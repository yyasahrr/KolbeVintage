import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { createPool } from './db.js';

/**
 * WMS/OMS operations phase:
 * - §5  inventory KPI summary (server-computed)
 * - §6  server-backed inventory filters + pagination
 * - §10-14 bulk inventory operations with per-item results
 * - §18-35 orders operations (3-tab read model, payment gate, bulk transitions)
 * - §28-29 shipment/tracking reconciliation with the existing shipments domain
 */

const testDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const baseConfig: Config = {
  NODE_ENV: 'test', PORT: 4061, DATABASE_URL: testDbUrl ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type App = Awaited<ReturnType<typeof buildApp>>;
type Pool = ReturnType<typeof createPool>;

async function createAdmin(app: App, pool: Pool, suffix: string) {
  const adminId = randomUUID();
  const passwordHash = await argon2.hash('StrongPass123456!');
  await pool.query(`INSERT INTO users(id, email, password_hash, display_name) VALUES ($1, $2, $3, 'مدیر عملیات')`,
    [adminId, `oms-admin-${suffix}@kolbe.test`, passwordHash]);
  await pool.query(`INSERT INTO user_roles(user_id, role_code) VALUES ($1, 'admin')`, [adminId]);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `oms-admin-${suffix}@kolbe.test`, password: 'StrongPass123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { adminId, adminHeaders: { authorization: `Bearer ${res.json().accessToken as string}` } };
}

test('WMS §5/§6/§10-14: inventory summary, server filters/pagination, bulk ops with per-item results', { skip: !testDbUrl }, async () => {
  const app = await buildApp(baseConfig);
  const pool = createPool(baseConfig);
  const suffix = Date.now().toString(36);
  try {
    const { adminHeaders } = await createAdmin(app, pool, suffix);
    const wh = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders, payload: { code: `OMS${suffix.toUpperCase().slice(-5)}`, name: 'انبار عملیات' } });
    assert.equal(wh.statusCode, 201, wh.body);
    const warehouseId = wh.json().id as string;

    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `کتانی عملیات ${suffix}`, category: 'کفش', cashPriceRial: '2500000',
      variants: [{ size: '41', color: 'مشکی' }, { size: '42', color: 'سفید' }] } });
    assert.equal(product.statusCode, 201, product.body);
    const [v1, v2] = product.json().variants as { id: string; sku: string }[];

    // Stock in: receipt + receive for v1 only.
    const receipt = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts', headers: { ...adminHeaders, 'idempotency-key': `oms-r1-${suffix}` },
      payload: { variantId: v1!.id, warehouseId, inventoryDomain: 'retail', quantity: 8 } });
    assert.equal(receipt.statusCode, 201, receipt.body);
    const received = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receipt.json().id}/receive`, headers: adminHeaders, payload: { receivedQuantity: 8 } });
    assert.equal(received.statusCode, 200, received.body);

    // §5: KPI summary is server-computed for the domain.
    const summary = await app.inject({ method: 'GET', url: `/api/v1/inventory/summary?inventoryDomain=retail&warehouseId=${warehouseId}`, headers: adminHeaders });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().on_hand, 8);
    assert.equal(summary.json().available, 8);

    // §6: server-backed filters — stock status + color + pagination metadata.
    const filtered = await app.inject({ method: 'GET', url: `/api/v1/inventory?inventoryDomain=retail&warehouseId=${warehouseId}&stockStatus=in_stock&colorLabel=${encodeURIComponent('مشکی')}&limit=1&offset=0&withTotal=1`, headers: adminHeaders });
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.equal(filtered.json().items.length, 1);
    assert.equal(filtered.json().items[0].sku, v1!.sku);
    assert.equal(filtered.json().total, 1, 'withTotal returns the full filtered count for pagination');
    const oos = await app.inject({ method: 'GET', url: `/api/v1/inventory?inventoryDomain=retail&warehouseId=${warehouseId}&stockStatus=out_of_stock&withTotal=1`, headers: adminHeaders });
    assert.equal(oos.statusCode, 200, oos.body);
    assert.ok((oos.json().items as { sku: string }[]).every((row) => row.sku !== v1!.sku), 'in-stock variant is not out_of_stock');

    // §11: bulk sale-status returns per-item results — product without retail price fails with a reason.
    const noPrice = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `بدون قیمت ${suffix}`, category: 'کفش', cashPriceRial: '0', wholesalePriceRial: '900000',
      retailEnabled: false, wholesaleEnabled: true, variants: [{ size: '40', color: 'زرد' }] } });
    assert.equal(noPrice.statusCode, 201, noPrice.body);
    const bulkSale = await app.inject({ method: 'POST', url: '/api/v1/products/bulk/sale-status', headers: adminHeaders,
      payload: { productIds: [product.json().id, noPrice.json().id], enabled: true } });
    assert.equal(bulkSale.statusCode, 200, bulkSale.body);
    const saleResults = bulkSale.json().results as { productId: string; ok: boolean; error?: string }[];
    assert.equal(bulkSale.json().succeeded, 1);
    assert.equal(bulkSale.json().failed, 1);
    assert.ok(saleResults.find((r) => r.productId === noPrice.json().id && !r.ok && /قیمت خرده/.test(r.error ?? '')), 'no-retail-price failure carries a readable reason');

    // §13: bulk adjustments in partial mode — per-line results, one transaction, ledger per movement.
    const bulkAdjust = await app.inject({ method: 'POST', url: '/api/v1/inventory/bulk-adjustments', headers: { ...adminHeaders, 'idempotency-key': `oms-ba-${suffix}` },
      payload: { partial: true, reason: 'شمارش انبارگردانی دوره‌ای', reference: `CYCLE-${suffix}`,
        lines: [
          { variantId: v1!.id, warehouseId, inventoryDomain: 'retail', delta: 2 },
          { variantId: v2!.id, warehouseId, inventoryDomain: 'retail', delta: -5 },
        ] } });
    assert.equal(bulkAdjust.statusCode, 201, bulkAdjust.body);
    const adjustResults = bulkAdjust.json().results as { ok: boolean; error?: string }[];
    assert.equal(adjustResults[0]!.ok, true, 'valid line applied');
    assert.equal(adjustResults[1]!.ok, false, 'negative-available line rejected per-item, not whole batch');
    assert.ok(/منفی/.test(adjustResults[1]!.error ?? ''));
    const afterAdjust = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [v1!.id, warehouseId, 'retail']);
    assert.equal(Number(afterAdjust.rows[0].on_hand), 10, 'successful line persisted through the ledger');
    const movement = await pool.query(`SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1 AND reason = 'شمارش انبارگردانی دوره‌ای'`, [v1!.id]);
    assert.equal(movement.rows[0].n, 1, 'every applied line leaves exactly one movement');

    // Existing all-or-nothing behavior unchanged without partial flag.
    const strict = await app.inject({ method: 'POST', url: '/api/v1/inventory/bulk-adjustments', headers: { ...adminHeaders, 'idempotency-key': `oms-bs-${suffix}` },
      payload: { reason: 'اصلاح سخت‌گیرانه', reference: `STRICT-${suffix}`,
        lines: [{ variantId: v1!.id, warehouseId, inventoryDomain: 'retail', delta: 1 }, { variantId: v2!.id, warehouseId, inventoryDomain: 'retail', delta: -9 }] } });
    assert.equal(strict.statusCode, 409, 'strict mode still fails the whole batch');
    const unchanged = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [v1!.id, warehouseId, 'retail']);
    assert.equal(Number(unchanged.rows[0].on_hand), 10, 'strict failure rolls back everything');

    // §14: bulk transfers — per-line eligibility with blocked reasons, rules enforced server-side.
    const wh2 = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders, payload: { code: `OMB${suffix.toUpperCase().slice(-5)}`, name: 'انبار مقصد' } });
    const destWarehouseId = wh2.json().id as string;
    const bulkTransfer = await app.inject({ method: 'POST', url: '/api/v1/inventory/bulk-transfers', headers: { ...adminHeaders, 'idempotency-key': `oms-bt-${suffix}` },
      payload: { reason: 'بالانس موجودی بین انبارها', sourceDomain: 'retail', destinationDomain: 'retail',
        sourceWarehouseId: warehouseId, destinationWarehouseId: destWarehouseId,
        lines: [
          { variantId: v1!.id, quantity: 3 },
          { variantId: v2!.id, quantity: 4 },
        ] } });
    assert.equal(bulkTransfer.statusCode, 201, bulkTransfer.body);
    const transferResults = bulkTransfer.json().results as { ok: boolean; error?: string; reference?: string }[];
    assert.equal(transferResults[0]!.ok, true, 'eligible line creates a real transfer document');
    assert.ok(transferResults[0]!.reference?.startsWith('TRF-'), 'transfer uses the official transfer domain');
    assert.equal(transferResults[1]!.ok, false, 'insufficient stock line blocked with a reason');
    assert.ok(/موجودی/.test(transferResults[1]!.error ?? ''));
  } finally {
    await app.close();
    await pool.end();
  }
});
