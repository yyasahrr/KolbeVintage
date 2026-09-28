import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, requestHash } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

const warehouseBody = z.object({ code: z.string().regex(/^[A-Z0-9_-]{3,30}$/), name: z.string().trim().min(2).max(120) });
const adjustmentBody = z.object({
  variantId: z.uuid(), warehouseId: z.uuid(), delta: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
  reason: z.string().trim().min(4).max(500), reference: z.string().trim().min(3).max(120),
});

export function registerInventoryRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/warehouses', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = warehouseBody.parse(request.body);
    const supplier = user.roles.includes('supplier') && !user.roles.includes('admin');
    if (!supplier) requirePermission(user, 'inventory:adjust');
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        if (supplier) {
          const profile = await one<{ cooperation_status: string }>(client, 'SELECT cooperation_status FROM supplier_profiles WHERE user_id = $1', [user.id]);
          if (profile?.cooperation_status !== 'approved') throw forbidden();
        }
        await client.query('INSERT INTO warehouses(id,owner_id,code,name) VALUES ($1,$2,$3,$4)', [id, supplier ? user.id : null, body.code, body.name]);
        await audit(client, user.id, 'warehouse.created', 'warehouse', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد انبار تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id, ...body });
  });

  app.get('/api/v1/inventory', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'inventory:read');
    const query = z.object({ variantId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT b.variant_id, b.warehouse_id, w.name AS warehouse_name, v.sku, b.on_hand, b.reserved,
              b.incoming, b.damaged, (b.on_hand - b.reserved - b.damaged) AS available, b.version
       FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
       JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
       WHERE ($1::uuid IS NULL OR b.variant_id = $1)
         AND ($2::boolean = true OR (w.owner_id = $3 AND p.supplier_id = $3))
       ORDER BY v.sku, w.code LIMIT $4`,
      [query.variantId ?? null, user.permissions.includes('inventory:read'), user.id, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/inventory/adjustments', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = adjustmentBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.adjust', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const target = await one<{ owner_id: string | null; supplier_id: string | null }>(client,
        `SELECT w.owner_id, p.supplier_id FROM warehouses w CROSS JOIN product_variants v
         JOIN products p ON p.id = v.product_id WHERE w.id = $1 AND v.id = $2`, [body.warehouseId, body.variantId]);
      if (!target) throw notFound();
      if (user.roles.includes('supplier') && !user.permissions.includes('inventory:adjust')) {
        if (target.owner_id !== user.id || target.supplier_id !== user.id) throw forbidden();
      } else requirePermission(user, 'inventory:adjust');
      await client.query(
        `INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [body.variantId, body.warehouseId]);
      const balance = await one<{ on_hand: number; reserved: number; damaged: number; version: string }>(client,
        `UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand + $3 >= reserved + damaged
         RETURNING on_hand, reserved, damaged, version`, [body.variantId, body.warehouseId, body.delta]);
      if (!balance) throw conflict('اصلاح موجودی باعث منفی شدن موجودی قابل فروش می‌شود.');
      const movementId = randomUUID();
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'adjustment',$6,$7,$8)`,
        [movementId, body.variantId, body.warehouseId, body.delta, body.reason, body.reference, user.id, `adjust:${user.id}:${key}`]);
      await audit(client, user.id, 'inventory.adjusted', 'variant', body.variantId, undefined, { ...body, movementId }, request.ip);
      const result = { movementId, onHand: balance.on_hand, available: balance.on_hand - balance.reserved - balance.damaged, version: balance.version };
      await completeIdempotency(client, user.id, 'inventory.adjust', key, result);
      return result;
    });
    return reply.code(201).send(response);
  });

  app.get('/api/v1/inventory/movements', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ variantId: z.uuid(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT m.id,m.variant_id,m.warehouse_id,m.on_hand_delta,m.reserved_delta,m.reason,
              m.reference_type,m.reference_id,m.actor_id,m.created_at
       FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
       WHERE m.variant_id = $1 AND ($2::boolean = true OR w.owner_id = $3)
       ORDER BY m.created_at DESC LIMIT $4`,
      [query.variantId, user.permissions.includes('inventory:read'), user.id, query.limit]);
    return { items: rows.rows };
  });
}
