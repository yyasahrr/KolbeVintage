/**
 * Prompt 2 — VIP Wholesale Master/Child OMS (§17-§55).
 *
 * Architecture: NO parallel OMS. The existing `orders` table IS the child order
 * (one per seller; financial/legal truth: own invoice, payment, refund scope).
 * `master_orders` is a THIN aggregation for grouping/consolidation/final shipment.
 * Commercial series-level truth lives in `child_order_lines`; piece-level
 * `order_lines` rows are still written so the entire existing WMS/invoice/
 * transition machinery keeps working unchanged.
 *
 * Source model (§21):
 *   A kolbe_stock             → owner-scoped series_stock_balances (owner=kolbe), reserve → READY
 *   B supplier_stock_at_kolbe → series_stock_balances (owner=supplier), reserve → READY (no reconfirmation)
 *   C supplier_external       → declared capacity is NOT eligibility; REQUESTED → AWAITING_SUPPLIER →
 *                               confirm → atomic reserveSupplierCapacity() → READY.
 *                               NEVER touches kolbe stock_balances/stock_reservations (§8).
 *
 * Payment gate (§46/§139): NO payment intent is created at master creation (§53).
 * Intents exist only for children whose payment_eligibility = 'ready' (W2).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requireApprovedActiveSupplier, type Principal } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import type { PoolClient } from 'pg';
import { rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { accrueChildPayable } from './settlement-core.js';
import { assertNotRestricted } from './console.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { resolveVariantPrice } from './promotions.js';
import { allocateSeriesPrice, loadSeriesComposition } from './series.js';
import { applySeriesMovement, buildRecipeSnapshot } from './series-inventory.js';
import {
  availableToRequest, expireSupplierCapacityReservations, reserveSupplierCapacity, settleSupplierCapacityReservation,
} from './supplier-offers.js';
import { issueInvoiceForOrder } from './invoices.js';
import { quoteShipping } from './shipping.js';
import { markCartConverted } from './cart.js';

/* ----------------------------- machine error codes (§198) ----------------------------- */

const code = (status: number, codeName: string, message: string) => new ApiError(status, codeName, message);

/* ----------------------------- configurable policy (§47/§69) ----------------------------- */

export type OmsPolicy = {
  paymentTtlMinutes: number;
  physicalReservationTtlMinutes: number;
  externalReservationTtlMinutes: number;
  supplierRespondHours: number;
};
const OMS_DEFAULTS: OmsPolicy = {
  paymentTtlMinutes: 2880, physicalReservationTtlMinutes: 2880,
  externalReservationTtlMinutes: 2880, supplierRespondHours: 48,
};

export async function omsPolicy(db: DbPool | DbClient): Promise<OmsPolicy> {
  const row = await one<{ value: Partial<OmsPolicy> }>(db, "SELECT value FROM site_settings WHERE key = 'wholesale_oms_policy'");
  const raw = row?.value ?? {};
  return {
    paymentTtlMinutes: Number(raw.paymentTtlMinutes ?? OMS_DEFAULTS.paymentTtlMinutes),
    physicalReservationTtlMinutes: Number(raw.physicalReservationTtlMinutes ?? OMS_DEFAULTS.physicalReservationTtlMinutes),
    externalReservationTtlMinutes: Number(raw.externalReservationTtlMinutes ?? OMS_DEFAULTS.externalReservationTtlMinutes),
    supplierRespondHours: Number(raw.supplierRespondHours ?? OMS_DEFAULTS.supplierRespondHours),
  };
}

/* ----------------------------- shared row types ----------------------------- */

type ChildRow = {
  id: string; reference: string; buyer_id: string; status: string; master_order_id: string | null;
  seller_type: 'kolbe' | 'supplier' | null; seller_id: string | null;
  supply_status: string | null; payment_eligibility: string | null;
  payment_due_at: Date | null; supplier_respond_by: Date | null;
  child_fulfillment: string | null; composition_state: string | null;
  subtotal_rial: string; discount_rial: string; total_rial: string;
};

type LineRow = {
  id: string; master_order_id: string; child_order_id: string; product_id: string;
  series_template_id: string; offer_id: string | null; seller_type: 'kolbe' | 'supplier';
  seller_id: string | null; requested_series: number; proposed_series: number | null;
  confirmed_series: number | null; accepted_series: number | null;
  dispatched_series: number; received_series: number; qc_passed_series: number; qc_rejected_series: number;
  pieces_per_series: number; unit_series_price_rial: string; line_total_rial: string;
  commercial_snapshot: Record<string, unknown>; snapshot_locked_at: Date | null;
  status: string; negotiation_history: Array<Record<string, unknown>>;
  supplier_response_status: string; supplier_response_note: string | null; supplier_responded_at: Date | null;
  supplier_committed_series: number; supplier_committed_at: Date | null; supplier_ready_at: Date | null;
};

type AllocationRow = {
  id: string; line_id: string; child_order_id: string; master_order_id: string;
  source_type: 'kolbe_stock' | 'supplier_stock_at_kolbe' | 'supplier_external';
  quantity: number; status: string; warehouse_id: string | null; owner_supplier_id: string | null;
  offer_id: string | null; capacity_reservation_id: string | null; reservation_expires_at: Date | null;
  disposition: string; dispatched_series: number; received_series: number;
  qc_passed_series: number; qc_rejected_series: number;
  reserved_at?: Date | null; created_at?: Date;
  supplier_response_status?: string; supplier_response_note?: string | null; supplier_committed_series?: number;
  supplier_responded_at?: Date | null; supplier_committed_at?: Date | null; supplier_ready_at?: Date | null;
};

/* ----------------------------- warehouse resolution (§80) ----------------------------- */

/** Destination of all supplier dispatches is SERVER-resolved — never client input (§137). */
export async function centralWholesaleWarehouse(client: DbClient): Promise<string> {
  const preferred = await one<{ id: string }>(client,
    `SELECT id FROM warehouses WHERE active = true AND owner_id IS NULL AND purpose IN ('wholesale','mixed')
     ORDER BY (purpose = 'wholesale') DESC, created_at ASC LIMIT 1`);
  if (preferred) return preferred.id;
  const id = randomUUID();
  await client.query(
    "INSERT INTO warehouses(id, owner_id, code, name, purpose, active) VALUES ($1, NULL, 'KOLBE-CENTRAL', 'انبار مرکزی کلبه', 'wholesale', true) ON CONFLICT (code) DO NOTHING",
    [id]);
  const found = await one<{ id: string }>(client,
    `SELECT id FROM warehouses WHERE owner_id IS NULL AND active = true AND purpose IN ('wholesale','mixed')
     ORDER BY (purpose = 'wholesale') DESC, created_at ASC LIMIT 1`);
  return found!.id;
}

/* ----------------------------- source allocation primitive (§21-§27) ----------------------------- */

/**
 * ONE rulebook for creating a source allocation — master creation AND reassignment both use it,
 * so reservation semantics can never drift between the two paths.
 * Physical sources reserve real Series inventory (owner-scoped); supplier capacity NEVER
 * becomes stock and only becomes a reservation after the supplier confirms (§23).
 */
async function createOrderAllocation(client: DbClient, input: {
  lineId: string; childId: string; masterId: string; templateId: string;
  sourceType: 'kolbe_stock' | 'supplier_stock_at_kolbe' | 'supplier_external';
  quantity: number; warehouseId: string | null; ownerSupplierId: string | null; offerId: string | null;
  actorId: string; physicalTtlMinutes: number;
}): Promise<{ id: string; status: string }> {
  const id = randomUUID();
  const isPhysical = input.sourceType !== 'supplier_external';
  let warehouse = input.warehouseId;
  let status = 'pending';
  let expiresAt: Date | null = null;
  if (isPhysical) {
    if (warehouse) {
      const recipeSnapshot = await buildRecipeSnapshot(client, input.templateId);
      await applySeriesMovement(client, {
        templateId: input.templateId, warehouseId: warehouse,
        owner: { ownerType: input.sourceType === 'kolbe_stock' ? 'kolbe' : 'supplier', supplierId: input.ownerSupplierId },
        movementType: 'reserve', reservedDelta: input.quantity, recipeSnapshot,
        referenceType: 'order', referenceId: input.childId, actorId: input.actorId,
        idempotencyKey: `series-reserve:${id}`,
      });
      await client.query(
        `INSERT INTO order_series_reservations(id, order_id, series_template_id, warehouse_id, owner_type, supplier_id, series_count, recipe_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), input.childId, input.templateId, warehouse,
          input.sourceType === 'kolbe_stock' ? 'kolbe' : 'supplier', input.ownerSupplierId,
          input.quantity, JSON.stringify(recipeSnapshot)]);
    } else {
      warehouse = await centralWholesaleWarehouse(client);
    }
    status = 'reserved';
    expiresAt = new Date(Date.now() + input.physicalTtlMinutes * 60_000);
  }
  await client.query(
    `INSERT INTO order_source_allocations(
       id, line_id, child_order_id, master_order_id, source_type, quantity, status,
       warehouse_id, owner_supplier_id, offer_id, reservation_expires_at, disposition, reserved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.lineId, input.childId, input.masterId, input.sourceType, input.quantity, status,
      warehouse, input.ownerSupplierId, input.offerId, expiresAt,
      input.sourceType === 'supplier_external' ? 'order_bound' : 'general', isPhysical ? new Date() : null]);
  return { id, status };
}

/* ----------------------------- derived child status (§73-§76) ----------------------------- */

/**
 * Recompute child supply_status + payment_eligibility from its lines/allocations.
 * MUST be called inside the caller's transaction after every mutation.
 * Eligibility is the HARD payment gate (§139) — 'ready' is set here and only here.
 */
export async function recomputeChild(client: DbClient, childOrderId: string, policy: OmsPolicy): Promise<ChildRow> {
  const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [childOrderId]);
  if (!child || !child.master_order_id) throw notFound();
  const lines = await client.query<LineRow>(
    'SELECT * FROM child_order_lines WHERE child_order_id = $1 ORDER BY created_at', [childOrderId]);
  const active = lines.rows.filter((l) => !['removed', 'rejected'].includes(l.status));

  let supply: string;
  if (active.length === 0) {
    supply = 'rejected';
  } else if (active.some((l) => l.status === 'exception')) {
    supply = 'exception';
  } else if (active.some((l) => ['counter_offered', 'awaiting_buyer'].includes(l.status))) {
    supply = 'awaiting_buyer';
  } else if (active.some((l) => l.status === 'timed_out')) {
    supply = 'timed_out';
  } else if (active.some((l) => ['pending', 'awaiting_supplier'].includes(l.status))) {
    supply = active.some((l) => ['confirmed', 'stock_reserved', 'accepted'].includes(l.status))
      ? 'partially_confirmed' : 'awaiting_supplier';
  } else {
    // every active line secured: physical-only child stays 'stock_reserved', others 'confirmed'.
    supply = active.every((l) => l.status === 'stock_reserved') ? 'stock_reserved' : 'confirmed';
  }

  // Eligibility transitions (never downgrade a paid child; never resurrect an expired one here).
  let eligibility = child.payment_eligibility ?? 'not_ready';
  if (eligibility !== 'paid' && eligibility !== 'expired') {
    if (supply === 'stock_reserved' || supply === 'confirmed') eligibility = 'ready';
    else if (supply === 'awaiting_supplier' || supply === 'partially_confirmed') eligibility = 'blocked_supply_pending';
    else if (supply === 'awaiting_buyer') eligibility = 'blocked_buyer_decision';
    else if (supply === 'exception') eligibility = 'blocked_exception';
    else eligibility = 'not_ready';
  }

  const becameReady = eligibility === 'ready' && child.payment_eligibility !== 'ready' && child.payment_eligibility !== 'paid';
  const dueAt = becameReady ? new Date(Date.now() + policy.paymentTtlMinutes * 60_000) : child.payment_due_at;
  const fulfillment = eligibility === 'paid' ? child.child_fulfillment
    : eligibility === 'ready' ? 'waiting_payment' : (child.child_fulfillment ?? 'not_started');

  await client.query(
    `UPDATE orders SET supply_status = $2, payment_eligibility = $3, payment_due_at = $4,
       child_fulfillment = $5, updated_at = now() WHERE id = $1`,
    [childOrderId, supply, eligibility, dueAt, fulfillment]);

  if (becameReady) {
    // §66: freeze the commercial snapshot at READY; immutable afterwards.
    await client.query(
      `UPDATE child_order_lines SET snapshot_locked_at = COALESCE(snapshot_locked_at, now()), updated_at = now()
       WHERE child_order_id = $1 AND status NOT IN ('removed','rejected')`, [childOrderId]);
    await outbox(client, 'child_order.payment_ready', 'order', childOrderId,
      { childOrderId, masterOrderId: child.master_order_id, paymentDueAt: dueAt });
  }
  return { ...child, supply_status: supply, payment_eligibility: eligibility, payment_due_at: dueAt ?? null };
}

/* ----------------------------- reservation release helpers ----------------------------- */

/** Release one allocation only; reassignment must never free sibling allocations. */
async function releaseAllocationHold(client: DbClient, alloc: AllocationRow, line: LineRow,
  actorId: string, note: string, preserveUnresolvedDemand = false): Promise<void> {
  if (alloc.status !== 'reserved' && alloc.status !== 'pending') return;
  if (alloc.source_type === 'supplier_external') {
    if (alloc.capacity_reservation_id) {
      await settleSupplierCapacityReservation(client, alloc.capacity_reservation_id, 'released');
    }
  } else if (alloc.status === 'reserved' && alloc.warehouse_id) {
    const reservation = await one<{ id: string; series_count: number; recipe_snapshot: unknown }>(client,
      `SELECT id, series_count, recipe_snapshot FROM order_series_reservations
       WHERE order_id = $1 AND series_template_id = $2 AND status = 'active' FOR UPDATE`,
      [line.child_order_id, line.series_template_id]);
    if (reservation) {
      await applySeriesMovement(client, {
        templateId: line.series_template_id, warehouseId: alloc.warehouse_id,
        owner: { ownerType: alloc.source_type === 'kolbe_stock' ? 'kolbe' : 'supplier', supplierId: alloc.owner_supplier_id },
        movementType: 'release', reservedDelta: -alloc.quantity,
        referenceType: 'order', referenceId: line.child_order_id, actorId,
        note, idempotencyKey: `oms-release:${alloc.id}`,
      });
      if (reservation.series_count <= alloc.quantity) {
        await client.query("UPDATE order_series_reservations SET status = 'released', updated_at = now() WHERE id = $1", [reservation.id]);
      } else {
        await client.query('UPDATE order_series_reservations SET series_count = series_count - $2, updated_at = now() WHERE id = $1',
          [reservation.id, alloc.quantity]);
      }
    }
  }
  await client.query(
    preserveUnresolvedDemand
      ? `UPDATE order_source_allocations SET status = 'pending', capacity_reservation_id = NULL,
           reservation_expires_at = NULL, reserved_at = NULL, updated_at = now() WHERE id = $1`
      : `UPDATE order_source_allocations SET status = 'released', capacity_reservation_id = NULL,
           reservation_expires_at = NULL, updated_at = now() WHERE id = $1`,
    [alloc.id]);
}

/** Release every active physical/external hold of ONE line. Optional demand preservation keeps the
 *  canonical allocations pending so staff can reassign the same quantity instead of losing demand. */
export async function releaseLineHolds(client: DbClient, line: LineRow, actorId: string, note: string,
  preserveUnresolvedDemand = false): Promise<void> {
  const allocations = await client.query<AllocationRow>(
    'SELECT * FROM order_source_allocations WHERE line_id = $1 FOR UPDATE', [line.id]);
  for (const allocation of allocations.rows) {
    await releaseAllocationHold(client, allocation, line, actorId, note, preserveUnresolvedDemand);
  }
}

/** Remove the piece-level order_lines + stock reservations of one commercial line (pre-payment only). */
async function removeLinePieces(client: DbClient, line: LineRow, actorId: string): Promise<void> {
  const variantIds = ((line.commercial_snapshot?.perPiece ?? []) as Array<{ variantId: string }>).map((p) => p.variantId);
  if (!variantIds.length) return;
  const pieceLines = await client.query<{ id: string; variant_id: string; quantity: number }>(
    'SELECT id, variant_id, quantity FROM order_lines WHERE order_id = $1 AND variant_id = ANY($2::uuid[]) FOR UPDATE',
    [line.child_order_id, variantIds]);
  for (const piece of pieceLines.rows) {
    const reservation = await one<{ id: string; warehouse_id: string; quantity: number; status: string; inventory_domain: string }>(client,
      'SELECT id, warehouse_id, quantity, status, inventory_domain FROM stock_reservations WHERE order_line_id = $1 FOR UPDATE', [piece.id]);
    if (reservation && reservation.status === 'active') {
      await client.query(
        `UPDATE stock_balances SET reserved = GREATEST(0, reserved - $4), version = version + 1, updated_at = now()
         WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [piece.variant_id, reservation.warehouse_id, reservation.inventory_domain, reservation.quantity]);
      await client.query(
        `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'oms line removed','order',$6,$7,$8)`,
        [randomUUID(), piece.variant_id, reservation.warehouse_id, reservation.inventory_domain,
          -reservation.quantity, line.child_order_id, actorId, `oms-line-remove:${piece.id}`]);
    }
    await client.query('DELETE FROM stock_reservations WHERE order_line_id = $1', [piece.id]);
    await client.query('DELETE FROM order_lines WHERE id = $1', [piece.id]);
  }
}

/** Recompute the child money totals from its remaining piece lines (pre-payment only). */
async function recomputeChildTotals(client: DbClient, childOrderId: string): Promise<void> {
  const sums = await one<{ subtotal: string; discount: string }>(client,
    `SELECT COALESCE(SUM(base_unit_price_rial * quantity), 0)::text AS subtotal,
            COALESCE(SUM(discount_amount_rial), 0)::text AS discount
     FROM order_lines WHERE order_id = $1`, [childOrderId]);
  const planPercent = await one<{ percent: string | null }>(client,
    `SELECT (pricing_snapshot->>'planDiscountPercent') AS percent FROM orders WHERE id = $1`, [childOrderId]);
  const subtotal = rial(sums?.subtotal ?? '0');
  const lineDiscount = rial(sums?.discount ?? '0');
  const percent = BigInt(Math.max(0, Math.min(90, Number(planPercent?.percent ?? 0) || 0)));
  const planDiscount = ((subtotal - lineDiscount) * percent) / 100n;
  let discount = lineDiscount + planDiscount;
  if (discount > subtotal) discount = subtotal;
  await client.query(
    `UPDATE orders SET subtotal_rial = $2::bigint, discount_rial = $3::bigint,
       total_rial = $2::bigint - $3::bigint + shipping_rial, updated_at = now()
     WHERE id = $1`, [childOrderId, subtotal.toString(), discount.toString()]);
}

async function appendNegotiation(client: DbClient, lineId: string, entry: Record<string, unknown>): Promise<void> {
  await client.query(
    `UPDATE child_order_lines SET negotiation_history = negotiation_history || $2::jsonb, updated_at = now() WHERE id = $1`,
    [lineId, JSON.stringify([{ ...entry, at: new Date().toISOString() }])]);
}

/* ----------------------------- payment application (§57-§62, §128) ----------------------------- */

/**
 * Called by applyVerifiedPayment (payments.ts) for intents whose targets live in
 * payment_allocations (single-child AND batch intents of the master flow).
 * Runs inside the SAME transaction as the gateway verification — children flip to
 * paid atomically (§60). A child whose eligibility lapsed between redirect and
 * callback is NOT paid: it gets a payment_late_callback exception + refund-required
 * outbox instead — never an oversell (§61-§62).
 */
export async function applyChildPaymentAllocations(client: PoolClient, input: {
  intentId: string; providerReference: string; paidAt: Date;
}): Promise<{ paidChildren: string[]; exceptionChildren: string[] }> {
  const allocations = await client.query<{ id: string; child_order_id: string; amount_rial: string; status: string }>(
    `SELECT id, child_order_id, amount_rial::text AS amount_rial, status FROM payment_allocations
     WHERE payment_intent_id = $1 ORDER BY created_at FOR UPDATE`, [input.intentId]);
  const paidChildren: string[] = [];
  const exceptionChildren: string[] = [];
  for (const alloc of allocations.rows) {
    if (alloc.status !== 'pending') continue;
    const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [alloc.child_order_id]);
    const payable = !!child && child.status === 'pending_payment' && child.payment_eligibility === 'ready'
      && (!child.payment_due_at || new Date(child.payment_due_at) > input.paidAt);
    if (payable) {
      await client.query(
        `UPDATE orders SET status = 'paid', paid_at = $2, payment_eligibility = 'paid',
           child_fulfillment = 'preparing', updated_at = now() WHERE id = $1`,
        [alloc.child_order_id, input.paidAt]);
      await client.query(
        `INSERT INTO order_events(id, order_id, from_status, to_status, note)
         VALUES ($1,$2,'pending_payment','paid',$3)`,
        [randomUUID(), alloc.child_order_id, `پرداخت زیرسفارش تأیید شد: ${input.providerReference}`]);
      await client.query("UPDATE payment_allocations SET status = 'succeeded', updated_at = now() WHERE id = $1", [alloc.id]);
      // paid holds never expire: clear both the allocation TTL and the capacity TTL.
      await client.query(
        `UPDATE order_source_allocations SET reservation_expires_at = NULL, updated_at = now()
         WHERE child_order_id = $1 AND status = 'reserved'`, [alloc.child_order_id]);
      await client.query(
        `UPDATE supplier_capacity_reservations SET expires_at = NULL, updated_at = now()
         WHERE id IN (SELECT capacity_reservation_id FROM order_source_allocations
                      WHERE child_order_id = $1 AND capacity_reservation_id IS NOT NULL AND status = 'reserved')`,
        [alloc.child_order_id]);
      // §128: finance hook — per-child event; Prompt 3 consumes it. Legacy order.paid kept for compat.
      await outbox(client, 'child_order.payment_verified', 'order', alloc.child_order_id,
        { childOrderId: alloc.child_order_id, masterOrderId: child!.master_order_id,
          paymentIntentId: input.intentId, amountRial: alloc.amount_rial });
      await outbox(client, 'order.paid', 'order', alloc.child_order_id,
        { orderId: alloc.child_order_id, paymentIntentId: input.intentId });
      // §106: one invoice per child (INV-xxxx-NN) — existing engine, dedup by order_id.
      await issueInvoiceForOrder(client, alloc.child_order_id);
      paidChildren.push(alloc.child_order_id);
    } else {
      await client.query("UPDATE payment_allocations SET status = 'exception', updated_at = now() WHERE id = $1", [alloc.id]);
      await client.query(
        `INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, exception_type, status, note)
         VALUES ($1,$2,$3,'payment_late_callback','open',$4)`,
        [randomUUID(), child?.master_order_id ?? null, alloc.child_order_id,
          `پرداخت پس از انقضای مهلت رزرو رسید (${input.providerReference}) — نیازمند استرداد؛ موجودی مجدداً رزرو نشده است.`]);
      await outbox(client, 'child_order.refund_requested', 'order', alloc.child_order_id,
        { childOrderId: alloc.child_order_id, masterOrderId: child?.master_order_id ?? null,
          paymentIntentId: input.intentId, amountRial: alloc.amount_rial, reason: 'payment_late_callback' });
      await outbox(client, 'child_order.exception_opened', 'order', alloc.child_order_id,
        { childOrderId: alloc.child_order_id, exceptionType: 'payment_late_callback' });
      exceptionChildren.push(alloc.child_order_id);
    }
  }
  return { paidChildren, exceptionChildren };
}

/* ----------------------------- TTL expiry sweep (§47-§49, §69) ----------------------------- */

async function expireChild(client: DbClient, child: ChildRow, actorId: string | null): Promise<void> {
  const lines = await client.query<LineRow>(
    `SELECT * FROM child_order_lines WHERE child_order_id = $1 AND status NOT IN ('removed','rejected') FOR UPDATE`,
    [child.id]);
  for (const line of lines.rows) {
    const held = await client.query<{ id: string }>(
      `SELECT id FROM order_source_allocations WHERE line_id = $1 AND status IN ('pending','reserved')`, [line.id]);
    await releaseLineHolds(client, line, actorId ?? child.buyer_id, 'انقضای مهلت پرداخت — آزادسازی رزرو');
    if (held.rows.length) {
      await client.query(
        `UPDATE order_source_allocations SET status = 'expired', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [held.rows.map((r) => r.id)]);
    }
  }
  await client.query(
    `UPDATE orders SET payment_eligibility = 'expired', child_fulfillment = 'not_started', updated_at = now() WHERE id = $1`,
    [child.id]);
  // stale intents can never pay (§49): fail every pending intent that references this child.
  const intents = await client.query<{ payment_intent_id: string }>(
    `SELECT DISTINCT pa.payment_intent_id FROM payment_allocations pa
     JOIN payment_intents pi ON pi.id = pa.payment_intent_id
     WHERE pa.child_order_id = $1 AND pi.status = 'pending'`, [child.id]);
  for (const row of intents.rows) {
    await client.query("UPDATE payment_intents SET status = 'failed' WHERE id = $1 AND status = 'pending'", [row.payment_intent_id]);
    await client.query(
      "UPDATE payment_allocations SET status = 'cancelled', updated_at = now() WHERE payment_intent_id = $1 AND status = 'pending'",
      [row.payment_intent_id]);
  }
  await client.query(
    `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
     VALUES ($1,$2,'pending_payment','pending_payment',$3,'مهلت پرداخت زیرسفارش منقضی و رزروها آزاد شد')`,
    [randomUUID(), child.id, actorId]);
  await outbox(client, 'child_order.payment_expired', 'order', child.id,
    { childOrderId: child.id, masterOrderId: child.master_order_id });
}

/** Deadline sweep: payment TTL expiry + supplier respond_by timeout + capacity reservation TTL. */
export async function runWholesaleOmsSweep(pool: DbPool, actorId: string | null): Promise<{
  expiredChildren: number; timedOutLines: number; expiredCapacityReservations: number;
}> {
  const policy = await omsPolicy(pool);
  return transaction(pool, async (client) => {
    // 1) children whose READY window lapsed → EXPIRED + full release (§48).
    const dueChildren = await client.query<ChildRow>(
      `SELECT * FROM orders
       WHERE master_order_id IS NOT NULL AND status = 'pending_payment'
         AND payment_eligibility = 'ready' AND payment_due_at IS NOT NULL AND payment_due_at < now()
       ORDER BY payment_due_at FOR UPDATE SKIP LOCKED LIMIT 100`);
    for (const child of dueChildren.rows) await expireChild(client, child, actorId);

    // 2) supplier respond_by timeout → TIMED_OUT lines; buyer decides next (§70, no auto-alternate).
    const dueLines = await client.query<LineRow & { respond_by: Date }>(
      `SELECT l.*, o.supplier_respond_by AS respond_by FROM child_order_lines l
       JOIN orders o ON o.id = l.child_order_id
       WHERE l.status = 'awaiting_supplier' AND o.status = 'pending_payment'
         AND o.supplier_respond_by IS NOT NULL AND o.supplier_respond_by < now()
       ORDER BY o.supplier_respond_by FOR UPDATE OF l SKIP LOCKED LIMIT 200`);
    const touchedChildren = new Set<string>();
    for (const line of dueLines.rows) {
      await client.query("UPDATE child_order_lines SET status = 'timed_out', updated_at = now() WHERE id = $1", [line.id]);
      await appendNegotiation(client, line.id, { type: 'supplier_timeout' });
      touchedChildren.add(line.child_order_id);
    }
    for (const childId of touchedChildren) {
      await recomputeChild(client, childId, policy);
      await outbox(client, 'child_order.supplier_timeout', 'order', childId, { childOrderId: childId });
    }

    // 3) Prompt-1 capacity reservation TTL sweep (frees reserved_external).
    const expiredCapacity = await expireSupplierCapacityReservations(client);
    return { expiredChildren: dueChildren.rows.length, timedOutLines: dueLines.rows.length, expiredCapacityReservations: expiredCapacity };
  });
}

/* ----------------------------- allowedActions (§140/§201) ----------------------------- */

function childAllowedActions(child: ChildRow, viewer: 'buyer' | 'supplier' | 'ops', masterComposition: string): string[] {
  const actions: string[] = [];
  const unpaid = child.payment_eligibility !== 'paid' && child.status === 'pending_payment';
  if (viewer === 'buyer') {
    if (child.payment_eligibility === 'ready') actions.push('pay');
    if (child.supply_status === 'awaiting_buyer') actions.push('decide_counter');
    if (unpaid && masterComposition === 'open') actions.push('remove_child');
  }
  if (viewer === 'supplier') {
    if (['awaiting_supplier', 'partially_confirmed'].includes(child.supply_status ?? '')) actions.push('respond_lines');
    if (child.payment_eligibility === 'paid' && ['preparing', 'waiting_payment', 'not_started'].includes(child.child_fulfillment ?? '')) {
      actions.push('dispatch');
    }
  }
  if (viewer === 'ops') {
    if (child.child_fulfillment === 'dispatched' || child.child_fulfillment === 'in_transit') actions.push('receive');
    if (child.child_fulfillment === 'received' || child.child_fulfillment === 'qc_pending') actions.push('qc');
    if (child.payment_eligibility === 'paid' && ['waiting_payment', 'preparing'].includes(child.child_fulfillment ?? '')
      && child.seller_type !== 'supplier') actions.push('pick');
  }
  return actions;
}

/* ========================================================================================= */
/* Prompt-4 Order Center projections: customer lifecycle, coverage/readiness and the TWO      */
/* serializers (VIP buyer vs operations). Helpers are declared here, next to the routes that   */
/* use them, and every number is DERIVED from canonical data — never stored, never editable.   */
/* ========================================================================================= */

/** §62: the small, customer-understandable lifecycle. This is the ONLY status vocabulary a VIP sees. */
export type CustomerStatus = { code: string; label: string };
export function masterCustomerStatus(input: {
  status: string; composition?: string;
  children: Array<{ status: string; payment_eligibility: string | null; supply_status?: string | null;
    child_fulfillment: string | null; composition_state: string | null }>;
  shippedAt?: Date | string | null; deliveredAt?: Date | string | null;
}): CustomerStatus {
  if (input.status === 'cancelled') return { code: 'cancelled', label: 'لغو شده' };
  if (input.deliveredAt) return { code: 'delivered', label: 'تحویل شده' };
  if (input.shippedAt) return { code: 'shipped', label: 'ارسال شده' };
  const included = input.children.filter((child) => child.status !== 'cancelled'
    && !['removed', 'cancelled'].includes(child.composition_state ?? ''));
  if (included.length === 0) return { code: 'cancelled', label: 'لغو شده' };
  const paid = (child: { payment_eligibility: string | null; child_fulfillment: string | null }) =>
    child.payment_eligibility === 'paid'
    || ['preparing', 'dispatched', 'in_transit', 'received', 'qc_pending', 'qc_partial',
      'ready_for_consolidation', 'consolidated'].includes(child.child_fulfillment ?? '');
  const settling = (child: { child_fulfillment: string | null }) =>
    ['consolidated'].includes(child.child_fulfillment ?? '');
  if (included.every((child) => paid(child) && settling(child))) return { code: 'ready_to_ship', label: 'آماده ارسال از انبار کلبه' };
  if (included.some(paid)) return { code: 'preparing', label: 'در حال آماده‌سازی سفارش' };
  if (included.some((child) => child.payment_eligibility === 'ready')) return { code: 'awaiting_payment', label: 'در انتظار پرداخت' };
  if (included.some((child) => child.payment_eligibility === 'blocked_buyer_decision' || child.supply_status === 'awaiting_buyer')) {
    return { code: 'needs_decision', label: 'نیازمند تأیید شما' };
  }
  return { code: 'processing', label: 'در حال آماده‌سازی سفارش' };
}

/** §58: coverage is reported per SOURCE (never one merged stock number) plus the ordered total. */
export type MasterCoverage = {
  orderedSeries: number; kolbeSeries: number; supplierAtKolbeSeries: number;
  capacitySeries: number; receivedSeries: number; qcPassedSeries: number;
};
export type MasterReadiness = 'not_ready' | 'partial' | 'ready' | 'shipped' | 'delivered' | 'cancelled';

/** §27/§28/§87: readiness is DERIVED — there is no user-editable «آماده ارسال» flag anywhere. */
export function deriveMasterReadiness(input: {
  status: string; shippedAt?: Date | string | null; deliveredAt?: Date | string | null;
  children: Array<{ status: string; composition_state: string | null; payment_eligibility: string | null; child_fulfillment: string | null }>;
  physicalReadySeries: number; capacitySeries: number; paidChildren: number;
}): MasterReadiness {
  if (input.status === 'cancelled') return 'cancelled';
  if (input.deliveredAt) return 'delivered';
  if (input.shippedAt) return 'shipped';
  const included = input.children.filter((child) => child.status !== 'cancelled'
    && !['removed', 'cancelled'].includes(child.composition_state ?? ''));
  if (included.length === 0) return 'cancelled';
  const settled = included.every((child) => child.payment_eligibility === 'paid'
    && ['ready_for_consolidation', 'consolidated', 'delivered'].includes(child.child_fulfillment ?? ''));
  if (settled && input.capacitySeries === 0) return 'ready';
  // §16/§28: declared supplier capacity is only «نیاز به تأمین» — it is NEVER physical progress, so a
  // capacity-only order stays 'not_ready' until something is actually at Kolbe; a paid order is honestly
  // 'partial' (money is settled, fulfilment has not started).
  const progressed = input.physicalReadySeries > 0 || input.paidChildren > 0
    || included.some((child) => (child.child_fulfillment ?? 'not_started') !== 'not_started');
  return progressed ? 'partial' : 'not_ready';
}

/** §48: internal event codes are mapped to Persian operational language before they leave the server. */
export function omsEventLabel(event: string, note?: string | null): string {
  const map: Record<string, string> = {
    created: 'ثبت سفارش',
    requested: 'ثبت درخواست از تأمین‌کننده',
    paid: 'پرداخت انجام شد',
    payment_ready: 'آماده پرداخت',
    awaiting_payment: 'در انتظار پرداخت',
    pending_payment: 'در انتظار پرداخت',
    confirmed: 'تأیید تأمین‌کننده',
    counter_offered: 'پیشنهاد جایگزین تأمین‌کننده',
    rejected: 'رد درخواست تأمین',
    awaiting_supplier: 'در انتظار تأمین‌کننده',
    expired: 'پایان مهلت تأمین',
    preparing: 'آماده‌سازی در انبار',
    reserved: 'رزرو انبار',
    dispatched: 'ارسال به انبار کلبه',
    in_transit: 'در مسیر انبار کلبه',
    received: 'ورود به انبار کلبه',
    qc_passed: 'کنترل کیفیت تأیید شد',
    qc_rejected: 'کنترل کیفیت رد شد',
    consolidation_started: 'شروع تجمیع',
    consolidated: 'تجمیع شد',
    ready_for_shipment: 'آماده ارسال نهایی',
    shipped: 'ارسال نهایی به خریدار',
    delivered: 'تحویل به خریدار',
    cancelled: 'لغو شد',
    composition_locked: 'قفل ترکیب سفارش',
    reassigned: 'انتقال منبع تخصیص',
    refund_pending: 'در انتظار تسویه مالی',
  };
  if (event.startsWith('fulfillment:')) return 'به‌روزرسانی وضعیت انبار';
  return map[event] ?? (note && note.trim().length ? note.trim() : 'رویداد سفارش');
}

async function masterCoverage(db: DbPool | DbClient, masterId: string) {
  const agg = await one<{
    kolbe: number; at_kolbe: number; capacity: number; received: number; qc_passed: number;
  }>(db,
    `SELECT
       COALESCE(SUM(CASE WHEN source_type = 'kolbe_stock' AND status IN ('reserved','consumed') THEN quantity END), 0)::int AS kolbe,
       COALESCE(SUM(CASE WHEN source_type = 'supplier_stock_at_kolbe' AND status IN ('reserved','consumed') THEN quantity END), 0)::int AS at_kolbe,
       COALESCE(SUM(CASE WHEN source_type = 'supplier_external' AND status IN ('pending','reserved') THEN quantity END), 0)::int AS capacity,
       COALESCE(SUM(received_series), 0)::int AS received,
       COALESCE(SUM(qc_passed_series), 0)::int AS qc_passed
     FROM order_source_allocations WHERE master_order_id = $1`, [masterId]);
  const ordered = await one<{ n: string }>(db,
    `SELECT COALESCE(SUM(COALESCE(confirmed_series, requested_series)), 0)::text AS n
       FROM child_order_lines l JOIN orders o ON o.id = l.child_order_id
      WHERE l.master_order_id = $1 AND l.status NOT IN ('removed','rejected') AND o.status <> 'cancelled'`, [masterId]);
  const coverage: MasterCoverage = {
    orderedSeries: Number(ordered?.n ?? 0),
    kolbeSeries: agg?.kolbe ?? 0,
    supplierAtKolbeSeries: agg?.at_kolbe ?? 0,
    capacitySeries: agg?.capacity ?? 0,
    receivedSeries: agg?.received ?? 0,
    qcPassedSeries: agg?.qc_passed ?? 0,
  };
  return coverage;
}

/** §59-§61: allocatable numbers per bucket for the manual allocation workspace (one query, no N+1). */
async function lineSupplyOptions(db: DbPool | DbClient, masterId: string) {
  const rows = await db.query<{
    line_id: string; kolbe_available: number; supplier_at_kolbe_available: number; offer_capacity_available: number;
  }>(
    `SELECT l.id AS line_id,
            COALESCE((SELECT SUM(b.on_hand - b.reserved - b.damaged) FROM series_stock_balances b
                       WHERE b.series_template_id = l.series_template_id AND b.owner_type = 'kolbe'), 0)::int AS kolbe_available,
            COALESCE((SELECT SUM(b.on_hand - b.reserved - b.damaged) FROM series_stock_balances b
                       WHERE b.series_template_id = l.series_template_id AND b.owner_type = 'supplier'
                         AND b.supplier_id = l.seller_id), 0)::int AS supplier_at_kolbe_available,
            COALESCE((SELECT o.declared_capacity - o.reserved_external - o.safety_buffer FROM supplier_offers o
                       WHERE o.id = l.offer_id AND o.status = 'active'), 0)::int AS offer_capacity_available
       FROM child_order_lines l
      WHERE l.master_order_id = $1 AND l.status NOT IN ('removed','rejected')`, [masterId]);
  return new Map(rows.rows.map((row) => [row.line_id, row]));
}

/**
 * §36: a `pending` supplier_external row is an UNCONFIRMED supply plan, not a capacity hold — the hold is
 * created atomically only when the supplier confirms (`supplier_offers.reserved_external`). Planning must
 * still never promise more than the offer declares, otherwise a second order would silently over-book the
 * same declared capacity and could never be fulfilled. This counts the live plan volume that is not yet
 * reflected in `reserved_external` (one query per offer, no N+1, no policy: pure arithmetic).
 */
async function pendingExternalPlanSeries(db: DbClient, offerId: string, excludeAllocationId?: string): Promise<number> {
  const row = await one<{ n: string }>(db,
    `SELECT COALESCE(SUM(quantity), 0)::text AS n FROM order_source_allocations
      WHERE offer_id = $1 AND source_type = 'supplier_external' AND status = 'pending'
        AND ($2::uuid IS NULL OR id <> $2::uuid)
        AND (reservation_expires_at IS NULL OR reservation_expires_at > now())`,
    [offerId, excludeAllocationId ?? null]);
  return Number(row?.n ?? '0');
}

/* ----------------------------- routes ----------------------------- */

const createMasterSchema = z.object({
  items: z.array(z.object({
    seriesTemplateId: z.uuid(),
    count: z.number().int().min(1).max(10000),
    offerId: z.uuid().optional(),
  }).strict()).min(1).max(60),
  shippingAddress: z.object({
    recipient: z.string().min(2).max(120), phone: z.string().min(5).max(32),
    province: z.string().min(2).max(60), city: z.string().min(2).max(60),
    line: z.string().min(5).max(400), postalCode: z.string().min(4).max(16),
  }).optional(),
  shippingMethodId: z.uuid().optional(),
  note: z.string().max(500).optional(),
}).strict();

export function registerWholesaleOmsRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const isOps = (user: Principal) =>
    user.permissions.includes('wholesale:ops') || user.permissions.includes('orders:transition');

  /* ============================ master creation (§17-§27, §53) ============================ */

  app.post('/api/v1/wholesale/masters', async (request, reply) => {
    const user = await principal(request, pool, config);
    await assertNotRestricted(pool, user.id, 'purchase');
    const body = createMasterSchema.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    // one template per master request — merged client-side; duplicates are a client bug.
    const templateIds = body.items.map((item) => item.seriesTemplateId);
    if (new Set(templateIds).size !== templateIds.length) throw badRequest('هر قالب سری فقط یک بار در سبد مجاز است.');

    const policy = await omsPolicy(pool);

    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale_master.create', key, requestHash(body));
      if (claim.previous) return claim.previous;

      // §membership: wholesale purchase requires an active VIP plan (same gate as legacy).
      const membership = await one<{ limits: Record<string, unknown> }>(client,
        `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
         WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now() LIMIT 1`,
        [user.id]);
      if (!membership) throw forbidden();
      const limits = membership.limits ?? {};
      if (typeof limits.maxOrderLines === 'number' && body.items.length > limits.maxOrderLines) {
        throw conflict('تعداد اقلام سفارش از سقف پلن بالاتر است.');
      }
      if (typeof limits.maxOrdersPerMonth === 'number' && limits.maxOrdersPerMonth >= 0) {
        const count = await one<{ count: string }>(client,
          `SELECT count(*)::text AS count FROM master_orders WHERE buyer_id = $1 AND status <> 'cancelled'
           AND created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')`,
          [user.id]);
        if (Number(count?.count ?? 0) >= limits.maxOrdersPerMonth) throw conflict('سقف سفارش ماهانه این پلن تکمیل شده است.');
      }

      type PlannedAllocation = {
        sourceType: AllocationRow['source_type']; quantity: number;
        warehouseId: string | null; ownerSupplierId: string | null; offerId: string | null;
      };
      type PlannedLine = {
        sellerKey: string; sellerType: 'kolbe' | 'supplier'; sellerId: string | null;
        templateId: string; templateName: string; productId: string; productName: string;
        offerId: string | null; offerVersion: number | null;
        requestedSeries: number; piecesPerSeries: number;
        unitSeriesPrice: bigint; baseSeriesPrice: bigint; seriesDiscount: bigint;
        allocations: PlannedAllocation[];
        pieces: Array<{ variantId: string; sku: string; productId: string; productName: string; supplierId: string | null;
          qps: number; quantity: number; physicalQuantity: number;
          basePrice: bigint; unitDiscount: bigint; finalPrice: bigint; matchedRuleId: string | null; pricing: unknown }>;
        hasExternal: boolean;
      };
      const planned: PlannedLine[] = [];
      // §36: plan volume already claimed in THIS request (the DB only holds what earlier requests wrote).
      const plannedExternal = new Map<string, number>();

      for (const item of body.items) {
        const composition = await loadSeriesComposition(client, item.seriesTemplateId);
        if (!composition || !composition.template.active) throw badRequest('قالب سری انتخاب‌شده معتبر یا فعال نیست.');
        const pps = composition.items.reduce((sum, c) => sum + c.quantity_per_series, 0);
        if (pps <= 0) throw badRequest('ترکیب سری خالی است.');

        const product = await one<{
          id: string; name: string; supplier_id: string | null; owner_type: string;
          wholesale_enabled: boolean; status: string; wholesale_moq: number | null;
        }>(client,
          `SELECT id, name, supplier_id, owner_type, wholesale_enabled, status, wholesale_moq
           FROM products WHERE id = $1`, [composition.template.product_id]);
        if (!product || product.status !== 'published') throw notFound();
        if (!product.wholesale_enabled) throw code(403, 'FORBIDDEN', `کالای «${product.name}» برای فروش عمده فعال نیست.`);

        // seller resolution: explicit offer > supplier-owned product > kolbe.
        let offer: {
          id: string; supplier_id: string; product_id: string; series_template_id: string | null; status: string;
          min_order_series: number; max_order_series: number | null; wholesale_price_rial: string | null;
          declared_capacity: number; reserved_external: number; safety_buffer: number; version: number;
        } | null = null;
        if (item.offerId) {
          offer = await one(client,
            `SELECT id, supplier_id, product_id, series_template_id, status, min_order_series, max_order_series,
                    wholesale_price_rial::text AS wholesale_price_rial, declared_capacity, reserved_external, safety_buffer, version
             FROM supplier_offers WHERE id = $1 FOR UPDATE`, [item.offerId]);
          if (!offer || offer.status !== 'active') throw code(409, 'SUPPLIER_OFFER_INACTIVE', 'پیشنهاد تأمین‌کننده فعال نیست.');
          if (offer.product_id !== product.id || (offer.series_template_id && offer.series_template_id !== item.seriesTemplateId)) {
            throw badRequest('پیشنهاد انتخاب‌شده با این قالب سری مطابقت ندارد.');
          }
        } else if (product.supplier_id) {
          offer = await one(client,
            `SELECT id, supplier_id, product_id, series_template_id, status, min_order_series, max_order_series,
                    wholesale_price_rial::text AS wholesale_price_rial, declared_capacity, reserved_external, safety_buffer, version
             FROM supplier_offers
             WHERE product_id = $1 AND supplier_id = $2 AND status = 'active'
               AND (series_template_id IS NULL OR series_template_id = $3)
             ORDER BY (series_template_id IS NOT NULL) DESC LIMIT 1 FOR UPDATE`,
            [product.id, product.supplier_id, item.seriesTemplateId]);
        }

        const sellerId = offer?.supplier_id ?? product.supplier_id ?? null;
        const sellerType: 'kolbe' | 'supplier' = sellerId ? 'supplier' : 'kolbe';
        if (sellerType === 'supplier' && (limits as Record<string, unknown>).sources === 'kolbe') throw forbidden();

        // MOQ / max (§118: canonical, line-level requested quantity).
        if (sellerType === 'supplier') {
          if (offer) {
            if (item.count < offer.min_order_series) {
              throw code(409, 'BELOW_MIN_ORDER_SERIES', `حداقل سفارش این پیشنهاد ${offer.min_order_series} سری است.`);
            }
            if (offer.max_order_series !== null && item.count > offer.max_order_series) {
              throw code(409, 'ABOVE_MAX_ORDER_SERIES', `سقف سفارش این پیشنهاد ${offer.max_order_series} سری است.`);
            }
          }
        } else {
          const moqSeries = composition.template.pricing_mode !== 'legacy_product' ? composition.template.min_order_series
            : Math.max(1, Math.ceil(Number(product.wholesale_moq ?? 1) / pps));
          if (item.count < moqSeries) throw code(409, 'BELOW_MIN_ORDER_SERIES', `حداقل سفارش «${product.name}» ${moqSeries} سری است.`);
        }

        // ---- source allocation policy (server-owned §26): physical first, external remainder ----
        const allocations: PlannedAllocation[] = [];
        let physical = 0;
        if (sellerType === 'kolbe') {
          const bal = await one<{ warehouse_id: string | null; available: string | null }>(client,
            `SELECT (SELECT b2.warehouse_id FROM series_stock_balances b2
                     WHERE b2.series_template_id = $1 AND b2.owner_type = 'kolbe'
                       AND b2.on_hand - b2.reserved - b2.damaged >= $2
                     ORDER BY b2.on_hand - b2.reserved - b2.damaged DESC LIMIT 1) AS warehouse_id,
                    SUM(on_hand - reserved - damaged)::text AS available
             FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'kolbe'`,
            [item.seriesTemplateId, item.count]);
          const tracked = await one<{ c: string }>(client,
            'SELECT count(*)::text AS c FROM series_stock_balances WHERE series_template_id = $1', [item.seriesTemplateId]);
          const isTracked = Number(tracked?.c ?? '0') > 0;
          if (isTracked && !bal?.warehouse_id) {
            throw code(409, 'INSUFFICIENT_SERIES', `سری کامل کافی از «${composition.template.name}» در انبار کلبه موجود نیست.`);
          }
          physical = item.count;
          allocations.push({ sourceType: 'kolbe_stock', quantity: item.count, warehouseId: bal?.warehouse_id ?? null, ownerSupplierId: null, offerId: null });
        } else {
          // B: supplier stock-at-kolbe first (verified, no reconfirmation §24).
          const atKolbe = await one<{ warehouse_id: string | null; available: string | null }>(client,
            `SELECT (SELECT b2.warehouse_id FROM series_stock_balances b2
                     WHERE b2.series_template_id = $1 AND b2.owner_type = 'supplier' AND b2.supplier_id = $2
                       AND b2.on_hand - b2.reserved - b2.damaged > 0
                     ORDER BY b2.on_hand - b2.reserved - b2.damaged DESC LIMIT 1) AS warehouse_id,
                    SUM(on_hand - reserved - damaged)::text AS available
             FROM series_stock_balances WHERE series_template_id = $1 AND owner_type = 'supplier' AND supplier_id = $2`,
            [item.seriesTemplateId, sellerId]);
          const atKolbeAvailable = Math.max(0, Number(atKolbe?.available ?? 0));
          physical = Math.min(item.count, atKolbeAvailable);
          if (physical > 0) {
            allocations.push({ sourceType: 'supplier_stock_at_kolbe', quantity: physical, warehouseId: atKolbe?.warehouse_id ?? null, ownerSupplierId: sellerId, offerId: offer?.id ?? null });
          }
          const remainder = item.count - physical;
          if (remainder > 0) {
            if (!offer) throw code(409, 'INSUFFICIENT_SUPPLIER_STOCK', `موجودی تأییدشده «${product.name}» کافی نیست و پیشنهاد فعالی برای تأمین خارجی وجود ندارد.`);
            const alreadyPlanned = plannedExternal.get(offer.id) ?? 0;
            const unconfirmed = await pendingExternalPlanSeries(client, offer.id);
            const freeCapacity = availableToRequest(offer) - alreadyPlanned - unconfirmed;
            if (freeCapacity < remainder) {
              throw code(409, 'INSUFFICIENT_SUPPLIER_STOCK', `ظرفیت اعلامی تأمین‌کننده برای «${product.name}» کافی نیست.`);
            }
            plannedExternal.set(offer.id, alreadyPlanned + remainder);
            // C: declared capacity ≠ eligibility — allocation stays pending until the supplier confirms (§23).
            allocations.push({ sourceType: 'supplier_external', quantity: remainder, warehouseId: null, ownerSupplierId: sellerId, offerId: offer.id });
          }
        }

        // ---- canonical pricing per piece (§64/§117) ----
        const pieces: PlannedLine['pieces'] = [];
        let unitSeriesPrice = 0n; let baseSeriesPrice = 0n;
        const commercialComponents = allocateSeriesPrice(composition.items, composition.template.pricing_mode, composition.template.total_price_rial);
        for (const component of commercialComponents) {
          const resolved = await resolveVariantPrice(client, component.variant_id, { orderType: 'wholesale', paymentMode: 'cash',
            ...(component.basePriceRial !== null ? { basePriceRial: component.basePriceRial } : {}) });
          const basePrice = rial(resolved.basePrice);
          if (basePrice === 0n && component.basePriceRial === null) throw badRequest(`قیمت فروش عمده برای SKU ${component.sku} معتبر نیست.`);
          const unitDiscount = rial(resolved.discountAmount);
          const finalPrice = rial(resolved.finalPrice);
          unitSeriesPrice += finalPrice * BigInt(component.quantity_per_series);
          baseSeriesPrice += basePrice * BigInt(component.quantity_per_series);
          pieces.push({
            variantId: component.variant_id, sku: component.sku, productId: product.id, productName: product.name,
            supplierId: sellerId, qps: component.quantity_per_series,
            quantity: component.quantity_per_series * item.count,
            physicalQuantity: component.quantity_per_series * physical,
            basePrice, unitDiscount, finalPrice, matchedRuleId: resolved.matchedRule?.id ?? null, pricing: resolved,
          });
        }

        planned.push({
          sellerKey: sellerId ?? 'kolbe', sellerType, sellerId,
          templateId: item.seriesTemplateId, templateName: composition.template.name,
          productId: product.id, productName: product.name,
          offerId: offer?.id ?? null, offerVersion: offer?.version ?? null,
          requestedSeries: item.count, piecesPerSeries: pps,
          unitSeriesPrice, baseSeriesPrice, seriesDiscount: baseSeriesPrice - unitSeriesPrice,
          allocations, pieces, hasExternal: allocations.some((a) => a.sourceType === 'supplier_external'),
        });
      }

      // plan-level master checks (same semantics as the legacy wholesale gate).
      const sellers = new Set(planned.map((line) => line.sellerKey));
      if (typeof limits.maxSuppliersPerOrder === 'number' && sellers.size > limits.maxSuppliersPerOrder) {
        throw conflict('تعداد تأمین‌کنندگان سفارش از سقف پلن بالاتر است.');
      }
      const masterSubtotal = planned.reduce((sum, line) => sum + line.unitSeriesPrice * BigInt(line.requestedSeries), 0n);
      if (typeof limits.maxOrderValueRial === 'string' && masterSubtotal > rial(limits.maxOrderValueRial)) throw conflict('مبلغ سفارش از سقف پلن بالاتر است.');
      if (typeof limits.minOrderValueRial === 'string' && masterSubtotal < rial(limits.minOrderValueRial)) throw conflict('مبلغ سفارش از کف خرید این پلن کمتر است.');
      const maxQty = limits.maxQuantityPerLine;
      if (typeof maxQty === 'number' && planned.some((line) => line.pieces.some((p) => p.quantity > maxQty))) {
        throw conflict('تعداد یک قلم از سقف پلن بالاتر است.');
      }
      const planPercent = typeof limits.discountPercent === 'number' && Number.isInteger(limits.discountPercent)
        && limits.discountPercent >= 0 && limits.discountPercent <= 90 ? limits.discountPercent : 0;

      // ---- master row ----
      const masterId = randomUUID();
      const mseq = await one<{ n: string }>(client, "SELECT nextval('master_order_seq')::text AS n");
      const masterReference = `MV-${mseq!.n}`;
      const shippingAddress = body.shippingAddress ?? {
        recipient: 'تحویل در انبار/آدرس ثبت‌شده', phone: '09120000000', province: 'تهران', city: 'تهران',
        line: 'تهران، خیابان ولیعصر، پلاک ۱۰۰', postalCode: '1111111111',
      };
      // §111: estimate only while OPEN; the binding snapshot happens at lock.
      let shippingEstimate: bigint | null = null;
      if (body.shippingMethodId) {
        const quote = await quoteShipping(client, body.shippingMethodId, {
          items: planned.flatMap((line) => line.pieces.map((p) => ({ variantId: p.variantId, quantity: p.quantity }))),
          subtotalRial: masterSubtotal, province: shippingAddress.province, city: shippingAddress.city,
        });
        shippingEstimate = quote.feeRial;
      }
      await client.query(
        `INSERT INTO master_orders(id, reference, buyer_id, composition, status, shipping_address, shipping_method_id, shipping_estimate_rial, note)
         VALUES ($1,$2,$3,'open','active',$4,$5,$6,$7)`,
        [masterId, masterReference, user.id, JSON.stringify(shippingAddress), body.shippingMethodId ?? null,
          shippingEstimate?.toString() ?? null, body.note ?? '']);

      // ---- children per seller ----
      const bySeller = new Map<string, PlannedLine[]>();
      for (const line of planned) {
        bySeller.set(line.sellerKey, [...(bySeller.get(line.sellerKey) ?? []), line]);
      }
      const childSummaries: Array<Record<string, unknown>> = [];
      for (const [sellerKey, sellerLines] of bySeller) {
        const sellerType = sellerKey === 'kolbe' ? 'kolbe' : 'supplier';
        const sellerId = sellerKey === 'kolbe' ? null : sellerKey;
        const childId = randomUUID();
        const seq = await one<{ n: string }>(client, "SELECT nextval('order_reference_seq')::text AS n");
        const reference = `KV-${seq!.n}`;
        const hasExternal = sellerLines.some((line) => line.hasExternal);

        const baseSubtotal = sellerLines.reduce((sum, line) => sum + line.baseSeriesPrice * BigInt(line.requestedSeries), 0n);
        const lineDiscount = sellerLines.reduce((sum, line) => sum + line.seriesDiscount * BigInt(line.requestedSeries), 0n);
        const planDiscount = ((baseSubtotal - lineDiscount) * BigInt(planPercent)) / 100n;
        let discount = lineDiscount + planDiscount;
        if (discount > baseSubtotal) discount = baseSubtotal;
        const total = baseSubtotal - discount;

        const respondBy = hasExternal ? new Date(Date.now() + policy.supplierRespondHours * 3_600_000) : null;
        const seriesSnapshot = sellerLines.map((line) => ({
          seriesTemplateId: line.templateId, name: line.templateName, count: line.requestedSeries,
          components: line.pieces.map((p) => ({ variantId: p.variantId, sku: p.sku, quantityPerSeries: p.qps })),
        }));
        const pricingSnapshot = {
          source: 'wholesale_master', masterOrderId: masterId, masterReference,
          baseSubtotalRial: baseSubtotal.toString(), lineDiscountRial: lineDiscount.toString(),
          planDiscountRial: planDiscount.toString(), planDiscountPercent: planPercent,
          totalDiscountRial: discount.toString(), totalRial: total.toString(),
        };

        await client.query(
          `INSERT INTO orders(
             id, reference, buyer_id, order_type, payment_mode, status, subtotal_rial, discount_rial, shipping_rial,
             total_rial, shipping_address, pricing_snapshot, fulfillment_via, inventory_domain,
             wholesale_fulfillment_status, series_snapshot, sales_channel,
             master_order_id, seller_type, seller_id, supply_status, payment_eligibility,
             supplier_respond_by, child_fulfillment, composition_state)
           VALUES ($1,$2,$3,'wholesale','cash','pending_payment',$4,$5,0,$6,$7,$8,'kolbe_warehouse','wholesale',
             $9,$10,'website',$11,$12,$13,'unresolved','not_ready',$14,'not_started','included')`,
          [childId, reference, user.id, baseSubtotal.toString(), discount.toString(), total.toString(),
            JSON.stringify(shippingAddress), JSON.stringify(pricingSnapshot),
            hasExternal ? 'awaiting_supplier' : 'ready_for_vip',
            JSON.stringify({ series: seriesSnapshot }), masterId, sellerType, sellerId, respondBy]);

        for (const line of sellerLines) {
          const lineId = randomUUID();
          const physicalAllocs = line.allocations.filter((a) => a.sourceType !== 'supplier_external');
          const lineHasExternal = line.hasExternal;
          const commercialSnapshot = {
            sellerType, sellerId, productId: line.productId, productName: line.productName,
            seriesTemplateId: line.templateId, templateName: line.templateName,
            offerId: line.offerId, offerVersion: line.offerVersion,
            requestedSeries: line.requestedSeries, piecesPerSeries: line.piecesPerSeries,
            unitSeriesPriceRial: line.unitSeriesPrice.toString(), baseSeriesPriceRial: line.baseSeriesPrice.toString(),
            allocations: line.allocations.map((a) => ({ sourceType: a.sourceType, quantity: a.quantity })),
            perPiece: line.pieces.map((p) => ({
              variantId: p.variantId, sku: p.sku, qps: p.qps,
              baseUnitPriceRial: p.basePrice.toString(), unitPriceRial: p.finalPrice.toString(),
              appliedPromotionRuleId: p.matchedRuleId,
            })),
            capturedAt: new Date().toISOString(),
          };
          await client.query(
            `INSERT INTO child_order_lines(
               id, master_order_id, child_order_id, product_id, series_template_id, offer_id, seller_type, seller_id,
               requested_series, confirmed_series, pieces_per_series, unit_series_price_rial, line_total_rial,
               commercial_snapshot, status, negotiation_history)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [lineId, masterId, childId, line.productId, line.templateId, line.offerId, sellerType, sellerId,
              line.requestedSeries, lineHasExternal ? null : line.requestedSeries,
              line.piecesPerSeries, line.unitSeriesPrice.toString(),
              (line.unitSeriesPrice * BigInt(line.requestedSeries)).toString(),
              JSON.stringify(commercialSnapshot),
              lineHasExternal ? 'awaiting_supplier' : 'stock_reserved',
              JSON.stringify([{ type: 'requested', series: line.requestedSeries, at: new Date().toISOString() }])]);

          // piece-level order_lines (invoice/WMS compatibility) — FULL requested quantity.
          for (const piece of line.pieces) {
            const pieceLineId = randomUUID();
            await client.query(
              `INSERT INTO order_lines(
                 id, order_id, product_id, variant_id, supplier_id, product_name, sku, quantity,
                 base_unit_price_rial, unit_price_rial, discount_amount_rial, line_total_rial,
                 applied_promotion_rule_id, pricing_snapshot, qc_status, inventory_domain)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending','wholesale')`,
              [pieceLineId, childId, piece.productId, piece.variantId, sellerId, piece.productName, piece.sku,
                piece.quantity, piece.basePrice.toString(), piece.finalPrice.toString(),
                (piece.unitDiscount * BigInt(piece.quantity)).toString(),
                (piece.finalPrice * BigInt(piece.quantity)).toString(),
                piece.matchedRuleId, JSON.stringify(piece.pricing)]);

            // physical piece reservation — only for the physically allocated portion (§8).
            if (piece.physicalQuantity > 0) {
              const balance = await one<{ warehouse_id: string }>(client,
                `SELECT b.warehouse_id FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
                 WHERE b.variant_id = $1 AND b.inventory_domain = 'wholesale' AND w.active = true
                   AND b.on_hand - b.reserved - b.damaged >= $2
                 ORDER BY COALESCE(b.warehouse_id = $3::uuid, false) DESC, w.code LIMIT 1 FOR UPDATE OF b`,
                [piece.variantId, piece.physicalQuantity, physicalAllocs[0]?.warehouseId ?? null]);
              if (!balance) {
                throw code(409, line.sellerType === 'kolbe' ? 'INSUFFICIENT_SERIES' : 'INSUFFICIENT_SUPPLIER_STOCK',
                  `موجودی SKU ${piece.sku} برای رزرو کافی نیست.`);
              }
              const warehouseId = balance.warehouse_id;
              await client.query(
                `UPDATE stock_balances SET reserved = reserved + $4, version = version + 1, updated_at = now()
                 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
                [piece.variantId, warehouseId, 'wholesale', piece.physicalQuantity]);
              await client.query(
                `INSERT INTO stock_reservations(id, order_line_id, variant_id, warehouse_id, inventory_domain, quantity, status)
                 VALUES ($1,$2,$3,$4,'wholesale',$5,'active')`,
                [randomUUID(), pieceLineId, piece.variantId, warehouseId, piece.physicalQuantity]);
              await client.query(
                `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
                 VALUES ($1,$2,$3,'wholesale',$4,'order reservation','order',$5,$6,$7)`,
                [randomUUID(), piece.variantId, warehouseId, piece.physicalQuantity, childId, user.id, `reserve:${pieceLineId}`]);
            }
          }

          // allocations + series-unit reservations — the SAME primitive reassignment uses.
          for (const alloc of line.allocations) {
            await createOrderAllocation(client, {
              lineId, childId, masterId, templateId: line.templateId, sourceType: alloc.sourceType,
              quantity: alloc.quantity, warehouseId: alloc.warehouseId, ownerSupplierId: alloc.ownerSupplierId,
              offerId: alloc.offerId, actorId: user.id, physicalTtlMinutes: policy.physicalReservationTtlMinutes,
            });
          }
        }

        await client.query(
          `INSERT INTO order_events(id, order_id, to_status, actor_id, note) VALUES ($1,$2,'pending_payment',$3,$4)`,
          [randomUUID(), childId, user.id,
            hasExternal ? `زیرسفارش ${reference} ثبت شد — در انتظار تأیید تأمین‌کننده (${masterReference})`
              : `زیرسفارش ${reference} ثبت و موجودی سری رزرو شد (${masterReference})`]);

        const child = await recomputeChild(client, childId, policy);
        await outbox(client, 'child_order.created', 'order', childId,
          { childOrderId: childId, reference, masterOrderId: masterId, masterReference, sellerType, sellerId });
        childSummaries.push({
          id: childId, reference, sellerType, sellerId,
          supplyStatus: child.supply_status, paymentEligibility: child.payment_eligibility,
          paymentDueAt: child.payment_due_at, subtotalRial: baseSubtotal.toString(),
          discountRial: discount.toString(), totalRial: total.toString(),
        });
      }

      await audit(client, user.id, 'wholesale_master.created', 'master_order', masterId, undefined,
        { reference: masterReference, children: childSummaries.length, subtotalRial: masterSubtotal.toString() }, request.ip);
      await outbox(client, 'wholesale_master.created', 'master_order', masterId,
        { masterOrderId: masterId, reference: masterReference, children: childSummaries.map((c) => c.id) });
      await markCartConverted(client, user.id, (childSummaries[0]?.id as string) ?? null);

      const response = {
        id: masterId, reference: masterReference, composition: 'open', status: 'active',
        shippingEstimateRial: shippingEstimate?.toString() ?? null,
        subtotalRial: masterSubtotal.toString(),
        children: childSummaries,
      };
      await completeIdempotency(client, user.id, 'wholesale_master.create', key, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  /* ============================ reads (§148-§152) ============================ */

  /* ------------------------------ §21-§23 Order Center list ------------------------------ */

  /**
   * §56-§58: the admin list. Filters (search / status / readiness / supply-required / date window / sort)
   * are server-side; clearing them always returns the canonical newest-first view. Coverage is reported per
   * SOURCE — never as one merged stock number. Non-ops callers only ever see their own masters (§65).
   */
  app.get('/api/v1/wholesale/masters', async (request) => {
    const user = await principal(request, pool, config);
    const ops = isOps(user);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.string().datetime({ offset: true }).optional(),
      buyerId: z.uuid().optional(),
      scope: z.enum(['own', 'all']).default('own'),
      search: z.string().trim().max(120).optional(),
      status: z.enum(['active', 'completed', 'cancelled']).optional(),
      readiness: z.enum(['not_ready', 'partial', 'ready', 'shipped', 'delivered', 'cancelled']).optional(),
      // §24/§62: the small customer lifecycle — filterable with the SAME derived values the list returns.
      customerStatus: z.enum(['processing', 'awaiting_payment', 'needs_decision', 'preparing',
        'ready_to_ship', 'shipped', 'delivered', 'cancelled']).optional(),
      supplyRequired: z.coerce.number().int().min(0).max(1).optional(),
      /*
       * PRODUCT-OWNER IA DECISION: source type is NOT an order type. A Master Order may hold Kolbe
       * physical stock, supplier physical stock at Kolbe and supplier capacity AT THE SAME TIME, so
       * source visibility is a FILTER on the one canonical Master Order list — never a separate
       * order center. `mixed` = more than one source bucket is actually present on the order.
       */
      coverage: z.enum(['all', 'kolbe', 'supplier_at_kolbe', 'supply_required', 'mixed']).optional(),
      dateFrom: z.string().datetime({ offset: true }).optional(),
      dateTo: z.string().datetime({ offset: true }).optional(),
      sort: z.enum(['newest', 'oldest']).default('newest'),
    }).parse(request.query ?? {});
    if (!ops && (query.scope === 'all' || (query.buyerId && query.buyerId !== user.id))) throw forbidden();
    const buyerId = ops && (query.scope === 'all' || !query.buyerId) ? null : (query.buyerId ?? user.id);

    const rows = await pool.query(
      `WITH base AS (
         SELECT m.id, m.reference, m.composition, m.status, m.shipping_estimate_rial::text AS shipping_estimate_rial,
                m.tracking_code, m.carrier, m.created_at, m.locked_at, m.shipped_at, m.delivered_at,
                u.display_name AS buyer_name,
                (SELECT count(*)::int FROM orders o WHERE o.master_order_id = m.id AND o.status <> 'cancelled') AS included_children,
                (SELECT count(*)::int FROM orders o WHERE o.master_order_id = m.id AND o.status <> 'cancelled' AND o.payment_eligibility = 'paid') AS paid_children,
                (SELECT count(*)::int FROM orders o WHERE o.master_order_id = m.id AND o.seller_type = 'supplier' AND o.status <> 'cancelled') AS supplier_children,
                -- canonical Prompt-2 meaning: children the buyer can PAY right now (VIP strip wording).
                (SELECT count(*)::int FROM orders o WHERE o.master_order_id = m.id AND o.status <> 'cancelled'
                   AND o.payment_eligibility = 'ready') AS ready_children,
                (SELECT count(*)::int FROM orders o WHERE o.master_order_id = m.id AND o.status <> 'cancelled'
                   AND o.child_fulfillment IN ('ready_for_consolidation','consolidated')) AS consolidation_ready_children,
                (SELECT COALESCE(SUM(COALESCE(l.confirmed_series, l.requested_series)), 0)::int FROM child_order_lines l
                  WHERE l.master_order_id = m.id AND l.status NOT IN ('removed','rejected')) AS ordered_series,
                (SELECT COALESCE(SUM(a.quantity), 0)::int FROM order_source_allocations a
                  WHERE a.master_order_id = m.id AND a.source_type = 'kolbe_stock' AND a.status IN ('reserved','consumed')) AS kolbe_series,
                (SELECT COALESCE(SUM(a.quantity), 0)::int FROM order_source_allocations a
                  WHERE a.master_order_id = m.id AND a.source_type = 'supplier_stock_at_kolbe' AND a.status IN ('reserved','consumed')) AS supplier_at_kolbe_series,
                (SELECT COALESCE(SUM(a.quantity), 0)::int FROM order_source_allocations a
                  WHERE a.master_order_id = m.id AND a.source_type = 'supplier_external' AND a.status IN ('pending','reserved')) AS supply_required_series,
                (SELECT COALESCE(SUM(a.received_series + a.qc_passed_series), 0)::int FROM order_source_allocations a
                  WHERE a.master_order_id = m.id AND a.source_type = 'supplier_external') AS inbound_series,
                COALESCE(SUM(o.total_rial), 0)::text AS total_rial
           FROM master_orders m
           LEFT JOIN users u ON u.id = m.buyer_id
           LEFT JOIN orders o ON o.master_order_id = m.id AND o.status <> 'cancelled' AND o.composition_state <> 'removed'
          WHERE ($1::uuid IS NULL OR m.buyer_id = $1)
            AND ($2::timestamptz IS NULL OR m.created_at < $2)
            AND ($3::text IS NULL OR m.reference ILIKE '%' || $3 || '%' OR u.display_name ILIKE '%' || $3 || '%')
            AND ($4::text IS NULL OR m.status = $4)
            AND ($5::timestamptz IS NULL OR m.created_at >= $5)
            AND ($6::timestamptz IS NULL OR m.created_at <= $6)
          GROUP BY m.id, u.display_name
       ), derived AS (
         SELECT *,
           (SELECT count(*)::int FROM orders o2 WHERE o2.master_order_id = base.id AND o2.status <> 'cancelled'
              AND o2.composition_state NOT IN ('removed','cancelled')
              AND ((o2.payment_eligibility IS NOT NULL AND o2.payment_eligibility = 'paid')
                   OR COALESCE(o2.child_fulfillment, 'not_started') <> 'not_started')) AS progressed_children,
           CASE
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN delivered_at IS NOT NULL THEN 'delivered'
             WHEN shipped_at IS NOT NULL THEN 'shipped'
             WHEN supply_required_series = 0 AND included_children > 0
                  AND paid_children = included_children
                  AND (SELECT count(*)::int FROM orders o3 WHERE o3.master_order_id = base.id
                        AND o3.status <> 'cancelled' AND o3.composition_state = 'included'
                        AND o3.child_fulfillment IN ('ready_for_consolidation','consolidated')) = included_children
               THEN 'ready'
             WHEN kolbe_series + supplier_at_kolbe_series + supply_required_series + inbound_series > 0
                  OR paid_children > 0
                  OR (SELECT count(*)::int FROM orders o4 WHERE o4.master_order_id = base.id AND o4.status <> 'cancelled'
                        AND COALESCE(o4.child_fulfillment, 'not_started') <> 'not_started') > 0
               THEN 'partial'
             ELSE 'not_ready'
           END AS readiness
         FROM base
       ), rows AS (
         SELECT *,
           CASE
             WHEN status = 'cancelled' THEN 'cancelled'
             WHEN delivered_at IS NOT NULL THEN 'delivered'
             WHEN shipped_at IS NOT NULL THEN 'shipped'
             WHEN included_children > 0 AND paid_children = included_children AND supply_required_series = 0
                  AND (SELECT count(*)::int FROM orders o5 WHERE o5.master_order_id = derived.id
                        AND o5.child_fulfillment = 'consolidated') = included_children THEN 'ready_to_ship'
             WHEN paid_children > 0 THEN 'preparing'
             WHEN included_children > 0 AND (SELECT count(*)::int FROM orders o6 WHERE o6.master_order_id = derived.id
                    AND o6.payment_eligibility = 'ready') > 0 THEN 'awaiting_payment'
             WHEN (SELECT count(*)::int FROM orders o7 WHERE o7.master_order_id = derived.id
                    AND (o7.payment_eligibility = 'blocked_buyer_decision' OR o7.supply_status = 'awaiting_buyer')) > 0 THEN 'needs_decision'
             ELSE 'processing'
           END AS customer_status,
           count(*) OVER()::int AS total_rows
         FROM derived
       )
       SELECT * FROM rows
        WHERE ($7::text IS NULL OR rows.readiness = $7)
          AND ($8::int IS NULL OR ($8 = 1 AND rows.supply_required_series > 0) OR ($8 = 0 AND rows.supply_required_series = 0))
          AND ($10::text IS NULL OR rows.customer_status = $10)
          AND ($11::text IS NULL OR $11::text = 'all'
               OR ($11 = 'kolbe' AND rows.kolbe_series > 0)
               OR ($11 = 'supplier_at_kolbe' AND rows.supplier_at_kolbe_series > 0)
               OR ($11 = 'supply_required' AND rows.supply_required_series > 0)
               OR ($11 = 'mixed' AND ((rows.kolbe_series > 0)::int + (rows.supplier_at_kolbe_series > 0)::int
                                     + (rows.supply_required_series > 0)::int) > 1))
        ORDER BY rows.created_at {order}, rows.id DESC
        LIMIT $9 OFFSET 0`.replace('{order}', query.sort === 'oldest' ? 'ASC' : 'DESC'),
      [buyerId, query.before ?? null, query.search ?? null, query.status ?? null, query.dateFrom ?? null,
        query.dateTo ?? null, query.readiness ?? null, query.supplyRequired ?? null, query.limit,
        query.customerStatus ?? null, query.coverage ?? null]);
    const items = rows.rows.map((row: Record<string, unknown> & { total_rows: number; included_children: number }) => {
      const { total_rows: totalRows, ...rest } = row;
      void totalRows;
      // `child_count` stays the canonical Prompt-2 key (Orders Hub + VIP strip already read it);
      // `included_children` is the same number under the §58 coverage vocabulary.
      return { ...rest, child_count: rest.included_children, included_children: rest.included_children };
    });
    return {
      items,
      limit: query.limit,
      sort: query.sort,
      total: rows.rows.length ? rows.rows[0]!.total_rows : 0,
    };
  });

  /* ------------------- §22-§23 detail workspace + §49/§64 serializers ------------------- */

  /**
   * ONE canonical read model, TWO server-side projections:
   *   view=buyer (default for a non-ops caller) → the strict customer projection: order facts, items with
   *       purchase-time prices, derived lifecycle and available ACTIONS. No supplier identity, no allocation
   *       rows, no capacity/warehouse internals, no fulfillment ids, no internal statuses (§20/§49/§77/§96).
   *   view=ops (staff) → the operational projection: coverage per source, readiness, allocations, buyer
   *       context, exceptions, consolidation and the internal timeline.
   * Masking happens HERE, not in React (§20).
   */
  app.get('/api/v1/wholesale/masters/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const master = await one<{
      id: string; reference: string; buyer_id: string; composition: string; status: string;
      shipping_address: Record<string, string>; shipping_method_id: string | null;
      shipping_estimate_rial: string | null; carrier: string | null; tracking_code: string | null;
      locked_at: Date | null; shipped_at: Date | null; delivered_at: Date | null; created_at: Date;
    }>(pool,
      `SELECT id, reference, buyer_id, composition, status, shipping_address, shipping_method_id,
              shipping_estimate_rial::text AS shipping_estimate_rial, carrier, tracking_code,
              locked_at, shipped_at, delivered_at, created_at
         FROM master_orders WHERE id = $1`, [id]);
    if (!master) throw notFound();
    const ops = isOps(user);
    if (!ops && master.buyer_id !== user.id) throw forbidden();

    const children = await pool.query<ChildRow & { created_at: Date; shipping_rial: string }>(
      `SELECT id, reference, buyer_id, status, master_order_id, seller_type, seller_id, supply_status, payment_eligibility,
              payment_due_at, supplier_respond_by, child_fulfillment, composition_state,
              subtotal_rial::text AS subtotal_rial, discount_rial::text AS discount_rial, total_rial::text AS total_rial,
              COALESCE(shipping_rial, 0)::text AS shipping_rial, created_at
         FROM orders WHERE master_order_id = $1 ORDER BY created_at`, [id]);
    const coverage = await masterCoverage(pool, id);
    const readiness = deriveMasterReadiness({
      status: master.status, shippedAt: master.shipped_at, deliveredAt: master.delivered_at,
      children: children.rows, physicalReadySeries: coverage.kolbeSeries + coverage.supplierAtKolbeSeries + coverage.qcPassedSeries,
      capacitySeries: coverage.capacitySeries,
      paidChildren: children.rows.filter((child) => child.payment_eligibility === 'paid' && child.status !== 'cancelled').length,
    });
    const customerStatus = masterCustomerStatus({
      status: master.status, composition: master.composition, children: children.rows,
      shippedAt: master.shipped_at, deliveredAt: master.delivered_at });

    const lines = await pool.query<LineRow & { product_name: string; series_name: string; color_label: string | null }>(
      `SELECT l.*, p.name AS product_name, t.name AS series_name, t.color_label
         FROM child_order_lines l
         JOIN products p ON p.id = l.product_id
         JOIN series_templates t ON t.id = l.series_template_id
        WHERE l.master_order_id = $1 AND l.status NOT IN ('removed','rejected')
        ORDER BY l.created_at`, [id]);
    const includedLines = lines.rows;

    if (!ops) {
      /* ------------------------------- VIP buyer projection (§49/§77/§96) ------------------------------ */
      const payable = children.rows.filter((child) => child.status !== 'cancelled'
        && child.composition_state !== 'removed' && child.payment_eligibility === 'ready');
      const needDecision = children.rows.filter((child) => child.status !== 'cancelled'
        && (child.payment_eligibility === 'blocked_buyer_decision' || child.supply_status === 'awaiting_buyer'));
      const included = children.rows.filter((child) => child.status !== 'cancelled' && child.composition_state !== 'removed');
      const totals = {
        subtotalRial: included.reduce((sum, child) => sum + BigInt(child.subtotal_rial), 0n).toString(),
        discountRial: included.reduce((sum, child) => sum + BigInt(child.discount_rial), 0n).toString(),
        shippingRial: included.reduce((sum, child) => sum + BigInt(child.shipping_rial ?? '0'), 0n).toString(),
        totalRial: included.reduce((sum, child) => sum + BigInt(child.total_rial), 0n).toString(),
      };
      const events = await pool.query<{ at: Date; event: string; note: string | null }>(
        `SELECT e.created_at AS at, e.to_status AS event, e.note FROM order_events e
           JOIN orders o ON o.id = e.order_id
          WHERE o.master_order_id = $1 ORDER BY e.created_at ASC`, [id]);
      const timeline = [
        { at: master.created_at, label: 'ثبت سفارش' },
        ...events.rows.map((row) => ({ at: row.at, label: omsEventLabel(row.event, row.note) })),
        ...(master.locked_at ? [{ at: master.locked_at, label: 'تأیید نهایی ترکیب سفارش' }] : []),
        ...(master.shipped_at ? [{ at: master.shipped_at, label: 'ارسال شده' }] : []),
        ...(master.delivered_at ? [{ at: master.delivered_at, label: 'تحویل شده' }] : []),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .filter((entry, index, all) => index === 0 || all[index - 1]!.label !== entry.label);
      return {
        view: 'buyer' as const,
        id: master.id, reference: master.reference, composition: master.composition, status: master.status,
        createdAt: master.created_at, lockedAt: master.locked_at, shippedAt: master.shipped_at, deliveredAt: master.delivered_at,
        customerStatus: customerStatus.code, customerStatusLabel: customerStatus.label,
        items: includedLines.map((line) => ({
          productName: line.product_name, seriesName: line.series_name, colorLabel: line.color_label,
          seriesCount: line.confirmed_series ?? line.requested_series,
          piecesPerSeries: line.pieces_per_series,
          pieces: (line.confirmed_series ?? line.requested_series) * line.pieces_per_series,
          unitSeriesPriceRial: line.unit_series_price_rial,
          lineTotalRial: line.line_total_rial,
        })),
        subOrders: children.rows.map((child) => ({
          reference: child.reference,
          totalRial: child.total_rial,
          statusLabel: masterCustomerStatus({ status: child.status, children: [child],
            shippedAt: master.shipped_at, deliveredAt: master.delivered_at }).label,
          payable: payable.some((row) => row.id === child.id),
          cancelled: child.status === 'cancelled' || child.composition_state === 'removed',
        })),
        totals,
        shippingEstimateRial: master.shipping_estimate_rial,
        shipping: {
          ...(master.shipping_address ?? {}),
          carrier: master.carrier, trackingCode: master.tracking_code, shippedAt: master.shipped_at, deliveredAt: master.delivered_at,
        },
        actions: {
          payableChildIds: payable.map((child) => child.id),
          canPay: payable.length > 0,
          canDecide: needDecision.length > 0,
          canLock: master.composition === 'open' && included.length > 0 && payable.length === 0 && needDecision.length === 0,
          canCancel: master.status !== 'cancelled' && !master.shipped_at && !master.delivered_at
            && included.length > 0 && included.every((child) => child.payment_eligibility !== 'paid'),
        },
        timeline,
      };
    }

    /* ------------------------------- operations projection (§21-§23/§56-§61) ------------------------------ */
    const allocations = await pool.query<AllocationRow>(
      `SELECT a.*, l.supplier_response_status, l.supplier_response_note, l.supplier_committed_series,
              l.supplier_responded_at, l.supplier_committed_at, l.supplier_ready_at
         FROM order_source_allocations a JOIN child_order_lines l ON l.id = a.line_id
        WHERE a.master_order_id = $1 ORDER BY a.created_at`, [id]);
    const exceptions = await pool.query(
      `SELECT id, child_order_id, exception_type, quantity, status, resolution, note, created_at
         FROM fulfillment_exceptions WHERE master_order_id = $1 ORDER BY created_at DESC`, [id]);
    const consolidation = await one(
      pool, `SELECT id, status, created_at, updated_at FROM master_consolidations WHERE master_order_id = $1`, [id]);
    const buyer = await one<{ id: string; name: string; email: string | null; membership_status: string | null }>(pool,
      `SELECT u.id, u.display_name AS name, u.email,
              (SELECT m.status FROM memberships m WHERE m.user_id = u.id ORDER BY m.created_at DESC LIMIT 1) AS membership_status
         FROM users u WHERE u.id = $1`, [master.buyer_id]);
    const supplyByLine = await lineSupplyOptions(pool, id);
    const events = await pool.query<{ at: Date; event: string; note: string | null }>(
      `SELECT e.created_at AS at, e.to_status AS event, e.note FROM order_events e
         JOIN orders o ON o.id = e.order_id
        WHERE o.master_order_id = $1 ORDER BY e.created_at ASC`, [id]);
    const timeline = [
      { at: master.created_at, event: 'created', note: null as string | null },
      ...events.rows.map((row) => ({ at: row.at, event: row.event, note: row.note })),
      ...(master.locked_at ? [{ at: master.locked_at, event: 'composition_locked', note: null }] : []),
      ...(master.shipped_at ? [{ at: master.shipped_at, event: 'shipped', note: `ارسال با ${master.carrier ?? ''} ${master.tracking_code ?? ''}`.trim() }] : []),
      ...(master.delivered_at ? [{ at: master.delivered_at, event: 'delivered', note: null }] : []),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    const canCancel = master.status !== 'cancelled' && !master.shipped_at && !master.delivered_at
      && includedLines.length > 0
      && allocations.rows.every((allocation) => allocation.status !== 'consumed' && allocation.received_series === 0)
      && children.rows.every((child) => !['dispatched', 'in_transit', 'received', 'qc_pending', 'qc_partial',
        'ready_for_consolidation', 'consolidated'].includes(child.child_fulfillment ?? ''));

    return {
      view: 'ops' as const,
      id: master.id, reference: master.reference, buyer_id: master.buyer_id,
      composition: master.composition, status: master.status,
      created_at: master.created_at, locked_at: master.locked_at, shipped_at: master.shipped_at, delivered_at: master.delivered_at,
      carrier: master.carrier, tracking_code: master.tracking_code,
      shipping_address: master.shipping_address,
      shipping_estimate_rial: master.shipping_estimate_rial,
      buyer,
      coverage, readiness,
      customerStatus: customerStatus.code, customerStatusLabel: customerStatus.label,
      totals: {
        subtotalRial: children.rows.filter((child) => child.status !== 'cancelled')
          .reduce((sum, child) => sum + BigInt(child.subtotal_rial), 0n).toString(),
        discountRial: children.rows.filter((child) => child.status !== 'cancelled')
          .reduce((sum, child) => sum + BigInt(child.discount_rial), 0n).toString(),
        shippingRial: children.rows.filter((child) => child.status !== 'cancelled')
          .reduce((sum, child) => sum + BigInt(child.shipping_rial), 0n).toString(),
        totalRial: children.rows.filter((child) => child.status !== 'cancelled')
          .reduce((sum, child) => sum + BigInt(child.total_rial), 0n).toString(),
      },
      children: children.rows.map((child) => ({
        id: child.id, reference: child.reference, seller_type: child.seller_type, seller_id: child.seller_id,
        status: child.status, supply_status: child.supply_status, payment_eligibility: child.payment_eligibility,
        payment_due_at: child.payment_due_at, supplier_respond_by: child.supplier_respond_by,
        child_fulfillment: child.child_fulfillment, composition_state: child.composition_state,
        subtotal_rial: child.subtotal_rial, discount_rial: child.discount_rial, total_rial: child.total_rial,
        created_at: child.created_at,
        allowedActions: childAllowedActions(child, 'ops', master.composition),
        lines: includedLines.filter((line) => line.child_order_id === child.id).map((line) => ({
          id: line.id, product_id: line.product_id, product_name: line.product_name,
          series_template_id: line.series_template_id, series_name: line.series_name, color_label: line.color_label,
          requested_series: line.requested_series, confirmed_series: line.confirmed_series,
          pieces_per_series: line.pieces_per_series, unit_series_price_rial: line.unit_series_price_rial,
          line_total_rial: line.line_total_rial, status: line.status,
          supply: supplyByLine.get(line.id) ?? null,
          allocations: allocations.rows.filter((allocation) => allocation.line_id === line.id).map((allocation) => ({
            id: allocation.id, source_type: allocation.source_type, quantity: allocation.quantity,
            status: allocation.status, owner_supplier_id: allocation.owner_supplier_id, offer_id: allocation.offer_id,
            warehouse_id: allocation.warehouse_id, received_series: allocation.received_series,
            qc_passed_series: allocation.qc_passed_series, qc_rejected_series: allocation.qc_rejected_series,
            reservation_expires_at: allocation.reservation_expires_at,
            supplier_response_status: allocation.supplier_response_status ?? 'unanswered',
            supplier_response_note: allocation.supplier_response_note ?? null,
            supplier_committed_series: allocation.supplier_committed_series ?? 0,
            supplier_responded_at: allocation.supplier_responded_at,
            supplier_committed_at: allocation.supplier_committed_at,
            supplier_ready_at: allocation.supplier_ready_at,
          })),
        })),
      })),
      exceptions: exceptions.rows,
      consolidation,
      timeline: timeline.map((row) => ({ at: row.at, label: omsEventLabel(row.event, row.note), code: row.event })),
      allowedActions: [
        ...(canCancel ? ['cancel_master'] : []),
        ...(includedLines.length > 0 ? ['reassign_allocation'] : []),
      ],
    };
  });

  /**
   * §30-§31/§82: cancel the whole master BEFORE anything irreversible happened.
   * Unwinds the OMS/WMS effects that are SAFE to unwind — series reservations released, supplier capacity
   * released, unstarted supply requirements cancelled, future fulfillment blocked — and records ONE timeline
   * event per child. Money is never touched: a paid child (ops-only cancellation) is marked
   * `cancel_refund_pending` and a refund hook is emitted for the finance scope to consume later (§55).
   * Idempotent: a repeated call (same key or not) replays the canonical result and never double-releases.
   */
  app.post('/api/v1/wholesale/masters/:id/cancel', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(4).max(500) }).strict().parse(request.body ?? {});
    const ops = isOps(user);
    const key = request.headers['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || key.length < 8 || key.length > 120)) {
      throw badRequest('Idempotency-Key معتبر لازم است.');
    }

    const result = await transaction(pool, async (client) => {
      if (typeof key === 'string') {
        const claim = await claimIdempotency(client, user.id, 'wholesale_master.cancel', key, requestHash({ id, ...body }));
        if (claim.previous) return claim.previous as Record<string, unknown>;
      }
      const master = await one<{ id: string; reference: string; buyer_id: string; status: string; shipped_at: Date | null; delivered_at: Date | null }>(
        client, 'SELECT id, reference, buyer_id, status, shipped_at, delivered_at FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (!ops && master.buyer_id !== user.id) throw forbidden();

      const children = await client.query<ChildRow & { child_fulfillment: string | null }>(
        `SELECT id, reference, buyer_id, status, master_order_id, seller_type, seller_id, supply_status, payment_eligibility,
                child_fulfillment, composition_state, subtotal_rial::text AS subtotal_rial, discount_rial::text AS discount_rial,
                total_rial::text AS total_rial
           FROM orders WHERE master_order_id = $1 ORDER BY created_at FOR UPDATE`, [id]);

      // ---- idempotent replay: the canonical result of the FIRST cancellation, without any second release ----
      if (master.status === 'cancelled') {
        const replay = {
          id: master.id, reference: master.reference, status: 'cancelled', duplicate: true,
          cancelledChildren: 0, refundPendingChildren: 0, released: { series: 0, capacity: 0, requirements: 0 },
          reason: 'already_cancelled',
        };
        if (typeof key === 'string') await completeIdempotency(client, user.id, 'wholesale_master.cancel', key, replay);
        return replay;
      }
      if (master.delivered_at) throw conflict('سفارش تحویل‌شده قابل لغو نیست؛ مسیر مرجوعی/بازگشت جداگانه است.');
      if (master.shipped_at) throw conflict('سفارش ارسال‌شده قابل لغو نیست؛ پس از ارسال فقط مسیر مرجوعی/بازگشت مجاز است.«');

      const activeChildren = children.rows.filter((child) => child.status !== 'cancelled' && child.composition_state !== 'removed');
      if (activeChildren.length === 0) throw conflict('سفارش فعالی برای لغو وجود ندارد.');
      const paidChildren = activeChildren.filter((child) => child.payment_eligibility === 'paid');
      if (!ops && paidChildren.length > 0) {
        throw forbidden('برای لغو سفارش پرداخت‌شده با پشتیبانی کلبه تماس بگیرید؛ لغو و تسویه مالی از مسیر پشتیبانی انجام می‌شود.');
      }
      // ---- §30: refuse to unwind anything that already physically happened ----
      const allocations = await client.query<AllocationRow & { received_series: number; qc_passed_series: number; dispatched_series: number }>(
        'SELECT * FROM order_source_allocations WHERE master_order_id = $1 FOR UPDATE', [id]);
      const irreversible = allocations.rows.find((allocation) => allocation.status === 'consumed'
        || allocation.received_series > 0 || allocation.qc_passed_series > 0 || allocation.dispatched_series > 0);
      if (irreversible) throw code(409, 'MASTER_ALREADY_FULFILLING',
        'بخشی از سفارش وارد انبار/کنترل کیفیت شده است و لغو کامل ممکن نیست؛ از مسیر عملیاتی/مرجوعی پیگیری کنید.');
      const fulfillingChild = activeChildren.find((child) => ['received', 'qc_pending', 'qc_partial', 'ready_for_consolidation', 'consolidated']
        .includes(child.child_fulfillment ?? ''));
      if (fulfillingChild) throw code(409, 'MASTER_ALREADY_FULFILLING',
        'بخشی از سفارش در حال تجمیع/آماده‌سازی نهایی است و لغو کامل ممکن نیست.');

      let releasedSeries = 0;
      let releasedCapacity = 0;
      let cancelledRequirements = 0;
      for (const allocation of allocations.rows) {
        if (allocation.status === 'pending' && allocation.source_type === 'supplier_external') {
          // §30: an UNSTARTED supply requirement is cancelled, never fulfilled later.
          await client.query(
            `UPDATE order_source_allocations SET status = 'cancelled', updated_at = now()
              WHERE id = $1 AND status = 'pending' AND source_type = 'supplier_external'`,
            [allocation.id]);
          cancelledRequirements += allocation.quantity;
          continue;
        }
        if (allocation.status !== 'reserved') continue;
        if (allocation.source_type === 'supplier_external') {
          // §36/§37: release the declared-capacity reservation exactly once (idempotent by construction).
          await settleSupplierCapacityReservation(client, allocation.capacity_reservation_id!, 'released');
          await client.query(
            `UPDATE order_source_allocations SET status = 'released', updated_at = now()
              WHERE id = $1 AND status = 'reserved'`, [allocation.id]);
          releasedCapacity += allocation.quantity;
        } else {
          // §15: give the physical WMS hold back through the canonical release path (never a raw decrement).
          const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [allocation.line_id]);
          if (line) await releaseLineHolds(client, line, user.id, `لغو سفارش مادر — ${body.reason}`);
          releasedSeries += allocation.quantity;
        }
      }
      // any allocation still live after the release pass (e.g. reserved rows already settled) is closed once.
      await client.query(
        `UPDATE order_source_allocations SET status = 'released', updated_at = now()
          WHERE master_order_id = $1 AND status IN ('pending','reserved')`, [id]);

      const cancelledAt = new Date();
      for (const child of activeChildren) {
        const wasPaid = child.payment_eligibility === 'paid';
        await client.query(
          `UPDATE orders SET status = 'cancelled',
             composition_state = CASE WHEN composition_state = 'included' THEN $2 ELSE composition_state END,
             child_fulfillment = 'not_started', supply_status = 'rejected',
             payment_eligibility = CASE WHEN payment_eligibility = 'paid' THEN 'paid' ELSE 'not_ready' END,
             wholesale_fulfillment_status = 'cancelled', updated_at = now()
           WHERE id = $1`, [child.id, wasPaid ? 'cancel_refund_pending' : 'cancelled']);
        await client.query(
          `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
           VALUES ($1,$2,$3,'cancelled',$4,$5)`,
          [randomUUID(), child.id, child.status, user.id, `لغو سفارش مادر: ${body.reason}`]);
        if (wasPaid) {
          // §30/§55: cancellation does NOT implement refunds — it flags the money for the finance scope.
          await outbox(client, 'child_order.refund_requested', 'order', child.id,
            { childOrderId: child.id, masterOrderId: id, reason: body.reason, requestedAt: cancelledAt.toISOString() });
        }
        await outbox(client, 'child_order.cancelled', 'order', child.id,
          { childOrderId: child.id, masterOrderId: id, reason: body.reason, paid: wasPaid });
      }
      await client.query(
        `UPDATE master_orders SET status = 'cancelled', updated_at = now(), note = COALESCE(note,'') WHERE id = $1`, [id]);
      const summary = {
        id: master.id, reference: master.reference, status: 'cancelled', duplicate: false,
        cancelledChildren: activeChildren.length,
        refundPendingChildren: paidChildren.length,
        released: { series: releasedSeries, capacity: releasedCapacity, requirements: cancelledRequirements },
        reason: body.reason,
      };
      await audit(client, user.id, 'wholesale_master.cancelled', 'master_order', id,
        { status: master.status }, summary, request.ip);
      await outbox(client, 'wholesale_master.cancelled', 'master_order', id, summary);
      if (typeof key === 'string') await completeIdempotency(client, user.id, 'wholesale_master.cancel', key, summary);
      return summary;
    });
    return reply.code(200).send(result);
  });

  /**
   * §33/§90: explicit, audited SOURCE REASSIGNMENT of one allocation (release A → assign B). Supported cases:
   *   • same supplier, capacity → that supplier's physical stock at Kolbe (an operational upgrade, no confirmation needed);
   *   • same supplier, physical stock → capacity (the goods are no longer in Kolbe; the supplier must confirm again);
   *   • another supplier's active offer for the SAME Series (cross-supplier substitution): the old capacity is
   *     released, the demand is re-pointed to the new supplier and returns to «نیاز به تأمین» until THAT supplier
   *     confirms (§23 — declared capacity is never eligibility). The buyer price never changes because wholesale
   *     price comes from the canonical Series pricing authority, never from the supplier offer; a mismatch aborts.
   * Demand is conserved (§34): the replacement allocation carries exactly the released quantity, and the
   * requested/confirmed series of the line are never rewritten.
   */
  app.post('/api/v1/wholesale/allocations/:id/reassign', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      toOfferId: z.uuid().optional(),
      toSource: z.enum(['supplier_stock_at_kolbe', 'supplier_external']).optional(),
      reason: z.string().trim().min(4).max(500),
    }).strict().parse(request.body ?? {});
    if (!body.toOfferId && !body.toSource) throw badRequest('مقصد بازتخصیص (پیشنهاد تأمین‌کننده یا نوع منبع) لازم است.');
    const policy = await omsPolicy(pool);
    const idemPayload = { allocationId: id, ...body };
    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = typeof rawIdempotencyKey === 'string' && rawIdempotencyKey.length >= 8 && rawIdempotencyKey.length <= 120
      ? rawIdempotencyKey : `oms-reassign:${id}:${requestHash(idemPayload)}`;

    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale_allocation.reassign', idempotencyKey, requestHash(idemPayload));
      if (claim.previous) return claim.previous as Record<string, unknown>;
      const allocation = await one<AllocationRow>(client,
        'SELECT * FROM order_source_allocations WHERE id = $1 FOR UPDATE', [id]);
      if (!allocation) throw notFound();
      const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [allocation.line_id]);
      if (!line) throw notFound();
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [allocation.child_order_id]);
      if (!child) throw notFound();
      if (['removed', 'rejected'].includes(line.status)) throw conflict('ردیف سفارش فعال نیست.');
      if (!['pending', 'reserved', 'exception'].includes(allocation.status)) {
        throw conflict('این تخصیص در وضعیت فعلی قابل بازتخصیص نیست.');
      }
      // §33: never after irreversibility (received/QC/dispatch/consolidation).
      if (allocation.received_series > 0 || allocation.qc_passed_series > 0 || allocation.dispatched_series > 0
        || ['dispatched', 'in_transit', 'received', 'qc_pending', 'qc_partial', 'ready_for_consolidation', 'consolidated']
          .includes(child.child_fulfillment ?? '')) {
        throw code(409, 'ALLOCATION_ALREADY_FULFILLING', 'این تخصیص وارد مرحله ورود/کنترل کیفیت شده است و بازتخصیص مجاز نیست.');
      }

      let targetSource: 'supplier_external' | 'supplier_stock_at_kolbe' = 'supplier_external';
      let targetOfferId: string | null = allocation.offer_id;
      let targetSupplierId: string | null = allocation.owner_supplier_id;
      let targetWarehouseId: string | null = null;

      if (body.toOfferId) {
        const offer = await one<{ id: string; supplier_id: string; series_template_id: string | null; product_id: string; status: string; declared_capacity: number; reserved_external: number; safety_buffer: number }>(
          client, `SELECT id, supplier_id, series_template_id, product_id, status, declared_capacity, reserved_external, safety_buffer
                     FROM supplier_offers WHERE id = $1`, [body.toOfferId]);
        if (!offer || offer.status !== 'active') throw conflict('پیشنهاد تأمین‌کننده مقصد فعال نیست.');
        if (offer.product_id !== line.product_id) throw badRequest('پیشنهاد مقصد به همین کالا/سری تعلق ندارد.');
        if (offer.series_template_id && offer.series_template_id !== line.series_template_id) {
          throw badRequest('پیشنهاد مقصد به همین قالب سری تعلق ندارد.');
        }
        targetOfferId = offer.id;
        targetSupplierId = offer.supplier_id;
        // §34/§36: never plan beyond what the target can actually take.
        const unconfirmedTarget = await pendingExternalPlanSeries(client, offer.id, allocation.id);
        if (availableToRequest(offer) - unconfirmedTarget < allocation.quantity) {
          throw conflict('ظرفیت آزاد پیشنهاد مقصد برای این مقدار کافی نیست.');
        }
        const atKolbe = await one<{ available: string | null; warehouse_id: string | null }>(client,
          `SELECT COALESCE(SUM(b.on_hand - b.reserved - b.damaged), 0)::text AS available,
                  (SELECT b2.warehouse_id FROM series_stock_balances b2
                    WHERE b2.series_template_id = $1 AND b2.owner_type = 'supplier' AND b2.supplier_id = $2
                      AND b2.on_hand - b2.reserved - b2.damaged >= $3
                    ORDER BY b2.on_hand DESC LIMIT 1) AS warehouse_id
             FROM series_stock_balances b
            WHERE b.series_template_id = $1 AND b.owner_type = 'supplier' AND b.supplier_id = $2`,
          [line.series_template_id, offer.supplier_id, allocation.quantity]);
        if (body.toSource === 'supplier_stock_at_kolbe') {
          if (!atKolbe?.warehouse_id || Number(atKolbe.available ?? 0) < allocation.quantity) {
            throw conflict('موجودی فیزیکی تأمین‌کننده مقصد نزد کلبه برای این بازتخصیص کافی نیست.');
          }
          targetSource = 'supplier_stock_at_kolbe';
          targetWarehouseId = atKolbe.warehouse_id;
        } else if (targetSupplierId === allocation.owner_supplier_id && atKolbe?.warehouse_id
          && Number(atKolbe.available ?? 0) >= allocation.quantity
          && allocation.source_type === 'supplier_external' && body.toSource === undefined) {
          // same supplier with the SAME quantity already present at Kolbe → upgrade to physical without reconfirmation.
          targetSource = 'supplier_stock_at_kolbe';
          targetWarehouseId = atKolbe.warehouse_id;
        } else {
          targetSource = 'supplier_external';
        }
      } else if (body.toSource) {
        if (body.toSource === 'supplier_external' && allocation.source_type !== 'supplier_stock_at_kolbe') {
          throw badRequest('این تخصیص فیزیکی نیست؛ انتقال به ظرفیت معنایی ندارد.');
        }
        targetSource = body.toSource;
        if (targetSource === 'supplier_stock_at_kolbe') {
          const atKolbe = await one<{ available: string | null; warehouse_id: string | null }>(client,
            `SELECT COALESCE(SUM(b.on_hand - b.reserved - b.damaged), 0)::text AS available,
                    (SELECT b2.warehouse_id FROM series_stock_balances b2
                      WHERE b2.series_template_id = $1 AND b2.owner_type = 'supplier' AND b2.supplier_id = $2
                        AND b2.on_hand - b2.reserved - b2.damaged >= $3
                      ORDER BY b2.on_hand DESC LIMIT 1) AS warehouse_id
               FROM series_stock_balances b
              WHERE b.series_template_id = $1 AND b.owner_type = 'supplier' AND b.supplier_id = $2`,
            [line.series_template_id, allocation.owner_supplier_id, allocation.quantity]);
          if (!atKolbe?.warehouse_id || Number(atKolbe.available ?? 0) < allocation.quantity) {
            throw conflict('موجودی فیزیکی تأمین‌کننده نزد کلبه برای این بازتخصیص کافی نیست.');
          }
          targetWarehouseId = atKolbe.warehouse_id;
        }
      }

      // §14/§90: the buyer price is NEVER derived from the supplier offer — assert that stays true here.
      const composition = await loadSeriesComposition(client, line.series_template_id);
      if (!composition) throw notFound();
      let expectedSeriesPrice = 0n;
      for (const component of allocateSeriesPrice(composition.items, composition.template.pricing_mode, composition.template.total_price_rial)) {
        const resolved = await resolveVariantPrice(client, component.variant_id, { orderType: 'wholesale', paymentMode: 'cash',
          ...(component.basePriceRial !== null ? { basePriceRial: component.basePriceRial } : {}) });
        expectedSeriesPrice += rial(resolved.finalPrice) * BigInt(component.quantity_per_series);
      }
      if (expectedSeriesPrice !== BigInt(line.unit_series_price_rial)) {
        throw code(409, 'REASSIGN_PRICE_CHANGED',
          'قیمت سری از زمان ثبت سفارش تغییر کرده است؛ بازتخصیص بدون بازبینی قیمت خریدار مجاز نیست.');
      }

      const releaseReason = `بازتخصیص منبع — ${body.reason}`;
      // Release only allocation A; never free siblings from this line/master.
      if (allocation.status === 'pending' || allocation.status === 'reserved') {
        await releaseAllocationHold(client, allocation, line, user.id, releaseReason);
      } else {
        await client.query(
          `UPDATE order_source_allocations SET status = 'released', capacity_reservation_id = NULL,
             reservation_expires_at = NULL, updated_at = now() WHERE id = $1`, [allocation.id]);
      }

      // ---- assign B through the ONE canonical allocation primitive ----
      const replacement = await createOrderAllocation(client, {
        lineId: line.id, childId: child.id, masterId: allocation.master_order_id, templateId: line.series_template_id,
        sourceType: targetSource, quantity: allocation.quantity, warehouseId: targetWarehouseId,
        ownerSupplierId: targetSupplierId, offerId: targetOfferId, actorId: user.id,
        physicalTtlMinutes: policy.physicalReservationTtlMinutes,
      });

      // A changed/reassigned external source always re-enters supplier review. Physical stock-at-Kolbe
      // is immediately reserved; no supplier response is required unless another external allocation remains.
      const externalLeft = await one<{ n: string }>(client,
        `SELECT count(*)::text AS n FROM order_source_allocations
         WHERE line_id = $1 AND source_type = 'supplier_external' AND status IN ('pending','reserved')`, [line.id]);
      const awaitingExternal = Number(externalLeft?.n ?? 0) > 0;
      const lineState = targetSource === 'supplier_external' || awaitingExternal ? 'awaiting_supplier' : 'stock_reserved';
      const supplierChanged = Boolean(targetSupplierId) && targetSupplierId !== allocation.owner_supplier_id;
      await client.query(
        `UPDATE child_order_lines SET seller_id = $2, offer_id = $3, status = $4,
           confirmed_series = CASE WHEN $4 = 'stock_reserved' THEN requested_series ELSE NULL END,
           proposed_series = NULL, supplier_response_status = 'unanswered', supplier_response_note = NULL,
           supplier_responded_at = NULL, supplier_committed_series = 0, supplier_committed_at = NULL,
           supplier_ready_at = NULL, responded_at = NULL, updated_at = now() WHERE id = $1`,
        [line.id, targetSupplierId, targetOfferId, lineState]);
      await client.query(
        `UPDATE orders SET seller_id = $2, seller_type = 'supplier', updated_at = now() WHERE id = $1`,
        [child.id, targetSupplierId]);
      if (awaitingExternal) {
        await client.query("UPDATE orders SET supplier_respond_by = now() + ($2::int * interval '1 hour') WHERE id = $1",
          [child.id, policy.supplierRespondHours]);
      } else {
        await client.query('UPDATE orders SET supplier_respond_by = NULL WHERE id = $1', [child.id]);
      }
      await appendNegotiation(client, line.id, {
        type: 'reassigned', fromAllocationId: allocation.id, toAllocationId: replacement.id,
        fromSource: allocation.source_type, toSource: targetSource, fromOfferId: allocation.offer_id,
        toOfferId: targetOfferId, fromSupplierId: allocation.owner_supplier_id, toSupplierId: targetSupplierId,
        quantity: allocation.quantity, reason: body.reason, actorId: user.id, at: new Date().toISOString(),
      });
      await recomputeChild(client, child.id, policy);
      const history = await one<{ negotiation_history: unknown[] }>(client,
        'SELECT negotiation_history FROM child_order_lines WHERE id = $1', [line.id]);
      await audit(client, user.id, 'wholesale_allocation.reassigned', 'order_source_allocation', allocation.id,
        { sourceType: allocation.source_type, offerId: allocation.offer_id, ownerSupplierId: allocation.owner_supplier_id, status: allocation.status },
        { sourceType: targetSource, offerId: targetOfferId, ownerSupplierId: targetSupplierId, replacementId: replacement.id, reason: body.reason },
        request.ip);
      await outbox(client, 'wholesale_allocation.reassigned', 'order_source_allocation', allocation.id,
        { allocationId: allocation.id, replacementAllocationId: replacement.id, masterOrderId: allocation.master_order_id,
          quantity: allocation.quantity, from: allocation.source_type, to: targetSource, supplierChanged });
      const response = {
        allocationId: allocation.id, replacementAllocationId: replacement.id, replacementStatus: replacement.status,
        source: targetSource, supplierChanged, quantity: allocation.quantity,
        supplierConfirmationRequired: targetSource === 'supplier_external',
        history: (history?.negotiation_history ?? []).length,
      };
      await completeIdempotency(client, user.id, 'wholesale_allocation.reassign', idempotencyKey, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  /* ============================ supplier panel (§71-§72) ============================ */

  app.get('/api/v1/wholesale/supplier/child-orders', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.iso.datetime().optional(),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT o.id, o.reference, o.status, o.supply_status, o.payment_eligibility, o.child_fulfillment,
              o.supplier_respond_by, o.created_at, m.reference AS master_reference,
              COALESCE((SELECT json_agg(json_build_object(
                  'id', l.id, 'productId', l.product_id, 'seriesTemplateId', l.series_template_id,
                  'requestedSeries', l.requested_series, 'proposedSeries', l.proposed_series,
                  'confirmedSeries', l.confirmed_series, 'status', l.status,
                  'piecesPerSeries', l.pieces_per_series,
                  'productName', l.commercial_snapshot->>'productName',
                  'templateName', l.commercial_snapshot->>'templateName',
                  'externalSeries', (SELECT COALESCE(SUM(a.quantity), 0) FROM order_source_allocations a
                                     WHERE a.line_id = l.id AND a.source_type = 'supplier_external'
                                       AND a.status IN ('pending','reserved')),
                  'stockAtKolbeSeries', (SELECT COALESCE(SUM(a.quantity), 0) FROM order_source_allocations a
                                     WHERE a.line_id = l.id AND a.source_type = 'supplier_stock_at_kolbe'
                                       AND a.status IN ('reserved','consumed'))
                ) ORDER BY l.created_at)
                FROM child_order_lines l WHERE l.child_order_id = o.id AND l.seller_id = $1), '[]'::json) AS lines
       FROM orders o JOIN master_orders m ON m.id = o.master_order_id
       WHERE o.seller_id = $1 AND o.master_order_id IS NOT NULL
         AND ($2::timestamptz IS NULL OR o.created_at < $2)
       ORDER BY o.created_at DESC LIMIT $3`,
      [user.id, query.before ?? null, query.limit]);
    // §72: no buyer identity/address is exposed to the supplier.
    return { items: rows.rows };
  });

  const respondSchema = z.object({
    action: z.enum(['confirm', 'counter', 'reject']),
    proposedSeries: z.number().int().min(1).optional(),
    note: z.string().trim().max(400).optional(),
  }).strict();
  type SupplierResponseBody = z.infer<typeof respondSchema>;

  const idempotencyFor = (request: import('fastify').FastifyRequest, scope: string, payload: unknown) => {
    const header = request.headers['idempotency-key'];
    if (typeof header === 'string' && header.length >= 8 && header.length <= 120) return header;
    // Backward-compatible clients still get server-enforced, actor-scoped, payload-bound replay safety.
    return `p5:${scope}:${requestHash(payload)}`;
  };

  async function performSupplierResponse(request: import('fastify').FastifyRequest, user: Principal,
    lineId: string, body: SupplierResponseBody, allocationId?: string) {
    const policy = await omsPolicy(pool);
    const payload = { lineId, allocationId: allocationId ?? null, ...body };
    const key = idempotencyFor(request, lineId, payload);
    return transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale_supplier.respond', key, requestHash(payload));
      if (claim.previous) return claim.previous;

      const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [lineId]);
      if (!line) throw notFound();
      if (line.seller_id !== user.id) throw forbidden();
      if (allocationId) {
        const scoped = await one<{ id: string }>(client,
          `SELECT id FROM order_source_allocations
           WHERE id = $1 AND line_id = $2 AND owner_supplier_id = $3
             AND source_type = 'supplier_external' AND status = 'pending' FOR UPDATE`,
          [allocationId, lineId, user.id]);
        if (!scoped) throw notFound();
      }
      if (line.status !== 'awaiting_supplier') {
        throw code(409, 'SUPPLIER_CONFIRMATION_REQUIRED', 'این ردیف در وضعیت انتظار پاسخ تأمین‌کننده نیست.');
      }
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [line.child_order_id]);
      if (!child || child.status !== 'pending_payment') throw code(409, 'CHILD_ALREADY_PAID', 'زیرسفارش قابل تغییر نیست.');

      const externalAllocs = await client.query<AllocationRow>(
        `SELECT * FROM order_source_allocations
         WHERE line_id = $1 AND owner_supplier_id = $2 AND source_type = 'supplier_external' AND status = 'pending'
         ORDER BY created_at FOR UPDATE`, [lineId, user.id]);
      if (!externalAllocs.rows.length) throw conflict('نیاز بیرونی فعالی برای این ردیف وجود ندارد.');
      const externalQty = externalAllocs.rows.reduce((sum, allocation) => sum + allocation.quantity, 0);
      const physicalQty = Math.max(0, line.requested_series - externalQty);
      let responseStatus: string;
      let lineStatus: string;

      if (body.action === 'confirm') {
        // Acceptance atomically reserves declared capacity; OMS holds are durable and have no standalone TTL.
        for (const allocation of externalAllocs.rows) {
          if (!allocation.offer_id) throw code(409, 'CAPACITY_RESERVATION_FAILED', 'پیشنهاد مرتبط با این تخصیص یافت نشد.');
          let reservationId: string;
          try {
            const reserved = await reserveSupplierCapacity(client, {
              offerId: allocation.offer_id, quantity: allocation.quantity, ttlMinutes: null,
              referenceType: 'order_source_allocation', referenceId: allocation.id,
              note: `پذیرش تأمین زیرسفارش ${child.reference}`, actorId: user.id,
              idempotencyKey: `oms-capacity:${allocation.id}`,
            });
            reservationId = reserved.reservationId;
          } catch {
            throw code(409, 'CAPACITY_RESERVATION_FAILED', 'رزرو اتمیک ظرفیت اعلامی ناکام ماند — ظرفیت کافی نیست.');
          }
          await client.query(
            `UPDATE order_source_allocations SET status = 'reserved', capacity_reservation_id = $2,
               reservation_expires_at = NULL, reserved_at = now(), updated_at = now() WHERE id = $1`,
            [allocation.id, reservationId]);
        }
        responseStatus = 'accepted';
        lineStatus = 'confirmed';
        await client.query(
          `UPDATE child_order_lines SET status = 'confirmed', confirmed_series = requested_series,
             supplier_response_status = 'accepted', supplier_response_note = $2,
             supplier_responded_at = now(), supplier_committed_series = 0,
             supplier_committed_at = NULL, supplier_ready_at = NULL,
             responded_at = now(), updated_at = now() WHERE id = $1`, [lineId, body.note ?? null]);
        await appendNegotiation(client, lineId, { type: 'supplier_confirmed', series: line.requested_series, by: user.id, note: body.note ?? '' });
      } else if (body.action === 'counter') {
        const proposed = body.proposedSeries;
        if (!proposed || proposed >= line.requested_series) throw badRequest('پیشنهاد جایگزین باید کمتر از تعداد درخواستی باشد.');
        if (proposed < physicalQty) throw badRequest('پیشنهاد جایگزین نمی‌تواند از سهم موجودی تأییدشده نزد کلبه کمتر باشد.');
        responseStatus = 'revised';
        lineStatus = 'awaiting_buyer';
        await client.query(
          `UPDATE child_order_lines SET status = 'awaiting_buyer', proposed_series = $2,
             supplier_response_status = 'revised', supplier_response_note = $3,
             supplier_responded_at = now(), supplier_committed_series = 0,
             supplier_committed_at = NULL, supplier_ready_at = NULL,
             responded_at = now(), updated_at = now() WHERE id = $1`, [lineId, proposed, body.note ?? null]);
        await appendNegotiation(client, lineId, {
          type: 'supplier_counter', requested: line.requested_series, proposed, by: user.id, note: body.note ?? '',
        });
      } else {
        // Rejection releases any physical holds but preserves every series of OMS demand as reassignable pending allocations.
        await releaseLineHolds(client, line, user.id, 'رد نیاز تأمین توسط تأمین‌کننده', true);
        await removeLinePieces(client, line, user.id);
        responseStatus = 'rejected';
        lineStatus = 'timed_out';
        await client.query(
          `UPDATE child_order_lines SET status = 'timed_out', proposed_series = NULL, confirmed_series = NULL,
             supplier_response_status = 'rejected', supplier_response_note = $2, supplier_responded_at = now(),
             supplier_committed_series = 0, supplier_committed_at = NULL, supplier_ready_at = NULL,
             responded_at = now(), updated_at = now() WHERE id = $1`, [lineId, body.note ?? null]);
        await appendNegotiation(client, lineId, { type: 'supplier_rejected', by: user.id, note: body.note ?? '' });
      }

      const updated = await recomputeChild(client, line.child_order_id, policy);
      await audit(client, user.id, `wholesale_supplier.${body.action}`, 'child_order_line', lineId,
        undefined, { childOrderId: line.child_order_id, allocationId: allocationId ?? null,
          proposedSeries: body.proposedSeries ?? null, responseStatus }, request.ip);
      await outbox(client, `child_order.supplier_${body.action}`, 'order', line.child_order_id,
        { lineId, action: body.action, proposedSeries: body.proposedSeries ?? null, responseStatus });
      const result = { ok: true, lineStatus, responseStatus,
        child: { id: updated.id, supplyStatus: updated.supply_status, paymentEligibility: updated.payment_eligibility } };
      await completeIdempotency(client, user.id, 'wholesale_supplier.respond', key, result);
      return result;
    });
  }

  app.get('/api/v1/wholesale/supplier/supply-requests', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const query = z.object({
      state: z.enum(['open', 'history', 'all']).default('open'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT a.id AS "allocationId", l.id AS "lineId", o.id AS "childOrderId", o.reference AS "orderReference",
              o.status AS "childStatus", o.payment_eligibility AS "paymentEligibility",
              o.child_fulfillment AS "childFulfillment", p.name AS "productName", t.name AS "seriesName",
              t.color_label AS "colorLabel", l.requested_series AS "requestedSeries",
              a.quantity AS "externalSeries", l.proposed_series AS "proposedSeries",
              l.confirmed_series AS "confirmedSeries", l.status AS "lineStatus",
              a.status AS "allocationStatus", l.supplier_response_status AS "responseStatus",
              l.supplier_response_note AS "responseNote", l.supplier_committed_series AS "committedSeries",
              l.supplier_responded_at AS "respondedAt", l.supplier_committed_at AS "committedAt",
              l.supplier_ready_at AS "readyAt", a.created_at AS "createdAt", a.updated_at AS "updatedAt"
       FROM order_source_allocations a
       JOIN child_order_lines l ON l.id = a.line_id AND l.seller_id = $1
       JOIN orders o ON o.id = a.child_order_id AND o.master_order_id IS NOT NULL
       JOIN products p ON p.id = l.product_id
       JOIN series_templates t ON t.id = l.series_template_id
       WHERE a.owner_supplier_id = $1 AND a.source_type = 'supplier_external'
         AND ($2::text = 'all'
              OR ($2::text = 'open' AND a.status IN ('pending','reserved')
                  AND l.supplier_response_status IN ('unanswered','revised','accepted','committed','ready'))
              OR ($2::text = 'history' AND (a.status NOT IN ('pending','reserved')
                  OR l.supplier_response_status IN ('rejected','cancelled'))))
       ORDER BY a.created_at DESC LIMIT $3`, [user.id, query.state, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/wholesale/supplier/supply-requests/:allocationId/respond', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const { allocationId } = z.object({ allocationId: z.uuid() }).parse(request.params);
    const body = respondSchema.parse(request.body);
    const scoped = await one<{ line_id: string }>(pool,
      `SELECT line_id FROM order_source_allocations
       WHERE id = $1 AND owner_supplier_id = $2 AND source_type = 'supplier_external'`, [allocationId, user.id]);
    if (!scoped) throw notFound();
    return performSupplierResponse(request, user, scoped.line_id, body, allocationId);
  });

  app.post('/api/v1/wholesale/supplier/lines/:lineId/respond', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const { lineId } = z.object({ lineId: z.uuid() }).parse(request.params);
    const body = respondSchema.parse(request.body);
    return performSupplierResponse(request, user, lineId, body);
  });

  async function transitionSupplierAllocation(request: import('fastify').FastifyRequest,
    user: Principal, allocationId: string, action: 'commit' | 'ready' | 'cancel', note: string) {
    const policy = await omsPolicy(pool);
    const payload = { allocationId, action, note };
    const key = idempotencyFor(request, allocationId, payload);
    return transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, `wholesale_supplier.${action}`, key, requestHash(payload));
      if (claim.previous) return claim.previous;
      const current = await one<AllocationRow & {
        seller_id: string; line_status: string; response_status: string; child_status: string;
        payment_eligibility: string; child_fulfillment: string | null;
      }>(client,
        `SELECT a.*, l.seller_id, l.status AS line_status, l.supplier_response_status AS response_status,
                o.status AS child_status, o.payment_eligibility, o.child_fulfillment
         FROM order_source_allocations a
         JOIN child_order_lines l ON l.id = a.line_id
         JOIN orders o ON o.id = a.child_order_id
         WHERE a.id = $1 FOR UPDATE OF a,l,o`, [allocationId]);
      if (!current || current.owner_supplier_id !== user.id || current.seller_id !== user.id
        || current.source_type !== 'supplier_external') throw notFound();
      const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [current.line_id]);
      if (!line) throw notFound();
      if (current.child_status === 'cancelled') throw conflict('سفارش مادر یا زیرسفارش لغو شده است.');
      let result: Record<string, unknown>;

      if (action === 'commit') {
        if (current.status !== 'reserved' || current.response_status !== 'accepted'
          || current.child_status !== 'pending_payment'
          || !['ready','paid'].includes(current.payment_eligibility)) {
          throw conflict('فقط تأمین پذیرفته‌شده و رزروشده، پیش از ارسال، قابل تعهد نهایی است.');
        }
        const committed = await one<{ quantity: number }>(client,
          `SELECT COALESCE(sum(quantity),0)::int AS quantity FROM order_source_allocations
           WHERE line_id = $1 AND owner_supplier_id = $2 AND source_type = 'supplier_external' AND status = 'reserved'`,
          [line.id, user.id]);
        await client.query(
          `UPDATE child_order_lines SET supplier_response_status = 'committed',
             supplier_response_note = COALESCE(NULLIF($2,''), supplier_response_note),
             supplier_committed_series = $3, supplier_committed_at = now(), updated_at = now() WHERE id = $1`,
          [line.id, note, committed?.quantity ?? current.quantity]);
        await appendNegotiation(client, line.id, { type: 'supplier_committed', series: committed?.quantity ?? current.quantity,
          by: user.id, note, at: new Date().toISOString() });
        result = { allocationId, responseStatus: 'committed', committedSeries: committed?.quantity ?? current.quantity };
      } else if (action === 'ready') {
        if (current.status !== 'reserved' || current.response_status !== 'committed'
          || current.payment_eligibility !== 'paid' || current.line_status !== 'confirmed') {
          throw conflict('آماده‌بودن فقط پس از تعهد نهایی و پرداخت خریدار قابل ثبت است.');
        }
        await client.query(
          `UPDATE child_order_lines SET supplier_response_status = 'ready', supplier_ready_at = now(),
             supplier_response_note = COALESCE(NULLIF($2,''), supplier_response_note), updated_at = now() WHERE id = $1`,
          [line.id, note]);
        await appendNegotiation(client, line.id, { type: 'supplier_ready_for_kolbe', series: line.supplier_committed_series,
          by: user.id, note, at: new Date().toISOString() });
        result = { allocationId, responseStatus: 'ready', readyAt: new Date().toISOString(), inventoryChanged: false };
      } else {
        if (current.status !== 'reserved' || !['accepted','committed'].includes(current.response_status)
          || current.child_status !== 'pending_payment' || current.payment_eligibility === 'paid'
          || current.payment_eligibility === 'expired' || current.line_status !== 'confirmed') {
          throw conflict('لغو تعهد فقط پیش از پرداخت و پیش از آماده‌سازی/ارسال مجاز است.');
        }
        await releaseLineHolds(client, line, user.id, note || 'لغو تعهد تأمین‌کننده — حفظ نیاز سفارش', true);
        await removeLinePieces(client, line, user.id);
        await client.query(
          `UPDATE child_order_lines SET status = 'timed_out', proposed_series = NULL, confirmed_series = NULL,
             supplier_response_status = 'cancelled', supplier_response_note = $2, supplier_responded_at = now(),
             supplier_committed_series = 0, supplier_committed_at = NULL, supplier_ready_at = NULL,
             responded_at = now(), updated_at = now() WHERE id = $1`, [line.id, note || 'لغو تعهد توسط تأمین‌کننده']);
        await client.query('UPDATE orders SET supplier_respond_by = NULL, updated_at = now() WHERE id = $1', [line.child_order_id]);
        await appendNegotiation(client, line.id, { type: 'supplier_cancelled', by: user.id, note, at: new Date().toISOString() });
        const updated = await recomputeChild(client, line.child_order_id, policy);
        result = { allocationId, responseStatus: 'cancelled', preservedDemandSeries: line.requested_series,
          child: { id: updated.id, supplyStatus: updated.supply_status, paymentEligibility: updated.payment_eligibility } };
      }
      await audit(client, user.id, `wholesale_supplier.${action}`, 'order_source_allocation', allocationId,
        { status: current.status, responseStatus: current.response_status }, result, request.ip);
      await outbox(client, `child_order.supplier_${action}`, 'order', line.child_order_id,
        { allocationId, lineId: line.id, ...result });
      await completeIdempotency(client, user.id, `wholesale_supplier.${action}`, key, result);
      return result;
    });
  }

  const transitionBody = z.object({ note: z.string().trim().max(400).optional() }).strict();
  for (const action of ['commit', 'ready', 'cancel'] as const) {
    app.post(`/api/v1/wholesale/supplier/supply-requests/:allocationId/${action}`, async (request) => {
      const user = await principal(request, pool, config);
      await requireApprovedActiveSupplier(pool, user);
      const { allocationId } = z.object({ allocationId: z.uuid() }).parse(request.params);
      const body = transitionBody.parse(request.body ?? {});
      return transitionSupplierAllocation(request, user, allocationId, action, body.note ?? '');
    });
  }

  /* ============================ buyer decisions (§36-§39) ============================ */

  const decisionSchema = z.object({
    action: z.enum(['accept_counter', 'remove']),
  }).strict();

  app.post('/api/v1/wholesale/lines/:lineId/decision', async (request) => {
    const user = await principal(request, pool, config);
    const { lineId } = z.object({ lineId: z.uuid() }).parse(request.params);
    const body = decisionSchema.parse(request.body);
    const policy = await omsPolicy(pool);

    return transaction(pool, async (client) => {
      const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [lineId]);
      if (!line) throw notFound();
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [line.child_order_id]);
      if (!child || child.buyer_id !== user.id) throw forbidden(); // IDOR guard
      if (child.status !== 'pending_payment') throw code(409, 'CHILD_ALREADY_PAID', 'زیرسفارش قابل تغییر نیست.');

      if (body.action === 'accept_counter') {
        if (line.status !== 'awaiting_buyer' || line.proposed_series === null) {
          throw code(409, 'COUNTER_OFFER_PENDING', 'پیشنهاد جایگزین فعالی برای این ردیف وجود ندارد.');
        }
        const proposed = line.proposed_series;
        // §37: full server revalidation at accept time.
        if (!line.offer_id) throw code(409, 'CAPACITY_RESERVATION_FAILED', 'پیشنهاد مرتبط یافت نشد.');
        const offer = await one<{
          id: string; status: string; min_order_series: number; max_order_series: number | null;
          declared_capacity: number; reserved_external: number; safety_buffer: number;
        }>(client, `SELECT id, status, min_order_series, max_order_series, declared_capacity, reserved_external, safety_buffer
                    FROM supplier_offers WHERE id = $1 FOR UPDATE`, [line.offer_id]);
        if (!offer || offer.status !== 'active') throw code(409, 'SUPPLIER_OFFER_INACTIVE', 'پیشنهاد تأمین‌کننده دیگر فعال نیست.');
        if (proposed < offer.min_order_series) {
          throw code(409, 'BELOW_MIN_ORDER_SERIES', `پیشنهاد جایگزین از حداقل سفارش (${offer.min_order_series} سری) کمتر است — فقط حذف ردیف ممکن است.`);
        }
        if (offer.max_order_series !== null && proposed > offer.max_order_series) {
          throw code(409, 'ABOVE_MAX_ORDER_SERIES', 'پیشنهاد جایگزین از سقف سفارش بیشتر است.');
        }

        const externalAllocs = await client.query<AllocationRow>(
          `SELECT * FROM order_source_allocations WHERE line_id = $1 AND source_type = 'supplier_external'
             AND status IN ('pending') FOR UPDATE`, [lineId]);
        const physicalQty = line.requested_series - externalAllocs.rows.reduce((sum, a) => sum + a.quantity, 0);
        const newExternal = proposed - physicalQty;
        if (newExternal < 0) throw badRequest('پیشنهاد جایگزین با سهم فیزیکی رزروشده سازگار نیست.');

        // resize external allocation to the proposed remainder + atomic capacity reserve.
        for (const alloc of externalAllocs.rows) {
          if (newExternal === 0) {
            await client.query("UPDATE order_source_allocations SET status = 'cancelled', updated_at = now() WHERE id = $1", [alloc.id]);
            continue;
          }
          let reservationId: string;
          try {
            const reserved = await reserveSupplierCapacity(client, {
              offerId: offer.id, quantity: newExternal, ttlMinutes: null,
              referenceType: 'order_source_allocation', referenceId: alloc.id,
              note: `پذیرش پیشنهاد جایگزین ${child.reference}`, actorId: user.id,
              idempotencyKey: `oms-capacity-accept:${alloc.id}`,
            });
            reservationId = reserved.reservationId;
          } catch {
            throw code(409, 'CAPACITY_RESERVATION_FAILED', 'ظرفیت اعلامی تأمین‌کننده دیگر کافی نیست.');
          }
          await client.query(
            `UPDATE order_source_allocations SET quantity = $2, status = 'reserved', capacity_reservation_id = $3,
               reservation_expires_at = NULL, reserved_at = now(), updated_at = now() WHERE id = $1`,
            [alloc.id, newExternal, reservationId]);
        }

        // shrink piece lines from requested → proposed (pre-payment commercial resize).
        const perPiece = (line.commercial_snapshot?.perPiece ?? []) as Array<{ variantId: string; qps: number }>;
        for (const piece of perPiece) {
          await client.query(
            `UPDATE order_lines SET quantity = $3::int,
               discount_amount_rial = (discount_amount_rial / NULLIF(quantity, 0)) * $3::bigint,
               line_total_rial = unit_price_rial * $3::bigint
             WHERE order_id = $1 AND variant_id = $2`,
            [line.child_order_id, piece.variantId, piece.qps * proposed]);
        }
        await client.query(
          `UPDATE child_order_lines SET status = 'confirmed', confirmed_series = $2::int,
             line_total_rial = unit_series_price_rial * $2::bigint, supplier_response_status = 'accepted',
             supplier_responded_at = now(), supplier_committed_series = 0, supplier_committed_at = NULL,
             supplier_ready_at = NULL, decided_at = now(), updated_at = now() WHERE id = $1`,
          [lineId, proposed]);
        await appendNegotiation(client, lineId, { type: 'buyer_accepted_counter', series: proposed, by: user.id });
        await recomputeChildTotals(client, line.child_order_id);
      } else {
        // remove line (buyer walks away from this row; siblings unaffected §40).
        if (!['awaiting_buyer', 'awaiting_supplier', 'timed_out', 'stock_reserved', 'confirmed'].includes(line.status)) {
          throw conflict('این ردیف در وضعیت قابل حذف نیست.');
        }
        await releaseLineHolds(client, line, user.id, 'حذف ردیف توسط خریدار');
        await removeLinePieces(client, line, user.id);
        await client.query(
          `UPDATE child_order_lines SET status = 'removed', decided_at = now(), updated_at = now() WHERE id = $1`, [lineId]);
        await appendNegotiation(client, lineId, { type: 'buyer_removed', by: user.id });
        await recomputeChildTotals(client, line.child_order_id);
      }

      const updated = await recomputeChild(client, line.child_order_id, policy);
      if (updated.supply_status === 'rejected') {
        await client.query(
          `UPDATE orders SET status = 'cancelled', composition_state = 'removed', updated_at = now() WHERE id = $1`,
          [line.child_order_id]);
        await client.query(
          `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
           VALUES ($1,$2,'pending_payment','cancelled',$3,'حذف همه ردیف‌ها — زیرسفارش لغو شد')`,
          [randomUUID(), line.child_order_id, user.id]);
      }
      await audit(client, user.id, `wholesale_line.buyer_${body.action}`, 'child_order_line', lineId, undefined,
        { childOrderId: line.child_order_id }, request.ip);
      return { ok: true, child: { id: updated.id, supplyStatus: updated.supply_status, paymentEligibility: updated.payment_eligibility } };
    });
  });

  /** Buyer removes a whole unpaid child from the master (§39/§44). */
  app.post('/api/v1/wholesale/children/:id/remove', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const policy = await omsPolicy(pool);
    return transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || !child.master_order_id) throw notFound();
      if (child.buyer_id !== user.id) throw forbidden();
      const master = await one<{ composition: string }>(client,
        'SELECT composition FROM master_orders WHERE id = $1 FOR UPDATE', [child.master_order_id]);
      if (master?.composition !== 'open') throw code(409, 'MASTER_COMPOSITION_OPEN', 'ترکیب سفارش مادر قفل شده است — حذف زیرسفارش ممکن نیست.');
      // §44/§179: paid children require the cancel/refund workflow — not a silent remove.
      if (child.payment_eligibility === 'paid' || child.status !== 'pending_payment') {
        throw code(409, 'CHILD_ALREADY_PAID', 'زیرسفارش پرداخت‌شده فقط از مسیر لغو/استرداد خارج می‌شود.');
      }
      const lines = await client.query<LineRow>(
        `SELECT * FROM child_order_lines WHERE child_order_id = $1 AND status NOT IN ('removed','rejected') FOR UPDATE`, [id]);
      for (const line of lines.rows) {
        await releaseLineHolds(client, line, user.id, 'حذف زیرسفارش توسط خریدار');
        await removeLinePieces(client, line, user.id);
        await client.query("UPDATE child_order_lines SET status = 'removed', decided_at = now(), updated_at = now() WHERE id = $1", [line.id]);
      }
      await client.query(
        `UPDATE orders SET status = 'cancelled', composition_state = 'removed', supply_status = 'rejected',
           payment_eligibility = 'not_ready', updated_at = now() WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
         VALUES ($1,$2,'pending_payment','cancelled',$3,'حذف زیرسفارش توسط خریدار')`, [randomUUID(), id, user.id]);
      await audit(client, user.id, 'wholesale_child.removed', 'order', id, undefined, { masterOrderId: child.master_order_id }, request.ip);
      await outbox(client, 'child_order.cancelled', 'order', id, { childOrderId: id, masterOrderId: child.master_order_id, reason: 'buyer_removed' });
      void policy;
      return { ok: true };
    });
  });

  /** §41-§42: lock master composition (prerequisite of consolidation; children stay payable before lock §114). */
  app.post('/api/v1/wholesale/masters/:id/lock', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const master = await one<{ id: string; buyer_id: string; composition: string; shipping_method_id: string | null; shipping_address: { province?: string; city?: string } }>(client,
        'SELECT id, buyer_id, composition, shipping_method_id, shipping_address FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (master.buyer_id !== user.id && !isOps(user)) throw forbidden();
      if (master.composition !== 'open') throw conflict('ترکیب سفارش مادر قبلاً قفل شده است.');
      const blocked = await one<{ count: string }>(client,
        `SELECT count(*)::text AS count FROM orders
         WHERE master_order_id = $1 AND composition_state = 'included'
           AND supply_status IN ('unresolved', 'awaiting_supplier', 'partially_confirmed', 'awaiting_buyer', 'timed_out', 'exception')`, [id]);
      if (Number(blocked?.count ?? 0) > 0) {
        throw code(409, 'SUPPLIER_CONFIRMATION_REQUIRED', 'هنوز زیرسفارش‌هایی با تأمین نامشخص وجود دارد — ابتدا تعیین تکلیف کنید.');
      }
      const included = await one<{ count: string }>(client,
        `SELECT count(*)::text AS count FROM orders WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'`, [id]);
      if (Number(included?.count ?? 0) === 0) throw conflict('هیچ زیرسفارش فعالی برای قفل ترکیب وجود ندارد.');

      // §112: shipping snapshot at lock.
      let quoteSnapshot: Record<string, unknown> | null = null;
      if (master.shipping_method_id) {
        const pieceAgg = await client.query<{ variant_id: string; quantity: number }>(
          `SELECT l.variant_id, SUM(l.quantity)::int AS quantity FROM order_lines l
           JOIN orders o ON o.id = l.order_id
           WHERE o.master_order_id = $1 AND o.composition_state = 'included' AND o.status <> 'cancelled'
           GROUP BY l.variant_id`, [id]);
        const subtotal = await one<{ total: string }>(client,
          `SELECT COALESCE(SUM(total_rial), 0)::text AS total FROM orders
           WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'`, [id]);
        const quote = await quoteShipping(client, master.shipping_method_id, {
          items: pieceAgg.rows.map((p) => ({ variantId: p.variant_id, quantity: p.quantity })),
          subtotalRial: rial(subtotal?.total ?? '0'),
          province: master.shipping_address?.province ?? '', city: master.shipping_address?.city ?? '',
        });
        quoteSnapshot = {
          methodId: master.shipping_method_id, feeRial: quote.feeRial.toString(),
          ruleId: quote.ruleId, pricingType: quote.pricingType,
          totalWeightGrams: quote.totalWeightGrams, snappedAt: new Date().toISOString(),
        };
      }
      await client.query(
        `UPDATE master_orders SET composition = 'locked', locked_at = now(), locked_by = $2,
           shipping_quote_snapshot = $3, shipping_estimate_rial = COALESCE($4, shipping_estimate_rial), updated_at = now()
         WHERE id = $1`,
        [id, user.id, quoteSnapshot ? JSON.stringify(quoteSnapshot) : null,
          quoteSnapshot ? String(quoteSnapshot.feeRial) : null]);
      await audit(client, user.id, 'wholesale_master.locked', 'master_order', id, undefined, { quote: quoteSnapshot }, request.ip);
      await outbox(client, 'wholesale_master.locked', 'master_order', id, { masterOrderId: id });
      return { ok: true, composition: 'locked', shippingQuote: quoteSnapshot };
    });
  });

  /* ============================ payment intents (§46-§60, §139) ============================ */

  /** Shared guard: the HARD payment gate. Throws machine codes; never bypassable, not even for admin (§139). */
  async function assertChildPayable(client: DbClient, child: ChildRow | null, buyerId: string): Promise<ChildRow> {
    if (!child || !child.master_order_id) throw notFound();
    if (child.buyer_id !== buyerId) throw forbidden();
    if (child.status !== 'pending_payment' || child.payment_eligibility === 'paid') {
      throw code(409, 'CHILD_ALREADY_PAID', 'این زیرسفارش قبلاً پرداخت شده یا بسته است.');
    }
    if (child.payment_eligibility === 'expired') {
      throw code(409, 'SUPPLY_RESERVATION_EXPIRED', 'مهلت پرداخت این زیرسفارش منقضی و رزروها آزاد شده است.');
    }
    if (child.payment_eligibility !== 'ready') {
      const reason = child.payment_eligibility === 'blocked_buyer_decision'
        ? code(409, 'COUNTER_OFFER_PENDING', 'پیشنهاد جایگزین تأمین‌کننده در انتظار تصمیم شماست.')
        : code(409, child.payment_eligibility === 'blocked_exception' ? 'FULFILLMENT_EXCEPTION_OPEN' : 'PAYMENT_NOT_READY',
          'پرداخت این زیرسفارش هنوز آماده نیست — تأمین همه اقلام باید قطعی شود.');
      throw reason;
    }
    if (child.payment_due_at && new Date(child.payment_due_at) <= new Date()) {
      await expireChild(client, child, buyerId);
      throw code(409, 'SUPPLY_RESERVATION_EXPIRED', 'مهلت پرداخت این زیرسفارش منقضی شد و رزروها آزاد شدند.');
    }
    return child;
  }

  async function createOmsIntent(client: DbClient, input: {
    masterOrderId: string; purpose: 'child_order' | 'child_batch';
    children: Array<{ id: string; amount: bigint }>;
  }): Promise<{ intentId: string; reference: string; amountRial: string }> {
    // §143: one active intent per child — the partial unique index is the authority.
    const existing = await client.query<{ child_order_id: string }>(
      `SELECT child_order_id FROM payment_allocations
       WHERE child_order_id = ANY($1::uuid[]) AND status = 'pending'`,
      [input.children.map((c) => c.id)]);
    if (existing.rows.length) {
      throw code(409, 'PAYMENT_INTENT_EXISTS', 'برای یک یا چند زیرسفارش درخواست پرداخت فعالی وجود دارد.');
    }
    const total = input.children.reduce((sum, child) => sum + child.amount, 0n);
    if (total <= 0n) throw badRequest('مبلغ پرداخت معتبر نیست.');
    const intentId = randomUUID();
    const seq = await one<{ n: string }>(client, "SELECT nextval('order_reference_seq')::text AS n");
    await client.query(
      `INSERT INTO payment_intents(id, reference, provider, amount_rial, status, master_order_id, purpose)
       VALUES ($1,$2,'nextpay',$3,'pending',$4,$5)`,
      [intentId, `PAY-${seq!.n}`, total.toString(), input.masterOrderId, input.purpose]);
    // §59: allocations MUST sum exactly to the intent amount — enforced by construction here,
    // re-verified at webhook time by amount equality in applyVerifiedPayment.
    for (const child of input.children) {
      await client.query(
        `INSERT INTO payment_allocations(id, payment_intent_id, child_order_id, amount_rial, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [randomUUID(), intentId, child.id, child.amount.toString()]);
    }
    return { intentId, reference: `PAY-${seq!.n}`, amountRial: total.toString() };
  }

  /** Individual child payment intent — READY children only (§54). */
  app.post('/api/v1/wholesale/children/:id/payment-intent', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      const payable = await assertChildPayable(client, child, user.id);
      const intent = await createOmsIntent(client, {
        masterOrderId: payable.master_order_id!, purpose: 'child_order',
        children: [{ id: payable.id, amount: rial(payable.total_rial) }],
      });
      await audit(client, user.id, 'wholesale_child.payment_intent', 'order', id, undefined,
        { intentId: intent.intentId, amountRial: intent.amountRial }, request.ip);
      return { ...intent, children: [{ id: payable.id, reference: payable.reference, amountRial: payable.total_rial }] };
    });
    return reply.code(201).send(result);
  });

  /** Batch payment: ONE gateway transaction across several READY children of one master (§57-§58). */
  app.post('/api/v1/wholesale/masters/:id/batch-payment-intent', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      childIds: z.array(z.uuid()).min(1).max(40)
        .refine((ids) => new Set(ids).size === ids.length, 'هر زیرسفارش فقط یک بار مجاز است.'),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const master = await one<{ id: string; buyer_id: string }>(client,
        'SELECT id, buyer_id FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (master.buyer_id !== user.id) throw forbidden();
      const children: Array<{ id: string; amount: bigint; reference: string; total: string }> = [];
      for (const childId of body.childIds) {
        const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [childId]);
        if (!child || child.master_order_id !== id) throw notFound();  // same master, same buyer, same currency/method
        const payable = await assertChildPayable(client, child, user.id);
        children.push({ id: payable.id, amount: rial(payable.total_rial), reference: payable.reference, total: payable.total_rial });
      }
      const intent = await createOmsIntent(client, { masterOrderId: id, purpose: 'child_batch', children });
      await audit(client, user.id, 'wholesale_master.batch_payment_intent', 'master_order', id, undefined,
        { intentId: intent.intentId, childIds: body.childIds, amountRial: intent.amountRial }, request.ip);
      return { ...intent, children: children.map((c) => ({ id: c.id, reference: c.reference, amountRial: c.total })) };
    });
    return reply.code(201).send(result);
  });

  /* ============================ fulfillment (§77-§91) ============================ */

  /** A paid child is ready for consolidation when no allocation is still pending/reserved and no exception is open. */
  async function refreshChildFulfillment(client: DbClient, childOrderId: string): Promise<string> {
    const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [childOrderId]);
    if (!child) throw notFound();
    const pending = await one<{ count: string }>(client,
      `SELECT count(*)::text AS count FROM order_source_allocations
       WHERE child_order_id = $1 AND status IN ('pending','reserved')`, [childOrderId]);
    const openExceptions = await one<{ count: string }>(client,
      `SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'`, [childOrderId]);
    let state = child.child_fulfillment ?? 'not_started';
    if (Number(openExceptions?.count ?? 0) > 0) state = 'exception';
    else if (child.payment_eligibility === 'paid' && Number(pending?.count ?? 0) === 0
      && !['consolidated', 'delivered'].includes(state)) {
      state = 'ready_for_consolidation';
      // settlement-grade accepted quantity (§91): physical + QC-passed external, minus resolved shortfalls.
      await client.query(
        `UPDATE child_order_lines l SET accepted_series = COALESCE((
             SELECT SUM(CASE WHEN a.source_type = 'supplier_external' THEN a.qc_passed_series ELSE a.quantity END)::int
             FROM order_source_allocations a
             WHERE a.line_id = l.id AND a.status IN ('consumed')
           ), 0), updated_at = now()
         WHERE l.child_order_id = $1 AND l.status NOT IN ('removed','rejected') AND l.accepted_series IS NULL`,
        [childOrderId]);
    }
    if (state !== child.child_fulfillment) {
      await client.query('UPDATE orders SET child_fulfillment = $2, updated_at = now() WHERE id = $1', [childOrderId, state]);
      if (state === 'ready_for_consolidation') {
        await client.query("UPDATE orders SET wholesale_fulfillment_status = 'awaiting_consolidation' WHERE id = $1", [childOrderId]);
        await outbox(client, 'child_order.ready_for_consolidation', 'order', childOrderId,
          { childOrderId, masterOrderId: child.master_order_id });
      }
    }
    return state;
  }

  async function openException(client: DbClient, input: {
    masterOrderId: string | null; childOrderId: string; lineId?: string | null; allocationId?: string | null;
    type: string; quantity?: number | null; note: string; actorId: string;
  }): Promise<string> {
    const exceptionId = randomUUID();
    await client.query(
      `INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, line_id, allocation_id, exception_type, quantity, status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9)`,
      [exceptionId, input.masterOrderId, input.childOrderId, input.lineId ?? null, input.allocationId ?? null,
        input.type, input.quantity ?? null, input.note, input.actorId]);
    await outbox(client, 'child_order.exception_opened', 'order', input.childOrderId,
      { childOrderId: input.childOrderId, exceptionId, exceptionType: input.type, quantity: input.quantity ?? null });
    return exceptionId;
  }

  /** Warehouse pick for PHYSICAL sources — kolbe stock & supplier stock-at-kolbe: pick → ready, no dispatch/QC (§77-§78). */
  app.post('/api/v1/wholesale/children/:id/pick', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || !child.master_order_id) throw notFound();
      if (child.payment_eligibility !== 'paid') throw code(409, 'PAYMENT_NOT_READY', 'زیرسفارش هنوز پرداخت نشده است — برداشت مجاز نیست.');
      const allocations = await client.query<AllocationRow>(
        `SELECT * FROM order_source_allocations
         WHERE child_order_id = $1 AND source_type IN ('kolbe_stock','supplier_stock_at_kolbe') AND status = 'reserved'
         ORDER BY created_at FOR UPDATE`, [id]);
      if (!allocations.rows.length) throw conflict('تخصیص فیزیکی فعالی برای برداشت وجود ندارد.');
      for (const alloc of allocations.rows) {
        const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [alloc.line_id]);
        if (!line) continue;
        // consume the series banding (goods leave sellable wholesale storage into consolidation staging).
        const reservation = await one<{ id: string; series_count: number }>(client,
          `SELECT id, series_count FROM order_series_reservations
           WHERE order_id = $1 AND series_template_id = $2 AND status = 'active' FOR UPDATE`,
          [id, line.series_template_id]);
        if (reservation && alloc.warehouse_id) {
          await applySeriesMovement(client, {
            templateId: line.series_template_id, warehouseId: alloc.warehouse_id,
            owner: { ownerType: alloc.source_type === 'kolbe_stock' ? 'kolbe' : 'supplier', supplierId: alloc.owner_supplier_id },
            movementType: 'consume', onHandDelta: -alloc.quantity, reservedDelta: -alloc.quantity,
            referenceType: 'order', referenceId: id, actorId: user.id,
            note: 'برداشت برای تجمیع سفارش مادر', idempotencyKey: `oms-pick:${alloc.id}`,
          });
          await client.query("UPDATE order_series_reservations SET status = 'consumed', updated_at = now() WHERE id = $1", [reservation.id]);
        }
        // consume the piece-level reservations of this line's physical portion.
        const perPiece = ((line.commercial_snapshot?.perPiece ?? []) as Array<{ variantId: string }>).map((p) => p.variantId);
        if (perPiece.length) {
          const reservations = await client.query<{ id: string; variant_id: string; warehouse_id: string; quantity: number; inventory_domain: string }>(
            `SELECT r.id, r.variant_id, r.warehouse_id, r.quantity, r.inventory_domain
             FROM stock_reservations r JOIN order_lines l ON l.id = r.order_line_id
             WHERE l.order_id = $1 AND l.variant_id = ANY($2::uuid[]) AND r.status = 'active' FOR UPDATE OF r`,
            [id, perPiece]);
          for (const res of reservations.rows) {
            await client.query(
              `UPDATE stock_balances SET on_hand = on_hand - $4, reserved = GREATEST(0, reserved - $4), version = version + 1, updated_at = now()
               WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
              [res.variant_id, res.warehouse_id, res.inventory_domain, res.quantity]);
            await client.query("UPDATE stock_reservations SET status = 'consumed' WHERE id = $1", [res.id]);
            await client.query(
              `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reserved_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
               VALUES ($1,$2,$3,$4,$5,$6,'picked for consolidation','order',$7,$8,$9)`,
              [randomUUID(), res.variant_id, res.warehouse_id, res.inventory_domain, -res.quantity, -res.quantity, id, user.id, `oms-pick-piece:${res.id}`]);
          }
        }
        await client.query("UPDATE order_source_allocations SET status = 'consumed', updated_at = now() WHERE id = $1", [alloc.id]);
      }
      const state = await refreshChildFulfillment(client, id);
      await audit(client, user.id, 'wholesale_child.picked', 'order', id, undefined,
        { allocations: allocations.rows.map((a) => a.id) }, request.ip);
      return { ok: true, childFulfillment: state };
    });
  });

  /** Supplier dispatch of ORDER-BOUND external goods → ALWAYS to Kolbe, never the VIP buyer. */
  app.post('/api/v1/wholesale/supplier/children/:id/dispatch', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    // Destination is server-resolved; the body cannot name a buyer or warehouse.
    const body = z.object({ trackingNote: z.string().trim().max(400).optional() }).strict().parse(request.body ?? {});
    const idemPayload = { childOrderId: id, trackingNote: body.trackingNote ?? null };
    const key = idempotencyFor(request, id, idemPayload);
    return transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale_supplier.dispatch', key, requestHash(idemPayload));
      if (claim.previous) return claim.previous;
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || child.seller_id !== user.id) throw notFound();
      if (child.payment_eligibility !== 'paid') throw code(409, 'PAYMENT_NOT_READY', 'زیرسفارش هنوز پرداخت نشده است — ارسال مجاز نیست.');
      const destination = await centralWholesaleWarehouse(client);
      const allocations = await client.query<AllocationRow & { supplier_response_status: string; supplier_committed_series: number }>(
        `SELECT a.*, l.supplier_response_status, l.supplier_committed_series
         FROM order_source_allocations a JOIN child_order_lines l ON l.id = a.line_id
         WHERE a.child_order_id = $1 AND a.owner_supplier_id = $2 AND l.seller_id = $2
           AND a.source_type = 'supplier_external' AND a.status = 'reserved' AND a.dispatched_series = 0
           AND l.supplier_response_status = 'ready'
         ORDER BY a.created_at FOR UPDATE OF a,l`, [id, user.id]);
      if (!allocations.rows.length) throw conflict('تخصیص خارجی تعهدشده و آماده ارسال وجود ندارد.');
      for (const allocation of allocations.rows) {
        await client.query(
          `UPDATE order_source_allocations SET dispatched_series = quantity, warehouse_id = $2, updated_at = now() WHERE id = $1`,
          [allocation.id, destination]);
        await client.query(
          `UPDATE child_order_lines SET dispatched_series = dispatched_series + $2,
             supplier_response_status = 'ready', supplier_committed_series = GREATEST(supplier_committed_series,$2),
             supplier_committed_at = COALESCE(supplier_committed_at,now()),
             supplier_ready_at = COALESCE(supplier_ready_at,now()), updated_at = now() WHERE id = $1`,
          [allocation.line_id, allocation.quantity]);
        if (allocation.supplier_response_status !== 'ready') {
          await appendNegotiation(client, allocation.line_id, { type: 'supplier_dispatch_implied_ready',
            series: allocation.quantity, by: user.id, at: new Date().toISOString() });
        }
        // Capacity becomes consumed at actual dispatch; this does not increase physical WMS stock.
        if (allocation.capacity_reservation_id) {
          await settleSupplierCapacityReservation(client, allocation.capacity_reservation_id, 'consumed');
        }
      }
      await client.query(
        `UPDATE orders SET child_fulfillment = 'dispatched', wholesale_fulfillment_status = 'supplier_dispatched', updated_at = now() WHERE id = $1`, [id]);
      await client.query(
        `INSERT INTO order_events(id, order_id, to_status, actor_id, note) VALUES ($1,$2,'paid',$3,$4)`,
        [randomUUID(), id, user.id, `تأمین‌کننده کالا را به انبار مرکزی کلبه ارسال کرد${body.trackingNote ? ` — ${body.trackingNote}` : ''}`]);
      await audit(client, user.id, 'wholesale_child.supplier_dispatched', 'order', id, undefined,
        { destinationWarehouseId: destination, allocations: allocations.rows.map((a) => a.id) }, request.ip);
      await outbox(client, 'child_order.supplier_dispatched', 'order', id,
        { childOrderId: id, masterOrderId: child.master_order_id, destinationWarehouseId: destination });
      const result = { ok: true, destinationWarehouseId: destination, childFulfillment: 'dispatched' };
      await completeIdempotency(client, user.id, 'wholesale_supplier.dispatch', key, result);
      return result;
    });
  });

  /** Warehouse receive of order-bound inbound (§84): received is tracked apart from dispatched. */
  app.post('/api/v1/wholesale/children/:id/receive', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      allocations: z.array(z.object({
        allocationId: z.uuid(), receivedSeries: z.number().int().min(0),
      }).strict()).min(1).max(50),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || !child.master_order_id) throw notFound();
      for (const entry of body.allocations) {
        const alloc = await one<AllocationRow>(client,
          `SELECT * FROM order_source_allocations WHERE id = $1 AND child_order_id = $2 FOR UPDATE`,
          [entry.allocationId, id]);
        if (!alloc || alloc.source_type !== 'supplier_external') throw notFound();
        if (alloc.dispatched_series <= 0) throw conflict('این تخصیص هنوز توسط تأمین‌کننده ارسال نشده است.');
        if (alloc.received_series > 0) throw conflict('رسید این تخصیص قبلاً ثبت شده است.');
        if (entry.receivedSeries > alloc.dispatched_series) throw badRequest('تعداد رسید از تعداد ارسالی بیشتر است.');
        await client.query(
          `UPDATE order_source_allocations SET received_series = $2, updated_at = now() WHERE id = $1`,
          [alloc.id, entry.receivedSeries]);
        await client.query(
          `UPDATE child_order_lines SET received_series = received_series + $2, updated_at = now() WHERE id = $1`,
          [alloc.line_id, entry.receivedSeries]);
        if (entry.receivedSeries < alloc.dispatched_series) {
          await openException(client, {
            masterOrderId: child.master_order_id, childOrderId: id, lineId: alloc.line_id, allocationId: alloc.id,
            type: 'lost_inbound', quantity: alloc.dispatched_series - entry.receivedSeries,
            note: 'کسری در رسید انبار نسبت به تعداد ارسالی تأمین‌کننده', actorId: user.id,
          });
        }
      }
      await client.query(
        `UPDATE orders SET child_fulfillment = 'qc_pending', wholesale_fulfillment_status = 'received_at_kolbe', updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'wholesale_child.received', 'order', id, undefined, body, request.ip);
      await outbox(client, 'child_order.received_at_kolbe', 'order', id, { childOrderId: id });
      return { ok: true, childFulfillment: 'qc_pending' };
    });
  });

  /**
   * QC of order-bound inbound (§85-§87): passed goods stay ORDER-BOUND — they are NEVER
   * credited to general supplier stock-at-kolbe (no series_stock_balances / stock_balances write).
   * Sellers can never QC their own goods (§135).
   */
  app.post('/api/v1/wholesale/children/:id/qc', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      allocations: z.array(z.object({
        allocationId: z.uuid(), passedSeries: z.number().int().min(0), rejectedSeries: z.number().int().min(0),
      }).strict()).min(1).max(50),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || !child.master_order_id) throw notFound();
      if (child.seller_id === user.id) throw forbidden(); // §135: no self-QC
      let anyRejected = false;
      for (const entry of body.allocations) {
        const alloc = await one<AllocationRow>(client,
          `SELECT * FROM order_source_allocations WHERE id = $1 AND child_order_id = $2 FOR UPDATE`,
          [entry.allocationId, id]);
        if (!alloc || alloc.source_type !== 'supplier_external') throw notFound();
        if (alloc.received_series <= 0) throw conflict('رسید انبار برای این تخصیص ثبت نشده است.');
        if (alloc.qc_passed_series + alloc.qc_rejected_series > 0) throw conflict('کنترل کیفیت این تخصیص قبلاً ثبت شده است.');
        if (entry.passedSeries + entry.rejectedSeries !== alloc.received_series) {
          throw badRequest('جمع قبول و رد باید دقیقاً برابر تعداد رسیدشده باشد.');
        }
        await client.query(
          `UPDATE order_source_allocations SET qc_passed_series = $2, qc_rejected_series = $3,
             status = CASE WHEN $2 = quantity THEN 'consumed' ELSE status END, updated_at = now() WHERE id = $1`,
          [alloc.id, entry.passedSeries, entry.rejectedSeries]);
        await client.query(
          `UPDATE child_order_lines SET qc_passed_series = qc_passed_series + $2, qc_rejected_series = qc_rejected_series + $3, updated_at = now()
           WHERE id = $1`, [alloc.line_id, entry.passedSeries, entry.rejectedSeries]);
        if (entry.rejectedSeries > 0) {
          anyRejected = true;
          await openException(client, {
            masterOrderId: child.master_order_id, childOrderId: id, lineId: alloc.line_id, allocationId: alloc.id,
            type: 'qc_rejected', quantity: entry.rejectedSeries,
            note: 'رد کنترل کیفیت کالای سفارش‌محور — کالا به موجودی عمومی اضافه نمی‌شود', actorId: user.id,
          });
        }
        if (entry.passedSeries < alloc.quantity && entry.rejectedSeries === 0 && alloc.received_series >= alloc.dispatched_series) {
          // short confirmation shrinkage without rejection → explicit shortage exception, never silent (§88).
          await openException(client, {
            masterOrderId: child.master_order_id, childOrderId: id, lineId: alloc.line_id, allocationId: alloc.id,
            type: 'shortage', quantity: alloc.quantity - entry.passedSeries,
            note: 'کسری نسبت به تعداد تأییدشده پس از کنترل کیفیت', actorId: user.id,
          });
        }
      }
      await client.query(
        `UPDATE orders SET wholesale_fulfillment_status = $2, updated_at = now() WHERE id = $1`,
        [id, anyRejected ? 'qc_issue' : 'qc_passed']);
      const state = await refreshChildFulfillment(client, id);
      await audit(client, user.id, 'wholesale_child.qc', 'order', id, undefined, body, request.ip);
      await outbox(client, 'child_order.qc_recorded', 'order', id, { childOrderId: id, state });
      return { ok: true, childFulfillment: state };
    });
  });

  /** Ops resolution of a fulfillment exception (§89-§90): refs only — money moves in Prompt 3. */
  app.post('/api/v1/wholesale/exceptions/:id/resolve', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      resolution: z.enum(['accept_short', 'refund_pending', 'supplier_redelivery', 'written_off']),
      note: z.string().max(500).optional(),
    }).strict().parse(request.body);
    const policy = await omsPolicy(pool);
    return transaction(pool, async (client) => {
      const exception = await one<{
        id: string; master_order_id: string | null; child_order_id: string; line_id: string | null;
        allocation_id: string | null; exception_type: string; quantity: number | null; status: string;
      }>(client, 'SELECT * FROM fulfillment_exceptions WHERE id = $1 FOR UPDATE', [id]);
      if (!exception) throw notFound();
      if (exception.status !== 'open') throw conflict('این استثنا قبلاً تعیین تکلیف شده است.');
      const resolutionReference = {
        resolvedBy: user.id, resolution: body.resolution, note: body.note ?? '',
        financeFollowUp: body.resolution === 'refund_pending' ? 'prompt3_refund' : null,
      };
      await client.query(
        `UPDATE fulfillment_exceptions SET status = 'resolved', resolution = $2, resolution_reference = $3,
           resolved_by = $4, resolved_at = now(), updated_at = now() WHERE id = $1`,
        [id, body.resolution, JSON.stringify(resolutionReference), user.id]);
      if (exception.allocation_id && (body.resolution === 'accept_short' || body.resolution === 'refund_pending' || body.resolution === 'written_off')) {
        // close the allocation at its QC-passed quantity; accepted shortfall is explicit, never silent.
        await client.query(
          `UPDATE order_source_allocations SET status = 'consumed', updated_at = now()
           WHERE id = $1 AND status NOT IN ('consumed','released','cancelled')`, [exception.allocation_id]);
        if (exception.line_id) {
          await client.query('UPDATE child_order_lines SET accepted_series = NULL, updated_at = now() WHERE id = $1', [exception.line_id]);
        }
      }
      if (body.resolution === 'supplier_redelivery' && exception.allocation_id) {
        // re-open the inbound leg: supplier dispatches again for the missing quantity.
        await client.query(
          `UPDATE order_source_allocations SET dispatched_series = 0, received_series = 0,
             qc_passed_series = 0, qc_rejected_series = 0, updated_at = now() WHERE id = $1 AND status = 'reserved'`,
          [exception.allocation_id]);
      }
      if (body.resolution === 'refund_pending') {
        await outbox(client, 'child_order.refund_requested', 'order', exception.child_order_id, {
          childOrderId: exception.child_order_id, masterOrderId: exception.master_order_id,
          exceptionId: id, exceptionType: exception.exception_type, quantity: exception.quantity, reason: 'fulfillment_exception',
        });
      }
      const state = await refreshChildFulfillment(client, exception.child_order_id);
      void policy;
      await audit(client, user.id, 'wholesale_exception.resolved', 'fulfillment_exception', id, undefined,
        { resolution: body.resolution }, request.ip);
      return { ok: true, childFulfillment: state };
    });
  });

  /* ============================ consolidation (§93-§102) ============================ */

  app.post('/api/v1/wholesale/masters/:id/consolidation/start', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await transaction(pool, async (client) => {
      const master = await one<{ id: string; reference: string; composition: string }>(client,
        'SELECT id, reference, composition FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (master.composition !== 'locked') throw code(409, 'MASTER_COMPOSITION_OPEN', 'ابتدا ترکیب سفارش مادر باید قفل شود.');
      // §95: denominator = included, non-cancelled children; ALL must be paid + ready (§43 excludes removed/rejected).
      const children = await client.query<ChildRow>(
        `SELECT * FROM orders WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'
         ORDER BY created_at FOR UPDATE`, [id]);
      if (!children.rows.length) throw conflict('زیرسفارش فعالی برای تجمیع وجود ندارد.');
      const notReady = children.rows.filter((c) => c.payment_eligibility !== 'paid' || c.child_fulfillment !== 'ready_for_consolidation');
      if (notReady.length) {
        throw code(409, 'CONSOLIDATION_NOT_READY',
          `زیرسفارش‌های ${notReady.map((c) => c.reference).join('، ')} هنوز آماده تجمیع نیستند.`);
      }
      // §146: double-start is impossible — UNIQUE(master_order_id).
      const existing = await one<{ id: string }>(client, 'SELECT id FROM master_consolidations WHERE master_order_id = $1', [id]);
      if (existing) throw conflict('تجمیع این سفارش مادر قبلاً آغاز شده است.');
      const consolidationId = randomUUID();
      const seq = await one<{ n: string }>(client, "SELECT nextval('consolidation_seq')::text AS n");
      const reference = `CON-${seq!.n}`;
      await client.query(
        `INSERT INTO master_consolidations(id, master_order_id, reference, status, expected_children, started_by)
         VALUES ($1,$2,$3,'started',$4,$5)`, [consolidationId, id, reference, children.rows.length, user.id]);
      const lines = await client.query<LineRow>(
        `SELECT l.* FROM child_order_lines l JOIN orders o ON o.id = l.child_order_id
         WHERE l.master_order_id = $1 AND o.composition_state = 'included' AND o.status <> 'cancelled'
           AND l.status NOT IN ('removed','rejected')`, [id]);
      for (const line of lines.rows) {
        await client.query(
          `INSERT INTO consolidation_items(id, consolidation_id, child_order_id, line_id, series_template_id, expected_series)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), consolidationId, line.child_order_id, line.id, line.series_template_id,
            line.accepted_series ?? line.confirmed_series ?? line.requested_series]);
      }
      await audit(client, user.id, 'wholesale_consolidation.started', 'master_consolidation', consolidationId, undefined,
        { masterOrderId: id, reference, children: children.rows.length }, request.ip);
      await outbox(client, 'wholesale_master.consolidation_started', 'master_order', id, { masterOrderId: id, consolidationId, reference });
      return { id: consolidationId, reference, status: 'started', expectedChildren: children.rows.length, items: lines.rows.length };
    });
    return reply.code(201).send(result);
  });

  /** §97: item verification — wrong/duplicate scans are rejected with machine codes. */
  app.post('/api/v1/wholesale/consolidations/:id/verify-item', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ lineId: z.uuid() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const consolidation = await one<{ id: string; status: string }>(client,
        'SELECT id, status FROM master_consolidations WHERE id = $1 FOR UPDATE', [id]);
      if (!consolidation) throw notFound();
      if (consolidation.status !== 'started') throw conflict('تجمیع در وضعیت اسکن اقلام نیست.');
      const item = await one<{ id: string; verified_at: Date | null; expected_series: number }>(client,
        'SELECT id, verified_at, expected_series FROM consolidation_items WHERE consolidation_id = $1 AND line_id = $2 FOR UPDATE',
        [id, body.lineId]);
      if (!item) throw code(409, 'WRONG_CONSOLIDATION_ITEM', 'این قلم متعلق به این تجمیع نیست.');
      if (item.verified_at) throw code(409, 'DUPLICATE_CONSOLIDATION_SCAN', 'این قلم قبلاً تأیید شده است.');
      await client.query(
        `UPDATE consolidation_items SET verified_series = expected_series, verified_by = $2, verified_at = now() WHERE id = $1`,
        [item.id, user.id]);
      const remaining = await one<{ count: string }>(client,
        'SELECT count(*)::text AS count FROM consolidation_items WHERE consolidation_id = $1 AND verified_at IS NULL', [id]);
      return { ok: true, remainingItems: Number(remaining?.count ?? 0) };
    });
  });

  app.post('/api/v1/wholesale/consolidations/:id/complete', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const consolidation = await one<{ id: string; status: string; master_order_id: string }>(client,
        'SELECT id, status, master_order_id FROM master_consolidations WHERE id = $1 FOR UPDATE', [id]);
      if (!consolidation) throw notFound();
      if (consolidation.status !== 'started') throw conflict('تجمیع در وضعیت تکمیل نیست.');
      const unverified = await one<{ count: string }>(client,
        'SELECT count(*)::text AS count FROM consolidation_items WHERE consolidation_id = $1 AND verified_at IS NULL', [id]);
      if (Number(unverified?.count ?? 0) > 0) {
        throw code(409, 'CONSOLIDATION_NOT_READY', 'هنوز اقلامی بدون تأیید اسکن باقی مانده است.');
      }
      await client.query(
        `UPDATE master_consolidations SET status = 'consolidated', consolidated_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await client.query(
        `UPDATE orders SET child_fulfillment = 'consolidated', wholesale_fulfillment_status = 'consolidated',
           consolidated_at = COALESCE(consolidated_at, now()), consolidated_by = COALESCE(consolidated_by, $2), updated_at = now()
         WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'`,
        [consolidation.master_order_id, user.id]);
      await audit(client, user.id, 'wholesale_consolidation.completed', 'master_consolidation', id, undefined, undefined, request.ip);
      await outbox(client, 'wholesale_master.consolidated', 'master_order', consolidation.master_order_id,
        { masterOrderId: consolidation.master_order_id, consolidationId: id });
      return { ok: true, status: 'consolidated' };
    });
  });

  app.post('/api/v1/wholesale/consolidations/:id/pack', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const consolidation = await one<{ id: string; status: string; master_order_id: string }>(client,
        'SELECT id, status, master_order_id FROM master_consolidations WHERE id = $1 FOR UPDATE', [id]);
      if (!consolidation) throw notFound();
      if (consolidation.status !== 'consolidated') throw conflict('ابتدا تجمیع باید تکمیل شود.');
      await client.query(
        `UPDATE master_consolidations SET status = 'ready_for_shipment', packed_at = now(), packed_by = $2, updated_at = now() WHERE id = $1`,
        [id, user.id]);
      await client.query(
        `UPDATE orders SET packed_at = COALESCE(packed_at, now()), updated_at = now()
         WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled'`,
        [consolidation.master_order_id]);
      await audit(client, user.id, 'wholesale_consolidation.packed', 'master_consolidation', id, undefined, undefined, request.ip);
      return { ok: true, status: 'ready_for_shipment' };
    });
  });

  /* ============================ final master shipment (§103, §110) ============================ */

  app.post('/api/v1/wholesale/masters/:id/ship', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      carrier: z.string().trim().min(2).max(80),
      trackingCode: z.string().trim().min(3).max(120),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const master = await one<{ id: string; shipped_at: Date | null }>(client,
        'SELECT id, shipped_at FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (master.shipped_at) throw conflict('این سفارش مادر قبلاً ارسال شده است.');
      const consolidation = await one<{ id: string; status: string }>(client,
        'SELECT id, status FROM master_consolidations WHERE master_order_id = $1 FOR UPDATE', [id]);
      if (!consolidation || consolidation.status !== 'ready_for_shipment') {
        throw code(409, 'CONSOLIDATION_NOT_READY', 'تجمیع و بسته‌بندی هنوز کامل نشده است.');
      }
      await client.query("UPDATE master_consolidations SET status = 'shipped', updated_at = now() WHERE id = $1", [consolidation.id]);
      await client.query(
        `UPDATE master_orders SET carrier = $2, tracking_code = $3, shipped_at = now(), updated_at = now() WHERE id = $1`,
        [id, body.carrier, body.trackingCode]);
      const children = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled' FOR UPDATE`, [id]);
      for (const child of children.rows) {
        await client.query(
          `UPDATE orders SET status = 'in_transit', child_fulfillment = 'in_transit',
             wholesale_fulfillment_status = 'vip_dispatched', vip_dispatched_at = COALESCE(vip_dispatched_at, now()),
             vip_tracking_code = $2, vip_carrier = $3, updated_at = now() WHERE id = $1`,
          [child.id, body.trackingCode, body.carrier]);
        await client.query(
          `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
           VALUES ($1,$2,$3,'in_transit',$4,$5)`,
          [randomUUID(), child.id, child.status, user.id, `ارسال نهایی سفارش مادر (${body.carrier} — ${body.trackingCode})`]);
      }
      await audit(client, user.id, 'wholesale_master.shipped', 'master_order', id, undefined, body, request.ip);
      await outbox(client, 'wholesale_master.shipped', 'master_order', id,
        { masterOrderId: id, carrier: body.carrier, trackingCode: body.trackingCode });
      return { ok: true, shipped: children.rows.length };
    });
  });

  app.post('/api/v1/wholesale/masters/:id/deliver', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const master = await one<{ id: string; shipped_at: Date | null; delivered_at: Date | null }>(client,
        'SELECT id, shipped_at, delivered_at FROM master_orders WHERE id = $1 FOR UPDATE', [id]);
      if (!master) throw notFound();
      if (!master.shipped_at) throw conflict('سفارش مادر هنوز ارسال نشده است.');
      if (master.delivered_at) throw conflict('تحویل این سفارش مادر قبلاً ثبت شده است.');
      await client.query(
        `UPDATE master_orders SET delivered_at = now(), status = 'completed', updated_at = now() WHERE id = $1`, [id]);
      const children = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM orders WHERE master_order_id = $1 AND composition_state = 'included' AND status <> 'cancelled' FOR UPDATE`, [id]);
      for (const child of children.rows) {
        await client.query(
          `UPDATE orders SET status = 'delivered', child_fulfillment = 'delivered',
             wholesale_fulfillment_status = 'delivered', updated_at = now() WHERE id = $1`, [child.id]);
        await client.query(
          `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
           VALUES ($1,$2,$3,'delivered',$4,'تحویل سفارش مادر به خریدار VIP')`,
          [randomUUID(), child.id, child.status, user.id]);
        // §128-§129: finance hook per CHILD. Deliberately NOT postSupplierEarnings —
        // the legacy blanket wallet credit stays confined to legacy /orders/:id/transitions;
        // supplier settlement for master-flow children is Prompt 3, fed by this event.
        await outbox(client, 'child_order.fulfillment_delivered', 'order', child.id,
          { childOrderId: child.id, masterOrderId: id });
        // Prompt 3 (§13, §120): child-level supplier payable accrual — exactly once,
        // inside this same transaction. Kolbe children return null (no payable).
        await accrueChildPayable(client, child.id, user.id);
      }
      await audit(client, user.id, 'wholesale_master.delivered', 'master_order', id, undefined,
        { children: children.rows.length }, request.ip);
      await outbox(client, 'wholesale_master.delivered', 'master_order', id, { masterOrderId: id });
      return { ok: true, delivered: children.rows.length };
    });
  });

  /* ============================ deadline sweep (§47-§49/§69-§70) ============================ */

  app.post('/api/v1/wholesale/oms/expire-sweep', async (request) => {
    const user = await principal(request, pool, config);
    if (!isOps(user)) throw forbidden();
    const result = await runWholesaleOmsSweep(pool, user.id);
    await transaction(pool, async (client) => {
      await audit(client, user.id, 'wholesale_oms.sweep', 'wholesale_oms', randomUUID(), undefined, result, request.ip);
    });
    return result;
  });
}
