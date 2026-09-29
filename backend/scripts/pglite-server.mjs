/* Embedded PostgreSQL (PGlite) over the PG wire protocol.
   Used to run migrations and integration tests in environments without a real server. */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.PGLITE_PORT ?? 55432);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log(`PGlite listening on postgres://127.0.0.1:${port}/pglite`);
process.on('SIGTERM', async () => { await server.stop(); await db.close(); process.exit(0); });
process.on('SIGINT', async () => { await server.stop(); await db.close(); process.exit(0); });
