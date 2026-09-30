import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPool } from './db.js';
import { loadConfig } from './config.js';

const pool = createPool(loadConfig());
const path = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
try {
  const files = (await readdir(path)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    if (process.env.NODE_ENV === 'test' && process.env.MIGRATION_STOP_AFTER && file > process.env.MIGRATION_STOP_AFTER) break;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (applied.rowCount) { await client.query('COMMIT'); continue; }
      await client.query(await readFile(join(path, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
} finally { await pool.end(); }
