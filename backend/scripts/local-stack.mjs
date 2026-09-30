/* Local development stack for browser verification: embedded PGlite (real PostgreSQL dialect,
   real migrations) + the real API server on a fixed port.

   Nothing here fabricates domain data — an empty database stays empty so the console's real
   empty states can be verified; `npm run seed:local` (NODE_ENV=development) is the only thing
   that inserts sample rows, and it is never automatic.

   Writes /tmp/kv-local-stack.json so other scripts (browser smoke, seed runner) reuse the same
   database instead of booting their own. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const pgPort = Number(process.env.KV_PG_PORT ?? 55449);
const apiPort = Number(process.env.PORT ?? 4000);
const databaseUrl = `postgres://127.0.0.1:${pgPort}/pglite`;

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: pgPort, host: '127.0.0.1', maxConnections: 20 });
await server.start();

const env = {
  ...process.env, NODE_ENV: 'development', REDIS_URL: undefined,
  DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
  JWT_SECRET: process.env.JWT_SECRET ?? 'local-stack-secret-at-least-thirty-two-characters',
  PUBLIC_ORIGIN: 'http://localhost:5173', PG_POOL_MAX: '4', PORT: String(apiPort),
};

const run = (command, args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
});

await run('npm', ['run', '--silent', 'migrate']);
await run('npx', ['tsx', 'src/bootstrap-admin.ts'], {
  BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@kolbe.ir',
  BOOTSTRAP_ADMIN_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'ChangeMe-Admin-123456',
});

const app = spawn('npx', ['tsx', 'src/main.ts'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
writeFileSync(join(tmpdir(), 'kv-local-stack.json'), JSON.stringify({ pgPort, apiPort, databaseUrl }, null, 2));
console.log(`[local-stack] database=${databaseUrl} api=http://127.0.0.1:${apiPort}`);

const shutdown = () => { try { app.kill('SIGTERM'); } catch { /* gone */ } void server.stop().finally(() => process.exit(0)); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
app.on('exit', (code) => { console.log(`[local-stack] api exited ${code}`); void server.stop().finally(() => process.exit(code ?? 0)); });
