import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { asRial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Wholesale marketplace review (item 3): a complete review page source with
   product details, supplier data, prices, stock, documents, specs and a
   decision history — plus publishing rules that protect buyers.
   Rejections always carry a persisted reason + free-text detail, notify the
   supplier, and can be resubmitted after fixes. */

const documentBody = z.object({
  docType: z.enum(['image', 'video', 'certificate', 'spec_sheet', 'other']),
  title: z.string().trim().min(2).max(200),
  fileMeta: z.record(z.string(), z.unknown()).default({}),
}).strict();

const reviewBody = z.object({
  decision: z.enum(['approved', 'rejected', 'changes_requested']),
  documentsChecked: z.boolean().default(false),
  checklist: z.record(z.string(), z.boolean()).default({}),
  reasonCode: z.string().trim().max(40).optional(),
  note: z.string().trim().max(2000).optional(),
}).strict();

/** In-app notification hung off its triggering outbox event (audit-able). */
async function notifyUser(client: PoolClient, userId: string, title: string, body: string, eventType: string, aggregateType: string, aggregateId: string, payload: unknown, priority: 'low' | 'normal' | 'high' = 'normal') {
  const eventId = randomUUID();
  await client.query('INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,payload) VALUES ($1,$2,$3,$4,$5)',
    [eventId, eventType, aggregateType, aggregateId, JSON.stringify(payload)]);
  await client.query('INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), userId, eventId, title, body, priority]);
}

export function registerMarketplaceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/marketplace/review-reasons', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const rows = await pool.query('SELECT code, label, position FROM product_review_reasons WHERE active = true ORDER BY position, label');
    return { items: rows.rows };
  });

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
              (SELECT r.decision FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_decision,
              (SELECT r.reason_label FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_reason,
              (SELECT r.created_at FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_reviewed_at
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
      `SELECT v.id,v.sku,v.size_label,v.color_label,v.weight_grams,v.attributes,v.active,
              COALESCE(sum(b.on_hand), 0)::int AS on_hand, COALESCE(sum(b.reserved), 0)::int AS reserved,
              COALESCE(sum(b.incoming), 0)::int AS incoming, COALESCE(sum(b.damaged), 0)::int AS damaged
       FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.product_id = $1 GROUP BY v.id ORDER BY v.sku`, [id]);
    const documents = await pool.query(
      'SELECT id,doc_type,title,file_meta,created_at FROM product_documents WHERE product_id = $1 ORDER BY created_at DESC', [id]);
    const reviews = await pool.query(
      `SELECT r.id,r.decision,r.documents_checked,r.checklist,r.reason_code,r.reason_label,r.note,r.created_at,u.display_name AS reviewer_name
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
      // Master §55: request-changes also needs an explanation the supplier can act on.
      if (body.decision === 'changes_requested' && !body.reasonCode && !(body.note && body.note.trim().length >= 3))
        throw badRequest('درخواست اصلاح بدون دلیل یا توضیح مجاز نیست.');
      let reasonLabel: string | null = null;
      if (body.decision === 'rejected') {
        if (!body.reasonCode) throw badRequest('رد محصول بدون انتخاب دلیل مجاز نیست.');
        const reason = await one<{ label: string }>(client,
          'SELECT label FROM product_review_reasons WHERE code = $1 AND active = true', [body.reasonCode]);
        if (!reason) throw badRequest('دلیل رد انتخاب‌شده معتبر نیست.');
        reasonLabel = reason.label;
      } else if (body.reasonCode) {
        const reason = await one<{ label: string }>(client,
          'SELECT label FROM product_review_reasons WHERE code = $1 AND active = true', [body.reasonCode]);
        if (reason) reasonLabel = reason.label;
      }
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO product_reviews(id,product_id,reviewer_id,decision,documents_checked,checklist,reason_code,reason_label,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [reviewId, id, user.id, body.decision, body.documentsChecked, JSON.stringify(body.checklist),
          body.reasonCode ?? null, reasonLabel, body.note ?? null]);
      const nextStatus = body.decision === 'approved' ? 'published' : body.decision === 'rejected' ? 'rejected' : 'draft';
      await client.query('UPDATE products SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, nextStatus]);
      await audit(client, user.id, 'product.reviewed', 'product', id,
        { status: product.status }, { status: nextStatus, decision: body.decision, reasonCode: body.reasonCode ?? null, note: body.note ?? null }, request.ip);
      await outbox(client, 'product.reviewed', 'product', id, { productId: id, decision: body.decision, status: nextStatus });
      if (product.supplier_id) {
        const title = body.decision === 'approved' ? `محصول «${product.name}» تأیید و منتشر شد`
          : body.decision === 'rejected' ? `محصول «${product.name}» رد شد` : `محصول «${product.name}» نیازمند اصلاح است`;
        const lines = [
          body.decision === 'approved' ? 'محصول شما پس از بازبینی در بازارچه عمده منتشر شد.' :
            body.decision === 'rejected' ? 'محصول شما در بازبینی رد شد. پس از اصلاح می‌توانید دوباره ارسال کنید.' :
              'بازبین برای انتشار محصول اصلاحاتی لازم می‌داند.',
        ];
        if (reasonLabel) lines.push(`دلیل: ${reasonLabel}`);
        if (body.note) lines.push(`توضیح بازبین: ${body.note}`);
        await notifyUser(client, product.supplier_id, title, lines.join('\n'), 'product.reviewed', 'product', id,
          { productId: id, decision: body.decision, status: nextStatus, reasonCode: body.reasonCode ?? null },
          body.decision === 'approved' ? 'normal' : 'high');
      }
      return { id, reviewId, decision: body.decision, status: nextStatus, reasonCode: body.reasonCode ?? null, reasonLabel };
    });
  });

  /** Master §54-§56: archive from the review workspace — server-side + audited.
   *  Archiving only changes catalogue status; stock is NEVER mutated here. */
  app.post('/api/v1/admin/marketplace/products/:id/archive', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; status: string; supplier_id: string | null; name: string }>(client,
        'SELECT id, status, supplier_id, name FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();
      if (product.status === 'archived') throw conflict('محصول قبلاً بایگانی شده است.');
      await client.query(`UPDATE products SET status = 'archived', version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'product.archived', 'product', id,
        { status: product.status }, { status: 'archived', reason: body.reason }, request.ip);
      await outbox(client, 'product.archived', 'product', id, { productId: id, reason: body.reason });
      if (product.supplier_id) {
        await notifyUser(client, product.supplier_id, `محصول «${product.name}» بایگانی شد`,
          `دلیل: ${body.reason}`, 'product.archived', 'product', id, { productId: id }, 'normal');
      }
      return { id, status: 'archived' };
    });
  });

  // ---------- Supplier self-service: own products, review reasons, resubmit ----------
  app.get('/api/v1/supplier/products', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      status: z.enum(['draft', 'pending', 'published', 'rejected', 'archived']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT p.id,p.brand,p.name,p.category,p.status,p.cash_price_rial,p.installment_price_rial,
              p.wholesale_price_rial,p.wholesale_moq,p.product_type_id,p.created_at,p.updated_at,
              (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variant_count,
              (SELECT r.decision FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_decision,
              (SELECT r.reason_label FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_reason,
              (SELECT r.note FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_note,
              (SELECT r.created_at FROM product_reviews r WHERE r.product_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_reviewed_at
       FROM products p WHERE p.supplier_id = $1 AND ($2::text IS NULL OR p.status = $2)
       ORDER BY p.updated_at DESC LIMIT $3`, [user.id, query.status ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({
      ...row,
      cash_price_rial: asRial(row.cash_price_rial),
      installment_price_rial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
      wholesale_price_rial: row.wholesale_price_rial === null ? null : asRial(row.wholesale_price_rial),
    })) };
  });

  app.get('/api/v1/supplier/products/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<Record<string, unknown>>(pool,
      'SELECT * FROM products WHERE id = $1 AND supplier_id = $2', [id, user.id]);
    if (!product) throw notFound();
    const variants = await pool.query(
      'SELECT id,sku,size_label,color_label,weight_grams,attributes,active FROM product_variants WHERE product_id = $1 ORDER BY sku', [id]);
    const documents = await pool.query(
      'SELECT id,doc_type,title,file_meta,created_at FROM product_documents WHERE product_id = $1 ORDER BY created_at DESC', [id]);
    const reviews = await pool.query(
      `SELECT r.id,r.decision,r.reason_code,r.reason_label,r.note,r.created_at,u.display_name AS reviewer_name
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

  /** After fixing a rejection the supplier resubmits the product for review. */
  app.post('/api/v1/supplier/products/:id/resubmit', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; status: string; name: string }>(client,
        'SELECT id, status, name FROM products WHERE id = $1 AND supplier_id = $2 FOR UPDATE', [id, user.id]);
      if (!product) throw notFound();
      if (product.status !== 'rejected' && product.status !== 'draft') {
        if (product.status === 'pending') return { id, status: 'pending', resubmitted: false };
        throw conflict('فقط محصول ردشده یا پیش‌نویس قابل ارسال مجدد برای بازبینی است.');
      }
      await client.query("UPDATE products SET status = 'pending', version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await audit(client, user.id, 'product.resubmitted', 'product', id, { status: product.status }, { status: 'pending' }, request.ip);
      await outbox(client, 'product.resubmitted', 'product', id, { productId: id });
      return { id, status: 'pending', resubmitted: true };
    });
  });

  /** Privileged users may resubmit on behalf of the supplier (same rule). */
  app.post('/api/v1/admin/marketplace/products/:id/resubmit', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'marketplace:review');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; status: string }>(client, 'SELECT id, status FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();
      if (product.status !== 'rejected' && product.status !== 'draft') throw conflict('فقط محصول ردشده یا پیش‌نویس قابل ارسال مجدد است.');
      await client.query("UPDATE products SET status = 'pending', version = version + 1, updated_at = now() WHERE id = $1", [id]);
      await audit(client, user.id, 'product.resubmitted', 'product', id, { status: product.status }, { status: 'pending' }, request.ip);
      await outbox(client, 'product.resubmitted', 'product', id, { productId: id });
      return { id, status: 'pending', resubmitted: true };
    });
  });

  // Suppliers see the same reason catalogue so the portal can explain decisions.
  app.get('/api/v1/marketplace/review-reasons', async (request) => {
    await principal(request, pool, config);
    const rows = await pool.query('SELECT code, label, position FROM product_review_reasons WHERE active = true ORDER BY position, label');
    return { items: rows.rows };
  });
}

// Re-exported for reuse by other modules that notify users (imports, orders).
export { notifyUser };
