import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import type { DbPool } from './db.js';
import { attachCardTemplates, commerceProductsByIds, queryCommerceProducts, type CommerceProduct } from './commerce-view.js';

/* Recommendation Engine (Req 239, 260-261, 318-319, 346). Strategies read the canonical catalog and
   WMS availability; nothing here keeps its own product, price or stock copy. Personal signals are
   *derived* preferences (views, wishlist, purchases, saved styles) — never stored as facts. */

export type Strategy = 'for_you' | 'similar' | 'popular' | 'trending';
type Queryable = DbPool | PoolClient;
export type RecommendInput = { strategy: Strategy; userId?: string | null; productId?: string | null; vibe?: string | null; category?: string | null; limit?: number };

const inStock = (items: CommerceProduct[]) => items.filter((p) => p.available > 0);

async function rankedIds(db: Queryable, sql: string, params: unknown[]): Promise<string[]> {
  return (await db.query(sql, params)).rows.map((r: { id: string }) => String(r.id));
}

/** Pure scoring used by `similar` (exported for tests): shared vibes, same category/type, season overlap, price proximity. */
export function similarityScore(anchor: CommerceProduct, candidate: CommerceProduct): number {
  if (anchor.id === candidate.id) return -1;
  const shared = (a: string[], b: string[]) => a.filter((x) => b.includes(x)).length;
  let score = shared(anchor.vibes, candidate.vibes) * 3 + shared(anchor.seasons, candidate.seasons);
  if (anchor.category === candidate.category) score += 4;
  if (anchor.productType && anchor.productType === candidate.productType) score += 2;
  const pa = Number(anchor.priceRial); const pc = Number(candidate.priceRial);
  if (pa > 0 && pc > 0) score += Math.max(0, 2 - Math.abs(Math.log(pc / pa)) * 2);
  return Math.round(score * 100) / 100;
}

export async function recommend(db: Queryable, input: RecommendInput): Promise<{ strategy: Strategy; items: CommerceProduct[]; basedOn: Record<string, unknown>; fallback: boolean }> {
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 16);
  const filters = { vibe: input.vibe ?? undefined, category: input.category ?? undefined };
  const popular = async () => queryCommerceProducts(db, { ...filters, inStockOnly: true, sortBy: 'popular', limit });

  if (input.strategy === 'similar') {
    const [anchor] = input.productId ? await commerceProductsByIds(db, [input.productId]) : [];
    if (!anchor) return { strategy: 'similar', items: await popular(), basedOn: {}, fallback: true };
    const pool = await queryCommerceProducts(db, { inStockOnly: true, limit: 48, sortBy: 'popular', ...(input.vibe ? { vibe: input.vibe } : {}) });
    const items = pool.map((p) => ({ p, s: similarityScore(anchor, p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.p);
    return { strategy: 'similar', items, basedOn: { productId: anchor.id, category: anchor.category, vibes: anchor.vibes }, fallback: false };
  }

  if (input.strategy === 'trending') {
    // Momentum over the last 14 days: purchases weigh 3× a product view.
    const ids = await rankedIds(db, `SELECT p.id FROM products p
        LEFT JOIN (SELECT product_id, count(*)::int AS n FROM product_views WHERE viewed_at >= now() - interval '14 days' GROUP BY product_id) v ON v.product_id = p.id
        LEFT JOIN (SELECT ol.product_id, SUM(ol.quantity)::int AS n FROM order_lines ol JOIN orders o ON o.id = ol.order_id
                   WHERE o.created_at >= now() - interval '14 days' AND o.status NOT IN ('pending_payment','cancelled') GROUP BY ol.product_id) s ON s.product_id = p.id
       WHERE p.status = 'published' AND COALESCE(v.n, 0) + COALESCE(s.n, 0) > 0
         AND ($1::text IS NULL OR $1 = ANY(p.vibes)) AND ($2::text IS NULL OR p.category = $2)
       ORDER BY COALESCE(s.n, 0) * 3 + COALESCE(v.n, 0) DESC, p.created_at DESC LIMIT 40`, [filters.vibe ?? null, filters.category ?? null]);
    const items = inStock(await commerceProductsByIds(db, ids)).slice(0, limit);
    if (items.length >= Math.min(4, limit)) return { strategy: 'trending', items, basedOn: { windowDays: 14 }, fallback: false };
    const fill = (await queryCommerceProducts(db, { ...filters, inStockOnly: true, sortBy: 'newest', limit })).filter((p) => !items.some((i) => i.id === p.id));
    return { strategy: 'trending', items: [...items, ...fill].slice(0, limit), basedOn: { windowDays: 14 }, fallback: items.length === 0 };
  }

  if (input.strategy === 'for_you' && input.userId) {
    const signals = (await db.query(`SELECT
        ARRAY(SELECT v FROM (
          SELECT unnest(p.vibes) AS v FROM products p WHERE p.id IN (
            SELECT ol.product_id FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.buyer_id = $1
            UNION ALL SELECT i.product_id FROM wishlist_items i JOIN wishlist_collections c ON c.id = i.collection_id WHERE c.owner_id = $1
            UNION ALL SELECT product_id FROM product_views WHERE user_id = $1)
          UNION ALL SELECT unnest(derived_vibes) FROM saved_styles WHERE user_id = $1) x GROUP BY v ORDER BY count(*) DESC LIMIT 3) AS vibes,
        ARRAY(SELECT DISTINCT v.size_label FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN product_variants v ON v.id = ol.variant_id
              WHERE o.buyer_id = $1 AND v.size_label IS NOT NULL LIMIT 4) AS sizes,
        ARRAY(SELECT DISTINCT ol.product_id::text FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.buyer_id = $1) AS purchased`, [input.userId])).rows[0] as
      { vibes: string[]; sizes: string[]; purchased: string[] };
    const vibes = input.vibe ? [input.vibe] : signals.vibes ?? [];
    if (!vibes.length && !(signals.sizes ?? []).length) return { strategy: 'for_you', items: await popular(), basedOn: {}, fallback: true };
    const candidates = (await Promise.all((vibes.length ? vibes : [undefined]).map((vibe) => queryCommerceProducts(db, { inStockOnly: true, vibe, category: filters.category, sortBy: 'popular', limit: 24 })))).flat();
    const seen = new Set<string>(signals.purchased ?? []);
    const sizes = signals.sizes ?? [];
    const ranked = candidates.filter((p) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .map((p) => ({ p, s: p.vibes.filter((v) => vibes.includes(v)).length * 2 + (sizes.length && p.variants.some((v) => v.available > 0 && v.size && sizes.includes(v.size)) ? 3 : 0) }))
      .sort((a, b) => b.s - a.s).map((x) => x.p).slice(0, limit);
    if (!ranked.length) return { strategy: 'for_you', items: await popular(), basedOn: { vibes, sizes }, fallback: true };
    return { strategy: 'for_you', items: ranked, basedOn: { vibes, sizes, derived: true }, fallback: false };
  }

  return { strategy: input.strategy === 'for_you' ? 'for_you' : 'popular', items: await popular(), basedOn: {}, fallback: input.strategy === 'for_you' };
}

export function registerRecommendationRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/recommendations', async (request) => {
    const q = z.object({
      strategy: z.enum(['for_you', 'similar', 'popular', 'trending']).default('popular'), productId: z.uuid().optional(),
      vibe: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), category: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(16).optional(),
    }).parse(request.query);
    let userId: string | null = null;
    if (q.strategy === 'for_you') { try { userId = (await principal(request, pool, config)).id; } catch { /* anonymous → popular fallback */ } }
    const result = await recommend(pool, { ...q, userId });
    return { ...result, items: await attachCardTemplates(pool, result.items) };
  });
}
