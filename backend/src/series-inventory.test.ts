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
  NODE_ENV: 'test', PORT: 4019, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

async function makeAdmin(app: Awaited<ReturnType<typeof buildApp>>, pool: ReturnType<typeof createPool>, suffix: string) {
  const adminId = randomUUID();
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [adminId, `series-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Series admin']);
  await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `series-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
  assert.equal(login.statusCode, 200, login.body);
  return { adminId, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
}

/** Product with 2 variants + a series template (2+1 pieces per series) + a wholesale warehouse. */
async function makeSeriesWorld(app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>, suffix: string) {
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
    payload: { brand: 'Kolbe', name: `سری تست ${suffix}`, category: 'کت', cashPriceRial: '9000000',
      wholesalePriceRial: '4000000', wholesaleEnabled: true,
      variants: [{ size: 'M', color: 'مشکی' }, { size: 'L', color: 'مشکی' }] } });
  assert.equal(product.statusCode, 201, product.body);
  const productId = product.json().id as string;
  const variants = product.json().variants as Array<{ id: string; sku: string }>;
  const template = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
    payload: { productId, name: `سری مشکی ${suffix}`, items: [
      { variantId: variants[0]!.id, quantityPerSeries: 2 },
      { variantId: variants[1]!.id, quantityPerSeries: 1 },
    ] } });
  assert.equal(template.statusCode, 201, template.body);
  const wh = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers,
    payload: { code: `CW-${suffix.toUpperCase()}`, name: `انبار مرکزی عمده ${suffix}` } });
  assert.equal(wh.statusCode, 201, wh.body);
  return { productId, variants, templateId: template.json().id as string, warehouseId: wh.json().id as string };
}

test('warehouse purpose: column exists, PATCH works and purpose guards reject invalid changes', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const wh = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers, payload: { code: `PUR-${suffix.toUpperCase()}`, name: 'Purpose WH' } });
    const whId = wh.json().id as string;
    // default purpose exposed in list
    const list = await app.inject({ method: 'GET', url: '/api/v1/warehouses', headers });
    const row = (list.json().items as Array<{ id: string; purpose: string }>).find((w) => w.id === whId);
    assert.equal(row?.purpose, 'mixed');
    // set to wholesale
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${whId}/purpose`, headers, payload: { purpose: 'wholesale' } });
    assert.equal(patch.statusCode, 200, patch.body);
    // add retail stock to another warehouse and verify guard: retail stock blocks switching to wholesale
    const whR = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers, payload: { code: `PURR-${suffix.toUpperCase()}`, name: 'Purpose retail WH' } });
    const whRId = whR.json().id as string;
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { brand: 'Kolbe', name: `purpose ${suffix}`, category: 'کت', cashPriceRial: '9000000', variants: [{ size: 'M', color: 'مشکی' }] } });
    const variantId = (product.json().variants as Array<{ id: string }>)[0]!.id;
    const adj = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...headers, 'idempotency-key': `pur-${suffix}` },
      payload: { variantId, warehouseId: whRId, delta: 5, inventoryDomain: 'retail', reason: 'initial stock', reference: `pur-${suffix}` } });
    assert.equal(adj.statusCode, 201, adj.body);
    const bad = await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${whRId}/purpose`, headers, payload: { purpose: 'wholesale' } });
    assert.equal(bad.statusCode, 409, bad.body);
    const ok = await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${whRId}/purpose`, headers, payload: { purpose: 'retail' } });
    assert.equal(ok.statusCode, 200, ok.body);
    await app.close();
  } finally { await pool.end(); }
});

test('series stocktake: overlay guard forbids fabricating series; valid counts become explicit stock', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix);
    await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${world.warehouseId}/purpose`, headers, payload: { purpose: 'wholesale' } });

    // No component stock yet → counting 2 series must FAIL (no fabricated series, §53)
    const fabricated = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: world.warehouseId, countedSeries: 2 } });
    assert.equal(fabricated.statusCode, 400, fabricated.body);

    // Put component pieces in wholesale: variant0=4 (2/series), variant1=2 (1/series) → covers exactly 2 series
    for (const [i, qty] of [[0, 4], [1, 2]] as const) {
      const adj = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...headers, 'idempotency-key': `st-${suffix}-${i}` },
        payload: { variantId: world.variants[i]!.id, warehouseId: world.warehouseId, delta: qty, inventoryDomain: 'wholesale', reason: 'initial stock', reference: `st-${suffix}-${i}` } });
      assert.equal(adj.statusCode, 201, adj.body);
    }
    // 3 series still impossible
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: world.warehouseId, countedSeries: 3 } });
    assert.equal(tooMany.statusCode, 400, tooMany.body);
    // 2 series OK, idempotency key respected
    const key = `stocktake-${suffix}`;
    const count = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: world.warehouseId, countedSeries: 2, idempotencyKey: key } });
    assert.equal(count.statusCode, 201, count.body);
    assert.equal(count.json().onHand, 2);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: world.warehouseId, countedSeries: 2, idempotencyKey: key } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().duplicate, true);

    // list shows the explicit (tracked) series row with sellable count and retail_supply_allowed
    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory/series?warehouseId=${world.warehouseId}&withItems=1`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const rows = list.json().items as Array<{ series_template_id: string; tracked: boolean; on_hand: number; sellable: number; owner_type: string; retail_supply_allowed: boolean; color_label: string | null; items: unknown[] }>;
    const mine = rows.find((r) => r.series_template_id === world.templateId);
    assert.ok(mine, list.body);
    assert.equal(mine!.tracked, true);
    assert.equal(mine!.on_hand, 2);
    assert.equal(mine!.sellable, 2);
    assert.equal(mine!.owner_type, 'kolbe');
    assert.equal(mine!.retail_supply_allowed, true);
    assert.equal(mine!.color_label, 'مشکی'); // single-color recipe → color derived
    assert.ok(mine!.items.length === 2);

    // movements ledger has the stocktake entry with a recipe snapshot reference
    const moves = await app.inject({ method: 'GET', url: `/api/v1/inventory/series/movements?seriesTemplateId=${world.templateId}`, headers });
    const moveRows = moves.json().items as Array<{ movement_type: string; quantity: number }>;
    assert.equal(moveRows[0]?.movement_type, 'stocktake');
    assert.equal(moveRows[0]?.quantity, 2);

    // stocktake into a retail-purpose warehouse must be rejected (§40)
    const whR = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers, payload: { code: `RS-${suffix.toUpperCase()}`, name: 'Retail WH' } });
    const whRId = whR.json().id as string;
    await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${whRId}/purpose`, headers, payload: { purpose: 'retail' } });
    const wrongPurpose = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: whRId, countedSeries: 1 } });
    assert.equal(wrongPurpose.statusCode, 400, wrongPurpose.body);
    await app.close();
  } finally { await pool.end(); }
});

test('series reconciliation: untracked templates reported with derived estimate, never converted', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix);
    // component stock exists (1 series derivable) but NO explicit count
    for (const [i, qty] of [[0, 2], [1, 1]] as const) {
      await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...headers, 'idempotency-key': `rec-${suffix}-${i}` },
        payload: { variantId: world.variants[i]!.id, warehouseId: world.warehouseId, delta: qty, inventoryDomain: 'wholesale', reason: 'initial stock', reference: `rec-${suffix}-${i}` } });
    }
    const report = await app.inject({ method: 'GET', url: '/api/v1/inventory/series/reconciliation', headers });
    assert.equal(report.statusCode, 200, report.body);
    const untracked = report.json().untracked_templates as Array<{ id: string; derived_available_series: number }>;
    const mine = untracked.find((t) => t.id === world.templateId);
    assert.ok(mine, 'template must appear as untracked');
    assert.equal(mine!.derived_available_series, 1);
    // and the list endpoint shows it as tracked=false with legacy estimate (no explicit on_hand)
    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory/series?search=${encodeURIComponent(`سری تست ${suffix}`)}`, headers });
    const rows = list.json().items as Array<{ series_template_id: string; tracked: boolean; on_hand: number; legacy_available: number }>;
    const row = rows.find((r) => r.series_template_id === world.templateId);
    assert.equal(row?.tracked, false);
    assert.equal(row?.on_hand, 0);
    assert.equal(row?.legacy_available, 1);
    await app.close();
  } finally { await pool.end(); }
});

test('wholesale order reserves INTACT tracked series; cancel releases; series-level oversell blocked', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix);
    await app.inject({ method: 'PATCH', url: `/api/v1/warehouses/${world.warehouseId}/purpose`, headers, payload: { purpose: 'wholesale' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${world.productId}/status`, headers, payload: { status: 'published' } });

    // Component pieces cover 2 series (v0=4 @2/series, v1=2 @1/series) …
    for (const [i, qty] of [[0, 4], [1, 2]] as const) {
      await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...headers, 'idempotency-key': `ord-${suffix}-${i}` },
        payload: { variantId: world.variants[i]!.id, warehouseId: world.warehouseId, delta: qty, inventoryDomain: 'wholesale', reason: 'initial stock', reference: `ord-${suffix}-${i}` } });
    }
    // … but only ONE physically intact series was counted (the rest are loose pieces).
    const count = await app.inject({ method: 'POST', url: '/api/v1/inventory/series/stocktake', headers,
      payload: { seriesTemplateId: world.templateId, warehouseId: world.warehouseId, countedSeries: 1 } });
    assert.equal(count.statusCode, 201, count.body);

    // VIP buyer with active membership.
    const vipId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [vipId, `series-vip-${suffix}@kolbe.test`, await argon2.hash('StrongPass123456!'), 'خریدار سری']);
    await pool.query("INSERT INTO user_roles(user_id, role_code) VALUES ($1,'customer')", [vipId]);
    const vipLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `series-vip-${suffix}@kolbe.test`, password: 'StrongPass123456!' } });
    const vipHeaders = { authorization: `Bearer ${vipLogin.json().accessToken as string}` };
    const plan = await app.inject({ method: 'POST', url: '/api/v1/plans', headers, payload: {
      code: `sinv-${suffix}`, title: 'پلن سری', annualPriceRial: '10000000',
      limits: { sources: 'all', maxOrdersPerMonth: 50, maxOrderValueRial: '50000000000', maxSuppliersPerOrder: 10, discountPercent: 0, prioritySupport: false },
    } });
    assert.equal(plan.statusCode, 201, plan.body);
    const membership = await app.inject({ method: 'POST', url: '/api/v1/memberships',
      headers: { ...vipHeaders, 'idempotency-key': `sinv-mem-${suffix}` }, payload: { planId: plan.json().id } });
    assert.equal(membership.statusCode, 201, membership.body);
    await applyVerifiedPayment(pool, {
      provider: 'verified-test-adapter', providerEventId: `sinv-evt-${suffix}`, providerReference: `sinv-ref-${suffix}`,
      intentId: membership.json().paymentIntentId, amountRial: '10000000', paidAt: new Date(),
    });

    // 2 series: components WOULD allow it, but explicit intact-series stock says only 1 → 409 (§36/§46).
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...vipHeaders, 'idempotency-key': `sinv-fail-${suffix}` },
      payload: { orderType: 'wholesale', series: [{ seriesTemplateId: world.templateId, count: 2 }] } });
    assert.equal(tooMany.statusCode, 409, tooMany.body);

    // 1 series succeeds: explicit series reserved AND component pieces reserved.
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...vipHeaders, 'idempotency-key': `sinv-ok-${suffix}` },
      payload: { orderType: 'wholesale', series: [{ seriesTemplateId: world.templateId, count: 1 }] } });
    assert.equal(order.statusCode, 201, order.body);
    const orderId = order.json().id as string;

    const afterReserve = await app.inject({ method: 'GET', url: `/api/v1/inventory/series?warehouseId=${world.warehouseId}`, headers });
    const reservedRow = (afterReserve.json().items as Array<{ series_template_id: string; on_hand: number; reserved: number; sellable: number }>)
      .find((r) => r.series_template_id === world.templateId);
    assert.equal(reservedRow?.on_hand, 1);
    assert.equal(reservedRow?.reserved, 1);
    assert.equal(reservedRow?.sellable, 0);
    // series snapshot persisted on the order itself (§37)
    const snap = await pool.query('SELECT series_snapshot FROM orders WHERE id = $1', [orderId]);
    assert.ok(snap.rows[0]?.series_snapshot, 'orders.series_snapshot written');

    // cancel → series reservation released, movement ledger shows reserve + release.
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/transitions`, headers,
      payload: { status: 'cancelled', reason: 'انصراف مشتری در تست' } });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const afterCancel = await app.inject({ method: 'GET', url: `/api/v1/inventory/series?warehouseId=${world.warehouseId}`, headers });
    const releasedRow = (afterCancel.json().items as Array<{ series_template_id: string; reserved: number; sellable: number }>)
      .find((r) => (r as { series_template_id: string }).series_template_id === world.templateId);
    assert.equal(releasedRow?.reserved, 0);
    assert.equal(releasedRow?.sellable, 1);
    const moves = await app.inject({ method: 'GET', url: `/api/v1/inventory/series/movements?seriesTemplateId=${world.templateId}&referenceType=order`, headers });
    const types = (moves.json().items as Array<{ movement_type: string }>).map((m) => m.movement_type);
    assert.ok(types.includes('reserve') && types.includes('release'), `ledger has reserve+release: ${types.join(',')}`);
    const reservationRow = await pool.query("SELECT status FROM order_series_reservations WHERE order_id = $1", [orderId]);
    assert.equal(reservationRow.rows[0]?.status, 'released');
    await app.close();
  } finally { await pool.end(); }
});
