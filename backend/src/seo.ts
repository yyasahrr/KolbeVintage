import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { ApiError, badRequest, conflict, notFound } from './errors.js';
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
/** The brand is written both «وینتج» and «وینتیج» (and in Latin); never append it twice. */
const BRAND_IN_TITLE = /کلبه\s*وینت\u06cc?ج|kolbe/i;
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
  const title = BRAND_IN_TITLE.test(baseTitle) ? baseTitle : `${baseTitle}${TITLE_SUFFIX}`;
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

/** SEO Center owns public metadata; the older SEO Domain supplies fields it has not set. */
export async function loadEffectiveSeoEntry(db: Queryable, type: SeoEntityType, key: string): Promise<SeoEntry | null> {
  const core = await loadEntry(db, type, key);
  const kind = type === 'page' ? 'cms' : type;
  const page = await one<{ seo_title: string; meta_description: string; slug: string; canonical_url: string;
    is_indexable: boolean; is_followable: boolean; social_title: string; social_description: string;
    social_image_url: string; schema_override: Record<string, unknown>; version: number }>(db,
    'SELECT * FROM seo_pages WHERE entity_type=$1 AND entity_key=$2', [kind, key]);
  if (!page) return core;
  return {
    ...core,
    title: page.seo_title || core?.title,
    description: page.meta_description || core?.description,
    canonical_path: page.canonical_url || page.slug || core?.canonical_path,
    robots_index: page.is_indexable, robots_follow: page.is_followable,
    og_title: page.social_title || core?.og_title,
    og_description: page.social_description || core?.og_description,
    og_image: page.social_image_url || core?.og_image,
    schema_extra: { ...(core?.schema_extra ?? {}), ...(page.schema_override ?? {}) },
    version: page.version,
  };
}

export async function resolveSeoFor(db: Queryable, type: SeoEntityType, key: string, origin: string): Promise<ResolvedSeo | null> {
  let subject = await loadSubject(db, type, key);
  if (!subject) return null;
  if (type === 'page') {
    const live = await one<{ title: string; description: string; path: string; sections_snapshot: { payload?: { image?: string } }[] }>(db, `SELECT v.* FROM cms_pages p
      JOIN LATERAL (SELECT * FROM cms_page_versions WHERE page_id=p.id AND status IN ('published','scheduled') AND (starts_at IS NULL OR starts_at<=now()) ORDER BY version DESC LIMIT 1) v ON true
      WHERE p.code=$1 AND p.status IN ('published','scheduled') AND v.active AND (v.ends_at IS NULL OR v.ends_at>now())`, [key]);
    if (!live) return null;
    subject = { ...subject, name: live.title, description: live.description, path: defaultPath('page', key, live.path), image: mediaUrl(live.sections_snapshot.find(s => s.payload?.image)?.payload?.image), active: true };
  }
  return resolveSeo(subject, await loadEffectiveSeoEntry(db, type, key), origin);
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

async function assertEditorialPublication(db: Queryable, id: string, slug: string, status: string) {
  if (status !== 'published') return;
  await db.query("SELECT pg_advisory_xact_lock(hashtext('editorial-publication-slugs'))");
  if (await one(db, "SELECT id FROM editorial_posts WHERE id<>$1 AND publication_enabled AND published_snapshot->>'slug'=$2 LIMIT 1", [id,slug]))
    throw conflict('نشانی مطلب با نسخه منتشرشده دیگری تداخل دارد.');
}

function registerSeoRoutesCore(app: FastifyInstance, pool: DbPool, config: Config) {
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
    const pages = (await pool.query(`SELECT p.code,v.path,v.created_at AS updated_at FROM cms_pages p JOIN LATERAL (SELECT * FROM cms_page_versions WHERE page_id=p.id AND status IN ('published','scheduled') AND (starts_at IS NULL OR starts_at<=now()) ORDER BY version DESC LIMIT 1) v ON true WHERE p.status IN ('published','scheduled') AND v.active AND (v.ends_at IS NULL OR v.ends_at>now())`)).rows;
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
import { createObjectStorage } from './storage.js';


const entityType = z.enum(['site','product','category','brand','blog','cms','landing']);
const seoBody = z.object({
  seoTitle: z.string().max(300).default(''), metaDescription: z.string().max(1000).default(''),
  slug: z.string().max(1000).default(''), canonicalUrl: z.string().max(2000).default(''),
  isIndexable: z.boolean().default(true), isFollowable: z.boolean().default(true),
  socialTitle: z.string().max(300).default(''), socialDescription: z.string().max(1000).default(''),
  socialImageUrl: z.string().max(2000).default(''), schemaOverride: z.record(z.string(), z.unknown()).default({}),
});
/** Redirects are application paths only. Reject URL authority, escaping and encoded separators. */
export function isInternalRedirectPath(value: string): boolean {
  return value === '/' || /^\/[\p{L}\p{N}._~-]+(?:\/[\p{L}\p{N}._~-]+)*\/?$/u.test(value);
}
const redirectBody = z.object({ sourcePath: z.string().max(2000).refine(isInternalRedirectPath), targetPath: z.string().max(2000).refine(isInternalRedirectPath).nullable(), statusCode: z.union([z.literal(301),z.literal(302),z.literal(410)]), active: z.boolean().default(true) }).refine((v) => v.statusCode === 410 ? v.targetPath === null : !!v.targetPath);
const postBody = z.object({ postType: z.enum(['article','video']), slug: z.string().trim().min(1).max(250).regex(/^[\p{L}\p{N}._-]+$/u), title: z.string().trim().min(1).max(300), excerpt: z.string().max(2000).default(''), body: z.string().max(200000).default(''), coverUrl: z.string().max(2000).default(''), author: z.string().max(200).default(''), category: z.string().max(150).default(''), tags: z.array(z.string().max(100)).max(50).default([]), sourceType: z.enum(['youtube','direct','external']).nullable().default(null), sourceUrl: z.string().max(3000).default(''), durationSeconds: z.number().int().nonnegative().nullable().default(null), seoTitle: z.string().max(300).default(''), seoDescription: z.string().max(1000).default(''), relatedProductIds: z.array(z.uuid()).max(100).default([]), status: z.enum(['draft','published','archived']).default('draft'), expectedVersion:z.number().int().positive().optional() }).refine((p) => p.postType !== 'video' || (!!p.sourceType && p.sourceUrl.startsWith('https://')), 'ویدیو باید منبع HTTPS داشته باشد.');
const mediaBody = z.object({ mediaType: z.enum(['image','video','pdf']), sourceType: z.enum(['object_storage','youtube','external']), storageKey: z.string().max(1000).default(''), publicUrl: z.url().max(3000), mimeType: z.string().max(150).default(''), byteSize: z.number().int().nonnegative().nullable().default(null), width: z.number().int().positive().nullable().default(null), height: z.number().int().positive().nullable().default(null), durationSeconds: z.number().int().nonnegative().nullable().default(null), altText: z.string().max(500).default(''), title: z.string().max(300).default(''), caption: z.string().max(1000).default(''), fileName: z.string().max(500).default(''), metadata: z.record(z.string(), z.unknown()).default({}) });
const publicUrl = (value: string) => { try { const url = new URL(value); return url.protocol === 'https:'; } catch { return false; } };

function registerD2SeoRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const objectStorage=createObjectStorage(config);
  app.addHook('onRequest',async(request,reply)=>{
    if(request.method!=='GET'||request.url.startsWith('/api/')||request.url.startsWith('/health/'))return;
    const original=request.url.split('?')[0]||'/';let current=original;let status=301;const visited=new Set<string>();
    for(let hop=0;hop<20;hop++){
      if(visited.has(current)){reply.code(508).send({code:'REDIRECT_LOOP'});return reply;}visited.add(current);
      const match=await pool.query('UPDATE seo_redirects SET hit_count=hit_count+1,updated_at=now() WHERE source_path=$1 AND active RETURNING target_path,status_code',[current]);
      const redirect=match.rows[0];if(!redirect){if(current!==original){reply.code(status).header('Location',current).send();return reply;}return;}
      if(Number(redirect.status_code)===410){reply.code(410).send();return reply;}
      if(hop===0)status=Number(redirect.status_code);if(!redirect.target_path){reply.code(410).send();return reply;}if(!isInternalRedirectPath(String(redirect.target_path))){reply.code(400).send({code:'INVALID_REDIRECT_TARGET'});return reply;}current=String(redirect.target_path);
    }
    reply.code(508).send({code:'REDIRECT_HOP_LIMIT'});return reply;
  });
  app.addHook('onResponse',async(request,reply)=>{
    if(request.method!=='GET'||reply.statusCode!==404||request.url.startsWith('/api/')||request.url.startsWith('/health/'))return;
    const path=(request.url.split('?')[0]||'/').slice(0,2000);const referrer=String(request.headers.referer??'').slice(0,2048);
    await pool.query(`INSERT INTO seo_not_found_hits(path,last_referrer) VALUES($1,$2) ON CONFLICT(path,hit_day) DO UPDATE SET hit_count=seo_not_found_hits.hit_count+1,last_seen_at=now(),last_referrer=EXCLUDED.last_referrer`,[path,referrer]);
  });
  app.get('/api/v1/admin/seo/pages', async (request) => {
    const user = await principal(request,pool,config); requirePermission(user,'seo:read');
    const query=z.object({entityType:entityType.optional(),q:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);
    const rows=await pool.query(`SELECT entity_type,entity_key,seo_title,meta_description,slug,canonical_url,is_indexable,is_followable,social_title,social_description,social_image_url,schema_override,version,updated_by,updated_at FROM seo_pages WHERE ($1::text IS NULL OR entity_type=$1) AND ($2::text IS NULL OR entity_key ILIKE '%'||$2||'%' OR seo_title ILIKE '%'||$2||'%') ORDER BY entity_type,entity_key LIMIT $3`,[query.entityType??null,query.q??null,query.limit]);
    return {items:rows.rows};
  });
  app.put('/api/v1/admin/seo/pages/:entityType/:entityKey',async(request)=>{
    const user=await principal(request,pool,config);requirePermission(user,'seo:manage');
    const {entityType:kind,entityKey}=z.object({entityType,entityKey:z.string().min(1).max(300)}).parse(request.params);const body=seoBody.parse(request.body);
    if(body.slug && !body.slug.startsWith('/')) throw badRequest('Slug باید با / شروع شود.');
    if(body.canonicalUrl && !publicUrl(body.canonicalUrl)) throw badRequest('Canonical باید HTTPS معتبر باشد.');
    if(body.socialImageUrl && !publicUrl(body.socialImageUrl)) throw badRequest('آدرس تصویر اجتماعی باید HTTPS باشد.');
    return transaction(pool,async(client)=>{
      const old=await client.query('SELECT * FROM seo_pages WHERE entity_type=$1 AND entity_key=$2 FOR UPDATE',[kind,entityKey]);
      const oldValue=old.rows[0]??null;const version=(Number(oldValue?.version)||0)+1;
      const result=await client.query(`INSERT INTO seo_pages(entity_type,entity_key,seo_title,meta_description,slug,canonical_url,is_indexable,is_followable,social_title,social_description,social_image_url,schema_override,version,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(entity_type,entity_key) DO UPDATE SET seo_title=EXCLUDED.seo_title,meta_description=EXCLUDED.meta_description,slug=EXCLUDED.slug,canonical_url=EXCLUDED.canonical_url,is_indexable=EXCLUDED.is_indexable,is_followable=EXCLUDED.is_followable,social_title=EXCLUDED.social_title,social_description=EXCLUDED.social_description,social_image_url=EXCLUDED.social_image_url,schema_override=EXCLUDED.schema_override,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=now()
        RETURNING *`,[kind,entityKey,body.seoTitle,body.metaDescription,body.slug,body.canonicalUrl,body.isIndexable,body.isFollowable,body.socialTitle,body.socialDescription,body.socialImageUrl,JSON.stringify(body.schemaOverride),version,user.id]);
      await client.query('INSERT INTO seo_page_revisions(id,entity_type,entity_key,version,actor_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),kind,entityKey,version,user.id,oldValue?JSON.stringify(oldValue):null,JSON.stringify(result.rows[0])]);
      await audit(client,user.id,'seo.page.updated','seo_page',`${kind}:${entityKey}`,oldValue,result.rows[0],request.ip);
      if(kind==='product' && oldValue?.slug && oldValue.slug!==body.slug){await client.query(`INSERT INTO seo_redirects(id,source_path,target_path,status_code,created_by) VALUES($1,$2,$3,301,$4) ON CONFLICT(source_path) DO UPDATE SET target_path=EXCLUDED.target_path,status_code=301,active=true,updated_at=now()`,[randomUUID(),oldValue.slug,body.slug,user.id]);}
      return result.rows[0];
    });
  });
  app.get('/api/v1/admin/seo/revisions',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:read');const q=z.object({entityType:entityType.optional(),entityKey:z.string().max(300).optional(),limit:z.coerce.number().int().min(1).max(250).default(100)}).parse(request.query);const rows=await pool.query(`SELECT r.*,u.display_name AS actor_name FROM seo_page_revisions r LEFT JOIN users u ON u.id=r.actor_id WHERE ($1::text IS NULL OR r.entity_type=$1) AND ($2::text IS NULL OR r.entity_key=$2) ORDER BY r.created_at DESC LIMIT $3`,[q.entityType??null,q.entityKey??null,q.limit]);return{items:rows.rows};});
  app.get('/api/v1/admin/seo/redirects',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:redirects');const q=z.object({q:z.string().max(500).optional(),limit:z.coerce.number().int().min(1).max(500).default(200)}).parse(request.query);const rows=await pool.query(`SELECT * FROM seo_redirects WHERE ($1::text IS NULL OR source_path ILIKE '%'||$1||'%' OR target_path ILIKE '%'||$1||'%') ORDER BY created_at DESC LIMIT $2`,[q.q??null,q.limit]);return{items:rows.rows};});
  app.post('/api/v1/admin/seo/redirects',async(request,reply)=>{
    const user=await principal(request,pool,config);requirePermission(user,'seo:redirects');const b=redirectBody.parse(request.body);
    const saved=await transaction(pool,async(client)=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtext('kolbe_seo_redirects'))");
      if(b.targetPath){let current=b.targetPath;const visited=new Set([b.sourcePath]);for(let hop=0;hop<20;hop++){if(visited.has(current))throw badRequest('ریدایرکت حلقه‌ای مجاز نیست.');visited.add(current);const next=await client.query('SELECT target_path,status_code FROM seo_redirects WHERE source_path=$1 AND active',[current]);const row=next.rows[0];if(!row||Number(row.status_code)===410||!row.target_path)break;current=String(row.target_path);if(hop===19)throw badRequest('زنجیره ریدایرکت بیش از حد مجاز است.');}}
      const result=await client.query(`INSERT INTO seo_redirects(id,source_path,target_path,status_code,active,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_path) DO UPDATE SET target_path=EXCLUDED.target_path,status_code=EXCLUDED.status_code,active=EXCLUDED.active,updated_at=now() RETURNING *`,[randomUUID(),b.sourcePath,b.targetPath,b.statusCode,b.active,user.id]);return result.rows[0];
    });return reply.code(201).send(saved);
  });
  app.delete('/api/v1/admin/seo/redirects/:id',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:redirects');const{id}=z.object({id:z.uuid()}).parse(request.params);await pool.query('DELETE FROM seo_redirects WHERE id=$1',[id]);return reply.code(204).send();});
  app.get('/api/v1/public/seo/redirect',async(request)=>{const{path}=z.object({path:z.string().max(2000).refine(isInternalRedirectPath)}).parse(request.query);const result=await pool.query(`UPDATE seo_redirects SET hit_count=hit_count+1,updated_at=now() WHERE source_path=$1 AND active RETURNING target_path,status_code`,[path]);const row=result.rows[0];if(row?.target_path&&!isInternalRedirectPath(String(row.target_path)))throw badRequest('Redirect target نامعتبر است.');return row??null;});
  app.get('/api/v1/admin/seo/facets',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const rows=await pool.query('SELECT * FROM seo_facet_policies ORDER BY facet_key');return{items:rows.rows,executionStatus:'inactive'};});
  app.put('/api/v1/admin/seo/facets/:key',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const{key}=z.object({key:z.string().min(1).max(100)}).parse(request.params);const b=z.object({isIndexable:z.boolean(),crawlAllowed:z.boolean(),canonicalTarget:z.string().startsWith('/').max(2000)}).parse(request.body);const r=await pool.query(`INSERT INTO seo_facet_policies(facet_key,is_indexable,crawl_allowed,canonical_target,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(facet_key) DO UPDATE SET is_indexable=EXCLUDED.is_indexable,crawl_allowed=EXCLUDED.crawl_allowed,canonical_target=EXCLUDED.canonical_target,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[key,b.isIndexable,b.crawlAllowed,b.canonicalTarget,user.id]);return r.rows[0];});
  app.get('/api/v1/admin/seo/settings',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:read');const r=await pool.query('SELECT * FROM seo_site_settings WHERE id=true');return r.rows[0]?{...r.rows[0],scheduledCrawlExecution:'inactive',facetPolicyExecution:'inactive'}:null;});
  app.put('/api/v1/admin/seo/settings',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const b=z.object({robotsText:z.string().max(20000),crawlSchedule:z.enum(['manual','daily','weekly']),organizationSchema:z.record(z.string(),z.unknown()),merchantFields:z.record(z.string(),z.unknown())}).parse(request.body);const r=await pool.query(`UPDATE seo_site_settings SET robots_text=$1,crawl_schedule=$2,organization_schema=$3,merchant_fields=$4,updated_by=$5,updated_at=now() WHERE id=true RETURNING *`,[b.robotsText,b.crawlSchedule,JSON.stringify(b.organizationSchema),JSON.stringify(b.merchantFields),user.id]);return r.rows[0];});
  app.post('/api/v1/admin/seo/crawls',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const runId=randomUUID();await pool.query(`INSERT INTO seo_crawl_runs(id,started_by,source,status) VALUES($1,$2,'manual','running')`,[runId,user.id]);try{
    const pages=await pool.query(`SELECT p.id::text AS entity_key,'product' AS entity_type,'/product/'||p.id::text AS url,p.name,p.description,p.metadata,s.seo_title,s.meta_description,s.canonical_url,s.is_indexable FROM products p LEFT JOIN seo_pages s ON s.entity_type='product' AND s.entity_key=p.id::text WHERE p.status='published' UNION ALL SELECT e.id::text,'blog','/journal/'||e.slug,e.title,e.excerpt,'{}'::jsonb,s.seo_title,s.meta_description,s.canonical_url,s.is_indexable FROM editorial_live e LEFT JOIN seo_pages s ON s.entity_type='blog' AND s.entity_key=e.id::text WHERE e.status='published'`);
    const issues:{severity:string;code:string;url:string;details:Record<string,unknown>}[]=[];const titleSeen=new Map<string,string>();for(const p of pages.rows){const title=String(p.seo_title||p.name||'').trim();const desc=String(p.meta_description||p.description||'').trim();if(!title)issues.push({severity:'error',code:'missing_title',url:p.url,details:{}});else if(titleSeen.has(title))issues.push({severity:'warning',code:'duplicate_title',url:p.url,details:{duplicateOf:titleSeen.get(title)}});else titleSeen.set(title,p.url);if(!desc)issues.push({severity:'warning',code:'missing_description',url:p.url,details:{}});if(p.canonical_url&&!publicUrl(p.canonical_url))issues.push({severity:'error',code:'invalid_canonical',url:p.url,details:{value:p.canonical_url}});if(p.is_indexable===false)continue;}
    await transaction(pool,async(client)=>{for(const issue of issues)await client.query('INSERT INTO seo_crawl_issues(id,run_id,severity,issue_code,page_url,details) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),runId,issue.severity,issue.code,issue.url,JSON.stringify(issue.details)]);await client.query(`UPDATE seo_crawl_runs SET status='completed',completed_at=now(),summary=$2 WHERE id=$1`,[runId,JSON.stringify({pages:pages.rowCount,issues:issues.length})]);});return reply.code(201).send({id:runId,status:'completed',pages:pages.rowCount,issues});
  }catch(error){await pool.query(`UPDATE seo_crawl_runs SET status='failed',completed_at=now(),error=$2 WHERE id=$1`,[runId,error instanceof Error?error.message:'unknown']);throw error;}});
  app.get('/api/v1/admin/seo/crawls',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const rows=await pool.query(`SELECT r.*, (SELECT count(*)::int FROM seo_crawl_issues i WHERE i.run_id=r.id) AS issue_count FROM seo_crawl_runs r ORDER BY started_at DESC LIMIT 100`);return{items:rows.rows};});
  app.get('/api/v1/admin/seo/crawls/:id/issues',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const{id}=z.object({id:z.uuid()}).parse(request.params);const rows=await pool.query('SELECT * FROM seo_crawl_issues WHERE run_id=$1 ORDER BY severity,issue_code',[id]);return{items:rows.rows};});
  app.get('/api/v1/admin/seo/not-found',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:technical');const q=z.object({limit:z.coerce.number().int().min(1).max(500).default(100)}).parse(request.query);const rows=await pool.query('SELECT path,hit_day,hit_count,first_seen_at,last_seen_at,last_referrer FROM seo_not_found_hits ORDER BY hit_day DESC,hit_count DESC LIMIT $1',[q.limit]);return{items:rows.rows};});
  app.get('/api/v1/admin/search/synonyms',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'search:manage');const rows=await pool.query('SELECT phrase,replacement,active,updated_by,updated_at FROM search_synonyms ORDER BY phrase');return{items:rows.rows};});
  app.put('/api/v1/admin/search/synonyms/:phrase',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'search:manage');const{phrase}=z.object({phrase:z.string().trim().min(1).max(200)}).parse(request.params);const b=z.object({replacement:z.string().trim().min(1).max(200),active:z.boolean().default(true)}).parse(request.body);const r=await pool.query(`INSERT INTO search_synonyms(phrase,replacement,active,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(phrase) DO UPDATE SET replacement=EXCLUDED.replacement,active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[phrase.normalize('NFKC').toLowerCase(),b.replacement,b.active,user.id]);return r.rows[0];});
  app.delete('/api/v1/admin/search/synonyms/:phrase',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'search:manage');const{phrase}=z.object({phrase:z.string().max(200)}).parse(request.params);await pool.query('DELETE FROM search_synonyms WHERE phrase=$1',[phrase]);return reply.code(204).send();});
  app.get('/api/v1/admin/search/analytics',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'search:analytics');await pool.query('DELETE FROM search_metrics WHERE expires_at<=now()');const q=z.object({zeroResult:z.coerce.boolean().optional(),limit:z.coerce.number().int().min(1).max(500).default(100)}).parse(request.query);const rows=await pool.query(`SELECT normalized_query,metric_day,search_count,last_result_count,click_count,conversion_count,zero_result,last_seen_at FROM search_metrics WHERE ($1::boolean IS NULL OR zero_result=$1) ORDER BY metric_day DESC,search_count DESC LIMIT $2`,[q.zeroResult??null,q.limit]);return{items:rows.rows};});
  app.post('/api/v1/public/search/metrics',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(request)=>{const b=z.object({query:z.string().trim().min(1).max(200),event:z.enum(['search','click','conversion']),resultCount:z.number().int().min(0).max(100000).default(0)}).parse(request.body);const normalized=b.query.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();const hash=createHash('sha256').update(normalized).digest('hex');await pool.query('DELETE FROM search_metrics WHERE expires_at<=now()');await pool.query(`INSERT INTO search_metrics(query_hash,normalized_query,metric_day,search_count,last_result_count,click_count,conversion_count,zero_result,expires_at) VALUES($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,now()+interval '30 days') ON CONFLICT(query_hash,metric_day) DO UPDATE SET search_count=search_metrics.search_count+EXCLUDED.search_count,last_result_count=CASE WHEN EXCLUDED.search_count>0 THEN EXCLUDED.last_result_count ELSE search_metrics.last_result_count END,click_count=search_metrics.click_count+EXCLUDED.click_count,conversion_count=search_metrics.conversion_count+EXCLUDED.conversion_count,zero_result=CASE WHEN EXCLUDED.search_count>0 THEN EXCLUDED.zero_result ELSE search_metrics.zero_result END,last_seen_at=now(),expires_at=now()+interval '30 days'`,[hash,normalized,b.event==='search'?1:0,b.resultCount,b.event==='click'?1:0,b.event==='conversion'?1:0,b.event==='search'&&b.resultCount===0]);return{ok:true};});
  const sitemapHandler=async(_request:FastifyRequest,reply:FastifyReply)=>{const r=await pool.query(`SELECT url FROM (
    SELECT COALESCE(NULLIF(s.canonical_url,''),'https://kolbe.ir'||COALESCE(NULLIF(s.slug,''),'/product/'||p.id::text)) AS url FROM products p LEFT JOIN seo_pages s ON s.entity_type='product' AND s.entity_key=p.id::text WHERE p.status='published' AND p.supplier_id IS NULL AND COALESCE(s.is_indexable,true)
    UNION ALL SELECT COALESCE(NULLIF(s.canonical_url,''),'https://kolbe.ir'||COALESCE(NULLIF(s.slug,''),'/journal/'||e.slug)) FROM editorial_live e LEFT JOIN seo_pages s ON s.entity_type='blog' AND s.entity_key=e.id::text WHERE e.status='published' AND COALESCE(s.is_indexable,true)
    UNION ALL SELECT COALESCE(NULLIF(canonical_url,''),'https://kolbe.ir'||slug) FROM seo_pages WHERE entity_type IN ('site','category','brand','cms','landing') AND is_indexable AND slug<>''
    ) AS urls WHERE url LIKE 'https://kolbe.ir/%' ORDER BY url`);const xml=`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${r.rows.map((x)=>`<url><loc>${String(x.url).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</loc></url>`).join('')}</urlset>`;return reply.type('application/xml; charset=utf-8').header('Cache-Control','public, max-age=300').send(xml);};
  const robotsHandler=async(_request:FastifyRequest,reply:FastifyReply)=>{const r=await pool.query('SELECT robots_text FROM seo_site_settings WHERE id=true');return reply.type('text/plain; charset=utf-8').header('Cache-Control','public, max-age=300').send(`${r.rows[0]?.robots_text??'User-agent: *\nAllow: /'}\nSitemap: https://kolbe.ir/sitemap.xml`);};
  app.get('/api/v1/public/sitemap.xml',sitemapHandler);app.get('/sitemap.xml',sitemapHandler);
  app.get('/api/v1/public/robots.txt',robotsHandler);app.get('/robots.txt',robotsHandler);

  app.get('/api/v1/public/editorial',async(request)=>{const q=z.object({type:z.enum(['article','video']).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)}).parse(request.query);const rows=await pool.query(`SELECT id,post_type,slug,title,excerpt,cover_url,author,category,tags,source_type,source_url,duration_seconds,seo_title,seo_description,related_product_ids,published_at FROM editorial_live WHERE status='published' AND ($1::text IS NULL OR post_type=$1) AND (published_at IS NULL OR published_at<=now()) ORDER BY published_at DESC NULLS LAST,created_at DESC LIMIT $2`,[q.type??null,q.limit]);return{items:rows.rows};});
  app.get('/api/v1/public/editorial/:slug',async(request)=>{const{slug}=z.object({slug:z.string().max(250)}).parse(request.params);const r=await pool.query(`SELECT id,post_type,slug,title,excerpt,body,cover_url,author,category,tags,source_type,source_url,duration_seconds,seo_title,seo_description,related_product_ids,published_at FROM editorial_live WHERE slug=$1 AND status='published' AND (published_at IS NULL OR published_at<=now())`,[slug]);if(!r.rowCount)throw notFound();return r.rows[0];});
  app.get('/api/v1/admin/editorial',async(request)=>{
    const user=await principal(request,pool,config);requirePermission(user,'content:manage');
    const q=z.object({type:z.enum(['article','video']).optional(),status:z.enum(['draft','published','archived']).optional(),q:z.string().max(160).default(''),limit:z.coerce.number().int().min(1).max(250).default(100),offset:z.coerce.number().int().min(0).max(100000).default(0)}).parse(request.query);
    const where=`($1::text IS NULL OR post_type=$1) AND ($2::text IS NULL OR status=$2) AND (title ILIKE $3 OR category ILIKE $3)`;
    const params=[q.type??null,q.status??null,`%${q.q}%`];
    const rows=await pool.query(`SELECT * FROM editorial_posts WHERE ${where} ORDER BY updated_at DESC,id LIMIT $4 OFFSET $5`,[...params,q.limit,q.offset]);
    const total=await one<{n:number}>(pool,`SELECT count(*)::int AS n FROM editorial_posts WHERE ${where}`,params);return {items:rows.rows,total:total!.n};
  });
  app.post('/api/v1/admin/editorial',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'content:manage');const b=postBody.parse(request.body);if(b.status==='published'||b.status==='archived')requirePermission(user,'cms:publish');if(b.coverUrl&&!publicUrl(b.coverUrl)&&!/^\/api\/v1\/media\/[0-9a-f-]{36}$/.test(b.coverUrl))throw badRequest('تصویر شاخص باید URL امن HTTPS باشد.');if(b.sourceType==='youtube'&&!isYoutubeUrl(b.sourceUrl))throw badRequest('نشانی یوتیوب معتبر نیست.');const id=randomUUID();const r=await transaction(pool,async(client)=>{await assertEditorialPublication(client,id,b.slug,b.status);const r=await client.query(`INSERT INTO editorial_posts(id,post_type,slug,title,excerpt,body,cover_url,author,category,tags,source_type,source_url,duration_seconds,seo_title,seo_description,related_product_ids,status,published_at,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $17='published' THEN now() ELSE NULL END,$18,$18) RETURNING *`,[id,b.postType,b.slug,b.title,b.excerpt,b.body,b.coverUrl,b.author,b.category,JSON.stringify(b.tags),b.sourceType,b.sourceUrl,b.durationSeconds,b.seoTitle,b.seoDescription,b.relatedProductIds,b.status,user.id]);await audit(client,user.id,'editorial.created','editorial_post',id,undefined,{status:b.status,version:r.rows[0].version},request.ip);return r;});return reply.code(201).send(r.rows[0]);});
  app.put('/api/v1/admin/editorial/:id',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'content:manage');const{id}=z.object({id:z.uuid()}).parse(request.params);const b=postBody.parse(request.body);if(b.status==='published'||b.status==='archived')requirePermission(user,'cms:publish');if(b.coverUrl&&!publicUrl(b.coverUrl)&&!/^\/api\/v1\/media\/[0-9a-f-]{36}$/.test(b.coverUrl))throw badRequest('تصویر شاخص باید URL امن HTTPS باشد.');if(b.sourceType==='youtube'&&!isYoutubeUrl(b.sourceUrl))throw badRequest('نشانی یوتیوب معتبر نیست.');const r=await transaction(pool,async(client)=>{await assertEditorialPublication(client,id,b.slug,b.status);const r=await client.query(`UPDATE editorial_posts SET post_type=$2,slug=$3,title=$4,excerpt=$5,body=$6,cover_url=$7,author=$8,category=$9,tags=$10,source_type=$11,source_url=$12,duration_seconds=$13,seo_title=$14,seo_description=$15,related_product_ids=$16,status=$17,published_at=CASE WHEN $17='published' THEN COALESCE(published_at,now()) ELSE published_at END,updated_by=$18,version=version+1,updated_at=now() WHERE id=$1 AND ($19::integer IS NULL OR version=$19) RETURNING *`,[id,b.postType,b.slug,b.title,b.excerpt,b.body,b.coverUrl,b.author,b.category,JSON.stringify(b.tags),b.sourceType,b.sourceUrl,b.durationSeconds,b.seoTitle,b.seoDescription,b.relatedProductIds,b.status,user.id,b.expectedVersion??null]);if(!r.rowCount){if(await one(client,'SELECT id FROM editorial_posts WHERE id=$1',[id]))throw conflict('نسخه مطلب تغییر کرده؛ دوباره بارگذاری کنید.');throw notFound();}await audit(client,user.id,'editorial.updated','editorial_post',id,undefined,{status:b.status,version:r.rows[0].version},request.ip);return r;});return r.rows[0];});
  app.delete('/api/v1/admin/editorial/:id',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'content:manage');const{id}=z.object({id:z.uuid()}).parse(request.params);await pool.query('DELETE FROM editorial_posts WHERE id=$1',[id]);return reply.code(204).send();});
  app.get('/api/v1/public/media/:id',async(request)=>{const{id}=z.object({id:z.uuid()}).parse(request.params);const r=await pool.query('SELECT id,media_type,source_type,public_url,mime_type,width,height,duration_seconds,alt_text,title,caption,file_name,metadata,processing_status FROM media_assets WHERE id=$1',[id]);if(!r.rowCount)throw notFound();return r.rows[0];});
  app.get('/api/v1/admin/media',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');const q=z.object({q:z.string().max(200).optional(),type:z.enum(['image','video','pdf']).optional(),limit:z.coerce.number().int().min(1).max(250).default(100)}).parse(request.query);const r=await pool.query(`SELECT * FROM media_assets WHERE ($1::text IS NULL OR media_type=$1) AND ($2::text IS NULL OR title ILIKE '%'||$2||'%' OR alt_text ILIKE '%'||$2||'%' OR file_name ILIKE '%'||$2||'%' OR metadata::text ILIKE '%'||$2||'%') ORDER BY created_at DESC LIMIT $3`,[q.type??null,q.q??null,q.limit]);return{items:r.rows};});
  app.post('/api/v1/admin/media',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');const b=mediaBody.parse(request.body);if(!publicUrl(b.publicUrl))throw badRequest('URL رسانه باید HTTPS باشد.');if(b.sourceType==='youtube'&&!isYoutubeUrl(b.publicUrl))throw badRequest('URL یوتیوب معتبر نیست.');if(b.sourceType==='object_storage'&&!b.storageKey)throw badRequest('Storage key لازم است.');const r=await pool.query(`INSERT INTO media_assets(id,media_type,source_type,storage_key,public_url,mime_type,byte_size,width,height,duration_seconds,alt_text,title,caption,file_name,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[randomUUID(),b.mediaType,b.sourceType,b.storageKey,b.publicUrl,b.mimeType,b.byteSize,b.width,b.height,b.durationSeconds,b.altText,b.title,b.caption,b.fileName,JSON.stringify(b.metadata),user.id]);return reply.code(201).send(r.rows[0]);});
  app.patch('/api/v1/admin/media/:id',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');const{id}=z.object({id:z.uuid()}).parse(request.params);const b=z.object({altText:z.string().max(500).optional(),title:z.string().max(300).optional(),caption:z.string().max(1000).optional(),metadata:z.record(z.string(),z.unknown()).optional()}).parse(request.body);const r=await pool.query(`UPDATE media_assets SET alt_text=COALESCE($2,alt_text),title=COALESCE($3,title),caption=COALESCE($4,caption),metadata=COALESCE($5,metadata),updated_at=now() WHERE id=$1 RETURNING *`,[id,b.altText??null,b.title??null,b.caption??null,b.metadata?JSON.stringify(b.metadata):null]);if(!r.rowCount)throw notFound();return r.rows[0];});
  app.post('/api/v1/admin/media/upload-intents',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');if(!objectStorage)throw new ApiError(503,'STORAGE_UNAVAILABLE','اتصال Object Storage تنظیم نشده است.');const b=z.object({mediaType:z.enum(['image','video','pdf']),fileName:z.string().trim().min(1).max(240),mimeType:z.string().min(1).max(150),byteSize:z.number().int().positive()}).parse(request.body);const max=b.mediaType==='video'?500*1024*1024:25*1024*1024;const allow=b.mediaType==='image'?/^image\/(jpeg|png|webp|avif|gif)$/.test(b.mimeType):b.mediaType==='video'?/^video\/(mp4|webm|quicktime)$/.test(b.mimeType):b.mimeType==='application/pdf';if(!allow||b.byteSize>max)throw badRequest('نوع یا اندازه فایل مجاز نیست.');const safeName=b.fileName.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu,'_').slice(-160);const id=randomUUID();const key=`${b.mediaType}/${user.id}/${id}-${safeName}`;const expiresAt=new Date(Date.now()+5*60*1000);const uploadUrl=await objectStorage.signPut(key,b.mimeType);await pool.query('INSERT INTO media_upload_intents(id,actor_id,storage_key,mime_type,byte_size,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[id,user.id,key,b.mimeType,b.byteSize,expiresAt]);return reply.code(201).send({id,uploadUrl,method:'PUT',headers:{'Content-Type':b.mimeType},publicUrl:`${objectStorage.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`,expiresAt:expiresAt.toISOString()});});
  app.post('/api/v1/admin/media/upload-intents/:id/complete',async(request,reply)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');if(!objectStorage)throw new ApiError(503,'STORAGE_UNAVAILABLE','اتصال Object Storage تنظیم نشده است.');const{id}=z.object({id:z.uuid()}).parse(request.params);const intent=await pool.query(`SELECT * FROM media_upload_intents WHERE id=$1 AND actor_id=$2 AND completed_at IS NULL AND expires_at>now()`,[id,user.id]);if(!intent.rowCount)throw notFound();const row=intent.rows[0];let head;try{head=await objectStorage.head(row.storage_key);}catch{throw badRequest('فایل در فضای ذخیره‌سازی پیدا نشد.');}if(head.size!==Number(row.byte_size)||head.contentType!==row.mime_type)throw badRequest('اندازه یا نوع محتوای بارگذاری‌شده با مجوز آپلود تطبیق ندارد.');const mime=String(row.mime_type);const mediaType=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':'pdf';const publicUrl=`${objectStorage.publicBase}/${String(row.storage_key).split('/').map(encodeURIComponent).join('/')}`;const result=await transaction(pool,async(client)=>{const media=await client.query(`INSERT INTO media_assets(id,media_type,source_type,storage_key,public_url,mime_type,byte_size,processing_status,created_by) VALUES($1,$2,'object_storage',$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),mediaType,row.storage_key,publicUrl,mime,row.byte_size,mediaType==='video'?'pending':'ready',user.id]);await client.query('UPDATE media_upload_intents SET completed_at=now() WHERE id=$1',[id]);return media.rows[0];});return reply.code(201).send(result);});
  app.get('/api/v1/admin/products/:id/media',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'media:manage');const{id}=z.object({id:z.uuid()}).parse(request.params);const rows=await pool.query(`SELECT pm.id,pm.role,pm.url,pm.external_url,pm.metadata,pm.alt_text,pm.variant_id,pm.purpose,pm.position,pm.media_asset_id,ma.public_url,ma.media_type,ma.title FROM product_media pm LEFT JOIN media_assets ma ON ma.id=pm.media_asset_id WHERE pm.product_id=$1 AND pm.active ORDER BY pm.variant_id NULLS FIRST,pm.position,pm.created_at`,[id]);return{items:rows.rows};});
  app.get('/api/v1/public/products/:id/media',async(request)=>{const{id}=z.object({id:z.uuid()}).parse(request.params);const rows=await pool.query(`SELECT ma.id,ma.media_type,ma.public_url,ma.alt_text,ma.title,ma.caption,ma.width,ma.height,ma.duration_seconds,pm.variant_id,pm.purpose,pm.position FROM product_media pm JOIN media_assets ma ON ma.id=pm.media_asset_id JOIN products p ON p.id=pm.product_id WHERE pm.product_id=$1 AND p.status='published' AND ma.processing_status='ready' ORDER BY pm.variant_id NULLS FIRST,pm.position`,[id]);return{items:rows.rows};});
  app.get('/api/v1/admin/seo/integration',async(request)=>{const user=await principal(request,pool,config);requirePermission(user,'seo:integrations');const r=await pool.query('SELECT provider,status,property_url,last_synced_at,last_error,updated_at FROM seo_integration_status');return{items:r.rows.map((row)=>row.provider==='object_storage'?{...row,status:objectStorage?'configured':'not_configured'}:row)};});
}
function isYoutubeUrl(value:string){try{const u=new URL(value);const host=u.hostname.toLowerCase().replace(/^www\./,'');if(!['youtube.com','m.youtube.com','youtu.be','youtube-nocookie.com'].includes(host))return false;const id=host==='youtu.be'?u.pathname.split('/').filter(Boolean)[0]:u.searchParams.get('v')||u.pathname.split('/').filter(Boolean).at(-1);return !!id&&/^[\w-]{11}$/.test(id);}catch{return false;}}

/* ---- integration wrapper: Agent C's SEO Domain core + Agent D2's SEO/search/media estate ---- */
export function registerSeoRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  registerSeoRoutesCore(app, pool, config);
  registerD2SeoRoutes(app, pool, config);
}
