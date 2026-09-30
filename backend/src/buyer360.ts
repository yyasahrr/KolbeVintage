import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { rial, roundRial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, notFound } from './errors.js';

/** Money strings for the UI; aggregate columns may carry a decimal part. */
const _rial = roundRial;

/* VIP / wholesale Buyer 360 (items 18-19).
   One screen with the entire customer state — account, membership history,
   commercial/legal profile, purchases, money, support and CRM — plus the audited
   admin controls. Normal purchase and upgrade stay payment-driven; nothing here
   approves a paid plan by hand. */

const profileBody = z.object({
  businessName: z.string().trim().max(160).nullable().optional(),
  guildIdentifier: z.string().trim().max(60).nullable().optional(),
  legalName: z.string().trim().max(160).nullable().optional(),
  legalInfo: z.record(z.string(), z.unknown()).optional(),
  activityType: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  approvalPolicy: z.enum(['auto', 'manual']).optional(),
}).strict();

const documentBody = z.object({
  docType: z.string().trim().min(2).max(60),
  title: z.string().trim().min(2).max(200),
  fileId: z.uuid().nullable().optional(),
}).strict();

export function registerBuyerRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** Buyer list (VIP + wholesale) with the numbers an operator scans first. */
  app.get('/api/v1/admin/buyers', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const query = z.object({
      search: z.string().max(120).optional(),
      actorType: z.enum(['all', 'vip', 'wholesale_buyer', 'customer']).default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT u.id, u.display_name, u.phone, u.email, u.created_at,
              c.actor_type, c.segment, c.tags,
              bp.business_name, bp.city, bp.vip_level, bp.credit_limit_rial, bp.blocked,
              (SELECT code FROM membership_plans p JOIN memberships m ON m.plan_id = p.id
                WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 1) AS plan_code,
              (SELECT m.ends_at FROM memberships m WHERE m.user_id = u.id AND m.status = 'active' ORDER BY m.created_at DESC LIMIT 1) AS plan_ends_at,
              (SELECT count(*)::int FROM orders o WHERE o.buyer_id = u.id AND o.status <> 'cancelled') AS order_count,
              (SELECT COALESCE(sum(o.total_rial),0)::text FROM orders o WHERE o.buyer_id = u.id AND o.status <> 'cancelled') AS total_spent_rial
       FROM users u
       LEFT JOIN crm_contacts c ON c.user_id = u.id
       LEFT JOIN buyer_profiles bp ON bp.user_id = u.id
       WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
              OR u.email ILIKE '%' || $1 || '%' OR bp.business_name ILIKE '%' || $1 || '%')
         AND ($2 = 'all' OR COALESCE(c.actor_type, 'customer') = $2)
       ORDER BY total_spent_rial DESC NULLS LAST, u.created_at DESC LIMIT $3`,
      [query.search ?? null, query.actorType, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, total_spent_rial: _rial(row.total_spent_rial), credit_limit_rial: _rial(row.credit_limit_rial ?? '0') })) };
  });

  /** The 360 payload: every canonical fact about the buyer, nothing duplicated. */
  app.get('/api/v1/admin/buyers/:userId/360', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const account = await one<Record<string, unknown>>(pool,
      `SELECT u.id,u.display_name,u.phone,u.email,u.birthday,u.status,u.created_at,
              cp.first_name,cp.last_name,cp.gender,cp.national_id,
              bp.business_name,bp.guild_identifier,bp.legal_name,bp.legal_info,bp.activity_type,bp.city,
              bp.credit_limit_rial,bp.vip_level,bp.approval_policy,bp.blocked,bp.block_reason,bp.internal_note,bp.approved_at,
              c.id AS contact_id,c.actor_type,c.segment,c.tags
       FROM users u
       LEFT JOIN customer_profiles cp ON cp.user_id = u.id
       LEFT JOIN buyer_profiles bp ON bp.user_id = u.id
       LEFT JOIN crm_contacts c ON c.user_id = u.id
       WHERE u.id = $1`, [userId]);
    if (!account) throw notFound();

    const membership = await one<Record<string, unknown>>(pool,
      `SELECT m.id,m.status,m.starts_at,m.ends_at,m.auto_renew,m.source,m.created_at,
              p.id AS plan_id,p.code,p.title,p.tier,p.limits,p.features
       FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 ORDER BY (m.status = 'active') DESC, m.created_at DESC LIMIT 1`, [userId]);
    const membershipHistory = await pool.query(
      `SELECT e.id,e.event_type,e.from_status,e.to_status,e.amount_rial,e.credit_rial,e.note,e.created_at,
              fp.code AS from_plan, tp.code AS to_plan
       FROM membership_events e LEFT JOIN membership_plans fp ON fp.id = e.from_plan_id
       LEFT JOIN membership_plans tp ON tp.id = e.to_plan_id
       WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT 30`, [userId]);

    const purchase = await one<Record<string, unknown>>(pool,
      `SELECT count(*)::int AS orders,
              count(*) FILTER (WHERE order_type = 'retail')::int AS retail_orders,
              count(*) FILTER (WHERE order_type = 'wholesale')::int AS wholesale_orders,
              COALESCE(sum(total_rial),0)::text AS total_rial,
              COALESCE(avg(total_rial),0)::text AS average_order_rial,
              max(created_at) AS last_order_at,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_orders
       FROM orders WHERE buyer_id = $1`, [userId]);
    const favourites = await pool.query(
      `SELECT l.product_id, l.product_name, sum(l.quantity)::int AS quantity, count(*)::int AS orders
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.buyer_id = $1 GROUP BY l.product_id, l.product_name ORDER BY quantity DESC LIMIT 8`, [userId]);
    const returns = await one<Record<string, unknown>>(pool,
      `SELECT count(*)::int AS count, COALESCE(sum(amount_rial),0)::text AS amount_rial FROM return_requests WHERE requester_id = $1`, [userId]);

    const finance = await one<Record<string, unknown>>(pool,
      `SELECT COALESCE(sum(i.remaining_rial) FILTER (WHERE i.status IN ('issued','partially_paid')),0)::text AS open_invoices_rial,
              (SELECT count(*)::int FROM invoices x WHERE x.buyer->>'userId' = $2) AS invoice_count,
              (SELECT COALESCE(sum(p.amount_rial),0)::text FROM payment_intents p JOIN orders o ON o.id = p.order_id
                WHERE o.buyer_id = $1 AND p.status = 'succeeded') AS paid_rial,
              (SELECT count(*)::int FROM payment_intents p JOIN orders o ON o.id = p.order_id
                WHERE o.buyer_id = $1 AND p.status = 'failed') AS failed_payments,
              (SELECT COALESCE(sum(w.balance_rial),0)::text FROM wallet_accounts w WHERE w.owner_id = $1) AS wallet_balance_rial,
              (SELECT COALESCE(sum(w.refunded_total_rial),0)::text FROM wallet_accounts w WHERE w.owner_id = $1) AS refunded_rial
       FROM invoices i WHERE i.buyer->>'userId' = $2`, [userId, userId]);

    const support = await pool.query(
      `SELECT id,reference,subject,category,status,priority,created_at FROM tickets WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]);
    const notifications = await pool.query(
      `SELECT id,title,body,priority,read_at,created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]);
    const sms = await pool.query(
      `SELECT id,message,status,sent_at,created_at FROM sms_deliveries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId]);
    const crmActivities = await pool.query(
      `SELECT a.id,a.type,a.title,a.body,a.created_at FROM crm_activities a
       JOIN crm_contacts c ON c.id = a.contact_id WHERE c.user_id = $1 ORDER BY a.created_at DESC LIMIT 15`, [userId]);
    const labels = await pool.query(
      `SELECT cl.label_code, l.title, cl.source, cl.assigned_at FROM crm_contact_labels cl
       JOIN crm_labels l ON l.code = cl.label_code JOIN crm_contacts c ON c.id = cl.contact_id
       WHERE c.user_id = $1 ORDER BY cl.assigned_at DESC`, [userId]);
    const segments = await pool.query(
      `SELECT s.code,s.title,s.kind FROM crm_segment_members m JOIN crm_segments s ON s.id = m.segment_id
       WHERE m.user_id = $1 ORDER BY s.title`, [userId]);
    const reviews = await pool.query(
      `SELECT r.id,r.rating,r.title,r.status,r.verified_purchase,r.created_at,p.name AS product_name
       FROM customer_reviews r JOIN products p ON p.id = r.product_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [userId]);
    const timeline = await pool.query(
      `SELECT id,event_type,title,description,source,occurred_at FROM customer_timeline
       WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 40`, [userId]);
    const documents = await pool.query(
      `SELECT id,doc_type,title,status,note,verified_at,created_at FROM buyer_documents WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    const consent = await one<Record<string, unknown>>(pool, 'SELECT * FROM customer_consents WHERE user_id = $1', [userId]);
    const auditTrail = await pool.query(
      `SELECT id,action,resource_type,resource_id,old_value,new_value,created_at FROM audit_logs
       WHERE (resource_type = 'user' AND resource_id = $1) OR (resource_type = 'buyer_profile' AND resource_id = $1)
       ORDER BY created_at DESC LIMIT 20`, [userId]);
    const summary = await one<Record<string, unknown>>(pool,
      `SELECT COALESCE(sum(o.total_rial),0)::text AS lifetime_rial,
              count(*)::int AS orders,
              (SELECT count(*)::int FROM coupons c WHERE c.recipient_user_id = $1) AS personal_coupons
       FROM orders o WHERE o.buyer_id = $1 AND o.status <> 'cancelled'`, [userId]);

    return {
      account: { ...account, credit_limit_rial: _rial(account.credit_limit_rial ?? '0') },
      membership: membership ? { ...membership, limits: membership.limits ?? {} } : null,
      membershipHistory: membershipHistory.rows.map((row) => ({
        ...row, amount_rial: _rial(row.amount_rial), credit_rial: _rial(row.credit_rial),
      })),
      purchase: {
        ...purchase,
        total_rial: _rial(purchase?.total_rial ?? '0'),
        average_order_rial: _rial(purchase?.average_order_rial ?? '0'),
        favourites: favourites.rows,
        returns: { count: returns?.count ?? 0, amount_rial: _rial(returns?.amount_rial ?? '0') },
      },
      finance: {
        ...finance,
        open_invoices_rial: _rial(finance?.open_invoices_rial ?? '0'),
        paid_rial: _rial(finance?.paid_rial ?? '0'),
        wallet_balance_rial: _rial(finance?.wallet_balance_rial ?? '0'),
        refunded_rial: _rial(finance?.refunded_rial ?? '0'),
      },
      support: { tickets: support.rows, notifications: notifications.rows, sms: sms.rows, crmActivities: crmActivities.rows },
      crm: { labels: labels.rows, segments: segments.rows, reviews: reviews.rows, timeline: timeline.rows, consent },
      documents: documents.rows,
      audit: auditTrail.rows,
      summary: { ...summary, lifetime_rial: _rial(summary?.lifetime_rial ?? '0') },
    };
  });

  app.patch('/api/v1/admin/buyers/:userId/profile', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = profileBody.parse(request.body);
    return transaction(pool, async (client) => {
      const account = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [userId]);
      if (!account) throw notFound();
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM buyer_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
      await client.query(
        `INSERT INTO buyer_profiles(user_id,business_name,guild_identifier,legal_name,legal_info,activity_type,city,approval_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'auto'))
         ON CONFLICT (user_id) DO UPDATE SET
           business_name = COALESCE($2, buyer_profiles.business_name),
           guild_identifier = COALESCE($3, buyer_profiles.guild_identifier),
           legal_name = COALESCE($4, buyer_profiles.legal_name),
           legal_info = COALESCE($5, buyer_profiles.legal_info),
           activity_type = COALESCE($6, buyer_profiles.activity_type),
           city = COALESCE($7, buyer_profiles.city),
           approval_policy = COALESCE($8, buyer_profiles.approval_policy),
           updated_at = now()`,
        [userId, body.businessName ?? null, body.guildIdentifier ?? null, body.legalName ?? null,
          body.legalInfo ? JSON.stringify(body.legalInfo) : null, body.activityType ?? null, body.city ?? null,
          body.approvalPolicy ?? null]);
      await audit(client, user.id, 'buyer.profile_updated', 'buyer_profile', userId, before, body, request.ip);
      return one(client, 'SELECT * FROM buyer_profiles WHERE user_id = $1', [userId]);
    });
  });

  app.post('/api/v1/admin/buyers/:userId/documents', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = documentBody.parse(request.body);
    const id = randomUUID();
    return transaction(pool, async (client) => {
      const account = await one(client, 'SELECT id FROM users WHERE id = $1', [userId]);
      if (!account) throw notFound();
      await client.query('INSERT INTO buyer_documents(id,user_id,doc_type,title,file_id) VALUES ($1,$2,$3,$4,$5)',
        [id, userId, body.docType, body.title, body.fileId ?? null]);
      await audit(client, user.id, 'buyer.document_added', 'buyer_profile', userId, undefined, { id, docType: body.docType }, request.ip);
      return reply.code(201).send({ id, ...body, status: 'pending' });
    });
  });

  app.post('/api/v1/admin/buyers/:userId/documents/:docId/verify', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const params = z.object({ userId: z.uuid(), docId: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['verified', 'rejected']), note: z.string().trim().max(300).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const document = await one<Record<string, unknown>>(client,
        'SELECT * FROM buyer_documents WHERE id = $1 AND user_id = $2 FOR UPDATE', [params.docId, params.userId]);
      if (!document) throw notFound();
      await client.query('UPDATE buyer_documents SET status = $2, note = $3, verified_by = $4, verified_at = now() WHERE id = $1',
        [params.docId, body.status, body.note ?? null, user.id]);
      await audit(client, user.id, `buyer.document_${body.status}`, 'buyer_profile', params.userId,
        { docId: params.docId, status: document.status }, { status: body.status, note: body.note ?? null }, request.ip);
      return { id: params.docId, status: body.status };
    });
  });

  app.post('/api/v1/admin/buyers/:userId/credit-limit', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({
      creditLimitRial: z.string().regex(/^\d+$/),
      approvalPolicy: z.enum(['auto', 'manual', 'prepaid']).optional(),
      reason: z.string().trim().min(3).max(300),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ credit_limit_rial: string; approval_policy: string | null }>(client,
        'SELECT credit_limit_rial,approval_policy FROM buyer_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE buyer_profiles SET credit_limit_rial = $2, approval_policy = COALESCE($3,approval_policy), updated_at = now()
         WHERE user_id = $1`,
        [userId, rial(body.creditLimitRial).toString(), body.approvalPolicy ?? null]);
      await audit(client, user.id, 'buyer.credit_limit_changed', 'buyer_profile', userId,
        { creditLimitRial: before.credit_limit_rial, approvalPolicy: before.approval_policy },
        { creditLimitRial: body.creditLimitRial, approvalPolicy: body.approvalPolicy ?? before.approval_policy, reason: body.reason }, request.ip);
      return { userId, creditLimitRial: rial(body.creditLimitRial).toString(), approvalPolicy: body.approvalPolicy ?? before.approval_policy };
    });
  });

  /** Block/unblock is separate from membership suspension: it stops ordering, not billing. */
  app.post('/api/v1/admin/buyers/:userId/block', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(300), blocked: z.boolean().default(true) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const profile = await one<Record<string, unknown>>(client,
        `INSERT INTO buyer_profiles(user_id,blocked,block_reason) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET blocked = $2, block_reason = $3, updated_at = now() RETURNING *`,
        [userId, body.blocked, body.blocked ? body.reason : null]);
      await audit(client, user.id, body.blocked ? 'buyer.blocked' : 'buyer.unblocked', 'buyer_profile', userId,
        undefined, { reason: body.reason }, request.ip);
      await outbox(client, body.blocked ? 'buyer.blocked' : 'buyer.unblocked', 'user', userId, { userId, reason: body.reason });
      return { userId, blocked: profile?.blocked ?? body.blocked };
    });
  });

  app.post('/api/v1/admin/buyers/:userId/notes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({
      body: z.string().trim().min(2).max(4000),
      visibility: z.enum(['internal', 'team']).default('internal'),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const contact = await one<{ id: string }>(client,
        `INSERT INTO crm_contacts(id,user_id) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id`, [randomUUID(), userId]);
      if (!contact) throw badRequest('مخاطب CRM ساخته نشد.');
      const id = randomUUID();
      await client.query('INSERT INTO crm_notes(id,contact_id,author_id,body,visibility) VALUES ($1,$2,$3,$4,$5)',
        [id, contact.id, user.id, body.body, body.visibility]);
      await audit(client, user.id, 'buyer.note_added', 'crm_contact', contact.id, undefined, { visibility: body.visibility }, request.ip);
      return reply.code(201).send({ id, visibility: body.visibility, createdAt: new Date().toISOString() });
    });
  });

  /** Manual label assignment (requirement 20: labels are manual *and* rule-based). */
  app.post('/api/v1/admin/buyers/:userId/labels', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({ labels: z.array(z.string().trim().min(2).max(40)).min(1).max(50) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const contact = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
      if (!contact) throw notFound();
      let assigned = 0;
      for (const label of body.labels) {
        const exists = await one(client, 'SELECT code FROM crm_labels WHERE code = $1 AND active', [label]);
        if (!exists) throw notFound();
        const inserted = await client.query(
          `INSERT INTO crm_contact_labels(contact_id,label_code,source,assigned_by) VALUES ($1,$2,'manual',$3)
           ON CONFLICT (contact_id,label_code) DO NOTHING`, [contact.id, label, user.id]);
        assigned += inserted.rowCount ?? 0;
      }
      await audit(client, user.id, 'crm.labels_assigned', 'crm_contact', contact.id, undefined, { labels: body.labels }, request.ip);
      return { contactId: contact.id, assigned };
    });
  });

  app.delete('/api/v1/admin/buyers/:userId/labels/:label', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const params = z.object({ userId: z.uuid(), label: z.string().max(40) }).parse(request.params);
    return transaction(pool, async (client) => {
      const result = await client.query(
        `DELETE FROM crm_contact_labels cl USING crm_contacts c
         WHERE cl.contact_id = c.id AND c.user_id = $1 AND cl.label_code = $2`, [params.userId, params.label]);
      if (!result.rowCount) throw notFound();
      await audit(client, user.id, 'crm.label_removed', 'crm_contact', params.userId, { label: params.label }, undefined, request.ip);
      return { removed: true };
    });
  });

  app.post('/api/v1/admin/buyers/:userId/consent', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'buyers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({
      marketingSms: z.boolean().optional(), transactionalSms: z.boolean().optional(),
      emailMarketing: z.boolean().optional(), doNotContact: z.boolean().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM customer_consents WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO customer_consents(user_id,marketing_sms,transactional_sms,email_marketing,do_not_contact,source)
         VALUES ($1,COALESCE($2,false),COALESCE($3,true),COALESCE($4,false),COALESCE($5,false),'admin')
         ON CONFLICT (user_id) DO UPDATE SET
           marketing_sms = COALESCE($2, customer_consents.marketing_sms),
           transactional_sms = COALESCE($3, customer_consents.transactional_sms),
           email_marketing = COALESCE($4, customer_consents.email_marketing),
           do_not_contact = COALESCE($5, customer_consents.do_not_contact),
           unsubscribed_at = CASE WHEN $2 = false THEN now() ELSE customer_consents.unsubscribed_at END,
           updated_at = now()`,
        [userId, body.marketingSms ?? null, body.transactionalSms ?? null, body.emailMarketing ?? null, body.doNotContact ?? null]);
      await audit(client, user.id, 'buyer.consent_updated', 'customer_consent', userId, before, body, request.ip);
      return one(client, 'SELECT * FROM customer_consents WHERE user_id = $1', [userId]);
    });
  });

  /** Admin self-service profile corrections (item 101) — sensitive fields need verification. */
  app.post('/api/v1/admin/buyers/:userId/profile-correction', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'profile:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({
      firstName: z.string().trim().max(80).nullable().optional(),
      lastName: z.string().trim().max(80).nullable().optional(),
      birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      city: z.string().trim().max(80).nullable().optional(),
      reason: z.string().trim().min(3).max(300),
      email: z.never().optional(),
      phone: z.never().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client,
        `SELECT u.display_name,u.birthday,cp.first_name,cp.last_name FROM users u
         LEFT JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [userId]);
      if (!before) throw notFound();
      if (body.birthday) {
        await client.query('UPDATE users SET birthday = $2, updated_at = now() WHERE id = $1', [userId, body.birthday]);
      }
      if (body.firstName !== undefined || body.lastName !== undefined) {
        await client.query(
          `INSERT INTO customer_profiles(user_id,first_name,last_name) VALUES ($1,$2,$3)
           ON CONFLICT (user_id) DO UPDATE SET first_name = COALESCE($2, customer_profiles.first_name),
             last_name = COALESCE($3, customer_profiles.last_name), updated_at = now()`,
          [userId, body.firstName ?? null, body.lastName ?? null]);
        const names = [body.firstName ?? before.first_name, body.lastName ?? before.last_name].filter(Boolean).join(' ');
        if (names) await client.query('UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1', [userId, names]);
      }
      if (body.city !== undefined) {
        await client.query(
          `INSERT INTO buyer_profiles(user_id,city) VALUES ($1,$2)
           ON CONFLICT (user_id) DO UPDATE SET city = COALESCE($2, buyer_profiles.city), updated_at = now()`,
          [userId, body.city]);
      }
      await audit(client, user.id, 'user.admin_profile_edit', 'user', userId, before,
        { ...body, email: 'verification_required', phone: 'verification_required' }, request.ip);
      await outbox(client, 'customer.updated', 'user', userId, { userId, fields: Object.keys(body).filter((key) => key !== 'reason') });
      return { userId, updated: true, reason: body.reason };
    });
  });
}
