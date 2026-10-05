import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { addRial, asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, requestHash } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { allocateSeriesPrice, loadSeriesComposition } from './series.js';

export type TargetType = 'variant' | 'color' | 'size' | 'product' | 'category';
export type DiscountType = 'percent' | 'fixed_rial';

export type PriceChannel = 'retail' | 'wholesale';
export type PaymentMode = 'cash' | 'four_installments';

/** THE canonical resolved price. Every surface (admin preview, storefront, cart, checkout, order
 *  snapshot) renders these numbers — nobody recomputes a final price in the browser or in SQL. */
export type ResolvedVariantPrice = {
  variantId: string;
  productId: string;
  sku: string;
  size: string | null;
  color: string | null;
  channel: PriceChannel;
  paymentMode: PaymentMode;
  /** Canonical base for the requested channel + payment mode. */
  basePrice: string;
  /** Retail cash base (variant override ?? product cash price) — context for every channel. */
  cashBasePriceRial: string;
  /** Explicit «قیمت پایه چهارقسطه» — null when the operator never defined one (never derived from cash). */
  installmentBasePriceRial: string | null;
  installmentEnabled: boolean;
  /** «اعمال تخفیف روی خرید چهارقسطه» — whether ordinary discounts may reduce the four-installment base. */
  installmentDiscountAllowed: boolean;
  /** The product's canonical «سیاست اعمال تخفیف روی خرید چهارقسطه» (raw policy value, for the UI). */
  installmentPolicy: string;
  /** True when a discount exists but the installment policy forbids discounting that purchase. */
  installmentDiscountBlocked: boolean;
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
  /** §9: crossed-out price derived from the canonical base of the resolved discount (never a manual value). */
  compareAtPriceRial: string | null;
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
  /** Req 25 (Agent 2): variant-level retail price override — replaces the retail cash base before promotions apply. */
  price_override_rial: string | null;
  installment_enabled: boolean;
  installment_policy: string;
  allow_installments: boolean;
  disable_installments_on_discount: boolean;
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

const VARIANT_PRICING_SELECT = `
  SELECT v.id AS variant_id, v.sku, v.size_label, v.color_label, v.attributes, v.active,
         v.price_override_rial::text AS price_override_rial,
         p.id AS product_id, p.name AS product_name, p.category, p.status,
         p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial,
         p.installment_enabled, p.installment_policy, p.allow_installments,
         p.disable_installments_on_discount
  FROM product_variants v
  JOIN products p ON p.id = v.product_id`;

const RULE_PRICING_SELECT = `
  SELECT r.id, r.promotion_id, r.name, r.channel, r.target_type, r.product_id,
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
    -- DEC-PRICING-001 (PO decision = Option A): rules suspended by a festival stay
    -- dormant even after the festival ends; the admin must reactivate them explicitly.
    AND r.suspended_by_promotion_id IS NULL
    AND (r.promotion_id IS NULL OR (
      pr.active = true
      AND pr.channel IN ('all', $1)
      AND (pr.starts_at IS NULL OR pr.starts_at <= $2)
      AND (pr.ends_at IS NULL OR pr.ends_at > $2)
    ))`;

/** Retail cash base — the variant override replaces the product cash price before promotions (Req 25). */
function retailCashBase(variant: VariantPricingContextRow, override: bigint | null): bigint | null {
  if (override !== null) return override;
  const cash = variant.price_override_rial ?? variant.cash_price_rial;
  return cash === null ? null : rial(cash);
}

/** Explicit four-installment base — never auto-derived from the cash price (§7/§8). */
function explicitInstallmentBase(variant: VariantPricingContextRow, override: bigint | null): bigint | null {
  if (override !== null) return override;
  return variant.installment_price_rial === null ? null : rial(variant.installment_price_rial);
}

function installmentAllowed(variant: VariantPricingContextRow): boolean {
  return variant.installment_enabled && variant.allow_installments && variant.installment_policy !== 'disabled';
}

type RuleMatchKeys = { colorKeys: Set<string>; sizeKeys: Set<string> };

function ruleMatchesVariant(rule: CandidateRuleRow, variant: VariantPricingContextRow, keys: RuleMatchKeys): boolean {
  switch (rule.target_type) {
    case 'variant':
      return rule.variant_id === variant.variant_id && (!rule.product_id || rule.product_id === variant.product_id);
    case 'color': {
      if (rule.product_id !== variant.product_id || !rule.color_id) return false;
      const ruleColorRaw = rule.color_id.trim().toLowerCase();
      const ruleColorNorm = normalizeColorKey(rule.color_id);
      return keys.colorKeys.has(ruleColorRaw) || (ruleColorNorm !== '' && keys.colorKeys.has(ruleColorNorm));
    }
    case 'size': {
      if (rule.product_id !== variant.product_id || !rule.size_code) return false;
      const ruleSizeNorm = normalizeSizeKey(rule.size_code);
      return ruleSizeNorm !== '' && keys.sizeKeys.has(ruleSizeNorm);
    }
    case 'product':
      return rule.product_id === variant.product_id;
    case 'category':
      return rule.category === variant.category;
  }
}

function matchKeysOf(variant: VariantPricingContextRow): RuleMatchKeys {
  const colorKeys = new Set<string>();
  if (variant.color_label) {
    colorKeys.add(variant.color_label.trim().toLowerCase());
    colorKeys.add(normalizeColorKey(variant.color_label));
  }
  const attrColorId = typeof variant.attributes?.colorId === 'string'
    ? variant.attributes.colorId
    : typeof variant.attributes?.color_id === 'string'
      ? variant.attributes.color_id
      : typeof variant.attributes?.color === 'string'
        ? variant.attributes.color
        : null;
  if (attrColorId) {
    colorKeys.add(attrColorId.trim().toLowerCase());
    colorKeys.add(normalizeColorKey(attrColorId));
  }

  const sizeKeys = new Set<string>();
  if (variant.size_label) sizeKeys.add(normalizeSizeKey(variant.size_label));
  const attrSize = typeof variant.attributes?.size === 'string'
    ? variant.attributes.size
    : typeof variant.attributes?.sizeCode === 'string'
      ? variant.attributes.sizeCode
      : null;
  if (attrSize) sizeKeys.add(normalizeSizeKey(attrSize));

  return { colorKeys, sizeKeys };
}

/** A Festival is always exclusive from standalone/product discounts, regardless of a
 *  misconfigured definition policy. Other campaigns retain their configured policy. */
const isExclusiveRule = (rule: CandidateRuleRow) => rule.promo_kind === 'festival'
  || rule.promo_exclusive_policy === 'override_all'
  || rule.promo_exclusive_policy === 'festival_exclusive';

/**
 * THE canonical deterministic resolution for one variant. Both the single-variant resolver and the
 * batch resolver call this function, so a storefront grid, the admin preview and the order pipeline
 * can never diverge.
 */
function resolveVariantPricing(
  variant: VariantPricingContextRow,
  rules: CandidateRuleRow[],
  options: { orderType: PriceChannel; paymentMode: PaymentMode; basePriceRial?: string },
): ResolvedVariantPrice {
  const channel = options.orderType;
  const paymentMode = options.paymentMode;
  const override = options.basePriceRial === undefined ? null : rial(options.basePriceRial);
  const cashBase = retailCashBase(variant, paymentMode === 'cash' && channel === 'retail' ? override : null);

  let basePrice: bigint | null;
  if (channel === 'wholesale') {
    // §10-§12: wholesale prices come from the wholesale authority (series allocation or the explicit
    // product wholesale price). A missing wholesale price is an explicit business error — the resolver
    // never silently falls back to the retail cash price.
    basePrice = override ?? (variant.wholesale_price_rial === null ? null : rial(variant.wholesale_price_rial));
    // §13/§20: 0 is «no price», never a free product — the resolver refuses instead of inventing one.
    if (basePrice === null || basePrice <= 0n) throw badRequest(`قیمت عمده برای SKU ${variant.sku} تعریف نشده است.`);
    // The four-installment offer is still gated by the product's canonical installment configuration.
    if (paymentMode === 'four_installments' && !installmentAllowed(variant))
      throw conflict(`خرید چهارقسطه برای SKU ${variant.sku} فعال نیست.`);
  } else if (paymentMode === 'four_installments') {
    if (!installmentAllowed(variant)) throw conflict(`خرید چهارقسطه برای SKU ${variant.sku} فعال نیست.`);
    const installmentBase = explicitInstallmentBase(variant, override);
    if (installmentBase === null || installmentBase <= 0n)
      throw badRequest(`قیمت پایه چهارقسطه برای SKU ${variant.sku} تعریف نشده است.`);
    basePrice = installmentBase;
  } else {
    if (cashBase === null || cashBase <= 0n) throw badRequest(`قیمت نقدی پایه برای SKU ${variant.sku} تعریف نشده است.`);
    basePrice = cashBase;
  }

  const installmentEnabled = installmentAllowed(variant);
  const installmentPolicy = variant.installment_policy;
  // «اعمال تخفیف روی خرید چهارقسطه»: only an explicit enabled_when_discounted / enabled policy
  // allows ordinary discounts to reduce the installment base.
  const installmentDiscountAllowed = installmentPolicy !== 'disabled_when_discounted'
    && !variant.disable_installments_on_discount
    && installmentPolicy !== 'disabled';

  const keys = matchKeysOf(variant);
  const matching = rules.filter((rule) => ruleMatchesVariant(rule, variant, keys));

  const emptyPrice = (discountBlocked: boolean): ResolvedVariantPrice => ({
    variantId: variant.variant_id,
    productId: variant.product_id,
    sku: variant.sku,
    size: variant.size_label,
    color: variant.color_label,
    channel,
    paymentMode,
    basePrice: asRial(basePrice!),
    cashBasePriceRial: asRial(cashBase ?? 0n),
    installmentBasePriceRial: variant.installment_price_rial === null ? null : asRial(rial(variant.installment_price_rial)),
    installmentEnabled,
    installmentDiscountAllowed,
    installmentPolicy,
    installmentDiscountBlocked: discountBlocked,
    matchedRule: null,
    discountType: null,
    discountValue: null,
    discountAmount: '0',
    finalPrice: asRial(basePrice!),
    compareAtPriceRial: null,
    startsAt: null,
    endsAt: null,
    source: 'none',
  });

  if (matching.length === 0) return emptyPrice(false);

  const hasExclusiveFestival = matching.some(isExclusiveRule);
  const poolOfRules = hasExclusiveFestival ? matching.filter(isExclusiveRule) : matching;

  poolOfRules.sort((a, b) => {
    const prioA = a.priority + (a.promo_priority ?? 0);
    const prioB = b.priority + (b.promo_priority ?? 0);
    if (prioB !== prioA) return prioB - prioA;
    const specDiff = specificityRank(b.target_type) - specificityRank(a.target_type);
    if (specDiff !== 0) return specDiff;
    const amtA = computeDiscountAmount(basePrice!, a.discount_type, rial(a.discount_value));
    const amtB = computeDiscountAmount(basePrice!, b.discount_type, rial(b.discount_value));
    if (amtB !== amtA) return amtB > amtA ? 1 : -1;
    return b.created_at.getTime() - a.created_at.getTime();
  });

  const winner = poolOfRules[0]!;
  const discountValueBig = rial(winner.discount_value);
  const rawDiscount = computeDiscountAmount(basePrice!, winner.discount_type, discountValueBig);
  // Ordinary discounts are ordinary: a product that forbids discounting on the installment path
  // resolves to the untouched four-installment base (and the order pipeline rejects the purchase).
  const blocked = paymentMode === 'four_installments' && rawDiscount > 0n && !installmentDiscountAllowed;
  const discountAmountBig = blocked ? 0n : rawDiscount;
  const finalPriceBig = basePrice! - discountAmountBig;
  const effectiveStartsAt = winner.starts_at ?? winner.promo_starts_at ?? null;
  const effectiveEndsAt = winner.ends_at ?? winner.promo_ends_at ?? null;

  return {
    variantId: variant.variant_id,
    productId: variant.product_id,
    sku: variant.sku,
    size: variant.size_label,
    color: variant.color_label,
    channel,
    paymentMode,
    basePrice: asRial(basePrice!),
    cashBasePriceRial: asRial(cashBase ?? 0n),
    installmentBasePriceRial: variant.installment_price_rial === null ? null : asRial(rial(variant.installment_price_rial)),
    installmentEnabled,
    installmentDiscountAllowed,
    installmentPolicy,
    installmentDiscountBlocked: blocked,
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
    // §9: the crossed-out price is ALWAYS derived from the canonical base of the resolved discount.
    compareAtPriceRial: discountAmountBig > 0n ? asRial(basePrice!) : null,
    startsAt: effectiveStartsAt ? effectiveStartsAt.toISOString() : null,
    endsAt: effectiveEndsAt ? effectiveEndsAt.toISOString() : null,
    source: winner.promo_kind === 'festival' ? 'festival' : 'promotion_rule',
  };
}

export async function resolveVariantPrice(
  db: DbClient,
  variantId: string,
  options: {
    orderType?: PriceChannel;
    paymentMode?: PaymentMode;
    now?: Date;
    basePriceRial?: string;
  } = {},
): Promise<ResolvedVariantPrice> {
  const orderType = options.orderType ?? 'retail';
  const paymentMode = options.paymentMode ?? 'cash';
  const now = options.now ?? new Date();

  const variant = await one<VariantPricingContextRow>(db, `${VARIANT_PRICING_SELECT} WHERE v.id = $1`, [variantId]);
  if (!variant || !variant.active) throw notFound();

  const rulesResult = await db.query<CandidateRuleRow>(
    `${RULE_PRICING_SELECT}
       AND (
         (r.target_type = 'variant' AND r.variant_id = $3)
         OR (r.target_type IN ('color', 'size', 'product') AND r.product_id = $4)
         OR (r.target_type = 'category' AND r.category = $5)
       )`,
    [orderType, now, variant.variant_id, variant.product_id, variant.category],
  );

  return resolveVariantPricing(variant, rulesResult.rows, {
    orderType,
    paymentMode,
    ...(options.basePriceRial === undefined ? {} : { basePriceRial: options.basePriceRial }),
  });
}

/**
 * §56 — batched resolution for grids (catalog, wholesale catalog, product 360, hub): exactly two
 * queries regardless of the number of variants, reusing the same per-variant resolution as
 * `resolveVariantPrice` so no surface can invent a different price.
 */
export async function resolveVariantPricesBatch(
  db: DbClient,
  variantIds: string[],
  options: { orderType?: PriceChannel; paymentMode?: PaymentMode; now?: Date; basePriceRialByVariant?: Map<string, string> } = {},
): Promise<Map<string, ResolvedVariantPrice>> {
  const orderType = options.orderType ?? 'retail';
  const paymentMode = options.paymentMode ?? 'cash';
  const now = options.now ?? new Date();
  const resolved = new Map<string, ResolvedVariantPrice>();
  if (variantIds.length === 0) return resolved;

  const variants = await db.query<VariantPricingContextRow>(
    `${VARIANT_PRICING_SELECT} WHERE v.id = ANY($1::uuid[]) AND v.active`, [variantIds]);
  if (variants.rows.length === 0) return resolved;

  const productIds = [...new Set(variants.rows.map((row) => row.product_id))];
  const categories = [...new Set(variants.rows.map((row) => row.category))];
  const rulesResult = await db.query<CandidateRuleRow>(
    `${RULE_PRICING_SELECT}
       AND (
         (r.target_type = 'variant' AND r.variant_id = ANY($3::uuid[]))
         OR (r.target_type IN ('color', 'size', 'product') AND r.product_id = ANY($4::uuid[]))
         OR (r.target_type = 'category' AND r.category = ANY($5::text[]))
       )`,
    [orderType, now, variantIds, productIds, categories],
  );

  for (const variant of variants.rows) {
    const override = options.basePriceRialByVariant?.get(variant.variant_id);
    // A variant with a missing price for the requested mode is skipped from the batch (the caller
    // surfaces it as an explicit business error in context) instead of blanking the whole grid.
    try {
      resolved.set(variant.variant_id, resolveVariantPricing(variant, rulesResult.rows, {
        orderType,
        paymentMode,
        ...(override === undefined ? {} : { basePriceRial: override }),
      }));
    } catch {
      continue;
    }
  }
  return resolved;
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

const productPromotionModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('standalone'), enabled: z.boolean(), confirmFestivalExit: z.boolean().default(false) }).strict(),
  z.object({
    mode: z.literal('festival'),
    promotionId: z.uuid().nullable(),
    channel: z.enum(['retail', 'wholesale', 'all']).optional(),
    discountType: z.enum(['percent', 'fixed_rial']).optional(),
    discountValue: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
    moveFromFestival: z.boolean().default(false),
  }).strict(),
]);

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
              r.starts_at, r.ends_at, r.active, r.priority, r.created_at,
              r.suspended_by_promotion_id, sp.name AS suspended_by_name,
              (r.suspended_by_promotion_id IS NOT NULL) AS effectively_suspended,
              pr.kind AS promotion_kind, pr.name AS promotion_name
       FROM promotion_rules r
       LEFT JOIN products p ON p.id = r.product_id
       LEFT JOIN product_variants v ON v.id = r.variant_id
       LEFT JOIN promotions pr ON pr.id = r.promotion_id
       LEFT JOIN promotions sp ON sp.id = r.suspended_by_promotion_id
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
              -- DEC-PRICING-001 (Option A): suspension persists until explicit reactivation.
              (r.suspended_by_promotion_id IS NOT NULL) AS effectively_suspended,
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

  // Product-level state for Studio and Product 360. `activeFestival` is effective now;
  // `assignedFestival` also exposes scheduled/expired assignments so an admin can see why
  // the saved standalone rules remain dormant after a Festival exits.
  app.get('/api/v1/promotions/product-summary', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:read') && !user.permissions.includes('products:write')) {
      requirePermission(user, 'promotions:read');
    }
    const query = z.object({ productId: z.uuid() }).parse(request.query);
    const assignment = await one<{
      id: string; promotion_id: string; name: string; channel: string; rule_active: boolean;
      promotion_active: boolean; starts_at: Date | null; ends_at: Date | null; effective: boolean;
    }>(pool,
      `SELECT r.id, r.promotion_id, pr.name, r.channel, r.active AS rule_active, pr.active AS promotion_active,
              pr.starts_at, pr.ends_at,
              (r.active AND pr.active
                AND (pr.starts_at IS NULL OR pr.starts_at <= now())
                AND (pr.ends_at IS NULL OR pr.ends_at > now())) AS effective
       FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
       WHERE r.product_id = $1 AND pr.kind = 'festival'
       ORDER BY (r.active AND pr.active
          AND (pr.starts_at IS NULL OR pr.starts_at <= now())
          AND (pr.ends_at IS NULL OR pr.ends_at > now())) DESC,
          r.active DESC, r.updated_at DESC, r.created_at DESC
       LIMIT 1`,
      [query.productId]);
    const counts = await one<{
      active_standalone: string; suspended_standalone: string; configured_standalone: string;
    }>(pool,
      `SELECT
         count(*) FILTER (WHERE r.promotion_id IS NULL AND r.active = true
           AND r.suspended_by_promotion_id IS NULL)::text AS active_standalone,
         count(*) FILTER (WHERE r.promotion_id IS NULL
           AND r.suspended_by_promotion_id IS NOT NULL)::text AS suspended_standalone,
         count(*) FILTER (WHERE r.promotion_id IS NULL)::text AS configured_standalone
       FROM promotion_rules r WHERE r.product_id = $1`,
      [query.productId]);
    const assignedFestival = assignment ? {
      ruleId: assignment.id,
      promotionId: assignment.promotion_id,
      name: assignment.name,
      channel: assignment.channel,
      active: assignment.rule_active,
      promotionActive: assignment.promotion_active,
      startsAt: assignment.starts_at,
      endsAt: assignment.ends_at,
      effective: assignment.effective,
    } : null;
    return {
      productId: query.productId,
      activeFestival: assignedFestival?.effective ? {
        promotionId: assignedFestival.promotionId,
        name: assignedFestival.name,
        endsAt: assignedFestival.endsAt,
      } : null,
      assignedFestival,
      activeStandaloneRules: Number(counts?.active_standalone ?? '0'),
      suspendedStandaloneRules: Number(counts?.suspended_standalone ?? '0'),
      configuredStandaloneRules: Number(counts?.configured_standalone ?? '0'),
    };
  });

  // Product-level mode controls operate on the canonical promotion_rules rows. All writes
  // lock the product so concurrent Studio/Center assignments cannot bypass Festival XOR.
  app.post('/api/v1/promotions/products/:productId/mode', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { productId } = z.object({ productId: z.uuid() }).parse(request.params);
    const body = productPromotionModeSchema.parse(request.body);

    return transaction(pool, async (client) => {
      const product = await one<{ id: string; name: string }>(
        client, 'SELECT id, name FROM products WHERE id = $1 FOR UPDATE', [productId]);
      if (!product) throw notFound();

      if (body.mode === 'standalone') {
        const savedRules = await client.query<{
          id: string; active: boolean; suspended_by_promotion_id: string | null;
        }>(
          `SELECT id, active, suspended_by_promotion_id FROM promotion_rules
           WHERE product_id = $1 AND promotion_id IS NULL FOR UPDATE`, [productId]);
        if (body.enabled && savedRules.rows.length === 0) {
          throw badRequest('ابتدا دست‌کم یک قانون تخفیف محصول یا واریانت ثبت کنید.');
        }

        let blockingFestival: { promotion_id: string; name: string; starts_at: Date | null; ends_at: Date | null } | null = null;
        if (body.enabled) {
          blockingFestival = await one(client,
            `SELECT pr.id AS promotion_id, pr.name, pr.starts_at, pr.ends_at
             FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
             WHERE r.product_id = $1 AND r.active = true AND pr.kind = 'festival' AND pr.active = true
               AND (pr.ends_at IS NULL OR pr.ends_at > now())
             ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`, [productId]);
          if (blockingFestival && !body.confirmFestivalExit) {
            throw conflict(`محصول به جشنواره «${blockingFestival.name}» متصل است. برای فعال‌کردن تخفیف مستقل، خروج صریح از جشنواره را تأیید کنید.`);
          }
          // Explicit Discount ON is also the only product-level reactivation action: it ends
          // active/scheduled assignments and restores every saved standalone rule unchanged.
          await client.query(
            `UPDATE promotion_rules r SET active = false, updated_at = now()
             FROM promotions pr
             WHERE r.product_id = $1 AND r.promotion_id = pr.id AND pr.kind = 'festival'
               AND r.active = true`, [productId]);
          const restored = await client.query<{ id: string }>(
            `UPDATE promotion_rules SET active = true, suspended_by_promotion_id = NULL, updated_at = now()
             WHERE product_id = $1 AND promotion_id IS NULL
               AND (active = false OR suspended_by_promotion_id IS NOT NULL)
             RETURNING id`, [productId]);
          await audit(client, user.id, 'product.standalone_discount.reactivated', 'product', productId,
            { standaloneRules: savedRules.rows, exitedFestivalId: blockingFestival?.promotion_id ?? null },
            { enabled: true, reactivatedRuleIds: restored.rows.map((row) => row.id) }, request.ip);
          return { productId, mode: 'standalone', enabled: true, reactivatedRules: restored.rowCount ?? 0 };
        }

        const disabled = await client.query<{ id: string }>(
          `UPDATE promotion_rules SET active = false, updated_at = now()
           WHERE product_id = $1 AND promotion_id IS NULL AND active = true
           RETURNING id`, [productId]);
        await audit(client, user.id, 'product.standalone_discount.deactivated', 'product', productId,
          { standaloneRules: savedRules.rows }, { enabled: false, deactivatedRuleIds: disabled.rows.map((row) => row.id) }, request.ip);
        return { productId, mode: 'standalone', enabled: false, deactivatedRules: disabled.rowCount ?? 0 };
      }

      if (body.promotionId === null) {
        const deactivated = await client.query<{ id: string; promotion_id: string }>(
          `UPDATE promotion_rules r SET active = false, updated_at = now()
           FROM promotions pr
           WHERE r.product_id = $1 AND r.promotion_id = pr.id AND pr.kind = 'festival'
             AND r.active = true
           RETURNING r.id, r.promotion_id`, [productId]);
        await audit(client, user.id, 'product.festival.deactivated', 'product', productId,
          { festivalRuleIds: deactivated.rows.map((row) => row.id) },
          { enabled: false, deactivatedRuleIds: deactivated.rows.map((row) => row.id), standaloneReactivated: false }, request.ip);
        return { productId, mode: 'festival', enabled: false, deactivatedRules: deactivated.rowCount ?? 0,
          standaloneReactivated: false };
      }

      const promotion = await one<{
        id: string; name: string; kind: string; channel: 'retail' | 'wholesale' | 'all';
        active: boolean; starts_at: Date | null; ends_at: Date | null;
      }>(client,
        'SELECT id, name, kind, channel, active, starts_at, ends_at FROM promotions WHERE id = $1 FOR UPDATE',
        [body.promotionId]);
      if (!promotion) throw notFound();
      if (promotion.kind !== 'festival') throw badRequest('شناسه انتخاب‌شده از نوع Festival نیست.');
      if (!promotion.active) throw badRequest(`جشنواره «${promotion.name}» غیرفعال است.`);
      if (promotion.ends_at && promotion.ends_at.getTime() <= Date.now()) throw badRequest(`جشنواره «${promotion.name}» به پایان رسیده است.`);
      const channel = body.channel ?? promotion.channel;
      if (promotion.channel !== 'all' && channel !== 'all' && channel !== promotion.channel) {
        throw badRequest('کانال قانون با کانال تعریف‌شده برای جشنواره هم‌خوانی ندارد.');
      }
      if (!body.discountType || body.discountValue === undefined) {
        throw badRequest('نوع و مقدار تخفیف جشنواره را وارد کنید.');
      }
      const discountValue = rial(body.discountValue);
      if (discountValue <= 0n) throw badRequest('مقدار تخفیف باید بزرگ‌تر از صفر باشد.');
      if (body.discountType === 'percent' && (discountValue < 1n || discountValue > 95n)) {
        throw badRequest('درصد تخفیف باید بین ۱ تا ۹۵ باشد.');
      }

      const currentFestival = await one<{
        promotion_id: string; promo_name: string; effective: boolean;
      }>(client,
        `SELECT r.promotion_id, pr.name AS promo_name,
                (pr.active AND (pr.starts_at IS NULL OR pr.starts_at <= now())
                  AND (pr.ends_at IS NULL OR pr.ends_at > now())) AS effective
         FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
         WHERE r.product_id = $1 AND r.active = true AND pr.kind = 'festival'
           AND r.promotion_id <> $2 AND pr.active = true AND (pr.ends_at IS NULL OR pr.ends_at > now())
         ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`, [productId, promotion.id]);
      if (currentFestival && !body.moveFromFestival) {
        throw conflict(`محصول به جشنواره «${currentFestival.promo_name}» متصل است. برای انتقال، تأیید صریح را فعال کنید.`);
      }
      const priorRules = await client.query<{
        id: string; promotion_id: string | null; active: boolean; suspended_by_promotion_id: string | null;
      }>(
        `SELECT id, promotion_id, active, suspended_by_promotion_id FROM promotion_rules
         WHERE product_id = $1 AND (promotion_id IS NULL OR promotion_id IN
           (SELECT id FROM promotions WHERE kind = 'festival')) FOR UPDATE`, [productId]);

      await client.query(
        `UPDATE promotion_rules r SET active = false, updated_at = now()
         FROM promotions pr
         WHERE r.product_id = $1 AND r.promotion_id = pr.id AND pr.kind = 'festival'
           AND r.promotion_id <> $2 AND r.active = true`, [productId, promotion.id]);

      const existingRule = await one<{ id: string }>(client,
        `SELECT id FROM promotion_rules
         WHERE product_id = $1 AND promotion_id = $2 AND target_type = 'product'
         ORDER BY active DESC, updated_at DESC, created_at DESC LIMIT 1 FOR UPDATE`, [productId, promotion.id]);
      let festivalRuleId: string;
      if (existingRule) {
        festivalRuleId = existingRule.id;
        await client.query(
          `UPDATE promotion_rules SET name = $2, channel = $3, discount_type = $4, discount_value = $5,
             starts_at = NULL, ends_at = NULL, active = true, updated_at = now()
           WHERE id = $1`,
          [festivalRuleId, `جشنواره ${promotion.name}`, channel, body.discountType, discountValue.toString()]);
      } else {
        festivalRuleId = randomUUID();
        await client.query(
          `INSERT INTO promotion_rules(
            id, promotion_id, name, channel, target_type, product_id, discount_type, discount_value,
            active, priority, created_by
          ) VALUES ($1,$2,$3,$4,'product',$5,$6,$7,true,0,$8)`,
          [festivalRuleId, promotion.id, `جشنواره ${promotion.name}`, channel, productId,
            body.discountType, discountValue.toString(), user.id]);
      }
      const suspended = await client.query<{ id: string }>(
        `UPDATE promotion_rules SET suspended_by_promotion_id = $2, updated_at = now()
         WHERE product_id = $1 AND promotion_id IS NULL
           AND suspended_by_promotion_id IS DISTINCT FROM $2
         RETURNING id`, [productId, promotion.id]);
      const modeResult = {
        productId, mode: 'festival', enabled: true, promotionId: promotion.id,
        promotionName: promotion.name, ruleId: festivalRuleId, channel,
        movedFromPromotionId: currentFestival?.promotion_id ?? null,
        suspendedRuleCount: suspended.rowCount ?? 0,
      };
      await audit(client, user.id, 'product.festival.activated', 'product', productId,
        { promotionRules: priorRules.rows, currentFestivalId: currentFestival?.promotion_id ?? null }, modeResult, request.ip);
      return modeResult;
    });
  });

  // DEC-PRICING-001 / Option A: deactivating or ending a Festival never clears saved
  // standalone suspension. Explicit product-level reactivation is required.
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

      let promo: { id: string; kind: string; name: string; active: boolean; channel: string; starts_at: Date | null; ends_at: Date | null } | null = null;
      if (body.promotionId) {
        promo = await one(client,
          'SELECT id, kind, name, active, channel, starts_at, ends_at FROM promotions WHERE id = $1 FOR UPDATE',
          [body.promotionId]);
        if (!promo) throw notFound();
      }

      if (promo?.kind === 'festival' && body.active && !resolvedProductId) {
        throw badRequest('قانون Festival فعال باید به محصول یا واریانت مشخص متصل باشد؛ برای چند محصول از Festival-bulk استفاده کنید.');
      }

      // A5/A6: serialize product promotion changes and reject any active/scheduled
      // Festival + active standalone overlap, not only the currently-effective window.
      if (resolvedProductId) {
        const lockedProduct = await one<{ id: string }>(
          client, 'SELECT id FROM products WHERE id = $1 FOR UPDATE', [resolvedProductId]);
        if (!lockedProduct) throw notFound();

        if (promo?.kind === 'festival' && body.active) {
          if (!promo.active) throw badRequest(`جشنواره «${promo.name}» غیرفعال است.`);
          if (promo.ends_at && promo.ends_at.getTime() <= Date.now()) throw badRequest(`جشنواره «${promo.name}» به پایان رسیده است.`);
          if (promo.channel !== 'all' && body.channel !== 'all' && body.channel !== promo.channel) {
            throw badRequest('کانال قانون با کانال تعریف‌شده برای جشنواره هم‌خوانی ندارد.');
          }
        }

        const otherFestival = body.active ? await one<{ promotion_id: string; promo_name: string }>(
          client,
          `SELECT r.promotion_id, pr.name AS promo_name
           FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
           WHERE r.product_id = $1 AND r.active = true AND pr.kind = 'festival'
             AND pr.active = true AND (pr.ends_at IS NULL OR pr.ends_at > now())
             ${promo?.kind === 'festival' ? 'AND pr.id <> $2' : ''}
           ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`,
          promo?.kind === 'festival' ? [resolvedProductId, promo.id] : [resolvedProductId],
        ) : null;

        if (promo?.kind === 'festival' && body.active) {
          // Max one active/scheduled Festival per product; A→B transfer needs confirmation.
          if (otherFestival) {
            if (body.moveFromFestival !== true) {
              throw conflict(
                `این محصول هم‌اکنون به جشنواره «${otherFestival.promo_name}» متصل است. برای انتقال به جشنواره جدید باید تأیید صریح (moveFromFestival) ارسال شود.`,
              );
            }
            await client.query(
              `UPDATE promotion_rules r SET active = false, updated_at = now()
               FROM promotions pr
               WHERE r.product_id = $1 AND r.promotion_id = pr.id AND pr.kind = 'festival'
                 AND r.active = true AND r.promotion_id <> $2`,
              [resolvedProductId, promo.id],
            );
          }
          // Preserve all saved rules and exact values; mark them dormant through the Festival.
          await client.query(
            `UPDATE promotion_rules SET suspended_by_promotion_id = $2, updated_at = now()
             WHERE product_id = $1 AND promotion_id IS NULL
               AND suspended_by_promotion_id IS DISTINCT FROM $2`,
            [resolvedProductId, body.promotionId],
          );
        } else if (!body.promotionId && body.active && otherFestival) {
          throw conflict(
            `این محصول به جشنواره «${otherFestival.promo_name}» متصل است؛ تخفیف مستقل فعال نمی‌شود. ابتدا جشنواره را خاموش کنید.`,
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

  // §17.10: bulk festival assignment from «همه کالاها» — one call, per-item result summary.
  app.post('/api/v1/promotions/festival-bulk', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const body = z.object({
      promotionId: z.uuid(),
      productIds: z.array(z.uuid()).min(1).max(200),
      discountType: z.enum(['percent', 'fixed_rial']),
      discountValue: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
      moveFromFestival: z.boolean().default(false),
    }).strict().parse(request.body);

    const promo = await one<{ id: string; name: string; kind: string; active: boolean; ends_at: Date | null }>(
      pool, 'SELECT id, name, kind, active, ends_at FROM promotions WHERE id = $1', [body.promotionId]);
    if (!promo) throw notFound();
    if (promo.kind !== 'festival') throw badRequest('شناسه انتخاب‌شده جشنواره نیست.');
    if (!promo.active) throw badRequest(`جشنواره «${promo.name}» غیرفعال است.`);
    if (promo.ends_at && promo.ends_at.getTime() <= Date.now()) throw badRequest(`جشنواره «${promo.name}» به پایان رسیده است.`);
    const discountValue = rial(body.discountValue);
    if (body.discountType === 'percent' && (discountValue < 1n || discountValue > 95n)) {
      throw badRequest('درصد تخفیف باید بین ۱ تا ۹۵ باشد.');
    }

    const productIds = [...new Set(body.productIds)];
    const results: { productId: string; productName: string | null; status: string; message: string }[] = [];
    for (const productId of productIds) {
      try {
        const result = await transaction(pool, async (client) => {
          const product = await one<{ id: string; name: string }>(client, 'SELECT id, name FROM products WHERE id = $1 FOR UPDATE', [productId]);
          if (!product) return { productId, productName: null, status: 'error', message: 'محصول یافت نشد.' };
          const existing = await one<{ promotion_id: string; promo_name: string }>(client,
            `SELECT r.promotion_id, pr.name AS promo_name
             FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
             WHERE r.product_id = $1 AND r.active = true
               AND pr.kind = 'festival' AND pr.active = true
               AND (pr.ends_at IS NULL OR pr.ends_at > now())
             ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`, [productId]);
          if (existing && existing.promotion_id === body.promotionId) {
            return { productId, productName: product.name, status: 'already_in_festival', message: `همین حالا در «${promo.name}» است.` };
          }
          if (existing && !body.moveFromFestival) {
            return { productId, productName: product.name, status: 'needs_confirmation', message: `در جشنواره فعال «${existing.promo_name}» است؛ انتقال نیاز به تأیید دارد.` };
          }
          // One active/scheduled Festival assignment per product. Inactive/expired historical
          // Festival rows are also turned off when a new Festival is explicitly assigned.
          await client.query(
            `UPDATE promotion_rules r SET active = false, updated_at = now()
             FROM promotions pr
             WHERE r.product_id = $1 AND r.promotion_id = pr.id AND pr.kind = 'festival'
               AND r.active = true AND r.promotion_id <> $2`,
            [productId, body.promotionId]);
          // §18 / DEC-PRICING-001: preserve rule values and stamp all configured standalone
          // rules; only the explicit admin reactivation path removes this suspension.
          await client.query(
            `UPDATE promotion_rules SET suspended_by_promotion_id = $2, updated_at = now()
             WHERE product_id = $1 AND promotion_id IS NULL
               AND suspended_by_promotion_id IS DISTINCT FROM $2`,
            [productId, body.promotionId]);
          const id = randomUUID();
          await client.query(
            `INSERT INTO promotion_rules(
              id, promotion_id, name, channel, target_type, product_id,
              discount_type, discount_value, active, priority, created_by
            ) VALUES ($1,$2,$3,'all','product',$4,$5,$6,true,0,$7)`,
            [id, body.promotionId, promo.name, productId, body.discountType, discountValue.toString(), user.id]);
          await audit(client, user.id, 'promotion_rule.created', 'promotion_rule', id, undefined,
            { bulk: true, promotionId: body.promotionId, productId, discountType: body.discountType, discountValue: discountValue.toString() }, request.ip);
          return { productId, productName: product.name, status: existing ? 'moved' : 'added', message: existing ? `از «${existing.promo_name}» به «${promo.name}» منتقل شد.` : `به «${promo.name}» اضافه شد.` };
        });
        results.push(result);
      } catch (error) {
        results.push({ productId, productName: null, status: 'error', message: error instanceof Error ? error.message : 'خطای نامشخص' });
      }
    }
    const summary = {
      total: results.length,
      added: results.filter((r) => r.status === 'added').length,
      moved: results.filter((r) => r.status === 'moved').length,
      alreadyInFestival: results.filter((r) => r.status === 'already_in_festival').length,
      needsConfirmation: results.filter((r) => r.status === 'needs_confirmation').length,
      errors: results.filter((r) => r.status === 'error').length,
    };
    return reply.code(200).send({ promotionId: body.promotionId, promotionName: promo.name, summary, results });
  });

  app.patch('/api/v1/promotions/rules/:id', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = updatePromotionRuleSchema.parse(request.body);
    return transaction(pool, async (client) => {
      const scope = await one<{ product_id: string | null }>(client,
        'SELECT product_id FROM promotion_rules WHERE id = $1', [id]);
      if (!scope) throw notFound();
      if (scope.product_id) await one(client, 'SELECT id FROM products WHERE id = $1 FOR UPDATE', [scope.product_id]);
      const existing = await one<{
        id: string;
        product_id: string | null;
        promotion_id: string | null;
        suspended_by_promotion_id: string | null;
        discount_type: DiscountType;
        discount_value: string;
        active: boolean;
        priority: number;
        name: string | null;
        starts_at: Date | null;
        ends_at: Date | null;
      }>(client, `SELECT id, product_id, promotion_id, suspended_by_promotion_id,
          discount_type, discount_value::text, active, priority, name, starts_at, ends_at
         FROM promotion_rules WHERE id = $1 FOR UPDATE`, [id]);
      if (!existing) throw notFound();
      if (existing.product_id && existing.promotion_id === null && body.active === true) {
        const activeFestival = await one<{ promo_name: string }>(client,
          `SELECT pr.name AS promo_name
           FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
           WHERE r.product_id = $1 AND r.active = true AND pr.kind = 'festival' AND pr.active = true
             AND (pr.ends_at IS NULL OR pr.ends_at > now())
           ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`, [existing.product_id]);
        if (activeFestival) throw conflict(`محصول به جشنواره «${activeFestival.promo_name}» متصل است؛ قانون مستقل فعال نمی‌شود.`);
      }
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

  // DEC-PRICING-001 (Option A): explicit admin reactivation of a festival-suspended rule.
  app.post('/api/v1/promotions/rules/:id/reactivate', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('promotions:write')) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const scope = await one<{ product_id: string | null }>(client,
        'SELECT product_id FROM promotion_rules WHERE id = $1', [id]);
      if (!scope) throw notFound();
      if (scope.product_id) {
        await one(client, 'SELECT id FROM products WHERE id = $1 FOR UPDATE', [scope.product_id]);
      }
      const existing = await one<{ id: string; product_id: string | null; suspended_by_promotion_id: string | null; active: boolean }>(
        client, 'SELECT id, product_id, suspended_by_promotion_id, active FROM promotion_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!existing) throw notFound();
      if (!existing.suspended_by_promotion_id) throw badRequest('این قانون معلق نیست و نیازی به فعال‌سازی مجدد ندارد.');
      if (existing.product_id) {
        const activeFestival = await one<{ promo_name: string }>(client,
          `SELECT pr.name AS promo_name
           FROM promotion_rules r JOIN promotions pr ON pr.id = r.promotion_id
           WHERE r.product_id = $1 AND r.active = true AND pr.kind = 'festival' AND pr.active = true
             AND (pr.ends_at IS NULL OR pr.ends_at > now())
           ORDER BY pr.starts_at NULLS FIRST LIMIT 1 FOR UPDATE OF r, pr`, [existing.product_id]);
        if (activeFestival) {
          throw conflict(`این محصول هنوز به جشنواره «${activeFestival.promo_name}» متصل است؛ ابتدا محصول را از جشنواره خارج کنید.`);
        }
      }
      await client.query('UPDATE promotion_rules SET active = true, suspended_by_promotion_id = NULL, updated_at = now() WHERE id = $1', [id]);
      await audit(client, user.id, 'promotion_rule.reactivated', 'promotion_rule', id,
        { active: existing.active, suspendedByPromotionId: existing.suspended_by_promotion_id },
        { active: true, suspendedByPromotionId: null }, request.ip);
      return { id, reactivated: true, active: true };
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
      // §20: a wholesale Series request identifies the canonical Series (never a bare list of pieces).
      series: z.array(z.object({ seriesTemplateId: z.uuid(), count: z.number().int().min(1).max(1000) }).strict()).max(20).optional(),
      items: z.array(z.object({
        variantId: z.uuid(),
        quantity: z.number().int().min(1).max(10000).default(1),
      })).max(100).default([]),
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
    if ((body.series?.length ?? 0) > 0 && body.orderType !== 'wholesale')
      throw badRequest('سفارش بر مبنای سری فقط برای معاملات عمده مجاز است.');
    if (body.items.length === 0 && !body.series?.length)
      throw badRequest('حداقل یک قلم یا یک سری برای محاسبهٔ قیمت لازم است.');

    // §20/§12: Series pricing comes from the same server allocation the order pipeline uses, so a
    // wholesale preview always shows the exact total (direct) or the exact component sum (derived).
    const seriesBlocks: Array<Record<string, unknown>> = [];
    for (const entry of body.series ?? []) {
      const composition = await loadSeriesComposition(pool, entry.seriesTemplateId);
      if (!composition || !composition.template.active) throw badRequest('قالب سری انتخاب‌شده معتبر یا فعال نیست.');
      if (composition.template.pricing_mode === 'legacy_product')
        throw badRequest(`برای سری «${composition.template.name}» قیمت‌گذاری عمده تعریف نشده است.`);
      const allocated = allocateSeriesPrice(composition.items, composition.template.pricing_mode, composition.template.total_price_rial);
      const units = allocated.filter((item) => item.basePriceRial !== null);
      const total = units.reduce((sum, item) => sum + BigInt(item.basePriceRial!) * BigInt(item.quantity_per_series) * BigInt(entry.count), 0n);
      seriesBlocks.push({
        seriesTemplateId: entry.seriesTemplateId, name: composition.template.name,
        pricingMode: composition.template.pricing_mode, count: entry.count,
        piecesPerSeries: allocated.reduce((sum, item) => sum + item.quantity_per_series, 0),
        totalPriceRial: asRial(total),
        unitPrices: units.map((item) => ({ variantId: item.variant_id, sku: item.sku, basePriceRial: item.basePriceRial })),
      });
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
      series: seriesBlocks,
      lines,
      subtotalRial: asRial(addRial(baseTotals)),
      discountRial: asRial(addRial(discountTotals)),
      totalRial: asRial(addRial(finalTotals)),
    };
  });
}
