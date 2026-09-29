import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { applyVerifiedPayment } from './payments.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4005, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('plans grant permissions, enforce limits and activate after verified payment', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `p-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `p-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    // A plan is more than a title: limits, features and permissions are stored.
    const plan = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: adminHeaders, payload: {
      code: `pro-${suffix}`, title: 'پلن حرفه‌ای', description: 'دسترسی عمده با سقف بالا',
      annualPriceRial: '1200000000',
      limits: { sources: 'all', maxOrdersPerMonth: 4, maxOrderValueRial: '9000000000',
        minOrderValueRial: '100000000', maxSuppliersPerOrder: 3, maxOrderLines: 2,
        maxQuantityPerLine: 50, discountPercent: 5, prioritySupport: true, installmentAccess: false },
      features: ['priority_support', 'reports'], permissions: ['plans:read'],
    } });
    assert.equal(plan.statusCode, 201, plan.body);

    // Buyer purchases the plan; the membership stays pending until payment.
    const buyerId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [buyerId, `p-buyer-${suffix}@example.test`, await argon2.hash('BuyerPassword123456!'), 'Buyer']);
    const buyerLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `p-buyer-${suffix}@example.test`, password: 'BuyerPassword123456!' } });
    const buyerHeaders = { authorization: `Bearer ${buyerLogin.json().accessToken as string}` };
    const membership = await app.inject({ method: 'POST', url: '/api/v1/memberships',
      headers: { ...buyerHeaders, 'idempotency-key': `mem-${suffix}` }, payload: { planId: plan.json().id } });
    assert.equal(membership.statusCode, 201, membership.body);
    assert.equal(membership.json().status, 'pending_payment');
    const pending = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyerHeaders });
    assert.equal(pending.json().membership, null);

    // Verified payment activates the plan automatically (no manual approval).
    const intentId = membership.json().paymentIntentId as string;
    await pool.query("UPDATE payment_intents SET provider = 'verified-test-adapter', provider_reference = $2 WHERE id = $1",
      [intentId, `pay-${suffix}`]);
    await applyVerifiedPayment(pool, { provider: 'verified-test-adapter', providerEventId: `pev-${suffix}`,
      providerReference: `pay-${suffix}`, intentId, amountRial: '1200000000', paidAt: new Date() });
    const current = await app.inject({ method: 'GET', url: '/api/v1/membership/current', headers: buyerHeaders });
    assert.equal(current.json().membership.status, 'active');
    assert.equal(current.json().membership.code, `pro-${suffix}`);
    assert.deepEqual(current.json().membership.features, ['priority_support', 'reports']);

    // Plan permissions appear on the account immediately.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: buyerHeaders });
    assert.ok(me.json().permissions.includes('plans:read'));

    // Wholesale checkout respects the plan limits.
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: adminHeaders,
      payload: { brand: 'Kolbe', name: 'کت عمده', category: 'کت', cashPriceRial: '200000000',
        wholesalePriceRial: '150000000', metadata: { images: ['img-1'], video: 'vid-1', specs: { fabric: 'پشم' } },
        variants: [{ size: 'M' }, { size: 'L' }, { size: 'XL' }] } });
    assert.equal(product.statusCode, 201, product.body);
    const variantId = product.json().variants[0].id as string;
    const variantIds = (product.json().variants as Array<{ id: string }>).map((item) => item.id);
    await pool.query("UPDATE products SET status = 'published' WHERE id = $1", [product.json().id]);
    const warehouse = await app.inject({ method: 'POST', url: '/api/v1/warehouses', headers: adminHeaders,
      payload: { code: `PW-${suffix.toUpperCase()}`, name: 'انبار' } });
    await app.inject({ method: 'POST', url: '/api/v1/inventory/adjustments',
      headers: { ...adminHeaders, 'idempotency-key': `stk-${suffix}` },
      payload: { variantId, warehouseId: warehouse.json().id, delta: 100, reason: 'اولیه', reference: `ST-${suffix}` } });

    const address = { recipient: 'خریدار عمده', phone: '09123456789', province: 'تهران', city: 'تهران',
      line: 'خیابان تست، پلاک ۲', postalCode: '1234567890' };
    // One line of 150,000,000 sits above the plan minimum of 100,000,000.
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `small-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId, quantity: 1 }], shippingAddress: address } });
    assert.equal(allowed.statusCode, 201, allowed.body);

    // Installment access is disabled on this plan.
    const installment = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `inst-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'four_installments', items: [{ variantId, quantity: 1 }], shippingAddress: address } });
    assert.equal(installment.statusCode, 409, installment.body);

    // maxOrderLines = 2 and maxQuantityPerLine = 50 are enforced.
    const threeLines = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `lines-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash',
        items: variantIds.map((id) => ({ variantId: id, quantity: 1 })), shippingAddress: address } });
    assert.equal(threeLines.statusCode, 409, threeLines.body);
    const overValue = await app.inject({ method: 'POST', url: '/api/v1/orders',
      headers: { ...buyerHeaders, 'idempotency-key': `over-${suffix}` },
      payload: { orderType: 'wholesale', paymentMode: 'cash', items: [{ variantId, quantity: 70 }], shippingAddress: address } });
    assert.equal(overValue.statusCode, 409, overValue.body);

    // Marketplace review with publishing rules and full detail.
    const supplierId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [supplierId, `p-sup-${suffix}@example.test`, await argon2.hash('SupplierPassword12345!'), 'Supplier']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [supplierId, 'supplier']);
    await pool.query("INSERT INTO supplier_profiles(user_id,brand_name,cooperation_status) VALUES ($1,$2,'approved')",
      [supplierId, `Brand ${suffix}`]);
    const supplierLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `p-sup-${suffix}@example.test`, password: 'SupplierPassword12345!' } });
    const supplierHeaders = { authorization: `Bearer ${supplierLogin.json().accessToken as string}` };
    const supplierProduct = await app.inject({ method: 'POST', url: '/api/v1/products', headers: supplierHeaders,
      payload: { brand: `Brand ${suffix}`, name: 'شلوار وینتج', category: 'شلوار', cashPriceRial: '80000000',
        wholesalePriceRial: '60000000', metadata: { images: ['img-a'], specs: { fabric: 'فاستونی' } },
        variants: [{ size: '32' }] } });
    assert.equal(supplierProduct.statusCode, 201, supplierProduct.body);
    assert.equal(supplierProduct.json().status, 'pending');
    const supplierProductId = supplierProduct.json().id as string;

    // Approval without a document check is refused for supplier products.
    const unverified = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${supplierProductId}/review`,
      headers: adminHeaders, payload: { decision: 'approved' } });
    assert.equal(unverified.statusCode, 400, unverified.body);

    await app.inject({ method: 'POST', url: `/api/v1/products/${supplierProductId}/documents`, headers: supplierHeaders,
      payload: { docType: 'certificate', title: 'گواهی کیفیت', fileMeta: { url: 'https://files.example.test/c.pdf' } } });
    const approved = await app.inject({ method: 'POST', url: `/api/v1/admin/marketplace/products/${supplierProductId}/review`,
      headers: adminHeaders, payload: { decision: 'approved', documentsChecked: true,
        checklist: { images: true, specs: true, price: true }, note: 'تصاویر و مشخصات کامل بود' } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, 'published');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/marketplace/products/${supplierProductId}`, headers: adminHeaders });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().supplier_brand, `Brand ${suffix}`);
    assert.equal(detail.json().documents.length, 1);
    assert.equal(detail.json().reviews.length, 1);
    assert.equal(detail.json().variants[0].sku.startsWith('SP-'), true);
    assert.ok(detail.json().metadata.specs.fabric === 'فاستونی');

    // History keeps every decision.
    const logs = await pool.query(`SELECT action FROM audit_logs WHERE resource_type = 'product' ORDER BY created_at`);
    assert.ok(logs.rows.some((row) => row.action === 'product.reviewed'));
  } finally {
    await app.close();
    await pool.end();
  }
});
