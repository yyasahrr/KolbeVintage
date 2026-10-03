/**
 * Prompt 3 — Supplier Financial Core (settlement-core).
 *
 * NEW canonical Supplier money-out path (§6/§99):
 *   Delivered Supplier Child → Net Payable → Settlement Hold → Eligible →
 *   Scheduled Settlement → Finance Review/Approve → Manual IBAN Transfer → PAID.
 *
 * Canonical reuse — NO parallel finance engine:
 *   - supplier_ledger_entries + journal (ledger.ts accrueSupplier / postJournalEntry)
 *     remain the financial source of truth (§17-§18, §22).
 *   - settlements / settlement_lines / settlement_exceptions / settlement_events /
 *     finance_approvals are the same canonical tables (settlements.kind='scheduled').
 *   - wallet / withdrawal flow stays ONLY as legacy history; normal supplier
 *     withdrawals are policy-disabled (§7, §62-§64).
 *   - payout.ts PayoutProviderAdapter is NEVER invoked here (§50-§51, §115, §171).
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { one, transaction, type DbPool } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { audit } from './operations.js';
import { rial } from './money.js';
import { accrueSupplier, financeEvent } from './ledger.js';
import { nextDocumentReference } from './references.js';

/* ============================================================================
 * Configurable finance policy (§26, §47, §57) — site_settings, code defaults.
 * ========================================================================== */
export type SupplierFinancePolicy = {
  holdHours: number;                    // global default hold duration (§26)
  bankCooldownHours: number;            // §47 verified→settlement_enabled cooldown
  dualControlThresholdRial: string;     // §57 second approval above this net
  legacyWithdrawalsEnabled: boolean;    // §62-§64: false = withdrawal create deprecated
};

export async function supplierFinancePolicy(db: DbPool | PoolClient): Promise<SupplierFinancePolicy> {
  const row = await one<{ value: Record<string, unknown> }>(db,
    "SELECT value FROM site_settings WHERE key = 'supplier_finance_policy'", []);
  const value = row?.value ?? {};
  const num = (key: string, fallback: number) => typeof value[key] === 'number' && Number.isFinite(value[key] as number)
    ? Math.max(0, Math.trunc(value[key] as number)) : fallback;
  return {
    holdHours: num('holdHours', 72),
    bankCooldownHours: num('bankCooldownHours', 0),
    dualControlThresholdRial: typeof value.dualControlThresholdRial === 'string'
      && /^\d+$/.test(value.dualControlThresholdRial as string) ? value.dualControlThresholdRial as string : '500000000',
    legacyWithdrawalsEnabled: value.legacyWithdrawalsEnabled === true,
  };
}

/* ============================================================================
 * Settlement policy resolution + schedule math (§33-§37, §153).
 * ========================================================================== */
export type SettlementPolicyRow = {
  id: string; name: string; active: boolean; schedule_type: 'weekly' | 'monthly' | 'month_days' | 'manual';
  weekly_day: number | null; month_days: number[]; minimum_settlement_rial: string;
  hold_hours: number | null; requires_verified_bank: boolean; requires_manual_review: boolean;
  version: number;
};

const DEFAULT_POLICY_ID = '00000000-0000-4000-9000-000000000001';

export async function resolveSettlementPolicy(db: DbPool | PoolClient, supplierId: string): Promise<SettlementPolicyRow> {
  const row = await one<SettlementPolicyRow>(db,
    `SELECT p.id, p.name, p.active, p.schedule_type, p.weekly_day, p.month_days,
            p.minimum_settlement_rial::text AS minimum_settlement_rial, p.hold_hours,
            p.requires_verified_bank, p.requires_manual_review, p.version
       FROM settlement_policies p
      WHERE p.active AND p.effective_from <= now() AND (p.effective_to IS NULL OR p.effective_to > now())
        AND (p.id = (SELECT settlement_policy_id FROM supplier_profiles WHERE user_id = $1) OR p.id = $2)
      ORDER BY (p.id = (SELECT settlement_policy_id FROM supplier_profiles WHERE user_id = $1)) DESC
      LIMIT 1`, [supplierId, DEFAULT_POLICY_ID]);
  if (!row) throw conflict('هیچ سیاست تسویه فعالی تعریف نشده است.');
  return row;
}

const lastDayOfMonth = (year: number, month0: number) => new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();

/** Next due settlement date strictly AFTER `after` (UTC date semantics). */
export function nextSettlementDate(policy: Pick<SettlementPolicyRow, 'schedule_type' | 'weekly_day' | 'month_days'>, after: Date): Date | null {
  const base = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate()));
  if (policy.schedule_type === 'manual') return null;
  if (policy.schedule_type === 'weekly') {
    const target = policy.weekly_day ?? 0;
    const delta = ((target - base.getUTCDay()) + 7) % 7 || 7;
    return new Date(base.getTime() + delta * 86_400_000);
  }
  const days = [...(policy.month_days ?? [])].filter((d) => Number.isInteger(d) && d >= 1 && d <= 31).sort((a, b) => a - b);
  if (!days.length) return null;
  for (let probe = 0; probe < 14; probe += 1) {
    const candidateMonth = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + probe, 1));
    const lastDay = lastDayOfMonth(candidateMonth.getUTCFullYear(), candidateMonth.getUTCMonth());
    for (const day of days) {
      const clamped = Math.min(day, lastDay);
      const candidate = new Date(Date.UTC(candidateMonth.getUTCFullYear(), candidateMonth.getUTCMonth(), clamped));
      if (candidate.getTime() > base.getTime()) return candidate;
    }
  }
  return null;
}

/** Is `asOf` one of the policy's settlement days? (generation gate, §37). */
export function isSettlementDueOn(policy: Pick<SettlementPolicyRow, 'schedule_type' | 'weekly_day' | 'month_days'>, asOf: Date): boolean {
  if (policy.schedule_type === 'manual') return false;
  if (policy.schedule_type === 'weekly') return asOf.getUTCDay() === (policy.weekly_day ?? 0);
  const days = (policy.month_days ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  if (!days.length) return false;
  const lastDay = lastDayOfMonth(asOf.getUTCFullYear(), asOf.getUTCMonth());
  const today = asOf.getUTCDate();
  return days.some((day) => Math.min(day, lastDay) === today);
}

/* ============================================================================
 * Shipping financial policy resolution (§73-§83) — versioned, snapshotted.
 * ========================================================================== */
export type ShippingLeg = 'supplier_inbound_order' | 'supplier_inbound_stock' | 'master_final';

export async function resolveShippingPolicy(db: DbPool | PoolClient, leg: ShippingLeg, supplierId: string | null, at = new Date()) {
  return one<{ id: string; name: string; leg: string; payer: string; supplier_share_percent: string;
    method: string; amount_rial: string; version: number; supplier_id: string | null }>(db,
    `SELECT id, name, leg, payer, supplier_share_percent::text AS supplier_share_percent,
            method, amount_rial::text AS amount_rial, version, supplier_id
       FROM shipping_financial_policies
      WHERE leg = $1 AND active AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)
        AND (supplier_id = $2 OR supplier_id IS NULL)
      ORDER BY (supplier_id = $2) DESC NULLS LAST, effective_from DESC
      LIMIT 1`, [leg, supplierId, at]);
}

/** Supplier share of a shipping leg under a resolved policy (server-side only, §82-§83). */
export function supplierShippingShare(policy: { payer: string; supplier_share_percent: string; method: string; amount_rial: string } | null,
  context: { seriesCount: number; actualCostRial?: bigint }): bigint {
  if (!policy) return 0n;
  const baseCost = policy.method === 'per_series'
    ? rial(policy.amount_rial) * BigInt(Math.max(0, context.seriesCount))
    : policy.method === 'actual_cost'
      ? (context.actualCostRial ?? 0n)
      : rial(policy.amount_rial);
  if (policy.payer === 'supplier') return baseCost;
  if (policy.payer === 'shared') {
    const pct = Math.round(Number(policy.supplier_share_percent) * 100);
    return baseCost * BigInt(Math.max(0, Math.min(10000, pct))) / 10000n;
  }
  return 0n; // customer / kolbe / promotion never deduct from the supplier (§83).
}

export const maskIban = (iban: string | null | undefined) =>
  iban && iban.length >= 8 ? `${iban.slice(0, 2)}••••••••••${iban.slice(-4)}` : '••••';

/* ============================================================================
 * §13-§17, §27, §120: child-level supplier payable accrual — exactly once.
 * Called INSIDE the master-deliver transaction (wholesale-oms.ts).
 * ========================================================================== */
export async function accrueChildPayable(client: PoolClient, childOrderId: string, actorId: string | null): Promise<
  { payableId: string; netRial: string; created: boolean } | null> {
  const child = await one<{ id: string; reference: string; master_order_id: string | null; seller_type: string;
    seller_id: string | null; payment_eligibility: string; status: string; discount_rial: string }>(client,
    `SELECT id, reference, master_order_id, seller_type, seller_id, payment_eligibility, status, discount_rial::text
       FROM orders WHERE id = $1 FOR UPDATE`, [childOrderId]);
  if (!child || !child.master_order_id) return null;
  // §12: Kolbe children never create supplier payables, even inside mixed masters.
  if (child.seller_type !== 'supplier' || !child.seller_id) return null;
  // §13/§105: payment + delivery are both hard preconditions — admin cannot bypass.
  if (child.payment_eligibility !== 'paid') return null;

  const existing = await one<{ id: string; net_rial: string }>(client,
    'SELECT id, net_rial::text FROM supplier_child_payables WHERE child_order_id = $1', [childOrderId]);
  if (existing) return { payableId: existing.id, netRial: existing.net_rial, created: false }; // §120 exactly-once

  // §15: FINAL accepted quantity per line (accepted → confirmed fallback for
  // stock-sourced lines that never pass QC).
  const lines = await client.query<{ id: string; product_id: string; requested_series: number; confirmed_series: number | null;
    accepted_series: number | null; dispatched_series: number; received_series: number; qc_passed_series: number;
    unit_series_price_rial: string; status: string; commercial_snapshot: Record<string, unknown> }>(
    `SELECT id, product_id, requested_series, confirmed_series, accepted_series, dispatched_series,
            received_series, qc_passed_series, unit_series_price_rial::text, status, commercial_snapshot
       FROM child_order_lines WHERE child_order_id = $1 AND status NOT IN ('rejected', 'removed')
      ORDER BY created_at`, [childOrderId]);
  if (!lines.rows.length) return null;

  let gross = 0n; let seriesCount = 0;
  const quantitySnapshot: Array<Record<string, unknown>> = [];
  for (const line of lines.rows) {
    const settledQty = line.accepted_series ?? line.confirmed_series ?? line.requested_series;
    const unit = rial(line.unit_series_price_rial);
    gross += unit * BigInt(Math.max(0, settledQty));
    seriesCount += Math.max(0, settledQty);
    quantitySnapshot.push({
      lineId: line.id, productId: line.product_id,
      requested: line.requested_series, confirmed: line.confirmed_series,
      dispatched: line.dispatched_series, received: line.received_series,
      qcPassed: line.qc_passed_series, accepted: settledQty,
      unitSeriesPriceRial: line.unit_series_price_rial,
      productName: line.commercial_snapshot?.productName ?? null,
    });
  }

  // §84: commission snapshot at accrual — later contract changes never touch it.
  const profile = await one<{ commission_percent: string }>(client,
    'SELECT COALESCE(commission_percent, 0)::text AS commission_percent FROM supplier_profiles WHERE user_id = $1',
    [child.seller_id]);
  const commissionPercent = Number(profile?.commission_percent ?? '0');
  const commission = gross * BigInt(Math.max(0, Math.round(commissionPercent * 100))) / 10000n;

  // §79/§82: order-driven inbound shipping — resolved policy, snapshotted.
  const shippingPolicy = await resolveShippingPolicy(client, 'supplier_inbound_order', child.seller_id);
  const shippingShare = supplierShippingShare(shippingPolicy, { seriesCount });
  const shippingSnapshot = shippingPolicy ? {
    policyId: shippingPolicy.id, version: shippingPolicy.version, leg: shippingPolicy.leg,
    payer: shippingPolicy.payer, method: shippingPolicy.method, amountRial: shippingPolicy.amount_rial,
    supplierSharePercent: shippingPolicy.supplier_share_percent,
    resolvedSupplierShareRial: shippingShare.toString(), seriesCount,
  } : { policyId: null, payer: 'customer', resolvedSupplierShareRial: '0', note: 'no active policy — default customer payer' };

  const rawNet = gross - commission - shippingShare;
  const net = rawNet > 0n ? rawNet : 0n;

  const payableId = randomUUID();
  const reference = await nextDocumentReference(client, 'payable');

  // Ledger truth first (§17-§18): gross credit + explainable deductions.
  const ledgerEntries = await accrueSupplier(client, [
    { event: 'order_sale', amount: gross, reference, description: `فروش زیرسفارش ${child.reference}`,
      supplierId: child.seller_id, orderId: child.id, actorId, sourceType: 'child_order', sourceId: child.id },
    ...(commission > 0n ? [{ event: 'commission' as const, amount: commission, reference,
      description: `کارمزد ${commissionPercent}٪ — ${child.reference}`, supplierId: child.seller_id,
      orderId: child.id, actorId, sourceType: 'child_order', sourceId: child.id }] : []),
    ...(shippingShare > 0n ? [{ event: 'shipping_charge' as const, amount: shippingShare, reference,
      description: `سهم ارسال تأمین‌کننده — ${child.reference}`, supplierId: child.seller_id,
      orderId: child.id, actorId, sourceType: 'child_order', sourceId: child.id }] : []),
  ]);

  await client.query(
    `INSERT INTO supplier_child_payables(id, reference, supplier_id, child_order_id, master_order_id,
       gross_rial, commission_rial, shipping_share_rial, refunds_rial, adjustments_rial, net_rial,
       commission_percent, shipping_policy_snapshot, quantity_snapshot, ledger_refs, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9,$10,$11,$12,$13,'held',$14)`,
    [payableId, reference, child.seller_id, child.id, child.master_order_id,
      gross.toString(), commission.toString(), shippingShare.toString(), net.toString(),
      commissionPercent, JSON.stringify(shippingSnapshot), JSON.stringify(quantitySnapshot),
      JSON.stringify({ ledgerEntryIds: ledgerEntries.map((e) => e.id), journalEntryIds: ledgerEntries.map((e) => e.journalEntryId) }),
      actorId]);

  // §24-§27: settlement hold starts immediately at accrual.
  const policy = await resolveSettlementPolicy(client, child.seller_id);
  const finance = await supplierFinancePolicy(client);
  const holdHours = policy.hold_hours ?? finance.holdHours;
  const releaseAt = new Date(Date.now() + holdHours * 3_600_000);
  await client.query(
    `INSERT INTO settlement_holds(id, payable_id, supplier_id, child_order_id, amount_rial, status,
       release_at, reason, policy_snapshot, created_by)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)`,
    [randomUUID(), payableId, child.seller_id, child.id, net.toString(), releaseAt,
      'دوره نگهداری استاندارد پس از تحویل',
      JSON.stringify({ source: policy.hold_hours !== null ? 'settlement_policy' : 'global_default', holdHours, policyId: policy.id, policyVersion: policy.version }),
      actorId]);

  await audit(client, actorId, 'supplier_payable.accrued', 'supplier_payable', payableId, undefined,
    { reference, childOrderId: child.id, grossRial: gross.toString(), commissionRial: commission.toString(),
      shippingShareRial: shippingShare.toString(), netRial: net.toString(), commissionPercent });
  await financeEvent(client, 'settlement_hold.created', 'supplier_payable', payableId,
    { payableId, reference, supplierId: child.seller_id, childOrderId: child.id, netRial: net.toString(), releaseAt: releaseAt.toISOString() });
  return { payableId, netRial: net.toString(), created: true };
}

/* ============================================================================
 * §28: hold blockers — revalidated at release time, not only at creation.
 * ========================================================================== */
async function holdBlockers(client: PoolClient, hold: { payable_id: string; child_order_id: string; supplier_id: string; manual_block: boolean }): Promise<string[]> {
  const reasons: string[] = [];
  if (hold.manual_block) reasons.push('manual_finance_block');
  const openException = await one<{ count: string }>(client,
    `SELECT COUNT(*)::text AS count FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'`,
    [hold.child_order_id]);
  if (Number(openException?.count ?? '0') > 0) reasons.push('unresolved_fulfillment_exception');
  const openReturn = await one<{ count: string }>(client,
    `SELECT COUNT(*)::text AS count FROM return_requests r JOIN order_lines ol ON ol.id = r.order_line_id
      WHERE ol.order_id = $1 AND r.status IN ('requested', 'approved', 'received')`, [hold.child_order_id]);
  if (Number(openReturn?.count ?? '0') > 0) reasons.push('open_return');
  const restricted = await one<{ count: string }>(client,
    `SELECT COUNT(*)::text AS count FROM supplier_restrictions
      WHERE user_id = $1 AND scope IN ('settlement_request', 'withdrawal') AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())`, [hold.supplier_id]);
  if (Number(restricted?.count ?? '0') > 0) reasons.push('supplier_restricted');
  return reasons;
}

/** §31: idempotent hold-release sweep — release due holds OR mark them blocked. */
export async function releaseDueHolds(pool: DbPool, actorId: string | null, asOf = new Date()):
  Promise<{ released: number; blocked: number }> {
  return transaction(pool, async (client) => {
    const due = await client.query<{ id: string; payable_id: string; child_order_id: string; supplier_id: string;
      amount_rial: string; manual_block: boolean }>(
      `SELECT id, payable_id, child_order_id, supplier_id, amount_rial::text, manual_block
         FROM settlement_holds WHERE status = 'active' AND release_at <= $1
        ORDER BY release_at FOR UPDATE`, [asOf]);
    let released = 0; let blocked = 0;
    for (const hold of due.rows) {
      const blockers = await holdBlockers(client, hold);
      if (blockers.length) {
        await client.query(
          `UPDATE settlement_holds SET status = 'blocked', blocked_reason = $2, updated_at = now() WHERE id = $1`,
          [hold.id, blockers.join(',')]);
        await client.query(`UPDATE supplier_child_payables SET status = 'blocked', updated_at = now() WHERE id = $1`, [hold.payable_id]);
        await audit(client, actorId, 'settlement_hold.blocked', 'settlement_hold', hold.id, undefined, { blockers });
        blocked += 1;
        continue;
      }
      await client.query(
        `UPDATE settlement_holds SET status = 'released', released_at = $2, released_by = $3, updated_at = now() WHERE id = $1`,
        [hold.id, asOf, actorId]);
      // §32: release ⇒ ELIGIBLE for the next settlement batch — never a payment.
      await client.query(
        `UPDATE supplier_child_payables SET status = 'eligible', eligible_at = $2, updated_at = now() WHERE id = $1`,
        [hold.payable_id, asOf]);
      await audit(client, actorId, 'settlement_hold.released', 'settlement_hold', hold.id, undefined,
        { payableId: hold.payable_id, amountRial: hold.amount_rial });
      await financeEvent(client, 'settlement_hold.released', 'supplier_payable', hold.payable_id,
        { payableId: hold.payable_id, supplierId: hold.supplier_id, amountRial: hold.amount_rial });
      released += 1;
    }
    return { released, blocked };
  });
}

/* ============================================================================
 * §30, §89-§94: refund impact on a payable — partial, state-aware, auditable.
 * ========================================================================== */
export async function applyPayableRefund(client: PoolClient, input: {
  payableId: string; amountRial: bigint; reason: string; actorId: string | null;
  sourceType?: 'post_settlement_refund' | 'chargeback' | 'adjustment' | 'manual';
}): Promise<{ status: string; appliedTo: string; recoveryId?: string }> {
  if (input.amountRial <= 0n) throw badRequest('مبلغ بازپرداخت باید بزرگ‌تر از صفر باشد.');
  const payable = await one<{ id: string; reference: string; supplier_id: string; child_order_id: string;
    status: string; net_rial: string; refunds_rial: string; settlement_id: string | null }>(client,
    `SELECT id, reference, supplier_id, child_order_id, status, net_rial::text, refunds_rial::text, settlement_id
       FROM supplier_child_payables WHERE id = $1 FOR UPDATE`, [input.payableId]);
  if (!payable) throw notFound();
  const amount = input.amountRial;
  const net = rial(payable.net_rial);

  if (payable.status === 'settled') {
    // §92: paid history immutable — create a recovery, offset future settlements.
    const reference = await nextDocumentReference(client, 'recovery');
    const recoveryId = randomUUID();
    await client.query(
      `INSERT INTO supplier_recoveries(id, reference, supplier_id, amount_rial, status, source_type, source_id,
         child_order_id, origin_settlement_id, note, created_by)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$10)`,
      [recoveryId, reference, payable.supplier_id, amount.toString(), input.sourceType ?? 'post_settlement_refund',
        payable.id, payable.child_order_id, payable.settlement_id, input.reason, input.actorId]);
    await accrueSupplier(client, [{ event: 'refund', amount, reference,
      description: `بازپرداخت پس از تسویه — ${payable.reference}`, supplierId: payable.supplier_id,
      orderId: payable.child_order_id, actorId: input.actorId, sourceType: 'supplier_recovery', sourceId: recoveryId }]);
    await audit(client, input.actorId, 'supplier_recovery.created', 'supplier_recovery', recoveryId, undefined,
      { reference, payableId: payable.id, amountRial: amount.toString(), reason: input.reason });
    await financeEvent(client, 'reconciliation.exception', 'supplier_recovery', recoveryId,
      { recoveryId, supplierId: payable.supplier_id, amountRial: amount.toString(), sourceType: input.sourceType ?? 'post_settlement_refund' });
    return { status: 'recovery_created', appliedTo: 'recovery', recoveryId };
  }

  if (amount > net) throw conflict('مبلغ بازپرداخت از خالص قابل پرداخت این زیرسفارش بیشتر است.');
  const newNet = net - amount;

  await accrueSupplier(client, [{ event: 'refund', amount, reference: `${payable.reference}-RF${Date.now().toString(36)}`,
    description: `بازپرداخت — ${payable.reference}`, supplierId: payable.supplier_id,
    orderId: payable.child_order_id, actorId: input.actorId, sourceType: 'supplier_payable', sourceId: payable.id }]);
  await client.query(
    `UPDATE supplier_child_payables SET refunds_rial = refunds_rial + $2, net_rial = $3, updated_at = now() WHERE id = $1`,
    [payable.id, amount.toString(), newNet.toString()]);

  if (payable.status === 'held' || payable.status === 'blocked') {
    // §89: reduce the hold itself — only the remainder can ever release.
    await client.query(
      `UPDATE settlement_holds SET amount_rial = $2, updated_at = now() WHERE payable_id = $1 AND status IN ('active','blocked')`,
      [payable.id, newNet.toString()]);
  } else if (payable.status === 'scheduled' && payable.settlement_id) {
    // §91: a pending settlement must not silently keep the old total.
    const settlement = await one<{ id: string; status: string; net_rial: string; returns_rial: string; amount_rial: string }>(client,
      `SELECT id, status, net_rial::text, returns_rial::text, amount_rial::text FROM settlements WHERE id = $1 FOR UPDATE`,
      [payable.settlement_id]);
    if (settlement && settlement.status === 'pending') {
      await client.query(
        `UPDATE settlement_lines SET returns_rial = returns_rial + $3, net_rial = net_rial - $3
          WHERE settlement_id = $1 AND payable_id = $2`, [settlement.id, payable.id, amount.toString()]);
      await client.query(
        `UPDATE settlements SET returns_rial = returns_rial + $2, net_rial = net_rial - $2, amount_rial = amount_rial - $2
          WHERE id = $1`, [settlement.id, amount.toString()]);
      await client.query(
        `INSERT INTO settlement_exceptions(id, settlement_id, order_id, code, severity, detail, expected_rial, found_rial)
         VALUES ($1,$2,$3,'post_delivery_refund','warning',$4,$5,$6)`,
        [randomUUID(), settlement.id, payable.child_order_id,
          `بازپرداخت ${amount.toString()} ریال پیش از تأیید تسویه اعمال و مبلغ تسویه بازمحاسبه شد.`,
          net.toString(), newNet.toString()]);
    } else if (settlement) {
      // Approved but unpaid: block the transfer until finance resolves (§91).
      await client.query(
        `INSERT INTO settlement_exceptions(id, settlement_id, order_id, code, severity, detail, expected_rial, found_rial)
         VALUES ($1,$2,$3,'post_delivery_refund','blocking',$4,$5,$6)`,
        [randomUUID(), settlement.id, payable.child_order_id,
          `بازپرداخت ${amount.toString()} ریال پس از تأیید تسویه رخ داد — پرداخت تا رفع مغایرت مسدود است.`,
          net.toString(), newNet.toString()]);
      await audit(client, input.actorId, 'settlement.blocked', 'settlement', settlement.id, undefined,
        { reason: 'post_delivery_refund', payableId: payable.id, amountRial: amount.toString() });
    }
  }

  await audit(client, input.actorId, 'supplier_payable.adjusted', 'supplier_payable', payable.id,
    { netRial: net.toString() }, { netRial: newNet.toString(), refundRial: amount.toString(), reason: input.reason });
  return { status: 'applied', appliedTo: payable.status };
}

/* ============================================================================
 * §126-§127: read-only reconciliation diagnostic. Mismatch blocks generation.
 * ========================================================================== */
export async function reconciliationDiagnostic(db: DbPool | PoolClient, supplierId: string) {
  const buckets = await one<Record<string, string>>(db,
    `SELECT
       COALESCE(SUM(net_rial) FILTER (WHERE status IN ('held','blocked')), 0)::text AS held,
       COALESCE(SUM(net_rial) FILTER (WHERE status = 'eligible'), 0)::text AS eligible,
       COALESCE(SUM(net_rial) FILTER (WHERE status = 'scheduled'), 0)::text AS scheduled,
       COALESCE(SUM(net_rial) FILTER (WHERE status = 'settled'), 0)::text AS settled,
       COALESCE(SUM(gross_rial), 0)::text AS gross,
       COALESCE(SUM(commission_rial), 0)::text AS commission,
       COALESCE(SUM(shipping_share_rial), 0)::text AS shipping,
       COALESCE(SUM(refunds_rial), 0)::text AS refunds
     FROM supplier_child_payables WHERE supplier_id = $1`, [supplierId]);
  const recoveries = await one<{ open: string }>(db,
    `SELECT COALESCE(SUM(amount_rial - offset_rial) FILTER (WHERE status = 'open'), 0)::text AS open
       FROM supplier_recoveries WHERE supplier_id = $1`, [supplierId]);
  // New-model ledger scope: entries tied to payable children or scheduled settlements.
  const ledger = await one<{ balance: string }>(db,
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
       FROM supplier_ledger_entries e
      WHERE e.supplier_id = $1 AND (
        e.order_id IN (SELECT child_order_id FROM supplier_child_payables WHERE supplier_id = $1)
        OR e.settlement_id IN (SELECT id FROM settlements WHERE party_user_id = $1 AND kind = 'scheduled'))`,
    [supplierId]);
  const held = rial(buckets?.held ?? '0'); const eligible = rial(buckets?.eligible ?? '0');
  const scheduled = rial(buckets?.scheduled ?? '0');
  const openRecovery = rial(recoveries?.open ?? '0');
  const expectedOutstanding = held + eligible + scheduled - openRecovery;
  const ledgerOutstanding = rial(ledger?.balance ?? '0');
  const holds = await one<{ active: string; blocked: string }>(db,
    `SELECT COALESCE(SUM(amount_rial) FILTER (WHERE status = 'active'), 0)::text AS active,
            COALESCE(SUM(amount_rial) FILTER (WHERE status = 'blocked'), 0)::text AS blocked
       FROM settlement_holds WHERE supplier_id = $1`, [supplierId]);
  return {
    supplierId,
    ledgerOutstandingRial: ledgerOutstanding.toString(),
    expectedOutstandingRial: expectedOutstanding.toString(),
    heldRial: buckets?.held ?? '0', eligibleRial: buckets?.eligible ?? '0',
    scheduledRial: buckets?.scheduled ?? '0', settledRial: buckets?.settled ?? '0',
    grossRial: buckets?.gross ?? '0', commissionRial: buckets?.commission ?? '0',
    shippingRial: buckets?.shipping ?? '0', refundsRial: buckets?.refunds ?? '0',
    openRecoveryRial: openRecovery.toString(),
    activeHoldRial: holds?.active ?? '0', blockedHoldRial: holds?.blocked ?? '0',
    status: ledgerOutstanding === expectedOutstanding ? 'OK' : 'MISMATCH',
    differenceRial: (ledgerOutstanding - expectedOutstanding).toString(),
  };
}

/* ============================================================================
 * §37-§41, §122: scheduled settlement generation — groups, never pays.
 * ========================================================================== */
export async function runScheduledSettlements(pool: DbPool, input: {
  actorId: string | null; asOf?: Date; supplierId?: string; force?: boolean;
}): Promise<{ created: Array<{ settlementId: string; reference: string; supplierId: string; netRial: string; lines: number }>;
  skipped: Array<{ supplierId: string; reason: string }> }> {
  const asOf = input.asOf ?? new Date();
  return transaction(pool, async (client) => {
    const supplierRows = await client.query<{ supplier_id: string }>(
      `SELECT DISTINCT supplier_id FROM supplier_child_payables
        WHERE status = 'eligible' AND ($1::uuid IS NULL OR supplier_id = $1) ORDER BY supplier_id`,
      [input.supplierId ?? null]);
    const created: Array<{ settlementId: string; reference: string; supplierId: string; netRial: string; lines: number }> = [];
    const skipped: Array<{ supplierId: string; reason: string }> = [];

    for (const { supplier_id: supplierId } of supplierRows.rows) {
      const policy = await resolveSettlementPolicy(client, supplierId);
      if (!input.force && !isSettlementDueOn(policy, asOf)) { skipped.push({ supplierId, reason: 'NOT_DUE' }); continue; }

      // §133: restrictions block scheduling.
      const restricted = await one<{ count: string }>(client,
        `SELECT COUNT(*)::text AS count FROM supplier_restrictions
          WHERE user_id = $1 AND scope IN ('settlement_request', 'withdrawal') AND status = 'active'
            AND (expires_at IS NULL OR expires_at > now())`, [supplierId]);
      if (Number(restricted?.count ?? '0') > 0) { skipped.push({ supplierId, reason: 'SUPPLIER_RESTRICTED' }); continue; }

      // §126: serious ledger/projection mismatch blocks new settlements.
      const diagnostic = await reconciliationDiagnostic(client, supplierId);
      if (diagnostic.status !== 'OK') {
        skipped.push({ supplierId, reason: 'FINANCIAL_RECONCILIATION_REQUIRED' });
        await financeEvent(client, 'reconciliation.mismatch', 'supplier', supplierId,
          { supplierId, differenceRial: diagnostic.differenceRial });
        continue;
      }

      // §43: verified + cooldown-passed bank account required.
      const bank = await one<{ id: string; bank_name: string; iban: string; holder_name: string; status: string;
        settlement_enabled_at: Date | null }>(client,
        `SELECT id, bank_name, iban, holder_name, status, settlement_enabled_at FROM supplier_bank_accounts
          WHERE supplier_id = $1 AND status = 'verified'
            AND (settlement_enabled_at IS NULL OR settlement_enabled_at <= $2)
          ORDER BY is_primary DESC, verified_at DESC NULLS LAST LIMIT 1`, [supplierId, asOf]);
      if (policy.requires_verified_bank && !bank) { skipped.push({ supplierId, reason: 'BANK_ACCOUNT_UNVERIFIED' }); continue; }

      // Lock eligible payables (assigned-once: settlement_id IS NULL guard, §122).
      const payables = await client.query<{ id: string; reference: string; child_order_id: string; master_order_id: string | null;
        gross_rial: string; commission_rial: string; shipping_share_rial: string; refunds_rial: string;
        adjustments_rial: string; net_rial: string; quantity_snapshot: Array<Record<string, unknown>> }>(
        `SELECT id, reference, child_order_id, master_order_id, gross_rial::text, commission_rial::text,
                shipping_share_rial::text, refunds_rial::text, adjustments_rial::text, net_rial::text, quantity_snapshot
           FROM supplier_child_payables
          WHERE supplier_id = $1 AND status = 'eligible' AND settlement_id IS NULL
          ORDER BY created_at FOR UPDATE`, [supplierId]);
      if (!payables.rows.length) { skipped.push({ supplierId, reason: 'NO_ELIGIBLE_PAYABLES' }); continue; }

      let gross = 0n; let commission = 0n; let shipping = 0n; let returns = 0n; let adjustments = 0n; let net = 0n;
      for (const p of payables.rows) {
        gross += rial(p.gross_rial); commission += rial(p.commission_rial); shipping += rial(p.shipping_share_rial);
        returns += rial(p.refunds_rial); adjustments += rial(p.adjustments_rial); net += rial(p.net_rial);
      }

      // §92-§93: open recoveries offset the settlement before anything is paid.
      const recoveries = await client.query<{ id: string; reference: string; amount_rial: string; offset_rial: string }>(
        `SELECT id, reference, amount_rial::text, offset_rial::text FROM supplier_recoveries
          WHERE supplier_id = $1 AND status = 'open' ORDER BY created_at FOR UPDATE`, [supplierId]);
      let recoveryOffset = 0n;
      const recoveryPlan: Array<{ id: string; take: bigint }> = [];
      for (const recovery of recoveries.rows) {
        const remaining = rial(recovery.amount_rial) - rial(recovery.offset_rial);
        if (remaining <= 0n) continue;
        const take = remaining < (net - recoveryOffset) ? remaining : (net - recoveryOffset);
        if (take <= 0n) break;
        recoveryOffset += take;
        recoveryPlan.push({ id: recovery.id, take });
      }
      const settlementNet = net - recoveryOffset;
      if (settlementNet < rial(policy.minimum_settlement_rial)) { skipped.push({ supplierId, reason: 'BELOW_MINIMUM' }); continue; }
      if (settlementNet <= 0n) { skipped.push({ supplierId, reason: 'FULLY_OFFSET_BY_RECOVERY' }); continue; }

      const settlementId = randomUUID();
      const reference = await nextDocumentReference(client, 'settlement');
      const scheduledFor = input.force ? asOf : asOf;
      const bankSnapshot = bank ? { bankAccountId: bank.id, bankName: bank.bank_name, iban: bank.iban,
        holderName: bank.holder_name, snapshotAt: asOf.toISOString() } : {};
      await client.query(
        `INSERT INTO settlements(id, reference, party_user_id, direction, amount_rial, net_rial, gross_rial,
           commission_rial, shipping_rial, returns_rial, adjustments_rial, recovery_offset_rial, status,
           reconciliation_status, kind, scheduled_for, policy_id, policy_version, policy_snapshot,
           bank_account_id, bank_snapshot, created_by, note)
         VALUES ($1,$2,$3,'payable',$4,$4,$5,$6,$7,$8,$9,$10,'pending','expected','scheduled',$11,$12,$13,$14,$15,$16,$17,$18)`,
        [settlementId, reference, supplierId, settlementNet.toString(), gross.toString(), commission.toString(),
          shipping.toString(), returns.toString(), adjustments.toString(), recoveryOffset.toString(),
          scheduledFor, policy.id, policy.version,
          JSON.stringify({ policyId: policy.id, name: policy.name, scheduleType: policy.schedule_type,
            weeklyDay: policy.weekly_day, monthDays: policy.month_days, version: policy.version,
            minimumSettlementRial: policy.minimum_settlement_rial }),
          bank?.id ?? null, JSON.stringify(bankSnapshot), input.actorId,
          input.force ? 'ایجاد دستی توسط مالی' : 'ایجاد خودکار طبق زمان‌بندی تسویه']);

      for (const p of payables.rows) {
        const qty = (p.quantity_snapshot ?? []).reduce((sum, line) => sum + Number((line as { accepted?: number }).accepted ?? 0), 0);
        const childRef = await one<{ reference: string; product_name: string | null }>(client,
          `SELECT o.reference, (SELECT l.commercial_snapshot->>'productName' FROM child_order_lines l
             WHERE l.child_order_id = o.id LIMIT 1) AS product_name FROM orders o WHERE o.id = $1`, [p.child_order_id]);
        await client.query(
          `INSERT INTO settlement_lines(id, settlement_id, order_id, order_reference, product_name, quantity,
             gross_rial, commission_rial, shipping_rial, returns_rial, adjustments_rial, net_rial,
             child_order_id, master_order_id, payable_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [randomUUID(), settlementId, p.child_order_id, childRef?.reference ?? p.reference,
            childRef?.product_name ?? 'زیرسفارش عمده', qty, p.gross_rial, p.commission_rial,
            p.shipping_share_rial, p.refunds_rial, p.adjustments_rial, p.net_rial,
            p.child_order_id, p.master_order_id, p.id]);
        await client.query(
          `UPDATE supplier_child_payables SET status = 'scheduled', settlement_id = $2, updated_at = now() WHERE id = $1`,
          [p.id, settlementId]);
      }
      for (const plan of recoveryPlan) {
        await client.query(
          `UPDATE supplier_recoveries SET offset_rial = offset_rial + $2,
             status = CASE WHEN offset_rial + $2 >= amount_rial THEN 'offset' ELSE status END,
             closed_at = CASE WHEN offset_rial + $2 >= amount_rial THEN now() ELSE closed_at END
           WHERE id = $1`, [plan.id, plan.take.toString()]);
        await audit(client, input.actorId, 'supplier_recovery.offset', 'supplier_recovery', plan.id, undefined,
          { settlementId, offsetRial: plan.take.toString() });
      }
      await client.query(
        `INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note)
         VALUES ($1,$2,NULL,'pending',$3,$4)`,
        [randomUUID(), settlementId, input.actorId, `تسویه زمان‌بندی‌شده با ${payables.rows.length} زیرسفارش`]);
      await client.query(
        `INSERT INTO finance_approvals(id, subject_type, subject_id, amount_rial, status, requested_by, reason)
         VALUES ($1,'settlement',$2,$3,'requested',$4,'تسویه زمان‌بندی‌شده تأمین‌کننده')`,
        [randomUUID(), settlementId, settlementNet.toString(), input.actorId]);
      await audit(client, input.actorId, 'settlement.created', 'settlement', settlementId, undefined,
        { reference, kind: 'scheduled', supplierId, netRial: settlementNet.toString(),
          recoveryOffsetRial: recoveryOffset.toString(), lines: payables.rows.length });
      await financeEvent(client, 'settlement.scheduled', 'settlement', settlementId,
        { settlementId, reference, supplierId, netRial: settlementNet.toString(), scheduledFor: scheduledFor.toISOString() });
      created.push({ settlementId, reference, supplierId, netRial: settlementNet.toString(), lines: payables.rows.length });
    }
    return { created, skipped };
  });
}
