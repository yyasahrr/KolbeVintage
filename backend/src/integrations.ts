import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { decryptSecret, encryptSecret, verifyHmacSignature } from './secrets.js';

/* Integration Center / API management (item 23): connections, environments,
   test-connection, webhooks, callbacks, sync status, logs and retries. */

const integrationBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  title: z.string().trim().min(2).max(120),
  category: z.enum(['payment', 'sms', 'shipping', 'marketplace', 'finance', 'crm', 'other']),
  provider: z.string().trim().max(60).default('generic'),
  environment: z.enum(['test', 'production']).default('test'),
  enabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.string().min(4).max(2000).optional(),
  webhookUrl: z.string().max(300).optional(),
  callbackUrl: z.string().max(300).optional(),
}).strict();

const integrationPatch = integrationBody.omit({ code: true }).partial().strict();

const routePatch = z.object({
  roles: z.array(z.string().trim().max(40)).max(20).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  channels: z.array(z.enum(['in_app', 'sms', 'email'])).max(5).optional(),
  active: z.boolean().optional(),
}).strict();

type IntegrationRow = {
  id: string; code: string; title: string; category: string; provider: string; environment: string;
  enabled: boolean; config: Record<string, unknown>; secret_ciphertext: Buffer | null; secret_iv: Buffer | null;
  secret_tag: Buffer | null; secret_hint: string | null; status: string; last_success_at: Date | null;
  last_error: string | null; last_error_at: Date | null; webhook_url: string | null; callback_url: string | null;
  sync_status: string; created_at: Date; updated_at: Date;
};

const masked = (row: IntegrationRow) => ({
  id: row.id, code: row.code, title: row.title, category: row.category, provider: row.provider,
  environment: row.environment, enabled: row.enabled, config: row.config,
  hasSecret: row.secret_ciphertext !== null, secretHint: row.secret_hint,
  status: row.status, lastSuccessAt: row.last_success_at, lastError: row.last_error, lastErrorAt: row.last_error_at,
  webhookUrl: row.webhook_url, callbackUrl: row.callback_url, syncStatus: row.sync_status,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

async function runTestConnection(pool: DbPool, config: Config, integration: IntegrationRow, httpFetch: typeof fetch,
  actor: { id: string }, ip: string) {
  const testUrl = typeof integration.config.testUrl === 'string' ? integration.config.testUrl : null;
  const logId = randomUUID();
  const attemptRow = await one<{ attempt: number }>(pool,
    'SELECT COALESCE(max(attempt), 0)::int AS attempt FROM integration_logs WHERE integration_id = $1 AND action = $2',
    [integration.id, 'test_connection']);
  const attempt = (attemptRow?.attempt ?? 0) + 1;
  if (!testUrl) {
    await pool.query(
      `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary,attempt)
       VALUES ($1,$2,'outbound','test_connection','failure',$3,$4,$5)`,
      [logId, integration.id, JSON.stringify({}), JSON.stringify({ error: 'testUrl در پیکربندی ثبت نشده است.' }), attempt]);
    await pool.query("UPDATE integrations SET status = 'error', last_error = $2, last_error_at = now() WHERE id = $1",
      [integration.id, 'testUrl در پیکربندی ثبت نشده است.']);
    throw badRequest('برای تست اتصال ابتدا testUrl را در پیکربندی این اتصال ثبت کنید.');
  }
  let status: 'success' | 'failure' = 'failure';
  let httpStatus: number | null = null;
  let responseSummary: Record<string, unknown> = {};
  let errorMessage: string | null = null;
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const authHeaderName = typeof integration.config.authHeaderName === 'string' ? integration.config.authHeaderName : null;
    if (authHeaderName && integration.secret_ciphertext && integration.secret_iv && integration.secret_tag) {
      headers[authHeaderName] = decryptSecret(config, {
        ciphertext: integration.secret_ciphertext, iv: integration.secret_iv, tag: integration.secret_tag,
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await httpFetch(testUrl, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timer);
    httpStatus = response.status;
    status = response.ok ? 'success' : 'failure';
    responseSummary = { httpStatus: response.status, ok: response.ok };
    if (!response.ok) errorMessage = `پاسخ HTTP ${response.status}`;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'ارتباط برقرار نشد.';
    responseSummary = { error: errorMessage };
  }
  await pool.query(
    `INSERT INTO integration_logs(id,integration_id,direction,action,status,http_status,request_summary,response_summary,attempt)
     VALUES ($1,$2,'outbound','test_connection',$3,$4,$5,$6,$7)`,
    [logId, integration.id, status, httpStatus, JSON.stringify({ url: testUrl }), JSON.stringify(responseSummary), attempt]);
  if (status === 'success') {
    await pool.query("UPDATE integrations SET status = 'connected', last_success_at = now(), last_error = NULL, last_error_at = NULL WHERE id = $1", [integration.id]);
  } else {
    await pool.query("UPDATE integrations SET status = 'error', last_error = $2, last_error_at = now() WHERE id = $1", [integration.id, errorMessage]);
  }
  await transaction(pool, (client) => audit(client, actor.id, 'integration.tested', 'integration', integration.id, undefined,
    { status, httpStatus }, ip));
  return { id: integration.id, logId, status, httpStatus, error: errorMessage, attempt };
}

export function registerIntegrationRoutes(app: FastifyInstance, pool: DbPool, config: Config, httpFetch: typeof fetch = fetch) {
  app.get('/api/v1/admin/integrations', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const rows = await pool.query('SELECT * FROM integrations ORDER BY category, code');
    return { items: rows.rows.map(masked) };
  });

  app.post('/api/v1/admin/integrations', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const body = integrationBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      const secret = body.secret ? encryptSecret(config, body.secret) : null;
      await client.query(
        `INSERT INTO integrations(id,code,title,category,provider,environment,enabled,config,
           secret_ciphertext,secret_iv,secret_tag,secret_hint,webhook_url,callback_url,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, body.code, body.title, body.category, body.provider, body.environment, body.enabled,
          JSON.stringify(body.config), secret?.ciphertext ?? null, secret?.iv ?? null, secret?.tag ?? null,
          secret?.hint ?? null, body.webhookUrl ?? null, body.callbackUrl ?? null, user.id]);
      await audit(client, user.id, 'integration.created', 'integration', id, undefined,
        { code: body.code, hasSecret: !!body.secret }, request.ip);
    });
    const row = await one<IntegrationRow>(pool, 'SELECT * FROM integrations WHERE id = $1', [id]);
    return reply.code(201).send(masked(row!));
  });

  app.patch('/api/v1/admin/integrations/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = integrationPatch.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<IntegrationRow>(client, 'SELECT * FROM integrations WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const secret = body.secret ? encryptSecret(config, body.secret) : null;
      await client.query(
        `UPDATE integrations SET title = COALESCE($2, title), category = COALESCE($3, category),
           provider = COALESCE($4, provider), environment = COALESCE($5, environment),
           enabled = COALESCE($6, enabled), config = COALESCE($7, config),
           secret_ciphertext = COALESCE($8, secret_ciphertext), secret_iv = COALESCE($9, secret_iv),
           secret_tag = COALESCE($10, secret_tag), secret_hint = COALESCE($11, secret_hint),
           webhook_url = COALESCE($12, webhook_url), callback_url = COALESCE($13, callback_url),
           updated_at = now()
         WHERE id = $1`,
        [id, body.title ?? null, body.category ?? null, body.provider ?? null, body.environment ?? null,
          body.enabled ?? null, body.config ? JSON.stringify(body.config) : null,
          secret?.ciphertext ?? null, secret?.iv ?? null, secret?.tag ?? null, secret?.hint ?? null,
          body.webhookUrl ?? null, body.callbackUrl ?? null]);
      // Audit shows what changed but never the secret value.
      await audit(client, user.id, 'integration.updated', 'integration', id,
        { enabled: before.enabled, environment: before.environment, config: before.config },
        { enabled: body.enabled, environment: body.environment, config: body.config, secretChanged: !!body.secret }, request.ip);
      const row = await one<IntegrationRow>(client, 'SELECT * FROM integrations WHERE id = $1', [id]);
      return masked(row!);
    });
  });

  /** Test connection over HTTP with the protected credential (never logged). */
  app.post('/api/v1/admin/integrations/:id/test', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const integration = await one<IntegrationRow>(pool, 'SELECT * FROM integrations WHERE id = $1', [id]);
    if (!integration) throw notFound();
    return runTestConnection(pool, config, integration, httpFetch, user, request.ip);
  });

  app.get('/api/v1/admin/integrations/:id/logs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,direction,action,status,http_status,request_summary,response_summary,attempt,created_at
       FROM integration_logs WHERE integration_id = $1 ORDER BY created_at DESC LIMIT $2`, [id, query.limit]);
    return { items: rows.rows };
  });

  /** Retry keeps the original log and appends a new attempt (item 23). */
  app.post('/api/v1/admin/integrations/:id/retry/:logId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'integrations:manage');
    const params = z.object({ id: z.uuid(), logId: z.uuid() }).parse(request.params);
    const previous = await one<{ id: string; action: string; attempt: number; request_summary: Record<string, unknown> }>(pool,
      'SELECT id, action, attempt, request_summary FROM integration_logs WHERE id = $1 AND integration_id = $2',
      [params.logId, params.id]);
    if (!previous) throw notFound();
    if (previous.action === 'test_connection') {
      const integration = await one<IntegrationRow>(pool, 'SELECT * FROM integrations WHERE id = $1', [params.id]);
      if (!integration) throw notFound();
      return runTestConnection(pool, config, integration, httpFetch, user, request.ip);
    }
    const retryId = randomUUID();
    await pool.query(
      `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary,attempt)
       VALUES ($1,$2,'outbound',$3,'retry',$4,$5,$6)`,
      [retryId, params.id, previous.action, JSON.stringify(previous.request_summary),
        JSON.stringify({ retriedFrom: previous.id }), previous.attempt + 1]);
    await transaction(pool, (client) => audit(client, user.id, 'integration.retried', 'integration', params.id,
      { logId: previous.id }, { retryId, attempt: previous.attempt + 1 }, request.ip));
    return { id: retryId, status: 'retry', attempt: previous.attempt + 1 };
  });

  /** Signed inbound webhook receiver; the secret is verified, never displayed. */
  app.post('/api/v1/integrations/webhook/:code', { config: { rawBody: true } }, async (request, reply) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(request.params);
    const integration = await one<IntegrationRow>(pool, 'SELECT * FROM integrations WHERE code = $1', [code]);
    if (!integration) throw notFound();
    const raw = request.rawBody;
    const signature = request.headers['x-signature'];
    const logId = randomUUID();
    const hasSecret = integration.secret_ciphertext !== null && integration.secret_iv !== null && integration.secret_tag !== null;
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;
    const verified = hasSecret && Buffer.isBuffer(raw) && signatureValue !== undefined && verifyHmacSignature(
      decryptSecret(config, {
        ciphertext: integration.secret_ciphertext!, iv: integration.secret_iv!, tag: integration.secret_tag!,
      }), raw, signatureValue);
    if (!verified) {
      await pool.query(
        `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
         VALUES ($1,$2,'inbound','webhook','rejected',$3,$4)`,
        [logId, integration.id, JSON.stringify({ headers: { 'x-signature': signatureValue ? 'provided' : 'missing' } }),
          JSON.stringify({ reason: 'invalid_signature' })]);
      throw conflict('امضای وب‌هوک معتبر نیست.');
    }
    let payload: unknown = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = { raw: raw.toString('utf8').slice(0, 500) }; }
    await pool.query(
      `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
       VALUES ($1,$2,'inbound','webhook','success',$3,$4)`,
      [logId, integration.id, JSON.stringify({ bytes: raw.length }), JSON.stringify({ payload })]);
    await pool.query("UPDATE integrations SET sync_status = 'synced', last_success_at = now() WHERE id = $1", [integration.id]);
    return reply.code(202).send({ accepted: true, logId });
  });

  app.get('/api/v1/admin/notification-routes', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'notifications:manage');
    const rows = await pool.query('SELECT * FROM notification_routes ORDER BY event_type');
    return { items: rows.rows };
  });

  app.patch('/api/v1/admin/notification-routes/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'notifications:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = routePatch.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM notification_routes WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE notification_routes SET roles = COALESCE($2, roles), priority = COALESCE($3, priority),
           channels = COALESCE($4, channels), active = COALESCE($5, active), updated_at = now() WHERE id = $1`,
        [id, body.roles ?? null, body.priority ?? null, body.channels ?? null, body.active ?? null]);
      await audit(client, user.id, 'notification_route.updated', 'notification_route', id, before, body, request.ip);
      return one(client, 'SELECT * FROM notification_routes WHERE id = $1', [id]);
    });
  });
}
