# مدل کسب‌وکار KolbeVintage

## 1. تعریف محصول

KolbeVintage یک پلتفرم تجارت الکترونیک دو-بازاره است:

1. **Retail Market — خرده‌فروشی**
2. **VIP / Wholesale Market — عمده‌فروشی**

پلتفرم فقط یک فروشگاه ساده نیست؛ هم‌زمان نقش‌های زیر را پوشش می‌دهد:

- فروشندهٔ خرده
- اپراتور بازار عمده
- مدیر تأمین‌کنندگان
- انبار مرکزی و QC
- CRM
- مرکز مالی و تسویه
- موتور قیمت‌گذاری/پروموشن
- سیستم وفاداری و Cashback
- CMS / SEO / Content
- مرکز عملیات Admin

---

# 2. بازیگران اصلی

## 2.1 Retail Customer

مشتری عادی که:

- محصولات Retail را می‌بیند.
- سبد خرید و Checkout دارد.
- سفارش خرده ثبت می‌کند.
- می‌تواند مرجوعی ثبت کند.
- Cashback دریافت و در سفارش‌های بعد استفاده می‌کند.
- Cashback را نمی‌تواند برداشت یا انتقال دهد.

## 2.2 VIP / Wholesale Buyer

خریداری که فقط در صورت داشتن Membership/Plan فعال به بازار عمده دسترسی دارد.

VIP:

- به قیمت‌ها و پیشنهادهای عمده دسترسی دارد.
- سفارش عمده ثبت می‌کند.
- اطلاعات خصوصی Supplier را نباید دریافت کند.
- سفارش خود را از Kolbe دریافت می‌کند، نه مستقیماً از Supplier.

## 2.3 Supplier

تأمین‌کنندهٔ عمده.

Supplier:

- درخواست عضویت می‌دهد.
- پس از تأیید، پنل اختصاصی دارد.
- Offer/Product/Capacity مربوط به عمده را مدیریت می‌کند.
- کالا را به **انبار مرکزی Kolbe** می‌فرستد.
- کالا قبل از ورود به چرخهٔ فروش عمده QC می‌شود.
- اطلاعات خصوصی VIP/Customer برای Supplier مخفی می‌ماند.
- مستقیم برای مشتری VIP ارسال نمی‌کند.

## 2.4 Kolbe Platform Owner

مالک پلتفرم می‌تواند:

- در Retail بفروشد.
- در Wholesale بفروشد.
- مالک کالا/موجودی باشد.
- موجودی را بین Domainهای مجاز به‌شکل رسمی منتقل کند.

## 2.5 Admin / Operations

ادمین مسئول ادارهٔ سیستم است، نه توسعهٔ نرم‌افزار.

Admin باید بتواند بدون دانستن API، enum، schema و table name:

- وضعیت سیستم را بفهمد.
- صف‌های منتظر اقدام را ببیند.
- عملیات را انجام دهد.
- مشکل را تشخیص دهد.
- تاریخچه و مسئول هر تغییر را مشاهده کند.

## 2.6 Warehouse / QC Operator

وظیفه:

- دریافت کالا
- بازرسی/QC
- ثبت اختلاف
- Put-away / ورود به موجودی
- انتقال
- Adjustment
- Damage
- دریافت مرجوعی
- ثبت نتیجهٔ بازرسی

## 2.7 Finance / Support

Finance:

- پرداخت، Refund، Settlement، Statement و Liability را مدیریت می‌کند.

Support:

- Ticket و پیگیری مشتری را مدیریت می‌کند.
- نباید به تنظیمات زیرساختی غیرمرتبط دسترسی ذهنی پیدا کند.

---

# 3. جریان ارزش Retail

```text
Product Definition
→ Retail Availability
→ Retail Inventory
→ Storefront
→ Cart
→ Pricing / Promotion / Coupon
→ Cashback Redemption
→ Payment
→ Order
→ Fulfillment / Shipping
→ Delivery
→ Cashback Earn/Release
→ Return / Refund (when applicable)
```

---

# 4. جریان ارزش Wholesale

قاعدهٔ اصلی:

```text
Supplier
→ Kolbe Central Warehouse
→ Receive
→ QC
→ Accepted Wholesale Inventory
→ VIP Order
→ Consolidation
→ Kolbe Dispatch
→ VIP Buyer
```

این Flow یک Invariant است.

هیچ Recommendation عمومی Marketplace نباید آن را با Supplier→Buyer direct shipping جایگزین کند.

---

# 5. دامنه‌های اصلی کسب‌وکار

- Product / PIM
- Category / Structure
- Variants / Color / Size
- Technical Specifications
- Size Guides
- Pricing
- Promotions / Festivals / Coupons
- Retail Inventory
- Wholesale Inventory
- WMS
- Transfers
- Supplier Operations
- VIP / Membership
- Orders / Fulfillment
- Returns / Refunds
- CRM / Customer 360
- Cashback
- Finance
- Support
- CMS / SEO / Media
- Integrations / Automation
- RBAC / Audit / Settings

---

# 6. فلسفهٔ Admin Panel

Admin Panel باید **Operations Platform** باشد، نه مجموعه‌ای از صفحات.

هر Domain مهم باید:

- Hub
- Queue
- Exception
- Summary
- Next Action
- Deep-link
- History

داشته باشد.

سؤال اصلی هر Hub:

```text
چه اتفاقی افتاده؟
چه چیزی نیاز به اقدام دارد؟
چه چیزی مشکل دارد؟
قدم بعدی چیست؟
```

---

# 7. مدل ذهنی Catalog و Inventory

تعریف محصول با موجودی فیزیکی یکی نیست.

```text
Product Studio = تعریف کاتالوگ
WMS = حقیقت عملیات فیزیکی کالا
```

ساخت محصول نباید خودکار Stock ایجاد کند.

بعد از تعریف Product:

```text
inventory_setup = pending
```

و راه‌اندازی موجودی از WMS انجام می‌شود.

---

# 8. مدل ذهنی Pricing و Promotion

سه مفهوم جدا هستند:

- **Base Pricing** — قیمت پایه
- **Installment Pricing** — قیمت خرید ۴ قسط
- **Promotion** — کاهش قیمت مبتنی بر Rule

Compare Price دستی نباید منبع حقیقت قیمت باشد.

Promotion/Festival/Coupon/Cashback مفاهیم یکسان نیستند.

---

# 9. مدل ذهنی Loyalty

Cashback یک حساب بانکی نیست.

```text
Retail Cashback Wallet = Loyalty Credit
```

مشتری می‌تواند آن را در سفارش آینده خرج کند، اما:

- Withdrawal ندارد.
- Transfer ندارد.
- Cash-out ندارد.
- Balance مستقیم edit نمی‌شود؛ Ledger حقیقت است.

---

# 10. معیار موفقیت محصول

KolbeVintage زمانی موفق است که:

- قابلیت‌ها فقط «وجود» نداشته باشند؛ در Flow واقعی قابل استفاده باشند.
- یک مفهوم یک Source of Truth واضح داشته باشد.
- UI اصطلاح فنی داخلی را به Admin تحمیل نکند.
- عملیات حساس traceable و auditable باشد.
- سیستم برای سناریوهای واقعی، نه فقط Demo ساده، کافی باشد.
