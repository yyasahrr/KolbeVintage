/**
 * Shared OMS fulfillment primitives (Prompt 2 → Prompt 6).
 *
 * Why this module exists: Prompt 6 needed the SAME fulfillment rules (warehouse resolution,
 * exception opening, child readiness derivation, exception resolution, inbound policy, warehouse
 * duties) from two route families — the OMS routes (`wholesale-oms.ts`) and the warehouse/inbound
 * routes (`work-inbound.ts`). Copying them would create a second authority for readiness and
 * exception handling, so they live here ONCE and both families import them.
 *
 * No business rule changed during the extraction: `childFulfillmentState` is the previous
 * `refreshChildFulfillment` plus the Prompt 6 hardening documented in the Prompt 6 report
 * (§readiness derivation), and `resolveFulfillmentException` is the previous inline handler.
 */
import { randomUUID } from 'node:crypto';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import type { Principal } from './auth.js';
import { audit, outbox } from './operations.js';
import { notFound, conflict } from './errors.js';

/* ----------------------------- shared row types ----------------------------- */

export type ChildRow = {
  id: string; reference: string; buyer_id: string; status: string; master_order_id: string | null;
  seller_type: 'kolbe' | 'supplier' | null; seller_id: string | null;
  supply_status: string | null; payment_eligibility: string | null;
  payment_due_at: Date | null; supplier_respond_by: Date | null;
  child_fulfillment: string | null; composition_state: string | null;
  subtotal_rial: string; discount_rial: string; total_rial: string;
};

export type LineRow = {
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

export type AllocationRow = {
  id: string; line_id: string; child_order_id: string; master_order_id: string;
  source_type: 'kolbe_stock' | 'supplier_stock_at_kolbe' | 'supplier_external';
  quantity: number; status: string; warehouse_id: string | null; owner_supplier_id: string | null;
  offer_id: string | null; capacity_reservation_id: string | null; reservation_expires_at: Date | null;
  disposition: string; dispatched_series: number; received_series: number;
  qc_passed_series: number; qc_rejected_series: number;
  reserved_at?: Date | null; created_at?: Date;
  supplier_response_status?: string; supplier_response_note?: string | null; supplier_committed_series?: number;
  supplier_responded_at?: Date | null; supplier_committed_at?: Date | null; supplier_ready_at?: Date | null;
  /* Prompt 6 receiving/QC detail */
  inbound_shipment_id?: string | null; received_missing_series?: number; received_damaged_series?: number;
  qc_damaged_series?: number; receipt_note?: string | null; qc_note?: string | null;
  received_by?: string | null; received_at?: Date | null; qc_by?: string | null; qc_at?: Date | null;
};

/* ----------------------------- warehouse duties (§27) ----------------------------- */

export const WMS_DUTIES = ['wms:receive', 'wms:qc', 'wms:consolidate', 'wms:ship'] as const;
export type WmsDuty = (typeof WMS_DUTIES)[number];

/**
 * Legacy broad operational permission. Accounts holding it keep every warehouse capability they
 * already had (accepted Prompt 1-5 behaviour is never silently narrowed); the granular `wms:*`
 * duties exist so an operator account CAN be restricted to e.g. receiving-only or QC-only.
 */
export function isWholesaleOps(user: Principal): boolean {
  return user.permissions.includes('wholesale:ops') || user.permissions.includes('orders:transition');
}

/** Server-side duty gate — the UI never decides who may receive, inspect, pack or ship. */
export function hasWarehouseDuty(user: Principal, duty: WmsDuty): boolean {
  return user.permissions.includes(duty) || isWholesaleOps(user);
}

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

/** §40: an authorized Kolbe-side destination only — supplier-owned or inactive warehouses are refused. */
export async function assertAuthorizedKolbeDestination(client: DbClient, warehouseId: string) {
  const row = await one<{ id: string; active: boolean; owner_id: string | null; purpose: string; name: string }>(
    client, 'SELECT id, active, owner_id, purpose, name FROM warehouses WHERE id = $1', [warehouseId]);
  if (!row || !row.active) throw notFound();
  if (row.owner_id !== null) {
    throw conflict('مقصد محموله ورودی باید انبار تحت اختیار کلبه باشد؛ انبار اختصاصی تأمین‌کننده مجاز نیست.');
  }
  return row;
}

/* ----------------------------- inbound policy ----------------------------- */

export type WmsInboundPolicy = { inboundDelayHours: number };
const WMS_INBOUND_DEFAULTS: WmsInboundPolicy = { inboundDelayHours: 72 };

/** Operational thresholds are settings, not hardcoded rules (same convention as migration 064 §47/§69). */
export async function wmsInboundPolicy(db: DbPool | DbClient): Promise<WmsInboundPolicy> {
  const row = await one<{ value: Partial<WmsInboundPolicy> }>(db, "SELECT value FROM site_settings WHERE key = 'wms_inbound_policy'");
  const raw = row?.value ?? {};
  const hours = Number(raw.inboundDelayHours ?? WMS_INBOUND_DEFAULTS.inboundDelayHours);
  return { inboundDelayHours: Number.isFinite(hours) && hours > 0 ? hours : WMS_INBOUND_DEFAULTS.inboundDelayHours };
}

/* ----------------------------- exceptions (§88-§90, §14) ----------------------------- */

export const FULFILLMENT_EXCEPTION_TYPES = [
  'shortage', 'damaged', 'qc_rejected', 'wrong_product', 'wrong_variant',
  'wrong_series', 'supplier_late', 'lost_inbound', 'payment_late_callback',
  'over_receipt', 'incorrect_quantity', 'reconciliation_failed',
  'delayed_inbound', 'supplier_non_fulfillment', 'wrong_master_order',
] as const;

/** One writer for `fulfillment_exceptions` — the Exception Center only reads them. */
export async function openFulfillmentException(client: DbClient, input: {
  masterOrderId: string | null; childOrderId: string; lineId?: string | null; allocationId?: string | null;
  type: string; quantity?: number | null; note: string; actorId: string; assignedTo?: string | null;
}): Promise<string> {
  const exceptionId = randomUUID();
  await client.query(
    `INSERT INTO fulfillment_exceptions(id, master_order_id, child_order_id, line_id, allocation_id, exception_type, quantity, status, note, created_by, assigned_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10)`,
    [exceptionId, input.masterOrderId, input.childOrderId, input.lineId ?? null, input.allocationId ?? null,
      input.type, input.quantity ?? null, input.note, input.actorId, input.assignedTo ?? null]);
  await outbox(client, 'child_order.exception_opened', 'order', input.childOrderId,
    { childOrderId: input.childOrderId, exceptionId, exceptionType: input.type, quantity: input.quantity ?? null });
  return exceptionId;
}

export type ExceptionResolution = 'accept_short' | 'refund_pending' | 'supplier_redelivery' | 'written_off';

/**
 * §89-§90: the ONE resolution authority for a fulfillment exception (money moves in Prompt 3 —
 * this only records an explicit, audited reference and re-derives the child state).
 */
export async function resolveFulfillmentException(pool: DbPool, user: Principal, input: {
  exceptionId: string; resolution: ExceptionResolution; note?: string; ip?: string;
}): Promise<{ ok: true; childFulfillment: string }> {
  return transaction(pool, async (client) => {
    const exception = await one<{
      id: string; master_order_id: string | null; child_order_id: string; line_id: string | null;
      allocation_id: string | null; exception_type: string; quantity: number | null; status: string;
    }>(client, 'SELECT * FROM fulfillment_exceptions WHERE id = $1 FOR UPDATE', [input.exceptionId]);
    if (!exception) throw notFound();
    if (exception.status !== 'open') throw conflict('این استثنا قبلاً تعیین تکلیف شده است.');
    const resolutionReference = {
      resolvedBy: user.id, resolution: input.resolution, note: input.note ?? '',
      financeFollowUp: input.resolution === 'refund_pending' ? 'prompt3_refund' : null,
    };
    await client.query(
      `UPDATE fulfillment_exceptions SET status = 'resolved', resolution = $2, resolution_reference = $3,
         resolved_by = $4, resolved_at = now(), updated_at = now() WHERE id = $1`,
      [input.exceptionId, input.resolution, JSON.stringify(resolutionReference), user.id]);
    if (exception.allocation_id && (input.resolution === 'accept_short' || input.resolution === 'refund_pending' || input.resolution === 'written_off')) {
      // close the allocation at its QC-passed quantity; accepted shortfall is explicit, never silent.
      await client.query(
        `UPDATE order_source_allocations SET status = 'consumed', updated_at = now()
         WHERE id = $1 AND status NOT IN ('consumed','released','cancelled')`, [exception.allocation_id]);
      if (exception.line_id) {
        await client.query('UPDATE child_order_lines SET accepted_series = NULL, updated_at = now() WHERE id = $1', [exception.line_id]);
      }
    }
    if (input.resolution === 'supplier_redelivery' && exception.allocation_id) {
      // re-open the inbound leg: supplier dispatches again for the missing quantity.
      await client.query(
        `UPDATE order_source_allocations SET dispatched_series = 0, received_series = 0,
           qc_passed_series = 0, qc_rejected_series = 0, received_missing_series = 0,
           received_damaged_series = 0, qc_damaged_series = 0, updated_at = now()
         WHERE id = $1 AND status = 'reserved'`, [exception.allocation_id]);
    }
    if (input.resolution === 'refund_pending') {
      await outbox(client, 'child_order.refund_requested', 'order', exception.child_order_id, {
        childOrderId: exception.child_order_id, masterOrderId: exception.master_order_id,
        exceptionId: input.exceptionId, exceptionType: exception.exception_type,
        quantity: exception.quantity, reason: 'fulfillment_exception',
      });
    }
    const state = await childFulfillmentState(client, exception.child_order_id);
    await audit(client, user.id, 'wholesale_exception.resolved', 'fulfillment_exception', input.exceptionId, undefined,
      { resolution: input.resolution }, input.ip);
    return { ok: true as const, childFulfillment: state };
  });
}

/* ----------------------------- readiness derivation (§16, §73-§76, §91) ----------------------------- */

export type ChildCoverage = {
  pendingAllocations: number;
  openExceptions: number;
  usableByLine: Map<string, number>;
  linesWithoutCoverage: string[];
  unreconciledInbound: string[];
};

/**
 * Readiness is DERIVED from operational records — there is no editable «آماده تجمیع» flag.
 *
 * Prompt 6 hardening (§16): a child is ready only when payment is settled, no exception is open,
 * no allocation is still pending/reserved, every external leg is fully reconciled
 * (dispatched = received + missing AND received = passed + rejected + damaged), and every active
 * line has real staged coverage. Declared supplier capacity, an in-transit leg, a partially
 * inspected leg or a released allocation can therefore never read as physical readiness.
 */
export async function childFulfillmentState(client: DbClient, childOrderId: string): Promise<string> {
  const child = await one<ChildRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [childOrderId]);
  if (!child) throw notFound();
  const allocations = await client.query<AllocationRow>(
    `SELECT * FROM order_source_allocations WHERE child_order_id = $1 ORDER BY created_at`, [childOrderId]);
  const openExceptions = await one<{ count: string }>(client,
    `SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'`, [childOrderId]);
  const lines = await client.query<LineRow>(
    `SELECT * FROM child_order_lines WHERE child_order_id = $1 AND status NOT IN ('removed','rejected')`, [childOrderId]);

  const pendingAllocations = allocations.rows.filter((a) => a.status === 'pending' || a.status === 'reserved');
  // An external leg is reconciled once its dispatch scope is closed AND its QC scope is closed.
  const unreconciledInbound = allocations.rows.filter((a) => {
    if (a.source_type !== 'supplier_external') return false;
    if (['released', 'cancelled', 'expired'].includes(a.status)) return false;
    if (a.status === 'pending') return false; // plan only — capacity, not physical inbound
    if (a.dispatched_series <= 0) return false;
    const receivedClosed = a.received_series + (a.received_missing_series ?? 0) >= a.dispatched_series;
    const qcClosed = a.received_series > 0
      && a.qc_passed_series + a.qc_rejected_series + (a.qc_damaged_series ?? 0) >= a.received_series;
    return !(receivedClosed && qcClosed);
  }).map((a) => a.id);

  const usable = new Map<string, number>();
  for (const line of lines.rows) {
    const lineAllocations = allocations.rows.filter((a) => a.line_id === line.id);
    const total = lineAllocations.reduce((sum, a) => {
      if (['released', 'cancelled', 'expired'].includes(a.status)) return sum;
      if (a.source_type === 'supplier_external') return sum + a.qc_passed_series;
      return sum + (a.status === 'consumed' ? a.quantity : 0);
    }, 0);
    usable.set(line.id, total);
  }
  const linesWithoutCoverage = lines.rows.filter((line) => (usable.get(line.id) ?? 0) <= 0).map((line) => line.id);

  let state = child.child_fulfillment ?? 'not_started';
  if (Number(openExceptions?.count ?? 0) > 0) {
    state = 'exception';
  } else if (
    child.payment_eligibility === 'paid'
    && pendingAllocations.length === 0
    && unreconciledInbound.length === 0
    && linesWithoutCoverage.length === 0
    && lines.rows.length > 0
    && !['consolidated', 'delivered'].includes(state)
  ) {
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
  } else if (
    child.payment_eligibility === 'paid'
    && state === 'ready_for_consolidation'
    && (unreconciledInbound.length > 0 || linesWithoutCoverage.length > 0 || pendingAllocations.length > 0)
  ) {
    // A previously-ready child regressed (e.g. a re-dispatched leg after an authorised redelivery):
    // readiness is never sticky once its physical basis is gone.
    state = 'preparing';
  } else if (state === 'exception') {
    // Prompt 6: 'exception' is only ever produced by an OPEN exception row, so once every exception is
    // resolved the label must be re-derived — never left stale on a child that is merely mid-flight
    // again (an authorised replacement leg, a reopened inbound, a partially restaged requirement).
    state = child.payment_eligibility === 'paid' ? 'preparing'
      : child.payment_eligibility === 'ready' ? 'waiting_payment' : 'not_started';
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

/** Read-only projection used by the warehouse work queues (no state mutation). */
export async function childCoverage(client: DbClient, childOrderId: string): Promise<ChildCoverage> {
  const snapshot = await client.query<AllocationRow>(
    `SELECT * FROM order_source_allocations WHERE child_order_id = $1`, [childOrderId]);
  const openExceptions = await one<{ count: string }>(client,
    `SELECT count(*)::text AS count FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'`, [childOrderId]);
  const lines = await client.query<LineRow>(
    `SELECT * FROM child_order_lines WHERE child_order_id = $1 AND status NOT IN ('removed','rejected')`, [childOrderId]);
  const usableByLine = new Map<string, number>();
  for (const line of lines.rows) {
    const total = snapshot.rows.filter((a) => a.line_id === line.id).reduce((sum, a) => {
      if (['released', 'cancelled', 'expired'].includes(a.status)) return sum;
      if (a.source_type === 'supplier_external') return sum + a.qc_passed_series;
      return sum + (a.status === 'consumed' ? a.quantity : 0);
    }, 0);
    usableByLine.set(line.id, total);
  }
  return {
    pendingAllocations: snapshot.rows.filter((a) => a.status === 'pending' || a.status === 'reserved').length,
    openExceptions: Number(openExceptions?.count ?? 0),
    usableByLine,
    linesWithoutCoverage: lines.rows.filter((line) => (usableByLine.get(line.id) ?? 0) <= 0).map((line) => line.id),
    unreconciledInbound: snapshot.rows
      .filter((a) => a.source_type === 'supplier_external' && a.dispatched_series > 0
        && !['released', 'cancelled', 'expired'].includes(a.status)
        && !(a.received_series + (a.received_missing_series ?? 0) >= a.dispatched_series
          && a.qc_passed_series + a.qc_rejected_series + (a.qc_damaged_series ?? 0) >= a.received_series))
      .map((a) => a.id),
  };
}
