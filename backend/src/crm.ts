import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial } from './money.js';
import { audit, outbox } from './operations.js';
import { notFound } from './errors.js';
import { createCoupon } from './coupons.js';

/* CRM for every actor type (item 16): contacts, activity timeline, segments,
   tags and automations that reach into the SMS panel and coupon engine. */

const contactPatch = z.object({
  actorType: z.enum(['customer', 'vip', 'wholesale_buyer', 'supplier', 'partner', 'other']).optional(),
  segment: z.string().trim().max(80).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const activityBody = z.object({
  type: z.enum(['note', 'call', 'sms', 'email', 'automation', 'order', 'ticket', 'coupon', 'event']).default('note'),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(5000).default(''),
  refType: z.string().max(40).optional(),
  refId: z.string().max(80).optional(),
}).strict();

const automationBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{3,40}$/),
  name: z.string().trim().min(2).max(120),
  automationType: z.enum(['birthday_sms', 'winback', 'order_followup', 'restock_alert', 'price_drop']),
  config: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().default(true),
}).strict();

export async function ensureContact(client: PoolClient, userId: string, actorType: 'customer' | 'vip' | 'wholesale_buyer' | 'supplier' | 'partner' | 'other' = 'customer') {
  const existing = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
  if (existing) return existing.id;
  const id = randomUUID();
  await client.query('INSERT INTO crm_contacts(id,user_id,actor_type) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING',
    [id, userId, actorType]);
  const row = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
  return row!.id;
}

type BirthdayConfig = {
  messageTemplate?: string;
  couponPercent?: number;
  couponMaxDiscountRial?: string;
  couponValidityDays?: number;
  couponScope?: { productIds?: string[]; categories?: string[] };
};

/** Birthday automation: check birthdays, generate a personal coupon through the
 *  coupon engine, send SMS through the SMS panel and log the result in CRM. */
export async function runAutomation(pool: DbPool, automationId: string, smsOutboxEventType = 'crm.birthday') {
  return transaction(pool, async (client) => {
    const automation = await one<{ id: string; code: string; name: string; automation_type: string; config: BirthdayConfig & Record<string, unknown>; active: boolean }>(client,
      'SELECT * FROM crm_automations WHERE id = $1 FOR UPDATE', [automationId]);
    if (!automation) throw notFound();
    const runId = randomUUID();
    await client.query('INSERT INTO crm_automation_runs(id,automation_id,status) VALUES ($1,$2,$3)',
      [runId, automationId, 'running']);
    const results: Array<{ userId: string; couponCode?: string; smsQueued?: boolean; skipped?: string }> = [];
    let processed = 0;
    if (automation.automation_type === 'birthday_sms' && automation.active) {
      const config = automation.config ?? {};
      // Requirement 143: a birthday gift SMS is marketing, so it only goes to
      // customers who opted in and who are not marked do-not-contact.
      const recipients = await client.query<{ id: string; phone: string | null; display_name: string }>(
        `SELECT u.id, u.phone, u.display_name FROM users u
         LEFT JOIN customer_consents c ON c.user_id = u.id
         WHERE u.status = 'active' AND u.phone IS NOT NULL AND u.birthday IS NOT NULL
           AND COALESCE(c.marketing_sms, false) AND NOT COALESCE(c.do_not_contact, false)
           AND EXTRACT(MONTH FROM u.birthday) = EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Tehran'))
           AND EXTRACT(DAY FROM u.birthday) = EXTRACT(DAY FROM (now() AT TIME ZONE 'Asia/Tehran'))`);
      for (const recipient of recipients.rows) {
        const already = await one<{ id: string }>(client,
          `SELECT a.id FROM crm_activities a JOIN crm_contacts c ON c.id = a.contact_id
           WHERE c.user_id = $1 AND a.type = 'automation' AND a.ref_type = 'birthday'
             AND a.created_at >= date_trunc('day', now())`, [recipient.id]);
        if (already) { results.push({ userId: recipient.id, skipped: 'already_run' }); continue; }
        const contactId = await ensureContact(client, recipient.id);
        const validityDays = Number(config.couponValidityDays ?? 14);
        const endsAt = new Date(Date.now() + validityDays * 86400_000);
        const coupon = await createCoupon(client, {
          type: 'percent', value: String(Math.min(Math.max(Number(config.couponPercent ?? 10), 1), 100)),
          maxDiscountRial: config.couponMaxDiscountRial ?? null, minOrderRial: '0',
          usageLimitPerUser: 1, recipientUserId: recipient.id, audience: ['customer', 'vip'],
          scope: config.couponScope ?? {}, endsAt, source: 'crm_automation',
          campaignName: `تولد ${recipient.display_name}`,
        });
        const message = String(config.messageTemplate ?? '{name} عزیز، تولدت مبارک! کد تخفیف اختصاصی شما: {code}')
          .replaceAll('{name}', recipient.display_name).replaceAll('{code}', coupon.code);
        await outbox(client, smsOutboxEventType, 'crm_contact', contactId,
          { contactId, userId: recipient.id, couponCode: coupon.code });
        const eventId = await one<{ id: string }>(client,
          'SELECT id FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at DESC LIMIT 1',
          [smsOutboxEventType, contactId]);
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), eventId!.id, recipient.id, recipient.phone, message]);
        await client.query(
          `INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id,result,created_by)
           VALUES ($1,$2,'automation',$3,$4,'birthday',$5,$6,NULL)`,
          [randomUUID(), contactId, `پیام تولد: ${automation.name}`, message, coupon.id,
            JSON.stringify({ couponCode: coupon.code, smsQueued: true })]);
        results.push({ userId: recipient.id, couponCode: coupon.code, smsQueued: true });
        processed += 1;
      }
    }
    await client.query(
      `UPDATE crm_automation_runs SET status = 'succeeded', processed_count = $2, results = $3, finished_at = now() WHERE id = $1`,
      [runId, processed, JSON.stringify(results)]);
    await client.query('UPDATE crm_automations SET last_run_at = now() WHERE id = $1', [automationId]);
    return { runId, processed, results };
  });
}

export function registerCrmRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/crm/contacts', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const query = z.object({
      actorType: z.enum(['customer', 'vip', 'wholesale_buyer', 'supplier', 'partner', 'other']).optional(),
      tag: z.string().max(40).optional(),
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT c.id,c.user_id,c.actor_type,c.segment,c.tags,c.metadata,c.updated_at,
              u.display_name,u.phone,u.email,u.birthday,
              (SELECT count(*)::int FROM orders o WHERE o.buyer_id = c.user_id) AS order_count,
              (SELECT COALESCE(sum(o.total_rial), 0)::text FROM orders o WHERE o.buyer_id = c.user_id AND o.status <> 'cancelled') AS total_spent_rial,
              (SELECT count(*)::int FROM tickets t WHERE t.owner_id = c.user_id) AS ticket_count
       FROM crm_contacts c LEFT JOIN users u ON u.id = c.user_id
       WHERE ($1::text IS NULL OR c.actor_type = $1)
         AND ($2::text IS NULL OR $2 = ANY(c.tags))
         AND ($3::text IS NULL OR u.display_name ILIKE '%' || $3 || '%' OR u.phone ILIKE '%' || $3 || '%')
       ORDER BY c.updated_at DESC LIMIT $4`,
      [query.actorType ?? null, query.tag ?? null, query.search ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, total_spent_rial: asRial(row.total_spent_rial) })) };
  });

  app.get('/api/v1/admin/crm/contacts/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const contact = await one<Record<string, unknown>>(pool,
      `SELECT c.*, u.display_name, u.phone, u.email, u.birthday, u.created_at AS user_created_at
       FROM crm_contacts c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = $1`, [id]);
    if (!contact) throw notFound();
    const activities = await pool.query(
      `SELECT a.id,a.type,a.title,a.body,a.ref_type,a.ref_id,a.result,a.created_at,u.display_name AS created_by_name
       FROM crm_activities a LEFT JOIN users u ON u.id = a.created_by
       WHERE a.contact_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [id]);
    return { ...contact, activities: activities.rows };
  });

  app.post('/api/v1/admin/crm/contacts', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = z.object({ userId: z.uuid(), actorType: z.enum(['customer', 'vip', 'wholesale_buyer', 'supplier', 'partner', 'other']).default('customer') })
      .strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const contactId = await ensureContact(client, body.userId, body.actorType);
      await audit(client, user.id, 'crm.contact_created', 'crm_contact', contactId, undefined, body, request.ip);
      return { id: contactId };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/admin/crm/contacts/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = contactPatch.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE crm_contacts SET actor_type = COALESCE($2, actor_type), segment = COALESCE($3, segment),
           tags = COALESCE($4, tags), metadata = COALESCE($5, metadata), updated_at = now() WHERE id = $1`,
        [id, body.actorType ?? null, body.segment ?? null, body.tags ?? null, body.metadata ? JSON.stringify(body.metadata) : null]);
      await audit(client, user.id, 'crm.contact_updated', 'crm_contact', id, before, body, request.ip);
      return one(client, 'SELECT * FROM crm_contacts WHERE id = $1', [id]);
    });
  });

  app.get('/api/v1/admin/crm/contacts/:id/activities', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      'SELECT id,type,title,body,ref_type,ref_id,result,created_at FROM crm_activities WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 100', [id]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/contacts/:id/activities', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = activityBody.parse(request.body);
    const exists = await one(pool, 'SELECT id FROM crm_contacts WHERE id = $1', [id]);
    if (!exists) throw notFound();
    const activityId = randomUUID();
    await pool.query(
      `INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [activityId, id, body.type, body.title, body.body, body.refType ?? null, body.refId ?? null, user.id]);
    await transaction(pool, (client) => audit(client, user.id, 'crm.activity_added', 'crm_contact', id, undefined, { activityId, title: body.title }, request.ip));
    return reply.code(201).send({ id: activityId, ...body });
  });

  app.get('/api/v1/admin/crm/automations', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT a.id,a.code,a.name,a.automation_type,a.config,a.active,a.last_run_at,a.created_at,
              (SELECT count(*)::int FROM crm_automation_runs r WHERE r.automation_id = a.id) AS run_count
       FROM crm_automations a ORDER BY a.created_at`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/automations', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = automationBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        'INSERT INTO crm_automations(id,code,name,automation_type,config,active,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, body.code, body.name, body.automationType, JSON.stringify(body.config), body.active, user.id]);
      await audit(client, user.id, 'crm.automation_created', 'crm_automation', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/crm/automations/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = automationBody.partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_automations WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE crm_automations SET name = COALESCE($2, name), config = COALESCE($3, config),
           active = COALESCE($4, active) WHERE id = $1`,
        [id, body.name ?? null, body.config ? JSON.stringify(body.config) : null, body.active ?? null]);
      await audit(client, user.id, 'crm.automation_updated', 'crm_automation', id, before, body, request.ip);
      return { id, ...body };
    });
  });

  app.post('/api/v1/admin/crm/automations/:id/run', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return runAutomation(pool, id);
  });

  app.get('/api/v1/admin/crm/automations/:id/runs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      'SELECT id,status,processed_count,results,error,started_at,finished_at FROM crm_automation_runs WHERE automation_id = $1 ORDER BY started_at DESC LIMIT 50', [id]);
    return { items: rows.rows };
  });
}
