import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox as outboxEvent, requestHash } from './operations.js';
import { emitEvent } from './events.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Membership lifecycle (items 15-17).
 *
 * Money rules live here and nowhere else:
 *   - activation is only reachable through a gateway-verified payment
 *     (applyVerifiedPayment in payments.ts → /payments/webhook),
 *   - renew extends the term instead of restarting it,
 *   - upgrade charges the unused-value credit of the current term,
 *   - downgrade follows the plan's server-side policy (immediate or at expiry).
 * The frontend success page can never activate a plan by itself. */

export type MembershipRow = {
  id: string; user_id: string; plan_id: string; status: string; starts_at: Date | null; ends_at: Date | null;
  payment_intent_id: string | null; auto_renew: boolean; created_at: Date; billing_cycle: string;
};

const DAY_MS = 86_400_000;

export async function recordMembershipEvent(client: PoolClient, input: {
  membershipId: string | null; userId: string; eventType: string; fromStatus?: string | null; toStatus?: string | null;
  fromPlanId?: string | null; toPlanId?: string | null; amountRial?: bigint; creditRial?: bigint;
  note?: string | null; actorId?: string | null;
}) {
  await client.query(
    `INSERT INTO membership_events(id,membership_id,user_id,event_type,from_status,to_status,from_plan_id,to_plan_id,
       amount_rial,credit_rial,note,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), input.membershipId, input.userId, input.eventType, input.fromStatus ?? null, input.toStatus ?? null,
      input.fromPlanId ?? null, input.toPlanId ?? null, (input.amountRial ?? 0n).toString(),
      (input.creditRial ?? 0n).toString(), input.note ?? null, input.actorId ?? null]);
}

/** Unused value of the current term, used by upgrades (server-side proration). */
export function unusedCreditRial(membership: Pick<MembershipRow, 'starts_at' | 'ends_at'>, annualPriceRial: string, now = new Date()): bigint {
  if (!membership.starts_at || !membership.ends_at) return 0n;
  const start = new Date(membership.starts_at).getTime();
  const end = new Date(membership.ends_at).getTime();
  if (end <= now.getTime() || end <= start) return 0n;
  const total = end - start;
  const remaining = end - now.getTime();
  const price = rial(annualPriceRial);
  return (price * BigInt(Math.round(Math.min(remaining, total))) / BigInt(Math.round(total)));
}

type PlanSummary = { id: string; code: string; title: string; annual_price_rial: string; tier: number; active: boolean; upgrade_policy: Record<string, unknown> };
const planRow = (db: DbClient, id: string) => one<PlanSummary>(db,
  'SELECT id,code,title,annual_price_rial,tier,active,upgrade_policy FROM membership_plans WHERE id = $1', [id]);

/** Renewal stacks on top of the remaining term so paid days are never lost. */
export function renewalWindow(current: MembershipRow | null, paidAt: Date): { start: Date; end: Date } {
  const base = current?.ends_at && new Date(current.ends_at).getTime() > paidAt.getTime()
    ? new Date(current.ends_at) : paidAt;
  return { start: paidAt, end: new Date(base.getTime() + 365 * DAY_MS) };
}

export async function expireDueMemberships(pool: DbPool, now = new Date()) {
  const result = await transaction(pool, async (client) => {
    const expired = await client.query<{ id: string; user_id: string }>(
      `UPDATE memberships SET status = 'expired' WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= $1 RETURNING id,user_id`, [now]);
    for (const row of expired.rows) {
      await recordMembershipEvent(client, { membershipId: row.id, userId: row.user_id, eventType: 'expired', fromStatus: 'active', toStatus: 'expired' });
      await outboxEvent(client, 'membership.expired', 'membership', row.id, { membershipId: row.id, userId: row.user_id });
    }
    const expiring = await client.query<{ id: string; user_id: string; ends_at: Date }>(
      `SELECT id,user_id,ends_at FROM memberships
       WHERE status = 'active' AND ends_at BETWEEN $1 AND $1::timestamptz + interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM membership_events e WHERE e.membership_id = memberships.id AND e.event_type = 'expired')
         AND NOT EXISTS (SELECT 1 FROM membership_events e WHERE e.membership_id = memberships.id AND e.note = 'expiring_notice'
            AND e.created_at > $1::timestamptz - interval '6 days')`, [now]);
    for (const row of expiring.rows) {
      await recordMembershipEvent(client, { membershipId: row.id, userId: row.user_id, eventType: 'admin_changed', fromStatus: 'active',
        toStatus: 'active', note: 'expiring_notice' });
      await outboxEvent(client, 'membership.expiring', 'membership', row.id, { membershipId: row.id, userId: row.user_id, endsAt: row.ends_at });
    }
    // Scheduled downgrades become effective when the paid term ends (policy: at_expiry).
    const scheduled = await client.query<{ id: string; user_id: string; scheduled_plan_id: string; plan_id: string }>(
      `SELECT id,user_id,scheduled_plan_id,plan_id FROM memberships
       WHERE status = 'active' AND scheduled_plan_id IS NOT NULL AND ends_at IS NOT NULL AND ends_at <= $1`, [now]);
    for (const row of scheduled.rows) {
      await client.query('UPDATE memberships SET plan_id = $2, scheduled_plan_id = NULL, updated_at = now() WHERE id = $1',
        [row.id, row.scheduled_plan_id]);
      await recordMembershipEvent(client, { membershipId: row.id, userId: row.user_id, eventType: 'downgraded',
        fromPlanId: row.plan_id, toPlanId: row.scheduled_plan_id, note: 'اعمال زمان‌بندی‌شده در پایان دوره' });
      await emitEvent(client, { eventType: 'membership.downgraded', entityType: 'membership', entityId: row.id,
        payload: { membershipId: row.id, userId: row.user_id, fromPlanId: row.plan_id, toPlanId: row.scheduled_plan_id } });
    }
    return { expired: expired.rowCount ?? 0, expiring: expiring.rowCount ?? 0, downgraded: scheduled.rowCount ?? 0 };
  });
  return result;
}

export function registerMembershipLifecycleRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const currentMembership = async (userId: string) => one<MembershipRow>(pool,
    `SELECT id,user_id,plan_id,status,starts_at,ends_at,payment_intent_id,auto_renew,created_at,billing_cycle
     FROM memberships WHERE user_id = $1 AND status = 'active' AND starts_at <= now() AND ends_at > now()
     ORDER BY created_at DESC LIMIT 1`, [userId]);

  /** Quote a plan change before any money moves (server-side only). */
  app.get('/api/v1/memberships/quote', async (request) => {
    const user = await principal(request, pool, config);
    const { planId, kind } = z.object({ planId: z.uuid(), kind: z.enum(['auto', 'renewal', 'upgrade', 'downgrade']).default('auto') })
      .parse(request.query);
    const target = await planRow(pool, planId);
    if (!target?.active) throw notFound();
    const current = await currentMembership(user.id);
    const currentPlan = current ? await planRow(pool, current.plan_id) : null;
    // A renewal stacks a new year on top of the running term, so the whole year is
    // payable; upgrades are prorated against the unused value of the current term.
    const credit = kind === 'renewal' ? 0n
      : current && currentPlan ? unusedCreditRial(current, currentPlan.annual_price_rial) : 0n;
    const targetPrice = rial(target.annual_price_rial);
    const payable = targetPrice - credit;
    return {
      direction: !currentPlan ? 'new' : target.tier > currentPlan.tier ? 'upgrade' : target.tier < currentPlan.tier ? 'downgrade' : 'renew',
      currentPlan: currentPlan ? { id: currentPlan.id, code: currentPlan.code, title: currentPlan.title, tier: currentPlan.tier } : null,
      targetPlan: { id: target.id, code: target.code, title: target.title, tier: target.tier },
      targetPriceRial: asRial(targetPrice),
      creditRial: asRial(credit),
      payableRial: asRial(payable > 0n ? payable : 0n),
      downgradeEffect: String(target.upgrade_policy?.downgradeEffect ?? 'at_expiry'),
      policy: target.upgrade_policy ?? {},
    };
  });

  /** Shared purchase path for renew/upgrade: creates a pending membership + payment intent. */
  const startPaidChange = async (input: {
    userId: string; planId: string; source: 'renewal' | 'upgrade'; key: string; ip?: string; upgradedFrom?: string | null;
    amountRial: bigint; note?: string;
  }) => transaction(pool, async (client) => {
    const claim = await claimIdempotency(client, input.userId, `membership.${input.source}`, input.key, requestHash(input));
    if (claim.previous) return claim.previous as Record<string, unknown>;
    const plan = await planRow(client, input.planId);
    if (!plan?.active) throw notFound();
    if (input.amountRial === 0n) throw badRequest('مبلغ قابل پرداخت صفر است؛ برای تغییر پلن بدون پرداخت از مسیر مدیریتی استفاده کنید.');
    const membershipId = randomUUID();
    const intentId = randomUUID();
    await client.query(
      `INSERT INTO memberships(id,user_id,plan_id,status,source,upgraded_from) VALUES ($1,$2,$3,'pending_payment',$4,$5)`,
      [membershipId, input.userId, input.planId, input.source, input.upgradedFrom ?? null]);
    await client.query(
      `INSERT INTO payment_intents(id,reference,membership_id,provider,amount_rial,status)
       VALUES ($1,$2,$3,'not_configured',$4,'pending')`,
      [intentId, `MEM-${input.source.toUpperCase()}-${Date.now()}-${membershipId.slice(0, 8)}`, membershipId, input.amountRial.toString()]);
    await client.query('UPDATE memberships SET payment_intent_id = $2 WHERE id = $1', [membershipId, intentId]);
    await recordMembershipEvent(client, {
      membershipId, userId: input.userId, eventType: 'payment_pending', toStatus: 'pending_payment',
      toPlanId: input.planId, amountRial: input.amountRial, actorId: input.userId, note: input.note ?? `درخواست ${input.source}`,
    });
    await audit(client, input.userId, `membership.${input.source}_requested`, 'membership', membershipId, undefined,
      { planId: input.planId, amountRial: input.amountRial.toString() }, input.ip);
    const result = { membershipId, paymentIntentId: intentId, status: 'pending_payment', amountRial: input.amountRial.toString(), paymentAvailable: false };
    await completeIdempotency(client, input.userId, `membership.${input.source}`, input.key, result);
    return result;
  });

  app.post('/api/v1/memberships/renew', async (request, reply) => {
    const user = await principal(request, pool, config);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const current = await currentMembership(user.id);
    if (!current) throw conflict('عضویت فعالی برای تمدید وجود ندارد.');
    const plan = await planRow(pool, current.plan_id);
    if (!plan) throw notFound();
    const response = await startPaidChange({
      userId: user.id, planId: current.plan_id, source: 'renewal', key, ip: request.ip,
      amountRial: rial(plan.annual_price_rial), upgradedFrom: current.id, note: 'تمدید عضویت',
    });
    return reply.code(201).send(response);
  });

  app.post('/api/v1/memberships/upgrade', async (request, reply) => {
    const user = await principal(request, pool, config);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const body = z.object({ planId: z.uuid() }).parse(request.body);
    const target = await planRow(pool, body.planId);
    if (!target?.active) throw notFound();
    const current = await currentMembership(user.id);
    const currentPlan = current ? await planRow(pool, current.plan_id) : null;
    if (currentPlan && target.tier <= currentPlan.tier)
      throw badRequest('پلن انتخابی ارتقا نیست؛ برای تمدید یا تغییر سطح از مسیر مربوطه استفاده کنید.');
    const credit = current && currentPlan ? unusedCreditRial(current, currentPlan.annual_price_rial) : 0n;
    const payable = rial(target.annual_price_rial) - credit;
    const response = await startPaidChange({
      userId: user.id, planId: target.id, source: 'upgrade', key, ip: request.ip,
      amountRial: payable > 0n ? payable : 0n, upgradedFrom: current?.id ?? null,
      note: `ارتقا با اعتبار ${asRial(credit)} ریال از دوره فعلی`,
    });
    return reply.code(201).send(response);
  });

  /** Downgrade follows the plan policy: immediate (admin/free) or scheduled at term end. */
  app.post('/api/v1/memberships/downgrade', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ planId: z.uuid() }).parse(request.body);
    const current = await currentMembership(user.id);
    if (!current) throw conflict('عضویت فعالی وجود ندارد.');
    const from = await planRow(pool, current.plan_id);
    const to = await planRow(pool, body.planId);
    if (!from || !to?.active) throw notFound();
    if (to.tier >= from.tier) throw badRequest('پلن انتخابی پایین‌تر از پلن فعلی نیست.');
    const immediate = String(to.upgrade_policy?.downgradeEffect ?? 'at_expiry') === 'immediate';
    return transaction(pool, async (client) => {
      if (immediate) {
        await client.query('UPDATE memberships SET plan_id = $2, updated_at = now() WHERE id = $1', [current.id, to.id]);
        await recordMembershipEvent(client, { membershipId: current.id, userId: user.id, eventType: 'downgraded',
          fromStatus: current.status, toStatus: current.status, fromPlanId: from.id, toPlanId: to.id, note: 'اعمال فوری طبق سیاست پلن' });
        await emitEvent(client, { eventType: 'membership.downgraded', entityType: 'membership', entityId: current.id,
          payload: { membershipId: current.id, userId: user.id, fromPlanId: from.id, toPlanId: to.id, immediate: true }, actorId: user.id });
      } else {
        await client.query('UPDATE memberships SET scheduled_plan_id = $2, updated_at = now() WHERE id = $1', [current.id, to.id]);
        await recordMembershipEvent(client, { membershipId: current.id, userId: user.id, eventType: 'admin_changed',
          fromPlanId: from.id, toPlanId: to.id, note: 'downgrade_scheduled_at_expiry' });
      }
      await audit(client, user.id, 'membership.downgrade_requested', 'membership', current.id, { planId: from.id }, { planId: to.id }, request.ip);
      return { membershipId: current.id, effective: immediate ? 'immediate' : 'at_expiry', planId: to.id };
    });
  });

  app.post('/api/v1/memberships/cancel', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ immediate: z.boolean().default(false), reason: z.string().trim().max(300).optional() }).strict().parse(request.body ?? {});
    const current = await currentMembership(user.id);
    if (!current) throw conflict('عضویت فعالی وجود ندارد.');
    return transaction(pool, async (client) => {
      const status = body.immediate ? 'cancelled' : 'active';
      await client.query(
        `UPDATE memberships SET status = $2, auto_renew = false, cancelled_at = now(), scheduled_plan_id = NULL, updated_at = now()
         WHERE id = $1`, [current.id, status]);
      await recordMembershipEvent(client, { membershipId: current.id, userId: user.id, eventType: 'cancelled',
        fromStatus: current.status, toStatus: status, toPlanId: current.plan_id, note: body.reason ?? null, actorId: user.id });
      await outboxEvent(client, 'membership.cancelled', 'membership', current.id,
        { membershipId: current.id, userId: user.id, immediate: body.immediate });
      await audit(client, user.id, 'membership.cancelled', 'membership', current.id, { status: current.status },
        { status, immediate: body.immediate }, request.ip);
      return { membershipId: current.id, status, effective: body.immediate ? 'immediate' : 'at_expiry' };
    });
  });

  app.get('/api/v1/memberships/history', async (request) => {
    const user = await principal(request, pool, config);
    const memberships = await pool.query(
      `SELECT m.id,m.status,m.starts_at,m.ends_at,m.created_at,m.source,m.auto_renew,m.billing_cycle,
              p.code,p.title,p.tier
       FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 30`, [user.id]);
    const events = await pool.query(
      `SELECT id,event_type,from_status,to_status,from_plan_id,to_plan_id,amount_rial,credit_rial,note,created_at
       FROM membership_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [user.id]);
    return {
      memberships: memberships.rows.map((row) => ({ ...row, amount_rial: undefined })),
      events: events.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial), credit_rial: asRial(row.credit_rial) })),
    };
  });

  /* --------------------------- admin controls (item 19) --------------------------- */

  app.get('/api/v1/admin/memberships/:userId/events', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const events = await pool.query(
      `SELECT e.id,e.event_type,e.from_status,e.to_status,e.from_plan_id,e.to_plan_id,e.amount_rial,e.credit_rial,e.note,
              e.created_at,u.display_name AS actor_name
       FROM membership_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT 200`, [userId]);
    return { items: events.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial), credit_rial: asRial(row.credit_rial) })) };
  });

  app.post('/api/v1/admin/memberships/:id/suspend', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const membership = await one<MembershipRow>(client, 'SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [id]);
      if (!membership) throw notFound();
      if (membership.status !== 'active') throw conflict('فقط عضویت فعال قابل تعلیق است.');
      await client.query("UPDATE memberships SET status = 'suspended', suspended_at = now(), updated_at = now() WHERE id = $1", [id]);
      await recordMembershipEvent(client, { membershipId: id, userId: membership.user_id, eventType: 'suspended',
        fromStatus: 'active', toStatus: 'suspended', toPlanId: membership.plan_id, note: body.reason, actorId: user.id });
      await audit(client, user.id, 'membership.suspended', 'membership', id, { status: 'active' }, { status: 'suspended', reason: body.reason }, request.ip);
      return { id, status: 'suspended' };
    });
  });

  app.post('/api/v1/admin/memberships/:id/reactivate', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const membership = await one<MembershipRow>(client, 'SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [id]);
      if (!membership) throw notFound();
      if (!['suspended', 'cancelled'].includes(membership.status)) throw conflict('این عضویت در وضعیت قابل فعال‌سازی نیست.');
      const active = await one<{ id: string }>(client, "SELECT id FROM memberships WHERE user_id = $1 AND status = 'active' AND id <> $2",
        [membership.user_id, id]);
      if (active) throw conflict('کاربر عضویت فعال دیگری دارد.');
      await client.query("UPDATE memberships SET status = 'active', suspended_at = NULL, updated_at = now() WHERE id = $1", [id]);
      await recordMembershipEvent(client, { membershipId: id, userId: membership.user_id, eventType: 'reactivated',
        fromStatus: membership.status, toStatus: 'active', toPlanId: membership.plan_id, actorId: user.id });
      await audit(client, user.id, 'membership.reactivated', 'membership', id, { status: membership.status }, { status: 'active' }, request.ip);
      return { id, status: 'active' };
    });
  });

  app.post('/api/v1/admin/memberships/:id/refund', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ amountRial: z.string().regex(/^\d+$/), note: z.string().trim().max(400).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const membership = await one<MembershipRow>(client, 'SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [id]);
      if (!membership) throw notFound();
      if (membership.status === 'refunded') throw conflict('این عضویت قبلاً بازپرداخت شده است.');
      await client.query("UPDATE memberships SET status = 'refunded', refunded_at = now(), updated_at = now() WHERE id = $1", [id]);
      await recordMembershipEvent(client, { membershipId: id, userId: membership.user_id, eventType: 'refunded',
        fromStatus: membership.status, toStatus: 'refunded', toPlanId: membership.plan_id,
        amountRial: rial(body.amountRial), note: body.note ?? null, actorId: user.id });
      await outboxEvent(client, 'membership.refunded', 'membership', id,
        { membershipId: id, userId: membership.user_id, amountRial: body.amountRial });
      await audit(client, user.id, 'membership.refunded', 'membership', id, { status: membership.status },
        { status: 'refunded', amountRial: body.amountRial }, request.ip);
      return { id, status: 'refunded', amountRial: body.amountRial };
    });
  });

  /** Admin plan change (item 19): always audited, never silently applied. */
  app.post('/api/v1/admin/memberships/:id/change-plan', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ planId: z.uuid(), reason: z.string().trim().min(3).max(300) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const membership = await one<MembershipRow>(client, 'SELECT * FROM memberships WHERE id = $1 FOR UPDATE', [id]);
      if (!membership) throw notFound();
      const target = await planRow(client, body.planId);
      if (!target?.active) throw notFound();
      await client.query('UPDATE memberships SET plan_id = $2, updated_at = now() WHERE id = $1', [id, body.planId]);
      await recordMembershipEvent(client, { membershipId: id, userId: membership.user_id, eventType: 'admin_changed',
        fromPlanId: membership.plan_id, toPlanId: body.planId, note: body.reason, actorId: user.id });
      await audit(client, user.id, 'membership.plan_changed', 'membership', id,
        { planId: membership.plan_id }, { planId: body.planId, reason: body.reason }, request.ip);
      return { id, planId: body.planId, planCode: target.code };
    });
  });

  /** Worker entry point (also callable manually by an operator). */
  app.post('/api/v1/admin/memberships/run-expiry', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'memberships:manage');
    return expireDueMemberships(pool);
  });
}
