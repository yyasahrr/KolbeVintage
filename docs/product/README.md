# KolbeVintage Business Knowledge Pack

این پوشه «لایهٔ دانش کسب‌وکار» برای Agentهای QA / Product / UX / Architecture / Coding پروژهٔ KolbeVintage است.

## هدف

Agent نباید فقط بررسی کند که یک دکمه کار می‌کند یا API پاسخ می‌دهد. باید بفهمد قابلیت موردنظر در کسب‌وکار چه مسئله‌ای را حل می‌کند و آیا مدل داده، UI و Flow واقعاً برای سناریوهای واقعی کافی هستند یا نه.

نمونه:

- فرم راهنمای سایز ممکن است بدون خطا Save شود.
- اما اگر فقط `کلید → مقدار` داشته باشد، نمی‌تواند جدول واقعی شلوار با ستون‌های «کمر، باسن، فاق، قد، دمپا» را مدل کند.
- این مورد `BUG` نیست؛ یک `DOMAIN_DEFECT` است.

## ترتیب اعتبار منابع

Agent هنگام تعارض باید این ترتیب را رعایت کند:

1. **تصمیم صریح و جدید Product Owner**
2. `KOLBE_DOMAIN_RULES.md`
3. `KOLBE_SOURCE_OF_TRUTH.md`
4. `KOLBE_BUSINESS_MODEL.md`
5. `KOLBE_USER_JOURNEYS.md`
6. `KOLBE_DOMAIN_EXPECTATIONS.md`
7. `KOLBE_REAL_WORLD_SCENARIOS.md`
8. رفتار فعلی کد/دیتابیس
9. الگوهای رایج صنعت

> رفتار فعلی کد الزاماً حقیقت محصول نیست. ممکن است خودِ implementation اشتباه یا legacy باشد.

## فایل‌ها

- `KOLBE_BUSINESS_MODEL.md` — کلبه چیست، چه کسانی از آن استفاده می‌کنند و جریان ارزش چگونه است.
- `KOLBE_DOMAIN_RULES.md` — قواعد غیرقابل‌نقض و تصمیم‌های تأییدشده.
- `KOLBE_USER_JOURNEYS.md` — سفرهای واقعی کاربران و اپراتورها.
- `KOLBE_DOMAIN_EXPECTATIONS.md` — انتظار معنایی/عملیاتی از هر Domain.
- `KOLBE_REAL_WORLD_SCENARIOS.md` — سناریوهای واقعی و Counterexample برای شکستن طراحی ضعیف.
- `KOLBE_SOURCE_OF_TRUTH.md` — مرجع canonical هر مفهوم و مالک Read/Write.
- `KOLBE_AGENT_AUDIT_PROTOCOL.md` — پروتکل استفادهٔ Agent از این دانش.
- `PRODUCT_DECISIONS_REQUIRED.md` — تصمیم‌هایی که Agent حق ندارد خودش حدس بزند.

## قانون نگهداری

Agent حق ندارد صرفاً بر اساس implementation فعلی، Business Knowledge را تغییر دهد.

این فایل‌ها فقط در دو حالت به‌روزرسانی شوند:

1. Product Owner تصمیم جدیدی را صریحاً تأیید کند.
2. یک تناقض مستند پیدا شود و Product Owner تصمیم نهایی را اعلام کند.

## وضعیت مبنا

این Pack بر اساس معماری و گزارش‌های فعلی KolbeVintage روی شاخهٔ
`arena/01a0f798-kolbevintage` تا HEAD نهایی‌سازی ادمین `2e16d19` و تصمیم‌های جدید Product Owner دربارهٔ Category، Size Guide، Pricing و Festival تهیه شده است.

این Pack «Target Product Truth» است؛ نه Snapshot صرف از کد فعلی.
