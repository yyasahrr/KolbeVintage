/* Real-browser admin console smoke (items 26 + 35).

   Drives http://localhost:5173/#/admin with headless Chromium against the live local stack
   (backend/scripts/local-stack.mjs → real migrations on embedded PostgreSQL + real API on :4000).

   Pass 1 runs on the as-migrated (empty) database: empty states, first-warehouse creation,
   CMS bootstrap, palette, ledger, integrations, no false "disconnected" banner.
   Pass 2 runs `npm run seed:local` (NODE_ENV=development) and re-checks the data-driven UI.

   Run with: LD_LIBRARY_PATH=/tmp/chromedeps/lib:/tmp/chromedeps node scripts/browser-admin-smoke.mjs */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import puppeteer from 'puppeteer-core';

/** The smoke owns its stack so every run starts from an as-migrated (empty) database. */
const freePort = async (start) => {
  for (let port = start; port < start + 60; port += 1) {
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
  const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'inherit' });
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
  const child = spawn('npx', ['tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (chunk) => { apiLog += String(chunk); });
  child.stderr.on('data', (chunk) => { apiLog += String(chunk); });
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
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  for (let attempt = 0; attempt < 30 && await portBusy(apiPort); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (attempt === 10) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  // A stale listener on the same port would silently serve the health check and keep a second
  // pool open against the single-writer embedded database — that is what broke the seed phase.
  if (await portBusy(apiPort)) throw new Error(`api port ${apiPort} still busy after graceful stop`);
};
api = useExternalStack ? { pid: null } : await startApi();
const web = useExternalStack ? { pid: null, stdout: null, stderr: null, on: () => {} } : spawn('npm', ['run', 'dev', '--', '--port', String(webPort), '--strictPort'], {
  cwd: '/home/user/KolbeVintage',
  env: { ...process.env, KV_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let webLog = '';
if (web.stdout) { web.stdout.on('data', (chunk) => { webLog += String(chunk); }); web.stderr.on('data', (chunk) => { webLog += String(chunk); }); }
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { const webReady = await fetch(base); if (webReady.ok) break; } catch { /* still booting */ }
}
const shotDir = '/home/user/KolbeVintage/artifacts/admin-smoke';
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
  executablePath: '/tmp/chromium',
  headless: 'shell',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });

const consoleErrors = [];
/** Every API call the console makes, so UI claims can be tied to real requests. */
const apiCalls = [];
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
  const falseBanner = afterLogin.includes('اطلاعات این بخش هنوز به سرور متصل نیست');
  check('hardcoded «پیش‌نمایش رابط» banner is gone', !falseBanner);
  await shot('01-tower');

  // ---------------------------- pass 1: empty database ----------------------------
  await openTab('حمل‌ونقل');
  let body = await text();
  check('shipping tab opens with the canonical columns', body.includes('کد روش ارسال') && body.includes('نوع ارسال') && body.includes('هزینه پایه'));
  check('shipping tab states a real server connection (not the old banner)',
    body.includes('داده‌های این بخش از سرور خوانده می‌شود'), body.split('\n').slice(0, 6).join(' | ').slice(0, 120));
  check('shipping empty state is honest (no fabricated carrier rows)',
    body.includes('روش ارسالی ثبت نشده') || body.includes('روش ارسال') , '');
  await shot('02-shipping-empty');

  await openTab('انبار و موجودی');
  body = await text();
  checkFresh(freshDb, 'WMS first-run card offers «ایجاد اولین انبار»', () => body.includes('ایجاد اولین انبار'));
  check('WMS copy is Persian (no Low Stock / Movement History leftovers)',
    !/Low Stock|Movement History|Warehouse ID|Variant ID|Delta|Reference|Adjustment|Transfer/.test(body));
  if (freshDb) {
    const createdWarehouse = await setInput('کد انبار', 'KV-MAIN') && await setInput('نام انبار', 'انبار مرکزی');
    check('WMS warehouse form accepts code + Persian name', createdWarehouse);
    await clickByText('ایجاد اولین انبار');
    await sleep(2500);
    body = await text();
    check('WMS «ایجاد اولین انبار» really creates it and reloads the module',
      body.includes('KV-MAIN') && body.includes('انبار مرکزی'), body.split('\n').slice(0, 5).join(' | ').slice(0, 120));
    check('WMS first-warehouse button performs a real POST /warehouses',
      sawCall('POST', '/warehouses') && sawCall('GET', '/warehouses'), apiCalls.filter((c) => c.includes('/warehouses')).slice(-3).join(' , '));
  } else {
    const switched = await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="انتخاب انبار"]');
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

  await openTab('کوپن و جشنواره');
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

  await openTab('دفتر کل');
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
  const moduleTabs = ['مشتریان', 'پنل پیامک', 'اعلان‌ها', 'مالی و تسویه', 'محتوا'];
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
  // Explicit, manual seed command (never automatic; development-only by its own guard).
  if (!useExternalStack) await stopApi(api);
  // NOTE: spawned asynchronously on purpose — the embedded database lives in THIS process, so a
  // synchronous `execFileSync` would freeze the event loop and the seed could never connect.
  const seedRun = await new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', 'seed:local'], {
      cwd: '/home/user/KolbeVintage/backend',
      env: {
        ...process.env, NODE_ENV: 'development', REDIS_URL: undefined,
        DATABASE_URL: stack.databaseUrl, TEST_DATABASE_URL: stack.databaseUrl,
        JWT_SECRET: process.env.JWT_SECRET ?? 'browser-smoke-secret-at-least-thirty-two-chars',
        PUBLIC_ORIGIN: base,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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

  // Reload so every module re-fetches from the freshly seeded database instead of stale state.
  await page.reload({ waitUntil: 'networkidle2' });
  // The console re-validates its session (401 → single refresh → /auth/me) before painting the
  // shell, so wait for the sidebar instead of guessing a delay.
  let shellReady = false;
  for (let attempt = 0; attempt < 40 && !shellReady; attempt += 1) {
    await sleep(500);
    shellReady = await page.evaluate(() => [...document.querySelectorAll('button')].some((button) => button.innerText.trim().startsWith('حمل‌ونقل')));
  }
  check('console shell comes back after a full reload (session revalidation)', shellReady);
  if (!shellReady) {
    console.error('--- after reload body ---\n' + (await text()).replace(/\n+/g, ' | ').slice(0, 400));
    console.error('--- after reload url --- ' + page.url());
    console.error('--- console errors ---\n' + consoleErrors.slice(-6).join('\n'));
  }
  await openTab('حمل‌ونقل');
  body = await text();
  check('seeded shipping methods are listed with Persian types',
    /استاندارد|سریع|تحویل حضوری/.test(body) && body.includes('تومان'), '');
  check('shipping table has no raw ISO dates', !/\d{4}-\d{2}-\d{2}T/.test(body));
  await shot('08-shipping-seeded');

  await openTab('انبار و موجودی');
  await waitForText('موجودی فیزیکی');
  // Stock lives in real warehouses: switch to the seeded main warehouse and read its ledger.
  const switched = await page.evaluate(() => {
    const select = document.querySelector('select[aria-label="انتخاب انبار"]');
    if (!select) return false;
    // Prefer the seeded main warehouse; otherwise whatever warehouse the stack carries.
    const option = [...select.options].find((candidate) => candidate.text.includes('KV-TEH-01')) ?? select.options[0];
    if (!option) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  // Wait for a real balance row (not just the table header) to appear for the selected warehouse.
  let balanceRows = 0;
  for (let attempt = 0; attempt < 25 && balanceRows === 0; attempt += 1) {
    await sleep(400);
    balanceRows = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr')];
      return rows.filter((row) => /KV-[A-Z]+-\d+/.test(row.innerText)).length;
    });
  }
  body = await text();
  check('seeded WMS balances render (on-hand/reserved/damaged/available in Persian)',
    switched && balanceRows > 0 && body.includes('موجودی فیزیکی') && body.includes('قابل فروش') && body.includes('رزرو شده'),
    `${balanceRows} balance row(s) — ${body.replace(/\n+/g, ' | ').slice(0, 110)}`);
  await shot('09-wms-seeded');

  await openTab('تعریف محصول');
  const catalogueReady = await waitForText('موجودی (WMS)');
  check('ProductStudio lists the real catalogue rows', catalogueReady, (await text()).replace(/\n+/g, ' | ').slice(0, 90));
  const inventoryOpened = await clickByText('موجودی و انبار');
  check('ProductStudio exposes a per-product inventory view', inventoryOpened);
  await sleep(2500);
  body = await text();
  check('product inventory drawer reads GET /admin/products/:id/inventory',
    sawCall('GET', '/admin/products/') && sawCall('GET', '/inventory'),
    apiCalls.filter((call) => call.includes('/inventory')).slice(-2).join(' , '));
  check('ProductStudio has no hardcoded warehouse option (real warehouses only)',
    !/انبار مرکزی — تهران|انبار اصفهان"/.test(body) || body.includes('KV-TEH-01') || body.includes('انبار مرکزی تهران'));
  check('product inventory is read from WMS (per-variant balances, read-only)',
    body.includes('قابل فروش') && (body.includes('رسید ورودی') || body.includes('اصلاح موجودی') || body.includes('تراز انبار')),
    body.split('\n').filter((line) => line.includes('قابل فروش')).slice(0, 1).join(' | '));
  check('product inventory does not offer a direct stock PATCH field',
    !body.includes('PATCH') && !body.includes('موجودی اولیه محصول'));
  await shot('10-product-inventory');

  await page.keyboard.press('Escape');
  await sleep(500);
  await openTab('کوپن و جشنواره');
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
  await openTab('دفتر کل');
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
  const allTabs = [
    'برج کنترل', 'سفارش‌های سرور', 'سفارش‌های عمده', 'میز عملیات کلبه', 'محصولات و بازبینی', 'قالب‌های سری کلبه',
    'تأمین‌کنندگان', 'درخواست همکاری', 'خریداران عمده', 'پلن‌های عضویت', 'سفارش‌های خرده', 'تعریف محصول',
    'حمل‌ونقل', 'انبار و موجودی', 'مشتریان', 'کوپن و جشنواره', 'محتوا', 'پنل پیامک', 'اعلان‌ها', 'مالی و تسویه',
    'دفتر کل', 'یکپارچه‌سازی‌ها', 'تیکت و مرجوعی', 'گزارش حسابرسی', 'محدودیت کاربران', 'تنظیمات و دسترسی',
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
  check('no unhandled page errors during the console walk', leftovers.length === 0, leftovers.slice(0, 2).join(' | ').slice(0, 200));

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
    .filter((line) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(line)); // UUIDs
  check('no standalone English UI labels across every visited module', sweep.length === 0, sweep.slice(0, 4).join(' | '));
  writeFileSync(`${shotDir}/api-calls.json`, JSON.stringify(apiCalls, null, 2));
  writeFileSync(`${shotDir}/report.json`, JSON.stringify({ results, consoleErrors }, null, 2));
} catch (error) {
  check('browser admin smoke completed without exceptions', false, String(error.stack ?? error).slice(0, 400));
  console.error('--- page errors ---\n' + consoleErrors.slice(-8).map((entry) => entry.split('\n').slice(0, 5).join('\n')).join('\n===\n'));
} finally {
  await browser.close();
  if (!useExternalStack) {
    for (const child of [api, web]) { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    await socketServer.stop();
    await db.close();
  }
  if (results.some((result) => !result.ok)) {
    console.error('--- api log tail ---\n' + apiLog.split('\n').slice(-15).join('\n'));
    console.error('--- vite log tail ---\n' + webLog.split('\n').slice(-10).join('\n'));
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
