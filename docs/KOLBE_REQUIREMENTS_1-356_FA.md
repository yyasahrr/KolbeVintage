## نیازمندی‌های تکمیلی Wholesale Admin

### 1. مرتب‌سازی و ترتیب سفارش‌های عمده

در بخش سفارش‌های عمده، ترتیب نمایش فعلی مناسب نیست.

باید قابلیت Sort واقعی اضافه شود.

حداقل مرتب‌سازی بر اساس:

- جدیدترین سفارش
- قدیمی‌ترین سفارش
- وضعیت سفارش
- مبلغ سفارش
- خریدار
- تأمین‌کننده
- وضعیت پرداخت
- وضعیت آماده‌سازی / ارسال

همچنین Order List باید ترتیب مشخص و قابل پیش‌بینی داشته باشد و نباید بر اساس ترتیب تصادفی دریافت داده از API نمایش داده شود.

---

### 2. میز عملیات کلبه

در بخش «میز عملیات کلبه» باید قابلیت مدیریت بهتر سفارش‌ها اضافه شود.

Admin باید بتواند سفارش‌ها را:

- مشاهده کند
- جست‌وجو کند
- فیلتر کند
- مرتب‌سازی کند
- براساس وضعیت دسته‌بندی کند
- وضعیت سفارش یا Fulfillment را تغییر دهد

Sort حداقل شامل:

- جدیدترین
- قدیمی‌ترین
- وضعیت
- مبلغ
- زمان آخرین تغییر
- زمان ارسال
- اولویت عملیاتی

همچنین نمایش سفارش‌ها باید خواناتر باشد و Order Detail کامل از همان بخش قابل دسترسی باشد.

---

### 3. دلیل رد محصول تأمین‌کننده

وقتی Admin محصول یک Supplier را در Marketplace Review رد می‌کند، فقط تغییر Status کافی نیست.

رد محصول باید حتماً همراه با دلیل باشد.

Flow:

```text
Supplier Product
→ Admin Review
→ Reject
→ Select / Write Reason
→ Persist Reason
→ Notify Supplier
```

دلیل رد باید در Backend ذخیره شود و Supplier در پنل خودش آن را ببیند.

مثال دلایل:

- تصاویر محصول مناسب نیست.
- کیفیت تصاویر کافی نیست.
- اطلاعات محصول ناقص است.
- توضیحات محصول نیاز به اصلاح دارد.
- قیمت‌گذاری با ضوابط بازارچه منطبق نیست.
- قیمت عمده مناسب نیست.
- مشخصات سایز ناقص است.
- مشخصات رنگ ناقص است.
- دسته‌بندی محصول اشتباه است.
- SKU / Variantها نیاز به اصلاح دارند.
- شرایط فروش عمده کامل نیست.
- حداقل سفارش مناسب تعریف نشده.
- مدارک یا اطلاعات برند ناقص است.
- سایر موارد.

Admin باید علاوه بر دلایل آماده بتواند توضیح آزاد نیز وارد کند.

مثلاً:

```text
دلیل:
تصاویر محصول مناسب نیست.

توضیح:
تصویر اصلی پس‌زمینه مناسبی ندارد و نمای پشت محصول نیز بارگذاری نشده است.
```

Supplier باید Notification دریافت کند و در Product Detail خودش بتواند:

- وضعیت رد شدن
- دلیل
- توضیح Admin
- تاریخ بررسی

را ببیند.

بعد از اصلاح بتواند محصول را دوباره برای Review ارسال کند.

---

### 4. سیستم Product Type برای قالب سایز

بخش «قالب سایزها / قالب‌های سری» نباید فقط چند نوع محصول از پیش تعریف‌شده داشته باشد.

Admin باید بتواند Product Type جدید تعریف کند.

مثلاً:

```text
کفش
شلوار
پیراهن
کت
مانتو
تی‌شرت
هودی
لباس بچگانه
کلاه
کمربند
```

و همچنین هر نوع محصول دلخواه جدید.

برای هر Product Type:

- نام
- کد
- توضیح
- فعال / غیرفعال
- ترتیب نمایش

قابل مدیریت باشد.

---

### 5. سایزهای قابل مدیریت برای هر Product Type

سایزها نباید Hardcoded باشند.

مثلاً برای کفش نباید سیستم فقط این‌ها را بشناسد:

```text
36
37
38
39
40
41
42
43
44
```

Admin باید بتواند هر زمان سایز جدید اضافه کند.

مثلاً:

```text
45
46
47
```

یا حتی:

```text
44.5
```

در لباس نیز:

```text
XS
S
M
L
XL
2XL
3XL
4XL
```

و در صورت نیاز سایز جدید.

---

### 6. مدیریت سایز Product Type

برای هر نوع محصول باید صفحه مدیریت سایز وجود داشته باشد.

مثلاً:

```text
نوع محصول: کفش
```

سایزهای فعلی:

```text
36
37
38
39
40
41
42
43
44
```

Admin:

```text
+ افزودن سایز
```

و مثلاً وارد کند:

```text
45
```

بعد سایز 45 بلافاصله برای محصولات جدید کفش قابل انتخاب باشد.

همچنین باید بتوان:

- سایز اضافه کرد.
- نام سایز را ویرایش کرد.
- ترتیب سایزها را تغییر داد.
- سایز را غیرفعال کرد.
- سایز جدید بین سایزهای قبلی قرار داد.

---

### 7. ترتیب سایزها

ترتیب سایز باید قابل مدیریت باشد.

مثلاً:

```text
36
37
38
39
40
41
42
43
44
45
```

یا:

```text
XS
S
M
L
XL
2XL
3XL
```

Backend نباید صرفاً Alphabetical Sort انجام دهد.

هر Size باید `position` یا `sort_order` داشته باشد.

---

### 8. اتصال Product Type به Product Editor

وقتی Admin یا Supplier محصول جدید تعریف می‌کند:

ابتدا نوع محصول انتخاب شود.

مثلاً:

```text
نوع محصول:
کفش
```

بعد سیستم سایزهای همان Product Type را از Backend دریافت کند.

مثلاً:

```text
36
37
38
39
40
41
42
43
44
45
```

اگر بعداً Admin سایز 46 اضافه کرد، در Product Editor نیز خودکار قابل انتخاب باشد.

هیچ Size List ثابت داخل Frontend نباشد.

---

### 9. اتصال به Series Templates

Series Templateها نیز باید از همین Product Type + Size System استفاده کنند.

مثلاً:

```text
Product Type:
تی‌شرت

Available Sizes:
S
M
L
XL
2XL
```

Template:

```text
S × 2
M × 3
L × 3
XL × 2
```

اگر بعداً:

```text
2XL
```

به Product Type اضافه شد، بتوان آن را وارد Template نیز کرد.

---

### 10. اصل معماری

Source of Truth این بخش باید Backend/PostgreSQL باشد.

نباید:

- Product Type hardcoded باشد.
- Size hardcoded باشد.
- Series sizes داخل Frontend ثابت باشند.

ساختار باید Dynamic باشد:

```text
Product Type
↓
Available Sizes
↓
Product
↓
Variants
↓
Series Template
↓
Wholesale Order
```

هر تغییر Product Type یا Size باید در تمام قسمت‌های مرتبط سیستم قابل استفاده باشد.




## 11. مدیریت ۳۶۰ درجه تأمین‌کنندگان

بخش «مدیریت تأمین‌کنندگان» نباید صرفاً یک لیست ساده از Supplierها و وضعیت آن‌ها باشد. برای هر تأمین‌کننده باید یک پرونده جامع و یک **Supplier 360° Profile** داشته باشیم تا مدیر بتواند تقریباً تمام وضعیت همکاری با آن تأمین‌کننده را از یک صفحه مشاهده و در صورت داشتن Permission مناسب مدیریت کند.

صفحه هر تأمین‌کننده باید نمای کاملی از هویت و پرونده، وضعیت همکاری، سابقه فعالیت، وضعیت مالی، محصولات، سفارش‌ها، موجودی، تسویه‌ها، مدارک، تخلفات، محدودیت‌ها، تیکت‌ها و Audit Trail ارائه دهد.

اطلاعات پایه باید شامل نام تجاری، اطلاعات حقوقی، شخص مسئول، اطلاعات تماس، شهر و آدرس، تاریخ شروع همکاری، مدت زمان فعالیت، وضعیت فعلی حساب، نوع همکاری، مدارک ثبت‌شده، وضعیت احراز و نسخه‌های قبلی پروفایل باشد.

### وضعیت فعالیت تأمین‌کننده

Admin باید بتواند وضعیت همکاری تأمین‌کننده را به‌صورت واقعی مدیریت کند.

حالت‌هایی مثل:

```text
در انتظار بررسی
فعال
محدودشده
تعلیق‌شده
مسدود
ردشده
```

Backend code می‌تواند انگلیسی بماند، ولی UI کاملاً فارسی باشد.

هر تغییر وضعیت باید همراه با:

```text
دلیل
توضیح مدیر
تاریخ
Admin انجام‌دهنده
مدت محدودیت در صورت موقت بودن
Audit Log
```

ثبت شود.

### محدودسازی Granular

فقط Block کامل کافی نیست.

Admin باید بتواند تأمین‌کننده را به‌صورت جزئی محدود کند.

مثلاً:

```text
عدم اجازه ثبت محصول جدید
عدم اجازه ویرایش محصول
عدم اجازه انتشار محصول
عدم اجازه دریافت سفارش جدید
عدم اجازه برداشت از کیف پول
عدم اجازه درخواست تسویه
عدم اجازه استفاده از بعضی قابلیت‌ها
محدودیت تعداد محصول
محدودیت حجم فروش
محدودیت موقت تا تاریخ مشخص
```

این محدودیت‌ها باید Server-side enforce شوند.

صرفاً غیرفعال کردن Button در Frontend کافی نیست.

---

## 12. وضعیت مالی ۳۶۰ درجه تأمین‌کننده

در Supplier 360 یک بخش مالی کامل وجود داشته باشد.

Admin باید بتواند وضعیت مالی تأمین‌کننده را یکجا ببیند:

```text
فروش کل
فروش این ماه
فروش این هفته
مبلغ قابل تسویه
مبلغ در انتظار تسویه
مبلغ تسویه‌شده
کارمزد کلبه
بدهی
بستانکاری
مبالغ بلوکه‌شده
بازپرداخت‌ها
مرجوعی‌ها
برداشت‌ها
درخواست‌های برداشت
سوابق تسویه
```

همچنین ارتباط مستقیم با:

```text
Wallet
Ledger
Settlement
Invoices
Withdrawals
Orders
```

وجود داشته باشد.

از همین صفحه Admin بتواند در صورت داشتن Permission مناسب وارد جزئیات تراکنش، فاکتور، تسویه و سند حسابداری شود.

هیچ عدد مالی مستقلی در Frontend محاسبه و به‌عنوان Source of Truth نگهداری نشود.

---

## 13. عملکرد و سلامت تأمین‌کننده

Supplier 360 باید Performance View داشته باشد.

برای مثال:

```text
تعداد کل سفارش‌ها
سفارش‌های تکمیل‌شده
سفارش‌های لغوشده
میانگین زمان تأیید سفارش
میانگین زمان آماده‌سازی
تأخیر در ارسال
نرخ مرجوعی
نرخ لغو
تعداد محصول ردشده
نرخ تأیید محصول
تعداد تیکت
نقض SLA
امتیاز مشتریان
```

هدف این است که Admin بدون مراجعه به چند صفحه مختلف بفهمد همکاری با این تأمین‌کننده در چه وضعیتی است.

---

## 14. Timeline کامل تأمین‌کننده

برای هر Supplier یک Timeline واحد داشته باشیم.

مثلاً:

```text
ثبت درخواست همکاری
تأیید حساب
آپلود مدرک
تأیید مدرک
ثبت محصول
رد محصول
اصلاح محصول
تأیید محصول
دریافت سفارش
رد سفارش
ارسال سفارش
ثبت مرجوعی
ثبت تیکت
درخواست برداشت
تسویه
اعمال محدودیت
رفع محدودیت
تغییر کارمزد
تغییر اطلاعات پروفایل
```

این Timeline از داده‌های واقعی Domainها و Audit Log ساخته شود، نه از آرایه محلی.

---

## 15. خریداران عمده نباید دستی تأیید شوند

Flow فعلی که کاربر Plan خریداری می‌کند و بعد Admin باید عضویت او را تأیید کند، برای Planهای پولی مناسب نیست.

Flow جدید:

```text
User
→ انتخاب Plan
→ ایجاد Payment
→ پرداخت موفق و تأییدشده توسط Gateway
→ Membership فعال
→ Role/Entitlements به‌روزرسانی
→ امکانات Plan فوراً فعال
```

یعنی وقتی پرداخت معتبر تأیید شد، Membership باید **خودکار** فعال یا Upgrade شود.

هیچ انتظار دستی برای Admin نباشد.

---

## 16. Upgrade خودکار Plan

مثلاً کاربر عادی Plan طلایی خریداری می‌کند:

```text
Regular User
→ Payment Confirmed
→ Gold Membership
```

یا:

```text
Gold
→ Premium
```

بعد از Payment Confirmation واقعی:

```text
membership plan
membership status
limits
permissions
credit limits
pricing access
wholesale access
expiration
```

همگی Server-side به‌روزرسانی شوند.

اگر Payment ناموفق یا Pending است، Plan فعال نشود.

Frontend success page نباید به‌تنهایی باعث فعال شدن Membership شود.

Source of Truth فقط Payment Provider verification و Backend است.

---

## 17. تمدید، Upgrade و Downgrade عضویت

سیستم Membership باید Lifecycle واقعی داشته باشد.

سناریوهای زیر باید پشتیبانی شوند:

```text
خرید اولین Plan
تمدید Plan
Upgrade
Downgrade
انقضا
لغو
تعلیق
بازگشت وجه
```

قوانین مالی مربوط به Upgrade/Downgrade باید بعداً قابل توسعه باشند و در Backend متمرکز شوند.

---

## 18. VIP / Wholesale Buyer 360°

برای خریداران عمده و مشتریان VIP نیز یک پروفایل ۳۶۰ درجه کامل لازم است.

Admin باید بتواند از یک صفحه تمام وضعیت مشتری را مشاهده کند.

اطلاعات اصلی:

```text
نام و اطلاعات حساب
شماره تماس
ایمیل
شهر و آدرس‌ها
تاریخ ثبت‌نام
مدت فعالیت
Plan فعلی
تاریخ شروع Plan
تاریخ انقضا
Membership history
سطح VIP
```

اطلاعات تجاری:

```text
نام کسب‌وکار
شناسه صنفی
اطلاعات حقوقی
نوع فعالیت
مدارک
```

اطلاعات خرید:

```text
تعداد سفارش
خرید خرده
خرید عمده
مجموع ارزش خرید
میانگین سفارش
آخرین خرید
محصولات موردعلاقه
مرجوعی‌ها
لغوها
```

اطلاعات مالی:

```text
پرداخت‌ها
فاکتورها
بدهی
اعتبار
Credit Limit
Refund
Payment failures
```

ارتباط و پشتیبانی:

```text
تیکت‌ها
پیام‌ها
اعلان‌ها
کمپین‌های دریافت‌شده
SMS history
CRM activity
```

---

## 19. کنترل Admin روی VIP / Wholesale Buyer

از Buyer 360 Admin در صورت داشتن Permission باید بتواند عملیات مدیریتی انجام دهد.

مثلاً:

```text
مشاهده Plan
تغییر Plan به‌صورت مدیریتی
تعلیق Membership
فعال‌سازی مجدد
Block حساب
اعمال محدودیت
تغییر Credit Limit
ثبت Note داخلی
مشاهده Audit
```

هر تغییر حساس باید Audit شود.

اما خرید و Upgrade عادی کاربر باید اتوماتیک و Payment-driven باقی بماند.

---

## 20. CRM Smart Labeling

CRM نباید فقط Segmentation دستی داشته باشد.

یک سیستم **Smart Label / Smart Segment** لازم داریم که مشتریان را براساس رفتار و داده واقعی دسته‌بندی کند.

مثلاً سیستم بتواند Labelهایی مانند این ایجاد یا اعمال کند:

```text
مشتری جدید
مشتری وفادار
VIP
خریدار عمده
پرخرج
ریزش‌یافته
در معرض ریزش
بدون خرید اخیر
خریدار تکراری
علاقه‌مند به دسته خاص
سبد رهاشده
پرداخت ناموفق
عضویت رو به انقضا
Plan ارتقایافته
فعال
کم‌فعال
```

Labelها باید هم:

```text
Manual
```

و هم:

```text
Rule-based / Automatic
```

باشند.

---

## 21. Rule Engine برای CRM

قواعد Label باید قابل تعریف باشند.

مثلاً:

```text
اگر تعداد سفارش >= 10
→ مشتری وفادار
```

یا:

```text
اگر مجموع خرید 90 روز اخیر > X
→ پرخرج
```

یا:

```text
اگر 60 روز خرید نداشته
→ در معرض ریزش
```

یا:

```text
اگر Membership تا 7 روز دیگر منقضی می‌شود
→ عضویت رو به انقضا
```

این Rule Engine باید Server-side باشد.

---

## 22. اتصال CRM به سیستم پیامک

Smart Labels و Segments باید مستقیماً قابل استفاده در سیستم SMS باشند.

مثلاً:

```text
Segment:
عضویت رو به انقضا

→ SMS:
«عضویت شما تا ۷ روز دیگر منقضی می‌شود...»
```

یا:

```text
Segment:
سبد رهاشده

→ پیام یادآوری
```

یا:

```text
Segment:
VIP

→ کمپین اختصاصی
```

Admin بتواند Campaign را براساس Label یا Segment هدف‌گذاری کند.

---

## 23. CRM Automation

ساختار CRM از الان باید Automation-ready طراحی شود.

یعنی Eventهایی مثل:

```text
customer.created
order.created
order.paid
order.delivered
cart.abandoned
membership.activated
membership.expiring
membership.expired
product.viewed
coupon.used
ticket.created
```

بتوانند Trigger ایجاد کنند.

Trigger:

```text
Event
→ CRM Rule
→ Label / Segment
→ Action
```

Action ممکن است:

```text
SMS
Notification
Coupon
CRM note
Webhook
n8n
```

باشد.

---

## 24. n8n Integration برای CRM و Marketing

فعلاً الزام نیست تمام Automationها با n8n ساخته شوند، اما معماری باید آماده اتصال باشد.

Backend باید بتواند Eventهای انتخاب‌شده را به Integration/Webhook موجود ارسال کند.

مثلاً:

```text
Kolbe Event
→ Integration Center
→ n8n Webhook
→ Marketing Workflow
```

هیچ Secret یا Webhook URL داخل Frontend hardcode نشود.

تمام تنظیمات از Integration Center بیاید.

---

# 25. Unified Invoice System

سیستم فاکتور نباید فقط برای یک نوع سفارش باشد.

یک **Invoice Domain واحد** لازم داریم که تمام بخش‌های سیستم از آن استفاده کنند:

```text
Retail Customer
Wholesale Buyer
VIP Customer
Supplier
Kolbe
Settlement
Refund
```

یعنی هر جا سند مالی قابل ارائه وجود دارد، از همین Invoice Engine استفاده شود.

---

## 26. انواع فاکتور

Invoice System باید بتواند حداقل این نوع سندها را تولید کند:

```text
فاکتور خرید خرده
فاکتور خرید عمده
فاکتور مشتری VIP
صورت‌حساب تأمین‌کننده
فاکتور/صورتحساب تسویه
سند برگشت وجه
سند اصلاحی
```

Domain واحد باشد ولی Template و داده‌ها براساس نوع سند تغییر کنند.

---

## 27. Invoice Template Builder

Admin باید بتواند قالب PDF فاکتور را خودش تعریف یا انتخاب کند.

قالب نباید داخل کد Frontend ثابت باشد.

Template باید Server-side ذخیره شود.

Admin بتواند مشخص کند:

```text
لوگو
عنوان فاکتور
اطلاعات فروشنده
اطلاعات خریدار
اطلاعات تأمین‌کننده
جدول اقلام
مالیات
تخفیف
هزینه ارسال
مبلغ نهایی
اطلاعات پرداخت
امضا
مهر
Footer
Terms
```

و ترتیب/نمایش بخش‌ها قابل تنظیم باشد.

---

## 28. Variable System برای قالب PDF

داخل Template باید Variable داشته باشیم.

مثلاً:

```text
{{invoice.number}}
{{invoice.date}}
{{invoice.dueDate}}

{{seller.name}}
{{seller.address}}
{{seller.taxId}}

{{customer.name}}
{{customer.phone}}
{{customer.address}}

{{supplier.name}}

{{order.reference}}

{{payment.method}}

{{subtotal}}
{{discount}}
{{tax}}
{{shipping}}
{{total}}
{{paid}}
{{remaining}}
```

همچنین Repeatable Data برای اقلام:

```text
{{items}}
```

با فیلدهای:

```text
item.name
item.sku
item.variant
item.quantity
item.unitPrice
item.discount
item.total
```

Variableهای معتبر باید Schema مشخص داشته باشند و arbitrary code اجرا نکنند.

---

## 29. PDF Rendering

فاکتور نهایی باید Server-side به PDF تبدیل شود.

خروجی:

```text
RTL
Persian
Jalali date
Persian-compatible font
print-ready
A4
```

و فایل نهایی در File/Storage Domain ذخیره شود.

Invoice باید به فایل PDF تولیدشده Reference داشته باشد.

---

## 30. Snapshot Principle

یک نکته بسیار مهم:

اگر اطلاعات مشتری، محصول، قیمت یا Template بعداً تغییر کرد، فاکتور قدیمی نباید تغییر کند.

هنگام صدور Invoice باید Snapshot داده‌های لازم ذخیره شود.

مثلاً:

```text
نام مشتری در زمان خرید
آدرس زمان خرید
قیمت زمان خرید
مالیات زمان خرید
نام محصول زمان خرید
اطلاعات فروشنده زمان صدور
Template version
```

بنابراین Re-render همان Invoice باید همان سند مالی تاریخی را تولید کند.

---

## 31. Invoice Versioning

Templateها Version داشته باشند.

مثلاً:

```text
Official Invoice v1
Official Invoice v2
Wholesale Invoice v3
```

فاکتور صادرشده مشخص کند با کدام Template Version تولید شده.

تغییر Template نباید اسناد قبلی را تغییر دهد.

---

## 32. Invoice Lifecycle

Invoice statusهای مناسب:

```text
Draft
Issued
Partially Paid
Paid
Cancelled
Refunded
Void
```

Labelهای UI فارسی باشند.

Transitionها Backend-controlled باشند.

---

## 33. Invoice Access

دسترسی به فاکتور براساس مالکیت و Permission باشد.

مشتری فقط فاکتور خودش.

Supplier فقط صورت‌حساب مربوط به خودش.

Admin براساس Permission.

PDF URL نباید Public unrestricted باشد.

از File/Storage permission model موجود استفاده شود.

---

## 34. Invoice Integration

Invoice System مستقیماً با Domainهای موجود یکپارچه باشد:

```text
Orders
Payments
Ledger
Wallet
Settlement
Returns
Refund
Membership
Supplier
```

مثلاً:

```text
Retail Order Paid
→ Invoice Issued
```

یا:

```text
Wholesale Order Paid
→ Wholesale Invoice
```

یا:

```text
Supplier Settlement Completed
→ Settlement Statement
```

همه از Engine واحد.




بله؛ این بخش را هم به همان سند اضافه می‌کنیم. برای قسمت SEO و Import الگوهای Google Search Central، Shopify، WooCommerce، Ahrefs و Semrush را بررسی کردم. نکته مهم این است که SEO را نباید فقط به چند input مثل Title و Description تقلیل بدهیم؛ باید یک **SEO/Discovery subsystem واقعی** داشته باشیم. گوگل برای فروشگاه‌های اینترنتی صراحتاً روی ساختار سایت، URLها، canonical، sitemap، داده‌های ساختاریافته محصول و واریانت، اطلاعات ارسال/مرجوعی و Core Web Vitals تأکید دارد. :chatgpt-content-reference{index="0"}

## 35. مرز قطعی بین محصولات کلبه و محصولات تأمین‌کننده

یک قانون معماری قطعی داریم:

```text
Supplier Products
→ فقط Wholesale Marketplace

Kolbe-owned Products
→ Retail
→ Wholesale
→ یا هر دو
```

هیچ محصول متعلق به Supplier نباید در فروشگاه خرده‌فروشی کلبه وینتیج ظاهر شود.

این محدودیت فقط UI نباشد.

Backend باید enforce کند.

مثلاً:

```text
owner_type = kolbe | supplier
sales_channels = retail | wholesale | both
```

Rule:

```text
owner_type = supplier
→ sales_channels MUST BE wholesale
```

و Supplier حتی از طریق API هم نباید بتواند مقدار `retail` یا `both` ثبت کند.

### Query isolation

Retail catalog:

```text
GET /products?channel=retail
```

فقط:

```text
owner_type = kolbe
AND retail_enabled = true
```

Wholesale catalog:

```text
owner_type = supplier
OR
owner_type = kolbe AND wholesale_enabled = true
```

بنابراین هیچ اشتباه Frontend یا Filter ناقص نباید بتواند محصول Supplier را وارد Retail Store کند.

---

## 36. تعریف Product Channel برای محصولات خود کلبه

در Product Studio ادمین، محصولات متعلق به Kolbe بتوانند Channel داشته باشند:

```text
فقط خرده
فقط عمده
خرده + عمده
```

اما Product Supplier همیشه:

```text
فقط عمده
```

باشد.

برای محصول Kolbe ممکن است قیمت‌ها مستقل باشند:

```text
Retail Cash Price
Retail Installment Price

Wholesale Price
Wholesale MOQ
Wholesale Series
```

نباید مجبور باشیم یک Price model را برای هر دو Channel استفاده کنیم.

---

## 37. Import / Migration Center کامل

یک بخش مستقل در Admin اضافه شود:

```text
مرکز ورود و مهاجرت داده
```

هدف:

- انتقال سایت قبلی
- ورود محصولات زیاد
- ورود کاربران
- ورود تصاویر
- ورود موجودی
- ورود دسته‌بندی
- ورود Variant
- ورود اطلاعات SEO
- ورود داده‌های تجاری دیگر

الگوی سیستم‌های بزرگ مثل Shopify و WooCommerce این است که Bulk Import بتواند Product، Variant، تصویر و اطلاعات مرتبط را از فایل‌های ساختاریافته وارد کند؛ WooCommerce همچنین Mapping ستون‌ها و Update محصول موجود با ID/SKU را پشتیبانی می‌کند. :chatgpt-content-reference{index="1"}

---

## 38. فرمت‌های Import

حداقل:

```text
.csv
.xlsx
.xls (legacy import)
```

برای Media:

```text
.zip
multiple image upload
remote image URLs
```

در CSV/XLSX بتوانیم Image URL هم داشته باشیم.

مثلاً:

```text
product_code
name
color
size
stock
image_1
image_2
image_3
```

Importer تصاویر را Download کند و داخل File/Storage Domain خودمان ذخیره کند.

Shopify و WooCommerce هر دو از URLهای تصویر برای Import محصول استفاده می‌کنند؛ پس این قابلیت برای Migration از سایت قبلی بسیار کاربردی است. :chatgpt-content-reference{index="2"}

---

## 39. Import Wizard

Import مستقیم بدون بررسی خطرناک است.

Flow:

```text
Upload File
↓
Detect Format
↓
Preview
↓
Column Mapping
↓
Validation
↓
Dry Run
↓
Import
↓
Result Report
```

مثلاً ستون سایت قدیمی:

```text
product_title
```

Admin بتواند Map کند به:

```text
Product Name
```

یا:

```text
stock_count
→ Variant Inventory
```

---

## 40. Smart Column Mapping

سیستم تلاش کند ستون‌های متداول را خودکار تشخیص دهد.

مثلاً:

```text
title
product_name
name
نام محصول
```

همگی پیشنهاد شوند برای:

```text
Product.name
```

ولی قبل از Import نهایی Admin بتواند Mapping را تأیید کند.

---

## 41. Import Dry Run

قبل از Import واقعی:

```text
۱۵۰۰ سطر خوانده شد

۱۴۲۰ معتبر
۴۵ هشدار
۳۵ خطا
```

خطاها:

```text
SKU تکراری
سایز نامعتبر
Product Type پیدا نشد
تصویر قابل دریافت نیست
ایمیل نامعتبر
موجودی منفی
Parent Product پیدا نشد
```

هیچ داده‌ای در Dry Run ذخیره نشود.

---

## 42. Import Idempotency

اجرای مجدد یک فایل نباید بی‌دلیل Duplicate ایجاد کند.

Matching strategy قابل انتخاب:

```text
SKU
Legacy ID
Email
Phone
Product Code
```

Mode:

```text
Create only
Update existing
Create + Update
```

WooCommerce نیز برای Update از شناسه پایدار یا SKU استفاده می‌کند؛ همین الگو برای Migration ما مناسب است. :chatgpt-content-reference{index="3"}

---

## 43. Import History

برای هر Import:

```text
Import ID
نوع Import
فایل
تاریخ
Admin
تعداد رکورد
موفق
ناموفق
هشدار
مدت زمان
```

و:

```text
دانلود خطاها
دانلود رکوردهای ردشده
```

وجود داشته باشد.

---

## 44. Background Import Jobs

Import بزرگ نباید HTTP Request را چند دقیقه باز نگه دارد.

Flow:

```text
Upload
→ Queue Job
→ Background Worker
→ Progress
```

مثلاً:

```text
Importing products
734 / 5000
14%
```

قابل Resume/Retry باشد.

---

## 45. Import کاربران سایت قبلی

User Import:

```text
نام
نام خانوادگی
موبایل
ایمیل
تاریخ ثبت‌نام
آدرس
شهر
سطح مشتری
Legacy ID
```

قابل Import باشد.

اما Password plaintext وارد نشود.

اگر Password Hash سایت قبلی با سیستم جدید سازگار نیست:

```text
User migrated
→ password reset / OTP login required
```

نه اینکه Password ناامن منتقل شود.

---

# 46. Discount × Installment Policy

تخفیف و فروش اقساطی باید دو مفهوم مستقل باشند.

هر محصول Kolbe باید بتواند مشخص کند:

```text
فروش اقساطی فعال است؟
```

و همچنین:

```text
اگر محصول تخفیف داشت،
خرید چهارقسطی مجاز است؟
```

مثلاً:

```text
installment_enabled = true
allow_installment_when_discounted = false
```

سناریو:

```text
قیمت اصلی: 10,000,000

تخفیف:
8,000,000
```

Admin تعیین کند:

```text
خرید نقدی:
8,000,000

چهارقسط:
غیرفعال
```

یا:

```text
چهارقسط روی قیمت تخفیف‌خورده:
فعال
```

---

## 47. Installment Rule Engine

بهتر است به جای یک Boolean ساده، Policy داشته باشیم:

```text
installment_policy:

disabled
enabled
disabled_when_discounted
enabled_when_discounted
```

و در آینده بتوانیم اضافه کنیم:

```text
campaign_override
category_override
brand_override
```

---

## 48. Pricing Server Authority

Frontend نباید خودش تصمیم بگیرد:

```text
Discount + Installment
```

مجاز هست یا نه.

Backend Pricing Engine باید هنگام Checkout محاسبه کند:

```text
Base Price
Discount
Final Price
Installment Eligibility
Installment Price
Installment Count
Installment Amount
```

و Snapshot سفارش ذخیره شود.

---

# 49. موجودی دقیق در کنار Variant

کاملاً درست است که موجودی نباید یک عدد برای کل Product باشد.

مثلاً:

```text
هودی مشکی / 2XL = 30
هودی مشکی / XL  = 8
هودی سفید / 2XL = 4
```

پس مدل:

```text
Product
↓
Variants
↓
Warehouse Balances
```

باشد.

---

## 50. Variant Inventory Table در Product Studio

بخش Variant محصول مثلاً:

| رنگ | سایز | SKU | موجودی فیزیکی | رزرو | قابل فروش |
|---|---|---|---:|---:|---:|
| مشکی | XL | ... | ۸ | ۱ | ۷ |
| مشکی | 2XL | ... | ۳۰ | ۲ | ۲۸ |
| سفید | 2XL | ... | ۴ | ۰ | ۴ |

همه این داده‌ها از WMS خوانده شوند.

---

## 51. Multi-Warehouse Variant Inventory

اگر چند انبار داشتیم:

```text
Variant:
Black / 2XL
```

ممکن است:

```text
Tehran = 20
Isfahan = 10
```

و مجموع:

```text
On Hand = 30
```

ولی Source of Truth همان Balanceهای هر Warehouse است.

---

## 52. Bulk Variant Inventory Editing

برای Admin ابزار Bulk داشته باشیم:

```text
Import Inventory CSV/XLSX
Bulk Adjustment
Bulk Receipt
```

مثلاً فایل:

```text
SKU,Warehouse,Quantity
KV-001-BLK-2XL,TEH-01,30
KV-001-WHT-2XL,TEH-01,4
```

---

# 53. SEO Center حرفه‌ای

یک بخش مستقل:

```text
SEO Center
```

لازم است.

نه فقط یک Field کوچک داخل Product Editor.

Google برای Ecommerce روی قابلیت Crawl، ساختار لینک‌ها، URL، canonical، sitemap، structured data و product data تأکید می‌کند. :chatgpt-content-reference{index="4"}

---

## 54. SEO Settings برای هر صفحه

برای:

```text
Product
Category
Brand
Blog
CMS Page
Landing Page
```

حداقل:

```text
SEO Title
Meta Description
Slug
Canonical URL
Index / Noindex
Follow / Nofollow
```

وجود داشته باشد.

همراه با:

```text
Google Preview
```

---

## 55. SEO Template System

برای هزار محصول قرار نیست دستی Meta بنویسیم.

Template:

```text
{{product.name}} | خرید از کلبه وینتیج
```

Description:

```text
خرید {{product.name}} با قیمت {{product.price}} و ارسال به سراسر ایران
```

Category:

```text
خرید {{category.name}} | کلبه وینتیج
```

و Product بتواند Override اختصاصی داشته باشد.

---

## 56. Structured Data Engine

سیستم Structured Data واقعی داشته باشیم.

Google از داده ساختاریافته برای درک بهتر صفحه و قابلیت‌های Rich Result استفاده می‌کند. برای Ecommerce، Product/Merchant Listing می‌تواند اطلاعات قیمت، موجودی، حمل‌ونقل و مرجوعی را منتقل کند. :chatgpt-content-reference{index="5"}

حداقل:

```text
Product
ProductGroup
Offer
BreadcrumbList
Organization / OnlineStore
Article
MerchantReturnPolicy
ShippingService / ShippingDetails
```

در صورت داشتن داده واقعی:

```text
AggregateRating
Review
```

و هرگز Rating جعلی تولید نشود.

---

## 57. Product Variant SEO

این بخش برای پروژه ما بسیار مهم است چون Productها Size/Color Variant دارند.

Google برای Variantهای محصول از `ProductGroup` و `Product` پشتیبانی می‌کند و توصیه می‌کند Variantها شناسه و URL قابل شناسایی داشته باشند. :chatgpt-content-reference{index="6"}

مثلاً:

```text
/product/hoodie
```

و:

```text
/product/hoodie?color=black&size=2xl
```

با انتخاب این URL:

- رنگ درست
- سایز درست
- تصویر درست
- Price درست
- Availability درست

نمایش داده شود.

---

## 58. ProductGroup Schema

Structured data:

```text
ProductGroup
↓
hasVariant
↓
Product
↓
Offer
```

مثلاً:

```text
variesBy:
color
size
```

Google این مدل را مشخصاً برای محصولاتی مثل لباس و کفش معرفی کرده است. :chatgpt-content-reference{index="7"}

---

## 59. Initial HTML SEO

Product Structured Data، Price و Availability تا حد ممکن در HTML اولیه قابل مشاهده باشند، نه اینکه صرفاً بعد از JavaScript Fetch ساخته شوند.

Google برای Merchant/Product markup گفته که قرار دادن Product structured data در HTML اولیه برای Shopping results بهترین حالت است؛ داده‌های صرفاً JavaScript-generated ممکن است برای داده‌های سریع‌التغییر مثل قیمت و موجودی کمتر قابل اتکا باشند. :chatgpt-content-reference{index="8"}

این یعنی اگر معماری Frontend فعلی SPA است، باید برای صفحات SEO-critical سراغ:

```text
SSR
SSG
Prerendering
```

یا معماری معادل قابل Crawl برویم.

---

## 60. Sitemap Engine

Sitemap اتوماتیک:

```text
/sitemap.xml
```

و ترجیحاً Sitemap Index:

```text
sitemap-products.xml
sitemap-categories.xml
sitemap-pages.xml
sitemap-blog.xml
sitemap-images.xml
```

فقط URLهای Canonical + Indexable وارد Sitemap شوند.

Google نیز Sitemap را یکی از راه‌های اصلی معرفی URLهای مهم و Canonical ترجیحی می‌داند. :chatgpt-content-reference{index="9"}

---

## 61. robots.txt Manager

Admin بتواند:

```text
robots.txt
```

را مدیریت کند.

اما UX باید هشدار دهد:

`robots.txt` ابزار جلوگیری از Index شدن صفحه نیست؛ برای خارج‌کردن صفحه از نتایج باید از `noindex` یا کنترل دسترسی استفاده شود. :chatgpt-content-reference{index="10"}

---

## 62. Canonical Manager

Canonical خودکار + Override.

مثلاً Filterها:

```text
/category/shirts?color=black
/category/shirts?size=xl
```

نباید بدون Strategy باعث هزاران Duplicate URL شوند.

Canonicalization برای URLهای مشابه و Filter شده یکی از مسائل مهم فروشگاه‌هاست. Google و ابزارهای Audit مثل Ahrefs روی Duplicate/Canonical تأکید دارند. :chatgpt-content-reference{index="11"}

---

## 63. Faceted Navigation SEO

Filterهای فروشگاه:

```text
رنگ
سایز
برند
قیمت
موجودی
تخفیف
```

می‌توانند تعداد بسیار زیادی URL بسازند.

پس باید Policy داشته باشیم:

```text
indexable filter
non-indexable filter
canonical target
crawl allowed
crawl blocked
```

نه اینکه هر ترکیب Filter یک صفحه قابل Index بسازد.

---

## 64. Redirect Manager

Admin SEO Center:

```text
301
302
410
```

تعریف کند.

مثلاً:

```text
/old-product
→
/new-product
```

همچنین هنگام تغییر Slug:

```text
old slug
→ 301
→ new slug
```

به‌صورت خودکار.

---

## 65. Broken Link / 404 Monitor

ثبت:

```text
404 URL
Referrer
Count
Last Seen
```

و امکان:

```text
Create Redirect
```

از همان صفحه.

---

## 66. Internal Linking Audit

سیستم صفحاتی را پیدا کند که:

```text
Orphan Page
```

هستند؛ یعنی هیچ Internal Link به آن‌ها وجود ندارد.

Ahrefs این را یکی از Auditهای مستقل SEO می‌داند و روی اهمیت Internal Links برای کشف صفحات توسط موتور جستجو تأکید می‌کند. :chatgpt-content-reference{index="12"}

---

## 67. Site Architecture Audit

ساختار:

```text
Home
→ Category
→ Subcategory
→ Product
```

باید قابل Crawl باشد.

Google نیز برای Ecommerce توصیه می‌کند صفحات محصول از طریق Navigation و Linkهای واقعی قابل رسیدن باشند. :chatgpt-content-reference{index="13"}

---

## 68. Breadcrumb

Breadcrumb واقعی:

```text
خانه
→ پوشاک
→ هودی
→ هودی مشکی
```

هم UI و هم:

```text
BreadcrumbList Schema
```

باشد. :chatgpt-content-reference{index="14"}

---

## 69. Image SEO

برای تمام Mediaها:

```text
Alt Text
Title
Caption
File Name
Width
Height
Aspect Ratio
```

و Admin باید Alt را بتواند ویرایش کند.

برای Product Variant نیز Image مرتبط با Color قابل تعریف باشد.

---

## 70. Image Optimization Pipeline

هنگام Upload:

```text
Original
↓
Validation
↓
Resize Variants
↓
Compression
↓
WebP / AVIF
↓
Thumbnail
```

و:

```text
srcset
sizes
lazy loading
```

در Frontend.

Hero اصلی نباید به‌صورت اشتباه Lazy Load شود چون می‌تواند LCP را خراب کند.

---

## 71. Core Web Vitals Dashboard

Google معیارهای اصلی فعلی را:

```text
LCP
INP
CLS
```

می‌داند و حدود توصیه‌شده برای تجربه خوب عبارت‌اند از:

```text
LCP <= 2.5s
INP < 200ms
CLS < 0.1
``` :chatgpt-content-reference{index="15"}


پس SEO Center باید Performance section داشته باشد.

---

## 72. Technical SEO Auditor داخلی

یک Mini Site Audit داخلی شبیه بخشی از قابلیت‌های:

```text
Semrush
Ahrefs
Screaming Frog
```

بسازیم.

Semrush Site Audit صدها Check را در حوزه‌هایی مثل Crawlability، HTTPS، Mobile، Core Web Vitals، Markup، International SEO و Internal Links انجام می‌دهد. Ahrefs نیز خطاهایی مثل Missing Title، Canonical، Broken Links، Orphan Pages و Duplicate Content را بررسی می‌کند. :chatgpt-content-reference{index="16"}

برای Kolbe حداقل Audit کنیم:

```text
Missing title
Duplicate title
Missing description
Duplicate description
Missing H1
Multiple H1
Missing canonical
Canonical conflict
Noindex in sitemap
Broken internal link
404
5xx
Redirect chain
Redirect loop
Orphan page
Missing image alt
Broken image
Invalid structured data
Missing Product schema
Missing Breadcrumb schema
Wrong canonical
HTTP link inside HTTPS
Slow page
Large image
```

---

## 73. SEO Issue Severity

هر Issue:

```text
Error
Warning
Notice
```

داشته باشد.

و Admin Dashboard:

```text
SEO Health
```

نمایش دهد.

اما این Score فقط Operational Metric داخلی باشد، نه ادعای مستقیم Ranking گوگل.

---

## 74. Scheduled SEO Crawl

Site Audit:

```text
Manual
Daily
Weekly
```

قابل اجرا باشد.

هر Crawl:

```text
new issues
fixed issues
remaining issues
```

را نشان دهد.

---

## 75. Search Console Integration

در Integration Center بعداً:

```text
Google Search Console
```

اتصال داشته باشیم.

برای:

```text
Clicks
Impressions
CTR
Average Position
Indexed Pages
Sitemap Status
```

همچنین Google اشاره می‌کند که داده Performance و Sitemap می‌تواند از Search Console/API بررسی شود. :chatgpt-content-reference{index="17"}

---

## 76. Merchant / Shopping Readiness

ساختار Product Data از همین الان قابلیت اتصال به:

```text
Google Merchant Center
```

را داشته باشد.

Google برای Ecommerce استفاده از Product data و Merchant Center را بخشی از مسیر حضور محصولات در Search، Images و Shopping می‌داند. :chatgpt-content-reference{index="18"}

Fields:

```text
GTIN
MPN
Brand
Condition
Availability
Price
Sale Price
Shipping
Return Policy
```

در صورت وجود واقعی.

---

## 77. Organization / Store Schema

Home Page:

```text
OnlineStore / Organization
```

شامل اطلاعات واقعی:

```text
name
logo
url
contact
address
return policy
```

Google برای سایت Ecommerce استفاده از subtype مناسب مثل `OnlineStore` را توصیه می‌کند. :chatgpt-content-reference{index="19"}

---

## 78. Social Metadata

برای هر صفحه:

```text
Open Graph
Twitter Card
Social Image
Social Title
Social Description
```

قابل تعریف باشد.

با Fallback از SEO metadata.

---

## 79. SEO Revision History

هر تغییر:

```text
Slug
Title
Description
Canonical
Robots
Schema
```

Version History داشته باشد.

Admin بتواند ببیند:

```text
چه کسی
چه چیزی
چه زمانی
```

تغییر داده.

---

## 80. SEO Permissions

Permissionهای مجزا:

```text
seo:read
seo:manage
seo:redirects
seo:technical
seo:integrations
```

هر Content Editor نباید الزاماً دسترسی به Robots یا Redirectهای کل سایت داشته باشد.

---

## 81. SEO Import / Export

SEO metadata نیز Bulk Import/Export داشته باشد.

مثلاً:

```text
SKU
SEO Title
SEO Description
Slug
Canonical
Index
```

از CSV/XLSX.

Shopify نیز SEO Title و SEO Description را در Product CSV در نظر گرفته است، بنابراین این قابلیت برای Catalogهای بزرگ کاملاً منطقی است. :chatgpt-content-reference{index="20"}

---

## 82. اصل نهایی Product / Inventory / Pricing

ساختار نهایی محصول باید به این صورت دیده شود:

```text
Product
│
├── Owner
│   ├── Kolbe
│   └── Supplier
│
├── Sales Channels
│   ├── Retail
│   └── Wholesale
│
├── Product Type
│
├── Variants
│   ├── Color
│   ├── Size
│   ├── SKU
│   └── WMS Inventory
│
├── Pricing
│   ├── Retail Cash
│   ├── Retail Installment
│   ├── Wholesale
│   └── Discounts
│
├── Installment Policy
│
├── Media
│
├── SEO
│
└── Structured Data
```

و قانون مالکیت همچنان قطعی باشد:

```text
Supplier
→ Wholesale only

Kolbe
→ Retail / Wholesale / Both
```

این بخش‌هایی که الان گفتی از نظر معماری خیلی مهم‌اند، چون **Import، Channel separation، Variant Inventory، Pricing Rules و SEO** همگی مستقیماً روی مدل Product اثر می‌گذارند. بنابراین بهتر است قبل از شروع Featureهای جدید، این Requirements هم داخل همان سند نهایی Wholesale/Commerce قرار بگیرند.




## 83. محاسبه هزینه حمل بر اساس وزن

هزینه حمل‌ونقل نباید فقط یک مبلغ ثابت باشد.

Admin باید بتواند برای هر روش ارسال، قیمت‌گذاری مبتنی بر وزن تعریف کند.

مثلاً:

```text
پست پیشتاز

0 تا 500 گرم    → 80,000 تومان
500 تا 1000 گرم → 110,000 تومان
1 تا 2 کیلو     → 160,000 تومان
2 تا 5 کیلو     → 250,000 تومان
```

قوانین باید کاملاً Server-side باشند.

هر Product/Variant باید بتواند وزن واقعی داشته باشد:

```text
weight_grams
```

مثلاً:

```text
هودی / مشکی / 2XL
وزن: 720 گرم
```

در سفارش چندکالایی:

```text
Total Shipping Weight
=
Sum(variant_weight × quantity)
```

و Shipping Engine از روی وزن کل سفارش هزینه را محاسبه کند.

---

## 84. Shipping Pricing Rules

سیستم حمل باید در آینده از Ruleهای مختلف پشتیبانی کند:

```text
Flat Rate
Weight Based
Free Shipping
Order Value Based
Destination Based
Carrier API Based
```

و در صورت نیاز ترکیبی:

```text
وزن + شهر مقصد
وزن + مبلغ سفارش
وزن + نوع سرویس
```

Admin باید Ruleها را از پنل مدیریت کند و هیچ مبلغ حمل مهمی در Frontend hardcode نباشد.

---

# 85. مرکز Automation

یک بخش مستقل داخل Admin Console ایجاد شود:

```text
اتوماسیون‌ها
```

هدف این صفحه مدیریت اتصال سیستم کلبه با:

```text
n8n
و سایر Automation Platformهای آینده
```

باشد.

این صفحه حداقل شامل:

```text
وضعیت اتصال
Webhookها
Eventها
Workflowهای متصل
آخرین اجرا
اجرای موفق
اجرای ناموفق
Retry
Error Logs
```

باشد.

---

# 86. کل پروژه باید Automation-Friendly باشد

معماری پروژه از این مرحله به بعد باید طوری باشد که هر Domain مهم بتواند بدون تغییر بنیادی به n8n متصل شود.

مدل کلی:

```text
Domain Event
↓
Automation Event
↓
Webhook / Queue
↓
n8n
↓
Action
```

مثلاً:

```text
order.created
order.paid
order.shipped
product.created
product.rejected
customer.created
customer.updated
membership.activated
ticket.created
invoice.issued
shipment.tracking.updated
review.created
cart.abandoned
```

---

# 87. Automation Event Contract

Eventها Schema مشخص داشته باشند.

مثلاً:

```json
{
  "event": "order.paid",
  "eventId": "...",
  "occurredAt": "...",
  "entityId": "...",
  "data": {}
}
```

هر Event باید:

```text
eventId
eventType
timestamp
entity
payload
schemaVersion
```

داشته باشد.

تا n8n بتواند به شکل پایدار روی آن Workflow بسازد.

---

# 88. امنیت اتصال n8n

Webhookهای Automation باید:

```text
HMAC Signature
Secret
Timestamp
Replay Protection
Idempotency
Retry
Timeout
```

داشته باشند.

Secret هیچ‌وقت داخل Frontend قرار نگیرد.

تنظیمات اتصال فقط از Integration Center مدیریت شود.

---

# 89. Outbox Pattern برای Eventها

برای Eventهای مهم نباید:

```text
DB update succeeded
ولی webhook failed
```

باعث از دست رفتن Event شود.

برای Domain Eventهای مهم از Outbox/Queue استفاده شود:

```text
Database Transaction
↓
Event Outbox
↓
Worker
↓
n8n/Webhook
```

اگر n8n موقتاً Down بود، Event بعداً Retry شود.

---

# 90. Tracking Automation Center

یک صفحه مستقل ایجاد شود:

```text
پیگیری مرسولات
```

این صفحه باید مرکز تمام Tracking Codeها و Shipmentهای سیستم باشد.

نمایش:

```text
شماره سفارش
شماره مرسوله
کد رهگیری
مشتری
شماره تماس
حامل
مبدأ
مقصد
تاریخ ارسال
آخرین وضعیت
آخرین مکان
آخرین به‌روزرسانی
```

---

# 91. استخراج خودکار کدهای رهگیری با n8n

n8n بتواند Tracking Code را از منابع مختلف دریافت کند.

مثلاً:

```text
Carrier API
PDF
Excel
CSV
Email
Uploaded File
Authorized Website Integration
Webhook
```

مثال:

```text
PDF شرکت پستی
↓
n8n
↓
Extract Tracking Code
↓
Match Order
↓
POST Tracking Update
↓
Kolbe
```

یا:

```text
Carrier Website/API
↓
n8n
↓
Tracking Status
↓
Kolbe
```

---

# 92. Tracking Import Review

اگر Tracking Code به‌صورت خودکار استخراج شد ولی Confidence پایین بود، سیستم نباید کورکورانه داده را ثبت کند.

حالت‌ها:

```text
تأییدشده
نیازمند بررسی
ناموفق
```

Admin بتواند موارد مشکوک را Review کند.

---

# 93. Shipment Tracking History

برای هر Shipment یک Timeline کامل وجود داشته باشد:

```text
تحویل به شرکت حمل
ثبت کد رهگیری
ورود به مرکز مبادلات
خروج از مرکز
ورود به شهر مقصد
تحویل به مأمور
تحویل به مشتری
```

هر Event:

```text
status
location
occurredAt
source
rawReference
```

داشته باشد.

---

# 94. Tracking → Customer Notification

با تغییر وضعیت مرسوله:

```text
shipment.updated
```

سیستم بتواند:

```text
SMS
Notification
Email
```

ارسال کند.

مثلاً:

```text
سفارش شما تحویل شرکت پست شد.
کد رهگیری: ...
```

این Workflow می‌تواند داخلی یا از طریق n8n اجرا شود.

---

# 95. CRM 360 کامل‌تر

CRM باید مرکز واقعی شناخت مشتری باشد، نه فقط یک جدول Contact.

Customer 360 باید شامل:

```text
نام
نام خانوادگی
شماره موبایل
ایمیل
تاریخ تولد
جنسیت در صورت ثبت اختیاری
شهر
آدرس‌ها
تاریخ عضویت
آخرین ورود
آخرین خرید
Plan
VIP Status
```

باشد.

---

# 96. رفتار خرید مشتری

برای هر مشتری:

```text
تعداد سفارش
ارزش کل خرید
میانگین سفارش
بیشترین سفارش
آخرین خرید
فاصله میان خریدها
محصولات خریداری‌شده
دسته‌های محبوب
رنگ‌های محبوب
سایزهای پرتکرار
محصولات مرجوع‌شده
سفارش‌های لغوشده
پرداخت‌های ناموفق
کوپن‌های استفاده‌شده
```

قابل مشاهده و تحلیل باشد.

---

# 97. CRM Behavioral Labels

Labelگذاری رفتاری بخش کلیدی CRM است.

Labelها باید با داده واقعی به‌صورت خودکار اعمال شوند.

مثلاً:

```text
مشتری جدید
مشتری وفادار
خریدار تکراری
VIP
خریدار عمده
پرخرج
کم‌فعال
در معرض ریزش
ریزش‌یافته
علاقه‌مند به کفش
علاقه‌مند به لباس زمستانی
خریدار تخفیف‌محور
خریدار اقساطی
پرداخت ناموفق
مرجوعی بالا
```

یک کاربر می‌تواند همزمان چند Label داشته باشد.

---

# 98. Dynamic CRM Segments

Admin باید بتواند Segment بسازد.

مثلاً:

```text
شهر = تهران
AND
تعداد خرید > 5
AND
آخرین خرید < 30 روز
```

یا:

```text
VIP = true
AND
Category Interest = Jacket
```

Segment باید Dynamic باشد و با تغییر رفتار مشتری خودکار Update شود.

---

# 99. Customer Activity Timeline

برای هر مشتری Timeline کامل داشته باشیم:

```text
ثبت‌نام
Login
ویرایش پروفایل
افزودن آدرس
مشاهده محصول
افزودن به علاقه‌مندی
افزودن به سبد
ثبت سفارش
پرداخت
تحویل
مرجوعی
Review
Comment
Ticket
Membership
Coupon
SMS
Notification
```

---

# 100. Internal CRM Notes / Comments

در CRM باید قابلیت ثبت Comment/Note داخلی وجود داشته باشد.

مثلاً کارشناس CRM بنویسد:

```text
مشتری درباره سفارش قبلی ناراضی بود.
برای خرید بعدی با ایشان تماس گرفته شود.
```

هر Note:

```text
author
createdAt
editedAt
visibility
```

داشته باشد.

این Note فقط داخلی باشد و مشتری آن را نبیند.

---

# 101. Customer Profile Editing توسط Admin

Admin با Permission مناسب بتواند اطلاعات اشتباه مشتری را اصلاح کند.

مثلاً:

```text
نام
نام خانوادگی
تاریخ تولد
آدرس
شهر
```

اما تغییر فیلدهای حساس مثل:

```text
موبایل
ایمیل
```

باید فرآیند Verification داشته باشد.

تمام تغییرات Admin Audit شوند:

```text
old value
new value
actor
reason
timestamp
```

---

# 102. Self-Service Customer Profile

خود کاربر نیز بتواند از Account خودش:

```text
نام
نام خانوادگی
ایمیل
موبایل
تاریخ تولد
آدرس‌ها
```

را مدیریت کند.

---

# 103. Verification برای تغییر ایمیل و موبایل

تغییر Email:

```text
New Email
→ Verification Code/Link
→ Confirm
→ Update
```

تغییر موبایل:

```text
New Phone
→ OTP
→ Confirm
→ Update
```

نباید صرفاً با PATCH ساده انجام شود.

---

# 104. امنیت حساب / احراز هویت دومرحله‌ای

قسمت Security در Account داشته باشیم:

```text
تغییر رمز
نشست‌های فعال
خروج از دستگاه‌ها
Two-Factor Authentication
Login History
```

2FA حداقل قابلیت طراحی برای:

```text
OTP
Authenticator App
```

را داشته باشد.

---

# 105. Product Ratings

سیستم امتیازدهی محصول اضافه شود.

مثلاً:

```text
1 تا 5 ستاره
```

برای هر Review:

```text
rating
title
comment
images optional
createdAt
updatedAt
```

---

# 106. Verified Purchase

Review مشخص کند آیا کاربر واقعاً محصول را خریداری کرده است یا خیر.

```text
Verified Purchase
```

Rating aggregation:

```text
Average Rating
Review Count
Rating Distribution
```

از داده واقعی محاسبه شود.

---

# 107. Review Moderation

Admin بتواند Reviewها را:

```text
تأیید
رد
مخفی
گزارش
```

کند.

اما Rating واقعی نباید به‌صورت دلخواه توسط Admin دستکاری شود.

تمام Moderationها Audit شوند.

---

# 108. Customer Reviews در CRM

در Customer 360 مشخص باشد:

```text
چه Reviewهایی نوشته
برای چه محصولاتی
چه Ratingهایی داده
چه Commentهایی گذاشته
Reviewهای تأییدشده
Reviewهای ردشده
```

این داده می‌تواند در تحلیل رضایت مشتری استفاده شود.

---

# 109. Product Review Analytics

در Product Admin:

```text
Average Rating
Review Count
1-star Count
2-star Count
3-star Count
4-star Count
5-star Count
```

همچنین Topicهای پرتکرار Reviewها در آینده قابل تحلیل باشند.

---

# 110. Recommendation Engine

یک Recommendation Domain مستقل طراحی شود.

نباید Recommendation فقط چند Product hardcoded باشد.

حداقل دو سطح داشته باشیم:

```text
Personalized Recommendation
Anonymous / General Recommendation
```

---

# 111. Personalized Recommendations

برای کاربر Login شده Recommendation بتواند از سیگنال‌های واقعی استفاده کند:

```text
Purchase History
Product Views
Wishlist
Cart
Categories
Colors
Sizes
Price Range
Ratings
Returns
Search History
```

مثلاً:

```text
چون قبلاً کت خریدی
→ شلوار مکمل
```

یا:

```text
بیشتر محصولات مشکی می‌بینی
→ محصولات مشکی مرتبط
```

---

# 112. Anonymous Recommendations

برای کاربری که Login نیست:

```text
Trending
Best Selling
New Arrivals
Popular in Category
Seasonal
Recently Popular
```

استفاده شود.

نیازی به شناخت هویت شخصی نیست.

---

# 113. Contextual Recommendations

Recommendation بتواند Context-aware باشد.

مثل:

```text
فصل
ماه
تاریخ
کمپین
موجودی
آب‌وهوا در صورت Integration آینده
ترند فروش
صفحه فعلی
```

مثلاً:

```text
Winter
→ coats / jackets
```

---

# 114. Recommendation Slots

Frontend نباید خودش Product Recommendation logic داشته باشد.

Slot تعریف شود:

```text
home.hero_recommendations
home.for_you
product.similar
product.complete_the_look
cart.you_may_like
checkout.last_minute
account.for_you
```

Backend برای هر Slot نتیجه برگرداند.

---

# 115. Recommendation Strategy

هر Slot بتواند Strategy داشته باشد:

```text
Personalized
Similar Product
Collaborative
Popular
Trending
Rule Based
Seasonal
Manual Campaign
```

در آینده ML نیز بتواند جایگزین یا ترکیب شود.

---

# 116. Recommendation Tracking

برای اینکه سیستم بعداً واقعاً بهتر شود، Eventها ثبت شوند:

```text
recommendation.shown
recommendation.clicked
recommendation.added_to_cart
recommendation.purchased
```

ولی Tracking باید با قواعد Privacy سیستم هماهنگ باشد.

---

# 117. Recommendation Admin Analytics

Admin بتواند ببیند:

```text
Impressions
Clicks
CTR
Add-to-cart
Conversion
Revenue
```

برای هر Strategy و Slot.

---

# 118. اتصال Recommendation به موجودی

محصولی که موجود نیست نباید بی‌دلیل در Recommendation فروش نشان داده شود.

Recommendation باید WMS availability را در نظر بگیرد.

---

# 119. اتصال Recommendation به Pricing

Recommendation باید قیمت و Promotion فعلی را از Pricing Engine دریافت کند.

هیچ Price مستقل یا Cache ناسازگار نداشته باشد.

---

# 120. CRM + Recommendation + Automation Architecture

ساختار مطلوب:

```text
Customer Events
        ↓
Customer Profile / CRM
        ↓
Smart Labels & Segments
        ↓
┌───────────────┬────────────────┐
↓               ↓                ↓
SMS        Recommendation       n8n
↓               ↓                ↓
Campaign      Website         Automation
```

همه این سیستم‌ها باید از Eventهای مشترک و داده‌های canonical استفاده کنند، نه اینکه هر بخش Customer Data جداگانه خودش را نگه دارد.

---

# 121. اصل نهایی Automation-Friendly

برای هر Feature جدید از این به بعد بررسی شود:

```text
آیا Event تولید می‌کند؟
آیا API دارد؟
آیا Webhook دارد؟
آیا Idempotent است؟
آیا Audit دارد؟
آیا n8n می‌تواند آن را Trigger/Action کند؟
```

هدف این است که KolbeVintage در آینده برای ساخت Automationهای جدید نیازمند تغییر بنیادی Backend نباشد.



## 122. سیستم Dynamic Product Specifications

«مشخصات محصول» نباید مجموعه‌ای از فیلدهای Hardcoded داخل Product Studio باشد.

باید یک سیستم مستقل برای تعریف **Product Attribute** داشته باشیم.

مثلاً Admin بتواند فیلدهای زیر را ایجاد کند:

```text
جنس
کشور تولید
فصل
نوع پارچه
ضخامت
نحوه شست‌وشو
نوع یقه
نوع آستین
فرم لباس
قد لباس
جنس زیره
جنس رویه کفش
نوع بسته‌شدن کفش
وزن
```

و هر زمان فیلد جدیدی لازم شد بدون تغییر کد Frontend یا Database Schema قابل تعریف باشد.

الگوی مناسب شبیه PIMهایی مانند Akeneo است که Attributeها را به‌صورت مستقل تعریف می‌کنند و سپس آن‌ها را در Familyهای مختلف Product دوباره استفاده می‌کنند؛ Shopify نیز برای داده‌های ساختاریافته و قابل استفاده مجدد از Metaobject/Metafield استفاده می‌کند و حتی Size Chart را یکی از Use Caseهای رسمی آن معرفی می‌کند.

---

## 123. Attribute Definition

هر فیلد مشخصات حداقل این ویژگی‌ها را داشته باشد:

```text
id
code
label
description

type:
text
textarea
number
decimal
boolean
single_select
multi_select
color
date
measurement
file
image
video
url

unit
required
searchable
filterable
variant_level
position
validation
active
```

مثلاً:

```text
label: جنس پارچه
code: fabric
type: single_select

options:
نخ
پنبه
کتان
پشم
پلی‌استر
چرم
```

---

# 124. Reusable Product Specification Templates

Admin باید بتواند قالب مشخصات بسازد.

مثلاً:

```text
قالب مشخصات تی‌شرت
```

شامل:

```text
جنس
فرم
نوع یقه
نوع آستین
ضخامت
نحوه شست‌وشو
کشور تولید
```

یا:

```text
قالب مشخصات کفش
```

شامل:

```text
جنس رویه
جنس زیره
ارتفاع ساق
نوع بسته‌شدن
وزن
مناسب فصل
```

فیلدها reusable باشند و یک Attribute بتواند در چندین Template استفاده شود.

---

# 125. Product Type → Specification Template

Product Typeهایی که قبلاً تعریف کردیم مستقیماً به این سیستم وصل شوند.

مثلاً:

```text
Product Type:
کاپشن

Specification Template:
مشخصات پوشاک زمستانی
```

در Product Editor فقط فیلدهای مرتبط با همان Type نمایش داده شوند.

ساختار:

```text
Product Type
↓
Specification Template
↓
Attribute Groups
↓
Attributes
↓
Product Values
```

---

# 126. Attribute Groups

مشخصات بتوانند دسته‌بندی شوند.

مثلاً برای کفش:

```text
اطلاعات عمومی
----------------
برند
مدل
کشور تولید

ساختار
----------------
جنس رویه
جنس زیره
ارتفاع ساق

ویژگی‌های فنی
----------------
وزن
ضدآب
تهویه

نگهداری
----------------
روش تمیزکردن
```

این باعث می‌شود صفحه Product Detail نیز جدول مشخصات مرتب و حرفه‌ای داشته باشد.

---

# 127. Product-specific Extra Fields

اگر محصول خاصی ویژگی‌ای داشت که در Template نیست، Admin/Supplier مجاز بتواند:

```text
+ افزودن مشخصه اختصاصی
```

انجام دهد.

اما این کار نباید Template اصلی را تغییر دهد.

دو گزینه وجود داشته باشد:

```text
فقط برای این محصول
```

یا:

```text
افزودن به Template برای محصولات بعدی
```

گزینه دوم فقط برای Admin دارای Permission مناسب.

---

# 128. Variant-level Attributes

بعضی مشخصات مربوط به Product هستند، بعضی مربوط به Variant.

مثلاً:

```text
Product:
جنس = پنبه

Variant:
رنگ = مشکی
سایز = 2XL
وزن = 720g
SKU = ...
```

Attribute باید بتواند تعیین کند:

```text
scope = product
scope = variant
```

Akeneo نیز در Variant Familyها امکان قرار دادن Attributeهایی مانند رنگ در یک سطح و رنگ+سایز/SKU/وزن در سطح Variant را مدل می‌کند.

---

# 129. Size Guide Builder

سیستم «راهنمای سایز» مستقل و کاملاً Dynamic باشد.

Admin بتواند Size Guide بسازد:

```text
راهنمای سایز تی‌شرت مردانه
راهنمای سایز کاپشن
راهنمای سایز شلوار
راهنمای سایز کفش
```

هیچ جدول ثابت داخل Frontend وجود نداشته باشد.

---

# 130. Dynamic Size Guide Columns

ستون‌های جدول نیز توسط Admin تعریف شوند.

مثلاً تی‌شرت:

```text
سایز
عرض سینه
قد لباس
عرض شانه
قد آستین
```

کفش:

```text
سایز
طول پا
طول کفی
عرض پا
```

شلوار:

```text
سایز
دور کمر
دور باسن
فاق
قد
```

---

# 131. Size Guide Template

Size Guide نیز مثل Series Template قابل استفاده مجدد باشد.

مثلاً:

```text
Template:
Men Jacket Standard v1
```

بعد بتوانیم آن را به:

```text
Product A
Product B
Product C
```

وصل کنیم.

---

# 132. Size Guide Override

گاهی دو لباس مشابه دقیقاً یک الگو ندارند.

پس Product بتواند:

```text
استفاده مستقیم از Template
```

یا:

```text
کپی Template و شخصی‌سازی برای این محصول
```

را انتخاب کند.

اگر Template مشترک Update شد، فقط محصولاتی که همچنان Link شده‌اند Update شوند؛ نسخه‌هایی که Detached شده‌اند مستقل باقی بمانند.

---

# 133. Multimedia Size Guide

Size Guide فقط جدول نباشد.

قابل افزودن باشد:

```text
تصویر
Diagram
ویدیو
GIF
متن راهنما
```

مثلاً:

```text
«دور سینه را از این قسمت اندازه بگیرید»
```

با تصویر مشخص‌کننده محل اندازه‌گیری.

یا ویدیو:

```text
چگونه سایز مناسب خود را اندازه بگیریم؟
```

Media از File/Storage Domain فعلی استفاده کند.

---

# 134. Size Guide Versioning

راهنمای سایز Version داشته باشد:

```text
Jacket Guide v1
Jacket Guide v2
```

تا تغییر یک جدول جدید باعث خراب شدن اطلاعات تاریخی Productهای قدیمی نشود.

---

# 135. Specification / Size Guide Library

Admin Console یک بخش مستقل داشته باشد:

```text
ساختار محصولات
```

با زیربخش‌های:

```text
انواع محصول
مشخصات محصول
قالب مشخصات
سایزها
راهنماهای سایز
قالب‌های سری
```

تا تمام Data Modeling محصول از یک مکان مدیریت شود.

---

# 136. CRM ↔ Promotion Engine

سیستم CRM و سیستم کوپن نباید دو جزیره جدا باشند.

ساختار:

```text
Customer Behavior
↓
CRM Smart Label
↓
Segment
↓
Automation Rule
↓
Coupon / SMS / Notification
```

مثلاً:

```text
مجموع خرید > 30,000,000 تومان
↓
Label:
مشتری ارزشمند
↓
Generate Personal Coupon
↓
10% Discount
↓
SMS
```

---

# 137. Safe CRM Automation

این Automation نباید بدون کنترل اجرا شود و یک Bug هزاران Coupon یا SMS تولید کند.

هر Automation Rule باید داشته باشد:

```text
Draft
Test
Active
Paused
```

و تنظیمات:

```text
حداکثر اجرای روزانه
حداکثر تعداد مخاطب
Cooldown
Usage limit
Budget cap
Expiration
Dry Run
Manual approval optional
```

---

# 138. Automation Dry Run

قبل از فعال‌کردن Rule:

```text
این Rule در حال حاضر روی 127 کاربر Match می‌شود.
```

نمایش داده شود.

Admin بتواند نمونه کاربران را ببیند.

بعد:

```text
فعال‌سازی
```

کند.

---

# 139. Personal Coupon Generation

Coupon Engine قابلیت تولید کد اختصاصی برای یک User داشته باشد.

مثلاً:

```text
YASHAR-BDAY-8F2K
```

Coupon:

```text
ownerUserId
10%
single-use
expiresAt
minimumOrder
allowedCategories
allowedProducts
installmentPolicy
```

---

# 140. Birthday Automation

Rule:

```text
event:
customer.birthday
```

Action:

```text
Generate Personal Coupon
→ Send SMS
```

مثلاً:

```text
تولدت مبارک!
۱۰٪ تخفیف ویژه خرید بعدی شما تا ۷ روز آینده.
کد: ...
```

Coupon باید Unique و قابل Audit باشد.

---

# 141. Reusable Coupon Campaign

Admin بتواند یک «قانون کمپین» تعریف کند:

```text
Birthday 10%
```

که محدودیت تعداد کلی ندارد، اما برای هر Customer در هر دوره یک Coupon شخصی تولید کند.

یعنی:

```text
Campaign Template
↓
Customer Trigger
↓
Coupon Instance
```

نه اینکه یک Code عمومی را برای همه ارسال کنیم.

---

# 142. CRM Triggers

علاوه بر تولد:

```text
مجموع خرید از حد مشخص
اولین خرید
پنجمین خرید
عدم خرید در 60 روز
Membership expiry
VIP upgrade
Cart abandoned
Product review
High rating
Low rating
Returned order
```

بتوانند Trigger باشند.

---

# 143. SMS Campaign Safety

ارسال بازاریابی باید فقط برای کاربری انجام شود که شرایط ارسال پیام بازاریابی را دارد.

در Customer profile وضعیت‌هایی مثل:

```text
Marketing SMS consent
Transactional SMS
Unsubscribed
Do-not-contact
```

وجود داشته باشد.

SMSهای عملیاتی مثل Tracking از Marketing Campaign جدا باشند.

---

# 144. Finance Architecture

بخش «مالی و تسویه» باید از یک Dashboard ساده به یک **Financial Operations System** تبدیل شود.

برای طراحی این بخش الگوهای چند سیستم حسابداری بزرگ بررسی شد:

Odoo علاوه بر Vendor Bills و پرداخت، Aged Payable، Bank Reconciliation، Budget، Asset Management و Analytic Accounting دارد؛ Analytic Accounting اجازه می‌دهد هزینه و درآمد به حساب‌ها/ابعاد تحلیلی مختلف تخصیص داده شود.

NetSuite علاوه بر A/P Aging، Vendor Prepayment و Vendor Payment، مکانیزم 3-Way Match برای مقایسه Bill با Purchase Order و Receipt دارد تا اختلاف مقدار یا مبلغ قبل از پرداخت شناسایی شود.

QuickBooks گزارش‌هایی مانند Accounts Payable Aging، Supplier/Vendor Balance، Unpaid Bills و Transaction List by Supplier ارائه می‌کند و Xero نیز A/P Aging Detail/Summary با Due Date، Bill Date، Grouping و Filtering دارد.

این مفاهیم را متناسب با مدل Marketplace خودمان پیاده می‌کنیم، نه اینکه UI آن سیستم‌ها را کپی کنیم.

---

# 145. Double-entry Ledger

تمام رویدادهای مالی مهم باید به دفتر کل دوطرفه متصل باشند.

هیچ عدد مالی حساس نباید فقط یک Counter یا فیلد مستقل باشد.

مثلاً:

```text
Order Payment
Supplier Payable
Commission
Shipping Cost
Refund
Settlement
Withdrawal
Adjustment
Discount Cost
```

باید Journal Entry ایجاد کند.

---

# 146. Supplier Financial Account

هر Supplier یک Financial Account کامل داشته باشد.

نمایش:

```text
Gross Sales
Net Sales
Platform Commission
Discount Share
Shipping Charges
Return Costs
Refunds
Adjustments
Penalties
Bonuses
Taxes
Withholding
Pending Payable
Available Payable
Blocked Amount
Settled Amount
Withdrawals
Prepayments
```

---

# 147. Supplier Statement

برای هر Supplier یک Statement مشابه صورت‌حساب بانکی داشته باشیم.

هر سطر:

```text
Date
Reference
Event
Debit
Credit
Balance
Order
Settlement
Description
```

مثلاً:

```text
+ فروش سفارش WO-1021
- کارمزد کلبه
- هزینه مرجوعی
+ اصلاح حساب
- تسویه بانکی
```

---

# 148. Supplier A/P Aging

یک گزارش **Supplier Payable Aging** داشته باشیم.

Bucketها:

```text
سررسید نشده
1–7 روز
8–30 روز
31–60 روز
61–90 روز
90+ روز
```

این دقیقاً از الگوی A/P Aging رایج در NetSuite/Xero/QuickBooks الهام گرفته شده که بدهی باز به Vendor را بر اساس تاریخ سررسید یا سن تراکنش تحلیل می‌کنند.

---

# 149. Settlement Engine

Supplier Settlement باید Engine مستقل داشته باشد.

Flow:

```text
Eligible Orders
↓
Calculate Gross Payable
↓
Commission
↓
Refund/Return
↓
Shipping/Other Costs
↓
Adjustments
↓
Net Settlement
↓
Approval
↓
Payment
↓
Ledger
↓
Statement
```

---

# 150. Settlement Detail

هر Settlement باید ریز جزئیات داشته باشد.

مثلاً:

```text
Settlement #ST-10021

Gross sales          150,000,000
Commission            -12,000,000
Shipping adjustment    -2,500,000
Returns                -4,000,000
Other adjustments        +500,000
--------------------------------
Net payable           132,000,000
```

و هر عدد قابل Drill-down باشد.

---

# 151. Order-level Supplier Finance

Admin و Supplier بتوانند داخل یک Wholesale Order ببینند:

```text
قیمت فروش
تعداد
تخفیف
سهم Supplier
سهم کلبه
هزینه ارسال
هزینه برگشت
مالیات
تعدیل
مبلغ قابل تسویه
```

و تمام محاسبات به Ledger Reference داشته باشند.

---

# 152. Shipping Cost Allocation

هزینه حمل و سایر هزینه‌های مشترک باید قابلیت تخصیص داشته باشند.

روش‌ها:

```text
بر اساس وزن
بر اساس تعداد
بر اساس ارزش کالا
بر اساس حجم
تقسیم مساوی
```

Odoo برای Landed Cost همین الگوهای Equal، Quantity، Current Cost، Weight و Volume را دارد و NetSuite نیز تخصیص بر اساس Weight، Quantity یا Value را پشتیبانی می‌کند.

برای Kolbe این مفهوم علاوه بر Inventory Cost می‌تواند برای Allocation شفاف هزینه حمل بین Lineها/Supplierها استفاده شود.

---

# 153. Weight-based Financial Trace

چون Shipping Engine بر اساس وزن کار خواهد کرد، Finance نیز باید Trace کامل داشته باشد.

مثلاً:

```text
Shipment Weight: 8.4 kg
Carrier Fee: 420,000
```

و Allocation:

```text
Supplier A
5.4kg
270,000

Supplier B
3kg
150,000
```

Rule محاسبه و Snapshot آن نگهداری شود.

---

# 154. Settlement Reconciliation

قبل از تسویه Supplier:

```text
Order
vs
Fulfillment / Delivery
vs
Supplier Payable
```

با هم تطبیق داده شوند.

این یک مدل متناسب با Marketplace از ایده 3-Way Match است؛ NetSuite از تطبیق Bill با Purchase Order و Item Receipt برای جلوگیری از پرداخت اختلاف‌های نامعتبر استفاده می‌کند.

اگر اختلاف وجود داشت:

```text
Settlement Exception
```

ایجاد شود.

---

# 155. Settlement Exceptions

مثلاً:

```text
Quantity mismatch
Returned quantity
Cancelled line
Commission mismatch
Shipping discrepancy
Manual adjustment
Payment dispute
```

قبل از Settlement نهایی Review شوند.

---

# 156. Supplier Prepayments / Advances

اگر در آینده نیاز بود مبلغی پیش از تسویه نهایی به Supplier پرداخت کنیم:

```text
Supplier Advance
```

وجود داشته باشد.

بعداً هنگام Settlement از مبلغ قابل پرداخت کسر شود.

NetSuite نیز Vendor Prepayment را به‌عنوان موجودیت مستقل ثبت می‌کند و آن را بعداً روی Billهای Vendor اعمال می‌کند.

---

# 157. Financial Adjustments

Admin مالی بتواند Adjustment ثبت کند:

```text
Credit Adjustment
Debit Adjustment
```

اما بدون حذف یا دستکاری تراکنش قبلی.

هر Adjustment:

```text
reason
reference
amount
actor
approvedBy
createdAt
```

داشته باشد.

---

# 158. Financial Approval Workflow

عملیات حساس:

```text
Large Settlement
Manual Adjustment
Supplier Advance
Refund
High-value Withdrawal
```

قابلیت Approval داشته باشند.

مثلاً:

```text
Requested
→ Reviewed
→ Approved
→ Paid
```

Permission و Audit کامل.

---

# 159. Reconciliation

Payment/Settlementهایی که به Provider یا حساب بانکی ارسال می‌شوند باید Reconciliation داشته باشند.

حالت‌ها:

```text
Expected
Processing
Paid
Reconciled
Mismatch
Failed
```

---

# 160. Finance Dimensions / Analytic Accounting

گزارش مالی فقط بر اساس کل شرکت کافی نیست.

هر Ledger Entry بتواند Dimension داشته باشد:

```text
Supplier
Channel
Retail / Wholesale
Warehouse
Category
Order
Campaign
Payment Provider
Shipping Carrier
```

تا بتوان Profitability و Cost را تحلیل کرد.

این مشابه مفهوم Analytic Accounting در Odoo است که هزینه و درآمد را بین حساب‌ها/ابعاد تحلیلی توزیع می‌کند.

---

# 161. واقعی بودن تمام Finance Charts

هیچ Chart در قسمت مالی نباید با Mock Data یا Random data ساخته شود.

تمام Chartها:

```text
API
↓
PostgreSQL / Ledger
↓
Aggregation
↓
Chart
```

---

# 162. Finance Dashboard

Dashboard اصلی حداقل KPIهای زیر را داشته باشد:

```text
فروش ناخالص
فروش خالص
درآمد کلبه
کارمزد Marketplace
Refund
Return Cost
Shipping Cost
Supplier Payables
Settlements
Outstanding Payables
Cash Collected
Payment Failures
Net Revenue
```

---

# 163. Supplier Finance Dashboard

داخل Supplier 360 نیز Dashboard مخصوص همان Supplier:

```text
فروش امروز
فروش ماه
فروش سال
رشد فروش
تعداد سفارش
Average Order Value
Gross Payable
Net Payable
Settlement Due
Settled
Commission
Returns
Refunds
Shipping Cost
```

---

# 164. Finance Charts

حداقل Chartهای واقعی:

```text
Revenue over Time
Gross vs Net Sales
Commission Revenue
Supplier Payable Trend
Settlement Trend
Return / Refund Cost
Shipping Cost
Order Volume
Average Order Value
Payment Success Rate
```

---

# 165. Time Range System

تمام Analyticsها Range مشترک داشته باشند:

```text
امروز
ساعتی
۷ روز
۳۰ روز
۳ ماه
۶ ماه
سال جاری
۱۲ ماه اخیر
کل دوره
بازه دلخواه
```

و Comparison:

```text
vs previous period
vs previous year
```

---

# 166. Drill-down Analytics

Chart فقط نمای تصویری نباشد.

مثلاً کلیک روی:

```text
Shipping Cost
```

باید بتواند کاربر را ببرد به:

```text
Carrier
Supplier
Shipment
Order
Weight
Ledger Entry
```

---

# 167. Finance Report Center

یک بخش:

```text
گزارش‌های مالی
```

با حداقل:

```text
دفتر کل
تراز حساب‌ها
Supplier Statement
Supplier Balance
Payable Aging
Settlement Report
Revenue Report
Commission Report
Refund Report
Return Cost Report
Shipping Cost Report
Payment Report
Invoice Report
```

---

# 168. Export

هر Report مهم:

```text
PDF
XLSX
CSV
```

خروجی داشته باشد.

---

# 169. Period Closing

برای آینده معماری امکان:

```text
Accounting Period
Open
Closed
Locked
```

داشته باشد.

تا بعد از بسته شدن یک دوره مالی، داده تاریخی با Edit مستقیم تغییر نکند.

اصلاح از طریق Adjustment/Reverse Entry باشد.

---

# 170. Supplier Financial 360

بخش Supplier 360 که قبلاً تعریف شد، حالا باید Financial Tab بسیار قوی داشته باشد:

```text
Overview
Orders
Products
Inventory
Performance
Financial
Settlements
Wallet
Invoices
Returns
Tickets
Documents
Restrictions
Timeline
Audit
```

Financial آن باید تقریباً تمام مسیر پول از:

```text
Customer Payment
→ Order
→ Supplier Payable
→ Commission
→ Costs
→ Settlement
→ Supplier Payment
```

را قابل مشاهده کند.

---

# 171. Finance Event Integration

تمام رویدادهای مالی Event تولید کنند:

```text
payment.completed
invoice.issued
refund.completed
supplier.payable.created
settlement.created
settlement.approved
settlement.paid
withdrawal.requested
withdrawal.paid
adjustment.created
```

تا سیستم Automation/n8n بتواند بعداً روی آن‌ها Workflow بسازد.

---

# 172. اصل نهایی Finance

هیچ Dashboard یا Supplier Profile نباید یک نسخه دوم از اطلاعات مالی را نگهداری کند.

ساختار:

```text
Orders / Payments / WMS / Shipping
            ↓
        Finance Events
            ↓
          Ledger
            ↓
 ┌──────────┼──────────┐
 ↓          ↓          ↓
Invoices  Supplier   Analytics
          Settlement
```

Ledger و Domainهای مالی Source of Truth هستند.

Dashboardها فقط View و Aggregation هستند.



## 173. بازطراحی کامل CMS

CMS فعلی باید از حالت:

```text
Page
→ چند Section محدود
```

خارج شود و تبدیل شود به:

```text
CMS
├── Pages
├── Component Library
├── Component Builder
├── Section Templates
├── Product Card Templates
├── Hero Templates
├── Dynamic Collections
├── Categories
├── Vibes
├── Campaigns
├── Theme Engine
├── Design Tokens
└── Preview / Version / Publish
```

CMS باید مستقیماً به Commerce Domainهای واقعی متصل باشد.

---

# 174. رفع کامل خطای Hero

Hero فعلی که خطای `500` می‌دهد باید قبل از هر توسعه دیگری Root-cause شود.

ممنوع است فقط Error را Hide کنیم.

باید بررسی شود:

```text
CMS Page
Hero Section
Media
Palette
Serialization
API Contract
Database
```

و تست واقعی داشته باشد:

```text
Fresh DB
→ bootstrap homepage
→ create hero
→ edit hero
→ publish
→ GET home
→ render
```

بدون 500.

---

# 175. Component Registry

تمام Componentهای CMS باید Registry مرکزی داشته باشند.

مثلاً:

```text
Hero
Countdown
Product Grid
Product Carousel
Product Card
Category Card
Banner
Video Hero
Image Hero
Text Section
CTA
Installment Card
Promotion Banner
Brand Strip
Review Section
Recommendation Section
Newsletter
FAQ
Spacer
Divider
```

هر Component Schema مخصوص خودش را داشته باشد.

---

# 176. Component Schema

مثلاً Countdown:

```text
name: Countdown
props:
  title
  targetDate
  campaignId
  background
  foreground
  radius
  layout
  showDays
  showHours
  showMinutes
  showSeconds
```

Hero:

```text
headline
eyebrow
description
media
video
poster
cta
secondaryCta
alignment
height
overlay
theme
animation
```

---

# 177. Visual Component Editor

Admin باید بتواند:

```text
Add
Delete
Duplicate
Move
Reorder
Configure
Preview
Disable
```

Componentها را انجام دهد.

Page:

```text
Hero
↓
Category Grid
↓
Special Offers
↓
New Arrivals
↓
Editorial Banner
↓
Recommendations
```

Drag/Reorder در صورت امکان.

---

# 178. Component Builder

علاوه بر Componentهای آماده، Admin باید بتواند Component جدید **بدون کدنویسی مستقیم React** بسازد.

از Primitiveهای امن:

```text
Container
Grid
Stack
Text
Image
Video
Button
Icon
Badge
Price
Product Image
Product Title
Rating
Countdown
```

مثلاً:

```text
Custom Product Card
├── Product Image
├── Discount Badge
├── Title
├── Price
├── Installment Info
└── CTA
```

---

# 179. ممنوعیت Arbitrary Runtime Code

CMS نباید اجازه اجرای JavaScript دلخواه از Database را بدهد.

Component جدید دو نوع باشد:

```text
Composable Component
→ توسط Admin از primitiveهای امن

Code Component
→ توسط Developer ساخته و Registry می‌شود
```

این مرز برای امنیت و maintainability ضروری است.

---

# 180. Component Presets

هر Component چند Preset آماده داشته باشد.

مثلاً Hero:

```text
Minimal Hero
Editorial Hero
Video Hero
Split Hero
Full-screen Hero
Product Hero
Campaign Hero
Collection Hero
```

Countdown:

```text
Minimal
Dark
Floating
Glass
Banner
Compact
```

Product Card:

```text
Classic
Editorial
Minimal
Image-first
Luxury
Sale
New Arrival
VIP
```

---

# 181. قابلیت Customization کامل

هر Component باید براساس Schema خودش قابلیت تنظیم داشته باشد.

مثلاً:

```text
Background
Foreground
Border
Radius
Shadow
Padding
Gap
Width
Height
Typography
Alignment
Overlay
Media
Animation
```

اما ترجیحاً از Design Tokenهای سایت استفاده کند.

---

# 182. Component Variants

یک Component بتواند Variantهای مختلف داشته باشد.

مثلاً:

```text
ProductCard
├── default
├── sale
├── new
├── premium
├── editorial
└── wholesale
```

نه اینکه برای هر حالت یک Component مستقل و تکراری بسازیم.

---

# 183. Component State Preview

داخل CMS بتوان Component را در حالت‌های مختلف Preview کرد.

مثلاً Product Card:

```text
Normal
Sale
Out of Stock
Low Stock
Installment
New
VIP
Long Title
No Image
```

تا قبل از Publish مشکلات UI دیده شوند.

---

# 184. Responsive Preview

Preview:

```text
Desktop
Tablet
Mobile
```

و Component بتواند برخی تنظیمات Responsive مستقل داشته باشد.

---

# 185. Commerce Data Binding

CMS نباید Data تجاری را کپی کند.

Component باید بتواند مستقیم به Domain واقعی متصل شود.

مثلاً:

```text
Product Card
↓
Product API
↓
Pricing Engine
↓
Discount Engine
↓
Installment Policy
↓
WMS
```

CMS فقط Presentation را تعیین کند.

---

# 186. Countdown ↔ Promotion

Countdown دستی تنها گزینه نباشد.

دو Mode:

```text
Manual Date
```

یا:

```text
Bind to Campaign
```

مثلاً:

```text
Black Friday Campaign
endsAt = 2026-11-27T23:59
```

Countdown همان زمان واقعی Campaign را مصرف کند.

---

# 187. Campaign Data Binding

یک Section بتواند به Campaign وصل شود.

مثلاً:

```text
Special Offers Section
↓
Campaign: Black Friday
```

و خودش:

```text
products
discount
start
end
theme
countdown
```

را از سیستم Campaign دریافت کند.

---

# 188. Installment Component

کامپوننت مستقلی برای نمایش خرید اقساطی داشته باشیم.

مثلاً:

```text
۴ قسط
هر قسط: 2,450,000 تومان
```

اما مبلغ را CMS محاسبه نکند.

Data:

```text
Pricing Engine
↓
Installment Engine
↓
Installment Provider
```

---

# 189. Installment Provider Cards

برای Providerهای مختلف:

```text
Digipay
SnappPay
Providerهای آینده
```

Component Variant داشته باشیم.

مثلاً:

```text
SnappPay Card
Digipay Card
Generic Installment Card
```

لوگو، متن، تعداد اقساط و شرایط از Integration/Pricing Domain بیاید.

---

# 190. Sync خودکار Installment با Product

اگر Product:

```text
installment_enabled = true
```

و Provider:

```text
SnappPay
```

داشت، Product Card بتواند اتوماتیک Component مربوط به SnappPay را نمایش دهد.

اگر:

```text
installment_enabled = false
```

هیچ Installment badge/card نمایش داده نشود.

---

# 191. Installment Dynamic Amount

مثلاً:

```text
Final price:
12,000,000

Installments:
4

Per installment:
3,000,000
```

این Calculation فقط Server-side باشد.

CMS صرفاً render کند.

---

# 192. Dynamic Product Cards

Product Card باید Rule-aware باشد.

مثلاً:

```text
Discount >= 50%
→ use "High Discount Card"
```

یا:

```text
isNew = true
→ New Arrival Card
```

یا:

```text
installment = true
→ Installment Card
```

---

# 193. Product Card Rule Engine

Admin بتواند Rule تعریف کند:

```text
IF
discount >= 50%

THEN
cardVariant = sale-red
```

یا:

```text
IF
collection = new-arrivals

THEN
cardVariant = editorial-new
```

---

# 194. Card Priority

ممکن است یک محصول هم:

```text
New
Discounted
Installment
```

باشد.

پس Ruleها Priority داشته باشند:

```text
1. Major Sale
2. Campaign
3. New
4. Installment
5. Default
```

Admin بتواند Priority را مدیریت کند.

---

# 195. فعال/غیرفعال کردن Rule

مثلاً:

```text
«محصولات با تخفیف بالای 50٪ کارت قرمز داشته باشند»
```

قابل:

```text
Enable
Disable
Schedule
```

باشد.

---

# 196. Product Card Designer

Admin بتواند Template کارت محصول بسازد.

مثلاً:

```text
Card
├── Image
├── Badge
├── Brand
├── Name
├── Original Price
├── Discount Price
├── Installment Info
├── Rating
└── CTA
```

همراه Customization.

---

# 197. Design Quality Gate

Card Template جدید قبل از Publish با معیارهای:

```text
Hierarchy
Spacing
Typography
Contrast
Mobile
Accessibility
Long text
Missing media
RTL
Hover
Focus
Loading
```

بررسی شود.

---

# 198. Default Professional Card Library

از ابتدا چند Card Template حرفه‌ای مخصوص Kolbe ساخته شود:

```text
Kolbe Classic
Kolbe Editorial
Kolbe Minimal
Kolbe Sale
Kolbe Flash Sale
Kolbe New Arrival
Kolbe Premium
Kolbe Installment
Kolbe Dark
```

این‌ها باید با Design System خود Kolbe همخوان باشند، نه Generic UI Kit.

برای طراحی این Variantها از رویکردهای Design-system-first، Variant testing و Interface Review استفاده شود.

---

# 199. Category Management

CMS باید Category Cardها را نیز مدیریت کند.

Category:

```text
name
slug
description
image
cover
icon
SEO
position
parent
active
```

---

# 200. Category Card Templates

مثلاً:

```text
Image Card
Editorial Card
Minimal Card
Glass Card
Overlay Card
Horizontal Card
```

و Card قابل Customization باشد.

---

# 201. Vibe Taxonomy

علاوه بر Category، مفهوم:

```text
Vibe
```

داشته باشیم.

مثلاً:

```text
Old Money
Dark Academia
Streetwear
Minimal
Vintage
Y2K
Quiet Luxury
Workwear
Classic
```

---

# 202. Vibe Entity

Vibe فقط Tag متنی نباشد.

Entity:

```text
id
name
slug
description
cover
palette
SEO
active
position
```

داشته باشد.

---

# 203. Product ↔ Vibe

در Product Editor بتوانیم تعریف کنیم:

```text
Category:
پالتو

Vibes:
Old Money
Dark Academia
```

یک Product بتواند چند Vibe داشته باشد.

---

# 204. Supplier Vibe Selection

برای Productهای Supplier نیز در Wholesale:

```text
Product Type
Category
Vibes
```

قابل انتخاب باشد.

اما باز همان قانون:

```text
Supplier Product
→ Wholesale only
```

حفظ شود.

---

# 205. Vibe Landing Pages

CMS بتواند Landing Page بسازد:

```text
/vibe/old-money
/vibe/dark-academia
```

شامل:

```text
Hero
Editorial
Products
Collections
Content
SEO
```

---

# 206. Dynamic Collection

CMS باید بتواند Collection پویا بسازد.

مثلاً:

```text
New Arrivals
Sale >= 40%
Black Products
Old Money
Winter Jackets
Installment Products
```

بدون واردکردن دستی Product IDها.

---

# 207. Collection Query Builder

Admin:

```text
Category = Coat
AND
Vibe = Old Money
AND
Stock > 0
AND
Discount >= 20%
```

و CMS همان Productها را نمایش دهد.

---

# 208. Manual Collection

همچنان بتوان Productها را دستی انتخاب کرد:

```text
Manual Selection
```

برای Campaignهای Editorial.

---

# 209. Hero Template Library

Hero فقط یک فرم Title/Image نباشد.

Templateهای آماده:

```text
Static Image Hero
Video Hero
Split Hero
Editorial Hero
Product Hero
Collection Hero
Minimal Hero
Full Viewport Hero
Horizontal Media Hero
Cinematic Hero
```

---

# 210. Video Hero

Video Hero:

```text
video
poster
mobileVideo
mobilePoster
autoplay
muted
loop
overlay
headline
cta
```

و Performance-safe باشد.

---

# 211. Hero Customization

قابل تنظیم:

```text
Height
Content Width
Alignment
Overlay
Color
Typography
Media Position
CTA Style
Motion
Scroll Indicator
```

---

# 212. Hero Content Binding

Hero بتواند به:

```text
Campaign
Product
Category
Vibe
Manual Content
```

وصل شود.

مثلاً Black Friday Hero زمان Campaign را بگیرد.

---

# 213. Component Templates از پیش ساخته

CMS از ابتدا Library واقعی داشته باشد.

نه اینکه Fresh DB فقط یک Hero خالی داشته باشد.

Bootstrap حداقل:

```text
Hero presets
Product cards
Category cards
Countdown
Campaign banner
Installment card
Editorial sections
Product grids
```

را ایجاد کند.

---

# 214. Visual Preview

CMS باید Draft را قبل از Publish روی سایت واقعی Preview کند.

مثل:

```text
Desktop
Tablet
Mobile
```

با تغییر Component، Preview سریع Update شود.

Block-based visual editing و preview نزدیک به همین الگو در Storyblok استفاده می‌شود.

---

# 215. Draft / Publish

هر Page:

```text
Draft
Scheduled
Published
Archived
```

داشته باشد.

---

# 216. Version History

هر تغییر:

```text
Who
When
What changed
```

ثبت شود.

و امکان:

```text
Restore Version
```

وجود داشته باشد.

---

# 217. Scheduled Publishing

مثلاً:

```text
Valentine Homepage
```

Admin:

```text
Start:
14 Feb 00:00

End:
15 Feb 00:00
```

و سیستم خودکار فعال/غیرفعال کند.

---

# 218. Site Theme Engine

یک بخش مستقل:

```text
تم و ظاهر سایت
```

داشته باشیم.

از این قسمت تمام Design Tokenهای اصلی سایت مدیریت شوند.

---

# 219. Design Tokens

مثلاً:

```text
background
surface
surfaceSecondary
textPrimary
textSecondary
primary
secondary
accent
border
success
warning
danger
```

و Tokenهای دیگر:

```text
radius
shadow
font
spacing
```

---

# 220. Theme Presets

از ابتدا:

```text
Kolbe Default
Valentine
Black Friday
Nowruz
Winter
Summer
```

Preset داشته باشیم.

---

# 221. Valentine Theme

مثلاً Admin 5–6 رنگ وارد کند:

```text
background
header
surface
accent
text
border
```

و Theme Engine همه UI را از Design Tokenها تغییر دهد.

نباید CSS را دستی تغییر دهیم.

---

# 222. Black Friday Theme

مثلاً:

```text
Dark Background
Warm Accent
High Contrast Sale
```

ولی همچنان Typography، Accessibility و Brand consistency حفظ شود.

---

# 223. Theme Preview

قبل از Activate:

```text
Preview
```

برای:

```text
Home
Product
Category
Cart
Checkout
Account
```

وجود داشته باشد.

---

# 224. Scheduled Theme

Theme نیز قابلیت Scheduling داشته باشد:

```text
Black Friday Theme
Start
End
```

بعد از پایان:

```text
Auto Restore Previous Theme
```

---

# 225. Theme + Campaign Binding

Campaign بتواند Theme مشخص کند:

```text
Campaign:
Valentine

Theme:
Valentine 2027
```

با فعال شدن Campaign، Theme فعال شود.

---

# 226. Component Theme Awareness

Componentها نباید Color hardcoded داشته باشند.

مثلاً:

```text
background = token.surface
text = token.textPrimary
accent = token.accent
```

ولی Component بتواند Override کنترل‌شده داشته باشد.

---

# 227. Section-level Theme

حتی داخل یک Page:

```text
Section A → Light
Section B → Dark
Section C → Campaign
```

قابل تعریف باشد.

---

# 228. Design System Guardrails

Admin آزادی طراحی داشته باشد، ولی نباید بتواند به‌سادگی Design System را خراب کند.

دو Mode:

```text
Simple
Advanced
```

Simple:

```text
Preset
Spacing
Theme
Media
Content
```

Advanced:

```text
Detailed Tokens
Layout
Responsive
Animation
```

---

# 229. CMS Asset Library

Media Library مستقل:

```text
Images
Videos
Icons
Documents
```

با:

```text
Search
Tags
Folder
Alt
Usage
Upload Date
Uploader
```

---

# 230. Media Usage

قبل از Delete یک Image:

```text
Used by:
Home Hero
Product X
Campaign Y
```

نمایش داده شود.

---

# 231. CMS Search

Search:

```text
Pages
Components
Templates
Campaigns
Categories
Vibes
Media
```

از یک نقطه.

---

# 232. CMS Permissions

مثلاً:

```text
cms:read
cms:edit
cms:publish
cms:templates
cms:theme
cms:components
cms:media
```

Editor معمولی نباید الزاماً Theme کل سایت را تغییر دهد.

---

# 233. CMS Audit Log

عملیات مهم:

```text
publish
unpublish
theme change
component delete
template update
campaign binding
```

Audit شوند.

---

# 234. CMS Performance

Componentها باید:

```text
Lazy load where appropriate
Responsive images
Code splitting
Video optimization
Server-side data fetching where necessary
```

داشته باشند.

Hero اصلی نباید بی‌دلیل lazy load شود.

---

# 235. CMS SEO Integration

هر Page/Category/Vibe/Collection باید مستقیم به SEO Domain متصل باشد.

```text
SEO Title
Description
Canonical
Schema
Social
Index
```

نه SEO مستقل داخل CMS.

---

# 236. CMS Analytics Hooks

هر Component بتواند Eventهای استاندارد تولید کند:

```text
component.view
banner.click
product_card.click
campaign.click
cta.click
```

برای Analytics/CRM/Recommendation.

---

# 237. CMS Automation Hooks

CMS نیز n8n-friendly باشد.

Eventها:

```text
cms.page.published
cms.page.scheduled
cms.theme.activated
cms.campaign.activated
```

---

# 238. Component Data Sources

هر Dynamic Component بتواند Data Source انتخاب کند:

```text
Products
Categories
Vibes
Campaign
Recommendations
Reviews
Manual
```

---

# 239. Recommendation Component

Component آماده:

```text
پیشنهاد برای شما
محصولات مشابه
محبوب‌ترین‌ها
ترند
```

مستقیماً Recommendation Engine را مصرف کند.

---

# 240. Review Component

Component آماده:

```text
Product Rating
Reviews
Customer Photos
Rating Summary
```

از Review Domain.

---

# 241. Homepage Composition

صفحه اصلی دیگر Hardcoded نباشد.

ساختار کاملش از CMS بیاید:

```text
CMS Page
↓
Blocks
↓
Registered Components
↓
Data Sources
↓
Commerce APIs
```

---

# 242. Component Design Standard

تمام Componentهای اولیه Kolbe باید در قالب یک Design Language مشترک طراحی شوند:

```text
Editorial
Premium
Fashion-focused
Clean
RTL-first
Responsive
Motion-aware
Accessible
```

نه اینکه هر Component ظاهر کاملاً متفاوت داشته باشد.

---

# 243. Design Reference Process

برای ساخت Component جدید Agent باید:

```text
1. Product goal
2. Content hierarchy
3. Component states
4. Design references
5. Variants
6. Responsive behavior
7. Accessibility
8. Stress test
9. Implementation
10. Visual review
```

را طی کند.

این با رویکرد Design-first و Variant/Interface-review در Skillهای معرفی‌شده هم‌راستاست.

---

# 244. CMS Definition of Done

CMS زمانی کامل است که:

```text
Hero 500 = fixed
Pages dynamic
Components reusable
Component builder available
Presets available
Product cards customizable
Category cards customizable
Vibes supported
Dynamic collections supported
Promotion binding supported
Installment binding supported
Countdown binding supported
Themes dynamic
Themes schedulable
Visual preview working
Draft/publish/versioning working
SEO integrated
Analytics integrated
Automation hooks available
```

و هیچ Page اصلی سایت برای Composition به JSX hardcoded وابسته نباشد.



این بخش را هم به همان سند اضافه می‌کنیم. از شماره 245 ادامه می‌دهم تا بعداً همه Requirementها را یکجا وارد پرامپت نهایی کنیم.

# 245. جنسیت محصول

هر Product باید بتواند Audience/Gender داشته باشد.

```text
مردانه
زنانه
یونیسکس
بچگانه
سایر / قابل تعریف
```

Backend مقدار Canonical نگهداری کند و Admin بتواند گزینه‌های جدید را در صورت نیاز تعریف کند.

این داده باید در:

```text
Product Editor
Search
Filters
Recommendations
Style Builder
Collections
SEO
Analytics
```

قابل استفاده باشد.

---

# 246. فصل محصول به‌صورت Multi-select

Season نباید Single-select باشد.

یک محصول ممکن است:

```text
بهار + پاییز
```

یا:

```text
بهار + تابستان + پاییز
```

یا:

```text
تمام فصول
```

باشد.

بنابراین:

```text
Product
→ seasons[]
```

و فصل‌ها قابل مدیریت باشند:

```text
Spring
Summer
Autumn
Winter
All-season
```

---

# 247. فصل به‌عنوان Taxonomy واقعی

Season فقط یک متن داخل Product نباشد.

در:

```text
Filter
Search
Recommendation
Style Builder
Collection Builder
Campaign
CMS
Analytics
```

قابل Query باشد.

مثلاً:

```text
Category = Jacket
AND
Season = Winter
AND
Vibe = Dark Academia
```

---

# 248. Style Builder Intelligence Engine

Style Builder از حالت Canvas ساده خارج شود و یک Intelligence Layer داشته باشد.

هدف:

```text
Product
↓
Fashion Features
↓
Compatibility Engine
↓
Style Score
↓
Recommendation
↓
Explanation
```

---

# 249. تحلیل خودکار هر محصول

وقتی محصول جدید و تصاویرش ثبت شدند، Automation بتواند اطلاعات Style را استخراج کند.

مثلاً:

```text
dominant colors
secondary colors
product type
silhouette
fit
pattern
material appearance
formal/casual level
season
vibes
style tags
visual weight
contrast
```

بخشی از این اطلاعات می‌تواند از اطلاعات دستی Product استفاده شود و بخش تصویری توسط مدل تحلیل تصویر تولید شود.

---

# 250. Fashion Feature Profile

برای هر Product یک Profile ماشین‌خوان داشته باشیم.

مثلاً:

```json
{
  "dominantColors": ["cream"],
  "productType": "trousers",
  "vibes": ["old-money", "minimal"],
  "seasons": ["spring", "autumn"],
  "formality": 0.75,
  "pattern": "solid",
  "fit": "regular"
}
```

این Data نباید جای اطلاعات اصلی Product را بگیرد.

فقط Data مخصوص Recommendation/Style Intelligence است.

---

# 251. Style Intelligence Data Store

اطلاعات Style می‌تواند در PostgreSQL/JSONB یا ساختار مناسب دیگری نگهداری شود.

نباید یک JSON File پراکنده کنار پروژه داشته باشیم.

لازم است:

```text
product_id
feature_version
features
model_version
generated_at
source
confidence
```

ذخیره شود.

---

# 252. تحلیل خودکار بعد از ایجاد Product

Flow:

```text
Product Created
↓
Images Uploaded
↓
product.style-analysis.requested
↓
Worker / n8n
↓
Vision/Rule Analysis
↓
Store Features
↓
Compatibility Update
```

این Process باید Async باشد و ایجاد Product را Block نکند.

---

# 253. Style Compatibility Score

مثلاً:

```text
Pink Shirt
+
Cream Trousers
=
Style Score: 94/100
```

Score باید از چند Dimension تشکیل شود.

مثلاً:

```text
Color Harmony
Vibe Match
Season Match
Formality Match
Silhouette Balance
Category Compatibility
Pattern Compatibility
```

---

# 254. Score Breakdown

فقط عدد `94` کافی نیست.

کاربر بتواند ببیند چرا:

```text
هماهنگی رنگ      98
هماهنگی استایل   95
فصل              100
فرم لباس          88
تناسب آیتم‌ها     92
```

و توضیح:

```text
شلوار کرم با رنگ صورتی کنتراست ملایم و هماهنگی مناسبی ایجاد می‌کند و هر دو آیتم با استایل Old Money سازگارند.
```

---

# 255. Hybrid Scoring

Style Score فقط روی پاسخ آزاد یک مدل AI بنا نشود.

ترکیب:

```text
Deterministic Rules
+
Product Metadata
+
Color Logic
+
Compatibility Rules
+
AI Analysis
```

باشد.

این باعث می‌شود نتیجه پایدارتر و قابل تست باشد.

---

# 256. Score Versioning

اگر Algorithm بعداً تغییر کرد:

```text
score_version = v1
v2
v3
```

داشته باشیم.

تا بتوانیم بفهمیم یک Score با چه الگوریتمی تولید شده.

---

# 257. Style Recommendation

اگر Outfit Score ضعیف بود:

سیستم فقط نگوید:

```text
این استایل بد است
```

بلکه پیشنهاد بدهد:

```text
این شلوار با این پیراهن هماهنگی متوسطی دارد.

پیشنهاد بهتر:
شلوار کرم روشن
یا
شلوار خاکستری زغالی
```

---

# 258. Complete the Look

Style Builder بتواند برای یک آیتم:

```text
Complete this look
```

ارائه کند.

مثلاً:

```text
Jacket
→ Shirt
→ Trousers
→ Shoes
→ Accessory
```

بر اساس موجودی واقعی محصولات.

---

# 259. Category Compatibility Matrix

منطق Category مهم است.

مثلاً:

```text
Trousers + Trousers = invalid
Shoes + Shoes = invalid
```

ولی:

```text
Shirt + Trousers = valid
Jacket + Shirt = valid
```

Admin بتواند Compatibility Ruleهای Category را مدیریت کند.

---

# 260. Style Builder ↔ WMS

Recommendation نباید Product ناموجود پیشنهاد بدهد.

```text
Style Recommendation
→ WMS Availability
```

Variantهای موجود اولویت داشته باشند.

---

# 261. Style Builder ↔ CRM

برای User Login شده:

```text
Size
Preferred Colors
Past Purchases
Favorite Vibes
Wishlist
Previous Styles
```

بتوانند Recommendation را بهتر کنند.

---

# 262. Style Builder ↔ n8n

Eventها:

```text
product.style_analysis_requested
product.style_analysis_completed
style.created
style.saved
style.shared
style.purchased
```

Automation-friendly باشند.

---

# 263. Style Purchase

کاربر بتواند کل Outfit را یکجا بخرد.

مثلاً:

```text
کت
پیراهن
شلوار
کفش
```

دکمه:

```text
افزودن کل استایل به سبد
```

---

# 264. Style Add-to-Cart Validation

قبل از افزودن Style:

Backend باید بررسی کند:

```text
variant exists
stock available
price current
product active
sales channel valid
```

اگر یکی ناموجود بود:

```text
۳ از ۴ آیتم قابل خرید هستند.
```

و جایگزین پیشنهاد شود.

---

# 265. Style Bundle Price

Style Builder جمع قیمت را نشان دهد:

```text
کت         8,900,000
شلوار      4,200,000
پیراهن     3,800,000

----------------
کل         16,900,000
```

Price فقط از Pricing Engine.

---

# 266. ذخیره Style

کاربر بتواند Outfit را ذخیره کند.

```text
Saved Styles
```

هر Style:

```text
id
name
items
score
createdAt
updatedAt
preview
```

داشته باشد.

---

# 267. Style Version

اگر کاربر یک Outfit ذخیره‌شده را تغییر داد:

بتواند:

```text
Update
Save as new
```

انجام دهد.

---

# 268. خروجی تصویر Style

Style Builder بتواند Canvas نهایی را به تصویر تبدیل کند.

مثلاً:

```text
PNG
JPEG
```

برای:

```text
Download
Share
Save
```

---

# 269. Style Sharing

در آینده:

```text
Share Link
```

اختیاری داشته باشیم.

مثلاً:

```text
/style/ABCD123
```

با Privacy:

```text
Private
Unlisted
Public
```

---

# 270. Quick Buy UX

Quick Buy فعلی باید UX کامل داشته باشد.

کلیک روی:

```text
خرید
```

نباید بدون Feedback باشد.

---

# 271. Add-to-Cart Interaction

بعد از Add:

```text
Button loading
↓
Success animation
↓
Cart count update
↓
Toast
```

مثلاً:

```text
«هودی مشکی به سبد خرید اضافه شد.»
```

---

# 272. Cart Microinteraction

حداقل:

```text
button state
spinner
check animation
cart badge animation
toast
```

داشته باشد.

اگر Error:

```text
این سایز دیگر موجود نیست.
```

واضح نمایش داده شود.

---

# 273. Quick Buy Panel

Quick Buy Card/Drawer:

```text
Product Image
Variant
Color
Size
Stock
Price
Installment
Quantity
Add to Cart
```

داشته باشد.

ظاهر آن با Design System جدید هماهنگ شود.

---

# 274. About Us Page

صفحه «درباره ما» اضافه شود.

اما Hardcoded نباشد.

از CMS ساخته شود.

Componentهای احتمالی:

```text
Story Hero
Brand Story
Timeline
Values
Gallery
Video
Stats
CTA
```

---

# 275. Global Layout CMS

CMS فقط Body صفحات را مدیریت نکند.

بخش:

```text
Global Layout
```

اضافه شود.

شامل:

```text
Header
Footer
Announcement Bar
Navigation
Mobile Navigation
```

---

# 276. Header Builder

Admin بتواند در محدوده Design System تغییر دهد:

```text
Logo
Menus
Menu order
Search
Account
Wishlist
Cart
Announcement
CTA
```

---

# 277. Header Variants

Preset:

```text
Default
Minimal
Transparent
Campaign
Dark
```

قابل انتخاب باشد.

ولی Arbitrary HTML/JS ممنوع.

---

# 278. Mega Menu Manager

Header بتواند Mega Menu داشته باشد.

مثلاً:

```text
مردانه
├── لباس
├── کفش
├── اکسسوری
└── New Arrivals
```

و:

```text
Image
Collection
Vibe
Campaign
```

نیز داخل آن باشد.

---

# 279. Footer Builder

Footer:

```text
Column
Navigation
Contact
Social
Newsletter
Trust badges
Legal
Copyright
```

از CMS قابل تنظیم باشد.

---

# 280. Global Hardcode Reduction

اصل معماری:

```text
Business Logic
→ Code

Site Content / Composition / Theme
→ CMS
```

یعنی:

- Checkout logic در CMS نرود.
- Authentication logic در CMS نرود.
- Pricing logic در CMS نرود.

اما:

```text
Home composition
Landing pages
Header
Footer
Cards
Sections
Campaign layout
```

تا جای ممکن CMS-driven باشند.

---

# 281. Generic Page Builder

Admin بتواند Page جدید ایجاد کند.

مثلاً:

```text
/about
/campaign/black-friday
/valentine
/style-guide
/new-collection
```

و با Component Builder بسازد.

---

# 282. Landing Page Builder

Landing Pageهای ویژه:

```text
Sale
Campaign
Collection
Vibe
Lead Generation
Launch
Event
```

بدون نیاز به تغییر Code ساخته شوند.

---

# 283. Lead Generation Page

Componentهای Lead:

```text
Lead Form
Phone
Email
CTA
Consent
Campaign Source
```

و داده‌ها وارد CRM شوند.

---

# 284. Advanced Product Filtering

فیلتر فعلی باید کامل اصلاح شود.

Filter Engine باید Server-side باشد.

فیلتر بر اساس:

```text
Category
Subcategory
Gender
Season
Vibe
Color
Size
Price
Discount
Brand
Availability
Installment
Rating
Product Type
Attributes
```

---

# 285. Dynamic Attribute Filters

فیلترها از Product Attribute System ساخته شوند.

مثلاً اگر Attribute:

```text
Material
```

با:

```text
filterable = true
```

تعریف شد، خودکار وارد Filter Engine شود.

---

# 286. Multi-filter Combination

مثلاً:

```text
Gender = Men
AND
Season = Winter
AND
Vibe = Old Money
AND
Color = Black
AND
Size = XL
AND
Stock > 0
```

Backend باید Query واقعی اجرا کند.

---

# 287. Filter Count

کنار گزینه‌ها Count واقعی:

```text
مشکی (42)
کرم (18)
سبز (11)
```

نمایش داده شود.

---

# 288. Active Filter Chips

فیلترهای انتخاب‌شده:

```text
Old Money ×
مشکی ×
زمستان ×
XL ×
```

بالای نتایج نمایش داده شوند.

---

# 289. Filter URL State

فیلترها بهتر است در URL قابل بازسازی باشند.

مثلاً:

```text
/products?vibe=old-money&color=black&season=winter
```

برای:

```text
Share
Back/Forward
Analytics
SEO policy
```

---

# 290. Search Engine واقعی

Search Box فعلی باید از سرچ ساده Frontend خارج شود.

یک Search Domain واقعی داشته باشیم.

---

# 291. Searchable Data

Search حداقل روی:

```text
Product name
SKU
Brand
Category
Vibe
Color
Product type
Attributes
Description
```

کار کند.

---

# 292. Search Suggestions

هنگام تایپ:

```text
کف...
```

نمایش:

```text
کفش
کفش چرمی
کفش مردانه
محصولات مرتبط
دسته‌ها
Vibeها
```

---

# 293. Typo Tolerance

مثلاً:

```text
کفص
```

تا حد مناسب:

```text
کفش
```

را پیشنهاد دهد.

---

# 294. Search Ranking

Ranking فقط `%LIKE%` ساده نباشد.

سیگنال‌ها:

```text
text relevance
popularity
availability
conversion
recency
exact match
```

در نظر گرفته شوند.

---

# 295. Search Analytics

ثبت:

```text
Search query
Result count
Click
Conversion
Zero-result
```

برای بهبود Search.

---

# 296. Zero-result Management

Admin بتواند Searchهای:

```text
0 نتیجه
```

را ببیند.

مثلاً:

```text
«کت جیر قهوه‌ای»
```

تا بفهمیم کاربران دنبال چه چیزی هستند.

---

# 297. Search ↔ CRM

برای User Login شده، Search behavior می‌تواند سیگنال CRM/Recommendation باشد.

نه اینکه raw queryهای حساس بی‌دلیل برای همیشه نگهداری شوند؛ Retention Policy مشخص داشته باشد.

---

# 298. Blog Architecture

Blog دو Experience اصلی داشته باشد:

```text
مقالات
ویدیوها
```

در صفحه Blog:

```text
محتوای متنی | محتوای ویدئویی
```

قابل انتخاب باشد.

---

# 299. Text Blog

Article:

```text
Title
Slug
Cover
Excerpt
Content
Author
Category
Tags
SEO
Publish Date
Related Products
Related Articles
```

از CMS.

---

# 300. Video Blog

Video Content:

```text
Title
Description
Thumbnail
Video Source
Duration
Category
Tags
Author
Publish Date
SEO
Related Products
```

---

# 301. Video Sources

Video بتواند از:

```text
YouTube
Direct Upload
External URL
Future video provider
```

بیاید.

برای YouTube:

```text
URL
Video ID
Thumbnail
```

ذخیره شود.

---

# 302. Video Thumbnail

Admin بتواند:

```text
Auto thumbnail
Custom thumbnail
```

انتخاب کند.

---

# 303. Video Blog SEO

هر Video Page:

```text
SEO title
description
thumbnail
publish date
duration
video URL
```

داشته باشد.

و در صورت امکان Structured Data مناسب Video تولید شود.

---

# 304. Video Categories

مثلاً:

```text
آموزشی
استایل
معرفی محصول
پشت صحنه
راهنمای خرید
```

---

# 305. Media Index

Media Library باید:

```text
Image
Video
PDF
```

را Index کند.

Search:

```text
name
tag
product
usage
date
type
```

---

# 306. Product Video

هر Product بتواند علاوه بر تصاویر چند Video داشته باشد.

مثلاً:

```text
Product Showcase
360 View
On-model Video
Detail Video
Size Guide Video
```

---

# 307. Product Video Gallery

Product Detail:

```text
Images
+
Videos
```

یک Gallery واحد داشته باشد.

---

# 308. Variant Media

در صورت نیاز:

```text
Black Variant
→ Black images/video

Cream Variant
→ Cream images/video
```

قابل تعریف باشد.

---

# 309. Video Storage Architecture

برای Upload مستقیم Video از Object Storage استفاده شود.

معماری آماده:

```text
App
↓
Signed Upload
↓
S3-compatible Object Storage
```

یا Provider سازگار.

اگر منظورت از «OTR» همان R2/Object Storage بوده، معماری باید با:

```text
S3-compatible
Cloudflare R2
یا Provider مشابه
```

قابل استفاده باشد.

---

# 310. عدم عبور Video از Backend Memory

Video بزرگ نباید:

```text
Browser
→ Backend RAM
→ Storage
```

عبور کند.

بهتر:

```text
Browser
→ Signed Upload URL
→ Object Storage
```

و Backend فقط Metadata را نگهداری کند.

---

# 311. Video Processing

در صورت نیاز:

```text
Upload
↓
Processing
↓
Thumbnail
↓
Multiple qualities
↓
Streaming
```

و در آینده HLS/DASH قابل اضافه‌شدن باشد.

---

# 312. CDN-ready Media

تمام Media Architecture:

```text
Image
Video
PDF
Style exports
```

باید CDN-ready باشد.

---

# 313. Responsive Product Video

Frontend:

```text
Poster
Lazy loading
Adaptive size
Muted preview optional
Controls
```

و Performance را خراب نکند.

---

# 314. Video Analytics

برای Video Blog/Product در صورت نیاز:

```text
play
25%
50%
75%
complete
```

Event داشته باشیم.

به Analytics/CRM قابل اتصال باشد.

---

# 315. Style Builder Media Source

Style Builder باید Flat-lay مناسب هر Variant را از Product Media Domain دریافت کند.

نه اینکه Image جداگانه Local نگهداری کند.

مثلاً:

```text
Variant
→ Flat-lay media
→ Style Builder
```

---

# 316. Product Media Roles

برای هر Media:

```text
role:
hero
gallery
flat_lay
on_model
detail
size_guide
video
```

تعریف شود.

---

# 317. Automation Media Pipeline

بعد از Upload:

```text
media.uploaded
↓
Automation
↓
Background Removal
↓
Metadata Analysis
↓
Style Analysis
↓
Derivative Generation
```

در صورت فعال بودن Workflow.

---

# 318. Saved Style ↔ CRM

Style ذخیره‌شده نیز می‌تواند Signal باشد.

مثلاً کاربر چند Style با:

```text
Dark Academia
```

ذخیره کرده.

CRM/Recommendation می‌تواند Preference احتمالی را تقویت کند.

اما این Preference باید:

```text
derived
```

باشد، نه اینکه به‌عنوان Fact قطعی درباره کاربر ثبت شود.

---

# 319. Commerce Search / Filter / Recommendation Source of Truth

هر سه سیستم:

```text
Search
Filter
Recommendation
```

باید از Product Catalog Canonical استفاده کنند.

نه سه Index با Business Data متناقض.

Index Search می‌تواند مشتق باشد، اما Product/Price/Availability Source of Truth:

```text
Catalog
Pricing
WMS
```

بماند.

---

# 320. Storefront State Feedback

هر Action مهم UI Feedback داشته باشد:

```text
Add to cart
Remove
Wishlist
Save style
Apply coupon
Select installment
Submit review
```

حداقل:

```text
loading
success
error
```

و Actionهای مهم Microinteraction مناسب داشته باشند.

---

# 321. Accessibility

Toast، Drawer، Search Suggestions، Filter و Quick Buy:

```text
Keyboard
Focus
ARIA
Screen Reader
Reduced Motion
```

را رعایت کنند.

---

# 322. Homepage / Storefront CMS Rule

صفحات عمومی مهم تا حد ممکن Compose‌شده از CMS باشند:

```text
Home
About
Landing
Campaign
Vibe
Collection
Blog index
```

اما Domain Logic کدنویسی‌شده باقی بماند.

---

# 323. Header/Footer Safety

Customization Header/Footer باید محدود به:

```text
registered components
design tokens
allowed layouts
```

باشد.

نه:

```text
arbitrary HTML
arbitrary JS
```

تا Admin نتواند ناخواسته Navigation یا Checkout Flow را خراب کند.

---

# 324. Storefront Definition of Done

این بخش زمانی کامل است که:

```text
Gender filters work
Multi-season products work
Advanced filters work
Search is server-backed
Vibe filtering works
Quick-buy feedback works
Style scoring works
Style recommendations work
Styles can be saved
Styles can be purchased
Styles can be exported as image
Product ratings/reviews work
About page is CMS-driven
Header/footer are configurable
Landing pages can be created
Text/video blog works
Product videos work
Media is object-storage ready
```

---

یک اصل مهم هم اینجا نهایی می‌شود:

```text
Catalog + Pricing + WMS
        ↓
 Search / Filters
        ↓
Recommendation
        ↓
 Style Intelligence
        ↓
      CMS/UI
```

یعنی **Style Builder و Recommendation نباید دیتای محصول، قیمت یا موجودی مخصوص خودشان بسازند**. همه آن‌ها باید روی همان Product/Variant/WMS/Pricing واقعی سوار شوند. این دقیقاً جلوی همان مشکلی را می‌گیرد که بعداً یک کالا در Product Studio موجود باشد ولی Style Builder یا Search اطلاعات متفاوتی از آن نشان بدهد.



آره، این بخش هم روشنه. منظور قسمت اولت رو این‌طور ثبت می‌کنم: **همان سیستم فیلدها/Attribute Templateهایی که تعریف کردیم باید مستقیماً داخل فرم تعریف محصول ظاهر شوند**؛ یعنی کاربر موقع ساخت محصول همان‌جا اطلاعات را پر کند و مجبور نباشد وارد چند صفحه جدا شود.

## 325. فرم محصول مبتنی بر Template

وقتی Product Type انتخاب می‌شود:

```text
نوع محصول: کاپشن
```

سیستم خودش Template مربوط به آن را Load کند:

```text
جنس:
فرم:
فصل:
جنس آستر:
ضد آب:
وزن:
راهنمای سایز:
...
```

یعنی:

```text
Product Type
↓
Specification Template
↓
Generated Product Form
```

Admin یا Supplier فقط Valueها را وارد کند.

تعریف Schema یک‌بار انجام شود؛ استفاده از آن ساده و چندبارمصرف باشد.

---

## 326. فرم محصول Adaptive باشد

مثلاً اگر:

```text
Product Type = کفش
```

فیلدهای کفش ظاهر شوند.

اگر:

```text
Product Type = کاپشن
```

فیلدهای کاپشن.

اگر Admin Product Type جدید ساخت، بدون تغییر Frontend بتوان برای آن Template جدید تعریف کرد.

---

# 327. Announcement Bar بالای Header

نوار بالای Header باید کاملاً از CMS قابل مدیریت باشد.

مثلاً:

```text
ارسال رایگان برای خریدهای بالای ۳ میلیون تومان
```

یا:

```text
تخفیف ویژه Black Friday تا پایان امشب
```

---

# 328. Announcement Bar متحرک

حالت‌های مختلف:

```text
Static
Marquee
Ticker
Slider
Rotating Messages
```

مثلاً چند پیام:

```text
ارسال رایگان
●
خرید چهارقسطی
●
تخفیف ویژه
●
کالکشن جدید
```

به‌صورت متحرک نمایش داده شوند.

---

# 329. Customization کامل Announcement Bar

Admin بتواند تنظیم کند:

```text
متن
لینک
رنگ پس‌زمینه
رنگ متن
فونت
سرعت حرکت
جهت حرکت
ارتفاع
آیکون
CTA
بستن توسط کاربر
```

و Responsive باشد.

---

# 330. اتصال Announcement Bar به Campaign

Announcement فقط متن دستی نباشد.

بتواند به:

```text
Campaign
Promotion
Coupon
Collection
Landing Page
```

Bind شود.

مثلاً:

```text
Black Friday Campaign
↓
Announcement
↓
Countdown / CTA
```

---

# 331. زمان‌بندی Announcement

مثلاً:

```text
شروع:
شنبه ساعت 00:00

پایان:
دوشنبه ساعت 23:59
```

بعد خودکار فعال/غیرفعال شود.

---

# 332. چند Announcement

Admin بتواند چند مورد تعریف کند:

```text
Announcement A
Announcement B
Announcement C
```

و مشخص کند:

```text
priority
schedule
active
```

---

# 333. پروفایل کامل تمام کاربران

برای:

```text
Customer
VIP
Wholesale Buyer
Supplier
Admin
```

یک Profile Domain واحد داشته باشیم ولی Policy هر Role متفاوت باشد.

---

# 334. تصویر پروفایل

تمام کاربران بتوانند Avatar/Profile Picture داشته باشند.

Flow:

```text
Upload
↓
Validation
↓
Resize
↓
Storage
↓
Profile
```

حداقل:

```text
JPG
PNG
WebP
```

با محدودیت Size و MIME.

---

# 335. ویرایش پروفایل مشتری عادی

Customer بتواند خودش تغییر دهد:

```text
نام
نام خانوادگی
تاریخ تولد
تصویر پروفایل
آدرس‌ها
شهر
کد پستی
```

---

# 336. تغییر Email و Mobile

فیلد حساس مستقیم تغییر نکند.

Mobile:

```text
شماره جدید
→ OTP
→ Confirm
→ Update
```

Email:

```text
ایمیل جدید
→ Verification
→ Confirm
→ Update
```

---

# 337. تغییر رمز عبور

Flow استاندارد:

```text
Current Password
New Password
Confirm Password
```

در صورت Login مبتنی بر OTP نیز مسیر مناسب بازیابی/تنظیم Password داشته باشیم.

---

# 338. پروفایل VIP

VIP همان قابلیت‌های Customer را داشته باشد و علاوه بر آن:

```text
Plan
Membership
Benefits
Credit
Wholesale access
Invoices
```

را ببیند.

تغییر اطلاعات شخصی معمول همچنان Self-service باشد.

---

# 339. پروفایل Supplier با Approval Policy

برای Supplier بعضی اطلاعات آزادانه قابل تغییر باشند:

```text
Avatar
Bio
Public description
Contact person
```

ولی اطلاعات مهم:

```text
نام حقوقی
شناسه ملی
شماره ثبت
شماره شبا
حساب بانکی
مدارک
اطلاعات مالیاتی
```

بعد از تغییر:

```text
Supplier submits change
↓
Pending Review
↓
Admin approves/rejects
↓
New version activated
```

---

# 340. Supplier Profile Versioning

اطلاعات حساس Supplier نباید مستقیم overwrite شوند.

مثلاً:

```text
Current Version
Proposed Version
```

Admin Diff ببیند:

```text
شماره شبا:
Old → New
```

بعد تأیید کند.

---

# 341. Profile Audit

تغییرات حساس:

```text
نام
Email
Phone
Bank
Legal info
```

Audit شوند.

```text
actor
oldValue
newValue
timestamp
verification
```

---

# 342. داشبورد مشتری عادی بازطراحی شود

Dashboard فعلی Customer باید از حالت ساده خارج شود.

صفحه اصلی حساب کاربری Dashboard واقعی داشته باشد.

---

# 343. Customer Dashboard Overview

بالا:

```text
سلام، یاشار
```

و Summary Cards:

```text
سفارش‌های فعال
سفارش‌های تحویل‌شده
علاقه‌مندی‌ها
سبد ذخیره‌شده
کوپن‌های من
امتیاز / سطح مشتری
```

---

# 344. سفارش فعال

اگر Order فعال وجود داشت:

```text
سفارش KV-...
آماده‌سازی
```

با Timeline:

```text
ثبت سفارش
↓
پرداخت
↓
آماده‌سازی
↓
ارسال
↓
تحویل
```

و Tracking Code.

---

# 345. Quick Actions

Dashboard:

```text
پیگیری سفارش
مشاهده فاکتورها
ویرایش پروفایل
مدیریت آدرس‌ها
علاقه‌مندی‌ها
استایل‌های ذخیره‌شده
ثبت تیکت
```

---

# 346. Personalization در Dashboard

برای User Login شده:

```text
پیشنهاد برای شما
آخرین بازدیدها
دوباره بخرید
استایل‌های پیشنهادی
محصولات علاقه‌مندی
```

از Recommendation Engine.

---

# 347. Coupon Wallet

قسمت:

```text
کوپن‌های من
```

داشته باشد.

مثلاً:

```text
تخفیف تولد
10%
تا 1405/08/20
```

یا:

```text
مشتری وفادار
15%
```

CRM Automation مستقیماً Couponهای شخصی را اینجا قرار دهد.

---

# 348. Saved Styles

Customer Dashboard به Style Builder وصل شود:

```text
استایل‌های ذخیره‌شده
```

با:

```text
Preview
Edit
Buy
Download
Delete
```

---

# 349. Review Center

مشتری بتواند ببیند:

```text
محصولاتی که می‌توانم نظر بدهم
نظرات ثبت‌شده
امتیازهای من
```

---

# 350. Invoice Center

تمام:

```text
فاکتورهای خرید
Refund documents
```

از همان Invoice Domain در Dashboard قابل دریافت باشند.

---

# 351. Account Security

بخش جدا:

```text
امنیت حساب
```

شامل:

```text
تغییر رمز
2FA
نشست‌های فعال
Login history
خروج از همه دستگاه‌ها
```

---

# 352. Customer Timeline

در آینده خود کاربر نیز نسخه مناسب Timeline خودش را ببیند:

```text
سفارش ثبت شد
پرداخت شد
کوپن دریافت کردید
مرسوله ارسال شد
Review ثبت کردید
```

اما Audit داخلی Admin نمایش داده نشود.

---

# 353. Mobile-first Account

Customer Dashboard باید مخصوصاً روی موبایل طراحی خوبی داشته باشد.

چون بخش بزرگی از:

```text
Tracking
Profile
Coupon
Wishlist
Orders
```

روی موبایل استفاده می‌شود.

---

# 354. CMS-driven Account Appearance

Business Logic حساب کاربری کدنویسی‌شده بماند، اما ظاهر بخش‌هایی مثل:

```text
Welcome banner
Promotional area
Recommendation sections
Help cards
```

از CMS قابل مدیریت باشند.

---

# 355. اصل Profile Architecture

ساختار:

```text
User
↓
Profile
↓
Role-specific Profile
├── Customer
├── VIP
└── Supplier
```

نه اینکه برای هر پنل اطلاعات کاربر مستقل ذخیره کنیم.

---

# 356. اصل ادامه توسعه

این Requirementها قرار نیست یکجا و کورکورانه پیاده شوند.

بعد از بسته‌شدن Foundation فعلی، آن‌ها را **مرحله‌به‌مرحله و Domain-by-Domain** اضافه می‌کنیم:

```text
Domain
↓
Backend
↓
API
↓
Frontend
↓
Tests
↓
Browser Verification
↓
Commit
```

و بعد وارد مرحله بعد می‌شویم.

این‌طوری به‌جای اینکه Arena یک دفعه ۱۰۰ قابلیت نصفه بسازد، هر بخش را کامل و قابل تست تحویل می‌گیریم.