/**
 * Prompt 3 — Supplier Financial Core routes.
 * Supplier self-service (summary/buckets/holds/settlements/bank accounts) and
 * admin finance operations (holds, policies, scheduled settlements, bank
 * verification, recoveries, reconciliation diagnostic, shipping policies,
 * provider reconciliation). Approve/pay of settlements stays in finance.ts
 * (canonical engine) — extended there for kind='scheduled'.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { principal, requirePermission, type Principal } from './auth.js';
import { audit } from './operations.js';
import { rial } from './money.js';
import { financeEvent } from './ledger.js';
import {
  applyPayableRefund, maskIban, nextSettlementDate, reconciliationDiagnostic,
  releaseDueHolds, resolveSettlementPolicy, runScheduledSettlements, supplierFinancePolicy,
} from './settlement-core.js';

const code = (status: number, codeName: string, message: string) => new ApiError(status, codeName, message);
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function requireSupplier(user: Principal): string {
  if (!user.roles.includes('supplier')) throw forbidden();
  return user.id;
}

const canReadFinance = (user: Principal) => {
  if (!user.permissions.includes('settlements:manage') && !user.permissions.includes('finance:read')) {
    requirePermission(user, 'settlements:manage');
  }
};

export function registerSettlementCoreRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ======================== Supplier self-service (§186-§189) ======================== */

  /** §186: bucketed finance summary — never a single opaque balance. */
  app.get('/api/v1/supplier/finance/summary', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const buckets = await one<Record<string, string>>(pool,
      `SELECT
         COALESCE(SUM(net_rial) FILTER (WHERE status IN ('held','blocked')), 0)::text AS held,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'blocked'), 0)::text AS blocked,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'eligible'), 0)::text AS eligible,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'scheduled'), 0)::text AS scheduled,
         COALESCE(SUM(net_rial) FILTER (WHERE status = 'settled'), 0)::text AS settled
       FROM supplier_child_payables WHERE supplier_id = $1`, [supplierId]);
    // در انتظار تکمیل سفارش: paid supplier children not yet delivered (estimate = gross).
    const pending = await one<{ amount: string; count: string }>(pool,
      `SELECT COALESCE(SUM(l.unit_series_price_rial * COALESCE(l.accepted_series, l.confirmed_series, l.requested_series)), 0)::text AS amount,
              COUNT(DISTINCT o.id)::text AS count
         FROM orders o JOIN child_order_lines l ON l.child_order_id = o.id
        WHERE o.seller_type = 'supplier' AND o.seller_id = $1 AND o.master_order_id IS NOT NULL
          AND o.payment_eligibility = 'paid' AND COALESCE(o.child_fulfillment, 'pending') <> 'delivered'
          AND o.status NOT IN ('cancelled') AND l.status NOT IN ('rejected', 'removed')`, [supplierId]);
    const recoveries = await one<{ open: string }>(pool,
      `SELECT COALESCE(SUM(amount_rial - offset_rial) FILTER (WHERE status = 'open'), 0)::text AS open
         FROM supplier_recoveries WHERE supplier_id = $1`, [supplierId]);
    const policy = await resolveSettlementPolicy(pool, supplierId);
    const nextDate = nextSettlementDate(policy, new Date());
    const nextHold = await one<{ release_at: Date }>(pool,
      `SELECT release_at FROM settlement_holds WHERE supplier_id = $1 AND status = 'active' ORDER BY release_at LIMIT 1`,
      [supplierId]);
    return {
      pendingFulfillmentRial: pending?.amount ?? '0',
      pendingFulfillmentOrders: Number(pending?.count ?? '0'),
      heldRial: buckets?.held ?? '0',
      blockedRial: buckets?.blocked ?? '0',
      eligibleRial: buckets?.eligible ?? '0',
      scheduledRial: buckets?.scheduled ?? '0',
      settledRial: buckets?.settled ?? '0',
      openRecoveryRial: recoveries?.open ?? '0',
      nextSettlementDate: nextDate ? nextDate.toISOString().slice(0, 10) : null,
      nextHoldReleaseAt: nextHold?.release_at ?? null,
      policy: { name: policy.name, scheduleType: policy.schedule_type, monthDays: policy.month_days,
        weeklyDay: policy.weekly_day, minimumSettlementRial: policy.minimum_settlement_rial },
      withdrawalsEnabled: false, // §7/§62: scheduled settlements replace withdrawals.
    };
  });

  /** §187: sales (payables) — component-wise explainable, per child. */
  app.get('/api/v1/supplier/finance/payables', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const query = pageQuery.extend({ status: z.enum(['held', 'blocked', 'eligible', 'scheduled', 'settled', 'cancelled']).optional() }).parse(request.query ?? {});
    const where = query.status ? 'AND p.status = $4' : '';
    const params: unknown[] = [supplierId, query.pageSize, (query.page - 1) * query.pageSize];
    if (query.status) params.push(query.status);
    const rows = await pool.query(
      `SELECT p.id, p.reference, p.status, p.gross_rial::text AS gross_rial, p.commission_rial::text AS commission_rial,
              p.shipping_share_rial::text AS shipping_share_rial, p.refunds_rial::text AS refunds_rial,
              p.adjustments_rial::text AS adjustments_rial, p.net_rial::text AS net_rial,
              p.commission_percent::text AS commission_percent, p.quantity_snapshot, p.shipping_policy_snapshot,
              p.created_at, p.eligible_at, p.settled_at, o.reference AS child_reference,
              m.reference AS master_reference, h.release_at AS hold_release_at, h.status AS hold_status
         FROM supplier_child_payables p
         JOIN orders o ON o.id = p.child_order_id
         LEFT JOIN master_orders m ON m.id = p.master_order_id
         LEFT JOIN settlement_holds h ON h.payable_id = p.id
        WHERE p.supplier_id = $1 ${where}
        ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, params);
    const total = await one<{ count: string }>(pool,
      `SELECT COUNT(*)::text AS count FROM supplier_child_payables p WHERE p.supplier_id = $1 ${query.status ? 'AND p.status = $2' : ''}`,
      query.status ? [supplierId, query.status] : [supplierId]);
    return { items: rows.rows, total: Number(total?.count ?? '0'), page: query.page, pageSize: query.pageSize };
  });

  /** §188: holds with reason + release date. */
  app.get('/api/v1/supplier/finance/holds', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const rows = await pool.query(
      `SELECT h.id, h.amount_rial::text AS amount_rial, h.status, h.starts_at, h.release_at, h.released_at,
              h.reason, h.blocked_reason, p.reference AS payable_reference, o.reference AS child_reference
         FROM settlement_holds h
         JOIN supplier_child_payables p ON p.id = h.payable_id
         JOIN orders o ON o.id = h.child_order_id
        WHERE h.supplier_id = $1 ORDER BY h.release_at DESC LIMIT 100`, [supplierId]);
    return { items: rows.rows };
  });

  /** §189: scheduled settlements — masked bank destination for self view. */
  app.get('/api/v1/supplier/finance/settlements', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const rows = await pool.query<{ bank_snapshot: { iban?: string; bankName?: string } } & Record<string, unknown>>(
      `SELECT id, reference, status, scheduled_for, net_rial::text AS net_rial, gross_rial::text AS gross_rial,
              commission_rial::text AS commission_rial, shipping_rial::text AS shipping_rial,
              returns_rial::text AS returns_rial, recovery_offset_rial::text AS recovery_offset_rial,
              paid_at, paid_reference, bank_snapshot, created_at
         FROM settlements WHERE party_user_id = $1 AND kind = 'scheduled'
        ORDER BY created_at DESC LIMIT 100`, [supplierId]);
    return {
      items: rows.rows.map((row) => ({
        ...row,
        bank_snapshot: undefined,
        bank: row.bank_snapshot?.iban
          ? { bankName: row.bank_snapshot.bankName ?? '', ibanMasked: maskIban(row.bank_snapshot.iban) }
          : null,
      })),
    };
  });

  app.get('/api/v1/supplier/finance/settlements/:id', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const settlement = await one<{ bank_snapshot: { iban?: string; bankName?: string; holderName?: string } } & Record<string, unknown>>(pool,
      `SELECT id, reference, status, scheduled_for, net_rial::text AS net_rial, gross_rial::text AS gross_rial,
              commission_rial::text AS commission_rial, shipping_rial::text AS shipping_rial,
              returns_rial::text AS returns_rial, adjustments_rial::text AS adjustments_rial,
              recovery_offset_rial::text AS recovery_offset_rial, paid_at, paid_reference,
              paid_amount_rial::text AS paid_amount_rial, bank_snapshot, policy_snapshot, created_at
         FROM settlements WHERE id = $1 AND party_user_id = $2 AND kind = 'scheduled'`, [id, supplierId]);
    if (!settlement) throw notFound();
    const lines = await pool.query(
      `SELECT l.id, l.order_reference, l.product_name, l.quantity, l.gross_rial::text AS gross_rial,
              l.commission_rial::text AS commission_rial, l.shipping_rial::text AS shipping_rial,
              l.returns_rial::text AS returns_rial, l.net_rial::text AS net_rial
         FROM settlement_lines l WHERE l.settlement_id = $1 ORDER BY l.created_at`, [id]);
    return {
      ...settlement,
      bank_snapshot: undefined,
      bank: settlement.bank_snapshot?.iban
        ? { bankName: settlement.bank_snapshot.bankName ?? '', holderName: settlement.bank_snapshot.holderName ?? '',
            ibanMasked: maskIban(settlement.bank_snapshot.iban) }
        : null,
      lines: lines.rows,
    };
  });

  /** تراکنش‌ها: own ledger projection — the ledger IS the truth (§18). */
  app.get('/api/v1/supplier/finance/ledger', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const query = pageQuery.parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT id, occurred_at, event, direction, amount_rial::text AS amount_rial,
              balance_after_rial::text AS balance_after_rial, reference, description
         FROM supplier_ledger_entries WHERE supplier_id = $1
        ORDER BY occurred_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [supplierId, query.pageSize, (query.page - 1) * query.pageSize]);
    const total = await one<{ count: string }>(pool,
      'SELECT COUNT(*)::text AS count FROM supplier_ledger_entries WHERE supplier_id = $1', [supplierId]);
    return { items: rows.rows, total: Number(total?.count ?? '0'), page: query.page, pageSize: query.pageSize };
  });

  /* ---------------- Supplier bank accounts (§43-§47, §116) ---------------- */
  app.get('/api/v1/supplier/finance/bank-accounts', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const rows = await pool.query(
      `SELECT id, bank_name, iban, holder_name, status, is_primary, verified_at, settlement_enabled_at,
              rejected_reason, created_at
         FROM supplier_bank_accounts WHERE supplier_id = $1 AND status <> 'archived'
        ORDER BY is_primary DESC, created_at DESC`, [supplierId]);
    return { items: rows.rows }; // §116: supplier sees own full IBAN.
  });

  app.post('/api/v1/supplier/finance/bank-accounts', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const body = z.object({
      bankName: z.string().trim().min(2).max(80),
      iban: z.string().trim().toUpperCase().regex(/^IR\d{24}$/, 'شماره شبا باید با IR شروع شود و ۲۴ رقم داشته باشد.'),
      holderName: z.string().trim().min(2).max(120),
    }).parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await one<{ id: string; status: string }>(client,
        'SELECT id, status FROM supplier_bank_accounts WHERE supplier_id = $1 AND iban = $2', [supplierId, body.iban]);
      if (existing && existing.status !== 'archived') throw conflict('این شماره شبا قبلاً ثبت شده است.');
      const hasPrimary = await one<{ count: string }>(client,
        `SELECT COUNT(*)::text AS count FROM supplier_bank_accounts WHERE supplier_id = $1 AND is_primary AND status NOT IN ('archived','rejected')`,
        [supplierId]);
      const id = randomUUID();
      // §45: every new/changed account starts unverified — verification is never carried over.
      await client.query(
        `INSERT INTO supplier_bank_accounts(id, supplier_id, bank_name, iban, holder_name, status, is_primary)
         VALUES ($1,$2,$3,$4,$5,'pending_verification',$6)`,
        [id, supplierId, body.bankName, body.iban, body.holderName, Number(hasPrimary?.count ?? '0') === 0]);
      await audit(client, user.id, 'bank_account.created', 'supplier_bank_account', id, undefined,
        { bankName: body.bankName, ibanMasked: maskIban(body.iban) }); // §117: never log full IBAN.
      await financeEvent(client, 'bank_account.submitted', 'supplier_bank_account', id,
        { bankAccountId: id, supplierId, status: 'pending_verification' });
      return { id, status: 'pending_verification' };
    });
  });

  app.post('/api/v1/supplier/finance/bank-accounts/:id/archive', async (request) => {
    const user = await principal(request, pool, config);
    const supplierId = requireSupplier(user);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const account = await one<{ id: string; status: string }>(client,
        'SELECT id, status FROM supplier_bank_accounts WHERE id = $1 AND supplier_id = $2 FOR UPDATE', [id, supplierId]);
      if (!account) throw notFound();
      const inFlight = await one<{ count: string }>(client,
        `SELECT COUNT(*)::text AS count FROM settlements WHERE bank_account_id = $1 AND status IN ('pending','approved','processing')`, [id]);
      if (Number(inFlight?.count ?? '0') > 0) throw conflict('این حساب در یک تسویه در جریان استفاده شده و فعلاً قابل حذف نیست.');
      await client.query(
        `UPDATE supplier_bank_accounts SET status = 'archived', is_primary = false, archived_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'bank_account.archived', 'supplier_bank_account', id, { status: account.status }, { status: 'archived' });
      return { id, status: 'archived' };
    });
  });

  /* ============================ Admin: holds (§192) ============================ */
  app.get('/api/v1/admin/finance/settlement-holds', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const query = pageQuery.extend({
      status: z.enum(['active', 'blocked', 'released', 'cancelled']).optional(),
      supplierId: z.uuid().optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = []; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`h.status = $${params.length}`); }
    if (query.supplierId) { params.push(query.supplierId); conditions.push(`h.supplier_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT h.id, h.supplier_id, h.amount_rial::text AS amount_rial, h.status, h.starts_at, h.release_at,
              h.released_at, h.reason, h.blocked_reason, h.manual_block, h.policy_snapshot,
              p.reference AS payable_reference, o.reference AS child_reference, u.display_name AS supplier_name
         FROM settlement_holds h
         JOIN supplier_child_payables p ON p.id = h.payable_id
         JOIN orders o ON o.id = h.child_order_id
         JOIN users u ON u.id = h.supplier_id
        ${where} ORDER BY h.release_at LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/settlement-holds/:id/:action', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(['block', 'unblock', 'extend', 'release']) }).parse(request.params);
    const body = z.object({
      reason: z.string().trim().min(2).max(500).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 90).optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const hold = await one<{ id: string; payable_id: string; supplier_id: string; child_order_id: string;
        status: string; manual_block: boolean; release_at: Date; amount_rial: string }>(client,
        'SELECT id, payable_id, supplier_id, child_order_id, status, manual_block, release_at, amount_rial::text FROM settlement_holds WHERE id = $1 FOR UPDATE', [id]);
      if (!hold) throw notFound();
      if (action === 'block') {
        if (!body.reason) throw badRequest('دلیل مسدودسازی الزامی است.');
        if (hold.status === 'released') throw conflict('این Hold قبلاً آزاد شده است.');
        await client.query(
          `UPDATE settlement_holds SET status = 'blocked', manual_block = true, blocked_reason = $2, updated_at = now() WHERE id = $1`,
          [id, body.reason]);
        await client.query(`UPDATE supplier_child_payables SET status = 'blocked', updated_at = now() WHERE id = $1`, [hold.payable_id]);
        await audit(client, user.id, 'settlement_hold.blocked', 'settlement_hold', id, { status: hold.status }, { status: 'blocked', reason: body.reason }, request.ip);
        return { id, status: 'blocked' };
      }
      if (action === 'unblock') {
        if (hold.status !== 'blocked') throw conflict('این Hold مسدود نیست.');
        await client.query(
          `UPDATE settlement_holds SET status = 'active', manual_block = false, blocked_reason = NULL, updated_at = now() WHERE id = $1`, [id]);
        await client.query(`UPDATE supplier_child_payables SET status = 'held', updated_at = now() WHERE id = $1`, [hold.payable_id]);
        await audit(client, user.id, 'settlement_hold.unblocked', 'settlement_hold', id, { status: 'blocked' }, { status: 'active', note: body.reason ?? null }, request.ip);
        return { id, status: 'active' };
      }
      if (action === 'extend') {
        if (!body.hours) throw badRequest('تعداد ساعت تمدید الزامی است.');
        if (hold.status !== 'active' && hold.status !== 'blocked') throw conflict('تنها Hold فعال قابل تمدید است.');
        await client.query(
          `UPDATE settlement_holds SET release_at = GREATEST(release_at, now()) + ($2 || ' hours')::interval, updated_at = now() WHERE id = $1`,
          [id, String(body.hours)]);
        await audit(client, user.id, 'settlement_hold.extended', 'settlement_hold', id, { releaseAt: hold.release_at }, { hours: body.hours, reason: body.reason ?? null }, request.ip);
        return { id, status: hold.status };
      }
      // release (early, manual — audited, still blocker-checked via sweep semantics)
      if (hold.status !== 'active') throw conflict('تنها Hold فعال قابل آزادسازی است.');
      await client.query(
        `UPDATE settlement_holds SET release_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'settlement_hold.early_release_requested', 'settlement_hold', id, undefined, { reason: body.reason ?? null }, request.ip);
      const result = await releaseDueHolds(pool, user.id);
      return { id, sweep: result };
    });
  });

  /** §31: idempotent manual sweep trigger (same function the worker runs). */
  app.post('/api/v1/admin/finance/settlement-holds/run-release', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const result = await releaseDueHolds(pool, user.id);
    return result;
  });

  /* ==================== Admin: payables + refunds (§89-§94) ==================== */
  app.get('/api/v1/admin/finance/supplier-payables', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const query = pageQuery.extend({
      status: z.enum(['held', 'blocked', 'eligible', 'scheduled', 'settled', 'cancelled']).optional(),
      supplierId: z.uuid().optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = []; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`p.status = $${params.length}`); }
    if (query.supplierId) { params.push(query.supplierId); conditions.push(`p.supplier_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT p.id, p.reference, p.supplier_id, u.display_name AS supplier_name, p.status,
              p.gross_rial::text AS gross_rial, p.commission_rial::text AS commission_rial,
              p.shipping_share_rial::text AS shipping_share_rial, p.refunds_rial::text AS refunds_rial,
              p.net_rial::text AS net_rial, p.commission_percent::text AS commission_percent,
              p.quantity_snapshot, p.shipping_policy_snapshot, p.created_at, p.eligible_at, p.settled_at,
              o.reference AS child_reference, m.reference AS master_reference, p.settlement_id
         FROM supplier_child_payables p
         JOIN users u ON u.id = p.supplier_id
         JOIN orders o ON o.id = p.child_order_id
         LEFT JOIN master_orders m ON m.id = p.master_order_id
        ${where} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/supplier-payables/:id/refund', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      amountRial: z.string().regex(/^\d+$/),
      reason: z.string().trim().min(3).max(500),
      sourceType: z.enum(['post_settlement_refund', 'chargeback', 'adjustment', 'manual']).optional(),
    }).parse(request.body);
    return transaction(pool, async (client) =>
      applyPayableRefund(client, { payableId: id, amountRial: rial(body.amountRial), reason: body.reason,
        actorId: user.id, sourceType: body.sourceType }));
  });

  /* ==================== Admin: settlement policies (§33-§36) ==================== */
  app.get('/api/v1/admin/finance/settlement-policies', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const rows = await pool.query(
      `SELECT p.id, p.name, p.active, p.schedule_type, p.weekly_day, p.month_days,
              p.minimum_settlement_rial::text AS minimum_settlement_rial, p.hold_hours,
              p.requires_verified_bank, p.requires_manual_review, p.automatic_bank_payout,
              p.version, p.effective_from, p.effective_to,
              (SELECT COUNT(*)::int FROM supplier_profiles sp WHERE sp.settlement_policy_id = p.id) AS supplier_count
         FROM settlement_policies p ORDER BY p.created_at`, []);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/settlement-policies', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({
      name: z.string().trim().min(2).max(120),
      scheduleType: z.enum(['weekly', 'monthly', 'month_days', 'manual']),
      weeklyDay: z.number().int().min(0).max(6).optional(),
      monthDays: z.array(z.number().int().min(1).max(31)).max(10).default([]),
      minimumSettlementRial: z.string().regex(/^\d+$/).default('0'),
      holdHours: z.number().int().min(0).max(24 * 90).nullable().optional(),
      requiresVerifiedBank: z.boolean().default(true),
      requiresManualReview: z.boolean().default(true),
    }).parse(request.body);
    if (body.scheduleType === 'weekly' && body.weeklyDay === undefined) throw badRequest('روز هفته برای زمان‌بندی هفتگی الزامی است.');
    if ((body.scheduleType === 'month_days' || body.scheduleType === 'monthly') && !body.monthDays.length) {
      throw badRequest('روزهای ماه برای این نوع زمان‌بندی الزامی است.');
    }
    return transaction(pool, async (client) => {
      const id = randomUUID();
      // §36/§50: automatic_bank_payout is hard-false at DB level — not even sent.
      await client.query(
        `INSERT INTO settlement_policies(id, name, schedule_type, weekly_day, month_days, minimum_settlement_rial,
           hold_hours, requires_verified_bank, requires_manual_review, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, body.name, body.scheduleType, body.weeklyDay ?? null, body.monthDays, body.minimumSettlementRial,
          body.holdHours ?? null, body.requiresVerifiedBank, body.requiresManualReview, user.id]);
      await audit(client, user.id, 'settlement_policy.created', 'settlement_policy', id, undefined, body, request.ip);
      return { id };
    });
  });

  /** §36: policy change = new version row; existing settlements keep snapshots. */
  app.post('/api/v1/admin/finance/settlement-policies/:id/revise', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      scheduleType: z.enum(['weekly', 'monthly', 'month_days', 'manual']).optional(),
      weeklyDay: z.number().int().min(0).max(6).nullable().optional(),
      monthDays: z.array(z.number().int().min(1).max(31)).max(10).optional(),
      minimumSettlementRial: z.string().regex(/^\d+$/).optional(),
      holdHours: z.number().int().min(0).max(24 * 90).nullable().optional(),
      active: z.boolean().optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const current = await one<{ id: string; version: number } & Record<string, unknown>>(client,
        'SELECT * FROM settlement_policies WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw notFound();
      await client.query(
        `UPDATE settlement_policies SET
           name = COALESCE($2, name), schedule_type = COALESCE($3, schedule_type),
           weekly_day = CASE WHEN $4::boolean THEN $5 ELSE weekly_day END,
           month_days = COALESCE($6, month_days),
           minimum_settlement_rial = COALESCE($7, minimum_settlement_rial),
           hold_hours = CASE WHEN $8::boolean THEN $9 ELSE hold_hours END,
           active = COALESCE($10, active), version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, body.name ?? null, body.scheduleType ?? null,
          body.weeklyDay !== undefined, body.weeklyDay ?? null,
          body.monthDays ?? null, body.minimumSettlementRial ?? null,
          body.holdHours !== undefined, body.holdHours ?? null,
          body.active ?? null]);
      await audit(client, user.id, 'settlement_policy.revised', 'settlement_policy', id,
        { version: current.version }, { version: current.version + 1, changes: body }, request.ip);
      return { id, version: current.version + 1 };
    });
  });

  app.post('/api/v1/admin/finance/settlement-policies/assign', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({ supplierId: z.uuid(), policyId: z.uuid().nullable() }).parse(request.body);
    return transaction(pool, async (client) => {
      if (body.policyId) {
        const policy = await one<{ id: string }>(client, 'SELECT id FROM settlement_policies WHERE id = $1 AND active', [body.policyId]);
        if (!policy) throw notFound('سیاست تسویه فعال پیدا نشد.');
      }
      const updated = await client.query(
        'UPDATE supplier_profiles SET settlement_policy_id = $2 WHERE user_id = $1', [body.supplierId, body.policyId]);
      if (!updated.rowCount) throw notFound('پروفایل تأمین‌کننده پیدا نشد.');
      await audit(client, user.id, 'settlement_policy.assigned', 'supplier_profile', body.supplierId, undefined,
        { policyId: body.policyId }, request.ip);
      return { supplierId: body.supplierId, policyId: body.policyId };
    });
  });

  /* ================= Admin: scheduled settlements (§37-§42, §193) ================= */
  app.get('/api/v1/admin/finance/supplier-settlements', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const query = pageQuery.extend({
      status: z.enum(['pending', 'approved', 'processing', 'paid', 'reconciled', 'cancelled', 'failed']).optional(),
      supplierId: z.uuid().optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = ["s.kind = 'scheduled'"]; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`s.status = $${params.length}`); }
    if (query.supplierId) { params.push(query.supplierId); conditions.push(`s.party_user_id = $${params.length}`); }
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT s.id, s.reference, s.party_user_id, u.display_name AS supplier_name, s.status, s.scheduled_for,
              s.net_rial::text AS net_rial, s.gross_rial::text AS gross_rial, s.recovery_offset_rial::text AS recovery_offset_rial,
              s.paid_at, s.paid_reference, s.created_at,
              (SELECT COUNT(*)::int FROM settlement_lines l WHERE l.settlement_id = s.id) AS line_count,
              (SELECT COUNT(*)::int FROM settlement_exceptions e WHERE e.settlement_id = s.id AND e.status = 'open' AND e.severity = 'blocking') AS blocking_exceptions
         FROM settlements s JOIN users u ON u.id = s.party_user_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  /** Upcoming view (§193): what WOULD be settled per supplier at next due dates. */
  app.get('/api/v1/admin/finance/supplier-settlements/upcoming', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const rows = await pool.query<{ supplier_id: string; supplier_name: string; eligible_rial: string;
      held_rial: string; payables: number }>(
      `SELECT p.supplier_id, u.display_name AS supplier_name,
              COALESCE(SUM(p.net_rial) FILTER (WHERE p.status = 'eligible'), 0)::text AS eligible_rial,
              COALESCE(SUM(p.net_rial) FILTER (WHERE p.status IN ('held','blocked')), 0)::text AS held_rial,
              COUNT(*) FILTER (WHERE p.status = 'eligible')::int AS payables
         FROM supplier_child_payables p JOIN users u ON u.id = p.supplier_id
        WHERE p.status IN ('eligible', 'held', 'blocked')
        GROUP BY p.supplier_id, u.display_name ORDER BY u.display_name`, []);
    const items = [] as Array<Record<string, unknown>>;
    for (const row of rows.rows) {
      const policy = await resolveSettlementPolicy(pool, row.supplier_id);
      const next = nextSettlementDate(policy, new Date());
      const bank = await one<{ count: string }>(pool,
        `SELECT COUNT(*)::text AS count FROM supplier_bank_accounts WHERE supplier_id = $1 AND status = 'verified'`,
        [row.supplier_id]);
      items.push({
        supplierId: row.supplier_id, supplierName: row.supplier_name,
        eligibleRial: row.eligible_rial, heldRial: row.held_rial, eligiblePayables: row.payables,
        nextSettlementDate: next ? next.toISOString().slice(0, 10) : null,
        policyName: policy.name, minimumSettlementRial: policy.minimum_settlement_rial,
        hasVerifiedBank: Number(bank?.count ?? '0') > 0,
      });
    }
    return { items };
  });

  app.post('/api/v1/admin/finance/supplier-settlements/generate', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({
      supplierId: z.uuid().optional(),
      force: z.boolean().default(false),
    }).parse(request.body ?? {});
    return runScheduledSettlements(pool, { actorId: user.id, supplierId: body.supplierId, force: body.force });
  });

  app.get('/api/v1/admin/finance/supplier-settlements/:id', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const settlement = await one<Record<string, unknown> & { status: string; bank_snapshot: { iban?: string } }>(pool,
      `SELECT s.*, s.amount_rial::text AS amount_rial, s.net_rial::text AS net_rial, s.gross_rial::text AS gross_rial,
              s.commission_rial::text AS commission_rial, s.shipping_rial::text AS shipping_rial,
              s.returns_rial::text AS returns_rial, s.adjustments_rial::text AS adjustments_rial,
              s.recovery_offset_rial::text AS recovery_offset_rial, s.paid_amount_rial::text AS paid_amount_rial,
              u.display_name AS supplier_name
         FROM settlements s JOIN users u ON u.id = s.party_user_id
        WHERE s.id = $1 AND s.kind = 'scheduled'`, [id]);
    if (!settlement) throw notFound();
    const lines = await pool.query(
      `SELECT l.id, l.order_reference, l.product_name, l.quantity, l.payable_id, l.child_order_id,
              l.gross_rial::text AS gross_rial, l.commission_rial::text AS commission_rial,
              l.shipping_rial::text AS shipping_rial, l.returns_rial::text AS returns_rial,
              l.net_rial::text AS net_rial
         FROM settlement_lines l WHERE l.settlement_id = $1 ORDER BY l.created_at`, [id]);
    const exceptions = await pool.query(
      `SELECT id, code, severity, detail, status, expected_rial::text AS expected_rial, found_rial::text AS found_rial, created_at
         FROM settlement_exceptions WHERE settlement_id = $1 ORDER BY created_at DESC`, [id]);
    const events = await pool.query(
      `SELECT from_status, to_status, actor_id, note, created_at FROM settlement_events
        WHERE settlement_id = $1 ORDER BY created_at`, [id]);
    const approval = await one(pool,
      `SELECT id, status, requested_by, reviewed_by, approved_by, amount_rial::text AS amount_rial
         FROM finance_approvals WHERE subject_type = 'settlement' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]);
    const openBlocking = exceptions.rows.some((e) => e.status === 'open' && e.severity === 'blocking');
    // §147: server-derived allowed actions.
    const allowedActions = settlement.status === 'pending' ? ['review', 'approve', 'cancel', 'block']
      : settlement.status === 'approved' ? (openBlocking ? ['cancel', 'fail'] : ['pay', 'cancel', 'fail'])
      : settlement.status === 'processing' ? ['approve', 'cancel']
      : [];
    return { ...settlement, lines: lines.rows, exceptions: exceptions.rows, events: events.rows, approval, allowedActions };
  });

  /** Manual block: blocking exception keeps پرداخت locked until resolved (§42). */
  app.post('/api/v1/admin/finance/supplier-settlements/:id/block', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const settlement = await one<{ id: string; status: string; kind: string }>(client,
        'SELECT id, status, kind FROM settlements WHERE id = $1 FOR UPDATE', [id]);
      if (!settlement || settlement.kind !== 'scheduled') throw notFound();
      if (settlement.status === 'paid' || settlement.status === 'reconciled') throw conflict('تسویه پرداخت‌شده قابل مسدودسازی نیست.');
      await client.query(
        `INSERT INTO settlement_exceptions(id, settlement_id, code, severity, detail)
         VALUES ($1,$2,'manual_adjustment','blocking',$3)`, [randomUUID(), id, body.reason]);
      await audit(client, user.id, 'settlement.blocked', 'settlement', id, undefined, { reason: body.reason }, request.ip);
      return { id, blocked: true };
    });
  });

  /** Cancel / fail: payables return to eligible; nothing financial is deleted (§55). */
  app.post('/api/v1/admin/finance/supplier-settlements/:id/:action', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(['cancel', 'fail']) }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const settlement = await one<{ id: string; reference: string; status: string; kind: string; party_user_id: string;
        recovery_offset_rial: string }>(client,
        'SELECT id, reference, status, kind, party_user_id, recovery_offset_rial::text FROM settlements WHERE id = $1 FOR UPDATE', [id]);
      if (!settlement || settlement.kind !== 'scheduled') throw notFound();
      if (settlement.status === 'paid' || settlement.status === 'reconciled') {
        throw code(409, 'SETTLEMENT_ALREADY_PAID', 'تسویه پرداخت‌شده قابل لغو نیست — برای بازپرداخت از Recovery استفاده کنید.');
      }
      if (settlement.status === 'cancelled' || settlement.status === 'failed') return { id, status: settlement.status };
      if (action === 'fail' && settlement.status !== 'approved' && settlement.status !== 'processing') {
        throw conflict('تنها تسویه تأییدشده می‌تواند به وضعیت ناموفق برود.');
      }
      const target = action === 'cancel' ? 'cancelled' : 'failed';
      // Release payables back to eligible; detach lines so payable-uniqueness stays true.
      await client.query(
        `UPDATE supplier_child_payables SET status = 'eligible', settlement_id = NULL, updated_at = now()
          WHERE settlement_id = $1 AND status = 'scheduled'`, [id]);
      await client.query(
        `UPDATE settlement_lines SET payable_id = NULL WHERE settlement_id = $1`, [id]);
      // Re-open recovery offsets consumed by this settlement.
      if (rial(settlement.recovery_offset_rial) > 0n) {
        await client.query(
          `UPDATE supplier_recoveries SET status = 'open', closed_at = NULL,
             offset_rial = GREATEST(offset_rial - $2, 0)
           WHERE supplier_id = $1 AND status IN ('open', 'offset')
             AND id = (SELECT id FROM supplier_recoveries WHERE supplier_id = $1 AND offset_rial > 0 ORDER BY created_at DESC LIMIT 1)`,
          [settlement.party_user_id, settlement.recovery_offset_rial]);
      }
      await client.query(`UPDATE settlements SET status = $2 WHERE id = $1`, [id, target]);
      await client.query(
        `UPDATE finance_approvals SET status = 'rejected', rejected_by = $2, updated_at = now()
          WHERE subject_type = 'settlement' AND subject_id = $1 AND status IN ('requested','reviewed','approved')`, [id, user.id]);
      await client.query(
        `INSERT INTO settlement_events(id, settlement_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [randomUUID(), id, settlement.status, target, user.id, body.reason]);
      await audit(client, user.id, `settlement.${target}`, 'settlement', id, { status: settlement.status }, { status: target, reason: body.reason }, request.ip);
      await financeEvent(client, `settlement.${target}`, 'settlement', id, { reference: settlement.reference, reason: body.reason });
      return { id, status: target };
    });
  });

  /* ================== Admin: bank verification (§46, §194) ================== */
  app.get('/api/v1/admin/finance/bank-accounts', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'bank:verify');
    const query = pageQuery.extend({
      status: z.enum(['pending_verification', 'verified', 'rejected', 'disabled', 'archived']).optional(),
      supplierId: z.uuid().optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = []; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`b.status = $${params.length}`); }
    if (query.supplierId) { params.push(query.supplierId); conditions.push(`b.supplier_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT b.id, b.supplier_id, u.display_name AS supplier_name, b.bank_name, b.iban, b.holder_name,
              b.status, b.is_primary, b.verified_at, b.settlement_enabled_at, b.rejected_reason, b.created_at
         FROM supplier_bank_accounts b JOIN users u ON u.id = b.supplier_id
        ${where} ORDER BY b.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    // §116: bank:verify holders are the authorized finance staff → full IBAN here.
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/bank-accounts/:id/:action', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'bank:verify');
    const { id, action } = z.object({ id: z.uuid(), action: z.enum(['verify', 'reject', 'disable']) }).parse(request.params);
    const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const account = await one<{ id: string; supplier_id: string; status: string; iban: string }>(client,
        'SELECT id, supplier_id, status, iban FROM supplier_bank_accounts WHERE id = $1 FOR UPDATE', [id]);
      if (!account) throw notFound();
      if (action === 'verify') {
        if (account.status !== 'pending_verification') throw conflict('تنها حساب در انتظار تأیید قابل تأیید است.');
        const finance = await supplierFinancePolicy(client);
        const enabledAt = new Date(Date.now() + finance.bankCooldownHours * 3_600_000);
        await client.query(
          `UPDATE supplier_bank_accounts SET status = 'verified', verified_at = now(), verified_by = $2,
             settlement_enabled_at = $3, updated_at = now() WHERE id = $1`, [id, user.id, enabledAt]);
        await financeEvent(client, 'bank_account.verified', 'supplier_bank_account', id,
          { bankAccountId: id, supplierId: account.supplier_id, settlementEnabledAt: enabledAt.toISOString() });
      } else if (action === 'reject') {
        if (account.status !== 'pending_verification') throw conflict('تنها حساب در انتظار تأیید قابل رد است.');
        if (!body.reason) throw badRequest('دلیل رد الزامی است.');
        await client.query(
          `UPDATE supplier_bank_accounts SET status = 'rejected', rejected_reason = $2, is_primary = false, updated_at = now() WHERE id = $1`,
          [id, body.reason]);
      } else {
        if (account.status !== 'verified') throw conflict('تنها حساب تأییدشده قابل غیرفعال‌سازی است.');
        if (!body.reason) throw badRequest('دلیل غیرفعال‌سازی الزامی است.');
        await client.query(
          `UPDATE supplier_bank_accounts SET status = 'disabled', security_note = $2, updated_at = now() WHERE id = $1`,
          [id, body.reason]);
        await financeEvent(client, 'bank_account.disabled', 'supplier_bank_account', id,
          { bankAccountId: id, supplierId: account.supplier_id, reason: body.reason });
      }
      await audit(client, user.id, `bank_account.${action}`, 'supplier_bank_account', id,
        { status: account.status }, { status: action === 'verify' ? 'verified' : action === 'reject' ? 'rejected' : 'disabled',
          ibanMasked: maskIban(account.iban), reason: body.reason ?? null }, request.ip);
      return { id, status: action === 'verify' ? 'verified' : action === 'reject' ? 'rejected' : 'disabled' };
    });
  });

  /* =================== Admin: recoveries + diagnostics (§92, §126) =================== */
  app.get('/api/v1/admin/finance/supplier-recoveries', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const query = pageQuery.extend({
      status: z.enum(['open', 'offset', 'written_off']).optional(),
      supplierId: z.uuid().optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = []; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`r.status = $${params.length}`); }
    if (query.supplierId) { params.push(query.supplierId); conditions.push(`r.supplier_id = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT r.id, r.reference, r.supplier_id, u.display_name AS supplier_name, r.amount_rial::text AS amount_rial,
              r.offset_rial::text AS offset_rial, r.status, r.source_type, r.note, r.created_at, r.closed_at
         FROM supplier_recoveries r JOIN users u ON u.id = r.supplier_id
        ${where} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/finance/supplier-recoveries/:id/write-off', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'finance:approve');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const recovery = await one<{ id: string; status: string; supplier_id: string; amount_rial: string; offset_rial: string; reference: string }>(client,
        'SELECT id, status, supplier_id, amount_rial::text, offset_rial::text, reference FROM supplier_recoveries WHERE id = $1 FOR UPDATE', [id]);
      if (!recovery) throw notFound();
      if (recovery.status !== 'open') throw conflict('تنها Recovery باز قابل بخشودگی است.');
      const remaining = rial(recovery.amount_rial) - rial(recovery.offset_rial);
      await client.query(
        `UPDATE supplier_recoveries SET status = 'written_off', closed_at = now(), note = COALESCE(note || ' | ', '') || $2 WHERE id = $1`,
        [id, `بخشودگی: ${body.reason}`]);
      // Ledger symmetry: the refund debit posted at creation is forgiven via a credit.
      if (remaining > 0n) {
        const { accrueSupplier } = await import('./ledger.js');
        await accrueSupplier(client, [{ event: 'adjustment_credit', amount: remaining,
          reference: `${recovery.reference}-WO`, description: `بخشودگی Recovery — ${body.reason}`,
          supplierId: recovery.supplier_id, actorId: user.id, sourceType: 'supplier_recovery', sourceId: id }]);
      }
      await audit(client, user.id, 'supplier_recovery.written_off', 'supplier_recovery', id,
        { status: 'open' }, { status: 'written_off', reason: body.reason }, request.ip);
      return { id, status: 'written_off' };
    });
  });

  /** §126: read-only reconciliation diagnostic — never mutates. */
  app.get('/api/v1/admin/finance/reconciliation-diagnostic/:supplierId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'finance:reconcile');
    const { supplierId } = z.object({ supplierId: z.uuid() }).parse(request.params);
    return reconciliationDiagnostic(pool, supplierId);
  });

  /* ================= Admin: shipping financial policies (§73-§85) ================= */
  app.get('/api/v1/admin/finance/shipping-policies', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    const rows = await pool.query(
      `SELECT p.id, p.name, p.leg, p.payer, p.supplier_share_percent::text AS supplier_share_percent,
              p.method, p.amount_rial::text AS amount_rial, p.supplier_id, u.display_name AS supplier_name,
              p.active, p.version, p.effective_from, p.effective_to
         FROM shipping_financial_policies p LEFT JOIN users u ON u.id = p.supplier_id
        ORDER BY p.leg, p.supplier_id NULLS FIRST, p.effective_from DESC`, []);
    return { items: rows.rows };
  });

  /** §80: a change = new version; old rows closed, snapshots untouched. */
  app.post('/api/v1/admin/finance/shipping-policies', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({
      name: z.string().trim().min(2).max(160),
      leg: z.enum(['supplier_inbound_order', 'supplier_inbound_stock', 'master_final']),
      payer: z.enum(['customer', 'supplier', 'kolbe', 'shared', 'promotion']),
      supplierSharePercent: z.number().min(0).max(100).default(0),
      method: z.enum(['fixed', 'per_series', 'actual_cost']).default('fixed'),
      amountRial: z.string().regex(/^\d+$/).default('0'),
      supplierId: z.uuid().nullable().optional(),
    }).parse(request.body);
    if (body.payer === 'shared' && body.supplierSharePercent <= 0) {
      throw code(400, 'INVALID_SHIPPING_POLICY', 'برای حالت مشترک، سهم تأمین‌کننده باید بزرگ‌تر از صفر باشد.');
    }
    if (body.payer !== 'shared' && body.supplierSharePercent > 0) {
      throw code(400, 'INVALID_SHIPPING_POLICY', 'سهم درصدی تنها در حالت مشترک معنا دارد.');
    }
    return transaction(pool, async (client) => {
      const previous = await one<{ version: number }>(client,
        `SELECT version FROM shipping_financial_policies
          WHERE leg = $1 AND (supplier_id = $2 OR (supplier_id IS NULL AND $2::uuid IS NULL)) AND active
          ORDER BY version DESC LIMIT 1 FOR UPDATE`, [body.leg, body.supplierId ?? null]);
      await client.query(
        `UPDATE shipping_financial_policies SET active = false, effective_to = now(), updated_at = now()
          WHERE leg = $1 AND (supplier_id = $2 OR (supplier_id IS NULL AND $2::uuid IS NULL)) AND active`,
        [body.leg, body.supplierId ?? null]);
      const id = randomUUID();
      await client.query(
        `INSERT INTO shipping_financial_policies(id, name, leg, payer, supplier_share_percent, method, amount_rial,
           supplier_id, version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, body.name, body.leg, body.payer, body.supplierSharePercent, body.method, body.amountRial,
          body.supplierId ?? null, (previous?.version ?? 0) + 1, user.id]);
      await audit(client, user.id, 'shipping_policy.created', 'shipping_financial_policy', id, undefined,
        { ...body, version: (previous?.version ?? 0) + 1 }, request.ip);
      return { id, version: (previous?.version ?? 0) + 1 };
    });
  });

  /* ============== Admin: provider reconciliation (§68-§72, §195) ============== */
  app.get('/api/v1/admin/finance/provider-reconciliations', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'finance:reconcile');
    const query = pageQuery.extend({
      status: z.enum(['unreconciled', 'matched', 'exception']).optional(),
      provider: z.string().trim().max(40).optional(),
    }).parse(request.query ?? {});
    const conditions: string[] = []; const params: unknown[] = [];
    if (query.status) { params.push(query.status); conditions.push(`r.status = $${params.length}`); }
    if (query.provider) { params.push(query.provider); conditions.push(`r.provider = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const rows = await pool.query(
      `SELECT r.id, r.provider, r.payment_intent_id, r.provider_reference, r.amount_rial::text AS amount_rial,
              r.status, r.source, r.external_reference, r.statement_batch, r.checked_at, r.note, r.created_at
         FROM provider_reconciliations r
        ${where} ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    // Intents with no reconciliation row at all = honest "unknown" (§70).
    const unknown = await one<{ count: string }>(pool,
      `SELECT COUNT(*)::text AS count FROM payment_intents pi
        WHERE pi.status = 'succeeded' AND NOT EXISTS (SELECT 1 FROM provider_reconciliations r WHERE r.payment_intent_id = pi.id)`, []);
    return { items: rows.rows, unreconciledIntents: Number(unknown?.count ?? '0') };
  });

  /** Record a reconciliation check — source is always explicit, never fabricated (§129). */
  app.post('/api/v1/admin/finance/provider-reconciliations', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'finance:reconcile');
    const body = z.object({
      paymentIntentId: z.uuid(),
      source: z.enum(['api', 'statement', 'manual']),
      externalReference: z.string().trim().max(160).optional(),
      statementBatch: z.string().trim().max(120).optional(),
      matched: z.boolean(),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body);
    if (body.source === 'statement' && !body.statementBatch) throw badRequest('شناسه صورتحساب بانکی برای حالت statement الزامی است.');
    return transaction(pool, async (client) => {
      const intent = await one<{ id: string; provider: string; amount_rial: string; provider_reference: string | null; status: string }>(client,
        'SELECT id, provider, amount_rial::text, provider_reference, status FROM payment_intents WHERE id = $1', [body.paymentIntentId]);
      if (!intent) throw notFound('Payment intent پیدا نشد.');
      const status = body.matched ? 'matched' : 'exception';
      const existing = await one<{ id: string }>(client,
        'SELECT id FROM provider_reconciliations WHERE payment_intent_id = $1 FOR UPDATE', [body.paymentIntentId]);
      let id = existing?.id ?? randomUUID();
      if (existing) {
        await client.query(
          `UPDATE provider_reconciliations SET status = $2, source = $3, external_reference = $4,
             statement_batch = $5, checked_at = now(), note = $6, updated_at = now() WHERE id = $1`,
          [id, status, body.source, body.externalReference ?? null, body.statementBatch ?? null, body.note ?? null]);
      } else {
        await client.query(
          `INSERT INTO provider_reconciliations(id, provider, payment_intent_id, provider_reference, amount_rial,
             status, source, external_reference, statement_batch, checked_at, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,$11)`,
          [id, intent.provider, intent.id, intent.provider_reference, intent.amount_rial,
            status, body.source, body.externalReference ?? null, body.statementBatch ?? null, body.note ?? null, user.id]);
      }
      if (!body.matched) {
        await financeEvent(client, 'reconciliation.exception', 'payment_intent', intent.id,
          { paymentIntentId: intent.id, provider: intent.provider, source: body.source, note: body.note ?? null });
      }
      await audit(client, user.id, 'provider_reconciliation.recorded', 'provider_reconciliation', id, undefined,
        { paymentIntentId: intent.id, status, source: body.source }, request.ip);
      return { id, status };
    });
  });

  /* ====== Finance policy settings (hold hours / cooldown / legacy flag) ====== */
  app.get('/api/v1/admin/finance/supplier-finance-policy', async (request) => {
    const user = await principal(request, pool, config); canReadFinance(user);
    return supplierFinancePolicy(pool);
  });

  app.put('/api/v1/admin/finance/supplier-finance-policy', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({
      holdHours: z.number().int().min(0).max(24 * 90).optional(),
      bankCooldownHours: z.number().int().min(0).max(24 * 30).optional(),
      dualControlThresholdRial: z.string().regex(/^\d+$/).optional(),
      legacyWithdrawalsEnabled: z.boolean().optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const current = await supplierFinancePolicy(client);
      const next = { ...current, ...body };
      await client.query(
        `INSERT INTO site_settings(key, value, updated_by, updated_at) VALUES ('supplier_finance_policy', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`,
        [JSON.stringify(next), user.id]);
      await audit(client, user.id, 'finance_policy.updated', 'site_setting', 'supplier_finance_policy', current, next, request.ip);
      return next;
    });
  });

}
