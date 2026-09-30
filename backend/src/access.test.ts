import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4009, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('access matrix, ticket board, VIP priority and attachments work', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `a-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `a-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const adminHeaders = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    // The access page is a readable matrix, not a checkbox list (item 31).
    const matrix = await app.inject({ method: 'GET', url: '/api/v1/admin/access/matrix', headers: adminHeaders });
    assert.equal(matrix.statusCode, 200, matrix.body);
    assert.ok(matrix.json().roles.length >= 6);
    const ordersRead = matrix.json().permissions.find((item: { code: string }) => item.code === 'orders:read');
    assert.equal(ordersRead.roles.admin, true);

    // Custom role with granular permissions.
    const role = await app.inject({ method: 'POST', url: '/api/v1/admin/roles', headers: adminHeaders, payload: {
      code: `ops-audit-${suffix.replace(/-/g, '')}`, title: 'ممیز عملیات', permissions: ['orders:read', 'tickets:read'],
    } });
    assert.equal(role.statusCode, 201, role.body);
    const granted = await app.inject({ method: 'POST',
      url: `/api/v1/admin/access/roles/${role.json().code}/permissions/reports:read`, headers: adminHeaders });
    assert.equal(granted.statusCode, 200, granted.body);
    const revoked = await app.inject({ method: 'DELETE',
      url: `/api/v1/admin/access/roles/${role.json().code}/permissions/reports:read`, headers: adminHeaders });
    assert.equal(revoked.statusCode, 200, revoked.body);

    // Role assignment changes effective permissions immediately; revoking ends the sessions.
    const memberId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [memberId, `a-member-${suffix}@example.test`, await argon2.hash('MemberPassword12345!'), 'Member']);
    const assigned = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${memberId}/roles/${role.json().code}`, headers: adminHeaders });
    assert.equal(assigned.statusCode, 200, assigned.body);
    const memberLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `a-member-${suffix}@example.test`, password: 'MemberPassword12345!' } });
    const memberHeaders = { authorization: `Bearer ${memberLogin.json().accessToken as string}` };
    const memberMe = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: memberHeaders });
    assert.ok(memberMe.json().permissions.includes('orders:read'));
    const memberMatrix = await app.inject({ method: 'GET', url: '/api/v1/admin/access/matrix', headers: memberHeaders });
    assert.equal(memberMatrix.statusCode, 403, memberMatrix.body);
    const unassigned = await app.inject({ method: 'DELETE', url: `/api/v1/admin/users/${memberId}/roles/${role.json().code}`, headers: adminHeaders });
    assert.equal(unassigned.statusCode, 200, unassigned.body);
    const afterRevoke = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: memberHeaders });
    assert.equal(afterRevoke.statusCode, 401, afterRevoke.body);

    // VIP priority boost and SLA cut in half (item 45).
    const plan = await app.inject({ method: 'POST', url: '/api/v1/plans', headers: adminHeaders, payload: {
      code: `vip-${suffix}`, title: 'پلن VIP', annualPriceRial: '500000000',
      limits: { sources: 'all', maxOrdersPerMonth: null, maxOrderValueRial: null, minOrderValueRial: null,
        maxSuppliersPerOrder: null, maxOrderLines: null, maxQuantityPerLine: null,
        discountPercent: 0, prioritySupport: true, installmentAccess: true },
      features: ['priority_support'], permissions: [],
    } });
    const vipId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [vipId, `a-vip-${suffix}@example.test`, await argon2.hash('VipPassword123456!'), 'VIP Buyer']);
    const membershipId = randomUUID();
    await pool.query(
      `INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active', now(), now() + interval '1 year')`,
      [membershipId, vipId, plan.json().id]);
    const vipLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `a-vip-${suffix}@example.test`, password: 'VipPassword123456!' } });
    const vipHeaders = { authorization: `Bearer ${vipLogin.json().accessToken as string}` };
    const vipTicket = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: vipHeaders, payload: {
      subject: 'مشکل در سفارش عمده', category: 'مشکل سفارش', priority: 'normal', message: 'سلام، سفارش من هنوز ارسال نشده است.',
    } });
    assert.equal(vipTicket.statusCode, 201, vipTicket.body);
    assert.equal(vipTicket.json().priority, 'high');
    assert.equal(vipTicket.json().vipBoost, true);

    // Attachments and the Kanban board (item 26).
    const attachment = await app.inject({ method: 'POST', url: `/api/v1/tickets/${vipTicket.json().id}/attachments`,
      headers: vipHeaders, payload: { title: 'عکس فاکتور', fileMeta: { url: 'https://files.example.test/inv.png' } } });
    assert.equal(attachment.statusCode, 201, attachment.body);
    const badAttachment = await app.inject({ method: 'POST', url: `/api/v1/tickets/${vipTicket.json().id}/attachments`,
      headers: vipHeaders, payload: { title: 'فایل نامعتبر', fileMeta: { url: 'http://files.example.test/x.png', mime: 'application/x-sh', size: 50 * 1024 * 1024 } } });
    assert.equal(badAttachment.statusCode, 400, badAttachment.body);
    await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: vipHeaders, payload: {
      subject: 'درخواست مرجوعی', category: 'مرجوعی', priority: 'low', message: 'می‌خواهم کالا را مرجوع کنم.',
    } });
    const board = await app.inject({ method: 'GET', url: '/api/v1/tickets/board', headers: adminHeaders });
    assert.equal(board.statusCode, 200, board.body);
    assert.equal(board.json().columns.new.length, 2);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${vipTicket.json().id}`, headers: adminHeaders });
    assert.equal(detail.json().attachments.length, 1);

    // Ticket list filters find the needle (item 26/30).
    const filtered = await app.inject({ method: 'GET', url: '/api/v1/tickets?priority=high&search=عمده', headers: adminHeaders });
    assert.equal(filtered.json().items.length, 1);
    assert.equal(filtered.json().items[0].id, vipTicket.json().id);

    // Reply timing feeds SLA reporting (item 26).
    await app.inject({ method: 'POST', url: `/api/v1/tickets/${vipTicket.json().id}/messages`, headers: adminHeaders,
      payload: { message: 'سفارش شما امروز ارسال می‌شود.', internal: false } });
    const replied = await pool.query('SELECT first_response_at, status FROM tickets WHERE id = $1', [vipTicket.json().id]);
    assert.ok(replied.rows[0].first_response_at);
    assert.equal(replied.rows[0].status, 'answered');
  } finally {
    await app.close();
    await pool.end();
  }
});
