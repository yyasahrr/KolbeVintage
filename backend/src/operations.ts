import { createHash, randomUUID } from 'node:crypto';
import { one, type DbClient } from './db.js';
import { conflict } from './errors.js';

/** Stable hash of a request payload; bigint amounts are stringified so the hash
 *  never throws on money fields. */
export const requestHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))).digest('hex');

export async function claimIdempotency(client: DbClient, actorId: string, operation: string, key: string, hash: string) {
  const insert = await client.query(
    `INSERT INTO idempotency_records(actor_id, operation, key, request_hash)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING key`, [actorId, operation, key, hash]);
  const record = await one<{ request_hash: string; response: unknown }>(client,
    `SELECT request_hash, response FROM idempotency_records
     WHERE actor_id = $1 AND operation = $2 AND key = $3 FOR UPDATE`, [actorId, operation, key]);
  if (!record || record.request_hash !== hash) throw conflict('کلید تکرار با درخواست دیگری استفاده شده است.');
  if (!insert.rowCount && record.response === null) throw conflict('درخواست مشابه هنوز در حال پردازش است.');
  return { previous: insert.rowCount ? null : record.response };
}

export async function completeIdempotency(client: DbClient, actorId: string, operation: string, key: string, response: unknown) {
  await client.query('UPDATE idempotency_records SET response = $4 WHERE actor_id = $1 AND operation = $2 AND key = $3',
    [actorId, operation, key, JSON.stringify(response)]);
}

export async function audit(client: DbClient, actorId: string | null, action: string, resourceType: string, resourceId: string, oldValue?: unknown, newValue?: unknown, ip?: string) {
  await client.query(
    `INSERT INTO audit_logs(id, actor_id, action, resource_type, resource_id, old_value, new_value, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), actorId, action, resourceType, resourceId, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue), ip ?? null]);
}

export async function outbox(client: DbClient, eventType: string, aggregateType: string, aggregateId: string, payload: unknown) {
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), eventType, aggregateType, aggregateId, JSON.stringify(payload)]);
}

/**
 * Server-backed notifications (section S): create an outbox event and fan a
 * notification out to a specific user — all inside the caller's transaction.
 */
export async function notifyUser(
  client: DbClient,
  userId: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  title: string,
  body: string,
  priority: 'low' | 'normal' | 'high' = 'normal',
) {
  const eventId = randomUUID();
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify({ title, body })]);
  await client.query(
    `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, event_id) DO NOTHING`,
    [randomUUID(), userId, eventId, title, body, priority]);
}

/**
 * Notify every active user holding a permission (e.g. warehouse/admin teams).
 */
export async function notifyByPermission(
  client: DbClient,
  permissionCode: string,
  eventType: string,
  aggregateType: string,
  aggregateId: string,
  title: string,
  body: string,
  priority: 'low' | 'normal' | 'high' = 'normal',
) {
  const eventId = randomUUID();
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify({ title, body })]);
  const recipients = await client.query<{ id: string }>(
    `SELECT DISTINCT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN role_permissions rp ON rp.role_code = ur.role_code
     WHERE rp.permission_code = $1 AND u.status = 'active'`,
    [permissionCode]);
  for (const row of recipients.rows) {
    await client.query(
      `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, event_id) DO NOTHING`,
      [randomUUID(), row.id, eventId, title, body, priority]);
  }
}
