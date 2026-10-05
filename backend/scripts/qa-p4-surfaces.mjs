/* Prompt 5 — Browser QA for the Prompt-4 surfaces (§16/§20/§25/§26/§27/§38-§43).
   Uses the RUNNING stack (API :4000 + vite :5173). Screenshots → /tmp/kv-p4-shots.
   Run: LD_LIBRARY_PATH=… KV_CHROME_PATH=/tmp/chromium node scripts/qa-p4-surfaces.mjs      */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WEB = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const API = process.env.KV_API ?? 'http://127.0.0.1:4000';
const SHOTS = '/tmp/kv-p4-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, path, token, body) => {
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const login = async (identity, password) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await api('POST', '/auth/login', null, { identity, password });
    if (res.status === 200) return res.json.accessToken;
    if (res.status !== 429) throw new Error(`login ${identity}: ${res.status}`);
    await sleep(8000);
  }
  throw new Error('login rate limited');
};

const admin = await login('admin@kolbe.ir', 'ChangeMe-Admin-123456');
const supplier = await login('seed.supplier@kolbe.ir', 'Seed-Supplier-123456');
const customer = await login('seed.customer@kolbe.ir', 'Seed-Customer-123456');

/* Fixture: a fresh supplier product awaiting marketplace review (status=pending). */
const pendingName = `ژاکت QA بازبینی ${Date.now() % 100000}`;
const pendingProduct = await api('POST', '/products', supplier, {
  name: pendingName, brand: 'QA', category: 'کفش', cashPriceRial: '2500000', wholesalePriceRial: '1500000',
  variants: [{ color: 'سبز', size: '40' }],
});
if (pendingProduct.status !== 201 && pendingProduct.status !== 200) throw new Error(`fixture product failed: ${pendingProduct.status}`);

const browser = await puppeteer.launch({ executablePath: process.env.KV_CHROME_PATH ?? '/tmp/chromium', headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'] });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
const requestLog = [];
page.on('request', (r) => { if (r.url().includes('/api/v1/')) requestLog.push(`${r.method()} ${r.url().replace(API, '').replace(WEB, '')}`); });

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

try {
  /* ================= ADMIN CONSOLE ================= */
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${WEB}/#/admin`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  for (let attempt = 0; attempt < 4 && !(await text()).includes('برج کنترل'); attempt += 1) {
    const inputs = await page.$$('input');
    if (inputs.length >= 2) {
      await inputs[0].click({ clickCount: 3 }); await inputs[0].type('admin@kolbe.ir');
      await inputs[1].click({ clickCount: 3 }); await inputs[1].type('ChangeMe-Admin-123456');
      await clickText('button', 'ورود به کنسول');
      await waitText('برج کنترل', 40);
      if (!(await text()).includes('برج کنترل')) await sleep(12000);
    }
  }
  check('admin console login (real form)', (await text()).includes('برج کنترل'));

  const openSidebar = async (label, settle = 1500) => {
    await page.evaluate((t) => [...document.querySelectorAll('aside button')].find((b) => b.textContent?.includes(t))?.click(), label);
    await sleep(settle);
  };

  /* ---- §16 Finance Center: single IA with 6 groups, no demo numbers ---- */
  await openSidebar('مرکز مالی');
  const financeBody = await text();
  const groups = ['داشبورد', 'حوزه‌های مالی', 'پرداخت و تسویه', 'اسناد و گزارش‌ها', 'حسابداری', 'تنظیمات مالی'];
  check('Finance §16: all six IA groups visible', groups.every((g) => financeBody.includes(g)), groups.filter((g) => !financeBody.includes(g)).join(','));
  await clickText('button', 'حوزه‌های مالی'); await sleep(1200);
  const domainsBody = await text();
  check('Finance §16: domains group exposes streams + try-on tabs',
    domainsBody.includes('درآمدها و خدمات جانبی') && domainsBody.includes('سرویس پرو مجازی') && domainsBody.includes('مالی Marketplace تأمین‌کنندگان'));
  await clickText('button', 'سرویس پرو مجازی');
  await waitText('بسته', 20);
  const tryonBody = await text();
  check('Finance §24: try-on finance tab renders seeded package honestly', tryonBody.includes('پرو مجازی') && tryonBody.includes('بسته'));
  check('Finance §24: AI cost honesty (no invented cost figures)', /متصل نیست|Cost Not Connected|اتصال هزینه/.test(tryonBody) || !/هزینه AI/.test(tryonBody), 'cost section');
  await shot('01-finance-tryon');
  await clickText('button', 'درآمدها و خدمات جانبی'); await sleep(1500);
  check('Finance §17: revenue streams tab renders (server data)', (await text()).includes('درآمد'), '');
  await shot('02-finance-streams');

  /* ---- §27 CRM hub: exactly the four consolidated tabs, legacy gone ---- */
  await openSidebar('مرکز CRM');
  const crmBody = await text();
  const crmTabs = ['مشتریان خرده', 'خریداران VIP', 'تأمین‌کنندگان', 'بازاریابی'];
  check('CRM §27: four consolidated tabs present', crmTabs.every((t) => crmBody.includes(t)), crmTabs.filter((t) => !crmBody.includes(t)).join(','));
  check('CRM §27: no legacy duplicate CRM surface', !crmBody.includes('CRM قدیمی') && !crmBody.includes('مخاطبین (قدیمی)'));
  await shot('03-crm-hub');

  /* ---- §25/§26 two-step marketplace review; approval must NOT mutate stock ---- */
  const stockBefore = await api('GET', '/inventory?inventoryDomain=retail&withTotal=1&limit=100', admin);
  const sumBefore = (stockBefore.json?.items ?? []).reduce((a, r) => a + r.on_hand, 0);
  /* Prompt 1: the supplier review queue lives in WMS → انبار عمده → محصولات و بازبینی;
     the «استودیو محصول» sidebar entry was replaced by «محصولات کلبه». */
  await openSidebar('انبار و موجودی (WMS)');
  await clickText('button', 'انبار عمده'); await sleep(1200);
  await clickText('button', 'محصولات و بازبینی'); await sleep(1500);
  const reviewOpen = await waitText(pendingName, 30);
  check('Review §25: pending supplier product appears in review queue', reviewOpen);
  // open the review card for OUR product
  await page.evaluate((name) => {
    const card = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('بررسی') && b.closest('div')?.parentElement?.textContent?.includes(name));
    (card ?? [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('بررسی')))?.click();
  }, pendingName);
  await sleep(1200);
  const twoStep = await text();
  check('Review §25: step-1 gate offers تأیید و انتشار / عدم تأیید', twoStep.includes('تأیید و انتشار') && twoStep.includes('عدم تأیید'));
  await clickText('button', 'عدم تأیید'); await sleep(600);
  const disapprove = await text();
  check('Review §25: step-2 exposes اصلاح/رد with reason control', /درخواست اصلاح|رد محصول/.test(disapprove) && /دلیل/.test(disapprove));
  await shot('04-review-two-step');
  await clickText('button', 'تأیید و انتشار'); await sleep(400);          // back to approve gate
  // Two-step guarantee: approving a SUPPLIER product requires the documents checkbox.
  const docGate = await page.evaluate(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('مدارک تأمین‌کننده بررسی شد'));
    const box = label?.querySelector('input[type="checkbox"]') ?? label;
    if (!box) return false; box.click(); return true;
  });
  check('Review §25: supplier approval demands explicit documents check', docGate);
  // The SUBMIT button carries an icon (svg); the segmented option of the same label does not.
  await page.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'تأیید و انتشار' && b.querySelector('svg') && !b.disabled)?.click());
  await sleep(2500);
  const detail = await api('GET', `/admin/marketplace/products?search=${encodeURIComponent(pendingName)}`, admin);
  const approvedRow = detail.json?.items?.find((p) => p.name === pendingName);
  check('Review §25: approval persists (status no longer pending)', approvedRow ? approvedRow.status !== 'pending' : false, approvedRow?.status ?? 'row not found');
  const stockAfter = await api('GET', '/inventory?inventoryDomain=retail&withTotal=1&limit=100', admin);
  const sumAfter = (stockAfter.json?.items ?? []).reduce((a, r) => a + r.on_hand, 0);
  check('Review §26 RELEASE GATE: approval created ZERO stock rows / mutations',
    sumAfter === sumBefore && !(stockAfter.json?.items ?? []).some((r) => r.product_name === pendingName),
    `on-hand before=${sumBefore} after=${sumAfter}`);
  await shot('05-review-approved');

  /* ================= CUSTOMER STOREFRONT: try-on purchase UI (§20) ================= */
  await page.evaluate((tk) => localStorage.setItem('kolbe-access-token', tk), customer);
  await page.goto(WEB, { waitUntil: 'networkidle2' });
  await sleep(1500);
  // CMS-configurable nav label (currently «پرو مجازی و استایل‌بیلدر») — match by inclusion.
  await page.evaluate(() => [...document.querySelectorAll('header nav button')].find((b) => b.textContent?.includes('پرو مجازی'))?.click());
  await sleep(2000);
  const studioReady = await waitText('اعتبار پرو مجازی', 20);
  check('Try-on §20: credits card renders for logged-in customer', studioReady);
  if (studioReady) {
    const body = await text();
    check('Try-on §20: free-quota honesty + seeded package visible', body.includes('بسته ۵ پرو مجازی'), '');
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('div')].find((d) => d.textContent?.includes('بسته ۵ پرو مجازی') && d.querySelector('button'));
      [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('خرید'))?.click();
    });
    await sleep(2500);
    const purchased = await text();
    check('Try-on §20: purchase creates payment request with reference (no silent grant)',
      /درخواست پرداخت [A-Z]+-[\d-]+ ثبت شد/.test(purchased), (purchased.match(/درخواست پرداخت[^\n]*/) ?? [''])[0]);
    const purchases = await api('GET', '/tryon/purchases', customer);
    const pendingPurchase = (purchases.json?.items ?? []).find((p) => p.status === 'pending');
    check('Try-on §22: purchase stays pending until gateway verification (no credits granted)', Boolean(pendingPurchase)
      && (await api('GET', '/tryon/packages', customer)).json.balance === 0, `balance=${(await api('GET', '/tryon/packages', customer)).json?.balance}`);
  }
  await shot('06-tryon-purchase');

  /* ================= §39 responsive + §38 states + §42/§43 hygiene ================= */
  for (const [width, height, label] of [[360, 740, 'mobile-360'], [390, 844, 'mobile-390'], [768, 1024, 'tablet-768'], [1024, 768, 'laptop-1024'], [1440, 900, 'desktop-1440']]) {
    await page.setViewport({ width, height });
    await page.goto(WEB, { waitUntil: 'networkidle2' });
    await sleep(1800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`Responsive §39 storefront @${width}: no horizontal overflow`, overflow <= 2, `overflow ${overflow}px`);
    await shot(`07-resp-${label}`);
  }
  // console shell at mobile width (RTL admin)
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${WEB}/#/admin`, { waitUntil: 'networkidle2' });
  await sleep(2000);
  const adminOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('Responsive §39 admin console @390: no horizontal overflow', adminOverflow <= 2, `overflow ${adminOverflow}px`);
  await shot('08-admin-mobile');

  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools|status of 40|net::ERR_CONNECTION|WebSocket|value` prop/.test(e));
  check('Console §42: no unexpected page errors across all walks', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));
  // §43 targets LOOPS/polling storms, not per-page-load hydration (StrictMode doubles dev
  // effects). Measure a quiet window on an idle page: no API chatter without user action.
  requestLog.length = 0;
  await sleep(9000);
  check('Network §43: idle page issues no repeated API calls (no loops/polling storms)', requestLog.length <= 4, requestLog.slice(0, 6).join(' | '));
} finally {
  await browser.close().catch(() => undefined);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} P4-surface checks passed · shots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
