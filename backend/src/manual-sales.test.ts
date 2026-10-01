import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4031, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

async function setup(app: Awaited<ReturnType<typeof buildApp>>, pool: ReturnType<typeof createPool>, suffix: string) {
  const adminId = randomUUID();
  await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
    [adminId, `ms-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Manual sale admin']);
  await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
    payload: { identity: `ms-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
  assert.equal(login.statusCode, 200, login.body);
  const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

  const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers,
    payload: { code: `MS${suffix.replace(/-/g, '').slice(0, 6).toUpperCase()}`, name: `انبار فروش دستی ${suffix}` } });
  assert.equal(warehouse.statusCode, 201, warehouse.body);
  const warehouseId = warehouse.json().id as string;

  const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers, payload: {
    brand: 'Kolbe', name: `محصول فروش دستی ${suffix}`, category: 'پیراهن', cashPriceRial: '2500000',
    variants: [{ size: 'M', color: 'مشکی' }, { size: 'L', color: 'مشکی' }],
  } });
  assert.equal(product.statusCode, 201, product.body);
  const variants = product.json().variants as { id: string; sku: string }[];
  for (const variant of variants) {
    await pool.query('INSERT INTO stock_balances(variant_id,warehouse_id,on_hand) VALUES ($1,$2,10)', [variant.id, warehouseId]);
  }
  return { adminId, headers, warehouseId, productId: product.json().id as string, variants };
}

const onHand = async (pool: ReturnType<typeof createPool>, variantId: string, warehouseId: string) =>
  Number((await pool.query('SELECT on_hand FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2', [variantId, warehouseId])).rows[0].on_hand);

test('manual sale is a real sale: channels, stock consumption, audit — not an adjustment', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers, warehouseId, variants } = await setup(app, pool, suffix);

    // Cash sale on Instagram completes immediately and consumes stock.
    const sale = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `ms-${suffix}-1` },
      payload: { channel: 'instagram', warehouseId, customerName: 'مشتری اینستاگرام', customerPhone: '09120000001',
        lines: [{ variantId: variants[0]!.id, quantity: 2, unitPriceRial: '2500000' }],
        payment: { method: 'cash', amountRial: '5000000' } } });
    assert.equal(sale.statusCode, 201, sale.body);
    assert.equal(sale.json().status, 'completed');
    assert.match(sale.json().reference as string, /^MS-\d+$/);
    assert.equal(sale.json().channel, 'instagram');
    assert.equal(await onHand(pool, variants[0]!.id, warehouseId), 8);

    // Inventory left through an append-only movement that references the sale.
    const movement = await pool.query(
      `SELECT reason, reference_type, on_hand_delta FROM stock_movements WHERE reference_type = 'manual_sale' AND reference_id = $1`,
      [sale.json().id]);
    assert.equal(movement.rows.length, 1);
    assert.equal(movement.rows[0].reason, 'manual sale');
    assert.equal(Number(movement.rows[0].on_hand_delta), -2);

    // Idempotent replay returns the same sale without double-consuming stock.
    const replay = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `ms-${suffix}-1` },
      payload: { channel: 'instagram', warehouseId, customerName: 'مشتری اینستاگرام', customerPhone: '09120000001',
        lines: [{ variantId: variants[0]!.id, quantity: 2, unitPriceRial: '2500000' }],
        payment: { method: 'cash', amountRial: '5000000' } } });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().id, sale.json().id);
    assert.equal(await onHand(pool, variants[0]!.id, warehouseId), 8);

    // An inventory adjustment stays an adjustment: no manual_sales row appears.
    const before = await pool.query('SELECT count(*)::int AS n FROM manual_sales');
    const adjust = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments', headers: { ...headers, 'idempotency-key': `adj-${suffix}-1` },
      payload: { variantId: variants[0]!.id, warehouseId, delta: -1, reason: 'شکستگی در انبار', reference: `ADJ-${suffix}` } });
    assert.equal(adjust.statusCode, 201, adjust.body);
    const after = await pool.query('SELECT count(*)::int AS n FROM manual_sales');
    assert.equal(after.rows[0].n, before.rows[0].n, 'adjustment must not create a sale');
    const adjMove = await pool.query(
      `SELECT reference_type FROM stock_movements WHERE variant_id = $1 ORDER BY created_at DESC LIMIT 1`, [variants[0]!.id]);
    assert.equal(adjMove.rows[0].reference_type, 'adjustment');

    // Insufficient sellable stock is refused atomically.
    const tooMany = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `ms-${suffix}-2` },
      payload: { channel: 'in_person', warehouseId,
        lines: [{ variantId: variants[0]!.id, quantity: 999, unitPriceRial: '2500000' }],
        payment: { method: 'cash', amountRial: '2497500000' } } });
    assert.equal(tooMany.statusCode, 409, tooMany.body);
    assert.equal(await onHand(pool, variants[0]!.id, warehouseId), 7);

    // Payment total must match the sale total.
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `ms-${suffix}-3` },
      payload: { channel: 'phone', warehouseId,
        lines: [{ variantId: variants[1]!.id, quantity: 1, unitPriceRial: '2500000' }],
        payment: { method: 'cash', amountRial: '100' } } });
    assert.equal(mismatch.statusCode, 400, mismatch.body);

    // RBAC: a plain customer cannot record manual sales.
    const customerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [customerId, `ms-cust-${suffix}@example.test`, await argon2.hash('CustomerPass12345!'), 'Customer']);
    const customerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `ms-cust-${suffix}@example.test`, password: 'CustomerPass12345!' } });
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales',
      headers: { authorization: `Bearer ${customerLogin.json().accessToken as string}`, 'idempotency-key': `ms-${suffix}-4` },
      payload: { channel: 'other', warehouseId,
        lines: [{ variantId: variants[1]!.id, quantity: 1, unitPriceRial: '2500000' }],
        payment: { method: 'cash', amountRial: '2500000' } } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('card-to-card payment: pending verification, verify completes, reject returns stock', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers, warehouseId, variants } = await setup(app, pool, suffix);

    // Card-to-card without a trace code is refused.
    const noTrace = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `cc-${suffix}-0` },
      payload: { channel: 'whatsapp', warehouseId,
        lines: [{ variantId: variants[0]!.id, quantity: 1, unitPriceRial: '2500000' }],
        payment: { method: 'card_to_card', amountRial: '2500000' } } });
    assert.equal(noTrace.statusCode, 400, noTrace.body);

    // Pending card-to-card sale consumes stock but awaits verification.
    const sale = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `cc-${suffix}-1` },
      payload: { channel: 'telegram', warehouseId, customerName: 'مشتری تلگرام',
        lines: [{ variantId: variants[0]!.id, quantity: 3, unitPriceRial: '2000000' }],
        payment: { method: 'card_to_card', amountRial: '6000000', reference: `TRACE-${suffix}`, note: 'کارت‌به‌کارت ملت' } } });
    assert.equal(sale.statusCode, 201, sale.body);
    assert.equal(sale.json().status, 'pending_verification');
    assert.equal(sale.json().payment.verificationStatus, 'pending_verification');
    assert.equal(await onHand(pool, variants[0]!.id, warehouseId), 7);

    // Verify -> sale completed, payment verified with verifier identity.
    const verify = await app.inject({ method: 'POST',
      url: `/api/v1/admin/manual-sales/${sale.json().id}/payments/${sale.json().payment.id}/verification`,
      headers, payload: { action: 'verify', note: 'رسید بانکی تطبیق شد' } });
    assert.equal(verify.statusCode, 200, verify.body);
    assert.equal(verify.json().status, 'completed');
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/manual-sales/${sale.json().id}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().status, 'completed');
    assert.equal(detail.json().payments[0].verification_status, 'verified');
    assert.ok(detail.json().payments[0].verified_by);
    assert.ok(detail.json().completed_at);

    // Double verification is refused.
    const again = await app.inject({ method: 'POST',
      url: `/api/v1/admin/manual-sales/${sale.json().id}/payments/${sale.json().payment.id}/verification`,
      headers, payload: { action: 'verify' } });
    assert.equal(again.statusCode, 409, again.body);

    // Rejecting another pending sale cancels it and returns the stock.
    const second = await app.inject({ method: 'POST', url: '/api/v1/admin/manual-sales', headers: { ...headers, 'idempotency-key': `cc-${suffix}-2` },
      payload: { channel: 'phone', warehouseId,
        lines: [{ variantId: variants[1]!.id, quantity: 4, unitPriceRial: '1500000' }],
        payment: { method: 'card_to_card', amountRial: '6000000', reference: `TRACE2-${suffix}` } } });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(await onHand(pool, variants[1]!.id, warehouseId), 6);
    const reject = await app.inject({ method: 'POST',
      url: `/api/v1/admin/manual-sales/${second.json().id}/payments/${second.json().payment.id}/verification`,
      headers, payload: { action: 'reject', note: 'واریز پیدا نشد' } });
    assert.equal(reject.statusCode, 200, reject.body);
    assert.equal(reject.json().status, 'cancelled');
    assert.equal(await onHand(pool, variants[1]!.id, warehouseId), 10);
    const compensation = await pool.query(
      `SELECT count(*)::int AS n FROM stock_movements WHERE reference_type = 'manual_sale' AND reference_id = $1 AND on_hand_delta > 0`,
      [second.json().id]);
    assert.equal(compensation.rows[0].n, 1, 'stock must return through an append-only movement');

    // List: server-side channel filter, search and the channel breakdown.
    const byChannel = await app.inject({ method: 'GET', url: '/api/v1/admin/manual-sales?channel=telegram&search=تلگرام', headers });
    assert.equal(byChannel.statusCode, 200, byChannel.body);
    assert.ok(byChannel.json().items.length >= 1);
    assert.ok(byChannel.json().items.every((item: { channel: string }) => item.channel === 'telegram'));
    assert.equal(typeof byChannel.json().total, 'number');
    const breakdown = byChannel.json().channels as { channel: string; sales: number }[];
    assert.ok(breakdown.find((row) => row.channel === 'telegram'));
    const byStatus = await app.inject({ method: 'GET', url: '/api/v1/admin/manual-sales?status=cancelled', headers });
    assert.ok(byStatus.json().items.every((item: { status: string }) => item.status === 'cancelled'));
  } finally {
    await app.close();
    await pool.end();
  }
});

test('admin user directory: server-side search, filters and pagination', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers } = await setup(app, pool, suffix);

    // Three customers: one with orders + address, one suspended, one plain.
    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,phone,email,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)',
      [buyerId, `0912${suffix.replace(/\D/g, '9').slice(0, 7)}`, `dir-buyer-${suffix}@example.test`, await argon2.hash('BuyerPass12345678!'), `خریدار دایرکتوری ${suffix}`]);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [buyerId, 'customer']);
    await pool.query(`INSERT INTO customer_addresses(id,user_id,title,recipient,phone,province,city,line,postal_code,is_default)
      VALUES ($1,$2,'خانه','خریدار','09120000000','تهران','تهران','خیابان آزادی','1111111111',true)`, [randomUUID(), buyerId]);
    await pool.query(`INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial)
      VALUES ($1,$2,$3,'retail','cash','paid',30000000,30000000)`, [randomUUID(), `ORD-DIR-${suffix}-1`, buyerId]);
    await pool.query(`INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,status,subtotal_rial,total_rial)
      VALUES ($1,$2,$3,'retail','cash','cancelled',5000000,5000000)`, [randomUUID(), `ORD-DIR-${suffix}-2`, buyerId]);
    const suspendedId = randomUUID();
    await pool.query("INSERT INTO users(id,email,password_hash,display_name,status) VALUES ($1,$2,$3,$4,'suspended')",
      [suspendedId, `dir-susp-${suffix}@example.test`, await argon2.hash('SuspPass123456789!'), `معلق دایرکتوری ${suffix}`]);

    // Search by display name is server-side.
    const byName = await app.inject({ method: 'GET', url: `/api/v1/admin/users?search=${encodeURIComponent(`خریدار دایرکتوری ${suffix}`)}`, headers });
    assert.equal(byName.statusCode, 200, byName.body);
    assert.equal(byName.json().total, 1);
    const found = byName.json().items[0];
    assert.equal(found.id, buyerId);
    assert.equal(found.order_count, 2);
    assert.equal(found.total_spent_rial, '30000000', 'cancelled orders stay out of the spend total');
    assert.equal(found.city, 'تهران');
    assert.ok((found.roles as string[]).includes('customer'));
    assert.ok(found.last_order_at);

    // Search by exact user id.
    const byId = await app.inject({ method: 'GET', url: `/api/v1/admin/users?search=${buyerId}`, headers });
    assert.equal(byId.json().total, 1);

    // Status + role + purchase filters are applied by the server.
    const suspended = await app.inject({ method: 'GET', url: `/api/v1/admin/users?status=suspended&search=${encodeURIComponent(suffix)}`, headers });
    assert.equal(suspended.json().total, 1);
    assert.equal(suspended.json().items[0].id, suspendedId);
    const bigSpenders = await app.inject({ method: 'GET', url: `/api/v1/admin/users?minSpentRial=20000000&minOrders=2&role=customer&search=${encodeURIComponent(suffix)}`, headers });
    assert.equal(bigSpenders.json().total, 1);
    assert.equal(bigSpenders.json().items[0].id, buyerId);
    const noMatches = await app.inject({ method: 'GET', url: `/api/v1/admin/users?minSpentRial=999999999999&search=${encodeURIComponent(suffix)}`, headers });
    assert.equal(noMatches.json().total, 0);

    // Pagination metadata + page size are honoured.
    const page = await app.inject({ method: 'GET', url: '/api/v1/admin/users?limit=2&offset=0', headers });
    assert.equal(page.json().items.length, 2);
    assert.ok(page.json().total >= 3);
    const next = await app.inject({ method: 'GET', url: '/api/v1/admin/users?limit=2&offset=2', headers });
    assert.notEqual(page.json().items[0].id, next.json().items[0]?.id);

    // RBAC: the directory needs users:manage.
    const plainId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [plainId, `dir-plain-${suffix}@example.test`, await argon2.hash('PlainPass123456789!'), 'Plain']);
    const plainLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `dir-plain-${suffix}@example.test`, password: 'PlainPass123456789!' } });
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${plainLogin.json().accessToken as string}` } });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('product structure: persisted colors, variant matrix cells and admin product detail', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers, warehouseId, productId, variants } = await setup(app, pool, suffix);

    // Req 30: inline color creation persists through the API and survives reload.
    const color = await app.inject({ method: 'POST', url: '/api/v1/admin/product-colors', headers,
      payload: { name: `قهوه‌ای کاراملی ${suffix}`, hex: '#8A5A2B' } });
    assert.equal(color.statusCode, 201, color.body);
    const colors = await app.inject({ method: 'GET', url: '/api/v1/product-colors' });
    assert.equal(colors.statusCode, 200, colors.body);
    assert.ok((colors.json().items as { name: string }[]).some((item) => item.name === `قهوه‌ای کاراملی ${suffix}`));
    const dupe = await app.inject({ method: 'POST', url: '/api/v1/admin/product-colors', headers,
      payload: { name: `قهوه‌ای کاراملی ${suffix}`, hex: '#8A5A2B' } });
    assert.equal(dupe.statusCode, 409, dupe.body);

    // Req 26/32: enabling a blank matrix cell creates a real variant with a server SKU…
    const created = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { size: 'XL', color: 'مشکی' } });
    assert.equal(created.statusCode, 201, created.body);
    assert.match(created.json().sku as string, /^KV-/);
    // …duplicate cells are refused…
    const dupCell = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/variants`, headers,
      payload: { size: 'XL', color: 'مشکی' } });
    assert.equal(dupCell.statusCode, 409, dupCell.body);
    // …and disabling keeps the variant but marks it inactive (distinct from stock 0).
    const disabled = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/variants/${variants[1]!.id}`, headers,
      payload: { active: false } });
    assert.equal(disabled.statusCode, 200, disabled.body);

    // Req 38: the admin detail loads full server data including inactive variants.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    const all = detail.json().variants as { id: string; active: boolean; available: number }[];
    assert.equal(all.length, 3);
    const inactive = all.find((v) => v.id === variants[1]!.id);
    assert.equal(inactive?.active, false);
    const zeroStock = all.find((v) => v.id === created.json().id);
    assert.equal(zeroStock?.active, true);
    assert.equal(zeroStock?.available, 0, 'a fresh enabled cell has stock 0, not “missing”');
    assert.ok(warehouseId);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('variant price override drives retail pricing (Req 25)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const { headers, productId, variants } = await setup(app, pool, suffix);
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [productId]);

    // Set the override on one variant only — integer RIAL, persisted on the variant row.
    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/variants/${variants[0]!.id}`, headers,
      payload: { priceOverrideRial: '3000000' } });
    assert.equal(patched.statusCode, 200, patched.body);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers });
    const rows = detail.json().variants as { id: string; price_override_rial: string | null }[];
    assert.equal(rows.find((v) => v.id === variants[0]!.id)?.price_override_rial, '3000000');
    assert.equal(rows.find((v) => v.id === variants[1]!.id)?.price_override_rial, null);

    // A real retail checkout prices the overridden variant at the override, the sibling at the base price.
    const customerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [customerId, `ov-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'Override buyer']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [customerId, 'customer']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `ov-buyer-${suffix}@example.test`, password: 'BuyerPassword123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { authorization: `Bearer ${login.json().accessToken as string}`, 'idempotency-key': `ov-${suffix}-1234` },
      payload: {
        orderType: 'retail', paymentMode: 'cash',
        items: [{ variantId: variants[0]!.id, quantity: 2 }, { variantId: variants[1]!.id, quantity: 1 }],
        shippingAddress: { recipient: 'خریدار تست', phone: '09123456789', province: 'تهران', city: 'تهران',
          line: 'خیابان آزادی، پلاک ۱۰، واحد ۲', postalCode: '1234567890' },
      } });
    assert.equal(order.statusCode, 201, order.body);
    const orderId = order.json().id as string;
    const lines = await pool.query('SELECT variant_id, unit_price_rial::text FROM order_lines WHERE order_id = $1', [orderId]);
    const byVariant = new Map(lines.rows.map((row) => [row.variant_id as string, row.unit_price_rial as string]));
    assert.equal(byVariant.get(variants[0]!.id), '3000000', 'overridden variant uses the override');
    assert.equal(byVariant.get(variants[1]!.id), '2500000', 'sibling variant keeps the base retail price');

    // Clearing the override returns the variant to the base price.
    const cleared = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/variants/${variants[0]!.id}`, headers,
      payload: { priceOverrideRial: null } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const after = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}`, headers });
    assert.equal((after.json().variants as { id: string; price_override_rial: string | null }[])
      .find((v) => v.id === variants[0]!.id)?.price_override_rial, null);
  } finally {
    await app.close();
    await pool.end();
  }
});
