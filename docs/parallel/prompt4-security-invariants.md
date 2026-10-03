# Security Invariants — کلبه وینتیج (Prompt 4, §123-§135, §177-§181)

## احراز هویت و RBAC
1. همه endpointهای admin با `principal()` + `requirePermission()` محافظت می‌شوند؛ نقش‌ها/مجوزها از دیتابیس (user_roles / role_permissions).
2. مجوزهای مالی تفکیک‌شده: `payments:read` (مشاهده)، `finance:manage`، `settlements:manage`، `finance:approve`، `bank:verify`، `finance:reconcile`. مدیریت بسته‌های پرو مجازی: `plans:manage`؛ مشاهده مالی آن: `payments:read`.
3. کنترل دوگانه: تأیید تسویه بالای آستانه توسط شخصِ ایجادکننده ممکن نیست.
4. مشتری به هیچ مسیر admin دسترسی ندارد (تست: POST بسته پرو مجازی با نقش customer → 403).

## پول و پرداخت
5. فقط adapter تأییدشدهٔ provider مجاز است `applyVerifiedPayment` را صدا بزند؛ رویداد تکراری provider idempotent است (payment_events unique).
6. تطبیق مبلغ/مرجع/درگاه قبل از هر اثر مالی؛ intent غیر pending قابل پرداخت مجدد نیست.
7. CHECK دیتابیس `payment_intents_target_check` + purpose check: هر intent حداکثر یک هدف (order | membership | tryon purchase از ستون یکتا).
8. هیچ auto-payout: `automatic_bank_payout` در سطح schema همیشه false.
9. اصلاح مالی فقط از financial_adjustments با دلیل + audit؛ هیچ UPDATE مستقیم موجودی (§185).

## PII و داده
10. عکس مشتری در پرو مجازی هرگز persist نمی‌شود؛ یک‌بار برای پردازش ارسال می‌شود؛ خروجی با JWT مخصوص session محافظت می‌شود (کاربر دیگر → 401 بدون تماس با provider).
11. Statement/گزارش‌ها فقط دادهٔ لازم را برمی‌گردانند؛ شماره حساب فقط به‌صورت snapshot تأییدشده.
12. audit_logs یکتا برای همه اقدامات حساس (archive، consent، تسویه، بسته‌ها، سیاست‌ها) با actor + before/after.
13. حذف = archive با دلیل مگر صفر مرجع (§131)؛ zero silent data loss (§153).

## سخت‌سازی
14. Rate limit روی مسیرهای گران (tryon jobs 3/ساعت، status 30/دقیقه) — جدا از کنترل اعتبار.
15. توکن‌های job پرو مجازی: HS256، issuer/audience مخصوص، انقضای ۲۰ دقیقه، در body نه URL.
16. ورودی‌ها همگی zod-validated؛ شماره‌ها/مبالغ به‌صورت رشتهٔ عددی و cast صریح `::int/::bigint`.
17. خطاهای مالی machine code دارند: SETTLEMENT_HOLD_ACTIVE، BANK_ACCOUNT_UNVERIFIED، BANK_ACCOUNT_COOLDOWN، SETTLEMENT_ALREADY_PAID، SETTLEMENT_AMOUNT_CHANGED، FINANCIAL_RECONCILIATION_REQUIRED، PAYABLE_ALREADY_ASSIGNED، INVALID_SHIPPING_POLICY، WITHDRAWAL_DEPRECATED، TRYON_CREDITS_REQUIRED.

## وضعیت QA امنیتی
- تست‌های embedded سناریوهای RBAC/idempotency/concurrency بالا را پوشش می‌دهند (171/171 سبز).
- **Browser QA: NOT RUN** (محیط بدون مرورگر). pen-test دستی انجام نشده — وضعیت صادقانه: Implementation Complete / QA Pending.
