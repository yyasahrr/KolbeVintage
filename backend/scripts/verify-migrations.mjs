/* Fresh-database migration verifier (integration readiness).
 *
 * Boots an empty embedded PostgreSQL, runs the migration runner from zero, prints
 * schema_migrations in apply order, asserts the reserved-range files landed last and
 * that the schema really contains the objects this branch owns. */
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.VERIFY_PG_PORT ?? 55461);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const databaseUrl = `postgres://127.0.0.1:${port}/pglite`;
const env = {
  ...process.env, NODE_ENV: 'test', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
  JWT_SECRET: 'verify-secret-at-least-thirty-two-characters', PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PG_POOL_MAX: '2',
};
const run = (args, overrides = {}) => new Promise((resolve) => {
  const child = spawn('npm', args, { env: { ...env, ...overrides }, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

try {
  const migrated = await run(['run', '--silent', 'migrate']);
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
  const expectedAll = ['001_core.sql','002_notifications.sql','003_sms.sql','004_invoices.sql','005_wallet.sql','006_suppliers.sql','007_plans_marketplace.sql','008_crm_promo.sql','009_integrations.sql','010_cms.sql','011_access_tickets.sql','012_wms_wishlist.sql','013_shipping_returns_files.sql','014_console_domains.sql','015_user_preferences.sql','016_commerce_product.sql','017_specs_sizeguides.sql','018_imports_shipping_rules.sql','025_supplier360.sql','026_invoice_engine.sql','027_finance_operations.sql','035_cms_style_profile_356.sql','036_seo_domain_media_variants.sql','037_cms_audit_round3.sql','045_membership_buyer.sql','046_crm_intelligence.sql','047_automation_tracking.sql','048_reviews_recommendations.sql','049_video_permissions_promo_growth_hardening.sql','050_seo_search_media.sql','050z_product_type_recovery_snapshot.sql','051_product_types_name_dedupe.sql','052_review_purchase_scope.sql','053_product_type_dependents.sql','054_accounting_period_dates.sql','055_wholesale_inventory_promotions.sql','056_manual_sales_product_colors.sql','057_variant_price_override.sql'];
  check(JSON.stringify(names) === JSON.stringify(expectedAll),
    'full merged inventory applied in name order', names.length === expectedAll.length ? '' : `got ${names.length} files`);
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
    check(await run(['run', '--silent', 'migrate'], upgradeEnv) === 0,
      'upgrade applies snapshot, 051, and forward repairs');
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
