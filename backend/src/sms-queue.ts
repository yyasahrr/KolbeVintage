import type { DbClient, DbPool } from './db.js';
import { one } from './db.js';
import { consentedRecipients } from './crm-intelligence.js';

/* SMS queue drain (hardening of items 136-143).
 *
 * `sms_deliveries.category` separates transactional messages (order, security,
 * shipping) from marketing ones (campaigns, automations, cart nudges, coupon
 * gifts). Marketing rows are gated twice: once when they are queued, and again
 * immediately before the provider call, because consent can be revoked while a
 * message is still waiting in the queue. A revoked row becomes `blocked` — it is
 * never handed to the provider and never silently retried. */

export type SmsSender = { send(phone: string, message: string): Promise<string> };

export type SmsDrainResult = { scanned: number; sent: number; blocked: number; unknown: number };

type QueueRow = { id: string; user_id: string; category: string };

/** Re-verify consent at send time; returns the ids that may still receive marketing SMS. */
async function stillConsented(client: DbClient, userIds: string[]) {
  const allowed = await consentedRecipients(client, userIds);
  return new Set(allowed.map((row) => row.id));
}

/** Block every queued marketing row of one customer — used when consent is revoked. */
export async function blockQueuedMarketingSms(client: DbClient, userId: string, reason = 'consent_revoked') {
  const result = await client.query(
    `UPDATE sms_deliveries SET status = 'blocked', blocked_reason = $2
     WHERE user_id = $1 AND category = 'marketing' AND status = 'queued'`, [userId, reason]);
  return result.rowCount ?? 0;
}

/** Reverts deliveries stuck in `sending` (a provider timeout) to `unknown`; they are
 *  never auto-resent, because the outcome of the first attempt is unknown. */
export async function reclaimStuckSms(pool: DbPool) {
  await pool.query(
    "UPDATE sms_deliveries SET status = 'unknown' WHERE status = 'sending' AND attempted_at < now() - interval '2 minutes'");
}

export async function drainSmsQueue(pool: DbPool, sender: SmsSender | null, options: { limit?: number } = {}): Promise<SmsDrainResult> {
  const result: SmsDrainResult = { scanned: 0, sent: 0, blocked: 0, unknown: 0 };
  if (!sender) return result;
  await reclaimStuckSms(pool);
  const queued = await pool.query<QueueRow>(
    "SELECT id,user_id,category FROM sms_deliveries WHERE status = 'queued' ORDER BY created_at LIMIT $1",
    [options.limit ?? 20]);
  result.scanned = queued.rowCount ?? 0;
  for (const item of queued.rows) {
    const claimed = await pool.query<{ phone: string; message: string }>(
      "UPDATE sms_deliveries SET status = 'sending', attempted_at = now() WHERE id = $1 AND status = 'queued' RETURNING phone,message",
      [item.id]);
    if (!claimed.rows[0]) continue; // another worker won the row
    if (item.category === 'marketing') {
      const allowed = await stillConsented(pool, [item.user_id]);
      if (!allowed.has(item.user_id)) {
        await pool.query("UPDATE sms_deliveries SET status = 'blocked', blocked_reason = 'consent_missing_at_send' WHERE id = $1",
          [item.id]);
        result.blocked += 1;
        continue;
      }
    }
    try {
      const reference = await sender.send(claimed.rows[0].phone, claimed.rows[0].message);
      await pool.query("UPDATE sms_deliveries SET status = 'sent', provider_reference = $2, sent_at = now() WHERE id = $1",
        [item.id, reference]);
      result.sent += 1;
    } catch {
      // A timeout may have occurred after dispatch; never resend automatically.
      await pool.query("UPDATE sms_deliveries SET status = 'unknown' WHERE id = $1", [item.id]);
      result.unknown += 1;
    }
  }
  return result;
}

/** Counting helper used by the SMS panel and by the hardening tests. */
export async function smsQueueStatus(client: DbClient, eventId: string) {
  return one<{ status: string; category: string; blocked_reason: string | null }>(client,
    'SELECT status, category, blocked_reason FROM sms_deliveries WHERE event_id = $1', [eventId]);
}
