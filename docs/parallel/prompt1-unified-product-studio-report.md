# PROMPT 1 — Unified Product Studio + Pricing Routing + Table Bugs + WMS + Structure — Final Report

Branch: `arena/01a10ace-kolbevintage` (never merged to `main`).
Verdict at the end of this document: **PROMPT 1 NOT VERIFIED — DO NOT CONTINUE** (server/static gates green, Browser UAT PENDING in this sandbox).

---

## 1. What changed in the product UX (before → after)

**Before:** a product was defined in Product Studio, then the operator had to _leave_ the Studio for a separate
full-page «قیمت‌گذاری» workspace (draft-first hand-off), manage discounts/festivals there and in the Promotion
Center, then leave again for «ورود اولیه کالا» (WMS modal) and finally reopen the product to publish it.

**After (one continuous Studio):** a single nine-step wizard that owns the whole journey:

| # | Step | Contents |
|---|------|----------|
| ۱ | اطلاعات پایه | identity, category, **sales mode** (فقط خرده / فقط عمده / خرده + عمده), channel flags |
| ۲ | رنگ، سایز و واریانت | Color×Size matrix, server variants, variant weights |
| ۳ | تصویر و ویدیو | product images + video (server files) |
| ۴ | تصویر استایل‌بیلدر | cutout pipeline (n8n + local fallback) |
| ۵ | **قیمت‌گذاری و تخفیف** | retail base prices + installment policy, wholesale Series pricing, **embedded canonical discount/festival editor** |
| ۶ | مشخصات و راهنمای سایز | two independent arbitrary tables |
| ۷ | **موجودی اولیه** | embedded canonical «ورود اولیه کالا» (WMS receipt) or read-only balances + WMS deep link |
| ۸ | سئو و کانال‌ها | SEO title/slug, channels |
| ۹ | بازبینی و انتشار | server readiness checklist, summary, **`[انتشار محصول]`** |

A **sticky action bar** is always visible at the bottom of the Studio:
`[مرحله قبل] [ذخیره پیش‌نویس] [مرحله بعد]` … and on the last step `[ذخیره پیش‌نویس] [انتشار محصول]`, plus the
always-visible publication chip («پیش‌نویس» / «منتشرشده» / «آرشیوشده») and `[انصراف]` with unsaved-change protection.

## 2. Pricing routing (before → after)

| | before | after |
|---|--------|-------|
| Studio entry | hand-off prop `onOpenPricing` → hub navigated to a separate page | **no hand-off**; Studio step ۵ embeds `ProductPricingPanel` |
| Separate page | `ProductPricingWorkspace` in `discount-manager.tsx`, hash `#/admin/products/pricing/<id>` | **file deleted**; the legacy hash is **redirected** (`history.replaceState`) to `#/admin/products/studio/<id>?step=price` |
| Hub `قیمت‌گذاری` | opened the pricing page | `openStudioAt(row, "price")` — the SAME Studio from step ۵ |
| Hub `مدیریت موجودی` / `ورود اولیه کالا` | inventory modal / WMS screen | `openStudioAt(row, "inventory")` — Studio step ۷ |
| Hub `ویرایش` | opened Studio at step ۱ | unchanged (step ۱) |
| Hub `ادامه تکمیل محصول` | resumed the draft at step ۱ | resumes at step ۷ when the receipt is pending, otherwise step ۵ |
| Hub `۳۶۰°` | modal read-only view | unchanged; its «قیمت‌گذاری» button now opens the Studio step ۵ |
| Deep-link/refresh | hash `pricing/<id>` | hash `studio/<id>?step=<step>` (`new` for create); Back/forward inside the Studio is handled by a `popstate` listener that maps the hash back to the step |

Authorization of the writes is unchanged and canonical: base prices → catalog columns (`POST/PATCH /products`);
discounts/festivals → `promotion_rules` / `promotions` via `promotionRulesApi`; stock → WMS receipts.

## 3. Draft-first semantics (one product id, never duplicates)

* `activeProductId = editing?.id ?? createdDraftId`.
* `ensureDraft()` returns the edit target, else the already-created draft, else creates **exactly one** draft
  (`createProduct()` with `saveIntent: 'draft'` + one idempotency key per session) and remembers its id in
  `createdDraftId`.
* The first server-backed need (entering step ۵ / ۷ / ۹, or pressing `[ذخیره پیش‌نویس]`) triggers `ensureDraft()`;
  every later step and the publish path reuse that same id (`pushDraft()` PATCHes it instead of creating).
* The form is **never** cleared or navigated away by a save (`keepForm` semantics); `[انصراف]` still asks before
  discarding unsaved edits.
* New colors/sizes enabled after the draft exists become real canonical variants through
  `productsApi.createVariant` inside `syncDraftVariants()`.
* Server proof: `product-draft-lifecycle.test.ts` §28/§29 (retry with the same idempotency key returns the SAME
  product; resuming a draft reuses the same product id; saving writes zero stock).

## 4. Dynamic-table column deletion (root cause + fix)

**Root cause (previous phase, still valid):** the old editor derived each mutation from a **render-time snapshot**
and emitted **two** `onChange` calls per user action; the second one re-added the column that the first had deleted,
so a deletion survived the local re-render but not the save/reload round-trip.

**Fix (in place):** all mutations are pure functions in `src/components/table-ops.ts`
(`tableAddColumn / tableRenameColumn / tableDeleteColumn / tableMoveColumn / tableAddRow / tableDeleteRow /
tableMoveRow / tableSetCell`) and the editor commits **exactly one** `onChange(next)` per user action.
The `backend/scripts/dynamic-table-smoke.ts` gate reproduces the walkthrough (delete the middle of three columns →
rename → reorder → delete a row → reorder → serialize/reload) and the contract smoke asserts the single-commit
invariant (`onChange(next)` appears once, every mutation line has at most one `commit(table…)`).

## 5. Publication vs physical inventory

* Publication is `draft → published` (explicit `[انتشار محصول]` in step ۹ **and** the hub row switch), server-validated.
* WMS receipts keep the product `پیش‌نویس`; **physical stock never publishes a product** (unchanged invariant).
* A published product that sells out stays «منتشرشده» (test §34).
* WMS wording is inventory-only: «موجودی فیزیکی / قابل تخصیص / رزروشده / آسیب‌دیده / در راه»; publication is its own
  column/filter («وضعیت انتشار»). The word «قابل فروش» was removed from WMS surfaces; `WMS_LABEL.available` is «قابل تخصیص».
* The Studio never labels a Draft's availability as «فعال».

## 6. WMS sort + filters (preserved, §28)

* Default sort = **جدیدترین**; deterministic server-side ordering (stable tie-breakers) — never accidental DB order.
* All eight options are server parameters: `newest | oldest | stock_desc | stock_asc | available_desc | available_asc | name_asc | name_desc`
  (جدیدترین، قدیمی‌ترین، بیشترین/کمترین موجودی، بیشترین/کمترین قابل تخصیص، نام الف→ی، نام ی→الف).
* Filters: search, category, warehouse, inventory domain, availability, publication status, ownership (+ color/size/
  hasIncoming/hasReservation) — compact bar, active chips, «پاک کردن فیلترها», result count, mobile-collapsible.
* The client never sorts the full inventory (no in-browser `.sort()` over the dataset).

## 7. Structure management (§12–§15 / §29)

* Every applicable row exposes `ویرایش` / `فعال‑غیرفعال` / `حذف` + display order (never a toggle-only row).
* Safe delete: unreferenced → hard delete; referenced → **409 with a Persian reason** and a «غیرفعال کردن به‌جای حذف»
  affordance; history is never cascade-deleted; inactive values are hidden from new-product creation but stay readable.
* Codes are immutable where references break (only `label|active|position` are PATCHed).
* No DB identifier (UUID) or timestamp is rendered anywhere in the surface.
* Long lists: server search + active filter + result count.

## 8. Dead code / parallel authority audit (§19/§41)

Removed after a zero-importer + zero-test-dependency check:

| file | why |
|------|-----|
| `src/components/discount-manager.tsx` (`ProductPricingWorkspace`) | superseded full-page pricing authority; the canonical editor is now `product-pricing-panel.tsx` |
| `src/components/product-specs-editor.tsx` (`ProductSpecsEditor`) | superseded specs/size-guide editor; the Studio's arbitrary tables are the only authority |
| `src/portals/admin-wms-panel.tsx` (`AdminWmsPanel`) | superseded second WMS surface, mounted nowhere |

No new authority was introduced: `ProductInventoryPanel` (read-only balances + WMS deep link) and
`ProductPricingPanel` (canonical promotion records) are thin surfaces over existing canonical APIs.

## 9. Backward compatibility

* Legacy hash `#/admin/products/pricing/<uuid>` still resolves — it is rewritten to the Studio pricing step.
* Legacy draft/bootstrap behaviour (`saveIntent:'draft'`, lenient validation, zero stock) is unchanged.
* `GET /admin/products` legacy `status=all|active|archived` still works (`status=published` was already invalid → use `view=published`).
* Topics/taxonomy codes, WMS sort keys and the publication validator are unchanged, so stored data and existing
  integrations keep working. **No schema change, no migration** (51 migrations; second run is a no-op).

## 10. Files changed in this phase

Added: `src/components/product-pricing-panel.tsx`, `src/components/product-inventory-panel.tsx`.
Rewritten/updated: `src/portals/admin-product.tsx` (9-step Studio, sticky bar, step router, draft-first, publish),
`src/components/kolbe-products-hub.tsx` (Studio step routing, legacy pricing redirect), `src/portals/admin.tsx`
(products-route detection), `src/components/initial-inventory-workspace.tsx` (embeddable + receipt state),
`backend/scripts/pricing-routing-smoke.ts` (rewritten for the unified Studio),
`backend/scripts/frontend-contract-smoke.ts`, `backend/scripts/qa-responsive-static.mjs`.
Deleted: `src/components/discount-manager.tsx`, `src/components/product-specs-editor.tsx`, `src/portals/admin-wms-panel.tsx`.

## 11. Exact final gate results (re-run on the frozen revision)

| gate | result |
|------|--------|
| `npm run test:embedded` (backend, fresh embedded PostgreSQL) | **206 / 206 pass, 0 fail, exit 0** — “51 migrations applied; second run was a no-op” |
| `npm run test:contract` (frontend contract smoke) | **134 / 134 checks pass, exit 0** |
| `npm run test:dynamic-table` (§4 regression + §22 walkthrough) | **14 / 14, exit 0** |
| `npm run test:pricing-routing` (rewritten routing/authority gate) | **25 / 25, exit 0** |
| `node scripts/qa-responsive-static.mjs` | **1 / 1 PASS** — 11 Prompt-1 surfaces, 27 fixed/min widths ≥ 320px |
| frontend `tsc -p tsconfig.json --noEmit` | **0 errors** |
| backend `tsc -p tsconfig.json --noEmit` | **0 errors** |
| `vite build` (production, single-file) | **exit 0**, built in 6.89s — 2,369.18 kB (gzip 585.45 kB); `dist/index.html` restored, never committed |
| migration verifier | **51 migrations applied on a fresh DB; second run is a no-op** (inside the embedded run) |

Test suites that specifically cover the acceptance scenarios: `product-draft-lifecycle.test.ts` (§28–§34: draft +
retail/wholesale receipts + domain isolation + sold-out stays published), `product-publication.test.ts` (explicit
publish + separate archive/deactivate + `stockIndependent`), `wholesale_inventory_promotions.test.ts`
(scenarios 16–20: variant/color/size/product discount precedence, official retail/wholesale isolation, transfer,
ownership conversion), `wms-workflows.test.ts`, `series-inventory.test.ts`, `pricing-wms-structure.test.ts`,
`contracts.test.ts` (route shape), `experience.test.ts` (studio payloads).

## 12. Browser UAT

Chromium is unavailable in this sandbox (no browser binary, CDN blocked, runtime libs absent, no package source,
non-root; retries are forbidden by §35). Therefore the browser gates are **PENDING — NOT VERIFIED**:

* real publish flow (new product → draft → publish → row «منتشرشده» after refresh),
* pricing route flow (Studio step ۵ in-place, legacy hash redirect, Back behaviour),
* draft-first handoff (no duplicate product, one id across steps),
* dynamic-table interactions in a real DOM (delete first/middle/last column for both tables, reload),
* WMS sort/filter interaction + default «جدیدترین»,
* structure CRUD interaction + referenced-delete 409 UX,
* responsive measurement at 360 / 390 / 768 / 1024 / 1280 / 1440,
* console/network verification (no 4xx/5xx, no duplicate writes, no console errors).

Static and server gates are **not** a substitute for this UAT and are not reported as such.

## 13. Skills

Relevant skills unavailable; used repository design system.

## 14. Commits / git state

Commits (this phase, on top of `e262411`):

| commit | content |
|--------|---------|
| `4d075cf` | feat(product-studio): ONE unified 9-step Studio + hub step routing + embedded pricing/inventory |
| `4b57a5a` | refactor: remove the superseded pricing workspace / specs editor / second WMS panel + align the gates |
| docs commits | this report and its commit-list pin (tip of `arena/01a10ace-kolbevintage`) |

Pushed to `origin/arena/01a10ace-kolbevintage` (`e262411..<tip of the branch>`); local `HEAD` == remote `HEAD`
verified after `git fetch`; `git status --porcelain` empty; `main` (`3cd9dac`) untouched and never merged.

## 15. Remaining risks / notes for the Product Owner

1. **Browser UAT is mandatory** before this can be called verified; the checklist in §12 is the acceptance list.
2. In create mode the two spec/size-guide tables persist with `[ذخیره پیش‌نویس]` (metadata JSON); the per-table save
   button only appears once the product is loaded for edit — one write path, no second authority.
3. The hub still cannot intercept the browser Back button at the hub level (pre-existing behaviour); the Studio
   itself handles Back/forward **between steps** and every in-app back affordance is wired.
