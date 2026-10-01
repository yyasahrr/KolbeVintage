import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { one, type DbClient, type DbPool } from './db.js';
import { decryptSecret } from './secrets.js';

/* Automation event contract + outbound delivery (items 85-89, 121).
 *
 * Every domain event is written to the `outbox_events` table inside the same
 * transaction as the state change (item 89), carries a stable contract
 * (eventId/eventType/occurredAt/entity/payload/schemaVersion — item 87) and is
 * delivered to the registered workflow endpoints with HMAC signature, timestamp,
 * replay-safe idempotency key, timeout, backoff and an error log (item 88). */

export type EventEnvelope = {
  event: string;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  entity: { type: string; id: string };
  data: Record<string, unknown>;
  source: string;
};

export type EmitEventInput = {
  eventType: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
  schemaVersion?: number;
  source?: string;
  actorId?: string | null;
  occurredAt?: Date;
};

/** Emit inside an existing transaction — the event can never outlive a rollback. */
export async function emitEvent(client: DbClient, input: EmitEventInput) {
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload,schema_version,occurred_at,source,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9)`,
    [eventId, input.eventType, input.entityType, input.entityId, JSON.stringify(input.payload ?? {}),
      input.schemaVersion ?? 1, input.occurredAt ?? null, input.source ?? 'domain', input.actorId ?? null]);
  return { eventId, eventType: input.eventType, entityType: input.entityType, entityId: input.entityId };
}

export type OutboxRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  schema_version: number;
  occurred_at: Date;
  source: string;
  attempts: number;
  delivered_at: Date | null;
  published_at: Date | null;
};

export const toEnvelope = (row: OutboxRow): EventEnvelope => ({
  event: row.event_type,
  eventId: row.id,
  eventType: row.event_type,
  schemaVersion: row.schema_version,
  occurredAt: new Date(row.occurred_at).toISOString(),
  entity: { type: row.aggregate_type, id: row.aggregate_id },
  data: row.payload ?? {},
  source: row.source,
});

/** `order.*` matches `order.paid`; an exact pattern matches itself. */
export function matchesEventPattern(pattern: string, eventType: string): boolean {
  if (pattern === '*' || pattern === eventType) return true;
  if (pattern.endsWith('.*')) return eventType.startsWith(`${pattern.slice(0, -1)}`);
  return false;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Verify a `t=…,v1=…` signature with a bounded clock tolerance (replay window). */
export function verifySignedPayload(secret: string, signature: string, body: string,
  toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): { valid: boolean; reason?: string } {
  const parts = Object.fromEntries(signature.split(',').map((piece) => piece.split('=', 2) as [string, string]));
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return { valid: false, reason: 'malformed_signature' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp_out_of_tolerance' };
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  if (provided.length !== expected.length) return { valid: false, reason: 'bad_signature' };
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.equals(b) ? { valid: true } : { valid: false, reason: 'bad_signature' };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type SubscriptionRow = {
  id: string; code: string; target_url: string | null; integration_id: string | null;
  hmac_enabled: boolean; timeout_ms: number; max_attempts: number; backoff_seconds: number;
  max_events_per_minute: number; event_patterns: string[];
  secret_ciphertext: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null;
};

const subscriptionSecret = (config: Config, row: SubscriptionRow): string | null => {
  if (row.secret_ciphertext && row.secret_iv && row.secret_tag) {
    return decryptSecret(config, { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag });
  }
  return null;
};

/** Create the delivery rows for every pending event whose type matches an active
 *  subscription. Events without a matching subscription are closed immediately so
 *  the outbox does not grow forever. */
export async function ensureDeliveries(pool: DbPool, limit = 50) {
  const events = await pool.query<OutboxRow>(
    `SELECT id,event_type,aggregate_type,aggregate_id,payload,schema_version,occurred_at,source,attempts,delivered_at,published_at
     FROM outbox_events WHERE delivered_at IS NULL ORDER BY occurred_at DESC LIMIT $1`, [limit]);
  let created = 0;
  for (const event of events.rows) {
    const subscriptions = await pool.query<{ id: string; max_events_per_minute: number; recent: string; event_patterns: string[] }>(
      `SELECT s.id, s.max_events_per_minute, s.event_patterns,
              (SELECT count(*)::text FROM automation_deliveries d
                WHERE d.subscription_id = s.id AND d.created_at > now() - interval '1 minute') AS recent
       FROM automation_subscriptions s WHERE s.enabled`);
    const matching = subscriptions.rows.filter((row) =>
      row.event_patterns.some((pattern) => matchesEventPattern(pattern, event.event_type))
      && Number(row.recent) < row.max_events_per_minute * 5);
    if (!matching.length) {
      await pool.query('UPDATE outbox_events SET delivered_at = now() WHERE id = $1 AND delivered_at IS NULL', [event.id]);
      continue;
    }
    for (const subscription of matching) {
      const result = await pool.query(
        `INSERT INTO automation_deliveries(id,event_id,subscription_id,status,next_attempt_at)
         VALUES ($1,$2,$3,'pending',now()) ON CONFLICT (event_id, subscription_id) DO NOTHING`,
        [randomUUID(), event.id, subscription.id]);
      created += result.rowCount ?? 0;
    }
  }
  return { events: events.rows.length, created };
}

async function dueDeliveries(pool: DbPool, limit: number) {
  const rows = await pool.query<{
    id: string; event_id: string; subscription_id: string; attempt: number;
  } & Record<string, unknown>>(
    `SELECT d.id,d.event_id,d.subscription_id,d.attempt
     FROM automation_deliveries d
     WHERE d.status IN ('pending','failure') AND d.next_attempt_at <= now()
     ORDER BY d.next_attempt_at LIMIT $1`, [limit]);
  return rows.rows;
}

/** Deliver due attempts. Returns counts so the worker and the admin "run now"
 *  action report the same numbers. */
export async function processDeliveries(pool: DbPool, config: Config, options: { limit?: number; fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  const due = await dueDeliveries(pool, options.limit ?? 25);
  const result = { attempted: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const delivery of due) {
    const subscription = await one<SubscriptionRow>(pool,
      `SELECT s.*, i.secret_ciphertext, i.secret_iv, i.secret_tag
       FROM automation_subscriptions s LEFT JOIN integrations i ON i.id = s.integration_id
       WHERE s.id = $1`, [delivery.subscription_id]);
    const event = await one<OutboxRow>(pool, 'SELECT * FROM outbox_events WHERE id = $1', [delivery.event_id]);
    if (!subscription || !event) continue;
    const targetUrl = subscription.target_url;
    if (!targetUrl) {
      await pool.query(
        `UPDATE automation_deliveries SET status = 'skipped', attempt = attempt + 1, error = $2,
           next_attempt_at = NULL, delivered_at = now() WHERE id = $1`,
        [delivery.id, 'آدرس مقصد برای این اشتراک ثبت نشده است.']);
      continue;
    }
    const envelope = toEnvelope(event);
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = subscriptionSecret(config, subscription);
    const signature = subscription.hmac_enabled && secret ? signPayload(secret, timestamp, body) : null;
    const attempt = delivery.attempt + 1;
    const startedAt = Date.now();
    let httpStatus: number | null = null;
    let error: string | null = null;
    let responseSummary: Record<string, unknown> = {};
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), subscription.timeout_ms);
      const response = await fetcher(targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kolbe-event': event.event_type,
          'x-kolbe-event-id': event.id,
          'x-kolbe-schema-version': String(event.schema_version),
          'x-kolbe-delivery-id': delivery.id,
          'x-kolbe-idempotency-key': `${event.id}:${subscription.id}`,
          'x-kolbe-attempt': String(attempt),
          ...(signature ? { 'x-kolbe-signature': signature } : {}),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      httpStatus = response.status;
      const text = await response.text().catch(() => '');
      responseSummary = { httpStatus: response.status, body: text.slice(0, 500) };
      if (!response.ok) error = `پاسخ HTTP ${response.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'ارتباط با مقصد برقرار نشد.';
      responseSummary = { error };
    }
    result.attempted += 1;
    const duration = Date.now() - startedAt;
    if (!error) {
      result.succeeded += 1;
      await pool.query(
        `UPDATE automation_deliveries SET status = 'success', attempt = $2, http_status = $3, duration_ms = $4,
           response_summary = $5, error = NULL, signature = $6, next_attempt_at = NULL, delivered_at = now() WHERE id = $1`,
        [delivery.id, attempt, httpStatus, duration, JSON.stringify(responseSummary), signature]);
      await pool.query('UPDATE automation_subscriptions SET last_success_at = now(), last_error = NULL WHERE id = $1',
        [subscription.id]);
      await writeIntegrationLog(pool, subscription.integration_id, delivery.event_id, event.event_type, 'success', httpStatus, duration,
        responseSummary, attempt);
    } else {
      const exhausted = attempt >= subscription.max_attempts;
      const nextAttempt = new Date(Date.now() + subscription.backoff_seconds * 1000 * Math.min(2 ** (attempt - 1), 32));
      if (exhausted) result.dead += 1; else result.failed += 1;
      await pool.query(
        `UPDATE automation_deliveries SET status = $2, attempt = $3, http_status = $4, duration_ms = $5,
           response_summary = $6, error = $7, signature = $8, next_attempt_at = $9 WHERE id = $1`,
        [delivery.id, exhausted ? 'dead' : 'failure', attempt, httpStatus, duration, JSON.stringify(responseSummary),
          error, signature, exhausted ? null : nextAttempt]);
      await pool.query('UPDATE automation_subscriptions SET last_failure_at = now(), last_error = $2 WHERE id = $1',
        [subscription.id, error]);
      await writeIntegrationLog(pool, subscription.integration_id, delivery.event_id, `${event.event_type}:attempt-${attempt}`,
        exhausted ? 'failure' : 'retry', httpStatus, duration, responseSummary, attempt);
    }
    const statuses = await one<{ pending: string; succeeded: string }>(pool,
      `SELECT count(*) FILTER (WHERE status IN ('pending','failure'))::text AS pending,
              count(*) FILTER (WHERE status = 'success')::text AS succeeded
       FROM automation_deliveries WHERE event_id = $1`, [delivery.event_id]);
    const pending = Number(statuses?.pending ?? 0);
    const succeeded = Number(statuses?.succeeded ?? 0);
    if (pending === 0 && succeeded > 0) {
      await pool.query('UPDATE outbox_events SET delivered_at = now(), last_error = NULL WHERE id = $1 AND delivered_at IS NULL',
        [delivery.event_id]);
    } else if (pending === 0) {
      // Every subscriber failed: the event stays in the console as failed so it can be replayed.
      await pool.query('UPDATE outbox_events SET last_error = COALESCE($2,last_error) WHERE id = $1', [delivery.event_id, error]);
    } else if (error) {
      await pool.query('UPDATE outbox_events SET last_error = $2 WHERE id = $1', [delivery.event_id, error]);
    }
  }
  return result;
}

async function writeIntegrationLog(pool: DbPool, integrationId: string | null, eventId: string, action: string,
  status: 'success' | 'failure' | 'retry', httpStatus: number | null, duration: number,
  responseSummary: Record<string, unknown>, attempt: number) {
  if (!integrationId) return;
  await pool.query(
    `INSERT INTO integration_logs(id,integration_id,direction,action,status,http_status,request_summary,response_summary,attempt)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), integrationId, action, status, httpStatus, JSON.stringify({ eventId, durationMs: duration }),
      JSON.stringify(responseSummary), attempt]);
}

/** One dispatcher pass: materialise deliveries, then process what is due. */
export async function dispatchAutomationEvents(pool: DbPool, config: Config,
  options: { limit?: number; fetcher?: typeof fetch } = {}) {
  const ensured = await ensureDeliveries(pool, options.limit ?? 50);
  const processed = await processDeliveries(pool, config, options);
  return { ...ensured, ...processed };
}

/** Inbound replay protection (item 88): a signature may only be accepted once. */
export async function recordWebhookReceipt(pool: DbPool, integrationId: string, signature: string, rawBody: string) {
  const signatureHash = sha256(signature);
  const payloadHash = sha256(rawBody);
  const inserted = await pool.query(
    `INSERT INTO automation_webhook_receipts(id,integration_id,signature_hash,payload_hash,timestamp_header)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (integration_id, signature_hash) DO NOTHING`,
    [randomUUID(), integrationId, signatureHash, payloadHash, signature.split(',')[0] ?? null]);
  if (!inserted.rowCount) {
    await pool.query(
      `UPDATE automation_webhook_receipts SET is_replay = true WHERE integration_id = $1 AND signature_hash = $2`,
      [integrationId, signatureHash]);
    return { accepted: false, replay: true };
  }
  return { accepted: true, replay: false };
}

export type AutomationIntegrityCheck = { ok: boolean; checks: Array<{ item: string; ok: boolean; note: string }> };

/** Requirement 121: every feature reports whether it is automation-ready. */
export function automationReadiness(input: {
  emitsEvents: string[]; hasApi: boolean; hasWebhook: boolean; idempotent: boolean; audited: boolean;
}): AutomationIntegrityCheck {
  const checks = [
    { item: 'event', ok: input.emitsEvents.length > 0, note: input.emitsEvents.join(', ') || 'رویدادی ثبت نشده' },
    { item: 'api', ok: input.hasApi, note: input.hasApi ? 'دارد' : 'ندارد' },
    { item: 'webhook', ok: input.hasWebhook, note: input.hasWebhook ? 'قابل اتصال به n8n' : 'ندارد' },
    { item: 'idempotency', ok: input.idempotent, note: input.idempotent ? 'کلید تکرار دارد' : 'ندارد' },
    { item: 'audit', ok: input.audited, note: input.audited ? 'ثبت شده' : 'ثبت نشده' },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}
