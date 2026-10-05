/**
 * Explicit local development seed — `npm run seed:local`.
 *
 * Purpose: a fresh database can be explored end-to-end in the admin console and the
 * storefront without inventing data by hand.
 *
 * Guarantees:
 * - Runs ONLY when NODE_ENV=development (production/test refuse to run).
 * - Idempotent: every entity is looked up before it is created; re-running only fills gaps.
 * - Domain writes go through Fastify routes (validation, audit, ledger, WMS movements,
 *   CMS bootstrap). Fixture-only customer creation uses hashed DB inserts to preserve
 *   the public registration rate limit.
 * - Never runs automatically: it is not imported by main.ts and is not part of `npm start`.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import type { DbPool } from './db.js';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { demoArticles, demoCategoryImages, demoProducts } from './demo-content.js';

const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@kolbe.ir';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-123456';
const customerEmail = 'seed.customer@kolbe.ir';
const customerPassword = 'Seed-Customer-123456';
const supplierEmail = 'seed.supplier@kolbe.ir';
const supplierPassword = 'Seed-Supplier-123456';

type Injection = { status: number; body: any };
const log: string[] = [];
const step = (message: string) => { log.push(message); console.log(`  • ${message}`); };

async function main() {
  const config = loadConfig();
  if (config.NODE_ENV !== 'development') {
    console.error(`seed:local only runs with NODE_ENV=development (got ${config.NODE_ENV}).`);
    process.exit(1);
  }
  const app = await buildApp(config);
  await app.ready();
  const pool = createPool(config);
  try {
    await seed(app, pool);
  } finally {
    await pool.end().catch(() => undefined);
    await app.close();
  }
  console.log(`\nseed:local finished — ${log.length} steps applied (idempotent, re-runnable).`);
}

async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string,
  options: { token?: string; payload?: unknown; key?: string } = {}): Promise<Injection> {
  const response = await app.inject({
    method, url,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
    },
    ...(options.payload !== undefined ? { payload: options.payload as never } : {}),
  });
  const text = response.body;
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.statusCode, body };
}

async function login(app: FastifyInstance, identity: string, password: string) {
  const res = await call(app, 'POST', '/api/v1/auth/login', { payload: { identity, password } });
  if (res.status !== 200) throw new Error(`login failed for ${identity}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

async function ensureUser(pool: DbPool, input: { email: string; password: string; displayName: string; phone: string }) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [input.email]);
  if (existing.rows[0]) return { id: existing.rows[0].id as string, created: false };
  // Fixture provisioning is local-only; inserting password hashes directly avoids weakening the
  // public registration rate limit when populating several demo accounts at once.
  const id = randomUUID();
  const passwordHash = await argon2.hash(input.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES($1,$2,$3,$4,$5)',
      [id, input.email, input.phone, passwordHash, input.displayName]);
    await client.query("INSERT INTO user_roles(user_id,role_code) VALUES($1,'customer')", [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return { id, created: true };
}

async function ensureSupplierAccount(app: FastifyInstance, pool: DbPool, adminToken: string, input: {
  email: string; password: string; displayName: string; phone: string; brand: string; city: string;
}) {
  const supplier = await ensureUser(pool, input);
  if (supplier.created) step(`تأمین‌کنندهٔ ${input.brand} ساخته شد.`);
  const profile = await pool.query('SELECT cooperation_status FROM supplier_profiles WHERE user_id=$1', [supplier.id]);
  if (profile.rows[0]?.cooperation_status !== 'approved') {
    const approved = await pool.query("SELECT id FROM cooperation_requests WHERE user_id=$1 AND status='approved' LIMIT 1", [supplier.id]);
    if (!approved.rows[0]) {
      const requested = await call(app, 'POST', '/api/v1/cooperation-requests', { payload: { payload: {
        brand_name: input.brand, legal_name: input.displayName, person_type: 'individual',
        national_id: '0000000000', phone: input.phone, mobile: input.phone, email: input.email,
        office_address: `${input.city}، نشانی آزمایشی`, bank_name: 'بانک آزمایشی',
        iban: 'IR000000000000000000000000', account_holder: input.displayName,
        product_categories: 'پوشاک', supply_capacity: '۳۰۰ تکه در ماه', lead_time_days: '7',
      } } });
      if (requested.status !== 201) throw new Error(`supplier request ${input.brand}: ${requested.status} ${JSON.stringify(requested.body)}`);
      const reviewed = await call(app, 'POST', `/api/v1/admin/cooperation-requests/${requested.body.id}/review`, {
        token: adminToken, payload: { status: 'approved', note: 'development demo data' },
      });
      if (![200, 201].includes(reviewed.status)) throw new Error(`supplier review ${input.brand}: ${reviewed.status} ${JSON.stringify(reviewed.body)}`);
    }
    const activated = await call(app, 'POST', `/api/v1/admin/suppliers/${supplier.id}/status`, {
      token: adminToken, payload: { status: 'approved', note: 'development demo data' },
    });
    if (activated.status !== 200) throw new Error(`supplier approval ${input.brand}: ${activated.status} ${JSON.stringify(activated.body)}`);
    step(`همکاری ${input.brand} تأیید شد.`);
  }
  return { ...supplier, token: await login(app, input.email, input.password) };
}

async function seed(app: FastifyInstance, pool: DbPool) {
  /* ---------------------------- admin session ---------------------------- */
  const adminToken = await login(app, adminEmail, adminPassword);
  step(`درخواست‌ها با حساب مدیر ${adminEmail} اجرا می‌شوند.`);

  /* ------------------------- shipping + warehouses ------------------------ */
  const warehouses: { id: string; code: string; name: string }[] = [];
  for (const wh of [
    { code: 'KV-TEH-01', name: 'انبار مرکزی تهران', location: { code: 'TEH-A01', name: 'قفسه A1 — تهران' } },
    { code: 'KV-ISF-01', name: 'انبار اصفهان', location: { code: 'ISF-A01', name: 'قفسه A1 — اصفهان' } },
  ]) {
    const existing = await pool.query('SELECT id, code, name FROM warehouses WHERE code = $1', [wh.code]);
    let warehouseId: string;
    if (existing.rows[0]) { warehouseId = existing.rows[0].id; }
    else {
      const res = await call(app, 'POST', '/api/v1/warehouses', { token: adminToken, payload: { code: wh.code, name: wh.name } });
      if (res.status !== 201) throw new Error(`warehouse ${wh.code}: ${res.status} ${JSON.stringify(res.body)}`);
      warehouseId = res.body.id;
      step(`انبار ${wh.name} (${wh.code}) ساخته شد.`);
    }
    const locations = await pool.query('SELECT code FROM warehouse_locations WHERE warehouse_id = $1 AND code = $2', [warehouseId, wh.location.code]);
    if (!locations.rows[0]) {
      const res = await call(app, 'POST', `/api/v1/warehouses/${warehouseId}/locations`, { token: adminToken, payload: wh.location });
      if (res.status !== 201) throw new Error(`location ${wh.location.code}: ${res.status} ${JSON.stringify(res.body)}`);
      step(`مکان ${wh.location.name} ثبت شد.`);
    }
    warehouses.push({ id: warehouseId, code: wh.code, name: wh.name });
  }
  const mainWarehouse = warehouses[0]!;

  const settings = await call(app, 'GET', '/api/v1/admin/site-settings/shipping', { token: adminToken });
  if (!settings.body?.settings?.defaultWarehouseId) {
    const res = await call(app, 'PUT', '/api/v1/admin/site-settings/shipping', {
      token: adminToken,
      payload: { defaultWarehouseId: mainWarehouse.id, freeShippingThresholdRial: '50000000', autoTracking: true },
    });
    if (res.status !== 200) throw new Error(`shipping settings: ${res.status} ${JSON.stringify(res.body)}`);
    step(`انبار پیش‌فرض ارسال روی ${mainWarehouse.name} تنظیم شد.`);
  }

  const methods = await call(app, 'GET', '/api/v1/admin/shipping-methods', { token: adminToken });
  if (!(methods.body?.items ?? []).length) {
    for (const method of [
      { code: 'post-pishtaz', name: 'پست پیشتاز', type: 'standard', baseFeeRial: '450000', freeAboveRial: '50000000', estimatedMinDays: 2, estimatedMaxDays: 4, active: true, config: {} },
      { code: 'tipax-express', name: 'تیپاکس سریع', type: 'express', baseFeeRial: '890000', freeAboveRial: null, estimatedMinDays: 1, estimatedMaxDays: 2, active: true, config: {} },
      { code: 'pickup-tehran', name: 'تحویل حضوری تهران', type: 'pickup', baseFeeRial: '0', freeAboveRial: null, estimatedMinDays: 0, estimatedMaxDays: 1, active: true, config: {} },
    ]) {
      const res = await call(app, 'POST', '/api/v1/admin/shipping-methods', { token: adminToken, payload: method });
      if (res.status !== 201) throw new Error(`shipping ${method.code}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    step('سه روش ارسال واقعی ثبت شد.');
  }

  /* ------------------------------- customers ------------------------------ */
  const customer = await ensureUser(pool, { email: customerEmail, password: customerPassword, displayName: 'مشتری نمونه', phone: '09120000001' });
  if (customer.created) step(`مشتری نمونه ${customerEmail} ساخته شد.`);
  const customerToken = await login(app, customerEmail, customerPassword);
  const demoCustomers = [{ id: customer.id, email: customerEmail, token: customerToken, name: 'مشتری نمونه', phone: '09120000001', city: 'تهران', targetOrders: 2 }];
  for (const [index, input] of [
    { email: 'demo.sara@example.test', name: 'سارا رضایی', phone: '09120000011', city: 'تهران' },
    { email: 'demo.arian@example.test', name: 'آرین احمدی', phone: '09120000012', city: 'اصفهان' },
    { email: 'demo.niloofar@example.test', name: 'نیلوفر کریمی', phone: '09120000013', city: 'شیراز' },
  ].entries()) {
    const password = `Demo-Customer-${index + 1}-123456`;
    const account = await ensureUser(pool, { email: input.email, password, displayName: input.name, phone: input.phone });
    if (account.created) step(`حساب آزمایشی ${input.name} ساخته شد.`);
    demoCustomers.push({ ...input, id: account.id, token: await login(app, input.email, password), targetOrders: 1 });
  }

  /* ------------------------------- supplier ------------------------------- */
  const supplier = await ensureSupplierAccount(app, pool, adminToken, { email: supplierEmail, password: supplierPassword,
    displayName: 'کارگاه نیلگون', phone: '09120000002', brand: 'نیلگون', city: 'اصفهان' });
  const secondSupplier = await ensureSupplierAccount(app, pool, adminToken, { email: 'demo.farasu@example.test', password: 'Demo-Farasu-123456',
    displayName: 'کارگاه فراسو', phone: '09120000003', brand: 'فراسو', city: 'تهران' });

  /* -------------------------------- catalog ------------------------------- */
  const products: { id: string; name: string; variants: { id: string; sku: string; color: string | null; size: string | null }[] }[] = [];
  for (const definition of demoProducts) {
    const existing = await pool.query(`SELECT id FROM products WHERE name = $1 AND supplier_id IS NULL`, [definition.name]);
    let productId = existing.rows[0]?.id as string | undefined;
    if (!productId) {
      const variants = definition.colors.flatMap((color) => definition.sizes.map((size) => ({ color, size, attributes: {} })));
      const res = await call(app, 'POST', '/api/v1/products', {
        token: adminToken,
        payload: {
          brand: definition.brand, name: definition.name, category: definition.category,
          description: definition.description, cashPriceRial: definition.cash,
          wholesalePriceRial: definition.wholesale, variants,
          gender: definition.gender, genderCode: definition.genderCode,
          seasons: [...definition.seasons], vibes: [...definition.vibes],
          metadata: { images: definition.images.map((url) => ({ url })), fabric: definition.fabric,
            channels: { retail: true, wholesale: true }, source: 'seed:local' },
        },
      });
      if (res.status !== 201) throw new Error(`product ${definition.name}: ${res.status} ${JSON.stringify(res.body)}`);
      productId = res.body.id;
      step(`محصول ${definition.name} با ${res.body.variants.length} واریانت ساخته شد.`);
    }
    const status = await call(app, 'PATCH', `/api/v1/products/${productId}/status`, { token: adminToken, payload: { status: 'published' } });
    if (status.status !== 200) throw new Error(`publish ${definition.name}: ${status.status} ${JSON.stringify(status.body)}`);

    const variants = await pool.query(
      `SELECT id, sku, color_label AS color, size_label AS size FROM product_variants WHERE product_id = $1 AND active ORDER BY sku`, [productId]);
    products.push({ id: productId!, name: definition.name, variants: variants.rows });
    let receivedNow = 0;

    // Initial stock through the WMS ledger: receipt → receive (never a product column).
    for (const [index, variant] of variants.rows.entries()) {
      const balance = await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2', [variant.id, mainWarehouse.id]);
      if (balance.rows[0] && Number(balance.rows[0].on_hand) > 0) continue;
      const quantity = 4 + index * 3;
      const receipt = await call(app, 'POST', '/api/v1/inventory/receipts', {
        token: adminToken, key: `seed-receipt-${variant.sku}`,
        payload: { warehouseId: mainWarehouse.id, variantId: variant.id, quantity, reference: `SEED-${variant.sku}` },
      });
      if (receipt.status !== 201) throw new Error(`receipt ${variant.sku}: ${receipt.status} ${JSON.stringify(receipt.body)}`);
      const receive = await call(app, 'POST', `/api/v1/inventory/receipts/${receipt.body.id}/receive`, { token: adminToken });
      if (receive.status !== 200) throw new Error(`receive ${variant.sku}: ${receive.status} ${JSON.stringify(receive.body)}`);
      receivedNow += 1;
    }
    if (receivedNow) step(`موجودی اولیه ${receivedNow} واریانت «${definition.name}» از طریق WMS ثبت شد.`);
  }

  let wholesaleWarehouse = await pool.query("SELECT id FROM warehouses WHERE code='SEED-WHOLESALE'");
  if (!wholesaleWarehouse.rows[0]) {
    const created = await call(app, 'POST', '/api/v1/warehouses', { token: adminToken, payload: { code: 'SEED-WHOLESALE', name: 'انبار مرکزی عمده نمونه' } });
    if (created.status !== 201) throw new Error(`wholesale warehouse: ${JSON.stringify(created)}`);
    const purpose = await call(app, 'PATCH', `/api/v1/warehouses/${created.body.id}/purpose`, { token: adminToken, payload: { purpose: 'wholesale' } });
    if (purpose.status !== 200) throw new Error(`wholesale purpose: ${JSON.stringify(purpose)}`);
    wholesaleWarehouse = { rows: [{ id: created.body.id }] } as typeof wholesaleWarehouse;
  }
  for (const entry of [
    { account: supplier, mode: 'order_driven', name: 'پیراهن لینن نیلگون', brand: 'نیلگون', image: demoProducts[3].images[0], color: 'شیری', price: '24500000' },
    { account: secondSupplier, mode: 'stock_at_kolbe', name: 'بلیزر فراسو', brand: 'فراسو', image: demoProducts[6].images[0], color: 'شنی', price: '58400000' },
  ]) {
    let row = await pool.query('SELECT id FROM products WHERE supplier_id=$1 AND name=$2', [entry.account.id, entry.name]);
    if (!row.rows[0]) {
      const created = await call(app, 'POST', '/api/v1/products', { token: entry.account.token, payload: {
        brand: entry.brand, name: entry.name, category: entry.name.includes('بلیزر') ? 'کت و پالتو' : 'پیراهن و شومیز',
        description: `دوخت کارگاه ${entry.brand} با پارچهٔ انتخابی و کنترل کیفیت پیش از ارسال عمده.`,
        cashPriceRial: entry.price, wholesalePriceRial: String(Math.floor(Number(entry.price) * 0.76)),
        variants: ['M', 'L', 'XL'].map((size) => ({ size, color: entry.color, attributes: {} })),
        gender: entry.name.includes('بلیزر') ? 'men' : 'women',
        seasons: ['spring', 'autumn'], vibes: [],
        wholesaleEnabled: true, retailEnabled: false, wholesaleMoq: 3,
        metadata: { images: [{ url: entry.image }], fabric: 'لینن و پنبه', source: 'seed:local' },
      } });
      if (created.status !== 201) throw new Error(`supplier product ${entry.name}: ${created.status} ${JSON.stringify(created.body)}`);
      row = { rows: [{ id: created.body.id }] } as typeof row;
      step(`محصول عمدهٔ ${entry.brand} ثبت شد.`);
    }
    const published = await call(app, 'PATCH', `/api/v1/products/${row.rows[0].id}/status`, {
      token: adminToken, payload: { status: 'published' },
    });
    if (published.status !== 200) throw new Error(`supplier publish ${entry.name}: ${published.status} ${JSON.stringify(published.body)}`);
    const variants = await pool.query('SELECT id,sku FROM product_variants WHERE product_id=$1 AND active', [row.rows[0].id]);
    let template = await pool.query("SELECT id FROM series_templates WHERE product_id=$1 AND name='سری نمونه کارگاه'", [row.rows[0].id]);
    const seriesPrice = String(BigInt(entry.price) * 76n / 100n * 6n);
    if (!template.rows[0]) {
      const created = await call(app, 'POST', '/api/v1/series-templates', { token: entry.account.token, payload: {
        productId: row.rows[0].id, name: 'سری نمونه کارگاه', pricingMode: 'series_total', totalPriceRial: seriesPrice, minOrderSeries: 1,
        items: variants.rows.map((v) => ({ variantId: v.id, quantityPerSeries: 2 })),
      } });
      if (created.status !== 201) throw new Error(`supplier series: ${JSON.stringify(created)}`);
      template = { rows: [{ id: created.body.id }] } as typeof template;
    }
    const offer = await call(app, 'POST', '/api/v1/supplier/offers', { token: entry.account.token, payload: {
      productId: row.rows[0].id, seriesTemplateId: template.rows[0].id, colorLabel: entry.color,
      fulfillmentMode: entry.mode, wholesalePriceRial: seriesPrice, minOrderSeries: 1, maxOrderSeries: 20, safetyBuffer: 0, leadTimeDays: 3,
    } });
    if (offer.status !== 201 && offer.status !== 200) throw new Error(`supplier offer: ${JSON.stringify(offer)}`);
    if (entry.mode === 'order_driven') {
      const capacity = await call(app, 'POST', `/api/v1/supplier/offers/${offer.body.id}/capacity`, { token: entry.account.token, payload: { declaredCapacity: 20 } });
      if (capacity.status !== 200) throw new Error(`supplier capacity: ${JSON.stringify(capacity)}`);
      // Availability is a claim, never a receipt or a physical stock balance.
    } else {
      const key = `seed-consignment-${template.rows[0].id}`;
      let inbound = await pool.query('SELECT id,status FROM supplier_series_inbounds WHERE idempotency_key=$1', [key]);
      if (!inbound.rows[0]) {
        const created = await call(app, 'POST', '/api/v1/supplier/inbounds', { token: entry.account.token, payload: {
          productId: row.rows[0].id, seriesTemplateId: template.rows[0].id, expectedSeries: 12, idempotencyKey: key,
        } });
        if (created.status !== 201) throw new Error(`seed inbound: ${JSON.stringify(created)}`);
        inbound = { rows: [{ id: created.body.id, status: 'requested' }] } as typeof inbound;
      }
      const id = inbound.rows[0].id;
      const stages = [
        { before: 'requested', after: 'approved', token: adminToken, url: `/api/v1/admin/supplier-inbounds/${id}/review`, payload: { decision: 'approve', warehouseId: wholesaleWarehouse.rows[0].id } },
        { before: 'approved', after: 'dispatched', token: entry.account.token, url: `/api/v1/supplier/inbounds/${id}/dispatch`, payload: {} },
        { before: 'dispatched', after: 'received', token: adminToken, url: `/api/v1/admin/supplier-inbounds/${id}/receive`, payload: { receivedSeries: 12 } },
        { before: 'received', after: 'qc_completed', token: adminToken, url: `/api/v1/admin/supplier-inbounds/${id}/qc`, payload: { passedSeries: 12, rejectedSeries: 0 } },
      ];
      let current = inbound.rows[0].status;
      for (const stage of stages) if (current === stage.before) {
        const result = await call(app, 'POST', stage.url, { token: stage.token, payload: stage.payload });
        if (result.status !== 200) throw new Error(`seed consignment ${stage.before}: ${JSON.stringify(result)}`);
        current = stage.after;
      }
    }
    step(`سری و پیشنهاد واقعی ${entry.brand}: ${entry.mode === 'order_driven' ? 'ظرفیت اعلامی بدون موجودی فیزیکی' : 'موجودی امانی پس از دریافت و کنترل کیفیت در کلبه'}.`);
  }

  /* ------------------------------- membership ----------------------------- */
  // A fresh database has no membership plans (migrations only create the RBAC side), so the seed
  // creates one through the real admin route before activating the customer's membership.
  const existingPlan = await pool.query(`SELECT id FROM membership_plans WHERE code = 'seed-gold'`);
  let planId = existingPlan.rows[0]?.id as string | undefined;
  if (!planId) {
    const created = await call(app, 'POST', '/api/v1/plans', {
      token: adminToken,
      payload: {
        code: 'seed-gold', title: 'عضویت عمده نمونه', description: 'پلن نمونه ساخته‌شده با seed:local',
        annualPriceRial: '12000000',
        limits: { sources: 'all', discountPercent: 5, maxOrdersPerMonth: 50, maxOrderValueRial: '5000000000',
          maxOrderLines: 20, maxQuantityPerLine: 50, minOrderValueRial: '10000000', prioritySupport: true, installmentAccess: true },
        features: ['wholesale_catalog', 'wholesale_pricing', 'priority_support'],
        permissions: ['wholesale:read'],
      },
    });
    if (created.status !== 201) throw new Error(`plan: ${created.status} ${JSON.stringify(created.body)}`);
    planId = created.body.id;
    step('پلن عضویت نمونه ساخته شد.');
  }
  const membership = await pool.query(`SELECT id FROM memberships WHERE user_id = $1 AND status = 'active'`, [customer.id]);
  if (!membership.rows[0]) {
    const request = await call(app, 'POST', '/api/v1/memberships', {
      token: customerToken, key: `seed-membership-${customer.id}`,
      payload: { planId },
    });
    if (request.status !== 201) throw new Error(`membership: ${request.status} ${JSON.stringify(request.body)}`);
    const approve = await call(app, 'PATCH', `/api/v1/admin/memberships/${request.body.membershipId}`, {
      token: adminToken, payload: { status: 'active' },
    });
    if (approve.status !== 200) throw new Error(`membership approve: ${approve.status} ${JSON.stringify(approve.body)}`);
    step('عضویت عمده برای مشتری نمونه فعال شد.');
  }

  /* --------------------------------- orders -------------------------------- */
  const shippingMethods = await call(app, 'GET', '/api/v1/shipping-methods');
  const shippingMethod = (shippingMethods.body?.items ?? []).find((method: any) => method.type === 'standard') ?? shippingMethods.body?.items?.[0];
  for (const [customerIndex, buyer] of demoCustomers.entries()) {
    const customerOrders = await call(app, 'GET', '/api/v1/orders', { token: buyer.token });
    const needed = buyer.targetOrders - (customerOrders.body?.items ?? []).length;
    for (let index = 0; index < needed; index += 1) {
      const product = products[(customerIndex * 2 + index) % products.length]!;
      const variant = product.variants[index % product.variants.length]!;
      const order = await call(app, 'POST', '/api/v1/orders', {
        token: buyer.token, key: `seed-order-${buyer.id}-${product.id}-${index}`,
        payload: {
          orderType: 'retail', paymentMode: 'cash',
          items: [{ variantId: variant.id, quantity: 1 }],
          shippingAddress: {
            recipient: buyer.name, phone: buyer.phone, province: buyer.city, city: buyer.city,
            line: 'نشانی آزمایشی، پلاک ۱، واحد ۲', postalCode: '1234567890',
          },
          shippingMethodId: shippingMethod?.id ?? null,
        },
      });
      if (order.status !== 201) throw new Error(`order: ${order.status} ${JSON.stringify(order.body)}`);
      step(`سفارش آزمایشی ${order.body.reference ?? order.body.id} برای ${buyer.name} ثبت شد.`);
    }
  }

  /* -------------------------- invoices + ledger ---------------------------- */
  // Orders do not mint invoices by themselves in this codebase: finance issues them
  // (kind retail_sale, linked to the order) and then records the payment → journal entry.
  const orderRows = await pool.query(
    `SELECT o.id, o.reference, o.total_rial, o.shipping_rial, u.display_name AS buyer_name, u.email AS buyer_email
     FROM orders o JOIN users u ON u.id = o.buyer_id WHERE o.buyer_id = ANY($1::uuid[]) ORDER BY o.created_at`,
    [demoCustomers.map((buyer) => buyer.id)]);
  for (const order of orderRows.rows) {
    const existing = await pool.query('SELECT id FROM invoices WHERE order_id = $1', [order.id]);
    if (existing.rows[0]) continue;
    const created = await call(app, 'POST', '/api/v1/invoices', {
      token: adminToken,
      payload: {
        kind: 'retail_sale', orderId: order.id, paymentType: 'cash',
        buyer: { userId: demoCustomers.find((buyer) => buyer.email === order.buyer_email)?.id ?? customer.id,
          name: order.buyer_name ?? 'مشتری آزمایشی', phone: demoCustomers.find((buyer) => buyer.email === order.buyer_email)?.phone ?? '09120000001', address: 'نشانی آزمایشی' },
        seller: { name: 'کلبه وینتیج' },
        lines: [{ productName: `سفارش ${order.reference}`, quantity: 1, unitPriceRial: String(Number(order.total_rial) - Number(order.shipping_rial)) }],
        shippingRial: String(order.shipping_rial), status: 'issued',
      },
    });
    if (created.status !== 201) throw new Error(`invoice: ${created.status} ${JSON.stringify(created.body)}`);
    step(`فاکتور ${created.body.reference} برای سفارش ${order.reference} صادر شد.`);
  }

  const invoices = await call(app, 'GET', '/api/v1/invoices', { token: adminToken });
  let paidInvoices = 0;
  for (const invoice of (invoices.body?.items ?? []).slice(0, 5)) {
    if (invoice.status === 'paid' || invoice.remaining_rial === '0') continue;
    const payment = await call(app, 'POST', `/api/v1/invoices/${invoice.id}/payments`, {
      token: adminToken,
      payload: { amountRial: String(invoice.remaining_rial ?? invoice.total_rial), method: 'transfer', note: 'پرداخت نمونه seed:local' },
    });
    if (payment.status !== 201) throw new Error(`invoice payment: ${payment.status} ${JSON.stringify(payment.body)}`);
    paidInvoices += 1;
  }
  if (paidInvoices) step(`${paidInvoices} فاکتور پرداخت شد و اسناد دفتر کل ثبت شد.`);

  const orderList = await call(app, 'GET', '/api/v1/orders', { token: adminToken });
  let transitions = 0;
  for (const order of (orderList.body?.items ?? []).filter((entry: any) => entry.status === 'paid').slice(0, 2)) {
    const res = await call(app, 'POST', `/api/v1/orders/${order.id}/transitions`, {
      token: adminToken, payload: { status: 'processing', note: 'seed:local' },
    });
    if (res.status === 200) transitions += 1;
  }
  if (transitions) step(`${transitions} سفارش پرداخت‌شده به وضعیت «در حال پردازش» منتقل شد.`);

  const reviewCopy = [
    { title: 'دوخت تمیز و خوش‌فرم', comment: 'برش لباس مرتب است و پارچه حس خوبی دارد. راهنمای سایز برای انتخاب کمک کرد.', rating: 5 },
    { title: 'همان چیزی که انتظار داشتم', comment: 'رنگ و فرم لباس با عکس‌ها هماهنگ بود و بسته‌بندی با دقت انجام شده بود.', rating: 5 },
    { title: 'انتخاب مناسب برای استفادهٔ روزمره', comment: 'پارچه راحت است و با چند ترکیب مختلف به‌خوبی ست می‌شود.', rating: 4 },
    { title: 'کیفیت خوب پارچه', comment: 'جنس و دوخت خوب است؛ برای انتخاب سایز بهتر است اندازه‌های جدول را بررسی کنید.', rating: 4 },
  ];
  for (const [index, buyer] of demoCustomers.entries()) {
    const product = products[(index * 2) % products.length]!;
    const prior = await pool.query('SELECT id FROM customer_reviews WHERE user_id=$1 AND product_id=$2', [buyer.id, product.id]);
    if (prior.rows[0]) continue;
    const created = await call(app, 'POST', `/api/v1/products/${product.id}/reviews`, {
      token: buyer.token, payload: reviewCopy[index],
    });
    if (created.status !== 201) throw new Error(`review ${buyer.email}: ${created.status} ${JSON.stringify(created.body)}`);
    const approved = await call(app, 'POST', `/api/v1/admin/reviews/${created.body.id}/moderate`, {
      token: adminToken, payload: { action: 'approve', note: 'development demo content' },
    });
    if (approved.status !== 200) throw new Error(`review approval ${buyer.email}: ${approved.status} ${JSON.stringify(approved.body)}`);
    step(`نظر آزمایشی ${buyer.name} برای «${product.name}» ثبت شد.`);
  }

  /* ---------------------------- coupon + festival -------------------------- */
  const couponRes = await call(app, 'GET', '/api/v1/admin/coupons', { token: adminToken });
  if (!(couponRes.body?.items ?? []).some((coupon: any) => coupon.code === 'SEED15')) {
    const now = new Date();
    const endsAt = new Date(now.getTime() + 30 * 864e5).toISOString();
    const created = await call(app, 'POST', '/api/v1/admin/coupons', {
      token: adminToken,
      payload: {
        code: 'SEED15', campaignName: 'کمپین نمونه', type: 'percent', value: '15', minOrderRial: '0',
        audience: ['customer', 'vip'], scope: { productIds: [], categories: [] },
        startsAt: now.toISOString(), endsAt,
      },
    });
    if (created.status !== 201) throw new Error(`coupon: ${created.status} ${JSON.stringify(created.body)}`);
    step('کوپن نمونه SEED15 ساخته شد.');
  }
  const festivalsRes = await call(app, 'GET', '/api/v1/admin/festivals', { token: adminToken });
  if (!(festivalsRes.body?.items ?? []).some((festival: any) => festival.code === 'seed-festival')) {
    const now = new Date();
    const created = await call(app, 'POST', '/api/v1/admin/festivals', {
      token: adminToken,
      payload: {
        code: 'seed-festival', name: 'جشنواره نمونه پایان فصل', startsAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 14 * 864e5).toISOString(), discountPercent: 20,
        audience: ['customer'], scope: { productIds: [], categories: [] }, active: true,
        themePaletteCode: 'kolbe-default',
      },
    });
    if (created.status !== 201) throw new Error(`festival: ${created.status} ${JSON.stringify(created.body)}`);
    step('جشنواره نمونه ساخته شد.');
  }

  /* --------------------------------- CMS ---------------------------------- */
  const pages = await call(app, 'GET', '/api/v1/admin/cms/pages', { token: adminToken });
  if (!(pages.body?.items ?? []).some((page: any) => page.code === 'home')) {
    const bootstrap = await call(app, 'POST', '/api/v1/admin/cms/bootstrap', { token: adminToken });
    if (bootstrap.status !== 200) throw new Error(`cms bootstrap: ${bootstrap.status} ${JSON.stringify(bootstrap.body)}`);
    step(`صفحه اصلی + هیرو + ${bootstrap.body.sectionsCreated} بخش پایه ساخته شد.`);
  }
  const hero = await pool.query(`SELECT s.id,s.payload FROM cms_sections s JOIN cms_pages p ON p.id=s.page_id
    JOIN cms_components c ON c.id=s.component_id WHERE p.code='home' AND c.code='hero' ORDER BY s.position LIMIT 1`);
  if (hero.rows[0] && !hero.rows[0].payload?.image) {
    const updated = await call(app, 'PATCH', `/api/v1/admin/cms/sections/${hero.rows[0].id}`, {
      token: adminToken, payload: { payload: { ...hero.rows[0].payload, image: demoProducts[0].images[0] } },
    });
    if (updated.status !== 200) throw new Error(`home hero image: ${updated.status} ${JSON.stringify(updated.body)}`);
    step('تصویر هیرو صفحهٔ اصلی ثبت شد.');
  }
  const home=await pool.query("SELECT id FROM cms_pages WHERE code='home'");
  if(home.rows[0]) {const publication=await call(app,'POST',`/api/v1/admin/cms/pages/${home.rows[0].id}/publish`,{token:adminToken,payload:{changeSummary:'Demo fixture publication'}});if(publication.status!==200)throw new Error(`CMS demo publication: ${JSON.stringify(publication.body)}`);}
  const categories = await pool.query('SELECT id,slug,image_url,cover_url FROM cms_categories');
  let categoryImagesAdded = 0;
  for (const category of categories.rows) {
    const image = demoCategoryImages[category.slug];
    if (!image || category.image_url || category.cover_url) continue;
    const updated = await call(app, 'PATCH', `/api/v1/admin/cms/categories/${category.id}`, {
      token: adminToken, payload: { imageUrl: image, coverUrl: image },
    });
    if (updated.status !== 200) throw new Error(`category image ${category.slug}: ${updated.status} ${JSON.stringify(updated.body)}`);
    categoryImagesAdded += 1;
  }
  if (categoryImagesAdded) step(`تصویر ${categoryImagesAdded} دسته‌بندی پوشاک تکمیل شد.`);
  const existingArticles = await pool.query('SELECT slug FROM editorial_posts WHERE slug = ANY($1::text[])', [demoArticles.map((article) => article.slug)]);
  const existingSlugs = new Set(existingArticles.rows.map((row) => row.slug));
  for (const article of demoArticles) {
    if (existingSlugs.has(article.slug)) continue;
    const created = await call(app, 'POST', '/api/v1/admin/editorial', { token: adminToken, payload: {
      postType: 'article', slug: article.slug, title: article.title, excerpt: article.excerpt,
      body: article.body, coverUrl: article.cover, author: 'تحریریه کلبه',
      category: article.category, tags: [...article.tags], status: 'published',
      seoTitle: article.title, seoDescription: article.excerpt,
    } });
    if (created.status !== 201) throw new Error(`article ${article.slug}: ${created.status} ${JSON.stringify(created.body)}`);
    step(`مقالهٔ «${article.title}» منتشر شد.`);
  }
  // Sample announcement (dev data only) — migrations and the bootstrap never publish announcement copy.
  const announcements = await call(app, 'GET', '/api/v1/admin/cms/announcements', { token: adminToken });
  if (!(announcements.body?.items ?? []).some((row: any) => row.active)) {
    const created = await call(app, 'POST', '/api/v1/admin/cms/announcements', { token: adminToken, payload: {
      title: 'اعلان نمونه محیط توسعه', messages: [{ text: 'کالکشن تازه کلبه وینتیج را ببینید', link: 'shop', ctaLabel: 'مشاهده' }],
      mode: 'rotating', priority: 100, style: { backgroundColor: '#1B2A4A', textColor: '#F9F6F1' } } });
    if (created.status !== 201) throw new Error(`announcement: ${created.status} ${JSON.stringify(created.body)}`);
    step('اعلان نمونه ساخته شد.');
  }
  const palettes = await call(app, 'GET', '/api/v1/admin/cms/palettes', { token: adminToken });
  if (!(palettes.body?.items ?? []).length) {
    const created = await call(app, 'POST', '/api/v1/admin/cms/palettes/default', { token: adminToken });
    if (created.status !== 201 && created.status !== 200) throw new Error(`default palette: ${created.status} ${JSON.stringify(created.body)}`);
    step('پالت اصلی کلبه ساخته و فعال شد.');
  }

  /* ------------------------- notification + ticket ------------------------- */
  const notifications = await pool.query('SELECT count(*)::int AS count FROM notifications WHERE user_id = $1', [customer.id]);
  if (!notifications.rows[0]?.count) {
    const created = await call(app, 'POST', '/api/v1/admin/notifications', {
      token: adminToken,
      payload: { userId: customer.id, title: 'به کلبه وینتیج خوش آمدید', body: 'این اعلان نمونه با seed:local ساخته شده است.', priority: 'normal' },
    });
    if (created.status !== 201) throw new Error(`notification: ${created.status} ${JSON.stringify(created.body)}`);
    step('اعلان نمونه برای مشتری ثبت شد.');
  }
  const tickets = await call(app, 'GET', '/api/v1/tickets', { token: adminToken });
  if (!(tickets.body?.items ?? []).some((ticket: any) => String(ticket.subject).includes('[seed]'))) {
    const ticket = await call(app, 'POST', '/api/v1/tickets', {
      token: customerToken,
      payload: { subject: '[seed] پیگیری سفارش نمونه', category: 'پیگیری سفارش', priority: 'normal', message: 'این تیکت با seed:local ساخته شد.' },
    });
    if (ticket.status !== 201) throw new Error(`ticket: ${ticket.status} ${JSON.stringify(ticket.body)}`);
    const reply = await call(app, 'POST', `/api/v1/tickets/${ticket.body.id}/messages`, {
      token: adminToken, payload: { message: 'درخواست شما در حال بررسی است.', internal: false },
    });
    if (reply.status !== 201) throw new Error(`ticket reply: ${reply.status} ${JSON.stringify(reply.body)}`);
    step('تیکت نمونه + پاسخ کارشناس ثبت شد.');
  }

  console.log('\nSeed credentials:');
  console.log(`  admin    : ${adminEmail} / ${adminPassword}`);
  console.log(`  customer : ${customerEmail} / ${customerPassword}`);
  console.log(`  supplier : ${supplierEmail} / ${supplierPassword}`);
}

await main();
process.exit(0);
