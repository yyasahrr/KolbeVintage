/** Run after local-stack.mjs and seed:local. Checks persisted demo data and public UI. */
import assert from 'node:assert/strict';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const origin = process.env.KV_WEB ?? 'http://127.0.0.1:5173';
const api = process.env.KV_API ?? 'http://127.0.0.1:4000';
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://127.0.0.1:55449/pglite';
const browser = await puppeteer.launch({ executablePath: process.env.KV_CHROME_PATH ?? '/tmp/chromium', headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const counts = (await client.query(`SELECT
    (SELECT count(*)::int FROM users WHERE email LIKE 'demo.%@example.test') AS demo_customers,
    (SELECT count(*)::int FROM supplier_profiles WHERE cooperation_status='approved') AS suppliers,
    (SELECT count(*)::int FROM products WHERE status='published') AS products,
    (SELECT count(*)::int FROM orders) AS orders,
    (SELECT count(*)::int FROM editorial_posts WHERE status='published') AS articles,
    (SELECT count(*)::int FROM customer_reviews WHERE status='approved') AS reviews,
    (SELECT count(*)::int FROM cms_categories c WHERE c.active AND NOT EXISTS
      (SELECT 1 FROM products p WHERE p.category=c.name AND p.status='published' AND p.owner_type='kolbe' AND p.retail_enabled)) AS empty_categories`)).rows[0];
  assert.ok(counts.demo_customers >= 3, JSON.stringify(counts));
  assert.ok(counts.suppliers >= 2, JSON.stringify(counts));
  assert.ok(counts.products >= 13, JSON.stringify(counts));
  assert.ok(counts.orders >= 5, JSON.stringify(counts));
  assert.ok(counts.articles >= 4, JSON.stringify(counts));
  assert.ok(counts.reviews >= 4, JSON.stringify(counts));
  assert.equal(counts.empty_categories, 0, JSON.stringify(counts));

  const catalog = await (await fetch(`${api}/api/v1/products?limit=100`)).json();
  assert.ok(catalog.items.length >= 11);
  assert.ok(catalog.items.every((item) => item.available > 0 && item.metadata?.images?.[0]?.url));
  const categories = await (await fetch(`${api}/api/v1/site/categories`)).json();
  assert.ok(categories.items.every((item) => item.image_url), 'all visible categories have photos');
  const editorial = await (await fetch(`${api}/api/v1/public/editorial`)).json();
  assert.ok(editorial.items.some((item) => item.slug === 'autumn-trench-guide'));

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('پیراهن آکسفورد سفید'), { timeout: 20000 });
  assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('بلیزر فراسو'), 'wholesale-only products stay off the retail home');
  const hero = await page.$('[data-component="hero"] img');
  assert.ok(hero, 'seeded home hero image is visible');
  await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="ناوبری اصلی"] button')].find((button) => button.textContent?.includes('مجله'))?.click());
  await page.waitForFunction(() => document.body.innerText.includes('چطور یک ترنچ‌کت ماندگار انتخاب کنیم؟'), { timeout: 20000 });
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('article')].find((item) => item.textContent?.includes('چطور یک ترنچ‌کت ماندگار انتخاب کنیم؟'));
    [...(card?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.includes('خواندن'))?.click();
  });
  await page.waitForFunction(() => document.body.innerText.includes('ترنچ‌کت خوب از پارچه‌ای شروع می‌شود'), { timeout: 15000 });
  console.log(`PASS demo content: ${JSON.stringify(counts)}, ${catalog.items.length} retail products, journal article opens`);
} finally {
  await client.end();
  await browser.close();
}
