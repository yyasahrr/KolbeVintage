/* Supplier wholesale offers + external declared capacity (Master Prompt 1 §29-§36).
 *
 * Domain boundaries:
 *   OFFER        = «چگونه فروخته می‌شود؟» — price / min / max / fulfillment mode.
 *   AVAILABILITY = «الان چقدر قابل تأمین است؟» — declared capacity is the
 *                  supplier's CLAIM about its own external warehouse. It is
 *                  NEVER written into stock_balances / series_stock_balances;
 *                  WMS numbers stay physical, this stays declarative.
 *
 * External capacity reservations are an availability primitive (consumed by the
 * Prompt-2 order flow): atomic conditional UPDATE (no check-then-update), TTL
 * expiry, and they live here — NOT in stock_reservations (that table is for
 * physical WMS stock only).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

/* ----------------------------- freshness (§32) ----------------------------- */

export type FreshnessConfig = { freshDays: number; acceptableDays: number; needsUpdateDays: number };
const FRESHNESS_DEFAULTS: FreshnessConfig = { freshDays: 2, acceptableDays: 7, needsUpdateDays: 14 };

/** Thresholds are configuration, not hardcoded business facts (site_settings). */
export async function freshnessConfig(db: DbPool | DbClient): Promise<FreshnessConfig> {
  const row = await one<{ value: unknown }>(db, "SELECT value FROM site_settings WHERE key = 'supplier_capacity_freshness'");
  const raw = (row?.value ?? {}) as Partial<FreshnessConfig>;
  return {
    freshDays: Number(raw.freshDays ?? FRESHNESS_DEFAULTS.freshDays),
    acceptableDays: Number(raw.acceptableDays ?? FRESHNESS_DEFAULTS.acceptableDays),
    needsUpdateDays: Number(raw.needsUpdateDays ?? FRESHNESS_DEFAULTS.needsUpdateDays),
  };
}

export function freshnessState(confirmedAt: string | Date | null, cfg: FreshnessConfig): 'fresh' | 'acceptable' | 'needs_update' | 'stale' {
  if (!confirmedAt) return 'stale';
  const ageDays = (Date.now() - new Date(confirmedAt).getTime()) / 86_400_000;
  if (ageDays <= cfg.freshDays) return 'fresh';
  if (ageDays <= cfg.acceptableDays) return 'acceptable';
  if (ageDays <= cfg.needsUpdateDays) return 'needs_update';
  return 'stale';
}

/** §31: the formula is server-side and single-sourced. */
export function availableToRequest(offer: { declared_capacity: number; reserved_external: number; safety_buffer: number }): number {
  return Math.max(0, offer.declared_capacity - offer.reserved_external - offer.safety_buffer);
}

/* ----------------------------- capacity primitives (§33) ----------------------------- */

/**
 * Atomically reserve external supplier capacity. The guard lives in the UPDATE's
 * WHERE clause — two concurrent requests for the last unit cannot both win.
 */
export async function reserveSupplierCapacity(client: DbClient, input: {
  offerId: string; quantity: number; ttlMinutes?: number | null;
  referenceType?: string; referenceId?: string; note?: string;
  actorId: string; idempotencyKey?: string | null;
}): Promise<{ reservationId: string; availableAfter: number } | { duplicate: true; reservationId: string }> {
  if (input.idempotencyKey) {
    const dupe = await one<{ id: string }>(client,
      'SELECT id FROM supplier_capacity_reservations WHERE idempotency_key = $1', [input.idempotencyKey]);
    if (dupe) return { duplicate: true, reservationId: dupe.id };
  }
  const updated = await one<{ declared_capacity: number; reserved_external: number; safety_buffer: number }>(client,
    `UPDATE supplier_offers
     SET reserved_external = reserved_external + $2, version = version + 1, updated_at = now()
     WHERE id = $1 AND status = 'active'
       AND declared_capacity - reserved_external - safety_buffer >= $2
     RETURNING declared_capacity, reserved_external, safety_buffer`,
    [input.offerId, input.quantity]);
  if (!updated) throw conflict('ظرفیت اعلامی تأمین‌کننده برای این درخواست کافی نیست.');
  const reservationId = randomUUID();
  await client.query(
    `INSERT INTO supplier_capacity_reservations(id, offer_id, quantity, status, reference_type, reference_id, expires_at, note, idempotency_key, created_by)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9)`,
    [reservationId, input.offerId, input.quantity, input.referenceType ?? null, input.referenceId ?? null,
      input.ttlMinutes ? new Date(Date.now() + input.ttlMinutes * 60_000) : null,
      input.note ?? '', input.idempotencyKey ?? null, input.actorId]);
  return { reservationId, availableAfter: availableToRequest(updated) };
}

/** Release (or consume) an active reservation; both paths return the capacity atomically on release. */
export async function settleSupplierCapacityReservation(
  client: DbClient, reservationId: string, outcome: 'released' | 'consumed' | 'expired',
): Promise<{ offerId: string; quantity: number }> {
  const row = await one<{ id: string; offer_id: string; quantity: number; status: string }>(client,
    'SELECT id, offer_id, quantity, status FROM supplier_capacity_reservations WHERE id = $1 FOR UPDATE', [reservationId]);
  if (!row) throw notFound();
  if (row.status !== 'active') throw conflict('این رزرو ظرفیت قبلاً تعیین تکلیف شده است.');
  await client.query(
    `UPDATE supplier_capacity_reservations SET status = $2, updated_at = now() WHERE id = $1`, [reservationId, outcome]);
  if (outcome !== 'consumed') {
    await client.query(
      `UPDATE supplier_offers SET reserved_external = GREATEST(0, reserved_external - $2), version = version + 1, updated_at = now()
       WHERE id = $1`, [row.offer_id, row.quantity]);
  }
  return { offerId: row.offer_id, quantity: row.quantity };
}

/** TTL sweep (§33): expire overdue active reservations and free their capacity. */
export async function expireSupplierCapacityReservations(client: DbClient): Promise<number> {
  const due = await client.query<{ id: string }>(
    `SELECT id FROM supplier_capacity_reservations
     WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()
     ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 200`);
  for (const row of due.rows) await settleSupplierCapacityReservation(client, row.id, 'expired');
  return due.rows.length;
}

/* ----------------------------- offer read model ----------------------------- */

const OFFER_SELECT = `
  SELECT o.id, o.supplier_id, o.product_id, o.color_label, o.series_template_id, o.status,
         o.fulfillment_mode, o.wholesale_price_rial::text AS wholesale_price_rial,
         o.min_order_series, o.max_order_series, o.declared_capacity, o.reserved_external,
         o.safety_buffer, o.lead_time_days, o.capacity_confirmed_at, o.created_at, o.updated_at,
         p.name AS product_name, p.status AS product_status,
         t.name AS series_template_name, u.display_name AS supplier_name
  FROM supplier_offers o
  JOIN products p ON p.id = o.product_id
  LEFT JOIN series_templates t ON t.id = o.series_template_id
  JOIN users u ON u.id = o.supplier_id`;

type OfferRow = {
  id: string; supplier_id: string; product_id: string; color_label: string | null;
  series_template_id: string | null; status: string; fulfillment_mode: string;
  wholesale_price_rial: string | null; min_order_series: number; max_order_series: number | null;
  declared_capacity: number; reserved_external: number; safety_buffer: number;
  lead_time_days: number; capacity_confirmed_at: string | null;
  product_name: string; product_status: string; series_template_name: string | null; supplier_name: string;
};

function offerView(row: OfferRow, cfg: FreshnessConfig, opts?: { privacy?: boolean }) {
  return {
    id: row.id,
    // §55: privacy shape hides the supplier's identity entirely (id AND name).
    supplierId: opts?.privacy ? undefined : row.supplier_id,
    supplierName: opts?.privacy ? undefined : row.supplier_name,
    productId: row.product_id,
    productName: row.product_name,
    productStatus: row.product_status,
    colorLabel: row.color_label,
    seriesTemplateId: row.series_template_id,
    seriesTemplateName: row.series_template_name,
    status: row.status,
    fulfillmentMode: row.fulfillment_mode,
    wholesalePriceRial: row.wholesale_price_rial,
    minOrderSeries: row.min_order_series,
    maxOrderSeries: row.max_order_series,
    declaredCapacity: row.declared_capacity,
    reservedExternal: row.reserved_external,
    safetyBuffer: row.safety_buffer,
    availableToRequest: availableToRequest(row),
    leadTimeDays: row.lead_time_days,
    capacityConfirmedAt: row.capacity_confirmed_at,
    freshness: freshnessState(row.capacity_confirmed_at, cfg),
  };
}

/* ----------------------------- routes ----------------------------- */

const offerBody = z.object({
  productId: z.uuid(),
  colorLabel: z.string().trim().min(1).max(60).nullable().optional(),
  seriesTemplateId: z.uuid().nullable().optional(),
  fulfillmentMode: z.enum(['order_driven', 'stock_at_kolbe', 'hybrid']).default('order_driven'),
  wholesalePriceRial: z.string().regex(/^\d+$/).nullable().optional(),
  minOrderSeries: z.number().int().min(1).max(10000).default(1),
  maxOrderSeries: z.number().int().min(1).max(10000).nullable().optional(),
  safetyBuffer: z.number().int().min(0).max(10000).default(0),
  leadTimeDays: z.number().int().min(0).max(60).default(3),
}).strict();

async function assertSupplierOwnsProduct(db: DbPool | DbClient, user: Principal, productId: string) {
  const product = await one<{ id: string; supplier_id: string | null; owner_type: string }>(
    db, 'SELECT id, supplier_id, owner_type FROM products WHERE id = $1', [productId]);
  if (!product) throw notFound();
  // §7: the offer links to the canonical product; a supplier may only offer
  // products submitted under its own account (IDOR guard).
  if (product.owner_type !== 'supplier' || product.supplier_id !== user.id) {
    throw forbidden('فقط برای محصولات ثبت‌شده توسط خودتان می‌توانید پیشنهاد عمده ثبت کنید.');
  }
  return product;
}

export function registerSupplierOfferRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const isSupplier = (user: Principal) => user.roles.includes('supplier');

  /** Supplier creates/updates its own offer (upsert on the exact scope). */
  app.post('/api/v1/supplier/offers', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!isSupplier(user)) throw forbidden();
    const body = offerBody.parse(request.body);
    if (body.maxOrderSeries != null && body.maxOrderSeries < body.minOrderSeries) {
      throw badRequest('حداکثر سفارش نمی‌تواند از حداقل سفارش کمتر باشد.');
    }
    const result = await transaction(pool, async (client) => {
      await assertSupplierOwnsProduct(client, user, body.productId);
      if (body.seriesTemplateId) {
        const tpl = await one<{ id: string; product_id: string; color_label: string | null }>(client,
          'SELECT id, product_id, color_label FROM series_templates WHERE id = $1 AND active', [body.seriesTemplateId]);
        if (!tpl || tpl.product_id !== body.productId) throw badRequest('قالب سری متعلق به این محصول نیست.');
        if (body.colorLabel && tpl.color_label && tpl.color_label !== body.colorLabel) {
          throw badRequest('رنگ پیشنهاد با رنگ قالب سری نمی‌خواند.');
        }
      }
      const existing = await one<{ id: string }>(client,
        `SELECT id FROM supplier_offers
         WHERE supplier_id = $1 AND product_id = $2 AND COALESCE(color_label,'') = COALESCE($3,'')
           AND COALESCE(series_template_id,'00000000-0000-0000-0000-000000000000'::uuid)
             = COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`,
        [user.id, body.productId, body.colorLabel ?? null, body.seriesTemplateId ?? null]);
      const id = existing?.id ?? randomUUID();
      if (existing) {
        await client.query(
          `UPDATE supplier_offers SET fulfillment_mode = $2, wholesale_price_rial = $3, min_order_series = $4,
             max_order_series = $5, safety_buffer = $6, lead_time_days = $7, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [id, body.fulfillmentMode, body.wholesalePriceRial ?? null, body.minOrderSeries,
            body.maxOrderSeries ?? null, body.safetyBuffer, body.leadTimeDays]);
      } else {
        await client.query(
          `INSERT INTO supplier_offers(id, supplier_id, product_id, color_label, series_template_id, fulfillment_mode,
             wholesale_price_rial, min_order_series, max_order_series, safety_buffer, lead_time_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, user.id, body.productId, body.colorLabel ?? null, body.seriesTemplateId ?? null, body.fulfillmentMode,
            body.wholesalePriceRial ?? null, body.minOrderSeries, body.maxOrderSeries ?? null,
            body.safetyBuffer, body.leadTimeDays]);
      }
      await audit(client, user.id, existing ? 'supplier_offer.updated' : 'supplier_offer.created', 'supplier_offer', id,
        undefined, { productId: body.productId, colorLabel: body.colorLabel ?? null, fulfillmentMode: body.fulfillmentMode,
          minOrderSeries: body.minOrderSeries, maxOrderSeries: body.maxOrderSeries ?? null }, request.ip);
      return { id, updated: Boolean(existing) };
    });
    return reply.code(result.updated ? 200 : 201).send(result);
  });

  /** Supplier: own offers. Admin (suppliers:manage): all offers, filterable. */
  app.get('/api/v1/supplier/offers', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      supplierId: z.uuid().optional(), productId: z.uuid().optional(),
      status: z.enum(['active', 'paused', 'archived']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const admin = user.permissions.includes('suppliers:manage');
    if (!admin && !isSupplier(user)) throw forbidden();
    const supplierId = admin ? (query.supplierId ?? null) : user.id; // IDOR: suppliers never cross scope
    const where: string[] = []; const params: unknown[] = [];
    if (supplierId) { params.push(supplierId); where.push(`o.supplier_id = $${params.length}`); }
    if (query.productId) { params.push(query.productId); where.push(`o.product_id = $${params.length}`); }
    if (query.status) { params.push(query.status); where.push(`o.status = $${params.length}`); }
    params.push(query.limit, query.offset);
    const rows = await pool.query<OfferRow>(
      `${OFFER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY o.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const cfg = await freshnessConfig(pool);
    return { items: rows.rows.map((row) => offerView(row, cfg)) };
  });

  /** §31/§32: supplier declares capacity (or just re-confirms the current number). */
  app.post('/api/v1/supplier/offers/:id/capacity', async (request) => {
    const user = await principal(request, pool, config);
    if (!isSupplier(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      declaredCapacity: z.number().int().min(0).max(100000).optional(),
      confirmOnly: z.boolean().default(false),
    }).strict().parse(request.body ?? {});
    if (!body.confirmOnly && body.declaredCapacity === undefined) {
      throw badRequest('ظرفیت اعلامی یا تأیید مجدد لازم است.');
    }
    return transaction(pool, async (client) => {
      const offer = await one<OfferRow & { supplier_id: string }>(client,
        'SELECT * FROM supplier_offers WHERE id = $1 FOR UPDATE', [id]);
      if (!offer) throw notFound();
      if (offer.supplier_id !== user.id) throw forbidden(); // IDOR guard
      const next = body.confirmOnly ? offer.declared_capacity : body.declaredCapacity!;
      if (next < offer.reserved_external) {
        throw conflict(`ظرفیت اعلامی نمی‌تواند از رزرو شده (${offer.reserved_external}) کمتر شود؛ ابتدا رزروها آزاد شوند.`);
      }
      await client.query(
        `UPDATE supplier_offers SET declared_capacity = $2, capacity_confirmed_at = now(), version = version + 1, updated_at = now()
         WHERE id = $1`, [id, next]);
      await audit(client, user.id, 'supplier_offer.capacity_confirmed', 'supplier_offer', id,
        { declared: offer.declared_capacity }, { declared: next, confirmOnly: body.confirmOnly }, request.ip);
      const cfg = await freshnessConfig(client);
      return {
        id, declaredCapacity: next, reservedExternal: offer.reserved_external, safetyBuffer: offer.safety_buffer,
        availableToRequest: availableToRequest({ declared_capacity: next, reserved_external: offer.reserved_external, safety_buffer: offer.safety_buffer }),
        freshness: freshnessState(new Date(), cfg),
      };
    });
  });

  /** Pause/resume/archive an offer (supplier own, or admin). */
  app.post('/api/v1/supplier/offers/:id/status', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(['active', 'paused', 'archived']) }).parse(request.body);
    return transaction(pool, async (client) => {
      const offer = await one<{ id: string; supplier_id: string; status: string }>(client,
        'SELECT id, supplier_id, status FROM supplier_offers WHERE id = $1 FOR UPDATE', [id]);
      if (!offer) throw notFound();
      const admin = user.permissions.includes('suppliers:manage');
      if (!admin && offer.supplier_id !== user.id) throw forbidden();
      await client.query(`UPDATE supplier_offers SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, status]);
      await audit(client, user.id, 'supplier_offer.status_changed', 'supplier_offer', id,
        { status: offer.status }, { status }, request.ip);
      return { id, status };
    });
  });

  /** §33 primitives exposed for ops/Prompt-2 (admin only). */
  app.post('/api/v1/admin/supplier-offers/:id/reservations', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      quantity: z.number().int().min(1).max(10000),
      ttlMinutes: z.number().int().min(1).max(10080).nullable().optional(),
      note: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().trim().min(8).max(120).optional(),
    }).strict().parse(request.body);
    const result = await transaction(pool, (client) => reserveSupplierCapacity(client, {
      offerId: id, quantity: body.quantity, ttlMinutes: body.ttlMinutes ?? null,
      note: body.note, actorId: user.id, idempotencyKey: body.idempotencyKey ?? null,
    }));
    if ('duplicate' in result) return reply.code(200).send(result);
    await transaction(pool, (client) => audit(client, user.id, 'supplier_capacity.reserved', 'supplier_offer', id,
      undefined, { quantity: body.quantity, reservationId: result.reservationId }, request.ip));
    return reply.code(201).send(result);
  });

  app.post('/api/v1/admin/supplier-offers/reservations/:reservationId/release', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { reservationId } = z.object({ reservationId: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const settled = await settleSupplierCapacityReservation(client, reservationId, 'released');
      await audit(client, user.id, 'supplier_capacity.released', 'supplier_offer', settled.offerId,
        undefined, { reservationId, quantity: settled.quantity }, request.ip);
      return { reservationId, status: 'released' };
    });
  });

  app.post('/api/v1/admin/supplier-offers/reservations/expire-sweep', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const expired = await transaction(pool, (client) => expireSupplierCapacityReservations(client));
    return { expired };
  });

  /** §34: supplier inventory accuracy metrics (real data from inbound documents). */
  app.get('/api/v1/admin/suppliers/:supplierId/inventory-accuracy', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const { supplierId } = z.object({ supplierId: z.uuid() }).parse(request.params);
    const row = await one<{
      inbounds: string; expected: string; received: string; passed: string; rejected: string; shortage: string;
    }>(pool,
      `SELECT count(*)::text AS inbounds,
              COALESCE(sum(expected_series),0)::text AS expected,
              COALESCE(sum(received_series),0)::text AS received,
              COALESCE(sum(qc_passed_series),0)::text AS passed,
              COALESCE(sum(qc_rejected_series),0)::text AS rejected,
              COALESCE(sum(shortage_series),0)::text AS shortage
       FROM supplier_series_inbounds
       WHERE supplier_id = $1 AND status IN ('received','qc_completed')`, [supplierId]);
    const expected = Number(row?.expected ?? 0); const received = Number(row?.received ?? 0);
    const passed = Number(row?.passed ?? 0);
    return {
      supplierId,
      inboundCount: Number(row?.inbounds ?? 0),
      expectedSeries: expected,
      receivedSeries: received,
      qcPassedSeries: passed,
      qcRejectedSeries: Number(row?.rejected ?? 0),
      shortageSeries: Number(row?.shortage ?? 0),
      inventoryAccuracyPct: expected > 0 ? Math.round((received / expected) * 1000) / 10 : null,
      qcPassRatePct: received > 0 ? Math.round((passed / received) * 1000) / 10 : null,
    };
  });

  /** §36: marketplace availability — two numbers, two confidences, never merged. */
  app.get('/api/v1/products/:productId/wholesale-availability', async (request) => {
    const user = await principal(request, pool, config);
    const { productId } = z.object({ productId: z.uuid() }).parse(request.params);
    const cfg = await freshnessConfig(pool);
    // Kolbe-owned verified stock (series, central wholesale).
    const kolbe = await pool.query<{ series_template_id: string; name: string; color_label: string | null; available: number }>(
      `SELECT b.series_template_id, t.name, t.color_label, SUM(b.on_hand - b.reserved)::int AS available
       FROM series_stock_balances b JOIN series_templates t ON t.id = b.series_template_id
       WHERE t.product_id = $1 AND b.owner_type = 'kolbe'
       GROUP BY b.series_template_id, t.name, t.color_label`, [productId]);
    // Supplier offers: verified stock-at-kolbe + declared external capacity, kept apart.
    const offers = await pool.query<OfferRow & { stock_at_kolbe: number | null }>(
      `${OFFER_SELECT.replace('FROM supplier_offers o', `, (
          SELECT SUM(b.on_hand - b.reserved)::int FROM series_stock_balances b
          WHERE b.series_template_id = o.series_template_id AND b.owner_type = 'supplier' AND b.supplier_id = o.supplier_id
        ) AS stock_at_kolbe
        FROM supplier_offers o`)}
       WHERE o.product_id = $1 AND o.status = 'active'`, [productId]);
    // §55: VIP sees the public shape only (no supplier ids / private data).
    const privacy = !user.permissions.includes('suppliers:manage');
    return {
      productId,
      kolbeStock: kolbe.rows.map((row) => ({
        seriesTemplateId: row.series_template_id, seriesTemplateName: row.name,
        colorLabel: row.color_label, availableSeries: row.available, source: 'kolbe_warehouse', confidence: 'verified',
      })),
      supplierOffers: offers.rows.map((row) => ({
        ...offerView(row, cfg, { privacy }),
        stockAtKolbeSeries: row.stock_at_kolbe ?? 0,            // verified, physically at Kolbe
        externalAvailableToRequest: availableToRequest(row),    // declared — needs supplier confirmation
      })),
    };
  });
}
