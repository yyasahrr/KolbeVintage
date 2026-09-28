import pg, { type PoolClient, type QueryResultRow } from 'pg';
import type { Config } from './config.js';

export type DbClient = Pick<PoolClient, 'query'>;

export function createPool(config: Config) {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'kolbe-api',
  });
  pool.on('error', (error) => console.error('PostgreSQL idle client error', error));
  return pool;
}

export type DbPool = ReturnType<typeof createPool>;

export async function transaction<T>(pool: DbPool, fn: (client: PoolClient) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (attempt < retries && (code === '40001' || code === '40P01')) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function one<T extends QueryResultRow>(db: DbClient, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await db.query<T>(sql, params);
  return result.rows[0] ?? null;
}
