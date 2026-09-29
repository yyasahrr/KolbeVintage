/* Browser-smoke fixtures (local stack only; run after `seed:local`).
   Creates the two catalogue items the experience smoke drives (Style Builder pair + lazy card images)
   entirely through the real admin APIs: product → uploaded image → product media → publish → WMS receipt.
   Idempotent: existing products (matched by name) are reused. Never runs against a non-local API.

   Usage (cwd backend):  node scripts/browser-smoke-fixtures.mjs   [KV_WEB=http://127.0.0.1:5173] */
import sharp from 'sharp';

const BASE = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw new Error(`fixtures only run against a local stack (got ${BASE})`);

const FIXTURES = [
  { name: 'پیراهن آکسفورد صورتی', category: 'پیراهن', color: 'صورتی', rgb: '#E8A5B5', sizes: ['M', 'L'], cash: '21000000', seasons: ['spring', 'autumn'] },
  { name: 'شلوار پارچه‌ای کرم', category: 'شلوار', color: 'کرم', rgb: '#E9DCC3', sizes: ['32', '34'], cash: '26000000', seasons: ['spring', 'autumn'] },
];

async function api(method, path, { token, body, key, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['idempotency-key'] = key;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const expect = (res, codes, what) => { if (!codes.includes(res.status)) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`); return res.body; };

const login = expect(await api('POST', '/api/v1/auth/login', { body: { identity: 'admin@kolbe.ir', password: 'ChangeMe-Admin-123456' } }), [200], 'admin login');
const token = login.accessToken;
const warehouses = expect(await api('GET', '/api/v1/warehouses', { token }), [200], 'warehouses');
const warehouse = (warehouses.items ?? warehouses)[0];
if (!warehouse) throw new Error('no warehouse — run seed:local first');
const existing = expect(await api('GET', '/api/v1/products?limit=100', { token }), [200], 'products');

for (const f of FIXTURES) {
  let product = (existing.items ?? []).find((p) => p.name === f.name);
  if (!product) {
    product = expect(await api('POST', '/api/v1/products', { token, body: {
      brand: 'Kolbe', name: f.name, category: f.category, description: 'محصول آزمون مرورگر (browser-smoke-fixtures)', cashPriceRial: f.cash,
      variants: f.sizes.map((size) => ({ color: f.color, size, attributes: {} })), vibes: ['old-money'], seasons: f.seasons,
      metadata: { images: [], channels: { retail: true, wholesale: false }, source: 'browser-smoke-fixtures' },
    } }), [201], `create ${f.name}`);
    const jpeg = await sharp({ create: { width: 800, height: 1000, channels: 3, background: f.rgb } }).jpeg({ quality: 80 }).toBuffer();
    const form = new FormData();
    form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'fixture.jpg');
    const file = expect(await api('POST', '/api/v1/files', { token, form }), [201], `upload ${f.name}`);
    for (const role of ['hero', 'flat_lay']) {
      expect(await api('POST', `/api/v1/admin/products/${product.id}/media`, { token, body: { fileId: file.id, role, altText: f.name } }), [200, 201], `media ${role} ${f.name}`);
    }
    console.log(`created ${f.name}`);
  }
  expect(await api('PATCH', `/api/v1/products/${product.id}/status`, { token, body: { status: 'published' } }), [200], `publish ${f.name}`);
  const listed = expect(await api('GET', '/api/v1/products?limit=100', { token }), [200], `read ${f.name}`);
  const variants = (listed.items ?? []).find((p) => p.id === product.id)?.variants ?? [];
  if (!variants.length) throw new Error(`no variants for ${f.name}`);
  for (const variant of variants) {
    const receipt = await api('POST', '/api/v1/inventory/receipts', { token, key: `smoke-fixture-${variant.sku}`,
      body: { warehouseId: warehouse.id, variantId: variant.id, quantity: 6, reference: `SMOKE-${variant.sku}` } });
    if (receipt.status !== 201) continue; // idempotent replay or already received
    await api('POST', `/api/v1/inventory/receipts/${receipt.body.id}/receive`, { token });
  }
}
console.log('browser smoke fixtures ready');
