import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { nextDocumentReference } from './references.js';
import { badRequest, conflict, notFound } from './errors.js';
import { getFile } from './storage.js';
import { defaultTemplateVersionId, storeInvoicePdf, storeInvoiceSnapshot } from './invoice-templates.js';
import { postJournalEntry } from './ledger.js';

/* Shared Invoice Engine (items 35-36). Every amount is computed server-side
   from the invoice lines; client totals are ignored. History is append-only. */

const party = z.object({
  userId: z.uuid().optional(),
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).optional(),
  nationalId: z.string().trim().max(20).optional(),
  economicCode: z.string().trim().max(20).optional(),
  phone: z.string().trim().max(20).optional(),
  address: z.string().trim().max(500).optional(),
  iban: z.string().trim().max(34).optional(),
}).strict();

const line = z.object({
  sku: z.string().trim().max(60).optional(),
  productName: z.string().trim().min(1).max(240),
  description: z.string().max(2000).default(''),
  quantity: z.number().int().min(1).max(100000),
  unitPriceRial: z.string().regex(/^\d+$/),
  discountRial: z.string().regex(/^\d+$/).default('0'),
  taxRial: z.string().regex(/^\d+$/).default('0'),
}).strict();

const invoiceKind = z.enum(['retail_sale', 'wholesale_sale', 'vip_sale', 'supplier_purchase', 'supplier_statement',
  'settlement', 'refund', 'return_credit', 'credit_note', 'installment_plan', 'other']);
const paymentType = z.enum(['cash', 'four_installments', 'transfer', 'credit', 'wallet', 'mixed']);

const createBody = z.object({
  kind: invoiceKind,
  orderId: z.uuid().optional(),
  revisesInvoiceId: z.uuid().optional(),
  creditNoteFor: z.uuid().optional(),
  partyUserId: z.uuid().optional(),
  templateCode: z.string().trim().max(60).optional(),
  orderReference: z.string().trim().max(60).optional(),
  buyer: party,
  seller: party,
  paymentType: paymentType.default('cash'),
  lines: z.array(line).min(1).max(500),
  discountRial: z.string().regex(/^\d+$/).default('0'),
  taxRial: z.string().regex(/^\d+$/).default('0'),
  shippingRial: z.string().regex(/^\d+$/).default('0'),
  servicesFeeRial: z.string().regex(/^\d+$/).default('0'),
  issueDate: z.iso.date().optional(),
  dueDate: z.iso.date().optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(['draft', 'issued']).default('issued'),
}).strict();

const paymentBody = z.object({
  amountRial: z.string().regex(/^\d+$/),
  method: z.enum(['cash', 'transfer', 'card', 'wallet', 'gateway', 'cheque', 'other']).default('transfer'),
  traceCode: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

const ACCOUNT = {
  receivable: '00000000-0000-4000-8000-000000000003',
  supplierPayable: '00000000-0000-4000-8000-000000000004',
  salesRevenue: '00000000-0000-4000-8000-000000000005',
  shippingIncome: '00000000-0000-4000-8000-000000000006',
  servicesIncome: '00000000-0000-4000-8000-000000000007',
  taxPayable: '00000000-0000-4000-8000-000000000009',
  supplierCost: '00000000-0000-4000-8000-000000000010',
  paymentClearing: '00000000-0000-4000-8000-000000000001',
  shippingExpense: '00000000-0000-4000-8000-000000000014',
  refundPayable: '00000000-0000-4000-8000-000000000015',
  commissionIncome: '00000000-0000-4000-8000-000000000012',
} as const;

/** Statements and settlements are reports/documents: postings happen in their own engines. */
const NON_POSTING_KINDS = new Set(['supplier_statement', 'settlement', 'other']);
const REFUND_KINDS = new Set(['refund', 'credit_note', 'return_credit']);

/** Issue-time postings per document kind (item 26). */
export async function postIssuedJournal(client: PoolClient, invoiceId: string, kind: string, reference: string, totals: Totals) {
  if (NON_POSTING_KINDS.has(kind)) return;
  if (REFUND_KINDS.has(kind)) {
    await postInvoiceJournal(client, 'invoice', invoiceId, `JE-${reference}`, [
      { account: ACCOUNT.salesRevenue, debit: totals.gross },
      ...(totals.shipping > 0n ? [{ account: ACCOUNT.shippingIncome, debit: totals.shipping }] : []),
      ...(totals.services > 0n ? [{ account: ACCOUNT.servicesIncome, debit: totals.services }] : []),
      ...(totals.tax > 0n ? [{ account: ACCOUNT.taxPayable, debit: totals.tax }] : []),
      { account: ACCOUNT.receivable, credit: totals.total },
    ]);
    return;
  }
  if (kind === 'supplier_purchase') {
    await postInvoiceJournal(client, 'invoice', invoiceId, `JE-${reference}`, [
      { account: ACCOUNT.supplierCost, debit: totals.subtotal },
      ...(totals.shipping > 0n ? [{ account: ACCOUNT.shippingExpense, debit: totals.shipping }] : []),
      { account: ACCOUNT.supplierPayable, credit: totals.subtotal + totals.shipping },
    ]);
    return;
  }
  await postInvoiceJournal(client, 'invoice', invoiceId, `JE-${reference}`, [
    { account: ACCOUNT.receivable, debit: totals.total },
    { account: ACCOUNT.salesRevenue, credit: totals.gross },
    ...(totals.shipping > 0n ? [{ account: ACCOUNT.shippingIncome, credit: totals.shipping }] : []),
    ...(totals.services > 0n ? [{ account: ACCOUNT.servicesIncome, credit: totals.services }] : []),
    ...(totals.tax > 0n ? [{ account: ACCOUNT.taxPayable, credit: totals.tax }] : []),
  ]);
}

export async function postInvoiceJournal(client: PoolClient, sourceType: string, sourceId: string, reference: string,
  lines: Array<{ account: string; debit?: bigint; credit?: bigint }>) {
  const posted = lines.filter((item) => (item.debit ?? 0n) > 0n || (item.credit ?? 0n) > 0n);
  if (posted.length < 2) throw badRequest('سند حسابداری حداقل به دو سطر بدهکار/بستانکار نیاز دارد.');
  // Single posting path: balance is asserted and the accounting period must be open.
  return postJournalEntry(client, { sourceType, sourceId, reference, lines: posted });
}

export type Totals = { subtotal: bigint; discount: bigint; tax: bigint; shipping: bigint; services: bigint; gross: bigint; total: bigint };

function computeTotals(input: Pick<z.infer<typeof createBody>, 'lines' | 'discountRial' | 'taxRial' | 'shippingRial' | 'servicesFeeRial'>): Totals {
  let subtotal = 0n, lineTax = 0n;
  for (const item of input.lines) {
    const unit = rial(item.unitPriceRial), discount = rial(item.discountRial), tax = rial(item.taxRial);
    const base = unit * BigInt(item.quantity) - discount;
    if (base < 0n) throw badRequest('تخفیف سطر از مبلغ آن بیشتر است.');
    subtotal += base;
    lineTax += tax;
  }
  const discount = rial(input.discountRial);
  const tax = rial(input.taxRial) + lineTax;
  const shipping = rial(input.shippingRial), services = rial(input.servicesFeeRial);
  if (discount > subtotal) throw badRequest('تخفیف فاکتور از جمع اقلام بیشتر است.');
  const gross = subtotal - discount;
  return { subtotal, discount, tax, shipping, services, gross, total: gross + tax + shipping + services };
}

async function insertInvoice(client: PoolClient, actor: Principal, input: z.infer<typeof createBody>, ip: string) {
  const totals = computeTotals(input);
  const invoiceId = randomUUID();
  const reference = await nextDocumentReference(client, 'invoice');
  const templateVersionId = await defaultTemplateVersionId(client, input.kind, input.templateCode);
  await client.query(
    `INSERT INTO invoices(id,reference,kind,order_id,revises_invoice_id,credit_note_for,buyer,seller,status,payment_type,
       subtotal_rial,discount_rial,tax_rial,shipping_rial,services_fee_rial,gross_rial,total_rial,
       remaining_rial,issue_date,due_date,notes,created_by,party_user_id,order_reference,issued_at,template_version_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [invoiceId, reference, input.kind, input.orderId ?? null, input.revisesInvoiceId ?? null,
      input.creditNoteFor ?? null,
      JSON.stringify(input.buyer), JSON.stringify(input.seller), input.status, input.paymentType,
      totals.subtotal.toString(), totals.discount.toString(), totals.tax.toString(), totals.shipping.toString(),
      totals.services.toString(), totals.gross.toString(), totals.total.toString(), totals.total.toString(),
      input.issueDate ? new Date(input.issueDate) : new Date(), input.dueDate ? new Date(input.dueDate) : null,
      input.notes ?? null, actor.id, input.partyUserId ?? null, input.orderReference ?? null,
      input.status === 'issued' ? new Date() : null, templateVersionId]);
  for (const [index, item] of input.lines.entries()) {
    const unit = rial(item.unitPriceRial);
    const lineTotal = unit * BigInt(item.quantity) - rial(item.discountRial) + rial(item.taxRial);
    await client.query(
      `INSERT INTO invoice_lines(id,invoice_id,line_no,sku,product_name,description,quantity,unit_price_rial,discount_rial,tax_rial,line_total_rial)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(), invoiceId, index + 1, item.sku ?? null, item.productName, item.description,
        item.quantity, item.unitPriceRial, item.discountRial, item.taxRial, lineTotal.toString()]);
  }
  await client.query(
    `INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'created',$3,$4,$5)`,
    [randomUUID(), invoiceId, actor.id, input.notes ?? null,
      JSON.stringify({ reference, totalRial: totals.total.toString(), lines: input.lines.length })]);
  await storeInvoiceSnapshot(client, invoiceId);
  if (input.status === 'issued') {
    await postIssuedJournal(client, invoiceId, input.kind, reference, totals);
    await outbox(client, 'invoice.issued', 'invoice', invoiceId, { invoiceId, reference, kind: input.kind, totalRial: totals.total.toString() });
  }
  await audit(client, actor.id, 'invoice.created', 'invoice', invoiceId, undefined, { reference, totalRial: totals.total.toString() }, ip);
  await outbox(client, 'invoice.created', 'invoice', invoiceId, { invoiceId, reference });
  return { id: invoiceId, reference, status: input.status, totalRial: asRial(totals.total), remainingRial: asRial(totals.total) };
}

export function registerInvoiceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // PDF: rendered by the server from the document snapshot, stored through the
  // file domain and only served to the parties or holders of `invoices:read` (item 33).
  app.get('/api/v1/invoices/:id/pdf', async (request, reply) => {
    const actor = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const invoice = await one<{ id: string; reference: string; buyer: unknown; seller: unknown; party_user_id: string | null }>(pool,
      'SELECT id, reference, buyer, seller, party_user_id FROM invoices WHERE id = $1', [id]);
    if (!invoice) throw notFound();
    const privileged = actor.permissions.includes('invoices:read');
    const own = invoice.party_user_id === actor.id
      || (invoice.buyer as { userId?: string } | null)?.userId === actor.id
      || (invoice.seller as { userId?: string } | null)?.userId === actor.id;
    if (!privileged && !own) throw notFound();
    const stored = await transaction(pool, (client) => storeInvoicePdf(client, id, actor.id));
    const file = await one<{ storage_key: string; original_name: string }>(pool,
      'SELECT storage_key, original_name FROM files WHERE id = $1', [stored.fileId]);
    if (!file) throw notFound();
    const bytes = await getFile(file.storage_key);
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="invoice-${invoice.reference}.pdf"`)
      .header('Cache-Control', 'private, max-age=0, must-revalidate')
      .send(bytes);
  });

  app.post('/api/v1/invoices', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const body = createBody.parse(request.body);
    const result = await transaction(pool, (client) => insertInvoice(client, actor, body, request.ip));
    return reply.code(201).send(result);
  });

  app.get('/api/v1/invoices', async (request) => {
    const actor = await principal(request, pool, config);
    const query = z.object({
      kind: invoiceKind.optional(), status: z.enum(['draft', 'issued', 'partially_paid', 'paid', 'cancelled', 'credited', 'revised', 'refunded', 'void']).optional(),
      orderId: z.uuid().optional(), reference: z.string().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(request.query);
    const privileged = actor.permissions.includes('invoices:read');
    const rows = await pool.query(
      `SELECT id,reference,kind,order_id,status,payment_type,total_rial,paid_rial,remaining_rial,issue_date,due_date,created_at,pdf_file_id
       FROM invoices
       WHERE ($1::boolean OR party_user_id = $2 OR buyer->>'userId' = $2 OR seller->>'userId' = $2)
         AND ($3::text IS NULL OR kind = $3) AND ($4::text IS NULL OR status = $4)
         AND ($5::uuid IS NULL OR order_id = $5) AND ($6::text IS NULL OR reference ILIKE '%' || $6 || '%')
       ORDER BY created_at DESC LIMIT $7`,
      [privileged, actor.id, query.kind ?? null, query.status ?? null, query.orderId ?? null, query.reference ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, total_rial: asRial(row.total_rial), paid_rial: asRial(row.paid_rial),
      remaining_rial: asRial(row.remaining_rial), pdfUrl: row.pdf_file_id ? `/api/v1/invoices/${row.id}/pdf` : null })) };
  });

  app.get('/api/v1/invoices/:id', async (request) => {
    const actor = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const invoice = await one<Record<string, unknown>>(pool, 'SELECT * FROM invoices WHERE id = $1', [id]);
    if (!invoice) throw notFound();
    const privileged = actor.permissions.includes('invoices:read');
    const own = invoice.buyer && (invoice.buyer as { userId?: string }).userId === actor.id
      || (invoice.seller as { userId?: string }).userId === actor.id;
    if (!privileged && !own) throw notFound();
    const lines = await pool.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id]);
    const events = await pool.query(
      `SELECT e.id,e.event_type,e.note,e.old_value,e.new_value,e.created_at,u.display_name AS actor_name
       FROM invoice_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.invoice_id = $1 ORDER BY e.created_at,e.id`, [id]);
    const payments = await pool.query('SELECT id,reference,amount_rial,method,trace_code,note,created_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at', [id]);
    return {
      ...invoice,
      subtotal_rial: asRial(String(invoice.subtotal_rial)), discount_rial: asRial(String(invoice.discount_rial)),
      tax_rial: asRial(String(invoice.tax_rial)), shipping_rial: asRial(String(invoice.shipping_rial)),
      services_fee_rial: asRial(String(invoice.services_fee_rial)), gross_rial: asRial(String(invoice.gross_rial)),
      total_rial: asRial(String(invoice.total_rial)), paid_rial: asRial(String(invoice.paid_rial)),
      remaining_rial: asRial(String(invoice.remaining_rial)),
      lines: lines.rows, events: events.rows,
      pdfUrl: invoice.pdf_file_id ? `/api/v1/invoices/${id}/pdf` : null,
      templateVersionId: invoice.template_version_id ?? null,
      payments: payments.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })),
    };
  });

  app.post('/api/v1/invoices/:id/payments', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = paymentBody.parse(request.body);
    const amount = rial(body.amountRial);
    if (amount === 0n) throw badRequest('مبلغ پرداخت باید بزرگ‌تر از صفر باشد.');
    const result = await transaction(pool, async (client) => {
      const invoice = await one<{ id: string; reference: string; status: string; total_rial: string; paid_rial: string; remaining_rial: string; kind: string }>(client,
        'SELECT id,reference,status,total_rial,paid_rial,remaining_rial,kind FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!invoice) throw notFound();
      if (invoice.status === 'cancelled' || invoice.status === 'credited' || invoice.status === 'revised'
        || invoice.status === 'draft' || invoice.status === 'void' || invoice.status === 'refunded')
        throw conflict('این فاکتور برای پرداخت باز نیست.');
      if (invoice.kind === 'supplier_statement' || invoice.kind === 'settlement' || invoice.kind === 'other')
        throw conflict('این سند برای ثبت پرداخت مشتری نیست.');
      const remaining = rial(invoice.remaining_rial);
      if (amount > remaining) throw conflict('مبلغ پرداخت از مانده فاکتور بیشتر است.');
      const paid = rial(invoice.paid_rial) + amount;
      const left = remaining - amount;
      const status = left === 0n ? 'paid' : 'partially_paid';
      const paymentId = randomUUID();
      const reference = await nextDocumentReference(client, 'transaction');
      await client.query(
        `INSERT INTO invoice_payments(id,invoice_id,reference,amount_rial,method,trace_code,note,actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [paymentId, id, reference, amount.toString(), body.method, body.traceCode ?? null, body.note ?? null, actor.id]);
      await client.query('UPDATE invoices SET paid_rial = $2, remaining_rial = $3, status = $4, paid_at = $5, version = version + 1, updated_at = now() WHERE id = $1',
        [id, paid.toString(), left.toString(), status, left === 0n ? new Date() : null]);
      const isPurchase = invoice.kind === 'supplier_purchase' || invoice.kind === 'settlement';
      await postInvoiceJournal(client, 'invoice_payment', paymentId, `JE-${reference}`,
        isPurchase
          ? [{ account: ACCOUNT.supplierPayable, debit: amount }, { account: ACCOUNT.paymentClearing, credit: amount }]
          : [{ account: ACCOUNT.paymentClearing, debit: amount }, { account: ACCOUNT.receivable, credit: amount }]);
      await client.query(
        `INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,old_value,new_value) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), id, left === 0n ? 'payment' : 'partial_payment', actor.id, body.note ?? null,
          JSON.stringify({ paidRial: invoice.paid_rial, remainingRial: invoice.remaining_rial }),
          JSON.stringify({ paidRial: paid.toString(), remainingRial: left.toString(), reference, traceCode: body.traceCode ?? null })]);
      await audit(client, actor.id, 'invoice.payment_recorded', 'invoice', id,
        { paidRial: invoice.paid_rial }, { paidRial: paid.toString(), reference, traceCode: body.traceCode ?? null }, request.ip);
      await outbox(client, 'invoice.payment', 'invoice', id, { invoiceId: id, reference, status });
      return { id, reference, status, paidRial: asRial(paid), remainingRial: asRial(left) };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/invoices/:id/cancel', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ note: z.string().trim().max(1000).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const invoice = await one<{ status: string; paid_rial: string; reference: string }>(client,
        'SELECT status,paid_rial,reference FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!invoice) throw notFound();
      if (invoice.status === 'cancelled') return { id, status: 'cancelled' };
      if (invoice.status === 'revised' || invoice.status === 'credited') throw conflict('فاکتور اصلاح‌شده قابل لغو نیست.');
      if (rial(invoice.paid_rial) !== 0n) throw conflict('فاکتور با پرداخت ثبت‌شده فقط با اصلاحیه بسته می‌شود.');
      await client.query("UPDATE invoices SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,old_value,new_value) VALUES ($1,$2,'cancelled',$3,$4,$5,$6)`,
        [randomUUID(), id, actor.id, body.note ?? null, JSON.stringify({ status: invoice.status }), JSON.stringify({ status: 'cancelled' })]);
      await audit(client, actor.id, 'invoice.cancelled', 'invoice', id, { status: invoice.status }, { status: 'cancelled' }, request.ip);
      return { id, status: 'cancelled' };
    });
  });

  /** A revised copy keeps every previous record; the old invoice is marked 'revised' (item 36). */
  app.post('/api/v1/invoices/:id/revisions', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = createBody.parse({ ...(request.body as object), revisesInvoiceId: id });
    return transaction(pool, async (client) => {
      const previous = await one<{ status: string; kind: string; reference: string }>(client,
        'SELECT status,kind,reference FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!previous) throw notFound();
      if (previous.status === 'cancelled') throw conflict('فاکتور لغوشده قابل اصلاح نیست.');
      if (body.kind !== previous.kind) throw badRequest('نوع فاکتور اصلاح‌شده باید با نسخه قبلی یکسان باشد.');
      const created = await insertInvoice(client, actor, body, request.ip);
      await client.query("UPDATE invoices SET status = 'revised', version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'revised',$3,$4,$5)`,
        [randomUUID(), id, actor.id, body.notes ?? null, JSON.stringify({ revisedBy: created.reference })]);
      return reply.code(201).send({ ...created, revises: previous.reference });
    });
  });
}

/** Issued automatically when a payment is verified so every paid order has an invoice. */
export async function issueInvoiceForOrder(client: PoolClient, orderId: string) {
  const order = await one<{ id: string; reference: string; order_type: string; payment_mode: string; buyer_id: string;
    subtotal_rial: string; discount_rial: string; shipping_rial: string; total_rial: string;
    shipping_address: { recipient?: string; phone?: string; line?: string } }>(client,
    'SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!order) return null;
  const existing = await one<{ id: string; reference: string }>(client,
    'SELECT id,reference FROM invoices WHERE order_id = $1 LIMIT 1', [orderId]);
  if (existing) return existing;
  const lines = await client.query<{ product_name: string; sku: string; quantity: number; unit_price_rial: string; line_total_rial: string }>(
    'SELECT product_name,sku,quantity,unit_price_rial,line_total_rial FROM order_lines WHERE order_id = $1 ORDER BY id', [orderId]);
  const totals = computeTotals({
    lines: lines.rows.map((item) => ({
      sku: item.sku, productName: item.product_name, description: '', quantity: item.quantity,
      unitPriceRial: item.unit_price_rial, discountRial: '0', taxRial: '0',
    })),
    discountRial: order.discount_rial, taxRial: '0', shippingRial: order.shipping_rial, servicesFeeRial: '0',
  });
  const invoiceId = randomUUID();
  const reference = await nextDocumentReference(client, 'invoice');
  await client.query(
    `INSERT INTO invoices(id,reference,kind,order_id,buyer,seller,status,payment_type,
       subtotal_rial,discount_rial,tax_rial,shipping_rial,services_fee_rial,gross_rial,total_rial,
       paid_rial,remaining_rial,paid_at,notes,created_by,party_user_id,order_reference,issued_at)
     VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9,$10,$11,$12,$13,$14,$14,0,now(),$15,$16,$17,$18,now())`,
    [invoiceId, reference, order.order_type === 'wholesale' ? 'wholesale_sale' : 'retail_sale', orderId,
      JSON.stringify({ userId: order.buyer_id, name: order.shipping_address.recipient ?? 'خریدار', phone: order.shipping_address.phone }),
      JSON.stringify({ name: 'کلبه وینتج', legalName: 'کلبه وینتج' }),
      order.payment_mode === 'four_installments' ? 'four_installments' : 'cash',
      totals.subtotal.toString(), totals.discount.toString(), totals.tax.toString(), totals.shipping.toString(),
      totals.services.toString(), totals.gross.toString(), totals.total.toString(),
      `فاکتور خودکار سفارش ${order.reference}`, order.buyer_id, order.buyer_id, order.reference]);
  for (const [index, item] of lines.rows.entries()) {
    await client.query(
      `INSERT INTO invoice_lines(id,invoice_id,line_no,sku,product_name,description,quantity,unit_price_rial,discount_rial,tax_rial,line_total_rial)
       VALUES ($1,$2,$3,$4,$5,'', $6,$7,0,0,$8)`,
      [randomUUID(), invoiceId, index + 1, item.sku, item.product_name, item.quantity, item.unit_price_rial, item.line_total_rial]);
  }
  await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,note,new_value) VALUES ($1,$2,'created',$3,$4)`,
    [randomUUID(), invoiceId, `فاکتور خودکار سفارش ${order.reference}`, JSON.stringify({ reference, orderId })]);
  await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,note,new_value) VALUES ($1,$2,'issued',$3,$4)`,
    [randomUUID(), invoiceId, `صدور خودکار هنگام پرداخت سفارش ${order.reference}`, JSON.stringify({ orderId })]);
  await storeInvoiceSnapshot(client, invoiceId);
  await outbox(client, 'invoice.issued', 'invoice', invoiceId, { invoiceId, reference, orderId });
  return { id: invoiceId, reference };
}
