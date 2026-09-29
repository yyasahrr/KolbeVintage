import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const enabled = !!process.env.TEST_DATABASE_URL;
const config: Config = {
  NODE_ENV: 'test', PORT: 4008, DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://127.0.0.1:1/none',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PG_POOL_MAX: 1,
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

test('CMS page builder, palettes and support widget are fully manageable', { skip: !enabled }, async () => {
  const app = await buildApp(config);
  const pool = createPool(config);
  try {
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `m-admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'Admin']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `m-admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // Component registry is shared and extensible (item 18).
    const components = await app.inject({ method: 'GET', url: '/api/v1/site/components' });
    assert.ok(components.json().items.length >= 10);
    const custom = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/components', headers, payload: {
      code: `lookbook_${suffix.replace(/-/g, '')}`, title: 'لوک‌بوک فصل', componentType: 'custom',
      fieldSchema: { image: 'text', caption: 'textarea' },
    } });
    assert.equal(custom.statusCode, 201, custom.body);

    // Page builder with sections and drag-drop ordering (items 18-19).
    const page = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/pages', headers, payload: {
      code: `home-${suffix}`, title: 'صفحه اصلی', path: '/', description: 'صفحه اصلی فروشگاه',
      seo: { title: 'کلبه وینتج', description: 'فروشگاه اینترنتی' },
    } });
    assert.equal(page.statusCode, 201, page.body);
    const pageId = page.json().id as string;
    const hero = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections`, headers, payload: {
      componentCode: 'hero', title: 'هدر نوروز', payload: { image: 'https://cdn.example.test/hero.jpg', title: 'کالکشن نوروز', cta: '/shop' },
    } });
    const slider = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections`, headers, payload: {
      componentCode: 'product_slider', title: 'پرفروش‌ها', payload: { limit: 8 },
    } });
    const banner = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections`, headers, payload: {
      componentCode: 'banner', title: 'بنر حراج', payload: { image: 'https://cdn.example.test/sale.jpg', title: 'حراج', link: '/sale' }, visible: false,
    } });
    assert.equal(hero.statusCode, 201, hero.body); assert.equal(banner.statusCode, 201, banner.body);
    // Reorder via the drag-drop endpoint (item 19).
    const reordered = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/pages/${pageId}/sections/reorder`,
      headers, payload: { sectionIds: [slider.json().id, hero.json().id, banner.json().id] } });
    assert.equal(reordered.statusCode, 200, reordered.body);
    const publicPage = await app.inject({ method: 'GET', url: `/api/v1/site/pages/home-${suffix}` });
    assert.equal(publicPage.statusCode, 200, publicPage.body);
    // Hidden sections never reach the storefront.
    assert.equal(publicPage.json().sections.length, 2);
    assert.equal(publicPage.json().sections[0].component_code, 'product_slider');
    assert.equal(publicPage.json().sections[1].component_code, 'hero');

    // Color palettes: 6 coordinated colors, manual and scheduled activation (item 21).
    const palette = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/palettes', headers, payload: {
      code: `valentine-${suffix}`, name: 'پالت ولنتاین', occasion: 'ولنتاین',
      colors: { primary: '#D6336C', secondary: '#F06595', accent: '#FFC9C9', background: '#FFF0F3', surface: '#FFFFFF', text: '#2B1219' },
    } });
    assert.equal(palette.statusCode, 201, palette.body);
    const none = await app.inject({ method: 'GET', url: '/api/v1/site/active-palette' });
    assert.equal(none.json().palette, null);
    const manual = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/palettes/${palette.json().id}/activations`,
      headers, payload: { mode: 'manual' } });
    assert.equal(manual.statusCode, 201, manual.body);
    const active = await app.inject({ method: 'GET', url: '/api/v1/site/active-palette' });
    assert.equal(active.json().palette.code, `valentine-${suffix}`);
    assert.equal(active.json().palette.colors.primary, '#D6336C');

    // A festival-linked palette takes over while its festival runs (item 21).
    const darkPalette = await app.inject({ method: 'POST', url: '/api/v1/admin/cms/palettes', headers, payload: {
      code: `bf-${suffix}`, name: 'پالت بلک‌فرایدی', occasion: 'Black Friday',
      colors: { primary: '#111111', secondary: '#222222', accent: '#FFD700', background: '#000000', surface: '#161616', text: '#F5F5F5' },
    } });
    const festival = await pool.query(
      `INSERT INTO festivals(id,code,name,starts_at,ends_at,discount_percent,auto_apply)
       VALUES ($1,$2,$3, now() - interval '1 hour', now() + interval '1 hour', 20, false) RETURNING id`,
      [randomUUID(), `bfest-${suffix}`, 'جشنواره بلک‌فرایدی']);
    await app.inject({ method: 'POST', url: `/api/v1/admin/cms/palettes/${darkPalette.json().id}/activations`,
      headers, payload: { mode: 'festival', festivalId: festival.rows[0].id } });
    const festivalPalette = await app.inject({ method: 'GET', url: '/api/v1/site/active-palette' });
    assert.equal(festivalPalette.json().palette.code, `bf-${suffix}`);
    assert.equal(festivalPalette.json().palette.mode, 'festival');

    // Scheduled palettes activate and expire on their own.
    const past = await app.inject({ method: 'POST', url: `/api/v1/admin/cms/palettes/${palette.json().id}/activations`,
      headers, payload: { mode: 'scheduled', startsAt: new Date(Date.now() - 7200_000).toISOString(),
        endsAt: new Date(Date.now() - 3600_000).toISOString() } });
    assert.equal(past.statusCode, 201, past.body);
    const stillFestival = await app.inject({ method: 'GET', url: '/api/v1/site/active-palette' });
    assert.equal(stillFestival.json().palette.code, `bf-${suffix}`);

    // Floating support widget is fully managed from the CMS (item 22).
    const widget = await app.inject({ method: 'PUT', url: '/api/v1/admin/site-settings/support-widget', headers, payload: {
      enabled: true, position: 'right',
      channels: [
        { type: 'whatsapp', label: 'واتساپ', value: '989120000000' },
        { type: 'ticket', label: 'ثبت تیکت', value: '/support' },
      ],
      appearance: { color: '#D6336C', size: 'large', icon: 'chat' },
    } });
    assert.equal(widget.statusCode, 200, widget.body);
    const publicWidget = await app.inject({ method: 'GET', url: '/api/v1/site/support-widget' });
    assert.equal(publicWidget.json().widget.position, 'right');
    assert.equal(publicWidget.json().widget.channels.length, 2);
  } finally {
    await app.close();
    await pool.end();
  }
});
