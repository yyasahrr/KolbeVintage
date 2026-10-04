# Product Decisions Required

این فایل صف تصمیم‌هایی است که Agent حق ندارد خودش حدس بزند.

---

## DEC-PRICING-001 — رفتار تخفیف قبلی بعد از پایان Festival

### وضعیت
DECIDED

### تصمیم تأییدشده تا اینجا
وقتی Product وارد Festival فعال می‌شود:

- Normal Product/Variant Discount دیگر Effective نیست.
- Rule قبلی Hard Delete نمی‌شود.
- History حفظ می‌شود.
- Festival مرجع قیمت مؤثر است.

### سؤال باز
وقتی Festival تمام شد، با Discount قبلی چه کنیم؟

### Option A — inactive باقی بماند
Admin باید دوباره آن را فعال کند.

**مزیت**
رفتار کاملاً قابل پیش‌بینی؛ تخفیف قدیمی ناخواسته برنمی‌گردد.

**ریسک**
Admin نیاز به اقدام دارد.

### Option B — restore خودکار
اگر Discount قبل از Festival active بوده و هنوز window معتبر دارد، دوباره فعال شود.

**مزیت**
کار دستی کمتر.

**ریسک**
ممکن است تخفیفی که Admin تصور کرده منقضی شده دوباره فعال شود.

### Recommendation
Option A تا زمانی که Product Owner تصمیم دیگری بگیرد.

### Product Owner Decision
**Option A** — پس از پایان جشنواره تخفیف قبلی غیرفعال می‌ماند و فعال‌سازی مجدد اقدام صریح ادمین است.

Date: 2026-10-04

Implementation impact:
- Resolver/قیمت مؤثر: قانونِ مُهرخوردهٔ `suspended_by_promotion_id` دیگر با پایان جشنواره خودکار برنمی‌گردد.
- UI «تخفیف و جشنواره» محصول: دکمهٔ «فعال‌سازی مجدد» برای هر قانون معلق + اصلاح متن پیام خروج از جشنواره.
- تست رگرسیون: پایان جشنواره → قانون قبلی غیر مؤثر می‌ماند.

---

## DEC-PRICING-001 — یافتهٔ Audit (QA2-FEST-016)

پیاده‌سازی فعلی (migration 061) رفتار **Option B** را دارد: با پایان/خروج از جشنواره، تخفیف‌های مستقلی که هنوز بازهٔ معتبر دارند خودبه‌خود برمی‌گردند. این با توصیهٔ A در تضاد است؛ سؤال در تاریخ 2026-10-04 به‌صورت گزینه‌ای از Product Owner پرسیده شد.

---

## DEC-SHOP-002 — جستجوی محصول در فروشگاه

### وضعیت
DECIDED (2026-10-04)

### Context
فروشگاه (storefront) هیچ ورودی جستجوی محصول ندارد و API عمومی `GET /products` پارامتر متنی جستجو ندارد (درخواست با `q` → 400). با رشد کاتالوگ، پیدا کردن کالا فقط با فیلتر دسته/جنسیت ممکن است.

### Question
آیا جستجوی متنی محصول به فروشگاه اضافه شود؟

### Option A — بله (پیشنهادی)
پارامتر `q` سمت سرور (نام/برند/دسته) + باکس جستجو در صفحهٔ فروشگاه.

### Option B — فعلاً نه
در backlog بماند؛ فقط به‌عنوان محدودیت مستند شود.

### Recommendation
Option A — افزایشی و بدون ریسک برای مسیرهای موجود.

### Product Owner Decision
**Option A** — جستجوی سادهٔ سرور-محور + باکس جستجوی فروشگاه اضافه شود.

Date: 2026-10-04

---

# Template for new decisions

```markdown
## DEC-DOMAIN-NNN — Title

### وضعیت
OPEN

### Context

### Question

### Option A

### Option B

### Recommendation

### Impact

### Product Owner Decision
TBD
```

---

# Agent Rule

اگر در Audit به رفتار مبهم Business رسیدی:

1. Fix نکن.
2. این فایل را به‌روزرسانی کن.
3. گزینه‌ها را کوتاه و روشن توضیح بده.
4. Recommendation بده.
5. منتظر تصمیم Product Owner بمان.
