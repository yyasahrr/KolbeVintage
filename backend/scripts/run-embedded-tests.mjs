import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.PGLITE_PORT ?? 55432);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: `postgres://127.0.0.1:${port}/pglite`,
  TEST_DATABASE_URL: `postgres://127.0.0.1:${port}/pglite`,
  JWT_SECRET: 'embedded-test-secret-at-least-thirty-two-characters',
  PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
  PG_POOL_MAX: '2',
};

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited ${code}`)));
    child.on('error', reject);
  });
}

try {
  await run(['run', '--silent', 'migrate']);
  const before = await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  const expected = ['001_core.sql','002_notifications.sql','003_sms.sql','004_invoices.sql','005_wallet.sql','006_suppliers.sql','007_plans_marketplace.sql','008_crm_promo.sql','009_integrations.sql','010_cms.sql','011_access_tickets.sql','012_wms_wishlist.sql','013_shipping_returns_files.sql','014_console_domains.sql','015_user_preferences.sql','016_commerce_product.sql','017_specs_sizeguides.sql','018_imports_shipping_rules.sql','025_supplier360.sql','026_invoice_engine.sql','027_finance_operations.sql','035_cms_style_profile_356.sql','036_seo_domain_media_variants.sql','037_cms_audit_round3.sql','045_membership_buyer.sql','046_crm_intelligence.sql','047_automation_tracking.sql','048_reviews_recommendations.sql','049_video_permissions_promo_growth_hardening.sql','050_seo_search_media.sql','050z_product_type_recovery_snapshot.sql','051_product_types_name_dedupe.sql','052_review_purchase_scope.sql','053_product_type_dependents.sql','054_accounting_period_dates.sql','055_wholesale_inventory_promotions.sql','056_manual_sales_product_colors.sql','057_variant_price_override.sql','058_wms_core.sql','059_supplier_requests.sql','060_series_templates.sql','061_promotion_festival_exclusivity.sql'];
  const applied = before.rows.map((row) => row.version);
  if (JSON.stringify(applied) !== JSON.stringify(expected)) throw new Error(`Unexpected migrations: ${applied.join(', ')}`);
  await run(['run', '--silent', 'migrate']);
  const after = await db.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  if (JSON.stringify(after.rows) !== JSON.stringify(before.rows)) throw new Error('Migration runner changed already-applied migration rows on its second run.');
  console.log(`Fresh embedded PostgreSQL: ${applied.length} migrations applied; second run was a no-op.`);
  await run(['test']);
} finally {
  await server.stop();
  await db.close();
}
