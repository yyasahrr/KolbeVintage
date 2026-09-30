/* Invoice/document template engine (items 27-31, 33-34).
 *
 * Templates are stored server-side and versioned. A version is immutable; a
 * document keeps the version it was rendered with, and the JSON snapshot of the
 * data used for the render is stored on the invoice, so re-printing years later
 * always produces the same document.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { one } from './db.js';
import { notFound } from './errors.js';
import { formatJalali, formatRial, renderPdf, type PdfColumn, type PdfSection } from './pdf.js';
import { putFile } from './storage.js';
import { nextDocumentReference } from './references.js';

export const templateSection = z.object({
  id: z.string().trim().min(1).max(60),
  type: z.enum(['heading', 'keyValues', 'table', 'totals', 'paragraph', 'divider', 'signature']),
  title: z.string().trim().max(120).optional(),
  order: z.number().int().min(0).max(99).default(0),
  visible: z.boolean().default(true),
  fields: z.array(z.string().trim().max(80)).max(30).optional(),
  text: z.string().max(4000).optional(),
  lines: z.array(z.string().trim().max(120)).min(1).max(4).optional(),
}).strict();

export const templateDefinition = z.object({
  paperSize: z.literal('A4').default('A4'),
  accent: z.object({ r: z.number().min(0).max(1), g: z.number().min(0).max(1), b: z.number().min(0).max(1) }).optional(),
  watermark: z.string().trim().max(120).optional(),
  footer: z.string().trim().max(200).optional(),
  sections: z.array(templateSection).min(1).max(30),
}).strict();

export type TemplateDefinition = z.infer<typeof templateDefinition>;

/** Code-level fallback so rendering never breaks if an admin deletes every template row. */
export const fallbackDefinition: TemplateDefinition = {
  paperSize: 'A4',
  sections: [
    { id: 'parties', type: 'keyValues', title: 'طرفین', order: 1, visible: true, fields: ['seller.name', 'customer.name', 'invoice.number'] },
    { id: 'items', type: 'table', title: 'اقلام', order: 2, visible: true },
    { id: 'totals', type: 'totals', order: 3, visible: true },
  ],
};

const KIND_LABEL: Record<string, string> = {
  retail_sale: 'فاکتور فروش خرده',
  wholesale_sale: 'فاکتور فروش عمده',
  vip_sale: 'فاکتور فروش ویژه',
  supplier_purchase: 'فاکتور خرید از تأمین‌کننده',
  supplier_statement: 'صورت‌حساب تأمین‌کننده',
  settlement: 'سند تسویه',
  refund: 'سند بازپرداخت',
  return_credit: 'اعتبار مرجوعی',
  credit_note: 'اصلاحیه اعتباری',
  installment_plan: 'فاکتور فروش اقساطی',
  other: 'سند مالی',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'پیش‌نویس',
  issued: 'صادرشده',
  partially_paid: 'پرداخت جزئی',
  paid: 'تسویه‌شده',
  cancelled: 'لغوشده',
  credited: 'اعتباری',
  revised: 'اصلاح‌شده',
  refunded: 'بازپرداخت‌شده',
  void: 'بطول‌شده',
};

export const KIND_TEMPLATE_CODE: Record<string, string> = {
  retail_sale: 'official-invoice',
  wholesale_sale: 'wholesale-invoice',
  vip_sale: 'official-invoice',
  supplier_purchase: 'supplier-statement',
  supplier_statement: 'supplier-statement',
  settlement: 'settlement-statement',
};

export const ITEM_COLUMNS: PdfColumn[] = [
  { key: 'index', label: 'ردیف', width: 34, align: 'right' },
  { key: 'name', label: 'شرح کالا / خدمات', width: 170, align: 'right' },
  { key: 'sku', label: 'کد', width: 60, align: 'left' },
  { key: 'quantity', label: 'تعداد', width: 45, align: 'right' },
  { key: 'unit', label: 'قیمت واحد', width: 80, align: 'right' },
  { key: 'discount', label: 'تخفیف', width: 60, align: 'right' },
  { key: 'lineTotal', label: 'جمع', width: 66, align: 'right' },
];

export type TemplateVersionRow = {
  id: string;
  template_id: string;
  version: number;
  definition: TemplateDefinition;
  change_note: string | null;
};

/** The version stored on the document wins; otherwise the active template for the kind. */
export async function resolveTemplateVersion(client: PoolClient, options: { kind?: string; templateCode?: string; templateVersionId?: string | null }): Promise<TemplateVersionRow | null> {
  if (options.templateVersionId) {
    const pinned = await one<TemplateVersionRow>(client,
      'SELECT id, template_id, version, definition, change_note FROM invoice_template_versions WHERE id = $1',
      [options.templateVersionId]);
    if (pinned) return pinned;
  }
  const code = options.templateCode ?? (options.kind ? KIND_TEMPLATE_CODE[options.kind] : undefined);
  if (code) {
    const byCode = await one<TemplateVersionRow>(client,
      `SELECT v.id, v.template_id, v.version, v.definition, v.change_note
         FROM invoice_templates t JOIN invoice_template_versions v ON v.template_id = t.id AND v.version = t.current_version
        WHERE t.active AND t.code = $1 LIMIT 1`, [code]);
    if (byCode) return byCode;
  }
  const anyActive = await one<TemplateVersionRow>(client,
    `SELECT v.id, v.template_id, v.version, v.definition, v.change_note
       FROM invoice_templates t JOIN invoice_template_versions v ON v.template_id = t.id AND v.version = t.current_version
      WHERE t.active ORDER BY t.code LIMIT 1`);
  return anyActive ?? null;
}

export async function defaultTemplateVersionId(client: PoolClient, kind: string, templateCode?: string): Promise<string | null> {
  const row = await resolveTemplateVersion(client, { kind, templateCode });
  return row?.id ?? null;
}

// ------------------------------------------------------------------ context --
export type InvoiceRow = Record<string, unknown> & {
  id: string; reference: string; kind: string; status: string; order_id?: string | null;
  buyer: Record<string, string>; seller: Record<string, string>;
  subtotal_rial: string; discount_rial: string; tax_rial: string; shipping_rial: string;
  services_fee_rial: string; gross_rial: string; total_rial: string; paid_rial: string;
  remaining_rial: string; issue_date: Date | string; due_date?: Date | string | null; notes?: string | null;
};

export type InvoiceLineRow = {
  product_name: string; sku?: string | null; quantity: number; unit_price_rial: string;
  discount_rial: string; tax_rial: string; line_total_rial: string; description?: string | null;
};

export function invoiceItemTableRows(lines: InvoiceLineRow[]): Array<Record<string, string>> {
  return lines.map((line, index) => ({
    index: String(index + 1),
    name: line.product_name,
    sku: line.sku ?? '—',
    quantity: String(line.quantity),
    unit: formatRial(line.unit_price_rial),
    discount: formatRial(line.discount_rial),
    lineTotal: formatRial(line.line_total_rial),
  }));
}

export function invoiceTotalsRows(invoice: InvoiceRow): Array<{ label: string; value: string; strong?: boolean }> {
  return [
    { label: 'جمع اقلام', value: formatRial(invoice.subtotal_rial) },
    { label: 'تخفیف', value: formatRial(invoice.discount_rial) },
    { label: 'مالیات', value: formatRial(invoice.tax_rial) },
    { label: 'هزینه ارسال', value: formatRial(invoice.shipping_rial) },
    { label: 'کارمزد خدمات', value: formatRial(invoice.services_fee_rial) },
    { label: 'مبلغ کل', value: formatRial(invoice.total_rial), strong: true },
    { label: 'پرداخت‌شده', value: formatRial(invoice.paid_rial) },
    { label: 'مانده', value: formatRial(invoice.remaining_rial), strong: true },
  ];
}

/** Flat `path.to.value` context used by `{{invoice.number}}`-style variables (item 29). */
export function templateContext(input: {
  invoice: InvoiceRow;
  lines: InvoiceLineRow[];
  orderReference?: string | null;
  payment?: { method?: string | null; lastReference?: string | null; paidAt?: Date | string | null };
  extras?: Record<string, Record<string, string>>;
}): Record<string, Record<string, string>> {
  const { invoice } = input;
  const buyer = invoice.buyer ?? {};
  const seller = invoice.seller ?? {};
  const itemText = input.lines.map((line, index) =>
    `${index + 1}. ${line.product_name} — ${line.quantity} × ${formatRial(line.unit_price_rial)} = ${formatRial(line.line_total_rial)}`).join('\n');
  return {
    invoice: {
      number: invoice.reference,
      kind: KIND_LABEL[invoice.kind] ?? invoice.kind,
      status: STATUS_LABEL[invoice.status] ?? invoice.status,
      date: formatJalali(invoice.issue_date),
      issueDate: formatJalali(invoice.issue_date),
      dueDate: invoice.due_date ? formatJalali(invoice.due_date) : '—',
      subtotal: formatRial(invoice.subtotal_rial),
      discount: formatRial(invoice.discount_rial),
      tax: formatRial(invoice.tax_rial),
      shipping: formatRial(invoice.shipping_rial),
      services: formatRial(invoice.services_fee_rial),
      total: formatRial(invoice.total_rial),
      paid: formatRial(invoice.paid_rial),
      remaining: formatRial(invoice.remaining_rial),
      notes: invoice.notes ?? '—',
      items: itemText,
      itemCount: String(input.lines.length),
    },
    customer: {
      name: buyer.name ?? '—', legalName: buyer.legalName ?? buyer.name ?? '—',
      phone: buyer.phone ?? '—', address: buyer.address ?? '—',
      nationalId: buyer.nationalId ?? '—', economicCode: buyer.economicCode ?? '—',
    },
    seller: {
      name: seller.name ?? 'کلبه وینتج', legalName: seller.legalName ?? seller.name ?? 'کلبه وینتج',
      phone: seller.phone ?? '—', address: seller.address ?? '—',
      nationalId: seller.nationalId ?? '—', economicCode: seller.economicCode ?? '—',
    },
    supplier: {
      name: seller.name ?? '—', legalName: seller.legalName ?? '—', iban: seller.iban ?? '—',
      address: seller.address ?? '—', phone: seller.phone ?? '—',
    },
    order: { reference: input.orderReference ?? '—' },
    payment: {
      method: input.payment?.method ?? '—',
      lastReference: input.payment?.lastReference ?? '—',
      paidAt: input.payment?.paidAt ? formatJalali(input.payment.paidAt, true) : '—',
    },
    ...(input.extras ?? {}),
  };
}

const resolveVariable = (context: Record<string, Record<string, string>>, path: string): string => {
  const [group, key] = path.split('.');
  if (!group || !key) return path;
  return context[group]?.[key] ?? '—';
};

export const substitute = (text: string, context: Record<string, Record<string, string>>): string =>
  text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => resolveVariable(context, path));

/** Turn a stored definition + context into the renderer model (items 29-30). */
export function buildDocument(input: {
  definition: TemplateDefinition;
  context: Record<string, Record<string, string>>;
  lines: InvoiceLineRow[];
  totals: Array<{ label: string; value: string; strong?: boolean }>;
  title: string;
  subtitle?: string;
}) {
  const sections: PdfSection[] = [];
  const ordered = [...input.definition.sections].sort((a, b) => a.order - b.order);
  for (const section of ordered) {
    if (!section.visible) continue;
    if (section.type === 'heading') {
      sections.push({ type: 'heading', text: substitute(section.text ?? input.title, input.context) });
      continue;
    }
    if (section.type === 'keyValues') {
      const rows = (section.fields ?? []).map((field) => ({ label: field, value: substitute(`{{${field}}}`, input.context) }))
        .filter((row) => row.value !== '—' && row.value !== '');
      if (rows.length) sections.push({ type: 'keyValues', title: section.title, rows });
      continue;
    }
    if (section.type === 'table') {
      sections.push({ type: 'table', title: section.title ?? 'اقلام', columns: ITEM_COLUMNS, rows: invoiceItemTableRows(input.lines) });
      continue;
    }
    if (section.type === 'totals') {
      sections.push({ type: 'totals', title: section.title, rows: input.totals });
      continue;
    }
    if (section.type === 'divider') { sections.push({ type: 'divider' }); continue; }
    if (section.type === 'signature') {
      sections.push({ type: 'signature', lines: (section.lines ?? ['مهر و امضا']).map((line) => substitute(line, input.context)) });
      continue;
    }
    const text = substitute(section.text ?? '', input.context);
    for (const part of text.split('\n')) {
      if (part.trim()) sections.push({ type: 'paragraph', title: section.title, text: part });
    }
  }
  if (!sections.length) sections.push({ type: 'table', columns: ITEM_COLUMNS, rows: invoiceItemTableRows(input.lines) });
  return {
    title: input.title,
    subtitle: input.subtitle,
    accent: input.definition.accent,
    watermarkText: input.definition.watermark,
    footerText: input.definition.footer ?? 'کلبه وینتج',
    sections,
  };
}

export async function renderInvoiceDocument(client: PoolClient, invoiceId: string, options: { templateCode?: string; templateVersionId?: string | null } = {}) {
  const invoice = await one<InvoiceRow>(client, 'SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!invoice) throw notFound();
  const lines = (await client.query<InvoiceLineRow>(
    'SELECT product_name, sku, description, quantity, unit_price_rial, discount_rial, tax_rial, line_total_rial FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no',
    [invoiceId])).rows;
  const lastPayment = await one<{ method: string; reference: string; created_at: Date }>(client,
    'SELECT method, reference, created_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1', [invoiceId]);
  const order = invoice.order_id
    ? await one<{ reference: string }>(client, 'SELECT reference FROM orders WHERE id = $1', [invoice.order_id])
    : null;
  const version = await resolveTemplateVersion(client, {
    kind: invoice.kind,
    templateCode: options.templateCode,
    templateVersionId: options.templateVersionId ?? (invoice as { template_version_id?: string | null }).template_version_id ?? null,
  });
  const definition = version ? templateDefinition.parse(version.definition) : fallbackDefinition;
  // Supplier documents carry the supplier in `buyer`; surface it under the
  // `supplier.*` variables the statement templates use.
  const counterparty = (invoice.buyer ?? {}) as Record<string, string>;
  const supplierExtras = invoice.kind === 'supplier_statement' || invoice.kind === 'settlement' || invoice.kind === 'supplier_purchase'
    ? { supplier: { name: counterparty.name ?? '—', legalName: counterparty.legalName ?? counterparty.name ?? '—',
        iban: counterparty.iban ?? '—', address: counterparty.address ?? '—', phone: counterparty.phone ?? '—' } }
    : undefined;
  const context = templateContext({ invoice, lines, orderReference: order?.reference,
    extras: supplierExtras,
    payment: lastPayment ? { method: lastPayment.method, lastReference: lastPayment.reference, paidAt: lastPayment.created_at } : undefined });
  const model = buildDocument({
    definition, context, lines, totals: invoiceTotalsRows(invoice),
    title: `${KIND_LABEL[invoice.kind] ?? 'سند مالی'} ${invoice.reference}`,
    subtitle: `${STATUS_LABEL[invoice.status] ?? invoice.status} — تاریخ ${formatJalali(invoice.issue_date)}`,
  });
  const bytes = await renderPdf(model);
  return { buffer: Buffer.from(bytes), definition, versionId: version?.id ?? null, snapshot: { context, templateVersion: version?.version ?? null } };
}

/** Render once, store through the file domain and link the PDF to the invoice (item 31). */
export async function storeInvoicePdf(client: PoolClient, invoiceId: string, actorId: string | null) {
  const existing = await one<{ pdf_file_id: string | null; reference: string }>(client,
    'SELECT pdf_file_id, reference FROM invoices WHERE id = $1', [invoiceId]);
  if (!existing) throw notFound();
  if (existing.pdf_file_id) return { fileId: existing.pdf_file_id, created: false };
  const { buffer, versionId, snapshot } = await renderInvoiceDocument(client, invoiceId);
  const { storageKey, sha256 } = await putFile(buffer, `invoice-${existing.reference}.pdf`, 'application/pdf');
  const fileId = randomUUID();
  await client.query(
    `INSERT INTO files(id, owner_id, storage_key, original_name, mime_type, size_bytes, sha256, visibility)
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,'private')`,
    [fileId, actorId, storageKey, `invoice-${existing.reference}.pdf`, buffer.length, sha256]);
  await client.query('UPDATE invoices SET pdf_file_id = $2, template_version_id = COALESCE(template_version_id, $3), snapshot = $4, updated_at = now() WHERE id = $1',
    [invoiceId, fileId, versionId, JSON.stringify(snapshot)]);
  await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'rendered',$3,$4,$5)`,
    [randomUUID(), invoiceId, actorId, 'تولید فایل PDF', JSON.stringify({ fileId, templateVersionId: versionId })]);
  return { fileId, created: true };
}

export async function storeInvoiceSnapshot(client: PoolClient, invoiceId: string) {
  const invoice = await one<InvoiceRow>(client, 'SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!invoice) return;
  const lines = (await client.query<InvoiceLineRow>('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no', [invoiceId])).rows;
  const order = invoice.order_id ? await one<{ reference: string }>(client, 'SELECT reference FROM orders WHERE id = $1', [invoice.order_id]) : null;
  const context = templateContext({ invoice, lines, orderReference: order?.reference });
  const version = await resolveTemplateVersion(client, { kind: invoice.kind });
  await client.query('UPDATE invoices SET snapshot = $2, template_version_id = COALESCE(template_version_id, $3) WHERE id = $1',
    [invoiceId, JSON.stringify({ context, templateVersion: version?.version ?? null }), version?.id ?? null]);
}

// --------------------------------------------------------------- statements --
export type StatementLine = {
  occurredAt: Date | string;
  event: string;
  description: string;
  debit: bigint;
  credit: bigint;
  balance: bigint;
  reference: string;
};

const STATEMENT_EVENT_LABEL: Record<string, string> = {
  order_sale: 'فروش سفارش', commission: 'کارمزد', discount_share: 'سهم تخفیف',
  shipping_charge: 'هزینه ارسال', return_cost: 'مرجوعی', refund: 'بازپرداخت',
  adjustment_credit: 'اصلاح بستانکار', adjustment_debit: 'اصلاح بدهکار', penalty: 'جریمه',
  bonus: 'پاداش', tax: 'مالیات', withholding: 'کسر از پرداخت', settlement: 'تسویه',
  withdrawal: 'برداشت', prepayment: 'پیش‌پرداخت', prepayment_applied: 'اعمال پیش‌پرداخت',
};

/** Supplier/settlement statement documents are invoices too — same engine (item 26/30/34). */
export async function issueStatementDocument(client: PoolClient, input: {
  kind: 'supplier_statement' | 'settlement';
  supplierId: string;
  supplier: Record<string, string>;
  lines: StatementLine[];
  title: string;
  periodFrom: Date;
  periodTo: Date;
  actorId: string | null;
  note?: string;
}) {
  const reference = await nextDocumentReference(client, 'invoice');
  const totalCredit = input.lines.reduce((sum, line) => sum + line.credit, 0n);
  const totalDebit = input.lines.reduce((sum, line) => sum + line.debit, 0n);
  const net = totalCredit - totalDebit;
  const invoiceId = randomUUID();
  const templateVersionId = await defaultTemplateVersionId(client, input.kind);
  const periodText = `${formatJalali(input.periodFrom)} تا ${formatJalali(input.periodTo)}`;
  await client.query(
    `INSERT INTO invoices(id,reference,kind,buyer,seller,status,payment_type,subtotal_rial,discount_rial,
       gross_rial,total_rial,paid_rial,remaining_rial,issue_date,notes,created_by,party_user_id,issued_at,template_version_id)
     VALUES ($1,$2,$3,$4,$5,'issued','credit',$6,$7,$8,$8,$8,0,current_date,$9,$10,$11,now(),$12)`,
    [invoiceId, reference, input.kind, JSON.stringify({ userId: input.supplierId, ...input.supplier }),
      JSON.stringify({ name: 'کلبه وینتج', legalName: 'کلبه وینتج' }),
      totalCredit.toString(), totalDebit.toString(), (net > 0n ? net : 0n).toString(),
      input.note ?? `صورت‌حساب ${periodText}`, input.actorId, input.supplierId, templateVersionId]);
  for (const [index, line] of input.lines.entries()) {
    const amount = line.debit > 0n ? line.debit : line.credit;
    await client.query(
      `INSERT INTO invoice_lines(id,invoice_id,line_no,product_name,description,quantity,unit_price_rial,discount_rial,tax_rial,line_total_rial)
       VALUES ($1,$2,$3,$4,$5,1,$6,0,0,$6)`,
      [randomUUID(), invoiceId, index + 1, STATEMENT_EVENT_LABEL[line.event] ?? line.event,
        `${line.reference} — ${formatJalali(line.occurredAt)} — ${line.debit > 0n ? 'بدهکار' : 'بستانکار'}`,
        amount.toString()]);
  }
  await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'issued',$3,$4,$5)`,
    [randomUUID(), invoiceId, input.actorId, `صدور سند ${input.title}`, JSON.stringify({ reference, lines: input.lines.length })]);
  const rendered = await renderInvoiceDocument(client, invoiceId, { templateVersionId });
  const { buffer, versionId, snapshot } = rendered;
  const { storageKey, sha256 } = await putFile(buffer, `${input.kind}-${reference}.pdf`, 'application/pdf');
  const fileId = randomUUID();
  await client.query(
    `INSERT INTO files(id, owner_id, storage_key, original_name, mime_type, size_bytes, sha256, visibility)
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,'private')`,
    [fileId, input.actorId, storageKey, `${input.kind}-${reference}.pdf`, buffer.length, sha256]);
  await client.query('UPDATE invoices SET pdf_file_id = $2, template_version_id = $3, snapshot = $4 WHERE id = $1',
    [invoiceId, fileId, versionId, JSON.stringify(snapshot)]);
  return { id: invoiceId, reference, fileId, totalCredit, totalDebit, net, periodText };
}

/** Preview an (possibly unsaved) template definition with sample data (item 28). */
export async function renderTemplatePreview(definition: TemplateDefinition, kind = 'retail_sale') {
  const sampleParams = {
    invoice: {
      id: '00000000-0000-4000-8000-000000000000', reference: 'INV-1405-000123', kind, status: 'issued',
      buyer: { name: 'خانم زهرا محمدی', phone: '۰۹۱۲۳۴۵۶۷۸۹', address: 'تهران، خیابان ولیعصر، پلاک ۱۲', nationalId: '۰۰۱۲۳۴۵۶۷۸' },
      seller: { name: 'کلبه وینتج', legalName: 'کلبه وینتج', address: 'اصفهان، خیابان چهارباغ', phone: '۰۳۱۳۲۲۲۳۳۳۳' },
      subtotal_rial: '100000000', discount_rial: '5000000', tax_rial: '9000000', shipping_rial: '2000000',
      services_fee_rial: '0', gross_rial: '95000000', total_rial: '106000000', paid_rial: '22000000',
      remaining_rial: '84000000', issue_date: new Date(), due_date: null, notes: 'این یک پیش‌نمایش است.',
    } as unknown as InvoiceRow,
    lines: [
      { product_name: 'کت کرم پشمی (سایز M)', sku: 'KV-1001', quantity: 2, unit_price_rial: '42000000', discount_rial: '5000000', tax_rial: '0', line_total_rial: '79000000' },
      { product_name: 'شال ابریشم دستباف', sku: 'KV-1002', quantity: 1, unit_price_rial: '26000000', discount_rial: '0', tax_rial: '0', line_total_rial: '26000000' },
    ] as InvoiceLineRow[],
  };
  const context = templateContext(sampleParams);
  return renderPdf(buildDocument({
    definition, context, lines: sampleParams.lines, totals: invoiceTotalsRows(sampleParams.invoice),
    title: 'پیش‌نمایش قالب سند', subtitle: `نوع سند: ${KIND_LABEL[kind] ?? kind}`,
  }));
}
