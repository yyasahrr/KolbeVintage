# Agent B — قراردادهای مالی/تأمین‌کننده (اشتراک بین ایجنت‌ها)

شاخه: `arena/01a0ed8f-kolbevintage`
دامنه: Supplier 360 (آیتم‌های ۱۱–۱۴)، موتور اسناد/فاکتور (۲۵–۳۴)، عملیات مالی (۱۴۴–۱۷۲)
دامنه ثابت (frozen) است: در این شاخه فیچر جدید اضافه نشده و هیچ دامنه موازی Product/WMS/CMS/Search/Recommendation ساخته نشده است.

## ۱) مهاجرت‌ها — بازه رزرو‌شده ۰۲۵–۰۳۴

| فایل | آیتم‌های سند | محتوا |
| --- | --- | --- |
| `025_supplier360.sql` | ۱۱–۱۴ | ستون‌های وضعیت فعالیت روی `supplier_profiles` + تریگر همگام‌ساز، `supplier_status_history`، `supplier_restrictions` |
| `026_invoice_engine.sql` | ۲۵–۳۴ | `invoice_templates`، `invoice_template_versions`، توسعه `invoices` (نسخه قالب، اسنپ‌شات، PDF، طرف حساب، تاریخ‌های چرخه عمر)، قیدهای نوع/وضعیت/رویداد، ایندکس‌ها، ۴ قالب پیش‌فرض + نسخه ۱ |
| `027_finance_operations.sql` | ۱۴۴–۱۷۲ | `accounting_periods`، ابعاد دفتر کل، `supplier_finance_accounts`، `supplier_ledger_entries` (+ تریگر تغییرناپذیری)، توسعه `settlements` + `settlement_lines`/`settlement_exceptions`/`settlement_events`، `supplier_advances`، `financial_adjustments`، `finance_approvals` + رویدادها، `shipping_allocations` + سطرها، `order_lines.weight_grams`، ۶ حساب دفتر کل، ۷ مجوز و اعطاها، backfill حساب تأمین‌کنندگان |

- `028`–`034` **آزاد و بلااستفاده** است (رزرو برای همین شاخه، بدون فایل).
- نام قدیمی `016_supplier360_invoice_finance.sql` حذف شد و فقط در تاریخچه گیت باقی است؛ امروز هیچ فایلی از این شاخه در بازه `016`–`024` وجود ندارد.
- اثبات ماشینی: `backend/scripts/verify-migrations.mjs` روی یک پایگاه‌داده خالی، `npm run migrate` را اجرا می‌کند و ترتیب/محتوا را می‌سنجد (خروجی: `ALL CHECKS PASSED`).

### ترتیب اعمال روی پایگاه‌داده خالی

```
001…015 (shared base)  →  025_supplier360.sql  →  026_invoice_engine.sql  →  027_finance_operations.sql
```

`016`–`024` لازم **نیست**؛ این شاخه به فایل هیچ ایجنت دیگری وابسته نیست.

## ۲) جداول پایه‌ای مصرف‌شده (Consume, never duplicate)

| منبع (فایل پایه) | استفاده در این شاخه |
| --- | --- |
| `001_core.sql` | `orders`، `order_lines`، `journal_entries`، `journal_lines`، `ledger_accounts` (حساب‌های ۱–۶)، `permissions`/`role_permissions`، `users`، `audit_logs`، `outbox_events`، `tickets`/`ticket_messages`، `files` |
| `004_invoices.sql` | `invoices`، `invoice_lines`، `invoice_events` — فقط `ALTER` (بدون `CREATE` موازی) |
| `005_wallet.sql` | `settlements` — `ALTER` + جداول فرزند (`settlement_lines`، `settlement_exceptions`، `settlement_events`) |
| `006_suppliers.sql` | `supplier_profiles` — `ALTER` (وضعیت فعالیت) |
| `013_shipping_returns_files.sql` | `files` با `IF NOT EXISTS` (بدون بازتعریف) |
| `016_commerce_product.sql` (ایجنت Commerce) | `product_variants.weight_grams` مالک اصلی همین فایل است؛ این شاخه فقط `order_lines.weight_grams` را اضافه می‌کند و هیچ ستون محصولی نمی‌سازد |

نتیجه بررسی هم‌پوشانی: **صفر تضاد نام شیء** بین اشیای `025`–`027` و DDL دیگر ایجنت‌ها (`git diff` بلاب‌های `004`–`015` بین شاخه‌ها یکسان است).

## ۳) سطح API اضافه‌شده

### Supplier 360 (`supplier360.ts`)
```
GET    /api/v1/admin/suppliers/:id/360
POST   /api/v1/admin/suppliers/:id/activity-status
GET    /api/v1/admin/suppliers/:id/status-history
GET    /api/v1/admin/suppliers/:id/restrictions
POST   /api/v1/admin/suppliers/:id/restrictions
POST   /api/v1/admin/suppliers/:id/restrictions/:restrictionId/lift
GET    /api/v1/admin/suppliers/:id/finance
```

### موتور اسناد و قالب‌ها (`invoice-templates.ts`, `invoice-docs.ts`)
```
GET    /api/v1/invoices/templates            POST /api/v1/invoices/templates
GET    /api/v1/invoices/templates/variables  GET  /api/v1/invoices/templates/:id
POST   /api/v1/invoices/templates/:id/versions
POST   /api/v1/invoices/templates/:id/activate
POST   /api/v1/invoices/templates/:id/preview
POST   /api/v1/invoices/:id/issue            POST /api/v1/invoices/:id/void
POST   /api/v1/invoices/:id/refunds          POST /api/v1/invoices/statements/supplier
GET    /api/v1/invoices/:id/pdf              (روت موجود در `invoices.ts`، مجوز‌محور)
```

### عملیات مالی (`finance.ts`)
```
GET  /api/v1/admin/finance/summary | analytics | aging | events | reports | reports/:code
GET/PUT /api/v1/admin/finance/targets
GET  /api/v1/admin/finance/suppliers            GET  /api/v1/admin/finance/suppliers/:id/statement
GET/POST /api/v1/admin/finance/settlements      GET  /api/v1/admin/finance/settlements/:id
POST /api/v1/admin/finance/settlements/:id/pay | :id/reconcile | :id/exceptions/:exceptionId/resolve
POST /api/v1/admin/finance/approvals/:id/:action
GET/POST /api/v1/admin/finance/adjustments      POST /api/v1/admin/finance/adjustments/:id/apply
GET/POST /api/v1/admin/finance/advances         POST /api/v1/admin/finance/advances/:id/pay | :id/apply
GET/POST /api/v1/admin/finance/shipping-allocations
GET  /api/v1/admin/finance/periods              POST /api/v1/admin/finance/periods/:code/:action
```

## ۴) مجوزها (۷ کد جدید)

`invoices:templates`، `supplier360:read`، `supplier360:manage`، `finance:adjust`، `finance:approve`، `finance:periods`، `finance:export`

اعطا: نقش `admin` (همه)، نقش `finance` (همه)، نقش `operations` (`supplier360:read`).

## ۵) نقاط اتصال بین ایجنت‌ها (Cross-agent surface)

| موضوع | قرارداد فعلی | آنچه ایجنت دیگر باید رعایت کند |
| --- | --- | --- |
| بازه مهاجرت | این شاخه `025`–`034` | هیچ ایجنتی روی `025`–`034` فایل نسازد (به‌ویژه `016` که متعلق به Commerce است) |
| دفتر کل | تنها مسیر نوشتن سند: `postJournalEntry` در `backend/src/ledger.ts` | ثبت مالی جدید باید از همین تابع برود تا «توازن» و «دوره باز» اعمال شود؛ درج مستقیم در `journal_entries` ممنوع |
| دوره مالی | `ensurePeriod` (ساخت خودکار دوره ماهانه) + `assertPeriodOpen` | هر سند مالی باید `period_code` داشته باشد؛ دوره `closed`/`locked` سند جدید نمی‌پذیرد |
| حساب‌های دفتر | `ACCOUNTS` در `ledger.ts` (uuid ثابت) و ۶ حساب جدید در `027` | حساب جدید = سطر جدید در `ledger_accounts`، نه حساب موازی در کد |
| تأمین‌کننده | `assertSupplierMay` / `supplierCapViolation` از `supplier360.ts` | دروازه‌ها سمت سرور و در مسیرهای `catalog`، `orders`، `wallet`، `finance` اعمال می‌شوند؛ UI تنها نمایش‌دهنده است |
| فاکتور | `invoices` + `snapshot`/`template_version_id`/`pdf_file_id` | سند صادرشده از اسنپ‌شات رندر می‌شود؛ تغییر مشتری/کالا/قالب نباید عدد یا PDF سند را عوض کند |
| فایل | دامنه `files` (visibility=private) | PDF فاکتور فقط از مسیر مجوز‌محور سرو می‌شود؛ دسترسی مستقیم به `storage_key` داده نشود |
| سفارش/محصول | جداول `orders`/`order_lines`/`product_variants` مالک اصلی ایجنت‌های پایه/Commerce | این شاخه فقط `order_lines.weight_grams` را اضافه کرده و موجودی/محصول را مصرف می‌کند |
| اسناد صورتحساب | `POST /invoices/statements/supplier` با ارجاع `INV-YYYY-NNNNNN` | سند تسویه به `settlements.statement_invoice_id` وصل می‌شود؛ ایجنت تسویه نباید شماره‌گذاری موازی بسازد |

## ۶) پیش‌نیازهای بازگشت (rollback / forward-compat)

- حذف فایل `016_supplier360_invoice_finance.sql` بدون بازنویسی `schema_migrations` انجام شده است؛ روی پایگاه‌داده‌ای که قبلاً همان فایل را اعمال کرده باشد، سه فایل جدید مستقل از نام قدیمی اعمال می‌شوند (هیچ وابستگی نام‌محور به `016` وجود ندارد).
- `027` فقط `ALTER TABLE … ADD COLUMN` و `CREATE TABLE` جدید انجام می‌دهد؛ قیدهای قبلی `invoices`/`settlements` با `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` گسترده شده‌اند.
