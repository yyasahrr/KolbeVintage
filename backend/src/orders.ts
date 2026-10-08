import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requireApprovedSupplier, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { addRial, asRial, rial } from './money.js';
import { audit, claimIdempotency, completeIdempotency, outbox, requestHash } from './operations.js';
import { markCartConverted } from './cart.js';
import { assertNotRestricted } from './console.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { assertSupplierMay, supplierCapViolation } from './supplier360.js';
import { postSupplierEarnings } from './wallet.js';
import { recordRedemption, resolveCouponDiscount, resolveFestivalDiscount, type DiscountContext } from './coupons.js';
import { quoteShipping } from './shipping.js';
import { resolveVariantPrice, type ResolvedVariantPrice } from './promotions.js';
import { allocateSeriesPrice, loadSeriesComposition } from './series.js';
import { applySeriesMovement, buildRecipeSnapshot } from './series-inventory.js';
import { earnCashbackOnPaid, quoteRedemption, redeemCashback, restoreRedeemedCashback, reverseCashbackForOrder, scheduleCashbackRelease } from './cashback.js';

const defaultShippingAddress = {
  recipient: 'تحویل در انبار/آدرس ثبت‌شده',
  phone: '09120000000',
  province: 'تهران',
  city: 'تهران',
  line: 'تهران، خیابان ولیعصر، پلاک ۱۰۰',
  postalCode: '1111111111',
};

const checkout = z.object({
  orderType: z.enum(['retail', 'wholesale']),
  paymentMode: z.enum(['cash', 'four_installments']).default('cash'),
  items: z.array(z.object({
    variantId: z.uuid(),
    quantity: z.number().int().min(1).max(10000),
  }).strict()).max(100).default([])
    .refine((items) => new Set(items.map((item) => item.variantId)).size === items.length, 'هر واریانت فقط یک بار مجاز است.'),
  // K3/K4: wholesale buys whole series; the server expands the relational recipe into
  // variant-level lines inside ONE transaction so reservation is all-or-nothing.
  series: z.array(z.object({
    seriesTemplateId: z.uuid(),
    count: z.number().int().min(1).max(1000),
  }).strict()).max(20).optional(),
  shippingAddress: z.object({
    recipient: z.string().trim().min(2).max(120),
    phone: z.string().regex(/^09\d{9}$/),
    province: z.string().trim().min(2).max(120),
    city: z.string().trim().min(2).max(120),
    line: z.string().trim().min(10).max(500),
    postalCode: z.string().regex(/^\d{10}$/),
  }).default(defaultShippingAddress),
  couponCode: z.string().trim().max(40).optional(),
  shippingMethodId: z.uuid().optional(),
  // Retail cashback wallet: how much loyalty credit pays for this order (rial, server-validated).
  walletRial: z.string().regex(/^\d+$/).optional(),
}).strict();

const orderStatus = z.enum([
  'pending_payment',
  'paid',
  'processing',
  'preparing',
  'ready_to_ship',
  'in_transit',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
]);
type OrderStatus = z.infer<typeof orderStatus>;

const allowed: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'preparing', 'cancelled'],
  processing: ['preparing', 'ready_to_ship', 'in_transit', 'shipped', 'cancelled'],
  preparing: ['ready_to_ship', 'in_transit', 'shipped', 'cancelled'],
  ready_to_ship: ['in_transit', 'shipped'],
  in_transit: ['shipped', 'delivered'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
};

const orderSort = z.enum(['newest', 'oldest', 'status', 'total', 'buyer', 'supplier', 'payment', 'fulfillment', 'updated', 'priority', 'shipped']);
type OrderSort = z.infer<typeof orderSort>;
const SHIPPED_AT = `(SELECT max(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.to_status IN ('shipped', 'fulfillment:shipped', 'fulfillment:handed_to_carrier'))`;
const SORT_SQL: Record<OrderSort, string> = {
  newest: 'o.created_at DESC, o.id DESC',
  oldest: 'o.created_at ASC, o.id ASC',
  status: 'o.status ASC, o.created_at DESC, o.id DESC',
  total: 'o.total_rial DESC, o.created_at DESC, o.id DESC',
  buyer: 'buyer_name ASC NULLS LAST, o.created_at DESC, o.id DESC',
  supplier: 'first_supplier ASC NULLS LAST, o.created_at DESC, o.id DESC',
  payment: 'payment_rank ASC, o.created_at DESC, o.id DESC',
  fulfillment: 'fulfillment_rank ASC NULLS FIRST, o.created_at ASC, o.id ASC',
  updated: 'o.updated_at DESC, o.id DESC',
  priority: `CASE o.status WHEN 'paid' THEN 0 WHEN 'processing' THEN 1 WHEN 'preparing' THEN 2
    WHEN 'ready_to_ship' THEN 3 WHEN 'pending_payment' THEN 4 WHEN 'in_transit' THEN 5
    WHEN 'shipped' THEN 6 WHEN 'delivered' THEN 7 WHEN 'cancelled' THEN 8 ELSE 9 END ASC,
    o.created_at ASC, o.id ASC`,
  shipped: `${SHIPPED_AT} DESC NULLS LAST, o.created_at DESC, o.id DESC`,
};
const FULFILLMENT_RANK = `CASE (SELECT e.to_status FROM order_events e WHERE e.order_id = o.id AND e.to_status LIKE 'fulfillment:%'
  ORDER BY e.created_at DESC LIMIT 1)
  WHEN 'fulfillment:received' THEN 0 WHEN 'fulfillment:confirmed' THEN 1 WHEN 'fulfillment:sourcing' THEN 2
  WHEN 'fulfillment:preparing' THEN 3 WHEN 'fulfillment:ready_to_ship' THEN 4
  WHEN 'fulfillment:handed_to_carrier' THEN 5 WHEN 'fulfillment:shipped' THEN 6
  WHEN 'fulfillment:delivered' THEN 7 WHEN 'fulfillment:completed' THEN 8 ELSE NULL END`;
const PAYMENT_RANK = `CASE (SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1)
  WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'refunded' THEN 2 WHEN 'succeeded' THEN 3 ELSE 0 END`;
/** §28-29: shipment/tracking come from the EXISTING shipments domain (no second tracking system). */
const LATEST_SHIPMENT_JOIN = `LEFT JOIN LATERAL (
  SELECT s.id AS shipment_id, s.carrier, s.tracking_code, s.status AS shipment_status, s.last_status_at, s.shipped_at
  FROM shipments s WHERE s.order_id = o.id ORDER BY s.created_at DESC LIMIT 1
) sh ON true`;
const TRACKING_SQL = `COALESCE(sh.tracking_code, o.vip_tracking_code, o.tracking_code)`;
/** §41: «مشکل‌دار» is computed ONLY from real persisted data — no fabricated frontend rules. */
const EXCEPTIONS_SQL = `ARRAY_REMOVE(ARRAY[
  CASE WHEN (SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1) = 'failed' THEN 'payment_failed'::text END,
  CASE WHEN o.status = 'pending_payment' AND o.created_at < now() - interval '24 hours' THEN 'payment_overdue'::text END,
  CASE WHEN o.status IN ('in_transit','shipped') AND ${TRACKING_SQL} IS NULL THEN 'missing_tracking'::text END,
  CASE WHEN o.status IN ('in_transit','shipped') AND COALESCE(sh.carrier, o.vip_carrier) IS NULL THEN 'missing_carrier'::text END,
  CASE WHEN o.status NOT IN ('delivered','cancelled','returned') AND COALESCE(o.shipping_address->>'postalCode','') !~ '^\\d{10}$' THEN 'invalid_address'::text END,
  CASE WHEN EXISTS (SELECT 1 FROM order_lines qx WHERE qx.order_id = o.id AND qx.qc_status IN ('rejected','partially_accepted')) THEN 'qc_issue'::text END
], NULL)`;

type VariantRow = {
  variant_id: string;
  sku: string;
  size_label: string | null;
  color_label: string | null;
  product_id: string;
  product_name: string;
  product_brand: string;
  brand_display_name: string | null;
  product_category: string;
  supplier_id: string | null;
  owner_type: 'kolbe' | 'supplier';
  retail_enabled: boolean;
  retail_sale_enabled: boolean;
  wholesale_enabled: boolean;
  installment_policy: string;
  wholesale_moq: number | null;
  allow_installments: boolean;
  disable_installments_on_discount: boolean;
  sale_terms: Record<string, unknown> | null;
  cash_price_rial: string;
  installment_price_rial: string | null;
  wholesale_price_rial: string | null;
  /** Req 25 (Agent 2): variant-level retail price override, integer rial. */
  price_override_rial: string | null;
  status: string;
  active: boolean;
};

type OrderRow = {
  id: string;
  reference: string;
  buyer_id: string;
  status: OrderStatus;
  total_rial: string;
  subtotal_rial: string;
  discount_rial: string;
  shipping_rial: string;
  payment_mode: string;
  order_type: 'retail' | 'wholesale';
  fulfillment_via: string;
  wholesale_fulfillment_status: string | null;
  consolidated_at: Date | null;
  vip_dispatched_at: Date | null;
  created_at: Date;
};

const prepareFulfillmentBody = z.object({
  note: z.string().trim().max(500).optional(),
});

const createInboundShipmentBody = z.object({
  fulfillmentId: z.uuid(),
  destinationWarehouseId: z.uuid().optional(),
  carrier: z.string().trim().min(2).max(120).default('ترابری انبار کلبه'),
  trackingCode: z.string().trim().min(2).max(120).default('TRK-KOLBE'),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    orderLineId: z.uuid(),
    quantity: z.number().int().min(1).max(10000).optional(),
    dispatchedQuantity: z.number().int().min(1).max(10000).optional(),
  })).optional(),
});

const inspectInboundShipmentBody = z.object({
  inspectorNote: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    shipmentLineId: z.uuid().optional(),
    orderLineId: z.uuid().optional(),
    receivedQuantity: z.number().int().min(0).max(10000),
    acceptedQuantity: z.number().int().min(0).max(10000),
    rejectedQuantity: z.number().int().min(0).max(10000).default(0),
    damagedQuantity: z.number().int().min(0).max(10000).default(0),
    missingQuantity: z.number().int().min(0).max(10000).default(0),
    inspectionNote: z.string().trim().max(500).optional(),
  })).min(1).max(100),
});

async function ensureDefaultKolbeWarehouse(client: DbClient): Promise<string> {
  const existing = await one<{ id: string }>(
    client,
    'SELECT id FROM warehouses WHERE owner_id IS NULL AND active = true ORDER BY created_at ASC LIMIT 1',
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await client.query(
    "INSERT INTO warehouses(id, owner_id, code, name, active) VALUES ($1, NULL, 'KOLBE-CENTRAL', 'انبار مرکزی کلبه', true) ON CONFLICT (code) DO NOTHING",
    [id],
  );
  const found = await one<{ id: string }>(
    client,
    'SELECT id FROM warehouses WHERE owner_id IS NULL AND active = true ORDER BY created_at ASC LIMIT 1',
  );
  return found!.id;
}

async function assertWholesaleReadyForVipDispatch(client: DbClient, orderId: string): Promise<void> {
  const order = await one<{
    id: string;
    order_type: 'retail' | 'wholesale';
    wholesale_fulfillment_status: string | null;
  }>(
    client,
    'SELECT id, order_type, wholesale_fulfillment_status FROM orders WHERE id = $1 FOR UPDATE',
    [orderId],
  );
  if (!order || order.order_type !== 'wholesale') return;

  const supplierLines = await client.query<{
    id: string;
    sku: string;
    quantity: number;
    received_at_kolbe: Date | null;
    qc_status: string;
  }>(
    `SELECT l.id, l.sku, l.quantity, l.received_at_kolbe, l.qc_status
     FROM order_lines l
     JOIN product_variants v ON v.id = l.variant_id
     JOIN products p ON p.id = v.product_id
     WHERE l.order_id = $1 AND (l.supplier_id IS NOT NULL OR p.owner_type = 'supplier')`,
    [orderId],
  );

  if (supplierLines.rows.length === 0) return;

  for (const line of supplierLines.rows) {
    if (!line.received_at_kolbe || line.qc_status !== 'accepted') {
      throw conflict(
        `ارسال سفارش عمده به مشتری VIP قبل از دریافت فیزیکی در انبار کلبه و تأیید کنترل کیفیت (QC) مجاز نیست (SKU: ${line.sku}).`,
      );
    }
  }

  const receiptCount = await one<{ count: string }>(
    client,
    `SELECT COUNT(*)::text AS count
     FROM warehouse_receipts wr
     JOIN inbound_shipments s ON s.id = wr.inbound_shipment_id
     WHERE s.order_id = $1`,
    [orderId],
  );
  if (!receiptCount || Number(receiptCount.count) === 0) {
    throw conflict('رسید انبار کلبه (Warehouse Receipt) برای کالاهای تأمین‌کننده ثبت نشده است.');
  }

  if (
    order.wholesale_fulfillment_status !== 'ready_for_vip' &&
    order.wholesale_fulfillment_status !== 'vip_dispatched' &&
    order.wholesale_fulfillment_status !== 'delivered'
  ) {
    throw conflict(
      `سفارش عمده هنوز در انبار کلبه تجمیع و آماده ارسال به VIP نشده است (وضعیت فعلی: ${order.wholesale_fulfillment_status}).`,
    );
  }
}

export function registerOrderRoutes(app: FastifyInstance, pool: DbPool, config: Config, availableProviders = new Set<string>()) {
  app.post('/api/v1/orders', async (request, reply) => {
    const user = await principal(request, pool, config);
    await assertNotRestricted(pool, user.id, 'purchase');
    const body = checkout.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    const seriesUnitPrices = new Map<object, string>();
    // K: expand series recipes (relational source of truth) into variant lines.
    let seriesSnapshot: Array<Record<string, unknown>> | null = null;
    if (body.series?.length) {
      if (body.orderType !== 'wholesale') throw badRequest('سفارش بر مبنای سری فقط برای معاملات عمده مجاز است.');
      const merged = new Map<string, number>(body.items.map((item) => [item.variantId, item.quantity]));
      const pricedSeriesItems: typeof body.items = [];
      seriesSnapshot = [];
      for (const entry of body.series) {
        const composition = await loadSeriesComposition(pool, entry.seriesTemplateId);
        if (!composition || !composition.template.active) {
          throw badRequest('قالب سری انتخاب‌شده معتبر یا فعال نیست.');
        }
        seriesSnapshot.push({
          seriesTemplateId: entry.seriesTemplateId,
          name: composition.template.name,
          count: entry.count,
          components: composition.items.map((item) => ({
            variantId: item.variant_id, sku: item.sku, quantityPerSeries: item.quantity_per_series,
          })),
        });
        for (const item of allocateSeriesPrice(composition.items, composition.template.pricing_mode, composition.template.total_price_rial)) {
          if (item.basePriceRial !== null) {
            const line = { variantId: item.variant_id, quantity: item.quantity_per_series * entry.count };
            pricedSeriesItems.push(line); seriesUnitPrices.set(line, item.basePriceRial);
            continue;
          }
          merged.set(item.variant_id, (merged.get(item.variant_id) ?? 0) + item.quantity_per_series * entry.count);
        }
      }
      body.items = [...merged.entries()].map(([variantId, quantity]) => ({ variantId, quantity })).concat(pricedSeriesItems);
    }
    if (body.items.length === 0) throw badRequest('سفارش باید حداقل یک قلم یا یک سری داشته باشد.');

    // Status/restriction gates run before the order transaction so rejected orders leave audit logs intact.
    const priced = await pool.query<{
      id: string;
      supplier_id: string | null;
      cash_price_rial: string;
      installment_price_rial: string | null;
      wholesale_price_rial: string | null;
      price_override_rial: string | null;
    }>(
      `SELECT v.id, p.supplier_id, p.cash_price_rial::text, p.installment_price_rial::text, p.wholesale_price_rial::text,
              v.price_override_rial::text
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::uuid[])`,
      [body.items.map((item) => item.variantId)],
    );
    const incomingBySupplier = new Map<string, bigint>();
    for (const item of body.items) {
      const row = priced.rows.find((candidate) => candidate.id === item.variantId);
      if (!row?.supplier_id) continue;
      // Req 25 (Agent 2): a variant-level override replaces the product cash price for retail.
      const unit = rial(seriesUnitPrices.get(item) ?? (body.orderType === 'wholesale' ? row.wholesale_price_rial : row.price_override_rial ?? row.cash_price_rial) ?? '0');
      incomingBySupplier.set(row.supplier_id, (incomingBySupplier.get(row.supplier_id) ?? 0n) + unit * BigInt(item.quantity));
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
        const membership = await one<{ limits: Record<string, unknown> }>(
          client,
          `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
           WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
           LIMIT 1`,
          [user.id],
        );
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
          const count = await one<{ count: string }>(
            client,
            `SELECT count(*)::text AS count FROM orders WHERE buyer_id = $1 AND order_type = 'wholesale'
             AND status <> 'cancelled' AND created_at >=
             (date_trunc('month', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')`,
            [user.id],
          );
          if (Number(count?.count ?? 0) >= limits.maxOrdersPerMonth) throw conflict('سقف سفارش ماهانه این پلن تکمیل شده است.');
        }
      }

      const requiredDomain: 'retail' | 'wholesale' = body.orderType === 'wholesale' ? 'wholesale' : 'retail';

      const orderId = randomUUID();
      const sequence = await one<{ number: string }>(client, "SELECT nextval('order_reference_seq')::text AS number");
      const reference = `KV-${sequence!.number}`;

      const lines: Array<{
        id: string;
        variant: VariantRow;
        quantity: number;
        basePrice: bigint;
        unitDiscount: bigint;
        finalUnitPrice: bigint;
        baseTotal: bigint;
        discountTotal: bigint;
        total: bigint;
        matchedRuleId: string | null;
        pricing: ResolvedVariantPrice;
      }> = [];

      for (const item of body.items) {
        const variant = await one<VariantRow>(
          client,
          `SELECT v.id AS variant_id, v.sku, v.size_label, v.color_label, v.active,
                  v.retail_sale_enabled,
                  v.price_override_rial::text AS price_override_rial,
                  p.id AS product_id, p.name AS product_name, p.brand AS product_brand,
                  sp.brand_name AS brand_display_name,
                  p.category AS product_category,
                  p.supplier_id, p.owner_type, p.retail_enabled, p.wholesale_enabled,
                  p.installment_policy, p.wholesale_moq,
                  p.allow_installments, p.disable_installments_on_discount, p.sale_terms,
                  p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial, p.status
           FROM product_variants v
           JOIN products p ON p.id = v.product_id
           LEFT JOIN supplier_profiles sp ON sp.user_id = p.supplier_id
           WHERE v.id = $1`,
          [item.variantId],
        );
        if (!variant || !variant.active || variant.status !== 'published') throw notFound();
        if (body.orderType === 'retail') {
          if (variant.owner_type !== 'kolbe' || !variant.retail_enabled) {
            throw new ApiError(403, 'FORBIDDEN', `کالای ${variant.sku} متعلق به تأمین‌کننده عمده است و بدون انتقال مالکیت به کلبه در خرده‌فروشی قابل عرضه نیست.`);
          }
          // §29/§30: variant-level sale eligibility — effective sellability is server-side.
          if (!variant.retail_sale_enabled) {
            throw new ApiError(403, 'FORBIDDEN', `فروش خرده تنوع ${variant.sku} متوقف شده است.`);
          }
        } else {
          if (!variant.wholesale_enabled) {
            throw new ApiError(403, 'FORBIDDEN', `کالای ${variant.sku} برای فروش عمده فعال نیست.`);
          }
          if (limits.sources === 'kolbe' && variant.supplier_id) throw forbidden();
          const moq = typeof variant.sale_terms?.moq === 'number' ? variant.sale_terms.moq : 1;
          if (item.quantity < moq) {
            throw conflict(`حداقل تعداد سفارش عمده (MOQ) برای ${variant.sku} برابر ${moq} عدد است.`);
          }
        }

        const resolvedPrice = await resolveVariantPrice(client, item.variantId, {
          orderType: body.orderType,
          paymentMode: body.paymentMode,
          ...(seriesUnitPrices.has(item) ? { basePriceRial: seriesUnitPrices.get(item)! } : {}),
        });

        const basePrice = rial(resolvedPrice.basePrice);
        if (basePrice === 0n && !seriesUnitPrices.has(item)) throw badRequest(`قیمت فروش برای SKU ${variant.sku} معتبر نیست.`);
        const unitDiscount = rial(resolvedPrice.discountAmount);
        const finalUnitPrice = rial(resolvedPrice.finalPrice);

        if (body.paymentMode === 'four_installments') {
          // The canonical resolver decides both eligibility and whether ordinary discounts may
          // reduce the four-installment purchase — the order pipeline never re-derives the policy.
          if (!resolvedPrice.installmentEnabled || !variant.allow_installments) {
            throw conflict(`خرید اقساطی برای کالای ${variant.sku} غیرفعال است.`);
          }
          if (resolvedPrice.installmentDiscountBlocked) {
            throw conflict(`کالای ${variant.sku} دارای تخفیف فعال است و امکان خرید اقساطی ندارد.`);
          }
        }

        const qtyBig = BigInt(item.quantity);
        lines.push({
          id: randomUUID(),
          variant,
          quantity: item.quantity,
          basePrice,
          unitDiscount,
          finalUnitPrice,
          baseTotal: basePrice * qtyBig,
          discountTotal: unitDiscount * qtyBig,
          total: finalUnitPrice * qtyBig,
          matchedRuleId: resolvedPrice.matchedRule?.id ?? null,
          pricing: resolvedPrice,
        });
      }

      // Per-product wholesale minimum quantity (summed across variants).
      if (body.orderType === 'wholesale') {
        const qtyByProduct = new Map<string, { name: string; qty: number; moq: number | null }>();
        for (const line of lines) {
          const entry = qtyByProduct.get(line.variant.product_id)
            ?? { name: line.variant.product_name, qty: 0, moq: line.variant.wholesale_moq };
          entry.qty += line.quantity;
          qtyByProduct.set(line.variant.product_id, entry);
        }
        for (const entry of qtyByProduct.values()) {
          if (entry.moq !== null && entry.qty < entry.moq)
            throw conflict(`حداقل سفارش عمده «${entry.name}» ${entry.moq} عدد است.`);
        }
      }

      const baseSubtotal = addRial(lines.map((line) => line.baseTotal));
      const lineDiscountTotal = addRial(lines.map((line) => line.discountTotal));
      const afterLinePromoSubtotal = addRial(lines.map((line) => line.total));

      if (body.orderType === 'wholesale') {
        if (typeof limits.maxOrderValueRial === 'string' && afterLinePromoSubtotal > rial(limits.maxOrderValueRial))
          throw conflict('مبلغ سفارش از سقف پلن بالاتر است.');
        if (typeof limits.minOrderValueRial === 'string' && afterLinePromoSubtotal < rial(limits.minOrderValueRial))
          throw conflict('مبلغ سفارش از کف خرید این پلن کمتر است.');
        const suppliers = new Set(lines.map((line) => line.variant.supplier_id ?? 'kolbe'));
        if (typeof limits.maxSuppliersPerOrder === 'number' && suppliers.size > limits.maxSuppliersPerOrder)
          throw conflict('تعداد تأمین‌کنندگان سفارش از سقف پلن بالاتر است.');
      }

      const percent = body.orderType === 'wholesale' && typeof limits.discountPercent === 'number'
        && Number.isInteger(limits.discountPercent) && limits.discountPercent >= 0 && limits.discountPercent <= 90
        ? BigInt(limits.discountPercent) : 0n;
      const planDiscount = (afterLinePromoSubtotal * percent) / 100n;

      const context: DiscountContext = {
        userId: user.id,
        orderType: body.orderType,
        isVip: user.roles.includes('vip'),
        lines: lines.map((line) => ({
          productId: line.variant.product_id,
          category: line.variant.product_category,
          total: line.total,
        })),
      };
      const promo = body.couponCode
        ? await resolveCouponDiscount(client, context, body.couponCode)
        : await resolveFestivalDiscount(client, context);
      if (body.couponCode && promo.source === 'none') throw badRequest(promo.note ?? 'کد تخفیف معتبر نیست.');

      let discount = lineDiscountTotal + planDiscount + promo.discountRial;
      if (discount > baseSubtotal) discount = baseSubtotal;

      // Server-side installment policy enforcement (items 46-48)
      let installmentEligible = body.paymentMode === 'four_installments';
      let installmentBlockReason: string | null = null;
      if (body.paymentMode === 'four_installments') {
        const disabled = lines.find((line) => line.variant.installment_policy === 'disabled' || !line.variant.allow_installments);
        if (disabled) {
          installmentEligible = false;
          installmentBlockReason = `فروش اقساطی برای «${disabled.variant.product_name}» فعال نیست.`;
        } else if (discount > 0n) {
          const blocked = lines.find((line) => line.variant.installment_policy === 'disabled_when_discounted' || line.variant.disable_installments_on_discount);
          if (blocked) {
            installmentEligible = false;
            installmentBlockReason = `«${blocked.variant.product_name}» با تخفیف، فروش اقساطی ندارد.`;
          }
        }
        if (!installmentEligible) throw conflict(installmentBlockReason!);
      }

      let shippingRial = 0n;
      let shippingMethodId: string | null = null;
      let shippingQuote: { ruleId: string | null; pricingType: string; totalWeightGrams: number } | null = null;
      if (body.shippingMethodId) {
        const quote = await quoteShipping(client, body.shippingMethodId, {
          items: body.items.map((item) => ({ variantId: item.variantId, quantity: item.quantity })),
          subtotalRial: afterLinePromoSubtotal,
          province: body.shippingAddress.province,
          city: body.shippingAddress.city,
        });
        shippingMethodId = body.shippingMethodId;
        shippingRial = quote.feeRial;
        shippingQuote = { ruleId: quote.ruleId, pricingType: quote.pricingType, totalWeightGrams: quote.totalWeightGrams };
      }

      // Retail cashback wallet — calculation order: base → promotions → coupon → wallet → shipping.
      // The wallet pays part of the merchandise net (never shipping); validation is fully
      // server-side (policy, available balance, % cap) under the per-customer advisory lock,
      // so concurrent checkouts cannot double-spend the same credit.
      const merchNet = baseSubtotal - discount;
      let walletUsed = 0n;
      if (body.walletRial && rial(body.walletRial) > 0n) {
        const requested = rial(body.walletRial);
        const quote = await quoteRedemption(client, user.id, merchNet, body.paymentMode, body.orderType);
        if (!quote.enabled) throw badRequest(quote.reason ?? 'استفاده از کیف پول ممکن نیست.');
        if (requested > quote.maxRedeemRial)
          throw badRequest(`حداکثر مبلغ قابل استفاده از کیف پول ${quote.maxRedeemRial.toString()} ریال است.`);
        walletUsed = requested;
      }

      const total = baseSubtotal - discount - walletUsed + shippingRial;
      const installmentCount = 4;
      const pricingSnapshot = {
        baseSubtotalRial: baseSubtotal.toString(),
        lineDiscountRial: lineDiscountTotal.toString(),
        planDiscountRial: planDiscount.toString(),
        promoDiscountRial: promo.discountRial.toString(),
        promoSource: promo.source !== 'none' ? promo.source : (lineDiscountTotal > 0n ? 'promotion_rule' : 'none'),
        totalDiscountRial: discount.toString(),
        walletRedeemedRial: walletUsed.toString(),
        shippingRial: shippingRial.toString(),
        totalRial: total.toString(),
        installment: body.paymentMode === 'four_installments'
          ? { eligible: true, count: installmentCount, perInstallmentRial: (total / BigInt(installmentCount)).toString(), totalRial: total.toString() }
          : { eligible: installmentEligible, count: installmentCount, reason: installmentBlockReason },
        policies: lines.map((line) => ({ productId: line.variant.product_id, policy: line.variant.installment_policy })),
        // §25: the order keeps its OWN commercial truth — channel, payment mode and one
        // resolver-based pricing line per sold item, unaffected by later price/series edits.
        orderType: body.orderType,
        paymentMode: body.paymentMode,
        lines: lines.map((line) => ({
          variantId: line.variant.variant_id, productId: line.variant.product_id, sku: line.variant.sku,
          quantity: line.quantity,
          baseUnitRial: line.basePrice.toString(), discountUnitRial: line.unitDiscount.toString(),
          finalUnitRial: line.finalUnitPrice.toString(), lineTotalRial: line.total.toString(),
          channel: line.pricing.channel, paymentMode: line.pricing.paymentMode,
          installmentPolicy: line.pricing.installmentPolicy, installmentDiscountBlocked: line.pricing.installmentDiscountBlocked,
          source: line.pricing.source, matchedRuleId: line.pricing.matchedRule?.id ?? null,
          matchedTarget: line.pricing.matchedRule?.targetType ?? null,
        })),
        shipping: shippingQuote ? { methodId: shippingMethodId, ...shippingQuote } : null,
      };

      const hasSupplierLines =
        body.orderType === 'wholesale' &&
        lines.some((l) => l.variant.supplier_id !== null || l.variant.owner_type === 'supplier');
      const initialWholesaleStatus =
        body.orderType === 'wholesale'
          ? hasSupplierLines
            ? 'awaiting_supplier'
            : 'ready_for_vip'
          : null;

      await client.query(
        `INSERT INTO orders(
          id, reference, buyer_id, order_type, payment_mode, subtotal_rial, discount_rial, shipping_rial,
          shipping_method_id, total_rial, shipping_address, pricing_snapshot, fulfillment_via, inventory_domain, wholesale_fulfillment_status,
          series_snapshot, cashback_redeemed_rial
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'kolbe_warehouse',$13,$14,$15,$16)`,
        [
          orderId,
          reference,
          user.id,
          body.orderType,
          body.paymentMode,
          baseSubtotal.toString(),
          discount.toString(),
          shippingRial.toString(),
          shippingMethodId,
          total.toString(),
          JSON.stringify(body.shippingAddress),
          JSON.stringify(pricingSnapshot),
          requiredDomain,
          initialWholesaleStatus,
          seriesSnapshot ? JSON.stringify({ series: seriesSnapshot }) : null,
          walletUsed.toString(),
        ],
      );

      // Post the wallet redemption against the freshly created order (same transaction —
      // all-or-nothing with the order itself; idempotent key cb-redeem:{orderId}).
      if (walletUsed > 0n) {
        await redeemCashback(client, user.id, orderId, walletUsed, merchNet, body.paymentMode, body.orderType);
      }

      // Requirement 1: Create Supplier Fulfillments routed to Kolbe Central Warehouse for supplier-owned wholesale items
      const supplierFulfillmentBySupplier = new Map<string, string>();
      if (hasSupplierLines) {
        const kolbeCentralWarehouseId = await ensureDefaultKolbeWarehouse(client);
        for (const line of lines) {
          if (line.variant.supplier_id && !supplierFulfillmentBySupplier.has(line.variant.supplier_id)) {
            const fulfillmentId = randomUUID();
            const fSeq = await one<{ num: string }>(client, "SELECT nextval('supplier_fulfillment_seq')::text AS num");
            const fRef = `SF-${fSeq!.num}`;
            await client.query(
              `INSERT INTO supplier_fulfillments(
                id, reference, order_id, supplier_id, destination_warehouse_id, status
              ) VALUES ($1,$2,$3,$4,$5,'awaiting_supplier')`,
              [fulfillmentId, fRef, orderId, line.variant.supplier_id, kolbeCentralWarehouseId],
            );
            supplierFulfillmentBySupplier.set(line.variant.supplier_id, fulfillmentId);
          }
        }
      }

      for (const line of lines) {
        const fulfillmentId = line.variant.supplier_id
          ? (supplierFulfillmentBySupplier.get(line.variant.supplier_id) ?? null)
          : null;
        const isKolbeDirect =
          body.orderType === 'wholesale' &&
          !line.variant.supplier_id &&
          line.variant.owner_type === 'kolbe';

        // Reserve strictly from the matching inventory_domain ('retail' vs 'wholesale')
        //
        // PROMPT-1 §53 (documented limitation, OMS redesign deferred to Prompt 2):
        // this path reserves supplier-wholesale lines from piece-level stock_balances and
        // assumes the goods already sit in a kolbe warehouse. It CANNOT represent
        // source-specific allocation. Prompt 2 must route wholesale allocation through
        // source-aware APIs instead:
        //   A kolbe series stock            → series_stock_balances (owner=kolbe)
        //   B supplier stock-at-kolbe       → series_stock_balances (owner=supplier) + §50 conversion/settlement
        //   C declared external capacity    → reserveSupplierCapacity()/settleSupplierCapacityReservation()
        //                                     (supplier-offers.ts — NEVER stock_reservations)
        //   D order-bound cross-dock        → supplier_fulfillments Model D (below, L~2010)
        // Until then this adapter stays as-is so existing VIP checkout keeps working.
        const balance = await one<{ warehouse_id: string }>(
          client,
          `SELECT b.warehouse_id
           FROM stock_balances b
           JOIN warehouses w ON w.id = b.warehouse_id
           WHERE b.variant_id = $1
             AND b.inventory_domain = $2
             AND w.active = true
             AND ($2 = 'wholesale' OR w.owner_id IS NULL)
             AND b.on_hand - b.reserved - b.damaged >= $3
           ORDER BY (w.owner_id IS NULL) DESC, w.code LIMIT 1 FOR UPDATE OF b`,
          [line.variant.variant_id, requiredDomain, line.quantity],
        );
        if (!balance) {
          throw conflict(`موجودی ${requiredDomain === 'wholesale' ? 'عمده' : 'خرده‌فروشی'} برای SKU ${line.variant.sku} کافی نیست.`);
        }

        await client.query(
          `INSERT INTO order_lines(
            id, order_id, product_id, variant_id, supplier_id, product_name, sku, quantity,
            base_unit_price_rial, unit_price_rial, discount_amount_rial, line_total_rial,
            applied_promotion_rule_id, pricing_snapshot,
            supplier_fulfillment_id, qc_status, received_at_kolbe, inventory_domain
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            line.id,
            orderId,
            line.variant.product_id,
            line.variant.variant_id,
            line.variant.supplier_id,
            line.variant.product_name,
            line.variant.sku,
            line.quantity,
            line.basePrice.toString(),
            line.finalUnitPrice.toString(),
            line.discountTotal.toString(),
            line.total.toString(),
            line.matchedRuleId,
            JSON.stringify({
              ...line.pricing,
              // §25: the order line snapshots the commercial truth it was sold under.
              quantity: line.quantity,
              lineBaseRial: line.baseTotal.toString(),
              lineDiscountRial: line.discountTotal.toString(),
              lineTotalRial: line.total.toString(),
              series: seriesSnapshot?.length ? seriesSnapshot : null,
            }),
            fulfillmentId,
            isKolbeDirect ? 'accepted' : 'pending',
            isKolbeDirect ? new Date() : null,
            requiredDomain,
          ],
        );

        const updated = await client.query(
          `UPDATE stock_balances
           SET reserved = reserved + $4, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3
             AND on_hand - reserved - damaged >= $4`,
          [line.variant.variant_id, balance.warehouse_id, requiredDomain, line.quantity],
        );
        if (!updated.rowCount) throw conflict(`موجودی SKU ${line.variant.sku} تغییر کرده است.`);

        await client.query(
          `INSERT INTO stock_reservations(id, order_line_id, variant_id, warehouse_id, inventory_domain, quantity, status)
           VALUES ($1,$2,$3,$4,$5,$6,'active')`,
          [randomUUID(), line.id, line.variant.variant_id, balance.warehouse_id, requiredDomain, line.quantity],
        );
        await client.query(
          `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,'order reservation','order',$6,$7,$8)`,
          [randomUUID(), line.variant.variant_id, balance.warehouse_id, requiredDomain, line.quantity, orderId, user.id, `reserve:${line.id}`],
        );
      }

      // §36/§46: wholesale orders reserve INTACT series when explicit series stock is tracked.
      // Component piece reservations above stay the physical bookkeeping; this is the series-unit
      // banding of the same goods — one of two concurrent buyers of the last series must fail here.
      if (body.series?.length) {
        for (const entry of body.series) {
          const tracked = await one<{ c: string }>(
            client, 'SELECT count(*)::text AS c FROM series_stock_balances WHERE series_template_id = $1', [entry.seriesTemplateId]);
          if (Number(tracked?.c ?? '0') === 0) continue; // legacy untracked template → component-level availability only
          const seriesRow = await one<{
            warehouse_id: string; owner_type: 'kolbe' | 'supplier'; supplier_id: string | null;
          }>(
            client,
            `SELECT warehouse_id, owner_type, supplier_id
             FROM series_stock_balances
             WHERE series_template_id = $1 AND on_hand - reserved - damaged >= $2
             ORDER BY on_hand - reserved - damaged DESC LIMIT 1 FOR UPDATE`,
            [entry.seriesTemplateId, entry.count]);
          if (!seriesRow) throw conflict('سری کامل قابل فروش برای این قالب کافی نیست.');
          const recipeSnapshot = await buildRecipeSnapshot(client, entry.seriesTemplateId);
          await applySeriesMovement(client, {
            templateId: entry.seriesTemplateId, warehouseId: seriesRow.warehouse_id,
            owner: { ownerType: seriesRow.owner_type, supplierId: seriesRow.supplier_id },
            movementType: 'reserve', reservedDelta: entry.count, recipeSnapshot,
            referenceType: 'order', referenceId: orderId, actorId: user.id,
            idempotencyKey: `series-reserve:${orderId}:${entry.seriesTemplateId}`,
          });
          await client.query(
            `INSERT INTO order_series_reservations(id, order_id, series_template_id, warehouse_id, owner_type, supplier_id, series_count, recipe_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [randomUUID(), orderId, entry.seriesTemplateId, seriesRow.warehouse_id, seriesRow.owner_type, seriesRow.supplier_id,
              entry.count, JSON.stringify(recipeSnapshot)]);
        }
      }

      await client.query(
        `INSERT INTO order_events(id, order_id, to_status, actor_id, note)
         VALUES ($1,$2,'pending_payment',$3,$4)`,
        [
          randomUUID(),
          orderId,
          user.id,
          body.orderType === 'wholesale'
            ? 'سفارش عمده ثبت و موجودی عمده رزرو شد (تأمین و کنترل کیفیت از طریق انبار مرکزی کلبه)'
            : 'سفارش ثبت و موجودی خرده‌فروشی رزرو شد',
        ],
      );

      const paymentIntentId = randomUUID();
      const provider = body.paymentMode === 'cash' ? (body.orderType === 'retail' ? 'zibal' : 'nextpay') : 'not_configured';
      await client.query(
        `INSERT INTO payment_intents(id, reference, order_id, provider, amount_rial, status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [paymentIntentId, `PAY-${sequence!.number}`, orderId, provider, total.toString()],
      );

      await audit(client, user.id, 'order.created', 'order', orderId, undefined, { reference, totalRial: total.toString(), orderType: body.orderType }, request.ip);
      await outbox(client, 'order.created', 'order', orderId, { orderId, reference, orderType: body.orderType });
      await markCartConverted(client, user.id, orderId);
      if (promo.couponId && promo.discountRial > 0n) {
        await recordRedemption(client, promo.couponId, user.id, orderId, promo.discountRial);
      }

      const response = {
        id: orderId,
        reference,
        status: 'pending_payment',
        orderType: body.orderType,
        inventoryDomain: requiredDomain,
        fulfillmentVia: 'kolbe_warehouse',
        wholesaleFulfillmentStatus: initialWholesaleStatus,
        subtotalRial: asRial(baseSubtotal),
        discountRial: asRial(discount),
        shippingRial: asRial(shippingRial),
        shippingMethodId,
        totalRial: asRial(total),
        paymentIntentId,
        paymentAvailable: availableProviders.has(provider),
        pricingSnapshot,
        lines: lines.map((l) => ({
          id: l.id,
          variantId: l.variant.variant_id,
          sku: l.variant.sku,
          productName: l.variant.product_name,
          brandDisplayName: l.variant.brand_display_name ?? l.variant.product_brand,
          quantity: l.quantity,
          baseUnitPriceRial: asRial(l.basePrice),
          unitPriceRial: asRial(l.finalUnitPrice),
          discountAmountRial: asRial(l.discountTotal),
          lineTotalRial: asRial(l.total),
          appliedPromotionRuleId: l.matchedRuleId,
          pricing: l.pricing,
          fulfillmentChannel: 'kolbe_warehouse',
        })),
      };
      // K: persist the series composition as a snapshot on the order itself (JSON is
      // snapshot-only; series_template_items stays the source of truth).
      if (seriesSnapshot) {
        await audit(client, user.id, 'order.series_snapshot', 'order', orderId, undefined, { series: seriesSnapshot }, request.ip);
        await outbox(client, 'order.series_snapshot', 'order', orderId, { series: seriesSnapshot });
      }
      await completeIdempotency(client, user.id, 'order.create', key, response);
      return response;
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/orders', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.iso.datetime().optional(),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
      status: orderStatus.optional(),
      orderType: z.enum(['retail', 'wholesale']).optional(),
      paymentStatus: z.enum(['pending', 'succeeded', 'failed', 'refunded', 'none']).optional(),
      supplierId: z.uuid().optional(),
      search: z.string().trim().max(120).optional(),
      sort: orderSort.default('newest'),
      // §18: wholesale is split by SELLER — Kolbe-owned stock vs supplier-fulfilled orders.
      sellerScope: z.enum(['kolbe', 'supplier']).optional(),
      // §30-§32: server-side operational filters.
      shipmentStatus: z.string().trim().max(40).optional(),
      carrier: z.string().trim().max(80).optional(),
      hasTracking: z.coerce.number().int().min(0).max(1).optional(),
      dateFrom: z.iso.datetime().optional(),
      dateTo: z.iso.datetime().optional(),
      amountMinRial: z.string().regex(/^\d+$/).optional(),
      amountMaxRial: z.string().regex(/^\d+$/).optional(),
      problem: z.coerce.number().int().min(0).max(1).optional(),
      withTotal: z.coerce.number().int().min(0).max(1).optional(),
    }).parse(request.query);
    const privileged = user.permissions.includes('orders:read');
    const orderBy = SORT_SQL[query.sort];
    const rows = await pool.query(
      `SELECT o.id, o.reference, o.buyer_id, o.status, o.order_type, o.payment_mode, o.sales_channel,
              o.subtotal_rial, o.discount_rial, o.shipping_rial, o.total_rial,
              o.fulfillment_via, o.wholesale_fulfillment_status, o.consolidated_at, o.vip_dispatched_at,
              o.created_at, o.updated_at,
              u.display_name AS buyer_name, u.phone AS buyer_phone,
              (SELECT count(*)::int FROM order_lines l WHERE l.order_id = o.id) AS lines_count,
              (SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1) AS payment_status,
              (SELECT e.to_status FROM order_events e WHERE e.order_id = o.id AND e.to_status LIKE 'fulfillment:%'
                 ORDER BY e.created_at DESC LIMIT 1) AS fulfillment_status,
              ${PAYMENT_RANK} AS payment_rank, ${FULFILLMENT_RANK} AS fulfillment_rank,
              COALESCE((SELECT jsonb_agg(DISTINCT COALESCE(sp.brand_name, su.display_name, 'کلبه وینتیج'))
                        FROM order_lines l2 LEFT JOIN supplier_profiles sp ON sp.user_id = l2.supplier_id
                        LEFT JOIN users su ON su.id = l2.supplier_id WHERE l2.order_id = o.id), '[]'::jsonb) AS supplier_names,
              (SELECT COALESCE(sp.brand_name, su.display_name)
                 FROM order_lines l3 LEFT JOIN supplier_profiles sp ON sp.user_id = l3.supplier_id
                 LEFT JOIN users su ON su.id = l3.supplier_id WHERE l3.order_id = o.id ORDER BY l3.id LIMIT 1) AS first_supplier,
              sh.carrier AS shipment_carrier, sh.shipment_status, ${TRACKING_SQL} AS tracking_code,
              ${EXCEPTIONS_SQL} AS exception_reasons,
              count(*) OVER()::int AS total_rows
       FROM orders o LEFT JOIN users u ON u.id = o.buyer_id
       ${LATEST_SHIPMENT_JOIN}
       WHERE ($1::boolean OR o.buyer_id = $2)
         AND ($3::timestamptz IS NULL OR o.created_at < $3)
         AND ($4::text IS NULL OR o.status = $4)
         AND ($5::text IS NULL OR o.order_type = $5)
         AND ($6::text IS NULL OR COALESCE((SELECT pi.status FROM payment_intents pi WHERE pi.order_id = o.id ORDER BY pi.created_at DESC LIMIT 1), 'none') = $6)
         AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM order_lines sl WHERE sl.order_id = o.id AND sl.supplier_id = $7))
         AND ($8::text IS NULL OR o.reference ILIKE '%' || $8 || '%' OR u.display_name ILIKE '%' || $8 || '%'
              OR u.phone ILIKE '%' || $8 || '%' OR ${TRACKING_SQL} ILIKE '%' || $8 || '%'
              OR EXISTS (SELECT 1 FROM order_lines ql WHERE ql.order_id = o.id AND (ql.sku ILIKE '%' || $8 || '%' OR ql.product_name ILIKE '%' || $8 || '%')))
         AND ($11::text IS NULL
              OR ($11 = 'kolbe' AND NOT EXISTS (SELECT 1 FROM order_lines sk WHERE sk.order_id = o.id AND sk.supplier_id IS NOT NULL))
              OR ($11 = 'supplier' AND EXISTS (SELECT 1 FROM order_lines sk WHERE sk.order_id = o.id AND sk.supplier_id IS NOT NULL)))
         AND ($12::text IS NULL OR sh.shipment_status = $12)
         AND ($13::integer IS NULL OR ($13 = 1 AND ${TRACKING_SQL} IS NOT NULL) OR ($13 = 0 AND ${TRACKING_SQL} IS NULL))
         AND ($14::text IS NULL OR COALESCE(sh.carrier, o.vip_carrier) ILIKE '%' || $14 || '%')
         AND ($15::timestamptz IS NULL OR o.created_at >= $15)
         AND ($16::timestamptz IS NULL OR o.created_at <= $16)
         AND ($17::bigint IS NULL OR o.total_rial >= $17)
         AND ($18::bigint IS NULL OR o.total_rial <= $18)
         AND ($19::integer IS NULL OR $19 = 0 OR cardinality(${EXCEPTIONS_SQL}) > 0)
       ORDER BY ${orderBy} LIMIT $9 OFFSET $10`,
      [
        privileged,
        user.id,
        query.before ?? null,
        query.status ?? null,
        query.orderType ?? null,
        query.paymentStatus ?? null,
        privileged ? (query.supplierId ?? null) : null,
        query.search ?? null,
        query.limit,
        query.offset,
        query.sellerScope ?? null,
        query.shipmentStatus ?? null,
        query.hasTracking ?? null,
        query.carrier ?? null,
        query.dateFrom ?? null,
        query.dateTo ?? null,
        query.amountMinRial ?? null,
        query.amountMaxRial ?? null,
        query.problem ?? null,
      ],
    );

    const total = rows.rows.length ? Number(rows.rows[0].total_rows) : 0;
    return {
      items: rows.rows.map((row) => {
        const { total_rows: _ignored, ...rest } = row;
        const base: Record<string, unknown> = {
          ...rest,
          subtotal_rial: asRial(row.subtotal_rial),
          discount_rial: asRial(row.discount_rial),
          shipping_rial: asRial(row.shipping_rial),
          total_rial: asRial(row.total_rial),
          fulfillment_status: row.fulfillment_status ? String(row.fulfillment_status).replace(/^fulfillment:/, '') : null,
        };
        if (!privileged) {
          delete base.supplier_names;
          delete base.first_supplier;
          delete base.exception_reasons;
        }
        return base;
      }),
      ...(query.withTotal === 1 ? { total, limit: query.limit, offset: query.offset } : {}),
    };
  });

  app.get('/api/v1/orders/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const privileged = user.permissions.includes('orders:read');
    const order = await one<OrderRow & Record<string, unknown>>(
      pool,
      `SELECT o.*, u.display_name AS buyer_name, u.phone AS buyer_phone, u.email AS buyer_email,
              sm.code AS shipping_code, sm.name AS shipping_name
       FROM orders o LEFT JOIN users u ON u.id = o.buyer_id
       LEFT JOIN shipping_methods sm ON sm.id = o.shipping_method_id WHERE o.id = $1`,
      [id],
    );
    if (!order || (order.buyer_id !== user.id && !privileged)) throw notFound();

    const payments = await pool.query('SELECT id, reference, provider, amount_rial, status, created_at FROM payment_intents WHERE order_id = $1 ORDER BY created_at', [id]);

    if (privileged) {
      const lines = await pool.query(
        `SELECT l.id, l.product_id, l.variant_id, l.supplier_id,
                COALESCE(sp.brand_name, p.brand) AS brand_display_name,
                l.sku, l.product_name, l.quantity,
                l.base_unit_price_rial::text, l.unit_price_rial::text, l.discount_amount_rial::text,
                l.line_total_rial::text, l.applied_promotion_rule_id, l.supplier_fulfillment_id,
                l.received_at_kolbe, l.qc_status
         FROM order_lines l
         LEFT JOIN products p ON p.id = l.product_id
         LEFT JOIN supplier_profiles sp ON sp.user_id = l.supplier_id
         WHERE l.order_id = $1 ORDER BY l.id`,
        [id],
      );
      const events = await pool.query(
        'SELECT from_status,to_status,note,actor_id,created_at FROM order_events WHERE order_id = $1 ORDER BY created_at,id',
        [id],
      );
      const fulfillments = await pool.query(
        `SELECT sf.id, sf.reference, sf.supplier_id, sp.brand_name, sf.destination_warehouse_id,
                sf.status, sf.dispatched_at, sf.arrived_at, sf.accepted_at
         FROM supplier_fulfillments sf
         LEFT JOIN supplier_profiles sp ON sp.user_id = sf.supplier_id
         WHERE sf.order_id = $1 ORDER BY sf.created_at`,
        [id],
      );
      return {
        ...order,
        fulfillment_via: order.fulfillment_via ?? 'kolbe_warehouse',
        subtotal_rial: asRial(String(order.subtotal_rial)),
        discount_rial: asRial(String(order.discount_rial ?? '0')),
        shipping_rial: asRial(String(order.shipping_rial ?? '0')),
        total_rial: asRial(order.total_rial),
        lines: lines.rows,
        events: events.rows,
        payments: payments.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })),
        fulfillments: fulfillments.rows,
      };
    }

    // ==========================================================================
    // REQUIREMENT 2: Safe VIP/Customer Order Read Model (Zero Supplier Leaks)
    // ==========================================================================
    const buyerLines = await pool.query(
      `SELECT l.id, l.sku, l.product_name,
              COALESCE(sp.brand_name, p.brand, 'کلبه وینتیج') AS brand_display_name,
              l.quantity, l.base_unit_price_rial::text AS base_unit_price_rial,
              l.unit_price_rial::text AS unit_price_rial,
              l.discount_amount_rial::text AS discount_amount_rial,
              l.line_total_rial::text AS line_total_rial,
              l.qc_status, 'kolbe_warehouse'::text AS fulfillment_channel
       FROM order_lines l
       LEFT JOIN products p ON p.id = l.product_id
       LEFT JOIN supplier_profiles sp ON sp.user_id = l.supplier_id
       WHERE l.order_id = $1 ORDER BY l.id`,
      [id],
    );
    const buyerEvents = await pool.query(
      'SELECT from_status,to_status,note,created_at FROM order_events WHERE order_id = $1 ORDER BY created_at,id',
      [id],
    );
    return {
      id: order.id,
      reference: order.reference,
      order_type: order.order_type,
      payment_mode: order.payment_mode,
      status: order.status,
      subtotal_rial: asRial(String(order.subtotal_rial)),
      discount_rial: asRial(String(order.discount_rial ?? '0')),
      shipping_rial: asRial(String(order.shipping_rial ?? '0')),
      total_rial: asRial(order.total_rial),
      shipping_method_id: order.shipping_method_id,
      shipping_code: order.shipping_code,
      shipping_name: order.shipping_name,
      shipping_address: order.shipping_address,
      pricing_snapshot: order.pricing_snapshot,
      wholesale_fulfillment_status: order.wholesale_fulfillment_status,
      consolidated_at: order.consolidated_at,
      vip_dispatched_at: order.vip_dispatched_at,
      created_at: order.created_at,
      fulfillment_via: 'kolbe_warehouse',
      lines: buyerLines.rows,
      events: buyerEvents.rows,
      payments: payments.rows.map((row) => ({ ...row, amount_rial: asRial(row.amount_rial) })),
    };
  });

  /**
   * Shared transition core — the single endpoint and §34 bulk endpoint go through
   * EXACTLY this rulebook (status machine, payment gate, reservation movements,
   * wholesale dispatch guard, earnings, events, audit).
   */
  async function applyOrderTransitionCore(
    client: PoolClient,
    user: Awaited<ReturnType<typeof principal>>,
    id: string,
    status: OrderStatus,
    effectiveNote: string | null,
    ip: string,
  ) {
    {
      const order = await one<OrderRow>(client, 'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!order) throw notFound();
      if (order.buyer_id === user.id && status === 'cancelled' && order.status === 'pending_payment') {
        // A buyer can cancel an unpaid order.
      } else {
        requirePermission(user, 'orders:transition');
      }
      if (!allowed[order.status].includes(status)) {
        throw conflict('این تغییر وضعیت در مرحله فعلی مجاز نیست.');
      }

      // §26: payment gate — the status machine already blocks unpaid orders from
      // fulfillment (pending_payment → only paid/cancelled). Marking PAID by hand is
      // the legitimate cash/COD/offline path, but it MUST document the evidence.
      if (status === 'paid') {
        const succeededIntent = await one<{ id: string }>(client,
          `SELECT id FROM payment_intents WHERE order_id = $1 AND status = 'succeeded' LIMIT 1`, [id]);
        if (!succeededIntent && (!effectiveNote || effectiveNote.trim().length < 5)) {
          throw badRequest('برای ثبت دستی «پرداخت شد» بدون پرداخت موفق درگاه، یادداشت روش پرداخت آفلاین (نقدی/کارت‌به‌کارت تأییدشده/پرداخت در محل) الزامی است.');
        }
      }

      // ========================================================================
      // REQUIREMENT 1: Hard Server-Side Guard on Wholesale VIP Dispatch
      // No wholesale order with supplier items can transition to ready_to_ship,
      // in_transit, shipped, or delivered before Kolbe Warehouse receipt, QC
      // acceptance, and consolidation!
      // ========================================================================
      if (
        order.order_type === 'wholesale' &&
        (status === 'ready_to_ship' ||
          status === 'in_transit' ||
          status === 'shipped' ||
          status === 'delivered')
      ) {
        const supplierWarehouseReservation = await one<{ id: string }>(
          client,
          `SELECT r.id FROM stock_reservations r
           JOIN order_lines l ON l.id = r.order_line_id
           JOIN warehouses w ON w.id = r.warehouse_id
           WHERE l.order_id = $1 AND w.owner_id IS NOT NULL LIMIT 1`,
          [id],
        );
        const hasInboundShipment = await one<{ id: string }>(
          client,
          'SELECT id FROM inbound_shipments WHERE order_id = $1 LIMIT 1',
          [id],
        );
        if (supplierWarehouseReservation || hasInboundShipment) {
          await assertWholesaleReadyForVipDispatch(client, id);
        }
      }

      if (status === 'cancelled' || status === 'in_transit' || status === 'shipped') {
        const reservations = await client.query<{
          id: string;
          variant_id: string;
          warehouse_id: string;
          inventory_domain: 'retail' | 'wholesale';
          quantity: number;
        }>(
          `SELECT r.id, r.variant_id, r.warehouse_id, r.inventory_domain, r.quantity
           FROM stock_reservations r
           JOIN order_lines l ON l.id = r.order_line_id
           WHERE l.order_id = $1 AND r.status = 'active' FOR UPDATE OF r`,
          [id],
        );
        for (const reservation of reservations.rows) {
          const consume = status === 'in_transit' || status === 'shipped';
          await client.query(
            `UPDATE stock_balances
             SET reserved = reserved - $4,
                 on_hand = on_hand - $5,
                 version = version + 1,
                 updated_at = now()
             WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
            [
              reservation.variant_id,
              reservation.warehouse_id,
              reservation.inventory_domain,
              reservation.quantity,
              consume ? reservation.quantity : 0,
            ],
          );
          await client.query(
            'UPDATE stock_reservations SET status = $2, updated_at = now() WHERE id = $1',
            [reservation.id, consume ? 'consumed' : 'released'],
          );
          await client.query(
            `INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reserved_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'order',$8,$9,$10)`,
            [
              randomUUID(),
              reservation.variant_id,
              reservation.warehouse_id,
              reservation.inventory_domain,
              consume ? -reservation.quantity : 0,
              -reservation.quantity,
              consume ? 'order shipped' : 'order cancelled',
              id,
              user.id,
              `${status}:${reservation.id}`,
            ],
          );
        }

        // §36: mirror the series-unit reservations — release on cancel, consume on dispatch.
        const seriesReservations = await client.query<{
          id: string; series_template_id: string; warehouse_id: string;
          owner_type: 'kolbe' | 'supplier'; supplier_id: string | null; series_count: number;
        }>(
          `SELECT id, series_template_id, warehouse_id, owner_type, supplier_id, series_count
           FROM order_series_reservations WHERE order_id = $1 AND status = 'active' FOR UPDATE`,
          [id]);
        for (const sr of seriesReservations.rows) {
          const consumeSeries = status === 'in_transit' || status === 'shipped';
          await applySeriesMovement(client, {
            templateId: sr.series_template_id, warehouseId: sr.warehouse_id,
            owner: { ownerType: sr.owner_type, supplierId: sr.supplier_id },
            movementType: consumeSeries ? 'consume' : 'release',
            onHandDelta: consumeSeries ? -sr.series_count : undefined,
            reservedDelta: -sr.series_count,
            referenceType: 'order', referenceId: id, actorId: user.id,
            note: consumeSeries ? 'ارسال سفارش عمده (مصرف سری)' : 'لغو سفارش عمده (آزادسازی سری)',
            idempotencyKey: `series-${status}:${sr.id}`,
          });
          await client.query(
            `UPDATE order_series_reservations SET status = $2, updated_at = now() WHERE id = $1`,
            [sr.id, consumeSeries ? 'consumed' : 'released']);
        }
      }

      if (order.order_type === 'wholesale' && (status === 'in_transit' || status === 'shipped')) {
        await client.query(
          "UPDATE orders SET wholesale_fulfillment_status = 'vip_dispatched', vip_dispatched_at = COALESCE(vip_dispatched_at, now()) WHERE id = $1",
          [id],
        );
      }
      if (order.order_type === 'wholesale' && status === 'delivered') {
        await client.query("UPDATE orders SET wholesale_fulfillment_status = 'delivered' WHERE id = $1", [id]);
      }

      await client.query('UPDATE orders SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
      if (status === 'delivered') await postSupplierEarnings(client, id);
      if (status === 'cancelled') {
        await client.query("UPDATE payment_intents SET status = 'failed' WHERE order_id = $1 AND status = 'pending'", [id]);
      }
      // Retail cashback lifecycle (all idempotent — a re-sent transition cannot double-post):
      if (status === 'paid') await earnCashbackOnPaid(client, id);                 // manual/offline paid path
      if (status === 'delivered') await scheduleCashbackRelease(client, id);       // start release-delay clock
      if (status === 'cancelled' || status === 'returned') {
        await reverseCashbackForOrder(client, id, user.id, 'برگشت کش‌بک به دلیل لغو/مرجوعی سفارش');
        await restoreRedeemedCashback(client, id, 'cancel', user.id);              // give spent credit back
      }
      await client.query(
        'INSERT INTO order_events(id,order_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), id, order.status, status, user.id, effectiveNote],
      );
      await audit(
        client,
        user.id,
        'order.status_changed',
        'order',
        id,
        { status: order.status },
        { status: status, note: effectiveNote },
        ip,
      );
      await outbox(client, 'order.status_changed', 'order', id, { orderId: id, from: order.status, to: status });
      return { id, reference: order.reference, status };
    }
  }

  app.post('/api/v1/orders/:id/transitions', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      status: orderStatus,
      note: z.string().trim().max(1000).optional(),
      reason: z.string().trim().max(1000).optional(),
    }).parse(request.body);
    const effectiveNote = body.note ?? body.reason ?? null;
    return transaction(pool, (client) => applyOrderTransitionCore(client, user, id, body.status, effectiveNote, request.ip));
  });

  // §34: bulk status change — ONE backend request, per-item results with readable
  // reasons; a failing order never rolls back the orders that were valid.
  /**
   * §31-§35: manual/offline sale = a REAL retail order on the canonical pipeline.
   * No parallel sale system: pricing via the canonical resolver, stock via normal order
   * reservations, consumption via the SAME transition core (exactly once), full audit.
   */
  app.post('/api/v1/admin/manual-orders', async (request, reply) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'sales:manage');
    const body = z.object({
      customer: z.object({
        customerId: z.uuid().optional(),
        name: z.string().trim().min(2).max(120).optional(),
        mobile: z.string().trim().regex(/^09\d{9}$/, 'شماره موبایل معتبر نیست.').optional(),
      }).refine((c) => c.customerId || (c.name && c.mobile), 'مشتری موجود یا نام+موبایل لازم است.'),
      channel: z.enum(['instagram', 'in_person', 'whatsapp', 'telegram', 'phone', 'other']),
      warehouseId: z.uuid(),
      items: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(50)
        .refine((items) => new Set(items.map((i) => i.variantId)).size === items.length, 'هر تنوع فقط یک بار مجاز است.'),
      payment: z.object({
        method: z.enum(['cash', 'card_to_card', 'gateway', 'cod']),
        status: z.enum(['paid', 'pending']),
        reference: z.string().trim().max(120).optional(),
      }),
      deliverNow: z.boolean().default(false),
      note: z.string().trim().max(1000).optional(),
      shippingAddress: z.object({
        recipient: z.string().trim().min(2).max(120),
        phone: z.string().regex(/^09\d{9}$/),
        province: z.string().trim().min(2).max(120),
        city: z.string().trim().min(2).max(120),
        line: z.string().trim().min(10).max(500),
        postalCode: z.string().regex(/^\d{10}$/),
      }).optional(),
    }).strict().parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');
    if (body.payment.method === 'card_to_card' && body.payment.status === 'paid' && !body.payment.reference?.trim()) {
      throw badRequest('برای کارت‌به‌کارت پرداخت‌شده، کد پیگیری لازم است.');
    }
    if (body.deliverNow && body.payment.status !== 'paid') {
      throw badRequest('تحویل حضوری فقط برای سفارش پرداخت‌شده ممکن است.');
    }

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'manual_order.create', key, requestHash(body));
      if (claim.previous) return { reused: true, body: claim.previous };

      // retail warehouse only (§40)
      const warehouse = await one<{ id: string; name: string; purpose: string }>(
        client, 'SELECT id, name, purpose FROM warehouses WHERE id = $1 AND active = true', [body.warehouseId]);
      if (!warehouse) throw badRequest('انبار انتخاب‌شده معتبر یا فعال نیست.');
      if (warehouse.purpose === 'wholesale') throw badRequest('فروش دستی خرده از انبار عمده مجاز نیست.');

      // §32: customer find-or-create by mobile (canonical users table, role customer)
      let buyerId = body.customer.customerId ?? null;
      let customerCreated = false;
      if (!buyerId) {
        const existing = await one<{ id: string }>(client, 'SELECT id FROM users WHERE phone = $1', [body.customer.mobile]);
        if (existing) buyerId = existing.id;
        else {
          buyerId = randomUUID();
          await client.query(
            'INSERT INTO users(id, phone, password_hash, display_name) VALUES ($1,$2,$3,$4)',
            [buyerId, body.customer.mobile, await argon2.hash(randomUUID()), body.customer.name]);
          await client.query('INSERT INTO user_roles(user_id, role_code) VALUES ($1,$2)', [buyerId, 'customer']);
          customerCreated = true;
        }
      } else {
        const exists = await one<{ id: string }>(client, 'SELECT id FROM users WHERE id = $1', [buyerId]);
        if (!exists) throw badRequest('مشتری انتخاب‌شده یافت نشد.');
      }

      const orderId = randomUUID();
      const sequence = await one<{ number: string }>(client, "SELECT nextval('order_reference_seq')::text AS number");
      const reference = `KV-${sequence!.number}`;
      const customerDisplay = body.customer.name ?? '';
      const address = body.shippingAddress ?? {
        recipient: customerDisplay || 'مشتری حضوری',
        phone: body.customer.mobile ?? '09000000000',
        province: 'تهران', city: 'تهران',
        line: body.channel === 'in_person' ? 'تحویل حضوری در فروشگاه کلبه' : 'آدرس ثبت‌نشده — هماهنگی تلفنی',
        postalCode: '0000000000',
      };

      // order shell FIRST (order_lines FK), totals updated after pricing the lines.
      await client.query(
        `INSERT INTO orders(id, reference, buyer_id, order_type, payment_mode, subtotal_rial, discount_rial, shipping_rial,
           total_rial, shipping_address, pricing_snapshot, fulfillment_via, inventory_domain, sales_channel)
         VALUES ($1,$2,$3,'retail','cash','0','0','0','0',$4,$5,'kolbe_warehouse','retail',$6)`,
        [orderId, reference, buyerId, JSON.stringify(address),
          JSON.stringify({ source: 'manual_order', channel: body.channel, createdBy: user.id }), body.channel]);

      let subtotal = 0n;
      let discountTotal = 0n;
      const lineRows: Array<{ id: string; variantId: string; sku: string; quantity: number }> = [];
      for (const item of body.items) {
        const variant = await one<{
          id: string; sku: string; active: boolean; retail_sale_enabled: boolean;
          product_id: string; product_name: string; status: string; owner_type: string; retail_enabled: boolean; supplier_id: string | null;
        }>(client,
          `SELECT v.id, v.sku, v.active, v.retail_sale_enabled, p.id AS product_id, p.name AS product_name,
                  p.status, p.owner_type, p.retail_enabled, p.supplier_id
           FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`, [item.variantId]);
        if (!variant || !variant.active || variant.status !== 'published') throw badRequest('تنوع انتخاب‌شده معتبر یا منتشرشده نیست.');
        if (variant.owner_type !== 'kolbe') throw forbidden(`کالای ${variant.sku} متعلق به تأمین‌کننده است و در خرده قابل فروش نیست.`);
        if (!variant.retail_enabled || !variant.retail_sale_enabled) {
          throw forbidden(`فروش خرده ${variant.sku} متوقف است؛ ابتدا وضعیت فروش را فعال کنید.`);
        }

        // §33: canonical retail pricing — same resolver as the website checkout.
        const resolved = await resolveVariantPrice(client, item.variantId, { orderType: 'retail', paymentMode: 'cash' });
        const basePrice = rial(resolved.basePrice);
        if (basePrice === 0n) throw badRequest(`قیمت فروش ${variant.sku} معتبر نیست.`);
        const unitDiscount = rial(resolved.discountAmount);
        const finalUnit = rial(resolved.finalPrice);
        const lineTotal = finalUnit * BigInt(item.quantity);
        subtotal += basePrice * BigInt(item.quantity);
        discountTotal += unitDiscount * BigInt(item.quantity);

        const lineId = randomUUID();
        // §34: inventory through the NORMAL order path — reserve now, consume on dispatch.
        const updated = await client.query(
          `UPDATE stock_balances SET reserved = reserved + $3, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'retail'
             AND on_hand - reserved - damaged >= $3`,
          [item.variantId, body.warehouseId, item.quantity]);
        if (!updated.rowCount) throw conflict(`موجودی قابل فروش ${variant.sku} در انبار «${warehouse.name}» کافی نیست.`);

        await client.query(
          `INSERT INTO order_lines(id, order_id, product_id, variant_id, supplier_id, product_name, sku, quantity,
             base_unit_price_rial, unit_price_rial, discount_amount_rial, line_total_rial,
             applied_promotion_rule_id, pricing_snapshot, qc_status, received_at_kolbe, inventory_domain)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'accepted',now(),'retail')`,
          [lineId, orderId, variant.product_id, variant.id, variant.supplier_id, variant.product_name, variant.sku,
            item.quantity, basePrice.toString(), finalUnit.toString(), (unitDiscount * BigInt(item.quantity)).toString(),
            lineTotal.toString(), resolved.matchedRule?.id ?? null,
            JSON.stringify({ source: 'manual_order', channel: body.channel, resolved }),
          ]);
        await client.query(
          `INSERT INTO stock_reservations(id, order_line_id, variant_id, warehouse_id, inventory_domain, quantity, status)
           VALUES ($1,$2,$3,$4,'retail',$5,'active')`,
          [randomUUID(), lineId, variant.id, body.warehouseId, item.quantity]);
        await client.query(
          `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, reserved_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
           VALUES ($1,$2,$3,'retail',$4,'order reservation','order',$5,$6,$7)`,
          [randomUUID(), variant.id, body.warehouseId, item.quantity, orderId, user.id, `reserve:${lineId}`]);
        lineRows.push({ id: lineId, variantId: variant.id, sku: variant.sku, quantity: item.quantity });
      }

      const total = subtotal - discountTotal;
      await client.query(
        'UPDATE orders SET subtotal_rial = $2, discount_rial = $3, total_rial = $4, updated_at = now() WHERE id = $1',
        [orderId, subtotal.toString(), discountTotal.toString(), total.toString()]);
      await client.query(
        `INSERT INTO order_events(id, order_id, to_status, actor_id, note) VALUES ($1,$2,'pending_payment',$3,$4)`,
        [randomUUID(), orderId, user.id, `ثبت سفارش دستی (${body.channel})${body.note ? ` — ${body.note}` : ''}`]);

      // §34: lifecycle through the SAME transition core — payment gate, reservation
      // consumption and audit identical to website orders; consumption happens exactly once.
      const methodLabel: Record<string, string> = { cash: 'نقدی', card_to_card: 'کارت‌به‌کارت', gateway: 'درگاه', cod: 'پرداخت در محل' };
      if (body.payment.status === 'paid') {
        const payNote = `پرداخت ${methodLabel[body.payment.method]}${body.payment.reference ? ` — پیگیری: ${body.payment.reference}` : ''}`;
        await applyOrderTransitionCore(client as unknown as PoolClient, user, orderId, 'paid', payNote, request.ip);
        if (body.deliverNow) {
          await applyOrderTransitionCore(client as unknown as PoolClient, user, orderId, 'processing', 'آماده‌سازی فروش حضوری', request.ip);
          await applyOrderTransitionCore(client as unknown as PoolClient, user, orderId, 'shipped', 'تحویل حضوری به مشتری', request.ip);
          await applyOrderTransitionCore(client as unknown as PoolClient, user, orderId, 'delivered', 'تحویل حضوری تکمیل شد', request.ip);
        }
      }

      await audit(client, user.id, 'manual_order.created', 'order', orderId, undefined,
        { reference, channel: body.channel, totalRial: total.toString(), paymentMethod: body.payment.method,
          paymentStatus: body.payment.status, deliverNow: body.deliverNow, customerCreated, lines: lineRows.length }, request.ip);

      const result = {
        id: orderId, reference, salesChannel: body.channel,
        status: body.deliverNow ? 'delivered' : body.payment.status === 'paid' ? 'paid' : 'pending_payment',
        buyerId, customerCreated,
        subtotalRial: subtotal.toString(), discountRial: discountTotal.toString(), totalRial: total.toString(),
      };
      await completeIdempotency(client, user.id, 'manual_order.create', key, result);
      return { reused: false, body: result };
    });
    return reply.code(response.reused ? 200 : 201).send(response.body);
  });

  app.post('/api/v1/orders/bulk-transitions', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'orders:transition');
    const body = z.object({
      orderIds: z.array(z.uuid()).min(1).max(200)
        .refine((ids) => new Set(ids).size === ids.length, 'هر سفارش فقط یک بار مجاز است.'),
      status: orderStatus,
      note: z.string().trim().max(1000).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const results: { orderId: string; reference?: string; ok: boolean; error?: string }[] = [];
      for (const [index, orderId] of body.orderIds.entries()) {
        await client.query(`SAVEPOINT bulk_ord_${index}`);
        try {
          const applied = await applyOrderTransitionCore(client, user, orderId, body.status, body.note ?? null, request.ip);
          await client.query(`RELEASE SAVEPOINT bulk_ord_${index}`);
          results.push({ orderId, reference: applied.reference, ok: true });
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT bulk_ord_${index}`);
          results.push({ orderId, ok: false, error: error instanceof ApiError ? error.message : 'تغییر وضعیت این سفارش ناموفق بود.' });
        }
      }
      const succeeded = results.filter((item) => item.ok).length;
      await audit(client, user.id, 'orders.bulk_status_changed', 'order', body.orderIds[0]!, undefined,
        { status: body.status, requested: body.orderIds.length, succeeded, failed: results.length - succeeded,
          failures: results.filter((item) => !item.ok).map((item) => ({ orderId: item.orderId, error: item.error })) },
        request.ip);
      return { results, succeeded, failed: results.length - succeeded };
    });
  });

  // ============================================================================
  // REQUIREMENT 1: Wholesale Inbound-to-Kolbe, QC Inspection & Consolidation
  // ============================================================================

  // 1. List Supplier Fulfillments (for Supplier or Admin/Operations)
  app.get('/api/v1/wholesale/fulfillments', async (request) => {
    const user = await principal(request, pool, config);
    const isOps = user.permissions.includes('orders:read') || user.permissions.includes('wholesale:ops');
    const isSupplier = user.roles.includes('supplier');
    if (!isOps && !isSupplier) throw forbidden();
    if (isSupplier) await requireApprovedSupplier(pool, user);

    const rows = await pool.query(
      `SELECT sf.id, sf.reference, sf.order_id, o.reference AS order_reference, o.status AS order_status,
              o.wholesale_fulfillment_status, sf.supplier_id, sp.brand_name,
              sf.destination_warehouse_id, w.name AS destination_warehouse_name,
              sf.status, sf.notes, sf.dispatched_at, sf.arrived_at, sf.accepted_at, sf.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'orderLineId', l.id,
                'variantId', l.variant_id,
                'sku', l.sku,
                'productName', l.product_name,
                'quantity', l.quantity,
                'qcStatus', l.qc_status,
                'receivedAtKolbe', l.received_at_kolbe
              )) FILTER (WHERE l.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM supplier_fulfillments sf
       JOIN orders o ON o.id = sf.order_id
       JOIN warehouses w ON w.id = sf.destination_warehouse_id
       LEFT JOIN supplier_profiles sp ON sp.user_id = sf.supplier_id
       LEFT JOIN order_lines l ON l.supplier_fulfillment_id = sf.id
       WHERE ($1::boolean = true OR sf.supplier_id = $2)
       GROUP BY sf.id, o.reference, o.status, o.wholesale_fulfillment_status, sp.brand_name, w.name
       ORDER BY sf.created_at DESC LIMIT 100`,
      [isOps, user.id],
    );
    return { items: rows.rows };
  });

  // 2. Supplier transitions fulfillment from awaiting_supplier -> supplier_preparing
  app.post('/api/v1/wholesale/fulfillments/:id/prepare', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = prepareFulfillmentBody.parse(request.body ?? {});

    return transaction(pool, async (client) => {
      if (user.roles.includes('supplier')) await requireApprovedSupplier(client, user);
      const f = await one<{
        id: string;
        reference: string;
        order_id: string;
        supplier_id: string;
        status: string;
      }>(client, 'SELECT * FROM supplier_fulfillments WHERE id = $1 FOR UPDATE', [id]);
      if (!f) throw notFound();
      const isOps = user.permissions.includes('orders:transition') || user.permissions.includes('wholesale:ops');
      if (!isOps && f.supplier_id !== user.id) throw forbidden();
      if (f.status !== 'awaiting_supplier' && f.status !== 'supplier_preparing') {
        throw conflict(`تغییر وضعیت تأمین از ${f.status} به supplier_preparing مجاز نیست.`);
      }

      await client.query(
        "UPDATE supplier_fulfillments SET status = 'supplier_preparing', notes = COALESCE($2, notes), updated_at = now() WHERE id = $1",
        [id, body.note ?? null],
      );
      await client.query(
        "UPDATE orders SET wholesale_fulfillment_status = 'supplier_preparing', updated_at = now() WHERE id = $1 AND wholesale_fulfillment_status = 'awaiting_supplier'",
        [f.order_id],
      );
      const res = { id: f.id, reference: f.reference, status: 'supplier_preparing' };
      await audit(client, user.id, 'supplier_fulfillment.preparing', 'supplier_fulfillment', id, { status: f.status }, res, request.ip);
      return res;
    });
  });

  // 3. Supplier creates & dispatches Inbound Shipment TO KOLBE CENTRAL WAREHOUSE ONLY
  app.post('/api/v1/wholesale/inbound-shipments', async (request, reply) => {
    const user = await principal(request, pool, config);
    const rawBody = (request.body ?? {}) as Record<string, unknown>;

    // ==========================================================================
    // REQUIREMENT 1: Strictly Prohibit Direct Supplier -> VIP Shipping
    // ==========================================================================
    if (
      rawBody.destinationType === 'vip' ||
      rawBody.destinationType === 'customer' ||
      rawBody.destinationType === 'buyer' ||
      rawBody.directToVip === true ||
      rawBody.customerAddress !== undefined ||
      rawBody.recipientCustomerId !== undefined
    ) {
      throw forbidden();
    }

    const body = createInboundShipmentBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    const shipment = await transaction(pool, async (client) => {
      if (user.roles.includes('supplier')) await requireApprovedSupplier(client, user);
      const claim = await claimIdempotency(client, user.id, 'inbound_shipment.create', key, requestHash(body));
      if (claim.previous) return claim.previous;

      const fulfillment = await one<{
        id: string;
        reference: string;
        order_id: string;
        supplier_id: string;
        destination_warehouse_id: string;
        status: string;
      }>(
        client,
        'SELECT * FROM supplier_fulfillments WHERE id = $1 FOR UPDATE',
        [body.fulfillmentId],
      );
      if (!fulfillment) throw notFound();

      const isOps = user.permissions.includes('orders:transition') || user.permissions.includes('wholesale:ops');
      if (!isOps && fulfillment.supplier_id !== user.id) throw forbidden();

      const destWarehouseId = body.destinationWarehouseId ?? fulfillment.destination_warehouse_id;
      const destWarehouse = await one<{ id: string; owner_id: string | null; active: boolean }>(
        client,
        'SELECT id, owner_id, active FROM warehouses WHERE id = $1',
        [destWarehouseId],
      );
      if (!destWarehouse || !destWarehouse.active) throw notFound();
      // Destination MUST be a Kolbe Central Warehouse (owner_id IS NULL)
      if (destWarehouse.owner_id !== null) {
        throw forbidden();
      }

      const orderLines = await client.query<{
        id: string;
        variant_id: string;
        sku: string;
        quantity: number;
      }>(
        'SELECT id, variant_id, sku, quantity FROM order_lines WHERE supplier_fulfillment_id = $1 FOR UPDATE',
        [fulfillment.id],
      );
      if (orderLines.rows.length === 0) {
        throw conflict('هیچ ردیف کالایی برای این درخواست تأمین یافت نشد.');
      }

      // ==========================================================================
      // PROMPT 6 — single inbound authority.
      // A master/OMS child (this table is the CHILD order, §18 of migration 064) owns its inbound
      // leg through `oms_inbound_shipments` + `order_source_allocations`. The legacy path below is
      // kept ONLY for legacy non-OMS wholesale orders: running both would post `incoming` twice for
      // the same physical goods (the legacy route credits piece-level `stock_balances.incoming`, the
      // OMS route credits ordered series). Whichever route reaches the goods first wins; the second
      // gets a deterministic conflict instead of a duplicate receipt.
      // ==========================================================================
      const omsChild = await one<{ master_order_id: string | null; seller_type: string | null }>(
        client, 'SELECT master_order_id, seller_type FROM orders WHERE id = $1', [fulfillment.order_id]);
      if (omsChild?.master_order_id) {
        throw conflict(
          'این سفارش زیرمجموعه یک سفارش مادر (OMS) است؛ محموله ورودی آن فقط از مسیر محموله‌های ورودی OMS ثبت می‌شود.',
        );
      }
      const omsExternalLeg = await one<{ id: string }>(
        client,
        `SELECT a.id FROM order_source_allocations a
         WHERE a.child_order_id = $1 AND a.source_type = 'supplier_external'
           AND a.status NOT IN ('released','cancelled','expired') LIMIT 1`,
        [fulfillment.order_id]);
      if (omsExternalLeg) {
        throw conflict(
          'این درخواست تأمین در OMS ثبت شده است؛ دریافت فیزیکی آن از مسیر OMS انجام می‌شود و مسیر قدیمی مجاز نیست.',
        );
      }

      const shipmentId = randomUUID();
      const sSeq = await one<{ num: string }>(client, "SELECT nextval('inbound_shipment_seq')::text AS num");
      const shipmentNumber = `INB-${sSeq!.num}`;

      await client.query(
        `INSERT INTO inbound_shipments(
          id, shipment_number, supplier_fulfillment_id, order_id, supplier_id,
          destination_warehouse_id, status, carrier, tracking_code, dispatched_at
        ) VALUES ($1,$2,$3,$4,$5,$6,'supplier_dispatched',$7,$8,now())`,
        [
          shipmentId,
          shipmentNumber,
          fulfillment.id,
          fulfillment.order_id,
          fulfillment.supplier_id,
          destWarehouseId,
          body.carrier,
          body.trackingCode,
        ],
      );

      const createdLines = [];
      for (const ol of orderLines.rows) {
        const requestedLine = body.lines?.find((l) => l.orderLineId === ol.id);
        const expectedQty = requestedLine ? (requestedLine.quantity ?? requestedLine.dispatchedQuantity ?? ol.quantity) : ol.quantity;
        const lineId = randomUUID();

        await client.query(
          `INSERT INTO inbound_shipment_lines(
            id, inbound_shipment_id, order_line_id, variant_id, expected_quantity
          ) VALUES ($1,$2,$3,$4,$5)`,
          [lineId, shipmentId, ol.id, ol.variant_id, expectedQty],
        );

        // Record incoming wholesale stock at Kolbe Central Warehouse
        await client.query(
          `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain, incoming)
           VALUES ($1, $2, 'wholesale', $3)
           ON CONFLICT (variant_id, warehouse_id, inventory_domain)
           DO UPDATE SET incoming = stock_balances.incoming + $3, version = stock_balances.version + 1, updated_at = now()`,
          [ol.variant_id, destWarehouseId, expectedQty],
        );

        await client.query(
          `INSERT INTO stock_movements(
            id, variant_id, warehouse_id, inventory_domain, incoming_delta,
            reason, reference_type, reference_id, actor_id, idempotency_key
          ) VALUES ($1,$2,$3,'wholesale',$4,$5,'inbound_shipment',$6,$7,$8)`,
          [
            randomUUID(),
            ol.variant_id,
            destWarehouseId,
            expectedQty,
            `ارسال محموله تأمین‌کننده ${shipmentNumber} به انبار کلبه`,
            shipmentId,
            user.id,
            `inbound-dispatch:${lineId}`,
          ],
        );

        createdLines.push({
          id: lineId,
          orderLineId: ol.id,
          variantId: ol.variant_id,
          sku: ol.sku,
          expectedQuantity: expectedQty,
        });
      }

      await client.query(
        "UPDATE supplier_fulfillments SET status = 'supplier_dispatched', dispatched_at = now(), updated_at = now() WHERE id = $1",
        [fulfillment.id],
      );
      await client.query(
        "UPDATE orders SET wholesale_fulfillment_status = 'supplier_dispatched', updated_at = now() WHERE id = $1 AND wholesale_fulfillment_status IN ('awaiting_supplier', 'supplier_preparing')",
        [fulfillment.order_id],
      );

      const response = {
        id: shipmentId,
        shipmentNumber,
        fulfillmentId: fulfillment.id,
        orderId: fulfillment.order_id,
        destinationWarehouseId: destWarehouseId,
        destinationType: 'kolbe_warehouse',
        status: 'supplier_dispatched',
        carrier: body.carrier,
        trackingCode: body.trackingCode,
        lines: createdLines,
      };
      await audit(client, user.id, 'inbound_shipment.dispatched', 'inbound_shipment', shipmentId, undefined, response, request.ip);
      await outbox(client, 'inbound_shipment.dispatched', 'inbound_shipment', shipmentId, response);
      await completeIdempotency(client, user.id, 'inbound_shipment.create', key, response);
      return response;
    });

    return reply.code(201).send(shipment);
  });

  // 4. List Inbound Shipments
  app.get('/api/v1/wholesale/inbound-shipments', async (request) => {
    const user = await principal(request, pool, config);
    const isOps = user.permissions.includes('orders:read') || user.permissions.includes('wholesale:ops');
    const isSupplier = user.roles.includes('supplier');
    if (!isOps && !isSupplier) throw forbidden();
    if (isSupplier) await requireApprovedSupplier(pool, user);

    const rows = await pool.query(
      `SELECT s.*, o.reference AS order_reference, sp.brand_name, w.name AS destination_warehouse_name,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', sl.id,
                'orderLineId', sl.order_line_id,
                'variantId', sl.variant_id,
                'sku', ol.sku,
                'productName', ol.product_name,
                'expectedQuantity', sl.expected_quantity,
                'receivedQuantity', sl.received_quantity,
                'acceptedQuantity', sl.accepted_quantity,
                'rejectedQuantity', sl.rejected_quantity,
                'damagedQuantity', sl.damaged_quantity,
                'missingQuantity', sl.missing_quantity,
                'inspectionNote', sl.inspection_note
              )) FILTER (WHERE sl.id IS NOT NULL), '[]'::jsonb) AS lines
       FROM inbound_shipments s
       JOIN orders o ON o.id = s.order_id
       JOIN warehouses w ON w.id = s.destination_warehouse_id
       LEFT JOIN supplier_profiles sp ON sp.user_id = s.supplier_id
       LEFT JOIN inbound_shipment_lines sl ON sl.inbound_shipment_id = s.id
       LEFT JOIN order_lines ol ON ol.id = sl.order_line_id
       WHERE ($1::boolean = true OR s.supplier_id = $2)
       GROUP BY s.id, o.reference, sp.brand_name, w.name
       ORDER BY s.created_at DESC LIMIT 100`,
      [isOps, user.id],
    );
    return { items: rows.rows };
  });

  // 5. Kolbe Warehouse records arrival / receiving start (arrived_at_kolbe -> receiving -> under_inspection)
  app.post('/api/v1/wholesale/inbound-shipments/:id/receive', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'orders:transition');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      stage: z.enum(['arrived_at_kolbe', 'receiving', 'under_inspection']).default('arrived_at_kolbe'),
    }).parse(request.body ?? {});

    return transaction(pool, async (client) => {
      const shipment = await one<{
        id: string;
        shipment_number: string;
        supplier_fulfillment_id: string;
        order_id: string;
        status: string;
      }>(client, 'SELECT * FROM inbound_shipments WHERE id = $1 FOR UPDATE', [id]);
      if (!shipment) throw notFound();
      // Prompt 6: an OMS child never owns a legacy inbound shipment; refuse rather than diverge.
      const orderScope = await one<{ master_order_id: string | null }>(
        client, 'SELECT master_order_id FROM orders WHERE id = $1', [shipment.order_id]);
      if (orderScope?.master_order_id) {
        throw conflict('این محموله متعلق به یک سفارش مادر OMS است؛ مسیر دریافت آن مسیر محموله‌های ورودی OMS است.');
      }

      await client.query(
        'UPDATE inbound_shipments SET status = $2, arrived_at = COALESCE(arrived_at, now()), updated_at = now() WHERE id = $1',
        [id, body.stage],
      );
      await client.query(
        'UPDATE supplier_fulfillments SET status = $2, arrived_at = COALESCE(arrived_at, now()), updated_at = now() WHERE id = $1',
        [shipment.supplier_fulfillment_id, body.stage],
      );
      await client.query(
        'UPDATE orders SET wholesale_fulfillment_status = $2, updated_at = now() WHERE id = $1',
        [shipment.order_id, body.stage],
      );

      const res = { id, shipmentNumber: shipment.shipment_number, status: body.stage };
      await audit(client, user.id, 'inbound_shipment.received_stage', 'inbound_shipment', id, { status: shipment.status }, res, request.ip);
      return res;
    });
  });

  // 6. Kolbe QC Inspection & Official Warehouse Receipt (GRN)
  app.post('/api/v1/wholesale/inbound-shipments/:id/inspect', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'orders:transition');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = inspectInboundShipmentBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    const result = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'inbound_shipment.inspect', key, requestHash({ id, ...body }));
      if (claim.previous) return claim.previous;

      const shipment = await one<{
        id: string;
        shipment_number: string;
        supplier_fulfillment_id: string;
        order_id: string;
        destination_warehouse_id: string;
        status: string;
      }>(client, 'SELECT * FROM inbound_shipments WHERE id = $1 FOR UPDATE', [id]);
      if (!shipment) throw notFound();
      if (['accepted', 'partially_accepted', 'rejected'].includes(shipment.status)) {
        throw conflict(`کنترل کیفیت این محموله قبلاً ثبت شده است (وضعیت: ${shipment.status}).`);
      }

      const dbLines = await client.query<{
        id: string;
        order_line_id: string;
        variant_id: string;
        expected_quantity: number;
      }>('SELECT id, order_line_id, variant_id, expected_quantity FROM inbound_shipment_lines WHERE inbound_shipment_id = $1 FOR UPDATE', [id]);
      if (dbLines.rows.length === 0) throw notFound();

      let totalExpected = 0;
      let totalAccepted = 0;
      let totalRejected = 0;
      let totalDamaged = 0;
      let totalMissing = 0;

      const inspectedLines = [];

      for (const dbLine of dbLines.rows) {
        const input = body.lines.find(
          (l) => (l.shipmentLineId && l.shipmentLineId === dbLine.id) || (l.orderLineId && l.orderLineId === dbLine.order_line_id),
        );
        if (!input) {
          throw badRequest(`اطلاعات بازرسی برای ردیف محموله ${dbLine.id} ارسال نشده است.`);
        }
        if (input.acceptedQuantity + input.rejectedQuantity + input.damagedQuantity !== input.receivedQuantity) {
          throw badRequest(
            'مجموع تعداد تایید شده، رد شده و آسیب‌دیده باید دقیقاً برابر با تعداد دریافتی (receivedQuantity) باشد.',
          );
        }
        if (input.receivedQuantity + input.missingQuantity !== dbLine.expected_quantity) {
          throw badRequest(
            `مجموع تعداد دریافتی (${input.receivedQuantity}) و کسری (${input.missingQuantity}) باید برابر با تعداد مورد انتظار (${dbLine.expected_quantity}) باشد.`,
          );
        }

        totalExpected += dbLine.expected_quantity;
        totalAccepted += input.acceptedQuantity;
        totalRejected += input.rejectedQuantity;
        totalDamaged += input.damagedQuantity;
        totalMissing += input.missingQuantity;

        await client.query(
          `UPDATE inbound_shipment_lines
           SET received_quantity = $2,
               accepted_quantity = $3,
               rejected_quantity = $4,
               damaged_quantity = $5,
               missing_quantity = $6,
               inspection_note = $7,
               inspected_by = $8,
               inspected_at = now()
           WHERE id = $1`,
          [
            dbLine.id,
            input.receivedQuantity,
            input.acceptedQuantity,
            input.rejectedQuantity,
            input.damagedQuantity,
            input.missingQuantity,
            input.inspectionNote ?? null,
            user.id,
          ],
        );

        const orderLine = await one<{ id: string; quantity: number }>(
          client,
          'SELECT id, quantity FROM order_lines WHERE id = $1 FOR UPDATE',
          [dbLine.order_line_id],
        );
        if (!orderLine) throw notFound();

        const lineQcStatus =
          input.acceptedQuantity === dbLine.expected_quantity
            ? 'accepted'
            : input.acceptedQuantity > 0
              ? 'partially_accepted'
              : 'rejected';

        await client.query(
          `UPDATE order_lines
           SET qc_status = $2,
               received_at_kolbe = CASE WHEN $3 > 0 THEN now() ELSE received_at_kolbe END
           WHERE id = $1`,
          [orderLine.id, lineQcStatus, input.receivedQuantity],
        );

        // Update supplier warehouse wholesale balance: consume dispatched reservation
        const reservation = await one<{ id: string; warehouse_id: string; quantity: number; status: string }>(
          client,
          "SELECT id, warehouse_id, quantity, status FROM stock_reservations WHERE order_line_id = $1 AND status = 'active' FOR UPDATE",
          [orderLine.id],
        );
        if (reservation) {
          const consumeQty = Math.min(reservation.quantity, dbLine.expected_quantity);
          await client.query(
            `UPDATE stock_balances
             SET on_hand = GREATEST(0, on_hand - $3),
                 reserved = GREATEST(0, reserved - $3),
                 version = version + 1,
                 updated_at = now()
             WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'`,
            [dbLine.variant_id, reservation.warehouse_id, consumeQty],
          );
          await client.query(
            "UPDATE stock_reservations SET status = 'consumed', updated_at = now() WHERE id = $1",
            [reservation.id],
          );
          await client.query(
            `INSERT INTO stock_movements(
              id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reserved_delta,
              reason, reference_type, reference_id, actor_id, idempotency_key
            ) VALUES ($1,$2,$3,'wholesale',$4,$5,$6,'inbound_shipment',$7,$8,$9)`,
            [
              randomUUID(),
              dbLine.variant_id,
              reservation.warehouse_id,
              -consumeQty,
              -consumeQty,
              `خروج از انبار تأمین‌کننده و تحویل به انبار کلبه طی محموله ${shipment.shipment_number}`,
              shipment.id,
              user.id,
              `inbound-supplier-consume:${dbLine.id}`,
            ],
          );
        }

        // Update Kolbe Central Warehouse wholesale balance: reduce incoming, add accepted + damaged
        const kolbeReceivedOnHand = input.acceptedQuantity + input.damagedQuantity;
        await client.query(
          `UPDATE stock_balances
           SET incoming = GREATEST(0, incoming - $3),
               on_hand = on_hand + $4,
               reserved = reserved + $5,
               damaged = damaged + $6,
               version = version + 1,
               updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'`,
          [
            dbLine.variant_id,
            shipment.destination_warehouse_id,
            dbLine.expected_quantity,
            kolbeReceivedOnHand,
            input.acceptedQuantity,
            input.damagedQuantity,
          ],
        );

        await client.query(
          `INSERT INTO stock_movements(
            id, variant_id, warehouse_id, inventory_domain,
            on_hand_delta, reserved_delta, incoming_delta, damaged_delta,
            reason, reference_type, reference_id, actor_id, idempotency_key
          ) VALUES ($1,$2,$3,'wholesale',$4,$5,$6,$7,$8,'warehouse_receipt',$9,$10,$11)`,
          [
            randomUUID(),
            dbLine.variant_id,
            shipment.destination_warehouse_id,
            kolbeReceivedOnHand,
            input.acceptedQuantity,
            -dbLine.expected_quantity,
            input.damagedQuantity,
            `دریافت و کنترل کیفیت محموله ${shipment.shipment_number} در انبار کلبه`,
            shipment.id,
            user.id,
            `inbound-kolbe-qc:${dbLine.id}`,
          ],
        );

        inspectedLines.push({
          shipmentLineId: dbLine.id,
          orderLineId: dbLine.order_line_id,
          variantId: dbLine.variant_id,
          expectedQuantity: dbLine.expected_quantity,
          receivedQuantity: input.receivedQuantity,
          acceptedQuantity: input.acceptedQuantity,
          rejectedQuantity: input.rejectedQuantity,
          damagedQuantity: input.damagedQuantity,
          missingQuantity: input.missingQuantity,
          qcStatus: lineQcStatus,
        });
      }

      const overallStatus: 'accepted' | 'partially_accepted' | 'rejected' =
        totalAccepted === totalExpected
          ? 'accepted'
          : totalAccepted > 0
            ? 'partially_accepted'
            : 'rejected';

      const receiptId = randomUUID();
      const rSeq = await one<{ num: string }>(client, "SELECT nextval('warehouse_receipt_seq')::text AS num");
      const receiptNumber = `GRN-${rSeq!.num}`;

      await client.query(
        `INSERT INTO warehouse_receipts(
          id, receipt_number, inbound_shipment_id, warehouse_id, received_by, qc_status, notes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          receiptId,
          receiptNumber,
          shipment.id,
          shipment.destination_warehouse_id,
          user.id,
          overallStatus,
          body.inspectorNote ?? null,
        ],
      );

      await client.query(
        `UPDATE inbound_shipments
         SET status = $2, arrived_at = COALESCE(arrived_at, now()), inspected_at = now(), updated_at = now()
         WHERE id = $1`,
        [shipment.id, overallStatus],
      );

      await client.query(
        `UPDATE supplier_fulfillments
         SET status = $2,
             arrived_at = COALESCE(arrived_at, now()),
             accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
             updated_at = now()
         WHERE id = $1`,
        [shipment.supplier_fulfillment_id, overallStatus],
      );

      // §22-§24/§48: supplier supply of series-based products is accounted in SERIES units.
      // Only FULLY passed series (bottleneck over accepted components, per the order-time recipe
      // snapshot) enter sellable series stock at the destination wholesale warehouse — rejected or
      // damaged pieces can never produce an intact series. Mirrors the piece-level handoff above:
      // consume the supplier-side series reservation, credit Kolbe-side on_hand+reserved.
      const orderSeriesRow = await one<{ series_snapshot: unknown }>(
        client, 'SELECT series_snapshot FROM orders WHERE id = $1', [shipment.order_id]);
      const snapshotSeries = ((orderSeriesRow?.series_snapshot as { series?: Array<{
        seriesTemplateId: string; name: string; count: number;
        components: Array<{ variantId: string; sku: string; quantityPerSeries: number }>;
      }> } | null)?.series) ?? [];
      if (snapshotSeries.length > 0) {
        const fulfillment = await one<{ supplier_id: string }>(
          client, 'SELECT supplier_id FROM supplier_fulfillments WHERE id = $1', [shipment.supplier_fulfillment_id]);
        for (const entry of snapshotSeries) {
          if (!entry.components.length) continue;
          let passedSeries = Number.POSITIVE_INFINITY;
          let touchesThisShipment = false;
          for (const comp of entry.components) {
            const line = inspectedLines.find((l) => l.variantId === comp.variantId);
            if (line) touchesThisShipment = true;
            passedSeries = Math.min(passedSeries, Math.floor((line?.acceptedQuantity ?? 0) / comp.quantityPerSeries));
          }
          if (!touchesThisShipment) continue;
          passedSeries = Math.min(Number.isFinite(passedSeries) ? passedSeries : 0, entry.count);

          // Goods physically left the supplier warehouse: consume any series reservation held there.
          const priorReservations = await client.query<{
            id: string; warehouse_id: string; owner_type: 'kolbe' | 'supplier'; supplier_id: string | null; series_count: number;
          }>(
            `SELECT id, warehouse_id, owner_type, supplier_id, series_count FROM order_series_reservations
             WHERE order_id = $1 AND series_template_id = $2 AND status = 'active' AND warehouse_id <> $3 FOR UPDATE`,
            [shipment.order_id, entry.seriesTemplateId, shipment.destination_warehouse_id]);
          for (const prior of priorReservations.rows) {
            await applySeriesMovement(client, {
              templateId: entry.seriesTemplateId, warehouseId: prior.warehouse_id,
              owner: { ownerType: prior.owner_type, supplierId: prior.supplier_id },
              movementType: 'consume', onHandDelta: -prior.series_count, reservedDelta: -prior.series_count,
              referenceType: 'inbound_shipment', referenceId: shipment.id, actorId: user.id,
              note: `خروج سری از انبار تأمین‌کننده طی محموله ${shipment.shipment_number}`,
              idempotencyKey: `series-inbound-consume:${shipment.id}:${prior.id}`,
            });
            await client.query(
              "UPDATE order_series_reservations SET status = 'consumed', updated_at = now() WHERE id = $1", [prior.id]);
          }

          if (passedSeries <= 0) continue;
          await applySeriesMovement(client, {
            templateId: entry.seriesTemplateId, warehouseId: shipment.destination_warehouse_id,
            owner: { ownerType: 'supplier', supplierId: fulfillment?.supplier_id ?? null },
            movementType: 'receipt', onHandDelta: passedSeries, reservedDelta: passedSeries,
            referenceType: 'inbound_shipment', referenceId: shipment.id, actorId: user.id,
            note: `دریافت ${passedSeries} سری کامل تأییدشده در QC از محموله ${shipment.shipment_number}`,
            idempotencyKey: `series-qc:${shipment.id}:${entry.seriesTemplateId}`,
          });
          await client.query(
            `INSERT INTO order_series_reservations(id, order_id, series_template_id, warehouse_id, owner_type, supplier_id, series_count, recipe_snapshot)
             VALUES ($1,$2,$3,$4,'supplier',$5,$6,$7)`,
            [randomUUID(), shipment.order_id, entry.seriesTemplateId, shipment.destination_warehouse_id,
              fulfillment?.supplier_id ?? null, passedSeries, JSON.stringify(entry)]);
        }
      }

      // Check all supplier lines of the order to determine next order wholesale_fulfillment_status
      const allOrderSupplierLines = await client.query<{ qc_status: string; received_at_kolbe: Date | null }>(
        `SELECT l.qc_status, l.received_at_kolbe
         FROM order_lines l
         JOIN product_variants v ON v.id = l.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE l.order_id = $1 AND (l.supplier_id IS NOT NULL OR p.owner_type = 'supplier')`,
        [shipment.order_id],
      );

      const allAccepted = allOrderSupplierLines.rows.every((r) => r.qc_status === 'accepted' && r.received_at_kolbe !== null);
      const anyRejected = allOrderSupplierLines.rows.every((r) => r.qc_status === 'rejected');
      const nextOrderFulfillmentStatus = allAccepted
        ? 'awaiting_consolidation'
        : anyRejected
          ? 'rejected'
          : 'partially_accepted';

      await client.query(
        'UPDATE orders SET wholesale_fulfillment_status = $2, updated_at = now() WHERE id = $1',
        [shipment.order_id, nextOrderFulfillmentStatus],
      );

      const response = {
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipment_number,
        receiptId,
        receiptNumber,
        status: overallStatus,
        orderWholesaleFulfillmentStatus: nextOrderFulfillmentStatus,
        summary: {
          expected: totalExpected,
          accepted: totalAccepted,
          rejected: totalRejected,
          damaged: totalDamaged,
          missing: totalMissing,
        },
        lines: inspectedLines,
      };

      await audit(client, user.id, 'inbound_shipment.inspected', 'inbound_shipment', shipment.id, { status: shipment.status }, response, request.ip);
      await outbox(client, 'inbound_shipment.inspected', 'inbound_shipment', shipment.id, response);
      await completeIdempotency(client, user.id, 'inbound_shipment.inspect', key, response);
      return response;
    });

    return reply.code(201).send(result);
  });

  // 7. Order Consolidation at Kolbe Warehouse -> ready_for_vip
  app.post('/api/v1/wholesale/orders/:id/consolidate', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'orders:transition');
    const { id: orderId } = z.object({ id: z.uuid() }).parse(request.params);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    return transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale.consolidate', key, requestHash({ orderId }));
      if (claim.previous) return claim.previous;

      const order = await one<{
        id: string;
        reference: string;
        order_type: 'retail' | 'wholesale';
        wholesale_fulfillment_status: string | null;
      }>(client, 'SELECT id, reference, order_type, wholesale_fulfillment_status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (!order) throw notFound();
      if (order.order_type !== 'wholesale') throw badRequest('تجمیع انبار فقط برای سفارش‌های عمده کاربرد دارد.');

      const supplierLines = await client.query<{
        id: string;
        sku: string;
        received_at_kolbe: Date | null;
        qc_status: string;
      }>(
        `SELECT l.id, l.sku, l.received_at_kolbe, l.qc_status
         FROM order_lines l
         JOIN product_variants v ON v.id = l.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE l.order_id = $1 AND (l.supplier_id IS NOT NULL OR p.owner_type = 'supplier')`,
        [orderId],
      );

      for (const line of supplierLines.rows) {
        if (!line.received_at_kolbe || line.qc_status !== 'accepted') {
          throw conflict(`کالای ${line.sku} هنوز در انبار کلبه دریافت و تایید کیفی (QC) نشده است؛ امکان تجمیع و آماده‌سازی برای ارسال به VIP وجود ندارد.`);
        }
      }

      await client.query(
        `UPDATE orders
         SET wholesale_fulfillment_status = 'ready_for_vip', consolidated_at = now(), updated_at = now()
         WHERE id = $1`,
        [orderId],
      );
      await client.query(
        `UPDATE supplier_fulfillments
         SET status = 'ready_for_vip', updated_at = now()
         WHERE order_id = $1 AND status = 'accepted'`,
        [orderId],
      );

      const response = {
        orderId,
        reference: order.reference,
        wholesaleFulfillmentStatus: 'ready_for_vip',
        consolidatedAt: new Date().toISOString(),
      };
      await audit(client, user.id, 'wholesale_order.consolidated', 'order', orderId, { wholesaleFulfillmentStatus: order.wholesale_fulfillment_status }, response, request.ip);
      await completeIdempotency(client, user.id, 'wholesale.consolidate', key, response);
      return response;
    });
  });

  // 8. Dispatch Consolidated Order from Kolbe Warehouse to VIP Buyer
  //
  // PROMPT 6 — single final-shipment authority. A master-flow child (orders.master_order_id IS NOT NULL)
  // is dispatched ONLY through POST /api/v1/wholesale/masters/:id/ship, which re-derives the whole
  // gate (composition locked, all children paid, consolidation verified+packed, no blocking exception)
  // and refuses to deduct stock a second time. This legacy endpoint therefore refuses master-flow
  // children outright: it both deducted piece stock again AND set a per-child 'shipped' status that
  // contradicts the single customer-facing Master Order shipment (Prompt 6 §21, Golden Scenario 5).
  app.post('/api/v1/wholesale/orders/:id/dispatch-vip', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'orders:transition');
    const { id: orderId } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      trackingCode: z.string().trim().min(3).max(120).optional(),
      reason: z.string().trim().min(3).max(500).default('ارسال بسته تجمیع‌شده از انبار کلبه به مشتری VIP'),
    }).parse(request.body ?? {});
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    return transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'wholesale.dispatch_vip', key, requestHash({ orderId, ...body }));
      if (claim.previous) return claim.previous;

      const masterScope = await one<{ master_order_id: string | null }>(
        client, 'SELECT master_order_id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (!masterScope) throw notFound();
      if (masterScope.master_order_id) {
        throw conflict(
          'این زیرسفارش بخشی از یک سفارش مادر است؛ ارسال نهایی فقط از مسیر ارسال سفارش مادر (Master Shipment) انجام می‌شود.',
        );
      }

      await assertWholesaleReadyForVipDispatch(client, orderId);

      const order = await one<{
        id: string;
        reference: string;
        status: string;
        buyer_id: string;
      }>(client, 'SELECT id, reference, status, buyer_id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
      if (!order) throw notFound();

      const kolbeWhId = await ensureDefaultKolbeWarehouse(client);
      const supplierLines = await client.query<{
        id: string;
        variant_id: string;
        quantity: number;
      }>(
        `SELECT l.id, l.variant_id, l.quantity
         FROM order_lines l
         JOIN product_variants v ON v.id = l.variant_id
         JOIN products p ON p.id = v.product_id
         WHERE l.order_id = $1 AND (l.supplier_id IS NOT NULL OR p.owner_type = 'supplier')`,
        [orderId],
      );

      for (const line of supplierLines.rows) {
        await client.query(
          `UPDATE stock_balances
           SET on_hand = GREATEST(0, on_hand - $3),
               reserved = GREATEST(0, reserved - $3),
               version = version + 1,
               updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'`,
          [line.variant_id, kolbeWhId, line.quantity],
        );
        await client.query(
          `INSERT INTO stock_movements(
            id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reserved_delta,
            reason, reference_type, reference_id, actor_id, idempotency_key
          ) VALUES ($1,$2,$3,'wholesale',$4,$5,$6,'order',$7,$8,$9)`,
          [
            randomUUID(),
            line.variant_id,
            kolbeWhId,
            -line.quantity,
            -line.quantity,
            `خروج نهایی از انبار کلبه برای ارسال به مشتری VIP سفارش ${order.reference}`,
            orderId,
            user.id,
            `vip-dispatch:${line.id}`,
          ],
        );
      }

      await client.query(
        `UPDATE orders
         SET status = 'shipped',
             wholesale_fulfillment_status = 'vip_dispatched',
             vip_dispatched_at = now(),
             updated_at = now()
         WHERE id = $1`,
        [orderId],
      );
      await client.query(
        "UPDATE supplier_fulfillments SET status = 'vip_dispatched', updated_at = now() WHERE order_id = $1",
        [orderId],
      );
      await client.query(
        'INSERT INTO order_events(id,order_id,from_status,to_status,actor_id,note) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), orderId, order.status, 'shipped', user.id, body.reason],
      );

      const response = {
        orderId,
        reference: order.reference,
        status: 'shipped',
        wholesaleFulfillmentStatus: 'vip_dispatched',
        dispatchedFrom: 'kolbe_warehouse',
      };
      await audit(client, user.id, 'wholesale_order.vip_dispatched', 'order', orderId, { status: order.status }, response, request.ip);
      await outbox(client, 'wholesale_order.vip_dispatched', 'order', orderId, response);
      await completeIdempotency(client, user.id, 'wholesale.dispatch_vip', key, response);
      return response;
    });
  });
}
