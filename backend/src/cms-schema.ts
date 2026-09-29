import { z } from 'zod';
import { badRequest } from './errors.js';

/* Typed component schema, token-restricted style overrides and responsive config (Req 176, 181, 184, 226, 228).
   Everything here is pure so it can be unit-tested and reused by the editor preview endpoint. */

export type FieldType = 'text' | 'textarea' | 'lines' | 'number' | 'boolean' | 'select' | 'media' | 'video' | 'target' | 'color'
  | 'datetime' | 'product' | 'collection' | 'campaign' | 'category' | 'vibe' | 'installment_provider';
export type FieldDef = { key: string; type: FieldType; label: string; group?: string; options?: string[]; min?: number; max?: number;
  required?: boolean; default?: unknown; advanced?: boolean; showIf?: Record<string, string>; hint?: string };
export type FieldSchema = { version?: number; props?: string[]; fields?: FieldDef[] };

const UNSAFE = /<\s*\/?\s*(script|iframe|object|embed|style|link|meta)\b|javascript:|data:text\/html|\bon[a-z]+\s*=/i;
export const NAV_TARGET = /^(home|shop|vip|tryon|journal|about|supplier|account|https:\/\/[^\s<>"]+|page:[a-z0-9_-]{2,40}|vibe:[a-z0-9-]{2,40}|collection:[a-z0-9-]{2,40}|category:[^\s<>"]{1,60}|product:[0-9a-f-]{36})$/;
const MEDIA = /^(https:\/\/[^\s<>"]+|\/api\/v1\/media\/[0-9a-f-]{36}(\?[a-z0-9=&]*)?)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{2,60}$/;
/** Colour fields accept a design-token name (preferred, Req 226) or a hex override (controlled). */
export const COLOR_TOKENS = ['inherit', 'background', 'surface', 'surfaceSecondary', 'textPrimary', 'textSecondary', 'primary', 'accent', 'onPrimary', 'success', 'danger'] as const;
/** Binding keys that every section may carry even if its schema does not list them (Req 185-187, 212). */
const BINDING_KEYS = new Set(['campaignId', 'collectionCode', 'productIds', 'productId', 'category', 'vibe', 'bindingType', 'categorySlug', 'vibeSlug', 'slides', 'mosaic']);

const isText = (v: unknown) => typeof v === 'string';
const fail = (label: string, message: string): never => { throw badRequest(`فیلد «${label}» ${message}`); };

/** Validates a section payload against its component's typed schema. Unknown keys are allowed (legacy content)
 *  but must be plain, HTML-free values — never code (Req 179, 323). Returns a normalised copy. */
const SELECT_ALIASES: Record<string, Record<string, string>> = {
  template: { fullbleed: 'fullviewport', fullscreen: 'fullviewport', 'full-screen': 'fullviewport', image: 'static', slider: 'carousel' },
};

export function validateSectionPayload(schema: FieldSchema | null | undefined, payload: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map((schema?.fields ?? []).map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(payload);
  if (keys.length > 60) throw badRequest('تعداد فیلدهای بخش بیش از حد مجاز است.');
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)) throw badRequest(`نام فیلد «${key}» مجاز نیست.`);
    const field = fields.get(key);
    assertPlain(value, field?.label ?? key);
    if (!field) {
      if (!BINDING_KEYS.has(key) && typeof value === 'object') throw badRequest(`فیلد «${key}» در Schema کامپوننت تعریف نشده و باید مقدار ساده باشد.`);
      out[key] = value; continue;
    }
    out[key] = coerceField(field, value);
  }
  for (const field of fields.values()) {
    if (!field.required || out[field.key] !== undefined) continue;
    const visible = !field.showIf || Object.entries(field.showIf).every(([k, v]) => String(out[k] ?? defaultOf(fields.get(k))) === v);
    if (visible) fail(field.label, 'الزامی است.');
  }
  return out;
}

const defaultOf = (field?: FieldDef) => (field?.default ?? '');

function assertPlain(value: unknown, label: string, depth = 0): void {
  if (depth > 3) fail(label, 'ساختار تو در توی بیش از حد دارد.');
  if (typeof value === 'string') {
    if (value.length > 6000) fail(label, 'بیش از حد طولانی است.');
    if (UNSAFE.test(value) || /<[a-z!/]/i.test(value)) fail(label, 'نباید شامل HTML یا اسکریپت باشد.');
  } else if (Array.isArray(value)) value.forEach((v) => assertPlain(v, label, depth + 1));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => assertPlain(v, label, depth + 1));
  else if (!['number', 'boolean'].includes(typeof value)) fail(label, 'نوع مقدار مجاز نیست.');
}

function coerceField(field: FieldDef, value: unknown): unknown {
  const s = typeof value === 'string' ? value.trim() : value;
  switch (field.type) {
    case 'text': case 'textarea': case 'lines': {
      if (!isText(s)) fail(field.label, 'باید متن باشد.');
      const max = field.max ?? (field.type === 'text' ? 200 : 4000);
      if ((s as string).length > max) fail(field.label, `حداکثر ${max} نویسه است.`);
      return s;
    }
    case 'number': {
      const n = typeof s === 'number' ? s : Number(s);
      if (!Number.isFinite(n)) fail(field.label, 'باید عدد باشد.');
      if (field.min !== undefined && n < field.min) fail(field.label, `حداقل ${field.min} است.`);
      if (field.max !== undefined && n > field.max) fail(field.label, `حداکثر ${field.max} است.`);
      return n;
    }
    case 'boolean':
      if (typeof s === 'boolean') return s;
      if (s === 'true' || s === 'false') return s === 'true';
      return fail(field.label, 'باید بله/خیر باشد.');
    case 'select': {
      // Legacy aliases saved by older builders are normalised instead of rejected (Req 211 compatibility).
      const alias = SELECT_ALIASES[field.key]?.[s as string];
      if (alias && (field.options ?? []).includes(alias)) return alias;
      if (!isText(s) || !(field.options ?? []).includes(s as string)) fail(field.label, `باید یکی از ${(field.options ?? []).join('، ')} باشد.`);
      return s;
    }
    case 'media': case 'video':
      if (!isText(s) || !MEDIA.test(s as string)) fail(field.label, 'باید نشانی رسانه داخلی (/api/v1/media/…) یا https باشد.');
      if (field.type === 'video' && /^https:/i.test(s as string) && !/\.(mp4|webm|m3u8)(\?|$)/i.test(s as string)) fail(field.label, 'باید فایل ویدیویی mp4/webm/m3u8 باشد.');
      return s;
    case 'target':
      if (!isText(s) || !NAV_TARGET.test(s as string)) fail(field.label, 'مقصد مجاز نیست (shop، vip، about، page:code، vibe:slug، collection:code، category:slug، product:id یا https).');
      return s;
    case 'color':
      if (!isText(s) || !((COLOR_TOKENS as readonly string[]).includes(s as string) || /^#[0-9a-fA-F]{3,8}$/.test(s as string))) fail(field.label, 'باید نام توکن طراحی یا رنگ hex باشد.');
      return s;
    case 'datetime':
      if (!isText(s) || Number.isNaN(Date.parse(s as string))) fail(field.label, 'تاریخ معتبر نیست.');
      return new Date(s as string).toISOString();
    case 'product': case 'campaign':
      if (!isText(s) || !UUID.test(s as string)) fail(field.label, 'شناسه معتبر نیست.');
      return s;
    case 'collection': case 'vibe': case 'installment_provider':
      if (!isText(s) || !SLUG.test(s as string)) fail(field.label, 'کد/slug معتبر نیست.');
      return s;
    case 'category':
      if (!isText(s) || (s as string).length > 120) fail(field.label, 'دسته معتبر نیست.');
      return s;
    default:
      return s;
  }
}

/* ---------------- Style overrides: tokens only, no raw CSS (Req 181, 226, 228) ---------------- */

export const STYLE_SPEC = {
  background: { values: ['inherit', 'background', 'surface', 'surfaceSecondary', 'primary', 'accent'], simple: true },
  foreground: { values: ['inherit', 'textPrimary', 'textSecondary', 'onPrimary', 'accent'], simple: false },
  border: { values: ['none', 'line', 'strong', 'accent'], simple: true },
  radius: { values: ['none', 'sm', 'md', 'lg', 'xl'], simple: true },
  shadow: { values: ['none', 'sm', 'md', 'lg'], simple: false },
  padding: { values: ['none', 'sm', 'md', 'lg', 'xl'], simple: true },
  gap: { values: ['sm', 'md', 'lg'], simple: false },
  width: { values: ['narrow', 'content', 'wide', 'full'], simple: false },
  minHeight: { values: ['auto', 'sm', 'md', 'lg', 'screen'], simple: false },
  typeScale: { values: ['sm', 'md', 'lg', 'xl'], simple: false },
  fontFamily: { values: ['body', 'display'], simple: false },
  align: { values: ['start', 'center', 'end'], simple: true },
  animation: { values: ['none', 'fade', 'rise', 'zoom'], simple: false },
  mediaFit: { values: ['cover', 'contain'], simple: false },
} as const;
export type StyleKey = keyof typeof STYLE_SPEC;

export function validateStyleOverrides(input: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'overlay') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 90) throw badRequest('تیرگی لایه باید عدد صحیح ۰ تا ۹۰ باشد.');
      out.overlay = n; continue;
    }
    const spec = STYLE_SPEC[key as StyleKey];
    if (!spec) throw badRequest(`تنظیم ظاهری «${key}» مجاز نیست؛ فقط توکن‌های سیستم طراحی قابل استفاده‌اند.`);
    if (typeof value !== 'string' || !(spec.values as readonly string[]).includes(value)) throw badRequest(`مقدار «${String(value)}» برای «${key}» مجاز نیست.`);
    out[key] = value;
  }
  return out;
}

/** Keys editable in Simple mode (Req 228). Advanced adds detailed tokens, layout, responsive and animation. */
export const SIMPLE_STYLE_KEYS = Object.entries(STYLE_SPEC).filter(([, s]) => s.simple).map(([k]) => k);

export const responsiveConfigSchema = z.object({
  hideOnMobile: z.boolean().optional(), hideOnTablet: z.boolean().optional(), hideOnDesktop: z.boolean().optional(),
  mobileColumns: z.number().int().min(1).max(3).optional(), tabletColumns: z.number().int().min(1).max(4).optional(),
  mobileAlign: z.enum(['start', 'center', 'end']).optional(), mobilePadding: z.enum(['none', 'sm', 'md', 'lg']).optional(),
  mobileTypeScale: z.enum(['sm', 'md', 'lg']).optional(),
}).strict();

/* ---------------- Product-card designer (Req 196-197) ---------------- */

export const CARD_BLOCKS = ['image', 'badge', 'brand', 'name', 'original_price', 'discount_price', 'installment', 'rating', 'cta', 'countdown', 'swatches'] as const;
export const cardStylesSchema = z.object({
  aspectRatio: z.enum(['3/4', '4/5', '1/1']).default('3/4'), radius: z.string().regex(/^\d{1,2}px$/).default('18px'),
  badgeTone: z.string().max(20).optional(), accentColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default('#1B2A4A'), darkSurface: z.boolean().optional(),
  serifTitle: z.boolean().optional(), highlightDiscount: z.boolean().optional(), prominentInstallment: z.boolean().optional(),
  borderless: z.boolean().optional(), luxuryBorder: z.boolean().optional(), showSwatches: z.boolean().optional(),
  titleLines: z.number().int().min(1).max(4).default(2), hoverEffect: z.enum(['zoom', 'lift', 'none', 'shadow']).default('zoom'),
  ctaStyle: z.enum(['solid', 'outline', 'ghost']).default('solid'), focusRing: z.enum(['accent', 'ink']).default('accent'),
  skeleton: z.boolean().default(true), textAlign: z.enum(['start', 'center', 'left', 'right']).default('start'),
  imageFit: z.enum(['cover', 'contain']).default('cover'), badgeText: z.string().trim().max(24).optional(),
}).strict();

const hexToRgb = (hex: string) => {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.slice(0, 6);
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
const lum = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export function contrast(a: string, b: string) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((l1! + 0.05) / (l2! + 0.05)) * 100) / 100;
}

/** Design quality gate (Req 197): every criterion is an actual check on the template definition. */
export function designQualityGate(template: { blocks: string[]; styles: Record<string, unknown> }) {
  const blocks = template.blocks;
  const st = { titleLines: 2, hoverEffect: 'zoom', focusRing: 'accent', skeleton: true, textAlign: 'start', ...template.styles } as Record<string, unknown>;
  const accent = String(st.accentColor ?? '#1B2A4A');
  const dark = Boolean(st.darkSurface);
  const surface = dark ? '#111622' : '#FFFFFF';
  const radius = Number.parseInt(String(st.radius ?? '16'), 10);
  const priceIdx = blocks.findIndex((b) => b.endsWith('price'));
  const titleLines = Number(st.titleLines ?? 0);
  const validAccent = /^#[0-9a-f]{3,8}$/i.test(accent);
  const ratio = validAccent ? contrast(accent, surface) : 0;
  const checks = {
    hierarchy: blocks.includes('image') && blocks.includes('name') && priceIdx >= 0 && blocks.indexOf('image') === 0,
    spacing: blocks.length <= 10 && Number.isFinite(radius) && radius >= 0 && radius <= 32,
    typography: !blocks.includes('name') || priceIdx < 0 || blocks.indexOf('name') < priceIdx,
    contrast: validAccent && ratio >= 3,
    mobile: blocks.length <= 9 && !(blocks.includes('countdown') && blocks.includes('swatches') && blocks.length > 8),
    accessibility: blocks.includes('name') && (!blocks.includes('badge') || blocks.includes('name')),
    longText: titleLines >= 1 && titleLines <= 3,
    missingMedia: blocks.includes('image') && ['cover', 'contain', undefined].includes(st.imageFit as string | undefined),
    rtl: !['left', 'right'].includes(String(st.textAlign ?? 'start')),
    hover: ['zoom', 'lift', 'none', 'shadow'].includes(String(st.hoverEffect ?? '')),
    focus: validAccent && (st.focusRing === 'ink' || (st.focusRing === 'accent' && ratio >= 3)),
    loading: st.skeleton !== false,
  };
  const labels: Record<keyof typeof checks, string> = {
    hierarchy: 'تصویر اول، سپس نام و قیمت', spacing: 'حداکثر ۱۰ بلاک و گردی ۰ تا ۳۲', typography: 'نام قبل از قیمت',
    contrast: 'کنتراست رنگ تأکیدی ≥ ۳', mobile: 'حداکثر ۹ بلاک در موبایل', accessibility: 'نام محصول برای صفحه‌خوان',
    longText: 'محدودیت ۱ تا ۳ خط برای نام طولانی', missingMedia: 'جایگزین تصویر ناموجود', rtl: 'چینش منطقی (start/center) برای RTL',
    hover: 'افکت هاور تعریف‌شده', focus: 'حلقه فوکوس با کنتراست کافی', loading: 'اسکلت بارگذاری',
  };
  const failed = (Object.keys(checks) as (keyof typeof checks)[]).filter((k) => !checks[k]).map((k) => ({ check: k, fix: labels[k] }));
  return { checks, passed: failed.length === 0, contrast: ratio, failed };
}
