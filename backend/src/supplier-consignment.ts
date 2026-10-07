/* Supplier Stock-at-Kolbe (Master Prompt 1 §23-§27, §35, §37, §39, §50).
 *
 * Model B: the supplier parks REAL goods inside the Central Wholesale Warehouse
 * before any order exists. Kolbe is custodian, the supplier stays OWNER —
 * balances live in series_stock_balances with owner_type='supplier' (first-class
 * ownership, §49), never mixed into Kolbe numbers.
 *
 * Advance inbound workflow (§26):
 *   supplier request → admin approval (capacity/eligibility — NOT marketplace
 *   approval) → supplier dispatch (incoming) → warehouse receive (discrepancy
 *   recorded, §27) → QC (partial pass) → ONLY passed series become verified
 *   supplier stock. Rejected series land in the damaged bucket; shortage is a
 *   recorded discrepancy, it never disappears.
 *
 * Every stock mutation goes through applySeriesMovement (atomic, idempotent,
 * append-only ledger) + piece-level stock_movements for the overlay guard —
 * no parallel inventory system.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission, type Principal } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit, notifyByPermission, outbox } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import {
  applySeriesMovement, assertWarehousePurpose, buildRecipeSnapshot, seriesBalanceForUpdate, type RecipeSnapshot,
} from './series-inventory.js';

/* ----------------------------- shared helpers ----------------------------- */

/** Piece-level bookkeeping of the same physical goods (overlay model, §53-062). */
export async function applyPieceDelta(client: DbClient, input: {
  variantId: string; warehouseId: string; onHandDelta: number; reason: string;
  referenceType: string; referenceId: string; actorId: string; idempotencyKey: string;
}) {
  await client.query(
    `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain) VALUES ($1,$2,'wholesale')
     ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
    [input.variantId, input.warehouseId]);
  const updated = await client.query(
    `UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
     WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'wholesale' AND on_hand + $3 >= reserved + damaged`,
    [input.variantId, input.warehouseId, input.onHandDelta]);
  if (!updated.rowCount) throw conflict('موجودی عددی اجزا برای این عملیات کافی نیست.');
  await client.query(
    `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
     VALUES ($1,$2,$3,'wholesale',$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING`,
    [randomUUID(), input.variantId, input.warehouseId, input.onHandDelta, input.reason,
      input.referenceType, input.referenceId, input.actorId, input.idempotencyKey]);
}

export async function applyRecipePieces(client: DbClient, snapshot: RecipeSnapshot, warehouseId: string, seriesCount: number, dir: 1 | -1, input: {
  reason: string; referenceType: string; referenceId: string; actorId: string; keyPrefix: string;
}) {
  for (const item of snapshot.items) {
    await applyPieceDelta(client, {
      variantId: item.variantId, warehouseId,
      onHandDelta: dir * item.quantityPerSeries * seriesCount,
      reason: input.reason, referenceType: input.referenceType, referenceId: input.referenceId,
      actorId: input.actorId, idempotencyKey: `${input.keyPrefix}:${item.variantId}`,
    });
  }
}

type InboundRow = {
  id: string; reference: string; supplier_id: string; product_id: string; series_template_id: string;
  color_label: string | null; warehouse_id: string | null; expected_series: number;
  received_series: number | null; qc_passed_series: number | null; qc_rejected_series: number | null;
  shortage_series: number | null; status: string; recipe_snapshot: RecipeSnapshot | null;
  batch_reference: string | null; carrier: string | null; note: string; rejection_reason: string | null;
  created_at: string;
};

async function inboundForUpdate(client: DbClient, id: string): Promise<InboundRow> {
  const row = await one<InboundRow>(client, 'SELECT * FROM supplier_series_inbounds WHERE id = $1 FOR UPDATE', [id]);
  if (!row) throw notFound();
  return row;
}

/* ----------------------------- routes ----------------------------- */

export function registerSupplierConsignmentRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const isSupplier = (user: Principal) => user.roles.includes('supplier');

  /** §26 step 1 — supplier requests to send stock to Kolbe (series unit). */
  app.post('/api/v1/supplier/inbounds', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!isSupplier(user)) throw forbidden();
    const body = z.object({
      productId: z.uuid(),
      seriesTemplateId: z.uuid(),
      expectedSeries: z.number().int().min(1).max(10000),
      note: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().trim().min(8).max(120).optional(),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      if (body.idempotencyKey) {
        const dupe = await one<{ id: string; reference: string }>(client,
          'SELECT id, reference FROM supplier_series_inbounds WHERE idempotency_key = $1', [body.idempotencyKey]);
        if (dupe) return { ...dupe, duplicate: true as const };
      }
      const product = await one<{ id: string; supplier_id: string | null; owner_type: string; status: string }>(client,
        'SELECT id, supplier_id, owner_type, status FROM products WHERE id = $1', [body.productId]);
      if (!product) throw notFound();
      if (product.owner_type !== 'supplier' || product.supplier_id !== user.id) {
        throw forbidden('فقط برای محصولات خودتان می‌توانید درخواست ارسال موجودی ثبت کنید.'); // IDOR guard
      }
      if (!['published', 'pending'].includes(product.status)) {
        throw badRequest('برای محصول آرشیو/ردشده نمی‌توان درخواست ارسال موجودی ثبت کرد.');
      }
      const tpl = await one<{ id: string; product_id: string; color_label: string | null; active: boolean }>(client,
        'SELECT id, product_id, color_label, active FROM series_templates WHERE id = $1', [body.seriesTemplateId]);
      if (!tpl || tpl.product_id !== body.productId || !tpl.active) throw badRequest('قالب سری معتبر این محصول را انتخاب کنید.');
      const seq = await one<{ n: string }>(client, "SELECT nextval('supplier_inbound_seq')::text AS n");
      const id = randomUUID();
      const reference = `SIN-${seq!.n}`;
      await client.query(
        `INSERT INTO supplier_series_inbounds(id, reference, supplier_id, product_id, series_template_id, color_label,
           expected_series, note, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, reference, user.id, body.productId, body.seriesTemplateId, tpl.color_label,
          body.expectedSeries, body.note ?? '', body.idempotencyKey ?? null]);
      await audit(client, user.id, 'supplier_inbound.requested', 'supplier_inbound', id,
        undefined, { reference, expectedSeries: body.expectedSeries, seriesTemplateId: body.seriesTemplateId }, request.ip);
      await outbox(client, 'supplier_inbound.requested', 'supplier_inbound', id, { id, reference });
      await notifyByPermission(client, 'wholesale:ops', 'supplier_inbound.requested.notify', 'supplier_inbound', id,
        `درخواست ارسال موجودی ${reference}`, `تأمین‌کننده درخواست ارسال ${body.expectedSeries} سری به انبار کلبه را ثبت کرد.`, 'normal');
      return { id, reference };
    });
    return reply.code('duplicate' in result ? 200 : 201).send(result);
  });

  /** Lists: supplier sees own; admin (wholesale:ops) sees all. */
  app.get('/api/v1/supplier/inbounds', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      status: z.string().trim().max(30).optional(),
      supplierId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const admin = user.permissions.includes('wholesale:ops');
    if (!admin && !isSupplier(user)) throw forbidden();
    const supplierId = admin ? (query.supplierId ?? null) : user.id;
    const where: string[] = []; const params: unknown[] = [];
    if (supplierId) { params.push(supplierId); where.push(`i.supplier_id = $${params.length}`); }
    if (query.status) { params.push(query.status); where.push(`i.status = $${params.length}`); }
    params.push(query.limit, query.offset);
    const rows = await pool.query(
      `SELECT i.*, p.name AS product_name, t.name AS series_template_name, u.display_name AS supplier_name,
              w.name AS warehouse_name
       FROM supplier_series_inbounds i
       JOIN products p ON p.id = i.product_id
       JOIN series_templates t ON t.id = i.series_template_id
       JOIN users u ON u.id = i.supplier_id
       LEFT JOIN warehouses w ON w.id = i.warehouse_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  /** §26 step 2 — warehouse/admin review (capacity/eligibility approval, NOT marketplace review). */
  app.post('/api/v1/admin/supplier-inbounds/:id/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      decision: z.enum(['approve', 'reject']),
      warehouseId: z.uuid().optional(),
      reason: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const inbound = await inboundForUpdate(client, id);
      if (inbound.status !== 'requested') throw conflict('فقط درخواست‌های در انتظار بررسی قابل تصمیم‌گیری هستند.');
      if (body.decision === 'reject') {
        if (!body.reason || body.reason.trim().length < 3) throw badRequest('برای رد درخواست، دلیل الزامی است.');
        await client.query(
          `UPDATE supplier_series_inbounds SET status = 'rejected', rejection_reason = $2, reviewed_by = $3, updated_at = now() WHERE id = $1`,
          [id, body.reason.trim(), user.id]);
        await audit(client, user.id, 'supplier_inbound.rejected', 'supplier_inbound', id,
          { status: inbound.status }, { reason: body.reason.trim() }, request.ip);
        return { id, status: 'rejected' };
      }
      if (!body.warehouseId) throw badRequest('انبار مقصد (انبار مرکزی عمده) الزامی است.');
      const warehouse = await assertWarehousePurpose(client, body.warehouseId, 'wholesale');
      const snapshot = await buildRecipeSnapshot(client, inbound.series_template_id);
      await client.query(
        `UPDATE supplier_series_inbounds SET status = 'approved', warehouse_id = $2, recipe_snapshot = $3,
           reviewed_by = $4, approved_at = now(), updated_at = now() WHERE id = $1`,
        [id, warehouse.id, JSON.stringify(snapshot), user.id]);
      await audit(client, user.id, 'supplier_inbound.approved', 'supplier_inbound', id,
        { status: inbound.status }, { warehouseId: warehouse.id }, request.ip);
      await outbox(client, 'supplier_inbound.approved', 'supplier_inbound', id, { id, reference: inbound.reference });
      return { id, status: 'approved', warehouseId: warehouse.id };
    });
  });

  /** §26 step 3 — supplier dispatches: series go «در راه» (incoming, owner=supplier). */
  app.post('/api/v1/supplier/inbounds/:id/dispatch', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      batchReference: z.string().trim().max(120).optional(),
      carrier: z.string().trim().max(120).optional(),
    }).strict().parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const inbound = await inboundForUpdate(client, id);
      const privileged = user.permissions.includes('wholesale:ops');
      if (!privileged && inbound.supplier_id !== user.id) throw forbidden(); // IDOR guard
      if (inbound.status !== 'approved') throw conflict('فقط درخواست تأییدشده قابل ارسال است.');
      await applySeriesMovement(client, {
        templateId: inbound.series_template_id, warehouseId: inbound.warehouse_id!,
        owner: { ownerType: 'supplier', supplierId: inbound.supplier_id },
        movementType: 'incoming', incomingDelta: inbound.expected_series,
        recipeSnapshot: inbound.recipe_snapshot, referenceType: 'supplier_inbound', referenceId: id,
        note: `ارسال محموله ${inbound.reference} از تأمین‌کننده`, actorId: user.id,
        idempotencyKey: `ssi-dispatch:${id}`,
      });
      await client.query(
        `UPDATE supplier_series_inbounds SET status = 'dispatched', batch_reference = $2, carrier = $3,
           dispatched_at = now(), updated_at = now() WHERE id = $1`,
        [id, body.batchReference ?? null, body.carrier ?? null]);
      await audit(client, user.id, 'supplier_inbound.dispatched', 'supplier_inbound', id,
        { status: inbound.status }, { batchReference: body.batchReference ?? null }, request.ip);
      return { id, status: 'dispatched' };
    });
  });

  /** §27 step 4 — warehouse receive with discrepancy capture (shortage never disappears). */
  app.post('/api/v1/admin/supplier-inbounds/:id/receive', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      receivedSeries: z.number().int().min(0).max(10000),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const inbound = await inboundForUpdate(client, id);
      if (inbound.status !== 'dispatched') throw conflict('فقط محموله ارسال‌شده قابل دریافت است (دریافت تکراری مسدود).');
      if (body.receivedSeries > inbound.expected_series) {
        throw badRequest('تعداد دریافتی نمی‌تواند از تعداد اعلامی بیشتر باشد.');
      }
      const shortage = inbound.expected_series - body.receivedSeries;
      // Incoming is settled — arrived goods wait in QC, nothing touches on_hand yet.
      await applySeriesMovement(client, {
        templateId: inbound.series_template_id, warehouseId: inbound.warehouse_id!,
        owner: { ownerType: 'supplier', supplierId: inbound.supplier_id },
        movementType: 'incoming_receive', incomingDelta: -inbound.expected_series,
        recipeSnapshot: inbound.recipe_snapshot, referenceType: 'supplier_inbound', referenceId: id,
        note: `دریافت محموله ${inbound.reference}: ${body.receivedSeries} از ${inbound.expected_series} سری${shortage ? ` (کسری ${shortage})` : ''}`,
        actorId: user.id, idempotencyKey: `ssi-receive:${id}`,
      });
      await client.query(
        `UPDATE supplier_series_inbounds SET status = 'received', received_series = $2, shortage_series = $3,
           received_at = now(), updated_at = now() WHERE id = $1`,
        [id, body.receivedSeries, shortage]);
      await audit(client, user.id, 'supplier_inbound.received', 'supplier_inbound', id,
        { expected: inbound.expected_series }, { received: body.receivedSeries, shortage }, request.ip);
      if (shortage > 0) {
        await outbox(client, 'supplier_inbound.discrepancy', 'supplier_inbound', id,
          { id, reference: inbound.reference, shortage });
      }
      return { id, status: 'received', receivedSeries: body.receivedSeries, shortageSeries: shortage };
    });
  });

  /** §27 step 5 — QC: ONLY passed series become verified supplier stock; rejected → damaged bucket. */
  app.post('/api/v1/admin/supplier-inbounds/:id/qc', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      passedSeries: z.number().int().min(0).max(10000),
      rejectedSeries: z.number().int().min(0).max(10000),
      note: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const inbound = await inboundForUpdate(client, id);
      if (inbound.status !== 'received') throw conflict('کنترل کیفیت فقط پس از دریافت و فقط یک بار انجام می‌شود.');
      const received = inbound.received_series ?? 0;
      if (body.passedSeries + body.rejectedSeries !== received) {
        throw badRequest(`جمع قبول و رد QC باید دقیقاً برابر تعداد دریافتی (${received}) باشد.`);
      }
      const snapshot = inbound.recipe_snapshot ?? await buildRecipeSnapshot(client, inbound.series_template_id);
      if (body.passedSeries > 0) {
        // Verified supplier-owned stock: series receipt + piece credits (overlay guard).
        await applyRecipePieces(client, snapshot, inbound.warehouse_id!, body.passedSeries, 1, {
          reason: `QC محموله ${inbound.reference}: ورود اجزای ${body.passedSeries} سری تأییدشده (مالکیت تأمین‌کننده)`,
          referenceType: 'supplier_inbound', referenceId: id, actorId: user.id, keyPrefix: `ssi-qc-pieces:${id}`,
        });
        await applySeriesMovement(client, {
          templateId: inbound.series_template_id, warehouseId: inbound.warehouse_id!,
          owner: { ownerType: 'supplier', supplierId: inbound.supplier_id },
          movementType: 'receipt', onHandDelta: body.passedSeries,
          recipeSnapshot: snapshot, referenceType: 'supplier_inbound', referenceId: id,
          note: `QC محموله ${inbound.reference}: ${body.passedSeries} سری تأیید شد`,
          actorId: user.id, idempotencyKey: `ssi-qc-pass:${id}`,
        });
      }
      if (body.rejectedSeries > 0) {
        // Rejected series are quarantined in the damaged bucket — never sellable, never lost.
        await applySeriesMovement(client, {
          templateId: inbound.series_template_id, warehouseId: inbound.warehouse_id!,
          owner: { ownerType: 'supplier', supplierId: inbound.supplier_id },
          movementType: 'qc_reject', damagedDelta: body.rejectedSeries,
          recipeSnapshot: snapshot, referenceType: 'supplier_inbound', referenceId: id,
          note: `QC محموله ${inbound.reference}: ${body.rejectedSeries} سری رد شد (قرنطینه)`,
          actorId: user.id, idempotencyKey: `ssi-qc-reject:${id}`,
        });
      }
      await client.query(
        `UPDATE supplier_series_inbounds SET status = 'qc_completed', qc_passed_series = $2, qc_rejected_series = $3,
           qc_at = now(), updated_at = now() WHERE id = $1`,
        [id, body.passedSeries, body.rejectedSeries]);
      await audit(client, user.id, 'supplier_inbound.qc_completed', 'supplier_inbound', id,
        { received }, { passed: body.passedSeries, rejected: body.rejectedSeries }, request.ip);
      await outbox(client, 'supplier_inbound.qc_completed', 'supplier_inbound', id,
        { id, reference: inbound.reference, passed: body.passedSeries, rejected: body.rejectedSeries });
      return { id, status: 'qc_completed', qcPassedSeries: body.passedSeries, qcRejectedSeries: body.rejectedSeries };
    });
  });

  /** Cancel while still requested/approved (supplier own or admin). */
  app.post('/api/v1/supplier/inbounds/:id/cancel', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const inbound = await inboundForUpdate(client, id);
      const privileged = user.permissions.includes('wholesale:ops');
      if (!privileged && inbound.supplier_id !== user.id) throw forbidden();
      if (!['requested', 'approved'].includes(inbound.status)) {
        throw conflict('پس از ارسال فیزیکی، لغو ممکن نیست؛ مسیر دریافت/QC را کامل کنید.');
      }
      await client.query(
        `UPDATE supplier_series_inbounds SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'supplier_inbound.cancelled', 'supplier_inbound', id,
        { status: inbound.status }, { status: 'cancelled' }, request.ip);
      return { id, status: 'cancelled' };
    });
  });

  /* -------------------- §35/§43: supplier stock-at-kolbe read model -------------------- */

  app.get('/api/v1/admin/supplier-stock', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      supplierId: z.uuid().optional(),
      warehouseId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const admin = user.permissions.includes('wholesale:ops') || user.permissions.includes('inventory:read');
    // Suppliers may read ONLY their own consigned stock.
    const supplierScope = admin ? (query.supplierId ?? null) : (user.roles.includes('supplier') ? user.id : null);
    if (!admin && !supplierScope) throw forbidden();
    const where: string[] = ["b.owner_type = 'supplier'"]; const params: unknown[] = [];
    if (supplierScope) { params.push(supplierScope); where.push(`b.supplier_id = $${params.length}`); }
    if (query.warehouseId) { params.push(query.warehouseId); where.push(`b.warehouse_id = $${params.length}`); }
    params.push(query.limit, query.offset);
    const rows = await pool.query(
      `SELECT b.series_template_id, b.warehouse_id, b.supplier_id, b.on_hand, b.reserved, b.damaged,
              (b.on_hand - b.reserved) AS available, b.updated_at,
              t.name AS series_template_name, t.color_label, p.id AS product_id, p.name AS product_name,
              u.display_name AS supplier_name, w.name AS warehouse_name,
              (SELECT max(m.created_at) FROM series_stock_movements m
                WHERE m.series_template_id = b.series_template_id AND m.warehouse_id = b.warehouse_id
                  AND m.owner_type = 'supplier' AND m.supplier_id = b.supplier_id AND m.movement_type = 'receipt') AS last_receipt_at
       FROM series_stock_balances b
       JOIN series_templates t ON t.id = b.series_template_id
       JOIN products p ON p.id = t.product_id
       JOIN users u ON u.id = b.supplier_id
       JOIN warehouses w ON w.id = b.warehouse_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.display_name, p.name LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  /* -------------------- §37: supplier stored-stock return -------------------- */

  app.post('/api/v1/supplier/stock-returns', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!isSupplier(user)) throw forbidden();
    const body = z.object({
      seriesTemplateId: z.uuid(),
      warehouseId: z.uuid(),
      seriesCount: z.number().int().min(1).max(10000),
      note: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().trim().min(8).max(120).optional(),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      if (body.idempotencyKey) {
        const dupe = await one<{ id: string; reference: string }>(client,
          'SELECT id, reference FROM supplier_stock_returns WHERE idempotency_key = $1', [body.idempotencyKey]);
        if (dupe) return { ...dupe, duplicate: true as const };
      }
      // Validate against the supplier's OWN available (on_hand - reserved) — reserved is never returnable.
      const balance = await seriesBalanceForUpdate(client, body.seriesTemplateId, body.warehouseId,
        { ownerType: 'supplier', supplierId: user.id });
      const available = balance.on_hand - balance.reserved;
      if (body.seriesCount > available) {
        throw conflict(`حداکثر ${available} سری قابل بازپس‌گیری است (رزروشده‌ها قابل بازپس‌گیری نیستند).`);
      }
      const snapshot = await buildRecipeSnapshot(client, body.seriesTemplateId);
      const seq = await one<{ n: string }>(client, "SELECT nextval('supplier_return_seq')::text AS n");
      const id = randomUUID();
      const reference = `SRT-${seq!.n}`;
      await client.query(
        `INSERT INTO supplier_stock_returns(id, reference, supplier_id, series_template_id, warehouse_id,
           series_count, recipe_snapshot, note, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, reference, user.id, body.seriesTemplateId, body.warehouseId, body.seriesCount,
          JSON.stringify(snapshot), body.note ?? '', body.idempotencyKey ?? null]);
      await audit(client, user.id, 'supplier_return.requested', 'supplier_return', id,
        undefined, { reference, seriesCount: body.seriesCount }, request.ip);
      await notifyByPermission(client, 'wholesale:ops', 'supplier_return.requested.notify', 'supplier_return', id,
        `درخواست بازپس‌گیری ${reference}`, `تأمین‌کننده درخواست خروج ${body.seriesCount} سری از انبار کلبه را ثبت کرد.`, 'normal');
      return { id, reference };
    });
    return reply.code('duplicate' in result ? 200 : 201).send(result);
  });

  app.get('/api/v1/supplier/stock-returns', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      status: z.string().trim().max(30).optional(), supplierId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const admin = user.permissions.includes('wholesale:ops');
    if (!admin && !isSupplier(user)) throw forbidden();
    const supplierId = admin ? (query.supplierId ?? null) : user.id;
    const where: string[] = []; const params: unknown[] = [];
    if (supplierId) { params.push(supplierId); where.push(`r.supplier_id = $${params.length}`); }
    if (query.status) { params.push(query.status); where.push(`r.status = $${params.length}`); }
    params.push(query.limit, query.offset);
    const rows = await pool.query(
      `SELECT r.*, t.name AS series_template_name, t.color_label, p.name AS product_name,
              u.display_name AS supplier_name, w.name AS warehouse_name
       FROM supplier_stock_returns r
       JOIN series_templates t ON t.id = r.series_template_id
       JOIN products p ON p.id = t.product_id
       JOIN users u ON u.id = r.supplier_id
       JOIN warehouses w ON w.id = r.warehouse_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY r.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { items: rows.rows };
  });

  /** Admin decision + physical completion. Completion debits series + pieces atomically. */
  app.post('/api/v1/admin/supplier-returns/:id/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'wholesale:ops');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      decision: z.enum(['approve', 'reject', 'complete']),
      reason: z.string().trim().max(500).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const row = await one<{
        id: string; reference: string; supplier_id: string; series_template_id: string; warehouse_id: string;
        series_count: number; status: string; recipe_snapshot: RecipeSnapshot | null;
      }>(client, 'SELECT * FROM supplier_stock_returns WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw notFound();
      if (body.decision === 'reject') {
        if (row.status !== 'requested') throw conflict('فقط درخواست در انتظار بررسی قابل رد است.');
        if (!body.reason || body.reason.trim().length < 3) throw badRequest('برای رد درخواست، دلیل الزامی است.');
        await client.query(`UPDATE supplier_stock_returns SET status = 'rejected', rejection_reason = $2, reviewed_by = $3, updated_at = now() WHERE id = $1`,
          [id, body.reason.trim(), user.id]);
        await audit(client, user.id, 'supplier_return.rejected', 'supplier_return', id, { status: row.status }, { reason: body.reason.trim() }, request.ip);
        return { id, status: 'rejected' };
      }
      if (body.decision === 'approve') {
        if (row.status !== 'requested') throw conflict('فقط درخواست در انتظار بررسی قابل تأیید است.');
        await client.query(`UPDATE supplier_stock_returns SET status = 'approved', reviewed_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, user.id]);
        await audit(client, user.id, 'supplier_return.approved', 'supplier_return', id, { status: row.status }, { status: 'approved' }, request.ip);
        return { id, status: 'approved' };
      }
      // complete: pick + outbound — stock leaves the building.
      if (row.status !== 'approved') throw conflict('ابتدا درخواست باید تأیید شود.');
      const snapshot = row.recipe_snapshot ?? await buildRecipeSnapshot(client, row.series_template_id);
      // applySeriesMovement enforces reserved <= on_hand, so reserved series can never leave.
      await applySeriesMovement(client, {
        templateId: row.series_template_id, warehouseId: row.warehouse_id,
        owner: { ownerType: 'supplier', supplierId: row.supplier_id },
        movementType: 'return_out', onHandDelta: -row.series_count,
        recipeSnapshot: snapshot, referenceType: 'supplier_return', referenceId: id,
        note: `بازپس‌گیری ${row.series_count} سری توسط تأمین‌کننده (${row.reference})`,
        actorId: user.id, idempotencyKey: `srt-complete:${id}`,
      });
      await applyRecipePieces(client, snapshot, row.warehouse_id, row.series_count, -1, {
        reason: `خروج اجزای ${row.series_count} سری بازپس‌گرفته‌شده (${row.reference})`,
        referenceType: 'supplier_return', referenceId: id, actorId: user.id, keyPrefix: `srt-pieces:${id}`,
      });
      await client.query(`UPDATE supplier_stock_returns SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await audit(client, user.id, 'supplier_return.completed', 'supplier_return', id,
        { status: row.status }, { seriesCount: row.series_count }, request.ip);
      await outbox(client, 'supplier_return.completed', 'supplier_return', id, { id, reference: row.reference });
      return { id, status: 'completed' };
    });
  });

  /* -------------------- §50: STOCK-level ownership conversion -------------------- */

  app.post('/api/v1/admin/inventory/series-ownership-conversions', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.permissions.includes('inventory:ownership') && !user.permissions.includes('inventory:adjust')) {
      throw forbidden('شما مجوز ثبت انتقال مالکیت موجودی را ندارید.');
    }
    const body = z.object({
      seriesTemplateId: z.uuid(),
      warehouseId: z.uuid(),
      supplierId: z.uuid(),
      seriesCount: z.number().int().min(1).max(10000),
      unitCostRial: z.string().regex(/^\d+$/).optional(),
      note: z.string().trim().max(500).optional(),
      idempotencyKey: z.string().trim().min(8).max(120),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const dupe = await one<{ id: string }>(client,
        `SELECT id FROM series_stock_movements WHERE idempotency_key = $1`, [`own-conv-out:${body.idempotencyKey}`]);
      if (dupe) return { duplicate: true as const };
      const tpl = await one<{ id: string; product_id: string }>(client,
        'SELECT id, product_id FROM series_templates WHERE id = $1', [body.seriesTemplateId]);
      if (!tpl) throw notFound();
      const snapshot = await buildRecipeSnapshot(client, body.seriesTemplateId);
      // Debit the supplier scope (only AVAILABLE stock converts — reserved stays protected).
      await applySeriesMovement(client, {
        templateId: body.seriesTemplateId, warehouseId: body.warehouseId,
        owner: { ownerType: 'supplier', supplierId: body.supplierId },
        movementType: 'conversion_out', onHandDelta: -body.seriesCount,
        recipeSnapshot: snapshot, referenceType: 'ownership_conversion',
        note: body.note ?? 'انتقال مالکیت به کلبه', actorId: user.id,
        idempotencyKey: `own-conv-out:${body.idempotencyKey}`,
      });
      // Credit the kolbe scope — same warehouse, same physical goods, new owner.
      await applySeriesMovement(client, {
        templateId: body.seriesTemplateId, warehouseId: body.warehouseId,
        owner: { ownerType: 'kolbe', supplierId: null },
        movementType: 'conversion_in', onHandDelta: body.seriesCount,
        recipeSnapshot: snapshot, referenceType: 'ownership_conversion',
        note: body.note ?? 'تملک موجودی تأمین‌کننده', actorId: user.id,
        idempotencyKey: `own-conv-in:${body.idempotencyKey}`,
      });
      const seq = await one<{ n: string }>(client, "SELECT nextval('ownership_conversion_seq')::text AS n");
      const conversionId = randomUUID();
      const reference = `OWN-${seq!.n}`;
      const unitCost = body.unitCostRial ? BigInt(body.unitCostRial) : null;
      await client.query(
        `INSERT INTO ownership_conversions(
           id, reference, conversion_number, product_id, from_owner_type, to_owner_type, supplier_id,
           conversion_type, unit_cost_rial, total_cost_rial, quantity, notes, note, status,
           converted_by, actor_id, approved_by, completed_by, approved_at, completed_at,
           series_template_id, warehouse_id, series_count)
         VALUES ($1,$2,$2,$3,'supplier','kolbe',$4,'series_stock',$5,$6,$7,$8,$8,'completed',$9,$9,$9,$9,now(),now(),$10,$11,$12)`,
        [conversionId, reference, tpl.product_id, body.supplierId,
          unitCost?.toString() ?? null, unitCost !== null ? (unitCost * BigInt(body.seriesCount)).toString() : '0',
          body.seriesCount, body.note ?? '', user.id, body.seriesTemplateId, body.warehouseId, body.seriesCount]);
      await audit(client, user.id, 'ownership_conversion.series_stock', 'ownership_conversion', conversionId,
        { ownerType: 'supplier', supplierId: body.supplierId },
        { ownerType: 'kolbe', seriesCount: body.seriesCount, reference }, request.ip);
      await outbox(client, 'ownership_conversion.completed', 'ownership_conversion', conversionId,
        { conversionId, reference, seriesCount: body.seriesCount });
      return { id: conversionId, reference };
    });
    return reply.code('duplicate' in result ? 200 : 201).send(result);
  });
}
