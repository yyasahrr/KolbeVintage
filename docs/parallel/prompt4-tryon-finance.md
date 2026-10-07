# مالی پرو مجازی (Try-On Monetization) — Prompt 4 §40-§47, §199

## مدل داده (migration 066 — additive)
- `tryon_packages` — بسته قابل تنظیم ادمین: name، credits>0، price_rial≥0، active، sort، expiry_days، created_by. Seed مفهومی: «بسته ۵ پرو مجازی» = ۵ اعتبار / ۱٬۰۰۰٬۰۰۰ ریال (۱۰۰هزار تومان) — قابل ویرایش، هاردکد نیست.
- `tryon_credit_accounts` — projection موجودی با قفل ردیفی: balance≥0 (CHECK)، free_granted.
- `tryon_credit_purchases` — خرید: reference یکتا `TRY-YYYY-######`، snapshot بسته، status ∈ pending/paid/cancelled، payment_intent_id (unique partial index).
- `tryon_credit_ledger` — append-only: direction credit/debit، qty>0، reason ∈ free_quota/purchase/generation/refund/admin_adjust، `generation_cost_rial` NULL‌پذیر (هزینه فقط اگر واقعاً معلوم)، `balance_after >= 0`.
- `payment_intents`: ستون `tryon_purchase_id` + purpose `tryon` (CHECK قبلی به‌صورت dynamic drop/re-add مثل 064 تعویض شد).
- سیاست: `site_settings['tryon_policy'] = {freeQuota, salesEnabled}`.

## API
| مسیر | دسترسی | شرح |
|---|---|---|
| `GET /api/v1/tryon/packages` | کاربر | بسته‌های فعال + موجودی + وضعیت سهمیه رایگان |
| `POST /api/v1/tryon/purchases` | کاربر | خرید بسته → purchase + payment_intent(purpose=tryon) در یک تراکنش |
| `GET /api/v1/tryon/purchases` | کاربر | تاریخچه خریدهای خودش |
| `GET/POST /api/v1/admin/tryon/packages`، `PATCH …/:id` | plans:manage | CRUD بسته (غیرفعال‌سازی به‌جای حذف) |
| `PUT /api/v1/admin/tryon/policy` | plans:manage | freeQuota / salesEnabled |
| `GET /api/v1/admin/tryon/finance` | payments:read | درآمد paid، اعتبار خریده/رایگان/مصرفی/باقی‌مانده، costStatus صادقانه، ۵۰ خرید اخیر |

## قواعد اجرا
1. **Exactly-once (§199):** grant داخل `applyVerifiedPayment` در همان تراکنش پرداخت؛ قفل `FOR UPDATE` روی purchase + گذار pending→paid؛ replay رویداد provider = duplicate بدون grant دوم. تست: «try-on credits … exactly-once grant» (tryon.test.ts).
2. **مصرف:** هر ساخت تصویر ۱ اعتبار؛ سهمیه رایگان یک‌بار در اولین استفاده credit می‌شود؛ debit قبل از تماس با provider؛ شکست ارسال → refund خودکار؛ موجودی صفر → `TRYON_CREDITS_REQUIRED` (409) بدون هیچ تماس با provider.
3. **صداقت هزینه (§45-§46):** هزینه هر generation نزد آلفا متصل نیست → `generation_cost_rial = NULL` و UI/گزارش «نامشخص — اتصال هزینه برقرار نیست» نشان می‌دهد؛ سود = «درآمد ناخالص» تا اتصال هزینه واقعی.
4. **جریان درآمدی (§19-§23 D):** endpoint درآمدها (`/admin/finance/revenue-streams`) درآمد tryon را از `tryon_credit_purchases(status='paid')` می‌خواند — با پرداخت واقعی به‌طور خودکار «فعال» می‌شود.
5. `salesEnabled=false` → سرویس به حالت رایگانِ rate-limited برمی‌گردد (کلید گذار تجاری؛ §41 «پشتیبانی‌شده ≠ فعال»).

## UI
- **ادمین:** مرکز مالی → حوزه‌های مالی → «سرویس پرو مجازی»: KPIها، مدیریت بسته‌ها (ساخت/فعال‌غیرفعال)، سیاست (سهمیه رایگان/کلید فروش)، خریدهای اخیر، کارت صداقت هزینه.
- **مشتری:** پورتال پرو مجازی، کارت «اعتبار پرو مجازی»: موجودی + سهمیه رایگان + بسته‌ها + خرید (ایجاد intent در خط پرداخت یکتا؛ اعتبار پس از تأیید پرداخت درگاه).

## شواهد تست
- embedded: بسته ادمین‌ساز → خرید → `applyVerifiedPayment` → grant یک‌بار؛ replay = duplicate؛ رویداد دوم → conflict؛ ۳ ساخت (۲ خریده + ۱ رایگان) → provider دقیقاً ۳ بار؛ چهارمی → 409 بدون تماس provider؛ RBAC: customer → 403؛ بسته غیرفعال → 404. کل suite: **171/171**.
