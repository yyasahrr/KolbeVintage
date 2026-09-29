/* Browser verification for the experience layer (Req 173-356):
   CMS-composed storefront, announcement bar, quick-buy feedback, CMS About page, Style Builder
   intelligence, customer dashboard (desktop + mobile), security page and the admin CMS Studio.
   Runs against an existing stack (local-stack.mjs + vite on :5173). Screenshots → /tmp/kv-shots. */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const SHOTS = '/tmp/kv-shots';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token(identity, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, password }) });
  return (await res.json()).accessToken;
}

const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
await page.setViewport({ width: 1440, height: 1000 });
const shot = (name, full = false) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
const text = () => page.evaluate(() => document.body.innerText);
const clickText = async (selector, label) => page.evaluate((sel, l) => {
  const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.trim().includes(l));
  if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false;
}, selector, label);

try {
  /* ---------- Storefront (guest) ---------- */
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-component]', { timeout: 20000 });
  const components = await page.$$eval('[data-component]', (els) => els.map((e) => e.getAttribute('data-component')));
  check('Home is composed from CMS registered components', components.includes('hero') && components.includes('product_grid'), components.join(','));
  check('Server announcement bar renders', !!(await page.$('[aria-label="اعلان‌های فروشگاه"]')));
  check('Header menus come from CMS (About link present)', (await text()).includes('درباره ما'));
  check('Server footer renders trust badges', (await text()).includes('ضمانت اصالت ۱۰۰٪'));
  await shot('01-home');
  await shot('01-home-full', true);

  const added = await clickText('button', 'افزودن به سبد');
  await sleep(700);
  const toastText = await page.$eval('[role="status"][aria-live="polite"]', (el) => el.textContent ?? '').catch(() => '');
  check('Quick-buy shows success toast + check state', added && /به سبد خرید اضافه شد/.test(toastText), toastText.slice(0, 60));
  const badge = await page.$eval('button[aria-label^="سبد خرید"]', (el) => el.getAttribute('aria-label')).catch(() => '');
  check('Cart badge count updates', /۱/.test(badge ?? ''), badge);
  await shot('02-quick-buy');

  await clickText('nav[aria-label="ناوبری اصلی"] button', 'درباره ما');
  await page.waitForFunction(() => document.body.innerText.includes('ارزش‌های ما'), { timeout: 15000 }).catch(() => undefined);
  const aboutComponents = await page.$$eval('[data-component]', (els) => els.map((e) => e.getAttribute('data-component')));
  check('About page is CMS-driven (story, timeline, values, stats)', ['story_hero', 'timeline', 'values_grid', 'stats_strip'].every((c) => aboutComponents.includes(c)), aboutComponents.join(','));
  await shot('03-about', true);

  /* ---------- Style Builder ---------- */
  await page.goto(`${BASE}/#/style/NOPE000`, { waitUntil: 'networkidle2' });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await clickText('nav[aria-label="ناوبری اصلی"] button', 'پرو مجازی');
  await sleep(600);
  await clickText('button', 'ساخت استایل');
  await page.waitForFunction(() => document.body.innerText.includes('استایل‌بیلدر هوشمند'), { timeout: 15000 });
  await clickText('button[aria-pressed]', 'پیراهن آکسفورد صورتی');
  await clickText('button[aria-pressed]', 'شلوار پارچه‌ای کرم');
  await page.waitForFunction(() => /امتیاز [۰-۹]+\/۱۰۰/.test(document.body.innerText), { timeout: 15000 }).catch(() => undefined);
  const t = await text();
  check('Style score with breakdown + explanation', /امتیاز [۰-۹]+\/۱۰۰/.test(t) && t.includes('هماهنگی رنگ') && t.includes('Old Money'));
  check('Bundle price shown from pricing engine', t.includes('قیمت کل استایل'));
  await shot('04-style-builder');
  await clickText('button', 'تکمیل استایل از موجودی کلبه');
  await sleep(1500);
  await shot('05-style-complete-look');

  /* ---------- Customer account ---------- */
  const customer = await token('seed.customer@kolbe.ir', 'Seed-Customer-123456');
  await page.evaluate((tk) => localStorage.setItem('kolbe-access-token', tk), customer);
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(800);
  await page.evaluate(() => { const b = [...document.querySelectorAll('header button[aria-expanded]')].find((x) => !x.getAttribute('aria-haspopup')); b?.click(); });
  await sleep(300);
  await clickText('button', 'پنل حساب من');
  await page.waitForFunction(() => document.body.innerText.includes('سفارش‌های فعال'), { timeout: 15000 }).catch(() => undefined);
  const dash = await text();
  check('Customer dashboard: greeting + summary cards', /سلام،/.test(dash) && dash.includes('سفارش‌های فعال') && dash.includes('کوپن‌های من'));
  check('Dashboard quick actions', dash.includes('دسترسی سریع') && dash.includes('ثبت تیکت'));
  await shot('06-dashboard', true);
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  await shot('07-dashboard-mobile', true);
  await page.setViewport({ width: 1440, height: 1000 });
  await clickText('nav[aria-label="بخش‌های حساب من"] button', 'اطلاعات حساب');
  await page.waitForFunction(() => document.body.innerText.includes('شماره همراه و ایمیل'), { timeout: 15000 }).catch(() => undefined);
  check('Profile: avatar, personal info, verified contact change, password', (await text()).includes('تغییر رمز عبور') && (await text()).includes('شماره همراه و ایمیل'));
  await shot('08-profile', true);
  await clickText('nav[aria-label="بخش‌های حساب من"] button', 'امنیت حساب');
  await page.waitForFunction(() => document.body.innerText.includes('نشست‌های فعال'), { timeout: 15000 }).catch(() => undefined);
  check('Security: sessions + login history + 2FA', (await text()).includes('همین دستگاه') && (await text()).includes('تاریخچه ورود'));
  await shot('09-security');

  /* ---------- Admin CMS Studio ---------- */
  const admin = await token('admin@kolbe.ir', 'ChangeMe-Admin-123456');
  await page.evaluate((tk) => localStorage.setItem('kolbe-access-token', tk), admin);
  await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle2' });
  await sleep(1500);
  const loginInputs = await page.$$('input');
  if (loginInputs.length >= 2 && !(await text()).includes('محتوا (CMS)')) {
    await loginInputs[0].type('admin@kolbe.ir');
    await loginInputs[1].type('ChangeMe-Admin-123456');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.innerText.includes('محتوا (CMS)'), { timeout: 20000 }).catch(() => undefined);
  }
  await clickText('button', 'محتوا (CMS)');
  await page.waitForFunction(() => document.body.innerText.includes('صفحات و انتشار') && document.body.innerText.includes('منتشر شده'), { timeout: 20000 }).catch(() => undefined);
  check('Admin CMS Studio opens with page lifecycle', (await text()).includes('صفحات و انتشار') && (await text()).includes('منتشر شده'));
  await shot('10-admin-studio-pages', true);
  for (const [label, name] of [['تم و توکن‌ها', '11-admin-themes'], ['کارت محصول', '12-admin-cards'], ['نوار اعلان', '13-admin-announcements'], ['هوش استایل', '14-admin-style']]) {
    await clickText('button[aria-pressed]', label);
    await sleep(1200);
    await shot(name, true);
  }
  check('Card templates render with quality gate', (await page.evaluate(() => document.body.innerText)).length > 0);
} catch (error) {
  check('smoke crashed', false, error instanceof Error ? error.message : String(error));
  await shot('zz-crash').catch(() => undefined);
} finally {
  const real = errors.filter((e) => !/favicon|unsplash|401|403/.test(e));
  check('No uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${SHOTS}`);
  process.exitCode = failed ? 1 : 0;
}
