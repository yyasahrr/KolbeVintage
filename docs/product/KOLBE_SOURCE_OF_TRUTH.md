# نقشهٔ Source of Truth

این فایل برای جلوگیری از Parallel System و Duplicate Authority است.

| Concept | Canonical Authority | Read Surfaces | Write Surfaces | ممنوع |
|---|---|---|---|---|
| Category | یک Category/Structure canonical | Product Studio, Storefront, Filters | Catalog Structure Admin | Product Type مستقل موازی |
| Product Definition | Catalog/Product domain | Product 360, Storefront | Product Studio | WMS writing product definition |
| Variants | Product/Catalog variant records | Product, Pricing, WMS | Product Studio | Variant shadow model در frontend |
| Technical Specs | Product spec model/template | Product 360/Storefront | Specs editor | schema hardcoded per UI page |
| Size Guide | Dynamic table/template model | Product/Storefront | Size Guide editor | Key/Value-only model |
| Retail Inventory | WMS/Inventory ledger, retail domain | Product summary, WMS, Orders | WMS ops | direct product edit stock |
| Wholesale Inventory | WMS/Inventory ledger, wholesale domain | WMS/VIP | WMS ops | merge با retail balance |
| Transfer | WMS transfer document/ledger | WMS/history | WMS transfer flow | ad-hoc balance edit |
| VIP Entitlement | Membership/Plan state | VIP market, CRM | Membership admin | role heuristic |
| Supplier Status | Supplier domain | Supplier 360, Wholesale hub | Supplier admin | duplicate status store |
| Base Price | Canonical pricing/product commercial data | Product/Pricing/Storefront | Pricing workspace | compare-price as truth |
| Effective Price | Server-side pricing resolver | Storefront/Admin preview | Promotion/Pricing rule inputs | client-only resolver as truth |
| Promotion | Canonical promotion rule store | Pricing, Growth, Storefront | Promotion workspace | duplicate festival engine |
| Festival | Promotion campaign context | Pricing/All Products | Festival management | independent price engine |
| Coupon | Coupon/code benefit store | Checkout/Admin | Coupon workspace | conflation with festival |
| Cashback Balance | Cashback ledger | Account, Customer 360, Finance | ledger events/rules | direct mutable balance |
| Order | Order domain | Admin/Customer/CRM | Order lifecycle APIs | local-only order truth |
| Return | Return domain | Support/Order/Customer | Return workflow | ticket-only return tracking |
| Customer Profile | Customer/Buyer360 domain | Customer 360 | CRM-approved actions | generic duplicate profile |
| Marketing Consent | Persisted consent/audit | CRM | Consent action | transient UI state |
| Finance | Finance ledger/domain | Finance Hub | Finance workflows | UI-calculated accounting truth |
| Audit | audit_logs / immutable audit mechanism | Admin Audit | system actions | overwrite/delete normal history |

---

# Source-of-Truth Rule

اگر Agent دو implementation برای یک Concept پیدا کرد:

1. Consumerها را trace کند.
2. Writerها را trace کند.
3. Migration/schema را trace کند.
4. Canonical authority را با این فایل مقایسه کند.
5. UI موازی را Merge/Redirect/Remove کند.
6. Data migration فقط با backward-safe strategy.
7. بدون تحلیل dependency هیچ backend table را حذف نکند.

---

# Category special rule

هدف نهایی:

```text
ONE Category Model
```

اگر legacy `product_type`, `category_profile` یا مشابه وجود دارد:

- یا به Category canonical map شود،
- یا migration/adaptor باشد،
- اما نباید User-facing Source of Truth دوم ایجاد کند.

---

# Pricing special rule

```text
Base/Installment Data
        +
Promotion Rules
        ↓
Server Effective Price Resolver
        ↓
Admin Preview / Storefront / Order Snapshot
```

Order باید قیمت مؤثر را snapshot کند تا تاریخچه تغییر نکند.

---

# Cashback special rule

```text
cashback_transactions
        ↓ SUM
Pending / Available / Used / Expired
```

هیچ `wallet.balance = X` direct edit مجاز نیست.

---

# WMS special rule

```text
Physical Event
→ Document/Movement
→ Ledger/Balance
→ Read Model
```

UI نباید balance را بدون سند عملیاتی تغییر دهد.
