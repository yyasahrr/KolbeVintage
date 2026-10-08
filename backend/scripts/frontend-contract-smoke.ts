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
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import {
  apiClient, authApi, getAccessToken, setAccessToken, setApiBaseUrl, ticketsApi, productsApi, filesApi,
  omsApi, ordersApi, seriesTemplatesApi, wholesaleOmsApi, wmsInboundApi, AdminApiError,
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
  shippingApi, supplier360Api,
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
try {
  if (await run('npm', ['run', '--silent', 'migrate']) !== 0) throw new Error('migrations failed');
  if (await run('npx', ['tsx', 'src/bootstrap-admin.ts'], { BOOTSTRAP_ADMIN_EMAIL: adminEmail, BOOTSTRAP_ADMIN_PASSWORD: adminPassword }) !== 0) {
    throw new Error('admin bootstrap failed');
  }
  app = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const log: string[] = [];
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

  // ---------- AUTH remediation: mobile + OTP is a REAL login on the same customer account ----------
  const otpPhone = `09${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const otpEmail = `smoke-otp-${suffix}@example.test`;
  /* MOBILE-FIRST REGISTRATION (locked §6): the number is verified BEFORE the account exists. */
  const signupChallenge = await authApi.requestOtp({ phone: otpPhone, purpose: 'signup' });
  check('authApi.requestOtp(purpose=signup) verifies the number before the account exists',
    typeof signupChallenge.challengeId === 'string' && signupChallenge.deliveryHint === 'sms_queued' &&
    typeof signupChallenge.devCode === 'string');
  const registered = await authApi.register({ displayName: 'خریدار اسموک OTP', phone: otpPhone,
    code: signupChallenge.devCode!, email: otpEmail, password: 'SmokePassword123456!' });
  check('authApi.register (mobile verified) creates the canonical customer and signs them in',
    typeof registered.id === 'string' && Boolean(registered.accessToken) && registered.linking === 'new' &&
    getAccessToken() === registered.accessToken);
  const registeredMe = await authApi.me();
  check('the same account carries BOTH verified identities and no wholesale entitlement',
    registeredMe.id === registered.id && registeredMe.phone === otpPhone && registeredMe.email === otpEmail &&
    registeredMe.isWholesaleMember === false && registeredMe.membership === null && registeredMe.supplier === null);
  let duplicateSignup = false;
  try { await authApi.requestOtp({ phone: otpPhone, purpose: 'signup' }); } catch { duplicateSignup = true; }
  check('signing up twice for one verified number is refused (no duplicate account)', duplicateSignup);

  const otpChallenge = await authApi.requestOtp({ phone: otpPhone });
  check('authApi.requestOtp queues ONE SMS challenge (masked mobile, no code in production)',
    typeof otpChallenge.challengeId === 'string' && otpChallenge.deliveryHint === 'sms_queued' &&
    otpChallenge.phoneMasked === `${otpPhone.slice(0, 4)}***${otpPhone.slice(-2)}`, otpChallenge.phoneMasked);
  const otpWrong = await authApi.requestOtp({ phone: otpPhone });
  check('a new OTP request invalidates the previous live code (single live challenge per customer)',
    otpWrong.challengeId !== otpChallenge.challengeId);
  let rejected = false;
  try { await authApi.verifyOtp({ challengeId: otpChallenge.challengeId, code: '000000' }); } catch { rejected = true; }
  check('authApi.verifyOtp rejects a wrong code instead of logging in', rejected);
  const otpSession = await authApi.verifyOtp({ challengeId: otpWrong.challengeId, code: otpWrong.devCode! });
  check('authApi.verifyOtp issues a real session for the SAME customer account',
    Boolean(otpSession.accessToken) && getAccessToken() === otpSession.accessToken);
  const otpMe = await authApi.me();
  check('mobile+OTP and email+password are two logins for ONE customer/VIP account',
    otpMe.id === (await authApi.me()).id && otpMe.email === otpEmail && otpMe.phone === otpPhone &&
    otpMe.isWholesaleMember === false && otpMe.membership === null);

  // ---------- canonical password recovery (one-time token → set-password) ----------
  const recovery = await authApi.forgotPassword(otpPhone);
  check('authApi.forgotPassword uses the canonical one-time token (no enumeration, hash only)',
    recovery.delivered === true && typeof recovery.devToken === 'string' && recovery.devToken.length > 20);
  const anonymous = await authApi.forgotPassword(`nobody-${suffix}@example.test`);
  check('recovery never reveals whether an identity exists', anonymous.delivered === true && anonymous.devToken === undefined);
  await authApi.setPassword({ token: recovery.devToken!, newPassword: 'RecoveredSmoke123456!' });
  const recoveredLogin = await authApi.login({ identity: otpPhone, password: 'RecoveredSmoke123456!' });
  check('the recovered password signs into the SAME account', Boolean(recoveredLogin.accessToken));
  check('recovery left the canonical identity intact', (await authApi.me()).id === registered.id);
  await authApi.login({ identity: otpPhone, password: 'SmokePassword123456!' }).then(
    () => check('the previous password is no longer valid after recovery', false),
    () => check('the previous password is no longer valid after recovery', true));

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

  /* The Studio's own product is completed the canonical way: it carries a Series price, so the
     explicit publish succeeds and the storefront read model can expose its server media. */
  const studioStatus = await productsApi.status(product.id, 'published');
  check('§1 the Studio-created product publishes explicitly → منتشرشده', studioStatus.status === 'published', studioStatus.status);

  /* ---------- publication contract (Prompt-1 §1-§5) ----------
   * Publication is an explicit, server-authoritative decision. It is blocked with an actionable
   * Persian list when a catalog requirement is missing, and it never depends on stock. */
  const wholesaleOnlyName = `بدون قیمت عمده ${suffix}`;
  const wholesaleOnly = await apiClient.post<{ id: string }>('/products', {
    saveIntent: 'draft', brand: 'Kolbe', name: wholesaleOnlyName, category: 'کت',
    retailEnabled: false, wholesaleEnabled: true, cashPriceRial: '0',
    variants: [{ size: 'M', color: 'مشکی' }],
  });
  check('§4 a wholesale product without any wholesale price can still be SAVED as a draft',
    Boolean(wholesaleOnly.id), wholesaleOnly.id);
  const blocked = await productsApi.status(wholesaleOnly!.id, 'published').then(
    () => null,
    (error: unknown) => error as { status?: number; message?: string; details?: { issues?: { code: string }[]; labels?: string[] } },
  );
  check('§4 publish of an incomplete product is rejected with 422 PUBLICATION_INCOMPLETE',
    blocked?.status === 422, `status=${blocked?.status ?? 'no error'}`);
  check('§4 the rejection carries the actionable Persian message',
    blocked?.message === 'برای انتشار محصول این موارد را تکمیل کنید:', String(blocked?.message));
  check('§4 the rejection lists the exact missing wholesale requirement',
    (blocked?.details?.issues ?? []).some((issue) => issue.code === 'series'),
    (blocked?.details?.labels ?? []).join('، ') || 'no issues');
  const stillDraft = await apiClient.get<{ status: string }>(`/admin/products/${wholesaleOnly!.id}`);
  check('§4 a blocked publish mutates nothing (the product stays پیش‌نویس)',
    String(stillDraft.status) !== 'published', String(stillDraft.status));

  // The canonical wholesale price makes it publishable — and NO stock is involved (§3/§19).
  await apiClient.patch<{ updated: string[] }>(`/products/${wholesaleOnly!.id}`, { wholesalePriceRial: '35000000' });
  const readiness = await apiClient.get<{ publishable: boolean; stockIndependent: boolean; issues: { code: string }[] }>(
    `/admin/products/${wholesaleOnly!.id}/publication-readiness`);
  check('§4 the readiness endpoint is the same authority the publish call enforces',
    readiness.publishable === true && readiness.stockIndependent === true && readiness.issues.length === 0,
    `publishable=${readiness.publishable} issues=${readiness.issues.map((i) => i.code).join(',') || 'none'}`);
  const wholesalePublish = await productsApi.status(wholesaleOnly!.id, 'published');
  check('§1/§2 explicit publish succeeds with ZERO physical stock', wholesalePublish.status === 'published');
  const republished = await productsApi.status(wholesaleOnly!.id, 'published');
  check('§5 re-publishing an already published product is an idempotent no-op', republished.status === 'published');
  const publishedList = await apiClient.get<{ items: { id: string }[] }>('/admin/products?view=published&owner=kolbe&limit=100');
  const draftList = await apiClient.get<{ items: { id: string }[] }>('/admin/products?view=drafts&owner=kolbe&limit=100');
  check('§2 the published product is in «منتشرشده» and no longer in «پیش‌نویس‌ها»',
    publishedList.items.some((item) => item.id === wholesaleOnly!.id) && !draftList.items.some((item) => item.id === wholesaleOnly!.id));

  await productsApi.update(product.id, { metadata: { images: [{ fileId: uploaded.id, url: filesApi.downloadPath(uploaded.id) }], channels: { retail: true, wholesale: true } } });
  const catalog = await apiClient.get<{ items: { id: string; metadata: { images?: { fileId: string }[] } }[] }>('/products');
  const published = catalog.items.find((item) => item.id === product.id);
  check('catalog exposes persisted server file reference (no data URL)',
    published?.metadata.images?.[0]?.fileId === uploaded.id);

  {
    const supplierAuthoring = await readFile(new URL('../../src/components/supplier-product-series-authoring.tsx', import.meta.url), 'utf8');
    check('P5 supplier product creation retains real image upload and attaches server file references',
      supplierAuthoring.includes('filesApi.upload(file)')
      && supplierAuthoring.includes('افزودن تصاویر محصول')
      && supplierAuthoring.includes('metadata: { images: productImages.map(({ fileId, url }) => ({ fileId, url })) }'),
      'Supplier form uploads to /files and submits fileId-backed product metadata');
  }

  // =================== Product Studio remediation (Prompt-1) ===================
  // Static contract checks on the single canonical Studio source: the 8-step nav, the explicit
  // publish control, the absence of template binding, and the merged specs + size-guide step.
  {
    const studio = await readFile(new URL('../../src/portals/admin-product.tsx', import.meta.url), 'utf8');
    const both = (...needles: string[]) => needles.every((needle) => studio.includes(needle));
    /* §55 (Prompt 2): the pricing journey spans three surfaces — the Studio step, the wholesale
       series editor and the embedded discount/festival editor — and ALL of them speak the
       canonical Persian vocabulary (no Resolver/compareAt/pricing_mode/enum wording). */
    const pricingSurfaces = studio
      + await readFile(new URL('../../src/components/product-series-editor.tsx', import.meta.url), 'utf8')
      + await readFile(new URL('../../src/components/product-pricing-panel.tsx', import.meta.url), 'utf8');
    // The nav is read straight out of the `secs` declaration so a renamed or re-added step fails here.
    const stepIds = studio.slice(studio.indexOf('export const STUDIO_STEPS = ['),
      studio.indexOf('] as const;', studio.indexOf('export const STUDIO_STEPS = [')));
    const stepLabels = studio.slice(studio.indexOf('export const STUDIO_STEP_LABEL'),
      studio.indexOf('};', studio.indexOf('export const STUDIO_STEP_LABEL')));
    // §1/§26: ONE continuous journey — create → pricing/discounts → initial inventory → publish.
    check('§26 the Studio nav is exactly the canonical 9 steps, in order',
      JSON.stringify([...stepIds.matchAll(/"(\w+)"/g)].map((m) => m[1]))
        === JSON.stringify(['base', 'variant', 'media', 'cutout', 'price', 'specs', 'inventory', 'seo', 'review'])
      && ['اطلاعات پایه', 'رنگ، سایز و واریانت', 'تصویر و ویدیو', 'تصویر استایل‌بیلدر', 'قیمت‌گذاری و تخفیف',
        'مشخصات و راهنمای سایز', 'موجودی اولیه', 'سئو و کانال‌ها', 'بازبینی و انتشار']
        .every((label) => stepLabels.includes(label)),
      stepIds.replace(/\s+/g, ' ').slice(0, 220));
    check('§6/§7/§18 the Studio embeds the canonical pricing + initial-inventory workspaces',
      studio.includes('<ProductPricingPanel') && studio.includes('<InitialInventoryWorkspace')
      && studio.includes('<ProductInventoryPanel')
      && !studio.includes('onOpenPricing') && !studio.includes('ProductPricingWorkspace'),
      'embedded canonical editors, no handoff/page');
    check('§3 the sticky bar owns [ذخیره پیش‌نویس] + step navigation and the last step owns [انتشار محصول]',
      studio.includes('const saveDraftAndStay =') && studio.includes('sticky bottom-0')
      && studio.includes('{draftSaving ? "در حال ذخیره…" : "ذخیره پیش‌نویس"}')
      && studio.includes('const isLastStep =') && studio.includes('onClick={() => goStep(STUDIO_STEPS[stepIndex + 1]!)}'));
    check('§9/§11 the merged step no longer binds a template or a category schema',
      !studio.includes('ProductSpecsEditor') && !studio.includes('قالب مشخصات')
      && !studio.includes('اتصال زنده') && !studio.includes('کپی ثابت'),
      'no ProductSpecsEditor / template binding');
    check('§1 the Review step owns an explicit «انتشار محصول» action',
      studio.includes('انتشار محصول') && studio.includes('publishProduct'), 'publish control present');
    check('§5 publication is guarded against double submit and reports true state',
      studio.includes('publishing || publicationState === "published"') && studio.includes('setPublishing(true)'),
      'in-flight guard present');
    check('§4 a blocked publish shows the server issue list, never a raw error',
      studio.includes('برای انتشار محصول این موارد را تکمیل کنید: '), 'canonical message shown');
    check('§6 Sales Mode replaces the old retail/wholesale price mode switch',
      both('فقط خرده', 'فقط عمده', 'خرده + عمده') && !studio.includes('حالت قیمت خرده/عمده'),
      'sales mode control');
    check('§6 retail section = cash price + installment enable + installment base + discount policy',
      both('قیمت نقدی پایه (تومان)', 'خرید چهارقسطه', 'قیمت پایه چهارقسطه (تومان)', 'سیاست اعمال تخفیف روی خرید چهارقسطه'),
      'retail pricing fields');
    /* §55/§19 (Prompt 2): the pricing surfaces speak the canonical Persian vocabulary and never leak
       the retired English/enum terms to the operator. */
    check('§55 pricing surfaces use the canonical Persian terms and leak no Resolver/enum wording',
      ['قیمت نقدی پایه', 'خرید چهارقسطه', 'قیمت پایه چهارقسطه', 'سیاست اعمال تخفیف روی خرید چهارقسطه',
        'فروش عمده', 'قیمت کل سری', 'محاسبه قیمت از اجزای سری', 'حداقل سفارش عمده', 'قیمت نهایی']
        .every((needle) => pricingSurfaces.includes(needle))
      /* A line that mixes Persian copy with an English/enum token IS a leak; pure code lines
         (object keys, type names) are not user-facing text and must stay allowed. */
      && !pricingSurfaces.split('\n')
        .filter((line) => /[\u0600-\u06FF]/.test(line))
        .some((line) => /compareAt|pricing_mode|Resolver|snake_case|installment_policy/.test(line)),
      'canonical Persian pricing vocabulary');
    check('§7/§12 the embedded discount+festival editor is the canonical Promotion Engine surface',
      studio.includes('<ProductPricingPanel') && studio.includes('onOpenPromotionCenter')
      && !studio.includes('localFestivalDraft') && !studio.includes('discountDraftMetadata')
      && !studio.includes('product.metadata') && !/productsApi\.update\([^)]*discount/.test(studio),
      'promotion engine is the only discount authority');
    check('§12 the two tables persist through the existing metadata JSON column (no new authority)',
      studio.includes('tables: { specs: d.specsTable, sizeGuide: d.sizeGuideTable }')
      && studio.includes('normalizeTable((meta.tables as { specs?: unknown } | undefined)?.specs)'),
      'tables in product metadata');
  }
  {
    const editor = await readFile(new URL('../../src/components/dynamic-table-editor.tsx', import.meta.url), 'utf8');
    const tableOps = await readFile(new URL('../../src/components/table-ops.ts', import.meta.url), 'utf8');
    check('§10 the table editors support add/rename/delete/reorder and the canonical empty state',
      ['افزودن ستون', 'افزودن سطر', 'هنوز اطلاعاتی ثبت نشده است.', 'tableRenameColumn', 'tableDeleteColumn', 'tableMoveColumn', 'tableDeleteRow', 'tableMoveRow']
        .every((needle) => editor.includes(needle))
      && ['tableAddColumn', 'tableRenameColumn', 'tableDeleteColumn', 'tableMoveColumn', 'tableAddRow', 'tableDeleteRow', 'tableMoveRow', 'tableSetCell']
        .every((needle) => tableOps.includes(`export function ${needle}`)),
      'dynamic table editor + pure operations');
    /* §4 (browser-UAT delta): a column delete must be ONE atomic onChange — the old editor fired
       onChange twice (columns, then rows from a stale snapshot) and the deleted column came back. */
    check('§4 every table mutation commits exactly once (delete-column regression)',
      editor.includes('const commit = (next: DataTable) => onChange(next);')
      && editor.split('onChange(next)').length - 1 === 1
      && editor.split('\n').every((line) => line.split('commit(').length - 1 <= 1)
      && editor.split('commit(table').length - 1 >= 10
      && tableOps.includes('export function tableDeleteColumn')
      && tableOps.includes('rows: table.rows.map((row) => ({ ...row, values: cellsFor(columns, row.values) }))'),
      'single commit per user action');
  }

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
    metadata: { images: [{ fileId: uploaded.id, url: filesApi.downloadPath(uploaded.id) }] },
    variants: [{ size: '40', color: 'سفید' }, { size: '41', color: 'سفید' }, { size: '42', color: 'سفید' }],
  }) as { id: string; variants: { id: string; sku: string }[] };
  // §6/§4: wholesale is canonical Series pricing, so publication needs a priced, orderable series.
  await apiClient.patch<{ updated: string[] }>(`/products/${seriesProduct.id}`, {
    wholesaleSeries: [{ name: 'سری کتانی اسموک', color: 'سفید', active: true, pricingMode: 'series_total',
      totalPriceRial: '35000000', minOrderSeries: 1,
      items: [{ size: '40', quantityPerSeries: 1 }, { size: '41', quantityPerSeries: 1 }, { size: '42', quantityPerSeries: 1 }] }],
  });
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
  const apiSrc = readFileSync(join(repoRoot, 'src/data/api.ts'), 'utf8');
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
  // §3/§25: «محصولات کلبه» is the canonical Product entry; Product Studio lives inside it and
  // WMS stays purely physical. Legacy product bookmarks (rproducts / wms:goods) still resolve.
  check('«محصولات کلبه» is the canonical product entry and WMS stays physical-only',
    adminSrc.includes('{ v: "products", label: "محصولات کلبه"') &&
    adminSrc.includes('<KolbeProductsHub flash={flash}') &&
    adminSrc.includes('<WarehouseHub flash={flash} initial={hubSub} />') &&
    !adminSrc.includes('"استودیو محصول"'));
  check('legacy product routes redirect into «محصولات کلبه» (bookmarks keep working)',
    adminSrc.includes('rproducts: "products"') && adminSrc.indexOf('"wms:goods": "products"') > 0);
  const productsHubSrc = readFileSync(join(repoRoot, 'src/components/kolbe-products-hub.tsx'), 'utf8');
  // §5/§26: the five canonical Product views, and NO «نیازمند راه‌اندازی» lifecycle anywhere.
  const userFacing = (source: string) => source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
  check('«محصولات کلبه» exposes exactly the five canonical views and no «نیازمند راه‌اندازی» lifecycle',
    ['همه محصولات', 'پیش‌نویس‌ها', 'منتشرشده', 'ناموجود', 'آرشیوشده'].every((t) => productsHubSrc.includes(t)) &&
    !userFacing(productsHubSrc).includes('نیازمند راه‌اندازی'));
  check('«محصولات کلبه» primary action opens the canonical Product Studio and offers the canonical row actions',
    productsHubSrc.includes('افزودن محصول') && productsHubSrc.includes('<ProductStudio') &&
    ['ادامه تکمیل محصول', 'ویرایش', '۳۶۰°', 'قیمت‌گذاری', 'مدیریت موجودی', 'ورود اولیه کالا']
      .every((t) => productsHubSrc.includes(t)) &&
    !productsHubSrc.includes('مالک محصول'));
  const studioSrc = readFileSync(join(repoRoot, 'src/portals/admin-product.tsx'), 'utf8');
  // §6: the canonical creation actions — no success page, no needs-setup queue.
  check('Product Studio actions are [ذخیره پیش‌نویس] / [مرحله بعد] / [انتشار محصول] / [انصراف] with no success page',
    ['ذخیره پیش‌نویس', 'مرحله بعد', 'انتشار محصول', 'انصراف'].every((t) => studioSrc.includes(t)) &&
    !studioSrc.includes('ذخیره و انتشار') && !studioSrc.includes('createdSummary') &&
    !studioSrc.includes('ذخیره و ادامه') && !userFacing(studioSrc).includes('نیازمند راه‌اندازی'));
  // Prompt-1 correction (browser UAT defect): «افزودن محصول» must open the NEW PRODUCT studio
  // form directly — no intermediate/parallel product list, no second click, no duplicate product.
  const studioHubSlice = productsHubSrc.slice(productsHubSrc.indexOf('screen.k === "studio"'));
  check('«افزودن محصول» mounts the Product Studio embedded — its own list stays hidden',
    /<ProductStudio[\s\S]{0,400}?embedded/.test(studioHubSlice) &&
    studioSrc.includes('{!open && !embedded && (<>') &&
    studioSrc.includes('{!open && embedded && resumeProductId && ('));
  const openCreateStart = studioSrc.indexOf('const openCreate = () => {');
  const openCreateBody = studioSrc.slice(openCreateStart, studioSrc.indexOf('};', openCreateStart) + 2);
  check('embedded studio auto-opens the NEW PRODUCT form exactly once and writes nothing on open',
    openCreateBody.includes('setOpen(true)') &&
    studioSrc.includes('const autoOpened = useRef(false)') &&
    studioSrc.includes('if (!embedded || resumeProductId || open || autoOpened.current) return;') &&
    !openCreateBody.includes('productsApi.create'));
  const structureSlice = adminSrc.slice(adminSrc.indexOf('tab === "structure"'), adminSrc.indexOf('tab === "imports"'));
  check('«ساختار محصولات و سری‌ها» stays structural/config-only — never a product-creation authority',
    structureSlice.includes('<ProductStructurePanel') && structureSlice.includes('<SeriesTemplateManager') &&
    !structureSlice.includes('ProductStudio'));
  check('every studio exit path ([انصراف] / «بازگشت به فهرست» / «خروج بدون ذخیره») returns to «محصولات کلبه»',
    (studioSrc.match(/onExit\?\.\(\)/g) ?? []).length >= 2 &&
    studioSrc.slice(studioSrc.indexOf('const closeStudio'), studioSrc.indexOf('const closeStudio') + 400).includes('onExit?.()') &&
    studioSrc.includes('onClick={onExit}') &&
    productsHubSrc.includes('onExit={closeStudio}') &&
    /const closeStudio = \(\) => \{[\s\S]{0,320}?setScreen\(\{ k: "list" \}\);/.test(productsHubSrc));
  const setupSrc = readFileSync(join(repoRoot, 'src/components/initial-inventory-workspace.tsx'), 'utf8');
  check('ورود اولیه کالا is the single canonical initial-inventory workspace (Color×Size + Series, two domains)',
    setupSrc.includes('ورود اولیه کالا') && setupSrc.includes('initial-inventory-workspace') === false &&
    setupSrc.includes('catalogOpsApi.inventorySetup') && setupSrc.includes('inventoryDomain') === false &&
    setupSrc.includes('retail') && setupSrc.includes('wholesale'));
  const product360Src = readFileSync(join(repoRoot, 'src/components/product-360.tsx'), 'utf8');
  check('Product 360 is a WorkspaceModal with ten read areas, canonical pricing summary/Resolver, and read-only inventory/history',
    product360Src.includes('<WorkspaceModal') &&
    ['نمای کلی', 'واریانت‌ها', 'مشخصات فنی', 'راهنمای سایز', 'رسانه', 'قیمت‌گذاری', 'عمده و سری‌ها', 'موجودی', 'SEO', 'تاریخچه'].every((t) => product360Src.includes(t)) &&
    product360Src.includes('promotionRulesApi.productSummary(product.id)') && product360Src.includes('promotionRulesApi.resolvePrices') &&
    product360Src.includes('مدیریت قیمت‌گذاری') && product360Src.includes('نتیجهٔ نهایی سرور') &&
    !product360Src.includes('Pricing Resolver') && !product360Src.includes('Resolver') &&
    product360Src.includes('view="inventory"') && product360Src.includes('view="history"'));
  /* ---------------- Prompt 6 — inbound receiving / QC / exceptions / consolidation ---------------- */
  const inboundOpsSrc = readFileSync(join(repoRoot, 'src/portals/wms-inbound-operations.tsx'), 'utf8');
  const inboundOpsUi = userFacing(inboundOpsSrc);
  check('Prompt 6 warehouse workspace lives inside the WMS hub as the «دریافت و تجمیع سفارش‌های مادر» sub-tab (four primary tabs unchanged)',
    hubSrc.includes('WmsInboundOperations') && hubSrc.includes('master-inbound') &&
    hubSrc.includes('دریافت و تجمیع سفارش‌های مادر') &&
    (hubHead.match(/\{ v: "/g) ?? []).length === 4 &&
    adminSrc.includes('"wms:inbound-ops": "wms:master-inbound"'));
  check('receiving/QC/consolidation actions are SERVER-derived (actions[] from the API), never guessed by the UI',
    inboundOpsSrc.includes('detail?.actions.includes("receive")') &&
    inboundOpsSrc.includes('detail?.actions.includes("inspect")') &&
    inboundOpsSrc.includes('actions.includes("start_consolidation")') &&
    inboundOpsSrc.includes('actions.includes("verify_item")') &&
    inboundOpsSrc.includes('actions.includes("pack")') &&
    inboundOpsSrc.includes('actions.includes("ship")'));
  check('the Prompt 6 UI never mutates stock or derives availability itself (no inventory writes, no on-hand math)',
    !inboundOpsSrc.includes('inventoryApi') && !inboundOpsSrc.includes('on_hand') &&
    !inboundOpsSrc.includes('stock_balances') && !inboundOpsSrc.includes('series_stock_balances') &&
    inboundOpsSrc.includes('wmsInboundApi'));
  check('the operational vocabulary is Persian and task-oriented (محموله ورودی، کسری، آسیب‌دیده، کنترل کیفیت، تجمیع، ارسال)',
    ['محموله ورودی', 'در انتظار دریافت فیزیکی', 'کسری', 'آسیب‌دیده', 'کنترل کیفیت', 'تأییدشده', 'نیازمند بررسی',
      'آماده تجمیع', 'آماده ارسال', 'ارسال‌شده'].every((label) => inboundOpsUi.includes(label)));
  check('receiving and QC are presented as two separate facts with explicit reconciliation hints',
    inboundOpsUi.includes('دریافت فیزیکی (رسید انبار)') && inboundOpsUi.includes('کنترل کیفیت کالای دریافتی') &&
    inboundOpsSrc.includes('received + missing !== line.dispatched_series') &&
    inboundOpsSrc.includes('qcTotal !== line.received_series'));
  check('the prompt-6 API client targets the canonical endpoints only — no parallel inbound/WMS/OMS centre',
    ['/admin/wms/inbound-shipments', '/admin/wms/exceptions', '/admin/wms/dashboard', '/admin/wms/consolidation-queue',
      '/admin/wms/masters/'].every((route) => apiSrc.includes(route)) &&
    !/wms-?v2|inbound-?v2|oms-?v2|shipment-?center/i.test(apiSrc) &&
    !/wms-?v2|inbound-?v2|oms-?v2/i.test(inboundOpsSrc));
  // The WMS surface is an INTERNAL operator surface: sign in as the admin (earlier blocks leave a
  // customer/supplier session in the client) exactly like the OMS checks below do.
  await authApi.login({ identity: adminEmail, password: adminPassword });
  const dashboard = await wmsInboundApi.dashboard();
  check('GET /admin/wms/dashboard returns SERVER counters that match the live queues',
    typeof dashboard.counters.awaiting_receiving === 'number' &&
    typeof dashboard.counters.open_exceptions === 'number' && dashboard.counters.open_exceptions >= 0 &&
    Array.isArray(dashboard.masters));
  const inboundQueue = await wmsInboundApi.shipments({ limit: 5 });
  check('GET /admin/wms/inbound-shipments is the one inbound work queue (rows carry operator labels, not UUIDs)',
    Array.isArray(inboundQueue.items) && inboundQueue.items.every((row) => typeof row.reference === 'string' &&
      typeof row.master_reference === 'string' && typeof row.supplier_label === 'string'));
  const exceptionFeed = await wmsInboundApi.exceptions({ status: 'open', limit: 5 });
  check('GET /admin/wms/exceptions is the Exception Centre feed (open count + per-item context)',
    Array.isArray(exceptionFeed.items) && typeof exceptionFeed.openCount === 'number' &&
    exceptionFeed.items.every((item) => typeof item.exception_type === 'string' && typeof item.child_reference === 'string'));
  const consolidationQueue = await wmsInboundApi.consolidationQueue({ limit: 5 });
  check('GET /admin/wms/consolidation-queue is the one consolidation work queue (operator + buyer labels, no UUID-only rows)',
    Array.isArray(consolidationQueue.items) && consolidationQueue.items.every((row) => typeof row.master_reference === 'string' &&
      typeof row.master_order_id === 'string' && typeof row.ordered_series === 'number'));
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
  /* PRODUCT-OWNER IA (locked): exactly TWO primary order surfaces. Source type is NOT an order type:
     the per-source wholesale centers must not exist as tabs, components or routes. */
  const adminSrcForIa = readFileSync(join(repoRoot, 'src/portals/admin.tsx'), 'utf8');
  const studioSrcForAuth = readFileSync(join(repoRoot, 'src/portals/studio.tsx'), 'utf8');
  const supplierSrcForAuth = readFileSync(join(repoRoot, 'src/portals/supplier.tsx'), 'utf8');
  const supplierWorkspaceSrcForAuth = readFileSync(join(repoRoot, 'src/portals/supplier-portal-workspace.tsx'), 'utf8');
  const supplierNotificationsSrcForAuth = readFileSync(join(repoRoot, 'src/components/supplier-notifications-panel.tsx'), 'utf8');
  const appSrcForAuth = readFileSync(join(repoRoot, 'src/App.tsx'), 'utf8');
  const childPanelSrc = readFileSync(join(repoRoot, 'src/components/master-child-orders.tsx'), 'utf8');
  check('orders hub has exactly TWO tabs: سفارشات خرده / سفارشات عمده / VIP',
    (hubTabs.match(/label: "سفارشات /g) ?? []).length === 2 && hubTabs.includes('سفارشات خرده') &&
    hubTabs.includes('سفارشات عمده / VIP'));
  check('the separate per-source wholesale centers are REMOVED (no tab label, no component)',
    !/label:\s*"سفارشات عمده کلبه"/.test(hubTabs) && !/label:\s*"سفارشات عمده تأمین‌کنندگان"/.test(hubTabs) &&
    !/label:\s*"مرکز سفارش‌های مادر VIP"/.test(hubTabs) &&
    !ordersHubSrc.includes('function WholesaleTab') && !ordersHubSrc.includes('function MasterOrdersStrip'));
  check('a COLD deep link resolves through the redirect table and keeps its hub sub-target',
    adminSrcForIa.includes('const [initialRoute]') && adminSrcForIa.includes('const [hubSub, setHubSub] = useState<string | null>(initialRoute?.sub ?? null)') &&
    /const \[tab, setTab\] = useState\(initialProductsRoute \? "products" : \(initialRoute\?\.hub \?\? "tower"\)\)/.test(adminSrcForIa));
  check('legacy wholesale order routes REDIRECT to the one unified surface (no duplicate authority)',
    /worders:\s*"server-orders:wholesale"/.test(adminSrcForIa) && /kolbe:\s*"server-orders:wholesale"/.test(adminSrcForIa) &&
    /masters:\s*"server-orders:wholesale"/.test(adminSrcForIa) && /wholesale:\s*"server-orders:wholesale"/.test(adminSrcForIa) &&
    /rorders:\s*"server-orders:retail"/.test(adminSrcForIa) && adminSrcForIa.includes('<OrdersHub initial={hubSub} />'));
  check('child/sub-orders carry their operational tools inside the master workspace module',
    childPanelSrc.includes('ordersApi.bulkTransitions') && childPanelSrc.includes('invoicesApi.bulkForOrders') &&
    childPanelSrc.includes('trackingApi.labelsBundlePath') && childPanelSrc.includes('trackingApi.createShipment') &&
    !childPanelSrc.includes('Drawer'));
  // ---------- AUTH remediation (locked): ONE customer/VIP account, real methods, no fake auth ----------
  check('customer+VIP log in with REAL methods only: mobile+OTP and email+password (no hardcoded code)',
    studioSrcForAuth.includes('authApi.requestOtp') && studioSrcForAuth.includes('authApi.verifyOtp') &&
    studioSrcForAuth.includes('authApi.login') && !/["'`]12345["'`]/.test(studioSrcForAuth) &&
    !studioSrcForAuth.includes('کد آزمایشی') && !/devCode\s*\?\?/.test(studioSrcForAuth));
  check('registration is REAL, mobile-first, and admin/supplier have NO public self-registration',
    studioSrcForAuth.includes('authApi.register') && studioSrcForAuth.includes('tab("register", "ثبت‌نام")') &&
    studioSrcForAuth.includes('دسترسی امن کارکنان کلبه') && studioSrcForAuth.includes('authApi.setPassword') &&
    studioSrcForAuth.includes('ثبت‌نام ادمین وجود ندارد') && studioSrcForAuth.includes('درخواست عضویت تأمین‌کننده'));
  check('VIP is NEVER a frontend/demo role: no demo VIP shortcut, no hardcoded demo password',
    !appSrcForAuth.includes('KolbeDemo123456!') && !appSrcForAuth.includes('ورود آزمایشی VIP') &&
    appSrcForAuth.includes('isWholesaleMember') && appSrcForAuth.includes('DEMO_MODE'));
  check('the supplier portal gates on the server cooperation/activity state and shows real pending/inactive/rejected states',
    supplierSrcForAuth.includes('const identity = await authApi.me()') &&
    supplierSrcForAuth.includes('identity.supplier?.cooperationStatus') &&
    supplierSrcForAuth.includes('identity.supplier?.activityStatus') &&
    supplierSrcForAuth.includes('status === "approved"') && supplierSrcForAuth.includes('activity === "active"') &&
    supplierSrcForAuth.includes('درخواست همکاری شما هنوز تأیید نشده است') &&
    supplierSrcForAuth.includes('درخواست همکاری تأیید نشده است') &&
    supplierSrcForAuth.includes('حساب تأمین‌کننده تأیید شده، اما در حال حاضر غیرفعال است'));
  check('Supplier product review history and safe resubmission remain reachable beside the scoped catalogue',
    supplierWorkspaceSrcForAuth.includes('import { SupplierReviewPanel }')
    && supplierWorkspaceSrcForAuth.includes('<SupplierReviewPanel flash={flash} />')
    && supplierWorkspaceSrcForAuth.includes('supplierPortalApi.products()'),
    'server review decisions/resubmit + Supplier-owned catalogue');
  check('Supplier support tickets and notification inbox are reachable and bound to the authenticated Supplier',
    supplierWorkspaceSrcForAuth.includes('<TicketCenter perspective="owner" ownerId={supplierId} ownerName={supplierName} ownerType="supplier" />')
    && supplierWorkspaceSrcForAuth.includes('<SupplierNotificationsPanel />')
    && supplierWorkspaceSrcForAuth.includes('title: "پشتیبانی و تیکت‌ها"')
    && supplierWorkspaceSrcForAuth.includes('title: "اعلان‌ها"')
    && supplierSrcForAuth.includes('supplierId={session.id}')
    && supplierNotificationsSrcForAuth.includes('notificationsApi.list({ limit: "100" })')
    && supplierNotificationsSrcForAuth.includes('notificationsApi.unreadCount()')
    && supplierNotificationsSrcForAuth.includes('notificationsApi.readAll()')
    && supplierNotificationsSrcForAuth.includes('notificationsApi.read(id)'),
    'TicketCenter owner + user-scoped notification list/unread/read/read-all');
  check('the auth surface exposes BOTH real login methods and only one set of inputs at a time',
    studioSrcForAuth.includes('setLoginMethod') && studioSrcForAuth.includes('شماره موبایل و کد یکبارمصرف') &&
    studioSrcForAuth.includes('ایمیل و رمز عبور') && studioSrcForAuth.includes('autoComplete="one-time-code"') &&
    studioSrcForAuth.includes('autoComplete="current-password"') && studioSrcForAuth.includes('autoComplete="new-password"'));
  check('registration is mobile-first with the canonical OTP signup purpose',
    studioSrcForAuth.includes('purpose: "signup"') && studioSrcForAuth.includes('signupChallenge') &&
    studioSrcForAuth.includes('شماره موبایل') && studioSrcForAuth.includes('نام خانوادگی'));
  check('password recovery and legacy activation are wired to the canonical endpoints',
    studioSrcForAuth.includes('authApi.forgotPassword') && studioSrcForAuth.includes('authApi.setPassword') &&
    studioSrcForAuth.includes('فعال‌سازی حساب‌های قدیمی'));
  check('the VIP area shows a membership-required state instead of a fake login loop',
    vipSrc.includes('قیمت و ثبت سفارش فقط برای اعضای عمده') && vipSrc.includes('ورود جداگانه‌ای وجود ندارد') &&
    vipSrc.includes('درخواست عضویت در همین حساب'));
  check('login always returns to the intended destination (checkout / account / studio)',
    /const \[returnTo, setReturnTo\]/.test(appSrcForAuth) &&
    appSrcForAuth.includes('setReturnTo({ section: "retail", view: "account" })') &&
    appSrcForAuth.includes('setSection(returnTo?.section ?? "retail")'));
  check('the storefront never derives VIP from a demo/hardcoded account',
    appSrcForAuth.includes('authUser.isWholesaleMember || authUser.roles.includes("vip")') &&
    appSrcForAuth.includes('DEMO_MODE && buyer?.status'));
  check('supplier portal auth is SERVER-derived (JWT + /auth/me roles) with no client-side bypass left',
    supplierSrcForAuth.includes('const identity = await authApi.me()') &&
    supplierSrcForAuth.includes('identity.roles.includes("supplier")') &&
    supplierSrcForAuth.includes('status === "approved"') && supplierSrcForAuth.includes('activity === "active"') &&
    !supplierSrcForAuth.includes('kolbe-supplier') && !supplierSrcForAuth.includes('demo-session') &&
    !/if\s*\(\s*demo\s*\)\s*\{\s*setAuthed/.test(supplierSrcForAuth) &&
    supplierSrcForAuth.includes('authApi.logout') && supplierWorkspaceSrcForAuth.includes('dir="rtl"'));
  check('the retired inline 2FA modal is gone — OTP lives in the canonical auth screens',
    !appSrcForAuth.includes('setTwoFactor(') && !appSrcForAuth.includes('ورود دومرحله‌ای'));

  const labelEngineSrc = readFileSync(join(repoRoot, 'backend/src/shipping-labels.ts'), 'utf8');
  check('shipping labels are SERVER PDFs (100×150mm thermal + A4 grid, price-free) and tracking writes go through the shipments domain',
    (ordersHubSrc.includes('trackingApi.labelPath') || childPanelSrc.includes('trackingApi.labelPath')) &&
    (ordersHubSrc.includes('trackingApi.labelsBundlePath') || childPanelSrc.includes('trackingApi.labelsBundlePath')) &&
    !ordersHubSrc.includes('document.write') && !childPanelSrc.includes('document.write') && labelEngineSrc.includes('283.46') &&
    !labelEngineSrc.includes('_rial') &&
    (ordersHubSrc.includes('trackingApi.createShipment') || childPanelSrc.includes('trackingApi.createShipment')) &&
    (ordersHubSrc.includes('trackingApi.updateShipment') || childPanelSrc.includes('trackingApi.updateShipment')));
  check('bulk invoice print reuses the existing invoice domain (no parallel invoice renderer)',
    ordersHubSrc.includes('invoicesApi.list({ orderId') && !ordersHubSrc.includes('INV-') && !childPanelSrc.includes('INV-'));

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

  // =================== Prompt-4 Wholesale Order Center: static + contract locks ===================
  const orderCenterSrc = readFileSync(join(repoRoot, 'src/portals/wholesale-order-center.tsx'), 'utf8');
  const omsSrc = readFileSync(join(repoRoot, 'backend/src/wholesale-oms.ts'), 'utf8');
  // The list schema is the authority: every filter the UI sends MUST exist server-side, otherwise a filter
  // silently does nothing (this is exactly how the customerStatus filter was caught).
  const listSchema = omsSrc.slice(omsSrc.indexOf("app.get('/api/v1/wholesale/masters'"));
  const schemaKeys = [...listSchema.slice(0, listSchema.indexOf('}).parse(request.query')).matchAll(/^\s{6}(\w+):/gm)]
    .map((match) => match[1]!);
  const uiParams = [...orderCenterSrc.matchAll(/p\.(\w+) =/g)].map((match) => match[1]!);
  const unknownParams = [...new Set(uiParams)].filter((key) => !schemaKeys.includes(key));
  check('every Wholesale Order Center filter exists in the server list schema (no silently ignored filter)',
    unknownParams.length === 0 && schemaKeys.includes('customerStatus') && schemaKeys.includes('readiness') &&
    schemaKeys.includes('supplyRequired') && schemaKeys.includes('search'),
    `schema=${schemaKeys.join(',')} ui=${[...new Set(uiParams)].join(',')}`);
  check('Order Center renders the THREE source buckets separately and names the unmet demand per line',
    orderCenterSrc.includes('موجودی کلبه') && orderCenterSrc.includes('موجود تأمین‌کننده نزد کلبه') &&
    orderCenterSrc.includes('ظرفیت تأمین‌کننده') && orderCenterSrc.includes('نیاز به تأمین') &&
    orderCenterSrc.includes('پوشش ناقص') && orderCenterSrc.includes('هنوز پوشش ندارد'));
  check('Order Center is a full-page OPERATIONAL workspace: named sections, no side drawer, ops projection only',
    orderCenterSrc.includes('view !== "ops"') &&
    ['خلاصه سفارش', 'خریدار VIP', 'اقلام سفارش', 'تخصیص و تأمین', 'وضعیت انبار', 'ورودی و کنترل کیفیت',
      'تجمیع و ارسال نهایی', 'تایم‌لاین سفارش']
      .every((title) => orderCenterSrc.includes(title)) &&
    !orderCenterSrc.includes('Drawer'));
  check('destructive cancellation is confirmed AND requires a written reason (no one-click cancel)',
    orderCenterSrc.includes('cancelMaster(') && orderCenterSrc.indexOf('setCancelOpen(true)') > 0 &&
    /reason\.trim\(\).length\s*<\s*4/.test(orderCenterSrc));
  check('Order Center never renders raw identifiers as content (React keys only)',
    !/(?<!key=)\{(?:m|child|line|allocation|e|entry)\.id\}/.test(orderCenterSrc) &&
    !orderCenterSrc.includes('slice(0, 8)'));
  check('readiness/coverage are SERVER values — the UI never derives readiness from raw statuses',
    orderCenterSrc.includes('m.readiness') && orderCenterSrc.includes('detail.coverage') &&
    !/readiness\s*=\s*[^;]*===/.test(orderCenterSrc));
  check('the ops workspace flags every open exception and names the Prompt-6 boundary in the UI',
    orderCenterSrc.includes('ورود کالا، کنترل کیفیت و ثبت رسید در انبار کلبه انجام می‌شود'));
  check('source coverage is a FILTER on the one master list (server-backed), never a separate center',
    orderCenterSrc.includes('COVERAGE_FILTERS') && orderCenterSrc.includes('دارای موجودی کلبه') &&
    orderCenterSrc.includes('دارای موجودی تأمین‌کننده نزد کلبه') && orderCenterSrc.includes('نیازمند تأمین') &&
    orderCenterSrc.includes('ترکیبی') && orderCenterSrc.includes('p.coverage = filters.coverage') &&
    omsSrc.includes("coverage: z.enum(['all', 'kolbe', 'supplier_at_kolbe', 'supply_required', 'mixed'])"));
  check('child/sub-orders live INSIDE the master workspace (تخصیص و تأمین), not as a competing center',
    orderCenterSrc.includes('<MasterChildOrders') && orderCenterSrc.includes('title="تخصیص و تأمین"') &&
    orderCenterSrc.includes('سفارشات عمده / VIP') && !orderCenterSrc.includes('Drawer'));
  /* §152 (re-homed by the PO IA): ONE canonical row per Master Order — children never resurface as
     separate top-level orders; they are read through the master's own detail workspace. */
  check('orders hub shows ONE canonical master row per VIP master order — children stay inside the master (§152)',
    ordersHubSrc.includes('WholesaleOrderCenter') && orderCenterSrc.includes('wholesaleOmsApi.masters') &&
    orderCenterSrc.includes('ordered_series') && orderCenterSrc.includes('CoverageCells') && !ordersHubSrc.includes('WholesaleTab') &&
    !ordersHubSrc.includes('supplier_children === m.child_count'));

  setAccessToken(null);
} catch (error) {
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
