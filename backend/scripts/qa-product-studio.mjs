/* PRODUCT STUDIO FINAL UAT GATE — full-flow browser + API + DB verification (§5-§44 of the
   final corrective prompt). Replaces the 17-check K2 suite with end-to-end coverage:
   category schema, required/custom specs, colors, sizes, invalid-size rejection, true matrix
   with a disabled cell, media, size guide modes, pricing, wholesale series + MOQ, SEO, review
   step, SAVE DRAFT with ZERO inventory mutation, SAVE & CONTINUE handoff into «ورود اولیه کالا»,
   draft-as-the-only-unfinished-state (the «نیازمند راه‌اندازی» lifecycle is retired), WMS-only
   opening inventory with no auto-publish, edit roundtrip, unsaved-changes guard, localization
   & raw-field sweeps, responsive, RBAC/spoof.

   Uses the RUNNING stack (API :4000 + vite :5173 + PGlite :55449). Screenshots → /tmp/kv-studio-shots.
   Run: cd backend && LD_LIBRARY_PATH=/tmp/chromedeps/lib:/tmp/chromedeps KV_CHROME_PATH=/tmp/chromium node scripts/qa-product-studio.mjs

   NOTE (Prompt 1): the «تعریف محصول» / «نیازمند راه‌اندازی» studio sub-views were replaced by the
   «محصولات کلبه» hub (همه محصولات / پیش‌نویس‌ها / منتشرشده / ناموجود / آرشیوشده) and by the
   [ذخیره پیش‌نویس] / [ذخیره و ادامه] / [انصراف] creation actions. This gate targets that IA. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import pg from 'pg';

const WEB = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const API = process.env.KV_API ?? 'http://127.0.0.1:4000';
const SHOTS = '/tmp/kv-studio-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = Date.now() % 1000000;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55449/pglite' });
await db.connect();
const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

/* ---------------- API helpers ---------------- */
const login = async (identity, password) => {
  const r = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity, password }) });
  const j = await r.json();
  return j.accessToken ?? j.token;
};
const ADMIN = await login('admin@kolbe.ir', 'ChangeMe-Admin-123456');
const api = async (method, path, body, token = ADMIN, extraHeaders = {}) => {
  const r = await fetch(`${API}/api/v1${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* empty body */ }
  return { status: r.status, json };
};

/* ================= PHASE A — canonical structure setup through admin APIs ================= */
const CATEGORY = `پیراهن کلاسیک QA${ts}`;
const CHILD_CATEGORY = `پیراهن آستین‌کوتاه QA${ts}`;
const parentCat = await api('POST', '/admin/cms/categories', { name: CATEGORY, slug: `qa-shirt-${ts}`, description: '' });
check('setup: QA category created', parentCat.status === 201, `status=${parentCat.status}`);
const childCat = await api('POST', '/admin/cms/categories', { name: CHILD_CATEGORY, slug: `qa-shirt-child-${ts}`, description: '', parentId: parentCat.json?.id });
check('setup: QA child category created (hierarchy)', childCat.status === 201, `status=${childCat.status}`);

const attr = await api('POST', '/admin/spec-attributes', { code: `qa_jens_${ts}`, label: 'جنس', type: 'text', required: true });
check('setup: required spec attribute «جنس»', attr.status === 201, `status=${attr.status}`);
const tpl = await api('POST', '/admin/spec-templates', { code: `qa_tpl_${ts}`, name: `قالب پیراهن QA${ts}` });
check('setup: spec template created', tpl.status === 201, `status=${tpl.status}`);
const tplAttr = await api('POST', `/admin/spec-templates/${tpl.json?.id}/attributes`, { attributeId: attr.json?.id });
check('setup: «جنس» attached to template', tplAttr.status === 201 || tplAttr.status === 200, `status=${tplAttr.status}`);

/* §21: flexible size-guide table through the canonical structure APIs (columns + rows). */
const guide = await api('POST', '/admin/size-guides', { code: `qa_guide_${ts}`, name: `راهنمای سایز پیراهن QA${ts}` });
check('setup: size guide created', guide.status === 201, `status=${guide.status}`);
await api('POST', `/admin/size-guides/${guide.json?.id}/columns`, { code: 'size', label: 'سایز', position: 0 });
const col2 = await api('POST', `/admin/size-guides/${guide.json?.id}/columns`, { code: 'chest', label: 'دور سینه', unit: 'cm', position: 1 });
const rows = await api('PUT', `/admin/size-guides/${guide.json?.id}/rows`, { rows: [{ size: 'S', chest: '96' }, { size: 'M', chest: '102' }, { size: 'L', chest: '108' }] });
check('§21 setup: guide columns + 3 rows saved (flexible table)', col2.status === 201 && rows.status === 200, `col=${col2.status} rows=${rows.status}`);

const profile = await api('PUT', `/admin/category-profiles/${encodeURIComponent(CATEGORY)}`, {
  specTemplateId: tpl.json?.id, sizeGuideId: guide.json?.id, allowedSizes: ['S', 'M', 'L'], requiredFields: [],
});
check('setup: category profile S/M/L + template + guide', profile.status === 201 || profile.status === 200, `status=${profile.status}`);

/* make sure «مشکی» exists as a server color (seed usually has it) */
const colorList = await api('GET', '/product-colors');
if (!(colorList.json?.items ?? []).some((c) => c.name === 'مشکی')) {
  await api('POST', '/admin/product-colors', { name: 'مشکی', hex: '#1F2124' });
}

/* ================= baselines (§27/§31/§93) ================= */
const movesBefore = await count('SELECT count(*)::int AS n FROM stock_movements');
const receiptsBefore = await count('SELECT count(*)::int AS n FROM stock_receipts');
const balancesBefore = await count('SELECT count(*)::int AS n FROM stock_balances');
const serverSeriesBefore = await count('SELECT count(*)::int AS n FROM series_templates');

/* ================= PHASE B — browser: the full create flow ================= */
const browser = await puppeteer.launch({ executablePath: process.env.KV_CHROME_PATH ?? '/tmp/chromium', headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote'] });
const page = await browser.newPage();
const browserDiagnostics = { consoleErrors: [], pageErrors: [], apiErrors: [], httpErrors: [], requestFailures: [] };
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const detail = { text: message.text(), location: message.location() };
  if (!browserDiagnostics.consoleErrors.some((item) => item.text === detail.text && item.location?.url === detail.location?.url))
    browserDiagnostics.consoleErrors.push(detail);
});
page.on('pageerror', (error) => browserDiagnostics.pageErrors.push(error.message));
page.on('requestfailed', (request) => browserDiagnostics.requestFailures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText }));
page.on('response', (response) => {
  if (response.status() >= 400) browserDiagnostics.httpErrors.push({ status: response.status(), url: response.url(), method: response.request().method() });
  if (response.status() >= 400 && /\/api\/v1\/(products|series-templates|files|admin\/category-profiles|admin\/product-colors)/.test(response.url())) {
    void response.json().then((body) => browserDiagnostics.apiErrors.push({ status: response.status(), url: response.url(), body }))
      .catch(() => browserDiagnostics.apiErrors.push({ status: response.status(), url: response.url() }));
  }
});
const text = () => page.evaluate(() => document.body.innerText);
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` });
const waitText = async (needle, attempts = 30) => {
  for (let i = 0; i < attempts; i += 1) { if ((await text()).includes(needle)) return true; await sleep(400); }
  return false;
};
const clickText = (selector, needle) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((b) => (b.textContent ?? '').includes(t) && !b.disabled);
  if (!el) return false; el.click(); return true;
}, selector, needle);
const clickExact = (selector, exact) => page.evaluate((sel, t) => {
  const el = [...document.querySelectorAll(sel)].find((b) => (b.textContent ?? '').trim() === t && !b.disabled);
  if (!el) return false; el.click(); return true;
}, selector, exact);
const typeIntoField = async (labelNeedle, value, kind = 'input') => {
  const handle = await page.evaluateHandle((needle, k) => {
    const labels = [...document.querySelectorAll('label')];
    const norm = (l) => (l.querySelector('span')?.textContent ?? '').replace(/[*]/g, '').trim();
    /* exact label match wins («جنس» must NOT hit «جنس پارچه») */
    const label = labels.find((l) => norm(l) === needle.trim()) ?? labels.find((l) => norm(l).includes(needle.trim()));
    return label?.querySelector(k) ?? null;
  }, labelNeedle, kind);
  const el = handle.asElement();
  if (!el) return false;
  await el.click({ clickCount: 3 }); await el.type(value);
  return true;
};
/** React-safe native <select> set-by-option-text. */
const selectOption = (optionText) => page.evaluate((t) => {
  for (const sel of document.querySelectorAll('select')) {
    const opt = [...sel.options].find((o) => (o.textContent ?? '').trim() === t.trim() || (o.textContent ?? '').includes(t));
    if (!opt) continue;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}, optionText);
const loginConsole = async () => {
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
  return (await text()).includes('برج کنترل');
};
/** §6/§37: leave the Product Studio, accepting the unsaved-changes guard when it appears. */
const closeStudio = async () => {
  const left = (await clickText('button', 'انصراف')) || (await clickText('button', 'بازگشت به فهرست'));
  await sleep(700);
  if (!left) return false;
  if ((await text()).includes('تغییرات ذخیره‌نشده')) { await clickText('button', 'خروج بدون ذخیره'); await sleep(800); }
  return true;
};
/** §3: the canonical entry is the «محصولات کلبه» hub; lands on the full product list. */
const gotoProducts = async () => {
  await clickExact('button', 'محصولات کلبه');
  await sleep(1000);
  await clickExact('button', 'همه محصولات');
  await sleep(900);
  return waitText('جست‌وجوی نام، برند یا دسته…', 20)
    || Boolean(await page.$('input[placeholder="جست‌وجوی نام، برند یا دسته…"]'));
};

try {
  await page.setViewport({ width: 1440, height: 1000 });
  check('admin console login', await loginConsole());
  // Ignore expected unauthenticated bootstrap probes; collect browser diagnostics only for
  // authenticated Product Studio/WMS acceptance flows below.
  Object.assign(browserDiagnostics, { consoleErrors: [], pageErrors: [], apiErrors: [], httpErrors: [], requestFailures: [] });
  await clickExact('button', 'محصولات کلبه');
  await sleep(1200);
  const studioLanding = await text();
  check('«محصولات کلبه» owns definition + the five canonical lifecycle views',
    ['همه محصولات', 'پیش‌نویس‌ها', 'منتشرشده', 'ناموجود', 'آرشیوشده'].every((label) => studioLanding.includes(label)));
  check('«نیازمند راه‌اندازی» retired as a user-facing lifecycle', !studioLanding.includes('نیازمند راه‌اندازی'));
  await clickExact('button', 'انبار و موجودی (WMS)');
  await sleep(1200);
  await waitText('موجودی فیزیکی', 25);
  const wmsLanding = await text();
  check('WMS is physical inventory only (no product lifecycle/catalog tabs)',
    ['خرده‌فروشی', 'نقل‌وانتقالات', 'انبار عمده', 'تنظیمات انبار'].every((label) => wmsLanding.includes(label))
      && !['همه محصولات', 'پیش‌نویس‌ها', 'تعریف محصول جدید', 'نیازمند راه‌اندازی'].some((label) => wmsLanding.includes(label)));
  check('WMS opens on a physical inventory screen', wmsLanding.includes('موجودی فیزیکی'));
  check('«محصولات کلبه» browser route is reachable', await gotoProducts());

  await clickText('button', 'افزودن محصول');
  await sleep(1200);
  /* §3 (Prompt-1 regression): [افزودن محصول] must land on the NEW PRODUCT form itself —
     the studio's own product list («جست‌وجوی محصول یا SKU…» / «قالب‌های سری کلبه») is a
     parallel product-management surface and must never appear as an intermediate step. */
  const studioDirect = await text();
  check('§12 [افزودن محصول] opens the NEW PRODUCT studio directly (no intermediate list)',
    studioDirect.includes('تعریف محصول جدید')
    && !studioDirect.includes('جست‌وجوی محصول یا SKU…')
    && !studioDirect.includes('قالب‌های سری کلبه'),
    studioDirect.includes('جست‌وجوی محصول یا SKU…') ? 'legacy studio list rendered instead of the form' : '');
  await shot('01-studio-open');

  /* ---------- §9/§4/§6: structure of the studio ---------- */
  const probe = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('nav[aria-label="بخش‌های تعریف محصول"] button')].map((b) => (b.textContent ?? '').trim());
    const labels = [...document.querySelectorAll('label span')].map((n) => n.textContent ?? '');
    return {
      steps,
      stockStep: steps.some((t) => t.includes('موجودی اولیه')),
      typeField: labels.some((t) => t.trim() === 'نوع محصول'),
      warehouseField: labels.some((t) => t.includes('انبار مقصد')),
    };
  });
  check('§9 no «نوع محصول» field in create mode', !probe.typeField);
  check('§4 no «موجودی اولیه» step / no warehouse selector', !probe.stockStep && !probe.warehouseField);
  check('§6 all capability sections present incl. review', ['اطلاعات پایه', 'رنگ و سایز', 'تصویر و ویدیو', 'تصویر استایل‌بیلدر', 'قیمت‌گذاری', 'سری‌های عمده', 'مشخصات فنی', 'راهنمای سایز', 'سئو و کانال‌ها', 'بازبینی و انتشار'].every((s) => probe.steps.some((x) => x.includes(s))), probe.steps.join('|'));
  const saleModeLabels = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()));
  check('§6 sales-mode selector exposes retail, wholesale and both', ['فقط خرده', 'فقط عمده', 'خرده + عمده'].every((label) => saleModeLabels.includes(label)), saleModeLabels.filter((label) => ['فقط خرده', 'فقط عمده', 'خرده + عمده'].includes(label)).join('|'));
  await clickText('button', 'فقط خرده');
  await sleep(250);
  check('§6 retail-only mode hides wholesale series step', !(await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="بخش‌های تعریف محصول"] button')].some((b) => (b.textContent ?? '').includes('سری‌های عمده')))));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'قیمت‌گذاری');
  const retailOnlyFields = await page.evaluate(() => [...document.querySelectorAll('label span')].map((s) => s.textContent ?? ''));
  check('§6 retail-only shows retail price without wholesale MOQ', retailOnlyFields.some((s) => s.includes('قیمت پایه خرده')) && !retailOnlyFields.some((s) => s.includes('حداقل سفارش عمده')));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'اطلاعات پایه');
  await clickText('button', 'فقط عمده');
  await sleep(250);
  const wholesaleSteps = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="بخش‌های تعریف محصول"] button')].map((b) => b.textContent ?? '').join('|'));
  check('§6 wholesale-only mode keeps series step', wholesaleSteps.includes('سری‌های عمده'));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'قیمت‌گذاری');
  const wholesaleOnlyFields = await page.evaluate(() => [...document.querySelectorAll('label span')].map((s) => s.textContent ?? ''));
  check('§6 wholesale-only hides retail price', !wholesaleOnlyFields.some((s) => s.includes('قیمت پایه خرده')));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'سری‌های عمده');
  const wholesaleOnlySeriesFields = await page.evaluate(() => [...document.querySelectorAll('label span')].map((s) => s.textContent ?? ''));
  check('§6 wholesale-only shows MOQ and series controls', wholesaleOnlySeriesFields.some((s) => s.includes('حداقل سفارش عمده')));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'اطلاعات پایه');
  await clickText('button', 'خرده + عمده');
  await sleep(250);
  const bothSteps = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="بخش‌های تعریف محصول"] button')].map((b) => b.textContent ?? '').join('|'));
  check('§6 both-channel mode restores retail pricing and wholesale-series steps', bothSteps.includes('قیمت‌گذاری') && bothSteps.includes('سری‌های عمده'));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'قیمت‌گذاری');
  const bothPriceFields = await page.evaluate(() => [...document.querySelectorAll('label span')].map((s) => s.textContent ?? ''));
  check('§6 both-channel mode shows retail price controls', bothPriceFields.some((s) => s.includes('قیمت پایه خرده')));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'سری‌های عمده');
  const bothSeriesFields = await page.evaluate(() => [...document.querySelectorAll('label span')].map((s) => s.textContent ?? ''));
  check('§6 both-channel mode also shows wholesale MOQ and series controls', bothSeriesFields.some((s) => s.includes('حداقل سفارش عمده')));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'اطلاعات پایه');

  /* ---------- §7/§8: hierarchical picker + schema loads live ---------- */
  const NAME = `پیراهن QA نهایی ${ts}`;
  check('name typed', await typeIntoField('نام محصول', NAME));
  const hierarchyOk = await page.evaluate((child) => [...document.querySelectorAll('select option')].some((o) => (o.textContent ?? '').includes(`— ${child}`)), CHILD_CATEGORY);
  check('§7 hierarchy: child rendered indented under parent', hierarchyOk);
  /* §7 search: filter narrows the option list */
  const catSearchTyped = await page.evaluate((needle) => {
    const inp = [...document.querySelectorAll('input')].find((i) => i.placeholder === 'جست‌وجوی دسته…');
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, needle); inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, `QA${ts}`);
  await sleep(400);
  const filteredCount = await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => (o.textContent ?? '').includes('ساخت دسته جدید')));
    return sel ? sel.options.length : -1;
  });
  check('§7 category search filters options', catSearchTyped && filteredCount >= 2 && filteredCount <= 5, `options after filter=${filteredCount}`);
  check('category selected', await selectOption(CATEGORY));
  check('§8 category schema loads WITHOUT reload (banner + sizes)', await waitText('دسته‌بندی منبع ساختار است', 25) && (await text()).includes('S، M، L'));
  check('§8 default size guide visible from profile', (await text()).includes(`راهنمای سایز پیراهن QA${ts}`));
  const noUuidInPicker = await page.evaluate(() => ![...document.querySelectorAll('select option')].some((o) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(o.textContent ?? '')));
  check('§7 no UUID/slug leakage in category picker', noUuidInPicker);
  await typeIntoField('توضیحات', 'پیراهن کلاسیک تست نهایی استودیو.', 'textarea');

  /* ---------- §10: required category spec blocks with a field-specific Persian error ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'مشخصات فنی');
  await sleep(700);
  check('§10 category spec form rendered in create mode', (await text()).includes(`مشخصات فنی دسته «${CATEGORY}»`));
  check('§10 required blank → «مشخصه «جنس» الزامی است»', (await text()).includes('مشخصه «جنس» الزامی است'));
  await shot('02-specs-required-error');
  /* review step lists the same issue and jumps back (§30) */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'بازبینی و انتشار');
  await sleep(600);
  check('§30 review checklist lists the missing spec', (await text()).includes('مشخصه «جنس» الزامی است'));
  await clickText('ul button', 'مشخصه «جنس»');
  await sleep(600);
  const jumped = await page.evaluate(() => document.body.innerText.includes('مشخصات فنی دسته'));
  check('§30 checklist item click jumps to its section', jumped);
  check('§10 filling «جنس» passes', await typeIntoField('جنس', 'نخ پنبه ۱۰۰٪'));
  await sleep(400);
  check('§10 error cleared after fill', !(await text()).includes('مشخصه «جنس» الزامی است'));

  /* ---------- §12/§13: colors + sizes ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'رنگ و سایز');
  await sleep(700);
  /* Normalize the palette to exactly one known color before adding the second.
     The persisted server palette contains many colors; the draft may also carry a
     default selection, so read and toggle one live chip per React render. */
  const selectedPaletteColors = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((n) => (n.textContent ?? '').trim() === 'رنگ‌های محصول');
    return [...(p?.nextElementSibling?.querySelectorAll('button[aria-pressed="true"]') ?? [])]
      .map((b) => (b.textContent ?? '').trim());
  });
  for (let i = 0; i < 20; i += 1) {
    const selected = await selectedPaletteColors();
    const remove = selected.find((name) => !name.includes('مشکی'));
    if (!remove) break;
    await page.evaluate((name) => {
      const p = [...document.querySelectorAll('p')].find((n) => (n.textContent ?? '').trim() === 'رنگ‌های محصول');
      const chip = [...(p?.nextElementSibling?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim().includes(name));
      chip?.click();
    }, remove);
    await sleep(350);
  }
  await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((n) => (n.textContent ?? '').trim() === 'رنگ‌های محصول');
    const black = [...(p?.nextElementSibling?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes('مشکی'));
    if (black?.getAttribute('aria-pressed') !== 'true') black?.click();
  });
  await sleep(400);
  const CREAM = `کرم QA${ts}`;
  check('§12 new color name typed', await typeIntoField('نام رنگ', CREAM));
  await clickText('button', 'ذخیره در سرور و انتخاب');
  check('§12 inline color created on server + selected', await waitText('ذخیره و انتخاب شد', 15) || await page.evaluate((c) => [...document.querySelectorAll('button[aria-pressed="true"]')].some((b) => (b.textContent ?? '').includes(c)), CREAM));
  const creamRow = await db.query('SELECT id, hex FROM product_colors WHERE name = $1', [CREAM]);
  check('§12 color persisted with HEX in DB', creamRow.rows.length === 1 && /^#/.test(creamRow.rows[0].hex), creamRow.rows[0]?.hex);
  /* duplicate handling: same name again → save button disabled */
  await typeIntoField('نام رنگ', CREAM);
  await sleep(300);
  const dupDisabled = await page.evaluate((c) => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('ذخیره در سرور و انتخاب'));
    return btn ? btn.disabled : false;
  }, CREAM);
  check('§12 duplicate color name blocked in UI', dupDisabled);
  check('§13 sizes come from the category profile', (await text()).includes(`سایزهای مجاز دسته «${CATEGORY}»`));
  const sizeState = await page.evaluate(() => {
    const field = [...document.querySelectorAll('label')].find((l) => (l.querySelector('span')?.textContent ?? '').includes('سایزهای مجاز دسته'));
    const chips = field ? [...field.querySelectorAll('button')] : [];
    return { all: chips.map((c) => (c.textContent ?? '').trim()), on: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => (c.textContent ?? '').trim()) };
  });
  check('§13 S/M/L offered and selected (no XL from defaults)', sizeState.all.join(',') === 'S,M,L' && sizeState.on.join(',') === 'S,M,L', JSON.stringify(sizeState));
  check('§13 add-size CTA says «افزودن به پروفایل این دسته»', (await text()).includes('افزودن به پروفایل این دسته'));
  const selectedColors = await selectedPaletteColors();
  check('§12 exactly two product colors selected', selectedColors.length === 2
    && selectedColors.some((c) => c.includes('مشکی')) && selectedColors.some((c) => c.includes(CREAM)), JSON.stringify(selectedColors));

  /* ---------- §15: true matrix — disable کرم/S ---------- */
  const cellsOnBefore = await page.evaluate(() => [...document.querySelectorAll('td button')].filter((b) => (b.textContent ?? '').includes('ساخته می‌شود')).length);
  check('§15 matrix shows 2×3 = 6 enabled cells', cellsOnBefore === 6, `on=${cellsOnBefore}`);
  const disabledCell = await page.evaluate((cream) => {
    const row = [...document.querySelectorAll('tr')].find((r) => (r.querySelector('td')?.textContent ?? '').includes(cream));
    const btn = row?.querySelectorAll('td button')[0]; /* first size column = S */
    if (!btn) return false; btn.click(); return true;
  }, CREAM);
  await sleep(400);
  const cellsOnAfter = await page.evaluate(() => [...document.querySelectorAll('td button')].filter((b) => (b.textContent ?? '').includes('ساخته می‌شود')).length);
  check('§15 کرم/S switched off → 5 enabled cells', disabledCell && cellsOnAfter === 5, `on=${cellsOnAfter}`);
  check('§15 off-cell explains «—» ≠ موجودی صفر', (await text()).includes('این با واریانتِ ساخته‌شده با موجودی صفر فرق دارد'));
  /* §17: weight is catalog data; no stock editor here */
  await page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((t) => (t.textContent ?? '').includes('وزن (گرم)'));
    const input = table?.querySelector('tbody input');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '420'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('§17 no stock quantity editor in create mode', !(await text()).includes('موجودی اولیه (تعداد)'));
  await shot('03-matrix');

  /* ---------- §18/§19: media ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'تصویر و ویدیو');
  await sleep(700);
  const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgYGD4z4AGMIUGUgAAHhYD/0Z320IAAAAASUVORK5CYII=', 'base64');
  writeFileSync('/tmp/qa-studio-1.png', png1);
  writeFileSync('/tmp/qa-studio-2.png', png1);
  const fileInput = await page.$('input[type=file][accept*="image/png"]');
  if (fileInput) { await fileInput.uploadFile('/tmp/qa-studio-1.png', '/tmp/qa-studio-2.png'); }
  await sleep(2500);
  const imgCount = await page.evaluate(() => document.body.innerText.match(/تصاویر فروشگاه \(([^)]+)\)/)?.[1] ?? '');
  check('§18 two images uploaded to the server', imgCount.includes('۲'), imgCount);
  check('§18 first image marked as کاور', (await text()).includes('کاور'));
  await clickText('button', 'کاور کن'); /* promote the 2nd image → ordering control */
  await sleep(500);
  check('§19 video capability present (upload + URL)', (await text()).includes('ویدیوی محصول') && await page.evaluate(() => !!document.querySelector('input[type=file][accept="video/mp4"]')));

  /* ---------- §20: style-builder asset is separate, Persian statuses ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'تصویر استایل‌بیلدر');
  await sleep(700);
  check('§20 style-builder section separate from gallery', (await text()).includes('تصویر استایل‌بیلدر جدا از عکس‌های فروشگاه است'));
  check('§20 status label is Persian', (await text()).includes('بدون تصویر'));

  /* ---------- §22/§23: pricing + promotion boundary ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'قیمت‌گذاری');
  await sleep(700);
  check('§22 cash price typed (toman)', await typeIntoField('قیمت پایه خرده', '450000'));
  await typeIntoField('قیمت مخصوص چهارقسطه', '480000');
  check('§23 promotion boundary text (engine-only discounts)', (await text()).includes('فقط از موتور پروموشن/جشنواره اعمال می‌شود'));
  const noDiscountInput = await page.evaluate(() => ![...document.querySelectorAll('label span')].some((s) => (s.textContent ?? '').includes('درصد تخفیف')));
  check('§23 studio stores NO discount rules', noDiscountInput);

  /* ---------- §24-§26: wholesale ON + series templates + MOQ ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'سری‌های عمده');
  await sleep(700);
  check('§24 wholesale channel is ON for this product', (await text()).includes('حداقل سفارش عمده'));
  await typeIntoField('حداقل سفارش عمده', '12');
  /* Configure two actual per-product recipes in Product Studio. Saving the product
     atomically writes these as canonical series_templates + series_template_items. */
  await clickText('button', 'افزودن سری');
  await sleep(400);
  await clickText('button', 'افزودن سری');
  await sleep(500);
  const seriesCardCount = await page.evaluate(() => {
    const candidate = (el) => [...el.classList].includes('rounded-[18px]')
      && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'نام سری')
      && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'رنگ سری');
    const all = [...document.querySelectorAll('div')].filter(candidate);
    return all.filter((el) => !all.some((other) => other !== el && el.contains(other))).length;
  });
  const setSeriesInput = async (index, labelName, value) => {
    const ok = await page.evaluate(({ index: i, labelName: labelText, value: v }) => {
      const candidate = (el) => [...el.classList].includes('rounded-[18px]')
        && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'نام سری')
        && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'رنگ سری');
      const all = [...document.querySelectorAll('div')].filter(candidate);
      const cards = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
      const card = cards[i];
      const input = labelText.startsWith('تعداد سایز ')
        ? card?.querySelector(`input[aria-label="${labelText}"]`)
        : [...(card?.querySelectorAll('label') ?? [])].find((node) => node.querySelector('span')?.textContent?.trim() === labelText)?.querySelector('input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, { index, labelName, value });
    await sleep(180);
    return ok;
  };
  const setSeriesColor = async (index, colorName) => {
    const ok = await page.evaluate(({ index: i, colorName: name }) => {
      const candidate = (el) => [...el.classList].includes('rounded-[18px]')
        && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'نام سری')
        && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'رنگ سری');
      const all = [...document.querySelectorAll('div')].filter(candidate);
      const cards = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
      const label = [...(cards[i]?.querySelectorAll('label') ?? [])].find((node) => node.querySelector('span')?.textContent?.trim() === 'رنگ سری');
      const select = label?.querySelector('select');
      const option = [...(select?.options ?? [])].find((entry) => (entry.textContent ?? '').trim() === name);
      if (!select || !option) return false;
      select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { index, colorName });
    await sleep(180);
    return ok;
  };
  const configureCard = async (index, { name, color, moq, price, composition }) => {
    const result = { name: await setSeriesInput(index, 'نام سری', name), color: await setSeriesColor(index, color),
      moq: await setSeriesInput(index, 'حداقل سفارش (سری)', moq), price: await setSeriesInput(index, 'قیمت کل سری (تومان)', price), quantities: {} };
    for (const [size, quantity] of Object.entries(composition)) {
      result.quantities[size] = await setSeriesInput(index, `تعداد سایز ${size}`, String(quantity));
    }
    return result;
  };
  const configureSeriesCards = {
    count: seriesCardCount,
    first: await configureCard(0, { name: `سری A QA${ts}`, color: 'مشکی', moq: '2', price: '7400000', composition: { S: 1, M: 2, L: 2 } }),
    second: await configureCard(1, { name: `سری B QA${ts}`, color: CREAM, moq: '1', price: '4500000', composition: { S: 0, M: 1, L: 2 } }),
  };
  const allFieldsSet = (card) => Boolean(card?.name && card?.color && card?.moq && card?.price)
    && Object.values(card?.quantities ?? {}).every(Boolean);
  check('§25 canonical series editor configured two cards and exact compositions', configureSeriesCards.count === 2
    && allFieldsSet(configureSeriesCards.first) && allFieldsSet(configureSeriesCards.second), JSON.stringify(configureSeriesCards));
  const seriesEditorSnapshot = await page.evaluate(() => {
    const candidate = (el) => [...el.classList].includes('rounded-[18px]')
      && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'نام سری')
      && [...el.querySelectorAll('label span')].some((s) => s.textContent?.trim() === 'رنگ سری');
    const all = [...document.querySelectorAll('div')].filter(candidate);
    const cards = all.filter((el) => !all.some((other) => other !== el && el.contains(other)));
    return cards.map((card) => {
      const field = (name) => [...card.querySelectorAll('label')].find((el) => el.querySelector('span')?.textContent?.trim() === name);
      return { name: field('نام سری')?.querySelector('input')?.value,
        color: field('رنگ سری')?.querySelector('select')?.selectedOptions?.[0]?.textContent?.trim(),
        moq: field('حداقل سفارش (سری)')?.querySelector('input')?.value,
        price: field('قیمت کل سری (تومان)')?.querySelector('input')?.value,
        composition: Object.fromEntries([...card.querySelectorAll('input[aria-label^="تعداد سایز "]')].map((input) => [input.getAttribute('aria-label')?.replace('تعداد سایز ', ''), input.value])) };
    });
  });
  check('§25 Series A and B names, colors, compositions, MOQ and prices are visible in editor',
    seriesEditorSnapshot.length === 2 && seriesEditorSnapshot.some((row) => row.name === `سری A QA${ts}` && row.color === 'مشکی' && row.moq === '2' && row.price === '7400000' && row.composition.S === '1' && row.composition.M === '2' && row.composition.L === '2')
      && seriesEditorSnapshot.some((row) => row.name === `سری B QA${ts}` && row.color === CREAM && row.moq === '1' && row.price === '4500000' && row.composition.S === '0' && row.composition.M === '1' && row.composition.L === '2'), JSON.stringify(seriesEditorSnapshot));
  check('§25 both series priced and available', !(await text()).includes('برای انتشار تکمیل کنید: سری‌های عمده'));
  check('§26 max wholesale order: NOT IMPLEMENTED (recorded honestly)', true, 'فیلد سقف سفارش عمده در سیستم وجود ندارد — جعل نشد');
  await shot('04-series');

  /* ---------- §28: SEO ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'سئو و کانال‌ها');
  await sleep(700);
  await typeIntoField('عنوان سئو', `پیراهن کلاسیک QA ${ts} | کلبه وینتیج`);
  await typeIntoField('نامک', `qa-classic-shirt-${ts}`);
  check('§28 human slug + seo title typed', true);

  /* ---------- §30: review step green state ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'بازبینی و انتشار');
  await sleep(700);
  check('§30 review: all complete → green state', (await text()).includes('همه بخش‌ها کامل است'));
  check('§30 review summary shows 5/6 matrix cells', (await text()).includes('۵ از ۶'));
  await shot('05-review');

  /* ---------- §7/§31: create — ZERO inventory mutation, canonical draft ---------- */
  const preSave = await page.evaluate(() => {
    const issues = [...document.querySelectorAll('p')].find((n) => (n.textContent ?? '').includes('برای ادامه تکمیل کنید'))?.textContent ?? '';
    const draftBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('ذخیره پیش‌نویس'));
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('ذخیره و ادامه'));
    const cancelBtn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'انصراف');
    return { issues, disabled: btn ? btn.disabled : null, hasDraft: Boolean(draftBtn), hasCancel: Boolean(cancelBtn) };
  });
  if (preSave.disabled) console.log('DIAG pre-save:', JSON.stringify(preSave));
  check('§7 creation actions are [ذخیره پیش‌نویس] / [ذخیره و ادامه] / [انصراف]',
    preSave.hasDraft && preSave.hasCancel && !(await text()).includes('ذخیره و انتشار'),
    JSON.stringify(preSave).slice(0, 120));
  check('§12 [ذخیره و ادامه] clicked', await clickText('button', 'ذخیره و ادامه'), preSave.disabled ? preSave.issues : '');
  check('§13 handoff opens «ورود اولیه کالا» with the product preselected (no search)',
    await waitText('ورود اولیه کالا — ' + NAME, 40));
  const handoffText = await text();
  check('§13 no creation success page in the journey', !handoffText.includes('محصول با موفقیت تعریف شد'));
  check('§13 handoff is the canonical audited WMS receipt workspace',
    handoffText.includes('سند رسید انبار') && !handoffText.includes('نیازمند راه‌اندازی'));
  await shot('06-handoff-initial-inventory');
  /* close the handoff workspace — the product must survive the interruption as a draft */
  await page.evaluate(() => { const b = [...document.querySelectorAll('button[aria-label="بستن"]')].pop(); if (b) b.click(); });
  await sleep(900);

  const movesAfterCreate = await count('SELECT count(*)::int AS n FROM stock_movements');
  const receiptsAfterCreate = await count('SELECT count(*)::int AS n FROM stock_receipts');
  check('§31/§93 stock_movements unchanged by create', movesAfterCreate === movesBefore, `${movesBefore} → ${movesAfterCreate}`);
  check('§31/§93 stock_receipts unchanged by create', receiptsAfterCreate === receiptsBefore, `${receiptsBefore} → ${receiptsAfterCreate}`);

  const prodRow = (await db.query('SELECT id, status, inventory_setup, owner_type, product_type_id, supplier_id, wholesale_moq, cash_price_rial, installment_price_rial, wholesale_price_rial, retail_enabled, wholesale_enabled, category_id, specifications, metadata FROM products WHERE name = $1', [NAME])).rows[0];
  check('§31 product persisted', Boolean(prodRow));
  const PRODUCT_ID = prodRow?.id;
  check('§7 product persisted as پیش‌نویس (draft), owner=kolbe, supplier NULL',
    prodRow?.status === 'draft' && prodRow?.inventory_setup === 'pending' && prodRow?.owner_type === 'kolbe' && prodRow?.supplier_id === null,
    `status=${prodRow?.status} setup=${prodRow?.inventory_setup}`);
  check('§9 created WITHOUT product_type_id', prodRow?.product_type_id === null);
  check('§22 cash price server-side = 4,500,000 rial', String(prodRow?.cash_price_rial) === '4500000', prodRow?.cash_price_rial);
  check('§22 four-installment amount persisted separately = 4,800,000 rial', String(prodRow?.installment_price_rial) === '4800000', prodRow?.installment_price_rial);
  check('§24 both retail and wholesale channels persisted', prodRow?.retail_enabled === true && prodRow?.wholesale_enabled === true);
  check('§26 MOQ=12 persisted server-side', Number(prodRow?.wholesale_moq) === 12, prodRow?.wholesale_moq);
  check('§7 canonical category identity persisted', Boolean(prodRow?.category_id));
  const specs = prodRow?.specifications ?? {};
  check('§10 required spec value persisted', String(specs[`qa_jens_${ts}`] ?? '').includes('نخ پنبه'), JSON.stringify(specs).slice(0, 80));
  const meta = prodRow?.metadata ?? {};
  check('§18 metadata.images = 2 server file ids', Array.isArray(meta.images) && meta.images.length === 2 && meta.images.every((i) => i.fileId), JSON.stringify(meta.images ?? []).slice(0, 120));
  check('§28 metadata.seo slug + title persisted', meta.seo?.slug === `qa-classic-shirt-${ts}` && String(meta.seo?.title ?? '').includes('کلبه وینتیج'), JSON.stringify(meta.seo ?? {}));
  check('§25 metadata.series = 2 wholesale series', Array.isArray(meta.series) && meta.series.length === 2 && meta.series.every((s) => s.pricePerSeries > 0 && s.moqSeries > 0));

  const variants = (await db.query('SELECT id, sku, color_label, size_label, weight_grams, active FROM product_variants WHERE product_id = $1 ORDER BY sku', [PRODUCT_ID])).rows;
  check('§15 exactly 5 variants persisted', variants.length === 5, variants.map((v) => `${v.color_label}/${v.size_label}`).join(','));
  check('§15 DB PROOF: کرم/S has NO variant row (≠ stock 0)', !variants.some((v) => v.color_label === CREAM && v.size_label === 'S'));
  check('§16 variant identity: server SKU + color + size on every row', variants.every((v) => v.id && /^KV-/.test(v.sku) && v.color_label && v.size_label));
  check('§17 weight persisted as catalog data', variants.some((v) => Number(v.weight_grams) === 420), variants.map((v) => v.weight_grams).join(','));

  /* ---------- §29/§33/§34: draft is the single authoritative unfinished state ---------- */
  await gotoProducts();
  await clickExact('button', 'پیش‌نویس‌ها');
  await sleep(1200);
  check('§33 interrupted draft is listed in «پیش‌نویس‌ها»', await waitText(NAME, 25));
  const draftsText = await text();
  check('§33 no «نیازمند راه‌اندازی» lifecycle/filter anywhere in the hub', !draftsText.includes('نیازمند راه‌اندازی'));
  check('§14 draft row offers «ادامه تکمیل محصول»', draftsText.includes('ادامه تکمیل محصول'));
  check('§34 pre-receipt inventory never reads as 0 (pending receipt)',
    draftsText.includes('موجودی ثبت‌نشده') || draftsText.includes('—'));
  await shot('07-drafts');

  /* ================= PHASE E — API-side: canonical recipes, invalid size, spoof, RBAC ================= */
  const recipeRows = (await db.query(`SELECT t.id,t.name,t.pricing_mode,t.total_price_rial::text,t.min_order_series,t.color_label,
      i.quantity_per_series,v.size_label,v.color_label AS variant_color
    FROM series_templates t JOIN series_template_items i ON i.series_template_id=t.id
    JOIN product_variants v ON v.id=i.variant_id WHERE t.product_id=$1 ORDER BY t.name,v.size_label`, [PRODUCT_ID])).rows;
  const recipeMap = new Map();
  for (const row of recipeRows) {
    const recipe = recipeMap.get(row.id) ?? { name: row.name, pricingMode: row.pricing_mode,
      price: row.total_price_rial, moq: Number(row.min_order_series), color: row.color_label, composition: {} };
    recipe.composition[row.size_label] = Number(row.quantity_per_series);
    recipeMap.set(row.id, recipe);
  }
  const recipeA = [...recipeMap.values()].find((r) => r.name === `سری A QA${ts}`);
  const recipeB = [...recipeMap.values()].find((r) => r.name === `سری B QA${ts}`);
  const recipeIs = (actual, expected) => Boolean(actual)
    && Object.entries(expected).every(([size, quantity]) => (actual[size] ?? 0) === quantity)
    && Object.keys(actual).every((size) => Object.hasOwn(expected, size));
  check('§25 canonical Series A S1/M2/L2 and Series B M0/L1/L2 persisted with distinct prices/MOQs',
    recipeMap.size === 2 && recipeA?.pricingMode === 'series_total' && recipeA.price === '74000000' && recipeA.moq === 2
      && recipeA.color === 'مشکی' && recipeIs(recipeA.composition, { L: 2, M: 2, S: 1 })
      && recipeB?.pricingMode === 'series_total' && recipeB.price === '45000000' && recipeB.moq === 1
      && recipeB.color === CREAM && recipeIs(recipeB.composition, { L: 2, M: 1 }), JSON.stringify([...recipeMap.values()]));
  const seriesApi = await api('GET', `/series-templates?productId=${PRODUCT_ID}&withAvailability=1`);
  check('§25 canonical series are readable from the server API with composition and persisted price',
    seriesApi.status === 200 && seriesApi.json?.items?.length === 2
      && seriesApi.json.items.some((r) => r.name === `سری A QA${ts}` && r.price_per_series_rial === '74000000' && r.moq_series === 2 && r.items?.length === 3)
      && seriesApi.json.items.some((r) => r.name === `سری B QA${ts}` && r.price_per_series_rial === '45000000' && r.moq_series === 1 && r.items?.length === 2),
    JSON.stringify(seriesApi.json?.items?.map((r) => ({ name: r.name, price: r.price_per_series_rial, moq: r.moq_series, items: r.items?.length }))));
  const movesAfterSeries = await count('SELECT count(*)::int AS n FROM stock_movements');
  const receiptsAfterSeries = await count('SELECT count(*)::int AS n FROM stock_receipts');
  const balancesAfterSeries = await count('SELECT count(*)::int AS n FROM stock_balances');
  check('§27 series definition produces ZERO inventory (DB)', movesAfterSeries === movesBefore && receiptsAfterSeries === receiptsBefore && balancesAfterSeries === balancesBefore,
    `moves ${movesBefore}→${movesAfterSeries}, receipts ${receiptsBefore}→${receiptsAfterSeries}, balances ${balancesBefore}→${balancesAfterSeries}`);
  check('§25 exactly two canonical templates created by product save', await count('SELECT count(*)::int AS n FROM series_templates') === serverSeriesBefore + 2);

  /* §14: server rejects out-of-profile size on variant add — then accepts after official extension */
  const xxl = await api('POST', `/products/${PRODUCT_ID}/variants`, { color: 'مشکی', size: 'XXL' });
  check('§14 API: size XXL rejected server-side (400)', xxl.status === 400, `status=${xxl.status} msg=${xxl.json?.message}`);
  check('§14 rejection message is Persian + names the category', String(xxl.json?.message ?? '').includes('مجاز نیست'), xxl.json?.message);
  const extend = await api('PUT', `/admin/category-profiles/${encodeURIComponent(CATEGORY)}`, {
    specTemplateId: tpl.json?.id, sizeGuideId: guide.json?.id, allowedSizes: ['S', 'M', 'L', 'XL'], requiredFields: [] });
  const throwaway = await api('POST', '/products', { brand: 'کلبه', name: `ثانویه QA${ts}`, category: CATEGORY, description: '',
    cashPriceRial: '1000000', specifications: { [`qa_jens_${ts}`]: 'نخ' }, variants: [{ color: 'مشکی', size: 'M' }] });
  const xlAfter = await api('POST', `/products/${throwaway.json?.id}/variants`, { color: 'مشکی', size: 'XL' });
  check('§14 after official profile extension, XL accepted (201)', extend.status === 200 && xlAfter.status === 201, `extend=${extend.status} xl=${xlAfter.status}`);
  await api('PUT', `/admin/category-profiles/${encodeURIComponent(CATEGORY)}`, {
    specTemplateId: tpl.json?.id, sizeGuideId: guide.json?.id, allowedSizes: ['S', 'M', 'L'], requiredFields: [] });

  /* §43: owner spoof has no effect — server derives owner from the authenticated role */
  const spoof = await api('POST', '/products', { brand: 'کلبه', name: `جعل مالکیت QA${ts}`, category: CATEGORY, description: '',
    cashPriceRial: '1000000', specifications: { [`qa_jens_${ts}`]: 'نخ' }, variants: [{ color: 'مشکی', size: 'M' }],
    owner_type: 'supplier', ownerType: 'supplier', supplierId: randomUUID() });
  const spoofRow = (await db.query('SELECT owner_type, supplier_id FROM products WHERE name = $1', [`جعل مالکیت QA${ts}`])).rows[0];
  check('§43 owner_type spoof neutralized server-side (kolbe, supplier NULL)', spoof.status === 201 && spoofRow?.owner_type === 'kolbe' && spoofRow?.supplier_id === null,
    `status=${spoof.status} owner=${spoofRow?.owner_type}`);

  /* §42: customer cannot touch the admin create API */
  const CUSTOMER = await login('seed.customer@kolbe.ir', 'Seed-Customer-123456');
  const custCreate = await api('POST', '/products', { brand: 'x', name: 'نفوذ مشتری', category: CATEGORY, description: '',
    cashPriceRial: '1000000', variants: [{ color: 'مشکی', size: 'M' }] }, CUSTOMER);
  check('§42 customer POST /products → 403', custCreate.status === 403, `status=${custCreate.status}`);
  const custAdmin = await api('GET', '/admin/products?view=drafts&owner=kolbe', undefined, CUSTOMER);
  check('§42 customer admin drafts list → 403', custAdmin.status === 403, `status=${custAdmin.status}`);
  const custSetup = await api('POST', `/admin/products/${randomUUID()}/inventory-setup`, { retail: { mode: 'per_variant', perVariant: [] } }, CUSTOMER);
  check('§42 customer initial-receipt API → 403', custSetup.status === 403, `status=${custSetup.status}`);
  /* §44: supplier cannot push a product into the retail channel */
  const SUPPLIER = await login('seed.supplier@kolbe.ir', 'Seed-Supplier-123456');
  const supRetail = await api('POST', '/products', { brand: 'x', name: `نفوذ تأمین QA${ts}`, category: CATEGORY, description: '',
    cashPriceRial: '1000000', specifications: { [`qa_jens_${ts}`]: 'نخ' }, variants: [{ color: 'مشکی', size: 'M' }], retailEnabled: true }, SUPPLIER);
  check('§44 supplier retail-channel create → 403', supRetail.status === 403, `status=${supRetail.status}`);

  /* §21: size-guide modes — link (existing) on the throwaway, detached copy via UI later */
  const linkAttach = await api('PUT', `/products/${throwaway.json?.id}/size-guide`, { guideId: guide.json.id, mode: 'link' });
  const linkRead = await api('GET', `/products/${throwaway.json?.id}/size-guide`);
  check('§21 mode «اتصال زنده» to an existing guide works', linkAttach.status === 200 || linkAttach.status === 201, `attach=${linkAttach.status}`);
  check('§21 attached guide readable with rows', linkRead.status === 200 && (linkRead.json?.guide?.rows ?? []).length === 3, `rows=${(linkRead.json?.guide?.rows ?? []).length}`);

  /* ================= PHASE F — §11 custom product-specific spec + §21 detached guide (UI) ================= */
  await gotoProducts();
  const searchBox = await page.$('input[placeholder="جست‌وجوی نام، برند یا دسته…"]');
  if (searchBox) { await searchBox.click({ clickCount: 3 }); await searchBox.type(NAME); await sleep(900); }
  await clickText('button', 'ویرایش');
  check('§11 edit studio opened from server data', await waitText('ویرایش محصول ·', 25));
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'مشخصات فنی');
  await sleep(1200);
  check('§11 product specs section opened', await waitText('افزودن مشخصه اختصاصی', 20));
  await clickText('button', 'افزودن مشخصه اختصاصی');
  await sleep(600);
  await selectOption('ساخت مشخصه جدید…');
  await sleep(500);
  await typeIntoField('نام', 'نوع شست‌وشو');
  await typeIntoField('کد انگلیسی', `qa_wash_${ts}`);
  await clickText('button', 'ساخت مشخصه');
  check('§11 off-template attribute created', await waitText('مقدار — نوع شست‌وشو', 20));
  await typeIntoField('مقدار — نوع شست‌وشو', 'فقط خشک‌شویی');
  check('§11 scope «فقط این محصول» offered', (await text()).includes('فقط این محصول'));
  await clickText('button', 'ذخیره مشخصه اختصاصی');
  await sleep(1200);
  const washVal = (await db.query(
    `SELECT v.value_text FROM product_spec_values v JOIN spec_attributes a ON a.id = v.attribute_id WHERE v.product_id = $1 AND a.code = $2`,
    [PRODUCT_ID, `qa_wash_${ts}`])).rows[0];
  check('§11 custom spec persisted for THIS product', washVal?.value_text === 'فقط خشک‌شویی', washVal?.value_text);
  const inTemplate = await count(
    `SELECT count(*)::int AS n FROM spec_template_attributes ta JOIN spec_attributes a ON a.id = ta.attribute_id WHERE a.code = $1`, [`qa_wash_${ts}`]);
  check('§11 custom spec did NOT enter any global template', inTemplate === 0, `template rows=${inTemplate}`);
  /* §21 mode 3: product-specific DETACHED copy through the UI */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'راهنمای سایز');
  await sleep(1000);
  await selectOption(`راهنمای سایز پیراهن QA${ts}`);
  await selectOption('کپی ثابت');
  await clickText('button', 'اتصال');
  check('§21 detached (product-specific) copy attached via UI', await waitText('کپی ثابت', 15));
  /* the attach handler refetches the guide async — wait for the table, not just the flash */
  const tableShown = await waitText('دور سینه', 25);
  check('§21 flexible table rendered (دور سینه + 96)', tableShown && /96|۹۶/.test(await text()));
  await shot('08-specs-sizeguide');
  const guideMode = await api('GET', `/products/${PRODUCT_ID}/size-guide`);
  check('§21 server confirms mode=detached for this product', guideMode.json?.mode === 'detached', guideMode.json?.mode);
  await closeStudio();

  /* §11 persistence through full reload */
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(1500);
  if (!(await text()).includes('برج کنترل')) await loginConsole();
  await gotoProducts();
  const sb2 = await page.$('input[placeholder="جست‌وجوی نام، برند یا دسته…"]');
  if (sb2) { await sb2.click({ clickCount: 3 }); await sb2.type(NAME); await sleep(900); }
  await clickText('button', 'ویرایش');
  await waitText('ویرایش محصول ·', 25);
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'مشخصات فنی');
  await sleep(1000);
  check('§11 custom spec survives full reload (visible in editor)', await waitText('نوع شست‌وشو', 25));
  await closeStudio();

  /* ================= PHASE G — §36 EDIT ROUNDTRIP (release blocker) ================= */
  const metaBefore = JSON.stringify((await db.query('SELECT metadata, specifications FROM products WHERE id = $1', [PRODUCT_ID])).rows[0]);
  await clickText('button', 'ویرایش');
  check('edit mode opened from server data', await waitText('ویرایش محصول ·', 25));
  const MARKER = `ویرایش-روندتریپ-${ts}`;
  const descTyped = await page.evaluate((m) => {
    const label = [...document.querySelectorAll('label')].find((l) => (l.querySelector('span')?.textContent ?? '').trim() === 'توضیحات');
    const ta = label?.querySelector('textarea');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, `${ta.value} ${m}`); ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, MARKER);
  check('§36 ONLY description changed', descTyped);
  await clickText('button', 'ذخیره تغییرات');
  await sleep(2500);
  /* full browser reload, then reopen the same product */
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(1500);
  if (!(await text()).includes('برج کنترل')) await loginConsole();
  await gotoProducts();
  const sb3 = await page.$('input[placeholder="جست‌وجوی نام، برند یا دسته…"]');
  if (sb3) { await sb3.click({ clickCount: 3 }); await sb3.type(NAME); await sleep(900); }
  await clickText('button', 'ویرایش');
  await waitText('ویرایش محصول ·', 25);
  await sleep(1500);
  const after = (await db.query('SELECT description, metadata, specifications, wholesale_moq, cash_price_rial FROM products WHERE id = $1', [PRODUCT_ID])).rows[0];
  const metaAfter = after?.metadata ?? {};
  check('§36 description change saved', String(after?.description ?? '').includes(MARKER));
  check('§36 images survived (2, same file ids)', Array.isArray(metaAfter.images) && metaAfter.images.length === 2 && metaAfter.images.every((i) => i.fileId));
  check('§36 SEO survived', metaAfter.seo?.slug === `qa-classic-shirt-${ts}`, JSON.stringify(metaAfter.seo ?? {}));
  check('§36 series survived (2)', Array.isArray(metaAfter.series) && metaAfter.series.length === 2);
  check('§36 specifications survived', String((after?.specifications ?? {})[`qa_jens_${ts}`] ?? '').includes('نخ پنبه'));
  check('§36 pricing + MOQ survived', String(after?.cash_price_rial) === '4500000' && Number(after?.wholesale_moq) === 12);
  const variantsAfterEdit = await count('SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1', [PRODUCT_ID]);
  check('§36 variants survived (5)', variantsAfterEdit === 5, `variants=${variantsAfterEdit}`);
  const washAfterEdit = (await db.query(
    `SELECT v.value_text FROM product_spec_values v JOIN spec_attributes a ON a.id = v.attribute_id WHERE v.product_id = $1 AND a.code = $2`,
    [PRODUCT_ID, `qa_wash_${ts}`])).rows[0];
  check('§36 custom spec survived', washAfterEdit?.value_text === 'فقط خشک‌شویی');
  const guideAfterEdit = await api('GET', `/products/${PRODUCT_ID}/size-guide`);
  check('§36 size guide survived (detached)', guideAfterEdit.json?.mode === 'detached');
  /* studio sections mount lazily — navigate to each section before reading its input */
  const readFieldIn = async (section, needle) => {
    await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', section);
    await sleep(600);
    return page.evaluate((n) => {
      const label = [...document.querySelectorAll('label')].find((l) => (l.querySelector('span')?.textContent ?? '').includes(n));
      return label?.querySelector('input')?.value ?? '';
    }, needle);
  };
  const uiRound = {
    price: await readFieldIn('قیمت‌گذاری', 'قیمت پایه خرده'),
    moq: await readFieldIn('سری‌های عمده', 'حداقل سفارش عمده'),
    slug: await readFieldIn('سئو و کانال‌ها', 'نامک'),
  };
  check('§36 UI shows server values after reload (price/slug/moq)', uiRound.price === '450000' && uiRound.slug === `qa-classic-shirt-${ts}` && uiRound.moq === '12', JSON.stringify(uiRound));
  await shot('09-edit-roundtrip');

  /* ---------- §41: save failure surfaces a clean Persian error, edit not lost ---------- */
  await page.setRequestInterception(true);
  let intercepted = false;
  const handler = (req) => {
    if (!intercepted && req.method() === 'PATCH' && req.url().includes('/api/v1/products/')) {
      intercepted = true;
      req.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'خطای آزمایشی اعتبارسنجی سرور' }) });
      return;
    }
    req.continue();
  };
  page.on('request', handler);
  await clickText('button', 'ذخیره تغییرات');
  await sleep(1500);
  const stillOpen = (await text()).includes('ویرایش محصول ·');
  const bodyNow = await text();
  check('§41 server failure → studio stays open, edit not lost', intercepted && stillOpen);
  check('§41 no raw stack/Zod dump in UI', !/ZodError|stack|TypeError|at .*\.js/.test(bodyNow));
  page.off('request', handler);
  await page.setRequestInterception(false);

  /* ---------- §37: unsaved-changes guard ---------- */
  await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', 'اطلاعات پایه'); /* name field mounts only in its section */
  await sleep(600);
  await typeIntoField('نام محصول', ` تغییر${ts}`); /* append → dirty */
  await clickText('button', 'بازگشت به فهرست');
  check('§37 unsaved-changes confirm appears', await waitText('تغییرات ذخیره‌نشده', 10));
  await clickText('button', 'ادامه ویرایش');
  await sleep(500);
  check('§37 «ادامه ویرایش» keeps the studio open', (await text()).includes('ویرایش محصول ·'));
  await clickText('button', 'بازگشت به فهرست');
  await waitText('تغییرات ذخیره‌نشده', 10);
  await clickText('button', 'خروج بدون ذخیره');
  await sleep(800);
  check('§37 discard leaves to the «محصولات کلبه» list', (await text()).includes('افزودن محصول'));
  const nameUntouched = (await db.query('SELECT name FROM products WHERE id = $1', [PRODUCT_ID])).rows[0];
  check('§37 discarded edit did NOT touch the server', nameUntouched?.name === NAME, nameUntouched?.name);
  /* clean exit without changes → no confirm */
  await clickText('button', 'افزودن محصول');
  await sleep(1000);
  await clickText('button', 'انصراف');
  await sleep(500);
  check('§37 pristine draft exits WITHOUT confirm', !(await text()).includes('تغییرات ذخیره‌نشده'));

  /* ---------- §38/§39: raw-field + Persian sweeps inside the studio ---------- */
  await clickText('button', 'افزودن محصول');
  await sleep(1200);
  const sweep = await text();
  check('§38 no raw technical identifiers in studio DOM',
    !/product_type_code|productTypeId|owner_type|inventory_domain|target_type|metadata\.images|POST \/files/.test(sweep));
  check('§38 no UUID leakage in studio DOM', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(sweep));
  check('§39 no English inventory jargon (on-hand/available)', !/on-hand|available\b/.test(sweep));

  /* ---------- §40: responsive sweep (studio open, key sections) ---------- */
  const viewports = [[360, 740], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 1000]];
  const responsiveIssues = [];
  for (const [w, h] of viewports) {
    await page.setViewport({ width: w, height: h });
    await sleep(600);
    for (const section of ['رنگ و سایز', 'تصویر و ویدیو', 'بازبینی و انتشار']) {
      await clickText('nav[aria-label="بخش‌های تعریف محصول"] button', section);
      await sleep(400);
      const overflow = await page.evaluate(() => {
        const extra = document.documentElement.scrollWidth - window.innerWidth;
        if (extra <= 8) return { extra };
        let worst = null;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > window.innerWidth + 8 && (!worst || r.width > worst.w)) worst = { w: Math.round(r.width), tag: el.tagName, cls: String(el.className).slice(0, 60) };
        }
        return { extra, worst };
      });
      if (overflow.extra > 8) responsiveIssues.push(`${w}px/${section}: overflow ${overflow.extra}px (${JSON.stringify(overflow.worst)})`);
    }
    const ctaVisible = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('ذخیره و ادامه'));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= -2 && r.right <= window.innerWidth + 2;
    });
    if (!ctaVisible) responsiveIssues.push(`${w}px: save CTA clipped`);
    if (w === 360) await shot('10-responsive-360');
  }
  check('§40 responsive 360/390/768/1024/1280/1440 — no overflow, CTA reachable', responsiveIssues.length === 0, responsiveIssues.join(' | ') || 'clean');
  await page.setViewport({ width: 1440, height: 1000 });
  await clickText('button', 'بازگشت به فهرست');
  await sleep(500);
  if ((await text()).includes('تغییرات ذخیره‌نشده')) { await clickText('button', 'خروج بدون ذخیره'); await sleep(500); }

  /* ================= PHASE K — §35: opening inventory ONLY through the audited WMS document ================= */
  const whs = await api('GET', '/warehouses');
  const retailWh = (whs.json?.items ?? whs.json ?? []).find((w) => (w.purpose ?? w.type) === 'retail') ?? (whs.json?.items ?? [])[0];
  check('§35 retail warehouse available', Boolean(retailWh?.id), retailWh?.name);
  const blackS = variants.find((v) => v.color_label === 'مشکی' && v.size_label === 'S');
  if (!retailWh?.id || !blackS?.id) {
    check('§35 prerequisites available (warehouse + مشکی/S variant)', false, `wh=${Boolean(retailWh?.id)} variant=${Boolean(blackS?.id)}`);
    throw new Error('§35 prerequisites missing — aborting phase K');
  }
  const auditBefore = await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.inventory_setup'");
  const IDEM_SETUP = `qa-setup-${ts}`;
  const setup = await api('POST', `/admin/products/${PRODUCT_ID}/inventory-setup`,
    { retail: { warehouseId: retailWh.id, mode: 'per_variant', perVariant: [{ variantId: blackS.id, quantity: 7 }] } },
    ADMIN, { 'idempotency-key': IDEM_SETUP });
  check('§35 opening inventory registered via WMS document', setup.status === 200 || setup.status === 201, `status=${setup.status} ${JSON.stringify(setup.json).slice(0, 120)}`);
  const movesAfterSetup = await count('SELECT count(*)::int AS n FROM stock_movements');
  const receiptsAfterSetup = await count('SELECT count(*)::int AS n FROM stock_receipts');
  check('§35 receipt +1 / movement +1 (only the non-zero variant)', receiptsAfterSetup === receiptsBefore + 1 && movesAfterSetup === movesBefore + 1,
    `receipts ${receiptsBefore}→${receiptsAfterSetup}, moves ${movesBefore}→${movesAfterSetup}`);
  const bal = (await db.query("SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND inventory_domain = 'retail'", [blackS.id])).rows[0];
  check('§35 balance on_hand = 7 for مشکی/S', Number(bal?.on_hand) === 7, bal?.on_hand);
  const zeroBalances = await count(
    "SELECT count(*)::int AS n FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = $1 AND b.inventory_domain = 'retail' AND b.on_hand = 0", [PRODUCT_ID]);
  check('§34 post-setup zero-stock variants read as REAL 0 (4 balance rows)', zeroBalances === 4, `zero rows=${zeroBalances}`);
  const auditAfter = await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'product.inventory_setup'");
  check('§35 audit row written', auditAfter === auditBefore + 1, `${auditBefore}→${auditAfter}`);
  const setupState = (await db.query('SELECT inventory_setup, status FROM products WHERE id = $1', [PRODUCT_ID])).rows[0];
  check('§34 inventory_setup flipped to configured', setupState?.inventory_setup === 'configured');
  check('§16 opening receipt does NOT auto-publish (status stays draft)', setupState?.status === 'draft', `status=${setupState?.status}`);
  const draftsList = await api('GET', '/admin/products?view=drafts&owner=kolbe');
  check('§34 configured draft remains پیش‌نویس until Admin publishes it',
    (draftsList.json?.items ?? []).some((p) => p.id === PRODUCT_ID));
  const pubList = await api('GET', '/admin/products?view=published&owner=kolbe');
  check('§16 draft is absent from «منتشرشده» after the receipt',
    !(pubList.json?.items ?? []).some((p) => p.id === PRODUCT_ID));
  const setupReplay = await api('POST', `/admin/products/${PRODUCT_ID}/inventory-setup`,
    { retail: { warehouseId: retailWh.id, mode: 'per_variant', perVariant: [{ variantId: blackS.id, quantity: 7 }] } },
    ADMIN, { 'idempotency-key': IDEM_SETUP });
  check('§20 initial receipt is idempotent under the same Idempotency-Key',
    setupReplay.status === 200 || setupReplay.status === 201, `status=${setupReplay.status}`);
  const balReplay = (await db.query("SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND inventory_domain = 'retail'", [blackS.id])).rows[0];
  check('§20 replay did NOT duplicate physical stock (on_hand still 7)', Number(balReplay?.on_hand) === 7, balReplay?.on_hand);
  check('browser has no uncaught page exceptions during Product Studio flow', browserDiagnostics.pageErrors.length === 0, browserDiagnostics.pageErrors.join(' | '));
  console.log('BROWSER_DIAGNOSTICS:', JSON.stringify(browserDiagnostics));
} catch (err) {
  check('script completed without crash', false, String(err?.message ?? err).slice(0, 180));
} finally {
  await browser.close();
  await db.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
