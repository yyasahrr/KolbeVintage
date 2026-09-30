import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import type { DbPool } from './db.js';
import { one, transaction } from './db.js';
import { audit } from './operations.js';
import { badRequest, notFound } from './errors.js';
import { rial } from './money.js';

const fields = {
  code: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
  type: z.enum(['standard','express','free','pickup']),
  pricingType: z.enum(['flat','weight','free','order_value','destination','carrier']).default('flat'),
  baseFeeRial: z.string().regex(/^\d+$/),
  freeAboveRial: z.string().regex(/^\d+$/).nullable().optional(),
  estimatedMinDays: z.number().int().min(0).max(60),
  estimatedMaxDays: z.number().int().min(0).max(60),
  config: z.record(z.string(), z.unknown()).default({}),
};
const baseBody = z.object(fields);
/**
 * Create keeps the min/max cross-check. PATCH must NOT reuse the refined schema:
 * Zod refuses `.partial()` on an object containing refinements (the old code threw at
 * request time → 500 on every shipping edit), and the range is re-validated against the
 * stored row inside the handler instead.
 */
const body = baseBody.superRefine((v, ctx) => {
  if (v.estimatedMaxDays < v.estimatedMinDays) ctx.addIssue({ code: 'custom', message: 'حداکثر روز باید >= حداقل باشد' });
});
const patchBody = baseBody.partial();

const ruleBody = z.object({
  ruleType: z.enum(['flat', 'weight', 'free', 'order_value', 'destination']),
  minWeightGrams: z.number().int().min(0).max(100000000).nullable().optional(),
  maxWeightGrams: z.number().int().min(0).max(100000000).nullable().optional(),
  minOrderRial: z.string().regex(/^\d+$/).nullable().optional(),
  maxOrderRial: z.string().regex(/^\d+$/).nullable().optional(),
  province: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  feeRial: z.string().regex(/^\d+$/),
  position: z.number().int().min(0).max(100000).default(0),
  active: z.boolean().default(true),
}).strict().superRefine((v, ctx) => {
  if (v.minWeightGrams !== null && v.minWeightGrams !== undefined && v.maxWeightGrams !== null && v.maxWeightGrams !== undefined
    && v.maxWeightGrams < v.minWeightGrams) ctx.addIssue({ code: 'custom', message: 'سقف وزن باید >= کف وزن باشد' });
  if (v.ruleType === 'weight' && v.minWeightGrams == null && v.maxWeightGrams == null)
    ctx.addIssue({ code: 'custom', message: 'قانون وزنی دست‌کم یک کران وزن لازم دارد' });
});

/** Canonical wire shape for a shipping method — the frontend type mirrors this exactly. */
type ShippingRow = {
  id: string; code: string; name: string; active: boolean; type: string; pricing_type: string;
  base_fee_rial: string | number; free_above_rial: string | number | null;
  estimated_min_days: number; estimated_max_days: number; config: unknown;
};
type RuleRow = {
  id: string; method_id: string; rule_type: string;
  min_weight_grams: number | null; max_weight_grams: number | null;
  min_order_rial: string | number | null; max_order_rial: string | number | null;
  province: string | null; city: string | null; fee_rial: string | number;
  position: number; active: boolean;
};
const serializeRule = (row: RuleRow) => ({
  id: row.id, methodId: row.method_id, ruleType: row.rule_type,
  minWeightGrams: row.min_weight_grams, maxWeightGrams: row.max_weight_grams,
  minOrderRial: row.min_order_rial === null ? null : String(row.min_order_rial),
  maxOrderRial: row.max_order_rial === null ? null : String(row.max_order_rial),
  province: row.province, city: row.city, feeRial: String(row.fee_rial),
  position: row.position, active: row.active,
});
const serialize = (row: ShippingRow, rules: RuleRow[] = []) => ({
  id: row.id, code: row.code, name: row.name, active: row.active, type: row.type, pricingType: row.pricing_type,
  baseFeeRial: String(row.base_fee_rial), freeAboveRial: row.free_above_rial === null ? null : String(row.free_above_rial),
  estimatedMinDays: row.estimated_min_days, estimatedMaxDays: row.estimated_max_days, config: row.config ?? {},
  rules: rules.map(serializeRule),
});

async function rulesFor(pool: DbPool, methodId: string, activeOnly: boolean): Promise<RuleRow[]> {
  const rows = await pool.query<RuleRow>(
    `SELECT * FROM shipping_price_rules WHERE method_id = $1 AND ($2::boolean = false OR active = true)
     ORDER BY position, id`, [methodId, activeOnly]);
  return rows.rows;
}

/** Global shipping rules stored in site_settings — the default fulfillment warehouse is a real UUID. */
const shippingSettings = z.object({
  defaultWarehouseId: z.uuid().nullable(),
  freeShippingThresholdRial: z.string().regex(/^\d+$/),
  autoTracking: z.boolean(),
}).strict();

const DEFAULT_SHIPPING_SETTINGS = { defaultWarehouseId: null, freeShippingThresholdRial: '0', autoTracking: false };

export type ShippingQuoteInput = {
  items: { variantId: string; quantity: number }[];
  subtotalRial: bigint;
  province?: string | null;
  city?: string | null;
};
export type ShippingQuote = { feeRial: bigint; totalWeightGrams: number; ruleId: string | null; pricingType: string };

/** Server-authoritative shipping engine (items 83-84) — shared by checkout and the quote endpoint. */
export async function quoteShipping(client: PoolClient, methodId: string, input: ShippingQuoteInput): Promise<ShippingQuote> {
  const method = await one<{ id: string; active: boolean; pricing_type: string; base_fee_rial: string; free_above_rial: string | null; config: Record<string, unknown> }>(
    client as unknown as DbPool, 'SELECT id, active, pricing_type, base_fee_rial, free_above_rial, config FROM shipping_methods WHERE id = $1', [methodId]);
  if (!method) throw notFound();
  if (!method.active) throw badRequest('روش ارسال انتخاب‌شده غیرفعال است.');
  if (method.pricing_type === 'carrier') throw badRequest('نرخ‌گذاری این روش نیازمند اتصال به سامانه باربری است که هنوز پیکربندی نشده است.');
  if (method.pricing_type === 'free') return { feeRial: 0n, totalWeightGrams: 0, ruleId: null, pricingType: 'free' };
  const defaultWeight = typeof method.config?.defaultWeightGrams === 'number' && method.config.defaultWeightGrams >= 0
    ? Math.floor(method.config.defaultWeightGrams) : 500;
  let totalWeight = 0;
  for (const item of input.items) {
    const variant = await one<{ weight_grams: number | null }>(client as unknown as DbPool,
      'SELECT weight_grams FROM product_variants WHERE id = $1', [item.variantId]);
    if (!variant) throw badRequest('قلم سفارش معتبر نیست.');
    totalWeight += (variant.weight_grams ?? defaultWeight) * item.quantity;
  }
  const freeAbove = method.free_above_rial ? rial(method.free_above_rial) : null;
  if (freeAbove !== null && input.subtotalRial >= freeAbove) {
    return { feeRial: 0n, totalWeightGrams: totalWeight, ruleId: null, pricingType: method.pricing_type };
  }
  if (method.pricing_type === 'flat') {
    return { feeRial: rial(method.base_fee_rial), totalWeightGrams: totalWeight, ruleId: null, pricingType: 'flat' };
  }
  const rules = await rulesFor(client as unknown as DbPool, methodId, true);
  for (const rule of rules) {
    if (rule.min_weight_grams !== null && totalWeight < rule.min_weight_grams) continue;
    if (rule.max_weight_grams !== null && totalWeight > rule.max_weight_grams) continue;
    if (rule.min_order_rial !== null && input.subtotalRial < rial(String(rule.min_order_rial))) continue;
    if (rule.max_order_rial !== null && input.subtotalRial > rial(String(rule.max_order_rial))) continue;
    if (rule.province && rule.province !== input.province) continue;
    if (rule.city && rule.city !== input.city) continue;
    return { feeRial: rial(String(rule.fee_rial)), totalWeightGrams: totalWeight, ruleId: rule.id, pricingType: method.pricing_type };
  }
  // No rule matched — fall back to the base fee instead of blocking checkout.
  return { feeRial: rial(method.base_fee_rial), totalWeightGrams: totalWeight, ruleId: null, pricingType: method.pricing_type };
}

export function registerShippingRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Public list (active only) — no auth required? but we check principal optionally
  app.get('/api/v1/shipping-methods', async (request) => {
    // Public: return active methods without auth, or with auth
    try { await principal(request, pool, config); } catch { /* public */ }
    const rows = await pool.query(`SELECT id, code, name, active, type, pricing_type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config FROM shipping_methods WHERE active = true ORDER BY base_fee_rial ASC`);
    const items = [];
    for (const row of rows.rows) items.push(serialize(row, await rulesFor(pool, row.id, true)));
    return { items };
  });

  /** Public quote: checkout shows the same fee the server will charge. */
  app.post('/api/v1/shipping/quote', async (request) => {
    const body = z.object({
      methodId: z.uuid(),
      items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(10000) })).min(1).max(100),
      subtotalRial: z.string().regex(/^\d+$/).default('0'),
      province: z.string().trim().max(120).optional(),
      city: z.string().trim().max(120).optional(),
    }).strict().parse(request.body);
    const client = await pool.connect();
    try {
      const quote = await quoteShipping(client, body.methodId, {
        items: body.items, subtotalRial: rial(body.subtotalRial),
        province: body.province ?? null, city: body.city ?? null,
      });
      return { methodId: body.methodId, feeRial: quote.feeRial.toString(), totalWeightGrams: quote.totalWeightGrams, ruleId: quote.ruleId, pricingType: quote.pricingType };
    } finally { client.release(); }
  });

  app.get('/api/v1/admin/shipping-methods', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:read');
    const rows = await pool.query(`SELECT * FROM shipping_methods ORDER BY created_at DESC`);
    const items = [];
    for (const row of rows.rows) items.push(serialize(row, await rulesFor(pool, row.id, false)));
    return { items };
  });

  app.post('/api/v1/admin/shipping-methods', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const data = body.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO shipping_methods(id, code, name, active, type, pricing_type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, data.code, data.name, data.active, data.type, data.pricingType, data.baseFeeRial, data.freeAboveRial ?? null, data.estimatedMinDays, data.estimatedMaxDays, JSON.stringify(data.config)]);
      await audit(client, user.id, 'shipping.created', 'shipping_method', id, undefined, data, request.ip);
    });
    return reply.code(201).send(serialize({
      id, code: data.code, name: data.name, active: data.active, type: data.type, pricing_type: data.pricingType,
      base_fee_rial: data.baseFeeRial, free_above_rial: data.freeAboveRial ?? null,
      estimated_min_days: data.estimatedMinDays, estimated_max_days: data.estimatedMaxDays, config: data.config,
    }));
  });

  app.patch('/api/v1/admin/shipping-methods/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const data = patchBody.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<ShippingRow & Record<string, unknown>>(client, 'SELECT * FROM shipping_methods WHERE id = $1', [id]);
      if (!before) throw notFound();
      const fields: string[] = [];
      const vals: unknown[] = [id];
      const map: Record<string, string> = {
        code: 'code', name: 'name', active: 'active', type: 'type', pricingType: 'pricing_type',
        baseFeeRial: 'base_fee_rial', freeAboveRial: 'free_above_rial',
        estimatedMinDays: 'estimated_min_days', estimatedMaxDays: 'estimated_max_days', config: 'config'
      };
      for (const [k, col] of Object.entries(map)) {
        const v = (data as Record<string, unknown>)[k];
        if (v !== undefined) {
          vals.push(k === 'config' ? JSON.stringify(v) : v);
          fields.push(`${col} = $${vals.length}`);
        }
      }
      if (!fields.length) throw badRequest('تغییری وجود ندارد.');
      if (data.estimatedMinDays !== undefined || data.estimatedMaxDays !== undefined) {
        const min = data.estimatedMinDays ?? before.estimated_min_days;
        const max = data.estimatedMaxDays ?? before.estimated_max_days;
        if (max < min) throw badRequest('حداکثر روز باید >= حداقل باشد');
      }
      // NOTE: no extra bind value here — every placeholder above is $1..$n and the timestamp
      // comes from SQL `now()`. An extra parameter made PostgreSQL reject the statement (500).
      await client.query(`UPDATE shipping_methods SET ${fields.join(', ')}, updated_at = now() WHERE id = $1`, vals);
      await audit(client, user.id, 'shipping.updated', 'shipping_method', id, before, data, request.ip);
      const row = await one<ShippingRow>(client, 'SELECT * FROM shipping_methods WHERE id = $1', [id]);
      return serialize(row!, await rulesFor(client as unknown as DbPool, id, false));
    });
  });

  app.get('/api/v1/admin/shipping-methods/:id/rules', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const method = await one(pool, 'SELECT id FROM shipping_methods WHERE id = $1', [id]);
    if (!method) throw notFound();
    return { items: (await rulesFor(pool, id, false)).map(serializeRule) };
  });

  app.post('/api/v1/admin/shipping-methods/:id/rules', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const data = ruleBody.parse(request.body);
    const method = await one(pool, 'SELECT id FROM shipping_methods WHERE id = $1', [id]);
    if (!method) throw notFound();
    const ruleId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO shipping_price_rules(id, method_id, rule_type, min_weight_grams, max_weight_grams, min_order_rial, max_order_rial, province, city, fee_rial, position, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [ruleId, id, data.ruleType, data.minWeightGrams ?? null, data.maxWeightGrams ?? null,
          data.minOrderRial ?? null, data.maxOrderRial ?? null, data.province ?? null, data.city ?? null,
          data.feeRial, data.position, data.active]);
      await audit(client, user.id, 'shipping.rule_created', 'shipping_method', id, undefined, { ruleId, ...data }, request.ip);
    });
    const row = await one<RuleRow>(pool, 'SELECT * FROM shipping_price_rules WHERE id = $1', [ruleId]);
    return reply.code(201).send(serializeRule(row!));
  });

  app.patch('/api/v1/admin/shipping-rules/:ruleId', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { ruleId } = z.object({ ruleId: z.uuid() }).parse(request.params);
    const data = ruleBody.partial().strict().parse(request.body);
    if (!Object.keys(data).length) throw badRequest('تغییری وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one<RuleRow>(client, 'SELECT * FROM shipping_price_rules WHERE id = $1 FOR UPDATE', [ruleId]);
      if (!before) throw notFound();
      const map: Record<string, string> = { ruleType: 'rule_type', minWeightGrams: 'min_weight_grams', maxWeightGrams: 'max_weight_grams',
        minOrderRial: 'min_order_rial', maxOrderRial: 'max_order_rial', province: 'province', city: 'city',
        feeRial: 'fee_rial', position: 'position', active: 'active' };
      const vals: unknown[] = [ruleId];
      const fields: string[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (data as Record<string, unknown>)[k];
        if (v !== undefined) { vals.push(v); fields.push(`${col} = $${vals.length}`); }
      }
      await client.query(`UPDATE shipping_price_rules SET ${fields.join(', ')} WHERE id = $1`, vals);
      await audit(client, user.id, 'shipping.rule_updated', 'shipping_method', before.method_id, before, data, request.ip);
      const row = await one<RuleRow>(client, 'SELECT * FROM shipping_price_rules WHERE id = $1', [ruleId]);
      return serializeRule(row!);
    });
  });

  app.delete('/api/v1/admin/shipping-rules/:ruleId', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { ruleId } = z.object({ ruleId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM shipping_price_rules WHERE id = $1 RETURNING method_id', [ruleId]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (c) => audit(c, user.id, 'shipping.rule_deleted', 'shipping_method', String(deleted.rows[0].method_id), { ruleId }, undefined, request.ip));
    return { id: ruleId, deleted: true };
  });

  /** Global shipping rules (default fulfillment warehouse + free-shipping threshold). */
  app.get('/api/v1/admin/site-settings/shipping', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:read');
    const row = await one<{ value: typeof DEFAULT_SHIPPING_SETTINGS }>(pool, `SELECT value FROM site_settings WHERE key = 'shipping'`);
    return { settings: { ...DEFAULT_SHIPPING_SETTINGS, ...(row?.value ?? {}) } };
  });

  app.put('/api/v1/admin/site-settings/shipping', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const data = shippingSettings.parse(request.body);
    return transaction(pool, async (client) => {
      if (data.defaultWarehouseId) {
        const warehouse = await one(client, 'SELECT id FROM warehouses WHERE id = $1 AND active', [data.defaultWarehouseId]);
        if (!warehouse) throw badRequest('انبار پیش‌فرض انتخابی یافت نشد.');
      }
      const before = await one<{ value: unknown }>(client, `SELECT value FROM site_settings WHERE key = 'shipping' FOR UPDATE`);
      await client.query(
        `INSERT INTO site_settings(key, value, updated_by) VALUES ('shipping', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`,
        [JSON.stringify(data), user.id]);
      await audit(client, user.id, 'shipping.settings_updated', 'site_settings', 'shipping', before?.value, data, request.ip);
      return { settings: data };
    });
  });

  /** Public read: checkout shows the same rules the server enforces. */
  app.get('/api/v1/site/shipping-settings', async () => {
    const row = await one<{ value: typeof DEFAULT_SHIPPING_SETTINGS }>(pool, `SELECT value FROM site_settings WHERE key = 'shipping'`);
    return { settings: { ...DEFAULT_SHIPPING_SETTINGS, ...(row?.value ?? {}) } };
  });

  app.delete('/api/v1/admin/shipping-methods/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query(`UPDATE shipping_methods SET active = false, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!res.rows[0]) throw notFound();
    await transaction(pool, (c) => audit(c, user.id, 'shipping.deactivated', 'shipping_method', id, undefined, {}, request.ip));
    return { id, active: false };
  });
}
