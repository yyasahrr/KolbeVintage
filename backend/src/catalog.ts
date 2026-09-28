import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { principal, requirePermission } from './auth.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, forbidden, notFound } from './errors.js';

const productBody = z.object({
  brand: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(240),
  category: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(''),
  cashPriceRial: z.string().regex(/^\d+$/),
  installmentPriceRial: z.string().regex(/^\d+$/).optional(),
  wholesalePriceRial: z.string().regex(/^\d+$/).optional(),
  variants: z.array(z.object({ size: z.string().max(50).optional(), color: z.string().max(100).optional(), attributes: z.record(z.string(), z.string()).default({}) })).min(1).max(100),
});
const statusBody = z.object({ status: z.enum(['published', 'rejected', 'draft', 'archived']) });

const categoryCode = (category: string) => /کفش|کتانی|بوت/.test(category) ? 'SHOE' : /شلوار|جین/.test(category) ? 'PANT'
  : /اکسسوری|کیف|شال|کمربند/.test(category) ? 'ACCS' : /کت|بلیزر/.test(category) ? 'COAT' : 'ITEM';

export function registerCatalogRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/products', async (request) => {
    const query = z.object({ category: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.iso.datetime().optional() }).parse(request.query);
    const result = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.description, p.cash_price_rial,
              p.installment_price_rial, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'size', v.size_label, 'color', v.color_label)
                ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published' AND ($1::text IS NULL OR p.category = $1)
         AND ($2::timestamptz IS NULL OR p.created_at < $2)
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT $3`, [query.category ?? null, query.before ?? null, query.limit]);
    return { items: result.rows.map((row) => ({
      id: row.id, brand: row.brand, name: row.name, category: row.category, description: row.description,
      cashPriceRial: asRial(row.cash_price_rial), installmentPriceRial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
      variants: row.variants, createdAt: row.created_at,
    })) };
  });

  app.get('/api/v1/wholesale/products', async (request) => {
    const user = await principal(request, pool, config);
    const membership = await one<{ limits: Record<string, unknown> }>(pool,
      `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
       LIMIT 1`, [user.id]);
    if (!membership) throw forbidden();
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const kolbeOnly = membership.limits.sources === 'kolbe';
    const rows = await pool.query(
      `SELECT p.id,p.name,p.brand,p.category,p.wholesale_price_rial,v.id AS variant_id,v.sku
       FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published' AND p.wholesale_price_rial > 0
         AND (NOT $1::boolean OR p.supplier_id IS NULL)
       ORDER BY p.created_at DESC,v.sku LIMIT $2`, [kolbeOnly, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, wholesale_price_rial: asRial(row.wholesale_price_rial) })) };
  });

  app.post('/api/v1/products', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'products:write');
    const body = productBody.parse(request.body);
    const cash = rial(body.cashPriceRial), installment = body.installmentPriceRial === undefined ? null : rial(body.installmentPriceRial);
    const wholesale = body.wholesalePriceRial === undefined ? null : rial(body.wholesalePriceRial);
    if (cash === 0n && (!wholesale || wholesale === 0n)) throw badRequest('دست‌کم یک قیمت معتبر لازم است.');
    if (user.roles.includes('supplier')) {
      const supplier = await one<{ cooperation_status: string }>(pool, 'SELECT cooperation_status FROM supplier_profiles WHERE user_id = $1', [user.id]);
      if (supplier?.cooperation_status !== 'approved') throw forbidden();
    }
    const productId = randomUUID();
    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [productId, user.roles.includes('supplier') ? user.id : null, body.brand, body.name, body.category, body.description,
          user.roles.includes('supplier') ? 'pending' : 'draft', cash.toString(), installment?.toString() ?? null, wholesale?.toString() ?? null]);
      const variants = [];
      for (const variant of body.variants) {
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${user.roles.includes('supplier') ? 'SP' : 'KV'}-${categoryCode(body.category)}-${seq!.id}`;
        const id = randomUUID();
        await client.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,attributes) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, productId, sku, variant.size ?? null, variant.color ?? null, JSON.stringify(variant.attributes)]);
        variants.push({ id, sku });
      }
      await audit(client, user.id, 'product.created', 'product', productId, undefined, { name: body.name, variants }, request.ip);
      await outbox(client, 'product.created', 'product', productId, { productId });
      return { id: productId, status: user.roles.includes('supplier') ? 'pending' : 'draft', variants };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/products/:id/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { status } = statusBody.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ status: string }>(client, 'SELECT status FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (before.status === status) return { id, status };
      await client.query('UPDATE products SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, status]);
      await audit(client, user.id, 'product.status_changed', 'product', id, before, { status }, request.ip);
      await outbox(client, 'product.status_changed', 'product', id, { productId: id, status });
      return { id, status };
    });
  });
}
