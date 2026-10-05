import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from './config.js';
import type { DbPool } from './db.js';
import { one } from './db.js';
import { commerceProductsByIds } from './commerce-view.js';
import { loadPublicPage, resolvePublicCmsPath } from './cms-studio.js';
import { jsonLdString, resolveSeoFor, type ResolvedSeo } from './seo.js';

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function documentHtml(template: string, seo: ResolvedSeo, content: string, extraSchema: Record<string, unknown>[] = []) {
  const head = `<title>${escapeHtml(seo.title)}</title>` +
    `<meta name="description" content="${escapeHtml(seo.description)}">` +
    `<meta name="robots" content="${escapeHtml(seo.robots)}">` +
    `<link rel="canonical" href="${escapeHtml(seo.canonical)}">` +
    [...seo.jsonLd, ...extraSchema].map((schema) => `<script type="application/ld+json">${jsonLdString(schema)}</script>`).join('');
  return template.replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/i, '')
    .replace('</head>', `${head}</head>`)
    .replace('<div id="root"></div>', `<div id="root">${content}</div>`);
}

export function registerStorefrontHtmlRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  let templatePromise: Promise<string> | null = null;
  const template = () => templatePromise ??= readFile(new URL('../../dist/index.html', import.meta.url), 'utf8')
    .catch((error: unknown) => {
      if (config.NODE_ENV !== 'test') throw error;
      return '<!doctype html><html lang="fa" dir="rtl"><head></head><body><div id="root"></div></body></html>';
    });
  const send = async (reply: FastifyReply, seo: ResolvedSeo, content: string, extraSchema: Record<string, unknown>[] = []) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=60')
      .send(documentHtml(await template(), seo, content, extraSchema));

  app.get('/product/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) return reply.code(404).send();
    const status = await one<{ status: string }>(pool, 'SELECT status FROM products WHERE id=$1', [id]);
    if (status?.status !== 'published') return reply.code(404).send();
    const seo = await resolveSeoFor(pool, 'product', id, config.PUBLIC_ORIGIN);
    if (!seo) return reply.code(404).send();
    const [product] = await commerceProductsByIds(pool, [id]);
    if (!product) return reply.code(404).send();
    const group = product.variants.length > 1 ? [{
      '@context': 'https://schema.org', '@type': 'ProductGroup', name: product.name,
      productGroupID: product.id, url: seo.canonical,
      hasVariant: product.variants.map((variant) => ({
        '@type': 'Product', name: product.name, sku: variant.sku,
        ...(variant.size ? { size: variant.size } : {}),
        ...(variant.color ? { color: variant.color } : {}),
        offers: { '@type': 'Offer', priceCurrency: 'IRR', price: product.priceRial,
          availability: variant.available > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
      })),
    }] : [];
    return send(reply, seo, `<main><h1>${escapeHtml(product.name)}</h1><p>${escapeHtml(seo.description)}</p>` +
      `<p>${escapeHtml(product.priceRial)} IRR</p><p>${product.available > 0 ? 'موجود' : 'ناموجود'}</p></main>`, group);
  });

  app.get('/category/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const seo = await resolveSeoFor(pool, 'category', slug, config.PUBLIC_ORIGIN);
    if (!seo) return reply.code(404).send();
    const category = await one<{ name: string; description: string }>(pool,
      'SELECT name,description FROM cms_categories WHERE slug=$1 AND active', [slug]);
    if (!category) return reply.code(404).send();
    return send(reply, seo, `<main><h1>${escapeHtml(category.name)}</h1><p>${escapeHtml(category.description)}</p></main>`);
  });

  app.get('/journal/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const post = await one<{ id: string; title: string; excerpt: string; body: string; seo_title: string; seo_description: string }>(pool,
      `SELECT id,title,excerpt,body,seo_title,seo_description FROM editorial_live
        WHERE slug=$1 AND status='published' AND (published_at IS NULL OR published_at<=now())`, [slug]);
    if (!post) return reply.code(404).send();
    const center = await one<{ seo_title: string; meta_description: string; canonical_url: string; is_indexable: boolean }>(pool,
      "SELECT seo_title,meta_description,canonical_url,is_indexable FROM seo_pages WHERE entity_type='blog' AND entity_key=$1", [post.id]);
    const canonical = center?.canonical_url || `${config.PUBLIC_ORIGIN}/journal/${slug}`;
    const title = center?.seo_title || post.seo_title || post.title;
    const description = center?.meta_description || post.seo_description || post.excerpt;
    const seo: ResolvedSeo = { entityType: 'page', entityKey: post.id, title, description, canonical,
      robots: center?.is_indexable === false ? 'noindex,follow' : 'index,follow', index: center?.is_indexable !== false,
      og: { title, description, image: null, url: canonical, type: 'article', siteName: 'کلبه وینتج', locale: 'fa_IR' },
      twitter: { card: 'summary', title, description, image: null },
      jsonLd: [{ '@context': 'https://schema.org', '@type': 'Article', headline: title, description, url: canonical }],
      source: center ? 'seo_domain' : 'derived', version: null };
    return send(reply, seo, `<main><article><h1>${escapeHtml(post.title)}</h1><p>${escapeHtml(post.excerpt)}</p>` +
      `<div>${escapeHtml(post.body)}</div></article></main>`);
  });

  app.get('/*', async (request, reply) => {
    const rawPath = request.url.split('?')[0] || '/';
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch { return reply.code(404).send(); }
    if (!/^\/[\p{L}\p{N}/_-]{0,120}$/u.test(path)) return reply.code(404).send();
    const code = await resolvePublicCmsPath(pool, path, config.PUBLIC_ORIGIN);
    if (!code) return reply.code(404).send();
    const page = await loadPublicPage(pool, code, config.PUBLIC_ORIGIN);
    if (!page?.seo) return reply.code(404).send();
    const sections = Array.isArray(page.sections) ? page.sections : [];
    const content = sections.map((section) => {
      const payload = section.payload as Record<string, unknown> | null;
      return [section.title, payload?.title, payload?.subtitle, payload?.description, payload?.text]
        .filter((value) => typeof value === 'string' && value.trim()).map((value) => `<p>${escapeHtml(value)}</p>`).join('');
    }).join('');
    return send(reply, page.seo, `<main><h1>${escapeHtml(page.seo.title)}</h1><p>${escapeHtml(page.seo.description)}</p>${content}</main>`);
  });
}
