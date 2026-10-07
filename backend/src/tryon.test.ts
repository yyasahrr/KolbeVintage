import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, type DbPool } from './db.js';

const config: Config = {
  NODE_ENV: 'test', PORT: 4099, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  JWT_SECRET: 'tryon-test-secret-at-least-thirty-two-chars', PG_POOL_MAX: 2,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', COOKIE_SECURE: 'false', ALPHA_API_KEY: 'test-alpha-key-only',
};
const suffix = randomUUID().slice(0, 8);
const jobId = randomUUID();
let app: FastifyInstance;
let pool: DbPool;

function upload(productId: string) {
  const boundary = `----tryon${randomUUID().replace(/-/g, '')}`;
  const photo = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="productId"\r\n\r\n${productId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="person.png"\r\nContent-Type: image/png\r\n\r\n`),
    photo, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

if (process.env.TEST_DATABASE_URL) {
  before(async () => { app = await buildApp(config); pool = createPool(config); });
  after(async () => { await app.close(); await pool.end(); });
}

it('try-on sends two images to Qwen and protects the output by session', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const createUser = async (role: string) => {
    const id = randomUUID();
    const email = `tryon-${role}-${randomUUID().slice(0, 8)}@example.test`;
    const password = 'TryOnTestPassword123456!';
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',
      [id, email, await argon2.hash(password), role]);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password } });
    assert.equal(login.statusCode, 200, login.body);
    return { authorization: `Bearer ${login.json().accessToken as string}` };
  };
  const admin = await createUser('admin');
  const buyer = await createUser('customer');
  const otherBuyer = await createUser('customer');
  const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin, payload: {
    brand: 'کلبه', name: `کت تست پرو ${suffix}`, category: 'کت و پالتو', cashPriceRial: '40000000',
    variants: [{ size: 'M', color: 'شنی' }],
    metadata: { images: [{ url: 'https://example.com/coat.jpg' }], channels: { retail: true } },
  } });
  assert.equal(created.statusCode, 201, created.body);
  const productId = created.json().id as string;
  const published = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: admin, payload: { status: 'published' } });
  assert.equal(published.statusCode, 200, published.body);

  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-alpha-key-only');
    if (calls === 1) {
      assert.equal(String(input), 'https://api.appalpha.ir/v1/generations');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'qwen-image-edit');
      assert.match(body.image, /^data:image\/png;base64,/);
      assert.equal(body.image2, 'https://example.com/coat.jpg');
      return new Response(JSON.stringify({ id: jobId, status: 'processing', progress: { percent: 12 } }), { status: 202 });
    }
    assert.equal(String(input), `https://api.appalpha.ir/v1/generations/${jobId}`);
    return new Response(JSON.stringify({ id: jobId, status: 'ready', output: { url: 'https://example.com/result.png' } }), { status: 200 });
  };
  try {
    const form = upload(productId);
    const start = await app.inject({ method: 'POST', url: '/api/v1/tryon/jobs', headers: { ...buyer, ...form.headers }, payload: form.payload });
    assert.equal(start.statusCode, 202, start.body);
    assert.equal(start.json().status, 'processing');
    assert.equal(start.json().percent, 12);
    assert.ok(start.json().jobToken);
    assert.ok(!start.body.includes('data:image'));
    const token = start.json().jobToken as string;
    const denied = await app.inject({ method: 'POST', url: '/api/v1/tryon/jobs/status', headers: otherBuyer, payload: { token } });
    assert.equal(denied.statusCode, 401);
    assert.equal(calls, 1, 'unauthorized user must not poll the provider');
    const result = await app.inject({ method: 'POST', url: '/api/v1/tryon/jobs/status', headers: buyer, payload: { token } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().outputUrl, 'https://example.com/result.png');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

it('try-on credits (§42-§47, §199): packages, exactly-once grant, consumption', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { applyVerifiedPayment } = await import('./payments.js');
  const makeUser = async (role: string) => {
    const id = randomUUID();
    const email = `tryoncr-${role}-${randomUUID().slice(0, 8)}@example.test`;
    const password = 'TryOnCreditPassword123456!';
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',
      [id, email, await argon2.hash(password), role]);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password } });
    assert.equal(login.statusCode, 200, login.body);
    return { id, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
  };
  const admin = await makeUser('admin');
  const buyer = await makeUser('customer');

  // Admin configures a package (not hardcoded — §41/§47).
  const createdPack = await app.inject({ method: 'POST', url: '/api/v1/admin/tryon/packages', headers: admin.headers,
    payload: { name: `بسته تست ${suffix}`, credits: 2, priceRial: '500000' } });
  assert.equal(createdPack.statusCode, 201, createdPack.body);
  const packageId = createdPack.json().id as string;
  const adminList = await app.inject({ method: 'GET', url: '/api/v1/admin/tryon/packages', headers: admin.headers });
  assert.equal(adminList.statusCode, 200, adminList.body);
  assert.ok(adminList.json().items.some((p: { id: string }) => p.id === packageId));
  assert.equal(adminList.json().policy.salesEnabled, true);

  // Buyer sees packages + zero balance, then buys through the canonical payment pipeline.
  const shop = await app.inject({ method: 'GET', url: '/api/v1/tryon/packages', headers: buyer.headers });
  assert.equal(shop.statusCode, 200, shop.body);
  assert.equal(shop.json().balance, 0);
  const purchase = await app.inject({ method: 'POST', url: '/api/v1/tryon/purchases', headers: buyer.headers, payload: { packageId } });
  assert.equal(purchase.statusCode, 201, purchase.body);
  assert.match(purchase.json().reference as string, /^TRY-/);
  const intentId = purchase.json().paymentIntentId as string;
  assert.equal(purchase.json().amountRial, '500000');

  // Verified payment grants credits EXACTLY once (§199): replay = duplicate, no double grant.
  const paidAt = new Date();
  const verify = await applyVerifiedPayment(pool, { provider: 'nextpay', providerEventId: `evt-${suffix}-1`,
    providerReference: `ref-${suffix}-1`, intentId, amountRial: '500000', paidAt });
  assert.equal(verify.duplicate, false);
  const replay = await applyVerifiedPayment(pool, { provider: 'nextpay', providerEventId: `evt-${suffix}-1`,
    providerReference: `ref-${suffix}-1`, intentId, amountRial: '500000', paidAt });
  assert.equal(replay.duplicate, true);
  await assert.rejects(applyVerifiedPayment(pool, { provider: 'nextpay', providerEventId: `evt-${suffix}-2`,
    providerReference: `ref-${suffix}-2`, intentId, amountRial: '500000', paidAt }));
  const afterPay = await app.inject({ method: 'GET', url: '/api/v1/tryon/packages', headers: buyer.headers });
  assert.equal(afterPay.json().balance, 2, afterPay.body);
  const ledgerGrants = await pool.query(
    "SELECT COUNT(*)::int AS n FROM tryon_credit_ledger l JOIN tryon_credit_purchases c ON c.id = l.purchase_id WHERE c.payment_intent_id = $1 AND l.reason = 'purchase'", [intentId]);
  assert.equal(ledgerGrants.rows[0].n, 1, 'purchase credited exactly once');

  // Prepare a published product for generations.
  const created = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers, payload: {
    brand: 'کلبه', name: `شال تست اعتبار ${suffix}`, category: 'کت و پالتو', cashPriceRial: '10000000',
    variants: [{ size: 'M', color: 'کرم' }],
    metadata: { images: [{ url: 'https://example.com/shawl.jpg' }], channels: { retail: true } },
  } });
  assert.equal(created.statusCode, 201, created.body);
  const productId = created.json().id as string;
  await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: admin.headers, payload: { status: 'published' } });

  const realFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response(JSON.stringify({ id: randomUUID(), status: 'processing', progress: { percent: 5 } }), { status: 202 });
  };
  try {
    // Free quota (1) is granted once on first use, so 2 purchased + 1 free = 3 generations.
    for (let i = 0; i < 3; i += 1) {
      const form = upload(productId);
      const job = await app.inject({ method: 'POST', url: '/api/v1/tryon/jobs', remoteAddress: '10.77.0.1',
        headers: { ...buyer.headers, ...form.headers }, payload: form.payload });
      assert.equal(job.statusCode, 202, job.body);
    }
    assert.equal(providerCalls, 3);
    const depleted = await app.inject({ method: 'GET', url: '/api/v1/tryon/packages', headers: buyer.headers });
    assert.equal(depleted.json().balance, 0);
    assert.equal(depleted.json().freeGranted, true);
    // No credits left → generation blocked BEFORE touching the provider.
    const form = upload(productId);
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/tryon/jobs', remoteAddress: '10.77.0.2',
      headers: { ...buyer.headers, ...form.headers }, payload: form.payload });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json().code, 'TRYON_CREDITS_REQUIRED');
    assert.equal(providerCalls, 3, 'provider must not be called without credits');
  } finally { globalThis.fetch = realFetch; }

  // Honest finance view: real revenue, no fabricated AI cost (§45/§46).
  const finance = await app.inject({ method: 'GET', url: '/api/v1/admin/tryon/finance', headers: admin.headers });
  assert.equal(finance.statusCode, 200, finance.body);
  assert.ok(BigInt(finance.json().revenueRial as string) >= 500000n);
  assert.ok(finance.json().creditsConsumed >= 3);
  assert.notEqual(finance.json().costStatus, 'tracked');

  // Deactivated package cannot be bought; policy is admin-editable.
  const deactivate = await app.inject({ method: 'PATCH', url: `/api/v1/admin/tryon/packages/${packageId}`,
    headers: admin.headers, payload: { active: false } });
  assert.equal(deactivate.statusCode, 200, deactivate.body);
  const buyInactive = await app.inject({ method: 'POST', url: '/api/v1/tryon/purchases', headers: buyer.headers, payload: { packageId } });
  assert.equal(buyInactive.statusCode, 404, buyInactive.body);
  const policyUpdate = await app.inject({ method: 'PUT', url: '/api/v1/admin/tryon/policy', headers: admin.headers,
    payload: { freeQuota: 1 } });
  assert.equal(policyUpdate.statusCode, 200, policyUpdate.body);
  // Customers can never manage packages (RBAC).
  const forbidden = await app.inject({ method: 'POST', url: '/api/v1/admin/tryon/packages', headers: buyer.headers,
    payload: { name: 'نفوذ', credits: 1, priceRial: '1000' } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
});
