# Prompt 6 Finalization Report — Inbound Operations / Warehouse Receiving (GRN) / QC / Consolidation / Final Shipment

- **Date:** 2026-10-08
- **Scope:** Prompt 6 only (sixth stage of the Core Commerce roadmap). Prompt 7 and Prompt 8 were **not** started.
- **Status:** Implementation, migration, tests, regression gates and the warehouse-side UI are complete on the Agent branch; the PR is open and intentionally **unmerged**.
- **Local browser UAT:** **REQUIRED** — an API/contract-level pass is not a browser pass. See §9 and §14.

## 1. Repository identity and SHAs

| Item | Value |
| --- | --- |
| Repository | `yyasahrr/KolbeVintage` |
| Baseline (branch point / verified canonical Core Commerce) | `ef7c7273ac2dd5f8c2a36ed063e30f88ccd6afc5` (merge of PR #10 — Prompt 5 accepted) |
| PR base (required) | `arena/01a10ace-kolbevintage` — **never `main`** |
| Agent branch | `arena/7030df7b-kolbevintage` (this session's branch) |
| `main` | `3cd9dace…` — untouched, never merged into this branch |
| Other agents' branches | `arena/cms-production-final`, `arena/crm-production-final`, `cms/visual-final-candidate` — untouched |

`git status` on this branch contains only Prompt 6 additions/changes (see §10). No force-push, no history rewrite, no push to `main`, no merge.

## 2. Audit — existing capability classification (audit-first, no rebuild)

Every pre-existing inbound/WMS/OMS/consolidation capability was classified **before** implementation. The implementation extends each capability in place; nothing was rebuilt wholesale.

| # | Capability (existing) | Classification | Decision taken in Prompt 6 |
| --- | --- | --- | --- |
| 1 | `order_source_allocations` (Prompt 2/4/5) as the single quantity authority for order-bound supply | CANONICAL_AND_COMPLETE | Kept. Receiving/QC buckets (`received_missing_series`, `received_damaged_series`, `qc_damaged_series`, notes/actors/timestamps) were **added to it** instead of creating a second quantity store. |
| 2 | `master_orders` / `orders` (children) / `child_order_lines` (Prompt 2) | CANONICAL_AND_COMPLETE | Kept. One Master Order for the buyer; internal sourcing stays a child/source detail. |
| 3 | `master_consolidations` / `consolidation_items` (Prompt 2) | CANONICAL_BUT_INCOMPLETE | Extended with verification (`scan_reference`) and packing metadata (`package_count`, `total_series`, `total_pieces`, `weight_grams`, `dimensions`, `packaging_note`). No second consolidation centre. |
| 4 | `warehouse_receipts` (GRN, migration 055) | CANONICAL_BUT_INCOMPLETE | Kept as the ONE receipt authority. Added an OMS scope (`oms_inbound_shipment_id`) plus `shortage_series`, `damaged_series`, `inspected_by/at` and an exactly-one-scope CHECK. |
| 5 | `inbound_shipments` + `supplier_fulfillments` (legacy v1 wholesale, migration 055, written by `orders.ts`) | LEGACY_COMPATIBILITY | Left intact for genuinely legacy orders. OMS-bound children are refused entry (see #12). |
| 6 | `/wholesale/children/:id/receive` and `/qc` (Prompt 4 adapters) | DUPLICATE_AUTHORITY (thin) | Converted into **thin adapters** that call the one receiving/QC authority in `work-inbound.ts`; they can no longer write GRN/QC state independently. |
| 7 | `/wholesale/orders/:id/consolidate` and `/dispatch-vip` (Prompt 2/3) | **DUPLICATE_AUTHORITY — PRIMARY RISK** | Blocked by three server-side guards so a second physical dispatch can never deduct `stock_balances` again. |
| 8 | `fulfillment_exceptions` (Prompt 2) | CANONICAL_BUT_INCOMPLETE | Exception kind catalogue widened to 15 operational kinds and `assigned_to` added. The Exception Center is a view over this table — no separate Customer Order Centre. |
| 9 | `warehouse_*` duties/permissions (Prompt 1–5) | CANONICAL_BUT_INCOMPLETE | Four new warehouse duties: `wms:receive`, `wms:qc`, `wms:consolidate`, `wms:ship` (granted to `admin` + `operations`). |
| 10 | Media service (Prompt 1/4) | CANONICAL_AND_COMPLETE | Reused verbatim for QC/receiving evidence. No new media store, no new upload path. |
| 11 | Shipping-quote engine + server label PDFs | CANONICAL_AND_COMPLETE | Reused. No second quote engine, no second label authority; tracking is written to the canonical master shipment only. |
| 12 | `supplier-consignment.ts` general consignment (`series_stock_balances` owner=supplier, `conversion_out/in`, `supplier_stock_returns`) | CANONICAL for its own scope | Untouched. Order-bound inbound/QC never writes general consignment stock; ownership conversion remains only through the explicit canonical movement types. |
| 13 | `series_stock_balances` / `stock_balances` (WMS) | CANONICAL_AND_COMPLETE | **Never written** by receiving or QC. Order-bound external goods remain order-bound until the canonical consolidation/pick path. |
| 14 | Warehouse dashboard / QC surfaces inside the WMS hub | CANONICAL_BUT_INCOMPLETE | Extended with the Prompt 6 operational dashboard + queues; the hub keeps its four primary tabs. |
| 15 | Order-bound inbound lifecycle document | **MISSING** | Added `oms_inbound_shipments` (`OIN-{seq}`): a pure lifecycle document that deliberately stores **no quantities**, so it can never drift from the allocation truth. |

Outcome of the audit: exactly two authorities exist per fact — OMS (`wholesale-oms.ts`) and order-bound inbound/QC/shipment (`work-inbound.ts`) — and the legacy v1 path is either reused as an adapter or explicitly blocked.

## 3. Delivered Prompt 6 functionality

### 3.1 Canonical Inbound Shipment lifecycle (§7)
`oms_inbound_shipments.status` uses the existing persisted operational stages: `dispatched → in_transit → arrived → receiving → received → qc_completed` (+ `cancelled`). One live leg per (child order, supplier) is enforced by a partial unique index, so the same physical dispatch cannot be tracked twice. The supplier declares the leg (`POST /wholesale/supplier/children/:id/inbound-shipment`), the destination is **server-resolved** to the central Kolbe warehouse, and a duplicate declaration resolves to the *same* document (idempotent).

### 3.2 GRN / physical receiving with server-side reconciliation (§8, §9)
`recordInboundReceive` is the only writer of a physical receipt. It requires `wms:receive`, the allocation to be `reserved` + dispatched, refuses re-entry (`409 INBOUND_ALREADY_RECEIVED`), and enforces on the server:

```
dispatched = received + missing          (checked, not assumed)
```

Partials are legitimate (dispatched 20 → received 18 → missing 2). The receipt is immutable once posted; corrections require a documented compensating flow (`supplier_redelivery`), never a status rollback. Every receipt produces exactly one GRN row (`GRN-{seq}`) for the OMS shipment — enforced at the database level by a partial unique index.

### 3.3 Real QC workflow (§10)
`recordInboundQc` is the only writer of QC results. It requires `wms:qc`, refuses QC before a receipt (`409 INBOUND_NOT_RECEIVED`), refuses a second finalisation (`409 INBOUND_ALREADY_QC`), refuses a supplier operating its own goods, and enforces **mutually exclusive** buckets:

```
received = accepted + rejected + damaged + pending_inspection
```

Damaged units are their own bucket and are **never** re-counted as missing or rejected (this convention matches the pre-existing canonical `inbound_shipment_lines` shape, and it is what makes "dispatched 5 / received 4 / accepted 3 / damaged 1 / missing 1" resolve to exactly 3 acceptable and 2 unresolved). Rejections and damage open real `qc_rejected`/`damaged` exceptions with operator notes; the GRN records shortage and damage separately. **No stock is credited before a canonical physical + QC event, and even then only per the canonical consolidation/pick path.**

### 3.4 Exception Center (§13, §14)
A single admin surface over the existing `fulfillment_exceptions`: server-side filters (`status`, `type`, `masterId`), operator-readable context (master reference, series name, product name, shipment reference, note, age), assignment to a responsible operator, and four canonical resolutions (`supplier_redelivery`, `accept_short`, `written_off`, `refund_pending`). `refund_pending` records an **explicit finance reference** for Prompt 3 — no money moves here. Everything is audited.

### 3.5 Readiness derived from records (§16)
There is **no** editable «آماده تجمیع» flag. A child becomes `ready_for_consolidation` only when: payment is settled, no exception is open, no allocation is still pending/reserved, every external leg is fully reconciled (`dispatched = received + missing` **and** `received = passed + rejected + damaged`), and every active line has real staged coverage. Declared supplier capacity, commitment, handoff readiness or dispatch are never readiness. A previously-ready child regresses if its physical basis disappears (re-dispatched leg), and a stale `exception` label is re-derived once its last open exception is resolved (production fix in `wholesale-fulfillment.ts`).

### 3.6 Consolidation → verification → packing → final shipment (§17–§22)
Using only `master_consolidations` / `consolidation_items`:
- `start` records the expected composition (`expected_children`, one item per canonical requirement), blocked with `409 CONSOLIDATION_NOT_READY` while any source is unresolved;
- `verify-item` scans/validates each item (`409 WRONG_CONSOLIDATION_ITEM`, duplicate → conflict) and completion is blocked while items remain unverified (`409 CONSOLIDATION_NOT_READY`);
- `pack` is only possible after completion; it stores **only** operator-entered real values (package count, weight, dimensions, note) — nothing is fabricated, and empty values stay `NULL`;
- the final shipment is **Kolbe-only** and reuses the canonical master ship/deliver API, the canonical label authority and the canonical tracking fields; a supplier can never ship to a buyer or choose a destination, and no second quote/label engine exists. Shipping is blocked by `CONSOLIDATION_NOT_READY` → `MASTER_COMPOSITION_OPEN` → `FULFILLMENT_EXCEPTION_OPEN` → `PAYMENT_NOT_READY`, in that guard order.

### 3.7 Warehouse operational dashboard (§24)
`GET /admin/wms/dashboard` returns server-derived counters (`arriving`, `awaiting_receiving`, `awaiting_qc`, `partial`, `damaged`, `awaiting_consolidation`, `ready_for_packing`, `ready_for_dispatch`, `open_exceptions`, `delayed_inbound`) and the in-flight masters. Every card deep-links to a **filtered server queue** (`awaitingReceiving`, `awaitingQc`, `hasException`, `masterId`, status, search) — no vanity counters, and the policy threshold (`inboundDelayHours`) is read from settings.

### 3.8 Server-derived permissions (§27)
Actions are computed server-side and returned as `actions[]` on the shipment and consolidation detail payloads (`receive`, `inspect`, `start_consolidation`, `verify_item`, `complete_consolidation`, `pack`, `ship`). The UI renders only what the server allows; every route independently re-checks the duty and role. Frontend strings are never the authority.

## 4. Authority map and duplicate-authority guards

| Fact | Single authority | Notes |
| --- | --- | --- |
| Order-bound quantities | `order_source_allocations` | Receiving/QC buckets live here; `oms_inbound_shipments` stores no quantities at all. |
| Physical receipt / GRN | `recordInboundReceive` → `warehouse_receipts` | One GRN per OMS shipment (partial unique index). |
| QC result | `recordInboundQc` | Only writer; `passed/rejected/damaged/received` stored on the allocation. |
| Inbound lifecycle document | `oms_inbound_shipments` | Reference `OIN-{seq}`; no quantities. |
| Exceptions | `fulfillment_exceptions` | Widened catalogue + assignment. |
| Consolidation / packing / shipment | `master_consolidations`, `consolidation_items`, `master_orders` | One Master Order, one final shipment. |
| General consignment / ownership conversion | `series_stock_balances`, `series_stock_movements`, `supplier_stock_returns` | Untouched; conversion still explicit (`conversion_out`/`conversion_in`). |

Guards that keep the legacy duplicate authority dead (verified by tests): a legacy v1 `inbound_shipment` can never be created for an OMS child; the legacy `/wholesale/children/:id/receive|qc` adapters answer `409 INBOUND_ALREADY_RECEIVED` / `INBOUND_ALREADY_QC` instead of posting twice; the legacy `/wholesale/orders/:id/dispatch-vip` path is refused after a canonical pick so the same goods cannot be deducted twice.

## 5. Business invariants (as enforced, with the test that proves it)

| Invariant | Enforcement | Evidence |
| --- | --- | --- |
| Capacity ≠ stock | Commitment/dispatch write no WMS stock | GOLDEN-1, P6-OMS-001/002 |
| Receiving ≠ QC | `INBOUND_NOT_RECEIVED` guard; two separate writers | P6-QC-005, GOLDEN-2 |
| `dispatched = received + missing` | Route validation + DB CHECK | GOLDEN-2, P6-INB-004/006 |
| `received = accepted + rejected + damaged` | Route validation + DB CHECK (mutually exclusive) | GOLDEN-2, P6-QC-002 |
| Damaged never re-counted as missing/rejected | Separate buckets + separate exceptions once | GOLDEN-2, P6-QC-002/004 |
| No silent quantity reduction | `child_order_lines.confirmed_series` untouched by QC/rejection | GOLDEN-2, P6-OMS-008 |
| No stock credit before physical + QC | Receiving/QC write no `stock_balances`/`series_stock_balances` | P6-QC-004 |
| Ownership preserved | Pick consumes the correct owner; no implicit conversion | GOLDEN-3, P6-CON-001, P6-REG-001 |
| One movement = one accounting effect | Legacy dispatch blocked; ledger asserted consistent | GOLDEN-5 |
| Master blocked until every source is real | Derived readiness + `CONSOLIDATION_NOT_READY` | GOLDEN-3, P6-OMS-003 |
| Buyer sees ONE Master Order | Server-side buyer projection | GOLDEN-1/GOLDEN-3, P6-REG-003 |

## 6. Migration 074

`backend/src/migrations/074_prompt6_inbound_qc_consolidation.sql` (the next number after `073`, no prior migration touched):

- `oms_inbound_shipments` (`OIN-{seq}` via `oms_inbound_seq`, no quantity columns) + partial unique index for one live leg per (child, supplier);
- `order_source_allocations` += `inbound_shipment_id`, `received_missing_series`, `received_damaged_series`, `qc_damaged_series`, `receipt_note`, `qc_note`, `received_by/at`, `qc_by/at` + two validated CHECK guards;
- `warehouse_receipts` += `oms_inbound_shipment_id`, `shortage_series`, `damaged_series`, `inspected_by/at`, `inbound_shipment_id` made nullable, exactly-one-scope CHECK, partial unique index per OMS shipment;
- `consolidation_items.scan_reference`; `master_consolidations` += packing metadata;
- `fulfillment_exceptions` catalogue widened to 15 kinds + `assigned_to` (historical kinds re-validated);
- `site_settings.wms_inbound_policy = {"inboundDelayHours": 72}`; permissions `wms:receive|qc|consolidate|ship` granted to `admin`/`operations`.

Every statement is additive (`IF NOT EXISTS` / guarded `DO $$` blocks); no column is dropped, no data is rewritten, and all new columns default to `0`/`NULL` on legacy rows.

## 7. Acceptance evidence — required test matrix (§38)

The Prompt 6 suite is `backend/src/prompt6-inbound-qc-consolidation.test.ts` (16 tests, drives the real HTTP surface through `app.inject` and asserts persisted state). Every required matrix id has a real executable assertion:

| Required ID | Where it is asserted |
| --- | --- |
| P6-INB-001 / 002 | Matrix test: one inbound document, `OIN-` reference, server-resolved central warehouse, idempotent re-declaration (same document id, still exactly one row). |
| P6-INB-003 | Matrix test + GOLDEN-3: foreign supplier gets 403 on admin detail and lists nothing of ours. |
| P6-INB-004 | `P6-INB-004`: receiving before dispatch and QC before receipt are refused (`INBOUND_NOT_DISPATCHED`, `INBOUND_NOT_RECEIVED`). |
| P6-INB-005 | Matrix test: a user without `wms:receive` gets 403; a supplier receives its own goods → 403; no receipt row written. |
| P6-INB-006 | Matrix test + GOLDEN-2: duplicate/immutable receipt, impossible quantity → 400, re-receipt → 409. |
| P6-INB-007 / 008 | GOLDEN-4: cross-endpoint duplicate receiving (canonical + legacy adapters) can never double-credit. |
| P6-QC-001 / 002 | `P6-QC-001/002/003/006`: QC only after receipt; bucket sum must equal received. |
| P6-QC-003 | Same test + GOLDEN-2: partial acceptance stays partial (child never `ready`). |
| P6-QC-004 | Matrix test: QC writes no sellable stock (piece and series balances unchanged, both zero). |
| P6-QC-005 | Matrix test: QC before receipt → 409 `INBOUND_NOT_RECEIVED`. |
| P6-QC-006 | `P6-QC-001/002/003/006`: idempotent QC (same key+payload → same outcome, single posting). |
| P6-QC-007 | GOLDEN-6: two operators finalising the same receipt concurrently → exactly one posting. |
| P6-QC-008 | Matrix test: operator note + rejection persisted; the rejection is a real open exception with a note. |
| P6-OMS-001 / 002 | GOLDEN-1: commitment/dispatch create no WMS stock and no intact series. |
| P6-OMS-003 | Matrix test: two-supplier master — one source received is **not** readiness; consolidation starts only after the second source is received and QC-passed. |
| P6-OMS-004 / 005 / 006 | `P6-OMS-004/005/006`: partial fulfilment keeps the requirement open; rejection never silently reduces demand; resolution re-derives readiness. |
| P6-OMS-007 | GOLDEN-3: supplier-tenant isolation on the inbound list/detail/warehouse routes. |
| P6-OMS-008 | Matrix test: `confirmed_series` is untouched by QC rejection and a partially rejected leg is not silently closed. |
| P6-SHP-001 | `P6-SHP-002/003/004`: a supplier and a buyer both get 403 on the final shipment route. |
| P6-SHP-002 | Same test: unpaid → 409 `PAYMENT_NOT_READY` for pick and ship. |
| P6-SHP-003 / 004 | Same test: unresolved shortage and an open blocking exception stop shipment (`FULFILLMENT_EXCEPTION_OPEN`), and resolving it releases the block. |
| P6-SHP-005 / 006 | Matrix test: shipping refused (`MASTER_COMPOSITION_OPEN` / `CONSOLIDATION_NOT_READY`) before a locked, consolidated composition; `shipped_at` stays `NULL`. |
| P6-SHP-007 | `P6-CON-001..008`: carrier/tracking persisted on the ONE master shipment, mirrored to children, visible to the buyer. |
| P6-SHP-008 | Same test: the pre-existing order label authority still serves wholesale children; no second label table/route. |
| P6-SHP-009 | Matrix test: no parallel shipping-quote/label authority exists for the OMS. |
| P6-SHP-010 | `P6-CON-001..008`: delivery is authorised, audited (≥4 sensitive physical ops) and recorded once (repeat → 409). |
| P6-REG-001 | Matrix test + `P6-REG-002/003/004`: general consignment authority and explicit ownership conversion intact; order-bound goods never enter the legacy inbound path. |
| P6-REG-002 / 003 / 004 | `P6-REG-002/003/004`: Prompt 3 consignment ownership, Prompt 5 supplier commitment/durable reservation (never a TTL sweep) and Prompt 4 per-source coverage. |
| P6-REG-005 / 006 | Migration-compatibility test: legacy v1 GRN coexistence, one-scope rule, live DB guards, widened exception catalogue. |

Golden scenarios §31–§37 are covered by GOLDEN-1 … GOLDEN-7 (mixed-source 3+2+5; partial receiving with damage; three suppliers with C undelivered; duplicate endpoint protection; double-deduction prevention; concurrent QC; unauthorised operations).

## 8. Regression gates and exact results

| Gate | Command | Result |
| --- | --- | --- |
| Backend type-check | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **CLEAN** |
| Frontend type-check | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` (repo root) | **CLEAN** |
| Full embedded backend suite (all 41 files, fresh PGlite, migrations 001→074 applied from scratch) | `npm run test:embedded` | **293 tests / 293 pass / 0 fail**, 21 suites, 208 s (`/tmp/embedded-full3.log`) — the final run after the last production change |
| Prompt 6 acceptance suite (isolated) | `node --import tsx --test --test-concurrency=1 src/prompt6-inbound-qc-consolidation.test.ts` against the embedded PGlite socket started by `scripts/run-embedded-tests.mjs` | **16 tests / 16 pass / 0 fail** (~24 s). `scripts/run-embedded-tests.mjs` runs `npm test`, so the focused run was driven through a temporary harness script that starts the same PGlite socket and points `node --test` at the single file; that throwaway script is deliberately **not** part of the patch |
| Prompt 4 + 5 + settlement + wholesale-OMS + Prompt 6 (5 files, one database) | 5-file run | **61 tests / 61 pass / 0 fail** |
| Migration verifier (fresh + populated upgrade + structural checks) | `node scripts/verify-migrations.mjs` | **ALL CHECKS PASSED** (now 55 migrations, 074 structural checks included) |
| Populated-upgrade fixture (previous release builds 073 data, then 074 applies) | throwaway harness `scripts/tmp/check-mig-populated.mjs` (not part of the patch — it starts PGlite, populates a 073-era database with the *previous release's* code from a detached worktree, then applies 074 against the current tree; `scripts/verify-migrations.mjs` performs the same freshness/populated comparison inside the committed tooling) | **PASSED** — 074 applied exactly once, re-run a no-op, 25 masters/40 allocations/3 exceptions/1 consolidation + a legacy v1 GRN survived, new guards validated and live, Prompt 6 16/16 on the upgraded database |
| Frontend contract smoke (real client + real contracts) | `npm run test:contract` | **187/187 checks passed** (8 new Prompt 6 checks incl. live server calls) |
| Dynamic-table smoke | `npm run test:dynamic-table` | **14/14 ✓** |
| Pricing-routing smoke | `npm run test:pricing-routing` | **25/25 ✓** |
| Responsive static lint (360 px no-overflow rule) | `node scripts/qa-responsive-static.mjs` | **1/1 PASS** — 22 surfaces, 46 wide elements inspected (Prompt 6 surface included) |
| Production build | `node node_modules/vite/bin/vite.js build` | **✓ built** — 2019 modules, `dist/index.html` 2,415.55 kB (gzip 594.94 kB) |

Environment notes (not assertion failures): the embedded suite runs on PGlite (PostgreSQL wire protocol) because no PostgreSQL server is installed in this sandbox; `vite`/`tsc` binaries are not executable via `npx` here, so they are invoked through `node node_modules/...`. Installing the root dependencies was required to obtain the Rollup native binary before the production build could run.

## 9. Frontend deliverable (warehouse side)

- **New workspace** `src/portals/wms-inbound-operations.tsx` — «دریافت، کنترل کیفیت و تجمیع» with five task views: داشبورد انبار / در انتظار دریافت / کنترل کیفیت / نیازمند بررسی / تجمیع و ارسال.
- **Placement (§23):** it lives *inside* the existing WMS hub as the wholesale sub-tab «دریافت و تجمیع سفارش‌های مادر»; the hub keeps exactly its four primary tabs, and the deep link `#/admin/wms/inbound-ops` resolves through the existing redirect table.
- **Dashboard (§24):** server counters, each card deep-linking to a filtered queue; in-flight masters listed with staged/remaining/open-exception chips.
- **Receiving & QC:** full-page `WorkspaceModal` with per-line quantity entry, live reconciliation hints («دریافتی + کسری باید برابر ۵ باشد»، «جمع سه بخش باید برابر مقدار رسیدشده باشد»), GRN list, exception list, and buttons rendered **only** from the server-provided `actions[]`.
- **Exception Center (§14):** filters, context, «واگذاری به من», and a resolution dialog with the four canonical resolutions (each explained in operator language).
- **Consolidation workshop (§17–§22):** per-source progress (internal only), item verification, packing form (explicitly “real measured values only”), and the final Kolbe shipment form.
- **§25 vocabulary** is used throughout: محموله ورودی، در انتظار دریافت، دریافت فیزیکی، کسری، آسیب‌دیده، کنترل کیفیت، تأییدشده، نیازمند بررسی، آماده تجمیع، در حال بسته‌بندی، آماده ارسال، ارسال‌شده. No raw enums, UUIDs, JSON or column names are rendered; statuses are mapped to Persian labels.
- **Responsive (§26):** mobile-first card lists (`md:hidden`) with desktop tables (`hidden md:block`) so no desktop table is forced onto a phone; the static 360 px lint passes for the new file. Tap targets use the shared primitives (≥44 px buttons/inputs).
- **Accessibility:** reuses the design-system dialog (`WorkspaceModal`: focus trap, Escape, `aria-modal`, `data-autofocus`) and labelled fields; `role="alert"` on reconciliation warnings.
- **Caveat:** no Chromium binary is available in this sandbox, so no real browser sweep (360/390/768/1024/1280/1440 px, keyboard traversal, screen-reader sanity) was executed. Per the rules, this is reported as **LOCAL BROWSER UAT REQUIRED** — not as a pass.

## 10. Changed-file audit

Production code:

1. `backend/src/work-inbound.ts` (new, 969 lines) — inbound/QC/GRN/exceptions/dashboard/queues authority + routes.
2. `backend/src/wholesale-fulfillment.ts` (new, 331 lines) — shared OMS primitives: duties, warehouse resolution, policy, exception helpers, derived readiness.
3. `backend/src/wholesale-oms.ts` — thin adapters to the new authority, consolidation/packing/shipment guards, `consolidationActions`.
4. `backend/src/orders.ts` — three guards that keep the legacy v1 dispatch/consolidate path from becoming a second physical authority.
5. `backend/src/app.ts` — registers `registerWorkInboundRoutes` after the OMS routes.
6. `backend/src/migrations/074_prompt6_inbound_qc_consolidation.sql` (new).
7. `src/portals/wms-inbound-operations.tsx` (new, 867 lines) — the warehouse workspace.
8. `src/data/api.ts` — `wmsInboundApi` + Prompt 6 types.
9. `src/portals/warehouse-hub.tsx` — the new wholesale sub-tab.
10. `src/portals/admin.tsx` — the `wms:inbound-ops` deep-link redirect.

Tests and gates:

11. `backend/src/prompt6-inbound-qc-consolidation.test.ts` (new, 16 tests).
12. `backend/package.json` — Prompt 6 suite added to `npm test`.
13. `backend/scripts/run-embedded-tests.mjs` — 074 registered in the expected migration list.
14. `backend/scripts/verify-migrations.mjs` — 074 expectations + 8 structural checks.
15. `backend/scripts/frontend-contract-smoke.ts` — 8 Prompt 6 contract checks (static + live).
16. `backend/scripts/qa-responsive-static.mjs` — the new surface added to the 360 px lint.

Documentation:

17. `docs/parallel/prompt-6-inbound-qc-consolidation-shipment-report.md` (this report).

Generated output is deliberately **not** part of the patch: the production bundle (`dist/index.html`) and `node_modules` are build/dependency artifacts and were reverted after being used as verification evidence (following the Prompt 5 convention of excluding generated build output from the staged patch).

Temporary harnesses (`backend/scripts/tmp/`) are **not** committed; they were removed before the commit (see §14).

## 11. Explicitly deferred / out of scope

- Prompt 7 (Discount & Festival Center) and Prompt 8 (Final Integration/Hardening) — not started.
- Supplier Settlement/Finance payables, advances, deductions and payouts — untouched; `refund_pending` only records a finance reference.
- Cashback, Returns/Refunds redesign, Storefront, CMS, CRM, Style Builder, Try-on, Retail PDP/cards and media redesign — untouched.
- Evidence attachments on QC: the existing media service is reused by reference, but no new upload UX was added inside the receiving form in this pass (a documented, non-blocking follow-up; the API accepts operator notes today).

## 12. §43 — completion checklist (40 items)

1. Existing inbound/WMS/OMS/consolidation capability audited and classified **before** implementation, with the classification table in §2.
2. Nothing was rebuilt wholesale: every Prompt 6 fact extends a pre-existing canonical table or module.
3. The canonical Inbound Shipment lifecycle uses existing persisted states (Expected/Dispatched/In Transit/Arrived/Receiving/Received/QC Completed/Resolved/Ready) and is exposed as `oms_inbound_shipments`.
4. No `InboundV2`, `WMSV2`, `OMSV2`, parallel Shipment Center, second Master Order, second commercial truth, second media store or second shipping-quote engine was created.
5. GRN/physical receiving reconciles quantities **server-side**: `dispatched = received + missing`, refused otherwise (`400`), never assumed from the UI.
6. Legitimate partial receiving is supported end to end (dispatched 5 → received 4 → missing 1).
7. Damaged units are their own bucket and are never re-counted as missing or rejected (`received = accepted + rejected + damaged + pending`).
8. Physical receiving is a distinct fact from QC: arrival ≠ accepted stock, receipt ≠ QC passed.
9. QC records accepted / rejected / damaged / pending with reasons, notes, actors and timestamps.
10. QC evidence uses the existing media service; no new media storage mechanism was introduced.
11. Partial inspection stays partial; nothing auto-completes and no requirement is silently closed.
12. No supplier self-approval: a supplier can never receive or QC its own goods (403), and duty checks are server-side.
13. No duplicate final inspection: immutable receipt, one GRN per OMS shipment, `INBOUND_ALREADY_QC` on re-finalisation, database-level uniqueness.
14. No stock credit before a canonical physical + QC event — receiving/QC write no stock balances at all.
15. The Exception Center lives inside the existing warehouse workspace and is a view over `fulfillment_exceptions` (no separate Customer Order Center).
16. Exceptions are actionable: assignment, four canonical resolutions, notes, audit trail, finance follow-up referenced not executed.
17. Readiness for consolidation is derived from records only — no manual «آماده تجمیع» toggle exists anywhere in the code.
18. Supplier ready-for-handoff/dispatch is never confused with Kolbe ready-for-consolidation (asserted in GOLDEN-1 and P6-OMS-003).
19. Master consolidation uses the existing `master_consolidations` / `consolidation_items` only.
20. Verification precedes packing, and completion is refused while any item is unverified (`CONSOLIDATION_NOT_READY`).
21. Packing records only real operator-entered values; weight/dimensions are never fabricated and stay `NULL` when unknown.
22. The final shipment is Kolbe-only and reuses the canonical master ship/deliver APIs, labels and tracking fields.
23. A supplier can never ship to a buyer nor select the destination; the warehouse is server-resolved and destination spoofing is rejected (400).
24. The buyer always sees exactly ONE Master Order; internal sourcing/child/receiving topology is never exposed (assertions in GOLDEN-1/GOLDEN-3).
25. Permissions are server-derived per action (`receive`, `inspect`, `approve_qc`, `reject_qc`, `resolve_exception`, `pick`, `verify_item`, `complete_consolidation`, `pack`, `ship`) and re-checked on every route.
26. Idempotency is implemented for every Prompt 6 mutation (same key + same payload → same outcome; different payload → conflict).
27. Real concurrency is tested, not just sequential calls (two QC operators on one receipt; row locks via `FOR UPDATE` on the inbound document).
28. Database-level constraints enforce the invariants even if application code is bypassed (bucket checks, one-scope GRN rule, one live leg, one GRN per shipment).
29. One physical movement produces exactly one accounting effect; the legacy double-deduction path is blocked and covered by GOLDEN-5.
30. Ownership is preserved through arrival, receiving, QC, consolidation and picking; conversion remains only via the explicit canonical movement types.
31. Migration 074 is additive, numbered immediately after 073, and overwrites nothing.
32. Migration safety is verified on both a fresh database and a populated 073-era database built by the previous release's real code paths.
33. Migration exactly-once semantics and no-op re-run are verified (`run-embedded-tests.mjs`, `verify-migrations.mjs`, populated harness).
34. The warehouse dashboard counters are server-derived and each card deep-links to a filtered work queue (no vanity metrics).
35. All operational UI is Persian, RTL, task-oriented, and uses the approved §25 label vocabulary without raw enums/UUIDs/JSON.
36. The UI is responsive with mobile-first card lists instead of forced desktop tables, and passes the static 360 px overflow lint.
37. Complex receiving/QC flows use a full-page workspace dialog with the design-system focus/escape/aria behaviour.
38. Navigation respects existing hubs: the WMS hub keeps four primary tabs and owns the new warehouse workflow via a sub-tab + deep link — no duplicate top-level tab.
39. Prompt 1–5 regressions, unified-auth/OMS remediation coverage, Prompt 3 consignment invariants, the embedded suite, the contract smoke, the dynamic-table/pricing smokes, the responsive lint, both type-checks, the migration verifier and the production build were all re-run after the last production change — with exact numbers in §8.
40. Evidence is reported honestly: environment limitations (PGlite, no Chromium, `npx` permission quirk) are stated, no browser PASS is claimed from API tests, and the remaining browser UAT is explicitly required.

## 13. Integration and finalization state

- Commit(s) contain the production code, migration, tests, updated gates and this report; temporary harnesses under `backend/scripts/tmp/` were deleted before committing.
- The Agent branch is pushed normally to `arena/7030df7b-kolbevintage` (no force-push). Local HEAD and remote HEAD are verified equal at finalization.
- The pull request `feat(wms): complete Prompt 6 Inbound, QC, Consolidation and Shipment` targets `arena/01a10ace-kolbevintage` (never `main`), is **left open**, and is **not** auto-merged. The Agent branch is not deleted.
- No other agent's branch, no `main`, and no separately developed Storefront/CMS/CRM work was modified.

## 14. Honest caveats and limitations

1. **Browser UAT not executed.** No Chromium binary is available in this environment; the UI was verified by type-check, contract smoke against the real API, static responsive lint and the backend acceptance suite. Required banner: **LOCAL BROWSER UAT REQUIRED**.
2. **PGlite instead of a PostgreSQL server.** The embedded environment speaks the PostgreSQL wire protocol (same engine family as the PostgreSQL 17.9 used in Prompt 5), but it is not the production server binary. All concurrency assertions (row locks, unique indexes, CHECK constraints) ran against this embedded engine.
3. **Shared-database test hygiene.** Two pre-existing Prompt 4 tests assert database-wide counts and therefore fail when the suite is run twice against a non-fresh database — reproduced independently of this work (`prompt4-oms.test.ts` fails 1 test on a second identical run). The Prompt 6 suite avoids that class of assertion (delta-based counters, per-fixture filters).
4. **Delivery already documented** in §9: no evidence-attachment upload widget in the receiving form yet (API notes are supported and used by tests).
5. The Prompt 4 database-wide-count assertions are the only known non-Prompt-6 red signals in a *re-used* database; on the standard fresh embedded run everything passes (§8). One intermediate run additionally showed a single unrelated pre-existing failure (`manual-sales.test.ts`, «product structure: persisted colors…», `401 !== 201`); the identical run immediately afterwards was fully green (293/293) and `manual-sales.test.ts` passed 5/5 when re-run alone, so it is recorded as PGlite flakiness in an untouched suite, not as a Prompt 6 regression.

---

**PROMPT 6 COMPLETE — LOCAL BROWSER UAT REQUIRED**
