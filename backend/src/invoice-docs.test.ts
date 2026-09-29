import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { extractPdfText, pdfStructure } from './pdf-inspect.js';
import { toVisual } from './shaping.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4003, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('invoice templates, lifecycle, snapshots and PDF documents (items 25-34)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `doc-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر اسناد']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `doc-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // --- template catalogue + builder -------------------------------------------------
    const templates = await app.inject({ method: 'GET', url: '/api/v1/invoices/templates', headers });
    assert.equal(templates.statusCode, 200, templates.body);
    const codes = (templates.json().items as Array<{ code: string }>).map((item) => item.code);
    assert.ok(codes.includes('official-invoice') && codes.includes('settlement-statement'), 'قالب‌های پیش‌فرض موجودند');

    const variables = await app.inject({ method: 'GET', url: '/api/v1/invoices/templates/variables', headers });
    assert.equal(variables.statusCode, 200, variables.body);
    assert.ok((variables.json().groups as Array<{ items: Array<{ path: string }> }>)
      .flatMap((group) => group.items).some((item) => item.path === 'invoice.number'), 'متغیر شماره سند موجود است');

    const custom = await app.inject({ method: 'POST', url: '/api/v1/invoices/templates', headers, payload: {
      code: `vip-${suffix}`, title: 'قالب ویژه', kind: 'vip_sale',
      definition: { paperSize: 'A4', footer: 'کلبه وینتج — ویژه',
        sections: [
          { id: 'head', type: 'keyValues', title: 'طرفین', order: 1, visible: true,
            fields: ['invoice.number', 'customer.name', 'invoice.date', 'order.reference'] },
          { id: 'items', type: 'table', title: 'اقلام', order: 2, visible: true },
          { id: 'totals', type: 'totals', order: 3, visible: true },
          { id: 'note', type: 'paragraph', order: 4, visible: true, text: 'شماره سند {{invoice.number}} برای {{customer.name}}' },
          { id: 'sign', type: 'signature', order: 5, visible: true, lines: ['امضای فروشنده'] },
        ] },
      changeNote: 'نسخه اولیه' } });
    assert.equal(custom.statusCode, 201, custom.body);
    const templateId = custom.json().id as string;

    const versionBump = await app.inject({ method: 'POST', url: `/api/v1/invoices/templates/${templateId}/versions`, headers,
      payload: { definition: { paperSize: 'A4',
        sections: [{ id: 'items', type: 'table', order: 1, visible: true }] }, changeNote: 'نسخه دوم' } });
    assert.equal(versionBump.statusCode, 201, versionBump.body);
    assert.equal(versionBump.json().version, 2);

    const preview = await app.inject({ method: 'POST', url: `/api/v1/invoices/templates/${templateId}/preview`, headers, payload: {} });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.match(preview.headers['content-type'] as string, /application\/pdf/);
    const previewPdf = preview.rawPayload;
    const previewStructure = pdfStructure(previewPdf);
    assert.equal(previewStructure.a4, true, 'پیش‌نمایش A4 است');
    assert.equal(previewStructure.embeddedFont, true, 'فونت فارسی جاسازی شده است');
    assert.ok(previewStructure.pageCount >= 1);

    // --- lifecycle: draft → issued with ledger posting and stored PDF ------------------
    const customerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [customerId, `doc-customer-${suffix}@example.test`, await argon2.hash('CustomerPassword123!'), 'خانم زهرا محمدی']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [customerId, 'customer']);
    const draft = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers, payload: {
      kind: 'vip_sale', status: 'draft', templateCode: `vip-${suffix}`,
      partyUserId: customerId,
      buyer: { name: 'خانم زهرا محمدی', phone: '09123456789', address: 'تهران، خیابان ولیعصر' },
      seller: { name: 'کلبه وینتج', legalName: 'کلبه وینتج', address: 'اصفهان، چهارباغ' },
      paymentType: 'transfer',
      lines: [{ sku: 'KV-VIP-1', productName: 'کت کرم پشمی', quantity: 2, unitPriceRial: '42000000', discountRial: '5000000', taxRial: '0' }],
      discountRial: '0', taxRial: '9000000', shippingRial: '2000000',
      notes: 'سفارش ویژه مشتری وفادار',
    } });
    assert.equal(draft.statusCode, 201, draft.body);
    const draftId = draft.json().id as string;
    assert.equal(draft.json().status, 'draft');
    const draftJournal = await pool.query('SELECT count(*)::int AS count FROM journal_entries WHERE source_id = $1', [draftId]);
    assert.equal(draftJournal.rows[0].count, 0, 'پیش‌نویس سند حسابداری ندارد');

    const issued = await app.inject({ method: 'POST', url: `/api/v1/invoices/${draftId}/issue`, headers, payload: {} });
    assert.equal(issued.statusCode, 200, issued.body);
    assert.equal(issued.json().status, 'issued');
    assert.match(issued.json().pdfUrl as string, /\/pdf$/);

    const invoiceRow = await pool.query(
      'SELECT issued_at, snapshot, template_version_id, pdf_file_id FROM invoices WHERE id = $1', [draftId]);
    assert.ok(invoiceRow.rows[0].issued_at, 'زمان صدور ثبت شده است');
    assert.ok(invoiceRow.rows[0].template_version_id, 'نسخه قالب روی سند قفل شده است');
    assert.ok(invoiceRow.rows[0].pdf_file_id, 'فایل PDF در دامنه فایل ذخیره شده است');
    const snapshot = invoiceRow.rows[0].snapshot as { context: { invoice: { number: string; total: string } }; templateVersion: number };
    assert.equal(snapshot.context.invoice.number.startsWith('INV-'), true);
    assert.equal(snapshot.templateVersion, 2, 'اسنپ‌شات نسخه قالب را نگه می‌دارد');

    const journal = await pool.query(
      `SELECT sum(debit_rial)::text AS debit, sum(credit_rial)::text AS credit FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_id = $1`, [draftId]);
    assert.equal(journal.rows[0].debit, journal.rows[0].credit, 'سند حسابداری متوازن است');

    const outbox = await pool.query("SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'invoice.issued' AND aggregate_id = $1", [draftId]);
    assert.equal(outbox.rows[0].count, 1, 'رویداد invoice.issued منتشر شده است');

    // --- the printable document renders the Persian content ---------------------------
    const pdf = await app.inject({ method: 'GET', url: `/api/v1/invoices/${draftId}/pdf`, headers });
    assert.equal(pdf.statusCode, 200, pdf.body);
    assert.match(pdf.headers['content-type'] as string, /application\/pdf/);
    const bytes = pdf.rawPayload;
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    const structure = pdfStructure(bytes);
    assert.equal(structure.a4, true);
    assert.equal(structure.embeddedFont, true);
    const text = extractPdfText(bytes);
    assert.ok(text.includes(toVisual('کت کرم پشمی')), `UI text missing in PDF: ${JSON.stringify(text.slice(0, 400))}`);
    assert.ok(text.includes('INV-'), 'شماره سند روی PDF چاپ شده است');
    const stored = await pool.query('SELECT original_name, mime_type, size_bytes FROM files WHERE id = $1', [invoiceRow.rows[0].pdf_file_id]);
    assert.equal(stored.rows[0].mime_type, 'application/pdf');
    assert.ok(Number(stored.rows[0].size_bytes) > 1000);

    // --- permission-gated: strangers cannot download --------------------------------
    const strangerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [strangerId, `doc-stranger-${suffix}@example.test`, await argon2.hash('StrangerPassword123!'), 'غریبه']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [strangerId, 'customer']);
    const strangerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `doc-stranger-${suffix}@example.test`, password: 'StrangerPassword123!' } });
    const strangerHeaders = { authorization: `Bearer ${strangerLogin.json().accessToken as string}` };
    const denied = await app.inject({ method: 'GET', url: `/api/v1/invoices/${draftId}/pdf`, headers: strangerHeaders });
    assert.equal(denied.statusCode, 404, denied.body);

    // --- refund → credit document, original marked refunded ---------------------------
    const refund = await app.inject({ method: 'POST', url: `/api/v1/invoices/${draftId}/refunds`, headers,
      payload: { reason: 'مرجوعی کامل کالا', full: true } });
    assert.equal(refund.statusCode, 201, refund.body);
    const refundId = refund.json().id as string;
    const refundRow = await pool.query('SELECT kind, credit_note_for, status, pdf_file_id FROM invoices WHERE id = $1', [refundId]);
    assert.equal(refundRow.rows[0].kind, 'refund');
    assert.equal(refundRow.rows[0].credit_note_for, draftId);
    assert.ok(refundRow.rows[0].pdf_file_id, 'سند بازپرداخت هم PDF دارد');
    const original = await pool.query('SELECT status, refunded_at FROM invoices WHERE id = $1', [draftId]);
    assert.equal(original.rows[0].status, 'refunded');
    assert.ok(original.rows[0].refunded_at);
    const refundTotal = await pool.query('SELECT total_rial FROM invoices WHERE id = $1', [refundId]);
    const refundPosted = await pool.query(
      `SELECT sum(debit_rial)::text AS debit, sum(credit_rial)::text AS credit FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_id = $1`, [refundId]);
    assert.equal(refundPosted.rows[0].debit, refundPosted.rows[0].credit, 'سند بازپرداخت متوازن است');
    assert.equal(BigInt(refundTotal.rows[0].total_rial) > 0n, true);

    // --- void a posted document reverses the ledger ------------------------------------
    const second = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers, payload: {
      kind: 'retail_sale',
      buyer: { name: 'خریدار خرده' }, seller: { name: 'کلبه وینتج' },
      lines: [{ productName: 'شال ابریشم', quantity: 1, unitPriceRial: '26000000', discountRial: '0', taxRial: '0' }],
    } });
    const secondId = second.json().id as string;
    const voided = await app.inject({ method: 'POST', url: `/api/v1/invoices/${secondId}/void`, headers,
      payload: { reason: 'درخواست مشتری برای لغو' } });
    assert.equal(voided.statusCode, 200, voided.body);
    const voidRow = await pool.query('SELECT status, voided_at FROM invoices WHERE id = $1', [secondId]);
    assert.equal(voidRow.rows[0].status, 'void');
    const reversal = await pool.query(
      `SELECT sum(debit_rial)::text AS debit, sum(credit_rial)::text AS credit FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_type = 'invoice_void' AND e.source_id::text LIKE $1`,
      [`%`]);
    assert.equal(reversal.rows[0].debit, reversal.rows[0].credit, 'سند برگشتی متوازن است');

    // --- supplier statement document (settlement completed → statement) ---------------
    const supplierId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supplierId, `doc-supplier-${suffix}@example.test`, await argon2.hash('SupplierPassword12345!'), 'تأمین‌کننده اسناد']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [supplierId, 'supplier']);
    await pool.query("INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')", [supplierId, 'برند اسناد']);
    const { accrueSupplier } = await import('./ledger.js');
    const { transaction } = await import('./db.js');
    await transaction(pool, (client) => accrueSupplier(client, [{ event: 'order_sale', amount: 100000000n,
      reference: `SET-L1-${suffix}`, description: 'فروش سفارش تست', supplierId }]));

    const statement = await app.inject({ method: 'POST', url: '/api/v1/invoices/statements/supplier', headers, payload: {
      supplierId, from: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } });
    assert.equal(statement.statusCode, 201, statement.body);
    assert.match(statement.json().reference as string, /^INV-\d{4}-\d{6}$/);
    const statementRow = await pool.query('SELECT kind, lines.pdf_file_id FROM invoices lines WHERE id = $1', [statement.json().id]);
    assert.equal(statementRow.rows[0]?.pdf_file_id !== null, true, 'صورت‌حساب PDF ذخیره‌شده دارد');
    const statementPdf = await app.inject({ method: 'GET', url: statement.json().pdfUrl as string, headers });
    assert.equal(statementPdf.statusCode, 200, statementPdf.body);
    assert.equal(extractPdfText(statementPdf.rawPayload).includes(toVisual('فروش سفارش')), true, 'ردیف صورت‌حساب در PDF هست');
  } finally {
    await app.close();
    await pool.end();
  }
});
