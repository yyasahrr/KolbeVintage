import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import type { DbPool } from './db.js';
import { one, transaction } from './db.js';
import { audit } from './operations.js';
import { badRequest, notFound } from './errors.js';

const body = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
  type: z.enum(['standard','express','free','pickup']),
  baseFeeRial: z.string().regex(/^\d+$/),
  freeAboveRial: z.string().regex(/^\d+$/).nullable().optional(),
  estimatedMinDays: z.number().int().min(0).max(60),
  estimatedMaxDays: z.number().int().min(0).max(60),
  config: z.record(z.string(), z.unknown()).default({}),
}).superRefine((v, ctx) => {
  if (v.estimatedMaxDays < v.estimatedMinDays) ctx.addIssue({ code: 'custom', message: 'حداکثر روز باید >= حداقل باشد' });
});

export function registerShippingRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Public list (active only) — no auth required? but we check principal optionally
  app.get('/api/v1/shipping-methods', async (request) => {
    // Public: return active methods without auth, or with auth
    try { await principal(request, pool, config); } catch { /* public */ }
    const rows = await pool.query(`SELECT id, code, name, active, type, base_fee_rial, free_above_rial, estimated_min_days, estimated_max_days, config FROM shipping_methods WHERE active = true ORDER BY base_fee_rial ASC`);
    // Map to camelCase
    return { items: rows.rows.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, active: r.active, type: r.type,
      baseFeeRial: r.base_fee_rial.toString(), freeAboveRial: r.free_above_rial?.toString() ?? null,
      estimatedMinDays: r.estimated_min_days, estimatedMaxDays: r.estimated_max_days, config: r.config
    })) };
  });

  app.get('/api/v1/admin/shipping-methods', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:read');
    const rows = await pool.query(`SELECT * FROM shipping_methods ORDER BY created_at DESC`);
    return { items: rows.rows.map((r: any) => ({
      id: r.id, code: r.code, name: r.name, active: r.active, type: r.type,
      baseFeeRial: r.base_fee_rial.toString(), freeAboveRial: r.free_above_rial?.toString() ?? null,
      estimatedMinDays: r.estimated_min_days, estimatedMaxDays: r.estimated_max_days, config: r.config
    })) };
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
    return reply.code(201).send({ id, ...data });
  });

  app.patch('/api/v1/admin/shipping-methods/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'shipping:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const data = body.partial().parse(request.body);
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
      vals.push(new Date().toISOString());
      // We'll just update updated_at manually
      await client.query(`UPDATE shipping_methods SET ${fields.join(', ')}, updated_at = now() WHERE id = $1`, vals);
      await audit(client, user.id, 'shipping.updated', 'shipping_method', id, before, data, request.ip);
      const row = await one(client, 'SELECT * FROM shipping_methods WHERE id = $1', [id]);
      return row;
    });
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
