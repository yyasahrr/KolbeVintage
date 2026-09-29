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
const run = (args) => new Promise((resolve) => {
  const child = spawn('npm', args, { env, stdio: 'inherit' });
  child.on('exit', (code) => resolve(code ?? 1));
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

  const reserved = names.filter((name) => /^02[5-9]_|^03[0-4]_/.test(name));
  check(reserved.length === 3, 'this branch applied exactly its three reserved-range files', reserved.join(', '));
  check(reserved.join(',') === '025_supplier360.sql,026_invoice_engine.sql,027_finance_operations.sql',
    'reserved-range files applied in 025 → 026 → 027 order');
  check(names.indexOf('015_user_preferences.sql') < names.indexOf('025_supplier360.sql'),
    'reserved range runs after the shared base (015 precedes 025)');
  check(!names.some((name) => /^01[6-9]_|^02[0-4]_/.test(name)),
    'no 016-024 file from another agent is required by this branch');

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

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await server.stop();
  await db.close();
}
