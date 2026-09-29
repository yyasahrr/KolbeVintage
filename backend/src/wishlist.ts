import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { notFound } from './errors.js';
import { audit } from './operations.js';

export function registerWishlistRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Collections
  app.get('/api/v1/wishlist/collections', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT c.id, c.title, c.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('id', i.id, 'productId', i.product_id, 'variantId', i.variant_id, 'addedAt', i.added_at)
                ORDER BY i.added_at DESC) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items,
              COUNT(i.id)::int AS item_count
       FROM wishlist_collections c LEFT JOIN wishlist_items i ON i.collection_id = c.id
       WHERE c.owner_id = $1 GROUP BY c.id ORDER BY c.created_at DESC`, [user.id]);
    return { items: rows.rows };
  });

  app.post('/api/v1/wishlist/collections', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(request.body);
    const id = randomUUID();
    await pool.query('INSERT INTO wishlist_collections(id,owner_id,title) VALUES ($1,$2,$3)', [id, user.id, body.title]);
    await transaction(pool, (c) => audit(c, user.id, 'wishlist.collection_created', 'wishlist_collection', id, undefined, body, request.ip));
    return reply.code(201).send({ id, title: body.title });
  });

  app.delete('/api/v1/wishlist/collections/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<{ owner_id: string }>(pool, 'SELECT owner_id FROM wishlist_collections WHERE id = $1', [id]);
    if (!row || row.owner_id !== user.id) throw notFound();
    await pool.query('DELETE FROM wishlist_collections WHERE id = $1', [id]);
    return { id, removed: true };
  });

  // Items: add product/variant to collection
  app.post('/api/v1/wishlist/collections/:id/items', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ productId: z.uuid(), variantId: z.uuid().nullable().optional() }).parse(request.body);
    const col = await one<{ owner_id: string }>(pool, 'SELECT owner_id FROM wishlist_collections WHERE id = $1', [id]);
    if (!col || col.owner_id !== user.id) throw notFound();
    const product = await one<{ cash_price_rial: string }>(pool, 'SELECT cash_price_rial FROM products WHERE id = $1', [body.productId]);
    if (!product) throw notFound();
    const itemId = randomUUID();
    try {
      await pool.query('INSERT INTO wishlist_items(id,collection_id,product_id,variant_id,price_at_add) VALUES ($1,$2,$3,$4,$5)',
        [itemId, id, body.productId, body.variantId ?? null, product.cash_price_rial]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(200).send({ id: itemId, duplicate: true });
      throw e;
    }
    // CRM segmentation: activity
    await pool.query(`INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id)
      SELECT $1, c.id, 'event', 'افزودن به علاقه‌مندی', $2, 'wishlist', $3 FROM crm_contacts c WHERE c.user_id = $4`,
      [randomUUID(), `افزودن محصول ${body.productId} به لیست`, body.productId, user.id]).catch(() => undefined);
    return reply.code(201).send({ id: itemId, collectionId: id, productId: body.productId });
  });

  app.delete('/api/v1/wishlist/items/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<{ owner_id: string }>(pool,
      `SELECT c.owner_id FROM wishlist_items i JOIN wishlist_collections c ON c.id = i.collection_id WHERE i.id = $1`, [id]);
    if (!row || row.owner_id !== user.id) throw notFound();
    await pool.query('DELETE FROM wishlist_items WHERE id = $1', [id]);
    return { id, removed: true };
  });

  // Alerts: price drop / restock / back-in-stock
  app.get('/api/v1/wishlist/alerts', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query('SELECT id, product_id, kind, active, created_at FROM wishlist_alerts WHERE user_id = $1 ORDER BY created_at DESC', [user.id]);
    return { items: rows.rows };
  });

  app.post('/api/v1/wishlist/alerts', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({ productId: z.uuid(), kind: z.enum(['price_drop','restock','back_in_stock']) }).parse(request.body);
    const id = randomUUID();
    try {
      await pool.query('INSERT INTO wishlist_alerts(id,user_id,product_id,kind) VALUES ($1,$2,$3,$4)', [id, user.id, body.productId, body.kind]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw notFound();
      throw e;
    }
    return reply.code(201).send({ id, ...body, active: true });
  });

  app.delete('/api/v1/wishlist/alerts/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<{ user_id: string }>(pool, 'SELECT user_id FROM wishlist_alerts WHERE id = $1', [id]);
    if (!row || row.user_id !== user.id) throw notFound();
    await pool.query('DELETE FROM wishlist_alerts WHERE id = $1', [id]);
    return { id, removed: true };
  });

  // Shared: list all saved products for CRM segmentation (admin)
  app.get('/api/v1/admin/wishlist/stats', async (request) => {
    const user = await principal(request, pool, config);
    const { requirePermission } = await import('./auth.js');
    requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT p.id, p.name, COUNT(i.id)::int AS saves,
              COUNT(DISTINCT c.owner_id)::int AS savers
       FROM products p LEFT JOIN wishlist_items i ON i.product_id = p.id
       LEFT JOIN wishlist_collections c ON c.id = i.collection_id
       GROUP BY p.id ORDER BY saves DESC LIMIT 50`);
    return { items: rows.rows };
  });
}
