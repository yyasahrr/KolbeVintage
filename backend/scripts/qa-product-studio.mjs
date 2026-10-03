/* Corrective phase K2 — Product Studio browser QA (§91/§92/§93).
   Uses the RUNNING stack (API :4000 + vite :5173 + PGlite :55449). Screenshots → /tmp/kv-studio-shots.
   Run: LD_LIBRARY_PATH=/tmp/chromedeps/lib:/tmp/chromedeps KV_CHROME_PATH=/tmp/chromium node scripts/qa-product-studio.mjs */
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import pg from 'pg';

const WEB = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const API = process.env.KV_API ?? 'http://127.0.0.1:4000';
const SHOTS = '/tmp/kv-studio-shots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:55449/pglite' });
await db.connect();
const count = async (sql) => Number((await db.query(sql)).rows[0].n);

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

try {
  /* ---------- login to the admin console ---------- */
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

  /* ---------- navigate: انبار و نقل‌وانتقالات → کالاها → تعریف محصول ---------- */
  await clickText('button, a', 'انبار و نقل‌وانتقالات');
  await sleep(1500);
  check('کالاها hub reachable', await waitText('تعریف محصول'));

  /* §93 baseline: inventory truth BEFORE definition */
  const movesBefore = await count('SELECT count(*)::int AS n FROM stock_movements');
  const receiptsBefore = await count('SELECT count(*)::int AS n FROM stock_receipts');

  await clickText('button', 'تعریف محصول جدید');
  await sleep(1200);
  await shot('studio-open');
  /* §92/§4: inspect the STUDIO stepper + fields (the hub's explanatory copy legitimately
     mentions «موجودی اولیه» while describing the Needs-Setup boundary). */
  const studioProbe = await page.evaluate(() => {
    const steps = [...document.querySelectorAll('button')].map((b) => b.textContent ?? '');
    const labels = [...document.querySelectorAll('label span')].map((n) => n.textContent ?? '');
    return {
      stockStep: steps.some((t) => t.includes('موجودی اولیه')),
      typeField: labels.some((t) => t.trim() === 'نوع محصول'),
      warehouseField: labels.some((t) => t.includes('انبار مقصد')),
    };
  });
  check('§92 no «نوع محصول» field in new Product Studio', !studioProbe.typeField);
  check('§4 no «موجودی اولیه» step in stepper', !studioProbe.stockStep);
  check('§4 no warehouse selector in Product Studio', !studioProbe.warehouseField);

  /* ---------- fill the definition ---------- */
  const name = `کت QA اصلاحی ${Date.now() % 100000}`;
  const typeIntoField = async (labelNeedle, value) => {
    const handle = await page.evaluateHandle((needle) => {
      const label = [...document.querySelectorAll('label')].find((l) => (l.querySelector('span')?.textContent ?? '').includes(needle));
      return label?.querySelector('input') ?? null;
    }, labelNeedle);
    const el = handle.asElement();
    if (!el) return false;
    await el.click({ clickCount: 3 }); await el.type(value);
    return true;
  };
  check('name field located', await typeIntoField('نام محصول', name));
  await sleep(300);

  /* media: upload a tiny real PNG through the hidden file input */
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNgYGD4z4AGMIUGUgAAHhYD/0Z320IAAAAASUVORK5CYII=', 'base64');
  writeFileSync('/tmp/qa-studio.png', png);
  await clickText('button', 'تصویر و ویدیو');
  await sleep(600);
  const fileInput = await page.$('input[type=file]');
  if (fileInput) await fileInput.uploadFile('/tmp/qa-studio.png');
  await sleep(1500);

  /* pricing (toman) */
  await clickText('button', 'قیمت‌گذاری');
  await sleep(600);
  check('price field located', await typeIntoField('قیمت پایه خرده', '450000'));
  await sleep(300);

  /* switch wholesale OFF so series completeness never blocks this scenario */
  await clickText('button', 'سری‌های عمده');
  await sleep(600);
  const wholesaleOn = await page.evaluate(() => document.body.innerText.includes('فروش در بازارچه عمده'));
  if (wholesaleOn) {
    await page.evaluate(() => {
      // deepest container of the wholesale toggle row → its Switch button
      const rows = [...document.querySelectorAll('div')].filter((n) => n.textContent?.includes('فروش در بازارچه عمده') && n.querySelector('button'));
      const row = rows[rows.length - 1];
      row?.querySelector('button')?.click();
    });
    await sleep(500);
  }

  /* save */
  const issuesLine = await page.evaluate(() => {
    const el = [...document.querySelectorAll('p')].find((n) => n.textContent?.includes('برای انتشار تکمیل کنید'));
    return el?.textContent ?? '';
  });
  if (issuesLine) console.log('ISSUES:', issuesLine);
  await shot('before-save');
  const saved = await clickText('button', 'ذخیره و انتشار');
  check('save button enabled & clicked', saved);
  const summaryShown = await waitText('محصول با موفقیت تعریف شد', 40);
  await shot('studio-summary');
  check('§44 post-create summary shown', summaryShown);
  const summaryText = await text();
  check('§44 summary says «نیازمند راه‌اندازی»', summaryText.includes('نیازمند راه‌اندازی'));

  /* ---------- §93 inventory boundary: counts unchanged ---------- */
  const movesAfter = await count('SELECT count(*)::int AS n FROM stock_movements');
  const receiptsAfter = await count('SELECT count(*)::int AS n FROM stock_receipts');
  check('§93 stock_movements unchanged by product create', movesAfter === movesBefore, `${movesBefore} → ${movesAfter}`);
  check('§93 stock_receipts unchanged by product create', receiptsAfter === receiptsBefore, `${receiptsBefore} → ${receiptsAfter}`);

  /* DB truth: product exists, pending setup, kolbe-owned, NO product type */
  const row = (await db.query('SELECT inventory_setup, owner_type, product_type_id, supplier_id FROM products WHERE name = $1', [name])).rows[0];
  check('product persisted', Boolean(row));
  check('§43 inventory_setup = pending', row?.inventory_setup === 'pending', row?.inventory_setup);
  check('§6 owner_type = kolbe (server-enforced)', row?.owner_type === 'kolbe' && row?.supplier_id === null, row?.owner_type);
  check('§92 created WITHOUT product_type_id', row?.product_type_id === null);

  /* ---------- summary CTA → Needs Setup workspace lists the product ---------- */
  await clickText('button', 'رفتن به راه‌اندازی موجودی');
  await sleep(1200);
  const needsSetup = await waitText(name, 25);
  await shot('needs-setup');
  check('§91 product appears in «نیازمند راه‌اندازی»', needsSetup);
} finally {
  await browser.close();
  await db.end();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1); }
