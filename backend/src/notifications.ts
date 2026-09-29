import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import { transaction, type DbPool } from './db.js';
import { audit } from './operations.js';

export function registerNotificationRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/notifications', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      unread: z.enum(['true', 'false']).default('false'),
      priority: z.enum(['low','normal','high','critical']).optional(),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,title,body,priority,event_id,read_at,created_at FROM notifications
       WHERE user_id = $1 AND (NOT $2::boolean OR read_at IS NULL)
         AND ($3::text IS NULL OR priority = $3)
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at DESC LIMIT $4`,
      [user.id, query.unread === 'true', query.priority ?? null, query.limit]);
    return { items: rows.rows };
  });
  app.get('/api/v1/notifications/unread-count', async (request) => {
    const user = await principal(request, pool, config);
    const row = await pool.query(`SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
    return { count: row.rows[0].count };
  });
  app.post('/api/v1/notifications/read-all', async (request) => {
    const user = await principal(request, pool, config);
    await pool.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE user_id = $1 AND read_at IS NULL`, [user.id]);
    return { updated: true };
  });
  app.post('/api/v1/notifications/:id/read', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const changed = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at,now()) WHERE id = $1 AND user_id = $2 RETURNING id,read_at', [id, user.id]);
    return { item: changed.rows[0] ?? null };
  });
  // Admin: broadcast notification (for settlement, stock low etc.)
  app.post('/api/v1/admin/notifications', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { requirePermission } = await import('./auth.js');
    requirePermission(user, 'notifications:manage');
    const body = z.object({
      userId: z.uuid().optional(),
      role: z.string().max(40).optional(),
      title: z.string().trim().min(2).max(200),
      body: z.string().trim().min(2).max(2000),
      priority: z.enum(['low','normal','high']).default('normal'),
      channel: z.enum(['in_app','sms','email','webhook']).default('in_app'),
    }).parse(request.body);
    const { randomUUID } = await import('node:crypto');
    if (body.userId) {
      // A notification always hangs off an outbox event (notifications.event_id is NOT NULL):
      // the event is the audit-able trigger, the row is the per-user delivery record.
      const id = randomUUID();
      const created = await transaction(pool, async (client) => {
        const eventId = randomUUID();
        await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
          [eventId, 'notification.admin', 'user', body.userId, JSON.stringify({ title: body.title })]);
        await client.query(`INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, body.userId, eventId, body.title, body.body, body.priority]);
        await audit(client, user.id, 'notification.created', 'notification', id, undefined,
          { userId: body.userId, channel: body.channel }, request.ip);
        return { id, userId: body.userId, eventId };
      });
      return reply.code(201).send(created);
    }
    if (body.role) {
      const users = await pool.query(`SELECT user_id FROM user_roles WHERE role_code = $1`, [body.role]);
      await transaction(pool, async (client) => {
        for (const u of users.rows) {
          const eventId = randomUUID();
          await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
            [eventId, 'notification.admin', 'user', u.user_id, JSON.stringify({ title: body.title })]);
          await client.query(`INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)`,
            [randomUUID(), u.user_id, eventId, body.title, body.body, body.priority]);
        }
        await audit(client, user.id, 'notification.broadcast', 'notification_route', randomUUID(),
          undefined, { role: body.role, recipients: users.rows.length }, request.ip);
      });
      return reply.code(201).send({ role: body.role, count: users.rows.length });
    }
    const { badRequest } = await import('./errors.js');
    throw badRequest('userId یا role لازم است.');
  });
}
