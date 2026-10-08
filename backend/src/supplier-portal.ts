/** Prompt 5 — tenant-scoped Supplier Portal read models.
 *
 * Every projection is derived from the existing supplier profile, catalog, series, WMS, offer,
 * supplier-request, and canonical OMS tables. No shadow request/order/inventory store is created.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requireApprovedActiveSupplier } from './auth.js';
import { one, type DbPool } from './db.js';

export function registerSupplierPortalRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/supplier/portal/dashboard', async (request) => {
    const user = await principal(request, pool, config);
    const profile = await requireApprovedActiveSupplier(pool, user);
    const [products, oms, capacity, stock] = await Promise.all([
      one<{ published: number; pending: number; total: number; series_count: number }>(pool,
        `SELECT count(*) FILTER (WHERE p.status = 'published')::int AS published,
                count(*) FILTER (WHERE p.status IN ('pending','draft'))::int AS pending,
                count(*)::int AS total,
                (SELECT count(*)::int FROM series_templates t JOIN products sp ON sp.id = t.product_id
                  WHERE sp.supplier_id = $1) AS series_count
         FROM products p WHERE p.supplier_id = $1 AND p.owner_type = 'supplier'`, [user.id]),
      one<{ open_requests: number; committed_series: number; ready_series: number; history_count: number }>(pool,
        `SELECT count(*) FILTER (WHERE a.status = 'pending' AND l.status = 'awaiting_supplier'
                                  AND l.supplier_response_status = 'unanswered')::int AS open_requests,
                COALESCE(sum(l.supplier_committed_series) FILTER (WHERE l.supplier_response_status IN ('committed','ready')),0)::int AS committed_series,
                COALESCE(sum(l.supplier_committed_series) FILTER (WHERE l.supplier_ready_at IS NOT NULL),0)::int AS ready_series,
                count(*)::int AS history_count
         FROM order_source_allocations a
         JOIN child_order_lines l ON l.id = a.line_id AND l.seller_id = $1
         JOIN orders o ON o.id = a.child_order_id
         WHERE a.owner_supplier_id = $1 AND a.source_type = 'supplier_external'
           AND o.master_order_id IS NOT NULL`, [user.id]),
      one<{ declared: number; reserved: number; available: number }>(pool,
        `SELECT COALESCE(sum(declared_capacity),0)::int AS declared,
                COALESCE(sum(reserved_external),0)::int AS reserved,
                COALESCE(sum(GREATEST(0, declared_capacity - reserved_external - safety_buffer)),0)::int AS available
         FROM supplier_offers WHERE supplier_id = $1 AND status <> 'archived'`, [user.id]),
      one<{ series: number }>(pool,
        `SELECT COALESCE(sum(GREATEST(0, on_hand - reserved - damaged)),0)::int AS series
         FROM series_stock_balances WHERE owner_type = 'supplier' AND supplier_id = $1`, [user.id]),
    ]);
    return {
      supplier: { id: user.id, brandName: profile.brand_name, cooperationStatus: profile.cooperation_status, activityStatus: profile.activity_status },
      products: { published: products?.published ?? 0, pending: products?.pending ?? 0, total: products?.total ?? 0, series: products?.series_count ?? 0 },
      supplyRequests: { open: oms?.open_requests ?? 0, committedSeries: oms?.committed_series ?? 0, readySeries: oms?.ready_series ?? 0, history: oms?.history_count ?? 0 },
      capacity: { declared: capacity?.declared ?? 0, reserved: capacity?.reserved ?? 0, availableToRequest: capacity?.available ?? 0 },
      stockAtKolbeSeries: stock?.series ?? 0,
    };
  });

  /** Supplier-owned catalog only; includes unpublished products and canonical series summaries. */
  app.get('/api/v1/supplier/portal/products', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.status, p.wholesale_enabled, p.created_at,
              COALESCE(json_agg(json_build_object(
                'id', t.id, 'name', t.name, 'colorLabel', t.color_label, 'active', t.active,
                'pricingMode', t.pricing_mode, 'minOrderSeries', t.min_order_series,
                'seriesCount', COALESCE((SELECT sum(i.quantity_per_series)::int FROM series_template_items i WHERE i.series_template_id = t.id),0),
                'pricePerSeriesRial', CASE
                  WHEN t.pricing_mode = 'series_total' THEN t.total_price_rial::text
                  WHEN t.pricing_mode = 'component_sum' THEN COALESCE((SELECT sum(i.unit_price_rial * i.quantity_per_series)::text FROM series_template_items i WHERE i.series_template_id = t.id),'0')
                  ELSE (COALESCE((SELECT sum(i.quantity_per_series) FROM series_template_items i WHERE i.series_template_id = t.id),0) * p.wholesale_price_rial)::text
                END,
                'items', COALESCE((SELECT json_agg(json_build_object(
                    'size', v.size_label, 'quantityPerSeries', i.quantity_per_series,
                    'unitPriceRial', i.unit_price_rial::text) ORDER BY v.size_label)
                  FROM series_template_items i JOIN product_variants v ON v.id = i.variant_id
                  WHERE i.series_template_id = t.id), '[]'::json)
              ) ORDER BY t.created_at) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS series,
              COALESCE((SELECT json_agg(DISTINCT v.color_label) FROM product_variants v
                         WHERE v.product_id = p.id AND v.color_label IS NOT NULL), '[]'::json) AS colors,
              COALESCE((SELECT json_agg(DISTINCT v.size_label) FROM product_variants v
                         WHERE v.product_id = p.id AND v.size_label IS NOT NULL), '[]'::json) AS sizes
       FROM products p
       LEFT JOIN series_templates t ON t.product_id = p.id
       WHERE p.supplier_id = $1 AND p.owner_type = 'supplier'
       GROUP BY p.id ORDER BY p.updated_at DESC, p.id LIMIT $2`, [user.id, query.limit]);
    return { items: rows.rows };
  });

  /** Read-only operations history for this supplier's own OMS allocations. */
  app.get('/api/v1/supplier/portal/history', async (request) => {
    const user = await principal(request, pool, config);
    await requireApprovedActiveSupplier(pool, user);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT a.id AS "allocationId", l.id AS "lineId", o.id AS "childOrderId",
              o.reference AS "orderReference", o.status AS "orderStatus", o.status AS "childStatus",
              o.payment_eligibility AS "paymentEligibility", o.child_fulfillment AS "childFulfillment",
              p.name AS "productName", t.name AS "seriesName", t.color_label AS "colorLabel",
              a.quantity AS "requestedSeries", a.quantity AS "externalSeries",
              l.proposed_series AS "proposedSeries", l.confirmed_series AS "confirmedSeries",
              l.status AS "lineStatus", a.status AS "allocationStatus",
              l.supplier_response_status AS "responseStatus", l.supplier_response_note AS "responseNote",
              l.supplier_committed_series AS "committedSeries", l.supplier_responded_at AS "respondedAt",
              l.supplier_committed_at AS "committedAt", l.supplier_ready_at AS "readyAt",
              a.created_at AS "createdAt", a.updated_at AS "updatedAt"
       FROM order_source_allocations a
       JOIN child_order_lines l ON l.id = a.line_id AND l.seller_id = $1
       JOIN orders o ON o.id = a.child_order_id
       JOIN products p ON p.id = l.product_id
       JOIN series_templates t ON t.id = l.series_template_id
       WHERE a.owner_supplier_id = $1 AND a.source_type = 'supplier_external'
         AND o.master_order_id IS NOT NULL
       ORDER BY GREATEST(a.updated_at, l.updated_at) DESC, a.created_at DESC LIMIT $2`, [user.id, query.limit]);
    return { items: rows.rows };
  });
}
