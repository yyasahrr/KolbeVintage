import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { emitEvent } from './events.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { ensureContact } from './crm.js';
import { recordTimeline } from './crm-intelligence.js';

/* Product ratings & reviews (items 105-109).
   Real aggregation from real rows, verified purchase from paid orders, and
   moderation that only ever changes the review *status* — an admin cannot
   rewrite a rating value (item 107). */

const reviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(160).default(''),
  // Agent C (`body`) and Agent D1 (`comment`) both accepted; comment wins when both given.
  body: z.string().trim().max(4000).default(''),
  comment: z.string().trim().max(4000).default(''),
  // Agent C photo moderation (photo_file_ids) and Agent D1 images both accepted.
  photoFileIds: z.array(z.uuid()).max(4).default([]),
  images: z.array(z.string().trim().max(400)).max(6).default([]),
  orderId: z.uuid().nullable().optional(),
}).strict();

const moderateBody = z.object({
  action: z.enum(['approve', 'reject', 'hide', 'restore']),
  note: z.string().trim().max(500).optional(),
}).strict();

export async function productRatingSummary(client: DbClient, productId: string) {
  const row = await one<{ review_count: string; average: string | null; r1: string; r2: string; r3: string; r4: string; r5: string; verified: string }>(client,
    `SELECT count(*)::text AS review_count, avg(rating)::text AS average,
            count(*) FILTER (WHERE rating = 1)::text AS r1, count(*) FILTER (WHERE rating = 2)::text AS r2,
            count(*) FILTER (WHERE rating = 3)::text AS r3, count(*) FILTER (WHERE rating = 4)::text AS r4,
            count(*) FILTER (WHERE rating = 5)::text AS r5,
            count(*) FILTER (WHERE verified_purchase)::text AS verified
     FROM customer_reviews WHERE product_id = $1 AND status = 'approved'`, [productId]);
  const distribution = [1, 2, 3, 4, 5].map((star) => ({
    star, count: Number(row?.[`r${star}` as 'r1'] ?? 0),
  }));
  const count = Number(row?.review_count ?? 0);
  return {
    productId, reviewCount: count,
    averageRating: count ? Math.round(Number(row!.average) * 100) / 100 : null,
    verifiedCount: Number(row?.verified ?? 0),
    distribution,
    ratingPercent: count && row?.average ? Math.round((Number(row.average) / 5) * 1000) / 10 : null,
  };
}

export function registerReviewRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ------------------------------ customer side ------------------------------ */
  app.get('/api/v1/products/:id/reviews', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(10),
      rating: z.coerce.number().int().min(1).max(5).optional(),
      withImages: z.enum(['true', 'false']).default('false'),
    }).parse(request.query);
    const product = await one<{ status: string }>(pool, 'SELECT status FROM products WHERE id = $1', [id]);
    if (!product || product.status !== 'published') throw notFound();
    const rows = await pool.query(
      `SELECT r.id,r.rating,r.title,r.comment,r.body,r.images,r.photo_file_ids,
              r.verified_purchase,r.helpful_count,r.report_count,r.created_at,
              u.display_name, split_part(COALESCE(u.display_name,'کاربر کلبه'),' ',1) AS author_name,
              ARRAY(SELECT '/api/v1/media/' || f::text FROM unnest(r.photo_file_ids) f) AS photos
       FROM customer_reviews r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.product_id = $1 AND r.status = 'approved'
         AND ($2::int IS NULL OR r.rating = $2)
         AND (NOT $3::boolean OR jsonb_array_length(r.images) > 0 OR cardinality(r.photo_file_ids) > 0)
       ORDER BY r.verified_purchase DESC, r.helpful_count DESC, r.created_at DESC LIMIT $4`,
      [id, query.rating ?? null, query.withImages === 'true', query.limit]);
    const summary = await productRatingSummary(pool, id);
    return {
      items: rows.rows,
      // Superset summary: Agent C's shape (average/total/distribution with rating+n) and
      // Agent D1's shape (averageRating/reviewCount/ratingPercent with star+count).
      summary: {
        average: summary.averageRating ?? 0,
        total: summary.reviewCount,
        distribution: summary.distribution.map((d) => ({ star: d.star, count: d.count, rating: d.star, n: d.count })),
        productId: summary.productId,
        reviewCount: summary.reviewCount,
        averageRating: summary.averageRating,
        verifiedCount: summary.verifiedCount,
        ratingPercent: summary.ratingPercent,
      },
    };
  });

  app.get('/api/v1/products/:id/ratings', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return { summary: await productRatingSummary(pool, id) };
  });

  app.post('/api/v1/products/:id/reviews', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const user = await principal(request, pool, config);
    const body = reviewBody.parse(request.body);
    const commentText = body.comment || body.body;
    for (const text of [body.title, commentText]) if (/<[a-z!/]/i.test(text)) throw badRequest('HTML مجاز نیست.');
    const created = await transaction(pool, async (client) => {
      const product = await one<{ id: string; name: string; status: string }>(client,
        'SELECT id,name,status FROM products WHERE id = $1', [id]);
      if (!product) throw notFound();
      if (product.status !== 'published') throw badRequest('ثبت نظر برای این محصول فعال نیست.');
      // Agent C: only the reviewer's own uploaded images can be attached.
      if (body.photoFileIds.length) {
        const owned = await client.query(
          `SELECT id FROM files WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND mime_type IN ('image/jpeg','image/png','image/webp')`,
          [body.photoFileIds, user.id]);
        if (owned.rowCount !== new Set(body.photoFileIds).size) throw badRequest('فقط تصاویر JPG/PNG/WebP که خودتان بارگذاری‌کرده‌اید قابل پیوست هستند.');
      }
      // Verified purchase is derived from a real order — never claimed by the client.
      const purchase = await one<{ order_id: string }>(client,
        `SELECT o.id AS order_id FROM order_lines l JOIN orders o ON o.id = l.order_id
         WHERE l.product_id = $1 AND o.buyer_id = $2
           AND o.status IN ('paid','processing','preparing','ready_to_ship','in_transit','shipped','delivered')
         ORDER BY o.paid_at DESC NULLS LAST LIMIT 1`, [id, user.id]);
      if (body.orderId) {
        const qualifies = await one(client,
          `SELECT o.id FROM orders o JOIN order_lines l ON l.order_id = o.id
           WHERE o.id = $1 AND o.buyer_id = $2 AND l.product_id = $3
             AND o.status IN ('paid','processing','preparing','ready_to_ship','in_transit','shipped','delivered')`,
          [body.orderId, user.id, id]);
        if (!qualifies) throw badRequest('سفارش انتخاب‌شده خرید واجد شرایط این محصول نیست.');
      }
      const orderId = body.orderId ?? purchase?.order_id ?? null;
      const existing = await one(client,
        `SELECT id FROM customer_reviews WHERE product_id = $1 AND user_id = $2
           AND COALESCE(order_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [id, user.id, orderId]);
      if (existing) throw conflict('برای این محصول و سفارش قبلاً نظر ثبت کرده‌اید.');
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO customer_reviews(id,product_id,user_id,order_id,rating,title,body,comment,images,photo_file_ids,verified_purchase,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')`,
        [reviewId, id, user.id, orderId, body.rating, body.title, commentText, commentText,
          JSON.stringify(body.images), body.photoFileIds, Boolean(orderId)]);
      const contactId = await ensureContact(client, user.id);
      await client.query(
        `INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id,result,created_by)
         VALUES ($1,$2,'event','ثبت نظر محصول',$3,'customer_review',$4,$5,$6)`,
        [randomUUID(), contactId, `${product.name}: ${body.rating} ستاره`, reviewId,
          JSON.stringify({ rating: body.rating, verified: Boolean(purchase) }), user.id]);
      await recordTimeline(client, { userId: user.id, eventType: 'review.created', source: 'account',
        title: `نظر ${body.rating} ستاره برای ${product.name}`, description: undefined, refType: 'customer_review', refId: reviewId, actorId: user.id });
      await emitEvent(client, { eventType: 'review.created', entityType: 'product', entityId: id,
        payload: { reviewId, productId: id, userId: user.id, rating: body.rating, verifiedPurchase: Boolean(purchase) }, actorId: user.id });
      await outbox(client, 'review.created', 'product', id, { reviewId, productId: id, rating: body.rating });
      // Agent C's automation hook (review.submitted) stays live alongside review.created.
      await outbox(client, 'review.submitted', 'product', id, { productId: id, userId: user.id, rating: body.rating, verified: Boolean(purchase), photos: body.photoFileIds.length });
      for (const fileId of body.photoFileIds) await outbox(client, 'media.uploaded', 'review_photo', reviewId, { reviewId, fileId });
      return { reviewId, id: reviewId, status: 'pending', verifiedPurchase: Boolean(purchase), photos: body.photoFileIds.length };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/v1/reviews/:id/helpful', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await principal(request, pool, config);
    const updated = await pool.query(
      `UPDATE customer_reviews SET helpful_count = helpful_count + 1 WHERE id = $1 AND status = 'approved'
       RETURNING helpful_count`, [id]);
    if (!updated.rowCount) throw notFound();
    return { helpfulCount: updated.rows[0]!.helpful_count };
  });

  app.post('/api/v1/reviews/:id/report', async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const user = await principal(request, pool, config);
    const body = z.object({ reason: z.string().trim().min(3).max(300) }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const review = await one(client, 'SELECT id FROM customer_reviews WHERE id = $1', [id]);
      if (!review) throw notFound();
      const reportId = randomUUID();
      await client.query('INSERT INTO customer_review_reports(id,review_id,reporter_id,reason) VALUES ($1,$2,$3,$4)',
        [reportId, id, user.id, body.reason]);
      await client.query('UPDATE customer_reviews SET report_count = report_count + 1 WHERE id = $1', [id]);
      await audit(client, user.id, 'review.reported', 'customer_review', id, undefined, { reason: body.reason }, request.ip);
      return { reportId, status: 'open' };
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/customer/reviews', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT r.id,r.rating,r.title,r.comment,r.status,r.verified_purchase,r.created_at,r.moderation_note,p.name AS product_name
       FROM customer_reviews r JOIN products p ON p.id = r.product_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [user.id]);
    return { items: rows.rows };
  });

  /* ------------------------------- moderation ------------------------------- */
  app.get('/api/v1/admin/reviews', async (request) => {
    const user = await principal(request, pool, config);
    // Agent C console moderates with products:write, Agent D1 with reviews:moderate — either suffices.
    if (!user.permissions.includes('products:write') && !user.permissions.includes('reviews:moderate')) throw forbidden();
    const query = z.object({
      status: z.enum(['all', 'pending', 'approved', 'rejected', 'hidden']).optional(),
      rating: z.coerce.number().int().min(1).max(5).optional(),
      reported: z.enum(['true', 'false']).default('false'),
      limit: z.coerce.number().int().min(1).max(200).default(200),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT r.*, p.name AS product_name, u.display_name, u.phone AS customer_phone,
              (SELECT count(*)::int FROM customer_review_reports rep WHERE rep.review_id = r.id AND rep.status = 'open') AS open_reports
       FROM customer_reviews r JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = r.user_id
       WHERE ($1::text IS NULL OR $1 = 'all' OR r.status = $1) AND ($2::int IS NULL OR r.rating = $2)
         AND (NOT $3::boolean OR r.report_count > 0)
       ORDER BY r.created_at DESC LIMIT $4`, [
        query.status ?? null, query.rating ?? null, query.reported === 'true', query.limit]);
    return { items: rows.rows };
  });

  /** Moderation never touches `rating` — only the visibility status (item 107). */
  app.post('/api/v1/admin/reviews/:id/moderate', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'reviews:moderate');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = moderateBody.parse(request.body);
    const status = body.action === 'approve' ? 'approved' : body.action === 'reject' ? 'rejected'
      : body.action === 'hide' ? 'hidden' : 'pending';
    return transaction(pool, async (client) => {
      const before = await one<{ status: string; rating: number; product_id: string; user_id: string }>(client,
        'SELECT status,rating,product_id,user_id FROM customer_reviews WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE customer_reviews SET status = $2, moderation_note = $3, moderated_by = $4, moderated_at = now(), updated_at = now()
         WHERE id = $1`, [id, status, body.note ?? null, user.id]);
      if (status === 'approved') {
        await client.query(
          `UPDATE customer_review_reports SET status = 'resolved', resolved_by = $2, resolved_at = now()
           WHERE review_id = $1 AND status = 'open'`, [id, user.id]);
      }
      await audit(client, user.id, `review.${body.action}d`, 'customer_review', id,
        { status: before.status }, { status, note: body.note ?? null, ratingUntouched: before.rating }, request.ip);
      await recordTimeline(client, { userId: before.user_id, eventType: 'review.moderated', source: 'admin',
        title: `نظر شما ${status === 'approved' ? 'تأیید' : status === 'rejected' ? 'رد' : 'مخفی'} شد`,
        description: body.note ?? '', refType: 'customer_review', refId: id, actorId: user.id });
      return { id, status, rating: before.rating };
    });
  });

  app.get('/api/v1/admin/review-reports', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'reviews:moderate');
    const rows = await pool.query(
      `SELECT rep.id,rep.reason,rep.status,rep.created_at,rep.review_id,r.rating,r.title,r.status AS review_status,
              p.name AS product_name, u.display_name AS reporter_name
       FROM customer_review_reports rep JOIN customer_reviews r ON r.id = rep.review_id
       JOIN products p ON p.id = r.product_id LEFT JOIN users u ON u.id = rep.reporter_id
       ORDER BY (rep.status = 'open') DESC, rep.created_at DESC LIMIT 100`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/review-reports/:id/resolve', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'reviews:moderate');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['resolved', 'dismissed']) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const report = await one<{ id: string; review_id: string }>(client,
        'SELECT id,review_id FROM customer_review_reports WHERE id = $1 FOR UPDATE', [id]);
      if (!report) throw notFound();
      await client.query('UPDATE customer_review_reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1',
        [id, body.status, user.id]);
      await audit(client, user.id, 'review.report_resolved', 'customer_review', report.review_id, undefined, { status: body.status }, request.ip);
      return { id, status: body.status };
    });
  });

  /** Requirement 109: real rating analytics for the product admin. */
  app.get('/api/v1/admin/products/:id/review-analytics', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'reviews:moderate');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const summary = await productRatingSummary(pool, id);
    const monthly = await pool.query(
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS count,
              round(avg(rating)::numeric, 2)::text AS average
       FROM customer_reviews WHERE product_id = $1 AND status = 'approved'
       GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, [id]);
    const moderation = await one<{ pending: string; rejected: string; hidden: string }>(pool,
      `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE status = 'rejected')::text AS rejected,
              count(*) FILTER (WHERE status = 'hidden')::text AS hidden
       FROM customer_reviews WHERE product_id = $1`, [id]);
    const keywords = await pool.query<{ comment: string }>(
      `SELECT comment FROM customer_reviews WHERE product_id = $1 AND status = 'approved' AND length(comment) > 12
       ORDER BY created_at DESC LIMIT 200`, [id]);
    // Topic extraction is deliberately simple today and replaceable by an NLP job later.
    const stopWords = new Set(['برای', 'خیلی', 'این', 'که', 'با', 'هم', 'در', 'و', 'از', 'یک', 'بسیار', 'بود', 'است', 'را', 'به', 'کیفیت']);
    const frequency = new Map<string, number>();
    for (const row of keywords.rows) {
      for (const word of row.comment.split(/[\s،.,!؟?؛;:()"'«»]+/)) {
        const token = word.trim();
        if (token.length < 3 || stopWords.has(token)) continue;
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
      }
    }
    const topics = [...frequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));
    return {
      summary: await summary, monthly: monthly.rows, moderation,
      topics, topicsNote: 'استخراج موضوع فعلاً فراوانی واژه است و می‌تواند با سرویس NLP جایگزین شود.',
    };
  });

  app.get('/api/v1/admin/reviews/analytics/overall', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'reviews:moderate');
    const totals = await one<Record<string, string>>(pool,
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'pending')::text AS pending,
              count(*) FILTER (WHERE verified_purchase)::text AS verified,
              round(avg(rating) FILTER (WHERE status = 'approved')::numeric, 2)::text AS average
       FROM customer_reviews`);
    const topProducts = await pool.query(
      `SELECT p.id, p.name, count(*)::int AS review_count, round(avg(r.rating)::numeric, 2)::text AS average
       FROM customer_reviews r JOIN products p ON p.id = r.product_id
       WHERE r.status = 'approved' GROUP BY p.id, p.name HAVING count(*) >= 1
       ORDER BY count(*) DESC LIMIT 10`);
    const lowRated = await pool.query(
      `SELECT p.id, p.name, count(*)::int AS one_star, (SELECT count(*)::int FROM customer_reviews x WHERE x.product_id = p.id AND x.status = 'approved') AS review_count
       FROM customer_reviews r JOIN products p ON p.id = r.product_id
       WHERE r.status = 'approved' AND r.rating <= 2 GROUP BY p.id, p.name ORDER BY one_star DESC LIMIT 10`);
    return { totals, topProducts: topProducts.rows, lowRated: lowRated.rows };
  });
}
