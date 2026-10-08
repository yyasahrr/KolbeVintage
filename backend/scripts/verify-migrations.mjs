/* Fresh-database migration verifier (integration readiness).
 *
 * Boots an empty embedded PostgreSQL, runs the migration runner from zero, prints
 * schema_migrations in apply order, asserts the reserved-range files landed last and
 * that the schema really contains the objects this branch owns. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const backendRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.VERIFY_PG_PORT ?? 55461);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const databaseUrl = `postgres://127.0.0.1:${port}/pglite`;
const env = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
  JWT_SECRET: 'verify-secret-at-least-thirty-two-characters', PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PG_POOL_MAX: '2',
};
const run = (args, overrides = {}, { silent = false } = {}) => new Promise((resolve) => {
  const child = spawn('npm', args, { cwd: backendRoot, env: { ...env, ...overrides },
    stdio: silent ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: process.platform === 'win32' });
  let captured = '';
  if (silent) {
    child.stdout.on('data', (chunk) => { captured += chunk; });
    child.stderr.on('data', (chunk) => { captured += chunk; });
  }
  child.on('exit', (code) => {
    // A failing step must show WHY — otherwise a red verifier is undiagnosable.
    if (silent && (code ?? 1) !== 0) console.log(captured.split('\n').slice(-25).join('\n'));
    resolve(code ?? 1);
  });
  child.on('error', () => resolve(1));
});

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  const migrated = await run(['run', '--silent', 'migrate'], {}, { silent: true });
  check(migrated === 0, 'migrate runs from an empty database');

  const rows = (await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version')).rows;
  console.log('\nschema_migrations (apply order = name order):');
  for (const row of rows) console.log(`   ${row.version}  ${new Date(row.applied_at).toISOString()}`);
  console.log('');

  const names = rows.map((row) => row.version);
  check(!names.includes('016_supplier360_invoice_finance.sql'), 'legacy 016 name is not applied');
  check(names.every((name, index) => index === 0 || names[index - 1] < name), 'schema_migrations is in ascending name order');
  check(rows.length === new Set(names).size, 'no duplicate migration rows (one file = one row)');

  // Integration (Agent 6): the merged inventory is the union of every agent's migrations.
  const expectedAll = ['001_core.sql','002_notifications.sql','003_sms.sql','004_invoices.sql','005_wallet.sql','006_suppliers.sql','007_plans_marketplace.sql','008_crm_promo.sql','009_integrations.sql','010_cms.sql','011_access_tickets.sql','012_wms_wishlist.sql','013_shipping_returns_files.sql','014_console_domains.sql','015_user_preferences.sql','016_commerce_product.sql','017_specs_sizeguides.sql','018_imports_shipping_rules.sql','025_supplier360.sql','026_invoice_engine.sql','027_finance_operations.sql','035_cms_style_profile_356.sql','036_seo_domain_media_variants.sql','037_cms_audit_round3.sql','045_membership_buyer.sql','046_crm_intelligence.sql','047_automation_tracking.sql','048_reviews_recommendations.sql','049_video_permissions_promo_growth_hardening.sql','050_seo_search_media.sql','050z_product_type_recovery_snapshot.sql','051_product_types_name_dedupe.sql','052_review_purchase_scope.sql','053_product_type_dependents.sql','054_accounting_period_dates.sql','055_wholesale_inventory_promotions.sql','056_manual_sales_product_colors.sql','057_variant_price_override.sql','058_wms_core.sql','059_supplier_requests.sql','060_series_templates.sql','061_promotion_festival_exclusivity.sql','062_series_inventory.sql','063_product_wms_foundation.sql','064_wholesale_master_oms.sql','065_supplier_settlement_core.sql','066_tryon_monetization.sql','067_cashback_wallet.sql','068_transfer_discrepancy.sql','069_catalog_category_authority.sql','070_series_commercial_pricing.sql','071_wholesale_child_cancellation.sql','072_customer_otp_login.sql','073_supplier_oms_lifecycle.sql','074_prompt6_inbound_qc_consolidation.sql'];
  check(JSON.stringify(names) === JSON.stringify(expectedAll),
    'full merged inventory applied in name order', names.length === expectedAll.length ? '' : `got ${names.length} files`);
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/migrations');
  const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  const migrationIds = migrationFiles.map((name) => name.match(/^(\d{3}[a-z]?)/)?.[1] ?? '');
  check(migrationFiles.length === 55 && JSON.stringify(migrationFiles) === JSON.stringify(expectedAll)
    && migrationIds.every(Boolean) && migrationIds.length === new Set(migrationIds).size,
    '55 migration files have unique version identifiers (050z is a distinct recovery-snapshot id)');
  check(names.slice(-3).join(',') === '072_customer_otp_login.sql,073_supplier_oms_lifecycle.sql,074_prompt6_inbound_qc_consolidation.sql',
    '074 Prompt 6 inbound/QC/consolidation is the final unique migration after 072/073');
  const reserved = names.filter((name) => /^02[5-9]_/.test(name));
  check(reserved.join(',') === '025_supplier360.sql,026_invoice_engine.sql,027_finance_operations.sql',
    '025 → 026 → 027 order preserved');
  check(names.indexOf('015_user_preferences.sql') < names.indexOf('025_supplier360.sql'),
    'reserved range runs after the shared base (015 precedes 025)');

  const count = async (sql) => Number((await db.query(sql)).rows[0].count);
  check(await count("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name IN ('supplier_status_history','supplier_restrictions','invoice_templates','invoice_template_versions','accounting_periods','supplier_finance_accounts','supplier_ledger_entries','settlement_lines','settlement_exceptions','settlement_events','supplier_advances','financial_adjustments','finance_approvals','finance_approval_events','shipping_allocations','shipping_allocation_lines')") === 16,
    'all 16 finance/supplier tables exist');
  check(await count("SELECT count(*)::int AS count FROM invoice_templates") === 4, 'four default invoice templates seeded');
  check(await count("SELECT count(*)::int AS count FROM invoice_template_versions") === 4, 'one version row per default template');
  check(await count("SELECT count(*)::int AS count FROM permissions WHERE code IN ('invoices:templates','supplier360:read','supplier360:manage','finance:adjust','finance:approve','finance:periods','finance:export')") === 7,
    'seven finance/supplier permissions seeded');
  check(await count("SELECT count(*)::int AS count FROM ledger_accounts WHERE code IN ('MARKETPLACE_COMMISSION','SUPPLIER_ADVANCE','SHIPPING_EXPENSE','REFUND_PAYABLE','OTHER_INCOME','PENALTY_INCOME')") === 6,
    'six finance ledger accounts seeded');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'order_lines' AND column_name = 'weight_grams'") === 1,
    'order_lines.weight_grams added once (canonical order table extended, not duplicated)');
  const triggers = (await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`)).rows.map((row) => row.tgname);
  const expectedTriggers = ['supplier_activity_status_sync', 'supplier_ledger_immutable', 'settlement_events_immutable', 'finance_approval_events_immutable'];
  check(expectedTriggers.every((name) => triggers.includes(name)),
    'four integrity triggers installed', expectedTriggers.filter((n) => !triggers.includes(n)).join(',') || 'all present');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'invoices' AND column_name IN ('snapshot','template_version_id','pdf_file_id')") === 3,
    'invoice snapshot/version/pdf columns present');
  // §2-§8/§27-§35 (062): explicit series inventory + warehouse purpose + variant sale flag + sales channel.
  check(await count("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name IN ('series_stock_balances','series_stock_movements','order_series_reservations','retail_supply_orders','retail_supply_events')") === 5,
    'all 5 series-inventory/retail-supply tables exist (062)');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'warehouses' AND column_name = 'purpose'") === 1,
    'warehouses.purpose added (062)');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'product_variants' AND column_name = 'retail_sale_enabled'") === 1,
    'product_variants.retail_sale_enabled added (062)');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'orders' AND column_name IN ('sales_channel','series_snapshot')") === 2,
    'orders.sales_channel + orders.series_snapshot added (062)');

  // Prompt 2 (064): Master/Child wholesale OMS tables + child columns on orders.
  check(await count("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name IN ('master_orders','child_order_lines','order_source_allocations','payment_allocations','master_consolidations','consolidation_items','fulfillment_exceptions')") === 7,
    'all 7 master/child OMS tables exist (064)');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='orders' AND column_name IN ('master_order_id','seller_id','supply_status','payment_eligibility','child_fulfillment','composition_state')") === 6,
    'orders child-order columns added (064)');
  check(await count("SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='payment_intents'::regclass AND conname='payment_intents_target_check' AND pg_get_constraintdef(oid) LIKE '%<= 1%'") === 1,
    'payment_intents target CHECK relaxed to at-most-one (064)');
  check(await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='child_order_lines' AND column_name IN ('supplier_response_status','supplier_response_note','supplier_responded_at','supplier_committed_series','supplier_committed_at','supplier_ready_at')") === 6,
    '073 Supplier response/commit/readiness lifecycle extends the canonical OMS line');
  check(await count("SELECT count(*)::int AS count FROM pg_indexes WHERE indexname IN ('child_order_lines_supplier_response_idx','order_source_allocations_supplier_demand_idx')") === 2,
    '073 Supplier OMS list indexes installed');

  // Prompt 6 (074): ONE inbound lifecycle document, receiving/QC buckets on the canonical allocation,
  // the GRN gains an OMS scope, and the exception catalogue + warehouse permissions are widened.
  check(await count("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'oms_inbound_shipments'") === 1,
    '074 oms_inbound_shipments is the single inbound lifecycle document (no quantities, no second authority)');
  check(await count(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='order_source_allocations'
      AND column_name IN ('inbound_shipment_id','received_missing_series','received_damaged_series','qc_damaged_series','receipt_note','qc_note','received_by','received_at','qc_by','qc_at')`) === 10,
    '074 receiving/QC buckets extend the canonical allocation (one quantity authority)');
  check(await count(`SELECT count(*)::int AS count FROM pg_constraint WHERE conname IN
      ('order_source_allocations_receipt_buckets_check','order_source_allocations_qc_buckets_check')
      AND convalidated`) === 2,
    '074 server-side receipt/QC reconciliation guards are installed and validated');
  check(await count(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='warehouse_receipts'
      AND column_name IN ('oms_inbound_shipment_id','shortage_series','damaged_series','inspected_by','inspected_at')`) === 5
      && await count("SELECT count(*)::int AS count FROM pg_constraint WHERE conname='warehouse_receipts_scope_check' AND convalidated") === 1,
    '074 the existing GRN table gains an OMS scope with an exactly-one-scope rule (no second receipts table)');
  check(await count(`SELECT count(*)::int AS count FROM pg_indexes WHERE indexname IN
      ('warehouse_receipts_oms_shipment_uniq','oms_inbound_shipments_live_uniq','fulfillment_exceptions_open_idx')`) === 3,
    '074 duplicate-receipt / duplicate-live-leg uniqueness + open-exception index installed');
  check(await count(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='master_consolidations'
      AND column_name IN ('package_count','total_series','total_pieces','weight_grams','dimensions','packaging_note')`) === 6
      && await count("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='consolidation_items' AND column_name='scan_reference'") === 1,
    '074 packing/verification metadata extends the existing consolidation tables (nothing fabricated, NULL by default)');
  check(await count(`SELECT count(*)::int AS count FROM pg_constraint WHERE conname='fulfillment_exceptions_exception_type_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%over_receipt%' AND pg_get_constraintdef(oid) LIKE '%reconciliation_failed%'`) === 1,
    '074 widens the exception catalogue instead of creating a second exception store');
  check(await count("SELECT count(*)::int AS count FROM permissions WHERE code IN ('wms:receive','wms:qc','wms:consolidate','wms:ship')") === 4
      && await count(`SELECT count(*)::int AS count FROM role_permissions
         WHERE permission_code IN ('wms:receive','wms:qc','wms:consolidate','wms:ship')`) >= 4,
    '074 installs the warehouse duties (receive/qc/consolidate/ship) and grants them to the operator roles');

  // Upgrade from the last pre-dedupe schema with conflicting size mappings and
  // products. 050z must snapshot dependents before the published 051 deletes.
  const upgradeDb = await PGlite.create();
  const upgradeServer = new PGLiteSocketServer({ db: upgradeDb, port: port + 1, host: '127.0.0.1', maxConnections: 20 });
  await upgradeServer.start();
  const upgradeEnv = { DATABASE_URL: `postgres://127.0.0.1:${port + 1}/pglite`,
    TEST_DATABASE_URL: `postgres://127.0.0.1:${port + 1}/pglite` };
  try {
    check(await run(['run', '--silent', 'migrate'], { ...upgradeEnv, MIGRATION_STOP_AFTER: '050_seo_search_media.sql' }) === 0,
      'upgrade fixture migrated through 050');
    const loser = 'c3000000-0003-4000-8000-000000000003';
    const winner = '8a880000-0000-4000-8000-000000000003';
    await upgradeDb.query(`INSERT INTO product_type_sizes(id,product_type_id,code,label,position)
      VALUES(gen_random_uuid(),$1,'29','29',0),(gen_random_uuid(),$1,'30','loser 30',1)`, [loser]);
    await upgradeDb.query(`INSERT INTO products(id,brand,name,category,cash_price_rial,product_type_id,product_type_code)
      VALUES(gen_random_uuid(),'Kolbe','loser product','pants',100000,$1,'pants'),
            (gen_random_uuid(),'Kolbe','winner product','pants',100000,$2,'trousers')`, [loser, winner]);
    check(await run(['run', '--silent', 'migrate'], { ...upgradeEnv, MIGRATION_STOP_AFTER: '068_transfer_discrepancy.sql' }) === 0,
      'upgrade applies 050z→068 before category/pricing fixtures');

    // Populate a realistic pre-069 database: free-text product categories, profile-only category,
    // a pre-existing CMS category, and a legacy-priced relational series recipe.
    const legacyCategory = 'Legacy category authority fixture';
    const legacyProfileId = randomUUID();
    const existingProfileId = randomUUID();
    const legacyProductId = randomUUID();
    const legacyVariantId = randomUUID();
    const legacyTemplateId = randomUUID();
    const legacySku = `MIG-${randomUUID().slice(0, 8).toUpperCase()}`;
    const existingCms = await upgradeDb.query("SELECT id FROM cms_categories WHERE slug = 'trousers'");
    const existingCmsId = existingCms.rows[0]?.id;
    check(Boolean(existingCmsId), 'upgrade fixture has a pre-existing CMS category to preserve');
    await upgradeDb.query(`INSERT INTO category_profiles(id,category,allowed_sizes)
      VALUES($1,$2,'[\"M\"]'::jsonb),($3,'شلوار','[\"32\"]'::jsonb)`,
      [legacyProfileId, legacyCategory, existingProfileId]);
    await upgradeDb.query(`INSERT INTO products(id,brand,name,category,cash_price_rial,wholesale_price_rial,wholesale_moq)
      VALUES($1,'Kolbe','Migration fixture seeded product',$2,3500000,1234567,6),
            ($3,'Kolbe','Existing CMS product fixture','شلوار',4200000,1100000,2)`,
      [legacyProductId, legacyCategory, randomUUID()]);
    await upgradeDb.query(`INSERT INTO product_variants(id,product_id,sku,color_label,size_label)
      VALUES($1,$2,$3,'مشکی','M')`, [legacyVariantId, legacyProductId, legacySku]);
    await upgradeDb.query(`INSERT INTO series_templates(id,product_id,name,description)
      VALUES($1,$2,'Legacy pricing migration fixture','pre-070 compatibility')`, [legacyTemplateId, legacyProductId]);
    await upgradeDb.query(`INSERT INTO series_template_items(id,series_template_id,variant_id,quantity_per_series)
      VALUES($1,$2,$3,2)`, [randomUUID(), legacyTemplateId, legacyVariantId]);
    const before069 = (await upgradeDb.query(`SELECT
      (SELECT count(*)::int FROM products) AS products,
      (SELECT count(*)::int FROM product_variants) AS variants,
      (SELECT count(*)::int FROM category_profiles) AS profiles,
      (SELECT count(*)::int FROM cms_categories) AS cms_categories,
      (SELECT count(*)::int FROM series_templates) AS series_templates,
      (SELECT count(*)::int FROM series_template_items) AS series_items,
      (SELECT count(*)::int FROM stock_balances) AS balances,
      (SELECT count(*)::int FROM stock_movements) AS movements`)).rows[0];

    check(await run(['run', '--silent', 'migrate'], { ...upgradeEnv, MIGRATION_STOP_AFTER: '' }) === 0,
      'upgrade applies 069/070 after the populated 068 fixture');
    const upgradedVersions = (await upgradeDb.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((row) => row.version);
    check(upgradedVersions.length === 55 && upgradedVersions.includes('069_catalog_category_authority.sql')
      && upgradedVersions.includes('070_series_commercial_pricing.sql')
      && upgradedVersions.includes('071_wholesale_child_cancellation.sql') && upgradedVersions.includes('072_customer_otp_login.sql')
      && upgradedVersions.includes('073_supplier_oms_lifecycle.sql')
      && upgradedVersions.includes('074_prompt6_inbound_qc_consolidation.sql'),
      'populated upgrade records 069/070/071/072/073/074 exactly once in the 55-file sequence');

    const badProductCategories = Number((await upgradeDb.query(`SELECT count(*)::int AS n FROM products p
      LEFT JOIN cms_categories c ON c.id = p.category_id WHERE c.id IS NULL OR c.name <> p.category`)).rows[0].n);
    const badProfileCategories = Number((await upgradeDb.query(`SELECT count(*)::int AS n FROM category_profiles p
      LEFT JOIN cms_categories c ON c.id = p.category_id WHERE c.id IS NULL OR c.name <> p.category`)).rows[0].n);
    check(badProductCategories === 0 && badProfileCategories === 0,
      '069 backfills every legacy product/profile to a valid canonical category');
    const pairedCategory = (await upgradeDb.query(`SELECT p.category_id AS product_category_id,
      cp.category_id AS profile_category_id,c.name FROM products p
      JOIN category_profiles cp ON cp.category = p.category JOIN cms_categories c ON c.id = p.category_id
      WHERE p.id = $1`, [legacyProductId])).rows[0];
    check(Boolean(pairedCategory) && pairedCategory.product_category_id === pairedCategory.profile_category_id
      && pairedCategory.name === legacyCategory,
      '069 maps the profile-only legacy category and its seeded product to one canonical identity');
    const existingProduct = (await upgradeDb.query('SELECT category_id,category,name,cash_price_rial::text FROM products WHERE name = $1',
      ['Existing CMS product fixture'])).rows[0];
    check(existingProduct?.category_id === existingCmsId && existingProduct.category === 'شلوار'
      && existingProduct.name === 'Existing CMS product fixture' && existingProduct.cash_price_rial === '4200000',
      '069 preserves an existing CMS category ID and keeps its product readable');

    const after069 = (await upgradeDb.query(`SELECT
      (SELECT count(*)::int FROM products) AS products,
      (SELECT count(*)::int FROM product_variants) AS variants,
      (SELECT count(*)::int FROM category_profiles) AS profiles,
      (SELECT count(*)::int FROM cms_categories) AS cms_categories,
      (SELECT count(*)::int FROM series_templates) AS series_templates,
      (SELECT count(*)::int FROM series_template_items) AS series_items,
      (SELECT count(*)::int FROM stock_balances) AS balances,
      (SELECT count(*)::int FROM stock_movements) AS movements`)).rows[0];
    check(Number(after069.products) === Number(before069.products)
      && Number(after069.variants) === Number(before069.variants)
      && Number(after069.profiles) === Number(before069.profiles)
      && Number(after069.series_templates) === Number(before069.series_templates)
      && Number(after069.series_items) === Number(before069.series_items)
      && Number(after069.balances) === Number(before069.balances)
      && Number(after069.movements) === Number(before069.movements)
      && Number(after069.cms_categories) === Number(before069.cms_categories) + 2,
      '069/070 are non-destructive: rows and stock ledgers remain; only two missing categories are added');

    const readableSeed = (await upgradeDb.query(`SELECT p.name,p.category,p.category_id,c.name AS canonical_category,
      p.cash_price_rial::text,p.wholesale_price_rial::text,v.sku
      FROM products p JOIN cms_categories c ON c.id=p.category_id
      JOIN product_variants v ON v.product_id=p.id WHERE p.id=$1`, [legacyProductId])).rows[0];
    check(readableSeed?.name === 'Migration fixture seeded product' && readableSeed.category === legacyCategory
      && readableSeed.canonical_category === legacyCategory && readableSeed.cash_price_rial === '3500000'
      && readableSeed.wholesale_price_rial === '1234567' && readableSeed.sku === legacySku,
      'seeded product, canonical category, prices, variant and SKU remain readable after upgrade');

    const legacyTerms = (await upgradeDb.query(`SELECT t.pricing_mode,t.total_price_rial::text,t.min_order_series,
      p.wholesale_price_rial::text,p.wholesale_moq,
      sum(i.quantity_per_series)::int AS pieces,sum(i.unit_price_rial)::text AS component_price
      FROM series_templates t JOIN products p ON p.id=t.product_id
      JOIN series_template_items i ON i.series_template_id=t.id WHERE t.id=$1
      GROUP BY t.id,p.id`, [legacyTemplateId])).rows[0];
    const legacySeriesPrice = BigInt(legacyTerms?.wholesale_price_rial ?? '0') * BigInt(legacyTerms?.pieces ?? 0);
    const legacySeriesMoq = Math.max(1, Math.ceil(Number(legacyTerms?.wholesale_moq ?? 1) / Number(legacyTerms?.pieces ?? 1)));
    check(legacyTerms?.pricing_mode === 'legacy_product' && legacyTerms.total_price_rial === null
      && Number(legacyTerms.min_order_series) === 1 && legacyTerms.component_price === null
      && legacySeriesPrice === 2469134n && legacySeriesMoq === 3,
      '070 preserves legacy product-based series price and MOQ compatibility', JSON.stringify({ ...legacyTerms, total_price_rial: legacyTerms?.total_price_rial }));
    check(Number((await upgradeDb.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('series_templates','series_template_items') AND column_name IN ('pricing_mode','total_price_rial','min_order_series','unit_price_rial')")).rows[0].n) === 4,
      '070 adds all four explicit commercial pricing columns');
    const totalTemplateId = randomUUID();
    await upgradeDb.query(`INSERT INTO series_templates(id,product_id,name,pricing_mode,total_price_rial,min_order_series)
      VALUES($1,$2,'Series total compatibility fixture','series_total',2468000,2)`, [totalTemplateId, legacyProductId]);
    const explicitTerms = (await upgradeDb.query('SELECT pricing_mode,total_price_rial::text,min_order_series FROM series_templates WHERE id=$1',
      [totalTemplateId])).rows[0];
    check(explicitTerms?.pricing_mode === 'series_total' && explicitTerms.total_price_rial === '2468000'
      && Number(explicitTerms.min_order_series) === 2,
      '070 accepts an explicit series-total price without rewriting legacy templates');

    const sizes = (await upgradeDb.query('SELECT code FROM product_type_sizes WHERE product_type_id=$1 ORDER BY code', [winner])).rows.map((r) => r.code);
    check(sizes.includes('29') && sizes.includes('30') && sizes.includes('32') && sizes.filter((s) => s === '30').length === 1,
      'winner-only, loser-only and duplicate size mappings survive once');
    check(Number((await upgradeDb.query(`SELECT count(*)::int AS count FROM products
      WHERE name IN ('loser product','winner product') AND product_type_id=$1 AND product_type_code='trousers'`, [winner])).rows[0].count) === 2,
      'winner and loser products reference one id/code');
    check(Number((await upgradeDb.query('SELECT count(*)::int AS count FROM product_types WHERE id=$1', [loser])).rows[0].count) === 0,
      'losing product type removed without orphan references');
    check(Number((await upgradeDb.query(`SELECT count(*)::int AS count FROM pg_constraint
      WHERE conrelid='customer_reviews'::regclass AND conname='customer_reviews_product_id_user_id_key'`)).rows[0].count) === 0,
      'old review uniqueness constraint removed');
    const beforeSecond = (await upgradeDb.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows;
    check(await run(['run', '--silent', 'migrate'], upgradeEnv) === 0,
      'upgrade migration second run succeeds');
    const afterSecond = (await upgradeDb.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows;
    check(JSON.stringify(afterSecond) === JSON.stringify(beforeSecond), 'upgrade second run is a no-op');
  } finally {
    await upgradeServer.stop();
    await upgradeDb.close();
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await server.stop();
  await db.close();
}
