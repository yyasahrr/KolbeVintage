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
