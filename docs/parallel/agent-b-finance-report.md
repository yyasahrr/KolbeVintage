# Agent B — گزارش Integration نهایی (Supplier 360 / اسناد / عملیات مالی)

- شاخه: `arena/01a0ed8f-kolbevintage` — PR: [#5](https://github.com/yyasahrr/KolbeVintage/pull/5)
- دامنه (frozen): آیتم‌های ۱۱–۱۴ (تأمین‌کننده ۳۶۰)، ۲۵–۳۴ (موتور اسناد/فاکتور)، ۱۴۴–۱۷۲ (عملیات مالی). **فیچر جدید اضافه نشد؛ فقط آماده‌سازی Integration.**
- commit کد تحویل‌شده و آزمون‌شده: `160a233`
- HEAD محلی/ریموت = همان commitی که این فایل را در خود دارد:
  `git log -1 --format=%H -- docs/parallel/agent-b-finance-report.md`
  (Remote HEAD روی `origin/arena/01a0ed8f-kolbevintage`؛ HEAD قبلی ریموت `036a3fb` بود.)

## ۱) کارهای انجام‌شده برای Integration

1. **انتقال مهاجرت‌ها به بازه رزرو‌شده ۰۲۵–۰۳۴**: فایل `016_supplier360_invoice_finance.sql` حذف و به سه فایل تقسیم شد (rename با شباهت ۵۴٪ در گیت ثبت شده است، پس تاریخچه حفظ شده). پوشش محتوا با ابزار پایتون سنجیده شد: ۴۵۷ سطر غیرخالی، ۰ سطر جا‌افتاده، ۰ سطر اضافی.
2. **اثبات مهاجرت از صفر**: `backend/scripts/verify-migrations.mjs` روی PGlite خالی `npm run migrate` را اجرا و ترتیب/اشیای واقعی را می‌سنجد (خروجی: `ALL CHECKS PASSED`).
3. **یکسان‌سازی مسیر پول**: `invoices.ts`، `wallet.ts` و `payments.ts` دیگر مستقیم در `journal_entries` درج نمی‌کنند و همگی از `postJournalEntry` (تنها مسیر قانونی در `ledger.ts`) عبور می‌کنند. پیش از این، ۲ سند در تست از قید «دوره مالی» جا می‌ماندند و `period_code` نداشتند؛ اکنون هیچ سند بدون دوره ثبت نمی‌شود.
4. **قابلیت ردیابی تسویه (آیتم ۱۵۴)**: ستون `settlement_lines.journal_entry_id` پس از accrual پر می‌شود، پس زنجیره «ردیف تسویه → دفتر تأمین‌کننده → سند حسابداری → پرداخت» بدون حدس‌زدن پیمایش‌شدنی است.
5. **تست‌های تثبیتی برای بندهای الزامی ریویو** (به جدول بخش ۴ نگاه کنید).

## ۲) فایل‌های مهاجرت (بازه رزرو‌شده)

| فایل | آیتم‌ها |
| --- | --- |
| `backend/src/migrations/025_supplier360.sql` | ۱۱–۱۴ |
| `backend/src/migrations/026_invoice_engine.sql` | ۲۵–۳۴ |
| `backend/src/migrations/027_finance_operations.sql` | ۱۴۴–۱۷۲ |

- `016_supplier360_invoice_finance.sql` **حذف شده** (فقط در تاریخچه گیت).
- `028`–`034` آزاد و بلااستفاده.
- ترتیب واقعی اعمال روی پایگاه‌داده خالی (۱۸ سطر در `schema_migrations`، صعودی):
  `001…015 → 025_supplier360.sql → 026_invoice_engine.sql → 027_finance_operations.sql`
- هیچ فایلی از بازه `016`–`024` لازم نیست؛ این شاخه به مهاجرت هیچ ایجنت دیگری وابسته نیست.

## ۳) باطری نهایی تست

| آزمون | دستور | نتیجه |
| --- | --- | --- |
| تست‌های درون‌ریز روی پایگاه‌داده تازه‌مهاجرت‌داده‌شده | `cd backend && npm run test:embedded` | **71/71 pass، 0 fail، 11 suite** (PGlite خالی → `migrate` → `node --test`) |
| قرارداد فرانت↔بک | `cd backend && npm run test:contract` | **60/60 checks passed** |
| تأیید مهاجرت از صفر | `cd backend && node scripts/verify-migrations.mjs` | **ALL CHECKS PASSED** (۱۶ جدول، ۴ قالب + ۴ نسخه، ۷ مجوز، ۶ حساب، ۴ تریگر، ستون‌های اسنپ‌شات/PDF) |
| تایپ‌اسکریپت بک‌اند | `cd backend && npx tsc --noEmit` | پاک |
| تایپ‌اسکریپت فرانت‌اند | `node node_modules/typescript/bin/tsc --noEmit` | پاک (`npx tsc` در این محیط Permission denied می‌دهد) |
| بیلد فرانت‌اند | `node node_modules/vite/bin/vite.js build` | `dist/index.html` **1,144.86 kB │ gzip 292.35 kB** |

## ۴) تأیید بندهای الزامی (هر بند با آزمون اجراشدنی)

| بند الزامی | شاهد |
| --- | --- |
| محدودیت‌ها سمت سرور اعمال می‌شوند | `supplier360.test.ts` (۴۰۳ برای تأمین‌کننده محدود/معلق)، و دروازه‌های `assertSupplierMay`/`supplierCapViolation` در `catalog.ts`, `orders.ts`, `wallet.ts`, `finance.ts` — UI فقط نمایش می‌دهد |
| تلاش‌های مسدودشده audit می‌شوند | `assertSupplierMay` → `recordBlockedAttempt` پیش از `COMMIT` (حتی وقتی تراکنش کسب‌وکار rollback می‌شود)؛ تست: تایم‌لاین شامل `supplier.action_blocked` |
| اسنپ‌شات سند پس از تغییر مشتری/کالا/قالب ثابت می‌ماند | `invoice-docs.test.ts` (بند جدید): پس از تغییر `users.display_name`، `invoices.buyer`، `invoice_lines.product_name` و ساخت نسخه سوم قالب → `snapshot` و `template_version_id` تغییر نمی‌کنند و **بایت‌های PDF یکسان** است |
| دسترسی PDF مجوزمحور است | `GET /api/v1/invoices/:id/pdf` → ۲۰۰ برای طرف سند/دارنده `invoices:read` و **۴۰۴ برای کاربر غریبه** (assert در `invoice-docs.test.ts`) |
| دفتر کل متوازن است | تریگر قید `journal_balance_insert` + تست: هیچ سند نامتوازنی در پایگاه‌داده نیست و `sum(debit) == sum(credit)` کل دفتر؛ درج دستی سند نامتوازن با `Unbalanced journal entry` رد می‌شود |
| تراکنش‌های تاریخی هرگز بازنویسی نمی‌شوند | تریگرهای `journal_*_immutable` (پایه) و `supplier_ledger_immutable`/`settlement_events_immutable`/`finance_approval_events_immutable` (۰۲۷)؛ تست: `UPDATE`/`DELETE` روی دفتر کل و دفتر تأمین‌کننده با خطای immutable رد می‌شود |
| دوره مالی بسته/قفل‌شده اعمال می‌شود | `ensurePeriod` (دوره ماهانه، `closed`/`locked` → 409) و همه مسیرهای پول اکنون از آن عبور می‌کنند؛ تست: هیچ سند بدون `period_code` وجود ندارد + ماشین وضعیت دوره در `finance.test.ts` |
| تسویه قابل ردیابی است | تست: ردیف تسویه → ردیف دفتر تأمین‌کننده → سند حسابداری متوازن → سند پرداخت تسویه → سند PDF تسویه (اسنپ‌شات‌دار) → زنجیره رویدادها `pending → reviewed → approved → paid → reconciled` با کنش‌گر هر تغییر |
| فرانت‌اند منبع مستقل عدد مالی نیست | طرح‌واره‌های ورودی `.strict()` هستند و `totalRial`/`netRial`/`lineTotalRial` را **۴۰۰** می‌کنند (تست جدید)، پس هیچ عدد محاسبه‌شده‌ای از کلاینت پذیرفته نمی‌شود؛ در فرانت هیچ ضرب/تقسیم مالی برای نوشتن وجود ندارد و همه اعداد نمایشی از پاسخ API می‌آیند (جمع‌های نمایشی روی مقادیر سرور محاسبه می‌شوند) |

## ۵) وضعیت نهایی

**DONE**
- انتقال مهاجرت به ۰۲۵–۰۳۴ + اثبات ماشینی مهاجرت از صفر روی پایگاه‌داده خالی.
- حذف دورزدن قیدهای دفتر کل/دوره مالی در مسیرهای فاکتور، کیف پول و پرداخت.
- پر شدن شکاف قابلیت ردیابی تسویه.
- باطری تست: ۷۱/۷۱ درون‌ریز، ۶۰/۶۰ قرارداد، tsc بک/فرانت پاک، بیلد موفق.

**BLOCKED (محیط)**
- آزمون مرورگری/E2E اجرا **نشد**: راه‌اندازی Chromium در این محیط با خطای کتابخانه مشترک گمشده `libnss3.so` شکست می‌خورد (بدون root/apt قابل نصب نیست). بنابراین هیچ ادعای سبز‌بودن برای تست مرورگر مطرح نمی‌شود؛ این بند در محیط CI/دسکتاپ باید اجرا شود.
- همچنین در همین محیط: `npx tsc` و `npm run build` به‌خاطر Permission denied کار نمی‌کنند و با مسیر مستقیم `node node_modules/.../bin/...` اجرا شدند (تفاوت رفتاری محصول نیست).

## ۶) وابستگی‌های بین‌ایجنتی

| شاخه | آخرین فایل‌های مهاجرت | بازه |
| --- | --- | --- |
| `main` | `001`–`003` | — |
| `arena/01a0e859-kolbevintage` | `001`–`011` | ۰۰۱–۰۱۱ |
| `arena/01a0e916-kolbevintage` | `001`–`015` | ۰۰۱–۰۱۵ |
| `arena/01a0ed8e-kolbevintage` (Commerce) | … `016_commerce_product.sql`، `017_specs_sizeguides.sql`، `018_imports_shipping_rules.sql` | ۰۱۶–۰۱۸ |
| `arena/01a0ed9a-kolbevintage` (CMS/SEO) | `016_cms_style_profile_356.sql`، `017_seo_domain_media_variants.sql` | ۰۱۶–۰۱۷ |
| `arena/01a0ed90-kolbevintage` (Membership/CRM) | `045_membership_buyer.sql` … `049_video_permissions_promo_growth_hardening.sql` | ۰۴۵–۰۴۹ |
| `arena/01a0ed97-kolbevintage` (Search/SEO) | `050_seo_search_media.sql` | ۰۵۰ |
| **این شاخه** | `025_supplier360.sql`، `026_invoice_engine.sql`، `027_finance_operations.sql` | **۰۲۵–۰۳۴** |

- بررسی هم‌پوشانی اشیا (نه فقط نام فایل) روی HEADهای فعلی Commerce/Membership/Search/CMS: **۰ تضاد** — نه `CREATE TABLE` مشترک و نه ستون مشترک روی جداول کانونیکال.
- وابستگی‌های کانونیکال مصرف‌شده: `001_core` (ledger/orders/order_lines/permissions/files/…)، `004_invoices`، `005_wallet` (settlements)، `006_suppliers` (supplier_profiles)، `013` (files). هیچ دامنه موازی Product/WMS/CMS/Search ساخته نشده؛ موجودی/محصول فقط خوانده می‌شود و تنها افزوده‌ها `order_lines.weight_grams` (سفارش) است — `product_variants.weight_grams` متعلق به مهاجرت Commerce `016` است.
- تذکر برای تجمیع: شاخه‌های CMS (`01a0ed9a`) و Commerce (`01a0ed8e`) هر دو `016`/`017` را ادعا می‌کنند؛ این تضاد بیرون از بازه ۰۲۵–۰۳۴ این شاخه است، اما در زمان merge باید حل شود (فایل‌های این شاخه با هیچ‌کدام برخورد ندارند).
- قراردادهای مشترک در `docs/parallel/agent-b-finance-contracts.md` مستند شده‌اند (API، مجوزها، جداول کانونیکال، تنها مسیر مجاز نوشتن سند مالی).
