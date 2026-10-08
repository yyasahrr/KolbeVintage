/**
 * Homepage CMS integration E2E — the storefront side of docs/cms-functional-audit.md §5.
 *
 * Real backend, real HTTP, real DOM:
 *   1. embedded PostgreSQL (PGlite) + migrations,
 *   2. the canonical development seed (npm run seed:local) — real published
 *      products with WMS stock, CMS bootstrap, a live announcement,
 *   3. Fastify LISTENING on 127.0.0.1 (the same buildApp the production server uses),
 *   4. admin edits the `home` draft through the public HTTP API and publishes v1,
 *   5. the REAL storefront bundle (vite build of <App/>, non-demo) boots in JSDOM
 *      with its fetch bridged to the running server and must render the published
 *      composition: hero payload, section order, hidden sections absent, added
 *      sections present, no legacy double render, no demo badge,
 *   6. a second publication (v2) must survive a full reload (fresh JSDOM boot),
 *   7. a ?demo boot must stay on the accepted seeded composition, prominently
 *      labeled, with NO published-CMS content leaking in.
 *
 * Run: cd backend && node --import tsx scripts/cms-home-e2e.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { JSDOM, VirtualConsole } from 'jsdom';

const fileUrl = (p) => 'file://' + path.resolve(p).replace(/\\/g, '/');
const repoRoot = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const bundlePath = path.join(repoRoot, '.smoke', 'out', 'cms-home-app.js');
if (!fs.existsSync(bundlePath)) {
  console.error(`missing ${bundlePath} — build it first: SMOKE_NAME=cms-home-app SMOKE_ENTRY=.smoke/cms-home-entry.tsx node .smoke/build.mjs`);
  process.exit(2);
}

const PORT = Number(process.env.E2E_PORT ?? 41990);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, fn) => {
  try {
    const note = fn();
    if (note === true || note === undefined) { results.push({ name, ok: true }); console.log(`PASS  ${name}`); }
    else { results.push({ name, ok: false, note: String(note) }); console.log(`FAIL  ${name} — ${note}`); }
  } catch (error) {
    results.push({ name, ok: false, note: String(error?.message ?? error) });
    console.log(`FAIL  ${name} — ${error?.message ?? error}`);
  }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const faDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

/* ------------------------- 1–2: database + seed --------------------------- */
console.log('· starting embedded PostgreSQL…');
const db = await PGlite.create();
const pgServer = new PGLiteSocketServer({ db, port: 55441, host: '127.0.0.1', maxConnections: 20 });
await pgServer.start();
const dbUrl = 'postgres://127.0.0.1:55441/pglite';
const baseEnv = {
  ...process.env, NODE_ENV: 'development', DATABASE_URL: dbUrl,
  JWT_SECRET: 'cms-home-e2e-secret-at-least-thirty-two-chars',
  PUBLIC_ORIGIN: BASE, PG_POOL_MAX: '4', COOKIE_SECURE: 'false',
};
const run = (args, env = baseEnv) => new Promise((resolve, reject) => {
  const child = spawn('npm', args, { env, stdio: 'inherit', shell: process.platform === 'win32', cwd: path.resolve(new URL(import.meta.url).pathname, '..') });
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited ${code}`)));
  child.on('error', reject);
});
await run(['run', '--silent', 'migrate']);
console.log('· creating the environment administrator…');
await run(['run', '--silent', 'bootstrap:admin'], { ...baseEnv, BOOTSTRAP_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL ?? 'admin@kolbe.ir', BOOTSTRAP_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-123456' });
console.log('· seeding the canonical development dataset (real products, stock, CMS)…');
await run(['run', '--silent', 'seed:local']);

/* --------------------------- 3: HTTP server ------------------------------- */
process.env.NODE_ENV = 'development';
const { buildApp } = await import('../src/app.js');
const { createPool } = await import('../src/db.js');
const config = { NODE_ENV: 'development', PORT, DATABASE_URL: dbUrl, JWT_SECRET: baseEnv.JWT_SECRET, PG_POOL_MAX: 4, PUBLIC_ORIGIN: BASE, COOKIE_SECURE: 'false' };
const app = await buildApp(config);
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`· backend listening on ${BASE}`);

const api = async (route, { method = 'GET', token, payload } = {}) => {
  const response = await fetch(`${BASE}/api/v1${route}`, {
    method,
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
};
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@kolbe.ir';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe-Admin-123456';
const login = await api('/auth/login', { method: 'POST', payload: { identity: adminEmail, password: adminPassword } });
if (login.status !== 200) { console.error(`admin login failed: ${login.status}`); process.exit(2); }
const token = login.body.accessToken;
const pages = await api('/admin/cms/pages', { token });
const homePage = (pages.body?.items ?? []).find((page) => page.code === 'home');
if (!homePage) { console.error('no home page after seed'); process.exit(2); }
const draftOf = async () => (await api(`/admin/cms/pages/${homePage.id}/draft`, { token })).body;
const strip = (sections) => sections.map(({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config }) =>
  ({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config }));
const saveDraft = async (draft) => {
  const saved = await api(`/admin/cms/pages/${homePage.id}/draft`, { method: 'PUT', token, payload: {
    expectedRevision: draft.draft_revision, title: draft.title, path: draft.path, description: draft.description, sections: strip(draft.sections) } });
  if (saved.status !== 200) throw new Error(`draft save failed ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
  return saved.body;
};
const publish = async (revision, summary) => {
  const published = await api(`/admin/cms/pages/${homePage.id}/publish`, { method: 'POST', token, payload: { expectedRevision: revision, changeSummary: summary } });
  if (published.status !== 200) throw new Error(`publish failed ${published.status}: ${JSON.stringify(published.body).slice(0, 300)}`);
  return published.body;
};

/* publish v1: retitle hero + grid, hide the newsletter, insert a text section */
const catalog = (await api('/products?limit=100')).body;
const catalogIds = (catalog?.items ?? []).filter((p) => (p.variants ?? []).some((v) => v.retailAvailableStock > 0)).map((p) => p.id);
if (catalogIds.length < 4) { console.error(`catalog too small for the E2E: ${catalogIds.length} products`); process.exit(2); }
const draft1 = await draftOf();
const byCode = (code) => draft1.sections.find((s) => s.component_code === code);
byCode('hero').payload = { ...byCode('hero').payload, title: 'پرده اول کلبه', eyebrow: 'کالکشن پاییز' };
byCode('product_grid').payload = { ...byCode('product_grid').payload, title: 'تازه‌های این هفته', productIds: catalogIds.slice(0, 4), limit: 4 };
byCode('product_slider').payload = { ...byCode('product_slider').payload, title: 'منتخب کلبه', productIds: catalogIds.slice(4, 8), limit: 4 };
byCode('newsletter').visible = false;
draft1.sections.splice(3, 0, { id: randomUUID(), component_code: 'text_section', title: 'ویراستاری کلبه',
  payload: { title: 'ویراستاری کلبه', text: 'پارچه، دوخت و ماندگاری؛ سه کلمه‌ای که همه چیز را می‌سازند.' },
  visible: true, position: 0, variant: 'centered', section_theme: 'campaign',
  style_overrides: { background: 'surfaceSecondary', padding: 'lg', width: 'narrow', radius: 'lg' },
  responsive_config: { hideOnMobile: false, hideOnTablet: false, hideOnDesktop: false } });
const saved1 = await saveDraft(draft1);
const pub1 = await publish(saved1.draft_revision, 'E2E انتشار نسخه اول');
const live1 = (await api('/site/pages/home')).body;
const liveCodes = live1.sections.map((s) => s.component_code);

/* ------------------------- 5: storefront DOM ------------------------------ */
const bootStorefront = async ({ demo = false } = {}) => {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => errors.push(String(error.message ?? error)));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM('<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
    { url: `${BASE}/${demo ? '?demo' : '?live'}`, pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole });
  const { window } = dom;
  window.matchMedia = (query) => ({ matches: !/prefers-reduced-motion/.test(query) && /min-width:\s*1024px/.test(query), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  class NoopObserver { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }
  window.ResizeObserver = NoopObserver;
  window.IntersectionObserver = NoopObserver;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = (input, init) => globalThis.fetch(String(input), init);
  window.__SMOKE_API_BASE__ = BASE;
  window.eval(fs.readFileSync(bundlePath, 'utf8'));
  const $ = (sel) => dom.window.document.querySelector(sel);
  const $$ = (sel) => Array.from(dom.window.document.querySelectorAll(sel));
  const bodyText = () => dom.window.document.body.textContent ?? '';
  const waitFor = async (predicate, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (predicate()) return true; await wait(150); }
    return predicate();
  };
  await wait(900);
  return { window, document: dom.window.document, errors, $, $$, bodyText, waitFor };
};

const v1 = await bootStorefront();
check('storefront boots against the real backend without runtime errors', () => v1.errors.length === 0 || v1.errors.slice(0, 2).join(' | '));
check('the published home marker is on the page', () => !!v1.$('[data-cms-home="home"]'));
check('the published version marker matches publication v1', () => v1.$('[data-cms-home]').getAttribute('data-cms-home-version') === String(pub1.version) || `marker=${v1.$('[data-cms-home]')?.getAttribute('data-cms-home-version')} published=${pub1.version}`);
check('the CMS hero payload drives the accepted hero', () => v1.bodyText().includes('پرده اول کلبه') && v1.bodyText().includes('کالکشن پاییز') ? true : 'published hero copy missing');
check('the hero keeps the accepted full-bleed presentation', () => !!v1.$('.kv-sf-hero'));
check('every published non-hero section renders in published order', () => {
  const rendered = v1.$$('[data-cms-section-id]').map((node) => node.getAttribute('data-component'));
  const expected = live1.sections.filter((s) => s.component_code !== 'hero').map((s) => s.component_code);
  return JSON.stringify(rendered) === JSON.stringify(expected) ? true : `rendered=[${rendered}] published=[${expected}]`;
});
check('hidden sections are absent from the storefront', () => !v1.bodyText().includes('باشگاه کلبه') || 'newsletter payload copy leaked');
check('a section added by the editor appears after publish', () => v1.bodyText().includes('ویراستاری کلبه'));
check('product bands render the real catalogue cards', () => {
  const cells = v1.$$('[data-component="product_grid"] .kv-sf-cell, [data-component="product_slider"] .kv-sf-cell');
  return cells.length >= 4 ? true : `only ${cells.length} cards rendered`;
});
check('the legacy fallback composition is fully replaced (no double render)', () =>
  !v1.bodyText().includes('تازه‌رسیده‌ها') && !v1.bodyText().includes('از کدام قفسه شروع کنیم؟') ? true : 'fallback band copy leaked next to published sections');
check('the CMS announcement system owns the announcement bar', () =>
  v1.bodyText().includes('کالکشن تازه کلبه وینتیج را ببینید') && !v1.bodyText().includes('PAIZ1404') ? true : 'server announcement missing or legacy ops bar rendered');
check('no demo badge outside demo mode', () => !v1.$('[data-demo-badge]'));
check('padding, width and background overrides reach the storefront band', () => {
  const band = v1.$$('[data-cms-section-id]').find((node) => (node.getAttribute('data-kv-pad') || node.getAttribute('data-kv-width') || node.getAttribute('data-kv-bg')));
  if (!band) return 'no band carries override attrs';
  return band.getAttribute('data-kv-pad') === 'lg' && band.getAttribute('data-kv-width') === 'narrow' && band.getAttribute('data-kv-bg') === 'surfaceSecondary'
    ? true : `pad=${band.getAttribute('data-kv-pad')} width=${band.getAttribute('data-kv-width')} bg=${band.getAttribute('data-kv-bg')}`;
});
check('the section theme class reaches the storefront band', () => {
  const band = v1.$$('[data-cms-section-id]').find((node) => node.className.includes('kv-surface-2') || node.className.includes('bg-'));
  return !!band;
});

/* scheduled publication must never be public before its window opens */
const draftS = await draftOf();
const savedS = await saveDraft(draftS);
const scheduled = await api(`/admin/cms/pages/${homePage.id}/publish`, { method: 'POST', token, payload: { expectedRevision: savedS.draft_revision, changeSummary: 'زمان‌بندی E2E', scheduledStartAt: new Date(Date.now() + 6 * 3600e3).toISOString() } });
check('a future start date parks the publication in scheduled (never public)', () => {
  if (scheduled.status !== 200) return `publish failed ${scheduled.status}`;
  const status = scheduled.body?.status ?? scheduled.body?.page?.status;
  return status === 'scheduled' || `status=${status}`;
});
const liveDuringSchedule = await api('/site/pages/home');
check('a scheduled future version never goes public early; the previous publication stays live', () => {
  if (liveDuringSchedule.status !== 200) return `public status=${liveDuringSchedule.status}`;
  const hero = liveDuringSchedule.body.sections.find((sec) => sec.component_code === 'hero');
  return hero?.payload?.title === 'پرده اول کلبه' || `scheduled content leaked early: ${hero?.payload?.title}`;
});
const restored = await api(`/admin/cms/pages/${homePage.id}/publish`, { method: 'POST', token, payload: { expectedRevision: (await draftOf()).draft_revision, changeSummary: 'بازگشت به انتشار فوری' } });
const liveAfterRestore = await api('/site/pages/home');
check('publishing without a schedule returns the homepage to the public site', () => restored.status === 200 && liveAfterRestore.status === 200);

/* ------------------- 6: second publication + full reload ------------------ */
const draft2 = await draftOf();
const hero2 = draft2.sections.find((s) => s.component_code === 'hero');
hero2.payload = { ...hero2.payload, title: 'پرده دوم کلبه' };
const saved2 = await saveDraft(draft2);
const pub2 = await publish(saved2.draft_revision, 'E2E انتشار نسخه دوم');
const v2 = await bootStorefront();
check('a republished title survives a full reload (fresh boot)', () => v2.bodyText().includes('پرده دوم کلبه') && !v2.bodyText().includes('پرده اول کلبه') ? true : 'v2 hero copy missing');
check('the version marker advanced to publication v2', () => v2.$('[data-cms-home]')?.getAttribute('data-cms-home-version') === String(pub2.version) || `marker=${v2.$('[data-cms-home]')?.getAttribute('data-cms-home-version')}`);

/* ------------------------- 7: demo stays demo ----------------------------- */
const demo = await bootStorefront({ demo: true });
check('demo mode never renders published CMS content', () => !demo.$('[data-cms-home]') && !demo.bodyText().includes('پرده دوم کلبه') ? true : 'published CMS leaked into demo');
check('demo mode keeps the accepted fallback composition', () => demo.bodyText().includes('تازه‌رسیده‌ها') || 'fallback composition missing in demo');
check('demo mode is prominently labeled', () => !!demo.$('[data-demo-badge]') && (demo.$('[data-demo-badge]')?.textContent ?? '').includes('حالت نمایشی'));

/* -------------------------------- summary -------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\ncms-home E2E (real backend + real DOM): ${results.length - failed.length}/${results.length} passed`);
await app.close().catch(() => undefined);
await pgServer.stop().catch(() => undefined);
await db.close().catch(() => undefined);
process.exit(failed.length ? 1 : 0);
