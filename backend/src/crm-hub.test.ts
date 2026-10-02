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

    // §6: paginated retail list with behavior + evidence
    const list = await app.inject({ method: 'GET', url: `/api/v1/admin/crm/retail-customers?search=${suffix}&limit=10`, headers });
    assert.equal(list.statusCode, 200, list.body);
    const body = list.json() as { total: number; items: Array<Record<string, unknown>> };
    assert.equal(body.total, 1);
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
