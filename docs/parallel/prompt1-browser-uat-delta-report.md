# PROMPT 1 — FINAL BROWSER UAT DELTA — Report

Product Creation + Pricing Routing + Table Bugs + WMS Operability + Structure Management.

Branch: `arena/01a10ace-kolbevintage` · Base: `a72c61c` · Implementation commits: `f2c0435`, `8941848`, `8a15453`, `abbe03d`, `7cf62cf`
Content commit of this report: `dda00dd344aef7841441e615f1fdbe760cefe371`; repository HEAD at delivery is the tip of `arena/01a10ace-kolbevintage` (a documentation commit that pins this report — the exact SHA is recorded in the delivery summary). Local HEAD == remote HEAD and the working tree is clean.

Browser UAT is **not executable in this sandbox** (no Chromium binary; the chromium CDN is TLS-blocked and the required system libraries are absent with no package source — see §17). Every §20–§26 browser acceptance item is therefore reported **PENDING**, never PASS, and the verdict stays **NOT VERIFIED**.

---

## 1. Pricing route before / after

| | Before | After |
|---|---|---|
| Entry | Modal (`WorkspaceModal`) over the hub list, plus a second `DiscountManager` modal mounted inside Product Studio | One **full-page** `ProductPricingWorkspace` (`data-workspace="product-pricing"`) rendered as a real screen |
| Route | none — state only, lost on refresh | `#/admin/products/pricing/<productId>`; refresh/bookmark reopens the same product (hub `useEffect` → `productsApi.adminDetail`) |
| Entry points | hub row «تخفیف/جشنواره», Studio step | hub row «قیمتگذاری», **Product 360** «مدیریت قیمتگذاری», Studio «مدیریت کامل قیمتگذاری» and the price step — all resolve to the same productId and the same page |
| Back | modal close, list state lost | «بازگشت به محصولات کلبه» / «بازگشت به پیشنویس در حال تکمیل»; hub path restores view/search/filters and the saved `scrollY` and reloads; Studio path resumes the SAME draft |
| Authority | local discount/festival state inside the modal | canonical server model only: promotions/festival rules come from `promotionRulesApi` + server price resolver; the page never computes or stores a local discount |
| Numbers shown | raw UUIDs, enum-ish labels | header shows image/name/SKU/sales mode/publication state; the raw productId is never rendered («کد کالا ثبت نشده است» when there is no SKU) |

## 2. Promotion deep links (§2/§17)

«مدیریت تخفیف» / «مدیریت جشنواره» on the pricing page call `onOpenPromotionCenter("discount"|"festival")` → hub `onOpenPromo({productId, productName, anchor})` → `admin.tsx` sets `promoFocus` and switches to the canonical **کوپن و جشنواره** tab, where `PromoPanel` shows «تخفیفهای/جشنوارههای محصول «X» از همینجا مدیریت میشود» and opens the matching tab. The secondary button («ویرایش قوانین همین محصول» / «جشنوارههای این محصول») only scrolls within the page. There is no second promotion authority; the Studio's discount/festival cards are read-only with `[مدیریت تخفیف]`/`[مدیریت جشنواره]` deep links and no local ON/OFF draft.

## 3. Draft-first pricing handoff (§3/§21)

`handoff(target)` in the Studio:
1. `editing?.id ?? createdDraftId` — if a product already exists (edit, or a draft created earlier in this session), it opens the workspace for that id and **never creates a second product**.
2. otherwise it validates the minimum Draft requirements (`draftBlockers`) and, if any are missing, renders the exact Persian field list («برای رفتن به «قیمتگذاری» ابتدا این موارد را وارد کنید: …») while keeping every entered value.
3. otherwise it calls `createProduct("draft", { handoff: true })`, which persists ONE canonical Draft preserving all entered data (prices in rial, colours×sizes variants, `metadata.tables`, category/type specs) and returns the id, then opens the workspace for that id.
4. the CTA label is explicit: «ذخیره پیشنویس و رفتن به قیمتگذاری» before the draft exists, plain «قیمتگذاری» afterwards. In-flight is guarded by `handoffBusy`; a failure keeps the Studio state and deep-links as before.

Creation still writes **zero stock**; WMS owns opening inventory.

## 4. Dynamic-table column-delete root cause and fix (§4)

**Root cause.** The old editor derived every operation from render-time props and committed a column delete as **two** `onChange` calls: first the new column list, then the rows rebuilt without the deleted cell. The second call was computed from the *stale render snapshot*, so it carried the pre-delete column list back into the caller — the header reappeared and the delete looked broken (and could also re-introduce the cell on reload).

**Fix.** `src/components/table-ops.ts` implements the operations as pure `DataTable → DataTable` functions, and `dynamic-table-editor.tsx` commits exactly once per user action (`const commit = (next) => onChange(next)`), so a stale second commit cannot exist. `normalizeTable` also drops unknown/stale cells and duplicate column ids (no duplicate React keys), and a successful save re-normalises the server echo. Covers add / rename / delete / reorder for columns and rows plus cell edit; the same component drives «مشخصات فنی» and «راهنمای سایز», and there are still exactly two simple 2D tables — no template, binding, schema or live connection returned.

## 5. Publication behaviour (§7/§25)

- WMS receipts never publish (proved by `PUBLISH-01`: Draft → receipt → still `draft` → explicit publish → `published`).
- «انتشار محصول» is the only writer of catalogue state: it runs the canonical validator (422 `PUBLICATION_INCOMPLETE` with the exact Persian issue list, mutating nothing) and is idempotent/guarded in flight; «محصول منتشر شد» on success.
- a publishable product with **zero stock** publishes (`منتشرشده` + ناموجود), and a sold-out published product stays published.
- publication is `stockIndependent: true`; `inventory_setup` never gates it.
- after publish the hub list reloads so the row, the «منتشرشده» filter and the admin `view=published` listing all show it.

## 6. Inventory vs publication semantics (§6)

WMS now speaks **inventory only**: موجودی فیزیکی، قابل تخصیص، رزروشده، آسیبدیده، در راه. «قابل فروش» is renamed «قابل تخصیص» across the WMS surfaces (labels in `contracts.ts` `WMS_LABEL`, KPI header, tables, modals, series/settings panels). Catalogue publication is a **separate** column and filter «وضعیت انتشار» (پیشنویس / منتشرشده / آرشیو) fed by `products.status`; the sale-flag column is «وضعیت عرضه» (در حال عرضه / این تنوع متوقف / عرضه متوقف (محصول) / آرشیو) and its dialog states explicitly that it changes neither publication nor stock. A persisted Draft with stock therefore reads: stock present, «پیشنویس» — no contradiction, and nothing auto-publishes.

## 7. WMS default sort + all options (§8/§9)

Server-side, `GET /api/v1/inventory`:
`newest` (default) = `product_created_at DESC, balance_updated_at DESC, sku, warehouse_code, inventory_domain`; `oldest` = ascending equivalent; `stock_desc` / `stock_asc` = `on_hand`; `available_desc` / `available_asc` = computed `available`; `name_asc` / `name_desc` = `product_name`. Every option carries stable tiebreakers, so ordering is deterministic and never the DB's incidental row order. The Persian control offers: جدیدترین، قدیمیترین، بیشترین موجودی، کمترین موجودی، بیشترین قابل تخصیص، کمترین قابل تخصیص، نام محصول: الف → ی، نام محصول: ی → الف. The browser sends the parameter and never sorts the full inventory client-side (enforced by the gate).

## 8. WMS filters (§10/§11)

Real, server-backed, combinable with the ordering: text search (name/SKU/colour/size), **canonical Category** (from `siteApi.categories()`, the same catalogue taxonomy the Studio uses), warehouse, inventory domain, availability (`stockStatus`: موجود / رو به اتمام / ناموجود / در راه / کاملاً رزرو), publication state, ownership (کلبه/تأمینکننده, wholesale), colour, size, «دارای در راه», «دارای رزرو». UX: one compact bar (search + ترتیب + «فقط موجودی کم»), a filters toggle that collapses the grid on small screens, removable chips for every active filter, «پاک کردن فیلترها» (which also restores the default ordering) and a live result count «N ردیف مطابق فیلتر · مرتبسازی: …» — no raw query names anywhere.

## 9. Product Structure CRUD + safe delete (§12–§15)

Every applicable structural record now has row actions ویرایش / فعال‑غیرفعال / حذف plus ordering: gender/season taxonomies, **product types and their sizes** (new «انواع محصول و سایز» tab — previously read-only), spec attributes, spec templates and size guides. Long lists have search, an active/inactive filter and a result count (taxonomies are filtered server-side via `q`/`active`/`total`; the others client-side). Editing exposes the Persian label, display order and active status only — never a UUID, timestamp or raw column — and the canonical **code is immutable** because products reference it.

Safe delete is a server decision with an actionable Persian reason:
- **unreferenced** → hard delete (`DELETE /admin/taxonomies/:id` deleted+audited, size delete, guide/type delete);
- **referenced** → 409 and nothing is destroyed: ««X» در N محصول استفاده شده است و حذف آن تاریخچه را خراب میکند؛ بهجای حذف، آن را «غیرفعال» کنید تا از فرم محصولات جدید حذف شود و محصولات قبلی سالم بمانند.» (types: «… ابتدا آن را غیرفعال کنید.» / sizes: «این سایز در واریانتی استفاده شده است…» / guides: «… بهجای حذف، آن را بایگانی کنید.»). The confirmation dialog offers «غیرفعال کردن بهجای حذف» once the server refuses, so the operator can always complete the intent.
- deactivation always works, never touches history, and removes the value from NEW products only; existing products keep rendering it (asserted for both a season and a size).
- no cascade delete of history anywhere.

## 10. Other real defects fixed in scope (§19)

- `productsApi.adminDetail`-based deep link: a refreshed pricing URL no longer silently loses the workspace (previously impossible — the surface had no URL at all).
- Studio's standalone mount (legacy full-page entry) rendered the pricing modal with a stale local `DiscountManager` instance; it now renders the same full page with its own `backLabel`.
- WMS bulk-sale toolbar and scope dialog wording implied publication; both now state that only «عرضه» changes.
- Table headers: the new «وضعیت انتشار» column was added to both the group and variant rows (retail/wholesale column counts verified against the header).
- Two orphan modules were a silent parallel-authority / second-WMS-surface risk (see §12).
- jsdom/browser leftovers and `.playwright-cli` artifacts stayed out of the tree; `dist/` and build caches were restored after each build.

## 11. Files changed (27)

`src/components/table-ops.ts` (new), `src/components/dynamic-table-editor.tsx`, `src/components/discount-manager.tsx`, `src/components/kolbe-products-hub.tsx`, `src/components/product-structure-panel.tsx`, `src/components/promo-panel.tsx`, `src/components/series-stock-panel.tsx`, `src/components/warehouse-settings.tsx`, `src/components/product-specs-editor.tsx` (deprecation header), `src/data/api.ts`, `src/data/contracts.ts`, `src/portals/admin-product.tsx`, `src/portals/admin.tsx`, `src/portals/warehouse-hub.tsx`, `src/portals/admin-wms-panel.tsx` (deprecation header + wording), `backend/src/inventory.ts`, `backend/src/product-types.ts`, `backend/src/pricing-wms-structure.test.ts` (new), `backend/scripts/dynamic-table-smoke.ts` (new), `backend/scripts/pricing-routing-smoke.ts` (new), `backend/scripts/frontend-contract-smoke.ts`, `backend/scripts/qa-responsive-static.mjs`, `backend/scripts/warehouse-ux-browser.mjs`, `backend/package.json`, `backend/.gitignore`, `MATRIX.md`, `REVIEW_FA.md`.
Total: 2,022 insertions / 416 deletions.

## 12. Dead code / duplicate authority (§5 of the continuation brief)

- `src/components/product-specs-editor.tsx` — **no importers**. A former parallel authority (legacy `product_spec_values` + size-guide rows) superseded by the Studio's dynamic tables and the structure dictionaries. **Retained**, marked `⚠ DEPRECATED — RETAINED, NOT RENDERED`, and the `pricing-routing` gate fails if any module imports it again — reconnection must be a deliberate decision. Removal is still an open PO decision (previously flagged in `prompt1-final-product-studio-remediation.md`).
- `src/portals/admin-wms-panel.tsx` — **no importers**. Superseded second WMS surface; same treatment and gate, because remounting it would reintroduce exactly the terminology and sort/filter inconsistencies this delta removed.
- `MATRIX.md` / `REVIEW_FA.md` still named the old panel as *the* WMS UI; corrected to `warehouse-hub.tsx`.
- Old pricing modal: **deleted** (the `DiscountManager` export no longer exists), so no parallel pricing authority can be re-mounted by accident.

## 13. Schema / migration impact

**None.** No migration added and none modified: the embedded verifier still applies exactly the 51 known migrations and a second run is a no-op. Dynamic tables live in the existing `products.metadata.tables.{specs,sizeGuide}` JSON; WMS sorting/filters are query-only; structure CRUD uses existing tables/columns (label/active/position + code immutable).

## 14. Backward compatibility

Legacy rows remain readable and are never rewritten: `product_spec_values` and `product_size_guides` are untouched, sex/season values referenced by old products still resolve after deactivation, and inactive structure values are simply not offered to new products. Legacy `GET /api/v1/admin/products` `status=all|active|archived` keeps working (only `view=` is used for the published listing). `GET /admin/taxonomies` returns the same complete list when called without query params. The pricing workspace is additive for the legacy Studio mount and replaces (not duplicates) the removed modal.

## 15. Skills available / used

No frontend-design or taste skill is installed in this environment (`~/.claude`, `~/.config/claude`, `SKILL.md`, plugins — all absent), and installing one is out of scope. The work used the repository's own design system (`src/components/primitives`, `kv-table`, `Card`, `Btn`, `Field`) plus the product knowledge pack (`docs/product/*`), per `AGENTS.md`. Stated honestly: **no design skill was loaded or used.**

## 16. Exact final test counts (final code, re-run after the last edit)

| Gate | Result |
|---|---|
| `npm run test:embedded` (34 suites, fresh embedded Postgres, migration verifier) | **206 tests / 206 pass / 0 fail / exit 0**; verifier: *51 migrations applied; second run was a no-op* |
| ↳ `src/product-publication.test.ts` (publication suite, standalone fresh DB) | 5 / 5 pass |
| ↳ `src/product-draft-lifecycle.test.ts` (Prompt-1 lifecycle) | 8 / 8 pass |
| ↳ `src/pricing-wms-structure.test.ts` (new: WMS + structure + publication independence) | 5 / 5 pass |
| ↳ `src/wms-workflows.test.ts` | 6 / 6 pass |
| ↳ `src/series-inventory.test.ts` | 8 / 8 pass |
| `npm run test:contract` (frontend contract smoke) | **132 / 132 checks**, exit 0 |
| `npm run test:dynamic-table` (new regression gate) | **14 / 14 checks**, exit 0 |
| `npm run test:pricing-routing` (new routing/authority gate) | **28 / 28 checks**, exit 0 |
| `node scripts/qa-responsive-static.mjs` | **1 / 1 PASS** (11 Prompt-1 surfaces, 28 fixed/min widths inspected) |
| frontend `tsc --noEmit` | 0 errors |
| backend `tsc --noEmit` | 0 errors |
| `vite build` (production, singlefile) | exit 0, `dist/index.html` 2,376.71 kB (gzip 586.37 kB); `dist/index.html` restored afterwards |
| migration verifier | included above — ALL PASSED |

Old tests were strengthened, never weakened: the contract smoke's table checks now follow the new pure operations **and** assert single-commit semantics; the WMS browser gate's wording assertions were updated to the new (correct) labels.

Note: this environment initially could not run `vite build` at all — the checkout shipped only Windows rollup binaries. Installing the platform-native `@rollup/rollup-linux-x64-gnu` (npm registry reachable) fixed it; no dependency was added to any `package.json`.

## 17. Browser UAT — PENDING (not PASS)

Chromium is not available and cannot be obtained: no `chrome`/`chromium` binary or puppeteer browser cache exists; `puppeteer`'s browser download fails («Failed to set up chrome v148…» because `storage.googleapis.com` is TLS-blocked); the required runtime libraries (`libnss3`, `libgbm`, `libatk`, `libpango`, `libcups`, `libdrm`, `libxkbcommon`, `libasound`) are all absent, we are not root, and no Debian package source is reachable. `backend/scripts/browser-admin-smoke.mjs` starts its server and database normally and then fails at `Browser was not found at the configured executablePath (/tmp/chromium)` — i.e. the gate is environment-blocked, not code-blocked.

The following are **PENDING** and must be executed in a browser before this delta can be accepted:
1. real publish flow (UI publish → reload → visible in همه surfaces + Published filter);
2. pricing route flow (modal-free page, correct product, Back returns, Studio opens the same workspace);
3. draft-first handoff (one Draft persisted, return resumes the same productId, no duplicate);
4. dynamic-table browser interactions (delete first/middle/last column, save+reload, rename/reorder row/column);
5. WMS sort/filter interaction (default newest-first, each sort option, combined filters, clear filters);
6. structure CRUD interaction (edit / activate-deactivate / delete, referenced-delete refusal + Persian reason);
7. responsive measurement at 360 / 390 / 768 / 1024 / 1280 / 1440 (no page-level horizontal overflow);
8. console/network browser checks (no swallowed errors, no failed requests).

Static gates substitute only for the structural parts of the above — they are **not** a substitute for browser UAT.

## 18. Commits / repository state

Implementation and gates (branch `arena/01a10ace-kolbevintage`, base `a72c61c`):

| SHA | Contents |
|---|---|
| `f2c0435` | atomic single-commit dynamic tables + `table-ops.ts` + Studio draft-first handoff + table regression gate |
| `8941848` | canonical full-page pricing workspace, product-scoped promotion deep links, routing gate |
| `8a15453` | WMS server-side newest-first sorting, real filters, inventory-only wording |
| `abbe03d` | structure CRUD, safe delete, display order, server-side taxonomy filtering |
| `7cf62cf` | new test suite registration, static coverage, loud deprecation of the two orphan modules, doc corrections |
| *(this report)* | `docs/parallel/prompt1-browser-uat-delta-report.md` |

Repository state at delivery: `local HEAD == origin/arena/01a10ace-kolbevintage`, working tree clean (0 modified/untracked files), no `dist/`/`node_modules` churn, `main` untouched at `3cd9dac`, no merge to `main`.

## 19. Remaining risks / open items

1. **Browser UAT not executed** — the single blocking item for verification; all eight flows in §17 must be run in a browser.
2. `product-specs-editor.tsx` and `admin-wms-panel.tsx` are retained-but-deprecated; a PO decision is still needed to delete them or give them an owner (until then the gate prevents silent reuse).
3. The hub's product-scoped «مدیریت موجودی» is presented as a focused modal; §18 names pricing/promotion/structure as the surfaces that must be full pages, so it was left as-is rather than redesigned (recorded here as an observation, not a fix).
