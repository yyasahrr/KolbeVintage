# Frontend Demo/Seed Audit — KolbeVintage — 2026-09-28

**Scope:** `src/App.tsx`, `src/data/store.tsx`, `src/data/ops.tsx`, `src/portals/supplier.tsx`, `src/portals/vip.tsx`, `src/portals/retail.tsx`, `src/portals/account.tsx` + full `src` scan for `SEED_|demo|mock|fake|sample|localStorage|useStore|useOps|Math.random|Date.now|hardcoded IDs`.  
**Method:** `grep -rn` + manual file read, then patch + `npx tsc --noEmit` + `vite build` + `backend npm run test:embedded`.  
**Branch:** `arena/01a0e916-kolbevintage` (PR https://github.com/yyasahrr/KolbeVintage/pull/2) — workflow `.github/workflows/ci.yml` stays local untracked (GitHub App lacks `workflows` permission; CI blocker unchanged).

## Summary
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
