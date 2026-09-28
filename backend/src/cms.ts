import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, notFound } from './errors.js';

/* CMS (items 18-22): component registry, page builder with drag-drop ordering,
   scheduled color palettes linked to festivals, and the support widget config. */

const colors = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  secondary: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  background: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  surface: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  text: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
}).strict();

const componentBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  title: z.string().trim().min(2).max(120),
  componentType: z.enum(['hero', 'banner', 'product_slider', 'category_section', 'promotional', 'text_image',
    'cta', 'faq', 'blog_section', 'brand_section', 'custom']),
  fieldSchema: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().default(true),
}).strict();

const pageBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
  title: z.string().trim().min(2).max(160),
  path: z.string().trim().min(1).max(200),
  description: z.string().max(1000).default(''),
  seo: z.record(z.string(), z.unknown()).default({}),
  active: z.boolean().default(true),
}).strict();

const sectionBody = z.object({
  componentCode: z.string().trim().max(40),
  title: z.string().trim().max(160).default(''),
  payload: z.record(z.string(), z.unknown()).default({}),
  visible: z.boolean().default(true),
}).strict();

const supportWidget = z.object({
  enabled: z.boolean(),
  position: z.enum(['left', 'right']),
  channels: z.array(z.object({
    type: z.enum(['whatsapp', 'telegram', 'phone', 'chat', 'ticket']),
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(300),
  }).strict()).max(10),
  appearance: z.object({
    color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
    size: z.enum(['small', 'medium', 'large']),
    icon: z.string().trim().max(40),
  }).strict(),
}).strict();

export function registerCmsRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ---------- Public site surface ---------- */

  app.get('/api/v1/site/active-palette', async () => {
    const row = await one<{ id: string; code: string; name: string; colors: Record<string, string>; mode: string }>(pool,
      `SELECT p.id, p.code, p.name, p.colors, a.mode
       FROM palette_activations a JOIN color_palettes p ON p.id = a.palette_id
       WHERE a.active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
         AND (a.mode <> 'festival' OR EXISTS (
           SELECT 1 FROM festivals f WHERE f.id = a.festival_id AND f.active
             AND f.starts_at <= now() AND f.ends_at >= now()))
       ORDER BY CASE a.mode WHEN 'festival' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, a.created_at DESC
       LIMIT 1`);
    return { palette: row ?? null };
  });

  app.get('/api/v1/site/pages/:code', async (request) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(request.params);
    const page = await one<Record<string, unknown>>(pool, 'SELECT * FROM cms_pages WHERE code = $1 AND active', [code]);
    if (!page) throw notFound();
    const sections = await pool.query(
      `SELECT s.id, s.title, s.payload, s.visible, s.position, c.code AS component_code, c.component_type
       FROM cms_sections s JOIN cms_components c ON c.id = s.component_id
       WHERE s.page_id = $1 AND s.visible ORDER BY s.position, s.created_at`, [page.id]);
    return { ...page, sections: sections.rows };
  });

  app.get('/api/v1/site/components', async () => {
    const rows = await pool.query('SELECT code, title, component_type, field_schema FROM cms_components WHERE active ORDER BY code');
    return { items: rows.rows };
  });

  app.get('/api/v1/site/support-widget', async () => {
    const row = await one<{ value: unknown }>(pool, `SELECT value FROM site_settings WHERE key = 'support_widget'`);
    return { widget: row?.value ?? { enabled: false, position: 'left', channels: [], appearance: { color: '#1B2A4A', size: 'medium', icon: 'headset' } } };
  });

  /* ---------- Admin management ---------- */

  app.get('/api/v1/admin/cms/components', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:read');
    const rows = await pool.query('SELECT * FROM cms_components ORDER BY code');
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/cms/components', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const body = componentBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO cms_components(id,code,title,component_type,field_schema,active) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, body.code, body.title, body.componentType, JSON.stringify(body.fieldSchema), body.active]);
      await audit(client, user.id, 'cms.component_created', 'cms_component', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/cms/components/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = componentBody.omit({ code: true }).partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM cms_components WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE cms_components SET title = COALESCE($2, title), component_type = COALESCE($3, component_type),
           field_schema = COALESCE($4, field_schema), active = COALESCE($5, active) WHERE id = $1`,
        [id, body.title ?? null, body.componentType ?? null, body.fieldSchema ? JSON.stringify(body.fieldSchema) : null, body.active ?? null]);
      await audit(client, user.id, 'cms.component_updated', 'cms_component', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_components WHERE id = $1', [id]);
    });
  });

  app.get('/api/v1/admin/cms/pages', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:read');
    const rows = await pool.query(
      `SELECT p.*, (SELECT count(*)::int FROM cms_sections s WHERE s.page_id = p.id) AS section_count
       FROM cms_pages p ORDER BY p.code`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/cms/pages', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const body = pageBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO cms_pages(id,code,title,path,description,seo,active) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, body.code, body.title, body.path, body.description, JSON.stringify(body.seo), body.active]);
      await audit(client, user.id, 'cms.page_created', 'cms_page', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/cms/pages/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = pageBody.omit({ code: true }).partial().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM cms_pages WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE cms_pages SET title = COALESCE($2, title), path = COALESCE($3, path),
           description = COALESCE($4, description), seo = COALESCE($5, seo), active = COALESCE($6, active), updated_at = now()
         WHERE id = $1`,
        [id, body.title ?? null, body.path ?? null, body.description ?? null, body.seo ? JSON.stringify(body.seo) : null, body.active ?? null]);
      await audit(client, user.id, 'cms.page_updated', 'cms_page', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_pages WHERE id = $1', [id]);
    });
  });

  app.post('/api/v1/admin/cms/pages/:id/sections', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = sectionBody.parse(request.body);
    return transaction(pool, async (client) => {
      const page = await one(client, 'SELECT id FROM cms_pages WHERE id = $1', [id]);
      if (!page) throw notFound();
      const component = await one<{ id: string }>(client, 'SELECT id FROM cms_components WHERE code = $1', [body.componentCode]);
      if (!component) throw badRequest('کامپوننت موردنظر تعریف نشده است.');
      const position = await one<{ next: number }>(client,
        'SELECT COALESCE(max(position), 0) + 1 AS next FROM cms_sections WHERE page_id = $1', [id]);
      const sectionId = randomUUID();
      await client.query(
        'INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [sectionId, id, component.id, body.title, JSON.stringify(body.payload), body.visible, position!.next]);
      await audit(client, user.id, 'cms.section_added', 'cms_section', sectionId, undefined, { pageId: id, ...body }, request.ip);
      return reply.code(201).send({ id: sectionId, position: position!.next, ...body });
    });
  });

  app.patch('/api/v1/admin/cms/sections/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().max(160).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      visible: z.boolean().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM cms_sections WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        'UPDATE cms_sections SET title = COALESCE($2, title), payload = COALESCE($3, payload), visible = COALESCE($4, visible), updated_at = now() WHERE id = $1',
        [id, body.title ?? null, body.payload ? JSON.stringify(body.payload) : null, body.visible ?? null]);
      await audit(client, user.id, 'cms.section_updated', 'cms_section', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_sections WHERE id = $1', [id]);
    });
  });

  app.delete('/api/v1/admin/cms/sections/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM cms_sections WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('DELETE FROM cms_sections WHERE id = $1', [id]);
      await audit(client, user.id, 'cms.section_removed', 'cms_section', id, before, undefined, request.ip);
      return { id, removed: true };
    });
  });

  /** Drag & drop ordering: the client sends the final section order (item 19). */
  app.post('/api/v1/admin/cms/pages/:id/sections/reorder', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ sectionIds: z.array(z.uuid()).min(1).max(200) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await client.query<{ id: string }>('SELECT id FROM cms_sections WHERE page_id = $1', [id]);
      const known = new Set(existing.rows.map((row) => row.id));
      if (body.sectionIds.some((sectionId) => !known.has(sectionId))) throw badRequest('فهرست بخش‌ها به این صفحه تعلق ندارد.');
      const before = await client.query('SELECT id, position FROM cms_sections WHERE page_id = $1 ORDER BY position', [id]);
      for (const [index, sectionId] of body.sectionIds.entries()) {
        await client.query('UPDATE cms_sections SET position = $2, updated_at = now() WHERE id = $1', [sectionId, index + 1]);
      }
      await audit(client, user.id, 'cms.sections_reordered', 'cms_page', id,
        { order: before.rows }, { order: body.sectionIds }, request.ip);
      return { pageId: id, order: body.sectionIds };
    });
  });

  app.get('/api/v1/admin/cms/palettes', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:read');
    const rows = await pool.query(
      `SELECT p.*, COALESCE(jsonb_agg(jsonb_build_object('id', a.id, 'mode', a.mode, 'startsAt', a.starts_at,
         'endsAt', a.ends_at, 'festivalId', a.festival_id, 'active', a.active) ORDER BY a.created_at DESC)
         FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS activations
       FROM color_palettes p LEFT JOIN palette_activations a ON a.palette_id = p.id
       GROUP BY p.id ORDER BY p.created_at DESC`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/cms/palettes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const body = z.object({
      code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/),
      name: z.string().trim().min(2).max(120),
      occasion: z.string().trim().max(120).optional(),
      colors,
    }).strict().parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO color_palettes(id,code,name,occasion,colors,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, body.code, body.name, body.occasion ?? null, JSON.stringify(body.colors), user.id]);
      await audit(client, user.id, 'cms.palette_created', 'color_palette', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.post('/api/v1/admin/cms/palettes/:id/activations', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      mode: z.enum(['manual', 'scheduled', 'festival']),
      startsAt: z.iso.datetime().optional(),
      endsAt: z.iso.datetime().nullable().optional(),
      festivalId: z.uuid().optional(),
    }).strict().parse(request.body);
    if (body.mode === 'festival' && !body.festivalId) throw badRequest('برای حالت جشنواره، شناسه جشنواره لازم است.');
    return transaction(pool, async (client) => {
      const palette = await one(client, 'SELECT id FROM color_palettes WHERE id = $1', [id]);
      if (!palette) throw notFound();
      if (body.festivalId) {
        const festival = await one(client, 'SELECT id FROM festivals WHERE id = $1', [body.festivalId]);
        if (!festival) throw badRequest('جشنواره موردنظر یافت نشد.');
      }
      // A manual activation replaces the previous manual one.
      if (body.mode === 'manual') await client.query(`UPDATE palette_activations SET active = false WHERE palette_id = $1 AND mode = 'manual'`, [id]);
      const activationId = randomUUID();
      await client.query(
        `INSERT INTO palette_activations(id,palette_id,mode,starts_at,ends_at,festival_id,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [activationId, id, body.mode, body.startsAt ?? new Date(), body.endsAt ?? null, body.festivalId ?? null, user.id]);
      await audit(client, user.id, 'cms.palette_activated', 'color_palette', id, undefined, body, request.ip);
      return reply.code(201).send({ id: activationId, paletteId: id, ...body });
    });
  });

  app.put('/api/v1/admin/site-settings/support-widget', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const body = supportWidget.parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ value: unknown }>(client, `SELECT value FROM site_settings WHERE key = 'support_widget' FOR UPDATE`);
      await client.query(
        `INSERT INTO site_settings(key, value, updated_by) VALUES ('support_widget', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = now()`,
        [JSON.stringify(body), user.id]);
      await audit(client, user.id, 'cms.support_widget_updated', 'site_settings', 'support_widget',
        before?.value, body, request.ip);
      return { widget: body };
    });
  });
}
