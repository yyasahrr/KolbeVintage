/* Real-browser admin console smoke (items 26 + 35).

   Drives http://localhost:5173/#/admin with headless Chromium against the live local stack
   (backend/scripts/local-stack.mjs → real migrations on embedded PostgreSQL + real API on :4000).

   Pass 1 runs on the as-migrated (empty) database: empty states, first-warehouse creation,
   CMS bootstrap, palette, ledger, integrations, no false "disconnected" banner.
   Pass 2 runs `npm run seed:local` (NODE_ENV=development) and re-checks the data-driven UI.

   Run with: LD_LIBRARY_PATH=/tmp/chromedeps/lib:/tmp/chromedeps node scripts/browser-admin-smoke.mjs */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import puppeteer from 'puppeteer-core';
import { warehouseUxSmoke } from './warehouse-ux-browser.mjs';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const chromePath = process.env.KV_CHROME_PATH ?? '/tmp/chromium';
const stopProcessTree = (child, signal = 'SIGTERM') => {
  if (!child?.pid) return;
  if (process.platform === 'win32') { try { child.kill(); } catch { /* gone */ } }
  else { try { process.kill(-child.pid, signal); } catch { /* gone */ } }
};

/** The smoke owns its stack so every run starts from an as-migrated (empty) database. */
const freePort = async (start) => {
  for (let port = start; port < start + 60; port += 1) {
    // On Windows a loopback bind can succeed beside a wildcard listener; reject live ports first.
    const listening = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (listening) continue;
    const ok = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error(`no free port near ${start}`);
};
const useExternalStack = process.env.KV_SMOKE_EXTERNAL === '1';
const pgPort = useExternalStack ? Number(process.env.KV_PG_PORT ?? 55449) : await freePort(55460);
const apiPort = useExternalStack ? Number(process.env.KV_API_PORT ?? 4000) : await freePort(5087);
const webPort = Number(process.env.KV_WEB_PORT ?? (useExternalStack ? 5173 : await freePort(5187)));
const databaseUrl = `postgres://127.0.0.1:${pgPort}/pglite`;
const stack = { pgPort, apiPort, webPort, databaseUrl };
const base = `http://localhost:${webPort}`;

let db = null;
let socketServer = null;
if (!useExternalStack) {
  db = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db, port: pgPort, host: '127.0.0.1', maxConnections: 20 });
  await socketServer.start();
}
const env = {
  ...process.env, NODE_ENV: 'development', REDIS_URL: undefined,
  DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
  JWT_SECRET: 'browser-smoke-secret-at-least-thirty-two-chars',
  PUBLIC_ORIGIN: base, PG_POOL_MAX: '4', PORT: String(apiPort),
};
const runStep = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
});
// On an already-provisioned stack (live preview) migrations are applied and the admin exists;
// both steps are idempotent-safe, so a non-zero exit there is expected rather than fatal.
const tolerantStep = async (command, args, extraEnv = {}) => {
  try { await runStep(command, args, extraEnv); }
  catch (error) { if (!useExternalStack) throw error; console.log(`[smoke] ${command} skipped on the existing stack`); }
};
await tolerantStep('npm', ['run', '--silent', 'migrate']);
await tolerantStep('npx', ['tsx', 'src/bootstrap-admin.ts'], {
  BOOTSTRAP_ADMIN_EMAIL: 'admin@kolbe.ir', BOOTSTRAP_ADMIN_PASSWORD: 'ChangeMe-Admin-123456',
});
let apiLog = '';
let api = null;
const startApi = async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  child.stdout.on('data', (chunk) => { apiLog += String(chunk); });
  child.stderr.on('data', (chunk) => { apiLog += String(chunk); });
  child.once('exit', (code, signal) => { apiLog += `\n[smoke] API pid ${child.pid} exited code=${code} signal=${signal}\n`; });
  child.once('error', (error) => { apiLog += `\n[smoke] API pid ${child.pid} error=${error.message}\n`; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    try { const health = await fetch(`http://127.0.0.1:${apiPort}/health/live`); if (health.ok) return child; } catch { /* booting */ }
  }
  throw new Error('api did not become ready');
};
const portBusy = async (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setTimeout(500);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
const stopApi = async (child) => {
  if (!child?.pid) return;
  stopProcessTree(child);
  for (let attempt = 0; attempt < 30 && await portBusy(apiPort); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (attempt === 10) stopProcessTree(child, 'SIGKILL');
  }
  // A stale listener on the same port would silently serve the health check and keep a second
  // pool open against the single-writer embedded database — that is what broke the seed phase.
  if (await portBusy(apiPort)) throw new Error(`api port ${apiPort} still busy after graceful stop`);
};
api = useExternalStack ? { pid: null } : await startApi();
const web = useExternalStack ? { pid: null, stdout: null, stderr: null, on: () => {} } : spawn(process.execPath, [join(repoRoot, 'node_modules/vite/bin/vite.js'), '--port', String(webPort), '--strictPort'], {
  cwd: repoRoot,
  env: { ...process.env, KV_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
  stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
});
let webLog = '';
if (web.stdout) { web.stdout.on('data', (chunk) => { webLog += String(chunk); }); web.stderr.on('data', (chunk) => { webLog += String(chunk); }); }
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { const webReady = await fetch(base); if (webReady.ok) break; } catch { /* still booting */ }
}
const shotDir = join(tmpdir(), 'kolbe-admin-smoke');
mkdirSync(shotDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
/** Fresh-database assertions are only meaningful when the smoke owns an as-migrated database. */
const checkFresh = (fresh, name, fn) => {
  if (fresh) { check(name, fn()); return; }
  console.log(`N/A   ${name} — needs a fresh database (running against an existing stack)`);
};

const freshDb = !useExternalStack;
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
});
const page = await browser.newPage();
const smokeSessionNonce = `kolbe-browser-smoke-${Date.now()}`;
await page.evaluateOnNewDocument((nonce) => {
  if (window.name !== nonce) {
    localStorage.removeItem('kolbe-access-token');
    sessionStorage.removeItem('kolbe-admin-auth');
    window.name = nonce;
  }
  window.__kvAuthRemovals = [];
  window.__kvLastClick = '';
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button) window.__kvLastClick = button.innerText.trim().replace(/\s+/g, ' ').slice(0, 80);
  }, true);
  const original = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (key) {
    if (key === 'kolbe-admin-auth') {
      window.__kvAuthRemovals?.push(`${new Error().stack ?? 'stack unavailable'}\nLAST_CLICK=${window.__kvLastClick}`);
    }
    return original.call(this, key);
  };
}, smokeSessionNonce);
await page.setViewport({ width: 1440, height: 1100 });

const consoleErrors = [];
const failedResponses = [];
/** Every API call the console makes, so UI claims can be tied to real requests. */
const apiCalls = [];
const authorizationResponses = [];
page.on('response', (response) => {
  const request = response.request();
  const url = response.url();
  if (response.status() >= 500) failedResponses.push(`${response.status()} ${request.method()} ${url}`);
  if (url.includes('/api/v1') && [401, 403].includes(response.status())) {
    authorizationResponses.push(`${response.status()} ${request.method()} ${url.slice(url.indexOf('/api/v1'))}`);
  }
});
page.on('request', (request) => {
  const url = request.url();
  const index = url.indexOf('/api/v1');
  if (index >= 0) apiCalls.push(`${request.method()} ${url.slice(index)}`);
});
const sawCall = (method, fragment) => apiCalls.some((entry) => entry.startsWith(method) && entry.includes(fragment));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.stack ?? error.message}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sidebarLabels = () => page.evaluate(() => {
  const nav = document.querySelector('aside') ?? document.body;
  return [...nav.querySelectorAll('button')].map((button) => button.innerText.trim().split('\n')[0]).filter(Boolean).slice(0, 40);
});
const text = () => page.evaluate(() => document.body.innerText);
/** Captures of every module body, used by the final Persian-only sweep. */
const seenBodies = [];
const capture = (body) => { seenBodies.push(body); return body; };
const shot = async (name) => { await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false }); };
/** Poll until the rendered text contains `needle` (async modules: API round-trip + render). */
const waitForText = async (needle, attempts = 24) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await text()).includes(needle)) return true;
    await sleep(400);
  }
  return false;
};

/** Click a sidebar entry by its visible Persian label and confirm the module rendered.
    A click can be swallowed while the console revalidates its session, so it is retried. */
const openTab = async (label) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const clicked = await page.evaluate((wanted) => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((candidate) => candidate.innerText.trim().startsWith(wanted));
      if (!button) return false;
      button.click();
      return true;
    }, label);
    if (!clicked) {
      const labels = await sidebarLabels();
      await shot(`debug-missing-${label.replace(/\s/g, '_')}`);
      throw new Error(`sidebar entry not found: ${label} | sidebar: [${labels.join(' ، ')}]`);
    }
    await sleep(1100);
    // The header title of the opened module repeats the sidebar label; also make sure the console
    // did not bounce back to the login gate (session revalidation) or to the default tab.
    const body = await text();
    if (body.includes(label) && !body.includes('ورود با حساب ثبت‌شده در سرور')) return;
  }
  await shot(`debug-unopened-${label.replace(/\s/g, '_')}`);
  throw new Error(`module «${label}» never rendered after 3 clicks`);
};

const clickByText = async (wanted) => {
  const clicked = await page.evaluate((target) => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((candidate) => candidate.innerText.trim().includes(target) && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  }, wanted);
  await sleep(700);
  return clicked;
};

// Product 360 and product-pricing workspaces are dialogs nested above the console shell.
// Resolve ambiguous labels such as «موجودی» only within the foremost open dialog so a tab
// click can never escape to the WMS sidebar or a lower, covered workspace.
const clickInDialogByText = async (wanted) => {
  const clicked = await page.evaluate((target) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(visible);
    const dialog = dialogs.at(-1);
    if (!dialog) return false;
    const button = [...dialog.querySelectorAll('button')]
      .find((candidate) => candidate.innerText.trim().includes(target) && !candidate.disabled && visible(candidate));
    if (!button) return false;
    button.click();
    return true;
  }, wanted);
  await sleep(700);
  return clicked;
};

/** Choose an option of a native select rendered by a Field with the given label. */
const setSelectByOption = async (labelText, optionSubstring) => page.evaluate((target, wanted) => {
  const label = [...document.querySelectorAll('label')].find((candidate) => candidate.innerText.includes(target));
  const select = label?.querySelector('select');
  if (!select) return false;
  const option = [...select.options].find((candidate) => candidate.text.includes(wanted));
  if (!option) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, labelText, optionSubstring);

const setInput = async (labelText, value) => page.evaluate((target, val) => {
  // Field markup: <label>…label…<input></label>
  const labels = [...document.querySelectorAll('label')];
  const label = labels.find((candidate) => candidate.innerText.includes(target));
  const input = label?.querySelector('input, textarea, select');
  if (!input) return false;
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(input, val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, labelText, value);

const setSearch = async (placeholder, value) => page.evaluate((ph, val) => {
  const input = [...document.querySelectorAll('input')].find((candidate) => candidate.placeholder === ph);
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, placeholder, value);

let adminToken = null;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const adminApi = async (path, method = 'GET', payload = undefined) => {
  if (!adminToken) throw new Error('browser smoke admin token is not available');
  const response = await fetch(`${apiOrigin}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${adminToken}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, body };
};

try {
  // ---------------------------- login ----------------------------
  await page.goto(`${base}/#/admin`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);
  const loginVisible = (await text()).includes('کنسول مدیریت کلبه');
  check('admin login gate renders', loginVisible);
  await setInput('ایمیل', 'admin@kolbe.ir');
  await setInput('گذرواژه', 'ChangeMe-Admin-123456');
  await clickByText('ورود');
  await sleep(2500);
  const afterLogin = await text();
  check('admin console shell renders after real login (no sessionStorage seeding)',
    afterLogin.includes('کنسول مدیریت') && !afterLogin.includes('ورود با حساب ثبت‌شده در سرور') && afterLogin.includes('برج کنترل'),
    afterLogin.replace(/\n+/g, ' ').slice(0, 90));
  adminToken = await page.evaluate(() => localStorage.getItem('kolbe-access-token'));
  check('admin browser session token is available to acceptance probes', Boolean(adminToken));
  const falseBanner = afterLogin.includes('اطلاعات این بخش هنوز به سرور متصل نیست');
  check('hardcoded «پیش‌نمایش رابط» banner is gone', !falseBanner);
  await shot('01-tower');

  // ---------------------------- pass 1: empty database ----------------------------
  // Final IA: shipping CONFIG lives under «تنظیمات و دسترسی» (legacy «حمل‌ونقل» key redirects).
  await openTab('تنظیمات و دسترسی');
  let body = await text();
  check('shipping tab opens with the canonical columns', body.includes('کد روش ارسال') && body.includes('نوع ارسال') && body.includes('هزینه پایه'));
  check('shipping tab states a real server connection (not the old banner)',
    body.includes('داده‌های این بخش از سرور خوانده می‌شود'), body.split('\n').slice(0, 6).join(' | ').slice(0, 120));
  check('shipping empty state is honest (no fabricated carrier rows)',
    body.includes('روش ارسالی ثبت نشده') || body.includes('روش ارسال') , '');
  await shot('02-shipping-empty');

  await openTab('انبار و موجودی (WMS)');
  await clickByText('تنظیمات انبار');
  body = await text();
  checkFresh(freshDb, 'WMS first-run card offers «ساخت انبار»', () => body.includes('ساخت انبار'));
  check('WMS copy is Persian (no Low Stock / Movement History leftovers)',
    !/Low Stock|Movement History|Warehouse ID|Variant ID|Delta|Reference|Adjustment|Transfer/.test(body));
  if (freshDb) {
    const createdWarehouse = await setInput('کد انبار', 'KV-MAIN') && await setInput('نام انبار', 'انبار مرکزی');
    check('WMS warehouse form accepts code + Persian name', createdWarehouse);
    await clickByText('ساخت انبار');
    await sleep(2500);
    body = await text();
    check('WMS «ساخت انبار» really creates it and reloads the module',
      body.includes('KV-MAIN') && body.includes('انبار مرکزی'), body.split('\n').slice(0, 5).join(' | ').slice(0, 120));
    check('WMS first-warehouse button performs a real POST /warehouses',
      sawCall('POST', '/warehouses') && sawCall('GET', '/warehouses'), apiCalls.filter((c) => c.includes('/warehouses')).slice(-3).join(' , '));
  } else {
    const switched = await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="انبار انتخاب‌شده"]');
      if (!select) return false;
      const option = [...select.options].find((candidate) => candidate.text.includes('KV-TEH-01'));
      if (!option) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    await sleep(1500);
    body = await text();
    check('WMS lists the real warehouses from the server', switched, body.replace(/\n+/g, ' | ').slice(0, 90));
  }
  await shot('03-wms-first-warehouse');
  await page.keyboard.press('Escape');

  await openTab('تخفیف و جشنواره');
  body = await text();
  check('promo panel is Persian (درصدی/مبلغ ثابت/جشنواره)',
    body.includes('درصدی') && body.includes('مبلغ ثابت') && body.includes('جشنواره'));
  check('promo uses Jalali date inputs (not ISO) for expiry', body.includes('تاریخ انقضا') && !/\d{4}-\d{2}-\d{2}/.test(body), '');
  const calendarOpened = await page.evaluate(() => {
    const trigger = document.querySelector('button[aria-label="باز کردن تقویم"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  });
  await sleep(600);
  const calendar = await page.evaluate(() => document.body.innerText);
  check('shared PersianDatePicker opens a Jalali calendar',
    calendarOpened && /فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند/.test(calendar),
    (calendar.match(/[۰-۹]{4}\/[۰-۹]{2}/) ?? ['—'])[0]);
  await shot('04-promo-jalali');
  await page.keyboard.press('Escape');
  await sleep(300);

  await openTab('محتوا');
  body = await text();
  if (!freshDb) {
    check('CMS shows the persisted home structure on an existing stack',
      body.includes('صفحه اصلی') || body.includes('هیرو'), body.replace(/\n+/g, ' | ').slice(0, 80));
  } else {
    check('CMS empty state offers «راه‌اندازی صفحه اصلی» (server-side bootstrap)',
      body.includes('راه‌اندازی صفحه اصلی'));
  }
  await clickByText('راه‌اندازی صفحه اصلی');
  await sleep(2500);
  body = await text();
  check('CMS bootstrap created the home page + hero on the server',
    body.includes('هیرو') && (body.includes('صفحه اصلی') ), body.split('\n').slice(0, 6).join(' | ').slice(0, 140));
  await shot('05-cms-bootstrap');

  // Final IA (Prompt 4 §15): GL lives inside مرکز مالی → حسابداری → دفتر کل.
  await openTab('مرکز مالی');
  await clickByText('حسابداری');
  await clickByText('دفتر کل');
  await sleep(1500);
  body = await text();
  if (!freshDb) {
    check('ledger renders real rows when the stack already carries finance events',
      !body.includes('هنوز رویداد مالی واقعی ایجاد نشده است.') || body.includes('فاکتور'), body.replace(/\n+/g, ' | ').slice(0, 80));
  } else {
    check('ledger empty state is the real one (no fabricated entries)',
      body.includes('هنوز رویداد مالی واقعی ایجاد نشده است.'));
    check('ledger explains automatic entries + offers real navigation',
      body.includes('پرداخت سفارش') && body.includes('می‌شود'), '');
  }
  await shot('06-ledger-empty');

  await openTab('یکپارچه‌سازی‌ها');
  body = await text();
  check('integrations panel empty state is Persian and honest',
    body.includes('اتصالی ثبت نشده است') || body.includes('اتصال جدید'));
  check('integrations empty state exposes no demo secret',
    !body.includes('demo-secret-1234'));
  await clickByText('اتصال جدید');
  await sleep(700);
  body = await text();
  check('integration form is Persian-labelled with a masked secret field',
    body.includes('نام سرویس') && body.includes('دسته') && body.includes('ارائه‌دهنده') && body.includes('محیط'));
  const secretType = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('label')];
    const label = labels.find((candidate) => candidate.innerText.includes('کلید/رمز'));
    return label?.querySelector('input')?.getAttribute('type') ?? null;
  });
  check('secret input is type=password (never a plain demo default)', secretType === 'password', String(secretType));
  await shot('07-integrations');

  // module tabs must never crash or blank the console
  const moduleTabs = ['مشتریان (CRM)', 'اعلان‌ها', 'مرکز مالی', 'محتوا'];
  capture((await text()));
  for (const label of moduleTabs) {
    try {
      await openTab(label);
      const moduleBody = capture(await text());
      const crashed = moduleBody.includes('خطایی در این بخش رخ داد');
      const blank = moduleBody.trim().length < 200;
      check(`module «${label}» renders without crash/blank`, !crashed && !blank, crashed ? 'boundary shown' : `${moduleBody.length} chars`);
    } catch (error) {
      check(`module «${label}» renders without crash/blank`, false, String(error.message).slice(0, 80));
    }
  }

  // ---------------------------- pass 2: explicit local seed ----------------------------
  console.log(`[smoke] browser session before seed: ${JSON.stringify(await page.evaluate(() => ({ token: Boolean(localStorage.getItem('kolbe-access-token')), marker: sessionStorage.getItem('kolbe-admin-auth') })))}`);
  // Park outside the console while the single-writer embedded database is reseeded and the API restarts.
  if (!useExternalStack) {
    // A public-route page still polls catalog/site endpoints in the background; keep the browser
    // truly idle during the deliberate API outage for the embedded-database seed step.
    await page.goto('about:blank', { waitUntil: 'load', timeout: 60000 });
    await stopApi(api);
  }
  // Explicit, manual seed command (never automatic; development-only by its own guard).
  // NOTE: spawned asynchronously on purpose — the embedded database lives in THIS process, so a
  // synchronous `execFileSync` would freeze the event loop and the seed could never connect.
  const seedRun = await new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', 'seed:local'], {
      cwd: join(repoRoot, 'backend'),
      env: {
        ...process.env, NODE_ENV: 'development', REDIS_URL: undefined,
        DATABASE_URL: stack.databaseUrl, TEST_DATABASE_URL: stack.databaseUrl,
        JWT_SECRET: process.env.JWT_SECRET ?? 'browser-smoke-secret-at-least-thirty-two-chars',
        PUBLIC_ORIGIN: base,
      },
      stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { out += String(chunk); });
    child.on('exit', (code) => resolve({ code, out }));
  });
  const seedOutput = seedRun.out;
  if (seedRun.code !== 0) console.error('--- seed output ---\n' + seedOutput.split('\n').slice(-12).join('\n'));
  check('npm run seed:local exits 0 and applies real steps', seedRun.code === 0, seedOutput.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 90));
  api = useExternalStack ? { pid: null } : await startApi();
  check('seed reports an idempotent run and its census',
    /steps applied|idempotent/.test(seedOutput) && (freshDb ? /انبار|محصول|موجودی/.test(seedOutput) : true),
    (seedOutput.match(/seed:local finished[^\n]{0,40}/) ?? ['—'])[0]);
  const seededAuth = await fetch(`${apiOrigin}/api/v1/auth/me`, { headers: { authorization: `Bearer ${adminToken}` } });
  check('existing browser access token remains valid after the API restart', seededAuth.status === 200, `HTTP ${seededAuth.status}`);
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 60000 });
  const sessionBeforeReload = await page.evaluate(() => ({
    hasAccessToken: Boolean(localStorage.getItem('kolbe-access-token')),
    adminSession: sessionStorage.getItem('kolbe-admin-auth'),
  }));
  console.log(`[smoke] browser session before reload: ${JSON.stringify(sessionBeforeReload)}`);
  check('browser session marker survives the controlled API restart', sessionBeforeReload.adminSession === '1' && sessionBeforeReload.hasAccessToken);
  if (authorizationResponses.length) console.log(`[smoke] 401/403 responses: ${JSON.stringify(authorizationResponses.slice(-30))}`);
  console.log(`[smoke] recent API calls: ${JSON.stringify(apiCalls.slice(-35))}`);
  console.log(`[smoke] session marker removals: ${JSON.stringify(await page.evaluate(() => window.__kvAuthRemovals ?? []))}`);

  // Re-open the admin route in the same browser tab so every module re-fetches from the seeded database.
  await page.goto(`${base}/#/admin`, { waitUntil: 'networkidle2', timeout: 60000 });
  // The console re-validates its session (401 → single refresh → /auth/me) before painting the
  // shell, so wait for the sidebar instead of guessing a delay.
  let shellReady = false;
  for (let attempt = 0; attempt < 40 && !shellReady; attempt += 1) {
    await sleep(500);
    shellReady = await page.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.innerText.trim().startsWith('برج کنترل')));
  }
  check('console shell comes back after a full reload (session revalidation)', shellReady);
  if (!shellReady) {
    console.error('--- after reload body ---\n' + (await text()).replace(/\n+/g, ' | ').slice(0, 400));
    console.error('--- after reload url --- ' + page.url());
    console.error('--- after reload storage --- ' + JSON.stringify(await page.evaluate(() => ({
      hasAccessToken: Boolean(localStorage.getItem('kolbe-access-token')),
      adminSession: sessionStorage.getItem('kolbe-admin-auth'),
    }))));
    console.error('--- browser auth probe --- ' + JSON.stringify(await page.evaluate(async () => {
      const token = localStorage.getItem('kolbe-access-token');
      const response = await fetch('/api/v1/auth/me', { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      return { status: response.status, body: await response.json().catch(() => null) };
    })));
    console.error('--- console errors ---\n' + consoleErrors.slice(-6).join('\n'));
  }
  await openTab('تنظیمات و دسترسی');
  body = await text();
  check('seeded shipping methods are listed with Persian types',
    /استاندارد|سریع|تحویل حضوری/.test(body) && body.includes('تومان'), '');
  check('shipping table has no raw ISO dates', !/\d{4}-\d{2}-\d{2}T/.test(body));
  await shot('08-shipping-seeded');

  await openTab('انبار و موجودی (WMS)');
  await warehouseUxSmoke({ page, check, apiPort, clickByText, setInput, text, waitForText });
  await shot('09-wms-seeded');

  // Canonical cross-surface acceptance fixture: exact variant discounts, canonical Festival record,
  // and a deliberately stackable definition (the Resolver must still make Festival exclusive).
  let pricingProductId = null;
  let pricingProductName = `محصول آزمون قیمت ${Date.now()}`;
  let pricingFestivalName = `جشنواره آزمون قیمت ${Date.now()}`;
  let pricingVariants = [];
  let pricingScenarioReady = false;
  if (freshDb) {
    const created = await adminApi('/products', 'POST', {
      brand: 'Kolbe', name: pricingProductName, category: 'پیراهن', cashPriceRial: '1000000',
      installmentPriceRial: '1200000', retailEnabled: true, wholesaleEnabled: false,
      variants: [{ color: 'Black', size: 'M' }, { color: 'Black', size: 'L' }, { color: 'Cream', size: 'XL' }],
      metadata: { editorialSku: `BROWSER-PRICE-${Date.now()}`, channels: { retail: true, wholesale: false, styleBuilder: false } },
    });
    pricingProductId = created.body.id;
    const detail = await adminApi(`/admin/products/${pricingProductId}`);
    pricingVariants = detail.body.variants;
    const expected = new Map([['M', 15], ['L', 20], ['XL', 10]]);
    for (const variant of pricingVariants) {
      const response = await adminApi('/promotions/rules', 'POST', {
        channel: 'retail', targetType: 'variant', productId: pricingProductId, variantId: variant.id,
        discountType: 'percent', discountValue: expected.get(variant.size), name: `${variant.color}/${variant.size}`,
      });
      if (response.status !== 201) throw new Error(`pricing rule create failed: ${JSON.stringify(response.body)}`);
    }
    await adminApi(`/promotions/products/${pricingProductId}/mode`, 'POST', { mode: 'standalone', enabled: true });
    const festival = await adminApi('/promotions', 'POST', {
      name: pricingFestivalName, kind: 'festival', channel: 'retail',
      exclusivePolicy: 'stackable_by_priority', active: true,
    });
    pricingScenarioReady = Boolean(festival.body.id && pricingVariants.length === 3);
    check('browser pricing fixture uses canonical product/rule/Festival records', pricingScenarioReady,
      `${pricingVariants.length} variant rules · ${pricingFestivalName}`);
  }

  // Product Studio catalog-only create → post-create direct WMS setup handoff.
  await openTab('محصولات کلبه');
  const studioProductName = `محصول شروع موجودی ${Date.now()}`;
  let studioProductId = null;
  const captureStudioCreate = async (response) => {
    if (response.request().method() !== 'POST' || !response.url().includes('/api/v1/products') || response.status() !== 201) return;
    try { studioProductId = (await response.json()).id ?? studioProductId; } catch { /* not a JSON product response */ }
  };
  page.on('response', captureStudioCreate);
  const formOpened = await clickByText('افزودن محصول');
  const studioBody = await text();
  check('«محصولات کلبه» opens the canonical Product Studio definition form',
    formOpened && studioBody.includes('تعریف محصول جدید'));
  /* Prompt-1 regression: the studio must open on the NEW PRODUCT form — its own product list
     («جست‌وجوی محصول یا SKU…» / «قالب‌های سری کلبه») is a parallel product-management entry. */
  check('[افزودن محصول] opens the NEW PRODUCT form directly, with no intermediate product list',
    studioBody.includes('تعریف محصول جدید')
      && !studioBody.includes('جست‌وجوی محصول یا SKU…')
      && !studioBody.includes('قالب‌های سری کلبه'),
    studioBody.includes('جست‌وجوی محصول یا SKU…') ? 'legacy studio list rendered instead of the form' : '');
  const retailOnly = await clickByText('فقط خرده');
  const named = await setInput('نام محصول', studioProductName);
  await clickByText('رنگ و سایز');
  const colorsSet = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const orange = buttons.find((button) => button.innerText.trim() === 'نارنجی آجری');
    const cream = buttons.find((button) => button.innerText.trim() === 'کرمی');
    if (orange?.getAttribute('aria-pressed') === 'true') orange.click();
    if (cream?.getAttribute('aria-pressed') !== 'true') cream?.click();
    return Boolean(orange && cream && [...document.querySelectorAll('button')].some((button) => button.innerText.trim() === 'مشکی' && button.getAttribute('aria-pressed') === 'true'));
  });
  await clickByText('قیمت‌گذاری');
  const priceSet = await setInput('قیمت نقدی پایه (تومان)', '100000');
  await clickByText('تصویر و ویدیو');
  const tinyProductImage = join(tmpdir(), 'kolbe-browser-smoke-product.png');
  writeFileSync(tinyProductImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64'));
  const imageInput = await page.$('input[type="file"][multiple][accept*="image/png"]');
  if (imageInput) await imageInput.uploadFile(tinyProductImage);
  const productImageUploaded = Boolean(imageInput) && await waitForText('ذخیره‌شده', 50);
  await clickByText('بازبینی و انتشار');
  body = await text();
  const reviewReady = body.includes('همه بخش‌ها کامل است');
  const saveClicked = reviewReady && await clickByText('ذخیره و ادامه');
  const successVisible = await waitForText(`ورود اولیه کالا — ${studioProductName}`, 60);
  page.off('response', captureStudioCreate);
  check('Product Studio catalog create validates retail product + image without stock fields',
    retailOnly && named && colorsSet && priceSet && productImageUploaded && reviewReady && saveClicked && successVisible,
    `channel=${retailOnly} colors=${colorsSet} image=${productImageUploaded} id=${studioProductId ?? 'missing'}`);
  check('§13 [ذخیره و ادامه] hands off straight into «ورود اولیه کالا» — no success page',
    successVisible && Boolean(studioProductId) && !(await text()).includes('محصول با موفقیت تعریف شد'));

  if (studioProductId) {
    const beforeSetup = await adminApi(`/admin/products/${studioProductId}`);
    const draftsRow = await adminApi(`/admin/products?view=drafts&owner=kolbe&limit=200`);
    check('new Product Studio product has zero physical stock and stays پیش‌نویس (draft)',
      beforeSetup.body.inventory_setup === 'pending'
        && beforeSetup.body.status === 'draft'
        && beforeSetup.body.variants.every((variant) => Number(variant.on_hand) === 0)
        && draftsRow.body.items.some((item) => item.id === studioProductId),
      `status=${beforeSetup.body.status} setup=${beforeSetup.body.inventory_setup}`);
  }
  const setupWorkspaceOpened = await waitForText(`ورود اولیه کالا — ${studioProductName}`, 60);
  check('handoff opens «ورود اولیه کالا» with the product preselected (no product search)',
    setupWorkspaceOpened && Boolean(studioProductId));
  check('handoff workspace is the canonical audited opening-receipt form',
    setupWorkspaceOpened && (await text()).includes('تأیید و ثبت سند افتتاحیه') && (await text()).includes('انبار خرده‌فروشی'));
  await clickByText('انصراف');
  await sleep(700);
  if (studioProductId) {
    const afterSkip = await adminApi(`/admin/products?view=drafts&owner=kolbe&limit=200`);
    const detailAfterSkip = await adminApi(`/admin/products/${studioProductId}`);
    check('§14 interrupted handoff leaves the product draft with no stock mutation',
      afterSkip.body.items.some((item) => item.id === studioProductId)
        && detailAfterSkip.body.status === 'draft'
        && detailAfterSkip.body.inventory_setup === 'pending'
        && detailAfterSkip.body.variants.every((variant) => Number(variant.on_hand) === 0),
      `status=${detailAfterSkip.body.status} setup=${detailAfterSkip.body.inventory_setup}`);
  }

  /* §18 PUBLISH-01 — the release-blocking lifecycle defect, end to end in the browser:
     complete the WMS opening receipt, verify the product is STILL draft, then publish
     explicitly from «بازبینی و انتشار» and verify the state actually persisted. */
  if (studioProductId) {
    const setupAgain = await clickByText('ادامه تکمیل محصول');
    await waitForText(`ورود اولیه کالا — ${studioProductName}`, 60);
    const receiptConfirmed = setupAgain && await clickByText('تأیید و ثبت سند افتتاحیه');
    await sleep(2500);
    const afterReceipt = await adminApi(`/admin/products/${studioProductId}`);
    check('§18/§B the WMS opening receipt does NOT auto-publish (still پیش‌نویس)',
      receiptConfirmed && afterReceipt.body.status === 'draft' && afterReceipt.body.inventory_setup === 'configured',
      `status=${afterReceipt.body.status} setup=${afterReceipt.body.inventory_setup}`);

    await clickByText('همه محصولات');
    await waitForText(studioProductName, 60);
    const reopened = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) => candidate.innerText.includes(name));
      const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.innerText.includes('ویرایش'));
      button?.click();
      return Boolean(button);
    }, studioProductName);
    check('§18 reopening a completed product uses the same canonical Studio', reopened && await waitForText('ویرایش محصول ·', 40));
    await clickByText('بازبینی و انتشار');
    await sleep(800);
    const blockedBefore = (await text()).includes('برای انتشار محصول این موارد را تکمیل کنید:');
    const publishClicked = await clickByText('انتشار محصول');
    await sleep(2500);
    const afterPublish = await adminApi(`/admin/products/${studioProductId}`);
    check('§18/§C explicit «انتشار محصول» publishes the product server-side',
      publishClicked && afterPublish.body.status === 'published',
      `blockedChecklist=${blockedBefore} status=${afterPublish.body.status}`);
    check('§18/§E publishing a fully configured product shows success feedback',
      await waitForText('محصول منتشر شد', 30));
    await clickByText('بستن');
    await sleep(800);
    const publishedList = await adminApi(`/admin/products?view=published&owner=kolbe&limit=200`);
    const draftList = await adminApi(`/admin/products?view=drafts&owner=kolbe&limit=200`);
    check('§18/§D the published product appears under «منتشرشده» and left «پیش‌نویس‌ها»',
      publishedList.body.items.some((item) => item.id === studioProductId)
        && !draftList.body.items.some((item) => item.id === studioProductId));
    const catalogueAfterPublish = await adminApi('/products?limit=200');
    check('§2 the storefront read model reflects the new publication state',
      catalogueAfterPublish.body.items.some((item) => item.id === studioProductId));
    /* hard reload: state must survive (no optimistic-only success) */
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(1500);
    const afterReload = await adminApi(`/admin/products/${studioProductId}`);
    check('§18/§D the published state survives a hard browser refresh', afterReload.body.status === 'published');
  }

  // The Product Studio row opens the exact same product pricing workspace as Product 360.
  await clickByText('همه محصولات');
  const studioListReady = await waitForText(studioProductName, 60);
  const studioPricingOpened = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('tbody tr')].find((candidate) => candidate.innerText.includes(name));
    const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.innerText.includes('قیمت‌گذاری'));
    button?.click();
    return Boolean(button);
  }, studioProductName);
  const studioWorkspaceReady = await waitForText(`قیمت‌گذاری محصول · ${studioProductName}`, 50);
  check('Product Studio opens the shared full pricing workspace', studioListReady && studioPricingOpened && studioWorkspaceReady,
    `row=${studioListReady} click=${studioPricingOpened}`);
  if (studioWorkspaceReady) await clickByText('بستن');

  // Product 360 owns the canonical list; search the exact acceptance product to test cross-surface pricing.
  await clickByText('همه محصولات');
  const catalogueReady = await waitForText('همه محصولات');
  const exactProductSearch = pricingScenarioReady && await setSearch('جست‌وجوی نام، برند یا دسته…', pricingProductName);
  const exactProductListed = pricingScenarioReady && await waitForText(pricingProductName, 60);
  check('Product Studio canonical list can locate the pricing acceptance product', catalogueReady && (!pricingScenarioReady || exactProductSearch && exactProductListed));
  const firstProduct = pricingScenarioReady
    ? pricingProductName
    : await page.evaluate(() => document.querySelector('tbody tr td button')?.textContent?.trim() ?? '');
  const productOpened = firstProduct ? await page.evaluate((name) => {
    const row = [...document.querySelectorAll('tbody tr')].find((candidate) => candidate.innerText.includes(name));
    const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.innerText.includes('۳۶۰°'));
    button?.click();
    return Boolean(button);
  }, firstProduct) : false;
  check('Product 360 opens from the canonical list row action «۳۶۰°»', productOpened);
  await sleep(2200);
  body = await text();
  const dialogBox = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) return null;
    const r = dialog.getBoundingClientRect();
    return { x: r.x, width: r.width, viewport: innerWidth, title: dialog.getAttribute('aria-label') };
  });
  check('Product 360 is a centered accessible WorkspaceModal', Boolean(dialogBox)
    && Math.abs((dialogBox.x + dialogBox.width / 2) - dialogBox.viewport / 2) < 3
    && Boolean(dialogBox.title));
  /* §26-G/§26-I: the Studio must offer no local promotion authority and must expose the
     canonical Sales Mode + merged specs step (static DOM truth after the flows above). */
  await clickByText('همه محصولات');
  await clickByText('افزودن محصول');
  await sleep(1200);
  const freshStudio = await text();
  check('§26-I the fresh Studio exposes the canonical Sales Mode and the merged specs step',
    freshStudio.includes('حالت فروش') && freshStudio.includes('فقط خرده') && freshStudio.includes('فقط عمده') && freshStudio.includes('خرده + عمده')
    && freshStudio.includes('مشخصات و راهنمای سایز'));
  check('§26-G the fresh Studio shows no local discount/festival authority toggle',
    await page.evaluate(() => ![...document.querySelectorAll('[role="switch"]')].some((el) => /تخفیف|جشنواره/.test(el.getAttribute('aria-label') ?? ''))));
  check('§11 the specs step demands no template or category binding',
    !/قالب مشخصات|اتصال زنده|کپی ثابت/.test(freshStudio));
  await clickByText('انصراف');
  await sleep(800);
  if ((await text()).includes('تغییرات ذخیره‌نشده')) { await clickByText('خروج بدون ذخیره'); await sleep(600); }

  const product360Tabs = ['نمای کلی', 'واریانت‌ها', 'مشخصات فنی', 'راهنمای سایز', 'رسانه', 'قیمت‌گذاری', 'عمده و سری‌ها', 'موجودی', 'SEO', 'تاریخچه'];
  check('Product 360 exposes all ten useful read areas', product360Tabs.every((label) => body.includes(label)));
  await clickInDialogByText('موجودی'); await sleep(1800); body = await text();
  check('Product 360 inventory is read-only and reads the WMS balance endpoint',
    body.includes('موجودی به تفکیک واریانت و انبار') || body.includes('موجودی‌ای ثبت نشده')
      ? sawCall('GET', '/admin/products/') && sawCall('GET', '/inventory')
      : body.includes('در حال خواندن تراز انبار'));
  check('Product 360 inventory offers no physical stock write controls',
    !/ثبت رسید|ثبت اصلاح|انتقال موجودی|موجودی اولیه محصول/.test(body));
  await shot('10-product-360-inventory');

  await clickInDialogByText('قیمت‌گذاری');
  body = await text();
  check('Product 360 pricing tab shows canonical base/installment, promotion state, variant rules, Resolver and shared workspace',
    body.includes('خلاصهٔ قیمت‌گذاری محصول') && body.includes('قیمت پایهٔ نقدی') && body.includes('سیاست اقساط')
      && body.includes('Discount مستقل') && body.includes('Festival') && body.includes('تخفیف‌های مستقیم واریانت')
      && body.includes('نتیجهٔ نهایی سرور') && body.includes('مدیریت قیمت‌گذاری'));
  const pricingManagerOpened = await clickInDialogByText('مدیریت قیمت‌گذاری');
  const pricingWorkspaceReady = pricingScenarioReady && await waitForText(`قیمت‌گذاری محصول · ${pricingProductName}`, 60);
  check('Product 360 opens the same canonical product pricing workspace', pricingManagerOpened && pricingWorkspaceReady);
  if (pricingWorkspaceReady) {
    await waitForText('Black / M', 50);
    body = await text();
    check('product pricing resolver preview exposes Black/M, Black/L and Cream/XL',
      body.includes('Black / M') && body.includes('Black / L') && body.includes('Cream / XL'));
    check('standalone variant values render before Festival activation',
      body.includes('۱۵٪') && body.includes('۲۰٪') && body.includes('۱۰٪'));
    check('variant discounts are directly discoverable in the Color × Size matrix',
      body.includes('ماتریس تخفیف واریانت · رنگ × سایز') && body.includes('۱۵٪') && body.includes('۲۰٪') && body.includes('۱۰٪'));

    const responsiveResults = [];
    for (const width of [360, 390, 768, 1024, 1440]) {
      await page.setViewport({ width, height: 1100 });
      await sleep(220);
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
        const rect = dialog?.getBoundingClientRect();
        return {
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          dialogLeft: rect?.left ?? -1, dialogRight: rect?.right ?? innerWidth + 1,
          dialogWidth: rect?.width ?? 0, titleVisible: Boolean(dialog?.getAttribute('aria-label')),
        };
      });
      const ok = metrics.titleVisible && metrics.dialogLeft >= -1 && metrics.dialogRight <= width + 1
        && metrics.dialogWidth <= width + 1 && metrics.documentWidth <= width + 1;
      responsiveResults.push({ width, ok, metrics });
      check(`Product Pricing responsive width ${width}px`, ok, JSON.stringify(metrics));
    }
    await page.setViewport({ width: 1440, height: 1100 });

    const installmentSwitchOff = await page.evaluate(() => {
      const toggle = document.querySelector('button[aria-label="خرید چهارقسطه"][role="switch"]');
      if (!toggle || toggle.getAttribute('aria-checked') !== 'true') return false;
      toggle.click(); return true;
    });
    await sleep(250);
    const installmentOffCollapsed = !(await text()).includes('قیمت پایهٔ چهارقسطه (تومان)')
      && !(await page.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.innerText.includes('چهارقسطه'))));
    const installmentSwitchOn = await page.evaluate(() => {
      const toggle = document.querySelector('button[aria-label="خرید چهارقسطه"][role="switch"]');
      if (!toggle || toggle.getAttribute('aria-checked') !== 'false') return false;
      toggle.click(); return true;
    });
    await sleep(250);
    check('four-installment OFF collapses details and ON restores saved draft values',
      installmentSwitchOff && installmentOffCollapsed && installmentSwitchOn
        && (await text()).includes('قیمت پایهٔ چهارقسطه (تومان)'));

    await clickInDialogByText('چهارقسطه');
    const installmentPreview = await adminApi(`/pricing/variants/${pricingVariants[0].id}?orderType=retail&paymentMode=four_installments`);
    check('four-installment mode uses the canonical installment base price', installmentPreview.body.basePrice === '1200000');
    await clickInDialogByText('نقدی');

    const festivalDetailsOpened = await clickInDialogByText('تنظیم Festival');
    const festivalSelected = festivalDetailsOpened && await setSelectByOption('تعریف Festival', pricingFestivalName);
    const festivalApplied = festivalSelected && await clickInDialogByText('اعمال Festival انتخاب‌شده');
    const festivalState = await adminApi(`/promotions/product-summary?productId=${pricingProductId}`);
    const expectedRates = new Map([['M', 15], ['L', 20], ['XL', 10]]);
    const rulesDuringFestival = await adminApi(`/promotions/rules?productId=${pricingProductId}`);
    const standaloneDuringFestival = rulesDuringFestival.body.items.filter((rule) => rule.promotion_id === null);
    const preservedDuringFestival = standaloneDuringFestival.length === 3 && standaloneDuringFestival.every((rule) => {
      const variant = pricingVariants.find((candidate) => candidate.id === rule.variant_id);
      return variant && Number(rule.discount_value) === expectedRates.get(variant.size)
        && rule.effectively_suspended === true && rule.suspended_by_promotion_id === festivalState.body.activeFestival?.promotionId;
    });
    await waitForText('منبع: Festival', 50);
    check('Festival ON suspends without changing the three exact saved variant values',
      festivalApplied && festivalState.body.activeFestival?.name === pricingFestivalName
        && festivalState.body.activeStandaloneRules === 0 && festivalState.body.suspendedStandaloneRules === 3
        && preservedDuringFestival && (await text()).includes('منبع: Festival'));

    const festivalSwitchClicked = await page.evaluate(() => {
      const toggle = document.querySelector('section[aria-label="انتخاب جشنواره"] button[role="switch"]');
      if (!toggle || toggle.getAttribute('aria-checked') !== 'true') return false;
      toggle.click(); return true;
    });
    await sleep(1000);
    const festivalOffState = await adminApi(`/promotions/product-summary?productId=${pricingProductId}`);
    const rulesAfterFestivalOff = await adminApi(`/promotions/rules?productId=${pricingProductId}`);
    const preservedAfterOff = rulesAfterFestivalOff.body.items.filter((rule) => rule.promotion_id === null);
    const basePreviewAfterOff = await adminApi('/pricing/resolve', 'POST', {
      orderType: 'retail', paymentMode: 'cash', items: pricingVariants.map((variant) => ({ variantId: variant.id, quantity: 1 })),
    });
    const discountDetailsCollapsedAfterFestival = !(await text()).includes('ماتریس تخفیف واریانت · رنگ × سایز');
    check('Festival OFF leaves Discount OFF, values suspended and Resolver at base price',
      festivalSwitchClicked && festivalOffState.body.activeFestival === null
        && festivalOffState.body.activeStandaloneRules === 0 && festivalOffState.body.suspendedStandaloneRules === 3
        && preservedAfterOff.length === 3 && preservedAfterOff.every((rule) => rule.effectively_suspended)
        && basePreviewAfterOff.body.lines.every((line) => line.finalPrice === '1000000')
        && discountDetailsCollapsedAfterFestival);

    const discountSwitchClicked = await page.evaluate(() => {
      const toggle = document.querySelector('section[aria-label="حالت تخفیف مستقل"] button[role="switch"]');
      if (!toggle || toggle.getAttribute('aria-checked') === 'true') return false;
      toggle.click(); return true;
    });
    await sleep(1000);
    const discountDetailsRestored = await waitForText('ماتریس تخفیف واریانت · رنگ × سایز', 20);
    const discountOnState = await adminApi(`/promotions/product-summary?productId=${pricingProductId}`);
    const finalRules = await adminApi(`/promotions/rules?productId=${pricingProductId}`);
    const finalRulesExact = finalRules.body.items.filter((rule) => rule.promotion_id === null).length === 3
      && pricingVariants.every((variant) => {
        const rule = finalRules.body.items.find((candidate) => candidate.promotion_id === null && candidate.variant_id === variant.id);
        const rate = expectedRates.get(variant.size);
        return rule && Number(rule.discount_value) === rate && rule.active === true && !rule.effectively_suspended;
      });
    const finalPreview = await adminApi('/pricing/resolve', 'POST', {
      orderType: 'retail', paymentMode: 'cash', items: pricingVariants.map((variant) => ({ variantId: variant.id, quantity: 1 })),
    });
    const expectedFinalBySize = new Map([['M', '850000'], ['L', '800000'], ['XL', '900000']]);
    const exactResolver = pricingVariants.every((variant) => {
      const line = finalPreview.body.lines.find((candidate) => candidate.variantId === variant.id);
      return line?.finalPrice === expectedFinalBySize.get(variant.size) && line.source === 'promotion_rule';
    });
    check('explicit Discount ON restores exact 15/20/10 rules and canonical Resolver outcomes',
      discountSwitchClicked && discountOnState.body.activeStandaloneRules === 3
        && discountOnState.body.suspendedStandaloneRules === 0 && finalRulesExact && exactResolver && discountDetailsRestored);

    await page.keyboard.press('Escape');
    await sleep(450);
    check('product pricing workspace closes accessibly on Escape', !(await text()).includes(`قیمت‌گذاری محصول · ${pricingProductName}`));

    await openTab('تخفیف و جشنواره');
    await clickByText('پروموشن‌های سرور');
    const centerReady = await waitForText(pricingFestivalName, 60);
    body = await text();
    const centerHasExactRules = body.includes(pricingProductName)
      && (body.includes('15٪') || body.includes('۱۵٪'))
      && (body.includes('20٪') || body.includes('۲۰٪'))
      && (body.includes('10٪') || body.includes('۱۰٪'));
    check('global Promotion Center shows the same Festival and exact active variant rules', centerReady && centerHasExactRules);
    await shot('10b-global-pricing-center');

    // Full reload, then re-open from the Product Studio row; values and Resolver results must persist.
    await page.reload({ waitUntil: 'networkidle2' });
    let pricingShellReady = false;
    for (let attempt = 0; attempt < 40 && !pricingShellReady; attempt += 1) {
      await sleep(350);
      pricingShellReady = await page.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.innerText.trim().startsWith('برج کنترل')));
    }
    adminToken = await page.evaluate(() => localStorage.getItem('kolbe-access-token'));
    await openTab('محصولات کلبه');
    const pricingStudioRow = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) => candidate.innerText.includes(name));
      const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.innerText.includes('تخفیف / جشنواره'));
      button?.click(); return Boolean(button);
    }, pricingProductName);
    const reloadedWorkspace = await waitForText(`قیمت‌گذاری محصول · ${pricingProductName}`, 60);
    await waitForText('Black / M', 50);
    body = await text();
    const afterReloadRules = await adminApi(`/promotions/rules?productId=${pricingProductId}`);
    const valuesPersisted = pricingVariants.every((variant) => {
      const rule = afterReloadRules.body.items.find((candidate) => candidate.promotion_id === null && candidate.variant_id === variant.id);
      return rule && Number(rule.discount_value) === expectedRates.get(variant.size) && rule.active === true && !rule.effectively_suspended;
    });
    check('reload + Product Studio re-open preserves exact variant values and Resolver preview',
      pricingShellReady && pricingStudioRow && reloadedWorkspace && valuesPersisted
        && body.includes('Black / M') && body.includes('Black / L') && body.includes('Cream / XL')
        && body.includes('۱۵٪') && body.includes('۲۰٪') && body.includes('۱۰٪'));
    await shot('10c-product-pricing-after-reload');
    await page.keyboard.press('Escape');
    await sleep(450);

    await clickByText('همه محصولات');
    const postReloadProduct360 = await page.evaluate((name) => {
      const row = [...document.querySelectorAll('tbody tr')].find((candidate) => candidate.innerText.includes(name));
      const button = [...(row?.querySelectorAll('button') ?? [])].find((candidate) => candidate.innerText.includes('۳۶۰°'));
      button?.click();
      return Boolean(button);
    }, pricingProductName);
    await sleep(1800);
    const postReloadPricingTab = postReloadProduct360 && await clickInDialogByText('قیمت‌گذاری');
    const postReloadSummaryReady = postReloadPricingTab && await waitForText('نتیجهٔ نهایی سرور', 40);
    body = await text();
    check('reload + Product 360 confirms exact variant values and the canonical Resolver cross-surface',
      postReloadSummaryReady && body.includes('Black / M') && body.includes('Black / L') && body.includes('Cream / XL')
        && body.includes('۱۵٪') && body.includes('۲۰٪') && body.includes('۱۰٪')
        && body.includes('Discount مستقل') && body.includes('قانون تخفیف'));
    await page.keyboard.press('Escape');
    await sleep(450);
  } else {
    // Still verify the Product 360 pricing link on an existing seeded product.
    await clickInDialogByText('قیمت‌گذاری');
    check('Product 360 exposes its pricing workspace entry point', (await text()).includes('مدیریت قیمت‌گذاری'));
    await page.keyboard.press('Escape');
  }
  await openTab('تخفیف و جشنواره');
  body = await text();
  check('seeded coupon row renders a Jalali expiry (۱۴۰۵/…)',
    /[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/.test(body), (body.match(/[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/) ?? ['—'])[0]);
  await shot('11-promo-seeded');

  await openTab('محتوا');
  body = await text();
  check('CMS shows the persisted hero as active after the seed', body.includes('هیرو فعال است') || body.includes('هیرو'));
  await clickByText('صفحات و پالت');
  await sleep(1200);
  body = await text();
  const paletteCreated = await clickByText('ایجاد پالت اصلی');
  await sleep(1800);
  body = await text();
  check('«ایجاد پالت اصلی» is idempotent and lists the الكبه default palette',
    paletteCreated && (body.includes('پالت اصلی کلبه') || body.includes('kolbe-default')));
  await shot('12-palette');

  // jalali table dates + full Persian sweep on the ledger/integrations surfaces
  await openTab('مرکز مالی');
  await clickByText('حسابداری');
  await clickByText('دفتر کل');
  await sleep(1500);
  body = await text();
  const ledgerHasData = !body.includes('هنوز رویداد مالی واقعی ایجاد نشده است.');
  if (ledgerHasData) {
    check('seeded ledger rows render Jalali timestamps and no English headers',
      !/Journal Entries|Reference|Source/.test(body) && /[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/.test(body));
  } else {
    check('ledger kept the real empty state after the seed (no fabricated entries)', true, 'seed created no journal rows');
  }
  await shot('13-ledger-after-seed');

  // ---- full console walk: every section of the sidebar, in order ----
  // Product Studio and WMS are separate entries; the rest of the sidebar is consolidated.
  const allTabs = [
    'مرکز سفارشات', 'محصولات کلبه', 'انبار و موجودی (WMS)', 'برج کنترل', 'مرکز ورود داده', 'اسناد و صورت‌حساب',
    'درخواست همکاری', 'پلن‌های عضویت', 'ساختار محصولات و سری‌ها', 'مشتریان (CRM)', 'تخفیف و جشنواره',
    'محتوا (CMS)', 'مرکز SEO', 'مجله و رسانه‌ها', 'اعلان‌ها', 'مرکز مالی', 'یکپارچه‌سازی‌ها',
    'اتوماسیون و n8n', 'نظرات و امتیازها', 'توصیه‌گر هوشمند', 'پشتیبانی و مرجوعی', 'کیف پول کش‌بک', 'گزارش حسابرسی',
    'محدودیت کاربران', 'تنظیمات و دسترسی',
  ];
  const broken = [];
  for (const label of allTabs) {
    try {
      await openTab(label);
      const moduleBody = capture(await text());
      if (moduleBody.includes('خطایی در این بخش رخ داد')) broken.push(`${label} (boundary)`);
      else if (moduleBody.trim().length < 200) broken.push(`${label} (blank)`);
    } catch (error) {
      broken.push(`${label} (${String(error.message).slice(0, 60)})`);
    }
  }
  check(`every console tab renders (${allTabs.length} sections walked)`, broken.length === 0, broken.join(' , '));
  await shot('14-full-walk');

  const leftovers = consoleErrors.filter((entry) => {
    if (/^(%o|%s|\s*)$/.test(entry.trim())) return false;                       // React placeholder frames
    if (/JSHandle@error|The above error occurred in the/.test(entry)) return false; // React boundary report
    return !/favicon|Download the React DevTools|Failed to load resource: the server responded with a status of 40|net::ERR_CONNECTION_CLOSED|WebSocket connection|value` prop on/i.test(entry);
  });
  check('no unhandled page errors during the console walk', leftovers.length === 0 && failedResponses.length === 0,
    [...leftovers.slice(0, 2), ...failedResponses.slice(0, 4)].join(' | ').slice(0, 300));

  // Full-page Persian sweep of the console chrome (categories of raw English the brief bans)
  await openTab('برج کنترل');
  body = capture(await text());
  const banned = ['Low Stock', 'Movement History', 'Journal Entries', 'Warehouse ID', 'Variant ID', 'Invoice Ledger',
    'Festivals', 'percent', 'fixed', 'Journal', 'Reference', 'Source', 'Delta', 'Adjustment', 'Movement', 'Invoice Ledger'];
  const hits = banned.filter((word) => body.includes(word));
  check('no banned English leftovers in the console chrome', hits.length === 0, hits.join(', '));
  const sweep = [...new Set(seenBodies.join('\n').split('\n').map((line) => line.trim()))]
    .filter((line) => /^[A-Za-z][A-Za-z0-9 _/-]{3,}$/.test(line))
    .filter((line) => !/^\/(admin|api|site|products|orders|invoices|warehouses|inventory)/.test(line))
    .filter((line) => !/^KV-[A-Z0-9-]+$/.test(line))                // order, invoice and warehouse codes
    .filter((line) => !/^SEED-[A-Z0-9-]+$/.test(line))              // stable smoke seed warehouse/reference codes, not UI labels
    .filter((line) => !/^(zibal|nextpay)$/.test(line))              // payment-provider technical codes (shown as codes by design)
    .filter((line) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(line)); // UUIDs
  check('no standalone English UI labels across every visited module', sweep.length === 0, sweep.slice(0, 12).join(' | '));
  writeFileSync(`${shotDir}/api-calls.json`, JSON.stringify(apiCalls, null, 2));
  writeFileSync(`${shotDir}/report.json`, JSON.stringify({ results, consoleErrors, failedResponses }, null, 2));
} catch (error) {
  check('browser admin smoke completed without exceptions', false, String(error.stack ?? error).slice(0, 400));
  console.error('--- page errors ---\n' + consoleErrors.slice(-8).map((entry) => entry.split('\n').slice(0, 5).join('\n')).join('\n===\n'));
} finally {
  // Kill test-owned servers before closing the browser; keep cleanup observable on Windows.
  if (!useExternalStack) for (const child of [api, web]) stopProcessTree(child, 'SIGKILL');
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(() => { browser.process()?.kill(); resolve(); }, 5000))]);
  if (!useExternalStack) {
    for (const child of [api, web]) stopProcessTree(child, 'SIGKILL');
    await socketServer.stop();
    await db.close();
  }
  if (results.some((result) => !result.ok)) {
    console.error('--- api log tail ---\n' + apiLog.split('\n').slice(-60).join('\n'));
    console.error('--- vite log tail ---\n' + webLog.split('\n').slice(-10).join('\n'));
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
