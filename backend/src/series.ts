import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

/**
 * Series templates (section K): wholesale sells by series, not individual pairs.
 * A series is a relational recipe (series_template_items: variant × quantity_per_series);
 * JSON appears only as an order-time snapshot, never as the source of truth.
 */

const itemsSchema = z.array(z.object({
  variantId: z.uuid(),
  quantityPerSeries: z.number().int().min(1).max(1000),
  unitPriceRial: z.string().regex(/^\d{1,15}$/).nullable().optional(),
})).min(1).max(100);

export const seriesCommercialSchema = z.object({
  pricingMode: z.enum(['legacy_product', 'series_total', 'component_sum']).default('legacy_product'),
  totalPriceRial: z.string().regex(/^\d{1,15}$/).nullable().optional(),
  minOrderSeries: z.number().int().min(1).max(10000).default(1),
});

export const productSeriesSchema = z.array(z.object({
  id: z.uuid().optional(), name: z.string().trim().min(2).max(120), color: z.string().trim().min(1).max(100),
  active: z.boolean().default(true),
  pricingMode: z.enum(['series_total', 'component_sum']),
  totalPriceRial: z.string().regex(/^\d{1,15}$/).nullable().optional(),
  minOrderSeries: z.number().int().min(1).max(10000).default(1),
  items: z.array(z.object({ size: z.string().trim().min(1).max(50), quantityPerSeries: z.number().int().min(1).max(1000),
    unitPriceRial: z.string().regex(/^\d{1,15}$/).nullable().optional() })).min(1).max(100),
})).max(50);

/** Atomic catalog writer: Studio recipes resolve to real variant IDs, never stock. */
export async function saveProductSeries(client: DbClient, productId: string, series: z.infer<typeof productSeriesSchema>, actorId: string) {
  const kept: string[] = [];
  for (const input of series) {
    if (new Set(input.items.map((i) => i.size)).size !== input.items.length) throw badRequest('هر سایز فقط یک‌بار در سری مجاز است.');
    const items = [];
    for (const item of input.items) {
      const variant = await one<{ id: string; sku: string }>(client,
        'SELECT id,sku FROM product_variants WHERE product_id=$1 AND color_label=$2 AND size_label=$3 AND active', [productId, input.color, item.size]);
      if (!variant) throw badRequest(`سایز «${item.size}» و رنگ «${input.color}» واریانت فعال این محصول نیست.`);
      items.push({ variant_id: variant.id, sku: variant.sku, quantity_per_series: item.quantityPerSeries, unit_price_rial: item.unitPriceRial ?? null });
    }
    allocateSeriesPrice(items, input.pricingMode, input.totalPriceRial ?? null);
    const id = input.id ?? randomUUID();
    let previous: Awaited<ReturnType<typeof loadSeriesComposition>> = null;
    if (input.id) {
      const existing = await one(client, 'SELECT id FROM series_templates WHERE id=$1 AND product_id=$2 FOR UPDATE', [id, productId]);
      if (!existing) throw badRequest('سری انتخاب‌شده متعلق به این محصول نیست.');
      const old = await loadSeriesComposition(client, id);
      previous = old;
      const key = (rows: { variant_id: string; quantity_per_series: number }[]) => rows.map((i) => `${i.variant_id}:${i.quantity_per_series}`).sort().join('|');
      if (key(old!.items) !== key(items)) {
        const stock = await one<{ n: string }>(client, 'SELECT count(*)::text AS n FROM series_stock_balances WHERE series_template_id=$1 AND (on_hand>0 OR reserved>0 OR incoming>0)', [id]);
        if (Number(stock?.n ?? 0)) throw conflict('سری دارای موجودی یا رزرو را نمی‌توان تغییر ترکیب داد؛ سری جدید بسازید.');
      }
    }
    await client.query(`INSERT INTO series_templates(id,product_id,name,color_label,active,pricing_mode,total_price_rial,min_order_series,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=$3,color_label=$4,active=$5,pricing_mode=$6,total_price_rial=$7,min_order_series=$8,updated_at=now()`,
      [id, productId, input.name, input.color, input.active, input.pricingMode, input.totalPriceRial ?? null, input.minOrderSeries, actorId]);
    await client.query('DELETE FROM series_template_items WHERE series_template_id=$1', [id]);
    for (const item of items) await client.query('INSERT INTO series_template_items(id,series_template_id,variant_id,quantity_per_series,unit_price_rial) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), id, item.variant_id, item.quantity_per_series, item.unit_price_rial]);
    kept.push(id);
    await audit(client, actorId, input.id ? 'series_template.updated' : 'series_template.created', 'series_template', id, undefined, input);
    // §28 — series price history rides the existing audit trail: previous/new value, actor, timestamp,
    // product + series context. A wholesale price change is never silent.
    if (input.id && previous) {
      const unitsOf = (rows: { variant_id: string; unit_price_rial?: string | null }[]) =>
        rows.map((row) => `${row.variant_id}:${row.unit_price_rial ?? ''}`).sort().join('|');
      const before = {
        pricing_mode: previous.template.pricing_mode,
        total_price_rial: previous.template.total_price_rial,
        min_order_series: previous.template.min_order_series,
        componentPrices: unitsOf(previous.items),
      };
      const next = {
        pricing_mode: input.pricingMode,
        total_price_rial: input.totalPriceRial ?? null,
        min_order_series: input.minOrderSeries,
        componentPrices: unitsOf(items),
      };
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        await audit(client, actorId, 'series_template.price_changed', 'series_template', id,
          { ...before, seriesName: previous.template.name, productId }, { ...next, seriesName: input.name }, undefined);
      }
    }
  }
  // Retain referenced recipes; removing from the form archives, never hard-deletes.
  await client.query('UPDATE series_templates SET active=false,updated_at=now() WHERE product_id=$1 AND NOT (id=ANY($2::uuid[]))', [productId, kept]);
}

const createBody = z.object({
  productId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  items: itemsSchema,
}).extend(seriesCommercialSchema.shape);

export function allocateSeriesPrice(items: { variant_id: string; quantity_per_series: number; unit_price_rial?: string | null; sku: string }[],
  mode: string, total: string | null) {
  if (mode === 'legacy_product') return items.map((item) => ({ ...item, basePriceRial: null as string | null }));
  if (mode === 'component_sum') {
    if (items.some((item) => item.unit_price_rial == null)) throw badRequest('قیمت هر جزء سری لازم است.');
    if (items.reduce((sum, item) => sum + BigInt(item.unit_price_rial!) * BigInt(item.quantity_per_series), 0n) <= 0n) throw badRequest('جمع قیمت اجزای سری باید مثبت باشد.');
    return items.map((item) => ({ ...item, basePriceRial: String(item.unit_price_rial) }));
  }
  const count = items.reduce((sum, item) => sum + item.quantity_per_series, 0);
  if (!total || BigInt(total) <= 0n || count <= 0) throw badRequest('قیمت کل سری باید مثبت باشد.');
  const unit = BigInt(total) / BigInt(count);
  let remainder = Number(BigInt(total) % BigInt(count));
  // At most two price groups per component. Integer-rial allocation preserves the
  // exact series total, even when it cannot be divided evenly by piece count.
  return items.flatMap((item) => {
    const extra = Math.min(remainder, item.quantity_per_series); remainder -= extra;
    return [
      ...(extra ? [{ ...item, quantity_per_series: extra, basePriceRial: (unit + 1n).toString() }] : []),
      ...(extra < item.quantity_per_series ? [{ ...item, quantity_per_series: item.quantity_per_series - extra, basePriceRial: unit.toString() }] : []),
    ];
  });
}

export async function loadSeriesComposition(pool: DbPool | DbClient, templateId: string) {
  const template = await one<{
    id: string; product_id: string; name: string; description: string; active: boolean;
    product_name: string; pricing_mode: string; total_price_rial: string | null; min_order_series: number;
  }>(pool,
    `SELECT t.*, p.name AS product_name FROM series_templates t JOIN products p ON p.id = t.product_id WHERE t.id = $1`,
    [templateId]);
  if (!template) return null;
  const items = await pool.query<{
    variant_id: string; quantity_per_series: number; sku: string; color_label: string | null; size_label: string | null; unit_price_rial: string | null;
  }>(
    `SELECT i.variant_id, i.quantity_per_series, i.unit_price_rial::text, v.sku, v.color_label, v.size_label
     FROM series_template_items i JOIN product_variants v ON v.id = i.variant_id
     WHERE i.series_template_id = $1 ORDER BY v.color_label, v.size_label`,
    [templateId]);
  return { template, items: items.rows };
}

/** Available whole series = min over components of floor(available component stock / qty per series). */
export async function computeAvailableSeries(pool: DbPool, templateId: string): Promise<number> {
  const row = await one<{ available_series: string | null }>(pool,
    `SELECT min(floor(COALESCE(avail.available, 0) / i.quantity_per_series))::text AS available_series
     FROM series_template_items i
     LEFT JOIN (
       SELECT variant_id, sum(on_hand - reserved - damaged) AS available
       FROM stock_balances WHERE inventory_domain = 'wholesale'
       GROUP BY variant_id
     ) avail ON avail.variant_id = i.variant_id
     WHERE i.series_template_id = $1`,
    [templateId]);
  return Math.max(0, Number(row?.available_series ?? '0'));
}


/** §5: a series belongs to ONE Product+Color — derive color_label from the recipe components. */
async function deriveTemplateColor(client: DbClient, templateId: string): Promise<void> {
  await client.query(
    `UPDATE series_templates t SET color_label = sub.color_label FROM (
       SELECT i.series_template_id,
              CASE WHEN count(DISTINCT COALESCE(v.color_label, '∅')) = 1 THEN min(v.color_label) ELSE NULL END AS color_label
       FROM series_template_items i JOIN product_variants v ON v.id = i.variant_id
       WHERE i.series_template_id = $1 GROUP BY i.series_template_id
     ) sub WHERE sub.series_template_id = t.id`,
    [templateId]);
}

export function registerSeriesTemplateRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/series-templates', async (request, reply) => {
    const user = await principal(request, pool, config);
    const supplier = user.roles.includes('supplier') && !user.permissions.includes('products:write');
    if (!supplier) requirePermission(user, 'products:write');
    const body = createBody.parse(request.body);

    const response = await transaction(pool, async (client) => {
      const product = await one<{ id: string; supplier_id: string | null }>(
        client, 'SELECT id, supplier_id FROM products WHERE id = $1', [body.productId]);
      if (!product) throw notFound();
      if (supplier && product.supplier_id !== user.id) {
        throw forbidden('فقط برای محصولات خودتان می‌توانید قالب سری تعریف کنید.');
      }
      // Every component variant must belong to the product (variant-level recipes, G5/K1).
      for (const item of body.items) {
        const variant = await one<{ id: string }>(
          client, 'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [item.variantId, body.productId]);
        if (!variant) throw badRequest('همه تنوع‌های سری باید متعلق به همین محصول باشند.');
      }
      const seen = new Set<string>();
      for (const item of body.items) {
        if (seen.has(item.variantId)) throw badRequest('هر تنوع فقط یک بار می‌تواند در ترکیب سری باشد.');
        seen.add(item.variantId);
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO series_templates(id, product_id, name, description, created_by, pricing_mode, total_price_rial, min_order_series)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.productId, body.name, body.description ?? '', user.id, body.pricingMode, body.totalPriceRial ?? null, body.minOrderSeries]);
      for (const item of body.items) {
        await client.query(
          `INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series, unit_price_rial)
           VALUES ($1,$2,$3,$4,$5)`,
          [randomUUID(), id, item.variantId, item.quantityPerSeries, item.unitPriceRial ?? null]);
      }
      const composition = await loadSeriesComposition(client, id);
      allocateSeriesPrice(composition!.items, body.pricingMode, body.totalPriceRial ?? null);
      await deriveTemplateColor(client, id);
      const out = { id, name: body.name, productId: body.productId, itemCount: body.items.length };
      await audit(client, user.id, 'series_template.created', 'series_template', id, undefined, out, request.ip);
      return out;
    });
    return reply.code(201).send(response);
  });

  app.get('/api/v1/series-templates', async (request) => {
    const user = await principal(request, pool, config);
    // VIP buyers, suppliers and staff may all read series compositions (K2/K3).
    const query = z.object({
      productId: z.uuid().optional(),
      active: z.coerce.boolean().optional(),
      // VIP marketplace asks for the full operational picture in one call:
      // composition items + availableSeries (component-bottleneck, server-computed).
      withAvailability: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query<{
      id: string; product_id: string; product_name: string; name: string; description: string;
      active: boolean; created_at: string; component_count: number; pairs_per_series: number;
      product_wholesale_price_rial: string | null; product_wholesale_moq: number | null;
      pricing_mode: string; total_price_rial: string | null; min_order_series: number; component_total_price_rial: string;
    }>(
      `SELECT t.id, t.product_id, p.name AS product_name, t.name, t.description, t.active, t.created_at,
              t.pricing_mode, t.total_price_rial::text, t.min_order_series,
              (SELECT COALESCE(sum(i.unit_price_rial * i.quantity_per_series),0)::text FROM series_template_items i WHERE i.series_template_id = t.id) AS component_total_price_rial,
              p.wholesale_price_rial::text AS product_wholesale_price_rial,
              p.wholesale_moq AS product_wholesale_moq,
              (SELECT count(*) FROM series_template_items i WHERE i.series_template_id = t.id)::int AS component_count,
              (SELECT COALESCE(sum(i.quantity_per_series),0) FROM series_template_items i WHERE i.series_template_id = t.id)::int AS pairs_per_series
       FROM series_templates t JOIN products p ON p.id = t.product_id
       WHERE ($1::uuid IS NULL OR t.product_id = $1)
         AND ($2::boolean IS NULL OR t.active = $2)
       ORDER BY t.created_at DESC LIMIT $3`,
      [query.productId ?? null, query.active ?? null, query.limit]);
    void user;
    const items = await Promise.all(rows.rows.map(async (row) => {
      const pairs = Math.max(1, Number(row.pairs_per_series));
      // Price/MOQ are derived server-side from the canonical product terms so the
      // client never computes wholesale economics on its own (K3).
      const base = {
        ...row,
        price_per_series_rial: row.pricing_mode === 'series_total' ? row.total_price_rial
          : row.pricing_mode === 'component_sum' ? row.component_total_price_rial : row.product_wholesale_price_rial
          ? (BigInt(row.product_wholesale_price_rial) * BigInt(pairs)).toString()
          : null,
        moq_series: row.pricing_mode !== 'legacy_product' ? row.min_order_series : Math.max(1, Math.ceil(Number(row.product_wholesale_moq ?? 1) / pairs)),
      };
      if (!query.withAvailability) return base;
      const composition = await loadSeriesComposition(pool, row.id);
      return {
        ...base,
        available_series: await computeAvailableSeries(pool, row.id),
        items: composition?.items ?? [],
      };
    }));
    return { items };
  });

  app.get('/api/v1/series-templates/:id', async (request) => {
    const user = await principal(request, pool, config);
    void user;
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const data = await loadSeriesComposition(pool, id);
    if (!data) throw notFound();
    const availableSeries = await computeAvailableSeries(pool, id);
    const pairsPerSeries = data.items.reduce((sum, item) => sum + item.quantity_per_series, 0);
    const terms = await one<{ wholesale_price_rial: string | null; wholesale_moq: number | null }>(
      pool, 'SELECT wholesale_price_rial::text, wholesale_moq FROM products WHERE id = $1', [data.template.product_id]);
    return {
      id: data.template.id,
      productId: data.template.product_id,
      productName: data.template.product_name,
      name: data.template.name,
      description: data.template.description,
      active: data.template.active,
      pricingMode: data.template.pricing_mode,
      totalPriceRial: data.template.total_price_rial,
      minOrderSeries: data.template.min_order_series,
      items: data.items,
      pairsPerSeries,
      availableSeries,
      pricePerSeriesRial: data.template.pricing_mode === 'series_total' ? data.template.total_price_rial
        : data.template.pricing_mode === 'component_sum' ? data.items.reduce((sum, i) => sum + BigInt(i.unit_price_rial ?? '0') * BigInt(i.quantity_per_series), 0n).toString()
        : terms?.wholesale_price_rial
        ? (BigInt(terms.wholesale_price_rial) * BigInt(Math.max(1, pairsPerSeries))).toString()
        : null,
      moqSeries: data.template.pricing_mode !== 'legacy_product' ? data.template.min_order_series : Math.max(1, Math.ceil(Number(terms?.wholesale_moq ?? 1) / Math.max(1, pairsPerSeries))),
    };
  });

  app.patch('/api/v1/series-templates/:id', async (request) => {
    const user = await principal(request, pool, config);
    const supplier = user.roles.includes('supplier') && !user.permissions.includes('products:write');
    if (!supplier) requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(500).optional(),
      active: z.boolean().optional(),
      items: itemsSchema.optional(),
      pricingMode: seriesCommercialSchema.shape.pricingMode.optional(),
      totalPriceRial: seriesCommercialSchema.shape.totalPriceRial,
      minOrderSeries: seriesCommercialSchema.shape.minOrderSeries.optional(),
    }).parse(request.body);

    return transaction(pool, async (client) => {
      const template = await one<{ id: string; product_id: string; supplier_id: string | null }>(
        client,
        `SELECT t.id, t.product_id, p.supplier_id FROM series_templates t JOIN products p ON p.id = t.product_id
         WHERE t.id = $1 FOR UPDATE`,
        [id]);
      if (!template) throw notFound();
      if (supplier && template.supplier_id !== user.id) throw forbidden();
      if (body.items) {
        const stock = await one<{ n: string }>(client,
          'SELECT count(*)::text AS n FROM series_stock_balances WHERE series_template_id=$1 AND (on_hand > 0 OR reserved > 0 OR incoming > 0)', [id]);
        if (Number(stock?.n ?? '0')) throw conflict('ترکیب سری دارای موجودی یا رزرو قابل تغییر نیست؛ سری جدید تعریف کنید.');
        if (new Set(body.items.map((i) => i.variantId)).size !== body.items.length) throw badRequest('هر واریانت فقط یک‌بار در سری مجاز است.');
      }

      await client.query(
        `UPDATE series_templates SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           active = COALESCE($4, active),
           pricing_mode = COALESCE($5, pricing_mode),
           total_price_rial = CASE WHEN $6::boolean THEN $7::bigint ELSE total_price_rial END,
           min_order_series = COALESCE($8, min_order_series),
           updated_at = now()
         WHERE id = $1`,
        [id, body.name ?? null, body.description ?? null, body.active ?? null, body.pricingMode ?? null,
          body.totalPriceRial !== undefined, body.totalPriceRial ?? null, body.minOrderSeries ?? null]);

      if (body.items) {
        for (const item of body.items) {
          const variant = await one<{ id: string }>(
            client, 'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2', [item.variantId, template.product_id]);
          if (!variant) throw badRequest('همه تنوع‌های سری باید متعلق به همین محصول باشند.');
        }
        await client.query('DELETE FROM series_template_items WHERE series_template_id = $1', [id]);
        for (const item of body.items) {
          await client.query(
            `INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series, unit_price_rial)
             VALUES ($1,$2,$3,$4,$5)`,
            [randomUUID(), id, item.variantId, item.quantityPerSeries, item.unitPriceRial ?? null]);
        }
        await deriveTemplateColor(client, id);
      }
      const composition = await loadSeriesComposition(client, id);
      allocateSeriesPrice(composition!.items, composition!.template.pricing_mode, composition!.template.total_price_rial);
      const out = { id, updated: true };
      await audit(client, user.id, 'series_template.updated', 'series_template', id, undefined, { ...body }, request.ip);
      return out;
    });
  });
}
