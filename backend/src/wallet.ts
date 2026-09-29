import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { nextDocumentReference } from './references.js';
import { badRequest, conflict, notFound } from './errors.js';
import { assertNotRestricted } from './console.js';
import { assertSupplierMay } from './supplier360.js';
import { postJournalEntry } from './ledger.js';

/* Wallet ledger, withdrawals and settlements (items 25, 39-41).
   The wallet is provider-agnostic: transfers are reconciled through the
   PayoutProviderAdapter contract in payout.ts, never a hard-coded gateway. */

const WALLET_LIABILITY = '00000000-0000-4000-8000-000000000011';
const PAYMENT_CLEARING = '00000000-0000-4000-8000-000000000001';

export type EntryKind = 'earning' | 'settlement_in' | 'settlement_out' | 'withdrawal' | 'refund' | 'fee' | 'commission' | 'adjustment';

export async function ensureWallet(client: PoolClient, ownerId: string): Promise<string> {
  const existing = await one<{ id: string }>(client, 'SELECT id FROM wallet_accounts WHERE owner_id = $1', [ownerId]);
  if (existing) return existing.id;
  const id = randomUUID();
  await client.query('INSERT INTO wallet_accounts(id, owner_id) VALUES ($1, $2) ON CONFLICT (owner_id) DO NOTHING', [id, ownerId]);
  const row = await one<{ id: string }>(client, 'SELECT id FROM wallet_accounts WHERE owner_id = $1', [ownerId]);
  return row!.id;
}

async function postEntry(client: PoolClient, options: {
  accountId: string; direction: 'credit' | 'debit'; amount: bigint; kind: EntryKind;
  sourceType?: string; sourceId?: string; note?: string; actorId?: string;
  updateTotals?: 'earned' | 'withdrawn' | 'settled' | 'refunded' | 'fee' | 'commission';
}) {
  const account = await one<{ id: string; balance_rial: string }>(client,
    'SELECT id, balance_rial FROM wallet_accounts WHERE id = $1 FOR UPDATE', [options.accountId]);
  if (!account) throw notFound();
  const balance = rial(account.balance_rial);
  const next = options.direction === 'credit' ? balance + options.amount : balance - options.amount;
  if (next < 0n) throw conflict('مانده کیف پول برای این برداشت کافی نیست.');
  const reference = await nextDocumentReference(client, 'transaction');
  await client.query(
    `INSERT INTO wallet_entries(id,account_id,direction,amount_rial,kind,balance_after_rial,reference,source_type,source_id,note,actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [randomUUID(), options.accountId, options.direction, options.amount.toString(), options.kind,
      next.toString(), reference, options.sourceType ?? null, options.sourceId ?? null, options.note ?? null, options.actorId ?? null]);
  const counter = options.updateTotals
    ? { earned: 'earned_total_rial', withdrawn: 'withdrawn_total_rial', settled: 'settled_total_rial',
      refunded: 'refunded_total_rial', fee: 'fee_total_rial', commission: 'commission_total_rial' }[options.updateTotals]
    : undefined;
  await client.query(
    `UPDATE wallet_accounts SET balance_rial = $2, version = version + 1, updated_at = now()${counter ? `, ${counter} = ${counter} + $3` : ''}
     WHERE id = $1`, counter ? [options.accountId, next.toString(), options.amount.toString()] : [options.accountId, next.toString()]);
  return { reference, balanceAfter: next };
}

export async function creditWallet(client: PoolClient, ownerId: string, amount: bigint, kind: EntryKind,
  source: { type: string; id: string }, note?: string, actorId?: string, totals?: 'earned' | 'settled' | 'refunded') {
  const accountId = await ensureWallet(client, ownerId);
  return postEntry(client, { accountId, direction: 'credit', amount, kind, sourceType: source.type, sourceId: source.id, note, actorId, updateTotals: totals });
}

export async function debitWallet(client: PoolClient, ownerId: string, amount: bigint, kind: EntryKind,
  source: { type: string; id: string }, note?: string, actorId?: string, totals?: 'withdrawn' | 'settled' | 'fee' | 'commission') {
  const accountId = await ensureWallet(client, ownerId);
  return postEntry(client, { accountId, direction: 'debit', amount, kind, sourceType: source.type, sourceId: source.id, note, actorId, updateTotals: totals });
}

/** Supplier earnings are credited when the order is delivered: the line total is
 *  credited as earning and the platform commission is debited as a fee. */
export async function postSupplierEarnings(client: PoolClient, orderId: string) {
  const lines = await client.query<{ id: string; supplier_id: string | null; line_total_rial: string; commission_percent: string }>(
    `SELECT l.id, l.supplier_id, l.line_total_rial, COALESCE(s.commission_percent, 0) AS commission_percent
     FROM order_lines l LEFT JOIN supplier_profiles s ON s.user_id = l.supplier_id
     WHERE l.order_id = $1 AND l.supplier_id IS NOT NULL`, [orderId]);
  for (const line of lines.rows) {
    const gross = rial(line.line_total_rial);
    const commission = gross * BigInt(Math.round(Number(line.commission_percent) * 100)) / 10000n;
    await creditWallet(client, line.supplier_id!, gross, 'earning', { type: 'order_line', id: line.id }, 'درآمد تأمین سفارش', undefined, 'earned');
    if (commission > 0n) {
      await debitWallet(client, line.supplier_id!, commission, 'commission', { type: 'order_line', id: line.id }, 'کمیسیون پلتفرم', undefined, 'commission');
    }
  }
}

async function postJournal(client: PoolClient, sourceType: string, sourceId: string, reference: string,
  lines: Array<{ account: string; debit?: bigint; credit?: bigint }>) {
  return postJournalEntry(client, { sourceType, sourceId, reference, lines });
}

const destination = z.object({
  bankName: z.string().trim().min(2).max(80),
  iban: z.string().trim().regex(/^IR\d{24}$/, 'شماره شبا باید با IR و ۲۴ رقم باشد.'),
  holderName: z.string().trim().min(2).max(120),
}).strict();

const withdrawalStatus = z.enum(['under_review', 'approved', 'processing', 'paid', 'failed', 'rejected', 'cancelled']);
const allowedWithdrawal: Record<string, string[]> = {
  requested: ['under_review', 'rejected', 'cancelled'],
  under_review: ['approved', 'rejected', 'cancelled'],
  approved: ['processing', 'cancelled', 'failed'],
  processing: ['paid', 'failed'],
  paid: [], failed: [], rejected: [], cancelled: [],
};
const terminalHeld = new Set(['paid', 'failed', 'rejected', 'cancelled']);

export function registerWalletRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/wallet', async (request) => {
    const user = await principal(request, pool, config);
    const accountId = await transaction(pool, (client) => ensureWallet(client, user.id));
    const account = await one(pool,
      `SELECT balance_rial,pending_rial,earned_total_rial,withdrawn_total_rial,settled_total_rial,
              refunded_total_rial,fee_total_rial,commission_total_rial FROM wallet_accounts WHERE id = $1`, [accountId]);
    const available = rial(account!.balance_rial) - rial(account!.pending_rial);
    return {
      availableRial: asRial(available), pendingRial: asRial(account!.pending_rial),
      totals: {
        earnedRial: asRial(account!.earned_total_rial), withdrawnRial: asRial(account!.withdrawn_total_rial),
        settledRial: asRial(account!.settled_total_rial), refundedRial: asRial(account!.refunded_total_rial),
        feeRial: asRial(account!.fee_total_rial), commissionRial: asRial(account!.commission_total_rial),
      },
    };
  });

  app.get('/api/v1/wallet/entries', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30),
      kind: z.enum(['earning', 'settlement_in', 'settlement_out', 'withdrawal', 'refund', 'fee', 'commission', 'adjustment']).optional() }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.id,e.direction,e.amount_rial,e.kind,e.balance_after_rial,e.reference,e.note,e.created_at
       FROM wallet_entries e JOIN wallet_accounts a ON a.id = e.account_id
       WHERE a.owner_id = $1 AND ($2::text IS NULL OR e.kind = $2)
       ORDER BY e.created_at DESC LIMIT $3`, [user.id, query.kind ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial), balance_after_rial: asRial(row.balance_after_rial) })) };
  });

  app.post('/api/v1/wallet/withdrawals', async (request, reply) => {
    const user = await principal(request, pool, config);
    await assertNotRestricted(pool, user.id, 'withdrawal');
    await assertSupplierMay(pool, user.id, 'withdrawal', { resource: 'withdrawal', ip: request.ip });
    const body = z.object({ amountRial: z.string().regex(/^\d+$/), destination }).strict().parse(request.body);
    const amount = rial(body.amountRial);
    if (amount === 0n) throw badRequest('مبلغ برداشت باید بزرگ‌تر از صفر باشد.');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'withdrawal.create', key, requestHash(body));
      if (claim.previous) return claim.previous;
      const accountId = await ensureWallet(client, user.id);
      const account = await one<{ balance_rial: string; pending_rial: string }>(client,
        'SELECT balance_rial, pending_rial FROM wallet_accounts WHERE id = $1 FOR UPDATE', [accountId]);
      const available = rial(account!.balance_rial) - rial(account!.pending_rial);
      if (available < amount) throw conflict('مبلغ برداشت از مانده قابل برداشت بیشتر است.');
      await client.query('UPDATE wallet_accounts SET pending_rial = pending_rial + $2, updated_at = now() WHERE id = $1',
        [accountId, amount.toString()]);
      const id = randomUUID();
      const reference = await nextDocumentReference(client, 'withdrawal');
      await client.query(
        `INSERT INTO withdrawal_requests(id,reference,account_id,amount_rial,destination)
         VALUES ($1,$2,$3,$4,$5)`, [id, reference, accountId, amount.toString(), JSON.stringify(body.destination)]);
      await client.query('INSERT INTO withdrawal_events(id,withdrawal_id,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), id, 'requested', user.id, 'ثبت درخواست برداشت']);
      await audit(client, user.id, 'withdrawal.requested', 'withdrawal', id, undefined, { reference, amountRial: amount.toString() }, request.ip);
      await outbox(client, 'withdrawal.requested', 'withdrawal', id, { withdrawalId: id, reference, userId: user.id });
      const response = { id, reference, status: 'requested', amountRial: asRial(amount) };
      await completeIdempotency(client, user.id, 'withdrawal.create', key, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/wallet/withdrawals', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT w.id,w.reference,w.amount_rial,w.status,w.destination,w.reject_reason,w.requested_at,w.paid_at
       FROM withdrawal_requests w JOIN wallet_accounts a ON a.id = w.account_id
       WHERE a.owner_id = $1 ORDER BY w.requested_at DESC LIMIT 100`, [user.id]);
    return { items: rows.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })) };
  });

  app.get('/api/v1/admin/withdrawals', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'withdrawals:manage');
    const query = z.object({ status: withdrawalStatus.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT w.id,w.reference,w.amount_rial,w.status,w.destination,w.reject_reason,w.requested_at,w.paid_at,
              u.display_name AS owner_name, a.owner_id
       FROM withdrawal_requests w JOIN wallet_accounts a ON a.id = w.account_id JOIN users u ON u.id = a.owner_id
       WHERE ($1::text IS NULL OR w.status = $1) ORDER BY w.requested_at DESC LIMIT $2`, [query.status ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })) };
  });

  app.post('/api/v1/admin/withdrawals/:id/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'withdrawals:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      status: withdrawalStatus,
      note: z.string().trim().max(1000).optional(),
      rejectReason: z.string().trim().max(500).optional(),
      provider: z.string().trim().max(60).optional(),
      providerReference: z.string().trim().max(120).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const withdrawal = await one<{ id: string; reference: string; account_id: string; status: string; amount_rial: string; owner_id: string }>(client,
        `SELECT w.id,w.reference,w.account_id,w.status,w.amount_rial,a.owner_id FROM withdrawal_requests w
         JOIN wallet_accounts a ON a.id = w.account_id WHERE w.id = $1 FOR UPDATE OF w`, [id]);
      if (!withdrawal) throw notFound();
      if (!(allowedWithdrawal[withdrawal.status] ?? []).includes(body.status)) throw conflict('این تغییر وضعیت در مرحله فعلی مجاز نیست.');
      if ((body.status === 'rejected' || body.status === 'failed') && !body.rejectReason && !body.note)
        throw badRequest('ثبت علت برای رد یا ناموفق شدن برداشت لازم است.');
      const amount = rial(withdrawal.amount_rial);
      const now = new Date();
      await client.query(
        `UPDATE withdrawal_requests SET status = $2, reject_reason = $3, provider = COALESCE($4, provider),
           provider_reference = COALESCE($5, provider_reference), reviewed_by = COALESCE(reviewed_by, $6),
           reviewed_at = COALESCE(reviewed_at, CASE WHEN $2 IN ('under_review','approved','rejected') THEN $7::timestamptz ELSE NULL::timestamptz END),
           processed_at = COALESCE(processed_at, CASE WHEN $2 IN ('processing','paid','failed') THEN $7::timestamptz ELSE NULL::timestamptz END),
           paid_at = CASE WHEN $2 = 'paid' THEN $7::timestamptz ELSE paid_at END, updated_at = now()
         WHERE id = $1`,
        [id, body.status, body.rejectReason ?? body.note ?? null, body.provider ?? null, body.providerReference ?? null, user.id, now]);
      await client.query('INSERT INTO withdrawal_events(id,withdrawal_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, withdrawal.status, body.status, user.id, body.note ?? body.rejectReason ?? null]);
      if (terminalHeld.has(body.status)) {
        // The hold is released in every terminal outcome; a paid withdrawal
        // additionally debits the ledger balance once (no double-debit).
        await client.query('UPDATE wallet_accounts SET pending_rial = pending_rial - $2, updated_at = now() WHERE id = $1',
          [withdrawal.account_id, amount.toString()]);
        if (body.status === 'paid') {
          await postEntry(client, { accountId: withdrawal.account_id, direction: 'debit', amount, kind: 'withdrawal',
            sourceType: 'withdrawal', sourceId: id, note: `برداشت ${withdrawal.reference}`, actorId: user.id, updateTotals: 'withdrawn' });
          await postJournal(client, 'withdrawal', id, `JE-${withdrawal.reference}`,
            [{ account: WALLET_LIABILITY, debit: amount }, { account: PAYMENT_CLEARING, credit: amount }]);
        }
      }
      await audit(client, user.id, 'withdrawal.status_changed', 'withdrawal', id,
        { status: withdrawal.status }, { status: body.status, note: body.note ?? null }, request.ip);
      await outbox(client, 'withdrawal.status_changed', 'withdrawal', id, { withdrawalId: id, status: body.status, ownerId: withdrawal.owner_id });
      return { id, reference: withdrawal.reference, status: body.status };
    });
  });

  app.get('/api/v1/settlements', async (request) => {
    const user = await principal(request, pool, config);
    const privileged = user.permissions.includes('settlements:manage');
    const rows = await pool.query(
      `SELECT id,reference,invoice_id,party_user_id,direction,amount_rial,status,note,created_at,settled_at
       FROM settlements WHERE ($1::boolean OR party_user_id = $2) ORDER BY created_at DESC LIMIT 100`,
      [privileged, user.id]);
    return { items: rows.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })) };
  });

  /** Settlement between the platform and a supplier, backed by a settlement invoice. */
  app.post('/api/v1/settlements', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const body = z.object({
      partyUserId: z.uuid(),
      amountRial: z.string().regex(/^\d+$/),
      note: z.string().trim().max(1000).optional(),
    }).strict().parse(request.body);
    const amount = rial(body.amountRial);
    if (amount === 0n) throw badRequest('مبلغ تسویه باید بزرگ‌تر از صفر باشد.');
    const result = await transaction(pool, async (client) => {
      const party = await one<{ display_name: string }>(client, 'SELECT display_name FROM users WHERE id = $1', [body.partyUserId]);
      if (!party) throw notFound();
      const invoiceId = randomUUID();
      const invoiceReference = await nextDocumentReference(client, 'invoice');
      await client.query(
        `INSERT INTO invoices(id,reference,kind,buyer,seller,status,payment_type,subtotal_rial,gross_rial,total_rial,remaining_rial,notes,created_by)
         VALUES ($1,$2,'settlement',$3,$4,'issued','transfer',$5,$5,$5,$5,$6,$7)`,
        [invoiceId, invoiceReference,
          JSON.stringify({ name: 'کلبه وینتج' }), JSON.stringify({ userId: body.partyUserId, name: party.display_name }),
          amount.toString(), body.note ?? null, user.id]);
      await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'created',$3,$4,$5)`,
        [randomUUID(), invoiceId, user.id, body.note ?? null, JSON.stringify({ reference: invoiceReference, amountRial: amount.toString() })]);
      const settlementId = randomUUID();
      const reference = await nextDocumentReference(client, 'settlement');
      await client.query(
        `INSERT INTO settlements(id,reference,invoice_id,party_user_id,direction,amount_rial,note,created_by)
         VALUES ($1,$2,$3,$4,'payable',$5,$6,$7)`,
        [settlementId, reference, invoiceId, body.partyUserId, amount.toString(), body.note ?? null, user.id]);
      await audit(client, user.id, 'settlement.created', 'settlement', settlementId, undefined,
        { reference, invoiceReference, amountRial: amount.toString() }, request.ip);
      await outbox(client, 'settlement.created', 'settlement', settlementId, { settlementId, reference });
      return { id: settlementId, reference, invoiceReference, status: 'pending', amountRial: asRial(amount) };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/settlements/:id/settle', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'settlements:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ note: z.string().trim().max(1000).optional(), method: z.enum(['wallet', 'transfer']).default('transfer') }).parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const settlement = await one<{ id: string; reference: string; party_user_id: string; amount_rial: string; status: string; invoice_id: string | null }>(client,
        'SELECT * FROM settlements WHERE id = $1 FOR UPDATE', [id]);
      if (!settlement) throw notFound();
      if (settlement.status === 'settled' || settlement.status === 'paid' || settlement.status === 'reconciled') return { id, status: settlement.status };
      if (settlement.status === 'cancelled') throw conflict('تسویه لغوشده قابل تکمیل نیست.');
      const amount = rial(settlement.amount_rial);
      if (body.method === 'wallet') {
        const accountId = await ensureWallet(client, settlement.party_user_id);
        await postEntry(client, { accountId, direction: 'debit', amount, kind: 'settlement_out',
          sourceType: 'settlement', sourceId: id, note: `تسویه ${settlement.reference}`, actorId: user.id, updateTotals: 'settled' });
      }
      await client.query("UPDATE settlements SET status = 'paid', settled_at = now(), paid_at = now(), reconciliation_status = 'paid' WHERE id = $1", [id]);
      if (settlement.invoice_id) {
        await client.query("UPDATE invoices SET status = 'paid', paid_rial = total_rial, remaining_rial = 0, paid_at = now(), updated_at = now() WHERE id = $1",
          [settlement.invoice_id]);
        await client.query(`INSERT INTO invoice_events(id,invoice_id,event_type,actor_id,note,new_value) VALUES ($1,$2,'payment',$3,$4,$5)`,
          [randomUUID(), settlement.invoice_id, user.id, body.note ?? `تسویه ${settlement.reference}`,
            JSON.stringify({ settlement: settlement.reference, amountRial: amount.toString() })]);
      }
      await audit(client, user.id, 'settlement.paid', 'settlement', id, { status: settlement.status }, { status: 'paid', method: body.method }, request.ip);
      return { id, status: 'paid' };
    });
  });
}
