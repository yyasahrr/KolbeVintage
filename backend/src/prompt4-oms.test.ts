/** Prompt 4 — Wholesale Order Center / multi-supplier OMS (P4-OMS-001 … P4-OMS-025).
 *
 *  Covers the Admin Order Center projections, buyer privacy projection, the three distinct line
 *  sources, sourced allocation through the ONE canonical primitive, cancellation/unwinding,
 *  explicit audited reassignment, derived readiness and the dispatch guards.
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
  NODE_ENV: 'test', PORT: 4032, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = Record<string, string>;

const uniqueRef = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `p4-${roles[0] ?? 'user'}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('TestPassword123456!'), label]);
  for (const role of roles) {
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  }
  return { id, email };
}

async function login(app: App, email: string): Promise<Headers> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeVip(pool: Pool, label: string, opts: { active?: boolean } = {}) {
  const user = await makeUser(pool, ['customer'], label);
  const planId = randomUUID();
  await pool.query("INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,'پلن P4',0,'{}')",
    [planId, uniqueRef('plan')]);
  await pool.query(
    `INSERT INTO memberships(id, user_id, plan_id, status, starts_at, ends_at)
     VALUES ($1,$2,$3,$4, now(), CASE WHEN $4 = 'active' THEN now() + interval '30 days' ELSE now() - interval '1 day' END)`,
    [randomUUID(), user.id, planId, opts.active === false ? 'expired' : 'active']);
  return user;
}

async function makeWarehouse(pool: Pool, suffix: string) {
  const id = randomUUID();
  await pool.query("INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,'wholesale')",
    [id, uniqueRef('WH'), `انبار P4 ${suffix}`]);
  return id;
}

/** Product + 2 variants + 1 series template. Supplier-owned products only expose the wholesale channel. */
async function makeSeriesProduct(pool: Pool, name: string, owner: { supplierId: string | null }, opts: { wholesaleEnabled?: boolean } = {}) {
  const wholesaleEnabled = opts.wholesaleEnabled !== false;
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id, supplier_id, brand, name, category, status, cash_price_rial, wholesale_price_rial,
       owner_type, retail_enabled, wholesale_enabled)
     VALUES ($1,$2,'برند P4',$3,'هودی','published',100000000,90000000,$4,$5,$6)`,
    [productId, owner.supplierId, name, owner.supplierId ? 'supplier' : 'kolbe',
      owner.supplierId ? false : wholesaleEnabled, wholesaleEnabled]);
  const v1 = randomUUID(); const v2 = randomUUID();
  await pool.query("INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','مشکی'),($4,$2,$5,'L','مشکی')",
    [v1, productId, uniqueRef('P4A'), v2, uniqueRef('P4B')]);
  const tplId = randomUUID();
  await pool.query("INSERT INTO series_templates(id, product_id, name) VALUES ($1,$2,'سری P4')", [tplId, productId]);
  await pool.query('INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,1),($4,$2,$5,1)',
    [randomUUID(), tplId, v1, randomUUID(), v2]);
  return { productId, tplId, variantIds: [v1, v2] };
}



async function seedStock(pool: Pool, tplId: string, variantIds: string[], warehouseId: string,
  owner: { ownerType: 'kolbe' | 'supplier'; supplierId: string | null }, series: number) {
  await pool.query(
    'INSERT INTO series_stock_balances(id, series_template_id, warehouse_id, owner_type, supplier_id, on_hand) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), tplId, warehouseId, owner.ownerType, owner.supplierId, series]);
  for (const variantId of variantIds) {
    await pool.query(
      `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain, on_hand) VALUES ($1,$2,'wholesale',$3)
       ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO UPDATE SET on_hand = stock_balances.on_hand + $3`,
      [variantId, warehouseId, series]);
  }
}

async function makeOffer(pool: Pool, supplierId: string, productId: string, tplId: string, capacity: number, status = 'active') {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO supplier_offers(id, supplier_id, product_id, series_template_id, status, wholesale_price_rial,
       min_order_series, declared_capacity, reserved_external, safety_buffer, capacity_confirmed_at)
     VALUES ($1,$2,$3,$4,$5,100000000,1,$6,0,0,now())`, [id, supplierId, productId, tplId, status, capacity]);
  return id;
}

async function makeMaster(app: App, headers: Headers, items: Array<Record<string, unknown>>) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
    headers: { ...headers, 'idempotency-key': uniqueRef('p4') }, payload: { items } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; reference: string; children: Array<{ id: string; reference: string; sellerType: string; sellerId: string | null }> };
}

async function applyVerified(pool: Pool, intentId: string, amountRial: string) {
  const { applyVerifiedPayment } = await import('./payments.js');
  return applyVerifiedPayment(pool, {
    provider: 'nextpay', providerEventId: `evt-${randomUUID()}`, providerReference: `ref-${randomUUID().slice(0, 12)}`,
    intentId, amountRial, paidAt: new Date(),
  });
}

const childOf = (master: { children: Array<{ id: string; sellerType: string; sellerId: string | null }> }, sellerType: 'kolbe' | 'supplier' | null, sellerId?: string | null) =>
  master.children.find((c) => (sellerType === null ? true : c.sellerType === sellerType && (sellerId === undefined || c.sellerId === sellerId)))!;

test('P4-OMS-001/002/003 — VIP membership gate, wholesale sales-mode gate and server-authoritative pricing', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-001');
    const adminHeaders = await login(app, admin.email);
    const vip = await makeVip(pool, 'خریدار P4-001');
    const vipHeaders = await login(app, vip.email);
    const expired = await makeVip(pool, 'منقضی P4-001', { active: false });
    const expiredHeaders = await login(app, expired.email);
    const warehouse = await makeWarehouse(pool, '001');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 4);

    // P4-OMS-001: the canonical server-side active entitlement is the ONLY gate — an expired
    // membership and a demo-style caller both fail.
    const expiredAttempt = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...expiredHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 1 }] } });
    assert.equal(expiredAttempt.statusCode, 403, expiredAttempt.body);
    const noMembership = await makeUser(pool, ['customer'], 'بدون عضویت P4-001');
    const noMembershipHeaders = await login(app, noMembership.email);
    const bare = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...noMembershipHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 1 }] } });
    assert.equal(bare.statusCode, 403, bare.body);

    // P4-OMS-002: retail-only products cannot be forced into wholesale ordering (explicit rejection).
    const retailOnly = await makeSeriesProduct(pool, `خرده‌فروشی ${uniqueRef('R')}`, { supplierId: null }, { wholesaleEnabled: false });
    const retailAttempt = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...vipHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: retailOnly.tplId, count: 1 }] } });
    assert.equal(retailAttempt.statusCode, 403, retailAttempt.body);
    assert.equal(retailAttempt.json().code, 'FORBIDDEN');

    // P4-OMS-003: client price/discount/total is refused; the canonical resolver decides.
    const stored = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${kolbe.tplId}`, headers: adminHeaders,
      payload: { pricingMode: 'series_total', totalPriceRial: '30000000' } });
    assert.equal(stored.statusCode, 200, stored.body);
    const tampered = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...vipHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 2, unitSeriesPriceRial: '1', totalRial: '1', discountRial: '999' }] } });
    assert.equal(tampered.statusCode, 400, tampered.body);
    const master = await makeMaster(app, vipHeaders, [{ seriesTemplateId: kolbe.tplId, count: 2 }]);
    const lines = await pool.query<{ unit_series_price_rial: string; commercial_snapshot: Record<string, unknown> }>(
      'SELECT unit_series_price_rial, commercial_snapshot FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'kolbe').id]);
    assert.equal(lines.rows[0]!.unit_series_price_rial, '30000000');
    assert.equal(lines.rows[0]!.commercial_snapshot.unitSeriesPriceRial, '30000000');
    const totals = await pool.query<{ total_rial: string }>('SELECT total_rial FROM orders WHERE id = $1', [childOf(master, 'kolbe').id]);
    assert.equal(totals.rows[0]!.total_rial, '60000000');
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-004/005/024 — one master across three sources; buyer projection leaks nothing', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVip(pool, 'خریدار P4-004');
    const buyerHeaders = await login(app, buyer.email);
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین‌کننده الف P4-004');
    const supplierSupports = await makeUser(pool, ['supplier'], 'تأمین‌کننده ب P4-004');
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-004');
    const adminHeaders = await login(app, admin.email);
    const warehouse = await makeWarehouse(pool, '004');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    const atKolbe = await makeSeriesProduct(pool, `نزد کلبه ${uniqueRef('S')}`, { supplierId: supplierA.id });
    const capacityOnly = await makeSeriesProduct(pool, `ظرفیت ${uniqueRef('C')}`, { supplierId: supplierSupports.id });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 5);
    await seedStock(pool, atKolbe.tplId, atKolbe.variantIds, warehouse, { ownerType: 'supplier', supplierId: supplierA.id }, 5);
    const offerId = await makeOffer(pool, supplierSupports.id, capacityOnly.productId, capacityOnly.tplId, 20);

    // P4-OMS-004: three lines / three sources → ONE master order, children only split fulfilment.
    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbe.tplId, count: 2 }, { seriesTemplateId: atKolbe.tplId, count: 2 },
      { seriesTemplateId: capacityOnly.tplId, count: 2 },
    ]);
    assert.equal(master.children.length, 3);
    const allocations = await pool.query<{ source_type: string; status: string }>(
      'SELECT source_type, status FROM order_source_allocations WHERE master_order_id = $1 ORDER BY source_type', [master.id]);
    assert.deepEqual(allocations.rows.map((r) => [r.source_type, r.status]),
      [['kolbe_stock', 'reserved'], ['supplier_external', 'pending'], ['supplier_stock_at_kolbe', 'reserved']]);
    const masters = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id = $1', [buyer.id]);
    assert.equal(masters.rows[0]!.n, 1, 'exactly ONE customer-facing order');

    // P4-OMS-005: buyer projection has NO supplier ids, offer ids, capacity numbers or topology.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders });
    assert.equal(detail.statusCode, 200, detail.body);
    const body = detail.json() as Record<string, unknown> & { items: Array<Record<string, unknown>>; actions: Record<string, unknown> };
    const raw = detail.body;
    for (const secret of [supplierA.id, supplierSupports.id, offerId, supplierA.email, supplierSupports.email]) {
      assert.ok(!raw.includes(secret), `buyer projection leaked ${secret}`);
    }
    for (const term of ['supplier_capacity_reservation', 'allocation_pending', 'child_fulfillment', 'order_source_allocations', 'reserved_external']) {
      assert.ok(!raw.includes(term), `buyer projection leaked internal term ${term}`);
    }
    assert.equal((body.items as unknown[]).length, 3);
    assert.ok(body.actions.canPay !== undefined);
    assert.ok(body.totals, 'customer totals present');
    // the buyer projection exposes ONLY customer vocabulary — no operational keys at all.
    const allowed = new Set(['view', 'id', 'reference', 'composition', 'status', 'createdAt', 'lockedAt', 'shippedAt',
      'deliveredAt', 'customerStatus', 'customerStatusLabel', 'items', 'subOrders', 'shipping', 'shippingEstimateRial',
      'actions', 'timeline', 'totals']);
    for (const key of Object.keys(body)) assert.ok(allowed.has(key), `unexpected buyer key ${key}`);
    for (const key of Object.keys(body.items[0]!)) {
      assert.ok(['productName', 'seriesName', 'colorLabel', 'seriesCount', 'piecesPerSeries', 'pieces',
        'unitSeriesPriceRial', 'lineTotalRial'].includes(key), `unexpected buyer item key ${key}`);
    }
    // ops projection DOES carry the operational fields (separate projection, not client masking).
    const ops = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: adminHeaders });
    assert.equal(ops.statusCode, 200, ops.body);
    const opsBody = ops.json() as { view: string; coverage: Record<string, number>; children: Array<{ allocations: unknown[]; allowedActions: string[] }> };
    assert.equal(opsBody.view, 'ops');
    assert.equal(opsBody.coverage.orderedSeries, 6);
    assert.equal(opsBody.coverage.kolbeSeries, 2);
    assert.equal(opsBody.coverage.supplierAtKolbeSeries, 2);
    assert.equal(opsBody.coverage.capacitySeries, 2);
    assert.equal(opsBody.children.length, 3);
    assert.ok(opsBody.children.every((c) => Array.isArray(c.allowedActions)));
    // P4-OMS-022: reserving supplier-owned physical stock never converts ownership.
    const owners = await pool.query<{ owner_type: string }>(
      'SELECT DISTINCT owner_type FROM series_stock_balances WHERE series_template_id = $1', [atKolbe.tplId]);
    assert.deepEqual(owners.rows, [{ owner_type: 'supplier' }]);
    const conversions = await pool.query(
      'SELECT count(*)::int AS n FROM ownership_conversions WHERE variant_id = ANY($1::uuid[])', [atKolbe.variantIds]);
    assert.equal(conversions.rows[0]!.n, 0, 'allocation never invokes an ownership conversion');
    // P4-OMS-024: a supplier token cannot read the ops master projection.
    const supplierHeaders = await login(app, supplierSupports.email);
    const supplierOps = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: supplierHeaders });
    assert.equal(supplierOps.statusCode, 403, supplierOps.body);
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-006/007/020 — physical reservation never decrements stock; over-allocation is blocked; totals stay consistent', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVip(pool, 'خریدار P4-006');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, '006');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 5);

    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: kolbe.tplId, count: 3 }]);
    // P4-OMS-006: 5 → 3 reserved, on_hand untouched (WMS reservation, not a decrement).
    const balance = await pool.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.deepEqual(balance.rows[0], { on_hand: 5, reserved: 3 });
    const reservations = await pool.query<{ status: string; series_count: number }>(
      'SELECT status, series_count FROM order_series_reservations WHERE order_id = $1', [childOf(master, 'kolbe').id]);
    assert.deepEqual(reservations.rows, [{ status: 'active', series_count: 3 }]);

    // P4-OMS-007: another 3 is refused (only 2 free); nothing is created.
    const over = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 3 }] } });
    assert.equal(over.statusCode, 409, over.body);
    assert.equal(over.json().code, 'INSUFFICIENT_SERIES');
    const masters = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id = $1', [buyer.id]);
    assert.equal(masters.rows[0]!.n, 1, 'blocked order leaves no partial master');

    // P4-OMS-020: list totals == sum of the immutable child snapshots == the detail totals.
    const line = await pool.query<{ unit_series_price_rial: string; requested_series: number }>(
      'SELECT unit_series_price_rial, requested_series FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'kolbe').id]);
    const expected = String(BigInt(line.rows[0]!.unit_series_price_rial) * BigInt(line.rows[0]!.requested_series));
    const list = await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters', headers: buyerHeaders });
    const row = (list.json().items as Array<Record<string, unknown>>).find((r) => r.id === master.id)!;
    assert.equal(row.total_rial, expected);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders });
    assert.equal((detail.json() as { totals: { totalRial: string } }).totals.totalRial, expected);
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-008/009/026 — capacity is only «نیاز به تأمین» and can never double-consume or become physical stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-008');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-008');
    const buyerHeaders = await login(app, buyer.email);
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده P4-008');
    const supplierHeaders = await login(app, supplier.email);
    const external = await makeSeriesProduct(pool, `ظرفیت ${uniqueRef('C')}`, { supplierId: supplier.id });
    const offerId = await makeOffer(pool, supplier.id, external.productId, external.tplId, 5);

    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: external.tplId, count: 5 }]);
    // P4-OMS-008: capacity allocation is pending + supply-required; there is no stock, no receipt,
    // no at-Kolbe balance and the master is never fulfillment-ready.
    const detailBefore = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: adminHeaders });
    const opsBefore = detailBefore.json() as { coverage: Record<string, number>; readiness: string };
    assert.equal(opsBefore.coverage.capacitySeries, 5);
    assert.equal(opsBefore.coverage.kolbeSeries, 0);
    assert.equal(opsBefore.coverage.supplierAtKolbeSeries, 0);
    assert.equal(opsBefore.coverage.receivedSeries, 0);
    assert.equal(opsBefore.readiness, 'not_ready', 'capacity alone is never progress (§16/§28)');
    const physical = await pool.query(
      `SELECT (SELECT count(*) FROM stock_balances WHERE variant_id = ANY($1::uuid[]))::int AS balances,
              (SELECT count(*) FROM stock_receipts WHERE variant_id = ANY($1::uuid[]))::int AS receipts,
              (SELECT count(*) FROM series_stock_balances WHERE series_template_id = $2)::int AS series`,
      [external.variantIds, external.tplId]);
    assert.deepEqual(physical.rows[0], { balances: 0, receipts: 0, series: 0 });
    // over-capacity also refused.
    const over = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': uniqueRef('p4') },
      payload: { items: [{ seriesTemplateId: external.tplId, count: 1 }] } });
    assert.equal(over.statusCode, 409, over.body);
    // P4-OMS-009: the same declared capacity cannot be consumed twice — reservation is atomic via the
    // unique capacity reservation row and the offer's reserved_external counter.
    const line = await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'supplier', supplier.id).id]);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0]!.id}/respond`,
      headers: supplierHeaders, payload: { action: 'confirm' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    const secondConfirm = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0]!.id}/respond`,
      headers: supplierHeaders, payload: { action: 'confirm' } });
    assert.ok([200, 409].includes(secondConfirm.statusCode), secondConfirm.body);
    const capacity = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerId]);
    assert.equal(capacity.rows[0]!.reserved_external, 5, 'declared capacity consumed exactly once');
    const reservations = await pool.query<{ status: string }>(
      'SELECT status FROM supplier_capacity_reservations WHERE offer_id = $1', [offerId]);
    assert.equal(reservations.rows.filter((r) => r.status === 'active').length, 1, 'ONE live capacity reservation');
    // P4-OMS-026: capacity never becomes physical/warehouse stock, no matter the operational state.
    const after = await pool.query(
      `SELECT (SELECT count(*) FROM stock_balances WHERE variant_id = ANY($1::uuid[]))::int AS balances,
              (SELECT count(*) FROM series_stock_balances WHERE series_template_id = $2)::int AS series`,
      [external.variantIds, external.tplId]);
    assert.deepEqual(after.rows[0], { balances: 0, series: 0 });
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-010/011/027 — master cancel releases WMS + capacity once, is idempotent and never touches finance', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVip(pool, 'خریدار P4-010');
    const buyerHeaders = await login(app, buyer.email);
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده P4-010');
    const warehouse = await makeWarehouse(pool, '010');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    const external = await makeSeriesProduct(pool, `ظرفیت ${uniqueRef('C')}`, { supplierId: supplier.id });
    const offerId = await makeOffer(pool, supplier.id, external.productId, external.tplId, 4);
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 4);
    const walletBefore = await pool.query('SELECT count(*)::int AS n FROM wallet_entries');

    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbe.tplId, count: 2 }, { seriesTemplateId: external.tplId, count: 2 },
    ]);
    const line = await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'supplier', supplier.id).id]);
    await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0]!.id}/respond`, headers: {}, payload: {} });

    // P4-OMS-010: cancel unwinds the order, releases the reservation and the supply requirement.
    const key = uniqueRef('cancel');
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/cancel`,
      headers: { ...buyerHeaders, 'idempotency-key': key }, payload: { reason: 'انصراف خریدار از سفارش نمونه' } });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const cancelled = cancel.json() as { status: string; duplicate: boolean; cancelledChildren: number; released: Record<string, number> };
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.duplicate, false);
    assert.equal(cancelled.cancelledChildren, 2);
    const balance = await pool.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.deepEqual(balance.rows[0], { on_hand: 4, reserved: 0 });
    const offer = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerId]);
    assert.equal(offer.rows[0]!.reserved_external, 0);
    const allocations = await pool.query<{ status: string }>('SELECT status FROM order_source_allocations WHERE master_order_id = $1', [master.id]);
    // §30: a reserved hold is RELEASED; an unstarted supply requirement is CANCELLED — both are closed once.
    assert.ok(allocations.rows.every((r) => ['released', 'cancelled'].includes(r.status)));
    assert.ok(allocations.rows.some((r) => r.status === 'released'));
    const orders = await pool.query<{ status: string }>('SELECT status FROM orders WHERE master_order_id = $1', [master.id]);
    assert.ok(orders.rows.every((r) => r.status === 'cancelled'));
    // P4-OMS-011: a second cancel (fresh idempotency key) is a safe replay — no duplicate release/event.
    const second = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/cancel`,
      headers: { ...buyerHeaders, 'idempotency-key': uniqueRef('cancel') }, payload: { reason: 'تلاش لغو دوباره همان سفارش' } });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal((second.json() as { duplicate: boolean }).duplicate, true);
    const balanceAgain = await pool.query<{ reserved: number }>(
      'SELECT reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.equal(balanceAgain.rows[0]!.reserved, 0);
    const offerAgain = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerId]);
    assert.equal(offerAgain.rows[0]!.reserved_external, 0);
    const cancelEvents = await pool.query(
      `SELECT count(*)::int AS n FROM order_events e JOIN orders o ON o.id = e.order_id
        WHERE o.master_order_id = $1 AND e.to_status = 'cancelled'`, [master.id]);
    assert.equal(cancelEvents.rows[0]!.n, 2, 'exactly one cancellation event per child');
    // P4-OMS-027: no refund/finance machinery runs on a cancellation.
    const walletAfter = await pool.query('SELECT count(*)::int AS n FROM wallet_entries');
    assert.equal(walletAfter.rows[0]!.n, walletBefore.rows[0]!.n);
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-012/028 — creation idempotency: replay = same master, mismatch = conflict', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVip(pool, 'خریدار P4-012');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, '012');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 6);
    const key = uniqueRef('master');
    // P4-OMS-012: the same key + same payload yields ONE order (reservation applied once).
    const first = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': key }, payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 2 }] } });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': key }, payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 2 }] } });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal((replay.json() as { id: string; duplicate?: boolean }).id, (first.json() as { id: string }).id);
    const masters = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id = $1', [buyer.id]);
    assert.equal(masters.rows[0]!.n, 1);
    const balance = await pool.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1', [kolbe.tplId]);
    assert.deepEqual(balance.rows[0], { on_hand: 6, reserved: 2 }, 'replay must not double-reserve');
    // P4-OMS-028: same key, different payload → deterministic conflict, not a second order.
    const conflict = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': key }, payload: { items: [{ seriesTemplateId: kolbe.tplId, count: 3 }] } });
    assert.equal(conflict.statusCode, 409, conflict.body);
    const still = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id = $1', [buyer.id]);
    assert.equal(still.rows[0]!.n, 1);
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-013/014 — immutable snapshots: price and Series composition never change under a placed order', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-013');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-013');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, '013');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 4);
    const priced = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${kolbe.tplId}`, headers: adminHeaders,
      payload: { pricingMode: 'series_total', totalPriceRial: '40000000' } });
    assert.equal(priced.statusCode, 200, priced.body);
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: kolbe.tplId, count: 1 }]);

    // P4-OMS-013: later price change updates the catalog but the placed order keeps its snapshot.
    const repriced = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${kolbe.tplId}`, headers: adminHeaders,
      payload: { totalPriceRial: '999000000' } });
    assert.equal(repriced.statusCode, 200, repriced.body);
    // P4-OMS-014: composition change after purchase must never rewrite the ordered composition.
    const recomposed = await app.inject({ method: 'PATCH', url: `/api/v1/series-templates/${kolbe.tplId}`, headers: adminHeaders,
      payload: { items: [{ variantId: kolbe.variantIds[0], quantityPerSeries: 3 }] } });
    assert.ok([200, 409, 400].includes(recomposed.statusCode), recomposed.body);
    const line = await pool.query<{ unit_series_price_rial: string; commercial_snapshot: Record<string, unknown> }>(
      'SELECT unit_series_price_rial, commercial_snapshot FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'kolbe').id]);
    assert.equal(line.rows[0]!.unit_series_price_rial, '40000000');
    const snapshot = line.rows[0]!.commercial_snapshot as { perPiece: Array<Record<string, unknown>> };
    assert.equal(snapshot.perPiece.length, 2, 'the ordered composition is snapshotted per piece');
    const total = await pool.query<{ unit_series_price_rial: string }>(
      'SELECT unit_series_price_rial FROM child_order_lines WHERE child_order_id = $1', [childOf(master, 'kolbe').id]);
    assert.equal(total.rows[0]!.unit_series_price_rial, '40000000');
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-015/016 — derived readiness & partial progress; final dispatch is Kolbe-only and guarded', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-015');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-015');
    const buyerHeaders = await login(app, buyer.email);
    const supplier = await makeUser(pool, ['supplier'], 'تأمین‌کننده P4-015');
    const supplierHeaders = await login(app, supplier.email);
    const warehouse = await makeWarehouse(pool, '015');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    const atKolbe = await makeSeriesProduct(pool, `نزد کلبه ${uniqueRef('S')}`, { supplierId: supplier.id });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 2);
    await seedStock(pool, atKolbe.tplId, atKolbe.variantIds, warehouse, { ownerType: 'supplier', supplierId: supplier.id }, 2);

    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbe.tplId, count: 2 }, { seriesTemplateId: atKolbe.tplId, count: 2 },
    ]);
    // P4-OMS-015: payment (all children) then a partial pick — readiness stays honest per source.
    const batch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/batch-payment-intent`,
      headers: buyerHeaders, payload: { childIds: [childOf(master, 'kolbe').id, childOf(master, 'supplier', supplier.id).id] } });
    assert.equal(batch.statusCode, 201, batch.body);
    const intent = batch.json() as { intentId: string; amountRial: string };
    await applyVerified(pool, intent.intentId, intent.amountRial);
    const pick = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childOf(master, 'kolbe').id}/pick`, headers: adminHeaders });
    assert.equal(pick.statusCode, 200, pick.body);
    const partial = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: adminHeaders });
    const ops = partial.json() as { readiness: string; coverage: Record<string, number> };
    assert.equal(ops.coverage.kolbeSeries, 2);
    assert.equal(ops.coverage.supplierAtKolbeSeries, 2);
    assert.equal(ops.readiness, 'partial', 'never a false whole-order ready');
    // P4-OMS-016: the buyer's final dispatch is Kolbe-only; a supplier dispatch never targets the VIP,
    // and a master ship before consolidation is refused by the server.
    const early = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: adminHeaders, payload: { carrier: 'باربری تست', trackingCode: 'TRK-' + randomUUID().slice(0, 6) } });
    assert.equal(early.statusCode, 409, early.body);
    assert.equal(early.json().code, 'CONSOLIDATION_NOT_READY');
    const directShip = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childOf(master, 'supplier', supplier.id).id}/dispatch`,
      headers: { ...supplierHeaders, 'idempotency-key': uniqueRef('p4') }, payload: { trackingNote: 'ارسال مستقیم به مشتری', address: 'tehran' } });
    assert.ok([200, 400, 409].includes(directShip.statusCode), directShip.body);
    const child = await pool.query<{ child_fulfillment: string }>('SELECT child_fulfillment FROM orders WHERE id = $1',
      [childOf(master, 'supplier', supplier.id).id]);
    assert.notEqual(child.rows[0]!.child_fulfillment, 'delivered');
    const masterRow = await pool.query<{ status: string; shipped_at: string | null }>(
      'SELECT status, shipped_at FROM master_orders WHERE id = $1', [master.id]);
    assert.equal(masterRow.rows[0]!.shipped_at, null);
    assert.notEqual(masterRow.rows[0]!.status, 'shipped');
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-017/018/019 — reassignment is explicit + audited; buyer access control and ownership preserved', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-017');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-017');
    const buyerHeaders = await login(app, buyer.email);
    const other = await makeVip(pool, 'خریدار دیگر P4-017');
    const otherHeaders = await login(app, other.email);
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین‌کننده الف P4-017');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین‌کننده ب P4-017');
    const external = await makeSeriesProduct(pool, `ظرفیت ${uniqueRef('C')}`, { supplierId: supplierA.id });
    const offerA = await makeOffer(pool, supplierA.id, external.productId, external.tplId, 10);
    const offerB = await makeOffer(pool, supplierB.id, external.productId, external.tplId, 10);

    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: external.tplId, count: 3 }]);
    const child = childOf(master, 'supplier', supplierA.id);
    const line = await pool.query<{ id: string; unit_series_price_rial: string; negotiation_history: unknown[] | null }>(
      'SELECT id, unit_series_price_rial, negotiation_history FROM child_order_lines WHERE child_order_id = $1', [child.id]);
    const priceBefore = line.rows[0]!.unit_series_price_rial;
    // capacity ≠ eligibility: only after the supplier confirms can the buyer pay (canonical rule §23).
    const supplierAHeaders = await login(app, supplierA.email);
    const confirmA = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0]!.id}/respond`,
      headers: supplierAHeaders, payload: { action: 'confirm' } });
    assert.equal(confirmA.statusCode, 200, confirmA.body);
    // reassignment is an OPERATIONAL move: the buyer has already paid this child (money is not moved again).
    const intent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${child.id}/payment-intent`, headers: buyerHeaders });
    assert.equal(intent.statusCode, 201, intent.body);
    await applyVerified(pool, intent.json().intentId as string, intent.json().amountRial as string);
    const allocation = await pool.query<{ id: string }>(
      'SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND status = \'reserved\'', [child.id]);

    // P4-OMS-017: ops reassign A → B explicitly, with a reason; the old row is released, a new one is
    // created, demand is conserved and the move is written to the audit trail + line history.
    const reassign = await app.inject({ method: 'POST', url: `/api/v1/wholesale/allocations/${allocation.rows[0]!.id}/reassign`,
      headers: adminHeaders, payload: { toOfferId: offerB, reason: 'انتقال تأمین به تأمین‌کننده دوم' } });
    assert.ok([200, 201].includes(reassign.statusCode), reassign.body);
    const rows = await pool.query<{ id: string; status: string; offer_id: string | null; quantity: number }>(
      'SELECT id, status, offer_id, quantity FROM order_source_allocations WHERE line_id = (SELECT id FROM child_order_lines WHERE child_order_id = $1) ORDER BY created_at',
      [child.id]);
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]!.status, 'released');
    assert.equal(rows.rows[1]!.status, 'pending');
    assert.equal(rows.rows[1]!.offer_id, offerB);
    assert.equal(rows.rows[1]!.quantity, rows.rows[0]!.quantity, 'demand conserved');
    const offerAReserved = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [offerA]);
    assert.equal(offerAReserved.rows[0]!.reserved_external, 0);
    const audit = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'wholesale_allocation.reassigned'");
    assert.equal(audit.rows[0]!.n, 1);
    const history = await pool.query<{ negotiation_history: Array<Record<string, unknown>> }>(
      'SELECT negotiation_history FROM child_order_lines WHERE child_order_id = $1', [child.id]);
    assert.ok(history.rows[0]!.negotiation_history.some((e) => e.type === 'reassigned'));
    const priceAfter = await pool.query<{ unit_series_price_rial: string }>(
      'SELECT unit_series_price_rial FROM child_order_lines WHERE child_order_id = $1', [child.id]);
    assert.equal(priceAfter.rows[0]!.unit_series_price_rial, priceBefore, 'reassignment is price-neutral');
    // a reassignment body without a reason is refused (no silent operational edits).
    const noReason = await app.inject({ method: 'POST', url: `/api/v1/wholesale/allocations/${rows.rows[1]!.id}/reassign`,
      headers: adminHeaders, payload: { toOfferId: offerA } });
    assert.equal(noReason.statusCode, 400, noReason.body);

    // P4-OMS-018: buyer access control — another buyer cannot read or act on the master.
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}`, headers: otherHeaders });
    assert.equal(foreign.statusCode, 403, foreign.body);
    const foreignCancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/cancel`,
      headers: { ...otherHeaders, 'idempotency-key': uniqueRef('p4') }, payload: { reason: 'تلاش لغو غیرمجاز' } });
    assert.equal(foreignCancel.statusCode, 403, foreignCancel.body);

    // P4-OMS-019: allocation never converts ownership — supplier-owned stays supplier-owned, and the
    // wholesale→retail conversion primitive is never invoked by the OMS.
    const owners = await pool.query<{ owner_type: string }>(
      'SELECT DISTINCT owner_type FROM series_stock_balances WHERE series_template_id = $1', [external.tplId]);
    assert.deepEqual(owners.rows, [], 'no ownership rows were fabricated by allocation');
    const conversions = await pool.query(
      'SELECT count(*)::int AS n FROM ownership_conversions WHERE variant_id = ANY($1::uuid[])', [external.variantIds]);
    assert.equal(conversions.rows[0]!.n, 0, 'no ownership conversion was invoked for these variants');
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-021/022/023 — domain isolation, transition guards and the customer lifecycle projection', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-021');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-021');
    const buyerHeaders = await login(app, buyer.email);
    const warehouse = await makeWarehouse(pool, '021');
    const kolbe = await makeSeriesProduct(pool, `کلبه ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbe.tplId, kolbe.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 4);
    const retailBefore = await pool.query(
      "SELECT COALESCE(SUM(on_hand),0)::int AS n FROM stock_balances WHERE inventory_domain = 'retail'");
    const master = await makeMaster(app, buyerHeaders, [{ seriesTemplateId: kolbe.tplId, count: 1 }]);

    // P4-OMS-021: the whole wholesale flow left the retail domain untouched.
    const retailAfter = await pool.query(
      "SELECT COALESCE(SUM(on_hand),0)::int AS n FROM stock_balances WHERE inventory_domain = 'retail'");
    assert.deepEqual(retailAfter.rows[0], retailBefore.rows[0]);

    // P4-OMS-023: the customer lifecycle is DERIVED server-side — no ready toggle, no raw enum leak.
    const list = await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters', headers: buyerHeaders });
    const row = (list.json().items as Array<Record<string, unknown>>).find((r) => r.id === master.id)!;
    assert.equal(typeof row.customer_status, 'string');
    assert.ok(!['not_ready', 'pending', 'reserved', 'supplier_external'].includes(row.customer_status as string));
    const detail = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders });
    const buyerBody = detail.json() as { customerStatus: string; customerStatusLabel: string; timeline: Array<{ label: string }> };
    assert.ok(/[\u0600-\u06FF]/.test(buyerBody.customerStatusLabel), 'customer-facing label is Persian');
    assert.ok(buyerBody.timeline.every((e) => /[\u0600-\u06FF]/.test(e.label)));

    // P4-OMS-022: transition guards — the master cannot be locked/cancelled into an illegal state and
    // cancelled masters reject further fulfilment actions.
    const lock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/lock`, headers: buyerHeaders });
    assert.equal(lock.statusCode, 200, lock.body);
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/cancel`,
      headers: { ...buyerHeaders, 'idempotency-key': uniqueRef('p4') }, payload: { reason: 'انصراف پس از قفل سفارش' } });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const pickAfterCancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childOf(master, 'kolbe').id}/pick`, headers: adminHeaders });
    assert.ok([403, 409].includes(pickAfterCancel.statusCode), pickAfterCancel.body);
    const shipAfterCancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${master.id}/ship`,
      headers: adminHeaders, payload: { carrier: 'باربری تست', trackingCode: 'TRK-' + randomUUID().slice(0, 6) } });
    assert.ok([403, 409].includes(shipAfterCancel.statusCode), shipAfterCancel.body);
    // filters are server-side and consistent with the derived state.
    const cancelled = await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters?status=cancelled', headers: adminHeaders });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.ok((cancelled.json().items as Array<{ id: string }>).some((r) => r.id === master.id));
    const active = await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters?status=active', headers: adminHeaders });
    assert.ok(!(active.json().items as Array<{ id: string }>).some((r) => r.id === master.id));
  } finally { await app.close(); await pool.end(); }
});

test('P4-OMS-004/008/015/016/022 — prescribed 4+3+2 multi-supplier master and 10=3+2+5 mixed coverage', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر P4-SCEN');
    const adminHeaders = await login(app, admin.email);
    const buyer = await makeVip(pool, 'خریدار P4-SCEN');
    const buyerHeaders = await login(app, buyer.email);
    const alpha = await makeUser(pool, ['supplier'], 'آلفا P4-SCEN');
    const beta = await makeUser(pool, ['supplier'], 'بتا P4-SCEN');
    const warehouse = await makeWarehouse(pool, 'SCEN');
    // Product A → Supplier Alpha 4, Product B → Supplier Beta 3, Product C → Kolbe physical 2.
    const productA = await makeSeriesProduct(pool, `کالای الف ${uniqueRef('A')}`, { supplierId: alpha.id });
    const productB = await makeSeriesProduct(pool, `کالای ب ${uniqueRef('B')}`, { supplierId: beta.id });
    const productC = await makeSeriesProduct(pool, `کالای پ ${uniqueRef('C')}`, { supplierId: null });
    const offerA = await makeOffer(pool, alpha.id, productA.productId, productA.tplId, 10);
    const offerB = await makeOffer(pool, beta.id, productB.productId, productB.tplId, 10);
    await seedStock(pool, productC.tplId, productC.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 2);

    const master = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: productA.tplId, count: 4 },
      { seriesTemplateId: productB.tplId, count: 3 },
      { seriesTemplateId: productC.tplId, count: 2 },
    ]);
    assert.equal(master.children.length, 3, 'three suppliers internally …');
    const masters = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id = $1', [buyer.id]);
    assert.equal(masters.rows[0]!.n, 1, '… but exactly ONE customer-facing Master Order');

    const ops = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=ops`, headers: adminHeaders })).json() as
      { coverage: Record<string, number>; readiness: string; children: Array<{ allowedActions: string[] }> };
    assert.equal(ops.coverage.orderedSeries, 9);
    assert.equal(ops.coverage.kolbeSeries, 2);
    assert.equal(ops.coverage.capacitySeries, 7);
    assert.equal(ops.coverage.supplierAtKolbeSeries, 0);
    // §56-§58 filters: exact + partial search, sort, supplyRequired and the date window, all server-side.
    const searchExact = (await app.inject({ method: 'GET',
      url: `/api/v1/wholesale/masters?scope=all&search=${encodeURIComponent(master.reference)}`, headers: adminHeaders })).json() as
      { items: Array<{ id: string }>; total: number; sort: string; limit: number };
    assert.equal(searchExact.total, 1);
    assert.equal(searchExact.items[0]!.id, master.id);
    assert.equal(searchExact.sort, 'newest');
    const searchPartial = (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&search=MV-', headers: adminHeaders })).json() as { items: unknown[] };
    assert.ok(searchPartial.items.length >= 1, 'partial reference search works');
    const byBuyerName = encodeURIComponent('خریدار P4-SCEN');
    const searchBuyer = (await app.inject({ method: 'GET',
      url: `/api/v1/wholesale/masters?scope=all&search=${byBuyerName}`, headers: adminHeaders })).json() as { items: unknown[] };
    assert.ok(searchBuyer.items.length >= 1, 'VIP buyer name search works');
    const oldest = (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&sort=oldest&limit=2', headers: adminHeaders })).json() as
      { items: Array<{ created_at: string }>; limit: number };
    assert.equal(oldest.limit, 2);
    assert.ok(oldest.items.length <= 2);
    const future = await app.inject({ method: 'GET',
      url: `/api/v1/wholesale/masters?scope=all&dateFrom=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`, headers: adminHeaders });
    assert.equal((future.json() as { items: unknown[] }).items.length, 0, 'date window filters server-side');
    // §24/§62: the derived customer lifecycle is filterable server-side with the SAME values the row returns.
    for (const item of (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&limit=100', headers: adminHeaders })).json().items as Array<{ id: string; customer_status: string }>) {
      const same = (await app.inject({ method: 'GET',
        url: `/api/v1/wholesale/masters?scope=all&limit=100&customerStatus=${item.customer_status}`, headers: adminHeaders })).json() as
        { items: Array<{ id: string; customer_status: string }> };
      assert.ok(same.items.some((row) => row.id === item.id),
        `customerStatus=${item.customer_status} must return its own row`);
      assert.ok(same.items.every((row) => row.customer_status === item.customer_status),
        'the customerStatus filter never mixes other lifecycles in');
    }
    const impossible = (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&customerStatus=delivered&limit=100', headers: adminHeaders })).json() as { items: unknown[] };
    assert.equal(impossible.items.length, 0, 'lifecycle filter excludes masters in other states');
    const required = (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&supplyRequired=1&limit=100', headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.ok(required.items.some((row) => row.id === master.id));
    const noSupply = (await app.inject({ method: 'GET',
      url: '/api/v1/wholesale/masters?scope=all&supplyRequired=0&limit=100', headers: adminHeaders })).json() as
      { items: Array<{ id: string }> };
    assert.ok(!noSupply.items.some((row) => row.id === master.id));
    const buyerDetail = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${master.id}?view=buyer`, headers: buyerHeaders })).body;
    for (const leak of [alpha.id, beta.id, offerA, offerB, 'supplier_external', 'kolbe_stock']) {
      assert.ok(!buyerDetail.includes(leak), `buyer payload leaked ${leak}`);
    }
    assert.equal((JSON.parse(buyerDetail) as { subOrders: unknown[] }).subOrders.length, 3);

    /* ---- §16 mixed coverage: demand 10 = Kolbe 3 + supplier-at-Kolbe 2 + declared capacity 5 ---- */
    const kolbeOnly = await makeSeriesProduct(pool, `کلبه تنها ${uniqueRef('K')}`, { supplierId: null });
    await seedStock(pool, kolbeOnly.tplId, kolbeOnly.variantIds, warehouse, { ownerType: 'kolbe', supplierId: null }, 3);
    const mixedOwned = await makeSeriesProduct(pool, `پوشش ترکیبی ${uniqueRef('M')}`, { supplierId: alpha.id });
    const mixedOffer = await makeOffer(pool, alpha.id, mixedOwned.productId, mixedOwned.tplId, 20);
    await seedStock(pool, mixedOwned.tplId, mixedOwned.variantIds, warehouse, { ownerType: 'supplier', supplierId: alpha.id }, 2);
    const onHandBefore = await pool.query<{ on_hand: number }>(
      "SELECT on_hand FROM series_stock_balances WHERE series_template_id = $1", [kolbeOnly.tplId]);
    const mixedMaster = await makeMaster(app, buyerHeaders, [
      { seriesTemplateId: kolbeOnly.tplId, count: 3 }, { seriesTemplateId: mixedOwned.tplId, count: 7 },
    ]);
    const allocs = await pool.query<{ source_type: string; quantity: number; status: string }>(
      'SELECT source_type, quantity, status FROM order_source_allocations WHERE master_order_id = $1 ORDER BY source_type', [mixedMaster.id]);
    assert.deepEqual(allocs.rows.map((r) => [r.source_type, r.quantity, r.status]), [
      ['kolbe_stock', 3, 'reserved'], ['supplier_external', 5, 'pending'], ['supplier_stock_at_kolbe', 2, 'reserved'],
    ]);
    const mixedView = (await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${mixedMaster.id}?view=ops`, headers: adminHeaders }))
      .json() as { coverage: Record<string, number>; readiness: string };
    assert.deepEqual(mixedView.coverage, {
      orderedSeries: 10, kolbeSeries: 3, supplierAtKolbeSeries: 2, capacitySeries: 5, receivedSeries: 0, qcPassedSeries: 0,
    });
    assert.equal(mixedView.readiness, 'partial', 'physical holds landed (5) but the supply requirement (5) is open');
    /* §IA (PO-locked): source coverage is a FILTER over the ONE canonical Master Order list — the
       same rows, server-filtered; there is no per-source order center. */
    const coverageRows = async (value: string) => (await app.inject({ method: 'GET',
      url: `/api/v1/wholesale/masters?scope=all&limit=100&coverage=${value}`, headers: adminHeaders })).json() as
      { items: Array<{ id: string; kolbe_series: number; supplier_at_kolbe_series: number; supply_required_series: number }> };
    const mixedRows = await coverageRows('mixed');
    assert.ok(mixedRows.items.some((row) => row.id === mixedMaster.id), 'the 3-source master is «ترکیبی»');
    assert.ok(mixedRows.items.every((row) => [row.kolbe_series > 0, row.supplier_at_kolbe_series > 0,
      row.supply_required_series > 0].filter(Boolean).length > 1), 'mixed = at least two real buckets');
    const kolbeRows = await coverageRows('kolbe');
    assert.ok(kolbeRows.items.some((row) => row.id === master.id) && kolbeRows.items.some((row) => row.id === mixedMaster.id));
    assert.ok(kolbeRows.items.every((row) => row.kolbe_series > 0));
    const atKolbeRows = await coverageRows('supplier_at_kolbe');
    assert.ok(atKolbeRows.items.some((row) => row.id === mixedMaster.id) && !atKolbeRows.items.some((row) => row.id === master.id));
    assert.ok(atKolbeRows.items.every((row) => row.supplier_at_kolbe_series > 0));
    const supplyRows = await coverageRows('supply_required');
    assert.ok(supplyRows.items.some((row) => row.id === master.id) && supplyRows.items.some((row) => row.id === mixedMaster.id));
    assert.ok(supplyRows.items.every((row) => row.supply_required_series > 0));
    const allRows = await coverageRows('all');
    assert.ok(allRows.items.some((row) => row.id === mixedMaster.id), 'coverage=all keeps every source bucket');
    const unfiltered = (await app.inject({ method: 'GET', url: '/api/v1/wholesale/masters?scope=all&limit=100',
      headers: adminHeaders })).json() as { items: unknown[] };
    assert.equal(allRows.items.length, unfiltered.items.length, 'coverage=all == no coverage filter');
    // physical buckets: 3 Kolbe + 2 supplier reserved, on_hand never decremented by the reservation.
    const kolbeAfter = await pool.query<{ on_hand: number; reserved: number }>(
      "SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1", [kolbeOnly.tplId]);
    assert.deepEqual(kolbeAfter.rows[0], { on_hand: onHandBefore.rows[0]!.on_hand, reserved: 3 });
    const supplierPhysical = await pool.query<{ reserved: number }>(
      "SELECT reserved FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'supplier'", [mixedOwned.tplId]);
    assert.equal(supplierPhysical.rows[0]!.reserved, 2);
    // capacity: a pending requirement consumes NOTHING; the atomic hold appears on supplier confirmation.
    const capacityBefore = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [mixedOffer]);
    assert.equal(capacityBefore.rows[0]!.reserved_external, 0);
    const mixedLine = await pool.query<{ id: string }>(
      "SELECT l.id FROM child_order_lines l WHERE l.master_order_id = $1 AND l.series_template_id = $2",
      [mixedMaster.id, mixedOwned.tplId]);
    const confirmMixed = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${mixedLine.rows[0]!.id}/respond`,
      headers: await login(app, alpha.email), payload: { action: 'confirm' } });
    assert.equal(confirmMixed.statusCode, 200, confirmMixed.body);
    const capacityAfter = await pool.query<{ reserved_external: number }>('SELECT reserved_external FROM supplier_offers WHERE id = $1', [mixedOffer]);
    assert.equal(capacityAfter.rows[0]!.reserved_external, 5);
    // capacity still created no physical stock, no receipt and no at-Kolbe balance.
    const fabricated = await pool.query(
      `SELECT (SELECT count(*) FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'kolbe')::int AS kolbe_rows,
              (SELECT count(*) FROM stock_receipts WHERE variant_id = ANY($2::uuid[]))::int AS receipts`,
      [mixedOwned.tplId, mixedOwned.variantIds]);
    assert.deepEqual(fabricated.rows[0], { kolbe_rows: 0, receipts: 0 });
  } finally { await app.close(); await pool.end(); }
});
