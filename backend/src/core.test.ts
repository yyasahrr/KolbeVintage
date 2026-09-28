import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';
import { rial } from './money.js';
import { ZibalAdapter } from './zibal.js';
import { NextPayAdapter } from './nextpay.js';
import type { DbPool } from './db.js';
import { MeliPayamakSms } from './melipayamak.js';

test('money remains exact above JavaScript safe integer', () => {
  assert.equal(rial('9007199254740993').toString(), '9007199254740993');
  assert.throws(() => rial('1.5'));
  assert.throws(() => rial('-1'));
});

test('Zibal callback checks the provider response, not the callback amount', async () => {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(requests.length === 1
      ? { result: 100, trackId: 123456789 }
      : { result: 100, amount: 50000000, paidAt: '2026-01-01T00:00:00Z' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = new ZibalAdapter('merchant-test', fakeFetch);
  const intentId = randomUUID();
  const checkout = await adapter.createCheckout({ intentId, reference: 'KV-1', amountRial: '50000000',
    returnUrl: 'https://api.example.test/api/v1/payments/callback' });
  assert.equal(checkout.providerReference, '123456789');
  assert.equal(requests[0]?.body.amount, 50000000);
  const verified = await adapter.verifyNotification(Buffer.from(`intentId=${intentId}&trackId=123456789&amount=1`));
  assert.equal(verified.amountRial, '50000000');
  assert.equal(requests[1]?.body.trackId, 123456789);
});

test('NextPay checkout sends the exact rial amount and IRR currency', async () => {
  let sent: Record<string, unknown> = {};
  const transId = randomUUID();
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ code: -1, trans_id: transId }), { status: 200 });
  }) as typeof fetch;
  const adapter = new NextPayAdapter('test-api-key', {} as DbPool, fakeFetch);
  const checkout = await adapter.createCheckout({ intentId: randomUUID(), reference: 'PAY-1',
    amountRial: '50000001', returnUrl: 'https://api.example.test/api/v1/payments/callback' });
  assert.equal(sent.amount, 50000001);
  assert.equal(sent.currency, 'IRR');
  assert.equal(checkout.providerReference, transId);
});

test('MeliPayamak SMS uses the official form endpoint', async () => {
  let sent: URLSearchParams | undefined;
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({ RetStatus: 1, Value: 'receipt-123' }), { status: 200 });
  }) as typeof fetch;
  const sms = new MeliPayamakSms('user', 'password', '5000', fakeFetch);
  assert.equal(await sms.send('09123456789', 'سفارش شما ثبت شد'), 'receipt-123');
  assert.equal(sent?.get('to'), '09123456789');
  assert.equal(sent?.get('text'), 'سفارش شما ثبت شد');
});

test('checkout reserves stock once, payment is idempotent, and shipment consumes stock', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const config: Config = {
    NODE_ENV: 'test', PORT: 4001, DATABASE_URL: process.env.TEST_DATABASE_URL!, REDIS_URL: undefined,
    JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
    PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
  };
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Test admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    const adminToken = login.json().accessToken as string;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders,
      payload: { brand: 'Kolbe', name: 'Test coat', category: 'کت', cashPriceRial: '50000000',
        installmentPriceRial: '52000000', wholesalePriceRial: '40000000', variants: [{ size: 'M', color: 'black' }] } });
    assert.equal(product.statusCode, 201, product.body);
    const productId = product.json().id as string;
    const variantId = product.json().variants[0].id as string;
    const published = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: adminHeaders, payload: { status: 'published' } });
    assert.equal(published.statusCode, 200, published.body);
    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders,
      payload: { code: `TEST-${suffix.toUpperCase()}`, name: 'Test warehouse' } });
    assert.equal(warehouse.statusCode, 201, warehouse.body);
    const warehouseId = warehouse.json().id as string;
    const adjust = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...adminHeaders, 'idempotency-key': `stock-${suffix}` },
      payload: { variantId, warehouseId, delta: 1, reason: 'Opening stock', reference: `TEST-${suffix}` } });
    assert.equal(adjust.statusCode, 201, adjust.body);

    const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: {
      email: `buyer-${suffix}@example.test`, password: 'BuyerPassword123456!', displayName: 'Test buyer',
    } });
    assert.equal(registration.statusCode, 201, registration.body);
    const buyerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {
      identity: `buyer-${suffix}@example.test`, password: 'BuyerPassword123456!',
    } });
    assert.equal(buyerLogin.statusCode, 200, buyerLogin.body);
    const buyerHeaders = { authorization: `Bearer ${buyerLogin.json().accessToken as string}` };
    const payload = { orderType: 'retail', paymentMode: 'four_installments', items: [{ variantId, quantity: 1 }],
      shippingAddress: { recipient: 'Test buyer', phone: '09123456789', province: 'Tehran', city: 'Tehran',
        line: 'Test street number one', postalCode: '1234567890' } };
    const order = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': `order-${suffix}` }, payload });
    assert.equal(order.statusCode, 201, order.body);
    assert.equal(order.json().totalRial, '52000000');
    assert.equal(order.json().status, 'pending_payment');
    const repeat = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': `order-${suffix}` }, payload });
    assert.equal(repeat.json().id, order.json().id);
    const oversell = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...buyerHeaders, 'idempotency-key': `other-${suffix}` }, payload });
    assert.equal(oversell.statusCode, 409, oversell.body);
    const reserved = await pool.query('SELECT on_hand,reserved FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2', [variantId, warehouseId]);
    assert.deepEqual([reserved.rows[0].on_hand, reserved.rows[0].reserved], [1, 1]);

    const payment = { provider: 'verified-test-adapter', providerEventId: `event-${suffix}`, providerReference: `ref-${suffix}`,
      intentId: order.json().paymentIntentId as string, amountRial: '52000000', paidAt: new Date() };
    await pool.query('UPDATE payment_intents SET provider = $2, provider_reference = $3 WHERE id = $1',
      [payment.intentId, payment.provider, payment.providerReference]);
    await assert.rejects(applyVerifiedPayment(pool, { ...payment, amountRial: '50000000' }));
    await assert.rejects(applyVerifiedPayment(pool, { ...payment, providerReference: 'wrong-reference' }));
    const paid = await applyVerifiedPayment(pool, payment);
    assert.equal(paid.status, 'succeeded');
    assert.equal((await applyVerifiedPayment(pool, payment)).duplicate, true);
    const ledger = await pool.query(
      `SELECT sum(l.debit_rial)::text AS debit, sum(l.credit_rial)::text AS credit,
              count(DISTINCT l.entry_id)::integer AS entries
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_id = $1`,
      [payment.intentId]);
    assert.equal(ledger.rows[0].debit, ledger.rows[0].credit);
    assert.equal(ledger.rows[0].entries, 1);
    for (const status of ['processing', 'preparing', 'ready_to_ship', 'in_transit'] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/orders/${order.json().id}/transitions`,
        headers: adminHeaders, payload: { status } });
      assert.equal(response.statusCode, 200, response.body);
    }
    const consumed = await pool.query('SELECT on_hand,reserved FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2', [variantId, warehouseId]);
    assert.deepEqual([consumed.rows[0].on_hand, consumed.rows[0].reserved], [0, 0]);

    const secondProduct = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders,
      payload: { brand: 'Kolbe', name: 'Parallel checkout coat', category: 'کت', cashPriceRial: '9007199254740993',
        variants: [{ size: 'L', color: 'navy' }] } });
    assert.equal(secondProduct.statusCode, 201, secondProduct.body);
    const secondVariantId = secondProduct.json().variants[0].id as string;
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${secondProduct.json().id}/status`, headers: adminHeaders,
      payload: { status: 'published' } });
    const secondStock = await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...adminHeaders, 'idempotency-key': `stock-two-${suffix}` },
      payload: { variantId: secondVariantId, warehouseId, delta: 1, reason: 'Opening stock', reference: `TEST2-${suffix}` } });
    assert.equal(secondStock.statusCode, 201, secondStock.body);
    const secondPayload = { ...payload, paymentMode: 'cash', items: [{ variantId: secondVariantId, quantity: 1 }] };
    const contenders = await Promise.all(['a', 'b'].map((part) => app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `race-${suffix}-${part}` }, payload: secondPayload })));
    assert.deepEqual(contenders.map((item) => item.statusCode).sort(), [201, 409], contenders.map((item) => item.body).join('\n'));
    assert.equal(contenders.find((item) => item.statusCode === 201)?.json().totalRial, '9007199254740993');

    const plan = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: adminHeaders,
      payload: { code: `gold-${suffix}`, title: 'Gold test plan', annualPriceRial: '240000000',
        limits: { sources: 'all', maxOrdersPerMonth: 20, maxOrderValueRial: '1000000000',
          maxSuppliersPerOrder: 5, discountPercent: 3, prioritySupport: true } } });
    assert.equal(plan.statusCode, 201, plan.body);
    const membership = await app.inject({ method: 'POST', url: '/api/v1/memberships',
      headers: { ...buyerHeaders, 'idempotency-key': `member-${suffix}` }, payload: { planId: plan.json().id } });
    assert.equal(membership.statusCode, 201, membership.body);
    const memberPayment = await applyVerifiedPayment(pool, { provider: 'verified-test-adapter',
      providerEventId: `member-event-${suffix}`, providerReference: `member-ref-${suffix}`,
      intentId: membership.json().paymentIntentId, amountRial: '240000000', paidAt: new Date() });
    assert.equal(memberPayment.status, 'succeeded');
    const active = await pool.query('SELECT status FROM memberships WHERE id = $1', [membership.json().membershipId]);
    assert.equal(active.rows[0].status, 'active');

    const ticket = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: buyerHeaders,
      payload: { subject: 'Order issue', category: 'shipping', priority: 'high', orderId: order.json().id,
        message: 'Please check my shipment status.' } });
    assert.equal(ticket.statusCode, 201, ticket.body);
    const reply = await app.inject({ method: 'POST', url: `/api/v1/tickets/${ticket.json().id}/messages`, headers: adminHeaders,
      payload: { message: 'We are checking it now.' } });
    assert.equal(reply.statusCode, 201, reply.body);
    const ticketDetail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.json().id}`, headers: buyerHeaders });
    assert.equal(ticketDetail.json().messages.length, 2);
  } finally { await app.close(); await pool.end(); }
});
