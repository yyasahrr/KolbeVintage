# FINAL PRODUCT/WMS INTEGRATION REPORT

**تاریخ:** 2026-10-05
**شاخه:** `arena/01a10817-kolbevintage`
**دامنه:** ادامهٔ verification و delivery ادغام موجود Product/WMS؛ بدون تغییر خارج از scope و بدون PASS 2.

## نتیجهٔ کلی

تمام معیارهای صریح پذیرش این دور که در این گزارش فهرست شده‌اند، پس از اجرای مجدد PASS شدند. در verification نهایی defect کاربردی تازه‌ای بازتولید نشد؛ خطاهای اولیهٔ چند harness مربوط به نام کلید Puppeteer، scope متغیر تست، شمارش templateهای archiveشده و focus اپنر بود و هر مسیر با harness اصلاح‌شده دوباره PASS شد. این‌ها به‌عنوان defect محصول ثبت نشدند.

## پذیرش مرورگر و رفتار کسب‌وکار

| حوزه | نتیجه |
|---|---|
| Product 360 | `22/22` PASS. در عرض 1440، یک `WorkspaceModal` متمرکز و accessible؛ body scroll lock؛ شروع focus در dialog؛ trap با Shift+Tab/Tab؛ Escape، بستن یکتا و بازگردانی focus/scroll. هر 10 ناحیهٔ درخواست‌شده حاضر و خواندنی بود؛ موجودی/تاریخچه کنترل عملیاتی نداشتند و هیچ business write صادر نشد. در `360/390/768/1024/1440`، همهٔ 10 تب بدون overflow صفحه یا dialog تکراری بررسی شدند. مدت: `14.722 s`.
| Sales modes و category | `26/26` PASS. فقط خرده، فقط عمده و خرده+عمده با save، navigation و browser reload روی سرور پایدار ماندند؛ Wholesale-only خرده را فعال نکرد. دسته با نام canonical ذخیره‌شده نمایش داده شد، نه شناسه. مدت: `22.246 s`.
| Series Builder — ویرایش | تغییر template موجود از UI در جدول‌های relational سرور ذخیره شد، پس از reload دوباره خوانده شد و مقدار fixture به حالت اولیه بازگردانده شد (در suite بالا). |
| Series Builder — ساخت | `9/9` PASS. کارت تازه ساخته شد، template فعال با ID واقعی relational ذخیره شد، پس از reload به فرم برگشت و حذف از فرم به‌صورت archive (بدون hard-delete) انجام شد؛ دو سری اصلی فعال ماندند. مدت: `7.991 s`.
| Product Studio UAT | `145/145` PASS؛ create/edit، ساختار و category، قیمت و دو کانال، سری‌ها، رسانه و راهنمای سایز، no-stock-on-create، error/unsaved guard، RBAC و sweep پنج‌عرضی. مدت: `82.126 s`.
| ماتریس رنگ×سایز | `7/7` PASS؛ ماتریس واقعی در `360/390/768/1024/1440` بدون overflow؛ فرم آزمایشی بدون ذخیره بسته شد. |
| Series Builder responsive | `5/5` PASS در `360/390/768/1024/1440`؛ ترکیب سری و CTA اصلی در دسترس و بدون overflow. |
| WMS browser | `28/28` PASS؛ تنظیمات و مکان انبار، رسیدهای مستقل، اصلاح با delta علامت‌دار، preview و validation، دریافت/کسری، تراز on-hand/incoming و توقف/فعال‌سازی فروش در سطح واریانت. مدت: `8.417 s`.
| WMS responsive | `20/20` PASS؛ چهار تب خرده، انتقال، عمده و تنظیمات در پنج عرض `360/390/768/1024/1440` بدون overflow افقی صفحه و با تب جاری قابل مشاهده. مدت: `7.335 s`.
| Supplier 360 | `15/15` PASS؛ dialog متمرکز، scroll/focus/Escape؛ تب «موجودی نزد کلبه» از WMS مقدار فیزیکی `۰` نشان داد، درحالی‌که «ظرفیت اعلامی» برای کارگاه نیلگون `۲۰` اعلامی و `۲۰` قابل‌درخواست نشان داد. این دو مقدار در UI و DB مجزا هستند؛ خواندن هیچ write نداشت. مدت: `5.170 s`.
| Cutout/media privacy | `5/5` PASS در CDP؛ preview از دو `/files/:id` خصوصی ادمین استفاده کرد؛ هیچ درخواست `/api/v1/product-media/:id` در جریان Cutout صادر نشد؛ endpoint عمومی برای همان تصویر draft همچنان `404` است. سیاست published-only تغییر نکرد. مدت: `5.316 s`.

### جریان عملیاتی واقعیِ series unpack

در تست embedded `series-inventory.test.ts` با عنوان `PO acceptance: S2 M2 L2 × 3`، reservation و replay همزمان با یک idempotency key، رد payload تغییریافته با `409`، rollback اتمیک در صورت مغایرت، و dispatch/receive با snapshot ثابت PASS شد. سه سریِ دارای ترکیب S2/M2/L2 به دقیقاً `18` قطعهٔ retail رسیدند؛ مجموع ledger نیز `18` بود و 2 سری عمده با مالکیت Kolbe باقی ماندند. تست در مجموعهٔ embedded `187/187` PASS است.

## نتایج خودکار و build

| دستور | نتیجهٔ دقیق | مدت |
|---|---:|---:|
| `backend npm test` | 142 test؛ 77 PASS، 65 SKIP، 0 FAIL، 0 cancelled، 0 todo | TAP `50867.304 ms`؛ wall `51.046 s` |
| `backend npm run test:embedded` | 187/187 PASS؛ بدون skip/fail | TAP `118564.609 ms`؛ wall `124.473 s` |
| `backend npm run test:contract` | 104/104 checks | wall `10.173 s` |
| `backend node scripts/verify-migrations.mjs` | 43/43 assertions؛ migrationهای 069/070 و upgrade داده‌دار تأیید شدند | wall `10.015 s` |
| `backend npm run build` | TypeScript build موفق | wall `12.606 s` |
| `npm run build` در ریشه | Vite build موفق؛ 2011 module | wall `7.020 s` |

اجرای عادی `npm test`، 65 تست integration را در نبود embedded DB skip می‌کند؛ اجرای embedded همهٔ 187 تست را فعال و PASS کرد. خروجی build فرانت (`dist/index.html`) artifact تولیدی است و نباید وارد commit شود.

## تشخیص‌های مرورگر و دادهٔ تست

- Product Studio UAT: `0` uncaught page errors و `0` duplicate-key warning.
- یک `PATCH 400` عمداً در تست خطای ذخیره inject شد؛ فرم باز ماند، ویرایش حفظ شد و stack/Zod خام نشان داده نشد. این پاسخ خطای موردانتظار تست بود، نه خطای سرویس.
- `68` درخواست resource خارجی از `images.pexels.com` و `fonts.googleapis.com` به‌علت egress محدود sandbox با `ERR_CONNECTION_CLOSED` شکست خوردند؛ درخواست‌های API محلی، upload و preview فایل خصوصی PASS بودند.
- WMS/Product Studio UAT از fixtureهای QA روی PGlite محلی استفاده کرد. تغییرهای عمدی آن‌ها صرفاً دادهٔ تست بودند؛ Product 360 و Supplier 360 هیچ business write نداشتند. سری آزمایشی ایجادشده در انتها archive شد و سری‌های اصلی فعال باقی ماندند.

## موارد باز — صریح و محدود

1. فیلد/قابلیت «حداکثر تعداد سفارش عمده» در Product Studio پیاده‌سازی نشده (`NOT IMPLEMENTED` در UAT). به‌علت دستور verification-only و منع PASS 2 در این دور تغییر نکرد و **PASS/VERIFIED نیست**.
2. دریافت تصاویر و فونت‌های remote از دامنه‌های خارجی در sandbox محدود است؛ این مورد از API یا preview خصوصی محلی ناشی نشد.
3. هیچ ردیف دیگری از gap matrix صرفاً به‌خاطر این گزارش VERIFIED نمی‌شود؛ فقط شواهد دوباره‌اجراشدهٔ بالا تأییدشده‌اند.

## Git delivery

تأیید push با `git push origin arena/01a10817-kolbevintage`، برابری local/remote HEAD و clean working tree مرحلهٔ مستقل delivery است و در پیام نهایی اعلام می‌شود؛ این فایل صرفاً شواهد آزمون و build را ثبت می‌کند.
