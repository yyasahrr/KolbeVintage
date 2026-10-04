# Product Decisions Required

این فایل صف تصمیم‌هایی است که Agent حق ندارد خودش حدس بزند.

---

## DEC-PRICING-001 — رفتار تخفیف قبلی بعد از پایان Festival

### وضعیت
OPEN

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
