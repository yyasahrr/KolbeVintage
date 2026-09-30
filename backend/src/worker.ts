import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createPool, transaction, one } from './db.js';
import { loadConfig } from './config.js';
import { MeliPayamakSms } from './melipayamak.js';
import { runAutomation } from './crm.js';
import { processStyleAnalysisEvents } from './style.js';
import { processMediaUploadedEvents } from './media-pipeline.js';
import { dispatchAutomationEvents } from './events.js';
import { expireDueMemberships } from './membership.js';
import { runCrmRuleSweep } from './crm-intelligence.js';
import { sweepAbandonedCarts } from './cart.js';
import { dispatchDueAutomations } from './promo-safety.js';
import { drainSmsQueue } from './sms-queue.js';

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
    } else if (event.aggregate_type === 'product' && !event.event_type.startsWith('product.style_') && event.event_type !== 'review.submitted') {
      const product = await one<{ supplier_id: string | null }>(client, 'SELECT supplier_id FROM products WHERE id = $1', [event.aggregate_id]);
      if (product) { recipient = product.supplier_id; title = 'محصول'; body = 'وضعیت محصول به‌روز شد.'; }
    }
    if (recipient) {
      const route = await one<{ roles: string[]; priority: string; channels: string[]; active: boolean }>(client,
        'SELECT roles, priority, channels, active FROM notification_routes WHERE event_type = $1', [event.event_type]);
      const priority = route?.priority ?? (event.event_type.includes('failed') ? 'high' : 'normal');
      await client.query(
        `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id,event_id) DO NOTHING`,
        [randomUUID(), recipient, event.id, title, body, priority]);
      // Role-based routing (item 24): the right teams see the event too.
      if (route?.active && route.roles.length) {
        const watchers = await client.query<{ id: string }>(
          `SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
           WHERE r.role_code = ANY($1) AND u.status = 'active' AND u.id <> $2`, [route.roles, recipient]);
        for (const watcher of watchers.rows) {
          await client.query(
            `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (user_id,event_id) DO NOTHING`,
            [randomUUID(), watcher.id, event.id, title, body, priority]);
        }
      }
      const user = await one<{ phone: string | null }>(client, 'SELECT phone FROM users WHERE id = $1', [recipient]);
      const smsAllowed = !route || route.channels.includes('sms');
      if (smsAllowed && user?.phone && /^09\d{9}$/.test(user.phone)) {
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category)
           VALUES ($1,$2,$3,$4,$5,'transactional') ON CONFLICT (event_id) DO NOTHING`,
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
const retentionCleanup = async () => { await pool.query('DELETE FROM search_metrics WHERE expires_at <= now()'); await pool.query('DELETE FROM media_upload_intents WHERE completed_at IS NULL AND expires_at <= now()'); };
const retentionTimer = setInterval(() => void retentionCleanup().catch((error) => console.error('Retention cleanup failed', error)), 60 * 60 * 1000);
await retentionCleanup();
await pump();
// Marketing rows re-check consent at send time; blocked rows never reach the provider.
const smsPump = async () => {
  const result = await drainSmsQueue(pool, sms, { limit: 20 });
  if (result.blocked) console.log('SMS held back by consent', JSON.stringify(result));
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
// Style intelligence (Req 252): product.style_analysis_requested is processed asynchronously.
const stylePump = async () => { await processStyleAnalysisEvents(pool, 20); };
const styleTimer = setInterval(() => void stylePump().catch((error) => console.error('Style analysis pump failed', error)), 15_000);
await stylePump();
// Media pipeline (Req 234, 322-323): media.uploaded → validate / inspect / responsive variants / background removal.
const mediaPump = async () => { await processMediaUploadedEvents(pool, 10); };
const mediaTimer = setInterval(() => void mediaPump().catch((error) => console.error('Media pipeline pump failed', error)), 10_000);
await mediaPump();
// Automation Center (items 85-89): outbound workflow deliveries with retry/backoff.
const automationPump = async () => {
  const result = await dispatchAutomationEvents(pool, config, { limit: 50 });
  if (result.attempted) console.log('Automation dispatch', JSON.stringify(result));
};
const automationTimer = setInterval(() => void automationPump().catch((error) => console.error('Automation pump failed', error)), 2000);
await automationPump();
// Smart labels + dynamic segments stay self-updating (items 21/98) without a cron VM.
const crmSweep = async () => {
  const result = await runCrmRuleSweep(pool, { labelIntervalHours: 6 });
  if (result.rulesApplied || result.segmentsRefreshed) console.log('CRM rule sweep', JSON.stringify(result));
};
const crmSweepTimer = setInterval(() => void crmSweep().catch((error) => console.error('CRM sweep failed', error)), 900_000);
await crmSweep();

// Abandoned carts become a real event (item 23/24) — one sweep, one event per cart.
const cartSweep = async () => {
  const result = await sweepAbandonedCarts(pool, 6, 50);
  if (result.swept) console.log('Abandoned-cart sweep', JSON.stringify({ swept: result.swept }));
};
const cartSweepTimer = setInterval(() => void cartSweep().catch((error) => console.error('Cart sweep failed', error)), 1_800_000);
await cartSweep();

// Requirement 137/142: active+approved automations fire themselves once their
// cooldown, daily cap and budget allow it (each run is still recorded).
const automationScheduler = async () => {
  const result = await dispatchDueAutomations(pool, { limit: 10 });
  if (result.due) console.log('Scheduled automations', JSON.stringify(result.results));
};
const automationSchedulerTimer = setInterval(
  () => void automationScheduler().catch((error) => console.error('Automation scheduler failed', error)), 900_000);
await automationScheduler();
// Membership lifecycle (item 17): expiries, 7-day notices and scheduled downgrades.
const membershipPump = async () => {
  const result = await expireDueMemberships(pool);
  if (result.expired || result.expiring || result.downgraded) console.log('Membership sweep', JSON.stringify(result));
};
const membershipTimer = setInterval(() => void membershipPump().catch((error) => console.error('Membership sweep failed', error)), 3600_000);
await membershipPump();
const shutdown = async () => {
  clearInterval(timer); clearInterval(smsTimer); clearInterval(crmTimer); clearInterval(retentionTimer);
  clearInterval(styleTimer); clearInterval(mediaTimer);
  clearInterval(automationTimer); clearInterval(membershipTimer); clearInterval(crmSweepTimer);
  clearInterval(cartSweepTimer); clearInterval(automationSchedulerTimer);
  await worker.close(); await queue.close(); redis.disconnect(); await pool.end(); process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
