import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('SEO/Search/Media PostgreSQL integration smoke', { skip: !databaseUrl }, async () => {
  const config: Config = {
    NODE_ENV: 'test', PORT: 4001, DATABASE_URL: databaseUrl!, REDIS_URL: undefined,
    JWT_SECRET: process.env.JWT_SECRET ?? 'embedded-test-secret-at-least-thirty-two-characters',
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173',
    PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false', PG_POOL_MAX: 2,
    S3_ENDPOINT: undefined, S3_REGION: undefined, S3_BUCKET: undefined,
    S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, S3_PUBLIC_BASE_URL: undefined,
  };
  const app = await buildApp(config);
  const pool = createPool(config);
  const adminId = randomUUID();
  const vendorId = randomUUID();
  const productId = randomUUID();
  const supplierProductId = randomUUID();
  const noindexProductId = randomUUID();
  const variantId = randomUUID();
  const supplierVariantId = randomUUID();
  const warehouseId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  try {
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4),($5,$6,$3,$7)', [
      adminId, `seo-admin-${suffix}@example.test`, await argon2.hash('IntegrationPassword123!'), 'SEO integration admin',
      vendorId, `seo-vendor-${suffix}@example.test`, 'SEO integration supplier',
    ]);
    await pool.query("INSERT INTO user_roles(user_id,role_code) VALUES ($1,'admin')", [adminId]);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { identity: `seo-admin-${suffix}@example.test`, password: 'IntegrationPassword123!' } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { authorization: `Bearer ${login.json().accessToken as string}` };

    // SEO persistence, revisions, permissions and robots endpoint.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/seo/pages' })).statusCode, 401);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/admin/seo/pages/site/home', headers: { origin: config.PUBLIC_ORIGIN, 'access-control-request-method': 'PUT' } });
    assert.equal(preflight.statusCode, 204);
    assert.match(String(preflight.headers['access-control-allow-methods']), /PUT/);
    const saveSeo = await app.inject({ method: 'PUT', url: '/api/v1/admin/seo/pages/site/home', headers, payload: {
      seoTitle: 'Integration home', metaDescription: 'SEO API persistence smoke', slug: '/', canonicalUrl: '',
      isIndexable: true, isFollowable: true, socialTitle: '', socialDescription: '', socialImageUrl: '', schemaOverride: {},
    } });
    assert.equal(saveSeo.statusCode, 200, saveSeo.body);
    assert.doesNotMatch(JSON.stringify(saveSeo.json()), /aggregateRating/);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/admin/seo/revisions?entityType=site&entityKey=home', headers })).json().items.length, 1);
    const settings = await app.inject({ method: 'PUT', url: '/api/v1/admin/seo/settings', headers, payload: {
      robotsText: 'User-agent: *\nDisallow: /private', crawlSchedule: 'manual', organizationSchema: {}, merchantFields: {},
    } });
    assert.equal(settings.statusCode, 200, settings.body);
    assert.match((await app.inject({ method: 'GET', url: '/robots.txt' })).body, /Disallow: \/private/);
    const savedSettings = await app.inject({ method: 'GET', url: '/api/v1/admin/seo/settings', headers });
    assert.equal(savedSettings.json().scheduledCrawlExecution, 'inactive');
    assert.equal(savedSettings.json().facetPolicyExecution, 'inactive');
    const savedFacets = await app.inject({ method: 'GET', url: '/api/v1/admin/seo/facets', headers });
    assert.equal(savedFacets.json().executionStatus, 'inactive');

    // DB-backed retail and supplier products; sitemap must use canonical/indexable retail URLs only.
    await pool.query(`INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,metadata) VALUES
      ($1,NULL,'Kolbe','Aurora Coat','Coats','Description','published',500000,'{}'),
      ($2,$3,'Vendor','Supplier Coat','Coats','Description','published',250000,'{}'),
      ($4,NULL,'Kolbe','Noindex Coat','Coats','Description','published',300000,'{}')`, [productId, supplierProductId, vendorId, noindexProductId]);
    await pool.query(`INSERT INTO product_variants(id,product_id,sku,size_label,color_label) VALUES
      ($1,$2,$3,'M','Black'),($4,$5,$6,'M','Black')`, [variantId, productId, `SEO-${suffix}`, supplierVariantId, supplierProductId, `SUP-${suffix}`]);
    const videoSave = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/media`, headers,
      payload: { role: 'video', url: 'https://media.example.test/aurora.mp4', purpose: 'gallery', metadata: { title: 'Aurora video' } } });
    assert.equal(videoSave.statusCode, 201, videoSave.body);
    const videoId = videoSave.json().id as string;
    const adminVideos = await app.inject({ method: 'GET', url: `/api/v1/admin/products/${productId}/media`, headers });
    assert.ok(adminVideos.json().items.some((item: { id: string; url: string }) => item.id === videoId && item.url === 'https://media.example.test/aurora.mp4'));
    const publicVideos = await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/media` });
    assert.ok(publicVideos.json().items.some((item: { id: string; url: string }) => item.id === videoId && item.url === 'https://media.example.test/aurora.mp4'));
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/admin/products/${productId}/media/${videoId}`, headers })).statusCode, 200);
    assert.ok(!(await app.inject({ method: 'GET', url: `/api/v1/products/${productId}/media` })).json().items.some((item: { id: string }) => item.id === videoId));
    await pool.query(`INSERT INTO seo_pages(entity_type,entity_key,slug,canonical_url,is_indexable) VALUES
      ('product',$1,'/products/aurora','https://kolbe.ir/canonical-aurora',true),
      ('product',$2,'/products/supplier','https://kolbe.ir/canonical-supplier',true),
      ('product',$3,'/products/noindex','',false)`, [productId, supplierProductId, noindexProductId]);
    const sitemap = await app.inject({ method: 'GET', url: '/sitemap.xml' });
    assert.equal(sitemap.statusCode, 200, sitemap.body);
    assert.match(sitemap.body, /https:\/\/kolbe\.ir\/canonical-aurora/);
    assert.match(sitemap.body, /<loc>https:\/\/kolbe\.ir\/<\/loc>/);
    assert.doesNotMatch(sitemap.body, /canonical-supplier|products\/noindex/);
    const productSeo = await app.inject({ method: 'PUT', url: `/api/v1/admin/seo/pages/product/${productId}`, headers,
      payload: { seoTitle: 'Aurora SEO Center title', metaDescription: 'Aurora description from SEO Center',
        slug: '/products/aurora', canonicalUrl: 'https://kolbe.ir/canonical-aurora', isIndexable: true,
        isFollowable: true, socialTitle: '', socialDescription: '', socialImageUrl: '', schemaOverride: {} } });
    assert.equal(productSeo.statusCode, 200, productSeo.body);
    const rawProduct = await app.inject({ method: 'GET', url: `/product/${productId}` });
    assert.equal(rawProduct.statusCode, 200, rawProduct.body);
    assert.match(rawProduct.body, /<title>Aurora SEO Center title/);
    assert.match(rawProduct.body, /Aurora description from SEO Center/);
    assert.match(rawProduct.body, /<link rel="canonical" href="https:\/\/kolbe\.ir\/canonical-aurora">/);
    assert.match(rawProduct.body, /"@type":"Product"/);
    assert.match(rawProduct.body, /"@type":"ProductGroup"/);
    assert.match(rawProduct.body, /"priceCurrency":"IRR","price":"500000"/);
    assert.doesNotMatch(rawProduct.body, /aggregateRating/);
    const rawCategory = await app.inject({ method: 'GET', url: '/category/coats' });
    assert.equal(rawCategory.statusCode, 200, rawCategory.body);
    assert.match(rawCategory.body, /<h1>کت و پالتو<\/h1>/);

    // Search is a discovery layer; the price/availability filters read product prices and stock rows.
    await pool.query('INSERT INTO warehouses(id,code,name) VALUES ($1,$2,$3)', [warehouseId, `SEO-${suffix}`, 'SEO test warehouse']);
    await pool.query('INSERT INTO stock_balances(variant_id,warehouse_id,on_hand,reserved,damaged) VALUES ($1,$2,4,0,0)', [variantId, warehouseId]);
    await pool.query("UPDATE products SET gender='female',seasons=ARRAY['winter'],vibes=ARRAY['classic'],description='بارانی وینتج' WHERE id=$1", [productId]);
    const firstCatalogPage = await app.inject({ method: 'GET', url: '/api/v1/products?limit=1&offset=0' });
    const secondCatalogPage = await app.inject({ method: 'GET', url: '/api/v1/products?limit=1&offset=1' });
    assert.equal(firstCatalogPage.statusCode, 200, firstCatalogPage.body);
    assert.equal(secondCatalogPage.statusCode, 200, secondCatalogPage.body);
    assert.notEqual(firstCatalogPage.json().items[0]?.id, secondCatalogPage.json().items[0]?.id);
    for (const query of [
      'q=Aurora', 'q=%D8%A8%D8%A7%D8%B1%D8%A7%D9%86%DB%8C', 'category=Coats',
      'gender=female', 'season=winter', 'vibe=classic',
      'gender=female&season=winter&vibe=classic&category=Coats',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/search?${query}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.json().items.some((item: { id: string }) => item.id === productId), query);
    }
    for (const query of ['gender=invalid', 'season=summer', 'vibe=unknown']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/search?${query}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.json().items.some((item: { id: string }) => item.id === productId), query);
    }
    await pool.query("INSERT INTO search_synonyms(phrase,replacement) VALUES ('vintage rainwear','Aurora Coat')");
    const synonymSearch = await app.inject({ method: 'GET', url: '/api/v1/search?q=vintage%20rainwear&available=true&minPriceRial=500000&maxPriceRial=500000' });
    assert.equal(synonymSearch.statusCode, 200, synonymSearch.body);
    assert.equal(synonymSearch.json().items[0]?.id, productId);
    await pool.query('UPDATE stock_balances SET on_hand=0 WHERE variant_id=$1 AND warehouse_id=$2', [variantId, warehouseId]);
    const soldOut = await app.inject({ method: 'GET', url: '/api/v1/search?q=vintage%20rainwear&available=true' });
    assert.equal(soldOut.json().items.length, 0);
    const metric = await app.inject({ method: 'POST', url: '/api/v1/public/search/metrics', payload: { query: 'Vintage Rainwear', event: 'search', resultCount: 0 } });
    assert.equal(metric.statusCode, 200, metric.body);
    const analytics = await app.inject({ method: 'GET', url: '/api/v1/admin/search/analytics?zeroResult=true', headers });
    assert.equal(analytics.statusCode, 200, analytics.body);
    assert.equal(analytics.json().items[0]?.normalized_query, 'vintage rainwear');
    const synonym = await app.inject({ method: 'PUT', url: '/api/v1/admin/search/synonyms/coat', headers, payload: { replacement: 'Aurora Coat', active: true } });
    assert.equal(synonym.statusCode, 200, synonym.body);

    // Redirect rules reject loops and the request hook also catches legacy loops at runtime.
    const redirect = await app.inject({ method: 'POST', url: '/api/v1/admin/seo/redirects', headers, payload: { sourcePath: '/legacy-coat', targetPath: '/current-coat', statusCode: 301, active: true } });
    assert.equal(redirect.statusCode, 201, redirect.body);
    const followed = await app.inject({ method: 'GET', url: '/legacy-coat' });
    assert.equal(followed.statusCode, 301);
    assert.equal(followed.headers.location, '/current-coat');
    for (const targetPath of ['//evil.example', 'http://evil.example', 'https://evil.example',
      'javascript:alert(1)', 'data:text/html,x', '/\\evil.example', '/%2Fevil.example', '/%5Cevil.example',
      '/safe\\evil.example', '/safe\r\nLocation: https://evil.example']) {
      const unsafe = await app.inject({ method: 'POST', url: '/api/v1/admin/seo/redirects', headers,
        payload: { sourcePath: `/unsafe-${randomUUID()}`, targetPath, statusCode: 301, active: true } });
      assert.equal(unsafe.statusCode, 400, `unsafe redirect ${JSON.stringify(targetPath)}: ${unsafe.body}`);
    }
    await pool.query("INSERT INTO seo_redirects(id,source_path,target_path,status_code) VALUES ($1,'/legacy-unsafe','//evil.example',301)", [randomUUID()]);
    const legacyUnsafe = await app.inject({ method: 'GET', url: '/legacy-unsafe' });
    assert.equal(legacyUnsafe.statusCode, 400);
    assert.equal(legacyUnsafe.headers.location, undefined);
    const loopWrite = await app.inject({ method: 'POST', url: '/api/v1/admin/seo/redirects', headers, payload: { sourcePath: '/current-coat', targetPath: '/legacy-coat', statusCode: 302, active: true } });
    assert.equal(loopWrite.statusCode, 400, loopWrite.body);
    await pool.query("INSERT INTO seo_redirects(id,source_path,target_path,status_code) VALUES ($1,'/old-loop-a','/old-loop-b',301),($2,'/old-loop-b','/old-loop-a',301)", [randomUUID(), randomUUID()]);
    assert.equal((await app.inject({ method: 'GET', url: '/old-loop-a' })).statusCode, 508);

    // Persistent 404 monitoring and technical crawl results.
    assert.equal((await app.inject({ method: 'GET', url: '/non-existent-seo-smoke' })).statusCode, 404);
    const notFound = await app.inject({ method: 'GET', url: '/api/v1/admin/seo/not-found', headers });
    assert.equal(notFound.statusCode, 200, notFound.body);
    assert.ok(notFound.json().items.some((row: { path: string }) => row.path === '/non-existent-seo-smoke'));
    const crawl = await app.inject({ method: 'POST', url: '/api/v1/admin/seo/crawls', headers, payload: {} });
    assert.equal(crawl.statusCode, 201, crawl.body);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/admin/seo/crawls/${crawl.json().id}/issues`, headers })).statusCode, 200);

    // Editorial + media persistence and relation to a real product variant.
    const article = await app.inject({ method: 'POST', url: '/api/v1/admin/editorial', headers, payload: {
      postType: 'article', slug: `seo-smoke-${suffix}`, title: 'SEO smoke article', excerpt: 'Excerpt', body: 'Content', coverUrl: '',
      author: 'Test', category: 'Editorial', tags: ['test'], sourceType: 'external', sourceUrl: '', durationSeconds: null,
      seoTitle: '', seoDescription: '', relatedProductIds: [productId], status: 'published',
    } });
    assert.equal(article.statusCode, 201, article.body);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/public/editorial/${article.json().slug}` })).statusCode, 200);
    const rawBlog = await app.inject({ method: 'GET', url: `/journal/${article.json().slug}` });
    assert.equal(rawBlog.statusCode, 200, rawBlog.body);
    assert.match(rawBlog.body, /<title>SEO smoke article<\/title>/);
    assert.match(rawBlog.body, /<h1>SEO smoke article<\/h1>/);
    assert.match(rawBlog.body, /"@type":"Article"/);
    const media = await app.inject({ method: 'POST', url: '/api/v1/admin/media', headers, payload: {
      mediaType: 'image', sourceType: 'external', publicUrl: 'https://media.example.test/aurora.jpg', mimeType: 'image/jpeg',
      altText: 'Aurora coat front view', title: 'Aurora front', metadata: {},
    } });
    assert.equal(media.statusCode, 201, media.body);
    const attached = await app.inject({ method: 'POST', url: `/api/v1/admin/products/${productId}/media`, headers, payload: {
      mediaAssetId: media.json().id, variantId, purpose: 'gallery', position: 0,
    } });
    assert.equal(attached.statusCode, 201, attached.body);
    const publicMedia = await app.inject({ method: 'GET', url: `/api/v1/public/products/${productId}/media` });
    assert.equal(publicMedia.statusCode, 200, publicMedia.body);
    assert.equal(publicMedia.json().items[0]?.variant_id, variantId);
    const unauthorizedUpload = await app.inject({ method: 'POST', url: '/api/v1/admin/media/upload-intents', payload: { mediaType: 'image', fileName: 'test.jpg', mimeType: 'image/jpeg', byteSize: 20 } });
    assert.equal(unauthorizedUpload.statusCode, 401);
    const unconfiguredUpload = await app.inject({ method: 'POST', url: '/api/v1/admin/media/upload-intents', headers, payload: { mediaType: 'image', fileName: 'test.jpg', mimeType: 'image/jpeg', byteSize: 20 } });
    assert.equal(unconfiguredUpload.statusCode, 503, unconfiguredUpload.body);
    assert.match(unconfiguredUpload.body, /STORAGE_UNAVAILABLE/);
    const providers = await app.inject({ method: 'GET', url: '/api/v1/admin/seo/integration', headers });
    assert.equal(providers.statusCode, 200, providers.body);
    assert.ok(providers.json().items.filter((row: { provider: string }) => ['google_search_console','google_merchant_center','cdn','object_storage'].includes(row.provider)).every((row: { status: string }) => row.status === 'not_configured'));
  } finally {
    await app.close();
    await pool.end();
  }
});
