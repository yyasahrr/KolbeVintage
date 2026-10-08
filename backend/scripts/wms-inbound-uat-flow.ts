/* Prompt 6 interactive warehouse UAT (real browser + real API + real embedded PostgreSQL).

   This is the OPT-IN companion of the deterministic structural sweep in `wms-inbound-browser.mjs`.
   It exercises the OPERATIONAL forms an operator really uses — physical receiving (GRN), quality
   control and the Exception Center — with a real dispatched inbound shipment:

     1. the seeded supplier leg of the «[seed-oms]» master is driven through the canonical
        lifecycle (confirm → commit → buyer payment → ready → dispatch → inbound shipment),
     2. the leg is reset to a clean "dispatched" state so the run is repeatable,
     3. Chromium performs the receiving and the QC in the warehouse workspace and the script asserts
        the PERSISTED result (allocation buckets, stock balances, exceptions) — never the UI text
        alone,
     4. the exception centre is verified against `fulfillment_exceptions` (one open item per
        unresolved unit; assignment works).

   Prerequisites (the committed local UAT path):
     • terminal 1:  cd backend && KV_SEED_LOCAL=1 node scripts/local-stack.mjs
     • terminal 2:  KV_API_PROXY_TARGET=http://127.0.0.1:4000 node node_modules/vite/bin/vite.js --port 5173
     • a Chromium/Chrome binary (KV_CHROME_PATH, default /tmp/chromium)
   Run:  npm run test:wms-inbound-uat

   The run is SKIPPED (exit 0, clearly reported) when the seeded wholesale leg is absent, so it can
   never turn another gate red on a database that has not been seeded. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import puppeteer from 'puppeteer-core';
import { applyVerifiedPayment } from '../src/payments.js';

const API = process.env.KV_API ?? 'http://127.0.0.1:4000/api/v1';
const stackFile = process.env.KV_STACK_FILE ?? join(tmpdir(), 'kv-local-stack.json');
let databaseUrl = process.env.KV_DATABASE ?? null;
if (!databaseUrl) {
  try { databaseUrl = JSON.parse(readFileSync(stackFile, 'utf8')).databaseUrl as string; }
  catch { databaseUrl = null; }
}
const pool = new pg.Pool({ connectionString: databaseUrl ?? 'postgres://127.0.0.1:55449/pglite', max: 2 });
const chromePath = process.env.KV_CHROME_PATH ?? '/tmp/chromium';
const base = `http://localhost:${process.env.KV_WEB_PORT ?? 5173}`;
const results = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const login = async (identity: string, password: string): Promise<string> => {
  const response = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity, password }) });
  const body = await response.json() as { accessToken?: string };
  if (!response.ok || !body.accessToken) throw new Error(`login ${identity}: ${response.status} ${JSON.stringify(body)}`);
  return body.accessToken;
};
const call = async (path: string, token: string, payload?: unknown, key?: string) => {
  const response = await fetch(`${API}${path}`, { method: payload === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};

/* ------------------------------ fixture: dispatch one leg ------------------------------ */
const legQuery = `SELECT a.id AS allocation_id, a.line_id, a.child_order_id AS child_id, m.id AS master_id,
         u.email AS supplier_email, bu.email AS buyer_email
    FROM order_source_allocations a
    JOIN orders o ON o.id = a.child_order_id
    JOIN master_orders m ON m.id = o.master_order_id
    JOIN users u ON u.id = o.seller_id
    JOIN users bu ON bu.id = m.buyer_id
   WHERE a.source_type = 'supplier_external' AND a.status NOT IN ('released','cancelled','expired')
     AND bu.email = 'seed.customer@kolbe.ir'
   ORDER BY a.created_at DESC LIMIT 1`;
const legRow = (await pool.query<{ allocation_id: string; line_id: string; child_id: string; master_id: string;
  supplier_email: string; buyer_email: string }>(legQuery).catch(() => ({ rows: [] }))).rows[0];
if (!legRow) {
  console.log('SKIP  no seeded wholesale leg found — run `KV_SEED_LOCAL=1 node scripts/local-stack.mjs` first.');
  await pool.end();
  process.exit(0);
}
const CHILD = legRow.child_id;
const buyerToken = await login(legRow.buyer_email, 'Seed-Customer-123456');
const supplierToken = await login(legRow.supplier_email, 'Seed-Supplier-123456');
await call(`/wholesale/supplier/lines/${legRow.line_id}/respond`, supplierToken, { action: 'confirm' });
await call(`/wholesale/supplier/supply-requests/${legRow.allocation_id}/commit`, supplierToken, { note: 'تعهد UAT' }, `uat-commit-${legRow.allocation_id}`);
await call(`/wholesale/masters/${legRow.master_id}/lock`, buyerToken, {});
const childState = (await pool.query<{ payment_eligibility: string | null }>(
  'SELECT payment_eligibility FROM orders WHERE id = $1', [CHILD])).rows[0];
let paid = childState?.payment_eligibility === 'paid';
let paymentNote = paid ? 'child already paid' : '';
if (!paid) {
  const intent = await call(`/wholesale/children/${CHILD}/payment-intent`, buyerToken, {});
  let payable = intent.body?.intentId ? intent.body as { intentId: string; amountRial: string } : null;
  if (!payable) {
    const existing = await pool.query<{ payment_intent_id: string; amount_rial: string }>(
      `SELECT pa.payment_intent_id, pa.amount_rial FROM payment_allocations pa
         JOIN payment_intents pi ON pi.id = pa.payment_intent_id
        WHERE pa.child_order_id = $1 AND pi.status = 'pending'
        ORDER BY pi.created_at DESC LIMIT 1`, [CHILD]);
    payable = existing.rows[0] ? { intentId: existing.rows[0].payment_intent_id, amountRial: existing.rows[0].amount_rial } : null;
  }
  if (!payable) {
    console.log(`SKIP  the seeded child is not payable (${intent.status} ${JSON.stringify(intent.body)}) — reseed and retry.`);
    await pool.end();
    process.exit(0);
  }
  try {
    await applyVerifiedPayment(pool as unknown as Parameters<typeof applyVerifiedPayment>[0], {
      provider: 'nextpay', providerEventId: `uat-${randomUUID()}`, providerReference: `uat-${randomUUID().slice(0, 12)}`,
      intentId: payable.intentId, amountRial: payable.amountRial, paidAt: new Date() });
    paid = true;
  } catch (error) {
    paymentNote = (error as Error).message;
  }
}
if (!paid) {
  console.log(`SKIP  the seeded child could not be paid for this run (${paymentNote}) — reseed and retry.`);
  await pool.end();
  process.exit(0);
}
await call(`/wholesale/supplier/supply-requests/${legRow.allocation_id}/ready`, supplierToken, { note: 'آماده ارسال به انبار کلبه' }, `uat-ready-${legRow.allocation_id}`);
await call(`/wholesale/supplier/children/${CHILD}/dispatch`, supplierToken, {}, `uat-dispatch-${CHILD}`);
await call(`/wholesale/supplier/children/${CHILD}/inbound-shipment`, supplierToken,
  { carrier: 'باربری UAT', trackingCode: `UAT-${randomUUID().slice(0, 8)}` }, `uat-declare-${CHILD}`);
await pool.query(`UPDATE order_source_allocations SET received_series=0, received_missing_series=0, received_damaged_series=0,
    qc_passed_series=0, qc_rejected_series=0, qc_damaged_series=0, received_at=NULL, qc_at=NULL, receipt_note=NULL, qc_note=NULL
  WHERE child_order_id=$1`, [CHILD]);
await pool.query('DELETE FROM fulfillment_exceptions WHERE child_order_id=$1', [CHILD]);
await pool.query('DELETE FROM warehouse_receipts WHERE oms_inbound_shipment_id IN (SELECT id FROM oms_inbound_shipments WHERE child_order_id=$1)', [CHILD]);
await pool.query(`UPDATE oms_inbound_shipments SET status='dispatched', arrived_at=NULL, receiving_started_at=NULL,
    received_at=NULL, qc_completed_at=NULL WHERE child_order_id=$1`, [CHILD]);
await pool.query("UPDATE orders SET child_fulfillment='dispatched' WHERE id=$1", [CHILD]);
const shipment = (await pool.query<{ reference: string }>('SELECT reference FROM oms_inbound_shipments WHERE child_order_id=$1', [CHILD])).rows[0];
console.log(`[uat] fixture ready: inbound shipment ${shipment?.reference ?? '?'} awaiting physical receiving`);
const stockBefore = Number((await pool.query('SELECT COALESCE(SUM(on_hand),0)::int AS total FROM series_stock_balances')).rows[0].total);

/* ----------------------------------- browser session ----------------------------------- */
const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
const noise = /401 \(Unauthorized\)|ERR_CONNECTION_CLOSED|Failed to load resource: the server responded with a status of 401/;
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(String(error.message)));
page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()); });
const text = () => page.evaluate(() => document.body.innerText);
const clickByText = async (wanted: string, index = 0) => {
  const clicked = await page.evaluate((target: string, wantedIndex: number) => {
    const button = [...document.querySelectorAll('button')]
      .filter((candidate) => candidate.innerText.trim().includes(target) && !candidate.disabled)[wantedIndex];
    if (!button) return false;
    button.click();
    return true;
  }, wanted, index);
  await sleep(700);
  return clicked;
};
const setInput = async (labelText: string, value: string) => page.evaluate((target: string, val: string) => {
  const label = [...document.querySelectorAll('label')].find((candidate) => candidate.innerText.trim().startsWith(target));
  const input = label?.querySelector('input, textarea, select') as HTMLInputElement | null;
  if (!input) return false;
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, labelText, value);
const waitForText = async (needle: string, attempts = 30) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await text()).includes(needle)) return true;
    await sleep(400);
  }
  return false;
};

try {
  await page.goto(`${base}/#/admin`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  await setInput('ایمیل', 'admin@kolbe.ir');
  await setInput('گذرواژه', 'ChangeMe-Admin-123456');
  await clickByText('ورود');
  await sleep(2500);
  await page.goto(`${base}/#/admin/inbound-ops`, { waitUntil: 'networkidle2', timeout: 60000 });
  check('the warehouse workspace opens from the deep link', await waitForText('داشبورد انبار'));

  /* physical receiving */
  await clickByText('در انتظار دریافت');
  check('the dispatched shipment is queued for physical receiving', await waitForText(shipment?.reference ?? 'OIN-'));
  await clickByText('مشاهده و دریافت');
  check('the inbound shipment workspace offers the receive action', await waitForText('ثبت دریافت فیزیکی'));
  await clickByText('ثبت دریافت فیزیکی');
  check('the receive form explains the server reconciliation rule (received + missing = dispatched)',
    await waitForText('تعداد دریافتی و کسری باید با ارسالی'));
  await setInput('دریافت‌شده', '1');
  await setInput('کسری', '2');
  check('an inconsistent receive is flagged before submitting (fast feedback, server stays the authority)',
    await waitForText('دریافتی + کسری باید برابر'));
  await setInput('کسری', '1');
  await setInput('آسیب‌دیده', '0');
  await clickByText('ثبت نهایی دریافت');
  check('the physical receipt is recorded through the canonical endpoint', await waitForText('رسید فیزیکی ثبت شد'));
  await page.keyboard.press('Escape');
  await sleep(600);
  const afterReceive = (await pool.query<{ received_series: number; received_missing_series: number }>(
    'SELECT received_series, received_missing_series FROM order_source_allocations WHERE child_order_id = $1', [CHILD])).rows[0]!;
  check('the server persisted received=1 and the shortage as its own number (no silent reduction)',
    Number(afterReceive.received_series) === 1 && Number(afterReceive.received_missing_series) === 1,
    JSON.stringify(afterReceive));

  /* quality control */
  await clickByText('کنترل کیفیت');
  check('the received shipment moved to the QC queue', await waitForText(shipment?.reference ?? 'OIN-'));
  await clickByText('کنترل کیفیت', 1);
  check('the QC workspace opens for the received shipment', await waitForText('ثبت کنترل کیفیت'));
  await clickByText('ثبت کنترل کیفیت');
  check('the QC form states that accepted + rejected + damaged must equal the received quantity',
    await waitForText('جمع تأییدشده، رد‌شده و آسیب‌دیده باید دقیقاً برابر مقدار رسیدشده'));
  await setInput('تأییدشده', '1');
  await setInput('رد‌شده', '1');
  check('an inspection whose buckets exceed the receipt is flagged before submitting', await waitForText('جمع سه بخش باید دقیقاً برابر'));
  await setInput('تأییدشده', '0');
  await setInput('رد‌شده', '1');
  await clickByText('ثبت نهایی کنترل کیفیت');
  check('the inspection result is recorded through the canonical endpoint', await waitForText('نتیجه کنترل کیفیت ثبت شد'));
  await page.keyboard.press('Escape');
  await sleep(600);
  const afterQc = (await pool.query<{ qc_passed_series: number; qc_rejected_series: number; qc_damaged_series: number }>(
    'SELECT qc_passed_series, qc_rejected_series, qc_damaged_series FROM order_source_allocations WHERE child_order_id = $1', [CHILD])).rows[0]!;
  check('QC buckets are mutually exclusive and sum to the receipt (passed=0 rejected=1 damaged=0)',
    Number(afterQc.qc_passed_series) === 0 && Number(afterQc.qc_rejected_series) === 1 && Number(afterQc.qc_damaged_series) === 0,
    JSON.stringify(afterQc));
  const stockAfter = Number((await pool.query('SELECT COALESCE(SUM(on_hand),0)::int AS total FROM series_stock_balances')).rows[0].total);
  check('neither receiving nor QC credited any stock balance', stockAfter === stockBefore, `before=${stockBefore} after=${stockAfter}`);

  /* exception centre */
  await clickByText('نیازمند بررسی');
  check('the exception centre renders the missing unit as «مفقود در مسیر»', await waitForText('مفقود در مسیر'));
  const open = (await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM fulfillment_exceptions WHERE child_order_id = $1 AND status = 'open'", [CHILD])).rows[0]!;
  check('exactly the two unresolved units are open (shortage + QC rejection) without double counting',
    Number(open.n) === 2, `open=${open.n}`);
  check('the header shows the server open count in Persian digits', (await text()).includes('موارد باز: ۲'));
  await clickByText('واگذاری به من');
  check('an operator can take ownership of an exception (server-side assignment)',
    await waitForText('مورد به شما واگذار شد'));
  const realErrors = pageErrors.filter((entry) => !noise.test(entry));
  check('the interactive flow raised no page errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
} catch (error) {
  check('the interactive UAT completed without exceptions', false, String((error as Error).stack ?? error));
} finally {
  await browser.close();
  await pool.end();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} interactive WMS inbound UAT checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
