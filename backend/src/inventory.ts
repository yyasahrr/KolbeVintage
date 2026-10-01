import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, notifyByPermission, outbox, requestHash } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { assertNotRestricted } from './console.js';

export type InventoryDomain = 'retail' | 'wholesale';

/** O1: threshold under which available stock is flagged «کم» and low-stock alerts fire. */
export const LOW_STOCK_THRESHOLD = 5;

const warehouseBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{3,30}$/),
  name: z.string().trim().min(2).max(120),
});
const locationBody = z.object({
  code: z.string().regex(/^[A-Z0-9_-]{2,30}$/),
  name: z.string().trim().min(2).max(120),
});
const adjustmentBody = z.object({
  variantId: z.uuid(),
  warehouseId: z.uuid(),
  inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
  delta: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
  reason: z.string().trim().min(4).max(500),
  reference: z.string().trim().min(3).max(120),
  sourceDomain: z.unknown().optional(),
  destinationDomain: z.unknown().optional(),
  transferToDomain: z.unknown().optional(),
});
const receiptBody = z.object({
  warehouseId: z.uuid(),
  variantId: z.uuid(),
  inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
  quantity: z.number().int().min(1).max(100000),
  reference: z.string().trim().min(2).max(120).optional(),
  batchReference: z.string().trim().min(1).max(120).optional(),
});
const domainTransferBody = z.object({
  variantId: z.uuid(),
  sourceDomain: z.enum(['retail', 'wholesale']),
  destinationDomain: z.enum(['retail', 'wholesale']),
  sourceWarehouseId: z.uuid(),
  destinationWarehouseId: z.uuid(),
  quantity: z.number().int().min(1).max(100000),
  reason: z.string().trim().min(4).max(500),
  ownershipConversionId: z.uuid().optional(),
  confirmFullStock: z.boolean().optional(),
  batchReference: z.string().trim().min(1).max(120).optional(),
});
const multiLineTransferBody = z.object({
  fromWarehouseId: z.uuid(),
  toWarehouseId: z.uuid(),
  inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
  lines: z.array(z.object({
    variantId: z.uuid(),
    quantity: z.number().int().min(1).max(100000),
  })).min(1).max(50),
  reference: z.string().trim().min(2).max(120).optional(),
});
const ownershipConversionBody = z.object({
  productId: z.uuid(),
  variantId: z.uuid().optional(),
  conversionType: z.enum([
    'purchase_acquisition', 'ownership_transfer', 'consignment_conversion',
    'purchase_buyout', 'consignment_settled', 'contract_transfer',
  ]).default('purchase_acquisition'),
  referenceCode: z.string().trim().min(2).max(120).optional(),
  unitCostRial: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).optional(),
  quantity: z.number().int().min(1).max(100000).optional(),
  notes: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(1000).optional(),
  enableRetail: z.boolean().default(false),
});
const damagedBody = z.object({
  variantId: z.uuid(),
  warehouseId: z.uuid(),
  inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
  quantity: z.number().int().min(1).max(100000),
  reason: z.string().trim().min(4).max(500),
});

function inferDefaultDomain(target: {
  owner_id: string | null;
  supplier_id: string | null;
  owner_type: string;
  retail_enabled: boolean;
  wholesale_enabled: boolean;
  name?: string;
  installment_policy?: string;
}): InventoryDomain {
  if (target.owner_id !== null || target.owner_type === 'supplier' || target.supplier_id !== null || !target.retail_enabled) {
    return 'wholesale';
  }
  if (target.name?.includes('عمده') || target.installment_policy === 'disabled_when_discounted') {
    return 'wholesale';
  }
  return 'retail';
}

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
      `SELECT b.variant_id, v.sku, p.name AS product_name, b.inventory_domain, b.on_hand, b.reserved, b.incoming, b.damaged,
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
      inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
      lowStock: z.coerce.number().int().min(0).max(1000000).optional(),
      search: z.string().max(100).optional(),
      supplierId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const privileged = user.permissions.includes('inventory:read');
    // D3: real search across product name / SKU / color / size; O1: stock_status is
    // auto-computed on the server and never admin-editable.
    const rows = await pool.query(
      `SELECT b.variant_id, b.warehouse_id, b.inventory_domain, w.code AS warehouse_code, w.name AS warehouse_name,
              v.sku, v.size_label, v.color_label, p.id AS product_id, p.name AS product_name, p.owner_type,
              p.supplier_id, p.retail_enabled, p.status AS product_status,
              b.on_hand, b.reserved, b.incoming, b.damaged, (b.on_hand - b.reserved - b.damaged) AS available, b.version,
              CASE
                WHEN b.on_hand - b.reserved - b.damaged > 0 AND b.on_hand - b.reserved - b.damaged <= ${LOW_STOCK_THRESHOLD} THEN 'low_stock'
                WHEN b.on_hand - b.reserved - b.damaged > 0 THEN 'in_stock'
                WHEN b.on_hand > 0 AND b.reserved >= b.on_hand - b.damaged THEN 'fully_reserved'
                WHEN b.incoming > 0 THEN 'incoming'
                ELSE 'out_of_stock'
              END AS stock_status
       FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
       JOIN product_variants v ON v.id = b.variant_id JOIN products p ON p.id = v.product_id
       WHERE ($1::uuid IS NULL OR b.variant_id = $1)
         AND ($2::uuid IS NULL OR b.warehouse_id = $2)
         AND ($3::text IS NULL OR v.sku ILIKE '%' || $3 || '%' OR p.name ILIKE '%' || $3 || '%'
              OR v.color_label ILIKE '%' || $3 || '%' OR v.size_label ILIKE '%' || $3 || '%')
         AND ($4::boolean = true OR (w.owner_id = $5 AND p.supplier_id = $5 AND b.inventory_domain = 'wholesale'))
         AND ($6::integer IS NULL OR (b.on_hand - b.reserved - b.damaged) <= $6)
         AND ($8::text IS NULL OR b.inventory_domain = $8)
         AND ($9::uuid IS NULL OR p.supplier_id = $9)
       ORDER BY available ASC, v.sku, b.inventory_domain LIMIT $7`,
      [query.variantId ?? null, query.warehouseId ?? null, query.search ?? null,
        privileged, user.id, query.lowStock ?? null, query.limit, query.inventoryDomain ?? null,
        query.supplierId ?? null]);
    return { items: rows.rows };
  });

  app.get('/api/v1/inventory/variants/:variantId', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'inventory:read');
    const params = z.object({ variantId: z.uuid() }).parse(request.params);
    const variant = await one<{
      id: string;
      sku: string;
      size_label: string;
      color_label: string;
      product_id: string;
      product_name: string;
      owner_type: string;
      supplier_id: string | null;
    }>(
      pool,
      `SELECT v.id, v.sku, v.size_label, v.color_label, p.id AS product_id, p.name AS product_name, p.owner_type, p.supplier_id
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = $1`,
      [params.variantId],
    );
    if (!variant) throw notFound();
    const privileged = user.permissions.includes('inventory:read');
    if (!privileged && variant.supplier_id !== user.id) throw forbidden();

    const rows = await pool.query<{
      warehouse_id: string;
      warehouse_code: string;
      warehouse_name: string;
      inventory_domain: InventoryDomain;
      on_hand: number;
      reserved: number;
      incoming: number;
      damaged: number;
      available: number;
    }>(
      `SELECT b.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name, b.inventory_domain,
              b.on_hand, b.reserved, b.incoming, b.damaged,
              (b.on_hand - b.reserved - b.damaged) AS available
       FROM stock_balances b
       JOIN warehouses w ON w.id = b.warehouse_id
       WHERE b.variant_id = $1
         AND ($2::boolean = true OR (w.owner_id = $3 AND b.inventory_domain = 'wholesale'))
       ORDER BY b.inventory_domain, w.code`,
      [params.variantId, privileged, user.id],
    );

    const summarize = (domain: InventoryDomain) => {
      const domainRows = rows.rows.filter((r) => r.inventory_domain === domain);
      return domainRows.reduce(
        (acc, r) => ({
          on_hand: acc.on_hand + Number(r.on_hand),
          reserved: acc.reserved + Number(r.reserved),
          incoming: acc.incoming + Number(r.incoming),
          damaged: acc.damaged + Number(r.damaged),
          available: acc.available + Number(r.available),
        }),
        { on_hand: 0, reserved: 0, incoming: 0, damaged: 0, available: 0 },
      );
    };

    return {
      variantId: variant.id,
      sku: variant.sku,
      productId: variant.product_id,
      productName: variant.product_name,
      ownerType: variant.owner_type,
      size: variant.size_label,
      color: variant.color_label,
      wholesale: summarize('wholesale'),
      retail: privileged ? summarize('retail') : { on_hand: 0, reserved: 0, incoming: 0, damaged: 0, available: 0 },
      warehouses: rows.rows,
    };
  });

  app.get('/api/v1/inventory/low-stock', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({ threshold: z.coerce.number().int().min(0).max(100000).default(10), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const privileged = user.permissions.includes('inventory:read');
    const rows = await pool.query(
      `SELECT b.variant_id, b.warehouse_id, b.inventory_domain, w.name AS warehouse_name, v.sku, b.on_hand, b.reserved, b.damaged,
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
    if (body.sourceDomain !== undefined || body.destinationDomain !== undefined || body.transferToDomain !== undefined) {
      throw badRequest('انتقال موجودی بین عمده و خرده از طریق اصلاح دستی مجاز نیست؛ از مسیر رسمی انتقال موجودی (/api/v1/inventory/transfers) استفاده کنید.');
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.adjust', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const target = await one<{
        owner_id: string | null;
        supplier_id: string | null;
        owner_type: string;
        product_id: string;
        retail_enabled: boolean;
        wholesale_enabled: boolean;
        name: string;
        installment_policy: string;
      }>(client,
        `SELECT w.owner_id, p.supplier_id, p.owner_type, p.id AS product_id, p.retail_enabled, p.wholesale_enabled, p.name, p.installment_policy
         FROM warehouses w CROSS JOIN product_variants v
         JOIN products p ON p.id = v.product_id WHERE w.id = $1 AND v.id = $2`,
        [body.warehouseId, body.variantId]);
      if (!target) throw notFound();
      const isSupplierOnly = user.roles.includes('supplier') && !user.permissions.includes('inventory:adjust');
      if (isSupplierOnly) {
        if (target.owner_id !== user.id || target.supplier_id !== user.id) throw forbidden();
        if (body.inventoryDomain === 'retail') {
          throw forbidden('تأمین‌کننده مجاز به تغییر موجودی خرده‌فروشی کلبه نیست.');
        }
      } else {
        requirePermission(user, 'inventory:adjust');
      }

      const effectiveDomain: InventoryDomain = isSupplierOnly
        ? 'wholesale'
        : (body.inventoryDomain ?? inferDefaultDomain(target));

      if (effectiveDomain === 'retail' && target.owner_type === 'supplier') {
        const converted = await one<{ id: string }>(
          client,
          `SELECT id FROM ownership_conversions
           WHERE status = 'completed'
             AND (variant_id = $1 OR (variant_id IS NULL AND product_id = $2))
           LIMIT 1`,
          [body.variantId, target.product_id],
        );
        if (!converted) {
          throw forbidden('کالاهای متعلق به تأمین‌کننده بدون ثبت رسمی انتقال مالکیت به کلبه نمی‌توانند وارد موجودی خرده‌فروشی شوند.');
        }
      }

      await client.query(
        `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
        [body.variantId, body.warehouseId, effectiveDomain],
      );
      const balance = await one<{ on_hand: number; reserved: number; damaged: number; version: string }>(client,
        `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3 AND on_hand + $4 >= reserved + damaged
         RETURNING on_hand, reserved, damaged, version`,
        [body.variantId, body.warehouseId, effectiveDomain, body.delta]);
      if (!balance) throw conflict('اصلاح موجودی باعث منفی شدن موجودی قابل فروش در این دامنه می‌شود.');
      const movementId = randomUUID();
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'adjustment',$7,$8,$9)`,
        [movementId, body.variantId, body.warehouseId, effectiveDomain, body.delta, body.reason, body.reference, user.id, `adjust:${user.id}:${key}`]);
      await audit(client, user.id, 'inventory.adjusted', 'variant', body.variantId, undefined, { ...body, inventoryDomain: effectiveDomain, movementId }, request.ip);
      const result = {
        movementId,
        inventoryDomain: effectiveDomain,
        onHand: balance.on_hand,
        reserved: balance.reserved,
        available: balance.on_hand - balance.reserved - balance.damaged,
        version: balance.version,
      };
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
    const domain: InventoryDomain = body.inventoryDomain ?? 'retail';
    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
         ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
        [body.variantId, body.warehouseId, domain]);
      const bal = await one<{ on_hand: number; reserved: number; damaged: number }>(client,
        `UPDATE stock_balances SET damaged = damaged + $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3 AND on_hand - reserved - damaged >= $4
         RETURNING on_hand, reserved, damaged`,
        [body.variantId, body.warehouseId, domain, body.quantity]);
      if (!bal) throw conflict('موجودی قابل تبدیل به آسیب‌دیده کافی نیست.');
      const mid = randomUUID();
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,damaged_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'damaged',$7,$8,$9)`,
        [mid, body.variantId, body.warehouseId, domain, body.quantity, body.reason, `damaged-${Date.now()}`, user.id, `damaged:${mid}`]);
      await audit(client, user.id, 'inventory.damaged', 'variant', body.variantId, undefined, body, request.ip);
      return { movementId: mid, inventoryDomain: domain, damaged: bal.damaged, available: bal.on_hand - bal.reserved - bal.damaged };
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
    const domain: InventoryDomain = body.inventoryDomain ?? 'retail';
    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.receipt', key, requestHash(body));
      if (claim.previous) return claim.previous;
      await client.query(
        `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
         ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
        [body.variantId, body.warehouseId, domain]);
      await client.query(
        `UPDATE stock_balances SET incoming = incoming + $4, version = version + 1
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [body.variantId, body.warehouseId, domain, body.quantity]);
      const id = randomUUID();
      const refSeq = await one<{ number: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS number");
      const reference = body.reference ?? `RCPT-${refSeq!.number}`;
      await client.query(
        `INSERT INTO stock_receipts(id,reference,receipt_number,warehouse_id,variant_id,quantity,status,created_by,inventory_domain,batch_reference)
         VALUES ($1,$2,$2,$3,$4,$5,'pending',$6,$7,$8)`,
        [id, reference, body.warehouseId, body.variantId, body.quantity, user.id, domain, body.batchReference ?? null]);
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'incoming stock','receipt',$6,$7,$8)`,
        [randomUUID(), body.variantId, body.warehouseId, domain, body.quantity, id, user.id, `receipt:${key}`]);
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
    const body = z.object({
      receivedQuantity: z.number().int().min(0).max(100000).optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const r = await one<{
        id: string; warehouse_id: string; variant_id: string; quantity: number; status: string;
        inventory_domain: InventoryDomain; reference: string; supplier_request_id: string | null;
      }>(client,
        'SELECT * FROM stock_receipts WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound();
      if (r.status !== 'pending') throw conflict('این رسید قبلاً تعیین تکلیف شده است.');
      // D1 fix: the receipt's own inventory domain is authoritative — never hard-code retail.
      const domain: InventoryDomain = r.inventory_domain ?? 'retail';
      const received = body.receivedQuantity ?? r.quantity;
      if (received > r.quantity) {
        throw badRequest('تعداد دریافت‌شده نمی‌تواند از تعداد مورد انتظار رسید بیشتر باشد.');
      }
      const missing = r.quantity - received;
      await client.query(
        `UPDATE stock_balances SET incoming = GREATEST(0, incoming - $4), on_hand = on_hand + $3, version = version + 1
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $5`,
        [r.variant_id, r.warehouse_id, received, r.quantity, domain]);
      await client.query(
        `UPDATE stock_receipts SET status = 'received', received_at = now(), received_quantity = $2, missing_quantity = $3 WHERE id = $1`,
        [id, received, missing]);
      await client.query(
        `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'receipt',$8,$9,$10)`,
        [randomUUID(), r.variant_id, r.warehouse_id, domain, received, -r.quantity,
          missing > 0 ? `receipt confirmed (کسری ${missing} عدد)` : 'receipt confirmed',
          id, user.id, `receipt-confirm:${id}`]);
      await audit(client, user.id, 'inventory.receipt_received', 'stock_receipt', id, { status: r.status },
        { status: 'received', receivedQuantity: received, missingQuantity: missing, note: body.note ?? null }, request.ip);
      if (missing > 0) {
        // R: discrepancy is recorded as a first-class event, never silently confirmed.
        await outbox(client, 'inventory.receipt_discrepancy', 'stock_receipt', id,
          { reference: r.reference, expected: r.quantity, received, missing });
        await notifyByPermission(client, 'inventory:adjust', 'inventory.receipt_discrepancy.notify', 'stock_receipt', id,
          `مغایرت رسید ${r.reference}`,
          `از ${r.quantity} عدد مورد انتظار فقط ${received} عدد دریافت شد (کسری ${missing} عدد).`, 'high');
      }
      if (r.supplier_request_id) {
        await client.query(
          `UPDATE supplier_requests SET status = 'received', received_at = COALESCE(received_at, now()), updated_at = now()
           WHERE id = $1 AND status = 'dispatched'`,
          [r.supplier_request_id]);
      }
      return { id, status: 'received', inventoryDomain: domain, receivedQuantity: received, missingQuantity: missing };
    });
  });

  app.get('/api/v1/inventory/receipts', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const rows = await pool.query(`SELECT * FROM stock_receipts ORDER BY created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  // Item 52: bulk adjustment — transactional all-or-nothing (≤200 lines).
  app.post('/api/v1/inventory/bulk-adjustments', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const body = z.object({
      lines: z.array(z.object({
        variantId: z.uuid(),
        warehouseId: z.uuid(),
        inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
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
        const domain: InventoryDomain = line.inventoryDomain ?? 'retail';
        await client.query(
          `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
           ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
          [line.variantId, line.warehouseId, domain]);
        const balance = await one<{ on_hand: number }>(client,
          `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3 AND on_hand + $4 >= reserved + damaged
           RETURNING on_hand`,
          [line.variantId, line.warehouseId, domain, line.delta]);
        if (!balance) throw conflict(`سطر ${index + 1}: اصلاح باعث منفی شدن موجودی قابل فروش می‌شود.`);
        const movementId = randomUUID();
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,'adjustment',$7,$8,$9)`,
          [movementId, line.variantId, line.warehouseId, domain, line.delta, body.reason, `${body.reference}#${index + 1}`, user.id, `bulk-adjust:${key}:${index}`]);
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
        variantId: z.uuid(),
        warehouseId: z.uuid(),
        inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
        quantity: z.number().int().min(1).max(100000),
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
        const domain: InventoryDomain = line.inventoryDomain ?? 'retail';
        await client.query(
          `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
           ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
          [line.variantId, line.warehouseId, domain]);
        const id = randomUUID();
        const refSeq = await one<{ number: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS number");
        const reference = body.reference ? `${body.reference}#${index + 1}` : `RCPT-${refSeq!.number}`;
        await client.query(
          `INSERT INTO stock_receipts(id,reference,receipt_number,warehouse_id,variant_id,quantity,status,created_by,received_at)
           VALUES ($1,$2,$2,$3,$4,$5,'received',$6,now())`,
          [id, reference, line.warehouseId, line.variantId, line.quantity, user.id]);
        await client.query(
          `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
          [line.variantId, line.warehouseId, domain, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'bulk import receipt','receipt',$6,$7,$8)`,
          [randomUUID(), line.variantId, line.warehouseId, domain, line.quantity, id, user.id, `bulk-receipt:${key}:${index}`]);
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

  // Official Ownership Conversion (Supplier -> Kolbe) (Requirement 6)
  app.post('/api/v1/inventory/ownership-conversions', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:ownership') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز ثبت انتقال مالکیت کالا به کلبه را ندارید.');
    }
    const body = ownershipConversionBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) {
      throw badRequest('Idempotency-Key معتبر لازم است.');
    }

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.ownership', key, requestHash(body));
      if (claim.previous) return claim.previous;

      const product = await one<{ id: string; supplier_id: string | null; owner_type: string; retail_enabled: boolean }>(
        client,
        'SELECT id, supplier_id, owner_type, retail_enabled FROM products WHERE id = $1 FOR UPDATE',
        [body.productId],
      );
      if (!product) throw notFound();
      if (body.variantId) {
        const variant = await one<{ id: string }>(
          client,
          'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2',
          [body.variantId, body.productId],
        );
        if (!variant) throw notFound();
      }

      const seq = await one<{ num: string }>(client, "SELECT nextval('ownership_conversion_seq')::text AS num");
      const conversionNumber = `OWN-${seq!.num}`;
      const id = randomUUID();
      const unitCost = body.unitCostRial !== undefined ? rial(body.unitCostRial) : null;
      const qty = body.quantity ?? 1;
      const totalCost = unitCost !== null ? unitCost * BigInt(qty) : 0n;
      const noteText = body.notes ?? body.note ?? '';

      await client.query(
        `INSERT INTO ownership_conversions(
          id, reference, conversion_number, product_id, variant_id, from_owner_type, to_owner_type, supplier_id,
          conversion_type, reference_code, unit_cost_rial, total_cost_rial, quantity, notes, note,
          status, converted_by, actor_id, approved_by, completed_by, approved_at, completed_at
        ) VALUES ($1,$2,$2,$3,$4,'supplier','kolbe',$5,$6,$7,$8,$9,$10,$11,$11,'completed',$12,$12,$12,$12,now(),now())`,
        [
          id,
          conversionNumber,
          body.productId,
          body.variantId ?? null,
          product.supplier_id,
          body.conversionType,
          body.referenceCode ?? null,
          unitCost !== null ? unitCost.toString() : null,
          totalCost.toString(),
          qty,
          noteText,
          user.id,
        ],
      );

      if (!body.variantId) {
        await client.query(
          `UPDATE products
           SET owner_type = 'kolbe',
               retail_enabled = CASE WHEN $2::boolean THEN true ELSE retail_enabled END,
               ownership_converted_from_supplier_id = COALESCE(ownership_converted_from_supplier_id, supplier_id),
               ownership_converted_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [body.productId, body.enableRetail],
        );
      } else if (body.enableRetail) {
        await client.query(
          `UPDATE products SET retail_enabled = true, updated_at = now() WHERE id = $1`,
          [body.productId],
        );
      }

      const result = {
        id,
        conversionNumber,
        productId: body.productId,
        variantId: body.variantId ?? null,
        fromOwnerType: 'supplier',
        toOwnerType: 'kolbe',
        supplierId: product.supplier_id,
        conversionType: body.conversionType,
        referenceCode: body.referenceCode ?? null,
        status: 'completed',
      };
      await audit(client, user.id, 'inventory.ownership_converted', 'ownership_conversion', id, undefined, result, request.ip);
      await outbox(client, 'inventory.ownership_converted', 'ownership_conversion', id, result);
      await completeIdempotency(client, user.id, 'inventory.ownership', key, result);
      return result;
    });

    return reply.code(201).send(response);
  });

  app.post('/api/v1/inventory/ownership-conversions/:id/complete', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:ownership') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز تکمیل انتقال مالکیت کالا به کلبه را ندارید.');
    }
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const conv = await one<{
        id: string;
        conversion_number: string | null;
        product_id: string;
        variant_id: string | null;
        status: string;
      }>(client, 'SELECT id, conversion_number, product_id, variant_id, status FROM ownership_conversions WHERE id = $1 FOR UPDATE', [id]);
      if (!conv) throw notFound();
      await client.query(
        `UPDATE ownership_conversions
         SET status = 'completed', approved_by = COALESCE(approved_by, $2), completed_by = $2,
             approved_at = COALESCE(approved_at, now()), completed_at = COALESCE(completed_at, now()), updated_at = now()
         WHERE id = $1`,
        [id, user.id],
      );
      await client.query(
        `UPDATE products
         SET owner_type = 'kolbe',
             retail_enabled = true,
             ownership_converted_from_supplier_id = COALESCE(ownership_converted_from_supplier_id, supplier_id),
             ownership_converted_at = COALESCE(ownership_converted_at, now()),
             updated_at = now()
         WHERE id = $1`,
        [conv.product_id],
      );
      return {
        id: conv.id,
        conversionNumber: conv.conversion_number,
        productId: conv.product_id,
        variantId: conv.variant_id,
        status: 'completed',
      };
    });
  });

  app.get('/api/v1/inventory/ownership-conversions', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({ productId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT oc.*, p.name AS product_name, v.sku AS variant_sku
       FROM ownership_conversions oc
       JOIN products p ON p.id = oc.product_id
       LEFT JOIN product_variants v ON v.id = oc.variant_id
       WHERE ($1::uuid IS NULL OR oc.product_id = $1)
       ORDER BY oc.created_at DESC LIMIT $2`,
      [query.productId ?? null, query.limit],
    );
    return { items: rows.rows };
  });

  // Official Stock Transfer (Supports both Mode A: 3-step Domain/Warehouse transfer with ownership checks, and Mode B: Multi-line WMS warehouse transfer)
  app.post('/api/v1/inventory/transfers', async (request, reply) => {
    const user = await principal(request, pool, config);
    const needPerm = user.permissions.includes('inventory:transfer') || user.permissions.includes('inventory:adjust');
    if (!needPerm && !user.roles.includes('supplier')) throw forbidden('شما مجوز ثبت انتقال موجودی را ندارید.');

    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    if ('sourceDomain' in rawBody || 'destinationDomain' in rawBody || 'sourceWarehouseId' in rawBody) {
      // Mode A: Official 3-step Domain/Warehouse Stock Transfer (Requirements 5 & 6)
      if (!needPerm) throw forbidden('شما مجوز ثبت انتقال موجودی را ندارید.');
      const body = domainTransferBody.parse(request.body);
      if (body.sourceDomain === body.destinationDomain && body.sourceWarehouseId === body.destinationWarehouseId) {
        throw badRequest('مبدأ و مقصد انتقال موجودی نمی‌تواند یکسان باشد.');
      }
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 120) {
        throw badRequest('Idempotency-Key معتبر لازم است.');
      }

      const response = await transaction(pool, async (client) => {
        const claim = await claimIdempotency(client, user.id, 'inventory.transfer.create', key, requestHash(body));
        if (claim.previous) return claim.previous;

        const target = await one<{
          variant_id: string;
          product_id: string;
          owner_type: string;
          supplier_id: string | null;
        }>(
          client,
          `SELECT v.id AS variant_id, p.id AS product_id, p.owner_type, p.supplier_id
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           WHERE v.id = $1`,
          [body.variantId],
        );
        if (!target) throw notFound();

        const srcWh = await one<{ id: string; owner_id: string | null; active: boolean }>(
          client,
          'SELECT id, owner_id, active FROM warehouses WHERE id = $1',
          [body.sourceWarehouseId],
        );
        const dstWh = await one<{ id: string; owner_id: string | null; active: boolean }>(
          client,
          'SELECT id, owner_id, active FROM warehouses WHERE id = $1',
          [body.destinationWarehouseId],
        );
        if (!srcWh || !dstWh || !srcWh.active || !dstWh.active) throw notFound();

        // Requirement 6: Supplier-owned goods cannot enter retail inventory without an official ownership conversion to Kolbe
        let ownershipConversionId: string | null = body.ownershipConversionId ?? null;
        if (body.destinationDomain === 'retail') {
          if (dstWh.owner_id !== null) {
            throw forbidden('موجودی خرده‌فروشی فقط می‌تواند در انبار رسمی کلبه نگهداری شود.');
          }
          if (target.owner_type === 'supplier') {
            // G1: only stock whose ownership has REALLY been converted to Kolbe may enter retail.
            // A stale/draft conversion or one without enough remaining quantity must not suffice.
            if (ownershipConversionId) {
              const conv = await one<{ id: string; quantity: number; used_quantity: number; status: string }>(
                client,
                `SELECT id, quantity, used_quantity, status FROM ownership_conversions
                 WHERE id = $1 AND product_id = $2
                   AND (variant_id IS NULL OR variant_id = $3)
                   AND to_owner_type = 'kolbe'
                 FOR UPDATE`,
                [ownershipConversionId, target.product_id, body.variantId],
              );
              if (!conv) {
                throw forbidden('سند انتقال مالکیت نامعتبر است یا با این کالا مطابقت ندارد.');
              }
              if (conv.status !== 'completed') {
                throw forbidden('سند انتقال مالکیت هنوز نهایی نشده است؛ انتقال به خرده‌فروشی مجاز نیست.');
              }
              if (conv.quantity - conv.used_quantity < body.quantity) {
                throw forbidden(
                  `ظرفیت باقی‌مانده سند تملک کافی نیست (باقی‌مانده: ${conv.quantity - conv.used_quantity}، درخواستی: ${body.quantity}).`,
                );
              }
            } else {
              const existingConv = await one<{ id: string }>(
                client,
                `SELECT id FROM ownership_conversions
                 WHERE product_id = $1 AND (variant_id IS NULL OR variant_id = $2)
                   AND to_owner_type = 'kolbe' AND status = 'completed'
                   AND quantity - used_quantity >= $3
                 ORDER BY created_at DESC LIMIT 1
                 FOR UPDATE`,
                [target.product_id, body.variantId, body.quantity],
              );
              if (!existingConv) {
                throw forbidden('انتقال کالای متعلق به تأمین‌کننده به موجودی خرده‌فروشی بدون ثبت رسمی خرید/تملک توسط کلبه مجاز نیست.');
              }
              ownershipConversionId = existingConv.id;
            }
            // Consume conversion capacity now (restored if the draft transfer is cancelled).
            await client.query(
              `UPDATE ownership_conversions SET used_quantity = used_quantity + $2, updated_at = now() WHERE id = $1`,
              [ownershipConversionId, body.quantity],
            );
          }
        }

        const reservedSource = await one<{ on_hand: number; reserved: number; damaged: number }>(
          client,
          `UPDATE stock_balances
           SET reserved = reserved + $4, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3
             AND on_hand - reserved - damaged >= $4
           RETURNING on_hand, reserved, damaged`,
          [body.variantId, body.sourceWarehouseId, body.sourceDomain, body.quantity],
        );
        if (!reservedSource) {
          throw conflict('موجودی قابل انتقال در دامنه/انبار مبدأ کافی نیست.');
        }
        // G3: moving 100% of available stock needs an explicit confirmation flag.
        const availableAfter = reservedSource.on_hand - reservedSource.reserved - reservedSource.damaged;
        if (availableAfter === 0 && body.confirmFullStock !== true) {
          throw badRequest('این انتقال تمام موجودی قابل‌فروش مبدأ را جابه‌جا می‌کند؛ برای ادامه باید تأیید صریح انتقال کامل (confirmFullStock) ارسال شود.');
        }

        const seq = await one<{ number: string }>(client, "SELECT nextval('stock_transfer_seq')::text AS number");
        const transferNumber = `TRF-${seq!.number}`;
        const transferId = randomUUID();

        await client.query(
          `INSERT INTO stock_transfers(
            id, reference, transfer_number, variant_id, source_domain, destination_domain,
            from_warehouse_id, to_warehouse_id, source_warehouse_id, destination_warehouse_id,
            quantity, status, ownership_conversion_id, reason, created_by, actor_id, batch_reference
          ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$6,$7,$8,'draft',$9,$10,$11,$11,$12)`,
          [
            transferId,
            transferNumber,
            body.variantId,
            body.sourceDomain,
            body.destinationDomain,
            body.sourceWarehouseId,
            body.destinationWarehouseId,
            body.quantity,
            ownershipConversionId,
            body.reason,
            user.id,
            body.batchReference ?? null,
          ],
        );

        await client.query(
          `INSERT INTO stock_movements(
            id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason,
            reference_type, reference_id, actor_id, idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,'stock_transfer',$7,$8,$9)`,
          [
            randomUUID(),
            body.variantId,
            body.sourceWarehouseId,
            body.sourceDomain,
            body.quantity,
            `رزرو انتقال به ${body.destinationDomain}: ${body.reason}`,
            transferId,
            user.id,
            `transfer-reserve:${transferId}`,
          ],
        );

        const result = {
          id: transferId,
          transferNumber,
          status: 'draft',
          variantId: body.variantId,
          sourceDomain: body.sourceDomain,
          destinationDomain: body.destinationDomain,
          sourceWarehouseId: body.sourceWarehouseId,
          destinationWarehouseId: body.destinationWarehouseId,
          quantity: body.quantity,
          ownershipConversionId,
        };
        await audit(client, user.id, 'inventory.transfer_created', 'stock_transfer', transferId, undefined, result, request.ip);
        await completeIdempotency(client, user.id, 'inventory.transfer.create', key, result);
        return result;
      });
      return reply.code(201).send(response);
    }

    // Mode B: Canonical multi-line WMS warehouse transfer (draft -> in_transit -> completed)
    const body = multiLineTransferBody.parse(request.body);
    const domain: InventoryDomain = body.inventoryDomain ?? 'retail';
    const result = await transaction(pool, async (client) => {
      const from = await one<{ owner_id: string | null }>(client, 'SELECT owner_id FROM warehouses WHERE id = $1', [body.fromWarehouseId]);
      const to = await one<{ owner_id: string | null }>(client, 'SELECT owner_id FROM warehouses WHERE id = $1', [body.toWarehouseId]);
      if (!from || !to) throw notFound();
      const supplier = user.roles.includes('supplier') && !user.permissions.includes('inventory:transfer');
      if (supplier && (from.owner_id !== user.id || to.owner_id !== user.id)) throw forbidden();
      const refSeq = await one<{ number: string }>(client, "SELECT nextval('transfer_reference_seq')::text AS number");
      const reference = body.reference ?? `TRF-${refSeq!.number}`;
      const transferId = randomUUID();
      await client.query(
        `INSERT INTO stock_transfers(id,reference,transfer_number,from_warehouse_id,to_warehouse_id,source_warehouse_id,destination_warehouse_id,source_domain,destination_domain,status,created_by)
         VALUES ($1,$2,$2,$3,$4,$3,$4,$5,$5,'draft',$6)`,
        [transferId, reference, body.fromWarehouseId, body.toWarehouseId, domain, user.id]);
      for (const line of body.lines) {
        await client.query(`INSERT INTO stock_transfer_lines(id,transfer_id,variant_id,quantity) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), transferId, line.variantId, line.quantity]);
        await client.query(
          `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
           ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
          [line.variantId, body.fromWarehouseId, domain]);
        await client.query(
          `INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3)
           ON CONFLICT (variant_id,warehouse_id,inventory_domain) DO NOTHING`,
          [line.variantId, body.toWarehouseId, domain]);
        const ok = await client.query(
          `UPDATE stock_balances SET on_hand = on_hand - $4, version = version + 1
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3 AND on_hand - reserved - damaged >= $4`,
          [line.variantId, body.fromWarehouseId, domain, line.quantity]);
        if (!ok.rowCount) throw conflict(`موجودی قابل انتقال برای SKU کافی نیست.`);
      }
      await client.query(`UPDATE stock_transfers SET status = 'in_transit' WHERE id = $1`, [transferId]);
      for (const line of body.lines) {
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'transfer out','transfer',$6,$7,$8)`,
          [randomUUID(), line.variantId, body.fromWarehouseId, domain, -line.quantity, transferId, user.id, `trf-out:${transferId}:${line.variantId}`]);
        await client.query(
          `UPDATE stock_balances SET incoming = incoming + $4, version = version + 1
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
          [line.variantId, body.toWarehouseId, domain, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'transfer incoming','transfer',$6,$7,$8)`,
          [randomUUID(), line.variantId, body.toWarehouseId, domain, line.quantity, transferId, user.id, `trf-in:${transferId}:${line.variantId}`]);
      }
      await audit(client, user.id, 'inventory.transfer_created', 'stock_transfer', transferId, undefined, body, request.ip);
      return { id: transferId, reference, status: 'in_transit' };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/inventory/transfers/:id/approve', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:transfer') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز تأیید انتقال موجودی را ندارید.');
    }
    const params = z.object({ id: z.uuid() }).parse(request.params);

    return transaction(pool, async (client) => {
      const transfer = await one<{
        id: string;
        transfer_number: string;
        variant_id: string;
        source_domain: InventoryDomain;
        destination_domain: InventoryDomain;
        source_warehouse_id: string;
        destination_warehouse_id: string;
        quantity: number;
        status: string;
        reason: string;
      }>(
        client,
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (!transfer) throw notFound();
      if (transfer.status === 'in_transit' || transfer.status === 'completed') {
        return { id: transfer.id, transferNumber: transfer.transfer_number, status: transfer.status };
      }
      if (transfer.status !== 'draft') {
        throw conflict(`انتقال در وضعیت ${transfer.status} قابل تأیید نیست.`);
      }

      const sourceUpdated = await one<{ on_hand: number; reserved: number }>(
        client,
        `UPDATE stock_balances
         SET on_hand = on_hand - $4, reserved = reserved - $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3
           AND on_hand >= $4 AND reserved >= $4
         RETURNING on_hand, reserved`,
        [transfer.variant_id, transfer.source_warehouse_id, transfer.source_domain, transfer.quantity],
      );
      if (!sourceUpdated) {
        throw conflict('موجودی رزروشده در مبدأ برای خروج کافی نیست.');
      }

      await client.query(
        `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
        [transfer.variant_id, transfer.destination_warehouse_id, transfer.destination_domain],
      );

      await client.query(
        `UPDATE stock_balances
         SET incoming = incoming + $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [transfer.variant_id, transfer.destination_warehouse_id, transfer.destination_domain, transfer.quantity],
      );

      await client.query(
        `INSERT INTO stock_movements(
          id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reserved_delta, reason,
          reference_type, reference_id, actor_id, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'stock_transfer',$8,$9,$10)`,
        [
          randomUUID(),
          transfer.variant_id,
          transfer.source_warehouse_id,
          transfer.source_domain,
          -transfer.quantity,
          -transfer.quantity,
          `خروج از ${transfer.source_domain} بابت انتقال ${transfer.transfer_number}`,
          transfer.id,
          user.id,
          `transfer-dispatch-out:${transfer.id}`,
        ],
      );

      await client.query(
        `INSERT INTO stock_movements(
          id, variant_id, warehouse_id, inventory_domain, incoming_delta, reason,
          reference_type, reference_id, actor_id, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,'stock_transfer',$7,$8,$9)`,
        [
          randomUUID(),
          transfer.variant_id,
          transfer.destination_warehouse_id,
          transfer.destination_domain,
          transfer.quantity,
          `در راه به مقصد ${transfer.destination_domain} بابت انتقال ${transfer.transfer_number}`,
          transfer.id,
          user.id,
          `transfer-dispatch-in:${transfer.id}`,
        ],
      );

      await client.query(
        `UPDATE stock_transfers
         SET status = 'in_transit', approved_by = $2, approved_at = now(), updated_at = now()
         WHERE id = $1`,
        [transfer.id, user.id],
      );

      const out = { id: transfer.id, transferNumber: transfer.transfer_number, status: 'in_transit' };
      await audit(client, user.id, 'inventory.transfer_approved', 'stock_transfer', transfer.id, { status: 'draft' }, out, request.ip);
      return out;
    });
  });

  app.post('/api/v1/inventory/transfers/:id/complete', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:transfer') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز تکمیل انتقال موجودی را ندارید.');
    }
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const tr = await one<{
        id: string;
        transfer_number: string | null;
        variant_id: string | null;
        source_domain: InventoryDomain | null;
        destination_domain: InventoryDomain | null;
        to_warehouse_id: string | null;
        destination_warehouse_id: string | null;
        quantity: number | null;
        status: string;
        ownership_conversion_id: string | null;
      }>(
        client,
        `SELECT id, transfer_number, variant_id, source_domain, destination_domain,
                to_warehouse_id, destination_warehouse_id, quantity, status, ownership_conversion_id
         FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!tr) throw notFound();
      if (tr.status === 'completed') {
        return { id: tr.id, transferNumber: tr.transfer_number, status: 'completed' };
      }
      if (tr.status !== 'in_transit' && tr.status !== 'approved') {
        throw conflict(`انتقال در وضعیت ${tr.status} قابل تکمیل و دریافت در مقصد نیست.`);
      }

      if (tr.variant_id && tr.quantity) {
        // Mode A: Single-variant domain transfer completion
        const dstWhId = tr.destination_warehouse_id ?? tr.to_warehouse_id!;
        const dstDomain = tr.destination_domain ?? 'retail';
        const received = await one<{ on_hand: number; incoming: number; reserved: number; damaged: number }>(
          client,
          `UPDATE stock_balances
           SET incoming = incoming - $4, on_hand = on_hand + $4, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3
             AND incoming >= $4
           RETURNING on_hand, incoming, reserved, damaged`,
          [tr.variant_id, dstWhId, dstDomain, tr.quantity],
        );
        if (!received) {
          throw conflict('موجودی در راه مقصد برای دریافت کافی نیست.');
        }

        await client.query(
          `INSERT INTO stock_movements(
            id, variant_id, warehouse_id, inventory_domain, on_hand_delta, incoming_delta, reason,
            reference_type, reference_id, actor_id, idempotency_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'stock_transfer',$8,$9,$10)`,
          [
            randomUUID(),
            tr.variant_id,
            dstWhId,
            dstDomain,
            tr.quantity,
            -tr.quantity,
            `دریافت قطعی در ${dstDomain} بابت انتقال ${tr.transfer_number}`,
            tr.id,
            user.id,
            `transfer-complete:${tr.id}`,
          ],
        );

        // Q: anbar transfer ≠ store publication. Completing a wholesale→retail transfer
        // must NOT auto-enable retail sale; that remains an explicit admin decision.

        await client.query(
          `UPDATE stock_transfers
           SET status = 'completed', completed_by = $2, completed_at = now(), updated_at = now()
           WHERE id = $1`,
          [tr.id, user.id],
        );

        const out = {
          id: tr.id,
          transferNumber: tr.transfer_number,
          status: 'completed',
          destinationDomain: dstDomain,
          destinationAvailable: received.on_hand - received.reserved - received.damaged,
        };
        await audit(client, user.id, 'inventory.transfer_completed', 'stock_transfer', tr.id, { status: tr.status }, out, request.ip);
        await outbox(client, 'inventory.transfer_completed', 'stock_transfer', tr.id, out);
        return out;
      }

      // Mode B: Multi-line WMS warehouse transfer completion
      const domain = tr.destination_domain ?? 'retail';
      const dstWhId = tr.to_warehouse_id ?? tr.destination_warehouse_id!;
      const lines = await client.query<{ variant_id: string; quantity: number }>(
        'SELECT variant_id, quantity FROM stock_transfer_lines WHERE transfer_id = $1',
        [id]);
      for (const line of lines.rows) {
        await client.query(
          `UPDATE stock_balances SET incoming = GREATEST(0, incoming - $4), on_hand = on_hand + $4, version = version + 1
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
          [line.variant_id, dstWhId, domain, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,incoming_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,'transfer completed','transfer',$7,$8,$9)`,
          [randomUUID(), line.variant_id, dstWhId, domain, line.quantity, -line.quantity, id, user.id, `trf-complete:${id}:${line.variant_id}`]);
      }
      await client.query(`UPDATE stock_transfers SET status = 'completed', completed_by = $2, completed_at = now(), updated_at = now() WHERE id = $1`, [id, user.id]);
      await audit(client, user.id, 'inventory.transfer_completed', 'stock_transfer', id, { status: tr.status }, { status: 'completed' }, request.ip);
      return { id, status: 'completed' };
    });
  });

  app.post('/api/v1/inventory/transfers/:id/cancel', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:transfer') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز لغو انتقال موجودی را ندارید.');
    }
    const params = z.object({ id: z.uuid() }).parse(request.params);

    return transaction(pool, async (client) => {
      const transfer = await one<{
        id: string;
        transfer_number: string;
        variant_id: string;
        source_domain: InventoryDomain;
        source_warehouse_id: string;
        quantity: number;
        status: string;
      }>(
        client,
        `SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE`,
        [params.id],
      );
      if (!transfer) throw notFound();
      if (transfer.status === 'cancelled') {
        return { id: transfer.id, transferNumber: transfer.transfer_number, status: 'cancelled' };
      }
      if (transfer.status !== 'draft') {
        throw conflict('فقط انتقال‌های در وضعیت پیش‌نویس قابل لغو مستقیم هستند.');
      }

      await client.query(
        `UPDATE stock_balances
         SET reserved = GREATEST(0, reserved - $4), version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [transfer.variant_id, transfer.source_warehouse_id, transfer.source_domain, transfer.quantity],
      );

      await client.query(
        `INSERT INTO stock_movements(
          id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason,
          reference_type, reference_id, actor_id, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,'stock_transfer',$7,$8,$9)`,
        [
          randomUUID(),
          transfer.variant_id,
          transfer.source_warehouse_id,
          transfer.source_domain,
          -transfer.quantity,
          `آزادسازی رزرو بابت لغو انتقال ${transfer.transfer_number}`,
          transfer.id,
          user.id,
          `transfer-cancel:${transfer.id}`,
        ],
      );

      // G1: give back the ownership-conversion capacity consumed at creation.
      const convRow = await one<{ ownership_conversion_id: string | null }>(
        client, 'SELECT ownership_conversion_id FROM stock_transfers WHERE id = $1', [transfer.id]);
      if (convRow?.ownership_conversion_id) {
        await client.query(
          `UPDATE ownership_conversions SET used_quantity = GREATEST(0, used_quantity - $2), updated_at = now() WHERE id = $1`,
          [convRow.ownership_conversion_id, transfer.quantity],
        );
      }

      await client.query(`UPDATE stock_transfers SET status = 'cancelled', updated_at = now() WHERE id = $1`, [transfer.id]);
      const out = { id: transfer.id, transferNumber: transfer.transfer_number, status: 'cancelled' };
      await audit(client, user.id, 'inventory.transfer_cancelled', 'stock_transfer', transfer.id, { status: 'draft' }, out, request.ip);
      return out;
    });
  });

  // H. Reverse Transfer: completed transfers are immutable; corrections happen through a
  // dedicated reverse document (TRF-100 → RTRF-100) capped by what is still free at the
  // destination — sold/reserved stock can never be reversed.
  app.post('/api/v1/inventory/transfers/:id/reverse', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:transfer');
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      quantity: z.number().int().min(1).max(100000),
      reason: z.string().trim().min(4).max(500),
    }).parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) {
      throw badRequest('Idempotency-Key معتبر لازم است.');
    }

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inventory.transfer.reverse', key, requestHash({ ...body, id: params.id }));
      if (claim.previous) return claim.previous;

      const original = await one<{
        id: string;
        transfer_number: string | null;
        variant_id: string | null;
        source_domain: InventoryDomain | null;
        destination_domain: InventoryDomain | null;
        source_warehouse_id: string | null;
        destination_warehouse_id: string | null;
        quantity: number | null;
        reversed_quantity: number;
        status: string;
        is_reverse: boolean;
        ownership_conversion_id: string | null;
      }>(client, 'SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [params.id]);
      if (!original) throw notFound();
      if (original.is_reverse) throw conflict('سند برگشتی خودش قابل برگشت نیست.');
      if (original.status !== 'completed') throw conflict('فقط انتقال‌های تکمیل‌شده قابل برگشت هستند.');
      if (!original.variant_id || !original.quantity || !original.source_warehouse_id || !original.destination_warehouse_id) {
        throw conflict('این سند انتقال ساختار تک‌کالایی ندارد و از مسیر برگشت پشتیبانی نمی‌شود.');
      }

      const reversible = original.quantity - original.reversed_quantity;
      if (reversible <= 0) throw conflict('تمام مقدار این انتقال قبلاً برگشت خورده است.');
      if (body.quantity > reversible) {
        throw conflict(`حداکثر مقدار قابل برگشت ${reversible} عدد است (فروخته/رزروشده قابل برگشت نیست).`);
      }

      const srcDomain = original.destination_domain ?? 'retail';
      const dstDomain = original.source_domain ?? 'wholesale';

      // G4 applied in reverse: only free (not reserved / not damaged) destination stock can return.
      const srcBal = await one<{ on_hand: number; reserved: number; damaged: number }>(
        client,
        `UPDATE stock_balances
         SET on_hand = on_hand - $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3
           AND on_hand - reserved - damaged >= $4
         RETURNING on_hand, reserved, damaged`,
        [original.variant_id, original.destination_warehouse_id, srcDomain, body.quantity],
      );
      if (!srcBal) {
        throw conflict('موجودی آزاد کافی برای برگشت وجود ندارد؛ کالای فروخته‌شده یا رزروشده قابل برگشت نیست.');
      }

      await client.query(
        `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain) VALUES ($1,$2,$3)
         ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
        [original.variant_id, original.source_warehouse_id, dstDomain],
      );
      await client.query(
        `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [original.variant_id, original.source_warehouse_id, dstDomain, body.quantity],
      );

      // RTRF numbering mirrors the original (RTRF-100, then RTRF-100-2 for later partials).
      const priorReverses = await one<{ n: string }>(
        client, 'SELECT count(*)::text AS n FROM stock_transfers WHERE original_transfer_id = $1', [original.id]);
      const reverseIndex = Number(priorReverses?.n ?? '0');
      const baseNumber = (original.transfer_number ?? `TRF-${original.id.slice(0, 8)}`).replace(/^TRF/, 'RTRF');
      const reverseNumber = reverseIndex === 0 ? baseNumber : `${baseNumber}-${reverseIndex + 1}`;
      const reverseId = randomUUID();

      await client.query(
        `INSERT INTO stock_transfers(
          id, reference, transfer_number, variant_id, source_domain, destination_domain,
          from_warehouse_id, to_warehouse_id, source_warehouse_id, destination_warehouse_id,
          quantity, status, reason, created_by, actor_id, completed_by, completed_at,
          is_reverse, original_transfer_id
        ) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$6,$7,$8,'completed',$9,$10,$10,$10,now(),true,$11)`,
        [
          reverseId, reverseNumber, original.variant_id, srcDomain, dstDomain,
          original.destination_warehouse_id, original.source_warehouse_id,
          body.quantity, body.reason, user.id, original.id,
        ],
      );

      await client.query(
        `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'stock_transfer',$7,$8,$9)`,
        [randomUUID(), original.variant_id, original.destination_warehouse_id, srcDomain, -body.quantity,
          `برگشت ${reverseNumber} بابت انتقال ${original.transfer_number}: ${body.reason}`, reverseId, user.id, `transfer-reverse-out:${reverseId}`],
      );
      await client.query(
        `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,'stock_transfer',$7,$8,$9)`,
        [randomUUID(), original.variant_id, original.source_warehouse_id, dstDomain, body.quantity,
          `ورود برگشتی ${reverseNumber} به ${dstDomain}`, reverseId, user.id, `transfer-reverse-in:${reverseId}`],
      );

      await client.query(
        'UPDATE stock_transfers SET reversed_quantity = reversed_quantity + $2, updated_at = now() WHERE id = $1',
        [original.id, body.quantity],
      );

      // Returning goods frees the ownership-conversion capacity consumed by the original transfer.
      if (original.ownership_conversion_id) {
        await client.query(
          `UPDATE ownership_conversions SET used_quantity = GREATEST(0, used_quantity - $2), updated_at = now() WHERE id = $1`,
          [original.ownership_conversion_id, body.quantity],
        );
      }

      const out = {
        id: reverseId,
        transferNumber: reverseNumber,
        originalTransferId: original.id,
        originalTransferNumber: original.transfer_number,
        status: 'completed',
        quantity: body.quantity,
        remainingReversible: reversible - body.quantity,
      };
      await audit(client, user.id, 'inventory.transfer_reversed', 'stock_transfer', reverseId,
        { originalStatus: original.status, reversedBefore: original.reversed_quantity }, out, request.ip);
      await outbox(client, 'inventory.transfer_reversed', 'stock_transfer', reverseId, out);
      await notifyByPermission(client, 'inventory:transfer', 'inventory.transfer_reversed.notify', 'stock_transfer', reverseId,
        `برگشت انتقال ${reverseNumber}`,
        `${body.quantity} عدد از انتقال ${original.transfer_number} به انبار مبدأ برگشت داده شد.`, 'normal');
      await completeIdempotency(client, user.id, 'inventory.transfer.reverse', key, out);
      return out;
    });
    return reply.code(201).send(response);
  });

  app.get('/api/v1/inventory/transfers', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({
      status: z.enum(['draft', 'approved', 'in_transit', 'completed', 'cancelled']).optional(),
      variantId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT t.id, t.reference, t.transfer_number, t.variant_id, t.source_domain, t.destination_domain,
              t.from_warehouse_id, t.to_warehouse_id, t.source_warehouse_id, t.destination_warehouse_id,
              t.quantity, t.status, t.ownership_conversion_id, t.reason, t.created_at, t.completed_at,
              t.is_reverse, t.original_transfer_id, t.reversed_quantity, t.batch_reference,
              v.sku, v.sku AS variant_sku, v.size_label, v.color_label, p.name AS product_name, p.owner_type,
              sw.code AS source_warehouse_code, sw.name AS source_warehouse_name,
              dw.code AS destination_warehouse_code, dw.name AS destination_warehouse_name,
              COALESCE(jsonb_agg(jsonb_build_object('variantId', l.variant_id, 'quantity', l.quantity))
                FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM stock_transfers t
       LEFT JOIN product_variants v ON v.id = t.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN warehouses sw ON sw.id = COALESCE(t.source_warehouse_id, t.from_warehouse_id)
       LEFT JOIN warehouses dw ON dw.id = COALESCE(t.destination_warehouse_id, t.to_warehouse_id)
       LEFT JOIN stock_transfer_lines l ON l.transfer_id = t.id
       WHERE ($1::text IS NULL OR t.status = $1)
         AND ($2::uuid IS NULL OR t.variant_id = $2)
       GROUP BY t.id, v.sku, v.size_label, v.color_label, p.name, p.owner_type, sw.code, sw.name, dw.code, dw.name
       ORDER BY t.created_at DESC LIMIT $3`,
      [query.status ?? null, query.variantId ?? null, query.limit],
    );
    return { items: rows.rows };
  });

  app.get('/api/v1/inventory/transfers/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const params = z.object({ id: z.uuid() }).parse(request.params);
    const transfer = await one(
      pool,
      `SELECT t.*, v.sku, v.size_label, v.color_label, p.name AS product_name, p.owner_type,
              sw.code AS source_warehouse_code, sw.name AS source_warehouse_name,
              dw.code AS destination_warehouse_code, dw.name AS destination_warehouse_name
       FROM stock_transfers t
       LEFT JOIN product_variants v ON v.id = t.variant_id
       LEFT JOIN products p ON p.id = v.product_id
       LEFT JOIN warehouses sw ON sw.id = COALESCE(t.source_warehouse_id, t.from_warehouse_id)
       LEFT JOIN warehouses dw ON dw.id = COALESCE(t.destination_warehouse_id, t.to_warehouse_id)
       WHERE t.id = $1`,
      [params.id],
    );
    if (!transfer) throw notFound();
    const movements = await pool.query(
      `SELECT id, warehouse_id, inventory_domain, on_hand_delta, reserved_delta, incoming_delta, reason, created_at
       FROM stock_movements
       WHERE reference_type IN ('stock_transfer', 'transfer') AND reference_id = $1
       ORDER BY created_at ASC`,
      [params.id],
    );
    return { ...transfer, movements: movements.rows };
  });

  app.get('/api/v1/inventory/movements', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      variantId: z.uuid().optional(),
      inventoryDomain: z.enum(['retail', 'wholesale']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT m.id,m.variant_id,m.warehouse_id,m.inventory_domain,m.on_hand_delta,m.reserved_delta,m.incoming_delta,m.damaged_delta,m.reason,
              m.reference_type,m.reference_id,m.actor_id,m.created_at,v.sku,p.name AS product_name,w.name AS warehouse_name
       FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
       JOIN product_variants v ON v.id = m.variant_id JOIN products p ON p.id = v.product_id
       WHERE ($1::uuid IS NULL OR m.variant_id = $1)
         AND ($2::boolean = true OR w.owner_id = $3)
         AND ($5::text IS NULL OR m.inventory_domain = $5)
       ORDER BY m.created_at DESC LIMIT $4`,
      [query.variantId ?? null, user.permissions.includes('inventory:read'), user.id, query.limit, query.inventoryDomain ?? null]);
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
        const line = await one<{ variant_id: string; warehouse_id: string; inventory_domain: string | null; quantity: number }>(client,
          `SELECT r.variant_id, r.warehouse_id, r.inventory_domain, r.quantity FROM stock_reservations r WHERE r.order_line_id = $1`, [ret.order_line_id]);
        if (line) {
          const domain = line.inventory_domain ?? 'retail';
          if (body.result === 'sellable') {
            await client.query(
              `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1
               WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
              [line.variant_id, line.warehouse_id, domain, line.quantity]);
            await client.query(
              `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
               VALUES ($1,$2,$3,$4,$5,'return sellable','return',$6,$7,$8)`,
              [randomUUID(), line.variant_id, line.warehouse_id, domain, line.quantity, id, user.id, `ret-sell:${id}`]);
          } else {
            await client.query(
              `UPDATE stock_balances SET damaged = damaged + $4, on_hand = on_hand + $4, version = version + 1
               WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
              [line.variant_id, line.warehouse_id, domain, line.quantity]);
            await client.query(
              `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,damaged_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
               VALUES ($1,$2,$3,$4,$5,$6,'return damaged','return',$7,$8,$9)`,
              [randomUUID(), line.variant_id, line.warehouse_id, domain, line.quantity, line.quantity, id, user.id, `ret-dam:${id}`]);
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
      return { id, reference: ret.reference, status: body.status };
    });
  });
}
