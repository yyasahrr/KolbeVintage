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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  apiClient, authApi, getAccessToken, setAccessToken, setApiBaseUrl, ticketsApi, productsApi, filesApi,
  omsApi, ordersApi, seriesTemplatesApi, wholesaleOmsApi, AdminApiError,
} from '../../src/data/api.ts';
import {
  TICKET_STATUSES, adaptCmsHero, adaptSitePage, buildProductCreatePayload, buildShippingMethodPayload, buildTicketCreatePayload,
  buildTicketReplyPayload, buildTicketUpdatePayload, productVariantSkus, readCmsBootstrap, readProductCreateResponse,
  readProductInventory, readFileUploadResponse, normalizeShippingMethods, normalizeStockBalances, normalizeWarehouses,
  COUPON_SOURCE_LABEL, COUPON_TYPE_LABEL, INTEGRATION_CATEGORY_LABEL, INTEGRATION_STATUS_LABEL, PALETTE_COLOR_LABEL,
  PALETTE_MODE_LABEL, PROMO_AUDIENCE_LABEL, SHIPPING_TYPE_LABEL, WMS_LABEL, labelOf, variantKey, variantMatrix,
} from '../../src/data/contracts.ts';
import {
  addDaysIso, formatPersianDate, formatPersianDateTime, isoDateOnly, isoToPersianInput, persianInputToIso,
  todayDateOnly, todayIso,
} from '../../src/data/persian-date.ts';
import { adjustmentPreview, pendingForRows } from '../../src/data/warehouse-ux.ts';
import { fmtRial, fmtToman, rialFromToman, tomanFromRial } from '../../src/data/contracts.ts';
import {
  cmsApi, financeApi, financeOpsApi, integrationsApi, inventoryApi, invoiceDocsApi, manualOrdersApi, promoApi,
  shippingApi, supplier360Api, crmApi, crmIntelApi, buyersApi,
} from '../../src/data/api.ts';

/** Pick a free loopback port so a stale server from an earlier run can never hijack the smoke. */
const freePort = async (start: number) => {
  for (let port = start; port < start + 50; port += 1) {
    // On Windows a loopback bind can succeed beside a wildcard listener; reject live ports first.
    const listening = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.setTimeout(500);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (listening) continue;
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
    const child = spawn(command, args, { env: { ...env, ...extraEnv }, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });

let app: ReturnType<typeof spawn> | null = null;
const log: string[] = [];
try {
  if (await run('npm', ['run', '--silent', 'migrate']) !== 0) throw new Error('migrations failed');
  if (await run('npx', ['tsx', 'src/bootstrap-admin.ts'], { BOOTSTRAP_ADMIN_EMAIL: adminEmail, BOOTSTRAP_ADMIN_PASSWORD: adminPassword }) !== 0) {
    throw new Error('admin bootstrap failed');
  }
  app = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  app.stdout?.on('data', (chunk) => log.push(String(chunk)));
  app.stderr?.on('data', (chunk) => log.push(String(chunk)));
  let ready = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const health = await fetch(`${base}/health/ready`);
      if (health.ok) { ready = true; break; }
    } catch { /* not up yet */ }
  }

  if (!ready) throw new Error(`API did not become ready: ${log.join("").slice(-2000)}`);

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

  // =========================== admin reconciliation ===========================
  // Exercised through the same client/payload code the admin console uses, on a database that has
  // never been seeded — so first-run (empty → real record) behaviour is what gets tested.

  // ---------- (30) Jalali round trip through the single central utility ----------
  const isoFromJalali = persianInputToIso('۱۴۰۵/۰۷/۱۳');
  check('persianInputToIso(«۱۴۰۵/۰۷/۱۳») → local 2026-10-05 (central Jalali utility)',
    isoFromJalali !== null && isoDateOnly(isoFromJalali) === '2026-10-05', String(isoFromJalali));
  check('Jalali round trip ISO → ۱۴۰۵/۰۷/۱۳ → ISO is stable',
    isoToPersianInput(isoFromJalali) === '۱۴۰۵/۰۷/۱۳' && persianInputToIso(isoToPersianInput(isoFromJalali)!) === isoFromJalali);
  const localFixtureTime = new Date('2026-09-29T10:30:00.000Z');
  const expectedLocalTime = `${String(localFixtureTime.getHours()).padStart(2, '0')}:${String(localFixtureTime.getMinutes()).padStart(2, '0')}`
    .replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]!);
  check('formatPersianDateTime renders Persian digits + local time for table rows',
    /^[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/.test(formatPersianDateTime('2026-09-29T10:30:00.000Z')) &&
    formatPersianDateTime('2026-09-29T10:30:00.000Z').includes(expectedLocalTime),
    formatPersianDateTime('2026-09-29T10:30:00.000Z'));
  check('todayIso/addDaysIso stay ISO internally (no Jalali strings in payloads)',
    /^\d{4}-\d{2}-\d{2}T/.test(todayIso()) && addDaysIso(todayIso(), 7) > todayIso());

  // ---------- (2/4/27) shipping: real methods, real payload, real disable ----------
  const shippingInput = buildShippingMethodPayload({
    code: `smoke-ship-${suffix}`, name: 'ارسال استاندارد اسموک', type: 'standard',
    baseFeeRial: '450000', freeAboveRial: '50000000', estimatedMinDays: 2, estimatedMaxDays: 4, active: true,
  });
  const createdMethod = await shippingApi.create(shippingInput) as { id: string };
  const afterCreate = normalizeShippingMethods(await shippingApi.adminList());
  const createdRow = afterCreate.find((method) => method.id === createdMethod.id);
  check('shippingApi.create (canonical payload) → row with code/type/baseFee/freeAbove/eta',
    createdRow?.code === `smoke-ship-${suffix}` && createdRow.type === 'standard' &&
    createdRow.baseFeeRial === '450000' && createdRow.estimatedMinDays === 2 && createdRow.estimatedMaxDays === 4,
    createdRow ? `${createdRow.code} ${createdRow.type} ${createdRow.baseFeeRial}` : 'missing');

  const editedMethod = await shippingApi.update(createdMethod.id, { baseFeeRial: '520000', estimatedMaxDays: 6 });
  check('shippingApi.update (edit from the drawer) persists fee + eta',
    (editedMethod as { base_fee_rial?: string }).base_fee_rial === '520000' || (editedMethod as { baseFeeRial?: string }).baseFeeRial === '520000');
  await shippingApi.remove(createdMethod.id);
  const afterDisable = normalizeShippingMethods(await shippingApi.adminList()).find((method) => method.id === createdMethod.id);
  check('shippingApi.remove → soft-disabled (active=false) and still listed', afterDisable?.active === false);
  check('shipping label maps are Persian while API values stay English',
    SHIPPING_TYPE_LABEL.standard === 'استاندارد' && SHIPPING_TYPE_LABEL.pickup === 'تحویل حضوری' && createdRow?.type === 'standard');
  check('shipping settings default warehouse is a real warehouse UUID (no hardcoded warehouse)',
    typeof (await shippingApi.settings()).defaultWarehouseId !== 'undefined');

  // ---------- (5/6/28) WMS first run on an empty database ----------
  const beforeWarehouses = normalizeWarehouses(await inventoryApi.warehouses());
  check('WMS starts empty on a fresh database (no fabricated warehouses)', beforeWarehouses.length === 0);
  const warehouse = await inventoryApi.createWarehouse({ code: `KV-${suffix}`, name: 'انبار مرکزی اسموک' });
  const warehouses = normalizeWarehouses(await inventoryApi.warehouses());
  const createdWarehouse = warehouses.find((row) => row.id === warehouse.id);
  check('WMS «ایجاد اولین انبار» really POSTs /warehouses and reloads it',
    Boolean(createdWarehouse) && createdWarehouse?.code === `KV-${suffix}`, createdWarehouse?.code);
  await inventoryApi.createLocation(warehouse.id, { code: `A-${suffix.slice(-3)}`, name: 'قفسه A' });
  const detail = await inventoryApi.warehouseDetail(warehouse.id);
  check('WMS location is stored inside the warehouse', (detail.locations ?? []).length === 1);
  check('WMS Persian labels replace the English leftovers',
    WMS_LABEL.onHand === 'موجودی فیزیکی' && WMS_LABEL.incoming === 'در راه' && WMS_LABEL.movementHistory === 'تاریخچه گردش' &&
    WMS_LABEL.from === 'مبدأ' && WMS_LABEL.to === 'مقصد' && WMS_LABEL.reference === 'شماره مرجع' && WMS_LABEL.reason === 'علت');

  // ---------- (7/8/9/29) product → variants → per-variant receipt → real balances ----------
  const wmsPayload = buildProductCreatePayload({
    name: 'پیراهن اسموک انبار', brand: 'Kolbe', category: 'پیراهن', description: 'تست اتصال محصول و انبار',
    editorialSku: '', retailOn: true, wholesaleOn: true,
    cashToman: '1850000', installmentToman: '1950000', compareToman: '2100000',
    colors: [{ name: 'مشکی' }, { name: 'شنی' }], sizes: ['M', 'L'],
    images: [{ fileId: uploaded.id, url: filesApi.downloadPath(uploaded.id) }], videoFileId: null,
    fabric: 'نخ', care: 'شست‌وشوی ملایم', seoTitle: 'اسموک انبار', slug: `wms-smoke-${suffix}`,
    cutout: null, series: [],
  });
  const wmsProduct = readProductCreateResponse(await productsApi.create(wmsPayload));
  check('product create → 4 variants for 2 colours × 2 sizes (SKUs from the server)',
    wmsProduct.variants.length === 4 && wmsProduct.variants.every((variant) => variant.sku.length > 0),
    wmsProduct.variants.map((variant) => variant.sku).join(' · '));

  const matrix = variantMatrix(['مشکی', 'شنی'], ['M', 'L']);
  const quantities: Record<string, number> = { [variantKey('مشکی', 'M')]: 5, [variantKey('مشکی', 'L')]: 3, [variantKey('شنی', 'M')]: 2, [variantKey('شنی', 'L')]: 7 };
  let receipted = 0;
  for (const variant of wmsProduct.variants) {
    const quantity = quantities[variantKey(variant.color, variant.size)] ?? 0;
    if (quantity < 1) continue;
    const receipt = await inventoryApi.receipt({ warehouseId: warehouse.id, variantId: variant.id, quantity, reference: `SMOKE-${variant.sku}` }, `smoke-${variant.id}`) as { id: string };
    await inventoryApi.receiveReceipt(receipt.id);
    receipted += 1;
  }
  check('per-variant initial stock → real receipt + receive for every variant cell',
    receipted === matrix.length && receipted === 4, `${receipted} receipts`);

  const balances = normalizeStockBalances(await inventoryApi.balances({ warehouseId: warehouse.id, productId: wmsProduct.id }));
  const availableByVariant = new Map(balances.map((row) => [row.variantId, row.available]));
  check('WMS balances equal the entered quantities (available = on_hand − reserved − damaged)',
    wmsProduct.variants.every((variant) => availableByVariant.get(variant.id) === quantities[variantKey(variant.color, variant.size)]) &&
    balances.every((row) => row.available === row.onHand - row.reserved - row.damaged),
    balances.map((row) => `${row.sku}:${row.available}`).join(' · '));

  await productsApi.status(wmsProduct.id, 'published');
  const productInventory = readProductInventory(await inventoryApi.productInventory(wmsProduct.id));
  check('GET /admin/products/:id/inventory is the read-only ProductStudio source',
    productInventory.variants.length === 4 && productInventory.items.length >= 1 && productInventory.totals.available === 17,
    `available=${productInventory.totals.available}`);

  const catalogAfter = await productsApi.list({ limit: '100' }) as { items: { id: string; variants?: { id: string; available?: number }[] }[] };
  const catalogRow = (catalogAfter.items ?? []).find((item) => item.id === wmsProduct.id);
  const catalogVariants = catalogRow?.variants ?? [];
  check('catalogue availability is served from WMS (available/reserved/incoming/damaged)',
    catalogVariants.length === 4 && catalogVariants.every((variant) => availableByVariant.get(variant.id) === variant.available),
    catalogVariants.map((variant) => String(variant.available)).join(' · '));

  await inventoryApi.adjust({ warehouseId: warehouse.id, variantId: wmsProduct.variants[0]!.id, delta: -1, reason: 'اصلاح اسموک', reference: `ADJ-${suffix}` }, `smoke-adj-${suffix}`);
  const afterAdjust = readProductInventory(await inventoryApi.productInventory(wmsProduct.id));
  check('stock changes only through WMS adjustment (no PATCH product stock)',
    afterAdjust.totals.available === 16, `available=${afterAdjust.totals.available}`);

  // Warehouse UX: use the real frontend helper and client against the existing receipt ledger.
  const uxVariant = wmsProduct.variants[0]!.id;
  const uxRow = { variant_id: uxVariant, warehouse_id: warehouse.id, inventory_domain: 'retail' };
  const increase = adjustmentPreview({ on_hand: 12, reserved: 2, damaged: 1 }, 'increase', '3');
  const decrease = adjustmentPreview({ on_hand: 12, reserved: 2, damaged: 1 }, 'decrease', '3');
  check('structured adjustment calculates signed delta and preview', increase.delta === 3 && increase.next === 15 && decrease.delta === -3 && decrease.next === 9);
  check('adjustment rejects zero, signed, fractional and nonnumeric quantities', ['0', '-3', '+3', '1.5', 'abc', ''].every((value) => !adjustmentPreview({ on_hand: 12, reserved: 0, damaged: 0 }, 'increase', value).valid));
  check('adjustment preview protects reserved and damaged stock', !adjustmentPreview({ on_hand: 12, reserved: 8, damaged: 2 }, 'decrease', '3').valid);
  const pendingA = await inventoryApi.receipt({ warehouseId: warehouse.id, variantId: uxVariant, inventoryDomain: 'retail', quantity: 5, batchReference: 'CTN-UX-A' }, `ux-a-${suffix}`) as { id: string };
  const pendingB = await inventoryApi.receipt({ warehouseId: warehouse.id, variantId: uxVariant, inventoryDomain: 'retail', quantity: 3, batchReference: 'CTN-UX-B' }, `ux-b-${suffix}`) as { id: string };
  type Pending = { id: string; variant_id: string; warehouse_id: string; inventory_domain: string; status: string };
  const pendingList = (await inventoryApi.pendingReceipts({ variantId: uxVariant, warehouseId: warehouse.id, inventoryDomain: 'retail' })).items as Pending[];
  check('pending receipt lookup matches variant, warehouse, domain and status', pendingList.length === 2 && pendingForRows(pendingList, [uxRow]).length === 2 && pendingForRows(pendingList, [{ ...uxRow, inventory_domain: 'wholesale' }]).length === 0 && pendingForRows(pendingList, [{ ...uxRow, warehouse_id: 'other' }]).length === 0 && pendingForRows(pendingList, [{ ...uxRow, variant_id: 'other' }]).length === 0);
  const uxBefore = readProductInventory(await inventoryApi.productInventory(wmsProduct.id));
  await inventoryApi.receiveReceipt(pendingA.id, { receivedQuantity: 4 });
  const uxAfter = readProductInventory(await inventoryApi.productInventory(wmsProduct.id));
  check('receive uses existing ledger: on-hand increases by actual, incoming clears expected', uxAfter.items.reduce((sum, row) => sum + row.onHand, 0) === uxBefore.items.reduce((sum, row) => sum + row.onHand, 0) + 4 && uxAfter.totals.incoming === uxBefore.totals.incoming - 5);
  const remainingReceipts = (await inventoryApi.pendingReceipts({ variantId: uxVariant, warehouseId: warehouse.id, inventoryDomain: 'retail' })).items as Pending[];
  check('receiving one independent receipt leaves the other pending', remainingReceipts.length === 1 && remainingReceipts[0]!.id === pendingB.id);
  await inventoryApi.receiveReceipt(pendingB.id, { receivedQuantity: 3 });
  check('pending receipts disappear after final receive', (await inventoryApi.pendingReceipts({ variantId: uxVariant, warehouseId: warehouse.id, inventoryDomain: 'retail' })).items.length === 0);

  // ---------- (11/12/30) promo: Jalali input → ISO → reload → same Jalali ----------
  const couponExpiry = addDaysIso(todayIso(), 7);
  const couponExpiryJalali = isoToPersianInput(couponExpiry);
  const coupon = await promoApi.createCoupon({
    code: `SMOKE${suffix.slice(-4)}`, campaignName: `کمپین اسموک ${suffix}`,
    type: 'percent', value: '15', minOrderRial: '0', audience: ['customer'],
    scope: { productIds: [], categories: [] }, startsAt: todayIso(), endsAt: couponExpiry,
  }) as { id: string };
  const couponList = await promoApi.coupons() as { items: { id: string; code: string; type: string; source: string; ends_at: string }[] };
  const couponRow = couponList.items.find((row) => row.id === coupon.id);
  check('promo coupon Jalali round trip: future ISO expiry → reload → same Jalali',
    Boolean(couponRow) && formatPersianDate(couponRow!.ends_at) === couponExpiryJalali,
    couponRow ? `${formatPersianDate(couponRow.ends_at)} (expected ${couponExpiryJalali})` : 'missing');
  check('promo label maps are Persian while coupon type/source values stay English',
    COUPON_TYPE_LABEL.percent === 'درصدی' && COUPON_TYPE_LABEL.fixed === 'مبلغ ثابت' &&
    COUPON_SOURCE_LABEL.manual === 'دستی' && PROMO_AUDIENCE_LABEL.wholesale === 'عمده' && couponRow?.type === 'percent');

  const festival = await promoApi.createFestival({
    code: `smoke-fest-${suffix}`, name: 'جشنواره اسموک', startsAt: todayIso(), endsAt: addDaysIso(todayIso(), 7),
    discountPercent: 15, audience: ['customer'], scope: { productIds: [], categories: [] },
  }) as { id: string };
  const festivals = await promoApi.festivals() as { items: { id: string; name: string; starts_at: string }[] };
  const festivalRow = festivals.items.find((row) => row.id === festival.id);
  check('festival stores ISO timestamps and renders Jalali in the console table',
    Boolean(festivalRow) && /^\d{4}-\d{2}-\d{2}T/.test(festivalRow!.starts_at) && /^[۰-۹]{4}\//.test(formatPersianDate(festivalRow!.starts_at)));

  // ---------- (14/15/16/31) CMS bootstrap on a database with no home page ----------
  const pagesBefore = await cmsApi.pages() as { items: unknown[] };
  check('CMS starts with no home page on a fresh database', pagesBefore.items.length === 0);
  const bootstrap = readCmsBootstrap(await cmsApi.bootstrap());
  check('POST /admin/cms/bootstrap → home page + hero + base sections + palette',
    bootstrap.pageCreated === true && bootstrap.sectionsCreated >= 3 && bootstrap.hero !== null && bootstrap.paletteActivated === true,
    `page=${bootstrap.pageId} sections=${bootstrap.sectionsCreated} palette=${bootstrap.paletteId}`);

  const bootstrapAgain = readCmsBootstrap(await cmsApi.bootstrap());
  check('CMS bootstrap is idempotent (second call creates nothing new)',
    bootstrapAgain.pageId === bootstrap.pageId && bootstrapAgain.sectionsCreated === 0 && bootstrapAgain.pageCreated === false);

  // Public storefront route (same URL the retail app calls through cmsApi.sitePage).
  const sitePage = await fetch(`${base}/api/v1/site/pages/home`);
  const sitePageBody = await sitePage.json() as { sections?: { component_code: string; payload: Record<string, unknown> }[]; hero?: unknown };
  check('GET /site/pages/home → 200 after bootstrap', sitePage.status === 200, `status=${sitePage.status}`);
  const adaptedPage = adaptSitePage(sitePageBody)!;
  const adaptedHero = adaptCmsHero(adaptedPage.sections.find((section) => section.component_code === 'hero') ?? null);
  check('storefront hero is rendered from the server CMS section (not local state)',
    adaptedHero !== null && typeof adaptedHero.title === 'string' && (adaptedHero.title as string).length > 0 && adaptedHero.visible === true,
    String(adaptedHero?.title));
  const defaultPalette = await cmsApi.defaultPalette();
  check('default palette «پالت اصلی کلبه» is idempotent and keeps 6 canonical colours',
    defaultPalette.created === false && Object.keys((defaultPalette.palette as { colors: object }).colors).length === 6,
    Object.keys((defaultPalette.palette as { colors: object }).colors).join(','));
  check('palette label maps are Persian while modes stay manual/scheduled/festival',
    PALETTE_MODE_LABEL.manual === 'دستی' && PALETTE_MODE_LABEL.scheduled === 'زمان‌بندی‌شده' &&
    PALETTE_MODE_LABEL.festival === 'جشنواره' && PALETTE_COLOR_LABEL.primary === 'رنگ اصلی' && PALETTE_COLOR_LABEL.surface === 'سطح');

  // ---------- (18/20-24) ledger + integrations surfaces ----------
  const journal = await financeApi.journal({ limit: '5' }) as { items: unknown[] };
  check('ledger is empty on an unseeded database (empty state, no fabricated entries)', Array.isArray(journal.items) && journal.items.length === 0);
  const integrations = await integrationsApi.list();
  check('integrations list is empty and normalized without any demo secret',
    integrations.items.length === 0);
  check('integration label maps are Persian while values stay English',
    INTEGRATION_CATEGORY_LABEL.payment === 'پرداخت' && INTEGRATION_CATEGORY_LABEL.crm === 'مدیریت ارتباط با مشتری' &&
    INTEGRATION_STATUS_LABEL.not_configured === 'پیکربندی نشده' && INTEGRATION_STATUS_LABEL.connected === 'متصل' && labelOf(INTEGRATION_STATUS_LABEL, 'error') === 'خطا');

  // ---------- (144-172) financial operations surface used by the console ----------
  const summary = await financeOpsApi.summary({ compare: 'previous' });
  check('financeOpsApi.summary returns ledger metrics + a comparison window',
    typeof summary.metrics.revenue === 'string' && typeof summary.metrics.payable_balance === 'string' && summary.comparison !== null);
  const analytics = await financeOpsApi.analytics({ dimension: 'channel', bucket: 'day' });
  check('financeOpsApi.analytics groups real journal lines by analytic dimension',
    Array.isArray(analytics.series) && Array.isArray(analytics.breakdown));
  const aging = await financeOpsApi.aging('payable');
  check('financeOpsApi.aging exposes the six A/P buckets',
    aging.payable.buckets.length === 6 && typeof aging.payable.totals.not_due === 'string');
  const accounts = await financeOpsApi.suppliers({ limit: '10' });
  check('financeOpsApi.suppliers starts empty on an unseeded database', accounts.items.length === 0);
  const settlementList = await financeOpsApi.settlements({ limit: '10' });
  check('financeOpsApi.settlements starts empty (no fabricated settlements)', settlementList.items.length === 0);
  const reportCatalog = await financeOpsApi.reports();
  const codes = reportCatalog.items.map((item) => item.code);
  check('report centre lists ledger/aging/settlement reports',
    codes.includes('ledger_balances') && codes.includes('payables_aging') && codes.includes('settlements'), codes.join(','));
  const reportRange = { from: isoDateOnly(addDaysIso(todayIso(), -30)), to: todayDateOnly() };
  const ledgerReport = await financeOpsApi.runReport('ledger_balances', reportRange);
  check('report run returns rows + totals and declares money columns',
    ledgerReport.columns.some((column) => column.kind === 'money') && ledgerReport.rows.length > 0 && Array.isArray(ledgerReport.rows));
  const csvUrl = await financeOpsApi.exportReport('ledger_balances', 'csv', reportRange);
  check('CSV export streams through the bearer-authenticated blob URL', csvUrl.startsWith('blob:'));
  const periods = await financeOpsApi.periods();
  check('accounting periods endpoint answers with an array (open/closed/locked)', Array.isArray(periods.items));
  const targets = await financeOpsApi.targets();
  check('monthly target endpoint reports actual sales for the requested month',
    typeof targets.actualRial === 'string' && typeof targets.month === 'string');
  const supplier360 = await supplier360Api.list();
  check('supplier360Api.list drives the 360° console panel', Array.isArray(supplier360.items));
  const templates = await invoiceDocsApi.templates();
  check('invoiceDocsApi.templates drives the document/template panel', Array.isArray(templates.items));
  check('date-only helper keeps the local day (never slices the ISO instant)',
    /^\d{4}-\d{2}-\d{2}$/.test(todayDateOnly()) && todayDateOnly() === isoDateOnly(todayIso()));
  check('rial ⇄ toman display helpers are bigint-safe and grouped',
    fmtToman('1234567890') === '۱۲۳٬۴۵۶٬۷۸۹ تومان' && fmtToman('-500000') === '−۵۰٬۰۰۰ تومان' &&
    fmtRial('1234567890') === '۱٬۲۳۴٬۵۶۷٬۸۹۰ ریال' && tomanFromRial('1234567890') === 123456789 &&
    rialFromToman(123456789) === '1234567890' && fmtToman('5') === '۰٫۵ تومان' && fmtToman(null) === '—');

  // =================== VIP series: server-backed list + real POST /orders checkout ===================
  // Same client code the VIP marketplace uses (seriesTemplatesApi.vipList / ordersApi.create).
  const seriesProduct = await productsApi.create({
    brand: 'Kolbe', name: `کتانی سری اسموک ${suffix}`, category: 'کفش',
    cashPriceRial: '6000000', wholesalePriceRial: '3500000',
    variants: [{ size: '40', color: 'سفید' }, { size: '41', color: 'سفید' }, { size: '42', color: 'سفید' }],
  }) as { id: string; variants: { id: string; sku: string }[] };
  await productsApi.status(seriesProduct.id, 'published');
  // Wholesale stock 40→10, 41→10, 42→3 (42 is the bottleneck component).
  for (const [i, qty] of [10, 10, 3].entries()) {
    const receipt = await inventoryApi.receipt({
      warehouseId: warehouse.id, variantId: seriesProduct.variants[i]!.id, quantity: qty,
      inventoryDomain: 'wholesale', reference: `SMOKE-SER-${i}`,
    }, `smoke-series-${suffix}-${i}`) as { id: string };
    await inventoryApi.receiveReceipt(receipt.id);
  }
  const seriesTemplate = await seriesTemplatesApi.create({
    productId: seriesProduct.id, name: `سری اسموک ${suffix}`,
    items: [
      { variantId: seriesProduct.variants[0]!.id, quantityPerSeries: 1 },
      { variantId: seriesProduct.variants[1]!.id, quantityPerSeries: 2 },
      { variantId: seriesProduct.variants[2]!.id, quantityPerSeries: 1 },
    ],
  }) as { id: string };
  const vipPlan = await apiClient.post<{ id: string }>('/plans', {
    code: `smoke-vip-${suffix}`, title: 'پلن اسموک', annualPriceRial: '10000000',
    limits: { sources: 'all', maxOrdersPerMonth: 50, maxOrderValueRial: '50000000000', maxSuppliersPerOrder: 10, discountPercent: 0, prioritySupport: false },
  });
  await db.query(
    `INSERT INTO memberships(id,user_id,plan_id,status,starts_at,ends_at) VALUES ($1,$2,$3,'active', now(), now() + interval '1 year')`,
    [randomUUID(), me.id, vipPlan.id]);

  // Back to the VIP buyer session.
  setAccessToken(session.accessToken);
  const vipSeries = await seriesTemplatesApi.vipList(seriesProduct.id);
  const vipRow = vipSeries.items.find((row) => row.id === seriesTemplate.id);
  check('VIP series list is server-backed (series_templates/items, not local Product.series)',
    Boolean(vipRow) && vipRow!.items.length === 3 && vipRow!.active === true, `rows=${vipSeries.items.length}`);
  check('availableSeries comes from the backend component-bottleneck calculation (size-42 ⇒ 3, not total stock)',
    vipRow!.available_series === 3 && vipRow!.moq_series === 1 && vipRow!.price_per_series_rial === '14000000',
    `available=${vipRow!.available_series} price=${vipRow!.price_per_series_rial}`);

  let overOrder: unknown = null;
  try {
    await ordersApi.create({ orderType: 'wholesale', series: [{ seriesTemplateId: seriesTemplate.id, count: 4 }] }, `smoke-ser-over-${suffix}`);
  } catch (error) { overOrder = error; }
  check('VIP cannot order more than availableSeries (409 from atomic server reservation)',
    overOrder instanceof AdminApiError && overOrder.status === 409,
    overOrder instanceof Error ? overOrder.message : 'no error raised');

  const placedOrder = await ordersApi.create(
    { orderType: 'wholesale', series: [{ seriesTemplateId: seriesTemplate.id, count: 2 }] },
    `smoke-ser-ok-${suffix}`) as { reference?: string };
  check('VIP checkout sends seriesTemplateId+count to POST /orders (server expands recipe + reserves atomically)',
    typeof placedOrder.reference === 'string' && placedOrder.reference!.startsWith('KV-'), placedOrder.reference ?? '');

  const afterOrder = await seriesTemplatesApi.vipList(seriesProduct.id);
  check('backend atomic reservation path reached by the frontend client: availableSeries 3 → 1',
    afterOrder.items.find((row) => row.id === seriesTemplate.id)?.available_series === 1);

  const myWholesaleOrders = await ordersApi.list({ orderType: 'wholesale' });
  check('VIP orders list refreshes from the server after checkout',
    myWholesaleOrders.items.some((order) => order.reference === placedOrder.reference));

  // =================== Prompt-2 §190: VIP Master/Child wholesale OMS through the SAME frontend client ===================
  const masterRes = await wholesaleOmsApi.createMaster(
    { items: [{ seriesTemplateId: seriesTemplate.id, count: 1 }] }, `smoke-master-${suffix}`);
  check('wholesaleOmsApi.createMaster → ONE master (MV-) + child per seller on the canonical orders table',
    masterRes.reference.startsWith('MV-') && masterRes.children.length === 1 &&
    masterRes.children[0]!.reference.startsWith('KV-'), masterRes.reference);
  check('kolbe-stock child is READY immediately (stock reserved atomically, snapshot locked)',
    masterRes.children[0]!.paymentEligibility === 'ready' &&
    ['stock_reserved', 'confirmed'].includes(masterRes.children[0]!.supplyStatus));
  const afterMaster = await seriesTemplatesApi.vipList(seriesProduct.id);
  check('master checkout consumed the LAST series through the same atomic reservation path (1 → 0)',
    afterMaster.items.find((row) => row.id === seriesTemplate.id)?.available_series === 0);
  const masterIntent = await wholesaleOmsApi.batchPaymentIntent(masterRes.id, [masterRes.children[0]!.id]);
  check('batch payment intent spans READY children of one master (PAY-, SUM == amount)',
    masterIntent.reference.startsWith('PAY-') && masterIntent.amountRial === masterRes.children[0]!.totalRial);
  let dupIntent: unknown = null;
  try { await wholesaleOmsApi.childPaymentIntent(masterRes.children[0]!.id); } catch (error) { dupIntent = error; }
  check('second intent on the same child is rejected (single active intent — PAYMENT_INTENT_EXISTS)',
    dupIntent instanceof AdminApiError && dupIntent.status === 409);
  const masterList = await wholesaleOmsApi.masters({ limit: 10 });
  check('wholesaleOmsApi.masters returns ONE canonical row per master with child aggregates (§152)',
    masterList.items.some((m) => m.reference === masterRes.reference && m.child_count === 1 && m.ready_children === 1));

  // =================== VIP / warehouse-hub UI contract (static source assertions) ===================
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const vipSrc = readFileSync(join(repoRoot, 'src/portals/vip.tsx'), 'utf8');
  const hubSrc = readFileSync(join(repoRoot, 'src/portals/warehouse-hub.tsx'), 'utf8');
  check('VIP UI renders no total piece/pair counts (business rule: series only)',
    !vipSrc.includes('تکه') && !vipSrc.includes('جفت') && !vipSrc.includes('cartPieces'));
  check('VIP UI still renders the series composition',
    vipSrc.includes('ترکیب سری') && vipSrc.includes('composition'));
  check('real VIP checkout posts /wholesale/masters (master/child OMS) — store.placeOrder only as the demo fallback branch',
    vipSrc.includes('wholesaleOmsApi.createMaster') && vipSrc.includes('seriesTemplateId') &&
    !vipSrc.includes('ordersApi.create') &&
    vipSrc.indexOf('serverCartLines.length > 0') < vipSrc.indexOf('store.placeOrder('));
  check('VIP availability uses server availableSeries (no local stock≥pieces×moq math)',
    vipSrc.includes('availableSeries') && !vipSrc.includes('p.stock >=') && !vipSrc.includes('p.stock <'));
  const hubHead = hubSrc.slice(hubSrc.indexOf('export function WarehouseHub'), hubSrc.indexOf('tab === "retail"'));
  const hubOptions = hubHead.slice(hubHead.indexOf('options={['), hubHead.indexOf(']}'));
  check('WMS has exactly 4 physical-inventory tabs and no product lifecycle list',
    (hubOptions.match(/\{ v: "/g) ?? []).length === 4 &&
    ['خرده‌فروشی', 'نقل‌وانتقالات', 'انبار عمده', 'تنظیمات انبار'].every((label) => hubOptions.includes(label)) &&
    !hubOptions.includes('کالاها') && !hubSrc.includes('CatalogHub'));
  const adminSrc = readFileSync(join(repoRoot, 'src/portals/admin.tsx'), 'utf8');
  check('Product Studio and WMS resolve to separate render branches while legacy product route is preserved',
    adminSrc.includes('rproducts: "wms:goods"') && adminSrc.includes('hubSub === "goods"') &&
    adminSrc.includes('<CatalogHub flash={flash} />') && adminSrc.includes('<WarehouseHub flash={flash} initial={hubSub} />'));
  const catalogHubSrc = readFileSync(join(repoRoot, 'src/components/catalog-hub.tsx'), 'utf8');
  check('Product Studio owns the canonical list/lifecycle and has no owner picker in product definition',
    ['تعریف محصول', 'نیازمند راه‌اندازی', 'بازبینی تأمین‌کنندگان', 'همه کالاها', 'آرشیو'].every((t) => catalogHubSrc.includes(t)) &&
    !catalogHubSrc.includes('مالک محصول'));
  const product360Src = readFileSync(join(repoRoot, 'src/components/product-360.tsx'), 'utf8');
  check('Product 360 is a WorkspaceModal with ten read areas, canonical pricing summary/Resolver, and read-only inventory/history',
    product360Src.includes('<WorkspaceModal') &&
    ['نمای کلی', 'واریانت‌ها', 'مشخصات فنی', 'راهنمای سایز', 'رسانه', 'قیمت‌گذاری', 'عمده و سری‌ها', 'موجودی', 'SEO', 'تاریخچه'].every((t) => product360Src.includes(t)) &&
    product360Src.includes('promotionRulesApi.productSummary(product.id)') && product360Src.includes('promotionRulesApi.resolvePrices') &&
    product360Src.includes('مدیریت قیمت‌گذاری') && product360Src.includes('نتیجهٔ Pricing Resolver') &&
    product360Src.includes('view="inventory"') && product360Src.includes('view="history"'));
  const supplierChildPanelSrc = readFileSync(join(repoRoot, 'src/components/supplier-child-orders-panel.tsx'), 'utf8');
  check('supplier wholesale panel offers exactly the §71 actions (تأیید کامل/پیشنهاد کمتر/عدم امکان) + server-resolved dispatch',
    ['تأیید کامل', 'پیشنهاد کمتر', 'عدم امکان'].every((t) => supplierChildPanelSrc.includes(t)) &&
    supplierChildPanelSrc.includes('supplierDispatch') && !supplierChildPanelSrc.includes('destinationWarehouseId'));

  // ---------- OMS: 3-tab orders hub contracts (§18-§41) ----------
  const omsAdmin = await authApi.login({ identity: adminEmail, password: adminPassword });
  setAccessToken(omsAdmin.accessToken);
  const omsOrders = await ordersApi.list({ orderType: 'retail', withTotal: '1', sellerScope: 'kolbe', limit: '5' }) as unknown as { items: Record<string, unknown>[]; total?: number };
  check('ordersApi.list supports OMS params (withTotal/sellerScope) and returns a real total', typeof omsOrders.total === 'number');
  check('orders list rows expose tracking/shipment/exception read-model columns',
    omsOrders.items.length === 0 || ['tracking_code', 'shipment_status', 'exception_reasons'].every((k) => k in omsOrders.items[0]!));
  const retailSales = await omsApi.retailSales({ limit: 5 });
  check('omsApi.retailSales unifies website orders + manual sales with payment/channel columns',
    typeof retailSales.total === 'number' &&
    (retailSales.items.length === 0 || ['kind', 'channel', 'payment_status', 'payment_method', 'tracking_code'].every((k) => k in retailSales.items[0]!)));
  const bulkGhost = await ordersApi.bulkTransitions({ orderIds: [randomUUID()], status: 'processing' });
  check('ordersApi.bulkTransitions is ONE backend call with per-item results + readable reasons',
    bulkGhost.failed === 1 && bulkGhost.results[0]!.ok === false && (bulkGhost.results[0]!.error ?? '').length > 0);
  const ordersHubSrc = readFileSync(join(repoRoot, 'src/portals/orders-hub.tsx'), 'utf8');
  const hubTabs = ordersHubSrc.slice(ordersHubSrc.indexOf('export function OrdersHub'));
  check('orders hub has exactly 3 tabs: خرده / عمده کلبه / عمده تأمین‌کنندگان',
    (hubTabs.match(/label: "سفارشات /g) ?? []).length === 3 && hubTabs.includes('سفارشات خرده') &&
    hubTabs.includes('سفارشات عمده کلبه') && hubTabs.includes('سفارشات عمده تأمین‌کنندگان'));
  const labelEngineSrc = readFileSync(join(repoRoot, 'backend/src/shipping-labels.ts'), 'utf8');
  check('shipping labels are SERVER PDFs (100×150mm thermal + A4 grid, price-free) and tracking writes go through the shipments domain',
    ordersHubSrc.includes('trackingApi.labelPath') && ordersHubSrc.includes('trackingApi.labelsBundlePath') &&
    !ordersHubSrc.includes('document.write') && labelEngineSrc.includes('283.46') &&
    !labelEngineSrc.includes('_rial') && ordersHubSrc.includes('trackingApi.createShipment') &&
    ordersHubSrc.includes('trackingApi.updateShipment'));
  check('bulk invoice print reuses the existing invoice domain (no parallel invoice renderer)',
    ordersHubSrc.includes('invoicesApi.list({ orderId') && !ordersHubSrc.includes('INV-'));
  check('orders hub shows ONE canonical master row (MasterOrdersStrip) — children stay in the wholesale tabs (§152)',
    ordersHubSrc.includes('MasterOrdersStrip') && ordersHubSrc.includes('wholesaleOmsApi.masters'));

  // ---------- §31-§35: manual sale = REAL order on the canonical pipeline ----------
  const moVariant = wmsProduct.variants.find((v) => v.color === 'مشکی' && v.size === 'M')!;
  const moBalancesBefore = normalizeStockBalances(await inventoryApi.balances({ warehouseId: warehouse.id, productId: wmsProduct.id }));
  const moBefore = moBalancesBefore.find((row) => row.variantId === moVariant.id)!;
  const moMobile = `0912${String(Date.now()).slice(-7)}`;
  const moKey = `smoke-mo-${suffix}`;
  const manualOrder = await manualOrdersApi.create({
    customer: { name: 'مشتری اسموک قرارداد', mobile: moMobile },
    channel: 'in_person', warehouseId: warehouse.id,
    items: [{ variantId: moVariant.id, quantity: 1 }],
    payment: { method: 'cash', status: 'paid' }, deliverNow: true,
  }, moKey);
  check('manualOrdersApi.create → real delivered order with SERVER-side canonical pricing',
    manualOrder.status === 'delivered' && manualOrder.customerCreated === true && manualOrder.totalRial === '18500000',
    `${manualOrder.reference} total=${manualOrder.totalRial}`);
  const manualReplay = await manualOrdersApi.create({
    customer: { name: 'مشتری اسموک قرارداد', mobile: moMobile },
    channel: 'in_person', warehouseId: warehouse.id,
    items: [{ variantId: moVariant.id, quantity: 1 }],
    payment: { method: 'cash', status: 'paid' }, deliverNow: true,
  }, moKey);
  check('manual order create is idempotent (same key → same order, no double consumption)',
    manualReplay.id === manualOrder.id && manualReplay.reference === manualOrder.reference);
  const moBalancesAfter = normalizeStockBalances(await inventoryApi.balances({ warehouseId: warehouse.id, productId: wmsProduct.id }));
  const moAfter = moBalancesAfter.find((row) => row.variantId === moVariant.id)!;
  check('in-person paid+delivered consumed stock exactly ONCE through the normal order lifecycle',
    moAfter.onHand === moBefore.onHand - 1 && moAfter.reserved === moBefore.reserved,
    `on_hand ${moBefore.onHand}→${moAfter.onHand} reserved ${moBefore.reserved}→${moAfter.reserved}`);
  const moPending = await manualOrdersApi.create({
    customer: { name: 'مشتری اسموک قرارداد', mobile: moMobile },
    channel: 'instagram', warehouseId: warehouse.id,
    items: [{ variantId: moVariant.id, quantity: 1 }],
    payment: { method: 'cod', status: 'pending' },
  }, `smoke-mo2-${suffix}`);
  const moBalancesPending = normalizeStockBalances(await inventoryApi.balances({ warehouseId: warehouse.id, productId: wmsProduct.id }));
  const moPendingRow = moBalancesPending.find((row) => row.variantId === moVariant.id)!;
  check('pending manual order reserves only (reuses existing customer, no consumption yet)',
    moPending.status === 'pending_payment' && moPending.customerCreated === false &&
    moPendingRow.onHand === moAfter.onHand && moPendingRow.reserved === moAfter.reserved + 1);
  const moSales = await omsApi.retailSales({ limit: 20 });
  const moSalesRow = (moSales.items as { id?: unknown; kind?: unknown; channel?: unknown }[]).find((row) => row.id === manualOrder.id);
  check('manual order listed beside website orders with its REAL commercial channel',
    moSalesRow?.kind === 'order' && moSalesRow?.channel === 'in_person');
  const moList = await ordersApi.list({ orderType: 'retail', limit: '20' }) as unknown as { items: { id: string; sales_channel?: string }[] };
  const moListRow = moList.items.find((row) => row.id === manualOrder.id);
  check('GET /orders rows expose sales_channel for the hub list', moListRow?.sales_channel === 'in_person');
  const manualFormSrc = readFileSync(join(repoRoot, 'src/components/manual-order-form.tsx'), 'utf8');
  check('manual-order form posts the REAL order endpoint and never asks for a client-side price',
    manualFormSrc.includes('manualOrdersApi.create') && !manualFormSrc.includes('unitPrice') && !manualFormSrc.includes('priceRial'));
  check('OrdersHub drawer mounts ManualOrderForm — legacy manual-sale CREATE panel no longer offered',
    ordersHubSrc.includes('<ManualOrderForm />') && !ordersHubSrc.includes('<ManualSalesPanel'));

  const crmUser=await crmApi.userRelationship(me.id);
  const crmContactId=String(crmUser.contact.id);
  const crmLabels=await crmIntelApi.labels();
  const crmLabel=String(crmLabels.items[0]!.code);
  await buyersApi.addLabel(me.id,{labelCode:crmLabel});
  await buyersApi.addNote(me.id,{body:'یادداشت قرارداد تیم',visibility:'team'});
  const crmDetail=await crmApi.relationship(crmContactId);
  check('VIP client label picker posts canonical labels array and persists',crmDetail.labels.some(label=>label.code===crmLabel));
  check('VIP client team-note visibility matches canonical API',crmDetail.notes.some(note=>note.body==='یادداشت قرارداد تیم'&&note.visibility==='team'));
  await buyersApi.saveConsent(me.id,{marketingSms:false,emailMarketing:false,reason:'آزمون قرارداد بازاریابی'});
  const consentAfter=await buyersApi.view360(me.id);
  check('marketing consent updates leave transactional consent enabled',consentAfter.crm.consent?.marketing_sms===false&&consentAfter.crm.consent?.transactional_sms===true);
  const crmLead=await crmApi.createLead({name:`سرنخ قرارداد ${suffix}`,nextFollowupAt:new Date(Date.now()+86_400_000).toISOString()});
  const leadDetail=await crmApi.relationship(crmLead.id);
  check('CRM frontend lead date creates a server-backed canonical task',leadDetail.tasks.length===1);
  const crmSearch=await crmApi.globalSearch(`سرنخ قرارداد ${suffix}`);
  check('global CRM search client returns standalone lead identity',crmSearch.items.some(row=>row.contact_id===crmLead.id));
  const crmSegment=await crmIntelApi.createSegment({code:`crm_contract_${suffix}`,title:'گروه آزمون قرارداد',kind:'dynamic',definition:{matchMode:'all',conditions:[{field:'order_count',op:'>=',value:0}]}}) as {id:string};
  await crmIntelApi.refreshSegment(crmSegment.id);
  const segmentMembers=await crmIntelApi.segmentMembers(crmSegment.id);
  check('segment member workspace receives metrics and membership criteria from API',segmentMembers.items.length>0&&segmentMembers.items.every(row=>'order_count'in row&&'total_rial'in row&&'membership_definition'in row&&'last_order_at'in row));
  setAccessToken(null);
} catch (error) {
  console.error('API diagnostic tail:',log.join('').split('\n').slice(-20).join('\n'));
  console.error('SMOKE ERROR:', error instanceof Error ? error.message : error);
  check('frontend contract smoke completed without exceptions', false, String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 400));
} finally {
  if (app?.pid) {
    if (process.platform === 'win32') app.kill();
    else { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  await server.stop();
  await db.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
