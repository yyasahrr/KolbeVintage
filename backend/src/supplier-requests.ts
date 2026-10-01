import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, notifyByPermission, notifyUser, outbox, requestHash } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

/**
 * Supplier replenishment / new-product requests (section I).
 *
 * Flow: submit → admin review (approve / reject with mandatory detailed reason /
 * request revision) → supplier dispatch → wholesale incoming receipts → warehouse
 * receive + QC → on_hand. Approval NEVER touches stock; only the receipt receive
 * step increases on_hand (section J).
 */

const MAX_ITEMS_PER_REQUEST = 10;

const requestItem = z.object({
  itemType: z.enum(['new_product', 'replenishment']),
  productId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  proposedName: z.string().trim().min(2).max(200).optional(),
  proposedColor: z.string().trim().max(80).optional(),
  proposedSize: z.string().trim().max(80).optional(),
  quantity: z.number().int().min(1).max(100000),
  unitCostRial: z.number().int().min(0).optional(),
  note: z.string().trim().max(500).optional(),
}).superRefine((item, ctx) => {
  if (item.itemType === 'replenishment' && !item.variantId) {
    ctx.addIssue({ code: 'custom', message: 'برای شارژ مجدد موجودی، انتخاب تنوع (variant) الزامی است.' });
  }
  if (item.itemType === 'new_product' && !item.proposedName) {
    ctx.addIssue({ code: 'custom', message: 'برای محصول جدید، نام پیشنهادی الزامی است.' });
  }
});

const createBody = z.object({
  note: z.string().trim().max(1000).optional(),
  items: z.array(requestItem).min(1),
});

type Snapshot = { note: string; items: Array<Record<string, unknown>> };

async function insertItems(
  client: Parameters<Parameters<typeof transaction>[1]>[0],
  requestId: string,
  supplierId: string,
  items: z.infer<typeof requestItem>[],
) {
  for (const item of items) {
    let productId = item.productId ?? null;
    if (item.variantId) {
      const variant = await one<{ product_id: string; supplier_id: string | null }>(
        client,
        'SELECT v.product_id, p.supplier_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1',
        [item.variantId],
      );
      if (!variant) throw notFound();
      // T/RBAC: a supplier may only request replenishment for their own products.
      if (variant.supplier_id !== supplierId) {
        throw forbidden('شما فقط برای محصولات خودتان می‌توانید درخواست شارژ موجودی ثبت کنید.');
      }
      productId = variant.product_id;
    }
    await client.query(
      `INSERT INTO supplier_request_items(
        id, request_id, item_type, product_id, variant_id,
        proposed_name, proposed_color, proposed_size, quantity, unit_cost_rial, note
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(), requestId, item.itemType, productId, item.variantId ?? null,
        item.proposedName ?? null, item.proposedColor ?? null, item.proposedSize ?? null,
        item.quantity, item.unitCostRial ?? null, item.note ?? '',
      ],
    );
  }
}

async function snapshotRevision(
  client: Parameters<Parameters<typeof transaction>[1]>[0],
  requestId: string,
  revisionNo: number,
  snapshot: Snapshot,
  note: string,
  userId: string,
) {
  await client.query(
    `INSERT INTO supplier_request_revisions(id, request_id, revision_no, snapshot, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), requestId, revisionNo, JSON.stringify(snapshot), note, userId],
  );
}

async function loadRequest(pool: DbPool, id: string) {
  const req = await one<{
    id: string; request_number: string; supplier_id: string; status: string; note: string;
    rejection_reason: string | null; revision_note: string | null; revision_count: number;
    reviewed_by: string | null; reviewed_at: string | null; dispatched_at: string | null;
    dispatch_batch_reference: string | null; dispatch_carrier: string | null;
    received_at: string | null; created_at: string; updated_at: string;
  }>(pool, 'SELECT * FROM supplier_requests WHERE id = $1', [id]);
  if (!req) throw notFound();
  const items = await pool.query(
    `SELECT i.id, i.item_type, i.product_id, i.variant_id, i.proposed_name, i.proposed_color, i.proposed_size,
            i.quantity, i.unit_cost_rial::text AS unit_cost_rial, i.note,
            p.name AS product_name, v.sku AS variant_sku, v.color_label, v.size_label
     FROM supplier_request_items i
     LEFT JOIN products p ON p.id = i.product_id
     LEFT JOIN product_variants v ON v.id = i.variant_id
     WHERE i.request_id = $1 ORDER BY i.created_at`,
    [id],
  );
  const revisions = await pool.query(
    `SELECT revision_no, snapshot, note, created_by, created_at
     FROM supplier_request_revisions WHERE request_id = $1 ORDER BY revision_no`,
    [id],
  );
  const receipts = await pool.query(
    `SELECT id, reference, status, quantity, received_quantity, missing_quantity, inventory_domain, created_at, received_at
     FROM stock_receipts WHERE supplier_request_id = $1 ORDER BY created_at`,
    [id],
  );
  return { ...req, items: items.rows, revisions: revisions.rows, receipts: receipts.rows };
}

export function registerSupplierRequestRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Create (supplier)
  app.post('/api/v1/supplier-requests', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden('فقط تأمین‌کنندگان می‌توانند درخواست تأمین ثبت کنند.');
    const body = createBody.parse(request.body);
    if (body.items.length > MAX_ITEMS_PER_REQUEST) {
      throw badRequest(`حداکثر ${MAX_ITEMS_PER_REQUEST} قلم در هر درخواست مجاز است.`);
    }
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'supplier_request.create', key, requestHash(body));
      if (claim.previous) return claim.previous;

      const seq = await one<{ n: string }>(client, "SELECT nextval('supplier_request_seq')::text AS n");
      const requestNumber = `SR-${seq!.n}`;
      const id = randomUUID();
      await client.query(
        `INSERT INTO supplier_requests(id, request_number, supplier_id, status, note)
         VALUES ($1,$2,$3,'submitted',$4)`,
        [id, requestNumber, user.id, body.note ?? ''],
      );
      await insertItems(client, id, user.id, body.items);
      await snapshotRevision(client, id, 1, { note: body.note ?? '', items: body.items as Array<Record<string, unknown>> }, 'نسخه اولیه', user.id);

      const result = { id, requestNumber, status: 'submitted', itemCount: body.items.length };
      await audit(client, user.id, 'supplier_request.created', 'supplier_request', id, undefined, result, request.ip);
      await outbox(client, 'supplier_request.created', 'supplier_request', id, result);
      await notifyByPermission(client, 'wholesale:ops', 'supplier_request.created.notify', 'supplier_request', id,
        `درخواست تأمین جدید ${requestNumber}`,
        `یک درخواست تأمین با ${body.items.length} قلم توسط تأمین‌کننده ثبت شد و در انتظار بررسی است.`, 'normal');
      await completeIdempotency(client, user.id, 'supplier_request.create', key, result);
      return result;
    });
    return reply.code(201).send(response);
  });

  // List (supplier: own — admin/ops: all)
  app.get('/api/v1/supplier-requests', async (request) => {
    const user = await principal(request, pool, config);
    const privileged = user.permissions.includes('wholesale:ops') || user.permissions.includes('inventory:read');
    if (!privileged && !user.roles.includes('supplier')) throw forbidden();
    const query = z.object({
      status: z.string().max(40).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT r.id, r.request_number, r.supplier_id, u.display_name AS supplier_name, r.status, r.note,
              r.rejection_reason, r.revision_note, r.revision_count, r.created_at, r.updated_at,
              r.dispatched_at, r.received_at,
              (SELECT count(*) FROM supplier_request_items i WHERE i.request_id = r.id)::int AS item_count,
              (SELECT COALESCE(sum(i.quantity),0) FROM supplier_request_items i WHERE i.request_id = r.id)::int AS total_quantity
       FROM supplier_requests r JOIN users u ON u.id = r.supplier_id
       WHERE ($1::boolean = true OR r.supplier_id = $2)
         AND ($3::text IS NULL OR r.status = $3)
       ORDER BY r.created_at DESC LIMIT $4`,
      [privileged, user.id, query.status ?? null, query.limit],
    );
    return { items: rows.rows };
  });

  // Detail
  app.get('/api/v1/supplier-requests/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const detail = await loadRequest(pool, id);
    const privileged = user.permissions.includes('wholesale:ops') || user.permissions.includes('inventory:read');
    if (!privileged && detail.supplier_id !== user.id) throw forbidden();
    return detail;
  });

  // Admin review: approve / reject (detailed reason mandatory) / request revision.
  app.post('/api/v1/supplier-requests/:id/review', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'inventory:adjust');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      decision: z.enum(['approve', 'reject', 'request_revision']),
      reason: z.string().trim().max(1000).optional(),
    }).parse(request.body);

    if (body.decision === 'reject' && (!body.reason || body.reason.length < 10)) {
      throw badRequest('برای رد درخواست، ثبت دلیل دقیق (حداقل ۱۰ کاراکتر) الزامی است.');
    }
    if (body.decision === 'request_revision' && (!body.reason || body.reason.length < 5)) {
      throw badRequest('برای درخواست اصلاح، توضیح لازم است.');
    }

    return transaction(pool, async (client) => {
      const req = await one<{ id: string; request_number: string; supplier_id: string; status: string }>(
        client, 'SELECT * FROM supplier_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!req) throw notFound();
      if (req.status !== 'submitted') {
        throw conflict(`درخواست در وضعیت ${req.status} قابل بررسی نیست.`);
      }

      const nextStatus = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'needs_revision';
      await client.query(
        `UPDATE supplier_requests
         SET status = $2, rejection_reason = $3, revision_note = $4,
             reviewed_by = $5, reviewed_at = now(), updated_at = now()
         WHERE id = $1`,
        [id, nextStatus,
          body.decision === 'reject' ? body.reason : null,
          body.decision === 'request_revision' ? body.reason : null,
          user.id],
      );

      // I: approval must NOT increase on_hand — stock only moves at receipt receive.
      const out = { id, requestNumber: req.request_number, status: nextStatus, reason: body.reason ?? null };
      await audit(client, user.id, `supplier_request.${nextStatus}`, 'supplier_request', id, { status: req.status }, out, request.ip);
      await outbox(client, `supplier_request.${nextStatus}`, 'supplier_request', id, out);
      const titles: Record<string, string> = {
        approved: `درخواست ${req.request_number} تأیید شد`,
        rejected: `درخواست ${req.request_number} رد شد`,
        needs_revision: `درخواست ${req.request_number} نیاز به اصلاح دارد`,
      };
      const bodies: Record<string, string> = {
        approved: 'درخواست تأمین شما تأیید شد. لطفاً کالاها را برای کلبه ارسال کنید.',
        rejected: `دلیل رد: ${body.reason ?? ''}`,
        needs_revision: `توضیح ادمین: ${body.reason ?? ''}`,
      };
      await notifyUser(client, req.supplier_id, `supplier_request.${nextStatus}.notify`, 'supplier_request', id,
        titles[nextStatus] ?? `درخواست ${req.request_number}`, bodies[nextStatus] ?? '',
        nextStatus === 'rejected' ? 'high' : 'normal');
      return out;
    });
  });

  // Supplier revision + resubmit (history preserved).
  app.post('/api/v1/supplier-requests/:id/revise', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = createBody.parse(request.body);
    if (body.items.length > MAX_ITEMS_PER_REQUEST) {
      throw badRequest(`حداکثر ${MAX_ITEMS_PER_REQUEST} قلم در هر درخواست مجاز است.`);
    }

    return transaction(pool, async (client) => {
      const req = await one<{ id: string; request_number: string; supplier_id: string; status: string; revision_count: number }>(
        client, 'SELECT * FROM supplier_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!req) throw notFound();
      if (req.supplier_id !== user.id) throw forbidden();
      if (req.status !== 'needs_revision') {
        throw conflict('فقط درخواست‌هایی که ادمین برای آن‌ها اصلاح خواسته قابل ویرایش هستند.');
      }

      await client.query('DELETE FROM supplier_request_items WHERE request_id = $1', [id]);
      await insertItems(client, id, user.id, body.items);
      const nextRevision = req.revision_count + 2; // revision 1 = initial snapshot
      const snapshot: Snapshot = { note: body.note ?? '', items: body.items as unknown as Array<Record<string, unknown>> };
      await snapshotRevision(client, id, nextRevision, snapshot, 'نسخه اصلاح‌شده توسط تأمین‌کننده', user.id);
      await client.query(
        `UPDATE supplier_requests
         SET status = 'submitted', note = $2, revision_count = revision_count + 1,
             rejection_reason = NULL, updated_at = now()
         WHERE id = $1`,
        [id, body.note ?? ''],
      );

      const out = { id, requestNumber: req.request_number, status: 'submitted', revision: nextRevision };
      await audit(client, user.id, 'supplier_request.revised', 'supplier_request', id, { status: req.status }, out, request.ip);
      await outbox(client, 'supplier_request.revised', 'supplier_request', id, out);
      await notifyByPermission(client, 'wholesale:ops', 'supplier_request.revised.notify', 'supplier_request', id,
        `درخواست ${req.request_number} اصلاح و مجدداً ارسال شد`,
        'نسخه اصلاح‌شده درخواست تأمین در انتظار بررسی مجدد است.', 'normal');
      return out;
    });
  });

  // Supplier dispatch: approved → dispatched + wholesale incoming receipts (J: incoming ≠ on_hand).
  app.post('/api/v1/supplier-requests/:id/dispatch', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      warehouseId: z.uuid(),
      batchReference: z.string().trim().max(120).optional(),
      carrier: z.string().trim().max(120).optional(),
      note: z.string().trim().max(500).optional(),
    }).parse(request.body);

    return transaction(pool, async (client) => {
      const req = await one<{ id: string; request_number: string; supplier_id: string; status: string }>(
        client, 'SELECT * FROM supplier_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!req) throw notFound();
      const privileged = user.permissions.includes('wholesale:ops');
      if (!privileged && req.supplier_id !== user.id) throw forbidden();
      if (req.status !== 'approved') throw conflict('فقط درخواست‌های تأییدشده قابل ارسال هستند.');

      const warehouse = await one<{ id: string; owner_id: string | null; active: boolean }>(
        client, 'SELECT id, owner_id, active FROM warehouses WHERE id = $1', [body.warehouseId]);
      if (!warehouse || !warehouse.active) throw notFound();

      const items = await client.query<{ id: string; item_type: string; variant_id: string | null; quantity: number }>(
        'SELECT id, item_type, variant_id, quantity FROM supplier_request_items WHERE request_id = $1',
        [id],
      );

      const receipts: Array<{ id: string; reference: string; quantity: number }> = [];
      for (const item of items.rows) {
        // J1: new_product items without a created variant stay visible as pending rows,
        // they cannot create incoming stock until the product/variant actually exists.
        if (!item.variant_id) continue;
        await client.query(
          `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain) VALUES ($1,$2,'wholesale')
           ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
          [item.variant_id, body.warehouseId],
        );
        await client.query(
          `UPDATE stock_balances SET incoming = incoming + $3, version = version + 1
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale'`,
          [item.variant_id, body.warehouseId, item.quantity],
        );
        const receiptId = randomUUID();
        const refSeq = await one<{ number: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS number");
        const reference = `RCPT-${refSeq!.number}`;
        await client.query(
          `INSERT INTO stock_receipts(id, reference, receipt_number, warehouse_id, variant_id, quantity, status, created_by, inventory_domain, batch_reference, supplier_request_id)
           VALUES ($1,$2,$2,$3,$4,$5,'pending',$6,'wholesale',$7,$8)`,
          [receiptId, reference, body.warehouseId, item.variant_id, item.quantity, user.id, body.batchReference ?? null, id],
        );
        await client.query(
          `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, incoming_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
           VALUES ($1,$2,$3,'wholesale',$4,$5,'receipt',$6,$7,$8)`,
          [randomUUID(), item.variant_id, body.warehouseId, item.quantity,
            `ارسال درخواست تأمین ${req.request_number}`, receiptId, user.id, `sr-dispatch:${id}:${item.id}`],
        );
        receipts.push({ id: receiptId, reference, quantity: item.quantity });
      }

      await client.query(
        `UPDATE supplier_requests
         SET status = 'dispatched', dispatched_at = now(), dispatch_batch_reference = $2, dispatch_carrier = $3, updated_at = now()
         WHERE id = $1`,
        [id, body.batchReference ?? null, body.carrier ?? null],
      );

      const out = { id, requestNumber: req.request_number, status: 'dispatched', receipts };
      await audit(client, user.id, 'supplier_request.dispatched', 'supplier_request', id, { status: req.status }, out, request.ip);
      await outbox(client, 'supplier_request.dispatched', 'supplier_request', id, out);
      await notifyByPermission(client, 'inventory:adjust', 'supplier_request.dispatched.notify', 'supplier_request', id,
        `محموله درخواست ${req.request_number} ارسال شد`,
        `کالاهای درخواست تأمین در راه انبار هستند (${receipts.length} رسید ورودی ایجاد شد).`, 'normal');
      return out;
    });
  });

  // Close after all receipts processed (admin/ops bookkeeping).
  app.post('/api/v1/supplier-requests/:id/close', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('wholesale:ops')) requirePermission(user, 'inventory:adjust');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const req = await one<{ id: string; request_number: string; supplier_id: string; status: string }>(
        client, 'SELECT * FROM supplier_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!req) throw notFound();
      if (!['received', 'dispatched'].includes(req.status)) {
        throw conflict('فقط درخواست‌های ارسال‌شده یا دریافت‌شده قابل بستن هستند.');
      }
      const openReceipts = await one<{ n: string }>(
        client, "SELECT count(*)::text AS n FROM stock_receipts WHERE supplier_request_id = $1 AND status = 'pending'", [id]);
      if (Number(openReceipts?.n ?? '0') > 0) {
        throw conflict('هنوز رسیدهای ورودی این درخواست تعیین تکلیف نشده‌اند.');
      }
      await client.query("UPDATE supplier_requests SET status = 'closed', updated_at = now() WHERE id = $1", [id]);
      const out = { id, requestNumber: req.request_number, status: 'closed' };
      await audit(client, user.id, 'supplier_request.closed', 'supplier_request', id, { status: req.status }, out, request.ip);
      await notifyUser(client, req.supplier_id, 'supplier_request.closed.notify', 'supplier_request', id,
        `درخواست ${req.request_number} بسته شد`, 'تمام اقلام درخواست تأمین دریافت و نهایی شد.', 'normal');
      return out;
    });
  });
}
