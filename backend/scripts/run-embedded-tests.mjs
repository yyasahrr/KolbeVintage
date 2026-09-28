/* Runs migrations and the test suite against an embedded PGlite server.
   Use when a real PostgreSQL instance is not available (CI, sandboxes). */
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
  JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-that-is-at-least-thirty-two-characters',
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173',
  PG_POOL_MAX: '2',
};

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

try {
  const migrated = await run('npm', ['run', '--silent', 'migrate']);
  if (migrated !== 0) process.exitCode = migrated;
  else process.exitCode = await run('npm', ['run', '--silent', 'test']);
} finally {
  await server.stop();
  await db.close();
}
