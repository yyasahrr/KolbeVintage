# AUTO QA FIX TRACKER — Business-Aware Product QA V2

- Branch: `arena/01a0f798-kolbevintage` — baseline `a9a09d8` (knowledge pack commit)
- **وضعیت فرایند:** PASS 1 اولیه → PASS 2 (شش فیکس) → **به دستور PO، PASS 2 متوقف و PASS 1 با دامنهٔ کامل محصول (۳۰ دامنه × ۱۰ بررسی) بازگشایی و تکمیل شد** → این سند اکنون شامل هر دو موج یافته‌هاست و پس از موج دوم دوباره **FREEZE** شده است.
- شواهد موج اول: `/tmp/qa-pass1/*` · شواهد موج دوم (PASS-1X): `/tmp/qa/*.json`, `/tmp/qa/shots/*.png` (کرال‌های supplier/account/VIP/admin + journeyهای API).
- فیکس‌های انجام‌شده تا لحظهٔ توقف: `184963a` (CRM) · `0997421` (PDP) · `a1b0795` (Festival Option A) · `55afa3c` (bulk festival + drill) · `b7eb065` (pricing compareAt + ماتریس) · `918a0ff` (WMS discrepancy) · `39a6391` (specs/size-guide split + builder editing — تکمیل کار در جریان، بدون فیکس جدید).

## FINDINGS — موج اول (وضعیت به‌روز)

| ID | Domain | Type | Sev | Conf | Problem | Status |
|---|---|---|---|---|---|---|
| QA2-CAT-001 | Category | ARCHITECTURE_DEFECT | P2 | HIGH | سه نظام دسته‌ایِ موازی (products.category متن آزاد + category_profiles canonical + product_types). اقدام: خروج ProductTypesManager از مسیر پیکربندی کاربر-رو؛ category_profiles تنها ورودی؛ بدون حذف داده | OPEN (نیمه‌کاره — ادامه در PASS 2) |
| QA2-PROD-002 | All Products | BUSINESS_FLOW_DEFECT | P2 | HIGH | اقدام گروهی جشنواره (§17.10) | **FIXED `55afa3c`** |
| QA2-PROD-003 | All Products | UX_DEFECT | P3 | HIGH | drill-down سطرها | **FIXED `55afa3c`** |
| QA2-PROD-004 | All Products | BUG (گزارش PO) | — | — | خطای UAT دستی | NOT_REPRODUCED (با تأیید PO بسته شد) |
| QA2-SIZE-005 | Size Guide | DOMAIN_DEFECT | P2 | HIGH | ویرایش نام/ترتیب ستون و سطر | **CODE COMPLETE `39a6391`** — تأیید مرورگری در PASS 3 |
| QA2-SIZE-006 | Size Guide UI | UX_DEFECT | P3 | HIGH | اتصال رسانه با UUID خام | **CODE COMPLETE `39a6391`** — تأیید مرورگری در PASS 3 |
| QA2-SPEC-007 | Product editor | UX_DEFECT | P3 | HIGH | تفکیک مشخصات/راهنمای سایز به دو تب (§17.3) | **CODE COMPLETE `39a6391`** — تأیید مرورگری در PASS 3 |
| QA2-PDP-008 | Storefront PDP | BUG + BUSINESS_FLOW | P2 | HIGH | دکمهٔ مردهٔ راهنمای سایز + نبود مشخصات در PDP | **FIXED `0997421`** |
| QA2-SHOP-009 | Storefront | — | — | — | گزارش نبود جستجو؛ `/search?q` کانونی موجود بود | INVALID (اشتباه PASS-1) · تصمیم DEC-SHOP-002=A (جعبهٔ جستجوی فروشگاه + q سرور) همچنان به‌عنوان بهبود OPEN برای PASS 2 |
| QA2-PRICE-010 | Pricing | DOMAIN_DEFECT | P2 | HIGH | compareAt دستی به‌عنوان خط‌خورده (§17.7) | **FIXED `b7eb065`** |
| QA2-PRICE-011 | Pricing | DOMAIN_DEFECT | P2 | MEDIUM | ماتریس Color×Size تخفیف واریانت (§17.8) | **FIXED `b7eb065`** |
| QA2-PRICE-012 | Pricing | ARCHITECTURE_DEFECT | P3 | MEDIUM | محاسبهٔ قیمت مؤثر ویترین سمت کلاینت؛ سرور در سفارش authority است | DOCUMENTED (CROSS_DOMAIN_CHANGE؛ خارج از budget این فاز) |
| QA2-WMS-013 | Transfers | DOMAIN_DEFECT | P2 | HIGH | دریافت انتقال با مغایرت (۱۸ سالم/۲ آسیب‌دیده) | **FIXED `918a0ff`** (migration 068) |
| QA2-CRM-014 | CRM | BUG | P2 | HIGH | dual-role در «مشتریان خرده» | **FIXED `184963a`** |
| QA2-UI-015 | UI System | UI_SYSTEM_DEFECT | P3 | MEDIUM | SearchBox ناهماهنگ (seo-center خام) | OPEN (PASS 2) |
| QA2-FEST-016 | Festival | PRODUCT_DECISION | — | — | DEC-PRICING-001 = Option A (ابلاغ PO) | **FIXED `a1b0795`** (suspension sticky + فعال‌سازی مجدد صریح) |

## FINDINGS — موج دوم PASS-1X (کل محصول، بدون فیکس — FROZEN)

| ID | Domain | Type | Sev | Conf | Problem / Evidence | Root Cause | پیشنهاد اقدام (PASS 2) |
|---|---|---|---|---|---|---|---|
| QA2-VIP-020 | VIP / Membership gate | BUSINESS_FLOW_DEFECT + ARCHITECTURE_DEFECT | **P1** | HIGH | عضو فعال عمده (seed.customer، پلن seed-gold) در «بازارچه عمده» و هدر حساب، غیرعضو دیده می‌شود («قیمت‌ها پس از عضویت عمده»، «درخواست عضویت عمده») در حالی که سرور عضویت فعال و `wholesale:read` می‌دهد و `/wholesale/products` 200 برمی‌گرداند. Cross-layer verified (کرال + API) | `App.tsx` L97-98 نقش VIP را از store دمو (`buyers`) یا claim نقش `vip` می‌گیرد که جریان عضویت هرگز نمی‌سازد؛ `vip.tsx` فقط وقتی role==="vip" است دادهٔ سرور را می‌خواند | گیت VIP باید از `/membership/current` (عضویت canonical — RULE-VIP) مشتق شود؛ حذف اتکای role به store دمو |
| QA2-RET-024 | Retail Returns | BUSINESS_FLOW_DEFECT | **P1** | HIGH | Counterexample موفق شد در حالی که باید رد می‌شد: ثبت مرجوعی برای سفارش `pending_payment` (پرداخت‌نشده) → 201 (RT-400000) و ادمین تا `refunded` پیش برد؛ مبلغ مرجوعیِ کل-سفارش هم 0 ثبت می‌شود | `POST /returns` (inventory.ts) هیچ گارد وضعیت سفارش ندارد؛ amount فقط از orderLineId | گارد وضعیت مجاز — DEC-RETURNS-003: فقط `shipped`/`delivered` + محاسبهٔ مبلغ سفارش‌-سطح |
| QA2-SUP-017 | Supplier portal | DOMAIN_DEFECT (fake data) | P2 | HIGH | تب «تولید» برای تأمین‌کنندهٔ واقعیِ لاگین‌شده جدول هاردکد PR-331/328/325 + تایم‌لاین QC ساختگی نشان می‌دهد؛ هیچ بک‌اندی ندارد (supplier.tsx L832-860) | mock دمو حذف‌نشده | DEC-SUPPLIER-004: حذف/پنهان تب تا ساخت واقعی |
| QA2-SEED-026 | Wholesale / Seed | BUG (completeness) | P2 | HIGH | هیچ `series_template`ی در seed نیست (GET /series-templates → 0) → سفارش عمدهٔ VIP از UI/دمو غیرقابل‌اجرا (ایجاد master به template نیاز دارد). Journey فقط با ساخت template از API ممکن شد | seed:local سری‌سازی ندارد | DEC-SEED-005 (تأیید شد): افزودن قالب سری + offer فعال به seed |
| QA2-AUD-023 | Audit | BUG | P2 | HIGH | «گزارش حسابرسی» همیشه خالی («رویدادی یافت نشد») در حالی که API رویداد دارد؛ capture شبکه: `?search=undefined&resourceType=undefined&actor=undefined` → items:[] | `financeApi.auditLogs` مقدارهای undefined را به رشتهٔ "undefined" سریال می‌کند (الگوی `new URLSearchParams(params)`)؛ سایر callerهای همین الگو هم باید اسکن شوند | پاک‌سازی params قبل از URLSearchParams + اسکن سراسری الگو |
| QA2-VIP-021 | VIP membership tab | DOMAIN_DEFECT (fake data) | P2 | HIGH | تب عضویت VIP «سقف اعتبار/ماندهٔ اعتبار» جعلی (42٪ هاردکد) و «فعال تا ۱۴ اسفند ۱۴۰۴» هاردکد نشان می‌دهد؛ قاعدهٔ دامنه: VIP هیچ نظام اعتباری ندارد (vip.tsx L879-895, L784) | باقی‌ماندهٔ دمو | حذف اعداد اعتبار؛ نمایش وضعیت عضویت واقعی سرور |
| QA2-SUP-018 | Supplier finance | UX_DEFECT (domain language) | P3 | HIGH | برچسب ناوبری «کیف پول و برداشت» و گزینهٔ محدودیت ادمین «توقف برداشت از کیف پول» با مدل تسویه در تضادند — خود صفحهٔ کیف پول می‌گوید «تسویه خودکار جایگزین درخواست برداشت شده است» (§7) | برچسب‌های legacy | تغییر برچسب‌ها به واژگان تسویه |
| QA2-SUP-019 | Supplier entry | UX_DEFECT | P3 | HIGH | ورود OTP کاربر غیرتأمین‌کننده در `#/supplier` بی‌هیچ پیامی به صفحهٔ معرفی برمی‌گردد (گِیت نقش درست کار می‌کند ولی بازخورد ندارد — supplier.tsx L191) | setAuthed(false) بدون پیام | پیام «این حساب نقش تأمین‌کننده ندارد» + مسیر درخواست همکاری |
| QA2-CB-022 | Cashback admin | UI_SYSTEM_DEFECT (observability) | P3 | HIGH | بنر هاب کش‌بک ادمین به دروغ می‌گوید «این بخش روی دادهٔ محلی کنسول اجرا می‌شود» در حالی که کاملاً سروری است (`/admin/cashback/rules` 200) | `server-connection.tsx` PROBES ورودیِ cashback ندارد → fallback به پیام local | افزودن probe کش‌بک |
| QA2-ARCH-027 | Frontend SoT | ARCHITECTURE_DEFECT | P3 | MEDIUM | باقی‌ماندهٔ store دموی `ops` هنوز در نقاط کاربر-رو مرجع است: نقش/VIP در App.tsx (≡020)، restrictionFor/کمیسیون/withdrawals در supplier.tsx، پلن‌های fallback در vip.tsx، تب غیرقابل‌دسترس finance-legacy | مهاجرت ناتمام دمو→سرور | پاک‌سازی تدریجی؛ حداقل مسیرهای تصمیم‌ساز (نقش، محدودیت) سروری شوند |
| QA2-UI-028 | UI System | UI_SYSTEM_DEFECT | P4 | HIGH | ارقام لاتین در مرکز SEO («47»، «0٪») خلاف قرارداد ارقام فارسی؛ placeholderهای انگلیسی «resourceType/actor» در پنل حسابرسی | جزئی | نرمال‌سازی در گذر UI |
| QA2-SUP-029 | Supplier sidebar | UX_DEFECT | P4 | MEDIUM | سایدبار تأمین‌کننده «تأمین‌کننده تأییدشده · تهران» و آواتار «ن» را برای همه هاردکد می‌کند | جزئی | از پروفایل واقعی |

## PASS-1X — پوشش و شواهد مثبت (دامنه‌های سالم)

**کرال مرورگر واقعی (Chromium headless، @1440 و @360):**
- پرتال تأمین‌کننده: هر ۱۴ تب (داشبورد…تنظیمات) — ۰ خطای API، ۰ خطای JS، overflow=۰ در هر دو عرض. Counterexample ورود غیرتأمین‌کننده: گیت نقش درست رد کرد (فقط بازخورد ندارد → 019).
- حساب خردهٔ مشتری: هر ۱۶ تب (نمای کلی…امنیت) — تمیز در هر دو عرض؛ کش‌بک/کوپن/فاکتور/مرجوعی‌ها/اعلان‌ها همه با empty-state سالم.
- کنسول ادمین: هر ۲۵ ماژول سایدبار — ۰ خطای API پس از لاگین، ۰ pageerror، overflow=۰ (نمونهٔ ۱۰ ماژول @360 هم تمیز). محتوای هر ماژول ثبت شد (adm-content.json).
- فروشگاه: home/shop بدون overflow.

**Journeyهای E2E (API، cross-layer):**
- J1 تأمینِ ورودی: درخواست تأمین (شارژ ۱۰ عدد) → تأیید ادمین → ارسال تأمین‌کننده (رسید RCPT-300066 + incoming + stock_movement) → دریافت انبار (۱۰/۱۰) → بستن درخواست. اعلان‌ها هم تولید شدند (صندوق ادمین). آیتم‌های new_product طبق طراحی تا ساخت محصول رسید نمی‌سازند (کامنت صریح کد).
- J2 زنجیرهٔ عمده: قالب سری (API) → offer عمدهٔ تأمین‌کننده + ظرفیت ۲۰ → master سفارش VIP (MV-2000) → گاردهای درست: بدون تأیید تأمین‌کننده `lock` 409 و پرداخت 409؛ پس از تأیید خط → lock 200 → payment-intent 201 (PAY-100006). ادامهٔ pick/dispatch/receive/QC/consolidation پشت درگاه پرداخت واقعی است و توسط `wholesale-oms.test.ts` پوشش دارد.
- J3 مرجوعی خرده: مکانیک وضعیت‌ها کار می‌کند (requested→approved→received→refunded) ولی counterexample نباید می‌گذشت → یافتهٔ 024.
- J4 CMS→ویترین: `/site/layout` عمومی از سرور (header/footer/announcements) + ۵ صفحهٔ CMS ادمین.
- J5 RBAC: تأمین‌کننده→audit ادمین 403؛ مشتری→عضویت‌های ادمین 403؛ مشتری→review درخواست تأمین 403؛ ناشناس→کاتالوگ عمده 401. همه درست.
- J6 حریم خصوصی: آیتم‌های `/wholesale/products` فقط brandDisplayName (بدون PII تأمین‌کننده)؛ child-orderهای تأمین‌کننده هیچ فیلد خریدار/گیرنده/آدرس ندارند. دوطرفه سالم.
- Supplier360/Buyer360: APIهای `/admin/suppliers/:id/360` (۱۸ بخش: finance/performance/qc/documents/timeline/…) و `/admin/buyers/:id/360` کامل و 200.

## FREEZE

یافته‌های موج دوم (017–029) از این نقطه منجمدند؛ هیچ فیکسی حین PASS-1X انجام نشد. ترتیب پیشنهادی PASS 2: **024 (P1) → 020 (P1) → 023 → 021 → 026 → 017 (طبق تصمیم PO) → 001 ادامه → 022 → 018 → 019 → DEC-SHOP-002 → 015 → 027/028/029**.

## PASS 3 — VERIFY (مستقل، پس از اتمام فیکس‌ها)

(پس از PASS 2 تکمیل می‌شود — شامل تأیید مرورگری 005/006/007 که فقط CODE COMPLETE هستند.)
