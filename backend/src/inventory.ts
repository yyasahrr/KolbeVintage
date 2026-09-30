import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, requestHash } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { assertNotRestricted } from './console.js';

const warehouseBody = z.object({ code: z.string().regex(/^[A-Z0-9_-]{3,30}$/), name: z.string().trim().min(2).max(120) });
const locationBody = z.object({ code: z.string().regex(/^[A-Z0-9_-]{2,30}$/), name: z.string().trim().min(2).max(120) });
const adjustmentBody = z.object({
  variantId: z.uuid(), warehouseId: z.uuid(), delta: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
  reason: z.string().trim().min(4).max(500), reference: z.string().trim().min(3).max(120),
});
const receiptBody = z.object({
  warehouseId: z.uuid(), variantId: z.uuid(), quantity: z.number().int().min(1).max(100000),
  reference: z.string().trim().min(2).max(120).optional(),
});
const transferBody = z.object({
  fromWarehouseId: z.uuid(), toWarehouseId: z.uuid(),
  lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(100000) })).min(1).max(50),
  reference: z.string().trim().min(2).max(120).optional(),
});
const damagedBody = z.object({
  variantId: z.uuid(), warehouseId: z.uuid(), quantity: z.number().int().min(1).max(100000),
  reason: z.string().trim().min(4).max(500),
});

export function registerInventoryRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Warehouses: create & list with supplier isolation
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

  app.get('/api/v1/warehouses', async (request) => {
    const user = await principal(request, pool, config);
    const privileged = user.permissions.includes('inventory:read');
    const supplierOnly = user.roles.includes('supplier') && !privileged;
    const rows = await pool.query(
      `SELECT id, code, name, owner_id, active, created_at FROM warehouses
       WHERE ($1::boolean OR owner_id IS NULL OR owner_id = $2) AND ($2::uuid IS NOT NULL OR true)
       ORDER BY code`,
      [privileged, user.id]);
    // Filter supplier isolation server-side
    const filtered = supplierOnly ? rows.rows.filter((r: { owner_id: string | null }) => r.owner_id === user.id) : rows.rows;
    return { items: filtered };
  });

  app.get('/api/v1/warehouses/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<{ id: string; owner_id: string | null }>(pool, 'SELECT id, owner_id FROM warehouses WHERE id = $1', [id]);
    if (!row) throw notFound();
    const privileged = user.permissions.includes('inventory:read');
    if (!privileged && row.owner_id !== null && row.owner_id !== user.id) throw notFound();
    const warehouse = await one(pool, 'SELECT id, code, name, owner_id, active, created_at FROM warehouses WHERE id = $1', [id]);
    const locations = await pool.query('SELECT id, code, name, active, created_at FROM warehouse_locations WHERE warehouse_id = $1 ORDER BY code', [id]);
    const balances = await pool.query(
      `SELECT b.variant_id, v.sku, p.name AS product_name, b.on_hand, b.reserved, b.incoming, b.damaged,
              (b.on_hand - b.reserved - b.damaged) AS available, b.version
       FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
       WHERE b.warehouse_id = $1 ORDER BY v.sku LIMIT 200`, [id]);
    return { ...warehouse, locations: locations.rows, balances: balances.rows };
  });

  // Warehouse locations
  app.post('/api/v1/warehouses/:id/locations', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = locationBody.parse(request.body);
    const privileged = user.permissions.includes('inventory:adjust');
    const supplier = user.roles.includes('supplier') && !privileged;
    return transaction(pool, async (client) => {
      const wh = await one<{ owner_id: string | null }>(client, 'SELECT owner_id FROM warehouses WHERE id = $1', [id]);
      if (!wh) throw notFound();
      if (!privileged) {
        if (supplier) {
          if (wh.owner_id !== user.id) throw forbidden();
        } else requirePermission(user, 'inventory:adjust');
      }
      const locId = randomUUID();
      try {
        await client.query('INSERT INTO warehouse_locations(id,warehouse_id,code,name) VALUES ($1,$2,$3,$4)', [locId, id, body.code, body.name]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('کد مکان تکراری است.');
        throw e;
      }
      await audit(client, user.id, 'warehouse.location_created', 'warehouse_location', locId, undefined, { warehouseId: id, ...body }, request.ip);
      const row = await one(client, 'SELECT * FROM warehouse_locations WHERE id = $1', [locId]);
      return reply.code(201).send(row);
    });
  });

  app.get('/api/v1/warehouses/:id/locations', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const wh = await one<{ owner_id: string | null }>(pool, 'SELECT owner_id FROM warehouses WHERE id = $1', [id]);
    if (!wh) throw notFound();
    const privileged = user.permissions.includes('inventory:read');
    if (!privileged && wh.owner_id !== null && wh.owner_id !== user.id) throw notFound();
    const rows = await pool.query('SELECT id, code, name, active, created_at FROM warehouse_locations WHERE warehouse_id = $1 ORDER BY code', [id]);
    return { items: rows.rows };
  });

  // Inventory balances: available = on_hand - reserved - damaged, incoming not sellable
  app.get('/api/v1/inventory', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'inventory:read');
    const query = z.object({
      variantId: z.uuid().optional(),
      warehouseId: z.uuid().optional(),
      lowStock: z.coerce.number().int().min(0).max(1000000).optional(),
      search: z.string().max(100).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const privileged = user.permissions.includes('inventory:read');
    const rows = await pool.query(
      `SELECT b.variant_id, b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, v.sku, p.name AS product_name,
              b.on_hand, b.reserved, b.incoming, b.damaged, (b.on_hand - b.reserved - b.damaged) AS available, b.version
       FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
       JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
       WHERE ($1::uuid IS NULL OR b.variant_id = $1)
         AND ($2::uuid IS NULL OR b.warehouse_id = $2)
         AND ($3::text IS NULL OR v.sku ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%')
         AND ($4::boolean = true OR (w.owner_id = $5 AND p.supplier_id = $5))
         AND ($6::integer IS NULL OR (b.on_hand - b.reserved - b.damaged) <= $6)
       ORDER BY available ASC, v.sku LIMIT $7`,
      [query.variantId ?? null, query.warehouseId ?? null, query.search ?? null,
        privileged, user.id, query.lowStock ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/inventory/low-stock', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({ threshold: z.coerce.number().int().min(0).max(100000).default(10), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const privileged = user.permissions.includes('inventory:read');
    const rows = await pool.query(
      `SELECT b.variant_id, b.warehouse_id, w.name AS warehouse_name, v.sku, b.on_hand, b.reserved, b.damaged,
              (b.on_hand - b.reserved - b.damaged) AS available
       FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN product_variants v ON v.id = b.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE (b.on_hand - b.reserved - b.damaged) <= $1 AND ($2::boolean = true OR w.owner_id = $3)
       ORDER BY available ASC LIMIT $4`, [query.threshold, privileged, user.id, query.limit]);
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
      await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [body.variantId, body.warehouseId]);
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

  // Damaged stock separate: move on_hand -> damaged (or increase damaged)
  app.post('/api/v1/inventory/damaged', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = damagedBody.parse(request.body);
    requirePermission(user, 'inventory:adjust');
    const result = await transaction(pool, async (client) => {
      await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [body.variantId, body.warehouseId]);
      const bal = await one<{ on_hand: number; reserved: number; damaged: number }>(client,
        `UPDATE stock_balances SET damaged = damaged + $3, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand - reserved - damaged >= $3
         RETURNING on_hand, reserved, damaged`, [body.variantId, body.warehouseId, body.quantity]);
      if (!bal) throw conflict('موجودی قابل تبدیل به آسیب‌دیده کافی نیست.');
      const mid = randomUUID();
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,damaged_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'damaged',$6,$7,$8)`,
        [mid, body.variantId, body.warehouseId, body.quantity, body.reason, `damaged-${Date.now()}`, user.id, `damaged:${mid}`]);
      await audit(client, user.id, 'inventory.damaged', 'variant', body.variantId, undefined, body, request.ip);
      return { movementId: mid, damaged: bal.damaged, available: bal.on_hand - bal.reserved - bal.damaged };
    });
    return reply.code(201).send(result);
  });

  // Incoming stock / Receipts
  app.post('/api/v1/inventory/receipts', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = receiptBody.parse(request.body);
    requirePermission(user, 'inventory:adjust');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key لازم است.');
    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.receipt', key, requestHash(body));
      if (claim.previous) return claim.previous;
      await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [body.variantId, body.warehouseId]);
      await client.query(`UPDATE stock_balances SET incoming = incoming + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
        [body.variantId, body.warehouseId, body.quantity]);
      const id = randomUUID();
      const refSeq = await one<{ number: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS number");
      const reference = body.reference ?? `RCPT-${refSeq!.number}`;
      await client.query(`INSERT INTO stock_receipts(id,reference,warehouse_id,variant_id,quantity,status,created_by) VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
        [id, reference, body.warehouseId, body.variantId, body.quantity, user.id]);
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,'incoming stock','receipt',$5,$6,$7)`,
        [randomUUID(), body.variantId, body.warehouseId, body.quantity, id, user.id, `receipt:${key}`]);
      await audit(client, user.id, 'inventory.receipt_created', 'stock_receipt', id, undefined, body, request.ip);
      const res = { id, reference, status: 'pending', quantity: body.quantity };
      await completeIdempotency(client, user.id, 'inventory.receipt', key, res);
      return res;
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/inventory/receipts/:id/receive', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const r = await one<{ id: string; warehouse_id: string; variant_id: string; quantity: number; status: string }>(client,
        'SELECT * FROM stock_receipts WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound();
      if (r.status !== 'pending') throw conflict('این رسید قبلاً تعیین تکلیف شده است.');
      await client.query(`UPDATE stock_balances SET incoming = incoming - $3, on_hand = on_hand + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
        [r.variant_id, r.warehouse_id, r.quantity]);
      await client.query(`UPDATE stock_receipts SET status = 'received', received_at = now() WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'receipt confirmed','receipt',$6,$7,$8)`,
        [randomUUID(), r.variant_id, r.warehouse_id, r.quantity, -r.quantity, id, user.id, `receipt-confirm:${id}`]);
      await audit(client, user.id, 'inventory.receipt_received', 'stock_receipt', id, { status: r.status }, { status: 'received' }, request.ip);
      return { id, status: 'received' };
    });
  });

  app.get('/api/v1/inventory/receipts', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const rows = await pool.query(`SELECT * FROM stock_receipts ORDER BY created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  // Item 52: bulk adjustment — transactional all-or-nothing (≤200 lines).
  // For partial-success file workflows use the import center instead.
  app.post('/api/v1/inventory/bulk-adjustments', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const body = z.object({
      lines: z.array(z.object({
        variantId: z.uuid(), warehouseId: z.uuid(),
        delta: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
      })).min(1).max(200),
      reason: z.string().trim().min(4).max(500),
      reference: z.string().trim().min(3).max(120),
    }).strict().parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.bulk_adjust', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const movements: string[] = [];
      for (const [index, line] of body.lines.entries()) {
        const target = await one<{ id: string }>(client,
          'SELECT v.id FROM product_variants v JOIN warehouses w ON w.id = $2 WHERE v.id = $1 AND w.active = true',
          [line.variantId, line.warehouseId]);
        if (!target) throw notFound();
        await client.query('INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [line.variantId, line.warehouseId]);
        const balance = await one<{ on_hand: number }>(client,
          `UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand + $3 >= reserved + damaged
           RETURNING on_hand`, [line.variantId, line.warehouseId, line.delta]);
        if (!balance) throw conflict(`سطر ${index + 1}: اصلاح باعث منفی شدن موجودی قابل فروش می‌شود.`);
        const movementId = randomUUID();
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'adjustment',$6,$7,$8)`,
          [movementId, line.variantId, line.warehouseId, line.delta, body.reason, `${body.reference}#${index + 1}`, user.id, `bulk-adjust:${key}:${index}`]);
        movements.push(movementId);
      }
      await audit(client, user.id, 'inventory.bulk_adjusted', 'stock_balance', body.reference, undefined,
        { lines: body.lines.length, reason: body.reason }, request.ip);
      const result = { movements, lines: body.lines.length, reference: body.reference };
      await completeIdempotency(client, user.id, 'inventory.bulk_adjust', key, result);
      return result;
    });
    return reply.code(201).send(response);
  });

  // Item 52: bulk receipt — creates + immediately receives (≤200 lines).
  app.post('/api/v1/inventory/bulk-receipts', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const body = z.object({
      lines: z.array(z.object({
        variantId: z.uuid(), warehouseId: z.uuid(), quantity: z.number().int().min(1).max(100000),
      })).min(1).max(200),
      reference: z.string().trim().min(2).max(120).optional(),
    }).strict().parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key لازم است.');
    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.bulk_receipt', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const receipts: { id: string; reference: string }[] = [];
      for (const [index, line] of body.lines.entries()) {
        const target = await one<{ id: string }>(client,
          'SELECT v.id FROM product_variants v JOIN warehouses w ON w.id = $2 WHERE v.id = $1 AND w.active = true',
          [line.variantId, line.warehouseId]);
        if (!target) throw notFound();
        await client.query('INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [line.variantId, line.warehouseId]);
        const id = randomUUID();
        const refSeq = await one<{ number: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS number");
        const reference = body.reference ? `${body.reference}#${index + 1}` : `RCPT-${refSeq!.number}`;
        await client.query(`INSERT INTO stock_receipts(id,reference,warehouse_id,variant_id,quantity,status,created_by,received_at)
          VALUES ($1,$2,$3,$4,$5,'received',$6,now())`, [id, reference, line.warehouseId, line.variantId, line.quantity, user.id]);
        await client.query('UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2',
          [line.variantId, line.warehouseId, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,'bulk import receipt','receipt',$5,$6,$7)`,
          [randomUUID(), line.variantId, line.warehouseId, line.quantity, id, user.id, `bulk-receipt:${key}:${index}`]);
        receipts.push({ id, reference });
      }
      await audit(client, user.id, 'inventory.bulk_received', 'stock_receipt', body.reference ?? receipts[0]!.reference,
        undefined, { lines: body.lines.length }, request.ip);
      const result = { receipts, lines: body.lines.length };
      await completeIdempotency(client, user.id, 'inventory.bulk_receipt', key, result);
      return result;
    });
    return reply.code(201).send(response);
  });

  // Transfers: reserve and move
  app.post('/api/v1/inventory/transfers', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = transferBody.parse(request.body);
    const needPerm = user.permissions.includes('inventory:transfer') || user.permissions.includes('inventory:adjust');
    if (!needPerm) requirePermission(user, 'inventory:transfer');
    const result = await transaction(pool, async (client) => {
      const from = await one<{ owner_id: string | null }>(client, 'SELECT owner_id FROM warehouses WHERE id = $1', [body.fromWarehouseId]);
      const to = await one<{ owner_id: string | null }>(client, 'SELECT owner_id FROM warehouses WHERE id = $1', [body.toWarehouseId]);
      if (!from || !to) throw notFound();
      const supplier = user.roles.includes('supplier') && !user.permissions.includes('inventory:transfer');
      if (supplier && (from.owner_id !== user.id || to.owner_id !== user.id)) throw forbidden();
      const refSeq = await one<{ number: string }>(client, "SELECT nextval('transfer_reference_seq')::text AS number");
      const reference = body.reference ?? `TRF-${refSeq!.number}`;
      const transferId = randomUUID();
      await client.query(`INSERT INTO stock_transfers(id,reference,from_warehouse_id,to_warehouse_id,status,created_by) VALUES ($1,$2,$3,$4,'draft',$5)`,
        [transferId, reference, body.fromWarehouseId, body.toWarehouseId, user.id]);
      for (const line of body.lines) {
        await client.query(`INSERT INTO stock_transfer_lines(id,transfer_id,variant_id,quantity) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), transferId, line.variantId, line.quantity]);
        // Reserve / deduct from source immediately (available check)
        await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [line.variantId, body.fromWarehouseId]);
        await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [line.variantId, body.toWarehouseId]);
        const ok = await client.query(`UPDATE stock_balances SET on_hand = on_hand - $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand - reserved - damaged >= $3`,
          [line.variantId, body.fromWarehouseId, line.quantity]);
        if (!ok.rowCount) throw conflict(`موجودی قابل انتقال برای SKU کافی نیست.`);
      }
      // Mark in_transit and create movements
      await client.query(`UPDATE stock_transfers SET status = 'in_transit' WHERE id = $1`, [transferId]);
      for (const line of body.lines) {
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,'transfer out','transfer',$5,$6,$7)`,
          [randomUUID(), line.variantId, body.fromWarehouseId, -line.quantity, transferId, user.id, `trf-out:${transferId}:${line.variantId}`]);
        await client.query(`UPDATE stock_balances SET incoming = incoming + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
          [line.variantId, body.toWarehouseId, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,'transfer incoming','transfer',$5,$6,$7)`,
          [randomUUID(), line.variantId, body.toWarehouseId, line.quantity, transferId, user.id, `trf-in:${transferId}:${line.variantId}`]);
      }
      await audit(client, user.id, 'inventory.transfer_created', 'stock_transfer', transferId, undefined, body, request.ip);
      return { id: transferId, reference, status: 'in_transit' };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/inventory/transfers/:id/complete', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:transfer');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const tr = await one<{ id: string; to_warehouse_id: string; status: string }>(client, 'SELECT id, to_warehouse_id, status FROM stock_transfers WHERE id = $1 FOR UPDATE', [id]);
      if (!tr) throw notFound();
      if (tr.status !== 'in_transit') throw conflict('انتقال در وضعیت قابل تکمیل نیست.');
      const lines = await client.query<{ variant_id: string; quantity: number }>('SELECT variant_id, quantity FROM stock_transfer_lines WHERE transfer_id = $1', [id]);
      for (const line of lines.rows) {
        await client.query(`UPDATE stock_balances SET incoming = incoming - $3, on_hand = on_hand + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
          [line.variant_id, tr.to_warehouse_id, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'transfer completed','transfer',$6,$7,$8)`,
          [randomUUID(), line.variant_id, tr.to_warehouse_id, line.quantity, -line.quantity, id, user.id, `trf-complete:${id}:${line.variant_id}`]);
      }
      await client.query(`UPDATE stock_transfers SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'inventory.transfer_completed', 'stock_transfer', id, { status: tr.status }, { status: 'completed' }, request.ip);
      return { id, status: 'completed' };
    });
  });

  app.get('/api/v1/inventory/transfers', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const rows = await pool.query(`SELECT t.id, t.reference, t.from_warehouse_id, t.to_warehouse_id, t.status, t.created_at, t.completed_at,
        jsonb_agg(jsonb_build_object('variantId', l.variant_id, 'quantity', l.quantity)) AS lines
        FROM stock_transfers t LEFT JOIN stock_transfer_lines l ON l.transfer_id = t.id
        GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  app.get('/api/v1/inventory/movements', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ variantId: z.uuid(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT m.id,m.variant_id,m.warehouse_id,m.on_hand_delta,m.reserved_delta,m.incoming_delta,m.damaged_delta,m.reason,
              m.reference_type,m.reference_id,m.actor_id,m.created_at
       FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
       WHERE m.variant_id = $1 AND ($2::boolean = true OR w.owner_id = $3)
       ORDER BY m.created_at DESC LIMIT $4`,
      [query.variantId, user.permissions.includes('inventory:read'), user.id, query.limit]);
    return { items: rows.rows };
  });

  // Returns: inspection -> sellable/damaged (with RT- reference, buyer_id, history via audit)
  app.post('/api/v1/returns', async (request, reply) => {
    const user = await principal(request, pool, config);
    await assertNotRestricted(pool, user.id, 'return');
    const body = z.object({
      orderId: z.uuid(), orderLineId: z.uuid().optional(),
      reason: z.string().trim().min(4).max(1000),
      resolution: z.enum(['refund','exchange','credit']).default('refund'),
    }).strict().parse(request.body);
    const order = await one<{ buyer_id: string }>(pool, 'SELECT buyer_id FROM orders WHERE id = $1', [body.orderId]);
    if (!order) throw notFound();
    if (order.buyer_id !== user.id && !user.permissions.includes('returns:manage')) throw forbidden();
    const line = body.orderLineId ? await one<{ id: string; line_total_rial: string }>(pool, 'SELECT id, line_total_rial FROM order_lines WHERE id = $1 AND order_id = $2', [body.orderLineId, body.orderId]) : null;
    const amount = line ? line.line_total_rial : '0';
    const id = randomUUID();
    const seq = await one<{ number: string }>(pool, "SELECT nextval('return_reference_seq')::text AS number");
    const reference = `RT-${seq!.number}`;
    await pool.query(`INSERT INTO return_requests(id,reference,order_id,order_line_id,requester_id,buyer_id,reason,resolution,amount_rial) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, reference, body.orderId, body.orderLineId ?? null, user.id, order.buyer_id, body.reason, body.resolution, amount]);
    await transaction(pool, (client) => audit(client, user.id, 'return.requested', 'return', id, undefined, { reference, ...body }, request.ip));
    return reply.code(201).send({ id, reference, status: 'requested', amountRial: amount });
  });

  app.post('/api/v1/returns/:id/inspect', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'returns:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ result: z.enum(['sellable','damaged']), note: z.string().max(1000).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const ret = await one<{ id: string; order_line_id: string | null; status: string }>(client, 'SELECT id, order_line_id, status FROM return_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!ret) throw notFound();
      if (ret.status !== 'requested' && ret.status !== 'approved') throw conflict('مرجوعی قابل بازرسی نیست.');
      await client.query(`UPDATE return_requests SET inspection_result = $2, status = 'received', updated_at = now() WHERE id = $1`, [id, body.result]);
      if (ret.order_line_id) {
        const line = await one<{ variant_id: string; warehouse_id: string; quantity: number }>(client,
          `SELECT r.variant_id, r.warehouse_id, r.quantity FROM stock_reservations r WHERE r.order_line_id = $1`, [ret.order_line_id]);
        if (line) {
          if (body.result === 'sellable') {
            await client.query(`UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
              [line.variant_id, line.warehouse_id, line.quantity]);
            await client.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
              VALUES ($1,$2,$3,$4,'return sellable','return',$5,$6,$7)`, [randomUUID(), line.variant_id, line.warehouse_id, line.quantity, id, user.id, `ret-sell:${id}`]);
          } else {
            await client.query(`UPDATE stock_balances SET damaged = damaged + $3, on_hand = on_hand + $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
              [line.variant_id, line.warehouse_id, line.quantity]);
            await client.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,damaged_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
              VALUES ($1,$2,$3,$4,$5,'return damaged','return',$6,$7,$8)`, [randomUUID(), line.variant_id, line.warehouse_id, line.quantity, line.quantity, id, user.id, `ret-dam:${id}`]);
          }
        }
      }
      await audit(client, user.id, 'return.inspected', 'return', id, { status: ret.status }, { result: body.result }, request.ip);
      return { id, status: 'received', result: body.result };
    });
  });

  app.get('/api/v1/returns', async (request) => {
    const user = await principal(request, pool, config);
    const privileged = user.permissions.includes('returns:manage') || user.permissions.includes('returns:read');
    const rows = await pool.query(`SELECT * FROM return_requests WHERE ($1::boolean OR requester_id = $2) ORDER BY created_at DESC LIMIT 100`, [privileged, user.id]);
    return { items: rows.rows };
  });

  app.get('/api/v1/returns/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one(pool, 'SELECT * FROM return_requests WHERE id = $1', [id]);
    if (!row) throw notFound();
    const privileged = user.permissions.includes('returns:manage') || user.permissions.includes('returns:read');
    if ((row as any).requester_id !== user.id && (row as any).buyer_id !== user.id && !privileged) throw forbidden();
    const history = await pool.query(`SELECT action, actor_id, created_at, details FROM audit_logs WHERE entity_type = 'return' AND entity_id = $1 ORDER BY created_at`, [id]);
    return { ...row, history: history.rows };
  });

  app.get('/api/v1/admin/returns', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'returns:manage');
    const rows = await pool.query(`SELECT r.*, o.reference as order_reference, u.display_name as requester_name FROM return_requests r LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = r.requester_id ORDER BY r.created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  app.patch('/api/v1/admin/returns/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'returns:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['approved','received','refunded','rejected']), note: z.string().max(1000).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const ret = await one<any>(client, 'SELECT * FROM return_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!ret) throw notFound();
      const allowed: Record<string, string[]> = {
        requested: ['approved','rejected'],
        approved: ['received','rejected'],
        received: ['refunded','rejected'],
        refunded: [], rejected: []
      };
      if (!allowed[ret.status]?.includes(body.status)) throw badRequest('تغییر وضعیت مجاز نیست.');
      await client.query(`UPDATE return_requests SET status = $2, updated_at = now() WHERE id = $1`, [id, body.status]);
      await audit(client, user.id, 'return.status_changed', 'return', id, { status: ret.status }, { status: body.status, note: body.note }, request.ip);
      // If refunded, we would trigger finance ledger/payment refund — for now, mark as provider_pending if not configured
      // No fake paid — just status change
      return { id, reference: ret.reference, status: body.status };
    });
  });
}
