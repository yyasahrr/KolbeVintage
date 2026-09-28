import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one } from './db.js';
import { conflict } from './errors.js';

export const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function claimIdempotency(client: PoolClient, actorId: string, operation: string, key: string, hash: string) {
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

export async function completeIdempotency(client: PoolClient, actorId: string, operation: string, key: string, response: unknown) {
  await client.query('UPDATE idempotency_records SET response = $4 WHERE actor_id = $1 AND operation = $2 AND key = $3',
    [actorId, operation, key, JSON.stringify(response)]);
}

export async function audit(client: PoolClient, actorId: string | null, action: string, resourceType: string, resourceId: string, oldValue?: unknown, newValue?: unknown, ip?: string) {
  await client.query(
    `INSERT INTO audit_logs(id, actor_id, action, resource_type, resource_id, old_value, new_value, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [randomUUID(), actorId, action, resourceType, resourceId, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue), ip ?? null]);
}

export async function outbox(client: PoolClient, eventType: string, aggregateType: string, aggregateId: string, payload: unknown) {
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), eventType, aggregateType, aggregateId, JSON.stringify(payload)]);
}
