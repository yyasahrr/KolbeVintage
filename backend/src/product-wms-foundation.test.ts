/** Master Prompt 1 — Product/WMS foundation tests (§64).
 *  Covers: admin product owner lock + no-stock-on-save + needs-setup lifecycle,
 *  opening receipts (zero/equal/per-variant, idempotent, audited), category
 *  profiles as source of truth, supplier offers (min/max, capacity ≠ WMS,
 *  freshness, atomic external reservations + expiry), consignment inbound
 *  (approve/dispatch/receive/discrepancy/partial QC), supplier stock-at-kolbe
 *  ownership, stored-stock returns, and stock-level ownership conversion. */
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
  return { id, email };
}

async function login(app: App, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeWarehouse(pool: Pool, purpose: 'retail' | 'wholesale', label: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,$4)`,
    [id, `${purpose.slice(0, 2)}-${id.slice(0, 8)}`, label, purpose]);
  return id;
}

async function makeSupplierProduct(pool: Pool, supplierId: string, name: string) {
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id, supplier_id, brand, name, category, status, cash_price_rial, wholesale_price_rial, owner_type, retail_enabled, wholesale_enabled)
     VALUES ($1,$2,'برند تأمین',$3,'هودی','published',0,90000000,'supplier',false,true)`,
    [productId, supplierId, name]);
  const v1 = randomUUID(); const v2 = randomUUID();
  await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','مشکی'),($4,$2,$5,'L','مشکی')`,
    [v1, productId, `SPT-${productId.slice(0, 8)}-M`, v2, `SPT-${productId.slice(0, 8)}-L`]);
  const tplId = randomUUID();
  await pool.query(`INSERT INTO series_templates(id, product_id, name, color_label) VALUES ($1,$2,'سری ویژه','مشکی')`, [tplId, productId]);
  await pool.query(`INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,1),($4,$2,$5,1)`,
    [randomUUID(), tplId, v1, randomUUID(), v2]);
  return { productId, variantIds: [v1, v2], tplId };
}

test('admin product: always kolbe-owned (spoof ignored), no stock on save, needs-setup → configured (§4/§15/§16)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'مدیر محصول');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار خرده تست');

    // §4: the client tries to spoof supplier ownership — server derives kolbe anyway.
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
      name: `محصول کلبه ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی', description: 'تست',
      cashPriceRial: '120000000',
      variants: [{ color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }],
      ownerType: 'supplier', supplierId: randomUUID(), owner: 'supplier', // ← spoof attempt, must be ignored
    } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;
    assert.equal(created.json().ownerType, 'kolbe');
    const row = await pool.query(`SELECT owner_type, supplier_id, inventory_setup FROM products WHERE id = $1`, [productId]);
    assert.equal(row.rows[0].owner_type, 'kolbe');
    assert.equal(row.rows[0].supplier_id, null);
    assert.equal(row.rows[0].inventory_setup, 'pending'); // «نیازمند راه‌اندازی»

    // §15: product definition created ZERO stock rows (no receipt, no balance, no series).
    const balances = await pool.query(
      `SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1`, [productId]);
    assert.equal(balances.rows[0].n, 0, 'product save must not create stock');

    // needs-setup list contains it; '—' semantics = pending (NOT zero).
    const needs = await app.inject({ method: 'GET', url: '/api/v1/admin/products/needs-setup', headers });
    assert.equal(needs.statusCode, 200);
    assert.ok((needs.json().items as { id: string }[]).some((p) => p.id === productId));

    // §19 zero mode: configure with zero stock → state flips, balances exist with 0.
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `setup-${productId}` },
      payload: { retail: { warehouseId: retailWh, mode: 'zero' } } });
    assert.equal(setup.statusCode, 201, setup.body);
    const after = await pool.query(`SELECT inventory_setup FROM products WHERE id = $1`, [productId]);
    assert.equal(after.rows[0].inventory_setup, 'configured');
    const zeroBalances = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(b.on_hand),0)::int AS total FROM stock_balances b
       JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1 AND b.inventory_domain = 'retail'`, [productId]);
    assert.equal(zeroBalances.rows[0].n, 2);      // configured …
    assert.equal(zeroBalances.rows[0].total, 0);  // … with REAL zero (0, not '—')
    const needs2 = await app.inject({ method: 'GET', url: '/api/v1/admin/products/needs-setup', headers });
    assert.ok(!(needs2.json().items as { id: string }[]).some((p) => p.id === productId));

    // configured products cannot be re-setup (changes go through normal WMS ops).
    const again = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `setup2-${productId}` },
      payload: { retail: { warehouseId: retailWh, mode: 'equal', quantity: 5 } } });
    assert.equal(again.statusCode, 409, again.body);
  } finally { await pool.end(); await app.close(); }
});

test('WMS setup cannot enable a catalog sales channel', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'مدیر کانال فروش');
    const headers = await login(app, admin.email);
    const warehouseId = await makeWarehouse(pool, 'retail', 'انبار خرده کانال');
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
      name: 'کالای فقط عمده', brand: 'کلبه', category: 'هودی', cashPriceRial: '0', wholesalePriceRial: '80000000',
      retailEnabled: false, wholesaleEnabled: true, variants: [{ color: 'کرم', size: 'M' }],
    } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${id}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `channel-${id}` },
      payload: { retail: { warehouseId, mode: 'equal', quantity: 6 } } });
    assert.equal(setup.statusCode, 409, setup.body);
    const row = await pool.query('SELECT retail_enabled, wholesale_enabled, inventory_setup FROM products WHERE id = $1', [id]);
    assert.deepEqual(row.rows[0], { retail_enabled: false, wholesale_enabled: true, inventory_setup: 'pending' });
    const balances = await pool.query('SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1', [id]);
    assert.equal(balances.rows[0].n, 0);
  } finally { await pool.end(); await app.close(); }
});

test('opening stock: equal/per-variant/wholesale series through audited receipts, idempotent (§19/§20)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'مدیر راه‌اندازی');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار خرده ۲');
    const wholesaleWh = await makeWarehouse(pool, 'wholesale', 'انبار مرکزی عمده ۲');

    const make = async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
        name: `کالا ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی', description: '',
        cashPriceRial: '100000000', wholesalePriceRial: '80000000',
        variants: [{ color: 'سبز', size: 'M' }, { color: 'سبز', size: 'L' }],
      } });
      assert.equal(res.statusCode, 201, res.body);
      const id = res.json().id as string;
      const variants = (res.json().variants as { id: string }[]).map((v) => v.id);
      return { id, variants };
    };

    // equal mode + §19 preview math: 2 variants × 5 = 10 pieces.
    const p1 = await make();
    const key1 = `op-${p1.id}`;
    const eq = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${p1.id}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key1 },
      payload: { retail: { warehouseId: retailWh, mode: 'equal', quantity: 5 } } });
    assert.equal(eq.statusCode, 201, eq.body);
    assert.equal((eq.json().retail as { totalPieces: number }).totalPieces, 10);
    const eqBal = await pool.query(
      `SELECT b.on_hand FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id
       WHERE v.product_id = $1 AND b.inventory_domain = 'retail' ORDER BY v.sku`, [p1.id]);
    assert.deepEqual(eqBal.rows.map((r) => r.on_hand), [5, 5]);
    // opening went through REAL receipt documents, and is audited.
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM stock_receipts r JOIN product_variants v ON v.id = r.variant_id
       WHERE v.product_id = $1 AND r.status = 'received'`, [p1.id]);
    assert.equal(receipts.rows[0].n, 2);
    const audited = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.inventory_setup' AND resource_id = $1`, [p1.id]);
    assert.equal(audited.rows[0].n, 1);
    // §64 idempotency: exact same call + same key replays the stored response, no double stock.
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${p1.id}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key1 },
      payload: { retail: { warehouseId: retailWh, mode: 'equal', quantity: 5 } } });
    assert.equal(replay.statusCode, 201, replay.body);
    const eqBal2 = await pool.query(
      `SELECT sum(b.on_hand)::int AS total FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id
       WHERE v.product_id = $1 AND b.inventory_domain = 'retail'`, [p1.id]);
    assert.equal(eqBal2.rows[0].total, 10, 'idempotent replay must not duplicate opening stock');

    // per-variant mode + wholesale series opening in ONE setup call.
    const p2 = await make();
    const tplId = randomUUID();
    await pool.query(`INSERT INTO series_templates(id, product_id, name, color_label) VALUES ($1,$2,'سری سبز','سبز')`, [tplId, p2.id]);
    await pool.query(
      `INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,2),($4,$2,$5,2)`,
      [randomUUID(), tplId, p2.variants[0], randomUUID(), tplId === tplId ? p2.variants[1] : p2.variants[1]]);
    const pv = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${p2.id}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `op2-${p2.id}` },
      payload: {
        retail: { warehouseId: retailWh, mode: 'per_variant', perVariant: [
          { variantId: p2.variants[0], quantity: 3 }, { variantId: p2.variants[1], quantity: 7 }] },
        wholesale: { warehouseId: wholesaleWh, seriesTemplateId: tplId, seriesCount: 4 },
      } });
    assert.equal(pv.statusCode, 201, pv.body);
    const pvBal = await pool.query(
      `SELECT b.on_hand FROM stock_balances b WHERE b.variant_id = ANY($1::uuid[]) AND b.inventory_domain = 'retail' ORDER BY b.on_hand`,
      [[p2.variants[0], p2.variants[1]]]);
    assert.deepEqual(pvBal.rows.map((r) => r.on_hand), [3, 7]);
    // wholesale: counted as SERIES (kolbe-owned), with overlay pieces behind it — not derived from retail.
    const series = await pool.query(
      `SELECT on_hand, owner_type FROM series_stock_balances WHERE series_template_id = $1`, [tplId]);
    assert.equal(series.rows[0].on_hand, 4);
    assert.equal(series.rows[0].owner_type, 'kolbe');
    const wsPieces = await pool.query(
      `SELECT sum(on_hand)::int AS total FROM stock_balances WHERE variant_id = ANY($1::uuid[]) AND inventory_domain = 'wholesale' AND warehouse_id = $2`,
      [[p2.variants[0], p2.variants[1]], wholesaleWh]);
    assert.equal(wsPieces.rows[0].total, 16); // 4 series × (2+2)
  } finally { await pool.end(); await app.close(); }
});

test('category profiles: category is the schema source of truth — no product type in the new flow (§8-§10)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر دسته');
    const headers = await login(app, admin.email);
    const category = `کت تست ${randomUUID().slice(0, 6)}`;

    // real spec template with ONE required attribute + an active size guide.
    const attrId = randomUUID(); const tplId = randomUUID(); const guideId = randomUUID();
    await pool.query(
      `INSERT INTO spec_attributes(id, code, label, type, required, active) VALUES ($1,$2,'جنس پارچه','text',true,true)`,
      [attrId, `fabric-${attrId.slice(0, 8)}`]);
    await pool.query(`INSERT INTO spec_templates(id, code, name) VALUES ($1,$2,'قالب تست')`, [tplId, `tpl-${tplId.slice(0, 8)}`]);
    await pool.query(`INSERT INTO spec_template_attributes(template_id, attribute_id, position) VALUES ($1,$2,0)`, [tplId, attrId]);
    await pool.query(`INSERT INTO size_guides(id, code, name, status) VALUES ($1,$2,'راهنمای تست','active')`, [guideId, `sg-${guideId.slice(0, 8)}`]);

    const put = await app.inject({ method: 'PUT', url: `/api/v1/admin/category-profiles/${encodeURIComponent(category)}`, headers,
      payload: { specTemplateId: tplId, sizeGuideId: guideId, allowedSizes: ['M', 'L'] } });
    assert.equal(put.statusCode, 201, put.body);

    const attrCode = `fabric-${attrId.slice(0, 8)}`;
    const base = {
      brand: 'کلبه', category, description: '', cashPriceRial: '90000000',
    };
    // missing required category spec → rejected (category drives validation, no product type involved).
    const missing = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { ...base, name: `بدون مشخصه ${randomUUID().slice(0, 4)}`, variants: [{ color: 'مشکی', size: 'M' }] } });
    assert.equal(missing.statusCode, 400, missing.body);
    // size outside the category bounds → rejected.
    const badSize = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { ...base, name: `سایز بد ${randomUUID().slice(0, 4)}`, specifications: { [attrCode]: 'نخ پنبه' },
        variants: [{ color: 'مشکی', size: 'XXL' }] } });
    assert.equal(badSize.statusCode, 400, badSize.body);
    // valid per category schema → created WITHOUT any productTypeCode/productTypeId.
    const ok = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { ...base, name: `معتبر ${randomUUID().slice(0, 4)}`, specifications: { [attrCode]: 'نخ پنبه' },
        variants: [{ color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }] } });
    assert.equal(ok.statusCode, 201, ok.body);

    // the Studio reads the category schema from the server.
    const schema = await app.inject({ method: 'GET', url: `/api/v1/catalog/categories/${encodeURIComponent(category)}/schema`, headers });
    assert.equal(schema.statusCode, 200);
    assert.equal(schema.json().configured, true);
    assert.ok((schema.json().specFields as unknown[]).length >= 1);
    assert.equal((schema.json().sizeGuide as { id: string }).id, guideId);

    // §14 regression (final UAT gate): the category size bound also guards LATER variant
    // additions — POST /products/:id/variants with an out-of-profile size must be 400.
    const productId = ok.json().id as string;
    const clearSpecs = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers,
      payload: { specifications: {} } });
    assert.equal(clearSpecs.statusCode, 400, clearSpecs.body);
    const savedSpecs = await pool.query('SELECT specifications FROM products WHERE id = $1', [productId]);
    assert.equal(savedSpecs.rows[0].specifications[attrCode], 'نخ پنبه');
    const rename = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers,
      payload: { name: 'نام تازه بدون تغییر مشخصات' } });
    assert.equal(rename.statusCode, 200, rename.body);
    const badVariant = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { color: 'مشکی', size: 'XXL' } });
    assert.equal(badVariant.statusCode, 400, badVariant.body);
    // official extension workflow: extend the category profile, then the size is accepted.
    const extend = await app.inject({ method: 'PUT', url: `/api/v1/admin/category-profiles/${encodeURIComponent(category)}`, headers,
      payload: { specTemplateId: tplId, sizeGuideId: guideId, allowedSizes: ['M', 'L', 'XXL'] } });
    assert.equal(extend.statusCode, 200, extend.body);
    const okVariant = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { color: 'مشکی', size: 'XXL' } });
    assert.equal(okVariant.statusCode, 201, okVariant.body);
    const identity = await pool.query('SELECT category_id FROM products WHERE id = $1', [productId]);
    const categoryId = identity.rows[0].category_id;
    assert.ok(categoryId);
    const profileIdentity = await pool.query('SELECT category_id FROM category_profiles WHERE category = $1', [category]);
    assert.equal(profileIdentity.rows[0].category_id, categoryId);
    const renamed = `${category} جدید`;
    await pool.query('UPDATE cms_categories SET name = $2 WHERE id = $1', [categoryId, renamed]);
    const projected = await pool.query('SELECT category, category_id FROM products WHERE id = $1', [productId]);
    assert.deepEqual(projected.rows[0], { category: renamed, category_id: categoryId });
    const renamedSchema = await app.inject({ method: 'GET', url: `/api/v1/catalog/categories/${encodeURIComponent(renamed)}/schema`, headers });
    assert.equal(renamedSchema.json().configured, true);
    assert.equal(renamedSchema.json().sizeGuide.id, guideId);
  } finally { await pool.end(); await app.close(); }
});

test('supplier offers: scope guards, min/max, capacity ≠ WMS, freshness, atomic reservations + TTL (§29-§34)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'مدیر عمده');
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین الف');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین ب');
    const adminHeaders = await login(app, admin.email);
    const aHeaders = await login(app, supplierA.email);
    const bHeaders = await login(app, supplierB.email);
    const { productId, variantIds, tplId } = await makeSupplierProduct(pool, supplierA.id, `محصول الف ${randomUUID().slice(0, 4)}`);

    // min/max validated server-side.
    const badMinMax = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: aHeaders,
      payload: { productId, seriesTemplateId: tplId, colorLabel: 'مشکی', minOrderSeries: 5, maxOrderSeries: 2, fulfillmentMode: 'hybrid' } });
    assert.equal(badMinMax.statusCode, 400, badMinMax.body);
    const offer = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: aHeaders,
      payload: { productId, seriesTemplateId: tplId, colorLabel: 'مشکی', minOrderSeries: 2, maxOrderSeries: 10,
        fulfillmentMode: 'hybrid', safetyBuffer: 2, wholesalePriceRial: '85000000' } });
    assert.equal(offer.statusCode, 201, offer.body);
    const offerId = offer.json().id as string;

    // IDOR: supplier B cannot offer A's product, cannot touch A's capacity.
    const idor = await app.inject({ method: 'POST', url: '/api/v1/supplier/offers', headers: bHeaders,
      payload: { productId, minOrderSeries: 1 } });
    assert.equal(idor.statusCode, 403, idor.body);
    const idorCap = await app.inject({ method: 'POST', url: `/api/v1/supplier/offers/${offerId}/capacity`, headers: bHeaders,
      payload: { declaredCapacity: 99 } });
    assert.equal(idorCap.statusCode, 403, idorCap.body);

    // §31: declared capacity — formula server-side (30 - 0 reserved - 2 buffer = 28), freshness fresh.
    const cap = await app.inject({ method: 'POST', url: `/api/v1/supplier/offers/${offerId}/capacity`, headers: aHeaders,
      payload: { declaredCapacity: 30 } });
    assert.equal(cap.statusCode, 200, cap.body);
    assert.equal(cap.json().availableToRequest, 28);
    assert.equal(cap.json().freshness, 'fresh');
    // §31: declared capacity NEVER lands in WMS stock tables.
    const wms = await pool.query(
      `SELECT count(*)::int AS n FROM stock_balances WHERE variant_id = ANY($1::uuid[])`, [variantIds]);
    assert.equal(wms.rows[0].n, 0, 'declared capacity must not create stock_balances');
    const seriesWms = await pool.query(`SELECT count(*)::int AS n FROM series_stock_balances WHERE series_template_id = $1`, [tplId]);
    assert.equal(seriesWms.rows[0].n, 0, 'declared capacity must not create series stock');

    // §33: atomic external reservation (admin/ops primitive) — over-reserve conflicts.
    const resv = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-offers/${offerId}/reservations`,
      headers: adminHeaders, payload: { quantity: 7, ttlMinutes: 60 } });
    assert.equal(resv.statusCode, 201, resv.body);
    assert.equal(resv.json().availableAfter, 21);
    const over = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-offers/${offerId}/reservations`,
      headers: adminHeaders, payload: { quantity: 25 } });
    assert.equal(over.statusCode, 409, over.body);
    // lowering declared below reserved is blocked.
    const lower = await app.inject({ method: 'POST', url: `/api/v1/supplier/offers/${offerId}/capacity`, headers: aHeaders,
      payload: { declaredCapacity: 5 } });
    assert.equal(lower.statusCode, 409, lower.body);
    // release frees capacity.
    const release = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-offers/reservations/${resv.json().reservationId}/release`,
      headers: adminHeaders });
    assert.equal(release.statusCode, 200, release.body);
    // TTL expiry sweep.
    const resv2 = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-offers/${offerId}/reservations`,
      headers: adminHeaders, payload: { quantity: 4, ttlMinutes: 30 } });
    assert.equal(resv2.statusCode, 201);
    await pool.query(`UPDATE supplier_capacity_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [resv2.json().reservationId]);
    const sweep = await app.inject({ method: 'POST', url: '/api/v1/admin/supplier-offers/reservations/expire-sweep', headers: adminHeaders });
    assert.ok((sweep.json().expired as number) >= 1);
    const offerRow = await pool.query(`SELECT reserved_external FROM supplier_offers WHERE id = $1`, [offerId]);
    assert.equal(offerRow.rows[0].reserved_external, 0, 'expired reservation must free capacity');

    // §36: availability keeps the two sources apart for the marketplace.
    const avail = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/wholesale-availability`, headers: adminHeaders });
    assert.equal(avail.statusCode, 200);
    const offerView = (avail.json().supplierOffers as Record<string, unknown>[])[0]!;
    assert.equal(offerView.stockAtKolbeSeries, 0);
    assert.equal(offerView.externalAvailableToRequest, 28);
  } finally { await pool.end(); await app.close(); }
});

test('consignment: inbound approve/dispatch/receive/QC, discrepancy, owner stays supplier, returns + conversion (§25-§27/§35/§37/§50)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'انباردار');
    const supplierA = await makeUser(pool, ['supplier'], 'تأمین امانی');
    const supplierB = await makeUser(pool, ['supplier'], 'تأمین غریبه');
    const adminHeaders = await login(app, admin.email);
    const aHeaders = await login(app, supplierA.email);
    const bHeaders = await login(app, supplierB.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'خرده امانی');
    const wholesaleWh = await makeWarehouse(pool, 'wholesale', 'مرکزی امانی');
    const { productId, variantIds, tplId } = await makeSupplierProduct(pool, supplierA.id, `امانی ${randomUUID().slice(0, 4)}`);

    // request (supplier B spoofing A's product → 403).
    const idor = await app.inject({ method: 'POST', url: '/api/v1/supplier/inbounds', headers: bHeaders,
      payload: { productId, seriesTemplateId: tplId, expectedSeries: 10 } });
    assert.equal(idor.statusCode, 403, idor.body);
    const req = await app.inject({ method: 'POST', url: '/api/v1/supplier/inbounds', headers: aHeaders,
      payload: { productId, seriesTemplateId: tplId, expectedSeries: 50 } });
    assert.equal(req.statusCode, 201, req.body);
    const inboundId = req.json().id as string;

    // approval: retail warehouse rejected by the purpose guard; wholesale accepted.
    const badWh = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/review`,
      headers: adminHeaders, payload: { decision: 'approve', warehouseId: retailWh } });
    assert.equal(badWh.statusCode, 400, badWh.body);
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/review`,
      headers: adminHeaders, payload: { decision: 'approve', warehouseId: wholesaleWh } });
    assert.equal(approve.statusCode, 200, approve.body);
    // approval creates NO stock (only incoming later at dispatch).
    const afterApprove = await pool.query(`SELECT count(*)::int AS n FROM series_stock_balances WHERE series_template_id = $1`, [tplId]);
    assert.equal(afterApprove.rows[0].n, 0, 'inbound approval must not create stock');

    // dispatch (IDOR: supplier B cannot dispatch A's inbound).
    const dispatchIdor = await app.inject({ method: 'POST', url: `/api/v1/supplier/inbounds/${inboundId}/dispatch`, headers: bHeaders, payload: {} });
    assert.equal(dispatchIdor.statusCode, 403);
    const dispatch = await app.inject({ method: 'POST', url: `/api/v1/supplier/inbounds/${inboundId}/dispatch`, headers: aHeaders,
      payload: { batchReference: 'BATCH-77' } });
    assert.equal(dispatch.statusCode, 200, dispatch.body);
    const incoming = await pool.query(
      `SELECT incoming, owner_type, supplier_id FROM series_stock_balances WHERE series_template_id = $1`, [tplId]);
    assert.equal(incoming.rows[0].incoming, 50);
    assert.equal(incoming.rows[0].owner_type, 'supplier');
    assert.equal(incoming.rows[0].supplier_id, supplierA.id);

    // receive 49 of 50 → shortage=1 recorded; double receive blocked.
    const recv = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/receive`,
      headers: adminHeaders, payload: { receivedSeries: 49 } });
    assert.equal(recv.statusCode, 200, recv.body);
    assert.equal(recv.json().shortageSeries, 1);
    const recvAgain = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/receive`,
      headers: adminHeaders, payload: { receivedSeries: 49 } });
    assert.equal(recvAgain.statusCode, 409, 'duplicate receipt must be blocked');

    // QC must settle exactly the received count; partial pass 47 + reject 2.
    const badQc = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/qc`,
      headers: adminHeaders, payload: { passedSeries: 40, rejectedSeries: 5 } });
    assert.equal(badQc.statusCode, 400, badQc.body);
    const qc = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/qc`,
      headers: adminHeaders, payload: { passedSeries: 47, rejectedSeries: 2 } });
    assert.equal(qc.statusCode, 200, qc.body);
    const qcAgain = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-inbounds/${inboundId}/qc`,
      headers: adminHeaders, payload: { passedSeries: 47, rejectedSeries: 2 } });
    assert.equal(qcAgain.statusCode, 409, 'duplicate QC must be blocked');

    // §27/§35: only 47 verified; 2 quarantined as damaged; owner stays supplier; pieces overlay credited.
    const bal = await pool.query(
      `SELECT on_hand, reserved, damaged, owner_type, supplier_id FROM series_stock_balances WHERE series_template_id = $1`, [tplId]);
    assert.equal(bal.rows[0].on_hand, 47);
    assert.equal(bal.rows[0].damaged, 2);
    assert.equal(bal.rows[0].owner_type, 'supplier');
    const pieces = await pool.query(
      `SELECT sum(on_hand)::int AS total FROM stock_balances WHERE variant_id = ANY($1::uuid[]) AND inventory_domain = 'wholesale'`, [variantIds]);
    assert.equal(pieces.rows[0].total, 94); // 47 series × (1+1)

    // stock-at-kolbe read model: supplier sees own rows only (B sees none of A's stock).
    const mine = await app.inject({ method: 'GET', url: '/api/v1/admin/supplier-stock', headers: aHeaders });
    assert.equal(mine.statusCode, 200);
    assert.ok((mine.json().items as unknown[]).length >= 1);
    const foreign = await app.inject({ method: 'GET', url: '/api/v1/admin/supplier-stock', headers: bHeaders });
    assert.equal((foreign.json().items as unknown[]).length, 0);

    // §37 return: reserve 8 → available 39; over-return 40 rejected; 10 allowed → completes to 37.
    await pool.query(`UPDATE series_stock_balances SET reserved = 8 WHERE series_template_id = $1`, [tplId]);
    const overReturn = await app.inject({ method: 'POST', url: '/api/v1/supplier/stock-returns', headers: aHeaders,
      payload: { seriesTemplateId: tplId, warehouseId: wholesaleWh, seriesCount: 40 } });
    assert.equal(overReturn.statusCode, 409, overReturn.body);
    const ret = await app.inject({ method: 'POST', url: '/api/v1/supplier/stock-returns', headers: aHeaders,
      payload: { seriesTemplateId: tplId, warehouseId: wholesaleWh, seriesCount: 10 } });
    assert.equal(ret.statusCode, 201, ret.body);
    const retId = ret.json().id as string;
    const approveRet = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-returns/${retId}/review`,
      headers: adminHeaders, payload: { decision: 'approve' } });
    assert.equal(approveRet.statusCode, 200, approveRet.body);
    const completeRet = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-returns/${retId}/review`,
      headers: adminHeaders, payload: { decision: 'complete' } });
    assert.equal(completeRet.statusCode, 200, completeRet.body);
    const afterRet = await pool.query(`SELECT on_hand, reserved FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'supplier'`, [tplId]);
    assert.equal(afterRet.rows[0].on_hand, 37);
    assert.equal(afterRet.rows[0].reserved, 8, 'reserved stock is never returnable');

    // §50: stock-level ownership conversion is a document, never a silent flip.
    const convKey = `conv-${inboundId}`;
    const conv = await app.inject({ method: 'POST', url: '/api/v1/admin/inventory/series-ownership-conversions',
      headers: adminHeaders, payload: {
        seriesTemplateId: tplId, warehouseId: wholesaleWh, supplierId: supplierA.id,
        seriesCount: 5, unitCostRial: '60000000', idempotencyKey: convKey } });
    assert.equal(conv.statusCode, 201, conv.body);
    const convReplay = await app.inject({ method: 'POST', url: '/api/v1/admin/inventory/series-ownership-conversions',
      headers: adminHeaders, payload: {
        seriesTemplateId: tplId, warehouseId: wholesaleWh, supplierId: supplierA.id,
        seriesCount: 5, unitCostRial: '60000000', idempotencyKey: convKey } });
    assert.equal(convReplay.statusCode, 200, 'conversion replay must be a no-op duplicate');
    const owners = await pool.query(
      `SELECT owner_type, on_hand FROM series_stock_balances WHERE series_template_id = $1 ORDER BY owner_type`, [tplId]);
    assert.deepEqual(owners.rows.map((r) => `${r.owner_type}:${r.on_hand}`), ['kolbe:5', 'supplier:32']);
    const convDoc = await pool.query(
      `SELECT count(*)::int AS n FROM ownership_conversions WHERE series_template_id = $1 AND series_count = 5`, [tplId]);
    assert.equal(convDoc.rows[0].n, 1);
    const convAudit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ownership_conversion.series_stock'`);
    assert.ok(convAudit.rows[0].n >= 1);
  } finally { await pool.end(); await app.close(); }
});
