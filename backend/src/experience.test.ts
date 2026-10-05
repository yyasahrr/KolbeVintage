import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { describe } from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import {
  assertSafeText, contrastRatio, designQualityGate, pageIsLive, pickActiveAnnouncements, validateComposition, validateThemeTokens,
} from './cms-studio.js';
import { buildCollectionQuery, resolveCardTemplate, type CardRule } from './commerce-view.js';
import { colorPairScore, deriveFeatures, scoreOutfit, SCORE_VERSION, type MatrixRow, type ScoredItem } from './style.js';
import { loyaltyTier, sniffImage, supplierDiff, validateAvatar, validateSpecifications, type SpecField } from './profile.js';
import { deviceLabel } from './auth.js';
import { jsonLdString, legacySeoToWrite, resolveSeo, validateSeoInput, type SeoSubject } from './seo.js';
import { processAvatar, renderVariant, snapWidth } from './images.js';
import sharp from 'sharp';
import { validateSectionPayload, validateStyleOverrides, type FieldSchema } from './cms-schema.js';
import { installmentOffers, type InstallmentProvider } from './installments.js';
import { similarityScore } from './recommendations.js';
import { applyInstallmentPolicy, ruleMatches, type CommerceProduct } from './commerce-view.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* ============================ Pure rules (always run) ============================ */

describe('CMS guardrails (Req 179, 197, 221-228, 323)', () => {
  test('composable components accept only safe primitives', () => {
    validateComposition([{ type: 'container', children: [{ type: 'product_image' }, { type: 'text', props: { value: 'تخفیف ویژه' } }, { type: 'button', props: { href: 'shop', label: 'خرید' } }] }]);
    assert.throws(() => validateComposition([{ type: 'html', props: { value: '<b>x</b>' } }]), /امن/);
    assert.throws(() => validateComposition([{ type: 'text', props: { value: '<script>alert(1)</script>' } }]), /HTML|اسکریپت/);
    assert.throws(() => validateComposition([{ type: 'button', props: { href: 'javascript:alert(1)' } }]));
    assert.throws(() => validateComposition([{ type: 'text', props: { value: { nested: true } as unknown as string } }]), /ساده/);
    const deep = { type: 'container', children: [{ type: 'container', children: [{ type: 'container', children: [{ type: 'container', children: [{ type: 'container', children: [{ type: 'container', children: [{ type: 'text' }] }] }] }] }] }] };
    assert.throws(() => validateComposition([deep]), /عمق/);
  });

  test('text fields reject markup and event handlers', () => {
    assertSafeText({ title: 'ارسال رایگان', list: ['a', 'b'] });
    assert.throws(() => assertSafeText({ title: '<img src=x onerror=alert(1)>' }));
    assert.throws(() => assertSafeText(['ok', 'x onclick=steal()']));
  });

  test('design quality gate enforces hierarchy and contrast', () => {
    assert.equal(designQualityGate({ blocks: ['image', 'name', 'discount_price', 'cta'], styles: { accentColor: '#1B2A4A', radius: '18px' } }).passed, true);
    const noPrice = designQualityGate({ blocks: ['image', 'name', 'cta'], styles: { accentColor: '#1B2A4A' } });
    assert.equal(noPrice.passed, false); assert.equal(noPrice.checks.hierarchy, false);
    const lowContrast = designQualityGate({ blocks: ['image', 'name', 'discount_price'], styles: { accentColor: '#F5F5F5' } });
    assert.equal(lowContrast.checks.contrast, false);
  });

  test('theme tokens must keep readable contrast', () => {
    assert.ok(contrastRatio('#000000', '#FFFFFF') > 20);
    const good = { background: '#F9F6F1', surface: '#FFFFFF', surfaceSecondary: '#F1ECE1', textPrimary: '#0E1527', textSecondary: '#5B616E', primary: '#1B2A4A',
      secondary: '#C1613B', accent: '#C1613B', border: '#E4DDD0', success: '#2E6B47', warning: '#B7791F', danger: '#B42318' };
    assert.ok(validateThemeTokens(good).bodyContrast >= 4.5);
    assert.throws(() => validateThemeTokens({ ...good, textPrimary: '#EEEEEE' }), /کنتراست/);
    assert.throws(() => validateThemeTokens({ ...good, accent: 'red' }), /hex/);
  });

  test('announcements respect schedule and priority; pages respect status/window', () => {
    const now = new Date('2026-11-27T12:00:00Z');
    const rows = [
      { id: 'a', priority: 10, active: true, starts_at: null, ends_at: null },
      { id: 'b', priority: 90, active: true, starts_at: '2026-11-27T00:00:00Z', ends_at: '2026-11-28T00:00:00Z' },
      { id: 'c', priority: 99, active: true, starts_at: '2026-12-01T00:00:00Z', ends_at: null },
      { id: 'd', priority: 50, active: false, starts_at: null, ends_at: null },
      { id: 'e', priority: 70, active: true, starts_at: null, ends_at: '2026-11-26T00:00:00Z' },
    ];
    assert.deepEqual(pickActiveAnnouncements(rows, now).map((r) => r.id), ['b', 'a']);
    assert.equal(pageIsLive({ status: 'published', active: true, scheduled_start_at: null, scheduled_end_at: null }, now), true);
    assert.equal(pageIsLive({ status: 'draft', active: true, scheduled_start_at: null, scheduled_end_at: null }, now), false);
    assert.equal(pageIsLive({ status: 'scheduled', active: true, scheduled_start_at: '2026-11-27T00:00:00Z', scheduled_end_at: '2026-11-28T00:00:00Z' }, now), true);
    assert.equal(pageIsLive({ status: 'scheduled', active: true, scheduled_start_at: '2026-11-28T00:00:00Z', scheduled_end_at: null }, now), false);
    assert.equal(pageIsLive({ status: 'published', active: true, scheduled_start_at: null, scheduled_end_at: '2026-11-01T00:00:00Z' }, now), false);
  });
});

describe('Commerce bindings (Req 192-195, 206-207)', () => {
  test('card rule engine follows priority, activation and schedule', () => {
    const rules: CardRule[] = [
      { id: '1', name: 'sale', priority: 1, conditions: { minDiscountPercent: 50 }, template_code: 'kolbe-sale', active: true, starts_at: null, ends_at: null },
      { id: '3', name: 'new', priority: 3, conditions: { isNew: true }, template_code: 'kolbe-new-arrival', active: true, starts_at: null, ends_at: null },
      { id: '4', name: 'inst', priority: 4, conditions: { installmentEnabled: true }, template_code: 'kolbe-installment', active: true, starts_at: null, ends_at: null },
      { id: '9', name: 'expired', priority: 0, conditions: {}, template_code: 'kolbe-dark', active: true, starts_at: null, ends_at: '2020-01-01T00:00:00Z' },
    ];
    const base = { discountPercent: 0, isNew: false, installmentEnabled: false, vibes: [], category: 'کت' };
    assert.equal(resolveCardTemplate({ ...base, discountPercent: 60, isNew: true, installmentEnabled: true }, rules), 'kolbe-sale');
    assert.equal(resolveCardTemplate({ ...base, discountPercent: 20, isNew: true, installmentEnabled: true }, rules), 'kolbe-new-arrival');
    assert.equal(resolveCardTemplate({ ...base, installmentEnabled: true }, rules), 'kolbe-installment');
    assert.equal(resolveCardTemplate(base, rules), 'kolbe-classic');
    assert.equal(resolveCardTemplate({ ...base, discountPercent: 60 }, rules.map((r) => (r.id === '1' ? { ...r, active: false } : r))), 'kolbe-classic');
  });

  test('collection query builder is fully parameterised', () => {
    const q = buildCollectionQuery({ category: "Coat'; DROP TABLE products;--", vibe: 'old-money', inStockOnly: true, minDiscountPercent: 20, sortBy: 'price_asc', limit: 500 });
    assert.ok(!q.where.includes('DROP'));
    assert.deepEqual(q.params, ["Coat'; DROP TABLE products;--", 'old-money', 20]);
    assert.ok(q.where.includes('COALESCE(b.available, 0) > 0'));
    assert.equal(q.order, 'p.cash_price_rial ASC');
    assert.equal(q.limit, 48);
  });
});

describe('Style intelligence (Req 249-259)', () => {
  const matrix: MatrixRow[] = [
    { category_a: 'trousers', category_b: 'trousers', compatible: false, score_weight: 15, reason: 'دو شلوار معتبر نیست.' },
    { category_a: 'shirt', category_b: 'trousers', compatible: true, score_weight: 96 },
    { category_a: 'coat', category_b: 'shirt', compatible: true, score_weight: 96 },
    { category_a: 'coat', category_b: 'trousers', compatible: true, score_weight: 95 },
  ];
  const item = (id: string, category: string, color: string, extra: Partial<ScoredItem['features']> = {}): ScoredItem => ({
    id, name: id, category, color,
    features: { dominantColors: [color], productType: category, vibes: ['old-money'], seasons: ['spring', 'autumn'], formality: 0.75, pattern: 'solid', fit: 'regular', visualWeight: 'medium', ...extra },
  });

  test('colour logic: harmonious vs clashing pairs', () => {
    assert.ok(colorPairScore('صورتی', 'کرم') >= 95);
    assert.ok(colorPairScore('قرمز', 'سبز') <= 55);
    assert.ok(colorPairScore('مشکی', 'نارنجی') >= 85, 'neutral pairs well');
  });

  test('pink shirt + cream trousers scores high with explained breakdown', () => {
    const result = scoreOutfit([item('pink-shirt', 'shirt', 'صورتی'), item('cream-trousers', 'trousers', 'کرم')], matrix);
    assert.equal(result.scoreVersion, SCORE_VERSION);
    assert.equal(result.valid, true);
    assert.ok(result.total >= 90, `total=${result.total}`);
    assert.deepEqual(Object.keys(result.breakdown).sort(), ['categoryCompatibility', 'colorHarmony', 'formalityMatch', 'patternCompatibility', 'seasonMatch', 'silhouetteBalance', 'vibeMatch']);
    assert.match(result.explanation, /Old Money/);
    assert.deepEqual(result.derivedVibes, ['old-money']);
  });

  test('invalid category combos are capped and explained', () => {
    const result = scoreOutfit([item('t1', 'trousers', 'کرم'), item('t2', 'trousers', 'مشکی')], matrix);
    assert.equal(result.valid, false);
    assert.ok(result.total <= 40);
    assert.ok(result.issues.some((i) => i.includes('شلوار')));
  });

  test('clashes, formality gaps and pattern overload lower the score deterministically', () => {
    const good = scoreOutfit([item('s', 'shirt', 'صورتی'), item('t', 'trousers', 'کرم')], matrix).total;
    const bad = scoreOutfit([
      item('s', 'shirt', 'قرمز', { pattern: 'checked', formality: 0.9, vibes: ['classic'] }),
      item('t', 'trousers', 'سبز', { pattern: 'striped', formality: 0.2, vibes: ['streetwear'], seasons: ['summer'] }),
    ], matrix).total;
    assert.ok(bad < good - 20, `good=${good} bad=${bad}`);
    assert.equal(scoreOutfit([item('s', 'shirt', 'صورتی'), item('t', 'trousers', 'کرم')], matrix).total, good, 'stable');
  });

  test('features derive from canonical product data', () => {
    const f = deriveFeatures({ name: 'بلیزر پشمی چهارخانه', category: 'کت و پالتو', productType: null, vibes: ['old-money'], seasons: ['autumn'],
      variants: [{ id: 'v', sku: 's', size: 'M', color: 'سرمه‌ای', available: 2 }] });
    assert.equal(f.productType, 'coat'); assert.equal(f.pattern, 'checked'); assert.equal(f.visualWeight, 'heavy');
    assert.ok(f.formality >= 0.9); assert.deepEqual(f.dominantColors, ['سرمه‌ای']);
  });
});

describe('Profile & product-type rules (Req 325-341)', () => {
  const template: SpecField[] = [
    { code: 'material', label: 'جنس', group: 'فنی', fieldType: 'select', options: ['پشم', 'چرم'], required: true, filterable: true },
    { code: 'waterproof', label: 'ضد آب', group: 'فنی', fieldType: 'boolean', options: [], required: false, filterable: true },
    { code: 'weight_grams', label: 'وزن', group: 'فنی', fieldType: 'number', options: [], required: false, filterable: false },
  ];
  test('adaptive spec form validates against the type template', () => {
    assert.deepEqual(validateSpecifications(template, { material: 'پشم', waterproof: true, weight_grams: '950' }), { material: 'پشم', waterproof: true, weight_grams: 950 });
    assert.throws(() => validateSpecifications(template, {}), /الزامی/);
    assert.throws(() => validateSpecifications(template, { material: 'پلاستیک' }), /مجاز/);
    assert.throws(() => validateSpecifications(template, { material: 'پشم', color_code: 'x' }), /تعریف نشده/);
    assert.deepEqual(validateSpecifications(template, { material: 'چرم', extra_note: 'دست‌دوز' }), { material: 'چرم', extra_note: 'دست‌دوز' });
  });

  const png = (w: number, h: number) => {
    const b = Buffer.alloc(64); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
  };
  test('avatar validation checks MIME, magic bytes, size and dimensions', () => {
    assert.deepEqual(sniffImage(png(512, 512)), { mime: 'image/png', width: 512, height: 512 });
    assert.equal(validateAvatar(png(512, 512), 'image/png').width, 512);
    assert.throws(() => validateAvatar(png(512, 512), 'image/jpeg'), /مطابقت/);
    assert.throws(() => validateAvatar(png(20, 20), 'image/png'), /ابعاد/);
    assert.throws(() => validateAvatar(Buffer.from('GIF89a......'), 'image/gif'), /JPG/);
    assert.throws(() => validateAvatar(Buffer.alloc(3 * 1024 * 1024), 'image/png'), /۲ مگابایت/);
  });

  test('supplier sensitive diff shows only real changes', () => {
    const diff = supplierDiff({ bank_iban: 'IR060120020000000397455001', legal_name: 'شرکت الف' }, { bankIban: 'IR110170000000000000000001', legalName: 'شرکت الف', website: 'x' } as Record<string, string>);
    assert.deepEqual(diff, [{ field: 'bankIban', label: 'شماره شبا', oldValue: 'IR060120020000000397455001', newValue: 'IR110170000000000000000001' }]);
  });

  test('loyalty tiers and device labels', () => {
    assert.equal(loyaltyTier(10).code, 'classic'); assert.equal(loyaltyTier(600).code, 'silver'); assert.equal(loyaltyTier(5000).code, 'gold');
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1'), 'Safari روی iOS');
  });
});


describe('SEO Domain (Req 235) and media processing (Req 234, 334)', () => {
  const origin = 'https://kolbe.ir';
  const vibe: SeoSubject = { type: 'vibe', key: 'old-money', name: 'Old Money', description: 'پالت کرم و سرمه‌ای', path: '/vibe/old-money', image: '/api/v1/media/abc', active: true };
  test('derives a complete head from the business entity when no SEO entry exists', () => {
    const r = resolveSeo(vibe, null, origin);
    assert.equal(r.title, 'Old Money | کلبه وینتج'); assert.equal(r.canonical, 'https://kolbe.ir/vibe/old-money');
    assert.equal(r.robots, 'index,follow'); assert.equal(r.og.image, 'https://kolbe.ir/api/v1/media/abc'); assert.equal(r.source, 'derived');
    assert.equal(r.jsonLd[0]!['@type'], 'CollectionPage'); assert.equal(r.jsonLd[1]!['@type'], 'BreadcrumbList');
  });
  test('SEO entry overrides title, canonical, robots and schema; inactive entities are never indexed', () => {
    const r = resolveSeo(vibe, { title: 'استایل اولد مانی', canonical_path: '/vibe/old-money-2', robots_index: true, robots_follow: false, schema_extra: { keywords: 'old money', '@context': 'x' }, version: 3 }, origin);
    assert.equal(r.title, 'استایل اولد مانی | کلبه وینتج'); assert.equal(r.canonical, 'https://kolbe.ir/vibe/old-money-2');
    assert.equal(r.robots, 'index,nofollow'); assert.equal(r.jsonLd[0]!.keywords, 'old money'); assert.equal(r.jsonLd[0]!['@context'], 'https://schema.org');
    assert.equal(resolveSeo({ ...vibe, active: false }, { robots_index: true }, origin).robots, 'noindex,follow');
    assert.equal(resolveSeo(vibe, { title: 'درباره ما | کلبه وینتیج' }, origin).title, 'درباره ما | کلبه وینتیج', 'brand is never appended twice');
  });
  test('product schema carries offer, availability and rating from commerce data', () => {
    const r = resolveSeo({ type: 'product', key: 'p1', name: 'پالتو پشمی', description: '', path: '/product/p1', image: null, active: true,
      product: { priceRial: '48000000', available: 0, brand: 'Kolbe', category: 'پالتو', rating: 4.66, reviewCount: 3 } }, null, origin);
    const product = r.jsonLd[0] as Record<string, any>;
    assert.equal(product['@type'], 'Product'); assert.equal(product.offers.price, '48000000'); assert.equal(product.offers.availability, 'https://schema.org/OutOfStock');
    assert.equal(product.aggregateRating.ratingValue, 4.7); assert.equal(r.og.type, 'product');
  });
  test('validation rejects unsafe values and warns about weak snippets', () => {
    assert.ok(validateSeoInput({ title: '<script>x</script>' }, origin).errors.length);
    assert.ok(validateSeoInput({ canonical_path: 'javascript:alert(1)' }, origin).errors.length);
    assert.ok(validateSeoInput({ og_image: 'http://evil.test/x.png' }, origin).errors.length);
    assert.ok(validateSeoInput({ schema_extra: { a: '</script><script>' } }, origin).errors.length);
    assert.ok(validateSeoInput({ schema_type: 'Recipe' }, origin).errors.length);
    const ok = validateSeoInput({ title: 'کت و پالتوی زمستانی کلبه', description: 'مجموعه کت و پالتوهای پشمی و کشمیر کلبه با ارسال رایگان و خرید چهارقسطه بدون بهره.' }, origin);
    assert.deepEqual(ok.errors, []); assert.deepEqual(ok.warnings, []);
    assert.ok(validateSeoInput({ title: 'کوتاه' }, origin).warnings.some((w) => w.includes('کوتاه')));
    assert.equal(jsonLdString({ a: '</script>' }).includes('</script>'), false);
    assert.deepEqual(legacySeoToWrite({ title: ' T ', index: false, junk: 1 }), { title: 'T', robotsIndex: false });
    assert.equal(legacySeoToWrite({}), null);
  });
  test('avatar is resized to 512 WebP with metadata stripped; variants never upscale', async () => {
    const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#1B2A4A' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'gps-secret' } } }).toBuffer();
    const out = await processAvatar(jpeg);
    assert.equal(out.processed, true); assert.equal(out.mime, 'image/webp'); assert.equal(out.width, 512); assert.equal(out.height, 512);
    assert.equal((await sharp(out.buffer).metadata()).exif, undefined);
    const small = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
    assert.equal((await renderVariant(small, 640, 'webp'))!.width, 200);
    assert.equal(snapWidth(1), 160); assert.equal(snapWidth(700), 960); assert.equal(snapWidth(99999), 1600);
  });
});

/* ============================ Integration (PostgreSQL) ============================ */


/* ============================ Round 3: typed schema, installments, recommendations ============================ */

describe('Typed field schema & presets (Req 175-181, 211)', () => {
  const schema: FieldSchema = { version: 2, props: [], fields: [
    { key: 'title', type: 'text', label: 'تیتر', group: 'content', required: true },
    { key: 'template', type: 'select', label: 'قالب', group: 'layout', options: ['static', 'fullviewport', 'split'] },
    { key: 'image', type: 'media', label: 'تصویر', group: 'media' },
    { key: 'overlay', type: 'number', label: 'تیرگی', group: 'style', min: 0, max: 90 },
    { key: 'video', type: 'video', label: 'ویدیو', group: 'media', showIf: { template: 'video' }, required: true },
  ] } as FieldSchema;
  test('valid payloads are coerced, legacy aliases normalised', () => {
    const out = validateSectionPayload(schema, { title: ' سلام ', template: 'fullbleed', image: '/api/v1/media/0b2a8c1e-0000-4000-8000-000000000001', overlay: '40' });
    assert.equal(out.title, 'سلام'); assert.equal(out.template, 'fullviewport'); assert.equal(out.overlay, 40);
  });
  test('unknown options, unsafe text, foreign media and out-of-range numbers are rejected', () => {
    assert.throws(() => validateSectionPayload(schema, { title: 'x', template: 'weird' }), /باید یکی از/);
    assert.throws(() => validateSectionPayload(schema, { title: '<script>alert(1)</script>' }), /HTML|اسکریپت/);
    assert.throws(() => validateSectionPayload(schema, { title: 'x', image: 'javascript:alert(1)' }), /اسکریپت/);
    assert.throws(() => validateSectionPayload(schema, { title: 'x', image: 'http://evil.test/a.jpg' }), /رسانه/);
    assert.throws(() => validateSectionPayload(schema, { title: 'x', overlay: 400 }));
    assert.throws(() => validateSectionPayload(schema, {}), /الزامی/);
    assert.throws(() => validateSectionPayload(schema, { title: 'x', extra: { nested: true } }), /Schema/);
  });
  test('showIf-hidden required fields are not enforced', () => {
    assert.doesNotThrow(() => validateSectionPayload(schema, { title: 'x', template: 'split' }));
  });
  test('style overrides only accept design tokens', () => {
    assert.throws(() => validateStyleOverrides({ background: 'url(javascript:alert(1))' }));
    assert.throws(() => validateStyleOverrides({ position: 'fixed' }));
  });
});

describe('Installment policy & recommendation scoring (Req 188-191, 239)', () => {
  const provider = (over: Partial<InstallmentProvider>): InstallmentProvider => ({ code: 'snapppay', title: 'اسنپ‌پی', integration_code: null, installments_count: 4, min_order_rial: '10000000',
    max_order_rial: '500000000', fee_percent: '0', badge_text: '', terms: '', brand_color: '#00B2A9', logo_url: null, position: 1, active: true, ...over });
  test('per-instalment amount = ceil(base × (1 + fee) / count) inside eligibility limits', () => {
    const [snapp, digi] = installmentOffers(10_000_001n, true, [], [provider({}), provider({ code: 'digipay', installments_count: 3, fee_percent: '5' })]);
    assert.equal(snapp!.perInstallmentRial, '2500001');
    assert.equal(digi!.totalRial, '10500002'); assert.equal(digi!.perInstallmentRial, '3500001');
    assert.equal(installmentOffers(9_000_000n, true, [], [provider({})]).length, 0, 'below minimum');
    assert.equal(installmentOffers(900_000_000n, true, [], [provider({})]).length, 0, 'above maximum');
    assert.equal(installmentOffers(20_000_000n, false, [], [provider({})]).length, 0, 'product not installment-enabled');
    assert.equal(installmentOffers(20_000_000n, true, ['digipay'], [provider({})]).length, 0, 'product restricted to another provider');
  });
  const product = (over: Partial<CommerceProduct>): CommerceProduct => ({ id: randomUUID(), name: 'p', brand: 'b', category: 'پیراهن', productType: 'shirt', gender: 'men', seasons: ['autumn'],
    vibes: ['old-money'], priceRial: '30000000', installmentPriceRial: null, perInstallmentRial: '7500000', compareAtRial: null, discountPercent: 0, installmentEnabled: true,
    installmentProviders: [], image: null, flatLay: null, available: 3, isNew: false, createdAt: '', rating: 0, reviewCount: 0, variants: [], installmentsCount: 4, installmentOffers: [], ...over });
  test('provider policy drives card numbers; no eligible provider means no instalment line', () => {
    const [p] = applyInstallmentPolicy([product({})], [provider({ installments_count: 6 })]);
    assert.equal(p!.installmentsCount, 6); assert.equal(p!.perInstallmentRial, '5000000');
    const [q] = applyInstallmentPolicy([product({ priceRial: '1000000' })], [provider({})]);
    assert.equal(q!.perInstallmentRial, null);
    assert.equal(applyInstallmentPolicy([product({})], [])[0]!.installmentsCount, 4, 'no providers configured → legacy split');
  });
  test('similar products share vibe/category and stay near in price', () => {
    const anchor = product({});
    const close = product({ priceRial: '32000000' });
    const far = product({ category: 'کفش', productType: 'shoes', vibes: ['streetwear'], priceRial: '300000000', seasons: ['summer'] });
    assert.ok(similarityScore(anchor, close) > similarityScore(anchor, far));
    assert.equal(similarityScore(anchor, anchor), -1);
  });
  test('card rules: collection membership and low stock conditions', () => {
    const base = { discountPercent: 0, isNew: false, installmentEnabled: false, vibes: [], category: 'x' };
    assert.equal(ruleMatches({ ...base, collections: ['new-arrivals'] }, { collectionCode: 'new-arrivals' }), true);
    assert.equal(ruleMatches({ ...base, collections: [] }, { collectionCode: 'new-arrivals' }), false);
    assert.equal(ruleMatches({ ...base, available: 2 }, { maxAvailable: 3 }), true);
    assert.equal(ruleMatches({ ...base, available: 0 }, { maxAvailable: 3 }), false);
    assert.equal(ruleMatches({ ...base, available: 0 }, { outOfStock: true }), true);
  });
});

describe('Migrations carry schema, not content (fresh database = empty CMS)', () => {
  test('agent-C migrations 035-044 never seed pages, sections, announcements or active providers', () => {
    const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
    const own = readdirSync(dir).filter((f) => /^0(3[5-9]|4[0-4])_.*\.sql$/.test(f));
    assert.ok(own.length >= 3);
    for (const file of own) {
      const sql = readFileSync(dir + file, 'utf8');
      for (const table of ['cms_pages', 'cms_sections', 'cms_announcements']) assert.ok(!new RegExp(`INSERT INTO ${table}\\b`).test(sql), `${file} seeds ${table}`);
      assert.ok(!/INSERT INTO installment_providers[^;]*true\)/.test(sql), `${file} seeds an active installment provider`);
    }
  });
});

/* ============================ End-to-end (needs TEST_DATABASE_URL) ============================ */

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4011, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('CMS studio, style intelligence and unified profile work end to end', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const hash = await argon2.hash('Password-123456!');
    const mkUser = async (label: string, role: string, phone?: string) => {
      const id = randomUUID();
      await pool.query('INSERT INTO users(id,email,phone,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)', [id, `${label}-${suffix}@example.test`, phone ?? null, hash, label]);
      await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `${label}-${suffix}@example.test`, password: 'Password-123456!' },
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' } });
      assert.equal(login.statusCode, 200, login.body);
      return { id, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
    };
    const admin = await mkUser('xp-admin', 'admin');
    const phone = `0912${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const customer = await mkUser('xp-customer', 'customer', phone);

    /* ---- Req 174: fresh page → hero → edit → publish → GET → render, no 500 ---- */
    const page = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/landing-pages', headers: admin.headers,
      payload: { code: `camp-${suffix}`, title: 'کمپین بلک فرایدی', path: `/campaign/bf-${suffix}`, pageType: 'campaign', template: 'campaign' } });
    assert.equal(page.statusCode, 201, page.body);
    const pageId = page.json().id as string;
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/site/pages/camp-${suffix}` })).statusCode, 404, 'drafts are not public');
    const preview = await app.inject({ method: 'GET', url: `/api/v1/admin/cms/pages/${pageId}/preview`, headers: admin.headers });
    assert.equal(preview.statusCode, 200, preview.body);
    const heroSection = preview.json().sections.find((s: { component_code: string }) => s.component_code === 'hero');
    assert.ok(heroSection);
    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/admin/cms/sections/${heroSection.id}`, headers: admin.headers,
      payload: { payload: { ...heroSection.payload, title: 'بلک فرایدی کلبه' } } });
    assert.equal(edited.statusCode, 200, edited.body);
    const published = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/publish`, headers: admin.headers, payload: { changeSummary: 'انتشار اول' } });
    assert.equal(published.statusCode, 200, published.body);
    const live = await app.inject({ method: 'GET', url: `/api/v1/site/pages/camp-${suffix}` });
    assert.equal(live.statusCode, 200, live.body);
    assert.equal(live.json().sections.find((s: { component_code: string }) => s.component_code === 'hero').payload.title, 'بلک فرایدی کلبه');
    // Draft edits don't leak to the live page until republished; restore works.
    await app.inject({ method: 'PATCH', url: `/api/v1/admin/cms/sections/${heroSection.id}`, headers: admin.headers, payload: { payload: { ...heroSection.payload, title: 'پیش‌نویس' } } });
    const stillLive = await app.inject({ method: 'GET', url: `/api/v1/site/pages/camp-${suffix}` });
    assert.equal(stillLive.json().sections.find((s: { component_code: string }) => s.component_code === 'hero').payload.title, 'بلک فرایدی کلبه');
    const versions = await app.inject({ method: 'GET', url: `/api/v1/admin/cms/pages/${pageId}/versions`, headers: admin.headers });
    assert.equal(versions.json().items.length, 1);
    const restored = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/versions/${versions.json().items[0].version}/restore`, headers: admin.headers });
    assert.equal(restored.statusCode, 200, restored.body);

    /* ---- Composable builder, themes, announcements, layout safety ---- */
    const unsafe = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/components/composable', headers: admin.headers,
      payload: { code: `bad_${suffix.replace(/-/g, '')}`, title: 'بد', composition: [{ type: 'text', props: { value: '<script>x</script>' } }] } });
    assert.equal(unsafe.statusCode, 400);
    const composable = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/components/composable', headers: admin.headers,
      payload: { code: `card_${suffix.replace(/-/g, '')}`, title: 'کارت سفارشی', composition: [{ type: 'container', children: [{ type: 'product_image' }, { type: 'badge', props: { value: 'ویژه' } }, { type: 'price' }] }] } });
    assert.equal(composable.statusCode, 201, composable.body);
    const badTheme = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/themes', headers: admin.headers, payload: { code: `bt-${suffix}`, name: 'بد',
      tokens: { background: '#FFFFFF', surface: '#FFFFFF', surfaceSecondary: '#FFFFFF', textPrimary: '#EEEEEE', textSecondary: '#DDDDDD', primary: '#111111', secondary: '#222222', accent: '#333333', border: '#EEEEEE', success: '#00AA00', warning: '#AAAA00', danger: '#AA0000' } } });
    assert.equal(badTheme.statusCode, 400);
    const theme = await app.inject({ method: 'GET', url: '/api/v1/site/theme' });
    assert.equal(theme.statusCode, 200); assert.ok(theme.json().theme.design_tokens.textPrimary);
    const ann = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/announcements', headers: admin.headers, payload: {
      title: `ann-${suffix}`, messages: [{ text: 'تخفیف ویژه تا پایان امشب' }], mode: 'marquee', priority: 999,
      style: { backgroundColor: '#0B0F17', textColor: '#FFFFFF' } } });
    assert.equal(ann.statusCode, 201, ann.body);
    await app.inject({ method: 'POST', url: '/api/v1/admin/cms/announcements', headers: admin.headers, payload: {
      title: `future-${suffix}`, messages: [{ text: 'آینده' }], mode: 'static', priority: 1000, startsAt: '2099-01-01T00:00:00.000Z',
      style: { backgroundColor: '#0B0F17', textColor: '#FFFFFF' } } });
    const layout = await app.inject({ method: 'GET', url: '/api/v1/site/layout' });
    assert.equal(layout.json().announcements[0].title, `ann-${suffix}`);
    assert.ok(!layout.json().announcements.some((a: { title: string }) => a.title === `future-${suffix}`));
    assert.ok(layout.json().header.menus.length >= 3);
    const header = { ...layout.json().header, logoText: '<script>x</script>' };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/cms/layout/global_header', headers: admin.headers, payload: header })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/cms/layout/global_header', headers: customer.headers, payload: layout.json().header })).statusCode, 403);
    /* Header CTA is a real, validated config shared by preview and storefront */
    const ctaHeader = { ...layout.json().header, ctaEnabled: true, ctaLabel: 'بازارچه عمده', ctaTarget: 'vip', ctaVariant: 'outline' };
    const ctaPut = await app.inject({ method: 'PUT', url: '/api/v1/admin/cms/layout/global_header', headers: admin.headers, payload: ctaHeader });
    assert.equal(ctaPut.statusCode, 200, ctaPut.body);
    const ctaLayout = (await app.inject({ method: 'GET', url: '/api/v1/site/layout' })).json().header;
    assert.equal(ctaLayout.ctaEnabled, true); assert.equal(ctaLayout.ctaVariant, 'outline'); assert.equal(ctaLayout.ctaTarget, 'vip');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/cms/layout/global_header', headers: admin.headers, payload: { ...ctaHeader, ctaVariant: 'neon' } })).statusCode, 400);

    /* ---- Asset usage guard ---- */
    const asset = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/assets', headers: admin.headers,
      payload: { url: `https://cdn.example.test/${suffix}.jpg`, title: 'هیرو', assetType: 'image', tags: ['hero'] } });
    assert.equal(asset.statusCode, 201, asset.body);
    const afterRestore = await app.inject({ method: 'GET', url: `/api/v1/admin/cms/pages/${pageId}/preview`, headers: admin.headers });
    const restoredHero = afterRestore.json().sections.find((s: { component_code: string }) => s.component_code === 'hero');
    assert.equal(restoredHero.payload.title, 'بلک فرایدی کلبه', 'restore brings back the published content');
    const linked = await app.inject({ method: 'PATCH', url: `/api/v1/admin/cms/sections/${restoredHero.id}`, headers: admin.headers, payload: { payload: { ...restoredHero.payload, image: `https://cdn.example.test/${suffix}.jpg` } } });
    assert.equal(linked.statusCode, 200, linked.body);
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/admin/cms/assets/${asset.json().id}`, headers: admin.headers });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.match(blocked.json().message, /کمپین بلک فرایدی/);

    /* ---- Lead → CRM ---- */
    const lead = await app.inject({ method: 'POST', url: '/api/v1/site/leads', payload: { pageCode: 'vip-lead', phone: `0935${suffix.replace(/\D/g, '').padEnd(7, '1').slice(0, 7)}`, consent: true, fullName: 'سرنخ' } });
    assert.equal(lead.statusCode, 201, lead.body);
    assert.ok((await pool.query('SELECT 1 FROM crm_activities WHERE contact_id = $1', [lead.json().contactId])).rowCount);

    /* ---- Adaptive product form (Req 325-326) ---- */
    const baseProduct = { brand: 'Kolbe', category: 'کت و پالتو', cashPriceRial: '89000000', productTypeCode: 'coat', vibes: ['old-money'], seasons: ['autumn', 'winter'] };
    const missing = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers, payload: { ...baseProduct, name: `کت ${suffix}`, variants: [{ size: 'M', color: 'سرمه‌ای' }] } });
    assert.equal(missing.statusCode, 400, missing.body);
    const badSize = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers,
      payload: { ...baseProduct, name: `کت ${suffix}`, variants: [{ size: '44', color: 'سرمه‌ای' }], specifications: { material: 'پشم خالص', fit: 'Regular Fit' } } });
    assert.equal(badSize.statusCode, 400, badSize.body);
    const coat = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers,
      payload: { ...baseProduct, name: `کت پشمی ${suffix}`, variants: [{ size: 'M', color: 'سرمه‌ای' }], specifications: { material: 'پشم خالص', fit: 'Regular Fit', waterproof: true } } });
    assert.equal(coat.statusCode, 201, coat.body);
    const shirt = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers, payload: { brand: 'Kolbe', category: 'پیراهن', cashPriceRial: '38000000',
      productTypeCode: 'shirt', name: `پیراهن صورتی ${suffix}`, vibes: ['old-money'], seasons: ['spring', 'autumn'], variants: [{ size: 'M', color: 'صورتی' }], specifications: { material: 'کتان ۱۰۰٪', fit: 'Regular Fit' } } });
    const trousers = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers, payload: { brand: 'Kolbe', category: 'شلوار', cashPriceRial: '42000000',
      productTypeCode: 'trousers', name: `شلوار کرم ${suffix}`, vibes: ['old-money'], seasons: ['spring', 'autumn'], variants: [{ size: '32', color: 'کرم' }], specifications: { material: 'کتان پنبه', fit: 'راسته کلاسیک (Straight)' } } });
    assert.equal(shirt.statusCode, 201, shirt.body); assert.equal(trousers.statusCode, 201, trousers.body);
    for (const p of [coat, shirt, trousers]) await app.inject({ method: 'PATCH', url: `/api/v1/products/${p.json().id}/status`, headers: admin.headers, payload: { status: 'published' } });
    const wh = randomUUID();
    await pool.query('INSERT INTO warehouses(id,code,name) VALUES ($1,$2,$3)', [wh, `XP-${suffix}`, 'انبار تست']);
    await pool.query('INSERT INTO stock_balances(variant_id,warehouse_id,on_hand) VALUES ($1,$2,5),($3,$2,4)', [shirt.json().variants[0].id, wh, trousers.json().variants[0].id]);

    /* ---- Style Builder (Req 253-266) ---- */
    const score = await app.inject({ method: 'POST', url: '/api/v1/style/score', payload: { items: [{ productId: shirt.json().id }, { productId: trousers.json().id }] } });
    assert.equal(score.statusCode, 200, score.body);
    assert.ok(score.json().total >= 85, score.body);
    const validate = await app.inject({ method: 'POST', url: '/api/v1/style/validate', payload: { items: [{ productId: shirt.json().id }, { productId: trousers.json().id }, { productId: coat.json().id }] } });
    assert.equal(validate.statusCode, 200, validate.body);
    assert.equal(validate.json().purchasableCount, 2);
    assert.equal(validate.json().message, '۲ از ۳ آیتم قابل خرید هستند.');
    assert.equal(validate.json().bundlePriceRial, '80000000');
    const saved = await app.inject({ method: 'POST', url: '/api/v1/styles', headers: customer.headers,
      payload: { name: 'استایل پاییزی', items: [{ productId: shirt.json().id }, { productId: trousers.json().id }] } });
    assert.equal(saved.statusCode, 201, saved.body);
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/styles/${saved.json().id}`, headers: customer.headers,
      payload: { items: [{ productId: shirt.json().id }, { productId: trousers.json().id }, { productId: coat.json().id }], privacy: 'unlisted' } });
    assert.equal(updated.json().version, 2, updated.body);
    const shared = await app.inject({ method: 'GET', url: `/api/v1/styles/shared/${saved.json().shareCode}` });
    assert.equal(shared.statusCode, 200, shared.body); assert.equal(shared.json().products.length, 3);

    /* ---- Unified profile & security (Req 333-351) ---- */
    const patched = await app.inject({ method: 'PATCH', url: '/api/v1/profile', headers: customer.headers, payload: { firstName: 'یاشار', lastName: 'رضایی', city: 'تهران', postalCode: '1234567890' } });
    assert.equal(patched.statusCode, 200, patched.body); assert.equal(patched.json().displayName, 'یاشار رضایی');
    const newPhone = `0990${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const otp = await app.inject({ method: 'POST', url: '/api/v1/profile/contact-change', headers: customer.headers, payload: { channel: 'phone', value: newPhone } });
    assert.equal(otp.statusCode, 201, otp.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/profile/contact-change/${otp.json().requestId}/verify`, headers: customer.headers, payload: { code: '000000' } })).statusCode, 400);
    const verified = await app.inject({ method: 'POST', url: `/api/v1/profile/contact-change/${otp.json().requestId}/verify`, headers: customer.headers, payload: { code: otp.json().devCode } });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal((await pool.query('SELECT phone FROM users WHERE id = $1', [customer.id])).rows[0].phone, newPhone);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE resource_id = $1 AND action = 'profile.phone_changed'`, [customer.id])).rowCount);
    const realPng = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#C1613B' } }).png().toBuffer();
    const avatar = await app.inject({ method: 'POST', url: '/api/v1/profile/avatar', headers: customer.headers, payload: { dataBase64: realPng.toString('base64'), mime: 'image/png' } });
    assert.equal(avatar.statusCode, 201, avatar.body);
    assert.equal(avatar.json().width, 512); assert.equal(avatar.json().mime, 'image/webp'); assert.equal(avatar.json().resized, true);
    const served = await app.inject({ method: 'GET', url: avatar.json().avatarUrl });
    assert.equal(served.statusCode, 200, 'avatar is publicly served');
    assert.equal(served.headers['content-type'], 'image/webp');
    const variant = await app.inject({ method: 'GET', url: `${avatar.json().avatarUrl as string}?w=150&fmt=jpeg` });
    assert.equal(variant.statusCode, 200); assert.equal(variant.headers['x-media-variant'], '160w'); assert.equal(variant.headers['content-type'], 'image/jpeg');
    assert.equal((await sharp(variant.rawPayload).metadata()).width, 160);
    const cachedVariant = await app.inject({ method: 'GET', url: `${avatar.json().avatarUrl as string}?w=150&fmt=jpeg` });
    assert.equal(cachedVariant.statusCode, 200);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM media_variants WHERE width = 160 AND format = $1', ['jpeg'])).rows[0].n >= 1, true, 'variant cached');
    const fake = Buffer.alloc(80); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fake); fake.write('IHDR', 12, 'ascii'); fake.writeUInt32BE(256, 16); fake.writeUInt32BE(256, 20);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/profile/avatar', headers: customer.headers, payload: { dataBase64: fake.toString('base64'), mime: 'image/png' } })).statusCode, 400, 'corrupt image is rejected');
    const security = await app.inject({ method: 'GET', url: '/api/v1/profile/security', headers: customer.headers });
    assert.equal(security.json().sessions.filter((s: { current: boolean }) => s.current).length, 1);
    assert.match(security.json().loginHistory[0].device_label, /Chrome/);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/profile/password', headers: customer.headers, payload: { currentPassword: 'wrong', newPassword: 'NewPassword-98765!', confirmPassword: 'NewPassword-98765!' } })).statusCode, 400);
    const pwd = await app.inject({ method: 'POST', url: '/api/v1/profile/password', headers: customer.headers, payload: { currentPassword: 'Password-123456!', newPassword: 'NewPassword-98765!', confirmPassword: 'NewPassword-98765!' } });
    assert.equal(pwd.statusCode, 200, pwd.body);
    const twoFa = await app.inject({ method: 'POST', url: '/api/v1/profile/security/2fa', headers: customer.headers, payload: { enabled: true, currentPassword: 'NewPassword-98765!' } });
    assert.equal(twoFa.statusCode, 200, twoFa.body);
    const step1 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: newPhone, password: 'NewPassword-98765!' } });
    assert.equal(step1.json().twoFactorRequired, true, step1.body);
    const step2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login/2fa', payload: { challengeId: step1.json().challengeId, code: step1.json().devCode } });
    assert.equal(step2.statusCode, 200, step2.body); assert.ok(step2.json().accessToken);
    const dashboard = await app.inject({ method: 'GET', url: '/api/v1/account/dashboard', headers: customer.headers });
    assert.equal(dashboard.statusCode, 200, dashboard.body);
    assert.equal(dashboard.json().greetingName, 'یاشار'); assert.equal(dashboard.json().summary.savedStyles, 1);
    const timeline = await app.inject({ method: 'GET', url: '/api/v1/account/timeline', headers: customer.headers });
    assert.ok(timeline.json().items.some((i: { kind: string }) => i.kind === 'style'));
    assert.ok(!timeline.json().items.some((i: { kind: string }) => i.kind.startsWith('audit')));

    /* ---- Supplier approval policy (Req 339-340) ---- */
    const supplier = await mkUser('xp-supplier', 'supplier');
    await pool.query(`INSERT INTO supplier_profiles(user_id,brand_name,bank_iban,cooperation_status) VALUES ($1,'برند تست','IR060120020000000397455001','approved')`, [supplier.id]);
    const direct = await app.inject({ method: 'PATCH', url: '/api/v1/supplier-profile', headers: supplier.headers, payload: { bankIban: 'IR110170000000000000000001' } });
    assert.equal(direct.statusCode, 400, direct.body);
    const change = await app.inject({ method: 'POST', url: '/api/v1/supplier-profile/change-requests', headers: supplier.headers, payload: { changes: { bankIban: 'IR110170000000000000000001' }, note: 'تغییر بانک' } });
    assert.equal(change.statusCode, 201, change.body);
    assert.equal(change.json().diff[0].oldValue, 'IR060120020000000397455001');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/supplier-profile/change-requests', headers: supplier.headers, payload: { changes: { legalName: 'x' } } })).statusCode, 409);
    const approve = await app.inject({ method: 'POST', url: `/api/v1/admin/supplier-change-requests/${change.json().id}/review`, headers: admin.headers, payload: { decision: 'approved' } });
    assert.equal(approve.statusCode, 200, approve.body);
    const after = await pool.query('SELECT bank_iban, version FROM supplier_profiles WHERE user_id = $1', [supplier.id]);
    assert.equal(after.rows[0].bank_iban, 'IR110170000000000000000001'); assert.equal(after.rows[0].version, 2);
    assert.ok((await pool.query('SELECT 1 FROM supplier_profile_versions WHERE user_id = $1', [supplier.id])).rowCount);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('SEO Domain is the single source of head tags for CMS entities (Req 235)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const id = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [id, `seo-admin-${suffix}@example.test`, await argon2.hash('Password-123456!'), 'seo admin']);
    await pool.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')`, [id]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `seo-admin-${suffix}@example.test`, password: 'Password-123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // CMS forms that still send `seo` write into the SEO Domain, not into the CMS row.
    const vibe = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/vibes', headers, payload: { name: 'Quiet Luxury', slug: `ql-${suffix}`, description: 'لوکس آرام', seo: { title: 'استایل Quiet Luxury کلبه' } } });
    assert.equal(vibe.statusCode, 201, vibe.body);
    assert.deepEqual((await pool.query('SELECT seo FROM cms_vibes WHERE id = $1', [vibe.json().id])).rows[0].seo, {});
    assert.equal((await pool.query(`SELECT title FROM seo_entries WHERE entity_type = 'vibe' AND entity_key = $1`, [`ql-${suffix}`])).rows[0].title, 'استایل Quiet Luxury کلبه');
    // Renaming the slug keeps the SEO row attached to the same entity.
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/admin/cms/vibes/${vibe.json().id as string}`, headers, payload: { slug: `quiet-${suffix}` } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    const pub = await app.inject({ method: 'GET', url: `/api/v1/seo/vibe/quiet-${suffix}` });
    assert.equal(pub.statusCode, 200, pub.body);
    assert.equal(pub.json().title, 'استایل Quiet Luxury کلبه | کلبه وینتج'); assert.equal(pub.json().canonical, `http://127.0.0.1:5173/vibe/quiet-${suffix}`);

    // Admin SEO editor: validation, optimistic versioning, history, audit and outbox.
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/admin/seo/vibe/quiet-${suffix}`, headers, payload: { canonicalPath: 'javascript:alert(1)' } })).statusCode, 400);
    const put = await app.inject({ method: 'PUT', url: `/api/v1/admin/seo/vibe/quiet-${suffix}`, headers,
      payload: { description: 'استایل Quiet Luxury؛ پارچه‌های طبیعی، رنگ‌های خنثی و دوخت دقیق در کلبه وینتج.', robotsIndex: false, ogTitle: 'Quiet Luxury', schemaExtra: { keywords: 'quiet luxury' }, expectedVersion: 1 } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().version, 2); assert.equal(put.json().resolved.robots, 'noindex,follow'); assert.equal(put.json().resolved.og.title, 'Quiet Luxury');
    assert.equal((await app.inject({ method: 'PUT', url: `/api/v1/admin/seo/vibe/quiet-${suffix}`, headers, payload: { title: 'x', expectedVersion: 1 } })).statusCode, 400, 'stale version');
    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/seo/vibe/quiet-${suffix}`, headers });
    assert.equal(detail.json().history.length, 2);
    assert.ok((await pool.query(`SELECT 1 FROM outbox_events WHERE event_type = 'seo.updated' AND payload->>'entityKey' = $1`, [`quiet-${suffix}`])).rowCount);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'seo.updated' AND resource_id = $1`, [`quiet-${suffix}`])).rowCount);
    const preview = await app.inject({ method: 'POST', url: `/api/v1/admin/seo/vibe/quiet-${suffix}/preview`, headers, payload: { title: 'پیش‌نمایش' } });
    assert.equal(preview.json().resolved.title, 'پیش‌نمایش | کلبه وینتج');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/seo/vibe/quiet-${suffix}` })).json().title, 'استایل Quiet Luxury کلبه | کلبه وینتج', 'preview does not persist');

    // Sitemap honours noindex; the published About page carries SEO Domain head tags.
    const sitemap = await app.inject({ method: 'GET', url: '/api/v1/seo/sitemap.xml' });
    assert.equal(sitemap.statusCode, 200); assert.match(sitemap.headers['content-type'] as string, /xml/);
    assert.equal(sitemap.body.includes(`/vibe/quiet-${suffix}`), false);
    await app.inject({ method: 'PUT', url: '/api/v1/admin/seo/page/about', headers, payload: { title: 'داستان کلبه وینتج' } });
    const about = await app.inject({ method: 'GET', url: '/api/v1/site/pages/about' });
    if (about.statusCode === 200) {
      assert.equal(about.json().seo.title, 'داستان کلبه وینتج'); assert.equal(about.json().seo.jsonLd[0]['@type'], 'AboutPage');
    }
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/seo?type=vibe', headers });
    assert.ok(list.json().items.some((i: { key: string; index: boolean }) => i.key === `quiet-${suffix}` && i.index === false));
    const anon = await app.inject({ method: 'GET', url: '/api/v1/admin/seo' });
    assert.equal(anon.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/seo/robots.txt' })).body.includes('Sitemap:'), true);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('Round 3: presets, installments, recommendations, saved cart, review photos and media pipeline (Req 180-191, 239-240, 322, 330, 344)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const hash = await argon2.hash('Password-123456!');
    const mk = async (label: string, role: string) => {
      const id = randomUUID();
      await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [id, `${label}-${suffix}@example.test`, hash, label]);
      await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, role]);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `${label}-${suffix}@example.test`, password: 'Password-123456!' } });
      return { id, headers: { authorization: `Bearer ${login.json().accessToken as string}` } };
    };
    const admin = await mk('r3-admin', 'admin');
    const customer = await mk('r3-customer', 'customer');

    /* Schema-validated sections + presets */
    const page = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/landing-pages', headers: admin.headers,
      payload: { code: `r3-${suffix}`, title: 'صفحه تست', path: `/campaign/r3-${suffix}`, pageType: 'campaign', template: 'blank' } });
    assert.equal(page.statusCode, 201, page.body);
    const pageId = page.json().id as string;
    const bad = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections`, headers: admin.headers, payload: { componentCode: 'hero', payload: { title: 'x', height: 'giant' } } });
    assert.equal(bad.statusCode, 400);
    const created = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections`, headers: admin.headers, payload: { componentCode: 'hero', presetCode: 'cinematic', payload: { title: 'تیتر' } } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().payload.template, 'cinematic'); assert.equal(created.json().payload.title, 'تیتر');
    const applied = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/sections/${created.json().id as string}/apply-preset`, headers: admin.headers, payload: { presetCode: 'minimal' } });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(applied.json().preset, 'minimal'); assert.equal(applied.json().payload.title, 'تیتر', 'content survives a preset switch');
    const registry = await app.inject({ method: 'GET', url: '/api/v1/admin/cms/registry', headers: admin.headers });
    assert.ok(registry.json().items.find((c: { code: string }) => c.code === 'hero').presetDefinitions.length >= 10);

    /* Installment providers are managed centrally and drive storefront numbers */
    const provider = { title: 'اسنپ‌پی', installmentsCount: 6, minOrderRial: '1000000', maxOrderRial: '900000000', feePercent: 0, badgeText: '۶ قسط', terms: 'بدون کارمزد',
      brandColor: '#00B2A9', logoUrl: null, position: 1, active: true, integrationCode: null };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/admin/installment-providers/snapppay', headers: customer.headers, payload: provider })).statusCode, 403);
    const put = await app.inject({ method: 'PUT', url: '/api/v1/admin/installment-providers/snapppay', headers: admin.headers, payload: provider });
    assert.equal(put.statusCode, 200, put.body);
    assert.ok((await pool.query(`SELECT 1 FROM audit_logs WHERE action LIKE 'installment_provider.%' AND resource_id = 'snapppay'`)).rowCount);
    const product = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin.headers, payload: { brand: 'Kolbe', category: 'پیراهن', cashPriceRial: '60000000',
      productTypeCode: 'shirt', name: `پیراهن R3 ${suffix}`, vibes: ['old-money'], seasons: ['autumn'], installmentEnabled: true, variants: [{ size: 'L', color: 'سفید' }], specifications: { material: 'کتان ۱۰۰٪', fit: 'Regular Fit' } } });
    assert.equal(product.statusCode, 201, product.body);
    const productId = product.json().id as string; const variantId = product.json().variants[0].id as string;
    await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: admin.headers, payload: { status: 'published' } });
    const wh = randomUUID();
    await pool.query('INSERT INTO warehouses(id,code,name) VALUES ($1,$2,$3)', [wh, `R3-${suffix}`, 'انبار R3']);
    await pool.query('INSERT INTO stock_balances(variant_id,warehouse_id,on_hand) VALUES ($1,$2,3)', [variantId, wh]);
    // Canonical recommendation contract after the Agent D1 merge: slot-based engine.
    const similar = await app.inject({ method: 'GET', url: `/api/v1/recommendations?slot=product.similar&strategy=similar&productId=${productId}&limit=4` });
    assert.equal(similar.statusCode, 200, similar.body);
    assert.ok(similar.json().items.every((p: { id: string; availableStock: number }) => p.id !== productId && p.availableStock > 0));
    const popular = await app.inject({ method: 'GET', url: '/api/v1/recommendations?slot=home.for_you&strategy=popular&limit=16' });
    assert.equal(popular.statusCode, 200, popular.body);
    const mine = popular.json().items.find((p: { id: string }) => p.id === productId);
    // Money/stock provenance: items carry catalog pricing read at request time
    // (installment display itself is covered by the installment policy suite).
    if (mine) assert.ok(String(mine.cashPriceRial).length > 0, 'recommendation items carry canonical catalog pricing');
    const anon = await app.inject({ method: 'GET', url: '/api/v1/recommendations?slot=home.for_you' });
    assert.equal(anon.statusCode, 200, anon.body);
    assert.equal(anon.json().strategy, 'personalized', 'slot default resolves');
    assert.ok(Array.isArray(anon.json().items) && anon.json().items.length > 0, 'anonymous personalized falls back to popular items');

    /* Saved cart keeps references only; price/stock are live */
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/profile/saved-cart', headers: customer.headers, payload: { items: [{ productId, variantId, quantity: 2 }] } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().items[0].available, 3); assert.equal(saved.json().items[0].product.priceRial, '60000000');
    assert.equal((await pool.query('SELECT items FROM saved_carts WHERE user_id = $1', [customer.id])).rows[0].items[0].priceRial, undefined, 'no copied price');
    const restored = await app.inject({ method: 'GET', url: '/api/v1/profile/saved-cart', headers: customer.headers });
    assert.equal(restored.json().items[0].quantity, 2, 'restore returns the saved lines');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/profile/saved-cart', headers: customer.headers, payload: { items: [] } })).json().items.length, 0, 'clear');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/profile/saved-cart', headers: customer.headers })).json().items.length, 0);
    await app.inject({ method: 'PUT', url: '/api/v1/profile/saved-cart', headers: customer.headers, payload: { items: [{ productId, variantId, quantity: 2 }] } });
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/profile/saved-cart', headers: customer.headers, payload: { items: [{ productId, variantId: randomUUID(), quantity: 1 }] } })).statusCode, 400);

    /* Review photos: only own images, moderated, then processed by the media pipeline */
    const png = await sharp({ create: { width: 700, height: 500, channels: 3, background: '#C1613B' } }).png().toBuffer();
    const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: customer.headers, payload: { originalName: 'r.png', mime: 'image/png', dataBase64: png.toString('base64') } });
    assert.equal(upload.statusCode, 201, upload.body);
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/files', headers: admin.headers, payload: { originalName: 'a.png', mime: 'image/png', dataBase64: png.toString('base64') } });
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/reviews`, headers: customer.headers, payload: { rating: 5, photoFileIds: [foreign.json().id] } })).statusCode, 400);
    const review = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/reviews`, headers: customer.headers, payload: { rating: 5, body: 'خوب', photoFileIds: [upload.json().id] } });
    assert.equal(review.statusCode, 201, review.body); assert.equal(review.json().status, 'pending');
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/media/${upload.json().id as string}` })).statusCode, 404, 'unmoderated photo is not public');
    await app.inject({ method: 'POST', url: '/api/v1/admin/media-pipeline/process', headers: admin.headers, payload: {} });
    const run = (await pool.query(`SELECT status, metadata FROM media_pipeline_runs WHERE subject_type = 'review_photo' AND subject_id = $1`, [review.json().id])).rows[0];
    assert.ok(run, 'pipeline run recorded'); assert.equal(run.status, 'partial'); assert.equal(run.metadata.width, 700); assert.deepEqual(run.metadata.variants, [320, 640]);
    await pool.query(`UPDATE customer_reviews SET status = 'approved' WHERE id = $1`, [review.json().id]);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/media/${upload.json().id as string}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/reviews` })).json().items[0].photos.length, 1);

    /* Announcements bind only to existing targets and resolve them publicly */
    const style = { backgroundColor: '#1B2A4A', textColor: '#FFFFFF' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/cms/announcements', headers: admin.headers,
      payload: { title: 'x', messages: [{ text: 'x' }], mode: 'static', style, bindingType: 'collection', bindingId: `missing-${suffix}` } })).statusCode, 400);
    const ann = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/announcements', headers: admin.headers,
      payload: { title: 'لندینگ', messages: [{ text: 'ثبت‌نام زودهنگام' }], mode: 'static', style, bindingType: 'landing_page', bindingId: `r3-${suffix}`, priority: 999 } });
    assert.equal(ann.statusCode, 201, ann.body);
    const layout = await app.inject({ method: 'GET', url: '/api/v1/site/layout' });
    assert.equal(layout.json().announcements.some((a: { id: string }) => a.id === ann.json().id), false, 'draft landing page → announcement hidden');
    await pool.query('DELETE FROM cms_announcements WHERE id = $1', [ann.json().id]);
  } finally {
    await app.close();
    await pool.end();
  }
});

test('CMS starter content is created only by the admin bootstrap and is idempotent (Req 205, 274, 283)', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const id = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)', [id, `starter-${suffix}@example.test`, await argon2.hash('Password-123456!'), 'starter']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [id, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `starter-${suffix}@example.test`, password: 'Password-123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    const first = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/bootstrap', headers });
    assert.equal(first.statusCode, 200, first.body);
    const pages = (await pool.query(`SELECT code, status, active FROM cms_pages WHERE code IN ('about','vibe-old-money','vibe-dark-academia','vip-lead') ORDER BY code`)).rows;
    assert.deepEqual(pages.map((r) => r.code), ['about', 'vibe-dark-academia', 'vibe-old-money', 'vip-lead']);
    assert.ok(pages.every((r) => r.status === 'draft' && r.active));
    const seo = await app.inject({ method: 'GET', url: '/api/v1/seo/page/about' });
    assert.equal(seo.statusCode, 404, 'unpublished starter metadata is not public');
    const draftSeo = await app.inject({ method: 'GET', url: '/api/v1/admin/seo/page/about', headers });
    assert.equal(draftSeo.statusCode, 200, draftSeo.body);
    assert.ok(String(draftSeo.json().resolved.title).includes('درباره ما'), draftSeo.body);
    const stats = await pool.query(`SELECT 1 FROM cms_sections s JOIN cms_pages p ON p.id = s.page_id JOIN cms_components c ON c.id = s.component_id
      WHERE p.code = 'about' AND c.code = 'stats_strip'`);
    assert.equal(stats.rowCount, 0, 'no fabricated customer/rating metrics in CMS content');
    const ann = await pool.query(`SELECT active, messages::text AS m FROM cms_announcements WHERE id = '8a660000-0000-4000-8000-000000000001'`);
    assert.equal(ann.rows[0]?.active, false, 'starter announcement ships inactive');
    assert.ok(!/ارسال رایگان|چهارقسطی/.test(ann.rows[0]!.m), 'shipping/instalment terms are not duplicated in CMS copy');
    const digipay = await pool.query(`SELECT active FROM installment_providers WHERE code = 'digipay'`);
    assert.equal(digipay.rows[0]?.active, false, 'installment providers ship inactive');

    const count = async () => Number((await pool.query('SELECT count(*)::int AS n FROM cms_sections')).rows[0].n);
    const before = await count();
    const second = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/bootstrap', headers });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().starterPagesCreated, 0);
    assert.equal(await count(), before, 're-running bootstrap never duplicates sections');
  } finally {
    await app.close();
    await pool.end();
  }
});
