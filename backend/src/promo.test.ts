import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { runAutomation } from './crm.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4006, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('coupons, festivals and the birthday CRM automation work end to end', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `c-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `c-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    // Catalog + stock for checkout assertions.
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders,
      payload: { brand: 'Kolbe', name: 'پیراهن وینتج', category: 'پیراهن', cashPriceRial: '100000000',
        metadata: { images: ['img'] }, variants: [{ size: 'M' }] } });
    const variantId = product.json().variants[0].id as string;
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [product.json().id]);
    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders,
      payload: { code: `C-${suffix.toUpperCase()}`, name: 'انبار' } });
    await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...adminHeaders, 'idempotency-key': `stk-${suffix}` },
      payload: { variantId, warehouseId: warehouse.json().id, delta: 50, reason: 'اولیه', reference: `ST-${suffix}` } });

    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `c-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'Buyer']);
    const buyerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `c-buyer-${suffix}@example.test`, password: 'BuyerPassword123456!' } });
    const buyerHeaders = { authorization: `Bearer ${buyerLogin.json().accessToken as string}` };
    const address = { recipient: 'خریدار', phone: '09123456789', province: 'تهران', city: 'تهران',
      line: 'خیابان تست، پلاک ۳', postalCode: '1234567890' };

    // Festival: 15% auto discount for retail customers with a discount cap.
    const festival = await app.inject({ method: 'POST', url: '/api/v1/admin/festivals', headers: adminHeaders, payload: {
      code: `yaldan-${suffix}`, name: 'جشنواره یلدا', occasion: 'شب یلدا',
      startsAt: new Date(Date.now() - 3600_000).toISOString(), endsAt: new Date(Date.now() + 86400_000).toISOString(),
      audience: ['customer'], scope: { categories: ['پیراهن'], productIds: [] },
      minOrderRial: '50000000', discountPercent: 15, maxDiscountRial: '10000000',
      usageLimitTotal: 100, usageLimitPerUser: 2, autoApply: true,
    } });
    assert.equal(festival.statusCode, 201, festival.body);

    const withFestival = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `fest-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }], shippingAddress: address } });
    assert.equal(withFestival.statusCode, 201, withFestival.body);
    // 15% of 100,000,000 = 15,000,000, capped at 10,000,000.
    assert.equal(withFestival.json().discountRial, '10000000');
    assert.equal(withFestival.json().totalRial, '90000000');

    // Personal coupon: validated first, then applied, then limited per user.
    const coupon = await app.inject({ method: 'POST', url: '/api/v1/admin/coupons', headers: adminHeaders, payload: {
      code: `VIP-${suffix.toUpperCase()}`, campaignName: 'کمپین پاییز', type: 'fixed', value: '20000000',
      minOrderRial: '10000000', usageLimitTotal: 10, usageLimitPerUser: 1, audience: ['customer'],
      scope: { categories: ['پیراهن'], productIds: [] },
      endsAt: new Date(Date.now() + 86400_000).toISOString(),
    } });
    assert.equal(coupon.statusCode, 201, coupon.body);
    const validated = await app.inject({ method: 'POST', url: '/api/v1/coupons/validate', headers: buyerHeaders, payload: {
      code: `VIP-${suffix.toUpperCase()}`, orderType: 'retail',
      items: [{ productId: product.json().id, category: 'پیراهن', totalRial: '100000000' }],
    } });
    assert.equal(validated.json().valid, true);
    assert.equal(validated.json().discountRial, '20000000');

    const withCoupon = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `coupon-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
        shippingAddress: address, couponCode: `VIP-${suffix.toUpperCase()}` } });
    assert.equal(withCoupon.statusCode, 201, withCoupon.body);
    // The coupon replaces the festival for this order and is capped by the order total.
    assert.equal(withCoupon.json().totalRial, '80000000');
    const reused = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `reuse-${suffix}` },
      payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
        shippingAddress: address, couponCode: `VIP-${suffix.toUpperCase()}` } });
    assert.equal(reused.statusCode, 400, reused.body);
    const redemptions = await pool.query('SELECT discount_rial FROM coupon_redemptions WHERE user_id = $1', [buyerId]);
    assert.equal(redemptions.rows.length, 1);
    assert.equal(redemptions.rows[0].discount_rial, '20000000');

    // Birthday automation: personal coupon + queued SMS + CRM timeline.
    const birthdayId = randomUUID();
    await pool.query(
      `INSERT INTO users(id,phone,password_hash,display_name,birthday) VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'Asia/Tehran')::date)`,
      [birthdayId, `0912${String(3000000 + Math.floor(Math.random() * 6999999)).slice(0, 7)}`, await argon2.hash('BirthdayPass12345!'), 'جشن تولد']);
    // Marketing consent is required for the birthday gift SMS (item 143) …
    await pool.query(
      `INSERT INTO customer_consents(user_id,marketing_sms,transactional_sms) VALUES ($1,true,true)`, [birthdayId]);
    // … and a customer without that consent is skipped, not messaged.
    const noConsentId = randomUUID();
    await pool.query(
      `INSERT INTO users(id,phone,password_hash,display_name,birthday) VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'Asia/Tehran')::date)`,
      [noConsentId, `0912${String(1000000 + Math.floor(Math.random() * 8999997)).slice(0, 7)}`, await argon2.hash('BirthdayPass12345!'), 'بدون رضایت']);
    const automation = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/automations', headers: adminHeaders, payload: {
      code: `bday-${suffix}`, name: 'پیام تولد مشتری', automationType: 'birthday_sms',
      config: { messageTemplate: '{name} عزیز، تولدت مبارک! کد: {code}', couponPercent: 12,
        couponMaxDiscountRial: '30000000', couponValidityDays: 7 },
    } });
    assert.equal(automation.statusCode, 201, automation.body);
    const run = await runAutomation(pool, automation.json().id as string);
    assert.equal(run.processed, 1);
    const birthdayCode = run.results[0]!.couponCode!;
    assert.ok(birthdayCode.startsWith('KV-'));
    const skippedByConsent = await pool.query('SELECT count(*)::int AS n FROM sms_deliveries WHERE user_id = $1', [noConsentId]);
    assert.equal(skippedByConsent.rows[0].n, 0, 'marketing SMS respects the consent gate');
    const sms = await pool.query('SELECT message, status FROM sms_deliveries WHERE user_id = $1', [birthdayId]);
    assert.equal(sms.rows.length, 1);
    assert.ok(sms.rows[0].message.includes(birthdayCode));
    assert.equal(sms.rows[0].status, 'queued');
    const activity = await pool.query(
      `SELECT a.title, a.result FROM crm_activities a JOIN crm_contacts c ON c.id = a.contact_id WHERE c.user_id = $1`,
      [birthdayId]);
    assert.equal(activity.rows.length, 1);
    // Running the automation again does not duplicate the birthday gift.
    const rerun = await runAutomation(pool, automation.json().id as string);
    assert.equal(rerun.processed, 0);

    // The birthday coupon is personal and time limited.
    const birthdayCoupon = await pool.query('SELECT recipient_user_id, ends_at FROM coupons WHERE code = $1', [birthdayCode]);
    assert.equal(birthdayCoupon.rows[0].recipient_user_id, birthdayId);

    // CRM views cover every actor with aggregates.
    const contacts = await app.inject({ method: 'GET', url: '/api/v1/admin/crm/contacts?search=جشن', headers: adminHeaders });
    assert.equal(contacts.statusCode, 200, contacts.body);
    assert.ok(contacts.json().items.some((item: { user_id: string }) => item.user_id === birthdayId));
  } finally {
    await app.close();
    await pool.end();
  }
});
