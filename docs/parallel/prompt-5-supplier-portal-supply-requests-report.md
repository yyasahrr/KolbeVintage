# Prompt 5 Finalization Report — Supplier Portal and OMS Supply Requests

- **Date:** 2026-10-08
- **Scope:** Prompt 5 finalization only. Prompt 6 was not started.
- **Implementation status:** Complete; implementation commit pushed and verified.
- **Integration status:** PR #10 is open against the canonical Core Commerce branch; it has not been merged.

## 1. Repository identity and SHAs

- **Starting/baseline SHA:** `177e529f12810d8f85d8ccc687bcd5c49d4149ae`.
- **Final Prompt 5 implementation SHA:** `bc6a9be235785a974f0b58c751b878331596b97d` (`feat(supplier): complete Prompt 5 portal and OMS supply lifecycle`). This commit contains the implementation, migration, tests, and QA support; this report is a separate documentation-only follow-up.
- **Working branch:** `arena/e69b89c7-kolbevintage`.
- **Canonical PR base:** `arena/01a10ace-kolbevintage`, fetched at `177e529f12810d8f85d8ccc687bcd5c49d4149ae`. The fetched canonical base is an ancestor of the implementation commit; no history rewrite, force-push, branch switch, or merge was performed.
- The implementation commit was pushed with a normal push. Immediately afterward, `git ls-remote` confirmed the remote working-branch SHA exactly matched `bc6a9be235785a974f0b58c751b878331596b97d`.
- **PR:** [#10 — feat(supplier): complete Prompt 5 Supplier Portal and OMS Supply Requests](https://github.com/yyasahrr/KolbeVintage/pull/10). At report authoring, GitHub reported `OPEN`, `MERGEABLE`, and merge state `CLEAN`; `HEAD` was `arena/e69b89c7-kolbevintage` at the implementation SHA and `BASE` was `arena/01a10ace-kolbevintage`. No status checks were listed in the PR rollup. The PR is intentionally not merged.
- This report is being added in a documentation-only commit after the verified implementation push. Its push and the resulting PR head will be verified separately; this report does **not** claim that its own commit has already been pushed.

## 2. Delivered Prompt 5 functionality and lifecycle

### Supplier Portal

- Replaced the legacy inline portal with a Persian RTL, server-backed Supplier workspace. Identity and roles come from the canonical `/auth/me` flow; operational access is enforced server-side and requires both **approved cooperation** and **active account** status. Pending applicants and approved-but-inactive accounts remain distinct and cannot use operational endpoints.
- The workspace presents seven Supplier tabs and live API-backed dashboard, product/series authoring, own stock-at-Kolbe, offer/capacity, existing replenishment/new-product requests, OMS Supply Requests/history, and account surfaces. Data is tenant-scoped; other Suppliers' products, requests, capacity, and private data are not returned.
- The stock view reads canonical WMS data and computes availability without treating reserved or damaged quantities as available. Declared external capacity remains a separate, non-physical availability claim.
- The Supplier's cancellation control is shown only when the current response, allocation, child, and payment state make cancellation eligible; the server remains authoritative.

### Order-bound Supplier Supply Requests

The feature extends the canonical OMS child line and `order_source_allocations` lifecycle; it does not create another order, request, or reservation authority.

1. An operational Supplier can confirm, counter/revise, or reject only its own allocation. A counter remains attached to the OMS demand and blocks payment pending the buyer's decision. Accepting a counter revalidates and reserves the accepted quantity using canonical capacity authority.
2. Full acceptance atomically reserves external declared capacity and updates the canonical allocation. Commitment records the Supplier's promise without making another reservation. Readiness is explicit and is blocked until the VIP child is paid.
3. Dispatch requires a paid child and the ready transition. The server resolves the destination to a Kolbe central warehouse; the Supplier cannot choose a buyer or warehouse. Suppliers hand off to Kolbe, which fulfills the VIP order.
4. Rejection and eligible cancellation release the relevant capacity but preserve unpaid OMS demand as unresolved/reassignable. They do not silently cancel/remove the child or reduce Master Order demand. Admin reassignment releases the old source and creates one replacement for the same quantity; it is idempotent and does not double-count coverage. Master Order locking remains blocked until the demand is resolved.
5. Admin Master Order projections expose sourcing lifecycle and audit-relevant status. The buyer/VIP projection remains a single canonical Master Order and omits Supplier identity, offer/allocation IDs, response lifecycle, and sourcing topology. Supplier reads likewise omit buyer PII.

## 3. Capacity, concurrency, idempotency, and WMS/OMS boundaries

- The existing offer authority computes available-to-request as `max(0, declared_capacity - reserved_external - safety_buffer)`. Reservation uses a single conditional database `UPDATE` on an active offer, with the capacity predicate in the `WHERE` clause and the updated row returned. This is the concurrency serialization point; it avoids a client-side check-then-update oversell window.
- OMS-linked reservations use the existing `supplier_capacity_reservations` table with `reference_type = 'order_source_allocation'`. Migration 073 makes those linked reservations durable (`expires_at = NULL`), and the generic expiry sweep explicitly excludes OMS-linked reservations. Only an OMS-owned payment-expiry, cancellation, reassignment, dispatch, or other lifecycle transition resolves them.
- Mutation idempotency is scoped to actor/operation and bound to a request-payload hash. A same-key/same-payload retry replays the prior result; changing the payload with the same key returns `409`. Tests cover response, commitment, dispatch, and reassignment replays, and verify no duplicate capacity reservation or replacement allocation.
- **Concurrency evidence boundary:** the atomic conditional SQL guard is present and the regression suite verifies the reservation result and that retries do not double-reserve. A separate high-volume or parallel HTTP race/stress test was not run or claimed in this finalization.
- Supplier acceptance, commitment, readiness, and dispatch do **not** write physical WMS on-hand, reserved, received, damaged, or QC-passed balances. External declared capacity and `supplier_committed_series` are not physical inventory. Dispatch consumes the capacity reservation and records an OMS handoff to Kolbe; actual receiving and QC remain later warehouse operations.
- The canonical OMS remains the source of truth for Master Orders, children, child lines, allocations, payment eligibility, and demand. Existing series/WMS sources remain the authority for physical stock. Supplier Settlement/Finance was not added or written by Prompt 5.

## 4. Migration and seed compatibility

- Added `backend/src/migrations/073_supplier_oms_lifecycle.sql`. It extends existing supplier-owned OMS child lines with response status/note/timestamps, committed series/time, and readiness time; backfills existing canonical OMS states; adds lookup indexes; and removes TTL expiry from active OMS-linked capacity reservations. It creates no parallel order, inventory, or reservation table.
- Fresh migration verification applied the complete **54-migration** inventory in order, verified unique migration identifiers and the final `072_customer_otp_login.sql` → `073_supplier_oms_lifecycle.sql` sequence, and confirmed the second migration run is a no-op. The embedded regression harness also migrated a fresh PGlite database and verified a second run made no changes.
- No seed file or seed identity was changed. The existing `seed.supplier@kolbe.ir` / `Seed-Supplier-123456` identity remains preserved where available. Browser UAT used the existing seeded Supplier phone `09120000002` and the existing local seed flow; it did not introduce a new demo identity or seed dataset.

## 5. P5-SUP acceptance evidence

Fresh targeted run of `src/prompt5-supplier-portal.test.ts` plus `src/supplier360.test.ts`: **27 tests passed, 0 failed, 0 skipped**. All 25 named P5-SUP gates passed:

| Gate | Verified behavior | Result |
|---|---|---|
| P5-SUP-001 | Unauthenticated and pending applicants cannot use operational portal routes. | PASS |
| P5-SUP-002 | Approved but inactive Supplier is denied on every operational route. | PASS |
| P5-SUP-003 | Only approved, active server identity reaches the live dashboard. | PASS |
| P5-SUP-004 | Dashboard aggregates real product, OMS, and capacity records, not demo data. | PASS |
| P5-SUP-005 | Own pending products/series are visible; every other Supplier's catalogue is excluded. | PASS |
| P5-SUP-006 | WMS stock is tenant-scoped; reserved/damaged stock is not available quantity. | PASS |
| P5-SUP-007 | Offers and declared capacity use the existing supplier-offer authority. | PASS |
| P5-SUP-008 | Legacy replenishment/new-product request surface remains available and scoped. | PASS |
| P5-SUP-009 | Child-order read model is buyer-private and Supplier-owned. | PASS |
| P5-SUP-010 | Supply Request list/history returns only the caller's canonical allocations. | PASS |
| P5-SUP-011 | A Supplier cannot read or answer another Supplier's allocation. | PASS |
| P5-SUP-012 | Full acceptance reserves declared capacity on the canonical OMS allocation. | PASS |
| P5-SUP-013 | Idempotency is actor/payload-bound; same request replays, changed payload conflicts. | PASS |
| P5-SUP-014 | Acceptance leaves physical WMS stock unchanged; OMS reservation is durable and auditable. | PASS |
| P5-SUP-015 | Revised/partial response stays on the OMS line; buyer acceptance reuses capacity authority. | PASS |
| P5-SUP-016 | Admin sees sourcing on one canonical Master Order; VIP projection exposes no topology. | PASS |
| P5-SUP-017 | Commitment is server-gated/idempotent and does not reserve capacity a second time. | PASS |
| P5-SUP-018 | Readiness is blocked until the VIP child is paid. | PASS |
| P5-SUP-019 | Payment remains the canonical OMS transition; no Supplier Settlement is created. | PASS |
| P5-SUP-020 | Supplier cannot dispatch an accepted/committed allocation before readiness. | PASS |
| P5-SUP-021 | Readiness is explicit/audited and leaves physical inventory unchanged. | PASS |
| P5-SUP-022 | Client cannot select a buyer/warehouse; dispatch uses server-resolved Kolbe warehouse. | PASS |
| P5-SUP-023 | Dispatch does not increase on-hand, received, QC, or Supplier-stock balances. | PASS |
| P5-SUP-024 | Cancellation preserves OMS demand; reassignment creates one replacement, not duplicate demand. | PASS |
| P5-SUP-025 | OMS capacity survives generic TTL sweep; Admin lifecycle/audit stay private; no Supplier Finance writes. | PASS |

The targeted run's exact TAP summary was `# tests 27`, `# pass 27`, `# fail 0`, `# skipped 0`. The 27 includes the 25 nested P5-SUP gates and the Supplier 360 lifecycle regression.

## 6. Regression gates and exact results

Fresh finalization evidence for the implementation tree (`bc6a9be235785a974f0b58c751b878331596b97d`):

| Gate | Result |
|---|---|
| Full embedded backend regression (`npm run test:embedded`) | **One completed fresh run: 277 passed, 0 failed, 0 skipped; 21 suites. A later confirmation rerun: 276 passed, 1 failed, 0 skipped; 21 suites, due to the PGlite protocol error detailed below.** |
| P5-SUP + Supplier 360 targeted regression | **27 passed, 0 failed, 0 skipped** |
| Auth OTP/membership targeted regression after the full-run protocol error | **12 passed, 0 failed, 0 skipped** |
| Frontend contract smoke (`node --import tsx scripts/frontend-contract-smoke.ts`) | **174/174 PASS** |
| Dynamic-table smoke (`node --import tsx scripts/dynamic-table-smoke.ts`) | **14/14 PASS** |
| Pricing-routing smoke (`node --import tsx scripts/pricing-routing-smoke.ts`) | **25/25 PASS** |
| Frontend TypeScript (root `tsconfig.json`, no emit) | **PASS** |
| Backend TypeScript (`backend/tsconfig.json`, no emit) | **PASS** |
| Vite production build (`npm run build`) | **PASS; 2,016 modules transformed** |
| Responsive static lint (`node scripts/qa-responsive-static.mjs`, from `backend/`) | **1/1 PASS; 21 surfaces and 44 fixed/min widths inspected** |
| Fresh migration verification (`node scripts/verify-migrations.mjs`, from `backend/`) | **PASS; 54 ordered, uniquely identified migrations; second run no-op** |
| `git diff --check` | **PASS; no whitespace errors** |

The first fresh frontend-contract run exposed two stale assertions that expected the old inline Supplier `me` variable and pre-refactor status copy. The smoke contract was updated to check the current server-derived `/auth/me`, cooperation/activity gate, and extracted workspace. Its final fresh rerun is **174/174 PASS**. This was a stale test expectation, not a Supplier authentication/application defect.

The full embedded suite has a repeatability caveat that is recorded rather than hidden: a completed run on the implementation tree passed **277/277** (`/tmp/kolbevintage-embedded-tests-final-2.log`). A later full rerun completed with **276/277**, where the sole failure was an uncaught `ERR_TEST_FAILURE` in the unrelated `AUTH-003/008/005` test (`src/auth-otp-membership.test.ts`) at `pg`'s `Client._handleCommandComplete`: `Received unexpected commandComplete message from backend.` (`/tmp/p5-full-regression-final.log`). It was a PGlite socket/PostgreSQL protocol error, not an assertion mismatch. A fresh isolated run of that auth test file then passed **12/12** (`/tmp/p5-auth-targeted-final.log`), while logging a non-fatal PGlite idle-client warning. Thus the focused Prompt 5/Supplier 360 tests are green, but the latest full-suite rerun is not consistently green; the embedded-runner protocol flake remains a test-environment blocker to call out.

## 7. Browser UAT and caveats

A fresh Chromium 131/Puppeteer UAT ran against a temporary PGlite database with migrations, local seed, API, and Vite server. The seeded Supplier authenticated via OTP (`09120000002`); the live dashboard and all **7 Supplier tabs** rendered. At **390×844** and **1440×1000**, there was no horizontal overflow. All **12 required auth/Supplier API endpoints returned 200**; missing required endpoints, Prompt 5 non-200 responses, 5xx responses, and page errors were all **0**. Runner log: `/tmp/p5-browser-uat-finalization.log` (outside the repository).

- **Google Fonts sandbox caveat:** the external stylesheet request failed with `net::ERR_CONNECTION_CLOSED`; the browser used fallback fonts. This was an environment/network limitation, not an application failure, and did not block the layout/API assertions.
- Expected diagnostic **401** responses came from pre-login/unauthenticated probes to protected endpoints. They were expected access-control results, not application defects. All required authenticated Supplier endpoints passed.

## 8. Complete changed-file audit

The implementation commit contains only Prompt 5 production/UI, its migration, regression coverage, and QA support. The separate final report below is the only documentation addition. No unrelated Storefront feature, seed change, generated build output, dependency tree, or browser-session artifact is included. `dist/index.html` and `node_modules/.vite/deps/_metadata.json` were regenerated temporarily by the production build and restored; they are not staged. Ignored build/dependency/storage directories were not staged.

**Production, OMS/UI, and migration (22):**

1. `backend/src/app.ts`
2. `backend/src/auth.ts`
3. `backend/src/catalog.ts`
4. `backend/src/inventory.ts`
5. `backend/src/marketplace.ts`
6. `backend/src/migrations/073_supplier_oms_lifecycle.sql`
7. `backend/src/orders.ts`
8. `backend/src/series.ts`
9. `backend/src/specs.ts`
10. `backend/src/style.ts`
11. `backend/src/supplier-consignment.ts`
12. `backend/src/supplier-offers.ts`
13. `backend/src/supplier-portal.ts`
14. `backend/src/supplier-requests.ts`
15. `backend/src/video.ts`
16. `backend/src/wholesale-oms.ts`
17. `src/components/supplier-product-series-authoring.tsx`
18. `src/components/supplier-supply-requests-panel.tsx`
19. `src/data/api.ts`
20. `src/portals/supplier-portal-workspace.tsx`
21. `src/portals/supplier.tsx`
22. `src/portals/wholesale-order-center.tsx`

**Regression tests and QA/test tooling (12):**

23. `backend/package.json`
24. `backend/scripts/frontend-contract-smoke.ts`
25. `backend/scripts/qa-responsive-static.mjs`
26. `backend/scripts/run-embedded-tests.mjs`
27. `backend/scripts/verify-migrations.mjs`
28. `backend/src/product-wms-foundation.test.ts`
29. `backend/src/prompt3-wms.test.ts`
30. `backend/src/prompt4-oms.test.ts`
31. `backend/src/prompt5-supplier-portal.test.ts`
32. `backend/src/settlement.test.ts`
33. `backend/src/supplier360.test.ts`
34. `backend/src/wholesale-oms.test.ts`

**Requested report (35th file in the final PR):**

35. `docs/parallel/prompt-5-supplier-portal-supply-requests-report.md`

No source/production changes were made after the final regression/browser evidence; subsequent work is the report and Git integration only.

## 9. Explicitly deferred — Prompt 6 and out of scope

- Physical warehouse receiving, receipt posting, QC pass/reject, discrepancy handling, and resulting WMS stock movements remain for Prompt 6. Prompt 5 readiness/dispatch is not receipt or QC and does not create physical stock.
- Supplier Settlement/Finance, payables, advances, deductions, and payout flows remain out of scope. The Prompt 5 tests assert no Supplier Finance writes.
- Suppliers do not ship directly to VIP buyers; Kolbe owns final fulfillment.
- No Prompt 6 work was started.

## 10. Integration and finalization state

The Prompt 5 implementation is pushed to the existing working branch, and PR #10 is prepared against the verified canonical Core Commerce base. The PR is open, clean/mergeable at the time checked, and intentionally unmerged. The report-only commit is the only remaining branch update at this report-authoring point; it must be pushed normally and the resulting remote HEAD/PR head verified before declaring the entire branch final. No force-push, history rewrite, main-branch push, or automatic merge is authorized.
