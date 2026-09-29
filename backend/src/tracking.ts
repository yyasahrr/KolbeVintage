import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { emitEvent, recordWebhookReceipt } from './events.js';
import { decryptSecret, verifyHmacSignature, verifyTimestampedSignature } from './secrets.js';
import { badRequest, conflict, notFound } from './errors.js';
import { recordTimeline } from './crm-intelligence.js';

/* Tracking Automation Center (items 90-94).
   Every shipment, tracking code and carrier live here; codes can arrive from a
   carrier API, a PDF/Excel extractor or any workflow (n8n) — low-confidence
   matches are never written blindly, they wait in the review queue. */

const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

const shipmentBody = z.object({
  orderId: z.uuid().nullable().optional(),
  carrier: z.string().trim().max(80).nullable().optional(),
  trackingCode: z.string().trim().max(120).nullable().optional(),
  origin: z.string().trim().max(160).nullable().optional(),
  destination: z.string().trim().max(160).nullable().optional(),
  contactPhone: z.string().trim().max(20).nullable().optional(),
  shippedAt: z.string().datetime().nullable().optional(),
  status: z.string().trim().max(60).default('created'),
}).strict();

const eventBody = z.object({
  status: z.string().trim().min(2).max(60),
  location: z.string().trim().max(160).nullable().optional(),
  occurredAt: z.string().datetime(),
  source: z.enum(['carrier_api', 'carrier_website', 'n8n', 'manual', 'pdf', 'excel', 'csv', 'email', 'upload', 'webhook']).default('manual'),
  rawReference: z.string().trim().max(300).nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
  note: z.string().trim().max(500).nullable().optional(),
}).strict();

const importBody = z.object({
  source: z.enum(['carrier_api', 'carrier_website', 'n8n', 'manual', 'pdf', 'excel', 'csv', 'email', 'upload']).default('n8n'),
  fileRef: z.string().trim().max(300).nullable().optional(),
  items: z.array(z.object({
    orderReference: z.string().trim().max(80).nullable().optional(),
    trackingCode: z.string().trim().max(120).nullable().optional(),
    carrier: z.string().trim().max(80).nullable().optional(),
    status: z.string().trim().max(60).nullable().optional(),
    location: z.string().trim().max(160).nullable().optional(),
    occurredAt: z.string().datetime().nullable().optional(),
    confidence: z.number().min(0).max(1).default(1),
    raw: z.record(z.string(), z.unknown()).optional(),
  })).min(1).max(500),
}).strict();

/** Status changes notify the customer (item 94) — tracking SMS is transactional,
 *  so it does not require marketing consent, but it does respect do-not-contact. */
async function notifyTrackingUpdate(client: PoolClient, input: {
  shipmentId: string; buyerId: string | null; status: string; location?: string | null; trackingCode?: string | null; orderReference?: string | null;
}) {
  if (!input.buyerId) return;
  const buyer = await one<{ phone: string | null; display_name: string }>(client,
    `SELECT u.phone,u.display_name FROM users u LEFT JOIN customer_consents c ON c.user_id = u.id
     WHERE u.id = $1 AND NOT COALESCE(c.do_not_contact, false)`, [input.buyerId]);
  if (!buyer) return;
  const title = `به‌روزرسانی مرسوله${input.orderReference ? ` ${input.orderReference}` : ''}`;
  const body = `${input.status}${input.location ? ` — ${input.location}` : ''}${input.trackingCode ? ` (کد رهگیری ${input.trackingCode})` : ''}`;
  const emitted = await emitEvent(client, {
    eventType: 'shipment.tracking.updated', entityType: 'shipment', entityId: input.shipmentId,
    payload: { shipmentId: input.shipmentId, status: input.status, location: input.location ?? null, trackingCode: input.trackingCode ?? null },
  });
  await client.query(
    `INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,'normal')
     ON CONFLICT (user_id,event_id) DO NOTHING`,
    [randomUUID(), input.buyerId, emitted.eventId, title, body]);
  if (buyer.phone && /^09\d{9}$/.test(buyer.phone)) {
    await client.query(
      `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'transactional')
       ON CONFLICT (event_id) DO NOTHING`,
      [randomUUID(), emitted.eventId, input.buyerId, buyer.phone, `کلبه وینتیج | ${title}: ${body}`]);
  }
  await recordTimeline(client, { userId: input.buyerId, eventType: 'shipment.updated', source: 'logistics',
    title, description: body, refType: 'shipment', refId: input.shipmentId });
  await outbox(client, 'order.shipped', 'shipment', input.shipmentId, { shipmentId: input.shipmentId, status: input.status });
}

export async function appendTrackingEvent(client: PoolClient, input: {
  shipmentId: string; status: string; location?: string | null; occurredAt: Date; source: string;
  rawReference?: string | null; confidence?: number; note?: string | null; actorId?: string | null;
}) {
  const confidence = input.confidence ?? 1;
  const reviewStatus = confidence >= REVIEW_CONFIDENCE_THRESHOLD ? 'confirmed' : 'needs_review';
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO shipment_tracking_events(id,shipment_id,status,location,occurred_at,source,raw_reference,confidence,review_status,note,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [eventId, input.shipmentId, input.status, input.location ?? null, input.occurredAt, input.source,
      input.rawReference ?? null, confidence, reviewStatus, input.note ?? null, input.actorId ?? null]);
  if (reviewStatus === 'confirmed') {
    await client.query(
      `UPDATE shipments SET status = $2, last_location = COALESCE($3,last_location), last_status_at = $4, updated_at = now(),
         tracking_code = COALESCE(tracking_code, $5) WHERE id = $1`,
      [input.shipmentId, input.status, input.location ?? null, input.occurredAt, input.rawReference ?? null]);
  }
  return { eventId, reviewStatus };
}

export function registerTrackingRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ----------------------------- tracking center ----------------------------- */
  app.get('/api/v1/admin/shipments', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const query = z.object({
      status: z.string().max(60).optional(),
      search: z.string().max(120).optional(),
      needsReview: z.enum(['true', 'false']).default('false'),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT s.id,s.reference,s.tracking_code,s.carrier,s.status,s.origin,s.destination,s.shipped_at,
              s.last_location,s.last_status_at,s.updated_at,
              o.reference AS order_reference, o.total_rial, u.display_name AS customer_name, u.phone AS customer_phone,
              (SELECT count(*)::int FROM shipment_tracking_events e WHERE e.shipment_id = s.id) AS event_count,
              (SELECT count(*)::int FROM shipment_tracking_events e WHERE e.shipment_id = s.id AND e.review_status = 'needs_review') AS pending_review
       FROM shipments s LEFT JOIN orders o ON o.id = s.order_id LEFT JOIN users u ON u.id = COALESCE(s.buyer_id, o.buyer_id)
       WHERE ($1::text IS NULL OR s.status = $1)
         AND ($2::text IS NULL OR s.tracking_code ILIKE '%' || $2 || '%' OR s.reference ILIKE '%' || $2 || '%'
              OR o.reference ILIKE '%' || $2 || '%' OR u.phone ILIKE '%' || $2 || '%')
         AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM shipment_tracking_events e WHERE e.shipment_id = s.id AND e.review_status = 'needs_review'))
       ORDER BY s.updated_at DESC LIMIT $4`,
      [query.status ?? null, query.search ?? null, query.needsReview === 'true', query.limit]);
    const stats = await one<Record<string, string>>(pool,
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE status = 'delivered')::text AS delivered,
              count(*) FILTER (WHERE status IN ('in_transit','shipped','sent','preparing'))::text AS in_transit,
              (SELECT count(*) FROM shipment_tracking_events WHERE review_status = 'needs_review')::text AS needs_review,
              (SELECT count(*) FROM tracking_import_items WHERE status = 'needs_review')::text AS review_queue
       FROM shipments`);
    return { items: rows.rows, stats };
  });

  app.post('/api/v1/admin/shipments', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const body = shipmentBody.parse(request.body);
    const result = await transaction(pool, async (client) => {
      let buyerId: string | null = null;
      if (body.orderId) {
        const order = await one<{ buyer_id: string }>(client, 'SELECT buyer_id FROM orders WHERE id = $1', [body.orderId]);
        if (!order) throw notFound();
        buyerId = order.buyer_id;
      }
      const id = randomUUID();
      const reference = `SHP-${Date.now().toString(36).toUpperCase()}`;
      await client.query(
        `INSERT INTO shipments(id,reference,order_id,buyer_id,carrier,tracking_code,origin,destination,contact_phone,shipped_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, reference, body.orderId ?? null, buyerId, body.carrier ?? null, body.trackingCode ?? null,
          body.origin ?? null, body.destination ?? null, body.contactPhone ?? null,
          body.shippedAt ? new Date(body.shippedAt) : null, body.status]);
      await audit(client, user.id, 'shipment.created', 'shipment', id, undefined, { reference, ...body }, request.ip);
      return { id, reference, buyerId };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/admin/shipments/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = shipmentBody.partial().strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM shipments WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE shipments SET carrier = COALESCE($2,carrier), tracking_code = COALESCE($3,tracking_code),
           origin = COALESCE($4,origin), destination = COALESCE($5,destination), contact_phone = COALESCE($6,contact_phone),
           shipped_at = COALESCE($7,shipped_at), updated_at = now() WHERE id = $1`,
        [id, body.carrier ?? null, body.trackingCode ?? null, body.origin ?? null, body.destination ?? null,
          body.contactPhone ?? null, body.shippedAt ? new Date(body.shippedAt) : null]);
      await audit(client, user.id, 'shipment.updated', 'shipment', id, before, body, request.ip);
      return one(client, 'SELECT * FROM shipments WHERE id = $1', [id]);
    });
  });

  app.get('/api/v1/admin/shipments/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const shipment = await one<Record<string, unknown>>(pool,
      `SELECT s.*, o.reference AS order_reference, o.shipping_address, u.display_name AS customer_name, u.phone AS customer_phone
       FROM shipments s LEFT JOIN orders o ON o.id = s.order_id
       LEFT JOIN users u ON u.id = COALESCE(s.buyer_id, o.buyer_id) WHERE s.id = $1`, [id]);
    if (!shipment) throw notFound();
    const events = await pool.query(
      `SELECT id,status,location,occurred_at,source,raw_reference,confidence,review_status,note,created_at
       FROM shipment_tracking_events WHERE shipment_id = $1 ORDER BY occurred_at DESC, created_at DESC`, [id]);
    return { shipment, timeline: events.rows };
  });

  /** Manual / carrier timeline entry (requirement 93). */
  app.post('/api/v1/admin/shipments/:id/events', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = eventBody.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const shipment = await one<{ id: string; buyer_id: string | null; order_id: string | null; tracking_code: string | null }>(
        client, 'SELECT id,buyer_id,order_id,tracking_code FROM shipments WHERE id = $1 FOR UPDATE', [id]);
      if (!shipment) throw notFound();
      const order = shipment.order_id
        ? await one<{ reference: string }>(client, 'SELECT reference FROM orders WHERE id = $1', [shipment.order_id]) : null;
      const appended = await appendTrackingEvent(client, {
        shipmentId: id, status: body.status, location: body.location ?? null, occurredAt: new Date(body.occurredAt),
        source: body.source, rawReference: body.rawReference ?? null, confidence: body.confidence,
        note: body.note ?? null, actorId: user.id,
      });
      if (appended.reviewStatus === 'confirmed') {
        await notifyTrackingUpdate(client, { shipmentId: id, buyerId: shipment.buyer_id, status: body.status,
          location: body.location ?? null, trackingCode: shipment.tracking_code, orderReference: order?.reference ?? null });
      }
      await audit(client, user.id, 'shipment.tracking_event', 'shipment', id, undefined,
        { status: body.status, reviewStatus: appended.reviewStatus, source: body.source }, request.ip);
      return appended;
    });
    return reply.code(201).send(result);
  });

  /* --------------------------- import + review queue --------------------------- */
  const ingestImport = async (input: z.infer<typeof importBody>, actorId: string | null, ip: string | null, source: string) =>
    transaction(pool, async (client) => {
      const importId = randomUUID();
      await client.query(
        `INSERT INTO tracking_imports(id,source,file_ref,status,item_count,raw,created_by)
         VALUES ($1,$2,$3,'received',$4,$5,$6)`,
        [importId, input.source, input.fileRef ?? null, input.items.length,
          JSON.stringify({ receivedFrom: source }), actorId]);
      let matched = 0; let needsReview = 0; let failed = 0;
      for (const item of input.items) {
        const itemId = randomUUID();
        const order = item.orderReference
          ? await one<{ id: string; buyer_id: string }>(client, 'SELECT id,buyer_id FROM orders WHERE reference = $1', [item.orderReference])
          : item.trackingCode
            ? await one<{ id: string; buyer_id: string }>(client,
              `SELECT o.id,o.buyer_id FROM orders o JOIN shipments s ON s.order_id = o.id WHERE s.tracking_code = $1 LIMIT 1`, [item.trackingCode])
            : null;
        const confidence = item.confidence;
        if (!order || confidence < REVIEW_CONFIDENCE_THRESHOLD) {
          await client.query(
            `INSERT INTO tracking_import_items(id,import_id,order_reference,tracking_code,carrier,status_taken,location,occurred_at,
               confidence,status,order_id,problem)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'needs_review',$10,$11)`,
            [itemId, importId, item.orderReference ?? null, item.trackingCode ?? null, item.carrier ?? null,
              item.status ?? null, item.location ?? null, item.occurredAt ? new Date(item.occurredAt) : null,
              confidence, order?.id ?? null, !order ? 'order_not_matched' : 'low_confidence']);
          needsReview += 1;
          continue;
        }
        let shipment = await one<{ id: string; tracking_code: string | null }>(client,
          'SELECT id,tracking_code FROM shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [order.id]);
        if (!shipment) {
          const shipmentId = randomUUID();
          await client.query(
            `INSERT INTO shipments(id,reference,order_id,buyer_id,carrier,tracking_code,status,shipped_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [shipmentId, `SHP-${Date.now().toString(36).toUpperCase()}-${shipmentId.slice(0, 4)}`, order.id, order.buyer_id,
              item.carrier ?? null, item.trackingCode ?? null, item.status ?? 'created',
              item.occurredAt ? new Date(item.occurredAt) : null]);
          shipment = { id: shipmentId, tracking_code: item.trackingCode ?? null };
        }
        const appended = await appendTrackingEvent(client, {
          shipmentId: shipment.id, status: item.status ?? 'updated', location: item.location ?? null,
          occurredAt: item.occurredAt ? new Date(item.occurredAt) : new Date(), source: input.source,
          rawReference: item.trackingCode ?? item.orderReference ?? null, confidence, actorId,
        });
        await client.query(
          `INSERT INTO tracking_import_items(id,import_id,order_reference,tracking_code,carrier,status_taken,location,occurred_at,
             confidence,status,shipment_id,order_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [itemId, importId, item.orderReference ?? null, item.trackingCode ?? null, item.carrier ?? null,
            item.status ?? null, item.location ?? null, item.occurredAt ? new Date(item.occurredAt) : null,
            confidence, appended.reviewStatus === 'confirmed' ? 'matched' : 'needs_review', shipment.id, order.id]);
        if (appended.reviewStatus === 'confirmed') {
          matched += 1;
          await notifyTrackingUpdate(client, { shipmentId: shipment.id, buyerId: order.buyer_id,
            status: item.status ?? 'updated', location: item.location ?? null, trackingCode: item.trackingCode ?? null,
            orderReference: item.orderReference ?? null });
        } else {
          needsReview += 1;
        }
      }
      const status = failed && !matched ? 'failed' : needsReview && !matched ? 'partial' : matched ? 'processed' : 'partial';
      await client.query(
        `UPDATE tracking_imports SET status = $2, matched_count = $3, needs_review_count = $4, failed_count = $5, finished_at = now()
         WHERE id = $1`, [importId, status, matched, needsReview, failed]);
      if (actorId) {
        await audit(client, actorId, 'tracking.import', 'tracking_import', importId, undefined,
          { matched, needsReview, failed, source: input.source }, ip ?? undefined);
      }
      return { importId, matched, needsReview, failed, status };
    });

  /** Manual/administrative import (CSV rows pasted by an operator). */
  app.post('/api/v1/admin/tracking/imports', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const body = importBody.parse(request.body);
    const result = await ingestImport(body, user.id, request.ip, 'admin');
    return reply.code(201).send(result);
  });

  /** Machine import endpoint for n8n: HMAC signature + replay protection (items 88/91). */
  app.post('/api/v1/automation/tracking/:code', { config: { rawBody: true } }, async (request, reply) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(request.params);
    const integration = await one<{
      id: string; enabled: boolean; secret_ciphertext: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null;
    }>(pool, 'SELECT id,enabled,secret_ciphertext,secret_iv,secret_tag FROM integrations WHERE code = $1', [code]);
    if (!integration) throw notFound();
    if (!integration.enabled) throw conflict('این اتصال غیرفعال است.');
    const raw = request.rawBody;
    if (!Buffer.isBuffer(raw)) throw badRequest('بدنه امضاشده در دسترس نیست.');
    const header = request.headers['x-kolbe-signature'] ?? request.headers['x-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !integration.secret_ciphertext || !integration.secret_iv || !integration.secret_tag)
      throw badRequest('امضای وب‌هوک لازم است.');
    const secret = decryptSecret(config, { ciphertext: integration.secret_ciphertext, iv: integration.secret_iv, tag: integration.secret_tag });
    // Accepts the timestamped `t=…,v1=…` scheme (preferred: bounded replay window) or
    // the legacy plain-hex digest used by older n8n workflows.
    const verified = signature.includes('v1=')
      ? verifyTimestampedSignature(secret, raw, signature).valid
      : verifyHmacSignature(secret, raw, signature);
    if (!verified) {
      await pool.query(
        `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
         VALUES ($1,$2,'inbound','tracking_import','rejected',$3,$4)`,
        [randomUUID(), integration.id, JSON.stringify({ signature: 'invalid' }), JSON.stringify({ reason: 'bad_signature' })]);
      throw conflict('امضای وب‌هوک معتبر نیست.');
    }
    const receipt = await recordWebhookReceipt(pool, integration.id, signature, raw.toString('utf8'));
    if (!receipt.accepted) throw conflict('این بسته رهگیری قبلاً پردازش شده است (Replay Protection).');
    const body = importBody.parse(JSON.parse(raw.toString('utf8')));
    const result = await ingestImport(body, null, null, `n8n:${code}`);
    await pool.query(
      `INSERT INTO integration_logs(id,integration_id,direction,action,status,request_summary,response_summary)
       VALUES ($1,$2,'inbound','tracking_import','success',$3,$4)`,
      [randomUUID(), integration.id, JSON.stringify({ items: body.items.length }), JSON.stringify(result)]);
    return reply.code(202).send(result);
  });

  app.get('/api/v1/admin/tracking/imports', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const rows = await pool.query(
      `SELECT i.*, u.display_name AS created_by_name FROM tracking_imports i LEFT JOIN users u ON u.id = i.created_by
       ORDER BY i.created_at DESC LIMIT $1`, [query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/tracking/imports/:id/items', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT it.*, o.reference AS matched_order_reference, s.tracking_code AS shipment_tracking_code
       FROM tracking_import_items it LEFT JOIN orders o ON o.id = it.order_id
       LEFT JOIN shipments s ON s.id = it.shipment_id WHERE it.import_id = $1 ORDER BY it.created_at`, [id]);
    return { items: rows.rows };
  });

  /** Requirement 92: a human decides what happens to a low-confidence match. */
  app.post('/api/v1/admin/tracking/imports/items/:itemId/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tracking:manage');
    const { itemId } = z.object({ itemId: z.uuid() }).parse(request.params);
    const body = z.object({
      decision: z.enum(['confirm', 'reject']),
      orderId: z.uuid().nullable().optional(),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const item = await one<Record<string, unknown>>(client,
        'SELECT * FROM tracking_import_items WHERE id = $1 FOR UPDATE', [itemId]);
      if (!item) throw notFound();
      if (item.status !== 'needs_review') throw conflict('این آیتم قبلاً بررسی شده است.');
      if (body.decision === 'reject') {
        await client.query(
          `UPDATE tracking_import_items SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), problem = COALESCE($3, problem)
           WHERE id = $1`, [itemId, user.id, body.note ?? null]);
        await audit(client, user.id, 'tracking.import_item_rejected', 'tracking_import_item', itemId, undefined, body, request.ip);
        return { itemId, status: 'rejected' };
      }
      const orderId = body.orderId ?? (item.order_id as string | null);
      if (!orderId) throw badRequest('برای تأیید باید سفارش مقصد مشخص شود.');
      const order = await one<{ id: string; buyer_id: string; reference: string }>(client,
        'SELECT id,buyer_id,reference FROM orders WHERE id = $1', [orderId]);
      if (!order) throw notFound();
      let shipment = await one<{ id: string; tracking_code: string | null }>(client,
        'SELECT id,tracking_code FROM shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1', [order.id]);
      if (!shipment) {
        const shipmentId = randomUUID();
        await client.query(
          `INSERT INTO shipments(id,reference,order_id,buyer_id,carrier,tracking_code,status,shipped_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [shipmentId, `SHP-${Date.now().toString(36).toUpperCase()}-${shipmentId.slice(0, 4)}`, order.id, order.buyer_id,
            (item.carrier as string) ?? null, (item.tracking_code as string) ?? null, (item.status_taken as string) ?? 'created',
            item.occurred_at ? new Date(String(item.occurred_at)) : null]);
        shipment = { id: shipmentId, tracking_code: (item.tracking_code as string) ?? null };
      }
      const appended = await appendTrackingEvent(client, {
        shipmentId: shipment.id, status: (item.status_taken as string) ?? 'updated',
        location: (item.location as string) ?? null,
        occurredAt: item.occurred_at ? new Date(String(item.occurred_at)) : new Date(),
        source: 'manual', rawReference: (item.tracking_code as string) ?? null, confidence: 1,
        note: `تأیید دستی توسط ${user.displayName}`, actorId: user.id,
      });
      await client.query(
        `UPDATE tracking_import_items SET status = 'matched', reviewed_by = $2, reviewed_at = now(), shipment_id = $3,
           order_id = $4, problem = NULL WHERE id = $1`, [itemId, user.id, shipment.id, order.id]);
      await notifyTrackingUpdate(client, { shipmentId: shipment.id, buyerId: order.buyer_id,
        status: (item.status_taken as string) ?? 'updated', location: (item.location as string) ?? null,
        trackingCode: (item.tracking_code as string) ?? null, orderReference: order.reference });
      await audit(client, user.id, 'tracking.import_item_confirmed', 'tracking_import_item', itemId, undefined,
        { orderId: order.id, shipmentId: shipment.id, eventId: appended.eventId }, request.ip);
      return { itemId, status: 'matched', shipmentId: shipment.id };
    });
  });
}
