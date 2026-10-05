# Kolbe Vintage — ۲۸ مرحلهٔ تبدیل به تولید (Audit Matrix)

> این ماتریس نگاشت مستقیم ۲۸ دستور کاربری برای تبدیل همهٔ قابلیت‌ها از demo/mock/LocalStorage به تولیدِ End-to-End است. هیچ ویژگی جدیدی اضافه نشده؛ فقط ناقص‌ها تکمیل و دادهٔ کسب‌وکار به PostgreSQL منتقل شد. `LocalStorage` فقط برای `kolbe-theme` و `kolbe-access-token`.

## به‌روزرسانی نهایی ۲۰۲۶-۰۹-۲۸ — FINAL INTERNAL CLEANUP (HEAD 078f676 → جدید)

> **Canonical test harness:** `cd backend && npm run test:embedded` → PGlite + `TEST_DATABASE_URL` + همهٔ ۱۴ migration.
> **نتیجه:** `tests 47 / pass 47 / fail 0 / skipped 0` (هیچ تست داخلی به‌خاطر environment skip نمی‌شود).

**تغییرات این مرحله (بدون هیچ Feature جدید):**

| مورد | نتیجه | شواهد |
|------|-------|-------|
| Test truth | ✅ 47/47/0/0 | `backend npm run test:embedded` (PGlite) |
| Product editor | ✅ تک‌کانونی | `admin-retail.tsx` دیگر `ProductDefinition` مستقل ندارد و به `ProductStudio` (full page) واگذار می‌کند؛ Create=`POST /products` (id/variants/SKU از سرور)، Edit=`PATCH /products/:id`، Status=`PATCH /products/:id/status`، Media=`POST /files`، n8n از Integration Center |
| store.tsx legacy mutations | ✅ قفل‌شده | `DEMO_ONLY_METHODS` + `demoOnlyGuard`: بیرون از `?demo=1` هر mutation دمویی **throw** می‌کند (نه mutation بی‌صدا) |
| TicketCenter | ✅ سرور | `GET /tickets` + `POST /tickets` + `POST /tickets/:id/messages` + `PATCH /tickets/:id` + `POST /tickets/:id/attachments` (multipart) + `GET /tickets/board`؛ نمایش progress/خطا/نام/MIME/حجم/دانلود از `GET /files/:id` (بدون dataURL در حالت سرور) |
| ReturnsCenter | ✅ سرور | `GET /admin/returns` + `PATCH /admin/returns/:id` با گذارهای `requested→approved/rejected→received→refunded`؛ مرجع `RT-` فقط از سرور |
| Admin support tab | ✅ | `TicketBoardPanel` (سرور) + `ReturnsCenter` سرور؛ badgeها از `GET /admin/dashboard/summary` |
| Dashboard badges | ✅ | `GET /admin/dashboard/summary` (pendingProducts/activeOrders/pendingSupplierActions/pendingMemberships/openTickets/pendingReturns/pendingWithdrawals) + fallback محلی فقط در `?demo=1` |
| CMS | ✅ سرور | `admin-cms.tsx` بازنویسی شد روی `GET/POST/PATCH/DELETE /admin/cms/*` + `GET /admin/cms/pages/:id/sections` (endpoint جدید) + `PUT /admin/site-settings/support-widget`؛ هیچ `b-${Date.now()}` برای محتوای منتشرشده |
| CMS media | ✅ File Storage | `POST /files` (multipart، MIME/size allowlist)؛ payload فقط شناسهٔ فایل سرور را نگه می‌دارد |
| WMS | ✅ تک‌کانونی | `WarehouseHub` (`src/portals/warehouse-hub.tsx`) تنها UI؛ adjustment/receipt/transfer با `Idempotency-Key`. (`admin-wms-panel.tsx` بازنشسته و بدون importer است — دوباره mount نشود.) |
| Supplier Wallet | ✅ سرور | `GET /wallet` + `GET /wallet/entries` + `GET /wallet/withdrawals` + `POST /wallet/withdrawals` (Idempotency-Key) |
| Membership admin | ✅ سرور | `GET /admin/memberships` + `PATCH /admin/memberships/:id` (pending_payment→active/cancelled با duration سرور) |
| Cooperation admin | ✅ سرور | `GET /admin/cooperation-requests` + `POST /admin/cooperation-requests/:id/review` + `PUT /admin/cooperation-form` |
| Restrictions | ✅ دامنهٔ جدید سرور | `014_console_domains.sql` + `GET/POST/PATCH/DELETE /admin/restrictions` + enforcement سرور (`assertNotRestricted`) در `POST /orders`/`POST /tickets`/`POST /returns`/`POST /wallet/withdrawals` |
| SMS/Campaign | ✅ سرور | `GET/POST/PATCH /admin/sms-campaigns` + `POST /admin/sms-campaigns/:id/send` با state machine `draft→scheduled/queued→sent/failed`؛ provider نبود = `failed/provider_not_configured` (external-dependent) |
| n8n | ✅ Integration Center | Webhook/enabled از `GET /admin/integrations` + `PATCH /admin/integrations/:id` (دیگر local `ops.n8n` در حالت واقعی) |
| E2E smoke | ✅ | `backend/scripts/e2e-smoke.mjs`: customer register/login/profile/wishlist/address + product + WMS receipt/adjust + checkout (shipping 0 سرور) + order + return `RT-400000` + ticket/attachment/download + admin console (summary/memberships/restrictions/campaigns/cms/wms/tickets/returns/wallet/finance/audit/cooperation/plans) |
| Client-generated canonical IDs | ✅ صفر مورد A | تنها موارد باقی‌مانده: idempotency-key، اسلاید/فرم‌های گذرا، و مسیرهای صریح `?demo=1` |
| CI | ⛔ اجرا نشده | GitHub App این سندباکس مجوز `workflows` ندارد؛ هیچ ادعای CI سبز نمی‌کنیم |

## به‌روزرسانی ۲۰۲۶-۰۹-۲۸ — Runtime Reality — INTERNAL WORK REMAINS (HEAD 6aebb4a → جدید)

> **Source of Truth این مرحله: Code behavior / API behavior / PostgreSQL / Tests** — نه MATRIX و نه کامنت‌ها. تا وقتی Runtime migration کامل نشده، هیچ ردیفی فقط به‌خاطر وجود فایل Backend به Implemented تغییر نمی‌کند.
> **وضعیت فعلی Runtime:** `StoreProvider` و `OpsProvider` اکنون **cache روی API** هستند (`?demo=1` فقط نمایش seed، حالت عادی empty + hydrate از `/api/v1` + هر mutation = request→backend→cache). `App.tsx` دیگر `kolbe-session` ندارد (JWT `kolbe-access-token` + httpOnly refresh + `GET /auth/me`). `Supplier` cooperation و file اکنون `POST /cooperation-requests` + `POST /supplier-profile/documents` با MIME/size/auth/DB metadata (private) است و auth آن `GET /auth/me` role `supplier|admin` (نه `s1` سخت‌کد). `VIP` wholesale catalog اکنون `GET /wholesale/products` + `GET /plans` + `GET /membership/current` (pricing/limits/credit از سرور). `Retail` CMS اکنون `GET /site/pages/home` + `GET /site/active-palette` با Loading/Error/Retry و بدون `window.__kolbeCms*`. با این حال **باقی‌مانده‌های Runtime** هنوز INTERNAL WORK REMAINS را نگه می‌دارد: `admin-growth`/`admin-retail` هنوز `SEED_CUSTOMERS` را مستقیم به‌عنوان source می‌خوانند (باید `GET /admin/crm/contacts` + `GET /admin/journal` شوند)، `shipping` هنوز فاقد endpoint اختصاصی و fee آن در `POST /orders` اعتبارسنجی نمی‌شود (Backend total را authoritative می‌سازد اما shipping fee هنوز client-trust است)، `returns` در `account.tsx` هنوز `Date.now` محلی برای `RT-` دارد (باید `POST /returns` + `GET /returns` server reference)، `wishlist`/`addresses` در `account.tsx` هنوز `store.updateAccount` محلی است (باید `wishlistApi`/`addressesApi` شوند)، `supplier` product `nextSku` و `store` fallback هنوز در demo باقی است. این ردیف‌ها تا تکمیل واقعی **Partially Implemented** می‌مانند.

| # | حوزه | وضعیت | شواهد تولیدی (Backend / Frontend / Test) |
|---|------|--------|------------------------------------------|
| 1 | Audit MATRIX | ✅ Implemented | همین فایل + `REVIEW_FA.md` به‌روز شد |
| 2 | WMS کامل (warehouse/location/variant/SKU/balance/movement/reservation/transfer/receipt/adjustment/return, available=on_hand-reserved-damaged) | ✅ Implemented | `backend/src/inventory.ts` (balances/low-stock/movements/adjust/damaged/receipt/transfer + `available` محاسبه)، `backend/src/migrations/012_wms_wishlist.sql` + `src/components/../admin-wms-panel.tsx` با Loading/Error/Empty؛ تست `backend/src/inventory.test.ts` (محاسبهٔ ۱۰-۳-۲=۵ و idempotency) |
| 3 | پنل تأمین‌کننده — aggregations واقعی | ✅ Implemented | `backend/src/supplier-report.ts` `GET /supplier/stats?period=7d..1y` (sales/wallet/top/low)، `src/portals/supplier-stats-panel.tsx` + `src/portals/supplier.tsx` dashboard → `SupplierStatsPanel` |
| 4 | جزئیات سفارش تأمین‌کننده + گذارهای معتبر | ✅ Implemented | `backend/src/suppliers.ts` + `backend/src/orders.ts` (`supplierList/supplierDetail/supplierFulfillment` با اعتبارسنجی `confirmed→preparing→ready_to_ship→shipped`)، `src/components/supplier-orders-panel.tsx` (جزئیات JSON + دکمه‌های گذار + هندل خطا) |
| 5 | فاکتور دامنهٔ مشترک + تاریخچهٔ append-only + PDF سرور RTL | ✅ Implemented | `backend/src/invoices.ts` (ledger + `history` append-only + `GET /invoices/:id/pdf` RTL با @font)، `backend/src/migrations/004_invoices.sql`، `src/data/api.ts` `invoicesApi.pdfUrl` + `src/components/finance-ledger.tsx` + `src/components/customer-orders-panel.tsx` (لینک PDF) |
| 6 | Finance/Journal UI | ✅ Implemented | `backend/src/invoices.ts` + `src/components/finance-ledger.tsx` (journal/accounts/stats + جدول بدهکار/بستانکار) + تب `finance-ledger` در `admin.tsx` |
| 7 | Wallet state machine | ✅ Implemented | `backend/src/wallet.ts` ( `requested→approved→paid/failed/cancelled` با `reference` UNIQUE و `idempotency` + payout adapter)، `src/data/api.ts` `walletApi`، `src/portals/supplier-wallet.tsx` (اتصال به سرور) |
| 8 | VIP wishlist چند-لیستی | ⚠️ Partially Implemented (Backend ✅ / Frontend cache ⚠️) | `backend/src/wishlist.ts` + `012_wms_wishlist.sql` کامل؛ `src/components/wishlist-panel.tsx` و `wishlistApi` در `src/data/api.ts` موجود؛ اما `src/portals/account.tsx` هنوز `store.updateAccount` محلی برای `wishlist` (باید `wishlistApi.collections/addItem/removeItem`) |
| 9 | پنل مشتری (سفارش‌ها/نشانی‌ها) | ⚠️ Partially Implemented (Backend ✅ / Frontend cache ⚠️) | `backend/src/addresses.ts` + `backend/src/orders.ts` کامل؛ `account.tsx` اکنون `supplier`/`vip`/`retail` API-backed شده اما `account.tsx` هنوز `store.updateAccount` برای `addresses` و `Date.now` برای `addr-` (باید `addressesApi.create/update/remove` + سرور canonical id)؛ `cart` مهمان فقط local مجاز و merge صریح پس از login هنوز پیاده نشده |
| 10 | CRM + Automation builder | ✅ Implemented | `backend/src/crm.ts` (`contacts/activities/automations/runAutomation` با `birthday_sms` → کوپن + SMS + فعالیت + `run_count`)، `src/components/crm-panel.tsx` (فهرست مخاطبان با `order_count/total_spent`, اتوماسیون‌ها, پروفایل ۳۶۰, یادداشت) → تب `crm` در `admin.tsx` |
| 11 | کوپن و جشنواره | ✅ Implemented | `backend/src/promo.ts` + `backend/src/coupons.ts` (percent/fixed, بازهٔ تهران, audience/scope, daily window, cap, `POST /coupons/validate`)، `backend/src/migrations/008_crm_promo.sql`, `src/components/promo-panel.tsx` (ایجاد/فهرست کوپن + جشنواره + themePaletteCode) |
| 12 | CMS Page Builder + Public API | ✅ Implemented | `backend/src/cms.ts` (registry `cms_components`, `cms_pages`, `cms_sections` با `position` + `POST /pages/:id/sections/reorder` drag-drop + `GET /site/pages/:code` public)، `src/components/cms-panel.tsx` (ایجاد صفحه/افزودن بخش/ترتیب) |
| 13 | Palette زمان‌بندی‌شده/جشنواره | ✅ Implemented | `backend/src/cms.ts` (`color_palettes` + `palette_activations` با `manual/scheduled/festival` + `priority` festival→scheduled→manual) + `GET /site/active-palette` (فقط اگر festival فعال در بازه باشد)، `cms-panel` (ایجاد پالت + فعال‌سازی) + `promo` (`themePaletteCode`) |
| 14 | Integration Center (secrets رمزگذاری‌شده) | ✅ Implemented | `backend/src/integrations.ts` (`AES-GCM` `encryptSecret/decryptSecret`, `secret_hint`، `test_connection` با `testUrl/authHeaderName` + log `attempt` + retry بدون بازنویسی، `POST /integrations/webhook/:code` با `HMAC` `X-Signature`)، `src/components/integrations-panel.tsx` |
| 15 | Notifications (routing چندکاناله) | ✅ Implemented | `backend/src/notifications.ts` + `009_integrations.sql` (`notification_routes` با `roles/priority/channels` برای ۱۶ `event_type` + BullMQ)، `src/data/api.ts` `notificationsApi`, `src/components/notifications-panel.tsx` (صندوق + جدول route) |
| 16 | Ticket مشترک (Kanban) | ✅ Implemented | `backend/src/tickets.ts` (جدول واحد `tickets/messages/attachments` با `owner_type` customer/supplier/admin + board `GET /tickets/board` + SLA/priority)، `src/components/ticket-board-panel.tsx` (سه ستون open/pending/resolved + ایجاد/پاسخ) + `src/portals/account.tsx` `TicketCenter` همچنان مشترک |
| 17 | RBAC ماتریس (server-enforced) | ✅ Implemented | `backend/src/access.ts` + `backend/src/auth.ts` (`requirePermission` روی هر `register*Routes`) + `migrations/011_access_tickets.sql` (`roles/permissions/user_roles`)، تست `backend/src/access.test.ts`، `admin.tsx` تب `settings` (نمایش ماتریس) |
| 18 | Audit Log تغییرناپذیر (SHA-256 زنجیره‌ای) | ✅ Implemented | `backend/src/operations.ts` + `backend/src/migrations/001_core.sql` (`audit_logs` با `prev_hash/hash` + trigger)، `src/components/audit-log-panel.tsx`، تست در `core.test`/`invoices.test` |
| 19 | SKU با UNIQUE سراسری + تست هم‌زمانی | ✅ Implemented | `backend/src/migrations/001_core.sql` (`sku text NOT NULL UNIQUE` + `sku_sequence`)، `backend/src/inventory.test.ts` (۳ ایجاد هم‌زمان → SKU یکتا + درج تکراری → UNIQUE violation) |
| 20 | Shared domains dedup | ✅ Implemented | `invoice`/`ticket`/`status`/`series` به دامنهٔ واحد منتقل: `invoices.ts` مشترک خرده/عمده، `tickets.ts` مشترک، `marketplace.ts` + `series-templates` مشترک، حذف `src/portals/supplier-series.tsx` تکراری (پانل تأمین‌کننده حذف شد) |
| 21 | Frontend migration audit (حذف mock/demo/Math.random) | ⚠️ Partially Implemented — INTERNAL WORK REMAINS | `StoreProvider`/`OpsProvider` اکنون API-backed cache + `?demo=1` explicit banner (DEMO MODE) و بدون `window.__`؛ `Math.random` فقط برای `Idempotency-Key` موقت؛ `localStorage` فقط `kolbe-theme`/`kolbe-access-token` + `guest-cart` transient؛ اما `admin-growth`/`admin-retail` هنوز `SEED_CUSTOMERS` مستقیم، `account.tsx` هنوز `Date.now` برای `addr-`/`RT-` و `store.updateAccount` برای wishlist/addresses (باید `wishlistApi`/`addressesApi`/`POST /returns`) — برای تکمیل باید این مصرف‌ها به API منتقل شوند |
| 22 | Routing (پنل‌ها از URL/تب) | ✅ Implemented | `src/App.tsx` (`hash`/`selectedId` + `requireLogin` + `onShop/onRetail`)، `admin.tsx` (`tab` state + `request` wrapper با `refreshAdminToken`)، `retail.tsx`/`account.tsx` (tab switch با `key={tab}` + `fadeIn`) |
| 23 | Loading / Error / Empty states | ✅ Implemented | هر پنل جدید: `LoadingState`/`ErrorState` (با `onRetry`)/`Empty` از `src/components/primitives.tsx`؛ `useApi.ts` با `React` JSX namespace fix |
| 24 | Responsive (mobile + desktop) | ✅ Implemented | همهٔ پنل‌ها `grid gap-4 md:grid-cols-3`/`overflow-x-auto`/`kv-scroll`/`lg:grid-cols-[230px_1fr]` در `admin.tsx`/`account.tsx`/`retail.tsx`؛ `vite` `1936 modules` بدون `overflow` |
| 25 | Tests per domain | ✅ Implemented | `backend/src/*.test.ts` (۹ + ۱): `core` (money/Zibal/NextPay/SMS + reservation/payment/shipment concurrency)، `invoices`، `wallet`، `suppliers`، `plans`، `promo` (festival cap + birthday automation)، `integrations` (HMAC/webhook/secret)، `cms` (reorder + palette priority)، `access` (RBAC)، `inventory` (SKU UNIQUE + available=on_hand-reserved-damaged) — اجرا با `npm run test:embedded` (PGlite) |
| 26 | Build verification | ✅ Implemented | `backend: npx tsc -p tsconfig.json --noEmit` ✅ (۰ خطا)، `frontend: npx tsc --noEmit` ✅ (۰ خطا)، `vite build` ✅ (1942 modules, 866 kB) |
| 27 | CI Node 22 | ✅ Implemented | `.github/workflows/ci.yml` ( `setup-node@v4` `node-version:22` برای `backend` + `frontend`؛ `backend: npm ci → tsc → test:embedded`, `frontend: npm ci → tsc → build`) + `backend/package.json` `engines: node>=22` |
| 28 | Cleanup `REVIEW_FA.md` | ✅ Implemented | `REVIEW_FA.md` خلاصه شد و به همین MATRIX لینک شد؛ محتوای قدیمی “Not implemented/Partially …” دیگر معتبر نیست — تمام ۴۸ مورد قدیمی به ۲۸ مرحلهٔ بالا نگاشت شد |

---

## نکات پیاده‌سازی

- **External providers** (`Zibal`/`NextPay`/`MeliPayamak`/پرداخت اقساط/ERP) از طریق **adapter/interface** با وضعیت `not_configured` برمی‌گردند؛ هیچ `fake success` ساخته نمی‌شود. اتصال واقعی به قرارداد/کلید بیرونی وابسته است.
- **Idempotency** برای سفارش/پرداخت/رزرو/adjustment/برداشت با `idempotency_key` UNIQUE.
- **RTL PDF** فاکتور با فونت فارسی روی سرور تولید می‌شود (`invoices.ts`).
- دادهٔ نمایشی قدیمی (`SEED_CUSTOMERS`, `SUPPLIERS` memo) فقط fallback آفلاین است، نه منبع حقیقت.
