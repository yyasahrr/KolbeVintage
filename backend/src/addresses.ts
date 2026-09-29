import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import type { DbPool } from './db.js';
import { notFound, badRequest } from './errors.js';
import { audit } from './operations.js';
import { transaction } from './db.js';

const body = z.object({
  title: z.string().trim().min(1).max(80),
  recipient: z.string().trim().min(2).max(120),
  phone: z.string().regex(/^09\d{9}$/),
  province: z.string().trim().min(2).max(120),
  city: z.string().trim().min(2).max(120),
  line: z.string().trim().min(10).max(500),
  postalCode: z.string().regex(/^\d{10}$/),
  isDefault: z.boolean().default(false),
});

export function registerAddressRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/addresses', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [user.id]);
    return { items: rows.rows };
  });
  app.post('/api/v1/addresses', async (request, reply) => {
    const user = await principal(request, pool, config);
    const data = body.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      if (data.isDefault) await client.query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1', [user.id]);
      await client.query(
        `INSERT INTO customer_addresses(id,user_id,title,recipient,phone,province,city,line,postal_code,is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, user.id, data.title, data.recipient, data.phone, data.province, data.city, data.line, data.postalCode, data.isDefault]);
      await audit(client, user.id, 'address.created', 'address', id, undefined, data, request.ip);
    });
    return reply.code(201).send({ id, ...data });
  });
  app.patch('/api/v1/addresses/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const data = body.partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await client.query('SELECT * FROM customer_addresses WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (!before.rows[0]) throw notFound();
      if (data.isDefault) await client.query('UPDATE customer_addresses SET is_default = false WHERE user_id = $1', [user.id]);
      const fields: string[] = []; const vals: unknown[] = [id, user.id];
      const map: Record<string, string> = { title: 'title', recipient: 'recipient', phone: 'phone', province: 'province', city: 'city', line: 'line', postalCode: 'postal_code', isDefault: 'is_default' };
      for (const [k, col] of Object.entries(map)) {
        const v = (data as Record<string, unknown>)[k];
        if (v !== undefined) { vals.push(v); fields.push(`${col} = $${vals.length}`); }
      }
      if (!fields.length) throw badRequest('تغییری وجود ندارد.');
      await client.query(`UPDATE customer_addresses SET ${fields.join(', ')} WHERE id = $1 AND user_id = $2`, vals);
      await audit(client, user.id, 'address.updated', 'address', id, before.rows[0], data, request.ip);
      const row = await client.query('SELECT * FROM customer_addresses WHERE id = $1', [id]);
      return row.rows[0];
    });
  });
  app.delete('/api/v1/addresses/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query('DELETE FROM customer_addresses WHERE id = $1 AND user_id = $2 RETURNING id', [id, user.id]);
    if (!res.rows[0]) throw notFound();
    await transaction(pool, (c) => audit(c, user.id, 'address.deleted', 'address', id, undefined, {}, request.ip));
    return { id, removed: true };
  });
}
