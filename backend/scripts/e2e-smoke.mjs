/* End-to-end smoke against an embedded PGlite-backed API.
   Covers: customer (register/login/profile/wishlist/address), catalog + WMS stock,
   checkout with server-side shipping fee, order list, return with server RT- reference,
   ticket + multipart attachment + file download, admin console (dashboard summary,
   memberships, restrictions, campaigns, CMS, WMS, tickets, returns, wallet, finance, audit),
   cooperation requests and plans. Run with: node scripts/e2e-smoke.mjs */
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
const port = 55440;
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
const env = { ...process.env, REDIS_URL: undefined, NODE_ENV: 'development', DATABASE_URL: `postgres://127.0.0.1:${port}/pglite`, TEST_DATABASE_URL: `postgres://127.0.0.1:${port}/pglite`, JWT_SECRET: 'test-secret-that-is-at-least-thirty-two-characters', PUBLIC_ORIGIN: 'http://127.0.0.1:5173', PG_POOL_MAX: '2', PORT: '5099', REDIS_URL: undefined };
const migrate = spawn('npm', ['run', '--silent', 'migrate'], { env, stdio: 'inherit' });
await new Promise((r) => migrate.on('exit', r));
const bootEnv = { ...env, BOOTSTRAP_ADMIN_EMAIL: 'admin@kolbe.ir', BOOTSTRAP_ADMIN_PASSWORD: 'ChangeMe-Admin-123456' };
const boot = spawn('npx', ['tsx', 'src/bootstrap-admin.ts'], { env: bootEnv, stdio: 'inherit' });
await new Promise((r) => boot.on('exit', r));
const app = spawn('npx', ['tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; app.stdout.on('data', d => log += d); app.stderr.on('data', d => log += d);
await new Promise((r) => setTimeout(r, 3500));
const base = 'http://127.0.0.1:5099/api/v1';
const j = async (path, init = {}) => { const hasBody = typeof init.body === 'string'; const res = await fetch(base + path, { ...init, headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } }); const body = await res.text(); let json = null; try { json = JSON.parse(body); } catch {} return { status: res.status, json }; };
const out = {};
out.health = (await j('/health/live')).status;
out.shipping = (await j('/shipping-methods')).json?.items?.length ?? 0;
const reg = await j('/auth/register', { method: 'POST', body: JSON.stringify({ phone: '09121234567', password: 'Secret-Pass-123', displayName: 'خریدار تست' }) });
out.register = reg.status;
out.registerKeys = Object.keys(reg.json || {});
const loginEarly = await j('/auth/login', { method: 'POST', body: JSON.stringify({ identity: '09121234567', password: 'Secret-Pass-123' }) });
out.loginEarly = loginEarly.status;
const token = reg.json?.accessToken ?? loginEarly.json?.accessToken ?? null;
const H = token ? { authorization: `Bearer ${token}` } : {};
out.me = (await j('/auth/me', { headers: H })).status;
out.profilePatch = (await j('/auth/me', { method: 'PATCH', headers: H, body: JSON.stringify({ displayName: 'خریدار تست ۲' }) })).status;
out.products = (await j('/products')).json?.items?.length ?? 0;
out.wishlist = (await j('/wishlist/collections', { method: 'POST', headers: H, body: JSON.stringify({ title: 'علاقه‌مندی‌ها' }) })).status;
out.address = (await j('/addresses', { method: 'POST', headers: H, body: JSON.stringify({ title: 'خانه', recipient: 'سارا رضایی', phone: '09121234567', province: 'تهران', city: 'تهران', line: 'خیابان ولیعصر، پلاک ۱، واحد ۲', postalCode: '1234567890' }) })).status;
const login = await j('/auth/login', { method: 'POST', body: JSON.stringify({ identity: '09121234567', password: 'Secret-Pass-123' }) });
out.login = login.status;
const admin = await j('/auth/login', { method: 'POST', body: JSON.stringify({ identity: 'admin@kolbe.ir', password: 'ChangeMe-Admin-123456' }) });
out.adminLogin = admin.status;
const AH = admin.json?.accessToken ? { authorization: `Bearer ${admin.json.accessToken}` } : {};
const s1 = await j('/admin/dashboard/summary', { headers: AH }); out.adminSummary = s1.status; out.adminSummaryBody = s1.status === 200 ? s1.json : s1.json;
const mm = await j('/admin/memberships', { headers: AH }); out.adminMemberships = mm.status; if (mm.status >= 400) out.adminMembershipsError = mm.json;
const rr = await j('/admin/restrictions', { headers: AH }); out.adminRestrictions = rr.status; if (rr.status >= 400) out.adminRestrictionsError = rr.json;
out.adminRestrictions = (await j('/admin/restrictions', { headers: AH })).status;
out.adminCampaigns = (await j('/admin/sms-campaigns', { headers: AH })).status;
out.adminCmsPages = (await j('/admin/cms/pages', { headers: AH })).status;
out.adminWms = (await j('/inventory?limit=5', { headers: AH })).status;
out.adminTickets = (await j('/tickets/board', { headers: AH })).status;
out.adminReturns = (await j('/admin/returns', { headers: AH })).status;
out.adminWallet = (await j('/wallet', { headers: H })).status;
out.adminFinance = (await j('/admin/journal', { headers: AH })).status;
const au = await j('/admin/audit-logs', { headers: AH }); out.adminAudit = au.status; if (au.status >= 400) out.adminAuditError = au.json;
out.coopRequests = (await j('/admin/cooperation-requests', { headers: AH })).status;
out.plans = (await j('/plans')).status;
const errs = log.split('\n').filter((l) => l.includes('"level":50'));
if (errs.length) {
  console.log('--- server errors ---');
  for (const line of errs.slice(-8)) {
    try { const o = JSON.parse(line); console.log('*', o.err?.type, '|', o.err?.message, '|', o.req?.url ?? ''); }
    catch { console.log('*', line.slice(0, 200)); }
  }
}

// ---- E2E: product -> order (server shipping fee) -> return -> ticket + file ----
const mkProduct = await j('/products', { method: 'POST', headers: AH, body: JSON.stringify({ brand: 'Kolbe', name: 'کت پشمی تست', category: 'کت', description: '', cashPriceRial: '50000000', installmentPriceRial: '52000000', wholesalePriceRial: '40000000', variants: [{ size: 'M', color: 'navy', attributes: {} }, { size: 'L', color: 'navy', attributes: {} }], metadata: { images: [] } }) });
out.createProduct = mkProduct.status;
out.productSku = mkProduct.json?.variants?.[0]?.sku ?? null;
await j(`/products/${mkProduct.json?.id}/status`, { method: 'PATCH', headers: AH, body: JSON.stringify({ status: 'published' }) });
const variantId = mkProduct.json?.variants?.[0]?.id;
const wh = await j('/warehouses', { method: 'POST', headers: AH, body: JSON.stringify({ code: 'SMOKE_WH', name: 'انبار اسموک' }) });
out.createWarehouse = wh.status;
const warehouseId = wh.json?.id ?? null;
const rcpt = await j('/inventory/receipts', { method: 'POST', headers: { ...AH, 'Idempotency-Key': 'smoke-receipt-0001' }, body: JSON.stringify({ variantId, warehouseId, quantity: 20, reference: 'SMOKE-1' }) });
out.createReceipt = rcpt.status; out.receiptId = rcpt.json?.id ?? null;
if (out.receiptId) { const rrv = await j(`/inventory/receipts/${out.receiptId}/receive`, { method: 'POST', headers: AH }); out.receiveReceipt = rrv.status; out.receiveReceiptError = rrv.json; }
const methods = (await j('/shipping-methods')).json?.items ?? [];
const wms = await j('/inventory/adjustments', { method: 'POST', headers: { ...AH, 'Idempotency-Key': 'smoke-adjust-0001' }, body: JSON.stringify({ variantId, warehouseId, delta: 5, reason: 'اصلاح موجودی اسموک', reference: 'SMOKE-ADJ-1' }) });
const order = await j('/orders', { method: 'POST', headers: { ...H, 'Idempotency-Key': 'smoke-order-0001' }, body: JSON.stringify({ orderType: 'retail', items: [{ variantId, quantity: 1 }], paymentMode: 'cash', shippingMethodId: methods[0]?.id, shippingAddress: { recipient: 'سارا رضایی', phone: '09121234567', province: 'تهران', city: 'تهران', line: 'خیابان ولیعصر، پلاک ۱', postalCode: '1234567890' } }) });
out.createOrder = order.status; if (order.status >= 400) out.createOrderError = order.json;
out.orderShippingRial = order.json?.shippingRial ?? order.json?.order?.shippingRial ?? null;
out.orderTotalRial = order.json?.totalRial ?? order.json?.order?.totalRial ?? null;
out.orderNumber = order.json?.number ?? order.json?.order?.number ?? order.json?.id ?? null;
const orderId = order.json?.id ?? order.json?.order?.id;
out.listOrders = (await j('/orders', { headers: H })).status;
const ret = await j('/returns', { method: 'POST', headers: H, body: JSON.stringify({ orderId, reason: 'اندازه مناسب نبود', resolution: 'refund' }) });
out.createReturn = ret.status; if (ret.status >= 400) out.createReturnError = ret.json;
out.returnReference = ret.json?.reference ?? null;
const board = await j('/tickets/board', { headers: AH });
const tk = await j('/tickets', { method: 'POST', headers: H, body: JSON.stringify({ subject: 'پیگیری سفارش تست', category: 'پیگیری سفارش', priority: 'normal', message: 'سلام، وضعیت سفارش را بررسی کنید' }) });
out.createTicket = tk.status; if (tk.status >= 400) out.createTicketError = tk.json;
const fd = new FormData();
fd.append('file', new Blob([Buffer.from('smoke-file-content')], { type: 'text/plain' }), 'smoke.txt');
fd.append('title', 'smoke.txt');
const up = await fetch(`${base}/tickets/${tk.json?.id}/attachments`, { method: 'POST', headers: H, body: fd });
out.uploadAttachment = up.status;
const upJson = await up.json().catch(() => ({}));
out.fileId = upJson.fileId ?? upJson.id ?? null;
out.shippingMethodId = methods[0]?.id ?? null;
const dl = await fetch(`${base}/files/${out.fileId}`, { headers: H });
out.downloadFile = dl.status;
const admScan = await j('/admin/restrictions', { method: 'POST', headers: AH, body: JSON.stringify({ userId: (await j('/auth/me', { headers: H })).json?.id, scope: 'purchase', reason: 'تست اسموک محدودیت' }) });
out.createRestriction = admScan.status;
const camp = await j('/admin/sms-campaigns', { method: 'POST', headers: AH, body: JSON.stringify({ title: 'کمپین تست', message: 'متن تست کمپین', audience: 'all', activate: true }) });
out.createCampaign = camp.status;
const sendRes = await j(`/admin/sms-campaigns/${camp.json?.id}/send`, { method: 'POST', headers: AH });
out.sendCampaign = sendRes.status; out.sendCampaignStatus = sendRes.json?.status ?? sendRes.json?.reason ?? null; out.sendCampaignBody = sendRes.json;
const rApprove = await j(`/admin/returns/${ret.json?.id}`, { method: 'PATCH', headers: AH, body: JSON.stringify({ status: 'approved', note: 'تأیید در اسموک' }) });
out.adminApproveReturn = rApprove.status;
out.wmsAdjust = wms.status;

console.log(JSON.stringify(out, null, 1));
app.kill('SIGKILL'); await server.stop(); await db.close();
process.exit(0);
