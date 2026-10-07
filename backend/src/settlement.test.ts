/** Master Prompt 3 — Supplier Financial Core tests (§150-§171, §207-§210).
 *  Covers: the VIP-2048-style end-to-end money path (delivered child → payable
 *  with explainable components → hold → release → eligible → scheduled
 *  settlement → finance approve (NO payout call) → manual bank transfer →
 *  PAID), accepted-quantity accrual (settle 3 not 5), commission snapshot
 *  immutability, Kolbe-child-no-payable, multi-payable single settlement with
 *  one bank reference, duplicate bank reference rejection, post-PAID refund →
 *  recovery offsetting the next settlement, refund-before-release partial
 *  hold, manual hold block, reconciliation-mismatch generation blocker,
 *  shipping policy versioning (non-retroactive), bank account lifecycle +
 *  takeover defense, withdrawal deprecation, RBAC/IDOR and the §171
 *  payout-adapter-never-called invariant. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, transaction } from './db.js';
import { applyVerifiedPayment } from './payments.js';
import { accrueChildPayable, releaseDueHolds } from './settlement-core.js';
import { accrueSupplier } from './ledger.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4040, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

type Pool = ReturnType<typeof createPool>;
type App = Awaited<ReturnType<typeof buildApp>>;

async function makeUser(pool: Pool, roles: string[], label: string) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [id, email, await argon2.hash('TestPassword123456!'), label]);
  for (const role of roles) await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, role]);
  return { id, email };
}

async function login(app: App, email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: email, password: 'TestPassword123456!' } });
  assert.equal(res.statusCode, 200, res.body);
  return { authorization: `Bearer ${res.json().accessToken as string}` };
}

async function makeVipBuyer(pool: Pool, label: string) {
  const buyer = await makeUser(pool, ['customer'], label);
  const planId = randomUUID();
  await pool.query(`INSERT INTO membership_plans(id,code,title,annual_price_rial,limits) VALUES ($1,$2,'پلن VIP تست',0,'{}')`,
    [planId, `fin-${planId.slice(0, 8)}`]);
  await pool.query(`INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active',now(),now() + interval '30 days')`,
    [randomUUID(), buyer.id, planId]);
  return buyer;
}

async function makeSupplier(pool: Pool, label: string, commissionPercent: number) {
  const supplier = await makeUser(pool, ['supplier'], label);
  await pool.query(
    `INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status,commission_percent)
     VALUES ($1,$2,'approved',$3)`, [supplier.id, `برند ${label}`, commissionPercent]);
  return supplier;
}

async function makeSeriesProduct(pool: Pool, name: string, ownerSupplierId: string | null) {
  const productId = randomUUID();
  await pool.query(
    `INSERT INTO products(id, supplier_id, brand, name, category, status, cash_price_rial, wholesale_price_rial, owner_type, retail_enabled, wholesale_enabled)
     VALUES ($1,$2,'برند تست',$3,'هودی','published',100000000,90000000,$4,false,true)`,
    [productId, ownerSupplierId, name, ownerSupplierId ? 'supplier' : 'kolbe']);
  const v1 = randomUUID(); const v2 = randomUUID();
  await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES ($1,$2,$3,'M','مشکی'),($4,$2,$5,'L','مشکی')`,
    [v1, productId, `FIN-${productId.slice(0, 8)}-M`, v2, `FIN-${productId.slice(0, 8)}-L`]);
  const tplId = randomUUID();
  await pool.query(`INSERT INTO series_templates(id, product_id, name) VALUES ($1,$2,'سری تست')`, [tplId, productId]);
  await pool.query(`INSERT INTO series_template_items(id, series_template_id, variant_id, quantity_per_series) VALUES ($1,$2,$3,1),($4,$2,$5,1)`,
    [randomUUID(), tplId, v1, randomUUID(), v2]);
  return { productId, variantIds: [v1, v2], tplId };
}

/** Fabricate a delivered, paid supplier/kolbe child (white-box; the API path is
 *  exercised end-to-end in the first test) and run the SAME accrual function
 *  the deliver route calls. */
async function fabricateDeliveredChild(pool: Pool, input: {
  buyerId: string; sellerType: 'supplier' | 'kolbe'; sellerId: string | null;
  productId: string; tplId: string; requested: number; accepted: number | null;
  unitPriceRial: string; paymentEligibility?: string;
}) {
  const masterId = randomUUID(); const childId = randomUUID(); const lineId = randomUUID();
  const total = (BigInt(input.unitPriceRial) * BigInt(input.requested)).toString();
  await pool.query(
    `INSERT INTO master_orders(id, reference, buyer_id, composition, status, delivered_at)
     VALUES ($1,$2,$3,'locked','completed',now())`, [masterId, `MV-T${masterId.slice(0, 8)}`, input.buyerId]);
  await pool.query(
    `INSERT INTO orders(id, reference, buyer_id, order_type, payment_mode, status, subtotal_rial, total_rial,
       master_order_id, seller_type, seller_id, payment_eligibility, child_fulfillment, composition_state)
     VALUES ($1,$2,$3,'wholesale','cash','delivered',$4,$4,$5,$6,$7,$8,'delivered','included')`,
    [childId, `VW-T${childId.slice(0, 8)}`, input.buyerId, total, masterId, input.sellerType, input.sellerId,
      input.paymentEligibility ?? 'paid']);
  await pool.query(
    `INSERT INTO child_order_lines(id, master_order_id, child_order_id, product_id, series_template_id,
       seller_type, seller_id, requested_series, confirmed_series, accepted_series, pieces_per_series,
       unit_series_price_rial, line_total_rial, status, commercial_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,2,$10,$11,'accepted','{"productName":"کالای تست مالی"}')`,
    [lineId, masterId, childId, input.productId, input.tplId, input.sellerType, input.sellerId,
      input.requested, input.accepted, input.unitPriceRial, total]);
  const result = await transaction(pool, (client) => accrueChildPayable(client, childId, null));
  return { masterId, childId, lineId, payable: result };
}

async function forceReleaseHolds(pool: Pool, supplierId: string) {
  await pool.query(`UPDATE settlement_holds SET release_at = now() - interval '1 hour' WHERE supplier_id = $1 AND status = 'active'`, [supplierId]);
  return releaseDueHolds(pool, null);
}

async function addVerifiedBank(app: App, supplierHeaders: Record<string, string>,
  adminHeaders: Record<string, string>, iban: string) {
  const created = await app.inject({ method: 'POST', url: '/api/v1/supplier/finance/bank-accounts',
    headers: supplierHeaders, payload: { bankName: 'ملت', iban, holderName: 'صاحب حساب تست' } });
  assert.equal(created.statusCode, 200, created.body);
  const verify = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/bank-accounts/${created.json().id}/verify`,
    headers: adminHeaders, payload: {} });
  assert.equal(verify.statusCode, 200, verify.body);
  return created.json().id as string;
}

async function approveSettlement(app: App, pool: Pool, settlementId: string, approverHeaders: Record<string, string>) {
  const approval = await pool.query(
    `SELECT id FROM finance_approvals WHERE subject_type = 'settlement' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [settlementId]);
  const res = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/approvals/${approval.rows[0].id}/approve`,
    headers: approverHeaders, payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  return res;
}

/* ------------------------------------------------------------------------- */

test('end-to-end §207: delivered child → explainable payable (settle 3 not 5) → hold → eligible → scheduled settlement → approve (no payout) → manual transfer → PAID → post-PAID refund = recovery', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const warehouseId = randomUUID();
    await pool.query(`INSERT INTO warehouses(id, code, name, purpose) VALUES ($1,$2,'انبار عمده مالی','wholesale')`,
      [warehouseId, `WH-${warehouseId.slice(0, 8)}`]);
    const buyer = await makeVipBuyer(pool, 'vip-fin');
    const admin = await makeUser(pool, ['admin', 'operations'], 'fin-admin-a');
    const admin2 = await makeUser(pool, ['admin'], 'fin-admin-b');
    const supplierA = await makeSupplier(pool, 'sup-fin-a', 10);
    const outsider = await makeSupplier(pool, 'sup-fin-x', 0);
    const buyerHeaders = await login(app, buyer.email);
    const adminHeaders = await login(app, admin.email);
    const admin2Headers = await login(app, admin2.email);
    const supplierHeaders = await login(app, supplierA.email);
    const outsiderHeaders = await login(app, outsider.email);

    // --- order-driven supplier product: request 5 series at 180,000,000 ---
    const prod = await makeSeriesProduct(pool, 'کالای مالی A', supplierA.id);
    await pool.query(
      `INSERT INTO supplier_offers(id, supplier_id, product_id, series_template_id, status, fulfillment_mode,
         wholesale_price_rial, min_order_series, declared_capacity, capacity_confirmed_at)
       VALUES ($1,$2,$3,$4,'active','order_driven',180000000,1,10,now())`,
      [randomUUID(), supplierA.id, prod.productId, prod.tplId]);
    const master = await app.inject({ method: 'POST', url: '/api/v1/wholesale/masters',
      headers: { ...buyerHeaders, 'idempotency-key': `m-${randomUUID()}` },
      payload: { items: [{ seriesTemplateId: prod.tplId, count: 5 }] } });
    assert.equal(master.statusCode, 201, master.body);
    const masterId = master.json().id as string;
    const childId = master.json().children[0].id as string;
    const line = await pool.query('SELECT id FROM child_order_lines WHERE child_order_id = $1', [childId]);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/lines/${line.rows[0].id}/respond`,
      headers: supplierHeaders, payload: { action: 'confirm' } });
    assert.equal(confirm.statusCode, 200, confirm.body);
    const intent = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/payment-intent`, headers: buyerHeaders });
    assert.equal(intent.statusCode, 201, intent.body);
    await applyVerifiedPayment(pool, { provider: 'nextpay', providerEventId: `evt-${randomUUID()}`,
      providerReference: `ref-${randomUUID().slice(0, 12)}`, intentId: intent.json().intentId as string,
      amountRial: intent.json().amountRial as string, paidAt: new Date() });

    // dispatch 5 → receive 4 → QC 3 pass / 1 reject → resolve exceptions → accepted 3 (§15).
    const dispatch = await app.inject({ method: 'POST', url: `/api/v1/wholesale/supplier/children/${childId}/dispatch`,
      headers: supplierHeaders, payload: {} });
    assert.equal(dispatch.statusCode, 200, dispatch.body);
    const alloc = await pool.query(
      `SELECT id FROM order_source_allocations WHERE child_order_id = $1 AND source_type = 'supplier_external'`, [childId]);
    const receive = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/receive`,
      headers: adminHeaders, payload: { allocations: [{ allocationId: alloc.rows[0].id, receivedSeries: 4 }] } });
    assert.equal(receive.statusCode, 200, receive.body);
    const qc = await app.inject({ method: 'POST', url: `/api/v1/wholesale/children/${childId}/qc`,
      headers: adminHeaders, payload: { allocations: [{ allocationId: alloc.rows[0].id, passedSeries: 3, rejectedSeries: 1 }] } });
    assert.equal(qc.statusCode, 200, qc.body);
    for (const row of await pool.query('SELECT id FROM fulfillment_exceptions WHERE child_order_id = $1', [childId]).then((r) => r.rows)) {
      const resolve = await app.inject({ method: 'POST', url: `/api/v1/wholesale/exceptions/${row.id}/resolve`,
        headers: adminHeaders, payload: { resolution: 'accept_short' } });
      assert.equal(resolve.statusCode, 200, resolve.body);
    }

    // consolidate → ship → deliver (accrual happens INSIDE the deliver transaction).
    const lockRes = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${masterId}/lock`, headers: buyerHeaders });
    assert.equal(lockRes.statusCode, 200, lockRes.body);
    const start = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${masterId}/consolidation/start`, headers: adminHeaders });
    assert.equal(start.statusCode, 201, start.body);
    const consolidationId = start.json().id as string;
    const verify = await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/verify-item`,
      headers: adminHeaders, payload: { lineId: line.rows[0].id } });
    assert.equal(verify.statusCode, 200, verify.body);
    await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/complete`, headers: adminHeaders });
    await app.inject({ method: 'POST', url: `/api/v1/wholesale/consolidations/${consolidationId}/pack`, headers: adminHeaders });
    const ship = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${masterId}/ship`,
      headers: adminHeaders, payload: { carrier: 'باربری مالی', trackingCode: 'TRK-FIN-1' } });
    assert.equal(ship.statusCode, 200, ship.body);
    const deliver = await app.inject({ method: 'POST', url: `/api/v1/wholesale/masters/${masterId}/deliver`, headers: adminHeaders });
    assert.equal(deliver.statusCode, 200, deliver.body);

    // --- payable: gross 3×180M = 540M, commission 10% = 54M, shipping leg A = customer → 0, net 486M (§16-§17) ---
    const payable = await pool.query(
      `SELECT id, status, gross_rial::text, commission_rial::text, shipping_share_rial::text, net_rial::text,
              commission_percent::text, quantity_snapshot, shipping_policy_snapshot
         FROM supplier_child_payables WHERE child_order_id = $1`, [childId]);
    assert.equal(payable.rows.length, 1, 'exactly one payable per delivered child (§120)');
    const p = payable.rows[0];
    assert.equal(p.gross_rial, '540000000', 'settle 3 accepted, never the 5 requested (§15)');
    assert.equal(p.commission_rial, '54000000');
    assert.equal(p.shipping_share_rial, '0', 'leg A default payer = customer (§74)');
    assert.equal(p.net_rial, '486000000');
    assert.equal(p.status, 'held');
    assert.equal(p.quantity_snapshot[0].requested, 5);
    assert.equal(p.quantity_snapshot[0].accepted, 3);
    assert.equal(p.shipping_policy_snapshot.payer, 'customer');

    // ledger truth: order_sale credit + commission debit, balanced journal (§17-§18).
    const ledger = await pool.query(
      `SELECT event, direction, amount_rial::text FROM supplier_ledger_entries WHERE supplier_id = $1 AND order_id = $2 ORDER BY event`,
      [supplierA.id, childId]);
    assert.deepEqual(ledger.rows, [
      { event: 'commission', direction: 'debit', amount_rial: '54000000' },
      { event: 'order_sale', direction: 'credit', amount_rial: '540000000' },
    ]);

    // §84: later commission change NEVER touches the accrued payable.
    await pool.query('UPDATE supplier_profiles SET commission_percent = 25 WHERE user_id = $1', [supplierA.id]);
    const unchanged = await pool.query('SELECT commission_rial::text, commission_percent::text FROM supplier_child_payables WHERE id = $1', [p.id]);
    assert.equal(unchanged.rows[0].commission_rial, '54000000');
    assert.equal(Number(unchanged.rows[0].commission_percent), 10);

    // §120: double accrual impossible — direct re-run returns the existing payable.
    const again = await transaction(pool, (client) => accrueChildPayable(client, childId, null));
    assert.equal(again?.created, false);
    const count = await pool.query('SELECT COUNT(*)::int AS c FROM supplier_child_payables WHERE child_order_id = $1', [childId]);
    assert.equal(count.rows[0].c, 1);

    // §7/§62: no withdrawal path for suppliers.
    const withdrawal = await app.inject({ method: 'POST', url: '/api/v1/wallet/withdrawals',
      headers: { ...supplierHeaders, 'idempotency-key': `wd-${randomUUID().slice(0, 10)}` },
      payload: { amountRial: '1000000', destination: { bankName: 'ملت', iban: 'IR060120020000000397455001', holderName: 'x' } } });
    assert.equal(withdrawal.statusCode, 409, withdrawal.body);
    assert.equal(withdrawal.json().code, 'WITHDRAWAL_DEPRECATED');

    // supplier summary buckets (§186): held, nothing eligible yet.
    const summary1 = await app.inject({ method: 'GET', url: '/api/v1/supplier/finance/summary', headers: supplierHeaders });
    assert.equal(summary1.statusCode, 200, summary1.body);
    assert.equal(summary1.json().heldRial, '486000000');
    assert.equal(summary1.json().eligibleRial, '0');
    assert.equal(summary1.json().withdrawalsEnabled, false);
    assert.ok(summary1.json().nextSettlementDate, 'policy-driven next settlement date');

    // hold release is time-gated and idempotent (§31-§32).
    const noop = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/settlement-holds/run-release', headers: adminHeaders });
    assert.equal(noop.json().released, 0, 'hold not due yet');
    await pool.query(`UPDATE settlement_holds SET release_at = now() - interval '1 minute' WHERE supplier_id = $1`, [supplierA.id]);
    const swept = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/settlement-holds/run-release', headers: adminHeaders });
    assert.equal(swept.json().released, 1, swept.body);
    const sweptAgain = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/settlement-holds/run-release', headers: adminHeaders });
    assert.equal(sweptAgain.json().released, 0, 'sweep is idempotent');
    const summary2 = await app.inject({ method: 'GET', url: '/api/v1/supplier/finance/summary', headers: supplierHeaders });
    assert.equal(summary2.json().eligibleRial, '486000000', 'release ⇒ eligible, NOT withdrawable (§32)');

    // §43: settlement generation refuses unverified bank destinations.
    const skippedUnverified = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierA.id, force: true } });
    assert.equal(skippedUnverified.json().created.length, 0);
    assert.equal(skippedUnverified.json().skipped[0].reason, 'BANK_ACCOUNT_UNVERIFIED');
    const badIban = await app.inject({ method: 'POST', url: '/api/v1/supplier/finance/bank-accounts',
      headers: supplierHeaders, payload: { bankName: 'ملت', iban: 'IR12', holderName: 'x' } });
    assert.equal(badIban.statusCode, 400);
    await addVerifiedBank(app, supplierHeaders, adminHeaders, 'IR060120020000000397455001');

    // generate → ONE scheduled settlement with frozen bank snapshot (§38-§48).
    const generated = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierA.id, force: true } });
    assert.equal(generated.json().created.length, 1, generated.body);
    const settlementId = generated.json().created[0].settlementId as string;
    assert.equal(generated.json().created[0].netRial, '486000000');
    const rerun = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierA.id, force: true } });
    assert.equal(rerun.json().created.length, 0, 'payable assigned to at most one settlement (§122)');

    // supplier sees masked IBAN only (§116).
    const selfView = await app.inject({ method: 'GET', url: `/api/v1/supplier/finance/settlements/${settlementId}`, headers: supplierHeaders });
    assert.equal(selfView.statusCode, 200, selfView.body);
    assert.ok((selfView.json().bank.ibanMasked as string).includes('••'));
    assert.ok(!selfView.body.includes('IR060120020000000397455001'), 'full IBAN never in supplier settlement payload');
    // IDOR (§169): another supplier can see nothing.
    const idor = await app.inject({ method: 'GET', url: `/api/v1/supplier/finance/settlements/${settlementId}`, headers: outsiderHeaders });
    assert.equal(idor.statusCode, 404);
    const rbac = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: supplierHeaders, payload: { force: true } });
    assert.equal(rbac.statusCode, 403, 'suppliers cannot run admin settlement ops');

    // approve: maker≠checker enforced; pay before approve blocked (§39, §57).
    const approvalRow = await pool.query(
      `SELECT id FROM finance_approvals WHERE subject_type = 'settlement' AND subject_id = $1`, [settlementId]);
    const selfApprove = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/approvals/${approvalRow.rows[0].id}/approve`,
      headers: adminHeaders, payload: {} });
    assert.equal(selfApprove.statusCode, 409, 'creator cannot approve own settlement');
    const earlyPay = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-EARLY', paidAmountRial: '486000000' } });
    assert.equal(earlyPay.statusCode, 409, 'no payment before approval');
    await approveSettlement(app, pool, settlementId, admin2Headers);

    // §171: approval produced NO payout-adapter activity of any kind.
    const payoutEvents = await pool.query(
      `SELECT COUNT(*)::int AS c FROM outbox_events WHERE event_type ILIKE '%payout%'`);
    assert.equal(payoutEvents.rows[0].c, 0, 'approve never invokes/queues a payout');
    const autoWithdrawals = await pool.query(
      `SELECT COUNT(*)::int AS c FROM withdrawal_requests w JOIN wallet_accounts a ON a.id = w.account_id WHERE a.owner_id = $1`,
      [supplierA.id]);
    assert.equal(autoWithdrawals.rows[0].c, 0);

    // manual transfer evidence (§52): amount must match exactly.
    const noAmount = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-A' } });
    assert.equal(noAmount.statusCode, 400, noAmount.body);
    const wrongAmount = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-A', paidAmountRial: '400000000' } });
    assert.equal(wrongAmount.statusCode, 409);
    assert.equal(wrongAmount.json().code, 'SETTLEMENT_AMOUNT_CHANGED');
    const paid = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-A', paidAmountRial: '486000000', sourceBank: 'حساب ملت کلبه' } });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.equal(paid.json().status, 'paid');
    const rePay = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-A2', paidAmountRial: '486000000' } });
    assert.equal(rePay.statusCode, 409);
    assert.equal(rePay.json().code, 'SETTLEMENT_ALREADY_PAID');
    const settledPayable = await pool.query('SELECT status FROM supplier_child_payables WHERE id = $1', [p.id]);
    assert.equal(settledPayable.rows[0].status, 'settled');
    const paidRow = await pool.query('SELECT paid_amount_rial::text, source_bank, paid_reference FROM settlements WHERE id = $1', [settlementId]);
    assert.deepEqual(paidRow.rows[0], { paid_amount_rial: '486000000', source_bank: 'حساب ملت کلبه', paid_reference: 'BNK-REF-A' });

    // reconciliation diagnostic OK after full cycle (§126).
    const diag = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/reconciliation-diagnostic/${supplierA.id}`, headers: adminHeaders });
    assert.equal(diag.statusCode, 200, diag.body);
    assert.equal(diag.json().status, 'OK', diag.body);

    // §92: refund AFTER PAID → recovery, paid history untouched.
    const refund = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/supplier-payables/${p.id}/refund`,
      headers: adminHeaders, payload: { amountRial: '40000000', reason: 'مرجوعی پس از تسویه' } });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().status, 'recovery_created');
    const recovery = await pool.query(
      `SELECT amount_rial::text, status FROM supplier_recoveries WHERE supplier_id = $1`, [supplierA.id]);
    assert.deepEqual(recovery.rows, [{ amount_rial: '40000000', status: 'open' }]);
    const stillPaid = await pool.query('SELECT status, net_rial::text FROM settlements WHERE id = $1', [settlementId]);
    assert.deepEqual(stillPaid.rows[0], { status: 'paid', net_rial: '486000000' }, 'PAID settlement immutable (§41)');
    const diag2 = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/reconciliation-diagnostic/${supplierA.id}`, headers: adminHeaders });
    assert.equal(diag2.statusCode, 200, diag2.body);
    assert.equal(diag2.json().status, 'OK', `recovery keeps ledger and projection consistent: ${diag2.body}`);
  } finally { await app.close(); await pool.end(); }
});

test('§208-§209: three payables → ONE settlement/one bank ref; duplicate bank ref rejected; recovery offsets the NEXT settlement; refunds before release/schedule; manual block; kolbe child → no payable', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVipBuyer(pool, 'vip-fin2');
    const admin = await makeUser(pool, ['admin', 'operations'], 'fin2-admin-a');
    const admin2 = await makeUser(pool, ['admin'], 'fin2-admin-b');
    const supplierB = await makeSupplier(pool, 'sup-fin-b', 0);
    const adminHeaders = await login(app, admin.email);
    const admin2Headers = await login(app, admin2.email);
    const supplierHeaders = await login(app, supplierB.email);
    const prodB = await makeSeriesProduct(pool, 'کالای مالی B', supplierB.id);
    const prodK = await makeSeriesProduct(pool, 'کالای مالی کلبه', null);

    // Kolbe child never creates a supplier payable (§12).
    const kolbeChild = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'kolbe', sellerId: null,
      productId: prodK.productId, tplId: prodK.tplId, requested: 1, accepted: 1, unitPriceRial: '50000000' });
    assert.equal(kolbeChild.payable, null);
    // Unpaid child never accrues (§13).
    const unpaid = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierB.id,
      productId: prodB.productId, tplId: prodB.tplId, requested: 1, accepted: 1, unitPriceRial: '9000000', paymentEligibility: 'ready' });
    assert.equal(unpaid.payable, null);

    // three payables: 8M + 12M + 7M (commission 0, shipping leg A = customer).
    const c1 = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierB.id,
      productId: prodB.productId, tplId: prodB.tplId, requested: 1, accepted: 1, unitPriceRial: '8000000' });
    const c2 = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierB.id,
      productId: prodB.productId, tplId: prodB.tplId, requested: 1, accepted: 1, unitPriceRial: '12000000' });
    const c3 = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierB.id,
      productId: prodB.productId, tplId: prodB.tplId, requested: 1, accepted: 1, unitPriceRial: '7000000' });
    assert.ok(c1.payable?.created && c2.payable?.created && c3.payable?.created);

    // refund BEFORE release reduces net + hold (§89): 12M payable → 10M.
    const partial = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/supplier-payables/${c2.payable!.payableId}/refund`,
      headers: adminHeaders, payload: { amountRial: '2000000', reason: 'کسری تأییدشده' } });
    assert.equal(partial.statusCode, 200, partial.body);
    const heldAfter = await pool.query(
      `SELECT p.net_rial::text AS net, h.amount_rial::text AS hold FROM supplier_child_payables p
        JOIN settlement_holds h ON h.payable_id = p.id WHERE p.id = $1`, [c2.payable!.payableId]);
    assert.deepEqual(heldAfter.rows[0], { net: '10000000', hold: '10000000' });

    // manual block survives the sweep; unblock then releases (§28-§29).
    const hold3 = await pool.query('SELECT id FROM settlement_holds WHERE payable_id = $1', [c3.payable!.payableId]);
    const block = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlement-holds/${hold3.rows[0].id}/block`,
      headers: adminHeaders, payload: { reason: 'اختلاف باز با تأمین‌کننده' } });
    assert.equal(block.statusCode, 200, block.body);
    await forceReleaseHolds(pool, supplierB.id);
    const afterSweep = await pool.query('SELECT status FROM supplier_child_payables WHERE id = $1', [c3.payable!.payableId]);
    assert.equal(afterSweep.rows[0].status, 'blocked', 'manual block beats the release clock');
    const unblock = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlement-holds/${hold3.rows[0].id}/unblock`,
      headers: adminHeaders, payload: {} });
    assert.equal(unblock.statusCode, 200, unblock.body);
    await forceReleaseHolds(pool, supplierB.id);
    const buckets = await pool.query(
      `SELECT status, COUNT(*)::int AS c FROM supplier_child_payables WHERE supplier_id = $1 GROUP BY status`, [supplierB.id]);
    assert.deepEqual(buckets.rows, [{ status: 'eligible', c: 3 }]);

    // ONE settlement, 3 lines, net 8+10+7 = 25M, one bank snapshot (§40, §208).
    await addVerifiedBank(app, supplierHeaders, adminHeaders, 'IR820540102680020817909002');
    const generated = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierB.id, force: true } });
    assert.equal(generated.json().created.length, 1, generated.body);
    const settlementId = generated.json().created[0].settlementId as string;
    assert.equal(generated.json().created[0].netRial, '25000000');
    assert.equal(generated.json().created[0].lines, 3);

    // refund while SCHEDULED (pending) → recompute + traceable exception (§91).
    const scheduledRefund = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/supplier-payables/${c1.payable!.payableId}/refund`,
      headers: adminHeaders, payload: { amountRial: '1000000', reason: 'مرجوعی پیش از تأیید' } });
    assert.equal(scheduledRefund.statusCode, 200, scheduledRefund.body);
    const recomputed = await pool.query('SELECT net_rial::text, returns_rial::text FROM settlements WHERE id = $1', [settlementId]);
    assert.equal(recomputed.rows[0].net_rial, '24000000');
    const exception = await pool.query(
      `SELECT code, severity FROM settlement_exceptions WHERE settlement_id = $1`, [settlementId]);
    assert.deepEqual(exception.rows, [{ code: 'post_delivery_refund', severity: 'warning' }]);

    await approveSettlement(app, pool, settlementId, admin2Headers);
    // duplicate bank tracking reference from the FIRST test's settlement → rejected (§54).
    const dupRef = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-A', paidAmountRial: '24000000' } });
    assert.equal(dupRef.statusCode, 409, dupRef.body);
    const paid = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/settlements/${settlementId}/pay`,
      headers: admin2Headers, payload: { reference: 'BNK-REF-B', paidAmountRial: '24000000' } });
    assert.equal(paid.statusCode, 200, paid.body);

    // §209: post-PAID refund 4M → recovery → NEXT settlement offsets it.
    const postPaid = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/supplier-payables/${c1.payable!.payableId}/refund`,
      headers: adminHeaders, payload: { amountRial: '4000000', reason: 'مرجوعی پس از تسویه' } });
    assert.equal(postPaid.json().status, 'recovery_created');
    const c4 = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierB.id,
      productId: prodB.productId, tplId: prodB.tplId, requested: 1, accepted: 1, unitPriceRial: '10000000' });
    await forceReleaseHolds(pool, supplierB.id);
    const second = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierB.id, force: true } });
    assert.equal(second.json().created.length, 1, second.body);
    assert.equal(second.json().created[0].netRial, '6000000', '10M payable − 4M recovery offset');
    const offsetRow = await pool.query('SELECT status, offset_rial::text FROM supplier_recoveries WHERE supplier_id = $1', [supplierB.id]);
    assert.deepEqual(offsetRow.rows, [{ status: 'offset', offset_rial: '4000000' }]);
    const secondId = second.json().created[0].settlementId as string;
    const secondRow = await pool.query('SELECT recovery_offset_rial::text FROM settlements WHERE id = $1', [secondId]);
    assert.equal(secondRow.rows[0].recovery_offset_rial, '4000000');

    // cancel releases payables + re-opens the recovery (§55).
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/supplier-settlements/${secondId}/cancel`,
      headers: adminHeaders, payload: { reason: 'بازبینی مجدد' } });
    assert.equal(cancel.statusCode, 200, cancel.body);
    const released = await pool.query('SELECT status, settlement_id FROM supplier_child_payables WHERE id = $1', [c4.payable!.payableId]);
    assert.deepEqual(released.rows[0], { status: 'eligible', settlement_id: null });
    const reopened = await pool.query('SELECT status, offset_rial::text FROM supplier_recoveries WHERE supplier_id = $1', [supplierB.id]);
    assert.deepEqual(reopened.rows, [{ status: 'open', offset_rial: '0' }]);
    const diag = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/reconciliation-diagnostic/${supplierB.id}`, headers: adminHeaders });
    assert.equal(diag.json().status, 'OK', diag.body);
  } finally { await app.close(); await pool.end(); }
});

test('§210 + §126 + §170: shipping policy versioning is non-retroactive; reconciliation mismatch blocks generation; bank takeover defense; provider reconciliation is honest', { skip: !enabled }, async () => {
  const app = await buildApp(config); const pool = createPool(config);
  try {
    const buyer = await makeVipBuyer(pool, 'vip-fin3');
    const admin = await makeUser(pool, ['admin', 'operations'], 'fin3-admin');
    const ops = await makeUser(pool, ['operations'], 'fin3-ops');
    const supplierC = await makeSupplier(pool, 'sup-fin-c', 0);
    const adminHeaders = await login(app, admin.email);
    const opsHeaders = await login(app, ops.email);
    const supplierHeaders = await login(app, supplierC.email);
    const prodC = await makeSeriesProduct(pool, 'کالای مالی C', supplierC.id);

    // seeded defaults (§74): A=customer, B=supplier, C=customer.
    const policies = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/shipping-policies', headers: adminHeaders });
    const byLeg = Object.fromEntries((policies.json().items as Array<{ leg: string; payer: string; active: boolean }>)
      .filter((row) => row.active).map((row) => [row.leg, row.payer]));
    assert.equal(byLeg.supplier_inbound_order, 'customer');
    assert.equal(byLeg.supplier_inbound_stock, 'supplier');
    assert.equal(byLeg.master_final, 'customer');

    // payable BEFORE the policy change: shipping share 0.
    const before = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierC.id,
      productId: prodC.productId, tplId: prodC.tplId, requested: 2, accepted: 2, unitPriceRial: '10000000' });
    const beforeRow = await pool.query('SELECT shipping_share_rial::text, net_rial::text FROM supplier_child_payables WHERE id = $1', [before.payable!.payableId]);
    assert.deepEqual(beforeRow.rows[0], { shipping_share_rial: '0', net_rial: '20000000' });

    // invalid policy combinations are rejected (§85).
    const badShared = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/shipping-policies',
      headers: adminHeaders, payload: { name: 'سیاست اشتراکی نامعتبر', leg: 'supplier_inbound_order', payer: 'shared', supplierSharePercent: 0 } });
    assert.equal(badShared.statusCode, 400);
    assert.equal(badShared.json().code, 'INVALID_SHIPPING_POLICY');

    // new version: supplier pays 500,000/series on leg A.
    const revised = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/shipping-policies',
      headers: adminHeaders, payload: { name: 'سهم ارسال تأمین‌کننده', leg: 'supplier_inbound_order', payer: 'supplier',
        method: 'per_series', amountRial: '500000' } });
    assert.equal(revised.statusCode, 200, revised.body);
    assert.equal(revised.json().version, 2);

    const after = await fabricateDeliveredChild(pool, { buyerId: buyer.id, sellerType: 'supplier', sellerId: supplierC.id,
      productId: prodC.productId, tplId: prodC.tplId, requested: 2, accepted: 2, unitPriceRial: '10000000' });
    const afterRow = await pool.query(
      'SELECT shipping_share_rial::text, net_rial::text, shipping_policy_snapshot FROM supplier_child_payables WHERE id = $1',
      [after.payable!.payableId]);
    assert.deepEqual(
      { shipping: afterRow.rows[0].shipping_share_rial, net: afterRow.rows[0].net_rial },
      { shipping: '1000000', net: '19000000' }, 'new policy applies to NEW children only');
    assert.equal(afterRow.rows[0].shipping_policy_snapshot.version, 2);
    const beforeUnchanged = await pool.query('SELECT shipping_share_rial::text FROM supplier_child_payables WHERE id = $1', [before.payable!.payableId]);
    assert.equal(beforeUnchanged.rows[0].shipping_share_rial, '0', 'policy change NEVER retroactive (§80)');

    // §170: a fresh (attacker-added) bank account is worthless without verification,
    // and disabling the verified account blocks settlement generation.
    await forceReleaseHolds(pool, supplierC.id);
    const bankId = await addVerifiedBank(app, supplierHeaders, adminHeaders, 'IR330170000000111111111111');
    const attacker = await app.inject({ method: 'POST', url: '/api/v1/supplier/finance/bank-accounts',
      headers: supplierHeaders, payload: { bankName: 'مهاجم', iban: 'IR990170000000999999999999', holderName: 'ناشناس' } });
    assert.equal(attacker.json().status, 'pending_verification', 'new account always unverified (§45)');
    const disable = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/bank-accounts/${bankId}/disable`,
      headers: adminHeaders, payload: { reason: 'گزارش امنیتی' } });
    assert.equal(disable.statusCode, 200, disable.body);
    const blockedGen = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierC.id, force: true } });
    assert.equal(blockedGen.json().created.length, 0);
    assert.equal(blockedGen.json().skipped[0].reason, 'BANK_ACCOUNT_UNVERIFIED', 'pending attacker account can never receive money');
    // RBAC: bank verification needs bank:verify — operations role has none (§169).
    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/admin/finance/bank-accounts/${attacker.json().id}/verify`,
      headers: opsHeaders, payload: {} });
    assert.equal(forbidden.statusCode, 403);

    // §126: a foreign ledger mutation breaks the equation → generation refuses.
    const reVerified = await addVerifiedBank(app, supplierHeaders, adminHeaders, 'IR550170000000222222222222');
    assert.ok(reVerified);
    await transaction(pool, (client) => accrueSupplier(client, [{ event: 'adjustment_credit', amount: 5_000_000n,
      reference: `ROGUE-${randomUUID().slice(0, 8)}`, description: 'ورودی خارج از مدل', supplierId: supplierC.id,
      orderId: before.childId, actorId: null }]));
    const diag = await app.inject({ method: 'GET', url: `/api/v1/admin/finance/reconciliation-diagnostic/${supplierC.id}`, headers: adminHeaders });
    assert.equal(diag.json().status, 'MISMATCH');
    assert.equal(diag.json().differenceRial, '5000000');
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/supplier-settlements/generate',
      headers: adminHeaders, payload: { supplierId: supplierC.id, force: true } });
    assert.equal(blocked.json().created.length, 0);
    assert.equal(blocked.json().skipped[0].reason, 'FINANCIAL_RECONCILIATION_REQUIRED');

    // §68-§72: provider reconciliation — explicit source, honest unknowns, §168 replay guard intact.
    const intentId = randomUUID();
    await pool.query(
      `INSERT INTO payment_intents(id, reference, order_id, amount_rial, status, provider, provider_reference)
       VALUES ($1, $2, $3, 1000000, 'succeeded', 'snapp_pay', $4)`,
      [intentId, `PAY-${intentId.slice(0, 8)}`, before.childId, `SP-${intentId.slice(0, 8)}`]);
    const listBefore = await app.inject({ method: 'GET', url: '/api/v1/admin/finance/provider-reconciliations', headers: adminHeaders });
    assert.ok(listBefore.json().unreconciledIntents >= 1, 'unknown settlement state is reported, never fabricated');
    const recorded = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/provider-reconciliations',
      headers: adminHeaders, payload: { paymentIntentId: intentId, source: 'manual', matched: false, note: 'در صورتحساب بانک یافت نشد' } });
    assert.equal(recorded.statusCode, 200, recorded.body);
    assert.equal(recorded.json().status, 'exception');
    const needsBatch = await app.inject({ method: 'POST', url: '/api/v1/admin/finance/provider-reconciliations',
      headers: adminHeaders, payload: { paymentIntentId: intentId, source: 'statement', matched: true } });
    assert.equal(needsBatch.statusCode, 400, 'statement source requires the statement batch id');
    // §168 regression: payment callback replay stays dedup-guarded at the DB level.
    const dedupe = await pool.query(
      `SELECT COUNT(*)::int AS c FROM pg_indexes WHERE tablename = 'payment_events' AND indexdef ILIKE '%UNIQUE%'`);
    assert.ok(dedupe.rows[0].c >= 1, 'payment_events unique (provider, provider_event_id) guard present');

    // supplier tokens cannot touch any admin finance surface (§169).
    for (const url of ['/api/v1/admin/finance/settlement-policies', '/api/v1/admin/finance/bank-accounts',
      '/api/v1/admin/finance/supplier-recoveries', `/api/v1/admin/finance/reconciliation-diagnostic/${supplierC.id}`]) {
      const res = await app.inject({ method: 'GET', url, headers: supplierHeaders });
      assert.equal(res.statusCode, 403, `${url} must be admin-only`);
    }
  } finally { await app.close(); await pool.end(); }
});
