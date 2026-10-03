/* Try-On monetization (Prompt 4 §42-§47, §199).
 *
 * One canonical money path: package → purchase → payment_intent (purpose='tryon')
 * → EXISTING applyVerifiedPayment → credits granted exactly once → generations
 * consume exactly one credit through an append-only ledger whose balance can
 * never go negative. Provider generation cost is stored ONLY when actually
 * known (NULL = honest unknown — §46 no-fake-cost rule). */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { ApiError, badRequest, notFound, conflict } from './errors.js';
import { audit, outbox } from './operations.js';
import { nextDocumentReference } from './references.js';

export type TryonPolicy = { freeQuota: number; salesEnabled: boolean };

export async function tryonPolicy(db: Pick<PoolClient, 'query'>): Promise<TryonPolicy> {
  const row = await one<{ value: Record<string, unknown> }>(db,
    "SELECT value FROM site_settings WHERE key = 'tryon_policy'", []);
  const value = row?.value ?? {};
  const freeQuota = typeof value.freeQuota === 'number' && Number.isFinite(value.freeQuota)
    ? Math.max(0, Math.trunc(value.freeQuota)) : 1;
  return { freeQuota, salesEnabled: value.salesEnabled !== false };
}

/** Lock (or create) the balance row — the single concurrency gate for credits. */
async function lockAccount(client: PoolClient, userId: string): Promise<{ balance: number; free_granted: boolean }> {
  await client.query(
    'INSERT INTO tryon_credit_accounts(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const account = await one<{ balance: number; free_granted: boolean }>(client,
    'SELECT balance, free_granted FROM tryon_credit_accounts WHERE user_id = $1 FOR UPDATE', [userId]);
  return account!;
}

async function postLedger(client: PoolClient, input: {
  userId: string; direction: 'credit' | 'debit'; qty: number;
  reason: 'free_quota' | 'purchase' | 'generation' | 'refund' | 'admin_adjust';
  purchaseId?: string | null; jobRef?: string | null; balanceAfter: number;
}) {
  await client.query(
    `UPDATE tryon_credit_accounts SET balance = $2, updated_at = now() WHERE user_id = $1`,
    [input.userId, input.balanceAfter]);
  await client.query(
    `INSERT INTO tryon_credit_ledger(id, user_id, direction, qty, reason, purchase_id, job_ref, generation_cost_rial, balance_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8)`,
    [randomUUID(), input.userId, input.direction, input.qty, input.reason,
      input.purchaseId ?? null, input.jobRef ?? null, input.balanceAfter]);
}

/** Called from applyVerifiedPayment inside the SAME transaction — exactly-once by
 *  purchase-status guard (the intent itself is already replay-guarded upstream). */
export async function grantTryonCredits(client: PoolClient, purchaseId: string, paidAt: Date) {
  const purchase = await one<{ id: string; user_id: string; credits: number; status: string; reference: string }>(client,
    'SELECT id, user_id, credits, status, reference FROM tryon_credit_purchases WHERE id = $1 FOR UPDATE', [purchaseId]);
  if (!purchase) throw notFound('خرید پرو مجازی پیدا نشد.');
  if (purchase.status === 'paid') return { granted: false };
  if (purchase.status !== 'pending') throw conflict('این خرید قابل پرداخت نیست.');
  await client.query(
    `UPDATE tryon_credit_purchases SET status = 'paid', paid_at = $2 WHERE id = $1`, [purchaseId, paidAt]);
  const account = await lockAccount(client, purchase.user_id);
  await postLedger(client, { userId: purchase.user_id, direction: 'credit', qty: purchase.credits,
    reason: 'purchase', purchaseId, balanceAfter: account.balance + purchase.credits });
  await outbox(client, 'tryon.credits_granted', 'tryon_purchase', purchaseId,
    { purchaseId, userId: purchase.user_id, credits: purchase.credits, reference: purchase.reference });
  return { granted: true };
}

/** Consume one credit for a generation (free quota auto-granted once). */
export async function consumeTryonCredit(pool: DbPool, userId: string):
  Promise<{ charged: boolean; balance: number }> {
  return transaction(pool, async (client) => {
    const policy = await tryonPolicy(client);
    if (!policy.salesEnabled) return { charged: false, balance: 0 }; // free mode — rate limit only
    const account = await lockAccount(client, userId);
    let balance = account.balance;
    if (!account.free_granted && policy.freeQuota > 0) {
      balance += policy.freeQuota;
      await client.query('UPDATE tryon_credit_accounts SET free_granted = true WHERE user_id = $1', [userId]);
      await postLedger(client, { userId, direction: 'credit', qty: policy.freeQuota,
        reason: 'free_quota', balanceAfter: balance });
    } else if (!account.free_granted) {
      await client.query('UPDATE tryon_credit_accounts SET free_granted = true WHERE user_id = $1', [userId]);
    }
    if (balance < 1) {
      throw new ApiError(409, 'TRYON_CREDITS_REQUIRED',
        'اعتبار پرو مجازی شما تمام شده است — برای ادامه یکی از بسته‌های اعتبار را تهیه کنید.');
    }
    await postLedger(client, { userId, direction: 'debit', qty: 1, reason: 'generation', balanceAfter: balance - 1 });
    return { charged: true, balance: balance - 1 };
  });
}

/** Refund one credit when the provider submission fails AFTER the debit. */
export async function refundTryonCredit(pool: DbPool, userId: string) {
  await transaction(pool, async (client) => {
    const account = await lockAccount(client, userId);
    await postLedger(client, { userId, direction: 'credit', qty: 1, reason: 'refund', balanceAfter: account.balance + 1 });
  });
}

export function registerTryOnCommerceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* --------------------------- customer side --------------------------- */
  app.get('/api/v1/tryon/packages', async (request) => {
    const user = await principal(request, pool, config);
    const policy = await tryonPolicy(pool);
    const packages = await pool.query(
      `SELECT id, name, credits, price_rial::text AS price_rial, expiry_days
         FROM tryon_packages WHERE active ORDER BY sort, created_at`, []);
    const account = await one<{ balance: number; free_granted: boolean }>(pool,
      'SELECT balance, free_granted FROM tryon_credit_accounts WHERE user_id = $1', [user.id]);
    return {
      salesEnabled: policy.salesEnabled,
      freeQuota: policy.freeQuota,
      freeGranted: account?.free_granted ?? false,
      balance: account?.balance ?? 0,
      packages: packages.rows,
    };
  });

  app.post('/api/v1/tryon/purchases', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({ packageId: z.uuid() }).parse(request.body);
    const policy = await tryonPolicy(pool);
    if (!policy.salesEnabled) throw conflict('فروش بسته پرو مجازی فعال نیست.');
    return transaction(pool, async (client) => {
      const pack = await one<{ id: string; name: string; credits: number; price_rial: string; expiry_days: number | null }>(client,
        'SELECT id, name, credits, price_rial::text AS price_rial, expiry_days FROM tryon_packages WHERE id = $1 AND active', [body.packageId]);
      if (!pack) throw notFound('بسته پیدا نشد یا غیرفعال است.');
      if (BigInt(pack.price_rial) <= 0n) throw badRequest('این بسته قابل خرید نیست.');
      const purchaseId = randomUUID();
      const reference = await nextDocumentReference(client, 'tryon_purchase');
      await client.query(
        `INSERT INTO tryon_credit_purchases(id, reference, user_id, package_id, package_snapshot, credits, price_rial, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [purchaseId, reference, user.id, pack.id,
          JSON.stringify({ name: pack.name, credits: pack.credits, priceRial: pack.price_rial, expiryDays: pack.expiry_days }),
          pack.credits, pack.price_rial]);
      const intentId = randomUUID();
      const seq = await one<{ n: string }>(client, "SELECT nextval('order_reference_seq')::text AS n");
      await client.query(
        `INSERT INTO payment_intents(id, reference, provider, amount_rial, status, purpose, tryon_purchase_id)
         VALUES ($1,$2,'nextpay',$3,'pending','tryon',$4)`,
        [intentId, `PAY-${seq!.n}`, pack.price_rial, purchaseId]);
      await client.query('UPDATE tryon_credit_purchases SET payment_intent_id = $2 WHERE id = $1', [purchaseId, intentId]);
      await audit(client, user.id, 'tryon_purchase.created', 'tryon_purchase', purchaseId, undefined,
        { packageId: pack.id, credits: pack.credits, priceRial: pack.price_rial });
      return reply.code(201).send({ id: purchaseId, reference, paymentIntentId: intentId,
        amountRial: pack.price_rial, status: 'pending' });
    });
  });

  app.get('/api/v1/tryon/purchases', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT id, reference, credits, price_rial::text AS price_rial, status, created_at, paid_at
         FROM tryon_credit_purchases WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id]);
    return { items: rows.rows };
  });

  /* ----------------------------- admin side ----------------------------- */
  app.get('/api/v1/admin/tryon/packages', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'plans:manage');
    const rows = await pool.query(
      `SELECT p.id, p.name, p.credits, p.price_rial::text AS price_rial, p.active, p.sort, p.expiry_days, p.created_at,
              (SELECT COUNT(*)::int FROM tryon_credit_purchases c WHERE c.package_id = p.id AND c.status = 'paid') AS paid_count
         FROM tryon_packages p ORDER BY p.sort, p.created_at`, []);
    const policy = await tryonPolicy(pool);
    return { items: rows.rows, policy };
  });

  app.post('/api/v1/admin/tryon/packages', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'plans:manage');
    const body = z.object({
      name: z.string().trim().min(2).max(120),
      credits: z.number().int().min(1).max(1000),
      priceRial: z.string().regex(/^\d+$/),
      expiryDays: z.number().int().min(1).max(3650).nullable().optional(),
      sort: z.number().int().min(0).max(1000).default(0),
    }).parse(request.body);
    const id = randomUUID();
    return transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO tryon_packages(id, name, credits, price_rial, sort, expiry_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, body.name, body.credits, body.priceRial, body.sort, body.expiryDays ?? null, actor.id]);
      await audit(client, actor.id, 'tryon_package.created', 'tryon_package', id, undefined, body);
      return reply.code(201).send({ id });
    });
  });

  app.patch('/api/v1/admin/tryon/packages/:id', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'plans:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      credits: z.number().int().min(1).max(1000).optional(),
      priceRial: z.string().regex(/^\d+$/).optional(),
      active: z.boolean().optional(),
      sort: z.number().int().min(0).max(1000).optional(),
      expiryDays: z.number().int().min(1).max(3650).nullable().optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const current = await one<{ id: string }>(client, 'SELECT id FROM tryon_packages WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw notFound();
      await client.query(
        `UPDATE tryon_packages SET
           name = COALESCE($2, name), credits = COALESCE($3, credits), price_rial = COALESCE($4, price_rial),
           active = COALESCE($5, active), sort = COALESCE($6, sort),
           expiry_days = CASE WHEN $7::boolean THEN $8 ELSE expiry_days END, updated_at = now()
         WHERE id = $1`,
        [id, body.name ?? null, body.credits ?? null, body.priceRial ?? null, body.active ?? null,
          body.sort ?? null, body.expiryDays !== undefined, body.expiryDays ?? null]);
      await audit(client, actor.id, 'tryon_package.updated', 'tryon_package', id, undefined, body);
      return { id };
    });
  });

  app.put('/api/v1/admin/tryon/policy', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'plans:manage');
    const body = z.object({
      freeQuota: z.number().int().min(0).max(100).optional(),
      salesEnabled: z.boolean().optional(),
    }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const current = await tryonPolicy(client);
      const next = { freeQuota: body.freeQuota ?? current.freeQuota, salesEnabled: body.salesEnabled ?? current.salesEnabled };
      await client.query(
        `INSERT INTO site_settings(key, value) VALUES ('tryon_policy', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify(next)]);
      await audit(client, actor.id, 'tryon_policy.updated', 'site_setting', 'tryon_policy', current as unknown as Record<string, unknown>, next);
      return next;
    });
  });

  app.get('/api/v1/admin/tryon/finance', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'payments:read');
    const totals = await one<Record<string, string>>(pool,
      `SELECT COALESCE(SUM(price_rial) FILTER (WHERE status = 'paid'), 0)::text AS revenue,
              COUNT(*) FILTER (WHERE status = 'paid')::text AS paid_count,
              COUNT(*) FILTER (WHERE status = 'pending')::text AS pending_count
         FROM tryon_credit_purchases`, []);
    const credits = await one<Record<string, string>>(pool,
      `SELECT COALESCE(SUM(qty) FILTER (WHERE direction = 'credit' AND reason = 'purchase'), 0)::text AS purchased,
              COALESCE(SUM(qty) FILTER (WHERE direction = 'credit' AND reason = 'free_quota'), 0)::text AS free_granted,
              COALESCE(SUM(qty) FILTER (WHERE direction = 'debit' AND reason = 'generation'), 0)::text AS consumed,
              COALESCE(SUM(generation_cost_rial) FILTER (WHERE reason = 'generation'), 0)::text AS known_cost,
              COUNT(*) FILTER (WHERE reason = 'generation' AND generation_cost_rial IS NULL)::text AS unknown_cost_rows
         FROM tryon_credit_ledger`, []);
    const outstanding = await one<{ v: string }>(pool,
      'SELECT COALESCE(SUM(balance), 0)::text AS v FROM tryon_credit_accounts', []);
    const purchases = await pool.query(
      `SELECT c.reference, u.display_name AS user_name, c.credits, c.price_rial::text AS price_rial, c.status, c.paid_at, c.created_at
         FROM tryon_credit_purchases c JOIN users u ON u.id = c.user_id
        ORDER BY c.created_at DESC LIMIT 50`, []);
    return {
      revenueRial: totals?.revenue ?? '0',
      paidPurchases: Number(totals?.paid_count ?? '0'),
      pendingPurchases: Number(totals?.pending_count ?? '0'),
      creditsPurchased: Number(credits?.purchased ?? '0'),
      creditsFreeGranted: Number(credits?.free_granted ?? '0'),
      creditsConsumed: Number(credits?.consumed ?? '0'),
      creditsOutstanding: Number(outstanding?.v ?? '0'),
      // §45/§46: cost is reported only where real data exists; otherwise honest unknown.
      knownGenerationCostRial: credits?.known_cost ?? '0',
      generationsWithUnknownCost: Number(credits?.unknown_cost_rows ?? '0'),
      costStatus: Number(credits?.unknown_cost_rows ?? '0') > 0 || (credits?.known_cost ?? '0') === '0' ? 'partial_or_unknown' : 'tracked',
      purchases: purchases.rows,
    };
  });
}
