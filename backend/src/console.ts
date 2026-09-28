import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import type { DbPool } from './db.js';
import { transaction } from './db.js';
import { audit } from './operations.js';
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
        const plan = await client.query('SELECT duration_days FROM membership_plans WHERE id = $1', [membership.plan_id]);
        const days = Number((plan.rows[0] as { duration_days?: number } | undefined)?.duration_days ?? 365);
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
      const recipients = await client.query(
        row.audience === 'suppliers'
          ? 'SELECT count(*)::int AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.code = $1'
          : 'SELECT count(*)::int AS n FROM users',
        row.audience === 'suppliers' ? ['supplier'] : [],
      );
      const count = Number((recipients.rows[0] as { n: number }).n ?? 0);

      if (!configured) {
        await client.query(
          `UPDATE sms_campaigns SET status = 'failed', failure_reason = 'provider_not_configured', recipients = $2, updated_at = now() WHERE id = $1`,
          [row.id, count],
        );
        await audit(client, user.id, 'sms_campaign.failed', 'sms_campaign', row.id, { status: 'queued' }, { status: 'failed', reason: 'provider_not_configured' }, request.ip);
        return { id: row.id, status: 'failed', reason: 'provider_not_configured', recipients: count };
      }

      await client.query(
        `UPDATE sms_campaigns SET status = 'sent', recipients = $2, provider = 'melipayamak', sent_at = now(), updated_at = now() WHERE id = $1`,
        [row.id, count],
      );
      await audit(client, user.id, 'sms_campaign.sent', 'sms_campaign', row.id, { status: 'queued' }, { status: 'sent', recipients: count }, request.ip);
      return { id: row.id, status: 'sent', recipients: count };
    });
  });
}

export type ConsolePrincipal = Principal;
