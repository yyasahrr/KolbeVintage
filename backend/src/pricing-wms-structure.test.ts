/** PROMPT 1 — FINAL BROWSER UAT DELTA (§6-§15, §23-§27): WMS operability + structure lifecycle.
 *
 *  This suite pins the SERVER-side facts the browser UAT depends on:
 *    - §8/§9  inventory default order is NEWEST (never the accidental DB row order) and every
 *             ordering option is a server parameter, deterministic and reversible;
 *    - §10    real filters (category / warehouse / availability / publication / ownership)
 *             combine with ordering — no full-inventory client sort anywhere;
 *    - §6/§25 catalogue publication and physical stock are INDEPENDENT: a persisted Draft with
 *             stock stays «پیشنویس», an explicit publish changes only the publication state and
 *             leaves every quantity untouched (and never auto-publishes from WMS);
 *    - §13/§14 structural dictionaries (gender/season taxonomies, product types + sizes) support
 *             real edit / activate-deactivate / delete, keep their canonical code immutable, and
 *             refuse to destroy referenced values with an actionable Persian reason.
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
  NODE_ENV: 'test', PORT: 4041, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
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
    [id, `w-${id.slice(0, 8)}`, label, purpose]);
  return id;
}

type Created = { id: string; variants: { id: string; size_label: string | null }[] };

/** A Draft product (saveIntent:'continue') with real variants — the canonical Studio create path. */
async function createDraft(app: App, headers: Headers, name: string, category: string, sizes: string[], extra: Record<string, unknown> = {}): Promise<Created> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
    payload: {
      saveIntent: 'continue', name, brand: 'کلبه', category, description: 'توضیح آزمون',
      cashPriceRial: '12000000', retailEnabled: true, wholesaleEnabled: false,
      variants: sizes.map((size) => ({ color: 'مشکی', size })), ...extra,
    } });
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().id as string, variants: res.json().variants as Created['variants'] };
}

/** Physical stock is WRITTEN BY WMS only: create a receipt and confirm it (never by Studio). */
async function receiveStock(app: App, headers: Headers, warehouseId: string, variantId: string, quantity: number) {
  const receipt = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
    headers: { ...headers, 'idempotency-key': `pw-${randomUUID()}` },
    payload: { warehouseId, variantId, quantity, inventoryDomain: 'retail' } });
  assert.equal(receipt.statusCode, 201, receipt.body);
  const received = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receipt.json().id}/receive`,
    headers, payload: { receivedQuantity: quantity } });
  assert.equal(received.statusCode, 200, received.body);
}

type BalanceRow = {
  variant_id: string; product_id: string; product_name: string; product_status: string;
  category: string | null; owner_type: string; on_hand: number; reserved: number; available: number; sku: string;
};

async function balances(app: App, headers: Headers, query: string, ids?: string[]): Promise<BalanceRow[]> {
  const res = await app.inject({ method: 'GET', url: `/api/v1/inventory?inventoryDomain=retail&limit=100${query}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items as BalanceRow[];
  return ids ? items.filter((row) => ids.includes(row.product_id)) : items;
}

test('§8/§9: WMS default order is NEWEST and every sorting option is deterministic and server-side', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'ترتیب انبار');
    const headers = await login(app, admin.email);
    const warehouse = await makeWarehouse(pool, 'retail', 'انبار ترتیب');
    const suffix = randomUUID().slice(0, 6);
    const older = await createDraft(app, headers, `آلفا ${suffix}`, 'پیراهن', ['S', 'M']);
    const newer = await createDraft(app, headers, `بتا ${suffix}`, 'کت', ['S', 'M']);
    await receiveStock(app, headers, warehouse, older.variants[0]!.id, 30); // highest stock
    await receiveStock(app, headers, warehouse, newer.variants[0]!.id, 4);  // lowest stock
    const ids = [older.id, newer.id];

    const order = async (query: string) => (await balances(app, headers, query, ids)).map((row) => row.product_id);
    const defaultOrder = await order('');
    assert.deepEqual(defaultOrder, await order('&sort=newest'), 'the default order IS newest (never the DB row order)');
    assert.deepEqual(defaultOrder, [newer.id, older.id], 'newest product comes first');
    assert.deepEqual(await order('&sort=oldest'), [older.id, newer.id], 'oldest product comes first');

    const stockDesc = await order('&sort=stock_desc');
    const stockAsc = await order('&sort=stock_asc');
    assert.deepEqual(stockDesc, [...stockAsc].reverse(), 'stock ordering is deterministic and reversible');
    assert.equal(stockDesc[0], older.id, 'highest stock first');
    assert.equal(stockAsc[0], newer.id, 'lowest stock first');

    const availableDesc = await order('&sort=available_desc');
    const availableAsc = await order('&sort=available_asc');
    assert.deepEqual(availableDesc, [...availableAsc].reverse(), 'available (قابل تخصیص) ordering is deterministic and reversible');
    assert.equal(availableDesc[0], older.id);

    // Name ordering is a server ORDER BY; assert it is a mirrored pair rather than assuming a collation.
    const nameAsc = await order('&sort=name_asc');
    const nameDesc = await order('&sort=name_desc');
    assert.deepEqual(nameAsc, [...nameDesc].reverse(), 'name ordering is deterministic and reversible');
    assert.equal(nameAsc.length, 2);
  } finally { await pool.end(); await app.close(); }
});

test('§10: real filters (category / availability / publication / warehouse / ownership) combine with sort', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'فیلتر انبار');
    const headers = await login(app, admin.email);
    const warehouseA = await makeWarehouse(pool, 'retail', 'انبار الف');
    const warehouseB = await makeWarehouse(pool, 'retail', 'انبار ب');
    const wholesale = await makeWarehouse(pool, 'wholesale', 'انبار عمده');
    const suffix = randomUUID().slice(0, 6);
    const shirt = await createDraft(app, headers, `پیراهن فیلتر ${suffix}`, 'پیراهن', ['S', 'M']);
    const coat = await createDraft(app, headers, `کت فیلتر ${suffix}`, 'کت', ['S', 'M']);
    await receiveStock(app, headers, warehouseA, shirt.variants[0]!.id, 12);
    await receiveStock(app, headers, warehouseB, shirt.variants[1]!.id, 0 + 1); // low stock, other warehouse
    const coatReceipt = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
      headers: { ...headers, 'idempotency-key': `pw-c-${randomUUID()}` },
      payload: { warehouseId: wholesale, variantId: coat.variants[0]!.id, quantity: 7, inventoryDomain: 'wholesale' } });
    assert.equal(coatReceipt.statusCode, 201, coatReceipt.body);
    await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${coatReceipt.json().id}/receive`, headers, payload: { receivedQuantity: 7 } });

    // Category is the canonical catalogue category (never a client-side copy).
    const shirts = await balances(app, headers, `&category=${encodeURIComponent('پیراهن')}&sort=newest`);
    assert.ok(shirts.length > 0);
    assert.ok(shirts.every((row) => row.category === 'پیراهن'), 'category filter returns only that category');
    assert.ok(shirts.some((row) => row.product_id === shirt.id));
    assert.ok(!shirts.some((row) => row.product_id === coat.id));

    // Warehouse + availability intersection on top of the category filter.
    const combined = await balances(app, headers, `&category=${encodeURIComponent('پیراهن')}&warehouseId=${warehouseA}&stockStatus=in_stock&sort=newest`);
    assert.deepEqual([...new Set(combined.map((row) => row.product_id))], [shirt.id]);
    assert.ok(combined.every((row) => row.available > 5), 'availability filter keeps only in-stock lines');
    const lowOnly = (await balances(app, headers, `&category=${encodeURIComponent('پیراهن')}&stockStatus=low_stock&sort=newest`))
      .filter((row) => row.product_id === shirt.id);
    assert.deepEqual([...new Set(lowOnly.map((row) => row.variant_id))], [shirt.variants[1]!.id], 'low-stock filter is a real server filter');
    assert.ok(lowOnly.every((row) => row.available <= 5));
    const otherWarehouse = (await balances(app, headers, `&category=${encodeURIComponent('پیراهن')}&warehouseId=${warehouseB}&sort=newest`))
      .filter((row) => row.product_id === shirt.id);
    assert.deepEqual([...new Set(otherWarehouse.map((row) => row.variant_id))], [shirt.variants[1]!.id]);

    // Publication filter: both products are persisted Drafts at this point.
    const drafts = await balances(app, headers, `&publicationStatus=draft&sort=newest`);
    assert.ok(drafts.some((row) => row.product_id === shirt.id));
    assert.ok(!drafts.some((row) => row.product_status === 'published'));

    // Ownership filter lives in the wholesale domain (kolbe vs supplier).
    const wholesaleKolbe = await app.inject({ method: 'GET', url: `/api/v1/inventory?inventoryDomain=wholesale&owner=kolbe&limit=100`, headers });
    assert.equal(wholesaleKolbe.statusCode, 200, wholesaleKolbe.body);
    const wholesaleRows = wholesaleKolbe.json().items as BalanceRow[];
    assert.ok(wholesaleRows.some((row) => row.product_id === coat.id), 'wholesale kolbe stock is reachable');
    assert.ok(wholesaleRows.every((row) => row.owner_type === 'kolbe'));
  } finally { await pool.end(); await app.close(); }
});

test('§6/§7/§25: inventory facts are independent of catalogue publication (draft stays draft, publish keeps quantities)', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'استقلال انتشار');
    const headers = await login(app, admin.email);
    const warehouse = await makeWarehouse(pool, 'retail', 'انبار استقلال');
    const suffix = randomUUID().slice(0, 6);
    const product = await createDraft(app, headers, `استقلال ${suffix}`, 'کت', ['S', 'M']);
    await receiveStock(app, headers, warehouse, product.variants[0]!.id, 9);

    const asDraft = (await balances(app, headers, `&productId=${product.id}`, [product.id]))[0]!;
    assert.equal(asDraft.product_status, 'draft', 'a persisted Draft with stock is still a Draft');
    assert.equal(asDraft.on_hand, 9, 'receiving stock never publishes and never changes the quantity');
    const draftFilter = await balances(app, headers, `&publicationStatus=draft`, [product.id]);
    assert.equal(draftFilter.length, 1);
    assert.equal((await balances(app, headers, `&publicationStatus=published`, [product.id])).length, 0);

    // Explicit publication is the ONLY thing that changes the catalogue state (§7).
    const published = await app.inject({ method: 'PATCH', url: `/api/v1/products/${product.id}/status`, headers, payload: { status: 'published' } });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().status, 'published');
    const asPublished = (await balances(app, headers, `&productId=${product.id}`, [product.id]))[0]!;
    assert.equal(asPublished.product_status, 'published', 'explicit publish is visible in WMS after the change');
    assert.equal(asPublished.on_hand, 9, 'publication does not touch physical stock');
    assert.equal(asPublished.available, 9, 'publication does not touch available (قابل تخصیص) stock');
    assert.equal((await balances(app, headers, `&publicationStatus=published`, [product.id])).length, 1, 'the Published filter sees it');
    assert.equal((await balances(app, headers, `&publicationStatus=draft`, [product.id])).length, 0, 'it is no longer in the Draft filter');
    const adminList = await app.inject({ method: 'GET', url: `/api/v1/admin/products?view=published&limit=50`, headers });
    assert.equal(adminList.statusCode, 200, adminList.body);
    assert.ok((adminList.json().items as { id: string }[]).some((item) => item.id === product.id), 'published catalogue listing shows the product');
  } finally { await pool.end(); await app.close(); }
});

test('§12-§14: gender/season dictionaries support edit, activate/deactivate and SAFE delete', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'ساختار رده‌بندی');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);
    const code = `tmp-${suffix}`;

    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/taxonomies', headers,
      payload: { kind: 'gender', code, label: 'آزمونی', position: 50 } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id as string;

    // Real edit: label + position, and the code is IMMUTABLE (referenced by existing products).
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/admin/taxonomies/${id}`, headers,
      payload: { label: 'آزمونی ویرایش‌شده', position: 3 } });
    assert.equal(edited.statusCode, 200, edited.body);
    const codeChange = await app.inject({ method: 'PATCH', url: `/api/v1/admin/taxonomies/${id}`, headers, payload: { code: 'renamed' } });
    assert.equal(codeChange.statusCode, 400, 'the canonical code stays immutable');

    // Search + active filter + count are server-backed (§15).
    const filtered = await app.inject({ method: 'GET', url: `/api/v1/admin/taxonomies?q=${encodeURIComponent('ویرایش‌شده')}&active=1`, headers });
    assert.equal(filtered.statusCode, 200, filtered.body);
    assert.ok((filtered.json().items as { id: string }[]).some((item) => item.id === id));
    assert.equal(typeof filtered.json().total, 'number');

    // Enable/disable is always available and never touches history.
    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/admin/taxonomies/${id}`, headers, payload: { active: false } });
    assert.equal(disabled.statusCode, 200, disabled.body);

    // Unreferenced → hard delete is allowed (domain-safe).
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/admin/taxonomies/${id}`, headers });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().deleted, true);
    const gone = await app.inject({ method: 'GET', url: `/api/v1/admin/taxonomies?q=${encodeURIComponent(code)}`, headers });
    assert.equal((gone.json().items as unknown[]).length, 0, 'unreferenced value is really gone');

    // Referenced → delete is refused with an actionable Persian reason; deactivation keeps history.
    const usedCode = `used-${suffix}`;
    const used = await app.inject({ method: 'POST', url: '/api/v1/admin/taxonomies', headers,
      payload: { kind: 'season', code: usedCode, label: 'فصل آزمون', position: 0 } });
    assert.equal(used.statusCode, 201, used.body);
    const usedId = used.json().id as string;
    const product = await createDraft(app, headers, `محصول ساختار ${suffix}`, 'پیراهن', ['S'], { seasons: [usedCode] });
    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/admin/taxonomies/${usedId}`, headers });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().message as string, /غیرفعال/);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/taxonomies/${usedId}`, headers, payload: { active: false } })).statusCode, 200);
    const stillReadable = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers });
    assert.equal(stillReadable.statusCode, 200, stillReadable.body);
    assert.deepEqual(stillReadable.json().seasons, [usedCode], 'historical product still references the inactive value');
  } finally { await pool.end(); await app.close(); }
});

test('§12-§14: product types and their sizes have a real lifecycle with safe delete', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin', 'operations'], 'ساختار سایز');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);
    const type = await app.inject({ method: 'POST', url: '/api/v1/admin/product-types', headers,
      payload: { code: `tmp-type-${suffix}`, name: 'نوع آزمون', description: '', active: true, position: 90 } });
    assert.equal(type.statusCode, 201, type.body);
    const typeId = type.json().id as string;

    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/admin/product-types/${typeId}`, headers, payload: { name: 'نوع آزمون ویرایش‌شده' } });
    assert.equal(edit.statusCode, 200, edit.body);

    const size = await app.inject({ method: 'POST', url: `/api/v1/admin/product-types/${typeId}/sizes`, headers,
      payload: { code: 'T1', label: 'آزمون یک', active: true, position: 0 } });
    assert.equal(size.statusCode, 201, size.body);
    const sizeId = size.json().id as string;
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/product-types/${typeId}/sizes/${sizeId}`, headers, payload: { label: 'آزمون ویرایش', active: false } })).statusCode, 200);
    // Unreferenced → hard delete allowed.
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/admin/product-types/${typeId}/sizes/${sizeId}`, headers })).statusCode, 200);

    // Referenced → refused with a Persian reason (history must stay readable).
    const usedSize = await app.inject({ method: 'POST', url: `/api/v1/admin/product-types/${typeId}/sizes`, headers,
      payload: { code: 'T2', label: 'آزمون دو', active: true, position: 1 } });
    assert.equal(usedSize.statusCode, 201, usedSize.body);
    const usedSizeId = usedSize.json().id as string;
    const product = await createDraft(app, headers, `محصول سایز ${suffix}`, 'پیراهن', ['T2'], { productTypeId: typeId });
    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/admin/product-types/${typeId}/sizes/${usedSizeId}`, headers });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(refused.json().message as string, /غیرفعال/);
    // The type itself is referenced too → refused, while deactivation stays available.
    const typeRefused = await app.inject({ method: 'DELETE', url: `/api/v1/admin/product-types/${typeId}`, headers });
    assert.equal(typeRefused.statusCode, 409, typeRefused.body);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/admin/product-types/${typeId}`, headers, payload: { active: false } })).statusCode, 200);
    const readable = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${product.id}`, headers });
    assert.equal(readable.statusCode, 200, readable.body);
  } finally { await pool.end(); await app.close(); }
});
