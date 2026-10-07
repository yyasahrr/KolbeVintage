# سناریوهای واقعی و Counterexample Library

هدف این فایل شکستن implementationهای ظاهراً سالم ولی ناقص است.

Agent باید برای هر Domain حداقل یک سناریوی ساده و یک سناریوی مرزی اجرا کند.

---

# A. Product / Size Guide

## SCN-SIZE-001 — T-Shirt

Product:
- T-shirt
- Colors: Black, White
- Sizes: M, L, XL

Guide:

| Size | Chest | Length | Shoulder | Sleeve |
|---|---:|---:|---:|---:|
| M | 104 | 70 | 46 | 22 |
| L | 108 | 72 | 48 | 23 |
| XL | 112 | 74 | 50 | 24 |

Expected:
سیستم بدون Hardcode بتواند این جدول را بسازد.

## SCN-SIZE-002 — Pants

| Size | Waist | Hip | Length | Rise | Leg Opening |
|---|---:|---:|---:|---:|---:|
| 32 | 82 | 100 | 102 | 27 | 18 |
| 34 | 87 | 105 | 103 | 28 | 19 |

اگر «دمپا» یا «فاق» قابل افزودن نباشد → `DOMAIN_DEFECT`.

## SCN-SIZE-003 — Shoes

| EU Size | Foot Length | Insole Length |
|---|---:|---:|
| 42 | 27.0 | 27.5 |
| 43 | 27.6 | 28.1 |

## SCN-SIZE-004 — Ring

| Ring Size | Inner Diameter | Circumference |
|---|---:|---:|
| 7 | 17.3 | 54.4 |
| 8 | 18.1 | 56.9 |

نتیجه: Size Guide نباید apparel-only باشد.

---

# B. Technical Specs

## SCN-SPEC-001

برای یک T-shirt:

```text
جنس = 100% Cotton
نوع بافت = دورس
یقه = گرد
کشور تولید = ترکیه
```

Expected:
Key/Value dynamic.

---

# C. Variants / Pricing

## SCN-PRICE-001 — Matrix

Colors:
- Black
- White

Sizes:
- M
- L
- XL

Rules:
- Black/M = no discount
- Black/L = 10%
- Black/XL = 200,000 تومان fixed
- White/L = 15%

Expected:
هر cell بتواند independent rule داشته باشد.

---

# D. Festival

## SCN-FEST-001

Product قبل از Festival:
- Black/L = 10%
- White/L = 15%

Festival:
- 25% on whole product

Expected:
- Festival effective
- old variant discounts no longer effective
- old rules preserved in history as superseded/inactive
- UI explicitly shows source = Festival

## SCN-FEST-002 — Bulk

Select 30 products.
Add to Festival.
Expected:
- chooser
- confirm
- server result summary
- partial failure surfaced per item
- no silent success

---

# E. WMS Transfer

## SCN-WMS-001 — Normal

Warehouse A:
20 units

Transfer:
10 A→B

Expected:
- document
- dispatch
- receive
- history
- final balances correct

## SCN-WMS-002 — Discrepancy

Send 20.
Receive:
- 18 sellable
- 2 damaged

Expected:
سیستم discrepancy را مدل کند، نه اینکه صرفاً 20 را منتقل‌شده فرض کند.

## SCN-WMS-003 — Domain boundary

Retail stock → Wholesale stock

Expected:
official domain-aware transfer only.

---

# F. Supplier

## SCN-SUP-001

Supplier approved.
Sends 100 units.
QC:
- 90 accepted
- 5 damaged
- 5 rejected

Expected:
Supplier 360 + WMS + finance context coherent.

## SCN-SUP-002 — Privacy

Supplier views wholesale order.

Expected:
No VIP private address/phone/email beyond explicitly permitted masked/public fields.

---

# G. VIP

## SCN-VIP-001

Retail customer without membership tries wholesale.

Expected:
blocked with clear upgrade/plan path.

## SCN-VIP-002

Membership expires.

Expected:
wholesale entitlement removed based on membership state, not cached label.

---

# H. Retail Order

## SCN-ORD-001

Product:
4,690,000 Toman

Wallet:
100,000 Toman

Expected:
- server quote
- wallet row
- final total 4,590,000 before other applicable shipping differences
- order snapshot records redeemed amount

---

# I. Cashback

## SCN-CB-001 — Earn

Eligible order paid/delivered.

Expected:
pending → available after release rule.

## SCN-CB-002 — Double submit

Same redemption submitted twice.

Expected:
one economic effect.

## SCN-CB-003 — Over cap

Customer requests more than server cap.

Expected:
server rejects with business-friendly error.

## SCN-CB-004 — Refund

Order used wallet and earned cashback.

Refund:
- redeemed amount restored proportionally
- earned cashback reversed/clawed back
- idempotent replay causes no second effect

---

# J. Return

## SCN-RET-001

Customer returns one item from multi-line order.

Expected:
- line-aware return
- inspection result
- stock outcome
- proportional refund
- cashback reconciliation

---

# K. CRM

## SCN-CRM-001

Customer has:
- 8 orders
- 2 returns
- wallet balance
- marketing opt-out
- 1 open ticket

Expected:
Customer 360 makes these facts discoverable without navigating six unrelated pages.

---

# L. UI Consistency

## SCN-UI-001 — SearchBox

Collect search boxes across:
- Products
- CRM
- Orders
- WMS
- Suppliers

Compare:
- height
- padding
- icon placement
- radius
- focus
- clear action
- mobile width

If they are materially inconsistent → `UX_DEFECT`.

## SCN-UI-002 — Responsive

At 360px:
- no document-level horizontal overflow
- primary actions reachable
- tables have intentional scroll cue
- modal fits viewport
- no clipped text/action

---

# M. Counterexample rule

برای هر feature مهم Agent باید بپرسد:

> چه دادهٔ واقعی یا سناریویی می‌تواند این طراحی را بشکند؟

اگر یک Feature فقط Happy Path ساده را پوشش دهد، PASS کامل نیست.
