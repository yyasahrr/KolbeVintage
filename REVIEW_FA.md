# بازبینی کلبه وینتج — وضعیت تولید (به‌روزرسانی 2026-09-28)

این سند قبلاً (۹۱ خط) ۴۸ درخواست را با برچسب‌های `Implemented / Partially / Not implemented` توصیف می‌کرد.
در شاخهٔ `arena/01a0e916-kolbevintage` هر ۴۸ مورد به **۲۸ مرحلهٔ تولیدی** زیر نگاشت و کامل شد — دادهٔ کسب‌وکار از `localStorage` به **PostgreSQL** منتقل شد و `localStorage` فقط برای `kolbe-theme` و `kolbe-access-token` باقی ماند.

**برای ماتریس دقیقِ ۲۸ مرحله با شواهد Backend/Frontend/Test به `MATRIX.md` مراجعه کنید.**

## خلاصهٔ ۲۸ مرحله (همگی ✅ Implemented)

1. Audit MATRIX — همین `MATRIX.md`
2. WMS کامل (available = on_hand - reserved - damaged) — `inventory.ts` + `admin-wms-panel` + `inventory.test.ts`
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
