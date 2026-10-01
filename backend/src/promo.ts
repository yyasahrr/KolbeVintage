import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit } from './operations.js';
import { badRequest, notFound } from './errors.js';
import { createCoupon } from './coupons.js';
import { registerPromotionRoutes } from './promotions.js';

/* Coupon and festival management (item 17). */

const audience = z.array(z.enum(['customer', 'vip', 'wholesale', 'all'])).max(10).default([]);
const scope = z.object({
  productIds: z.array(z.uuid()).max(500).default([]),
  categories: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
}).strict().default({ productIds: [], categories: [] });

const couponBody = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{4,40}$/).optional(),
  campaignName: z.string().trim().max(120).optional(),
  festivalId: z.uuid().optional(),
  type: z.enum(['percent', 'fixed']),
  value: z.string().regex(/^\d+$/),
  maxDiscountRial: z.string().regex(/^\d+$/).nullable().optional(),
  minOrderRial: z.string().regex(/^\d+$/).default('0'),
  usageLimitTotal: z.number().int().min(1).max(1000000).nullable().optional(),
  usageLimitPerUser: z.number().int().min(1).max(1000).nullable().optional(),
  recipientUserId: z.uuid().nullable().optional(),
  audience: audience.optional(),
  scope: scope.optional(),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime(),
  dailyStartTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  dailyEndTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
}).strict();

const festivalBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{3,40}$/),
  name: z.string().trim().min(2).max(120),
  occasion: z.string().trim().max(120).optional(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  dailyStartTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  dailyEndTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  audience: audience.optional(),
  scope: scope.optional(),
  minOrderRial: z.string().regex(/^\d+$/).default('0'),
  maxDiscountRial: z.string().regex(/^\d+$/).nullable().optional(),
  discountPercent: z.number().min(0.1).max(100).nullable().optional(),
  discountFixedRial: z.string().regex(/^\d+$/).nullable().optional(),
  usageLimitTotal: z.number().int().min(1).max(10000000).nullable().optional(),
  usageLimitPerUser: z.number().int().min(1).max(1000).nullable().optional(),
  autoApply: z.boolean().default(false),
  themePaletteCode: z.string().trim().max(60).nullable().optional(),
  active: z.boolean().default(true),
}).strict().refine((value) => value.discountPercent !== null || value.discountFixedRial !== undefined,
  'درصد یا مبلغ ثابت تخفیف لازم است.').refine((value) => value.discountPercent === null || value.discountFixedRial == null,
  'فقط یکی از درصد یا مبلغ ثابت مجاز است.');

export function registerPromoRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/coupons', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const query = z.object({ festivalId: z.uuid().optional(), active: z.enum(['true', 'false']).optional(),
      search: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,code,campaign_name,festival_id,type,value,max_discount_rial,min_order_rial,usage_limit_total,
              usage_limit_per_user,used_count,recipient_user_id,audience,scope,starts_at,ends_at,active,source,created_at
       FROM coupons WHERE ($1::uuid IS NULL OR festival_id = $1)
         AND ($2::text IS NULL OR active = ($2 = 'true'))
         AND ($3::text IS NULL OR code ILIKE '%' || $3 || '%')
       ORDER BY created_at DESC LIMIT $4`, [query.festivalId ?? null, query.active ?? null, query.search ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, value: asRial(row.value) })) };
  });

  app.post('/api/v1/admin/coupons', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const body = couponBody.parse(request.body);
    if (body.type === 'percent' && Number(body.value) > 100) throw badRequest('درصد تخفیف باید حداکثر ۱۰۰ باشد.');
    rial(body.value);
    if (body.maxDiscountRial) rial(body.maxDiscountRial);
    const result = await transaction(pool, async (client) => {
      const created = await createCoupon(client, {
        code: body.code, festivalId: body.festivalId ?? null, campaignName: body.campaignName ?? null,
        type: body.type, value: body.value, maxDiscountRial: body.maxDiscountRial ?? null,
        minOrderRial: body.minOrderRial, usageLimitTotal: body.usageLimitTotal ?? null,
        usageLimitPerUser: body.usageLimitPerUser ?? null, recipientUserId: body.recipientUserId ?? null,
        audience: body.audience, scope: body.scope, startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: new Date(body.endsAt), dailyStartTime: body.dailyStartTime ?? null, dailyEndTime: body.dailyEndTime ?? null,
        createdBy: user.id,
      });
      await audit(client, user.id, 'coupon.created', 'coupon', created.id, undefined, { code: created.code }, request.ip);
      return created;
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/admin/coupons/:id/deactivate', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one<{ active: boolean }>(client, 'SELECT active FROM coupons WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('UPDATE coupons SET active = false WHERE id = $1', [id]);
      await audit(client, user.id, 'coupon.deactivated', 'coupon', id, { active: before.active }, { active: false }, request.ip);
      return { id, active: false };
    });
  });

  app.get('/api/v1/admin/festivals', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const rows = await pool.query('SELECT * FROM festivals ORDER BY starts_at DESC LIMIT 100');
    return { items: rows.rows.map((row) => ({ ...row, min_order_rial: asRial(row.min_order_rial) })) };
  });

  app.post('/api/v1/admin/festivals', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const body = festivalBody.parse(request.body);
    if (body.discountFixedRial) rial(body.discountFixedRial);
    if (body.maxDiscountRial) rial(body.maxDiscountRial);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO festivals(id,code,name,occasion,starts_at,ends_at,daily_start_time,daily_end_time,audience,scope,
           min_order_rial,max_discount_rial,discount_percent,discount_fixed_rial,usage_limit_total,usage_limit_per_user,
           auto_apply,theme_palette_code,active,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [id, body.code, body.name, body.occasion ?? null, body.startsAt, body.endsAt,
          body.dailyStartTime ?? null, body.dailyEndTime ?? null, body.audience ?? [], JSON.stringify(body.scope ?? {}),
          body.minOrderRial, body.maxDiscountRial ?? null, body.discountPercent ?? null, body.discountFixedRial ?? null,
          body.usageLimitTotal ?? null, body.usageLimitPerUser ?? null, body.autoApply, body.themePaletteCode ?? null,
          body.active, user.id]);
      await audit(client, user.id, 'festival.created', 'festival', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/festivals/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'promos:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = festivalBody.partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM festivals WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE festivals SET name = COALESCE($2, name), starts_at = COALESCE($3, starts_at), ends_at = COALESCE($4, ends_at),
           audience = COALESCE($5, audience), scope = COALESCE($6, scope), min_order_rial = COALESCE($7, min_order_rial),
           max_discount_rial = COALESCE($8, max_discount_rial), discount_percent = COALESCE($9, discount_percent),
           discount_fixed_rial = COALESCE($10, discount_fixed_rial), usage_limit_total = COALESCE($11, usage_limit_total),
           usage_limit_per_user = COALESCE($12, usage_limit_per_user), auto_apply = COALESCE($13, auto_apply),
           theme_palette_code = COALESCE($14, theme_palette_code), active = COALESCE($15, active),
           daily_start_time = COALESCE($16, daily_start_time), daily_end_time = COALESCE($17, daily_end_time),
           updated_at = now()
         WHERE id = $1`,
        [id, body.name ?? null, body.startsAt ?? null, body.endsAt ?? null,
          body.audience ?? null, body.scope ? JSON.stringify(body.scope) : null, body.minOrderRial ?? null,
          body.maxDiscountRial ?? null, body.discountPercent ?? null, body.discountFixedRial ?? null,
          body.usageLimitTotal ?? null, body.usageLimitPerUser ?? null, body.autoApply ?? null,
          body.themePaletteCode ?? null, body.active ?? null, body.dailyStartTime ?? null, body.dailyEndTime ?? null]);
      await audit(client, user.id, 'festival.updated', 'festival', id, before, body, request.ip);
      return { id, ...body };
    });
  });

  /** Buyers can validate a code before checkout. */
  app.post('/api/v1/coupons/validate', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ code: z.string().trim().min(4).max(40), orderType: z.enum(['retail', 'wholesale']).default('retail'),
      items: z.array(z.object({ productId: z.uuid(), category: z.string().max(120), totalRial: z.string().regex(/^\d+$/) })).min(1).max(100) })
      .parse(request.body);
    const { resolveCouponDiscount } = await import('./coupons.js');
    const result = await transaction(pool, (client) => resolveCouponDiscount(client, {
      userId: user.id, orderType: body.orderType, isVip: user.roles.includes('vip'),
      lines: body.items.map((item) => ({ productId: item.productId, category: item.category, total: rial(item.totalRial) })),
    }, body.code));
    return {
      valid: result.source === 'coupon',
      discountRial: asRial(result.discountRial),
      message: result.note ?? (result.source === 'coupon' ? 'کد تخفیف اعمال شد.' : undefined),
    };
  });

  registerPromotionRoutes(app, pool, config);
}
