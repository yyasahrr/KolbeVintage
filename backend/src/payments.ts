import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { issueInvoiceForOrder } from './invoices.js';

const limitsSchema = z.object({
  sources: z.enum(['all', 'kolbe']).default('all'),
  maxOrdersPerMonth: z.number().int().min(0).nullable().default(null),
  maxOrderValueRial: z.string().regex(/^\d+$/).nullable().default(null),
  minOrderValueRial: z.string().regex(/^\d+$/).nullable().default(null),
  maxSuppliersPerOrder: z.number().int().min(1).nullable().default(null),
  maxOrderLines: z.number().int().min(1).nullable().default(null),
  maxQuantityPerLine: z.number().int().min(1).nullable().default(null),
  discountPercent: z.number().int().min(0).max(90).default(0),
  prioritySupport: z.boolean().default(false),
  installmentAccess: z.boolean().default(false),
}).strict();
const planBody = z.object({
  code: z.string().regex(/^[a-z0-9_-]{3,40}$/), title: z.string().trim().min(2).max(120),
  description: z.string().max(1000).default(''),
  annualPriceRial: z.string().regex(/^\d+$/), limits: limitsSchema,
  features: z.array(z.string().trim().regex(/^[a-z0-9_-]{2,40}$/)).max(50).default([]),
  permissions: z.array(z.string().trim().regex(/^[a-z0-9:_-]{2,60}$/)).max(100).default([]),
  // Membership lifecycle (items 15-17): tier drives upgrade/downgrade decisions and
  // the policy states how a downgrade takes effect on the server side.
  tier: z.number().int().min(1).max(10).default(1),
  billingCycle: z.enum(['annual', 'monthly']).default('annual'),
  upgradePolicy: z.record(z.string(), z.unknown()).default({}),
});

export type VerifiedPayment = {
  provider: string;
  providerEventId: string;
  providerReference: string;
  intentId: string;
  amountRial: string;
  paidAt: Date;
};

/** Only a provider adapter that verifies a signed webhook and confirms the payment server-to-server may call this. */
export async function applyVerifiedPayment(pool: DbPool, payment: VerifiedPayment) {
  const amount = rial(payment.amountRial);
  return transaction(pool, async (client) => {
    const intent = await one<{ id: string; order_id: string | null; membership_id: string | null; amount_rial: string; status: string; reference: string; provider_reference: string | null; provider: string }>(client,
      'SELECT id,order_id,membership_id,amount_rial,status,reference,provider_reference,provider FROM payment_intents WHERE id = $1 FOR UPDATE', [payment.intentId]);
    if (!intent) throw notFound();
    if (rial(intent.amount_rial) !== amount) throw conflict('مبلغ تأییدشده با مبلغ درخواست پرداخت برابر نیست.');
    if (intent.provider_reference && intent.provider_reference !== payment.providerReference) throw conflict('شناسه تراکنش درگاه با درخواست پرداخت برابر نیست.');
    if (intent.provider !== 'not_configured' && intent.provider !== payment.provider) throw conflict('درگاه پرداخت با درخواست پرداخت برابر نیست.');
    if (intent.status === 'succeeded') {
      const previous = await one<{ id: string }>(client,
        'SELECT id FROM payment_events WHERE provider = $1 AND provider_event_id = $2 AND payment_intent_id = $3',
        [payment.provider, payment.providerEventId, intent.id]);
      if (!previous) throw conflict('پرداخت قبلاً با رویداد دیگری ثبت شده است.');
      return { intentId: intent.id, status: 'succeeded', duplicate: true };
    }
    if (intent.status !== 'pending') throw conflict('درخواست پرداخت فعال نیست.');
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO payment_events(id,provider,provider_event_id,payment_intent_id,event_type)
       VALUES ($1,$2,$3,$4,'payment.succeeded')`,
      [eventId, payment.provider, payment.providerEventId, intent.id]);
    await client.query(
      `UPDATE payment_intents SET provider = $2, provider_reference = $3, status = 'succeeded', succeeded_at = $4 WHERE id = $1`,
      [intent.id, payment.provider, payment.providerReference, payment.paidAt]);
    const entryId = randomUUID();
    await client.query('INSERT INTO journal_entries(id,reference,source_type,source_id) VALUES ($1,$2,$3,$4)',
      [entryId, `JE-${intent.reference}`, 'payment', intent.id]);
    await client.query(
      `INSERT INTO journal_lines(id,entry_id,account_id,debit_rial,credit_rial) VALUES
       ($1,$3,'00000000-0000-4000-8000-000000000001',$4,0),
       ($2,$3,'00000000-0000-4000-8000-000000000002',0,$4)`,
      [randomUUID(), randomUUID(), entryId, amount.toString()]);
    if (intent.order_id) {
      const order = await one<{ status: string }>(client, 'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [intent.order_id]);
      if (order?.status !== 'pending_payment') throw conflict('سفارش در انتظار پرداخت نیست.');
      await client.query("UPDATE orders SET status = 'paid', paid_at = $2, updated_at = now() WHERE id = $1", [intent.order_id, payment.paidAt]);
      await client.query("INSERT INTO order_events(id,order_id,from_status,to_status,note) VALUES ($1,$2,'pending_payment','paid',$3)",
        [randomUUID(), intent.order_id, `پرداخت تأیید شد: ${payment.providerReference}`]);
      await outbox(client, 'order.paid', 'order', intent.order_id, { orderId: intent.order_id, paymentIntentId: intent.id });
      await issueInvoiceForOrder(client, intent.order_id);
    }
    if (intent.membership_id) {
      const membership = await one<{ user_id: string; status: string; source: string }>(client,
        'SELECT user_id,status,source FROM memberships WHERE id = $1 FOR UPDATE', [intent.membership_id]);
      if (membership?.status !== 'pending_payment') throw conflict('عضویت در انتظار پرداخت نیست.');
      // Requirement 17: a renewal stacks on the remaining paid days; an upgrade or a
      // brand-new plan replaces the current term (credit was already priced in).
      const previous = await one<{ id: string; ends_at: Date | null }>(client,
        `SELECT id, ends_at FROM memberships WHERE user_id = $1 AND status = 'active' AND id <> $2 AND ends_at > $3 FOR UPDATE`,
        [membership.user_id, intent.membership_id, payment.paidAt]);
      const renewal = membership.source === 'renewal' && previous?.ends_at;
      const endsAt = renewal
        ? new Date(new Date(previous!.ends_at!).getTime() + 365 * 86_400_000)
        : new Date(payment.paidAt.getTime() + 365 * 86_400_000);
      await client.query(
        renewal
          ? "UPDATE memberships SET status = 'renewed' WHERE user_id = $1 AND status = 'active' AND id <> $2"
          : "UPDATE memberships SET status = 'expired' WHERE user_id = $1 AND status = 'active' AND id <> $2",
        [membership.user_id, intent.membership_id]);
      await client.query(
        `UPDATE memberships SET status = 'active', starts_at = $2, ends_at = $3 WHERE id = $1`,
        [intent.membership_id, payment.paidAt, endsAt]);
      await client.query(
        `INSERT INTO membership_events(id,membership_id,user_id,event_type,from_status,to_status,amount_rial,note,actor_id)
         VALUES ($1,$2,$3,$4,'pending_payment','active',$5,$6,NULL)`,
        [randomUUID(), intent.membership_id, membership.user_id, renewal ? 'renewed' : 'activated', amount.toString(),
          renewal ? `تمدید با انباشت دوره تا ${endsAt.toISOString()}` : 'فعال‌سازی پس از تأیید پرداخت درگاه']);
      await outbox(client, renewal ? 'membership.renewed' : 'membership.activated', 'membership', intent.membership_id,
        { membershipId: intent.membership_id, userId: membership.user_id, endsAt: endsAt.toISOString() });
      await outbox(client, 'membership.activated', 'membership', intent.membership_id,
        { membershipId: intent.membership_id, userId: membership.user_id, endsAt: endsAt.toISOString(), renewal: Boolean(renewal) });
    }
    await audit(client, null, 'payment.verified', 'payment_intent', intent.id, { status: 'pending' },
      { status: 'succeeded', provider: payment.provider, providerReference: payment.providerReference });
    return { intentId: intent.id, status: 'succeeded', duplicate: false };
  });
}

/** A real adapter must authenticate the notification and verify amount/status with the provider API. */
export interface PaymentProviderAdapter {
  providerCode: string;
  checkoutUrl(providerReference: string): string;
  createCheckout(input: { intentId: string; reference: string; amountRial: string; returnUrl: string }): Promise<{ url: string; providerReference: string }>;
  verifyNotification(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifiedPayment>;
}

export function registerPaymentRoutes(app: FastifyInstance, pool: DbPool, config: Config, adapters: Record<string, PaymentProviderAdapter> = {}) {
  app.get('/api/v1/plans', async (request) => {
    const user = await principal(request, pool, config).catch(() => null);
    const privileged = !!user && (user.permissions.includes('plans:manage') || user.permissions.includes('users:manage'));
    const columns = privileged
      ? 'id,code,title,description,annual_price_rial,limits,features,permissions,active,tier,billing_cycle,upgrade_policy'
      : `id,code,title,description,annual_price_rial,
         jsonb_build_object('sources', limits->'sources', 'discountPercent', limits->'discountPercent',
           'maxOrdersPerMonth', limits->'maxOrdersPerMonth', 'maxOrderValueRial', limits->'maxOrderValueRial',
           'prioritySupport', limits->'prioritySupport', 'installmentAccess', limits->'installmentAccess') AS limits,
         features`;
    const rows = await pool.query(`SELECT ${columns} FROM membership_plans WHERE active ORDER BY annual_price_rial`);
    return { items: rows.rows.map((row) => ({ ...row, annual_price_rial: asRial(row.annual_price_rial) })) };
  });

  app.get('/api/v1/membership/current', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<{ id: string; status: string; starts_at: Date; ends_at: Date; plan_id: string;
      code: string; title: string; description: string; limits: Record<string, unknown>; features: string[]; permissions: string[] }>(pool,
      `SELECT m.id,m.status,m.starts_at,m.ends_at,p.id AS plan_id,p.code,p.title,p.description,p.limits,p.features,p.permissions,
              p.tier,p.billing_cycle
       FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
       ORDER BY m.created_at DESC LIMIT 1`, [user.id]);
    if (!row) return { membership: null };
    return { membership: row };
  });

  app.post('/api/v1/plans', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'plans:manage');
    const body = planBody.parse(request.body);
    rial(body.annualPriceRial);
    if (body.limits.maxOrderValueRial !== null) rial(body.limits.maxOrderValueRial);
    if (body.limits.minOrderValueRial !== null) rial(body.limits.minOrderValueRial);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO membership_plans(id,code,title,description,annual_price_rial,limits,features,permissions,
           tier,billing_cycle,upgrade_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, body.code, body.title, body.description, body.annualPriceRial, JSON.stringify(body.limits),
          JSON.stringify(body.features), body.permissions, body.tier, body.billingCycle,
          JSON.stringify(body.upgradePolicy)]);
      await audit(client, user.id, 'plan.created', 'membership_plan', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/plans/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'plans:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = planBody.omit({ code: true }).partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM membership_plans WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.annualPriceRial !== undefined) rial(body.annualPriceRial);
      if (body.limits?.maxOrderValueRial != null) rial(body.limits.maxOrderValueRial);
      if (body.limits?.minOrderValueRial != null) rial(body.limits.minOrderValueRial);
      await client.query(
        `UPDATE membership_plans SET title = COALESCE($2, title), description = COALESCE($3, description),
           annual_price_rial = COALESCE($4, annual_price_rial), limits = COALESCE($5, limits),
           features = COALESCE($6, features), permissions = COALESCE($7, permissions),
           tier = COALESCE($8, tier), billing_cycle = COALESCE($9, billing_cycle),
           upgrade_policy = COALESCE($10, upgrade_policy)
         WHERE id = $1`,
        [id, body.title ?? null, body.description ?? null, body.annualPriceRial ?? null,
          body.limits ? JSON.stringify(body.limits) : null,
          body.features ? JSON.stringify(body.features) : null, body.permissions ?? null,
          body.tier ?? null, body.billingCycle ?? null,
          body.upgradePolicy ? JSON.stringify(body.upgradePolicy) : null]);
      await audit(client, user.id, 'plan.updated', 'membership_plan', id, before, body, request.ip);
      return { id, ...body };
    });
  });

  app.post('/api/v1/memberships', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({ planId: z.uuid() }).parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'membership.create', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const plan = await one<{ annual_price_rial: string; active: boolean }>(client,
        'SELECT annual_price_rial,active FROM membership_plans WHERE id = $1', [body.planId]);
      if (!plan?.active) throw notFound();
      if (rial(plan.annual_price_rial) === 0n) throw badRequest('فعال‌سازی پلن رایگان به مسیر جداگانه احراز کسب‌وکار نیاز دارد.');
      const membershipId = randomUUID();
      const intentId = randomUUID();
      await client.query("INSERT INTO memberships(id,user_id,plan_id,status) VALUES ($1,$2,$3,'pending_payment')",
        [membershipId, user.id, body.planId]);
      await client.query(
        `INSERT INTO payment_intents(id,reference,membership_id,provider,amount_rial,status)
         VALUES ($1,$2,$3,'not_configured',$4,'pending')`,
        [intentId, `MEM-${Date.now()}-${membershipId.slice(0, 8)}`, membershipId, plan.annual_price_rial]);
      await client.query('UPDATE memberships SET payment_intent_id = $2 WHERE id = $1', [membershipId, intentId]);
      await audit(client, user.id, 'membership.created', 'membership', membershipId, undefined,
        { planId: body.planId, amountRial: plan.annual_price_rial }, request.ip);
      const result = { membershipId, paymentIntentId: intentId, status: 'pending_payment', paymentAvailable: false };
      await completeIdempotency(client, user.id, 'membership.create', key, result);
      return result;
    });
    return reply.code(201).send(response);
  });

  // No payment-success route is exposed without a verified provider adapter.
  if (Object.keys(adapters).length) {
    app.post('/api/v1/payments/:id/checkout', async (request) => {
      const user = await principal(request, pool, config);
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const intent = await one<{ id: string; reference: string; amount_rial: string; status: string; provider: string; provider_reference: string | null; buyer_id: string | null; membership_user_id: string | null; order_type: string | null; payment_mode: string | null }>(client,
          `SELECT p.id,p.reference,p.amount_rial,p.status,p.provider,p.provider_reference,o.buyer_id,m.user_id AS membership_user_id,o.order_type,o.payment_mode
           FROM payment_intents p LEFT JOIN orders o ON o.id = p.order_id
           LEFT JOIN memberships m ON m.id = p.membership_id WHERE p.id = $1 FOR UPDATE OF p`, [id]);
        if (!intent || (intent.buyer_id !== user.id && intent.membership_user_id !== user.id)) throw notFound();
        if (intent.status !== 'pending') throw conflict('درخواست پرداخت فعال نیست.');
        const adapter = adapters[intent.provider];
        if (!adapter) throw conflict('درگاه این روش پرداخت هنوز فعال نیست.');
        if (adapter.providerCode === 'zibal' && (intent.order_type !== 'retail' || intent.payment_mode !== 'cash'))
          throw conflict('زیبال فقط برای خرید نقدی خرده‌فروشی فعال است.');
        if (adapter.providerCode === 'nextpay' && (intent.order_type !== 'wholesale' || intent.payment_mode !== 'cash'))
          throw conflict('نکست‌پی فقط برای خرید نقدی عمده فعال است.');
        if (intent.provider_reference) {
          await client.query('COMMIT');
          return { url: adapter.checkoutUrl(intent.provider_reference) };
        }
        const checkout = await adapter.createCheckout({ intentId: id, reference: intent.reference,
          amountRial: asRial(intent.amount_rial), returnUrl: `${config.API_PUBLIC_URL}/api/v1/payments/callback` });
        await client.query('UPDATE payment_intents SET provider_reference = $2 WHERE id = $1', [id, checkout.providerReference]);
        await client.query('COMMIT');
        return { url: checkout.url };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    });
    app.post('/api/v1/payments/webhook', { config: { rawBody: true } }, async (request) => {
      const raw = request.rawBody;
      if (!Buffer.isBuffer(raw)) throw badRequest('بدنه امضاشده پرداخت موجود نیست.');
      const provider = z.object({ provider: z.string() }).parse(request.query).provider;
      const adapter = adapters[provider];
      if (!adapter) throw notFound();
      const verified = await adapter.verifyNotification(raw, request.headers);
      return applyVerifiedPayment(pool, verified);
    });
    app.get('/api/v1/payments/callback', async (request) => {
      const query = z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(request.query);
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        const field = Array.isArray(value) ? value[0] : value;
        if (field !== undefined) parameters.set(key, field);
      }
      const provider = z.string().parse(parameters.get('provider'));
      const adapter = adapters[provider];
      if (!adapter) throw notFound();
      const verified = await adapter.verifyNotification(Buffer.from(parameters.toString(), 'utf8'), request.headers);
      return applyVerifiedPayment(pool, verified);
    });
  }
}
