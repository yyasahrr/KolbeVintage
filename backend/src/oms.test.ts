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

test('OMS §18-§34: payment gate, bulk transitions, shipment/tracking reconciliation, unified retail read model', { skip: !testDbUrl }, async () => {
  const app = await buildApp({ ...baseConfig, PORT: 4062 });
  const pool = createPool(baseConfig);
  const suffix = randomUUID().slice(0, 8);
  try {
    const { adminHeaders } = await createAdmin(app, pool, suffix);
    const wh = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders, payload: { code: `OMS2${suffix.toUpperCase().slice(-4)}`, name: 'انبار سفارشات' } });
    const warehouseId = wh.json().id as string;
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders, payload: {
      brand: 'Kolbe', name: `پیراهن سفارشات ${suffix}`, category: 'پیراهن', cashPriceRial: '2500000', variants: [{ size: 'L', color: 'آبی' }] } });
    const productId = product.json().id as string;
    const variantId = product.json().variants[0].id as string;
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: adminHeaders, payload: { status: 'published' } });
    await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...adminHeaders, 'idempotency-key': `oms2-st-${suffix}` },
      payload: { variantId, warehouseId, delta: 5, reason: 'موجودی اولیه آزمون', reference: `OMS2-${suffix}` } });

    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: `oms-buyer-${suffix}@kolbe.test`, password: 'BuyerPassword123456!', displayName: 'خریدار آزمون' } });
    const buyerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `oms-buyer-${suffix}@kolbe.test`, password: 'BuyerPassword123456!' } });
    const buyerHeaders = { authorization: `Bearer ${buyerLogin.json().accessToken as string}` };
    const checkout = (key: string) => app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': key }, payload: {
      orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
      shippingAddress: { recipient: 'خریدار آزمون', phone: '09123456789', province: 'تهران', city: 'تهران', line: 'خیابان آزمون، پلاک ۲', postalCode: '1234567890' } } });
    const order = await checkout(`oms2-o1-${suffix}`);
    assert.equal(order.statusCode, 201, order.body);
    const orderId = order.json().id as string;
    const orderRef = order.json().reference as string;

    // §26: payment gate is backend-enforced — unpaid orders cannot advance to fulfillment.
    const gate = await app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/transitions`, headers: adminHeaders, payload: { status: 'processing' } });
    assert.equal(gate.statusCode, 409, 'unpaid order cannot start preparation');
    // Manual «paid» (legitimate cash/offline path) requires documented evidence.
    const paidNoNote = await app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/transitions`, headers: adminHeaders, payload: { status: 'paid' } });
    assert.equal(paidNoNote.statusCode, 400, paidNoNote.body);
    assert.ok(/یادداشت/.test(paidNoNote.json().message ?? ''), 'offline paid needs a note');
    const paid = await app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/transitions`, headers: adminHeaders, payload: { status: 'paid', note: 'پرداخت نقدی حضوری دریافت شد' } });
    assert.equal(paid.statusCode, 200, paid.body);

    // §34: bulk transitions — per-item results; invalid ids fail alone, valid ones apply.
    const ghost = randomUUID();
    const bulk = await app.inject({ method: 'POST', url: '/api/v1/orders/bulk-transitions', headers: adminHeaders,
      payload: { orderIds: [orderId, ghost], status: 'processing', note: 'شروع آماده‌سازی گروهی' } });
    assert.equal(bulk.statusCode, 200, bulk.body);
    assert.equal(bulk.json().succeeded, 1);
    assert.equal(bulk.json().failed, 1);
    const bulkResults = bulk.json().results as { orderId: string; ok: boolean; error?: string }[];
    assert.equal(bulkResults.find((r) => r.orderId === orderId)?.ok, true);
    assert.ok(bulkResults.find((r) => r.orderId === ghost)?.error, 'ghost order carries a readable reason');
    const afterBulk = await app.inject({ method: 'GET', url: `/api/v1/orders/${orderId}`, headers: adminHeaders });
    assert.equal(afterBulk.json().status, 'processing', 'bulk transition persisted');
    const timeline = (afterBulk.json().events as { to_status: string; note: string | null }[]);
    assert.ok(timeline.some((e) => e.to_status === 'processing' && /گروهی/.test(e.note ?? '')), 'real order event recorded for bulk transition');

    // §28-§29: tracking registered through the EXISTING shipments domain shows up on the orders list.
    const shipment = await app.inject({ method: 'POST', url: '/api/v1/admin/shipments', headers: adminHeaders,
      payload: { orderId, carrier: 'پست پیشتاز', trackingCode: `TRK-${suffix}`, status: 'handed_over' } });
    assert.equal(shipment.statusCode, 201, shipment.body);
    const list = await app.inject({ method: 'GET', url: `/api/v1/orders?orderType=retail&withTotal=1&search=${encodeURIComponent(`TRK-${suffix}`)}`, headers: adminHeaders });
    assert.equal(list.statusCode, 200, list.body);
    const listItems = list.json().items as Record<string, unknown>[];
    assert.equal(listItems.length, 1, 'search by tracking code finds the order');
    assert.equal(listItems[0]!.reference, orderRef);
    assert.equal(listItems[0]!.tracking_code, `TRK-${suffix}`);
    assert.equal(listItems[0]!.shipment_carrier, 'پست پیشتاز');
    assert.equal(listItems[0]!.shipment_status, 'handed_over');
    assert.ok(Number(list.json().total) >= 1, 'withTotal returns real count');
    const noTracking = await app.inject({ method: 'GET', url: `/api/v1/orders?hasTracking=0&search=${encodeURIComponent(`TRK-${suffix}`)}`, headers: adminHeaders });
    assert.equal((noTracking.json().items as unknown[]).length, 0, 'hasTracking=0 excludes tracked orders');

    // §18: sellerScope mechanics — this order has no supplier lines → kolbe scope only.
    const kolbeScope = await app.inject({ method: 'GET', url: `/api/v1/orders?sellerScope=kolbe&search=${orderRef}`, headers: adminHeaders });
    assert.equal((kolbeScope.json().items as unknown[]).length, 1);
    const supplierScope = await app.inject({ method: 'GET', url: `/api/v1/orders?sellerScope=supplier&search=${orderRef}`, headers: adminHeaders });
    assert.equal((supplierScope.json().items as unknown[]).length, 0);

    // §41: «مشکل‌دار» from REAL data — a backdated unpaid order becomes payment_overdue.
    const order2 = await checkout(`oms2-o2-${suffix}`);
    const order2Id = order2.json().id as string;
    await pool.query(`UPDATE orders SET created_at = now() - interval '2 days' WHERE id = $1`, [order2Id]);
    const problems = await app.inject({ method: 'GET', url: `/api/v1/orders?problem=1&search=${order2.json().reference}`, headers: adminHeaders });
    const problemItems = problems.json().items as { id: string; exception_reasons: string[] }[];
    assert.equal(problemItems.length, 1);
    assert.ok(problemItems[0]!.exception_reasons.includes('payment_overdue'));

    // §22-§23: unified retail read model — website order + manual sale in ONE server-backed table.
    const before = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [variantId, warehouseId, 'retail']);
    const manualSale = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...adminHeaders, 'idempotency-key': `oms2-ms-${suffix}` },
      payload: { channel: 'instagram', warehouseId, customerName: 'مشتری اینستاگرام', customerPhone: '09351112233',
        lines: [{ variantId, quantity: 1, unitPriceRial: '2500000' }], payment: { method: 'cash', amountRial: '2500000' } } });
    assert.equal(manualSale.statusCode, 201, manualSale.body);
    const after = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [variantId, warehouseId, 'retail']);
    assert.equal(Number(before.rows[0].on_hand) - Number(after.rows[0].on_hand), 1, 'manual sale consumed MAIN retail inventory via a movement');

    const unified = await app.inject({ method: 'GET', url: '/api/v1/oms/retail-sales?limit=50', headers: adminHeaders });
    assert.equal(unified.statusCode, 200, unified.body);
    const unifiedItems = unified.json().items as Record<string, unknown>[];
    const siteRow = unifiedItems.find((row) => row.reference === orderRef);
    const manualRow = unifiedItems.find((row) => row.kind === 'manual_sale' && row.reference === manualSale.json().reference);
    assert.ok(siteRow, 'website order present in the unified retail table');
    assert.ok(manualRow, 'manual sale present in the unified retail table');
    assert.equal(siteRow!.channel, 'website');
    assert.equal(siteRow!.tracking_code, `TRK-${suffix}`);
    assert.equal(manualRow!.channel, 'instagram');
    assert.equal(manualRow!.payment_method, 'cash');
    assert.equal(manualRow!.payment_status, 'succeeded');
    const channelFiltered = await app.inject({ method: 'GET', url: '/api/v1/oms/retail-sales?channel=instagram&search=09351112233', headers: adminHeaders });
    const channelItems = channelFiltered.json().items as Record<string, unknown>[];
    assert.equal(channelItems.length, 1);
    assert.equal(channelItems[0]!.kind, 'manual_sale');

    // RBAC: the unified read model is admin-only.
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/oms/retail-sales', headers: buyerHeaders });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await app.close();
    await pool.end();
  }
});
