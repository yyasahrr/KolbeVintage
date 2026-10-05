# PRODUCT PRICING + INITIAL INVENTORY FINAL REPORT

**تاریخ:** 2026-10-05
**شاخهٔ تحویل:** `arena/01a10817-kolbevintage`
**مبنای بررسی:** `539cda7af605dbebccd12fa245aa616cbd4de888`
**وضعیت پیاده‌سازی:** PASS — تغییر محدود به قیمت‌گذاری محصول، کنترل Promotion/Festival و ادامهٔ راه‌اندازی موجودی اولیه است.

## تصمیم‌های معماری و دامنه

- Product Studio مرجع تعریف کاتالوگ و قیمت‌های پایه باقی ماند؛ ایجاد/ویرایش محصول هیچ موجودی فیزیکی نمی‌نویسد و هیچ وضعیت قیمت‌گذاری در metadata ذخیره نمی‌کند.
- موجودی همچنان فقط از مرزهای canonical WMS و ledger/رسیدهای آن تغییر می‌کند. ممیزی نشان داد عملیات مناسب `inventory-setup` از قبل وجود دارد؛ بنابراین عملیات افتتاحیه یا موجودیت ledger تازه‌ای ساخته نشد.
- قیمت تبلیغی فقط در رکوردهای canonical `promotions` و `promotion_rules` ذخیره می‌شود. Promotion Center، Product Studio و Product 360 از APIهای موجود، خلاصهٔ محصول و Pricing Resolver واحد استفاده می‌کنند؛ موتور یا حقیقت سمت‌کلاینت موازی افزوده نشد.
- Migration 061 همچنان marker تعلیق `suspended_by_promotion_id` را به کار می‌گیرد. توضیح منسوخ دربارهٔ بازگشت خودکار در migration و سند تصمیم PO اصلاح شد؛ داده‌ها یا ledgerهای موجود بازنویسی نشدند.

## جریان موجودی اولیه

- ایجاد محصول با `inventory_setup = pending` و بدون balance انجام می‌شود. صفحهٔ موفقیت Product Studio دکمهٔ مستقیم ادامه دارد و همان پنل **نیازمند راه‌اندازی** را با `productId` باز می‌کند؛ حالت Skip موجودی را pending نگه می‌دارد و mutation نمی‌فرستد.
- ثبت موجودی اولیه از endpoint و عملیات transaction-safe و idempotent موجود عبور می‌کند: موجودی خرده به‌صورت receiptهای واقعی WMS ثبت می‌شود؛ موجودی عمدهٔ متعلق به Kolbe از Series ledger/stock balance canonical ثبت می‌شود.
- آزمون‌ها مقدار برابر، مقدار جداگانهٔ هر واریانت، سری عمدهٔ Kolbe، مالکیت، audit، و replay با idempotency key بدون دوبرابرشدن موجودی را پوشش می‌دهند.

## قیمت‌گذاری و ترفیع محصول

- فضای کامل قیمت‌گذاری از Product Studio و Product 360 مشترک است و قیمت نقدی، پایهٔ چهارقسطه، سیاست اقساط، قیمت عمده، Discount محصول/رنگ/سایز/واریانت، انتخاب Festival و نتیجهٔ سروری Resolver را فراهم می‌کند.
- چهارقسطه کنترل روشن ON/OFF دارد و اطلاعات مبلغ/سیاست فقط هنگام ON دیده می‌شوند. تنظیمات جزئی Discount یا Festival در حالت خاموش به‌طور پیش‌فرض جمع هستند.
- ماتریس واقعی Color × Size مقادیر تخفیف و وضعیت هر واریانت را آشکار می‌کند. Product 360 خلاصه‌ای فقط‌خواندنی از قیمت کاتالوگ، Promotionها و Resolver canonical ارائه می‌کند و موجودی/قیمت را نمی‌نویسد.
- کنترل سمت‌سرور Festival و Discount مستقل را متقابلاً انحصاری می‌کند. با فعال‌شدن Festival، قوانین قبلی حذف یا تغییر مقدار نمی‌یابند و معلق می‌شوند؛ خاموش/منقضی‌شدن Festival آن‌ها را خودکار فعال نمی‌کند. فقط reactivation صریح Admin marker تعلیق را پاک و مقادیر ذخیره‌شده را عیناً بازمی‌گرداند. تغییرها در audit ثبت می‌شوند.
- کنترل‌های نامعتبر نیز آزموده شدند: نوع/mode نامعتبر، Festival غیرفعال یا شناسه/کانال ناسازگار، درصد خارج از محدوده، Festival هدف‌گرفته‌شده به category، تخفیف مستقل هنگام Festival و انتقال بدون تأیید صریح، با پاسخ‌های 400/404/409 رد می‌شوند.

## نتایج آزمون و build

| کنترل | نتیجه |
|---|---:|
| آزمون متمرکز embedded برای Product/WMS/Pricing/Series (چهار فایل مرتبط) | **29/29 PASS**؛ 0 fail، 0 skip |
| مجموعهٔ کامل `backend npm run test:embedded` | **188/188 PASS**؛ 0 fail، 0 skip، 0 cancelled، 0 todo؛ 51 migration روی DB تازه و اجرای دوم migration بدون تغییر |
| `backend npm run test:contract` | **104/104 PASS** |
| `backend node scripts/verify-migrations.mjs` | **ALL CHECKS PASSED**؛ پایگاه تازه، upgrade داده‌دار و اجرای idempotent دوباره تأیید شد |
| `backend npm run build` | TypeScript موفق |
| `node node_modules/typescript/bin/tsc --noEmit` | TypeScript فرانت موفق |
| `node node_modules/vite/bin/vite.js build` | Vite موفق؛ **2,023** ماژول تبدیل شد |
| `LD_LIBRARY_PATH=/tmp/al2023/lib:/tmp npm run test:browser` | **103/103 PASS** |

### پذیرش مرورگر

- محصول تازه: عدم نوشتن stock در Studio، ادامه به همان Needs Setup با محصول انتخاب‌شده، صفر موجودی اولیه و Skip بدون mutation.
- Product Studio و Product 360: workspace مشترک، ورودی‌های canonical، پیش‌نمایش Resolver، ثبت/بازخوانی از Center و حفظ مقادیر پس از reload.
- مقادیر واقعی واریانت **Black/M = 15%، Black/L = 20%، Cream/XL = 10%** در مسیر `Discount ON → Festival ON → Festival OFF → explicit Discount ON` حفظ شدند؛ Festival در حالت فعال بر Resolver غالب بود، پس از خاموشی تخفیف‌ها خودکار برنگشتند، و reactivation صریح نتیجه‌های canonical را برگرداند.
- ابعاد dialog در **360 / 390 / 768 / 1024 / 1440 px** بدون overflow پذیرفته شدند. هر **25** بخش کنسول نیز walk شد.
- گزارش smoke شامل `failedResponses` است: **0** پاسخ HTTP با status ≥500 و **0** خطای صفحهٔ unhandled. از 113 پیام خام کنسول، 99 مورد `ERR_CONNECTION_CLOSED` برای منابع بیرونیِ مسدودشده در sandbox و 14 مورد 401 از مسیر refresh/auth بودند؛ مورد غیرمنتظره‌ای در assertion باقی نماند.
- اسکن برچسب‌های انگلیسی PASS شد. فقط شناسهٔ فنی seed با الگوی محدود `SEED-*` از تشخیص label کنار گذاشته می‌شود؛ متن UI همچنان اسکن می‌شود.

## فایل‌های شواهد و دادهٔ محلی

گزارش مرورگر و تصاویر در `/tmp/kolbe-admin-smoke/` تولید شدند و artifactهای محلی هستند. `backend/storage/private/2026-10-05/` فقط فایل‌های محلیِ ignored برای fixture/media است و به commit افزوده نمی‌شود. خروجی build در `dist/` و churn نصب/cache در `node_modules/` نیز artifact هستند و وارد commit نمی‌شوند.

## تحویل Git

تمام تغییرات محصول و این گزارش فقط روی `arena/01a10817-kolbevintage` تحویل می‌شوند. پس از commit و push، برابری HEAD محلی/remote و clean بودن worktree به‌طور مستقل بررسی می‌شود؛ وضعیت نهایی در پیام تحویل اعلام خواهد شد.
