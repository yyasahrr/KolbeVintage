/** Prompt 5 — approved Supplier Portal + canonical OMS Supply Requests (P5-SUP-001…025).
 *  These integration gates deliberately exercise the existing OMS, supplier capacity authority,
 *  catalog, WMS, and audit/outbox. They do not introduce receiving/QC or Supplier Settlement flows.
 */
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
  NODE_ENV: 'test', PORT: 4045, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;
type Headers = Record<string, string>;
type Product = { id: string; templateId: string; variantIds: string[]; name: string };

const key = (prefix: string) => `${prefix}-${randomUUID()}`;

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `p5-${roles[0] ?? 'user'}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('P5-Test-Password-123456!', { type: argon2.argon2id }), label]);
  for (const role of roles) {
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  }
  return { id, email };
}

async function makeSupplier(pool: Pool, label: string, state: 'approved' | 'pending' | 'inactive' = 'approved') {
  const user = await makeUser(pool, ['supplier'], label);
  await pool.query('INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,$3)',
    [user.id, label, state === 'pending' ? 'pending' : 'approved']);
  if (state === 'inactive') await pool.query(
    "UPDATE supplier_profiles SET activity_status='suspended', activity_reason='P5 UAT' WHERE user_id=$1", [user.id]);
  return user;
}

async function login(app: App, email: string): Promise<Headers> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: email, password: 'P5-Test-Password-123456!' } });
  assert.equal(response.statusCode, 200, response.body);
  return { authorization: `Bearer ${response.json().accessToken as string}` };
}

async function makeBuyer(pool: Pool, label: string) {
  const user = await makeUser(pool, ['customer'], label);
  const planId = randomUUID();
  await pool.query("INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,'پلن P5',0,'{}')",
    [planId, key('p5-plan')]);
  await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at)
    VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`, [randomUUID(), user.id, planId]);
  return user;
}

async function makeProduct(pool: Pool, supplierId: string, name: string, status = 'published'): Promise<Product> {
  const id = randomUUID();
  await pool.query(`INSERT INTO products(id,supplier_id,brand,name,category,status,cash_price_rial,wholesale_price_rial,
      owner_type,retail_enabled,wholesale_enabled)
    VALUES ($1,$2,'برند آزمون P5',$3,'پیراهن', $4,50000000,20000000,'supplier',false,true)`,
    [id, supplierId, name, status]);
  const variants = [randomUUID(), randomUUID()];
  await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label)
    VALUES ($1,$2,$3,'M','آبی'),($4,$2,$5,'L','آبی')`,
    [variants[0], id, `P5-${id.slice(0, 8)}-M`, variants[1], `P5-${id.slice(0, 8)}-L`]);
  const templateId = randomUUID();
  await pool.query(`INSERT INTO series_templates(id,product_id,name,pricing_mode,total_price_rial,min_order_series)
    VALUES ($1,$2,'سری P5','series_total',20000000,1)`, [templateId, id]);
  await pool.query(`INSERT INTO series_template_items(id,series_template_id,variant_id,quantity_per_series)
    VALUES ($1,$2,$3,1),($4,$2,$5,1)`, [randomUUID(), templateId, variants[0], randomUUID(), variants[1]]);
  return { id, templateId, variantIds: variants, name };
}

async function makeOffer(pool: Pool, supplierId: string, product: Product, capacity = 100) {
  const id = randomUUID();
  await pool.query(`INSERT INTO supplier_offers(id,supplier_id,product_id,series_template_id,status,fulfillment_mode,
      wholesale_price_rial,min_order_series,max_order_series,declared_capacity,reserved_external,safety_buffer,capacity_confirmed_at)
    VALUES ($1,$2,$3,$4,'active','order_driven',20000000,1,100,$5,0,0,now())`,
    [id, supplierId, product.id, product.templateId, capacity]);
  return id;
}

async function makeWarehouse(pool: Pool) {
  const id = randomUUID();
  await pool.query("INSERT INTO warehouses(id,code,name,purpose) VALUES ($1,$2,'انبار مرکزی عمده P5','wholesale')",
    [id, key('P5-WH')]);
  return id;
}

async function seedSupplierStock(pool: Pool, supplierId: string, product: Product, warehouseId: string,
  onHand: number, reserved: number, damaged: number) {
  await pool.query(`INSERT INTO series_stock_balances(id,series_template_id,warehouse_id,owner_type,supplier_id,on_hand,reserved,damaged)
    VALUES ($1,$2,$3,'supplier',$4,$5,$6,$7)`,
    [randomUUID(), product.templateId, warehouseId, supplierId, onHand, reserved, damaged]);
}

async function createMaster(app: App, pool: Pool, headers: Headers, product: Product, count: number) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
    headers: { ...headers, 'idempotency-key': key('p5-master') }, payload: { items: [{ seriesTemplateId: product.templateId, count }] } });
  assert.equal(response.statusCode, 201, response.body);
  const child = response.json().children[0] as { id: string; reference: string; paymentEligibility: string };
  const line = await pool.query<{ id: string }>('SELECT id FROM child_order_lines WHERE child_order_id=$1', [child.id]);
  const allocation = await pool.query<{ id: string; quantity: number }>(
    "SELECT id,quantity FROM order_source_allocations WHERE child_order_id=$1 AND source_type='supplier_external'", [child.id]);
  assert.equal(line.rows.length, 1);
  assert.equal(allocation.rows.length, 1);
  return { id: response.json().id as string, child, lineId: line.rows[0]!.id,
    allocationId: allocation.rows[0]!.id, allocationQuantity: allocation.rows[0]!.quantity };
}

async function payChild(app: App, pool: Pool, headers: Headers, childId: string) {
  const intent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/payment-intent`, headers });
  assert.equal(intent.statusCode, 201, intent.body);
  await applyVerifiedPayment(pool, {
    provider: 'nextpay', providerEventId: key('p5-event'), providerReference: key('p5-ref'),
    intentId: intent.json().intentId as string, amountRial: intent.json().amountRial as string, paidAt: new Date(),
  });
}

/* Each nested gate carries its P5-SUP ID so a fresh embedded test run yields a traceable result. */
test('P5-SUP-001…025 — approved Supplier portal, canonical OMS lifecycle, privacy and WMS separation', { skip: !enabled }, async (t) => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const supplierA = await makeSupplier(pool, `تأمین‌کننده A ${randomUUID().slice(0, 6)}`);
    const supplierB = await makeSupplier(pool, `تأمین‌کننده B ${randomUUID().slice(0, 6)}`);
    const pendingSupplier = await makeSupplier(pool, `متقاضی ${randomUUID().slice(0, 6)}`, 'pending');
    const inactiveSupplier = await makeSupplier(pool, `غیرفعال ${randomUUID().slice(0, 6)}`, 'inactive');
    const buyer = await makeBuyer(pool, `خریدار VIP ${randomUUID().slice(0, 6)}`);
    const ops = await makeUser(pool, ['operations'], `عملیات P5 ${randomUUID().slice(0, 6)}`);
    const aHeaders = await login(app, supplierA.email);
    const bHeaders = await login(app, supplierB.email);
    const pendingHeaders = await login(app, pendingSupplier.email);
    const inactiveHeaders = await login(app, inactiveSupplier.email);
    const buyerHeaders = await login(app, buyer.email);
    const opsHeaders = await login(app, ops.email);
    const productA = await makeProduct(pool, supplierA.id, `محصول تأمین A ${randomUUID().slice(0, 6)}`);
    const productAPending = await makeProduct(pool, supplierA.id, `پیش‌نویس تأمین A ${randomUUID().slice(0, 6)}`, 'pending');
    const productB = await makeProduct(pool, supplierB.id, `محصول تأمین B ${randomUUID().slice(0, 6)}`);
    const pendingProduct = await makeProduct(pool, pendingSupplier.id, `محصول حساب در انتظار ${randomUUID().slice(0, 6)}`);
    const offerA = await makeOffer(pool, supplierA.id, productA, 100);
    const offerB = await makeOffer(pool, supplierB.id, productB, 100);
    // The second offer is an explicit ops-approved substitute for the same canonical series.
    const crossOffer = await makeOffer(pool, supplierB.id, productA, 100);
    const warehouseId = await makeWarehouse(pool);

    // Seed OMS demand before physical stock: this case must remain an external-capacity allocation.
    const main = await createMaster(app, pool, buyerHeaders, productA, 5);
    const otherSupplierOrder = await createMaster(app, pool, buyerHeaders, productB, 2);
    const counterOrder = await createMaster(app, pool, buyerHeaders, productA, 4);
    const cancelOrder = await createMaster(app, pool, buyerHeaders, productA, 3);
    const reassignOrder = await createMaster(app, pool, buyerHeaders, productA, 2);
    await seedSupplierStock(pool, supplierA.id, productA, warehouseId, 5, 1, 1);
    await seedSupplierStock(pool, supplierB.id, productB, warehouseId, 7, 1, 0);
    const stockBefore = await pool.query<{ on_hand: number; reserved: number; damaged: number }>(
      'SELECT on_hand,reserved,damaged FROM series_stock_balances WHERE series_template_id=$1 AND supplier_id=$2',
      [productA.templateId, supplierA.id]);
    const supplierWalletBefore = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM wallet_entries e JOIN wallet_accounts a ON a.id=e.account_id WHERE a.owner_id=$1', [supplierA.id]);

    await t.test('P5-SUP-001 — unauthenticated and pending applicants have no operational portal access', async () => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/dashboard' });
      assert.equal(anonymous.statusCode, 401);
      const pending = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/dashboard', headers: pendingHeaders });
      assert.equal(pending.statusCode, 403);
      const pendingOffers = await app.inject({ method: 'GET', url: '/api/v1/supplier/offers', headers: pendingHeaders });
      assert.equal(pendingOffers.statusCode, 403);
      const pendingCreate = await app.inject({ method: 'POST', url: '/api/v1/products', headers: pendingHeaders,
        payload: { saveIntent: 'draft', brand: 'متقاضی', name: 'محصول متقاضی', category: `P5-${randomUUID()}`,
          cashPriceRial: '0', variants: [] } });
      assert.equal(pendingCreate.statusCode, 403, pendingCreate.body);
      const pendingUpdate = await app.inject({ method: 'PATCH', url: `/api/v1/products/${pendingProduct.id}`,
        headers: pendingHeaders, payload: { name: 'تغییر غیرمجاز' } });
      assert.equal(pendingUpdate.statusCode, 403, pendingUpdate.body);
      const pendingVariants = await app.inject({ method: 'POST', url: `/api/v1/products/${pendingProduct.id}/variants`,
        headers: pendingHeaders, payload: { size: 'XL', color: 'سبز' } });
      assert.equal(pendingVariants.statusCode, 403, pendingVariants.body);
      const pendingVariantEdit = await app.inject({ method: 'PATCH',
        url: `/api/v1/products/${pendingProduct.id}/variants/${pendingProduct.variantIds[0]}`,
        headers: pendingHeaders, payload: { weightGrams: 250 } });
      assert.equal(pendingVariantEdit.statusCode, 403, pendingVariantEdit.body);

      const pendingSupplierProducts = await app.inject({ method: 'GET', url: '/api/v1/supplier/products', headers: pendingHeaders });
      assert.equal(pendingSupplierProducts.statusCode, 403, pendingSupplierProducts.body);
      const pendingSpecs = await app.inject({ method: 'PUT', url: `/api/v1/products/${pendingProduct.id}/specs`,
        headers: pendingHeaders, payload: { values: [] } });
      assert.equal(pendingSpecs.statusCode, 403, pendingSpecs.body);
      const pendingSeriesCreate = await app.inject({ method: 'POST', url: '/api/v1/series-templates',
        headers: pendingHeaders, payload: {} });
      assert.equal(pendingSeriesCreate.statusCode, 403, pendingSeriesCreate.body);
      const pendingWarehouseList = await app.inject({ method: 'GET', url: '/api/v1/warehouses', headers: pendingHeaders });
      assert.equal(pendingWarehouseList.statusCode, 403, pendingWarehouseList.body);
      const pendingWms = await app.inject({ method: 'GET', url: '/api/v1/inventory', headers: pendingHeaders });
      assert.equal(pendingWms.statusCode, 403, pendingWms.body);
      const pendingLegacyFulfillments = await app.inject({ method: 'GET', url: '/api/v1/wholesale/fulfillments', headers: pendingHeaders });
      assert.equal(pendingLegacyFulfillments.statusCode, 403, pendingLegacyFulfillments.body);
      const pendingLegacyShipments = await app.inject({ method: 'GET', url: '/api/v1/wholesale/inbound-shipments', headers: pendingHeaders });
      assert.equal(pendingLegacyShipments.statusCode, 403, pendingLegacyShipments.body);
    });

    await t.test('P5-SUP-002 — approved but inactive supplier is denied by the server on every operational route', async () => {
      const dashboard = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/dashboard', headers: inactiveHeaders });
      assert.equal(dashboard.statusCode, 403);
      const products = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/products', headers: inactiveHeaders });
      assert.equal(products.statusCode, 403, products.body);
      const history = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/history', headers: inactiveHeaders });
      assert.equal(history.statusCode, 403, history.body);
      const offers = await app.inject({ method: 'GET', url: '/api/v1/supplier/offers', headers: inactiveHeaders });
      assert.equal(offers.statusCode, 403, offers.body);
      const stock = await app.inject({ method: 'GET', url: '/api/v1/admin/supplier-stock?limit=100', headers: inactiveHeaders });
      assert.equal(stock.statusCode, 403, stock.body);
      const childOrders = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/child-orders', headers: inactiveHeaders });
      assert.equal(childOrders.statusCode, 403, childOrders.body);
      const requests = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests', headers: inactiveHeaders });
      assert.equal(requests.statusCode, 403, requests.body);
    });

    await t.test('P5-SUP-003 — only approved active supplier identity reaches the server-backed dashboard', async () => {
      const dashboard = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/dashboard', headers: aHeaders });
      assert.equal(dashboard.statusCode, 200, dashboard.body);
      assert.equal(dashboard.json().supplier.id, supplierA.id);
      assert.equal(dashboard.json().supplier.cooperationStatus, 'approved');
      assert.equal(dashboard.json().supplier.activityStatus, 'active');
      assert.equal(dashboard.json().supplier.brandName, (await pool.query('SELECT brand_name FROM supplier_profiles WHERE user_id=$1', [supplierA.id])).rows[0].brand_name);
    });

    await t.test('P5-SUP-004 — dashboard aggregates real product, OMS and capacity records (not demo data)', async () => {
      const dashboard = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/dashboard', headers: aHeaders });
      const data = dashboard.json();
      assert.equal(data.products.total, 2);
      assert.equal(data.products.published, 1);
      assert.equal(data.products.pending, 1);
      assert.equal(data.supplyRequests.open, 4);
      assert.equal(data.capacity.declared, 100);
      assert.equal(data.capacity.reserved, 0);
      assert.equal(data.capacity.availableToRequest, 100);
      assert.equal(data.stockAtKolbeSeries, 3);
    });

    await t.test('P5-SUP-005 — product and series catalogue includes own pending items but excludes every other supplier', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/products', headers: aHeaders });
      assert.equal(result.statusCode, 200, result.body);
      const ids = (result.json().items as Array<{ id: string; status: string; series: unknown[] }>).map((row) => row.id);
      assert.ok(ids.includes(productA.id));
      assert.ok(ids.includes(productAPending.id));
      assert.ok(!ids.includes(productB.id));
      assert.ok(!result.body.includes(supplierB.id));
      const rows = result.json().items as Array<{ id: string; status: string; colors: string[]; sizes: string[];
        series: Array<{ id: string; items: Array<{ size: string; quantityPerSeries: number }> }> }>;
      const pending = rows.find((row) => row.id === productAPending.id)!;
      assert.equal(pending.status, 'pending');
      const own = rows.find((row) => row.id === productA.id)!;
      assert.deepEqual(own.colors, ['آبی']);
      assert.deepEqual(own.sizes.sort(), ['L', 'M']);
      assert.deepEqual(own.series[0]!.items.map((item) => [item.size, item.quantityPerSeries]), [['L', 1], ['M', 1]]);

      // Approved Suppliers can create scoped wholesale products/series through the canonical catalog writer.
      const category = `دسته آزمایشی P5 ${randomUUID().slice(0, 6)}`;
      const supplierImage = await app.inject({ method: 'POST', url: '/api/v1/files', headers: aHeaders, payload: {
        originalName: 'p5-supplier-product.png', mime: 'image/png',
        dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      } });
      assert.equal(supplierImage.statusCode, 201, supplierImage.body);
      const supplierImageId = supplierImage.json().id as string;
      const createKey = key('p5-supplier-product');
      const productPayload = {
        saveIntent: 'draft', brand: 'برند تأمین P5', name: `محصول جدید ${randomUUID().slice(0, 6)}`,
        category, description: 'ثبت محصول برای بازبینی', cashPriceRial: '0', wholesalePriceRial: '10000000',
        metadata: { images: [{ fileId: supplierImageId, url: 'blob:temporary-preview' }] },
        retailEnabled: false, wholesaleEnabled: true,
        variants: [{ color: 'بنفش', size: 'M' }, { color: 'بنفش', size: 'L' }],
        wholesaleSeries: [{ name: 'سری بنفش', color: 'بنفش', active: true, pricingMode: 'series_total',
          totalPriceRial: '20000000', minOrderSeries: 1,
          items: [{ size: 'M', quantityPerSeries: 1 }, { size: 'L', quantityPerSeries: 1 }] }],
      };
      const created = await app.inject({ method: 'POST', url: '/api/v1/products',
        headers: { ...aHeaders, 'idempotency-key': createKey }, payload: productPayload });
      assert.equal(created.statusCode, 201, created.body);
      const replay = await app.inject({ method: 'POST', url: '/api/v1/products',
        headers: { ...aHeaders, 'idempotency-key': createKey }, payload: productPayload });
      assert.equal(replay.statusCode, 201, replay.body);
      assert.equal(replay.json().id, created.json().id);
      const authoredId = created.json().id as string;
      const authored = await pool.query<{ status: string; owner_type: string; supplier_id: string; retail_enabled: boolean; wholesale_enabled: boolean }>(
        'SELECT status,owner_type,supplier_id,retail_enabled,wholesale_enabled FROM products WHERE id=$1', [authoredId]);
      assert.deepEqual(authored.rows[0], { status: 'pending', owner_type: 'supplier', supplier_id: supplierA.id,
        retail_enabled: false, wholesale_enabled: true });
      const persistedImage = await pool.query<{ metadata: { images: { fileId: string; url: string }[] } }>(
        'SELECT metadata FROM products WHERE id=$1', [authoredId]);
      assert.deepEqual(persistedImage.rows[0]!.metadata.images, [{
        fileId: supplierImageId, url: `/api/v1/product-media/${supplierImageId}`,
      }], 'Supplier product creation attaches the Supplier-owned server file, never the temporary preview URL');
      const unpublishedMedia = await app.inject({ method: 'GET', url: `/api/v1/product-media/${supplierImageId}` });
      assert.equal(unpublishedMedia.statusCode, 404, 'pending product media is not public before catalog review');
      const privateMedia = await app.inject({ method: 'GET', url: `/api/v1/files/${supplierImageId}`, headers: aHeaders });
      assert.equal(privateMedia.statusCode, 200, privateMedia.body);
      const template = await pool.query<{ id: string }>('SELECT id FROM series_templates WHERE product_id=$1', [authoredId]);
      assert.equal(template.rows.length, 1);
      const updateKey = key('p5-supplier-series-update');
      const updatePayload = { wholesalePriceRial: '11000000', wholesaleSeries: [{
        id: template.rows[0]!.id, name: 'سری بنفش', color: 'بنفش', active: true, pricingMode: 'series_total',
        totalPriceRial: '22000000', minOrderSeries: 2,
        items: [{ size: 'M', quantityPerSeries: 1 }, { size: 'L', quantityPerSeries: 1 }],
      }] };
      const updated = await app.inject({ method: 'PATCH', url: `/api/v1/products/${authoredId}`,
        headers: { ...aHeaders, 'idempotency-key': updateKey }, payload: updatePayload });
      assert.equal(updated.statusCode, 200, updated.body);
      const updateReplay = await app.inject({ method: 'PATCH', url: `/api/v1/products/${authoredId}`,
        headers: { ...aHeaders, 'idempotency-key': updateKey }, payload: updatePayload });
      assert.equal(updateReplay.statusCode, 200, updateReplay.body);
      assert.deepEqual(updateReplay.json(), updated.json());
      const persistedSeries = await pool.query<{ min_order_series: number; total_price_rial: string }>(
        'SELECT min_order_series,total_price_rial::text FROM series_templates WHERE product_id=$1', [authoredId]);
      assert.deepEqual(persistedSeries.rows[0], { min_order_series: 2, total_price_rial: '22000000' });
      const productStock = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM series_stock_balances WHERE series_template_id=$1', [template.rows[0]!.id]);
      assert.equal(productStock.rows[0]!.n, 0);
    });

    await t.test('P5-SUP-006 — WMS stock view is tenant-scoped and available quantity excludes reserved/damaged stock', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/v1/admin/supplier-stock?limit=100', headers: aHeaders });
      assert.equal(result.statusCode, 200, result.body);
      const rows = result.json().items as Array<{ supplier_id: string; series_template_id: string; on_hand: number; reserved: number; damaged: number; available: number }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.supplier_id, supplierA.id);
      assert.equal(rows[0]!.series_template_id, productA.templateId);
      assert.deepEqual([rows[0]!.on_hand, rows[0]!.reserved, rows[0]!.damaged, rows[0]!.available], [5, 1, 1, 3]);
      assert.ok(!result.body.includes(supplierB.id));
    });

    await t.test('P5-SUP-007 — offers/capacity stay on the existing supplier offer authority', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/v1/supplier/offers', headers: aHeaders });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual((result.json().items as Array<{ id: string }>).map((row) => row.id), [offerA]);
      assert.ok(!result.body.includes(offerB));
      assert.ok(!result.body.includes(crossOffer));
      const otherSupplier = await app.inject({ method: 'GET', url: '/api/v1/supplier/offers', headers: bHeaders });
      assert.ok((otherSupplier.json().items as Array<{ id: string }>).some((row) => row.id === offerB));
    });

    await t.test('P5-SUP-008 — legacy replenishment/new-product request surface remains available and scoped', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/v1/supplier-requests', headers: aHeaders });
      assert.equal(result.statusCode, 200, result.body);
      assert.ok(Array.isArray(result.json().items));
      assert.ok(!result.body.includes(supplierB.id));
    });

    await t.test('P5-SUP-009 — child-order read model remains buyer-private and Supplier-owned', async () => {
      const result = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/child-orders', headers: aHeaders });
      assert.equal(result.statusCode, 200, result.body);
      assert.ok((result.json().items as Array<{ id: string }>).some((row) => row.id === main.child.id));
      assert.ok(!(result.json().items as Array<{ id: string }>).some((row) => row.id === otherSupplierOrder.child.id));
      assert.ok(!result.body.includes(buyer.email));
      for (const forbiddenField of ['shipping_address', 'shippingAddress', 'phone', 'email', 'buyer_id', 'buyerId']) {
        assert.ok(!result.body.includes(`"${forbiddenField}"`), `supplier response leaked ${forbiddenField}`);
      }
    });

    await t.test('P5-SUP-010 — OMS request list and history include only the caller’s own canonical allocations', async () => {
      const open = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests?state=open', headers: aHeaders });
      assert.equal(open.statusCode, 200, open.body);
      const allocations = (open.json().items as Array<{ allocationId: string }>).map((row) => row.allocationId);
      assert.ok(allocations.includes(main.allocationId));
      assert.ok(allocations.includes(counterOrder.allocationId));
      assert.ok(allocations.includes(reassignOrder.allocationId));
      assert.ok(!allocations.includes(otherSupplierOrder.allocationId));
      const history = await app.inject({ method: 'GET', url: '/api/v1/supplier/portal/history', headers: aHeaders });
      assert.equal(history.statusCode, 200, history.body);
      assert.ok((history.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === main.allocationId));
      assert.ok(!(history.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === otherSupplierOrder.allocationId));
      assert.ok(!history.body.includes(buyer.email));
    });

    await t.test('P5-SUP-011 — a supplier cannot read or answer another supplier’s allocation', async () => {
      const foreignRead = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests?state=all', headers: aHeaders });
      assert.ok(!(foreignRead.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === otherSupplierOrder.allocationId));
      const foreignResponse = await app.inject({ method: 'POST',
        url: `/api/v1/wholesale/supplier/supply-requests/${otherSupplierOrder.allocationId}/respond`, headers: aHeaders,
        payload: { action: 'confirm' } });
      assert.equal(foreignResponse.statusCode, 404);
      const ownResponse = await app.inject({ method: 'GET', url: `/api/v1/wholesale/supplier/supply-requests?state=all`, headers: bHeaders });
      assert.ok((ownResponse.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === otherSupplierOrder.allocationId));
    });

    const confirmPayload = { action: 'confirm' as const, note: 'توان تأمین کامل تأیید شد' };
    const confirmKey = key('p5-confirm');
    await t.test('P5-SUP-012 — full acceptance atomically reserves declared capacity in the canonical OMS allocation', async () => {
      const response = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/respond`,
        headers: { ...aHeaders, 'idempotency-key': confirmKey }, payload: confirmPayload });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().responseStatus, 'accepted');
      assert.equal(response.json().child.paymentEligibility, 'ready');
      const allocation = await pool.query('SELECT status,capacity_reservation_id,reservation_expires_at FROM order_source_allocations WHERE id=$1', [main.allocationId]);
      assert.equal(allocation.rows[0].status, 'reserved');
      assert.ok(allocation.rows[0].capacity_reservation_id);
      assert.equal(allocation.rows[0].reservation_expires_at, null);
      const offer = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id=$1', [offerA]);
      assert.equal(offer.rows[0].reserved_external, 5);
    });

    await t.test('P5-SUP-013 — response idempotency is actor- and payload-bound (same request replays, mutation conflicts)', async () => {
      const replay = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/respond`,
        headers: { ...aHeaders, 'idempotency-key': confirmKey }, payload: confirmPayload });
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().responseStatus, 'accepted');
      const mismatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/respond`,
        headers: { ...aHeaders, 'idempotency-key': confirmKey }, payload: { action: 'reject', note: 'تغییر payload با همان کلید' } });
      assert.equal(mismatch.statusCode, 409, mismatch.body);
      const offer = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id=$1', [offerA]);
      assert.equal(offer.rows[0].reserved_external, 5, 'replay did not double-reserve capacity');
    });

    await t.test('P5-SUP-014 — acceptance never writes physical WMS stock; OMS reservation stays durable and auditable', async () => {
      const after = await pool.query<{ on_hand: number; reserved: number; damaged: number }>(
        'SELECT on_hand,reserved,damaged FROM series_stock_balances WHERE series_template_id=$1 AND supplier_id=$2',
        [productA.templateId, supplierA.id]);
      assert.deepEqual(after.rows[0], stockBefore.rows[0]);
      const reservation = await pool.query<{ status: string; reference_type: string; expires_at: Date | null }>(
        'SELECT status,reference_type,expires_at FROM supplier_capacity_reservations WHERE id=(SELECT capacity_reservation_id FROM order_source_allocations WHERE id=$1)',
        [main.allocationId]);
      assert.deepEqual(reservation.rows[0], { status: 'active', reference_type: 'order_source_allocation', expires_at: null });
      const audit = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='wholesale_supplier.confirm' AND resource_type='child_order_line'");
      assert.ok(audit.rows[0].n >= 1);
      const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='child_order.supplier_confirm' AND aggregate_id=$1", [main.child.id]);
      assert.equal(outbox.rows[0].n, 1);
    });

    await t.test('P5-SUP-015 — partial/revised response remains attached to OMS and buyer acceptance reuses capacity reservation authority', async () => {
      const counter = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${counterOrder.allocationId}/respond`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-counter') }, payload: { action: 'counter', proposedSeries: 2, note: 'دو سری قابل تأمین است' } });
      assert.equal(counter.statusCode, 200, counter.body);
      assert.equal(counter.json().responseStatus, 'revised');
      assert.equal(counter.json().child.paymentEligibility, 'blocked_buyer_decision');
      const decision = await app.inject({ method: 'POST', url: `/api/v1/wholesale/lines/${counterOrder.lineId}/decision`,
        headers: buyerHeaders, payload: { action: 'accept_counter' } });
      assert.equal(decision.statusCode, 200, decision.body);
      const line = await pool.query('SELECT requested_series,proposed_series,confirmed_series,supplier_response_status FROM child_order_lines WHERE id=$1', [counterOrder.lineId]);
      assert.equal(line.rows[0].requested_series, 4);
      assert.equal(line.rows[0].proposed_series, 2);
      assert.equal(line.rows[0].confirmed_series, 2);
      assert.equal(line.rows[0].supplier_response_status, 'accepted');
      const allocation = await pool.query('SELECT quantity,status,capacity_reservation_id FROM order_source_allocations WHERE id=$1', [counterOrder.allocationId]);
      assert.equal(allocation.rows[0].quantity, 2);
      assert.equal(allocation.rows[0].status, 'reserved');
      assert.ok(allocation.rows[0].capacity_reservation_id);
      const offer = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id=$1', [offerA]);
      assert.equal(offer.rows[0].reserved_external, 7);
    });

    await t.test('P5-SUP-016 — Admin Master Order keeps one canonical order and projects sourcing lifecycle; VIP gets no topology', async () => {
      const ops = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${main.id}`, headers: opsHeaders });
      assert.equal(ops.statusCode, 200, ops.body);
      assert.equal(ops.json().view, 'ops');
      const projected = (ops.json().children as Array<{ lines: Array<{ allocations: Array<Record<string, unknown>> }> }>)[0]!
        .lines[0]!.allocations[0]!;
      assert.equal(projected.supplier_response_status, 'accepted');
      assert.equal(projected.supplier_committed_series, 0);
      const buyerView = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${main.id}`, headers: buyerHeaders });
      assert.equal(buyerView.statusCode, 200, buyerView.body);
      assert.equal(buyerView.json().view, 'buyer');
      for (const privateValue of [supplierA.id, supplierB.id, offerA, crossOffer, 'supplier_external', 'order_source_allocations']) {
        assert.ok(!buyerView.body.includes(privateValue), `buyer projection leaked ${privateValue}`);
      }
      assert.ok(!buyerView.body.includes(buyer.email));
      const masters = await pool.query('SELECT count(*)::int AS n FROM master_orders WHERE buyer_id=$1', [buyer.id]);
      assert.equal(masters.rows[0].n, 5, 'the buyer still has one Master Order per checkout; suppliers do not create shadow orders');
    });

    const commitKey = key('p5-commit');
    await t.test('P5-SUP-017 — commitment is server-gated and idempotent without a second capacity reservation', async () => {
      const commit = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/commit`,
        headers: { ...aHeaders, 'idempotency-key': commitKey }, payload: { note: 'تعهد نهایی' } });
      assert.equal(commit.statusCode, 200, commit.body);
      assert.equal(commit.json().responseStatus, 'committed');
      assert.equal(commit.json().committedSeries, 5);
      const replay = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/commit`,
        headers: { ...aHeaders, 'idempotency-key': commitKey }, payload: { note: 'تعهد نهایی' } });
      assert.equal(replay.statusCode, 200, replay.body);
      const offer = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id=$1', [offerA]);
      assert.equal(offer.rows[0].reserved_external, 7);
      const line = await pool.query('SELECT supplier_committed_series,supplier_committed_at FROM child_order_lines WHERE id=$1', [main.lineId]);
      assert.equal(line.rows[0].supplier_committed_series, 5);
      assert.ok(line.rows[0].supplier_committed_at);
    });

    await t.test('P5-SUP-018 — readiness is blocked until the VIP child is paid', async () => {
      const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/ready`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-ready-early') }, payload: {} });
      assert.equal(ready.statusCode, 409, ready.body);
    });

    await t.test('P5-SUP-019 — payment is the canonical OMS child transition; it does not create supplier settlement', async () => {
      await payChild(app, pool, buyerHeaders, main.child.id);
      const child = await pool.query('SELECT status,payment_eligibility,child_fulfillment FROM orders WHERE id=$1', [main.child.id]);
      assert.deepEqual(child.rows[0], { status: 'paid', payment_eligibility: 'paid', child_fulfillment: 'preparing' });
    });

    await t.test('P5-SUP-020 — Supplier cannot dispatch an accepted/committed allocation before the readiness transition', async () => {
      const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${main.child.id}/dispatch`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-dispatch-before-ready') }, payload: {} });
      assert.equal(dispatch.statusCode, 409, dispatch.body);
      const allocation = await pool.query('SELECT dispatched_series FROM order_source_allocations WHERE id=$1', [main.allocationId]);
      assert.equal(allocation.rows[0].dispatched_series, 0);
    });

    await t.test('P5-SUP-021 — readiness is explicit/audited and leaves physical inventory untouched', async () => {
      const ready = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${main.allocationId}/ready`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-ready') }, payload: { note: 'آماده ارسال به انبار مرکزی کلبه' } });
      assert.equal(ready.statusCode, 200, ready.body);
      assert.equal(ready.json().responseStatus, 'ready');
      assert.equal(ready.json().inventoryChanged, false);
      const after = await pool.query('SELECT on_hand,reserved,damaged FROM series_stock_balances WHERE series_template_id=$1 AND supplier_id=$2',
        [productA.templateId, supplierA.id]);
      assert.deepEqual(after.rows[0], stockBefore.rows[0]);
      const allocation = await pool.query('SELECT supplier_ready_at FROM child_order_lines WHERE id=$1', [main.lineId]);
      assert.ok(allocation.rows[0].supplier_ready_at);
    });

    await t.test('P5-SUP-022 — client cannot select a buyer/warehouse; dispatch goes only to the server-resolved Kolbe warehouse', async () => {
      const spoof = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${main.child.id}/dispatch`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-spoof') }, payload: { destinationWarehouseId: randomUUID(), buyerId: buyer.id } });
      assert.equal(spoof.statusCode, 400, spoof.body);
      const dispatchKey = key('p5-dispatch');
      const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${main.child.id}/dispatch`,
        headers: { ...aHeaders, 'idempotency-key': dispatchKey }, payload: { trackingNote: 'باربری نمونه' } });
      assert.equal(dispatch.statusCode, 200, dispatch.body);
      const central = await pool.query<{ id: string }>(
        "SELECT id FROM warehouses WHERE active=true AND owner_id IS NULL AND purpose IN ('wholesale','mixed') ORDER BY (purpose='wholesale') DESC, created_at ASC LIMIT 1");
      assert.ok(dispatch.json().destinationWarehouseId);
      assert.equal(dispatch.json().destinationWarehouseId, central.rows[0]!.id, 'destination is selected by the server from Kolbe central warehouses');
      const replay = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${main.child.id}/dispatch`,
        headers: { ...aHeaders, 'idempotency-key': dispatchKey }, payload: { trackingNote: 'باربری نمونه' } });
      assert.equal(replay.statusCode, 200, replay.body);
      const mismatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${main.child.id}/dispatch`,
        headers: { ...aHeaders, 'idempotency-key': dispatchKey }, payload: { trackingNote: 'payload دیگر' } });
      assert.equal(mismatch.statusCode, 409, mismatch.body);
      const allocation = await pool.query('SELECT dispatched_series,warehouse_id FROM order_source_allocations WHERE id=$1', [main.allocationId]);
      assert.equal(allocation.rows[0].dispatched_series, 5);
      assert.equal(allocation.rows[0].warehouse_id, dispatch.json().destinationWarehouseId, 'the OMS stores only the server-resolved Kolbe destination');
    });

    await t.test('P5-SUP-023 — OMS dispatch never increases on-hand, received, QC or supplier-stock balances', async () => {
      const after = await pool.query<{ on_hand: number; reserved: number; damaged: number }>(
        'SELECT on_hand,reserved,damaged FROM series_stock_balances WHERE series_template_id=$1 AND supplier_id=$2',
        [productA.templateId, supplierA.id]);
      assert.deepEqual(after.rows[0], stockBefore.rows[0]);
      const line = await pool.query('SELECT received_series,qc_passed_series,qc_rejected_series FROM child_order_lines WHERE id=$1', [main.lineId]);
      assert.deepEqual(line.rows[0], { received_series: 0, qc_passed_series: 0, qc_rejected_series: 0 });
      const capacity = await pool.query('SELECT status FROM supplier_capacity_reservations WHERE id=(SELECT capacity_reservation_id FROM order_source_allocations WHERE id=$1)', [main.allocationId]);
      assert.equal(capacity.rows[0].status, 'consumed');
    });

    await t.test('P5-SUP-024 — cancellation preserves unresolved OMS demand; reassignment creates one replacement, never duplicate demand', async () => {
      const accepted = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${cancelOrder.allocationId}/respond`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-cancel-accept') }, payload: { action: 'confirm' } });
      assert.equal(accepted.statusCode, 200, accepted.body);
      const cancel = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/supply-requests/${cancelOrder.allocationId}/cancel`,
        headers: { ...aHeaders, 'idempotency-key': key('p5-cancel') }, payload: { note: 'ظرفیت آزاد شد؛ نیاز برای بازتخصیص حفظ شود' } });
      assert.equal(cancel.statusCode, 200, cancel.body);
      assert.equal(cancel.json().responseStatus, 'cancelled');
      assert.equal(cancel.json().preservedDemandSeries, 3);
      const preserved = await pool.query('SELECT requested_series,status,supplier_response_status FROM child_order_lines WHERE id=$1', [cancelOrder.lineId]);
      assert.equal(preserved.rows[0].requested_series, 3);
      assert.equal(preserved.rows[0].supplier_response_status, 'cancelled');
      const released = await pool.query('SELECT quantity,status,capacity_reservation_id FROM order_source_allocations WHERE id=$1', [cancelOrder.allocationId]);
      assert.deepEqual(released.rows[0], { quantity: 3, status: 'pending', capacity_reservation_id: null });
      const prematureLock = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${cancelOrder.id}/lock`, headers: buyerHeaders });
      assert.equal(prematureLock.statusCode, 409, prematureLock.body);
      assert.equal(prematureLock.json().code, 'SUPPLIER_CONFIRMATION_REQUIRED', 'cancelled supplier capacity must leave OMS demand unresolved');
      const offer = await pool.query('SELECT reserved_external FROM supplier_offers WHERE id=$1', [offerA]);
      assert.equal(offer.rows[0].reserved_external, 7, 'only the cancelled capacity is released; the accepted counter remains reserved');

      const reassignKey = key('p5-reassign');
      const reassign = await app.inject({ method: 'POST', url: `/api/v1/wholesale/allocations/${cancelOrder.allocationId}/reassign`,
        headers: { ...opsHeaders, 'idempotency-key': reassignKey }, payload: { toOfferId: crossOffer, reason: 'تخصیص نیاز باز به پیشنهاد جایگزین فعال' } });
      assert.equal(reassign.statusCode, 201, reassign.body);
      assert.equal(reassign.json().quantity, 3);
      const rows = await pool.query('SELECT id,quantity,status,owner_supplier_id FROM order_source_allocations WHERE line_id=$1 ORDER BY created_at', [cancelOrder.lineId]);
      assert.deepEqual(rows.rows.map((row) => [row.quantity, row.status, row.owner_supplier_id]), [
        [3, 'released', supplierA.id], [3, 'pending', supplierB.id],
      ]);
      const demand = await pool.query("SELECT COALESCE(sum(quantity) FILTER (WHERE status IN ('pending','reserved')),0)::int AS active FROM order_source_allocations WHERE line_id=$1", [cancelOrder.lineId]);
      assert.equal(demand.rows[0].active, 3);
      const projection = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${cancelOrder.id}`, headers: opsHeaders });
      const capacity = projection.json().coverage.capacitySeries as number;
      assert.equal(capacity, 3, 'released source A excluded; replacement source B counted once');
      const oldSupplier = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests?state=all', headers: aHeaders });
      assert.ok(!(oldSupplier.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === rows.rows[1].id));
      const newSupplier = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests?state=open', headers: bHeaders });
      assert.ok((newSupplier.json().items as Array<{ allocationId: string }>).some((row) => row.allocationId === rows.rows[1].id), newSupplier.body);
      const replay = await app.inject({ method: 'POST', url: `/api/v1/wholesale/allocations/${cancelOrder.allocationId}/reassign`,
        headers: { ...opsHeaders, 'idempotency-key': reassignKey }, payload: { toOfferId: crossOffer, reason: 'تخصیص نیاز باز به پیشنهاد جایگزین فعال' } });
      assert.equal(replay.statusCode, 201, replay.body);
      const count = await pool.query('SELECT count(*)::int AS n FROM order_source_allocations WHERE line_id=$1', [cancelOrder.lineId]);
      assert.equal(count.rows[0].n, 2, 'idempotent replay did not create a third allocation');
    });

    await t.test('P5-SUP-025 — OMS capacity ignores the generic TTL sweep; Admin lifecycle/audit stay private; no Supplier Finance writes', async () => {
      const counterReservation = await pool.query<{ id: string }>(
        "SELECT capacity_reservation_id AS id FROM order_source_allocations WHERE id=$1", [counterOrder.allocationId]);
      const counterReservationId = counterReservation.rows[0]!.id;
      assert.ok(counterReservationId);
      await pool.query('UPDATE supplier_capacity_reservations SET expires_at=now()-interval \'1 minute\' WHERE id=$1', [counterReservationId]);
      const sweep = await app.inject({ method: 'POST', url: '/api/v1/wholesale/oms/expire-sweep', headers: opsHeaders });
      assert.equal(sweep.statusCode, 200, sweep.body);
      assert.equal(sweep.json().expiredCapacityReservations, 0);
      const reservation = await pool.query('SELECT status FROM supplier_capacity_reservations WHERE id=$1', [counterReservationId]);
      assert.equal(reservation.rows[0].status, 'active');

      const adminProjection = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${main.id}`, headers: opsHeaders });
      const mainAllocation = (adminProjection.json().children as Array<{ lines: Array<{ allocations: Array<Record<string, unknown>> }> }>)[0]!
        .lines[0]!.allocations[0]!;
      assert.equal(mainAllocation.supplier_response_status, 'ready');
      assert.equal(mainAllocation.supplier_committed_series, 5);
      assert.ok(mainAllocation.supplier_ready_at);
      const vipProjection = await app.inject({ method: 'GET', url: `/api/v1/wholesale/masters/${main.id}`, headers: buyerHeaders });
      for (const internal of ['supplier_response_status', 'supplier_committed_series', 'supplier_ready_at', supplierA.id, offerA]) {
        assert.ok(!vipProjection.body.includes(internal), `VIP projection leaked ${internal}`);
      }
      const audit = await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'wholesale_supplier.%'");
      assert.ok(audit.rows[0].n >= 5);
      const outbox = await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type LIKE 'child_order.supplier_%'");
      assert.ok(outbox.rows[0].n >= 5);
      const walletAfter = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM wallet_entries e JOIN wallet_accounts a ON a.id=e.account_id WHERE a.owner_id=$1', [supplierA.id]);
      assert.equal(walletAfter.rows[0]!.n, supplierWalletBefore.rows[0]!.n, 'Prompt 5 never writes Supplier Settlement/Finance');
      // New supplier data stays separately scoped and no purchase/buyer PII is ever serialized to suppliers.
      const newSupplier = await app.inject({ method: 'GET', url: '/api/v1/wholesale/supplier/supply-requests?state=open', headers: bHeaders });
      assert.ok(newSupplier.body.includes(productA.name), 'reassigned product request is visible to the new owner');
      assert.ok(!newSupplier.body.includes(buyer.email));
    });
  } finally {
    await app.close();
    await pool.end();
  }
});
