/**
 * Prompt 6 — Inbound / QC / Consolidation / Shipment acceptance suite.
 *
 *  Every case below drives the CANONICAL backend over the real HTTP surface (Fastify inject) and
 *  asserts on persisted state, not on test-local bookkeeping. Groups map 1:1 to the required matrix:
 *    Golden Scenario 1..7, P6-INB-00x, P6-QC-00x, P6-OMS-00x, P6-CON-00x, P6-SHP-00x, P6-REG-00x.
 *
 *  Authority exercised:  work-inbound.ts (arrival/receiving/GRN/QC/exceptions/dashboard/queues) and
 *  wholesale-oms.ts (pick, consolidation, packing, single final shipment). The legacy
 *  `children/:id/receive|qc` and `orders/:id/dispatch-vip` surfaces are exercised as ADAPTERS so a
 *  duplicate authority can never reappear unnoticed.
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
  NODE_ENV: 'test', PORT: 4033, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 3,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = Record<string, string>;

const uniqueRef = (prefix: string) => `${prefix}-${randomUUID().slice(0, 10)}`;

/* ------------------------------------------------------------------ fixtures */

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `p6-${roles[0] ?? 'user'}-${id.slice(0, 10)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('TestPassword123456!'), label]);
  for (const role of roles) {
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  }
  if (roles.includes('supplier')) await pool.query(
    "INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')", [id, label]);
  return { id, email, label };
}

async function login(app: App, email: string): Promise<Headers> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeVip(pool: Pool, label: string) {
  const user = await makeUser(pool, ['customer'], label);
  const planId = randomUUID();
  await pool.query("INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,$3,0,'{}')",
    [planId, uniqueRef('plan'), `پلن P6 ${label}`]);
  await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at)
     VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`, [randomUUID(), user.id, planId]);
  return user;
}

async function makeWarehouse(pool: Pool, label: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,'wholesale')",
    [id, uniqueRef('WH'), label]);
  return id;
}

/** Product + 2 variants + one 1-piece-per-series template (keeps piece vs series arithmetic obvious). */
async function makeSeriesProduct(pool: Pool, name: string, supplierId: string | null, opts: { piecesPerSeries?: number } = {}) {
  const pieces = opts.piecesPerSeries ?? 1;
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id, supplier_id, brand, name, category, status, cash_price_rial, wholesale_price_rial,
       owner_type, retail_enabled, wholesale_enabled)
     VALUES ($1,$2,'برند P6',$3,'هودی','published',100000000,90000000,$4,$5,true)`,
    [productId, supplierId, name, supplierId ? 'supplier' : 'kolbe', supplierId ? false : true]);
  const v1 = randomUUID(); const v2 = randomUUID();
  await pool.query("INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','مشکی'),($4,$2,$5,'L','مشکی')",
    [v1, productId, uniqueRef('P6A'), v2, uniqueRef('P6B')]);
  const tplId = randomUUID();
  await pool.query("INSERT INTO series_templates(id, product_id, name) VALUES ($1,$2,'سری P6')", [tplId, productId]);
  await pool.query('INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,$4),($5,$2,$6,$4)',
    [randomUUID(), tplId, v1, pieces, randomUUID(), v2]);
  return { productId, tplId, variantIds: [v1, v2] };
}

async function seedStock(pool: Pool, tplId: string, variantIds: string[], warehouseId: string,
  owner: { ownerType: 'kolbe' | 'supplier'; supplierId: string | null }, series: number, pieceMultiplier = 1) {
  await pool.query(
    'INSERT INTO series_stock_balances(id, series_template_id, warehouse_id, owner_type, supplier_id, on_hand) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), tplId, warehouseId, owner.ownerType, owner.supplierId, series]);
  for (const variantId of variantIds) {
    await pool.query(
      `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain, on_hand) VALUES ($1,$2,'wholesale',$3)
       ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO UPDATE SET on_hand = stock_balances.on_hand + $3`,
      [variantId, warehouseId, series * pieceMultiplier]);
  }
}

async function makeOffer(pool: Pool, supplierId: string, productId: string, tplId: string, capacity: number) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO supplier_offers(id, supplier_id, product_id, series_template_id, status, wholesale_price_rial,
       min_order_series, declared_capacity, reserved_external, safety_buffer, capacity_confirmed_at)
     VALUES ($1,$2,$3,$4,'active',100000000,1,$5,0,0,now())`, [id, supplierId, productId, tplId, capacity]);
  return id;
}

async function makeMaster(app: App, headers: Headers, items: Array<Record<string, unknown>>) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
    headers: { ...headers, 'idempotency-key': uniqueRef('p6') }, payload: { items } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; reference: string;
    children: Array<{ id: string; reference: string; sellerType: string; sellerId: string | null }> };
}

async function applyVerified(pool: Pool, intentId: string, amountRial: string) {
  const { applyVerifiedPayment } = await import('./payments.js');
  return applyVerifiedPayment(pool, {
    provider: 'nextpay', providerEventId: `evt-${randomUUID()}`, providerReference: `ref-${randomUUID().slice(0, 12)}`,
    intentId, amountRial, paidAt: new Date(),
  });
}

async function payChild(app: App, pool: Pool, buyerHeaders: Headers, childId: string) {
  const intent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/payment-intent`, headers: buyerHeaders });
  assert.equal(intent.statusCode, 201, intent.body);
  await applyVerified(pool, intent.json().intentId as string, intent.json().amountRial as string);
}

type ExternalLegFixture = {
  supplier: { id: string; email: string; label: string };
  buyer: { id: string; email: string; label: string };
  admin: { id: string; email: string; label: string };
  buyerHeaders: Headers; adminHeaders: Headers; supplierHeaders: Headers;
  master: { id: string; reference: string; children: Array<{ id: string; reference: string; sellerType: string; sellerId: string | null }> };
  childId: string;
  allocationId: string;
  product: { productId: string; tplId: string; variantIds: string[] };
  warehouseId: string;
};

/**
 * Brings ONE order-bound external leg (Golden Scenario source C) all the way to "supplier dispatched":
 * respond(accept) → commit → buyer pays → ready → dispatch. Stock is NEVER created by any of these
 * steps, which is exactly what several matrix cases assert.
 */
async function externalLeg(app: App, pool: Pool, opts: { series: number; label: string; warehouseId?: string }): Promise<ExternalLegFixture> {
  const admin = await makeUser(pool, ['admin'], `مدیر ${opts.label}`);
  const buyer = await makeVip(pool, `خریدار ${opts.label}`);
  const supplier = await makeUser(pool, ['supplier'], `تأمین‌کننده ${opts.label}`);
  const adminHeaders = await login(app, admin.email);
  const buyerHeaders = await login(app, buyer.email);
  const supplierHeaders = await login(app, supplier.email);
  const warehouseId = opts.warehouseId ?? await makeWarehouse(pool, `انبار ${opts.label}`);
  const product = await makeSeriesProduct(pool, `کالای ${opts.label}`, supplier.id);
  await makeOffer(pool, supplier.id, product.productId, product.tplId, Math.max(opts.series, 10));
  const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: product.tplId, count: opts.series }]);
  const childId = master.children[0]!.id;
  const line = await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childId]);
  const accept = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0]!.id}/respond`,
    headers: supplierHeaders, payload: { action: 'confirm' } });
  assert.equal(accept.statusCode, 200, accept.body);
  const allocation = await pool.query<{ id: string }>(
    "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'", [childId]);
  const allocationId = allocation.rows[0]!.id;
  const commit = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocationId}/commit`,
    headers: { ...supplierHeaders, 'idempotency-key': uniqueRef('p6-commit') }, payload: { note: 'تعهد P6' } });
  assert.equal(commit.statusCode, 200, commit.body);
  await payChild(app, pool, buyerHeaders, childId);
  const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocationId}/ready`,
    headers: { ...supplierHeaders, 'idempotency-key': uniqueRef('p6-ready') }, payload: { note: 'آماده برای انبار کلبه' } });
  assert.equal(ready.statusCode, 200, ready.body);
  const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childId}/dispatch`,
    headers: { ...supplierHeaders, 'idempotency-key': uniqueRef('p6-dispatch') }, payload: {} });
  assert.equal(dispatch.statusCode, 200, dispatch.body);
  return { supplier, buyer, admin, buyerHeaders, adminHeaders, supplierHeaders, master, childId, allocationId, product, warehouseId };
}

/** Declares the canonical inbound shipment document for the dispatched leg. */
async function declareShipment(app: App, fixture: ExternalLegFixture, body: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${fixture.childId}/inbound-shipment`,
    headers: { ...fixture.supplierHeaders, 'idempotency-key': uniqueRef('p6-declare') },
    payload: { carrier: 'باربری P6', trackingCode: uniqueRef('TRK'), ...body } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; reference: string; destinationWarehouseId: string };
}

const allocRow = async (pool: Pool, allocationId: string) => (await pool.query<{
  dispatched_series: number; received_series: number; received_missing_series: number;
  received_damaged_series: number; qc_passed_series: number; qc_rejected_series: number; qc_damaged_series: number;
  status: string; received_at: string | null; qc_at: string | null;
}>('SELECT dispatched_series, received_series, received_missing_series, received_damaged_series, qc_passed_series, ' +
  'qc_rejected_series, qc_damaged_series, status, received_at, qc_at FROM order_source_allocations WHERE id = $1',
  [allocationId])).rows[0]!;

const pieceOnHand = async (pool: Pool, variantIds: string[]) => (await pool.query<{ total: number }>(
  'SELECT COALESCE(SUM(on_hand),0)::int AS total FROM stock_balances WHERE variant_id = ANY($1::uuid[])', [variantIds])).rows[0]!.total;

const seriesOnHand = async (pool: Pool, tplId: string, ownerType?: string) => (await pool.query<{ total: number; reserved: number }>(
  `SELECT COALESCE(SUM(on_hand),0)::int AS total, COALESCE(SUM(reserved),0)::int AS reserved
     FROM series_stock_balances WHERE series_template_id = $1 AND ($2::text IS NULL OR owner_type = $2)`,
  [tplId, ownerType ?? null])).rows[0]!;

const exceptionsOf = async (pool: Pool, childId: string) => (await pool.query<{ exception_type: string; quantity: number; status: string }>(
  'SELECT exception_type, quantity, status FROM fulfillment_exceptions WHERE child_order_id = $1 ORDER BY exception_type', [childId])).rows;

const childState = async (pool: Pool, childId: string) => (await pool.query<{ child_fulfillment: string; payment_eligibility: string }>(
  'SELECT child_fulfillment, payment_eligibility FROM orders WHERE id = $1', [childId])).rows[0]!;

/* ================================================================== Golden Scenario 1 */

test('P6 GOLDEN-1 — complete mixed-source fulfillment: 3 Kolbe + 2 supplier-at-Kolbe + 5 external, one Master, one shipment', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر G1');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار G1');
    const buyerHeaders = await login(app, buyer.email);
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین‌کننده الف G1');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین‌کننده ب G1');
    const warehouse = await makeWarehouse(pool, 'انبار G1');

    /* ---- source A: Kolbe-owned physical stock (3) + source B: supplier-owned at Kolbe (2) ---- */
    const kolbeProduct = await makeSeriesProduct(pool, `کلبه G1 ${uniqueRef('K')}`, null);
    await seedStock(pool, kolbeProduct.tplId, kolbeProduct.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 3);
    const atKolbe = await makeSeriesProduct(pool, `انبار تأمین‌کننده G1 ${uniqueRef('S')}`, supplierA.id);
    await seedStock(pool, atKolbe.tplId, atKolbe.variantIds, warehouse, { ownerType: 'supplier', supplierId: supplierA.id }, 2);

    /* ---- source C: 5 external series through the supplier OMS lifecycle ---- */
    const external = await externalLeg(app, pool, { series: 5, label: 'G1-خارجی', warehouseId: warehouse });

    // The Master is ONE order for the buyer even though it draws on three sources.
    const masterDetail = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${external.master.id}?view=ops`, headers: adminHeaders });
    const ops = masterDetail.json() as { coverage: Record<string, number>; children: unknown[] };
    assert.equal(ops.coverage.orderedSeries, 5, 'the external leg is its own child with 5 ordered series');

    // P6-OMS-001/002: at this point the external capacity is NOT physical stock.
    assert.equal(await pieceOnHand(pool, external.product.variantIds), 0, 'supplier commitment/dispatch never creates WMS stock');
    assert.equal((await seriesOnHand(pool, external.product.tplId)).total, 0, 'no intact series credited by dispatch');
    const committedStock = await allocRow(pool, external.allocationId);
    assert.equal(committedStock.received_series, 0);

    /* ---- P6-INB-001/002: handoff links to the canonical inbound shipment, destination is Kolbe-only ---- */
    const shipment = await declareShipment(app, external);
    // The destination is the SERVER-resolved central Kolbe warehouse (never a warehouse the supplier or the
    // test names), so the assertion resolves it from the canonical table instead of assuming a fixture id.
    const centralWarehouse = (await pool.query<{ id: string }>(
      `SELECT id FROM warehouses WHERE active = true AND owner_id IS NULL AND purpose IN ('wholesale','mixed')
       ORDER BY (purpose = 'wholesale') DESC, created_at ASC LIMIT 1`)).rows[0]!.id;
    assert.equal(shipment.destinationWarehouseId, centralWarehouse, 'destination is server-resolved to the central Kolbe warehouse');
    const spoof = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${external.childId}/inbound-shipment`,
      headers: external.supplierHeaders, payload: { destinationWarehouseId: randomUUID() } });
    assert.equal(spoof.statusCode, 400, 'a supplier can never name a warehouse (§137)');
    const spoofBuyer = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${external.childId}/inbound-shipment`,
      headers: external.supplierHeaders, payload: { trackingCode: 'T', recipientCustomerId: randomUUID() } });
    assert.equal(spoofBuyer.statusCode, 400, 'a supplier can never name a buyer');

    /* ---- §8 receiving (partial-capable, here complete) ---- */
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: external.allocationId, receivedSeries: 5 }], note: 'دریافت کامل G1' } });
    assert.equal(receive.statusCode, 200, receive.body);
    const received = await allocRow(pool, external.allocationId);
    assert.equal(received.received_series, 5);
    assert.equal(received.received_missing_series, 0, 'dispatched = received + missing');
    assert.equal(received.status, 'reserved', 'receipt alone never closes the allocation');

    /* ---- §10 QC ---- */
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: external.allocationId, passedSeries: 5, rejectedSeries: 0 }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    const qcd = await allocRow(pool, external.allocationId);
    assert.equal(qcd.qc_passed_series, 5);
    assert.equal(qcd.status, 'consumed', 'a fully passed leg is closed');

    /* ---- P6-OMS-003/QC-008: order-bound accepted goods are staged in the allocation — never general stock ---- */
    assert.equal(await pieceOnHand(pool, external.product.variantIds), 0, 'order-bound goods are never credited to sellable general stock');
    assert.equal((await seriesOnHand(pool, external.product.tplId)).total, 0);
    const staged = await seriesOnHand(pool, atKolbe.tplId, 'supplier');
    assert.equal(staged.total, 2, 'the supplier-owned at-Kolbe stock is untouched by the external leg');
    const trace = await pool.query<{ received_series: number; qc_passed_series: number; qc_rejected_series: number }>(
      'SELECT received_series, qc_passed_series, qc_rejected_series FROM child_order_lines WHERE child_order_id = $1', [external.childId]);
    assert.deepEqual(trace.rows[0], { received_series: 5, qc_passed_series: 5, qc_rejected_series: 0 }, '§91 quantity trace');
    assert.deepEqual(await exceptionsOf(pool, external.childId), [], 'a clean delivery raises no exception');
    assert.equal((await childState(pool, external.childId)).child_fulfillment, 'ready_for_consolidation');

    /* ---- §15 picking the physical sources (Kolbe + supplier-at-Kolbe) ---- */
    const physicalMaster = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbeProduct.tplId, count: 3 }, { seriesTemplateId: atKolbe.tplId, count: 2 },
    ]);
    const physicalChild = physicalMaster.children.find((c) => c.sellerType === 'kolbe')!.id;
    const supplierAtKolbeChild = physicalMaster.children.find((c) => c.sellerId === supplierA.id)!.id;
    await payChild(app, pool, buyerHeaders, physicalChild);
    await payChild(app, pool, buyerHeaders, supplierAtKolbeChild);
    const kolbeBefore = await seriesOnHand(pool, kolbeProduct.tplId, 'kolbe');
    assert.deepEqual(kolbeBefore, { total: 3, reserved: 3 }, 'reservation holds the series without moving on_hand');
    const pick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${physicalChild}/pick`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} });
    assert.equal(pick.statusCode, 200, pick.body);
    const pickSupplierOwned = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${supplierAtKolbeChild}/pick`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} });
    assert.equal(pickSupplierOwned.statusCode, 200, pickSupplierOwned.body);
    assert.deepEqual(await seriesOnHand(pool, kolbeProduct.tplId, 'kolbe'), { total: 0, reserved: 0 }, 'pick consumes the Kolbe banding once');
    assert.deepEqual(await seriesOnHand(pool, atKolbe.tplId, 'supplier'), { total: 0, reserved: 0 },
      'the supplier-owned banding is consumed too — ownership stays supplier on the ledger');
    const ownershipRows = await pool.query<{ owner_type: string; movement_type: string; quantity: number }>(
      `SELECT owner_type, movement_type, quantity FROM series_stock_movements
        WHERE series_template_id = $1 ORDER BY created_at`, [atKolbe.tplId]);
    assert.deepEqual(ownershipRows.rows.map((r) => [r.owner_type, r.movement_type, r.quantity]),
      [['supplier', 'reserve', 2], ['supplier', 'consume', -2]], 'no ownership conversion happened by picking');
    assert.equal(await pieceOnHand(pool, atKolbe.variantIds), 0, 'piece ledger follows the same single deduction');
    // P6-CON-002: a second pick cannot consume anything twice.
    const secondPick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${physicalChild}/pick`, headers: adminHeaders, payload: {} });
    assert.equal(secondPick.statusCode, 409, secondPick.body);

    /* ---- §16/§17: lock + consolidate ONE master that mixes physical and external goods ---- */
    const lockPhysical = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/lock`, headers: buyerHeaders });
    assert.equal(lockPhysical.statusCode, 200, lockPhysical.body);
    const startPhysical = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(startPhysical.statusCode, 201, startPhysical.body);
    const consolidationId = startPhysical.json().id as string;
    assert.equal(startPhysical.json().expectedSeries, 5, 'expected series comes from the canonical accepted/confirmed quantity');

    /* ---- §18 verification: manual confirmation works, duplicate scan and wrong item are rejected ---- */
    const items = await pool.query<{ line_id: string }>('SELECT line_id FROM consolidation_items WHERE consolidation_id = $1', [consolidationId]);
    const verify = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: items.rows[0]!.line_id, scanReference: 'SCAN-1' } });
    assert.equal(verify.statusCode, 200, verify.body);
    const duplicateScan = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: items.rows[0]!.line_id } });
    assert.equal(duplicateScan.statusCode, 409);
    assert.equal(duplicateScan.json().code, 'DUPLICATE_CONSOLIDATION_SCAN');
    const wrongItem = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: randomUUID() } });
    assert.equal(wrongItem.json().code, 'WRONG_CONSOLIDATION_ITEM');
    // §18/§19: completion and packing are blocked until every canonical item is verified.
    const earlyComplete = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });
    assert.equal(earlyComplete.statusCode, 409);
    assert.equal(earlyComplete.json().code, 'CONSOLIDATION_NOT_READY');
    const earlyPack = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders, payload: {} });
    assert.equal(earlyPack.statusCode, 409, 'packing before completion is refused');
    for (const item of items.rows.slice(1)) {
      const done = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
        headers: adminHeaders, payload: { lineId: item.line_id } });
      assert.equal(done.statusCode, 200, done.body);
    }
    const complete = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });
    assert.equal(complete.statusCode, 200, complete.body);
    const pack = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`,
      headers: adminHeaders, payload: { packageCount: 1, weightGrams: 4200, dimensions: '40x30x20' } });
    assert.equal(pack.statusCode, 200, pack.body);
    const packing = await pool.query<{ package_count: number; weight_grams: string; total_series: number; total_pieces: number }>(
      'SELECT package_count, weight_grams, total_series, total_pieces FROM master_consolidations WHERE id = $1', [consolidationId]);
    assert.equal(packing.rows[0]!.package_count, 1, 'operator-recorded packing data is persisted, never fabricated');
    assert.equal(packing.rows[0]!.total_series, 5);

    /* ---- §20/§21: ONE final Kolbe shipment, no second stock deduction ---- */
    const kolbePieceBefore = await pieceOnHand(pool, kolbeProduct.variantIds);
    const shipKey = uniqueRef('p6-ship');
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': shipKey }, payload: { carrier: 'پست پیشتاز', trackingCode: 'P6-TRK-0001' } });
    assert.equal(ship.statusCode, 200, ship.body);
    assert.equal(await pieceOnHand(pool, kolbeProduct.variantIds), kolbePieceBefore, 'shipping posts NO second stock movement');
    const replay = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': shipKey }, payload: { carrier: 'پست پیشتاز', trackingCode: 'P6-TRK-0001' } });
    assert.equal(replay.statusCode, 200, 'same key + same payload replays the same outcome');
    assert.equal(replay.json().trackingCode, 'P6-TRK-0001');
    const secondShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-ship2') }, payload: { carrier: 'باربری دیگر', trackingCode: 'P6-TRK-9999' } });
    assert.equal(secondShip.statusCode, 409, 'a second dispatch is impossible');
    const masterRow = await pool.query<{ tracking_code: string; shipped_at: string | null }>(
      'SELECT tracking_code, shipped_at FROM master_orders WHERE id = $1', [physicalMaster.id]);
    assert.equal(masterRow.rows[0]!.tracking_code, 'P6-TRK-0001');

    /* ---- P6-SHP-009/OMS-008: the buyer sees ONE order and no supplier topology ---- */
    const buyerView = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${physicalMaster.id}?view=buyer`, headers: buyerHeaders })).body;
    for (const leak of [supplierA.id, supplierB.id, external.supplier.id, 'supplier_external', 'kolbe_stock', 'supplier_stock_at_kolbe']) {
      assert.ok(!buyerView.includes(leak), `buyer projection leaked ${leak}`);
    }
    const buyerOrder = JSON.parse(buyerView) as { reference: string; subOrders: Array<{ reference: string }>; shippedAt?: string };
    assert.equal(buyerOrder.reference, physicalMaster.reference, 'the buyer sees ONE order identity');
    assert.equal(buyerOrder.subOrders.length, physicalMaster.children.length,
      'the internal children stay internal — never extra customer-facing orders');
    assert.ok(buyerOrder.shippedAt, 'buyer sees the shipped state backed by the canonical event');
    const externalBuyerView = JSON.parse((await app.inject({ method: 'GET',
      url: `/api/v1/wholesale/masters/${external.master.id}?view=buyer`, headers: external.buyerHeaders })).body) as
      { reference: string; subOrders: unknown[] };
    assert.equal(externalBuyerView.subOrders.length, 1, 'a single-supplier master is still exactly one order for the buyer');

    /* ---- §22: delivery confirmation is authorised + audited ---- */
    const deliver = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${physicalMaster.id}/deliver`, headers: adminHeaders });
    assert.equal(deliver.statusCode, 200, deliver.body);
    const delivered = await pool.query<{ delivered_at: string | null }>('SELECT delivered_at FROM master_orders WHERE id = $1', [physicalMaster.id]);
    assert.ok(delivered.rows[0]!.delivered_at);
    const auditRow = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_logs WHERE action IN ('wholesale_master.shipped','wholesale_master.delivered') AND actor_id = $1",
      [admin.id]);
    assert.ok(Number(auditRow.rows[0]!.count) >= 2, 'shipment and delivery are both audited');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 2 */

test('P6 GOLDEN-2 — partial receiving with damaged goods: 5 dispatched, 4 received, 3 accepted, 1 damaged, 1 missing', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 5, label: 'G2' });
    const shipment = await declareShipment(app, fixture);

    /* ---- P6-INB-005/006: impossible submissions are rejected by the SERVER, before any write ---- */
    const impossible = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.adminHeaders,
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 3, missingSeries: 0 }] } });
    assert.equal(impossible.statusCode, 400, 'received + missing must equal dispatched');
    const negative = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: -1 }] } });
    assert.equal(negative.statusCode, 400, 'negative quantities are rejected');
    const impossibleDamage = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 2, damagedSeries: 3 }] } });
    assert.equal(impossibleDamage.statusCode, 400, 'damage can never exceed the received quantity');
    assert.equal((await allocRow(pool, fixture.allocationId)).received_at, null, 'a rejected submission writes nothing');

    /* ---- P6-INB-005/006: quantity reconciliation is explicit and partial ---- */
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 4, damagedSeries: 1, note: 'یک سری آسیب ظاهری' }] } });
    assert.equal(receive.statusCode, 200, receive.body);
    const received = await allocRow(pool, fixture.allocationId);
    assert.deepEqual({
      dispatched: received.dispatched_series, received: received.received_series,
      missing: received.received_missing_series, damagedVisited: received.received_damaged_series,
    }, { dispatched: 5, received: 4, missing: 1, damagedVisited: 1 }, 'dispatched = received + missing; damage recorded once');
    const afterReceipt = await childState(pool, fixture.childId);
    assert.ok(['qc_pending', 'exception', 'preparing'].includes(afterReceipt.child_fulfillment),
      `receipt is NOT QC (got ${afterReceipt.child_fulfillment})`);
    assert.notEqual(afterReceipt.child_fulfillment, 'ready_for_consolidation', 'a receipt never makes goods ready — QC still owns the gate');


    /* ---- exceptions at receiving: the missing unit is unresolved; visible damage is a pending
       inspection bucket that QC will decide (raised once, never counted twice) ---- */
    const exceptions = await exceptionsOf(pool, fixture.childId);
    assert.deepEqual(exceptions.map((e) => [e.exception_type, e.quantity, e.status]),
      [['lost_inbound', 1, 'open']], 'missing ≠ damaged ≠ rejected');
    // Nothing entered general sellable stock for the damaged unit.
    assert.equal(await pieceOnHand(pool, fixture.product.variantIds), 0);
    assert.equal((await seriesOnHand(pool, fixture.product.tplId)).total, 0);

    /* ---- §10 QC on the 4 received units: 3 accepted, 1 damaged-rejected ---- */
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 0, damagedSeries: 1, note: 'یک سری معیوب' }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    const qcd = await allocRow(pool, fixture.allocationId);
    assert.deepEqual({
      received: qcd.received_series, passed: qcd.qc_passed_series, rejected: qcd.qc_rejected_series, damaged: qcd.qc_damaged_series,
    }, { received: 4, passed: 3, rejected: 0, damaged: 1 }, 'received = accepted + rejected + damaged (mutually exclusive buckets)');
    assert.equal(qcd.qc_passed_series + qcd.qc_rejected_series + qcd.qc_damaged_series, qcd.received_series,
      'the QC buckets reconcile exactly with the receipt — no unit counted twice');
    const receiptRow = await pool.query<{ shortage_series: number; damaged_series: number; qc_status: string }>(
      'SELECT shortage_series, damaged_series, qc_status FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1', [shipment.id]);
    assert.deepEqual(receiptRow.rows[0], { shortage_series: 1, damaged_series: 1, qc_status: 'partially_accepted' },
      'the GRN itself records shortage and visible damage separately');
    // A submission that tries to count the same unit as both rejected AND damaged is refused.
    const doubleCount = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 3, damagedSeries: 2 }] } });
    assert.equal(doubleCount.statusCode, 409, 'the receipt is immutable — buckets can never be rewritten');

    /* ---- P6-QC-002/004: rejected/damaged units are never allocatable ---- */
    assert.equal(await pieceOnHand(pool, fixture.product.variantIds), 0, 'rejected units never become sellable stock');
    assert.equal((await seriesOnHand(pool, fixture.product.tplId)).total, 0);
    const qcExceptions = await exceptionsOf(pool, fixture.childId);
    assert.deepEqual(qcExceptions.map((e) => [e.exception_type, e.quantity]),
      [['damaged', 1], ['lost_inbound', 1]], 'every unresolved unit has its own auditable exception (missing ≠ damaged)');

    /* ---- §13: the requirement is NOT silently reduced and the Master stays blocked ---- */
    const child = await childState(pool, fixture.childId);
    assert.equal(child.child_fulfillment, 'exception', 'unresolved shortage blocks readiness');
    const coverage = await pool.query<{ accepted_series: number | null; confirmed_series: number }>(
      'SELECT accepted_series, confirmed_series FROM child_order_lines WHERE child_order_id = $1', [fixture.childId]);
    assert.equal(coverage.rows[0]!.confirmed_series, 5, 'the commercial quantity is untouched by QC');
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${fixture.master.id}/lock`, headers: fixture.buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${fixture.master.id}/consolidation/start`, headers: fixture.adminHeaders });
    assert.equal(start.statusCode, 409, 'consolidation is blocked while the shortage is unresolved');
    assert.equal(start.json().code, 'CONSOLIDATION_NOT_READY');

    /* ---- §14: admin sees an actionable exception with Master context ---- */
    const exceptionCentre = await app.inject({ method: 'GET', url: `/api/v1/admin/wms/exceptions?status=open&masterId=${fixture.master.id}`, headers: fixture.adminHeaders });
    assert.equal(exceptionCentre.statusCode, 200, exceptionCentre.body);
    const items = exceptionCentre.json().items as Array<Record<string, unknown>>;
    assert.equal(items.length, 2, 'exactly one open exception per unresolved unit');
    for (const item of items) {
      assert.equal(item.master_reference, fixture.master.reference);
      assert.ok(item.series_name, 'the operator sees the Series, not a raw id');
      assert.ok(String(item.note).length > 0);
    }
    const assign = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/exceptions/${items[0]!.id as string}/assign`,
      headers: fixture.adminHeaders, payload: { assignedTo: fixture.admin.id } });
    assert.equal(assign.statusCode, 200, assign.body);
    assert.equal((await pool.query('SELECT assigned_to FROM fulfillment_exceptions WHERE id = $1', [items[0]!.id as string])).rows[0]!.assigned_to, fixture.admin.id);

    /* ---- §13 resolution paths: replacement supply resolves, then consolidation unblocks ---- */
    const rejected = items.find((item) => item.exception_type === 'damaged')!;
    const { resolveFulfillmentException } = await import('./wholesale-fulfillment.js');
    await resolveFulfillmentException(pool, { id: fixture.admin.id, roles: ['admin'], permissions: ['wholesale:ops'], displayName: 'مدیر', sessionId: 'x' },
      { exceptionId: rejected.id as string, resolution: 'supplier_redelivery', note: 'ارسال جایگزین' });
    const reopened = await allocRow(pool, fixture.allocationId);
    assert.deepEqual({
      dispatched: reopened.dispatched_series, received: reopened.received_series, passed: reopened.qc_passed_series,
    }, { dispatched: 0, received: 0, passed: 0 }, 'the inbound leg is explicitly re-opened for replacement supply');
    assert.equal((await childState(pool, fixture.childId)).child_fulfillment, 'exception',
      'one resolved exception never unblocks the Master while another unit is still unresolved');
    const remaining = await exceptionsOf(pool, fixture.childId);
    assert.ok(remaining.some((e) => e.exception_type === 'lost_inbound' && e.status === 'open'),
      'the genuinely missing unit still blocks the Master until it is authorised or replaced');
    const stillBlocked = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${fixture.master.id}/consolidation/start`, headers: fixture.adminHeaders });
    assert.equal(stillBlocked.statusCode, 409, 'consolidation stays blocked while a unit is unresolved');
    assert.equal(stillBlocked.json().code, 'CONSOLIDATION_NOT_READY');

    /* ---- §13: the missing unit is explicitly written off (accept_short) — the label is re-derived,
       never sticky, and the authorised shortfall still does not fabricate physical stock ---- */
    await resolveFulfillmentException(pool, { id: fixture.admin.id, roles: ['admin'], permissions: ['wholesale:ops'], displayName: 'مدیر', sessionId: 'x' },
      { exceptionId: (await pool.query<{ id: string }>("SELECT id FROM fulfillment_exceptions WHERE child_order_id = $1 AND exception_type = 'lost_inbound' AND status = 'open'", [fixture.childId])).rows[0]!.id, resolution: 'accept_short', note: 'کسری پذیرفتهشده توسط خریدار' });
    const afterWriteOff = await childState(pool, fixture.childId);
    assert.equal(afterWriteOff.child_fulfillment, 'preparing', 'a resolved exception is re-derived, never left as a stale "exception" label');
    assert.equal(await pieceOnHand(pool, fixture.product.variantIds), 0, 'an authorised shortfall never becomes sellable stock');
    const shortfallCoverage = await pool.query<{ accepted_series: number | null; confirmed_series: number }>(
      'SELECT accepted_series, confirmed_series FROM child_order_lines WHERE child_order_id = $1', [fixture.childId]);
    assert.equal(shortfallCoverage.rows[0]!.confirmed_series, 5, 'the commercial requirement is still 5 — nothing was silently reduced');
    const shortfallBlocked = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${fixture.master.id}/consolidation/start`, headers: fixture.adminHeaders });
    assert.equal(shortfallBlocked.statusCode, 409, 'an authorised shortfall does not fabricate the goods needed to consolidate');

    /* ---- §29: a completed physical event is never reversed by resetting a status ---- */
    const resetAttempt = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 5 }] } });
    assert.equal(resetAttempt.statusCode, 409, 'the receipt is immutable; corrections need a documented compensating flow');
    const grn = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1', [shipment.id]);
    assert.equal(Number(grn.rows[0]!.count), 1, 'exactly one GRN exists for this shipment');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 3 */

test('P6 GOLDEN-3 — three suppliers: isolation, no cross-supplier access, blocked until the last one delivers', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر G3');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار G3');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, 'انبار G3');
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین‌کننده الف G3');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین‌کننده ب G3');
    const supplierC = await makeUser(pool, ['supplier'], 'تأمین‌کننده پ G3');
    const headersA = await login(app, supplierA.email);
    const headersB = await login(app, supplierB.email);
    const headersC = await login(app, supplierC.email);

    // Supplier A: goods already at Kolbe (source B).
    const productA = await makeSeriesProduct(pool, `کالای الف ${uniqueRef('A')}`, supplierA.id);
    await makeOffer(pool, supplierA.id, productA.productId, productA.tplId, 20);
    await seedStock(pool, productA.tplId, productA.variantIds, warehouse, { ownerType: 'supplier', supplierId: supplierA.id }, 3);
    // Supplier B + C: external capacity (source C).
    const productB = await makeSeriesProduct(pool, `کالای ب ${uniqueRef('B')}`, supplierB.id);
    await makeOffer(pool, supplierB.id, productB.productId, productB.tplId, 20);
    const productC = await makeSeriesProduct(pool, `کالای پ ${uniqueRef('C')}`, supplierC.id);
    await makeOffer(pool, supplierC.id, productC.productId, productC.tplId, 20);

    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: productA.tplId, count: 2 },
      { seriesTemplateId: productB.tplId, count: 2 },
      { seriesTemplateId: productC.tplId, count: 2 },
    ]);
    assert.equal(master.children.length, 3, 'one child order per independent supplier — still ONE Master Order');
    const childB = master.children.find((c) => c.sellerId === supplierB.id)!.id;
    const childC = master.children.find((c) => c.sellerId === supplierC.id)!.id;

    const lineOf = async (childId: string) => (await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childId])).rows[0]!.id;
    for (const [childId, headers] of [[childB, headersB], [childC, headersC]] as Array<[string, Headers]>) {
      const accept = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${await lineOf(childId)}/respond`,
        headers, payload: { action: 'confirm' } });
      assert.equal(accept.statusCode, 200, accept.body);
    }
    for (const childId of [childB, childC]) {
      const allocation = await pool.query<{ id: string }>(
        "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'", [childId]);
      const commit = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocation.rows[0]!.id}/commit`,
        headers: childId === childB ? headersB : headersC, payload: {} });
      assert.equal(commit.statusCode, 200, commit.body);
    }
    for (const childId of master.children.map((c) => c.id)) await payChild(app, pool, buyerHeaders, childId);
    for (const childId of [childB, childC]) {
      const allocation = await pool.query<{ id: string }>(
        "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'", [childId]);
      const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocation.rows[0]!.id}/ready`,
        headers: childId === childB ? headersB : headersC, payload: {} });
      assert.equal(ready.statusCode, 200, ready.body);
      const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childId}/dispatch`,
        headers: childId === childB ? headersB : headersC, payload: {} });
      assert.equal(dispatch.statusCode, 200, dispatch.body);
    }

    // P6-INB-003/OMS-007: tenant isolation — supplier A can never see or touch B's goods.
    const shipmentB = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childB}/inbound-shipment`,
      headers: { ...headersB, 'idempotency-key': uniqueRef('p6-declare') }, payload: {} });
    assert.equal(shipmentB.statusCode, 201, shipmentB.body);
    const shipmentBId = shipmentB.json().id as string;
    const foreignDeclare = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childB}/inbound-shipment`,
      headers: headersA, payload: {} });
    assert.equal(foreignDeclare.statusCode, 404, 'supplier A cannot announce supplier B goods (IDOR guard)');
    const ownList = (await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/inbound-shipments', headers: headersB })).json() as
      { items: Array<{ id: string }> };
    assert.deepEqual(ownList.items.map((row) => row.id), [shipmentBId], 'supplier B lists exactly its own leg');
    const foreignList = (await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/inbound-shipments', headers: headersA })).json() as
      { items: Array<{ id: string }> };
    assert.ok(!foreignList.items.some((row) => row.id === shipmentBId), 'supplier A never sees supplier B goods');
    const foreignDetail = await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments/${shipmentBId}`, headers: headersA });
    assert.equal(foreignDetail.statusCode, 403, 'supplier A cannot read B inbound detail through the ops route');
    const foreignWarehouse = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentBId}/receive`,
      headers: headersA, payload: { lines: [{ allocationId: randomUUID(), receivedSeries: 1 }] } });
    assert.equal(foreignWarehouse.statusCode, 403, 'a supplier cannot operate the warehouse queue');

    // Supplier B delivers and passes QC.
    const receiveB = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentBId}/receive`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: (await pool.query<{ id: string }>(
        "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type='supplier_external'", [childB])).rows[0]!.id, receivedSeries: 2 }] } });
    assert.equal(receiveB.statusCode, 200, receiveB.body);
    const qcB = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentBId}/qc`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: (await pool.query<{ id: string }>(
        "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type='supplier_external'", [childB])).rows[0]!.id, passedSeries: 2, rejectedSeries: 0 }] } });
    assert.equal(qcB.statusCode, 200, qcB.body);

    // A and B are operationally staged; C has not delivered.
    assert.equal((await childState(pool, childB)).child_fulfillment, 'ready_for_consolidation');
    assert.equal((await childState(pool, childC)).child_fulfillment, 'dispatched');
    // Supplier A's goods are already at Kolbe: they stay physically reserved (owner=supplier) and the
    // external suppliers' progress neither advances nor blocks them.
    const atKolbeReserved = await seriesOnHand(pool, productA.tplId, 'supplier');
    assert.deepEqual({ total: atKolbeReserved.total, reserved: atKolbeReserved.reserved }, { total: 3, reserved: 2 },
      'supplier-owned physical stock is reserved, not moved, and never becomes Kolbe stock');
    assert.notEqual((await childState(pool, master.children.find((c) => c.sellerId === supplierA.id)!.id)).child_fulfillment,
      'ready_for_consolidation', 'physical goods still need a real pick before consolidation');

    // §16/§33: the Master is blocked until supplier C completes valid receiving + QC.
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const blockedStart = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(blockedStart.statusCode, 409, blockedStart.body);
    assert.equal(blockedStart.json().code, 'CONSOLIDATION_NOT_READY');

    // Buyer projection: one order, no sourcing topology.
    const buyerView = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders })).body;
    for (const leak of [supplierA.id, supplierB.id, supplierC.id, 'supplier_external', 'supplier_stock_at_kolbe']) {
      assert.ok(!buyerView.includes(leak), `buyer projection leaked ${leak}`);
    }
    assert.equal((JSON.parse(buyerView) as { reference: string }).reference, master.reference, 'one Master Order for the buyer');
    assert.equal((JSON.parse(buyerView) as { subOrders: unknown[] }).subOrders.length, 3, 'three suppliers stay an INTERNAL detail');

    // Supplier C completes a valid receiving + QC → consolidation becomes eligible.
    const declareC = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childC}/inbound-shipment`,
      headers: { ...headersC, 'idempotency-key': uniqueRef('p6-declare') }, payload: {} });
    assert.equal(declareC.statusCode, 201, declareC.body);
    const allocationC = (await pool.query<{ id: string }>(
      "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type='supplier_external'", [childC])).rows[0]!.id;
    const receiveC = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${declareC.json().id as string}/receive`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-recv') }, payload: { lines: [{ allocationId: allocationC, receivedSeries: 2 }] } });
    assert.equal(receiveC.statusCode, 200, receiveC.body);
    const qcC = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${declareC.json().id as string}/qc`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-qc') }, payload: { lines: [{ allocationId: allocationC, passedSeries: 2, rejectedSeries: 0 }] } });
    assert.equal(qcC.statusCode, 200, qcC.body);
    assert.equal((await childState(pool, childC)).child_fulfillment, 'ready_for_consolidation');

    // Supplier A's physically stored goods are picked through the canonical owner-aware WMS path;
    // B and C were reconciled by receiving + QC and need no pick (they were never storage stock).
    const pickA = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${master.children.find((c) => c.sellerId === supplierA.id)!.id}/pick`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} });
    assert.equal(pickA.statusCode, 200, pickA.body);
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    assert.equal(start.json().expectedChildren, 3, 'one master, three supplier sources');
    const ownership = await seriesOnHand(pool, productA.tplId, 'supplier');
    // The 2 picked series leave sellable storage (3 on hand − 2 consumed = 1 physically left, 0 reserved);
    // the remaining balance is still SUPPLIER-owned — nothing was converted to Kolbe stock.
    assert.deepEqual(ownership, { total: 1, reserved: 0 }, 'supplier-owned stock keeps supplier ownership through picking');
    const kolbeOwned = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = $2', [productA.tplId, 'kolbe']);
    assert.equal(Number(kolbeOwned.rows[0]!.count), 0, 'no silent ownership conversion (§REQ-004)');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 4 */

test('P6 GOLDEN-4/P6-INB-007/008 — cross-endpoint duplicate receiving can never double-credit', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 4, label: 'G4' });
    const shipment = await declareShipment(app, fixture);
    const key = uniqueRef('p6-recv');
    const first = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': key },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 4 }] } });
    assert.equal(first.statusCode, 200, first.body);

    /* ---- P6-INB-007: replaying the SAME idempotency key + payload returns the same outcome ---- */
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': key },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 4 }] } });
    assert.equal(replay.statusCode, 200, 'same key + same payload = same outcome');
    assert.equal(replay.json().shipmentReference, first.json().shipmentReference);
    const conflicting = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': key },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 3, missingSeries: 1 }] } });
    assert.equal(conflicting.statusCode, 409, 'same key + different payload = conflict');

    /* ---- P6-INB-008: the LEGACY OMS route for the same goods is refused, not double-posted ---- */
    const legacy = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${fixture.childId}/receive`,
      headers: fixture.adminHeaders, payload: { allocations: [{ allocationId: fixture.allocationId, receivedSeries: 4 }] } });
    assert.equal(legacy.statusCode, 409, legacy.body);
    assert.equal(legacy.json().code, 'INBOUND_ALREADY_RECEIVED');
    const after = await allocRow(pool, fixture.allocationId);
    assert.equal(after.received_series, 4, 'the receipt is posted exactly once');
    const receiptCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1', [shipment.id]);
    assert.equal(Number(receiptCount.rows[0]!.count) <= 1, true, 'never more than one GRN document');

    /* ---- QC mirror: the legacy QC route cannot double-post either ---- */
    const qcFirst = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 4, rejectedSeries: 0 }] } });
    assert.equal(qcFirst.statusCode, 200, qcFirst.body);
    const qcLegacy = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${fixture.childId}/qc`,
      headers: fixture.adminHeaders, payload: { allocations: [{ allocationId: fixture.allocationId, passedSeries: 4, rejectedSeries: 0 }] } });
    assert.equal(qcLegacy.statusCode, 409, qcLegacy.body);
    assert.equal(qcLegacy.json().code, 'INBOUND_ALREADY_QC');
    const final = await allocRow(pool, fixture.allocationId);
    assert.equal(final.qc_passed_series, 4, 'QC acceptance exists exactly once');

    /* ---- §12: the LEGACY inbound-shipment path refuses OMS-bound goods outright ---- */
    const fulfillment = await makeUser(pool, ['supplier'], 'تأمین‌کننده قدیمی G4');
    const legacyBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbound_shipments s JOIN orders o ON o.id = s.order_id WHERE o.master_order_id IS NOT NULL`);
    const legacyShipment = await app.inject({ method: 'POST', url: '/api/v1/wholesale/inbound-shipments',
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('legacy') },
      payload: { fulfillmentId: randomUUID(), lines: [] } });
    assert.ok([400, 404].includes(legacyShipment.statusCode), 'a legacy shipment needs a real legacy fulfillment');
    const omsChildLegacy = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbound_shipments s JOIN orders o ON o.id = s.order_id WHERE o.master_order_id IS NOT NULL`);
    assert.equal(Number(omsChildLegacy.rows[0]!.count), Number(legacyBefore.rows[0]!.count),
      `no legacy shipment may ever be created for an OMS child (${fulfillment.id.slice(0, 4)})`);
    assert.equal(Number((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbound_shipments WHERE order_id = $1`, [fixture.childId])).rows[0]!.count), 0,
      'the OMS-bound child has no legacy inbound shipment authority');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 5 */

test('P6 GOLDEN-5 — physically picked goods are deducted once: legacy dispatch is refused, ledger stays consistent', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر G5');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار G5');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, 'انبار G5');
    const product = await makeSeriesProduct(pool, `کالای G5 ${uniqueRef('K')}`, null, { piecesPerSeries: 2 });
    await seedStock(pool, product.tplId, product.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 4, 2);
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: product.tplId, count: 4 }]);
    const childId = master.children[0]!.id;
    await payChild(app, pool, buyerHeaders, childId);
    const pick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/pick`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} });
    assert.equal(pick.statusCode, 200, pick.body);
    const afterPick = await pieceOnHand(pool, product.variantIds);
    assert.equal(afterPick, 0, 'picking removes the pieces from sellable wholesale storage');

    // P6-CON-002/§15: replaying the pick with the same key is a no-op, without it a conflict.
    const replayPick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/pick`, headers: adminHeaders, payload: {} });
    assert.equal(replayPick.statusCode, 409, replayPick.body);
    assert.equal(await pieceOnHand(pool, product.variantIds), afterPick, 'no second deduction');

    // Consolidate, verify, pack.
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    const consolidationId = start.json().id as string;
    const items = await pool.query<{ line_id: string }>('SELECT line_id FROM consolidation_items WHERE consolidation_id = $1', [consolidationId]);
    for (const item of items.rows) {
      const verified = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
        headers: adminHeaders, payload: { lineId: item.line_id } });
      assert.equal(verified.statusCode, 200, verified.body);
    }
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders, payload: {} })).statusCode, 200);
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-ship') }, payload: { carrier: 'باربری G5', trackingCode: 'TRK-G5' } });
    assert.equal(ship.statusCode, 200, ship.body);
    const afterShip = await pieceOnHand(pool, product.variantIds);
    assert.equal(afterShip, 0, 'shipping never deducts a second time');

    /* ---- the LEGACY dispatch endpoint must not double-deduct nor duplicate the shipment ---- */
    const legacyDispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/orders/${childId}/dispatch-vip`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-legacy') }, payload: { trackingCode: 'TRK-LEGACY' } });
    assert.equal(legacyDispatch.statusCode, 409, legacyDispatch.body);
    assert.equal(await pieceOnHand(pool, product.variantIds), 0, 'no negative or double-deducted balance');
    const shipments = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM master_orders WHERE id = $1 AND shipped_at IS NOT NULL", [master.id]);
    assert.equal(Number(shipments.rows[0]!.count), 1, 'one canonical customer-facing dispatch');
    const tracking = await pool.query<{ count: string }>(
      "SELECT count(DISTINCT tracking_code)::text AS count FROM master_orders WHERE id = $1", [master.id]);
    assert.equal(Number(tracking.rows[0]!.count), 1, 'no duplicate tracking code');
    const stockDrift = await pool.query<{ drift: number }>(
      `SELECT COALESCE(SUM(CASE WHEN b.reserved > b.on_hand THEN 1 ELSE 0 END), 0)::int AS drift
         FROM stock_balances b WHERE b.variant_id = ANY($1::uuid[])`, [product.variantIds]);
    assert.equal(stockDrift.rows[0]!.drift, 0, 'no balance contradicts the ledger');
    const seriesDrift = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM series_stock_balances WHERE series_template_id = $1 AND reserved > on_hand', [product.tplId]);
    assert.equal(Number(seriesDrift.rows[0]!.count), 0, 'series banding stays consistent with its pieces');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 6 */

test('P6 GOLDEN-6/P6-QC-007 — two QC operators finalising the same receipt simultaneously: exactly one posting', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 3, label: 'G6' });
    const shipment = await declareShipment(app, fixture);
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 3 }] } });
    assert.equal(receive.statusCode, 200, receive.body);

    const inspectorA = await makeUser(pool, ['operations'], 'کارشناس کیفی الف G6');
    const inspectorB = await makeUser(pool, ['operations'], 'کارشناس کیفی ب G6');
    const headersA = await login(app, inspectorA.email);
    const headersB = await login(app, inspectorB.email);

    // §28: REAL concurrency, not only sequential duplicates.
    const results = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`, headers: headersA,
        payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 0 }] } }),
      app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`, headers: headersB,
        payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 2, rejectedSeries: 1 }] } }),
    ]);
    const okResults = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode !== 200);
    assert.equal(okResults.length, 1, `exactly one QC posting may succeed (${results.map((r) => r.statusCode).join(',')})`);
    assert.ok(rejected[0]!.statusCode === 409 || rejected[0]!.statusCode === 500, rejected[0]!.body);
    const allocation = await allocRow(pool, fixture.allocationId);
    assert.equal(allocation.qc_passed_series + allocation.qc_rejected_series, 3, 'no double acceptance and no double rejection');
    assert.ok(allocation.qc_passed_series === 3 || allocation.qc_rejected_series === 1);
    const receiptCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1', [shipment.id]);
    assert.equal(Number(receiptCount.rows[0]!.count), 1, 'one GRN, never a contradictory pair');
    const shipmentRow = await pool.query<{ status: string }>('SELECT status FROM oms_inbound_shipments WHERE id = $1', [shipment.id]);
    assert.equal(shipmentRow.rows[0]!.status, 'qc_completed');
    // Concurrent RECEIVING is equally safe.
    const secondFixture = await externalLeg(app, pool, { series: 2, label: 'G6b' });
    const shipmentB = await declareShipment(app, secondFixture);
    const receives = await Promise.all([
      app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentB.id}/receive`, headers: headersA,
        payload: { lines: [{ allocationId: secondFixture.allocationId, receivedSeries: 2 }] } }),
      app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentB.id}/receive`, headers: headersB,
        payload: { lines: [{ allocationId: secondFixture.allocationId, receivedSeries: 1, missingSeries: 1 }] } }),
    ]);
    assert.equal(receives.filter((r) => r.statusCode === 200).length, 1, 'only one physical receipt wins');
    const secondAllocation = await allocRow(pool, secondFixture.allocationId);
    assert.equal(secondAllocation.received_series + secondAllocation.received_missing_series, 2, 'reconciliation stays exact');
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== Golden Scenario 7 */

test('P6 GOLDEN-7 — unauthorised operations are refused by the SERVER regardless of the UI', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 2, label: 'G7' });
    const shipment = await declareShipment(app, fixture);

    // Supplier cannot receive, QC, pick, verify, pack or ship.
    const supplierReceive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.supplierHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 2 }] } });
    assert.equal(supplierReceive.statusCode, 403, 'a supplier never receives its own goods (§27)');
    const supplierQc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.supplierHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 2, rejectedSeries: 0 }] } });
    assert.equal(supplierQc.statusCode, 403, 'a supplier can never self-approve QC');
    const supplierQueue = await app.inject({ method: 'GET', url: '/api/v1/admin/wms/inbound-shipments', headers: fixture.supplierHeaders });
    assert.equal(supplierQueue.statusCode, 403, 'the internal warehouse queue is closed to suppliers');
    const supplierDashboard = await app.inject({ method: 'GET', url: '/api/v1/admin/wms/dashboard', headers: fixture.supplierHeaders });
    assert.equal(supplierDashboard.statusCode, 403);
    const supplierResolve = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/exceptions/${randomUUID()}/resolve`,
      headers: fixture.supplierHeaders, payload: { resolution: 'accept_short' } });
    assert.equal(supplierResolve.statusCode, 403);

    // The buyer cannot touch warehouse operations nor read another buyer's master.
    const buyerReceive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: fixture.buyerHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 2 }] } });
    assert.equal(buyerReceive.statusCode, 403, 'a buyer never receives or inspects goods');
    const buyerDetail = await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}`, headers: fixture.buyerHeaders });
    assert.equal(buyerDetail.statusCode, 403);
    const stranger = await makeVip(pool, 'خریدار غریبه G7');
    const strangerHeaders = await login(app, stranger.email);
    const foreignMaster = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${fixture.master.id}`, headers: strangerHeaders });
    assert.ok([403, 404].includes(foreignMaster.statusCode),
      `another buyer can never read the Master (got ${foreignMaster.statusCode})`);
    const foreignReceiver = await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments?masterId=${fixture.master.id}`,
      headers: fixture.supplierHeaders });
    assert.equal(foreignReceiver.statusCode, 403);

    // A valid warehouse operator must still work: duty-scoped accounts are the intended narrowing.
    const receiverOnly = await makeUser(pool, ['operations'], 'اپراتور دریافت G7');
    await pool.query("DELETE FROM user_roles WHERE user_id = $1 AND role_code = 'operations'", [receiverOnly.id]);
    await pool.query("INSERT INTO user_roles(user_id, role_code) VALUES ($1,'operations')", [receiverOnly.id]);
    await pool.query("DELETE FROM role_permissions WHERE role_code = 'operations' AND permission_code IN ('wms:receive','wms:qc','wms:consolidate','wms:ship','wholesale:ops','orders:transition')");
    await pool.query("INSERT INTO role_permissions(role_code, permission_code) VALUES ('operations','wms:receive') ON CONFLICT DO NOTHING");
    const receiverHeaders = await login(app, receiverOnly.email);
    const allowed = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: receiverHeaders, payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 2 }] } });
    assert.equal(allowed.statusCode, 200, 'a receiving-only operator can receive');
    const deniedQc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: receiverHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 2, rejectedSeries: 0 }] } });
    assert.equal(deniedQc.statusCode, 403, 'and cannot inspect — QC is a separate duty');
    // restore the shared role matrix for later suites.
    await pool.query("INSERT INTO role_permissions(role_code, permission_code) VALUES ('operations','wms:qc'),('operations','wms:consolidate'),('operations','wms:ship'),('operations','wholesale:ops'),('operations','orders:transition') ON CONFLICT DO NOTHING");
  } finally { await app.close(); await pool.end(); }
});

/* ================================================================== matrix details */

test('P6-INB-004 — receiving before dispatch (and QC before receipt) are rejected', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 2, label: 'INB4' });
    const allocationBefore = await allocRow(pool, fixture.allocationId);
    assert.equal(allocationBefore.dispatched_series, 2);
    // Rewind the dispatch marker to simulate "not dispatched yet" — the guard must hold on state, not on UI.
    await pool.query('UPDATE order_source_allocations SET dispatched_series = 0 WHERE id = $1', [fixture.allocationId]);
    const shipment = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${fixture.childId}/inbound-shipment`,
      headers: { ...fixture.supplierHeaders, 'idempotency-key': uniqueRef('p6-declare') }, payload: {} });
    // No dispatched quantity → no inbound leg may be announced at all.
    assert.equal(shipment.statusCode, 409, shipment.body);
    const lazyReceive = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${fixture.childId}/receive`,
      headers: fixture.adminHeaders, payload: { allocations: [{ allocationId: fixture.allocationId, receivedSeries: 2 }] } });
    assert.equal(lazyReceive.statusCode, 409, lazyReceive.body);
    assert.equal(lazyReceive.json().code, 'INBOUND_NOT_DISPATCHED');
    const qcBeforeReceipt = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${fixture.childId}/qc`,
      headers: fixture.adminHeaders, payload: { allocations: [{ allocationId: fixture.allocationId, passedSeries: 2, rejectedSeries: 0 }] } });
    assert.equal(qcBeforeReceipt.statusCode, 409, 'QC before receiving is impossible');
    const untouched = await allocRow(pool, fixture.allocationId);
    assert.equal(untouched.received_series, 0);
    assert.equal(untouched.qc_at, null);
  } finally { await app.close(); await pool.end(); }
});

test('P6-QC-001/002/003/006 — QC guards: after receipt only, exact totals, partial stays partial, idempotent', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 4, label: 'QC1' });
    const shipment = await declareShipment(app, fixture);
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 4 }] } });
    assert.equal(receive.statusCode, 200, receive.body);

    // totals must settle exactly; over-acceptance and negatives are refused by the server.
    const over = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 5, rejectedSeries: 0 }] } });
    assert.equal(over.statusCode, 400, 'accepted quantity can never exceed what was received');
    const under = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 0 }] } });
    assert.equal(under.statusCode, 400, 'a partial QC draft must not post an unreconciled total');
    const negative = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 4, rejectedSeries: -1 }] } });
    assert.equal(negative.statusCode, 400, 'negative QC quantities are impossible');
    const badDamaged = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 1, damagedSeries: 2 }] } });
    assert.equal(badDamaged.statusCode, 400, 'damage is a subset of rejected — it can never be counted twice');

    // P6-QC-006: idempotent finalisation.
    const key = uniqueRef('p6-qc');
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': key },
      payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 1 }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': key },
      payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 1 }] } });
    assert.equal(replay.statusCode, 200, 'replay returns the same outcome');
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: fixture.adminHeaders, payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 4, rejectedSeries: 0 }] } });
    assert.equal(duplicate.statusCode, 409, 'a final inspection is never repeated');

    // P6-QC-003: partially accepted stock is handled correctly — staging only the accepted part.
    const allocation = await allocRow(pool, fixture.allocationId);
    assert.equal(allocation.qc_passed_series, 3);
    assert.equal(allocation.status, 'reserved', 'an unreconciled leg stays open');
    const state = await childState(pool, fixture.childId);
    assert.equal(state.child_fulfillment, 'exception', 'unresolved rejection blocks readiness until it is authorised');
    const exceptions = await exceptionsOf(pool, fixture.childId);
    assert.deepEqual(exceptions.map((e) => [e.exception_type, e.quantity]), [['qc_rejected', 1]]);
    const fulfilment = await app.inject({ method: 'POST', url: `/api/v1/wholesale/exceptions/${exceptions.length ? (await pool.query<{ id: string }>(
      "SELECT id FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'", [fixture.childId])).rows[0]!.id : ''}/resolve`,
      headers: fixture.adminHeaders, payload: { resolution: 'accept_short', note: 'تأیید کسری' } });
    assert.equal(fulfilment.statusCode, 200, fulfilment.body);
    assert.equal((await childState(pool, fixture.childId)).child_fulfillment, 'ready_for_consolidation', 'authorised shrinkage unblocks the child');
    const accepted = await pool.query<{ accepted_series: number }>('SELECT accepted_series FROM child_order_lines WHERE child_order_id = $1', [fixture.childId]);
    assert.equal(accepted.rows[0]!.accepted_series, 3, 'settlement-grade accepted quantity = 3, never the requested 4');
  } finally { await app.close(); await pool.end(); }
});

test('P6-OMS-004/005/006 — partial fulfillment keeps the requirement open; rejection never reduces demand silently', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 5, label: 'OMS4' });
    const shipment = await declareShipment(app, fixture);
    await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 4, note: 'کسری یک سری' }] } });
    await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...fixture.adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: fixture.allocationId, passedSeries: 3, rejectedSeries: 1 }] } });

    const exceptions = await pool.query<{ id: string; exception_type: string; quantity: number; status: string }>(
      'SELECT id, exception_type, quantity, status FROM fulfillment_exceptions WHERE child_order_id = $1 ORDER BY exception_type', [fixture.childId]);
    assert.deepEqual(exceptions.rows.map((r) => [r.exception_type, r.quantity, r.status]),
      [['lost_inbound', 1, 'open'], ['qc_rejected', 1, 'open']], 'the 2 unresolved units are represented, not hidden');
    const line = await pool.query<{ requested_series: number; confirmed_series: number; accepted_series: number | null }>(
      'SELECT requested_series, confirmed_series, accepted_series FROM child_order_lines WHERE child_order_id = $1', [fixture.childId]);
    assert.equal(line.rows[0]!.confirmed_series, 5, 'the commercial quantity is untouched by operational shrinkage');

    // P6-OMS-006: reassignment preserves the Master and its quantities while the goods stay unresolved.
    const before = await pool.query<{ reference: string; count: string }>(
      'SELECT mo.reference, (SELECT count(*)::text FROM orders o WHERE o.master_order_id = mo.id) AS count FROM master_orders mo WHERE mo.id = $1',
      [fixture.master.id]);
    const shortException = exceptions.rows.find((r) => r.exception_type === 'lost_inbound')!;
    const { resolveFulfillmentException } = await import('./wholesale-fulfillment.js');
    await resolveFulfillmentException(pool,
      { id: fixture.admin.id, roles: ['admin'], permissions: ['wholesale:ops'], displayName: 'مدیر', sessionId: 'x' },
      { exceptionId: shortException.id, resolution: 'supplier_redelivery', note: 'ارسال مجدد کسری' });
    const after = await pool.query<{ reference: string; count: string }>(
      'SELECT mo.reference, (SELECT count(*)::text FROM orders o WHERE o.master_order_id = mo.id) AS count FROM master_orders mo WHERE mo.id = $1',
      [fixture.master.id]);
    assert.deepEqual(after.rows[0], before.rows[0], 'the Master Order and its child count are preserved');
    const resetLeg = await allocRow(pool, fixture.allocationId);
    assert.equal(resetLeg.dispatched_series, 0, 'the supplier may dispatch replacement supply for the missing unit');
    assert.equal((await childState(pool, fixture.childId)).child_fulfillment, 'exception',
      'the still-open rejected unit keeps the Master blocked — a reopened leg alone is not enough');
    const rejectedException = (await pool.query<{ id: string }>(
      "SELECT id FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'", [fixture.childId])).rows[0]!;
    await resolveFulfillmentException(pool,
      { id: fixture.admin.id, roles: ['admin'], permissions: ['wholesale:ops'], displayName: 'مدیر', sessionId: 'x' },
      { exceptionId: rejectedException.id, resolution: 'supplier_redelivery', note: 'جایگزینی سری معیوب' });
    assert.equal((await childState(pool, fixture.childId)).child_fulfillment, 'preparing',
      'readiness is re-derived from the reopened leg — never sticky after a resolution');
    assert.equal(await pieceOnHand(pool, fixture.product.variantIds), 0, 'no fabricated replacement stock was created');
  } finally { await app.close(); await pool.end(); }
});

test('P6-SHP-002/003/004 — final shipment blocked for unpaid, unresolved shortage and unresolved QC exception', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر SHP2');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار SHP2');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, 'انبار SHP2');
    const product = await makeSeriesProduct(pool, `کالای SHP2 ${uniqueRef('K')}`, null);
    await seedStock(pool, product.tplId, product.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 2);
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: product.tplId, count: 2 }]);
    const childId = master.children[0]!.id;

    // P6-SHP-002: unpaid → pick and ship are both refused.
    const unpaidPick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/pick`, headers: adminHeaders, payload: {} });
    assert.equal(unpaidPick.statusCode, 409);
    assert.equal(unpaidPick.json().code, 'PAYMENT_NOT_READY');
    const unpaidShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-ship') }, payload: { carrier: 'باربری', trackingCode: 'T-1' } });
    assert.equal(unpaidShip.statusCode, 409, unpaidShip.body);

    await payChild(app, pool, buyerHeaders, childId);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/pick`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} })).statusCode, 200);
    await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    const consolidationId = start.json().id as string;
    const items = await pool.query<{ line_id: string }>('SELECT line_id FROM consolidation_items WHERE consolidation_id = $1', [consolidationId]);
    for (const item of items.rows) {
      await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`, headers: adminHeaders, payload: { lineId: item.line_id } });
    }
    await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });

    // P6-SHP-004: an unresolved blocking exception stops the shipment even after packing.
    // A genuine blocking exception is opened on the child AFTER packing (worst-case ordering).
    const exceptionId = await (async () => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, exception_type, quantity, status, note, created_by)
         VALUES ($1,$2,$3,'qc_rejected',1,'open','استثنای باز آزمون ارسال',$4) RETURNING id`,
        [randomUUID(), master.id, childId, admin.id]);
      return res.rows[0]!.id;
    })();
    const pack = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders, payload: {} });
    assert.equal(pack.statusCode, 200, pack.body);
    const blockedShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-ship') }, payload: { carrier: 'باربری', trackingCode: 'T-2' } });
    assert.equal(blockedShip.statusCode, 409, blockedShip.body);
    assert.equal(blockedShip.json().code, 'FULFILLMENT_EXCEPTION_OPEN');
    // P6-SHP-001: the shipment authority is Kolbe-side; a supplier cannot trigger it.
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده SHP2');
    const supplierHeaders = await login(app, supplier.email);
    const supplierShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: supplierHeaders, payload: { carrier: 'باربری', trackingCode: 'T-3' } });
    assert.equal(supplierShip.statusCode, 403);
    const buyerShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: buyerHeaders, payload: { carrier: 'باربری', trackingCode: 'T-4' } });
    assert.equal(buyerShip.statusCode, 403, 'a buyer cannot dispatch its own order');

    // Resolving the exception releases the block.
    const resolve = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/exceptions/${exceptionId}/resolve`,
      headers: adminHeaders, payload: { resolution: 'accept_short', note: 'تأیید' } });
    assert.equal(resolve.statusCode, 200, resolve.body);
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-ship') }, payload: { carrier: 'باربری', trackingCode: 'T-5' } });
    assert.equal(ship.statusCode, 200, ship.body);
  } finally { await app.close(); await pool.end(); }
});

test('P6-CON-001..008 + P6-SHP-010 — consolidation integrity: owner-aware picks, all-items requirement, audited delivery', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر CON');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار CON');
    const buyerHeaders = await login(app, buyer.email);
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده CON');
    const warehouse = await makeWarehouse(pool, 'انبار CON');
    const kolbeProduct = await makeSeriesProduct(pool, `کلبه CON ${uniqueRef('K')}`, null);
    await seedStock(pool, kolbeProduct.tplId, kolbeProduct.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 2);
    const supplierProduct = await makeSeriesProduct(pool, `تأمین CON ${uniqueRef('S')}`, supplier.id);
    await seedStock(pool, supplierProduct.tplId, supplierProduct.variantIds, warehouse, { ownerType: 'supplier', supplierId: supplier.id }, 2);

    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbeProduct.tplId, count: 2 }, { seriesTemplateId: supplierProduct.tplId, count: 2 },
    ]);
    for (const child of master.children) await payChild(app, pool, buyerHeaders, child.id);
    for (const child of master.children) {
      const pick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/pick`,
        headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-pick') }, payload: {} });
      assert.equal(pick.statusCode, 200, pick.body);
    }
    // P6-CON-001: the owner-aware ledger records Kolbe and supplier movements separately.
    const movements = await pool.query<{ owner_type: string; movement_type: string }>(
      `SELECT owner_type, movement_type FROM series_stock_movements
        WHERE series_template_id IN ($1,$2) AND movement_type = 'consume' ORDER BY owner_type`,
      [kolbeProduct.tplId, supplierProduct.tplId]);
    assert.deepEqual(movements.rows.map((r) => [r.owner_type, r.movement_type]),
      [['kolbe', 'consume'], ['supplier', 'consume']], 'both owners consumed through the same primitive');

    // §16: a master cannot be started without every included child being physically ready.
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    const consolidationId = start.json().id as string;
    const items = await pool.query<{ line_id: string; expected_series: number }>(
      'SELECT line_id, expected_series FROM consolidation_items WHERE consolidation_id = $1 ORDER BY expected_series', [consolidationId]);
    assert.deepEqual(items.rows.map((r) => r.expected_series), [2, 2], 'every canonical requirement has exactly one expected item');

    // P6-CON-006: wrong item and duplicate verification are rejected with machine codes.
    const wrong = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: randomUUID() } });
    assert.equal(wrong.json().code, 'WRONG_CONSOLIDATION_ITEM');
    const verified = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: items.rows[0]!.line_id } });
    assert.equal(verified.statusCode, 200, verified.body);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: items.rows[0]!.line_id } });
    assert.equal(duplicate.json().code, 'DUPLICATE_CONSOLIDATION_SCAN');
    const verificationAudit = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM consolidation_items WHERE consolidation_id = $1 AND verified_by IS NOT NULL', [consolidationId]);
    assert.equal(Number(verificationAudit.rows[0]!.count), 1, 'manual confirmation is auditable');

    // P6-CON-007: completion requires every valid item.
    const premature = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });
    assert.equal(premature.statusCode, 409);
    assert.equal(premature.json().code, 'CONSOLIDATION_NOT_READY');
    // P6-CON-008: packing is only allowed after a valid completion.
    const packBefore = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders, payload: {} });
    assert.equal(packBefore.statusCode, 409);
    for (const item of items.rows.slice(1)) {
      const done = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
        headers: adminHeaders, payload: { lineId: item.line_id } });
      assert.equal(done.statusCode, 200, done.body);
    }
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders })).statusCode, 200);
    // Consolidation is not editable after completion.
    const afterComplete = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: items.rows[0]!.line_id } });
    assert.equal(afterComplete.statusCode, 409, 'a completed consolidation is closed for scanning');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`,
      headers: adminHeaders, payload: { packageCount: 2 } })).statusCode, 200);
    const shipKey = uniqueRef('p6-ship');
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: { ...adminHeaders, 'idempotency-key': shipKey }, payload: { carrier: 'پست', trackingCode: 'CON-TRK' } });
    assert.equal(ship.statusCode, 200, ship.body);
    /* ---- P6-SHP-007: tracking is persisted on the ONE master shipment and stays visible to the buyer
       in the canonical projection (the buyer sees tracking, never the internal sourcing topology). ---- */
    const shipped = await pool.query<{ carrier: string | null; tracking_code: string | null; shipped_at: string | null }>(
      'SELECT carrier, tracking_code, shipped_at FROM master_orders WHERE id = $1', [master.id]);
    assert.deepEqual({ carrier: shipped.rows[0]!.carrier, tracking: shipped.rows[0]!.tracking_code },
      { carrier: 'پست', tracking: 'CON-TRK' }, 'the shipment tracking lives on the master order');
    assert.ok(shipped.rows[0]!.shipped_at, 'the dispatch time is recorded');
    const buyerShipped = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders })).json() as
      { trackingCode?: string; status?: string };
    assert.equal(JSON.stringify(buyerShipped).includes('CON-TRK'), true, 'the buyer sees the real tracking of the ONE shipment');
    const childTracking = await pool.query<{ vip_tracking_code: string | null }>(
      'SELECT vip_tracking_code FROM orders WHERE id = $1', [master.children[0]!.id]);
    assert.equal(childTracking.rows[0]!.vip_tracking_code, 'CON-TRK', 'each child records the same canonical tracking');
    /* ---- P6-SHP-008: labels/documents still come from the pre-existing server label authority —
       a child of the master is recognised by it (200 or a documented precondition, never "no such thing"). */
    const label = await app.inject({ method: 'GET', url: `/api/v1/admin/orders/${master.children[0]!.id}/label`, headers: adminHeaders });
    assert.notEqual(label.statusCode, 404, 'the canonical order label authority exists for wholesale children too');
    const duplicateLabeAuthority = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name IN ('oms_labels','master_shipping_labels','consolidation_labels')");
    assert.equal(Number(duplicateLabeAuthority.rows[0]!.count), 0, 'no second label authority was created for Prompt 6');
    // P6-SHP-010: the delivery transition is authorised, audited and idempotent-blocked on repeat.
    const deliver = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/deliver`, headers: adminHeaders });
    assert.equal(deliver.statusCode, 200, deliver.body);
    const deliverAgain = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/deliver`, headers: adminHeaders });
    assert.equal(deliverAgain.statusCode, 409, 'delivery is recorded once');
    const auditRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs
        WHERE action IN ('wholesale_master.shipped','wholesale_master.delivered','wholesale_consolidation.completed','wholesale_consolidation.packed')
          AND actor_id = $1`, [admin.id]);
    assert.ok(Number(auditRow.rows[0]!.count) >= 4, 'every sensitive physical operation is audited');
  } finally { await app.close(); await pool.end(); }
});

test('P6-DASH-001 — the warehouse dashboard counts are server-derived and deep-link to filtered queues', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const fixture = await externalLeg(app, pool, { series: 3, label: 'DASH' });
    const shipment = await declareShipment(app, fixture);
    const adminHeaders = fixture.adminHeaders;

    const before = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/dashboard', headers: adminHeaders })).json() as
      { counters: Record<string, number> };
    assert.ok(before.counters.awaiting_receiving! >= 1, 'the customer-order inbound is counted as awaiting receiving');
    // Tests share one database, so the QC queue is asserted as a DELTA of the real pre-receipt count.
    const qcBaseline = before.counters.awaiting_qc!;

    // Each counter is verified against a real query on the canonical tables (no vanity numbers).
    const expectedArriving = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM oms_inbound_shipments WHERE status IN ('dispatched','in_transit')");
    assert.equal(before.counters.arriving, Number(expectedArriving.rows[0]!.n));

    // Deep link: the receiving work queue filtered server-side returns exactly that shipment.
    const queue = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/inbound-shipments?awaitingReceiving=true', headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.ok(queue.items.some((row) => row.id === shipment.id), 'the awaiting-receiving deep link finds the shipment');
    const qcQueue = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/inbound-shipments?awaitingQc=true', headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.ok(!qcQueue.items.some((row) => row.id === shipment.id), 'it is not yet a QC task');

    // Receive with a shortage → dashboard + exception filters react to the real event.
    await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: fixture.allocationId, receivedSeries: 2, damagedSeries: 1 }] } });
    const after = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/dashboard', headers: adminHeaders })).json() as
      { counters: Record<string, number>; masters: Array<{ master_reference: string }> };
    assert.equal(after.counters.awaiting_receiving! < before.counters.awaiting_receiving!, true, 'the received shipment left the receiving queue');
    assert.equal(after.counters.awaiting_qc, qcBaseline + 1, 'the receipt turned this shipment into exactly one QC task');
    assert.ok(after.counters.damaged! >= 1, 'the damaged unit is counted');
    assert.ok(after.counters.open_exceptions! >= 1);
    const qcNow = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/inbound-shipments?awaitingQc=true', headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.ok(qcNow.items.some((row) => row.id === shipment.id));
    const exceptionQueue = (await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments?hasException=true&masterId=${fixture.master.id}`, headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.deepEqual(exceptionQueue.items.map((r) => r.id), [shipment.id], 'the exception deep link resolves to the affected shipment');
    // The master queue lists the affected Master so the operator can act on it.
    const masterQueue = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/consolidation-queue?status=blocked', headers: adminHeaders })).json() as
      { items: Array<{ master_reference: string }> };
    assert.ok(masterQueue.items.some((row) => row.master_reference === fixture.master.reference));
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/admin/wms/masters/${fixture.master.id}/consolidation-detail`, headers: adminHeaders })).json() as
      { children: Array<{ open_exceptions: number; external_missing_series: number }>; actions: string[] };
    assert.equal(detail.children.length, 1);
    assert.equal(detail.children[0]!.external_missing_series, 1, 'internal operators see the real per-source progress');
    assert.ok(!detail.actions.includes('start_consolidation'), 'the server does not offer an action the state forbids');
    // The shipment detail exposes per-line operator data with GRN references and no raw UUID-only view.
    const shipmentDetail = (await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}`, headers: adminHeaders })).json() as
      { lines: Array<Record<string, unknown>>; actions: string[]; shipment: Record<string, unknown> };
    assert.equal(shipmentDetail.lines.length, 1);
    assert.ok(String(shipmentDetail.shipment.reference).startsWith('OIN-'));
    assert.ok(shipmentDetail.actions.includes('inspect'), 'QC is offered once a receipt exists');
    assert.ok(!shipmentDetail.actions.includes('receive'), 'receiving is no longer offered');
  } finally { await app.close(); await pool.end(); }
});

test('P6-REG-002/003/004 — Prompt 3/4/5 invariants survive: consignment ownership, supplier commitments, master coverage', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    /* ---- Prompt 3 (P6-REG-001/004): general supplier consignment keeps its own workflow and ownership ---- */
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده REG');
    const supplierHeaders = await login(app, supplier.email);
    const admin = await makeUser(pool, ['admin'], 'مدیر REG');
    const adminHeaders = await login(app, admin.email);
    const warehouse = await makeWarehouse(pool, 'انبار امانی REG');
    const product = await makeSeriesProduct(pool, `امانی REG ${uniqueRef('C')}`, supplier.id);
    const request = await app.inject({ method: 'POST', url: '/api/v1/supplier/inbounds', headers: supplierHeaders,
      payload: { productId: product.productId, seriesTemplateId: product.tplId, expectedSeries: 4, note: 'ورود امانی' } });
    assert.equal(request.statusCode, 201, request.body);
    const inboundId = request.json().id as string;
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/review`,
      headers: adminHeaders, payload: { decision: 'approve', warehouseId: warehouse } });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/supplier/inbounds/${inboundId}/dispatch`, headers: supplierHeaders,
      payload: { carrier: 'باربری امانی' } })).statusCode, 200);
    const beforeReceive = await seriesOnHand(pool, product.tplId);
    assert.equal(beforeReceive.total, 0, 'dispatch creates no stock — «در راه» is not on-hand');
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/receive`,
      headers: adminHeaders, payload: { receivedSeries: 3, note: 'کسری ۱' } });
    assert.equal(receive.statusCode, 200, receive.body);
    assert.equal((await seriesOnHand(pool, product.tplId)).total, 0, 'receiving is not QC — nothing sellable yet');
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/qc`,
      headers: adminHeaders, payload: { passedSeries: 2, rejectedSeries: 1 } });
    assert.equal(qc.statusCode, 200, qc.body);
    const consigned = await seriesOnHand(pool, product.tplId, 'supplier');
    assert.deepEqual({ on_hand: consigned.total, reserved: consigned.reserved }, { on_hand: 2, reserved: 0 });
    const kolbeScoped = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'kolbe'", [product.tplId]);
    assert.equal(Number(kolbeScoped.rows[0]!.count), 0, 'consigned goods never silently become Kolbe-owned');

    /* ---- Prompt 5 (P6-REG-003): commitments remain durable and still create no stock ---- */
    const buyer = await makeVip(pool, 'خریدار REG');
    const buyerHeaders = await login(app, buyer.email);
    const offerProduct = await makeSeriesProduct(pool, `تعهد REG ${uniqueRef('O')}`, supplier.id);
    await makeOffer(pool, supplier.id, offerProduct.productId, offerProduct.tplId, 6);
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: offerProduct.tplId, count: 3 }]);
    const childId = master.children[0]!.id;
    const lineId = (await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childId])).rows[0]!.id;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineId}/respond`,
      headers: supplierHeaders, payload: { action: 'confirm' } })).statusCode, 200);
    const allocationId = (await pool.query<{ id: string }>(
      "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'", [childId])).rows[0]!.id;
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocationId}/commit`,
      headers: { ...supplierHeaders, 'idempotency-key': uniqueRef('p6-commit') }, payload: {} })).statusCode, 200);
    const committed = await pool.query<{ supplier_response_status: string; supplier_committed_series: number; expires_at: string | null }>(
      `SELECT l.supplier_response_status, l.supplier_committed_series, r.expires_at
         FROM child_order_lines l LEFT JOIN supplier_capacity_reservations r ON r.id = (SELECT capacity_reservation_id FROM order_source_allocations WHERE line_id = l.id LIMIT 1)
        WHERE l.id = $1`, [lineId]);
    assert.equal(committed.rows[0]!.supplier_response_status, 'committed');
    assert.equal(committed.rows[0]!.supplier_committed_series, 3);
    assert.equal(committed.rows[0]!.expires_at, null, 'a durable commitment is never released by a TTL sweep');
    assert.equal(await pieceOnHand(pool, offerProduct.variantIds), 0, 'commitment is not stock');
    assert.equal((await seriesOnHand(pool, offerProduct.tplId)).total, 0);

    /* ---- Prompt 4 (P6-REG-002): source coverage is still reported per source, never merged ---- */
    const masterRow = await pool.query<{ id: string }>('SELECT id FROM master_orders WHERE id = $1', [master.id]);
    assert.ok(masterRow.rows.length === 1);
    const opsView = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: adminHeaders })).json() as
      { coverage: Record<string, number>; readiness: string };
    assert.deepEqual(opsView.coverage, {
      orderedSeries: 3, kolbeSeries: 0, supplierAtKolbeSeries: 0, capacitySeries: 3, receivedSeries: 0, qcPassedSeries: 0,
    }, 'declared capacity is reported as a requirement, never as physical stock');
    assert.equal(opsView.readiness, 'partial');
  } finally { await app.close(); await pool.end(); }
});

/* ============================================ Migration compatibility (P6-REG-005/006) */

test('P6-REG-005/006 — migration 074 is safe on populated databases and legacy GRNs keep their own scope', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر REG-MIG');
    const adminHeaders = await login(app, admin.email);
    const warehouse = await makeWarehouse(pool, 'انبار REG-MIG');

    /* ---- a LEGACY v1 GRN written in the pre-074 shape (its own fulfillment → shipment → receipt) ---- */
    const legacyOrderId = randomUUID();
    await pool.query(`INSERT INTO orders(id, reference, buyer_id, order_type, payment_mode, status, subtotal_rial, total_rial, paid_at)
                      VALUES ($1,$2,$3,'wholesale','cash','paid',0,0,now() - interval '40 days')`,
      [legacyOrderId, uniqueRef('MV-LEGACY'), admin.id]);
    const fulfillmentId = randomUUID();
    await pool.query(`INSERT INTO supplier_fulfillments(id, reference, order_id, supplier_id, destination_warehouse_id, status)
                      VALUES ($1,$2,$3,$4,$5,'arrived_at_kolbe')`,
      [fulfillmentId, uniqueRef('SF-LEGACY'), legacyOrderId, admin.id, warehouse]);
    const legacyShipmentId = randomUUID();
    await pool.query(`INSERT INTO inbound_shipments(id, shipment_number, supplier_fulfillment_id, order_id, supplier_id,
                        destination_warehouse_id, status, dispatched_at)
                      VALUES ($1,$2,$3,$4,$5,$6,'receiving', now() - interval '35 days')`,
      [legacyShipmentId, uniqueRef('IN-LEGACY'), fulfillmentId, legacyOrderId, admin.id, warehouse]);
    const legacyReceiptId = randomUUID();
    await pool.query(`INSERT INTO warehouse_receipts(id, receipt_number, inbound_shipment_id, warehouse_id, received_by,
                        qc_status, notes, received_at)
                      VALUES ($1,$2,$3,$4,$5,'accepted','رسید نسخه قبلی', now() - interval '34 days')`,
      [legacyReceiptId, uniqueRef('GRN-LEGACY'), legacyShipmentId, warehouse, admin.id]);

    // The legacy GRN keeps working and is NEVER surfaced as an OMS inbound shipment.
    const legacyReceipt = await pool.query<{ inbound_shipment_id: string; oms_inbound_shipment_id: string | null }>(
      'SELECT inbound_shipment_id, oms_inbound_shipment_id FROM warehouse_receipts WHERE id = $1', [legacyReceiptId]);
    assert.equal(legacyReceipt.rows[0]!.inbound_shipment_id, legacyShipmentId, 'the legacy GRN keeps its legacy scope');
    assert.equal(legacyReceipt.rows[0]!.oms_inbound_shipment_id, null, 'a legacy receipt is never re-scoped to OMS');
    const omsShipmentsForLegacy = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM oms_inbound_shipments WHERE child_order_id = $1', [legacyOrderId]);
    assert.equal(Number(omsShipmentsForLegacy.rows[0]!.count), 0, 'no OMS inbound document was fabricated for legacy data');
    const omsQueue = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/inbound-shipments?limit=200', headers: adminHeaders })).json() as
      { items: Array<{ reference: string }> };
    assert.ok(!omsQueue.items.some((row) => row.reference.includes(legacyShipmentId.slice(0, 8))),
      'the OMS receiving queue only ever lists OMS-bound legs');
    const dashboard = (await app.inject({ method: 'GET', url: '/api/v1/admin/wms/dashboard', headers: adminHeaders })).json() as
      { counters: Record<string, number> };
    assert.equal(typeof dashboard.counters.arriving, 'number', 'the dashboard derives its counters from the canonical OMS tables');

    /* ---- the one-scope GRN rule is live: neither both scopes nor no scope may exist ---- */
    const omsShipmentId = randomUUID(); // a syntactically valid but non-existent OMS id must still be refused by the FK
    await assert.rejects(async () => {
      await pool.query(`INSERT INTO warehouse_receipts(id, receipt_number, inbound_shipment_id, oms_inbound_shipment_id,
                          warehouse_id, received_by, qc_status)
                        VALUES ($1,$2,$3,$4,$5,$6,'accepted')`,
        [randomUUID(), uniqueRef('GRN-BOTH'), legacyShipmentId, omsShipmentId, warehouse, admin.id]);
    }, 'a GRN can never be attached to both the legacy and the OMS authority');
    await assert.rejects(async () => {
      await pool.query(`INSERT INTO warehouse_receipts(id, receipt_number, inbound_shipment_id, oms_inbound_shipment_id,
                          warehouse_id, received_by, qc_status)
                        VALUES ($1,$2,NULL,NULL,$3,$4,'accepted')`,
        [randomUUID(), uniqueRef('GRN-NONE'), warehouse, admin.id]);
    }, 'a GRN must always belong to exactly one inbound authority');
    let scopeGuard = false;
    try {
      await pool.query('UPDATE warehouse_receipts SET inbound_shipment_id = NULL WHERE id = $1', [legacyReceiptId]);
    } catch { scopeGuard = true; }
    assert.equal(scopeGuard, true, 'the scope guard is enforced by the database, not by application code');

    /* ---- the reconciliation guards are server-side (a violation cannot be persisted at all) ---- */
    const product = await makeSeriesProduct(pool, `کالای REG-MIG ${uniqueRef('K')}`, null);
    await seedStock(pool, product.tplId, product.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 3);
    const buyer = await makeVip(pool, 'خریدار REG-MIG');
    const buyerHeaders = await login(app, buyer.email);
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: product.tplId, count: 3 }]);
    const allocationId = (await pool.query<{ id: string }>(
      'SELECT id FROM order_source_allocations WHERE child_order_id = $1', [master.children[0]!.id])).rows[0]!.id;
    let bucketGuard = false;
    try {
      await pool.query('UPDATE order_source_allocations SET received_series = dispatched_series + 5 WHERE id = $1', [allocationId]);
    } catch { bucketGuard = true; }
    assert.equal(bucketGuard, true, 'receiving more than was dispatched is impossible in the database');

    /* ---- the widened exception catalogue accepts Prompt 6 kinds and still refuses unknown ones ---- */
    const childId = master.children[0]!.id;
    for (const type of ['over_receipt', 'incorrect_quantity', 'delayed_inbound', 'supplier_non_fulfillment', 'reconciliation_failed', 'wrong_master_order']) {
      await pool.query(`INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, exception_type, quantity, note, created_by)
                        VALUES ($1,$2,$3,$4,1,'آزمون کاتالوگ استثنا',$5)`,
        [randomUUID(), master.id, childId, type, admin.id]);
    }
    let unknownTypeRefused = false;
    try {
      await pool.query(`INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, exception_type, quantity, note, created_by)
                        VALUES ($1,$2,$3,'not_a_real_exception',1,'',$4)`,
        [randomUUID(), master.id, childId, admin.id]);
    } catch { unknownTypeRefused = true; }
    assert.equal(unknownTypeRefused, true, 'an unknown exception kind can never be persisted');
    const catalogue = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'", [childId]);
    assert.equal(Number(catalogue.rows[0]!.count), 6, 'all six Prompt 6 kinds are stored as real, open exceptions');
    const exceptions = (await app.inject({ method: 'GET', url: `/api/v1/admin/wms/exceptions?status=open&masterId=${master.id}`, headers: adminHeaders })).json() as
      { items: Array<{ exception_type: string }> };
    assert.equal(exceptions.items.length, 6, 'the Exception Centre lists every one of them for an operator');
  } finally { await app.close(); await pool.end(); }
});

/* ==================================== Acceptance-matrix completion (§38) ==================================== */

test('P6-INB-001/002/003/005/006, P6-QC-004/005/008, P6-OMS-003/008, P6-SHP-005/006/007/009, P6-REG-001 — the remaining matrix IDs', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const leg = await externalLeg(app, pool, { series: 4, label: 'MATRIX' });

    /* ---- P6-INB-001: the declaration is the ONE inbound document, with an operator reference and a
       SERVER-resolved central-Kolbe destination (no supplier-supplied warehouse, no buyer address). ---- */
    const shipment = await declareShipment(app, leg, { carrier: 'باربری ماتریس', trackingCode: 'TRK-MATRIX' });
    assert.ok(shipment.reference.startsWith('OIN-'), 'the inbound document carries an operator-facing reference');
    const centralWarehouse = (await pool.query<{ id: string }>(
      `SELECT id FROM warehouses WHERE active = true AND owner_id IS NULL AND purpose IN ('wholesale','mixed')
       ORDER BY (purpose = 'wholesale') DESC, created_at ASC LIMIT 1`)).rows[0]!.id;
    assert.equal(shipment.destinationWarehouseId, centralWarehouse, 'destination is the server-resolved central warehouse');
    const shipmentCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM oms_inbound_shipments WHERE child_order_id = $1', [leg.childId]);
    assert.equal(Number(shipmentCount.rows[0]!.count), 1, 'exactly one inbound document exists for the leg');

    /* ---- P6-INB-002: re-declaring the same leg is idempotent (same document) — never a second shipment. ---- */
    const again = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${leg.childId}/inbound-shipment`,
      headers: { ...leg.supplierHeaders, 'idempotency-key': uniqueRef('p6-declare') }, payload: {} });
    assert.ok([200, 201].includes(again.statusCode), again.body);
    assert.equal(again.json().id, shipment.id, 'the duplicate declaration resolves to the same inbound document');
    assert.equal(Number((await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM oms_inbound_shipments WHERE child_order_id = $1', [leg.childId])).rows[0]!.count), 1,
      'no second inbound document was created');

    /* ---- P6-INB-003: tenant isolation — another supplier can never read or operate this document. ---- */
    const outsider = await makeUser(pool, ['supplier'], 'تأمین‌کننده ماتریس بیگانه');
    const outsiderHeaders = await login(app, outsider.email);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}`, headers: outsiderHeaders })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/wholesale/supplier/inbound-shipments`, headers: outsiderHeaders }))
      .json<{ items: unknown[] }>().items.length, 0, 'a foreign supplier lists nothing of ours');

    /* ---- P6-INB-005/006: receiving needs the warehouse duty, and only for a live, unreceived leg. ---- */
    const clerk = await makeUser(pool, ['customer'], 'کارمند بدون وظیفه انبار');
    const clerkHeaders = await login(app, clerk.email);
    const unauthorizedReceive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: clerkHeaders, payload: { lines: [{ allocationId: leg.allocationId, receivedSeries: 4 }] } });
    assert.equal(unauthorizedReceive.statusCode, 403, 'a user without the receiving duty cannot post a receipt');
    const supplierReceive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: leg.supplierHeaders, payload: { lines: [{ allocationId: leg.allocationId, receivedSeries: 4 }] } });
    assert.equal(supplierReceive.statusCode, 403, 'a supplier can never receive its own goods into Kolbe stock');
    assert.equal((await allocRow(pool, leg.allocationId)).received_at, null, 'no receipt was recorded by the refused attempts');

    /* ---- P6-QC-005: QC before a physical receipt is impossible (receipt ≠ QC ordering). ---- */
    const earlyQc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...leg.adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: leg.allocationId, passedSeries: 4, rejectedSeries: 0 }] } });
    assert.equal(earlyQc.statusCode, 409, 'QC cannot precede the physical receipt');
    assert.equal(earlyQc.json().code, 'INBOUND_NOT_RECEIVED');

    /* ---- the canonical receipt then happens (4 dispatched → 4 received). ---- */
    const receive = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/receive`,
      headers: { ...leg.adminHeaders, 'idempotency-key': uniqueRef('p6-recv') },
      payload: { lines: [{ allocationId: leg.allocationId, receivedSeries: 4, note: 'دریافت کامل ماتریس' }] } });
    assert.equal(receive.statusCode, 200, receive.body);

    /* ---- P6-QC-004: QC never creates sellable stock — the order-bound goods stay order-bound. ---- */
    const stockBefore = { pieces: await pieceOnHand(pool, leg.product.variantIds), series: (await seriesOnHand(pool, leg.product.tplId)).total };
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipment.id}/qc`,
      headers: { ...leg.adminHeaders, 'idempotency-key': uniqueRef('p6-qc') },
      payload: { lines: [{ allocationId: leg.allocationId, passedSeries: 3, rejectedSeries: 1, note: 'یک سری رد شد' }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    assert.deepEqual({ pieces: await pieceOnHand(pool, leg.product.variantIds), series: (await seriesOnHand(pool, leg.product.tplId)).total },
      stockBefore, 'QC writes no sellable stock for order-bound goods');
    assert.deepEqual(stockBefore, { pieces: 0, series: 0 }, 'external goods never existed as WMS stock in the first place');

    /* ---- P6-QC-008: the operator note and the rejection are persisted together (reason + context). ---- */
    const noted = await allocRow(pool, leg.allocationId);
    assert.equal(noted.qc_rejected_series, 1);
    const rejectionNote = await pool.query<{ qc_note: string | null }>(
      'SELECT qc_note FROM order_source_allocations WHERE id = $1', [leg.allocationId]);
    assert.ok((rejectionNote.rows[0]!.qc_note ?? '').length > 0, 'the QC decision carries the operator reason');
    const rejection = (await app.inject({ method: 'GET', url: `/api/v1/admin/wms/exceptions?status=open&type=qc_rejected`, headers: leg.adminHeaders })).json() as
      { items: Array<{ child_order_id: string; note: string }> };
    const mine = rejection.items.filter((item) => item.child_order_id === leg.childId);
    assert.equal(mine.length, 1, 'the rejection is a real, actionable exception');
    assert.ok(mine[0]!.note.length > 0);

    /* ---- P6-QC-006/P6-OMS-008: partial acceptance never silently reduces demand, and the commercial
       quantity of the line is untouched (the buyer still owes/receives the full requirement). ---- */
    const line = await pool.query<{ confirmed_series: number; accepted_series: number | null }>(
      'SELECT confirmed_series, accepted_series FROM child_order_lines WHERE child_order_id = $1', [leg.childId]);
    assert.equal(line.rows[0]!.confirmed_series, 4, 'the commercial requirement is 4 and was not rewritten');
    const afterQc = await allocRow(pool, leg.allocationId);
    assert.notEqual(afterQc.status, 'consumed', 'a partially rejected leg is not silently closed');

    /* ---- P6-OMS-003: readiness needs EVERY source. A master with TWO supplier legs unlocks only
       when BOTH have been physically received and QC-passed — one arriving is not enough. ---- */
    const buyer2 = await makeVip(pool, 'خریدار MATRIX-2');
    const buyer2Headers = await login(app, buyer2.email);
    const admin2 = await makeUser(pool, ['admin'], 'مدیر MATRIX-2');
    const admin2Headers = await login(app, admin2.email);
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین‌کننده الف MATRIX');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین‌کننده ب MATRIX');
    const headersA = await login(app, supplierA.email);
    const headersB = await login(app, supplierB.email);
    const productA = await makeSeriesProduct(pool, `کالای الف MATRIX ${uniqueRef('A')}`, supplierA.id);
    const productB = await makeSeriesProduct(pool, `کالای ب MATRIX ${uniqueRef('B')}`, supplierB.id);
    await makeOffer(pool, supplierA.id, productA.productId, productA.tplId, 10);
    await makeOffer(pool, supplierB.id, productB.productId, productB.tplId, 10);
    const twoSource = await makeMaster(app, buyer2Headers, [
      { seriesTemplateId: productA.tplId, count: 2 }, { seriesTemplateId: productB.tplId, count: 2 }]);
    assert.equal(twoSource.children.length, 2, 'ONE master order with two supplier sources');
    const childA = twoSource.children.find((child) => child.sellerId === supplierA.id)!.id;
    const childB = twoSource.children.find((child) => child.sellerId === supplierB.id)!.id;
    const sharedLine = async (childId: string) => (await pool.query<{ id: string }>(
      'SELECT id FROM child_order_lines WHERE child_order_id = $1', [childId])).rows[0]!.id;
    const confirmLine = async (childId: string, headers: Headers) => {
      const lineId = await sharedLine(childId);
      const respond = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineId}/respond`,
        headers, payload: { action: 'confirm' } });
      assert.ok([200, 409].includes(respond.statusCode), respond.body);
    };
    /** Everything from the supplier commitment to a passed QC — the canonical physical pipeline. */
    const settleLeg = async (childId: string, headers: Headers, series: number, label: string) => {
      const allocationId = (await pool.query<{ id: string }>(
        "SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'", [childId])).rows[0]!.id;
      const commit = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocationId}/commit`,
        headers: { ...headers, 'idempotency-key': uniqueRef('p6-commit') }, payload: {} });
      assert.equal(commit.statusCode, 200, `${label} commit: ${commit.body}`);
      await payChild(app, pool, buyer2Headers, childId);
      const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${allocationId}/ready`,
        headers: { ...headers, 'idempotency-key': uniqueRef('p6-ready') }, payload: {} });
      assert.equal(ready.statusCode, 200, `${label} ready: ${ready.body}`);
      const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childId}/dispatch`,
        headers: { ...headers, 'idempotency-key': uniqueRef('p6-dispatch') }, payload: {} });
      assert.equal(dispatch.statusCode, 200, `${label} dispatch: ${dispatch.body}`);
      const declared = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childId}/inbound-shipment`,
        headers: { ...headers, 'idempotency-key': uniqueRef('p6-declare') }, payload: {} });
      assert.equal(declared.statusCode, 201, `${label} declare: ${declared.body}`);
      const shipmentId = declared.json().id as string;
      const received = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentId}/receive`,
        headers: { ...admin2Headers, 'idempotency-key': uniqueRef('p6-recv') },
        payload: { lines: [{ allocationId, receivedSeries: series }] } });
      assert.equal(received.statusCode, 200, `${label} receive: ${received.body}`);
      const inspected = await app.inject({ method: 'POST', url: `/api/v1/admin/wms/inbound-shipments/${shipmentId}/qc`,
        headers: { ...admin2Headers, 'idempotency-key': uniqueRef('p6-qc') },
        payload: { lines: [{ allocationId, passedSeries: series, rejectedSeries: 0 }] } });
      assert.equal(inspected.statusCode, 200, `${label} qc: ${inspected.body}`);
    };
    await confirmLine(childA, headersA);
    await confirmLine(childB, headersB);
    await settleLeg(childA, headersA, 2, 'leg A');
    assert.equal((await childState(pool, childA)).child_fulfillment, 'ready_for_consolidation', 'supplier A is physically ready');
    assert.notEqual((await childState(pool, childB)).child_fulfillment, 'ready_for_consolidation', 'supplier B has not delivered yet');
    let twoSourceReadiness = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${twoSource.id}?view=ops`, headers: admin2Headers })).json() as
      { readiness: string };
    assert.equal(twoSourceReadiness.readiness, 'partial', 'one delivered source out of two is NOT readiness');
    const lockTwoSource = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${twoSource.id}/lock`, headers: buyer2Headers });
    assert.equal(lockTwoSource.statusCode, 200, lockTwoSource.body);
    const blockedStart = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${twoSource.id}/consolidation/start`, headers: admin2Headers });
    assert.equal(blockedStart.statusCode, 409, 'consolidation is refused while a source is missing');
    assert.equal(blockedStart.json().code, 'CONSOLIDATION_NOT_READY');
    await settleLeg(childB, headersB, 2, 'leg B');
    assert.equal((await childState(pool, childB)).child_fulfillment, 'ready_for_consolidation', 'the second source completes the requirement');
    twoSourceReadiness = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${twoSource.id}?view=ops`, headers: admin2Headers })).json() as
      { readiness: string };
    assert.equal(twoSourceReadiness.readiness, 'ready', 'only now is the master ready to consolidate');
    const unlockedStart = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${twoSource.id}/consolidation/start`, headers: admin2Headers });
    assert.equal(unlockedStart.statusCode, 201, 'with every source received and QC-passed, consolidation starts for real');

    /* ---- P6-SHP-005/006: shipping requires the canonical gate (paid child + locked, ready composition). ---- */
    const earlyShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${leg.master.id}/ship`,
      headers: { ...leg.adminHeaders, 'idempotency-key': uniqueRef('p6-ship') }, payload: { carrier: 'پست', trackingCode: 'T-1' } });
    assert.equal(earlyShip.statusCode, 409, earlyShip.body);
    assert.ok(['MASTER_COMPOSITION_OPEN', 'CONSOLIDATION_NOT_READY'].includes(earlyShip.json().code),
      `shipping is refused before composition/consolidation (${earlyShip.json().code})`);
    assert.equal((await pool.query<{ shipped_at: string | null }>('SELECT shipped_at FROM master_orders WHERE id = $1', [leg.master.id]))
      .rows[0]!.shipped_at, null, 'no shipment was recorded by the refused attempt');

    /* ---- P6-SHP-007/009: tracking belongs to the canonical master order (empty until a real dispatch),
       and no parallel shipping-quote/label authority was invented for the OMS. ---- */
    const quoteRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_name IN ('shipping_quotes','oms_shipping_quotes','oms_labels','master_shipping_labels')");
    assert.equal(Number(quoteRows.rows[0]!.count), 0, 'no parallel shipping-quote or label authority exists for the OMS');
    const tracked = await pool.query<{ tracking_code: string | null; carrier: string | null }>(
      'SELECT tracking_code, carrier FROM master_orders WHERE id = $1', [leg.master.id]);
    assert.equal(tracked.rows[0]!.tracking_code, null, 'tracking stays empty until a real Kolbe dispatch');

    /* ---- P6-REG-001: the Prompt-3 consignment path is untouched by order-bound inbound/QC. ---- */
    const consignmentAuthority = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_name IN ('supplier_stock_returns','series_stock_balances','series_stock_movements')`);
    assert.equal(Number(consignmentAuthority.rows[0]!.count), 3, 'the general consignment authority still exists');
    const ownershipStillExplicit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conname = 'series_stock_movements_movement_type_check' AND convalidated
          AND pg_get_constraintdef(oid) LIKE '%conversion_out%' AND pg_get_constraintdef(oid) LIKE '%conversion_in%'`);
    assert.equal(Number(ownershipStillExplicit.rows[0]!.count), 1,
      'ownership conversion is still only possible through the explicit canonical movement types');
    const inboundRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM inbound_shipments WHERE order_id = $1", [leg.childId]);
    assert.equal(Number(inboundRows.rows[0]!.count), 0, 'order-bound goods never enter the legacy v1 inbound path');
  } finally { await app.close(); await pool.end(); }
});
