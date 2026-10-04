# AUTO QA FIX TRACKER — Business-Aware Product QA V2

- Branch: `arena/01a0f798-kolbevintage` — baseline `a9a09d8` (knowledge pack commit)
- PASS 1 (DISCOVER) executed with real Chromium against the live local stack (seeded). Evidence: `/tmp/qa-pass1/*.png`, crawl report `/tmp/qa-pass1/report.json`.
- Crawl coverage: all 25 admin sidebar modules (console errors / failed API / overflow@1440 captured per module), All-Products deep-dive (search/archive/pagination/drill), size-guide builder (Ring counterexample executed live), CRM @1440+@360, promo hub + festivals tab, WMS transfers tab, storefront home/shop/PDP @1440+@360.

## FINDINGS (frozen after PASS 1)

| ID | Domain | Type | Sev | Conf | Problem | Root Cause | Action | Verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| QA2-CAT-001 | Category | ARCHITECTURE_DEFECT | P2 | HIGH | سه نظام دسته‌ایِ موازی: `products.category` (متن آزاد) + `category_profiles` (canonical طبق 063 §8-§10، متصل به spec_templates/size_guides) + `product_types` (sizes/spec_template/size_guide_template جداگانهٔ jsonb + آینهٔ relational `product_type_sizes`). `ProductTypesManager` هنوز writer کاربر-رو است و `AdaptiveSpecForm` مسیر legacy در ادیتور | تکامل تدریجی (016→035→063) بدون حذف UI قدیمی | UI نوع محصول از مسیر پیکربندی خارج/پنهان شود؛ category_profiles تنها ورودی پیکربندی؛ مسیر legacy فقط adapter خواندنی؛ هیچ جدول/داده‌ای حذف نشود (RULE-PROD-002) | tsc + crawl + regression | OPEN |
| QA2-PROD-002 | All Products | BUSINESS_FLOW_DEFECT | P2 | HIGH | انتخاب چندتایی و اقدام گروهی وجود ندارد؛ «افزودن گروهی به جشنواره» (RULE-BULK-001، §17.10) ممکن نیست | قابلیت ساخته نشده | چک‌باکس + نوار اقدام گروهی + مودال انتخاب جشنواره + endpoint گروهی سرور (تراکنشی، نتیجهٔ per-item) | browser + API + test | OPEN |
| QA2-PROD-003 | All Products | UX_DEFECT | P3 | HIGH | هیچ drill-down/اقدامی روی سطرهای «همه کالاها» نیست (اقدام‌ها فقط در کارت‌های «تعریف محصول») | ستون اقدام ساخته نشده | ستون اقدام: ویرایش (deep-link به ادیتور همان محصول) | browser | OPEN |
| QA2-PROD-004 | All Products | BUG (گزارش PO) | — | NOT_REPRODUCED | خطای runtime گزارش‌شده در UAT دستی | — | کرال کامل: لود، جستجو (۴ نتیجه), آرشیو، صفحه‌بندی، فیلتر مالک — بدون هیچ console/page error (evidence: 60-all-products.png + report.json) | real browser | NOT_REPRODUCED — جزئیات بازتولید از PO پرسیده شد |
| QA2-SIZE-005 | Size Guide | DOMAIN_DEFECT | P2 | HIGH | سازندهٔ راهنمای سایز: تغییر نام/ترتیب ستون و ویرایش/ترتیب سطر ندارد (RULE-SIZE-001)؛ مدل 2D پویا و counterexample انگشتر PASS شد | endpointها/UI ساخته نشده | PATCH ستون (rename/unit/position) + ویرایش سطر in-place + جابه‌جایی ترتیب | browser + API test | OPEN |
| QA2-SIZE-006 | Size Guide UI | UX_DEFECT | P3 | HIGH | اتصال رسانه فقط با UUID خام و برچسب «شناسه فایل (POST /files)» (نقض RULE-UI-001) | میان‌بر پیاده‌سازی | آپلود مستقیم فایل در همان فرم؛ حذف اصطلاح API | browser | OPEN |
| QA2-SPEC-007 | Product editor | UX_DEFECT | P3 | HIGH | «مشخصات فنی» و «راهنمای سایز» در یک سکشن واحدند؛ خواستهٔ PO دو تب مستقل است (§17.3) | ادغام تاریخی | تفکیک به دو استپ مستقل در ناوبری ادیتور | browser | OPEN |
| QA2-PDP-008 | Storefront PDP | BUG + BUSINESS_FLOW_DEFECT | P2 | HIGH | دکمهٔ «راهنمای سایز» مرده است (onClick ندارد؛ dialogs 0→0)؛ مشخصات فنی هرگز در PDP نمایش داده نمی‌شود — با اینکه هر دو API عمومی (`/products/:id/specs`, `/products/:id/size-guide`) موجودند | UI هرگز به API متصل نشد | مودال راهنمای سایز + بلوک مشخصات فنی از APIهای موجود | browser | OPEN |
| QA2-SHOP-009 | Storefront | BUSINESS_FLOW_DEFECT | P2 | MEDIUM | هیچ جستجوی محصولی در فروشگاه نیست؛ API عمومی هم پارامتر q ندارد (400) | ساخته نشده | پیشنهاد: افزودن q سرور + باکس جستجو (در انتظار تصمیم PO) | API + browser | OPEN — منوط به تصمیم PO (پرسیده شد) |
| QA2-PRICE-010 | Pricing | DOMAIN_DEFECT | P2 | HIGH | `compareAtRial` دستی به‌عنوان قیمتِ خط‌خورده روی کارت‌های CMS نمایش داده می‌شود — «تخفیف‌نما» خارج از موتور پروموشن (RULE-PRICE-002، §17.7) | فیلد نمایشی legacy | حذف ورودی دستی از ادیتور؛ خط‌خورده فقط از resolver (پایه vs مؤثر)؛ دادهٔ موجود در metadata دست‌نخورده | browser + code | OPEN |
| QA2-PRICE-011 | Pricing | DOMAIN_DEFECT | P2 | MEDIUM | نمای ماتریس Color×Size برای تخفیف واریانت وجود ندارد؛ فقط pick-list کور (RULE-PRICE-003)؛ پیش‌نمایش resolver سرور موجود است | UI ساخته نشده | گرید Color×Size با قانون مؤثر هر سلول + ساخت قانون سلولی (بدون/درصدی/مبلغ ثابت) | browser | OPEN |
| QA2-PRICE-012 | Pricing | ARCHITECTURE_DEFECT | P3 | MEDIUM | قیمت مؤثر ویترین سمت کلاینت محاسبه می‌شود (`resolveVariantPromotion`)؛ سرور فقط هنگام سفارش مرجع است — ریسک اختلاف نمایش/فاکتور | معماری تاریخی ویترین | ریسک مستند؛ snapshot سفارش سرور-مرجع است؛ یکسان‌سازی کامل = CROSS_DOMAIN_CHANGE (پیشنهاد فاز بعد) | tests | DOCUMENTED (fix بزرگ خارج از budget این فاز؛ بدون شکست invariant — سرور در سفارش authority است) |
| QA2-WMS-013 | Transfers | DOMAIN_DEFECT | P2 | HIGH | دریافت انتقال all-or-nothing است؛ SCN-WMS-002 (۲۰ ارسال، ۱۸ سالم، ۲ آسیب‌دیده) قابل ثبت نیست؛ خطوط انتقال فقط quantity دارند | schema 012 حداقلی | migration 068 (received/damaged per line) + تکمیل با اختلاف + حرکت‌های ledger مجزا + UI دریافت | API test + browser | OPEN |
| QA2-CRM-014 | CRM | BUG | P2 | HIGH | حساب‌های تأمین‌کننده (کارگاه فراسو/نیلگون — roles=[customer,supplier]) در «مشتریان خرده» فهرست می‌شوند | کوئری فقط role=customer را می‌بیند؛ dual-role خارج نشده | خروج نقش‌های supplier/admin از لیست خرده | API + test | OPEN |
| QA2-UI-015 | UI System | UI_SYSTEM_DEFECT | P3 | MEDIUM | ورودی‌های جستجو ناهماهنگ: SearchBox (۲۰ فایل) vs Input+icon vs `<input>` خام (seo-center) | رشد تدریجی | نرمال‌سازی موارد خام/پرتکرار به SearchBox | browser | OPEN |
| QA2-FEST-016 | Festival | PRODUCT_DECISION_REQUIRED | — | — | رفتار پس از پایان جشنواره: پیاده‌سازی فعلی (061) = بازگشت خودکار (Option B)؛ توصیهٔ pack = Option A؛ DEC-PRICING-001 هنوز OPEN | تناقض implementation با صف تصمیم | از PO پرسیده شد | — | PRODUCT_DECISION_REQUIRED — در انتظار پاسخ PO |

## PASS-1 verifications که سالم بودند (شواهد مثبت)

- کرال ۲۵ ماژول ادمین: ۰ خطای کنسول واقعی، ۰ پاسخ 4xx/5xx پس از لاگین، overflow=۰ در 1440 (report.json).
- «همه کالاها»: لود ۱۳ کالا + جستجوی سرور (۴ نتیجه برای «پیراهن») + آرشیو با empty-state سالم — خطای گزارش‌شدهٔ PO بازتولید نشد.
- Counterexample انگشتر (SCN-SIZE-004) از UI واقعی: ساخت راهنما + ۳ ستون (قطر داخلی mm، محیط mm) + سطر 17.3 → PASS؛ مدل 2D پویاست و apparel-hardcoded نیست.
- جشنواره: فرم ایجاد (کد/نام/بازه/درصد/پالت/مخاطب) + فهرست + اتصال per-product از درایور «تخفیف / جشنواره» (کد + endpoint موجود).
- CRM @1440 و @360: KPIها برچسب و context دارند؛ overflow@360=0؛ tooltip «چرا این وضعیت؟» کار می‌کند.
- فروشگاه: home/shop/PDP overflow@360=0؛ افزودن به سبد فعال.
- انتقال رسمی بین دامنه‌ها: گارد مالکیت تأمین‌کننده→خرده (سند تملک) کار می‌کند (کد inventory.ts G1).

## PASS 3 — VERIFY (مستقل، پس از اتمام فیکس‌ها)

(پس از PASS 2 تکمیل می‌شود)
