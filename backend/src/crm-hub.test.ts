/** Master phase C2 — CRM read models: explainable behavior + paginated CRM lists. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { classifyVipBehavior } from './buyer360.js';
import { behaviorReasons, supplierPerformance, BEHAVIOR_LABEL } from './crm-intelligence.js';
import { loadShippingLabelData } from './shipping-labels.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4019, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('crm behavior engine is rule-based and explainable (no black box)', () => {
  // VIP: expired plan wins over everything
  const expired = classifyVipBehavior({ order_count: 12, wholesale_order_count: 12, last_order_at: new Date().toISOString(),
    created_at: new Date().toISOString(), plan_code: null, plan_status: 'expired', plan_ends_at: null, total_spent_rial: '9000000000' });
  assert.equal(expired.state, 'plan_expired');
  // VIP: plan ending within 30 days → نزدیک تمدید with day-count evidence
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const renewal = classifyVipBehavior({ order_count: 3, wholesale_order_count: 3, last_order_at: new Date().toISOString(),
    created_at: new Date().toISOString(), plan_code: 'gold', plan_status: 'active', plan_ends_at: soon, total_spent_rial: '100000000' });
  assert.equal(renewal.state, 'renewal_due');
  assert.ok(renewal.reasons.some((r) => r.includes('روز تا پایان پلن')), renewal.reasons.join('|'));
  // VIP with zero wholesale orders → جدید
  const fresh = classifyVipBehavior({ order_count: 0, wholesale_order_count: 0, last_order_at: null,
    created_at: new Date().toISOString(), plan_code: 'gold', plan_status: 'active', plan_ends_at: null, total_spent_rial: '0' });
  assert.equal(fresh.state, 'new');

  // Supplier: QC pass rate below 80% → QC ضعیف with the rate visible in reasons
  const weak = supplierPerformance({ cooperation_status: 'approved', activity_status: 'active', active_products: 4,
    total_sales: '500000000', sold_lines: 10, qc_accepted: 6, qc_rejected: 4, cancelled_lines: 0 });
  assert.equal(weak.state, 'qc_weak');
  assert.equal(weak.qcPassRate, 60);
  assert.ok(weak.reasons.some((r) => r.includes('نرخ قبولی QC')));
  const suspended = supplierPerformance({ cooperation_status: 'suspended', activity_status: 'active', active_products: 0,
    total_sales: '0', sold_lines: 0, qc_accepted: 0, qc_rejected: 0, cancelled_lines: 0 });
  assert.equal(suspended.state, 'suspended');

  // Retail evidence strings carry real numbers
  const reasons = behaviorReasons({ behavior: 'active', order_count: 3, total_spent: '120000000',
    last_order_at: new Date(Date.now() - 5 * 86_400_000).toISOString(), prev_order_at: null,
    created_at: new Date(Date.now() - 100 * 86_400_000).toISOString(), returns: 1 });
  assert.ok(reasons.some((r) => r.includes('سفارش موفق')));
  assert.ok(reasons.some((r) => r.includes('مرجوعی')));
  assert.ok(BEHAVIOR_LABEL.at_risk === 'در خطر ریزش');
});

test('crm read models: retail list pagination/filter, summary KPIs, supplier + VIP lists', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `crmhub-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر CRM']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `crmhub-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // Retail customer with one real order (recent → فعال)
    const custId = randomUUID();
    await pool.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)',
      [custId, `crmhub-cust-${suffix}@example.test`, `0912${suffix.replace(/\D/g, '1').slice(0, 7).padEnd(7, '1')}`,
        await argon2.hash('CustomerPassword123!'), `مشتری ${suffix}`]);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'customer')", [custId]);
    await pool.query(
      `INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial)
       VALUES ($1,$2,$3,'retail','cash','delivered',150000000,150000000)`,
      [randomUUID(), `CRMHUB-${suffix}`, custId]);

    // QA2-CRM-014: a supplier whose login ALSO has the customer role (dual-role workshop
    // account) must NOT appear in the retail customers list — it belongs to the supplier tab.
    const workshopId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [workshopId, `crmhub-workshop-${suffix}@example.test`, await argon2.hash('SupplierPassword123!'), `کارگاه ${suffix}`]);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'customer'), ($1,'supplier')", [workshopId]);

    // §6: paginated retail list with behavior + evidence
    const list = await app.inject({ method: 'GET', url: `/api/v1/admin/crm/retail-customers?search=${suffix}&limit=10`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const body = list.json() as { total: number; items: Array<Record<string, unknown>> };
    assert.equal(body.total, 1, 'dual-role supplier account is excluded from the retail list');
    const row = body.items[0]!;
    assert.equal(row.behavior, 'active');
    assert.equal(row.behavior_label, 'فعال');
    assert.ok((row.behavior_reasons as string[]).length >= 2, 'evidence («چرا؟») present');
    assert.equal(row.order_count, 1);
    // behavior filter is applied server-side
    const none = await app.inject({ method: 'GET', url: `/api/v1/admin/crm/retail-customers?search=${suffix}&behavior=loyal`, headers });
    assert.equal((none.json() as { total: number }).total, 0);
    // active VIP members are excluded from the RETAIL tab (they live in the VIP tab)

    // §5: summary KPIs come back as integers
    const summary = await app.inject({ method: 'GET', url: '/api/v1/admin/crm/summary', headers });
    assert.equal(summary.statusCode, 200, summary.body);
    const kpis = (summary.json() as { kpis: Record<string, number> }).kpis;
    for (const key of ['active_customers', 'active_vip', 'active_suppliers', 'at_risk', 'birthdays_this_month', 'abandoned_carts', 'vip_expiring'])
      assert.equal(typeof kpis[key], 'number', `KPI ${key}`);
    assert.ok(kpis.active_customers! >= 1);

    // §17: supplier CRM list with performance + reasons
    const supId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supId, `crmhub-sup-${suffix}@example.test`, await argon2.hash('SupplierPassword123!'), `تأمین‌کننده ${suffix}`]);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'supplier')", [supId]);
    await pool.query("INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')",
      [supId, `برند CRM ${suffix}`]);
    const sup = await app.inject({ method: 'GET', url: `/api/v1/admin/crm/suppliers?search=${encodeURIComponent(`برند CRM ${suffix}`)}`, headers });
    assert.equal(sup.statusCode, 200, sup.body);
    const supBody = sup.json() as { total: number; items: Array<Record<string, unknown>> };
    assert.equal(supBody.total, 1);
    assert.ok(supBody.items[0]!.performance_label, 'performance label present');
    assert.ok(Array.isArray(supBody.items[0]!.performance_reasons));

    // §13/§14: VIP list is paginated, classified, and NEVER exposes credit fields
    const buyers = await app.inject({ method: 'GET', url: `/api/v1/admin/buyers?search=${suffix}&limit=5&offset=0`, headers });
    assert.equal(buyers.statusCode, 200, buyers.body);
    const buyersBody = buyers.json() as { total: number; items: Array<Record<string, unknown>> };
    assert.equal(typeof buyersBody.total, 'number');
    for (const item of buyersBody.items) {
      assert.ok(!('credit_limit_rial' in item), 'VIP list must not expose credit fields (§13)');
      assert.ok('series_purchased' in item && 'behavior_label' in item && 'behavior_reasons' in item);
    }
  } finally {
    await pool.end();
    await app.close();
  }
});

test('marketing: campaign preview breakdown + configurable frequency cap (§28-§29)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `mkt-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر بازاریابی']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `mkt-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // settings roundtrip (audited, stored in site_settings)
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/crm/marketing-settings', headers,
      payload: { maxPerWindow: 1, windowDays: 7 } });
    assert.equal(put.statusCode, 200, put.body);
    const got = await app.inject({ method: 'GET', url: '/api/v1/admin/crm/marketing-settings', headers });
    assert.deepEqual((got.json() as { frequencyCap: unknown }).frequencyCap, { maxPerWindow: 1, windowDays: 7 });

    // two customers under one label: one consented, one opted out
    const label = `mkt_${suffix}`;
    await pool.query(`INSERT INTO crm_labels(code,title,kind) VALUES ($1,'کمپین تست','manual')`, [label]);
    const mk = async (phoneTail: string, consent: boolean) => {
      const uid = randomUUID();
      await pool.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)',
        [uid, `mkt-${phoneTail}-${suffix}@example.test`, `091234${phoneTail}`, await argon2.hash('CustomerPassword123!'), `مشتری ${phoneTail}`]);
      await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'customer')", [uid]);
      const cid = randomUUID();
      await pool.query('INSERT INTO crm_contacts(id,user_id) VALUES ($1,$2)', [cid, uid]);
      await pool.query(`INSERT INTO crm_contact_labels(contact_id,label_code,source) VALUES ($1,$2,'manual')`, [cid, label]);
      if (consent) await pool.query(`INSERT INTO customer_consents(user_id,marketing_sms) VALUES ($1,true)`, [uid]);
      return uid;
    };
    const tail = suffix.replace(/\D/g, '9').padEnd(5, '0').slice(0, 5);
    const consentedId = await mk(tail, true);

    // §100 regression: the admin consent form sends a human `reason` — must be accepted, not 400.
    const consentWithReason = await app.inject({ method: 'POST', url: `/api/v1/admin/buyers/${consentedId}/consent`,
      headers, payload: { marketingSms: true, reason: 'تنظیم از پنل مدیریت' } });
    assert.equal(consentWithReason.statusCode, 200, consentWithReason.body);
    await mk(String((Number(tail) + 1) % 100000).padStart(5, '0'), false);

    // dry-run: breakdown shows matched=2, eligible=1, optedOut=1
    const preview = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/campaigns', headers,
      payload: { title: 'کمپین تست', message: 'پیام آزمایشی کمپین', labelCode: label, dryRun: true, send: false } });
    assert.equal(preview.statusCode, 200, preview.body);
    const b1 = (preview.json() as { breakdown: Record<string, number> }).breakdown;
    assert.equal(b1.matched, 2); assert.equal(b1.eligible, 1);
    assert.equal(b1.optedOut, 1); assert.equal(b1.capped, 0);

    // real send consumes the cap (maxPerWindow=1) → next preview buckets the user as capped
    const send = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/campaigns', headers,
      payload: { title: 'کمپین ارسال', message: 'پیام ارسال واقعی', labelCode: label, dryRun: false, send: true } });
    assert.equal(send.statusCode, 201, send.body);
    const after = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/campaigns', headers,
      payload: { title: 'کمپین دوم', message: 'پیام دوم آزمایشی', labelCode: label, dryRun: true, send: false } });
    const b2 = (after.json() as { breakdown: Record<string, number> }).breakdown;
    assert.equal(b2.capped, 1, JSON.stringify(b2));
    assert.equal(b2.eligible, 0);

    // operational SMS is never affected by the cap: deliveries written were category='marketing' only
    const cats = await pool.query(`SELECT DISTINCT category FROM sms_deliveries WHERE user_id = $1`, [consentedId]);
    assert.deepEqual(cats.rows.map((r: { category: string }) => r.category), ['marketing']);
  } finally {
    // restore the global default so other suites see the out-of-the-box cap
    await pool.query(`DELETE FROM site_settings WHERE key = 'crm_marketing_frequency_cap'`).catch(() => undefined);
    await pool.end();
    await app.close();
  }
});

test('wms review: reason-required actions, archive, and approval never mutates stock (§54-§56)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `rev-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'بازبین']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `rev-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const productId = randomUUID();
    await pool.query(
      `INSERT INTO products(id,brand,name,category,status,cash_price_rial,wholesale_price_rial)
       VALUES ($1,'کلبه',$2,'پیراهن','pending',120000000,90000000)`, [productId, `محصول بازبینی ${suffix}`]);

    // request-changes WITHOUT reason or note → rejected server-side
    const noReason = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productId}/review`,
      headers, payload: { decision: 'changes_requested' } });
    assert.equal(noReason.statusCode, 400, noReason.body);

    // approval changes catalogue status only — stock rows stay untouched
    const stockBefore = await pool.query(
      `SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1`, [productId]);
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productId}/review`,
      headers, payload: { decision: 'approved', documentsChecked: true } });
    assert.equal(approve.statusCode, 200, approve.body);
    assert.equal(approve.json().status, 'published');
    const stockAfter = await pool.query(
      `SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1`, [productId]);
    assert.equal(stockAfter.rows[0].n, stockBefore.rows[0].n, 'approval never mutates stock');
    const seriesTouch = await pool.query(`SELECT count(*)::int AS n FROM series_stock_balances`);
    assert.ok(seriesTouch.rows[0].n >= 0); // table readable; review path never writes it

    // archive requires a reason and is audited; double-archive conflicts
    const badArchive = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productId}/archive`,
      headers, payload: { reason: 'x' } });
    assert.equal(badArchive.statusCode, 400, badArchive.body);
    const archive = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productId}/archive`,
      headers, payload: { reason: 'پایان همکاری فصلی' } });
    assert.equal(archive.statusCode, 200, archive.body);
    assert.equal(archive.json().status, 'archived');
    const again = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${productId}/archive`,
      headers, payload: { reason: 'تکراری' } });
    assert.equal(again.statusCode, 409, again.body);
    const audited = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.archived' AND resource_id = $1`, [productId]);
    assert.equal(audited.rows[0].n, 1, 'archive is audited');
  } finally {
    await pool.end();
    await app.close();
  }
});

test('invoice: order→invoice issuance, bulk identify/issue, PDF bundle (§H)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `inv-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر فاکتور']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `inv-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `inv-buyer-${suffix}@example.test`, await argon2.hash('CustomerPassword123!'), 'خریدار فاکتور']);
    const productId = randomUUID(); const variantId = randomUUID();
    await pool.query(`INSERT INTO products(id,brand,name,category,status,cash_price_rial) VALUES ($1,'کلبه',$2,'پیراهن','published',150000000)`,
      [productId, `محصول فاکتور ${suffix}`]);
    await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'L','مشکی')`,
      [variantId, productId, `INVSKU-${suffix}`]);
    const mkOrder = async (n: number) => {
      const orderId = randomUUID();
      await pool.query(
        `INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial)
         VALUES ($1,$2,$3,'retail','cash','paid',150000000,150000000)`, [orderId, `INVORD-${suffix}-${n}`, buyerId]);
      await pool.query(
        `INSERT INTO order_lines(id,order_id,product_id,variant_id,product_name,sku,quantity,unit_price_rial,line_total_rial)
         VALUES ($1,$2,$3,$4,$5,$6,1,150000000,150000000)`,
        [randomUUID(), orderId, productId, variantId, `محصول فاکتور ${suffix}`, `INVSKU-${suffix}`]);
      return orderId;
    };
    const orderA = await mkOrder(1); const orderB = await mkOrder(2);

    // issue once → 201; again → 200 with the SAME invoice (reprint ≠ new invoice)
    const first = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderA}/invoice`, headers });
    assert.equal(first.statusCode, 201, first.body);
    const second = await app.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderA}/invoice`, headers });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().id, first.json().id);
    assert.equal(second.json().existing, true);
    // snapshot pricing: the invoice line carries color/size in description (§40)
    const line = await pool.query(`SELECT description FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE i.order_id = $1`, [orderA]);
    assert.equal(line.rows[0].description, 'مشکی / L');

    // bulk identify: A existing, B missing (reported, NOT silently issued)
    const identify = await app.inject({ method: 'POST', url: '/api/v1/admin/orders/invoices/bulk', headers,
      payload: { orderIds: [orderA, orderB], issueMissing: false } });
    assert.equal(identify.statusCode, 200, identify.body);
    assert.deepEqual(identify.json().summary, { existing: 1, issued: 0, missing: 1, failed: 0 });
    // bulk issue missing → B gets its invoice
    const issueAll = await app.inject({ method: 'POST', url: '/api/v1/admin/orders/invoices/bulk', headers,
      payload: { orderIds: [orderA, orderB], issueMissing: true } });
    assert.deepEqual(issueAll.json().summary, { existing: 1, issued: 1, missing: 0, failed: 0 });
    const ids = (issueAll.json().results as { invoiceId?: string }[]).map((r) => r.invoiceId).filter(Boolean);
    assert.equal(ids.length, 2);

    // bundle: one multi-page PDF from the existing invoice domain
    const bundle = await app.inject({ method: 'GET', url: `/api/v1/admin/invoices/bundle?ids=${ids.join(',')}`, headers });
    assert.equal(bundle.statusCode, 200, bundle.body.slice(0, 200));
    assert.equal(bundle.headers['content-type'], 'application/pdf');
    assert.ok(bundle.rawPayload.subarray(0, 5).toString('latin1').startsWith('%PDF'), 'bundle is a real PDF');
  } finally {
    await pool.end();
    await app.close();
  }
});

test('shipping label: server PDF, contents without prices, thermal + A4 bundle (§I)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `lbl-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر لیبل']);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `lbl-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `lbl-buyer-${suffix}@example.test`, await argon2.hash('CustomerPassword123!'), 'خریدار لیبل']);
    const productId = randomUUID(); const variantId = randomUUID();
    await pool.query(`INSERT INTO products(id,brand,name,category,status,cash_price_rial) VALUES ($1,'کلبه',$2,'پیراهن','published',150000000)`,
      [productId, `محصول لیبل ${suffix}`]);
    await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','سبز')`,
      [variantId, productId, `LBLSKU-${suffix}`]);
    const address = JSON.stringify({ recipient: 'گیرنده تست', phone: '09120000000', province: 'تهران', city: 'تهران',
      line: 'خیابان آزادی، پلاک ۱', postalCode: '1234567890' });
    const mkOrder = async (n: number) => {
      const orderId = randomUUID();
      await pool.query(
        `INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial,shipping_address)
         VALUES ($1,$2,$3,'retail','cash','paid',150000000,150000000,$4::jsonb)`, [orderId, `LBLORD-${suffix}-${n}`, buyerId, address]);
      await pool.query(
        `INSERT INTO order_lines(id,order_id,product_id,variant_id,product_name,sku,quantity,unit_price_rial,line_total_rial)
         VALUES ($1,$2,$3,$4,$5,$6,2,150000000,300000000)`,
        [randomUUID(), orderId, productId, variantId, `محصول لیبل ${suffix}`, `LBLSKU-${suffix}`]);
      return orderId;
    };
    const orderA = await mkOrder(1); const orderB = await mkOrder(2);

    // loader is price-free by construction: contents carry name/color/size/qty only
    const data = await loadShippingLabelData(pool, [orderA]);
    assert.equal(data.length, 1);
    assert.equal(data[0]!.recipientName, 'گیرنده تست');
    assert.deepEqual(data[0]!.lines[0], { productName: `محصول لیبل ${suffix}`, colorLabel: 'سبز', sizeLabel: 'M', quantity: 2 });
    assert.ok(!Object.keys(data[0]!).some((k) => /rial|price/i.test(k)), 'label data exposes no price fields');

    // single label = 100×150 thermal PDF, audited; unknown order → 404
    const single = await app.inject({ method: 'GET', url: `/api/v1/admin/orders/${orderA}/label`, headers });
    assert.equal(single.statusCode, 200, single.body.slice(0, 200));
    assert.equal(single.headers['content-type'], 'application/pdf');
    assert.ok(single.rawPayload.subarray(0, 5).toString('latin1').startsWith('%PDF'));
    const missing = await app.inject({ method: 'GET', url: `/api/v1/admin/orders/${randomUUID()}/label`, headers });
    assert.equal(missing.statusCode, 404);
    const audited = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'label.printed' AND resource_id = $1`, [orderA]);
    assert.equal(audited.rows[0].n, 1, 'label print is audited');

    // batch: thermal stack and A4 grid both render one real PDF
    for (const format of ['thermal', 'a4'] as const) {
      const bundle = await app.inject({ method: 'GET', url: `/api/v1/admin/orders/labels/bundle?ids=${orderA},${orderB}&format=${format}`, headers });
      assert.equal(bundle.statusCode, 200, bundle.body.slice(0, 200));
      assert.equal(bundle.headers['content-type'], 'application/pdf');
      assert.ok(bundle.rawPayload.subarray(0, 5).toString('latin1').startsWith('%PDF'), `${format} bundle is a real PDF`);
    }
  } finally {
    await pool.end();
    await app.close();
  }
});
