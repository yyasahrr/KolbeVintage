/**
 * PROMPT 3 — WHOLESALE PRODUCTS / OWNERSHIP / WMS.
 *
 * The numbered acceptance matrix P3-WMS-001..020 from the Prompt-3 brief, written as an
 * independent end-to-end verification suite on top of the canonical WMS APIs:
 *
 *   - inventory domains (`retail` | `wholesale`) never collapse into one another,
 *   - ownership (kolbe | supplier) is explicit and NEVER a side effect,
 *   - supplier declared capacity is NOT stock,
 *   - Series → retail unit conversion is exactly-one-document, atomic, idempotent,
 *     snapshot-driven and rolls back as a whole,
 *   - transfers are documents with states, in-transit visibility and discrepancy receipts,
 *   - adjustments are deltas with reason + movement (raw overwrite does not exist),
 *   - publication and stock are independent,
 *   - server-backed WMS filters with a deterministic newest-first default,
 *   - supplier privacy and the ban on supplier→VIP direct shipping.
 *
 * This suite is additive: it does not weaken any existing Prompt-1/Prompt-2 suite.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4023, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type App = Awaited<ReturnType<typeof buildApp>>;
type Pool = ReturnType<typeof createPool>;
type Headers = Record<string, string>;

async function makeUser(app: App, pool: Pool, role: string, suffix: string) {
  const id = randomUUID();
  const email = `p3-${role}-${suffix}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('Prompt3Password123456!'), `P3 ${role} ${suffix}`]);
  await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
  if (role === 'supplier') await pool.query(
    "INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')", [id, `P3 Supplier ${suffix}`]);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: email, password: 'Prompt3Password123456!' } });
  assert.equal(login.statusCode, 200, login.body);
  return { id, email, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
}

const makeAdmin = (app: App, pool: Pool, suffix: string) => makeUser(app, pool, 'admin', suffix);

async function makeProduct(app: App, headers: Headers, suffix: string, sizes: string[] = ['M']) {
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
    brand: 'Kolbe', name: `کالای P3 ${suffix}`, category: 'کت', cashPriceRial: '9000000',
    wholesalePriceRial: '4000000', retailEnabled: true, wholesaleEnabled: true,
    variants: sizes.map((size) => ({ size, color: 'مشکی' })),
  } });
  assert.equal(product.statusCode, 201, product.body);
  return { productId: product.json().id as string,
    variants: product.json().variants as Array<{ id: string; sku: string }> };
}

/** 016_commerce_product.sql: a supplier-owned product is wholesale-only — enforced by the DB. */
async function makeSupplierProduct(app: App, pool: Pool, headers: Headers, supplierId: string, suffix: string) {
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
    brand: 'Kolbe', name: `کالای تأمین‌کننده P3 ${suffix}`, category: 'کت', cashPriceRial: '0',
    wholesalePriceRial: '4000000', retailEnabled: false, wholesaleEnabled: true,
    variants: [{ size: 'M', color: 'مشکی' }],
  } });
  assert.equal(product.statusCode, 201, product.body);
  const productId = product.json().id as string;
  const updated = await pool.query(
    "UPDATE products SET owner_type = 'supplier', supplier_id = $1 WHERE id = $2 AND retail_enabled = false", [supplierId, productId]);
  assert.equal(updated.rowCount, 1);
  return { productId, variants: product.json().variants as Array<{ id: string; sku: string }> };
}

async function makeWarehouse(app: App, headers: Headers, code: string, name: string) {
  const wh = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers, payload: { code, name } });
  assert.equal(wh.statusCode, 201, wh.body);
  return wh.json().id as string;
}

function adjust(app: App, headers: Headers, payload: Record<string, unknown>, key: string) {
  return app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
    headers: { ...headers, 'idempotency-key': key }, payload });
}

async function receipt(app: App, headers: Headers, payload: Record<string, unknown>, key: string) {
  const created = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
    headers: { ...headers, 'idempotency-key': key }, payload });
  assert.equal(created.statusCode, 201, created.body);
  const received = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${created.json().id as string}/receive`,
    headers, payload: {} });
  assert.equal(received.statusCode, 200, received.body);
  return received.json();
}

async function stockRow(pool: Pool, variantId: string, warehouseId: string, domain: string) {
  const row = await pool.query<{ on_hand: number; reserved: number; incoming: number; damaged: number }>(
    `SELECT on_hand, reserved, incoming, damaged FROM stock_balances
     WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
    [variantId, warehouseId, domain]);
  const r = row.rows[0];
  return r ? { ...r, available: r.on_hand - r.reserved - r.damaged } : null;
}

/**
 * Canonical OMS retention: create order + line + active reservation + balance reservation
 * + movement, exactly like the order pipeline does. Prompt 4 owns order-side reservations;
 * this suite only needs the resulting state to prove domain isolation of allocatable stock.
 */
async function reserveRetail(pool: Pool, input: { buyerId: string; productId: string; variantId: string; warehouseId: string; quantity: number; reference: string }) {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await pool.query(`INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial)
    VALUES ($1,$2,$3,'retail','cash','paid',150000000,150000000)`, [orderId, `P3-ORD-${input.reference}`, input.buyerId]);
  await pool.query(`INSERT INTO order_lines(id,order_id,product_id,variant_id,product_name,sku,quantity,unit_price_rial,line_total_rial)
    VALUES ($1,$2,$3,$4,$5,$6,$7,150000000,150000000)`,
    [lineId, orderId, input.productId, input.variantId, 'P3 order line', `P3-SKU-${input.reference}`, input.quantity]);
  const updated = await pool.query(
    `UPDATE stock_balances SET reserved = reserved + $3, version = version + 1, updated_at = now()
     WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'retail'
       AND on_hand - reserved - damaged >= $3`,
    [input.variantId, input.warehouseId, input.quantity]);
  assert.equal(updated.rowCount, 1, 'reservation must be backed by allocatable retail stock');
  await pool.query(`INSERT INTO stock_reservations(id,order_line_id,variant_id,warehouse_id,inventory_domain,quantity,status)
    VALUES ($1,$2,$3,$4,'retail',$5,'active')`, [randomUUID(), lineId, input.variantId, input.warehouseId, input.quantity]);
  await pool.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,reserved_delta,reason,reference_type,reference_id,idempotency_key)
    VALUES ($1,$2,$3,'retail',$4,'order reservation','order',$5,$6)`,
    [randomUUID(), input.variantId, input.warehouseId, input.quantity, orderId, `p3-reserve:${lineId}`]);
  return orderId;
}

async function makeSeriesWorld(app: App, headers: Headers, suffix: string, seriesCount = 5) {
  const { productId, variants } = await makeProduct(app, headers, suffix, ['S', 'M', 'L']);
  const template = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers, payload: {
    productId, name: `سری P3 ${suffix}`,
    items: variants.map((v) => ({ variantId: v.id, quantityPerSeries: 2 })),
  } });
  assert.equal(template.statusCode, 201, template.body);
  const templateId = template.json().id as string;
  const source = await makeWarehouse(app, headers, `P3W-${suffix.toUpperCase()}`, 'انبار مرکزی عمده P3');
  const destination = await makeWarehouse(app, headers, `P3R-${suffix.toUpperCase()}`, 'انبار خرده P3');
  const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
    headers: { ...headers, 'idempotency-key': `p3-setup-${suffix}` },
    payload: { retail: { warehouseId: destination, mode: 'zero' },
      wholesale: { warehouseId: source, seriesTemplateId: templateId, seriesCount } } });
  assert.equal(setup.statusCode, 201, setup.body);
  return { productId, variants, templateId, source, destination, seriesCount };
}

/* ------------------------------------------------------------------ P3-WMS-001/004 */

test('P3-WMS-001/004: retail 10 with reservation 3 → 7 allocatable and wholesale 5 untouched (domains stay independent)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { id: buyerId, headers } = await makeAdmin(app, pool, suffix);
    const retail = await makeWarehouse(app, headers, `P3-1R-${suffix.toUpperCase()}`, 'خرده ۱');
    const wholesale = await makeWarehouse(app, headers, `P3-1W-${suffix.toUpperCase()}`, 'عمده ۱');
    const { productId, variants } = await makeProduct(app, headers, suffix);
    const variantId = variants[0]!.id;

    assert.equal((await adjust(app, headers, { variantId, warehouseId: retail, inventoryDomain: 'retail', delta: 10, reason: 'موجودی اولیه خرده', reference: `p3-1r-${suffix}` }, `p3-1r-${suffix}`)).statusCode, 201);
    assert.equal((await adjust(app, headers, { variantId, warehouseId: wholesale, inventoryDomain: 'wholesale', delta: 5, reason: 'موجودی اولیه عمده', reference: `p3-1w-${suffix}` }, `p3-1w-${suffix}`)).statusCode, 201);
    await reserveRetail(pool, { buyerId, productId, variantId, warehouseId: retail, quantity: 3, reference: suffix });

    assert.deepEqual(await stockRow(pool, variantId, retail, 'retail'), { on_hand: 10, reserved: 3, incoming: 0, damaged: 0, available: 7 });
    assert.deepEqual(await stockRow(pool, variantId, wholesale, 'wholesale'), { on_hand: 5, reserved: 0, incoming: 0, damaged: 0, available: 5 });

    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}&withTotal=1&limit=50`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const rows = (list.json().items as Array<{ inventory_domain: string; on_hand: number; reserved: number; available: number }>);
    const retailRow = rows.find((r) => r.inventory_domain === 'retail')!;
    const wholesaleRow = rows.find((r) => r.inventory_domain === 'wholesale')!;
    assert.equal(retailRow.available, 7);
    assert.equal(retailRow.reserved, 3);
    // The retail reservation must never consume wholesale allocatable stock.
    assert.equal(wholesaleRow.available, 5);
    assert.equal(wholesaleRow.reserved, 0);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/inventory/variants/${variantId}`, headers });
    assert.equal(detail.json().retail.available, 7);
    assert.equal(detail.json().wholesale.available, 5);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-002 */

test('P3-WMS-002: declared supplier capacity 20 is capacity, never physical/allocatable stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers: adminHeaders } = await makeAdmin(app, pool, suffix);
    const { id: supplierId, headers: supplierHeaders } = await makeUser(app, pool, 'supplier', suffix);
    const { productId, variants } = await makeSupplierProduct(app, pool, adminHeaders, supplierId, suffix);

    const offer = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: supplierHeaders, payload: {
      productId, fulfillmentMode: 'order_driven', minOrderSeries: 1, safetyBuffer: 0, leadTimeDays: 3 } });
    assert.equal(offer.statusCode, 201, offer.body);
    const offerId = offer.json().id as string;
    const capacity = await app.inject({ method: 'POST', url: `/api/v1/supplier/offers/${offerId}/capacity`, headers: supplierHeaders,
      payload: { declaredCapacity: 20 } });
    assert.equal(capacity.statusCode, 200, capacity.body);
    assert.equal(capacity.json().availableToRequest, 20);

    const availability = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/wholesale-availability`, headers: adminHeaders });
    assert.equal(availability.statusCode, 200, availability.body);
    assert.equal(availability.json().kolbeStock.length, 0);
    assert.equal(availability.json().supplierOffers[0].declaredCapacity, 20);
    assert.equal(availability.json().supplierOffers[0].stockAtKolbeSeries, 0);
    assert.equal(availability.json().supplierOffers[0].externalAvailableToRequest, 20);

    // No physical book was created anywhere by a capacity declaration.
    const balances = await pool.query('SELECT count(*)::int AS n FROM stock_balances WHERE variant_id = ANY($1::uuid[])', [variants.map((v) => v.id)]);
    assert.equal(balances.rows[0].n, 0);
    const series = await pool.query('SELECT count(*)::int AS n FROM series_stock_balances WHERE series_template_id IN (SELECT id FROM series_templates WHERE product_id = $1)', [productId]);
    assert.equal(series.rows[0].n, 0);
    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}&withTotal=1`, headers: adminHeaders });
    assert.equal(list.json().total, 0);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-003 + 010 */

test('P3-WMS-003/010: supplier-owned stock physically at Kolbe stays supplier-owned — receipt never converts, retail entry is blocked', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const { id: supplierId } = await makeUser(app, pool, 'supplier', suffix);
    const retail = await makeWarehouse(app, headers, `P3-3R-${suffix.toUpperCase()}`, 'خرده ۳');
    const wholesale = await makeWarehouse(app, headers, `P3-3W-${suffix.toUpperCase()}`, 'عمده ۳ (محل کلبه)');
    const { productId, variants } = await makeSupplierProduct(app, pool, headers, supplierId, suffix);
    const variantId = variants[0]!.id;

    // Supplier-owned goods CAN physically live at a Kolbe warehouse in the wholesale domain.
    const received = await receipt(app, headers, { warehouseId: wholesale, variantId, inventoryDomain: 'wholesale', quantity: 5, reference: `p3-3-${suffix}` }, `p3-3-${suffix}`);
    assert.equal(received.receivedQuantity, 5);
    assert.deepEqual(await stockRow(pool, variantId, wholesale, 'wholesale'),
      { on_hand: 5, reserved: 0, incoming: 0, damaged: 0, available: 5 });
    const product = await pool.query('SELECT owner_type, supplier_id FROM products WHERE id = $1', [productId]);
    assert.equal(product.rows[0].owner_type, 'supplier');
    assert.equal(product.rows[0].supplier_id, supplierId);

    // Receiving did NOT create any retail stock, and a manual retail adjustment is refused.
    assert.equal((await stockRow(pool, variantId, retail, 'retail')), null);
    const manual = await adjust(app, headers, { variantId, warehouseId: retail, inventoryDomain: 'retail', delta: 3, reason: 'ورود دستی به خرده', reference: `p3-3a-${suffix}` }, `p3-3a-${suffix}`);
    assert.equal(manual.statusCode, 403, manual.body);
    assert.match(manual.json().message, /انتقال مالکیت|مالکیت/);

    // And the official wholesale→retail transfer is refused without a completed conversion.
    const transfer = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-3t-${suffix}` }, payload: {
        variantId, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: wholesale, destinationWarehouseId: retail, quantity: 2, reason: 'انتقال آزمایشی' } });
    assert.equal(transfer.statusCode, 403, transfer.body);
    assert.deepEqual(await stockRow(pool, variantId, wholesale, 'wholesale'),
      { on_hand: 5, reserved: 0, incoming: 0, damaged: 0, available: 5 });
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-005 */

test('P3-WMS-005: Series S2/M2/L2 × 3 converts to exactly 18 retail units (wholesale 5 → 2)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix, 5);

    const supply = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload: {
      seriesTemplateId: world.templateId, sourceWarehouseId: world.source, destinationWarehouseId: world.destination,
      seriesCount: 3, idempotencyKey: `p3-5-${suffix}` } });
    assert.equal(supply.statusCode, 201, supply.body);
    const id = supply.json().id as string;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/retail-supplies/${id}/dispatch`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/retail-supplies/${id}/receive`, headers })).statusCode, 200);

    const retail = await pool.query<{ size_label: string; on_hand: number; incoming: number }>(
      `SELECT v.size_label, b.on_hand, b.incoming FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id
       WHERE v.product_id = $1 AND b.warehouse_id = $2 AND b.inventory_domain = 'retail' ORDER BY v.size_label`,
      [world.productId, world.destination]);
    assert.deepEqual(retail.rows.map((r) => r.on_hand), [6, 6, 6]);
    assert.equal(retail.rows.reduce((n, r) => n + r.on_hand, 0), 18);
    assert.ok(retail.rows.every((r) => r.incoming === 0));

    const series = await pool.query('SELECT on_hand, reserved, owner_type FROM series_stock_balances WHERE series_template_id = $1 AND warehouse_id = $2',
      [world.templateId, world.source]);
    assert.equal(series.rows[0].on_hand, 2);
    assert.equal(series.rows[0].reserved, 0);
    assert.equal(series.rows[0].owner_type, 'kolbe');

    const ledger = await pool.query<{ qty: number }>(
      `SELECT sum(on_hand_delta)::int AS qty FROM stock_movements
       WHERE reference_id = $1 AND warehouse_id = $2 AND inventory_domain = 'retail'`, [id, world.destination]);
    assert.equal(ledger.rows[0]!.qty, 18);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-006 + 007 */

test('P3-WMS-006/007: same idempotency key + same payload replays as a no-op; different payload is a deterministic 409', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix, 5);
    const payload = { seriesTemplateId: world.templateId, sourceWarehouseId: world.source,
      destinationWarehouseId: world.destination, seriesCount: 3, idempotencyKey: `p3-6-${suffix}` };

    const first = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().id, first.json().id);
    assert.equal(replay.json().duplicate, true);
    const docs = await pool.query('SELECT count(*)::int AS n FROM retail_supply_orders WHERE idempotency_key = $1', [payload.idempotencyKey]);
    assert.equal(docs.rows[0].n, 1);
    // The replay did not reserve a second time.
    const series = await pool.query('SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [world.templateId]);
    assert.deepEqual(series.rows[0], { on_hand: 5, reserved: 3 });

    const changed = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload: { ...payload, seriesCount: 4 } });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.match(changed.json().message, /کلید تکرار/);
    const after = await pool.query('SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [world.templateId]);
    assert.deepEqual(after.rows[0], { on_hand: 5, reserved: 3 });
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-008 */

test('P3-WMS-008: an inconsistent piece balance rolls the whole conversion back (no partial unpack, no movements)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix, 5);
    const created = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload: {
      seriesTemplateId: world.templateId, sourceWarehouseId: world.source, destinationWarehouseId: world.destination,
      seriesCount: 3, idempotencyKey: `p3-8-${suffix}` } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    // Physical reality no longer covers one component — the conversion must not invent it.
    await pool.query("UPDATE stock_balances SET on_hand = 0 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'",
      [world.variants[1]!.id, world.source]);
    const failed = await app.inject({ method: 'POST', url: `/api/v1/retail-supplies/${id}/dispatch`, headers });
    assert.equal(failed.statusCode, 409, failed.body);

    const series = await pool.query('SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [world.templateId]);
    assert.deepEqual(series.rows[0], { on_hand: 5, reserved: 3 });
    const movements = await pool.query("SELECT count(*)::int AS n FROM stock_movements WHERE reference_type = 'retail_supply' AND reference_id = $1", [id]);
    assert.equal(movements.rows[0].n, 0);
    const retail = await pool.query<{ on_hand: number }>(
      "SELECT COALESCE(sum(on_hand), 0)::int AS on_hand FROM stock_balances WHERE warehouse_id = $1 AND inventory_domain = 'retail'", [world.destination]);
    assert.equal(retail.rows[0]!.on_hand, 0);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-009 */

test('P3-WMS-009: dispatch expands the immutable recipe snapshot, not the edited live recipe', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const world = await makeSeriesWorld(app, headers, suffix, 5);
    const created = await app.inject({ method: 'POST', url: '/api/v1/retail-supplies', headers, payload: {
      seriesTemplateId: world.templateId, sourceWarehouseId: world.source, destinationWarehouseId: world.destination,
      seriesCount: 2, idempotencyKey: `p3-9-${suffix}` } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    // A later recipe edit must never change what an existing document contains.
    await pool.query('UPDATE series_template_items SET quantity_per_series = 9 WHERE series_template_id = $1', [world.templateId]);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/retail-supplies/${id}/dispatch`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/retail-supplies/${id}/receive`, headers })).statusCode, 200);

    const retail = await pool.query<{ on_hand: number }>(
      `SELECT b.on_hand FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id
       WHERE v.product_id = $1 AND b.warehouse_id = $2 AND b.inventory_domain = 'retail'`, [world.productId, world.destination]);
    // 2 series × 2 pieces per component — NOT 2 × 9.
    assert.deepEqual(retail.rows.map((r) => r.on_hand), [4, 4, 4]);
    const snapshot = await pool.query<{ recipe_snapshot: { piecesPerSeries: number } }>(
      'SELECT recipe_snapshot FROM retail_supply_orders WHERE id = $1', [id]);
    assert.equal(snapshot.rows[0]!.recipe_snapshot.piecesPerSeries, 6);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-011 */

test('P3-WMS-011: ownership conversion is explicit, keeps quantities unchanged, and its capacity bounds retail entry', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const { id: supplierId } = await makeUser(app, pool, 'supplier', suffix);
    const retail = await makeWarehouse(app, headers, `P3-11R-${suffix.toUpperCase()}`, 'خرده ۱۱');
    const wholesale = await makeWarehouse(app, headers, `P3-11W-${suffix.toUpperCase()}`, 'عمده ۱۱');
    const { productId, variants } = await makeSupplierProduct(app, pool, headers, supplierId, suffix);
    const variantId = variants[0]!.id;
    await receipt(app, headers, { warehouseId: wholesale, variantId, inventoryDomain: 'wholesale', quantity: 5, reference: `p3-11-${suffix}` }, `p3-11-${suffix}`);
    const before = await pool.query('SELECT on_hand, version FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [variantId, wholesale, 'wholesale']);
    const movementsBefore = await pool.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId]);

    const conversion = await app.inject({ method: 'POST', url: '/api/v1/inventory/ownership-conversions',
      headers: { ...headers, 'idempotency-key': `p3-11c-${suffix}` }, payload: {
        productId, variantId, conversionType: 'purchase_acquisition', referenceCode: `PO-${suffix}`,
        quantity: 3, notes: 'خرید آزمایشی از تأمین‌کننده' } });
    assert.equal(conversion.statusCode, 201, conversion.body);
    assert.equal(conversion.json().status, 'completed');
    assert.equal(conversion.json().fromOwnerType, 'supplier');
    assert.equal(conversion.json().toOwnerType, 'kolbe');

    // Ownership ≠ quantity: the physical book is bit-for-bit unchanged.
    const after = await pool.query('SELECT on_hand, version FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3', [variantId, wholesale, 'wholesale']);
    assert.deepEqual(after.rows[0], before.rows[0]);
    const movements = await pool.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId]);
    assert.equal(movements.rows[0]!.n, movementsBefore.rows[0]!.n,
      'ownership conversion writes no stock movement — only physical events move stock');

    // The conversion is auditable and listed.
    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory/ownership-conversions?productId=${productId}`, headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok((list.json().items as Array<{ id: string }>).some((row) => row.id === conversion.json().id));

    // Retail entry consumes conversion capacity: 3 units may enter, the remaining 2 may not.
    const first = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-11t1-${suffix}` }, payload: {
        variantId, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: wholesale, destinationWarehouseId: retail, quantity: 3, reason: 'انتقال به خرده پس از تملک' } });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${first.json().id as string}/approve`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${first.json().id as string}/complete`, headers, payload: {} })).statusCode, 200);
    assert.equal((await stockRow(pool, variantId, retail, 'retail'))?.on_hand, 3);
    const definition = await pool.query('SELECT retail_enabled, owner_type FROM products WHERE id = $1', [productId]);
    assert.equal(definition.rows[0].retail_enabled, false, 'unit ownership conversion never auto-enables retail sale');
    assert.equal(definition.rows[0].owner_type, 'supplier');

    const second = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-11t2-${suffix}` }, payload: {
        variantId, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: wholesale, destinationWarehouseId: retail, quantity: 2, reason: 'انتقال مازاد بر سند تملک' } });
    assert.equal(second.statusCode, 403, second.body);
    assert.match(second.json().message, /ظرفیت باقی‌مانده|تملک/);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-012 */

test('P3-WMS-012: transfer 20 → 10 is a document with in-transit state (never an instant A−10/B+10)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const from = await makeWarehouse(app, headers, `P3-12A-${suffix.toUpperCase()}`, 'انبار مبدأ ۱۲');
    const to = await makeWarehouse(app, headers, `P3-12B-${suffix.toUpperCase()}`, 'انبار مقصد ۱۲');
    const { variants } = await makeProduct(app, headers, suffix);
    const variantId = variants[0]!.id;
    assert.equal((await adjust(app, headers, { variantId, warehouseId: from, inventoryDomain: 'retail', delta: 20, reason: 'موجودی اولیه مبدأ', reference: `p3-12-${suffix}` }, `p3-12-${suffix}`)).statusCode, 201);

    const created = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-12t-${suffix}` }, payload: {
        variantId, sourceDomain: 'retail', destinationDomain: 'retail',
        sourceWarehouseId: from, destinationWarehouseId: to, quantity: 10, reason: 'انتقال بین دو انبار خرده' } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().status, 'draft');
    const id = created.json().id as string;

    // Draft only reserves the source; the destination has not been credited.
    assert.deepEqual(await stockRow(pool, variantId, from, 'retail'), { on_hand: 20, reserved: 10, incoming: 0, damaged: 0, available: 10 });
    assert.equal(await stockRow(pool, variantId, to, 'retail'), null);

    const approved = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/approve`, headers });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'in_transit');
    const inTransit = await app.inject({ method: 'GET', url: `/api/v1/inventory/variants/${variantId}`, headers });
    assert.equal(inTransit.json().retail.incoming, 10, 'in-transit units are exposed as incoming at the destination');
    assert.equal(inTransit.json().retail.on_hand, 10);

    const completed = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/complete`, headers, payload: {} });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().status, 'completed');
    assert.deepEqual(await stockRow(pool, variantId, from, 'retail'), { on_hand: 10, reserved: 0, incoming: 0, damaged: 0, available: 10 });
    assert.deepEqual(await stockRow(pool, variantId, to, 'retail'), { on_hand: 10, reserved: 0, incoming: 0, damaged: 0, available: 10 });

    const movements = await pool.query<{ on_hand_delta: number; warehouse_id: string }>(
      "SELECT on_hand_delta, warehouse_id FROM stock_movements WHERE reference_type = 'stock_transfer' AND reference_id = $1", [id]);
    assert.equal(movements.rows.filter((m) => m.warehouse_id === from).reduce((n, m) => n + m.on_hand_delta, 0), -10);
    assert.equal(movements.rows.filter((m) => m.warehouse_id === to).reduce((n, m) => n + m.on_hand_delta, 0), 10);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-013 + 014 */

test('P3-WMS-013/014: 20 sent / 18 usable / 2 damaged closes with preserved discrepancy; a second receive is a no-op', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const from = await makeWarehouse(app, headers, `P3-13A-${suffix.toUpperCase()}`, 'انبار مبدأ ۱۳');
    const to = await makeWarehouse(app, headers, `P3-13B-${suffix.toUpperCase()}`, 'انبار مقصد ۱۳');
    const { variants } = await makeProduct(app, headers, suffix);
    const variantId = variants[0]!.id;
    await adjust(app, headers, { variantId, warehouseId: from, inventoryDomain: 'retail', delta: 20, reason: 'موجودی اولیه مبدأ', reference: `p3-13-${suffix}` }, `p3-13-${suffix}`);
    const created = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-13t-${suffix}` }, payload: {
        variantId, sourceDomain: 'retail', destinationDomain: 'retail',
        sourceWarehouseId: from, destinationWarehouseId: to, quantity: 20, reason: 'انتقال کامل با احتمال مغایرت' } });
    // Moving 100% of allocatable stock demands explicit confirmation (never an accidental empty shelf).
    assert.equal(created.statusCode, 400, created.body);
    const confirmed = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...headers, 'idempotency-key': `p3-13t2-${suffix}` }, payload: {
        variantId, sourceDomain: 'retail', destinationDomain: 'retail', confirmFullStock: true,
        sourceWarehouseId: from, destinationWarehouseId: to, quantity: 20, reason: 'انتقال کامل با تأیید صریح' } });
    assert.equal(confirmed.statusCode, 201, confirmed.body);
    const id = confirmed.json().id as string;
    await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/approve`, headers });

    // sent ≠ received is never silently forced to match.
    const wrong = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/complete`, headers,
      payload: { receivedQty: 19, damagedQty: 2 } });
    assert.equal(wrong.statusCode, 400, wrong.body);
    assert.deepEqual(await stockRow(pool, variantId, to, 'retail'), { on_hand: 0, reserved: 0, incoming: 20, damaged: 0, available: 0 });

    const completed = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/complete`, headers,
      payload: { receivedQty: 18, damagedQty: 2 } });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().status, 'completed_with_discrepancy');
    assert.equal(completed.json().receivedQty, 18);
    assert.equal(completed.json().damagedQty, 2);
    assert.deepEqual(await stockRow(pool, variantId, to, 'retail'), { on_hand: 18, reserved: 0, incoming: 0, damaged: 2, available: 16 });

    // The document preserves what was sent vs what really arrived, and the history is readable.
    const transfer = await pool.query('SELECT status, quantity, received_qty, damaged_qty FROM stock_transfers WHERE id = $1', [id]);
    assert.deepEqual(transfer.rows[0], { status: 'completed_with_discrepancy', quantity: 20, received_qty: 18, damaged_qty: 2 });
    const history = await app.inject({ method: 'GET', url: `/api/v1/inventory/movements?variantId=${variantId}`, headers });
    const completeMovement = (history.json().items as Array<{ reference_id: string; reason: string; damaged_delta: number }>)
      .find((m) => m.reference_id === id && m.damaged_delta === 2)!;
    assert.ok(completeMovement, 'discrepancy movement must exist');
    assert.match(completeMovement.reason, /18/);
    assert.match(completeMovement.reason, /2/);

    // Double receive: same status, same balances, no double increment.
    const again = await app.inject({ method: 'POST', url: `/api/v1/inventory/transfers/${id}/complete`, headers, payload: {} });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().status, 'completed_with_discrepancy');
    assert.deepEqual(await stockRow(pool, variantId, to, 'retail'), { on_hand: 18, reserved: 0, incoming: 0, damaged: 2, available: 16 });
    const completedMovements = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM stock_movements WHERE reference_id = $1 AND idempotency_key = 'transfer-complete:' || $1", [id]);
    assert.equal(completedMovements.rows[0]!.n, 1, 'no duplicated completion movement');

    // Confirming a RECEIPT is idempotent too: the same request replays the recorded outcome
    // (including the recorded shortage) instead of mutating stock a second time.
    const receiptRow = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
      headers: { ...headers, 'idempotency-key': `p3-14-${suffix}` },
      payload: { warehouseId: to, variantId, inventoryDomain: 'retail', quantity: 5, reference: `p3-14-${suffix}` } });
    assert.equal(receiptRow.statusCode, 201, receiptRow.body);
    const receiptId = receiptRow.json().id as string;
    const receiptConfirmed = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receiptId}/receive`, headers, payload: { receivedQuantity: 4 } });
    assert.equal(receiptConfirmed.statusCode, 200, receiptConfirmed.body);
    assert.equal(receiptConfirmed.json().missingQuantity, 1);
    const beforeRetry = await stockRow(pool, variantId, to, 'retail');
    const receiptRetry = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receiptId}/receive`, headers, payload: { receivedQuantity: 4 } });
    assert.equal(receiptRetry.statusCode, 200, receiptRetry.body);
    assert.equal(receiptRetry.json().duplicate, true);
    assert.deepEqual(await stockRow(pool, variantId, to, 'retail'), beforeRetry, 'a receipt retry never moves stock twice');
    const receiptConflict = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receiptId}/receive`, headers, payload: { receivedQuantity: 3 } });
    assert.equal(receiptConflict.statusCode, 409, receiptConflict.body);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-015 + 016 */

test('P3-WMS-015/016: adjustments are delta + reason + movement (no raw overwrite endpoint) and can never go negative', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const retail = await makeWarehouse(app, headers, `P3-15R-${suffix.toUpperCase()}`, 'خرده ۱۵');
    const { variants } = await makeProduct(app, headers, suffix);
    const variantId = variants[0]!.id;
    await adjust(app, headers, { variantId, warehouseId: retail, inventoryDomain: 'retail', delta: 10, reason: 'موجودی اولیه', reference: `p3-15-${suffix}` }, `p3-15-${suffix}`);

    const decreased = await adjust(app, headers, { variantId, warehouseId: retail, inventoryDomain: 'retail', delta: -2,
      reason: 'شمارش دوره‌ای — دو عدد مفقود', reference: `ADJ-${suffix}` }, `p3-15b-${suffix}`);
    assert.equal(decreased.statusCode, 201, decreased.body);
    assert.equal(decreased.json().onHand, 8);
    assert.equal(decreased.json().available, 8);
    const movement = await pool.query<{ on_hand_delta: number; reason: string; reference_type: string; actor_id: string }>(
      'SELECT on_hand_delta, reason, reference_type, actor_id FROM stock_movements WHERE id = $1', [decreased.json().movementId as string]);
    assert.equal(movement.rows[0]!.on_hand_delta, -2);
    assert.match(movement.rows[0]!.reason, /شمارش دوره/);
    assert.equal(movement.rows[0]!.reference_type, 'adjustment');
    assert.ok(movement.rows[0]!.actor_id, 'movement records the actor');

    // There is no raw "set balance" authority anywhere.
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/inventory', headers, payload: { onHand: 27 } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/v1/inventory/balance', headers, payload: { onHand: 27 } })).statusCode, 404);

    // Negative guard: a delta that would push on_hand below reserved + damaged is refused.
    const damaged = await app.inject({ method: 'POST', url: '/api/v1/inventory/damaged', headers,
      payload: { variantId, warehouseId: retail, inventoryDomain: 'retail', quantity: 2, reason: 'آسیب در جابه‌جایی' } });
    assert.equal(damaged.statusCode, 201, damaged.body);
    const failing = await adjust(app, headers, { variantId, warehouseId: retail, inventoryDomain: 'retail', delta: -7,
      reason: 'اصلاح بیش از موجودی قابل فروش', reference: `ADJ-BAD-${suffix}` }, `p3-16-${suffix}`);
    assert.equal(failing.statusCode, 409, failing.body);
    assert.deepEqual(await stockRow(pool, variantId, retail, 'retail'), { on_hand: 8, reserved: 0, incoming: 0, damaged: 2, available: 6 });
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-017 */

test('P3-WMS-017: publication and stock are independent (receiving never publishes; stock changes never archive)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const wholesale = await makeWarehouse(app, headers, `P3-17W-${suffix.toUpperCase()}`, 'عمده ۱۷');
    const { productId, variants } = await makeProduct(app, headers, suffix);
    const variantId = variants[0]!.id;

    const initial = await pool.query('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(initial.rows[0].status, 'draft');
    // Receiving physical stock must not publish a draft.
    await receipt(app, headers, { warehouseId: wholesale, variantId, inventoryDomain: 'wholesale', quantity: 4, reference: `p3-17-${suffix}` }, `p3-17-${suffix}`);
    const afterReceipt = await pool.query('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(afterReceipt.rows[0].status, 'draft');
    const draftView = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}&publicationStatus=draft`, headers });
    assert.equal(draftView.json().items.length, 1);
    const publishedView = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}&publicationStatus=published`, headers });
    assert.equal(publishedView.json().items.length, 0);

    // A published product with stock keeps its publication when the stock changes (and never archives).
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [productId]);
    const adjustResult = await adjust(app, headers, { variantId, warehouseId: wholesale, inventoryDomain: 'wholesale', delta: -1,
      reason: 'فروش عمده آزمایشی', reference: `p3-17b-${suffix}` }, `p3-17b-${suffix}`);
    assert.equal(adjustResult.statusCode, 201, adjustResult.body);
    const afterAdjust = await pool.query('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(afterAdjust.rows[0].status, 'published');
    const list = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}`, headers });
    const row = (list.json().items as Array<{ product_status: string; sale_status: string }>)[0]!;
    assert.equal(row.product_status, 'published');
    assert.notEqual(row.sale_status, 'published', 'sale status must never masquerade as publication state');

    // Zero stock does not unpublish: stock and publication stay orthogonal.
    await adjust(app, headers, { variantId, warehouseId: wholesale, inventoryDomain: 'wholesale', delta: -3,
      reason: 'تخلیه آزمایشی موجودی', reference: `p3-17c-${suffix}` }, `p3-17c-${suffix}`);
    assert.equal((await stockRow(pool, variantId, wholesale, 'wholesale'))?.on_hand, 0);
    const afterZero = await pool.query('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(afterZero.rows[0].status, 'published');
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-018 */

test('P3-WMS-018: combined server-backed filters narrow correctly and clearing them restores the newest-first default', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await makeAdmin(app, pool, suffix);
    const retail = await makeWarehouse(app, headers, `P3-18R-${suffix.toUpperCase()}`, 'خرده ۱۸');
    const wholesale = await makeWarehouse(app, headers, `P3-18W-${suffix.toUpperCase()}`, 'عمده ۱۸');
    const first = await makeProduct(app, headers, `۱۸قدیم-${suffix}`, ['M']);
    const second = await makeProduct(app, headers, `۱۸جدید-${suffix}`, ['M']);
    await adjust(app, headers, { variantId: first.variants[0]!.id, warehouseId: retail, inventoryDomain: 'retail', delta: 4, reason: 'موجودی خرده اول', reference: `p3-18a-${suffix}` }, `p3-18a-${suffix}`);
    await adjust(app, headers, { variantId: first.variants[0]!.id, warehouseId: wholesale, inventoryDomain: 'wholesale', delta: 9, reason: 'موجودی عمده اول', reference: `p3-18b-${suffix}` }, `p3-18b-${suffix}`);
    await adjust(app, headers, { variantId: second.variants[0]!.id, warehouseId: retail, inventoryDomain: 'retail', delta: 7, reason: 'موجودی خرده دوم', reference: `p3-18c-${suffix}` }, `p3-18c-${suffix}`);

    const filtered = await app.inject({ method: 'GET', headers, url:
      `/api/v1/inventory?productId=${second.productId}&inventoryDomain=retail&warehouseId=${retail}&owner=kolbe&hasReservation=0&stockStatus=in_stock&sort=stock_desc&withTotal=1` });
    assert.equal(filtered.statusCode, 200, filtered.body);
    const rows = filtered.json().items as Array<{ product_id: string; inventory_domain: string; warehouse_id: string; owner_type: string; available: number }>;
    assert.equal(rows.length, 1, filtered.body);
    assert.equal(rows[0]!.product_id, second.productId);
    assert.equal(rows[0]!.inventory_domain, 'retail');
    assert.equal(rows[0]!.warehouse_id, retail);
    assert.equal(rows[0]!.owner_type, 'kolbe');
    assert.equal(rows[0]!.available, 7);

    // A filter combination with no matching row stays empty — never falls back to the whole table.
    const empty = await app.inject({ method: 'GET', headers, url:
      `/api/v1/inventory?productId=${second.productId}&inventoryDomain=wholesale&owner=supplier` });
    assert.equal(empty.json().items.length, 0);

    // Clearing every filter returns the deterministic newest-product-first default.
    const cleared = await app.inject({ method: 'GET', url: '/api/v1/inventory?limit=100', headers });
    const all = cleared.json().items as Array<{ product_id: string; product_created_at: string }>;
    const mine = all.filter((r) => r.product_id === first.productId || r.product_id === second.productId);
    assert.ok(mine.length >= 3);
    assert.equal(mine[0]!.product_id, second.productId, 'default sort is newest product first');
    const dates = mine.map((r) => r.product_created_at);
    assert.deepEqual(dates, [...dates].sort().reverse());
    const oldest = await app.inject({ method: 'GET', url: '/api/v1/inventory?sort=oldest&limit=100', headers });
    const oldestMine = (oldest.json().items as Array<{ product_id: string }>).filter((r) => r.product_id === first.productId || r.product_id === second.productId);
    assert.equal(oldestMine[0]!.product_id, first.productId);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-019 */

test('P3-WMS-019: inventory reads preserve supplier privacy (no identity leak to buyers, no cross-supplier visibility)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers: adminHeaders } = await makeAdmin(app, pool, suffix);
    const { headers: buyerHeaders } = await makeUser(app, pool, 'customer', suffix);
    const { id: supplierA, headers: supplierAHeaders } = await makeUser(app, pool, 'supplier', `a${suffix}`);
    const { headers: supplierBHeaders } = await makeUser(app, pool, 'supplier', `b${suffix}`);
    const { productId } = await makeSupplierProduct(app, pool, adminHeaders, supplierA, suffix);
    // The product belongs to supplierA; a different supplier cannot offer it (IDOR guard).
    const foreignOffer = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: supplierBHeaders,
      payload: { productId, fulfillmentMode: 'order_driven', minOrderSeries: 1 } });
    assert.equal(foreignOffer.statusCode, 403, foreignOffer.body);

    const ownOffer = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: supplierAHeaders,
      payload: { productId, fulfillmentMode: 'order_driven', minOrderSeries: 1 } });
    assert.equal(ownOffer.statusCode, 201, ownOffer.body);

    const availability = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/wholesale-availability`, headers: buyerHeaders });
    assert.equal(availability.statusCode, 200, availability.body);
    for (const row of availability.json().supplierOffers as Array<Record<string, unknown>>) {
      assert.equal('supplierId' in row, false, 'buyer must not see supplier ids');
      assert.equal('supplierName' in row, false, 'buyer must not see supplier names');
    }

    // Buyers cannot read WMS inventory at all; another supplier only sees its own wholesale rows.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/inventory', headers: buyerHeaders })).statusCode, 403);
    const crossSupplier = await app.inject({ method: 'GET', url: `/api/v1/inventory?productId=${productId}`, headers: supplierBHeaders });
    assert.equal(crossSupplier.statusCode, 200, crossSupplier.body);
    assert.equal(crossSupplier.json().items.length, 0);
  } finally { await pool.end(); await app.close(); }
});

/* ------------------------------------------------------------------ P3-WMS-020 */

test('P3-WMS-020: declared capacity can never be dispatched to a buyer — no supplier→VIP direct path', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers: adminHeaders } = await makeAdmin(app, pool, suffix);
    const { id: supplierId, headers: supplierHeaders } = await makeUser(app, pool, 'supplier', suffix);
    const retail = await makeWarehouse(app, adminHeaders, `P3-20R-${suffix.toUpperCase()}`, 'خرده ۲۰');
    const wholesale = await makeWarehouse(app, adminHeaders, `P3-20W-${suffix.toUpperCase()}`, 'عمده ۲۰');
    const { productId, variants } = await makeSupplierProduct(app, pool, adminHeaders, supplierId, suffix);
    const variantId = variants[0]!.id;
    const offer = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: supplierHeaders,
      payload: { productId, fulfillmentMode: 'order_driven', minOrderSeries: 1 } });
    const offerId = offer.json().id as string;
    await app.inject({ method: 'POST', url: `/api/v1/supplier/offers/${offerId}/capacity`, headers: supplierHeaders, payload: { declaredCapacity: 10 } });

    // External procurement reserves CAPACITY only — never stock.
    const reserved = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-offers/${offerId}/reservations`, headers: adminHeaders,
      payload: { quantity: 6, idempotencyKey: `p3-20-${suffix}` } });
    assert.equal(reserved.statusCode, 201, reserved.body);
    const capacityRows = await pool.query('SELECT status, quantity FROM supplier_capacity_reservations WHERE offer_id = $1', [offerId]);
    assert.equal(capacityRows.rows[0]!.status, 'active');
    assert.equal(capacityRows.rows[0]!.quantity, 6);
    assert.equal(await stockRow(pool, variantId, wholesale, 'wholesale'), null);
    assert.equal(await stockRow(pool, variantId, retail, 'retail'), null);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/inventory/variants/${variantId}`, headers: adminHeaders });
    assert.equal(detail.json().retail.available, 0);
    assert.equal(detail.json().wholesale.available, 0);

    // Declared capacity cannot satisfy a warehouse transfer or create an inbound movement.
    const transfer = await app.inject({ method: 'POST', url: '/api/v1/inventory/transfers',
      headers: { ...adminHeaders, 'idempotency-key': `p3-20t-${suffix}` }, payload: {
        variantId, sourceDomain: 'wholesale', destinationDomain: 'retail',
        sourceWarehouseId: wholesale, destinationWarehouseId: retail, quantity: 1, reason: 'تلاش برای ارسال از ظرفیت' } });
    assert.equal([403, 409].includes(transfer.statusCode), true, transfer.body);
    const movements = await pool.query('SELECT count(*)::int AS n FROM stock_movements WHERE variant_id = $1', [variantId]);
    assert.equal(movements.rows[0].n, 0, 'capacity never writes an inventory movement');
  } finally { await pool.end(); await app.close(); }
});
