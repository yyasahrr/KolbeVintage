import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, notFound, patchBody } from './errors.js';
import { getFile, putFile } from './storage.js';
import { isResizable, renderVariant, snapWidth } from './images.js';
import { legacySeoToWrite, renameSeoKey, resolveSeo, loadEntry, loadSubject, upsertSeoEntry } from './seo.js';
import { ensureContact } from './crm.js';
import { CARD_BLOCKS, NAV_TARGET, SIMPLE_STYLE_KEYS, STYLE_SPEC, cardStylesSchema, designQualityGate, responsiveConfigSchema, validateSectionPayload, validateStyleOverrides, type FieldSchema } from './cms-schema.js';
import { recommend } from './recommendations.js';
import { installmentProviders } from './installments.js';
import {
  attachCardTemplates, commerceProductsByIds, queryCommerceProducts, type CollectionRules, type CommerceProduct,
} from './commerce-view.js';

/* ============================ Pure rules (unit-testable) ============================ */

/** Safe primitives for admin-composed components (Req 178-179). No HTML, no JS, ever. */
export const PRIMITIVES = ['container', 'grid', 'stack', 'text', 'image', 'video', 'button', 'icon', 'badge',
  'price', 'product_image', 'product_title', 'rating', 'countdown', 'installment_info', 'spacer'] as const;
export type CompositionNode = { type: string; props?: Record<string, unknown>; children?: CompositionNode[] };

const UNSAFE = /<\s*\/?\s*(script|iframe|object|embed|style|link|meta)\b|javascript:|data:text\/html|\bon[a-z]+\s*=/i;

/** Rejects anything that could turn CMS data into runtime code (Req 179, 323). */
export function assertSafeText(value: unknown, field = 'مقدار'): void {
  if (typeof value === 'string' && (UNSAFE.test(value) || /<[a-z!/]/i.test(value))) {
    throw badRequest(`${field} نباید شامل HTML یا اسکریپت باشد.`);
  }
  if (Array.isArray(value)) value.forEach((item) => assertSafeText(item, field));
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) assertSafeText(inner, `${field}.${key}`);
}

export function validateComposition(nodes: CompositionNode[], depth = 0, counter = { n: 0 }): void {
  if (depth > 5) throw badRequest('عمق ساختار کامپوننت بیش از حد مجاز (۵) است.');
  for (const node of nodes) {
    counter.n += 1;
    if (counter.n > 80) throw badRequest('تعداد اجزای کامپوننت بیش از ۸۰ است.');
    if (!(PRIMITIVES as readonly string[]).includes(node.type)) throw badRequest(`جزء «${node.type}» در فهرست اجزای امن نیست.`);
    for (const [key, value] of Object.entries(node.props ?? {})) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw badRequest(`ویژگی «${key}» باید مقدار ساده باشد.`);
      assertSafeText(value, key);
      if (key === 'href' && typeof value === 'string' && !/^(https:\/\/|\/|#|shop$|vip$|tryon$|journal$|about$)/.test(value)) {
        throw badRequest('لینک فقط می‌تواند مسیر داخلی یا https باشد.');
      }
    }
    if (node.children?.length) validateComposition(node.children, depth + 1, counter);
  }
}

const hexToRgb = (hex: string) => {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((l1! + 0.05) / (l2! + 0.05)) * 100) / 100;
}

export { designQualityGate } from './cms-schema.js';

export const TOKEN_KEYS = ['background', 'surface', 'surfaceSecondary', 'textPrimary', 'textSecondary', 'primary', 'secondary',
  'accent', 'border', 'success', 'warning', 'danger'] as const;

/** Theme guardrail (Req 221-222, 228): text must stay readable whatever the campaign palette. */
export function validateThemeTokens(tokens: Record<string, string>) {
  for (const key of TOKEN_KEYS) if (!/^#[0-9a-fA-F]{3,8}$/.test(tokens[key] ?? '')) throw badRequest(`توکن «${key}» باید رنگ hex معتبر باشد.`);
  const body = contrastRatio(tokens.textPrimary!, tokens.background!);
  if (body < 4.5) throw badRequest(`کنتراست متن اصلی با پس‌زمینه ${body} است؛ حداقل ۴٫۵ لازم است.`);
  const card = contrastRatio(tokens.textPrimary!, tokens.surface!);
  if (card < 4.5) throw badRequest(`کنتراست متن اصلی با سطح کارت ${card} است؛ حداقل ۴٫۵ لازم است.`);
  return { bodyContrast: body, surfaceContrast: card };
}

/** Legacy 6-colour palettes (pre-theme-engine) are expanded to the full token set so every theme is renderable. */
export function tokensFromPalette(colors: Record<string, string>, tokens: Record<string, string> | null | undefined): Record<string, string> {
  if (tokens && tokens.textPrimary && tokens.background) return tokens;
  const dark = contrastRatio(colors.background ?? '#F9F6F1', '#000000') < 7;
  return {
    background: colors.background ?? '#F9F6F1', surface: colors.surface ?? '#FFFFFF', surfaceSecondary: colors.surface ?? '#F1ECE1',
    textPrimary: colors.text ?? '#0E1527', textSecondary: dark ? '#A8B3C7' : '#5B616E', primary: colors.primary ?? '#1B2A4A',
    secondary: colors.secondary ?? '#C1613B', accent: colors.accent ?? '#C1613B', border: dark ? '#2E3A52' : '#E4DDD0',
    success: '#2E6B47', warning: '#B7791F', danger: '#B42318', radius: '16px', shadow: 'soft', font: 'Vazirmatn', spacing: 'comfortable',
  };
}

export type AnnouncementRow = { id: string; priority: number; active: boolean; starts_at: string | Date | null; ends_at: string | Date | null };
export function pickActiveAnnouncements<T extends AnnouncementRow>(rows: T[], now = new Date()): T[] {
  return rows.filter((row) => row.active
    && (!row.starts_at || new Date(row.starts_at) <= now)
    && (!row.ends_at || new Date(row.ends_at) > now))
    .sort((a, b) => b.priority - a.priority);
}

/** Page visibility (Req 215, 217): published, or scheduled and inside its window. */
export function pageIsLive(page: { status: string; active: boolean; scheduled_start_at: string | Date | null; scheduled_end_at: string | Date | null }, now = new Date()) {
  if (!page.active) return false;
  const inWindow = (!page.scheduled_start_at || new Date(page.scheduled_start_at) <= now)
    && (!page.scheduled_end_at || new Date(page.scheduled_end_at) > now);
  if (page.status === 'published') return inWindow;
  if (page.status === 'scheduled') return Boolean(page.scheduled_start_at) && inWindow;
  return false;
}

/* ============================ Schemas ============================ */

const safeString = (max: number) => z.string().trim().max(max).refine((v) => !UNSAFE.test(v) && !/<[a-z!/]/i.test(v), 'HTML یا اسکریپت مجاز نیست.');
// One navigation grammar for header, footer, mega menu and CMS fields (incl. category:/product: targets).
const navTarget = z.string().trim().max(200).refine((v) => NAV_TARGET.test(v), 'مقصد لینک مجاز نیست.');
const hex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);

const headerSchema = z.object({
  variant: z.enum(['default', 'minimal', 'transparent', 'campaign', 'dark']),
  logoText: safeString(40), logoSubtext: safeString(40),
  showSearch: z.boolean(), showWishlist: z.boolean(), showCart: z.boolean(), showAccount: z.boolean(), showThemeToggle: z.boolean().default(true),
  // Header CTA (Req 277): label + registered target + on/off + visual variant; rendered by the shared storefront HeaderCta.
  ctaLabel: safeString(40).default(''), ctaTarget: navTarget.default('vip'),
  ctaEnabled: z.boolean().default(false), ctaVariant: z.enum(['solid', 'outline', 'ghost']).default('solid'),
  menus: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{2,40}$/), label: safeString(40), target: navTarget, order: z.number().int().min(0).max(100),
    active: z.boolean(), vip: z.boolean().optional(), hasMegaMenu: z.boolean().optional() }).strict()).max(12),
  // Req 278: per-menu mega columns with media + collection / vibe / campaign promos — registered fields only.
  megaMenu: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_-]{2,40}$/), title: safeString(40), menuId: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(),
    items: z.array(z.object({ label: safeString(60), category: safeString(60).optional(), gender: safeString(20).optional(), target: navTarget.optional() }).strict()).max(12),
    featuredVibe: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), featuredCollection: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
    featuredCampaign: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(), promoTitle: safeString(80).optional(),
    image: z.string().regex(/^(https:\/\/[^\s<>"]+|\/api\/v1\/media\/[0-9a-f-]{36})$/).optional(), imageAlt: safeString(120).optional(),
  }).strict()).max(8).default([]),
  showAnnouncement: z.boolean().default(true),
  mobileNav: z.object({ showCategories: z.boolean(), showVibes: z.boolean(),
    items: z.array(z.object({ label: safeString(40), target: navTarget }).strict()).max(8) }).strict().default({ showCategories: true, showVibes: true, items: [] }),
}).strict();

const footerSchema = z.object({
  brandTitle: safeString(60), brandSubtitle: safeString(120), brandDescription: safeString(400),
  columns: z.array(z.object({ title: safeString(60), links: z.array(z.object({ label: safeString(60), target: navTarget }).strict()).max(10) }).strict()).max(5),
  contact: z.object({ phone: safeString(40), address: safeString(200), email: safeString(120) }).strict(),
  social: z.array(z.object({ platform: z.enum(['instagram', 'telegram', 'whatsapp', 'youtube', 'linkedin', 'x']), label: safeString(40), url: z.string().regex(/^https:\/\/[^\s<>"]+$/) }).strict()).max(8),
  trustBadges: z.array(safeString(60)).max(6), newsletterEnabled: z.boolean(), copyright: safeString(160),
}).strict();

const accountAppearanceSchema = z.object({
  welcomeBanner: z.object({ eyebrow: safeString(60), title: safeString(120), subtitle: safeString(300), tone: z.enum(['navy', 'terra', 'stone']) }).strict(),
  promoCard: z.object({ enabled: z.boolean(), title: safeString(120), subtitle: safeString(300), ctaLabel: safeString(40), ctaTarget: navTarget }).strict(),
  recommendationHeading: safeString(120),
  helpCards: z.array(z.object({ title: safeString(80), desc: safeString(200), action: z.enum(['support', 'membership', 'addresses', 'profile', 'security', 'shop']) }).strict()).max(4),
}).strict();

const announcementBody = z.object({
  title: safeString(120),
  messages: z.array(z.object({ text: safeString(200), link: navTarget.optional(), ctaLabel: safeString(40).optional(), icon: z.string().max(30).optional() }).strict()).min(1).max(8),
  mode: z.enum(['static', 'marquee', 'ticker', 'slider', 'rotating']),
  style: z.object({
    backgroundColor: hex, textColor: hex, fontFamily: z.enum(['Vazirmatn', 'Marcellus', 'system']).default('Vazirmatn'),
    speed: z.enum(['slow', 'normal', 'fast']).default('normal'), direction: z.enum(['rtl', 'ltr']).default('rtl'),
    heightPx: z.number().int().min(28).max(64).default(40), icon: z.string().max(30).optional(), dismissible: z.boolean().default(true),
    ctaLabel: safeString(40).optional(), ctaTarget: navTarget.optional(), showCountdown: z.boolean().optional(),
  }).strict(),
  bindingType: z.enum(['none', 'campaign', 'promotion', 'coupon', 'collection', 'landing_page']).default('none'),
  bindingId: z.string().max(80).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(10),
  startsAt: z.iso.datetime().nullable().optional(), endsAt: z.iso.datetime().nullable().optional(),
  active: z.boolean().default(true),
}).strict();

const collectionRules = z.object({
  category: z.string().max(120).optional(), categories: z.array(z.string().max(120)).max(20).optional(),
  vibe: z.string().max(40).optional(), season: z.enum(['spring', 'summer', 'autumn', 'winter', 'all-season']).optional(),
  gender: z.enum(['men', 'women', 'unisex', 'kids']).optional(), productType: z.string().max(40).optional(),
  minDiscountPercent: z.number().int().min(0).max(95).optional(), minPriceRial: z.string().regex(/^\d+$/).optional(),
  maxPriceRial: z.string().regex(/^\d+$/).optional(), inStockOnly: z.boolean().optional(), installmentEnabled: z.boolean().optional(),
  newWithinDays: z.number().int().min(1).max(365).optional(),
  sortBy: z.enum(['newest', 'price_asc', 'price_desc', 'discount', 'popular']).optional(), limit: z.number().int().min(1).max(48).optional(),
}).strict();

/* ============================ Helpers ============================ */

async function readSetting<T>(db: DbPool | PoolClient, key: string): Promise<T | null> {
  const row = await one<{ value: T }>(db, 'SELECT value FROM site_settings WHERE key = $1', [key]);
  return row?.value ?? null;
}

type SectionRow = { id: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number;
  component_code: string; component_type: string; variant?: string; preset?: string | null; section_theme?: string;
  data_binding?: Record<string, unknown>; style_overrides?: Record<string, unknown>; responsive_config?: Record<string, unknown>;
  composition?: unknown };

async function workingSections(db: DbPool | PoolClient, pageId: string, visibleOnly: boolean): Promise<SectionRow[]> {
  const rows = await db.query(
    `SELECT s.id, s.title, s.payload, s.visible, s.position, s.variant, s.preset, s.section_theme, s.data_binding,
            s.style_overrides, s.responsive_config, c.code AS component_code, c.component_type, c.composition
     FROM cms_sections s JOIN cms_components c ON c.id = s.component_id
     WHERE s.page_id = $1 AND ($2::boolean = false OR s.visible) ORDER BY s.position, s.created_at`, [pageId, visibleOnly]);
  return rows.rows as SectionRow[];
}

/** Req 330-332: an announcement may only bind to an existing campaign / promotion / public coupon / collection / landing page. */
async function assertAnnouncementBinding(db: DbPool | PoolClient, type: string, ref: string | null) {
  if (type === 'none') return;
  if (!ref) throw badRequest('برای این نوع اتصال، شناسه مقصد لازم است.');
  const isId = /^[0-9a-f-]{36}$/.test(ref);
  const sql: Record<string, string> = {
    campaign: `SELECT 1 FROM festivals WHERE ${isId ? 'id = $1::uuid' : 'code = $1'}`,
    promotion: `SELECT 1 FROM festivals WHERE ${isId ? 'id = $1::uuid' : 'code = $1'}`,
    coupon: `SELECT 1 FROM coupons WHERE ${isId ? 'id = $1::uuid' : 'code = $1'} AND recipient_user_id IS NULL`,
    collection: 'SELECT 1 FROM cms_collections WHERE code = $1',
    landing_page: 'SELECT 1 FROM cms_pages WHERE code = $1',
  };
  if (!sql[type] || !(await db.query(sql[type]!, [ref])).rowCount) throw badRequest('مقصد اتصال اعلان یافت نشد (کمپین/کوپن/کالکشن/صفحه باید وجود داشته باشد).');
}

const HERO_CODES = new Set(['hero', 'image_hero', 'video_hero']);

/** Resolves Commerce Data Bindings server-side (Req 185-191, 212, 238-240). CMS never stores copies. */
async function enrichSections(db: DbPool | PoolClient, sections: SectionRow[]) {
  const out = [];
  const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
  const isSlug = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{2,60}$/.test(v);
  for (const section of sections) {
    const binding = { ...(section.data_binding ?? {}), ...pickBinding(section.payload) } as Record<string, unknown>;
    const resolved: Record<string, unknown> = {};
    const code = section.component_code;
    const limit = Math.min(Math.max(Number(section.payload.limit ?? section.payload.count ?? 8) || 8, 1), 24);
    try {
      let campaignScope: { productIds?: string[]; categories?: string[] } | null = null;
      if (isUuid(binding.campaignId)) {
        const campaign = await one<Record<string, unknown> & { scope: { productIds?: string[]; categories?: string[] } }>(db, `SELECT id, code, name, occasion, starts_at, ends_at, discount_percent,
          theme_palette_code, scope, (active AND starts_at <= now() AND ends_at >= now()) AS live FROM festivals WHERE id = $1`, [binding.campaignId]);
        if (campaign) {
          const { scope, ...rest } = campaign;
          campaignScope = scope ?? {};
          const theme = await one<{ code: string; name: string }>(db, `SELECT code, name FROM color_palettes WHERE campaign_id = $1 OR code = $2 ORDER BY (campaign_id = $1) DESC LIMIT 1`,
            [binding.campaignId, campaign.theme_palette_code ?? null]);
          resolved.campaign = { ...rest, theme }; // Req 187: products, discount, start, end, theme, countdown from the campaign
        }
      }
      const productCodes = ['product_grid', 'product_carousel', 'product_slider', 'products', 'promotion_banner', 'installment_card', 'hero', 'image_hero', 'video_hero', 'product_card'];
      if (code === 'recommendation_section') {
        const strategy = (['for_you', 'similar', 'popular', 'trending'] as const).find((x) => x === section.payload.strategy) ?? 'popular';
        const rec = await recommend(db, { strategy, productId: isUuid(binding.productId) ? binding.productId : null,
          vibe: isSlug(section.payload.vibe) ? section.payload.vibe : null, category: typeof section.payload.category === 'string' && section.payload.category ? section.payload.category : null, limit });
        resolved.products = await attachCardTemplates(db, rec.items);
        resolved.recommendation = { strategy, personal: strategy === 'for_you', basedOn: rec.basedOn, fallback: rec.fallback };
      } else if (productCodes.includes(code) || binding.collectionCode || binding.productIds) {
        let rules: CollectionRules | null = null;
        const heroBinding = String(section.payload.bindingType ?? 'manual');
        if (typeof binding.collectionCode === 'string' && (code !== 'hero' || heroBinding === 'collection')) {
          const collection = await one<{ code: string; title: string; description: string; mode: string; query_rules: CollectionRules; product_ids: string[] }>(db,
            'SELECT code, title, description, mode, query_rules, product_ids FROM cms_collections WHERE code = $1 AND active', [binding.collectionCode]);
          if (collection) {
            rules = collection.mode === 'manual' ? { productIds: collection.product_ids, limit: 24 } : { ...collection.query_rules, limit: Math.min(collection.query_rules.limit ?? limit, 24) };
            resolved.collection = { code: collection.code, title: collection.title, description: collection.description };
          }
        } else if (Array.isArray(binding.productIds) && binding.productIds.length) {
          rules = { productIds: (binding.productIds as string[]).filter((id) => isUuid(id)), limit: 24 };
        } else if ((code === 'product_card' || (HERO_CODES.has(code) && heroBinding === 'product') || code === 'installment_card') && isUuid(binding.productId)) {
          rules = { productIds: [binding.productId], limit: 1 };
        } else if (code === 'installment_card') {
          rules = { installmentEnabled: true, inStockOnly: false, limit: 1 };
        } else if (campaignScope && !HERO_CODES.has(code)) {
          rules = campaignScope.productIds?.length ? { productIds: campaignScope.productIds, limit }
            : { categories: campaignScope.categories?.length ? campaignScope.categories : undefined, inStockOnly: true, sortBy: 'discount', limit };
        } else if (HERO_CODES.has(code) && heroBinding === 'category' && typeof section.payload.categorySlug === 'string') {
          const cat = await one<{ name: string }>(db, 'SELECT name FROM cms_categories WHERE slug = $1', [section.payload.categorySlug]);
          rules = cat ? { category: cat.name, inStockOnly: true, limit: 4 } : null;
        } else if (HERO_CODES.has(code) && heroBinding === 'vibe' && isSlug(section.payload.vibeSlug)) {
          rules = { vibe: section.payload.vibeSlug, inStockOnly: true, limit: 4 };
        } else if (!HERO_CODES.has(code) && code !== 'product_card') {
          rules = { category: typeof section.payload.category === 'string' && section.payload.category && section.payload.category !== 'همه' ? section.payload.category : undefined,
            vibe: isSlug(section.payload.vibe) ? section.payload.vibe : undefined, limit, sortBy: 'newest' };
        }
        if (rules) resolved.products = await attachCardTemplates(db, await queryCommerceProducts(db, rules));
      }
      if (HERO_CODES.has(code)) resolved.heroEntity = await resolveHeroEntity(db, section.payload, resolved);
      if (code === 'installment_card') {
        const providers = await installmentProviders(db);
        const wanted = typeof section.payload.provider === 'string' && section.payload.provider ? section.payload.provider : section.variant && section.variant !== 'default' && section.variant !== 'generic' ? section.variant : null;
        resolved.providers = providers.filter((p) => !wanted || p.code === wanted)
          .map((p) => ({ code: p.code, title: p.title, count: p.installments_count, badge: p.badge_text, terms: p.terms, color: p.brand_color, logoUrl: p.logo_url, minOrderRial: p.min_order_rial }));
      }
      if (code === 'review_section') {
        const productId = isUuid(binding.productId) ? binding.productId : null;
        const reviews = await db.query(`SELECT r.id, r.rating, r.title, r.body, r.verified_purchase, r.created_at, r.photo_file_ids, u.display_name, p.name AS product_name, p.id AS product_id
          FROM customer_reviews r JOIN users u ON u.id = r.user_id JOIN products p ON p.id = r.product_id
          WHERE r.status = 'approved' AND ($1::uuid IS NULL OR r.product_id = $1) ORDER BY r.created_at DESC LIMIT $2`, [productId, limit]);
        const summary = await one<{ average: number; total: number }>(db, `SELECT COALESCE(AVG(rating),0)::float AS average, COUNT(*)::int AS total FROM customer_reviews
          WHERE status = 'approved' AND ($1::uuid IS NULL OR product_id = $1)`, [productId]);
        const distribution = (await db.query(`SELECT rating, COUNT(*)::int AS n FROM customer_reviews WHERE status = 'approved' AND ($1::uuid IS NULL OR product_id = $1) GROUP BY rating`, [productId])).rows;
        const photos = (await db.query(`SELECT r.id AS review_id, unnest(r.photo_file_ids) AS file_id, p.name AS product_name, u.display_name FROM customer_reviews r
          JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.user_id WHERE r.status = 'approved' AND ($1::uuid IS NULL OR r.product_id = $1)
          ORDER BY r.created_at DESC LIMIT 12`, [productId])).rows.map((row: { review_id: string; file_id: string; product_name: string; display_name: string }) =>
          ({ reviewId: row.review_id, url: `/api/v1/media/${row.file_id}`, productName: row.product_name, author: row.display_name }));
        resolved.reviews = reviews.rows.map((r: Record<string, unknown>) => ({ ...r, photos: ((r.photo_file_ids as string[]) ?? []).map((id) => `/api/v1/media/${id}`) }));
        resolved.reviewSummary = { average: Math.round((summary?.average ?? 0) * 10) / 10, total: summary?.total ?? 0, distribution };
        resolved.customerPhotos = photos;
        if (productId) resolved.products = await attachCardTemplates(db, await commerceProductsByIds(db, [productId]));
      }
      if (code === 'category_card' || code === 'category_section') {
        resolved.categories = (await db.query(`SELECT c.id, c.name, c.slug, c.description, c.image_url, c.cover_url, c.icon, c.card_template, c.card_style, c.parent_id,
          (SELECT count(*)::int FROM products p WHERE p.category = c.name AND p.status = 'published') AS product_count
          FROM cms_categories c WHERE c.active ORDER BY c.position, c.name`)).rows;
      }
      if (code === 'collection_showcase') {
        const codes = typeof section.payload.collectionCodes === 'string' ? section.payload.collectionCodes.split(/[،,\s]+/).map((c) => c.trim()).filter((c) => /^[a-z0-9-]{2,40}$/.test(c)) : [];
        const rows = (await db.query(`SELECT code, title, description, mode, query_rules, product_ids FROM cms_collections WHERE active AND (cardinality($1::text[]) = 0 OR code = ANY($1::text[]))
          ORDER BY created_at LIMIT $2`, [codes, Math.min(Number(section.payload.limit ?? 4) || 4, 8)])).rows as { code: string; title: string; description: string; mode: string; query_rules: CollectionRules; product_ids: string[] }[];
        resolved.collections = await Promise.all(rows.map(async (c) => {
          const items = c.mode === 'manual' ? await commerceProductsByIds(db, c.product_ids.slice(0, 3)) : await queryCommerceProducts(db, { ...c.query_rules, limit: 3 });
          return { code: c.code, title: c.title, description: c.description, images: items.map((p) => p.image).filter(Boolean), count: items.length };
        }));
      }
    } catch { /* a broken binding must never 500 the whole page (Req 174) — the section renders its static payload */ }
    out.push({ ...section, resolved });
  }
  return out;
}

/** Hero content binding (Req 212): Campaign / Product / Category / Vibe / Collection / Manual. */
async function resolveHeroEntity(db: DbPool | PoolClient, payload: Record<string, unknown>, resolved: Record<string, unknown>) {
  const type = String(payload.bindingType ?? 'manual');
  const products = (resolved.products as CommerceProduct[] | undefined) ?? [];
  if (type === 'product' && products[0]) {
    const p = products[0];
    return { type, title: p.name, subtitle: `${p.brand} · ${p.category}`, image: p.image, target: `product:${p.id}`, priceRial: p.priceRial, compareAtRial: p.compareAtRial,
      perInstallmentRial: p.perInstallmentRial, installmentsCount: p.installmentsCount, available: p.available };
  }
  if (type === 'category' && typeof payload.categorySlug === 'string') {
    const c = await one<{ name: string; description: string; cover_url: string | null; image_url: string | null }>(db, 'SELECT name, description, cover_url, image_url FROM cms_categories WHERE slug = $1 AND active', [payload.categorySlug]);
    if (c) return { type, title: c.name, subtitle: c.description, image: c.cover_url ?? c.image_url ?? products[0]?.image ?? null, target: `category:${c.name}` };
  }
  if (type === 'vibe' && typeof payload.vibeSlug === 'string') {
    const v = await one<{ name: string; description: string; cover_url: string | null; palette: Record<string, string>; slug: string }>(db, 'SELECT name, slug, description, cover_url, palette FROM cms_vibes WHERE slug = $1 AND active', [payload.vibeSlug]);
    if (v) return { type, title: v.name, subtitle: v.description, image: v.cover_url ?? products[0]?.image ?? null, target: `vibe:${v.slug}`, palette: v.palette };
  }
  if (type === 'collection' && resolved.collection) {
    const c = resolved.collection as { code: string; title: string; description: string };
    return { type, title: c.title, subtitle: c.description, image: products[0]?.image ?? null, target: `collection:${c.code}`, mosaic: products.slice(0, 4).map((p) => p.image) };
  }
  if (type === 'campaign' && resolved.campaign) {
    const c = resolved.campaign as { name: string; occasion: string | null; ends_at: string; discount_percent: string | null };
    return { type, title: c.name, subtitle: c.discount_percent ? `تا ${Math.round(Number(c.discount_percent))}٪ تخفیف` : (c.occasion ?? ''), endsAt: c.ends_at, target: 'shop' };
  }
  return null;
}

function pickBinding(payload: Record<string, unknown>) {
  const binding: Record<string, unknown> = {};
  for (const key of ['campaignId', 'collectionCode', 'productIds', 'productId']) if (payload[key] !== undefined && payload[key] !== '') binding[key] = payload[key];
  return binding;
}

async function snapshotPage(client: PoolClient, pageId: string, actorId: string, status: string, summary?: string) {
  const page = await one<{ version: number; title: string; seo: unknown }>(client, 'SELECT version, title, seo FROM cms_pages WHERE id = $1 FOR UPDATE', [pageId]);
  if (!page) throw notFound();
  const sections = await workingSections(client, pageId, false);
  const version = Number(page.version) + 1;
  await client.query(`INSERT INTO cms_page_versions(id,page_id,version,title,status,sections_snapshot,seo_snapshot,change_summary,changed_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), pageId, version, page.title, status, JSON.stringify(sections), JSON.stringify(page.seo ?? {}), summary ?? null, actorId]);
  await client.query('UPDATE cms_pages SET version = $2 WHERE id = $1', [pageId, version]);
  return { version, sectionCount: sections.length };
}

/** Public read model: last published snapshot (fallback: live sections for legacy pages never published). */
export async function loadPublicPage(pool: DbPool, code: string, origin = 'https://kolbe.ir') {
  const page = await one<Record<string, unknown> & { id: string; status: string; active: boolean; scheduled_start_at: string | null; scheduled_end_at: string | null }>(pool,
    'SELECT * FROM cms_pages WHERE code = $1', [code]);
  if (!page || !pageIsLive(page)) return null;
  const snapshot = await one<{ sections_snapshot: SectionRow[]; version: number }>(pool,
    `SELECT sections_snapshot, version FROM cms_page_versions WHERE page_id = $1 AND status IN ('published','scheduled')
     ORDER BY version DESC LIMIT 1`, [page.id]);
  const sections = snapshot ? snapshot.sections_snapshot.filter((s) => s.visible) : await workingSections(pool, page.id, true);
  // Req 235: head tags come from the SEO Domain, not from the CMS row.
  const subject = await loadSubject(pool, 'page', code);
  const seo = subject ? resolveSeo(subject, await loadEntry(pool, 'page', code), origin) : null;
  return { ...page, seo, publishedVersion: snapshot?.version ?? null, sections: await enrichSections(pool, sections) };
}

/* ============================ Routes ============================ */

export function registerCmsStudioRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  const actor = async (request: Parameters<typeof principal>[0], permission: string) => {
    const user = await principal(request, pool, config); requirePermission(user, permission); return user;
  };

  /* ---------- Public media (Req 312): only files referenced by public entities are served ---------- */
  app.get('/api/v1/media/:fileId', async (request, reply) => {
    const { fileId } = z.object({ fileId: z.uuid() }).parse(request.params);
    // Req 234: responsive variants (?w=640&fmt=webp), snapped to fixed breakpoints and cached per file.
    const { w, fmt } = z.object({ w: z.coerce.number().int().min(16).max(4000).optional(), fmt: z.enum(['webp', 'jpeg', 'png']).optional() }).parse(request.query);
    const file = await one<{ storage_key: string; mime_type: string; size_bytes: number }>(pool,
      `SELECT f.storage_key, f.mime_type, f.size_bytes FROM files f WHERE f.id = $1 AND (
         f.visibility = 'public'
         OR EXISTS (SELECT 1 FROM products p WHERE p.status = 'published' AND p.metadata::text LIKE '%' || $1::text || '%')
         OR EXISTS (SELECT 1 FROM product_media pm JOIN products p ON p.id = pm.product_id WHERE pm.file_id = f.id AND p.status = 'published')
         OR EXISTS (SELECT 1 FROM cms_assets a WHERE a.file_id = f.id)
         OR EXISTS (SELECT 1 FROM cms_sections s WHERE s.payload::text LIKE '%' || $1::text || '%')
         OR EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
         OR EXISTS (SELECT 1 FROM customer_reviews r WHERE r.status = 'approved' AND f.id = ANY(r.photo_file_ids)))`, [fileId]);
    if (!file) throw notFound();
    if ((w || fmt) && isResizable(file.mime_type)) {
      const width = snapWidth(w ?? 1600);
      const format = fmt ?? (file.mime_type === 'image/png' ? 'png' : file.mime_type === 'image/webp' ? 'webp' : 'jpeg');
      const cached = await one<{ storage_key: string }>(pool, 'SELECT storage_key FROM media_variants WHERE file_id = $1 AND width = $2 AND format = $3', [fileId, width, format]);
      if (cached) {
        const data = await getFile(cached.storage_key).catch(() => null);
        if (data) return reply.header('Content-Type', `image/${format}`).header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff').header('X-Media-Variant', `${width}w`).send(data);
      }
      const variant = await renderVariant(await getFile(file.storage_key), width, format).catch(() => null);
      if (variant) {
        const stored = await putFile(variant.buffer, `variant-${width}.${format === 'jpeg' ? 'jpg' : format}`, variant.mime).catch(() => null);
        if (stored) await pool.query(`INSERT INTO media_variants(file_id, width, format, storage_key, size_bytes) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (file_id, width, format) DO UPDATE SET storage_key = EXCLUDED.storage_key, size_bytes = EXCLUDED.size_bytes`,
          [fileId, width, format, stored.storageKey, variant.buffer.length]).catch(() => undefined);
        return reply.header('Content-Type', variant.mime).header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('X-Content-Type-Options', 'nosniff').header('X-Media-Variant', `${width}w`).send(variant.buffer);
      }
    }
    const buffer = await getFile(file.storage_key);
    return reply.header('Content-Type', file.mime_type).header('Cache-Control', 'public, max-age=86400, immutable')
      .header('X-Content-Type-Options', 'nosniff').send(buffer);
  });

  /* ---------- Public site surface ---------- */
  app.get('/api/v1/site/pages/:code', async (request) => {
    const { code } = z.object({ code: z.string().trim().max(40) }).parse(request.params);
    const page = await loadPublicPage(pool, code, config.PUBLIC_ORIGIN);
    if (!page) throw notFound();
    return page;
  });

  /** Canonical URLs from the SEO Domain (e.g. /about, /campaign/x) deep-link into the SPA (Req 235). */
  app.get('/api/v1/site/resolve-path', async (request) => {
    const { path } = z.object({ path: z.string().regex(/^\/[a-z0-9/_-]{0,120}$/) }).parse(request.query);
    const page = await one<{ code: string; active: boolean; status: string; scheduled_start_at: string | null; scheduled_end_at: string | null }>(pool,
      'SELECT code, active, status, scheduled_start_at, scheduled_end_at FROM cms_pages WHERE path = $1 ORDER BY updated_at DESC LIMIT 1', [path]);
    if (!page || !pageIsLive(page)) throw notFound();
    return { kind: 'page', code: page.code };
  });

  app.get('/api/v1/site/layout', async () => {
    const [header, footer, accountAppearance] = await Promise.all([
      readSetting(pool, 'global_header'), readSetting(pool, 'global_footer'), readSetting(pool, 'account_appearance')]);
    const rows = (await pool.query('SELECT * FROM cms_announcements WHERE active ORDER BY priority DESC, created_at DESC')).rows as (AnnouncementRow & Record<string, unknown>)[];
    const announcements = [];
    for (const row of pickActiveAnnouncements(rows)) {
      let campaign = null;
      let binding: Record<string, unknown> | null = null;
      const ref = typeof row.binding_id === 'string' ? row.binding_id : '';
      const isId = /^[0-9a-f-]{36}$/.test(ref);
      if ((row.binding_type === 'campaign' || row.binding_type === 'promotion') && ref) {
        campaign = await one<{ id: string; name: string; starts_at: string; ends_at: string; discount_percent: string | null }>(pool,
          `SELECT id, name, starts_at, ends_at, discount_percent FROM festivals WHERE (${isId ? 'id = $1::uuid' : 'code = $1'}) AND active AND ends_at >= now()`, [ref]);
        if (!campaign) continue; // bound campaign/promotion ended → announcement disappears automatically (Req 330-331)
        if (row.binding_type === 'promotion') binding = { kind: 'promotion', discountPercent: campaign.discount_percent ? Math.round(Number(campaign.discount_percent)) : null, target: 'shop' };
      } else if (row.binding_type === 'coupon' && ref) {
        const coupon = await one<{ code: string; type: string; value: string; ends_at: string | null }>(pool,
          `SELECT code, type, value::text, ends_at FROM coupons WHERE (${isId ? 'id = $1::uuid' : 'code = $1'}) AND active AND recipient_user_id IS NULL AND (ends_at IS NULL OR ends_at > now())`, [ref]);
        if (!coupon) continue;
        binding = { kind: 'coupon', code: coupon.code, label: coupon.type === 'percent' ? `${coupon.value}٪` : null, endsAt: coupon.ends_at };
      } else if (row.binding_type === 'collection' && ref) {
        const collection = await one<{ code: string; title: string }>(pool, 'SELECT code, title FROM cms_collections WHERE code = $1 AND active', [ref]);
        if (!collection) continue;
        binding = { kind: 'collection', target: `collection:${collection.code}`, title: collection.title };
      } else if (row.binding_type === 'landing_page' && ref) {
        const page = await one<{ code: string; title: string; status: string; active: boolean; scheduled_start_at: string | null; scheduled_end_at: string | null }>(pool,
          'SELECT code, title, status, active, scheduled_start_at, scheduled_end_at FROM cms_pages WHERE code = $1', [ref]);
        if (!page || !pageIsLive(page)) continue;
        binding = { kind: 'landing_page', target: `page:${page.code}`, title: page.title };
      }
      announcements.push({ id: row.id, title: row.title, messages: row.messages, mode: row.mode, style: row.style,
        bindingType: row.binding_type, bindingId: row.binding_id, priority: row.priority, campaign, binding });
    }
    return { header, footer, accountAppearance, announcements };
  });

  /** Active theme: campaign-bound > festival > scheduled > manual (auto-restores when a window ends, Req 224-225). */
  app.get('/api/v1/site/theme', async () => {
    const campaignTheme = await one<Record<string, unknown>>(pool,
      `SELECT p.id, p.code, p.name, p.colors, p.design_tokens, 'campaign' AS mode, f.name AS campaign_name
       FROM color_palettes p JOIN festivals f ON f.id = p.campaign_id
       WHERE f.active AND f.starts_at <= now() AND f.ends_at >= now() ORDER BY f.starts_at DESC LIMIT 1`);
    const normalize = (row: Record<string, unknown> | null) => row && ({ ...row,
      design_tokens: tokensFromPalette(row.colors as Record<string, string>, row.design_tokens as Record<string, string>) });
    if (campaignTheme) return { theme: normalize(campaignTheme) };
    const theme = await one<Record<string, unknown>>(pool,
      `SELECT p.id, p.code, p.name, p.colors, p.design_tokens, a.mode, a.ends_at
       FROM palette_activations a JOIN color_palettes p ON p.id = a.palette_id
       WHERE a.active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
         AND (a.mode <> 'festival' OR EXISTS (SELECT 1 FROM festivals f WHERE f.id = a.festival_id AND f.active AND f.starts_at <= now() AND f.ends_at >= now()))
       ORDER BY CASE a.mode WHEN 'festival' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 1`);
    return { theme: normalize(theme ?? await one<Record<string, unknown>>(pool, `SELECT id, code, name, colors, design_tokens, 'default' AS mode FROM color_palettes WHERE code = 'kolbe-default'`)) };
  });

  app.get('/api/v1/site/collections/:code', async (request) => {
    const { code } = z.object({ code: z.string().regex(/^[a-z0-9-]{2,40}$/) }).parse(request.params);
    const collection = await one<{ id: string; code: string; title: string; description: string; mode: string; query_rules: CollectionRules; product_ids: string[]; seo: unknown }>(pool,
      'SELECT * FROM cms_collections WHERE code = $1 AND active', [code]);
    if (!collection) throw notFound();
    const products = collection.mode === 'manual'
      ? await commerceProductsByIds(pool, collection.product_ids)
      : await queryCommerceProducts(pool, collection.query_rules);
    const subject = await loadSubject(pool, 'collection', code);
    const seo = subject ? resolveSeo(subject, await loadEntry(pool, 'collection', code), config.PUBLIC_ORIGIN) : null;
    return { ...collection, seo, products: await attachCardTemplates(pool, products) };
  });

  app.get('/api/v1/site/categories', async () => ({ items: (await pool.query('SELECT * FROM cms_categories WHERE active ORDER BY position, name')).rows }));
  app.get('/api/v1/site/vibes', async () => ({ items: (await pool.query('SELECT * FROM cms_vibes WHERE active ORDER BY position, name')).rows }));
  app.get('/api/v1/site/card-templates', async () => ({ items: (await pool.query('SELECT code, name, variant, blocks, styles FROM cms_product_card_templates WHERE active ORDER BY is_system DESC, name')).rows }));

  /** Lead Generation (Req 283): stored + pushed into CRM as a contact activity + automation event. */
  app.post('/api/v1/site/leads', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = z.object({
      pageCode: z.string().regex(/^[a-z0-9_-]{2,40}$/), campaignSource: safeString(80).optional(),
      fullName: safeString(120).optional(), phone: z.string().regex(/^09\d{9}$/).optional(), email: z.email().max(254).optional(),
      consent: z.literal(true),
    }).strict().refine((v) => v.phone || v.email, 'شماره همراه یا ایمیل لازم است.').parse(request.body);
    const result = await transaction(pool, async (client) => {
      const existingUser = await one<{ id: string }>(client, 'SELECT id FROM users WHERE phone = $1 OR email = $2', [body.phone ?? null, body.email?.toLowerCase() ?? null]);
      let contactId: string;
      if (existingUser) contactId = await ensureContact(client, existingUser.id);
      else {
        contactId = randomUUID();
        await client.query(`INSERT INTO crm_contacts(id,user_id,actor_type,segment,tags,metadata) VALUES ($1,NULL,'other','lead',$2,$3)`,
          [contactId, ['lead', body.pageCode], JSON.stringify({ fullName: body.fullName ?? null, phone: body.phone ?? null, email: body.email ?? null, source: body.campaignSource ?? body.pageCode })]);
      }
      await client.query(`INSERT INTO crm_activities(id,contact_id,type,title,body,ref_type,ref_id) VALUES ($1,$2,'event',$3,$4,'cms_lead',$5)`,
        [randomUUID(), contactId, `ثبت سرنخ از صفحه ${body.pageCode}`, body.campaignSource ?? '', body.pageCode]);
      const id = randomUUID();
      await client.query(`INSERT INTO cms_leads(id,page_code,campaign_source,full_name,phone,email,consent,crm_contact_id) VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
        [id, body.pageCode, body.campaignSource ?? null, body.fullName ?? null, body.phone ?? null, body.email ?? null, contactId]);
      await outbox(client, 'cms.lead.created', 'cms_lead', id, { leadId: id, pageCode: body.pageCode, contactId });
      return { id, contactId };
    });
    return reply.code(201).send(result);
  });

  /** Standard component analytics hooks (Req 236). Anonymous allowed; user attached when a token is present. */
  app.post('/api/v1/site/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = z.object({
      eventType: z.enum(['component.view', 'banner.click', 'product_card.click', 'campaign.click', 'cta.click']),
      pageCode: z.string().max(40).optional(), sectionId: z.uuid().optional(), componentCode: z.string().max(40).optional(),
      targetId: z.string().max(80).optional(),
    }).strict().parse(request.body);
    let userId: string | null = null;
    try { userId = (await principal(request, pool, config)).id; } catch { /* anonymous */ }
    await pool.query(`INSERT INTO cms_analytics_events(id,event_type,page_code,section_id,component_code,target_id,user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), body.eventType, body.pageCode ?? null, body.sectionId ?? null, body.componentCode ?? null, body.targetId ?? null, userId]);
    return reply.code(202).send({ accepted: true });
  });

  /* ---------- Admin: registry & composable builder (Req 175-183) ---------- */
  app.get('/api/v1/admin/cms/registry', async (request) => {
    await actor(request, 'cms:read');
    const [components, presets] = await Promise.all([
      pool.query('SELECT * FROM cms_components ORDER BY kind, code'),
      pool.query('SELECT id, component_code, code, title, variant, payload, style_overrides, responsive_config, position FROM cms_component_presets ORDER BY component_code, position'),
    ]);
    const byComponent = new Map<string, unknown[]>();
    for (const row of presets.rows as { component_code: string }[]) byComponent.set(row.component_code, [...(byComponent.get(row.component_code) ?? []), row]);
    return { items: components.rows.map((c: { code: string }) => ({ ...c, presetDefinitions: byComponent.get(c.code) ?? [] })), primitives: PRIMITIVES,
      styleSpec: STYLE_SPEC, simpleStyleKeys: SIMPLE_STYLE_KEYS };
  });

  /** Component presets (Req 180): applying one sets variant + presentational payload + style tokens; content stays. */
  app.post('/api/v1/admin/cms/sections/:id/apply-preset', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { presetCode } = z.object({ presetCode: z.string().regex(/^[a-z0-9_-]{2,40}$/) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const section = await one<{ payload: Record<string, unknown>; component_code: string; field_schema: FieldSchema; style_overrides: Record<string, unknown> }>(client,
        `SELECT s.payload, s.style_overrides, c.code AS component_code, c.field_schema FROM cms_sections s JOIN cms_components c ON c.id = s.component_id WHERE s.id = $1 FOR UPDATE OF s`, [id]);
      if (!section) throw notFound();
      const preset = await one<{ title: string; variant: string; payload: Record<string, unknown>; style_overrides: Record<string, unknown>; responsive_config: Record<string, unknown> }>(client,
        'SELECT title, variant, payload, style_overrides, responsive_config FROM cms_component_presets WHERE component_code = $1 AND code = $2', [section.component_code, presetCode]);
      if (!preset) throw badRequest('این Preset برای این کامپوننت تعریف نشده است.');
      const payload = validateSectionPayload(section.field_schema, { ...section.payload, ...preset.payload });
      const style = validateStyleOverrides(preset.style_overrides);
      await client.query(`UPDATE cms_sections SET payload = $2, variant = $3, preset = $4, style_overrides = $5,
          responsive_config = CASE WHEN $6::jsonb = '{}'::jsonb THEN responsive_config ELSE $6::jsonb END, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(payload), preset.variant, presetCode, JSON.stringify(style), JSON.stringify(preset.responsive_config ?? {})]);
      await audit(client, user.id, 'cms.section_preset_applied', 'cms_section', id, { payload: section.payload, style: section.style_overrides }, { presetCode, variant: preset.variant }, request.ip);
      return one(client, 'SELECT * FROM cms_sections WHERE id = $1', [id]);
    });
  });

  /** Validates a draft payload against the typed schema without saving (used by the schema-driven editor). */
  app.post('/api/v1/admin/cms/components/:code/validate', async (request) => {
    await actor(request, 'cms:read');
    const { code } = z.object({ code: z.string().regex(/^[a-z0-9_]{2,40}$/) }).parse(request.params);
    const component = await one<{ field_schema: FieldSchema }>(pool, 'SELECT field_schema FROM cms_components WHERE code = $1', [code]);
    if (!component) throw notFound();
    return { payload: validateSectionPayload(component.field_schema, z.record(z.string(), z.unknown()).parse(request.body)) };
  });

  app.post('/api/v1/admin/cms/components/composable', async (request, reply) => {
    const user = await actor(request, 'cms:components');
    const body = z.object({
      code: z.string().regex(/^[a-z0-9_]{2,40}$/), title: safeString(120),
      composition: z.array(z.any()).min(1).max(40),
      variants: z.array(z.string().regex(/^[a-z0-9_-]{2,30}$/)).min(1).max(10).default(['default']),
      presets: z.array(safeString(60)).max(10).default([]),
      styleTokens: z.record(z.string(), z.string().max(60)).default({}),
    }).strict().parse(request.body);
    validateComposition(body.composition as CompositionNode[]);
    assertSafeText(body.styleTokens, 'styleTokens');
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_components(id,code,title,component_type,kind,composition,variants,presets,style_tokens,field_schema)
        VALUES ($1,$2,$3,'composable','composable',$4,$5,$6,$7,$8)`,
        [id, body.code, body.title, JSON.stringify(body.composition), JSON.stringify(body.variants), JSON.stringify(body.presets),
          JSON.stringify(body.styleTokens), JSON.stringify({ props: ['title', 'text', 'image', 'ctaLabel', 'ctaTarget'] })]);
      await audit(client, user.id, 'cms.component_created', 'cms_component', id, undefined, { code: body.code, kind: 'composable' }, request.ip);
    });
    return reply.code(201).send({ id, code: body.code, kind: 'composable' });
  });

  app.patch('/api/v1/admin/cms/components/:id/composition', async (request) => {
    const user = await actor(request, 'cms:components');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ composition: z.array(z.any()).min(1).max(40), variants: z.array(z.string().regex(/^[a-z0-9_-]{2,30}$/)).max(10).optional() }).strict().parse(request.body);
    validateComposition(body.composition as CompositionNode[]);
    return transaction(pool, async (client) => {
      const before = await one<{ kind: string; composition: unknown }>(client, 'SELECT kind, composition FROM cms_components WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (before.kind !== 'composable') throw badRequest('کامپوننت‌های کدنویسی‌شده فقط توسط توسعه‌دهنده تغییر می‌کنند.');
      await client.query('UPDATE cms_components SET composition = $2, variants = COALESCE($3, variants), updated_at = now() WHERE id = $1',
        [id, JSON.stringify(body.composition), body.variants ? JSON.stringify(body.variants) : null]);
      await audit(client, user.id, 'cms.template_updated', 'cms_component', id, before, body, request.ip);
      return { id, updated: true };
    });
  });

  app.delete('/api/v1/admin/cms/components/:id', async (request) => {
    const user = await actor(request, 'cms:components');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const row = await one<{ kind: string; code: string }>(client, 'SELECT kind, code FROM cms_components WHERE id = $1 FOR UPDATE', [id]);
      if (!row) throw notFound();
      if (row.kind !== 'composable') throw badRequest('کامپوننت‌های سیستمی حذف نمی‌شوند؛ می‌توانید آن‌ها را غیرفعال کنید.');
      const used = await one<{ n: number }>(client, 'SELECT count(*)::int AS n FROM cms_sections WHERE component_id = $1', [id]);
      if (used && used.n > 0) throw conflict(`این کامپوننت در ${used.n} بخش استفاده شده است.`);
      await client.query('DELETE FROM cms_components WHERE id = $1', [id]);
      await audit(client, user.id, 'cms.component_deleted', 'cms_component', id, row, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  /* ---------- Admin: page lifecycle (Req 214-217, 281-282) ---------- */
  app.post('/api/v1/admin/cms/landing-pages', async (request, reply) => {
    const user = await actor(request, 'cms:edit');
    const body = z.object({
      code: z.string().regex(/^[a-z0-9_-]{2,40}$/), title: safeString(160),
      path: z.string().regex(/^\/[a-z0-9/_-]{0,120}$/),
      pageType: z.enum(['about', 'landing', 'campaign', 'collection', 'vibe', 'lead_generation', 'generic']),
      description: safeString(1000).default(''), campaignId: z.uuid().nullable().optional(),
      seo: z.object({ title: safeString(160).optional(), description: safeString(320).optional(), canonical: z.string().max(300).optional(), index: z.boolean().optional() }).strict().default({}),
      template: z.enum(['blank', 'about', 'campaign', 'vibe', 'lead']).default('blank'),
    }).strict().parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_pages(id,code,title,path,description,seo,active,page_type,status,campaign_id)
        VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,true,$6,'draft',$7)`,
        [id, body.code, body.title, body.path, body.description, body.pageType, body.campaignId ?? null]);
      const seo = legacySeoToWrite(body.seo);
      if (seo) await upsertSeoEntry(client, 'page', body.code, seo, user.id, config.PUBLIC_ORIGIN, request.ip);
      const templates: Record<string, { code: string; title: string; payload: Record<string, unknown> }[]> = {
        blank: [],
        about: [
          { code: 'story_hero', title: 'هیرو داستان ما', payload: { eyebrow: 'از ۱۳۹۸', title: body.title, subtitle: 'روایت کلبه وینتیج', yearFounded: '۱۳۹۸', location: 'تهران' } },
          { code: 'text_section', title: 'روایت برند', payload: { eyebrow: 'داستان برند', title: 'اصالت، دوخت و ماندگاری', body: 'متن روایت برند را اینجا بنویسید.' } },
          { code: 'timeline', title: 'تایم‌لاین', payload: { title: 'مسیر کلبه', milestones: '۱۳۹۸|شروع\n۱۴۰۱|بازارچه عمده\n۱۴۰۵|استایل‌بیلدر هوشمند' } },
          { code: 'values_grid', title: 'ارزش‌ها', payload: { title: 'ارزش‌های ما', values: 'اصالت|پارچه طبیعی و دوخت دقیق\nماندگاری|طراحی فراتر از فصل\nشفافیت|قیمت و موجودی واقعی' } },
          { code: 'stats_strip', title: 'آمار', payload: { stats: '۱۲هزار+|مشتری\n۱۲۰+|تأمین‌کننده\n۴.۹|امتیاز' } },
          { code: 'cta', title: 'دعوت به خرید', payload: { title: 'کالکشن کلبه را ببینید', cta: 'ورود به فروشگاه', target: 'shop' } },
        ],
        campaign: [
          { code: 'hero', title: 'هیرو کمپین', payload: { template: 'fullviewport', eyebrow: 'کمپین ویژه', title: body.title, subtitle: '', ctaLabel: 'مشاهده پیشنهادها', ctaTarget: 'shop', campaignId: body.campaignId ?? undefined } },
          { code: 'countdown', title: 'شمارش معکوس', payload: { title: 'تا پایان کمپین', mode: body.campaignId ? 'campaign' : 'manual', campaignId: body.campaignId ?? undefined, tone: 'terra' } },
          { code: 'product_grid', title: 'محصولات کمپین', payload: { title: 'پیشنهادهای ویژه', collectionCode: 'new-arrivals', limit: 8 } },
        ],
        vibe: [
          { code: 'hero', title: 'هیرو وایب', payload: { template: 'minimal', eyebrow: 'Vibe', title: body.title, subtitle: body.description, ctaLabel: 'خرید این استایل', ctaTarget: 'shop' } },
          { code: 'product_grid', title: 'محصولات وایب', payload: { title: 'منتخب این وایب', collectionCode: 'old-money-edit', limit: 8 } },
        ],
        lead: [
          { code: 'hero', title: 'هیرو لندینگ', payload: { template: 'minimal', eyebrow: 'دسترسی زودهنگام', title: body.title, subtitle: body.description, ctaLabel: '', ctaTarget: 'shop' } },
          { code: 'lead_form', title: 'فرم سرنخ', payload: { title: 'عضو فهرست انتظار شوید', subtitle: 'اولین نفری باشید که از کالکشن جدید باخبر می‌شود.', campaignSource: body.code, ctaLabel: 'ثبت‌نام', consentText: 'با ارسال فرم، دریافت پیامک اطلاع‌رسانی کلبه را می‌پذیرم.', collectEmail: true, collectName: true } },
        ],
      };
      let position = 1;
      for (const section of templates[body.template] ?? []) {
        const component = await one<{ id: string }>(client, 'SELECT id FROM cms_components WHERE code = $1', [section.code]);
        if (!component) continue;
        await client.query('INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position) VALUES ($1,$2,$3,$4,$5,true,$6)',
          [randomUUID(), id, component.id, section.title, JSON.stringify(section.payload), position++]);
      }
      await audit(client, user.id, 'cms.page_created', 'cms_page', id, undefined, { code: body.code, template: body.template }, request.ip);
    });
    return reply.code(201).send({ id, code: body.code, status: 'draft' });
  });

  app.get('/api/v1/admin/cms/pages/:id/preview', async (request) => {
    await actor(request, 'cms:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const page = await one(pool, 'SELECT * FROM cms_pages WHERE id = $1', [id]);
    if (!page) throw notFound();
    return { ...page, preview: true, sections: await enrichSections(pool, await workingSections(pool, id, true)) };
  });

  app.post('/api/v1/admin/cms/pages/:id/publish', async (request) => {
    const user = await actor(request, 'cms:publish');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      scheduledStartAt: z.iso.datetime().nullable().optional(), scheduledEndAt: z.iso.datetime().nullable().optional(),
      changeSummary: safeString(300).optional(),
    }).strict().parse(request.body ?? {});
    if (body.scheduledStartAt && body.scheduledEndAt && new Date(body.scheduledEndAt) <= new Date(body.scheduledStartAt)) throw badRequest('پایان زمان‌بندی باید بعد از شروع باشد.');
    const scheduled = Boolean(body.scheduledStartAt && new Date(body.scheduledStartAt) > new Date());
    const status = scheduled ? 'scheduled' : 'published';
    return transaction(pool, async (client) => {
      const snapshot = await snapshotPage(client, id, user.id, status, body.changeSummary);
      await client.query(`UPDATE cms_pages SET status = $2, scheduled_start_at = $3, scheduled_end_at = $4, published_at = now(), published_by = $5, updated_at = now() WHERE id = $1`,
        [id, status, body.scheduledStartAt ?? null, body.scheduledEndAt ?? null, user.id]);
      await audit(client, user.id, scheduled ? 'cms.page_scheduled' : 'cms.page_published', 'cms_page', id, undefined, { ...snapshot, ...body }, request.ip);
      await outbox(client, scheduled ? 'cms.page.scheduled' : 'cms.page.published', 'cms_page', id, { pageId: id, version: snapshot.version, ...body });
      return { id, status, ...snapshot };
    });
  });

  app.post('/api/v1/admin/cms/pages/:id/unpublish', async (request) => {
    const user = await actor(request, 'cms:publish');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ archive: z.boolean().default(false) }).strict().parse(request.body ?? {});
    return transaction(pool, async (client) => {
      const before = await one<{ status: string; code: string }>(client, 'SELECT status, code FROM cms_pages WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (before.code === 'home' && body.archive) throw badRequest('صفحه اصلی بایگانی نمی‌شود.');
      const status = body.archive ? 'archived' : 'draft';
      await client.query('UPDATE cms_pages SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
      await audit(client, user.id, 'cms.page_unpublished', 'cms_page', id, before, { status }, request.ip);
      return { id, status };
    });
  });

  app.get('/api/v1/admin/cms/pages/:id/versions', async (request) => {
    await actor(request, 'cms:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(`SELECT v.id, v.version, v.title, v.status, v.change_summary, v.created_at, jsonb_array_length(v.sections_snapshot) AS section_count,
        u.display_name AS changed_by_name FROM cms_page_versions v LEFT JOIN users u ON u.id = v.changed_by WHERE v.page_id = $1 ORDER BY v.version DESC LIMIT 50`, [id]);
    return { items: rows.rows };
  });

  /** Restore = copy a snapshot back into the working copy (draft). Publishing it again is explicit. */
  app.post('/api/v1/admin/cms/pages/:id/versions/:version/restore', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id, version } = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }).parse(request.params);
    return transaction(pool, async (client) => {
      const snap = await one<{ sections_snapshot: SectionRow[] }>(client, 'SELECT sections_snapshot FROM cms_page_versions WHERE page_id = $1 AND version = $2', [id, version]);
      if (!snap) throw notFound();
      await client.query('DELETE FROM cms_sections WHERE page_id = $1', [id]);
      for (const section of snap.sections_snapshot) {
        const component = await one<{ id: string }>(client, 'SELECT id FROM cms_components WHERE code = $1', [section.component_code]);
        if (!component) continue;
        await client.query(`INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position,variant,preset,section_theme,data_binding,style_overrides,responsive_config)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [randomUUID(), id, component.id, section.title, JSON.stringify(section.payload ?? {}), section.visible, section.position,
            section.variant ?? 'default', section.preset ?? null, section.section_theme ?? 'inherit', JSON.stringify(section.data_binding ?? {}),
            JSON.stringify(section.style_overrides ?? {}), JSON.stringify(section.responsive_config ?? {})]);
      }
      await audit(client, user.id, 'cms.version_restored', 'cms_page', id, undefined, { version }, request.ip);
      return { id, restoredVersion: version, sections: snap.sections_snapshot.length };
    });
  });

  app.patch('/api/v1/admin/cms/sections/:id/presentation', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      variant: z.string().regex(/^[a-z0-9_-]{2,30}$/).optional(), preset: safeString(60).nullable().optional(),
      sectionTheme: z.enum(['inherit', 'light', 'dark', 'campaign']).optional(),
      dataBinding: z.object({ campaignId: z.uuid().optional(), collectionCode: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
        productIds: z.array(z.uuid()).max(24).optional(), productId: z.uuid().optional(), source: z.enum(['products', 'categories', 'vibes', 'campaign', 'recommendations', 'reviews', 'manual']).optional() }).strict().optional(),
      styleOverrides: z.record(z.string(), z.union([z.string().max(60), z.number(), z.boolean()])).optional(),
      responsiveConfig: responsiveConfigSchema.optional(),
    }).strict().parse(request.body);
    // Req 181/226/228: only design-token values are accepted — never raw CSS.
    if (body.styleOverrides) body.styleOverrides = validateStyleOverrides(body.styleOverrides);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT variant, preset, section_theme, data_binding FROM cms_sections WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(`UPDATE cms_sections SET variant = COALESCE($2, variant), preset = CASE WHEN $3::boolean THEN $4 ELSE preset END,
          section_theme = COALESCE($5, section_theme), data_binding = COALESCE($6, data_binding), style_overrides = COALESCE($7, style_overrides),
          responsive_config = COALESCE($8, responsive_config), updated_at = now() WHERE id = $1`,
        [id, body.variant ?? null, body.preset !== undefined, body.preset ?? null, body.sectionTheme ?? null,
          body.dataBinding ? JSON.stringify(body.dataBinding) : null, body.styleOverrides ? JSON.stringify(body.styleOverrides) : null,
          body.responsiveConfig ? JSON.stringify(body.responsiveConfig) : null]);
      await audit(client, user.id, body.dataBinding?.campaignId ? 'cms.campaign_binding' : 'cms.section_presentation', 'cms_section', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_sections WHERE id = $1', [id]);
    });
  });

  app.post('/api/v1/admin/cms/sections/:id/duplicate', async (request, reply) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const copyId = randomUUID();
    await transaction(pool, async (client) => {
      const source = await one<{ page_id: string; position: number }>(client, 'SELECT page_id, position FROM cms_sections WHERE id = $1', [id]);
      if (!source) throw notFound();
      await client.query('UPDATE cms_sections SET position = position + 1 WHERE page_id = $1 AND position > $2', [source.page_id, source.position]);
      await client.query(`INSERT INTO cms_sections(id,page_id,component_id,title,payload,visible,position,variant,preset,section_theme,data_binding,style_overrides,responsive_config)
        SELECT $2,page_id,component_id,title || ' (کپی)',payload,visible,position + 1,variant,preset,section_theme,data_binding,style_overrides,responsive_config FROM cms_sections WHERE id = $1`, [id, copyId]);
      await audit(client, user.id, 'cms.section_duplicated', 'cms_section', copyId, undefined, { from: id }, request.ip);
    });
    return reply.code(201).send({ id: copyId });
  });

  /* ---------- Admin: product-card templates & rules (Req 192-198) ---------- */
  app.get('/api/v1/admin/cms/card-templates', async (request) => {
    await actor(request, 'cms:read');
    return { items: (await pool.query('SELECT * FROM cms_product_card_templates ORDER BY is_system DESC, name')).rows };
  });

  const cardTemplateBody = z.object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/), name: safeString(120), variant: z.string().regex(/^[a-z0-9-]{2,30}$/),
    blocks: z.array(z.enum(CARD_BLOCKS)).min(2).max(11),
    styles: cardStylesSchema,
    active: z.boolean().default(true),
  }).strict();

  app.post('/api/v1/admin/cms/card-templates', async (request, reply) => {
    const user = await actor(request, 'cms:templates');
    const body = cardTemplateBody.parse(request.body);
    const report = designQualityGate(body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_product_card_templates(id,code,name,variant,blocks,styles,quality_report,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.code, body.name, body.variant, JSON.stringify(body.blocks), JSON.stringify(body.styles), JSON.stringify(report), body.active && report.passed]);
      await audit(client, user.id, 'cms.template_updated', 'cms_card_template', id, undefined, { code: body.code, report }, request.ip);
    });
    return reply.code(201).send({ id, code: body.code, qualityReport: report, active: body.active && report.passed });
  });

  app.patch('/api/v1/admin/cms/card-templates/:id', async (request) => {
    const user = await actor(request, 'cms:templates');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody(cardTemplateBody.omit({ code: true }).partial().parse(request.body), request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ blocks: string[]; styles: Record<string, unknown>; is_system: boolean }>(client, 'SELECT * FROM cms_product_card_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const next = { blocks: body.blocks ?? before.blocks, styles: body.styles ? { ...before.styles, ...body.styles } : before.styles };
      const report = designQualityGate(next);
      if (body.active && !report.passed) throw badRequest('قالب از بررسی کیفیت طراحی عبور نکرده و قابل فعال‌سازی نیست.');
      await client.query(`UPDATE cms_product_card_templates SET name = COALESCE($2,name), variant = COALESCE($3,variant), blocks = $4, styles = $5,
          quality_report = $6, active = COALESCE($7, active) AND $8, updated_at = now() WHERE id = $1`,
        [id, body.name ?? null, body.variant ?? null, JSON.stringify(next.blocks), JSON.stringify(next.styles), JSON.stringify(report), body.active ?? null, report.passed]);
      await audit(client, user.id, 'cms.template_updated', 'cms_card_template', id, before, { ...body, report }, request.ip);
      return { id, qualityReport: report };
    });
  });

  app.post('/api/v1/admin/cms/card-templates/quality-check', async (request) => {
    await actor(request, 'cms:read');
    const body = cardTemplateBody.pick({ blocks: true, styles: true }).parse(request.body);
    return designQualityGate(body);
  });

  app.get('/api/v1/admin/cms/card-rules', async (request) => {
    await actor(request, 'cms:read');
    return { items: (await pool.query('SELECT * FROM cms_product_card_rules ORDER BY priority, created_at')).rows };
  });

  const cardRuleBody = z.object({
    name: safeString(160), priority: z.number().int().min(1).max(1000),
    conditions: z.object({ minDiscountPercent: z.number().int().min(1).max(95).optional(), isNew: z.boolean().optional(),
      installmentEnabled: z.boolean().optional(), inActiveCampaign: z.boolean().optional(), vibe: z.string().max(40).optional(), category: z.string().max(120).optional(),
      collectionCode: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), maxAvailable: z.number().int().min(0).max(50).optional(), outOfStock: z.boolean().optional() }).strict(),
    templateCode: z.string().regex(/^[a-z0-9-]{2,40}$/), active: z.boolean().default(true),
    startsAt: z.iso.datetime().nullable().optional(), endsAt: z.iso.datetime().nullable().optional(),
  }).strict();

  app.post('/api/v1/admin/cms/card-rules', async (request, reply) => {
    const user = await actor(request, 'cms:templates');
    const body = cardRuleBody.parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      const template = await one(client, 'SELECT id FROM cms_product_card_templates WHERE code = $1 AND active', [body.templateCode]);
      if (!template) throw badRequest('قالب کارت انتخاب‌شده فعال نیست.');
      await client.query(`INSERT INTO cms_product_card_rules(id,name,priority,conditions,template_code,active,starts_at,ends_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.name, body.priority, JSON.stringify(body.conditions), body.templateCode, body.active, body.startsAt ?? null, body.endsAt ?? null]);
      await audit(client, user.id, 'cms.card_rule_created', 'cms_card_rule', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id });
  });

  app.patch('/api/v1/admin/cms/card-rules/:id', async (request) => {
    const user = await actor(request, 'cms:templates');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody(cardRuleBody.partial().parse(request.body), request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cms_product_card_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(`UPDATE cms_product_card_rules SET name = COALESCE($2,name), priority = COALESCE($3,priority), conditions = COALESCE($4,conditions),
          template_code = COALESCE($5,template_code), active = COALESCE($6,active),
          starts_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE starts_at END, ends_at = CASE WHEN $9::boolean THEN $10::timestamptz ELSE ends_at END WHERE id = $1`,
        [id, body.name ?? null, body.priority ?? null, body.conditions ? JSON.stringify(body.conditions) : null, body.templateCode ?? null, body.active ?? null,
          body.startsAt !== undefined, body.startsAt ?? null, body.endsAt !== undefined, body.endsAt ?? null]);
      await audit(client, user.id, 'cms.card_rule_updated', 'cms_card_rule', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_product_card_rules WHERE id = $1', [id]);
    });
  });

  app.delete('/api/v1/admin/cms/card-rules/:id', async (request) => {
    const user = await actor(request, 'cms:templates');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cms_product_card_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('DELETE FROM cms_product_card_rules WHERE id = $1', [id]);
      await audit(client, user.id, 'cms.card_rule_deleted', 'cms_card_rule', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  /* ---------- Admin: categories, vibes, collections (Req 199-208) ---------- */
  const taxonomy = (table: 'cms_categories' | 'cms_vibes') => {
    const base = z.object({
      name: safeString(120), slug: z.string().regex(/^[a-z0-9-]{2,60}$/), description: safeString(1000).default(''),
      coverUrl: z.string().max(400).nullable().optional(), position: z.number().int().min(0).max(1000).default(0), active: z.boolean().default(true),
      seo: z.object({ title: safeString(160).optional(), description: safeString(320).optional() }).strict().default({}),
      ...(table === 'cms_categories'
        ? { imageUrl: z.string().max(400).nullable().optional(), icon: z.string().max(40).nullable().optional(),
            cardTemplate: z.enum(['image', 'editorial', 'minimal', 'glass', 'overlay', 'horizontal']).default('editorial'),
            parentId: z.uuid().nullable().optional(),
            cardStyle: z.object({ aspect: z.enum(['4/3', '1/1', '3/4', '16/9']).optional(), radius: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
              overlay: z.number().int().min(0).max(80).optional(), textAlign: z.enum(['start', 'center']).optional(), showDescription: z.boolean().optional(),
              accent: z.enum(['accent', 'primary', 'surface']).optional() }).strict().optional() }
        : { palette: z.object({ primary: hex, accent: hex, background: hex }).strict().optional() }),
    }).strict();
    const label = table === 'cms_categories' ? 'category' : 'vibe';
    const path = table === 'cms_categories' ? 'categories' : 'vibes';
    app.get(`/api/v1/admin/cms/${path}`, async (request) => {
      await actor(request, 'cms:read');
      const rows = await pool.query(table === 'cms_vibes'
        ? `SELECT v.*, (SELECT count(*)::int FROM products p WHERE v.slug = ANY(p.vibes)) AS product_count FROM cms_vibes v ORDER BY position, name`
        : `SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category = c.name) AS product_count FROM cms_categories c ORDER BY position, name`);
      return { items: rows.rows };
    });
    app.post(`/api/v1/admin/cms/${path}`, async (request, reply) => {
      const user = await actor(request, 'cms:edit');
      const body = base.parse(request.body) as Record<string, unknown> & { name: string; slug: string };
      const id = randomUUID();
      await transaction(pool, async (client) => {
        if (table === 'cms_categories') {
          if (body.parentId) {
            const parent = await one(client, 'SELECT id FROM cms_categories WHERE id = $1', [body.parentId]);
            if (!parent) throw badRequest('دسته والد یافت نشد.');
          }
          await client.query(`INSERT INTO cms_categories(id,name,slug,description,image_url,cover_url,icon,card_template,seo,position,parent_id,active,card_style) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [id, body.name, body.slug, body.description, body.imageUrl ?? null, body.coverUrl ?? null, body.icon ?? null, body.cardTemplate, '{}', body.position, body.parentId ?? null, body.active, JSON.stringify(body.cardStyle ?? {})]);
        } else {
          await client.query(`INSERT INTO cms_vibes(id,name,slug,description,cover_url,palette,seo,active,position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [id, body.name, body.slug, body.description, body.coverUrl ?? null, JSON.stringify(body.palette ?? {}), '{}', body.active, body.position]);
        }
        const seo = legacySeoToWrite(body.seo as Record<string, unknown>);
        if (seo) await upsertSeoEntry(client, label, body.slug, seo, user.id, config.PUBLIC_ORIGIN, request.ip);
        await audit(client, user.id, `cms.${label}_created`, `cms_${label}`, id, undefined, body, request.ip);
      });
      return reply.code(201).send({ id, slug: body.slug });
    });
    app.patch(`/api/v1/admin/cms/${path}/:id`, async (request) => {
      const user = await actor(request, 'cms:edit');
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const body = patchBody(base.partial().parse(request.body), request.body) as Record<string, unknown>;
      const columns: Record<string, string> = { name: 'name', slug: 'slug', description: 'description', coverUrl: 'cover_url', position: 'position', active: 'active',
        imageUrl: 'image_url', icon: 'icon', cardTemplate: 'card_template', parentId: 'parent_id', palette: 'palette', cardStyle: 'card_style' };
      return transaction(pool, async (client) => {
        const before = await one(client, `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!before) throw notFound();
        if (body.parentId === id) throw badRequest('یک دسته نمی‌تواند والد خودش باشد.');
        const sets: string[] = []; const values: unknown[] = [id];
        for (const [key, value] of Object.entries(body)) {
          if (value === undefined || !columns[key]) continue;
          values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
          sets.push(`${columns[key]} = $${values.length}`);
        }
        const seo = legacySeoToWrite(body.seo as Record<string, unknown> | undefined);
        if (!sets.length && !seo) throw badRequest('تغییری برای ذخیره وجود ندارد.');
        if (sets.length) await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1`, values);
        const slug = String(body.slug ?? before.slug);
        await renameSeoKey(client, label, String(before.slug), slug);
        if (seo) await upsertSeoEntry(client, label, slug, seo, user.id, config.PUBLIC_ORIGIN, request.ip);
        await audit(client, user.id, `cms.${label}_updated`, `cms_${label}`, id, before, body, request.ip);
        return one(client, `SELECT * FROM ${table} WHERE id = $1`, [id]);
      });
    });
  };
  taxonomy('cms_categories');
  taxonomy('cms_vibes');

  app.get('/api/v1/admin/cms/collections', async (request) => {
    await actor(request, 'cms:read');
    return { items: (await pool.query('SELECT * FROM cms_collections ORDER BY created_at')).rows };
  });

  const collectionBody = z.object({
    code: z.string().regex(/^[a-z0-9-]{2,40}$/), title: safeString(160), description: safeString(1000).default(''),
    mode: z.enum(['dynamic', 'manual']), queryRules: collectionRules.default({}), productIds: z.array(z.uuid()).max(48).default([]),
    active: z.boolean().default(true),
  }).strict();

  app.post('/api/v1/admin/cms/collections', async (request, reply) => {
    const user = await actor(request, 'cms:edit');
    const body = collectionBody.parse(request.body);
    if (body.mode === 'manual' && !body.productIds.length) throw badRequest('کالکشن دستی دست‌کم یک محصول لازم دارد.');
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO cms_collections(id,code,title,description,mode,query_rules,product_ids,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, body.code, body.title, body.description, body.mode, JSON.stringify(body.queryRules), body.productIds, body.active]);
      await audit(client, user.id, 'cms.collection_created', 'cms_collection', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, code: body.code });
  });

  app.patch('/api/v1/admin/cms/collections/:id', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody(collectionBody.omit({ code: true }).partial().parse(request.body), request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cms_collections WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(`UPDATE cms_collections SET title = COALESCE($2,title), description = COALESCE($3,description), mode = COALESCE($4,mode),
          query_rules = COALESCE($5,query_rules), product_ids = COALESCE($6,product_ids), active = COALESCE($7,active), updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.description ?? null, body.mode ?? null, body.queryRules ? JSON.stringify(body.queryRules) : null, body.productIds ?? null, body.active ?? null]);
      await audit(client, user.id, 'cms.collection_updated', 'cms_collection', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_collections WHERE id = $1', [id]);
    });
  });

  /** Query-builder preview: admin sees exactly the products the storefront will get. */
  app.post('/api/v1/admin/cms/collections/preview', async (request) => {
    await actor(request, 'cms:read');
    const body = z.object({ mode: z.enum(['dynamic', 'manual']), queryRules: collectionRules.default({}), productIds: z.array(z.uuid()).max(48).default([]) }).strict().parse(request.body);
    const products = body.mode === 'manual' ? await commerceProductsByIds(pool, body.productIds) : await queryCommerceProducts(pool, body.queryRules);
    return { items: await attachCardTemplates(pool, products), count: products.length };
  });

  /* ---------- Admin: theme engine (Req 218-228) ---------- */
  app.get('/api/v1/admin/cms/themes', async (request) => {
    await actor(request, 'cms:read');
    const rows = await pool.query(`SELECT p.*, f.name AS campaign_name,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'mode',a.mode,'startsAt',a.starts_at,'endsAt',a.ends_at,'active',a.active) ORDER BY a.created_at DESC)
          FROM palette_activations a WHERE a.palette_id = p.id), '[]'::jsonb) AS activations
      FROM color_palettes p LEFT JOIN festivals f ON f.id = p.campaign_id ORDER BY p.is_preset DESC, p.created_at`);
    return { items: rows.rows, tokenKeys: TOKEN_KEYS };
  });

  app.post('/api/v1/admin/cms/themes', async (request, reply) => {
    const user = await actor(request, 'cms:theme');
    const body = z.object({
      code: z.string().regex(/^[a-z0-9_-]{2,40}$/), name: safeString(120), occasion: safeString(60).optional(),
      tokens: z.object(Object.fromEntries(TOKEN_KEYS.map((k) => [k, hex])) as Record<(typeof TOKEN_KEYS)[number], typeof hex>).extend({
        radius: z.string().regex(/^\d{1,2}px$/).default('16px'), shadow: z.enum(['soft', 'crisp', 'warm', 'rose', 'high-contrast']).default('soft'),
        font: z.enum(['Vazirmatn', 'system']).default('Vazirmatn'), spacing: z.enum(['compact', 'comfortable', 'airy']).default('comfortable'),
      }).strict(),
      campaignId: z.uuid().nullable().optional(),
    }).strict().parse(request.body);
    const contrast = validateThemeTokens(body.tokens as unknown as Record<string, string>);
    const id = randomUUID();
    const colors = { primary: body.tokens.primary, secondary: body.tokens.secondary, accent: body.tokens.accent, background: body.tokens.background, surface: body.tokens.surface, text: body.tokens.textPrimary };
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO color_palettes(id,code,name,occasion,colors,design_tokens,campaign_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, body.code, body.name, body.occasion ?? null, JSON.stringify(colors), JSON.stringify(body.tokens), body.campaignId ?? null, user.id]);
      await audit(client, user.id, 'cms.theme_created', 'color_palette', id, undefined, { code: body.code, contrast }, request.ip);
    });
    return reply.code(201).send({ id, code: body.code, contrast });
  });

  app.patch('/api/v1/admin/cms/themes/:id/campaign', async (request) => {
    const user = await actor(request, 'cms:theme');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ campaignId: z.uuid().nullable() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT campaign_id FROM color_palettes WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('UPDATE color_palettes SET campaign_id = $2 WHERE id = $1', [id, body.campaignId]);
      await audit(client, user.id, 'cms.campaign_binding', 'color_palette', id, before, body, request.ip);
      if (body.campaignId) await outbox(client, 'cms.campaign.activated', 'color_palette', id, { paletteId: id, campaignId: body.campaignId });
      return { id, campaignId: body.campaignId };
    });
  });

  app.post('/api/v1/admin/cms/themes/:id/activate', async (request, reply) => {
    const user = await actor(request, 'cms:theme');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ mode: z.enum(['manual', 'scheduled']), startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().nullable().optional() }).strict().parse(request.body);
    if (body.mode === 'scheduled' && (!body.startsAt || !body.endsAt)) throw badRequest('برای تم زمان‌بندی‌شده شروع و پایان لازم است.');
    return transaction(pool, async (client) => {
      const palette = await one(client, 'SELECT id FROM color_palettes WHERE id = $1', [id]);
      if (!palette) throw notFound();
      if (body.mode === 'manual') await client.query(`UPDATE palette_activations SET active = false WHERE mode = 'manual' AND active`);
      const activationId = randomUUID();
      await client.query(`INSERT INTO palette_activations(id,palette_id,mode,starts_at,ends_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [activationId, id, body.mode, body.startsAt ?? new Date().toISOString(), body.endsAt ?? null, user.id]);
      await audit(client, user.id, 'cms.theme_change', 'color_palette', id, undefined, body, request.ip);
      await outbox(client, 'cms.theme.activated', 'color_palette', id, { paletteId: id, ...body });
      return reply.code(201).send({ id: activationId, paletteId: id, ...body });
    });
  });

  /* ---------- Admin: asset library (Req 229-231, 305) ---------- */
  app.get('/api/v1/admin/cms/assets', async (request) => {
    await actor(request, 'cms:read');
    const q = z.object({ search: z.string().max(120).optional(), type: z.enum(['image', 'video', 'icon', 'document']).optional(),
      folder: z.string().max(60).optional(), tag: z.string().max(40).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), uploader: z.uuid().optional(),
      sort: z.enum(['newest', 'oldest', 'largest', 'title']).default('newest') }).parse(request.query);
    const order = { newest: 'a.created_at DESC', oldest: 'a.created_at ASC', largest: 'a.size_bytes DESC NULLS LAST', title: 'a.title ASC' }[q.sort];
    const rows = await pool.query(`SELECT a.*, u.display_name AS uploader_name,
        (SELECT count(*)::int FROM cms_asset_usages x WHERE x.asset_id = a.id) AS explicit_usage,
        (SELECT jsonb_build_object('status', r.status, 'metadata', r.metadata) FROM media_pipeline_runs r WHERE r.subject_type = 'cms_asset' AND r.subject_id = a.id ORDER BY r.created_at DESC LIMIT 1) AS pipeline
      FROM cms_assets a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE ($1::text IS NULL OR a.title ILIKE '%' || $1 || '%' OR a.alt_text ILIKE '%' || $1 || '%' OR $1 = ANY(a.tags))
        AND ($2::text IS NULL OR a.asset_type = $2) AND ($3::text IS NULL OR a.folder = $3) AND ($4::text IS NULL OR $4 = ANY(a.tags))
        AND ($5::date IS NULL OR a.created_at >= $5::date) AND ($6::date IS NULL OR a.created_at < $6::date + 1) AND ($7::uuid IS NULL OR a.uploaded_by = $7)
      ORDER BY ${order} LIMIT 200`, [q.search ?? null, q.type ?? null, q.folder ?? null, q.tag ?? null, q.from ?? null, q.to ?? null, q.uploader ?? null]);
    const uploaders = (await pool.query(`SELECT DISTINCT u.id, u.display_name FROM cms_assets a JOIN users u ON u.id = a.uploaded_by ORDER BY u.display_name`)).rows;
    return { items: rows.rows, uploaders };
  });

  app.post('/api/v1/admin/cms/assets', async (request, reply) => {
    const user = await actor(request, 'cms:media');
    const body = z.object({
      fileId: z.uuid().optional(), url: z.string().regex(/^https:\/\/[^\s<>"]+$/).optional(), title: safeString(160),
      assetType: z.enum(['image', 'video', 'icon', 'document']), folder: z.string().regex(/^[a-z0-9_-]{1,60}$/).default('general'),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]), altText: safeString(300).default(''),
    }).strict().refine((v) => v.fileId || v.url, 'فایل یا نشانی رسانه لازم است.').parse(request.body);
    let mime: string | null = null; let size = 0;
    if (body.fileId) {
      const file = await one<{ mime_type: string; size_bytes: number }>(pool, 'SELECT mime_type, size_bytes FROM files WHERE id = $1', [body.fileId]);
      if (!file) throw badRequest('فایل روی سرور یافت نشد.');
      mime = file.mime_type; size = file.size_bytes;
    }
    const id = randomUUID();
    const url = body.fileId ? `/api/v1/media/${body.fileId}` : body.url!;
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_assets(id,file_id,title,asset_type,url,folder,tags,alt_text,mime_type,size_bytes,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, body.fileId ?? null, body.title, body.assetType, url, body.folder, body.tags, body.altText, mime, size, user.id]);
      await audit(client, user.id, 'cms.asset_created', 'cms_asset', id, undefined, { title: body.title }, request.ip);
      await outbox(client, 'media.uploaded', 'cms_asset', id, { assetId: id, assetType: body.assetType, url, fileId: body.fileId ?? null });
    });
    return reply.code(201).send({ id, url });
  });

  app.patch('/api/v1/admin/cms/assets/:id', async (request) => {
    const user = await actor(request, 'cms:media');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ title: safeString(160).optional(), folder: z.string().regex(/^[a-z0-9_-]{1,60}$/).optional(),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), altText: safeString(300).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cms_assets WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('UPDATE cms_assets SET title = COALESCE($2,title), folder = COALESCE($3,folder), tags = COALESCE($4,tags), alt_text = COALESCE($5,alt_text) WHERE id = $1',
        [id, body.title ?? null, body.folder ?? null, body.tags ?? null, body.altText ?? null]);
      await audit(client, user.id, 'cms.asset_updated', 'cms_asset', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_assets WHERE id = $1', [id]);
    });
  });

  const assetUsage = async (db: DbPool | PoolClient, id: string) => {
    const asset = await one<{ url: string; file_id: string | null }>(db, 'SELECT url, file_id FROM cms_assets WHERE id = $1', [id]);
    if (!asset) throw notFound();
    const needle = asset.file_id ?? asset.url;
    const sections = await db.query(`SELECT s.id, s.title, p.title AS page_title, p.code FROM cms_sections s JOIN cms_pages p ON p.id = s.page_id
      WHERE s.payload::text LIKE '%' || $1 || '%'`, [needle]);
    const products = await db.query(`SELECT id, name FROM products WHERE metadata::text LIKE '%' || $1 || '%' LIMIT 50`, [needle]);
    const categories = await db.query(`SELECT id, name FROM cms_categories WHERE image_url = $1 OR cover_url = $1`, [asset.url]);
    const explicit = await db.query('SELECT entity_type, entity_id, entity_label FROM cms_asset_usages WHERE asset_id = $1', [id]);
    return [
      ...sections.rows.map((r: Record<string, string>) => ({ type: 'cms_section', id: r.id, label: `${r.page_title} › ${r.title}` })),
      ...products.rows.map((r: Record<string, string>) => ({ type: 'product', id: r.id, label: r.name })),
      ...categories.rows.map((r: Record<string, string>) => ({ type: 'category', id: r.id, label: r.name })),
      ...explicit.rows.map((r: Record<string, string>) => ({ type: r.entity_type, id: r.entity_id, label: r.entity_label })),
    ];
  };

  app.get('/api/v1/admin/cms/assets/:id/usage', async (request) => {
    await actor(request, 'cms:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return { items: await assetUsage(pool, id) };
  });

  app.delete('/api/v1/admin/cms/assets/:id', async (request) => {
    const user = await actor(request, 'cms:media');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { force } = z.object({ force: z.enum(['true', 'false']).optional() }).parse(request.query);
    return transaction(pool, async (client) => {
      const usage = await assetUsage(client, id);
      if (usage.length && force !== 'true') {
        throw conflict(`این رسانه در ${usage.length} جا استفاده شده است: ${usage.slice(0, 5).map((u) => u.label).join('، ')}`);
      }
      await client.query('DELETE FROM cms_assets WHERE id = $1', [id]);
      await audit(client, user.id, 'cms.asset_deleted', 'cms_asset', id, { usage }, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  /* ---------- Admin: announcements (Req 327-332) ---------- */
  app.get('/api/v1/admin/cms/announcements', async (request) => {
    await actor(request, 'cms:read');
    return { items: (await pool.query('SELECT * FROM cms_announcements ORDER BY priority DESC, created_at DESC')).rows };
  });

  app.post('/api/v1/admin/cms/announcements', async (request, reply) => {
    const user = await actor(request, 'cms:edit');
    const body = announcementBody.parse(request.body);
    if (body.startsAt && body.endsAt && new Date(body.endsAt) <= new Date(body.startsAt)) throw badRequest('پایان باید بعد از شروع باشد.');
    await assertAnnouncementBinding(pool, body.bindingType, body.bindingId ?? null);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO cms_announcements(id,title,messages,mode,style,binding_type,binding_id,priority,starts_at,ends_at,active,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, body.title, JSON.stringify(body.messages), body.mode, JSON.stringify(body.style), body.bindingType, body.bindingId ?? null,
          body.priority, body.startsAt ?? null, body.endsAt ?? null, body.active, user.id]);
      await audit(client, user.id, 'cms.announcement_created', 'cms_announcement', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id });
  });

  app.patch('/api/v1/admin/cms/announcements/:id', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = patchBody(announcementBody.partial().parse(request.body), request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ binding_type: string; binding_id: string | null }>(client, 'SELECT * FROM cms_announcements WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.bindingType !== undefined || body.bindingId !== undefined)
        await assertAnnouncementBinding(client, body.bindingType ?? before.binding_type, body.bindingId !== undefined ? body.bindingId ?? null : before.binding_id);
      await client.query(`UPDATE cms_announcements SET title = COALESCE($2,title), messages = COALESCE($3,messages), mode = COALESCE($4,mode),
          style = COALESCE($5,style), binding_type = COALESCE($6,binding_type), binding_id = CASE WHEN $7::boolean THEN $8 ELSE binding_id END,
          priority = COALESCE($9,priority), starts_at = CASE WHEN $10::boolean THEN $11::timestamptz ELSE starts_at END,
          ends_at = CASE WHEN $12::boolean THEN $13::timestamptz ELSE ends_at END, active = COALESCE($14,active), updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.messages ? JSON.stringify(body.messages) : null, body.mode ?? null, body.style ? JSON.stringify(body.style) : null,
          body.bindingType ?? null, body.bindingId !== undefined, body.bindingId ?? null, body.priority ?? null,
          body.startsAt !== undefined, body.startsAt ?? null, body.endsAt !== undefined, body.endsAt ?? null, body.active ?? null]);
      await audit(client, user.id, 'cms.announcement_updated', 'cms_announcement', id, before, body, request.ip);
      return one(client, 'SELECT * FROM cms_announcements WHERE id = $1', [id]);
    });
  });

  app.delete('/api/v1/admin/cms/announcements/:id', async (request) => {
    const user = await actor(request, 'cms:edit');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT * FROM cms_announcements WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('DELETE FROM cms_announcements WHERE id = $1', [id]);
      await audit(client, user.id, 'cms.announcement_deleted', 'cms_announcement', id, before, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  /* ---------- Admin: global layout (Req 275-280, 323, 354) ---------- */
  const layoutSchemas = { global_header: headerSchema, global_footer: footerSchema, account_appearance: accountAppearanceSchema } as const;
  app.get('/api/v1/admin/cms/layout', async (request) => {
    await actor(request, 'cms:read');
    const [header, footer, accountAppearance] = await Promise.all([
      readSetting(pool, 'global_header'), readSetting(pool, 'global_footer'), readSetting(pool, 'account_appearance')]);
    return { header, footer, accountAppearance };
  });
  app.put('/api/v1/admin/cms/layout/:key', async (request) => {
    const user = await actor(request, 'cms:theme');
    const { key } = z.object({ key: z.enum(['global_header', 'global_footer', 'account_appearance']) }).parse(request.params);
    const value = layoutSchemas[key].parse(request.body);
    return transaction(pool, async (client) => {
      const before = await readSetting(client, key);
      await client.query(`INSERT INTO site_settings(key,value,updated_by) VALUES ($1,$2,$3)
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`, [key, JSON.stringify(value), user.id]);
      await audit(client, user.id, 'cms.layout_updated', 'site_settings', key, before, value, request.ip);
      return { key, value };
    });
  });

  /* ---------- Admin: unified CMS search, leads, analytics (Req 231, 236, 283) ---------- */
  app.get('/api/v1/admin/cms/search', async (request) => {
    await actor(request, 'cms:read');
    const { q } = z.object({ q: z.string().trim().min(1).max(120) }).parse(request.query);
    const like = `%${q}%`;
    const [pages, components, templates, campaigns, categories, vibes, assets, collections] = await Promise.all([
      pool.query(`SELECT id, code, title, 'page' AS kind FROM cms_pages WHERE title ILIKE $1 OR code ILIKE $1 OR path ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, code, title, 'component' AS kind FROM cms_components WHERE title ILIKE $1 OR code ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, code, name AS title, 'card_template' AS kind FROM cms_product_card_templates WHERE name ILIKE $1 OR code ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, code, name AS title, 'campaign' AS kind FROM festivals WHERE name ILIKE $1 OR code ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, slug AS code, name AS title, 'category' AS kind FROM cms_categories WHERE name ILIKE $1 OR slug ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, slug AS code, name AS title, 'vibe' AS kind FROM cms_vibes WHERE name ILIKE $1 OR slug ILIKE $1 LIMIT 10`, [like]),
      pool.query(`SELECT id, folder AS code, title, 'asset' AS kind FROM cms_assets WHERE title ILIKE $1 OR alt_text ILIKE $1 OR $2 = ANY(tags) LIMIT 10`, [like, q]),
      pool.query(`SELECT id, code, title, 'collection' AS kind FROM cms_collections WHERE title ILIKE $1 OR code ILIKE $1 LIMIT 10`, [like]),
    ]);
    return { items: [pages, components, templates, campaigns, categories, vibes, assets, collections].flatMap((r) => r.rows) };
  });

  app.get('/api/v1/admin/cms/leads', async (request) => {
    await actor(request, 'cms:read');
    return { items: (await pool.query('SELECT * FROM cms_leads ORDER BY created_at DESC LIMIT 200')).rows };
  });

  app.get('/api/v1/admin/cms/analytics', async (request) => {
    await actor(request, 'cms:read');
    const rows = await pool.query(`SELECT event_type, component_code, page_code, count(*)::int AS total
      FROM cms_analytics_events WHERE created_at >= now() - interval '30 days' GROUP BY 1,2,3 ORDER BY total DESC LIMIT 100`);
    return { items: rows.rows };
  });
}
