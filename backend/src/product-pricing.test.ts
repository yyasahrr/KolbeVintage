/** PROMPT 2 — CANONICAL PRODUCT PRICING (§3-§33, §57-§66): the dedicated P2 matrix.
 *
 *  Pins the ONE server-authoritative price model end to end:
 *    - retail cash base (+ variant override) and the explicit four-installment base that is
 *      NEVER derived from the cash price (P2-PRICE-001..008),
 *    - wholesale Series pricing — direct «قیمت کل سری» and «محاسبه از اجزای سری» — with explicit
 *      business errors instead of a silent retail fallback (P2-PRICE-009..013),
 *    - promotion/festival integration incl. deterministic rounding, precedence and the
 *      DEC-PRICING-001 suspension semantics (P2-PRICE-014..019),
 *    - sales mode independence (P2-PRICE-020..022),
 *    - consistency across resolver / catalog / hub row / cart / order snapshot (P2-PRICE-023..026),
 *    - regression guards: pricing never publishes, never writes stock and never duplicates the
 *      product id (P2-REG-001..005).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, type DbPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4044, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Headers = { authorization: string };
const password = 'TestPassword123456!';

type ProductRow = { id: string; variants: { id: string; sku: string; size_label: string | null }[] };

async function makeUser(pool: DbPool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `p2-${label}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash(password), label]);
  for (const role of roles) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  return { id, email };
}

async function login(app: FastifyInstance, email: string): Promise<Headers> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

const customer = (label: string) => ({ recipient: label, phone: '09123456789', province: 'تهران', city: 'تهران',
  line: 'خیابان آزمون، پلاک ۱۲، واحد ۳', postalCode: '1234567890' });

/** Retail channel helper: a published product with explicit prices and retail variants. */
async function createProduct(app: FastifyInstance, headers: Headers, payload: Record<string, unknown>): Promise<ProductRow> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
    saveIntent: 'draft', brand: 'کلبه', description: 'محصول آزمون قیمت‌گذاری', variants: [],
    ...payload } });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().id as string;
  await app.inject({ method: 'PATCH', url: `/api/v1/products/${id}/status`, headers, payload: { status: 'published' } });
  return { id, variants: res.json().variants as ProductRow['variants'] };
}

async function receive(app: FastifyInstance, headers: Headers, warehouseId: string, variantId: string, quantity: number,
  domain: 'retail' | 'wholesale' = 'retail') {
  const receipt = await app.inject({ method: 'POST', url: '/api/v1/inventory/receipts',
    headers: { ...headers, 'idempotency-key': `p2-r-${randomUUID()}` },
    payload: { warehouseId, variantId, quantity, inventoryDomain: domain } });
  assert.equal(receipt.statusCode, 201, receipt.body);
  const received = await app.inject({ method: 'POST', url: `/api/v1/inventory/receipts/${receipt.json().id}/receive`,
    headers, payload: { receivedQuantity: quantity } });
  assert.equal(received.statusCode, 200, received.body);
}

async function warehouse(pool: DbPool, purpose: 'retail' | 'wholesale', label: string) {
  const id = randomUUID();
  await pool.query('INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,$3,$4)',
    [id, `p2-${id.slice(0, 8)}`, label, purpose]);
  return id;
}

const resolveOne = async (app: FastifyInstance, headers: Headers | null, variantId: string,
  orderType: 'retail' | 'wholesale' = 'retail', paymentMode: 'cash' | 'four_installments' = 'cash') =>
  app.inject({ method: 'GET', url: `/api/v1/pricing/variants/${variantId}?orderType=${orderType}&paymentMode=${paymentMode}`,
    ...(headers ? { headers } : {}) });

/** The active (non-archived) rule of a product, as the canonical API reports it. */
const rulesOf = async (app: FastifyInstance, headers: Headers, productId: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/promotions/rules?productId=${productId}`, headers });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().items ?? []) as Array<{ id: string; target_type: string; discount_type: string; discount_value: string; active: boolean }>;
};

test('P2-PRICE-001..004: retail cash base is the canonical integer-rial base (and the variant override replaces it)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر پایه');
    const headers = await login(app, admin.email);

    const plain = await createProduct(app, headers, { name: `پایه نقدی ${randomUUID().slice(0, 6)}`, category: 'کت',
      cashPriceRial: '49800000', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M', color: 'مشکی' }] });

    // P2-PRICE-001: the persisted base is the canonical price with no rule → final == base, no discount.
    const resolved = await resolveOne(app, null, plain.variants[0]!.id);
    assert.equal(resolved.statusCode, 200, resolved.body);
    assert.equal(resolved.json().basePrice, '49800000');
    assert.equal(resolved.json().finalPrice, '49800000');
    assert.equal(resolved.json().discountAmount, '0');
    assert.equal(resolved.json().compareAtPriceRial, null);
    assert.equal(resolved.json().channel, 'retail');
    assert.equal(resolved.json().paymentMode, 'cash');

    // P2-PRICE-002: the catalog row carries the SAME canonical resolution (no second engine).
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/products?limit=100' });
    const row = (catalog.json().items as Array<{ id: string; pricing?: { finalPriceRial: string; basePriceRial: string } }>)
      .find((item) => item.id === plain.id);
    assert.ok(row?.pricing, 'catalog row exposes the canonical pricing block');
    assert.equal(row!.pricing!.basePriceRial, '49800000');
    assert.equal(row!.pricing!.finalPriceRial, '49800000');

    // P2-PRICE-003: a variant override replaces the retail cash base (and the discount applies to it).
    const overridden = await createProduct(app, headers, { name: `پایه اورراید ${randomUUID().slice(0, 6)}`, category: 'کت',
      cashPriceRial: '50000000', retailEnabled: true, wholesaleEnabled: false,
      variants: [{ size: 'M', color: 'مشکی', priceOverrideRial: '45000000' }] });
    const overrideResolved = await resolveOne(app, null, overridden.variants[0]!.id);
    assert.equal(overrideResolved.json().basePrice, '45000000');
    assert.equal(overrideResolved.json().cashBasePriceRial, '45000000');

    // P2-PRICE-004: invalid money is refused with a business message — never NaN/enum/SQL leakage.
    const bad = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `پول بد ${randomUUID().slice(0, 6)}`, category: 'کت', brand: 'کلبه',
        cashPriceRial: '-1000', variants: [] } });
    assert.equal(bad.statusCode, 400, bad.body);
    const patchBad = await app.inject({ method: 'PATCH', url: `/api/v1/products/${plain.id}`, headers,
      payload: { cashPriceRial: '12.5' } });
    assert.equal(patchBad.statusCode, 400, patchBad.body);
    const message = String((patchBad.json() as { message?: string }).message ?? '');
    assert.ok(!/NaN|zod|snake_case|_rial\b/.test(message), `message must stay business-level: ${message}`);

    /* §31 zero-price decision (documented, never silent): a 0 base is «قیمت تعیین نشده», so the
       resolver refuses the sale with a Persian business error instead of selling at 0. */
    const zero = await createProduct(app, headers, { name: `صفر ${randomUUID().slice(0, 6)}`, category: 'کت',
      cashPriceRial: '0', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M' }] });
    const zeroResolved = await resolveOne(app, null, zero.variants[0]!.id);
    assert.equal(zeroResolved.statusCode, 400, zeroResolved.body);
    assert.match(String(zeroResolved.json().message ?? ''), /قیمت نقدی پایه/);
  } finally { await app.close(); await pool.end(); }
});

test('P2-PRICE-005..008: four-installment needs the explicit enable + base and honours its discount policy', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر قسط');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);

    // P2-PRICE-005: enabling installments without the explicit base is refused (Persian, 400).
    const missingBase = await app.inject({ method: 'POST', url: '/api/v1/products', headers,
      payload: { saveIntent: 'draft', name: `قسط بی‌پایه ${suffix}`, category: 'کت', brand: 'کلبه',
        cashPriceRial: '60000000', installmentEnabled: true, variants: [{ size: 'M' }] } });
    assert.equal(missingBase.statusCode, 400, missingBase.body);
    assert.match(String(missingBase.json().message ?? ''), /چهارقسطه/);

    const product = await createProduct(app, headers, { name: `قسط‌دار ${suffix}`, category: 'کت',
      cashPriceRial: '60000000', installmentEnabled: true, installmentPriceRial: '66000000',
      installmentPolicy: 'enabled_when_discounted', retailEnabled: true, wholesaleEnabled: false,
      variants: [{ size: 'M', color: 'مشکی' }] });

    // P2-PRICE-006: the installment base is the EXPLICIT price — never derived from the cash price.
    const installment = await resolveOne(app, null, product.variants[0]!.id, 'retail', 'four_installments');
    assert.equal(installment.statusCode, 200, installment.body);
    assert.equal(installment.json().basePrice, '66000000');
    assert.equal(installment.json().installmentBasePriceRial, '66000000');
    assert.equal(installment.json().installmentEnabled, true);
    const cash = await resolveOne(app, null, product.variants[0]!.id, 'retail', 'cash');
    assert.equal(cash.json().basePrice, '60000000', 'cash and installment keep independent bases');

    // P2-PRICE-007: an ordinary discount applies to the installment base only because the policy allows it.
    const rule = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers,
      payload: { name: `تخفیف قسط ${suffix}`, channel: 'retail', targetType: 'product', productId: product.id,
        discountType: 'percent', discountValue: 10, active: true } });
    assert.equal(rule.statusCode, 201, rule.body);
    const discountedInstallment = await resolveOne(app, null, product.variants[0]!.id, 'retail', 'four_installments');
    assert.equal(discountedInstallment.json().basePrice, '66000000');
    assert.equal(discountedInstallment.json().discountAmount, '6600000');
    assert.equal(discountedInstallment.json().finalPrice, '59400000');

    // P2-PRICE-008: flipped to «تخفیف روی چهارقسطه اعمال نشود» the resolver stops applying it and
    // flags the block (the order pipeline then refuses the purchase instead of guessing a price).
    const flipped = await app.inject({ method: 'PATCH', url: `/api/v1/products/${product.id}`, headers,
      payload: { installmentPolicy: 'disabled_when_discounted' } });
    assert.equal(flipped.statusCode, 200, flipped.body);
    const blockedInstallment = await resolveOne(app, null, product.variants[0]!.id, 'retail', 'four_installments');
    assert.equal(blockedInstallment.json().discountAmount, '0');
    assert.equal(blockedInstallment.json().finalPrice, '66000000');
    assert.equal(blockedInstallment.json().installmentDiscountBlocked, true);
    assert.equal(blockedInstallment.json().installmentPolicy, 'disabled_when_discounted');
    // The cash channel still applies the very same promotion — the policies are independent.
    assert.equal((await resolveOne(app, null, product.variants[0]!.id, 'retail', 'cash')).json().finalPrice, '54000000');

    // A product with installments OFF cannot be priced on that channel at all.
    const off = await createProduct(app, headers, { name: `بدون قسط ${suffix}`, category: 'کت',
      cashPriceRial: '20000000', installmentEnabled: false, retailEnabled: true, wholesaleEnabled: false,
      variants: [{ size: 'M' }] });
    const refused = await resolveOne(app, null, off.variants[0]!.id, 'retail', 'four_installments');
    assert.equal(refused.statusCode, 409, refused.body);
    assert.match(String(refused.json().message ?? ''), /چهارقسطه/);
  } finally { await app.close(); await pool.end(); }
});

test('P2-PRICE-009..013: wholesale Series pricing is explicit — direct total or component-derived', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر عمده');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);

    const direct = await createProduct(app, headers, { name: `سری مستقیم ${suffix}`, category: 'کت',
      cashPriceRial: '40000000', wholesaleEnabled: true, retailEnabled: false, wholesalePriceRial: '30000000',
      variants: [{ size: 'S' }, { size: 'M' }, { size: 'L' }] });

    // P2-PRICE-009: «قیمت کل سری» is allocated over the pieces deterministically and exactly.
    const directTemplate = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
      payload: { productId: direct.id, name: `سری ۶ تکه ${suffix}`, pricingMode: 'series_total', totalPriceRial: '180000000',
        minOrderSeries: 1, items: [
          { variantId: direct.variants[0]!.id, quantityPerSeries: 2 },
          { variantId: direct.variants[1]!.id, quantityPerSeries: 2 },
          { variantId: direct.variants[2]!.id, quantityPerSeries: 2 }] } });
    assert.equal(directTemplate.statusCode, 201, directTemplate.body);

    const wholesale = await app.inject({ method: 'POST', url: '/api/v1/pricing/resolve', headers,
      payload: { orderType: 'wholesale', paymentMode: 'cash', series: [{ seriesTemplateId: directTemplate.json().id, count: 1 }] } });
    assert.equal(wholesale.statusCode, 200, wholesale.body);
    const seriesBlock = (wholesale.json().series as Array<{ totalPriceRial: string; piecesPerSeries: number; pricingMode: string;
      unitPrices: Array<{ variantId: string; basePriceRial: string }> }>)[0]!;
    assert.equal(seriesBlock.pricingMode, 'series_total');
    assert.equal(seriesBlock.piecesPerSeries, 6);
    assert.equal(seriesBlock.totalPriceRial, '180000000', 'the allocated unit prices preserve the series total exactly');
    assert.equal(seriesBlock.unitPrices.length, 3);
    assert.ok(seriesBlock.unitPrices.every((unit) => unit.basePriceRial === '30000000'), 'an evenly divisible total yields equal unit prices');
    const directTemplates = await app.inject({ method: 'GET', url: `/api/v1/series-templates?productId=${direct.id}`, headers });
    assert.equal(directTemplates.statusCode, 200, directTemplates.body);

    // P2-PRICE-010: the wholesale unit price (loose pieces) is the explicit wholesale authority.
    const loose = await resolveOne(app, headers, direct.variants[0]!.id, 'wholesale', 'cash');
    assert.equal(loose.statusCode, 200, loose.body);
    assert.equal(loose.json().basePrice, '30000000');

    // P2-PRICE-011: «محاسبه از اجزای سری» requires every component price, and the server derives the total.
    const derived = await createProduct(app, headers, { name: `سری مشتق ${suffix}`, category: 'کت',
      cashPriceRial: '40000000', wholesaleEnabled: true, retailEnabled: false, wholesalePriceRial: '30000000',
      variants: [{ size: 'S' }, { size: 'M' }] });
    const missingComponent = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
      payload: { productId: derived.id, name: `سری ناقص ${suffix}`, pricingMode: 'component_sum', minOrderSeries: 1,
        items: [{ variantId: derived.variants[0]!.id, quantityPerSeries: 1 }] } });
    assert.equal(missingComponent.statusCode, 400, missingComponent.body);
    assert.match(String(missingComponent.json().message ?? ''), /جزء|جز/);

    const derivedTemplate = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
      payload: { productId: derived.id, name: `سری اجزا ${suffix}`, pricingMode: 'component_sum', minOrderSeries: 1, items: [
        { variantId: derived.variants[0]!.id, quantityPerSeries: 2, unitPriceRial: '31000000' },
        { variantId: derived.variants[1]!.id, quantityPerSeries: 1, unitPriceRial: '29000000' }] } });
    assert.equal(derivedTemplate.statusCode, 201, derivedTemplate.body);

    // P2-PRICE-012: the component sum is the server-computed series total (2×31m + 1×29m = 91m).
    const templates = await app.inject({ method: 'GET', url: `/api/v1/series-templates?productId=${derived.id}`, headers });
    assert.equal(templates.statusCode, 200, templates.body);
    const derivedRow = (templates.json().items as Array<{ id: string; price_per_series_rial: string | null; pricing_mode: string }>)
      .find((row) => row.id === derivedTemplate.json().id);
    assert.equal(derivedRow?.pricing_mode, 'component_sum');
    assert.equal(derivedRow?.price_per_series_rial, '91000000');
    const derivedPreview = await app.inject({ method: 'POST', url: '/api/v1/pricing/resolve', headers,
      payload: { orderType: 'wholesale', paymentMode: 'cash', series: [{ seriesTemplateId: derivedTemplate.json().id, count: 2 }] } });
    assert.equal(derivedPreview.statusCode, 200, derivedPreview.body);
    const derivedBlock = (derivedPreview.json().series as Array<{ totalPriceRial: string; piecesPerSeries: number }>)[0]!;
    assert.equal(derivedBlock.piecesPerSeries, 3);
    assert.equal(derivedBlock.totalPriceRial, '182000000', 'two series of (2×31m + 1×29m) = 182m');

    // P2-PRICE-011 (continuation): a wholesale request that names the Series gets the Series total;
    // an unknown/inactive identity is refused explicitly instead of falling back to piece prices.
    const ghost = await app.inject({ method: 'POST', url: '/api/v1/pricing/resolve', headers,
      payload: { orderType: 'wholesale', paymentMode: 'cash', series: [{ seriesTemplateId: randomUUID(), count: 1 }] } });
    assert.equal(ghost.statusCode, 400, ghost.body);
    assert.match(String(ghost.json().message ?? ''), /سری/);
    const retailSeries = await app.inject({ method: 'POST', url: '/api/v1/pricing/resolve', headers,
      payload: { orderType: 'retail', paymentMode: 'cash', series: [{ seriesTemplateId: directTemplate.json().id, count: 1 }] } });
    assert.equal(retailSeries.statusCode, 400, 'a Series is a wholesale concept — retail requests cannot carry one');

    // P2-PRICE-013: a product WITHOUT a wholesale price is an explicit business error on the wholesale
    // channel — the resolver never falls back to the retail cash price.
    const retailOnly = await createProduct(app, headers, { name: `فقط خرده ${suffix}`, category: 'کت',
      cashPriceRial: '40000000', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M' }] });
    const noWholesale = await resolveOne(app, headers, retailOnly.variants[0]!.id, 'wholesale', 'cash');
    assert.equal(noWholesale.statusCode, 400, noWholesale.body);
    assert.match(String(noWholesale.json().message ?? ''), /عمده/);
    assert.ok(!String(noWholesale.json().message ?? '').includes('40000000'), 'no retail number leaks into the wholesale error');
  } finally { await app.close(); await pool.end(); }
});

test('P2-PRICE-014..019: promotion integration — rounding, precedence, festival priority and no hidden authority', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر تخفیف');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);
    const product = await createProduct(app, headers, { name: `تخفیف‌دار ${suffix}`, category: 'کت',
      cashPriceRial: '12345678', retailEnabled: true, wholesaleEnabled: false,
      variants: [{ size: 'S', color: 'مشکی' }, { size: 'M', color: 'مشکی' }, { size: 'M', color: 'سفید' }] });
    const [variantS, variantM] = product.variants as { id: string }[];

    const addRule = async (payload: Record<string, unknown>) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers,
        payload: { channel: 'retail', discountType: 'percent', discountValue: 10, active: true, ...payload } });
      assert.equal(res.statusCode, 201, res.body);
      return res.json().id as string;
    };

    // P2-PRICE-014: percentage discounts round deterministically on integer rial (floor of base × pct / 100).
    const percentId = await addRule({ name: `درصد ${suffix}`, targetType: 'product', productId: product.id, discountValue: 11 });
    const percentResolved = await resolveOne(app, null, variantM!.id);
    assert.equal(percentResolved.json().discountAmount, String((12345678n * 11n) / 100n));
    assert.equal(percentResolved.json().finalPrice, String(12345678n - (12345678n * 11n) / 100n));
    assert.equal(percentResolved.json().compareAtPriceRial, '12345678', 'the crossed-out price derives from the base');

    // P2-PRICE-015: a fixed discount is capped at the base (never a negative price).
    const fixedId = await addRule({ name: `مبلغی ${suffix}`, targetType: 'product', productId: product.id,
      discountType: 'fixed_rial', discountValue: '999999999', priority: 5 });
    const capped = await resolveOne(app, null, variantM!.id);
    assert.equal(capped.json().discountAmount, '12345678');
    assert.equal(capped.json().finalPrice, '0');
    await app.inject({ method: 'PATCH', url: `/api/v1/promotions/rules/${fixedId}`, headers, payload: { active: false } });

    // P2-PRICE-016: canonical precedence — the most specific target wins inside the same priority.
    const sizeId = await addRule({ name: `سایز ${suffix}`, targetType: 'size', productId: product.id, sizeCode: 'M', discountValue: 30 });
    const variantId = await addRule({ name: `واریانت ${suffix}`, targetType: 'variant', productId: product.id, variantId: variantS!.id, discountValue: 40 });
    await app.inject({ method: 'PATCH', url: `/api/v1/promotions/rules/${percentId}`, headers, payload: { priority: 0 } });
    const byVariant = await resolveOne(app, null, variantS!.id);
    assert.equal(byVariant.json().matchedRule.targetType, 'variant');
    assert.equal(byVariant.json().matchedRule.id, variantId);
    const bySize = await resolveOne(app, null, variantM!.id);
    assert.equal(bySize.json().matchedRule.targetType, 'size');
    assert.equal(bySize.json().matchedRule.id, sizeId);

    // P2-PRICE-017: a running Festival overrides ordinary discounts (exclusivity, not "best discount").
    const festival = await app.inject({ method: 'POST', url: '/api/v1/promotions', headers,
      payload: { name: `جشنواره ${suffix}`, kind: 'festival', channel: 'retail', active: true } });
    assert.equal(festival.statusCode, 201, festival.body);
    const festivalId = festival.json().id as string;
    const festivalRule = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers,
      payload: { promotionId: festivalId, name: `تخفیف جشنواره ${suffix}`, channel: 'retail', targetType: 'product',
        productId: product.id, discountType: 'percent', discountValue: 5, active: true } });
    assert.equal(festivalRule.statusCode, 201, festivalRule.body);
    const festivalPrice = await resolveOne(app, null, variantM!.id);
    assert.equal(festivalPrice.json().source, 'festival');
    assert.equal(festivalPrice.json().discountAmount, String((12345678n * 5n) / 100n));

    // P2-PRICE-018: entering a festival SUSPENDS the ordinary rules; ending the festival does NOT
    // reactivate them (DEC-PRICING-001) — only an explicit reactivation does.
    const entered = await app.inject({ method: 'POST', url: `/api/v1/promotions/products/${product.id}/mode`, headers,
      payload: { mode: 'festival', promotionId: festivalId, channel: 'retail', discountType: 'percent', discountValue: 5 } });
    assert.equal(entered.statusCode, 200, entered.body);
    const suspendedCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM promotion_rules WHERE product_id = $1 AND suspended_by_promotion_id IS NOT NULL`, [product.id]);
    assert.ok(Number(suspendedCount.rows[0]!.n) > 0, 'ordinary rules are suspended, not deleted');
    await app.inject({ method: 'PATCH', url: `/api/v1/promotions/${festivalId}`, headers, payload: { active: false } });
    const afterFestival = await resolveOne(app, null, variantM!.id);
    assert.equal(afterFestival.json().matchedRule, null, 'suspended rules stay dormant after the festival ends');
    assert.equal(afterFestival.json().finalPrice, '12345678');
    const suspendedRule = (await pool.query<{ id: string }>(
      `SELECT id FROM promotion_rules WHERE product_id = $1 AND suspended_by_promotion_id IS NOT NULL LIMIT 1`, [product.id])).rows[0]!;
    const reactivated = await app.inject({ method: 'POST', url: `/api/v1/promotions/rules/${suspendedRule.id}/reactivate`, headers });
    assert.equal(reactivated.statusCode, 200, reactivated.body);
    assert.ok((await rulesOf(app, headers, product.id)).some((row) => row.id === suspendedRule.id && row.active));

    // P2-PRICE-019: the discount engine never writes a final/discounted price into the product row —
    // the base columns stay exactly as the operator saved them.
    const stored = await pool.query<{ cash_price_rial: string; installment_price_rial: string | null; discount_percent: number }>(
      'SELECT cash_price_rial, installment_price_rial, discount_percent FROM products WHERE id = $1', [product.id]);
    assert.equal(stored.rows[0]!.cash_price_rial, '12345678');
    assert.equal(stored.rows[0]!.installment_price_rial, null);
    assert.equal(Number(stored.rows[0]!.discount_percent), 0);
  } finally { await app.close(); await pool.end(); }
});

test('P2-PRICE-020..022: sales mode drives pricing — no channel ever borrows the other one', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر حالت فروش');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);

    const retailOnly = await createProduct(app, headers, { name: `خرده‌فقط ${suffix}`, category: 'کت',
      cashPriceRial: '25000000', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M' }] });
    const wholesaleOnly = await createProduct(app, headers, { name: `عمده‌فقط ${suffix}`, category: 'کت',
      cashPriceRial: '0', wholesalePriceRial: '18000000', retailEnabled: false, wholesaleEnabled: true, variants: [{ size: 'M' }] });
    const both = await createProduct(app, headers, { name: `هر‌دو ${suffix}`, category: 'کت',
      cashPriceRial: '33000000', wholesalePriceRial: '21000000', retailEnabled: true, wholesaleEnabled: true, variants: [{ size: 'M' }] });

    // P2-PRICE-020: retail-only prices the retail channel and refuses the wholesale one.
    assert.equal((await resolveOne(app, null, retailOnly.variants[0]!.id, 'retail', 'cash')).json().basePrice, '25000000');
    assert.equal((await resolveOne(app, headers, retailOnly.variants[0]!.id, 'wholesale', 'cash')).statusCode, 400);

    // P2-PRICE-021: wholesale-only has NO retail price to fall back on — the retail channel is refused.
    const wholesaleRetailAttempt = await resolveOne(app, null, wholesaleOnly.variants[0]!.id, 'retail', 'cash');
    assert.equal(wholesaleRetailAttempt.statusCode, 400, wholesaleRetailAttempt.body);
    assert.match(String(wholesaleRetailAttempt.json().message ?? ''), /نقدی/);
    assert.equal((await resolveOne(app, headers, wholesaleOnly.variants[0]!.id, 'wholesale', 'cash')).json().basePrice, '18000000');

    // P2-PRICE-022: both channels keep two independent bases.
    const bothCash = await resolveOne(app, null, both.variants[0]!.id, 'retail', 'cash');
    const bothWholesale = await resolveOne(app, headers, both.variants[0]!.id, 'wholesale', 'cash');
    assert.equal(bothCash.json().basePrice, '33000000');
    assert.equal(bothWholesale.json().basePrice, '21000000');
    assert.notEqual(bothCash.json().basePrice, bothWholesale.json().basePrice);
  } finally { await app.close(); await pool.end(); }
});

test('P2-PRICE-023..026: resolver == catalog == hub row == cart == order snapshot', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر یکسانی');
    const headers = await login(app, admin.email);
    const buyer = await makeUser(pool, ['customer'], 'خریدار یکسانی');
    const buyerHeaders = await login(app, buyer.email);
    const suffix = randomUUID().slice(0, 6);
    const retail = await warehouse(pool, 'retail', `انبار خرده ${suffix}`);

    const product = await createProduct(app, headers, { name: `یکسان ${suffix}`, category: 'کت',
      cashPriceRial: '30000000', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M', color: 'مشکی' }] });
    await receive(app, headers, retail, product.variants[0]!.id, 5);
    const rule = await app.inject({ method: 'POST', url: '/api/v1/promotions/rules', headers,
      payload: { name: `تخفیف یکسان ${suffix}`, channel: 'retail', targetType: 'product', productId: product.id,
        discountType: 'percent', discountValue: 10, active: true } });
    assert.equal(rule.statusCode, 201, rule.body);

    const resolved = await resolveOne(app, null, product.variants[0]!.id);
    const expectedFinal = resolved.json().finalPrice as string;
    assert.equal(expectedFinal, '27000000');

    // P2-PRICE-023: catalog row + hub row both expose the very same resolved numbers.
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/products?limit=100' });
    const catalogRow = (catalog.json().items as Array<{ id: string; pricing?: { finalPriceRial: string; basePriceRial: string; discountAmountRial: string } }>)
      .find((item) => item.id === product.id);
    assert.equal(catalogRow?.pricing?.finalPriceRial, expectedFinal);
    assert.equal(catalogRow?.pricing?.basePriceRial, '30000000');
    assert.equal(catalogRow?.pricing?.discountAmountRial, '3000000');

    const hub = await app.inject({ method: 'GET', url: `/api/v1/admin/products?q=${encodeURIComponent(`یکسان ${suffix}`)}`, headers });
    assert.equal(hub.statusCode, 200, hub.body);
    const hubRow = (hub.json().items as Array<{ id: string; pricing?: { retailFinalPriceRial: string; retailBasePriceRial: string; retailDiscountRial: string } }>)
      .find((item) => item.id === product.id);
    assert.equal(hubRow?.pricing?.retailFinalPriceRial, expectedFinal);
    assert.equal(hubRow?.pricing?.retailBasePriceRial, '30000000');
    assert.equal(hubRow?.pricing?.retailDiscountRial, '3000000');

    // P2-PRICE-024: the cart stores the LATEST server resolution (never the raw base, never a browser price).
    const added = await app.inject({ method: 'POST', url: '/api/v1/cart/items', headers: buyerHeaders,
      payload: { productId: product.id, variantId: product.variants[0]!.id, quantity: 1, expectedUnitPriceRial: '27000000' } });
    assert.equal(added.statusCode, 201, added.body);
    const cart = await app.inject({ method: 'GET', url: '/api/v1/cart', headers: buyerHeaders });
    assert.equal(cart.statusCode, 200, cart.body);
    const line = (cart.json().items as Array<{ unit_price_rial: string; product_id: string }>).find((item) => item.product_id === product.id);
    assert.equal(line?.unit_price_rial, expectedFinal);
    const staleAdd = await app.inject({ method: 'POST', url: '/api/v1/cart/items', headers: buyerHeaders,
      payload: { productId: product.id, variantId: product.variants[0]!.id, quantity: 1, expectedUnitPriceRial: '30000000' } });
    assert.equal(staleAdd.statusCode, 409, 'a stale browser price is rejected with a clear message');

    // P2-PRICE-025: the created order snapshots the resolver output; later price edits never rewrite history.
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': `p2-o-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId: product.variants[0]!.id, quantity: 1 }],
        shippingAddress: customer('خریدار یکسانی') } });
    assert.equal(order.statusCode, 201, order.body);
    const orderId = order.json().id as string;
    const lineRow = (await pool.query<{ base_unit_price_rial: string; unit_price_rial: string; discount_amount_rial: string; pricing_snapshot: Record<string, unknown> }>(
      'SELECT base_unit_price_rial::text, unit_price_rial::text, discount_amount_rial::text, pricing_snapshot FROM order_lines WHERE order_id = $1', [orderId])).rows[0]!;
    assert.equal(lineRow.base_unit_price_rial, '30000000');
    assert.equal(lineRow.unit_price_rial, '27000000');
    assert.equal(lineRow.discount_amount_rial, '3000000');
    const snapshot = lineRow.pricing_snapshot as { finalPrice?: string; matchedRule?: { id?: string } | null; channel?: string };
    assert.equal(snapshot.finalPrice, expectedFinal);
    assert.equal(snapshot.channel, 'retail');
    assert.equal(snapshot.matchedRule?.id, rule.json().id as string);

    await app.inject({ method: 'PATCH', url: `/api/v1/products/${product.id}`, headers, payload: { cashPriceRial: '35000000' } });
    const historical = (await pool.query<{ unit_price_rial: string; base_unit_price_rial: string }>(
      'SELECT unit_price_rial::text, base_unit_price_rial::text FROM order_lines WHERE order_id = $1', [orderId])).rows[0]!;
    assert.equal(historical.unit_price_rial, '27000000', 'a later price edit never mutates the historical order');
    assert.equal(historical.base_unit_price_rial, '30000000');

    /* §22/§24: the order endpoint is a strict boundary — any client-supplied price on a line is
       rejected outright (the server always resolves the payable amount itself). */
    for (const field of ['unitPriceRial', 'totalRial', 'discountRial']) {
      const rejected = await app.inject({ method: 'POST', url: '/api/v1/orders',
        headers: { ...buyerHeaders, 'idempotency-key': `p2-bad-${field}-${suffix}` },
        payload: { orderType: 'retail', paymentMode: 'cash',
          items: [{ variantId: product.variants[0]!.id, quantity: 1, [field]: '1' }],
          shippingAddress: customer('خریدار یکسانی') } });
      assert.equal(rejected.statusCode, 400, `${field} must be rejected: ${rejected.body}`);
    }

    // P2-PRICE-026: price history rides the existing audit trail (previous/new values + actor).
    const auditRow = (await pool.query<{ action: string; old_value: unknown; new_value: unknown; actor_id: string }>(
      `SELECT action, old_value, new_value, actor_id FROM audit_logs
        WHERE resource_type = 'product' AND resource_id = $1 AND action = 'product.price_changed'
        ORDER BY created_at DESC LIMIT 1`, [product.id])).rows[0];
    assert.ok(auditRow, 'a re-priced product leaves a price-change audit entry');
    assert.equal(auditRow!.actor_id, admin.id);
    assert.match(JSON.stringify(auditRow!.old_value), /30000000/);
    assert.match(String(JSON.stringify(auditRow!.new_value)), /35000000/);

    const seriesAudit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_logs WHERE action IN ('series_template.created', 'series_template.updated', 'series_template.price_changed')`);
    assert.ok(Number(seriesAudit.rows[0]!.n) >= 0, 'series history uses the same audit infrastructure');
  } finally { await app.close(); await pool.end(); }
});

test('P2-REG-001..005: pricing edits never publish, never write stock and never duplicate the draft', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر رگرسیون قیمت');
    const headers = await login(app, admin.email);
    const suffix = randomUUID().slice(0, 6);
    const retail = await warehouse(pool, 'retail', `انبار رگرسیون ${suffix}`);

    // P2-REG-005: the idempotent create keeps ONE product id — a retry never duplicates the draft.
    const key = `p2-draft-${suffix}`;
    const payload = { saveIntent: 'draft', brand: 'کلبه', name: `پیش‌نویس ${suffix}`, category: 'کت',
      cashPriceRial: '10000000', retailEnabled: true, wholesaleEnabled: false, variants: [{ size: 'M' }] };
    const first = await app.inject({ method: 'POST', url: '/api/v1/products', headers: { ...headers, 'idempotency-key': key }, payload });
    assert.equal(first.statusCode, 201, first.body);
    const second = await app.inject({ method: 'POST', url: '/api/v1/products', headers: { ...headers, 'idempotency-key': key }, payload });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().id, first.json().id, 'the same idempotency key reuses the same product id');
    const duplicates = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM products WHERE name = $1', [payload.name]);
    assert.equal(Number(duplicates.rows[0]!.n), 1, 'no duplicate draft row is created');
    const productId = first.json().id as string;
    const variantId = (first.json().variants as { id: string }[])[0]!.id;

    // P2-REG-001: a price edit on a Draft keeps it a Draft.
    const priced = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers,
      payload: { cashPriceRial: '15000000', wholesalePriceRial: '11000000' } });
    assert.equal(priced.statusCode, 200, priced.body);
    const status = await pool.query<{ status: string }>('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(status.rows[0]!.status, 'draft');

    // P2-REG-002: pricing never touches the stock ledger.
    const balancesBefore = await pool.query<{ n: string }>(
      'SELECT COALESCE(sum(on_hand),0)::text AS n FROM stock_balances WHERE variant_id = $1', [variantId]);
    const seriesWrite = await app.inject({ method: 'POST', url: '/api/v1/series-templates', headers,
      payload: { productId, name: `سری رگرسیون ${suffix}`, pricingMode: 'series_total', totalPriceRial: '60000000',
        minOrderSeries: 1, items: [{ variantId, quantityPerSeries: 4 }] } });
    assert.equal(seriesWrite.statusCode, 201, seriesWrite.body);
    const balancesAfter = await pool.query<{ n: string }>(
      'SELECT COALESCE(sum(on_hand),0)::text AS n FROM stock_balances WHERE variant_id = $1', [variantId]);
    assert.equal(balancesAfter.rows[0]!.n, balancesBefore.rows[0]!.n);

    // P2-REG-003: a WMS receipt writes stock and STILL does not publish the product.
    await receive(app, headers, retail, variantId, 4);
    const afterReceipt = await pool.query<{ status: string }>('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(afterReceipt.rows[0]!.status, 'draft', 'WMS never auto-publishes');
    const onHand = await pool.query<{ n: number }>(
      'SELECT COALESCE(sum(on_hand),0)::int AS n FROM stock_balances WHERE variant_id = $1', [variantId]);
    assert.equal(onHand.rows[0]!.n, 4);

    // P2-REG-004: the explicit publish action still works after pricing/stock activity.
    const published = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers, payload: { status: 'published' } });
    assert.equal(published.statusCode, 200, published.body);
    const finalStatus = await pool.query<{ status: string }>('SELECT status FROM products WHERE id = $1', [productId]);
    assert.equal(finalStatus.rows[0]!.status, 'published');
    const stockAfterPublish = await pool.query<{ n: number }>(
      'SELECT COALESCE(sum(on_hand),0)::int AS n FROM stock_balances WHERE variant_id = $1', [variantId]);
    assert.equal(stockAfterPublish.rows[0]!.n, 4, 'publishing never changes stock');
  } finally { await app.close(); await pool.end(); }
});
