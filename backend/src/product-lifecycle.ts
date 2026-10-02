/* Product lifecycle + category profiles (Master Prompt 1 §8-§10, §15-§20, §44).
 *
 * Product Definition creates CATALOG data only — it never mutates stock.
 * The explicit lifecycle:
 *
 *   تعریف محصول → inventory_setup = 'pending' («نیازمند راه‌اندازی», shown as «—»)
 *   → راه‌اندازی (this module) → audited OPENING RECEIPTS through the canonical
 *     WMS pipelines → inventory_setup = 'configured' (zero stock now reads 0).
 *
 * «—» means the inventory profile was never configured; 0 means configured with
 * real zero stock. The distinction is backend state, not a UI trick.
 *
 * Category profiles make CATEGORY the source of truth for spec template, size
 * guide and required fields (§8). legacy product_type data stays untouched in
 * the DB (deprecated, hidden from the new flow) — compatibility, not deletion.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { audit, claimIdempotency, completeIdempotency, outbox } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { applySeriesMovement, assertWarehousePurpose, buildRecipeSnapshot } from './series-inventory.js';
import { applyRecipePieces } from './supplier-consignment.js';

const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/* ----------------------------- category profiles (§8-§10) ----------------------------- */

export type CategoryProfile = {
  id: string; category: string; spec_template_id: string | null; size_guide_id: string | null;
  allowed_sizes: string[]; required_fields: string[]; variant_attributes: string[]; active: boolean;
};

export async function categoryProfileFor(db: DbPool | DbClient, category: string): Promise<CategoryProfile | null> {
  return one<CategoryProfile>(db,
    'SELECT id, category, spec_template_id, size_guide_id, allowed_sizes, required_fields, variant_attributes, active FROM category_profiles WHERE category = $1 AND active',
    [category]);
}

/**
 * §8/§11: category-driven validation at product definition time.
 * - allowed_sizes (when configured) bound the variant matrix,
 * - required spec attributes of the category template must be present.
 * Products saved before a profile existed are untouched (no retro-breakage).
 */
export async function validateCategoryRequirements(
  db: DbPool | DbClient, category: string, specifications: Record<string, unknown>, sizes: (string | null | undefined)[],
): Promise<void> {
  const profile = await categoryProfileFor(db, category);
  if (!profile) return;
  const allowed = (profile.allowed_sizes ?? []).filter(Boolean);
  if (allowed.length) {
    const bad = sizes.find((size) => size && !allowed.includes(size));
    if (bad) throw badRequest(`سایز «${bad}» در دسته‌بندی «${category}» مجاز نیست.`);
  }
  if (profile.spec_template_id) {
    const required = await db.query<{ code: string; label: string }>(
      `SELECT a.code, a.label FROM spec_template_attributes ta
       JOIN spec_attributes a ON a.id = ta.attribute_id
       WHERE ta.template_id = $1 AND a.required AND a.active`, [profile.spec_template_id]);
    for (const attr of required.rows) {
      const value = specifications?.[attr.code];
      if (value === undefined || value === null || value === '') {
        throw badRequest(`مشخصه الزامی «${attr.label}» برای دسته‌بندی «${category}» ثبت نشده است.`);
      }
    }
  }
}

/* ----------------------------- routes ----------------------------- */

export function registerProductLifecycleRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ---------- category profiles admin ---------- */

  app.get('/api/v1/admin/category-profiles', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const rows = await pool.query(
      `SELECT cp.*, st.name AS spec_template_name, sg.name AS size_guide_name,
              (SELECT count(*)::int FROM products p WHERE p.category = cp.category) AS product_count
       FROM category_profiles cp
       LEFT JOIN spec_templates st ON st.id = cp.spec_template_id
       LEFT JOIN size_guides sg ON sg.id = cp.size_guide_id
       ORDER BY cp.category`);
    return { items: rows.rows };
  });

  app.put('/api/v1/admin/category-profiles/:category', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { category } = z.object({ category: z.string().trim().min(1).max(120) }).parse(request.params);
    const body = z.object({
      specTemplateId: z.uuid().nullable().optional(),
      sizeGuideId: z.uuid().nullable().optional(),
      allowedSizes: z.array(z.string().trim().min(1).max(40)).max(60).default([]),
      requiredFields: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
      notes: z.string().trim().max(1000).default(''),
      active: z.boolean().default(true),
    }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      if (body.specTemplateId) {
        const tpl = await one<{ id: string }>(client, 'SELECT id FROM spec_templates WHERE id = $1 AND active', [body.specTemplateId]);
        if (!tpl) throw badRequest('قالب مشخصات فنی معتبر نیست.');
      }
      if (body.sizeGuideId) {
        const guide = await one<{ id: string }>(client, "SELECT id FROM size_guides WHERE id = $1 AND status = 'active'", [body.sizeGuideId]);
        if (!guide) throw badRequest('راهنمای سایز معتبر نیست.');
      }
      const existing = await one<{ id: string }>(client, 'SELECT id FROM category_profiles WHERE category = $1', [category]);
      const id = existing?.id ?? randomUUID();
      await client.query(
        `INSERT INTO category_profiles(id, category, spec_template_id, size_guide_id, allowed_sizes, required_fields, notes, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (category) DO UPDATE SET spec_template_id = $3, size_guide_id = $4, allowed_sizes = $5,
           required_fields = $6, notes = $7, active = $8, updated_at = now()`,
        [id, category, body.specTemplateId ?? null, body.sizeGuideId ?? null,
          JSON.stringify(body.allowedSizes), JSON.stringify(body.requiredFields), body.notes, body.active, user.id]);
      await audit(client, user.id, existing ? 'category_profile.updated' : 'category_profile.created', 'category_profile', id,
        undefined, { category, specTemplateId: body.specTemplateId ?? null, sizeGuideId: body.sizeGuideId ?? null }, request.ip);
      return { id, category, updated: Boolean(existing) };
    });
    return reply.code(result.updated ? 200 : 201).send(result);
  });

  /** Studio UI reads the category schema here — product_type is NOT part of the new flow. */
  app.get('/api/v1/catalog/categories/:category/schema', async (request) => {
    await principal(request, pool, config);
    const { category } = z.object({ category: z.string().trim().min(1).max(120) }).parse(request.params);
    const profile = await categoryProfileFor(pool, category);
    if (!profile) return { category, configured: false, specFields: [], sizeGuide: null, allowedSizes: [] };
    const fields = profile.spec_template_id
      ? (await pool.query(
          `SELECT a.id, a.code, a.label, a.type, a.unit, a.required, ta.position,
                  COALESCE(json_agg(json_build_object('value', o.value, 'label', o.label) ORDER BY o.position)
                           FILTER (WHERE o.id IS NOT NULL), '[]') AS options
           FROM spec_template_attributes ta
           JOIN spec_attributes a ON a.id = ta.attribute_id AND a.active
           LEFT JOIN spec_attribute_options o ON o.attribute_id = a.id
           WHERE ta.template_id = $1
           GROUP BY a.id, a.code, a.label, a.type, a.unit, a.required, ta.position
           ORDER BY ta.position`, [profile.spec_template_id])).rows
      : [];
    const sizeGuide = profile.size_guide_id
      ? await one<{ id: string; code: string; name: string }>(pool,
          'SELECT id, code, name FROM size_guides WHERE id = $1', [profile.size_guide_id])
      : null;
    return { category, configured: true, specFields: fields, sizeGuide, allowedSizes: profile.allowed_sizes ?? [] };
  });

  /* ---------- §16: «نیازمند راه‌اندازی» read model ---------- */

  app.get('/api/v1/admin/products/needs-setup', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const rows = await pool.query(
      `SELECT p.id, p.name, p.brand, p.category, p.status, p.retail_enabled, p.wholesale_enabled,
              p.inventory_setup, p.created_at,
              (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variant_count
       FROM products p
       WHERE p.inventory_setup = 'pending' AND p.owner_type = 'kolbe' AND p.status <> 'archived'
       ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`, [query.limit, query.offset]);
    const total = await one<{ n: string }>(pool,
      `SELECT count(*)::text AS n FROM products WHERE inventory_setup = 'pending' AND owner_type = 'kolbe' AND status <> 'archived'`);
    return { items: rows.rows, total: Number(total?.n ?? 0) };
  });

  /* ---------- §44: admin «همه کالاها / آرشیو» read model (server-backed pagination/search) ---------- */

  app.get('/api/v1/admin/products', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(['all', 'active', 'archived']).default('active'),
      owner: z.enum(['all', 'kolbe', 'supplier']).default('all'),
      setup: z.enum(['all', 'pending', 'configured']).default('all'),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query ?? {});
    const where = `($1::text IS NULL OR p.name ILIKE '%' || $1 || '%' OR p.brand ILIKE '%' || $1 || '%' OR p.category ILIKE '%' || $1 || '%')
         AND ($2 = 'all' OR ($2 = 'archived' AND p.status = 'archived') OR ($2 = 'active' AND p.status <> 'archived'))
         AND ($3 = 'all' OR p.owner_type = $3)
         AND ($4 = 'all' OR p.inventory_setup = $4)`;
    const params = [query.q ?? null, query.status, query.owner, query.setup];
    const rows = await pool.query(
      `SELECT p.id, p.name, p.brand, p.category, p.status, p.owner_type, p.supplier_id, u.display_name AS supplier_name,
              p.retail_enabled, p.wholesale_enabled, p.inventory_setup, p.created_at,
              (SELECT count(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.active) AS variant_count,
              -- §16/§44: numbers are only meaningful once the profile is configured; UI shows «—» for pending.
              (SELECT COALESCE(sum(b.on_hand - b.reserved - b.damaged), 0)::int FROM stock_balances b
                 JOIN product_variants v ON v.id = b.variant_id
               WHERE v.product_id = p.id AND b.inventory_domain = 'retail') AS retail_available,
              (SELECT COALESCE(sum(s.on_hand - s.reserved), 0)::int FROM series_stock_balances s
                 JOIN series_templates t ON t.id = s.series_template_id
               WHERE t.product_id = p.id AND s.owner_type = 'kolbe') AS wholesale_series_available,
              (SELECT count(*)::int FROM supplier_offers o WHERE o.product_id = p.id AND o.status = 'active') AS active_offers
       FROM products p LEFT JOIN users u ON u.id = p.supplier_id
       WHERE ${where}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $5 OFFSET $6`, [...params, query.limit, query.offset]);
    const total = await one<{ n: string }>(pool,
      `SELECT count(*)::text AS n FROM products p WHERE ${where}`, params);
    return { items: rows.rows, total: Number(total?.n ?? 0) };
  });

  /* ---------- §17-§20: inventory setup — the ONLY bridge from definition to stock ---------- */

  const retailSetup = z.object({
    warehouseId: z.uuid(),
    mode: z.enum(['zero', 'equal', 'per_variant']),
    quantity: z.number().int().min(0).max(100000).optional(),          // equal mode
    perVariant: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(0).max(100000) })).max(200).optional(),
  }).strict();

  const wholesaleSetup = z.object({
    warehouseId: z.uuid(),
    seriesTemplateId: z.uuid(),
    seriesCount: z.number().int().min(0).max(10000),
  }).strict();

  app.post('/api/v1/admin/products/:id/inventory-setup', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'inventory:adjust');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      retail: retailSetup.optional(),
      wholesale: wholesaleSetup.optional(),
    }).strict().parse(request.body);
    if (!body.retail && !body.wholesale) throw badRequest('دست‌کم یک کانال (خرده یا عمده) باید راه‌اندازی شود.');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 120) throw badRequest('Idempotency-Key معتبر لازم است.');

    const response = await transaction(pool, async (client) => {
      const claim = await claimIdempotency(client, user.id, 'product.inventory_setup', key, requestHash({ id, body }));
      if (claim.previous) return claim.previous;

      const product = await one<{
        id: string; name: string; owner_type: string; status: string; inventory_setup: string;
        retail_enabled: boolean; wholesale_enabled: boolean;
      }>(client, 'SELECT id, name, owner_type, status, inventory_setup, retail_enabled, wholesale_enabled FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();
      // §4/§16: setup is a KOLBE lifecycle — supplier stock arrives only via consignment inbound.
      if (product.owner_type !== 'kolbe') throw forbidden('راه‌اندازی موجودی فقط برای محصولات کلبه است؛ موجودی تأمین‌کننده از مسیر ورودی امانی وارد می‌شود.');
      if (product.status === 'archived') throw conflict('محصول آرشیوشده قابل راه‌اندازی نیست.');
      if (product.inventory_setup === 'configured') throw conflict('پروفایل موجودی این محصول قبلاً راه‌اندازی شده است؛ تغییرات از عملیات عادی انبار انجام می‌شود.');

      const summary: Record<string, unknown> = {};

      if (body.retail) {
        await assertWarehousePurpose(client, body.retail.warehouseId, 'retail');
        const variants = await client.query<{ id: string; sku: string }>(
          'SELECT id, sku FROM product_variants WHERE product_id = $1 AND active ORDER BY sku', [id]);
        if (!variants.rows.length) throw badRequest('محصول هیچ واریانت فعالی ندارد.');
        let plan: Array<{ variantId: string; sku: string; quantity: number }>;
        if (body.retail.mode === 'zero') {
          plan = variants.rows.map((v) => ({ variantId: v.id, sku: v.sku, quantity: 0 }));
        } else if (body.retail.mode === 'equal') {
          if (body.retail.quantity === undefined) throw badRequest('مقدار یکسان برای همه واریانت‌ها لازم است.');
          plan = variants.rows.map((v) => ({ variantId: v.id, sku: v.sku, quantity: body.retail!.quantity! }));
        } else {
          const byId = new Map((body.retail.perVariant ?? []).map((entry) => [entry.variantId, entry.quantity]));
          const unknown = [...byId.keys()].find((vid) => !variants.rows.some((v) => v.id === vid));
          if (unknown) throw badRequest('واریانت نامعتبر در لیست مقداردهی.');
          plan = variants.rows.map((v) => ({ variantId: v.id, sku: v.sku, quantity: byId.get(v.id) ?? 0 }));
        }
        // Opening receipts through the canonical receipt document — never a silent balance UPDATE.
        for (const entry of plan) {
          await client.query(
            `INSERT INTO stock_balances(variant_id, warehouse_id, inventory_domain) VALUES ($1,$2,'retail')
             ON CONFLICT (variant_id, warehouse_id, inventory_domain) DO NOTHING`,
            [entry.variantId, body.retail.warehouseId]);
          if (entry.quantity <= 0) continue;
          const refSeq = await one<{ n: string }>(client, "SELECT nextval('receipt_reference_seq')::text AS n");
          const receiptId = randomUUID();
          await client.query(
            `INSERT INTO stock_receipts(id, reference, receipt_number, warehouse_id, variant_id, quantity, status, created_by,
               inventory_domain, received_quantity, received_at, batch_reference)
             VALUES ($1,$2,$2,$3,$4,$5,'received',$6,'retail',$5,now(),$7)`,
            [receiptId, `RCPT-${refSeq!.n}`, body.retail.warehouseId, entry.variantId, entry.quantity, user.id, `OPENING-${id.slice(0, 8)}`]);
          const updated = await client.query(
            `UPDATE stock_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
             WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = 'retail'`,
            [entry.variantId, body.retail.warehouseId, entry.quantity]);
          if (!updated.rowCount) throw conflict('خطای همزمانی در موجودی اولیه.');
          await client.query(
            `INSERT INTO stock_movements(id, variant_id, warehouse_id, inventory_domain, on_hand_delta, reason, reference_type, reference_id, actor_id, idempotency_key)
             VALUES ($1,$2,$3,'retail',$4,'موجودی اولیه (راه‌اندازی محصول)','opening_receipt',$5,$6,$7)`,
            [randomUUID(), entry.variantId, body.retail.warehouseId, entry.quantity, receiptId, user.id, `setup-retail:${id}:${entry.variantId}`]);
        }
        summary.retail = {
          mode: body.retail.mode,
          variants: plan.length,
          totalPieces: plan.reduce((sum, entry) => sum + entry.quantity, 0),
        };
      }

      if (body.wholesale) {
        await assertWarehousePurpose(client, body.wholesale.warehouseId, 'wholesale');
        const tpl = await one<{ id: string; product_id: string; color_label: string | null; active: boolean }>(client,
          'SELECT id, product_id, color_label, active FROM series_templates WHERE id = $1', [body.wholesale.seriesTemplateId]);
        if (!tpl || tpl.product_id !== id || !tpl.active) throw badRequest('قالب سری فعالِ همین محصول را انتخاب کنید.');
        const snapshot = await buildRecipeSnapshot(client, tpl.id);
        if (body.wholesale.seriesCount > 0) {
          // Pieces first (overlay guard), then the explicit intact-series receipt — one atomic document.
          await applyRecipePieces(client, snapshot, body.wholesale.warehouseId, body.wholesale.seriesCount, 1, {
            reason: `موجودی اولیه عمده: اجزای ${body.wholesale.seriesCount} سری (${snapshot.templateName})`,
            referenceType: 'opening_receipt', referenceId: id, actorId: user.id, keyPrefix: `setup-wholesale-pieces:${id}:${tpl.id}`,
          });
          await applySeriesMovement(client, {
            templateId: tpl.id, warehouseId: body.wholesale.warehouseId,
            owner: { ownerType: 'kolbe', supplierId: null },
            movementType: 'receipt', onHandDelta: body.wholesale.seriesCount,
            recipeSnapshot: snapshot, referenceType: 'opening_receipt', referenceId: id,
            note: `موجودی اولیه عمده (راه‌اندازی محصول ${product.name})`, actorId: user.id,
            idempotencyKey: `setup-series:${id}:${tpl.id}`,
          });
        }
        summary.wholesale = {
          seriesTemplateId: tpl.id, colorLabel: tpl.color_label,
          seriesCount: body.wholesale.seriesCount, piecesPerSeries: snapshot.piecesPerSeries,
          totalPieces: body.wholesale.seriesCount * snapshot.piecesPerSeries,
        };
      }

      await client.query(
        `UPDATE products SET inventory_setup = 'configured',
           retail_enabled = CASE WHEN $2::boolean THEN true ELSE retail_enabled END,
           wholesale_enabled = CASE WHEN $3::boolean THEN true ELSE wholesale_enabled END,
           updated_at = now()
         WHERE id = $1`,
        [id, Boolean(body.retail), Boolean(body.wholesale)]);
      await audit(client, user.id, 'product.inventory_setup', 'product', id, { inventory_setup: 'pending' },
        { inventory_setup: 'configured', ...summary }, request.ip);
      await outbox(client, 'product.inventory_setup', 'product', id, { productId: id, ...summary });
      const out = { id, inventorySetup: 'configured', ...summary };
      await completeIdempotency(client, user.id, 'product.inventory_setup', key, out);
      return out;
    });
    return reply.code(201).send(response);
  });
}
