/** Master Prompt 2 — VIP Wholesale Master/Child OMS tests (§161-§189).
 *  Covers: the VIP-2048 multi-seller reference scenario (1 master / 3 children,
 *  per-source eligibility), the hard payment gate + batch payment, supplier
 *  confirm/counter/reject independence, reservation TTL expiry + stale intents +
 *  late gateway callback, order-bound external fulfillment with QC shortage
 *  (general stock untouched), consolidation + master final shipment without
 *  blanket supplier earnings, and IDOR/security invariants. */
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
  NODE_ENV: 'test', PORT: 4031, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('TestPassword123456!'), label]);
  for (const role of roles) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  // OMS supplier actors model the real approved/active Supplier state enforced by Prompt 5.
  if (roles.includes('supplier')) await pool.query(
    "INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')", [id, label]);
  return { id, email };
}

async function login(app: App, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeVipBuyer(pool: Pool, label: string) {
  const buyer = await makeUser(pool, ['customer'], label);
  const planId = randomUUID();
  await pool.query(`INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,'پلن VIP تست',0,'{}')`,
    [planId, `vip-${planId.slice(0, 8)}`]);
  await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`,
    [randomUUID(), buyer.id, planId]);
  return buyer;
}

async function makeWholesaleWarehouse(pool: Pool, label: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,'wholesale')`,
    [id, `WH-${id.slice(0, 8)}`, label]);
  return id;
}

/** Product + 2-variant series template (pps=2). ownerSupplierId null → kolbe product. */
async function makeSeriesProduct(pool: Pool, name: string, ownerSupplierId: string | null) {
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id, supplier_id, brand, name, category, status, cash_price_rial, wholesale_price_rial, owner_type, retail_enabled, wholesale_enabled)
     VALUES ($1,$2,'برند تست',$3,'هودی','published',100000000,90000000,$4,false,true)`,
    [productId, ownerSupplierId, name, ownerSupplierId ? 'supplier' : 'kolbe']);
  const v1 = randomUUID(); const v2 = randomUUID();
  await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','مشکی'),($4,$2,$5,'L','مشکی')`,
    [v1, productId, `OMS-${productId.slice(0, 8)}-M`, v2, `OMS-${productId.slice(0, 8)}-L`]);
  const tplId = randomUUID();
  await pool.query(`INSERT INTO series_templates(id, product_id, name) VALUES ($1,$2,'سری تست')`, [tplId, productId]);
  await pool.query(`INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,1),($4,$2,$5,1)`,
    [randomUUID(), tplId, v1, randomUUID(), v2]);
  return { productId, variantIds: [v1, v2], tplId };
}

/** Seed consistent physical series stock (series balance + covering piece balances). */
async function seedSeriesStock(pool: Pool, tplId: string, variantIds: string[], warehouseId: string,
  owner: { ownerType: 'kolbe' | 'supplier'; supplierId: string | null }, series: number) {
  await pool.query(
    `INSERT INTO series_stock_balances(id, series_template_id, warehouse_id, owner_type, supplier_id, on_hand)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), tplId, warehouseId, owner.ownerType, owner.supplierId, series]);
  for (const variantId of variantIds) {
    await pool.query(
      `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain, on_hand)
       VALUES ($1,$2,'wholesale',$3)
       ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO UPDATE SET on_hand = stock_balances.on_hand + $3`,
      [variantId, warehouseId, series]);
  }
}

async function makeOffer(pool: Pool, supplierId: string, productId: string, tplId: string | null, opts: {
  declaredCapacity?: number; minOrderSeries?: number; maxOrderSeries?: number | null;
} = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO supplier_offers(id, supplier_id, product_id, series_template_id, status, fulfillment_mode,
       wholesale_price_rial, min_order_series, max_order_series, declared_capacity, capacity_confirmed_at)
     VALUES ($1,$2,$3,$4,'active','order_driven',180000000,$5,$6,$7,now())`,
    [id, supplierId, productId, tplId, opts.minOrderSeries ?? 1, opts.maxOrderSeries ?? null, opts.declaredCapacity ?? 0]);
  return id;
}

async function createMaster(app: App, headers: Record<string, string>, items: Array<{ seriesTemplateId: string; count: number }>) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/wholesale/masters',
    headers: { ...headers, 'idempotency-key': `master-${randomUUID()}` },
    payload: { items },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as {
    id: string; reference: string;
    children: Array<{ id: string; reference: string; sellerType: string; sellerId: string | null;
      supplyStatus: string; paymentEligibility: string; totalRial: string }>;
  };
}

const childBySeller = (master: { children: Array<{ sellerType: string; sellerId: string | null } & Record<string, unknown>> }, sellerId: string | null) =>
  master.children.find((c) => (sellerId === null ? c.sellerType === 'kolbe' : c.sellerId === sellerId))! as unknown as {
    id: string; reference: string; supplyStatus: string; paymentEligibility: string; totalRial: string };

async function payIntent(pool: Pool, intentId: string, amountRial: string) {
  return applyVerifiedPayment(pool, {
    provider: 'nextpay', providerEventId: `evt-${randomUUID()}`, providerReference: `ref-${randomUUID().slice(0, 12)}`,
    intentId, amountRial, paidAt: new Date(),
  });
}

/* ------------------------------------------------------------------ */

test('series price is canonical: total price, component sum, exact rial allocation and historical order snapshot', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر قیمت سری');
    const headers = await login(app, admin.email);
    const buyer = await makeVipBuyer(pool, 'خریدار قیمت سری');
    const buyerHeaders = await login(app, buyer.email);
    const world = await makeSeriesProduct(pool, `سری قیمت ${randomUUID().slice(0,8)}`, null);
    const warehouse = await makeWholesaleWarehouse(pool, 'انبار قیمت سری');
    await seedSeriesStock(pool, world.tplId, world.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 10);
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${world.tplId}`, headers,
      payload: { pricingMode: 'series_total', totalPriceRial: '10000001', minOrderSeries: 1 } });
    assert.equal(updated.statusCode, 200, updated.body);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/series-templates/${world.tplId}`, headers });
    assert.equal(detail.json().pricePerSeriesRial, '10000001');
    const order = await createMaster(app, buyerHeaders, [{ seriesTemplateId: world.tplId, count: 3 }]);
    assert.equal(order.children[0]!.totalRial, '30000003');
    const before = await pool.query('SELECT commercial_snapshot FROM child_order_lines WHERE master_order_id=$1', [order.id]);
    assert.equal(before.rows[0].commercial_snapshot.unitSeriesPriceRial, '10000001');
    const changed = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${world.tplId}`, headers,
      payload: { totalPriceRial: '20000000' } });
    assert.equal(changed.statusCode, 200, changed.body);
    const after = await pool.query('SELECT commercial_snapshot FROM child_order_lines WHERE master_order_id=$1', [order.id]);
    assert.deepEqual(after.rows, before.rows);
    const compositionChange = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${world.tplId}`, headers,
      payload: { items: world.variantIds.map((variantId) => ({ variantId, quantityPerSeries: 2 })) } });
    assert.equal(compositionChange.statusCode, 409, compositionChange.body);
    const componentTemplate = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers, payload: {
      productId: world.productId, name: 'سری جمع اجزا', pricingMode: 'component_sum',
      items: world.variantIds.map((variantId, index) => ({ variantId, quantityPerSeries: 2, unitPriceRial: index ? '3000000' : '2000000' })),
    } });
    assert.equal(componentTemplate.statusCode, 201, componentTemplate.body);
    const sum = await app.inject({ method: 'GET', url: `/api/v1/series-templates/${componentTemplate.json().id}`, headers });
    assert.equal(sum.json().pricePerSeriesRial, '10000000');
  } finally { await pool.end(); await app.close(); }
});

test('VIP-2048 reference scenario: 1 master / 3 children, per-source eligibility, payment gate, batch pay (§165-§167, §57)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const warehouseId = await makeWholesaleWarehouse(pool, 'انبار مرکزی عمده');
    const buyer = await makeVipBuyer(pool, 'vip-2048');
    const intruder = await makeVipBuyer(pool, 'vip-intruder');
    const supplierA = await makeUser(pool, ['supplier'], 'supplier-a');
    const supplierB = await makeUser(pool, ['supplier'], 'supplier-b');
    const buyerHeaders = await login(app, buyer.email);
    const intruderHeaders = await login(app, intruder.email);
    const supplierAHeaders = await login(app, supplierA.email);
    const supplierBHeaders = await login(app, supplierB.email);

    const kolbe = await makeSeriesProduct(pool, 'هودی کلبه', null);
    await seedSeriesStock(pool, kolbe.tplId, kolbe.variantIds, warehouseId, { ownerType: 'kolbe', supplierId: null }, 10);
    const prodA = await makeSeriesProduct(pool, 'هودی تأمین A', supplierA.id);
    await seedSeriesStock(pool, prodA.tplId, prodA.variantIds, warehouseId, { ownerType: 'supplier', supplierId: supplierA.id }, 5);
    const prodB = await makeSeriesProduct(pool, 'هودی تأمین B', supplierB.id);
    const offerB = await makeOffer(pool, supplierB.id, prodB.productId, prodB.tplId, { declaredCapacity: 10 });

    // ---- creation: kolbe 2 + A(stock-at-kolbe) 3 + B(external) 4 → 3 children ----
    const master = await createMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbe.tplId, count: 2 },
      { seriesTemplateId: prodA.tplId, count: 3 },
      { seriesTemplateId: prodB.tplId, count: 4 },
    ]);
    assert.equal(master.children.length, 3);
    const childKolbe = childBySeller(master, null);
    const childA = childBySeller(master, supplierA.id);
    const childB = childBySeller(master, supplierB.id);
    // §22/§24: physical sources are READY immediately; external is NOT eligibility (§23).
    assert.equal(childKolbe.paymentEligibility, 'ready');
    assert.equal(childA.paymentEligibility, 'ready');
    assert.equal(childB.paymentEligibility, 'blocked_supply_pending');
    assert.equal(childB.supplyStatus, 'awaiting_supplier');

    // physical reservations are owner-scoped; declared capacity untouched before confirm (§23).
    const kolbeBal = await pool.query('SELECT reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.equal(kolbeBal.rows[0].reserved, 2);
    const aBal = await pool.query('SELECT reserved FROM series_stock_balances WHERE series_template_id = $1', [prodA.tplId]);
    assert.equal(aBal.rows[0].reserved, 3);
    const offerBefore = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerB]);
    assert.equal(offerBefore.rows[0].reserved_external, 0);

    // §66: READY children carry a frozen commercial snapshot.
    const lockedSnapshots = await pool.query(
      'SELECT snapshot_locked_at FROM child_order_lines WHERE child_order_id = ANY($1::uuid[])',
      [[childKolbe.id, childA.id]]);
    assert.ok(lockedSnapshots.rows.every((r) => r.snapshot_locked_at !== null));

    // ---- hard payment gate (§139): no intent for the blocked child ----
    const blockedIntent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childB.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(blockedIntent.statusCode, 409, blockedIntent.body);
    assert.equal(blockedIntent.json().code, 'PAYMENT_NOT_READY');

    // ---- composition lock blocked while a child awaits the supplier ----
    const earlyLock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(earlyLock.statusCode, 409);
    assert.equal(earlyLock.json().code, 'SUPPLIER_CONFIRMATION_REQUIRED');

    // ---- IDOR: foreign buyer cannot read the master; supplier A cannot answer B's line ----
    const foreignRead = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}`, headers: intruderHeaders });
    assert.equal(foreignRead.statusCode, 403);
    const lineB = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childB.id]);
    const crossRespond = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineB.rows[0].id}/respond`,
      headers: supplierAHeaders, payload: { action: 'confirm' } });
    assert.equal(crossRespond.statusCode, 403);

    // ---- supplier B panel shows the child without buyer identity; confirm reserves capacity atomically ----
    const panel = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/child-orders', headers: supplierBHeaders });
    assert.equal(panel.statusCode, 200, panel.body);
    const panelItems = panel.json().items as Array<Record<string, unknown>>;
    assert.ok(panelItems.some((row) => row.id === childB.id));
    assert.ok(!panel.body.includes(buyer.email), 'supplier privacy: no buyer identity (§72)');

    const confirm = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineB.rows[0].id}/respond`,
      headers: supplierBHeaders, payload: { action: 'confirm' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(confirm.json().child.paymentEligibility, 'ready');
    const offerAfter = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerB]);
    assert.equal(offerAfter.rows[0].reserved_external, 4);

    // ---- batch payment: ONE intent, SUM(allocations) == amount; duplicate intents rejected (§57-§59, §143) ----
    const batch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/batch-payment-intent`,
      headers: buyerHeaders, payload: { childIds: [childKolbe.id, childA.id] } });
    assert.equal(batch.statusCode, 201, batch.body);
    const batchJson = batch.json() as { intentId: string; amountRial: string };
    const expectedAmount = (BigInt(childKolbe.totalRial) + BigInt(childA.totalRial)).toString();
    assert.equal(batchJson.amountRial, expectedAmount);
    const dup = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childKolbe.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().code, 'PAYMENT_INTENT_EXISTS');

    // ---- atomic verification pays BOTH children, per-child invoices, third child untouched (§60, §106) ----
    await payIntent(pool, batchJson.intentId, batchJson.amountRial);
    const paid = await pool.query('SELECT id, status, payment_eligibility FROM orders WHERE id = ANY($1::uuid[]) ORDER BY created_at',
      [[childKolbe.id, childA.id, childB.id]]);
    assert.deepEqual(paid.rows.map((r) => r.status).sort(), ['paid', 'paid', 'pending_payment'].sort());
    const invoices = await pool.query('SELECT order_id FROM invoices WHERE order_id = ANY($1::uuid[])', [[childKolbe.id, childA.id]]);
    assert.equal(invoices.rows.length, 2, 'one invoice per paid child');
    const hooks = await pool.query(
      `SELECT aggregate_id FROM outbox_events WHERE event_type = 'child_order.payment_verified' AND aggregate_id = ANY($1::uuid[])`,
      [[childKolbe.id, childA.id]]);
    assert.equal(hooks.rows.length, 2, 'child_order.payment_verified finance hooks (§128)');

    // paid child can no longer be removed without the refund workflow (§44).
    const removePaid = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childKolbe.id}/remove`, headers: buyerHeaders });
    assert.equal(removePaid.statusCode, 409);
    assert.equal(removePaid.json().code, 'CHILD_ALREADY_PAID');
  } finally { await app.close(); await pool.end(); }
});

test('hybrid 6+4, counter→accept with revalidation, MOQ, reject independence (§25, §35-§40, §118)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const warehouseId = await makeWholesaleWarehouse(pool, 'انبار عمده هیبرید');
    const buyer = await makeVipBuyer(pool, 'vip-hybrid');
    const supplierC = await makeUser(pool, ['supplier'], 'supplier-c');
    const supplierD = await makeUser(pool, ['supplier'], 'supplier-d');
    const supplierE = await makeUser(pool, ['supplier'], 'supplier-e');
    const buyerHeaders = await login(app, buyer.email);
    const cHeaders = await login(app, supplierC.email);
    const dHeaders = await login(app, supplierD.email);
    const eHeaders = await login(app, supplierE.email);

    // ---- hybrid: 6 stock-at-kolbe + 4 external for ONE line (§25) ----
    const prodC = await makeSeriesProduct(pool, 'کالای هیبرید C', supplierC.id);
    await seedSeriesStock(pool, prodC.tplId, prodC.variantIds, warehouseId, { ownerType: 'supplier', supplierId: supplierC.id }, 6);
    const offerC = await makeOffer(pool, supplierC.id, prodC.productId, prodC.tplId, { declaredCapacity: 10, minOrderSeries: 2 });

    // MOQ guard (§118): below the offer minimum fails with a machine code.
    const belowMin = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': `moq-${randomUUID()}` },
      payload: { items: [{ seriesTemplateId: prodC.tplId, count: 1 }] } });
    assert.equal(belowMin.statusCode, 409);
    assert.equal(belowMin.json().code, 'BELOW_MIN_ORDER_SERIES');

    const master = await createMaster(app, buyerHeaders, [{ seriesTemplateId: prodC.tplId, count: 10 }]);
    const child = master.children[0]!;
    const allocations = await pool.query(
      'SELECT source_type, quantity, status FROM order_source_allocations WHERE child_order_id = $1 ORDER BY source_type', [child.id]);
    assert.deepEqual(allocations.rows.map((r) => [r.source_type, r.quantity, r.status]),
      [['supplier_external', 4, 'pending'], ['supplier_stock_at_kolbe', 6, 'reserved']]);
    assert.equal(child.paymentEligibility, 'blocked_supply_pending');

    // ---- counter: supplier proposes 8 of 10; requested stays immutable (§35) ----
    const lineC = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [child.id]);
    const counter = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineC.rows[0].id}/respond`,
      headers: cHeaders, payload: { action: 'counter', proposedSeries: 8 } });
    assert.equal(counter.statusCode, 200, counter.body);
    assert.equal(counter.json().child.paymentEligibility, 'blocked_buyer_decision');

    // the gate reports the pending counter decision (§46).
    const intentDuringCounter = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(intentDuringCounter.statusCode, 409);
    assert.equal(intentDuringCounter.json().code, 'COUNTER_OFFER_PENDING');

    // supplier cannot accept their own counter (buyer-only decision).
    const supplierAccept = await app.inject({ method: 'POST', url: `/api/v1/wholesale/lines/${lineC.rows[0].id}/decision`,
      headers: cHeaders, payload: { action: 'accept_counter' } });
    assert.equal(supplierAccept.statusCode, 403);

    const accept = await app.inject({ method: 'POST', url: `/api/v1/wholesale/lines/${lineC.rows[0].id}/decision`,
      headers: buyerHeaders, payload: { action: 'accept_counter' } });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(accept.json().child.paymentEligibility, 'ready');
    const lineAfter = await pool.query(
      'SELECT requested_series, proposed_series, confirmed_series FROM child_order_lines WHERE id = $1', [lineC.rows[0].id]);
    assert.deepEqual(lineAfter.rows[0], { requested_series: 10, proposed_series: 8, confirmed_series: 8 });
    // external shrank to 2 and got atomically reserved; totals resized to 8 series.
    const extAfter = await pool.query(
      `SELECT quantity, status FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'`, [child.id]);
    assert.deepEqual(extAfter.rows[0], { quantity: 2, status: 'reserved' });
    const offerCAfter = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerC]);
    assert.equal(offerCAfter.rows[0].reserved_external, 2);
    const totals = await pool.query('SELECT total_rial::text AS total FROM orders WHERE id = $1', [child.id]);
    assert.equal(totals.rows[0].total, (180000000n * 8n).toString());

    // ---- rejection never breaks siblings (§40): D rejects, E confirms ----
    const prodD = await makeSeriesProduct(pool, 'کالای D', supplierD.id);
    await makeOffer(pool, supplierD.id, prodD.productId, prodD.tplId, { declaredCapacity: 5 });
    const prodE = await makeSeriesProduct(pool, 'کالای E', supplierE.id);
    await makeOffer(pool, supplierE.id, prodE.productId, prodE.tplId, { declaredCapacity: 5 });
    const master2 = await createMaster(app, buyerHeaders, [
      { seriesTemplateId: prodD.tplId, count: 2 }, { seriesTemplateId: prodE.tplId, count: 2 },
    ]);
    const childD = childBySeller(master2, supplierD.id);
    const childE = childBySeller(master2, supplierE.id);
    const lineD = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childD.id]);
    const lineE = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childE.id]);
    const reject = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineD.rows[0].id}/respond`,
      headers: dHeaders, payload: { action: 'reject' } });
    assert.equal(reject.statusCode, 200, reject.body);
    const confirmE = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${lineE.rows[0].id}/respond`,
      headers: eHeaders, payload: { action: 'confirm' } });
    assert.equal(confirmE.statusCode, 200, confirmE.body);
    const siblings = await pool.query('SELECT id, status, composition_state, payment_eligibility FROM orders WHERE id = ANY($1::uuid[]) ORDER BY created_at',
      [[childD.id, childE.id]]);
    const rowD = siblings.rows.find((r) => r.id === childD.id)!;
    const rowE = siblings.rows.find((r) => r.id === childE.id)!;
    assert.equal(rowD.status, 'pending_payment', 'rejection does not erase the unpaid OMS child');
    assert.equal(rowD.composition_state, 'included', 'unresolved demand remains in the Master Order');
    assert.equal(rowD.payment_eligibility, 'not_ready');
    assert.equal(rowE.payment_eligibility, 'ready'); // sibling unaffected
    const pendingDemand = await pool.query(
      "SELECT quantity,status FROM order_source_allocations WHERE child_order_id=$1 AND source_type='supplier_external'", [childD.id]);
    assert.deepEqual(pendingDemand.rows, [{ quantity: 2, status: 'pending' }]);
    // The Master Order cannot lock while the rejected demand still needs explicit reassignment.
    const lock2 = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master2.id}/lock`, headers: buyerHeaders });
    assert.equal(lock2.statusCode, 409, lock2.body);
    assert.equal(lock2.json().code, 'SUPPLIER_CONFIRMATION_REQUIRED');
  } finally { await app.close(); await pool.end(); }
});

test('reservation TTL expiry releases stock, stale intents cannot pay, late callback → exception (§47-§49, §61-§62)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const warehouseId = await makeWholesaleWarehouse(pool, 'انبار عمده انقضا');
    const buyer = await makeVipBuyer(pool, 'vip-expiry');
    const admin = await makeUser(pool, ['admin', 'operations'], 'ادمین انقضا');
    const buyerHeaders = await login(app, buyer.email);
    const adminHeaders = await login(app, admin.email);

    const kolbe = await makeSeriesProduct(pool, 'کالای انقضا', null);
    await seedSeriesStock(pool, kolbe.tplId, kolbe.variantIds, warehouseId, { ownerType: 'kolbe', supplierId: null }, 6);

    // ---- child 1: due passes BEFORE payment → sweep expires it and frees stock ----
    const m1 = await createMaster(app, buyerHeaders, [{ seriesTemplateId: kolbe.tplId, count: 3 }]);
    const child1 = m1.children[0]!;
    const intent1 = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child1.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(intent1.statusCode, 201, intent1.body);
    await pool.query("UPDATE orders SET payment_due_at = now() - interval '1 minute' WHERE id = $1", [child1.id]);
    const sweep = await app.inject({ method: 'POST', url: '/api/v1/wholesale/oms/expire-sweep', headers: adminHeaders });
    assert.equal(sweep.statusCode, 200, sweep.body);
    assert.ok((sweep.json().expiredChildren as number) >= 1);
    const after1 = await pool.query('SELECT payment_eligibility FROM orders WHERE id = $1', [child1.id]);
    assert.equal(after1.rows[0].payment_eligibility, 'expired');
    const bal = await pool.query('SELECT reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.equal(bal.rows[0].reserved, 0, 'physical series released on expiry (§48)');
    // stale intent is dead (§49).
    await assert.rejects(payIntent(pool, intent1.json().intentId as string, intent1.json().amountRial as string));
    // and a new intent on the expired child is refused by the gate.
    const retry = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child1.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.json().code, 'SUPPLY_RESERVATION_EXPIRED');

    // ---- child 2: gateway callback lands AFTER due (no sweep ran) → exception + refund flag, NOT paid ----
    const m2 = await createMaster(app, buyerHeaders, [{ seriesTemplateId: kolbe.tplId, count: 2 }]);
    const child2 = m2.children[0]!;
    const intent2 = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child2.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(intent2.statusCode, 201, intent2.body);
    await pool.query("UPDATE orders SET payment_due_at = now() - interval '1 minute' WHERE id = $1", [child2.id]);
    const result = await payIntent(pool, intent2.json().intentId as string, intent2.json().amountRial as string);
    assert.equal(result.status, 'succeeded'); // gateway money arrived…
    const after2 = await pool.query('SELECT status FROM orders WHERE id = $1', [child2.id]);
    assert.equal(after2.rows[0].status, 'pending_payment', '…but the child is NOT paid (§62)');
    const exception = await pool.query(
      `SELECT exception_type, status FROM fulfillment_exceptions WHERE child_order_id = $1`, [child2.id]);
    assert.deepEqual(exception.rows[0], { exception_type: 'payment_late_callback', status: 'open' });
    const refundHook = await pool.query(
      `SELECT 1 FROM outbox_events WHERE event_type = 'child_order.refund_requested' AND aggregate_id = $1`, [child2.id]);
    assert.equal(refundHook.rows.length, 1, 'refund-required finance hook (§61/§128)');
  } finally { await app.close(); await pool.end(); }
});

test('order-bound external fulfillment: dispatch→receive 4/5→QC 3/1 → exceptions, general stock untouched (§79-§91, §177)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    await makeWholesaleWarehouse(pool, 'انبار عمده QC');
    const buyer = await makeVipBuyer(pool, 'vip-qc');
    const admin = await makeUser(pool, ['admin', 'operations'], 'ادمین کیوسی');
    const supplierF = await makeUser(pool, ['supplier'], 'supplier-f');
    const buyerHeaders = await login(app, buyer.email);
    const adminHeaders = await login(app, admin.email);
    const fHeaders = await login(app, supplierF.email);

    const prodF = await makeSeriesProduct(pool, 'کالای خارجی F', supplierF.id);
    await makeOffer(pool, supplierF.id, prodF.productId, prodF.tplId, { declaredCapacity: 10 });
    const master = await createMaster(app, buyerHeaders, [{ seriesTemplateId: prodF.tplId, count: 5 }]);
    const child = master.children[0]!;
    const line = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [child.id]);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0].id}/respond`,
      headers: fHeaders, payload: { action: 'confirm' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    const external = await pool.query<{ id: string }>(
      "SELECT id FROM order_source_allocations WHERE child_order_id=$1 AND source_type='supplier_external'", [child.id]);
    const commit = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${external.rows[0]!.id}/commit`,
      headers: fHeaders, payload: { note: 'تعهد در آزمون OMS' } });
    assert.equal(commit.statusCode, 200, commit.body);

    // dispatch before payment is blocked.
    const earlyDispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${child.id}/dispatch`,
      headers: fHeaders, payload: {} });
    assert.equal(earlyDispatch.statusCode, 409);
    assert.equal(earlyDispatch.json().code, 'PAYMENT_NOT_READY');

    const intent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(intent.statusCode, 201, intent.body);
    await payIntent(pool, intent.json().intentId as string, intent.json().amountRial as string);
    const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${external.rows[0]!.id}/ready`,
      headers: fHeaders, payload: { note: 'آماده برای انبار کلبه' } });
    assert.equal(ready.statusCode, 200, ready.body);

    // §137: the supplier cannot steer the destination — strict schema rejects it.
    const spoofDestination = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${child.id}/dispatch`,
      headers: fHeaders, payload: { destinationWarehouseId: randomUUID() } });
    assert.equal(spoofDestination.statusCode, 400);

    const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${child.id}/dispatch`,
      headers: fHeaders, payload: {} });
    assert.equal(dispatch.statusCode, 200, dispatch.body);
    assert.ok(dispatch.json().destinationWarehouseId, 'destination server-resolved (§80)');

    const alloc = await pool.query(
      `SELECT id, dispatched_series, capacity_reservation_id FROM order_source_allocations
       WHERE child_order_id = $1 AND source_type = 'supplier_external'`, [child.id]);
    assert.equal(alloc.rows[0].dispatched_series, 5);
    const capacity = await pool.query('SELECT status FROM supplier_capacity_reservations WHERE id = $1',
      [alloc.rows[0].capacity_reservation_id]);
    assert.equal(capacity.rows[0].status, 'consumed');

    // suppliers can never run QC — not even on others' goods (§135).
    const selfQc = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/qc`,
      headers: fHeaders, payload: { allocations: [{ allocationId: alloc.rows[0].id, passedSeries: 5, rejectedSeries: 0 }] } });
    assert.equal(selfQc.statusCode, 403);

    // receive 4 of 5 → lost_inbound exception; QC 3 pass / 1 reject → qc_rejected exception.
    const receive = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/receive`,
      headers: adminHeaders, payload: { allocations: [{ allocationId: alloc.rows[0].id, receivedSeries: 4 }] } });
    assert.equal(receive.statusCode, 200, receive.body);
    const qc = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/qc`,
      headers: adminHeaders, payload: { allocations: [{ allocationId: alloc.rows[0].id, passedSeries: 3, rejectedSeries: 1 }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    assert.equal(qc.json().childFulfillment, 'exception');

    const trace = await pool.query(
      `SELECT requested_series, confirmed_series, dispatched_series, received_series, qc_passed_series, qc_rejected_series
       FROM child_order_lines WHERE id = $1`, [line.rows[0].id]);
    assert.deepEqual(trace.rows[0], {
      requested_series: 5, confirmed_series: 5, dispatched_series: 5,
      received_series: 4, qc_passed_series: 3, qc_rejected_series: 1,
    }, 'full §91 quantity trace');

    // §86-§87: order-bound goods NEVER appear in general supplier stock-at-kolbe.
    const generalSeries = await pool.query('SELECT count(*)::int AS c FROM series_stock_balances WHERE series_template_id = $1', [prodF.tplId]);
    assert.equal(generalSeries.rows[0].c, 0);
    const generalPieces = await pool.query(
      'SELECT COALESCE(SUM(on_hand), 0)::int AS c FROM stock_balances WHERE variant_id = ANY($1::uuid[])', [prodF.variantIds]);
    assert.equal(generalPieces.rows[0].c, 0);

    const exceptions = await pool.query(
      `SELECT exception_type, quantity FROM fulfillment_exceptions WHERE child_order_id = $1 ORDER BY exception_type`, [child.id]);
    assert.deepEqual(exceptions.rows, [{ exception_type: 'lost_inbound', quantity: 1 }, { exception_type: 'qc_rejected', quantity: 1 }]);

    // ops resolves both (refs only — finance is Prompt 3) → child becomes ready for consolidation; accepted = 3.
    for (const row of await pool.query('SELECT id FROM fulfillment_exceptions WHERE child_order_id = $1', [child.id]).then((r) => r.rows)) {
      const resolve = await app.inject({ method: 'POST', url: `/api/v1/wholesale/exceptions/${row.id}/resolve`,
        headers: adminHeaders, payload: { resolution: 'accept_short' } });
      assert.equal(resolve.statusCode, 200, resolve.body);
    }
    const finalChild = await pool.query('SELECT child_fulfillment FROM orders WHERE id = $1', [child.id]);
    assert.equal(finalChild.rows[0].child_fulfillment, 'ready_for_consolidation');
    const accepted = await pool.query('SELECT accepted_series FROM child_order_lines WHERE id = $1', [line.rows[0].id]);
    assert.equal(accepted.rows[0].accepted_series, 3, 'accepted shrinkage is explicit, never silent (§88)');
  } finally { await app.close(); await pool.end(); }
});

test('consolidation + single master shipment; delivered children emit finance hooks, NO blanket supplier earnings (§93-§103, §128-§129)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const warehouseId = await makeWholesaleWarehouse(pool, 'انبار عمده تجمیع');
    const buyer = await makeVipBuyer(pool, 'vip-consol');
    const admin = await makeUser(pool, ['admin', 'operations'], 'ادمین تجمیع');
    const supplierG = await makeUser(pool, ['supplier'], 'supplier-g');
    const buyerHeaders = await login(app, buyer.email);
    const adminHeaders = await login(app, admin.email);

    const kolbe = await makeSeriesProduct(pool, 'کالای تجمیع کلبه', null);
    await seedSeriesStock(pool, kolbe.tplId, kolbe.variantIds, warehouseId, { ownerType: 'kolbe', supplierId: null }, 2);
    const prodG = await makeSeriesProduct(pool, 'کالای تجمیع G', supplierG.id);
    await seedSeriesStock(pool, prodG.tplId, prodG.variantIds, warehouseId, { ownerType: 'supplier', supplierId: supplierG.id }, 3);

    const master = await createMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbe.tplId, count: 1 }, { seriesTemplateId: prodG.tplId, count: 2 },
    ]);
    const childK = childBySeller(master, null);
    const childG = childBySeller(master, supplierG.id);

    const batch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/batch-payment-intent`,
      headers: buyerHeaders, payload: { childIds: [childK.id, childG.id] } });
    assert.equal(batch.statusCode, 201, batch.body);
    await payIntent(pool, batch.json().intentId as string, batch.json().amountRial as string);

    // consolidation cannot start before lock and before children are picked.
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const early = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().code, 'CONSOLIDATION_NOT_READY');

    for (const childId of [childK.id, childG.id]) {
      const pick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/pick`, headers: adminHeaders });
      assert.equal(pick.statusCode, 200, pick.body);
      assert.equal(pick.json().childFulfillment, 'ready_for_consolidation');
    }
    // pick consumed the kolbe series (1 of 2) and the supplier-owned series (2 of 3).
    const kolbeBal = await pool.query('SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.deepEqual(kolbeBal.rows[0], { on_hand: 1, reserved: 0 });

    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    const consolidationId = start.json().id as string;
    assert.match(start.json().reference as string, /^CON-\d+$/);
    // §146: a second start is impossible.
    const doubleStart = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/consolidation/start`, headers: adminHeaders });
    assert.equal(doubleStart.statusCode, 409);

    // §97: wrong item rejected; duplicate scan rejected; then verify both real items.
    const wrong = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: randomUUID() } });
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().code, 'WRONG_CONSOLIDATION_ITEM');
    const lines = await pool.query('SELECT id FROM child_order_lines WHERE master_order_id = $1', [master.id]);
    for (const row of lines.rows) {
      const verify = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
        headers: adminHeaders, payload: { lineId: row.id } });
      assert.equal(verify.statusCode, 200, verify.body);
    }
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: lines.rows[0].id } });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().code, 'DUPLICATE_CONSOLIDATION_SCAN');

    const complete = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });
    assert.equal(complete.statusCode, 200, complete.body);
    const pack = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders });
    assert.equal(pack.statusCode, 200, pack.body);

    // §103: ONE master-level final shipment.
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: adminHeaders, payload: { carrier: 'باربری تست', trackingCode: 'TRK-123456' } });
    assert.equal(ship.statusCode, 200, ship.body);
    const deliver = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/deliver`, headers: adminHeaders });
    assert.equal(deliver.statusCode, 200, deliver.body);

    const delivered = await pool.query('SELECT status, child_fulfillment FROM orders WHERE master_order_id = $1', [master.id]);
    assert.ok(delivered.rows.every((r) => r.status === 'delivered' && r.child_fulfillment === 'delivered'));
    const hooks = await pool.query(
      `SELECT aggregate_id FROM outbox_events WHERE event_type = 'child_order.fulfillment_delivered' AND aggregate_id = ANY($1::uuid[])`,
      [[childK.id, childG.id]]);
    assert.equal(hooks.rows.length, 2, 'per-child delivered finance hooks (§128)');
    // §129: master delivery must NOT blanket-credit the supplier wallet (legacy postSupplierEarnings stays legacy-only).
    const walletEntries = await pool.query(
      `SELECT count(*)::int AS c FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id WHERE a.owner_id = $1`,
      [supplierG.id]);
    assert.equal(walletEntries.rows[0].c, 0, 'no automatic supplier earning on master delivery');

    // buyer sees ONE canonical master row with aggregates (orders hub source, §152).
    const list = await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters', headers: buyerHeaders });
    assert.equal(list.statusCode, 200, list.body);
    const row = (list.json().items as Array<Record<string, unknown>>).find((r) => r.id === master.id)!;
    assert.equal(row.child_count, 2);
    assert.equal(row.paid_children, 2);
  } finally { await app.close(); await pool.end(); }
});
