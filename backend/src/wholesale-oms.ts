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
import { principal, type Principal } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import type { PoolClient } from 'pg';
import { rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { assertNotRestricted } from './console.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { resolveVariantPrice } from './promotions.js';
import { loadSeriesComposition } from './series.js';
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
};

type AllocationRow = {
  id: string; line_id: string; child_order_id: string; master_order_id: string;
  source_type: 'kolbe_stock' | 'supplier_stock_at_kolbe' | 'supplier_external';
  quantity: number; status: string; warehouse_id: string | null; owner_supplier_id: string | null;
  offer_id: string | null; capacity_reservation_id: string | null; reservation_expires_at: Date | null;
  disposition: string; dispatched_series: number; received_series: number;
  qc_passed_series: number; qc_rejected_series: number;
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
    "INSERT INTO warehouses(id, owner_id, code, name, active) VALUES ($1, NULL, 'KOLBE-CENTRAL', 'انبار مرکزی کلبه', true) ON CONFLICT (code) DO NOTHING",
    [id]);
  const found = await one<{ id: string }>(client,
    'SELECT id FROM warehouses WHERE owner_id IS NULL AND active = true ORDER BY created_at ASC LIMIT 1');
  return found!.id;
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

/** Release every active physical/external hold of ONE line (counter-reject/remove/expiry paths). */
export async function releaseLineHolds(client: DbClient, line: LineRow, actorId: string, note: string): Promise<void> {
  const allocations = await client.query<AllocationRow>(
    'SELECT * FROM order_source_allocations WHERE line_id = $1 FOR UPDATE', [line.id]);
  for (const alloc of allocations.rows) {
    if (alloc.status === 'reserved' || alloc.status === 'pending') {
      if (alloc.source_type === 'supplier_external') {
        if (alloc.capacity_reservation_id) {
          await settleSupplierCapacityReservation(client, alloc.capacity_reservation_id, 'released');
        }
      } else if (alloc.status === 'reserved' && alloc.warehouse_id) {
        // owner-scoped series release through the Prompt-1 engine.
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
      await client.query("UPDATE order_source_allocations SET status = 'released', updated_at = now() WHERE id = $1", [alloc.id]);
    }
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
          const moqSeries = Math.max(1, Math.ceil(Number(product.wholesale_moq ?? 1) / pps));
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
            if (availableToRequest(offer) < remainder) {
              throw code(409, 'INSUFFICIENT_SUPPLIER_STOCK', `ظرفیت اعلامی تأمین‌کننده برای «${product.name}» کافی نیست.`);
            }
            // C: declared capacity ≠ eligibility — allocation stays pending until the supplier confirms (§23).
            allocations.push({ sourceType: 'supplier_external', quantity: remainder, warehouseId: null, ownerSupplierId: sellerId, offerId: offer.id });
          }
        }

        // ---- canonical pricing per piece (§64/§117) ----
        const pieces: PlannedLine['pieces'] = [];
        let unitSeriesPrice = 0n; let baseSeriesPrice = 0n;
        for (const component of composition.items) {
          const resolved = await resolveVariantPrice(client, component.variant_id, { orderType: 'wholesale', paymentMode: 'cash' });
          const basePrice = rial(resolved.basePrice);
          if (basePrice === 0n) throw badRequest(`قیمت فروش عمده برای SKU ${component.sku} معتبر نیست.`);
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

          // allocations + series-unit reservations.
          for (const alloc of line.allocations) {
            const allocationId = randomUUID();
            const isPhysical = alloc.sourceType !== 'supplier_external';
            let allocWarehouse = alloc.warehouseId;
            let allocStatus = 'pending';
            let expiresAt: Date | null = null;
            if (isPhysical) {
              // series banding when the template is tracked (legacy templates may be piece-only).
              if (alloc.warehouseId) {
                const recipeSnapshot = await buildRecipeSnapshot(client, line.templateId);
                await applySeriesMovement(client, {
                  templateId: line.templateId, warehouseId: alloc.warehouseId,
                  owner: { ownerType: alloc.sourceType === 'kolbe_stock' ? 'kolbe' : 'supplier', supplierId: alloc.ownerSupplierId },
                  movementType: 'reserve', reservedDelta: alloc.quantity, recipeSnapshot,
                  referenceType: 'order', referenceId: childId, actorId: user.id,
                  idempotencyKey: `series-reserve:${childId}:${line.templateId}:${alloc.sourceType}`,
                });
                await client.query(
                  `INSERT INTO order_series_reservations(id, order_id, series_template_id, warehouse_id, owner_type, supplier_id, series_count, recipe_snapshot)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                  [randomUUID(), childId, line.templateId, alloc.warehouseId,
                    alloc.sourceType === 'kolbe_stock' ? 'kolbe' : 'supplier', alloc.ownerSupplierId,
                    alloc.quantity, JSON.stringify(recipeSnapshot)]);
              } else {
                allocWarehouse = await centralWholesaleWarehouse(client);
              }
              allocStatus = 'reserved';
              expiresAt = new Date(Date.now() + policy.physicalReservationTtlMinutes * 60_000);
            }
            await client.query(
              `INSERT INTO order_source_allocations(
                 id, line_id, child_order_id, master_order_id, source_type, quantity, status,
                 warehouse_id, owner_supplier_id, offer_id, reservation_expires_at, disposition, reserved_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [allocationId, lineId, childId, masterId, alloc.sourceType, alloc.quantity, allocStatus,
                allocWarehouse, alloc.ownerSupplierId, alloc.offerId, expiresAt,
                alloc.sourceType === 'supplier_external' ? 'order_bound' : 'general',
                isPhysical ? new Date() : null]);
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

  app.get('/api/v1/wholesale/masters', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.iso.datetime().optional(),
      buyerId: z.uuid().optional(),
    }).parse(request.query);
    const admin = user.permissions.includes('orders:read');
    const buyerId = admin && query.buyerId ? query.buyerId : user.id;
    if (!admin && query.buyerId && query.buyerId !== user.id) throw forbidden();
    // one aggregate query — no N+1 (§212).
    const rows = await pool.query(
      `SELECT m.id, m.reference, m.composition, m.status, m.shipping_estimate_rial::text AS shipping_estimate_rial,
              m.tracking_code, m.carrier, m.created_at, m.locked_at, m.shipped_at, m.delivered_at,
              COUNT(o.id)::int AS child_count,
              COUNT(o.id) FILTER (WHERE o.seller_type = 'supplier')::int AS supplier_children,
              COUNT(o.id) FILTER (WHERE o.payment_eligibility = 'paid')::int AS paid_children,
              COUNT(o.id) FILTER (WHERE o.payment_eligibility = 'ready')::int AS ready_children,
              COUNT(o.id) FILTER (WHERE o.composition_state = 'included')::int AS included_children,
              COALESCE(SUM(o.total_rial) FILTER (WHERE o.composition_state = 'included'), 0)::text AS total_rial
       FROM master_orders m
       LEFT JOIN orders o ON o.master_order_id = m.id
       WHERE m.buyer_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
       GROUP BY m.id ORDER BY m.created_at DESC LIMIT $3`,
      [buyerId, query.before ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/wholesale/masters/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const master = await one<{ id: string; buyer_id: string; composition: string; [k: string]: unknown }>(pool,
      `SELECT id, reference, buyer_id, composition, status, shipping_address, shipping_method_id,
              shipping_estimate_rial::text AS shipping_estimate_rial, shipping_quote_snapshot,
              carrier, tracking_code, locked_at, shipped_at, delivered_at, note, created_at
       FROM master_orders WHERE id = $1`, [id]);
    if (!master) throw notFound();
    const admin = user.permissions.includes('orders:read') || isOps(user);
    const buyerView = master.buyer_id === user.id;
    if (!buyerView && !admin) throw forbidden();

    const children = await pool.query<ChildRow & { wholesale_fulfillment_status: string | null; created_at: Date }>(
      `SELECT id, reference, buyer_id, status, master_order_id, seller_type, seller_id, supply_status,
              payment_eligibility, payment_due_at, supplier_respond_by, child_fulfillment, composition_state,
              subtotal_rial::text AS subtotal_rial, discount_rial::text AS discount_rial, total_rial::text AS total_rial,
              wholesale_fulfillment_status, created_at
       FROM orders WHERE master_order_id = $1 ORDER BY created_at`, [id]);
    const lines = await pool.query<LineRow>(
      'SELECT * FROM child_order_lines WHERE master_order_id = $1 ORDER BY created_at', [id]);
    const allocations = await pool.query<AllocationRow>(
      'SELECT * FROM order_source_allocations WHERE master_order_id = $1 ORDER BY created_at', [id]);
    const exceptions = await pool.query(
      `SELECT id, child_order_id, line_id, allocation_id, exception_type, quantity, status, resolution, note, created_at, resolved_at
       FROM fulfillment_exceptions WHERE master_order_id = $1 ORDER BY created_at DESC`, [id]);
    const consolidation = await one(pool,
      `SELECT c.*, (SELECT COALESCE(json_agg(json_build_object(
            'id', ci.id, 'childOrderId', ci.child_order_id, 'lineId', ci.line_id,
            'expectedSeries', ci.expected_series, 'verifiedSeries', ci.verified_series, 'verifiedAt', ci.verified_at)), '[]'::json)
          FROM consolidation_items ci WHERE ci.consolidation_id = c.id) AS items
       FROM master_consolidations c WHERE c.master_order_id = $1`, [id]);

    const viewer: 'buyer' | 'ops' = buyerView ? 'buyer' : 'ops';
    // §72: suppliers never see this endpoint; buyer sees no supplier identity beyond type.
    const privacy = buyerView && !admin;
    return {
      ...master,
      children: children.rows.map((child) => ({
        ...child,
        seller_id: privacy ? null : child.seller_id,
        allowedActions: childAllowedActions(child, viewer, master.composition),
        lines: lines.rows.filter((l) => l.child_order_id === child.id).map((l) => ({
          ...l,
          seller_id: privacy ? null : l.seller_id,
          allocations: allocations.rows.filter((a) => a.line_id === l.id).map((a) => ({
            ...a, owner_supplier_id: privacy ? null : a.owner_supplier_id,
          })),
        })),
      })),
      exceptions: exceptions.rows,
      consolidation: consolidation ?? null,
      allowedActions: viewer === 'buyer' && master.composition === 'open'
        && children.rows.some((c) => c.composition_state === 'included') ? ['lock_composition'] : [],
    };
  });

  /* ============================ supplier panel (§71-§72) ============================ */

  app.get('/api/v1/wholesale/supplier/child-orders', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
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
                FROM child_order_lines l WHERE l.child_order_id = o.id), '[]'::json) AS lines
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
    note: z.string().max(400).optional(),
  }).strict();

  app.post('/api/v1/wholesale/supplier/lines/:lineId/respond', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
    const { lineId } = z.object({ lineId: z.uuid() }).parse(request.params);
    const body = respondSchema.parse(request.body);
    const policy = await omsPolicy(pool);

    return transaction(pool, async (client) => {
      const line = await one<LineRow>(client, 'SELECT * FROM child_order_lines WHERE id = $1 FOR UPDATE', [lineId]);
      if (!line) throw notFound();
      if (line.seller_id !== user.id) throw forbidden(); // IDOR guard (§133)
      if (line.status !== 'awaiting_supplier') {
        throw code(409, 'SUPPLIER_CONFIRMATION_REQUIRED', 'این ردیف در وضعیت انتظار پاسخ تأمین‌کننده نیست.');
      }
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [line.child_order_id]);
      if (!child || child.status !== 'pending_payment') throw code(409, 'CHILD_ALREADY_PAID', 'زیرسفارش قابل تغییر نیست.');

      const externalAllocs = await client.query<AllocationRow>(
        `SELECT * FROM order_source_allocations WHERE line_id = $1 AND source_type = 'supplier_external' AND status = 'pending' FOR UPDATE`,
        [lineId]);
      const externalQty = externalAllocs.rows.reduce((sum, a) => sum + a.quantity, 0);
      const physicalQty = line.requested_series - externalQty;

      if (body.action === 'confirm') {
        // §32-§33: confirmation = atomic capacity reservation; failure means NOT confirmed.
        for (const alloc of externalAllocs.rows) {
          if (!alloc.offer_id) throw code(409, 'CAPACITY_RESERVATION_FAILED', 'پیشنهاد مرتبط با این تخصیص یافت نشد.');
          let reservationId: string;
          try {
            const reserved = await reserveSupplierCapacity(client, {
              offerId: alloc.offer_id, quantity: alloc.quantity,
              ttlMinutes: policy.externalReservationTtlMinutes,
              referenceType: 'order_source_allocation', referenceId: alloc.id,
              note: `تأیید تأمین زیرسفارش ${child.reference}`, actorId: user.id,
              idempotencyKey: `oms-capacity:${alloc.id}`,
            });
            reservationId = reserved.reservationId;
          } catch {
            throw code(409, 'CAPACITY_RESERVATION_FAILED', 'رزرو اتمیک ظرفیت اعلامی ناکام ماند — ظرفیت کافی نیست.');
          }
          await client.query(
            `UPDATE order_source_allocations SET status = 'reserved', capacity_reservation_id = $2,
               reservation_expires_at = $3, reserved_at = now(), updated_at = now() WHERE id = $1`,
            [alloc.id, reservationId, new Date(Date.now() + policy.externalReservationTtlMinutes * 60_000)]);
        }
        await client.query(
          `UPDATE child_order_lines SET status = 'confirmed', confirmed_series = requested_series,
             responded_at = now(), updated_at = now() WHERE id = $1`, [lineId]);
        await appendNegotiation(client, lineId, { type: 'supplier_confirmed', series: line.requested_series, by: user.id });
      } else if (body.action === 'counter') {
        const proposed = body.proposedSeries;
        if (!proposed || proposed >= line.requested_series) {
          throw badRequest('پیشنهاد جایگزین باید کمتر از تعداد درخواستی باشد.');
        }
        if (proposed < physicalQty) {
          throw badRequest('پیشنهاد جایگزین نمی‌تواند از سهم موجودی تأییدشده نزد کلبه کمتر باشد.');
        }
        await client.query(
          `UPDATE child_order_lines SET status = 'awaiting_buyer', proposed_series = $2,
             responded_at = now(), updated_at = now() WHERE id = $1`, [lineId, proposed]);
        await appendNegotiation(client, lineId, {
          type: 'supplier_counter', requested: line.requested_series, proposed, by: user.id, note: body.note ?? '',
        });
      } else {
        // reject: whole line out; physical holds released; siblings unaffected (§40).
        await releaseLineHolds(client, line, user.id, 'رد تأمین توسط تأمین‌کننده');
        await removeLinePieces(client, line, user.id);
        await client.query(
          `UPDATE child_order_lines SET status = 'rejected', responded_at = now(), updated_at = now() WHERE id = $1`, [lineId]);
        await appendNegotiation(client, lineId, { type: 'supplier_rejected', by: user.id, note: body.note ?? '' });
        await recomputeChildTotals(client, line.child_order_id);
      }

      const updated = await recomputeChild(client, line.child_order_id, policy);
      if (updated.supply_status === 'rejected') {
        // every line rejected → child drops out of the consolidation denominator (§43).
        await client.query(
          `UPDATE orders SET status = 'cancelled', composition_state = 'removed', updated_at = now() WHERE id = $1`,
          [line.child_order_id]);
        await client.query(
          `INSERT INTO order_events(id, order_id, from_status, to_status, actor_id, note)
           VALUES ($1,$2,'pending_payment','cancelled',$3,'رد کامل تأمین — زیرسفارش از تجمیع خارج شد')`,
          [randomUUID(), line.child_order_id, user.id]);
      }
      await audit(client, user.id, `wholesale_line.${body.action}`, 'child_order_line', lineId, undefined,
        { childOrderId: line.child_order_id, proposedSeries: body.proposedSeries ?? null }, request.ip);
      await outbox(client, `child_order.supplier_${body.action}`, 'order', line.child_order_id,
        { lineId, action: body.action, proposedSeries: body.proposedSeries ?? null });
      return { ok: true, lineStatus: body.action === 'confirm' ? 'confirmed' : body.action === 'counter' ? 'awaiting_buyer' : 'rejected', child: { id: updated.id, supplyStatus: updated.supply_status, paymentEligibility: updated.payment_eligibility } };
    });
  });

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
              offerId: offer.id, quantity: newExternal,
              ttlMinutes: policy.externalReservationTtlMinutes,
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
               reservation_expires_at = $4, reserved_at = now(), updated_at = now() WHERE id = $1`,
            [alloc.id, newExternal, reservationId, new Date(Date.now() + policy.externalReservationTtlMinutes * 60_000)]);
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
             line_total_rial = unit_series_price_rial * $2::bigint, decided_at = now(), updated_at = now() WHERE id = $1`,
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
           AND supply_status IN ('unresolved', 'awaiting_supplier', 'partially_confirmed', 'awaiting_buyer', 'exception')`, [id]);
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

  /** Supplier dispatch of ORDER-BOUND external goods → ALWAYS to the central wholesale warehouse (§79-§80). */
  app.post('/api/v1/wholesale/supplier/children/:id/dispatch', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    // §137: destination is NOT accepted from the client — strict schema rejects any attempt.
    const body = z.object({ trackingNote: z.string().max(400).optional() }).strict().parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!child || child.seller_id !== user.id) throw forbidden(); // IDOR guard
      if (child.payment_eligibility !== 'paid') throw code(409, 'PAYMENT_NOT_READY', 'زیرسفارش هنوز پرداخت نشده است — ارسال مجاز نیست.');
      const destination = await centralWholesaleWarehouse(client);
      const allocations = await client.query<AllocationRow>(
        `SELECT * FROM order_source_allocations
         WHERE child_order_id = $1 AND source_type = 'supplier_external' AND status = 'reserved' AND dispatched_series = 0
         ORDER BY created_at FOR UPDATE`, [id]);
      if (!allocations.rows.length) throw conflict('تخصیص خارجی آماده ارسال وجود ندارد.');
      for (const alloc of allocations.rows) {
        await client.query(
          `UPDATE order_source_allocations SET dispatched_series = quantity, warehouse_id = $2, updated_at = now() WHERE id = $1`,
          [alloc.id, destination]);
        await client.query(
          `UPDATE child_order_lines SET dispatched_series = dispatched_series + $2, updated_at = now() WHERE id = $1`,
          [alloc.line_id, alloc.quantity]);
        // capacity is now truly used — consume the reservation (never returns to availableToRequest).
        if (alloc.capacity_reservation_id) {
          await settleSupplierCapacityReservation(client, alloc.capacity_reservation_id, 'consumed');
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
      return { ok: true, destinationWarehouseId: destination, childFulfillment: 'dispatched' };
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
