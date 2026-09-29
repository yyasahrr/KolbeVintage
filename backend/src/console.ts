import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import type { DbPool } from './db.js';
import { transaction } from './db.js';
import { audit } from './operations.js';
import { emitEvent } from './events.js';
import { consentedRecipients, recordTimeline } from './crm-intelligence.js';
import { badRequest, notFound } from './errors.js';

/* ================= Pure rules (unit-testable, no DB) ================= */

export const RESTRICTION_SCOPES = ['purchase', 'ticket', 'return', 'withdrawal', 'all'] as const;
export type RestrictionScope = (typeof RESTRICTION_SCOPES)[number];

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'queued', 'sent', 'failed'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Canonical SMS campaign lifecycle. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled', 'queued'],
  scheduled: ['queued', 'draft'],
  queued: ['sent', 'failed'],
  sent: [],
  failed: ['draft', 'queued'],
};

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

/** A restriction blocks an action when scope matches directly or via `all`. */
export function restrictionBlocks(scope: RestrictionScope, action: Exclude<RestrictionScope, 'all'>): boolean {
  return scope === 'all' || scope === action;
}

export function isBlocked(restrictions: { scope: string; status: string }[], action: Exclude<RestrictionScope, 'all'>): boolean {
  return restrictions.some((r) => r.status === 'active' && restrictionBlocks(r.scope as RestrictionScope, action));
}

/** Server-side enforcement helper — used by orders/tickets/returns/withdrawals. */
export async function assertNotRestricted(
  pool: DbPool, userId: string, action: Exclude<RestrictionScope, 'all'>,
): Promise<void> {
  const rows = await pool.query('SELECT scope, status FROM user_restrictions WHERE user_id = $1 AND status = $2', [userId, 'active']);
  if (isBlocked(rows.rows as { scope: string; status: string }[], action)) {
    throw badRequest('حساب شما توسط مدیریت محدود شده است و امکان انجام این عملیات وجود ندارد.');
  }
}

/* ================= HTTP routes ================= */

const restrictionBody = z.object({
  userId: z.string().uuid(),
  scope: z.enum(RESTRICTION_SCOPES),
  reason: z.string().trim().min(3).max(500),
});

const campaignBody = z.object({
  title: z.string().trim().min(2).max(120),
  message: z.string().trim().min(4).max(1000),
  audience: z.enum(['all', 'retail', 'wholesale', 'vip', 'suppliers']).default('all'),
  scheduledAt: z.string().datetime().nullable().optional(),
  activate: z.boolean().default(false),
});

const campaignPatch = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  message: z.string().trim().min(4).max(1000).optional(),
  audience: z.enum(['all', 'retail', 'wholesale', 'vip', 'suppliers']).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});

export function registerConsoleRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ---- Dashboard summary: server-side counts, no client state ---- */
  app.get('/api/v1/admin/dashboard/summary', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'admin:read');
    const result = await pool.query(`
      SELECT
        (SELECT count(*) FROM products WHERE status = 'pending') AS pending_products,
        (SELECT count(*) FROM orders WHERE status NOT IN ('delivered','cancelled','refunded')) AS active_orders,
        (SELECT count(*) FROM products WHERE status = 'pending') +
        (SELECT count(*) FROM cooperation_requests WHERE status = 'submitted') +
        (SELECT count(*) FROM withdrawal_requests WHERE status = 'requested') AS pending_supplier_actions,
        (SELECT count(*) FROM memberships WHERE status = 'pending_payment') AS pending_memberships,
        (SELECT count(*) FROM tickets WHERE status NOT IN ('resolved','closed')) AS open_tickets,
        (SELECT count(*) FROM return_requests WHERE status = 'requested') AS pending_returns,
        (SELECT count(*) FROM withdrawal_requests WHERE status = 'requested') AS pending_withdrawals,
        (SELECT count(*) FROM orders) AS total_orders,
        (SELECT count(*) FROM users) AS total_users
    `);
    const row = result.rows[0] as Record<string, string>;
    return {
      pendingProducts: Number(row.pending_products),
      activeOrders: Number(row.active_orders),
      pendingSupplierActions: Number(row.pending_supplier_actions),
      pendingMemberships: Number(row.pending_memberships),
      openTickets: Number(row.open_tickets),
      pendingReturns: Number(row.pending_returns),
      pendingWithdrawals: Number(row.pending_withdrawals),
      totalOrders: Number(row.total_orders),
      totalUsers: Number(row.total_users),
    };
  });

  /* ---- Memberships admin ---- */
  app.get('/api/v1/admin/memberships', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'admin:read');
    const filter = z.object({ status: z.enum(['pending_payment', 'active', 'expired', 'cancelled']).optional() }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT m.id, m.status, m.created_at, m.starts_at, m.ends_at, m.user_id,
              u.display_name AS full_name, u.phone, p.title AS plan_name, p.code AS plan_code, p.annual_price_rial AS price_rial
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN membership_plans p ON p.id = m.plan_id
        WHERE ($1::text IS NULL OR m.status = $1)
        ORDER BY m.created_at DESC LIMIT 200`, [filter.status ?? null],
    );
    return {
      items: rows.rows.map((r: Record<string, unknown>) => ({
        id: r.id, status: r.status, userId: r.user_id, applicantName: r.full_name, phone: r.phone,
        planName: r.plan_name, planCode: r.plan_code, priceRial: String(r.price_rial ?? '0'),
        createdAt: r.created_at, startsAt: r.starts_at, endsAt: r.ends_at,
      })),
    };
  });

  app.patch('/api/v1/admin/memberships/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'memberships:manage');
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['active', 'cancelled', 'expired']), note: z.string().trim().max(500).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const current = await client.query('SELECT id, user_id, plan_id, status FROM memberships WHERE id = $1 FOR UPDATE', [params.id]);
      if (!current.rowCount) throw notFound();
      const membership = current.rows[0] as { id: string; user_id: string; plan_id: string; status: string };
      if (membership.status === body.status) return { id: membership.id, status: membership.status };

      if (body.status === 'active') {
        if (membership.status !== 'pending_payment') throw badRequest('فقط درخواست‌های در انتظار پرداخت قابل تأیید دستی هستند.');
        // membership_plans has no duration column — plans are annual, so an approved membership runs 365 days.
        const days = 365;
        await client.query("UPDATE memberships SET status = 'expired' WHERE user_id = $1 AND status = 'active'", [membership.user_id]);
        await client.query(
          `UPDATE memberships SET status = 'active', starts_at = now(), ends_at = now() + ($2 || ' days')::interval WHERE id = $1`,
          [membership.id, String(days)],
        );
      } else {
        await client.query('UPDATE memberships SET status = $2 WHERE id = $1', [membership.id, body.status]);
      }
      await audit(client, user.id, `membership.${body.status}`, 'membership', membership.id, { status: membership.status }, { status: body.status, note: body.note }, request.ip);
      return { id: membership.id, status: body.status };
    });
  });

  /* ---- User restrictions ---- */
  app.get('/api/v1/admin/restrictions', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'admin:read');
    const rows = await pool.query(
      `SELECT r.id, r.user_id, r.scope, r.reason, r.status, r.created_at, r.lifted_at, u.display_name AS full_name, u.phone
         FROM user_restrictions r JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC LIMIT 200`,
    );
    return {
      items: rows.rows.map((r: Record<string, unknown>) => ({
        id: r.id, userId: r.user_id, userName: r.full_name, phone: r.phone, scope: r.scope,
        reason: r.reason, status: r.status, createdAt: r.created_at, liftedAt: r.lifted_at,
      })),
    };
  });

  app.post('/api/v1/admin/restrictions', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'restrictions:manage');
    const data = restrictionBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      const target = await client.query('SELECT id FROM users WHERE id = $1', [data.userId]);
      if (!target.rowCount) throw notFound();
      await client.query('UPDATE user_restrictions SET status = $2, lifted_at = now(), lifted_by = $3 WHERE user_id = $1 AND scope = $4 AND status = $5',
        [data.userId, 'lifted', user.id, data.scope, 'active']);
      await client.query('INSERT INTO user_restrictions(id, user_id, scope, reason, created_by) VALUES ($1,$2,$3,$4,$5)',
        [id, data.userId, data.scope, data.reason, user.id]);
      await audit(client, user.id, 'restriction.created', 'user_restriction', id, undefined, data, request.ip);
    });
    return reply.code(201).send({ id });
  });

  app.patch('/api/v1/admin/restrictions/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'restrictions:manage');
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['active', 'lifted']), reason: z.string().trim().min(3).max(500).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const current = await client.query('SELECT id, user_id, scope, status FROM user_restrictions WHERE id = $1 FOR UPDATE', [params.id]);
      if (!current.rowCount) throw notFound();
      const row = current.rows[0] as { id: string; user_id: string; scope: string; status: string };
      await client.query(
        `UPDATE user_restrictions SET status = $2, reason = COALESCE($3, reason),
            lifted_at = CASE WHEN $2 = 'lifted' THEN now() ELSE NULL END,
            lifted_by = CASE WHEN $2 = 'lifted' THEN $4 ELSE NULL END
          WHERE id = $1`, [row.id, body.status, body.reason ?? null, user.id],
      );
      await audit(client, user.id, `restriction.${body.status}`, 'user_restriction', row.id, { status: row.status }, { status: body.status }, request.ip);
      return { id: row.id, status: body.status };
    });
  });

  app.delete('/api/v1/admin/restrictions/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'restrictions:manage');
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await transaction(pool, async (client) => {
      const current = await client.query('SELECT id, user_id, scope FROM user_restrictions WHERE id = $1 FOR UPDATE', [params.id]);
      if (!current.rowCount) throw notFound();
      const row = current.rows[0] as { id: string; user_id: string; scope: string };
      await client.query('DELETE FROM user_restrictions WHERE id = $1', [row.id]);
      await audit(client, user.id, 'restriction.deleted', 'user_restriction', row.id, { user_id: row.user_id, scope: row.scope }, undefined, request.ip);
    });
    return { ok: true };
  });

  /* ---- SMS campaigns (provider call stays external-dependent) ---- */
  app.get('/api/v1/admin/sms-campaigns', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'admin:read');
    const rows = await pool.query(
      `SELECT id, title, message, audience, status, scheduled_at, provider, provider_reference, failure_reason, recipients, created_at, sent_at
         FROM sms_campaigns ORDER BY created_at DESC LIMIT 200`,
    );
    return {
      items: rows.rows.map((r: Record<string, unknown>) => ({
        id: r.id, title: r.title, message: r.message, audience: r.audience, status: r.status,
        scheduledAt: r.scheduled_at, provider: r.provider, providerReference: r.provider_reference,
        failureReason: r.failure_reason, recipients: Number(r.recipients ?? 0), createdAt: r.created_at, sentAt: r.sent_at,
      })),
    };
  });

  app.post('/api/v1/admin/sms-campaigns', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'campaigns:manage');
    const data = campaignBody.parse(request.body);
    const id = randomUUID();
    const status: CampaignStatus = data.activate ? (data.scheduledAt ? 'scheduled' : 'queued') : 'draft';
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO sms_campaigns(id, title, message, audience, status, scheduled_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, data.title, data.message, data.audience, status, data.scheduledAt ?? null, user.id],
      );
      await audit(client, user.id, 'sms_campaign.created', 'sms_campaign', id, undefined, { status }, request.ip);
    });
    return reply.code(201).send({ id, status });
  });

  app.patch('/api/v1/admin/sms-campaigns/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'campaigns:manage');
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const data = campaignPatch.parse(request.body);
    return transaction(pool, async (client) => {
      const current = await client.query('SELECT id, status FROM sms_campaigns WHERE id = $1 FOR UPDATE', [params.id]);
      if (!current.rowCount) throw notFound();
      const row = current.rows[0] as { id: string; status: CampaignStatus };
      if (data.status && data.status !== row.status && !canTransitionCampaign(row.status, data.status)) {
        throw badRequest(`گذار وضعیت از ${row.status} به ${data.status} مجاز نیست.`);
      }
      await client.query(
        `UPDATE sms_campaigns SET title = COALESCE($2, title), message = COALESCE($3, message), audience = COALESCE($4, audience),
            scheduled_at = COALESCE($5, scheduled_at), status = COALESCE($6, status), updated_at = now() WHERE id = $1`,
        [row.id, data.title ?? null, data.message ?? null, data.audience ?? null, data.scheduledAt ?? null, data.status ?? null],
      );
      await audit(client, user.id, 'sms_campaign.updated', 'sms_campaign', row.id, { status: row.status }, { status: data.status ?? row.status }, request.ip);
      return { id: row.id, status: data.status ?? row.status };
    });
  });

  app.post('/api/v1/admin/sms-campaigns/:id/send', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'campaigns:manage');
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const current = await client.query('SELECT id, status, audience FROM sms_campaigns WHERE id = $1 FOR UPDATE', [params.id]);
      if (!current.rowCount) throw notFound();
      const row = current.rows[0] as { id: string; status: CampaignStatus; audience: string };
      if (row.status === 'sent') return { id: row.id, status: 'sent' };
      if (row.status === 'draft') throw badRequest('کمپین پیش‌نویس ابتدا باید فعال شود.');
      await client.query("UPDATE sms_campaigns SET status = 'queued', updated_at = now() WHERE id = $1", [row.id]);

      const integration = await client.query(
        "SELECT id, enabled, config FROM integrations WHERE code = 'sms' OR code = 'melipayamak' ORDER BY created_at LIMIT 1",
      );
      const configured = Boolean(integration.rowCount) && Boolean((integration.rows[0] as { enabled?: boolean }).enabled);
      // Requirement 143: an audience is only a candidate list — the consent gate
      // (marketing_sms ∧ ¬do_not_contact ∧ valid mobile) decides who is messaged.
      const audienceIds = row.audience.startsWith('segment:')
        ? (await client.query<{ user_id: string }>(
          `SELECT m.user_id FROM crm_segment_members m JOIN crm_segments s ON s.id = m.segment_id
           WHERE s.code = $1 OR s.id::text = $2`, [row.audience.slice(8), row.audience.slice(8)])).rows.map((r) => r.user_id)
        : row.audience.startsWith('label:')
          ? (await client.query<{ user_id: string }>(
            `SELECT c.user_id FROM crm_contact_labels cl JOIN crm_contacts c ON c.id = cl.contact_id
             JOIN crm_labels l ON l.code = cl.label_code WHERE l.title = $1 OR cl.label_code = $1`, [row.audience.slice(6)]))
            .rows.map((r) => r.user_id)
          : (await client.query<{ id: string }>(
            row.audience === 'suppliers'
              ? `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE ur.role_code = 'supplier'`
              : row.audience === 'vip'
                ? `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
                     JOIN membership_plans p ON p.id = m.plan_id WHERE m.status = 'active' AND p.tier >= 2`
                : `SELECT u.id FROM users u WHERE u.status = 'active'`, [])).rows.map((r) => r.id);
      const candidates = row.audience.startsWith('segment:') || row.audience.startsWith('label:') || row.audience === 'all'
        ? audienceIds
        : [...new Set(audienceIds)];
      const recipients = await consentedRecipients(client, candidates as string[]);
      const blockedByConsent = candidates.length - recipients.length;
      const count = recipients.length;

      if (!configured) {
        await client.query(
          `UPDATE sms_campaigns SET status = 'failed', failure_reason = 'provider_not_configured', recipients = $2, updated_at = now() WHERE id = $1`,
          [row.id, count],
        );
        await audit(client, user.id, 'sms_campaign.failed', 'sms_campaign', row.id, { status: 'queued' },
          { status: 'failed', reason: 'provider_not_configured', recipients: count, blockedByConsent }, request.ip);
        return { id: row.id, status: 'failed', reason: 'provider_not_configured', recipients: count, blockedByConsent };
      }

      // One delivery row per consented recipient; the worker drains the queue.
      const campaign = await client.query<{ title: string; message: string }>(
        'SELECT title, message FROM sms_campaigns WHERE id = $1', [row.id]);
      for (const recipient of recipients) {
        const emitted = await emitEvent(client, { eventType: 'crm.campaign_sms', entityType: 'sms_campaign',
          entityId: row.id, payload: { campaignId: row.id, userId: recipient.id }, actorId: user.id });
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), emitted.eventId, recipient.id, recipient.phone, campaign.rows[0]?.message ?? campaign.rows[0]?.title ?? '']);
        await recordTimeline(client, { userId: recipient.id, eventType: 'crm.campaign', source: 'sms_campaign',
          title: `کمپین پیامکی: ${campaign.rows[0]?.title ?? ''}`, refType: 'sms_campaign', refId: row.id, actorId: user.id });
      }
      await client.query(
        `UPDATE sms_campaigns SET status = 'sent', recipients = $2, provider = 'melipayamak', sent_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, count],
      );
      await audit(client, user.id, 'sms_campaign.sent', 'sms_campaign', row.id, { status: 'queued' },
        { status: 'sent', recipients: count, blockedByConsent }, request.ip);
      return { id: row.id, status: 'sent', recipients: count, blockedByConsent };
    });
  });
}

export type ConsolePrincipal = Principal;
