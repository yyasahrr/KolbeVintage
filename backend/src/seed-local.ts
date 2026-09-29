/**
 * Explicit local development seed — `npm run seed:local`.
 *
 * Purpose: a fresh database can be explored end-to-end in the admin console and the
 * storefront without inventing data by hand.
 *
 * Guarantees:
 * - Runs ONLY when NODE_ENV=development (production/test refuse to run).
 * - Idempotent: every entity is looked up before it is created; re-running only fills gaps.
 * - Server-backed: every write goes through the real Fastify routes (validation, audit, ledger,
 *   WMS movements, CMS bootstrap), so the resulting rows are indistinguishable from UI-made ones.
 * - Never runs automatically: it is not imported by main.ts and is not part of `npm start`.
 */
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import type { DbPool } from './db.js';
import type { FastifyInstance } from 'fastify';

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

async function ensureUser(app: FastifyInstance, pool: DbPool, input: { email: string; password: string; displayName: string; phone: string }) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [input.email]);
  if (existing.rows[0]) return { id: existing.rows[0].id as string, created: false };
  const res = await call(app, 'POST', '/api/v1/auth/register', {
    payload: { email: input.email, phone: input.phone, password: input.password, displayName: input.displayName },
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`register ${input.email} failed: ${res.status} ${JSON.stringify(res.body)}`);
  const row = await pool.query('SELECT id FROM users WHERE email = $1', [input.email]);
  return { id: row.rows[0]?.id as string, created: res.status === 201 };
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
  const customer = await ensureUser(app, pool, { email: customerEmail, password: customerPassword, displayName: 'مشتری نمونه', phone: '09120000001' });
  if (customer.created) step(`مشتری نمونه ${customerEmail} ساخته شد.`);
  const customerToken = await login(app, customerEmail, customerPassword);

  /* ------------------------------- supplier ------------------------------- */
  const supplier = await ensureUser(app, pool, { email: supplierEmail, password: supplierPassword, displayName: 'تأمین‌کننده نمونه', phone: '09120000002' });
  if (supplier.created) step(`تأمین‌کننده ${supplierEmail} ساخته شد.`);
  const supplierProfile = await pool.query('SELECT cooperation_status FROM supplier_profiles WHERE user_id = $1', [supplier.id]);
  if (supplierProfile.rows[0]?.cooperation_status !== 'approved') {
    // Approval is two steps in the real flow: review the cooperation request (creates/links the
    // supplier identity) and then approve the supplier profile itself.
    const approvedRequest = await pool.query(`SELECT id FROM cooperation_requests WHERE user_id = $1 AND status = 'approved' LIMIT 1`, [supplier.id]);
    let requestId = approvedRequest.rows[0]?.id as string | undefined;
    if (!requestId) {
      const res = await call(app, 'POST', '/api/v1/cooperation-requests', {
        payload: {
          payload: {
            brand_name: 'پوشاک نمونه کویر', legal_name: 'شرکت پوشاک نمونه کویر', person_type: 'legal',
            national_id: '10101010101', phone: '03133333333', mobile: '09120000002',
            email: supplierEmail, office_address: 'اصفهان، خیابان نمونه، پلاک ۱۰', bank_name: 'بانک نمونه',
            iban: 'IR000000000000000000000000', account_holder: 'شرکت پوشاک نمونه کویر',
            product_categories: 'پوشاک', supply_capacity: '۱۰۰۰ تکه در ماه', lead_time_days: '7',
          },
        },
      });
      if (res.status !== 201) throw new Error(`cooperation request: ${res.status} ${JSON.stringify(res.body)}`);
      requestId = res.body.id;
      const review = await call(app, 'POST', `/api/v1/admin/cooperation-requests/${requestId}/review`, {
        token: adminToken, payload: { status: 'approved', note: 'seed:local' },
      });
      if (review.status !== 200 && review.status !== 201) throw new Error(`cooperation review: ${review.status} ${JSON.stringify(review.body)}`);
      step('درخواست همکاری تأمین‌کننده تأیید شد.');
    }
    const supplierStatus = await call(app, 'POST', `/api/v1/admin/suppliers/${supplier.id}/status`, {
      token: adminToken, payload: { status: 'approved', note: 'seed:local' },
    });
    if (supplierStatus.status !== 200) throw new Error(`supplier approve: ${supplierStatus.status} ${JSON.stringify(supplierStatus.body)}`);
    step('پروفایل تأمین‌کننده نمونه تأیید شد.');
  }

  /* -------------------------------- catalog ------------------------------- */
  const products: { id: string; name: string; variants: { id: string; sku: string; color: string | null; size: string | null }[] }[] = [];
  for (const definition of [
    { name: 'کت پشمی دکمه‌دار نمونه', category: 'کت', colors: ['مشکی', 'شنی'], sizes: ['M', 'L'], cash: '49000000', wholesale: '36000000' },
    { name: 'پیراهن نخی نمونه', category: 'پیراهن', colors: ['سفید'], sizes: ['S', 'M', 'L'], cash: '18500000', wholesale: '13000000' },
  ]) {
    const existing = await pool.query(`SELECT id FROM products WHERE name = $1 AND supplier_id IS NULL`, [definition.name]);
    let productId = existing.rows[0]?.id as string | undefined;
    if (!productId) {
      const variants = definition.colors.flatMap((color) => definition.sizes.map((size) => ({ color, size, attributes: {} })));
      const res = await call(app, 'POST', '/api/v1/products', {
        token: adminToken,
        payload: {
          brand: 'Kolbe', name: definition.name, category: definition.category,
          description: 'محصول نمونه ساخته‌شده با seed:local', cashPriceRial: definition.cash,
          wholesalePriceRial: definition.wholesale, variants,
          metadata: { images: [], channels: { retail: true, wholesale: true }, source: 'seed:local' },
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
  const customerOrders = await call(app, 'GET', '/api/v1/orders', { token: customerToken });
  if ((customerOrders.body?.items ?? []).length < 2) {
    const shippingMethods = await call(app, 'GET', '/api/v1/shipping-methods');
    const shippingMethod = (shippingMethods.body?.items ?? []).find((method: any) => method.type === 'standard') ?? shippingMethods.body?.items?.[0];
    const needed = 2 - (customerOrders.body?.items ?? []).length;
    for (let index = 0; index < needed; index += 1) {
      const product = products[index % products.length]!;
      const variant = product.variants[index % product.variants.length]!;
      const order = await call(app, 'POST', '/api/v1/orders', {
        token: customerToken, key: `seed-order-${product.id}-${index}`,
        payload: {
          orderType: 'retail', paymentMode: 'cash',
          items: [{ variantId: variant.id, quantity: 1 }],
          shippingAddress: {
            recipient: 'مشتری نمونه', phone: '09120000001', province: 'تهران', city: 'تهران',
            line: 'خیابان نمونه، پلاک ۱، واحد ۲', postalCode: '1234567890',
          },
          shippingMethodId: shippingMethod?.id ?? null,
        },
      });
      if (order.status !== 201) throw new Error(`order: ${order.status} ${JSON.stringify(order.body)}`);
      step(`سفارش ${order.body.reference ?? order.body.id} برای مشتری نمونه ثبت شد.`);
    }
  }

  /* -------------------------- invoices + ledger ---------------------------- */
  // Orders do not mint invoices by themselves in this codebase: finance issues them
  // (kind retail_sale, linked to the order) and then records the payment → journal entry.
  const orderRows = await pool.query(
    `SELECT o.id, o.reference, o.total_rial, o.shipping_rial, u.display_name AS buyer_name, u.email AS buyer_email
     FROM orders o JOIN users u ON u.id = o.buyer_id WHERE u.email = $1 ORDER BY o.created_at`, [customerEmail]);
  for (const order of orderRows.rows) {
    const existing = await pool.query('SELECT id FROM invoices WHERE order_id = $1', [order.id]);
    if (existing.rows[0]) continue;
    const created = await call(app, 'POST', '/api/v1/invoices', {
      token: adminToken,
      payload: {
        kind: 'retail_sale', orderId: order.id, paymentType: 'cash',
        buyer: { userId: customer.id, name: order.buyer_name ?? 'مشتری نمونه', phone: '09120000001', address: 'تهران، خیابان نمونه' },
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
