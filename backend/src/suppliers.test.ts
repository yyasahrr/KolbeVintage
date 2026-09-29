import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4004, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('cooperation form submissions become versioned supplier profiles', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `s-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `s-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${login.json().accessToken as string}` };

    // The cooperation form is public and admin-managed.
    const form = await app.inject({ method: 'GET', url: '/api/v1/cooperation-form' });
    assert.equal(form.statusCode, 200, form.body);
    assert.ok(form.json().items.length > 10);
    assert.ok(form.json().items.some((field: { code: string }) => field.code === 'iban'));

    // Required fields are enforced on submission.
    const incomplete = await app.inject({ method: 'POST', url: '/api/v1/cooperation-requests',
      payload: { payload: { brand_name: 'برند تست' } } });
    assert.equal(incomplete.statusCode, 400, incomplete.body);

    const mobile = `0912${String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7)}`;
    const submitted = await app.inject({ method: 'POST', url: '/api/v1/cooperation-requests', payload: {
      payload: {
        brand_name: `برند ${suffix}`, legal_name: 'شرکت تست', person_type: 'legal', national_id: '10930000000',
        phone: '02122334455', mobile, email: `brand-${suffix}@example.test`, office_address: 'تهران، خیابان تست',
        bank_name: 'ملت', iban: 'IR060120020000000397455001', account_holder: 'شرکت تست',
        product_categories: 'کت و شلوار', lead_time_days: 14,
      },
    } });
    assert.equal(submitted.statusCode, 201, submitted.body);
    assert.match(submitted.json().reference as string, /^COOP-\d{4}-\d{6}$/);

    // Review turns the submission into a complete supplier profile.
    const reviewed = await app.inject({ method: 'POST', url: `/api/v1/admin/cooperation-requests/${submitted.json().id}/review`,
      headers: adminHeaders, payload: { status: 'approved', note: 'تأیید اولیه' } });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.ok(reviewed.json().userId);
    const tempPassword = reviewed.json().temporaryPassword as string;
    assert.ok(tempPassword.length >= 12);

    const supplierLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: mobile, password: tempPassword } });
    assert.equal(supplierLogin.statusCode, 200, supplierLogin.body);
    const supplierHeaders = { authorization: `Bearer ${supplierLogin.json().accessToken as string}` };

    const profile = await app.inject({ method: 'GET', url: '/api/v1/supplier-profile', headers: supplierHeaders });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.equal(profile.json().brand_name, `برند ${suffix}`);
    assert.equal(profile.json().bank_iban, 'IR060120020000000397455001');
    assert.equal(profile.json().cooperation_status, 'pending');

    // Profile updates are versioned.
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/supplier-profile', headers: supplierHeaders,
      payload: { warehouseAddress: 'تهران، انبار مرکزی', leadTimeDays: 7, changeNote: 'به‌روزرسانی انبار' } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().lead_time_days, 7);
    const versions = await app.inject({ method: 'GET', url: '/api/v1/supplier-profile/versions', headers: supplierHeaders });
    assert.ok(versions.json().items.length >= 2);
    assert.equal(versions.json().items[0].change_note, 'به‌روزرسانی انبار');

    // Commission can only be changed by the platform, not the supplier.
    const hack = await app.inject({ method: 'PATCH', url: '/api/v1/supplier-profile', headers: supplierHeaders,
      payload: { commissionPercent: 0 } });
    assert.equal(hack.statusCode, 400, hack.body);

    // Approval status is managed by the admin with a full audit trail.
    const approved = await app.inject({ method: 'POST', url: `/api/v1/admin/suppliers/${reviewed.json().userId}/status`,
      headers: adminHeaders, payload: { status: 'approved', note: 'همکاری تأیید شد' } });
    assert.equal(approved.statusCode, 200, approved.body);
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/suppliers?status=approved', headers: adminHeaders });
    assert.ok(list.json().items.some((item: { user_id: string }) => item.user_id === reviewed.json().userId));

    // Documents are registered and verified by the platform.
    const document = await app.inject({ method: 'POST', url: '/api/v1/supplier-profile/documents', headers: supplierHeaders,
      payload: { docType: 'license', title: 'پروانه کسب', fileMeta: { url: 'https://files.example.test/license.pdf' } } });
    assert.equal(document.statusCode, 201, document.body);
    const verified = await app.inject({ method: 'POST',
      url: `/api/v1/admin/suppliers/${reviewed.json().userId}/documents/${document.json().id}/verify`,
      headers: adminHeaders, payload: { verified: true } });
    assert.equal(verified.statusCode, 200, verified.body);
    const afterDocs = await app.inject({ method: 'GET', url: '/api/v1/supplier-profile', headers: supplierHeaders });
    assert.equal(afterDocs.json().documents[0].verified, true);

    // The audit log recorded the profile lifecycle.
    const logs = await pool.query(
      `SELECT action FROM audit_logs WHERE resource_type IN ('supplier','cooperation_request','supplier_document')
       ORDER BY created_at`);
    const actions = logs.rows.map((row) => row.action);
    for (const expected of ['cooperation_request.created', 'cooperation_request.reviewed', 'supplier.profile_updated',
      'supplier.status_changed', 'supplier.document_added', 'supplier.document_verified']) {
      assert.ok(actions.includes(expected), `missing audit action ${expected}`);
    }
  } finally {
    await app.close();
    await pool.end();
  }
});
