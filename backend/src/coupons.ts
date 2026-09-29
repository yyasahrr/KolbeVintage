import { randomBytes, randomUUID } from 'node:crypto';
import { one, type DbClient } from './db.js';
import { rial } from './money.js';

/* Coupon and festival engine (item 17): shared by checkout, CRM automations and
   the admin console. Every rule (window, audience, scope, caps, usage limits)
   is evaluated here, never in the client. */

export type DiscountContext = {
  userId: string;
  orderType: 'retail' | 'wholesale';
  isVip: boolean;
  /** line totals keyed by "productId|category" for scope matching */
  lines: Array<{ productId: string; category: string; total: bigint }>;
};

export type DiscountResolution = {
  discountRial: bigint;
  source: 'coupon' | 'festival' | 'none';
  couponId?: string;
  festivalId?: string;
  note?: string;
};

type RuleRow = {
  id: string; type: 'percent' | 'fixed'; value: string; max_discount_rial: string | null;
  min_order_rial: string; usage_limit_total: number | null; usage_limit_per_user: number | null;
  used_count: number | null; recipient_user_id: string | null; audience: string[]; scope: { productIds?: string[]; categories?: string[] };
  starts_at: Date; ends_at: Date; daily_start_time: string | null; daily_end_time: string | null;
};

const tehranTime = (date: Date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(date);

function withinDailyWindow(row: Pick<RuleRow, 'daily_start_time' | 'daily_end_time'>, now = new Date()): boolean {
  if (!row.daily_start_time || !row.daily_end_time) return true;
  const current = tehranTime(now); // HH:MM
  const start = row.daily_start_time.slice(0, 5);
  const end = row.daily_end_time.slice(0, 5);
  return start <= end ? current >= start && current <= end : current >= start || current <= end;
}

function audienceMatches(audience: string[], context: DiscountContext): boolean {
  if (!audience.length || audience.includes('all')) return true;
  const wanted = context.orderType === 'wholesale' ? 'wholesale' : context.isVip ? 'vip' : 'customer';
  return audience.includes(wanted);
}

function eligibleSubtotal(row: Pick<RuleRow, 'scope'>, context: DiscountContext): bigint {
  const scope = row.scope ?? {};
  const productIds = scope.productIds ?? [];
  const categories = scope.categories ?? [];
  if (!productIds.length && !categories.length) return context.lines.reduce((sum, line) => sum + line.total, 0n);
  return context.lines
    .filter((line) => productIds.includes(line.productId) || categories.includes(line.category))
    .reduce((sum, line) => sum + line.total, 0n);
}

function computeDiscount(row: RuleRow, base: bigint): bigint {
  if (base <= 0n) return 0n;
  let discount = row.type === 'percent'
    ? base * BigInt(Math.round(Number(row.value) * 100)) / 10000n
    : rial(row.value);
  if (row.max_discount_rial !== null && discount > rial(row.max_discount_rial)) discount = rial(row.max_discount_rial);
  return discount > base ? base : discount;
}

export async function resolveCouponDiscount(client: DbClient, context: DiscountContext, code: string, now = new Date()): Promise<DiscountResolution> {
  const coupon = await one<RuleRow & { code: string; active: boolean; festival_id: string | null }>(client,
    `SELECT id,type,value,max_discount_rial,min_order_rial,usage_limit_total,usage_limit_per_user,used_count,
            recipient_user_id,audience,scope,starts_at,ends_at,daily_start_time,daily_end_time,code,active,festival_id
     FROM coupons WHERE upper(code) = upper($1)`, [code]);
  if (!coupon || !coupon.active) return { discountRial: 0n, source: 'none', note: 'کد تخفیف معتبر نیست.' };
  if (now < new Date(coupon.starts_at) || now > new Date(coupon.ends_at) || !withinDailyWindow(coupon, now))
    return { discountRial: 0n, source: 'none', note: 'کد تخفیف در این بازه زمانی فعال نیست.' };
  if (coupon.recipient_user_id && coupon.recipient_user_id !== context.userId)
    return { discountRial: 0n, source: 'none', note: 'این کد تخفیف برای حساب دیگری صادر شده است.' };
  if (!audienceMatches(coupon.audience, context)) return { discountRial: 0n, source: 'none', note: 'این کد برای نوع خرید شما فعال نیست.' };
  const subtotal = context.lines.reduce((sum, line) => sum + line.total, 0n);
  if (subtotal < rial(coupon.min_order_rial)) return { discountRial: 0n, source: 'none', note: 'مبلغ سفارش به حداقل این کد نرسیده است.' };
  if (coupon.usage_limit_total !== null && (coupon.used_count ?? 0) >= coupon.usage_limit_total)
    return { discountRial: 0n, source: 'none', note: 'سقف استفاده از این کد تکمیل شده است.' };
  if (coupon.usage_limit_per_user !== null) {
    const used = await one<{ count: string }>(client,
      'SELECT count(*)::text AS count FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2',
      [coupon.id, context.userId]);
    if (Number(used?.count ?? 0) >= coupon.usage_limit_per_user)
      return { discountRial: 0n, source: 'none', note: 'سقف استفاده شما از این کد تکمیل شده است.' };
  }
  const base = eligibleSubtotal(coupon, context);
  const discount = computeDiscount(coupon, base);
  if (discount === 0n) return { discountRial: 0n, source: 'none', note: 'کد تخفیف برای اقلام این سفارش کاربرد ندارد.' };
  return { discountRial: discount, source: 'coupon', couponId: coupon.id, festivalId: coupon.festival_id ?? undefined };
}

/** Auto-applied festival discount when the buyer has no coupon code. */
export async function resolveFestivalDiscount(client: DbClient, context: DiscountContext, now = new Date()): Promise<DiscountResolution> {
  const festivals = await client.query<RuleRow & { auto_apply: boolean }>(
    `SELECT id, max_discount_rial, min_order_rial, usage_limit_total, usage_limit_per_user,
            NULL::integer AS used_count, NULL::uuid AS recipient_user_id, audience, scope, starts_at, ends_at,
            daily_start_time, daily_end_time, auto_apply,
            CASE WHEN discount_percent IS NOT NULL THEN 'percent' ELSE 'fixed' END AS type,
            COALESCE(discount_percent::text, discount_fixed_rial::text) AS value
     FROM festivals
     WHERE active AND auto_apply AND starts_at <= $1 AND ends_at >= $1`, [now]);
  let best: DiscountResolution = { discountRial: 0n, source: 'none' };
  for (const festival of festivals.rows) {
    if (!withinDailyWindow(festival, now) || !audienceMatches(festival.audience, context)) continue;
    const subtotal = context.lines.reduce((sum, line) => sum + line.total, 0n);
    if (subtotal < rial(festival.min_order_rial)) continue;
    if (festival.usage_limit_total !== null) {
      const used = await one<{ count: string }>(client,
        `SELECT count(*)::text AS count FROM coupon_redemptions cr JOIN coupons c ON c.id = cr.coupon_id
         WHERE c.festival_id = $1`, [festival.id]);
      if (Number(used?.count ?? 0) >= festival.usage_limit_total) continue;
    }
    const discount = computeDiscount(festival, eligibleSubtotal(festival, context));
    if (discount > best.discountRial) best = { discountRial: discount, source: 'festival', festivalId: festival.id };
  }
  return best;
}

export function generateCouponCode(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex').toUpperCase()}`;
}

export async function createCoupon(client: DbClient, input: {
  code?: string; festivalId?: string | null; campaignName?: string | null; type: 'percent' | 'fixed';
  value: string; maxDiscountRial?: string | null; minOrderRial?: string; usageLimitTotal?: number | null;
  usageLimitPerUser?: number | null; recipientUserId?: string | null; audience?: string[];
  scope?: { productIds?: string[]; categories?: string[] }; startsAt?: Date; endsAt: Date;
  dailyStartTime?: string | null; dailyEndTime?: string | null; source?: 'manual' | 'festival' | 'crm_automation' | 'campaign';
  createdBy?: string | null;
}) {
  const id = randomUUID();
  const code = input.code ?? generateCouponCode('KV');
  await client.query(
    `INSERT INTO coupons(id,code,festival_id,campaign_name,type,value,max_discount_rial,min_order_rial,
       usage_limit_total,usage_limit_per_user,recipient_user_id,audience,scope,starts_at,ends_at,
       daily_start_time,daily_end_time,source,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, code, input.festivalId ?? null, input.campaignName ?? null, input.type, input.value,
      input.maxDiscountRial ?? null, input.minOrderRial ?? '0', input.usageLimitTotal ?? null,
      input.usageLimitPerUser ?? null, input.recipientUserId ?? null, input.audience ?? [],
      JSON.stringify(input.scope ?? {}), input.startsAt ?? new Date(), input.endsAt,
      input.dailyStartTime ?? null, input.dailyEndTime ?? null, input.source ?? 'manual', input.createdBy ?? null]);
  return { id, code };
}

export async function recordRedemption(client: DbClient, couponId: string, userId: string, orderId: string, discount: bigint) {
  await client.query(
    'INSERT INTO coupon_redemptions(id,coupon_id,user_id,order_id,discount_rial) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), couponId, userId, orderId, discount.toString()]);
  await client.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponId]);
}
