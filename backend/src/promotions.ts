import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { addRial, asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, requestHash } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

export type TargetType = 'variant' | 'color' | 'size' | 'product' | 'category';
export type DiscountType = 'percent' | 'fixed_rial';

export type ResolvedVariantPrice = {
  variantId: string;
  productId: string;
  sku: string;
  size: string | null;
  color: string | null;
  basePrice: string;
  matchedRule: {
    id: string;
    promotionId: string | null;
    name: string | null;
    targetType: TargetType;
    productId: string | null;
    colorId: string | null;
    sizeCode: string | null;
    variantId: string | null;
    priority: number;
  } | null;
  discountType: DiscountType | null;
  discountValue: string | null;
  discountAmount: string;
  finalPrice: string;
  startsAt: string | null;
  endsAt: string | null;
  source: 'promotion_rule' | 'festival' | 'none';
};

const COLOR_ALIASES: Record<string, string> = {
  black: 'black',
  'مشکی': 'black',
  white: 'white',
  'سفید': 'white',
  orange: 'orange',
  'نارنجی': 'orange',
  'نارنجی آجری': 'orange',
  'آجری': 'orange',
  cream: 'cream',
  'کرمی': 'cream',
  olive: 'olive',
  'زیتونی': 'olive',
  sand: 'sand',
  'شنی': 'sand',
  navy: 'navy',
  'سرمه‌ای': 'navy',
  burgundy: 'burgundy',
  'زرشکی': 'burgundy',
  brown: 'brown',
  'قهوه‌ای': 'brown',
  gray: 'gray',
  grey: 'gray',
  'طوسی': 'gray',
  'خاکستری': 'gray',
};

export function normalizeColorKey(value: string | null | undefined): string {
  if (!value) return '';
  const cleaned = value.trim().toLowerCase();
  return COLOR_ALIASES[cleaned] ?? cleaned;
}

export function normalizeSizeKey(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().toUpperCase();
}

function specificityRank(targetType: TargetType): number {
  switch (targetType) {
    case 'variant': return 40;
    case 'color': return 30;
    case 'size': return 20;
    case 'product': return 10;
    case 'category': return 5;
  }
}

type VariantPricingContextRow = {
  variant_id: string;
  sku: string;
  size_label: string | null;
  color_label: string | null;
  attributes: Record<string, unknown> | null;
  active: boolean;
  product_id: string;
  product_name: string;
  category: string;
  status: string;
  cash_price_rial: string;
  installment_price_rial: string | null;
  wholesale_price_rial: string | null;
  /** Req 25 (Agent 2): variant-level retail price override — replaces the cash base price before promotions apply. */
  price_override_rial: string | null;
};

type CandidateRuleRow = {
  id: string;
  promotion_id: string | null;
  name: string | null;
  channel: 'retail' | 'wholesale' | 'all';
  target_type: TargetType;
  product_id: string | null;
  color_id: string | null;
  size_code: string | null;
  variant_id: string | null;
  category: string | null;
  discount_type: DiscountType;
  discount_value: string;
  starts_at: Date | null;
  ends_at: Date | null;
  priority: number;
  created_at: Date;
  promo_kind: 'standard' | 'festival' | 'campaign' | null;
  promo_exclusive_policy: 'stackable_by_priority' | 'festival_exclusive' | 'override_all' | null;
  promo_starts_at: Date | null;
  promo_ends_at: Date | null;
  promo_priority: number | null;
};

export function computeDiscountAmount(basePrice: bigint, discountType: DiscountType, discountValue: bigint): bigint {
  if (basePrice <= 0n || discountValue <= 0n) return 0n;
  if (discountType === 'percent') {
    const clamped = discountValue > 95n ? 95n : discountValue;
    return (basePrice * clamped) / 100n;
  }
  return discountValue > basePrice ? basePrice : discountValue;
}

export async function resolveVariantPrice(
  db: DbClient,
  variantId: string,
  options: {
    orderType?: 'retail' | 'wholesale';
    paymentMode?: 'cash' | 'four_installments';
    now?: Date;
  } = {},
): Promise<ResolvedVariantPrice> {
  const orderType = options.orderType ?? 'retail';
  const paymentMode = options.paymentMode ?? 'cash';
  const now = options.now ?? new Date();

  const variant = await one<VariantPricingContextRow>(
    db,
    `SELECT v.id AS variant_id, v.sku, v.size_label, v.color_label, v.attributes, v.active,
            v.price_override_rial::text AS price_override_rial,
            p.id AS product_id, p.name AS product_name, p.category, p.status,
            p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.id = $1`,
    [variantId],
  );
  if (!variant || !variant.active) throw notFound();

  // Req 25 (Agent 2): a variant-level price override replaces the product cash
  // price as the retail base; promotions then discount the overridden base.
  // The deliberate installment price stays authoritative for 4-installment mode;
  // the override only replaces the cash price (and its installment fallback).
  const rawBasePrice =
    orderType === 'wholesale'
      ? variant.wholesale_price_rial
      : paymentMode === 'four_installments'
        ? (variant.installment_price_rial ?? variant.price_override_rial ?? variant.cash_price_rial)
        : (variant.price_override_rial ?? variant.cash_price_rial);

  if (rawBasePrice === null) {
    throw badRequest(`قیمت فروش برای SKU ${variant.sku} تعریف نشده است.`);
  }
  const basePrice = rial(rawBasePrice);

  const rulesResult = await db.query<CandidateRuleRow>(
    `SELECT r.id, r.promotion_id, r.name, r.channel, r.target_type, r.product_id,
            r.color_id, r.size_code, r.variant_id, r.category,
            r.discount_type, r.discount_value::text AS discount_value,
            r.starts_at, r.ends_at, r.priority, r.created_at,
            pr.kind AS promo_kind, pr.exclusive_policy AS promo_exclusive_policy,
            pr.starts_at AS promo_starts_at, pr.ends_at AS promo_ends_at,
            pr.priority AS promo_priority
     FROM promotion_rules r
     LEFT JOIN promotions pr ON pr.id = r.promotion_id
     WHERE r.active = true
       AND r.channel IN ('all', $1)
       AND (r.starts_at IS NULL OR r.starts_at <= $2)
       AND (r.ends_at IS NULL OR r.ends_at > $2)
       -- A5/A6: rules suspended by a festival stay dormant only while that festival is
       -- really active; when it ends, still-valid rules are restored automatically.
       AND (r.suspended_by_promotion_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM promotions sp
         WHERE sp.id = r.suspended_by_promotion_id
           AND sp.active = true
           AND (sp.starts_at IS NULL OR sp.starts_at <= $2)
           AND (sp.ends_at IS NULL OR sp.ends_at > $2)
       ))
       AND (r.promotion_id IS NULL OR (
         pr.active = true
         AND pr.channel IN ('all', $1)
         AND (pr.starts_at IS NULL OR pr.starts_at <= $2)
         AND (pr.ends_at IS NULL OR pr.ends_at > $2)
       ))
       AND (
         (r.target_type = 'variant' AND r.variant_id = $3)
         OR (r.target_type IN ('color', 'size', 'product') AND r.product_id = $4)
         OR (r.target_type = 'category' AND r.category = $5)
       )`,
    [orderType, now, variant.variant_id, variant.product_id, variant.category],
  );

  const variantColorKeys = new Set<string>();
  if (variant.color_label) {
    variantColorKeys.add(variant.color_label.trim().toLowerCase());
    variantColorKeys.add(normalizeColorKey(variant.color_label));
  }
  const attrColorId = typeof variant.attributes?.colorId === 'string'
    ? variant.attributes.colorId
    : typeof variant.attributes?.color_id === 'string'
      ? variant.attributes.color_id
      : typeof variant.attributes?.color === 'string'
        ? variant.attributes.color
        : null;
  if (attrColorId) {
    variantColorKeys.add(attrColorId.trim().toLowerCase());
    variantColorKeys.add(normalizeColorKey(attrColorId));
  }

  const variantSizeKeys = new Set<string>();
  if (variant.size_label) {
    variantSizeKeys.add(normalizeSizeKey(variant.size_label));
  }
  const attrSize = typeof variant.attributes?.size === 'string'
    ? variant.attributes.size
    : typeof variant.attributes?.sizeCode === 'string'
      ? variant.attributes.sizeCode
      : null;
  if (attrSize) {
    variantSizeKeys.add(normalizeSizeKey(attrSize));
  }

  const matching = rulesResult.rows.filter((rule) => {
    switch (rule.target_type) {
      case 'variant':
        return rule.variant_id === variant.variant_id && (!rule.product_id || rule.product_id === variant.product_id);
      case 'color': {
        if (rule.product_id !== variant.product_id || !rule.color_id) return false;
        const ruleColorRaw = rule.color_id.trim().toLowerCase();
        const ruleColorNorm = normalizeColorKey(rule.color_id);
        return variantColorKeys.has(ruleColorRaw) || (ruleColorNorm !== '' && variantColorKeys.has(ruleColorNorm));
      }
      case 'size': {
        if (rule.product_id !== variant.product_id || !rule.size_code) return false;
        const ruleSizeNorm = normalizeSizeKey(rule.size_code);
        return ruleSizeNorm !== '' && variantSizeKeys.has(ruleSizeNorm);
      }
      case 'product':
        return rule.product_id === variant.product_id;
      case 'category':
        return rule.category === variant.category;
    }
  });

  if (matching.length === 0) {
    return {
      variantId: variant.variant_id,
      productId: variant.product_id,
      sku: variant.sku,
      size: variant.size_label,
      color: variant.color_label,
      basePrice: asRial(basePrice),
      matchedRule: null,
      discountType: null,
      discountValue: null,
      discountAmount: '0',
      finalPrice: asRial(basePrice),
      startsAt: null,
      endsAt: null,
      source: 'none',
    };
  }

  // Check if any active festival has exclusive override policy
  const hasExclusiveFestival = matching.some(
    (r) => r.promo_exclusive_policy === 'override_all' || r.promo_exclusive_policy === 'festival_exclusive',
  );
  const poolOfRules = hasExclusiveFestival
    ? matching.filter((r) => r.promo_exclusive_policy === 'override_all' || r.promo_exclusive_policy === 'festival_exclusive')
    : matching;

  poolOfRules.sort((a, b) => {
    const prioA = a.priority + (a.promo_priority ?? 0);
    const prioB = b.priority + (b.promo_priority ?? 0);
    if (prioB !== prioA) return prioB - prioA;
    const specDiff = specificityRank(b.target_type) - specificityRank(a.target_type);
    if (specDiff !== 0) return specDiff;
    const amtA = computeDiscountAmount(basePrice, a.discount_type, rial(a.discount_value));
    const amtB = computeDiscountAmount(basePrice, b.discount_type, rial(b.discount_value));
    if (amtB !== amtA) return amtB > amtA ? 1 : -1;
    return b.created_at.getTime() - a.created_at.getTime();
  });

  const winner = poolOfRules[0]!;
  const discountValueBig = rial(winner.discount_value);
  const discountAmountBig = computeDiscountAmount(basePrice, winner.discount_type, discountValueBig);
  const finalPriceBig = basePrice - discountAmountBig;
  const effectiveStartsAt = winner.starts_at ?? winner.promo_starts_at ?? null;
  const effectiveEndsAt = winner.ends_at ?? winner.promo_ends_at ?? null;

  return {
    variantId: variant.variant_id,
    productId: variant.product_id,
    sku: variant.sku,
    size: variant.size_label,
    color: variant.color_label,
    basePrice: asRial(basePrice),
    matchedRule: {
      id: winner.id,
      promotionId: winner.promotion_id,
      name: winner.name,
      targetType: winner.target_type,
      productId: winner.product_id,
      colorId: winner.color_id,
      sizeCode: winner.size_code,
      variantId: winner.variant_id,
      priority: winner.priority + (winner.promo_priority ?? 0),
    },
    discountType: winner.discount_type,
    discountValue: asRial(discountValueBig),
    discountAmount: asRial(discountAmountBig),
    finalPrice: asRial(finalPriceBig),
    startsAt: effectiveStartsAt ? effectiveStartsAt.toISOString() : null,
    endsAt: effectiveEndsAt ? effectiveEndsAt.toISOString() : null,
    source: winner.promo_kind === 'festival' ? 'festival' : 'promotion_rule',
  };
}

const createPromotionSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9_-]{3,40}$/).optional(),
  name: z.string().trim().min(2).max(160),
  description: z.string().max(2000).default(''),
  kind: z.enum(['standard', 'festival', 'campaign']).default('standard'),
  channel: z.enum(['retail', 'wholesale', 'all']).default('retail'),
  exclusivePolicy: z.enum(['stackable_by_priority', 'festival_exclusive', 'override_all']).default('stackable_by_priority'),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  active: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
});

const createPromotionRuleSchema = z.object({
  promotionId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(160).optional(),
  channel: z.enum(['retail', 'wholesale', 'all']).default('retail'),
  targetType: z.enum(['product', 'color', 'size', 'variant', 'category']),
  productId: z.uuid().nullable().optional(),
  colorId: z.string().trim().min(1).max(100).nullable().optional(),
  sizeCode: z.string().trim().min(1).max(50).nullable().optional(),
  variantId: z.uuid().nullable().optional(),
  category: z.string().trim().min(1).max(120).nullable().optional(),
  discountType: z.enum(['percent', 'fixed_rial']),
  discountValue: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  active: z.boolean().default(true),
  priority: z.number().int().min(-1000).max(1000).default(0),
  // A6: moving a product from festival A to festival B needs explicit confirmation.
  moveFromFestival: z.boolean().optional(),
});

const updatePromotionRuleSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  active: z.boolean().optional(),
  priority: z.number().int().min(-1000).max(1000).optional(),
  discountValue: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
});

export function registerPromotionRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/promotions', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:read') && !user.permissions.includes('products:write')) {
      requirePermission(user, 'promotions:read');
    }
    const promotions = await pool.query(
      `SELECT id, code, name, description, kind, channel, exclusive_policy, starts_at, ends_at, active, priority, created_at
       FROM promotions ORDER BY priority DESC, created_at DESC LIMIT 100`,
    );
    const rules = await pool.query(
      `SELECT r.id, r.promotion_id, r.name, r.channel, r.target_type, r.product_id, p.name AS product_name,
              r.color_id, r.size_code, r.variant_id, v.sku AS variant_sku, r.category,
              r.discount_type, r.discount_value::text AS discount_value,
              r.starts_at, r.ends_at, r.active, r.priority, r.created_at
       FROM promotion_rules r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN product_variants v ON v.id = r.variant_id
       ORDER BY r.priority DESC, r.created_at DESC LIMIT 200`,
    );
    return { promotions: promotions.rows, rules: rules.rows };
  });

  // List rules (used by the product-row Discount Manager). Includes the effective
  // suspension state so the UI can grey suspended rules out with an explanation.
  app.get('/api/v1/promotions/rules', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:read') && !user.permissions.includes('products:write')) {
      requirePermission(user, 'promotions:read');
    }
    const query = z.object({
      productId: z.uuid().optional(),
      active: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT r.id, r.promotion_id, r.name, r.channel, r.target_type, r.product_id, p.name AS product_name,
              r.color_id, r.size_code, r.variant_id, v.sku AS variant_sku, r.category,
              r.discount_type, r.discount_value::text AS discount_value,
              r.starts_at, r.ends_at, r.active, r.priority, r.created_at,
              r.suspended_by_promotion_id, sp.name AS suspended_by_name,
              (r.suspended_by_promotion_id IS NOT NULL AND sp.active = true
                AND (sp.starts_at IS NULL OR sp.starts_at <= now())
                AND (sp.ends_at IS NULL OR sp.ends_at > now())) AS effectively_suspended,
              pr.kind AS promotion_kind, pr.name AS promotion_name
       FROM promotion_rules r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN product_variants v ON v.id = r.variant_id
       LEFT JOIN promotions pr ON pr.id = r.promotion_id
       LEFT JOIN promotions sp ON sp.id = r.suspended_by_promotion_id
       WHERE ($1::uuid IS NULL OR r.product_id = $1)
         AND ($2::boolean IS NULL OR r.active = $2)
       ORDER BY r.priority DESC, r.created_at DESC LIMIT $3`,
      [query.productId ?? null, query.active ?? null, query.limit],
    );
    return { items: rows.rows };
  });

  // Per-product promotion snapshot for the «تخفیف و جشنواره» column (A1/A4/A5).
  app.get('/api/v1/promotions/product-summary', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:read') && !user.permissions.includes('products:write')) {
      requirePermission(user, 'promotions:read');
    }
    const query = z.object({ productId: z.uuid() }).parse(request.query);
    const festival = await one<{ promotion_id: string; name: string; ends_at: Date | null }>(pool,
      `SELECT r.promotion_id, pr.name, pr.ends_at
       FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
       WHERE r.product_id = $1 AND r.active = true
         AND pr.kind = 'festival' AND pr.active = true
         AND (pr.starts_at IS NULL OR pr.starts_at <= now())
         AND (pr.ends_at IS NULL OR pr.ends_at > now())
       LIMIT 1`,
      [query.productId]);
    const counts = await one<{ active_standalone: string; suspended_standalone: string }>(pool,
      `SELECT
         count(*) FILTER (WHERE r.promotion_id IS NULL AND r.active = true
           AND (r.suspended_by_promotion_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM promotions sp WHERE sp.id = r.suspended_by_promotion_id AND sp.active = true
               AND (sp.starts_at IS NULL OR sp.starts_at <= now()) AND (sp.ends_at IS NULL OR sp.ends_at > now()))))::text AS active_standalone,
         count(*) FILTER (WHERE r.promotion_id IS NULL AND r.active = true
           AND r.suspended_by_promotion_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM promotions sp WHERE sp.id = r.suspended_by_promotion_id AND sp.active = true
               AND (sp.starts_at IS NULL OR sp.starts_at <= now()) AND (sp.ends_at IS NULL OR sp.ends_at > now())))::text AS suspended_standalone
       FROM promotion_rules r WHERE r.product_id = $1`,
      [query.productId]);
    return {
      productId: query.productId,
      activeFestival: festival ? { promotionId: festival.promotion_id, name: festival.name, endsAt: festival.ends_at } : null,
      activeStandaloneRules: Number(counts?.active_standalone ?? '0'),
      suspendedStandaloneRules: Number(counts?.suspended_standalone ?? '0'),
    };
  });

  // Festival lifecycle control (A6 exit path): deactivating/ending a festival lifts the
  // suspension of still-valid standalone rules automatically (see resolver predicate).
  app.patch('/api/v1/promotions/:id', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      active: z.boolean().optional(),
      endsAt: z.iso.datetime().nullable().optional(),
      priority: z.number().int().min(-1000).max(1000).optional(),
    }).parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await one<{ id: string; active: boolean; kind: string; name: string }>(
        client, 'SELECT id, active, kind, name FROM promotions WHERE id = $1 FOR UPDATE', [id]);
      if (!existing) throw notFound();
      await client.query(
        `UPDATE promotions SET
           active = COALESCE($2, active),
           ends_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE ends_at END,
           priority = COALESCE($5, priority),
           updated_at = now()
         WHERE id = $1`,
        [id, body.active ?? null, body.endsAt !== undefined, body.endsAt ?? null, body.priority ?? null]);
      const out = { id, active: body.active ?? existing.active, kind: existing.kind };
      await audit(client, user.id, 'promotion.updated', 'promotion', id, { active: existing.active }, out, request.ip);
      return out;
    });
  });

  app.post('/api/v1/promotions', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const body = createPromotionSchema.parse(request.body);
    if (body.startsAt && body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw badRequest('تاریخ پایان باید بعد از تاریخ شروع باشد.');
    }
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO promotions(id, code, name, description, kind, channel, exclusive_policy, starts_at, ends_at, active, priority, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          body.code ?? null,
          body.name,
          body.description,
          body.kind,
          body.channel,
          body.exclusivePolicy,
          body.startsAt ?? null,
          body.endsAt ?? null,
          body.active,
          body.priority,
          user.id,
        ],
      );
      await audit(client, user.id, 'promotion.created', 'promotion', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.post('/api/v1/promotions/rules', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const body = createPromotionRuleSchema.parse(request.body);
    const discountValue = rial(body.discountValue);
    if (discountValue <= 0n) throw badRequest('مقدار تخفیف باید بزرگ‌تر از صفر باشد.');
    if (body.discountType === 'percent' && (discountValue < 1n || discountValue > 95n)) {
      throw badRequest('درصد تخفیف باید بین ۱ تا ۹۵ باشد.');
    }
    if (body.startsAt && body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw badRequest('تاریخ پایان قانون تخفیف باید بعد از تاریخ شروع باشد.');
    }

    // Validate target scope requirements
    if (body.targetType === 'variant' && !body.variantId) {
      throw badRequest('برای تخفیف سطح واریانت، شناسه واریانت (variantId) الزامی است.');
    }
    if (body.targetType === 'color' && (!body.productId || !body.colorId)) {
      throw badRequest('برای تخفیف سطح رنگ، شناسه محصول (productId) و رنگ (colorId) الزامی است.');
    }
    if (body.targetType === 'size' && (!body.productId || !body.sizeCode)) {
      throw badRequest('برای تخفیف سطح سایز، شناسه محصول (productId) و سایز (sizeCode) الزامی است.');
    }
    if (body.targetType === 'product' && !body.productId) {
      throw badRequest('برای تخفیف سطح محصول، شناسه محصول (productId) الزامی است.');
    }
    if (body.targetType === 'category' && !body.category) {
      throw badRequest('برای تخفیف سطح دسته‌بندی، نام دسته (category) الزامی است.');
    }

    const key = request.headers['idempotency-key'];
    const rule = await transaction(pool, async (client) => {
      if (typeof key === 'string' && key.length >= 8 && key.length <= 120) {
        const claim = await claimIdempotency(client, user.id, 'promotion_rule.create', key, requestHash(body));
        if (claim.previous) return claim.previous;
      }

      let resolvedProductId = body.productId ?? null;
      if (body.variantId) {
        const v = await one<{ id: string; product_id: string }>(
          client,
          'SELECT id, product_id FROM product_variants WHERE id = $1',
          [body.variantId],
        );
        if (!v) throw notFound();
        if (resolvedProductId && resolvedProductId !== v.product_id) {
          throw badRequest('واریانت انتخاب‌شده متعلق به این محصول نیست.');
        }
        resolvedProductId = v.product_id;
      } else if (resolvedProductId) {
        const p = await one<{ id: string }>(client, 'SELECT id FROM products WHERE id = $1', [resolvedProductId]);
        if (!p) throw notFound();
      }

      let promoKind: string | null = null;
      if (body.promotionId) {
        const promo = await one<{ id: string; kind: string }>(client, 'SELECT id, kind FROM promotions WHERE id = $1', [body.promotionId]);
        if (!promo) throw notFound();
        promoKind = promo.kind;
      }

      // A5/A6: Festival XOR standalone discount — server-side guarantee, per product.
      if (resolvedProductId) {
        const activeFestivalOfProduct = await one<{ promotion_id: string; promo_name: string }>(
          client,
          `SELECT r.promotion_id, pr.name AS promo_name
           FROM promotion_rules r
           JOIN promotions pr ON pr.id = r.promotion_id
           WHERE r.product_id = $1 AND r.active = true
             AND pr.kind = 'festival' AND pr.active = true
             AND (pr.starts_at IS NULL OR pr.starts_at <= now())
             AND (pr.ends_at IS NULL OR pr.ends_at > now())
             ${promoKind === 'festival' ? 'AND pr.id <> $2' : ''}
           LIMIT 1`,
          promoKind === 'festival' ? [resolvedProductId, body.promotionId] : [resolvedProductId],
        );

        if (promoKind === 'festival') {
          // Max one active festival per product; A→B transfer only with explicit confirmation.
          if (activeFestivalOfProduct) {
            if (body.moveFromFestival !== true) {
              throw conflict(
                `این محصول هم‌اکنون در جشنواره فعال «${activeFestivalOfProduct.promo_name}» است. برای انتقال به جشنواره جدید باید تأیید صریح (moveFromFestival) ارسال شود.`,
              );
            }
            await client.query(
              `UPDATE promotion_rules SET active = false, updated_at = now()
               WHERE product_id = $1 AND active = true AND promotion_id = $2`,
              [resolvedProductId, activeFestivalOfProduct.promotion_id],
            );
          }
          // Entering a festival SUSPENDS (not deletes) standalone rules of the product.
          await client.query(
            `UPDATE promotion_rules SET suspended_by_promotion_id = $2, updated_at = now()
             WHERE product_id = $1 AND promotion_id IS NULL AND active = true
               AND suspended_by_promotion_id IS NULL`,
            [resolvedProductId, body.promotionId],
          );
        } else if (activeFestivalOfProduct) {
          // Standalone discount while product is inside an active festival → blocked.
          throw conflict(
            `این محصول در جشنواره فعال «${activeFestivalOfProduct.promo_name}» است؛ تا پایان جشنواره امکان ثبت تخفیف مستقل وجود ندارد.`,
          );
        }
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO promotion_rules(
          id, promotion_id, name, channel, target_type, product_id, color_id, size_code, variant_id, category,
          discount_type, discount_value, starts_at, ends_at, active, priority, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          id,
          body.promotionId ?? null,
          body.name ?? null,
          body.channel,
          body.targetType,
          resolvedProductId,
          body.colorId ?? null,
          body.sizeCode ? normalizeSizeKey(body.sizeCode) : null,
          body.variantId ?? null,
          body.category ?? null,
          body.discountType,
          discountValue.toString(),
          body.startsAt ?? null,
          body.endsAt ?? null,
          body.active,
          body.priority,
          user.id,
        ],
      );
      const response = {
        id,
        promotionId: body.promotionId ?? null,
        name: body.name ?? null,
        channel: body.channel,
        targetType: body.targetType,
        productId: resolvedProductId,
        colorId: body.colorId ?? null,
        sizeCode: body.sizeCode ? normalizeSizeKey(body.sizeCode) : null,
        variantId: body.variantId ?? null,
        category: body.category ?? null,
        discountType: body.discountType,
        discountValue: discountValue.toString(),
        startsAt: body.startsAt ?? null,
        endsAt: body.endsAt ?? null,
        active: body.active,
        priority: body.priority,
      };
      await audit(client, user.id, 'promotion_rule.created', 'promotion_rule', id, undefined, response, request.ip);
      if (typeof key === 'string' && key.length >= 8 && key.length <= 120) {
        await completeIdempotency(client, user.id, 'promotion_rule.create', key, response);
      }
      return response;
    });
    return reply.code(201).send(rule);
  });

  app.patch('/api/v1/promotions/rules/:id', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = updatePromotionRuleSchema.parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await one<{
        id: string;
        discount_type: DiscountType;
        discount_value: string;
        active: boolean;
        priority: number;
        name: string | null;
        starts_at: Date | null;
        ends_at: Date | null;
      }>(client, 'SELECT id, discount_type, discount_value::text, active, priority, name, starts_at, ends_at FROM promotion_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!existing) throw notFound();
      const nextValue = body.discountValue !== undefined ? rial(body.discountValue) : rial(existing.discount_value);
      if (existing.discount_type === 'percent' && (nextValue < 1n || nextValue > 95n)) {
        throw badRequest('درصد تخفیف باید بین ۱ تا ۹۵ باشد.');
      }
      const nextActive = body.active ?? existing.active;
      const nextPriority = body.priority ?? existing.priority;
      const nextName = body.name !== undefined ? body.name : existing.name;
      const nextStarts = body.startsAt !== undefined ? body.startsAt : (existing.starts_at ? existing.starts_at.toISOString() : null);
      const nextEnds = body.endsAt !== undefined ? body.endsAt : (existing.ends_at ? existing.ends_at.toISOString() : null);
      if (nextStarts && nextEnds && new Date(nextEnds) <= new Date(nextStarts)) {
        throw badRequest('تاریخ پایان باید بعد از تاریخ شروع باشد.');
      }
      await client.query(
        `UPDATE promotion_rules
         SET name = $2, active = $3, priority = $4, discount_value = $5, starts_at = $6, ends_at = $7, updated_at = now()
         WHERE id = $1`,
        [id, nextName, nextActive, nextPriority, nextValue.toString(), nextStarts, nextEnds],
      );
      await audit(client, user.id, 'promotion_rule.updated', 'promotion_rule', id, existing, body, request.ip);
      return { id, active: nextActive, priority: nextPriority, discountValue: nextValue.toString(), name: nextName, startsAt: nextStarts, endsAt: nextEnds };
    });
  });

  app.delete('/api/v1/promotions/rules/:id', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await transaction(pool, async (client) => {
      const existing = await one<{ id: string }>(client, 'SELECT id FROM promotion_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!existing) throw notFound();
      await client.query('UPDATE promotion_rules SET active = false, updated_at = now() WHERE id = $1', [id]);
      await audit(client, user.id, 'promotion_rule.deactivated', 'promotion_rule', id, { active: true }, { active: false }, request.ip);
    });
    return reply.code(204).send();
  });

  // Public / Buyer / Storefront Server-Side Pricing Resolver Endpoints
  app.get('/api/v1/pricing/variants/:variantId', async (request) => {
    const { variantId } = z.object({ variantId: z.uuid() }).parse(request.params);
    const query = z.object({
      orderType: z.enum(['retail', 'wholesale']).default('retail'),
      paymentMode: z.enum(['cash', 'four_installments']).default('cash'),
    }).parse(request.query);
    if (query.orderType === 'wholesale') {
      const user = await principal(request, pool, config);
      const membership = await one<{ id: string }>(
        pool,
        `SELECT m.id FROM memberships m
         WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now() LIMIT 1`,
        [user.id],
      );
      if (!membership && !user.permissions.includes('orders:read')) throw conflict('مشاهده قیمت عمده نیازمند عضویت فعال است.');
    }
    return resolveVariantPrice(pool, variantId, {
      orderType: query.orderType,
      paymentMode: query.paymentMode,
    });
  });

  app.post('/api/v1/pricing/resolve', async (request) => {
    const body = z.object({
      orderType: z.enum(['retail', 'wholesale']).default('retail'),
      paymentMode: z.enum(['cash', 'four_installments']).default('cash'),
      items: z.array(z.object({
        variantId: z.uuid(),
        quantity: z.number().int().min(1).max(10000).default(1),
      })).min(1).max(100),
    }).parse(request.body);

    if (body.orderType === 'wholesale') {
      const user = await principal(request, pool, config);
      const membership = await one<{ id: string }>(
        pool,
        `SELECT m.id FROM memberships m
         WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now() LIMIT 1`,
        [user.id],
      );
      if (!membership && !user.permissions.includes('orders:read')) throw conflict('مشاهده قیمت عمده نیازمند عضویت فعال است.');
    }

    const lines = [];
    const baseTotals: bigint[] = [];
    const discountTotals: bigint[] = [];
    const finalTotals: bigint[] = [];

    for (const item of body.items) {
      const resolved = await resolveVariantPrice(pool, item.variantId, {
        orderType: body.orderType,
        paymentMode: body.paymentMode,
      });
      const qty = BigInt(item.quantity);
      const lineBase = rial(resolved.basePrice) * qty;
      const lineDiscount = rial(resolved.discountAmount) * qty;
      const lineFinal = rial(resolved.finalPrice) * qty;
      baseTotals.push(lineBase);
      discountTotals.push(lineDiscount);
      finalTotals.push(lineFinal);
      lines.push({
        ...resolved,
        quantity: item.quantity,
        lineBaseRial: asRial(lineBase),
        lineDiscountRial: asRial(lineDiscount),
        lineFinalRial: asRial(lineFinal),
      });
    }

    return {
      orderType: body.orderType,
      paymentMode: body.paymentMode,
      lines,
      subtotalRial: asRial(addRial(baseTotals)),
      discountRial: asRial(addRial(discountTotals)),
      totalRial: asRial(addRial(finalTotals)),
    };
  });
}
