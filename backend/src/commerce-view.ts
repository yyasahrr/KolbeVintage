import type { PoolClient } from 'pg';
import type { DbPool } from './db.js';

/* Shared, read-only commerce projections used by CMS, Style Builder, Recommendation and Account.
   Rule (Req 185, 260, 319): nobody keeps its own copy of product/price/stock — everything here is
   derived from products + product_variants + stock_balances at read time. */

type Queryable = DbPool | PoolClient;

export type CommerceProduct = {
  id: string; name: string; brand: string; category: string; productType: string | null;
  gender: string; seasons: string[]; vibes: string[];
  priceRial: string; installmentPriceRial: string | null; perInstallmentRial: string | null;
  compareAtRial: string | null; discountPercent: number; installmentEnabled: boolean; installmentProviders: string[];
  image: string | null; flatLay: string | null; available: number; isNew: boolean; createdAt: string;
  rating: number; reviewCount: number; cardTemplate?: string;
  variants: { id: string; sku: string; size: string | null; color: string | null; available: number }[];
};

/** Public media URL for a product image reference `{fileId,url}` (blob:/data: previews are never public). */
export function mediaUrl(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return /^https?:\/\//.test(ref) || ref.startsWith('/api/v1/media/') ? ref : null;
  const value = ref as { fileId?: string | null; url?: string };
  if (value.fileId) return `/api/v1/media/${value.fileId}`;
  return value.url && /^https?:\/\//.test(value.url) ? value.url : null;
}

/** Category text → canonical style category (used by the compatibility matrix). */
export function styleCategoryOf(category: string, productType?: string | null): string {
  if (productType) {
    const map: Record<string, string> = { coat: 'coat', shirt: 'shirt', trousers: 'trousers', shoes: 'shoes', knitwear: 'knitwear', accessory: 'accessory' };
    if (map[productType]) return map[productType]!;
  }
  if (/کفش|بوت|لوفر|کتانی/.test(category)) return 'shoes';
  if (/شلوار|جین/.test(category)) return 'trousers';
  if (/کت|پالتو|بلیزر|ترنچ|کاپشن|مانتو|بارانی/.test(category)) return 'coat';
  if (/بافت|پلیور|هودی|ژاکت/.test(category)) return 'knitwear';
  if (/اکسسوری|کیف|کمربند|شال|کلاه/.test(category)) return 'accessory';
  if (/پیراهن|شومیز|تی‌شرت|تیشرت/.test(category)) return 'shirt';
  return 'shirt';
}

export type CollectionRules = {
  category?: string; categories?: string[]; vibe?: string; season?: string; gender?: string; productType?: string;
  minDiscountPercent?: number; minPriceRial?: string; maxPriceRial?: string; inStockOnly?: boolean;
  installmentEnabled?: boolean; newWithinDays?: number; productIds?: string[];
  sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'discount' | 'popular'; limit?: number;
};

/** Pure: collection rules → parameterised WHERE/ORDER (Req 206-207). Never interpolates user values. */
export function buildCollectionQuery(rules: CollectionRules) {
  const where: string[] = [`p.status = 'published'`];
  const params: unknown[] = [];
  const push = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (rules.productIds?.length) where.push(`p.id = ANY(${push(rules.productIds)}::uuid[])`);
  if (rules.category) where.push(`p.category = ${push(rules.category)}`);
  if (rules.categories?.length) where.push(`p.category = ANY(${push(rules.categories)}::text[])`);
  if (rules.vibe) where.push(`${push(rules.vibe)} = ANY(p.vibes)`);
  if (rules.season) where.push(`(${push(rules.season)} = ANY(p.seasons) OR 'all-season' = ANY(p.seasons))`);
  if (rules.gender) where.push(`(p.gender = ${push(rules.gender)} OR p.gender = 'unisex')`);
  if (rules.productType) where.push(`p.product_type_code = ${push(rules.productType)}`);
  if (rules.minDiscountPercent) where.push(`p.discount_percent >= ${push(rules.minDiscountPercent)}`);
  if (rules.minPriceRial) where.push(`p.cash_price_rial >= ${push(rules.minPriceRial)}::bigint`);
  if (rules.maxPriceRial) where.push(`p.cash_price_rial <= ${push(rules.maxPriceRial)}::bigint`);
  if (rules.installmentEnabled) where.push(`p.installment_enabled`);
  if (rules.newWithinDays) where.push(`p.created_at >= now() - (${push(rules.newWithinDays)} || ' days')::interval`);
  if (rules.inStockOnly) where.push(`COALESCE(b.available, 0) > 0`);
  const order = rules.sortBy === 'price_asc' ? 'p.cash_price_rial ASC'
    : rules.sortBy === 'price_desc' ? 'p.cash_price_rial DESC'
    : rules.sortBy === 'discount' ? 'p.discount_percent DESC, p.created_at DESC'
    : rules.sortBy === 'popular' ? 'COALESCE(s.sold, 0) DESC, p.created_at DESC'
    : 'p.created_at DESC';
  const limit = Math.min(Math.max(Number(rules.limit ?? 8), 1), 48);
  return { where: where.join(' AND '), params, order, limit };
}

const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.brand, p.category, p.product_type_code, p.gender, p.seasons, p.vibes,
         p.cash_price_rial::text AS cash_price_rial, p.installment_price_rial::text AS installment_price_rial,
         p.discount_percent, p.installment_enabled, p.installment_providers, p.metadata, p.created_at,
         COALESCE(b.available, 0)::int AS available,
         COALESCE(r.avg_rating, 0)::float AS avg_rating, COALESCE(r.review_count, 0)::int AS review_count,
         (SELECT pm.url FROM product_media pm WHERE pm.product_id = p.id AND pm.role = 'hero' ORDER BY pm.position LIMIT 1) AS hero_media,
         (SELECT COALESCE(pm.cutout_url, pm.url) FROM product_media pm WHERE pm.product_id = p.id AND pm.role = 'flat_lay' ORDER BY pm.position LIMIT 1) AS flat_lay_media,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'size', v.size_label, 'color', v.color_label,
             'available', COALESCE((SELECT SUM(sb.on_hand - sb.reserved - sb.damaged) FROM stock_balances sb
               JOIN warehouses w ON w.id = sb.warehouse_id AND w.active WHERE sb.variant_id = v.id), 0)) ORDER BY v.sku)
           FROM product_variants v WHERE v.product_id = p.id AND v.active), '[]'::jsonb) AS variants
  FROM products p
  LEFT JOIN (
    SELECT v.product_id, SUM(sb.on_hand - sb.reserved - sb.damaged)::int AS available
    FROM product_variants v JOIN stock_balances sb ON sb.variant_id = v.id
    JOIN warehouses w ON w.id = sb.warehouse_id AND w.active
    WHERE v.active GROUP BY v.product_id
  ) b ON b.product_id = p.id
  LEFT JOIN (
    SELECT product_id, AVG(rating) AS avg_rating, COUNT(*) AS review_count
    FROM customer_reviews WHERE status = 'approved' GROUP BY product_id
  ) r ON r.product_id = p.id
  LEFT JOIN (
    SELECT ol.product_id, SUM(ol.quantity)::int AS sold FROM order_lines ol JOIN orders o ON o.id = ol.order_id
    WHERE o.status NOT IN ('pending_payment', 'cancelled') GROUP BY ol.product_id
  ) s ON s.product_id = p.id`;

export function toCommerceProduct(row: Record<string, unknown>): CommerceProduct {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const images = Array.isArray(metadata.images) ? metadata.images : [];
  const cutout = metadata.cutout as { status?: string; src?: string } | undefined;
  const cash = BigInt(String(row.cash_price_rial ?? '0'));
  const installment = row.installment_price_rial === null || row.installment_price_rial === undefined ? null : BigInt(String(row.installment_price_rial));
  const installmentBase = installment ?? cash;
  const installmentEnabled = Boolean(row.installment_enabled);
  const discount = Number(row.discount_percent ?? 0);
  const compare = metadata.compareAtRial ? String(metadata.compareAtRial)
    : discount > 0 ? ((cash * 100n) / BigInt(100 - Math.min(discount, 95))).toString() : null;
  const createdAt = new Date(String(row.created_at));
  const flatLay = (row.flat_lay_media as string | null)
    ?? (cutout?.status === 'ready' && cutout.src && /^https?:\/\/|^\/api\/v1\/media\//.test(cutout.src) ? cutout.src : null);
  return {
    id: String(row.id), name: String(row.name), brand: String(row.brand), category: String(row.category),
    productType: (row.product_type_code as string | null) ?? null, gender: String(row.gender ?? 'unisex'),
    seasons: (row.seasons as string[]) ?? [], vibes: (row.vibes as string[]) ?? [],
    priceRial: cash.toString(), installmentPriceRial: installment?.toString() ?? null,
    // Server-side installment maths (Req 188-191): CMS/UI only render this value.
    perInstallmentRial: installmentEnabled && installmentBase > 0n ? ((installmentBase + 3n) / 4n).toString() : null,
    compareAtRial: compare, discountPercent: discount, installmentEnabled,
    installmentProviders: (row.installment_providers as string[]) ?? [],
    image: (row.hero_media as string | null) ?? mediaUrl(images[0]), flatLay,
    available: Number(row.available ?? 0), isNew: Date.now() - createdAt.getTime() < 30 * 86400_000,
    createdAt: createdAt.toISOString(), rating: Math.round(Number(row.avg_rating ?? 0) * 10) / 10,
    reviewCount: Number(row.review_count ?? 0),
    variants: ((row.variants as CommerceProduct['variants']) ?? []).map((v) => ({ ...v, available: Number(v.available ?? 0) })),
  };
}

export async function queryCommerceProducts(db: Queryable, rules: CollectionRules): Promise<CommerceProduct[]> {
  const { where, params, order, limit } = buildCollectionQuery(rules);
  const rows = await db.query(`${PRODUCT_SELECT} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`, params);
  return rows.rows.map(toCommerceProduct);
}

export async function commerceProductsByIds(db: Queryable, ids: string[]): Promise<CommerceProduct[]> {
  if (!ids.length) return [];
  const rows = await db.query(`${PRODUCT_SELECT} WHERE p.id = ANY($1::uuid[])`, [ids]);
  return rows.rows.map(toCommerceProduct);
}

/* ---------------- Product card rule engine (Req 192-195) ---------------- */

export type CardRule = { id: string; name: string; priority: number; conditions: Record<string, unknown>; template_code: string;
  active: boolean; starts_at: string | Date | null; ends_at: string | Date | null };

export function ruleMatches(product: Pick<CommerceProduct, 'discountPercent' | 'isNew' | 'installmentEnabled' | 'vibes' | 'category'> & { inActiveCampaign?: boolean }, conditions: Record<string, unknown>): boolean {
  if (conditions.minDiscountPercent !== undefined && product.discountPercent < Number(conditions.minDiscountPercent)) return false;
  if (conditions.isNew === true && !product.isNew) return false;
  if (conditions.installmentEnabled === true && !product.installmentEnabled) return false;
  if (conditions.inActiveCampaign === true && !product.inActiveCampaign) return false;
  if (typeof conditions.vibe === 'string' && !product.vibes.includes(conditions.vibe)) return false;
  if (typeof conditions.category === 'string' && product.category !== conditions.category) return false;
  return true;
}

/** Highest-priority (lowest number) active, in-window rule wins; falls back to kolbe-classic. */
export function resolveCardTemplate(product: Parameters<typeof ruleMatches>[0], rules: CardRule[], now = new Date()): string {
  const live = rules
    .filter((rule) => rule.active
      && (!rule.starts_at || new Date(rule.starts_at) <= now)
      && (!rule.ends_at || new Date(rule.ends_at) > now))
    .sort((a, b) => a.priority - b.priority);
  return live.find((rule) => ruleMatches(product, rule.conditions ?? {}))?.template_code ?? 'kolbe-classic';
}

export async function attachCardTemplates(db: Queryable, products: CommerceProduct[]): Promise<CommerceProduct[]> {
  if (!products.length) return products;
  const rules = (await db.query('SELECT * FROM cms_product_card_rules')).rows as CardRule[];
  const campaign = await db.query(`SELECT scope FROM festivals WHERE active AND starts_at <= now() AND ends_at >= now()`);
  const campaignProducts = new Set<string>();
  let campaignAll = false;
  for (const row of campaign.rows as { scope: { productIds?: string[] } }[]) {
    if (!row.scope?.productIds?.length) campaignAll = true;
    for (const id of row.scope?.productIds ?? []) campaignProducts.add(id);
  }
  return products.map((product) => ({
    ...product,
    cardTemplate: resolveCardTemplate({ ...product, inActiveCampaign: campaignAll || campaignProducts.has(product.id) }, rules),
  }));
}
