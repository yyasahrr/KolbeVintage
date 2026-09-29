import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, transaction } from './db.js';
import { accrueSupplier } from './ledger.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4005, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('financial operations: settlements, approvals, adjustments, periods and reports (items 144-172)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `fin-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر مالی']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `fin-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    assert.equal(adminLogin.statusCode, 200, adminLogin.body);
    const admin = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    // A second finance user proves the two-step approval rule (no self-approval).
    const financeId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [financeId, `fin-officer-${suffix}@example.test`, await argon2.hash('FinancePassword12345!'), 'کارشناس مالی']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'finance')", [financeId]);
    const financeLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `fin-officer-${suffix}@example.test`, password: 'FinancePassword12345!' } });
    const officer = { authorization: `Bearer ${financeLogin.json().accessToken as string}` };

    const supplierId = randomUUID();
    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supplierId, `fin-sup-${suffix}@example.test`, await argon2.hash('SupplierPassword12345!'), 'تأمین‌کننده مالی']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'supplier')", [supplierId]);
    await pool.query("INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status,commission_percent) VALUES ($1,$2,'approved',10)",
      [supplierId, `برند مالی ${suffix}`]);
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `fin-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'خریدار مالی']);

    // A delivered order with two suppliers: only this supplier's line is settleable.
    const productId = randomUUID();
    const variantId = randomUUID();
    await pool.query(`INSERT INTO products(id,supplier_id,brand,name,category,status,cash_price_rial,wholesale_price_rial)
                      VALUES ($1,$2,'برند مالی','کت وینتج','کت','published','90000000','70000000')`, [productId, supplierId]);
    await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,attributes)
                      VALUES ($1,$2,$3,'M','{"volumeCm3": 2000}')`, [variantId, productId, `SKU-${suffix}`]);
    const orderId = randomUUID();
    const orderLineId = randomUUID();
    await pool.query(`INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,shipping_rial,discount_rial,total_rial,paid_at,updated_at)
                      VALUES ($1,$2,$3,'wholesale','cash','delivered',200000000,20000000,0,220000000,now(),now())`,
      [orderId, `ORD-${suffix}`, buyerId]);
    await pool.query(`INSERT INTO order_events(id,order_id,to_status,note) VALUES ($1,$2,'delivered','تحویل شد')`, [randomUUID(), orderId]);
    await pool.query(`INSERT INTO order_lines(id,order_id,product_id,variant_id,supplier_id,product_name,sku,quantity,unit_price_rial,line_total_rial,weight_grams)
                      VALUES ($1,$2,$3,$4,$5,'کت وینتج',$6,2,100000000,200000000,1500)`,
      [orderLineId, orderId, productId, variantId, supplierId, `SKU-${suffix}`]);

    // ------------------------------------------------------------- settlement --
    const settlement = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/settlements', headers: admin, payload: {
      supplierId, from: new Date(Date.now() - 86400_000).toISOString().slice(0, 10),
      to: new Date(Date.now() + 86400_000).toISOString().slice(0, 10), shippingRule: 'value',
    } });
    assert.equal(settlement.statusCode, 201, settlement.body);
    const settlementId = settlement.json().id as string;
    // 200,000,000 gross − 10% commission − 20,000,000 shipping = 160,000,000
    assert.equal(settlement.json().netRial, '160000000');
    assert.equal(settlement.json().grossRial, '200000000');
    assert.equal(settlement.json().commissionRial, '20000000');
    assert.equal(settlement.json().shippingRial, '20000000');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/settlements/${settlementId}`, headers: admin });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, 'pending');
    assert.equal(detail.json().reconciliation_status, 'expected');
    assert.equal((detail.json().lines as unknown[]).length, 1);
    const approvalId = detail.json().approval.id as string;
    assert.equal(detail.json().approval.status, 'requested');

    const statement = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/suppliers/${supplierId}/statement`, headers: admin });
    assert.equal(statement.statusCode, 200, statement.body);
    const events = (statement.json().entries as Array<{ event: string }>).map((row) => row.event);
    assert.ok(events.includes('order_sale') && events.includes('commission') && events.includes('shipping_charge'), events.join(','));
    const ledger = await pool.query(
      `SELECT sum(debit_rial)::text AS debit, sum(credit_rial)::text AS credit FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_type = 'supplier_ledger'`);
    assert.equal(ledger.rows[0].debit, ledger.rows[0].credit, 'هر رویداد تأمین‌کننده سند متوازن دارد');

    // Paying before approval is refused; the requester cannot approve their own request.
    const early = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`, headers: admin,
      payload: { reference: 'PAY-EARLY' } });
    assert.equal(early.statusCode, 409, early.body);
    const selfApprove = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/approvals/${approvalId}/approve`, headers: admin,
      payload: { note: 'خودتأیید' } });
    assert.equal(selfApprove.statusCode, 409, selfApprove.body);

    const reviewed = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/approvals/${approvalId}/review`, headers: officer,
      payload: { note: 'بررسی اولیه' } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const approved = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/approvals/${approvalId}/approve`, headers: officer,
      payload: { note: 'تأیید پرداخت' } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'approved');

    const paid = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`, headers: officer,
      payload: { method: 'transfer', reference: 'PAY-OK-1' } });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(paid.json().status, 'paid');
    const paidRow = await pool.query('SELECT paid_at, statement_invoice_id FROM settlements WHERE id = $1', [settlementId]);
    assert.ok(paidRow.rows[0].paid_at);
    assert.ok(paidRow.rows[0].statement_invoice_id, 'سند تسویه صادر شده است');

    const reconciled = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/reconcile`, headers: officer,
      payload: { actualRial: '160000000' } });
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    assert.equal(reconciled.json().reconciliationStatus, 'reconciled');

    const afterPayment = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/suppliers/${supplierId}/statement`, headers: admin });
    const settlementEvents = (afterPayment.json().entries as Array<{ event: string }>).map((row) => row.event);
    assert.ok(settlementEvents.includes('settlement'), settlementEvents.join(','));

    // ------------------------------------------------------------ adjustments --
    const adjustment = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/adjustments', headers: admin, payload: {
      supplierId, direction: 'debit', amountRial: '5000000', category: 'penalty', reason: 'تأخیر در ارسال',
    } });
    assert.equal(adjustment.statusCode, 201, adjustment.body);
    const adjustmentId = adjustment.json().id as string;
    // Two-step approval: the requester may not approve their own adjustment.
    const selfApply = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/adjustments/${adjustmentId}/apply`, headers: admin,
      payload: {} });
    assert.equal(selfApply.statusCode, 409, selfApply.body);
    const adjustmentApproval = await pool.query(
      "SELECT id FROM finance_approvals WHERE subject_type = 'adjustment' AND subject_id = $1", [adjustmentId]);
    const adjustmentApproved = await app.inject({ method: 'POST',
      url: `/api/v1/admin/finance/approvals/${adjustmentApproval.rows[0].id}/approve`, headers: officer, payload: { note: 'تأیید جریمه' } });
    assert.equal(adjustmentApproved.statusCode, 200, adjustmentApproved.body);
    const applied = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/adjustments/${adjustmentId}/apply`, headers: officer,
      payload: { note: 'اعمال پس از تأیید' } });
    assert.equal(applied.statusCode, 200, applied.body);
    const adjustmentLedger = await pool.query(
      `SELECT event, direction, journal_entry_id FROM supplier_ledger_entries WHERE supplier_id = $1 AND event = 'penalty'`, [supplierId]);
    assert.equal(adjustmentLedger.rows.length, 1);
    assert.equal(adjustmentLedger.rows[0].direction, 'debit');
    assert.ok(adjustmentLedger.rows[0].journal_entry_id, 'هر ردیف صورت‌حساب به سند حسابداری وصل است');
    const balance = await pool.query(
      `SELECT pending_payable_rial::text, penalties_rial::text FROM supplier_finance_accounts WHERE user_id = $1`, [supplierId]);
    assert.equal(balance.rows[0].penalties_rial, '5000000');

    // A fresh accrual restores a positive payable before the advance is applied.
    await transaction(pool, (client) => accrueSupplier(client, [{ event: 'order_sale', amount: 50000000n,
      reference: `L2-${suffix}`, description: 'فروش دوره دوم', supplierId }]));

    // ---------------------------------------------------------------- advances --
    const advance = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/advances', headers: admin, payload: {
      supplierId, amountRial: '30000000', reason: 'پیش‌پرداخت خرید مواد',
    } });
    assert.equal(advance.statusCode, 201, advance.body);
    const advancePaid = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/advances/${advance.json().id as string}/pay`,
      headers: officer, payload: { reference: 'ADV-1', method: 'transfer' } });
    assert.equal(advancePaid.statusCode, 200, advancePaid.body);
    const advanceApplied = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/advances/${advance.json().id as string}/apply`,
      headers: officer, payload: { amountRial: '10000000' } });
    assert.equal(advanceApplied.statusCode, 200, advanceApplied.body);
    const advanceRow = await pool.query('SELECT applied_rial::text, status FROM supplier_advances WHERE id = $1', [advance.json().id]);
    assert.equal(advanceRow.rows[0].applied_rial, '10000000');
    const prepayEvents = await pool.query(
      `SELECT event, direction FROM supplier_ledger_entries WHERE supplier_id = $1 AND event IN ('prepayment','prepayment_applied')
        ORDER BY occurred_at`, [supplierId]);
    assert.ok(prepayEvents.rows.length >= 2, JSON.stringify(prepayEvents.rows));

    // ------------------------------------------------------------------ aging --
    const aging = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/aging', headers: admin });
    assert.equal(aging.statusCode, 200, aging.body);
    assert.equal(typeof aging.json().payable.totals.not_due, 'string');
    const payableBuckets = Object.keys(aging.json().payable.totals);
    assert.deepEqual(payableBuckets, ['not_due', 'days_1_7', 'days_8_30', 'days_31_60', 'days_61_90', 'days_over_90']);

    // ----------------------------------------------- shipping allocation engine --
    const allocation = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/shipping-allocations', headers: admin, payload: {
      orderId, totalCostRial: '20000000', rule: 'weight', carrier: 'پست پیشتاز',
    } });
    assert.equal(allocation.statusCode, 201, allocation.body);
    const allocationLines = allocation.json().lines as Array<{ supplierId: string; amountRial: string }>;
    assert.equal(allocationLines.length, 1);
    assert.equal(allocationLines[0]!.supplierId, supplierId);
    assert.equal(allocationLines[0]!.amountRial, '20000000', 'تک‌سطر کل هزینه را می‌گیرد');
    const snapshot = await pool.query('SELECT snapshot->>\'rule\' AS rule FROM shipping_allocations WHERE id = $1', [allocation.json().id]);
    assert.equal(snapshot.rows[0].rule, 'weight', 'قاعده تخصیص در اسنپ‌شات ثبت می‌شود');

    // ---------------------------------------------------------------- reports --
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports', headers: admin });
    assert.equal(catalog.statusCode, 200, catalog.body);
    const codes = (catalog.json().items as Array<{ code: string }>).map((item) => item.code);
    assert.ok(codes.includes('ledger_balances') && codes.includes('payables_aging') && codes.includes('settlements'), codes.join(','));

    const ledgerReport = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/ledger_balances', headers: admin });
    assert.equal(ledgerReport.statusCode, 200, ledgerReport.body);
    assert.ok((ledgerReport.json().rows as unknown[]).length > 5);
    const agingReport = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/payables_aging', headers: admin });
    assert.equal(agingReport.statusCode, 200, agingReport.body);

    const csv = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/ledger_balances?format=csv', headers: admin });
    assert.equal(csv.statusCode, 200, csv.body);
    assert.match(csv.headers['content-type'] as string, /text\/csv/);
    assert.ok(csv.body.includes('\uFEFF'), 'CSV با BOM برای اکسل');
    const xlsx = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/settlements?format=xlsx', headers: admin });
    assert.equal(xlsx.statusCode, 200, xlsx.body);
    assert.equal(xlsx.rawPayload.subarray(0, 2).toString('latin1'), 'PK');
    const reportPdf = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/payables_aging?format=pdf', headers: admin });
    assert.equal(reportPdf.statusCode, 200, reportPdf.body);
    assert.equal(reportPdf.rawPayload.subarray(0, 5).toString('latin1'), '%PDF-');

    // A user without finance permissions may not export.
    const supplierLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `fin-sup-${suffix}@example.test`, password: 'SupplierPassword12345!' } });
    const supplierHeaders = { authorization: `Bearer ${supplierLogin.json().accessToken as string}` };
    const forbiddenExport = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/reports/ledger_balances?format=xlsx', headers: supplierHeaders });
    assert.equal(forbiddenExport.statusCode, 403, forbiddenExport.body);

    // ------------------------------------------------- dashboard and periods --
    const summary = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/summary', headers: admin });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.ok(summary.json().metrics, 'شاخص‌های دوره جاری');
    assert.ok(summary.json().comparison, 'دوره قبلی برای مقایسه');
    assert.equal(typeof (summary.json().metrics as Record<string, string>).revenue, 'string');
    const analytics = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/analytics?groupBy=channel', headers: admin });
    assert.equal(analytics.statusCode, 200, analytics.body);
    const targets = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/targets', headers: admin });
    assert.equal(targets.statusCode, 200, targets.body);

    const periods = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/periods', headers: admin });
    assert.equal(periods.statusCode, 200, periods.body);
    const periodItems = periods.json().items as Array<{ code: string; status: string }>;
    const currentCode = periodItems.find((item) => item.status === 'open')!.code;
    assert.ok(currentCode, 'دوره جاری باز است');

    // The running month cannot be closed before it ends — that guard is part of the contract.
    const earlyClose = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/periods/${currentCode}/close`, headers: admin,
      payload: { note: 'تلاش برای بستن دوره جاری' } });
    assert.equal(earlyClose.statusCode, 409, earlyClose.body);

    // A finished month can be closed, locked and — from closed — reopened.
    const pastCode = '2001-01';
    await pool.query(`INSERT INTO accounting_periods(code, title, starts_on, ends_on, status)
      VALUES ($1, 'دوره آزمایشی گذشته', '2001-01-01', '2001-01-31', 'open') ON CONFLICT (code) DO NOTHING`, [pastCode]);
    const closed = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/periods/${pastCode}/close`, headers: admin,
      payload: { note: 'بستن دوره' } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().status, 'closed');
    const locked = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/periods/${pastCode}/lock`, headers: admin,
      payload: { note: 'قفل دوره' } });
    assert.equal(locked.statusCode, 200, locked.body);
    assert.equal(locked.json().status, 'locked');
    const lockedReopen = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/periods/${pastCode}/reopen`, headers: admin,
      payload: { note: 'بازگشایی دوره قفل‌شده' } });
    assert.equal(lockedReopen.statusCode, 409, lockedReopen.body);
    await pool.query("UPDATE accounting_periods SET status = 'closed' WHERE code = $1", [pastCode]);
    const reopened = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/periods/${pastCode}/reopen`, headers: admin,
      payload: { note: 'بازگشایی برای اصلاح' } });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(reopened.json().status, 'open');

    const feed = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/events', headers: admin });
    assert.equal(feed.statusCode, 200, feed.body);
    const feedTypes = (feed.json().items as Array<{ event_type: string }>).map((row) => row.event_type);
    assert.ok(feedTypes.some((type) => type.startsWith('settlement.')), feedTypes.join(','));

    // Accrued supplier money is exposed through the finance dashboard list.
    await transaction(pool, (client) => accrueSupplier(client, [{ event: 'bonus', amount: 1000000n,
      reference: `BONUS-${suffix}`, description: 'پاداش همکاری', supplierId }]));
    const suppliers = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/suppliers?search=برند مالی ${suffix}`, headers: admin });
    assert.equal(suppliers.statusCode, 200, suppliers.body);
    assert.equal((suppliers.json().items as unknown[]).length, 1);
  } finally {
    await app.close();
    await pool.end();
  }
});
