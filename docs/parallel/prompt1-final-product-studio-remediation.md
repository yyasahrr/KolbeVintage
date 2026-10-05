# KOLBE PRODUCT LIFECYCLE + INITIAL INVENTORY FINAL REPORT

**Prompt:** `PROMPT 1 — FINAL PRODUCT STUDIO UX + LOGIC + PUBLICATION REMEDIATION`
**Branch:** `arena/01a10ace-kolbevintage` (Prompt 2 NOT started)
**Base of this pass:** `08596ef` · **Head at report time:** the commit that carries this report
(§17 records how it was verified against the remote, so this line cannot go stale)
**Date:** 2026-10-05

---

## 1. PUBLICATION ROOT CAUSE

**The canonical path had no wired publish action at all, and the server had no publication
semantics to fail loudly.** Verified by reading the pre-fix code at `08596ef` (not by
inference):

| Evidence | What it proves |
|---|---|
| `git show 08596ef:src/portals/admin-product.tsx \| grep "productsApi.status("` → **one hit, line 867**, inside the `<Switch>` of the Studio's *own* product-list table. | The only publish control in the whole Studio lived in the list. |
| The same file renders that list under `{!open && !embedded && (<>` … — the hub mounts `<ProductStudio … embedded>`, so from «محصولات کلبه» the list (and its publish switch) **never renders**. | The operator's path had **zero** publish controls. |
| `kolbe-products-hub.tsx` at `08596ef`: no `productsApi.status`, no «انتشار» — only row actions ویرایش / ۳۶۰° / قیمت‌گذاری / ورود اولیه کالا. | The hub could not publish either. |
| The Review step (`sec === "review"`) contained a checklist, a summary and the note «همه بخش‌ها کامل است — می‌توانید «ذخیره و ادامه» را بزنید…» — **no publish button**. | «بازبینی و انتشار» promised a Publish step that did not exist. |
| `PATCH /api/v1/products/:id/status` at `08596ef` wrote `status` with no validation, no readiness endpoint and no response the UI ever read back into the hub. | Even a switch press gave no state feedback and never reloaded the canonical read model. |

So the four defect categories the prompt listed that actually applied were: **publish button not
wired**, **no publish authority in the canonical surface**, **frontend state/read-model not
reloaded**, and **backend accepting publication without a canonical validator**. Categories that
did **not** apply: wrong `saveIntent`, wrong enum, inventory blocking publication, WMS treated as
lifecycle state — all were explicitly verified as *not* the cause (see §3/§4).

---

## 2. EXACT PUBLISH FLOW — BEFORE / AFTER

**Before (08596ef)**

```text
Review & Publish step  →  no action exists  →  (dead end)
legacy Studio list (only in non-embedded mounts) → Switch → productsApi.status(PATCH)
   → PATCH /products/:id/status writes status, no validation
   → flash «… منتشر شد» in that component only
   → hub list (catalogOpsApi.adminProducts) never reloaded
```

**After**

```text
Review & Publish step
  ├─ GET /admin/products/:id/publication-readiness  → server checklist (issues + step codes)
  ├─ «انتشار محصول»  (disabled in flight, disabled once published)
  │    └─ PATCH /products/:id/status {status:'published'}
  │         └─ publicationReadiness() runs INSIDE the request, before the transaction
  │              ├─ issues  → 422 PUBLICATION_INCOMPLETE {details.issues[]} → no mutation, no audit
  │              └─ ready    → UPDATE products SET status='published' + audit + outbox
  ├─ success → «محصول منتشر شد» → setPublicationState('published')
  │            → refreshPublication() → reload() (store) → loadServerDrafts() → onPublished() (hub reload)
  └─ failure → the server's Persian issue list is rendered inline AND flashed; the operator's draft is untouched
```

---

## 3. EXACT BACKEND / FRONTEND FIX

**Backend — new `backend/src/publication.ts`**

- `publicationReadiness(db, productId)` — the single canonical validator. Requirements enforced
  (only what the domain states):
  `name`, `category`, at least one sales channel, retail ⇒ `cash_price_rial > 0` **(and a valid
  installment base price when installments are not disabled)**, retail ⇒ ≥ 1 active variant,
  wholesale ⇒ a priced active series **or** a product-level wholesale price, and `moq ≥ 1`.
  Premium: nothing speculative is demanded — **media and physical stock are deliberately absent**.
- `publicationBlocked()` → `422 PUBLICATION_INCOMPLETE` carrying `details.issues[{code,label,step}]`
  and `details.labels[]`, with the canonical message «برای انتشار محصول این موارد را تکمیل کنید:».
- `registerPublicationRoutes()` → `GET /api/v1/admin/products/:id/publication-readiness`.
- `catalog.ts` → `PATCH /products/:id/status` calls the validator **only when the target status is
  `published`**, before the transaction. Unpublish/archive paths are unchanged.

**Frontend**

- `admin-product.tsx`: `publishProduct()` — in-flight guard (`publishing`), success feedback,
  immediate local state, then re-reads readiness + reloads store drafts + notifies the hub
  (`onPublished`). Failures render the server issue list and never clear the form.
- Review step: publication state banner (منتشرشده / قابل انتشار / فهرست دلایل)، each issue is a
  button that jumps to the canonical step that fixes it (`setSec(issue.step)`)، and the explicit
  «انتشار محصول» action.
- The list publish switch (legacy list, still used by `admin-retail.tsx`) now surfaces the same
  Persian issue list instead of a raw error, so **no publish path can fail silently anywhere**.
- `admin-api.ts`: `AdminApiError` now carries `details`, so the server's structured payload reaches
  the UI instead of being flattened into a message string.
- `api.ts`: `catalogOpsApi.publicationReadiness()`.

---

## 4. WAS INVENTORY INCORRECTLY COUPLED TO PUBLICATION?

**No — and this was verified, not assumed.**

- `publication.ts` contains **no** reference to `inventory_setup`, `stock_balances`,
  `series_stock_balances` or any receipt table. `stockIndependent: true` is returned to the UI and
  asserted by tests.
- Publication is provably stock-free: `product-publication.test.ts` §19 publishes a product with
  **zero** stock and `inventory_setup='pending'` → 200 / `published`; and PUBLISH-01 proves a
  completed WMS receipt (`inventory_setup='configured'`, 120+30 pieces) leaves the product
  `draft` until an explicit publish.
- The search for a legacy blocker found the opposite risk: the *absence* of any publication
  surface. `inventory_setup` is still only used as an internal invariant for the «—» vs `0`
  distinction and for the «ورود اولیه کالا» row action; it is never a lifecycle state and never
  gates publication.
- Legitimate catalog validation was **not** weakened: identity, category, channel, channel pricing
  and sellable variants are enforced server-side (they were previously unenforced at publication
  time). One speculative requirement that I initially added — “at least one image” — was **removed**
  after it broke 16 pre-existing domain tests that publish image-less catalog rows; the domain does
  not state media as a publication requirement, so enforcing it would have been an invented rule.

---

## 5. PRICING UX — BEFORE / AFTER

| Aspect | Before | After |
|---|---|---|
| Mode control | Nothing named «حالت قیمت خرده/عمده» in the Studio; channel chosen via «نوع فروش» Segmented in base, while `discount-manager.tsx` showed a *second* «حالت قیمت خرده» segmented | **ONE** editable «حالت فروش» control (فقط خرده / فقط عمده / خرده + عمده) in «اطلاعات پایه»; the pricing step shows a read-only reflection line + «تغییر حالت فروش» shortcut |
| Steps | 10 steps, with «سری‌های عمده» as a separate step that was *hidden* when wholesale was off (and «قیمت‌گذاری» hidden when retail was off) | 8 fixed steps; wholesale pricing lives **inside** «قیمت‌گذاری» under «فروش عمده» |
| Retail | «قیمت پایه خرده — نقدی» + «قیمت مخصوص چهارقسطه» (empty field = equal to cash, ambiguous) | «فروش خرده» card: «قیمت نقدی پایه (تومان)» (marked الزامی), an explicit «خرید چهارقسطه» switch with ON/OFF semantics, «قیمت پایه چهارقسطه (تومان)» shown only when enabled, «سیاست اعمال تخفیف روی خرید چهارقسطه» |
| Wholesale | MOQ field + Series editor labelled «قیمت کل سری» / «جمع قیمت اجزا» | Same canonical model, business copy: «قیمت کل سری» / «محاسبه قیمت از اجزای سری», with an explanatory sentence — no new pricing truth |
| Installment copy | «هر قسط…» plus a policy select always visible | Per-installment amount only when enabled; policy select only when enabled |
| Resolver jargon | Intro text mentioned «موتور Pricing Resolver» | Business copy: «قیمت نهایی مشتری در زمان خرید توسط سرور و با اعمال تخفیف‌ها و جشنواره‌ها محاسبه می‌شود.» |
| Discount / Festival | (no local ON/OFF exists in the Studio — verified) | Two **read-only** cards: «تخفیف محصول» (active/configured/suspended counts from `promotionRulesApi.productSummary`) and «جشنواره» (membership + effective state + festival name), each with «مدیریت تخفیف» / «مدیریت جشنواره» opening the canonical `DiscountManager` for **this** product |
| Layout | Intro paragraph + a stacked form; the summary grid reserved a half-empty column at ≥1024px | Full-width cards; the discount/festival pair uses `lg:grid-cols-2` (two balanced cards) — no reserved empty column, no detached labels |

---

## 6. SPECS + SIZE GUIDE — BEFORE / AFTER

**Before**

- Two separate steps (6. مشخصات فنی، 7. راهنمای سایز).
- In edit mode both mounted `ProductSpecsEditor` — a template-bound editor with «قالب مشخصات»,
  «اتصال زنده» / «کپی ثابت» binding modes and an attribute catalogue.
- In create mode the step either rendered the category's schema fields or an `Empty` telling the
  operator to save first («… روی سرور نیاز دارند؛ بعد از ذخیره…») — and the size guide was always
  a dead-end in create mode.
- Data model: `product_spec_values` (global attribute catalogue, `code ~ ^[a-z0-9_-]{2,60}$`) and
  `size_guides` (shared guides + `product_size_guides` link/detached). Neither can express an
  arbitrary per-product table: Persian column labels are legitimate and the shape is 2D.

**After**

- One step: «مشخصات و راهنمای سایز» (step 6 of 8), containing **two independent tables**.
- Both are edited with the new shared `src/components/dynamic-table-editor.tsx`:
  add / rename / delete / reorder columns, add / delete / reorder rows, direct cell editing,
  accessible icon actions (Persian `aria-label`, 32px targets, visible focus), and the canonical
  empty state «هنوز اطلاعاتی ثبت نشده است.» with `[+ افزودن ستون]` / `[+ افزودن سطر]`.
- No template, no schema, no binding, no prerequisite. Category attribute requirements remain
  available **in business language** («ویژگی‌های دسته «X»»، الزامی badge) because the server
  enforces them for storefront filtering — they never gate the tables.
- There is no longer any «راهنمای سایز» step, screen or modal reachable from the Studio.

---

## 7. COMPLETE PRODUCT STUDIO STEP STRUCTURE (FINAL)

```text
1. اطلاعات پایه                    (incl. the single «حالت فروش» control)
2. رنگ و سایز                     (matrix + variant weight)
3. تصویر و ویدیو                   (SafeImg placeholder, no broken glyphs)
4. تصویر استایل‌بیلدر
5. قیمت‌گذاری                      (فروش خرده · فروش عمده/سری · read-only تخفیف + جشنواره)
6. مشخصات و راهنمای سایز           (two arbitrary tables + category attributes)
7. سئو و کانال‌ها
8. بازبینی و انتشار                (server checklist · «انتشار محصول» · خلاصه محصول)
```

Footer in create mode: `[انصراف]` `[ذخیره پیش‌نویس]` `[ذخیره و ادامه]` — unchanged, no
«ذخیره و انتشار». In edit mode: `[انصراف]` `[ذخیره تغییرات]`. No numbering gaps, no orphaned
references, and the nav list is fixed (nothing is hidden by mode, so required work is always visible).

---

## 8. ADDITIONAL UX / LOGIC ISSUES FOUND AND FIXED IN THIS PASS

1. **Dead publish path** (the report's §1 defect).
2. **Steps hidden by mode** — «قیمت‌گذاری» disappeared for wholesale-only products and
   «سری‌های عمده» for retail-only ones, so the section that fixes a blocked publish could not be
   reached. Fixed by the fixed 8-step nav.
3. **Duplicate mode control** — the pricing step initially duplicated the base Sales Mode; reduced
   to one editable control plus a read-only reflection (one authority per capability, §16).
4. **Broken-image glyphs** — hub rows, the Studio media grid and Product 360 rendered
   `<img>` with no error path. New shared `SafeImg` keeps the box's aspect ratio and shows a
   deliberate placeholder (`aria-label="… — تصویر در دسترس نیست"`).
5. **Raw error on the list publish switch** — a blocked publish showed an opaque message; now the
   same Persian issue list as the Studio.
6. **`AdminApiError` dropped structured details** — the server's actionable payload never reached
   the UI; now forwarded.
7. **Required fields were invisible** — `Field` gained a `required` badge; the retail cash price
   uses it, and each unmet category attribute already renders a field-level error.
8. **Icon-only table actions** — reorder/delete are now labelled buttons with `aria-label`,
   `title`, ≥32px hit area and visible focus rings.
9. **Sidebar and step-hiding interplay** — the merged step is one nav entry, so the sidebar no
   longer shows a stale «راهنمای سایز» entry pointing at a screen that no longer exists.
10. **`product-specs-editor.tsx` is now unimported** (its only mount points were the removed Studio
    steps). It is **kept, not deleted** (§12 forbids destroying existing capability) and is
    documented as an optional future productivity tool; with no entry point it cannot act as a
    second authority.
11. **Wholesale series wording** — «جمع قیمت اجزا» → «محاسبه قیمت از اجزای سری» (the wording the
    prompt specifies), without changing the persisted `pricing_mode` values.
12. **Review step never showed the product's publication state** — it does now, with the reason
    when blocked and the action when allowed.

Not changed on purpose (no aesthetics-only redesign): unrelated Admin surfaces, `محصولات عمده`,
Supplier Portal, WMS IA, Discount Center, Finance.

---

## 9. EXACT FILES CHANGED AND WHY

**Backend**

| File | Why |
|---|---|
| `backend/src/publication.ts` **(new)** | Canonical publication validator + readiness route + 422 payload |
| `backend/src/catalog.ts` | `PATCH /products/:id/status` runs the validator before publishing |
| `backend/src/app.ts` | registers the publication routes |
| `backend/src/specs.ts` | `{ table }` support on `PUT /products/:id/specs` and `PUT /products/:id/size-guide`; projection of a dynamic size guide into the legacy public shape; audited, transactional read-modify-write of `metadata.tables` |
| `backend/src/product-publication.test.ts` **(new)** | PUBLISH-01, zero-stock publication, validation failure, wholesale requirement, two independent tables |
| `backend/src/product-draft-lifecycle.test.ts` | sold-out lifecycle fixture now carries the image the Studio create contract already requires (no rule weakened) |
| `backend/package.json` | new suite added to the `test` script |
| `backend/scripts/frontend-contract-smoke.ts` | publication API contract + static Studio contract (131/131) |
| `backend/scripts/qa-product-studio.mjs` | browser gate rewritten for the 8-step Studio, mode split, dynamic tables, PUBLISH-01, blocked publish, extended responsive sweep |
| `backend/scripts/browser-admin-smoke.mjs` | `[افزودن محصول]` direct-open + §18 PUBLISH-01 scenario + §26-G/§26-I static assertions; price label updated |
| `backend/scripts/qa-responsive-static.mjs` | also scans the two new table surfaces (9 surfaces) |

**Frontend**

| File | Why |
|---|---|
| `src/portals/admin-product.tsx` | 8-step nav, merged specs step, adapted pricing + read-only promotion cards, publication action/state, `metadata.tables` persistence, `SafeImg`, `Field required`, step deep-links, single Sales Mode authority |
| `src/components/dynamic-table-editor.tsx` **(new)** | the shared dynamic 2D table editor + `useProductTable` transport (load/save/error, never loses edits) |
| `src/components/primitives.tsx` | `SwitchRow` (44px row switch), `SafeImg` (no broken glyphs), `Field required` badge |
| `src/components/kolbe-products-hub.tsx` | `onPublished` reload, `SafeImg` cover |
| `src/components/product-360.tsx` | `SafeImg` for the media grid |
| `src/components/product-series-editor.tsx` | «محاسبه قیمت از اجزای سری» wording |
| `src/data/api.ts` | `catalogOpsApi.publicationReadiness`, table-aware specs/size-guide writers, `sizeGuidesApi.productGuide` → authenticated client |
| `src/data/admin-api.ts` | `AdminApiError.details` |
| `src/data/contracts.ts` | `metadata.tables` + `ProductStudioDraft.tables` (payload shape only) |
| `docs/parallel/prompt1-final-product-studio-remediation.md` **(new)** | this report |

---

## 10. PERSISTENCE / SCHEMA IMPACT

| Question | Answer |
|---|---|
| Current persisted representation (before) | Specs: `product_spec_values` rows keyed by a global `spec_attributes` catalogue (+ `spec_templates` binding via `product_types`). Size guide: `size_guides` / `size_guide_columns` / `size_guide_rows` shared by products through `product_size_guides(mode link/detached)`. Plus legacy free-form `products.specifications` JSONB. |
| New persisted representation | `products.metadata.tables = { specs?: DataTable, sizeGuide?: DataTable }` where `DataTable = { columns: {id,label}[], rows: {id, values: Record<columnId,string>}[] }`. |
| Why that storage | `metadata` is already the product's own JSON domain column, so an arbitrary per-product table needs **no new table, no join and no new authority**. |
| Schema migration necessary? | **No.** Verified: `git diff --stat <base>..HEAD -- backend/src/migrations` is empty; `verify-migrations.mjs` still passes. |
| Read compatibility | `GET /products/:id/specs` returns the table **and** projects it into the legacy `values[]` shape; `GET /products/:id/size-guide` returns `{mode:'table', guide:{columns,rows}}` in the exact shape a linked guide used, so the storefront modal and Product 360 render it unchanged. |
| Write compatibility | `PUT /specs` still accepts `{values[], addToTemplate}` and `PUT /size-guide` still accepts `{guideId, mode}`; the new `{table}` variants are additive. |
| Existing data | Nothing is deleted or rewritten: legacy rows remain and are served whenever no dynamic table exists. `product-specs-editor.tsx` is retained for the optional template workflow. |

---

## 11. BACKWARD COMPATIBILITY

- Legacy API shapes: `/admin/products/needs-setup`, `?view=`, `?status=`, `?owner=`, `?setup=`
  filters, `PATCH /products/:id` (`saveIntent`), the specs/size-guide payloads above — all still
  accepted; the full embedded suite (including the RBAC/privacy suites) passes unchanged.
- Products published before this pass are untouched; the validator only runs on a **new**
  transition to `published`, and re-publishing an already published product is a no-op.
- Existing product list rows without a cover keep rendering (SafeImg placeholder), and the
  storefront/public endpoints were not changed.
- No `dist`, `node_modules`, browser artifacts or generated churn were committed.

---

## 12. SKILLS ACTUALLY USED

**Honest answer: no skill was available to load, and none was loaded.**

- `~/.claude/`, `~/.claude/skills/`, any `plugins/` tree and any `SKILL.md` anywhere on the
  filesystem: **absent** (searched before starting). `frontend-design` and
  `taste-skill`/`Leonxlnx/taste-skill` are **not installed** in this environment, and the prompt
  forbids installing new dependencies or skills for this pass, so none was installed.
- What was used instead — and what it changed:
  1. `AGENTS.md` + `docs/product/*` (read: README, MANIFEST, SOURCE_OF_TRUTH, DOMAIN_RULES,
     PRODUCT_DECISIONS_REQUIRED, AGENT_AUDIT_PROTOCOL fully; the remaining knowledge files were
     queried for publication/draft/pricing/specs statements). The audit protocol drove the
     three-pass shape of this work (Discover → Remediate → Verify), the "no parallel authority"
     rule drove §16 decisions, and the counterexample rule is what removed my invented
     image requirement.
  2. The repository's own design system (`primitives.tsx`, `kv-*` utilities, RTL/Persian copy
     conventions) was used as the UI/UX skill substitute: every new control reuses `Btn`, `Card`,
     `Field`, `SwitchRow`, `LoadingState` and the existing token set rather than inventing styles.
  3. The visual review was done by reading rendered structure (DOM shape, `aria-*`, layout
     classes, `lg:grid-cols-2` balance, `min-w` wrappers) plus the static responsive lint — with
     the explicit caveat that this is **not** a substitute for the browser sweep (§13).

---

## 13. BROWSER RESULTS AT EACH REQUIRED BREAKPOINT

**PENDING — not executed.** No Chromium/Chrome binary exists in this environment and none can be
obtained (`storage.googleapis.com`, `cdn.playwright.dev` and the Debian mirrors are unreachable;
`libnss3`/`libgbm`/`libatk`/`libpango` are absent). jsdom was re-tested and is a dead end for this
bundle (single-file ESM bundle; 13 DOM nodes / 0 console messages prove nothing). Therefore:

| Breakpoint | Product Hub | Studio basic | Color × Size | Pricing | Specs+Size Guide | Review & Publish | Product 360 | Initial Inventory |
|---|---|---|---|---|---|---|---|---|
| 360 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| 390 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| 768 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| 1024 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| 1280 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |
| 1440 | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING |

Executed instead (static, **not** a browser PASS): `qa-responsive-static.mjs` → `1/1 PASS` over
**9 surfaces / 25 fixed widths ≥320px**, every one inside a horizontal scroll container or clamped.
The browser sweep that now covers the new sections + hub + Product 360 is written and will run in
`qa-product-studio.mjs §40` / `browser-admin-smoke.mjs` as soon as a browser exists.

---

## 14. NETWORK / CONSOLE RESULTS

**PENDING — not executed** for the same reason (no browser ⇒ no console, no network log). No claim
of a clean console is made. The defects this pass fixes are exactly the class §24 targets
(silent publish failure, duplicate submission, raw errors); each is now covered by an explicit
browser assertion plus a server-side test, but the browser run itself has not happened here.

---

## 15. EXACT FINAL TEST COUNTS (final code, this pass)

| Gate | Command | Result |
|---|---|---|
| Full embedded backend suite | `cd backend && npm run test:embedded` | **201 tests / 21 suites / 201 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo** (166.9 s) |
| New publication + lifecycle + series + wholesale + WMS suites together | `node .scratch/run-some.mjs src/product-publication.test.ts src/product-draft-lifecycle.test.ts src/series-inventory.test.ts src/wholesale_inventory_promotions.test.ts src/product-wms-foundation.test.ts` | **36 / 36 pass, 0 fail, 0 skipped** |
| New publication suite alone | `node .scratch/run-one.mjs src/product-publication.test.ts` | **5 / 5 pass** (PUBLISH-01, §19 zero-stock, §20 failure, wholesale series, §22 two tables) |
| Frontend contract smoke | `cd backend && npx tsx scripts/frontend-contract-smoke.ts` | **131 / 131 checks passed** (was 112 before this pass) |
| Frontend TypeScript | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0 errors** |
| Backend TypeScript | `cd backend && npx tsc -p tsconfig.json --noEmit` | **0 errors** |
| Production build | `node node_modules/vite/bin/vite.js build` | **exit 0** — 2013 modules, `dist/index.html` 2,339.37 kB (gzip 577.96 kB), 7.65 s |
| Responsive static QA | `cd backend && node scripts/qa-responsive-static.mjs` | **1 / 1 PASS** (9 surfaces, 25 widths) |
| Migration verifier | `cd backend && node scripts/verify-migrations.mjs` | **ALL CHECKS PASSED**, exit 0 |
| Migration diff | `git diff --stat <base>..HEAD -- backend/src/migrations` | **empty** |
| Browser gates (`qa-product-studio`, `browser-admin-smoke`, `qa-p4-surfaces`, `browser-experience-smoke`, `warehouse-ux-browser`) | — | **NOT RUN (no browser)** — rewritten/extended in this pass, no results claimed |

Regression coverage added for every defect of this pass (§26 A–I): direct Studio entry (contract +
browser), WMS receipt does not publish, explicit publish persists, reload persists, published +
zero stock never reverts, validation failure returns exact issues with no mutation, no local
promotion authority, one merged step with two independently persisted tables, and sales-mode-driven
pricing sections.

---

## 16. EXACT COMMIT SHAs

| SHA | Subject |
|---|---|
| `9d4531b` | feat(products): explicit publication is server-authoritative (Prompt-1 §1-§5) |
| `b5b56eb` | feat(products): arbitrary specs + size-guide tables over existing storage (§9-§12) |
| `66924b3` | feat(studio): canonical 8-step Product Studio — pricing, specs, publish (§6-§17) |
| `3dc4055` | test(qa): pin publication, the 8-step studio, dynamic tables and the mode split |
| `HEAD` at report time | docs(qa): this report (the commit you are reading; `git log -1`) |

Branch history was flattened once (a duplicated publication commit created by an accidental
`git reset --soft` was consolidated before publishing the final SHAs); the four atomic commits above
are the final, pushed state.

Earlier Prompt-1 commits on the same branch (unchanged): `b8c3cec`, `afd8d05`, `1675487`,
`3b46f85`, `dba09b6`, `319c910`, `f1e419b`, `05530e0`, `9353079`, `efea355`, `d74e7e5`, `08596ef`.

The branch history was flattened once before this report was committed (a duplicated publication
commit produced by an accidental `git reset --soft` was consolidated); the five SHAs above are the
final pushed state.

---

## 17. LOCAL HEAD == REMOTE HEAD

Verified after the final push with:

```bash
git rev-parse HEAD
git fetch origin arena/01a10ace-kolbevintage && git rev-parse FETCH_HEAD
```

Both printed the **same** SHA (the report's own commit — that is why the value is not repeated in
this file, where embedding it would immediately make it stale). Only
`origin/arena/01a10ace-kolbevintage` was pushed; no other branch was touched and nothing was merged
to `main`.

---

## 18. GIT STATUS CLEAN

`git status --porcelain` is empty at report time; `dist/index.html` and
`node_modules/.package-lock.json` were restored after the build; `backend/.scratch` was removed.

---

## OPEN ITEMS

| # | Type | Item |
|---|---|---|
| 1 | **BLOCKED** | Browser UAT (PUBLISH-01, breakpoint sweep, console/network) cannot be executed in this sandbox — no Chromium binary obtainable. All six documented items from the previous UAT correction, the publication scenario and the responsive matrix remain **PENDING** until a browser is available; they are now automated in `qa-product-studio.mjs` / `browser-admin-smoke.mjs`. |
| 2 | OPEN | `product-specs-editor.tsx` is retained but unimported. Decision needed later: re-mount it as an optional template tool inside «ساختار محصولات و سری‌ها», or delete it once the template workflow has an owner. No user-facing surface depends on it today. |
| 3 | OPEN | `discount-manager.tsx` still renders its own «حالت قیمت خرده/عمده» segmented control inside the shared pricing workspace. It is the canonical pricing workspace, not the Studio, and it belongs to a later prompt's scope — recorded so it is not silently forgotten. |

No new `PRODUCT_DECISION_REQUIRED` items were created by this pass: the domain pack, the explicit
Product Owner decisions and the prompt itself were sufficient for every change made.

---

## FINAL STATUS

**PROMPT 1 NOT VERIFIED — DO NOT CONTINUE**

Reason: the release-blocking publication defect is fixed and proven server-side (201/201 backend
tests including PUBLISH-01, 131/131 contract checks) and every browser gate is written to catch it —
but the mandatory browser acceptance (§18 PUBLISH-01 in a real browser, §23 breakpoints, §24
console/network) **could not be executed in this environment** and therefore remains PENDING. The
prompt forbids claiming PASS from static analysis, and the same environment limitation that blocked
the earlier UAT still applies. Prompt 2 has not been started.
