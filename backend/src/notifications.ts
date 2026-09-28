import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import { type DbPool } from './db.js';

export function registerNotificationRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/notifications', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), unread: z.enum(['true', 'false']).default('false') }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,title,body,priority,read_at,created_at FROM notifications
       WHERE user_id = $1 AND (NOT $2::boolean OR read_at IS NULL)
       ORDER BY created_at DESC LIMIT $3`, [user.id, query.unread === 'true', query.limit]);
    return { items: rows.rows };
  });
  app.post('/api/v1/notifications/:id/read', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const changed = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at,now()) WHERE id = $1 AND user_id = $2 RETURNING id,read_at', [id, user.id]);
    return { item: changed.rows[0] ?? null };
  });
}
