import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import type { Config } from './config.js';

/**
 * Homepage CMS integration (docs/cms-functional-audit.md §5).
 *
 * The storefront homepage renders EXCLUSIVELY from the published `home`
 * snapshot (GET /api/v1/site/pages/home). These tests pin the server side of
 * that contract: bootstrap creates the home page as a DRAFT (public 404 until
 * the first publication), a saved draft never leaks, publication freezes an
 * immutable snapshot (title/order/visibility/limit), republishing replaces the
 * live snapshot, unpublishing returns the homepage to its fallback, and the
 * home page can never be archived. The DOM half of this contract is
 * .smoke/cms-home.mjs (real HTTP + JSDOM).
 *
 * Runs through its own script (npm run test:cms-home) against the embedded
 * PostgreSQL recipe (scripts/run-embedded-tests.mjs style): the node --test
 * CLI schedules multi-file suites against ONE shared database in a
 * non-deterministic order, and the CMS suites assert pristine-DB state (no
 * active palette, starter pages created exactly once). Keeping this suite
 * self-contained keeps every suite green without weakening any assertion.
 */
test('CMS home integration: draft isolation, publication snapshot and public surface', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const config: Config = { NODE_ENV: 'test', PORT: 4021, DATABASE_URL: process.env.TEST_DATABASE_URL!, JWT_SECRET: 'cms-home-integration-secret-at-least-32-chars', PG_POOL_MAX: 1, PUBLIC_ORIGIN: 'http://127.0.0.1:5173', COOKIE_SECURE: 'false' };
  const pool = createPool(config), app = await buildApp(config);
  const suffix = randomUUID().slice(0, 8);
  try {
    const adminId = randomUUID(), adminEmail = `home-admin-${suffix}@example.test`;
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [adminId, adminEmail, await argon2.hash('HomePassword-123456!'), 'مدیر خانه']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [adminId, 'admin']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: adminEmail, password: 'HomePassword-123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    const admin = { authorization: `Bearer ${login.json().accessToken}` };
    const call = async (method: 'GET' | 'POST' | 'PUT', route: string, payload?: unknown) =>
      app.inject({ method, url: `/api/v1${route}`, headers: admin, payload: payload as never });

    let pageId = '', revision = 0, firstVersion = 0;

    await t.test('bootstrap leaves the home page as a draft with the base composition', async () => {
      /* another suite on this shared database may have bootstrapped already —
         the route is idempotent and must hand back the same home page */
      const boot = await call('POST', '/admin/cms/bootstrap');
      assert.ok(boot.statusCode === 200 || boot.statusCode === 201, boot.body);
      const body = boot.json();
      pageId = body.pageId;
      const draft = (await call('GET', `/admin/cms/pages/${pageId}/draft`)).json();
      assert.equal(draft.status, 'draft');
      assert.ok(draft.sections.length >= 9, `base sections missing: ${draft.sections.length}`);
      assert.equal(draft.sections[0].component_code, 'hero');
      assert.ok(draft.draft_revision >= 1);
      revision = draft.draft_revision;
      /* a previous run of this suite on a long-lived database may have left the
         home page published — return it to draft so the fallback contract below
         is observed from a clean state */
      const live = await call('GET', '/site/pages/home');
      if (live.statusCode === 200) {
        const off = await call('POST', `/admin/cms/pages/${pageId}/unpublish`, { archive: false });
        assert.equal(off.statusCode, 200, off.body);
        assert.equal((await call('GET', '/site/pages/home')).statusCode, 404);
      }
      /* nothing published → the public homepage endpoint must 404 so the
         storefront keeps its accepted fallback composition */
      assert.equal((await call('GET', '/site/pages/home')).statusCode, 404);
    });

    await t.test('guest requests never see the draft; permission checks hold', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/site/pages/home' })).statusCode, 404);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/cms/pages' })).statusCode, 401);
    });

    await t.test('saved draft edits (title, hide, add, reorder, limit) stay invisible publicly', async () => {
      const draft = (await call('GET', `/admin/cms/pages/${pageId}/draft`)).json();
      const byCode = (code: string) => draft.sections.find((s: { component_code: string }) => s.component_code === code);
      /* 1. hero speaks with a new title */
      byCode('hero').payload = { ...byCode('hero').payload, title: 'پرده اول کلبه', eyebrow: 'کالکشن پاییز', ctaTarget: 'shop' };
      /* 2. newsletter is hidden */
      byCode('newsletter').visible = false;
      /* 3. product_grid shows 4 items */
      byCode('product_grid').payload = { ...byCode('product_grid').payload, limit: 4 };
      /* 4. a new text section joins between cta and category_card … */
      draft.sections.push({ id: randomUUID(), component_code: 'text_section', title: 'ویراستاری کلبه', payload: { title: 'ویراستاری کلبه', text: 'پارچه، دوخت و ماندگاری؛ سه کلمه‌ای که همه چیز را می‌سازند.' }, visible: true, position: 0, variant: 'centered', section_theme: 'inherit', style_overrides: {}, responsive_config: {} });
      /* 5. … and the save contract takes the ARRAY order as the new section
         order (exactly what a drag-drop save sends) */
      const order = ['hero', 'product_slider', 'cta', 'text_section', 'category_card', 'product_grid', 'recommendation_section', 'review_section', 'installment_card', 'newsletter'];
      draft.sections.sort((a: { component_code: string }, b: { component_code: string }) => order.indexOf(a.component_code) - order.indexOf(b.component_code));
      const save = await call('PUT', `/admin/cms/pages/${pageId}/draft`, {
        expectedRevision: draft.draft_revision, title: draft.title, path: draft.path, description: draft.description,
        sections: draft.sections.map(({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config }: Record<string, unknown>) => ({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config })),
      });
      assert.equal(save.statusCode, 200, save.body);
      revision = save.json().draft_revision;
      assert.equal((await call('GET', '/site/pages/home')).statusCode, 404, 'a saved draft must never be public');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM cms_page_versions WHERE page_id=$1', [pageId])).rows[0].n, 0, 'saving a draft must not create a publication');
    });

    await t.test('publication freezes the snapshot and the public home matches it exactly', async () => {
      const published = await call('POST', `/admin/cms/pages/${pageId}/publish`, { expectedRevision: revision, changeSummary: 'انتشار خانه' });
      assert.equal(published.statusCode, 200, published.body);
      firstVersion = published.json().version;
      assert.ok(firstVersion >= 1);
      const live = await call('GET', '/site/pages/home');
      assert.equal(live.statusCode, 200, live.body);
      const page = live.json();
      assert.equal(page.publishedVersion, firstVersion);
      assert.equal(page.status, 'published');
      const codes = page.sections.map((s: { component_code: string }) => s.component_code);
      assert.deepEqual(codes, ['hero', 'product_slider', 'cta', 'text_section', 'category_card', 'product_grid', 'recommendation_section', 'review_section', 'installment_card']);
      const hero = page.sections.find((s: { component_code: string }) => s.component_code === 'hero');
      assert.equal(hero.payload.title, 'پرده اول کلبه');
      assert.equal(hero.payload.eyebrow, 'کالکشن پاییز');
      assert.ok(!codes.includes('newsletter'), 'hidden sections must not exist in the public snapshot');
      const grid = page.sections.find((s: { component_code: string }) => s.component_code === 'product_grid');
      assert.equal(grid.payload.limit, 4);
      assert.ok(page.sections.every((s: { visible: boolean }) => s.visible), 'public snapshot carries visible sections only');
    });

    await t.test('a second publication replaces the live snapshot for every reader', async () => {
      const draft = (await call('GET', `/admin/cms/pages/${pageId}/draft`)).json();
      const hero = draft.sections.find((s: { component_code: string }) => s.component_code === 'hero');
      hero.payload = { ...hero.payload, title: 'پرده دوم کلبه' };
      const save = await call('PUT', `/admin/cms/pages/${pageId}/draft`, {
        expectedRevision: draft.draft_revision, title: draft.title, path: draft.path, description: draft.description,
        sections: draft.sections.map(({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config }: Record<string, unknown>) => ({ id, component_code, title, payload, visible, position, variant, section_theme, style_overrides, responsive_config })),
      });
      assert.equal(save.statusCode, 200, save.body);
      const published = await call('POST', `/admin/cms/pages/${pageId}/publish`, { expectedRevision: save.json().draft_revision, changeSummary: 'نسخه دوم' });
      assert.equal(published.statusCode, 200, published.body);
      const live = (await call('GET', '/site/pages/home')).json();
      assert.equal(live.publishedVersion, firstVersion + 1);
      assert.equal(live.sections.find((s: { component_code: string }) => s.component_code === 'hero').payload.title, 'پرده دوم کلبه');
    });

    await t.test('the site layout surface serves header, footer and announcements', async () => {
      const layout = await call('GET', '/site/layout');
      assert.equal(layout.statusCode, 200, layout.body);
      const body = layout.json();
      assert.ok('header' in body && 'footer' in body && Array.isArray(body.announcements));
    });

    await t.test('unpublishing returns the homepage to its fallback; archiving home is refused', async () => {
      const off = await call('POST', `/admin/cms/pages/${pageId}/unpublish`, { archive: false });
      assert.equal(off.statusCode, 200, off.body);
      assert.equal((await call('GET', '/site/pages/home')).statusCode, 404);
      const archive = await call('POST', `/admin/cms/pages/${pageId}/unpublish`, { archive: true });
      assert.equal(archive.statusCode, 400, 'the home page can never be archived');
      const on = await call('POST', `/admin/cms/pages/${pageId}/publish`, { expectedRevision: (await call('GET', `/admin/cms/pages/${pageId}/draft`)).json().draft_revision, changeSummary: 'بازگشت' });
      assert.equal(on.statusCode, 200, on.body);
      assert.equal((await call('GET', '/site/pages/home')).statusCode, 200);
    });
  } finally {
    await pool.end().catch(() => undefined);
    await app.close();
  }
});
