/** FINAL PRODUCT STUDIO REMEDIATION — canonical PUBLICATION (§1-§5, §18-§20) + dynamic
 *  Specs/Size-Guide tables (§9-§12, §22).
 *
 *  The release-blocking defect this suite locks down: an explicit «انتشار» left the product
 *  as «پیش‌نویس» forever. Publication is now a server-side catalog decision that
 *    - runs the canonical publication validator (never a silent no-op),
 *    - is completely independent of physical stock and of `inventory_setup` (a WMS receipt
 *      must never publish, and a sold-out product must never fall back to draft).
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
  NODE_ENV: 'test', PORT: 4037, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = { authorization: string };

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('TestPassword123456!'), label]);
  for (const role of roles) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  return { id, email };
}

async function login(app: App, email: string): Promise<Headers> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeWarehouse(pool: Pool, purpose: 'retail' | 'wholesale', label: string) {
  const id = randomUUID();
  await pool.query('INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,$4)',
    [id, `${purpose.slice(0, 2)}-${id.slice(0, 8)}`, label, purpose]);
  return id;
}

/** A retail-only product with every canonical publication requirement satisfied. */
async function createPublishableRetailProduct(app: App, headers: Headers, name: string) {
  const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
    payload: { saveIntent: 'continue', name, brand: 'کلبه', category: 'کت', description: 'توضیح تست',
      cashPriceRial: '45000000', retailEnabled: true, wholesaleEnabled: false,
      metadata: { images: [{ url: '/api/v1/product-media/demo' }] },
      variants: [{ color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }] } });
  assert.equal(created.statusCode, 201, created.body);
  return created.json().id as string;
}

const statusOf = async (pool: Pool, productId: string) =>
  (await pool.query('SELECT status FROM products WHERE id = $1', [productId])).rows[0]?.status as string;

/* ============================================================================
 * §18 — PUBLISH-01: the release-blocking scenario, end to end
 * ========================================================================== */
test('PUBLISH-01: Draft → (WMS receipt, still draft) → explicit انتشار → منتشرشده (persists)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر انتشار');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار خرده انتشار');
    const productId = await createPublishableRetailProduct(app, headers, `کت کبریتی ${randomUUID().slice(0, 6)}`);

    // 1. step 4: the product is a DRAFT with zero physical stock
    assert.equal(await statusOf(pool, productId), 'draft');
    const stockBefore = await pool.query(
      `SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1`, [productId]);
    assert.equal(stockBefore.rows[0].n, 0, 'Product Studio must never write physical stock');

    // 2. step 5: complete the initial inventory through the canonical WMS document
    const variants = (await pool.query('SELECT id FROM product_variants WHERE product_id = $1 AND active ORDER BY sku', [productId])).rows;
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `pub-setup-${randomUUID()}` },
      payload: { retail: { warehouseId: retailWh, mode: 'per_variant',
        perVariant: variants.map((v: { id: string }, i: number) => ({ variantId: v.id, quantity: i === 0 ? 120 : 30 })) } } });
    assert.equal(setup.statusCode, 201, setup.body);

    // 3. step 6 (§B): WMS did NOT auto-publish — inventory is a WMS concern, not a lifecycle
    assert.equal(await statusOf(pool, productId), 'draft', 'a WMS receipt must never auto-publish');
    const afterSetup = await pool.query('SELECT inventory_setup FROM products WHERE id = $1', [productId]);
    assert.equal(afterSetup.rows[0].inventory_setup, 'configured');
    const draftsView = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=drafts&owner=kolbe', headers });
    assert.ok((draftsView.json().items as { id: string }[]).some((p) => p.id === productId),
      'configured draft still belongs to پیش‌نویس‌ها until Admin publishes');

    // 4. step 8/9: the server agrees the product is publishable, then Admin publishes
    const readiness = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/publication-readiness`, headers });
    assert.equal(readiness.statusCode, 200, readiness.body);
    assert.equal(readiness.json().publishable, true, JSON.stringify(readiness.json().issues));
    assert.equal(readiness.json().issues.length, 0);

    const publish = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    assert.equal(publish.statusCode, 200, publish.body);
    assert.equal(publish.json().status, 'published');

    // 5. step 10 (§C): the transition really persisted server-side
    assert.equal(await statusOf(pool, productId), 'published');
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.status_changed' AND resource_id = $1 AND resource_type = 'product'`, [productId]);
    assert.equal(audit.rows[0].n, 1, 'publication is audited exactly once');

    // 6. step 10/11 (§D): the hub read model reflects it — and it survives a hard reload
    const publishedView = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=published&owner=kolbe', headers });
    assert.ok((publishedView.json().items as { id: string }[]).some((p) => p.id === productId),
      'published product must appear under «منتشرشده»');
    const draftsAfter = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=drafts&owner=kolbe', headers });
    assert.ok(!(draftsAfter.json().items as { id: string }[]).some((p) => p.id === productId),
      'published product must disappear from «پیش‌نویس‌ها»');
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, 'published', 'reopening Product Studio must still show منتشرشده');
    const catalogue = await app.inject({ method: 'GET', url: '/api/v1/products?limit=100' });
    assert.ok((catalogue.json().items as { id: string }[]).some((p) => p.id === productId),
      'the storefront eligibility read model must reflect the new state');

    // 7. §5: publishing again is a no-op (idempotent / retry-safe, no second audit row)
    const again = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    assert.equal(again.statusCode, 200, again.body);
    const audit2 = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.status_changed' AND resource_id = $1 AND resource_type = 'product'`, [productId]);
    assert.equal(audit2.rows[0].n, 1, 're-publishing an already published product must not write a second audit row');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §19 — publication is NOT coupled to physical stock
 * ========================================================================== */
test('§19: a publishable catalog product with ZERO stock publishes (منتشرشده + ناموجود, never draft)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر بدون موجودی');
    const headers = await login(app, admin.email);
    const productId = await createPublishableRetailProduct(app, headers, `بدون موجودی ${randomUUID().slice(0, 6)}`);

    // NO WMS receipt at all — inventory_setup is still 'pending'.
    const before = await pool.query('SELECT status, inventory_setup FROM products WHERE id = $1', [productId]);
    assert.equal(before.rows[0].status, 'draft');
    assert.equal(before.rows[0].inventory_setup, 'pending');

    // §19: stock is not a publication requirement → Publish → Published (+ Out of stock)
    const publish = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    assert.equal(publish.statusCode, 200, publish.body);
    assert.equal(await statusOf(pool, productId), 'published', 'a zero-stock product must still be publishable');

    // ...and selling out / never receiving stock must never push it back to draft
    const publishedView = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=published&owner=kolbe', headers });
    assert.ok((publishedView.json().items as { id: string }[]).some((p) => p.id === productId));
    const drafts = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=drafts&owner=kolbe', headers });
    assert.ok(!(drafts.json().items as { id: string }[]).some((p) => p.id === productId),
      'zero stock must never revert a published product to پیش‌نویس');
    // §34: it is «ناموجود» only once the inventory profile is configured and empty.
    const pendingOutOfStock = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=out_of_stock&owner=kolbe', headers });
    assert.ok(!(pendingOutOfStock.json().items as { id: string }[]).some((p) => p.id === productId),
      'inventory_setup=pending reads «—», not a fabricated zero (§34)');

    // after a real WMS receipt of zero pieces the product is configured and truly ناموجود
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار صفر');
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `zero-${randomUUID()}` },
      payload: { retail: { warehouseId: retailWh, mode: 'zero' } } });
    assert.equal(setup.statusCode, 201, setup.body);
    const outOfStock = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=out_of_stock&owner=kolbe', headers });
    assert.ok((outOfStock.json().items as { id: string }[]).some((p) => p.id === productId),
      'a sold-out PUBLISHED product is ناموجود — still published, never a draft');
    assert.equal(await statusOf(pool, productId), 'published');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §20 — publication validation failure: exact reasons, no silent no-op, no mutation
 * ========================================================================== */
test('§20: publishing an incomplete draft answers 422 with the exact Persian issues and mutates nothing', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر ناقص');
    const headers = await login(app, admin.email);

    // structurally valid draft: no price, no variants, no image, no channel price
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `ناقص ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'کت',
        cashPriceRial: '0', variants: [] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;

    const publish = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    // NOT a silent success and NOT a generic error: 422 + the exact missing items.
    assert.equal(publish.statusCode, 422, publish.body);
    assert.equal(publish.json().code, 'PUBLICATION_INCOMPLETE');
    const issues = publish.json().details.issues as { code: string; label: string; step: string }[];
    const codes = issues.map((issue) => issue.code);
    /* Only requirements the domain actually states: a missing retail price and no sellable
       variant. Nothing speculative is demanded (media and physical stock are NOT requirements). */
    for (const expected of ['cash_price', 'variants']) {
      assert.ok(codes.includes(expected), `missing issue «${expected}» in ${JSON.stringify(codes)}`);
    }
    assert.ok(!codes.includes('images'), 'media must never be a publication requirement');
    assert.ok(!codes.includes('stock') && !codes.includes('inventory_setup'), 'stock must never gate publication');
    // every issue names a canonical Product Studio step (§4: navigate the Admin to the fix)
    for (const issue of issues) {
      assert.ok(['base', 'variant', 'media', 'cutout', 'price', 'specs', 'seo', 'review'].includes(issue.step),
        `unknown step «${issue.step}»`);
      assert.ok(issue.label.length > 0 && !/[a-z_]{4,}/.test(issue.label), `raw/technical label: ${issue.label}`);
    }
    // the readiness endpoint answers the same thing before the Admin clicks anything (§4)
    const readiness = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/publication-readiness`, headers });
    assert.equal(readiness.json().publishable, false);
    assert.deepEqual((readiness.json().issues as { code: string }[]).map((i) => i.code), codes);

    // NO partial publication and NO state mutation
    assert.equal(await statusOf(pool, productId), 'draft');
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.status_changed' AND resource_id = $1 AND resource_type = 'product'`, [productId]);
    assert.equal(audit.rows[0].n, 0, 'a rejected publication must not be audited as a transition');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §4 — wholesale: the canonical Series requirement (and only that)
 * ========================================================================== */
test('§4: wholesale publication requires a priced Series — never physical stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر عمده');
    const headers = await login(app, admin.email);

    // wholesale-only product WITHOUT a series → publication must say exactly that
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `عمده ناقص ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'کت',
        cashPriceRial: '0', retailEnabled: false, wholesaleEnabled: true,
        metadata: { images: [{ url: '/api/v1/product-media/demo' }] }, variants: [] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;
    const blocked = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    assert.equal(blocked.statusCode, 422, blocked.body);
    const codes = (blocked.json().details.issues as { code: string }[]).map((issue) => issue.code);
    assert.ok(codes.includes('series'), `expected a series issue, got ${JSON.stringify(codes)}`);
    // retail-specific requirements must NOT be demanded from a wholesale-only product
    assert.ok(!codes.includes('cash_price') && !codes.includes('variants'), JSON.stringify(codes));

    // add the canonical series → publication now succeeds with ZERO stock
    const variant = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { color: 'مشکی', size: 'M' } });
    assert.equal(variant.statusCode, 201, variant.body);
    const series = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
      payload: { productId, name: 'سری کبریتی', items: [{ variantId: variant.json().id, quantityPerSeries: 6 }] } });
    assert.equal(series.statusCode, 201, series.body);
    await pool.query("UPDATE series_templates SET pricing_mode = 'series_total', total_price_rial = $2, min_order_series = $3 WHERE id = $1",
      [series.json().id, '840000000', 1]);
    const publish = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers,
      payload: { status: 'published' } });
    assert.equal(publish.statusCode, 200, publish.body);
    assert.equal(await statusOf(pool, productId), 'published');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §22/§12 — Specs + Size Guide: two independently persisted dynamic tables
 * ========================================================================== */
test('§22: «مشخصات فنی» and «راهنمای سایز» persist as two independent dynamic tables', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر جدول');
    const headers = await login(app, admin.email);
    const productId = await createPublishableRetailProduct(app, headers, `جدول ${randomUUID().slice(0, 6)}`);

    const specsTable = {
      columns: [{ id: 'c1', label: 'ویژگی' }, { id: 'c2', label: 'مقدار' }, { id: 'c3', label: 'توضیح' }],
      rows: [
        { id: 'r1', values: { c1: 'جنس', c2: 'کتان', c3: 'الیاف طبیعی' } },
        { id: 'r2', values: { c1: 'کشور تولید', c2: 'ایران', c3: '' } },
      ],
    };
    const guideTable = {
      columns: [{ id: 's1', label: 'سایز' }, { id: 's2', label: 'دور سینه' }, { id: 's3', label: 'قد' }],
      rows: [
        { id: 'g1', values: { s1: 'S', s2: '92', s3: '68' } },
        { id: 'g2', values: { s1: 'M', s2: '96', s3: '70' } },
      ],
    };

    const savedSpecs = await app.inject({ method: 'PUT', url: `/api/v1/products/${productId}/specs`, headers,
      payload: { table: specsTable } });
    assert.equal(savedSpecs.statusCode, 200, savedSpecs.body);
    const savedGuide = await app.inject({ method: 'PUT', url: `/api/v1/products/${productId}/size-guide`, headers,
      payload: { table: guideTable } });
    assert.equal(savedGuide.statusCode, 200, savedGuide.body);

    // §12: both live in products.metadata.tables — no new table, no parallel authority
    const row = await pool.query<{ metadata: { tables?: Record<string, unknown> } }>('SELECT metadata FROM products WHERE id = $1', [productId]);
    const tables = (row.rows[0]?.metadata?.tables ?? {}) as { specs?: unknown; sizeGuide?: unknown };
    assert.ok(tables.specs && tables.sizeGuide, 'both tables must be persisted');

    // reload: each table comes back on its own endpoint, independently
    const readSpecs = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/specs`, headers });
    assert.equal(readSpecs.statusCode, 200, readSpecs.body);
    assert.deepEqual(readSpecs.json().table, specsTable);
    const readGuide = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/size-guide`, headers });
    assert.equal(readGuide.statusCode, 200, readGuide.body);
    assert.equal(readGuide.json().mode, 'table');
    const guideRows = readGuide.json().guide.rows as { values: Record<string, string> }[];
    assert.deepEqual(guideRows[1]?.values, { s1: 'M', s2: '96', s3: '70' });

    // §12: the public/storefront read shapes still work (projection, no frontend rewrite)
    const projected = readSpecs.json().values as { label: string; value: string }[];
    assert.deepEqual(projected[0], { id: 'r1', label: 'جنس', unit: null, value: 'کتان · الیاف طبیعی', variant_id: null, scope: 'product' });

    // editing one table must never clobber the other
    const updateGuide = await app.inject({ method: 'PUT', url: `/api/v1/products/${productId}/size-guide`, headers,
      payload: { table: { columns: [{ id: 's1', label: 'سایز' }], rows: [{ id: 'g1', values: { s1: 'XL' } }] } } });
    assert.equal(updateGuide.statusCode, 200, updateGuide.body);
    const afterSpecs = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/specs`, headers });
    assert.deepEqual(afterSpecs.json().table, specsTable, 'saving the size guide must not touch the specs table');
    const afterGuide = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/size-guide`, headers });
    assert.equal((afterGuide.json().guide.rows as unknown[]).length, 1);

    // legacy attribute-based specs stay readable for products that still use them
    const legacyProduct = await createPublishableRetailProduct(app, headers, `قدیمی ${randomUUID().slice(0, 6)}`);
    const attr = await app.inject({ method: 'POST', url: '/api/v1/admin/spec-attributes', headers,
      payload: { code: `jens_${randomUUID().slice(0, 8)}`, label: 'جنس پارچه', type: 'text' } });
    assert.equal(attr.statusCode, 201, attr.body);
    const legacyPut = await app.inject({ method: 'PUT', url: `/api/v1/products/${legacyProduct}/specs`, headers,
      payload: { values: [{ attributeCode: attr.json().code, value: 'نخ پنبه' }] } });
    assert.equal(legacyPut.statusCode, 200, legacyPut.body);
    const legacyRead = await app.inject({ method: 'GET', url: `/api/v1/products/${legacyProduct}/specs`, headers });
    assert.equal(legacyRead.json().table, null);
    assert.ok((legacyRead.json().values as unknown[]).length >= 1, 'legacy product_spec_values stay readable');
  } finally { await pool.end(); await app.close(); }
});
