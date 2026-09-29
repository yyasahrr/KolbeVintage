import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial } from './money.js';
import { audit } from './operations.js';
import { emitEvent } from './events.js';
import { badRequest, notFound } from './errors.js';
import { recordTimeline } from './crm-intelligence.js';

/* Recommendation domain (items 110-121).
   The storefront never decides what to show: it asks for a slot and the backend
   answers with a strategy. Availability comes from stock balances (118), prices
   come from the product/pricing source of truth (119), and every impression and
   click is recorded so the engine can be measured (116-117). */

export type RecommendationStrategy =
  | 'personalized' | 'similar' | 'collaborative' | 'popular' | 'trending'
  | 'rule_based' | 'seasonal' | 'manual_campaign' | 'new_arrivals';

/* Canonical-source rule: this projection reads prices from the catalogue and
   availability from WMS on every request. Nothing is copied into recommendation
   tables, so a price/stock change is visible immediately (requirement 118). */
const PRODUCT_SELECT = `
  SELECT p.id, p.name, p.brand, p.category, p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial,
         p.metadata, p.created_at,
         (SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged), 0)::int FROM stock_balances b
            JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = p.id) AS available_stock,
         (SELECT round(avg(r.rating)::numeric, 2)::text FROM customer_reviews r WHERE r.product_id = p.id AND r.status = 'approved') AS rating,
         (SELECT count(*)::int FROM customer_reviews r WHERE r.product_id = p.id AND r.status = 'approved') AS review_count
  FROM products p WHERE p.status = 'published'`;

const serialize = (row: Record<string, unknown>, position: number) => ({
  id: row.id, name: row.name, brand: row.brand, category: row.category,
  cashPriceRial: asRial(String(row.cash_price_rial ?? '0')),
  installmentPriceRial: row.installment_price_rial === null || row.installment_price_rial === undefined ? null : asRial(String(row.installment_price_rial)),
  wholesalePriceRial: row.wholesale_price_rial === null || row.wholesale_price_rial === undefined ? null : asRial(String(row.wholesale_price_rial)),
  metadata: row.metadata ?? {}, availableStock: Number(row.available_stock ?? 0),
  rating: row.rating === null ? null : Number(row.rating), reviewCount: Number(row.review_count ?? 0),
  position,
});

const SEASONAL_DEFAULT: Record<string, string[]> = {
  winter: ['پالتو', 'ترنچ', 'کت', 'بلیزر', 'شلوار'],
  spring: ['مانتو', 'پیراهن', 'شومیز', 'کت'],
  summer: ['پیراهن', 'شومیز', 'تنبان', 'تی‌شرت'],
  autumn: ['کت', 'بلیزر', 'پالتو', 'مانتو'],
};

// Iranian calendar seasons: winter = Dey..Esfand, spring = Farvardin..Khordad, …
const monthToSeason = (month: number) => (month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn');

export function seasonForDate(date = new Date(), timeZone = 'Asia/Tehran'): string {
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone, month: 'numeric' }).format(date));
  return monthToSeason(month);
}

async function personalizedItems(client: PoolClient, userId: string, limit: number, exclude: string[]) {
  const signals = await client.query<{ signal_type: string; signal_key: string; weight: number }>(
    `SELECT signal_type, signal_key, weight FROM customer_interest_signals
     WHERE user_id = $1 ORDER BY weight DESC, last_seen_at DESC LIMIT 60`, [userId]);
  const categories = new Set<string>(); const colors = new Set<string>(); const sizes = new Set<string>();
  let priceCeiling: number | null = null;
  for (const signal of signals.rows) {
    if (signal.signal_type === 'category') categories.add(signal.signal_key);
    if (signal.signal_type === 'color') colors.add(signal.signal_key);
    if (signal.signal_type === 'size') sizes.add(signal.signal_key);
    if (signal.signal_type === 'view' || signal.signal_type === 'purchase') {
      const product = await one<{ category: string; cash_price_rial: string }>(client,
        'SELECT category, cash_price_rial FROM products WHERE id = $1', [signal.signal_key]);
      if (product) {
        categories.add(product.category);
        priceCeiling = Math.max(priceCeiling ?? 0, Number(product.cash_price_rial) * 2);
      }
    }
  }
  const purchased = await client.query<{ product_id: string }>(
    `SELECT DISTINCT l.product_id FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.buyer_id = $1`, [userId]);
  for (const row of purchased.rows) {
    const product = await one<{ category: string }>(client, 'SELECT category FROM products WHERE id = $1', [row.product_id]);
    if (product) categories.add(product.category);
  }
  const rows = await client.query<Record<string, unknown>>(
    `${PRODUCT_SELECT}
       AND (SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged), 0) FROM stock_balances b
              JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = p.id) > 0
       AND ($2::text[] = '{}' OR p.category = ANY($2::text[]))
       AND ($3::bigint IS NULL OR p.cash_price_rial <= $3::bigint)
       AND NOT (p.id = ANY($4::uuid[]))
     ORDER BY (p.category = ANY($2::text[])) DESC,
              (SELECT count(*) FROM order_lines l WHERE l.product_id = p.id) DESC, p.created_at DESC
     LIMIT $1`,
    [limit, [...categories], priceCeiling === null ? null : Math.round(priceCeiling), exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']]);
  return rows.rows;
}

export function registerRecommendationRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** The single public entry point: slot + context in, products out. */
  app.get('/api/v1/recommendations', async (request) => {
    const query = z.object({
      slot: z.string().trim().min(3).max(60),
      strategy: z.string().trim().max(40).optional(),
      productId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(24).default(8),
      exclude: z.string().max(800).optional(),
      sessionId: z.string().max(80).optional(),
      anonymousId: z.string().max(80).optional(),
    }).parse(request.query);
    const user = await principal(request, pool, config).catch(() => null);
    const slot = await one<{ code: string; title: string; page_scope: string; default_strategy: string; strategies: string[]; config: Record<string, unknown>; active: boolean }>(
      pool, 'SELECT * FROM recommendation_slots WHERE code = $1', [query.slot]);
    if (!slot?.active) throw notFound();
    const strategy = (query.strategy && slot.strategies.includes(query.strategy) ? query.strategy : slot.default_strategy) as RecommendationStrategy;
    const exclude = (query.exclude ? query.exclude.split(',').filter(Boolean) : []);
    if (query.productId) exclude.push(query.productId);
    const limit = query.limit;
    const slotConfig = slot.config ?? {};

    const resolved = await transaction(pool, async (client) => {
      let rows: Record<string, unknown>[] = [];
      switch (strategy) {
        case 'personalized': {
          if (!user) {
            rows = (await client.query<Record<string, unknown>>(
              `${PRODUCT_SELECT} AND (SELECT COALESCE(sum(b.on_hand-b.reserved-b.damaged),0) FROM stock_balances b JOIN product_variants v ON v.id=b.variant_id WHERE v.product_id=p.id) > 0
               ORDER BY (SELECT count(*) FROM order_lines l WHERE l.product_id = p.id) DESC LIMIT $1`, [limit])).rows;
            break;
          }
          rows = await personalizedItems(client, user.id, limit, exclude);
          break;
        }
        case 'similar': {
          const anchor = query.productId
            ? await one<{ category: string; cash_price_rial: string }>(client, 'SELECT category,cash_price_rial FROM products WHERE id = $1', [query.productId])
            : null;
          const price = anchor ? Number(anchor.cash_price_rial) : null;
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT}
               AND ($2::text IS NULL OR p.category = $2::text)
               AND ($3::bigint IS NULL OR p.cash_price_rial BETWEEN $3::bigint * 6 / 10 AND $3::bigint * 14 / 10)
               AND NOT (p.id = ANY($4::uuid[]))
               AND (SELECT COALESCE(sum(b.on_hand-b.reserved-b.damaged),0) FROM stock_balances b JOIN product_variants v ON v.id=b.variant_id WHERE v.product_id=p.id) > 0
             ORDER BY ($2::text IS NOT NULL AND p.category = $2::text) DESC, p.created_at DESC LIMIT $1`,
            [limit, anchor?.category ?? null, price === null ? null : Math.round(price),
              exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
        case 'collaborative': {
          const anchorId = query.productId ?? (user
            ? (await one<{ product_id: string }>(client,
                `SELECT l.product_id FROM order_lines l JOIN orders o ON o.id = l.order_id
                 WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 1`, [user.id]))?.product_id ?? null
            : null);
          if (anchorId) {
            rows = (await client.query<Record<string, unknown>>(
              `WITH peers AS (
                 SELECT DISTINCT o2.buyer_id FROM order_lines l1 JOIN orders o1 ON o1.id = l1.order_id
                 JOIN orders o2 ON o2.buyer_id = o1.buyer_id
                 JOIN order_lines l2 ON l2.order_id = o2.id
                 WHERE l1.product_id = $2 AND l2.product_id <> $2
               )
               ${PRODUCT_SELECT}
                 AND EXISTS (SELECT 1 FROM order_lines l JOIN orders o ON o.id = l.order_id
                             WHERE l.product_id = p.id AND o.buyer_id IN (SELECT buyer_id FROM peers))
                 AND p.id <> $2 AND NOT (p.id = ANY($3::uuid[]))
               ORDER BY (SELECT count(*) FROM order_lines l WHERE l.product_id = p.id) DESC LIMIT $1`,
              [limit, anchorId, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          }
          break;
        }
        case 'trending': {
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT}
               AND NOT (p.id = ANY($2::uuid[]))
             ORDER BY (SELECT COALESCE(sum(l.quantity),0) FROM order_lines l JOIN orders o ON o.id = l.order_id
                        WHERE l.product_id = p.id AND o.created_at > now() - interval '30 days') DESC,
                      (SELECT count(*) FROM recommendation_events e WHERE e.product_id = p.id AND e.event_type = 'clicked'
                        AND e.created_at > now() - interval '14 days') DESC
             LIMIT $1`,
            [limit, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
        case 'new_arrivals': {
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT} AND NOT (p.id = ANY($2::uuid[])) ORDER BY p.created_at DESC LIMIT $1`,
            [limit, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
        case 'seasonal': {
          const season = (slotConfig.season as string) ?? seasonForDate();
          const categories = (slotConfig.seasonCategories as Record<string, string[]>)?.[season] ?? SEASONAL_DEFAULT[season] ?? [];
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT} AND p.category = ANY($2::text[]) AND NOT (p.id = ANY($3::uuid[])) ORDER BY p.created_at DESC LIMIT $1`,
            [limit, categories.length ? categories : ['هیچ'], exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
        case 'rule_based': {
          const rules = (slotConfig.rules ?? {}) as { categories?: string[]; maxPriceRial?: string; minRating?: number };
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT}
               AND ($2::text[] IS NULL OR p.category = ANY($2::text[]))
               AND ($3::bigint IS NULL OR p.cash_price_rial <= $3::bigint)
               AND ($4::numeric IS NULL OR (SELECT COALESCE(avg(r.rating),0) FROM customer_reviews r WHERE r.product_id = p.id AND r.status='approved') >= $4::numeric)
               AND NOT (p.id = ANY($5::uuid[]))
             ORDER BY p.created_at DESC LIMIT $1`,
            [limit, rules.categories ?? null, rules.maxPriceRial ?? null, rules.minRating ?? null,
              exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
        case 'manual_campaign': {
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT} AND p.id IN (SELECT product_id FROM recommendation_manual_items WHERE slot_code = $2 AND active)
             ORDER BY (SELECT position FROM recommendation_manual_items m WHERE m.product_id = p.id AND m.slot_code = $2) LIMIT $1`,
            [limit, slot.code])).rows;
          break;
        }
        case 'popular':
        default: {
          rows = (await client.query<Record<string, unknown>>(
            `${PRODUCT_SELECT}
               AND NOT (p.id = ANY($2::uuid[]))
             ORDER BY (SELECT COALESCE(sum(l.quantity),0) FROM order_lines l JOIN orders o ON o.id = l.order_id
                        WHERE l.product_id = p.id AND o.status NOT IN ('pending_payment','cancelled')) DESC,
                      p.created_at DESC LIMIT $1`,
            [limit, exclude.length ? exclude : ['00000000-0000-0000-0000-000000000000']])).rows;
          break;
        }
      }
      // Requirement 118: never recommend something that cannot be sold right now.
      // Strict availability is the default (an empty slot is better than an unsellable
      // item); a slot can opt into the "show the rest when the catalogue is empty"
      // fallback explicitly through its own config, never implicitly.
      const inStock = rows.filter((row) => Number(row.available_stock ?? 0) > 0 || strategy === 'manual_campaign');
      const allowFallback = slotConfig.allowOutOfStockFallback === true;
      const published = allowFallback && !inStock.length ? rows : inStock;
      return { items: published.slice(0, limit), strategy };
    });

    // Impressions are recorded server-side; the client never has to be trusted for them.
    await transaction(pool, async (client) => {
      for (const [index, row] of resolved.items.entries()) {
        await client.query(
          `INSERT INTO recommendation_events(id,slot_code,strategy,event_type,user_id,anonymous_id,session_id,product_id,position,context)
           VALUES ($1,$2,$3,'shown',$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), slot.code, resolved.strategy, user?.id ?? null, query.anonymousId ?? null, query.sessionId ?? null,
            row.id, index, JSON.stringify({ pageScope: slot.page_scope, contextual: { season: seasonForDate() } })]);
      }
    });

    return {
      slot: slot.code, slotTitle: slot.title, strategy: resolved.strategy,
      contextual: { season: seasonForDate(), month: new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran', month: 'long' }) },
      items: resolved.items.map((row, index) => serialize(row, index)),
      tracking: { slot: slot.code, strategy: resolved.strategy, sessionId: query.sessionId ?? null },
      // Hardening (requirement 118): recommendations never cache money or stock. The
      // response states where both values were read from, so callers cannot mistake
      // them for recommendation-owned data.
      sources: {
        pricing: 'catalog.products.cash_price_rial',
        availability: 'wms.stock_balances(on_hand - reserved - damaged)',
        cached: false,
      },
    };
  });

  app.post('/api/v1/recommendations/events', async (request, reply) => {
    const user = await principal(request, pool, config).catch(() => null);
    const body = z.object({
      sessionId: z.string().max(80).optional(), anonymousId: z.string().max(80).optional(),
      events: z.array(z.object({
        slotCode: z.string().trim().max(60), strategy: z.string().trim().max(40),
        eventType: z.enum(['shown', 'clicked', 'added_to_cart', 'purchased']),
        productId: z.uuid().nullable().optional(), position: z.number().int().min(0).max(50).optional(),
        orderId: z.uuid().nullable().optional(), revenueRial: z.string().regex(/^\d+$/).optional(),
        context: z.record(z.string(), z.unknown()).optional(),
      })).min(1).max(50),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      let recorded = 0;
      for (const event of body.events) {
        await client.query(
          `INSERT INTO recommendation_events(id,slot_code,strategy,event_type,user_id,anonymous_id,session_id,product_id,position,order_id,revenue_rial,context)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [randomUUID(), event.slotCode, event.strategy, event.eventType, user?.id ?? null,
            body.anonymousId ?? null, body.sessionId ?? null, event.productId ?? null, event.position ?? null,
            event.orderId ?? null, event.revenueRial ?? '0', JSON.stringify(event.context ?? {})]);
        recorded += 1;
        if (user && event.productId && event.eventType === 'added_to_cart') {
          await client.query(
            `INSERT INTO customer_interest_signals(user_id,signal_type,signal_key,weight) VALUES ($1,'cart',$2,3)
             ON CONFLICT (user_id,signal_type,signal_key) DO UPDATE SET weight = customer_interest_signals.weight + 3, last_seen_at = now()`,
            [user.id, event.productId]);
        }
        if (user && event.productId && event.eventType === 'purchased') {
          await emitEvent(client, { eventType: 'recommendation.purchased', entityType: 'product', entityId: event.productId,
            payload: { slot: event.slotCode, strategy: event.strategy, productId: event.productId, orderId: event.orderId ?? null },
            actorId: user.id });
          await recordTimeline(client, { userId: user.id, eventType: 'recommendation.purchase', source: 'recommendation',
            title: 'خرید از پیشنهاد', description: `${event.slotCode} → ${event.strategy}`,
            refType: 'product', refId: event.productId, actorId: user.id });
        }
      }
      return { recorded };
    });
    return reply.code(202).send(result);
  });

  /** Compact behavioural ingestion for personalization (views, wishlist, search…). */
  app.post('/api/v1/recommendations/signals', async (request, reply) => {
    const user = await principal(request, pool, config).catch(() => null);
    if (!user) throw badRequest('برای ثبت سیگنال رفتاری باید وارد حساب شوید.');
    const body = z.object({
      signals: z.array(z.object({
        type: z.enum(['view', 'wishlist', 'cart', 'purchase', 'return', 'search', 'rating', 'category', 'color', 'size']),
        key: z.string().trim().min(1).max(120),
        weight: z.number().int().min(1).max(20).default(1),
      })).min(1).max(50),
    }).strict().parse(request.body);
    await transaction(pool, async (client) => {
      for (const signal of body.signals) {
        await client.query(
          `INSERT INTO customer_interest_signals(user_id,signal_type,signal_key,weight) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id,signal_type,signal_key)
           DO UPDATE SET weight = customer_interest_signals.weight + $4, last_seen_at = now()`,
          [user.id, signal.type, signal.key, signal.weight]);
      }
    });
    return reply.code(202).send({ accepted: body.signals.length });
  });

  /* ------------------------------- admin side ------------------------------- */
  app.get('/api/v1/admin/recommendations/slots', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'recommendations:manage');
    const rows = await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM recommendation_manual_items m WHERE m.slot_code = s.code AND m.active) AS manual_items
       FROM recommendation_slots s ORDER BY s.code`);
    return { items: rows.rows, strategies: ['personalized', 'similar', 'collaborative', 'popular', 'trending', 'rule_based', 'seasonal', 'manual_campaign', 'new_arrivals'] };
  });

  app.patch('/api/v1/admin/recommendations/slots/:code', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'recommendations:manage');
    const { code } = z.object({ code: z.string().max(60) }).parse(request.params);
    const body = z.object({
      defaultStrategy: z.enum(['personalized', 'similar', 'collaborative', 'popular', 'trending', 'rule_based', 'seasonal', 'manual_campaign', 'new_arrivals']).optional(),
      strategies: z.array(z.string().max(40)).max(12).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      active: z.boolean().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM recommendation_slots WHERE code = $1 FOR UPDATE', [code]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE recommendation_slots SET default_strategy = COALESCE($2,default_strategy), strategies = COALESCE($3,strategies),
           config = COALESCE($4,config), active = COALESCE($5,active), updated_at = now() WHERE code = $1`,
        [code, body.defaultStrategy ?? null, body.strategies ?? null,
          body.config ? JSON.stringify(body.config) : null, body.active ?? null]);
      await audit(client, user.id, 'recommendation.slot_updated', 'recommendation_slot', code, before, body, request.ip);
      return one(client, 'SELECT * FROM recommendation_slots WHERE code = $1', [code]);
    });
  });

  app.post('/api/v1/admin/recommendations/slots/:code/items', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'recommendations:manage');
    const { code } = z.object({ code: z.string().max(60) }).parse(request.params);
    const body = z.object({
      productIds: z.array(z.uuid()).min(1).max(50),
      replace: z.boolean().default(false),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const slot = await one(client, 'SELECT code FROM recommendation_slots WHERE code = $1', [code]);
      if (!slot) throw notFound();
      if (body.replace) await client.query('DELETE FROM recommendation_manual_items WHERE slot_code = $1', [code]);
      let position = (await one<{ max: number | null }>(client,
        'SELECT max(position) AS max FROM recommendation_manual_items WHERE slot_code = $1', [code]))?.max ?? 0;
      for (const productId of body.productIds) {
        const product = await one(client, 'SELECT id FROM products WHERE id = $1', [productId]);
        if (!product) throw notFound();
        position += 1;
        await client.query(
          `INSERT INTO recommendation_manual_items(slot_code,product_id,position,active) VALUES ($1,$2,$3,true)
           ON CONFLICT (slot_code,product_id) DO UPDATE SET position = $3, active = true`, [code, productId, position]);
      }
      await audit(client, user.id, 'recommendation.manual_items', 'recommendation_slot', code, undefined,
        { products: body.productIds.length, replace: body.replace }, request.ip);
      return reply.code(201).send({ slot: code, items: body.productIds.length });
    });
  });

  app.delete('/api/v1/admin/recommendations/slots/:code/items/:productId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'recommendations:manage');
    const params = z.object({ code: z.string().max(60), productId: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const result = await client.query(
        'DELETE FROM recommendation_manual_items WHERE slot_code = $1 AND product_id = $2', [params.code, params.productId]);
      if (!result.rowCount) throw notFound();
      await audit(client, user.id, 'recommendation.manual_item_removed', 'recommendation_slot', params.code,
        { productId: params.productId }, undefined, request.ip);
      return { removed: true };
    });
  });

  /** Requirement 117: impressions, clicks, CTR, add-to-cart, conversion and revenue. */
  app.get('/api/v1/admin/recommendations/analytics', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'recommendations:manage');
    const query = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      slot: z.string().max(60).optional(),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.slot_code, e.strategy,
              count(*) FILTER (WHERE e.event_type = 'shown')::int AS impressions,
              count(*) FILTER (WHERE e.event_type = 'clicked')::int AS clicks,
              count(*) FILTER (WHERE e.event_type = 'added_to_cart')::int AS add_to_cart,
              count(*) FILTER (WHERE e.event_type = 'purchased')::int AS purchases,
              COALESCE(sum(e.revenue_rial) FILTER (WHERE e.event_type = 'purchased'), 0)::text AS revenue_rial
       FROM recommendation_events e
       WHERE e.created_at > now() - ($1::int || ' days')::interval AND ($2::text IS NULL OR e.slot_code = $2)
       GROUP BY e.slot_code, e.strategy ORDER BY e.slot_code, e.strategy`, [query.days, query.slot ?? null]);
    const items = rows.rows.map((row) => ({
      slotCode: row.slot_code, strategy: row.strategy, impressions: row.impressions, clicks: row.clicks,
      ctr: row.impressions ? Math.round((row.clicks / row.impressions) * 10000) / 100 : 0,
      addToCart: row.add_to_cart,
      addToCartRate: row.clicks ? Math.round((row.add_to_cart / row.clicks) * 10000) / 100 : 0,
      purchases: row.purchases,
      conversion: row.clicks ? Math.round((row.purchases / row.clicks) * 10000) / 100 : 0,
      revenueRial: asRial(row.revenue_rial),
    }));
    const totals = items.reduce((acc, item) => ({
      impressions: acc.impressions + item.impressions, clicks: acc.clicks + item.clicks,
      addToCart: acc.addToCart + item.addToCart, purchases: acc.purchases + item.purchases,
      revenueRial: (BigInt(acc.revenueRial) + BigInt(item.revenueRial)).toString(),
    }), { impressions: 0, clicks: 0, addToCart: 0, purchases: 0, revenueRial: '0' });
    return {
      items, totals: {
        ...totals,
        ctr: totals.impressions ? Math.round((totals.clicks / totals.impressions) * 10000) / 100 : 0,
        conversion: totals.clicks ? Math.round((totals.purchases / totals.clicks) * 10000) / 100 : 0,
      },
      privacyNote: 'رویدادها با شناسه کاربر/نشست ثبت می‌شوند و برای کاربر مهمان فقط شناسه ناشناس ذخیره می‌شود.',
    };
  });
}
