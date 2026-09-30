# Agent A — Cross-Agent Contracts

Branch: `arena/01a0ed8e-kolbevintage` · Scope: requirements **1–10, 35–52, 82–84, 122–135, 245–247**
(Wholesale ops, Product Type, Dynamic Sizes, Series Templates, Product Editor,
Product/Variant/WMS, Channel ownership, Import/Migration, Pricing/Installment,
Shipping/Weight, Dynamic Specs, Size Guides, Gender/Season, Quick Buy/Product form)

Status: **FROZEN for integration.** No new features; audit fixes only.
Delta measured against 916-foundation `ec41e11c97e1b472a3b97433b1458caf05dad3ed`
(16 backend files + 20 frontend files + migrations 016–018).

---

## 1. Migrations (Agent A owns 016–018 — IN RANGE, no rename needed)

| File | Contents |
|---|---|
| `016_commerce_product.sql` | `product_types`, `product_type_sizes` (+index), `product_taxonomies` (+gender/season seeds), `product_seasons`, `product_review_reasons` (+seeds); `products` += `product_type_id`, `owner_type` (+`kolbe`/`supplier` checks, supplier⊆wholesale-only check), `retail_enabled`, `wholesale_enabled`, `installment_policy` (+4-value check), `wholesale_moq`, `gender_code`; `product_variants` += `weight_grams`; `product_reviews` += `reason_code`/`reason_label`; `orders` += `pricing_snapshot`; `users` += `must_reset_password` |
| `017_specs_sizeguides.sql` | spec attributes/options/templates tables, size-guide tables (+ `version`, seeds) |
| `018_imports_shipping_rules.sql` | `import_jobs` (+report/mapping), shipping rules tables, method rule columns |

**Integration rule:** `001–015` are byte-identical on every branch — take once.
Every agent used `016+` numbers with different filenames; the coordinator renumbers
colliding sets. Agent A keeps `016_commerce_product`, `017_specs_sizeguides`,
`018_imports_shipping_rules`.

---

## 2. New backend modules (Agent A owns the files)

### `product-types.ts` — Product Types, Dynamic Sizes, Taxonomies
- `GET /api/v1/product-types` · `GET /api/v1/product-types/:id` (public)
- `GET /api/v1/taxonomies?kind=gender|season` (public)
- `POST /api/v1/admin/product-types` · `PATCH …/:id` · `DELETE …/:id`
- `POST …/:id/sizes` · `PATCH …/:id/sizes/:sizeId` · `POST …/:id/sizes/reorder` ·
  `DELETE …/:id/sizes/:sizeId`
- `POST /api/v1/admin/taxonomies` (+ rename/reorder/activate — same file)
- Sizes are the ONLY runtime size source: creation **requires ≥1 size**; renaming a
  size code propagates to `product_variants.size_label` (same type).
- Needs: `principal` + `requirePermission`, `transaction`, `zod`, `audit` (foundation).

### `specs.ts` — Dynamic Specs + Size Guides
- Attributes: `GET /api/v1/spec-attributes`, admin CRUD
  (`POST/PATCH/DELETE /api/v1/admin/spec-attributes[/:id]`),
  options `POST …/:id/options`, `DELETE …/:id/options/:optionId`
- Templates: `GET /api/v1/spec-templates[/:id]`, admin CRUD
- Product specs: `GET /api/v1/products/:id/specs`, `PUT /api/v1/products/:id/specs`
  (v1 public shape + v2 typed values; unknown keys rejected)
- Size guides: `GET /api/v1/size-guides[/:id]`, admin CRUD
  (`POST/PATCH/DELETE /api/v1/admin/size-guides[/:id]`),
  `POST …/:id/columns`, `DELETE …/:id/columns/:columnId`,
  `PUT …/:id/rows` (full replace), `POST …/:id/media` (file upload → fileId)

### `imports.ts` — Import / Migration (items 35–44)
- `POST /api/v1/admin/imports/upload` (multipart) · `GET /api/v1/admin/imports` ·
  `GET …/:id` · `PUT …/:id/mapping` · `POST …/:id/dry-run` · `POST …/:id/run` ·
  `POST …/:id/retry` · `POST …/:id/cancel` · `GET …/:id/errors.csv` · `DELETE …/:id`
- **Dry-run writes NOTHING business**: only `UPDATE import_jobs.report` + one
  `import.dry_run` audit row. Matching key = `import_key`.
- Migrated users get `must_reset_password=true` + one-time activation token;
  login returns `403 PASSWORD_RESET_REQUIRED` until reset (see `auth.ts` delta).

## 3. Deltas inside shared backend files (MERGE WITH CARE)

| File | Agent-A delta (vs 916) |
|---|---|
| `app.ts` | +3 registrations: `registerProductTypeRoutes`, `registerSpecRoutes`, `registerImportRoutes` (additive; keep all agents' registrations) |
| `catalog.ts` | `+PATCH /products/:id/variants/:variantId`; create/patch accept `productTypeId`, `retailEnabled`, `wholesaleEnabled`, `installmentPolicy` (4 policies), `wholesaleMoq`, `genderCode`, `seasons[]`; variants accept `weightGrams`; list filters `channel=retail|wholesale|all`, `productTypeId`, `gender`, `season`; supplier rows wholesale-only enforced |
| `orders.ts` | **No new routes.** List gains 11 server-side sorts incl. `shipped` (`SHIPPED_AT` subquery) + fulfillment-stage rank; checkout consumes `installment_policy`/`wholesale_moq`, persists `pricing_snapshot` |
| `shipping.ts` | `+POST /api/v1/shipping/quote` (weight = Σ `weight_grams × qty`, default per-variant fallback), `+GET/POST /api/v1/admin/shipping-methods/:id/rules`, `+PATCH/DELETE /api/v1/admin/shipping-rules/:ruleId` |
| `inventory.ts` | `+POST /api/v1/inventory/bulk-adjustments`, `+POST /api/v1/inventory/bulk-receipts` (WMS stays the sole availability truth; catalogue `available` derives from `stock_balances`) |
| `marketplace.ts` | `+GET /api/v1/supplier/products`, `+GET …/:id`, `+POST …/:id/resubmit`, `+POST /api/v1/admin/marketplace/products/:id/resubmit`, `+GET /api/v1/[admin/marketplace|marketplace]/review-reasons` (supplier flow incl. review reasons + resubmission + notify drawer data) |
| `auth.ts` | `must_reset_password` gate (`403 PASSWORD_RESET_REQUIRED`) + one-time activation endpoint for migrated users |
| `supplier-report.ts` | Item 1: 9 server-side sorts/search/filter + deterministic `ORDER BY` |
| `wallet.test.ts` | Fixture update only (wholesale price + plan membership for supplier listings) |
| `commerce.test.ts` | +521 lines: embedded contract coverage for the above |

## 4. Events (audit log — `operations.audit`, no event bus added)

`import.job_created|mapping_updated|dry_run|job_started|job_retry|job_finished|
product_created|product_updated|inventory_applied|user_created|user_updated`
All scoped to `import_job`/`product`/`variant`/`user` entities with `{jobId, row}` context.

## 5. Frontend contracts (Agent A owns these files)

New: `components/import-center-panel.tsx`, `marketplace-review-panel.tsx`,
`product-specs-editor.tsx`, `product-structure-panel.tsx`, `supplier-review-panel.tsx`;
extended: `components/shipping-admin.tsx`, `data/api.ts` (+167), `data/contracts.ts` (+540),
`data/store.tsx`, `data/catalog.ts` (`Product.variants?`), `portals/retail.tsx`,
`portals/admin-product.tsx`, `portals/admin-server-orders.tsx`,
`portals/admin-wms-panel.tsx`, `portals/admin.tsx`, `portals/series-templates.tsx`,
`portals/studio.tsx`, `portals/supplier.tsx`; **deleted** `portals/supplier-series.tsx`
(dead hardcoded sizes — do not resurrect).

- Demo gate: `USE_DEMO_SEED` (`store.tsx`), `USE_DEMO_SEED_OPS` (`ops.tsx`), `?demo=1`.
  Normal runtime: **no seed products/users/coupons/heroes/sizes**; localStorage holds
  only auth tokens + UI prefs; cart is transient.
- Catalog hydration (`store.tsx`): server row → `Product` mapper (Rial→Toman,
  `metadata.images` → `images`, variants → colors + fallback series, `available` → `stock`).
- Checkout payload (`retail.tsx`): `{ variantId, quantity }[]` + `paymentMode` +
  `shippingMethodId` + `couponCode?` + `shippingAddress` — exact variant resolved by
  **size+color** (never `variants[0]`); quotes via `POST /api/v1/shipping/quote`.
- Product create payload (`contracts.ts`): exact-keys, Rial strings; admin series
  summary persisted in `metadata.series` (**without** `composition` — known gap §7).

## 6. Cross-agent dependencies (what Agent A NEEDS, not owns)

| Need | Owner (expected) | Notes |
|---|---|---|
| `principal` / `requirePermission` / roles | Foundation + Membership agent | All admin routes; supplier role scoping |
| WMS balances + receipts | Foundation / Inventory | Sole stock truth; receipts per variant |
| Payments / installments execution | Finance agent | A defines `installmentPolicy` + snapshot; execution is theirs |
| Vibe taxonomy (items 201–203) | CMS/Style agent | Out of Agent-A scope; no `vibe` kind added |
| Supplier 360 / invoices / payouts | Supplier agent (`d8f`) | A owns supplier **product** flow; 360 profile/invoicing is theirs |
| Review moderation core | Foundation | A adds reasons/resubmit only |
| Notifications infra | Foundation | A emits audit rows; drawer reads server data |

## 7. Known gaps / limitations (documented, not hidden)

1. **Series-template definitions are session-local** in real runtime: template types
   pull server sizes, but definitions have no backend CRUD in assigned IDs
   (`ops.tsx` has no `upsert` mapping). No other agent blocked.
2. **Admin `metadata.series[]` lacks `composition`** (supplier flow persists full
   `draftSeries` with composition). Retail sizes for admin-created products derive
   from **variant sizes** via the hydration mapper — display stays correct.
3. **Vibe** (201–203) intentionally untouched — belongs to the style agent.
4. `dist/` is a build artifact of this branch; the integration build regenerates it.
