import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { decryptSecret, encryptSecret, hintOf } from './secrets.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4007, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('integration center protects secrets, tests connections and verifies webhooks', { skip: !enabled }, async () => {
  // Secrets are encrypted and only hinted to humans.
  const secret = encryptSecret(config, 'super-secret-api-key-1234');
  assert.equal(decryptSecret(config, secret), 'super-secret-api-key-1234');
  assert.equal(secret.hint, hintOf('super-secret-api-key-1234'));
  assert.equal(secret.hint, '••••1234');

  let receivedAuth: string | undefined;
  const server = createServer((req, res) => {
    receivedAuth = req.headers['x-api-key'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `i-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `i-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const integration = await app.inject({ method: 'POST', url: '/api/v1/admin/integrations', headers, payload: {
      code: `digikala-${suffix}`, title: 'اتصال دیجی‌کالا', category: 'marketplace', provider: 'digikala',
      environment: 'test', enabled: true,
      config: { testUrl: `http://127.0.0.1:${port}/health`, authHeaderName: 'x-api-key' },
      secret: 'super-secret-api-key-1234',
    } });
    assert.equal(integration.statusCode, 201, integration.body);
    assert.equal(integration.json().hasSecret, true);
    assert.equal(integration.json().secretHint, '••••1234');
    assert.equal(JSON.stringify(integration.json()).includes('super-secret'), false);

    // Test connection runs over HTTP and delivers the decrypted secret only to the endpoint.
    const tested = await app.inject({ method: 'POST', url: `/api/v1/admin/integrations/${integration.json().id}/test`, headers });
    assert.equal(tested.statusCode, 200, tested.body);
    assert.equal(tested.json().status, 'success');
    assert.equal(tested.json().httpStatus, 200);
    assert.equal(receivedAuth, 'super-secret-api-key-1234');

    // A failing endpoint is logged and retriable with an incremented attempt.
    await app.inject({ method: 'PATCH', url: `/api/v1/admin/integrations/${integration.json().id}`, headers,
      payload: { config: { testUrl: 'http://127.0.0.1:1/unreachable', authHeaderName: 'x-api-key' } } });
    const failed = await app.inject({ method: 'POST', url: `/api/v1/admin/integrations/${integration.json().id}/test`, headers });
    assert.equal(failed.json().status, 'failure');
    const retried = await app.inject({ method: 'POST',
      url: `/api/v1/admin/integrations/${integration.json().id}/retry/${failed.json().logId}`, headers });
    assert.equal(retried.json().status, 'failure');
    assert.equal(retried.json().attempt, failed.json().attempt + 1);
    const logs = await app.inject({ method: 'GET', url: `/api/v1/admin/integrations/${integration.json().id}/logs`, headers });
    assert.ok(logs.json().items.length >= 3);

    // Inbound webhooks must carry a valid HMAC signature of the raw body.
    const body = JSON.stringify({ event: 'order.sync', ids: [1, 2] });
    const signature = createHmac('sha256', 'super-secret-api-key-1234').update(body).digest('hex');
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/integrations/webhook/digikala-${suffix}`,
      headers: { 'content-type': 'application/json', 'x-signature': signature }, payload: body });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/integrations/webhook/digikala-${suffix}`,
      headers: { 'content-type': 'application/json', 'x-signature': 'deadbeef'.repeat(8) }, payload: body });
    assert.equal(rejected.statusCode, 409, rejected.body);

    // Plaintext secrets never surface through the API or logs.
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/integrations', headers });
    assert.equal(JSON.stringify(list.json()).includes('super-secret'), false);
    const raw = await pool.query('SELECT secret_ciphertext FROM integrations WHERE id = $1', [integration.json().id]);
    assert.equal(raw.rows[0].secret_ciphertext.toString('utf8').includes('super-secret'), false);

    // Notification routes are manageable with priorities and roles (item 24).
    const routes = await app.inject({ method: 'GET', url: '/api/v1/admin/notification-routes', headers });
    assert.equal(routes.statusCode, 200, routes.body);
    const route = routes.json().items.find((item: { event_type: string }) => item.event_type === 'integration.error');
    assert.equal(route.priority, 'critical');
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/admin/notification-routes/${route.id}`, headers,
      payload: { priority: 'high', roles: ['admin'], channels: ['in_app'] } });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().priority, 'high');
  } finally {
    await app.close();
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
