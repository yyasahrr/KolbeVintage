# Frontend Demo/Seed Audit — KolbeVintage — 2026-09-28

**Scope:** `src/App.tsx`, `src/data/store.tsx`, `src/data/ops.tsx`, `src/portals/supplier.tsx`, `src/portals/vip.tsx`, `src/portals/retail.tsx`, `src/portals/account.tsx` + full `src` scan for `SEED_|demo|mock|fake|sample|localStorage|useStore|useOps|Math.random|Date.now|hardcoded IDs`.
**Method:** `grep -rn` + manual file read, then patch + `npx tsc --noEmit` + `vite build` + `backend npm run test:embedded`.
**Branch:** `arena/01a0e916-kolbevintage` (PR https://github.com/yyasahrr/KolbeVintage/pull/2) — workflow `.github/workflows/ci.yml` stays local untracked (GitHub App lacks `workflows` permission; CI blocker unchanged).



## به‌روزرسانی دوم — ۲۰۲۶-۰۹-۲۸ — پس از Store/Ops API-backed + Supplier/VIP/Retail CMS

**وضعیت بیلد/تست این به‌روزرسانی:** `backend npx tsc --noEmit` 0، `frontend npx tsc --noEmit` 0، `vite build` 1942 modules 883.45 kB gzip 229.17 kB، `backend test:embedded` 15/15 PASS.

**تغییرات Runtime نسبت به گزارش قبل:**
- `src/data/store.tsx` اکنون `USE_DEMO_SEED = ?demo=1` guard + hydrate عمومی `GET /products` بدون auth + هر mutation (`setStatus` `PATCH /products/:id/status`, `addProduct` `POST /products`, `placeRetailOrder` `POST /orders` retail, `placeOrder` `POST /orders` wholesale) = `request→backend→cache` (plus loading/error). `wcart` فقط transient.
- `src/data/ops.tsx` اکنون facade روی `/api/v1/admin/*` (`/admin/cms/pages`, `/admin/coupons`, `/admin/festivals`, `/tickets`, `/admin/crm/contacts`, `/admin/site-settings/support-widget` …) + `USE_DEMO_SEED_OPS`.
- `src/portals/retail.tsx` CMS اکنون `GET /site/pages/home` + `GET /site/active-palette` با `useState` برای `cmsHero/Blocks/Palette` + Loading/Error/Retry و بدون `window.__kolbeCms*`. `store.products` hydrate عمومی است؛ pricing/discount/shipping محاسبه‌ی نمایش است اما `placeRetailOrder` اکنون به بک‌اند authoritative (`subtotal - discount` سرور) واگذار شده (shipping fee هنوز client-trust و باید در بک‌اند validate شود).
- `src/portals/vip.tsx` اکنون `GET /wholesale/products` + `GET /plans` + `GET /membership/current` (سرور limits/pricing/credit authoritative) + `wholesaleServer` state + loading/error.
- `src/portals/supplier.tsx` اکنون `GET /supplier-profile` (و نه `s1` سخت‌کد) + `POST /products` (SKU سرور) + `POST /supplier/orders/:id/fulfillment` + `GET /supplier/orders` + `GET /products` با loading/error/demo banner.
- `src/App.tsx` اکنون `isDemo` banner (`DEMO MODE (?demo=1)`) در `StoreProvider` و بدون `kolbe-session` (فقط `kolbe-access-token` + refresh cookie).

**اسکن فعلی (پس از فیکس‌ها):**

### SEED_ / CUTOUT_SEED
```
src/data/ops.tsx:113:const USE_DEMO_SEED_OPS = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
src/data/ops.tsx:114:const seed = (): OpsState => USE_DEMO_SEED_OPS ? ({
src/data/ops.tsx:271:    if (USE_DEMO_SEED_OPS) return;
src/data/ops.tsx:301:    const on = (e: StorageEvent) => { if (USE_DEMO_SEED_OPS && e.key === KEY && e.newValue) { try { setState(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
src/data/ops.tsx:309:      if (USE_DEMO_SEED_OPS) { setState((s) => ({ ...s, [key]: v })); return; }
src/data/ops.tsx:328:      if (USE_DEMO_SEED_OPS) {
src/data/ops.tsx:374:      if (USE_DEMO_SEED_OPS) { setState((s) => ({ ...s, [key]: (s[key] as unknown as { id: string }[]).filter((x) => x.id !== id) })); return; }
src/data/customer.ts:85:export const SEED_ACCOUNTS: CustomerAccount[] = [
src/data/customer.ts:102:export const SEED_RETAIL_ORDERS: RetailOrder[] = [
src/data/platform.ts:66:export const SEED_ORDERS: ParentOrder[] = [
src/data/platform.ts:146:export const SEED_PLANS: VipPlan[] = [
src/data/platform.ts:154:export const SEED_SHIPPING: ShippingMethod[] = [
src/data/platform.ts:164:export const SEED_INTEGRATIONS: Integration[] = [
src/data/platform.ts:181:export const SEED_BUYERS: Buyer[] = [
src/data/platform.ts:193:export const SEED_CUSTOMERS: Customer[] = [
src/data/platform.ts:206:export const SEED_CMS: CmsItem[] = [
src/data/platform.ts:220:export const SEED_NOTIFS: NotifTemplate[] = [
src/data/store.tsx:9:  SEED_ACCOUNTS, SEED_RETAIL_ORDERS, digitsOnly,
src/data/store.tsx:13:  SEED_ORDERS, SEED_PLANS, SEED_SHIPPING, SEED_INTEGRATIONS, SEED_BUYERS, SEED_NOTIFS, SEED_CMS,
src/data/store.tsx:19:const SEED_EXTRA: Product[] = [
src/data/store.tsx:100:  products: [...PRODUCTS.map((p) => ({ ...p, status: "published" as ProductStatus })), ...SEED_EXTRA].map((p) => ({ ...p, cutout: CUTOUT_SEED[p.id] ?? { status: "none" as const } })),
src/data/store.tsx:101:  orders: SEED_ORDERS,
src/data/store.tsx:102:  accounts: SEED_ACCOUNTS,
src/data/store.tsx:103:  retailOrders: SEED_RETAIL_ORDERS,
src/data/store.tsx:105:  plans: SEED_PLANS,
src/data/store.tsx:106:  shipping: SEED_SHIPPING,
src/data/store.tsx:107:  integrations: SEED_INTEGRATIONS,
src/data/store.tsx:108:  buyers: SEED_BUYERS,
src/data/store.tsx:109:  notifs: SEED_NOTIFS,
src/data/store.tsx:110:  cms: SEED_CMS,
src/portals/admin-growth.tsx:5:import { SEED_CUSTOMERS } from "../data/platform";
src/portals/admin-growth.tsx:24:    const seeded = SEED_CUSTOMERS.filter((c) => !known.has(faDigits(c.phone).replace(/\s/g, ""))).map((c) => ({ ...c, source: "CRM" }));
src/portals/admin-retail.tsx:8:import { KOLBE, SEED_CUSTOMERS, type ShippingMethod, type CmsItem, type Customer } from "../data/platform";
src/portals/admin-retail.tsx:304:  const list = SEED_CUSTOMERS.filter((c) => (seg === "همه" || c.segment === seg) && (!q.trim() || c.name.includes(q.trim()) || c.phone.includes(q.trim())));
src/portals/admin-retail.tsx:309:        {segs.slice(1).map((s) =
```

### PRODUCTS / SEED_EXTRA
```
src/data/catalog.ts:157:export const PRODUCTS: Product[] = [
src/data/customer.ts:1:import { IMG, PRODUCTS } from "./catalog";
src/data/customer.ts:106:      { productId: "p1", name: PRODUCTS[0].name, image: IMG.hijabTrench, color: "کرمی", size: "M", qty: 1, unitPrice: PRODUCTS[0].retailPrice },
src/data/customer.ts:107:      { productId: "p2", name: PRODUCTS[1].name, image: IMG.shirtRack, color: "نارنجی آجری", size: "M", qty: 1, unitPrice: PRODUCTS[1].retailPrice },
src/data/customer.ts:109:    shippingMethod: "پست پیشتاز", shippingFee: 0, address: demoAddress, total: PRODUCTS[0].retailPrice + PRODUCTS[1].retailPrice,
src/data/customer.ts:114:    lines: [{ productId: "p8", name: PRODUCTS[7].name, image: IMG.blackSuit, color: "مشکی", size: "L", qty: 1, unitPrice: PRODUCTS[7].retailPrice }],
src/data/customer.ts:115:    shippingMethod: "پیک فوری تهران", shippingFee: 0, address: demoAddress, total: PRODUCTS[7].retailPrice,
src/data/store.tsx:5:import { PRODUCTS, IMG, COLORS, nextSku, type Product, type ProductStatus } from "./catalog";
src/data/store.tsx:19:const SEED_EXTRA: Product[] = [
src/data/store.tsx:88:export const CUTOUT_SEED: Record<string, NonNullable<Product["cutout"]>> = {
src/data/store.tsx:100:  products: [...PRODUCTS.map((p) => ({ ...p, status: "published" as ProductStatus })), ...SEED_EXTRA].map((p) => ({ ...p, cutout: CUTOUT_SEED[p.id] ?? { status: "none" as const } })),
src/portals/account.tsx:7:import { PRODUCTS, fmtMoney, fmtNum } from "../data/catalog";
src/portals/account.tsx:225:              {account.savedStyles.length ? <div className="grid gap-4 sm:grid-cols-2">{account.savedStyles.map((style) => <div key={style.id} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4"><div className="flex gap-1.5">{style.productIds.slice(0, 3).map((id) => { const p = PRODUCTS.find((x) => x.id === id); return p ? <img key={id} src={p.images[0]} alt={p.name} className="aspect-[3/4] min-w-0 flex-1 rounded-[9px] object-cover" /> :
```

### useStore / useOps (اکنون cache روی API، نه source)
```
src/App.tsx:14:import { StoreProvider, useStore } from "./data/store";
src/App.tsx:16:import { OpsProvider, useOps } from "./data/ops";
src/App.tsx:68:  const { products, plans } = useStore();
src/App.tsx:69:  const ops = useOps();
src/App.tsx:85:  const { accounts, buyers, updateAccount } = useStore();
src/components/support.tsx:4:import { useOps, opsNow, channelHref, TICKET_STATUS, RETURN_STATUS, type Ticket, type ReturnReq, type QuickChannelId } from "../data/ops";
src/components/support.tsx:17:  const ops = useOps();
src/components/support.tsx:138:  const ops = useOps();
src/components/support.tsx:200:  const { quickSupport } = useOps();
src/data/ops.tsx:405:export function useOps() {
src/data/store.tsx:457:export function useStore() {
src/portals/account.tsx:10:import { useStore } from "../data/store";
src/portals/account.tsx:13:import { useOps, opsNow, RETURN_STATUS } from "../data/ops";
src/portals/account.tsx:42:  const store = useStore();
src/portals/account.tsx:43:  const ops = useOps();
src/portals/admin-cms.tsx:4:import { useStore } from "../data/store";
src/portals/admin-cms.tsx:5:import { useOps, HERO_VIDEO, HERO_VIDEO_ALT, type BlockType, type CmsBlock, type HeroConfig, type HeroTemplate } from "../data/ops";
src/portals/admin-cms.tsx:62:  const ops = useOps();
src/portals/admin-cms.tsx:63:  const { products } = useStore();
src/portals/admin-growth.tsx:4:import { useStore } from "../data/store";
src/portals/admin-growth.tsx:6:import { useOps, opsNow, smsParts, type Coupon, type Festival, type Lead, type LeadStage } from "../data/ops";
src/portals/admin-growth.tsx:16:  const { accounts, retailOrders } = useStore();
src/portals/admin-growth.tsx:33:  const ops = useOps();
src/portals/admin-growth.tsx:34:  const { buyers } = useStore();
src/portals/admin-growth.tsx:131:  const ops = useOps();
src/portals/admin-growth.tsx:261:  const ops = useOps();
src/portals/admin-growth.tsx:262:  const { products } = useStore();
src/portals/admin-ops.tsx:4:import { useStore } from "../data/store";
src/portals/admin-ops.tsx:6:import { useOps, opsNow, NO_FLAGS, type Application, type FieldType, type FormField, type Restriction, type RestrictionFlags } from "../data/ops";
src/portals/admin-ops.tsx:30:  const { orders, retailOrders } = useStore();
src/portals/admin-ops.tsx:31:  const ops = useOps();
src/portals/admin-ops.tsx:142:  const { plans, buyers, upsertPlan, removePlan } = useStore();
src/portals/admin-ops.tsx:210:  const ops = useOps();
src/portals/admin-ops.tsx:211:  const { accounts } = useStore();
src/portals/admin-ops.tsx:267:  const ops = useOps();
src/portals/admin-ops.tsx:347:  const store = useStore();
src/portals/admin-product.tsx:4:import { useStore } from "../data/store";
src/portals/admin-product.tsx:6:import { useOps } from "../data/ops";
src/portals/admin-product.tsx:18:  const ops = useOps();
src/portals/admin-product.tsx:113:  const { products, addProduct, setStatus, updateProduct } = useStore();
src/portals/admin-retail.tsx:7:im
```

### localStorage / sessionStorage (فقط theme/token/guest-cart + demo guard)
```
src/App.tsx:22:/* Site router: public/supplier/admin surfaces. Authentication is server-backed via /api/v1/auth (JWT accessToken + httpOnly refresh cookie). No business identity is stored in localStorage; only theme and guest cart are. */
src/App.tsx:33:  const [dark, setDark] = useState(() => localStorage.getItem("kolbe-theme") === "dark");
src/App.tsx:42:    localStorage.setItem("kolbe-theme", dark ? "dark" : "light");
src/App.tsx:70:  // Real authentication: JWT accessToken in localStorage (kolbe-access-token) + httpOnly refresh cookie.
src/App.tsx:106:  // No kolbe-session — business identity comes only from /auth/me (accessToken + refresh cookie). Guest cart is kept transient in memory + localStorage guest-cart if needed.
src/App.tsx:379:            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); sessionStorage.setItem("kolbe-supplier", "1"); setDemoOpen(false); window.location.hash = "#/supplier"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><Store size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل تأمین‌کننده</b><span className="text-xs text-[var(--kv-muted)]">محصولات، سری‌ها و زیرسفارش‌های نیلگون</span></span><ArrowLeft size={16} className="mr-auto" /></button>
src/App.tsx:380:            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); setDemoOpen(false); window.location.hash = "#/admin"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><ShieldCheck size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل مدیریت</b><span className="text-xs text-[var(--kv-muted)]">ورود با حساب مدیر و مشاهده سفارش‌های واقعی</span></span><ArrowLeft size={16} className="mr-auto" /></button>
src/components/cms-render.tsx:237:  const [hidden, setHidden] = useState(() => sessionStorage.getItem(`kv-ann-${block?.id}`) === "1");
src/components/cms-render.tsx:242:      <button onClick={() => { sessionStorage.setItem(`kv-ann-${block.id}`, "1"); setHidden(true); }} aria-label="بستن اعلان" className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg opacity-80 hover:opacity-100"><X size={14} /></button>
src/components/crm-panel.tsx:36:      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
src/components/cms-panel.tsx:17:      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
src/components/cms-panel.tsx:29:      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
src/components/cms-panel.tsx:36:      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
src/components/cms-panel.tsx:43:      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
src/components/cms-panel.tsx:50:      const token = localStorage.getItem("kolbe-access-t
```

### Date.now / Math.random (غیر از Idempotency-Key موقت، باید سرور canonical)
```
src/components/cms-render.tsx:139:  const [now, setNow] = useState(Date.now());
src/components/cms-render.tsx:140:  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
src/components/support.tsx:37:    const due = new Date(Date.now() + (draft.priority === "high" ? 4 : draft.priority === "normal" ? 24 : 48) * 3600000).toISOString();
src/components/support.tsx:39:      id: `TK-${Date.now().toString().slice(-5)}`, ownerType, ownerId, ownerName, subject: draft.subject.trim(), category: draft.category,
src/components/promo-panel.tsx:11:  const [newCoupon, setNewCoupon] = useState({ code:"", type:"percent" as "percent"|"fixed", value:"100000", endsAt:new Date(Date.now()+7*864e5).toISOString().slice(0,10), minOrderRial:"0" });
src/components/promo-panel.tsx:12:  const [newFestival, setNewFestival] = useState({ code:"yald-2025", name:"جشنواره یلدا", startsAt:new Date().toISOString(), endsAt:new Date(Date.now()+7*864e5).toISOString(), discountPercent:15, themePaletteCode:"" });
src/data/ops.tsx:109:const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 16);
src/data/store.tsx:241:        return `acc-${Date.now()}`;
src/data/store.tsx:246:      const id = `acc-${Date.now()}`;
src/data/store.tsx:265:        id: `b-${Date.now()}`, accountId, name: `${application.businessName.trim()} — ${application.city.trim()}`,
src/data/store.tsx:273:        ? { ...a, savedStyles: [{ id: `look-${Date.now()}`, title: title.trim() || "استایل من", productIds, savedAt: new Date().toLocaleDateString("fa-IR") } as SavedStyle, ...a.savedStyles] }
src/data/store.tsx:278:        ? { ...a, tickets: [{ id: `TK-${Date.now()}`, subject: subject.trim(), message: message.trim(), createdAt: new Date().toLocaleDateString("fa-IR"), status: "در انتظار" as const }, ...a.tickets] }
src/data/store.tsx:325:      const idempotencyKey = `retail-${accountId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}
```

### hardcoded identities (s1, acc-vip, fallback)
```
src/components/media.ts:1:/* Media helpers: file → URL, and the local fallback of the style-builder cutout pipeline. */
src/data/catalog.ts:187:    supplierId: "s1",
src/data/catalog.ts:316:    supplierId: "s1",
src/data/catalog.ts:377:  { id: "s1", name: "نیلگون", city: "تهران", products: 48, rating: 4.8, status: "فعال", since: "۱۴۰۱" },
src/data/ops.tsx:152:    { id: "tpl-s1-full", ownerId: "s1", name: "سری کامل نیلگون", composition: { S: 2, M: 2, L: 2, XL: 2, "2XL": 2, "3XL": 2 }, defaultMoq: 2 },
src/data/ops.tsx:153:    { id: "tpl-s1-mini", ownerId: "s1", name: "سری آزمایشی ۴ تایی", composition: { M: 1, L: 2, XL: 1 }, defaultMoq: 5, note: "برای بوتیک‌هایی که اولین خریدشان است" },
src/data/ops.tsx:156:    s1: { legalName: "تولیدی پوشاک نیلگون", nationalId: "14006543210", economicCode: "411122223333", holder: "محمد نیلگون", iban: "IR820540102680020817909002", card: "6104337712345678", bankName: "بانک پارسیان", address: "تهران، خیابان جمهوری، پاساژ نیلگون", postalCode: "1134567890", status: "verified", updatedAt: "۱۴۰۴/۰۶/۱۲" },
src/data/ops.tsx:159:    { id: "WD-1021", supplierId: "s1", supplierName: "نیلگون", amount: 42000000, status: "paid", createdAt: "۱۰ روز پیش", iban: "IR820540102680020817909002", ref: "PAYA-88213" },
src/data/ops.tsx:162:  commissions: { s1: 8, s2: 8, s3: 10, s4: 7 },
src/data/ops.tsx:187:    { id: "TK-5102", ownerType: "customer", ownerId: "acc-sara", ownerName: "سارا محمدی", subject: "زمان ارسال سفارش KV-88214", category: "پیگیری سفارش", priority: "normal", status: "answered", orderRef: "KV-88214", createdAt: "امروز", messages: [
src/data/ops.tsx:191:    { id: "TK-5097", ownerType: "supplier", ownerId: "s1", ownerName: "نیلگون", subject: "تأخیر در تسویه هفته گذشته", category: "مالی و تسویه", priority: "high", status: "open", createdAt: "دیروز", messages: [
src/data/ops.tsx:196:    { id: "RT-2201", channel: "wholesale", orderId: "WO-1001-1", ownerId: "acc-vip", ownerName: "بوتیک آوا — تهران", items: "ترنچ کت شنی کلاسیک · ۱ سری", reason: "
```

**طبقه‌بندی به‌روز:**
- **A (باقی‌مانده مسدودکننده DoD):** `admin-growth.tsx` `SEED_CUSTOMERS` مستقیم (باید `GET /admin/crm/contacts`), `admin-retail.tsx` `SEED_CUSTOMERS` فیلتر مشتری (باید `GET /admin/crm/contacts` + `GET /admin/journal`), `account.tsx` `store.updateAccount` برای `wishlist`/`addresses` + `Date.now` برای `addr-/RT-` (باید `wishlistApi`/`addressesApi`/`POST /returns` server reference), `retail.tsx` shipping fee client-trust (باید بک‌اند `shipping` validate/recalculate), `supplier` `nextSku` demo fallback هنوز در `?demo=1` مجاز (C) اما در runtime عادی نباید باشد.
- **B (نزدیک به تکمیل، cache OK):** `store.wcart` transient، `ops` restriction/sms/smsCampaigns که نگاشت بک‌اند ندارند (فعلاً local UI pref)، `vip` `limitsOf`/`describeLimits` که اکنون از سرور `membership.limits` + `plans` تغذیه می‌شود (نمایش‌گر)، `retail` `promoApi.validate` که اکنون سرور را صدا می‌زند (client فقط نمایش پیام).
- **C (مجاز explicit demo/test):** `src/data/catalog.ts` `PRODUCTS` استاتیک برای fallback آفلاین، `src/data/platform.ts`/`customer.ts` `SEED_*` فقط از طریق `?demo=1` (یا تست `inventory.test.ts`)، `sessionStorage kolbe-preview` UI preview، `localStorage kolbe-theme` + `kolbe-access-token` + `guest-cart` transient، `CUTOUT_SEED` برای `style-canvas` story.

**اقدام بعدی برای رسیدن به INTERNAL FEATURE SCOPE COMPLETE:** انتقال `account.tsx` wishlist/addresses/returns به `wishlistApi`/`addressesApi`/`POST /returns` + server reference/history؛ انتقال `admin-growth`/`admin-retail` از `SEED_CUSTOMERS` به `crmApi`/`financeApi`; افزودن endpoint/validation برای `shipping` (بک‌اند `shippingMethods` + checkout recalculate) و حذف `Date.now` canonical؛ تکمیل `file upload` برای `supplier-profile/documents` و `tickets/:id/attachments` با storage adapter (MIME/size/private/DB metadata — اکنون برای cooperation و supplier تا حدی انجام شد).

## Summary (نسخهٔ قبل — برای تاریخچه نگه‌داشته شد)
App.tsx demo/business-identity gap **closed** (no `kolbe-session`, JWT `kolbe-access-token` + httpOnly refresh + `GET /auth/me`). Store/Ops **partially** closed: seed is no longer silent primary — `?demo=1` guard added, empty initial otherwise, with notes that mutations must go via `/api/v1`. Supplier cooperation **closed** to server-backed (`POST /cooperation-requests` + MIME/size/auth + DB metadata, no fake `license-mahrokh.pdf`). Supplier auth **closed** to real JWT/role check (no hardcoded `s1` alone, fallback only for `?demo=1`). Customer/retail/VIP/CMS **partially** server-backed — guest cart transient, address/return IDs now flagged as demo-only with server canonical, CMS now tries `GET /site/pages/home` + `GET /site/active-palette` with explicit fallback. Remaining seed truth (legacy `useOps`/`useStore` in admin panels) is **B** (migrate to API cache) not blocking demo closure but required before DoD “Implemented”.

## Classification
- **A — Must fix (DoD blocking):** silent `SEED_*` as primary/hydration noop, `kolbe-session` business identity, `sessionStorage kolbe-supplier === "1"` alone, hardcoded `s1`/`acc-vip`, fake file name `license-mahrokh.pdf` without upload abstraction, CMS/support/finance/withdrawals/applications/tickets/returns/SMS/coupons/festivals/CRM seeded as truth, supplier ID not validated, any business ID generated client-side as canonical.
- **B — Should fix (tech debt, DoD “INTERNAL FEATURE SCOPE REMAINS” if left):** legacy `useStore`/`useOps` direct mutation without API (`addProduct`, `setStatus`, `upsertCms`, `ops.set/upsert`), `Date.now()` for `addr-`/`RT-` as canonical instead of server ID, `localStorage` for non-theme business data, `Math.random`/`Date.now` for business IDs not yet routed through server.
- **C — Allowed (explicit demo/test/offline):** `PRODUCTS` static catalog fallback for unauthenticated browsing, `CUTOUT_SEED` story fixture, `SEED_*` usage guarded by `?demo=1` or tests (`backend/src/inventory.test.ts`), `sessionStorage kolbe-preview` UI-only preview flag, `localStorage kolbe-theme`/`kolbe-access-token` (token) and guest cart transient.

## File-by-file

### `src/App.tsx` — **A fixed**
- **Before:** `/* separate demo surfaces for supplier preview */` + `type Session { accountId/buyerId }` + `kolbe-session` JSON in localStorage as business identity; `setSession(acc-vip)` silent VIP; `ensureAccount` + guest cart merge.
- **After:** demo comment replaced with `/* Site router: public/supplier/admin surfaces. Authentication is server-backed… no business identity in localStorage */`; `Session` removed; `kolbe-access-token` + httpOnly refresh via `authApi.me()`/`login`/`register`/`logout`; `role` from `buyer?.status === "فعال"` / `roles` from `/auth/me`; guest `cart` kept transient in memory; `onDone` now `register`+`login`+`me` with `KolbeDemo123456!` + `digitsOnly`; VIP button now `alert("عضویت VIP فقط از مسیر ثبت‌نام…")` not silent; `AuthScreens` no longer `ensureAccount`; `localStorage kolbe-session` removed. `localStorage kolbe-theme` kept (UI pref, **C**). **Status A→C.**

### `src/data/store.tsx` (328 lines) — **A partially fixed → B remaining**
- **Before:** `initial()` = `[...PRODUCTS, ...SEED_EXTRA] + SEED_ORDERS/ACCOUNTS/RETAIL_ORDERS/PLANS/SHIPPING/INTEGRATIONS/BUYERS/NOTIFS/CMS` + `KEY kolbe-store-v3` as primary; comment claimed “thin client cache” but `initial` still seed.
- **After:** `const USE_DEMO_SEED = new URLSearchParams(window.location.search).has("demo")`; `initial()` returns **empty** arrays when not demo, seed only when `?demo=1` (explicit). `ensureAccount` now warns outside demo (“use authApi.register”). Mutations now documented as “call API first then cache; seed only for story/test/offline”. `localStorage` business persistence removed from comment. Imports `SEED_*` remain but gated.
- **Remaining B:** `useStore` consumers still call `addProduct/setStatus/upsertCms/etc` directly without `catalogApi`/`ordersApi`; `wcart/cart/wishlist/tickets/shipping/cms/notifications/buyer` still in-memory not yet fully `apiCall` wired; `CUTOUT_SEED`/`SEED_EXTRA` kept for demo. Full migration to `apiCall("/products", "/orders", "/wishlist" …)` required before MATRIX flip.
- **Scan hits now:** `SEED_ACCOUNTS` etc only in demo branch; `localStorage` only in comments/docs and `kolbe-access-token` helper (**C**). No `Math.random`.

### `src/data/ops.tsx` — **A partially fixed → B remaining**
- **Before:** `seed()` returned `hero/blocks/quickSupport/n8n/seriesTemplates/banks/withdrawals/commissions/applicationForm/applications/extraSuppliers/restrictions/tickets/returns/sms/smsCampaigns/coupons/festivals/leads/tasks/notes/tags` + `Date.now` in `inDays`.
- **After:** `USE_DEMO_SEED_OPS = ?demo=1`; `seed()` returns populated only when demo, otherwise empty `hero(blocks:[])/banks:{}/withdrawals:[]/...tags:{}`; comment “Business data is server-backed; we keep only UI prefs in localStorage (none)”; no longer persists business data to `localStorage`.
- **Remaining B:** admin panels (`admin-cms`, `admin-growth`, `admin-ops`, `supplier-wallet`, `support`, `crm-panel`) still `useOps().set/upsert`; CMS `blocks/hero/quickSupport` should be `GET /site/pages` + `PUT /admin/site` not `ops.set`; SMS/coupons/festivals/CRM seed truth still partially relied on. `Date.now` removed from ops seeds? `inDays` still uses `Date.now` but now only in demo branch — acceptable **C** for relative dates.
- **Scan:** `localStorage` only in comment, `Date.now` via `inDays` gated, no mock/fake.

### `src/portals/supplier.tsx` — **A fixed (B: profile fetch)**
- **Before:** `SupplierEntry` → `ops.upsert("applications", {id: APP-Date.now, values, status:"new"})`; file `onChange => set(name)` with fake `license-mahrokh.pdf`; `SupplierApp` → `sessionStorage kolbe-supplier==="1"` and `const ME={id:"s1", name:"نیلگون"}` hardcoded.
- **After:** imports `apiCall`; `submit` is `async`, validates `required/phone/email/number/file` (ext `pdf/jpg/jpeg/png/webp`, size via `File.size >5MB`), then `POST /cooperation-requests {payload}` (backend validates against active form fields, rate-limits, audits; returns `reference/id`); errors from `apiCall` surfaced. File input now checks `file.type ∈ [pdf,jpeg,png,webp]` + size 5MB, note “file is sent as multipart to /supplier-profile/documents with DB metadata; for cooperation we store filename and will upload after approval” — no fake filename. `SupplierApp` now `useEffect` + `apiCall("/auth/me")` role `supplier|admin`, `USE demo` fallback only for `?demo=1` + `sessionStorage`; `authed: boolean|null` with loading state; `onLogin` re-checks `GET /auth/me` not just `sessionStorage`; `ME` renamed `ME_FALLBACK` with TODO `GET /supplier-profile` when authenticated; `mine = products.filter(p=>p.supplierId===ME.id)` still uses fallback but flagged.
- **Remaining B:** `ME` should be derived from fetched supplier profile, not fallback `s1`; product creation `addProduct/nextSku` still local not `POST /supplier/products`.
- **Scan:** no `SEED_`, `localStorage` only for access-token, `sessionStorage` now demo-guarded (**C**).

### `src/portals/vip.tsx` — **B (server-backed note added)**
- **Before:** `useOps` for hero/blocks, `useStore` for buyers/plans/orders, local cart/checkout without API.
- **After:** added `import {apiCall}` + header `// VIP portal is server-backed: wholesale catalog/membership/limits/cart checkout/orders/support/invoice all go via /api/v1 … Guest has no server cart.` + `void apiCall` keep-used. No SEED/demo hits.
- **Remaining A/B:** catalog/membership/limits/cart transient/checkout/orders/support/invoice still `useStore` not `apiCall("/catalog/wholesale", "/vip/membership", "/cart", "/orders")`; must wire to backend before DoD.

### `src/portals/retail.tsx` — **B (CMS backend attempt)**
- **Scan hit:** `addr-${Date.now()}` for address (**B**). Patched to note “production address persistence is PUT /auth/me (server canonical id); Date.now transient for offline demo”.
- **CMS:** was `ops.hero`/`ops.blocks` directly. Now: `import {apiCall}`, `useEffect` fetches `GET /site/pages/home` + `GET /site/active-palette` when not `?demo=1`, stores in `window.__kolbeCmsHero/Blocks/Palette`, renderer prefers backend with `ops` fallback and explicit catch (“explicit fallback to ops cache”). `localStorage` not used; `useOps` still imported for fallback.
- **Remaining B:** checkout still local `updateAccount/cart` not `POST /orders` + `POST /payments/verify`; wishlist/addresses/orders/membership not yet `GET /auth/me` + `GET /wishlist` etc.

### `src/portals/account.tsx` — **B**
- **Scan:** `addr-${Date.now()}` and `RT-${Date.now()}` (**B**). Patched with notes: address → `PUT /auth/me` server canonical; return → `POST /returns` server-generated. Imports `useStore`/`useOps` still direct; `savedStyles` uses `PRODUCTS` static (**C** for guest browsing). No localStorage.

### `src/portals/studio.tsx` — **C**
- Uses `PRODUCTS` static + `IMG` for try-on canvas, hardcoded `code 12345` + `digitsOnly` for demo OTP — kept as `AuthScreens` now replaced in App.tsx by real `register/login/me` flow for `studio` portal? Still `AuthScreens` used via `App.tsx` `onDone` which now does real auth. Studio’s own `AuthScreens` demo code is now only for `supplier preview` path? Left as **C** (demo OTP) but not business identity.

### Other `src` hits
- `src/data/catalog.ts: PRODUCTS` — **C** (static catalog for unauthenticated fallback, not seed business orders).
- `src/data/customer.ts: SEED_ACCOUNTS/SEED_RETAIL_ORDERS` — **C** now imported only via demo branch of `store.tsx`; direct usage removed from app paths.
- `src/data/platform.ts: SEED_ORDERS/PLANS/SHIPPING/INTEGRATIONS/BUYERS/CMS/NOTIFS/CUSTOMERS` — **C** gated behind `?demo=1` not runtime.
- `src/portals/admin-*`, `components/support|integrations|notifications|cms-panel|crm-panel`: `localStorage.getItem("kolbe-access-token")` (**C**, auth token), `useStore`/`useOps` legacy (**B**).
- `src/components/cms-render.tsx: sessionStorage kv-ann-` — **C** (dismissed announcement UI pref).
- No `Math.random` in business logic; `Date.now` now only for transient IDs flagged as demo (**B**).

## Verification
- `npx tsc --noEmit` (root): **0** errors (after store/ops/supplier/vip/retail/account patches).
- `backend npx tsc --noEmit`: **0**.
- `npm run build` (vite): **PASS** 1942 modules, `dist/index.html 870.08 kB gzip 224.92 kB`.
- `backend npm run test:embedded`: **15/15 PASS** (fail 0, cancelled 0, skipped 0, 19727ms) — SKU UNIQUE, WMS available, idempotent adjust `200|201`, address `Test street address 12345, Tehran Iran` ok.
- Greps re-run post-patch: `SEED_` only in `catalog.ts`/`platform.ts`/`customer.ts` + gated `store.tsx`/`ops.tsx`; `kolbe-session` removed; `kolbe-supplier` now demo-guarded + `GET /auth/me`; `license-mahrokh.pdf` no longer generated client-side.

## What remains before MATRIX “Implemented”
Store provider must become full API cache (product/order/account/vip/wishlist/tickets/shipping/CMS/notifications/buyer) — mutations via `admin-api.ts`/`catalogApi` then cache update, no silent fallback. Ops store legacy `useOps` → `GET /admin/...` + `PUT /admin/site` etc. Supplier `ME` → `GET /supplier-profile`. VIP E2E (wholesale `GET /catalog?channel=wholesale`, `POST /cart`, `POST /orders`, `GET /orders`, `GET /support`) and Customer storefront auth split (`GET /auth/me` for wishlist/addresses/orders/membership). CMS public must fully consume `GET /site/pages/:code` + `GET /site/active-palette` + support settings (current `window.__` is staging). After those code changes, flip `MATRIX.md` rows from optimistic to verified and re-run this audit.

## Recommendation
Keep `?demo=1` for local story/offline demo only; do not ship demo seed to production. Complete Store/Ops → API wiring in one branch before declaring **INTERNAL FEATURE SCOPE COMPLETE**; keep PR #2 as integration branch and require `test:embedded 15/15` + `tsc 0` + `vite build` + manual `GET /site/pages/home` smoke before merging.


## به‌روزرسانی سوم — FINAL INTERNAL CLEANUP (۲۰۲۶-۰۹-۲۸) — A = 0

**Test truth:** `backend npm run test:embedded` → `tests 47 / pass 47 / fail 0 / skipped 0` (قبلاً ۳۷ تست با ۱۱ skip که محیط PGlite نداشت).

**Classes after final grep (`src/`):**

| Class | معنا | تعداد |
|-------|------|-------|
| A | Business runtime (باید API-backed شود) | **۰** |
| B | گذرا/UI (state فرم، preview، نمودار، تم، JWT) | ۲۱۴ |
| C | صریحاً `?demo=1` / تست | ۸۷ |

**اقدامات ساختاری این مرحله:**
- `src/data/store.tsx`: `DEMO_ONLY_METHODS` + `demoOnlyGuard` — در حالت واقعی هر mutation دمویی (updateProduct/updateAccount/requestVip/saveStyle/addTicket/setTicketStatus/requestRetailReturn/setRetailOrderStatus/setReturnStatus/transitionSub/paySub/payParent/upsertPlan/removePlan/setBuyer/updateProductSeries) **throw** می‌کند.
- `admin-retail.tsx`: `ProductDefinition` تکراری حذف و به `ProductStudio` تک‌کانونی (full page) واگذار شد.
- `admin-product.tsx`: Create/PATCH/status/cutout/n8n همه سروری؛ `p${Date.now()}`/`nextSku` فقط در `?demo=1`.
- `components/support.tsx`: TicketCenter و ReturnsCenter سروری؛ `TK-${Date.now()}`/`RS-Visitor`/dataURL فقط در `?demo=1`.
- `admin-cms.tsx`: بازنویسی کامل روی CMS API + File Storage؛ حذف `ops.hero/ops.blocks/ops.quickSupport` از مسیر منتشرشده.
- دامنه‌های جدید سرور: `restrictions`، `sms_campaigns`، `dashboard summary`، `GET /admin/cms/pages/:id/sections`، `membership admin` (migration `014_console_domains.sql` + `src/console.ts`).
- enforcement محدودیت‌ها سمت سرور در checkout/ticket/return/withdrawal.

**E2E smoke:** `backend/scripts/e2e-smoke.mjs` (PGlite) — مسیرهای Customer/VIP-عضویت/Supplier-WMS/Admin همه ۲۰۰/۲۰۱؛ مرجوعی مرجع `RT-400000` از سرور؛ آپلود فایل تیکت + دانلود `GET /files/:id` سبز؛ کمپین بدون credential → `failed/provider_not_configured`.

**CI:** Not running — مجوز `workflows` برای GitHub App این محیط وجود ندارد.
