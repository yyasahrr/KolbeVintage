import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import type { DbPool } from './db.js';
import { asRial } from './money.js';

/**
 * OMS read models (§18-§23, §30-§32).
 *
 * «سفارشات خرده» is ONE operational table over TWO existing write domains:
 * website orders (orders/order_lines/payment_intents/shipments) and manual sales
 * (manual_sales/manual_sale_payments). This endpoint is a READ MODEL ONLY — it
 * reconciles them for the OMS console without creating a second order system.
 * Sales channel: website orders are the 'website' channel by definition; manual
 * sales carry their own commercial channel (§22). Writes keep flowing through
 * the existing domains (checkout, manual-sales API, transitions, shipments).
 */
export function registerOmsRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/oms/retail-sales', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'orders:read');
    const query = z.object({
      search: z.string().trim().max(120).optional(),
      channel: z.enum(['website', 'instagram', 'in_person', 'phone', 'whatsapp', 'telegram', 'other']).optional(),
      paymentStatus: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'none']).optional(),
      kind: z.enum(['order', 'manual_sale']).optional(),
      status: z.string().trim().max(40).optional(),
      hasTracking: z.coerce.number().int().min(0).max(1).optional(),
      problem: z.coerce.number().int().min(0).max(1).optional(),
      dateFrom: z.iso.datetime().optional(),
      dateTo: z.iso.datetime().optional(),
      amountMinRial: z.string().regex(/^\d+$/).optional(),
      amountMaxRial: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(request.query);

    const rows = await pool.query(
      `WITH unified AS (
         SELECT 'order'::text AS kind, o.id, o.reference, o.created_at,
                u.display_name AS buyer_name, u.phone AS buyer_phone,
                'website'::text AS channel,
                (SELECT count(*)::int FROM order_lines l WHERE l.order_id = o.id) AS lines_count,
                o.total_rial::text AS total_rial,
                CASE WHEN o.payment_mode = 'four_installments' THEN 'installments' ELSE 'gateway' END AS payment_method,
                (SELECT pi.provider FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1) AS payment_provider,
                COALESCE((SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1), 'none') AS payment_status,
                o.status AS status,
                sh.status AS shipment_status,
                COALESCE(sh.tracking_code, o.vip_tracking_code, o.tracking_code) AS tracking_code,
                COALESCE(sh.carrier, o.vip_carrier) AS carrier,
                ARRAY_REMOVE(ARRAY[
                  CASE WHEN (SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1) = 'failed' THEN 'payment_failed'::text END,
                  CASE WHEN o.status = 'pending_payment' AND o.created_at < now() - interval '24 hours' THEN 'payment_overdue'::text END,
                  CASE WHEN o.status IN ('in_transit','shipped') AND COALESCE(sh.tracking_code, o.vip_tracking_code, o.tracking_code) IS NULL THEN 'missing_tracking'::text END,
                  CASE WHEN o.status NOT IN ('delivered','cancelled','returned') AND COALESCE(o.shipping_address->>'postalCode','') !~ '^\\d{10}$' THEN 'invalid_address'::text END
                ], NULL) AS exception_reasons
         FROM orders o
         LEFT JOIN users u ON u.id = o.buyer_id
         LEFT JOIN LATERAL (
           SELECT s.carrier, s.tracking_code, s.status FROM shipments s WHERE s.order_id = o.id ORDER BY s.created_at DESC LIMIT 1
         ) sh ON true
         WHERE o.order_type = 'retail'
         UNION ALL
         SELECT 'manual_sale'::text, ms.id, ms.reference, ms.created_at,
                COALESCE(u2.display_name, NULLIF(ms.customer_name, '')) AS buyer_name,
                COALESCE(u2.phone, NULLIF(ms.customer_phone, '')) AS buyer_phone,
                ms.channel,
                (SELECT count(*)::int FROM manual_sale_lines ml WHERE ml.sale_id = ms.id) AS lines_count,
                ms.total_rial::text,
                (SELECT mp.payment_method FROM manual_sale_payments mp WHERE mp.sale_id = ms.id ORDER BY mp.created_at DESC LIMIT 1) AS payment_method,
                NULL::text AS payment_provider,
                CASE COALESCE((SELECT mp.verification_status FROM manual_sale_payments mp WHERE mp.sale_id = ms.id ORDER BY mp.created_at DESC LIMIT 1), 'pending_verification')
                  WHEN 'verified' THEN 'succeeded' WHEN 'rejected' THEN 'failed' ELSE 'pending' END AS payment_status,
                ms.status AS status,
                NULL::text AS shipment_status, NULL::text AS tracking_code, NULL::text AS carrier,
                ARRAY_REMOVE(ARRAY[
                  CASE WHEN ms.status = 'pending_verification' THEN 'payment_unverified'::text END
                ], NULL) AS exception_reasons
         FROM manual_sales ms
         LEFT JOIN users u2 ON u2.id = ms.customer_id
       )
       SELECT *, count(*) OVER()::int AS total_rows FROM unified
       WHERE ($1::text IS NULL OR reference ILIKE '%' || $1 || '%' OR buyer_name ILIKE '%' || $1 || '%'
              OR buyer_phone ILIKE '%' || $1 || '%' OR tracking_code ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR channel = $2)
         AND ($3::text IS NULL OR payment_status = $3)
         AND ($4::text IS NULL OR kind = $4)
         AND ($5::text IS NULL OR status = $5)
         AND ($6::integer IS NULL OR ($6 = 1 AND tracking_code IS NOT NULL) OR ($6 = 0 AND tracking_code IS NULL))
         AND ($7::integer IS NULL OR $7 = 0 OR cardinality(exception_reasons) > 0)
         AND ($8::timestamptz IS NULL OR created_at >= $8)
         AND ($9::timestamptz IS NULL OR created_at <= $9)
         AND ($10::bigint IS NULL OR total_rial::bigint >= $10)
         AND ($11::bigint IS NULL OR total_rial::bigint <= $11)
       ORDER BY created_at DESC LIMIT $12 OFFSET $13`,
      [query.search ?? null, query.channel ?? null, query.paymentStatus ?? null, query.kind ?? null,
        query.status ?? null, query.hasTracking ?? null, query.problem ?? null,
        query.dateFrom ?? null, query.dateTo ?? null, query.amountMinRial ?? null, query.amountMaxRial ?? null,
        query.limit, query.offset]);

    const total = rows.rows.length ? Number(rows.rows[0].total_rows) : 0;
    return {
      items: rows.rows.map(({ total_rows: _ignored, ...row }) => ({ ...row, total_rial: asRial(row.total_rial) })),
      total, limit: query.limit, offset: query.offset,
    };
  });
}
