import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { commerceProductsByIds, queryCommerceProducts, styleCategoryOf, type CommerceProduct } from './commerce-view.js';

/* ======================= Style Intelligence — pure, deterministic, versioned =======================
   Hybrid scoring (Req 255): deterministic rules + product metadata + colour logic + category matrix.
   Optional vision/AI analysis only *adds* features through product_style_features (source = vision|hybrid);
   the score itself never depends on a free-form model answer, so it is stable and testable. */

export const SCORE_VERSION = 'v1';

type ColorInfo = { family: string; neutral: boolean; warm: boolean; label: string };
const COLOR_TABLE: [RegExp, ColorInfo][] = [
  [/مشکی|سیاه|black/i, { family: 'black', neutral: true, warm: false, label: 'مشکی' }],
  [/سفید|white|یخی/i, { family: 'white', neutral: true, warm: false, label: 'سفید' }],
  [/کرم|cream|استخوانی|بژ|beige|ivory/i, { family: 'cream', neutral: true, warm: true, label: 'کرم' }],
  [/شنی|sand|خاکی|khaki/i, { family: 'sand', neutral: true, warm: true, label: 'شنی' }],
  [/شتری|camel/i, { family: 'camel', neutral: true, warm: true, label: 'شتری' }],
  [/طوسی|خاکستری|grey|gray|ذغالی|زغالی|charcoal/i, { family: 'grey', neutral: true, warm: false, label: 'خاکستری' }],
  [/سرمه|navy/i, { family: 'navy', neutral: true, warm: false, label: 'سرمه‌ای' }],
  [/قهوه|brown|کاراملی|شکلاتی/i, { family: 'brown', neutral: false, warm: true, label: 'قهوه‌ای' }],
  [/زیتونی|olive|یشمی/i, { family: 'olive', neutral: false, warm: true, label: 'زیتونی' }],
  [/زرشکی|burgundy|شرابی/i, { family: 'burgundy', neutral: false, warm: true, label: 'زرشکی' }],
  [/صورتی|pink|گلبهی/i, { family: 'pink', neutral: false, warm: true, label: 'صورتی' }],
  [/قرمز|red/i, { family: 'red', neutral: false, warm: true, label: 'قرمز' }],
  [/نارنجی|orange|آجری|terra/i, { family: 'orange', neutral: false, warm: true, label: 'نارنجی' }],
  [/زرد|خردلی|yellow|mustard/i, { family: 'yellow', neutral: false, warm: true, label: 'زرد' }],
  [/سبز|green/i, { family: 'green', neutral: false, warm: false, label: 'سبز' }],
  [/آبی|blue|جین/i, { family: 'blue', neutral: false, warm: false, label: 'آبی' }],
  [/بنفش|purple|یاسی/i, { family: 'purple', neutral: false, warm: false, label: 'بنفش' }],
];

export function colorInfo(name: string): ColorInfo {
  for (const [pattern, info] of COLOR_TABLE) if (pattern.test(name)) return info;
  return { family: 'other', neutral: false, warm: false, label: name };
}

const pairKey = (a: string, b: string) => [a, b].sort().join('+');
const GOOD_PAIRS: Record<string, number> = {
  [pairKey('pink', 'cream')]: 98, [pairKey('pink', 'navy')]: 94, [pairKey('pink', 'grey')]: 93,
  [pairKey('navy', 'cream')]: 97, [pairKey('navy', 'camel')]: 96, [pairKey('navy', 'white')]: 96,
  [pairKey('burgundy', 'camel')]: 95, [pairKey('burgundy', 'cream')]: 94, [pairKey('burgundy', 'navy')]: 90,
  [pairKey('olive', 'cream')]: 95, [pairKey('olive', 'brown')]: 93, [pairKey('olive', 'sand')]: 92,
  [pairKey('brown', 'cream')]: 96, [pairKey('brown', 'blue')]: 91, [pairKey('black', 'white')]: 95,
  [pairKey('green', 'cream')]: 92, [pairKey('blue', 'cream')]: 93, [pairKey('blue', 'white')]: 94,
};
const CLASH_PAIRS: Record<string, number> = {
  [pairKey('red', 'pink')]: 55, [pairKey('red', 'orange')]: 58, [pairKey('green', 'red')]: 50, [pairKey('purple', 'orange')]: 52,
  [pairKey('yellow', 'purple')]: 55, [pairKey('pink', 'orange')]: 60, [pairKey('black', 'navy')]: 72, [pairKey('brown', 'black')]: 70,
};

export function colorPairScore(a: string, b: string): number {
  const ca = colorInfo(a), cb = colorInfo(b);
  const key = pairKey(ca.family, cb.family);
  if (GOOD_PAIRS[key]) return GOOD_PAIRS[key]!;
  if (CLASH_PAIRS[key]) return CLASH_PAIRS[key]!;
  if (ca.family === cb.family) return ca.neutral ? 86 : 80; // tonal
  if (ca.neutral || cb.neutral) return 90;
  return ca.warm === cb.warm ? 78 : 70;
}

export type FashionFeatures = {
  dominantColors: string[]; productType: string; vibes: string[]; seasons: string[]; formality: number;
  pattern: 'solid' | 'striped' | 'checked' | 'printed'; fit: 'regular' | 'relaxed' | 'slim'; visualWeight: 'light' | 'medium' | 'heavy';
};

const FORMALITY: Record<string, number> = { coat: 0.8, shirt: 0.7, trousers: 0.65, shoes: 0.72, knitwear: 0.5, accessory: 0.6 };

/** Deterministic feature extraction from the canonical product (Req 249-250). */
export function deriveFeatures(product: Pick<CommerceProduct, 'name' | 'category' | 'productType' | 'vibes' | 'seasons' | 'variants'> & { specifications?: Record<string, unknown> }): FashionFeatures {
  const category = styleCategoryOf(product.category, product.productType);
  const colors = [...new Set(product.variants.map((v) => v.color).filter((c): c is string => Boolean(c)))];
  const specs = product.specifications ?? {};
  const text = `${product.name} ${String(specs.pattern ?? '')} ${String(specs.fit ?? '')}`;
  let formality = FORMALITY[category] ?? 0.6;
  if (product.vibes.some((v) => ['old-money', 'classic', 'quiet-luxury'].includes(v))) formality += 0.1;
  if (product.vibes.includes('streetwear')) formality -= 0.3;
  if (product.vibes.includes('workwear')) formality -= 0.15;
  if (/هودی|تی‌شرت|کتانی|جین/.test(product.name)) formality -= 0.2;
  if (/بلیزر|کت رسمی|آکسفورد|لوفر|فاستونی/.test(product.name)) formality += 0.1;
  const pattern = /چهارخانه|check|plaid/i.test(text) ? 'checked' : /راه‌راه|راه راه|stripe/i.test(text) ? 'striped' : /طرح‌دار|print|گل‌دار/i.test(text) ? 'printed' : 'solid';
  const fit = /oversize|relaxed|گشاد|آزاد/i.test(text) ? 'relaxed' : /slim|tailored|جذب/i.test(text) ? 'slim' : 'regular';
  return {
    dominantColors: colors.slice(0, 3), productType: category, vibes: product.vibes, seasons: product.seasons,
    formality: Math.round(Math.min(1, Math.max(0, formality)) * 100) / 100, pattern, fit,
    visualWeight: category === 'coat' || /پشم|چرم|پالتو/.test(product.name) ? 'heavy' : category === 'accessory' ? 'light' : 'medium',
  };
}

export type MatrixRow = { category_a: string; category_b: string; compatible: boolean; score_weight: number; reason?: string };
export type ScoredItem = { id: string; name: string; category: string; features: FashionFeatures; color?: string | null };
export type ScoreResult = {
  scoreVersion: string; total: number; valid: boolean; issues: string[];
  breakdown: { colorHarmony: number; vibeMatch: number; seasonMatch: number; formalityMatch: number; silhouetteBalance: number; categoryCompatibility: number; patternCompatibility: number };
  explanation: string; derivedVibes: string[];
};

const WEIGHTS = { colorHarmony: 0.26, vibeMatch: 0.18, seasonMatch: 0.12, formalityMatch: 0.14, silhouetteBalance: 0.08, categoryCompatibility: 0.14, patternCompatibility: 0.08 };
const VIBE_LABEL: Record<string, string> = { 'old-money': 'Old Money', 'dark-academia': 'Dark Academia', 'quiet-luxury': 'Quiet Luxury', vintage: 'Vintage', minimal: 'Minimal', streetwear: 'Streetwear', workwear: 'Workwear', y2k: 'Y2K', classic: 'Classic' };

function matrixLookup(matrix: MatrixRow[], a: string, b: string): MatrixRow | null {
  return matrix.find((row) => (row.category_a === a && row.category_b === b) || (row.category_a === b && row.category_b === a)) ?? null;
}

/** Outfit Compatibility Score with full breakdown & Persian explanation (Req 253-256). */
export function scoreOutfit(items: ScoredItem[], matrix: MatrixRow[]): ScoreResult {
  const issues: string[] = [];
  if (items.length < 2) {
    return { scoreVersion: SCORE_VERSION, total: 0, valid: false, issues: ['برای محاسبه امتیاز دست‌کم دو آیتم لازم است.'],
      breakdown: { colorHarmony: 0, vibeMatch: 0, seasonMatch: 0, formalityMatch: 0, silhouetteBalance: 0, categoryCompatibility: 0, patternCompatibility: 0 },
      explanation: '', derivedVibes: [] };
  }
  const pairs: [ScoredItem, ScoredItem][] = [];
  for (let i = 0; i < items.length; i += 1) for (let j = i + 1; j < items.length; j += 1) pairs.push([items[i]!, items[j]!]);
  const colorOf = (item: ScoredItem) => item.color ?? item.features.dominantColors[0] ?? '';
  const colorScores = pairs.map(([a, b]) => (colorOf(a) && colorOf(b) ? colorPairScore(colorOf(a), colorOf(b)) : 82));
  const colorHarmony = Math.round(colorScores.reduce((s, v) => s + v, 0) / colorScores.length);

  const vibeCounts = new Map<string, number>();
  for (const item of items) for (const vibe of new Set(item.features.vibes)) vibeCounts.set(vibe, (vibeCounts.get(vibe) ?? 0) + 1);
  const [topVibe, topCount] = [...vibeCounts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const vibeMatch = items.every((i) => i.features.vibes.length === 0) ? 80 : Math.round(55 + 45 * (topCount / items.length));

  const seasonSets = items.map((i) => new Set(i.features.seasons.includes('all-season') ? ['spring', 'summer', 'autumn', 'winter'] : i.features.seasons));
  const sharedSeasons = ['spring', 'summer', 'autumn', 'winter'].filter((s) => seasonSets.every((set) => set.size === 0 || set.has(s)));
  const seasonMatch = sharedSeasons.length ? 100 : 60;
  if (!sharedSeasons.length) issues.push('آیتم‌ها فصل مشترکی ندارند.');

  const formalities = items.map((i) => i.features.formality);
  const spread = Math.max(...formalities) - Math.min(...formalities);
  const formalityMatch = Math.round(Math.max(40, 100 - spread * 120));
  if (spread > 0.35) issues.push('سطح رسمی بودن آیتم‌ها با هم فاصله زیادی دارد.');

  const relaxed = items.filter((i) => i.features.fit === 'relaxed').length;
  const heavy = items.filter((i) => i.features.visualWeight === 'heavy').length;
  const silhouetteBalance = Math.round(100 - (relaxed === items.length && items.length > 1 ? 25 : 0) - (heavy > 2 ? 15 : 0));

  let categoryInvalid = false;
  const categoryScores = pairs.map(([a, b]) => {
    const row = matrixLookup(matrix, a.category, b.category);
    if (row && !row.compatible) { categoryInvalid = true; issues.push(row.reason || `ترکیب ${a.name} و ${b.name} معتبر نیست.`); }
    if (!row && a.category === b.category) { categoryInvalid = true; issues.push(`دو آیتم از دسته «${a.category}» در یک استایل قرار گرفته‌اند.`); return 20; }
    return row ? row.score_weight : 85;
  });
  const categoryCompatibility = Math.round(categoryScores.reduce((s, v) => s + v, 0) / categoryScores.length);

  const patterned = items.filter((i) => i.features.pattern !== 'solid').length;
  const patternCompatibility = patterned <= 1 ? 100 : patterned === 2 ? 72 : 50;
  if (patterned >= 2) issues.push('بیش از یک آیتم طرح‌دار است؛ تعادل بصری کم می‌شود.');

  const breakdown = { colorHarmony, vibeMatch, seasonMatch, formalityMatch, silhouetteBalance, categoryCompatibility, patternCompatibility };
  let total = Math.round(Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + breakdown[key as keyof typeof breakdown] * weight, 0));
  if (categoryInvalid) total = Math.min(total, 40);

  const colors = [...new Set(items.map(colorOf).filter(Boolean).map((c) => colorInfo(c).label))];
  const parts: string[] = [];
  if (colors.length >= 2) parts.push(colorHarmony >= 90 ? `ترکیب ${colors.join(' و ')} کنتراست ملایم و هماهنگی بسیار خوبی ایجاد می‌کند` : colorHarmony >= 78 ? `رنگ‌های ${colors.join(' و ')} هماهنگی قابل قبولی دارند` : `رنگ‌های ${colors.join(' و ')} با هم رقابت می‌کنند`);
  if (topVibe && topCount >= 2) parts.push(`${topCount === items.length ? 'همه آیتم‌ها' : `${topCount} آیتم`} با استایل ${VIBE_LABEL[topVibe] ?? topVibe} سازگارند`);
  if (sharedSeasons.length) parts.push(`برای ${sharedSeasons.map((s) => ({ spring: 'بهار', summer: 'تابستان', autumn: 'پاییز', winter: 'زمستان' })[s]).join('، ')} مناسب است`);
  const explanation = `${parts.join('؛ ')}.${issues.length ? ` نکته: ${issues[0]}` : ''}`;
  return { scoreVersion: SCORE_VERSION, total, valid: !categoryInvalid, issues, breakdown, explanation,
    derivedVibes: topVibe && topCount >= 2 ? [topVibe] : [] };
}

const LOOK_ORDER = ['coat', 'knitwear', 'shirt', 'trousers', 'shoes', 'accessory'];

/* ======================= DB helpers ======================= */

async function loadMatrix(db: DbPool | PoolClient): Promise<MatrixRow[]> {
  return (await db.query('SELECT category_a, category_b, compatible, score_weight, reason FROM style_category_matrix')).rows as MatrixRow[];
}

async function featuresFor(db: DbPool | PoolClient, products: CommerceProduct[]): Promise<Map<string, FashionFeatures>> {
  const stored = await db.query('SELECT product_id, features FROM product_style_features WHERE product_id = ANY($1::uuid[])', [products.map((p) => p.id)]);
  const map = new Map<string, FashionFeatures>();
  const specs = await db.query('SELECT id, specifications FROM products WHERE id = ANY($1::uuid[])', [products.map((p) => p.id)]);
  const specMap = new Map((specs.rows as { id: string; specifications: Record<string, unknown> }[]).map((r) => [r.id, r.specifications]));
  for (const product of products) {
    const derived = deriveFeatures({ ...product, specifications: specMap.get(product.id) ?? {} });
    const row = (stored.rows as { product_id: string; features: Partial<FashionFeatures> }[]).find((r) => r.product_id === product.id);
    map.set(product.id, { ...derived, ...(row?.features ?? {}) });
  }
  return map;
}

const toScored = (product: CommerceProduct, features: FashionFeatures, color?: string | null): ScoredItem =>
  ({ id: product.id, name: product.name, category: features.productType, features, color: color ?? null });

async function analyzeProduct(client: PoolClient, productId: string) {
  const [product] = await commerceProductsByIds(client, [productId]);
  if (!product) throw notFound();
  const spec = await one<{ specifications: Record<string, unknown> }>(client, 'SELECT specifications FROM products WHERE id = $1', [productId]);
  const features = deriveFeatures({ ...product, specifications: spec?.specifications ?? {} });
  await client.query(`INSERT INTO product_style_features(product_id, feature_version, features, model_version, source, confidence, generated_at)
    VALUES ($1,'v1',$2,'kolbe-deterministic-v1','deterministic',0.85,now())
    ON CONFLICT (product_id) DO UPDATE SET features = CASE WHEN product_style_features.source IN ('vision','manual') THEN product_style_features.features || $2 ELSE $2 END,
      generated_at = now(), feature_version = 'v1'`, [productId, JSON.stringify(features)]);
  await outbox(client, 'product.style_analysis_completed', 'product', productId, { productId, features, source: 'deterministic' });
  return features;
}

export async function processStyleAnalysisEvents(pool: DbPool, limit = 20) {
  const rows = await pool.query(`SELECT id, aggregate_id FROM outbox_events WHERE event_type = 'product.style_analysis_requested'
    AND NOT EXISTS (SELECT 1 FROM product_style_features f WHERE f.product_id::text = outbox_events.aggregate_id AND f.generated_at >= outbox_events.created_at)
    ORDER BY created_at LIMIT $1`, [limit]);
  let processed = 0;
  for (const row of rows.rows as { aggregate_id: string }[]) {
    try { await transaction(pool, (client) => analyzeProduct(client, row.aggregate_id)); processed += 1; } catch { /* product removed */ }
  }
  return processed;
}

/* ======================= Routes ======================= */

const shareCode = () => randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 7);
const styleItems = z.array(z.object({
  productId: z.uuid(), variantId: z.uuid().nullable().optional(), x: z.number().min(0).max(100).default(50), y: z.number().min(0).max(100).default(50),
  scale: z.number().min(0.3).max(2).default(1), z: z.number().int().min(-100).max(1000).default(1),
}).strict()).min(1).max(12);

export function registerStyleRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const optionalUser = async (request: Parameters<typeof principal>[0]): Promise<Principal | null> => {
    try { return await principal(request, pool, config); } catch { return null; }
  };

  /** Style Builder catalogue: canonical products + flat-lay media from Product Media Domain (Req 315, 319). */
  app.get('/api/v1/style/catalog', async () => {
    const products = await queryCommerceProducts(pool, { limit: 48, sortBy: 'newest' });
    const features = await featuresFor(pool, products);
    return { items: products.filter((p) => Number(p.priceRial) > 0).map((p) => ({ ...p, styleCategory: features.get(p.id)!.productType, features: features.get(p.id) })) };
  });

  app.post('/api/v1/style/score', async (request) => {
    const body = z.object({ items: z.array(z.object({ productId: z.uuid(), color: z.string().max(60).nullable().optional() }).strict()).min(1).max(12) }).strict().parse(request.body);
    const products = await commerceProductsByIds(pool, body.items.map((i) => i.productId));
    if (products.length !== new Set(body.items.map((i) => i.productId)).size) throw badRequest('برخی از محصولات یافت نشدند.');
    const [features, matrix] = await Promise.all([featuresFor(pool, products), loadMatrix(pool)]);
    const scored = body.items.map((item) => { const p = products.find((x) => x.id === item.productId)!; return toScored(p, features.get(p.id)!, item.color); });
    const result = scoreOutfit(scored, matrix);

    // Style Recommendation (Req 257, 260): if weak, propose in-stock replacements that raise the score.
    const suggestions: { replaceProductId: string; replaceName: string; candidate: CommerceProduct; newScore: number }[] = [];
    if (result.total < 85 && scored.length >= 2) {
      const pool2 = await queryCommerceProducts(pool, { inStockOnly: true, limit: 48, sortBy: 'popular' });
      const candFeatures = await featuresFor(pool, pool2);
      for (const target of scored) {
        let best: { candidate: CommerceProduct; score: number } | null = null;
        for (const candidate of pool2) {
          if (scored.some((s) => s.id === candidate.id)) continue;
          const f = candFeatures.get(candidate.id)!;
          if (f.productType !== target.category) continue;
          const trial = scoreOutfit(scored.map((s) => (s.id === target.id ? toScored(candidate, f) : s)), matrix);
          if (trial.total > result.total + 3 && (!best || trial.total > best.score)) best = { candidate, score: trial.total };
        }
        if (best) suggestions.push({ replaceProductId: target.id, replaceName: target.name, candidate: best.candidate, newScore: best.score });
      }
      suggestions.sort((a, b) => b.newScore - a.newScore);
    }
    return { ...result, suggestions: suggestions.slice(0, 3) };
  });

  /** Complete the look from real, in-stock inventory (Req 258, 260-261). */
  app.post('/api/v1/style/complete-look', async (request) => {
    const body = z.object({ productIds: z.array(z.uuid()).min(1).max(6) }).strict().parse(request.body);
    const user = await optionalUser(request);
    const anchors = await commerceProductsByIds(pool, body.productIds);
    if (!anchors.length) throw notFound();
    const candidates = await queryCommerceProducts(pool, { inStockOnly: true, limit: 48, sortBy: 'popular' });
    const [features, matrix] = await Promise.all([featuresFor(pool, [...anchors, ...candidates]), loadMatrix(pool)]);
    let preferred = new Set<string>();
    if (user) {
      const history = await pool.query(`SELECT DISTINCT unnest(p.vibes) AS vibe FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN products p ON p.id = ol.product_id
        WHERE o.buyer_id = $1 AND o.status <> 'cancelled' UNION SELECT unnest(derived_vibes) FROM saved_styles WHERE user_id = $1`, [user.id]);
      preferred = new Set((history.rows as { vibe: string }[]).map((r) => r.vibe));
    }
    const look: ScoredItem[] = anchors.map((p) => toScored(p, features.get(p.id)!));
    const added: CommerceProduct[] = [];
    for (const category of LOOK_ORDER) {
      if (look.some((item) => item.category === category)) continue;
      let best: { product: CommerceProduct; score: number } | null = null;
      for (const candidate of candidates) {
        const f = features.get(candidate.id)!;
        if (f.productType !== category || look.some((i) => i.id === candidate.id)) continue;
        const bonus = f.vibes.some((v) => preferred.has(v)) ? 3 : 0;
        const score = scoreOutfit([...look, toScored(candidate, f)], matrix).total + bonus;
        if (!best || score > best.score) best = { product: candidate, score };
      }
      if (best && best.score >= 70) { look.push(toScored(best.product, features.get(best.product.id)!)); added.push(best.product); }
    }
    return { anchors, added, score: scoreOutfit(look, matrix) };
  });

  /** Style add-to-cart validation (Req 264-265): variant, stock, current price, active, channel. */
  app.post('/api/v1/style/validate', async (request) => {
    const body = z.object({ items: z.array(z.object({ productId: z.uuid(), variantId: z.uuid().nullable().optional(), quantity: z.number().int().min(1).max(10).default(1) }).strict()).min(1).max(12) }).strict().parse(request.body);
    const rows = await pool.query(`SELECT p.id, p.name, p.status, p.supplier_id, p.cash_price_rial::text AS price FROM products p WHERE p.id = ANY($1::uuid[])`, [body.items.map((i) => i.productId)]);
    const products = await commerceProductsByIds(pool, body.items.map((i) => i.productId));
    const results = [];
    let bundle = 0n;
    for (const item of body.items) {
      const row = (rows.rows as { id: string; name: string; status: string; supplier_id: string | null; price: string }[]).find((r) => r.id === item.productId);
      const product = products.find((p) => p.id === item.productId);
      let reason: string | null = null;
      let variant = product?.variants.find((v) => v.id === item.variantId) ?? null;
      if (!row || !product) reason = 'محصول یافت نشد.';
      else if (row.status !== 'published') reason = 'محصول فعال نیست.';
      else if (row.supplier_id) reason = 'این محصول فقط در بازارچه عمده عرضه می‌شود.';
      else if (BigInt(row.price) <= 0n) reason = 'قیمت خرده برای این محصول تعریف نشده است.';
      else {
        if (!variant) variant = product.variants.filter((v) => v.available >= item.quantity).sort((a, b) => b.available - a.available)[0] ?? null;
        if (!variant) reason = 'هیچ سایز/رنگی از این محصول موجود نیست.';
        else if (variant.available < item.quantity) reason = `سایز ${variant.size ?? '—'} دیگر موجود نیست.`;
      }
      if (!reason && row) bundle += BigInt(row.price) * BigInt(item.quantity);
      let alternatives: CommerceProduct[] = [];
      if (reason && product) {
        const f = (await featuresFor(pool, [product])).get(product.id)!;
        alternatives = (await queryCommerceProducts(pool, { inStockOnly: true, category: product.category, limit: 4 })).filter((p) => p.id !== product.id);
        if (!alternatives.length) alternatives = (await queryCommerceProducts(pool, { inStockOnly: true, productType: f.productType, limit: 4 })).filter((p) => p.id !== product.id);
      }
      results.push({ productId: item.productId, name: row?.name ?? '—', purchasable: !reason, reason, variant, unitPriceRial: row?.price ?? '0', quantity: item.quantity, alternatives: alternatives.slice(0, 3) });
    }
    const ok = results.filter((r) => r.purchasable).length;
    const fa = (n: number) => n.toLocaleString('fa-IR');
    return { items: results, purchasableCount: ok, total: results.length, bundlePriceRial: bundle.toString(),
      message: ok === results.length ? 'همه آیتم‌های استایل قابل خرید هستند.' : `${fa(ok)} از ${fa(results.length)} آیتم قابل خرید هستند.` };
  });

  /* ---------- Saved styles (Req 266-269, 318, 348) ---------- */
  const computeForSave = async (items: z.infer<typeof styleItems>) => {
    const products = await commerceProductsByIds(pool, items.map((i) => i.productId));
    const [features, matrix] = await Promise.all([featuresFor(pool, products), loadMatrix(pool)]);
    const scored = items.map((i) => products.find((p) => p.id === i.productId)).filter((p): p is CommerceProduct => Boolean(p)).map((p) => toScored(p, features.get(p.id)!));
    const score = scored.length >= 2 ? scoreOutfit(scored, matrix) : null;
    const bundle = products.reduce((sum, p) => sum + BigInt(p.priceRial), 0n);
    return { score, bundle };
  };

  app.get('/api/v1/styles', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query('SELECT * FROM saved_styles WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100', [user.id]);
    const ids = [...new Set((rows.rows as { items: { productId: string }[] }[]).flatMap((r) => r.items.map((i) => i.productId)))];
    const products = await commerceProductsByIds(pool, ids);
    // Price shown is always the *current* Pricing value, not the one at save time (Req 265).
    return { items: rows.rows.map((row: Record<string, unknown>) => {
      const its = (row.items as { productId: string }[]);
      const current = its.map((i) => products.find((p) => p.id === i.productId)).filter(Boolean) as CommerceProduct[];
      return { ...row, products: current, currentBundlePriceRial: current.reduce((s, p) => s + BigInt(p.priceRial), 0n).toString(),
        allAvailable: current.length === its.length && current.every((p) => p.available > 0) };
    }) };
  });

  app.post('/api/v1/styles', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({ name: z.string().trim().min(1).max(120), items: styleItems, privacy: z.enum(['private', 'unlisted', 'public']).default('private'),
      previewDataUrl: z.string().max(900_000).regex(/^data:image\/(png|jpeg);base64,/).nullable().optional() }).strict().parse(request.body);
    const { score, bundle } = await computeForSave(body.items);
    const id = randomUUID(); const code = shareCode();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO saved_styles(id,user_id,share_code,name,privacy,items,score,score_version,score_breakdown,explanation,bundle_price_rial,preview_data_url,derived_vibes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, user.id, code, body.name, body.privacy, JSON.stringify(body.items), score?.total ?? 0, SCORE_VERSION, JSON.stringify(score?.breakdown ?? {}),
          score?.explanation ?? '', bundle.toString(), body.previewDataUrl ?? null, score?.derivedVibes ?? []]);
      await client.query('INSERT INTO saved_style_versions(id,style_id,version,name,items,score,score_version) VALUES ($1,$2,1,$3,$4,$5,$6)',
        [randomUUID(), id, body.name, JSON.stringify(body.items), score?.total ?? 0, SCORE_VERSION]);
      await outbox(client, 'style.saved', 'saved_style', id, { styleId: id, userId: user.id, score: score?.total ?? 0, derivedVibes: score?.derivedVibes ?? [] });
    });
    return reply.code(201).send({ id, shareCode: code, score: score?.total ?? 0 });
  });

  app.patch('/api/v1/styles/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), items: styleItems.optional(), privacy: z.enum(['private', 'unlisted', 'public']).optional(),
      previewDataUrl: z.string().max(900_000).regex(/^data:image\/(png|jpeg);base64,/).nullable().optional() }).strict().parse(request.body);
    // Scoring reads the catalogue through the pool, so it runs before the row lock is taken.
    const computed = body.items ? await computeForSave(body.items) : null;
    return transaction(pool, async (client) => {
      const current = await one<{ user_id: string; version: number; name: string; items: unknown }>(client, 'SELECT * FROM saved_styles WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw notFound();
      if (current.user_id !== user.id) throw forbidden();
      const version = body.items || body.name ? current.version + 1 : current.version;
      await client.query(`UPDATE saved_styles SET name = COALESCE($2,name), items = COALESCE($3,items), privacy = COALESCE($4,privacy),
          score = COALESCE($5,score), score_breakdown = COALESCE($6,score_breakdown), explanation = COALESCE($7,explanation),
          bundle_price_rial = COALESCE($8,bundle_price_rial), preview_data_url = CASE WHEN $9::boolean THEN $10 ELSE preview_data_url END,
          derived_vibes = COALESCE($11,derived_vibes), version = $12, updated_at = now() WHERE id = $1`,
        [id, body.name ?? null, body.items ? JSON.stringify(body.items) : null, body.privacy ?? null, computed?.score?.total ?? null,
          computed?.score ? JSON.stringify(computed.score.breakdown) : null, computed?.score?.explanation ?? null, computed?.bundle.toString() ?? null,
          body.previewDataUrl !== undefined, body.previewDataUrl ?? null, computed?.score?.derivedVibes ?? null, version]);
      if (version !== current.version) {
        await client.query('INSERT INTO saved_style_versions(id,style_id,version,name,items,score,score_version) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), id, version, body.name ?? current.name, JSON.stringify(body.items ?? current.items), computed?.score?.total ?? 0, SCORE_VERSION]);
      }
      if (body.privacy && body.privacy !== 'private') await outbox(client, 'style.shared', 'saved_style', id, { styleId: id, privacy: body.privacy });
      return one(client, 'SELECT * FROM saved_styles WHERE id = $1', [id]);
    });
  });

  app.delete('/api/v1/styles/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query('DELETE FROM saved_styles WHERE id = $1 AND user_id = $2 RETURNING id', [id, user.id]);
    if (!res.rowCount) throw notFound();
    return { id, deleted: true };
  });

  app.get('/api/v1/styles/:id/versions', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const owner = await one<{ user_id: string }>(pool, 'SELECT user_id FROM saved_styles WHERE id = $1', [id]);
    if (!owner || owner.user_id !== user.id) throw notFound();
    return { items: (await pool.query('SELECT version, name, items, score, score_version, created_at FROM saved_style_versions WHERE style_id = $1 ORDER BY version DESC', [id])).rows };
  });

  app.get('/api/v1/styles/shared/:code', async (request) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Z0-9]{5,10}$/) }).parse(request.params);
    const row = await one<Record<string, unknown> & { items: { productId: string }[]; privacy: string }>(pool,
      `SELECT s.id, s.name, s.items, s.score, s.score_breakdown, s.explanation, s.privacy, s.preview_data_url, s.updated_at, u.display_name AS owner_name
       FROM saved_styles s JOIN users u ON u.id = s.user_id WHERE s.share_code = $1`, [code]);
    if (!row || row.privacy === 'private') throw notFound();
    return { ...row, products: await commerceProductsByIds(pool, row.items.map((i) => i.productId)) };
  });

  app.post('/api/v1/styles/events', async (request, reply) => {
    const user = await optionalUser(request);
    const body = z.object({ type: z.enum(['style.created', 'style.purchased', 'style.shared']), styleId: z.uuid().optional(), productIds: z.array(z.uuid()).max(12).default([]) }).strict().parse(request.body);
    await transaction(pool, (client) => outbox(client, body.type, 'saved_style', body.styleId ?? randomUUID(), { ...body, userId: user?.id ?? null }));
    return reply.code(202).send({ accepted: true });
  });

  /* ---------- Admin: matrix & analysis (Req 252, 259) ---------- */
  app.get('/api/v1/admin/style/matrix', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'style:manage');
    return { items: (await pool.query('SELECT * FROM style_category_matrix ORDER BY category_a, category_b')).rows, categories: LOOK_ORDER };
  });

  app.put('/api/v1/admin/style/matrix', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'style:manage');
    const body = z.object({ categoryA: z.enum(LOOK_ORDER as [string, ...string[]]), categoryB: z.enum(LOOK_ORDER as [string, ...string[]]),
      compatible: z.boolean(), scoreWeight: z.number().int().min(0).max(100), reason: z.string().trim().max(300).default('') }).strict().parse(request.body);
    const [a, b] = [body.categoryA, body.categoryB].sort();
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM style_category_matrix WHERE (category_a = $1 AND category_b = $2) OR (category_a = $2 AND category_b = $1)', [a, b]);
      await client.query('DELETE FROM style_category_matrix WHERE (category_a = $1 AND category_b = $2) OR (category_a = $2 AND category_b = $1)', [a, b]);
      await client.query('INSERT INTO style_category_matrix(id,category_a,category_b,compatible,score_weight,reason,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), a, b, body.compatible, body.scoreWeight, body.reason, user.id]);
      await audit(client, user.id, 'style.matrix_updated', 'style_matrix', `${a}+${b}`, before ?? undefined, body, request.ip);
      return { categoryA: a, categoryB: b, compatible: body.compatible, scoreWeight: body.scoreWeight };
    });
  });

  app.post('/api/v1/admin/style/analyze/:productId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'style:manage');
    const { productId } = z.object({ productId: z.uuid() }).parse(request.params);
    const features = await transaction(pool, async (client) => {
      await outbox(client, 'product.style_analysis_requested', 'product', productId, { productId, requestedBy: user.id });
      return analyzeProduct(client, productId);
    });
    return { productId, features, scoreVersion: SCORE_VERSION };
  });

  app.post('/api/v1/admin/style/analyze-pending', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'style:manage');
    return { processed: await processStyleAnalysisEvents(pool, 50) };
  });

  /* ---------- Product media roles (Req 306-308, 315-317) ---------- */
  app.get('/api/v1/products/:id/media', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ status: string }>(pool, 'SELECT status FROM products WHERE id = $1', [id]);
    if (!product || product.status !== 'published') throw notFound();
    return { items: (await pool.query('SELECT id, variant_id, role, url, cutout_url, mime_type, alt_text, position, pipeline_status FROM product_media WHERE product_id = $1 ORDER BY role, position', [id])).rows };
  });

  app.post('/api/v1/admin/products/:id/media', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      fileId: z.uuid().optional(), url: z.string().regex(/^https:\/\/[^\s<>"]+$/).optional(),
      role: z.enum(['hero', 'gallery', 'flat_lay', 'on_model', 'detail', 'size_guide', 'video']), variantId: z.uuid().nullable().optional(),
      altText: z.string().trim().max(300).default(''), position: z.number().int().min(0).max(100).default(0),
      cutoutUrl: z.string().max(400).nullable().optional(),
    }).strict().refine((v) => v.fileId || v.url, 'فایل یا نشانی لازم است.').parse(request.body);
    const product = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    if (!(product.supplier_id === user.id && user.roles.includes('supplier'))) requirePermission(user, 'products:write');
    let mime: string | null = null;
    if (body.fileId) {
      const file = await one<{ mime_type: string; owner_id: string }>(pool, 'SELECT mime_type, owner_id FROM files WHERE id = $1', [body.fileId]);
      if (!file) throw badRequest('فایل یافت نشد.');
      mime = file.mime_type;
      if (body.role === 'video' ? !mime.startsWith('video/') : !mime.startsWith('image/')) throw badRequest('نوع فایل با نقش رسانه سازگار نیست.');
    }
    const mediaId = randomUUID();
    const url = body.fileId ? `/api/v1/media/${body.fileId}` : body.url!;
    await transaction(pool, async (client) => {
      if (body.variantId) {
        const variant = await one(client, 'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [body.variantId, id]);
        if (!variant) throw badRequest('واریانت متعلق به این محصول نیست.');
      }
      await client.query(`INSERT INTO product_media(id,product_id,variant_id,file_id,role,url,cutout_url,mime_type,alt_text,position,pipeline_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [mediaId, id, body.variantId ?? null, body.fileId ?? null, body.role, url, body.cutoutUrl ?? null, mime, body.altText, body.position,
          body.role === 'flat_lay' && !body.cutoutUrl ? 'uploaded' : 'ready']);
      await audit(client, user.id, 'product.media_added', 'product', id, undefined, { mediaId, role: body.role }, request.ip);
      // Automation media pipeline (Req 317): n8n picks this up for background removal / analysis / derivatives.
      await outbox(client, 'media.uploaded', 'product_media', mediaId, { productId: id, mediaId, role: body.role, url });
      await outbox(client, 'product.style_analysis_requested', 'product', id, { productId: id, reason: 'media.uploaded' });
    });
    return reply.code(201).send({ id: mediaId, url });
  });

  app.delete('/api/v1/admin/products/:productId/media/:mediaId', async (request) => {
    const user = await principal(request, pool, config);
    const { productId, mediaId } = z.object({ productId: z.uuid(), mediaId: z.uuid() }).parse(request.params);
    const product = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [productId]);
    if (!product) throw notFound();
    if (!(product.supplier_id === user.id && user.roles.includes('supplier'))) requirePermission(user, 'products:write');
    const res = await pool.query('DELETE FROM product_media WHERE id = $1 AND product_id = $2 RETURNING id', [mediaId, productId]);
    if (!res.rowCount) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'product.media_removed', 'product', productId, { mediaId }, undefined, request.ip));
    return { id: mediaId, deleted: true };
  });

  /* ---------- Customer reviews (Req 240, 349) ---------- */
  app.get('/api/v1/products/:id/reviews', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const summary = await one<{ average: number; total: number }>(pool, `SELECT COALESCE(AVG(rating),0)::float AS average, COUNT(*)::int AS total
      FROM customer_reviews WHERE product_id = $1 AND status = 'approved'`, [id]);
    const distribution = await pool.query(`SELECT rating, COUNT(*)::int AS n FROM customer_reviews WHERE product_id = $1 AND status = 'approved' GROUP BY rating`, [id]);
    const items = await pool.query(`SELECT r.id, r.rating, r.title, r.body, r.verified_purchase, r.created_at, u.display_name
      FROM customer_reviews r JOIN users u ON u.id = r.user_id WHERE r.product_id = $1 AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 30`, [id]);
    return { summary: { average: Math.round((summary?.average ?? 0) * 10) / 10, total: summary?.total ?? 0, distribution: distribution.rows }, items: items.rows };
  });

  app.post('/api/v1/products/:id/reviews', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ rating: z.number().int().min(1).max(5), title: z.string().trim().max(120).default(''), body: z.string().trim().max(3000).default('') }).strict().parse(request.body);
    const product = await one(pool, `SELECT id FROM products WHERE id = $1 AND status = 'published'`, [id]);
    if (!product) throw notFound();
    const purchase = await one<{ order_id: string }>(pool, `SELECT o.id AS order_id FROM orders o JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.buyer_id = $1 AND ol.product_id = $2 AND o.status IN ('paid','processing','preparing','ready_to_ship','in_transit','shipped','delivered')
      ORDER BY o.created_at DESC LIMIT 1`, [user.id, id]);
    const reviewId = randomUUID();
    const status = purchase ? 'approved' : 'pending';
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO customer_reviews(id,product_id,user_id,order_id,rating,title,body,verified_purchase,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (product_id, user_id) DO UPDATE SET rating = $5, title = $6, body = $7, created_at = now(),
          status = CASE WHEN customer_reviews.verified_purchase THEN 'approved' ELSE 'pending' END`,
        [reviewId, id, user.id, purchase?.order_id ?? null, body.rating, body.title, body.body, Boolean(purchase), status]);
      await outbox(client, 'review.submitted', 'product', id, { productId: id, userId: user.id, rating: body.rating, verified: Boolean(purchase) });
    });
    return reply.code(201).send({ status, verifiedPurchase: Boolean(purchase) });
  });

  app.get('/api/v1/me/reviews', async (request) => {
    const user = await principal(request, pool, config);
    const mine = await pool.query(`SELECT r.id, r.product_id, r.rating, r.title, r.body, r.status, r.verified_purchase, r.created_at, p.name AS product_name
      FROM customer_reviews r JOIN products p ON p.id = r.product_id WHERE r.user_id = $1 ORDER BY r.created_at DESC`, [user.id]);
    const reviewable = await pool.query(`SELECT DISTINCT ON (p.id) p.id AS product_id, p.name, o.reference, o.created_at
      FROM orders o JOIN order_lines ol ON ol.order_id = o.id JOIN products p ON p.id = ol.product_id
      WHERE o.buyer_id = $1 AND o.status IN ('delivered','shipped','in_transit','paid','processing','preparing','ready_to_ship')
        AND NOT EXISTS (SELECT 1 FROM customer_reviews r WHERE r.user_id = $1 AND r.product_id = p.id)
      ORDER BY p.id, o.created_at DESC`, [user.id]);
    return { mine: mine.rows, reviewable: reviewable.rows };
  });

  app.get('/api/v1/admin/reviews', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(request.query);
    return { items: (await pool.query(`SELECT r.*, p.name AS product_name, u.display_name FROM customer_reviews r JOIN products p ON p.id = r.product_id
      JOIN users u ON u.id = r.user_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`, [q.status ?? null])).rows };
  });

  app.patch('/api/v1/admin/reviews/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['approved', 'rejected']) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT status FROM customer_reviews WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('UPDATE customer_reviews SET status = $2 WHERE id = $1', [id, body.status]);
      await audit(client, user.id, 'review.moderated', 'customer_review', id, before, body, request.ip);
      return { id, status: body.status };
    });
  });
}
