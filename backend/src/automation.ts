import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { decryptSecret, verifyHmacSignature } from './secrets.js';
import { automationReadiness, dispatchAutomationEvents, emitEvent, recordWebhookReceipt, verifySignedPayload } from './events.js';

/* Automation Center (items 85-89, 121).
   One admin surface for every outbound workflow connection (n8n today, other
   platforms later): connection status, webhooks, events, workflows, last run,
   success/failure counts, retry and error logs. Secrets are owned by the
   Integration Center and never travel to the browser (item 88). */

const subscriptionBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  title: z.string().trim().min(2).max(120),
  eventPatterns: z.array(z.string().trim().min(1).max(60)).min(1).max(60),
  integrationId: z.uuid().nullable().optional(),
  targetUrl: z.string().trim().max(400).nullable().optional(),
  enabled: z.boolean().default(true),
  hmacEnabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(500).max(30_000).default(5000),
  maxAttempts: z.number().int().min(1).max(20).default(5),
  backoffSeconds: z.number().int().min(1).max(3600).default(30),
  maxEventsPerMinute: z.number().int().min(1).max(6000).default(120),
}).strict();

const patchBody = subscriptionBody.omit({ code: true }).partial().strict();

const serializeSubscription = (row: Record<string, unknown>) => ({
  id: row.id, code: row.code, title: row.title, eventPatterns: row.event_patterns,
  integrationId: row.integration_id, targetUrl: row.target_url, enabled: row.enabled,
  hmacEnabled: row.hmac_enabled, timeoutMs: row.timeout_ms, maxAttempts: row.max_attempts,
  backoffSeconds: row.backoff_seconds, maxEventsPerMinute: row.max_events_per_minute,
  lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at, lastError: row.last_error,
  integrationTitle: row.integration_title ?? null, integrationStatus: row.integration_status ?? null,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export function registerAutomationRoutes(app: FastifyInstance, pool: DbPool, config: Config, fetcher: typeof fetch = fetch) {
  /** Requirement 85: the page header — connection, counters, last runs and error logs. */
  app.get('/api/v1/admin/automation/overview', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const connections = await pool.query(
      `SELECT id,code,title,provider,status,enabled,webhook_url,last_success_at,last_error,last_error_at,
              (SELECT count(*)::int FROM integration_logs l WHERE l.integration_id = i.id AND l.created_at > now() - interval '24 hours') AS logs_24h
       FROM integrations i WHERE category IN ('crm','other') ORDER BY code`);
    const deliveries = await one<{ success: string; failure: string; dead: string; pending: string; total: string }>(pool,
      `SELECT count(*) FILTER (WHERE status = 'success')::text AS success,
              count(*) FILTER (WHERE status = 'failure')::text AS failure,
              count(*) FILTER (WHERE status = 'dead')::text AS dead,
              count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*)::text AS total
       FROM automation_deliveries`);
    const events = await one<{ pending: string; delivered: string; failed: string; last_24h: string }>(pool,
      `SELECT count(*) FILTER (WHERE delivered_at IS NULL)::text AS pending,
              count(*) FILTER (WHERE delivered_at IS NOT NULL)::text AS delivered,
              count(*) FILTER (WHERE last_error IS NOT NULL)::text AS failed,
              count(*) FILTER (WHERE occurred_at > now() - interval '24 hours')::text AS last_24h
       FROM outbox_events`);
    const workflows = await pool.query(
      `SELECT s.id,s.code,s.title,s.event_patterns,s.enabled,s.last_success_at,s.last_failure_at,s.last_error,
              (SELECT count(*)::int FROM automation_deliveries d WHERE d.subscription_id = s.id AND d.status = 'success') AS success_count,
              (SELECT count(*)::int FROM automation_deliveries d WHERE d.subscription_id = s.id AND d.status IN ('failure','dead')) AS failure_count,
              (SELECT max(d.delivered_at) FROM automation_deliveries d WHERE d.subscription_id = s.id) AS last_run_at
       FROM automation_subscriptions s ORDER BY s.code`);
    const errors = await pool.query(
      `SELECT d.id,d.event_id,d.subscription_id,e.event_type,d.status,d.attempt,d.http_status,d.error,d.created_at,d.next_attempt_at,
              s.title AS subscription_title
       FROM automation_deliveries d JOIN outbox_events e ON e.id = d.event_id
       JOIN automation_subscriptions s ON s.id = d.subscription_id
       WHERE d.status IN ('failure','dead') ORDER BY d.created_at DESC LIMIT 20`);
    return {
      connections: connections.rows.map((row) => ({
        id: row.id, code: row.code, title: row.title, provider: row.provider, status: row.status,
        enabled: row.enabled, webhookUrl: row.webhook_url, lastSuccessAt: row.last_success_at,
        lastError: row.last_error, lastErrorAt: row.last_error_at, logs24h: row.logs_24h,
      })),
      counts: {
        deliveries: deliveries, events,
        workflows: workflows.rows.length,
        errorLogs: errors.rows.length,
      },
      workflows: workflows.rows.map(serializeSubscription),
      errors: errors.rows,
    };
  });

  /** Requirement 87: the published event contract that n8n workflows build against. */
  app.get('/api/v1/admin/automation/catalog', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const rows = await pool.query('SELECT * FROM automation_event_catalog WHERE active ORDER BY domain, event_type');
    const enrolled = await pool.query(
      `SELECT event_type, count(*)::int AS subscriptions FROM automation_subscriptions s, unnest(s.event_patterns) AS event_type
       WHERE s.enabled GROUP BY event_type`);
    return {
      schemaVersion: 1,
      contract: {
        event: 'event type, e.g. order.paid',
        eventId: 'uuid — stable idempotency key for the whole lifecycle of the event',
        occurredAt: 'ISO-8601 timestamp of the domain change',
        entity: { type: 'aggregate type', id: 'aggregate uuid' },
        data: 'event-specific payload',
        schemaVersion: 'integer, bumped on breaking payload changes',
      },
      signatures: {
        header: 'x-kolbe-signature',
        format: 't=<unix seconds>,v1=<hex hmac-sha256 of `${t}.${rawBody}`>',
        toleranceSeconds: 300,
        idempotencyHeader: 'x-kolbe-idempotency-key (eventId:subscriptionId — stable across retries)',
      },
      items: rows.rows,
      subscriptionsByEvent: enrolled.rows,
    };
  });

  app.get('/api/v1/admin/automation/subscriptions', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const rows = await pool.query(
      `SELECT s.*, i.title AS integration_title, i.status AS integration_status
       FROM automation_subscriptions s LEFT JOIN integrations i ON i.id = s.integration_id
       ORDER BY s.code`);
    return { items: rows.rows.map(serializeSubscription) };
  });

  app.post('/api/v1/admin/automation/subscriptions', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const body = subscriptionBody.parse(request.body);
    const id = randomUUID();
    return transaction(pool, async (client) => {
      if (body.integrationId) {
        const integration = await one(client, 'SELECT id FROM integrations WHERE id = $1', [body.integrationId]);
        if (!integration) throw notFound();
      }
      if (!body.integrationId && !body.targetUrl) throw badRequest('آدرس مقصد یا اتصال Integration لازم است.');
      await client.query(
        `INSERT INTO automation_subscriptions(id,code,title,event_patterns,integration_id,target_url,enabled,
           hmac_enabled,timeout_ms,max_attempts,backoff_seconds,max_events_per_minute,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, body.code, body.title, body.eventPatterns, body.integrationId ?? null, body.targetUrl ?? null, body.enabled,
          body.hmacEnabled, body.timeoutMs, body.maxAttempts, body.backoffSeconds, body.maxEventsPerMinute, user.id]);
      await audit(client, user.id, 'automation.subscription_created', 'automation_subscription', id, undefined,
        { code: body.code, eventPatterns: body.eventPatterns }, request.ip);
      const row = await one<Record<string, unknown>>(client,
        `SELECT s.*, i.title AS integration_title, i.status AS integration_status FROM automation_subscriptions s
         LEFT JOIN integrations i ON i.id = s.integration_id WHERE s.id = $1`, [id]);
      return reply.code(201).send(serializeSubscription(row!));
    });
  });

  app.patch('/api/v1/admin/automation/subscriptions/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM automation_subscriptions WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE automation_subscriptions SET title = COALESCE($2,title), event_patterns = COALESCE($3,event_patterns),
           integration_id = COALESCE($4,integration_id), target_url = COALESCE($5,target_url), enabled = COALESCE($6,enabled),
           hmac_enabled = COALESCE($7,hmac_enabled), timeout_ms = COALESCE($8,timeout_ms), max_attempts = COALESCE($9,max_attempts),
           backoff_seconds = COALESCE($10,backoff_seconds), max_events_per_minute = COALESCE($11,max_events_per_minute),
           updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.eventPatterns ?? null, body.integrationId ?? null, body.targetUrl ?? null,
          body.enabled ?? null, body.hmacEnabled ?? null, body.timeoutMs ?? null, body.maxAttempts ?? null,
          body.backoffSeconds ?? null, body.maxEventsPerMinute ?? null]);
      await audit(client, user.id, 'automation.subscription_updated', 'automation_subscription', id, before, body, request.ip);
      return serializeSubscription((await one<Record<string, unknown>>(client, 'SELECT * FROM automation_subscriptions WHERE id = $1', [id]))!);
    });
  });

  /** Test workflow: a real signed delivery to the configured endpoint. */
  app.post('/api/v1/admin/automation/subscriptions/:id/test', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const subscription = await one<{ id: string; code: string; title: string }>(pool,
      'SELECT id,code,title FROM automation_subscriptions WHERE id = $1', [id]);
    if (!subscription) throw notFound();
    const result = await transaction(pool, async (client) => {
      const emitted = await emitEvent(client, {
        eventType: 'automation.test', entityType: 'automation_subscription', entityId: id,
        payload: { subscription: subscription.code, requestedBy: user.id }, source: 'admin_test',
        actorId: user.id,
      });
      await audit(client, user.id, 'automation.test_sent', 'automation_subscription', id, undefined, { eventId: emitted.eventId }, request.ip);
      return emitted;
    });
    await dispatchAutomationEvents(pool, config, { limit: 20, fetcher });
    const delivery = await one<Record<string, unknown>>(pool,
      `SELECT d.*, e.event_type FROM automation_deliveries d JOIN outbox_events e ON e.id = d.event_id
       WHERE d.event_id = $1 AND d.subscription_id = $2`, [result.eventId, id]);
    return { eventId: result.eventId, delivery: delivery ? {
      id: delivery.id, status: delivery.status, attempt: delivery.attempt, httpStatus: delivery.http_status,
      error: delivery.error, durationMs: delivery.duration_ms,
    } : null };
  });

  app.get('/api/v1/admin/automation/events', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const query = z.object({
      type: z.string().max(60).optional(),
      status: z.enum(['all', 'pending', 'delivered', 'failed']).default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.id,e.event_type,e.aggregate_type,e.aggregate_id,e.schema_version,e.source,e.occurred_at,
              e.delivered_at,e.published_at,e.attempts,e.last_error,
              (SELECT count(*)::int FROM automation_deliveries d WHERE d.event_id = e.id AND d.status = 'success') AS success_count,
              (SELECT count(*)::int FROM automation_deliveries d WHERE d.event_id = e.id AND d.status IN ('failure','dead')) AS failure_count,
              (SELECT count(*)::int FROM automation_deliveries d WHERE d.event_id = e.id) AS delivery_count
       FROM outbox_events e
       WHERE ($1::text IS NULL OR e.event_type = $1)
         AND ($2 = 'all'
              OR ($2 = 'pending' AND e.delivered_at IS NULL)
              OR ($2 = 'delivered' AND e.delivered_at IS NOT NULL AND e.last_error IS NULL)
              OR ($2 = 'failed' AND e.last_error IS NOT NULL))
       ORDER BY e.occurred_at DESC LIMIT $3`,
      [query.type ?? null, query.status, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/automation/events/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const event = await one<Record<string, unknown>>(pool, 'SELECT * FROM outbox_events WHERE id = $1', [id]);
    if (!event) throw notFound();
    const deliveries = await pool.query(
      `SELECT d.*, s.code AS subscription_code, s.title AS subscription_title
       FROM automation_deliveries d JOIN automation_subscriptions s ON s.id = d.subscription_id
       WHERE d.event_id = $1 ORDER BY d.created_at`, [id]);
    const envelope = {
      event: event.event_type, eventId: event.id, schemaVersion: event.schema_version,
      occurredAt: event.occurred_at, entity: { type: event.aggregate_type, id: event.aggregate_id },
      data: event.payload, source: event.source,
    };
    return { event, envelope, deliveries: deliveries.rows };
  });

  /** Replay keeps the original event id so downstream idempotency still holds. */
  app.post('/api/v1/admin/automation/events/:id/replay', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const event = await one<Record<string, unknown>>(client, 'SELECT * FROM outbox_events WHERE id = $1 FOR UPDATE', [id]);
      if (!event) throw notFound();
      await client.query(
        `UPDATE automation_deliveries SET status = 'pending', next_attempt_at = now(), delivered_at = NULL, error = NULL
         WHERE event_id = $1`, [id]);
      await client.query('UPDATE outbox_events SET delivered_at = NULL, last_error = NULL WHERE id = $1', [id]);
      await audit(client, user.id, 'automation.event_replayed', 'outbox_event', id, undefined, { eventType: event.event_type }, request.ip);
      return { id, replayed: true };
    });
  });

  app.post('/api/v1/admin/automation/deliveries/:id/retry', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await transaction(pool, async (client) => {
      const delivery = await one<Record<string, unknown>>(client, 'SELECT * FROM automation_deliveries WHERE id = $1 FOR UPDATE', [id]);
      if (!delivery) throw notFound();
      if (delivery.status === 'success') throw conflict('این تحویل با موفقیت انجام شده است.');
      await client.query(
        `UPDATE automation_deliveries SET status = 'pending', next_attempt_at = now(), delivered_at = NULL, error = NULL
         WHERE id = $1`, [id]);
      await client.query('UPDATE outbox_events SET delivered_at = NULL WHERE id = $1', [delivery.event_id]);
      await audit(client, user.id, 'automation.delivery_retried', 'automation_delivery', id, undefined, { eventId: delivery.event_id }, request.ip);
      return { id, eventId: delivery.event_id };
    });
    await dispatchAutomationEvents(pool, config, { limit: 20, fetcher });
    const after = await one<Record<string, unknown>>(pool, 'SELECT status,attempt,http_status,error FROM automation_deliveries WHERE id = $1', [id]);
    return { ...result, delivery: after };
  });

  app.post('/api/v1/admin/automation/dispatch', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    return dispatchAutomationEvents(pool, config, { limit: 100, fetcher });
  });

  /** Requirement 121: a live readiness report instead of a promise in a document. */
  app.get('/api/v1/admin/automation/readiness', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'automation:manage');
    const catalog = await pool.query('SELECT event_type FROM automation_event_catalog WHERE active ORDER BY event_type');
    const byDomain = new Map<string, string[]>();
    for (const row of catalog.rows) {
      const domain = row.event_type.split('.')[0];
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), row.event_type]);
    }
    const webhookSubscriptions = await one<{ count: string }>(pool,
      'SELECT count(*)::text AS count FROM automation_subscriptions WHERE enabled');
    const items = [...byDomain.entries()].map(([domain, events]) => ({
      domain,
      ...automationReadiness({ emitsEvents: events, hasApi: true, hasWebhook: Number(webhookSubscriptions?.count ?? 0) > 0, idempotent: true, audited: true }),
    }));
    return { items, webhookSubscriptions: Number(webhookSubscriptions?.count ?? 0) };
  });

  /** Inbound automation webhook: signature + timestamp + replay protection (item 88). */
  app.post('/api/v1/automation/inbound/:code', { config: { rawBody: true } }, async (request, reply) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(request.params);
    const integration = await one<{
      id: string; code: string; secret_ciphertext: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null; enabled: boolean;
    }>(pool, 'SELECT id,code,secret_ciphertext,secret_iv,secret_tag,enabled FROM integrations WHERE code = $1', [code]);
    if (!integration) throw notFound();
    if (!integration.enabled) throw conflict('این اتصال غیرفعال است.');
    const raw = request.rawBody;
    if (!Buffer.isBuffer(raw)) throw badRequest('بدنه امضاشده در دسترس نیست.');
    const signature = request.headers['x-kolbe-signature'] ?? request.headers['x-signature'];
    const signatureValue = Array.isArray(signature) ? signature[0] : signature;
    if (!signatureValue || !integration.secret_ciphertext || !integration.secret_iv || !integration.secret_tag)
      throw badRequest('امضای وب‌هوک لازم است.');
    const secret = decryptSecret(config, {
      ciphertext: integration.secret_ciphertext, iv: integration.secret_iv, tag: integration.secret_tag,
    });
    const body = raw.toString('utf8');
    const timestamps = /t=(\d+)/.exec(signatureValue);
    const signedStyle = timestamps ? verifySignedPayload(secret, signatureValue, body) : null;
    const legacyOk = !signedStyle && verifyHmacSignature(secret, raw, signatureValue);
    if ((signedStyle && !signedStyle.valid) || (!signedStyle && !legacyOk)) {
      await pool.query(
        `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
         VALUES ($1,$2,'inbound','automation_webhook','rejected',$3,$4)`,
        [randomUUID(), integration.id, JSON.stringify({ signature: 'invalid' }),
          JSON.stringify({ reason: signedStyle?.reason ?? 'bad_signature' })]);
      throw conflict('امضای وب‌هوک معتبر نیست.');
    }
    const receipt = await recordWebhookReceipt(pool, integration.id, signatureValue, body);
    if (!receipt.accepted) throw conflict('این وب‌هوک قبلاً دریافت شده است (Replay Protection).');
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(body) as Record<string, unknown>; } catch { payload = { raw: body.slice(0, 1000) }; }
    const eventId = await transaction(pool, async (client) => {
      const emitted = await emitEvent(client, {
        eventType: typeof payload.event === 'string' ? `inbound.${payload.event}` : 'automation.inbound',
        entityType: 'integration', entityId: integration.id,
        payload, source: 'webhook',
      });
      await client.query(
        `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
         VALUES ($1,$2,'inbound','automation_webhook','success',$3,$4)`,
        [randomUUID(), integration.id, JSON.stringify({ bytes: raw.length }), JSON.stringify({ eventId: emitted.eventId })]);
      await client.query("UPDATE integrations SET sync_status = 'synced', last_success_at = now() WHERE id = $1", [integration.id]);
      return emitted.eventId;
    });
    return reply.code(202).send({ accepted: true, eventId });
  });
}
