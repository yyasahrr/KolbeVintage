import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPool, transaction, one } from './db.js';
import { loadConfig } from './config.js';
import { MeliPayamakSms } from './melipayamak.js';
import { runAutomation } from './crm.js';

const config = loadConfig();
if (!config.REDIS_URL) throw new Error('REDIS_URL is required for the worker.');
const pool = createPool(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('kolbe-events', { connection: redis });
const sms = config.MELIPAYAMAK_USERNAME && config.MELIPAYAMAK_PASSWORD && config.MELIPAYAMAK_SENDER
  ? new MeliPayamakSms(config.MELIPAYAMAK_USERNAME, config.MELIPAYAMAK_PASSWORD, config.MELIPAYAMAK_SENDER) : null;

type Event = { id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, string>; published_at: Date | null };

async function deliver(eventId: string) {
  await transaction(pool, async (client) => {
    const event = await one<Event>(client, 'SELECT * FROM outbox_events WHERE id = $1 FOR UPDATE', [eventId]);
    if (!event || event.published_at) return;
    let recipient: string | null = null;
    let title = event.event_type;
    let body = '';
    if (event.aggregate_type === 'order') {
      const order = await one<{ buyer_id: string; reference: string }>(client, 'SELECT buyer_id,reference FROM orders WHERE id = $1', [event.aggregate_id]);
      if (order) { recipient = order.buyer_id; title = `سفارش ${order.reference}`; body = event.event_type === 'order.paid' ? 'پرداخت سفارش تأیید شد.' : 'وضعیت سفارش به‌روز شد.'; }
    } else if (event.aggregate_type === 'ticket') {
      const ticket = await one<{ owner_id: string; reference: string }>(client, 'SELECT owner_id,reference FROM tickets WHERE id = $1', [event.aggregate_id]);
      if (ticket) { recipient = ticket.owner_id; title = `تیکت ${ticket.reference}`; body = 'درخواست پشتیبانی به‌روز شد.'; }
    } else if (event.aggregate_type === 'membership') {
      const membership = await one<{ user_id: string }>(client, 'SELECT user_id FROM memberships WHERE id = $1', [event.aggregate_id]);
      if (membership) { recipient = membership.user_id; title = 'عضویت عمده'; body = 'پلن عضویت شما فعال شد.'; }
    } else if (event.aggregate_type === 'product') {
      const product = await one<{ supplier_id: string | null }>(client, 'SELECT supplier_id FROM products WHERE id = $1', [event.aggregate_id]);
      if (product) { recipient = product.supplier_id; title = 'محصول'; body = 'وضعیت محصول به‌روز شد.'; }
    }
    if (recipient) {
      await client.query(
        `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id,event_id) DO NOTHING`,
        [randomUUID(), recipient, event.id, title, body, event.event_type.includes('failed') ? 'high' : 'normal']);
      const user = await one<{ phone: string | null }>(client, 'SELECT phone FROM users WHERE id = $1', [recipient]);
      if (user?.phone && /^09\d{9}$/.test(user.phone)) {
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING`,
          [randomUUID(), event.id, recipient, user.phone, `${title}: ${body}`]);
      }
    }
    await client.query('UPDATE outbox_events SET published_at = now() WHERE id = $1', [event.id]);
  });
}

const worker = new Worker('kolbe-events', async (job) => deliver(String(job.data.eventId)),
  { connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 10 });
worker.on('failed', (job, error) => console.error('Outbox delivery failed', job?.id, error));

const pump = async () => {
  const events = await pool.query<{ id: string }>(
    'SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 100');
  for (const event of events.rows) {
    await queue.add('deliver', { eventId: event.id }, { jobId: `outbox-${event.id}`, attempts: 5,
      backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 86400 }, removeOnFail: true });
  }
};
const timer = setInterval(() => void pump().catch((error) => console.error('Outbox pump failed', error)), 2000);
await pump();
const smsPump = async () => {
  if (!sms) return;
  await pool.query("UPDATE sms_deliveries SET status = 'unknown' WHERE status = 'sending' AND attempted_at < now() - interval '2 minutes'");
  const items = await pool.query<{ id: string }>(
    "SELECT id FROM sms_deliveries WHERE status = 'queued' ORDER BY created_at LIMIT 20");
  for (const item of items.rows) {
    const claimed = await pool.query<{ phone: string; message: string }>(
      "UPDATE sms_deliveries SET status = 'sending', attempted_at = now() WHERE id = $1 AND status = 'queued' RETURNING phone,message", [item.id]);
    if (!claimed.rows[0]) continue;
    try {
      const reference = await sms.send(claimed.rows[0].phone, claimed.rows[0].message);
      await pool.query("UPDATE sms_deliveries SET status = 'sent', provider_reference = $2, sent_at = now() WHERE id = $1",
        [item.id, reference]);
    } catch (error) {
      // A timeout may have occurred after dispatch; do not resend automatically.
      await pool.query("UPDATE sms_deliveries SET status = 'unknown' WHERE id = $1", [item.id]);
      console.error('SMS submission outcome is unknown', item.id, error instanceof Error ? error.message : 'unknown error');
    }
  }
};
const smsTimer = setInterval(() => void smsPump().catch((error) => console.error('SMS pump failed', error)), 2000);
await smsPump();
// CRM automations (item 16): the birthday rule runs at most once a day per user.
const crmPump = async () => {
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM crm_automations WHERE active AND automation_type = 'birthday_sms'
       AND (last_run_at IS NULL OR last_run_at < now() - interval '20 hours')`);
  for (const item of due.rows) {
    await runAutomation(pool, item.id).catch((error) => console.error('CRM automation failed', item.id, error instanceof Error ? error.message : error));
  }
};
const crmTimer = setInterval(() => void crmPump().catch((error) => console.error('CRM pump failed', error)), 3600_000);
await crmPump();
const shutdown = async () => {
  clearInterval(timer); clearInterval(smsTimer); clearInterval(crmTimer); await worker.close(); await queue.close(); redis.disconnect(); await pool.end(); process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
