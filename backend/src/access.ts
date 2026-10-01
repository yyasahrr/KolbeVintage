import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Access control (item 31): a readable roles × permissions matrix plus direct
   grant/revoke and user role management — not a flat list of checkboxes. */

export function registerAccessRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/access/matrix', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'access:manage');
    const roles = await pool.query('SELECT code, title FROM roles ORDER BY code');
    const permissions = await pool.query('SELECT code, title FROM permissions ORDER BY code');
    const grants = await pool.query('SELECT role_code, permission_code FROM role_permissions');
    const granted = new Set(grants.rows.map((row) => `${row.role_code}:${row.permission_code}`));
    return {
      roles: roles.rows,
      permissions: permissions.rows.map((permission) => ({
        ...permission,
        roles: Object.fromEntries(roles.rows.map((role) => [role.code, granted.has(`${role.code}:${permission.code}`)])),
      })),
    };
  });

  app.post('/api/v1/admin/access/roles/:role/permissions/:permission', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'access:manage');
    const params = z.object({ role: z.string().max(40), permission: z.string().max(60) }).parse(request.params);
    return transaction(pool, async (client) => {
      const role = await one(client, 'SELECT code FROM roles WHERE code = $1', [params.role]);
      const permission = await one(client, 'SELECT code FROM permissions WHERE code = $1', [params.permission]);
      if (!role || !permission) throw notFound();
      await client.query('INSERT INTO role_permissions(role_code, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [params.role, params.permission]);
      await audit(client, user.id, 'access.permission_granted', 'role', params.role,
        undefined, { permission: params.permission }, request.ip);
      return { role: params.role, permission: params.permission, granted: true };
    });
  });

  app.delete('/api/v1/admin/access/roles/:role/permissions/:permission', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'access:manage');
    const params = z.object({ role: z.string().max(40), permission: z.string().max(60) }).parse(request.params);
    if (params.role === 'admin' && params.permission === 'access:manage')
      throw conflict('دسترسی مدیریت نقش‌ها از مدیر کل قابل حذف نیست.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT 1 FROM role_permissions WHERE role_code = $1 AND permission_code = $2',
        [params.role, params.permission]);
      if (!before) throw notFound();
      await client.query('DELETE FROM role_permissions WHERE role_code = $1 AND permission_code = $2',
        [params.role, params.permission]);
      await audit(client, user.id, 'access.permission_revoked', 'role', params.role,
        { permission: params.permission }, undefined, request.ip);
      return { role: params.role, permission: params.permission, granted: false };
    });
  });

  /**
   * Server-side user directory (Requirements 19-20): real search on
   * name/phone/email/user-id plus server-side filters on role, status, order
   * count, purchase total, join date, last-order date and city — with
   * pagination metadata (total/limit/offset). Order aggregates come from the
   * orders ledger; city from the customer's addresses.
   * Not available in the current domain (reported, not faked): customer
   * segment on users themselves (lives in crm_contacts) and acquisition source.
   */
  app.get('/api/v1/admin/users', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'users:manage');
    const query = z.object({
      search: z.string().trim().max(120).optional(),
      role: z.string().trim().max(40).optional(),
      status: z.enum(['active', 'suspended']).optional(),
      city: z.string().trim().max(120).optional(),
      joinedFrom: z.iso.datetime().optional(),
      joinedTo: z.iso.datetime().optional(),
      minOrders: z.coerce.number().int().min(0).max(1000000).optional(),
      maxOrders: z.coerce.number().int().min(0).max(1000000).optional(),
      minSpentRial: z.string().regex(/^\d+$/).optional(),
      maxSpentRial: z.string().regex(/^\d+$/).optional(),
      lastOrderFrom: z.iso.datetime().optional(),
      lastOrderTo: z.iso.datetime().optional(),
      sort: z.enum(['newest', 'oldest', 'orders', 'spent', 'last_order']).default('newest'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(request.query);
    const sortSql = {
      newest: 'created_at DESC', oldest: 'created_at ASC',
      orders: 'order_count DESC, created_at DESC', spent: 'total_spent_rial DESC, created_at DESC',
      last_order: 'last_order_at DESC NULLS LAST, created_at DESC',
    }[query.sort];
    const params = [
      query.search ?? null, query.role ?? null, query.status ?? null, query.city ?? null,
      query.joinedFrom ?? null, query.joinedTo ?? null,
      query.minOrders ?? null, query.maxOrders ?? null,
      query.minSpentRial ?? null, query.maxSpentRial ?? null,
      query.lastOrderFrom ?? null, query.lastOrderTo ?? null,
    ];
    const baseSql = `
      WITH order_stats AS (
        SELECT o.buyer_id, count(*)::int AS order_count,
               COALESCE(sum(o.total_rial) FILTER (WHERE o.status <> 'cancelled'), 0) AS total_spent_rial,
               max(o.created_at) AS last_order_at
        FROM orders o GROUP BY o.buyer_id
      )
      SELECT u.id, u.display_name, u.phone, u.email, u.status, u.created_at,
             COALESCE(s.order_count, 0) AS order_count,
             COALESCE(s.total_spent_rial, 0)::text AS total_spent_rial,
             s.last_order_at,
             (SELECT a.city FROM customer_addresses a WHERE a.user_id = u.id ORDER BY a.is_default DESC, a.created_at DESC LIMIT 1) AS city,
             COALESCE((SELECT jsonb_agg(DISTINCT ur.role_code) FROM user_roles ur WHERE ur.user_id = u.id), '[]'::jsonb) AS roles
      FROM users u LEFT JOIN order_stats s ON s.buyer_id = u.id
      WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
             OR u.email ILIKE '%' || $1 || '%' OR u.id::text = lower($1))
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role_code = $2))
        AND ($3::text IS NULL OR u.status = $3)
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM customer_addresses a WHERE a.user_id = u.id AND a.city ILIKE '%' || $4 || '%'))
        AND ($5::timestamptz IS NULL OR u.created_at >= $5)
        AND ($6::timestamptz IS NULL OR u.created_at <= $6)
        AND ($7::int IS NULL OR COALESCE(s.order_count, 0) >= $7)
        AND ($8::int IS NULL OR COALESCE(s.order_count, 0) <= $8)
        AND ($9::numeric IS NULL OR COALESCE(s.total_spent_rial, 0) >= $9::numeric)
        AND ($10::numeric IS NULL OR COALESCE(s.total_spent_rial, 0) <= $10::numeric)
        AND ($11::timestamptz IS NULL OR s.last_order_at >= $11)
        AND ($12::timestamptz IS NULL OR s.last_order_at <= $12)`;
    const total = await pool.query(`SELECT count(*)::int AS total FROM (${baseSql}) q`, params);
    const rows = await pool.query(`SELECT * FROM (${baseSql}) q ORDER BY ${sortSql} LIMIT $13 OFFSET $14`,
      [...params, query.limit, query.offset]);
    return { items: rows.rows, total: total.rows[0]?.total ?? 0, limit: query.limit, offset: query.offset };
  });

  app.post('/api/v1/admin/users/:id/roles/:role', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'users:manage');
    const params = z.object({ id: z.uuid(), role: z.string().max(40) }).parse(request.params);
    return transaction(pool, async (client) => {
      const target = await one(client, 'SELECT id FROM users WHERE id = $1', [params.id]);
      const role = await one(client, 'SELECT code FROM roles WHERE code = $1', [params.role]);
      if (!target || !role) throw notFound();
      await client.query('INSERT INTO user_roles(user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [params.id, params.role]);
      await audit(client, user.id, 'access.role_assigned', 'user', params.id, undefined, { role: params.role }, request.ip);
      return { userId: params.id, role: params.role, assigned: true };
    });
  });

  app.delete('/api/v1/admin/users/:id/roles/:role', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'users:manage');
    const params = z.object({ id: z.uuid(), role: z.string().max(40) }).parse(request.params);
    if (params.id === user.id && params.role === 'admin') throw conflict('نقش مدیر کل از حساب خودتان قابل حذف نیست.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_code = $2', [params.id, params.role]);
      if (!before) throw notFound();
      await client.query('DELETE FROM user_roles WHERE user_id = $1 AND role_code = $2', [params.id, params.role]);
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [params.id]);
      await audit(client, user.id, 'access.role_revoked', 'user', params.id, { role: params.role }, undefined, request.ip);
      return { userId: params.id, role: params.role, assigned: false };
    });
  });

  app.get('/api/v1/admin/roles', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'access:manage');
    const rows = await pool.query(
      `SELECT r.code, r.title, COALESCE(jsonb_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '[]'::jsonb) AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
       GROUP BY r.code ORDER BY r.code`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/roles', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'access:manage');
    const body = z.object({
      code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
      title: z.string().trim().min(2).max(80),
      permissions: z.array(z.string().max(60)).max(100).default([]),
    }).strict().parse(request.body);
    const exists = await one(pool, 'SELECT code FROM roles WHERE code = $1', [body.code]);
    if (exists) throw badRequest('این نقش قبلاً تعریف شده است.');
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO roles(code, title) VALUES ($1,$2)', [body.code, body.title]);
      for (const permission of body.permissions) {
        const known = await one(client, 'SELECT code FROM permissions WHERE code = $1', [permission]);
        if (!known) throw badRequest(`دسترسی «${permission}» تعریف نشده است.`);
        await client.query('INSERT INTO role_permissions(role_code, permission_code) VALUES ($1,$2)', [body.code, permission]);
      }
      await audit(client, user.id, 'access.role_created', 'role', body.code, undefined, body, request.ip);
    });
    return reply.code(201).send({ ...body });
  });
}
