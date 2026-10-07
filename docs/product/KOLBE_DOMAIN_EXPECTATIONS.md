# انتظارات معنایی و عملیاتی Domainها

این فایل برای کشف `DOMAIN_DEFECT` است.

Agent نباید فقط بپرسد «آیا feature کار می‌کند؟»
باید بپرسد «آیا feature برای استفادهٔ واقعی کافی است؟»

---

# 1. Product / PIM

## هدف
تعریف کامل چیزی که قرار است فروخته شود، بدون ایجاد موجودی فیزیکی.

## باید بتواند
- Identity
- Category
- Variants
- Color
- Size
- Technical specs
- Size guide
- Media
- Base/installment pricing
- Wholesale commercial series
- SEO

## نشانه‌های Domain Defect
- Product بدون Variant strategy واضح
- Category duplicate
- Spec hardcoded
- Size guide تک‌مقداری
- Inventory write داخل Product Studio
- Compare price دستی
- Festival logic پراکنده

---

# 2. Category

## هدف
یک Taxonomy واحد برای رفتار Catalog.

## انتظار
Category باید بتواند Default/template فراهم کند ولی Domain موازی نسازد.

## Defect Example
«شلوار» در چند ساختار مستقل با کد/قواعد متفاوت وجود داشته باشد.

---

# 3. Technical Specifications

## مدل درست
```text
Key → Value
```

## قابلیت لازم
- Add/remove/reorder
- Template
- Custom value
- Per-product override

---

# 4. Size Guide

## مدل درست
Dynamic 2D table.

## قابلیت لازم
- Dynamic columns
- Dynamic rows
- Units
- Reorder
- Template
- Per-product customization

## Domain Defect
اگر فقط بتوان یک «عنوان/مقدار» برای هر ردیف ثبت کرد.

---

# 5. Pricing

## هدف
تعریف Base Price و Installment Price و مشاهده/مدیریت discount context.

## انتظار
- Base
- 4-installment
- Variant matrix
- Effective price preview
- Festival assignment
- Audit/history

## Defect
- manual compare price
- client-only pricing truth
- product/variant discount بدون precedence
- festival جدا و disconnected

---

# 6. Promotions

## انتظار
Admin بفهمد تفاوت Promotion/Festival/Coupon/Cashback چیست.

## Festival
Campaign context است و Ruleهای خودش را اعمال می‌کند.

## Defect
یک Product هم‌زمان از دو engine مستقل قیمت بگیرد.

---

# 7. All Products

## هدف
مرکز عملیاتی Catalog.

## انتظار
- Search/filter
- Bulk select
- Bulk publish/archive where relevant
- Bulk festival assignment
- Drill-down Product 360
- Status clarity
- No runtime errors

---

# 8. Product 360

باید Context بدهد:

- Overview
- Variants
- Specs
- Size guide
- Media
- Pricing
- Promotions
- Inventory summary
- Wholesale
- History

WMS write forms نباید داخل آن پنهان شوند.

---

# 9. WMS

## سؤال اصلی
آیا اپراتور واقعاً می‌تواند عملیات فیزیکی انبار را مدیریت کند یا فقط چند جدول می‌بیند؟

## انتظار
- Receive
- QC
- Put-away/setup
- Balance
- Reservation
- Transfer
- Adjustment
- Damage
- Incoming
- History
- Exceptions

---

# 10. Transfer

## انتظار حداقلی
- Source
- Destination
- Item/variant
- Requested qty
- Dispatched qty
- Received qty
- Status
- Actor
- Timestamps
- Exception/discrepancy

## Counterexample
۲۰ عدد ارسال، ۱۸ سالم دریافت، ۲ آسیب‌دیده.

اگر سیستم فقط «کم کردن A و زیاد کردن B» دارد، Domain ناقص است.

---

# 11. Orders

Detail باید پاسخ دهد:

- What happened?
- Current state?
- Payment state?
- Fulfillment state?
- Shipping state?
- Return state?
- Wallet usage?
- Next action?
- History?

---

# 12. Returns

باید lifecycle ساخت‌یافته داشته باشد، نه Ticket آزاد.

---

# 13. CRM

CRM باید بیش از Profile viewer باشد.

## انتظار
- Customer 360
- Purchases
- Returns
- Wallet
- Support
- Consent
- Segments/tags
- Timeline
- Notes
- Follow-up context

---

# 14. CRM KPI UI

اعداد باید:

- Hierarchy واضح
- Label
- Unit
- Context
- Trend/meaning در صورت وجود
- Card density منطقی
- Responsive

داشته باشند.

عدد بزرگ بدون معنی یا واحد، UI خوب محسوب نمی‌شود.

---

# 15. Supplier Operations

Journey باید قابل دنبال‌کردن باشد:

```text
Application
→ Approval
→ Profile
→ Offers
→ Inbound
→ QC
→ Performance
→ Finance
→ Documents
```

Supplier Hub باید پراکندگی بین ماژول‌ها را کاهش دهد.

---

# 16. VIP

VIP status باید از Membership/Entitlement canonical بیاید.

لیست VIP نباید کاربران عادی یا Admin را صرفاً با heuristic نشان دهد.

---

# 17. Cashback

## انتظار
- Pending
- Available
- Used
- Expired
- Earn
- Release
- Redeem
- Reverse
- Refund restore
- Admin adjustment
- Liability reporting
- Idempotency
- Concurrency safety

---

# 18. Finance

Finance باید بتواند توضیح دهد:

- چه پولی وارد شد؟
- چرا؟
- چه مبلغی باید پرداخت شود؟
- به چه کسی؟
- چه چیزی Refund شد؟
- چه Liabilityای باقی است؟

Raw technical ledger code نباید UI اصلی باشد.

---

# 19. Support

Support باید:

- Queue
- Priority
- SLA context
- Customer/order context
- Status
- Assignment/follow-up در صورت نیاز

داشته باشد.

---

# 20. Content / CMS / SEO

UI باید Business-facing باشد.

Migration/table/API terminology در صفحهٔ اصلی Admin جایی ندارد.

---

# 21. Admin Hubs

Hub خوب فقط Menu نیست.

باید:

- Summary
- Pending
- Exceptions
- Recent activity
- Quick actions
- Deep-links

داشته باشد.

---

# 22. UI System

Agent باید consistency را در کل پروژه بررسی کند:

- SearchBox
- Input heights
- Button heights
- Padding
- Gap
- Card spacing
- Tables
- Modals
- Typography
- RTL
- Responsive
- Empty/loading/error state
- Focus
- Overflow

این موارد فقط Cosmetic نیستند؛ inconsistency گسترده یک UX defect سیستمی است.
