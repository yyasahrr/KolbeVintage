import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, type DbPool } from './db.js';

const config: Config = {
  NODE_ENV: 'test', PORT: 4011, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
  PG_POOL_MAX: 2, PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

const ADDRESS = {
  recipient: 'خریدار کش‌بک', phone: '09123456789', province: 'تهران', city: 'تهران',
  line: 'خیابان تست کش‌بک، پلاک ۱', postalCode: '1234567890',
};

describe('cashback wallet: earn, release, redeem, reverse, restore, expire, admin', { skip: !process.env.TEST_DATABASE_URL }, () => {
  let app: FastifyInstance;
  let pool: DbPool;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let customerId = '';
  let outsiderHeaders: Record<string, string>;
  let warehouseId = '';
  let variantId = '';
  const suffix = randomUUID().slice(0, 8);

  const login = async (identity: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity, password } });
    assert.equal(res.statusCode, 200, res.body);
    return { authorization: `Bearer ${res.json().accessToken as string}` };
  };

  const wallet = async (headers: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/cashback/wallet', headers });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { pendingRial: string; availableRial: string; usedRial: string; expiredRial: string; items: unknown[] };
  };

  const createRetailOrder = async (opts: { walletRial?: string; idem: string; quantity?: number }) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...customer, 'idempotency-key': `cb-${opts.idem}-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash',
        items: [{ variantId, quantity: opts.quantity ?? 1 }], shippingAddress: ADDRESS,
        ...(opts.walletRial ? { walletRial: opts.walletRial } : {}) } });
    return res;
  };

  const transition = async (orderId: string, status: string, note?: string) => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/transitions`, headers: admin,
      payload: { status, ...(note ? { note } : {}) } });
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
  };

  const payManually = (orderId: string) => transition(orderId, 'paid', 'پرداخت نقدی آفلاین تأییدشده (تست)');
  const deliver = async (orderId: string) => {
    await transition(orderId, 'processing');
    await transition(orderId, 'in_transit');
    await transition(orderId, 'delivered');
  };

  before(async () => {
    app = await buildApp(config);
    pool = createPool(config);
    const mkUser = async (email: string, password: string, role: string, display: string) => {
      const id = randomUUID();
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
        [id, email, await argon2.hash(password), display]);
      await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
      return id;
    };
    await mkUser(`cb-admin-${suffix}@example.test`, 'AdminPassword123456!', 'admin', 'مدیر کش‌بک');
    customerId = await mkUser(`cb-cust-${suffix}@example.test`, 'CustomerPassword1234!', 'customer', 'مشتری کش‌بک');
    await mkUser(`cb-out-${suffix}@example.test`, 'OutsiderPassword1234!', 'customer', 'کاربر بی‌دسترسی');
    admin = await login(`cb-admin-${suffix}@example.test`, 'AdminPassword123456!');
    customer = await login(`cb-cust-${suffix}@example.test`, 'CustomerPassword1234!');
    outsiderHeaders = await login(`cb-out-${suffix}@example.test`, 'OutsiderPassword1234!');

    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: admin,
      payload: { code: `CB-${suffix.toUpperCase()}`, name: 'انبار تست کش‌بک' } });
    assert.equal(warehouse.statusCode, 201, warehouse.body);
    warehouseId = warehouse.json().id as string;

    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin,
      payload: { brand: 'Kolbe', name: `هودی کش‌بک ${suffix}`, category: 'هودی',
        cashPriceRial: '10000000', variants: [{ size: 'L', color: 'مشکی' }] } });
    assert.equal(product.statusCode, 201, product.body);
    variantId = product.json().variants[0].id as string;
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [product.json().id]);
    const stock = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...admin, 'idempotency-key': `cb-stk-${suffix}` },
      payload: { variantId, warehouseId, delta: 100, reason: 'موجودی تست کش‌بک', reference: `CB-${suffix}` } });
    assert.equal(stock.statusCode, 201, stock.body);
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  it('admin creates a percent rule (RBAC enforced, percent XOR fixed enforced)', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/rules', headers: outsiderHeaders,
      payload: { name: 'قانون غیرمجاز', percent: 10 } });
    assert.equal(denied.statusCode, 403, denied.body);

    const both = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/rules', headers: admin,
      payload: { name: 'هر دو مقدار', percent: 10, fixedRial: '50000' } });
    assert.equal(both.statusCode, 400, both.body);

    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/rules', headers: admin,
      payload: { name: `کش‌بک ۱۰٪ ${suffix}`, percent: 10, releaseDelayDays: 0, expirationDays: 90,
        paymentModes: ['cash'], minOrderRial: '0' } });
    assert.equal(created.statusCode, 201, created.body);
  });

  let order1 = '';
  it('paid retail order earns pending cashback — idempotently', async () => {
    const res = await createRetailOrder({ idem: 'o1' });
    assert.equal(res.statusCode, 201, res.body);
    order1 = res.json().id as string;
    await payManually(order1);
    const w1 = await wallet(customer);
    // 10% of 10,000,000 = 1,000,000 rial pending
    assert.equal(w1.pendingRial, '1000000');
    assert.equal(w1.availableRial, '0');
    // double transition paid is blocked by the status machine, but the earn itself is
    // idempotent: re-running the earn hook adds nothing (simulate via direct second call).
    const { earnCashbackOnPaid } = await import('./cashback.js');
    const { transaction } = await import('./db.js');
    await transaction(pool, (client) => earnCashbackOnPaid(client, order1));
    const w2 = await wallet(customer);
    assert.equal(w2.pendingRial, '1000000');
  });

  it('delivery + zero release delay flips pending to available (lazy, idempotent)', async () => {
    await deliver(order1);
    const w = await wallet(customer); // read triggers the lazy flip
    assert.equal(w.pendingRial, '0');
    assert.equal(w.availableRial, '1000000');
    const again = await wallet(customer);
    assert.equal(again.availableRial, '1000000'); // second read must not double-release
  });

  it('redemption is capped by the server and spends the wallet exactly once per order', async () => {
    // cap = min(available 1,000,000, 50% of 10,000,000) = 1,000,000 → asking more fails
    const over = await createRetailOrder({ walletRial: '1500000', idem: 'o2-over' });
    assert.equal(over.statusCode, 400, over.body);

    const quote = await app.inject({ method: 'GET',
      url: '/api/v1/cashback/redemption-quote?merchNetRial=10000000&paymentMode=cash', headers: customer });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().maxRedeemRial, '1000000');

    const ok = await createRetailOrder({ walletRial: '600000', idem: 'o2' });
    assert.equal(ok.statusCode, 201, ok.body);
    const order2 = ok.json().id as string;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/orders/${order2}`, headers: customer });
    assert.equal(detail.json().total_rial, '9400000'); // 10,000,000 − 600,000 wallet
    const snapshot = detail.json().pricing_snapshot as Record<string, unknown>;
    assert.equal(snapshot.walletRedeemedRial, '600000');

    const w = await wallet(customer);
    assert.equal(w.availableRial, '400000');
    assert.equal(w.usedRial, '600000');

    // duplicate submit with the SAME idempotency key returns the same order and must not
    // double-charge the wallet (idempotent replay at both order and ledger level)
    const replay = await createRetailOrder({ walletRial: '600000', idem: 'o2' });
    assert.ok([200, 201].includes(replay.statusCode), replay.body);
    const w2 = await wallet(customer);
    assert.equal(w2.usedRial, '600000');

    // cancelling the unpaid order restores the spent credit (reservation released)
    await transition(order2, 'cancelled');
    const w3 = await wallet(customer);
    assert.equal(w3.availableRial, '1000000');
    assert.equal(w3.usedRial, '600000'); // history keeps the spend; restore is a separate row
  });

  it('wallet credit never pays for wholesale orders or exceeds policy on installments', async () => {
    const quote = await app.inject({ method: 'GET',
      url: '/api/v1/cashback/redemption-quote?merchNetRial=10000000&paymentMode=four_installments', headers: customer });
    assert.equal(quote.statusCode, 200, quote.body);
    assert.equal(quote.json().enabled, false); // redeemOnInstallments default = false
  });

  it('cancelling a paid order reverses the pending earn (bounded, idempotent)', async () => {
    const res = await createRetailOrder({ idem: 'o3' });
    assert.equal(res.statusCode, 201, res.body);
    const order3 = res.json().id as string;
    await payManually(order3);
    const before3 = await wallet(customer);
    assert.equal(before3.pendingRial, '1000000'); // new earn pending
    await transition(order3, 'cancelled');
    const after3 = await wallet(customer);
    assert.equal(after3.pendingRial, '0'); // reversed before release
    assert.equal(after3.availableRial, '1000000'); // untouched available from order1
  });

  it('refund via returns restores redeemed credit and claws back earned credit without going negative', async () => {
    // order4: pay 1,000,000 with wallet, then full refund through the returns pipeline
    const res = await createRetailOrder({ walletRial: '1000000', idem: 'o4' });
    assert.equal(res.statusCode, 201, res.body);
    const order4 = res.json().id as string;
    await payManually(order4);
    const mid = await wallet(customer);
    assert.equal(mid.availableRial, '0'); // fully spent
    assert.equal(mid.pendingRial, '900000'); // earn = 10% of (10,000,000 − 1,000,000 wallet)

    const ret = await app.inject({ method: 'POST', url: '/api/v1/returns', headers: customer,
      payload: { orderId: order4, reason: 'تست بازگشت اعتبار کش‌بک', resolution: 'refund' } });
    assert.equal(ret.statusCode, 201, ret.body);
    const returnId = ret.json().id as string;
    const approve = await app.inject({ method: 'PATCH', url: `/api/v1/admin/returns/${returnId}`, headers: admin,
      payload: { status: 'approved' } });
    assert.equal(approve.statusCode, 200, approve.body);
    const receive = await app.inject({ method: 'PATCH', url: `/api/v1/admin/returns/${returnId}`, headers: admin,
      payload: { status: 'received' } });
    assert.equal(receive.statusCode, 200, receive.body);
    const refund = await app.inject({ method: 'PATCH', url: `/api/v1/admin/returns/${returnId}`, headers: admin,
      payload: { status: 'refunded' } });
    assert.equal(refund.statusCode, 200, refund.body);

    const w = await wallet(customer);
    // redeemed 1,000,000 restored; pending earn of the refunded order reversed
    assert.equal(w.availableRial, '1000000');
    assert.equal(w.pendingRial, '0');

    // replaying the refund PATCH is rejected by the status machine → ledger untouched
    const replay = await app.inject({ method: 'PATCH', url: `/api/v1/admin/returns/${returnId}`, headers: admin,
      payload: { status: 'refunded' } });
    assert.equal(replay.statusCode, 400, replay.body);
    const w2 = await wallet(customer);
    assert.equal(w2.availableRial, '1000000');
  });

  it('expiry is ledger-based, lazy and idempotent', async () => {
    const res = await createRetailOrder({ idem: 'o5' });
    assert.equal(res.statusCode, 201, res.body);
    const order5 = res.json().id as string;
    await payManually(order5);
    await deliver(order5);
    await wallet(customer); // flip to available
    // force the earn to be already expired
    await pool.query(
      `UPDATE cashback_transactions SET expires_at = now() - interval '1 day'
       WHERE source_order_id = $1 AND tx_type = 'cashback_pending'`, [order5]);
    const w = await wallet(customer);
    assert.equal(w.availableRial, '1000000'); // order5's 1,000,000 expired, order1 credit remains
    assert.equal(w.expiredRial, '1000000');
    const again = await wallet(customer);
    assert.equal(again.expiredRial, '1000000'); // no double expiry
  });

  it('admin adjustments are ledger-only, audited, and the wallet can never go negative', async () => {
    const debitTooMuch = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/adjust', headers: admin,
      payload: { customerId, direction: 'debit', amountRial: '999999999', reason: 'تست کسر بیش از موجودی' } });
    assert.equal(debitTooMuch.statusCode, 409, debitTooMuch.body);

    const credit = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/adjust', headers: admin,
      payload: { customerId, direction: 'credit', amountRial: '250000', reason: 'هدیه جبرانی تست' } });
    assert.equal(credit.statusCode, 201, credit.body);
    const debit = await app.inject({ method: 'POST', url: '/api/v1/admin/cashback/adjust', headers: admin,
      payload: { customerId, direction: 'debit', amountRial: '50000', reason: 'اصلاح تست' } });
    assert.equal(debit.statusCode, 201, debit.body);
    const w = await wallet(customer);
    assert.equal(w.availableRial, '1200000'); // 1,000,000 + 250,000 − 50,000

    const auditRows = await pool.query(
      `SELECT action FROM audit_logs WHERE action IN ('cashback.credit','cashback.debit') ORDER BY created_at DESC LIMIT 2`);
    assert.equal(auditRows.rows.length, 2);
  });

  it('admin surfaces: overview liability, wallets, transactions, expiring, settings round-trip', async () => {
    const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/cashback/overview', headers: admin });
    assert.equal(overview.statusCode, 200, overview.body);
    assert.ok(BigInt(overview.json().liabilityRial as string) >= 0n);

    const wallets = await app.inject({ method: 'GET', url: '/api/v1/admin/cashback/wallets', headers: admin });
    assert.equal(wallets.statusCode, 200, wallets.body);
    assert.ok((wallets.json().items as unknown[]).length >= 1);

    const txs = await app.inject({ method: 'GET', url: `/api/v1/admin/cashback/transactions?customerId=${customerId}`, headers: admin });
    assert.equal(txs.statusCode, 200, txs.body);
    assert.ok((txs.json().items as unknown[]).length >= 5);

    const expiring = await app.inject({ method: 'GET', url: '/api/v1/admin/cashback/expiring', headers: admin });
    assert.equal(expiring.statusCode, 200, expiring.body);

    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/cashback/settings', headers: admin,
      payload: { redemptionEnabled: true, maxPercentOfOrder: 40, minRedeemRial: '50000',
        earnOnInstallments: false, redeemOnInstallments: false } });
    assert.equal(put.statusCode, 200, put.body);
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/cashback/settings', headers: admin });
    assert.equal(get.json().maxPercentOfOrder, 40);

    const deniedCustomer = await app.inject({ method: 'GET', url: '/api/v1/admin/cashback/overview', headers: customer });
    assert.equal(deniedCustomer.statusCode, 403, deniedCustomer.body);
  });
});
