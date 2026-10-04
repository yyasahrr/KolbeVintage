# ماتریس شکاف محصول، عمده و انبار

تاریخ تدوین اولیه: 2026-10-04 · تاریخ بازبینی نهایی: 2026-10-05 · شاخهٔ پیگیری: `arena/01a10817-kolbevintage` · نقطهٔ شروع بازبینی نهایی: `3eaa71834ea6ce092e67f13a5effb5cb484974f7` · upstream: `origin/main@3cd9dace97e00e3131af018fb5b696f8c18d67fc`.

## قرارداد شواهد

نسخهٔ اولیه حاصل بررسی کد، migrationها، قرارداد API و تست‌های موجود بود و عمداً هیچ PASS اجرایی ادعا نمی‌کرد. نتایج اجرای نهایی این شاخه در پیوست «شواهد اجرایی 2026-10-05» آمده‌اند؛ وضعیت آن پیوست فقط برای مواردی است که واقعاً دوباره اجرا شدند و جایگزین کشف‌های خارج از این محدوده نیست. وضعیت «درست» در ماتریس یعنی مسیر پیاده‌سازی مطابق قاعده یافت شده است. موارد MEDIUM پیش از هر اصلاح نیازمند بازتولیدند. مشخصات کامل مالک محصول خوانده شد و در آغاز عنوان مدیریت سفارشات پایان می‌یابد؛ معماری سفارش تازه‌ای تعریف نمی‌شود.

منابع: PO = فایل «کلبه وینتیج.md» و درخواست جاری؛ DR = KOLBE_DOMAIN_RULES؛ ST = KOLBE_SOURCE_OF_TRUTH؛ BM = KOLBE_BUSINESS_MODEL؛ UX = USER_JOURNEYS/DOMAIN_EXPECTATIONS؛ SC = REAL_WORLD_SCENARIOS؛ DEC = PRODUCT_DECISIONS_REQUIRED. همه مسیرهای اسناد در `docs/product/` هستند. تصمیم‌های DEC-PRICING-001 و DEC-SUPPLIER-004 و DEC-SEED-005 قطعی‌اند و دوباره پرسیده نمی‌شوند.

## مالکیت قابلیت‌ها

کاتالوگ مالک تعریف محصول و واریانت است؛ دسته canonical مالک پیش‌فرض‌هاست؛ Pricing مالک تنظیم تجاری و resolver سرور مالک قیمت مؤثر است؛ promotion store مالک جشنواره است؛ series_templates/items مالک ترکیب سری است؛ supplier_offers مالک ظرفیت تجاری است؛ اسناد WMS و ledger مالک موجودی فیزیکی‌اند؛ owner_type/supplier_id مالکیت کالا را از warehouse_id جدا می‌کنند. UI خلاصه مجاز به ایجاد نویسندهٔ عملیاتی دوم نیست.

## شکاف‌ها

هر ردیف شامل Requirement، Current behavior، Expected behavior، Source of Truth، Backend files، Frontend files، DB impact، Root cause، Required change، Risk و Verification method است. B مسیر زیر backend/src و F مسیر زیر src است.

| ID / Requirement / Status | Current → Expected | Source of Truth | Backend files | Frontend files | DB/migration impact | Root cause / Required change | Risk / confidence | Verification method |
|---|---|---|---|---|---|---|---|---|
| CAT-01 یک دسته / DUPLICATED | cms_categories برای hierarchy، category_profiles برای schema، product_types برای سایز همگی قابل نوشتن‌اند → یک authority با adapter | PO، DR-PROD-002/003، ST | cms-studio.ts، product-lifecycle.ts، product-types.ts، catalog.ts | product-structure-panel.tsx، catalog-hub.tsx، admin-product.tsx | پیوند افزایشی و backfill؛ حذف داده ممنوع | اتصال مبتنی بر نام و legacy editor؛ تجمیع تنظیمات و bridge قابل ردگیری | P1 HIGH؛ CROSS_DOMAIN_CHANGE | ایجاد دسته، پیش‌فرض سایز، مصرف Studio/ویترین، compatibility |
| CAT-02 hierarchy/search/inline / IMPLEMENTED_PARTIALLY | Studio hierarchy/search/create از CMS دارد؛ profile مستقل با متن آزاد → schema همان دسته | PO | cms-studio.ts، product-lifecycle.ts | portals/admin-product.tsx | وابسته CAT-01 | دو API بی‌پیوند؛ انتخاب category canonical در profile | P2 HIGH | ایجاد زیر‌دسته و مشاهده schema |
| CAT-03 تغییر دسته / WRONG_MODEL | onChange سایز و سری را فوراً reset می‌کند → داده عمدی بدون تأیید نابود نشود | PO، DR-PROD-003 | catalog.ts | portals/admin-product.tsx:807 | بدون migration | reset غیرشرطی؛ حفظ داده و اعمال defaults فقط برای فرم دست‌نخورده | P1 HIGH | category change با سری/سایز سفارشی |
| CAT-04 validation هنگام edit / IMPLEMENTED_PARTIALLY | create و variant replace schema را بررسی می‌کنند؛ PATCH محصول category/specs را کامل بررسی نمی‌کند → قرارداد واحد | DR-PROD-003 | catalog.ts، product-lifecycle.ts | portals/admin-product.tsx | بدون migration | validation پراکنده؛ validate merged persisted fields | P1 HIGH | PATCH نامعتبر و state بدون تغییر |
| MODE-01 selector / IMPLEMENTED_PARTIALLY | دو switch و default هر دو فعال → انتخاب زودهنگام سه حالت | PO | catalog.ts | portals/admin-product.tsx | همان retail_enabled/wholesale_enabled؛ enum موازی ممنوع | UI کانال‌محور؛ selector مشتق از دو فیلد canonical | P2 HIGH | سه حالت create/edit/API |
| MODE-02 WMS نباید فروش را تعریف کند / WRONG_MODEL | inventory-setup کانال انتخابی را true می‌کند → WMS فقط موجودی کانال مجاز | ST، DR-PROD-001 | product-lifecycle.ts | components/catalog-hub.tsx | بدون migration | اختلاط setup و catalog؛ گارد کانال و حذف flag writes | P1 HIGH | wholesale-only + retail setup رد؛ flags ثابت |
| MODE-03 wholesale-only / IMPLEMENTED_PARTIALLY | بخشی از قیمت خرده شرطی است؛ وایب/رسانه style/فیلدهای خرده هنوز مشترک‌اند → فرم متناسب با عمده | PO | catalog.ts | portals/admin-product.tsx | حفظ historical data | conditional rendering ناقص؛ بخش‌های بی‌ربط حذف شوند | P2 HIGH | wholesale-only مسیر کامل، عدم ایجاد retail stock |
| PROD-01 تعریف بدون stock / IMPLEMENTED_CORRECTLY | create محصول pending و بدون balance؛ stock صفر دمو → همین invariant | PO، DR-PROD-001 | catalog.ts، product-lifecycle.ts | portals/admin-product.tsx | 063 | پایه موجود صحیح؛ حفظ | P1 HIGH | product-wms-foundation.test.ts و شمارش ledger |
| PROD-02 identity/gender/season / IMPLEMENTED_CORRECTLY | identity و taxonomy در DTO و Studio موجود → حفظ | PO | catalog.ts، product-types.ts | portals/admin-product.tsx | موجود | حفظ رفتار | P2 MEDIUM | create/edit roundtrip |
| PROD-03 وایب مستقل / IMPLEMENTED_PARTIALLY | multiselect مستقل و siteApi.vibes موجود؛ ایجاد inline نیاز به بررسی → tag مستقل از category | PO | cms-studio.ts، catalog.ts | portals/admin-product.tsx | موجود | تکمیل ایجاد مجاز و visibility عمده | P2 MEDIUM | create/select/remove vibe |
| VAR-01 ماتریس interactive / IMPLEMENTED_PARTIALLY | cell toggle و SKU در Studio؛ category defaults با legacy تداخل دارند → variant واقعی یکتا | PO، DR-PROD-003 | catalog.ts | portals/admin-product.tsx | unique SKU موجود | رفع category dependency؛ حفظ IDs در edit | P1 MEDIUM | رنگ×سایز، disable cell، عدم duplicate |
| VAR-02 SKU اتوماتیک / IMPLEMENTED_CORRECTLY | generator سرور و SKU unique موجود → حفظ | PO | catalog.ts، migrations/001_core.sql | portals/admin-product.tsx | موجود | بهبود فقط پس از collision test | P1 MEDIUM | parallel create و uniqueness |
| SPEC-01 مشخصات dynamic / IMPLEMENTED_PARTIALLY | template و dynamic editor هست؛ legacy type هم schema می‌دهد → category schema canonical | DR-PROD-004 | specs.ts، catalog.ts، profile.ts | product-specs-editor.tsx، admin-product.tsx | CAT-01 | دو validator؛ legacy فقط adapter | P2 HIGH | add/edit/reorder/template roundtrip |
| SIZE-01 جدول 2D / IMPLEMENTED_PARTIALLY | rows/columns/rename/reorder پیاده‌سازی Arena CODE COMPLETE → verify independent | DR-SIZE-001/002 | specs.ts | product-specs-editor.tsx، product-structure-panel.tsx | 017 موجود | کد جدید نیازمند browser verify | P2 MEDIUM | SCN-SIZE-001..004 |
| MEDIA-01 image/video/cutout / IMPLEMENTED_PARTIALLY | upload و file linkage موجود؛ readonly view و style workspace نیاز بررسی → upload واقعی و preview | PO | storage.ts، video.ts، shaping.ts | admin-product.tsx | موجود | بررسی feedback/ownership | P2 MEDIUM | upload واقعی، reload، errors |
| PRICE-01 base/installment / IMPLEMENTED_PARTIALLY | DTO و Pricing موجود؛ wholesale-only installment server guards ناقص → سیاست مرتبط کانال | PO، DR-PRICE-001 | catalog.ts، promotions.ts | product-social.tsx، admin-product.tsx | موجود | flagهای legacy متعدد؛ همگرایی سیاست | P1 MEDIUM | cash/installment quote و persisted policy |
| PRICE-02 compare دستی / IMPLEMENTED_CORRECTLY | Arena b7eb065 دستی را از قیمت مؤثر حذف کرده → حفظ | DR-PRICE-002 | promotions.ts | product-social.tsx | موجود | حفظ اصلاح Arena | P2 MEDIUM | discount/no-discount نمایش |
| PRICE-03 server effective / IMPLEMENTED_PARTIALLY | GET products enriched resolver دارد؛ tracker قبلی client fallback را گزارش کرده → همه نمایش‌های واقعی از server | DR-PRICE-004 | catalog.ts، promotions.ts، commerce-view.ts | data/api.ts، data/pricing.ts | بدون migration احتمالی | مهاجرت ناتمام؛ trace consumers پیش از تغییر | P1 MEDIUM | Admin/PDP/cart/order quote parity |
| PROMO-01 festival precedence/exit / IMPLEMENTED_CORRECTLY | Arena a1b0795 sticky suspension و explicit reactivate → Option A | DEC-PRICING-001، DR-PROMO-003 | promotions.ts | product-social.tsx | 061 موجود | حفظ؛ بازگشت خودکار ممنوع | P1 HIGH | promo.test.ts و پایان جشنواره |
| PROMO-02 variant matrix/bulk / IMPLEMENTED_CORRECTLY | Arena b7eb065/55afa3c ماتریس و bulk ساخته → verify | PO، DR-PRICE-003/BULK-001 | promotions.ts | product-social.tsx، catalog-hub.tsx | موجود | حفظ اصلاحات Arena | P2 MEDIUM | SCN-PRICE-001/FEST-002 |
| SERIES-01 relational composition / IMPLEMENTED_PARTIALLY | series_templates/items واقعی + قالب‌های محلی legacy → یک recipe canonical | PO | series.ts، series-inventory.ts | portals/series-templates.tsx | 060/062 | UI local recipe bridge؛ trace writes و canonical save | P1 MEDIUM | S2/M2/L2 recipe persisted |
| SERIES-02 series pricing / WRONG_MODEL | API قیمت سری را wholesale product price × pieces حساب می‌کند → قیمت کل سری یا مجموع قیمت اجزا | PO | series.ts، supplier-offers.ts | series-templates.tsx، supplier-wholesale-panel.tsx | افزایشی pricing mode/values با snapshots | قیمت واحد محصول جای قیمت سری؛ schema و resolver واحد لازم | P1 HIGH؛ CROSS_DOMAIN_CHANGE | کل سری و مجموع اجزا، quote/order parity |
| SERIES-03 color scope / IMPLEMENTED_PARTIALLY | derive color_label در صورت تک‌رنگ؛ mixed-color NULL می‌شود → سری رنگ مشخص و گارد | PO | series.ts، series-inventory.ts | series-templates.tsx | data compatibility بررسی | derive بدون منع؛ بازتولید mixed recipe | P1 MEDIUM | رنگ کرم و recipe نامعتبر |
| SUP-01 capacity != stock / IMPLEMENTED_CORRECTLY | supplier_offers و reservations مستقل از ledger؛ mode order_driven/stock_at_kolbe/hybrid → حفظ | PO، DR-SUP-004 | supplier-offers.ts، supplier360.ts | supplier-wholesale-panel.tsx، supplier-360.tsx | 063 موجود | تفکیک صحیح؛ verify | P1 HIGH | capacity reserve بدون stock movement |
| SUP-02 consignment/QC / IMPLEMENTED_CORRECTLY | inbound approve/dispatch/receive/QC با owner supplier → حفظ | PO، DR-SUP-001 | supplier-consignment.ts | supplier-wholesale-panel.tsx | 063 موجود | مسیر صحیح | P1 HIGH | 90/5/5 و supplier stock |
| SUP-03 approval/revision / IMPLEMENTED_PARTIALLY | status/review routes موجود؛ reason و history نیاز بررسی → جریان واقعی و permissions | PO | supplier-requests.ts، catalog.ts | supplier-review-panel.tsx، supplier-requests-portal.tsx | موجود | بررسی state guards | P2 MEDIUM | publish/reject/request changes |
| SUP-04 no direct VIP shipment/privacy / IMPLEMENTED_CORRECTLY | wholesale OMS central QC و DTO masked؛ frozen QA مثبت → حفظ | PO، DR-SUP-001/002 | wholesale-oms.ts، supplier360.ts | supplier-child-orders-panel.tsx | 064 موجود | حفظ guards | P0 HIGH | RBAC/security + DTO PII assertions |
| SUP-05 fake production / WRONG_MODEL | تب تولید PR-331/328/325 hardcoded برای کاربر واقعی → hide طبق تصمیم قطعی | DEC-SUPPLIER-004 | هیچ | portals/supplier.tsx | هیچ | mock ناوبری؛ حذف entry | P2 HIGH | real supplier navigation فاقد تولید |
| OWN-01 ownership/location / IMPLEMENTED_CORRECTLY | series balances owner scope و warehouse location جدا؛ conversion سند دارد → حفظ | PO، ST | supplier-consignment.ts، series-inventory.ts | supplier-wholesale-panel.tsx، series-stock-panel.tsx | 055/062/063 | تفکیک schema صحیح؛ verify UI | P0 HIGH | supplier-owned at Kolbe و conversion audit |
| WMS-01 inventory authority / DUPLICATED | product-inventory.tsx receipt/adjust/transfer توابع عملیاتی دارد و از Studio باز می‌شود → خلاصه فقط read؛ write در WMS | DR-WMS-001، ST، UI-004 | inventory.ts، wms.ts | product-inventory.tsx، admin-product.tsx، warehouse-hub.tsx | هیچ | comment read-only با توابع واقعی ناسازگار؛ حذف نویسنده دوم | P1 HIGH | Studio no stock actions + WMS journey |
| WMS-02 retail/wholesale / IMPLEMENTED_CORRECTLY | inventory_domain و series ledger مجزا → حفظ | DR-WMS-002 | inventory.ts، series-inventory.ts | warehouse-hub.tsx | 055/062 | بررسی read projections | P1 HIGH | تغییر wholesale بدون retail movement |
| WMS-03 receiving/transfers/discrepancy / IMPLEMENTED_CORRECTLY | documents و Arena migration068 discrepancy → حفظ | DR-WMS-003/004 | wms.ts، inventory.ts | warehouse-hub.tsx | 058/068 | حفظ اصلاح Arena | P1 MEDIUM | SCN-WMS-001/002 |
| UNPACK-01 three series / IMPLEMENTED_PARTIALLY | reserve→dispatch_break→receive واقعی با snapshot؛ تست فعلی یک سری متفاوت → acceptance دقیق الزامی | PO | series-inventory.ts | series-stock-panel.tsx | 062 موجود | verify S2/M2/L2 ×3 | P0 HIGH | retail +6/+6/+6 total18، wholesale -3، ledger |
| UNPACK-02 atomic/replay/concurrency / IMPLEMENTED_PARTIALLY | FOR UPDATE transition؛ creation optional key و SELECT-before-INSERT بدون claim → hash conflict و concurrent replay لازم | PO | series-inventory.ts، operations.ts | series-stock-panel.tsx | idempotency store موجود | race روی create؛ canonical claim با hash | P0 HIGH | double-submit، altered payload، rollback |
| UI-01 stepped Studio / IMPLEMENTED_PARTIALLY | step nav مشترک create/edit موجود → sales mode adaptive و WMS مستقل | PO، UX | catalog.ts | admin-product.tsx | هیچ | controls shared؛ بهبود مدل قبل style | P2 HIGH | هر سه حالت و reload |
| UI-02 Product360/heavy workspace / IMPLEMENTED_PARTIALLY | WorkspaceModal primitive/setup موجود؛ specs/series/inventory/history heavy Drawer باقی است → centered | PO | read APIs موجود | primitives.tsx، admin-product.tsx، series-stock-panel.tsx | هیچ | مهاجرت ناتمام overlays؛ reuse WorkspaceModal | P2 HIGH | focus/scroll/360..1440 |
| UI-03 RTL/loading/error/empty / IMPLEMENTED_PARTIALLY | عمدتاً Persian primitives؛ raw supply status در errors و catchهای silent → feedback واقعی | PO، DR-UI-001 | series-inventory.ts | catalog-hub.tsx، warehouse-hub.tsx | هیچ | متن technical و swallowed errors؛ label map/retry | P2 MEDIUM | network fail/empty و responsive |
| HIST-01 price/series snapshots / IMPLEMENTED_PARTIALLY | order price و recipe_snapshot در supply/OMS موجود؛ size guide snapshot نیاز trace → historical meaning ثابت | PO، ST | orders.ts، series-inventory.ts، wholesale-oms.ts | product-specs-editor.tsx | snapshot gap ممکن | trace historical consumers قبل migration/decision | P0 MEDIUM | تغییر قیمت/recipe بعد order؛ اندازه تاریخی |
| STATE-01 state machines doc / MISSING | guards/status checks پراکنده؛ سند canonical مستقل در docs/product نیست → استخراج از guards و قواعد | PO | catalog.ts، wms.ts، supplier-consignment.ts، series-inventory.ts | ops surfaces | هیچ | نبود سند جامع؛ مستندکردن بدون اختراع state | P1 HIGH | transition matrix و invalid transitions |
| AUD-01 business history / IMPLEMENTED_PARTIALLY | series events/audit actor/time/snapshot موجود؛ برخی exceptional reasons اختیاری → reasons و labels قابل پیگیری | DR-AUD-001/002 | operations.ts، series-inventory.ts | series-stock-panel.tsx | موجود | verify exception semantics | P1 MEDIUM | audit before/after و ledger refs |
| SEED-01 real UAT dataset / MISSING | frozen QA seed template/offer ندارد → تصمیم قطعی seed واقعی + سه sales mode | DEC-SEED-005، PO | seed-local.ts | UI server-backed | dev data فقط | incomplete fixtures؛ افزوده بدون production mutation | P2 HIGH | seed ثم browser wholesale journey |

## ده خطر اول و ترتیب اصلاح

1. CAT-01: چند نویسندهٔ مستقل برای دسته و سایز؛ همگرایی افزایشی و حفظ legacy.
2. CAT-04: PATCH می‌تواند قواعد schema را دور بزند؛ validate state ترکیبی.
3. CAT-03: تغییر دسته سری/سایز عمدی را پاک می‌کند؛ حفاظت فرم.
4. MODE-02: WMS کانال فروش کاتالوگ را فعال می‌کند؛ حذف writer و گارد.
5. WMS-01: پنل محصول عملیات انبار موازی ارائه می‌کند؛ خلاصه read-only.
6. SERIES-02: قیمت سری همیشه مشتق از یک قیمت واحد محصول است؛ مدل قیمت مستقل سری.
7. UNPACK-02: پس از اجرای embedded، replay همزمان با همان کلید و payload متفاوت، conflict و atomicity دوباره سبز شدند؛ این دور defectی نشان نداد.
8. UNPACK-01: سناریوی دقیق S2/M2/L2 × 3 دوباره PASS شد؛ 18 عدد retail و ledger، موجودی عمده باقیمانده و recipe snapshot بررسی شدند.
9. HIST-01: تغییر recipe/guide باید از معنای تاریخی جدا بماند؛ trace snapshots.
10. SUP-05: دادهٔ ساختگی تولید در پنل واقعی؛ اجرای DEC-SUPPLIER-004.

## تصمیم‌های محصول

در این نسخه تصمیم جدیدی مطرح نشده است. نبود تست یا بررسی‌نشدن مصرف‌کننده، PRODUCT_DECISION_REQUIRED نیست. خطر snapshot راهنمای سایز ابتدا در کد و سفارش‌های ذخیره‌شده trace می‌شود؛ فقط اگر رفتار واقعاً در منابع تعیین نشده باشد سؤال مطرح خواهد شد.

## شواهد اجرایی 2026-10-05 — شاخهٔ `arena/01a10817-kolbevintage`

این پیوست فقط شواهد اجرای زنده/تست برای پذیرش Product/WMS همین کار را ثبت می‌کند. وضعیت‌های جدول کشف بالا به‌صورت سراسری عوض نشده‌اند؛ موردی که اینجا نیامده VERIFIED نیست.

| ID / محور | نتیجهٔ دوباره‌اجراشده | شواهد |
|---|---|---|
| CAT-01 / CAT-04 | نام دستهٔ canonical در ویرایش Product Studio با مقدار ذخیره‌شده یکی است؛ دسته به‌صورت شناسه/slug در UI نشت نمی‌کند. | Product Studio browser UAT `145/145`؛ mode/category browser `26/26`؛ migration verifier `43/43` (backfill دسته‌ها و حفظ شناسهٔ CMS). |
| MODE-01 / MODE-02 / UI-01 | سه حالت فقط خرده، فقط عمده، و خرده+عمده پس از ذخیره، navigation و reload پابرجا هستند؛ فقط‌عمده خرده را فعال نمی‌کند. WMS نیز کانال فروش را تغییر نمی‌دهد. | browser `26/26`؛ Product Studio `145/145`؛ embedded backend `187/187`، شامل تست گارد WMS. |
| VAR-01 | ماتریس رنگ×سایز در 360/390/768/1024/1440 px بدون overflow صفحه رندر می‌شود؛ تغییر پایدار selectorها پس از UAT فاقد هشدار duplicate-key است. | matrix browser `7/7` (پنج عرض + نشست/خروج)؛ Product Studio `145/145`؛ بدون هشدار React duplicate-key در log پس از اصلاح. |
| SERIES-01 / SERIES-02 | ساخت سری تازه از Product Studio، شناسهٔ relational فعال روی سرور، بارگذاری مجدد در فرم، و حذف از فرم به‌صورت archive (بدون hard delete) تأیید شد؛ ویرایش سری موجود نیز save/reload و سپس restore شد. | Series create/reload `9/9`؛ sales-mode/series edit `26/26`؛ migration `070` در verifier و embedded pricing test. |
| MEDIA-01 | تصویر پیش‌نمایش Cutout از فایل خصوصی ادمین استفاده می‌کند؛ هیچ درخواست `/product-media/:id` در این جریان صادر نشد. فایل محصول draft همچنان از endpoint عمومی `404` می‌گیرد؛ سیاست published-only تضعیف نشده است. | CDP/browser privacy `5/5`؛ Product Studio upload/edit `145/145`؛ embedded test «published catalog media…» PASS. |
| WMS-01 / UI-02 | Product 360 یک WorkspaceModal متمرکز با 10 ناحیهٔ خواندنی است؛ موجودی/تاریخچه read-oriented، بدون write، focus/scroll/escape درست و هر 10 ناحیه در پنج عرض بدون overflow است. | Product 360 browser `22/22`; عرض‌ها `360/390/768/1024/1440`. |
| WMS-02 / UI-03 | WMS چهار تب عملیاتی/تنظیمی در پنج عرض قابل استفاده و بدون overflow صفحه است؛ مسیرهای رسید/اصلاح/دریافت/وضعیت فروش از browser helper اجرا شدند. | WMS helper `28/28`; WMS responsive `20/20`. |
| UNPACK-01 / UNPACK-02 | سناریوی دقیق 3 سریِ S2/M2/L2 با replay همزمان، payload conflict، rollback، recipe snapshot و مالکیت دوباره اجرا شد؛ `18` قطعه به retail رسید، ledger با `18` برابر بود و 2 سری wholesale باقی ماند. | embedded test `series-inventory.test.ts`, case `PO acceptance: S2 M2 L2 × 3`; included in `187/187` PASS. |
| SUP-01 | Supplier 360 موجودی فیزیکی WMS را از ظرفیت تجاری جدا می‌کند: نمونهٔ کارگاه نیلگون در UI موجودی فیزیکی `۰` و ظرفیت/قابل‌درخواست `۲۰` نشان داد؛ خواندن و Escape هیچ write نداشت. | Supplier 360 browser `15/15`; مقایسهٔ DB با UI: on-hand `0`, declared capacity `20`. |
| SERIES/UI responsive | کارت و ترکیب Series Builder و CTA در پنج viewport بدون overflow و قابل استفاده بود. | Series Builder responsive `5/5`. |

### جمع‌بندی تست خودکار و تشخیص

- `backend npm test`: 142 مورد؛ 77 PASS، 65 SKIP، صفر FAIL؛ TAP duration `50867.304 ms` (skips در اجرای بدون embedded DB).
- `backend npm run test:embedded`: 187/187 PASS، صفر SKIP/FAIL؛ TAP duration `118564.609 ms`.
- `npm run test:contract`: 104/104، 10.173 ثانیهٔ wall؛ `node scripts/verify-migrations.mjs`: 43/43، 10.015 ثانیهٔ wall.
- Product Studio UAT: 145/145، 82.126 ثانیهٔ wall؛ backend build: 12.606 ثانیه؛ frontend build: 7.020 ثانیه. build خروجی tracked `dist/index.html` بود و فقط artifact تولیدی برگردانده می‌شود.
- تشخیص مرورگر UAT: page errors `0`؛ duplicate-key warning `0`؛ یک `PATCH 400` عمداً تزریق‌شده برای تست خطای ذخیره و در UI مدیریت شد؛ 68 خطای بارگذاری منابع خارجی (`images.pexels.com` و `fonts.googleapis.com`) به‌علت بسته‌بودن egress sandbox. هیچ‌یک خطای Product/WMS محلی نبود.

### مورد بازِ صریح

حداکثر تعداد سفارش عمده در فرم Product Studio پیاده‌سازی نشده و UAT آن را صریحاً `NOT IMPLEMENTED` ثبت کرد؛ در این کارِ صرفاً verification / بدون PASS 2 تغییر داده نشد. این مورد را PASS/VERIFIED حساب نکنید. سایر ردیف‌های ماتریس که در جدول شواهد بالا نیامده‌اند نیز با این اجرا تأیید نشده‌اند.
