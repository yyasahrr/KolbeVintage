# گزارش فاز Master — تجمیع CRM، پاکسازی ناوبری و اصلاحات QA

- **Branch:** `arena/01a0f798-kolbevintage`
- **Start SHA:** `6c48c07`
- **Final SHA:** see `git log` — C10 is the last commit of this phase
- **Migrations:** هیچ migration جدیدی لازم نشد (آخرین migration همان `062` باقی ماند). همهٔ داده‌های موردنیاز CRM/فاکتور/لیبل از schema موجود projection می‌شوند.

## کامیت‌ها (C1–C10)

| # | SHA | عنوان |
|---|-----|-------|
| C1 | `bf56c3a` | nav: «مرکز CRM» canonical + حذف users/buyers/suppliers/sms از sidebar با redirect؛ ادغام wproducts+mreview در WMS |
| C2 | `f5b8efc` | CRM read models + موتور رفتار قابل‌توضیح (rule-based، بدون AI black-box) |
| C3 | `9d36c07` | تب مشتریان خرده + Customer 360 تمام‌عرض؛ تب خریداران VIP (بدون هیچ فیلد اعتباری) |
| C4 | `76ff58d` | تب تأمین‌کنندگان: ستون‌های عملکرد با دلایل قابل‌مشاهده، متریک server-side |
| C5 | `9679551` | تب بازاریابی: ادغام SMS، سگمنت‌های پویا با شمارش زنده، wizard کمپین، سقف فرکانس قابل‌تنظیم، suppression |
| C6–C10 | (کامیت بازیابی — همین کامیت) | محتوای پنج کامیت C6–C10 در یک کامیت بازیابی منتشر شد (توضیح پایین) |

> **یادداشت بازیابی:** کامیت‌های محلی C6=`8f950b9` (بازبینی WMS)، C7=`8065769` (UX وضعیت فروش scope-pure)،
> C8=`0945385` (فاکتور PDF سرور)، C9=`a76598b` (لیبل ارسال PDF سرور) و C10=`4726dc1` (گزارش) به‌دلیل
> انقضای توکن GitHub هرگز push نشدند و در بازسازی sandbox از بین رفتند (object store پاک شد؛ درخت کاری
> سالم ماند). محتوای کامل و اعتبارسنجی‌شدهٔ آن‌ها — بدون هیچ تغییری — از روی درخت کاری در این کامیت واحد
> روی `9679551` (C5) بازنشر شد. تاریخچهٔ push شدهٔ C1–C5 دست نخورده است.

## ناوبری (A)

- ورودی‌های حذف‌شده از sidebar: `users`, `buyers`, `suppliers`, `sms`, `wproducts`, `mreview`, `crm-center`, `buyers360`
- Redirect ها (کلید قدیمی → مقصد): users→crm/retail-customers، buyers→crm/vip-buyers، suppliers→crm/suppliers، sms→crm/marketing، crm-center→crm، buyers360→crm/vip-buyers، wproducts/mreview→wms/wholesale/product-review
- «تعریف محصول» (Product Studio) مستقل و دست‌نخورده ماند.
- هیچ قابلیت backend یا history حذف نشد؛ فقط projection/ناوبری تغییر کرد.

## مرکز CRM (B–F)

- دقیقاً ۴ تب: **مشتریان خرده / خریداران VIP / تأمین‌کنندگان / بازاریابی** + جستجوی سراسری + KPI + مرکز اقدام.
- موتور رفتار rule-based با popover «چرا؟» (شواهد عددی)؛ آستانه‌ها قابل‌تنظیم؛ precedence مستند در `crm-intelligence.ts`.
- Customer 360: درایور تمام‌عرض (موبایل تمام‌صفحه)، ۸ KPI، تب‌های نمای کلی/سفارش‌ها/فعالیت‌ها/علاقه‌مندی‌ها/پشتیبانی/بازاریابی/تاریخچه؛ دادهٔ غایب = «ثبت نشده»؛ علاقه‌مندی‌ها فقط از رفتار واقعی.
- **VIP بدون سیستم اعتباری** — هیچ فیلد limit/available/used/balance در UI یا 360 (تست ۲۳ پاس).
- CRM فقط projection است؛ Orders/Finance/WMS/… منبع حقیقت ماندند.
- بازاریابی: سقف فرکانس پیش‌فرض ۲ پیام/۷ روز (site_settings)، suppression کامل، opt-out هرگز SMS عملیاتی را مسدود نمی‌کند، آمار فقط از دادهٔ واقعی.
- Bulk: یک فراخوانی تراکنشی با نتیجهٔ per-item؛ حذف سخت فقط با history صفر.

## اصلاحات QA

### وضعیت فروش (G — C7)
مودال scope-pure شد: ورود از ردیف محصول = فقط scope محصول (بدون variant نماینده)؛ ورود از variant = همان variant؛ تغییر scope به‌صورت پیشرفته/ثانویه. API scoped backend دست نخورد.

### فاکتور (H — C8)
- `POST /admin/orders/:orderId/invoice` — صدور از `issueInvoiceForOrder` موجود (قیمت از snapshot)؛ بار دوم 200 + `existing:true` → **چاپ مجدد هرگز سند مالی دوم نمی‌سازد**.
- `POST /admin/orders/invoices/bulk` — یک فراخوانی: existing/issued/**missing**/failed per-order + summary؛ صدور موارد غایب فقط با `issueMissing` صریح (بدون فاکتور جعلی خاموش)؛ تراکنش per-order.
- `GET /admin/invoices/bundle?ids=` — PDF چندصفحه‌ای ادغام‌شده از رندرر RTL موجود (pdf-lib copyPages)؛ audited.
- خطوط فاکتور اکنون رنگ/سایز را در description حمل می‌کنند (snapshot هنگام صدور).
- OrdersHub: «فاکتور (PDF)» و bundle از طریق authBlobUrl؛ مسیر document.write فاکتور **حذف شد**.

### لیبل ارسال (I — C9)
- ماژول جدید `backend/src/shipping-labels.ts` روی زیرساخت PDF موجود (فونت فارسی embedded + shaping RTL) — بدون dependency جدید.
- `GET /admin/orders/:orderId/label` — تک‌برگ حرارتی ۱۰۰×۱۵۰ میلی‌متر (283.46×425.2pt)؛ `GET /admin/orders/labels/bundle?ids=&format=thermal|a4` — پشتهٔ حرارتی یا شبکهٔ A4 چهارتایی (ترتیب خوانش RTL). هر دو audited (`label.printed` / `label.bundle_printed`)، مجوز `tracking:manage`.
- محتوا: برند، مرجع/تاریخ جلالی، فرستنده، گیرندهٔ کامل، روش/حامل/رهگیری، **اقلام بسته اجباری** (نام — رنگ/سایز ×تعداد) با حالت فشرده «و X ردیف دیگر…» (maxLines قابل‌تنظیم ۳–۱۲، پیش‌فرض ۶).
- **بدون قیمت**: loader هیچ ستون قیمتی select نمی‌کند (در تست و contract-check تثبیت شده).
- Barcode/QR: زیرساخت موجودی در repo نبود؛ طبق قید «فقط از زیرساخت موجود»، اضافه نشد (کار آینده).

### بازبینی WMS (J — C6)
زیرتب‌های نهایی انبار عمده شامل «محصولات و بازبینی»؛ شش نمای وضعیت؛ reason اجباری برای رد/درخواست اصلاح؛ `archive` سرور-ساید با reason و audit؛ تأیید فقط status را تغییر می‌دهد — **هرگز موجودی را نمی‌نویسد** (در تست assert شده).

## اعتبارسنجی

| بررسی | نتیجه |
|---|---|
| تست‌های embedded backend (PGlite) | **157/157** (شروع فاز: 149؛ +۸ تست: CRM/رفتار، VIP بدون اعتبار، تأمین‌کننده، بازاریابی، بازبینی §J، فاکتور §H، لیبل §I و…) |
| Contract smoke | **93/93** |
| Build backend (tsc) | سبز |
| Build frontend (tsc + vite) | سبز |
| verify-migrations (fresh + upgrade + no-op) | ALL CHECKS PASSED |
| Browser smoke | **NOT RUN** — Chromium در sandbox قابل‌نصب نبود |

## محدودیت‌ها و کار آینده

- **Push به GitHub از C6 به بعد مسدود است** (توکن GitHub منقضی شده — «Authentication failed»). کامیت‌های C6–C10 local هستند؛ پس از اتصال مجدد GitHub در Arena، یک `git push origin arena/01a0f798-kolbevintage` کافی است.
- Barcode/QR روی لیبل: نیازمند تصمیم/زیرساخت جدید.
- ادغام (merge) رکوردهای تکراری مشتری: تشخیص + مقایسه هست؛ merge خودکار عمداً پیاده نشد.
- تحویل/کلیک واقعی SMS نیازمند webhook اپراتور است؛ آمار فعلی فقط رویدادهای واقعی ثبت‌شده را می‌شمارد.
