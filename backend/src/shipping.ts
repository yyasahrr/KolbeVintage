import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import type { DbPool } from './db.js';
import { one, transaction } from './db.js';
import { audit } from './operations.js';
import { badRequest, notFound } from './errors.js';

const fields = {
  code: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
  type: z.enum(['standard','express','free','pickup']),
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

/** Canonical wire shape for a shipping method — the frontend type mirrors this exactly. */
type ShippingRow = {
  id: string; code: string; name: string; active: boolean; type: string;
  base_fee_rial: string | number; free_above_rial: string | number | null;
  estimated_min_days: number; estimated_max_days: number; config: unknown;
};
const serialize = (row: ShippingRow) => ({
  id: row.id, code: row.code, name: row.name, active: row.active, type: row.type,
  baseFeeRial: String(row.base_fee_rial), freeAboveRial: row.free_above_rial === null ? null : String(row.free_above_rial),
  estimatedMinDays: row.estimated_min_days, estimatedMaxDays: row.estimated_max_days, config: row.config ?? {},
});

/** Global shipping rules stored in site_settings — the default fulfillment warehouse is a real UUID. */
const shippingSettings = z.object({
  defaultWarehouseId: z.uuid().nullable(),
  freeShippingThresholdRial: z.string().regex(/^\d+$/),
  autoTracking: z.boolean(),
}).strict();

const DEFAULT_SHIPPING_SETTINGS = { defaultWarehouseId: null, freeShippingThresholdRial: '0', autoTracking: false };

export function registerShippingRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Public list (active only) — no auth required? but we check principal optionally
  app.get('/api/v1/shipping-methods', async (request) => {
    // Public: return active methods without auth, or with auth
    try { await principal(request, pool, config); } catch { /* public */ }
    const rows = await pool.query(`SELECT id, code, name, active, type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config FROM shipping_methods WHERE active = true ORDER BY base_fee_rial ASC`);
    return { items: rows.rows.map(serialize) };
  });

  app.get('/api/v1/admin/shipping-methods', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:read');
    const rows = await pool.query(`SELECT * FROM shipping_methods ORDER BY created_at DESC`);
    return { items: rows.rows.map(serialize) };
  });

  app.post('/api/v1/admin/shipping-methods', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const data = body.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO shipping_methods(id, code, name, active, type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, data.code, data.name, data.active, data.type, data.baseFeeRial, data.freeAboveRial ?? null, data.estimatedMinDays, data.estimatedMaxDays, JSON.stringify(data.config)]);
      await audit(client, user.id, 'shipping.created', 'shipping_method', id, undefined, data, request.ip);
    });
    return reply.code(201).send(serialize({
      id, code: data.code, name: data.name, active: data.active, type: data.type,
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
      const before = await one<any>(client, 'SELECT * FROM shipping_methods WHERE id = $1', [id]);
      if (!before) throw notFound();
      const fields: string[] = [];
      const vals: unknown[] = [id];
      const map: Record<string, string> = {
        code: 'code', name: 'name', active: 'active', type: 'type',
        baseFeeRial: 'base_fee_rial', freeAboveRial: 'free_above_rial',
        estimatedMinDays: 'estimated_min_days', estimatedMaxDays: 'estimated_max_days', config: 'config'
      };
      for (const [k, col] of Object.entries(map)) {
        const v = (data as any)[k];
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
      return serialize(row!);
    });
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
