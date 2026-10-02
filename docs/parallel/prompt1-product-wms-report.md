# Master Prompt 1 — Product / Catalog / Supplier-Offer / WMS Foundation — Final Report

Branch: `arena/01a0f798-kolbevintage` · Date: 2026-10-02

## 1. BASELINE

- Starting SHA: `7f41b0f0c0bf9204d5ef954794e2e4a2306f9aca` (CRM master phase complete, remote == local).
- Delivered commits (all pushed):
  - `025ad42` — W1-W3 backend: migration 063, supplier-offers.ts, supplier-consignment.ts, product-lifecycle.ts, catalog hooks, 5 new embedded test suites.
  - `a337eab` — W4a: کالاها hub tab, WorkspaceModal, §44 admin product read model, contract-smoke 5-tab assert.
  - `ecc87cf` — W4b: supplier portal panels, admin consignment ops, VIP §36 availability split, §55 privacy fix.
  - `5d91bab` — W4c: §8 category-driven Studio, category-profiles config panel, §14 nav consolidation, §53 documentation.

## 2. AUDIT (what existed, what was reused — NO parallel systems)

| Capability | Existing canonical system | Action |
|---|---|---|
| Product/variant/SKU/media/SEO | `catalog.ts`, `products`/`product_variants` | EXTENDED (`inventory_setup` state, category validation hook) |
| Specs / size guides | `specs.ts`, migration 017 (`spec_templates`, `spec_attributes`, `size_guides`) | REUSED — category_profiles references them, no new spec system |
| Series engine | `series-inventory.ts` (062): owner-scoped balances, overlay guard, movements | REUSED — all consignment/opening/conversion stock writes go through `applySeriesMovement` |
| Piece stock | `stock_balances`/`stock_movements`/`stock_receipts` (058) | REUSED — opening receipts and QC overlay credits use the canonical tables |
| Marketplace review | `marketplace.ts` + `MarketplaceReviewPanel` | REUSED unchanged (approval = marketplace permission ONLY; verified: creates no stock) |
| Ownership conversion | `ownership_conversions` (055, product-level in inventory.ts) | EXTENDED with `conversion_type='series_stock'` scope — same table, same audit pattern |
| Legacy supplier replenishment | `supplier_requests` (059) | LEFT AS-IS; §52: consignment inbound deliberately does NOT reuse it (it credits owner-less stock) |
| RBAC / audit / outbox / idempotency / references | `auth.ts`, `operations.ts`, `references.ts` | REUSED everywhere; new permission codes NOT invented (uses `wholesale:ops`, `suppliers:manage`, `inventory:*`, `products:write`) |

## 3. MIGRATIONS

One additive migration: `backend/src/migrations/063_product_wms_foundation.sql`

- `category_profiles` (§8-§10): category → spec template, size guide, allowed sizes, required fields.
- `products.inventory_setup` (`pending`/`configured`; existing rows grandfathered `configured`) + `wholesale_max_order`.
- `supplier_offers` (§29): scope supplier+product+color+template; min/max order (Series), fulfillment mode, declared_capacity, reserved_external, safety_buffer, capacity_confirmed_at, lead time, version.
- `supplier_capacity_reservations` (§33): atomic external reservations with TTL — **never** rows in `stock_reservations`.
- `supplier_series_inbounds` + seq (§26-§27): requested→approved→dispatched→received→qc_completed (+rejected/cancelled), shortage/passed/rejected counts, recipe snapshot, idempotency key.
- `supplier_stock_returns` + seq (§37).
- `ownership_conversions`: + `series_template_id`/`warehouse_id`/`series_count` and `conversion_type` CHECK extended with `series_stock` (constraint recreated additively; legacy values intact).
- Series movement CHECK extended: `return_out`, `conversion_out`, `conversion_in`.

Verified: `node scripts/verify-migrations.mjs` → ALL CHECKS PASSED (fresh apply + second-run no-op, 001…063).

## 4. IMPLEMENTATION BY DOMAIN

### CATALOG (§4-§11, §14-§16, §44)
- Admin products are ALWAYS kolbe-owned server-side; client `ownerType`/`supplierId` is stripped (pre-existing, now covered by a test with a spoof payload).
- New kolbe products start `inventory_setup='pending'` → «نیازمند راه‌اندازی»; «—» (not configured) vs «۰» (configured, zero) is backend state surfaced in every table.
- `GET /api/v1/admin/products` — §44 read model (owner, catalog status, retail/wholesale numbers, active offers, setup state; server pagination/search/filters).
- `GET /api/v1/admin/products/needs-setup`.
- Category profiles: `GET/PUT /api/v1/admin/category-profiles[...]`, `GET /api/v1/catalog/categories/:category/schema`; product create validates required category specs + allowed sizes.
- Studio (§8): configured category hides the product-type picker entirely and shows the category schema; `product_type` data retained untouched (adapter below).

### Opening stock (§17-§20)
`POST /api/v1/admin/products/:id/inventory-setup` (perm `inventory:adjust`, mandatory `Idempotency-Key`, claim/complete idempotency):
- retail: zero / equal / per-variant → real `stock_receipts` (status received) + balance update + movements (`opening_receipt` refs), retail-purpose warehouse enforced;
- wholesale: series template + count → recipe piece credits then `receipt` series movement (overlay stays consistent), wholesale-purpose warehouse enforced;
- one-shot: configured products get 409 (later changes go through normal WMS ops); audited + outboxed; honest preview in UI before confirm.

### OFFER / AVAILABILITY (§28-§36, §55)
`supplier-offers.ts`:
- supplier offer upsert w/ ownership guard (IDOR-checked), server-validated min ≤ max (Series);
- declared capacity: `FOR UPDATE`, cannot drop below reserved_external, confirm-only refresh; **never** touches stock tables (asserted by test);
- freshness: configurable via `site_settings['supplier_capacity_freshness']` (fresh/acceptable/needs-update/stale); stale never un-approves;
- `availableToRequest = max(0, declared − reserved_external − safety_buffer)` — server-side only;
- capacity reservations: atomic conditional UPDATE + TTL + expire sweep (`FOR UPDATE SKIP LOCKED`); release/expire restore capacity, consume doesn't; exported primitives (`reserveSupplierCapacity`, `settleSupplierCapacityReservation`) are the Prompt-2 contract;
- `GET /products/:id/wholesale-availability` (§36): kolbe verified stock and supplier declared capacity returned separately with confidence; §55 privacy shape strips supplier id AND name for non-admins;
- inventory-accuracy aggregate endpoint (confirmed vs received, shortage, QC pass) for §34 metrics.

### WMS / consignment (§21-§27, §35, §37, §40-§43, §48-§50)
`supplier-consignment.ts`:
- advance inbound: request (supplier, own product+template only) → admin approve (= warehouse/capacity control, wholesale-purpose enforced, creates NO stock — asserted) / reject (reason required) → supplier dispatch (`incoming` +expected, owner=supplier) → admin receive (≤ expected; shortage recorded as discrepancy + outbox event; double receive 409) → QC (passed+rejected must equal received exactly; passed → piece overlay credit THEN series `receipt`; rejected → `qc_reject` damaged/quarantine; double QC 409). Every stock write idempotency-keyed (`ssi-*:{id}`).
- supplier stock-at-kolbe read model (§43): owner=supplier balances w/ on_hand/reserved/available/damaged/last-receipt; suppliers see ONLY their own rows (tested).
- stored-stock returns (§37): request limited to on_hand−reserved (reserved never returnable — tested), approve/reject/complete; complete debits series + overlay pieces atomically.
- series ownership conversion (§50): `POST /admin/inventory/series-ownership-conversions` — mandatory idempotency key, `conversion_out` (supplier) + `conversion_in` (kolbe) + `ownership_conversions` document `OWN-…` with cost kept for Prompt-3 settlement; replay returns duplicate 200 (tested).
- §38: ownership, durations (received/qc/completed timestamps), references all preserved — no fee engine built.

### UI (§14, §40-§44, §60-§62)
- Warehouse hub: 5 primary tabs — **کالاها** (تعریف محصول = relocated ProductStudio / نیازمند راه‌اندازی / بازبینی تأمین‌کنندگان / همه کالاها / آرشیو), خرده‌فروشی, نقل‌وانتقالات, انبار عمده (+ «موجودی تأمین‌کنندگان» sub-view, consignment queue inside «ورودی انبار و QC»), تنظیمات (+ پروفایل دسته‌بندی‌ها).
- `WorkspaceModal` primitive (§60): centered ~90vw / max-1360px / ~90vh, fixed header, scrollable body, mobile full-screen; used for the opening-stock workspace. No right drawers added.
- Supplier portal: «پیشنهاد و ظرفیت عمده» + «موجودی نزد کلبه» (inbounds / consigned stock / returns).
- VIP: §36 split display — «آمادهٔ ارسال از انبار کلبه (تأییدشده)» vs «قابل درخواست از تأمین‌کننده (اعلامی/استعلامی)» with freshness-aware labels; failures of the availability call never break ordering.
- Legacy nav: admin sidebar «تعریف محصول» removed; `rproducts` key redirects to `wms:goods` (no crash, no duplicate).

## 5. API SURFACE (new)

Supplier: `POST/GET /supplier/offers`, `POST /supplier/offers/:id/capacity`, `POST /supplier/offers/:id/status`, `POST/GET /supplier/inbounds`, `POST /supplier/inbounds/:id/dispatch|cancel`, `POST/GET /supplier/stock-returns`.
Admin: `GET /admin/products`, `GET /admin/products/needs-setup`, `POST /admin/products/:id/inventory-setup`, `GET/PUT /admin/category-profiles`, `GET /catalog/categories/:category/schema`, `POST /admin/supplier-inbounds/:id/review|receive|qc`, `GET /admin/supplier-stock`, `POST /admin/supplier-returns/:id/review`, `POST /admin/supplier-offers/:id/reservations`, `POST /admin/supplier-offers/reservations/:id/release`, `POST /admin/supplier-offers/reservations/expire-sweep`, `GET /admin/suppliers/:id/inventory-accuracy`, `POST /admin/inventory/series-ownership-conversions`, `GET /products/:id/wholesale-availability`.

## 6. SECURITY & CONCURRENCY (§56-§57)

Covered by implementation + tests: owner spoofing (strip + test), IDOR on offers/capacity/inbound dispatch (403 tests), double receipt/QC (status-guard 409 tests), over-return and reserved-return (409 test), capacity over-reserve (atomic conditional UPDATE, 409 test), capacity-below-reserved (409 test), stale TTL expiry restoring capacity (test), idempotent replays (setup claim/complete test; conversion duplicate test; all movement writes `ON CONFLICT (idempotency_key)`), negative-stock guards in both balance tables, `FOR UPDATE` on offers/inbounds/balances/products, approval-creates-no-stock (two asserts: marketplace approval pre-existing tests + inbound approval test), supplier privacy from VIP (§55 id+name stripped).

## 7. TESTS

- `backend/src/product-wms-foundation.test.ts` — 5 suites / ~60 asserts (admin owner lock + no-stock-on-save + needs-setup lifecycle; opening stock equal/per-variant/wholesale + idempotency + audit; category profiles; offers/capacity/freshness/reservations; full consignment flow + returns + conversion).
- Full embedded run: **162/162 pass** (`node scripts/run-embedded-tests.mjs`).
- Contract smoke: **94/94 pass** (`npm run test:contract`) — incl. new 5-tab hub assert + کالاها sub-view assert + existing VIP series-only asserts.
- Migrations: ALL CHECKS PASSED. Backend `npm run build` green; root `npx tsc --noEmit` green; `npx vite build` green.

## 8. MANUAL QA

Browser-based manual QA **NOT RUN** — no browser available in this environment. UI paths are exercised only by tsc/vite builds and static contract asserts. Recommended manual pass: کالاها lifecycle end-to-end, supplier portal inbound → admin receive/QC → VIP availability display, RTL layout of WorkspaceModal on mobile.

## 9. DEFERRED TO PROMPTS 2-4 (clean interfaces left behind)

- Prompt 2 (OMS): source-specific wholesale allocation — contract documented in `orders.ts` (§53 comment at the reserve path); capacity primitives exported from `supplier-offers.ts`; order-driven consolidation UI placeholder remains the existing Model D flow.
- Prompt 3 (finance): conversion documents carry `unit_cost_rial`/`total_cost_rial`; consignment rows carry ownership + duration timestamps for storage/handling fees. No wallet/settlement built.
- Prompt 4: shared canonical rejection-reason system (current review/reject uses free-text reason server-validated non-empty); accuracy-threshold driven automation (metrics endpoint exists, enforcement hooks not wired).

## 10. HONEST LIMITATIONS / RISKS

1. **Legacy product-type path still live for unconfigured categories**: the Studio falls back to the type picker when a category has no profile (intentional adapter per §8); full retirement requires seeding profiles for all live categories.
2. `supplier_requests` (059) replenishment flow still exists untouched; it is piece-level kolbe replenishment, not consignment — do not confuse the two (named differently in UI).
3. Inventory-setup is one-shot; products created *before* 063 are grandfathered `configured` even if they never had stock (acceptable: they already operate through normal WMS ops).
4. Freshness is evaluated at read time; there is no scheduled job pausing stale listings (policy per §32 is warn/request-only, which the VIP display implements).
5. VIP availability block requires the authenticated availability endpoint; on failure it silently hides (ordering unaffected).
