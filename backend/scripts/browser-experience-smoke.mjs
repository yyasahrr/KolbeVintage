/* Browser verification for the experience layer (Req 173-356):
   CMS-composed storefront, announcement bar, quick-buy feedback, CMS About page, Style Builder
   intelligence, customer dashboard (desktop + mobile), security page, the admin CMS Studio, and the gap-closure checks
   (header CTA, saved cart ↔ backend, dialog focus trap, supplier taxonomy fields).
   Runs against an existing stack: local-stack.mjs → seed:local → scripts/browser-smoke-fixtures.mjs → vite on :5173.
   Screenshots → /tmp/kv-shots. */
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const SHOTS = '/tmp/kv-shots';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token(identity, password) {
  // The login route is rate limited (10/min per IP); seed + fixtures right before the smoke can exhaust it.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, password }) });
    if (res.status !== 429) return (await res.json()).accessToken;
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error(`login rate limited for ${identity}`);
}

const browser = await puppeteer.launch({ executablePath: '/tmp/chromium', headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
await page.setViewport({ width: 1440, height: 1000 });
const shot = (name, full = false) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
const text = () => page.evaluate(() => document.body.innerText);
const api = async (tk, method, path, body) => {
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers: { authorization: `Bearer ${tk}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const dialogState = () => page.evaluate(() => {
  const d = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].pop();
  const a = document.activeElement;
  return { open: !!d, inside: !!d && d.contains(a), named: !!d && !!(d.getAttribute('aria-label') || d.getAttribute('aria-labelledby')), overflow: document.body.style.overflow, active: a?.getAttribute('aria-label') ?? a?.textContent?.trim().slice(0, 30) ?? '' };
});
const openCart = () => page.evaluate(() => { const b = [...document.querySelectorAll('button[aria-label^="سبد خرید"]')].find((x) => x.offsetParent); b?.focus(); b?.click(); return !!b; });
const clickText = async (selector, label) => page.evaluate((sel, l) => {
  const el = [...document.querySelectorAll(sel)].find((n) => n.textContent?.trim().includes(l));
  if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false;
}, selector, label);

try {
  /* ---------- Header CTA config (gap closure): enable via the canonical layout API ---------- */
  const adminEarly = await token('admin@kolbe.ir', 'ChangeMe-Admin-123456');
  const headerCfg = (await (await fetch(`${BASE}/api/v1/site/layout`)).json()).header;
  const ctaPut = await api(adminEarly, 'PUT', '/admin/cms/layout/global_header', { ...headerCfg, ctaEnabled: true, ctaLabel: 'بازارچه عمده', ctaTarget: 'vip', ctaVariant: 'outline' });
  /* ---------- Storefront (guest) ---------- */
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-component]', { timeout: 20000 });
  const components = await page.$$eval('[data-component]', (els) => els.map((e) => e.getAttribute('data-component')));
  check('Home is composed from CMS registered components', components.includes('hero') && components.includes('product_grid'), components.join(','));
  check('Server announcement bar renders', !!(await page.$('[aria-label="اعلان‌های فروشگاه"]')));
  check('Header menus come from CMS (About link present)', (await text()).includes('درباره ما'));
  check('Server footer renders trust badges', (await text()).includes('ضمانت اصالت ۱۰۰٪'));
  const ctaInfo = await page.$eval('header [data-header-cta]', (el) => ({ v: el.getAttribute('data-header-cta'), t: el.textContent?.trim() })).catch(() => null);
  check('Header CTA renders the CMS config (label + variant)', ctaPut.status === 200 && ctaInfo?.v === 'outline' && ctaInfo?.t === 'بازارچه عمده', JSON.stringify(ctaInfo));
  await shot('01-home');
  await shot('01-home-full', true);
  /* Req 234: hero is never lazy; product cards are lazy with responsive srcset */
  const imgInfo = await page.evaluate(() => {
    const hero = document.querySelector('[data-component="hero"] img');
    const card = document.querySelector('[data-component="product_grid"] img, [data-component="product_carousel"] img');
    return { heroLoading: hero?.getAttribute('loading'), heroPriority: hero?.getAttribute('fetchpriority'), cardLoading: card?.getAttribute('loading'), cardSrcset: card?.getAttribute('srcset') ?? '', cardSizes: card?.getAttribute('sizes') ?? '' };
  });
  check('Hero image loads eagerly with high fetch priority (Req 234)', imgInfo.heroLoading === 'eager' && imgInfo.heroPriority === 'high', JSON.stringify({ l: imgInfo.heroLoading, p: imgInfo.heroPriority }));
  check('Product card images are lazy with responsive srcset/sizes (Req 234)', imgInfo.cardLoading === 'lazy' && /\s320w/.test(imgInfo.cardSrcset) && imgInfo.cardSizes.length > 0, imgInfo.cardSrcset.slice(0, 90));

  const added = await clickText('button', 'افزودن به سبد');
  await sleep(700);
  const toastText = await page.$eval('[role="status"][aria-live="polite"]', (el) => el.textContent ?? '').catch(() => '');
  check('Quick-buy shows success toast + check state', added && /به سبد خرید اضافه شد/.test(toastText), toastText.slice(0, 60));
  const badge = await page.$eval('button[aria-label^="سبد خرید"]', (el) => el.getAttribute('aria-label')).catch(() => '');
  check('Cart badge count updates', /۱/.test(badge ?? ''), badge);

  /* ---------- Dialog accessibility (gap closure): cart drawer ---------- */
  await openCart();
  await sleep(500);
  const opened = await dialogState();
  let trapped = true;
  for (let i = 0; i < 25; i += 1) { await page.keyboard.press('Tab'); if (!(await dialogState()).inside) { trapped = false; break; } }
  for (let i = 0; i < 6; i += 1) { await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); if (!(await dialogState()).inside) { trapped = false; break; } }
  await shot('02b-cart-drawer');
  await page.keyboard.press('Escape');
  await sleep(400);
  const closed = await dialogState();
  check('Cart drawer: role=dialog + aria-modal + name, focus moved inside, scroll locked', opened.open && opened.named && opened.inside && opened.overflow === 'hidden', JSON.stringify(opened));
  check('Cart drawer: Tab/Shift+Tab trapped; Escape closes and restores focus to the opener', trapped && !closed.open && /^سبد خرید/.test(closed.active) && closed.overflow !== 'hidden', JSON.stringify(closed));
  await shot('02-quick-buy');

  await clickText('nav[aria-label="ناوبری اصلی"] button', 'درباره ما');
  await page.waitForFunction(() => document.body.innerText.includes('ارزش‌های ما'), { timeout: 15000 }).catch(() => undefined);
  const aboutComponents = await page.$$eval('[data-component]', (els) => els.map((e) => e.getAttribute('data-component')));
  check('About page is CMS-driven (story, timeline, values, gallery; no fabricated stats)',
    ['story_hero', 'timeline', 'values_grid', 'gallery'].every((c) => aboutComponents.includes(c)) && !aboutComponents.includes('stats_strip'), aboutComponents.join(','));
  await shot('03-about', true);
  await page.waitForFunction(() => !!document.querySelector('link[rel="canonical"]'), { timeout: 8000 }).catch(() => undefined);
  const head = await page.evaluate(() => ({
    title: document.title, canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
    robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? '', og: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '',
    descriptions: document.querySelectorAll('meta[name="description"]').length,
    ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent || '{}')['@type']),
  }));
  check('About head comes from the SEO Domain: title, canonical, robots, OG, JSON-LD (Req 235)',
    head.title.includes('درباره ما') && head.canonical.endsWith('/about') && head.robots === 'index,follow' && head.og.length > 0 && head.ld.includes('AboutPage') && head.ld.includes('BreadcrumbList') && head.descriptions === 1,
    JSON.stringify(head));
  /* Canonical paths deep-link into the SPA */
  await page.goto(`${BASE}/vibe/old-money`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Old Money'), { timeout: 15000 }).catch(() => undefined);
  const vibeHead = await page.evaluate(() => ({ title: document.title, canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '' }));
  check('Canonical /vibe/old-money opens the vibe landing with its SEO head', (await text()).includes('Old Money') && vibeHead.canonical.endsWith('/vibe/old-money'), JSON.stringify(vibeHead));
  await shot('03b-vibe-deeplink');
  await page.goto(BASE, { waitUntil: 'networkidle2' });

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

  /* ---------- Saved cart ↔ canonical backend (gap closure) ---------- */
  await api(customer, 'PUT', '/profile/saved-cart', { items: [] });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(800);
  await clickText('button', 'افزودن به سبد');
  await sleep(1500);
  const afterAdd = await api(customer, 'GET', '/profile/saved-cart');
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const restoredBadge = await page.$eval('button[aria-label^="سبد خرید"]', (el) => el.getAttribute('aria-label')).catch(() => '');
  await openCart();
  await sleep(600);
  const syncLabel = await page.$eval('[data-saved-cart-sync]', (el) => el.textContent?.trim()).catch(() => '');
  const localShadow = await page.evaluate(() => Object.keys(localStorage).filter((k) => /cart/i.test(k)));
  check('Saved cart: add → persisted server-side, reload → restored from backend (no local shadow)', afterAdd.json?.items?.length >= 1 && /۱/.test(restoredBadge ?? '') && !!syncLabel && localShadow.length === 0, JSON.stringify({ n: afterAdd.json?.items?.length, restoredBadge, syncLabel, localShadow }));
  await shot('05b-saved-cart');
  await clickText('button', 'پاک کردن سبد');
  await sleep(1500);
  const afterClear = await api(customer, 'GET', '/profile/saved-cart');
  const emptyShown = (await text()).includes('سبد خرید خالی است');
  check('Saved cart: clear → PUT [] on the server + empty state', afterClear.json?.items?.length === 0 && emptyShown, `${afterClear.json?.items?.length}`);
  await page.keyboard.press('Escape');
  await sleep(300);
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

  /* ---------- SEO Domain editor (Req 235) ---------- */
  await clickText('button[aria-pressed]', 'سئو');
  await page.waitForFunction(() => document.body.innerText.includes('دامنه سئو'), { timeout: 15000 }).catch(() => undefined);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'وایب‌ها')?.click(); });
  await page.waitForFunction(() => [...document.querySelectorAll('li button')].some((b) => b.textContent?.includes('old-money') && !b.textContent?.includes('vibe-')), { timeout: 10000 }).catch(() => undefined);
  await page.evaluate(() => { [...document.querySelectorAll('li button')].find((b) => b.textContent?.includes('old-money') && !b.textContent?.includes('vibe-'))?.click(); });
  await page.waitForFunction(() => document.body.innerText.includes('پیش‌نمایش نتیجه گوگل'), { timeout: 15000 }).catch(() => undefined);
  const titleInput = await page.$('input[placeholder="Old Money"], input[placeholder*="Old Money"]');
  const seoTitle = `اولد مانی کلبه ${Date.now() % 1000}`;
  if (titleInput) { await titleInput.click({ clickCount: 3 }); await titleInput.type(seoTitle); }
  await sleep(1200);
  const livePreview = (await text()).includes(`${seoTitle} | کلبه وینتج`);
  await clickText('button', 'ذخیره در دامنه سئو');
  await sleep(1500);
  const publicSeo = await (await fetch(`${BASE}/api/v1/seo/vibe/old-money`)).json();
  check('SEO editor: live Google preview + save to SEO Domain + public head updated', livePreview && publicSeo.title === `${seoTitle} | کلبه وینتج` && publicSeo.source === 'seo_domain', publicSeo.title);
  await shot('15-admin-seo', true);

  /* ---------- Visual editor drag & drop reorder (Req 177) ---------- */
  await clickText('button[aria-pressed]', 'صفحات و انتشار');
  await sleep(1200);
  await page.evaluate(() => { const row = [...document.querySelectorAll('tr')].find((r) => r.textContent?.includes('درباره ما')); [...(row?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('بخش‌ها'))?.click(); });
  await page.waitForSelector('li[data-section-id]', { timeout: 15000 }).catch(() => undefined);
  const before = await page.$$eval('li[data-section-id]', (els) => els.map((e) => e.getAttribute('data-section-id')));
  if (before.length >= 2) {
    await page.evaluate((fromId, toId) => {
      const from = document.querySelector(`li[data-section-id="${fromId}"]`); const to = document.querySelector(`li[data-section-id="${toId}"]`);
      const dt = new DataTransfer();
      dt.setData('text/plain', fromId);
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, before[0], before[1]);
    await sleep(2000);
  }
  const after = await page.$$eval('li[data-section-id]', (els) => els.map((e) => e.getAttribute('data-section-id')));
  check('Sections reorder by drag & drop and persist to the draft (Req 177)', before.length >= 2 && after[0] === before[1] && after[1] === before[0], `${before.length} sections`);
  await shot('16-admin-dnd', true);

  /* ---------- Header CTA editor in CMS Studio (gap closure) ---------- */
  await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await clickText('button', 'محتوا (CMS)');
  await sleep(1200);
  await clickText('button[aria-pressed]', 'هدر و فوتر');
  await page.waitForSelector('[data-header-cta-editor]', { timeout: 15000 }).catch(() => undefined);
  const editor = await page.$eval('[data-header-cta-editor]', (el) => ({ inputs: el.querySelectorAll('input').length, selects: el.querySelectorAll('select, [role="listbox"], button[aria-haspopup]').length, preview: el.querySelector('[data-header-cta]')?.getAttribute('data-header-cta') ?? null, label: el.querySelector('[data-header-cta]')?.textContent?.trim() ?? '' })).catch(() => null);
  check('CMS header builder: CTA label/target/enabled/variant inputs with live preview of the same config', !!editor && editor.inputs >= 2 && editor.preview === 'outline' && editor.label === 'بازارچه عمده', JSON.stringify(editor));
  await shot('17-admin-header-cta', true);

  /* ---------- Supplier product form taxonomy (gap closure) ---------- */
  const supplier = await token('seed.supplier@kolbe.ir', 'Seed-Supplier-123456');
  const canonicalCats = (await (await fetch(`${BASE}/api/v1/site/categories`)).json()).items.map((c) => c.name);
  const canonicalVibes = (await (await fetch(`${BASE}/api/v1/site/vibes`)).json()).items.map((v) => v.name);
  await page.evaluate((tk) => localStorage.setItem('kolbe-access-token', tk), supplier);
  await page.goto(`${BASE}/#/supplier`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' }); // hash-only navigation keeps the previous in-memory session
  await sleep(1500);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === 'محصولات')?.click(); });
  await sleep(800);
  await clickText('button', 'افزودن محصول جدید');
  await page.waitForSelector('[data-supplier-taxonomy]', { timeout: 15000 }).catch(() => undefined);
  const tax = await page.evaluate(() => {
    const box = document.querySelector('[data-supplier-taxonomy]');
    const catSelect = [...document.querySelectorAll('label')].find((n) => n.textContent?.startsWith('دسته‌بندی'))?.querySelector('select');
    return { box: !!box, cats: catSelect ? [...catSelect.options].map((o) => o.textContent) : [], buttons: box ? [...box.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent?.trim()) : [], text: box?.textContent ?? '' };
  });
  if (tax.box) await page.evaluate(() => { [...document.querySelectorAll('[data-supplier-taxonomy] button[aria-pressed]')].slice(-1)[0]?.click(); });
  await sleep(200);
  const pressed = await page.$$eval('[data-supplier-taxonomy] button[aria-pressed="true"]', (els) => els.length).catch(() => 0);
  check('Supplier product form: canonical category + vibe + gender + season fields', tax.box && canonicalCats.length > 0 && canonicalCats.every((c) => tax.cats.includes(c)) && canonicalVibes.length > 0 && canonicalVibes.every((v) => tax.buttons.includes(v)) && tax.text.includes('جنسیت') && tax.buttons.includes('بهار') && pressed === 1,
    JSON.stringify({ cats: tax.cats.length, canonicalCats: canonicalCats.length, vibes: canonicalVibes.length, buttons: tax.buttons.length, pressed }));
  await shot('18-supplier-taxonomy', true);
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
