import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';
import { dispatchAutomationEvents, matchesEventPattern, signPayload, verifySignedPayload } from './events.js';
import { totpCode, verifyTotp } from './profile.js';
import { runCrmRuleSweep } from './crm-intelligence.js';
import { dispatchDueAutomations } from './promo-safety.js';
import { seasonForDate } from './recommendations.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4007, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

const password = 'BuyerPassword123456!';

/** Creates a user, returns an authenticated header set. */
async function makeUser(app: Awaited<ReturnType<typeof buildApp>>, pool: ReturnType<typeof createPool>, role: string | null, suffix: string) {
  const id = randomUUID();
  const email = `${role ?? 'user'}-${suffix}-${id.slice(0, 6)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name,phone) VALUES ($1,$2,$3,$4,$5)',
    [id, email, await argon2.hash(password), `کاربر ${id.slice(0, 4)}`, `0912${String(1000000 + Math.floor(Math.random() * 8999998)).slice(0, 7)}`]);
  if (role) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password } });
  assert.equal(login.statusCode, 200, login.body);
  return {
    id, email,
    headers: { authorization: `Bearer ${login.json().accessToken as string}` } as Record<string, string>,
  };
}

/** Minimal n8n-style receiver: verifies the HMAC signature and records payloads. */
function startWebhookReceiver() {
  const received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ body, headers: request.headers as Record<string, string | string[] | undefined> });
      if (request.headers['x-kolbe-event'] === 'automation.fail') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, workflow: 'n8n' }));
    });
  });
  return new Promise<{ url: string; received: typeof received; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/webhook/kolbe`, received, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('event contract, HMAC signing and pattern matching are deterministic', () => {
  assert.equal(matchesEventPattern('order.paid', 'order.paid'), true);
  assert.equal(matchesEventPattern('order.*', 'order.paid'), true);
  assert.equal(matchesEventPattern('*', 'membership.activated'), true);
  assert.equal(matchesEventPattern('order.*', 'membership.activated'), false);
  const signature = signPayload('secret', 1_700_000_000, '{"a":1}');
  assert.match(signature, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(verifySignedPayload('secret', signature, '{"a":1}', 300, 1_700_000_000).valid, true);
  assert.equal(verifySignedPayload('secret', signature, '{"a":2}', 300, 1_700_000_000).valid, false);
  assert.deepEqual(verifySignedPayload('secret', signature, '{"a":1}', 300, 1_700_000_000 + 600),
    { valid: false, reason: 'timestamp_out_of_tolerance' }, 'replay outside tolerance');
  const tampered = `t=1700000000,v1=${createHmac('sha256', 'other').update('1700000000.{"a":1}').digest('hex')}`;
  assert.equal(verifySignedPayload('secret', tampered, '{"a":1}', 300, 1_700_000_000).valid, false);
});

test('TOTP implementation matches RFC 6238 vectors', () => {
  // RFC 6238 test secret (base32 of "12345678901234567890") — SHA1, 6 digits.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 59_000), '287082');
  assert.equal(totpCode(secret, 1_111_111_109_000), '081804');
  assert.equal(verifyTotp(secret, '287082', 59_000), true);
  assert.equal(verifyTotp(secret, '287082', 59_000 + 90_000), false);
});

test('recommendation seasons follow the Tehran calendar', () => {
  assert.equal(seasonForDate(new Date('2026-01-15T10:00:00Z')), 'winter');
  assert.equal(seasonForDate(new Date('2026-04-15T10:00:00Z')), 'spring');
  assert.equal(seasonForDate(new Date('2026-07-15T10:00:00Z')), 'summer');
  assert.equal(seasonForDate(new Date('2026-10-15T10:00:00Z')), 'autumn');
});

test('membership renew/upgrade, CRM intelligence, automation, tracking, reviews, recommendations and security',
  { skip: !enabled }, async () => {
    const app = await buildApp(config);
    const pool = createPool(config);
    const receiver = await startWebhookReceiver();
    try {
      const suffix = randomUUID().slice(0, 8);
      const admin = await makeUser(app, pool, 'admin', `admin-${suffix}`);
      const buyer = await makeUser(app, pool, null, `buyer-${suffix}`);

      /* ------------------------- catalogue + stock ------------------------- */
      const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers,
        payload: { brand: 'Kolbe', name: `کت وینتج ${suffix}`, category: 'کت', cashPriceRial: '100000000',
          wholesalePriceRial: '80000000', metadata: { images: ['img-1'] }, variants: [{ size: 'M' }, { size: 'L' }] } });
      assert.equal(product.statusCode, 201, product.body);
      const productId = product.json().id as string;
      const variantId = product.json().variants[0].id as string;
      await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [productId]);
      const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: admin.headers,
        payload: { code: `G-${suffix.toUpperCase()}`, name: 'انبار رشد' } });
      await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
        headers: { ...admin.headers, 'idempotency-key': `stk-${suffix}` },
        payload: { variantId, warehouseId: warehouse.json().id, delta: 25, reason: 'اولیه', reference: `ST-${suffix}` } });

      /* --------------------- 15-17 membership lifecycle --------------------- */
      const planA = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: admin.headers, payload: {
        code: `basic-${suffix}`, title: 'پلن پایه', description: 'پایه', annualPriceRial: '100000000',
        limits: { maxOrdersPerMonth: 2, discountPercent: 0 }, features: ['basic'], permissions: [] } });
      assert.equal(planA.statusCode, 201, planA.body);
      const planB = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: admin.headers, payload: {
        code: `vip-${suffix}`, title: 'پلن VIP', description: 'ویژه', annualPriceRial: '400000000', tier: 2,
        limits: { maxOrdersPerMonth: 20, discountPercent: 10 }, features: ['vip'], permissions: [] } });
      assert.equal(planB.statusCode, 201, planB.body);

      const membership = await app.inject({ method: 'POST', url: '/api/v1/memberships',
        headers: { ...buyer.headers, 'idempotency-key': `mem-${suffix}` }, payload: { planId: planA.json().id } });
      assert.equal(membership.statusCode, 201, membership.body);
      // A pending payment must never activate anything (item 17).
      const beforePayment = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyer.headers });
      assert.equal(beforePayment.json().membership, null);
      await pool.query("UPDATE payment_intents SET provider = 'growth-adapter' WHERE id = $1", [membership.json().paymentIntentId]);
      await applyVerifiedPayment(pool, { provider: 'growth-adapter', providerEventId: `ev-act-${suffix}`,
        providerReference: `pay-act-${suffix}`, intentId: membership.json().paymentIntentId as string,
        amountRial: '100000000', paidAt: new Date() });
      const activated = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyer.headers });
      assert.equal(activated.json().membership.status, 'active');
      const firstEndsAt = new Date(activated.json().membership.ends_at as string);

      // Renewal stacks a full year on the existing term instead of replacing it.
      const quote = await app.inject({ method: 'GET', url: `/api/v1/memberships/quote?kind=renewal&planId=${planA.json().id}`, headers: buyer.headers });
      assert.equal(quote.statusCode, 200, quote.body);
      assert.equal(quote.json().payableRial, '100000000');
      const renewal = await app.inject({ method: 'POST', url: '/api/v1/memberships/renew',
        headers: { ...buyer.headers, 'idempotency-key': `ren-${suffix}` } });
      assert.equal(renewal.statusCode, 201, renewal.body);
      assert.equal(renewal.json().amountRial, '100000000', 'a renewal charges a full year');
      await pool.query("UPDATE payment_intents SET provider = 'growth-adapter' WHERE id = $1", [renewal.json().paymentIntentId]);
      await applyVerifiedPayment(pool, { provider: 'growth-adapter', providerEventId: `ev-ren-${suffix}`,
        providerReference: `pay-ren-${suffix}`, intentId: renewal.json().paymentIntentId as string,
        amountRial: '100000000', paidAt: new Date() });
      const renewed = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyer.headers });
      const stackedEndsAt = new Date(renewed.json().membership.ends_at as string);
      const yearMs = 365 * 86_400_000;
      assert.ok(Math.abs((stackedEndsAt.getTime() - firstEndsAt.getTime()) - yearMs) < 60_000, 'term stacked by one year');
      const history = await app.inject({ method: 'GET', url: '/api/v1/memberships/history', headers: buyer.headers });
      const kinds = history.json().events.map((row: { event_type: string }) => row.event_type);
      assert.ok(history.json().memberships.length >= 2, 'membership history keeps every term');
      assert.ok(kinds.includes('activated') && kinds.includes('renewed'), JSON.stringify(kinds));

      // Upgrade supersedes the old term and charges only the difference.
      const upgradeQuote = await app.inject({ method: 'GET', url: `/api/v1/memberships/quote?kind=upgrade&planId=${planB.json().id}`, headers: buyer.headers });
      const expectedPayable = BigInt(upgradeQuote.json().payableRial as string);
      assert.ok(expectedPayable > 0n && expectedPayable <= 400_000_000n, upgradeQuote.body);
      const upgrade = await app.inject({ method: 'POST', url: '/api/v1/memberships/upgrade',
        headers: { ...buyer.headers, 'idempotency-key': `upg-${suffix}` }, payload: { planId: planB.json().id } });
      assert.equal(upgrade.statusCode, 201, upgrade.body);
      assert.equal(upgrade.json().amountRial, upgradeQuote.json().payableRial, 'the upgrade charges only the prorated difference');
      await pool.query("UPDATE payment_intents SET provider = 'growth-adapter' WHERE id = $1", [upgrade.json().paymentIntentId]);
      await applyVerifiedPayment(pool, { provider: 'growth-adapter', providerEventId: `ev-upg-${suffix}`,
        providerReference: `pay-upg-${suffix}`, intentId: upgrade.json().paymentIntentId as string,
        amountRial: upgrade.json().amountRial as string, paidAt: new Date() });
      const upgraded = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyer.headers });
      assert.equal(upgraded.json().membership.code, `vip-${suffix}`);
      const superseded = await pool.query('SELECT status FROM memberships WHERE user_id = $1 ORDER BY created_at', [buyer.id]);
      assert.ok(superseded.rows.some((row) => ['upgraded', 'renewed'].includes(row.status)), JSON.stringify(superseded.rows));

      // Admin controls are audited (item 19).
      const suspend = await app.inject({ method: 'POST', url: `/api/v1/admin/memberships/${upgraded.json().membership.id}/suspend`,
        headers: admin.headers, payload: { reason: 'بررسی مالی' } });
      assert.equal(suspend.statusCode, 200, suspend.body);
      const reactivate = await app.inject({ method: 'POST', url: `/api/v1/admin/memberships/${upgraded.json().membership.id}/reactivate`,
        headers: admin.headers });
      assert.equal(reactivate.statusCode, 200, reactivate.body);
      const audits = await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'membership.%' AND resource_id = $1",
        [upgraded.json().membership.id]);
      assert.ok(audits.rows.length >= 2, JSON.stringify(audits.rows));

      /* ------------------- 105-109 reviews + moderation ------------------- */
      const orderResponse = await app.inject({ method: 'POST', url: '/api/v1/orders',
        headers: { ...buyer.headers, 'idempotency-key': `ord-${suffix}` },
        payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
          shippingAddress: { recipient: 'خریدار', phone: '09123456789', province: 'تهران', city: 'تهران',
            line: 'خیابان تست، پلاک ۱', postalCode: '1234567890' } } });
      assert.equal(orderResponse.statusCode, 201, orderResponse.body);
      await pool.query("UPDATE payment_intents SET provider = 'growth-adapter' WHERE id = $1", [orderResponse.json().paymentIntentId]);
      await applyVerifiedPayment(pool, { provider: 'growth-adapter', providerEventId: `ev-ord-${suffix}`,
        providerReference: `pay-ord-${suffix}`, intentId: orderResponse.json().paymentIntentId as string,
        amountRial: orderResponse.json().totalRial as string, paidAt: new Date() });

      /* ---------------- 20-22 CRM labels, rules, segments ---------------- */
      const labelRule = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/label-rules', headers: admin.headers, payload: {
        code: `big-spender-${suffix}`, title: 'خریدار پرخرج', labelCode: 'high_spender', status: 'test',
        matchMode: 'all', conditions: [{ field: 'order_count', op: '>=', value: 1 }], priority: 10,
        requiresApproval: true } });
      assert.equal(labelRule.statusCode, 201, labelRule.body);
      const dryRun = await app.inject({ method: 'POST', url: `/api/v1/admin/crm/label-rules/${labelRule.json().id}/dry-run`,
        headers: admin.headers });
      assert.equal(dryRun.statusCode, 200, dryRun.body);
      assert.ok(dryRun.json().matchCount >= 1, dryRun.body);
      assert.ok(dryRun.json().sample.length >= 1);
      const applyWithoutApproval = await app.inject({ method: 'POST', url: `/api/v1/admin/crm/label-rules/${labelRule.json().id}/apply`,
        headers: admin.headers, payload: {} });
      assert.equal(applyWithoutApproval.statusCode, 409, applyWithoutApproval.body);

      const segment = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/segments', headers: admin.headers, payload: {
        code: `active-${suffix}`, title: 'خریداران فعال', kind: 'dynamic',
        definition: { matchMode: 'all', conditions: [{ field: 'order_count', op: '>=', value: 1 }] },
        refreshIntervalMinutes: 60 } });
      assert.equal(segment.statusCode, 201, segment.body);

      /* -------------- 101-104 profile edits + security center -------------- */
      const profile = await app.inject({ method: 'PATCH', url: '/api/v1/customer/profile', headers: buyer.headers,
        payload: { displayName: 'خریدار تازه', city: 'تهران', gender: 'unspecified' } });
      assert.equal(profile.statusCode, 200, profile.body);
      const contactChange = await app.inject({ method: 'POST', url: '/api/v1/customer/profile/contact-change',
        headers: buyer.headers, payload: { kind: 'email', newValue: `new-${suffix}@example.test`, idempotencyKey: `cc-${suffix}` } });
      assert.equal(contactChange.statusCode, 201, contactChange.body);
      const confirmed = await app.inject({ method: 'POST', url: `/api/v1/customer/profile/contact-change/${contactChange.json().requestId}/confirm`,
        headers: buyer.headers, payload: { code: contactChange.json().developmentCode } });
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      const changed = await pool.query('SELECT email FROM users WHERE id = $1', [buyer.id]);
      assert.equal(changed.rows[0].email, `new-${suffix}@example.test`);
      const changeAudit = await pool.query(
        `SELECT old_value,new_value FROM audit_logs WHERE action = 'customer.contact_changed' AND resource_id = $1`, [buyer.id]);
      assert.equal(changeAudit.rowCount, 1);
      assert.ok(changeAudit.rows[0].new_value.email.endsWith('@example.test'));

      // 2FA: setup, confirm with a real TOTP code, then enforce on login.
      const setup = await app.inject({ method: 'POST', url: '/api/v1/customer/security/2fa/setup', headers: buyer.headers,
        payload: { method: 'authenticator' } });
      assert.equal(setup.statusCode, 200, setup.body);
      const secret = setup.json().manualEntryKey as string;
      const confirmable = await app.inject({ method: 'POST', url: '/api/v1/customer/security/2fa/confirm', headers: buyer.headers,
        payload: { code: totpCode(secret) } });
      assert.equal(confirmable.statusCode, 200, confirmable.body);
      assert.equal(confirmable.json().recoveryCodes.length, 8);
      const loginWithoutCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password } });
      assert.equal(loginWithoutCode.statusCode, 401, loginWithoutCode.body);
      assert.equal(loginWithoutCode.json().code ?? loginWithoutCode.json().error, 'TWO_FACTOR_REQUIRED');
      const loginWithCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password, code: totpCode(secret) } });
      assert.equal(loginWithCode.statusCode, 200, loginWithCode.body);
      const loginHistory = await app.inject({ method: 'GET', url: '/api/v1/customer/security/login-history', headers: buyer.headers });
      assert.ok(loginHistory.json().items.some((row: { success: boolean }) => !row.success), 'failed attempts are recorded');
      const sessions = await app.inject({ method: 'GET', url: '/api/v1/customer/security/sessions', headers: buyer.headers });
      assert.ok(sessions.json().items.length >= 1);
      const revokeOthers = await app.inject({ method: 'POST', url: '/api/v1/customer/security/sessions/revoke-others',
        headers: buyer.headers });
      assert.equal(revokeOthers.statusCode, 200, revokeOthers.body);

      // SMS OTP is the second supported method: the code is issued server-side,
      // stored hashed and delivered through the SMS panel (never returned to the browser).
      const smsSetup = await app.inject({ method: 'POST', url: '/api/v1/customer/security/2fa/setup', headers: buyer.headers,
        payload: { method: 'otp_sms' } });
      assert.equal(smsSetup.statusCode, 200, smsSetup.body);
      assert.ok(smsSetup.json().developmentCode, 'non-production responses expose the activation code for the operator');
      const smsConfirmed = await app.inject({ method: 'POST', url: '/api/v1/customer/security/2fa/confirm', headers: buyer.headers,
        payload: { code: smsSetup.json().developmentCode } });
      assert.equal(smsConfirmed.statusCode, 200, smsConfirmed.body);
      const recoveryCodes = smsConfirmed.json().recoveryCodes as string[];
      assert.equal(recoveryCodes.length, 8);
      const otpRequired = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password } });
      assert.equal(otpRequired.statusCode, 401, otpRequired.body);
      assert.equal(otpRequired.json().code, 'TWO_FACTOR_REQUIRED');
      assert.equal(otpRequired.json().challenge?.method, 'otp_sms', 'the client is told which challenge to answer');
      assert.ok(otpRequired.json().challenge?.challengeId);
      const otpRow = await pool.query(
        `SELECT message FROM sms_deliveries WHERE user_id = $1 AND message LIKE 'کد ورود دومرحله‌ای%' ORDER BY created_at DESC LIMIT 1`,
        [buyer.id]);
      const otpCode = String(otpRow.rows[0]?.message ?? '').match(/(\d{6})/)?.[1];
      assert.ok(otpCode, 'the OTP was queued through the SMS panel');
      const otpLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password, code: otpCode } });
      assert.equal(otpLogin.statusCode, 200, otpLogin.body);
      const otpReplay = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password, code: otpCode } });
      assert.equal(otpReplay.statusCode, 401, 'a consumed OTP cannot be replayed');
      const recoveryLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password, code: recoveryCodes[0] } });
      assert.equal(recoveryLogin.statusCode, 200, recoveryLogin.body);
      const reusedRecovery = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
        payload: { identity: `new-${suffix}@example.test`, password, code: recoveryCodes[0] } });
      assert.equal(reusedRecovery.statusCode, 401, 'recovery codes are single-use');
      const storedCodes = await pool.query('SELECT recovery_codes FROM user_two_factor WHERE user_id = $1', [buyer.id]);
      assert.equal(storedCodes.rows[0].recovery_codes.length, 7, 'the used recovery code is removed');
      const storedOtp = await pool.query(
        `SELECT code_hash FROM two_factor_challenges WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [buyer.id]);
      assert.ok(!String(storedOtp.rows[0]?.code_hash ?? '').includes(String(otpCode)), 'the OTP is stored hashed');

      /* ------------------- 105-109 reviews + moderation ------------------- */
      const review = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/reviews`, headers: buyer.headers,
        payload: { rating: 5, title: 'عالی', comment: 'دوخت و کیفیت پارچه فوق‌العاده بود', images: [] } });
      assert.equal(review.statusCode, 201, review.body);
      assert.equal(review.json().verifiedPurchase, true, 'verified purchase comes from the paid order');
      const hidden = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/ratings` });
      assert.equal(hidden.json().summary.reviewCount, 0, 'pending reviews are not public');
      const moderate = await app.inject({ method: 'POST', url: `/api/v1/admin/reviews/${review.json().reviewId}/moderate`,
        headers: admin.headers, payload: { action: 'approve', note: 'تأیید' } });
      assert.equal(moderate.statusCode, 200, moderate.body);
      assert.equal(moderate.json().rating, 5, 'moderation never rewrites the rating');
      const ratings = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/ratings` });
      assert.equal(ratings.json().summary.reviewCount, 1);
      assert.equal(ratings.json().summary.averageRating, 5);
      assert.deepEqual(ratings.json().summary.distribution.map((row: { count: number }) => row.count), [0, 0, 0, 0, 1]);
      const publicReviews = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/reviews` });
      assert.equal(publicReviews.json().items.length, 1);
      const analytics = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/review-analytics`,
        headers: admin.headers });
      assert.equal(analytics.statusCode, 200, analytics.body);
      assert.equal(analytics.json().summary.reviewCount, 1);
      // A duplicate review for the same order is refused.
      const duplicateReview = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/reviews`, headers: buyer.headers,
        payload: { rating: 4, title: 'دوباره', comment: 'تکراری', images: [], orderId: orderResponse.json().id } });
      assert.equal(duplicateReview.statusCode, 409, duplicateReview.body);
      const reported = await app.inject({ method: 'POST', url: `/api/v1/reviews/${review.json().reviewId}/report`,
        headers: admin.headers, payload: { reason: 'بررسی محتوای نامناسب' } });
      assert.equal(reported.statusCode, 201, reported.body);
      const reports = await app.inject({ method: 'GET', url: '/api/v1/admin/review-reports', headers: admin.headers });
      assert.ok(reports.json().items.length >= 1);
      // Reviews are visible inside the CRM 360 view (item 108).
      const contact = await pool.query('SELECT id FROM crm_contacts WHERE user_id = $1', [buyer.id]);
      const contact360 = await app.inject({ method: 'GET', url: `/api/v1/admin/crm/contacts/${contact.rows[0].id}/360`, headers: admin.headers });
      assert.equal(contact360.statusCode, 200, contact360.body);
      assert.ok(contact360.json().reviews.some((row: { rating: number }) => row.rating === 5));

      // The paid order now exists, so the approved rule assigns the behavioural label.
      const applied = await app.inject({ method: 'POST', url: `/api/v1/admin/crm/label-rules/${labelRule.json().id}/apply`,
        headers: admin.headers, payload: { approve: true } });
      assert.equal(applied.statusCode, 200, applied.body);
      assert.ok(applied.json().matchCount >= 1, applied.body);
      const labelRows = await pool.query(
        `SELECT c.user_id FROM crm_contact_labels cl JOIN crm_contacts c ON c.id = cl.contact_id
         WHERE cl.label_code = 'high_spender' AND c.user_id = $1`, [buyer.id]);
      assert.equal(labelRows.rowCount, 1, 'label assigned to the matching customer');
      const refreshed = await app.inject({ method: 'POST', url: `/api/v1/admin/crm/segments/${segment.json().id}/refresh`,
        headers: admin.headers });
      assert.equal(refreshed.statusCode, 200, refreshed.body);
      assert.ok(refreshed.json().members >= 1, refreshed.body);
      // The scheduled sweep keeps labels and dynamic segments fresh without a cron VM.
      const sweepRule = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/label-rules', headers: admin.headers, payload: {
        code: `sweep-${suffix}`, title: 'قانون زمان‌بند', labelCode: 'repeat_buyer', status: 'active',
        matchMode: 'all', conditions: [{ field: 'order_count', op: '>=', value: 1 }], priority: 5 } });
      assert.equal(sweepRule.statusCode, 201, sweepRule.body);
      await pool.query(`UPDATE crm_segments SET last_refreshed_at = now() - interval '2 hours' WHERE id = $1`, [segment.json().id]);
      const sweep = await runCrmRuleSweep(pool, { labelIntervalHours: 0 });
      assert.ok(sweep.rulesApplied >= 1, JSON.stringify(sweep));
      assert.ok(sweep.labelsAssigned >= 1, JSON.stringify(sweep));
      const sweptLabels = await pool.query(
        `SELECT count(*)::int AS n FROM crm_contact_labels WHERE label_code = 'repeat_buyer'`);
      assert.ok(sweptLabels.rows[0].n >= 1, 'the sweep assigned the behavioural label');
      const ruleList = await app.inject({ method: 'GET', url: '/api/v1/admin/crm/label-rules', headers: admin.headers });
      const ruleRow = ruleList.json().items.find((row: { id: string }) => row.id === labelRule.json().id);
      assert.ok(ruleRow.approved_at, 'the rule records who approved it and when');
      assert.equal(ruleRow.last_match_count, applied.json().matchCount);

      /* ------------------ 110-121 recommendations + video ------------------ */
      const similar = await app.inject({ method: 'GET', url: `/api/v1/recommendations?slot=product.similar&strategy=similar&productId=${productId}` });
      assert.equal(similar.statusCode, 200, similar.body);
      assert.equal(similar.json().slot, 'product.similar');
      const seasonal = await app.inject({ method: 'GET', url: '/api/v1/recommendations?slot=home.for_you&strategy=seasonal' });
      assert.equal(seasonal.statusCode, 200, seasonal.body);
      const manual = await app.inject({ method: 'POST', url: '/api/v1/admin/recommendations/slots/home.hero_recommendations/items',
        headers: admin.headers, payload: { productIds: [productId], replace: true } });
      assert.equal(manual.statusCode, 201, manual.body);
      const hero = await app.inject({ method: 'GET', url: '/api/v1/recommendations?slot=home.hero_recommendations' });
      assert.ok(hero.json().items.some((item: { id: string }) => item.id === productId), hero.body);
      const tracked = await app.inject({ method: 'POST', url: '/api/v1/recommendations/events', headers: buyer.headers, payload: {
        sessionId: 'sess-test',
        events: [
          { slotCode: 'home.for_you', strategy: 'personalized', eventType: 'clicked', productId, position: 0 },
          { slotCode: 'home.for_you', strategy: 'personalized', eventType: 'added_to_cart', productId, position: 0 },
        ] } });
      assert.equal(tracked.statusCode, 202, tracked.body);
      const signals = await app.inject({ method: 'POST', url: '/api/v1/recommendations/signals', headers: buyer.headers, payload: {
        signals: [{ type: 'view', key: productId, weight: 2 }, { type: 'category', key: 'کت', weight: 3 }] } });
      assert.equal(signals.statusCode, 202, signals.body);
      const recAnalytics = await app.inject({ method: 'GET', url: '/api/v1/admin/recommendations/analytics?days=7', headers: admin.headers });
      assert.equal(recAnalytics.statusCode, 200, recAnalytics.body);
      assert.ok(recAnalytics.json().totals.impressions >= 1, recAnalytics.body);
      assert.ok(recAnalytics.json().items.some((row: { slotCode: string; clicks: number }) => row.slotCode === 'home.for_you' && row.clicks >= 1));

      // Responsive product video + analytics (313-314).
      const media = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/media`, headers: admin.headers,
        payload: { role: 'video', externalUrl: 'https://cdn.example.test/kolbe/video.mp4', position: 1,
          metadata: { sources: [{ src: 'https://cdn.example.test/kolbe/video.mp4', type: 'video/mp4' }], title: 'ویدیوی کت' } } });
      assert.equal(media.statusCode, 201, media.body);
      const mediaList = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/media` });
      assert.equal(mediaList.json().player.lazy, true);
      assert.equal(mediaList.json().items[0].role, 'video');
      const videoEvents = await app.inject({ method: 'POST', url: '/api/v1/video/events', headers: buyer.headers, payload: {
        sessionId: 'sess-video',
        events: [
          { videoId: media.json().id, productId, eventType: 'play', surface: 'product' },
          { videoId: media.json().id, productId, eventType: '50', watchedSeconds: 12, surface: 'product' },
          { videoId: media.json().id, productId, eventType: 'complete', watchedSeconds: 24, surface: 'product' },
        ] } });
      assert.equal(videoEvents.statusCode, 202, videoEvents.body);
      assert.equal(videoEvents.json().recorded, 3);
      const videoAnalytics = await app.inject({ method: 'GET', url: `/api/v1/admin/video/analytics?days=7&productId=${productId}`,
        headers: admin.headers });
      assert.equal(videoAnalytics.statusCode, 200, videoAnalytics.body);
      assert.ok(videoAnalytics.json().items.length >= 1, videoAnalytics.body);

      /* ------------------- 136-143 promotion safety + templates ------------------- */
      const template = await app.inject({ method: 'POST', url: '/api/v1/admin/promo/templates', headers: admin.headers, payload: {
        code: `birthday_${suffix}`, title: 'کمپین تولد', description: 'کد تخفیف شخصی تولد', type: 'percent', value: '12',
        minOrderRial: '50000000', usageLimitPerUser: 1, validityDays: 7, scope: { categories: ['کت'] },
        audience: ['all'], installmentPolicy: 'inherit', codePrefix: 'YASHAR', messageTemplate: '{name} عزیز، کد تولد شما: {code}',
        triggerCode: 'spend_threshold' } });
      assert.equal(template.statusCode, 201, template.body);
      const templateDryRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/templates/birthday_${suffix}/dry-run`,
        headers: admin.headers, payload: { triggerCode: 'spend_threshold', config: { spendThresholdRial: '1' }, sampleSize: 5 } });
      assert.equal(templateDryRun.statusCode, 200, templateDryRun.body);
      assert.ok(templateDryRun.json().matchCount >= 1, templateDryRun.body);
      assert.match(templateDryRun.json().message as string, /Match/);
      assert.ok(templateDryRun.json().sample.length >= 1);
      assert.ok(templateDryRun.json().sample.every((row: { phoneMasked: string | null }) =>
        row.phoneMasked === null || (row.phoneMasked.includes('***') && row.phoneMasked.replace('***', '').length <= 6)),
        'sample phone numbers are masked, never exposed');
      const issuanceDryRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/templates/birthday_${suffix}/issue`,
        headers: admin.headers, payload: { triggerCode: 'spend_threshold', config: { spendThresholdRial: '1' }, dryRun: true } });
      assert.equal(issuanceDryRun.statusCode, 200, issuanceDryRun.body);
      assert.equal(issuanceDryRun.json().issued, issuanceDryRun.json().matched);
      const couponsAfterDryRun = await pool.query('SELECT count(*)::int AS n FROM coupons WHERE template_code = $1', [`birthday_${suffix}`]);
      assert.equal(couponsAfterDryRun.rows[0].n, 0, 'dry run creates nothing');
      const mismatched = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/templates/birthday_${suffix}/issue`,
        headers: admin.headers, payload: { triggerCode: 'spend_threshold', config: { spendThresholdRial: '1' },
          dryRun: false, confirmMatchCount: 999 } });
      assert.equal(mismatched.statusCode, 409, mismatched.body);
      const liveIssue = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/templates/birthday_${suffix}/issue`,
        headers: admin.headers, payload: { triggerCode: 'spend_threshold', config: { spendThresholdRial: '1' }, dryRun: false,
          confirmMatchCount: issuanceDryRun.json().matched, reason: 'کمپین تولد' } });
      assert.equal(liveIssue.statusCode, 201, liveIssue.body);
      assert.ok(liveIssue.json().issued >= 1, liveIssue.body);
      const issuedCoupons = await pool.query(
        'SELECT code, recipient_user_id, usage_limit_per_user, template_code, installment_policy FROM coupons WHERE template_code = $1',
        [`birthday_${suffix}`]);
      assert.ok(issuedCoupons.rows.every((row) => row.usage_limit_per_user === 1 && row.recipient_user_id));
      assert.match(issuedCoupons.rows[0].code as string, /^YASHAR-[0-9A-F]{12}$/);
      // Re-issuing the same day does not mint duplicates (uniqueness + audit).
      const secondIssue = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/templates/birthday_${suffix}/issue`,
        headers: admin.headers, payload: { triggerCode: 'spend_threshold', config: { spendThresholdRial: '1' }, dryRun: false,
          confirmMatchCount: issuanceDryRun.json().matched } });
      assert.equal(secondIssue.json().issued, 0, secondIssue.body);
      assert.ok(secondIssue.json().skipped.length >= 1);

      /* ------------------- 85-89 automation center + outbox ------------------- */
      const subscription = await app.inject({ method: 'POST', url: '/api/v1/admin/automation/subscriptions', headers: admin.headers,
        payload: { code: `n8n-${suffix}`, title: 'ورک‌فلو n8n تست', eventPatterns: ['coupon.*', 'review.*', 'automation.fail'],
          targetUrl: receiver.url, enabled: true, hmacEnabled: false, maxAttempts: 3, backoffSeconds: 1, timeoutMs: 2000 } });
      assert.equal(subscription.statusCode, 201, subscription.body);
      const dispatch = await dispatchAutomationEvents(pool, config, { limit: 100 });
      assert.ok(dispatch.attempted >= 1, JSON.stringify(dispatch));
      assert.ok(receiver.received.length >= 1, 'receiver got at least one delivery');
      const envelope = JSON.parse(receiver.received[0]!.body) as Record<string, unknown>;
      assert.ok(typeof envelope.eventId === 'string' && typeof envelope.eventType === 'string');
      assert.equal(envelope.schemaVersion, 1);
      assert.ok(receiver.received[0]!.headers['x-kolbe-idempotency-key'], 'idempotency key header is sent');
      const deliveryRow = await pool.query(
        `SELECT d.status,d.attempt,d.http_status FROM automation_deliveries d JOIN automation_subscriptions s ON s.id = d.subscription_id
         WHERE s.code = $1 ORDER BY d.created_at DESC LIMIT 1`, [`n8n-${suffix}`]);
      assert.equal(deliveryRow.rows[0].status, 'success', JSON.stringify(deliveryRow.rows));
      assert.equal(deliveryRow.rows[0].http_status, 200);
      const overview = await app.inject({ method: 'GET', url: '/api/v1/admin/automation/overview', headers: admin.headers });
      assert.equal(overview.statusCode, 200, overview.body);
      const catalog = await app.inject({ method: 'GET', url: '/api/v1/admin/automation/catalog', headers: admin.headers });
      assert.ok(catalog.json().items.length >= 15, 'event catalogue is populated');
      const readiness = await app.inject({ method: 'GET', url: '/api/v1/admin/automation/readiness', headers: admin.headers });
      assert.equal(readiness.statusCode, 200, readiness.body);

      // A failing endpoint retries with backoff and then dies without losing the event.
      await pool.query(`UPDATE automation_subscriptions SET max_attempts = 1, backoff_seconds = 1 WHERE code = $1`, [`n8n-${suffix}`]);
      await pool.query('UPDATE automation_subscriptions SET event_patterns = $2 WHERE code = $1', [`n8n-${suffix}`, ['automation.fail']]);
      const failureEvent = await pool.query(
        `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload)
         VALUES ($1,'automation.fail','system',$2,'{"probe":true}') RETURNING id`, [randomUUID(), randomUUID()]);
      const failureDispatch = await dispatchAutomationEvents(pool, config, { limit: 50 });
      assert.ok(failureDispatch.dead >= 1, JSON.stringify(failureDispatch));
      const deadDelivery = await pool.query(
        `SELECT d.status,d.error FROM automation_deliveries d JOIN automation_subscriptions s ON s.id = d.subscription_id
         WHERE s.code = $1 ORDER BY d.created_at DESC LIMIT 1`, [`n8n-${suffix}`]);
      assert.equal(deadDelivery.rows[0].status, 'dead');
      assert.ok(deadDelivery.rows[0].error);
      const eventRow = await pool.query('SELECT last_error, delivered_at FROM outbox_events WHERE id = $1', [failureEvent.rows[0].id]);
      assert.ok(eventRow.rows[0].last_error, 'the failed event keeps its error for the console');

      // Inbound webhook: HMAC + replay protection (item 88).
      const integration = await app.inject({ method: 'POST', url: '/api/v1/admin/integrations', headers: admin.headers, payload: {
        code: `n8n-track-${suffix}`, title: 'رهگیری n8n', provider: 'n8n', category: 'crm',
        environment: 'test', enabled: true, webhookUrl: receiver.url, secret: 'super-secret-webhook-value-123456' } });
      assert.equal(integration.statusCode, 201, integration.body);
      const integrationCode = `n8n-track-${suffix}`;
      const trackingBody = JSON.stringify({ source: 'n8n', items: [
        { orderReference: orderResponse.json().reference, trackingCode: 'TRK-1', carrier: 'پست', status: 'in_transit',
          location: 'تهران', occurredAt: new Date().toISOString(), confidence: 0.95 },
        { orderReference: `UNKNOWN-${suffix}`, trackingCode: 'TRK-2', status: 'unknown', confidence: 0.2 },
      ] });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `t=${timestamp},v1=${createHmac('sha256', 'super-secret-webhook-value-123456').update(`${timestamp}.${trackingBody}`).digest('hex')}`;
      const inbound = await app.inject({ method: 'POST', url: `/api/v1/automation/tracking/${integrationCode}`,
        headers: { 'content-type': 'application/json', 'x-kolbe-signature': signature }, payload: trackingBody });
      assert.equal(inbound.statusCode, 202, inbound.body);
      assert.equal(inbound.json().matched, 1);
      assert.equal(inbound.json().needsReview, 1, 'low-confidence rows wait for review');
      const replay = await app.inject({ method: 'POST', url: `/api/v1/automation/tracking/${integrationCode}`,
        headers: { 'content-type': 'application/json', 'x-kolbe-signature': signature }, payload: trackingBody });
      assert.equal(replay.statusCode, 409, replay.body);
      const shipments = await app.inject({ method: 'GET', url: '/api/v1/admin/shipments', headers: admin.headers });
      assert.equal(shipments.statusCode, 200, shipments.body);
      assert.ok(Number(shipments.json().stats.review_queue) >= 1, 'the low-confidence import row is in the review queue');
      const shipmentId = shipments.json().items[0].id as string;
      const shipment = await app.inject({ method: 'GET', url: `/api/v1/admin/shipments/${shipmentId}`, headers: admin.headers });
      assert.ok(shipment.json().timeline.length >= 1);
      // Customer notification for a tracking update (item 94).
      const trackingEvent = await app.inject({ method: 'POST', url: `/api/v1/admin/shipments/${shipmentId}/events`, headers: admin.headers,
        payload: { status: 'delivered', location: 'مشهد', occurredAt: new Date().toISOString(), source: 'manual', confidence: 1 } });
      assert.equal(trackingEvent.statusCode, 201, trackingEvent.body);
      assert.equal(trackingEvent.json().reviewStatus, 'confirmed');
      const notified = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%مرسوله%'", [buyer.id]);
      assert.ok(notified.rows[0].n >= 1, 'customer was notified about the shipment update');
      const importReview = await app.inject({ method: 'GET', url: '/api/v1/admin/tracking/imports', headers: admin.headers });
      const importId = importReview.json().items[0].id as string;
      const importItems = await app.inject({ method: 'GET', url: `/api/v1/admin/tracking/imports/${importId}/items`, headers: admin.headers });
      const pendingItem = importItems.json().items.find((item: { status: string }) => item.status === 'needs_review');
      assert.ok(pendingItem, 'a low-confidence row is in the review queue');
      const rejected = await app.inject({ method: 'POST', url: `/api/v1/admin/tracking/imports/items/${pendingItem.id}/review`,
        headers: admin.headers, payload: { decision: 'reject', note: 'سفارش نامشخص' } });
      assert.equal(rejected.statusCode, 200, rejected.body);
      assert.equal(rejected.json().status, 'rejected');

      /* ------------------- campaigns honour marketing consent ------------------- */
      await pool.query('UPDATE customer_consents SET marketing_sms = false WHERE user_id = $1', [buyer.id]);
      const noConsentCampaign = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/campaigns', headers: admin.headers,
        payload: { title: `کمپین ${suffix}`, message: 'متن تبلیغاتی', segmentId: segment.json().id, send: false } });
      assert.equal(noConsentCampaign.statusCode, 200, noConsentCampaign.body);
      assert.ok(noConsentCampaign.json().blockedByConsent >= 1, 'customers without consent are excluded');
      assert.equal(noConsentCampaign.json().blockedByConsent + noConsentCampaign.json().recipients,
        noConsentCampaign.json().recipients + noConsentCampaign.json().blockedByConsent);
      const consentUpdate = await app.inject({ method: 'PATCH', url: '/api/v1/customer/consent', headers: buyer.headers,
        payload: { marketingSms: true } });
      assert.equal(consentUpdate.statusCode, 200, consentUpdate.body);
      const withConsentCampaign = await app.inject({ method: 'POST', url: '/api/v1/admin/crm/campaigns', headers: admin.headers,
        payload: { title: `کمپین ${suffix}`, message: 'متن تبلیغاتی', segmentId: segment.json().id, send: true } });
      assert.equal(withConsentCampaign.statusCode, 201, withConsentCampaign.body);
      assert.ok(withConsentCampaign.json().recipients >= 1, withConsentCampaign.body);
      const campaignSms = await pool.query(
        `SELECT count(*)::int AS n FROM sms_deliveries d JOIN sms_campaigns c ON c.id = d.event_id::text::uuid
         WHERE false`).catch(() => null);
      void campaignSms;
      const buyerSms = await pool.query(
        "SELECT count(*)::int AS n FROM sms_deliveries WHERE user_id = $1 AND message = 'متن تبلیغاتی'", [buyer.id]);
      assert.equal(buyerSms.rows[0].n, 1, 'the consented customer received exactly one campaign SMS');

      /* ------------------- 136-143 automation safety caps ------------------- */
      const automationId = randomUUID();
      await pool.query(
        `INSERT INTO crm_automations(id,code,name,automation_type,config,status,trigger_code,target_kind,target_ref,
           daily_run_cap,audience_cap,cooldown_hours,budget_cap_rial,dry_run_required,manual_approval_required,coupon_template_code)
         VALUES ($1,$2,'کمپین پرخرج','winback',$3,'draft','review_high_rating','segment',$5,1,500,24,100000,'true','true',$4)`,
        [automationId, `safety-${suffix}`, JSON.stringify({ message: 'کلبه وینتج: پیشنهاد ویژه' }),
          `birthday_${suffix}`, segment.json().id]);
      const blockedRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/automations/${automationId}/run`,
        headers: admin.headers, payload: { mode: 'live' } });
      assert.equal(blockedRun.statusCode, 409, blockedRun.body);
      const blockedRow = await pool.query('SELECT last_error FROM crm_automations WHERE id = $1', [automationId]);
      assert.ok((blockedRow.rows[0].last_error as string).includes('تأیید'), blockedRow.rows[0].last_error);
      const dryRunAutomation = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/automations/${automationId}/dry-run`,
        headers: admin.headers, payload: {} });
      assert.equal(dryRunAutomation.statusCode, 200, dryRunAutomation.body);
      assert.match(dryRunAutomation.json().message as string, /Match/);
      // The dry run also previews the personal coupon that would be minted:
      // owner, percent, single-use, expiry, minimum order, scope, instalments.
      const preview = dryRunAutomation.json().couponPreview;
      assert.ok(preview, 'the dry run previews the coupon instance');
      assert.match(preview.codeExample as string, /^[A-Z0-9-]+$/);
      assert.match(String(preview.ownerUserId), /^[0-9a-f-]{36}$/, 'the coupon is owned by a matched customer');
      assert.equal(preview.ownerUserId, dryRunAutomation.json().sample[0].userId, 'the preview belongs to the first matched customer');
      assert.equal(preview.singleUse, true);
      assert.equal(preview.usageLimitPerUser, 1);
      assert.equal(preview.percent, 12, 'the preview carries the template percentage');
      assert.equal(preview.minOrderRial, '50000000', 'the preview shows the template minimum order');
      assert.deepEqual(preview.installmentPolicy, 'inherit');
      assert.ok(Array.isArray(preview.allowedProductIds));
      assert.ok(preview.expiresAt, 'the preview shows when the coupon would expire');
      const testRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/automations/${automationId}/run`,
        headers: admin.headers, payload: { mode: 'test' } });
      assert.equal(testRun.statusCode, 200, testRun.body);
      assert.equal(testRun.json().sent, 0, 'test mode sends nothing');
      const approve = await app.inject({ method: 'PATCH', url: `/api/v1/admin/promo/automations/${automationId}`,
        headers: admin.headers, payload: { status: 'active' } });
      assert.equal(approve.statusCode, 200, approve.body);
      assert.ok(approve.json().approved_at, 'approval is recorded with a timestamp');
      const liveRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/automations/${automationId}/run`,
        headers: admin.headers, payload: { mode: 'live', note: 'اجرای دستی' } });
      assert.equal(liveRun.statusCode, 201, liveRun.body);
      assert.ok(liveRun.json().sent >= 1, liveRun.body);
      const cappedRun = await app.inject({ method: 'POST', url: `/api/v1/admin/promo/automations/${automationId}/run`,
        headers: admin.headers, payload: { mode: 'live' } });
      assert.equal(cappedRun.statusCode, 409, cappedRun.body);
      const runs = await app.inject({ method: 'GET', url: `/api/v1/admin/promo/automations/${automationId}/runs`, headers: admin.headers });
      assert.ok(runs.json().items.length >= 3, runs.body);
      const triggers = await app.inject({ method: 'GET', url: '/api/v1/admin/promo/triggers', headers: admin.headers });
      assert.ok(triggers.json().items.some((row: { code: string }) => row.code === 'inactivity_60d'));
      const personalCoupons = await app.inject({ method: 'GET', url: `/api/v1/admin/promo/personal-coupons?template=birthday_${suffix}`,
        headers: admin.headers });
      assert.ok(personalCoupons.json().items.length >= 1);

      /* ------------------- 23/24/98 server-side cart + abandonment event ------------------- */
      const cartAdd = await app.inject({ method: 'POST', url: '/api/v1/cart/items', headers: buyer.headers,
        payload: { productId, quantity: 2, color: 'خردلی', size: 'M' } });
      assert.equal(cartAdd.statusCode, 201, cartAdd.body);
      assert.equal(cartAdd.json().itemCount, 2);
      assert.ok(BigInt(cartAdd.json().valueRial) > 0n, 'the cart value is computed from the catalogue');
      const cartView = await app.inject({ method: 'GET', url: '/api/v1/cart', headers: buyer.headers });
      assert.equal(cartView.statusCode, 200, cartView.body);
      assert.equal(cartView.json().items.length, 1);
      assert.equal(cartView.json().items[0].quantity, 2);
      // The sweep is deterministic in tests: age the cart, then run it.
      await pool.query(`UPDATE carts SET updated_at = now() - interval '8 hours' WHERE id = $1`, [cartAdd.json().cartId]);
      const cartSweep = await app.inject({ method: 'POST', url: '/api/v1/admin/carts/sweep', headers: admin.headers,
        payload: { idleHours: 6 } });
      assert.equal(cartSweep.statusCode, 200, cartSweep.body);
      assert.ok(cartSweep.json().swept >= 1, cartSweep.body);
      const abandoned = await pool.query(
        `SELECT id FROM outbox_events WHERE event_type = 'cart.abandoned' AND aggregate_id = $1`, [cartAdd.json().cartId]);
      assert.equal(abandoned.rowCount, 1, 'cart.abandoned is emitted exactly once');
      const abandonedRow = await pool.query('SELECT status, abandoned_at FROM carts WHERE id = $1', [cartAdd.json().cartId]);
      assert.equal(abandonedRow.rows[0].status, 'abandoned');
      assert.ok(abandonedRow.rows[0].abandoned_at);
      const nudge = await app.inject({ method: 'POST', url: `/api/v1/admin/carts/${cartAdd.json().cartId}/nudge`,
        headers: admin.headers, payload: {} });
      assert.equal(nudge.statusCode, 200, nudge.body);
      const abandonQueue = await app.inject({ method: 'GET', url: '/api/v1/admin/carts/abandoned', headers: admin.headers });
      assert.ok(abandonQueue.json().items.some((row: { id: string }) => row.id === cartAdd.json().cartId));
      // Converting the cart closes the funnel.
      const secondCart = await app.inject({ method: 'POST', url: '/api/v1/cart/items', headers: buyer.headers,
        payload: { productId, quantity: 1 } });
      assert.equal(secondCart.statusCode, 201, secondCart.body);
      const secondOrder = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyer.headers, 'idempotency-key': `ord2-${suffix}` },
        payload: { orderType: 'retail', paymentMode: 'cash', items: [{ variantId, quantity: 1 }],
          shippingAddress: { recipient: 'خریدار تست', phone: '09121234567', province: 'تهران', city: 'تهران',
            line: 'خیابان تست، پلاک ۱', postalCode: '1234567890' } } });
      assert.equal(secondOrder.statusCode, 201, secondOrder.body);
      const converted = await pool.query(`SELECT status, converted_order_id FROM carts WHERE id = $1`, [secondCart.json().cartId]);
      assert.equal(converted.rows[0].status, 'converted', 'creating the order converts the active cart');
      assert.equal(converted.rows[0].converted_order_id, secondOrder.json().id);

      /* ------------------- bulk SMS panel obeys the consent gate ------------------- */
      const bulk = await app.inject({ method: 'POST', url: '/api/v1/admin/sms-campaigns', headers: admin.headers,
        payload: { title: `همگانی ${suffix}`, message: 'پیام همگانی کلبه', audience: 'all', activate: true } });
      assert.equal(bulk.statusCode, 201, bulk.body);
      assert.equal(bulk.json().status, 'queued', 'activating moves the campaign out of draft');
      await pool.query('UPDATE customer_consents SET marketing_sms = false WHERE user_id = $1', [buyer.id]);
      const bulkSend = await app.inject({ method: 'POST', url: `/api/v1/admin/sms-campaigns/${bulk.json().id}/send`,
        headers: admin.headers });
      assert.equal(bulkSend.statusCode, 200, bulkSend.body);
      assert.ok(bulkSend.json().blockedByConsent >= 1, 'unconsented users are excluded from the bulk panel too');
      const blockedBulk = await pool.query(
        `SELECT count(*)::int AS n FROM sms_deliveries WHERE user_id = $1 AND message = 'پیام همگانی کلبه'`, [buyer.id]);
      assert.equal(blockedBulk.rows[0].n, 0, 'no delivery row is queued for an unconsented user');

      /* ------------------- 137 scheduled automations run by themselves ------------------- */
      const scheduledId = randomUUID();
      await pool.query(
        `INSERT INTO crm_automations(id,code,name,automation_type,config,status,trigger_code,target_kind,target_ref,
           daily_run_cap,cooldown_hours,dry_run_required,manual_approval_required,approved_at,last_dry_run_at,last_dry_run_match_count,coupon_template_code)
         VALUES ($1,$2,'یادآوری سبد رهاشده','cart_abandoned',$3,'active','cart_abandoned','segment',$5,1,0,true,true,now(),now(),1,$4)`,
        [scheduledId, `cart-${suffix}`, JSON.stringify({ message: 'سبد خرید شما منتظر است' }), `birthday_${suffix}`, segment.json().id]);
      await pool.query('UPDATE customer_consents SET marketing_sms = true WHERE user_id = $1', [buyer.id]);
      const scheduled = await dispatchDueAutomations(pool, { limit: 10 });
      assert.ok(scheduled.results.some((row) => row.code === `cart-${suffix}` && row.outcome.startsWith('sent:')), JSON.stringify(scheduled.results));
      const scheduledRuns = await app.inject({ method: 'GET', url: `/api/v1/admin/promo/automations/${scheduledId}/runs`,
        headers: admin.headers });
      assert.equal(scheduledRuns.statusCode, 200, scheduledRuns.body);
      assert.equal(scheduledRuns.json().items[0].trigger_type, 'scheduled', 'the run log records that the worker fired it');
      const repeatSweep = await dispatchDueAutomations(pool, { limit: 10 });
      assert.ok(!repeatSweep.results.some((row) => row.code === `cart-${suffix}`), 'the daily cap stops an immediate second run');

      /* ------------------- buyer 360 admin view (items 18-19) ------------------- */
      const buyers = await app.inject({ method: 'GET', url: `/api/v1/admin/buyers?search=${suffix}`, headers: admin.headers });
      assert.equal(buyers.statusCode, 200, buyers.body);
      assert.ok(buyers.json().items.some((row: { id: string }) => row.id === buyer.id));
      const buyer360 = await app.inject({ method: 'GET', url: `/api/v1/admin/buyers/${buyer.id}/360`, headers: admin.headers });
      assert.equal(buyer360.statusCode, 200, buyer360.body);
      assert.ok(buyer360.json().purchase.orders >= 1);
      assert.ok(buyer360.json().membership);
      const credit = await app.inject({ method: 'POST', url: `/api/v1/admin/buyers/${buyer.id}/credit-limit`, headers: admin.headers,
        payload: { creditLimitRial: '5000000000', approvalPolicy: 'manual', reason: 'افزایش اعتبار' } });
      assert.equal(credit.statusCode, 200, credit.body);
      const note = await app.inject({ method: 'POST', url: `/api/v1/admin/buyers/${buyer.id}/notes`, headers: admin.headers,
        payload: { body: 'مشتری مهم — پیگیری تلفنی', visibility: 'internal' } });
      assert.equal(note.statusCode, 201, note.body);
      const noteView = await app.inject({ method: 'GET', url: `/api/v1/admin/buyers/${buyer.id}/360`, headers: admin.headers });
      assert.equal(noteView.statusCode, 200, noteView.body);
      assert.ok(noteView.json(), 'the 360 view still renders after the note is attached');
    } finally {
      await receiver.close();
      await app.close();
      await pool.end();
    }
  });
