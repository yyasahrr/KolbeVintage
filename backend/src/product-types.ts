import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { specFieldSchema, sizeSchema } from './profile.js';

/* Product types + sizes (docs items 4-10) and gender/season taxonomies (245-247).
   PostgreSQL is the source of truth: no hardcoded type/size lists anywhere. */

const codeField = z.string().trim().regex(/^[a-z0-9_-]{2,40}$/);
const sizeCodeField = z.string().trim().min(1).max(40);

const sizeGuideSchema = z.object({
  columns: z.array(z.string().max(40)).max(10),
  rows: z.array(z.array(z.string().max(20)).max(10)).max(40),
}).strict();
/* Union contract: Agent A's structure fields + Agent C's adaptive-form inline template fields.
   Both admin panels POST/PATCH the same paths, so one schema accepts both payload families. */
const typeBody = z.object({
  code: codeField,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(100000).default(0),
  specTemplateId: z.uuid().nullable().optional(),
  sizes: z.array(sizeSchema).max(60).default([]),
  specTemplate: z.array(specFieldSchema).max(40).default([]),
  sizeGuideTemplate: sizeGuideSchema.optional(),
}).strict();
const typePatch = z.object({
  code: codeField.optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(100000).optional(),
  specTemplateId: z.uuid().nullable().optional(),
  sizes: z.array(sizeSchema).max(60).optional(),
  specTemplate: z.array(specFieldSchema).max(40).optional(),
  sizeGuideTemplate: sizeGuideSchema.optional(),
}).strict();
const sizeBody = z.object({
  code: sizeCodeField,
  label: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(100000).default(0),
}).strict();
const sizePatch = z.object({
  code: sizeCodeField.optional(),
  label: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(100000).optional(),
}).strict();
const taxonomyBody = z.object({
  kind: z.enum(['gender', 'season']),
  code: codeField,
  label: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(100000).default(0),
}).strict();

type TypeRow = {
  id: string; code: string; name: string; description: string; active: boolean;
  position: number; spec_template_id: string | null;
  sizes?: unknown; spec_template?: unknown; size_guide_template?: unknown;
};
type SizeRow = { id: string; code: string; label: string; active: boolean; position: number };
const serializeType = (row: TypeRow, sizeRows: SizeRow[]) => {
  // Rows are canonical (they carry ids for the structure editor); jsonb-only rows (created through
  // the CMS panel before dual-write) still surface their sizes with a stable synthetic id.
  const jsonbSizes = ((row.sizes ?? []) as { code: string; label: string; active: boolean; position: number }[])
    .filter((size) => size && typeof size.code === 'string');
  const sizes = sizeRows.length
    ? sizeRows
    : jsonbSizes.map((size) => ({ id: `${row.id}:${size.code}`, code: size.code, label: size.label ?? size.code, active: size.active !== false, position: Number(size.position ?? 0) }));
  return {
    id: row.id, code: row.code, name: row.name, description: row.description,
    active: row.active, position: row.position, specTemplateId: row.spec_template_id,
    sizes,
    spec_template: (row.spec_template ?? []) as unknown,
    size_guide_template: (row.size_guide_template ?? {}) as unknown,
  };
};
const TYPE_SELECT = 'SELECT id, code, name, description, active, position, spec_template_id, sizes, spec_template, size_guide_template FROM product_types';

/** Dual-write: the inline jsonb size list (CMS panel) is mirrored into product_type_sizes rows
    (structure editor) so both product-type models stay readable. */
async function mirrorSizesToRows(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[] }> }, typeId: string, sizes: { code: string; label: string; active: boolean; position: number }[]) {
  await client.query('DELETE FROM product_type_sizes WHERE product_type_id = $1', [typeId]);
  for (const size of sizes) {
    await client.query(
      `INSERT INTO product_type_sizes(id, product_type_id, code, label, active, position)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (product_type_id, code) DO NOTHING`,
      [randomUUID(), typeId, size.code, size.label, size.active !== false, Number(size.position ?? 0)]);
  }
}

async function sizesFor(pool: DbPool, typeId: string, activeOnly: boolean) {
  const rows = await pool.query(
    `SELECT id, code, label, active, position FROM product_type_sizes
     WHERE product_type_id = $1 AND ($2::boolean = false OR active = true)
     ORDER BY position, code`, [typeId, activeOnly]);
  return rows.rows as { id: string; code: string; label: string; active: boolean; position: number }[];
}

export function registerProductTypeRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // Public: editors (admin + supplier) read live types/sizes — never a hardcoded list.
  app.get('/api/v1/product-types', async (request) => {
    const query = z.object({ active: z.enum(['true', 'false']).default('true') }).parse(request.query);
    const activeOnly = query.active === 'true';
    const rows = await pool.query<TypeRow>(
      `${TYPE_SELECT}
       WHERE ($1::boolean = false OR active = true) ORDER BY position, name`, [activeOnly]);
    const items = [];
    for (const row of rows.rows) items.push(serializeType(row, await sizesFor(pool, row.id, activeOnly)));
    return { items };
  });

  app.get('/api/v1/product-types/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one<TypeRow>(pool, `${TYPE_SELECT} WHERE id = $1`, [id]);
    if (!row) throw notFound();
    return serializeType(row, await sizesFor(pool, row.id, false));
  });

  /**
   * Product color registry (Req 30): inline color creation from Product Studio
   * persists here — colors are never local-state-only in production.
   */
  app.get('/api/v1/product-colors', async (request) => {
    const query = z.object({ active: z.enum(['true', 'false']).default('true') }).parse(request.query);
    const rows = await pool.query(
      `SELECT id, name, hex, active, position, created_at FROM product_colors
       WHERE ($1::boolean = false OR active = true) ORDER BY position, name`, [query.active === 'true']);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/product-colors', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = z.object({
      name: z.string().trim().min(1).max(80),
      hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8A6A4F'),
      position: z.number().int().min(0).max(100000).default(0),
    }).strict().parse(request.body);
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO product_colors(id,name,hex,active,position,created_by) VALUES ($1,$2,$3,true,$4,$5)',
          [id, body.name, body.hex, body.position, user.id]);
        await audit(client, user.id, 'product_color.created', 'product_color', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('رنگی با همین نام قبلاً ثبت شده است.');
      throw error;
    }
    return reply.code(201).send({ id, ...body, active: true });
  });

  app.patch('/api/v1/admin/product-colors/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      active: z.boolean().optional(),
      position: z.number().int().min(0).max(100000).optional(),
    }).strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM product_colors WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { name: 'name', hex: 'hex', active: 'active', position: 'position' };
      const sets: string[] = []; const values: unknown[] = [id];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value); sets.push(`${column} = $${values.length}`);
      }
      await client.query(`UPDATE product_colors SET ${sets.join(', ')} WHERE id = $1`, values);
      await audit(client, user.id, 'product_color.updated', 'product_color', id, before, body, request.ip);
      return one(client, 'SELECT * FROM product_colors WHERE id = $1', [id]);
    });
  });

  app.get('/api/v1/taxonomies', async (request) => {
    const query = z.object({ kind: z.enum(['gender', 'season']).optional() }).parse(request.query);
    const rows = await pool.query(
      `SELECT id, kind, code, label, active, position FROM product_taxonomies
       WHERE active = true AND ($1::text IS NULL OR kind = $1) ORDER BY kind, position, label`,
      [query.kind ?? null]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/product-types', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = typeBody.parse(request.body);
    if (body.specTemplateId) {
      const template = await one(pool, 'SELECT id FROM spec_templates WHERE id = $1', [body.specTemplateId]);
      if (!template) throw badRequest('قالب مشخصات انتخاب‌شده یافت نشد.');
    }
    if (new Set(body.specTemplate.map((f) => f.code)).size !== body.specTemplate.length) throw badRequest('کد فیلدها باید یکتا باشد.');
    if (new Set(body.sizes.map((sz) => sz.code)).size !== body.sizes.length) throw badRequest('کد سایزها باید یکتا باشد.');
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO product_types(id, code, name, description, active, position, spec_template_id, sizes, spec_template, size_guide_template)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, body.code, body.name, body.description, body.active, body.position, body.specTemplateId ?? null,
            JSON.stringify(body.sizes), JSON.stringify(body.specTemplate), JSON.stringify(body.sizeGuideTemplate ?? {})]);
        if (body.sizes.length) await mirrorSizesToRows(client, id, body.sizes);
        await audit(client, user.id, 'product_type.created', 'product_type', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد یا نام نوع محصول تکراری است.');
      throw error;
    }
    const row = await one<TypeRow>(pool, `${TYPE_SELECT} WHERE id = $1`, [id]);
    return reply.code(201).send(serializeType(row!, await sizesFor(pool, id, false)));
  });

  app.patch('/api/v1/admin/product-types/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = typePatch.parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    if (body.specTemplateId) {
      const template = await one(pool, 'SELECT id FROM spec_templates WHERE id = $1', [body.specTemplateId]);
      if (!template) throw badRequest('قالب مشخصات انتخاب‌شده یافت نشد.');
    }
    if (body.specTemplate && new Set(body.specTemplate.map((f) => f.code)).size !== body.specTemplate.length) throw badRequest('کد فیلدها باید یکتا باشد.');
    if (body.sizes && new Set(body.sizes.map((sz) => sz.code)).size !== body.sizes.length) throw badRequest('کد سایزها باید یکتا باشد.');
    return transaction(pool, async (client) => {
      const before = await one<TypeRow>(client, 'SELECT * FROM product_types WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.sizes) {
        // Agent C guard: a size already used by variants may be deactivated but never deleted.
        const removed = ((before.sizes ?? []) as { code: string }[]).filter((old) => !body.sizes!.some((n) => n.code === old.code)).map((old) => old.code);
        if (removed.length) {
          const used = await one<{ n: number }>(client, `SELECT count(*)::int AS n FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE (p.product_type_code = $1 OR p.product_type_id = $2) AND v.size_label = ANY($3::text[])`, [before.code, id, removed]);
          if (used && used.n > 0) throw conflict('سایزهای استفاده‌شده در محصولات حذف نمی‌شوند؛ آن‌ها را غیرفعال کنید.');
        }
      }
      const map: Record<string, string> = {
        name: 'name', description: 'description', active: 'active', position: 'position', specTemplateId: 'spec_template_id',
        sizes: 'sizes', specTemplate: 'spec_template', sizeGuideTemplate: 'size_guide_template',
      };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const raw = (body as Record<string, unknown>)[key];
        if (raw === undefined) continue;
        values.push(key === 'sizes' || key === 'specTemplate' || key === 'sizeGuideTemplate' ? JSON.stringify(raw) : raw);
        updates.push(`${column} = $${values.length}`);
      }
      if (body.code !== undefined && body.code !== before.code) {
        values.push(body.code);
        updates.push(`code = $${values.length}`);
        // Keep Agent C's code-based linkage (products.product_type_code) consistent with a code rename.
        await client.query('UPDATE products SET product_type_code = $2, updated_at = now() WHERE product_type_code = $1', [before.code, body.code]);
      }
      await client.query(`UPDATE product_types SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, values);
      if (body.sizes) await mirrorSizesToRows(client, id, body.sizes);
      await audit(client, user.id, 'product_type.updated', 'product_type', id, before, body, request.ip);
      const row = await one<TypeRow>(client, `${TYPE_SELECT} WHERE id = $1`, [id]);
      return serializeType(row!, await sizesFor(client as unknown as DbPool, id, false));
    });
  });

  app.delete('/api/v1/admin/product-types/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one<TypeRow>(client, 'SELECT * FROM product_types WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const used = await one<{ count: string }>(client, 'SELECT count(*)::text AS count FROM products WHERE product_type_id = $1', [id]);
      if (Number(used?.count ?? 0) > 0) throw conflict('این نوع محصول در محصولی استفاده شده است؛ ابتدا آن را غیرفعال کنید.');
      await client.query('DELETE FROM product_types WHERE id = $1', [id]);
      await audit(client, user.id, 'product_type.deleted', 'product_type', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  app.post('/api/v1/admin/product-types/:id/sizes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = sizeBody.parse(request.body);
    const type = await one(pool, 'SELECT id FROM product_types WHERE id = $1', [id]);
    if (!type) throw notFound();
    const sizeId = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO product_type_sizes(id, product_type_id, code, label, active, position)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [sizeId, id, body.code, body.label, body.active, body.position]);
        await audit(client, user.id, 'product_type.size_added', 'product_type', id, undefined, { sizeId, ...body }, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('این کد سایز در این نوع محصول تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id: sizeId, productTypeId: id, ...body });
  });

  app.patch('/api/v1/admin/product-types/:id/sizes/:sizeId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), sizeId: z.uuid() }).parse(request.params);
    const body = sizePatch.parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one<{ id: string; code: string; label: string; active: boolean; position: number }>(client,
        'SELECT id, code, label, active, position FROM product_type_sizes WHERE id = $1 AND product_type_id = $2 FOR UPDATE',
        [params.sizeId, params.id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { code: 'code', label: 'label', active: 'active', position: 'position' };
      const values: unknown[] = [params.sizeId];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
      try {
        await client.query(`UPDATE product_type_sizes SET ${updates.join(', ')} WHERE id = $1`, values);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('این کد سایز در این نوع محصول تکراری است.');
        throw error;
      }
      await audit(client, user.id, 'product_type.size_updated', 'product_type', params.id, before, body, request.ip);
      return { productTypeId: params.id, ...before, ...body, id: params.sizeId };
    });
  });

  app.post('/api/v1/admin/product-types/:id/sizes/reorder', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ sizeIds: z.array(z.uuid()).min(1).max(500) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const type = await one(client, 'SELECT id FROM product_types WHERE id = $1', [id]);
      if (!type) throw notFound();
      const existing = await client.query('SELECT id FROM product_type_sizes WHERE product_type_id = $1', [id]);
      const known = new Set(existing.rows.map((row: { id: string }) => row.id));
      if (body.sizeIds.length !== known.size || !body.sizeIds.every((sizeId) => known.has(sizeId)))
        throw badRequest('فهرست سایزها باید دقیقاً شامل همه سایزهای این نوع محصول باشد.');
      for (const [index, sizeId] of body.sizeIds.entries()) {
        await client.query('UPDATE product_type_sizes SET position = $2 WHERE id = $1', [sizeId, index + 1]);
      }
      await audit(client, user.id, 'product_type.sizes_reordered', 'product_type', id, undefined, { count: body.sizeIds.length }, request.ip);
      return { productTypeId: id, ordered: body.sizeIds.length };
    });
  });

  app.delete('/api/v1/admin/product-types/:id/sizes/:sizeId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), sizeId: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one<{ id: string; code: string }>(client,
        'SELECT id, code FROM product_type_sizes WHERE id = $1 AND product_type_id = $2 FOR UPDATE',
        [params.sizeId, params.id]);
      if (!before) throw notFound();
      const used = await one<{ count: string }>(client,
        `SELECT count(*)::text AS count FROM product_variants v JOIN products p ON p.id = v.product_id
         WHERE p.product_type_id = $1 AND v.size_label = $2`, [params.id, before.code]);
      if (Number(used?.count ?? 0) > 0) throw conflict('این سایز در واریانتی استفاده شده است؛ به‌جای حذف، آن را غیرفعال کنید.');
      await client.query('DELETE FROM product_type_sizes WHERE id = $1', [params.sizeId]);
      await audit(client, user.id, 'product_type.size_deleted', 'product_type', params.id, before, undefined, request.ip);
      return { id: params.sizeId, deleted: true };
    });
  });

  app.post('/api/v1/admin/taxonomies', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = taxonomyBody.parse(request.body);
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO product_taxonomies(id, kind, code, label, active, position) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, body.kind, body.code, body.label, body.active, body.position]);
        await audit(client, user.id, 'taxonomy.created', 'product_taxonomy', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('این کد طبقه‌بندی تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/taxonomies/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      label: z.string().trim().min(1).max(80).optional(),
      active: z.boolean().optional(),
      position: z.number().int().min(0).max(100000).optional(),
    }).strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM product_taxonomies WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { label: 'label', active: 'active', position: 'position' };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
      await client.query(`UPDATE product_taxonomies SET ${updates.join(', ')} WHERE id = $1`, values);
      await audit(client, user.id, 'taxonomy.updated', 'product_taxonomy', id, before, body, request.ip);
      return { id, ...body };
    });
  });

  app.get('/api/v1/admin/taxonomies', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const rows = await pool.query('SELECT id, kind, code, label, active, position FROM product_taxonomies ORDER BY kind, position, label');
    return { items: rows.rows };
  });
}
