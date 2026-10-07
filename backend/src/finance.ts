/* Financial Operations System (items 144-172).
 *
 * Design rules:
 *   - the double-entry ledger is the single source of truth (item 145),
 *   - every supplier movement is mirrored into an append-only statement with a
 *     running balance and into the supplier financial account (items 146/147/163),
 *   - settlement eligibility, commission, shipping allocation, returns and
 *     adjustments are computed server-side; nothing is accepted from the client
 *     (items 149-155),
 *   - sensitive money operations go through a Requested → Reviewed → Approved →
 *     Paid workflow (item 158) and are reconciled before being marked paid
 *     (item 159),
 *   - closed/locked accounting periods reject new postings (item 169).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial, signedRial } from './money.js';
import { audit } from './operations.js';
import { ApiError, badRequest, conflict, notFound } from './errors.js';
import { nextDocumentReference } from './references.js';
import { ensurePeriod, financeEvent, refreshSupplierAccount, accrueSupplier } from './ledger.js';
import { issueStatementDocument, type StatementLine } from './invoice-templates.js';
import { runReport, REPORT_CATALOG, exportReport, type ReportFormat } from './reports.js';
import { assertSupplierMay } from './supplier360.js';
import { supplierFinancePolicy } from './settlement-core.js';

const readPermission = 'payments:read';
const managePermission = 'finance:manage';

const dateRange = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

const rangeOf = (from?: string, to?: string) => {
  const end = to ? new Date(`${to}T23:59:59.999Z`) : new Date();
  const start = from ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - 30 * 86400_000);
  return { start, end };
};

/** Previous window of the same length, for “این ماه در برابر ماه گذشته” (item 164). */
const previousRange = (start: Date, end: Date) => {
  const span = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - span), end: new Date(start.getTime() - 1) };
};

export function registerFinanceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // ------------------------------------------------------------- dashboard --
  /** Prompt 4 (§40-§47): honest revenue-stream classification. Every number comes
   *  from a REAL canonical source; streams with no connected billing are reported
   *  as supported-but-disabled — nothing is fabricated. */
  app.get('/api/v1/admin/finance/revenue-streams', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = dateRange.parse(request.query ?? {});
    const { start, end } = rangeOf(query.from, query.to);
    const plans = await pool.query<{ v: string; c: number }>(
      `SELECT COALESCE(SUM(amount_rial), 0)::text AS v, COUNT(*)::int AS c
         FROM payment_intents WHERE status = 'succeeded' AND membership_id IS NOT NULL
          AND COALESCE(succeeded_at, created_at) BETWEEN $1 AND $2`, [start, end]);
    const commission = await pool.query<{ v: string; c: number }>(
      `SELECT COALESCE(SUM(commission_rial), 0)::text AS v, COUNT(*)::int AS c
         FROM supplier_child_payables WHERE created_at BETWEEN $1 AND $2 AND status <> 'cancelled'`, [start, end]);
    const fees = await pool.query<{ category: string; v: string; c: number }>(
      `SELECT category, COALESCE(SUM(amount_rial), 0)::text AS v, COUNT(*)::int AS c
         FROM financial_adjustments
        WHERE category IN ('storage', 'handling', 'qc', 'fulfillment') AND status = 'applied'
          AND created_at BETWEEN $1 AND $2 GROUP BY category`, [start, end]);
    const feeRow = (category: string, title: string) => {
      const found = fees.rows.find((r) => r.category === category);
      return { key: category, title, revenueRial: found?.v ?? '0', count: found?.c ?? 0,
        enabled: Boolean(found && found.v !== '0'), supported: true, costRial: null, costStatus: 'not_tracked' };
    };
    // Try-On: monetization table may not exist yet — report honestly either way.
    let tryon = { revenue: '0', count: 0, cost: null as string | null, connected: false };
    try {
      const t = await pool.query<{ v: string; c: number }>(
        `SELECT COALESCE(SUM(price_rial), 0)::text AS v, COUNT(*)::int AS c
           FROM tryon_credit_purchases WHERE status = 'paid' AND created_at BETWEEN $1 AND $2`, [start, end]);
      tryon = { revenue: t.rows[0]?.v ?? '0', count: t.rows[0]?.c ?? 0, cost: null, connected: true };
    } catch { /* table absent until Try-On monetization migration runs */ }
    return {
      range: { from: start.toISOString(), to: end.toISOString() },
      streams: [
        { key: 'vip_plans', title: 'پلن‌های عضویت VIP', revenueRial: plans.rows[0]?.v ?? '0',
          count: plans.rows[0]?.c ?? 0, enabled: true, supported: true, costRial: null, costStatus: 'not_tracked' },
        { key: 'marketplace_commission', title: 'کمیسیون Marketplace', revenueRial: commission.rows[0]?.v ?? '0',
          count: commission.rows[0]?.c ?? 0, enabled: true, supported: true, costRial: null, costStatus: 'not_tracked' },
        { key: 'tryon', title: 'سرویس پرو مجازی (Try-On)', revenueRial: tryon.revenue, count: tryon.count,
          enabled: tryon.connected, supported: true, costRial: tryon.cost,
          costStatus: tryon.connected ? 'unknown' : 'not_connected' },
        feeRow('storage', 'هزینه انبارداری'), feeRow('handling', 'هزینه هندلینگ'),
        feeRow('qc', 'هزینه کنترل کیفیت'), feeRow('fulfillment', 'هزینه پردازش سفارش'),
      ],
    };
  });

  app.get('/api/v1/admin/finance/summary', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = dateRange.extend({ compare: z.enum(['previous', 'none']).default('previous') }).parse(request.query);
    const { start, end } = rangeOf(query.from, query.to);
    const previous = previousRange(start, end);
    const snapshots = await pool.query<Record<string, string>>(
      `WITH win AS (SELECT $1::timestamptz AS s, $2::timestamptz AS e)
       SELECT
         COALESCE((SELECT SUM(jl.credit_rial - jl.debit_rial) FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id JOIN ledger_accounts la ON la.id = jl.account_id, win w
            WHERE la.account_type = 'revenue' AND je.created_at >= w.s AND je.created_at < w.e), 0)::text AS revenue,
         COALESCE((SELECT SUM(jl.debit_rial - jl.credit_rial) FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.entry_id JOIN ledger_accounts la ON la.id = jl.account_id, win w
            WHERE la.account_type = 'expense' AND je.created_at >= w.s AND je.created_at < w.e), 0)::text AS expense,
         COALESCE((SELECT SUM(amount_rial) FROM supplier_ledger_entries, win w
            WHERE event = 'settlement' AND occurred_at >= w.s AND occurred_at < w.e), 0)::text AS supplier_paid,
         COALESCE((SELECT SUM(amount_rial) FROM invoice_payments, win w
            WHERE created_at >= w.s AND created_at < w.e), 0)::text AS customer_received,
         COALESCE((SELECT SUM(paid_rial - total_rial) FROM invoices, win w
            WHERE status IN ('issued','partially_paid') AND created_at >= w.s AND created_at < w.e), 0)::text AS dummy,
         COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END) FROM supplier_ledger_entries), 0)::text AS payable_balance,
         COALESCE((SELECT SUM(total_rial - paid_rial) FROM invoices WHERE status IN ('issued','partially_paid')), 0)::text AS receivable_balance,
         COALESCE((SELECT COUNT(*) FROM settlements, win w WHERE created_at >= w.s AND created_at < w.e), 0)::text AS settlements_count,
         COALESCE((SELECT SUM(net_rial) FROM settlements, win w WHERE created_at >= w.s AND created_at < w.e AND status <> 'cancelled'), 0)::text AS settlements_net,
         COALESCE((SELECT COUNT(*) FROM supplier_restrictions WHERE status = 'active'), 0)::text AS active_restrictions,
         COALESCE((SELECT COUNT(*) FROM settlement_exceptions WHERE status = 'open'), 0)::text AS open_exceptions`,
      [start, end]);
    const current = snapshots.rows[0] ?? {};
    const older = query.compare === 'previous'
      ? (await pool.query<Record<string, string>>(
        `SELECT
           COALESCE((SELECT SUM(jl.credit_rial - jl.debit_rial) FROM journal_lines jl
               JOIN journal_entries je ON je.id = jl.entry_id JOIN ledger_accounts la ON la.id = jl.account_id
              WHERE la.account_type = 'revenue' AND je.created_at >= $1 AND je.created_at < $2), 0)::text AS revenue,
           COALESCE((SELECT SUM(jl.debit_rial - jl.credit_rial) FROM journal_lines jl
               JOIN journal_entries je ON je.id = jl.entry_id JOIN ledger_accounts la ON la.id = jl.account_id
              WHERE la.account_type = 'expense' AND je.created_at >= $1 AND je.created_at < $2), 0)::text AS expense`,
        [previous.start, previous.end])).rows[0] ?? {}
      : {};
    const entries = (Object.keys(current) as Array<keyof typeof current>).map((key) => [key, current[key] ?? '0'] as const);
    return {
      range: { from: start.toISOString(), to: end.toISOString() },
      metrics: Object.fromEntries(entries) as Record<string, string>,
      comparison: query.compare === 'previous'
        ? { from: previous.start.toISOString(), to: previous.end.toISOString(), metrics: older }
        : null,
    };
  });

  /** Analytics: series and breakdowns, always read from PostgreSQL (item 161). */
  app.get('/api/v1/admin/finance/analytics', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = dateRange.extend({
      dimension: z.enum(['channel', 'supplier', 'category', 'warehouse', 'campaign', 'provider', 'carrier', 'order', 'account']).default('channel'),
      bucket: z.enum(['day', 'week', 'month']).default('day'),
    }).parse(request.query);
    const { start, end } = rangeOf(query.from, query.to);
    const dimensions = {
      channel: "COALESCE(NULLIF(jl.dimensions->>'channel',''), 'retail')",
      supplier: "COALESCE(NULLIF(jl.dimensions->>'supplierId',''), 'none')",
      category: "COALESCE(NULLIF(jl.dimensions->>'category',''), 'other')",
      warehouse: "COALESCE(NULLIF(jl.dimensions->>'warehouseId',''), 'main')",
      campaign: "COALESCE(NULLIF(jl.dimensions->>'campaign',''), 'organic')",
      provider: "COALESCE(NULLIF(jl.dimensions->>'paymentProvider',''), 'other')",
      carrier: "COALESCE(NULLIF(jl.dimensions->>'shippingCarrier',''), 'other')",
      order: "COALESCE(NULLIF(jl.dimensions->>'orderId',''), 'none')",
      account: "la.code",
    } as const;
    const expression = dimensions[query.dimension];
    const series = await pool.query(
      `SELECT date_trunc($3, je.created_at) AS bucket,
              SUM(jl.credit_rial - jl.debit_rial)::text AS net_rial,
              SUM(CASE WHEN la.account_type = 'revenue' THEN jl.credit_rial - jl.debit_rial ELSE 0 END)::text AS revenue_rial,
              SUM(CASE WHEN la.account_type = 'expense' THEN jl.debit_rial - jl.credit_rial ELSE 0 END)::text AS expense_rial
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE je.created_at >= $1 AND je.created_at < $2
        GROUP BY 1 ORDER BY 1`, [start, end, query.bucket]);
    const breakdown = await pool.query(
      `SELECT ${expression} AS key,
              SUM(CASE WHEN la.account_type = 'revenue' THEN jl.credit_rial - jl.debit_rial ELSE 0 END)::text AS revenue_rial,
              SUM(CASE WHEN la.account_type = 'expense' THEN jl.debit_rial - jl.credit_rial ELSE 0 END)::text AS expense_rial,
              COUNT(DISTINCT je.id)::int AS entries
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE je.created_at >= $1 AND je.created_at < $2
        GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 50`, [start, end]);
    const labels = await pool.query<{ id: string; label: string }>(
      `SELECT u.id::text AS id, u.display_name AS label FROM users u
        WHERE u.id::text = ANY($1::text[])`, [breakdown.rows.map((row) => row.key)]);
    const labelOf = new Map(labels.rows.map((row) => [row.id, row.label]));
    return {
      dimension: query.dimension,
      bucket: query.bucket,
      range: { from: start.toISOString(), to: end.toISOString() },
      series: series.rows,
      breakdown: breakdown.rows.map((row) => ({ ...row, label: labelOf.get(row.key) ?? row.key })),
    };
  });

  /** Targets (item 165): stored per month in site settings, compared with actuals. */
  app.get('/api/v1/admin/finance/targets', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(request.query);
    const month = query.month ?? new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year!, mon! - 1, 1));
    const end = new Date(Date.UTC(year!, mon!, 1));
    const setting = await one<{ value: Record<string, string> }>(pool, "SELECT value FROM site_settings WHERE key = 'finance.targets'");
    const targetRevenue = rial(setting?.value?.[month] ?? '0');
    const actual = await one<{ revenue: string; orders: string }>(pool,
      `SELECT COALESCE(SUM(total_rial), 0)::text AS revenue, COUNT(*)::text AS orders
         FROM orders WHERE status NOT IN ('cancelled','pending_payment') AND created_at >= $1 AND created_at < $2`,
      [start, end]);
    const revenue = BigInt(actual?.revenue ?? '0');
    return {
      month,
      targetRial: asRial(targetRevenue),
      actualRial: asRial(revenue),
      achievementPercent: targetRevenue > 0n ? Number((revenue * 10000n) / targetRevenue) / 100 : null,
      orders: Number(actual?.orders ?? '0'),
    };
  });

  app.put('/api/v1/admin/finance/targets', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, managePermission);
    const body = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), targetRial: z.string().regex(/^\d+$/) }).parse(request.body);
    return transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO site_settings(key, value, updated_by, updated_at)
         VALUES ('finance.targets', jsonb_build_object($1::text, $2::text), $3, now())
         ON CONFLICT (key) DO UPDATE SET value = site_settings.value || jsonb_build_object($1::text, $2::text),
           updated_by = $3, updated_at = now()`, [body.month, body.targetRial, actor.id]);
      await audit(client, actor.id, 'finance.target_updated', 'site_setting', body.month, undefined, { month: body.month, targetRial: body.targetRial }, request.ip);
      return { month: body.month, targetRial: asRial(rial(body.targetRial)) };
    });
  });

  // ---------------------------------------------------------------- aging --
  app.get('/api/v1/admin/finance/aging', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    z.object({ side: z.enum(['payable', 'receivable']).default('payable') }).parse(request.query);
    const payables = await pool.query(
      `WITH running AS (
         SELECT supplier_id, occurred_at, amount_rial,
                SUM(amount_rial) OVER (PARTITION BY supplier_id ORDER BY occurred_at DESC, id DESC) AS credit_from_newest
           FROM supplier_ledger_entries WHERE direction = 'credit'
       ), outstanding AS (
         SELECT r.supplier_id, r.occurred_at,
                GREATEST(LEAST(r.amount_rial, COALESCE(b.balance, 0) - (r.credit_from_newest - r.amount_rial)), 0) AS unpaid_rial
           FROM running r JOIN (SELECT supplier_id, SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END) AS balance
                                  FROM supplier_ledger_entries GROUP BY supplier_id) b ON b.supplier_id = r.supplier_id
       )
       SELECT u.display_name AS party, o.supplier_id::text AS party_id,
              SUM(o.unpaid_rial)::text AS total_rial,
              SUM(CASE WHEN o.occurred_at + interval '30 days' >= now() THEN o.unpaid_rial ELSE 0 END)::text AS not_due,
              SUM(CASE WHEN o.occurred_at + interval '30 days' < now() AND o.occurred_at + interval '37 days' >= now() THEN o.unpaid_rial ELSE 0 END)::text AS days_1_7,
              SUM(CASE WHEN o.occurred_at + interval '37 days' < now() AND o.occurred_at + interval '60 days' >= now() THEN o.unpaid_rial ELSE 0 END)::text AS days_8_30,
              SUM(CASE WHEN o.occurred_at + interval '60 days' < now() AND o.occurred_at + interval '90 days' >= now() THEN o.unpaid_rial ELSE 0 END)::text AS days_31_60,
              SUM(CASE WHEN o.occurred_at + interval '90 days' < now() AND o.occurred_at + interval '120 days' >= now() THEN o.unpaid_rial ELSE 0 END)::text AS days_61_90,
              SUM(CASE WHEN o.occurred_at + interval '120 days' < now() THEN o.unpaid_rial ELSE 0 END)::text AS days_over_90
         FROM outstanding o JOIN users u ON u.id = o.supplier_id
        GROUP BY 1,2 HAVING SUM(o.unpaid_rial) <> 0 ORDER BY SUM(o.unpaid_rial) DESC LIMIT 200`);
    const receivables = await pool.query(
      `SELECT u.display_name AS party, i.buyer->>'userId' AS party_id, SUM(i.remaining_rial)::text AS total_rial,
              SUM(CASE WHEN i.due_date IS NULL OR i.due_date >= current_date THEN i.remaining_rial ELSE 0 END)::text AS not_due,
              SUM(CASE WHEN i.due_date < current_date AND i.due_date >= current_date - 7 THEN i.remaining_rial ELSE 0 END)::text AS days_1_7,
              SUM(CASE WHEN i.due_date < current_date - 7 AND i.due_date >= current_date - 30 THEN i.remaining_rial ELSE 0 END)::text AS days_8_30,
              SUM(CASE WHEN i.due_date < current_date - 30 AND i.due_date >= current_date - 60 THEN i.remaining_rial ELSE 0 END)::text AS days_31_60,
              SUM(CASE WHEN i.due_date < current_date - 60 AND i.due_date >= current_date - 90 THEN i.remaining_rial ELSE 0 END)::text AS days_61_90,
              SUM(CASE WHEN i.due_date < current_date - 90 THEN i.remaining_rial ELSE 0 END)::text AS days_over_90
         FROM invoices i LEFT JOIN users u ON u.id::text = i.buyer->>'userId'
        WHERE i.status IN ('issued','partially_paid') AND i.remaining_rial > 0
        GROUP BY 1,2 ORDER BY SUM(i.remaining_rial) DESC LIMIT 200`);
    const buckets = ['not_due', 'days_1_7', 'days_8_30', 'days_31_60', 'days_61_90', 'days_over_90'];
    const totals = (rows: Array<Record<string, unknown>>) => Object.fromEntries(buckets.map((bucket) =>
      [bucket, asRial(rows.reduce((sum, row) => sum + BigInt(String(row[bucket] ?? '0')), 0n))]));
    return {
      payable: { buckets: ['سررسیدنشده', '۱-۷ روز', '۸-۳۰ روز', '۳۱-۶۰ روز', '۶۱-۹۰ روز', 'بیش از ۹۰ روز'],
        items: payables.rows, totals: totals(payables.rows) },
      receivable: { buckets: ['سررسیدنشده', '۱-۷ روز', '۸-۳۰ روز', '۳۱-۶۰ روز', '۶۱-۹۰ روز', 'بیش از ۹۰ روز'],
        items: receivables.rows, totals: totals(receivables.rows) },
    };
  });

  // ----------------------------------------------------- supplier accounts --
  app.get('/api/v1/admin/finance/suppliers', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ search: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT a.user_id, u.display_name, u.phone, p.brand_name, p.commission_percent, p.activity_status,
              a.gross_sales_rial::text, a.commission_rial::text, a.shipping_charges_rial::text, a.return_costs_rial::text, a.refunds_rial::text,
              a.adjustments_rial::text, a.pending_payable_rial::text, a.available_payable_rial::text,
              a.blocked_rial::text, a.settled_rial::text, a.prepayments_rial::text, a.updated_at
         FROM supplier_finance_accounts a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN supplier_profiles p ON p.user_id = a.user_id
        WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR p.brand_name ILIKE '%' || $1 || '%')
        ORDER BY a.pending_payable_rial DESC LIMIT $2`, [query.search ?? null, query.limit]);
    return { items: rows.rows };
  });

  /** Statement with debit/credit/balance and drill-down links (items 147/163). */
  app.get('/api/v1/admin/finance/suppliers/:id/statement', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = dateRange.extend({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const { start, end } = rangeOf(query.from, query.to);
    const supplier = await one<{ display_name: string; phone: string | null; email: string | null }>(pool,
      'SELECT display_name, phone, email FROM users WHERE id = $1', [id]);
    if (!supplier) throw notFound();
    const account = await one<Record<string, string>>(pool, 'SELECT * FROM supplier_finance_accounts WHERE user_id = $1', [id]);
    const entries = await pool.query(
      `SELECT e.id, e.occurred_at, e.event, e.direction, e.amount_rial::text, e.balance_after_rial::text, e.reference,
              e.description, e.order_id, e.invoice_id, e.settlement_id, o.reference AS order_reference,
              i.reference AS invoice_reference, s.reference AS settlement_reference
         FROM supplier_ledger_entries e
         LEFT JOIN orders o ON o.id = e.order_id
         LEFT JOIN invoices i ON i.id = e.invoice_id
         LEFT JOIN settlements s ON s.id = e.settlement_id
        WHERE e.supplier_id = $1 AND e.occurred_at >= $2 AND e.occurred_at < $3
        ORDER BY e.occurred_at DESC, e.id DESC LIMIT $4`, [id, start, end, query.limit]);
    const opening = await one<{ balance: string }>(pool,
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_rial ELSE -amount_rial END), 0)::text AS balance
         FROM supplier_ledger_entries WHERE supplier_id = $1 AND occurred_at < $2`, [id, start]);
    const orders = await pool.query(
      `SELECT o.id, o.reference, o.status, o.updated_at, SUM(ol.line_total_rial)::text AS gross_rial,
              COUNT(ol.id)::int AS lines
         FROM order_lines ol JOIN orders o ON o.id = ol.order_id
        WHERE ol.supplier_id = $1 AND o.updated_at >= $2 AND o.updated_at < $3
        GROUP BY 1,2,3,4 ORDER BY o.updated_at DESC LIMIT 100`, [id, start, end]);
    // Prompt 4 (§87-§89): statement V2 position — canonical payable/settlement data,
    // same tables the supplier portal and settlement center read. No second engine.
    const position = await one<Record<string, string>>(pool,
      `SELECT
         COALESCE(SUM(net_rial) FILTER (WHERE status IN ('held','blocked')), 0)::text AS held,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'blocked'), 0)::text AS blocked,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'eligible'), 0)::text AS eligible,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'scheduled'), 0)::text AS scheduled,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'settled'), 0)::text AS settled
       FROM supplier_child_payables WHERE supplier_id = $1`, [id]);
    const recovery = await one<{ open: string }>(pool,
      `SELECT COALESCE(SUM(amount_rial - offset_rial) FILTER (WHERE status = 'open'), 0)::text AS open
         FROM supplier_recoveries WHERE supplier_id = $1`, [id]);
    const paidSettlements = await pool.query(
      `SELECT reference, net_rial::text AS net_rial, paid_reference, paid_at
         FROM settlements WHERE party_user_id = $1 AND kind = 'scheduled' AND status IN ('paid', 'reconciled')
          AND paid_at >= $2 AND paid_at < $3 ORDER BY paid_at DESC LIMIT 50`, [id, start, end]);
    return {
      supplier: { id, ...supplier },
      range: { from: start.toISOString(), to: end.toISOString() },
      openingBalanceRial: asRial(signedRial(opening?.balance ?? '0')),
      account,
      orders: orders.rows,
      entries: entries.rows,
      settlementPosition: {
        heldRial: position?.held ?? '0', blockedRial: position?.blocked ?? '0',
        eligibleRial: position?.eligible ?? '0', scheduledRial: position?.scheduled ?? '0',
        settledRial: position?.settled ?? '0', openRecoveryRial: recovery?.open ?? '0',
      },
      paidSettlements: paidSettlements.rows,
    };
  });

  // ---------------------------------------------------------- settlements --
  app.get('/api/v1/admin/finance/settlements', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ status: z.string().max(30).optional(), supplierId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT s.id, s.reference, s.status, s.reconciliation_status, s.gross_rial::text, s.commission_rial::text,
              s.shipping_rial::text, s.returns_rial::text, s.adjustments_rial::text, s.net_rial::text,
              s.created_at, s.approved_at, s.paid_at, s.party_user_id, u.display_name AS supplier_name,
              (SELECT count(*)::int FROM settlement_lines l WHERE l.settlement_id = s.id) AS line_count,
              (SELECT count(*)::int FROM settlement_exceptions e WHERE e.settlement_id = s.id AND e.status = 'open') AS open_exceptions
         FROM settlements s JOIN users u ON u.id = s.party_user_id
        WHERE ($1::text IS NULL OR s.status = $1) AND ($2::uuid IS NULL OR s.party_user_id = $2)
        ORDER BY s.created_at DESC LIMIT $3`, [query.status ?? null, query.supplierId ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/finance/settlements/:id', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const settlement = await one<Record<string, unknown>>(pool,
      `SELECT s.*, u.display_name AS supplier_name FROM settlements s JOIN users u ON u.id = s.party_user_id WHERE s.id = $1`, [id]);
    if (!settlement) throw notFound();
    const [lines, exceptions, events, approval] = await Promise.all([
      pool.query('SELECT * FROM settlement_lines WHERE settlement_id = $1 ORDER BY order_reference, product_name', [id]),
      pool.query('SELECT * FROM settlement_exceptions WHERE settlement_id = $1 ORDER BY created_at', [id]),
      pool.query(`SELECT e.*, u.display_name AS actor_name FROM settlement_events e LEFT JOIN users u ON u.id = e.actor_id
                   WHERE e.settlement_id = $1 ORDER BY e.created_at`, [id]),
      one<Record<string, unknown>>(pool,
        `SELECT a.*, r.display_name AS requested_by_name, v.display_name AS reviewed_by_name, p.display_name AS approved_by_name
           FROM finance_approvals a LEFT JOIN users r ON r.id = a.requested_by
           LEFT JOIN users v ON v.id = a.reviewed_by LEFT JOIN users p ON p.id = a.approved_by
          WHERE a.subject_type = 'settlement' AND a.subject_id = $1`, [id]),
    ]);
    return { ...settlement, lines: lines.rows, exceptions: exceptions.rows, events: events.rows, approval };
  });

  /** Build a settlement from delivered orders (items 149-153). */
  app.post('/api/v1/admin/finance/settlements', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, managePermission);
    const body = z.object({
      supplierId: z.uuid(),
      from: z.iso.date(),
      to: z.iso.date(),
      orderIds: z.array(z.uuid()).max(200).optional(),
      shippingRule: z.enum(['weight', 'quantity', 'value', 'volume', 'equal']).default('value'),
      deductShipping: z.boolean().default(true),
      adjustmentIds: z.array(z.uuid()).max(50).optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body);

    // Blocked settlement requests must be auditable, so the gate runs before the transaction.
    await assertSupplierMay(pool, body.supplierId, 'settlement_request', { resource: 'settlement', ip: request.ip });
    const created = await transaction(pool, async (client) => {
      const supplier = await one<{ brand_name: string; legal_name: string | null; bank_iban: string | null; commission_percent: string }>(client,
        `SELECT COALESCE(p.brand_name, u.display_name) AS brand_name, p.legal_name, p.bank_iban, COALESCE(p.commission_percent, 0)::text AS commission_percent
           FROM users u LEFT JOIN supplier_profiles p ON p.user_id = u.id WHERE u.id = $1`, [body.supplierId]);
      if (!supplier) throw notFound();
      const commissionPercent = Number(supplier.commission_percent);

      const lines = (await client.query<{ order_line_id: string; order_id: string; order_reference: string; product_name: string;
        quantity: number; line_total_rial: string; delivered_at: Date; order_subtotal: string; order_shipping: string;
        returned_rial: string; weight_grams: number | null; volume: string | null }>(
        `SELECT ol.id AS order_line_id, o.id AS order_id, o.reference AS order_reference, ol.product_name, ol.quantity,
                ol.line_total_rial::text,
                COALESCE((SELECT max(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'delivered'), o.updated_at) AS delivered_at,
                o.subtotal_rial::text AS order_subtotal, o.shipping_rial::text AS order_shipping,
                COALESCE((SELECT SUM(r.amount_rial) FROM return_requests r
                           WHERE r.order_line_id = ol.id AND r.status IN ('approved','received','refunded')), 0)::text AS returned_rial,
                ol.weight_grams,
                (SELECT v.attributes->>'volumeCm3' FROM product_variants v WHERE v.id = ol.variant_id) AS volume
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id
          WHERE ol.supplier_id = $1 AND o.status = 'delivered'
            AND o.updated_at >= $2 AND o.updated_at < $3::date + interval '1 day'
            AND ($4::uuid[] IS NULL OR o.id = ANY($4::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.order_line_id = ol.id)
          ORDER BY o.updated_at, ol.id`, [body.supplierId, body.from, body.to, body.orderIds ?? null])).rows;
      if (!lines.length) throw badRequest('سفارش تحویل‌شده و تسویه‌نشده‌ای در این بازه وجود ندارد.');

      const orders = new Map<string, { reference: string; subtotal: bigint; shipping: bigint }>();
      for (const line of lines) {
        const current = orders.get(line.order_id) ?? { reference: line.order_reference, subtotal: rial(line.order_subtotal), shipping: rial(line.order_shipping) };
        orders.set(line.order_id, current);
      }
      // Shipping allocation: each line carries its share of the order's shipping
      // cost under the chosen rule; the rule and the basis are stored as a
      // snapshot so the number stays explainable later (items 152-153).
      const allocationId = randomUUID();
      const orderScope = [...orders.keys()];
      const ruleBasis = (line: { quantity: number; line_total_rial: string; weight_grams: number | null; volume: string | null }) =>
        body.shippingRule === 'quantity' ? line.quantity
          : body.shippingRule === 'value' ? Number(line.line_total_rial)
            : body.shippingRule === 'weight' ? Number(line.weight_grams ?? 0)
              : body.shippingRule === 'volume' ? Number(line.volume ?? 0)
                : 1;
      const allOrderLines = (await client.query<{ order_id: string; id: string; quantity: number; line_total_rial: string;
        weight_grams: number | null; volume: string | null }>(
        `SELECT ol.order_id, ol.id, ol.quantity, ol.line_total_rial::text, ol.weight_grams,
                (v.attributes->>'volumeCm3') AS volume
           FROM order_lines ol JOIN product_variants v ON v.id = ol.variant_id
          WHERE ol.order_id = ANY($1::uuid[])`, [orderScope])).rows;
      const orderBasis = new Map<string, number>();
      const lineBasis = new Map<string, number>();
      for (const row of allOrderLines) {
        const basis = ruleBasis(row);
        lineBasis.set(row.id, basis);
        orderBasis.set(row.order_id, (orderBasis.get(row.order_id) ?? 0) + basis);
      }
      const shareOf = (line: { order_id: string; order_line_id: string }) => {
        const total = orderBasis.get(line.order_id) ?? 0;
        return total > 0 ? (lineBasis.get(line.order_line_id) ?? 0) / total : 0;
      };

      const reference = await nextDocumentReference(client, 'settlement');
      let gross = 0n; let commission = 0n; let shipping = 0n; let returns = 0n; let adjustments = 0n;
      const entries: Array<{ event: 'order_sale' | 'commission' | 'shipping_charge' | 'return_cost'
        | 'adjustment_credit' | 'adjustment_debit'; amount: bigint; reference: string; description: string;
        orderId: string; orderLineId: string }> = [];
      const lineRows: Array<Record<string, string | number | null>> = [];
      const exceptions: Array<{ code: string; severity: string; detail: string; expected?: bigint; found?: bigint; orderId: string; orderLineId: string }> = [];

      for (const [index, line] of lines.entries()) {
        const lineGross = rial(line.line_total_rial);
        const lineReturned = rial(line.returned_rial);
        const commissionRate = commissionPercent / 100;
        const lineCommission = BigInt(Math.round(Number(lineGross) * commissionRate));
        const order = orders.get(line.order_id)!;
        const share = shareOf(line);
        const lineShipping = body.deductShipping ? BigInt(Math.round(Number(order.shipping) * share)) : 0n;
        const net = lineGross - lineCommission - lineReturned - lineShipping;
        gross += lineGross; commission += lineCommission; shipping += lineShipping; returns += lineReturned;
        const suffix = `${reference}-L${index + 1}`;
        entries.push({ event: 'order_sale', amount: lineGross, reference: suffix, description: `${line.product_name} — ${line.order_reference}`, orderId: line.order_id, orderLineId: line.order_line_id });
        if (lineCommission > 0n) entries.push({ event: 'commission', amount: lineCommission, reference: suffix, description: `کارمزد ${commissionPercent}٪ — ${line.order_reference}`, orderId: line.order_id, orderLineId: line.order_line_id });
        if (lineShipping > 0n) entries.push({ event: 'shipping_charge', amount: lineShipping, reference: suffix, description: `سهم ارسال (${body.shippingRule}) — ${line.order_reference}`, orderId: line.order_id, orderLineId: line.order_line_id });
        if (lineReturned > 0n) entries.push({ event: 'return_cost', amount: lineReturned, reference: suffix, description: `مرجوعی — ${line.order_reference}`, orderId: line.order_id, orderLineId: line.order_line_id });
        if (lineReturned > 0n) exceptions.push({ code: 'returned_quantity', severity: 'warning',
          detail: `برای «${line.product_name}» مرجوعی ثبت شده است.`, expected: lineGross, found: lineReturned, orderId: line.order_id, orderLineId: line.order_line_id });
        if (commissionPercent === 0) exceptions.push({ code: 'commission_mismatch', severity: 'warning',
          detail: 'نرخ کارمزد برای این تأمین‌کننده صفر است؛ قرارداد کارمزد را بررسی کنید.', orderId: line.order_id, orderLineId: line.order_line_id });
        lineRows.push({ orderId: line.order_id, orderReference: line.order_reference, orderLineId: line.order_line_id,
          productName: line.product_name, quantity: line.quantity, deliveredAt: line.delivered_at ? line.delivered_at.toISOString() : null,
          gross: lineGross.toString(), commission: lineCommission.toString(), shipping: lineShipping.toString(),
          returns: lineReturned.toString(), adjustments: '0', net: net.toString() });
      }

      // Approved, not-yet-applied adjustments for this supplier join the settlement (item 157).
      let appliedAdjustments: Array<{ id: string; reference: string; direction: string; amount_rial: string; category: string }> = [];
      if (body.adjustmentIds?.length) {
        const found = await client.query<{ id: string; reference: string; direction: string; amount_rial: string; category: string }>(
          `SELECT id, reference, direction, amount_rial::text, category FROM financial_adjustments
            WHERE supplier_id = $1 AND status = 'approved' AND id = ANY($2::uuid[]) FOR UPDATE`, [body.supplierId, body.adjustmentIds]);
        if (found.rows.length !== body.adjustmentIds.length) throw conflict('برخی اصلاحات انتخابی تأییدنشده یا نامعتبرند.');
        appliedAdjustments = found.rows;
      }
      for (const adjustment of appliedAdjustments) {
        const amount = rial(adjustment.amount_rial);
        adjustments += adjustment.direction === 'credit' ? amount : -amount;
        entries.push({ event: adjustment.direction === 'credit' ? 'adjustment_credit' : 'adjustment_debit', amount,
          reference: adjustment.reference, description: `اصلاح ${adjustment.category}`, orderId: lines[0]!.order_id, orderLineId: lines[0]!.order_line_id });
      }

      const net = gross - commission - shipping - returns + adjustments;
      const settlementId = randomUUID();
      const deductions = { gross, commission, shipping, returns, adjustments };
      if (net <= 0n) throw conflict(`مانده تسویه محاسبه‌شده (${net.toString()} ریال) مثبت نیست؛ ابتدا اصلاحات را بررسی کنید.`);
      const periodCode = await ensurePeriod(client, new Date());
      await client.query(
        `INSERT INTO settlements(id, reference, party_user_id, direction, amount_rial, net_rial, gross_rial, commission_rial,
           shipping_rial, returns_rial, adjustments_rial, status, reconciliation_status, period_code, note, created_by)
         VALUES ($1,$2,$3,'payable',$4,$4,$5,$6,$7,$8,$9,'pending','expected',$10,$11,$12)`,
        [settlementId, reference, body.supplierId, net.toString(), deductions.gross.toString(), deductions.commission.toString(),
          deductions.shipping.toString(), deductions.returns.toString(), deductions.adjustments.toString(), periodCode, body.note ?? null, actor.id]);
      for (const line of lineRows) {
        await client.query(
          `INSERT INTO settlement_lines(id, settlement_id, order_id, order_reference, order_line_id, product_name, quantity,
             delivered_at, gross_rial, commission_rial, shipping_rial, returns_rial, adjustments_rial, net_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [randomUUID(), settlementId, line.orderId, line.orderReference, line.orderLineId, line.productName, line.quantity,
            line.deliveredAt, line.gross, line.commission, line.shipping, line.returns, line.adjustments, line.net]);
      }
      // Weight snapshot for the shipping allocation (item 153 rule snapshot).
      const allocationLines: Array<{ supplierId: string; orderId: string; orderLineId: string; basis: number; amount: bigint }> = [];
      for (const line of lines) {
        const order = orders.get(line.order_id)!;
        const share = shareOf(line);
        allocationLines.push({ supplierId: body.supplierId, orderId: line.order_id, orderLineId: line.order_line_id,
          basis: Number((Number(line.line_total_rial) * 0).toFixed(0)) + Math.round(Number(line.line_total_rial)), amount: body.deductShipping ? BigInt(Math.round(Number(order.shipping) * share)) : 0n });
      }
      if (allocationLines.some((line) => line.amount > 0n)) {
        await client.query(
          `INSERT INTO shipping_allocations(id, reference, order_id, total_cost_rial, rule, snapshot, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [allocationId, `SHA-${reference}`, lines[0]!.order_id,
            lines.reduce((sum, line) => sum + orders.get(line.order_id)!.shipping, 0n).toString(),
            body.shippingRule, JSON.stringify({ rule: body.shippingRule, orderCount: orders.size, lineCount: lines.length, basis: [...orderBasis.entries()] }), actor.id]);
        for (const line of allocationLines) {
          await client.query(
            `INSERT INTO shipping_allocation_lines(id, allocation_id, supplier_id, order_id, order_line_id, basis_value, amount_rial)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [randomUUID(), allocationId, line.supplierId, line.orderId, line.orderLineId, line.basis, line.amount.toString()]);
        }
      }
      for (const exception of exceptions) {
        await client.query(
          `INSERT INTO settlement_exceptions(id, settlement_id, order_id, order_line_id, code, severity, detail, expected_rial, found_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [randomUUID(), settlementId, exception.orderId, exception.orderLineId, exception.code, exception.severity,
            exception.detail, exception.expected?.toString() ?? null, exception.found?.toString() ?? null]);
      }
      for (const adjustment of appliedAdjustments) {
        await client.query("UPDATE financial_adjustments SET status = 'applied', applied_at = now() WHERE id = $1", [adjustment.id]);
      }
      await accrueSupplier(client, entries.map((entry) => ({ ...entry, supplierId: body.supplierId, settlementId, actorId: actor.id })));
      // Traceability (item 154): each settlement line points at the journal entry of its accrual,
      // so «ردیف تسویه → دفتر تأمین‌کننده → سند حسابداری» is walkable without guessing.
      await client.query(
        `UPDATE settlement_lines sl
            SET journal_entry_id = src.journal_entry_id
           FROM (SELECT DISTINCT ON (order_line_id) order_line_id, journal_entry_id
                   FROM supplier_ledger_entries
                  WHERE settlement_id = $1 AND order_line_id IS NOT NULL AND journal_entry_id IS NOT NULL
                  ORDER BY order_line_id, occurred_at, created_at) src
          WHERE sl.settlement_id = $1 AND sl.order_line_id = src.order_line_id`, [settlementId]);
      await client.query(
        `INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note) VALUES ($1,$2,NULL,'pending',$3,$4)`,
        [randomUUID(), settlementId, actor.id, `ایجاد خودکار از ${lines.length} سطر سفارش`]);
      await client.query(
        `INSERT INTO finance_approvals(id, subject_type, subject_id, amount_rial, status, requested_by, reason)
         VALUES ($1,'settlement',$2,$3,'requested',$4,$5)`,
        [randomUUID(), settlementId, net.toString(), actor.id, body.note ?? 'درخواست تسویه']);
      await financeEvent(client, 'settlement.created', 'settlement', settlementId,
        { reference, supplierId: body.supplierId, netRial: net.toString(), orders: orders.size, lines: lines.length });
      await audit(client, actor.id, 'settlement.created', 'settlement', settlementId, undefined,
        { reference, netRial: net.toString(), lines: lines.length }, request.ip);
      return { id: settlementId, reference, netRial: asRial(net), grossRial: asRial(gross), commissionRial: asRial(commission),
        shippingRial: asRial(shipping), returnsRial: asRial(returns), adjustmentsRial: asRial(adjustments),
        lines: lines.length, orders: orders.size, openExceptions: exceptions.length };
    });
    return reply.code(201).send(created);
  });

  /** Requested → Reviewed → Approved → Paid for every sensitive operation (item 158). */
  app.post('/api/v1/admin/finance/approvals/:id/:action', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(['review', 'approve', 'reject', 'mark-paid']) }).parse(request.params);
    const body = z.object({ note: z.string().trim().max(500).optional(), reason: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const approval = await one<{ id: string; subject_type: string; subject_id: string; status: string; amount_rial: string; requested_by: string | null }>(client,
        'SELECT * FROM finance_approvals WHERE id = $1 FOR UPDATE', [id]);
      if (!approval) throw notFound();
      const flow: Record<string, { from: string[]; to: string }> = {
        review: { from: ['requested'], to: 'reviewed' },
        approve: { from: ['requested', 'reviewed'], to: 'approved' },
        reject: { from: ['requested', 'reviewed', 'approved'], to: 'rejected' },
        'mark-paid': { from: ['approved'], to: 'paid' },
      };
      const transition = flow[action]!;
      if (!transition.from.includes(approval.status)) throw conflict(`انتقال از وضعیت ${approval.status} به این مرحله مجاز نیست.`);
      if (approval.requested_by === actor.id && (action === 'approve' || action === 'review')) {
        throw conflict('تأیید دو‌مرحله‌ای: تأییدکننده باید شخص دیگری باشد.');
      }
      // Prompt 3 (§46, §49, §57): scheduled supplier settlements re-verify the
      // destination bank account at approval time and enforce dual control.
      if (approval.subject_type === 'settlement' && action === 'approve') {
        const scheduled = await one<{ id: string; kind: string; bank_account_id: string | null; created_by: string | null; net_rial: string }>(client,
          'SELECT id, kind, bank_account_id, created_by, net_rial::text FROM settlements WHERE id = $1', [approval.subject_id]);
        if (scheduled?.kind === 'scheduled') {
          if (!scheduled.bank_account_id) {
            throw new ApiError(409, 'BANK_ACCOUNT_UNVERIFIED', 'این تسویه حساب بانکی تأییدشده ندارد.');
          }
          const bank = await one<{ status: string; settlement_enabled_at: Date | null }>(client,
            'SELECT status, settlement_enabled_at FROM supplier_bank_accounts WHERE id = $1', [scheduled.bank_account_id]);
          if (!bank || bank.status !== 'verified') {
            throw new ApiError(409, 'BANK_ACCOUNT_UNVERIFIED', 'حساب بانکی مقصد دیگر تأییدشده نیست — تسویه قابل تأیید نیست.');
          }
          if (bank.settlement_enabled_at && bank.settlement_enabled_at > new Date()) {
            throw new ApiError(409, 'BANK_ACCOUNT_COOLDOWN', 'حساب بانکی مقصد در دوره انتظار امنیتی است.');
          }
          const financePolicy = await supplierFinancePolicy(client);
          if (rial(scheduled.net_rial) > rial(financePolicy.dualControlThresholdRial) && scheduled.created_by === actor.id) {
            throw conflict('کنترل دوگانه: برای مبالغ بالا، تأییدکننده باید غیر از ایجادکننده تسویه باشد.');
          }
        }
      }
      const column = action === 'review' ? 'reviewed_by' : action === 'approve' ? 'approved_by' : action === 'reject' ? 'rejected_by' : null;
      await client.query(
        `UPDATE finance_approvals SET status = $2, updated_at = now()${column ? `, ${column} = $3` : ''} WHERE id = $1`,
        column ? [id, transition.to, actor.id] : [id, transition.to]);
      await client.query(
        `INSERT INTO finance_approval_events(id, approval_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), id, approval.status, transition.to, actor.id, body.note ?? body.reason ?? null]);
      if (approval.subject_type === 'settlement') {
        if (action === 'review' || action === 'approve') {
          const target = action === 'approve' ? 'approved' : 'processing';
          const set = action === 'approve' ? ", approved_by = $3, approved_at = now()" : '';
          await client.query(`UPDATE settlements SET status = $2${set} WHERE id = $1 AND status IN ('pending','processing')`,
            action === 'approve' ? [approval.subject_id, target, actor.id] : [approval.subject_id, target]);
        }
        if (action === 'reject') {
          await client.query("UPDATE settlements SET status = 'cancelled' WHERE id = $1 AND status IN ('pending','processing','approved')", [approval.subject_id]);
        }
        await client.query(
          `INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), approval.subject_id, approval.status, transition.to, actor.id, body.note ?? body.reason ?? null]);
        await financeEvent(client, action === 'reject' ? 'settlement.rejected' : action === 'approve' ? 'settlement.approved' : 'settlement.reviewed',
          'settlement', approval.subject_id, { approvalId: id, actorId: actor.id });
      }
      await audit(client, actor.id, `finance_approval.${action}`, approval.subject_type, approval.subject_id,
        { status: approval.status }, { status: transition.to, note: body.note ?? body.reason ?? null }, request.ip);
      return { id, status: transition.to };
    });
  });

  /** Payment execution + reconciliation (items 155, 159): paid → reconciled | mismatch. */
  app.post('/api/v1/admin/finance/settlements/:id/pay', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      method: z.enum(['transfer', 'card', 'cash', 'cheque', 'wallet', 'gateway', 'other']).default('transfer'),
      reference: z.string().trim().min(2).max(120),
      paidAt: z.iso.datetime().optional(),
      note: z.string().trim().max(500).optional(),
      // Prompt 3 (§52): manual transfer evidence for scheduled settlements.
      paidAmountRial: z.string().regex(/^\d+$/).optional(),
      sourceBank: z.string().trim().max(120).optional(),
    }).parse(request.body);
    return transaction(pool, async (client) => {
      const settlement = await one<{ id: string; reference: string; party_user_id: string; net_rial: string; status: string;
        reconciliation_status: string; period_code: string | null; kind: string; bank_account_id: string | null;
        bank_snapshot: { iban?: string } }>(client,
        'SELECT id, reference, party_user_id, net_rial::text, status, reconciliation_status, period_code, kind, bank_account_id, bank_snapshot FROM settlements WHERE id = $1 FOR UPDATE', [id]);
      if (!settlement) throw notFound();
      if (settlement.status === 'paid' || settlement.status === 'reconciled') {
        throw new ApiError(409, 'SETTLEMENT_ALREADY_PAID', 'این تسویه قبلاً پرداخت و نهایی شده است.');
      }
      if (settlement.status !== 'approved') throw conflict('پرداخت تنها پس از تأیید مدیر مالی مجاز است.');
      if (settlement.kind === 'scheduled') {
        // §48/§52: transfer only to the frozen verified snapshot + evidence checks.
        if (!settlement.bank_snapshot?.iban || !settlement.bank_account_id) {
          throw new ApiError(409, 'BANK_ACCOUNT_UNVERIFIED', 'این تسویه snapshot حساب بانکی تأییدشده ندارد.');
        }
        const bank = await one<{ status: string }>(client,
          'SELECT status FROM supplier_bank_accounts WHERE id = $1', [settlement.bank_account_id]);
        if (!bank || bank.status !== 'verified') {
          throw new ApiError(409, 'BANK_ACCOUNT_UNVERIFIED', 'حساب بانکی مقصد دیگر تأییدشده نیست — ثبت پرداخت مسدود است.');
        }
        if (!body.paidAmountRial) throw badRequest('مبلغ واقعی واریز برای تسویه زمان\u200cبندی\u200cشده الزامی است.');
        if (rial(body.paidAmountRial) !== rial(settlement.net_rial)) {
          throw new ApiError(409, 'SETTLEMENT_AMOUNT_CHANGED',
            'مبلغ واریز با خالص تسویه برابر نیست — در صورت تغییر مبلغ، تسویه باید بازبینی شود.');
        }
        // §54: one bank tracking reference closes at most one settlement.
        const duplicate = await one<{ id: string }>(client,
          "SELECT id FROM settlements WHERE kind = 'scheduled' AND paid_reference = $1 AND id <> $2", [body.reference, id]);
        if (duplicate) throw conflict('این کد پیگیری بانکی قبلاً برای تسویه دیگری ثبت شده است.');
      }
      const blocking = await one<{ count: string }>(client,
        "SELECT COUNT(*)::text AS count FROM settlement_exceptions WHERE settlement_id = $1 AND status = 'open' AND severity = 'blocking'", [id]);
      if (Number(blocking?.count ?? '0') > 0) throw conflict('مغایرت بازدارنده حل نشده است.');
      const amount = rial(settlement.net_rial);
      const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
      // The payable settlement postings come from the supplier ledger entry itself,
      // so the statement row and the journal entry can never drift apart (Değil: item 151).
      const [accrual] = await accrueSupplier(client, [{
        event: 'settlement', amount, reference: settlement.reference,
        description: `پرداخت تسویه (${body.reference})`, supplierId: settlement.party_user_id,
        settlementId: settlement.id, actorId: actor.id, occurredAt: paidAt,
        dimensions: { paymentProvider: body.method },
        sourceType: 'settlement_payment', sourceId: settlement.id,
      }]);
      const entryId = accrual!.journalEntryId;
      await client.query(
        `UPDATE settlements SET status = 'paid', reconciliation_status = 'paid', paid_at = $2, paid_reference = $3,
           paid_amount_rial = $4, paid_by = $5, source_bank = $6, paid_note = $7 WHERE id = $1`,
        [id, paidAt, body.reference, body.paidAmountRial ?? settlement.net_rial, actor.id,
          body.sourceBank ?? null, body.note ?? null]);
      if (settlement.kind === 'scheduled') {
        // §41: payables settle exactly with their settlement — immutable afterwards.
        await client.query(
          `UPDATE supplier_child_payables SET status = 'settled', settled_at = $2, updated_at = now()
            WHERE settlement_id = $1 AND status = 'scheduled'`, [id, paidAt]);
      }
      await client.query(
        `INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,'paid',$4,$5)`,
        [randomUUID(), id, settlement.status, actor.id, `پرداخت با روش ${body.method} — ${body.reference}`]);
      await client.query(`UPDATE finance_approvals SET status = 'paid', updated_at = now() WHERE subject_type = 'settlement' AND subject_id = $1`, [id]);
      // Settlement completed → supplier statement document (item 34).
      const ledger = await client.query<{ occurred_at: Date; event: string; direction: string; amount_rial: string;
        balance_after_rial: string; reference: string; description: string | null }>(
        `SELECT occurred_at, event, direction, amount_rial::text, balance_after_rial::text, reference, description
           FROM supplier_ledger_entries WHERE settlement_id = $1 ORDER BY occurred_at, id`, [id]);
      const supplier = await one<{ display_name: string; phone: string | null; email: string | null }>(client,
        'SELECT display_name, phone, email FROM users WHERE id = $1', [settlement.party_user_id]);
      const statementLines: StatementLine[] = ledger.rows.map((row) => ({
        occurredAt: row.occurred_at, event: row.event, description: row.description ?? '',
        debit: row.direction === 'debit' ? BigInt(row.amount_rial) : 0n,
        credit: row.direction === 'credit' ? BigInt(row.amount_rial) : 0n,
        balance: BigInt(row.balance_after_rial), reference: row.reference,
      }));
      if (supplier?.display_name) {
        const statement = await issueStatementDocument(client, {
          kind: 'settlement', supplierId: settlement.party_user_id,
          supplier: { name: supplier.display_name, legalName: supplier.display_name, phone: supplier.phone ?? '', email: supplier.email ?? '' },
          lines: statementLines, title: `سند تسویه ${settlement.reference}`,
          periodFrom: paidAt, periodTo: paidAt, actorId: actor.id,
          note: `سند تسویه ${settlement.reference} — پرداخت ${body.reference}`,
        });
        await client.query('UPDATE settlements SET statement_invoice_id = $2 WHERE id = $1', [id, statement.id]);
      }
      await financeEvent(client, 'payment.completed', 'settlement', id, {
        reference: settlement.reference, amountRial: amount.toString(), method: body.method, journalEntryId: entryId });
      await financeEvent(client, 'settlement.completed', 'settlement', id, { reference: settlement.reference, amountRial: amount.toString() });
      await audit(client, actor.id, 'settlement.paid', 'settlement', id, { status: settlement.status },
        { status: 'paid', reference: body.reference, method: body.method }, request.ip);
      return { id, status: 'paid', reconciliationStatus: 'paid', amountRial: asRial(amount), journalEntryId: entryId };
    });
  });

  app.post('/api/v1/admin/finance/settlements/:id/reconcile', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ actualRial: z.string().regex(/^\d+$/), note: z.string().trim().max(500).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const settlement = await one<{ id: string; reference: string; net_rial: string; status: string; party_user_id: string }>(client,
        'SELECT id, reference, net_rial::text, status, party_user_id FROM settlements WHERE id = $1 FOR UPDATE', [id]);
      if (!settlement) throw notFound();
      if (settlement.status !== 'paid') throw conflict('مغایرت‌یابی تنها پس از پرداخت انجام می‌شود.');
      const expected = rial(settlement.net_rial);
      const actual = rial(body.actualRial);
      const withinTolerance = expected > actual ? expected - actual <= 1000n : actual - expected <= 1000n;
      if (withinTolerance) {
        await client.query("UPDATE settlements SET status = 'reconciled', reconciliation_status = 'reconciled' WHERE id = $1", [id]);
        await client.query(`INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note) VALUES ($1,$2,'paid','reconciled',$3,$4)`,
          [randomUUID(), id, actor.id, body.note ?? 'تطبیق کامل با صورتحساب بانکی']);
        await financeEvent(client, 'settlement.reconciled', 'settlement', id, { reference: settlement.reference, expectedRial: expected.toString(), actualRial: actual.toString() });
        return { id, reconciliationStatus: 'reconciled', expectedRial: asRial(expected), actualRial: asRial(actual) };
      }
      const exceptionId = randomUUID();
      await client.query(
        `INSERT INTO settlement_exceptions(id, settlement_id, code, severity, detail, expected_rial, found_rial)
         VALUES ($1,$2,'payment_dispute','blocking',$3,$4,$5)`,
        [exceptionId, id, body.note ?? 'اختلاف بین مبلغ تسویه و پرداخت بانکی', expected.toString(), actual.toString()]);
      await client.query("UPDATE settlements SET reconciliation_status = 'mismatch' WHERE id = $1", [id]);
      await financeEvent(client, 'settlement.mismatch', 'settlement', id, { reference: settlement.reference, expectedRial: expected.toString(), actualRial: actual.toString() });
      await audit(client, actor.id, 'settlement.mismatch', 'settlement', id, { expectedRial: expected.toString() }, { actualRial: actual.toString() }, request.ip);
      return { id, reconciliationStatus: 'mismatch', exceptionId, expectedRial: asRial(expected), actualRial: asRial(actual) };
    });
  });

  app.post('/api/v1/admin/finance/settlements/:id/exceptions/:exceptionId/resolve', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id, exceptionId } = z.object({ id: z.uuid(), exceptionId: z.uuid() }).parse(request.params);
    const body = z.object({ resolution: z.enum(['resolved', 'waived']).default('resolved'),
      note: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const exception = await one<{ id: string; status: string; severity: string }>(client,
        'SELECT id, status, severity FROM settlement_exceptions WHERE id = $1 AND settlement_id = $2 FOR UPDATE', [exceptionId, id]);
      if (!exception) throw notFound();
      if (exception.status !== 'open') throw conflict('این مغایرت قبلاً بسته شده است.');
      await client.query('UPDATE settlement_exceptions SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1',
        [exceptionId, body.resolution, actor.id, body.note]);
      await audit(client, actor.id, 'settlement.exception_resolved', 'settlement', id,
        { exceptionId, status: exception.status }, { status: body.resolution, note: body.note }, request.ip);
      return { id, exceptionId, status: body.resolution };
    });
  });

  // ------------------------------------------------- adjustments & advances --
  app.get('/api/v1/admin/finance/adjustments', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ supplierId: z.uuid().optional(), status: z.string().max(30).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT a.*, a.amount_rial::text, u.display_name AS supplier_name FROM financial_adjustments a
         LEFT JOIN users u ON u.id = a.supplier_id
        WHERE ($1::uuid IS NULL OR a.supplier_id = $1) AND ($2::text IS NULL OR a.status = $2)
        ORDER BY a.created_at DESC LIMIT $3`, [query.supplierId ?? null, query.status ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/adjustments', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:adjust');
    const body = z.object({
      supplierId: z.uuid(),
      direction: z.enum(['credit', 'debit']),
      amountRial: z.string().regex(/^\d+$/).refine((value) => rial(value) > 0n, 'مبلغ باید بزرگ‌تر از صفر باشد.'),
      category: z.enum(['manual', 'penalty', 'bonus', 'tax', 'withholding', 'shipping', 'return']).default('manual'),
      reason: z.string().trim().min(3).max(500),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const supplier = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [body.supplierId]);
      if (!supplier) throw notFound();
      const reference = await nextDocumentReference(client, 'credit_note');
      const id = randomUUID();
      await client.query(
        `INSERT INTO financial_adjustments(id, reference, supplier_id, direction, amount_rial, category, reason, note, status, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9)`,
        [id, reference, body.supplierId, body.direction, body.amountRial, body.category, body.reason, body.note ?? null, actor.id]);
      await client.query(
        `INSERT INTO finance_approvals(id, subject_type, subject_id, amount_rial, status, requested_by, reason)
         VALUES ($1,'adjustment',$2,$3,'requested',$4,$5)`,
        [randomUUID(), id, body.amountRial, actor.id, body.reason]);
      await financeEvent(client, 'adjustment.created', 'financial_adjustment', id, { reference, supplierId: body.supplierId, direction: body.direction, amountRial: body.amountRial });
      await audit(client, actor.id, 'adjustment.created', 'financial_adjustment', id, undefined, { reference, direction: body.direction }, request.ip);
      return { id, reference, status: 'requested', amountRial: asRial(rial(body.amountRial)) };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/admin/finance/adjustments/:id/apply', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const adjustment = await one<{ id: string; reference: string; supplier_id: string | null; direction: 'credit' | 'debit';
        amount_rial: string; category: string; reason: string; status: string; requested_by: string | null; applied_at: Date | null }>(client,
        'SELECT * FROM financial_adjustments WHERE id = $1 FOR UPDATE', [id]);
      if (!adjustment) throw notFound();
      if (adjustment.applied_at) throw conflict('این اصلاح قبلاً اعمال شده است.');
      if (!adjustment.supplier_id) throw conflict('اصلاح بدون تأمین‌کننده قابل اعمال نیست.');
      const approval = await one<{ id: string; status: string }>(client,
        "SELECT id, status FROM finance_approvals WHERE subject_type = 'adjustment' AND subject_id = $1", [id]);
      if (!approval) throw notFound();
      if (approval.status !== 'approved') {
        if (approval.status === 'requested' && adjustment.requested_by !== actor.id) {
          await client.query("UPDATE finance_approvals SET status = 'approved', approved_by = $2, updated_at = now() WHERE id = $1", [approval.id, actor.id]);
          await client.query(`INSERT INTO finance_approval_events(id, approval_id, from_status, to_status, actor_id, note) VALUES ($1,$2,'requested','approved',$3,$4)`,
            [randomUUID(), approval.id, actor.id, body.note ?? 'تأیید هنگام اعمال']);
        } else {
          throw conflict('اصلاح باید ابتدا توسط مدیر مالی دیگر تأیید شود.');
        }
      }
      const amount = rial(adjustment.amount_rial);
      const event = adjustment.category === 'penalty' ? 'penalty'
        : adjustment.category === 'bonus' ? 'bonus'
        : adjustment.category === 'tax' ? 'tax'
        : adjustment.category === 'withholding' ? 'withholding'
        : adjustment.direction === 'credit' ? 'adjustment_credit' : 'adjustment_debit';
      const [accrued] = await accrueSupplier(client, [{
        event, amount, reference: adjustment.reference, description: `${adjustment.reason} (${adjustment.category})`,
        supplierId: adjustment.supplier_id, actorId: actor.id, sourceType: 'financial_adjustment', sourceId: adjustment.id,
      }]);
      const ledgerId = accrued?.id ?? null;
      await client.query("UPDATE financial_adjustments SET status = 'applied', applied_at = now(), ledger_entry_id = $2, approved_by = $3, approved_at = COALESCE(approved_at, now()) WHERE id = $1",
        [id, ledgerId ?? null, actor.id]);
      await client.query("UPDATE finance_approvals SET status = 'paid', updated_at = now() WHERE id = $1", [approval.id]);
      await financeEvent(client, 'adjustment.applied', 'financial_adjustment', id, { reference: adjustment.reference, amountRial: amount.toString() });
      await audit(client, actor.id, 'adjustment.applied', 'financial_adjustment', id, { status: adjustment.status },
        { status: 'applied', ledgerEntryId: ledgerId }, request.ip);
      return { id, status: 'applied', ledgerEntryId: ledgerId ?? null };
    });
  });

  app.get('/api/v1/admin/finance/advances', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ supplierId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT a.*, a.amount_rial::text, a.applied_rial::text, u.display_name AS supplier_name FROM supplier_advances a
         LEFT JOIN users u ON u.id = a.supplier_id
        WHERE ($1::uuid IS NULL OR a.supplier_id = $1) ORDER BY a.created_at DESC LIMIT $2`, [query.supplierId ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/advances', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:adjust');
    const body = z.object({
      supplierId: z.uuid(), amountRial: z.string().regex(/^\d+$/).refine((value) => rial(value) > 0n),
      reason: z.string().trim().min(3).max(500), note: z.string().trim().max(500).optional(),
    }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const supplier = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [body.supplierId]);
      if (!supplier) throw notFound();
      const reference = await nextDocumentReference(client, 'transaction');
      const id = randomUUID();
      await client.query(
        `INSERT INTO supplier_advances(id, reference, supplier_id, amount_rial, status, reason, note, requested_by)
         VALUES ($1,$2,$3,$4,'requested',$5,$6,$7)`,
        [id, reference, body.supplierId, body.amountRial, body.reason, body.note ?? null, actor.id]);
      await client.query(
        `INSERT INTO finance_approvals(id, subject_type, subject_id, amount_rial, status, requested_by, reason)
         VALUES ($1,'advance',$2,$3,'requested',$4,$5)`, [randomUUID(), id, body.amountRial, actor.id, body.reason]);
      await audit(client, actor.id, 'advance.created', 'supplier_advance', id, undefined, { reference, amountRial: body.amountRial }, request.ip);
      return { id, reference, status: 'requested', amountRial: asRial(rial(body.amountRial)) };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/admin/finance/advances/:id/pay', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reference: z.string().trim().min(2).max(120), method: z.enum(['transfer', 'cash', 'cheque', 'card']).default('transfer') }).parse(request.body);
    return transaction(pool, async (client) => {
      const advance = await one<{ id: string; reference: string; supplier_id: string; amount_rial: string; applied_rial: string; status: string; requested_by: string | null }>(client,
        'SELECT * FROM supplier_advances WHERE id = $1 FOR UPDATE', [id]);
      if (!advance) throw notFound();
      if (advance.status === 'paid' || advance.status === 'applied') throw conflict('این پیش‌پرداخت قبلاً پرداخت شده است.');
      const approval = await one<{ id: string; status: string }>(client,
        "SELECT id, status FROM finance_approvals WHERE subject_type = 'advance' AND subject_id = $1 FOR UPDATE", [id]);
      if (!approval) throw notFound();
      if (approval.status !== 'approved') {
        if (approval.status === 'requested' && advance.requested_by !== actor.id) {
          await client.query("UPDATE finance_approvals SET status = 'approved', approved_by = $2, updated_at = now() WHERE id = $1", [approval.id, actor.id]);
        } else {
          throw conflict('پیش‌پرداخت باید ابتدا تأیید شود.');
        }
      }
      const amount = rial(advance.amount_rial);
      await accrueSupplier(client, [{
        event: 'prepayment', amount, reference: advance.reference,
        description: `پیش‌پرداخت (${body.method}) — ${body.reference}`, supplierId: advance.supplier_id,
        actorId: actor.id, sourceType: 'supplier_advance', sourceId: advance.id,
      }]);
      await client.query("UPDATE supplier_advances SET status = 'paid', paid_at = now() WHERE id = $1", [id]);
      await client.query("UPDATE finance_approvals SET status = 'paid', updated_at = now() WHERE id = $1", [approval.id]);
      await financeEvent(client, 'advance.paid', 'supplier_advance', id, { reference: advance.reference, amountRial: amount.toString() });
      await audit(client, actor.id, 'advance.paid', 'supplier_advance', id, { status: advance.status }, { status: 'paid', reference: body.reference }, request.ip);
      return { id, status: 'paid', amountRial: asRial(amount) };
    });
  });

  /** Applying an advance consumes it against what the supplier is owed (item 156). */
  app.post('/api/v1/admin/finance/advances/:id/apply', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ amountRial: z.string().regex(/^\d+$/).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const advance = await one<{ id: string; reference: string; supplier_id: string; amount_rial: string; applied_rial: string; status: string }>(client,
        'SELECT * FROM supplier_advances WHERE id = $1 FOR UPDATE', [id]);
      if (!advance) throw notFound();
      if (advance.status !== 'paid') throw conflict('تنها پیش‌پرداخت پرداخت‌شده قابل اعمال است.');
      const remaining = rial(advance.amount_rial) - rial(advance.applied_rial);
      if (remaining <= 0n) throw conflict('این پیش‌پرداخت کاملاً اعمال شده است.');
      const account = await one<{ pending_payable_rial: string }>(client,
        'SELECT pending_payable_rial::text FROM supplier_finance_accounts WHERE user_id = $1', [advance.supplier_id]);
      const payable = signedRial(account?.pending_payable_rial ?? '0');
      const requested = body.amountRial ? rial(body.amountRial) : remaining;
      const amount = requested < remaining ? requested : remaining;
      if (payable <= 0n) throw conflict('مانده پرداختنی مثبتی برای اعمال پیش‌پرداخت وجود ندارد.');
      const applied = amount < payable ? amount : payable;
      // Each application posts its own journal entry; source_id is a uuid column with a
      // UNIQUE (source_type, source_id) guard, so a fresh uuid keeps applications distinct
      // while the supplier ledger row keeps the link back to the advance.
      await accrueSupplier(client, [{
        event: 'prepayment_applied', amount: applied, reference: `${advance.reference}-AP`,
        description: `اعمال پیش‌پرداخت ${advance.reference}`, supplierId: advance.supplier_id,
        actorId: actor.id, sourceType: 'supplier_advance', sourceId: randomUUID(),
      }]);
      const appliedTotal = rial(advance.applied_rial) + applied;
      await client.query("UPDATE supplier_advances SET applied_rial = $2, status = CASE WHEN $2 >= amount_rial THEN 'applied' ELSE 'paid' END WHERE id = $1",
        [id, appliedTotal.toString()]);
      await audit(client, actor.id, 'advance.applied', 'supplier_advance', id, { appliedRial: advance.applied_rial },
        { appliedRial: appliedTotal.toString() }, request.ip);
      return { id, appliedRial: asRial(appliedTotal), status: appliedTotal >= rial(advance.amount_rial) ? 'applied' : 'paid' };
    });
  });

  // -------------------------------------------------- shipping allocations --
  app.get('/api/v1/admin/finance/shipping-allocations', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const rows = await pool.query(
      `SELECT a.id, a.reference, a.total_cost_rial::text, a.rule, a.created_at, o.reference AS order_reference,
              (SELECT count(*)::int FROM shipping_allocation_lines l WHERE l.allocation_id = a.id) AS line_count
         FROM shipping_allocations a LEFT JOIN orders o ON o.id = a.order_id
        ORDER BY a.created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/shipping-allocations', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, managePermission);
    const body = z.object({
      orderId: z.uuid(),
      totalCostRial: z.string().regex(/^\d+$/),
      rule: z.enum(['weight', 'quantity', 'value', 'volume', 'equal']),
      carrier: z.string().trim().max(80).optional(),
    }).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const order = await one<{ id: string; reference: string }>(client, 'SELECT id, reference FROM orders WHERE id = $1', [body.orderId]);
      if (!order) throw notFound();
      const lines = await client.query<{ order_line_id: string; supplier_id: string | null; quantity: number; line_total_rial: string;
        weight_grams: number | null; volume: string | null }>(
        `SELECT ol.id AS order_line_id, ol.supplier_id, ol.quantity, ol.line_total_rial::text, ol.weight_grams,
                (v.attributes->>'volumeCm3') AS volume
           FROM order_lines ol JOIN product_variants v ON v.id = ol.variant_id WHERE ol.order_id = $1`, [body.orderId]);
      if (!lines.rowCount) throw badRequest('سفارش سطری ندارد.');
      const weightOf = (line: typeof lines.rows[number]) => body.rule === 'quantity' ? line.quantity
        : body.rule === 'value' ? Number(line.line_total_rial)
        : body.rule === 'weight' ? Number(line.weight_grams ?? 0)
        : body.rule === 'volume' ? Number(line.volume ?? 0)
        : 1;
      const total = lines.rows.reduce((sum, line) => sum + weightOf(line), 0) || 1;
      const totalCost = rial(body.totalCostRial);
      const allocationId = randomUUID();
      const reference = `SHA-${order.reference}`;
      await client.query(
        `INSERT INTO shipping_allocations(id, reference, order_id, total_cost_rial, total_weight_grams, rule, snapshot, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [allocationId, reference, order.id, totalCost.toString(),
          lines.rows.reduce((sum, line) => sum + Number(line.weight_grams ?? 0), 0),
          body.rule, JSON.stringify({ rule: body.rule, carrier: body.carrier ?? null,
            lines: lines.rows.map((line) => ({ orderLineId: line.order_line_id, basis: weightOf(line) })) }), actor.id]);
      const resultLines: Array<{ supplierId: string | null; amount: bigint }> = [];
      for (const line of lines.rows) {
        const amount = BigInt(Math.round(Number(totalCost) * weightOf(line) / total));
        await client.query(
          `INSERT INTO shipping_allocation_lines(id, allocation_id, supplier_id, order_id, order_line_id, basis_value, amount_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(), allocationId, line.supplier_id, order.id, line.order_line_id, weightOf(line), amount.toString()]);
        resultLines.push({ supplierId: line.supplier_id, amount });
      }
      await financeEvent(client, 'shipping.allocated', 'shipping_allocation', allocationId,
        { reference, orderId: order.id, rule: body.rule, totalCostRial: totalCost.toString() });
      await audit(client, actor.id, 'shipping.allocated', 'shipping_allocation', allocationId, undefined,
        { reference, rule: body.rule, totalCostRial: totalCost.toString() }, request.ip);
      return { id: allocationId, reference, rule: body.rule,
        lines: resultLines.map((line) => ({ supplierId: line.supplierId, amountRial: asRial(line.amount) })) };
    });
    return reply.code(201).send(result);
  });

  // -------------------------------------------------------------- periods --
  app.get('/api/v1/admin/finance/periods', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const rows = await pool.query(
      `SELECT p.code, p.title, p.starts_on, p.ends_on, p.status, p.closed_at, p.note,
              COALESCE((SELECT SUM(jl.credit_rial - jl.debit_rial) FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.entry_id
                 JOIN ledger_accounts la ON la.id = jl.account_id
                WHERE la.account_type = 'revenue' AND je.period_code = p.code), 0)::text AS revenue_rial,
              COALESCE((SELECT COUNT(*) FROM journal_entries je WHERE je.period_code = p.code), 0)::int AS entries
         FROM accounting_periods p ORDER BY p.code DESC LIMIT 36`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/periods/:code/:action', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'finance:periods');
    const { code, action } = z.object({ code: z.string().regex(/^\d{4}-\d{2}$/), action: z.enum(['close', 'lock', 'reopen']) }).parse(request.params);
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const period = await one<{ code: string; status: string; is_complete: boolean }>(client,
        `SELECT code, status,
                ends_on < (now() AT TIME ZONE 'Asia/Tehran')::date
                AND (to_date(code || '-01', 'YYYY-MM-DD') + interval '1 month')::date
                    <= (now() AT TIME ZONE 'Asia/Tehran')::date AS is_complete
         FROM accounting_periods WHERE code = $1 FOR UPDATE`, [code]);
      if (!period) throw notFound();
      const target = action === 'close' ? 'closed' : action === 'lock' ? 'locked' : 'open';
      if (period.status === target) return { code, status: target };
      if (action === 'reopen' && period.status === 'locked') throw conflict('دوره قفل‌شده فقط با دسترسی ویژه باز می‌شود.');
      if (action !== 'reopen' && !period.is_complete) {
        throw conflict('دوره جاری تا پایان ماه قابل بستن نیست.');
      }
      const unbalanced = await one<{ count: string }>(client,
        `SELECT COUNT(*)::text AS count FROM journal_entries je
          WHERE je.period_code = $1 AND (
            COALESCE((SELECT SUM(debit_rial) FROM journal_lines l WHERE l.entry_id = je.id), 0) <>
            COALESCE((SELECT SUM(credit_rial) FROM journal_lines l WHERE l.entry_id = je.id), 0))`, [code]);
      if (Number(unbalanced?.count ?? '0') > 0) throw conflict('سند نامتوازن در این دوره وجود دارد.');
      await client.query('UPDATE accounting_periods SET status = $2, closed_by = $3, closed_at = now(), note = $4 WHERE code = $1',
        [code, target, actor.id, body.note ?? null]);
      await audit(client, actor.id, `period.${action}`, 'accounting_period', code, { status: period.status }, { status: target, note: body.note ?? null }, request.ip);
      return { code, status: target };
    });
  });

  // -------------------------------------------------------------- reports --
  app.get('/api/v1/admin/finance/reports', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    return { items: REPORT_CATALOG };
  });

  app.get('/api/v1/admin/finance/reports/:code', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const { code } = z.object({ code: z.string().trim().max(60) }).parse(request.params);
    const query = dateRange.extend({
      format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
      groupBy: z.string().max(60).optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(500),
    }).parse(request.query);
    const { start, end } = rangeOf(query.from, query.to);
    const report = await transaction(pool, (client) => runReport(client, code, { from: start, to: end, groupBy: query.groupBy, limit: query.limit }));
    if (query.format === 'json') return report;
    requirePermission(actor, 'finance:export');
    const exported = await exportReport(report, query.format as ReportFormat);
    await transaction(pool, (client) => audit(client, actor.id, 'finance.report_exported', 'report', code, undefined,
      { code, format: query.format, rows: report.rows.length }, request.ip));
    return reply.header('Content-Type', exported.contentType)
      .header('Content-Disposition', `attachment; filename="${report.code}-${query.from ?? 'auto'}.${exported.extension}"`)
      .send(exported.body);
  });

  // ---------------------------------------------------------- finance feed --
  app.get('/api/v1/admin/finance/events', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, readPermission);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at FROM outbox_events
        WHERE event_type LIKE 'settlement.%' OR event_type LIKE 'invoice.%' OR event_type LIKE 'payment.%'
           OR event_type LIKE 'adjustment.%' OR event_type LIKE 'advance.%' OR event_type LIKE 'shipping.%'
           OR event_type LIKE 'withdrawal.%' OR event_type LIKE 'statement.%'
        ORDER BY created_at DESC LIMIT $1`, [query.limit]);
    return { items: rows.rows };
  });
}

/** Helper exported for the supplier 360 module (item 163). */
export async function supplierStatementRows(client: PoolClient, supplierId: string, from: Date, to: Date) {
  const rows = await client.query<{ occurred_at: Date; event: string; direction: string; amount_rial: string;
    balance_after_rial: string; reference: string; description: string | null; order_id: string | null;
    invoice_id: string | null; settlement_id: string | null }>(
    `SELECT occurred_at, event, direction, amount_rial::text, balance_after_rial::text, reference, description,
            order_id, invoice_id, settlement_id
       FROM supplier_ledger_entries WHERE supplier_id = $1 AND occurred_at >= $2 AND occurred_at < $3
      ORDER BY occurred_at DESC, id DESC LIMIT 500`, [supplierId, from, to]);
  await refreshSupplierAccount(client, supplierId);
  return rows.rows;
}
