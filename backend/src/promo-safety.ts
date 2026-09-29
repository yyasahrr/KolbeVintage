import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { asRial } from './money.js';
import { audit, outbox } from './operations.js';
import { emitEvent } from './events.js';
import { createCoupon, generateCouponCode } from './coupons.js';
import { badRequest, conflict, notFound } from './errors.js';
import { consentedRecipients, recordTimeline } from './crm-intelligence.js';

/* CRM ↔ promotion flow with safety rails (items 136-143).
   Nothing here sends or mints coupons unless every configured cap allows it, and
   dry-run always answers first: how many customers match, and who are they. */

export type SafetySnapshot = {
  allowed: boolean;
  reasons: string[];
  audienceCap: number | null;
  matched: number;
  capped: number;
  budgetRemainingRial: string | null;
  runsToday: number;
  dailyRunCap: number | null;
  cooldownRemainingHours: number | null;
  status: string;
};

type AutomationRow = {
  id: string; code: string; name: string; automation_type: string; config: Record<string, unknown>;
  active: boolean; status: string; trigger_code: string | null; target_kind: string | null; target_ref: string | null;
  daily_run_cap: number | null; audience_cap: number | null; cooldown_hours: number; budget_cap_rial: string | null;
  budget_spent_rial: string; expires_at: Date | null; dry_run_required: boolean; manual_approval_required: boolean;
  approved_by: string | null; approved_at: Date | null; runs_today: number; runs_today_date: string | null;
  last_run_at: Date | null; last_dry_run_at: Date | null; last_dry_run_match_count: number | null; coupon_template_code: string | null;
};

/** Read + evaluate the safety state of one automation (requirement 137). */
export async function safetySnapshot(client: DbClient, automation: AutomationRow, matched: number): Promise<SafetySnapshot> {
  const reasons: string[] = [];
  const today = await one<{ today: string }>(client,
    `SELECT to_char(now() AT TIME ZONE 'Asia/Tehran', 'YYYY-MM-DD') AS today`);
  const runsToday = automation.runs_today_date === today?.today ? automation.runs_today : 0;
  if (automation.status !== 'active') reasons.push(`وضعیت «${automation.status}» اجازه اجرای خودکار نمی‌دهد.`);
  if (automation.expires_at && new Date(automation.expires_at).getTime() < Date.now()) reasons.push('این قاعده منقضی شده است.');
  if (automation.daily_run_cap !== null && runsToday >= automation.daily_run_cap) reasons.push('سقف اجرای روزانه تکمیل شده است.');
  if (automation.audience_cap !== null && matched > automation.audience_cap)
    reasons.push(`تعداد مخاطب (${matched}) از سقف مجاز (${automation.audience_cap}) بیشتر است.`);
  let cooldownRemainingHours: number | null = null;
  if (automation.last_run_at && automation.cooldown_hours > 0) {
    const elapsed = (Date.now() - new Date(automation.last_run_at).getTime()) / 3_600_000;
    if (elapsed < automation.cooldown_hours) {
      cooldownRemainingHours = Math.ceil(automation.cooldown_hours - elapsed);
      reasons.push(`دوره خنک‌سازی فعال است؛ ${cooldownRemainingHours} ساعت باقی مانده.`);
    }
  }
  if (automation.manual_approval_required && !automation.approved_at) reasons.push('این قاعده هنوز تأیید انسانی نشده است.');
  if (automation.dry_run_required && !automation.last_dry_run_at) reasons.push('قبل از اجرا باید تست خشک گرفته شود.');
  const remaining = automation.budget_cap_rial === null ? null
    : BigInt(automation.budget_cap_rial) - BigInt(automation.budget_spent_rial);
  if (remaining !== null && remaining <= 0n) reasons.push('سقف بودجه این قاعده تکمیل شده است.');
  return {
    allowed: reasons.length === 0, reasons, matched, audienceCap: automation.audience_cap,
    capped: automation.audience_cap === null ? matched : Math.min(matched, automation.audience_cap),
    budgetRemainingRial: remaining === null ? null : remaining.toString(),
    runsToday, dailyRunCap: automation.daily_run_cap, cooldownRemainingHours, status: automation.status,
  };
}

type MatchContext = { triggerCode: string | null; config: Record<string, unknown>; targetKind: string | null; targetRef: string | null };

/** Audience matcher shared by dry-run and real issuance — the rule lives server-side. */
async function matchAudience(client: DbClient, context: MatchContext): Promise<Array<{ id: string; display_name: string; phone: string | null; reason: string }>> {
  if (context.targetKind === 'label' && context.targetRef) {
    const rows = await client.query<{ id: string; display_name: string; phone: string | null }>(
      `SELECT u.id,u.display_name,u.phone FROM crm_contact_labels cl
       JOIN crm_contacts c ON c.id = cl.contact_id JOIN users u ON u.id = c.user_id
       WHERE cl.label_code = $1 AND (cl.expires_at IS NULL OR cl.expires_at > now()) AND u.status = 'active'`,
      [context.targetRef]);
    return rows.rows.map((row) => ({ ...row, reason: `برچسب ${context.targetRef}` }));
  }
  if (context.targetKind === 'segment' && context.targetRef) {
    const rows = await client.query<{ id: string; display_name: string; phone: string | null }>(
      `SELECT u.id,u.display_name,u.phone FROM crm_segment_members m JOIN users u ON u.id = m.user_id
       WHERE m.segment_id::text = $1 AND u.status = 'active'`, [context.targetRef]);
    return rows.rows.map((row) => ({ ...row, reason: `سگمنت ${context.targetRef}` }));
  }
  const thresholdRial = String(context.config.spendThresholdRial ?? '0');
  const days = Number(context.config.days ?? 60);
  const queries: Record<string, { sql: string; params: unknown[]; reason: string }> = {
    spend_threshold: {
      sql: `SELECT u.id,u.display_name,u.phone, sum(o.total_rial)::text AS metric FROM users u
            JOIN orders o ON o.buyer_id = u.id AND o.status NOT IN ('cancelled','pending_payment')
            WHERE u.status = 'active' GROUP BY u.id,u.display_name,u.phone HAVING sum(o.total_rial) >= $1::bigint`,
      params: [thresholdRial], reason: `مجموع خرید ≥ ${thresholdRial} ریال`,
    },
    inactivity_60d: {
      sql: `SELECT u.id,u.display_name,u.phone, max(o.created_at)::text AS metric FROM users u
            JOIN orders o ON o.buyer_id = u.id WHERE u.status = 'active'
            GROUP BY u.id,u.display_name,u.phone HAVING max(o.created_at) < now() - ($1::int || ' days')::interval`,
      params: [days], reason: `${days} روز بی‌فعالیتی`,
    },
    first_order: {
      sql: `SELECT u.id,u.display_name,u.phone, count(*)::text AS metric FROM users u
            JOIN orders o ON o.buyer_id = u.id AND o.status NOT IN ('cancelled','pending_payment')
            WHERE u.status = 'active' GROUP BY u.id,u.display_name,u.phone HAVING count(*) = 1`,
      params: [], reason: 'اولین خرید',
    },
    fifth_order: {
      sql: `SELECT u.id,u.display_name,u.phone, count(*)::text AS metric FROM users u
            JOIN orders o ON o.buyer_id = u.id AND o.status NOT IN ('cancelled','pending_payment')
            WHERE u.status = 'active' GROUP BY u.id,u.display_name,u.phone HAVING count(*) >= 5`,
      params: [], reason: 'پنجمین خرید',
    },
    membership_expiry: {
      sql: `SELECT u.id,u.display_name,u.phone, m.ends_at::text AS metric FROM users u
            JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            WHERE u.status = 'active' AND m.ends_at BETWEEN now() AND now() + ($1::int || ' days')::interval`,
      params: [days], reason: `انقضای عضویت در ${days} روز آینده`,
    },
    membership_activated: {
      sql: `SELECT u.id,u.display_name,u.phone, m.starts_at::text AS metric FROM users u
            JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            WHERE u.status = 'active' AND m.starts_at > now() - ($1::int || ' days')::interval`,
      params: [days], reason: 'فعال‌سازی اخیر عضویت',
    },
    vip_upgrade: {
      sql: `SELECT u.id,u.display_name,u.phone, p.tier::text AS metric FROM users u
            JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
            JOIN membership_plans p ON p.id = m.plan_id WHERE u.status = 'active' AND p.tier >= 2`,
      params: [], reason: 'عضویت VIP',
    },
    cart_abandoned: {
      sql: `SELECT u.id,u.display_name,u.phone, max(e.created_at)::text AS metric FROM users u
            JOIN recommendation_events e ON e.user_id = u.id AND e.event_type = 'added_to_cart'
            LEFT JOIN orders o ON o.buyer_id = u.id AND o.created_at > e.created_at AND o.status NOT IN ('cancelled','pending_payment')
            WHERE u.status = 'active' AND o.id IS NULL AND e.created_at > now() - ($1::int || ' days')::interval
            GROUP BY u.id,u.display_name,u.phone`,
      params: [days], reason: `سبد رهاشده در ${days} روز اخیر`,
    },
    review_low_rating: {
      sql: `SELECT DISTINCT u.id,u.display_name,u.phone, r.rating::text AS metric FROM users u
            JOIN customer_reviews r ON r.user_id = u.id AND r.rating <= 2
            WHERE u.status = 'active' AND r.created_at > now() - ($1::int || ' days')::interval`,
      params: [days], reason: 'نظر ۱ یا ۲ ستاره',
    },
    review_high_rating: {
      sql: `SELECT DISTINCT u.id,u.display_name,u.phone, r.rating::text AS metric FROM users u
            JOIN customer_reviews r ON r.user_id = u.id AND r.rating >= 4
            WHERE u.status = 'active' AND r.created_at > now() - ($1::int || ' days')::interval`,
      params: [days], reason: 'نظر ۴ یا ۵ ستاره',
    },
    order_returned: {
      sql: `SELECT DISTINCT u.id,u.display_name,u.phone, r.created_at::text AS metric FROM users u
            JOIN return_requests r ON r.requester_id = u.id
            WHERE u.status = 'active' AND r.created_at > now() - ($1::int || ' days')::interval`,
      params: [days], reason: 'مرجوعی اخیر',
    },
    failed_payment: {
      sql: `SELECT DISTINCT u.id,u.display_name,u.phone, p.failed_at::text AS metric FROM users u
            JOIN payment_intents p ON p.user_id = u.id AND p.status = 'failed'
            WHERE u.status = 'active' AND p.created_at > now() - ($1::int || ' days')::interval`,
      params: [days], reason: 'پرداخت ناموفق اخیر',
    },
    birthday: {
      sql: `SELECT u.id,u.display_name,u.phone, u.birthday::text AS metric FROM users u
            WHERE u.status = 'active' AND u.birthday IS NOT NULL
              AND EXTRACT(MONTH FROM u.birthday) = EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Tehran'))
              AND EXTRACT(DAY FROM u.birthday) = EXTRACT(DAY FROM (now() AT TIME ZONE 'Asia/Tehran'))`,
      params: [], reason: 'تولد امروز',
    },
  };
  const entry = context.triggerCode ? queries[context.triggerCode] : undefined;
  if (!entry) return [];
  try {
    const rows = await client.query<{ id: string; display_name: string; phone: string | null }>(entry.sql, entry.params);
    return rows.rows.map((row) => ({ ...row, reason: entry.reason }));
  } catch {
    // A trigger whose source table is absent must not break the whole console.
    return [];
  }
}

/** What the customer's personal coupon instance would look like (requirement 140):
 *  code shape, ownership, single-use rule, expiry, minimum order, scope, instalments. */
export async function previewTemplateCoupon(client: DbClient, templateCode: string,
  owner: { id: string; display_name: string } | null, validityOverrideDays?: number) {
  const template = await one<{
    code: string; title: string; type: 'percent' | 'fixed'; value: string; max_discount_rial: string | null;
    min_order_rial: string; usage_limit_per_user: number; validity_days: number;
    scope: { productIds?: string[]; categories?: string[] }; installment_policy: string; code_prefix: string;
    message_template: string;
  }>(client, 'SELECT * FROM coupon_campaign_templates WHERE code = $1', [templateCode]);
  if (!template) return null;
  const validityDays = validityOverrideDays ?? template.validity_days;
  const storeCreditRial = (template.type === 'fixed' ? template.value : `${template.value}%`)
    .toString();
  return {
    templateCode: template.code, title: template.title,
    codeExample: `${template.code_prefix}-${randomBytes(4).toString('hex').toUpperCase()}`,
    ownerUserId: owner?.id ?? null, ownerName: owner?.display_name ?? null,
    percent: template.type === 'percent' ? Number(template.value) : null,
    value: template.value, type: template.type, maxDiscountRial: template.max_discount_rial,
    singleUse: template.usage_limit_per_user === 1, usageLimitPerUser: template.usage_limit_per_user,
    minOrderRial: template.min_order_rial, expiresAt: new Date(Date.now() + validityDays * 86_400_000).toISOString(),
    validityDays, allowedProductIds: template.scope?.productIds ?? [], allowedCategories: template.scope?.categories ?? [],
    installmentPolicy: template.installment_policy, storeCreditRial,
    messagePreview: owner ? template.message_template.replaceAll('{name}', owner.display_name)
      .replaceAll('{code}', `${template.code_prefix}-XXXX`) : template.message_template,
  };
}

/** Personal, single-use coupon instances from a template (requirements 140-141). */
export async function issueTemplateCoupons(client: DbClient, input: {
  templateCode: string; runId: string; audience: Array<{ id: string; display_name: string; phone: string | null }>;
  issuedBy: string | null; dryRun: boolean; extraCodes?: Record<string, string>;
}) {
  const template = await one<{
    code: string; title: string; type: 'percent' | 'fixed'; value: string; max_discount_rial: string | null;
    min_order_rial: string; usage_limit_per_user: number; usage_limit_total: number | null; validity_days: number;
    scope: { productIds?: string[]; categories?: string[] }; audience: string[]; installment_policy: string;
    code_prefix: string; message_template: string; trigger_code: string | null;
  }>(client, 'SELECT * FROM coupon_campaign_templates WHERE code = $1 AND active', [input.templateCode]);
  if (!template) throw notFound();
  const issued: Array<{ userId: string; code: string; couponId: string }> = [];
  const skipped: Array<{ userId: string; reason: string }> = [];
  for (const member of input.audience) {
    const existing = await one<{ code: string }>(client,
      `SELECT code FROM coupons WHERE recipient_user_id = $1 AND template_code = $2
         AND (created_at AT TIME ZONE 'Asia/Tehran')::date = (now() AT TIME ZONE 'Asia/Tehran')::date`,
      [member.id, template.code]);
    if (existing) { skipped.push({ userId: member.id, reason: 'already_issued_today' }); continue; }
    const code = input.extraCodes?.[member.id] ?? generateCouponCode(template.code_prefix);
    if (input.dryRun) { issued.push({ userId: member.id, code: '(تست خشک)', couponId: '' }); continue; }
    const endsAt = new Date(Date.now() + template.validity_days * 86_400_000);
    const coupon = await createCoupon(client, {
      code, type: template.type, value: String(template.value),
      maxDiscountRial: template.max_discount_rial, minOrderRial: template.min_order_rial,
      usageLimitPerUser: template.usage_limit_per_user, usageLimitTotal: template.usage_limit_total,
      recipientUserId: member.id, audience: template.audience.length ? template.audience : ['all'],
      scope: template.scope ?? {}, endsAt, source: 'campaign',
      campaignName: `${template.title} — ${member.display_name}`,
      createdBy: input.issuedBy ?? null,
    });
    await client.query(
      `UPDATE coupons SET template_code = $2, installment_policy = $3, issued_run_id = $4, generation_meta = $5 WHERE id = $1`,
      [coupon.id, template.code, template.installment_policy, input.runId,
        JSON.stringify({ template: template.code, runId: input.runId, trigger: template.trigger_code, issuedAt: new Date().toISOString() })]);
    if (member.phone && /^09\d{9}$/.test(member.phone)) {
      const message = template.message_template.replaceAll('{name}', member.display_name).replaceAll('{code}', coupon.code);
      const emitted = await emitEvent(client, { eventType: 'coupon.personal_issued', entityType: 'coupon', entityId: coupon.id,
        payload: { couponId: coupon.id, template: template.code, userId: member.id, runId: input.runId }, actorId: input.issuedBy });
      const consented = await consentedRecipients(client, [member.id] as string[]);
      await outbox(client, 'crm.campaign_sms', 'coupon', coupon.id,
        { couponId: coupon.id, userId: member.id, code: coupon.code, consented: consented.length > 0 });
      if (consented.length) {
        await client.query('INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), emitted.eventId, member.id, member.phone, message]);
      }
    }
    await recordTimeline(client, { userId: member.id, eventType: 'coupon.personal', source: 'crm',
      title: `کوپن شخصی ${template.title}`, description: `کد ${coupon.code}`,
      refType: 'coupon', refId: coupon.id, actorId: input.issuedBy });
    issued.push({ userId: member.id, code: coupon.code, couponId: coupon.id });
  }
  return { issued, skipped };
}

export function registerPromoSafetyRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ----------------------------- trigger catalog ----------------------------- */
  app.get('/api/v1/admin/promo/triggers', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const rows = await pool.query(
      `SELECT t.*, (SELECT count(*)::int FROM crm_automations a WHERE a.trigger_code = t.code) AS automations
       FROM crm_trigger_catalog t ORDER BY t.category, t.code`);
    return { items: rows.rows };
  });

  /* --------------------------- coupon templates (141) --------------------------- */
  const templateBody = z.object({
    code: z.string().trim().regex(/^[a-z0-9_]{3,40}$/),
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(400).default(''),
    type: z.enum(['percent', 'fixed']),
    value: z.string().regex(/^\d+$/),
    maxDiscountRial: z.string().regex(/^\d+$/).nullable().optional(),
    minOrderRial: z.string().regex(/^\d+$/).default('0'),
    usageLimitPerUser: z.number().int().min(1).max(100).default(1),
    usageLimitTotal: z.number().int().min(1).nullable().optional(),
    validityDays: z.number().int().min(1).max(365).default(14),
    scope: z.object({ productIds: z.array(z.uuid()).max(200).optional(), categories: z.array(z.string().max(80)).max(100).optional() }).default({}),
    audience: z.array(z.enum(['all', 'customer', 'vip', 'wholesale'])).max(4).default(['all']),
    installmentPolicy: z.enum(['inherit', 'cash_only', 'installment_only', 'no_interest']).default('inherit'),
    codePrefix: z.string().trim().regex(/^[A-Z0-9-]{2,12}$/).default('KV'),
    messageTemplate: z.string().trim().min(5).max(600).default('{name} عزیز، کد تخفیف اختصاصی شما: {code}'),
    triggerCode: z.string().trim().max(60).nullable().optional(),
    active: z.boolean().default(true),
  }).strict();

  app.get('/api/v1/admin/promo/templates', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const rows = await pool.query(
      `SELECT t.*, (SELECT count(*)::int FROM coupons c WHERE c.template_code = t.code) AS issued_count
       FROM coupon_campaign_templates t ORDER BY t.created_at DESC`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/promo/templates', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const body = templateBody.parse(request.body);
    if (body.type === 'percent' && Number(body.value) > 100) throw badRequest('درصد تخفیف باید حداکثر ۱۰۰ باشد.');
    return transaction(pool, async (client) => {
      const existing = await one(client, 'SELECT code FROM coupon_campaign_templates WHERE code = $1', [body.code]);
      if (existing) throw conflict('قالبی با این کد وجود دارد.');
      await client.query(
        `INSERT INTO coupon_campaign_templates(code,title,description,type,value,max_discount_rial,min_order_rial,
           usage_limit_per_user,usage_limit_total,validity_days,scope,audience,installment_policy,code_prefix,message_template,
           trigger_code,active,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [body.code, body.title, body.description, body.type, body.value, body.maxDiscountRial ?? null,
          body.minOrderRial, body.usageLimitPerUser, body.usageLimitTotal ?? null, body.validityDays,
          JSON.stringify(body.scope), body.audience, body.installmentPolicy, body.codePrefix, body.messageTemplate,
          body.triggerCode ?? null, body.active, user.id]);
      await audit(client, user.id, 'promo.template_created', 'coupon_campaign_template', body.code, undefined, body, request.ip);
      return reply.code(201).send({ code: body.code });
    });
  });

  app.patch('/api/v1/admin/promo/templates/:code', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const { code } = z.object({ code: z.string().max(40) }).parse(request.params);
    const body = templateBody.partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM coupon_campaign_templates WHERE code = $1 FOR UPDATE', [code]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE coupon_campaign_templates SET title = COALESCE($2,title), description = COALESCE($3,description),
           type = COALESCE($4,type), value = COALESCE($5,value), max_discount_rial = COALESCE($6,max_discount_rial),
           min_order_rial = COALESCE($7,min_order_rial), usage_limit_per_user = COALESCE($8,usage_limit_per_user),
           usage_limit_total = COALESCE($9,usage_limit_total), validity_days = COALESCE($10,validity_days),
           scope = COALESCE($11,scope), audience = COALESCE($12,audience), installment_policy = COALESCE($13,installment_policy),
           code_prefix = COALESCE($14,code_prefix), message_template = COALESCE($15,message_template),
           trigger_code = COALESCE($16,trigger_code), active = COALESCE($17,active), updated_at = now()
         WHERE code = $1`,
        [code, body.title ?? null, body.description ?? null, body.type ?? null, body.value ?? null,
          body.maxDiscountRial ?? null, body.minOrderRial ?? null, body.usageLimitPerUser ?? null,
          body.usageLimitTotal ?? null, body.validityDays ?? null, body.scope ? JSON.stringify(body.scope) : null,
          body.audience ?? null, body.installmentPolicy ?? null, body.codePrefix ?? null, body.messageTemplate ?? null,
          body.triggerCode ?? null, body.active ?? null]);
      await audit(client, user.id, 'promo.template_updated', 'coupon_campaign_template', code, before, body, request.ip);
      return one(client, 'SELECT * FROM coupon_campaign_templates WHERE code = $1', [code]);
    });
  });

  /** Dry run (item 138): "این Rule روی ۱۲۷ کاربر Match میشود" + a sample of them. */
  app.post('/api/v1/admin/promo/templates/:code/dry-run', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const { code } = z.object({ code: z.string().max(40) }).parse(request.params);
    const body = z.object({
      triggerCode: z.string().trim().max(60).nullable().optional(),
      targetKind: z.enum(['label', 'segment', 'customer']).nullable().optional(),
      targetRef: z.string().trim().max(80).nullable().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
      sampleSize: z.number().int().min(1).max(50).default(10),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const template = await one<{ code: string; trigger_code: string | null; title: string }>(client,
        'SELECT code,trigger_code,title FROM coupon_campaign_templates WHERE code = $1', [code]);
      if (!template) throw notFound();
      const matched = await matchAudience(client, {
        triggerCode: body.triggerCode ?? template.trigger_code ?? null, config: body.config,
        targetKind: body.targetKind ?? null, targetRef: body.targetRef ?? null,
      });
      const consented = await consentedRecipients(client, matched.map((row: { id: string }) => row.id) as string[]);
      const consentIds = new Set(consented.map((row) => row.id));
      const estimatedDiscount = matched.length * (template.code ? Number((await one<{ value: string }>(client,
        'SELECT value FROM coupon_campaign_templates WHERE code = $1', [code]))?.value ?? 0) : 0);
      await client.query(
        `UPDATE coupon_campaign_templates SET updated_at = now() WHERE code = $1`, [code]);
      await audit(client, user.id, 'promo.template_dry_run', 'coupon_campaign_template', code, undefined,
        { matched: matched.length, consented: consented.length, trigger: body.triggerCode ?? template.trigger_code }, request.ip);
      return {
        template: code, title: template.title,
        message: `این قاعده روی ${matched.length} کاربر Match می‌شود (${consented.length} کاربر با رضایت بازاریابی).`,
        matchCount: matched.length, consentedCount: consented.length,
        blockedByConsent: matched.length - consented.length,
        estimatedDiscountRial: asRial(String(estimatedDiscount)),
        sample: matched.slice(0, body.sampleSize).map((row) => ({
          userId: row.id, displayName: row.display_name,
          phoneMasked: row.phone ? `${row.phone.slice(0, 4)}***${row.phone.slice(-2)}` : null,
          consent: consentIds.has(row.id), reason: row.reason,
        })),
        dryRun: true,
        note: 'هیچ کوپنی در تست خشک صادر و هیچ پیامی ارسال نمی‌شود.',
      };
    });
  });

  /** Issue personal coupon instances to the matched audience (item 140/141). */
  app.post('/api/v1/admin/promo/templates/:code/issue', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const { code } = z.object({ code: z.string().max(40) }).parse(request.params);
    const body = z.object({
      triggerCode: z.string().trim().max(60).nullable().optional(),
      targetKind: z.enum(['label', 'segment', 'customer']).nullable().optional(),
      targetRef: z.string().trim().max(80).nullable().optional(),
      config: z.record(z.string(), z.unknown()).default({}),
      dryRun: z.boolean().default(true),
      confirmMatchCount: z.number().int().min(0).optional(),
      reason: z.string().trim().max(300).default(''),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const template = await one<{ code: string; trigger_code: string | null }>(client,
        'SELECT code,trigger_code FROM coupon_campaign_templates WHERE code = $1 AND active', [code]);
      if (!template) throw notFound();
      const matched = await matchAudience(client, {
        triggerCode: body.triggerCode ?? template.trigger_code ?? null, config: body.config,
        targetKind: body.targetKind ?? null, targetRef: body.targetRef ?? null,
      });
      // A dry run must be re-confirmed with the same count before anything is created.
      if (!body.dryRun && body.confirmMatchCount !== undefined && body.confirmMatchCount !== matched.length) {
        throw conflict(`تعداد مخاطب تغییر کرده است (اکنون ${matched.length} کاربر). تست خشک را تکرار کنید.`);
      }
      const runId = randomUUID();
      const issued = await issueTemplateCoupons(client, {
        templateCode: code, runId, audience: matched, issuedBy: user.id, dryRun: body.dryRun,
      });
      await audit(client, user.id, body.dryRun ? 'promo.issue_dry_run' : 'promo.coupons_issued',
        'coupon_campaign_template', code, undefined,
        { matched: matched.length, issued: issued.issued.length, skipped: issued.skipped.length, reason: body.reason }, request.ip);
      return { runId, template: code, matched: matched.length, issued: issued.issued.length, skipped: issued.skipped, dryRun: body.dryRun };
    });
    return reply.code(body.dryRun ? 200 : 201).send(result);
  });

  /* ------------------------- automation safety state (137) ------------------------- */
  app.get('/api/v1/admin/promo/automations', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const rows = await pool.query(
      `SELECT a.id,a.code,a.name,a.automation_type,a.status,a.trigger_code,a.target_kind,a.target_ref,a.active,
              a.daily_run_cap,a.audience_cap,a.cooldown_hours,a.budget_cap_rial,a.budget_spent_rial,a.expires_at,
              a.dry_run_required,a.manual_approval_required,a.approved_at,a.runs_today,a.runs_today_date,
              a.last_run_at,a.last_dry_run_at,a.last_dry_run_match_count,a.coupon_template_code,a.last_error,
              (SELECT count(*)::int FROM crm_automation_runs r WHERE r.automation_id = a.id) AS run_count,
              (SELECT count(*)::int FROM crm_automation_runs r WHERE r.automation_id = a.id AND r.dry_run) AS dry_run_count
       FROM crm_automations a ORDER BY a.created_at DESC`);
    return { items: rows.rows.map((row) => ({ ...row, budget_cap_rial: row.budget_cap_rial === null ? null : asRial(row.budget_cap_rial), budget_spent_rial: asRial(row.budget_spent_rial) })) };
  });

  app.patch('/api/v1/admin/promo/automations/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(['draft', 'test', 'active', 'paused', 'archived']).optional(),
      triggerCode: z.string().trim().max(60).nullable().optional(),
      targetKind: z.enum(['label', 'segment', 'customer']).nullable().optional(),
      targetRef: z.string().trim().max(80).nullable().optional(),
      dailyRunCap: z.number().int().min(1).max(10000).nullable().optional(),
      audienceCap: z.number().int().min(1).max(1000000).nullable().optional(),
      cooldownHours: z.number().int().min(0).max(8760).optional(),
      budgetCapRial: z.string().regex(/^\d+$/).nullable().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      dryRunRequired: z.boolean().optional(),
      manualApprovalRequired: z.boolean().optional(),
      couponTemplateCode: z.string().trim().max(40).nullable().optional(),
      note: z.string().trim().max(400).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<AutomationRow>(client, 'SELECT * FROM crm_automations WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      // draft→test→active: approval is recorded with actor + timestamp, never implicit.
      const approving = body.status === 'active' && before.status !== 'active';
      if (body.status === 'active') {
        // Two active rules with the same trigger and target would double-send; the DB
        // enforces it, and here we explain it in business language.
        const trigger = body.triggerCode ?? before.trigger_code;
        const targetKind = body.targetKind ?? before.target_kind;
        const targetRef = body.targetRef ?? before.target_ref;
        if (trigger) {
          const clash = await one<{ code: string; name: string }>(client,
            `SELECT code,name FROM crm_automations WHERE id <> $1 AND status = 'active' AND trigger_code = $2
               AND COALESCE(target_kind,'') = COALESCE($3,'') AND COALESCE(target_ref,'') = COALESCE($4,'') LIMIT 1`,
            [id, trigger, targetKind ?? null, targetRef ?? null]);
          if (clash) throw conflict(`قاعده فعال «${clash.name}» (${clash.code}) همین تریگر و مخاطب را پوشش می‌دهد؛ ابتدا آن را متوقف کنید.`);
        }
      }
      await client.query(
        `UPDATE crm_automations SET status = COALESCE($2,status), active = CASE WHEN $2 IN ('active','test') THEN true WHEN $2 IN ('paused','archived','draft') THEN false ELSE active END,
           trigger_code = COALESCE($3,trigger_code), target_kind = COALESCE($4,target_kind), target_ref = COALESCE($5,target_ref),
           daily_run_cap = COALESCE($6,daily_run_cap), audience_cap = COALESCE($7,audience_cap),
           cooldown_hours = COALESCE($8,cooldown_hours), budget_cap_rial = COALESCE($9,budget_cap_rial),
           expires_at = COALESCE($10,expires_at), dry_run_required = COALESCE($11,dry_run_required),
           manual_approval_required = COALESCE($12,manual_approval_required),
           coupon_template_code = COALESCE($13,coupon_template_code),
           approved_by = CASE WHEN $14 THEN $15 ELSE approved_by END,
           approved_at = CASE WHEN $14 THEN now() ELSE approved_at END,
           last_error = NULL
         WHERE id = $1`,
        [id, body.status ?? null, body.triggerCode ?? null, body.targetKind ?? null, body.targetRef ?? null,
          body.dailyRunCap ?? null, body.audienceCap ?? null, body.cooldownHours ?? null, body.budgetCapRial ?? null,
          body.expiresAt ? new Date(body.expiresAt) : null, body.dryRunRequired ?? null, body.manualApprovalRequired ?? null,
          body.couponTemplateCode ?? null, approving, user.id]);
      await audit(client, user.id, approving ? 'promo.automation_approved' : 'promo.automation_updated',
        'crm_automation', id, { status: before.status }, { ...body, approver: approving ? user.id : undefined }, request.ip);
      return one(client, 'SELECT * FROM crm_automations WHERE id = $1', [id]);
    });
  });

  /** Dry run for a rule-based automation: caps + match count + sample. */
  app.post('/api/v1/admin/promo/automations/:id/dry-run', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ config: z.record(z.string(), z.unknown()).optional(), sampleSize: z.number().int().min(1).max(50).default(10) })
      .strict().parse(request.body);
    return transaction(pool, async (client) => {
      const automation = await one<AutomationRow>(client, 'SELECT * FROM crm_automations WHERE id = $1 FOR UPDATE', [id]);
      if (!automation) throw notFound();
      const matched = await matchAudience(client, {
        triggerCode: automation.trigger_code, config: { ...(automation.config ?? {}), ...(body.config ?? {}) },
        targetKind: automation.target_kind, targetRef: automation.target_ref,
      });
      const consented = await consentedRecipients(client, matched.map((row: { id: string }) => row.id) as string[]);
      const consentIds = new Set(consented.map((row) => row.id));
      const snapshot = await safetySnapshot(client, automation, matched.length);
      await client.query(
        `UPDATE crm_automations SET last_dry_run_at = now(), last_dry_run_match_count = $2 WHERE id = $1`,
        [id, matched.length]);
      await audit(client, user.id, 'promo.automation_dry_run', 'crm_automation', id, undefined,
        { matched: matched.length, capped: snapshot.capped, reasons: snapshot.reasons }, request.ip);
      const previewOwner = matched[0] ? { id: matched[0].id, display_name: matched[0].display_name } : null;
      const couponPreview = automation.coupon_template_code
        ? await previewTemplateCoupon(client, automation.coupon_template_code, previewOwner)
        : null;
      return {
        automationId: id, message: `این Rule روی ${matched.length} کاربر Match می‌شود.`,
        matchCount: matched.length, consentedCount: consented.length,
        willSend: snapshot.capped > 0 && snapshot.reasons.length === 0,
        couponPreview,
        safety: snapshot,
        sample: matched.slice(0, body.sampleSize).map((row) => ({
          userId: row.id, displayName: row.display_name,
          phoneMasked: row.phone ? `${row.phone.slice(0, 4)}***${row.phone.slice(-2)}` : null,
          consent: consentIds.has(row.id), reason: row.reason,
        })),
      };
    });
  });

  /** Execute an automation under every safety cap; refuses with explicit reasons.
   *  A refused run is still recorded (audit + run row + last_error) — refusals are
   *  part of the safety story, so they must survive the rollback of the refusal. */
  app.post('/api/v1/admin/promo/automations/:id/run', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      mode: z.enum(['test', 'live']).default('test'),
      force: z.boolean().default(false),
      note: z.string().trim().max(400).default(''),
    }).strict().parse(request.body);
    const outcome = await executeAutomation(pool, id, {
      mode: body.mode, force: body.force, note: body.note, actorId: user.id, ip: request.ip ?? null, source: 'manual',
    });
    if (outcome.kind === 'blocked') throw conflict(`اجرای این قاعده مجاز نیست: ${outcome.reasons.join(' ')}`);
    return reply.code(outcome.kind === 'test' ? 200 : 201).send({
      runId: outcome.runId, mode: outcome.kind, matched: outcome.matched,
      sent: outcome.kind === 'live' ? outcome.sent : 0,
      coupons: outcome.kind === 'live' ? outcome.coupons : 0,
      safety: outcome.safety,
    });
  });

  app.get('/api/v1/admin/promo/automations/:id/runs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:safety');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT r.*, u.display_name AS triggered_by_name FROM crm_automation_runs r
       LEFT JOIN users u ON u.id = r.triggered_by WHERE r.automation_id = $1 ORDER BY r.started_at DESC LIMIT 50`, [id]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/promo/personal-coupons', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const query = z.object({
      search: z.string().max(80).optional(), template: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT c.id,c.code,c.type,c.value,c.min_order_rial,c.ends_at,c.used_count,c.template_code,c.installment_policy,
              c.generation_meta,u.display_name AS owner_name,u.phone AS owner_phone,
              (SELECT count(*)::int FROM coupon_redemptions r WHERE r.coupon_id = c.id) AS redemptions
       FROM coupons c LEFT JOIN users u ON u.id = c.recipient_user_id
       WHERE c.recipient_user_id IS NOT NULL AND ($1::text IS NULL OR c.code ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR c.template_code = $2)
       ORDER BY c.created_at DESC LIMIT $3`, [query.search ?? null, query.template ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, value: row.value.toString(), min_order_rial: asRial(row.min_order_rial) })) };
  });

  /** Manual/administrative single issuance (still audited). */
  app.post('/api/v1/admin/promo/personal-coupons', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promo:templates');
    const body = z.object({
      userId: z.uuid(), templateCode: z.string().trim().max(40),
      percent: z.number().int().min(1).max(100).optional(),
      reason: z.string().trim().min(3).max(300),
      expiresInDays: z.number().int().min(1).max(365).optional(),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const buyer = await one<{ id: string; display_name: string; phone: string | null }>(client,
        'SELECT id,display_name,phone FROM users WHERE id = $1', [body.userId]);
      if (!buyer) throw notFound();
      if (body.percent !== undefined && body.templateCode !== 'manual_percent') {
        // Ad-hoc percentage coupons are allowed but must not silently bypass templates.
        await audit(client, user.id, 'promo.manual_coupon', 'user', body.userId, undefined,
          { percent: body.percent, reason: body.reason, mode: 'ad_hoc' }, request.ip);
        const coupon = await createCoupon(client, {
          type: 'percent', value: String(body.percent), usageLimitPerUser: 1, recipientUserId: body.userId,
          minOrderRial: '0', endsAt: new Date(Date.now() + (body.expiresInDays ?? 14) * 86_400_000),
          source: 'manual', campaignName: `کوپن دستی — ${body.reason}`, createdBy: user.id,
        });
        await client.query(
          `UPDATE coupons SET generation_meta = $2 WHERE id = $1`,
          [coupon.id, JSON.stringify({ mode: 'ad_hoc', reason: body.reason, issuedBy: user.id })]);
        return reply.code(201).send({ couponId: coupon.id, code: coupon.code });
      }
      const issued = await issueTemplateCoupons(client, {
        templateCode: body.templateCode, runId: randomUUID(),
        audience: [{ id: buyer.id, display_name: buyer.display_name, phone: buyer.phone }],
        issuedBy: user.id, dryRun: false,
      });
      if (!issued.issued.length) throw conflict(`کوپن صادر نشد: ${issued.skipped[0]?.reason ?? 'دلیل نامشخص'}`);
      await audit(client, user.id, 'promo.manual_coupon', 'user', body.userId, undefined,
        { template: body.templateCode, code: issued.issued[0]!.code, reason: body.reason }, request.ip);
      return reply.code(201).send({ couponId: issued.issued[0]!.couponId, code: issued.issued[0]!.code });
    });
    return result;
  });
}

/** Birthday run wired to templates (item 140): event → personal coupon → SMS. */
export async function runBirthdayAutomation(pool: DbPool, config: Config, actorId?: string | null) {
  return transaction(pool, async (client) => {
    const template = await one<{ code: string }>(client,
      `SELECT code FROM coupon_campaign_templates WHERE trigger_code = 'birthday' AND active ORDER BY created_at LIMIT 1`);
    if (!template) return { skipped: 'no_birthday_template' } as const;
    const automation = await one<AutomationRow>(client,
      `SELECT * FROM crm_automations WHERE trigger_code = 'birthday' ORDER BY created_at LIMIT 1`);
    const matched = await matchAudience(client, { triggerCode: 'birthday', config: {}, targetKind: null, targetRef: null });
    const snapshot = automation ? await safetySnapshot(client, automation, matched.length) : null;
    if (snapshot && !snapshot.allowed && !(actorId && snapshot.reasons.every((reason) => reason.includes('تأیید')))) {
      return { skipped: 'safety_caps', reasons: snapshot.reasons } as const;
    }
    const runId = randomUUID();
    const consented = await consentedRecipients(client, matched.map((row: { id: string }) => row.id) as string[]);
    const issued = await issueTemplateCoupons(client, { templateCode: template.code, runId, audience: consented, issuedBy: actorId ?? null, dryRun: false });
    void config;
    return { template: template.code, matched: matched.length, consented: consented.length, issued: issued.issued.length, skipped: issued.skipped } as const;
  });
}

/** Shared implementation behind the admin "run" button and the worker scheduler.
 *  `mode:'test'` never reaches a customer; `live` must clear every safety cap. */
export async function executeAutomation(pool: DbPool, id: string, options: {
  mode: 'test' | 'live'; force?: boolean; note?: string;
  actorId?: string | null; ip?: string | null; source?: 'manual' | 'scheduled';
}) {
  const actorId = options.actorId ?? null;
  const note = options.note ?? '';
  const source = options.source ?? 'manual';
  return transaction(pool, async (client) => {
    const automation = await one<AutomationRow>(client, 'SELECT * FROM crm_automations WHERE id = $1 FOR UPDATE', [id]);
    if (!automation) throw notFound();
    const matched = await matchAudience(client, {
      triggerCode: automation.trigger_code, config: automation.config ?? {},
      targetKind: automation.target_kind, targetRef: automation.target_ref,
    });
    const snapshot = await safetySnapshot(client, automation, matched.length);
    const runId = randomUUID();
    if (options.mode === 'test') {
      await client.query(
        `INSERT INTO crm_automation_runs(id,automation_id,status,processed_count,matched_count,sent_count,dry_run,triggered_by,trigger_type,note,finished_at)
         VALUES ($1,$2,'succeeded',0,$3,0,true,$4,'manual_test',$5,now())`,
        [runId, id, matched.length, actorId, note]);
      await audit(client, actorId, 'promo.automation_test_run', 'crm_automation', id, undefined,
        { matched: matched.length, safety: snapshot.reasons }, options.ip ?? undefined);
      return { kind: 'test' as const, runId, matched: matched.length, safety: snapshot };
    }
    if (!snapshot.allowed && !options.force) {
      const reason = snapshot.reasons.join(' | ');
      await client.query(
        `INSERT INTO crm_automation_runs(id,automation_id,status,processed_count,matched_count,skipped_count,dry_run,triggered_by,trigger_type,note,error,finished_at)
         VALUES ($1,$2,'failed',0,$3,$3,false,$4,$7,$5,$6,now())`,
        [runId, id, matched.length, actorId, note, reason, source === 'scheduled' ? 'scheduled' : 'manual']);
      await client.query('UPDATE crm_automations SET last_error = $2 WHERE id = $1', [id, reason]);
      await audit(client, actorId, 'promo.automation_run_blocked', 'crm_automation', id, undefined,
        { matched: matched.length, reasons: snapshot.reasons, source }, options.ip ?? undefined);
      return { kind: 'blocked' as const, runId, reasons: snapshot.reasons, safety: snapshot };
    }
    const target = snapshot.capped === matched.length ? matched : matched.slice(0, snapshot.capped);
    const consented = await consentedRecipients(client, target.map((row: { id: string }) => row.id) as string[]);
    let issuedCount = 0;
    if (automation.coupon_template_code) {
      const issued = await issueTemplateCoupons(client, {
        templateCode: automation.coupon_template_code, runId, audience: consented, issuedBy: actorId, dryRun: false,
      });
      issuedCount = issued.issued.length;
    }
    const message = String((automation.config as { message?: string })?.message
      ?? 'کلبه وینتیج: پیشنهاد ویژه برای شما فعال شد.');
    for (const recipient of consented) {
      if (!recipient.phone) continue;
      const event = await emitEvent(client, { eventType: 'crm.automation_message', entityType: 'crm_automation',
        entityId: id, payload: { automationId: id, userId: recipient.id, runId }, actorId });
      await client.query('INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), event.eventId, recipient.id, recipient.phone, message]);
      await recordTimeline(client, { userId: recipient.id, eventType: 'crm.automation', source: 'crm',
        title: automation.name, refType: 'crm_automation', refId: id, actorId });
    }
    const today = (await one<{ today: string }>(client,
      `SELECT to_char(now() AT TIME ZONE 'Asia/Tehran','YYYY-MM-DD') AS today`))!.today;
    const runsToday = automation.runs_today_date === today ? automation.runs_today + 1 : 1;
    const costPerMessage = (automation.config as { estimatedCostRialPerMessage?: string })?.estimatedCostRialPerMessage;
    const budgetSpent = costPerMessage ? BigInt(costPerMessage) * BigInt(consented.length) : 0n;
    await client.query(
      `UPDATE crm_automations SET last_run_at = now(), runs_today = $2, runs_today_date = $3::date,
         budget_spent_rial = budget_spent_rial + $4, last_error = NULL WHERE id = $1`,
      [id, runsToday, today, budgetSpent.toString()]);
    await client.query(
      `INSERT INTO crm_automation_runs(id,automation_id,status,processed_count,matched_count,sent_count,skipped_count,budget_spent_rial,triggered_by,trigger_type,note,finished_at)
       VALUES ($1,$2,'succeeded',$3,$4,$3,$5,$6,$7,$9,$8,now())`,
      [runId, id, consented.length, matched.length, matched.length - target.length, budgetSpent.toString(),
        actorId, note, source === 'scheduled' ? 'scheduled' : 'manual']);
    await audit(client, actorId, 'promo.automation_run', 'crm_automation', id, undefined,
      { matched: matched.length, sent: consented.length, coupons: issuedCount, source }, options.ip ?? undefined);
    return { kind: 'live' as const, runId, matched: matched.length, sent: consented.length, coupons: issuedCount, safety: snapshot };
  });
}

/** Scheduler (worker): automations that are active, approved and past their cooldown run
 *  themselves — the trigger → audience → action chain is complete without an operator. */
export async function dispatchDueAutomations(pool: DbPool, options: { limit?: number } = {}) {
  const due = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT id,code,name FROM crm_automations
     WHERE status = 'active' AND active
       AND trigger_code IS NOT NULL
       AND (expires_at IS NULL OR expires_at > now())
       AND (NOT manual_approval_required OR approved_at IS NOT NULL)
       AND (NOT dry_run_required OR last_dry_run_at IS NOT NULL)
       AND (daily_run_cap IS NULL OR runs_today_date IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Tehran')::date OR runs_today < daily_run_cap)
       AND (last_run_at IS NULL OR cooldown_hours = 0 OR last_run_at < now() - (cooldown_hours || ' hours')::interval)
       AND (audience_cap IS NULL OR last_dry_run_match_count IS NULL OR last_dry_run_match_count <= audience_cap)
     ORDER BY last_run_at NULLS FIRST LIMIT $1`, [options.limit ?? 10]);
  const results: { id: string; code: string; outcome: string }[] = [];
  for (const automation of due.rows) {
    try {
      const outcome = await executeAutomation(pool, automation.id, { mode: 'live', actorId: null, source: 'scheduled' });
      results.push({ id: automation.id, code: automation.code, outcome: outcome.kind === 'live' ? `sent:${outcome.sent}` : outcome.kind });
    } catch (error) {
      results.push({ id: automation.id, code: automation.code, outcome: 'error' });
      console.error('Scheduled automation failed', automation.code, error);
    }
  }
  return { due: due.rows.length, results };
}
