import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, notFound } from './errors.js';
import { commerceProductsByIds, mediaUrl } from './commerce-view.js';

/* SEO Domain (Req 235). Pages, categories, vibes, collections and products are *connected* to this
   domain; the CMS does not own SEO. Every storefront surface asks this module for a resolved
   head (title, description, canonical, robots, social, JSON-LD). */

export const SEO_ENTITY_TYPES = ['page', 'category', 'vibe', 'collection', 'product'] as const;
export type SeoEntityType = typeof SEO_ENTITY_TYPES[number];

export type SeoEntry = {
  title?: string | null; description?: string | null; canonical_path?: string | null;
  robots_index?: boolean; robots_follow?: boolean; og_title?: string | null; og_description?: string | null;
  og_image?: string | null; twitter_card?: string; schema_type?: string | null; schema_extra?: Record<string, unknown>;
  version?: number; updated_at?: string;
};

/** What the SEO Domain knows about the underlying business entity (never duplicated into SEO rows). */
export type SeoSubject = {
  type: SeoEntityType; key: string; name: string; description: string; path: string; image: string | null;
  active: boolean; pageType?: string;
  product?: { priceRial: string; available: number; brand: string; category: string; rating: number; reviewCount: number; sku?: string };
};

export type ResolvedSeo = {
  entityType: SeoEntityType; entityKey: string;
  title: string; description: string; canonical: string; robots: string; index: boolean;
  og: { title: string; description: string; image: string | null; url: string; type: string; siteName: string; locale: string };
  twitter: { card: string; title: string; description: string; image: string | null };
  jsonLd: Record<string, unknown>[];
  source: 'seo_domain' | 'derived';
  version: number | null;
};

export const SITE_NAME = 'کلبه وینتج';
const TITLE_SUFFIX = ` | ${SITE_NAME}`;
const SCHEMA_TYPES = ['WebPage', 'AboutPage', 'ContactPage', 'CollectionPage', 'ItemPage', 'Product', 'Organization'] as const;

/** Canonical path conventions per entity type (the storefront deep-links these paths). */
export function defaultPath(type: SeoEntityType, key: string, pagePath?: string): string {
  if (type === 'page') return pagePath && pagePath.startsWith('/') ? pagePath : `/${key}`;
  if (type === 'category') return `/category/${key}`;
  if (type === 'vibe') return `/vibe/${key}`;
  if (type === 'collection') return `/collection/${key}`;
  return `/product/${key}`;
}

const clip = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`);
const plain = (value: string) => value.replace(/\s+/g, ' ').trim();

export function absoluteUrl(origin: string, pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  if (/^https:\/\//.test(pathOrUrl)) return pathOrUrl;
  if (!pathOrUrl.startsWith('/')) return null;
  return `${origin.replace(/\/+$/, '')}${pathOrUrl}`;
}

const JSONLD_FORBIDDEN_KEYS = new Set(['@context', '__proto__', 'constructor', 'prototype']);

/** Validates an SEO write. Hard errors reject, soft warnings are returned for the editor (snippet health). */
export function validateSeoInput(input: SeoEntry, origin: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = [];
  const unsafe = /<\s*\/?\s*[a-z!]|javascript:|data:text\/html/i;
  for (const [field, value] of Object.entries({ title: input.title, description: input.description, og_title: input.og_title, og_description: input.og_description })) {
    if (typeof value === 'string' && unsafe.test(value)) errors.push(`فیلد ${field} نباید شامل HTML یا اسکریپت باشد.`);
  }
  if (input.title) {
    const len = [...input.title].length;
    if (len < 10) warnings.push('عنوان سئو کوتاه است (کمتر از ۱۰ کاراکتر).');
    if (len > 65) warnings.push('عنوان سئو بلند است و در نتایج گوگل بریده می‌شود (بیش از ۶۵ کاراکتر).');
  } else warnings.push('عنوان سئو تعیین نشده؛ از نام موجودیت استفاده می‌شود.');
  if (input.description) {
    const len = [...input.description].length;
    if (len < 50) warnings.push('توضیح متا کوتاه است (کمتر از ۵۰ کاراکتر).');
    if (len > 160) warnings.push('توضیح متا بلند است (بیش از ۱۶۰ کاراکتر).');
  } else warnings.push('توضیح متا تعیین نشده؛ از توضیح موجودیت استفاده می‌شود.');
  if (input.canonical_path) {
    const c = input.canonical_path;
    if (c.startsWith('/')) {
      if (c.startsWith('//') || /\s/.test(c)) errors.push('Canonical نامعتبر است.');
    } else if (/^https:\/\//.test(c)) {
      try { if (new URL(c).host !== new URL(origin).host) warnings.push('Canonical به دامنه دیگری اشاره می‌کند.'); } catch { errors.push('Canonical نامعتبر است.'); }
    } else errors.push('Canonical باید مسیر نسبی (با / شروع شود) یا آدرس https باشد.');
  }
  if (input.og_image && !(input.og_image.startsWith('/api/v1/media/') || /^https:\/\//.test(input.og_image))) {
    errors.push('تصویر شبکه اجتماعی باید از کتابخانه رسانه یا یک آدرس https باشد.');
  }
  if (input.schema_type && !(SCHEMA_TYPES as readonly string[]).includes(input.schema_type)) errors.push(`نوع Schema «${input.schema_type}» پشتیبانی نمی‌شود.`);
  if (input.schema_extra) {
    const text = JSON.stringify(input.schema_extra);
    if (text.length > 8000) errors.push('داده Schema بیش از ۸ کیلوبایت است.');
    if (/<\/?script|<!--/i.test(text)) errors.push('داده Schema نباید شامل تگ اسکریپت باشد.');
    const walk = (value: unknown, depth: number): void => {
      if (depth > 6) { errors.push('عمق داده Schema بیش از حد است.'); return; }
      if (Array.isArray(value)) value.forEach((v) => walk(v, depth + 1));
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
        if (JSONLD_FORBIDDEN_KEYS.has(k)) errors.push(`کلید «${k}» در Schema مجاز نیست.`);
        walk(v, depth + 1);
      }
    };
    walk(input.schema_extra, 0);
  }
  if (input.robots_index === false) warnings.push('این صفحه noindex است و در نتایج جست‌وجو نمایش داده نمی‌شود.');
  return { errors: [...new Set(errors)], warnings };
}

/** Pure resolver: SEO Domain entry (optional) + business subject → head tags. Deterministic & testable. */
export function resolveSeo(subject: SeoSubject, entry: SeoEntry | null, origin: string): ResolvedSeo {
  const baseTitle = plain(entry?.title || subject.name || SITE_NAME);
  const title = baseTitle.includes(SITE_NAME) ? baseTitle : `${baseTitle}${TITLE_SUFFIX}`;
  const description = clip(plain(entry?.description || subject.description || `${subject.name} در ${SITE_NAME}؛ پوشاک کلاسیک و مدرن با ارسال سریع و پرداخت اقساطی.`), 160);
  const path = entry?.canonical_path || subject.path;
  const canonical = absoluteUrl(origin, path) ?? absoluteUrl(origin, subject.path)!;
  // Inactive / unpublished entities are never indexable, whatever the entry says.
  const index = subject.active && entry?.robots_index !== false;
  const follow = entry?.robots_follow !== false;
  const robots = `${index ? 'index' : 'noindex'},${follow ? 'follow' : 'nofollow'}`;
  const image = absoluteUrl(origin, entry?.og_image || subject.image);
  const ogTitle = plain(entry?.og_title || baseTitle);
  const ogDescription = clip(plain(entry?.og_description || description), 200);

  const schemaType = entry?.schema_type || (subject.type === 'product' ? 'Product'
    : subject.type === 'page' ? (subject.pageType === 'about' ? 'AboutPage' : 'WebPage') : 'CollectionPage');
  const primary: Record<string, unknown> = { '@context': 'https://schema.org', '@type': schemaType, name: baseTitle, description, url: canonical };
  if (image) primary.image = image;
  if (schemaType === 'Product' && subject.product) {
    const p = subject.product;
    Object.assign(primary, {
      brand: { '@type': 'Brand', name: p.brand || SITE_NAME }, category: p.category, ...(p.sku ? { sku: p.sku } : {}),
      offers: { '@type': 'Offer', priceCurrency: 'IRR', price: p.priceRial, url: canonical,
        availability: p.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
      ...(p.reviewCount > 0 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(p.rating.toFixed(1)), reviewCount: p.reviewCount } } : {}),
    });
  }
  const extra = entry?.schema_extra ?? {};
  for (const [k, v] of Object.entries(extra)) if (!JSONLD_FORBIDDEN_KEYS.has(k) && k !== '@type') primary[k] = v;
  const crumbs: { name: string; url: string }[] = [{ name: SITE_NAME, url: absoluteUrl(origin, '/')! }];
  if (subject.type === 'category' || subject.type === 'collection' || subject.type === 'vibe') crumbs.push({ name: baseTitle, url: canonical });
  if (subject.type === 'product') {
    if (subject.product?.category) crumbs.push({ name: subject.product.category, url: absoluteUrl(origin, '/shop')! });
    crumbs.push({ name: baseTitle, url: canonical });
  }
  if (subject.type === 'page' && subject.path !== '/') crumbs.push({ name: baseTitle, url: canonical });
  const jsonLd: Record<string, unknown>[] = [primary];
  if (crumbs.length > 1) jsonLd.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) });

  return {
    entityType: subject.type, entityKey: subject.key, title, description, canonical, robots, index,
    og: { title: ogTitle, description: ogDescription, image, url: canonical, type: subject.type === 'product' ? 'product' : 'website', siteName: SITE_NAME, locale: 'fa_IR' },
    twitter: { card: entry?.twitter_card || (image ? 'summary_large_image' : 'summary'), title: ogTitle, description: ogDescription, image },
    jsonLd, source: entry ? 'seo_domain' : 'derived', version: entry?.version ?? null,
  };
}

/** Serialises JSON-LD safely for embedding in a <script type="application/ld+json"> tag. */
export function jsonLdString(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

/* ============================ Data access ============================ */

type Queryable = DbPool | PoolClient;

export async function loadSubject(db: Queryable, type: SeoEntityType, key: string): Promise<SeoSubject | null> {
  if (type === 'page') {
    const r = await one<{ code: string; title: string; description: string; path: string; page_type: string; status: string; active: boolean; hero: string | null }>(db,
      `SELECT p.code, p.title, p.description, p.path, p.page_type, p.status, p.active,
              (SELECT COALESCE(s.payload->>'imageUrl', s.payload->>'image', s.payload->>'backgroundImage') FROM cms_sections s WHERE s.page_id = p.id AND s.visible ORDER BY s.position LIMIT 1) AS hero
       FROM cms_pages p WHERE p.code = $1`, [key]);
    if (!r) return null;
    return { type, key, name: r.title, description: r.description ?? '', path: defaultPath('page', r.code, r.path), image: mediaUrl(r.hero),
      active: r.active && r.status === 'published', pageType: r.page_type };
  }
  if (type === 'category' || type === 'vibe') {
    const table = type === 'category' ? 'cms_categories' : 'cms_vibes';
    const imageCol = type === 'category' ? 'COALESCE(cover_url, image_url)' : 'cover_url';
    const r = await one<{ slug: string; name: string; description: string; active: boolean; image: string | null }>(db,
      `SELECT slug, name, description, active, ${imageCol} AS image FROM ${table} WHERE slug = $1`, [key]);
    if (!r) return null;
    return { type, key, name: r.name, description: r.description ?? '', path: defaultPath(type, r.slug), image: mediaUrl(r.image), active: r.active };
  }
  if (type === 'collection') {
    const r = await one<{ code: string; title: string; description: string; active: boolean }>(db,
      'SELECT code, title, description, active FROM cms_collections WHERE code = $1', [key]);
    if (!r) return null;
    return { type, key, name: r.title, description: r.description ?? '', path: defaultPath('collection', r.code), image: null, active: r.active };
  }
  if (!/^[0-9a-f-]{36}$/i.test(key)) return null;
  const meta = await one<{ status: string; description: string | null; metadata: Record<string, unknown> }>(db,
    'SELECT status, description, metadata FROM products WHERE id = $1', [key]);
  if (!meta) return null;
  const [product] = await commerceProductsByIds(db, [key]);
  if (!product) return null;
  const seoTitle = typeof meta.metadata?.seoTitle === 'string' ? meta.metadata.seoTitle : '';
  return {
    type, key, name: seoTitle || product.name, description: meta.description ?? '', path: defaultPath('product', key), image: product.image,
    active: meta.status === 'published',
    product: { priceRial: product.priceRial, available: product.available, brand: product.brand, category: product.category,
      rating: product.rating, reviewCount: product.reviewCount, sku: product.variants[0]?.sku },
  };
}

export async function loadEntry(db: Queryable, type: SeoEntityType, key: string): Promise<(SeoEntry & { id: string }) | null> {
  return one(db, 'SELECT * FROM seo_entries WHERE entity_type = $1 AND entity_key = $2', [type, key]);
}

export async function resolveSeoFor(db: Queryable, type: SeoEntityType, key: string, origin: string): Promise<ResolvedSeo | null> {
  const subject = await loadSubject(db, type, key);
  if (!subject) return null;
  return resolveSeo(subject, await loadEntry(db, type, key), origin);
}

export const seoWriteSchema = z.object({
  title: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(320).nullable().optional(),
  canonicalPath: z.string().trim().max(300).nullable().optional(),
  robotsIndex: z.boolean().optional(),
  robotsFollow: z.boolean().optional(),
  ogTitle: z.string().trim().max(120).nullable().optional(),
  ogDescription: z.string().trim().max(320).nullable().optional(),
  ogImage: z.string().trim().max(400).nullable().optional(),
  twitterCard: z.enum(['summary', 'summary_large_image']).optional(),
  schemaType: z.string().trim().max(40).nullable().optional(),
  schemaExtra: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict();
export type SeoWrite = z.infer<typeof seoWriteSchema>;

const toEntry = (w: SeoWrite, current: SeoEntry | null): SeoEntry => ({
  title: w.title !== undefined ? (w.title || null) : current?.title ?? null,
  description: w.description !== undefined ? (w.description || null) : current?.description ?? null,
  canonical_path: w.canonicalPath !== undefined ? (w.canonicalPath || null) : current?.canonical_path ?? null,
  robots_index: w.robotsIndex ?? current?.robots_index ?? true,
  robots_follow: w.robotsFollow ?? current?.robots_follow ?? true,
  og_title: w.ogTitle !== undefined ? (w.ogTitle || null) : current?.og_title ?? null,
  og_description: w.ogDescription !== undefined ? (w.ogDescription || null) : current?.og_description ?? null,
  og_image: w.ogImage !== undefined ? (w.ogImage || null) : current?.og_image ?? null,
  twitter_card: w.twitterCard ?? current?.twitter_card ?? 'summary_large_image',
  schema_type: w.schemaType !== undefined ? (w.schemaType || null) : current?.schema_type ?? null,
  schema_extra: w.schemaExtra ?? current?.schema_extra ?? {},
});

/** The only write path into SEO data. Other domains (CMS create forms) call this inside their own transaction. */
export async function upsertSeoEntry(client: PoolClient, type: SeoEntityType, key: string, write: SeoWrite, actorId: string | null, origin: string, ip?: string) {
  const current = await one<SeoEntry & { id: string; version: number }>(client,
    'SELECT * FROM seo_entries WHERE entity_type = $1 AND entity_key = $2 FOR UPDATE', [type, key]);
  if (write.expectedVersion && current && current.version !== write.expectedVersion) {
    throw badRequest('این تنظیمات سئو هم‌زمان توسط کاربر دیگری تغییر کرده است؛ صفحه را تازه کنید.');
  }
  const next = toEntry(write, current);
  const { errors, warnings } = validateSeoInput(next, origin);
  if (errors.length) throw badRequest(errors.join(' '));
  const id = current?.id ?? randomUUID();
  const version = (current?.version ?? 0) + 1;
  await client.query(`INSERT INTO seo_entries(id, entity_type, entity_key, title, description, canonical_path, robots_index, robots_follow,
        og_title, og_description, og_image, twitter_card, schema_type, schema_extra, version, updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (entity_type, entity_key) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
        canonical_path = EXCLUDED.canonical_path, robots_index = EXCLUDED.robots_index, robots_follow = EXCLUDED.robots_follow,
        og_title = EXCLUDED.og_title, og_description = EXCLUDED.og_description, og_image = EXCLUDED.og_image,
        twitter_card = EXCLUDED.twitter_card, schema_type = EXCLUDED.schema_type, schema_extra = EXCLUDED.schema_extra,
        version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, type, key, next.title, next.description, next.canonical_path, next.robots_index, next.robots_follow, next.og_title,
      next.og_description, next.og_image, next.twitter_card, next.schema_type, JSON.stringify(next.schema_extra ?? {}), version, actorId]);
  await client.query('INSERT INTO seo_entry_versions(id, entry_id, version, snapshot, changed_by) VALUES ($1,$2,$3,$4,$5)',
    [randomUUID(), id, version, JSON.stringify(next), actorId]);
  await audit(client, actorId, 'seo.updated', `seo_${type}`, key, current ?? undefined, next, ip);
  await outbox(client, 'seo.updated', 'seo_entry', id, { entityType: type, entityKey: key, version, index: next.robots_index });
  return { id, version, warnings };
}

/** Maps the loose `seo` object older CMS forms still send into a SEO Domain write (or null if empty). */
export function legacySeoToWrite(seo: Record<string, unknown> | undefined | null): SeoWrite | null {
  if (!seo) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const write: SeoWrite = {};
  if (str(seo.title)) write.title = str(seo.title);
  if (str(seo.description)) write.description = str(seo.description);
  if (str(seo.canonical)) write.canonicalPath = str(seo.canonical);
  if (typeof seo.index === 'boolean') write.robotsIndex = seo.index;
  return Object.keys(write).length ? write : null;
}

/** Keeps SEO rows attached when a CMS slug/code changes (the entity stays the same, its key moves). */
export async function renameSeoKey(client: PoolClient, type: SeoEntityType, fromKey: string, toKey: string) {
  if (fromKey === toKey) return;
  await client.query('UPDATE seo_entries SET entity_key = $3, updated_at = now() WHERE entity_type = $1 AND entity_key = $2', [type, fromKey, toKey]);
}

type Listed = { type: SeoEntityType; key: string; name: string; active: boolean };

async function listSubjects(db: Queryable, type?: SeoEntityType): Promise<Listed[]> {
  const parts: Listed[] = [];
  const want = (t: SeoEntityType) => !type || type === t;
  if (want('page')) parts.push(...(await db.query(`SELECT code AS key, title AS name, (active AND status = 'published') AS active FROM cms_pages ORDER BY title`)).rows.map((r) => ({ type: 'page' as const, ...r })));
  if (want('category')) parts.push(...(await db.query('SELECT slug AS key, name, active FROM cms_categories ORDER BY position, name')).rows.map((r) => ({ type: 'category' as const, ...r })));
  if (want('vibe')) parts.push(...(await db.query('SELECT slug AS key, name, active FROM cms_vibes ORDER BY position, name')).rows.map((r) => ({ type: 'vibe' as const, ...r })));
  if (want('collection')) parts.push(...(await db.query('SELECT code AS key, title AS name, active FROM cms_collections ORDER BY title')).rows.map((r) => ({ type: 'collection' as const, ...r })));
  if (want('product')) parts.push(...(await db.query(`SELECT id::text AS key, name, status = 'published' AS active FROM products ORDER BY created_at DESC LIMIT 500`)).rows.map((r) => ({ type: 'product' as const, ...r })));
  return parts;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ============================ Routes ============================ */

export function registerSeoRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const origin = config.PUBLIC_ORIGIN;
  const typeParam = z.enum(SEO_ENTITY_TYPES);
  const actor = async (request: Parameters<typeof principal>[0]) => {
    const user = await principal(request, pool, config); requirePermission(user, 'seo:manage'); return user;
  };

  app.get('/api/v1/seo/:type/:key', async (request, reply) => {
    const { type, key } = z.object({ type: typeParam, key: z.string().trim().min(1).max(80) }).parse(request.params);
    const resolved = await resolveSeoFor(pool, type, key, origin);
    if (!resolved) throw notFound();
    return reply.header('Cache-Control', 'public, max-age=60').send(resolved);
  });

  app.get('/api/v1/seo/sitemap.xml', async (_request, reply) => {
    const noindex = new Set((await pool.query(`SELECT entity_type || ':' || entity_key AS k FROM seo_entries WHERE NOT robots_index`)).rows.map((r) => r.k as string));
    const pages = (await pool.query(`SELECT code, path, updated_at FROM cms_pages WHERE active AND status = 'published'`)).rows;
    const urls: { loc: string; lastmod?: string }[] = [];
    for (const p of pages) if (!noindex.has(`page:${p.code}`)) urls.push({ loc: absoluteUrl(origin, defaultPath('page', p.code, p.path))!, lastmod: new Date(p.updated_at).toISOString() });
    for (const [type, sql] of [['category', 'SELECT slug AS k FROM cms_categories WHERE active'], ['vibe', 'SELECT slug AS k FROM cms_vibes WHERE active'],
      ['collection', 'SELECT code AS k FROM cms_collections WHERE active'], ['product', `SELECT id::text AS k FROM products WHERE status = 'published'`]] as const) {
      for (const r of (await pool.query(sql)).rows) if (!noindex.has(`${type}:${r.k}`)) urls.push({ loc: absoluteUrl(origin, defaultPath(type, r.k))! });
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...new Map(urls.map((u) => [u.loc, u])).values()]
      .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
    return reply.header('Content-Type', 'application/xml; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(body);
  });

  app.get('/api/v1/seo/robots.txt', async (_request, reply) => reply.header('Content-Type', 'text/plain; charset=utf-8')
    .send(`User-agent: *\nDisallow: /api/\nDisallow: /#/admin\nDisallow: /#/supplier\nAllow: /\nSitemap: ${absoluteUrl(origin, '/api/v1/seo/sitemap.xml')}\n`));

  /* ---------- Admin ---------- */
  app.get('/api/v1/admin/seo', async (request) => {
    await actor(request);
    const { type } = z.object({ type: typeParam.optional() }).parse(request.query);
    const subjects = await listSubjects(pool, type);
    const entries = new Map((await pool.query('SELECT * FROM seo_entries')).rows.map((r) => [`${r.entity_type}:${r.entity_key}`, r as SeoEntry]));
    return {
      items: subjects.map((s) => {
        const entry = entries.get(`${s.type}:${s.key}`) ?? null;
        const { warnings } = validateSeoInput(entry ?? {}, origin);
        return { ...s, hasEntry: Boolean(entry), title: entry?.title ?? null, index: entry?.robots_index ?? true, version: entry?.version ?? null,
          health: warnings.length === 0 ? 'good' : warnings.length <= 1 ? 'fair' : 'poor', warnings };
      }),
    };
  });

  app.get('/api/v1/admin/seo/:type/:key', async (request) => {
    await actor(request);
    const { type, key } = z.object({ type: typeParam, key: z.string().trim().min(1).max(80) }).parse(request.params);
    const subject = await loadSubject(pool, type, key);
    if (!subject) throw notFound();
    const entry = await loadEntry(pool, type, key);
    const history = entry ? (await pool.query('SELECT version, snapshot, changed_by, created_at FROM seo_entry_versions WHERE entry_id = $1 ORDER BY version DESC LIMIT 20', [entry.id])).rows : [];
    return { subject, entry, resolved: resolveSeo(subject, entry, origin), check: validateSeoInput(entry ?? {}, origin), history };
  });

  app.post('/api/v1/admin/seo/:type/:key/preview', async (request) => {
    await actor(request);
    const { type, key } = z.object({ type: typeParam, key: z.string().trim().min(1).max(80) }).parse(request.params);
    const subject = await loadSubject(pool, type, key);
    if (!subject) throw notFound();
    const entry = toEntry(seoWriteSchema.parse(request.body ?? {}), await loadEntry(pool, type, key));
    return { resolved: resolveSeo(subject, entry, origin), check: validateSeoInput(entry, origin) };
  });

  app.put('/api/v1/admin/seo/:type/:key', async (request) => {
    const user = await actor(request);
    const { type, key } = z.object({ type: typeParam, key: z.string().trim().min(1).max(80) }).parse(request.params);
    const body = seoWriteSchema.parse(request.body ?? {});
    const subject = await loadSubject(pool, type, key);
    if (!subject) throw notFound();
    const saved = await transaction(pool, (client) => upsertSeoEntry(client, type, key, body, user.id, origin, request.ip));
    return { ...saved, resolved: await resolveSeoFor(pool, type, key, origin) };
  });
}
