import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal } from './auth.js';
import type { DbPool } from './db.js';
import { asRial } from './money.js';
import { notFound, forbidden, conflict } from './errors.js';

export function registerSupplierReportRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/supplier/stats', async (request) => {
    const user = await principal(request, pool, config);
    // supplier isolation: only own data unless admin
    const range = z.object({
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      period: z.enum(['7d','30d','3m','6m','1y','custom']).default('30d'),
    }).parse(request.query);
    let from: Date | null = range.from ? new Date(range.from) : null;
    let to: Date | null = range.to ? new Date(range.to) : null;
    if (!from) {
      const map: Record<string, number> = { '7d': 7, '30d': 30, '3m': 90, '6m': 180, '1y': 365 };
      const days = map[range.period] ?? 30;
      from = new Date(Date.now() - days * 86400_000);
    }
    if (!to) to = new Date();

    // Sales aggregations from orders where supplier's products are involved
    const isPrivileged = user.permissions.includes('suppliers:manage');
    const supplierId = user.id;

    const sales = await pool.query(
      `SELECT
         COUNT(DISTINCT o.id)::int AS orders_count,
         COALESCE(SUM(o.total_rial),0)::text AS revenue_rial,
         COALESCE(AVG(o.total_rial),0)::text AS avg_order_rial,
         COALESCE(SUM(CASE WHEN o.created_at >= now() - interval '1 day' THEN o.total_rial ELSE 0 END),0)::text AS sales_today,
         COALESCE(SUM(CASE WHEN o.created_at >= now() - interval '7 days' THEN o.total_rial ELSE 0 END),0)::text AS sales_week,
         COALESCE(SUM(CASE WHEN o.created_at >= now() - interval '30 days' THEN o.total_rial ELSE 0 END),0)::text AS sales_month,
         COALESCE(SUM(CASE WHEN o.created_at >= now() - interval '365 days' THEN o.total_rial ELSE 0 END),0)::text AS sales_year,
         COUNT(CASE WHEN o.status = 'returned' THEN 1 END)::int AS returned_orders
       FROM orders o JOIN order_lines l ON l.order_id = o.id
       WHERE ($1::boolean OR l.supplier_id = $2) AND o.created_at BETWEEN $3 AND $4 AND o.status <> 'cancelled'`,
      [isPrivileged, supplierId, from.toISOString(), to.toISOString()]);

    const topProducts = await pool.query(
      `SELECT l.product_name, l.sku, SUM(l.quantity)::int AS qty, SUM(l.line_total_rial)::text AS total
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE ($1::boolean OR l.supplier_id = $2) AND o.created_at BETWEEN $3 AND $4
       GROUP BY l.product_name, l.sku ORDER BY SUM(l.line_total_rial) DESC LIMIT 10`,
      [isPrivileged, supplierId, from.toISOString(), to.toISOString()]);

    const lowProducts = await pool.query(
      `SELECT l.product_name, l.sku, SUM(l.quantity)::int AS qty, SUM(l.line_total_rial)::text AS total
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE ($1::boolean OR l.supplier_id = $2) AND o.created_at BETWEEN $3 AND $4
       GROUP BY l.product_name, l.sku ORDER BY SUM(l.line_total_rial) ASC LIMIT 10`,
      [isPrivileged, supplierId, from.toISOString(), to.toISOString()]);

    const wallet = await pool.query(
      `SELECT balance_rial, pending_rial, earned_total_rial, withdrawn_total_rial, settled_total_rial
       FROM wallet_accounts WHERE owner_id = $1`, [supplierId]);
    const w = wallet.rows[0];
    const pendingSettlement = await pool.query(
      `SELECT COALESCE(SUM(amount_rial),0)::text AS pending FROM settlements WHERE party_user_id = $1 AND status = 'pending'`, [supplierId]);

    return {
      range: { from: from.toISOString(), to: to.toISOString(), period: range.period },
      sales: {
        todayRial: asRial(sales.rows[0].sales_today),
        weekRial: asRial(sales.rows[0].sales_week),
        monthRial: asRial(sales.rows[0].sales_month),
        yearRial: asRial(sales.rows[0].sales_year),
        ordersCount: sales.rows[0].orders_count,
        avgOrderRial: asRial(sales.rows[0].avg_order_rial),
        returnedOrders: sales.rows[0].returned_orders,
        revenueRial: asRial(sales.rows[0].revenue_rial),
      },
      topProducts: topProducts.rows.map(r => ({ ...r, totalRial: asRial(r.total) })),
      lowProducts: lowProducts.rows.map(r => ({ ...r, totalRial: asRial(r.total) })),
      wallet: w ? {
        availableRial: asRial((BigInt(w.balance_rial) - BigInt(w.pending_rial)).toString()),
        pendingRial: asRial(w.pending_rial),
        earnedRial: asRial(w.earned_total_rial),
        withdrawnRial: asRial(w.withdrawn_total_rial),
        settledRial: asRial(w.settled_total_rial),
        pendingSettlementRial: asRial(pendingSettlement.rows[0].pending),
      } : null,
    };
  });

  // Supplier orders: detailed view filtered by supplier_id in order_lines
  app.get('/api/v1/supplier/orders', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      status: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.iso.datetime().optional(),
    }).parse(request.query);
    const isPrivileged = user.permissions.includes('orders:read');
    const rows = await pool.query(
      `SELECT DISTINCT o.id, o.reference, o.buyer_id, o.order_type, o.payment_mode, o.status, o.total_rial, o.created_at,
              u.display_name AS buyer_name, u.phone AS buyer_phone
       FROM orders o JOIN order_lines l ON l.order_id = o.id LEFT JOIN users u ON u.id = o.buyer_id
       WHERE ($1::boolean OR l.supplier_id = $2)
         AND ($3::text IS NULL OR o.status = $3)
         AND ($4::timestamptz IS NULL OR o.created_at < $4)
       ORDER BY o.created_at DESC LIMIT $5`,
      [isPrivileged, user.id, query.status ?? null, query.before ?? null, query.limit]);
    return { items: rows.rows.map(r => ({ ...r, total_rial: asRial(r.total_rial) })) };
  });

  app.get('/api/v1/supplier/orders/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    // Verify supplier has at least one line in this order
    const belongs = await pool.query(
      `SELECT 1 FROM order_lines WHERE order_id = $1 AND supplier_id = $2 LIMIT 1`, [id, user.id]);
    const isPrivileged = user.permissions.includes('orders:read');
    if (!belongs.rows[0] && !isPrivileged) {
      throw notFound();
    }
    const order = await pool.query(`SELECT o.*, u.display_name AS buyer_name, u.phone AS buyer_phone, u.email AS buyer_email
       FROM orders o LEFT JOIN users u ON u.id = o.buyer_id WHERE o.id = $1`, [id]);
    if (!order.rows[0]) throw notFound();
    const lines = await pool.query(`SELECT id, product_name, sku, quantity, unit_price_rial, line_total_rial, supplier_id FROM order_lines WHERE order_id = $1 ORDER BY id`, [id]);
    // Filter lines to supplier's own if not privileged
    const filteredLines = isPrivileged ? lines.rows : lines.rows.filter((l: { supplier_id: string | null }) => l.supplier_id === user.id);
    const events = await pool.query('SELECT from_status,to_status,note,actor_id,created_at FROM order_events WHERE order_id = $1 ORDER BY created_at', [id]);
    const invoice = await pool.query('SELECT id, reference, status, total_rial FROM invoices WHERE order_id = $1 LIMIT 1', [id]);
    const payments = await pool.query('SELECT id, reference, provider, amount_rial, status FROM payment_intents WHERE order_id = $1', [id]);
    const shipments = await pool.query(`SELECT * FROM stock_reservations r JOIN order_lines l ON l.id = r.order_line_id WHERE l.order_id = $1`, [id]);

    // Supplier fulfillment status mapping: derive from order status but provide extended workflow
    const fulfillmentStatuses = ['received','confirmed','sourcing','preparing','ready_to_ship','handed_to_carrier','shipped','delivered','completed'] as const;
    // Use order_events to infer current fulfillment stage
    return {
      ...order.rows[0],
      total_rial: asRial(order.rows[0].total_rial),
      subtotal_rial: asRial(order.rows[0].subtotal_rial),
      discount_rial: asRial(order.rows[0].discount_rial),
      lines: filteredLines.map((r: { unit_price_rial: string; line_total_rial: string }) => ({ ...r, unit_price_rial: asRial(r.unit_price_rial), line_total_rial: asRial(r.line_total_rial) })),
      events: events.rows,
      invoice: invoice.rows[0] ? { ...invoice.rows[0], total_rial: asRial(invoice.rows[0].total_rial) } : null,
      payments: payments.rows.map((r: { amount_rial: string }) => ({ ...r, amount_rial: asRial(r.amount_rial) })),
      reservations: shipments.rows,
      fulfillmentStatuses,
    };
  });

  app.post('/api/v1/supplier/orders/:id/fulfillment', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(['received','confirmed','sourcing','preparing','ready_to_ship','handed_to_carrier','shipped','delivered','completed']),
      note: z.string().trim().max(1000).optional(),
      trackingCode: z.string().trim().max(100).optional(),
    }).parse(request.body);
    const allowedTransitions: Record<string, string[]> = {
      received: ['confirmed'], confirmed: ['sourcing'], sourcing: ['preparing'], preparing: ['ready_to_ship'],
      ready_to_ship: ['handed_to_carrier'], handed_to_carrier: ['shipped'], shipped: ['delivered'], delivered: ['completed'], completed: [],
    };
    const { transaction, one } = await import('./db.js');
    return transaction(pool, async (client) => {
      const order = await one<{ id: string; status: string }>(client, 'SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!order) throw notFound();
      const owns = await one<{ id: string }>(client, 'SELECT id FROM order_lines WHERE order_id = $1 AND supplier_id = $2 LIMIT 1', [id, user.id]);
      if (!owns && !user.permissions.includes('orders:transition')) throw forbidden();
      const last = await one<{ to_status: string }>(client, `SELECT to_status FROM order_events WHERE order_id = $1 AND note ILIKE 'fulfillment:%' ORDER BY created_at DESC LIMIT 1`, [id]);
      const current = last?.to_status?.replace('fulfillment:','') ?? 'received';
      const allowed = allowedTransitions[current] ?? [];
      if (!allowed.includes(body.status) && current !== body.status) {
        if (!(current === 'received' && body.status === 'received')) throw conflict(`گذار از ${current} به ${body.status} مجاز نیست.`);
      }
      const eventId = (await import('node:crypto')).randomUUID();
      await client.query(`INSERT INTO order_events(id,order_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [eventId, id, current, `fulfillment:${body.status}`, user.id, `fulfillment:${body.status}` + (body.trackingCode ? ` tracking:${body.trackingCode}` : '') + (body.note ? ` note:${body.note}` : '')]);
      const { audit } = await import('./operations.js');
      await audit(client, user.id, 'order.fulfillment_changed', 'order', id, { from: current }, { to: body.status, tracking: body.trackingCode }, request.ip);
      // If shipped, consume reserved stock (existing logic uses in_transit). Here also handle.
      if (body.status === 'shipped' || body.status === 'handed_to_carrier') {
        const reservations = await client.query<{ id: string; variant_id: string; warehouse_id: string; quantity: number }>(
          `SELECT r.id,r.variant_id,r.warehouse_id,r.quantity FROM stock_reservations r JOIN order_lines l ON l.id = r.order_line_id WHERE l.order_id = $1 AND r.status = 'active' FOR UPDATE OF r`, [id]);
        for (const r of reservations.rows) {
          if (r.quantity) {
            await client.query(`UPDATE stock_balances SET reserved = reserved - $3, on_hand = on_hand - $3, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2`,
              [r.variant_id, r.warehouse_id, r.quantity]);
            await client.query(`UPDATE stock_reservations SET status = 'consumed', updated_at = now() WHERE id = $1`, [r.id]);
            await client.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reserved_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
              VALUES ($1,$2,$3,$4,$5,'order shipped','order',$6,$7,$8)`,
              [(await import('node:crypto')).randomUUID(), r.variant_id, r.warehouse_id, -r.quantity, -r.quantity, id, user.id, `fulfill-ship:${r.id}`]);
          }
        }
      }
      return { id, fulfillmentStatus: body.status };
    });
  });
}
