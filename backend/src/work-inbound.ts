/**
 * Prompt 6 — Inbound Operations: arrival, physical receiving (GRN), quality control, exceptions,
 * warehouse dashboard, receiving queue and consolidation verification/packing (server-derived actions).
 *
 * AUTHORITY MAP (see docs/parallel/prompt-6-...-report.md §Authority consolidation):
 *
 *   shipment announcement / supplier dispatch / handoff readiness
 *       → `wholesale-oms.ts` (supplier routes), status changes only, NO stock effect.
 *   arrival + physical receiving + GRN + QC for ORDER-BOUND goods
 *       → **this module** (`recordInboundReceive` / `recordInboundQc`), serialised on the
 *         `oms_inbound_shipments` row so cross-endpoint duplicate receiving is impossible.
 *   arrival / receiving / QC for GENERAL supplier consignment (stock-at-kolbe, no order)
 *       → `supplier-consignment.ts` (unchanged, still canonical for its own scope).
 *   piece-level warehouse receipts
 *       → `inventory.ts` `/inventory/receipts` (general retail/wholesale replenishment).
 *   picking, consolidation items, packing, final shipment
 *       → `wholesale-oms.ts` (extended in Prompt 6 with duty gates, idempotency and blocking checks).
 *
 * This module writes NO duplicate inventory: order-bound goods are staged inside their allocation
 * (`qc_passed_series`), which is what pick/consolidation consume. Nothing is credited to general
 * sellable stock-at-kolbe, and ownership stays with the supplier until an explicit ownership workflow.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requireApprovedActiveSupplier, type Principal } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import type { PoolClient } from 'pg';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import {
  assertAuthorizedKolbeDestination, centralWholesaleWarehouse, childFulfillmentState,
  hasWarehouseDuty, isWholesaleOps, openFulfillmentException, resolveFulfillmentException, wmsInboundPolicy,
  type AllocationRow, type ChildRow,
} from './wholesale-fulfillment.js';

const code = (status: number, codeName: string, message: string) => new ApiError(status, codeName, message);

/** Deterministic operator-facing reference (never a raw UUID in the UI). */
async function nextInboundReference(client: DbClient): Promise<string> {
  const row = await one<{ n: string }>(client, "SELECT nextval('oms_inbound_seq')::text AS n");
  return `OIN-${row!.n}`;
}

export type InboundShipmentRow = {
  id: string; reference: string; master_order_id: string; child_order_id: string; supplier_id: string;
  destination_warehouse_id: string; status: string; carrier: string | null; tracking_code: string | null;
  note: string; dispatched_at: Date | null; arrived_at: Date | null; receiving_started_at: Date | null;
  received_at: Date | null; qc_completed_at: Date | null; cancelled_at: Date | null;
};

async function inboundForUpdate(client: DbClient, id: string): Promise<InboundShipmentRow> {
  const row = await one<InboundShipmentRow>(client, 'SELECT * FROM oms_inbound_shipments WHERE id = $1 FOR UPDATE', [id]);
  if (!row) throw notFound();
  return row;
}

/**
 * Resolve (or lazily ANNOUNCE) the inbound shipment document of one allocation leg.
 *
 * The supplier-facing route `POST /wholesale/supplier/children/:id/inbound-shipment` announces the
 * shipment up front. Orders that were dispatched before that route existed (and every internal
 * receiving call) still funnel through HERE, so a receipt can never be posted without its shipment
 * document: the document is created once, deterministically, with the destination taken from the
 * allocation the supplier already dispatched against. This is what makes the legacy
 * `children/:id/receive` adapter and the warehouse route share a single receipt authority.
 */
async function ensureInboundShipmentForAllocation(
  client: DbClient, alloc: AllocationRow, child: ChildRow,
): Promise<InboundShipmentRow> {
  if (alloc.inbound_shipment_id) return inboundForUpdate(client, alloc.inbound_shipment_id);
  const supplierId = alloc.owner_supplier_id ?? child.seller_id;
  if (!supplierId) throw conflict('تأمین‌کننده این قلم مشخص نیست؛ ثبت محموله ورودی ممکن نیست.');
  const existingLive = await one<InboundShipmentRow>(client,
    `SELECT * FROM oms_inbound_shipments
      WHERE child_order_id = $1 AND supplier_id = $2 AND status NOT IN ('qc_completed','cancelled') FOR UPDATE`,
    [child.id, supplierId]);
  if (existingLive) {
    await client.query('UPDATE order_source_allocations SET inbound_shipment_id = $2, updated_at = now() WHERE id = $1',
      [alloc.id, existingLive.id]);
    return existingLive;
  }
  const destination = alloc.warehouse_id ?? await centralWholesaleWarehouse(client);
  const reference = await nextInboundReference(client);
  const id = randomUUID();
  await client.query(
    `INSERT INTO oms_inbound_shipments(id, reference, master_order_id, child_order_id, supplier_id,
       destination_warehouse_id, status, note, dispatched_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'dispatched','محموله ثبت‌شده در زمان دریافت انبار',$7,NULL)
     ON CONFLICT DO NOTHING`,
    [id, reference, child.master_order_id, child.id, supplierId, destination, new Date()]);
  const created = await one<InboundShipmentRow>(client,
    `SELECT * FROM oms_inbound_shipments
      WHERE child_order_id = $1 AND supplier_id = $2 AND status NOT IN ('qc_completed','cancelled') FOR UPDATE`,
    [child.id, supplierId]);
  if (!created) throw conflict('ثبت محموله ورودی ممکن نشد؛ دوباره تلاش کنید.');
  await client.query('UPDATE order_source_allocations SET inbound_shipment_id = $2, updated_at = now() WHERE id = $1',
    [alloc.id, created.id]);
  await audit(client, null, 'oms_inbound.auto_declared', 'oms_inbound_shipment', created.id, undefined,
    { childOrderId: child.id, allocationId: alloc.id, reference: created.reference });
  return created;
}

/* ================================================================================================
 * Receive primitives (shared by every receiving route — the ONLY place a receipt is posted)
 * ============================================================================================== */

export type ReceiveEntry = {
  allocationId: string; receivedSeries: number; missingSeries?: number;
  damagedSeries?: number; note?: string;
};
export type ReceiveOutcome = {
  childFulfillment: string; shipmentReferences: string[]; receiptNumbers: string[];
  lines: Array<Record<string, unknown>>;
};

/**
 * Post a physical receipt (GRN) for the order-bound external allocations of ONE child order.
 * Every input is validated server-side; impossible submissions are rejected before any write.
 */
export async function recordInboundReceive(client: DbClient, user: Principal, input: {
  childOrderId: string; allocations: ReceiveEntry[]; note?: string;

  expectedSupplierId?: string;
}): Promise<ReceiveOutcome> {
  if (!hasWarehouseDuty(user, 'wms:receive')) throw forbidden();
  const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.childOrderId]);
  if (!child || !child.master_order_id) throw notFound();
  if (input.expectedSupplierId && child.seller_id !== input.expectedSupplierId) throw notFound();

  const shipmentIds = new Set<string>();
  const lines: Array<Record<string, unknown>> = [];
  for (const entry of input.allocations) {
    const alloc = await one<AllocationRow>(client,
      'SELECT * FROM order_source_allocations WHERE id = $1 AND child_order_id = $2 FOR UPDATE',
      [entry.allocationId, input.childOrderId]);
    if (!alloc || alloc.source_type !== 'supplier_external') throw notFound();
    if (alloc.received_at) {
      throw code(409, 'INBOUND_ALREADY_RECEIVED', 'رسید فیزیکی این قلم قبلاً ثبت شده است.');
    }
    if (alloc.status !== 'reserved') {
      throw code(409, 'INBOUND_NOT_DISPATCHED', 'این قلم در وضعیت قابل دریافت نیست (ارسالی ثبت نشده یا لغو شده است).');
    }
    if (alloc.dispatched_series <= 0) {
      throw code(409, 'INBOUND_NOT_DISPATCHED', 'این قلم هنوز توسط تأمین‌کننده ارسال نشده است؛ دریافت پیش از ارسال مجاز نیست.');
    }
    // Deterministic reconciliation: missing is derived when the caller only states what arrived.
    const missing = entry.missingSeries ?? (alloc.dispatched_series - entry.receivedSeries);
    if (missing < 0) throw badRequest('کسری منفی معنا ندارد.');
    if (entry.receivedSeries + missing !== alloc.dispatched_series) {
      throw badRequest(
        `مجموع دریافتی (${entry.receivedSeries}) و کسری (${missing}) باید برابر تعداد ارسالی تأمین‌کننده (${alloc.dispatched_series}) باشد.`,
      );
    }
    const visibleDamage = entry.damagedSeries ?? 0;
    if (visibleDamage > entry.receivedSeries) {
      throw badRequest('تعداد آسیب‌دیده نمی‌تواند از تعداد دریافتی بیشتر باشد.');
    }
    const shipment = await ensureInboundShipmentForAllocation(client, alloc, child);
    if (!['dispatched', 'in_transit', 'arrived', 'receiving'].includes(shipment.status)) {
      throw code(409, 'INBOUND_ALREADY_RECEIVED', 'دریافت فیزیکی این محموله قبلاً ثبت شده است.');
    }
    await assertAuthorizedKolbeDestination(client, shipment.destination_warehouse_id);

    await client.query(
      `UPDATE order_source_allocations
       SET received_series = $2, received_missing_series = $3, received_damaged_series = $4,
           receipt_note = $5, received_by = $6, received_at = now(), updated_at = now()
       WHERE id = $1`,
      [alloc.id, entry.receivedSeries, missing, visibleDamage, entry.note ?? null, user.id]);
    await client.query(
      `UPDATE child_order_lines SET received_series = GREATEST(0, received_series + $2), updated_at = now() WHERE id = $1`,
      [alloc.line_id, entry.receivedSeries]);

    shipmentIds.add(shipment.id);
    lines.push({
      allocationId: alloc.id, orderedSeries: alloc.quantity, dispatchedSeries: alloc.dispatched_series,
      receivedSeries: entry.receivedSeries, missingSeries: missing, damagedVisibleSeries: visibleDamage,
    });

    // §13: a missing unit never arrives, so its demand is unresolved from this moment — one exception.
    if (missing > 0) {
      await openFulfillmentException(client, {
        masterOrderId: child.master_order_id, childOrderId: child.id, lineId: alloc.line_id, allocationId: alloc.id,
        type: 'lost_inbound', quantity: missing,
        note: 'کسری در رسید فیزیکی انبار نسبت به تعداد ارسالی تأمین‌کننده', actorId: user.id,
      });
    }
    // §9/§13: VISIBLE damage is recorded as the receiving bucket + GRN + note, and its exception is
    // raised ONCE by QC, where the unit's final outcome (damaged / rejected / still pending) is decided.
    // Raising it twice for the same physical unit would double-count the unresolved demand.
  }

  // Lifecycle: the receipt closes the physical leg; QC owns the next stage.
  for (const shipmentId of shipmentIds) {
    await client.query(
      `UPDATE oms_inbound_shipments
       SET status = 'received', arrived_at = COALESCE(arrived_at, now()),
           receiving_started_at = COALESCE(receiving_started_at, now()), received_at = now(), updated_at = now()
       WHERE id = $1`,
      [shipmentId]);
    await outbox(client, 'oms_inbound.received', 'oms_inbound_shipment', shipmentId,
      { shipmentId, childOrderId: child.id, masterOrderId: child.master_order_id });
  }

  await client.query(
    `UPDATE orders SET child_fulfillment = 'qc_pending', wholesale_fulfillment_status = 'received_at_kolbe',
       updated_at = now() WHERE id = $1`, [child.id]);
  const state = await childFulfillmentState(client, child.id);
  const shipments = await client.query<{ reference: string }>(
    'SELECT reference FROM oms_inbound_shipments WHERE id = ANY($1::uuid[]) ORDER BY reference', [[...shipmentIds]]);
  return { childFulfillment: state, shipmentReferences: shipments.rows.map((r) => r.reference), receiptNumbers: [], lines };
}

/* ------------------------------------------------------------------------------------------- */

export type QcEntry = { allocationId: string; passedSeries: number; rejectedSeries: number; damagedSeries?: number; note?: string };
export type QcOutcome = {
  childFulfillment: string; receiptNumbers: string[]; shipmentReferences: string[];
  lines: Array<Record<string, unknown>>;
};

/**
 * Post quality control for the order-bound external allocations of ONE child order.
 * Rules enforced (Prompt 6 §10):
 *   • QC only after a physical receipt exists;
 *   • QC only for THIS child's own supplier data;
 *   • a seller can never QC its own goods;
 *   • no duplicate final inspection (one QC posting per allocation, enforced under row lock);
 *   • passed + rejected + damaged must equal the received quantity exactly (mutually exclusive buckets,
 *     no negative values, no overflow);
 *   • the accepted quantity can never exceed what was physically received.
 * Accepted goods stay ORDER-BOUND — they are staged in the allocation and never credited to general
 * sellable supplier stock (no `series_stock_balances` / `stock_balances` write, §11).
 */
export async function recordInboundQc(client: DbClient, user: Principal, input: {
  childOrderId: string; allocations: QcEntry[]; note?: string; expectedSupplierId?: string;
}): Promise<QcOutcome> {
  if (!hasWarehouseDuty(user, 'wms:qc')) throw forbidden();
  const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.childOrderId]);
  if (!child || !child.master_order_id) throw notFound();
  if (child.seller_id === user.id) throw forbidden(); // §135: no self-QC
  if (input.expectedSupplierId && child.seller_id !== input.expectedSupplierId) throw notFound();

  const shipmentIds = new Set<string>();
  const receiptNumbers: string[] = [];
  const lines: Array<Record<string, unknown>> = [];
  for (const entry of input.allocations) {
    const alloc = await one<AllocationRow>(client,
      'SELECT * FROM order_source_allocations WHERE id = $1 AND child_order_id = $2 FOR UPDATE',
      [entry.allocationId, input.childOrderId]);
    if (!alloc || alloc.source_type !== 'supplier_external') throw notFound();
    // Machine-readable guard: QC is a SECOND fact that can only follow the physical receipt (§8/§10).
    if (!alloc.received_at) throw code(409, 'INBOUND_NOT_RECEIVED', 'کنترل کیفیت پیش از دریافت فیزیکی مجاز نیست.');
    if (alloc.qc_at) throw code(409, 'INBOUND_ALREADY_QC', 'کنترل کیفیت این قلم قبلاً ثبت شده است.');
    if (entry.passedSeries < 0 || entry.rejectedSeries < 0 || (entry.damagedSeries ?? 0) < 0) {
      throw badRequest('تعداد کنترل کیفیت نمی‌تواند منفی باشد.');
    }
    const damaged = entry.damagedSeries ?? 0;
    // §9: the buckets are MUTUALLY EXCLUSIVE (the same convention the canonical
    // `inbound_shipment_lines` table has always used), so one unit can never be counted as both
    // rejected and damaged, and nothing can be counted twice.
    //   received = accepted + rejected + damaged + (still pending inspection)
    if (entry.passedSeries + entry.rejectedSeries + damaged !== alloc.received_series) {
      throw badRequest(
        `جمع قبول (${entry.passedSeries})، رد (${entry.rejectedSeries}) و آسیب‌دیده (${damaged}) باید دقیقاً برابر تعداد رسیدشده (${alloc.received_series}) باشد.`,
      );
    }
    const shipment = await ensureInboundShipmentForAllocation(client, alloc, child);
    await assertAuthorizedKolbeDestination(client, shipment.destination_warehouse_id);

    await client.query(
      `UPDATE order_source_allocations
       SET qc_passed_series = $2, qc_rejected_series = $3, qc_damaged_series = $4, qc_note = $5,
           qc_by = $6, qc_at = now(),
           status = CASE WHEN $2 >= dispatched_series THEN 'consumed' ELSE status END,
           updated_at = now()
       WHERE id = $1`,
      [alloc.id, entry.passedSeries, entry.rejectedSeries, damaged, entry.note ?? null, user.id]);
    await client.query(
      `UPDATE child_order_lines
       SET qc_passed_series = GREATEST(0, qc_passed_series + $2), qc_rejected_series = GREATEST(0, qc_rejected_series + $3), updated_at = now()
       WHERE id = $1`,
      [alloc.line_id, entry.passedSeries, entry.rejectedSeries]);

    if (entry.rejectedSeries > 0) {
      await openFulfillmentException(client, {
        masterOrderId: child.master_order_id, childOrderId: child.id, lineId: alloc.line_id, allocationId: alloc.id,
        type: 'qc_rejected', quantity: entry.rejectedSeries,
        note: 'رد کنترل کیفیت کالای سفارش‌محور — کالا به موجودی عمومی اضافه نمی‌شود',
        actorId: user.id,
      });
    }
    if (damaged > 0) {
      await openFulfillmentException(client, {
        masterOrderId: child.master_order_id, childOrderId: child.id, lineId: alloc.line_id, allocationId: alloc.id,
        type: 'damaged', quantity: damaged,
        note: 'آسیب‌دیده در کنترل کیفیت — قابل تخصیص نیست و به موجودی فروش اضافه نمی‌شود',
        actorId: user.id,
      });
    }
    if (entry.passedSeries < alloc.quantity && entry.rejectedSeries === 0 && damaged === 0
      && alloc.received_series + (alloc.received_missing_series ?? 0) >= alloc.dispatched_series) {
      // short confirmation shrinkage without rejection → explicit shortage exception, never silent (§88).
      await openFulfillmentException(client, {
        masterOrderId: child.master_order_id, childOrderId: child.id, lineId: alloc.line_id, allocationId: alloc.id,
        type: 'shortage', quantity: alloc.quantity - entry.passedSeries,
        note: 'کسری نسبت به تعداد تأییدشده پس از کنترل کیفیت', actorId: user.id,
      });
    }

    lines.push({
      allocationId: alloc.id, receivedSeries: alloc.received_series, passedSeries: entry.passedSeries,
      rejectedSeries: entry.rejectedSeries, damagedSeries: damaged, missingSeries: alloc.received_missing_series ?? 0,
    });
    shipmentIds.add(shipment.id);
  }

  // §8/§10: the GRN stays the SINGLE receipts authority; the OMS scope carries its QC outcome.
  for (const shipmentId of shipmentIds) {
    const shipment = await inboundForUpdate(client, shipmentId);
    const remaining = await one<{ count: string }>(client,
      `SELECT count(*)::text AS count FROM order_source_allocations
       WHERE inbound_shipment_id = $1 AND received_at IS NOT NULL AND qc_at IS NULL`, [shipmentId]);
    const shipmentAllocations = await client.query<{
      passed: number; rejected: number; damaged: number; received: number; missing: number; dispatched: number;
    }>(
      `SELECT COALESCE(SUM(qc_passed_series),0)::int AS passed, COALESCE(SUM(qc_rejected_series),0)::int AS rejected,
              COALESCE(SUM(qc_damaged_series),0)::int AS damaged, COALESCE(SUM(received_series),0)::int AS received,
              COALESCE(SUM(received_missing_series),0)::int AS missing, COALESCE(SUM(dispatched_series),0)::int AS dispatched
       FROM order_source_allocations WHERE inbound_shipment_id = $1`, [shipmentId]);
    const agg = shipmentAllocations.rows[0]!;
    const qcStatus = agg.passed === agg.dispatched ? 'accepted' : agg.passed > 0 ? 'partially_accepted' : 'rejected';
    const receiptNumber = await upsertOmsReceipt(client, {
      shipment, userId: user.id, qcStatus,
      shortage: agg.missing, damaged: agg.damaged,
      notes: input.note ?? null,
    });
    receiptNumbers.push(receiptNumber);
    if (Number(remaining?.count ?? 0) > 0) {
      await client.query(
        `UPDATE oms_inbound_shipments SET status = 'receiving', updated_at = now() WHERE id = $1`, [shipmentId]);
    } else {
      await client.query(
        `UPDATE oms_inbound_shipments
         SET status = 'qc_completed', qc_completed_at = COALESCE(qc_completed_at, now()), updated_at = now()
         WHERE id = $1`, [shipmentId]);
      await outbox(client, 'oms_inbound.qc_completed', 'oms_inbound_shipment', shipmentId,
        { shipmentId, childOrderId: child.id, masterOrderId: child.master_order_id, qcStatus });
    }
  }

  const anyRejected = lines.some((line) => Number(line.rejectedSeries) > 0);
  await client.query(
    `UPDATE orders SET wholesale_fulfillment_status = $2, updated_at = now() WHERE id = $1`,
    [child.id, anyRejected ? 'qc_issue' : 'qc_passed']);
  const state = await childFulfillmentState(client, child.id);
  const shipments = await client.query<{ reference: string }>(
    'SELECT reference FROM oms_inbound_shipments WHERE id = ANY($1::uuid[]) ORDER BY reference', [[...shipmentIds]]);
  return { childFulfillment: state, receiptNumbers, shipmentReferences: shipments.rows.map((r) => r.reference), lines };
}

/** One GRN row per OMS inbound shipment (unique index) — idempotent inside the QC transaction. */
async function upsertOmsReceipt(client: PoolClient | DbClient, input: {
  shipment: InboundShipmentRow; userId: string; qcStatus: string; shortage: number; damaged: number; notes: string | null;
}): Promise<string> {
  const existing = await one<{ id: string; receipt_number: string }>(client,
    'SELECT id, receipt_number FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1 FOR UPDATE', [input.shipment.id]);
  if (existing) {
    await client.query(
      `UPDATE warehouse_receipts SET qc_status = $2, shortage_series = $3, damaged_series = $4,
         notes = COALESCE($5, notes), inspected_by = $6, inspected_at = now() WHERE id = $1`,
      [existing.id, input.qcStatus, input.shortage, input.damaged, input.notes, input.userId]);
    return existing.receipt_number;
  }
  const id = randomUUID();
  const seq = await one<{ n: string }>(client, "SELECT nextval('warehouse_receipt_seq')::text AS n");
  const receiptNumber = `GRN-${seq!.n}`;
  await client.query(
    `INSERT INTO warehouse_receipts(id, receipt_number, inbound_shipment_id, oms_inbound_shipment_id, warehouse_id,
       received_by, qc_status, shortage_series, damaged_series, notes, inspected_by, inspected_at)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
    [id, receiptNumber, input.shipment.id, input.shipment.destination_warehouse_id, input.userId,
      input.qcStatus, input.shortage, input.damaged, input.notes, input.userId]);
  return receiptNumber;
}

/* ================================================================================================
 * Routes
 * ============================================================================================== */

const queueSchema = z.object({
  status: z.string().trim().max(40).optional(),
  supplierId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  masterId: z.uuid().optional(),
  q: z.string().trim().max(80).optional(),
  awaitingReceiving: z.coerce.boolean().optional(),
  awaitingQc: z.coerce.boolean().optional(),
  hasException: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

export function registerWorkInboundRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ------------------------------- supplier: declaration of dispatch ------------------------------- */

  /**
   * §7: the supplier announces the dispatch of its ORDER-BOUND external commitment. The destination is
   * SERVER-resolved (a supplier can never name a warehouse or a buyer address, §137/§20). Quantities are
   * NOT stored here — they live on the allocation, so the two can never drift. No stock effect: sending
   * goods is not receiving them (§4).
   */
  app.post('/api/v1/wholesale/supplier/children/:id/inbound-shipment', async (request, reply) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      carrier: z.string().trim().max(80).optional(),
      trackingCode: z.string().trim().max(120).optional(),
      note: z.string().trim().max(400).optional(),
    }).strict().parse(request.body ?? {});
    const key = request.headers['idempotency-key'];
    const idemKey = typeof key === 'string' && key.length >= 8 && key.length <= 120 ? key : null;
    if (typeof key === 'string' && !idemKey) throw badRequest('Idempotency-Key معتبر لازم است.');

    const result = await transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || child.seller_id !== user.id) throw notFound();
      const existing = await one<InboundShipmentRow>(client,
        `SELECT * FROM oms_inbound_shipments WHERE child_order_id = $1 AND supplier_id = $2
           AND status NOT IN ('qc_completed','cancelled') FOR UPDATE`, [id, user.id]);
      if (existing) {
        return { id: existing.id, reference: existing.reference, status: existing.status, destinationWarehouseId: existing.destination_warehouse_id, duplicate: true };
      }
      if (idemKey) {
        const claim = await claimIdempotency(client, user.id, 'oms_inbound.declare',
          idemKey, requestHash({ childOrderId: id, ...body }));
        if (claim.previous) return claim.previous as Record<string, unknown>;
      }
      const allocations = await client.query<AllocationRow>(
        `SELECT a.* FROM order_source_allocations a
         WHERE a.child_order_id = $1 AND a.owner_supplier_id = $2 AND a.source_type = 'supplier_external'
           AND a.status = 'reserved' AND a.dispatched_series > 0
         ORDER BY a.id`, [id, user.id]);
      if (!allocations.rows.length) {
        throw conflict('تخصیص خارجی ارسال‌شده‌ای برای این زیرسفارش وجود ندارد؛ ابتدا ارسال کالا را ثبت کنید.');
      }
      const destination = await centralWholesaleWarehouse(client);
      const reference = await nextInboundReference(client);
      const shipmentId = randomUUID();
      await client.query(
        `INSERT INTO oms_inbound_shipments(id, reference, master_order_id, child_order_id, supplier_id,
           destination_warehouse_id, status, carrier, tracking_code, note, dispatched_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'dispatched',$7,$8,$9,now(),$10)`,
        [shipmentId, reference, child.master_order_id, id, user.id, destination,
          body.carrier ?? null, body.trackingCode ?? null, body.note ?? '', user.id]);
      for (const alloc of allocations.rows) {
        await client.query(
          'UPDATE order_source_allocations SET inbound_shipment_id = $2, warehouse_id = COALESCE(warehouse_id, $3), updated_at = now() WHERE id = $1',
          [alloc.id, shipmentId, destination]);
      }
      const response = {
        id: shipmentId, reference, status: 'dispatched', destinationWarehouseId: destination,
        destinationType: 'kolbe_warehouse', allocationCount: allocations.rows.length, duplicate: false,
      };
      await audit(client, user.id, 'oms_inbound.declared', 'oms_inbound_shipment', shipmentId, undefined, response, request.ip);
      await outbox(client, 'oms_inbound.declared', 'oms_inbound_shipment', shipmentId,
        { shipmentId, reference, childOrderId: id, masterOrderId: child.master_order_id, destinationWarehouseId: destination });
      if (idemKey) await completeIdempotency(client, user.id, 'oms_inbound.declare', idemKey, response);
      return response;
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  /** Supplier view of its own inbound progress. Never exposes buyer data or other suppliers' goods. */
  app.get('/api/v1/wholesale/supplier/inbound-shipments', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const query = queueSchema.parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT s.id, s.reference, s.status, s.carrier, s.tracking_code, s.dispatched_at, s.received_at, s.qc_completed_at,
              s.destination_warehouse_id, w.name AS destination_warehouse_name, o.reference AS child_reference,
              COALESCE(stats.dispatched_series, 0)::int AS dispatched_series,
              COALESCE(stats.received_series, 0)::int AS received_series,
              COALESCE(stats.missing_series, 0)::int AS missing_series,
              COALESCE(stats.passed_series, 0)::int AS qc_passed_series,
              COALESCE(stats.rejected_series, 0)::int AS qc_rejected_series
       FROM oms_inbound_shipments s
       JOIN orders o ON o.id = s.child_order_id
       JOIN warehouses w ON w.id = s.destination_warehouse_id
       LEFT JOIN LATERAL (
         SELECT SUM(a.dispatched_series) AS dispatched_series, SUM(a.received_series) AS received_series,
                SUM(a.received_missing_series) AS missing_series, SUM(a.qc_passed_series) AS passed_series,
                SUM(a.qc_rejected_series) AS rejected_series
         FROM order_source_allocations a WHERE a.inbound_shipment_id = s.id
       ) stats ON true
       WHERE s.supplier_id = $1 AND ($2::text IS NULL OR s.status = $2)
       ORDER BY s.created_at DESC LIMIT $3`,
      [user.id, query.status ?? null, query.limit]);
    return { items: rows.rows };
  });

  /* ------------------------------- warehouse: inbound queue ------------------------------- */

  /**
   * §24: the warehouse inbound work queue. Counts and rows are SERVER-derived; every card deep-links
   * to a filtered view of this same query. Nothing here is a vanity metric.
   */
  app.get('/api/v1/admin/wms/inbound-shipments', async (request) => {
    const user = await principal(request, pool, config);
    if (!isWholesaleOps(user) && !hasWarehouseDuty(user, 'wms:receive')) throw forbidden();
    const query = queueSchema.parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT s.id, s.reference, s.status, s.carrier, s.tracking_code, s.note,
              s.dispatched_at, s.arrived_at, s.received_at, s.qc_completed_at,
              s.destination_warehouse_id, w.name AS destination_warehouse_name,
              o.id AS child_order_id, o.reference AS child_reference,
              mo.id AS master_order_id, mo.reference AS master_reference, mo.status AS master_status,
              s.supplier_id, COALESCE(sp.brand_name, 'تأمین‌کننده') AS supplier_label,
              COALESCE(stats.dispatched_series, 0)::int AS dispatched_series,
              COALESCE(stats.received_series, 0)::int AS received_series,
              COALESCE(stats.missing_series, 0)::int AS missing_series,
              COALESCE(stats.passed_series, 0)::int AS qc_passed_series,
              COALESCE(stats.rejected_series, 0)::int AS qc_rejected_series,
              COALESCE(stats.damaged_series, 0)::int AS damaged_series,
              COALESCE(x.open_exceptions, 0)::int AS open_exceptions
       FROM oms_inbound_shipments s
       JOIN orders o ON o.id = s.child_order_id
       JOIN master_orders mo ON mo.id = s.master_order_id
       JOIN warehouses w ON w.id = s.destination_warehouse_id
       LEFT JOIN supplier_profiles sp ON sp.user_id = s.supplier_id
       LEFT JOIN LATERAL (
         SELECT SUM(a.dispatched_series) AS dispatched_series, SUM(a.received_series) AS received_series,
                SUM(a.received_missing_series) AS missing_series, SUM(a.qc_passed_series) AS passed_series,
                SUM(a.qc_rejected_series) AS rejected_series,
                SUM(a.received_damaged_series + a.qc_damaged_series) AS damaged_series
         FROM order_source_allocations a WHERE a.inbound_shipment_id = s.id
       ) stats ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_exceptions FROM fulfillment_exceptions e
          WHERE e.master_order_id = s.master_order_id AND e.status = 'open'
       ) x ON true
       WHERE ($1::text IS NULL OR s.status = $1)
         AND ($2::uuid IS NULL OR s.supplier_id = $2)
         AND ($3::uuid IS NULL OR s.destination_warehouse_id = $3)
         AND ($4::uuid IS NULL OR s.master_order_id = $4)
         AND ($5::text IS NULL OR s.reference ILIKE '%' || $5 || '%' OR o.reference ILIKE '%' || $5 || '%'
              OR mo.reference ILIKE '%' || $5 || '%' OR COALESCE(sp.brand_name,'') ILIKE '%' || $5 || '%')
         AND ($6::boolean IS NOT TRUE OR (s.received_at IS NULL AND s.status <> 'cancelled'))
         AND ($7::boolean IS NOT TRUE OR (s.received_at IS NOT NULL AND s.qc_completed_at IS NULL))
         AND ($8::boolean IS NOT TRUE OR COALESCE(x.open_exceptions, 0) > 0)
       ORDER BY (s.status = 'dispatched') DESC, s.created_at DESC
       LIMIT $9`,
      [query.status ?? null, query.supplierId ?? null, query.warehouseId ?? null, query.masterId ?? null,
        query.q ?? null, query.awaitingReceiving ?? null, query.awaitingQc ?? null, query.hasException ?? null, query.limit]);
    return { items: rows.rows };
  });

  /** Full operational detail of one inbound shipment (internal operators only). */
  app.get('/api/v1/admin/wms/inbound-shipments/:id', async (request) => {
    const user = await principal(request, pool, config);
    if (!isWholesaleOps(user) && !hasWarehouseDuty(user, 'wms:receive')) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const header = await one<Record<string, unknown>>(pool,
      `SELECT s.*, w.name AS destination_warehouse_name, o.reference AS child_reference,
              mo.reference AS master_reference, o.seller_id AS supplier_id,
              COALESCE(sp.brand_name, 'تأمین‌کننده') AS supplier_label, o.child_fulfillment
       FROM oms_inbound_shipments s
       JOIN orders o ON o.id = s.child_order_id
       JOIN master_orders mo ON mo.id = s.master_order_id
       JOIN warehouses w ON w.id = s.destination_warehouse_id
       LEFT JOIN supplier_profiles sp ON sp.user_id = s.supplier_id
       WHERE s.id = $1`, [id]);
    if (!header) throw notFound();
    const lines = await pool.query(
      `SELECT a.id, a.quantity AS ordered_series, a.dispatched_series, a.received_series,
              a.received_missing_series, a.received_damaged_series, a.qc_passed_series, a.qc_rejected_series,
              a.qc_damaged_series, a.receipt_note, a.qc_note, a.received_at, a.qc_at, a.status,
              l.id AS line_id, l.requested_series, l.confirmed_series, l.pieces_per_series,
              t.name AS series_name, p.name AS product_name, p.id AS product_id,
              COALESCE(rb.receipt_number, '') AS receipt_number
       FROM order_source_allocations a
       JOIN child_order_lines l ON l.id = a.line_id
       JOIN series_templates t ON t.id = l.series_template_id
       JOIN products p ON p.id = l.product_id
       LEFT JOIN warehouse_receipts rb ON rb.oms_inbound_shipment_id = a.inbound_shipment_id
       WHERE a.inbound_shipment_id = $1
       ORDER BY p.name, t.name`, [id]);
    const receipts = await pool.query(
      `SELECT receipt_number, qc_status, shortage_series, damaged_series, notes, received_at, inspected_at, received_by
       FROM warehouse_receipts WHERE oms_inbound_shipment_id = $1 ORDER BY received_at DESC`, [id]);
    const exceptions = await pool.query(
      `SELECT e.id, e.exception_type, e.quantity, e.status, e.note, e.created_at, e.resolved_at, e.resolution
       FROM fulfillment_exceptions e
       WHERE e.child_order_id = (SELECT child_order_id FROM oms_inbound_shipments WHERE id = $1)
       ORDER BY e.created_at DESC`, [id]);
    const actions = await inboundShipmentActions(pool, user, id);
    return { shipment: header, lines: lines.rows, receipts: receipts.rows, exceptions: exceptions.rows, actions };
  });

  /* ------------------------------- warehouse: receiving + QC ------------------------------- */

  /**
   * §8: physical receiving (GRN). Partial quantities are legitimate; missing and visible damage are
   * recorded as separate buckets and never counted twice.
   */
  app.post('/api/v1/admin/wms/inbound-shipments/:id/receive', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:receive')) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      lines: z.array(z.object({
        allocationId: z.uuid(), receivedSeries: z.number().int().min(0),
        missingSeries: z.number().int().min(0).optional(),
        damagedSeries: z.number().int().min(0).optional(),
        note: z.string().trim().max(400).optional(),
      }).strict()).min(1).max(50),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    const key = request.headers['idempotency-key'];
    const idemKey = typeof key === 'string' && key.length >= 8 && key.length <= 120 ? key : null;
    if (typeof key === 'string' && !idemKey) throw badRequest('Idempotency-Key معتبر لازم است.');

    return transaction(pool, async (client) => {
      const shipment = await inboundForUpdate(client, id); // serialises all receiving for this shipment
      if (idemKey) {
        const claim = await claimIdempotency(client, user.id, 'wms_inbound.receive', idemKey,
          requestHash({ shipmentId: id, ...body }));
        if (claim.previous) return claim.previous;
      }
      const result = await recordInboundReceive(client, user, {
        childOrderId: shipment.child_order_id, allocations: body.lines, note: body.note,
        expectedSupplierId: shipment.supplier_id,
      });
      await audit(client, user.id, 'wms_inbound.received', 'oms_inbound_shipment', id,
        { status: shipment.status }, { lines: result.lines, note: body.note ?? null }, request.ip);
      const response = { ok: true, shipmentReference: shipment.reference, status: 'received',
        childFulfillment: result.childFulfillment, lines: result.lines };
      if (idemKey) await completeIdempotency(client, user.id, 'wms_inbound.receive', idemKey, response);
      return response;
    });
  });

  /** §10: quality control after receiving. Accepted goods stay order-bound. */
  app.post('/api/v1/admin/wms/inbound-shipments/:id/qc', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:qc')) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      lines: z.array(z.object({
        allocationId: z.uuid(), passedSeries: z.number().int().min(0), rejectedSeries: z.number().int().min(0),
        damagedSeries: z.number().int().min(0).optional(),
        note: z.string().trim().max(400).optional(),
      }).strict()).min(1).max(50),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    const key = request.headers['idempotency-key'];
    const idemKey = typeof key === 'string' && key.length >= 8 && key.length <= 120 ? key : null;
    if (typeof key === 'string' && !idemKey) throw badRequest('Idempotency-Key معتبر لازم است.');

    return transaction(pool, async (client) => {
      const shipment = await inboundForUpdate(client, id); // serialises concurrent QC finalisation
      if (idemKey) {
        const claim = await claimIdempotency(client, user.id, 'wms_inbound.qc', idemKey,
          requestHash({ shipmentId: id, ...body }));
        if (claim.previous) return claim.previous;
      }
      const result = await recordInboundQc(client, user, {
        childOrderId: shipment.child_order_id, allocations: body.lines, note: body.note,
        expectedSupplierId: shipment.supplier_id,
      });
      await audit(client, user.id, 'wms_inbound.qc_recorded', 'oms_inbound_shipment', id,
        { status: shipment.status }, { lines: result.lines, receipts: result.receiptNumbers }, request.ip);
      const response = { ok: true, shipmentReference: shipment.reference, status: 'qc_completed',
        childFulfillment: result.childFulfillment, receipts: result.receiptNumbers, lines: result.lines };
      if (idemKey) await completeIdempotency(client, user.id, 'wms_inbound.qc', idemKey, response);
      return response;
    });
  });

  /* ------------------------------- exceptions (§14) ------------------------------- */

  app.get('/api/v1/admin/wms/exceptions', async (request) => {
    const user = await principal(request, pool, config);
    if (!isWholesaleOps(user) && !hasWarehouseDuty(user, 'wms:receive') && !hasWarehouseDuty(user, 'wms:consolidate')) throw forbidden();
    const query = z.object({
      status: z.enum(['open', 'resolved', 'cancelled']).default('open'),
      type: z.string().trim().max(40).optional(),
      masterId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(80),
    }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT e.id, e.exception_type, e.quantity, e.status, e.note, e.resolution, e.created_at, e.resolved_at,
              e.master_order_id, mo.reference AS master_reference, e.child_order_id, o.reference AS child_reference,
              o.child_fulfillment, o.payment_eligibility,
              e.allocation_id, e.line_id, t.name AS series_name, p.name AS product_name,
              e.assigned_to, u.display_name AS assigned_label, s.reference AS shipment_reference
       FROM fulfillment_exceptions e
       JOIN orders o ON o.id = e.child_order_id
       LEFT JOIN master_orders mo ON mo.id = e.master_order_id
       LEFT JOIN child_order_lines l ON l.id = e.line_id
       LEFT JOIN series_templates t ON t.id = l.series_template_id
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN order_source_allocations a ON a.id = e.allocation_id
       LEFT JOIN oms_inbound_shipments s ON s.id = a.inbound_shipment_id
       LEFT JOIN users u ON u.id = e.assigned_to
       WHERE e.status = $1 AND ($2::text IS NULL OR e.exception_type = $2)
         AND ($3::uuid IS NULL OR e.master_order_id = $3)
       ORDER BY e.created_at DESC LIMIT $4`,
      [query.status, query.type ?? null, query.masterId ?? null, query.limit]);
    const openCount = await one<{ count: string }>(pool,
      "SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE status = 'open'");
    const overdue = await one<{ count: string }>(pool,
      `SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE status = 'open'
         AND created_at < now() - (COALESCE(($1::jsonb->>'inboundDelayHours')::int, 72) || ' hours')::interval`,
      [JSON.stringify(await wmsInboundPolicy(pool))]);
    return { items: rows.rows, openCount: Number(openCount?.count ?? 0), overdueCount: Number(overdue?.count ?? 0) };
  });

  /** Ops assignment of a responsible operator (§14) — the exception itself stays open. */
  app.post('/api/v1/admin/wms/exceptions/:id/assign', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:consolidate') && !isWholesaleOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ assignedTo: z.uuid().nullable() }).strict().parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const exception = await one<{ id: string; status: string }>(client,
        'SELECT id, status FROM fulfillment_exceptions WHERE id = $1 FOR UPDATE', [id]);
      if (!exception) throw notFound();
      if (exception.status !== 'open') throw conflict('این استثنا تعیین تکلیف شده است.');
      if (body.assignedTo) {
        const person = await one<{ id: string; status: string }>(client, 'SELECT id, status FROM users WHERE id = $1', [body.assignedTo]);
        if (!person || person.status !== 'active') throw badRequest('کاربر مسئول معتبر نیست.');
      }
      await client.query('UPDATE fulfillment_exceptions SET assigned_to = $2, updated_at = now() WHERE id = $1',
        [id, body.assignedTo]);
      await audit(client, user.id, 'wms_exception.assigned', 'fulfillment_exception', id, undefined,
        { assignedTo: body.assignedTo }, request.ip);
      return { ok: true };
    });
  });

  /** Resolution uses the SHARED authority (wholesale-fulfillment.ts) — never a second one. */
  app.post('/api/v1/admin/wms/exceptions/:id/resolve', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:consolidate') && !isWholesaleOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      resolution: z.enum(['accept_short', 'refund_pending', 'supplier_redelivery', 'written_off']),
      note: z.string().max(500).optional(),
    }).strict().parse(request.body);
    return resolveFulfillmentException(pool, user, {
      exceptionId: id, resolution: body.resolution, note: body.note, ip: request.ip,
    });
  });

  /* ------------------------------- dashboard (§24) ------------------------------- */

  /** Server-derived operational counters; each one deep-links to a filtered queue. */
  app.get('/api/v1/admin/wms/dashboard', async (request) => {
    const user = await principal(request, pool, config);
    if (!isWholesaleOps(user) && !hasWarehouseDuty(user, 'wms:receive') && !hasWarehouseDuty(user, 'wms:consolidate')) throw forbidden();
    const policy = await wmsInboundPolicy(pool);
    const counters = await one<{
      arriving: number; awaiting_receiving: number; awaiting_qc: number; partial: number;
      damaged: number; awaiting_consolidation: number; ready_for_packing: number; ready_for_dispatch: number;
      open_exceptions: number; delayed_inbound: number;
    }>(pool,
      `SELECT
         (SELECT count(*) FROM oms_inbound_shipments WHERE status IN ('dispatched','in_transit'))::int AS arriving,
         (SELECT count(*) FROM oms_inbound_shipments WHERE received_at IS NULL AND status <> 'cancelled')::int AS awaiting_receiving,
         (SELECT count(*) FROM oms_inbound_shipments WHERE received_at IS NOT NULL AND qc_completed_at IS NULL AND status <> 'cancelled')::int AS awaiting_qc,
         (SELECT count(DISTINCT child_order_id) FROM order_source_allocations
           WHERE source_type = 'supplier_external' AND qc_rejected_series > 0)::int AS partial,
         (SELECT COALESCE(SUM(received_damaged_series + qc_damaged_series), 0) FROM order_source_allocations)::int AS damaged,
         (SELECT count(*) FROM orders WHERE child_fulfillment = 'ready_for_consolidation')::int AS awaiting_consolidation,
         (SELECT count(*) FROM master_consolidations WHERE status = 'consolidated')::int AS ready_for_packing,
         (SELECT count(*) FROM master_consolidations WHERE status = 'ready_for_shipment')::int AS ready_for_dispatch,
         (SELECT count(*) FROM fulfillment_exceptions WHERE status = 'open')::int AS open_exceptions,
         (SELECT count(*) FROM oms_inbound_shipments
           WHERE status IN ('dispatched','in_transit')
             AND COALESCE(dispatched_at, created_at) < now() - ($1::int || ' hours')::interval)::int AS delayed_inbound`,
      [policy.inboundDelayHours]);
    const masters = await pool.query(
      `SELECT mo.id, mo.reference, mo.status, mo.composition, mo.shipped_at, mo.delivered_at,
              mc.reference AS consolidation_reference, mc.status AS consolidation_status,
              COALESCE(stats.ordered, 0)::int AS ordered_series,
              COALESCE(stats.staged, 0)::int AS staged_series,
              COALESCE(stats.open_exceptions, 0)::int AS open_exceptions
       FROM master_orders mo
       LEFT JOIN master_consolidations mc ON mc.master_order_id = mo.id
       LEFT JOIN LATERAL (
         SELECT SUM(COALESCE(l.confirmed_series, l.requested_series)) AS ordered,
                SUM(COALESCE(l.accepted_series, 0)) AS staged,
                (SELECT count(*) FROM fulfillment_exceptions e WHERE e.master_order_id = mo.id AND e.status = 'open') AS open_exceptions
         FROM child_order_lines l JOIN orders o ON o.id = l.child_order_id
         WHERE l.master_order_id = mo.id AND o.composition_state = 'included' AND o.status <> 'cancelled'
           AND l.status NOT IN ('removed','rejected')
       ) stats ON true
       WHERE mo.status <> 'cancelled'
         AND (mc.id IS NOT NULL OR COALESCE(stats.open_exceptions, 0) > 0
              OR COALESCE(stats.ordered, 0) <> COALESCE(stats.staged, 0))
       ORDER BY mo.created_at DESC LIMIT 30`);
    return { counters, masters: masters.rows, policy, generatedAt: new Date().toISOString() };
  });

  /* ------------------------------- consolidation work queue (§17/§18) ------------------------------- */

  /** Masters that are (or are becoming) consolidatable, with per-child physical progress. */
  app.get('/api/v1/admin/wms/consolidation-queue', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:consolidate') && !isWholesaleOps(user)) throw forbidden();
    const query = z.object({
      status: z.enum(['waiting', 'ready', 'in_progress', 'packed', 'shipped', 'blocked']).optional(),
      q: z.string().trim().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(60),
    }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT mo.id AS master_order_id, mo.reference AS master_reference, mo.status AS master_status,
              mo.composition, mc.id AS consolidation_id, mc.reference AS consolidation_reference,
              mc.status AS consolidation_status, mc.packed_at, mc.package_count,
              COALESCE(stats.children, 0)::int AS children,
              COALESCE(stats.paid_children, 0)::int AS paid_children,
              COALESCE(stats.ready_children, 0)::int AS ready_children,
              COALESCE(stats.ordered_series, 0)::int AS ordered_series,
              COALESCE(stats.staged_series, 0)::int AS staged_series,
              COALESCE(stats.external_pending, 0)::int AS external_pending_series,
              COALESCE(stats.open_exceptions, 0)::int AS open_exceptions,
              stats.buyer_label
       FROM master_orders mo
       LEFT JOIN master_consolidations mc ON mc.master_order_id = mo.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS children,
                count(*) FILTER (WHERE o.payment_eligibility = 'paid') AS paid_children,
                count(*) FILTER (WHERE o.child_fulfillment IN ('ready_for_consolidation','consolidated')) AS ready_children,
                (SELECT COALESCE(SUM(COALESCE(l.confirmed_series, l.requested_series)),0) FROM child_order_lines l
                  WHERE l.master_order_id = mo.id AND l.status NOT IN ('removed','rejected')) AS ordered_series,
                (SELECT COALESCE(SUM(COALESCE(l.accepted_series, 0)),0) FROM child_order_lines l
                  WHERE l.master_order_id = mo.id AND l.status NOT IN ('removed','rejected')) AS staged_series,
                (SELECT COALESCE(SUM(a.quantity - a.qc_passed_series),0) FROM order_source_allocations a
                  WHERE a.master_order_id = mo.id AND a.source_type = 'supplier_external'
                    AND a.status NOT IN ('released','cancelled','expired')) AS external_pending,
                (SELECT count(*) FROM fulfillment_exceptions e WHERE e.master_order_id = mo.id AND e.status = 'open') AS open_exceptions,
                -- a Master always has exactly one buyer, so the label is safe to aggregate under the same
                -- (aggregate) LATERAL that counts the children.
                max(u.display_name) AS buyer_label
         FROM orders o JOIN users u ON u.id = o.buyer_id
         WHERE o.master_order_id = mo.id AND o.composition_state = 'included' AND o.status <> 'cancelled'
       ) stats ON true
       WHERE mo.status <> 'cancelled'
         AND ($1::text IS NULL OR $1::text = CASE
                WHEN mc.status = 'ready_for_shipment' THEN 'packed'
                WHEN mc.status = 'shipped' THEN 'shipped'
                WHEN mc.status IN ('started','consolidated') THEN 'in_progress'
                WHEN COALESCE(stats.open_exceptions,0) > 0 THEN 'blocked'
                WHEN COALESCE(stats.children,0) > 0 AND COALESCE(stats.ready_children,0) = COALESCE(stats.children,0) THEN 'ready'
                ELSE 'waiting' END)
         AND ($2::text IS NULL OR mo.reference ILIKE '%' || $2 || '%' OR stats.buyer_label ILIKE '%' || $2 || '%')
       ORDER BY (mc.status IS NOT NULL) DESC, mo.created_at DESC
       LIMIT $3`,
      [query.status ?? null, query.q ?? null, query.limit]);
    return { items: rows.rows };
  });

  /** Per-child physical/scoping detail used by the consolidation workspace. */
  app.get('/api/v1/admin/wms/masters/:id/consolidation-detail', async (request) => {
    const user = await principal(request, pool, config);
    if (!hasWarehouseDuty(user, 'wms:consolidate') && !isWholesaleOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const master = await one<{ id: string; reference: string; composition: string; status: string; shipping_address: unknown }>(
      pool, 'SELECT id, reference, composition, status, shipping_address FROM master_orders WHERE id = $1', [id]);
    if (!master) throw notFound();
    const children = await pool.query(
      `SELECT o.id, o.reference, o.seller_type, o.seller_id, o.payment_eligibility, o.child_fulfillment,
              o.composition_state, COALESCE(sp.brand_name, CASE WHEN o.seller_type = 'kolbe' THEN 'انبار کلبه' ELSE 'تأمین‌کننده' END) AS seller_label,
              COALESCE(l.ordered, 0)::int AS ordered_series, COALESCE(l.staged, 0)::int AS staged_series,
              COALESCE(a.kolbe_series, 0)::int AS kolbe_series,
              COALESCE(a.supplier_at_kolbe_series, 0)::int AS supplier_at_kolbe_series,
              COALESCE(a.external_series, 0)::int AS external_series,
              COALESCE(a.external_staged, 0)::int AS external_staged_series,
              COALESCE(a.external_missing, 0)::int AS external_missing_series,
              COALESCE(e.open_exceptions, 0)::int AS open_exceptions,
              COALESCE(s.open_inbounds, 0)::int AS open_inbounds
       FROM orders o
       LEFT JOIN supplier_profiles sp ON sp.user_id = o.seller_id
       LEFT JOIN LATERAL (
         SELECT SUM(COALESCE(cl.confirmed_series, cl.requested_series)) AS ordered, SUM(COALESCE(cl.accepted_series,0)) AS staged
         FROM child_order_lines cl WHERE cl.child_order_id = o.id AND cl.status NOT IN ('removed','rejected')
       ) l ON true
       LEFT JOIN LATERAL (
         SELECT SUM(CASE WHEN al.source_type = 'kolbe_stock' THEN al.quantity END) AS kolbe_series,
                SUM(CASE WHEN al.source_type = 'supplier_stock_at_kolbe' THEN al.quantity END) AS supplier_at_kolbe_series,
                SUM(CASE WHEN al.source_type = 'supplier_external' THEN al.quantity END) AS external_series,
                SUM(CASE WHEN al.source_type = 'supplier_external' THEN al.qc_passed_series END) AS external_staged,
                SUM(CASE WHEN al.source_type = 'supplier_external' THEN al.received_missing_series END) AS external_missing
         FROM order_source_allocations al WHERE al.child_order_id = o.id
       ) a ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_exceptions FROM fulfillment_exceptions e WHERE e.child_order_id = o.id AND e.status = 'open'
       ) e ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_inbounds FROM oms_inbound_shipments s
          WHERE s.child_order_id = o.id AND s.status NOT IN ('qc_completed','cancelled')
       ) s ON true
       WHERE o.master_order_id = $1 AND o.composition_state = 'included' AND o.status <> 'cancelled'
       ORDER BY o.created_at`, [id]);
    const consolidation = await one<Record<string, unknown>>(pool,
      `SELECT id, reference, status, expected_children, started_at, consolidated_at, packed_at,
              package_count, total_series, total_pieces, weight_grams, dimensions, packaging_note
       FROM master_consolidations WHERE master_order_id = $1`, [id]);
    const items = consolidation
      ? (await pool.query(
        `SELECT ci.id, ci.line_id, ci.expected_series, ci.verified_series, ci.verified_at, ci.scan_reference,
                ci.child_order_id, o.reference AS child_reference, t.name AS series_name, p.name AS product_name,
                l.pieces_per_series
         FROM consolidation_items ci
         JOIN child_order_lines l ON l.id = ci.line_id
         JOIN orders o ON o.id = ci.child_order_id
         JOIN series_templates t ON t.id = ci.series_template_id
         JOIN products p ON p.id = l.product_id
         WHERE ci.consolidation_id = $1 ORDER BY p.name, t.name`, [consolidation.id])).rows
      : [];
    const actions = await consolidationActions(pool, user, id, (consolidation?.status as string | undefined) ?? null);
    return { master, children: children.rows, consolidation, items, actions };
  });
}

/* ================================================================================================
 * Server-derived actions (§27) — the frontend renders what the server allows, never its own guess
 * ============================================================================================== */

export async function inboundShipmentActions(db: DbPool, user: Principal, shipmentId: string): Promise<string[]> {
  const shipment = await one<InboundShipmentRow>(db, 'SELECT * FROM oms_inbound_shipments WHERE id = $1', [shipmentId]);
  if (!shipment) return [];
  const actions: string[] = [];
  if (shipment.status === 'cancelled' || shipment.status === 'qc_completed') return actions;
  const pendingReceipt = await one<{ count: string }>(db,
    `SELECT count(*)::text AS count FROM order_source_allocations
     WHERE inbound_shipment_id = $1 AND received_at IS NULL AND dispatched_series > 0`, [shipmentId]);
  const pendingQc = await one<{ count: string }>(db,
    `SELECT count(*)::text AS count FROM order_source_allocations
     WHERE inbound_shipment_id = $1 AND received_at IS NOT NULL AND qc_at IS NULL`, [shipmentId]);
  if (hasWarehouseDuty(user, 'wms:receive') && Number(pendingReceipt?.count ?? 0) > 0) actions.push('receive');
  if (hasWarehouseDuty(user, 'wms:qc') && Number(pendingQc?.count ?? 0) > 0) actions.push('inspect');
  return actions;
}

export async function consolidationActions(
  db: DbPool, user: Principal, masterId: string, consolidationStatus: string | null,
): Promise<string[]> {
  if (!hasWarehouseDuty(user, 'wms:consolidate')) return [];
  const actions: string[] = [];
  if (!consolidationStatus) {
    const ready = await one<{ children: string; ready: string }>(db,
      `SELECT count(*)::text AS children,
              count(*) FILTER (WHERE child_fulfillment = 'ready_for_consolidation')::text AS ready
       FROM orders WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'`, [masterId]);
    if (Number(ready?.children ?? 0) > 0 && ready?.children === ready?.ready) actions.push('start_consolidation');
    return actions;
  }
  if (consolidationStatus === 'started') { actions.push('verify_item', 'complete_consolidation'); }
  if (consolidationStatus === 'consolidated') actions.push('pack');
  if (consolidationStatus === 'ready_for_shipment' && hasWarehouseDuty(user, 'wms:ship')) {
    const blocking = await one<{ count: string }>(db,
      `SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE master_order_id = $1 AND status = 'open'`, [masterId]);
    if (Number(blocking?.count ?? 0) === 0) actions.push('ship');
  }
  return actions;
}
