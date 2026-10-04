import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Dynamic product specifications (docs items 122-128) and size guides (129-134).
   Attributes/templates/guides live in PostgreSQL; the editor renders whatever
   the API returns — no hardcoded spec or size-chart tables in the frontend. */

const attributeType = z.enum(['text', 'textarea', 'number', 'decimal', 'boolean', 'single_select', 'multi_select', 'color', 'date', 'measurement', 'file', 'image', 'video', 'url']);
type AttributeType = z.infer<typeof attributeType>;

const attributeBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,60}$/),
  label: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  type: attributeType,
  unit: z.string().trim().max(40).nullable().optional(),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
  filterable: z.boolean().default(false),
  scope: z.enum(['product', 'variant']).default('product'),
  position: z.number().int().min(0).max(100000).default(0),
  validation: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().default(true),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(120),
    position: z.number().int().min(0).max(100000).default(0),
  })).max(500).default([]),
}).strict();

type AttributeRow = {
  id: string; code: string; label: string; description: string; type: AttributeType;
  unit: string | null; required: boolean; searchable: boolean; filterable: boolean;
  scope: 'product' | 'variant'; position: number; validation: Record<string, unknown>; active: boolean;
};
type OptionRow = { id: string; value: string; label: string; position: number };

async function optionsFor(pool: DbPool, attributeId: string): Promise<OptionRow[]> {
  const rows = await pool.query<OptionRow>(
    'SELECT id, value, label, position FROM spec_attribute_options WHERE attribute_id = $1 ORDER BY position, label', [attributeId]);
  return rows.rows;
}

async function attributeDetail(pool: DbPool, id: string) {
  const row = await one<AttributeRow>(pool, 'SELECT * FROM spec_attributes WHERE id = $1', [id]);
  if (!row) return null;
  return { ...row, options: await optionsFor(pool, id) };
}

type StoredValue = { value_text: string | null; value_number: string | null; value_boolean: boolean | null; value_json: unknown };

function toStored(type: AttributeType, value: unknown, options: OptionRow[], validation: Record<string, unknown>): StoredValue {
  const checkTextRules = (text: string) => {
    const minLength = validation.minLength, maxLength = validation.maxLength, pattern = validation.pattern;
    if (typeof minLength === 'number' && text.length < minLength) throw badRequest(`مقدار باید دست‌کم ${minLength} نویسه باشد.`);
    if (typeof maxLength === 'number' && text.length > maxLength) throw badRequest(`مقدار باید حداکثر ${maxLength} نویسه باشد.`);
    if (typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 200) {
      let re: RegExp;
      try { re = new RegExp(pattern); } catch { throw badRequest('الگوی اعتبارسنجی این فیلد نامعتبر است.'); }
      if (!re.test(text)) throw badRequest('مقدار با الگوی مجاز این فیلد مطابقت ندارد.');
    }
  };
  const checkNumberRules = (num: number) => {
    const min = validation.min, max = validation.max;
    if (typeof min === 'number' && num < min) throw badRequest(`مقدار باید دست‌کم ${min} باشد.`);
    if (typeof max === 'number' && num > max) throw badRequest(`مقدار باید حداکثر ${max} باشد.`);
  };
  switch (type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw badRequest('مقدار باید درست یا نادرست باشد.');
      return { value_text: null, value_number: null, value_boolean: value, value_json: null };
    case 'number':
    case 'decimal':
    case 'measurement': {
      const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(num)) throw badRequest('مقدار باید عدد باشد.');
      if (type === 'number' && !Number.isInteger(num)) throw badRequest('مقدار باید عدد صحیح باشد.');
      checkNumberRules(num);
      return { value_text: null, value_number: String(num), value_boolean: null, value_json: null };
    }
    case 'multi_select': {
      if (!Array.isArray(value)) throw badRequest('مقدار باید فهرستی از گزینه‌ها باشد.');
      const allowed = new Set(options.map((o) => o.value));
      for (const entry of value as unknown[]) {
        if (typeof entry !== 'string' || !allowed.has(entry)) throw badRequest(`گزینه «${String(entry)}» در فهرست مجاز نیست.`);
      }
      return { value_text: null, value_number: null, value_boolean: null, value_json: value };
    }
    case 'single_select': {
      if (typeof value !== 'string' || !options.some((o) => o.value === value)) throw badRequest('گزینه انتخاب‌شده در فهرست مجاز نیست.');
      return { value_text: value, value_number: null, value_boolean: null, value_json: null };
    }
    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) throw badRequest('رنگ باید در قالب HEX شش‌رقمی باشد.');
      return { value_text: value, value_number: null, value_boolean: null, value_json: null };
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw badRequest('تاریخ باید در قالب YYYY-MM-DD باشد.');
      return { value_text: value, value_number: null, value_boolean: null, value_json: null };
    case 'url':
      if (typeof value !== 'string' || !/^https?:\/\/\S{4,2000}$/.test(value)) throw badRequest('آدرس اینترنتی معتبر نیست.');
      return { value_text: value, value_number: null, value_boolean: null, value_json: null };
    default: {
      if (typeof value !== 'string') throw badRequest('مقدار باید متن باشد.');
      if (value.length > 20000) throw badRequest('مقدار متنی بیش از حد طولانی است.');
      checkTextRules(value);
      return { value_text: value, value_number: null, value_boolean: null, value_json: null };
    }
  }
}

function fromStored(row: StoredValue & { type?: AttributeType }) {
  if (row.value_boolean !== null) return row.value_boolean;
  if (row.value_number !== null) return Number(row.value_number);
  if (row.value_json !== null && row.value_json !== undefined) return row.value_json;
  return row.value_text;
}

async function templateShape(pool: DbPool, templateId: string) {
  const template = await one<{ id: string; code: string; name: string; description: string; active: boolean }>(
    pool, 'SELECT id, code, name, description, active FROM spec_templates WHERE id = $1', [templateId]);
  if (!template) return null;
  const groups = (await pool.query(
    'SELECT id, name, position FROM spec_attribute_groups WHERE template_id = $1 ORDER BY position, name', [templateId])).rows;
  const attrs = (await pool.query(
    `SELECT a.*, ta.group_id AS group_id, ta.position AS in_template_position
     FROM spec_template_attributes ta JOIN spec_attributes a ON a.id = ta.attribute_id
     WHERE ta.template_id = $1 ORDER BY ta.position, a.label`, [templateId])).rows as (AttributeRow & { group_id: string | null; in_template_position: number })[];
  const attributes = [];
  for (const attr of attrs) attributes.push({ ...attr, options: await optionsFor(pool, attr.id) });
  return { ...template, groups, attributes };
}

async function fullGuide(pool: DbPool, guideId: string) {
  const guide = await one<{ id: string; code: string; name: string; description: string; version: number; supersedes_id: string | null; status: string }>(
    pool, 'SELECT id, code, name, description, version, supersedes_id, status FROM size_guides WHERE id = $1', [guideId]);
  if (!guide) return null;
  const columns = (await pool.query(
    'SELECT id, code, label, unit, position FROM size_guide_columns WHERE guide_id = $1 ORDER BY position', [guideId])).rows;
  const rows = (await pool.query(
    'SELECT id, values, position FROM size_guide_rows WHERE guide_id = $1 ORDER BY position', [guideId])).rows;
  const media = (await pool.query(
    `SELECT m.id, m.kind, m.caption, m.position, m.file_id, f.original_name, f.mime_type, f.size_bytes
     FROM size_guide_media m JOIN files f ON f.id = m.file_id WHERE m.guide_id = $1 ORDER BY m.position`, [guideId])).rows;
  return { ...guide, columns, rows, media };
}

export function registerSpecRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  // ---------- Attributes ----------
  app.get('/api/v1/spec-attributes', async () => {
    const rows = await pool.query<AttributeRow>('SELECT * FROM spec_attributes WHERE active = true ORDER BY position, label');
    const items = [];
    for (const row of rows.rows) items.push({ ...row, options: await optionsFor(pool, row.id) });
    return { items };
  });
  app.get('/api/v1/admin/spec-attributes', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const rows = await pool.query<AttributeRow>('SELECT * FROM spec_attributes ORDER BY position, label');
    const items = [];
    for (const row of rows.rows) items.push({ ...row, options: await optionsFor(pool, row.id) });
    return { items };
  });
  app.post('/api/v1/admin/spec-attributes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = attributeBody.parse(request.body);
    if ((body.type === 'single_select' || body.type === 'multi_select') && body.options.length === 0)
      throw badRequest('فیلد انتخابی دست‌کم یک گزینه لازم دارد.');
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query(
          `INSERT INTO spec_attributes(id, code, label, description, type, unit, required, searchable, filterable, scope, position, validation, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [id, body.code, body.label, body.description, body.type, body.unit ?? null, body.required,
            body.searchable, body.filterable, body.scope, body.position, JSON.stringify(body.validation), body.active]);
        for (const option of body.options) {
          await client.query('INSERT INTO spec_attribute_options(id, attribute_id, value, label, position) VALUES ($1,$2,$3,$4,$5)',
            [randomUUID(), id, option.value, option.label, option.position]);
        }
        await audit(client, user.id, 'spec_attribute.created', 'spec_attribute', id, undefined, { code: body.code }, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد این فیلد یا یکی از گزینه‌ها تکراری است.');
      throw error;
    }
    return reply.code(201).send(await attributeDetail(pool, id));
  });
  app.patch('/api/v1/admin/spec-attributes/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = attributeBody.partial().omit({ code: true, options: true }).strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM spec_attributes WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { label: 'label', description: 'description', type: 'type', unit: 'unit', required: 'required', searchable: 'searchable', filterable: 'filterable', scope: 'scope', position: 'position', validation: 'validation', active: 'active' };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(column === 'validation' ? JSON.stringify(value) : value);
        updates.push(`${column} = $${values.length}`);
      }
      await client.query(`UPDATE spec_attributes SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, values);
      await audit(client, user.id, 'spec_attribute.updated', 'spec_attribute', id, before, body, request.ip);
      return attributeDetail(client as unknown as DbPool, id);
    });
  });
  app.delete('/api/v1/admin/spec-attributes/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM spec_attributes WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const used = await one<{ count: string }>(client,
        `SELECT ((SELECT count(*) FROM spec_template_attributes WHERE attribute_id = $1) +
                 (SELECT count(*) FROM product_spec_values WHERE attribute_id = $1))::text AS count`, [id]);
      if (Number(used?.count ?? 0) > 0) throw conflict('این فیلد در قالب یا محصولی استفاده شده است؛ به‌جای حذف، آن را غیرفعال کنید.');
      await client.query('DELETE FROM spec_attributes WHERE id = $1', [id]);
      await audit(client, user.id, 'spec_attribute.deleted', 'spec_attribute', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });
  app.post('/api/v1/admin/spec-attributes/:id/options', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ value: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(120),
      position: z.number().int().min(0).max(100000).default(0) }).strict().parse(request.body);
    const attr = await one<AttributeRow>(pool, 'SELECT * FROM spec_attributes WHERE id = $1', [id]);
    if (!attr) throw notFound();
    if (attr.type !== 'single_select' && attr.type !== 'multi_select') throw badRequest('فقط فیلد انتخابی می‌تواند گزینه داشته باشد.');
    const optionId = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO spec_attribute_options(id, attribute_id, value, label, position) VALUES ($1,$2,$3,$4,$5)',
          [optionId, id, body.value, body.label, body.position]);
        await audit(client, user.id, 'spec_attribute.option_added', 'spec_attribute', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('این گزینه تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id: optionId, attributeId: id, ...body });
  });
  app.delete('/api/v1/admin/spec-attributes/:id/options/:optionId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), optionId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM spec_attribute_options WHERE id = $1 AND attribute_id = $2 RETURNING id', [params.optionId, params.id]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'spec_attribute.option_deleted', 'spec_attribute', params.id, { optionId: params.optionId }, undefined, request.ip));
    return { id: params.optionId, deleted: true };
  });

  // ---------- Templates ----------
  app.get('/api/v1/spec-templates', async () => {
    const rows = await pool.query('SELECT id FROM spec_templates WHERE active = true ORDER BY name');
    const items = [];
    for (const row of rows.rows) items.push(await templateShape(pool, row.id));
    return { items };
  });
  app.get('/api/v1/spec-templates/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const shape = await templateShape(pool, id);
    if (!shape) throw notFound();
    return shape;
  });
  app.get('/api/v1/admin/spec-templates', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const rows = await pool.query('SELECT id, code, name, description, active FROM spec_templates ORDER BY name');
    return { items: rows.rows };
  });
  app.post('/api/v1/admin/spec-templates', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = z.object({ code: z.string().trim().regex(/^[a-z0-9_-]{2,60}$/), name: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).default(''), active: z.boolean().default(true) }).strict().parse(request.body);
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO spec_templates(id, code, name, description, active) VALUES ($1,$2,$3,$4,$5)',
          [id, body.code, body.name, body.description, body.active]);
        await audit(client, user.id, 'spec_template.created', 'spec_template', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد قالب تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id, ...body });
  });
  app.patch('/api/v1/admin/spec-templates/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(160).optional(), description: z.string().trim().max(2000).optional(),
      active: z.boolean().optional() }).strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM spec_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { name: 'name', description: 'description', active: 'active' };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
      await client.query(`UPDATE spec_templates SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, values);
      await audit(client, user.id, 'spec_template.updated', 'spec_template', id, before, body, request.ip);
      return { id, ...body };
    });
  });
  app.delete('/api/v1/admin/spec-templates/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM spec_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const used = await one<{ count: string }>(client, 'SELECT count(*)::text AS count FROM product_types WHERE spec_template_id = $1', [id]);
      if (Number(used?.count ?? 0) > 0) throw conflict('این قالب به نوع محصولی وصل است؛ ابتدا اتصال را جدا کنید.');
      await client.query('DELETE FROM spec_templates WHERE id = $1', [id]);
      await audit(client, user.id, 'spec_template.deleted', 'spec_template', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });
  app.post('/api/v1/admin/spec-templates/:id/groups', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(120),
      position: z.number().int().min(0).max(100000).default(0) }).strict().parse(request.body);
    const template = await one(pool, 'SELECT id FROM spec_templates WHERE id = $1', [id]);
    if (!template) throw notFound();
    const groupId = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO spec_attribute_groups(id, template_id, name, position) VALUES ($1,$2,$3,$4)',
          [groupId, id, body.name, body.position]);
        await audit(client, user.id, 'spec_template.group_added', 'spec_template', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('نام این گروه در قالب تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id: groupId, templateId: id, ...body });
  });
  app.delete('/api/v1/admin/spec-templates/:id/groups/:groupId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), groupId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM spec_attribute_groups WHERE id = $1 AND template_id = $2 RETURNING id', [params.groupId, params.id]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'spec_template.group_deleted', 'spec_template', params.id, { groupId: params.groupId }, undefined, request.ip));
    return { id: params.groupId, deleted: true };
  });
  app.post('/api/v1/admin/spec-templates/:id/attributes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ attributeId: z.uuid(), groupId: z.uuid().nullable().optional(),
      position: z.number().int().min(0).max(100000).default(0) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const template = await one(client, 'SELECT id FROM spec_templates WHERE id = $1', [id]);
      if (!template) throw notFound();
      const attribute = await one(client, 'SELECT id FROM spec_attributes WHERE id = $1', [body.attributeId]);
      if (!attribute) throw badRequest('فیلد انتخاب‌شده یافت نشد.');
      if (body.groupId) {
        const group = await one(client, 'SELECT id FROM spec_attribute_groups WHERE id = $1 AND template_id = $2', [body.groupId, id]);
        if (!group) throw badRequest('گروه انتخاب‌شده متعلق به این قالب نیست.');
      }
      try {
        await client.query('INSERT INTO spec_template_attributes(template_id, attribute_id, group_id, position) VALUES ($1,$2,$3,$4)',
          [id, body.attributeId, body.groupId ?? null, body.position]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('این فیلد قبلاً در قالب هست.');
        throw error;
      }
      await audit(client, user.id, 'spec_template.attribute_added', 'spec_template', id, undefined, body, request.ip);
      return reply.code(201).send({ templateId: id, ...body });
    });
  });
  app.patch('/api/v1/admin/spec-templates/:id/attributes/:attributeId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), attributeId: z.uuid() }).parse(request.params);
    const body = z.object({ groupId: z.uuid().nullable().optional(),
      position: z.number().int().min(0).max(100000).optional() }).strict().parse(request.body);
    if (body.groupId === undefined && body.position === undefined) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const link = await one(client, 'SELECT * FROM spec_template_attributes WHERE template_id = $1 AND attribute_id = $2 FOR UPDATE', [params.id, params.attributeId]);
      if (!link) throw notFound();
      if (body.groupId) {
        const group = await one(client, 'SELECT id FROM spec_attribute_groups WHERE id = $1 AND template_id = $2', [body.groupId, params.id]);
        if (!group) throw badRequest('گروه انتخاب‌شده متعلق به این قالب نیست.');
      }
      const updates: string[] = [];
      const values: unknown[] = [params.id, params.attributeId];
      if (body.groupId !== undefined) { values.push(body.groupId); updates.push(`group_id = $${values.length}`); }
      if (body.position !== undefined) { values.push(body.position); updates.push(`position = $${values.length}`); }
      await client.query(`UPDATE spec_template_attributes SET ${updates.join(', ')} WHERE template_id = $1 AND attribute_id = $2`, values);
      await audit(client, user.id, 'spec_template.attribute_moved', 'spec_template', params.id, link, body, request.ip);
      return { templateId: params.id, attributeId: params.attributeId, ...body };
    });
  });
  app.delete('/api/v1/admin/spec-templates/:id/attributes/:attributeId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), attributeId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM spec_template_attributes WHERE template_id = $1 AND attribute_id = $2 RETURNING template_id', [params.id, params.attributeId]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'spec_template.attribute_removed', 'spec_template', params.id, { attributeId: params.attributeId }, undefined, request.ip));
    return { templateId: params.id, attributeId: params.attributeId, deleted: true };
  });

  // ---------- Product spec values (items 127-128) ----------
  app.get('/api/v1/products/:id/specs', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ id: string; product_type_id: string | null }>(pool, 'SELECT id, product_type_id FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    let template = null;
    if (product.product_type_id) {
      const link = await one<{ spec_template_id: string | null }>(pool, 'SELECT spec_template_id FROM product_types WHERE id = $1', [product.product_type_id]);
      if (link?.spec_template_id) template = await templateShape(pool, link.spec_template_id);
    }
    const rows = await pool.query(
      `SELECT v.id, v.variant_id, v.attribute_id, a.code, a.label, a.type, a.unit, a.scope,
              v.value_text, v.value_number, v.value_boolean, v.value_json
       FROM product_spec_values v JOIN spec_attributes a ON a.id = v.attribute_id
       WHERE v.product_id = $1 ORDER BY a.position, a.label`, [id]);
    return { productId: id, template, values: rows.rows.map((row) => ({ ...row, value: fromStored(row) })) };
  });

  app.put('/api/v1/products/:id/specs', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      values: z.array(z.object({
        attributeId: z.uuid().optional(), attributeCode: z.string().trim().min(1).max(60).optional(),
        variantId: z.uuid().nullable().optional(), value: z.unknown(),
      }).strict()).max(300).default([]),
      // Item 127: also attach the used attributes to the product-type template (admins only).
      addToTemplate: z.boolean().default(false),
    }).strict().parse(request.body);
    if (body.addToTemplate) requirePermission(user, 'catalog:structure');
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; supplier_id: string | null; product_type_id: string | null }>(client,
        'SELECT id, supplier_id, product_type_id FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();
      const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
      if (!isOwner) requirePermission(user, 'products:write');
      const variantIds = new Set((await client.query('SELECT id FROM product_variants WHERE product_id = $1', [id])).rows.map((row: { id: string }) => row.id));
      const warnings: string[] = [];
      let templateId: string | null = null;
      if (body.addToTemplate && product.product_type_id) {
        const link = await one<{ spec_template_id: string | null }>(client, 'SELECT spec_template_id FROM product_types WHERE id = $1', [product.product_type_id]);
        templateId = link?.spec_template_id ?? null;
        if (!templateId) warnings.push('نوع محصول این کالا قالب مشخصات ندارد؛ مقادیر فقط برای همین محصول ذخیره شد.');
      } else if (body.addToTemplate) {
        warnings.push('این کالا نوع محصول ندارد؛ مقادیر فقط برای همین محصول ذخیره شد.');
      }
      for (const entry of body.values) {
        if (!entry.attributeId && !entry.attributeCode) throw badRequest('هر مقدار باید فیلد مشخصی داشته باشد.');
        const attribute = entry.attributeId
          ? await one<AttributeRow>(client, 'SELECT * FROM spec_attributes WHERE id = $1', [entry.attributeId])
          : await one<AttributeRow>(client, 'SELECT * FROM spec_attributes WHERE code = $1', [entry.attributeCode]);
        if (!attribute || !attribute.active) throw badRequest(`فیلد «${entry.attributeCode ?? entry.attributeId}» فعال نیست.`);
        const variantId = entry.variantId ?? null;
        if (variantId && !variantIds.has(variantId)) throw badRequest('واریانت انتخاب‌شده متعلق به این محصول نیست.');
        if (variantId && attribute.scope !== 'variant') throw badRequest(`فیلد «${attribute.label}» سطح محصول است، نه سطح واریانت.`);
        if (!variantId && attribute.scope !== 'product') throw badRequest(`فیلد «${attribute.label}» سطح واریانت است؛ واریانت را مشخص کنید.`);
        const stored = toStored(attribute.type, entry.value, await optionsFor(client as unknown as DbPool, attribute.id), attribute.validation ?? {});
        if (variantId) {
          await client.query(
            `INSERT INTO product_spec_values(id, product_id, variant_id, attribute_id, value_text, value_number, value_boolean, value_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (product_id, variant_id, attribute_id) WHERE variant_id IS NOT NULL
             DO UPDATE SET value_text = $5, value_number = $6, value_boolean = $7, value_json = $8, updated_at = now()`,
            [randomUUID(), id, variantId, attribute.id, stored.value_text, stored.value_number,
              stored.value_boolean, stored.value_json === null || stored.value_json === undefined ? null : JSON.stringify(stored.value_json)]);
        } else {
          await client.query(
            `INSERT INTO product_spec_values(id, product_id, variant_id, attribute_id, value_text, value_number, value_boolean, value_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (product_id, attribute_id) WHERE variant_id IS NULL
             DO UPDATE SET value_text = $5, value_number = $6, value_boolean = $7, value_json = $8, updated_at = now()`,
            [randomUUID(), id, null, attribute.id, stored.value_text, stored.value_number,
              stored.value_boolean, stored.value_json === null || stored.value_json === undefined ? null : JSON.stringify(stored.value_json)]);
        }
        if (templateId) {
          await client.query(
            `INSERT INTO spec_template_attributes(template_id, attribute_id, group_id, position)
             VALUES ($1,$2,NULL,(SELECT COALESCE(max(position),0)+1 FROM spec_template_attributes WHERE template_id = $1))
             ON CONFLICT (template_id, attribute_id) DO NOTHING`, [templateId, attribute.id]);
        }
      }
      // Required-but-missing template attributes surface as warnings, not blockers,
      // so incremental editing stays possible while the editor can highlight gaps.
      if (product.product_type_id) {
        const link = await one<{ spec_template_id: string | null }>(client, 'SELECT spec_template_id FROM product_types WHERE id = $1', [product.product_type_id]);
        if (link?.spec_template_id) {
          const missing = await client.query(
            `SELECT a.label FROM spec_template_attributes ta JOIN spec_attributes a ON a.id = ta.attribute_id
             LEFT JOIN product_spec_values v ON v.product_id = $2 AND v.attribute_id = a.id AND v.variant_id IS NULL
             WHERE ta.template_id = $1 AND a.required = true AND a.scope = 'product' AND a.active = true AND v.id IS NULL`,
            [link.spec_template_id, id]);
          for (const row of missing.rows) warnings.push(`فیلد الزامی «${row.label}» هنوز مقدار ندارد.`);
        }
      }
      await audit(client, user.id, 'product.specs_saved', 'product', id, undefined, { count: body.values.length, addToTemplate: body.addToTemplate }, request.ip);
      return { productId: id, saved: body.values.length, warnings };
    });
  });

  // ---------- Size guides (items 129-134) ----------
  app.get('/api/v1/size-guides', async () => {
    const rows = await pool.query(
      `SELECT g.id, g.code, g.name, g.description, g.version, g.status,
              (SELECT count(*)::int FROM size_guide_columns c WHERE c.guide_id = g.id) AS column_count,
              (SELECT count(*)::int FROM size_guide_rows r WHERE r.guide_id = g.id) AS row_count
       FROM size_guides g WHERE g.status = 'active' ORDER BY g.name`);
    return { items: rows.rows };
  });
  app.get('/api/v1/size-guides/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const guide = await fullGuide(pool, id);
    if (!guide) throw notFound();
    return guide;
  });
  app.get('/api/v1/admin/size-guides', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const rows = await pool.query('SELECT id, code, name, description, version, supersedes_id, status FROM size_guides ORDER BY name, version DESC');
    return { items: rows.rows };
  });
  app.post('/api/v1/admin/size-guides', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const body = z.object({ code: z.string().trim().regex(/^[a-z0-9_-]{2,60}$/), name: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).default(''), status: z.enum(['draft', 'active', 'archived']).default('active') }).strict().parse(request.body);
    const id = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO size_guides(id, code, name, description, version, status) VALUES ($1,$2,$3,$4,1,$5)',
          [id, body.code, body.name, body.description, body.status]);
        await audit(client, user.id, 'size_guide.created', 'size_guide', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد راهنما تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id, version: 1, ...body });
  });
  app.patch('/api/v1/admin/size-guides/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(160).optional(), description: z.string().trim().max(2000).optional(),
      status: z.enum(['draft', 'active', 'archived']).optional() }).strict().parse(request.body);
    if (!Object.keys(body).length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM size_guides WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const map: Record<string, string> = { name: 'name', description: 'description', status: 'status' };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(map)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        updates.push(`${column} = $${values.length}`);
      }
      await client.query(`UPDATE size_guides SET ${updates.join(', ')}, updated_at = now() WHERE id = $1`, values);
      await audit(client, user.id, 'size_guide.updated', 'size_guide', id, before, body, request.ip);
      return { id, ...body };
    });
  });
  app.delete('/api/v1/admin/size-guides/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM size_guides WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const linked = await one<{ count: string }>(client,
        `SELECT ((SELECT count(*) FROM product_size_guides WHERE guide_id = $1 AND mode = 'link') +
                 (SELECT count(*) FROM size_guides WHERE supersedes_id = $1))::text AS count`, [id]);
      if (Number(linked?.count ?? 0) > 0) throw conflict('این راهنما به محصول یا نسخه جدیدتری وصل است؛ به‌جای حذف، آن را بایگانی کنید.');
      await client.query('DELETE FROM size_guides WHERE id = $1', [id]);
      await audit(client, user.id, 'size_guide.deleted', 'size_guide', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });
  app.post('/api/v1/admin/size-guides/:id/columns', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ code: z.string().trim().regex(/^[a-z0-9_-]{1,60}$/), label: z.string().trim().min(1).max(120),
      unit: z.string().trim().max(40).nullable().optional(), position: z.number().int().min(0).max(100000).default(0) }).strict().parse(request.body);
    const guide = await one(pool, 'SELECT id FROM size_guides WHERE id = $1', [id]);
    if (!guide) throw notFound();
    const columnId = randomUUID();
    try {
      await transaction(pool, async (client) => {
        await client.query('INSERT INTO size_guide_columns(id, guide_id, code, label, unit, position) VALUES ($1,$2,$3,$4,$5,$6)',
          [columnId, id, body.code, body.label, body.unit ?? null, body.position]);
        await audit(client, user.id, 'size_guide.column_added', 'size_guide', id, undefined, body, request.ip);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('کد ستون در این راهنما تکراری است.');
      throw error;
    }
    return reply.code(201).send({ id: columnId, guideId: id, ...body });
  });
  // QA2-SIZE-005: in-place column rename / unit change / reorder.
  app.patch('/api/v1/admin/size-guides/:id/columns/:columnId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), columnId: z.uuid() }).parse(request.params);
    const body = z.object({
      label: z.string().trim().min(1).max(120).optional(),
      unit: z.string().trim().max(40).nullable().optional(),
      position: z.number().int().min(0).max(100000).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await one<{ id: string; label: string; unit: string | null; position: number }>(
        client, 'SELECT id, label, unit, position FROM size_guide_columns WHERE id = $1 AND guide_id = $2 FOR UPDATE',
        [params.columnId, params.id]);
      if (!existing) throw notFound();
      const next = {
        label: body.label ?? existing.label,
        unit: body.unit !== undefined ? body.unit : existing.unit,
        position: body.position ?? existing.position,
      };
      await client.query('UPDATE size_guide_columns SET label = $2, unit = $3, position = $4 WHERE id = $1',
        [params.columnId, next.label, next.unit, next.position]);
      await audit(client, user.id, 'size_guide.column_updated', 'size_guide', params.id,
        { columnId: params.columnId, ...existing }, { columnId: params.columnId, ...next }, request.ip);
      return { id: params.columnId, guideId: params.id, ...next };
    });
  });
  app.delete('/api/v1/admin/size-guides/:id/columns/:columnId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), columnId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM size_guide_columns WHERE id = $1 AND guide_id = $2 RETURNING id', [params.columnId, params.id]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'size_guide.column_deleted', 'size_guide', params.id, { columnId: params.columnId }, undefined, request.ip));
    return { id: params.columnId, deleted: true };
  });
  // Bulk row replace keeps table editing atomic from the UI.
  app.put('/api/v1/admin/size-guides/:id/rows', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ rows: z.array(z.record(z.string(), z.string().max(500))).max(500) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const guide = await one(client, 'SELECT id FROM size_guides WHERE id = $1 FOR UPDATE', [id]);
      if (!guide) throw notFound();
      const columns = (await client.query('SELECT code FROM size_guide_columns WHERE guide_id = $1', [id])).rows.map((row: { code: string }) => row.code);
      const known = new Set(columns);
      for (const row of body.rows) {
        for (const key of Object.keys(row)) {
          if (!known.has(key)) throw badRequest(`ستون «${key}» در این راهنما تعریف نشده است.`);
        }
      }
      await client.query('DELETE FROM size_guide_rows WHERE guide_id = $1', [id]);
      for (const [index, row] of body.rows.entries()) {
        await client.query('INSERT INTO size_guide_rows(id, guide_id, values, position) VALUES ($1,$2,$3,$4)',
          [randomUUID(), id, JSON.stringify(row), index + 1]);
      }
      await audit(client, user.id, 'size_guide.rows_replaced', 'size_guide', id, undefined, { count: body.rows.length }, request.ip);
      return { guideId: id, rows: body.rows.length };
    });
  });
  app.post('/api/v1/admin/size-guides/:id/media', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ fileId: z.uuid(), kind: z.enum(['image', 'diagram', 'video', 'gif']),
      caption: z.string().trim().max(500).default(''), position: z.number().int().min(0).max(100000).default(0) }).strict().parse(request.body);
    const guide = await one(pool, 'SELECT id FROM size_guides WHERE id = $1', [id]);
    if (!guide) throw notFound();
    const file = await one(pool, 'SELECT id FROM files WHERE id = $1', [body.fileId]);
    if (!file) throw badRequest('فایل انتخاب‌شده یافت نشد.');
    const mediaId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO size_guide_media(id, guide_id, file_id, kind, caption, position) VALUES ($1,$2,$3,$4,$5,$6)',
        [mediaId, id, body.fileId, body.kind, body.caption, body.position]);
      await audit(client, user.id, 'size_guide.media_added', 'size_guide', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id: mediaId, guideId: id, ...body });
  });
  app.delete('/api/v1/admin/size-guides/:id/media/:mediaId', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const params = z.object({ id: z.uuid(), mediaId: z.uuid() }).parse(request.params);
    const deleted = await pool.query('DELETE FROM size_guide_media WHERE id = $1 AND guide_id = $2 RETURNING id', [params.mediaId, params.id]);
    if (!deleted.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'size_guide.media_deleted', 'size_guide', params.id, { mediaId: params.mediaId }, undefined, request.ip));
    return { id: params.mediaId, deleted: true };
  });
  // Item 134: versioning — clone as a new version; history stays intact.
  app.post('/api/v1/admin/size-guides/:id/version', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'catalog:structure');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ code: z.string().trim().regex(/^[a-z0-9_-]{2,60}$/),
      name: z.string().trim().min(2).max(160).optional() }).strict().parse(request.body);
    const nextId = randomUUID();
    const version = await transaction(pool, async (client) => {
      const current = await one<{ code: string; name: string; description: string; version: number }>(client,
        'SELECT code, name, description, version FROM size_guides WHERE id = $1', [id]);
      if (!current) throw notFound();
      try {
        await client.query('INSERT INTO size_guides(id, code, name, description, version, supersedes_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [nextId, body.code, body.name ?? `${current.name} (v${current.version + 1})`, current.description, current.version + 1, id, 'active']);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw conflict('کد نسخه جدید تکراری است.');
        throw error;
      }
      const columns = (await client.query('SELECT code, label, unit, position FROM size_guide_columns WHERE guide_id = $1', [id])).rows;
      for (const column of columns) {
        await client.query('INSERT INTO size_guide_columns(id, guide_id, code, label, unit, position) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), nextId, column.code, column.label, column.unit, column.position]);
      }
      const rows = (await client.query('SELECT values, position FROM size_guide_rows WHERE guide_id = $1', [id])).rows;
      for (const row of rows) {
        await client.query('INSERT INTO size_guide_rows(id, guide_id, values, position) VALUES ($1,$2,$3,$4)',
          [randomUUID(), nextId, JSON.stringify(row.values), row.position]);
      }
      const media = (await client.query('SELECT file_id, kind, caption, position FROM size_guide_media WHERE guide_id = $1', [id])).rows;
      for (const item of media) {
        await client.query('INSERT INTO size_guide_media(id, guide_id, file_id, kind, caption, position) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), nextId, item.file_id, item.kind, item.caption, item.position]);
      }
      await audit(client, user.id, 'size_guide.versioned', 'size_guide', nextId, { from: id }, { version: current.version + 1 }, request.ip);
      return { id: nextId, version: current.version + 1, supersedesId: id };
    });
    return reply.code(201).send(version);
  });

  // ---------- Product <-> guide attachment (items 131-132) ----------
  app.get('/api/v1/products/:id/size-guide', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const link = await one<{ guide_id: string; mode: string; detached_snapshot: unknown }>(pool,
      'SELECT guide_id, mode, detached_snapshot FROM product_size_guides WHERE product_id = $1', [id]);
    if (!link) return { productId: id, guide: null };
    if (link.mode === 'detached') return { productId: id, mode: 'detached', guide: link.detached_snapshot };
    const guide = await fullGuide(pool, link.guide_id);
    return { productId: id, mode: 'link', guide };
  });
  app.put('/api/v1/products/:id/size-guide', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ guideId: z.uuid(), mode: z.enum(['link', 'detached']) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const product = await one<{ id: string; supplier_id: string | null }>(client, 'SELECT id, supplier_id FROM products WHERE id = $1', [id]);
      if (!product) throw notFound();
      const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
      if (!isOwner) requirePermission(user, 'products:write');
      const guide = await fullGuide(client as unknown as DbPool, body.guideId);
      if (!guide) throw badRequest('راهنمای سایز انتخاب‌شده یافت نشد.');
      const snapshot = body.mode === 'detached' ? guide : null;
      await client.query(
        `INSERT INTO product_size_guides(product_id, guide_id, mode, detached_snapshot, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (product_id) DO UPDATE SET guide_id = $2, mode = $3, detached_snapshot = $4, updated_at = now()`,
        [id, body.guideId, body.mode, snapshot ? JSON.stringify(snapshot) : null]);
      await audit(client, user.id, 'product.size_guide_attached', 'product', id, undefined, { guideId: body.guideId, mode: body.mode }, request.ip);
      return { productId: id, guideId: body.guideId, mode: body.mode };
    });
  });
  app.delete('/api/v1/products/:id/size-guide', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
    if (!isOwner) requirePermission(user, 'products:write');
    await pool.query('DELETE FROM product_size_guides WHERE product_id = $1', [id]);
    await transaction(pool, (client) => audit(client, user.id, 'product.size_guide_detached', 'product', id, undefined, undefined, request.ip));
    return { productId: id, guide: null };
  });
}
