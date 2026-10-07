# Business Invariants — کلبه وینتیج (Prompt 4, §177-§181, §228)

هر مورد = قانونی که کد سرور آن را تحمیل می‌کند (نه فقط UI) + شاهد.

## مالی و تسویه
1. **هیچ پرداخت خودکاری به تأمین‌کننده وجود ندارد.** تأیید تسویه هرگز payout صدا نمی‌زند؛ واریز فقط فرم دستی ثبت واریز بانکی است. شاهد: `settlement.test.ts` («zero %payout% outbox after approve»)؛ `settlement_policies.automatic_bank_payout` با CHECK همیشه false (migration 065).
2. **Ledger منبع واقعیت است؛ کیف‌پول projection.** هیچ endpoint ویرایش مستقیم موجودی وجود ندارد (§185)؛ اصلاح فقط از مسیر financial_adjustments با دلیل + audit.
3. چرخه payable تغییرناپذیر است: pending → held → eligible → scheduled → paid؛ گذارها فقط رو به جلو، سند paid قابل ویرایش نیست (`SETTLEMENT_ALREADY_PAID`).
4. واریز فقط به حساب بانکی تأییدشده با snapshot منجمد؛ دوره cooldown پس از تغییر حساب (`BANK_ACCOUNT_UNVERIFIED` / `BANK_ACCOUNT_COOLDOWN`).
5. کنترل دوگانه بالای آستانه (`dualControlThresholdRial`): تأییدکننده ≠ ایجادکننده.
6. بازگشتِ پس از پرداخت → Recovery (RCV) و offset از تسویه‌های بعدی؛ موجودی تأمین‌کننده هرگز منفی نمی‌شود.
7. برداشت قدیمی (WDR) فقط تاریخچه؛ ایجاد جدید = `WITHDRAWAL_DEPRECATED` مگر کلید گذار `legacyWithdrawalsEnabled` فعال باشد.
8. مبلغ تراکنش درگاه باید دقیقاً با intent برابر باشد؛ webhook تکراری duplicate می‌شود نه دوباره‌اعمال (replay-guard در `applyVerifiedPayment`).
9. پول = integer RIAL در سرور؛ UI تومان (÷۱۰). هیچ float پولی وجود ندارد.
10. تخصیص پرداخت batch باید دقیقاً جمع children باشد (§59) و در webhook دوباره تطبیق می‌شود.
11. reconciliation ارائه‌دهنده درگاه صادق است: source ∈ api/statement/manual؛ داده نامعلوم «نامشخص» می‌ماند، هرگز جعل نمی‌شود.

## پرو مجازی (Try-On) — Prompt 4
12. خرید اعتبار فقط از خط پرداخت یکتا (payment_intents purpose=`tryon`)؛ **اعتبار دقیقاً یک‌بار** پس از پرداخت تأییدشده (§199) — قفل FOR UPDATE روی وضعیت خرید + replay-guard رویداد.
13. دفتر اعتبار append-only با `balance_after >= 0` (CHECK دیتابیس): اعتبار منفی ناممکن است.
14. هر ساخت تصویر = ۱ اعتبار؛ کسر قبل از تماس با سرویس، بازگشت خودکار اگر ارسال به سرویس شکست بخورد؛ بدون اعتبار → `TRYON_CREDITS_REQUIRED` قبل از هر تماس با provider.
15. سهمیه رایگان یک‌بارهٔ هر کاربر از سیاست ادمین (`tryon_policy`)؛ بسته‌ها/قیمت‌ها هاردکد نیستند.
16. هزینه هر generation فقط اگر واقعاً معلوم باشد ثبت می‌شود؛ NULL = «Cost Not Connected» صادقانه (§46).

## محصول، انبار و بازبینی
17. **تأیید محصول تأمین‌کننده هرگز موجودی نمی‌سازد** — فقط مجوز بازارچه. شاهد: crm-hub.test.ts «approval never mutates stock» + product-wms-foundation.test.ts «inbound approval must not create stock».
18. هیچ mutation موجودی خارج از اسناد audit‌شده WMS وجود ندارد؛ frontend هرگز stock نمی‌نویسد.
19. ظرفیت اعلامی ≠ موجودی WMS؛ موجودی supplier-at-Kolbe متعلق به تأمین‌کننده است.
20. عمده = Series، خرده = Piece؛ کالای order-driven به همان سفارش قفل است.
21. حذف سخت فقط با صفر مرجع؛ در غیر این صورت archive با دلیل + audit (§131).
22. بازبینی دومرحله‌ای: تأیید و انتشار | عدم تأیید → (نیازمند اصلاح | رد نهایی)؛ رد/اصلاح بدون دلیل ممکن نیست؛ دلیل snapshot می‌شود.

## CRM و مشتری
23. مشتری debt/credit ندارد؛ VIP هیچ سیستم اعتباری ندارد (§102).
24. تغییر email/phone فقط از مسیر تأیید خود مشتری؛ ادمین نمی‌تواند بی‌صدا بازنویسی کند.
25. کمپین‌ها consent-gated: opted-out هرگز پیام بازاریابی نمی‌گیرد (تست breakdown: matched/eligible/optedOut).
26. تغییر consent توسط ادمین همیشه با reason در audit ثبت می‌شود (§100).

## عمومی
27. یک قابلیت = یک سیستم: یک موتور پروموشن، یک CRM هاب، یک مرکز مالی، یک سیستم audit. کلیدهای tab قدیمی redirect می‌شوند، crash نمی‌کنند.
28. pagination/search سمت سرور؛ عملیات bulk = یک تراکنش.
29. خطاها machine-readable code + پیام فارسی دارند (§154-§155).
