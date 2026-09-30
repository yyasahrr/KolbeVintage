import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4003, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('wallet earnings, withdrawal lifecycle and settlements are traceable', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    // Finance admin.
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `w-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Finance admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    // Supplier with a 10% platform commission.
    const supplierId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supplierId, `w-sup-${suffix}@example.test`, await argon2.hash('SupplierPassword12345!'), 'Supplier']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [supplierId, 'supplier']);
    await pool.query(
      `INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status,commission_percent)
       VALUES ($1,$2,'approved',10)`, [supplierId, `Brand ${suffix}`]);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `w-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };
    const supplierLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `w-sup-${suffix}@example.test`, password: 'SupplierPassword12345!' } });
    assert.equal(supplierLogin.statusCode, 200, supplierLogin.body);
    const supplierHeaders = { authorization: `Bearer ${supplierLogin.json().accessToken as string}` };

    // Product, stock, order and verified payment up to delivery.
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders,
      payload: { brand: `Brand ${suffix}`, name: 'کت وینتج', category: 'کت', cashPriceRial: '100000000',
        wholesalePriceRial: '100000000', variants: [{ size: 'M', color: 'کرم' }] } });
    assert.equal(product.statusCode, 201, product.body);
    const variantId = product.json().variants[0].id as string;
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [product.json().id]);
    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders,
      payload: { code: `W-${suffix.toUpperCase()}`, name: 'انبار مرکزی' } });
    const warehouseId = warehouse.json().id as string;
    await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...adminHeaders, 'idempotency-key': `stock-${suffix}` },
      payload: { variantId, warehouseId, delta: 2, reason: 'موجودی اولیه', reference: `ST-${suffix}` } });

    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `w-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'Buyer']);
    // Supplier listings are wholesale-only (item 35): the buyer needs a plan membership.
    const planId = randomUUID();
    await pool.query(`INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,$3,0,'{}')`,
      [planId, `w-plan-${suffix}`, 'Wholesale plan']);
    await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`,
      [randomUUID(), buyerId, planId]);
    const buyerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `w-buyer-${suffix}@example.test`, password: 'BuyerPassword123456!' } });
    const buyerHeaders = { authorization: `Bearer ${buyerLogin.json().accessToken as string}` };
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': `o-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
        shippingAddress: { recipient: 'خریدار تست', phone: '09123456789', province: 'تهران', city: 'تهران',
          line: 'خیابان تست، پلاک ۱', postalCode: '1234567890' } } });
    assert.equal(order.statusCode, 201, order.body);
    const intentId = order.json().paymentIntentId as string;
    await pool.query("UPDATE payment_intents SET provider = 'verified-test-adapter', provider_reference = $2 WHERE id = $1",
      [intentId, `ref-${suffix}`]);
    await applyVerifiedPayment(pool, { provider: 'verified-test-adapter', providerEventId: `ev-${suffix}`,
      providerReference: `ref-${suffix}`, intentId, amountRial: '100000000', paidAt: new Date() });
    for (const status of ['processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped', 'delivered'] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/orders/${order.json().id}/transitions`,
        headers: adminHeaders, payload: { status } });
      assert.equal(response.statusCode, 200, response.body);
    }

    // Delivery credited the supplier wallet: 100,000,000 earning minus 10% commission.
    const wallet = await app.inject({ method: 'GET', url: '/api/v1/wallet', headers: supplierHeaders });
    assert.equal(wallet.json().availableRial, '90000000');
    assert.equal(wallet.json().totals.earnedRial, '100000000');
    assert.equal(wallet.json().totals.commissionRial, '10000000');
    const entries = await app.inject({ method: 'GET', url: '/api/v1/wallet/entries', headers: supplierHeaders });
    assert.equal(entries.json().items.length, 2);
    assert.match(entries.json().items[0].reference as string, /^TXN-\d{4}-\d{6}$/);

    // Withdrawal request is idempotent and holds the amount.
    const withdrawalPayload = { amountRial: '50000000',
      destination: { bankName: 'ملت', iban: 'IR060120020000000397455001', holderName: 'صاحب حساب' } };
    const withdrawal = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals',
      headers: { ...supplierHeaders, 'idempotency-key': `wd-${suffix}` }, payload: withdrawalPayload });
    assert.equal(withdrawal.statusCode, 201, withdrawal.body);
    assert.match(withdrawal.json().reference as string, /^WDR-\d{4}-\d{6}$/);
    const repeat = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals',
      headers: { ...supplierHeaders, 'idempotency-key': `wd-${suffix}` }, payload: withdrawalPayload });
    assert.equal(repeat.json().id, withdrawal.json().id);
    const over = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals',
      headers: { ...supplierHeaders, 'idempotency-key': `wd-over-${suffix}` },
      payload: { ...withdrawalPayload, amountRial: '90000000' } });
    assert.equal(over.statusCode, 409, over.body);
    const held = await app.inject({ method: 'GET', url: '/api/v1/wallet', headers: supplierHeaders });
    assert.equal(held.json().availableRial, '40000000');
    assert.equal(held.json().pendingRial, '50000000');

    // A rejected withdrawal releases the hold.
    const withdrawalId = withdrawal.json().id as string;
    for (const [status, extra] of [['under_review', {}], ['rejected', { rejectReason: 'شماره شبا نادرست است' }]] as const) {
      const changed = await app.inject({ method: 'POST', url: `/api/v1/admin/withdrawals/${withdrawalId}/status`,
        headers: adminHeaders, payload: { status, note: 'بررسی', ...extra } });
      assert.equal(changed.statusCode, 200, changed.body);
    }
    const released = await app.inject({ method: 'GET', url: '/api/v1/wallet', headers: supplierHeaders });
    assert.equal(released.json().availableRial, '90000000');
    assert.equal(released.json().pendingRial, '0');

    // The full path pays out and posts a balanced ledger entry.
    const second = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals',
      headers: { ...supplierHeaders, 'idempotency-key': `wd2-${suffix}` }, payload: withdrawalPayload });
    const secondId = second.json().id as string;
    for (const status of ['under_review', 'approved', 'processing', 'paid'] as const) {
      const changed = await app.inject({ method: 'POST', url: `/api/v1/admin/withdrawals/${secondId}/status`,
        headers: adminHeaders, payload: { status, provider: 'manual', providerReference: `BANK-${suffix}` } });
      assert.equal(changed.statusCode, 200, changed.body);
    }
    const finalWallet = await app.inject({ method: 'GET', url: '/api/v1/wallet', headers: supplierHeaders });
    assert.equal(finalWallet.json().availableRial, '40000000');
    assert.equal(finalWallet.json().pendingRial, '0');
    assert.equal(finalWallet.json().totals.withdrawnRial, '50000000');
    const journal = await pool.query(
      `SELECT sum(l.debit_rial)::text AS debit, sum(l.credit_rial)::text AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_type = 'withdrawal'`);
    assert.equal(journal.rows[0].debit, journal.rows[0].credit);

    // An invalid transition is refused.
    const bad = await app.inject({ method: 'POST', url: `/api/v1/admin/withdrawals/${secondId}/status`,
      headers: adminHeaders, payload: { status: 'approved' } });
    assert.equal(bad.statusCode, 409, bad.body);

    // Settlement records a settlement invoice and can settle from the wallet.
    const settlement = await app.inject({ method: 'POST', url: '/api/v1/settlements', headers: adminHeaders,
      payload: { partyUserId: supplierId, amountRial: '40000000', note: 'تسویه ماهانه' } });
    assert.equal(settlement.statusCode, 201, settlement.body);
    assert.match(settlement.json().reference as string, /^SET-\d{4}-\d{6}$/);
    const settled = await app.inject({ method: 'POST', url: `/api/v1/settlements/${settlement.json().id}/settle`,
      headers: adminHeaders, payload: { method: 'wallet' } });
    assert.equal(settled.statusCode, 200, settled.body);
    const afterSettle = await app.inject({ method: 'GET', url: '/api/v1/wallet', headers: supplierHeaders });
    assert.equal(afterSettle.json().availableRial, '0');
    assert.equal(afterSettle.json().totals.settledRial, '40000000');
  } finally {
    await app.close();
    await pool.end();
  }
});
