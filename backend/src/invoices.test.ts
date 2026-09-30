import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4002, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('invoice module computes totals, keeps history, and handles payments', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `inv-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Finance admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `inv-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const created = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers, payload: {
      kind: 'wholesale_sale',
      buyer: { name: 'خریدار عمده', nationalId: '1234567890' },
      seller: { name: 'کلبه وینتج', legalName: 'کلبه وینتج' },
      paymentType: 'transfer',
      lines: [
        { sku: 'KV-ITEM-1', productName: 'کت کرم', quantity: 2, unitPriceRial: '50000000', discountRial: '0', taxRial: '0' },
        { productName: 'شلوار مشکی', quantity: 1, unitPriceRial: '30000000', discountRial: '5000000', taxRial: '0' },
      ],
      discountRial: '5000000', shippingRial: '2000000', servicesFeeRial: '0', dueDate: '2026-12-31',
    } });
    assert.equal(created.statusCode, 201, created.body);
    const invoiceId = created.json().id as string;
    assert.match(created.json().reference as string, /^INV-\d{4}-\d{6}$/);
    // 2*50,000,000 + (30,000,000-5,000,000) = 125,000,000; minus 5,000,000 discount + 2,000,000 shipping
    assert.equal(created.json().totalRial, '122000000');
    assert.equal(created.json().remainingRial, '122000000');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().lines.length, 2);
    assert.equal(detail.json().events.length, 1);
    assert.equal(detail.json().events[0].event_type, 'created');

    // The client cannot tamper with totals: totals come from the lines.
    const journal = await pool.query(
      `SELECT sum(l.debit_rial)::text AS debit, sum(l.credit_rial)::text AS credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.source_id = $1`, [invoiceId]);
    assert.equal(journal.rows[0].debit, journal.rows[0].credit);

    const partial = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoiceId}/payments`, headers,
      payload: { amountRial: '22000000', method: 'transfer', traceCode: 'TR-1' } });
    assert.equal(partial.statusCode, 201, partial.body);
    assert.equal(partial.json().status, 'partially_paid');
    assert.equal(partial.json().remainingRial, '100000000');
    assert.match(partial.json().reference as string, /^TXN-\d{4}-\d{6}$/);

    const tooMuch = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoiceId}/payments`, headers,
      payload: { amountRial: '200000000', method: 'transfer' } });
    assert.equal(tooMuch.statusCode, 409, tooMuch.body);

    const rest = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoiceId}/payments`, headers,
      payload: { amountRial: '100000000', method: 'transfer', traceCode: 'TR-2' } });
    assert.equal(rest.statusCode, 201, rest.body);
    assert.equal(rest.json().status, 'paid');
    assert.equal(rest.json().remainingRial, '0');

    const afterPay = await app.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}`, headers });
    assert.equal(afterPay.json().payments.length, 2);
    assert.equal(afterPay.json().events.length, 3);

    // History rows are immutable.
    await assert.rejects(pool.query('UPDATE invoice_events SET note = $1 WHERE invoice_id = $2', ['tamper', invoiceId]));

    // A revision keeps the previous version and its history.
    const revision = await app.inject({ method: 'POST', url: `/api/v1/invoices/${invoiceId}/revisions`, headers, payload: {
      kind: 'wholesale_sale',
      buyer: { name: 'خریدار عمده', nationalId: '1234567890' },
      seller: { name: 'کلبه وینتج' },
      paymentType: 'transfer',
      lines: [{ productName: 'کت کرم', quantity: 2, unitPriceRial: '48000000' }],
    } });
    assert.equal(revision.statusCode, 201, revision.body);
    const revised = await app.inject({ method: 'GET', url: `/api/v1/invoices/${invoiceId}`, headers });
    assert.equal(revised.json().status, 'revised');
    assert.equal(revised.json().payments.length, 2);
    const oldEvents = revised.json().events as Array<{ event_type: string }>;
    assert.ok(oldEvents.some((event) => event.event_type === 'revised'));

    // Reference numbers stay unique.
    const rows = await pool.query('SELECT count(*)::int AS count, count(DISTINCT reference)::int AS unique_refs FROM invoices');
    assert.equal(rows.rows[0].count, rows.rows[0].unique_refs);
  } finally {
    await app.close();
    await pool.end();
  }
});
