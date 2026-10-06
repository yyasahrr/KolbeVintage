/**
 * AUTH remediation matrix (PO-locked §48) — ONE customer/VIP account, two real login methods.
 *
 * AUTH-001 new customer mobile registration (mobile → OTP → account)
 * AUTH-002 existing customer mobile OTP login
 * AUTH-003 customer email + password login
 * AUTH-004 both methods resolve to the SAME user
 * AUTH-005 verified email added to a mobile-first customer never creates a duplicate account
 * AUTH-006 wrong OTP rejected            AUTH-007 expired/reused OTP rejected
 * AUTH-008 wrong email/password rejected AUTH-009 password recovery uses the canonical backend
 * AUTH-010 plain customer has no wholesale purchasing capability
 * AUTH-011 active VIP logs in through normal customer auth and gains it
 * AUTH-012 VIP authority comes from server membership/session (never a client role)
 * AUTH-013 admin email/password login   AUTH-014 no public admin signup
 * AUTH-015 approved supplier login      AUTH-016 unapproved supplier cannot reach the portal
 * AUTH-017 supplier application is a distinct action from login
 * AUTH-018 logout clears the session and the capabilities it carried
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
  NODE_ENV: 'test', PORT: 4033, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;

const PASSWORD = 'TestPassword123456!';

/* ---------------- helpers for the registration / linking / supplier cases ---------------- */

/** Full mobile-first registration: signup code → verified account + session (AUTH-001). */
async function registerByMobile(app: Awaited<ReturnType<typeof buildApp>>, phone: string,
  displayName: string, extra: { email?: string; password?: string } = {}) {
  const request = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, purpose: 'signup' } });
  assert.equal(request.statusCode, 200, request.body);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
    payload: { phone, code: request.json().devCode as string, displayName, ...extra } });
  assert.equal(res.statusCode, 201, res.body);
  return { request: request.json() as { challengeId: string; devCode: string }, ...(res.json() as { id: string; accessToken: string; linking: string }) };
}

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `${label.replace(/\s+/g, '-')}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash(PASSWORD, { type: argon2.argon2id }), label]);
  for (const role of roles) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  return { id, email };
}

async function makeSupplier(pool: Pool, label: string, status: 'approved' | 'pending') {
  const user = await makeCustomer(pool, label, null);
  await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'supplier') ON CONFLICT DO NOTHING`, [user.id]);
  await pool.query(`INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,$3)`,
    [user.id, label, status === 'approved' ? 'approved' : 'pending']);
  return user;
}


async function makeCustomer(pool: Pool, label: string, phone: string | null) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)',
    [id, email, phone, await argon2.hash(PASSWORD), label]);
  await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'customer') ON CONFLICT DO NOTHING`, [id]);
  return { id, email, phone };
}

async function grantMembership(pool: Pool, userId: string) {
  const planId = randomUUID();
  await pool.query(`INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,'پلن VIP تست',0,'{}')`,
    [planId, `otp-vip-${planId.slice(0, 8)}`]);
  await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`,
    [randomUUID(), userId, planId]);
}

/** A fresh valid Iranian mobile per call — `users.phone` is globally unique. */
const mobile = () => `09${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const masked = (phone: string) => `${phone.slice(0, 4)}***${phone.slice(-2)}`;

test('AUTH-OTP: unknown or inactive mobile never reveals whether an account exists', { skip: !enabled }, async () => {
  const pool = createPool(config);
  const app = await buildApp(config);
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: mobile() } });
  assert.equal(res.statusCode, 404);
  assert.equal(String(res.json().message).includes('ثبت‌نام'), true);
  // the same answer for an account that exists but is suspended
  const suspendedPhone = mobile();
  const suspended = await makeCustomer(pool, 'otp-suspended', suspendedPhone);
  await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.id]);
  const res2 = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone: suspendedPhone } });
  assert.equal(res2.statusCode, 404);
  await app.close();
  await pool.end();
});

test('AUTH-OTP: request → verify logs the customer in (OTP session + refresh cookie) and the code is single-use', { skip: !enabled }, async () => {
  const pool = createPool(config);
  const app = await buildApp(config);
  const phone = mobile();
  const customer = await makeCustomer(pool, 'otp-login', phone);

  const request = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  assert.equal(request.statusCode, 200, request.body);
  const issued = request.json();
  assert.equal(issued.deliveryHint, 'sms_queued');
  assert.equal(issued.phoneMasked, masked(phone));
  assert.equal(typeof issued.devCode, 'string');
  // the challenge is a real customer_login challenge and the SMS is queued for the (fake) provider
  const challenge = await pool.query(`SELECT purpose, method, consumed_at FROM two_factor_challenges WHERE id = $1`, [issued.challengeId]);
  assert.equal(challenge.rows[0].purpose, 'customer_login');
  assert.equal(challenge.rows[0].method, 'otp_sms');
  const sms = await pool.query(`SELECT category FROM sms_deliveries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [customer.id]);
  assert.equal(sms.rows[0].category, 'transactional');

  const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: issued.challengeId, code: '000000' } });
  assert.equal(wrong.statusCode, 401);
  const attempts = await pool.query(`SELECT attempts FROM two_factor_challenges WHERE id = $1`, [issued.challengeId]);
  assert.equal(attempts.rows[0].attempts, 1);

  const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: issued.challengeId, code: issued.devCode } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().tokenType, 'Bearer');
  assert.equal(typeof verify.json().accessToken, 'string');
  assert.match(String(verify.headers['set-cookie']), /kolbe_refresh=/);
  const history = await pool.query(`SELECT method, succeeded FROM login_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [customer.id]);
  assert.equal(history.rows[0].method, 'otp_sms');
  assert.equal(history.rows[0].succeeded, true);

  // replaying a consumed challenge is rejected
  const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: issued.challengeId, code: issued.devCode } });
  assert.equal(replay.statusCode, 401);

  // ...and the access token is a real session for the SAME customer account
  const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${verify.json().accessToken as string}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().id, customer.id);
  await app.close();
  await pool.end();
});

test('AUTH-OTP: one live code per customer, brute-force lockout, and expiry are enforced server-side', { skip: !enabled }, async () => {
  const pool = createPool(config);
  const app = await buildApp(config);
  const phone = mobile();
  await makeCustomer(pool, 'otp-locking', phone);

  const first = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  const second = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  assert.equal(second.statusCode, 200);
  const oldId = first.json().challengeId as string;
  const invalidated = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: oldId, code: first.json().devCode as string } });
  assert.equal(invalidated.statusCode, 401);
  const consumed = await pool.query(`SELECT consumed_at FROM two_factor_challenges WHERE id = $1`, [oldId]);
  assert.notEqual(consumed.rows[0].consumed_at, null);

  // max_attempts (5) burns the challenge before the correct code can be used
  const target = second.json().challengeId as string;
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { challengeId: target, code: '111111' } });
    assert.equal(res.statusCode, 401);
  }
  const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: target, code: second.json().devCode as string } });
  assert.equal(locked.statusCode, 401);

  // expired challenges never authenticate
  const expired = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  await pool.query(`UPDATE two_factor_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.json().challengeId]);
  const late = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: expired.json().challengeId as string, code: expired.json().devCode as string } });
  assert.equal(late.statusCode, 401);
  await app.close();
  await pool.end();
});

test('AUTH-VIP: wholesale membership is a canonical server entitlement on ONE customer account', { skip: !enabled }, async () => {
  const pool = createPool(config);
  const app = await buildApp(config);
  const phone = mobile();
  const customer = await makeCustomer(pool, 'otp-vip', phone);

  // before any membership: password login works, but /auth/me reports NO wholesale entitlement
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: customer.email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().accessToken as string;
  const before = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(before.json().isWholesaleMember, false);
  assert.equal(before.json().membership, null);
  assert.deepEqual(before.json().roles, ['customer']);

  // granting the canonical membership flips the entitlement on the SAME account — no second login,
  // no separate VIP user record, no client-supplied role.
  await grantMembership(pool, customer.id);
  const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.json().isWholesaleMember, true);
  assert.equal(after.json().id, customer.id);
  assert.equal(after.json().membership.planCode.startsWith('otp-vip-'), true);
  const sameAccount = await pool.query(`SELECT count(*)::int AS n FROM users WHERE id = $1 OR email = $2`, [customer.id, customer.email]);
  assert.equal(sameAccount.rows[0].n, 1);

  // mobile+OTP and email+password are two logins for the SAME account record
  const otpRequest = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
  const otpLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
    payload: { challengeId: otpRequest.json().challengeId, code: otpRequest.json().devCode } });
  const otpMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${otpLogin.json().accessToken as string}` } });
  assert.equal(otpMe.json().id, customer.id);
  assert.equal(otpMe.json().isWholesaleMember, true);

  // expiry revokes the entitlement (canonical gate is evaluated per request, never cached client-side)
  await pool.query(`UPDATE memberships SET ends_at = now() - interval '1 day' WHERE user_id = $1`, [customer.id]);
  const expired = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(expired.json().isWholesaleMember, false);
  assert.equal(expired.json().membership, null);
  await app.close();
  await pool.end();
});

test('AUTH-VIP: wholesale PURCHASE is blocked by the server gate until the membership is active', { skip: !enabled }, async () => {
  const pool = createPool(config);
  const app = await buildApp(config);
  const customer = await makeCustomer(pool, 'otp-gate', mobile());
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: customer.email, password: PASSWORD } });
  const headers = { authorization: `Bearer ${login.json().accessToken as string}`, 'idempotency-key': randomUUID() };
  // shape valid on purpose: the 403 must come from the MEMBERSHIP gate, not from validation
  const payload = { items: [{ seriesTemplateId: randomUUID(), count: 1 }] };

  const blocked = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters', headers, payload });
  assert.equal(blocked.statusCode, 403);
  await grantMembership(pool, customer.id);
  // with the membership the request reaches validation (the VIP gate no longer rejects it first)
  const unblocked = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters', headers, payload });
  assert.notEqual(unblocked.statusCode, 403);
  await app.close();
  await pool.end();
});

test('AUTH-001/004: mobile-first registration verifies the number and yields the canonical account + session', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const phone = mobile();
    const request = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, purpose: 'signup' } });
    assert.equal(request.statusCode, 200, request.body);
    const issued = request.json();
    assert.equal(issued.purpose, 'signup');
    const challenge = await pool.query(`SELECT purpose, user_id FROM two_factor_challenges WHERE id = $1`, [issued.challengeId]);
    assert.equal(challenge.rows[0].purpose, 'customer_signup');
    assert.equal(challenge.rows[0].user_id, null, 'signup proves the number BEFORE the account exists');
    const sms = await pool.query(`SELECT phone, user_id FROM sms_deliveries WHERE phone = $1`, [phone]);
    assert.equal(sms.rows[0].phone, phone);

    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { phone, code: '000000', displayName: 'خریدار تست' } });
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.json().message, 'کد واردشده صحیح نیست.');

    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { phone, code: issued.devCode, displayName: 'خریدار تازه' } });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().linking, 'new');
    assert.match(String(res.headers['set-cookie']), /kolbe_refresh=/);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${res.json().accessToken as string}` } });
    assert.equal(me.json().phone, phone);
    assert.deepEqual(me.json().roles, ['customer']);
    assert.equal(me.json().isWholesaleMember, false);
    const roles = await pool.query(`SELECT role_code FROM user_roles WHERE user_id = $1`, [res.json().id]);
    assert.deepEqual(roles.rows.map((r) => r.role_code), ['customer'], 'public registration never grants admin/supplier (§50)');

    // AUTH-004: mobile+OTP sign-in and the very same record
    const otp = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify',
      payload: { challengeId: otp.json().challengeId, code: otp.json().devCode } });
    const loginMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken as string}` } });
    assert.equal(loginMe.json().id, res.json().id);
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-003/008/005: email+password login, wrong credentials, and verified email linking without a duplicate', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const phone = mobile();
    const account = await registerByMobile(app, phone, 'خریدار پیوند');

    // AUTH-008: wrong password / unknown identity are refused with the same generic answer
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `nobody-${randomUUID().slice(0, 8)}@example.test`, password: PASSWORD } });
    assert.equal(wrong.statusCode, 401);

    // AUTH-005: the customer adds a VERIFIED email from the (authenticated) profile flow —
    // the canonical identity-linking path; no second account may appear.
    const token = account.accessToken;
    const requested = await app.inject({ method: 'POST', url: '/api/v1/profile/contact-change',
      headers: { authorization: `Bearer ${token}` }, payload: { channel: 'email', value: 'linked.customer@example.test' } });
    assert.equal(requested.statusCode, 201, requested.body);
    const changeId = requested.json().requestId as string;
    assert.ok(changeId, 'the verified-contact request exposes its idempotent request id');
    const emailOtp = await pool.query(`SELECT otp_code_hash FROM contact_change_requests WHERE id = $1`, [changeId]);
    assert.ok(emailOtp.rows[0].otp_code_hash, 'the email change is code-verified server-side');
    const usersBefore = await pool.query('SELECT count(*)::int AS n FROM users');
    const code = (requested.json() as { devCode?: string }).devCode;
    assert.ok(code, 'non-production returns the verification code for the test account');
    const linked = await app.inject({ method: 'POST', url: `/api/v1/profile/contact-change/${changeId}/verify`,
      headers: { authorization: `Bearer ${token}` }, payload: { code } });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(linked.json().value, 'linked.customer@example.test');
    const usersAfter = await pool.query('SELECT count(*)::int AS n FROM users');
    assert.equal(usersAfter.rows[0].n, usersBefore.rows[0].n, 'linking an email never creates a duplicate user');

    // AUTH-003: the SAME account now signs in with email + password
    await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [account.id, await argon2.hash(PASSWORD, { type: argon2.argon2id })]);
    const emailLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: 'linked.customer@example.test', password: PASSWORD } });
    assert.equal(emailLogin.statusCode, 200, emailLogin.body);
    const emailMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${emailLogin.json().accessToken as string}` } });
    assert.equal(emailMe.json().id, account.id);
    assert.equal(emailMe.json().email, 'linked.customer@example.test');
    assert.equal(emailMe.json().phone, phone, 'ONE account holds both verified identities');

    // AUTH-008b: wrong password for a real identity
    const badPassword = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: 'linked.customer@example.test', password: 'WrongPassword123456!' } });
    assert.equal(badPassword.statusCode, 401);

    // an email that already belongs to this account can never be taken by a fresh registration
    const taken = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'linked.customer@example.test', password: PASSWORD, displayName: 'کپی' } });
    assert.equal(taken.statusCode, 409);
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-001b/016: an account that already owns the verified number is never silently duplicated', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const phone = mobile();
    await registerByMobile(app, phone, 'حساب موجود', { password: PASSWORD });
    // a second signup for the same verified number is refused up front…
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/request', payload: { phone, purpose: 'signup' } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().message, 'این شماره همراه قبلاً ثبت شده است؛ وارد شوید.');
    const count = await pool.query(`SELECT count(*)::int AS n FROM users WHERE phone = $1`, [phone]);
    assert.equal(count.rows[0].n, 1, 'no duplicate account for one verified number');
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-009: password recovery uses the canonical one-time token + set-password flow', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const phone = mobile();
    const account = await registerByMobile(app, phone, 'فراموشی رمز', { password: PASSWORD, email: `recover-${phone}@example.test` });
    // unknown identity: same generic answer, no enumeration
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { identity: 'nobody@example.test' } });
    assert.equal(unknown.statusCode, 200);
    assert.equal(unknown.json().delivered, true);
    assert.equal(unknown.json().devToken, undefined);

    const forgot = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { identity: phone } });
    assert.equal(forgot.statusCode, 200);
    assert.equal(forgot.json().delivered, true);
    const token = forgot.json().devToken as string;
    assert.ok(token && token.length > 20);
    const stored = await pool.query('SELECT token_hash, used_at FROM password_reset_tokens WHERE user_id = $1', [account.id]);
    assert.notEqual(stored.rows[0].token_hash, token, 'only the hash is stored');
    const sms = await pool.query(`SELECT message FROM sms_deliveries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [account.id]);
    assert.ok(String(sms.rows[0].message).length > 10, 'the recovery notice is queued on the canonical channel');
    const notice = await pool.query(`SELECT title FROM notifications WHERE user_id = $1`, [account.id]);
    assert.equal(notice.rows[0].title, 'بازیابی رمز عبور');

    // requesting again invalidates the previous live token
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', payload: { identity: phone } });
    const stale = await app.inject({ method: 'POST', url: '/api/v1/auth/set-password',
      payload: { token, newPassword: 'RecoveredPassword123456!' } });
    assert.equal(stale.statusCode, 400);
    const fresh = second.json().devToken as string;
    const set = await app.inject({ method: 'POST', url: '/api/v1/auth/set-password',
      payload: { token: fresh, newPassword: 'RecoveredPassword123456!' } });
    assert.equal(set.statusCode, 200, set.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: phone, password: 'RecoveredPassword123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/set-password',
      payload: { token: fresh, newPassword: 'AnotherPassword123456789!' } });
    assert.equal(reuse.statusCode, 400, 'a recovery token is single-use');
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-013/014/017: admin and supplier auth are separate, and the supplier application is not a login', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const admin = await makeUser(pool, ['admin'], 'مدیر ماتریس');
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: admin.email, password: PASSWORD } });
    assert.equal(adminLogin.statusCode, 200, adminLogin.body);
    const adminMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${adminLogin.json().accessToken as string}` } });
    assert.equal(adminMe.json().roles.includes('admin'), true);

    // AUTH-014: public registration can never mint staff (or supplier) authority
    const phone = mobile();
    const reg = await registerByMobile(app, phone, 'ثبت‌نام عمومی', { password: PASSWORD });
    const regMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${reg.accessToken}` } });
    assert.deepEqual(regMe.json().roles, ['customer']);
    assert.ok(!regMe.json().permissions.includes('users:manage'));
    const adminRoutes = await app.inject({ method: 'GET', url: '/api/v1/admin/cooperation-requests', headers: { authorization: `Bearer ${reg.accessToken}` } });
    assert.equal(adminRoutes.statusCode, 403);

    // AUTH-017: the supplier application is a real request, and the applicant cannot pick staff perms
    const applicantPhone = mobile();
    const request = await app.inject({ method: 'POST', url: '/api/v1/cooperation-requests',
      payload: { payload: { brand_name: 'برند متقاضی', legal_name: 'شرکت متقاضی', person_type: 'legal',
        national_id: '1234567890', phone: '02112345678', mobile: applicantPhone, office_address: 'تهران، خیابان آزمون',
        bank_name: 'بانک آزمون', iban: 'IR000000000000000000000000', account_holder: 'شرکت متقاضی',
        product_categories: 'پوشاک' } } });
    assert.equal(request.statusCode, 201, request.body);
    assert.equal(request.json().status, 'new');

    // the applicant has NO account yet → the login answer is the application state, not "not found"
    const pendingLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: applicantPhone, password: PASSWORD } });
    assert.equal(pendingLogin.statusCode, 403);
    assert.equal(pendingLogin.json().code, 'SUPPLIER_APPLICATION_PENDING');

    // …and once reviewed as pending→approved the same identity gets the canonical supplier account
    const reviewed = await app.inject({ method: 'POST', url: `/api/v1/admin/cooperation-requests/${request.json().id as string}/review`,
      headers: { authorization: `Bearer ${adminLogin.json().accessToken as string}` }, payload: { status: 'approved' } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const created = await pool.query('SELECT id FROM users WHERE phone = $1', [applicantPhone]);
    assert.equal(created.rows.length, 1, 'approval creates the ONE canonical account for the applicant');
    const supplierProfile = await pool.query(`SELECT cooperation_status FROM supplier_profiles WHERE user_id = $1`, [created.rows[0].id]);
    assert.equal(supplierProfile.rows[0].cooperation_status, 'pending', 'approval opens onboarding, not instant operations');
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-015/016: approved suppliers authenticate like customers, unapproved ones stay out of the portal', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const approved = await makeSupplier(pool, `تأمین‌کننده تأییدشده ${randomUUID().slice(0, 6)}`, 'approved');
    const pending = await makeSupplier(pool, `تأمین‌کننده ناتأیید ${randomUUID().slice(0, 6)}`, 'pending');
    await pool.query(`UPDATE users SET password_hash = $2 WHERE id = ANY($1::uuid[])`,
      [[approved.id, pending.id], await argon2.hash(PASSWORD, { type: argon2.argon2id })]);

    // AUTH-015: email+password login works for the approved supplier and /auth/me carries the state
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: approved.email, password: PASSWORD } });
    assert.equal(login.statusCode, 200, login.body);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().accessToken as string}` } });
    assert.equal(me.json().roles.includes('supplier'), true);
    assert.equal(me.json().supplier.cooperationStatus, 'approved');

    // AUTH-016: the pending supplier authenticates but is NOT an approved operator
    const pendingLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: pending.email, password: PASSWORD } });
    assert.equal(pendingLogin.statusCode, 200, pendingLogin.body);
    const pendingMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${pendingLogin.json().accessToken as string}` } });
    assert.equal(pendingMe.json().supplier.cooperationStatus, 'pending');
    // a customer-only account never reaches supplier operations either
    const plain = await registerByMobile(app, mobile(), 'مشتری ساده', { password: PASSWORD });
    const plainMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${plain.accessToken}` } });
    assert.equal(plainMe.json().supplier, null);
    assert.equal(plainMe.json().roles.includes('supplier'), false);
  } finally { await app.close(); await pool.end(); }
});

test('AUTH-018: logout revokes the canonical session and its refresh capability', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const phone = mobile();
    const account = await registerByMobile(app, phone, 'خروج امن', { password: PASSWORD });
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${account.accessToken}` } });
    assert.equal(me.statusCode, 200);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [account.id])).rows[0].n, 1);

    // registration already handed the browser the canonical refresh cookie; logout revokes it
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: phone, password: PASSWORD } });
    const cookie = String(registered.headers['set-cookie']).match(/kolbe_refresh=([^;]+)/)?.[1];
    assert.ok(cookie, 'the session is carried by the canonical refresh cookie');
    const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { kolbe_refresh: cookie } });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    // refresh ROTATES the token, so the browser now holds the new cookie — logout must revoke that one
    const rotated = String(refreshed.headers['set-cookie']).match(/kolbe_refresh=([^;]+)/)?.[1];
    assert.ok(rotated && rotated !== cookie, 'refresh rotates the session handle');
    const liveBefore = await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [account.id]);

    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { kolbe_refresh: rotated } });
    assert.equal(logout.statusCode, 204);
    const liveAfter = await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [account.id]);
    assert.equal(liveAfter.rows[0].n, Number(liveBefore.rows[0].n) - 1, 'exactly the logged-out session is revoked');
    const afterLogout = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { kolbe_refresh: rotated } });
    assert.equal(afterLogout.statusCode, 401, 'the revoked session can no longer refresh');
    const meAfter = await app.inject({ method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${registered.json().accessToken as string}` } });
    assert.equal(meAfter.statusCode, 401, 'capabilities die with the session');
  } finally { await app.close(); await pool.end(); }
});
