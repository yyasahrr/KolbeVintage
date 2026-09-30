/* Document builder + lifecycle + print pipeline for the unified invoice engine
 * (items 25-34): templates, versions, preview, issue, void, refunds and
 * supplier/settlement statements.
 *
 * Every document is produced by the same engine, stored through the file domain
 * and always rendered from the stored snapshot — never from live data.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nextDocumentReference } from './references.js';
import { postInvoiceJournal, postIssuedJournal, type Totals } from './invoices.js';
import {
  defaultTemplateVersionId, issueStatementDocument, renderInvoiceDocument, renderTemplatePreview,
  resolveTemplateVersion, storeInvoicePdf, templateDefinition,
  type StatementLine,
} from './invoice-templates.js';

/** Every `{{group.key}}` a template may use, grouped for the builder UI (item 29). */
export const TEMPLATE_VARIABLES = [
  { group: 'invoice', label: 'سند', items: [
    { path: 'invoice.number', label: 'شماره سند' }, { path: 'invoice.kind', label: 'نوع سند' },
    { path: 'invoice.status', label: 'وضعیت' }, { path: 'invoice.date', label: 'تاریخ صدور' },
    { path: 'invoice.issueDate', label: 'تاریخ صدور (میلیادی)' }, { path: 'invoice.dueDate', label: 'سررسید' },
    { path: 'invoice.subtotal', label: 'جمع اقلام' }, { path: 'invoice.discount', label: 'تخفیف' },
    { path: 'invoice.tax', label: 'مالیات' }, { path: 'invoice.shipping', label: 'هزینه ارسال' },
    { path: 'invoice.services', label: 'کارمزد خدمات' }, { path: 'invoice.total', label: 'مبلغ کل' },
    { path: 'invoice.paid', label: 'پرداخت‌شده' }, { path: 'invoice.remaining', label: 'مانده' },
    { path: 'invoice.notes', label: 'توضیحات' }, { path: 'invoice.items', label: 'فهرست اقلام (چندخطی)' },
    { path: 'invoice.itemCount', label: 'تعداد اقلام' },
  ] },
  { group: 'customer', label: 'خریدار', items: [
    { path: 'customer.name', label: 'نام' }, { path: 'customer.legalName', label: 'نام حقوقی' },
    { path: 'customer.phone', label: 'تلفن' }, { path: 'customer.address', label: 'نشانی' },
    { path: 'customer.nationalId', label: 'کد ملی' }, { path: 'customer.economicCode', label: 'کد اقتصادی' },
  ] },
  { group: 'seller', label: 'فروشنده', items: [
    { path: 'seller.name', label: 'نام' }, { path: 'seller.legalName', label: 'نام حقوقی' },
    { path: 'seller.phone', label: 'تلفن' }, { path: 'seller.address', label: 'نشانی' },
    { path: 'seller.nationalId', label: 'کد ملی' }, { path: 'seller.economicCode', label: 'کد اقتصادی' },
  ] },
  { group: 'supplier', label: 'تأمین‌کننده', items: [
    { path: 'supplier.name', label: 'نام' }, { path: 'supplier.legalName', label: 'نام حقوقی' },
    { path: 'supplier.iban', label: 'شبا' }, { path: 'supplier.address', label: 'نشانی' }, { path: 'supplier.phone', label: 'تلفن' },
  ] },
  { group: 'order', label: 'سفارش', items: [{ path: 'order.reference', label: 'شماره سفارش' }] },
  { group: 'payment', label: 'پرداخت', items: [
    { path: 'payment.method', label: 'روش' }, { path: 'payment.lastReference', label: 'آخرین مرجع' },
    { path: 'payment.paidAt', label: 'زمان پرداخت' },
  ] },
];

const kindEnum = z.enum(['retail_sale', 'wholesale_sale', 'vip_sale', 'supplier_purchase', 'supplier_statement',
  'settlement', 'refund', 'return_credit', 'credit_note', 'installment_plan', 'other']);

export function registerInvoiceDocumentRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // ------------------------------------------------------------- templates --
  /** Variable catalogue for the template builder (item 29). */
  app.get('/api/v1/invoices/templates/variables', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:read');
    return { groups: TEMPLATE_VARIABLES };
  });

  app.get('/api/v1/invoices/templates', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:read');
    const rows = await pool.query(
      `SELECT t.id, t.code, t.title, t.kind, t.active, t.current_version, t.created_at, t.updated_at,
              v.definition, v.change_note,
              (SELECT count(*)::int FROM invoices i WHERE i.template_version_id = v.id) AS usage_count
         FROM invoice_templates t
         JOIN invoice_template_versions v ON v.template_id = t.id AND v.version = t.current_version
        ORDER BY t.kind, t.code`);
    return { items: rows.rows };
  });

  app.post('/api/v1/invoices/templates', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:templates');
    const body = z.object({
      code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
      title: z.string().trim().min(2).max(120),
      kind: kindEnum,
      definition: templateDefinition,
      changeNote: z.string().trim().max(300).optional(),
    }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const duplicate = await one<{ id: string }>(client, 'SELECT id FROM invoice_templates WHERE code = $1', [body.code]);
      if (duplicate) throw conflict('کد قالب تکراری است.');
      const templateId = randomUUID();
      await client.query('INSERT INTO invoice_templates(id,code,title,kind,created_by) VALUES ($1,$2,$3,$4,$5)',
        [templateId, body.code, body.title, body.kind, actor.id]);
      const versionId = randomUUID();
      await client.query('INSERT INTO invoice_template_versions(id,template_id,version,definition,change_note,created_by) VALUES ($1,$2,1,$3,$4,$5)',
        [versionId, templateId, JSON.stringify(body.definition), body.changeNote ?? 'نسخه اول', actor.id]);
      await audit(client, actor.id, 'invoice_template.created', 'invoice_template', templateId, undefined,
        { code: body.code, kind: body.kind }, request.ip);
      return { id: templateId, code: body.code, version: 1, versionId };
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/invoices/templates/:id', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const template = await one<Record<string, unknown>>(pool, 'SELECT * FROM invoice_templates WHERE id = $1', [id]);
    if (!template) throw notFound();
    const versions = await pool.query(
      `SELECT v.id, v.version, v.change_note, v.created_at, v.definition, u.display_name AS created_by_name
         FROM invoice_template_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.template_id = $1 ORDER BY v.version DESC`, [id]);
    return { ...template, versions: versions.rows };
  });

  app.post('/api/v1/invoices/templates/:id/versions', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:templates');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ definition: templateDefinition, changeNote: z.string().trim().max(300).optional() }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const template = await one<{ id: string; current_version: number }>(client,
        'SELECT id, current_version FROM invoice_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!template) throw notFound();
      const version = template.current_version + 1;
      const versionId = randomUUID();
      await client.query('INSERT INTO invoice_template_versions(id,template_id,version,definition,change_note,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [versionId, id, version, JSON.stringify(body.definition), body.changeNote ?? null, actor.id]);
      await client.query('UPDATE invoice_templates SET current_version = $2, updated_at = now() WHERE id = $1', [id, version]);
      await audit(client, actor.id, 'invoice_template.version_created', 'invoice_template', id,
        { version: template.current_version }, { version }, request.ip);
      return { id, version, versionId };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/invoices/templates/:id/activate', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:templates');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ active: z.boolean() }).parse(request.body);
    return transaction(pool, async (client) => {
      const template = await one<{ active: boolean }>(client, 'SELECT active FROM invoice_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!template) throw notFound();
      await client.query('UPDATE invoice_templates SET active = $2, updated_at = now() WHERE id = $1', [id, body.active]);
      await audit(client, actor.id, body.active ? 'invoice_template.activated' : 'invoice_template.deactivated',
        'invoice_template', id, { active: template.active }, { active: body.active }, request.ip);
      return { id, active: body.active };
    });
  });

  /** Preview: an unsaved definition, a stored version, or a real invoice with another template. */
  app.post('/api/v1/invoices/templates/:id/preview', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      invoiceId: z.uuid().optional(), version: z.number().int().min(1).optional(), definition: templateDefinition.optional(),
    }).parse(request.body ?? {});
    const template = await one<{ kind: string }>(pool, 'SELECT kind FROM invoice_templates WHERE id = $1', [id]);
    if (!template) throw notFound();
    let bytes: Uint8Array;
    if (body.invoiceId) {
      const versionId = body.definition
        ? (await transaction(pool, async (client) => {
          const created = await one<{ id: string }>(client,
            `INSERT INTO invoice_template_versions(id,template_id,version,definition,change_note,created_by)
             VALUES ($1,$2,(SELECT COALESCE(MAX(version),0) + 1000 FROM invoice_template_versions WHERE template_id = $2),$3,'پیش‌نمایش',$4)
             RETURNING id`, [randomUUID(), id, JSON.stringify(body.definition), actor.id]);
          return created?.id ?? null;
        }))
        : null;
      const version = versionId
        ? null
        : await one<{ id: string }>(pool, 'SELECT id FROM invoice_template_versions WHERE template_id = $1 AND version = $2',
          [id, body.version ?? (await one<{ current_version: number }>(pool, 'SELECT current_version FROM invoice_templates WHERE id = $1', [id]))?.current_version ?? 1]);
      const rendered = await transaction(pool, (client) =>
        renderInvoiceDocument(client, body.invoiceId!, { templateVersionId: versionId ?? version?.id ?? null }));
      bytes = rendered.buffer;
    } else if (body.definition) {
      bytes = await renderTemplatePreview(body.definition, template.kind);
    } else {
      const version = await transaction(pool, (client) => resolveTemplateVersion(client, { kind: template.kind }));
      bytes = await renderTemplatePreview(version?.definition ?? templateDefinition.parse({ sections: [{ id: 'items', type: 'table' }] }), template.kind);
    }
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="template-preview.pdf"').send(Buffer.from(bytes));
  });

  // ------------------------------------------------------------- lifecycle --
  /** Draft → issued, with the journal posting and the stored printable document (item 32/34). */
  app.post('/api/v1/invoices/:id/issue', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await transaction(pool, async (client) => {
      const invoice = await one<{ status: string; kind: string; reference: string; subtotal_rial: string; discount_rial: string;
        tax_rial: string; shipping_rial: string; services_fee_rial: string; gross_rial: string; total_rial: string } & Record<string, unknown>>(
        client, 'SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!invoice) throw notFound();
      if (invoice.status !== 'draft') throw conflict('فقط پیش‌نویس قابل صدور است.');
      const totals: Totals = {
        subtotal: rial(invoice.subtotal_rial), discount: rial(invoice.discount_rial), tax: rial(invoice.tax_rial),
        shipping: rial(invoice.shipping_rial), services: rial(invoice.services_fee_rial),
        gross: rial(invoice.gross_rial), total: rial(invoice.total_rial),
      };
      await postIssuedJournal(client, id, invoice.kind, invoice.reference, totals);
      await client.query("UPDATE invoices SET status = 'issued', issued_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'issued',$3,$4,$5)`,
        [randomUUID(), id, actor.id, 'صدور سند', JSON.stringify({ status: 'issued' })]);
      await outbox(client, 'invoice.issued', 'invoice', id, { invoiceId: id, reference: invoice.reference, kind: invoice.kind });
      await audit(client, actor.id, 'invoice.issued', 'invoice', id, { status: invoice.status }, { status: 'issued' }, request.ip);
      return { id, reference: invoice.reference, status: 'issued' };
    });
    const stored = await transaction(pool, (client) => storeInvoicePdf(client, id, actor.id));
    return reply.code(200).send({ ...result, pdfFileId: stored.fileId, pdfUrl: `/api/v1/invoices/${id}/pdf` });
  });

  /** Voiding keeps the ledger intact by posting a reversing entry (item 145/157). */
  app.post('/api/v1/invoices/:id/void', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const invoice = await one<{ status: string; kind: string; reference: string; total_rial: string; paid_rial: string;
        gross_rial: string; shipping_rial: string; services_fee_rial: string; tax_rial: string; subtotal_rial: string;
        discount_rial: string }>(client, 'SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!invoice) throw notFound();
      if (invoice.status === 'void') return { id, status: 'void' };
      if (invoice.status === 'draft') throw conflict('پیش‌نویس را می‌توان حذف یا لغو کرد؛ بطول کردن برای اسناد صادرشده است.');
      if (rial(invoice.paid_rial) !== 0n) throw conflict('سند دارای پرداخت باید ابتدا بازپرداخت شود.');
      const totals: Totals = {
        subtotal: rial(invoice.subtotal_rial), discount: rial(invoice.discount_rial), tax: rial(invoice.tax_rial),
        shipping: rial(invoice.shipping_rial), services: rial(invoice.services_fee_rial),
        gross: rial(invoice.gross_rial), total: rial(invoice.total_rial),
      };
      const REFUND_KINDS = new Set(['refund', 'credit_note', 'return_credit']);
      if (invoice.kind !== 'supplier_statement' && invoice.kind !== 'settlement' && invoice.kind !== 'other') {
        await postInvoiceReversal(client, id, invoice.kind, invoice.reference, totals, REFUND_KINDS.has(invoice.kind));
      }
      await client.query("UPDATE invoices SET status = 'void', voided_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,old_value,new_value) VALUES ($1,$2,'voided',$3,$4,$5,$6)`,
        [randomUUID(), id, actor.id, body.reason, JSON.stringify({ status: invoice.status }), JSON.stringify({ status: 'void' })]);
      await outbox(client, 'invoice.voided', 'invoice', id, { invoiceId: id, reference: invoice.reference, reason: body.reason });
      await audit(client, actor.id, 'invoice.voided', 'invoice', id, { status: invoice.status }, { status: 'void', reason: body.reason }, request.ip);
      return { id, status: 'void', reference: invoice.reference };
    });
  });

  /** Refund / credit note: a new document, linked to the original, never an edit. */
  app.post('/api/v1/invoices/:id/refunds', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      reason: z.string().trim().min(3).max(500),
      full: z.boolean().default(false),
      kind: z.enum(['refund', 'credit_note', 'return_credit']).default('refund'),
      lines: z.array(z.object({
        productName: z.string().trim().min(1).max(240),
        sku: z.string().trim().max(60).optional(),
        quantity: z.number().int().min(1).max(10000),
      })).max(200).optional(),
    }).strict().parse(request.body);

    const created = await transaction(pool, async (client) => {
      const original = await one<{ id: string; reference: string; kind: string; status: string; buyer: Record<string, string>;
        seller: Record<string, string>; paid_rial: string; total_rial: string; tax_rial: string; shipping_rial: string;
        services_fee_rial: string; order_id: string | null; notes: string | null }>(
        client, 'SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (!original) throw notFound();
      if (original.status === 'cancelled' || original.status === 'void') throw conflict('سند لغوشده قابل بازپرداخت نیست.');
      const lines = await client.query<{ product_name: string; sku: string | null; quantity: number; unit_price_rial: string; line_total_rial: string }>(
        'SELECT product_name, sku, quantity, unit_price_rial, line_total_rial FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [id]);
      const previousRefunds = await one<{ total: string }>(client,
        "SELECT COALESCE(SUM(total_rial),0)::text AS total FROM invoices WHERE credit_note_for = $1 AND status NOT IN ('cancelled','void')", [id]);
      const alreadyRefunded = rial(previousRefunds?.total ?? '0');
      const remainingRefundable = rial(original.total_rial) - alreadyRefunded;
      if (remainingRefundable <= 0n) throw conflict('سند اصلی پیش‌تر به‌طور کامل بازپرداخت شده است.');

      type RefundLine = { productName: string; sku: string | null; quantity: number; unitPriceRial: string; lineTotal: bigint };
      let documentLines: RefundLine[];
      let amount: bigint;
      if (body.full) {
        // A full refund refunds exactly what is left of the document, including
        // tax/shipping/services, so the printed credit note adds up to the total.
        amount = remainingRefundable;
        documentLines = lines.rows.map((row) => ({
          productName: row.product_name, sku: row.sku, quantity: row.quantity,
          unitPriceRial: (rial(row.line_total_rial) / BigInt(row.quantity)).toString(),
          lineTotal: rial(row.line_total_rial),
        }));
        for (const [label, value] of [['مالیات', original.tax_rial], ['هزینه ارسال', original.shipping_rial],
          ['کارمزد خدمات', original.services_fee_rial]] as Array<[string, string]>) {
          if (rial(value) > 0n) documentLines.push({ productName: label, sku: null, quantity: 1, unitPriceRial: value, lineTotal: rial(value) });
        }
      } else {
        const requested = body.lines ?? [];
        if (!requested.length) throw badRequest('حداقل یک سطر برای بازپرداخت لازم است.');
        documentLines = requested.map((item) => {
          const source = lines.rows.find((row) => row.product_name === item.productName);
          if (!source) throw badRequest(`سطر «${item.productName}» در سند اصلی یافت نشد.`);
          if (item.quantity > source.quantity) throw badRequest(`تعداد بازپرداخت «${item.productName}» از سند اصلی بیشتر است.`);
          const unit = rial(source.line_total_rial) / BigInt(source.quantity);
          return { productName: source.product_name, sku: source.sku, quantity: item.quantity,
            unitPriceRial: unit.toString(), lineTotal: unit * BigInt(item.quantity) };
        });
        amount = documentLines.reduce((sum, line) => sum + line.lineTotal, 0n);
      }
      if (amount <= 0n) throw badRequest('مبلغ بازپرداخت باید بزرگ‌تر از صفر باشد.');
      if (alreadyRefunded + amount > rial(original.total_rial)) throw conflict('جمع بازپرداخت از مبلغ سند اصلی بیشتر است.');

      const refundReference = await nextDocumentReference(client, 'invoice');
      const refundId = randomUUID();
      const templateVersionId = await defaultTemplateVersionId(client, body.kind);
      const totals: Totals = { subtotal: amount, discount: 0n, tax: 0n, shipping: 0n, services: 0n, gross: amount, total: amount };
      await client.query(
        `INSERT INTO invoices(id,reference,kind,order_id,credit_note_for,buyer,seller,status,payment_type,
           subtotal_rial,gross_rial,total_rial,remaining_rial,issue_date,notes,created_by,party_user_id,issued_at,template_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'issued','transfer',$8,$8,$8,$8,current_date,$9,$10,$11,now(),$12)`,
        [refundId, refundReference, body.kind, original.order_id, id, JSON.stringify(original.buyer),
          JSON.stringify(original.seller), amount.toString(), `${body.reason} — بازپرداخت سند ${original.reference}`,
          actor.id, (original.buyer as { userId?: string }).userId ?? null, templateVersionId]);
      for (const [index, line] of documentLines.entries()) {
        await client.query(
          `INSERT INTO invoice_lines(id,invoice_id,line_no,sku,product_name,description,quantity,unit_price_rial,discount_rial,tax_rial,line_total_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9)`,
          [randomUUID(), refundId, index + 1, line.sku, line.productName, `بازپرداخت ${original.reference}`,
            line.quantity, line.unitPriceRial, line.lineTotal.toString()]);
      }
      await postIssuedJournal(client, refundId, body.kind, refundReference, totals);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'refunded',$3,$4,$5)`,
        [randomUUID(), id, actor.id, body.reason, JSON.stringify({ refundReference, amountRial: amount.toString() })]);
      const refundedTotal = alreadyRefunded + amount;
      if (refundedTotal >= rial(original.total_rial)) {
        await client.query("UPDATE invoices SET status = 'refunded', refunded_at = now(), version = version + 1, updated_at = now() WHERE id = $1", [id]);
      }
      await outbox(client, 'invoice.refunded', 'invoice', id, { invoiceId: id, refundId, refundReference, reason: body.reason });
      await audit(client, actor.id, 'invoice.refunded', 'invoice', id, { totalRial: original.total_rial }, { amountRial: amount.toString(), refundReference }, request.ip);
      return { id: refundId, reference: refundReference, amountRial: asRial(amount), original: original.reference };
    });
    const stored = await transaction(pool, (client) => storeInvoicePdf(client, created.id, actor.id));
    return reply.code(201).send({ ...created, pdfFileId: stored.fileId, pdfUrl: `/api/v1/invoices/${created.id}/pdf` });
  });

  // ------------------------------------------------------------ statements --
  /** Settlement completed → supplier statement document (item 34/147). */
  app.post('/api/v1/invoices/statements/supplier', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'invoices:write');
    const body = z.object({
      supplierId: z.uuid(),
      from: z.iso.date(),
      to: z.iso.date(),
      settlementId: z.uuid().optional(),
    }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const supplier = await one<{ display_name: string; phone: string | null; email: string | null }>(client,
        'SELECT display_name, phone, email FROM users WHERE id = $1', [body.supplierId]);
      if (!supplier) throw notFound();
      const ledger = await client.query<{ occurred_at: Date; event: string; direction: string; amount_rial: string;
        balance_after_rial: string; reference: string; description: string | null }>(
        `SELECT occurred_at, event, direction, amount_rial, balance_after_rial, reference, description
           FROM supplier_ledger_entries
          WHERE supplier_id = $1 AND occurred_at >= $2 AND occurred_at < $3::date + interval '1 day'
          ORDER BY occurred_at, id`, [body.supplierId, body.from, body.to]);
      if (!ledger.rows.length) throw badRequest('برای این بازه گردشی ثبت نشده است.');
      const lines: StatementLine[] = ledger.rows.map((row) => ({
        occurredAt: row.occurred_at, event: row.event, description: row.description ?? '',
        debit: row.direction === 'debit' ? BigInt(row.amount_rial) : 0n,
        credit: row.direction === 'credit' ? BigInt(row.amount_rial) : 0n,
        balance: BigInt(row.balance_after_rial), reference: row.reference,
      }));
      const statement = await issueStatementDocument(client, {
        kind: 'supplier_statement',
        supplierId: body.supplierId,
        supplier: { name: supplier.display_name, legalName: supplier.display_name, phone: supplier.phone ?? '', email: supplier.email ?? '' },
        lines, title: 'صورت‌حساب تأمین‌کننده',
        periodFrom: new Date(body.from), periodTo: new Date(body.to), actorId: actor.id,
      });
      await outbox(client, 'statement.issued', 'invoice', statement.id, {
        invoiceId: statement.id, reference: statement.reference, supplierId: body.supplierId,
        from: body.from, to: body.to, netRial: statement.net.toString(),
      });
      await audit(client, actor.id, 'statement.issued', 'invoice', statement.id, undefined,
        { supplierId: body.supplierId, reference: statement.reference, netRial: statement.net.toString() }, request.ip);
      return { id: statement.id, reference: statement.reference, period: statement.periodText,
        debitRial: asRial(statement.totalDebit), creditRial: asRial(statement.totalCredit), netRial: asRial(statement.net) };
    });
    return reply.code(201).send({ ...result, pdfUrl: `/api/v1/invoices/${result.id}/pdf` });
  });
}

/** Reversing entry used when a posted document is voided or refunded (never an edit). */
async function postInvoiceReversal(client: PoolClient, invoiceId: string, kind: string, reference: string, totals: Totals, wasRefund: boolean) {
  const sourceId = invoiceId;
  if (wasRefund) {
    await postInvoiceJournal(client, 'invoice_void', sourceId, `JE-${reference}-VOID`, [
      { account: '00000000-0000-4000-8000-000000000003', debit: totals.total },
      { account: '00000000-0000-4000-8000-000000000005', credit: totals.gross },
      { account: '00000000-0000-4000-8000-000000000009', credit: totals.tax },
    ]);
    return;
  }
  if (kind === 'supplier_purchase') {
    await postInvoiceJournal(client, 'invoice_void', sourceId, `JE-${reference}-VOID`, [
      { account: '00000000-0000-4000-8000-000000000004', debit: totals.subtotal + totals.shipping },
      { account: '00000000-0000-4000-8000-000000000010', credit: totals.subtotal },
      { account: '00000000-0000-4000-8000-000000000014', credit: totals.shipping },
    ]);
    return;
  }
  await postInvoiceJournal(client, 'invoice_void', sourceId, `JE-${reference}-VOID`, [
    { account: '00000000-0000-4000-8000-000000000005', debit: totals.gross },
    { account: '00000000-0000-4000-8000-000000000006', debit: totals.shipping },
    { account: '00000000-0000-4000-8000-000000000007', debit: totals.services },
    { account: '00000000-0000-4000-8000-000000000009', debit: totals.tax },
    { account: '00000000-0000-4000-8000-000000000003', credit: totals.total },
  ]);
}

/** Guards a document against live-data drift: reports always read the snapshot. */
export async function assertDocumentSnapshot(client: PoolClient, invoiceId: string) {
  const invoice = await one<{ snapshot: Record<string, unknown> }>(client, 'SELECT snapshot FROM invoices WHERE id = $1', [invoiceId]);
  if (!invoice) throw notFound();
  if (!invoice.snapshot || Object.keys(invoice.snapshot).length === 0) {
    throw conflict('این سند پیش از فعال‌شدن موتور قالب‌ها صادر شده و اسنپ‌شات ندارد.');
  }
  return invoice.snapshot;
}
