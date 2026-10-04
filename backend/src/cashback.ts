import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { rial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

/* ============================================================================
 * Retail cashback wallet — loyalty credit. NO withdrawal, NO transfer, NO cash-out.
 * Ledger = source of truth (cashback_transactions); balances are derived sums.
 *
 * Buckets: 'pending' (earned, not yet usable) and 'available' (spendable).
 *   pendingBalance   = SUM(amount) over bucket='pending'
 *   availableBalance = SUM(amount) over bucket='available'  (kept >= 0 by construction)
 *
 * Lifecycle (all idempotent via unique idempotency_key):
 *   paid       → +X pending                     (cb-earn:{orderId})
 *   delivered  → stamp available_at/expires_at on the earn row (no new money)
 *   lazy flip  → when available_at <= now: −X pending / +X available pair
 *                (cb-rel-out:{earnId} / cb-rel-in:{earnId}) — run on every read
 *                inside the per-customer lock, so a scheduler is not required
 *                and a crashed flip simply re-runs.
 *   expiry     → when expires_at <= now and credit still unused:
 *                −min(remaining, available) available (cb-exp:{earnId}).
 *                Bounded by the live available balance → the wallet can never go
 *                negative even though redemptions are not attributed per-earn
 *                (documented simplification: redemptions implicitly consume the
 *                oldest credit).
 *   cancel     → reverse earn remaining (pending first, then available), bounded.
 *   redeem     → one per order (cb-redeem:{orderId}), −X available, inside the
 *                SAME transaction that creates the order (race-safe via advisory
 *                lock + unique key: double click / duplicate callback = no-op).
 *   refund     → restore redeemed proportionally (cb-restore:{returnId}), capped
 *                at redeemed − already restored; and reverse the earned credit of
 *                the refunded order (bounded — shortfall is recorded in metadata,
 *                never pushed below zero: «bounded debt» policy).
 *
 * Earning basis = eligible merchandise net after promotions + coupon,
 * excluding shipping and excluding the wallet-paid portion of the order.
 * ========================================================================== */

const POLICY_KEY = 'cashback_policy';

export type CashbackPolicy = {
  redemptionEnabled: boolean;
  maxPercentOfOrder: number;       // cap: % of (merchandise net) payable by wallet
  minRedeemRial: string;           // smallest redemption amount
  earnOnInstallments: boolean;     // conservative default: false
  redeemOnInstallments: boolean;   // conservative default: false
};

const DEFAULT_POLICY: CashbackPolicy = {
  redemptionEnabled: true, maxPercentOfOrder: 50, minRedeemRial: '100000',
  earnOnInstallments: false, redeemOnInstallments: false,
};

export async function cashbackPolicy(db: DbClient | DbPool): Promise<CashbackPolicy> {
  const row = await one<{ value: Partial<CashbackPolicy> }>(db, 'SELECT value FROM site_settings WHERE key = $1', [POLICY_KEY]);
  return { ...DEFAULT_POLICY, ...(row?.value ?? {}) };
}

/** Serialize every wallet mutation per customer (double click, concurrent checkouts, dup callbacks). */
async function lockWallet(client: DbClient, customerId: string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('cashback:' || $1))`, [customerId]);
}

async function insertTx(client: DbClient, tx: {
  customerId: string; type: string; bucket: 'pending' | 'available'; amountRial: bigint;
  source?: string; orderId?: string | null; ruleId?: string | null; relatedTxId?: string | null;
  description?: string | null; actorId?: string | null; metadata?: Record<string, unknown>;
  availableAt?: string | null; expiresAt?: string | null; idempotencyKey?: string | null;
}): Promise<string | null> {
  if (tx.amountRial === 0n) return null;
  const id = randomUUID();
  const res = await client.query(
    `INSERT INTO cashback_transactions(
       id, customer_id, tx_type, bucket, amount_rial, source, source_order_id, source_rule_id,
       related_tx_id, description, actor_id, metadata, available_at, expires_at, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [id, tx.customerId, tx.type, tx.bucket, tx.amountRial.toString(), tx.source ?? 'order',
     tx.orderId ?? null, tx.ruleId ?? null, tx.relatedTxId ?? null, tx.description ?? null,
     tx.actorId ?? null, JSON.stringify(tx.metadata ?? {}), tx.availableAt ?? null,
     tx.expiresAt ?? null, tx.idempotencyKey ?? null]);
  return res.rows.length ? id : null; // null = idempotent replay, nothing inserted
}

type Balances = { pendingRial: bigint; availableRial: bigint; usedRial: bigint; expiredRial: bigint };

async function rawBalances(client: DbClient, customerId: string): Promise<Balances> {
  const row = await one<{ pending: string; available: string; used: string; expired: string }>(client,
    `SELECT
       COALESCE(SUM(amount_rial) FILTER (WHERE bucket = 'pending'), 0)::text AS pending,
       COALESCE(SUM(amount_rial) FILTER (WHERE bucket = 'available'), 0)::text AS available,
       COALESCE(-SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_redeemed'), 0)::text AS used,
       COALESCE(-SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_expired'), 0)::text AS expired
     FROM cashback_transactions WHERE customer_id = $1`, [customerId]);
  return {
    pendingRial: BigInt(row!.pending), availableRial: BigInt(row!.available),
    usedRial: BigInt(row!.used), expiredRial: BigInt(row!.expired),
  };
}

/** How much of an earn row is still un-consumed by release/reversal rows that reference it. */
async function earnRemaining(client: DbClient, earnId: string, bucket: 'pending' | 'available'): Promise<bigint> {
  const earn = await one<{ amount_rial: string }>(client,
    `SELECT amount_rial FROM cashback_transactions WHERE id = $1`, [earnId]);
  if (!earn) return 0n;
  const consumed = await one<{ total: string }>(client,
    `SELECT COALESCE(SUM(-amount_rial), 0)::text AS total FROM cashback_transactions
     WHERE related_tx_id = $1 AND bucket = $2 AND amount_rial < 0`, [earnId, bucket]);
  const remaining = BigInt(earn.amount_rial) - BigInt(consumed!.total);
  return remaining > 0n ? remaining : 0n;
}

/**
 * Lazy lifecycle settlement for one customer: flip matured pending credit to available and
 * expire dead credit. Idempotent (unique keys), run under the wallet lock before any read
 * or mutation that depends on the balance.
 */
export async function settleCashbackLifecycle(client: DbClient, customerId: string): Promise<void> {
  // 1) release matured earns
  const matured = await client.query<{ id: string; expires_at: string | null }>(
    `SELECT e.id, e.expires_at FROM cashback_transactions e
     WHERE e.customer_id = $1 AND e.tx_type = 'cashback_pending' AND e.available_at IS NOT NULL
       AND e.available_at <= now()
       AND NOT EXISTS (SELECT 1 FROM cashback_transactions r
                       WHERE r.related_tx_id = e.id AND r.tx_type = 'cashback_released')
     ORDER BY e.created_at`, [customerId]);
  for (const earn of matured.rows) {
    const remaining = await earnRemaining(client, earn.id, 'pending');
    if (remaining <= 0n) continue;
    await insertTx(client, { customerId, type: 'cashback_released', bucket: 'pending', amountRial: -remaining,
      source: 'release', relatedTxId: earn.id, idempotencyKey: `cb-rel-out:${earn.id}`, description: 'آزادسازی اعتبار پس از تحویل' });
    await insertTx(client, { customerId, type: 'cashback_released', bucket: 'available', amountRial: remaining,
      source: 'release', relatedTxId: earn.id, idempotencyKey: `cb-rel-in:${earn.id}`, description: 'آزادسازی اعتبار پس از تحویل' });
  }
  // 2) expire released-but-unused credit past its expiry
  const dead = await client.query<{ id: string }>(
    `SELECT e.id FROM cashback_transactions e
     WHERE e.customer_id = $1 AND e.tx_type = 'cashback_pending' AND e.expires_at IS NOT NULL
       AND e.expires_at <= now()
       AND EXISTS (SELECT 1 FROM cashback_transactions r
                   WHERE r.related_tx_id = e.id AND r.tx_type = 'cashback_released' AND r.bucket = 'available')
       AND NOT EXISTS (SELECT 1 FROM cashback_transactions x
                       WHERE x.related_tx_id = e.id AND x.tx_type = 'cashback_expired')
     ORDER BY e.created_at`, [customerId]);
  for (const earn of dead.rows) {
    const remaining = await earnRemaining(client, earn.id, 'available');
    if (remaining <= 0n) continue;
    const { availableRial } = await rawBalances(client, customerId);
    const amount = remaining < availableRial ? remaining : (availableRial > 0n ? availableRial : 0n);
    if (amount <= 0n) {
      // nothing left to expire (already spent) — mark with a zero-impact metadata row is not
      // allowed (amount<>0), so record the terminal state via the idempotency key with 1-rial?
      // No: simply skip; the NOT EXISTS guard will re-check next time and keep skipping once
      // the available balance stays 0 for this earn (remaining>0 but spent globally = consumed).
      continue;
    }
    await insertTx(client, { customerId, type: 'cashback_expired', bucket: 'available', amountRial: -amount,
      source: 'expiry', relatedTxId: earn.id, idempotencyKey: `cb-exp:${earn.id}`, description: 'انقضای اعتبار استفاده‌نشده' });
  }
}

export async function cashbackBalances(client: DbClient, customerId: string): Promise<Balances> {
  await lockWallet(client, customerId);
  await settleCashbackLifecycle(client, customerId);
  return rawBalances(client, customerId);
}

/* ------------------------------- earning ------------------------------- */

type RuleRow = {
  id: string; name: string; priority: number; percent: number | null; fixed_rial: string | null;
  min_order_rial: string; max_per_order_rial: string | null; min_quantity: number | null;
  first_order_only: boolean; max_uses_per_customer: number | null; payment_modes: string[];
  customer_scope: { vipOnly?: boolean }; product_scope: {
    includeCategories?: string[]; excludeCategories?: string[];
    includeProductIds?: string[]; excludeProductIds?: string[];
  };
  release_delay_days: number; expiration_days: number | null; stacking: 'exclusive' | 'stack';
};

/** Eligible merchandise net for a rule: line totals filtered by scope, scaled by the
 *  order-level discount and wallet factors (proportional attribution, documented). */
function eligibleBasis(
  lines: { product_id: string; category: string; line_total_rial: string }[],
  rule: RuleRow, merchNet: bigint, merchBase: bigint, walletUsed: bigint,
): bigint {
  const scope = rule.product_scope ?? {};
  const included = lines.filter((line) => {
    if (scope.includeProductIds?.length && !scope.includeProductIds.includes(line.product_id)) return false;
    if (scope.excludeProductIds?.includes(line.product_id)) return false;
    if (scope.includeCategories?.length && !scope.includeCategories.includes(line.category)) return false;
    if (scope.excludeCategories?.includes(line.category)) return false;
    return true;
  });
  const eligibleBase = included.reduce((sum, line) => sum + BigInt(line.line_total_rial), 0n);
  if (eligibleBase <= 0n || merchBase <= 0n) return 0n;
  // scale by (net after all discounts) / base, then remove the wallet-paid share
  const netAfterWallet = merchNet - walletUsed;
  if (netAfterWallet <= 0n) return 0n;
  return (eligibleBase * netAfterWallet) / merchBase;
}

/**
 * Earn hook — call when a RETAIL order becomes paid (gateway callback or manual transition).
 * Idempotent per order. Never throws business errors into the payment path: an order that
 * matches no rule simply earns nothing.
 */
export async function earnCashbackOnPaid(client: DbClient, orderId: string): Promise<void> {
  const order = await one<{
    id: string; buyer_id: string; order_type: string; payment_mode: string; status: string;
    subtotal_rial: string; discount_rial: string; cashback_redeemed_rial: string;
  }>(client, `SELECT id, buyer_id, order_type, payment_mode, status, subtotal_rial, discount_rial,
                     COALESCE(cashback_redeemed_rial, 0)::text AS cashback_redeemed_rial
              FROM orders WHERE id = $1`, [orderId]);
  if (!order || order.order_type !== 'retail') return;
  const policy = await cashbackPolicy(client);
  if (order.payment_mode !== 'cash' && !policy.earnOnInstallments) return;
  await lockWallet(client, order.buyer_id);
  const already = await one<{ id: string }>(client,
    `SELECT id FROM cashback_transactions WHERE idempotency_key = $1`, [`cb-earn:${orderId}`]);
  if (already) return;

  const lines = (await client.query<{ product_id: string; category: string; line_total_rial: string }>(
    `SELECT l.product_id, COALESCE(p.category, '') AS category, l.line_total_rial::text
     FROM order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.order_id = $1`, [orderId])).rows;
  const merchBase = BigInt(order.subtotal_rial);
  const merchNet = merchBase - BigInt(order.discount_rial);
  const walletUsed = BigInt(order.cashback_redeemed_rial);
  const quantityRow = await one<{ qty: string }>(client,
    `SELECT COALESCE(SUM(quantity), 0)::text AS qty FROM order_lines WHERE order_id = $1`, [orderId]);
  const totalQty = Number(quantityRow!.qty);

  const rules = (await client.query<RuleRow>(
    `SELECT * FROM cashback_rules
     WHERE active = true AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at >= now())
     ORDER BY priority ASC, created_at ASC`)).rows;

  const isVip = !!(await one<{ x: number }>(client,
    `SELECT 1 AS x FROM user_roles WHERE user_id = $1 AND role_code = 'vip'`, [order.buyer_id]));
  const priorPaidOrders = await one<{ n: string }>(client,
    `SELECT count(*)::text AS n FROM orders
     WHERE buyer_id = $1 AND id <> $2 AND status NOT IN ('pending_payment','cancelled')`, [order.buyer_id, orderId]);
  const matches: RuleRow[] = [];
  for (const rule of rules) {
    if (!rule.payment_modes.includes(order.payment_mode)) continue;
    if (merchNet < BigInt(rule.min_order_rial)) continue;
    if (rule.min_quantity !== null && totalQty < rule.min_quantity) continue;
    if (rule.first_order_only && Number(priorPaidOrders!.n) > 0) continue;
    if (rule.customer_scope?.vipOnly && !isVip) continue;
    if (rule.max_uses_per_customer !== null) {
      const uses = await one<{ n: string }>(client,
        `SELECT count(*)::text AS n FROM cashback_transactions
         WHERE customer_id = $1 AND source_rule_id = $2 AND tx_type = 'cashback_pending'`,
        [order.buyer_id, rule.id]);
      if (Number(uses!.n) >= rule.max_uses_per_customer) continue;
    }
    matches.push(rule);
  }
  if (!matches.length) return;
  // highest priority rule wins; additional 'stack' rules stack on top of a 'stack' winner
  const winner = matches[0]!;
  const applied = winner.stacking === 'stack' ? matches.filter((rule) => rule.stacking === 'stack') : [winner];

  let suffix = 0;
  for (const rule of applied) {
    const basis = eligibleBasis(lines, rule, merchNet, merchBase, walletUsed);
    if (basis <= 0n) continue;
    let amount = rule.percent !== null ? (basis * BigInt(rule.percent)) / 100n : BigInt(rule.fixed_rial!);
    if (rule.max_per_order_rial !== null && amount > BigInt(rule.max_per_order_rial)) amount = BigInt(rule.max_per_order_rial);
    if (amount > basis) amount = basis; // cashback never exceeds what the customer actually paid
    if (amount <= 0n) continue;
    const key = suffix === 0 ? `cb-earn:${orderId}` : `cb-earn:${orderId}:${rule.id}`;
    suffix += 1;
    const txId = await insertTx(client, {
      customerId: order.buyer_id, type: 'cashback_pending', bucket: 'pending', amountRial: amount,
      source: 'rule', orderId, ruleId: rule.id, idempotencyKey: key,
      description: `کش‌بک قانون «${rule.name}»`,
      metadata: { basisRial: basis.toString(), releaseDelayDays: rule.release_delay_days, expirationDays: rule.expiration_days },
    });
    if (txId) await outbox(client, 'cashback.earned', 'cashback', txId, { orderId, customerId: order.buyer_id, amountRial: amount.toString() });
  }
}

/** Delivery hook: stamp the release/expiry schedule on the pending earns of this order. */
export async function scheduleCashbackRelease(client: DbClient, orderId: string): Promise<void> {
  await client.query(
    `UPDATE cashback_transactions e SET
       available_at = now() + make_interval(days => COALESCE((e.metadata->>'releaseDelayDays')::int, 7)),
       expires_at   = CASE WHEN e.metadata->>'expirationDays' IS NULL THEN NULL
                           ELSE now() + make_interval(days => COALESCE((e.metadata->>'releaseDelayDays')::int, 7)
                                                            + (e.metadata->>'expirationDays')::int) END
     WHERE e.source_order_id = $1 AND e.tx_type = 'cashback_pending' AND e.available_at IS NULL`, [orderId]);
}

/**
 * Cancel/refund hook: reverse this order's earned credit (bounded ≥ 0).
 * Full reversal by default; pass `portion` for partial (line-level) refunds — the reversal is
 * proportional to refund/merchandise and each partial event gets its own idempotency suffix.
 */
export async function reverseCashbackForOrder(
  client: DbClient, orderId: string, actorId: string | null, reason: string,
  opts?: { portion?: { refundRial: bigint; orderMerchRial: bigint }; idemSuffix?: string },
): Promise<void> {
  const earns = (await client.query<{ id: string; customer_id: string; amount_rial: string }>(
    `SELECT id, customer_id, amount_rial::text FROM cashback_transactions
     WHERE source_order_id = $1 AND tx_type = 'cashback_pending'`, [orderId])).rows;
  for (const earn of earns) {
    await lockWallet(client, earn.customer_id);
    await settleCashbackLifecycle(client, earn.customer_id);
    const key = opts?.idemSuffix ? `cb-rev:${earn.id}:${opts.idemSuffix}` : `cb-rev:${earn.id}`;
    const targetFromPortion = opts?.portion && opts.portion.orderMerchRial > 0n
      ? (BigInt(earn.amount_rial) * opts.portion.refundRial) / opts.portion.orderMerchRial
      : null;
    const pendingLeft = await earnRemaining(client, earn.id, 'pending');
    const releasedRow = await one<{ id: string }>(client,
      `SELECT id FROM cashback_transactions WHERE related_tx_id = $1 AND tx_type = 'cashback_released' AND bucket = 'available'`, [earn.id]);
    if (!releasedRow && pendingLeft > 0n) {
      let amount = targetFromPortion !== null && targetFromPortion < pendingLeft ? targetFromPortion : pendingLeft;
      if (amount <= 0n) continue;
      await insertTx(client, { customerId: earn.customer_id, type: 'cashback_reversed', bucket: 'pending',
        amountRial: -amount, source: 'refund', orderId, relatedTxId: earn.id,
        actorId, idempotencyKey: key, description: reason });
      continue;
    }
    // already released: claw back only down to zero (bounded debt policy — the shortfall is
    // recorded in metadata, the wallet is never pushed negative)
    const availableLeft = await earnRemaining(client, earn.id, 'available');
    if (availableLeft <= 0n) continue;
    let target = targetFromPortion !== null && targetFromPortion < availableLeft ? targetFromPortion : availableLeft;
    const { availableRial } = await rawBalances(client, earn.customer_id);
    const amount = target < availableRial ? target : (availableRial > 0n ? availableRial : 0n);
    if (amount <= 0n) continue;
    await insertTx(client, { customerId: earn.customer_id, type: 'cashback_reversed', bucket: 'available',
      amountRial: -amount, source: 'refund', orderId, relatedTxId: earn.id, actorId,
      idempotencyKey: key,
      description: reason,
      metadata: { requestedRial: target.toString(), shortfallRial: (target - amount).toString() } });
  }
}

/** Refund hook: give back the credit the customer SPENT on this order (idempotent, capped). */
export async function restoreRedeemedCashback(
  client: DbClient, orderId: string, idemSuffix: string, actorId: string | null,
  portion?: { refundRial: bigint; orderMerchRial: bigint },
): Promise<void> {
  const redeemed = await one<{ customer_id: string; total: string }>(client,
    `SELECT customer_id, COALESCE(-SUM(amount_rial), 0)::text AS total FROM cashback_transactions
     WHERE source_order_id = $1 AND tx_type = 'cashback_redeemed' GROUP BY customer_id`, [orderId]);
  if (!redeemed || BigInt(redeemed.total) <= 0n) return;
  await lockWallet(client, redeemed.customer_id);
  const restored = await one<{ total: string }>(client,
    `SELECT COALESCE(SUM(amount_rial), 0)::text AS total FROM cashback_transactions
     WHERE source_order_id = $1 AND tx_type = 'refund_restore'`, [orderId]);
  const cap = BigInt(redeemed.total) - BigInt(restored!.total);
  if (cap <= 0n) return;
  let amount = cap;
  if (portion && portion.orderMerchRial > 0n) {
    const proportional = (BigInt(redeemed.total) * portion.refundRial) / portion.orderMerchRial;
    amount = proportional < cap ? proportional : cap;
  }
  if (amount <= 0n) return;
  const txId = await insertTx(client, { customerId: redeemed.customer_id, type: 'refund_restore', bucket: 'available',
    amountRial: amount, source: 'refund', orderId, actorId,
    idempotencyKey: `cb-restore:${orderId}:${idemSuffix}`, description: 'بازگشت اعتبار استفاده‌شده پس از مرجوعی' });
  if (txId) await outbox(client, 'cashback.restored', 'cashback', txId, { orderId, amountRial: amount.toString() });
}

/* ------------------------------ redemption ------------------------------ */

export type RedemptionQuote = { maxRedeemRial: bigint; availableRial: bigint; enabled: boolean; reason: string | null };

/** Server-authoritative cap for how much wallet credit may pay for a given order basis. */
export async function quoteRedemption(
  client: DbClient, customerId: string, merchNetRial: bigint, paymentMode: string, orderType: string,
): Promise<RedemptionQuote> {
  const policy = await cashbackPolicy(client);
  if (!policy.redemptionEnabled) return { maxRedeemRial: 0n, availableRial: 0n, enabled: false, reason: 'استفاده از کیف پول کش‌بک غیرفعال است.' };
  if (orderType !== 'retail') return { maxRedeemRial: 0n, availableRial: 0n, enabled: false, reason: 'کیف پول کش‌بک فقط برای خرید خرده است.' };
  if (paymentMode !== 'cash' && !policy.redeemOnInstallments) return { maxRedeemRial: 0n, availableRial: 0n, enabled: false, reason: 'استفاده از کیف پول در پرداخت اقساطی فعال نیست.' };
  const { availableRial } = await cashbackBalances(client, customerId);
  const percentCap = (merchNetRial * BigInt(Math.min(Math.max(policy.maxPercentOfOrder, 0), 100))) / 100n;
  let max = availableRial < percentCap ? availableRial : percentCap;
  if (max < BigInt(policy.minRedeemRial)) max = 0n;
  return { maxRedeemRial: max, availableRial, enabled: true, reason: null };
}

/**
 * Redeem inside the order-creation transaction. Throws a readable error when the request
 * exceeds the server-side cap. Idempotent per order (cb-redeem:{orderId}).
 */
export async function redeemCashback(
  client: DbClient, customerId: string, orderId: string, requestedRial: bigint,
  merchNetRial: bigint, paymentMode: string, orderType: string,
): Promise<bigint> {
  if (requestedRial <= 0n) return 0n;
  const quote = await quoteRedemption(client, customerId, merchNetRial, paymentMode, orderType);
  if (!quote.enabled) throw badRequest(quote.reason ?? 'استفاده از کیف پول ممکن نیست.');
  if (requestedRial > quote.maxRedeemRial) {
    throw badRequest(`حداکثر مبلغ قابل استفاده از کیف پول ${quote.maxRedeemRial.toString()} ریال است.`);
  }
  const txId = await insertTx(client, { customerId, type: 'cashback_redeemed', bucket: 'available',
    amountRial: -requestedRial, source: 'order', orderId,
    idempotencyKey: `cb-redeem:${orderId}`, description: 'استفاده از اعتبار کش‌بک در پرداخت سفارش' });
  if (!txId) {
    // replay (double submit with same idempotent order id) — the previous redemption stands
    return requestedRial;
  }
  await outbox(client, 'cashback.redeemed', 'cashback', txId, { orderId, customerId, amountRial: requestedRial.toString() });
  return requestedRial;
}

/* -------------------------------- routes -------------------------------- */

const ruleBase = z.object({
  name: z.string().trim().min(2).max(120),
  active: z.boolean().default(true),
  priority: z.number().int().min(1).max(10000).default(100),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  percent: z.number().int().min(1).max(100).nullable().optional(),
  fixedRial: z.string().regex(/^\d+$/).nullable().optional(),
  minOrderRial: z.string().regex(/^\d+$/).default('0'),
  maxPerOrderRial: z.string().regex(/^\d+$/).nullable().optional(),
  minQuantity: z.number().int().min(1).nullable().optional(),
  firstOrderOnly: z.boolean().default(false),
  maxUsesPerCustomer: z.number().int().min(1).nullable().optional(),
  paymentModes: z.array(z.enum(['cash', 'four_installments'])).min(1).default(['cash']),
  customerScope: z.object({ vipOnly: z.boolean().optional() }).default({}),
  productScope: z.object({
    includeCategories: z.array(z.string()).optional(), excludeCategories: z.array(z.string()).optional(),
    includeProductIds: z.array(z.string()).optional(), excludeProductIds: z.array(z.string()).optional(),
  }).default({}),
  releaseDelayDays: z.number().int().min(0).max(365).default(7),
  expirationDays: z.number().int().min(1).max(3650).nullable().optional(),
  stacking: z.enum(['exclusive', 'stack']).default('exclusive'),
}).strict();

const ruleBody = ruleBase.refine((value) => (value.percent != null) !== (value.fixedRial != null), {
  message: 'دقیقاً یکی از «درصد» یا «مبلغ ثابت» باید تعیین شود.',
});
// PATCH payload: any subset of fields; the percent/fixed exclusivity only applies when one of
// them is actually being changed (switching type nulls the other side explicitly).
const rulePatch = ruleBase.partial().refine(
  (value) => value.percent == null || value.fixedRial == null,
  { message: 'درصد و مبلغ ثابت هم‌زمان مجاز نیست.' });

export function registerCashbackRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ---- customer wallet ---- */
  app.get('/api/v1/cashback/wallet', async (request) => {
    const user = await principal(request, pool, config);
    return transaction(pool, async (client) => {
      const balances = await cashbackBalances(client, user.id);
      const txs = await client.query(
        `SELECT t.id, t.tx_type, t.bucket, t.amount_rial::text, t.description, t.available_at, t.expires_at,
                t.created_at, o.reference AS order_reference
         FROM cashback_transactions t LEFT JOIN orders o ON o.id = t.source_order_id
         WHERE t.customer_id = $1 ORDER BY t.created_at DESC LIMIT 100`, [user.id]);
      const policy = await cashbackPolicy(client);
      return {
        pendingRial: balances.pendingRial.toString(), availableRial: balances.availableRial.toString(),
        usedRial: balances.usedRial.toString(), expiredRial: balances.expiredRial.toString(),
        policy: { redemptionEnabled: policy.redemptionEnabled, maxPercentOfOrder: policy.maxPercentOfOrder, minRedeemRial: policy.minRedeemRial, redeemOnInstallments: policy.redeemOnInstallments },
        items: txs.rows,
      };
    });
  });

  /** Checkout helper: how much of the wallet may pay for a given basket subtotal. */
  app.get('/api/v1/cashback/redemption-quote', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      merchNetRial: z.string().regex(/^\d+$/),
      paymentMode: z.enum(['cash', 'four_installments']).default('cash'),
    }).parse(request.query);
    return transaction(pool, async (client) => {
      const quote = await quoteRedemption(client, user.id, rial(query.merchNetRial), query.paymentMode, 'retail');
      return { enabled: quote.enabled, reason: quote.reason,
        availableRial: quote.availableRial.toString(), maxRedeemRial: quote.maxRedeemRial.toString() };
    });
  });

  /* ---- admin: overview ---- */
  app.get('/api/v1/admin/cashback/overview', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    const totals = await one<{ pending: string; available: string; used: string; expired: string; customers: string }>(pool,
      `SELECT COALESCE(SUM(amount_rial) FILTER (WHERE bucket = 'pending'), 0)::text AS pending,
              COALESCE(SUM(amount_rial) FILTER (WHERE bucket = 'available'), 0)::text AS available,
              COALESCE(-SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_redeemed'), 0)::text AS used,
              COALESCE(-SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_expired'), 0)::text AS expired,
              count(DISTINCT customer_id)::text AS customers
       FROM cashback_transactions`);
    const last30 = await one<{ earned: string; redeemed: string }>(pool,
      `SELECT COALESCE(SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_pending'), 0)::text AS earned,
              COALESCE(-SUM(amount_rial) FILTER (WHERE tx_type = 'cashback_redeemed'), 0)::text AS redeemed
       FROM cashback_transactions WHERE created_at >= now() - interval '30 days'`);
    return {
      liabilityRial: (BigInt(totals!.pending) + BigInt(totals!.available)).toString(),
      pendingRial: totals!.pending, availableRial: totals!.available,
      usedRial: totals!.used, expiredRial: totals!.expired, customers: Number(totals!.customers),
      last30: { earnedRial: last30!.earned, redeemedRial: last30!.redeemed },
    };
  });

  /* ---- admin: rules CRUD ---- */
  app.get('/api/v1/admin/cashback/rules', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    const rows = await pool.query(`SELECT * FROM cashback_rules ORDER BY priority ASC, created_at ASC`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/cashback/rules', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:rules_manage');
    const body = ruleBody.parse(request.body);
    const id = randomUUID();
    return transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO cashback_rules(id, name, active, priority, starts_at, ends_at, percent, fixed_rial,
           min_order_rial, max_per_order_rial, min_quantity, first_order_only, max_uses_per_customer,
           payment_modes, customer_scope, product_scope, release_delay_days, expiration_days, stacking, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [id, body.name, body.active, body.priority, body.startsAt ?? null, body.endsAt ?? null,
         body.percent ?? null, body.fixedRial ?? null, body.minOrderRial, body.maxPerOrderRial ?? null,
         body.minQuantity ?? null, body.firstOrderOnly, body.maxUsesPerCustomer ?? null,
         body.paymentModes, JSON.stringify(body.customerScope), JSON.stringify(body.productScope),
         body.releaseDelayDays, body.expirationDays ?? null, body.stacking, user.id]);
      await audit(client, user.id, 'cashback.rule_created', 'cashback_rule', id, undefined, body, request.ip);
      return reply.code(201).send({ id });
    });
  });

  app.patch('/api/v1/admin/cashback/rules/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:rules_manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = rulePatch.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cashback_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const mapping: [string, unknown][] = [
        ['name', body.name], ['active', body.active], ['priority', body.priority],
        ['starts_at', body.startsAt], ['ends_at', body.endsAt], ['percent', body.percent],
        ['fixed_rial', body.fixedRial], ['min_order_rial', body.minOrderRial],
        ['max_per_order_rial', body.maxPerOrderRial], ['min_quantity', body.minQuantity],
        ['first_order_only', body.firstOrderOnly], ['max_uses_per_customer', body.maxUsesPerCustomer],
        ['payment_modes', body.paymentModes],
        ['customer_scope', body.customerScope ? JSON.stringify(body.customerScope) : undefined],
        ['product_scope', body.productScope ? JSON.stringify(body.productScope) : undefined],
        ['release_delay_days', body.releaseDelayDays], ['expiration_days', body.expirationDays],
        ['stacking', body.stacking],
      ];
      const sets: string[] = []; const values: unknown[] = [id];
      for (const [column, value] of mapping) {
        if (value === undefined) continue;
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (!sets.length) throw badRequest('هیچ فیلدی برای تغییر ارسال نشده است.');
      await client.query(`UPDATE cashback_rules SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
      await audit(client, user.id, 'cashback.rule_updated', 'cashback_rule', id, before, body, request.ip);
      return { id };
    });
  });

  /* ---- admin: wallets / transactions / expiring ---- */
  app.get('/api/v1/admin/cashback/wallets', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    const query = z.object({
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT t.customer_id, u.display_name, u.phone, u.email,
              COALESCE(SUM(t.amount_rial) FILTER (WHERE t.bucket = 'pending'), 0)::text AS pending_rial,
              COALESCE(SUM(t.amount_rial) FILTER (WHERE t.bucket = 'available'), 0)::text AS available_rial,
              COALESCE(-SUM(t.amount_rial) FILTER (WHERE t.tx_type = 'cashback_redeemed'), 0)::text AS used_rial,
              COALESCE(-SUM(t.amount_rial) FILTER (WHERE t.tx_type = 'cashback_expired'), 0)::text AS expired_rial,
              max(t.created_at) AS last_activity_at,
              count(*) OVER()::int AS total_rows
       FROM cashback_transactions t JOIN users u ON u.id = t.customer_id
       WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
       GROUP BY t.customer_id, u.display_name, u.phone, u.email
       ORDER BY max(t.created_at) DESC LIMIT $2 OFFSET $3`,
      [query.search ?? null, query.limit, query.offset]);
    const total = rows.rows.length ? Number((rows.rows[0] as { total_rows: number }).total_rows) : 0;
    return { total, items: rows.rows.map(({ total_rows: _t, ...rest }) => rest) };
  });

  app.get('/api/v1/admin/cashback/transactions', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    const query = z.object({
      customerId: z.uuid().optional(),
      type: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT t.*, t.amount_rial::text AS amount_rial, u.display_name AS customer_name, o.reference AS order_reference,
              count(*) OVER()::int AS total_rows
       FROM cashback_transactions t
       JOIN users u ON u.id = t.customer_id
       LEFT JOIN orders o ON o.id = t.source_order_id
       WHERE ($1::uuid IS NULL OR t.customer_id = $1) AND ($2::text IS NULL OR t.tx_type = $2)
       ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [query.customerId ?? null, query.type ?? null, query.limit, query.offset]);
    const total = rows.rows.length ? Number((rows.rows[0] as { total_rows: number }).total_rows) : 0;
    return { total, items: rows.rows.map(({ total_rows: _t, ...rest }) => rest) };
  });

  app.get('/api/v1/admin/cashback/expiring', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.id, e.customer_id, u.display_name, e.amount_rial::text, e.expires_at, o.reference AS order_reference
       FROM cashback_transactions e
       JOIN users u ON u.id = e.customer_id
       LEFT JOIN orders o ON o.id = e.source_order_id
       WHERE e.tx_type = 'cashback_pending' AND e.expires_at IS NOT NULL
         AND e.expires_at BETWEEN now() AND now() + make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM cashback_transactions x WHERE x.related_tx_id = e.id AND x.tx_type = 'cashback_expired')
       ORDER BY e.expires_at ASC LIMIT 200`, [query.days]);
    return { items: rows.rows };
  });

  /* ---- admin: manual adjustments (ledger-only, audited) ---- */
  app.post('/api/v1/admin/cashback/adjust', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:adjust');
    const body = z.object({
      customerId: z.uuid(),
      direction: z.enum(['credit', 'debit']),
      amountRial: z.string().regex(/^[1-9]\d*$/),
      reason: z.string().trim().min(4).max(500),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const customer = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [body.customerId]);
      if (!customer) throw notFound();
      await lockWallet(client, body.customerId);
      await settleCashbackLifecycle(client, body.customerId);
      const amount = rial(body.amountRial);
      if (body.direction === 'debit') {
        const { availableRial } = await rawBalances(client, body.customerId);
        if (amount > availableRial) throw conflict('مبلغ کسر از موجودی قابل استفاده بیشتر است؛ کیف پول هرگز منفی نمی‌شود.');
      }
      const txId = await insertTx(client, {
        customerId: body.customerId, type: body.direction === 'credit' ? 'admin_credit' : 'admin_debit',
        bucket: 'available', amountRial: body.direction === 'credit' ? amount : -amount,
        source: 'admin', actorId: user.id, description: body.reason,
      });
      await audit(client, user.id, `cashback.${body.direction}`, 'cashback', txId ?? body.customerId,
        undefined, { customerId: body.customerId, amountRial: body.amountRial, reason: body.reason }, request.ip);
      if (txId) await outbox(client, 'cashback.adjusted', 'cashback', txId,
        { customerId: body.customerId, direction: body.direction, amountRial: body.amountRial });
      return reply.code(201).send({ id: txId });
    });
  });

  /* ---- admin: redemption policy ---- */
  app.get('/api/v1/admin/cashback/settings', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:read');
    return cashbackPolicy(pool);
  });

  app.put('/api/v1/admin/cashback/settings', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'cashback:rules_manage');
    const body = z.object({
      redemptionEnabled: z.boolean(),
      maxPercentOfOrder: z.number().int().min(0).max(100),
      minRedeemRial: z.string().regex(/^\d+$/),
      earnOnInstallments: z.boolean(),
      redeemOnInstallments: z.boolean(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ value: unknown }>(client, 'SELECT value FROM site_settings WHERE key = $1 FOR UPDATE', [POLICY_KEY]);
      await client.query(
        `INSERT INTO site_settings(key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [POLICY_KEY, JSON.stringify(body), user.id]);
      await audit(client, user.id, 'cashback.policy_updated', 'site_settings', POLICY_KEY, before?.value, body, request.ip);
      return body;
    });
  });
}
