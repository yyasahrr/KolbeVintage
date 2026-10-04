# قواعد دامنه و Invariantهای KolbeVintage

این فایل قواعدی را ثبت می‌کند که Agent نباید هنگام Refactor یا Auto-Fix نقض کند.

---

# A. قواعد Marketplace

## RULE-MKT-001 — دو بازار مستقل

Retail و Wholesale دو Channel متفاوت هستند.

این جدایی باید در:

- Access
- Inventory
- Pricing context
- Order context
- Reporting

قابل تشخیص بماند.

## RULE-MKT-002 — VIP Gate

دسترسی به خرید عمده نیازمند Membership/Plan فعال است.

Role یا Label ظاهری نباید جای Membership canonical را بگیرد.

---

# B. Supplier

## RULE-SUP-001 — مسیر اجباری کالا

```text
Supplier → Kolbe Warehouse → QC → Consolidation → VIP
```

## RULE-SUP-002 — حریم خصوصی

Supplier نباید PII مشتری/VIP را ببیند.

## RULE-SUP-003 — بازار Supplier

Supplier برای Domain عمده است؛ Retail ownership/selling توسط Platform Owner مسیر جدا دارد.

## RULE-SUP-004 — موجودی در اختیار Kolbe ≠ ظرفیت اعلامی Supplier

این دو مفهوم در Supplier 360 نباید ادغام شوند.

---

# C. Product / Catalog

## RULE-PROD-001 — Product Studio موجودی نمی‌سازد

ساخت/ویرایش Product Definition نباید:

- Receipt
- Opening stock
- Transfer
- Adjustment
- On-hand write

انجام دهد.

## RULE-PROD-002 — یک Category Source of Truth

کل سیستم فقط یک مفهوم canonical برای Category دارد.

UIهایی مانند:

- Product Type
- Category Profile
- Warehouse Category Profile
- Structure Profile

نباید Domain موازی مستقل بسازند.

اگر دادهٔ legacy لازم است، باید adapter/migration داشته باشد؛ نه Source of Truth دوم.

## RULE-PROD-003 — Category رفتار Product را هدایت می‌کند

Category می‌تواند Defaultهای زیر را تعیین کند:

- Variant dimensions
- Allowed/default sizes
- Technical spec template
- Size guide template
- Business defaults

اما Product Editor باید در محدودهٔ مجاز انعطاف داشته باشد.

## RULE-PROD-004 — Technical Specs و Size Guide دو ساختار متفاوت‌اند

### Technical Specs
Key/Value مناسب است.

### Size Guide
باید جدول دوبعدی Dynamic باشد.

Size Guide نباید به Key/Value تقلیل پیدا کند.

---

# D. Size Guide

## RULE-SIZE-001 — Dynamic 2D Table

Admin باید بتواند:

- ستون اضافه کند.
- ستون را Rename کند.
- ستون را Reorder کند.
- ستون را حذف کند.
- ردیف اضافه کند.
- ردیف را Reorder کند.
- ردیف را حذف کند.
- Unit مناسب تعریف کند.
- Template ذخیره/انتخاب کند.
- Template را برای Product فعلی Customize کند.

## RULE-SIZE-002 — Category-aware, not category-hardcoded

Category می‌تواند Default بدهد، اما سیستم نباید فقط برای پوشاک یا فقط یک نوع لباس Hardcode شود.

---

# E. Inventory / WMS

## RULE-WMS-001 — Inventory authority

موجودی فیزیکی فقط از WMS/Ledger canonical خوانده و تغییر داده می‌شود.

## RULE-WMS-002 — Retail/Wholesale independence

موجودی Retail و Wholesale به‌ازای Variant Domain مستقل هستند.

## RULE-WMS-003 — Official transfer

انتقال بین Domain/Warehouse فقط با سند رسمی Transfer انجام می‌شود.

## RULE-WMS-004 — History preservation

Adjustment/Transfer/QC نباید تاریخچه را با overwrite مخفی کند.

---

# F. Pricing

## RULE-PRICE-001 — سه مفهوم اصلی

برای Product/Variant:

1. قیمت اصلی
2. قیمت خرید ۴ قسط
3. تخفیف‌های مؤثر

## RULE-PRICE-002 — No manual compare price

«قیمت قبل از تخفیف» به‌صورت مقدار دستی نباید Source of Truth باشد.

## RULE-PRICE-003 — Variant Discount Matrix

Admin باید بتواند روی ماتریس:

```text
Color × Size
```

برای Variant انتخابی:

- No discount
- Percentage discount
- Fixed amount discount

تعریف کند.

## RULE-PRICE-004 — Server authority

قیمت نهایی مؤثر باید از Resolver canonical سمت Server حاصل شود.

Frontend calculator مستقل نباید Business Truth جدا بسازد.

---

# G. Promotion / Festival / Coupon

## RULE-PROMO-001 — مفاهیم جدا

- Promotion = Rule-based price reduction
- Festival = Time-bound promotional campaign
- Coupon = Code-based benefit
- VIP benefit = Membership entitlement
- Cashback = Post-purchase loyalty credit

## RULE-PROMO-002 — Festival assignment

Product باید از Pricing و نیز Bulk Action در «همه کالاها» قابل افزودن به Festival باشد.

## RULE-PROMO-003 — Festival precedence

وقتی Product وارد Festival فعال شود:

```text
Festival rule > normal product/variant discount
```

تخفیف قبلی Effective نباشد.

History نباید Hard Delete شود.

از statusهایی مانند `superseded / expired / inactive_by_festival` می‌توان استفاده کرد.

## RULE-PROMO-004 — Exit behavior unresolved

بعد از پایان Festival، تخفیف قبلی نباید بدون Rule صریح کورکورانه فعال شود.

این موضوع در `PRODUCT_DECISIONS_REQUIRED.md` باقی می‌ماند تا Product Owner تصمیم دهد.

---

# H. Bulk Operations

## RULE-BULK-001 — Festival bulk assignment

در «همه کالاها»:

- Multi-select
- Bulk action: افزودن به جشنواره
- Festival chooser popup
- Confirm
- Apply server-side
- Result summary

باید قابل انجام باشد.

---

# I. Orders / Returns

## RULE-RET-001 — Retail return structured flow

حداقل:

```text
Request
→ Review
→ Approve/Reject
→ Receive
→ Inspect
→ Restock/Damage
→ Refund
→ Close
```

## RULE-RET-002 — Refund must reconcile dependent value

Refund باید وابستگی‌های مرتبط مانند Cashback earned/redeemed را به‌صورت idempotent reconcile کند.

---

# J. Cashback

## RULE-CB-001

```text
NO WITHDRAWAL
NO TRANSFER
NO CASH-OUT
```

## RULE-CB-002 — Ledger authority

Balance = Sum of ledger.

هیچ Balance mutable مستقل نباید منبع حقیقت باشد.

## RULE-CB-003 — Server authoritative redemption

Client فقط مقدار پیشنهادی مصرف را ارسال می‌کند؛ Server باید:

- balance
- cap
- eligibility
- concurrency

را دوباره اعتبارسنجی کند.

## RULE-CB-004 — Shipping excluded by default

Wallet به‌صورت پیش‌فرض هزینهٔ ارسال را پوشش نمی‌دهد.

## RULE-CB-005 — Refund restoration

اعتبار مصرف‌شده در Refund/Cancel معتبر باید به‌شکل idempotent بازیابی شود.

---

# K. CRM

## RULE-CRM-001 — 360 belongs to entity

Timeline/Profile generic جدا نباید Source of Truth دوم بسازد.

Customer/Supplier 360 باید مرکز Context آن Entity باشد.

## RULE-CRM-002 — Item-level purchase history

رفتار خرید باید مشخص کند:

- چه کالا
- چه Variant
- چه تاریخی
- چه Order
- مبلغ/وضعیت

## RULE-CRM-003 — Marketing consent

Consent باید persisted و auditable باشد.

---

# L. Admin UI

## RULE-UI-001 — Persian business UI

Raw enum / DB field / snake_case / API wording در UI عادی ادمین نمایش داده نشود.

## RULE-UI-002 — تومان در Display

در UI مدیریتی واحد نمایش پول یکدست و business-friendly باشد؛ storage داخلی می‌تواند Rial باقی بماند.

## RULE-UI-003 — Hub-based navigation

Navigation بر اساس mental model کسب‌وکار باشد، نه تاریخچهٔ implementation.

## RULE-UI-004 — One capability, one canonical entry

Shortcut/deep-link مجاز است؛ Surface موازی مستقل برای یک عملیات حیاتی مجاز نیست.

---

# M. Audit / Traceability

## RULE-AUD-001

عملیات حساس باید Actor/Time/Reason/History داشته باشد.

## RULE-AUD-002

Agent هنگام Fix نباید History یا Auditability را برای ساده‌سازی UI حذف کند.
