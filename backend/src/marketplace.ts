import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Wholesale marketplace review (item 3): a complete review page source with
   product details, supplier data, prices, stock, documents, specs and a
   decision history — plus publishing rules that protect buyers. */

const documentBody = z.object({
  docType: z.enum(['image', 'video', 'certificate', 'spec_sheet', 'other']),
  title: z.string().trim().min(2).max(200),
  fileMeta: z.record(z.string(), z.unknown()).default({}),
}).strict();

const reviewBody = z.object({
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  documentsChecked: z.boolean().default(false),
  checklist: z.record(z.string(), z.boolean()).default({}),
  note: z.string().trim().max(2000).optional(),
}).strict();

export function registerMarketplaceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/marketplace/products', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const query = z.object({
      status: z.enum(['draft', 'pending', 'published', 'rejected', 'archived']).optional(),
      category: z.string().max(120).optional(),
      supplierId: z.uuid().optional(),
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT p.id,p.brand,p.name,p.category,p.status,p.cash_price_rial,p.installment_price_rial,
              p.wholesale_price_rial,p.supplier_id,p.created_at,p.updated_at,
              s.brand_name AS supplier_brand, s.cooperation_status,
              (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variant_count,
              (SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged), 0)::int FROM stock_balances b
                JOIN product_variants v ON v.id = b.variant_id WHERE v.product_id = p.id) AS available_stock,
              (SELECT count(*)::int FROM product_reviews r WHERE r.product_id = p.id) AS review_count,
              (SELECT r.decision FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_decision
       FROM products p LEFT JOIN supplier_profiles s ON s.user_id = p.supplier_id
       WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.category = $2)
         AND ($3::uuid IS NULL OR p.supplier_id = $3)
         AND ($4::text IS NULL OR p.name ILIKE '%' || $4 || '%' OR p.brand ILIKE '%' || $4 || '%')
       ORDER BY p.updated_at DESC LIMIT $5`,
      [query.status ?? null, query.category ?? null, query.supplierId ?? null, query.search ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({
      ...row,
      cash_price_rial: asRial(row.cash_price_rial),
      installment_price_rial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
      wholesale_price_rial: row.wholesale_price_rial === null ? null : asRial(row.wholesale_price_rial),
    })) };
  });

  app.get('/api/v1/admin/marketplace/products/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<Record<string, unknown>>(pool,
      `SELECT p.*, s.brand_name AS supplier_brand, s.legal_name AS supplier_legal_name, s.national_id AS supplier_national_id,
              s.cooperation_status, s.product_categories AS supplier_categories, s.business_phone AS supplier_phone,
              s.mobile AS supplier_mobile, s.email AS supplier_email, s.commission_percent,
              u.display_name AS supplier_display_name
       FROM products p LEFT JOIN supplier_profiles s ON s.user_id = p.supplier_id
       LEFT JOIN users u ON u.id = p.supplier_id WHERE p.id = $1`, [id]);
    if (!product) throw notFound();
    const variants = await pool.query(
      `SELECT v.id,v.sku,v.size_label,v.color_label,v.attributes,v.active,
              COALESCE(sum(b.on_hand), 0)::int AS on_hand, COALESCE(sum(b.reserved), 0)::int AS reserved,
              COALESCE(sum(b.incoming), 0)::int AS incoming, COALESCE(sum(b.damaged), 0)::int AS damaged
       FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.product_id = $1 GROUP BY v.id ORDER BY v.sku`, [id]);
    const documents = await pool.query(
      'SELECT id,doc_type,title,file_meta,created_at FROM product_documents WHERE product_id = $1 ORDER BY created_at DESC', [id]);
    const reviews = await pool.query(
      `SELECT r.id,r.decision,r.documents_checked,r.checklist,r.note,r.created_at,u.display_name AS reviewer_name
       FROM product_reviews r LEFT JOIN users u ON u.id = r.reviewer_id
       WHERE r.product_id = $1 ORDER BY r.created_at DESC`, [id]);
    return {
      ...product,
      cash_price_rial: asRial(String(product.cash_price_rial)),
      installment_price_rial: product.installment_price_rial === null ? null : asRial(String(product.installment_price_rial)),
      wholesale_price_rial: product.wholesale_price_rial === null ? null : asRial(String(product.wholesale_price_rial)),
      variants: variants.rows, documents: documents.rows, reviews: reviews.rows,
    };
  });

  app.post('/api/v1/products/:id/documents', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = documentBody.parse(request.body);
    const product = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    const isSupplierOwner = product.supplier_id === user.id && user.roles.includes('supplier');
    if (!isSupplierOwner) requirePermission(user, 'products:write');
    const docId = randomUUID();
    await pool.query('INSERT INTO product_documents(id,product_id,doc_type,title,file_meta,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [docId, id, body.docType, body.title, JSON.stringify(body.fileMeta), user.id]);
    await transaction(pool, (client) => audit(client, user.id, 'product.document_added', 'product_document', docId,
      undefined, { productId: id, title: body.title }, request.ip));
    return reply.code(201).send({ id: docId, productId: id, ...body });
  });

  /** Review decisions enforce publishing rules: supplier products cannot reach
   *  the marketplace without a checked-document approval (item 3). */
  app.post('/api/v1/admin/marketplace/products/:id/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = reviewBody.parse(request.body);
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; status: string; supplier_id: string | null; name: string }>(client,
        'SELECT id, status, supplier_id, name FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();
      if (product.status === 'archived') throw conflict('محصول بایگانی‌شده قابل بازبینی نیست.');
      if (body.decision === 'approved' && product.supplier_id && !body.documentsChecked)
        throw badRequest('تأیید محصول تأمین‌کننده بدون بررسی مدارک مجاز نیست.');
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO product_reviews(id,product_id,reviewer_id,decision,documents_checked,checklist,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [reviewId, id, user.id, body.decision, body.documentsChecked, JSON.stringify(body.checklist), body.note ?? null]);
      const nextStatus = body.decision === 'approved' ? 'published' : body.decision === 'rejected' ? 'rejected' : 'draft';
      await client.query('UPDATE products SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, nextStatus]);
      await audit(client, user.id, 'product.reviewed', 'product', id,
        { status: product.status }, { status: nextStatus, decision: body.decision, note: body.note ?? null }, request.ip);
      await outbox(client, 'product.reviewed', 'product', id, { productId: id, decision: body.decision, status: nextStatus });
      return { id, reviewId, decision: body.decision, status: nextStatus };
    });
  });
}
