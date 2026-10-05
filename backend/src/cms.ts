import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateSectionPayload, validateStyleOverrides, type FieldSchema } from './cms-schema.js';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import type { PoolClient } from 'pg';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { legacySeoToWrite, upsertSeoEntry } from './seo.js';
import { badRequest, notFound, patchBody } from './errors.js';
import { seedStarterContent } from './cms-starter.js';

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
  presetCode: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(),
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

/** Deterministic default palette — the admin CTA «ایجاد پالت اصلی» and the CMS bootstrap both use it. */
const DEFAULT_PALETTE = {
  code: 'kolbe-default',
  name: 'پالت اصلی کلبه',
  occasion: null as string | null,
  colors: { primary: '#1B2A4A', secondary: '#C1613B', accent: '#C1613B', background: '#F9F6F1', surface: '#FFFFFF', text: '#0E1527' },
};

/** Base hero payload — the storefront `HeroRenderer` reads exactly these keys. */
const DEFAULT_HERO = {
  eyebrow: 'کلبه وینتیج',
  title: 'پوشاک انتخابی، برای سال‌ها',
  subtitle: 'کالکشن کلبه وینتیج با تمرکز بر پارچه، دوخت و ماندگاری؛ برای خرید خرده و تأمین عمده.',
  ctaLabel: 'مشاهده کالکشن',
  ctaTarget: 'shop',
  image: null,
  visible: true,
};

/** Base sections created by the one-click bootstrap (hero is always position 0). */
const BASE_SECTIONS: { componentCode: string; title: string; payload: Record<string, unknown>; position: number }[] = [
  { componentCode: 'hero', title: 'هیرو صفحه اصلی', payload: DEFAULT_HERO, position: 0 },
  { componentCode: 'product_slider', title: 'محصولات منتخب', payload: { heading: 'منتخب کلبه', limit: 8 }, position: 1 },
  { componentCode: 'cta', title: 'دعوت به خرید عمده', payload: { title: 'تأمین عمده پوشاک با شرایط ویژه', cta: 'درخواست همکاری', target: 'vip' }, position: 2 },
  // Component library on a fresh DB (Req 213): every block is bound to live commerce data, never copies.
  { componentCode: 'category_card', title: 'دسته‌بندی‌ها', payload: { title: 'دسته‌بندی‌های کلبه', template: 'editorial', columns: 3 }, position: 3 },
  { componentCode: 'product_grid', title: 'تازه‌رسیده‌ها', payload: { title: 'تازه‌رسیده‌ها', subtitle: 'جدیدترین مدل‌های موجود در انبار', collectionCode: 'new-arrivals', limit: 8 }, position: 4 },
  { componentCode: 'installment_card', title: 'خرید اقساطی', payload: { provider: 'snapppay', installmentsCount: 4, title: 'خرید چهارقسطه بدون کارمزد', subtitle: 'مبلغ هر قسط از قیمت واقعی محصول محاسبه می‌شود.' }, position: 5 },
  { componentCode: 'recommendation_section', title: 'محبوب‌ترین‌ها', payload: { title: 'محبوب‌ترین‌های کلبه', strategy: 'popular', limit: 4 }, position: 6 },
  { componentCode: 'review_section', title: 'نظر مشتریان', payload: { title: 'مشتریان کلبه چه می‌گویند', limit: 3, showSummary: true }, position: 7 },
  { componentCode: 'newsletter', title: 'خبرنامه', payload: { title: 'باشگاه کلبه', text: 'از کالکشن‌های جدید و پیشنهادهای ویژه زودتر باخبر شوید.', tone: 'stone' }, position: 8 },
];

/** Creates (or returns) the default palette and makes it the active manual palette. Idempotent. */
async function ensureDefaultPalette(client: PoolClient, actorId: string, ip: string) {
  const existing = await one<{ id: string }>(client, 'SELECT id FROM color_palettes WHERE code = $1', [DEFAULT_PALETTE.code]);
  let paletteId = existing?.id;
  let created = false;
  if (!paletteId) {
    paletteId = randomUUID();
    await client.query('INSERT INTO color_palettes(id,code,name,occasion,colors,created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [paletteId, DEFAULT_PALETTE.code, DEFAULT_PALETTE.name, DEFAULT_PALETTE.occasion, JSON.stringify(DEFAULT_PALETTE.colors), actorId]);
    await audit(client, actorId, 'cms.palette_created', 'color_palette', paletteId, undefined, { code: DEFAULT_PALETTE.code }, ip);
    created = true;
  }
  const activation = await one<{ id: string }>(client,
    `SELECT id FROM palette_activations WHERE palette_id = $1 AND mode = 'manual' AND active LIMIT 1`, [paletteId]);
  let activated = false;
  if (!activation) {
    await client.query(
      `UPDATE palette_activations SET active = false WHERE mode = 'manual' AND active`);
    await client.query(
      `INSERT INTO palette_activations(id,palette_id,mode,starts_at,ends_at,created_by) VALUES ($1,$2,'manual',now(),NULL,$3)`,
      [randomUUID(), paletteId, actorId]);
    await audit(client, actorId, 'cms.palette_activated', 'color_palette', paletteId, undefined, { mode: 'manual' }, ip);
    activated = true;
  }
  return { paletteId, created, activated };
}

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

  // GET /api/v1/site/pages/:code lives in cms-studio.ts (published snapshot + schedule + commerce bindings).

  app.get('/api/v1/site/components', async () => {
    const rows = await pool.query('SELECT code, title, component_type, field_schema FROM cms_components WHERE active ORDER BY code');
    return { items: rows.rows };
  });

  app.get('/api/v1/site/support-widget', async () => {
    const row = await one<{ value: unknown }>(pool, `SELECT value FROM site_settings WHERE key = 'support_widget'`);
    return { widget: row?.value ?? { enabled: false, position: 'left', channels: [], appearance: { color: '#1B2A4A', size: 'medium', icon: 'headset' } } };
  });

  /* ---------- Admin management ---------- */

  /**
   * One-click CMS bootstrap for a fresh database: home page + hero + base sections + default palette
   * + About/Vibe/Lead starter pages (cms-starter.ts).
   * Idempotent — running it twice never duplicates rows and never resets edited content.
   */
  app.post('/api/v1/admin/cms/bootstrap', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    return transaction(pool, async (client) => {
      const existingPage = await one<{ id: string }>(client, `SELECT id FROM cms_pages WHERE code = 'home'`);
      let pageId = existingPage?.id;
      let pageCreated = false;
      if (!pageId) {
        pageId = randomUUID();
        await client.query(
          `INSERT INTO cms_pages(id,code,title,path,description,seo,active,status)
           VALUES ($1,'home','صفحه اصلی','/','صفحه اصلی فروشگاه کلبه وینتیج',$2,true,'draft')`,
          [pageId, JSON.stringify({ title: 'کلبه وینتیج', description: 'پوشاک انتخابی کلبه وینتیج' })]);
        await audit(client, user.id, 'cms.page_created', 'cms_page', pageId, undefined, { code: 'home', source: 'bootstrap' }, request.ip);
        pageCreated = true;
      }

      const createdSections: string[] = [];
      for (const section of BASE_SECTIONS) {
        const component = await one<{ id: string }>(client, 'SELECT id FROM cms_components WHERE code = $1', [section.componentCode]);
        if (!component) continue; // registry is seeded by migration 010; skip gracefully if missing
        const already = await one<{ id: string }>(client,
          'SELECT id FROM cms_sections WHERE page_id = $1 AND component_id = $2', [pageId, component.id]);
        if (already) continue;
        const sectionId = randomUUID();
        await client.query(
          `INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sectionId, pageId, component.id, section.title, JSON.stringify(section.payload), true, section.position]);
        createdSections.push(sectionId);
      }
      if (createdSections.length) {
        await audit(client, user.id, 'cms.sections_seeded', 'cms_page', pageId, undefined,
          { sections: createdSections.length, source: 'bootstrap' }, request.ip);
      }

      const palette = await ensureDefaultPalette(client, user.id, request.ip);
      const starter = await seedStarterContent(client);
      if (starter.pagesCreated) {
        await audit(client, user.id, 'cms.starter_pages_seeded', 'cms_page', pageId, undefined, { pages: starter.pagesCreated, source: 'bootstrap' }, request.ip);
      }
      const hero = await one(client,
        `SELECT s.id, s.title, s.payload FROM cms_sections s JOIN cms_components c ON c.id = s.component_id
         WHERE s.page_id = $1 AND c.code = 'hero' ORDER BY s.position LIMIT 1`, [pageId]);
      return {
        pageId, pageCreated, sectionsCreated: createdSections.length, starterPagesCreated: starter.pagesCreated,
        paletteId: palette.paletteId, paletteCreated: palette.created, paletteActivated: palette.activated,
        hero,
      };
    });
  });

  /** Idempotent default-palette creation used by the palettes CTA. */
  app.post('/api/v1/admin/cms/palettes/default', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const result = await transaction(pool, (client) => ensureDefaultPalette(client, user.id, request.ip));
    const row = await one(pool, 'SELECT * FROM color_palettes WHERE id = $1', [result.paletteId]);
    return reply.code(result.created ? 201 : 200).send({ palette: row, created: result.created, activated: result.activated });
  });

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
    const body = patchBody(componentBody.omit({ code: true }).partial().parse(request.body), request.body);
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
    const q=z.object({search:z.string().max(160).default(''),limit:z.coerce.number().int().min(1).max(250).default(100),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(request.query);
    const rows=await pool.query(`SELECT p.*, (SELECT count(*)::int FROM cms_sections s WHERE s.page_id=p.id) AS section_count,
      p.draft_revision IS DISTINCT FROM (SELECT v.draft_revision FROM cms_page_versions v WHERE v.page_id=p.id ORDER BY v.version DESC LIMIT 1) AS unpublished_changes
      FROM cms_pages p WHERE title ILIKE $1 OR path ILIKE $1 ORDER BY updated_at DESC,id LIMIT $2 OFFSET $3`,[`%${q.search}%`,q.limit,q.offset]);
    const total=await one<{n:number}>(pool,'SELECT count(*)::int AS n FROM cms_pages WHERE title ILIKE $1 OR path ILIKE $1',[`%${q.search}%`]);
    return {items:rows.rows,total:total!.n};
  });

  app.post('/api/v1/admin/cms/pages', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const body = pageBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_pages(id,code,title,path,description,seo,active,status) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,'draft')`,
        [id, body.code, body.title, body.path, body.description, body.active]);
      // Req 235: SEO lives in the SEO Domain, never in cms_pages.
      const seo = legacySeoToWrite(body.seo);
      if (seo) await upsertSeoEntry(client, 'page', body.code, seo, user.id, config.PUBLIC_ORIGIN, request.ip);
      await audit(client, user.id, 'cms.page_created', 'cms_page', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, ...body });
  });

  app.patch('/api/v1/admin/cms/pages/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody(pageBody.omit({ code: true }).partial().parse(request.body), request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM cms_pages WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE cms_pages SET title = COALESCE($2, title), path = COALESCE($3, path),
           description = COALESCE($4, description), active = COALESCE($5, active), updated_at = now()
         WHERE id = $1`,
        [id, body.title ?? null, body.path ?? null, body.description ?? null, body.active ?? null]);
      const seo = legacySeoToWrite(body.seo);
      if (seo) await upsertSeoEntry(client, 'page', String(before.code), seo, user.id, config.PUBLIC_ORIGIN, request.ip);
      await audit(client, user.id, 'cms.page_updated', 'cms_page', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_pages WHERE id = $1', [id]);
    });
  });

  app.get('/api/v1/admin/cms/pages/:id/sections', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT s.id, s.page_id, s.title, s.payload, s.visible, s.position, s.variant, s.preset, s.section_theme, s.style_overrides, s.responsive_config,
              c.code AS component_code
         FROM cms_sections s JOIN cms_components c ON c.id = s.component_id
        WHERE s.page_id = $1 ORDER BY s.position, s.created_at`, [id]);
    return { items: rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id, pageId: r.page_id, componentCode: r.component_code, title: r.title,
      payload: r.payload, visible: r.visible, position: r.position,
      variant: r.variant, preset: r.preset, sectionTheme: r.section_theme, styleOverrides: r.style_overrides ?? {}, responsiveConfig: r.responsive_config ?? {},
    })) };
  });

  app.post('/api/v1/admin/cms/pages/:id/sections', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = sectionBody.parse(request.body);
    return transaction(pool, async (client) => {
      const page = await one(client, 'SELECT id FROM cms_pages WHERE id = $1', [id]);
      if (!page) throw notFound();
      const component = await one<{ id: string; field_schema: FieldSchema; variants: string[] }>(client, 'SELECT id, field_schema, variants FROM cms_components WHERE code = $1 AND active', [body.componentCode]);
      if (!component) throw badRequest('کامپوننت موردنظر تعریف نشده است.');
      // Req 180: a new section can start from a Preset (variant + presentational fields + style tokens).
      const preset = body.presetCode ? await one<{ variant: string; payload: Record<string, unknown>; style_overrides: Record<string, unknown>; responsive_config: Record<string, unknown> }>(client,
        'SELECT variant, payload, style_overrides, responsive_config FROM cms_component_presets WHERE component_code = $1 AND code = $2', [body.componentCode, body.presetCode]) : null;
      if (body.presetCode && !preset) throw badRequest('Preset انتخاب‌شده برای این کامپوننت تعریف نشده است.');
      const payload = validateSectionPayload(component.field_schema, { ...(preset?.payload ?? {}), ...body.payload });
      const position = await one<{ next: number }>(client,
        'SELECT COALESCE(max(position), 0) + 1 AS next FROM cms_sections WHERE page_id = $1', [id]);
      const sectionId = randomUUID();
      await client.query(
        `INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position,variant,preset,style_overrides,responsive_config)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [sectionId, id, component.id, body.title, JSON.stringify(payload), body.visible, position!.next, preset?.variant ?? component.variants?.[0] ?? 'default',
          body.presetCode ?? null, JSON.stringify(preset ? validateStyleOverrides(preset.style_overrides) : {}), JSON.stringify(preset?.responsive_config ?? {})]);
      await audit(client, user.id, 'cms.section_added', 'cms_section', sectionId, undefined, { pageId: id, ...body, payload }, request.ip);
      return reply.code(201).send({ id: sectionId, position: position!.next, ...body, payload });
    });
  });

  app.patch('/api/v1/admin/cms/sections/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cms:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().max(160).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      visible: z.boolean().optional(),
      variant: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown> & { field_schema: FieldSchema; variants: string[] }>(client,
        'SELECT s.*, c.field_schema, c.variants FROM cms_sections s JOIN cms_components c ON c.id = s.component_id WHERE s.id = $1 FOR UPDATE OF s', [id]);
      if (!before) throw notFound();
      // Req 175-176: payload is validated against the component's typed Field Schema — no free JSON.
      const payload = body.payload ? validateSectionPayload(before.field_schema, body.payload) : null;
      if (body.variant && !(before.variants ?? []).includes(body.variant)) throw badRequest('این Variant برای کامپوننت ثبت نشده است.');
      await client.query(
        'UPDATE cms_sections SET title = COALESCE($2, title), payload = COALESCE($3, payload), visible = COALESCE($4, visible), variant = COALESCE($5, variant), updated_at = now() WHERE id = $1',
        [id, body.title ?? null, payload ? JSON.stringify(payload) : null, body.visible ?? null, body.variant ?? null]);
      const { field_schema: _schema, variants: _variants, ...beforeRow } = before;
      await audit(client, user.id, 'cms.section_updated', 'cms_section', id, beforeRow, { ...body, payload: payload ?? undefined }, request.ip);
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
