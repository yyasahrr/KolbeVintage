import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, requestHash } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { asRial, rial } from './money.js';

/**
 * Manual retail sales (Requirements 13-16).
 *
 * A manual sale is a real commercial event — Sale → Payment → Inventory
 * consumption → Audit — recorded for sales that happen outside the website
 * checkout (Instagram, in-person, phone, WhatsApp, Telegram, …). It is NOT an
 * inventory adjustment: stock leaves the warehouse through an append-only
 * stock movement that references the sale, and the payment carries its own
 * verification lifecycle (card-to-card stays pending until a human verifies
 * the bank trace code).
 */

export const MANUAL_SALE_CHANNELS = ['website', 'instagram', 'in_person', 'phone', 'whatsapp', 'telegram', 'other'] as const;
export const MANUAL_SALE_PAYMENT_METHODS = ['card_to_card', 'cash', 'pos', 'gateway', 'other'] as const;

const lineInput = z.object({
  variantId: z.uuid(),
  quantity: z.number().int().min(1).max(10000),
  unitPriceRial: z.string().regex(/^\d+$/),
});
const paymentInput = z.object({
  method: z.enum(MANUAL_SALE_PAYMENT_METHODS),
  amountRial: z.string().regex(/^\d+$/),
  /** Bank trace / receipt code — required for card-to-card. */
  reference: z.string().trim().max(120).optional(),
  paidAt: z.iso.datetime().optional(),
  note: z.string().trim().max(1000).default(''),
});
const createBody = z.object({
  channel: z.enum(MANUAL_SALE_CHANNELS),
  warehouseId: z.uuid(),
  customerId: z.uuid().nullable().optional(),
  customerName: z.string().trim().max(160).optional(),
  customerPhone: z.string().trim().max(20).optional(),
  customerNote: z.string().trim().max(2000).default(''),
  note: z.string().trim().max(2000).default(''),
  discountRial: z.string().regex(/^\d+$/).default('0'),
  lines: z.array(lineInput).min(1).max(100),
  payment: paymentInput,
}).strict();

type SaleRow = Record<string, unknown> & { id: string; status: string };

function serializeSale(sale: Record<string, unknown>) {
  return {
    ...sale,
    subtotal_rial: asRial(sale.subtotal_rial as string),
    discount_rial: asRial(sale.discount_rial as string),
    total_rial: asRial(sale.total_rial as string),
  };
}

export function registerManualSaleRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Create a manual sale: snapshot lines, consume stock, record the payment.
  app.post('/api/v1/admin/manual-sales', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'sales:manage');
    const body = createBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    if (body.payment.method === 'card_to_card' && !body.payment.reference?.trim())
      throw badRequest('برای پرداخت کارت‌به‌کارت کد پیگیری/شماره مرجع لازم است.');

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'manual_sale.create', key, requestHash(body));
      if (claim.previous) return { reused: true, body: claim.previous };

      const warehouse = await one<{ id: string }>(client, 'SELECT id FROM warehouses WHERE id = $1 AND active', [body.warehouseId]);
      if (!warehouse) throw badRequest('انبار انتخاب‌شده معتبر یا فعال نیست.');
      if (body.customerId) {
        const customer = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [body.customerId]);
        if (!customer) throw badRequest('مشتری انتخاب‌شده یافت نشد.');
      }

      const saleId = randomUUID();
      const seq = await one<{ n: string }>(client, "SELECT nextval('manual_sale_reference_seq')::text AS n");
      const reference = `MS-${seq!.n}`;

      let subtotal = 0n;
      const lines: { id: string; variantId: string; productId: string; sku: string; productName: string; quantity: number; unitPriceRial: string; lineTotalRial: string }[] = [];
      for (const line of body.lines) {
        const variant = await one<{ id: string; sku: string; product_id: string; product_name: string }>(client,
          `SELECT v.id, v.sku, v.product_id, p.name AS product_name
           FROM product_variants v JOIN products p ON p.id = v.product_id
           WHERE v.id = $1 AND v.active`, [line.variantId]);
        if (!variant) throw badRequest('واریانت انتخاب‌شده معتبر یا فعال نیست.');
        const unit = rial(line.unitPriceRial);
        const lineTotal = unit * BigInt(line.quantity);
        subtotal += lineTotal;

        // Consume sellable stock atomically; the guard keeps available >= 0.
        const balance = await one<{ on_hand: number }>(client,
          `UPDATE stock_balances SET on_hand = on_hand - $3, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand - $3 >= reserved + damaged
           RETURNING on_hand`, [line.variantId, body.warehouseId, line.quantity]);
        if (!balance) throw conflict(`موجودی قابل فروش «${variant.sku}» در انبار انتخاب‌شده کافی نیست.`);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,'manual sale','manual_sale',$5,$6,$7)`,
          [randomUUID(), line.variantId, body.warehouseId, -line.quantity, saleId, user.id, `msale:${saleId}:${line.variantId}`]);

        lines.push({ id: randomUUID(), variantId: variant.id, productId: variant.product_id, sku: variant.sku,
          productName: variant.product_name, quantity: line.quantity, unitPriceRial: unit.toString(), lineTotalRial: lineTotal.toString() });
      }

      const discount = rial(body.discountRial);
      if (discount > subtotal) throw badRequest('تخفیف نمی‌تواند از جمع فاکتور بیشتر باشد.');
      const total = subtotal - discount;
      const paymentAmount = rial(body.payment.amountRial);
      if (paymentAmount !== total) throw badRequest('مبلغ پرداخت باید دقیقاً برابر مبلغ نهایی فروش باشد.');

      // Card-to-card requires human verification; other methods are settled on entry.
      const pending = body.payment.method === 'card_to_card';
      const saleStatus = pending ? 'pending_verification' : 'completed';
      await client.query(
        `INSERT INTO manual_sales(id,reference,channel,customer_id,customer_name,customer_phone,customer_note,warehouse_id,status,
           subtotal_rial,discount_rial,total_rial,note,created_by,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [saleId, reference, body.channel, body.customerId ?? null, body.customerName ?? null, body.customerPhone ?? null,
          body.customerNote, body.warehouseId, saleStatus, subtotal.toString(), discount.toString(), total.toString(),
          body.note, user.id, pending ? null : new Date().toISOString()]);

      // Line snapshots are written after the sale header so the FK holds;
      // the stock movements above already reference the same sale id.
      for (const line of lines) {
        await client.query(
          `INSERT INTO manual_sale_lines(id,sale_id,variant_id,product_id,product_name,sku,quantity,unit_price_rial,line_total_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [line.id, saleId, line.variantId, line.productId, line.productName, line.sku, line.quantity, line.unitPriceRial, line.lineTotalRial]);
      }

      const paymentId = randomUUID();
      await client.query(
        `INSERT INTO manual_sale_payments(id,sale_id,payment_method,amount_rial,reference,paid_at,verification_status,verified_by,verified_at,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [paymentId, saleId, body.payment.method, paymentAmount.toString(), body.payment.reference ?? null,
          body.payment.paidAt ?? null, pending ? 'pending_verification' : 'verified',
          pending ? null : user.id, pending ? null : new Date().toISOString(), body.payment.note]);

      await audit(client, user.id, 'manual_sale.created', 'manual_sale', saleId, undefined,
        { reference, channel: body.channel, totalRial: total.toString(), paymentMethod: body.payment.method, status: saleStatus }, request.ip);

      const result = {
        id: saleId, reference, channel: body.channel, status: saleStatus,
        subtotalRial: subtotal.toString(), discountRial: discount.toString(), totalRial: total.toString(),
        lines,
        payment: { id: paymentId, method: body.payment.method, amountRial: paymentAmount.toString(),
          reference: body.payment.reference ?? null, verificationStatus: pending ? 'pending_verification' : 'verified' },
      };
      await completeIdempotency(client, user.id, 'manual_sale.create', key, result);
      return { reused: false, body: result };
    });
    return reply.code(response.reused ? 200 : 201).send(response.body);
  });

  // Verify or reject a card-to-card (or other pending) payment.
  app.post('/api/v1/admin/manual-sales/:id/payments/:paymentId/verification', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'sales:manage');
    const params = z.object({ id: z.uuid(), paymentId: z.uuid() }).parse(request.params);
    const body = z.object({ action: z.enum(['verify', 'reject']), note: z.string().trim().max(1000).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const sale = await one<SaleRow>(client, 'SELECT * FROM manual_sales WHERE id = $1 FOR UPDATE', [params.id]);
      if (!sale) throw notFound();
      const payment = await one<{ id: string; verification_status: string; note: string }>(client,
        'SELECT id, verification_status, note FROM manual_sale_payments WHERE id = $1 AND sale_id = $2 FOR UPDATE', [params.paymentId, params.id]);
      if (!payment) throw notFound();
      if (payment.verification_status !== 'pending_verification') throw conflict('این پرداخت قبلاً بررسی شده است.');
      if (sale.status !== 'pending_verification') throw conflict('وضعیت فروش اجازه بررسی پرداخت را نمی‌دهد.');

      const verified = body.action === 'verify';
      await client.query(
        `UPDATE manual_sale_payments SET verification_status = $2, verified_by = $3, verified_at = now(),
           note = CASE WHEN $4::text IS NULL THEN note ELSE $4 END
         WHERE id = $1`, [params.paymentId, verified ? 'verified' : 'rejected', user.id, body.note ?? null]);

      if (verified) {
        await client.query(`UPDATE manual_sales SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [params.id]);
      } else {
        // Rejected payment cancels the sale and returns the consumed stock —
        // via a compensating append-only movement, never a raw overwrite.
        const lines = await client.query('SELECT variant_id, quantity FROM manual_sale_lines WHERE sale_id = $1', [params.id]);
        for (const line of lines.rows as { variant_id: string; quantity: number }[]) {
          await client.query(
            `UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
             WHERE variant_id = $1 AND warehouse_id = $2`, [line.variant_id, sale.warehouse_id, line.quantity]);
          await client.query(
            `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
             VALUES ($1,$2,$3,$4,'manual sale payment rejected','manual_sale',$5,$6,$7)`,
            [randomUUID(), line.variant_id, sale.warehouse_id, line.quantity, params.id, user.id, `msale-reject:${params.id}:${line.variant_id}`]);
        }
        await client.query(`UPDATE manual_sales SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [params.id]);
      }
      await audit(client, user.id, verified ? 'manual_sale.payment_verified' : 'manual_sale.payment_rejected',
        'manual_sale', params.id, { status: sale.status }, { paymentId: params.paymentId, action: body.action, note: body.note }, request.ip);
      return { id: params.id, paymentId: params.paymentId, status: verified ? 'completed' : 'cancelled',
        verificationStatus: verified ? 'verified' : 'rejected' };
    });
  });

  // List with server-side channel/status filters + search + pagination (Req 16).
  app.get('/api/v1/admin/manual-sales', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'sales:read');
    const query = z.object({
      channel: z.enum(MANUAL_SALE_CHANNELS).optional(),
      status: z.enum(['pending_verification', 'completed', 'cancelled']).optional(),
      search: z.string().trim().max(120).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(request.query);
    const where = `($1::text IS NULL OR s.channel = $1)
         AND ($2::text IS NULL OR s.status = $2)
         AND ($3::timestamptz IS NULL OR s.created_at >= $3)
         AND ($4::timestamptz IS NULL OR s.created_at <= $4)
         AND ($5::text IS NULL OR s.reference ILIKE '%' || $5 || '%' OR s.customer_name ILIKE '%' || $5 || '%'
              OR s.customer_phone ILIKE '%' || $5 || '%'
              OR EXISTS (SELECT 1 FROM manual_sale_lines l WHERE l.sale_id = s.id
                         AND (l.sku ILIKE '%' || $5 || '%' OR l.product_name ILIKE '%' || $5 || '%')))`;
    const params = [query.channel ?? null, query.status ?? null, query.from ?? null, query.to ?? null, query.search ?? null];
    const total = await one<{ total: number }>(pool, `SELECT count(*)::int AS total FROM manual_sales s WHERE ${where}`, params);
    const rows = await pool.query(
      `SELECT s.*, u.display_name AS created_by_name,
              (SELECT count(*)::int FROM manual_sale_lines l WHERE l.sale_id = s.id) AS line_count,
              (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'method', p.payment_method, 'amountRial', p.amount_rial::text,
                 'reference', p.reference, 'verificationStatus', p.verification_status) ORDER BY p.created_at)
               FROM manual_sale_payments p WHERE p.sale_id = s.id) AS payments
       FROM manual_sales s LEFT JOIN users u ON u.id = s.created_by
       WHERE ${where} ORDER BY s.created_at DESC LIMIT $6 OFFSET $7`, [...params, query.limit, query.offset]);
    // Channel breakdown for reporting (Req 16) under the same filters.
    const channels = await pool.query(
      `SELECT s.channel, count(*)::int AS sales, COALESCE(sum(s.total_rial) FILTER (WHERE s.status <> 'cancelled'), 0)::text AS total_rial
       FROM manual_sales s WHERE ${where} GROUP BY s.channel ORDER BY s.channel`, params);
    return {
      items: rows.rows.map((row) => serializeSale(row)),
      total: total?.total ?? 0, limit: query.limit, offset: query.offset,
      channels: channels.rows.map((row: { channel: string; sales: number; total_rial: string }) =>
        ({ channel: row.channel, sales: row.sales, totalRial: asRial(row.total_rial) })),
    };
  });

  app.get('/api/v1/admin/manual-sales/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'sales:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const sale = await one<Record<string, unknown>>(pool,
      `SELECT s.*, u.display_name AS created_by_name, w.name AS warehouse_name, w.code AS warehouse_code
       FROM manual_sales s LEFT JOIN users u ON u.id = s.created_by LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.id = $1`, [id]);
    if (!sale) throw notFound();
    const lines = await pool.query('SELECT * FROM manual_sale_lines WHERE sale_id = $1 ORDER BY sku', [id]);
    const payments = await pool.query(
      `SELECT p.*, u.display_name AS verified_by_name FROM manual_sale_payments p
       LEFT JOIN users u ON u.id = p.verified_by WHERE p.sale_id = $1 ORDER BY p.created_at`, [id]);
    const history = await pool.query(
      `SELECT action, actor_id, created_at, new_value FROM audit_logs WHERE resource_type = 'manual_sale' AND resource_id = $1 ORDER BY created_at`, [id]);
    return {
      ...serializeSale(sale),
      lines: lines.rows.map((row: Record<string, unknown>) => ({
        ...row, unit_price_rial: asRial(row.unit_price_rial as string), line_total_rial: asRial(row.line_total_rial as string) })),
      payments: payments.rows.map((row: Record<string, unknown>) => ({ ...row, amount_rial: asRial(row.amount_rial as string) })),
      history: history.rows,
    };
  });
}
