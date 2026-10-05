# PROMPT 2 — PRODUCT PRICING: canonical price model, resolution, history, order snapshots & UX

Final report of Prompt 2 (of 8). Prompt 1 (unified Product Studio) was accepted; Prompt 2 builds on
it and does **not** touch Prompts 3–8.

---

## 1. Repository state (as reported before implementation started)

| Item | Value |
| --- | --- |
| Session branch (all work committed here) | `arena/01a10ace-kolbevintage` |
| Baseline (Prompt-1 close) | `c0825bf` — `c0825bf87eeedefb9b9d8755544905704f0a42e6` |
| HEAD after Prompt 2 | `9e33a82` (pushed; local == remote) — see §12 for the commit table |
| Merge-base with `origin/main` | `3cd9dace97e00e3131af018fb5b696f8c18d67fc` (`main` untouched) |
| Working tree | clean (no `dist/`, `node_modules/`, `.scratch/` or browser artifacts committed) |

**Branch note (transparency):** a fresh `prompt2/product-pricing` branch was created from `c0825bf`
as the prompt requires, but this Arena session is hard-bound to `arena/01a10ace-kolbevintage`
(work on any other branch is not tracked by the session). The temporary branch was therefore deleted
again and every Prompt-2 commit lives on `arena/01a10ace-kolbevintage`, which is a legitimate
descendant of `c0825bf`; `main` was never merged into and never pushed.

---

## 2. The ONE canonical price model (no parallel system)

Reused, never duplicated: `promotions.ts` already owned the promotion resolver, `catalog.ts` the
product columns, `orders.ts` the order pipeline, `series.ts`/`070_series_commercial_pricing.sql` the
Series commercial pricing, and `operations.audit()` the audit trail.

| Price | Authority (single writer) | Read by |
| --- | --- | --- |
| Retail cash base «قیمت نقدی پایه» | `products.cash_price_rial` (variant override: `product_variants.price_override_rial`) | the resolver → catalog/storefront/cart/checkout/order/resolver API |
| Four-installment base «قیمت پایه چهارقسطه» | `products.installment_price_rial` — **explicit, never derived** | the resolver (installment path) |
| Installment enable + discount policy | `products.installment_enabled`, `products.installment_policy` (+ derived `allow_installments`, `disable_installments_on_discount`) | the resolver, order gates, Studio/360/hub |
| Wholesale unit price | `products.wholesale_price_rial` | the resolver (wholesale path) |
| Wholesale Series price | `series_templates` (`pricing_mode` = `series_total` \| `component_sum`, `total_price_rial`, `series_template_items.unit_price_rial`) | `allocateSeriesPrice()` → resolve API + order lines |
| Discount / festival | `promotions` + `promotion_rules` (existing engine) | the resolver |
| Crossed-out price | derived by the resolver from the resolved base when a discount applies (`compareAtPriceRial`) — **the manual/legacy compare-at authority is retired** | storefront/cards/360 |
| Final price | computed by the resolver in the same request/transaction that needs it | never stored as independent truth on the product |

No `ProductPricingV2`/`PricingV2`, no second resolver, no second price table, no metadata price
authority, no frontend-only final price: every surface either **calls the resolver** or **renders the
resolver's numbers**.

### Resolver contract (`backend/src/promotions.ts`)
`resolveVariantPricing` (single) and `resolveVariantPricesBatch` (Map, two queries) return the same
shape for retail/wholesale × cash/installments:

```
{ variantId, productId, sku, size, color, channel, paymentMode,
  basePrice, cashBasePriceRial, installmentBasePriceRial, installmentEnabled,
  installmentDiscountAllowed, installmentDiscountBlocked, installmentPolicy,
  matchedRule{ id, promotionId, name, targetType, productId, colorId, sizeCode, variantId, priority } | null,
  discountType, discountValue, discountAmount, finalPrice,
  compareAtPriceRial, startsAt, endsAt, source: 'promotion_rule' | 'festival' | 'none' }
```

* retail cash: `price_override_rial` → `cash_price_rial`; `0`/missing ⇒ explicit business error.
* four-installment: installments off ⇒ `خرید چهارقسطه برای SKU … فعال نیست.` (409) · no explicit base
  ⇒ `قیمت پایه چهارقسطه برای SKU … تعریف نشده است.` (400). **The cash price is never used as an
  installment base.**
* policy: `enabled` · `disabled` · `enabled_when_discounted` · `disabled_when_discounted`
  (`installment_policy` is the single column; the two legacy booleans are derived from it).
  When the policy forbids a discount on installments the resolver reports
  `installmentDiscountBlocked: true` and the order pipeline refuses that purchase instead of guessing.
* wholesale: `wholesale_price_rial` (or the Series allocation handed in by the order pipeline);
  missing ⇒ `قیمت عمده برای SKU … تعریف نشده است.` — **never a silent retail fallback**.
* festival: a running Festival is exclusive — ordinary rules are suspended, not deleted, and are
  **not** auto-reactivated when it ends (DEC-PRICING-001); only an explicit reactivation revives them.
* rounding: integer رial everywhere; percentage discounts are `floor(base × pct / 100)`, amounts are
  clamped to the base (never negative), so the frontend preview and the server always agree.

### Wholesale Series pricing
Per Series exactly ONE explicit mode: `series_total` («قیمت کل سری») or `component_sum`
(«محاسبه قیمت از اجزای سری», requires a unit price for every component; otherwise a Persian 400).
`allocateSeriesPrice()` is deterministic and integer-exact (the allocated unit prices always sum back
to the series total). `POST /api/v1/pricing/resolve` accepts
`series: [{ seriesTemplateId, count }]` for wholesale requests only and answers the server-computed
`totalPriceRial` + `piecesPerSeries` + allocated unit prices; a retail request carrying a Series and an
unknown/inactive Series are both explicit 400s. Legacy `legacy_product` Series are refused.

### §31 zero price (documented decision, not a silent reinterpretation)
A stored base of `0` is treated as **«قیمت تعیین نشده»**: the resolver answers a Persian business error
(`قیمت نقدی پایه … تعریف نشده است.`) instead of selling at zero; the order pipeline therefore never
creates a zero-amount order. Products may legitimately keep a `0` cash column while selling only
wholesale (sales mode off for retail) — that path is covered by tests. If the business later wants
genuinely free products this decision must be revisited explicitly (no code path supports a free
checkout today).

---

## 3. Sales mode & Studio step 5 (canonical pricing UX)

* Sales mode (فقط خرده / فقط عمده / خرده + عمده) is the ONLY channel switch; it is derived from
  `retail_enabled`/`wholesale_enabled` and drives which pricing sections exist. Retail-only products
  refuse wholesale prices and wholesale-only products refuse retail prices (both tested); both-on keeps
  two independent bases.
* Studio step 5 «قیمت‌گذاری و تخفیف» is the ONE pricing UX (no popup, no second app, no parallel
  editor). It contains: sales-mode reflection + deep link to «اطلاعات پایه», the retail section
  (`قیمت نقدی پایه (تومان)`, `خرید چهارقسطه`, `قیمت پایه چهارقسطه (تومان)` required with a Persian
  alert, `سیاست اعمال تخفیف روی خرید چهارقسطه`), the wholesale section (MOQ + per-Series editor with
  mode, composition/pieces, price or component prices) and the embedded canonical discount/festival
  editor (`product-pricing-panel.tsx`) whose every preview comes from `POST /pricing/resolve`.
* Studio draft-first behaviour is preserved: step 5/«موجودی اولیه»/review create the ONE canonical
  Draft when needed (idempotency-key protected, never a second draft), and a base-price save reports
  `قیمت نقدی پایه از … به …` (previous → new) and refreshes the embedded editor — no stale UI, no
  manual refresh.
* Money is integer رial in the server and تومان in the UI through the central formatters
  (`fmtToman`/`fmtMoney`); no float arithmetic anywhere in the pricing paths.

## 4. Read surfaces, storefront and orders

* **Hub (`kolbe-products-hub.tsx`) §34**: the price column shows the canonical numbers **per sales
  mode** — resolved retail final price (with the struck base when discounted and a «تخفیف/جشنواره»
  source label), the four-installment price when the explicit base exists, and for wholesale either
  «سری از X» (cheapest active non-legacy Series total) or «قیمت سری تعیین نشده»; «—» when no channel is
  enabled. It is a read model — the hub never becomes a second editor; every row action deep-links into
  the Studio at the relevant step (`?step=pricing|inventory|…`), and the legacy
  `#/admin/products/pricing/<id>` route redirects into that same step.
* **Product 360 §35**: pricing facts are read from the resolver/summary (`نتیجهٔ نهایی سرور`), the
  struck price and installment numbers come from the server, the tab deep-links to
  «مدیریت قیمت‌گذاری», and §28 price history is rendered from the shared audit trail
  («تاریخچهٔ تغییرات قیمت»: previous → new, actor, timestamp, product and Series rows).
* **Storefront (PDP/cards/cart/checkout/confirmation)**: the catalog read model carries the resolver's
  `pricing` block; `resolveDisplayPrice()`/`serverUnitToman()` render exactly those numbers (the local
  rule engine remains only as the offline demo fallback), installment UI distinguishes cash from
  installment and never invents a number when no explicit installment base exists.
* **Cart**: unit prices are the latest server resolution (adding with a stale `expectedUnitPriceRial`
  → 409 with a clear message), so the cart is never a price authority.
* **Checkout/order**: the browser sends no prices (order items are `.strict()` — any client-supplied
  `unitPriceRial`/`totalRial`/`discountRial` is rejected with 400), the server resolves the payable
  amount in the order transaction, and `pricing_snapshot` (+ `order_lines.base_unit_price_rial`,
  `unit_price_rial`, `discount_amount_rial`, `commission_*`) records the commercial truth:
  base/final/quantity/discount/promotion-or-festival reference/channel/installment policy. Later price
  edits never mutate existing orders (tested). No price-lock is invented: the customer always pays the
  server's current resolution.
* **VIP/wholesale** storefront reads the canonical Series definitions from the catalog read model and
  never sees supplier-private cost data.

## 5. Validation (server-side, Persian, business-level)

| Case | Result |
| --- | --- |
| negative / non-integer money | 400 (regex/length validation, Persian message) |
| installment enabled without base (create + patch) | 400 `برای فعال‌سازی خرید چهارقسطه، «قیمت پایه چهارقسطه» را وارد کنید.` |
| installment purchase disabled / no explicit base | 409 / 400 as in §2 |
| policy forbids discounts but a discount is live | resolver reports the block; the order pipeline refuses (`… با تخفیف، فروش اقساطی ندارد.`) |
| invalid Series mode / `series_total` without total / `component_sum` without component prices | 400 with Persian messages |
| unknown/inactive Series, retail request carrying a Series | 400 |
| non-sensical fixed/percent discount | 400 (`درصد تخفیف باید بین ۱ تا ۹۵ باشد.`, …) |
| client price on order creation | 400 (strict schema) |
| zero price | explicit «تعریف نشده» error (§2) |

No message exposes `NaN`, SQL, enum names, `snake_case`, UUIDs or stack traces (asserted in tests).

## 6. Price history & audit (existing infrastructure only)

`product.price_changed` (catalog PATCH) and the Series price audit (`series.ts`, before/after
`pricing_mode`/`total_price_rial`/component prices, real changes only) reuse `audit_logs`; the new
Product 360 panel and the existing audit console read the same table. No second audit store, no
`ProductPricingV2`, no schema change.

## 7. Migrations / seeds

**No migration was added**: the model fits the existing schema (`032/045/055/057/060/062/070` already
carry the price columns, the installment policy and the Series commercial pricing), which satisfies the
§64 «avoid schema change if the model suffices». The migration verifier still runs 51 migrations and a
second run is a byte-identical no-op (asserted by `npm run test:embedded`). The seed gained the §66
canonical showcase (idempotent, SELECT-guarded): a retail-only product, a retail + explicit
four-installment product (`enabled_when_discounted`), a product discounted through the promotion
engine, a `series_total` Series, a `component_sum` Series, and both-channel products.

## 8. Tests

* **Dedicated P2 suite — `backend/src/product-pricing.test.ts`** (registered in the embedded battery),
  covering the whole matrix:
  `P2-PRICE-001..004` (retail cash base, override, catalog parity, invalid money, zero price),
  `P2-PRICE-005..008` (installment enable/base/policy/refusal),
  `P2-PRICE-009..013` (series_total allocation, wholesale authority, component_sum validation and
  derived total, Series identity/error, no retail fallback),
  `P2-PRICE-014..019` (deterministic rounding, fixed-discount clamp, target precedence,
  festival exclusivity, DEC-PRICING-001 suspension without auto-reactivation, no stored final price),
  `P2-PRICE-020..022` (sales-mode independence),
  `P2-PRICE-023..026` (resolver == catalog == hub == cart == order; snapshot immutability; price audit),
  `P2-REG-001..005` (price save never publishes, never writes stock, WMS never auto-publishes, explicit
  publish, one productId per idempotency key, no duplicate draft).
* Existing suites were aligned with the canonical model (never weakened): `commerce.test.ts`,
  `experience.test.ts` (explicit installment base; policy without a determined base yields no offer),
  `contracts.test.ts` (payload key set + `installmentEnabled` + no compare-at field).
* Prompt-1 lifecycle/publication suites already cover the Studio lifecycle scenarios (draft-first,
  receipt → still draft, retail vs wholesale domains, explicit publish, sell-out, incomplete draft) and
  are kept green.

### Gate battery (frozen tree, no stale counts)

| Gate | Result |
| --- | --- |
| `npm run test:embedded` (migration verifier + all suites incl. P2) | **213/213 pass, 0 fail** (21 suites, 51 migrations, second run no-op) |
| `npm run test:contract` (frontend contract smoke) | **135/135** |
| `npm run test:pricing-routing` | **25/25** |
| `npm run test:dynamic-table` | **14/14** |
| `node scripts/qa-responsive-static.mjs` | **1/1 PASS** (wide elements wrapped/clamped at ≥360 px) |
| `npx tsc -p backend/tsconfig.json --noEmit` | **0** |
| `tsc -p tsconfig.json --noEmit` (frontend) | **0** |
| `vite build` (production) | **0** — 2,377.19 kB / gzip 587.55 kB; `dist/index.html` restored, not committed |

## 9. §73 dead-code / duplicate-authority audit

* `discount-manager.tsx` (the old full-page pricing workspace) and the Studio handoff/`onOpenPricing`
  machinery are gone; the pricing-routing smoke asserts their absence and the legacy route redirect.
* The only pricing implementations left are `promotions.ts` (server resolver) and the frontend
  `catalog.ts`/`ops.tsx` display layer; `resolveVariantPromotion()` survives **only** as the offline
  demo fallback (documented in code) and inside the Prompt-7-owned growth simulator preview (see §10).
* `products.discount_percent` and `metadata.discountPercent` are retired authorities: nothing derives a
  storefront price from them any more (the column stays writable for backwards compatibility and is
  ignored for pricing; the Studio deletes the legacy `metadata.compareAtRial` key on save).
* No raw identifiers/UUIDs are rendered in the pricing surfaces; the `Resolver`/`compareAt`/
  `pricing_mode` vocabulary is absent from user-facing copy (new §55 gate in the contract smoke).

## 10. Open items / deliberately untouched

1. **Browser UAT (§67–§72): PENDING — LOCAL UAT REQUIRED.** One bounded Chromium availability check was
   performed (per §72); the Puppeteer cache directories exist but contain **no browser binary** and no
   browser is installed on `PATH`, so the browser scenarios (A–D) could not be executed here. Static and
   server-side gates are not a browser PASS.
2. **Prompt 7 surface:** the growth/Discount-Festival Center simulator still previews with the local
   rule engine; it is out of Prompt-2 scope (§17–§19) and is flagged for Prompt 7 to switch to the
   server resolve API.
3. **§31 zero-price product decision**: documented in §2 — revisit explicitly if free products become a
   business requirement.
4. Legacy `discount_percent`/`metadata.discountPercent` columns are kept readable for old data; a
   dedicated cleanup could drop them once no legacy client writes them.

## 11. Verdict

`PROMPT 2 IMPLEMENTATION COMPLETE — LOCAL BROWSER UAT REQUIRED`

All Prompt-2 code, tests, gates and this report are pushed to `origin/arena/01a10ace-kolbevintage`
(local HEAD == remote HEAD == `9e33a82`); the working tree is clean and `origin/main` stays at
`3cd9dac`.

## 12. Commit table (baseline `c0825bf` → HEAD `9e33a82`; 27 files incl. this report, +1631/−245 in code)

| Commit | Subject |
| --- | --- |
| `df52a08` | feat(pricing): one canonical server price model — explicit installment base + policy, series-aware wholesale resolution, batched read models |
| `a85b5b4` | test(pricing): P2-PRICE-001..026 + P2-REG-001..005 matrix on the embedded harness |
| `b23ed3b` | test(gates): align pricing gate needles with the §55 Persian terminology |
| `e35f5d4` | feat(storefront): render the canonical server price on cards, PDP, cart and admin surfaces |
| `707fa25` | feat(pricing): price history in Product 360, price-change feedback in the Studio, §55 term gate |
| `9e33a82` | docs(pricing): Prompt-2 final report (canonical model, resolver contract, gates, open items) |
