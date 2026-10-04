# پیگیری نهایی Product / WMS

**تاریخ:** 2026-10-05 · **شاخهٔ ثابت:** `arena/01a10817-kolbevintage` · **شروع این دور:** `3eaa71834ea6ce092e67f13a5effb5cb484974f7` · **scope:** تکمیل verification و delivery ادغام موجود Product/WMS؛ بدون feature اضافی و بدون PASS 2.

## نتیجهٔ پذیرش

همهٔ معیارهای صریح همین دور که در جدول‌های زیر آمده‌اند پس از اجرای مجدد PASS شدند. هیچ production code در verification نهایی تغییر نکرد؛ خطاهای اولیهٔ harness (نام‌گذاری `Shift+Tab`، scope متغیر token، شمارش کارت با templateهای archiveشده و focus اپنر) اصلاح روش آزمون بودند، نه defect برنامه، و مسیرهای مربوطه با harness درست دوباره PASS شدند. هیچ موردی که اجرا نشده در این tracker VERIFIED اعلام نشده است.

## مرورگر زنده و رفتار کسب‌وکار

| حوزه | خروجی دقیق | نتیجه |
|---|---|---|
| Product 360 | `22/22`؛ یک dialog متمرکز و accessible، body scroll lock، focus trap با Shift+Tab/Tab، Escape و restore focus/scroll؛ هر 10 ناحیه؛ inventory/history خواندنی و بدون write؛ 10 تب × عرض‌های `360/390/768/1024/1440` بدون overflow صفحه یا modal تکراری. | PASS |
| Sales modes + category + ویرایش سری | `26/26`؛ retail-only / wholesale-only / both روی سرور ذخیره و پس از navigation/reload حفظ شدند؛ wholesale-only خرده را فعال نکرد؛ category با نام canonical ذخیره‌شده نمایش داده شد؛ ویرایش سری در API relational ذخیره، reload، سپس به مقدار اصلی برگردانده شد. | PASS |
| Series create/reload | `9/9`؛ Add Series یک کارت draft افزود؛ save یک template relational فعال ساخت؛ پس از reload در فرم ظاهر شد؛ حذف از فرم آن را archive کرد و سری‌های قبلی فعال ماندند. | PASS |
| Product Studio و responsive | UAT زنده `145/145`؛ شامل سه حالت فروش، category/profile، ماتریس واقعی، رسانه، guide، قیمت/SEO، save/edit/reload، no-stock-on-create، تست error/unsaved، RBAC و sweep پنج‌عرضی. | PASS |
| Color × Size matrix | `7/7`؛ ماتریس واقعی در هر پنج عرض `360/390/768/1024/1440` بدون overflow؛ نشست/خروجِ بدون ذخیره نیز تأیید شد. | PASS |
| Series Builder responsive | `5/5` در `360/390/768/1024/1440`؛ کارت ترکیب و CTA اصلی قابل‌دسترسی و بدون overflow. | PASS |
| WMS browser helper | `28/28`؛ settings/location، رسیدهای مستقل، preview و validation اصلاح، signed delta، receive/shortage، موجودی/incoming، و توقف/فعال‌سازی فروش در scope واریانت. | PASS |
| WMS responsive | `20/20`؛ چهار تب اصلی در هر پنج عرض، بدون overflow افقی صفحه و تب جاری قابل مشاهده. | PASS |
| Exact unpack acceptance | تست embedded `PO acceptance: S2 M2 L2 × 3` PASS شد: 3 سری، دریافت `18` قطعه به retail، ledger برابر `18`، 2 سری wholesale باقی‌مانده، replay همزمان با همان کلید idempotent، payload متفاوت `409` و snapshot ترکیب حفظ شد. | PASS |
| Supplier 360 | `15/15`؛ WorkspaceModal متمرکز، focus/scroll/Escape، موجودی واقعی WMS از DB/UI برابر `۰` در برابر ظرفیت و مقدار قابل‌درخواست `۲۰`؛ هیچ business write در تب‌های stock/capacity. | PASS |
| Cutout / media privacy | `5/5`؛ CDP هیچ `/api/v1/product-media/:id` برای draft preview ندید؛ دو `/files/:id` خصوصی برای ادمین خوانده شدند؛ endpoint عمومی برای همان draft همچنان `404`؛ بدون business write. | PASS |

## تست‌های خودکار و build

| دستور / suite | نتیجهٔ دقیق | مدت |
|---|---:|---:|
| `backend npm test` | 142 tests: 77 pass, 65 skipped, 0 fail, 0 cancelled, 0 todo | TAP `50867.304 ms`; wall `51.046 s` |
| `backend npm run test:embedded` | 187/187 pass, 0 skipped/fail | TAP `118564.609 ms`; wall `124.473 s` |
| `backend npm run test:contract` | 104/104 checks | wall `10.173 s` |
| `backend node scripts/verify-migrations.mjs` | 43/43 assertions | wall `10.015 s` |
| Product Studio browser UAT | 145/145 | wall `82.126 s` |
| Backend TypeScript build | pass | wall `12.606 s` |
| Frontend Vite production build | pass؛ 2011 modules transformed | wall `7.020 s` |

`npm test` عادی 65 تست integration را به‌علت نداشتن embedded DB skip می‌کند؛ اجرای `test:embedded` همهٔ 187 تست را بدون skip اجرا کرد. تست‌های migration، دسته canonical و قیمت‌گذاری سری 069/070 را از صفر و از دیتابیس upgradeشده بررسی کردند.

## تشخیص‌ها و اثر fixtureها

- Product Studio UAT: صفر uncaught page errors، صفر duplicate-key warning. یک PATCH `400` عمداً برای سنجش خطای ذخیره intercept شد و فرم بدون از دست‌دادن داده خطا را نمایش داد.
- 68 درخواست منبع خارجی به `images.pexels.com` / `fonts.googleapis.com` در محیط sandbox با `ERR_CONNECTION_CLOSED` شکست خوردند؛ API محلی، upload فایل، Product 360، WMS و cutout preview خصوصی PASS بودند.
- Browser/WMS UAT از fixtureهای QA روی PGlite محلی استفاده کرد؛ writeهای هدفمند فقط دادهٔ تست بودند. Product 360 و Supplier 360 هیچ write کسب‌وکاری صادر نکردند.
- محصول آزمایشی Series از فرم حذف و در سرور archive شد؛ templateهای اصلی فعال ماندند.

## مورد باز

حداکثر تعداد سفارش عمده در Product Studio UI پیاده‌سازی نشده است (`NOT IMPLEMENTED` در UAT). در چارچوب verification-only و منع PASS 2 تغییری برای آن ساخته نشد؛ این مورد **PASS/VERIFIED نیست**. ردیف‌های دیگر gap matrix که در این سند نتیجهٔ اجرای مجدد ندارند نیز VERIFIED تلقی نشوند.

## Delivery

فایل گزارش فارسی: `docs/parallel/CODEX_PRODUCT_WMS_FINAL_REPORT_FA.md`. نتیجهٔ commit، push و برابری local/remote HEAD در پیام نهایی delivery اعلام می‌شود؛ این tracker فقط شواهد اجرایی بالا را ثبت می‌کند.
