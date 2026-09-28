/**
 * Frontend contract smoke — boots the real API against embedded PGlite and drives
 * it with the REAL frontend client (`src/data/api.ts`) plus the REAL frontend
 * payload builders/adapters (`src/data/contracts.ts`).
 *
 * This is not a backend test: every request below goes through the same code path
 * the browser uses (authFetch, single refresh, FormData handling, domain APIs).
 *
 * Run with: npm run test:contract   (inside backend/)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  apiClient, authApi, getAccessToken, setAccessToken, setApiBaseUrl, ticketsApi, productsApi, filesApi,
} from '../../src/data/api.ts';
import {
  TICKET_STATUSES, adaptTicketBoard, buildProductCreatePayload, buildTicketCreatePayload, buildTicketReplyPayload,
  buildTicketUpdatePayload, productVariantSkus, readProductCreateResponse, readFileUploadResponse,
} from '../../src/data/contracts.ts';

/** Pick a free loopback port so a stale server from an earlier run can never hijack the smoke. */
const freePort = async (start: number) => {
  for (let port = start; port < start + 50; port += 1) {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (ok) return port;
  }
  throw new Error(`no free port near ${start}`);
};
const pgPort = await freePort(55441);
const apiPort = await freePort(5098);
const base = `http://127.0.0.1:${apiPort}`;
const adminEmail = 'admin@kolbe.ir';
const adminPassword = 'ChangeMe-Admin-123456';
const suffix = String(Date.now()).slice(-6);

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: pgPort, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const env = {
  ...process.env, NODE_ENV: 'development', REDIS_URL: undefined,
  DATABASE_URL: `postgres://127.0.0.1:${pgPort}/pglite`, TEST_DATABASE_URL: `postgres://127.0.0.1:${pgPort}/pglite`,
  JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PUBLIC_ORIGIN: 'http://127.0.0.1:5173',
  PG_POOL_MAX: '2', PORT: String(apiPort),
};
const run = (command: string, args: string[], extraEnv: Record<string, string | undefined> = {}) =>
  new Promise<number>((resolve) => {
    const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });

let app: ReturnType<typeof spawn> | null = null;
try {
  if (await run('npm', ['run', '--silent', 'migrate']) !== 0) throw new Error('migrations failed');
  if (await run('npx', ['tsx', 'src/bootstrap-admin.ts'], { BOOTSTRAP_ADMIN_EMAIL: adminEmail, BOOTSTRAP_ADMIN_PASSWORD: adminPassword }) !== 0) {
    throw new Error('admin bootstrap failed');
  }
  app = spawn('npx', ['tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log: string[] = [];
  app.stdout?.on('data', (chunk) => log.push(String(chunk)));
  app.stderr?.on('data', (chunk) => log.push(String(chunk)));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const health = await fetch(`${base}/health/ready`);
      if (health.ok) break;
    } catch { /* not up yet */ }
  }

  // The browser client resolves its base from window.location.origin; in Node we inject it.
  setApiBaseUrl(base);

  // ---------- customer session through the real client ----------
  await authApi.register({ email: `smoke-${suffix}@example.test`, password: 'SmokePassword123456!', displayName: 'خریدار اسموک' });
  const session = await authApi.login({ identity: `smoke-${suffix}@example.test`, password: 'SmokePassword123456!' });
  check('authApi.login stores the access token', Boolean(session.accessToken) && getAccessToken() === session.accessToken);

  const me = await authApi.me();
  check('authApi.me (Bearer auto-attached, 401→refresh path armed)', typeof me.id === 'string' && me.roles.includes('customer'));

  const savedPrefs = await authApi.updatePreference('orderUpdates', false);
  const reread = await authApi.me();
  check('authApi.updatePreference round-trips through PostgreSQL',
    savedPrefs.preferences.orderUpdates === false && reread.preferences?.orderUpdates === false);

  // ---------- tickets ----------
  const created = await ticketsApi.create(buildTicketCreatePayload({
    subject: 'اسموک قرارداد رابط کاربری', category: 'پیگیری سفارش', priority: 'normal',
    message: 'این تیکت از payload واقعی فرانت‌اند ساخته شده است.',
  }));
  check('ticketsApi.create (frontend payload) → 201', created.id.length > 0 && /^TK-\d+$/.test(created.reference), created.reference);

  const replied = await ticketsApi.reply(created.id, buildTicketReplyPayload('پاسخ خریدار از کلاینت واقعی'));
  check('ticketsApi.reply (message/internal) → 201', replied.status === 'reviewing', `status=${replied.status}`);

  const attachmentBody = 'frontend contract smoke attachment';
  const blob = new File([Buffer.from(attachmentBody)], 'smoke-attachment.txt', { type: 'text/plain' });
  const attachment = await ticketsApi.attach(created.id, blob, 'smoke-attachment.txt', 'smoke-attachment.txt') as
    { id: string; fileId: string | null; mime: string; size: number; url: string | null };
  check('ticketsApi.attach via FormData → 201 (multipart, no JSON content-type)',
    Boolean(attachment.fileId) && attachment.mime === 'text/plain' && attachment.size === Buffer.byteLength(attachmentBody),
    `fileId=${attachment.fileId ?? 'none'} size=${attachment.size}`);

  const downloaded = await fetch(`${base}${filesApi.downloadPath(attachment.fileId!)}`, { headers: { authorization: `Bearer ${getAccessToken()}` } });
  check('attachment download via /files/:id → 200', downloaded.status === 200 && (await downloaded.text()) === attachmentBody);

  // ---------- admin session (assignee picker + status transitions) ----------
  const adminSession = await authApi.login({ identity: adminEmail, password: adminPassword });
  const agents = await apiClient.get<{ items: { id: string; displayName: string }[] }>('/admin/support-agents');
  check('adminApi.supportAgents returns real users for the assignee picker', adminSession.accessToken.length > 0 && agents.items.length > 0, `${agents.items.length} agent(s)`);

  const updated = await ticketsApi.update(created.id, buildTicketUpdatePayload({
    status: 'reviewing', department: 'پشتیبانی عمومی', assigneeId: agents.items[0]!.id,
  }));
  check('ticketsApi.update (status/department/assigneeId UUID) → 200', updated.status === 'reviewing');

  const board = await ticketsApi.boardMap();
  check('ticketsApi.boardMap consumes { columns } into canonical statuses',
    TICKET_STATUSES.every((status) => Array.isArray(board[status])) && board.reviewing.some((ticket) => ticket.id === created.id));

  // ---------- products ----------
  const mediaFile = new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'smoke-media.png', { type: 'image/png' });
  const uploaded = readFileUploadResponse(await filesApi.upload(mediaFile));
  check('filesApi.upload persists product media server-side', uploaded.mime === 'image/png' && uploaded.size === 8, uploaded.id);

  const payload = buildProductCreatePayload({
    name: 'کت اسموک قرارداد', brand: 'Kolbe', category: 'کت', description: 'ساخته‌شده از payload واقعی ProductStudio',
    editorialSku: '', retailOn: true, wholesaleOn: true,
    cashToman: '4900000', installmentToman: '5100000', compareToman: '5900000',
    colors: [{ name: 'مشکی' }, { name: 'شنی' }], sizes: ['M', 'L', 'XL'],
    images: [{ fileId: uploaded.id, url: filesApi.downloadPath(uploaded.id) }],
    videoFileId: null, fabric: 'پشم', care: 'خشک‌شویی', seoTitle: 'کت اسموک', slug: 'smoke-coat',
    cutout: { status: 'ready', src: 'https://cdn.example.test/cut.png', source: 'n8n' },
    series: [{ name: 'سری اسموک', pieces: 6, moqSeries: 2, pricePerSeries: 3900000, available: true, colorIds: [] }],
    stock: '9',
  });
  const product = readProductCreateResponse(await productsApi.create(payload));
  const skus = productVariantSkus(product);
  check('productsApi.create (ProductStudio payload) → 201 with server SKUs',
    product.variants.length === 6 && skus.every((sku) => sku.startsWith('KV-COAT-')), `${product.variants.length} variants: ${skus[0] ?? '-'}`);

  const status = await productsApi.status(product.id, 'published');
  check('productsApi.status → published', status.status === 'published');

  await productsApi.update(product.id, { metadata: { images: [{ fileId: uploaded.id, url: filesApi.downloadPath(uploaded.id) }], channels: { retail: true, wholesale: true } } });
  const catalog = await apiClient.get<{ items: { id: string; metadata: { images?: { fileId: string }[] } }[] }>('/products');
  const published = catalog.items.find((item) => item.id === product.id);
  check('catalog exposes persisted server file reference (no data URL)',
    published?.metadata.images?.[0]?.fileId === uploaded.id);

  setAccessToken(null);
} catch (error) {
  console.error('SMOKE ERROR:', error instanceof Error ? error.message : error);
  check('frontend contract smoke completed without exceptions', false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 400));
} finally {
  if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* already gone */ } }
  await server.stop();
  await db.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
