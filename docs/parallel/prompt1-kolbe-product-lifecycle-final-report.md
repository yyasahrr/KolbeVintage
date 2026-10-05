# KOLBE PRODUCT LIFECYCLE + INITIAL INVENTORY FINAL REPORT

Prompt 1 of 8 — KOLBE PRODUCTS + PRODUCT DRAFT LIFECYCLE + CANONICAL INITIAL INVENTORY
Repository: `yyasahrr/KolbeVintage`
Branch: `arena/01a10ace-kolbevintage` · HEAD `05530e0` · base `3cd9dac` (main, not merged)
Date: 2026-10-05 (UTC)

---

## 1. VERDICT

Prompt 1 is **code-complete and server-verified**. Draft (`پیش‌نویس`) is the single
authoritative user-facing unfinished Product state; `نیازمند راه‌اندازی` / Needs Setup is gone
as a second lifecycle and survives only as the internal `inventory_setup` technical invariant.
Every server-side acceptance criterion is covered by a new DB-proving test suite that is green.

Two acceptance criteria could **not be executed** in this sandbox (browser UAT gates and the
measured responsive sweep) because no Chromium/Chrome binary is obtainable here — see §6.

---

## 2. WHAT CHANGED (8 atomic commits)

| # | SHA | Commit | Scope |
|---|-----|--------|-------|
| 1 | `b8c3cec` | feat(products): «محصولات کلبه» hub becomes the canonical Kolbe product IA | new `kolbe-products-hub.tsx`, extracted `category-profiles-panel.tsx`, deleted `catalog-hub.tsx`, `admin.tsx` nav, `api.ts` read-model types |
| 2 | `afd8d05` | feat(products): server read model exposes the five canonical product views | `backend/src/product-lifecycle.ts` |
| 3 | `1675487` | feat(products): draft-first creation — Save Draft / Save & Continue | `backend/src/catalog.ts`, `src/portals/admin-product.tsx` |
| 4 | `3b46f85` | fix(products): «پیش‌نویس» is the only user-facing unfinished state | `src/data/fa-labels.ts`, `src/components/product-360.tsx` |
| 5 | `dba09b6` | feat(wms): canonical «ورود اولیه کالا» workspace + per-product WMS deep link | new `initial-inventory-workspace.tsx`, `backend/src/inventory.ts` |
| 6 | `319c910` | test(products): draft lifecycle + initial inventory regression suite | new `backend/src/product-draft-lifecycle.test.ts`, `backend/package.json` |
| 7 | `f1e419b` | test(contract): contract smoke targets the «محصولات کلبه» hub | `backend/scripts/frontend-contract-smoke.ts` |
| 8 | `05530e0` | chore(qa): realign browser UAT gates with the draft lifecycle IA | `qa-product-studio.mjs`, `browser-admin-smoke.mjs`, `qa-p4-surfaces.mjs`, new `qa-responsive-static.mjs` |

No schema change. No ProductV2 / InventoryV2 / parallel lifecycle or pricing system. Recomposition
of the existing Product Studio, catalog read model and WMS receipt path only.

---

## 3. ACCEPTANCE CRITERIA — STATUS

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Draft is the single authoritative unfinished state | **DONE** | §28–§30 tests; `INVENTORY_SETUP_FA.pending = «موجودی ثبت‌نشده»`; Product 360 shows «وضعیت انتشار» |
| 2 | Admin IA: «محصولات کلبه» / «ساختار محصولات و سری‌ها» / «انبار و موجودی (WMS)»; no «تنظیمات محصول» | **DONE** | `admin.tsx` tab list; contract smoke checks |
| 3 | Five filters, no Needs Setup filter | **DONE** | `view = all / drafts / published / out_of_stock / archived` in `product-lifecycle.ts` |
| 4 | `[ذخیره پیش‌نویس]` + `[ذخیره و ادامه]` + `[انصراف]` | **DONE** | `saveIntent` in `catalog.ts`; studio footer |
| 5 | Draft creates ZERO stock / balance / fake receipt | **DONE** | §28 test: 0 `stock_balances`, 0 `stock_receipts`, 0 `stock_movements` |
| 6 | Draft not purchasable, not published | **DONE** | §28: absent from public catalogue and `view=published`; checkout rejected with 0 `order_lines` |
| 7 | Draft survives browser close | **DONE** | §29: resume by canonical id, PATCH persists |
| 8 | Save & Continue reuses the same productId and hands off to «ورود اولیه کالا» preselected | **DONE** | §29 test + studio `onContinueToInventory(productId)` |
| 9 | Retail initial inventory at Color × Size; Wholesale via canonical Series; domains separated | **DONE** | §31/§32/§33 tests (retail-only, series-only, both-domains grouping) |
| 10 | Interrupted handoff ⇒ stays Draft, `[ادامه تکمیل محصول]` reopens the same flow preselected | **DONE** | §30 test + hub row action |
| 11 | Sold-out stays منتشرشده / ناموجود, never Draft or Needs Setup | **DONE** | §34 test |
| 12 | Prior pricing behaviour untouched | **PRESERVED** | No pricing module touched; promotion/pricing suites still green (196/196) |
| 13 | Series unpack regression preserved | **PRESERVED** | `series-inventory` suite green inside 196/196 |
| 14 | Server-authoritative idempotency (Save Draft, Save & Continue, initial WMS setup) | **DONE** | `Idempotency-Key` claim in `catalog.ts` create; §28/§31/§32 replay tests |
| 15 | No `inventory_setup` / `pending` / raw enums / UUID / snake_case in Admin UI | **DONE** | contract smoke + §38-style sweep in the UAT gate |
| 16 | Responsive 360/390/768/1024/1280/1440, no horizontal overflow | **NOT EXECUTED** | static lint clean (§6) — no browser available |
| 17 | No auto-publish on WMS receipt | **DONE** | §31: `inventory_setup='configured'` while `status` stays `draft` |

---

## 4. TEST RESULTS — EXECUTED AGAINST FINAL CODE

| Suite | Command | Result |
|-------|---------|--------|
| Backend embedded (all) | `cd backend && npm run test:embedded` | **# tests 196 · # pass 196 · # fail 0 · # skipped 0 · # suites 21 · 132.5 s** |
| New draft-lifecycle suite | `backend/src/product-draft-lifecycle.test.ts` | **8 / 8 pass** (included in the 196) |
| Frontend contract smoke | `cd backend && npm run test:contract` | **108 / 108 checks passed** (was 84/86 with the suite aborting on `ENOENT catalog-hub.tsx`) |
| Static responsive lint | `cd backend && node scripts/qa-responsive-static.mjs` | **1 / 1 pass** — 7 Prompt-1 surfaces, 23 fixed/min widths ≥ 320 px, all wrapped or clamped |
| Frontend typecheck | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0 errors** |
| Backend typecheck | `cd backend && npx tsc -p tsconfig.json --noEmit` | **0 errors** |
| Browser UAT gates | `qa-product-studio.mjs`, `browser-admin-smoke.mjs`, `browser-experience-smoke.mjs`, `warehouse-ux-browser.mjs`, `qa-p4-surfaces.mjs` | **NOT RUN — blocked, see §6** |

Idempotency semantics proven by test (not assumed): replaying the **same** `Idempotency-Key` with
the **same** payload returns the same canonical record; a key reused with a **different** payload
answers **409** «کلید تکرار با درخواست دیگری استفاده شده است.».

---

## 5. SERVER FACTS NOW PROVEN BY TEST (were assumptions before)

- `POST /api/v1/admin/products/:id/inventory-setup` **is** idempotent — retail replay stays 10
  pieces, wholesale replay stays 4 series / 24 pieces. The earlier "server idempotency gap" note
  is **closed**.
- An opening receipt writes `stock_receipts` + `stock_movements(reference_type='opening_receipt')`
  + exactly one `audit_logs` row with `action='product.inventory_setup'`.
- A WMS receipt flips `inventory_setup` to `configured` but **does not** publish.
- Checkout on a draft variant fails **before** any order row is written (404 on variant
  resolution in the draft lifecycle path); `order_lines` stays empty.
- `GET /api/v1/admin/products?view=…&owner=kolbe` serves all five views; the legacy
  `/admin/products/needs-setup?productId=…` still answers 200 as a compatibility alias only.

---

## 6. OPEN ITEMS

**BLOCKED — environment (not a code defect): browser verification.**
`qa-product-studio.mjs`, `browser-admin-smoke.mjs`, `browser-experience-smoke.mjs` and
`warehouse-ux-browser.mjs` are Puppeteer gates that need a Chromium binary plus a running
stack. This sandbox has no browser binary and no way to obtain one: `storage.googleapis.com`,
`cdn.playwright.dev` and `deb.debian.org` are all unreachable (only `github.com` and the npm
registry are open), and the image has none of Chromium's shared libraries. All four gates were
**updated** to the new IA in commit `05530e0` and are ready to run, but they have produced **no
results in this session** and none may be claimed.

**OPEN — measured responsive sweep.** The prompt requires 360/390/768/1024/1280/1440 with no
document horizontal overflow. `qa-product-studio.mjs` §40 now includes the 1280 breakpoint, but
it has not been executed. The substitute that *was* run, `qa-responsive-static.mjs`, is a
source-level lint for the dominant failure mode (a `min-w-[…]`/`w-[…]` ≥ 320 px that is not
inside `overflow-x-auto` / `kv-scroll-x` and does not clamp with `w-full` / `max-w-[…]`). It
passes on all seven Prompt-1 surfaces — that is evidence, not a measurement.

**NOTE (not open) — `dist/index.html`.** The repo tracks the single-file build and earlier
commits rebuilt it. Per the standing "do not commit `dist`" rule, the locally rebuilt
`dist/index.html` was reverted to HEAD and the branch carries source changes only. Rebuild with
`node node_modules/vite/bin/vite.js build` when a deployment bundle is wanted.

---

## 7. PUSH STATE

- Local HEAD `05530e0` == remote HEAD `origin/arena/01a10ace-kolbevintage` `05530e0`.
- Working tree clean (`git status --porcelain` empty).
- Not merged to `main`. Compare/PR:
  `https://github.com/yyasahrr/KolbeVintage/pull/new/arena/01a10ace-kolbevintage`

NEEDS_MORE_VERIFICATION
