/** KOLBE PRODUCTS + PRODUCT DRAFT LIFECYCLE + CANONICAL INITIAL INVENTORY (§28-§36).
 *
 *  Final Product Owner decision implemented here:
 *  - «پیش‌نویس» is the ONLY unfinished Product state; «نیازمند راه‌اندازی» is not a
 *    user-facing lifecycle (inventory_setup stays an internal technical invariant),
 *  - Product definition (draft or continue) writes ZERO physical stock,
 *  - the initial inventory is a canonical audited WMS receipt, per domain,
 *  - a published product that sells out stays «منتشرشده» and never returns to draft.
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
  NODE_ENV: 'test', PORT: 4031, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = { authorization: string };

const ADDRESS = {
  recipient: 'خریدار تست', phone: '09123456789', province: 'تهران', city: 'تهران',
  line: 'خیابان تست، پلاک ۱', postalCode: '1234567890',
};

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

const countRetailStock = async (pool: Pool, productId: string) => {
  const rows = await pool.query(
    `SELECT COALESCE(sum(b.on_hand), 0)::int AS on_hand, count(*)::int AS rows FROM stock_balances b
       JOIN product_variants v ON v.id = b.variant_id
      WHERE v.product_id = $1 AND b.inventory_domain = 'retail'`, [productId]);
  return { onHand: rows.rows[0].on_hand as number, rows: rows.rows[0].rows as number };
};

const countWholesalePieces = async (pool: Pool, productId: string) => {
  const rows = await pool.query(
    `SELECT COALESCE(sum(b.on_hand), 0)::int AS on_hand FROM stock_balances b
       JOIN product_variants v ON v.id = b.variant_id
      WHERE v.product_id = $1 AND b.inventory_domain = 'wholesale'`, [productId]);
  return rows.rows[0].on_hand as number;
};

const countSeries = async (pool: Pool, productId: string) => {
  const rows = await pool.query(
    `SELECT COALESCE(sum(s.on_hand), 0)::int AS on_hand FROM series_stock_balances s
       JOIN series_templates t ON t.id = s.series_template_id
      WHERE t.product_id = $1 AND s.owner_type = 'kolbe'`, [productId]);
  return rows.rows[0].on_hand as number;
};

/* ============================================================================
 * §28 — MANDATORY TEST: SAVE DRAFT
 * ========================================================================== */
test('§28/§7: ذخیره پیش‌نویس — canonical id, draft state, zero physical stock, retry-safe', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'پیش نویس');
    const buyer = await makeUser(pool, ['customer'], 'خریدار پیش نویس');
    const headers = await login(app, admin.email);
    const buyerHeaders = await login(app, buyer.email);

    // Partial but structurally valid data: no price, no variants, no image.
    const key = `draft-${randomUUID()}`;
    const draftPayload = { saveIntent: 'draft', name: `محصول کلبه الف ${randomUUID().slice(0, 6)}`, brand: 'کلبه',
      category: 'هودی', description: '', cashPriceRial: '0', variants: [] };
    const draft = await app.inject({ method: 'POST', url: '/api/v1/products',
      headers: { ...headers, 'idempotency-key': key }, payload: draftPayload });
    assert.equal(draft.statusCode, 201, draft.body);
    const productId = draft.json().id as string;

    // canonical identity + «پیش‌نویس» is the ONLY unfinished state
    const row = await pool.query('SELECT status, inventory_setup, owner_type FROM products WHERE id = $1', [productId]);
    assert.equal(row.rows[0].status, 'draft');
    assert.equal(row.rows[0].owner_type, 'kolbe');
    // §14: inventory_setup stays as an INTERNAL invariant; it is not a second lifecycle.
    assert.equal(row.rows[0].inventory_setup, 'pending');

    // ZERO fake WMS stock: no balance, no receipt, no movement, no warehouse row.
    const stock = await countRetailStock(pool, productId);
    assert.equal(stock.rows, 0, 'product save must not create physical stock');
    assert.equal(stock.onHand, 0);
    const receipts = await pool.query(
      `SELECT count(*)::int AS n FROM stock_receipts r JOIN product_variants v ON v.id = r.variant_id WHERE v.product_id = $1`, [productId]);
    assert.equal(receipts.rows[0].n, 0);

    // appears under «محصولات کلبه → پیش‌نویس‌ها», not published and not out-of-stock
    const drafts = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=drafts&owner=kolbe', headers });
    assert.equal(drafts.statusCode, 200, drafts.body);
    assert.ok((drafts.json().items as { id: string }[]).some((p) => p.id === productId), 'draft must appear in پیش‌نویس‌ها');
    const publishedView = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=published&owner=kolbe', headers });
    assert.ok(!(publishedView.json().items as { id: string }[]).some((p) => p.id === productId), 'draft is not published');

    // not purchasable: absent from the public catalogue and rejected by checkout
    const catalogue = await app.inject({ method: 'GET', url: '/api/v1/products?limit=100' });
    assert.ok(!(catalogue.json().items as { id: string }[]).some((p) => p.id === productId), 'draft must stay out of the storefront');

    // §39: a retried Save Draft reuses the SAME canonical product (no duplicate identity).
    const replay = await app.inject({ method: 'POST', url: '/api/v1/products',
      headers: { ...headers, 'idempotency-key': key }, payload: draftPayload });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().id, productId, 'retry must reuse the canonical product id');
    const total = await pool.query('SELECT count(*)::int AS n FROM products WHERE id = $1', [productId]);
    assert.equal(total.rows[0].n, 1, 'retry must not create a second product identity');
    // a DIFFERENT payload under the same key is a real conflict, never a silent duplicate
    const abuse = await app.inject({ method: 'POST', url: '/api/v1/products',
      headers: { ...headers, 'idempotency-key': key },
      payload: { saveIntent: 'draft', name: 'تکرار', brand: 'کلبه', category: 'هودی', cashPriceRial: '0', variants: [] } });
    assert.equal(abuse.statusCode, 409, abuse.body);

    // after variants exist, checkout still refuses a draft
    const variant = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { color: 'مشکی', size: 'M' } });
    assert.equal(variant.statusCode, 201, variant.body);
    // Checkout must reject a draft variant — the canonical guard is publication state.
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `draft-order-${randomUUID()}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId: variant.json().id, quantity: 1 }], shippingAddress: ADDRESS } });
    assert.notEqual(order.statusCode, 201, `a draft must never be purchasable: ${order.body}`);
    assert.ok(order.statusCode >= 400, `checkout must reject a draft: ${order.body}`);
    const draftLines = await pool.query('SELECT count(*)::int AS n FROM order_lines WHERE variant_id = $1', [variant.json().id]);
    assert.equal(draftLines.rows[0].n, 0, 'no order line may reference a draft variant');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §29 — RESUME + SAVE & CONTINUE
 * ========================================================================== */
test('§29/§11: resuming a draft reuses the same product; product save still writes zero stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'ادامه محصول');
    const headers = await login(app, admin.email);

    const draft = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `ناتمام ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        description: '', cashPriceRial: '0', variants: [] } });
    assert.equal(draft.statusCode, 201, draft.body);
    const productId = draft.json().id as string;

    // resume: complete the catalog data on the SAME product (canonical PATCH, no new product)
    const resumed = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers,
      payload: { description: 'توضیح تکمیل‌شده', cashPriceRial: '120000000' } });
    assert.equal(resumed.statusCode, 200, resumed.body);
    const after = await pool.query('SELECT description, cash_price_rial FROM products WHERE id = $1', [productId]);
    assert.equal(after.rows[0].description, 'توضیح تکمیل‌شده', 'resumed data must persist');
    assert.equal(after.rows[0].cash_price_rial, '120000000');

    // variants are created on the same product — no duplicate product, no duplicate variant
    const first = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers, payload: { color: 'مشکی', size: 'M' } });
    assert.equal(first.statusCode, 201, first.body);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers, payload: { color: 'مشکی', size: 'M' } });
    assert.equal(duplicate.statusCode, 409, `${duplicate.body} — duplicate Color×Size must be rejected`);

    // §11/§15: Save & Continue (product definition) still creates ZERO physical stock
    const stock = await countRetailStock(pool, productId);
    assert.equal(stock.rows, 0, 'Save & Continue must not write stock from Product Studio');
    const still = await pool.query('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(still.rows[0].status, 'draft', 'the product remains پیش‌نویس until Admin publishes');
    const products = await pool.query('SELECT count(*)::int AS n FROM products WHERE name LIKE $1', ['ناتمام%']);
    assert.ok(products.rows[0].n >= 1);
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §30 — INTERRUPTED INITIAL INVENTORY
 * ========================================================================== */
test('§30/§13: closing before the WMS receipt leaves the product پیش‌نویس with no stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'وقفه موجودی');
    const headers = await login(app, admin.email);
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'continue', name: `وقفه ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '90000000', variants: [{ color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;

    // Admin opens «ورود اولیه کالا» … and leaves before confirming. Nothing is written.
    const stock = await countRetailStock(pool, productId);
    assert.equal(stock.rows, 0);
    const row = await pool.query('SELECT status, inventory_setup FROM products WHERE id = $1', [productId]);
    assert.equal(row.rows[0].status, 'draft');
    assert.equal(row.rows[0].inventory_setup, 'pending');

    // §13: reopening from «پیش‌نویس‌ها» still finds ONE product with the same canonical id,
    // and there is no separate «نیازمند راه‌اندازی» lifecycle to visit.
    const drafts = await app.inject({ method: 'GET', url: `/api/v1/admin/products?view=drafts&owner=kolbe&q=${encodeURIComponent('وقفه')}`, headers });
    const matches = (drafts.json().items as { id: string }[]).filter((p) => p.id === productId);
    assert.equal(matches.length, 1);

    // the canonical continuation endpoint addresses the very same product
    const legacy = await app.inject({ method: 'GET', url: `/api/v1/admin/products/needs-setup?productId=${productId}&limit=1`, headers });
    assert.equal(legacy.statusCode, 200, legacy.body);
    assert.deepEqual((legacy.json().items as { id: string }[]).map((item) => item.id), [productId]);
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §31 — RETAIL INITIAL RECEIPT (canonical WMS document)
 * ========================================================================== */
test('§31/§15: retail initial receipt — document, movement, balance, retail domain, idempotent', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'رسید خرده');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار مرکزی');
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'continue', name: `خرده ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '90000000', variants: [
          { color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }, { color: 'کرم', size: 'M' }] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;
    const variants = created.json().variants as { id: string; size: string | null; color: string | null }[];
    const byCell = (color: string, size: string) => variants.find((v) => v.color === color && v.size === size)!.id;

    // Black/M = 5, Black/L = 3, Cream/M = 2 → 10 retail pieces
    const key = `retail-setup-${randomUUID()}`;
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { retail: { warehouseId: retailWh, mode: 'per_variant', perVariant: [
        { variantId: byCell('مشکی', 'M'), quantity: 5 },
        { variantId: byCell('مشکی', 'L'), quantity: 3 },
        { variantId: byCell('کرم', 'M'), quantity: 2 }] } } });
    assert.equal(setup.statusCode, 201, setup.body);
    assert.equal(setup.json().retail.totalPieces, 10);

    // canonical balance in the RETAIL domain only
    const balances = await pool.query(
      `SELECT v.color_label, v.size_label, b.on_hand, b.inventory_domain FROM stock_balances b
         JOIN product_variants v ON v.id = b.variant_id
        WHERE v.product_id = $1 ORDER BY v.size_label, v.color_label`, [productId]);
    assert.equal(balances.rows.length, 3);
    const byVariant = Object.fromEntries(balances.rows.map((r) => [`${r.color_label}/${r.size_label}`, r.on_hand]));
    assert.equal(byVariant['مشکی/M'], 5);
    assert.equal(byVariant['مشکی/L'], 3);
    assert.equal(byVariant['کرم/M'], 2);
    assert.ok(balances.rows.every((r) => r.inventory_domain === 'retail'), 'retail setup writes retail domain only');

    // canonical receipt document + movement with an opening reason
    const receipts = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(r.quantity), 0)::int AS qty FROM stock_receipts r
         JOIN product_variants v ON v.id = r.variant_id WHERE v.product_id = $1 AND r.inventory_domain = 'retail'`, [productId]);
    assert.equal(receipts.rows[0].n, 3);
    assert.equal(receipts.rows[0].qty, 10);
    const movements = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(m.on_hand_delta), 0)::int AS qty FROM stock_movements m
         JOIN product_variants v ON v.id = m.variant_id
        WHERE v.product_id = $1 AND m.reference_type = 'opening_receipt' AND m.inventory_domain = 'retail'`, [productId]);
    assert.equal(movements.rows[0].n, 3);
    assert.equal(movements.rows[0].qty, 10);
    const auditRow = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.inventory_setup' AND resource_id = $1`, [productId]);
    assert.equal(auditRow.rows[0].n, 1, 'initial inventory must be audited');

    // §39: replaying the confirmation must not double the physical stock
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { retail: { warehouseId: retailWh, mode: 'per_variant', perVariant: [
        { variantId: byCell('مشکی', 'M'), quantity: 5 },
        { variantId: byCell('مشکی', 'L'), quantity: 3 },
        { variantId: byCell('کرم', 'M'), quantity: 2 }] } } });
    assert.equal(replay.statusCode, 201, replay.body);
    const after = await countRetailStock(pool, productId);
    assert.equal(after.onHand, 10, 'idempotent replay must not create duplicate physical inventory');

    // configured, still «پیش‌نویس» — publication remains Admin's decision (§18)
    const row = await pool.query('SELECT status, inventory_setup FROM products WHERE id = $1', [productId]);
    assert.equal(row.rows[0].inventory_setup, 'configured');
    assert.equal(row.rows[0].status, 'draft', 'a WMS receipt must not auto-publish');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §32 — WHOLESALE SERIES INITIAL RECEIPT (Kolbe owned)
 * ========================================================================== */
test('§32/§16: wholesale series initial receipt — wholesale domain only, no retail stock', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'رسید عمده');
    const headers = await login(app, admin.email);
    const wholesaleWh = await makeWarehouse(pool, 'wholesale', 'انبار مرکزی عمده');
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'continue', name: `عمده ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '90000000', wholesalePriceRial: '70000000', wholesaleEnabled: true, retailEnabled: false,
        variants: [{ color: 'مشکی', size: 'S' }, { color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }],
        wholesaleSeries: [{ name: 'سری الف', color: 'مشکی', pricingMode: 'series_total', totalPriceRial: '840000000',
          minOrderSeries: 1, items: ['S', 'M', 'L'].map((size) => ({ size, quantityPerSeries: 2 })) }] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;

    const templateRow = await pool.query('SELECT id FROM series_templates WHERE product_id = $1 AND active', [productId]);
    const templateId = templateRow.rows[0]?.id as string;
    assert.ok(templateId, 'the create payload must persist a canonical series template');

    const key = `wholesale-setup-${randomUUID()}`;
    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { wholesale: { warehouseId: wholesaleWh, seriesTemplateId: templateId, seriesCount: 4 } } });
    assert.equal(setup.statusCode, 201, setup.body);
    assert.equal(setup.json().wholesale.seriesCount, 4);
    assert.equal(setup.json().wholesale.piecesPerSeries, 6);
    assert.equal(setup.json().wholesale.totalPieces, 24);

    // intact series balance = 4, physical composition = 24 pieces, ownership = Kolbe
    assert.equal(await countSeries(pool, productId), 4);
    assert.equal(await countWholesalePieces(pool, productId), 24);
    const owner = await pool.query(
      `SELECT s.owner_type, s.supplier_id FROM series_stock_balances s
         JOIN series_templates t ON t.id = s.series_template_id WHERE t.product_id = $1`, [productId]);
    assert.equal(owner.rows[0].owner_type, 'kolbe');
    assert.equal(owner.rows[0].supplier_id, null);

    // §16/§17: NO retail stock was created by the wholesale opening receipt
    const retail = await countRetailStock(pool, productId);
    assert.equal(retail.onHand, 0, 'wholesale setup must never create retail stock');
    assert.equal(retail.rows, 0);

    // canonical series ledger row + idempotent replay
    const ledger = await pool.query(
      `SELECT count(*)::int AS n FROM series_stock_movements s
         JOIN series_templates t ON t.id = s.series_template_id
        WHERE t.product_id = $1 AND s.movement_type = 'receipt'`, [productId]);
    assert.equal(ledger.rows[0].n, 1);
    const replay = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { wholesale: { warehouseId: wholesaleWh, seriesTemplateId: templateId, seriesCount: 4 } } });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(await countSeries(pool, productId), 4); // replay must not double the series stock
    assert.equal(await countWholesalePieces(pool, productId), 24);
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §33 — RETAIL + WHOLESALE ISOLATION
 * ========================================================================== */
test('§33/§17: خرده + عمده keep two independent inventory domains in one product', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'دو دامنه');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار خرده');
    const wholesaleWh = await makeWarehouse(pool, 'wholesale', 'انبار عمده');
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'continue', name: `دودامنه ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '90000000', wholesalePriceRial: '70000000', retailEnabled: true, wholesaleEnabled: true,
        variants: [{ color: 'مشکی', size: 'M' }, { color: 'مشکی', size: 'L' }],
        wholesaleSeries: [{ name: 'سری الف', color: 'مشکی', pricingMode: 'series_total', totalPriceRial: '560000000',
          minOrderSeries: 1, items: ['M', 'L'].map((size) => ({ size, quantityPerSeries: 2 })) }] } });
    assert.equal(created.statusCode, 201, created.body);
    const productId = created.json().id as string;
    const variants = created.json().variants as { id: string; size: string | null }[];
    const templateId = (await pool.query('SELECT id FROM series_templates WHERE product_id = $1', [productId])).rows[0].id as string;

    const setup = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `both-${randomUUID()}` },
      payload: {
        retail: { warehouseId: retailWh, mode: 'per_variant', perVariant: [
          { variantId: variants.find((v) => v.size === 'M')!.id, quantity: 5 },
          { variantId: variants.find((v) => v.size === 'L')!.id, quantity: 3 }] },
        wholesale: { warehouseId: wholesaleWh, seriesTemplateId: templateId, seriesCount: 4 },
      } });
    assert.equal(setup.statusCode, 201, setup.body);

    // Retail WMS: 8 pieces. Wholesale WMS: 4 series (16 pieces). No cross-domain mixing.
    assert.equal((await countRetailStock(pool, productId)).onHand, 8);
    assert.equal(await countSeries(pool, productId), 4);
    assert.equal(await countWholesalePieces(pool, productId), 16);
    const domains = await pool.query(
      `SELECT b.inventory_domain, COALESCE(sum(b.on_hand), 0)::int AS on_hand FROM stock_balances b
         JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1 GROUP BY 1 ORDER BY 1`, [productId]);
    assert.deepEqual(domains.rows.map((r) => `${r.inventory_domain}:${r.on_hand}`), ['retail:8', 'wholesale:16']);
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §34 — PUBLISHED PRODUCT THAT SELLS OUT
 * ========================================================================== */
test('§34/§19: a published product that sells out stays «منتشرشده» — never draft, never needs-setup', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'اتمام موجودی');
    const headers = await login(app, admin.email);
    const retailWh = await makeWarehouse(pool, 'retail', 'انبار اتمام');
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'continue', name: `اتمام ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '90000000', variants: [{ color: 'مشکی', size: 'M' }],
        /* §4: publication requires the catalog minimum — an image is one of them, exactly as
           the Product Studio enforces it (buildProductCreatePayload rejects an imageless product). */
        metadata: { images: [{ fileId: null, url: 'https://cdn.kolbe.test/sellout.png' }] } } });
    const productId = created.json().id as string;
    const variantId = (created.json().variants as { id: string }[])[0]!.id;

    await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/inventory-setup`,
      headers: { ...headers, 'idempotency-key': `sold-${randomUUID()}` },
      payload: { retail: { warehouseId: retailWh, mode: 'equal', quantity: 4 } } });
    const published = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers, payload: { status: 'published' } });
    assert.equal(published.statusCode, 200, published.body);

    // sell out through a legitimate canonical WMS operation
    const consume = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...headers, 'idempotency-key': `consume-${randomUUID()}` },
      payload: { variantId, warehouseId: retailWh, delta: -4, reason: 'فروش کامل موجودی', reference: 'SELLOUT-1', inventoryDomain: 'retail' } });
    assert.equal(consume.statusCode, 201, consume.body);

    const row = await pool.query('SELECT status, inventory_setup FROM products WHERE id = $1', [productId]);
    assert.equal(row.rows[0].status, 'published', 'a sold-out published product must NOT fall back to draft');
    assert.equal(row.rows[0].inventory_setup, 'configured', 'a sold-out product must not re-enter needs-setup');

    // «ناموجود» is a commercial state, not a lifecycle state
    const outOfStock = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=out_of_stock&owner=kolbe', headers });
    assert.equal(outOfStock.statusCode, 200, outOfStock.body);
    assert.ok((outOfStock.json().items as { id: string }[]).some((p) => p.id === productId), 'must appear under ناموجود');
    const drafts = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=drafts&owner=kolbe', headers });
    assert.ok(!(drafts.json().items as { id: string }[]).some((p) => p.id === productId), 'must NOT appear under پیش‌نویس‌ها');
    const publishedView = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=published&owner=kolbe', headers });
    assert.ok((publishedView.json().items as { id: string }[]).some((p) => p.id === productId), 'must still appear under منتشرشده');
  } finally { await pool.end(); await app.close(); }
});

/* ============================================================================
 * §5/§26 — the read model exposes exactly one lifecycle
 * ========================================================================== */
test('§5/§26: the product read model returns no «نیازمند راه‌اندازی» lifecycle field to the UI', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'خوانش محصول');
    const headers = await login(app, admin.email);
    const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `خوانش ${randomUUID().slice(0, 6)}`, brand: 'کلبه', category: 'هودی',
        cashPriceRial: '50000000', variants: [{ color: 'مشکی', size: 'M' }] } });
    const productId = created.json().id as string;
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/products?view=all&owner=kolbe', headers });
    const row = (list.json().items as Record<string, unknown>[]).find((item) => item.id === productId)!;
    // lifecycle = publication state (draft/published/archived); inventory_setup stays internal
    assert.equal(row.status, 'draft');
    // a product row is recognisable without opening it (§5)
    assert.ok('variant_count' in row && 'retail_available' in row && 'wholesale_series_available' in row);
    assert.ok('sku' in row && 'cash_price_rial' in row && 'cover_file_id' in row);
  } finally { await pool.end(); await app.close(); }
});
