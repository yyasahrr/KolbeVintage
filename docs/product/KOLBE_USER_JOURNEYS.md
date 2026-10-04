# سفرهای اصلی کاربران و اپراتورها

Agent باید Journey را از ابتدا تا انتها تست کند؛ نه فقط Page را.

---

# 1. Admin — شروع روز

## Goal
فهمیدن اینکه امروز چه چیزهایی نیاز به اقدام دارند.

```text
Login
→ Overview/Control Tower
→ Pending queues
→ Open highest-priority queue
→ Resolve item
→ Return to overview
```

Overview باید حداقل Context عملیاتی مهم را نشان دهد:

- سفارش نیازمند اقدام
- مرجوعی باز
- QC
- Supplier action
- Product setup
- Low stock
- Ticket
- Payment/refund exception

---

# 2. Admin — تعریف محصول

```text
Products
→ New Product
→ Identity
→ Category
→ Variants
→ Technical Specs
→ Size Guide
→ Media
→ Base Pricing
→ Installment Pricing
→ Wholesale commercial definition (if applicable)
→ SEO
→ Review
→ Save
```

پس از Save:

```text
Product created
→ inventory_setup = pending
→ Next Action = راه‌اندازی موجودی در WMS
```

نباید Stock خودکار ساخته شود.

---

# 3. Admin — Technical Specs

```text
Product
→ مشخصات فنی
→ Add key/value
→ Edit
→ Reorder
→ Save
```

مثال:

```text
جنس → پنبه
کشور سازنده → ترکیه
نوع بافت → دورس
```

---

# 4. Admin — Size Guide

```text
Product
→ راهنمای سایز
→ Choose template OR create custom table
→ Add dynamic columns
→ Add size rows
→ Fill values
→ Reorder
→ Save
```

مثال T-shirt:

```text
سایز | دور سینه | قد | سرشانه | آستین
M    | 104      | 70 | 46      | 22
L    | 108      | 72 | 48      | 23
```

---

# 5. Admin — Pricing

```text
Product
→ Pricing
→ Base price
→ 4-installment price
→ Variant discount matrix
→ Optional festival assignment
→ Review effective pricing
→ Save
```

ماتریس باید Color×Size را نمایش دهد.

---

# 6. Admin — Bulk Festival

```text
All Products
→ Select multiple products
→ Bulk Actions
→ Add to Festival
→ Festival chooser modal
→ Confirm
→ Result summary
```

برای هر Product:

- Normal discount دیگر Effective نیست.
- History حفظ می‌شود.
- Festival rule مرجع Effective Price می‌شود.

---

# 7. Warehouse — Inventory Setup

```text
Needs Setup
→ Choose product/variant
→ Receive / official setup document
→ Warehouse/location
→ Quantity
→ Confirm
→ Ledger updated
```

---

# 8. Warehouse — Supplier Inbound

```text
Expected inbound
→ Receive shipment
→ Compare expected/received
→ QC
→ Accept / Damage / Reject
→ Put into wholesale inventory
→ Ready for VIP allocation
```

---

# 9. Warehouse — Transfer

```text
Create transfer
→ Source
→ Destination
→ Select items
→ Quantities
→ Approve
→ Dispatch
→ Receive
→ Resolve discrepancy if any
→ Close
```

Agent باید Partial/Exception را نیز شبیه‌سازی کند.

---

# 10. Supplier — Joining

```text
Application
→ Admin review
→ Approve/Reject
→ Supplier account
→ Supplier 360
→ Products/Offers
→ Inbound
→ QC
→ Performance
→ Settlement
```

---

# 11. VIP Buyer — Wholesale purchase

```text
Login
→ Membership entitlement check
→ Wholesale market
→ Product/Offer
→ Wholesale order
→ Kolbe warehouse allocation
→ Consolidation
→ Dispatch
→ Delivery
```

نباید Supplier PII نمایش داده شود.

---

# 12. Retail Customer — Purchase

```text
Browse
→ Product
→ Variant
→ Cart
→ Promotion/Coupon
→ Optional Cashback redemption
→ Shipping
→ Payment
→ Order
→ Fulfillment
→ Delivery
```

---

# 13. Retail Customer — Cashback

```text
Paid Order
→ Cashback Pending
→ Delivered + Release Delay
→ Cashback Available
→ Next Checkout
→ Redeem
→ Ledger entry
```

---

# 14. Retail Customer — Return

```text
Order
→ Return request
→ Admin review
→ Approved
→ Shipment/receive
→ Inspection
→ Restock or Damage
→ Refund
→ Cashback reconciliation
→ Closed
```

---

# 15. CRM Operator — Customer follow-up

```text
Customer list
→ Customer 360
→ Purchase history
→ Returns
→ Wallet
→ Support
→ Consent
→ Notes / Timeline
→ Decide next action
```

Customer 360 نباید فقط یک Profile dump باشد؛ باید Context تصمیم‌گیری بدهد.

---

# 16. Finance — Daily operations

```text
Finance Hub
→ Payments
→ Refunds
→ Supplier settlements
→ Statements
→ Holds/Exceptions
→ Cashback liability
→ Reconcile
```

---

# 17. Support — Ticket

```text
Ticket queue
→ Open ticket
→ Customer context
→ Related order/return
→ Reply/resolve/escalate
→ Close
```

تنظیمات SMS provider در این Journey نیست؛ متعلق به System/Integrations است.
