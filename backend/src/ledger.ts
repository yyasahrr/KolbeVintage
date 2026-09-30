/* Double-entry ledger helpers shared by every financial domain (items 145, 146,
 * 147, 160, 169, 171, 172).
 *
 * Rules enforced here:
 *   - every money movement becomes a balanced journal entry,
 *   - a closed/locked accounting period rejects new postings (corrections are
 *     recorded as adjustments or reversing entries instead of edits),
 *   - each entry carries analytic dimensions (supplier, channel, order, …),
 *   - supplier movements are mirrored into the supplier statement with a
 *     running balance, and the supplier financial account is refreshed in the
 *     same transaction,
 *   - business events are published through the outbox for automation.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { one } from './db.js';
import { conflict } from './errors.js';
import type { Principal } from './auth.js';

export const ACCOUNTS = {
  paymentClearing: '00000000-0000-4000-8000-000000000001',
  customerPrepayment: '00000000-0000-4000-8000-000000000002',
  receivable: '00000000-0000-4000-8000-000000000003',
  supplierPayable: '00000000-0000-4000-8000-000000000004',
  salesRevenue: '00000000-0000-4000-8000-000000000005',
  shippingIncome: '00000000-0000-4000-8000-000000000006',
  servicesIncome: '00000000-0000-4000-8000-000000000007',
  discountExpense: '00000000-0000-4000-8000-000000000008',
  taxPayable: '00000000-0000-4000-8000-000000000009',
  supplierCost: '00000000-0000-4000-8000-000000000010',
  walletLiability: '00000000-0000-4000-8000-000000000011',
  commission: '00000000-0000-4000-8000-000000000012',
  supplierAdvance: '00000000-0000-4000-8000-000000000013',
  shippingExpense: '00000000-0000-4000-8000-000000000014',
  refundPayable: '00000000-0000-4000-8000-000000000015',
  otherIncome: '00000000-0000-4000-8000-000000000016',
  penaltyIncome: '00000000-0000-4000-8000-000000000017',
} as const;

export type Dimensions = {
  supplierId?: string | null;
  channel?: 'retail' | 'wholesale' | 'vip' | null;
  warehouseId?: string | null;
  category?: string | null;
  orderId?: string | null;
  campaign?: string | null;
  paymentProvider?: string | null;
  shippingCarrier?: string | null;
};

export type JournalLineInput = {
  account: string;
  debit?: bigint;
  credit?: bigint;
  dimensions?: Dimensions;
};

/** The accounting period that covers a timestamp; created on demand, then locked when closed. */
export async function ensurePeriod(client: PoolClient, date: Date): Promise<string> {
  const code = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const startsOn = new Date(date.getFullYear(), date.getMonth(), 1);
  const endsOn = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const existing = await one<{ code: string; status: string }>(client,
    `INSERT INTO accounting_periods(code, title, starts_on, ends_on)
     VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO UPDATE SET title = accounting_periods.title
     RETURNING code, status`,
    [code, code, startsOn.toISOString().slice(0, 10), endsOn.toISOString().slice(0, 10)]);
  if (existing?.status !== 'open') throw conflict('دوره مالی بسته است؛ اصلاح باید با سند اصلاحی ثبت شود.');
  return code;
}

export async function assertPeriodOpen(client: PoolClient, code: string | null | undefined) {
  if (!code) return;
  const period = await one<{ status: string }>(client, 'SELECT status FROM accounting_periods WHERE code = $1', [code]);
  if (period && period.status !== 'open') throw conflict('دوره مالی بسته یا قفل است.');
}

/** Post one balanced journal entry. Returns the entry id. */
export async function postJournalEntry(client: PoolClient, input: {
  sourceType: string;
  sourceId: string;
  reference: string;
  lines: JournalLineInput[];
  memo?: string;
  dimensions?: Dimensions;
  occurredAt?: Date;
  createdBy?: string | null;
}): Promise<string> {
  const occurredAt = input.occurredAt ?? new Date();
  let debit = 0n; let credit = 0n;
  for (const line of input.lines) { debit += line.debit ?? 0n; credit += line.credit ?? 0n; }
  if (debit !== credit || debit === 0n) throw conflict('سند حسابداری متوازن نیست.');
  const period = await ensurePeriod(client, occurredAt);
  const entryId = randomUUID();
  await client.query(
    `INSERT INTO journal_entries(id, reference, source_type, source_id, period_code, memo, created_by, dimensions, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entryId, input.reference, input.sourceType, input.sourceId, period, input.memo ?? null,
      input.createdBy ?? null, JSON.stringify(input.dimensions ?? {}), occurredAt]);
  for (const line of input.lines) {
    await client.query(
      `INSERT INTO journal_lines(id, entry_id, account_id, debit_rial, credit_rial, dimensions, supplier_id, order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), entryId, line.account, (line.debit ?? 0n).toString(), (line.credit ?? 0n).toString(),
        JSON.stringify(line.dimensions ?? input.dimensions ?? {}),
        line.dimensions?.supplierId ?? input.dimensions?.supplierId ?? null,
        line.dimensions?.orderId ?? input.dimensions?.orderId ?? null]);
  }
  return entryId;
}

export type SupplierLedgerEvent =
  | 'order_sale' | 'commission' | 'discount_share' | 'shipping_charge' | 'return_cost' | 'refund'
  | 'adjustment_credit' | 'adjustment_debit' | 'penalty' | 'bonus' | 'tax' | 'withholding'
  | 'settlement' | 'withdrawal' | 'prepayment' | 'prepayment_applied';

/** Which account balances a supplier statement event on the other side of the payable. */
const COUNTERPART: Record<SupplierLedgerEvent, { account: string; side: 'expense' | 'income' }> = {
  order_sale: { account: ACCOUNTS.supplierCost, side: 'expense' },
  commission: { account: ACCOUNTS.commission, side: 'income' },
  discount_share: { account: ACCOUNTS.discountExpense, side: 'income' },
  shipping_charge: { account: ACCOUNTS.shippingExpense, side: 'income' },
  return_cost: { account: ACCOUNTS.supplierCost, side: 'income' },
  refund: { account: ACCOUNTS.refundPayable, side: 'income' },
  adjustment_credit: { account: ACCOUNTS.supplierCost, side: 'expense' },
  adjustment_debit: { account: ACCOUNTS.otherIncome, side: 'income' },
  penalty: { account: ACCOUNTS.penaltyIncome, side: 'income' },
  bonus: { account: ACCOUNTS.supplierCost, side: 'expense' },
  tax: { account: ACCOUNTS.taxPayable, side: 'income' },
  withholding: { account: ACCOUNTS.taxPayable, side: 'income' },
  settlement: { account: ACCOUNTS.paymentClearing, side: 'income' },
  withdrawal: { account: ACCOUNTS.walletLiability, side: 'income' },
  prepayment: { account: ACCOUNTS.supplierAdvance, side: 'income' },
  prepayment_applied: { account: ACCOUNTS.supplierAdvance, side: 'income' },
};

export type SupplierEntryInput = {
  event: SupplierLedgerEvent;
  amount: bigint;
  reference: string;
  description?: string;
  supplierId: string;
  orderId?: string | null;
  orderLineId?: string | null;
  invoiceId?: string | null;
  settlementId?: string | null;
  actorId?: string | null;
  occurredAt?: Date;
  dimensions?: Dimensions;
  sourceType?: string;
  sourceId?: string;
};

/** Credit adds to what Kolbe owes the supplier, debit reduces it. */
const creditEvents = new Set<SupplierLedgerEvent>(['order_sale', 'adjustment_credit', 'bonus', 'prepayment_applied']);

/** Advances move between the payable and the advance asset; they are not plain accruals. */
function advancePosting(event: SupplierLedgerEvent, amount: bigint) {
  if (event === 'prepayment') {
    return [
      { account: ACCOUNTS.supplierAdvance, debit: amount },
      { account: ACCOUNTS.paymentClearing, credit: amount },
    ];
  }
  if (event === 'prepayment_applied') {
    return [
      { account: ACCOUNTS.supplierPayable, debit: amount },
      { account: ACCOUNTS.supplierAdvance, credit: amount },
    ];
  }
  return null;
}

/**
 * Append supplier statement rows and their journal entries in one transaction.
 * The running balance on the supplier statement is always recomputed from the
 * rows themselves, so the statement and the financial account can never drift.
 */
export async function accrueSupplier(client: PoolClient, entries: SupplierEntryInput[]): Promise<Array<{ id: string; journalEntryId: string }>> {
  const created: Array<{ id: string; journalEntryId: string }> = [];
  for (const entry of entries) {
    if (entry.amount <= 0n) continue;
    const direction = creditEvents.has(entry.event) ? 'credit' : 'debit';
    const balance = await one<{ balance: string }>(client,
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
       FROM supplier_ledger_entries WHERE supplier_id = $1`, [entry.supplierId]);
    const previous = BigInt(balance?.balance ?? '0');
    const balanceAfter = direction === 'credit' ? previous + entry.amount : previous - entry.amount;
    const id = randomUUID();
    const counterpart = COUNTERPART[entry.event];
    const special = advancePosting(entry.event, entry.amount);
    const journalEntryId = await postJournalEntry(client, {
      sourceType: entry.sourceType ?? 'supplier_ledger',
      sourceId: entry.sourceId ?? id,
      reference: `JE-${entry.reference}-${entry.event}`,
      memo: entry.description ?? entry.event,
      dimensions: { ...entry.dimensions, supplierId: entry.supplierId, orderId: entry.orderId ?? null },
      occurredAt: entry.occurredAt,
      createdBy: entry.actorId ?? null,
      lines: special ?? (direction === 'credit'
        ? [
          { account: counterpart.account, debit: entry.amount },
          { account: ACCOUNTS.supplierPayable, credit: entry.amount },
        ]
        : [
          { account: ACCOUNTS.supplierPayable, debit: entry.amount },
          { account: counterpart.account, credit: entry.amount },
        ]),
    });
    await client.query(
      `INSERT INTO supplier_ledger_entries(id, supplier_id, occurred_at, event, direction, amount_rial,
         balance_after_rial, reference, description, order_id, order_line_id, invoice_id, settlement_id,
         journal_entry_id, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, entry.supplierId, entry.occurredAt ?? new Date(), entry.event, direction, entry.amount.toString(),
        balanceAfter.toString(), entry.reference, entry.description ?? null, entry.orderId ?? null,
        entry.orderLineId ?? null, entry.invoiceId ?? null, entry.settlementId ?? null, journalEntryId, entry.actorId ?? null]);
    await refreshSupplierAccount(client, entry.supplierId);
    created.push({ id, journalEntryId });
  }
  return created;
}

/** Recompute the supplier financial account (item 146/163) from immutable rows. */
export async function refreshSupplierAccount(client: PoolClient, supplierId: string) {
  const sums = await one<Record<string, string>>(client,
    `SELECT
       COALESCE(SUM(CASE WHEN event = 'order_sale' THEN amount_rial END), 0)::text AS gross,
       COALESCE(SUM(CASE WHEN event = 'commission' THEN amount_rial END), 0)::text AS commission,
       COALESCE(SUM(CASE WHEN event = 'discount_share' THEN amount_rial END), 0)::text AS discount_share,
       COALESCE(SUM(CASE WHEN event = 'shipping_charge' THEN amount_rial END), 0)::text AS shipping,
       COALESCE(SUM(CASE WHEN event = 'return_cost' THEN amount_rial END), 0)::text AS returns,
       COALESCE(SUM(CASE WHEN event = 'refund' THEN amount_rial END), 0)::text AS refunds,
       COALESCE(SUM(CASE WHEN event = 'adjustment_credit' THEN amount_rial ELSE 0 END)
              - SUM(CASE WHEN event = 'adjustment_debit' THEN amount_rial ELSE 0 END), 0)::text AS adjustments,
       COALESCE(SUM(CASE WHEN event = 'penalty' THEN amount_rial END), 0)::text AS penalties,
       COALESCE(SUM(CASE WHEN event = 'bonus' THEN amount_rial END), 0)::text AS bonuses,
       COALESCE(SUM(CASE WHEN event = 'tax' THEN amount_rial END), 0)::text AS taxes,
       COALESCE(SUM(CASE WHEN event = 'withholding' THEN amount_rial END), 0)::text AS withholding,
       COALESCE(SUM(CASE WHEN event = 'settlement' THEN amount_rial END), 0)::text AS settled,
       COALESCE(SUM(CASE WHEN event = 'withdrawal' THEN amount_rial END), 0)::text AS withdrawn,
       COALESCE(SUM(CASE WHEN event = 'prepayment' THEN amount_rial END), 0)::text AS prepayments,
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
     FROM supplier_ledger_entries WHERE supplier_id = $1`, [supplierId]);
  const blocked = await one<{ blocked: string }>(client,
    `SELECT COALESCE(SUM(COALESCE(expected_rial, found_rial, 0)), 0)::text AS blocked
     FROM settlement_exceptions e JOIN settlements s ON s.id = e.settlement_id
     WHERE s.party_user_id = $1 AND e.status = 'open' AND e.severity = 'blocking'`, [supplierId]);
  const gross = BigInt(sums?.gross ?? '0');
  const commission = BigInt(sums?.commission ?? '0');
  const returns = BigInt(sums?.returns ?? '0');
  const shipping = BigInt(sums?.shipping ?? '0');
  const penalties = BigInt(sums?.penalties ?? '0');
  const taxes = BigInt(sums?.taxes ?? '0');
  const withheld = BigInt(sums?.withholding ?? '0');
  const adjustments = BigInt(sums?.adjustments ?? '0');
  const balance = BigInt(sums?.balance ?? '0');
  const blockedAmount = BigInt(blocked?.blocked ?? '0');
  const available = balance - blockedAmount > 0n ? balance - blockedAmount : 0n;
  await client.query(
    `INSERT INTO supplier_finance_accounts(user_id, gross_sales_rial, net_sales_rial, commission_rial,
       discount_share_rial, shipping_charges_rial, return_costs_rial, refunds_rial, adjustments_rial,
       penalties_rial, bonuses_rial, taxes_rial, withholding_rial, pending_payable_rial,
       available_payable_rial, blocked_rial, settled_rial, withdrawn_rial, prepayments_rial, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
     ON CONFLICT (user_id) DO UPDATE SET
       gross_sales_rial = EXCLUDED.gross_sales_rial,
       net_sales_rial = EXCLUDED.net_sales_rial,
       commission_rial = EXCLUDED.commission_rial,
       discount_share_rial = EXCLUDED.discount_share_rial,
       shipping_charges_rial = EXCLUDED.shipping_charges_rial,
       return_costs_rial = EXCLUDED.return_costs_rial,
       refunds_rial = EXCLUDED.refunds_rial,
       adjustments_rial = EXCLUDED.adjustments_rial,
       penalties_rial = EXCLUDED.penalties_rial,
       bonuses_rial = EXCLUDED.bonuses_rial,
       taxes_rial = EXCLUDED.taxes_rial,
       withholding_rial = EXCLUDED.withholding_rial,
       pending_payable_rial = EXCLUDED.pending_payable_rial,
       available_payable_rial = EXCLUDED.available_payable_rial,
       blocked_rial = EXCLUDED.blocked_rial,
       settled_rial = EXCLUDED.settled_rial,
       withdrawn_rial = EXCLUDED.withdrawn_rial,
       prepayments_rial = EXCLUDED.prepayments_rial,
       updated_at = now()`,
    [supplierId, gross.toString(), (gross - commission - returns - shipping - penalties - taxes - withheld).toString(),
      commission.toString(), sums?.discount_share ?? '0', shipping.toString(), returns.toString(),
      sums?.refunds ?? '0', adjustments.toString(), penalties.toString(), sums?.bonuses ?? '0', taxes.toString(),
      withheld.toString(), balance.toString(), available.toString(), blockedAmount.toString(),
      sums?.settled ?? '0', sums?.withdrawn ?? '0', sums?.prepayments ?? '0']);
}

/** Business events for automation/n8n (item 171) — written to the outbox. */
export async function financeEvent(client: PoolClient, eventType: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>) {
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), eventType, aggregateType, aggregateId, JSON.stringify(payload)]);
}

export const financePermissions = (actor: Principal, permission: string) => actor.permissions.includes(permission) || actor.roles.includes('admin');
