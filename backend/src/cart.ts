import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { emitEvent } from './events.js';
import { audit } from './operations.js';
import { asRial, rial } from './money.js';
import { consentedRecipients, ensureContact, recordTimeline } from './crm-intelligence.js';
import { principal, requirePermission } from './auth.js';
import { resolveVariantPrice } from './promotions.js';

/**
 * Requirement 23 — `cart.abandoned` must be a real server-side event, not a browser
 * guess. The cart lives in PostgreSQL so: the storefront (and the Telegram/bot or
 * n8n flows) all write to the same cart, the value of the abandoned cart is known
 * server-side, and the abandonment sweep can emit the event exactly once.
 */

const cartItemBody = z.object({
  productId: z.uuid(),
  variantId: z.uuid().nullable().optional(),
  quantity: z.number().int().min(1).max(1000).default(1),
  color: z.string().trim().max(60).nullable().optional(),
  size: z.string().trim().max(60).nullable().optional(),
  // Price is verified against the catalogue; this field only exists to reject
  // stale clients early, never to trust the browser.
  expectedUnitPriceRial: z.string().regex(/^\d+$/).optional(),
}).strict();

const mergeBody = z.object({
  sessionKey: z.string().trim().min(6).max(120).optional(),
  items: z.array(cartItemBody).max(200).default([]),
}).strict();

export type AbandonedCartRow = {
  id: string; user_id: string; value_rial: string; item_count: number; updated_at: Date; display_name: string | null;
};

/** §38: the cart unit price is the LATEST canonical server resolution (base + resolved promotion),
 *  never a browser-supplied number and never a stale copy of the product row. Sellable stock comes
 *  from WMS: `available = on_hand - reserved - damaged`, exactly like the inventory module. */
async function resolvePrice(client: DbClient, productId: string, variantId: string | null) {
  const product = await one<{ cash_price_rial: string; status: string }>(client,
    'SELECT cash_price_rial::text AS cash_price_rial, status FROM products WHERE id = $1', [productId]);
  if (!product || product.status !== 'published') throw notFound();
  const variant = variantId
    ? await one<{ id: string }>(client, 'SELECT id FROM product_variants WHERE id = $1 AND product_id = $2 AND active',
      [variantId, productId])
    : await one<{ id: string }>(client,
      'SELECT id FROM product_variants WHERE product_id = $1 AND active ORDER BY created_at LIMIT 1', [productId]);
  const resolved = variant
    ? await resolveVariantPrice(client, variant.id, { orderType: 'retail', paymentMode: 'cash' })
    : null;
  const base = resolved ? rial(resolved.basePrice) : rial(product.cash_price_rial);
  const price = resolved ? rial(resolved.finalPrice) : base;
  const stock = variant
    ? await one<{ available: string }>(client,
      `SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged),0)::text AS available
       FROM stock_balances b WHERE b.variant_id = $1`, [variant.id])
    : null;
  return {
    price, basePrice: base, discountAmount: base - price,
    matchedRuleId: resolved?.matchedRule?.id ?? null, variantId: variant?.id ?? null,
    available: Number(stock?.available ?? 0),
  };
}

async function recompute(client: DbClient, cartId: string) {
  const totals = await one<{ item_count: string; value_rial: string }>(client,
    `SELECT COALESCE(sum(quantity),0)::text AS item_count, COALESCE(sum(quantity * unit_price_rial),0)::text AS value_rial
     FROM cart_items WHERE cart_id = $1`, [cartId]);
  await client.query('UPDATE carts SET item_count = $2, value_rial = $3, updated_at = now() WHERE id = $1',
    [cartId, Number(totals?.item_count ?? 0), totals?.value_rial ?? '0']);
  return { itemCount: Number(totals?.item_count ?? 0), valueRial: String(totals?.value_rial ?? '0') };
}

/** The single active cart of a user (or of an anonymous session key). */
type CartKey = { userId?: string | null; sessionKey?: string | null };

async function activeCart(client: DbClient, key: CartKey) {
  const row = key.userId
    ? await one<{ id: string }>(client, `SELECT id FROM carts WHERE user_id = $1 AND status = 'active'`, [key.userId])
    : await one<{ id: string }>(client, `SELECT id FROM carts WHERE session_key = $1 AND status = 'active'`, [key.sessionKey ?? '']);
  return row?.id ?? null;
}

async function ensureCart(client: DbClient, key: CartKey) {
  const existing = await activeCart(client, key);
  if (existing) return existing;
  const id = randomUUID();
  await client.query('INSERT INTO carts(id,user_id,session_key,status) VALUES ($1,$2,$3,\'active\')',
    [id, key.userId ?? null, key.sessionKey ?? null]);
  return id;
}

/** Merge an anonymous session cart into the signed-in user's cart (login / checkout). */
export async function attachSessionCart(client: DbClient, userId: string, sessionKey: string | null) {
  if (!sessionKey) return null;
  const anonymous = await one<{ id: string }>(client,
    `SELECT id FROM carts WHERE session_key = $1 AND status = 'active'`, [sessionKey]);
  if (!anonymous) return null;
  const target = await ensureCart(client, { userId });
  await client.query(
    `INSERT INTO cart_items(id,cart_id,product_id,variant_id,quantity,unit_price_rial,color_label,size_label)
     SELECT gen_random_uuid(),$2,product_id,variant_id,quantity,unit_price_rial,color_label,size_label FROM cart_items WHERE cart_id = $1
     ON CONFLICT DO NOTHING`, [anonymous.id, target]);
  await client.query(`UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1`, [anonymous.id]);
  await recompute(client, target);
  return target;
}

/** Mark a cart as converted to an order (called from the order flow). */
export async function markCartConverted(client: DbClient, userId: string | null, orderId: string | null) {
  if (!userId) return null;
  const cart = await one<{ id: string }>(client, `SELECT id FROM carts WHERE user_id = $1 AND status = 'active'`, [userId]);
  if (!cart) return null;
  await client.query(
    `UPDATE carts SET status = 'converted', converted_order_id = $2, updated_at = now(), notified_at = NULL WHERE id = $1`,
    [cart.id, orderId]);
  await emitEvent(client, { eventType: 'cart.converted', entityType: 'cart', entityId: cart.id,
    payload: { cartId: cart.id, userId, orderId }, source: 'cart' });
  await recordTimeline(client, { userId, eventType: 'cart.converted', source: 'cart',
    title: 'سبد خرید به سفارش تبدیل شد', refType: 'order', refId: orderId });
  return cart.id;
}

/** Sweep: carts untouched for N hours become `abandoned` and emit cart.abandoned once. */
export async function sweepAbandonedCarts(pool: DbPool, idleHours = 6, limit = 50) {
  const stale = await pool.query<AbandonedCartRow>(
    `SELECT c.id,c.user_id,c.value_rial::text,c.item_count,c.updated_at,u.display_name,u.phone
     FROM carts c JOIN users u ON u.id = c.user_id
     WHERE c.status = 'active' AND c.user_id IS NOT NULL AND c.item_count > 0
       AND c.updated_at < now() - ($1::int || ' hours')::interval
     ORDER BY c.updated_at LIMIT $2`, [idleHours, limit]);
  const results: { cartId: string; userId: string; valueRial: string; notified: boolean }[] = [];
  for (const cart of stale.rows) {
    const outcome = await transaction(pool, async (client) => {
      const locked = await one<{ id: string; user_id: string; status: string; value_rial: string; item_count: number; updated_at: Date }>(client,
        'SELECT id,user_id,status,value_rial::text,item_count,updated_at FROM carts WHERE id = $1 FOR UPDATE', [cart.id]);
      if (!locked || locked.status !== 'active') return null;
      const abandonedAt = new Date();
      await client.query(`UPDATE carts SET status = 'abandoned', abandoned_at = $2, updated_at = now() WHERE id = $1`,
        [cart.id, abandonedAt]);
      const emitted = await emitEvent(client, {
        eventType: 'cart.abandoned', entityType: 'cart', entityId: cart.id, source: 'cart',
        payload: { cartId: cart.id, userId: cart.user_id, valueRial: asRial(locked.value_rial), itemCount: locked.item_count,
          lastActivityAt: locked.updated_at.toISOString() },
      });
      const consent = await consentedRecipients(client, [cart.user_id] as string[]);
      await recordTimeline(client, { userId: cart.user_id, eventType: 'cart.abandoned', source: 'cart',
        title: `سبد خرید رهاشده به ارزش ${asRial(locked.value_rial)} ریال`, refType: 'cart', refId: cart.id,
        metadata: { eventId: emitted.eventId, valueRial: asRial(locked.value_rial) } });
      let notified = false;
      if (consent.length) {
        await client.query(`UPDATE carts SET notified_at = now() WHERE id = $1`, [cart.id]);
        await client.query(
          `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'marketing')`,
          [randomUUID(), emitted.eventId, cart.user_id, consent[0]!.phone,
            'کلبه وینتیج: سبد خرید شما منتظر شماست. برای تکمیل سفارش برگردید.']);
        notified = true;
      }
      return { cartId: cart.id, userId: cart.user_id, valueRial: asRial(locked.value_rial), notified };
    });
    if (outcome) results.push(outcome);
  }
  return { swept: results.length, carts: results };
}

export function registerCartRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** Cart for the caller: the signed-in user, or an anonymous session key. */
  const resolve = async (request: FastifyRequest): Promise<CartKey> => {
    if (request.headers.authorization?.startsWith('Bearer ')) {
      try {
        const user = await principal(request, pool, config);
        return { userId: user.id as string | null, sessionKey: null as string | null };
      } catch { /* invalid token → treat as an anonymous cart */ }
    }
    const sessionKey = (request.body as { sessionKey?: string } | undefined)?.sessionKey
      ?? (request.query as { sessionKey?: string } | undefined)?.sessionKey ?? null;
    return { userId: null as string | null, sessionKey: sessionKey as string | null };
  };

  app.get('/api/v1/cart', async (request) => {
    const key = await resolve(request);
    if (!key.userId && !key.sessionKey) throw badRequest('کلید نشست سبد خرید لازم است.');
    const cartId = await activeCart(pool, key);
    if (!cartId) return { cart: null, items: [], itemCount: 0, valueRial: '0' };
    const cart = await one<Record<string, unknown>>(pool,
      `SELECT id,user_id,status,item_count,value_rial::text AS value_rial,created_at,updated_at FROM carts WHERE id = $1`, [cartId]);
    const items = await pool.query(
      `SELECT i.id,i.product_id,i.variant_id,i.quantity,i.unit_price_rial::text AS unit_price_rial,i.color_label,i.size_label,
              p.name AS product_name,p.brand,p.category,
              (SELECT COALESCE(m.external_url, '/api/v1/files/' || m.file_id::text) FROM product_media m
                WHERE m.product_id = p.id AND m.role <> 'video' AND m.active
                ORDER BY m.position LIMIT 1) AS image_url,
              (SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged),0) FROM stock_balances b WHERE b.variant_id = i.variant_id) AS variant_stock
       FROM cart_items i JOIN products p ON p.id = i.product_id
       LEFT JOIN product_variants v ON v.id = i.variant_id
       WHERE i.cart_id = $1 ORDER BY i.added_at`, [cartId]);
    return { cart, items: items.rows, itemCount: cart?.item_count ?? 0, valueRial: String(cart?.value_rial ?? '0') };
  });

  app.post('/api/v1/cart/items', async (request, reply) => {
    const key = await resolve(request);
    const body = cartItemBody.extend({ sessionKey: z.string().trim().min(6).max(120).optional() })
      .strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const cartId = await ensureCart(client, key.userId ? { userId: key.userId } : { sessionKey: key.sessionKey! });
      const resolved = await resolvePrice(client, body.productId, body.variantId ?? null);
      if (body.expectedUnitPriceRial && rial(body.expectedUnitPriceRial) !== resolved.price) {
        throw conflict('قیمت محصول تغییر کرده است؛ سبد را دوباره ببینید.');
      }
      if (resolved.available < body.quantity) throw badRequest('موجودی کافی برای این تعداد نیست.');
      await client.query(
        `INSERT INTO cart_items(id,cart_id,product_id,variant_id,quantity,unit_price_rial,color_label,size_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (cart_id,product_id,COALESCE(color_label,''),COALESCE(size_label,''))
         DO UPDATE SET quantity = EXCLUDED.quantity, unit_price_rial = EXCLUDED.unit_price_rial, updated_at = now()`,
        [randomUUID(), cartId, body.productId, resolved.variantId, body.quantity, resolved.price.toString(),
          body.color ?? null, body.size ?? null]);
      const totals = await recompute(client, cartId);
      await client.query('UPDATE carts SET status = \'active\', abandoned_at = NULL, notified_at = NULL WHERE id = $1', [cartId]);
      if (key.userId) {
        const contactId = await ensureContact(client, key.userId);
        await client.query(
          `INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id,result,created_by)
           VALUES ($1,$2,'cart',$3,$4,'cart',$5,$6,NULL)`,
          [randomUUID(), contactId, 'افزودن به سبد خرید', `ارزش سبد: ${totals.valueRial} ریال`, cartId,
            JSON.stringify({ itemCount: totals.itemCount, valueRial: totals.valueRial })]);
      }
      return { cartId, ...totals };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/cart/items/:itemId', async (request) => {
    const key = await resolve(request);
    const { itemId } = z.object({ itemId: z.uuid() }).parse(request.params);
    const body = z.object({ quantity: z.number().int().min(1).max(1000) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const cartId = await activeCart(client, key.userId ? { userId: key.userId } : { sessionKey: key.sessionKey ?? '' });
      if (!cartId) throw notFound();
      const updated = await client.query('UPDATE cart_items SET quantity = $3, updated_at = now() WHERE id = $1 AND cart_id = $2',
        [itemId, cartId, body.quantity]);
      if (!updated.rowCount) throw notFound();
      await client.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
      return { ...(await recompute(client, cartId)) };
    });
  });

  app.delete('/api/v1/cart/items/:itemId', async (request) => {
    const key = await resolve(request);
    const { itemId } = z.object({ itemId: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const cartId = await activeCart(client, key.userId ? { userId: key.userId } : { sessionKey: key.sessionKey ?? '' });
      if (!cartId) throw notFound();
      await client.query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cartId]);
      await client.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
      return { ...(await recompute(client, cartId)) };
    });
  });

  /** Anonymous → signed-in merge, so the same cart continues after login. */
  app.post('/api/v1/cart/merge', async (request) => {
    const user = await principal(request, pool, config);
    const body = mergeBody.parse(request.body);
    return transaction(pool, async (client) => {
      const cartId = await attachSessionCart(client, user.id, body.sessionKey ?? null);
      const target = cartId ?? (await activeCart(client, { userId: user.id }));
      if (!target) return { cartId: null, itemCount: 0, valueRial: '0' };
      return { cartId: target, ...(await recompute(client, target)) };
    });
  });

  /* ------------------------------- admin surface ------------------------------- */

  /** Abandoned-cart queue (requirement 24/98): value, age and re-engagement send. */
  app.get('/api/v1/admin/carts/abandoned', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const query = z.object({ hours: z.coerce.number().int().min(1).max(720).default(6), limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(request.query);
    const rows = await pool.query(
      `SELECT c.id,c.user_id,c.value_rial::text AS value_rial,c.item_count,c.status,c.abandoned_at,c.notified_at,c.updated_at,
              u.display_name,u.phone,
              (SELECT count(*)::int FROM cart_items i WHERE i.cart_id = c.id) AS line_count
       FROM carts c LEFT JOIN users u ON u.id = c.user_id
       WHERE c.item_count > 0 AND (
         (c.status = 'active' AND c.updated_at < now() - ($1::int || ' hours')::interval)
         OR c.status = 'abandoned')
       ORDER BY c.updated_at DESC LIMIT $2`, [query.hours, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, value_rial: asRial(row.value_rial) })) };
  });

  app.post('/api/v1/admin/carts/sweep', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = z.object({ idleHours: z.number().int().min(1).max(720).default(6), limit: z.number().int().min(1).max(200).default(50) })
      .strict().parse(request.body ?? {});
    const result = await sweepAbandonedCarts(pool, body.idleHours, body.limit);
    await audit(pool, user.id, 'cart.sweep', 'cart', 'abandoned', undefined, result, request.ip);
    return result;
  });

  /** Manual nudge for one abandoned cart — still behind the marketing-consent gate. */
  app.post('/api/v1/admin/carts/:id/nudge', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'campaigns:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ message: z.string().trim().min(5).max(400).optional() }).strict().parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const cart = await one<{ id: string; user_id: string | null; value_rial: string; status: string }>(client,
        'SELECT id,user_id,value_rial::text,status FROM carts WHERE id = $1 FOR UPDATE', [id]);
      if (!cart?.user_id) throw notFound();
      const consent = await consentedRecipients(client, [cart.user_id] as string[]);
      if (!consent.length) throw forbidden();
      const message = body.message ?? `کلبه وینتیج: سبد خرید شما منتظر شماست (ارزش ${asRial(cart.value_rial)} ریال).`;
      const emitted = await emitEvent(client, { eventType: 'cart.nudged', entityType: 'cart', entityId: cart.id,
        payload: { cartId: cart.id, userId: cart.user_id, valueRial: asRial(cart.value_rial) }, actorId: user.id });
      await client.query(
        `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'marketing')`,
        [randomUUID(), emitted.eventId, cart.user_id, consent[0]!.phone, message]);
      await client.query('UPDATE carts SET notified_at = now() WHERE id = $1', [cart.id]);
      await recordTimeline(client, { userId: cart.user_id, eventType: 'cart.nudged', source: 'crm',
        title: 'یادآوری سبد خرید ارسال شد', refType: 'cart', refId: cart.id, actorId: user.id });
      await audit(client, user.id, 'cart.nudged', 'cart', cart.id, undefined, { valueRial: asRial(cart.value_rial) }, request.ip);
      return { cartId: cart.id, sent: true };
    });
  });
}
