import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { addRial, asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { assertNotRestricted } from './console.js';
import { assertSupplierMay, supplierCapViolation } from './supplier360.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { postSupplierEarnings } from './wallet.js';
import { recordRedemption, resolveCouponDiscount, resolveFestivalDiscount, type DiscountContext } from './coupons.js';

const checkout = z.object({
  orderType: z.enum(['retail', 'wholesale']),
  paymentMode: z.enum(['cash', 'four_installments']),
  items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(10000) })).min(1).max(100)
    .refine((items) => new Set(items.map((item) => item.variantId)).size === items.length, 'هر واریانت فقط یک بار مجاز است.'),
  shippingAddress: z.object({
    recipient: z.string().trim().min(2).max(120), phone: z.string().regex(/^09\d{9}$/),
    province: z.string().trim().min(2).max(120), city: z.string().trim().min(2).max(120),
    line: z.string().trim().min(10).max(500), postalCode: z.string().regex(/^\d{10}$/),
  }),
  couponCode: z.string().trim().max(40).optional(),
  shippingMethodId: z.uuid().optional(),
});
const orderStatus = z.enum(['pending_payment', 'paid', 'processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped', 'delivered', 'cancelled', 'returned']);
type OrderStatus = z.infer<typeof orderStatus>;
const allowed: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['cancelled'], paid: ['processing'], processing: ['preparing'],
  preparing: ['ready_to_ship'], ready_to_ship: ['in_transit'], in_transit: ['shipped'],
  shipped: ['delivered'], delivered: [], cancelled: [], returned: [],
};

type VariantRow = {
  variant_id: string; sku: string; product_id: string; product_name: string; product_category: string; supplier_id: string | null;
  cash_price_rial: string; installment_price_rial: string | null; wholesale_price_rial: string | null;
  status: string; active: boolean;
};
type OrderRow = { id: string; reference: string; buyer_id: string; status: OrderStatus; total_rial: string; payment_mode: string; order_type: string; created_at: Date };

export function registerOrderRoutes(app: FastifyInstance, pool: DbPool, config: Config, availableProviders = new Set<string>()) {
  app.post('/api/v1/orders', async (request, reply) => {
    const user = await principal(request, pool, config);
    await assertNotRestricted(pool, user.id, 'purchase');
    const body = checkout.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    // Status/restriction gates run before the order transaction: a rejected order
    // must leave the audit trail behind (items 11-13), which a rollback would erase.
    const priced = await pool.query<{ id: string; supplier_id: string | null; cash_price_rial: string;
      installment_price_rial: string | null; wholesale_price_rial: string | null }>(
      `SELECT v.id, p.supplier_id, p.cash_price_rial::text, p.installment_price_rial::text, p.wholesale_price_rial::text
         FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`,
      [body.items.map((item) => item.variantId)]);
    const incomingBySupplier = new Map<string, bigint>();
    for (const item of body.items) {
      const row = priced.rows.find((candidate) => candidate.id === item.variantId);
      if (!row?.supplier_id) continue;
      const unit = rial((body.orderType === 'wholesale' ? row.wholesale_price_rial : row.cash_price_rial) ?? '0');
      incomingBySupplier.set(row.supplier_id,
        (incomingBySupplier.get(row.supplier_id) ?? 0n) + unit * BigInt(item.quantity));
    }
    for (const [supplierId, incoming] of incomingBySupplier) {
      await assertSupplierMay(pool, supplierId, 'order_intake', { resource: 'order', ip: request.ip });
      const violation = await transaction(pool, (client) => supplierCapViolation(client, supplierId, 'sales_limit', incoming));
      if (violation) throw forbidden(violation);
    }
    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'order.create', key, requestHash(body));
      if (claim.previous) return claim.previous;
      let limits: Record<string, unknown> = {};
      if (body.orderType === 'wholesale') {
        const membership = await one<{ limits: Record<string, unknown> }>(client,
          `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
           WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
           LIMIT 1`, [user.id]);
        if (!membership) throw forbidden();
        limits = membership.limits;
        if (body.paymentMode === 'four_installments' && limits.installmentAccess === false)
          throw conflict('خرید اقساطی در پلن عضویت شما فعال نیست.');
        const maxQuantityPerLine = limits.maxQuantityPerLine;
        if (typeof limits.maxOrderLines === 'number' && body.items.length > limits.maxOrderLines)
          throw conflict('تعداد اقلام سفارش از سقف پلن بالاتر است.');
        if (typeof maxQuantityPerLine === 'number' && body.items.some((item) => item.quantity > maxQuantityPerLine))
          throw conflict('تعداد یک قلم از سقف پلن بالاتر است.');
        if (typeof limits.maxOrdersPerMonth === 'number' && limits.maxOrdersPerMonth >= 0) {
          const count = await one<{ count: string }>(client,
            `SELECT count(*)::text AS count FROM orders WHERE buyer_id = $1 AND order_type = 'wholesale'
             AND status <> 'cancelled' AND created_at >=
             (date_trunc('month', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')`, [user.id]);
          if (Number(count?.count ?? 0) >= limits.maxOrdersPerMonth) throw conflict('سقف سفارش ماهانه این پلن تکمیل شده است.');
        }
      }
      const orderId = randomUUID();
      const sequence = await one<{ number: string }>(client, "SELECT nextval('order_reference_seq')::text AS number");
      const reference = `KV-${sequence!.number}`;
      const lines: Array<{ id: string; variant: VariantRow; quantity: number; price: bigint; total: bigint }> = [];
      for (const item of body.items) {
        const variant = await one<VariantRow>(client,
          `SELECT v.id AS variant_id, v.sku, v.active, p.id AS product_id, p.name AS product_name,
                  p.category AS product_category,
                  p.supplier_id, p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial, p.status
           FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`, [item.variantId]);
        if (!variant || !variant.active || variant.status !== 'published') throw notFound();
        if (body.orderType === 'wholesale' && limits.sources === 'kolbe' && variant.supplier_id) throw forbidden();
        const priceValue = body.orderType === 'wholesale' ? variant.wholesale_price_rial
          : body.paymentMode === 'four_installments' ? variant.installment_price_rial ?? variant.cash_price_rial
            : variant.cash_price_rial;
        if (priceValue === null) throw badRequest(`قیمت فروش برای SKU ${variant.sku} تعریف نشده است.`);
        const price = rial(priceValue);
        if (price === 0n) throw badRequest(`قیمت فروش برای SKU ${variant.sku} معتبر نیست.`);
        lines.push({ id: randomUUID(), variant, quantity: item.quantity, price, total: price * BigInt(item.quantity) });
      }
      const subtotal = addRial(lines.map((line) => line.total));
      if (body.orderType === 'wholesale') {
        if (typeof limits.maxOrderValueRial === 'string' && subtotal > rial(limits.maxOrderValueRial)) throw conflict('مبلغ سفارش از سقف پلن بالاتر است.');
        if (typeof limits.minOrderValueRial === 'string' && subtotal < rial(limits.minOrderValueRial)) throw conflict('مبلغ سفارش از کف خرید این پلن کمتر است.');
        const suppliers = new Set(lines.map((line) => line.variant.supplier_id ?? 'kolbe'));
        if (typeof limits.maxSuppliersPerOrder === 'number' && suppliers.size > limits.maxSuppliersPerOrder) throw conflict('تعداد تأمین‌کنندگان سفارش از سقف پلن بالاتر است.');
      }
      const percent = body.orderType === 'wholesale' && typeof limits.discountPercent === 'number'
        && Number.isInteger(limits.discountPercent) && limits.discountPercent >= 0 && limits.discountPercent <= 90
        ? BigInt(limits.discountPercent) : 0n;
      const planDiscount = subtotal * percent / 100n;
      const context: DiscountContext = {
        userId: user.id,
        orderType: body.orderType,
        isVip: user.roles.includes('vip'),
        lines: lines.map((line) => ({ productId: line.variant.product_id, category: line.variant.product_category, total: line.total })),
      };
      const promo = body.couponCode
        ? await resolveCouponDiscount(client, context, body.couponCode)
        : await resolveFestivalDiscount(client, context);
      if (body.couponCode && promo.source === 'none') throw badRequest(promo.note ?? 'کد تخفیف معتبر نیست.');
      let discount = planDiscount + promo.discountRial;
      if (discount > subtotal) discount = subtotal;
      // Shipping: server-side authoritative — never trust client fee
      let shippingRial = 0n;
      let shippingMethodId: string | null = null;
      if (body.shippingMethodId) {
        const method = await one<{ id: string; active: boolean; base_fee_rial: string; free_above_rial: string | null }>(client,
          'SELECT id, active, base_fee_rial, free_above_rial FROM shipping_methods WHERE id = $1', [body.shippingMethodId]);
        if (!method) throw notFound();
        if (!method.active) throw badRequest('روش ارسال انتخاب‌شده غیرفعال است.');
        shippingMethodId = method.id;
        const base = rial(method.base_fee_rial);
        const freeAbove = method.free_above_rial ? rial(method.free_above_rial) : null;
        if (freeAbove !== null && subtotal >= freeAbove) shippingRial = 0n;
        else shippingRial = base;
      }
      const total = subtotal - discount + shippingRial;
      await client.query(
        `INSERT INTO orders(id,reference,buyer_id,order_type,payment_mode,subtotal_rial,discount_rial,shipping_rial,shipping_method_id,total_rial,shipping_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [orderId, reference, user.id, body.orderType, body.paymentMode, subtotal.toString(), discount.toString(), shippingRial.toString(), shippingMethodId, total.toString(), JSON.stringify(body.shippingAddress)]);
      for (const line of lines) {
        await client.query(
          `INSERT INTO order_lines(id,order_id,product_id,variant_id,supplier_id,product_name,sku,quantity,unit_price_rial,line_total_rial)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [line.id, orderId, line.variant.product_id, line.variant.variant_id, line.variant.supplier_id,
            line.variant.product_name, line.variant.sku, line.quantity, line.price.toString(), line.total.toString()]);
        const balance = await one<{ warehouse_id: string }>(client,
          `SELECT b.warehouse_id FROM stock_balances b JOIN warehouses w ON w.id = b.warehouse_id
           WHERE b.variant_id = $1 AND w.active AND b.on_hand - b.reserved - b.damaged >= $2
           ORDER BY w.code LIMIT 1 FOR UPDATE OF b`, [line.variant.variant_id, line.quantity]);
        if (!balance) throw conflict(`موجودی SKU ${line.variant.sku} کافی نیست.`);
        const updated = await client.query(
          `UPDATE stock_balances SET reserved = reserved + $3, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND on_hand - reserved - damaged >= $3`,
          [line.variant.variant_id, balance.warehouse_id, line.quantity]);
        if (!updated.rowCount) throw conflict(`موجودی SKU ${line.variant.sku} تغییر کرده است.`);
        await client.query(
          `INSERT INTO stock_reservations(id,order_line_id,variant_id,warehouse_id,quantity,status)
           VALUES ($1,$2,$3,$4,$5,'active')`,
          [randomUUID(), line.id, line.variant.variant_id, balance.warehouse_id, line.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id,variant_id,warehouse_id,reserved_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
           VALUES ($1,$2,$3,$4,'order reservation','order',$5,$6,$7)`,
          [randomUUID(), line.variant.variant_id, balance.warehouse_id, line.quantity, orderId, user.id, `reserve:${line.id}`]);
      }
      await client.query(
        `INSERT INTO order_events(id,order_id,to_status,actor_id,note) VALUES ($1,$2,'pending_payment',$3,'سفارش ثبت و موجودی رزرو شد')`,
        [randomUUID(), orderId, user.id]);
      const paymentIntentId = randomUUID();
      const provider = body.paymentMode === 'cash' ? (body.orderType === 'retail' ? 'zibal' : 'nextpay') : 'not_configured';
      await client.query(
        `INSERT INTO payment_intents(id,reference,order_id,provider,amount_rial,status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [paymentIntentId, `PAY-${sequence!.number}`, orderId, provider, total.toString()]);
      await audit(client, user.id, 'order.created', 'order', orderId, undefined, { reference, totalRial: total.toString() }, request.ip);
      await outbox(client, 'order.created', 'order', orderId, { orderId, reference });
      if (promo.couponId && promo.discountRial > 0n) {
        await recordRedemption(client, promo.couponId, user.id, orderId, promo.discountRial);
      }
      const response = { id: orderId, reference, status: 'pending_payment', subtotalRial: asRial(subtotal), discountRial: asRial(discount), shippingRial: asRial(shippingRial), shippingMethodId, totalRial: asRial(total), paymentIntentId,
        paymentAvailable: availableProviders.has(provider) };
      await completeIdempotency(client, user.id, 'order.create', key, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/orders', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.iso.datetime().optional() }).parse(request.query);
    const privileged = user.permissions.includes('orders:read');
    const rows = await pool.query<OrderRow>(
      `SELECT id, reference, buyer_id, status, total_rial, payment_mode, order_type, created_at
       FROM orders WHERE ($1::boolean OR buyer_id = $2) AND ($3::timestamptz IS NULL OR created_at < $3)
       ORDER BY created_at DESC LIMIT $4`, [privileged, user.id, query.before ?? null, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, total_rial: asRial(row.total_rial) })) };
  });

  app.get('/api/v1/orders/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const order = await one<OrderRow>(pool, 'SELECT * FROM orders WHERE id = $1', [id]);
    if (!order || (order.buyer_id !== user.id && !user.permissions.includes('orders:read'))) throw notFound();
    const lines = await pool.query('SELECT id,sku,product_name,quantity,unit_price_rial,line_total_rial FROM order_lines WHERE order_id = $1 ORDER BY id', [id]);
    const events = await pool.query('SELECT from_status,to_status,note,actor_id,created_at FROM order_events WHERE order_id = $1 ORDER BY created_at,id', [id]);
    return { ...order, total_rial: asRial(order.total_rial), lines: lines.rows, events: events.rows };
  });

  app.post('/api/v1/orders/:id/transitions', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ status: orderStatus, note: z.string().trim().max(1000).optional() }).parse(request.body);
    return transaction(pool, async (client) => {
      const order = await one<OrderRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!order) throw notFound();
      if (order.buyer_id === user.id && body.status === 'cancelled' && order.status === 'pending_payment') {
        // A buyer can cancel an unpaid order.
      } else requirePermission(user, 'orders:transition');
      if (!allowed[order.status].includes(body.status)) throw conflict('این تغییر وضعیت در مرحله فعلی مجاز نیست.');
      if (body.status === 'cancelled' || body.status === 'in_transit') {
        const reservations = await client.query<{ id: string; variant_id: string; warehouse_id: string; quantity: number }>(
          `SELECT r.id,r.variant_id,r.warehouse_id,r.quantity FROM stock_reservations r
           JOIN order_lines l ON l.id = r.order_line_id WHERE l.order_id = $1 AND r.status = 'active' FOR UPDATE OF r`, [id]);
        for (const reservation of reservations.rows) {
          const consume = body.status === 'in_transit';
          await client.query(
            `UPDATE stock_balances SET reserved = reserved - $3, on_hand = on_hand - $4,
             version = version + 1, updated_at = now() WHERE variant_id = $1 AND warehouse_id = $2`,
            [reservation.variant_id, reservation.warehouse_id, reservation.quantity, consume ? reservation.quantity : 0]);
          await client.query('UPDATE stock_reservations SET status = $2, updated_at = now() WHERE id = $1',
            [reservation.id, consume ? 'consumed' : 'released']);
          await client.query(
            `INSERT INTO stock_movements(id,variant_id,warehouse_id,on_hand_delta,reserved_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,'order',$7,$8,$9)`,
            [randomUUID(), reservation.variant_id, reservation.warehouse_id, consume ? -reservation.quantity : 0,
              -reservation.quantity, consume ? 'order shipped' : 'order cancelled', id, user.id, `${body.status}:${reservation.id}`]);
        }
      }
      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [id, body.status]);
      if (body.status === 'delivered') await postSupplierEarnings(client, id);
      if (body.status === 'cancelled') await client.query("UPDATE payment_intents SET status = 'failed' WHERE order_id = $1 AND status = 'pending'", [id]);
      await client.query('INSERT INTO order_events(id,order_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, order.status, body.status, user.id, body.note ?? null]);
      await audit(client, user.id, 'order.status_changed', 'order', id, { status: order.status }, { status: body.status, note: body.note }, request.ip);
      await outbox(client, 'order.status_changed', 'order', id, { orderId: id, from: order.status, to: body.status });
      return { id, reference: order.reference, status: body.status };
    });
  });
}
