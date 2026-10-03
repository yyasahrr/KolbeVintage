# گزارش فاز اصلاحی — Product Studio + CRM/360 + یکپارچگی UX

## BASELINE
- Branch: `arena/01a0f798-kolbevintage`
- Starting SHA: `6d8c74f` (پس از Prompt5-Q4؛ ریموت sync)
- آخرین مهاجرت موجود: `066_tryon_monetization.sql` — مهاجرت جدید فقط در صورت نیاز با شماره 067+
- Ending SHA: (در پایان فاز تکمیل می‌شود)

## K1 — ماتریس شکاف (Gap Matrix) — مبتنی بر بازرسی واقعی کد

### A) Product Studio — `src/portals/admin-product.tsx`

| # | الزام | وضعیت فعلی | حکم | اصلاح لازم | فایل‌ها |
|---|-------|------------|-----|------------|---------|
| P1 | §4 تعریف محصول نباید موجودی بسازد | گام «موجودی اولیه» + انتخاب انبار + تعداد به‌ازای واریانت + حلقه `inventoryApi.receipt→receiveReceipt` بلافاصله بعد از create (L580-620, L632, L973-1014) | **WRONG (P0)** | حذف گام stock و حلقه رسید؛ خلاصه پس از ثبت با «رفتن به راه‌اندازی موجودی» (مسیر canonical: کالاها → نیازمند راه‌اندازی در `catalog-hub.tsx`) | admin-product.tsx |
| P2 | §7 عدم وابستگی به نوع محصول | وقتی پروفایل دسته نباشد، `productTypeId`/`typeCode` در issues الزامی است (L523, L528) | **PARTIAL** | در جریان جدید الزام برداشته شود؛ نوع محصول فقط سازگاری تاریخی (مخفی در UX جدید) | admin-product.tsx |
| P3 | §8 پیام ممنوع «برای افزودن سایز ابتدا نوع محصول…» | L339 عیناً موجود | **WRONG (P0)** | افزودن سایز category-driven: افزودن به پروفایل دسته (صریح) یا فقط همین محصول | admin-product.tsx |
| P4 | §6 مالک همیشه کلبه | بک‌اند `owner_type` را سرور-ساید تعیین می‌کند (catalog.ts L503+: admin→kolbe)؛ UI دراپ‌داون مالک ندارد | **CORRECT** | — | — |
| P5 | §43 بک‌اند create بدون موجودی | `inventory_setup='pending'` برای محصول ادمین (catalog.ts L536-539) ✓ | **CORRECT** | — | — |
| P6 | §9-§11 دسته منبع schema | `categoryProfileFor` + `validateCategoryRequirements` (سایز مجاز + مشخصات الزامی) + `categorySchema` API موجود و در استودیو مصرف می‌شود (`categoryDriven`) | **CORRECT/PARTIAL** | وقتی پروفایل نیست، fallback به type نباید create را بلاک کند | product-lifecycle.ts, admin-product.tsx |
| P7 | §44 خلاصه پس از ثبت | Drawer «محصول ثبت شد — موجودی اولیه» (L1071) | **WRONG** | خلاصه (واریانت/رنگ/سری) + وضعیت «نیازمند راه‌اندازی» + اکشن‌های [راه‌اندازی موجودی]/[بعداً] | admin-product.tsx |
| P8 | §5 ویرایش: موجودی فقط‌خواندنی + [مدیریت موجودی] | جدول محصولات دکمه «موجودی و انبار» دارد؛ داخل استودیو ویرایش فیلد عددی موجودی وجود ندارد (گام stock فقط در create) | **CORRECT پس از P1** | — | — |
| P9 | §51 Needs Setup | `catalog-hub.tsx` + `/admin/products/needs-setup` + سند انبار ممیزی‌شده موجود | **CORRECT** | فقط اتصال از خلاصه create | — |

### B) CRM / 360 — عارضه‌های گزارش‌شده کاربر

| # | الزام | وضعیت فعلی | حکم | اصلاح لازم | فایل‌ها |
|---|-------|------------|-----|------------|---------|
| C1 | §68 دکمه «پرونده ۳۶۰°» برای هر ردیف تأمین‌کننده | `CrmSuppliersPanel` پراپ `onOpen360` دارد اما admin.tsx بدون آن رندر می‌کند → دکمه برای همه ردیف‌ها **مخفی** است؛ ۳۶۰ فقط از `<details>` تاشو جدا | **WRONG (P0)** | اتصال مستقیم onOpen360 → باز شدن Supplier 360؛ حذف `<details>` تکراری | admin.tsx, crm-suppliers-panel.tsx |
| C2 | §69 Supplier 360 باید WorkspaceModal باشد | `Supplier360Drawer` با `<Drawer wide>` (supplier-360.tsx L238) | **WRONG (P0)** | تبدیل به WorkspaceModal (primitives.tsx L252) | supplier-360.tsx |
| C3 | §65 Customer 360 مرکزی | `Customer360Drawer` شیت کناری دست‌ساز (`justify-end`, max-w-4xl) | **WRONG** | WorkspaceModal | crm-retail-panel.tsx |
| C4 | §55 حذف تب عمومی «پروفایل و تایم‌لاین» | `crm-center.tsx` تب `contacts` با همین نام دارد | **WRONG** | حذف تب از هاب بازاریابی؛ پروفایل/تایم‌لاین در ۳۶۰ هر Entity | crm-center.tsx |
| C5 | §56 گاه‌شمار خرید سطح قلم | تب «سفارش‌ها» فقط سطح سفارش (مرجع/وضعیت/مبلغ)؛ هیچ قلم/رنگ/سایز/تعداد/قیمت واحدی نیست | **GAP (P0)** | بک‌اند: `purchases` (order_lines⋈products⋈variants + وضعیت مرجوعی) در 360؛ UI: تب «خریدها» با مرتب‌سازی جدید/قدیم | crm-intelligence.ts, crm-retail-panel.tsx |
| C6 | §75 کنترل‌های رضایت باید کار کنند | Customer 360: رضایت فقط نمایش است (بدون toggle)؛ VIP 360 چک‌باکس دارد (endpoint `/admin/buyers/:id/consent` با reason از Prompt4 پذیرفته می‌شود — crm-hub.test) | **PARTIAL** | toggle در Customer 360 + تست مرورگری واقعی VIP و Retail | crm-retail-panel.tsx |
| C7 | §60-§63 فارسی‌سازی مقادیر | نشت enum خام: `text(o.status)` سفارش، `event_type` تایم‌لاین، `status` دیدگاه، fallback «معلق» برای هر وضعیت غیر active، `cooperation_status` خام در fallback | **WRONG** | ماژول نگاشت برچسب فارسی مشترک + جاروب | crm-retail-panel.tsx، crm-suppliers-panel.tsx، buyer-360-panel.tsx |
| C8 | §86 کدهای رویداد تایم‌لاین | `event_type` خام نمایش داده می‌شود | **WRONG** | نگاشت فارسی رویدادها | crm-retail-panel.tsx (+ ماژول مشترک) |
| C9 | §54 چهار تب CRM | customers/vip/suppliers/marketing ✓ اما زیر «تأمین‌کنندگان» دو `<details>` (تغییر پروفایل + ۳۶۰/مدیریت) باقی است | **PARTIAL** | ادغام در جریان اصلی؛ حذف بلوک‌های تاشوی تکراری | admin.tsx |
| C10 | §103 RBAC | 360 مشتری پشت `crm:manage`؛ consent پشت `buyers:manage`؛ supplier360 پشت پرمیشن خودش | **CORRECT** (تست §30 قبلی) | — | — |

### C) اولویت اجرا
1. **K2 (P0 Product):** حذف جهش موجودی از ProductStudio + حذف وابستگی نوع محصول + سایز category-driven + خلاصه create جدید.
2. **K3 (P0 CRM):** Supplier 360 → WorkspaceModal + دکمه ۳۶۰ همیشه در دسترس؛ Customer 360 → WorkspaceModal.
3. **K4:** گاه‌شمار خرید قلم‌سطح (بک‌اند+UI) + toggle رضایت در Customer 360.
4. **K5:** حذف تب «پروفایل و تایم‌لاین» از هاب بازاریابی + پاک‌سازی `<details>` + فارسی‌سازی enum ها.
5. **K8:** تست‌های مرورگری + جاروب نشت enum + گزارش نهایی.

(بخش‌های AFTER/TESTS در پایان هر برش تکمیل می‌شود.)
