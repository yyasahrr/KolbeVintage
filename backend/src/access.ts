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

  app.get('/api/v1/admin/users', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'users:manage');
    const query = z.object({ search: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    const rows = await pool.query(
      `SELECT u.id, u.display_name, u.phone, u.email, u.status, u.created_at,
              COALESCE(jsonb_agg(DISTINCT ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), '[]'::jsonb) AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
       WHERE ($1::text IS NULL OR u.display_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
       GROUP BY u.id ORDER BY u.created_at DESC LIMIT $2`, [query.search ?? null, query.limit]);
    return { items: rows.rows };
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
