import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { principal, requirePermission } from './auth.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { assertSupplierMay, supplierCapViolation } from './supplier360.js';
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
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const statusBody = z.object({ status: z.enum(['published', 'rejected', 'draft', 'archived']) });

const categoryCode = (category: string) => /کفش|کتانی|بوت/.test(category) ? 'SHOE' : /شلوار|جین/.test(category) ? 'PANT'
  : /اکسسوری|کیف|شال|کمربند/.test(category) ? 'ACCS' : /کت|بلیزر/.test(category) ? 'COAT' : 'ITEM';

export function registerCatalogRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/products', async (request) => {
    const query = z.object({ category: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.iso.datetime().optional() }).parse(request.query);
    // Availability is derived from the WMS ledger (stock_balances), never from product.metadata.
    const result = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.description, p.cash_price_rial,
              p.installment_price_rial, p.metadata, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'size', v.size_label, 'color', v.color_label,
                'available', COALESCE(b.available, 0), 'reserved', COALESCE(b.reserved, 0),
                'incoming', COALESCE(b.incoming, 0), 'damaged', COALESCE(b.damaged, 0))
                ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
       LEFT JOIN (
         SELECT sb.variant_id,
                SUM(sb.on_hand - sb.reserved - sb.damaged)::int AS available,
                SUM(sb.reserved)::int AS reserved, SUM(sb.incoming)::int AS incoming, SUM(sb.damaged)::int AS damaged
         FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id AND w.active
         GROUP BY sb.variant_id
       ) b ON b.variant_id = v.id
       WHERE p.status = 'published' AND ($1::text IS NULL OR p.category = $1)
         AND ($2::timestamptz IS NULL OR p.created_at < $2)
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT $3`, [query.category ?? null, query.before ?? null, query.limit]);
    return { items: result.rows.map((row) => {
      const variants = row.variants as { available?: number; reserved?: number; incoming?: number; damaged?: number }[];
      const sum = (key: 'available' | 'reserved' | 'incoming' | 'damaged') => variants.reduce((total, variant) => total + Number(variant[key] ?? 0), 0);
      return {
        id: row.id, brand: row.brand, name: row.name, category: row.category, description: row.description,
        cashPriceRial: asRial(row.cash_price_rial), installmentPriceRial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
        metadata: row.metadata, variants, createdAt: row.created_at,
        available: sum('available'), reserved: sum('reserved'), incoming: sum('incoming'), damaged: sum('damaged'),
      };
    }) };
  });

  /** Per-variant WMS inventory for one product — drives the ProductStudio inventory view. */
  app.get('/api/v1/admin/products/:id/inventory', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ id: string; name: string }>(pool, 'SELECT id, name FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    const rows = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.color_label AS color, v.size_label AS size,
              w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              COALESCE(b.on_hand, 0)::int AS on_hand, COALESCE(b.reserved, 0)::int AS reserved,
              COALESCE(b.incoming, 0)::int AS incoming, COALESCE(b.damaged, 0)::int AS damaged,
              COALESCE(b.on_hand - b.reserved - b.damaged, 0)::int AS available
       FROM product_variants v
       LEFT JOIN stock_balances b ON b.variant_id = v.id
       LEFT JOIN warehouses w ON w.id = b.warehouse_id
       WHERE v.product_id = $1 AND v.active
       ORDER BY v.sku, w.code`, [id]);
    const variants = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.color_label AS color, v.size_label AS size,
              COALESCE(SUM(b.on_hand - b.reserved - b.damaged), 0)::int AS available
       FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.product_id = $1 AND v.active GROUP BY v.id ORDER BY v.sku`, [id]);
    const totals = { available: 0, reserved: 0, incoming: 0, damaged: 0 };
    for (const row of rows.rows) {
      totals.available += Number(row.available); totals.reserved += Number(row.reserved);
      totals.incoming += Number(row.incoming); totals.damaged += Number(row.damaged);
    }
    return { productId: product.id, productName: product.name, variants: variants.rows, items: rows.rows, totals };
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
      // The activity lifecycle (item 11) is the single gate: it already folds in
      // the legacy cooperation status and always explains *why* an action is blocked.
      const supplier = await one<{ activity_status: string }>(pool,
        'SELECT activity_status FROM supplier_profiles WHERE user_id = $1', [user.id]);
      if (!supplier) throw forbidden('پروفایل تأمین‌کننده یافت نشد؛ ابتدا درخواست همکاری را تکمیل کنید.');
      await assertSupplierMay(pool, user.id, 'product_create', { resource: 'product', ip: request.ip });
      const violation = await transaction(pool, (client) => supplierCapViolation(client, user.id, 'product_limit'));
      if (violation) throw forbidden(violation);
    }
    const productId = randomUUID();
    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [productId, user.roles.includes('supplier') ? user.id : null, body.brand, body.name, body.category, body.description,
          user.roles.includes('supplier') ? 'pending' : 'draft', cash.toString(), installment?.toString() ?? null, wholesale?.toString() ?? null,
          JSON.stringify(body.metadata)]);
      const variants = [];
      for (const variant of body.variants) {
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${user.roles.includes('supplier') ? 'SP' : 'KV'}-${categoryCode(body.category)}-${seq!.id}`;
        const id = randomUUID();
        await client.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,attributes) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, productId, sku, variant.size ?? null, variant.color ?? null, JSON.stringify(variant.attributes)]);
        // Color/size travel with the ids so the client can bind per-variant inventory input
        // without relying on array order.
        variants.push({ id, sku, color: variant.color ?? null, size: variant.size ?? null });
      }
      await audit(client, user.id, 'product.created', 'product', productId, undefined, { name: body.name, variants }, request.ip);
      await outbox(client, 'product.created', 'product', productId, { productId });
      return { id: productId, status: user.roles.includes('supplier') ? 'pending' : 'draft', variants };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/products/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      brand: z.string().trim().min(1).max(120).optional(),
      name: z.string().trim().min(2).max(240).optional(),
      category: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(10000).optional(),
      cashPriceRial: z.string().regex(/^\d+$/).optional(),
      installmentPriceRial: z.string().regex(/^\d+$/).nullable().optional(),
      wholesalePriceRial: z.string().regex(/^\d+$/).nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).strict().parse(request.body);
    const owned = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!owned) throw notFound();
    const isSupplierOwner = owned.supplier_id === user.id && user.roles.includes('supplier');
    if (!isSupplierOwner) requirePermission(user, 'products:write');
    else await assertSupplierMay(pool, user.id, 'product_edit', { resource: 'product', resourceId: id, ip: request.ip });
    return transaction(pool, async (client) => {
      const before = await one<{ supplier_id: string | null; status: string }>(client,
        'SELECT supplier_id, status FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.cashPriceRial !== undefined) rial(body.cashPriceRial);
      if (body.installmentPriceRial) rial(body.installmentPriceRial);
      if (body.wholesalePriceRial) rial(body.wholesalePriceRial);
      const columns: Record<string, string> = {
        brand: 'brand', name: 'name', category: 'category', description: 'description',
        cashPriceRial: 'cash_price_rial', installmentPriceRial: 'installment_price_rial',
        wholesalePriceRial: 'wholesale_price_rial', metadata: 'metadata',
      };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(key === 'metadata' ? JSON.stringify(value) : value);
        updates.push(`${column} = $${values.length}`);
      }
      if (!updates.length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
      await client.query(`UPDATE products SET ${updates.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, values);
      await audit(client, user.id, 'product.updated', 'product', id, before,
        { fields: Object.keys(body) }, request.ip);
      await outbox(client, 'product.updated', 'product', id, { productId: id });
      return { id, updated: Object.keys(body) };
    });
  });

  app.patch('/api/v1/products/:id/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { status } = statusBody.parse(request.body);
    if (user.roles.includes('supplier') && status === 'published') {
      await assertSupplierMay(pool, user.id, 'product_publish', { resource: 'product', resourceId: id, ip: request.ip });
      const owned = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
      if (!owned || (owned.supplier_id && owned.supplier_id !== user.id)) throw forbidden();
    }
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
