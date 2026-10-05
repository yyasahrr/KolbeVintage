/**
 * Frontend ↔ Backend contract tests.
 *
 * These do NOT re-declare payload shapes: they import the *frontend* builders and
 * adapters from `src/data/contracts.ts` and drive the real HTTP API with them.
 * A drift in either side fails here (e.g. `description` vs `message`, `text` vs
 * `message`, `items` vs `columns`, client-generated SKUs, data-URL media).
 *
 * Backend tests alone cannot catch these: the previous suite passed 47/47 while
 * the UI sent payloads the API rejected.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { buildApp } from './app.js';
import { createPool, type DbPool } from './db.js';
import type { FastifyInstance } from 'fastify';

/* ---- The real frontend modules (pure TS, no DOM) ---- */
type TicketCreate = { subject: string; category: string; priority: string; orderId?: string; message: string };
type TicketReply = { message: string; internal: boolean };
type TicketUpdate = { status: string; department?: string; assigneeId?: string | null };
type ProductCreate = {
  brand: string; name: string; category: string; description: string; cashPriceRial: string;
  installmentEnabled?: boolean; installmentPriceRial?: string; wholesalePriceRial?: string;
  variants: { size?: string; color?: string; attributes: Record<string, string> }[];
  metadata: Record<string, unknown>;
};
type Contracts = {
  TICKET_STATUSES: readonly string[];
  buildTicketCreatePayload: (input: { subject: string; category?: string; priority?: string; orderId?: string | null; message: string }) => TicketCreate;
  buildTicketReplyPayload: (message: string, internal?: boolean) => TicketReply;
  buildTicketUpdatePayload: (patch: { status: string; department?: string | null; assigneeId?: string | null }) => TicketUpdate;
  buildProductCreatePayload: (draft: Record<string, unknown>) => ProductCreate;
  buildProductVariants: (colors: string[], sizes: string[]) => { size?: string; color?: string; attributes: Record<string, string> }[];
  readProductCreateResponse: (raw: unknown) => { id: string; status: string; variants: { id: string; sku: string }[] };
  productVariantSkus: (response: { id: string; status: string; variants: { id: string; sku: string }[] }) => string[];
  readFileUploadResponse: (raw: unknown) => { id: string; mime: string; size: number; originalName: string };
  adaptTicketBoard: (raw: unknown) => Record<string, { id: string; status: string; attachments: { id: string; fileId: string | null; url: string | null }[] }[]>;
  emptyTicketBoard: () => Record<string, unknown[]>;
  adaptTicketList: (raw: unknown) => { id: string; status: string; messages: { body: string; internal: boolean }[] }[];
  normalizeTicket: (raw: unknown) => {
    id: string; status: string; messages: { body: string; internal: boolean }[];
    attachments: { id: string; fileId: string | null; url: string | null }[];
  } | null;
};

let contracts: Contracts;
const loadContracts = async () => await import(new URL('../../src/data/contracts.ts', import.meta.url).href) as Contracts;

const config: Config = {
  NODE_ENV: 'test', PORT: 4007, DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  REDIS_URL: undefined, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters',
  PG_POOL_MAX: 2, PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PAYMENT_WEBHOOK_SECRET: undefined, COOKIE_SECURE: 'false',
};

/** Same multipart assembly the browser performs for `FormData`. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; content: Buffer }) {
  const boundary = `----kolbe${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('frontend ↔ backend contracts', { skip: !process.env.TEST_DATABASE_URL }, () => {
  let app: FastifyInstance;
  let pool: DbPool;
  let buyer: Record<string, string>;
  let admin: Record<string, string>;
  let agentId: string;
  const suffix = randomUUID().slice(0, 8);

  before(async () => {
    contracts = await loadContracts();
    app = await buildApp(config);
    pool = createPool(config);

    // Support agent = a real user the admin picker can return as `assigneeId`.
    agentId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [agentId, `agent-${suffix}@example.test`, await argon2.hash('AgentPassword123456!'), 'کارشناس تست']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [agentId, 'support']);

    const adminId = randomUUID();
    await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES ($1,$2,$3,$4)',
      [adminId, `admin-${suffix}@example.test`, await argon2.hash('AdminPassword123456!'), 'مدیر تست']);
    await pool.query('INSERT INTO user_roles(user_id,role_code) VALUES ($1,$2)', [adminId, 'admin']);
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `admin-${suffix}@example.test`, password: 'AdminPassword123456!' } });
    assert.equal(adminLogin.statusCode, 200, adminLogin.body);
    admin = { authorization: `Bearer ${adminLogin.json().accessToken as string}` };

    const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email: `buyer-${suffix}@example.test`, password: 'BuyerPassword123456!', displayName: 'خریدار تست' } });
    assert.equal(registration.statusCode, 201, registration.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { identity: `buyer-${suffix}@example.test`, password: 'BuyerPassword123456!' } });
    assert.equal(login.statusCode, 200, login.body);
    buyer = { authorization: `Bearer ${login.json().accessToken as string}` };
  });

  after(async () => {
    await app.close();
    await pool.end();
  });

  describe('tickets', () => {
    let ticketId = '';
    let attachmentFileId: string | null = null;

    it('frontend ticket-create payload → POST /tickets → 201', async () => {
      const payload = contracts.buildTicketCreatePayload({
        subject: 'پیگیری سفارش از رابط کاربری', category: 'پیگیری سفارش', priority: 'normal',
        message: 'سلام، وضعیت سفارش من را بررسی کنید.',
      });
      assert.deepEqual(Object.keys(payload).sort(), ['category', 'message', 'priority', 'subject']);
      const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: buyer, payload });
      assert.equal(res.statusCode, 201, res.body);
      ticketId = res.json().id as string;
      assert.match(res.json().reference as string, /^TK-\d+$/);
      assert.equal(res.json().status, 'new');
    });

    it('rejects a display order reference where a real order UUID is required', async () => {
      assert.throws(() => contracts.buildTicketCreatePayload({
        subject: 'سفارش اشتباه', message: 'متن کافی برای تست', orderId: 'KV-400123',
      }));
    });

    it('frontend reply payload → POST /tickets/:id/messages → 201', async () => {
      const payload = contracts.buildTicketReplyPayload('پاسخ کارشناس از رابط کاربری', false);
      assert.deepEqual(payload, { message: 'پاسخ کارشناس از رابط کاربری', internal: false });
      const res = await app.inject({ method: 'POST', url: `/api/v1/tickets/${ticketId}/messages`, headers: admin, payload });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().status, 'answered');
    });

    it('admin internal note → internal: true', async () => {
      const res = await app.inject({ method: 'POST', url: `/api/v1/tickets/${ticketId}/messages`, headers: admin,
        payload: contracts.buildTicketReplyPayload('یادداشت داخلی پشتیبانی', true) });
      assert.equal(res.statusCode, 201, res.body);
    });

    it('frontend patch payload (status + real assignee UUID) → PATCH /tickets/:id → 200', async () => {
      const agents = await app.inject({ method: 'GET', url: '/api/v1/admin/support-agents', headers: admin });
      assert.equal(agents.statusCode, 200, agents.body);
      const picked = (agents.json().items as { id: string }[]).find((item) => item.id === agentId);
      assert.ok(picked, 'support agent must be listed for the admin picker');
      const res = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticketId}`, headers: admin,
        payload: contracts.buildTicketUpdatePayload({ status: 'reviewing', department: 'پشتیبانی عمومی', assigneeId: picked.id }) });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().status, 'reviewing');
    });

    it('board response → frontend adapter → canonical columns', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/tickets/board', headers: admin });
      assert.equal(res.statusCode, 200, res.body);
      const columns = contracts.adaptTicketBoard(res.json());
      assert.deepEqual(Object.keys(columns).sort(), [...contracts.TICKET_STATUSES].sort());
      assert.equal(columns.reviewing?.some((ticket) => ticket.id === ticketId), true);
    });

    it('frontend attachment FormData → multipart → 201 with canonical attachment shape', async () => {
      const body = multipart({ title: 'contract-test.txt' },
        { name: 'contract-test.txt', type: 'text/plain', content: Buffer.from('kolbe contract multipart body') });
      const res = await app.inject({ method: 'POST', url: `/api/v1/tickets/${ticketId}/attachments`, headers: { ...buyer, 'content-type': body.contentType }, payload: body.payload });
      assert.equal(res.statusCode, 201, res.body);
      const attachment = res.json() as { id: string; ticketId: string; fileId: string | null; mime: string; size: number; createdAt: string; url: string | null };
      assert.equal(attachment.ticketId, ticketId);
      assert.equal(attachment.mime, 'text/plain');
      assert.equal(attachment.size, 29);
      assert.ok(attachment.fileId, 'attachment must carry the server file id');
      assert.equal(attachment.url, `/api/v1/files/${attachment.fileId}`);
      attachmentFileId = attachment.fileId;
    });

    it('GET /tickets/:id returns the same normalized attachments (no data URLs)', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: buyer });
      assert.equal(res.statusCode, 200, res.body);
      const ticket = contracts.normalizeTicket(res.json());
      assert.ok(ticket);
      assert.equal(ticket.status, 'reviewing');
      assert.equal(ticket.attachments.length, 1);
      assert.equal(ticket.attachments[0]?.fileId, attachmentFileId);
      assert.match(ticket.attachments[0]?.url ?? '', /^\/api\/v1\/files\//);
      assert.equal(ticket.messages.some((message) => message.internal), false, 'customer must not see internal notes');
      assert.equal(ticket.messages.some((message) => message.body.includes('پاسخ کارشناس')), true);
    });

    it('GET /tickets list → frontend list adapter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: buyer });
      assert.equal(res.statusCode, 200, res.body);
      const tickets = contracts.adaptTicketList(res.json());
      assert.equal(tickets.some((ticket) => ticket.id === ticketId), true);
    });

    it('attachment download → GET /files/:id → 200', async () => {
      assert.ok(attachmentFileId);
      const res = await app.inject({ method: 'GET', url: `/api/v1/files/${attachmentFileId}`, headers: buyer });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['content-type'], 'text/plain');
      assert.equal(res.body, 'kolbe contract multipart body');
    });
  });

  describe('account preferences', () => {
    it('PATCH /auth/me/preferences persists allowlisted keys and rejects unknown ones', async () => {
      const saved = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me/preferences', headers: buyer, payload: { orderUpdates: false, sms: true } });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().preferences.orderUpdates, false);
      assert.equal(saved.json().preferences.sms, true);
      const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: buyer });
      assert.equal(me.json().preferences.orderUpdates, false);
      const rejected = await app.inject({ method: 'PATCH', url: '/api/v1/auth/me/preferences', headers: buyer, payload: { notARealKey: true } });
      assert.equal(rejected.statusCode, 400, rejected.body);
    });
  });

  describe('products', () => {
    it('ProductStudio payload builder → POST /products → 201 with server SKUs', async () => {
      const payload = contracts.buildProductCreatePayload({
        name: 'کت قرارداد تست', brand: 'Kolbe', category: 'کت', description: 'توضیح قرارداد',
        editorialSku: '', retailOn: true, wholesaleOn: true,
        cashToman: '5000000', installmentToman: '5200000', compareToman: '6000000',
        colors: [{ name: 'مشکی' }, { name: 'شنی' }], sizes: ['M', 'L'],
        images: [{ fileId: null, url: 'https://cdn.example.test/coat.jpg' }],
        fabric: 'پشم', care: 'خشک‌شویی', seoTitle: 'کت تست', slug: 'coat-test',
        cutout: { status: 'ready', src: 'https://cdn.example.test/cut.png', source: 'n8n' },
        series: [{ name: 'سری پاییز', pieces: 6, moqSeries: 2, pricePerSeries: 4000000, available: true, colorIds: ['مشکی'] }],
        stock: '12',
      });
      assert.deepEqual(Object.keys(payload).sort(),
        ['brand', 'cashPriceRial', 'category', 'description', 'installmentEnabled', 'installmentPriceRial', 'metadata', 'name', 'variants', 'wholesalePriceRial']);
      assert.equal(payload.cashPriceRial, '50000000');
      assert.equal(payload.installmentPriceRial, '52000000');
      assert.equal(payload.installmentEnabled, true, 'the payload states the canonical four-installment enable flag');
      assert.equal('compareAtPriceRial' in payload, false, 'a manual crossed-out price is not a pricing authority any more');
      assert.equal(payload.wholesalePriceRial, '40000000');
      assert.equal('sku' in payload, false, 'the client must never send a SKU');

      const res = await app.inject({ method: 'POST', url: '/api/v1/products', headers: admin, payload });
      assert.equal(res.statusCode, 201, res.body);
      const created = contracts.readProductCreateResponse(res.json());
      assert.equal(created.variants.length, 4, 'variants = colors × sizes');
      const skus = contracts.productVariantSkus(created);
      assert.equal(skus.length, 4);
      assert.ok(skus.every((sku) => sku.startsWith('KV-COAT-')), `server SKUs expected, got ${skus.join(',')}`);
      assert.equal((res.json() as { sku?: string }).sku, undefined, 'response has no top-level sku field');
      (globalThis as { __contractProductId?: string }).__contractProductId = created.id;
    });

    it('variant matrix matches colors × sizes exactly', async () => {
      const variants = contracts.buildProductVariants(['مشکی', 'شنی'], ['M', 'L']);
      assert.deepEqual(variants, [
        { size: 'M', color: 'مشکی', attributes: {} }, { size: 'L', color: 'مشکی', attributes: {} },
        { size: 'M', color: 'شنی', attributes: {} }, { size: 'L', color: 'شنی', attributes: {} },
      ]);
    });

    it('status PATCH → 200 and catalog exposes metadata media references', async () => {
      const upload = multipart({}, { name: 'media.png', type: 'image/png', content: Buffer.from('89504e470d0a1a0a', 'hex') });
      const uploaded = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { ...admin, 'content-type': upload.contentType }, payload: upload.payload });
      assert.equal(uploaded.statusCode, 201, uploaded.body);
      const file = contracts.readFileUploadResponse(uploaded.json());
      assert.equal(file.mime, 'image/png');
      assert.equal(file.size, 8);

      const productId = (globalThis as { __contractProductId?: string }).__contractProductId;
      assert.ok(productId);
      const patched = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}`, headers: admin,
        payload: { metadata: { images: [{ fileId: file.id, url: `/api/v1/files/${file.id}` }], channels: { retail: true } } } });
      assert.equal(patched.statusCode, 200, patched.body);

      const status = await app.inject({ method: 'PATCH', url: `/api/v1/products/${productId}/status`, headers: admin, payload: { status: 'published' } });
      assert.equal(status.statusCode, 200, status.body);

      const catalog = await app.inject({ method: 'GET', url: '/api/v1/products' });
      const item = (catalog.json().items as { id: string; metadata: { images?: { fileId: string }[] }; variants: { sku: string }[] }[])
        .find((row) => row.id === productId);
      assert.ok(item, 'published product must appear in the catalog');
      assert.equal(item.metadata.images?.[0]?.fileId, file.id, 'persisted media must be a server file reference');
      assert.ok(item.variants.every((variant) => variant.sku.startsWith('KV-COAT-')));
    });
  });
});
