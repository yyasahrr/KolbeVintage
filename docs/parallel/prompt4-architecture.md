# معماری نهایی پلتفرم کلبه وینتیج (Prompt 4 — §177)

## نمای کلی
- **Backend:** Fastify + PostgreSQL (migrations 001…066، additive-only). منبع واقعیت: دیتابیس/API.
- **Frontend:** React + Vite (tsc strict)، تک‌باندل `dist/index.html`.
- **تست:** embedded Node test runner روی PGlite (171 تست)، contract smoke (102 چک)، verify-migrations (fresh + upgrade).

## دامنه‌ها و مالکیت داده
| دامنه | جداول کلیدی | ماژول سرور | سطح UI |
|---|---|---|---|
| محصول/نوع/سری | products, product_variants, series_templates | products.ts, series-*.ts | مرکز محصولات / ساختار |
| WMS | stock_balances, series_stock_balances, اسناد انبار | wms-*.ts | انبار و نقل‌وانتقالات |
| OMS عمده | master_orders, orders(children), payment_allocations | wholesale-oms.ts | مرکز سفارشات |
| پرداخت | payment_intents, payment_events | payments.ts (applyVerifiedPayment = تنها درگاه اثر مالی) | — |
| تسویه تأمین‌کننده | supplier_child_payables, settlement_*, supplier_recoveries, supplier_bank_accounts | settlement-core.ts / settlement-routes.ts | مرکز مالی → پرداخت و تسویه |
| حسابداری | journal_*, accounting_periods, financial_adjustments | ledger.ts, finance.ts | مرکز مالی → حسابداری |
| پرو مجازی | tryon_packages, tryon_credit_accounts/purchases/ledger | tryon.ts + tryon-commerce.ts | مرکز مالی → حوزه‌های مالی → سرویس پرو مجازی + پورتال مشتری |
| CRM | crm_contacts/labels/rules/segments, customer_consents | crm*.ts, buyer360.ts | مرکز CRM (۴ تب) |
| بازبینی بازارچه | product_reviews, review_reasons | marketplace در commerce.ts | بازبینی محصولات |

## IA نهایی کنسول ادمین (پس از Prompt 4)
- **مرکز مالی = یک ورودی سایدبار** با ۶ دامنه (§15):
  1. داشبورد (نمای کسب‌وکار — بدون بدهی مشتری/VIP credit)
  2. حوزه‌های مالی (مالی Marketplace تأمین‌کنندگان، مانده پرداختنی، درآمدها و خدمات جانبی، **سرویس پرو مجازی**)
  3. پرداخت و تسویه (تسویه تأمین‌کنندگان [SettlementCenter]، تاریخچه قدیمی، پیش‌پرداخت‌های بایگانی)
  4. اسناد و گزارش‌ها
  5. حسابداری (دفتر کل، دوره‌ها، اصلاحات، رویدادها)
  6. تنظیمات مالی (سیاست حمل، سیاست مالی تأمین‌کننده)
- **مرکز CRM = دقیقاً ۴ تب:** مشتریان خرده / خریداران VIP / تأمین‌کنندگان / بازاریابی. CrmPanel قدیمی حذف (superseded)، UsersDirectory به تنظیمات منتقل شد (§109).
- **بازبینی محصولات:** UX دومرحله‌ای با فعل‌های صریح (§56-§63).
- پنل‌های بزرگ در WorkspaceModal (نه drawer راست): ویرایشگر محصول، Statement تأمین‌کننده (V2).

## جریان پول (یکتا)
```
مشتری → payment_intent (purpose: order|membership|child_order|child_batch|tryon)
      → provider webhook → applyVerifiedPayment (قفل + تطبیق + replay-guard)
      → اثرها در همان تراکنش: journal entry + {order paid | membership active |
        tryon credits exactly-once | child allocations}
فروش تأمین‌کننده → supplier_child_payables (hold→eligible→scheduled)
      → سند تسویه SET → بررسی → تأیید (بدون payout!) → ثبت دستی واریز بانکی → paid
بازگشت پس از پرداخت → Recovery → offset تسویه بعدی
```

## جریان اعتبار پرو مجازی (Prompt 4)
```
ادمین: بسته/سهمیه (tryon_packages + tryon_policy) — plans:manage
مشتری: خرید بسته → purchase(TRY-…) + intent(purpose=tryon)
پرداخت تأییدشده → grantTryonCredits (FOR UPDATE روی purchase، دقیقاً یک‌بار §199)
ساخت تصویر → consumeTryonCredit (free quota یک‌بار، debit 1، balance_after>=0)
       → شکست provider → refund خودکار؛ بدون اعتبار → TRYON_CREDITS_REQUIRED
گزارش ادمین: درآمد واقعی + هزینه «Cost Not Connected» صادقانه (§46)
```

## قراردادهای پایدار
- پول: integer RIAL سرور / تومان UI (÷۱۰).
- خطا: `{code, message}` — code ماشینی، message فارسی.
- صفحه‌بندی سمت سرور؛ bulk تراکنشی.
- migrations فقط additive؛ 063/064/065/066 دست‌نخورده باقی می‌مانند.
