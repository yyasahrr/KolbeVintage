# بازبینی کلبه وینتج — وضعیت تولید (به‌روزرسانی 2026-09-28)

این سند قبلاً (۹۱ خط) ۴۸ درخواست را با برچسب‌های `Implemented / Partially / Not implemented` توصیف می‌کرد.
در شاخهٔ `arena/01a0e916-kolbevintage` هر ۴۸ مورد به **۲۸ مرحلهٔ تولیدی** زیر نگاشت و کامل شد — دادهٔ کسب‌وکار از `localStorage` به **PostgreSQL** منتقل شد و `localStorage` فقط برای `kolbe-theme` و `kolbe-access-token` باقی ماند.

**برای ماتریس دقیقِ ۲۸ مرحله با شواهد Backend/Frontend/Test به `MATRIX.md` مراجعه کنید.**

## خلاصهٔ ۲۸ مرحله (همگی ✅ Implemented)

1. Audit MATRIX — همین `MATRIX.md`
2. WMS کامل (available = on_hand - reserved - damaged) — `inventory.ts` + `warehouse-hub.tsx` (پنل قدیمی `admin-wms-panel.tsx` بازنشسته است) + `inventory.test.ts`
3. پنل تأمین‌کننده aggregations واقعی — `supplier-report.ts` + `supplier-stats-panel`
4. جزئیات سفارش تأمین‌کننده با گذار معتبر — `suppliers.ts` + `supplier-orders-panel`
5. فاکتور دامنه مشترک + history append-only + PDF RTL — `invoices.ts`
6. Finance/Journal UI — `finance-ledger.tsx`
7. Wallet state machine — `wallet.ts`
8. Wishlist چند-لیستی — `wishlist.ts` + `wishlist-panel`
9. پنل مشتری — `customer-orders-panel` + `customer-addresses`
10. CRM + Automation (`birthday_sms` → کوپن + SMS) — `crm.ts` + `crm-panel`
11. کوپن/جشنواره (قواعد تهران، validate) — `promo.ts` + `promo-panel`
12. CMS Page Builder + `GET /site/pages/:code` — `cms.ts` + `cms-panel`
13. Palette زمان‌بندی/جشنواره (اولویت festival→scheduled→manual) — `cms.ts`
14. Integration Center (AES-GCM، HMAC webhook، retry) — `integrations.ts` + `integrations-panel`
15. Notifications (۱۶ رویداد + `notification_routes` + BullMQ) — `notifications-panel`
16. Ticket مشترک Kanban — `tickets.ts` + `ticket-board-panel`
17. RBAC ماتریس server-enforced — `access.ts` + `requirePermission`
18. Audit Log زنجیره SHA-256 — `operations.ts` + `audit-log-panel`
19. SKU UNIQUE سراسری + تست هم‌زمانی — `001_core.sql` + `inventory.test.ts`
20. Shared domains dedup — `invoice`/`ticket`/`series` واحد
21. Frontend migration audit — `localStorage` فقط prefs
22. Routing — `App.tsx`/`admin.tsx` hash/tab
23. Loading/Error/Empty — هر پنل `LoadingState`/`ErrorState`/`Empty`
24. Responsive — `grid`/`overflow-x-auto`/`kv-scroll`
25. Tests per domain — `backend/src/*.test.ts` ×۱۰ با `test:embedded` (PGlite)
26. Build verification — `backend tsc` ✅ `frontend tsc` ✅ `vite build` 1942 modules
27. CI Node 22 — `.github/workflows/ci.yml`
28. این cleanup

## External providers

`SnappPay`/`DigiPay`/`SMS`/`payout`/`ERP` از طریق adapter با وضعیت `not_configured` هستند؛ موفقیت جعلی ساخته نمی‌شود.

---
*نسخهٔ قبلی این فایل (۹۱ خط) برای تاریخچه در `git log` باقی است؛ این نسخه خلاصهٔ تولیدی است.*


## به‌روزرسانی نهایی — FINAL INTERNAL CLEANUP (۲۰۲۶-۰۹-۲۸)

**آزمون کانونیکال:** `cd backend && npm run test:embedded` → **۴۷ تست / ۴۷ پاس / ۰ خطا / ۰ skip** (PGlite + `TEST_DATABASE_URL`).

**ممیزی grep نهایی (src):** تعداد برخوردها بر اساس کلاس — A (Business Runtime): **۰**، B (گذرا/UI): ۲۱۴، C (صراحتاً `?demo=1`): ۸۷.
- تنها شناسه‌های ساخته‌شدهٔ سمت کلاینت باقی‌مانده: `Idempotency-Key` سفارش/انبار (کلید idempotency، نه شناسهٔ دامنه)، شناسهٔ اسلایدهای گذرا و فرم‌های محلی، و مسیرهای صریح `?demo=1` که همه با `demoOnlyGuard` محافظت می‌شوند.
- `useOps`/`useStore` باقی‌مانده فقط در پنل‌هایی است که دادهٔ واقعی آن‌ها از API می‌آید و مقادیر محلی آن‌ها در حالت `?demo=1` یا صرفاً UI گذرا هستند (نمونه: `ops.hero` فقط به‌عنوان fallback تا زمانی که CMS سرور پاسخ نداده باشد).

**دامنه‌های سرور تکمیل‌شده در این مرحله:** restrictions (جدید)، SMS campaigns (جدید)، dashboard summary (جدید)، membership admin (جدید)، `GET /admin/cms/pages/:id/sections` (جدید)، + اتصال CMS/Wallet/Tickets/Returns/Product/Dashboard به API.

**باگ‌های واقعی که اسموک E2E کشف و رفع کرد:**
1. `audit_logs` در `PATCH /auth/me` با ستون اشتباه (`entity_type`) درج می‌شد → ۵۰۰ (اکنون `audit()` استاندارد).
2. فیلتر `ip` در `GET /admin/audit-logs` روی نوع `inet` با text مقایسه می‌شد → ۵۰۰ (اکنون `ip::text`).
3. شناسه‌های seed روش‌های ارسال، UUID معتبر v4 نبودند و `shippingMethodId` در checkout را رد می‌کرد → اصلاح seed + migration ترمیمی.
4. خطاهای ۴xx سطح فریم‌ورک (بدنهٔ خالی JSON) به ۵۰۰ تبدیل می‌شدند → مدیریت خطا اصلاح شد.

**External-provider dependent (طبیعی):** ارسال پیامک واقعی و درگاه پرداخت واقعی نیازمند credential هستند؛ در نبود آن‌ها کمپین با `failed / provider_not_configured` ثبت می‌شود و پرداخت با adapter تأییدشده انجام می‌شود.

**CI:** GitHub Actions اجرا نمی‌شود (مجوز `workflows` برای GitHub App این محیط موجود نیست) — هیچ ادعای سبز بودن CI نداریم.
