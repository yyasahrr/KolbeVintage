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
  NODE_ENV: 'test', PORT: 4004, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('supplier 360: lifecycle, granular restrictions and financial drill-down (items 11-14)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `s360-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر تأمین‌کنندگان']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `s360-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    const supplierId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supplierId, `s360-sup-${suffix}@example.test`, await argon2.hash('SupplierPassword12345!'), 'برند آوین']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'supplier')", [supplierId]);
    await pool.query("INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'pending')",
      [supplierId, `برند ${suffix}`]);
    const supplierLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `s360-sup-${suffix}@example.test`, password: 'SupplierPassword12345!' } });
    assert.equal(supplierLogin.statusCode, 200, supplierLogin.body);
    const supplierHeaders = { authorization: `Bearer ${supplierLogin.json().accessToken as string}` };

    const productPayload = {
      brand: `برند ${suffix}`, name: 'شلوار وینتج', category: 'شلوار',
      cashPriceRial: '80000000', wholesalePriceRial: '60000000',
      metadata: { images: ['img-a'], specs: { fabric: 'فاستونی' } }, variants: [{ size: '32' }],
    };

    // --- pending_review: the supplier may not create or publish products -------
    const pending = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders, payload: productPayload });
    assert.equal(pending.statusCode, 403, pending.body);
    assert.match(pending.json().message as string, /در انتظار بررسی/);

    const before = await app.inject({ method: 'GET', url: `/api/v1/admin/suppliers/${supplierId}/360`, headers: adminHeaders });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().status.current, 'pending_review');
    assert.equal(before.json().status.label, 'در انتظار بررسی');
    const blockedTimeline = (before.json().timeline as Array<{ action: string }>).some((row) => row.action === 'supplier.action_blocked');
    assert.equal(blockedTimeline, true, 'تلاش مسدودشده در تایم‌لاین ثبت شده است');

    // --- activation requires a note and is fully audited -----------------------
    const noNote = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/activity-status`, headers: adminHeaders,
      payload: { status: 'active', reason: 'تأیید مدارک' } });
    assert.equal(noNote.statusCode, 400, noNote.body);
    const activated = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/activity-status`, headers: adminHeaders,
      payload: { status: 'active', reason: 'تأیید مدارک و قرارداد', note: 'شروع همکاری' } });
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal(activated.json().label, 'فعال');

    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders, payload: productPayload });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;

    // --- a scoped restriction blocks exactly one action, not everything --------
    const restricted = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/restrictions`, headers: adminHeaders,
      payload: { scope: 'withdrawal', reason: 'شکایت مالی باز', durationDays: 30 } });
    assert.equal(restricted.statusCode, 201, restricted.body);
    const restrictionId = restricted.json().id as string;

    const withdrawal = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals', headers: { ...supplierHeaders, 'idempotency-key': `w-${suffix}` },
      payload: { amountRial: '1000000', destination: { bankName: 'بانک ملی', iban: 'IR000000000000000000000000', holderName: 'برند آوی' } } });
    assert.equal(withdrawal.statusCode, 403, withdrawal.body);
    assert.match(withdrawal.json().message as string, /شکایت مالی باز/);

    const stillEdits = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers: supplierHeaders,
      payload: { name: 'شلوار وینتج دوخت' } });
    assert.equal(stillEdits.statusCode, 200, stillEdits.body);

    const profile = await pool.query('SELECT activity_status, activity_reason FROM supplier_profiles WHERE user_id = $1', [supplierId]);
    assert.equal(profile.rows[0].activity_status, 'restricted');
    assert.equal(profile.rows[0].activity_reason, 'شکایت مالی باز');

    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/restrictions`, headers: adminHeaders,
      payload: { scope: 'withdrawal', reason: 'تکرار' } });
    assert.equal(duplicate.statusCode, 409, duplicate.body);

    // --- lifting the last restriction restores `active` ------------------------
    const lifted = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/restrictions/${restrictionId}/lift`,
      headers: adminHeaders, payload: { note: 'رفع با تأیید مالی' } });
    assert.equal(lifted.statusCode, 200, lifted.body);
    assert.equal(lifted.json().remainingActive, 0);
    const after = await pool.query('SELECT activity_status FROM supplier_profiles WHERE user_id = $1', [supplierId]);
    assert.equal(after.rows[0].activity_status, 'active');
    const history = await app.inject({ method: 'GET', url: `/api/v1/admin/suppliers/${supplierId}/status-history`, headers: adminHeaders });
    const transitions = (history.json().items as Array<{ from_status: string; to_status: string }>).map((row) => `${row.from_status}->${row.to_status}`);
    assert.ok(transitions.includes('pending_review->active'), transitions.join(','));
    assert.ok(transitions.includes('active->restricted'), transitions.join(','));
    assert.ok(transitions.includes('restricted->active'), transitions.join(','));

    // --- product cap ----------------------------------------------------------
    const cap = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/restrictions`, headers: adminHeaders,
      payload: { scope: 'product_limit', reason: 'سقف توافق‌شده', limitValue: '2' } });
    assert.equal(cap.statusCode, 201, cap.body);
    const second = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders,
      payload: { ...productPayload, name: 'پیراهن وینتج' } });
    assert.equal(second.statusCode, 201, second.body);
    const third = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders,
      payload: { ...productPayload, name: 'کت وینتج' } });
    assert.equal(third.statusCode, 403, third.body);
    assert.match(third.json().message as string, /سقف محصول/);
    const missingLimit = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/restrictions`, headers: adminHeaders,
      payload: { scope: 'sales_limit', reason: 'بدون عدد' } });
    assert.equal(missingLimit.statusCode, 400, missingLimit.body);

    // --- suspension blocks every action ---------------------------------------
    const suspended = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${supplierId}/activity-status`, headers: adminHeaders,
      payload: { status: 'suspended', reason: 'تخلف کیفی', durationDays: 10 } });
    assert.equal(suspended.statusCode, 200, suspended.body);
    const suspendedEdit = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers: supplierHeaders,
      payload: { name: 'تلاش در حالت تعلیق' } });
    assert.equal(suspendedEdit.statusCode, 403, suspendedEdit.body);

    // --- finance drill-down (item 14) ------------------------------------------
    await transaction(pool, (client) => accrueSupplier(client, [{ event: 'order_sale', amount: 50000000n,
      reference: `L1-${suffix}`, description: 'فروش دوره', supplierId }]));
    const finance = await app.inject({ method: 'GET', url: `/api/v1/admin/suppliers/${supplierId}/finance`, headers: adminHeaders });
    assert.equal(finance.statusCode, 200, finance.body);
    assert.ok(finance.json().account, 'حساب مالی تأمین‌کننده برمی‌گردد');
    assert.equal((finance.json().entries as Array<{ event: string }>).some((row) => row.event === 'order_sale'), true);
    assert.match(finance.json().links.statement as string, /\/statement$/);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/suppliers/${supplierId}/360`, headers: adminHeaders });
    assert.equal(detail.json().financeSummary.payableRial.startsWith('50000000'), true, JSON.stringify(detail.json().financeSummary));
    assert.equal((detail.json().restrictions as unknown[]).length >= 2, true);
    const performance = detail.json().performance as Record<string, unknown>;
    assert.equal(typeof performance.avg_delivery_days, 'string', 'شاخص عملکرد از رویدادهای واقعی محاسبه می‌شود');
    assert.ok(performance.products, 'توزیع وضعیت محصولات');

    // Item 11: the 360 file also carries the real WMS position, the supplier's tickets
    // and the versioned profile history — never a number typed into the console.
    const overview = detail.json();
    assert.equal(typeof overview.inventory.available, 'number', 'موجودی از WMS خوانده می‌شود');
    assert.ok(overview.inventory.product_count >= 1);
    assert.ok(overview.inventory.variant_count >= 1);
    assert.ok(Array.isArray(overview.tickets.items));
    assert.equal(typeof overview.tickets.openCount, 'number');
    assert.ok(Array.isArray(overview.profileVersions) && Array.isArray(overview.statusHistory));
  } finally {
    await app.close();
    await pool.end();
  }
});
