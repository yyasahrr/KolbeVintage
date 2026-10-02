import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { loadSeriesComposition } from './series.js';

/**
 * Series inventory (Local QA scope §2-§8): the CENTRAL WHOLESALE warehouse counts in SERIES,
 * the retail warehouse counts in PIECES. A series here is a REAL explicit inventory state
 * (series_stock_balances + append-only series_stock_movements), not derived component math.
 *
 * Overlay model: variant stock_balances stay the piece bookkeeping of the same physical goods —
 * explicit series rows are a banding of those pieces, so every increase is validated against
 * component piece stock in the same warehouse (no fabricated series, §53).
 */

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export type SeriesOwner = { ownerType: 'kolbe' | 'supplier'; supplierId: string | null };

export type RecipeSnapshot = {
  templateId: string;
  templateName: string;
  productId: string;
  productName: string;
  colorLabel: string | null;
  piecesPerSeries: number;
  items: Array<{ variantId: string; sku: string; sizeLabel: string | null; colorLabel: string | null; quantityPerSeries: number }>;
};

/** Canonical recipe snapshot written on every sensitive series document (§6). */
export async function buildRecipeSnapshot(db: DbPool | DbClient, templateId: string): Promise<RecipeSnapshot> {
  const data = await loadSeriesComposition(db as DbPool, templateId);
  if (!data) throw notFound();
  const color = await one<{ color_label: string | null }>(db, 'SELECT color_label FROM series_templates WHERE id = $1', [templateId]);
  return {
    templateId: data.template.id,
    templateName: data.template.name,
    productId: data.template.product_id,
    productName: data.template.product_name,
    colorLabel: color?.color_label ?? null,
    piecesPerSeries: data.items.reduce((sum, item) => sum + item.quantity_per_series, 0),
    items: data.items.map((item) => ({
      variantId: item.variant_id,
      sku: item.sku,
      sizeLabel: item.size_label,
      colorLabel: item.color_label,
      quantityPerSeries: item.quantity_per_series,
    })),
  };
}

type SeriesBalanceRow = {
  id: string; series_template_id: string; warehouse_id: string;
  owner_type: 'kolbe' | 'supplier'; supplier_id: string | null;
  on_hand: number; reserved: number; incoming: number; damaged: number; version: number;
};

/** Lock (and lazily create) the explicit balance row for template×warehouse×owner. */
export async function seriesBalanceForUpdate(
  client: DbClient, templateId: string, warehouseId: string, owner: SeriesOwner,
): Promise<SeriesBalanceRow> {
  await client.query(
    `INSERT INTO series_stock_balances(id, series_template_id, warehouse_id, owner_type, supplier_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (series_template_id, warehouse_id, owner_type, COALESCE(supplier_id, '${ZERO_UUID}'::uuid)) DO NOTHING`,
    [randomUUID(), templateId, warehouseId, owner.ownerType, owner.supplierId]);
  const row = await one<SeriesBalanceRow>(
    client,
    `SELECT id, series_template_id, warehouse_id, owner_type, supplier_id, on_hand, reserved, incoming, damaged, version
     FROM series_stock_balances
     WHERE series_template_id = $1 AND warehouse_id = $2 AND owner_type = $3
       AND COALESCE(supplier_id, '${ZERO_UUID}'::uuid) = COALESCE($4::uuid, '${ZERO_UUID}'::uuid)
     FOR UPDATE`,
    [templateId, warehouseId, owner.ownerType, owner.supplierId]);
  if (!row) throw conflict('خطای همزمانی در موجودی سری؛ دوباره تلاش کنید.');
  return row;
}

/**
 * Apply one series movement atomically: balance deltas + append-only ledger row.
 * `quantity` in the ledger records the on_hand delta when present, otherwise the dominant delta.
 */
export async function applySeriesMovement(client: DbClient, input: {
  templateId: string; warehouseId: string; owner: SeriesOwner;
  movementType: 'stocktake' | 'receipt' | 'reserve' | 'release' | 'consume' | 'dispatch_break'
    | 'incoming' | 'incoming_receive' | 'incoming_cancel' | 'qc_reject' | 'adjust';
  onHandDelta?: number; reservedDelta?: number; incomingDelta?: number; damagedDelta?: number;
  recipeSnapshot?: RecipeSnapshot | null;
  referenceType?: string; referenceId?: string; note?: string; actorId?: string | null;
  idempotencyKey?: string | null;
}): Promise<SeriesBalanceRow> {
  const balance = await seriesBalanceForUpdate(client, input.templateId, input.warehouseId, input.owner);
  const onHand = balance.on_hand + (input.onHandDelta ?? 0);
  const reserved = balance.reserved + (input.reservedDelta ?? 0);
  const incoming = balance.incoming + (input.incomingDelta ?? 0);
  const damaged = balance.damaged + (input.damagedDelta ?? 0);
  if (onHand < 0 || reserved < 0 || incoming < 0 || damaged < 0) {
    throw conflict('موجودی سری کافی نیست.');
  }
  if (reserved > onHand) {
    throw conflict('سری قابل فروش کافی نیست (رزرو از موجودی بیشتر می‌شود).');
  }
  await client.query(
    `UPDATE series_stock_balances
     SET on_hand = $2, reserved = $3, incoming = $4, damaged = $5, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [balance.id, onHand, reserved, incoming, damaged]);
  const quantity = input.onHandDelta ?? input.reservedDelta ?? input.incomingDelta ?? input.damagedDelta ?? 0;
  if (quantity !== 0) {
    await client.query(
      `INSERT INTO series_stock_movements(id, series_template_id, warehouse_id, owner_type, supplier_id,
         movement_type, quantity, recipe_snapshot, reference_type, reference_id, note, actor_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), input.templateId, input.warehouseId, input.owner.ownerType, input.owner.supplierId,
        input.movementType, quantity, input.recipeSnapshot ? JSON.stringify(input.recipeSnapshot) : null,
        input.referenceType ?? null, input.referenceId ?? null, input.note ?? '', input.actorId ?? null,
        input.idempotencyKey ?? null]);
  }
  return { ...balance, on_hand: onHand, reserved, incoming, damaged };
}

/** Overlay guard (§53): intact series counted in a warehouse must be covered by component pieces there. */
async function assertSeriesCoveredByComponents(
  client: DbClient, templateId: string, warehouseId: string, totalSeriesOnHand: number,
): Promise<void> {
  if (totalSeriesOnHand <= 0) return;
  const short = await one<{ sku: string; needed: string; on_hand: string }>(
    client,
    `SELECT v.sku, (i.quantity_per_series * $3)::text AS needed, COALESCE(b.on_hand, 0)::text AS on_hand
     FROM series_template_items i
     JOIN product_variants v ON v.id = i.variant_id
     LEFT JOIN stock_balances b ON b.variant_id = i.variant_id AND b.warehouse_id = $2 AND b.inventory_domain = 'wholesale'
     WHERE i.series_template_id = $1 AND COALESCE(b.on_hand, 0) < i.quantity_per_series * $3
     ORDER BY v.sku LIMIT 1`,
    [templateId, warehouseId, totalSeriesOnHand]);
  if (short) {
    throw badRequest(
      `تعداد اعلام‌شده با موجودی عددی اجزا در این انبار نمی‌خواند: برای ${totalSeriesOnHand} سری کامل به ${short.needed} عدد از ${short.sku} نیاز است ولی ${short.on_hand} عدد موجود است. سری دست‌نخورده نمی‌تواند از هوا ساخته شود (ابتدا موجودی اجزا را اصلاح کنید).`);
  }
}

/** Total explicit series on_hand of a template in a warehouse across all owners (for the overlay guard). */
async function totalSeriesOnHand(client: DbClient, templateId: string, warehouseId: string): Promise<number> {
  const row = await one<{ total: string }>(
    client,
    `SELECT COALESCE(sum(on_hand), 0)::text AS total FROM series_stock_balances
     WHERE series_template_id = $1 AND warehouse_id = $2`,
    [templateId, warehouseId]);
  return Number(row?.total ?? '0');
}

export type WarehousePurposeRow = { id: string; name: string; purpose: 'retail' | 'wholesale' | 'mixed'; owner_id: string | null };

/** §40: server-side purpose guard — wholesale-unit operations only in wholesale-capable warehouses. */
export async function assertWarehousePurpose(
  db: DbPool | DbClient, warehouseId: string, expected: 'wholesale' | 'retail',
): Promise<WarehousePurposeRow> {
  const row = await one<WarehousePurposeRow>(db, 'SELECT id, name, purpose, owner_id FROM warehouses WHERE id = $1 AND active = true', [warehouseId]);
  if (!row) throw badRequest('انبار انتخاب‌شده معتبر یا فعال نیست.');
  if (row.purpose !== expected && row.purpose !== 'mixed') {
    throw badRequest(expected === 'wholesale'
      ? `انبار «${row.name}» انبار عمده نیست؛ عملیات سری فقط در انبار مرکزی عمده مجاز است.`
      : `انبار «${row.name}» انبار خرده نیست؛ مقصد تأمین خرده باید انبار خرده‌فروشی باشد.`);
  }
  return row;
}

/** Owner of a template's goods comes from its product (kolbe-purchased vs supplier-consignment). */
async function resolveTemplateOwnerContext(db: DbPool | DbClient, templateId: string) {
  const row = await one<{ id: string; product_id: string; product_name: string; supplier_id: string | null; active: boolean }>(
    db,
    `SELECT t.id, t.product_id, p.name AS product_name, p.supplier_id, t.active
     FROM series_templates t JOIN products p ON p.id = t.product_id WHERE t.id = $1`,
    [templateId]);
  if (!row) throw notFound();
  return row;
}

const ownerSchema = z.object({
  ownerType: z.enum(['kolbe', 'supplier']).default('kolbe'),
  supplierId: z.uuid().optional(),
});

export function registerSeriesInventoryRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // ---------------------------------------------------------------- list (§7, §49)
  app.get('/api/v1/inventory/series', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({
      search: z.string().trim().max(120).optional(),
      warehouseId: z.uuid().optional(),
      ownerType: z.enum(['kolbe', 'supplier']).optional(),
      supplierId: z.uuid().optional(),
      color: z.string().trim().max(60).optional(),
      status: z.enum(['available', 'reserved', 'incoming', 'empty']).optional(),
      withItems: z.coerce.number().int().min(0).max(1).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);

    // One row per Product+Color+Owner+Series template (+warehouse): explicit rows are the truth;
    // templates that were never counted appear as untracked rows with the legacy derived estimate.
    const rows = await pool.query<{
      series_template_id: string; template_name: string; template_active: boolean;
      product_id: string; product_name: string; color_label: string | null;
      pieces_per_series: number;
      warehouse_id: string | null; warehouse_name: string | null;
      owner_type: 'kolbe' | 'supplier'; supplier_id: string | null; supplier_name: string | null;
      on_hand: number; reserved: number; incoming: number; damaged: number;
      tracked: boolean; legacy_available: number; total: string;
    }>(
      `WITH legacy AS (
         SELECT i.series_template_id,
                GREATEST(0, min(floor(COALESCE(avail.available, 0) / i.quantity_per_series)))::int AS available_series
         FROM series_template_items i
         LEFT JOIN (
           SELECT variant_id, sum(on_hand - reserved - damaged) AS available
           FROM stock_balances WHERE inventory_domain = 'wholesale' GROUP BY variant_id
         ) avail ON avail.variant_id = i.variant_id
         GROUP BY i.series_template_id
       ), unified AS (
         SELECT t.id AS series_template_id, t.name AS template_name, t.active AS template_active,
                p.id AS product_id, p.name AS product_name, t.color_label,
                (SELECT COALESCE(sum(i.quantity_per_series),0) FROM series_template_items i WHERE i.series_template_id = t.id)::int AS pieces_per_series,
                b.warehouse_id, w.name AS warehouse_name,
                COALESCE(b.owner_type, CASE WHEN p.supplier_id IS NULL THEN 'kolbe' ELSE 'supplier' END) AS owner_type,
                COALESCE(b.supplier_id, CASE WHEN b.id IS NULL THEN p.supplier_id ELSE NULL END) AS supplier_id,
                COALESCE(b.on_hand, 0) AS on_hand, COALESCE(b.reserved, 0) AS reserved,
                COALESCE(b.incoming, 0) AS incoming, COALESCE(b.damaged, 0) AS damaged,
                (b.id IS NOT NULL) AS tracked,
                COALESCE(l.available_series, 0) AS legacy_available
         FROM series_templates t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN series_stock_balances b ON b.series_template_id = t.id
         LEFT JOIN warehouses w ON w.id = b.warehouse_id
         LEFT JOIN legacy l ON l.series_template_id = t.id
       )
       SELECT u.*, s.display_name AS supplier_name, count(*) OVER()::text AS total
       FROM unified u
       LEFT JOIN users s ON s.id = u.supplier_id
       WHERE ($1::text IS NULL OR u.product_name ILIKE '%' || $1 || '%' OR u.template_name ILIKE '%' || $1 || '%')
         AND ($2::uuid IS NULL OR u.warehouse_id = $2)
         AND ($3::text IS NULL OR u.owner_type = $3)
         AND ($4::uuid IS NULL OR u.supplier_id = $4)
         AND ($5::text IS NULL OR u.color_label ILIKE '%' || $5 || '%')
         AND ($6::text IS NULL
              OR ($6 = 'available' AND (u.on_hand - u.reserved) > 0)
              OR ($6 = 'reserved' AND u.reserved > 0)
              OR ($6 = 'incoming' AND u.incoming > 0)
              OR ($6 = 'empty' AND u.on_hand = 0 AND u.incoming = 0))
       ORDER BY u.product_name, u.color_label NULLS LAST, u.template_name, u.warehouse_name NULLS LAST, u.owner_type
       LIMIT $7 OFFSET $8`,
      [query.search ?? null, query.warehouseId ?? null, query.ownerType ?? null, query.supplierId ?? null,
        query.color ?? null, query.status ?? null, query.limit, query.offset]);

    const total = Number(rows.rows[0]?.total ?? '0');
    const items = await Promise.all(rows.rows.map(async ({ total: _t, ...row }) => {
      const sellable = Math.max(0, row.on_hand - row.reserved - row.damaged);
      const base = {
        ...row,
        sellable,
        // §8: supplier-owned goods can NEVER feed retail supply — surfaced server-side.
        retail_supply_allowed: row.owner_type === 'kolbe',
      };
      if (!query.withItems) return base;
      const composition = await loadSeriesComposition(pool, row.series_template_id);
      return { ...base, items: composition?.items ?? [] };
    }));
    return { items, total, limit: query.limit, offset: query.offset };
  });

  // ---------------------------------------------------------------- stocktake (§53)
  app.post('/api/v1/inventory/series/stocktake', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const body = z.object({
      seriesTemplateId: z.uuid(),
      warehouseId: z.uuid(),
      countedSeries: z.number().int().min(0).max(10000),
      note: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().trim().min(8).max(120).optional(),
    }).extend(ownerSchema.shape).parse(request.body);
    if ((body.ownerType === 'supplier') !== Boolean(body.supplierId)) {
      throw badRequest('برای مالکیت تأمین‌کننده باید خود تأمین‌کننده مشخص شود (و برعکس).');
    }

    const result = await transaction(pool, async (client) => {
      if (body.idempotencyKey) {
        const dupe = await one<{ id: string }>(client, 'SELECT id FROM series_stock_movements WHERE idempotency_key = $1', [body.idempotencyKey]);
        if (dupe) return { duplicate: true as const };
      }
      await assertWarehousePurpose(client, body.warehouseId, 'wholesale');
      const context = await resolveTemplateOwnerContext(client, body.seriesTemplateId);
      if (body.ownerType === 'supplier' && context.supplier_id !== body.supplierId) {
        throw badRequest('این تأمین‌کننده مالک محصولِ این سری نیست.');
      }
      if (body.ownerType === 'kolbe' && context.supplier_id !== null) {
        // Allowed: kolbe may have PURCHASED supplier-made goods; explicitly audited below.
      }
      const owner: SeriesOwner = { ownerType: body.ownerType, supplierId: body.supplierId ?? null };
      const balance = await seriesBalanceForUpdate(client, body.seriesTemplateId, body.warehouseId, owner);
      const delta = body.countedSeries - balance.on_hand;
      if (delta === 0) return { onHand: balance.on_hand, delta: 0 };
      if (delta > 0) {
        const total = await totalSeriesOnHand(client, body.seriesTemplateId, body.warehouseId);
        await assertSeriesCoveredByComponents(client, body.seriesTemplateId, body.warehouseId, total + delta);
      }
      if (body.countedSeries < balance.reserved) {
        throw conflict(`نمی‌توان کمتر از تعداد رزروشده (${balance.reserved} سری) اعلام کرد؛ ابتدا رزروها را تعیین تکلیف کنید.`);
      }
      const snapshot = await buildRecipeSnapshot(client, body.seriesTemplateId);
      const updated = await applySeriesMovement(client, {
        templateId: body.seriesTemplateId, warehouseId: body.warehouseId, owner,
        movementType: 'stocktake', onHandDelta: delta, recipeSnapshot: snapshot,
        referenceType: 'series_stocktake', note: body.note ?? '', actorId: user.id,
        idempotencyKey: body.idempotencyKey ?? null,
      });
      await audit(client, user.id, 'series_stock.stocktake', 'series_template', body.seriesTemplateId, { on_hand: balance.on_hand },
        { on_hand: updated.on_hand, delta, warehouseId: body.warehouseId, owner }, request.ip);
      return { onHand: updated.on_hand, delta };
    });
    if ('duplicate' in result) return reply.code(200).send({ duplicate: true });
    return reply.code(201).send(result);
  });

  // ---------------------------------------------------------------- movements (§18 timeline)
  app.get('/api/v1/inventory/series/movements', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const query = z.object({
      seriesTemplateId: z.uuid().optional(),
      warehouseId: z.uuid().optional(),
      referenceType: z.string().trim().max(60).optional(),
      referenceId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT m.id, m.series_template_id, t.name AS template_name, p.name AS product_name, t.color_label,
              m.warehouse_id, w.name AS warehouse_name, m.owner_type, m.supplier_id,
              m.movement_type, m.quantity, m.reference_type, m.reference_id, m.note, m.actor_id, u.display_name AS actor_name, m.created_at
       FROM series_stock_movements m
       JOIN series_templates t ON t.id = m.series_template_id
       JOIN products p ON p.id = t.product_id
       JOIN warehouses w ON w.id = m.warehouse_id
       LEFT JOIN users u ON u.id = m.actor_id
       WHERE ($1::uuid IS NULL OR m.series_template_id = $1)
         AND ($2::uuid IS NULL OR m.warehouse_id = $2)
         AND ($3::text IS NULL OR m.reference_type = $3)
         AND ($4::uuid IS NULL OR m.reference_id = $4)
       ORDER BY m.created_at DESC LIMIT $5`,
      [query.seriesTemplateId ?? null, query.warehouseId ?? null, query.referenceType ?? null, query.referenceId ?? null, query.limit]);
    return { items: rows.rows };
  });

  // ---------------------------------------------------------------- reconciliation report (§53)
  app.get('/api/v1/inventory/series/reconciliation', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    // Templates still running on legacy derived availability (component math) with no explicit count:
    const untracked = await pool.query(
      `SELECT t.id, t.name, p.name AS product_name, t.color_label,
              GREATEST(0, (SELECT min(floor(COALESCE(avail.available,0) / i.quantity_per_series))
                 FROM series_template_items i
                 LEFT JOIN (SELECT variant_id, sum(on_hand - reserved - damaged) AS available
                            FROM stock_balances WHERE inventory_domain = 'wholesale' GROUP BY variant_id) avail
                   ON avail.variant_id = i.variant_id
                 WHERE i.series_template_id = t.id))::int AS derived_available_series
       FROM series_templates t JOIN products p ON p.id = t.product_id
       WHERE t.active = true
         AND NOT EXISTS (SELECT 1 FROM series_stock_balances b WHERE b.series_template_id = t.id)
       ORDER BY p.name, t.name`);
    // Warehouses whose purpose is still ambiguous:
    const mixedWarehouses = await pool.query(
      `SELECT id, code, name, purpose FROM warehouses WHERE active = true AND purpose = 'mixed' ORDER BY code`);
    // Templates without a resolvable single color (recipe spans colors — legacy data):
    const colorless = await pool.query(
      `SELECT t.id, t.name, p.name AS product_name FROM series_templates t JOIN products p ON p.id = t.product_id
       WHERE t.active = true AND t.color_label IS NULL ORDER BY p.name, t.name`);
    return {
      untracked_templates: untracked.rows,
      mixed_purpose_warehouses: mixedWarehouses.rows,
      templates_without_color: colorless.rows,
      note: 'سری دست‌نخورده از موجودی عددی ساخته نمی‌شود؛ برای قالب‌های ردیابی‌نشده شمارش واقعی (stocktake) ثبت کنید.',
    };
  });

  // ---------------------------------------------------------------- warehouse purpose (§39)
  app.patch('/api/v1/warehouses/:id/purpose', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:adjust');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ purpose: z.enum(['retail', 'wholesale', 'mixed']) }).parse(request.body);
    return transaction(pool, async (client) => {
      const warehouse = await one<{ id: string; name: string; purpose: string; owner_id: string | null }>(
        client, 'SELECT id, name, purpose, owner_id FROM warehouses WHERE id = $1 FOR UPDATE', [id]);
      if (!warehouse) throw notFound();
      if (warehouse.owner_id !== null && !user.roles.includes('admin')) throw forbidden();
      if (body.purpose === 'retail') {
        const series = await one<{ c: string }>(client,
          `SELECT count(*)::text AS c FROM series_stock_balances WHERE warehouse_id = $1 AND (on_hand > 0 OR reserved > 0 OR incoming > 0)`, [id]);
        if (Number(series?.c ?? '0') > 0) throw conflict('این انبار موجودی سری دارد و نمی‌تواند خرده‌فروشی شود.');
        const wholesale = await one<{ c: string }>(client,
          `SELECT count(*)::text AS c FROM stock_balances WHERE warehouse_id = $1 AND inventory_domain = 'wholesale' AND on_hand > 0`, [id]);
        if (Number(wholesale?.c ?? '0') > 0) throw conflict('این انبار موجودی عمده دارد و نمی‌تواند خرده‌فروشی شود.');
      }
      if (body.purpose === 'wholesale') {
        const retail = await one<{ c: string }>(client,
          `SELECT count(*)::text AS c FROM stock_balances WHERE warehouse_id = $1 AND inventory_domain = 'retail' AND on_hand > 0`, [id]);
        if (Number(retail?.c ?? '0') > 0) throw conflict('این انبار موجودی خرده دارد و نمی‌تواند انبار عمده شود.');
      }
      await client.query('UPDATE warehouses SET purpose = $2 WHERE id = $1', [id, body.purpose]);
      await audit(client, user.id, 'warehouse.purpose_changed', 'warehouse', id, { purpose: warehouse.purpose }, { purpose: body.purpose }, request.ip);
      return { id, purpose: body.purpose };
    });
  });
}
