/* Corrective phase K3 — CRM 360 browser QA (§95-§102 slice).
   Verifies: Customer 360 opens as a CENTERED WorkspaceModal (not a side drawer),
   item-level «خریدها» chronology renders real order-line rows, consent toggles persist
   through the canonical endpoint (no 400) and survive reload, VIP + Supplier 360 are
   WorkspaceModals, and the generic «پروفایل و تایم‌لاین» tab is gone from CRM intelligence.
   Uses the RUNNING stack (API :4000 + vite :5173 + PGlite :55449). Screenshots → /tmp/kv-crm-shots.
   Run: LD_LIBRARY_PATH=/tmp/chromedeps/lib:/tmp/chromedeps KV_CHROME_PATH=/tmp/chromium node scripts/qa-crm-360.mjs */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import pg from 'pg';

const WEB = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const SHOTS = '/tmp/kv-crm-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55449/pglite' });
await db.connect();

const browser = await puppeteer.launch({ executablePath: process.env.KV_CHROME_PATH ?? '/tmp/chromium', headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'] });
const page = await browser.newPage();
const text = () => page.evaluate(() => document.body.innerText);
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const waitText = async (needle, attempts = 30) => {
  for (let i = 0; i < attempts; i += 1) { if ((await text()).includes(needle)) return true; await sleep(400); }
  return false;
};
const clickText = (selector, needle) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((b) => b.textContent?.includes(t) && !b.disabled);
  if (!el) return false; el.click(); return true;
}, selector, needle);
/* click a button INSIDE the topmost open dialog (the hub below may reuse the same labels) */
const clickInDialog = (needle) => page.evaluate((t) => {
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  if (!dialog) return false;
  const el = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === t && !b.disabled);
  if (!el) return false; el.click(); return true;
}, needle);

/* The centered 360 must be a WorkspaceModal: fixed overlay with a CENTERED panel
   (inset + items-center/justify-center), NOT a right-edge side sheet (justify-end). */
const modalProbe = () => page.evaluate(() => {
  const overlays = [...document.querySelectorAll('div[role="dialog"], div.fixed')].filter((d) => {
    const cls = d.className ?? ''; return typeof cls === 'string' && cls.includes('fixed') && cls.includes('inset-0');
  });
  const open = overlays.at(-1);
  if (!open) return { found: false };
  const cls = String(open.className);
  return { found: true, centered: cls.includes('justify-center') || cls.includes('items-center'), sideSheet: cls.includes('justify-end') };
});

try {
  /* ---------- login ---------- */
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${WEB}/#/admin`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  for (let attempt = 0; attempt < 4 && !(await text()).includes('برج کنترل'); attempt += 1) {
    const inputs = await page.$$('input');
    if (inputs.length >= 2) {
      await inputs[0].click({ clickCount: 3 }); await inputs[0].type('admin@kolbe.ir');
      await inputs[1].click({ clickCount: 3 }); await inputs[1].type('ChangeMe-Admin-123456');
      await clickText('button', 'ورود به کنسول');
      await sleep(2500);
    }
  }
  check('admin console login', (await text()).includes('برج کنترل'));

  /* ---------- CRM → مشتریان خرده ---------- */
  await clickText('button, a', 'مرکز CRM');
  await sleep(1500);
  check('CRM hub reachable', await waitText('مشتریان خرده'));
  await clickText('button', 'مشتریان خرده');
  await sleep(1500);

  /* Pick the first customer WITH orders (seeded) and open the 360. */
  const opened = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('پروفایل ۳۶۰°'));
    if (!btns.length) return false; btns[0].click(); return true;
  });
  check('§95 360 opens from retail list', opened);
  await sleep(2200);
  await shot('customer-360');

  const probe1 = await modalProbe();
  check('§55 Customer 360 is a CENTERED WorkspaceModal', probe1.found && probe1.centered && !probe1.sideSheet, JSON.stringify(probe1));
  check('§66 tabs present (خریدها/تاریخچه)', (await text()).includes('خریدها') && (await text()).includes('تاریخچه'));

  /* ---------- §56 item-level chronology ---------- */
  /* Find a customer that actually has purchases: iterate the list until the «خریدها» tab has rows. */
  let purchaseRows = 0; let triedCustomers = 0;
  for (let i = 0; i < 6 && purchaseRows === 0; i += 1) {
    await clickInDialog('خریدها');
    await sleep(1200);
    const body = await text();
    const hasHeaders = body.includes('مرجع سفارش') && body.includes('قیمت واحد');
    if (hasHeaders && !body.includes('خریدی ثبت نشده است')) {
      purchaseRows = await page.evaluate(() => {
        const ths = [...document.querySelectorAll('th')].filter((t) => t.textContent?.includes('مرجع سفارش'));
        const table = ths.at(-1)?.closest('table');
        return table ? table.querySelectorAll('tbody tr').length : 0;
      });
    }
    if (purchaseRows === 0) {
      /* close + open next customer */
      await page.keyboard.press('Escape'); await sleep(600);
      triedCustomers += 1;
      const ok = await page.evaluate((skip) => {
        const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('پروفایل ۳۶۰°'));
        if (!btns[skip]) return false; btns[skip].click(); return true;
      }, triedCustomers);
      if (!ok) break;
      await sleep(2000);
    }
  }
  await shot('customer-360-purchases');
  check('§56 item-level purchase rows render', purchaseRows > 0, `rows=${purchaseRows}`);
  const purchasesBody = await text();
  check('§97 order status localized (no raw enum in purchases)', !/pending_payment|ready_to_ship|in_transit/.test(purchasesBody));

  /* ---------- §63/§100 consent toggles persist ---------- */
  const marketingTab = await clickInDialog('بازاریابی');
  check('§66 marketing tab opens inside the 360', marketingTab);
  await sleep(1000);
  const consentBefore = await page.evaluate(() => {
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('پیامک تبلیغاتی'))?.querySelector('input[type="checkbox"]');
    return box ? box.checked : null;
  });
  let consent400 = false;
  page.on('response', (res) => { if (res.url().includes('/consent') && res.status() >= 400) consent400 = true; });
  await page.evaluate(() => {
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('پیامک تبلیغاتی'))?.querySelector('input[type="checkbox"]');
    box?.click();
  });
  await sleep(2500);
  const consentAfterToggle = await page.evaluate(() => {
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('پیامک تبلیغاتی'))?.querySelector('input[type="checkbox"]');
    return box ? box.checked : null;
  });
  check('§100 consent toggle flips without 400', consentBefore !== null && consentAfterToggle === !consentBefore && !consent400,
    `before=${consentBefore} after=${consentAfterToggle} saw400=${consent400}`);

  /* §99 persists after full reload */
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(2500);
  await clickText('button, a', 'مرکز CRM'); await sleep(1200);
  await clickText('button', 'مشتریان خرده'); await sleep(1500);
  await page.evaluate((skip) => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('پروفایل ۳۶۰°'));
    btns[skip]?.click();
  }, triedCustomers);
  await sleep(2200);
  await clickInDialog('بازاریابی'); await sleep(1000);
  const consentAfterReload = await page.evaluate(() => {
    const box = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('پیامک تبلیغاتی'))?.querySelector('input[type="checkbox"]');
    return box ? box.checked : null;
  });
  check('§99 consent persists after reload', consentAfterReload === consentAfterToggle, `reload=${consentAfterReload}`);

  /* audit row written */
  const audit = await db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'buyer.consent_updated'`);
  check('§63 consent change audited', Number(audit.rows[0].n) > 0, `audit rows=${audit.rows[0].n}`);
  await page.keyboard.press('Escape'); await sleep(600);

  /* ---------- §58 generic profile/timeline tab removed ---------- */
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'بازاریابی');
    btns[0]?.click();
  });
  await sleep(2000);
  const crmCenterBody = await text();
  check('§58 «پروفایل و تایم‌لاین» tab gone from CRM intelligence', !crmCenterBody.includes('پروفایل و تایم‌لاین'));

  /* ---------- VIP 360 is a WorkspaceModal ---------- */
  await clickText('button', 'خریداران VIP');
  await sleep(1800);
  const vipOpened = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('نمای ۳۶۰°'));
    if (!btns.length) return false; btns[0].click(); return true;
  });
  if (vipOpened) {
    await sleep(2200); await shot('vip-360');
    const probeVip = await modalProbe();
    check('§67 VIP 360 is a CENTERED WorkspaceModal', probeVip.found && probeVip.centered && !probeVip.sideSheet, JSON.stringify(probeVip));
    await page.keyboard.press('Escape'); await sleep(600);
  } else {
    check('§67 VIP 360 is a CENTERED WorkspaceModal', false, 'no VIP 360 button found');
  }

  /* ---------- Supplier 360 is a WorkspaceModal, reachable from every row ---------- */
  await clickText('button', 'تأمین‌کنندگان');
  await sleep(1800);
  const sup = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent?.includes('پرونده ۳۶۰°'));
    if (!btns.length) return false; btns[0].click(); return true;
  });
  check('§70 Supplier 360 reachable from supplier row', sup);
  if (sup) {
    await sleep(2500); await shot('supplier-360');
    const probeSup = await modalProbe();
    check('§101 Supplier 360 is a CENTERED WorkspaceModal (not drawer)', probeSup.found && probeSup.centered && !probeSup.sideSheet, JSON.stringify(probeSup));
    await page.keyboard.press('Escape'); await sleep(600);
  } else {
    check('§101 Supplier 360 is a CENTERED WorkspaceModal (not drawer)', false, 'could not open');
  }

  await shot('crm-final');
} catch (error) {
  console.error('FATAL', error);
  check('script completed without fatal error', false, error?.message);
} finally {
  await browser.close();
  await db.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}
