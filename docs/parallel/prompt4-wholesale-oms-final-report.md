# PROMPT 4 — WHOLESALE ORDER CENTER / MULTI-SUPPLIER OMS: one customer order, three legitimate sources, Kolbe-mediated delivery

Final report of Prompt 4 (of 8). Prompts 1–3 were accepted; this prompt delivers the canonical VIP
Wholesale Order Center (master order, multi-supplier allocation, fulfilment orchestration, Kolbe-mediated
delivery, snapshots, idempotency, operational UX) and does **not** start Prompt 5 (Supplier Portal) or
Prompt 6 (inbound/QC/consolidation/final-shipment execution).

Baseline for this prompt: Prompt-3 HEAD `1ff2268` · starting SHA of the P4 work: `1ff2268`.

---

## 1. Repository state

| Item | Value |
| --- | --- |
| Session branch (all work committed here) | `arena/01a10ace-kolbevintage` |
| Starting SHA (Prompt-3 close, verified ancestor) | `1ff2268` |
| Final SHA (code + tests, second pass) | `5c951ae` (code/tests) — the docs-pin commit that records this SHA is the branch tip |
| Merge-base with `origin/main` | `3cd9dace97e00e3131af018fb5b696f8c18d67fc` — `main` untouched, never merged/reset |
| Working tree | clean (no `dist/`, `node_modules/`, `.scratch/` or browser artifacts committed) |
| Migration count | **52** (`071_wholesale_child_cancellation.sql` is the only Prompt-4 migration, additive) |
| Local HEAD == remote HEAD | verified after the push (see §34) |

**Branch note (transparency):** this Arena session is hard-bound to `arena/01a10ace-kolbevintage`; all
Prompt-4 commits live on that branch as direct descendants of `1ff2268`.

**State anomaly handled honestly:** at the start of the continuation the local branch ref had been reset
to `3cd9dac` by the sandbox while the worktree still held the Prompt-3 + Prompt-4 content. A backup tarball
was written, the ref was re-pointed with `git reset -q 1ff2268` (no `--hard`, no worktree change), and the
P3 ancestry plus every P4 change was verified afterwards. Nothing was discarded.

---

## 2. The exact Master Order model (§3–§6, §19, §20, §42, §65)

* One VIP checkout creates **ONE customer-facing Master Order** (`master_orders`, reference `MV-…`).
  The three suppliers/products of the accepted example (Product A → Supplier Alpha 4 series,
  Product B → Supplier Beta 3 series, Product C → Kolbe physical 2 series) become **three internal child
  orders** (`orders` rows with `master_order_id`), never three customer orders. Verified by
  P4-OMS-004 / P4-OMS-024 evidence: `master_orders` count for the buyer = 1, `children = 3`, buyer
  payload contains no seller identity.
* The master owns commercial facts (reference, composition state, shipping address/method, carrier,
  tracking, locked/shipped/delivered timestamps) and **never loses history**: child lines carry an
  immutable purchase-time snapshot, and no operational action rewrites placed commercial data.
* Seller resolution is canonical: explicit offer → supplier-owned product → Kolbe. All lines of one
  seller are grouped into the same child order; a child is the financial unit (payment intent), the
  master is the customer unit.
* Cycle-free composition: `open → locked`; cancellation is the only path that closes a master early.

## 3. Allocation model (§7, §15, §16, §34–§37, §40, §45)

`order_source_allocations` is the single allocation ledger with exactly three source types:

| Source | Meaning | Physical effect |
| --- | --- | --- |
| `kolbe_stock` | Kolbe-owned physical series at Kolbe | canonical WMS reservation (never a decrement) |
| `supplier_stock_at_kolbe` | supplier-owned physical series already at Kolbe | canonical WMS reservation of a supplier-owned balance |
| `supplier_external` | supplier declared capacity (not physical) | supply requirement + atomic capacity reservation on confirmation |

Rules enforced server-side:

* sum(active allocations per line) ≤ line demand; physical allocations are bounded by WMS allocatable;
* capacity allocations are bounded by `declared_capacity − reserved_external − safety_buffer`, **including
  live unconfirmed plans in the same request and in the database** (added this prompt: a second order can no
  longer over-book declared capacity that is already planned by an unconfirmed request);
* a `pending` capacity row consumes nothing — the hold is created atomically only when the supplier confirms;
* allocation never converts ownership and never invokes the wholesale→retail conversion.

## 4. Coverage / readiness derivation (§24–§28, §62)

* `masterCoverage(masterId)` → `{orderedSeries, kolbeSeries, supplierAtKolbeSeries, capacitySeries,
  receivedSeries, qcPassedSeries}` (one query, no N+1).
* `deriveMasterReadiness` → `not_ready | partial | ready | shipped | delivered | cancelled`. Rules:
  * `ready` requires every included child paid **and** consolidation-ready/consolidated **and zero capacity
    series**;
  * **declared capacity is never progress**: a capacity-only order is `not_ready`; once something is
    physically held (or a child is paid / fulfilment progressed) it is honestly `partial`;
  * no editable «آماده ارسال» toggle exists anywhere in the API or UI.
* the list is filterable server-side by `search`, `status`, `readiness`, **`customerStatus`** (the derived
  lifecycle), `supplyRequired`, `dateFrom`/`dateTo`, `sort` and `before`; a contract check now reads the
  Order Center source and fails if the UI sends any query parameter the server schema does not accept —
  this caught the `customerStatus` filter being silently ignored and it was wired server-side (P4 suite
  asserts every returned lifecycle value round-trips through the filter).
* `masterCustomerStatus` maps internal states to the small customer lifecycle
  (`processing / awaiting_payment / needs_decision / preparing / ready_to_ship / shipped / delivered /
  cancelled`) with Persian labels; the list/detail expose only the derived code **and** its label.
* The list row keeps the Prompt-2 keys (`child_count`, `ready_children` = payable children) and adds the
  coverage vocabulary (`included_children`, `ordered_series`, `kolbe_series`, `supplier_at_kolbe_series`,
  `supply_required_series`, `inbound_series`, `consolidation_ready_children`).

## 5. Physical reservation integration (§15, §35, §37)

`kolbe_stock` / `supplier_stock_at_kolbe` allocations are executed through the WMS primitives already
authoritative in this module: a `stock_reservations` row plus `stock_balances.reserved` delta and a
`stock_movements` entry; series-level holds sit in `order_series_reservations` and
`series_stock_balances.reserved`. Ordering never decrements `on_hand`; consumption happens only at pick
through the canonical path. Releasing a hold is idempotent (`GREATEST(0, …)` + movement row). Verified by
P4-OMS-006 (on_hand 5 / reserved 3 after ordering 3) and P4-OMS-010 (release back to reserved 0).

**Retained compatibility code (documented, not duplicated authority):** these reserve/release/consume
statements live inside `backend/src/wholesale-oms.ts` (Prompt-2 origin) and write the same WMS tables the
Prompt-3 inventory module reads — there is no parallel stock table and no second reservation store.
Capacity paths never touch them.

## 6. Capacity reservation integration (§16, §36, §43)

`reserveSupplierCapacity` / `settleSupplierCapacityReservation` (canonical, from `supplier-offers.ts`) are
the only writers of `supplier_capacity_reservations` and `supplier_offers.reserved_external`; the OMS
contains **zero** raw writes to `reserved_external`. A confirmed capacity allocation creates only a
«نیاز به تأمین»: no `stock_balances`, no `stock_receipts`, no `series_stock_balances`, no at-Kolbe state, no
QC, no fulfilment-ready (P4-OMS-008/023). Over-capacity is refused (409) and a second confirmation can never
consume the same declared capacity twice (P4-OMS-009). Release/expiry returns capacity exactly once
(`GREATEST(0, reserved − qty)`, `status='released'`), and an already-settled reservation throws instead of
double-releasing (P4-OMS-010, `oms/expire-sweep`).

## 7. Source reassignment (§33, §17)

`POST /api/v1/wholesale/allocations/:id/reassign` (ops only, body `{toOfferId? | toSource?} + reason 4–500`):

1. refuses after irreversibility (received / QC / dispatched / consolidation);
2. target offer must be `active`, same product/series, with enough free capacity **and** no conflicting
   unconfirmed plan;
3. asserts price neutrality against the canonical pricing resolver (409 `REASSIGN_PRICE_CHANGED`);
4. releases A through the canonical paths (capacity settle or WMS hold release), then assigns B through the
   **same** `createOrderAllocation` primitive used at order creation, with the identical quantity;
5. appends `negotiation_history {type:'reassigned', …}`, an audit row
   (`wholesale_allocation.reassigned`) and an outbox event; demand and the line price snapshot are untouched.

## 8. Cancellation behaviour (§30, §31, §43)

`POST /api/v1/wholesale/masters/:id/cancel` (ops, or the owner while nothing is paid):

* refuses (409 `MASTER_ALREADY_FULFILLING`) once any allocation is consumed/received/QC/dispatched or a
  child is received/QC/consolidation/consolidated; refuses shipped/delivered masters;
* releases physical holds through `releaseLineHolds`, settles capacity reservations, cancels unstarted
  supply requirements, and performs one final sweep of live rows;
* marks each child `cancelled` (+`cancel_refund_pending` when already paid), writes exactly one
  `order_events` cancellation row per child, and emits `child_order.cancelled` (+`child_order.refund_requested`
  for paid children) — **no refund/finance logic**;
* blocks later fulfilment actions, and a repeated cancel (any key) returns the canonical result with
  `duplicate: true` and never double-releases (P4-OMS-010/011, P4-OMS-025).
* `071_wholesale_child_cancellation.sql` widens the `orders_wholesale_fulfillment_status_check` constraint
  additively so `'cancelled'` is representable; 055/064 were not rewritten.

## 9. Creation idempotency (§41)

`POST /api/v1/wholesale/masters` requires `Idempotency-Key` (validated before the VIP/wholesale gates):
same key + same payload → the same master, one reservation, one child set; same key + different payload →
deterministic `CONFLICT` with no extra mutation (P4-OMS-011/012).

## 10. Series / pricing snapshots (§8, §9, §12, §44, §63)

Creation re-resolves the canonical Series composition and price on the server; the client can never submit
price/discount/total (400). The line stores `unit_series_price_rial`, `pieces_per_series`,
`line_total_rial`, `commercial_snapshot.perPiece[]` and `snapshot_locked_at`; later catalog price or
composition changes never rewrite a placed order, and totals are read from the snapshots (P4-OMS-013/014/020).

## 11. Buyer / Admin projections (§20, §21–§23, §49, §64)

One read model, two **server-side** serializers. The projection is chosen by the caller's role — a buyer
cannot request the ops view, and a supplier token receives `403` (P4-OMS-024).

* **Buyer** (`view:'buyer'`): reference, composition, status, timestamps, derived customer status + label,
  items (product/series/color, series count, pieces, purchase-time unit price, line total), sub-order
  references with payable/cancelled flags, totals, shipping, available actions and a Persian timeline.
  Serializer whitelist is asserted by test (exact key sets, leak scan for seller ids, offer ids, source
  types, `child_fulfillment`, `reserved_external`, warehouse/offer terms).
* **Ops** (`view:'ops'`): buyer context, coverage, readiness, children with `allowedActions`, lines with the
  **three separate allocatable buckets** and their allocation rows, exceptions, consolidation, internal
  timeline with codes, and master-level `allowedActions` (`cancel_master`, `reassign_allocation`).

## 12. VIP membership enforcement (§10, §11)

The gate is the canonical server-side entitlement: an active `memberships` row with `starts_at <= now() <
ends_at`. Expired, pending or absent membership → 403; a non-VIP customer → 403; demo roles and client
flags are never authority. Wholesale ordering additionally requires `products.wholesale_enabled`; a
retail-only product → 403 `FORBIDDEN` with no silent reinterpretation (P4-OMS-001/002). `/auth/me`
membership behaviour was not modified.

## 13. Supplier privacy (§20, §39, §49)

Buyer-facing responses contain no supplier id/email/phone, no offer id, no allocation topology, no capacity
numbers, no internal warehouse or fulfilment identifiers and no internal enum literal; enforcement lives in
the serializer, not in React. The supplier panel remains Prompt-5 scope and still receives child orders
only (no buyer identity).

## 14. No direct Supplier → VIP shipping + final-dispatch guard (§4, §69, §16–§18)

* The supplier dispatch contract accepts **only** `{trackingNote}`; a payload carrying a customer `address`
  is rejected (400) and the child is never marked delivered by a supplier action.
* The only shipment that can reach the VIP is `POST /wholesale/masters/:id/ship`, guarded server-side:
  it requires a completed consolidation (`409 CONSOLIDATION_NOT_READY` otherwise) and rejects cancelled or
  already-shipped masters; `deliver` is guarded the same way. Capacity-only orders can never pass
  (`deriveMasterReadiness` keeps them out of `ready`).
* The canonical path enforced by the data model stays: supplier / Kolbe stock → Kolbe warehouse → receive &
  QC → consolidate → **Kolbe final dispatch → VIP**.

## 15. Customer status mapping (§24, §62)

Internal complexity is mapped once, server-side (`masterCustomerStatus`), to the small customer lifecycle
already used in this project: «در حال بررسی/آمادهسازی», «در انتظار پرداخت», «نیازمند تصمیم خریدار»,
«آماده ارسال», «ارسالشده», «تحویلشده», «لغوشده». The ops screens show the operational vocabulary
(آمادگی عملیات + پوشش) separately; no raw enum string is rendered.

## 16. Admin Wholesale Order Center UX (§21–§23, §29, §56–§62, §71, §72)

`src/portals/wholesale-order-center.tsx` (mounted in the Orders Hub `masters` tab, deep-linkable from the
admin console):

* **List**: newest-first by default; search by master reference or VIP buyer name; date window; customer
  status; ops readiness; supply-required; sort oldest/newest; a live result count (`total` from the server,
  filter-aware) and a clear-filters action; concise columns — سفارش / خریدار VIP / تاریخ / پوشش موجودی /
  نیاز به تأمین / آمادگی عملیات / وضعیت سفارش / مبلغ / اقدام. No UUID or enum is rendered.
* **Detail**: a full-page workspace with named sections — خلاصه سفارش، خریدار VIP، اقلام سفارش، تخصیص و
  تأمین، وضعیت انبار، ورودی و کنترل کیفیت (existing data only, with an explicit note that the physical
  workflow belongs to Prompt 6), تجمیع و ارسال نهایی، تاریخچه — never a side drawer.
* **Line coverage**: each line shows product, series name/color, ordered series, pieces per series and total
  pieces, the immutable unit price and line total, the three buckets separately
  (موجودی کلبه / موجود تأمینکننده نزد کلبه / ظرفیت تأمینکننده) with allocated-vs-allocatable numbers,
  an explicit «پوشش ناقص — N سری» / «پوشش فیزیکی کامل» / «در انتظار تأمین» chip per line, and the
  planned-vs-demand total.
* **Allocation workspace**: shows demand, allocatable and planned preview per bucket before committing a
  reassignment, requires a written reason, and reloads canonical data after every mutation (no
  client-only optimistic truth). Cancellation is a destructive action with an explicit confirmation modal.

## 17. Migrations / schema impact (§109)

One additive migration: `071_wholesale_child_cancellation.sql` (widen an existing CHECK constraint to accept
`'cancelled'` on `orders.wholesale_fulfillment_status`). No table was rebuilt, 055/064 were not rewritten,
and the migration inventory guard (52 files, 050z distinct id) plus the populated-upgrade path were updated
and verified.

## 18. Open DEC-OMS items (§108)

Recorded in `docs/product/PRODUCT_DECISIONS_REQUIRED.md` with issue, options, current safe fallback and
implementation impact — **not guessed in code**:

* **DEC-OMS-001** — automatic source priority among several active suppliers (fallback: no invented
  priority; deterministic feasibility + explicit audited manual reassignment).
* **DEC-OMS-002** — cancellation cut-off / financial behaviour for paid or rejected orders (fallback: block
  at the first irreversible operational step; flag `cancel_refund_pending` for the finance scope).
* **DEC-OMS-003** — partial customer shipments and expiry policy of an unconfirmed supply requirement
  (fallback: no automatic splitting, one Kolbe final shipment, existing expire-sweep/payment deadline).

## 19. Dead code / duplicate-authority audit (§107)

| Checked | Result |
| --- | --- |
| Old wholesale-order admin screen | replaced by the Order Center; the Orders Hub strip stays as the compact list and the new `masters` tab hosts the workspace — no second wholesale order admin surface |
| Fake/demo VIP gate | none in the wholesale path; the server entitlement is the only authority |
| Parallel allocation store | none — `order_source_allocations` is the single ledger |
| Frontend-derived readiness | none — every readiness/coverage number comes from the server |
| Client-trusted price | none — client price/discount/total is rejected (400) and never read |
| Direct supplier dispatch | impossible — dispatch accepts only `trackingNote` |
| Buyer API leaking internals | covered by whitelist + leak-scan tests |
| Duplicate capacity reservation code | none — only the canonical primitives write capacity |
| Raw stock mutation in the OMS | only the canonical reserve/release/consume pairs on the shared WMS tables (documented in §5); capacity paths write no stock |
| Removed obsolete zero-importer paths | the superseded pre-rewrite projection helpers in `wholesale-oms.ts` were deleted; the unused price-neutrality helper was removed after its logic was inlined into the reassign route |

## 20. Exact test counts (frozen after the LAST code change)

| Gate | Result |
| --- | --- |
| Full embedded backend suite (`npm run test:embedded`, fresh PGlite + migrations + full `test`) | **239/239 pass, 0 fail** |
| Migration verifier (`scripts/verify-migrations.mjs`) | **ALL CHECKS PASSED** (52 files; second run no-op; populated 068→071 upgrade) |
| Prompt-4 acceptance suite (`src/prompt4-oms.test.ts`, 11 integration tests) | **11/11 pass** (covers P4-OMS-001…025) |
| Prompt-2/3 regressions inside the embedded suite (`wholesale-oms`, `series-inventory`, `wms-workflows`, `prompt3-wms`, `oms`, pricing/snapshot suites) | pass (included in 239/239) |
| Contract smoke (`npm run test:contract`) | **142/142** (7 new Prompt-4 static/contract locks: UI-filter↔schema parity, three source buckets, ops-only workspace, destructive-cancel confirmation, no rendered identifiers, server-derived readiness, Prompt-6 boundary note) |
| Dynamic-table smoke (`npm run test:dynamic-table`) | **14/14** |
| Pricing-routing smoke (`npm run test:pricing-routing`) | **25/25** |
| Responsive static QA (`backend/scripts/qa-responsive-static.mjs`, now covering the P4 surfaces) | **1/1 PASS** — 14 surfaces, 35 fixed/min widths ≥320px, none without a scroll/clamp wrapper |
| Backend TypeScript (`tsc -p backend/tsconfig.json --noEmit`) | **0 errors** |
| Frontend TypeScript (`tsc -p tsconfig.json --noEmit`) | **0 errors** |
| Production build (`vite build`) | OK — `dist/index.html` 2,407.71 kB / gzip 593.90 kB; `dist/index.html` restored afterwards, nothing built is committed |
| §110 UAT seed (`seed:local` twice on a fresh DB) | one master `MV-2000`, 3 children; coverage `kolbe_stock/reserved/2`, `supplier_stock_at_kolbe/reserved/2`, `supplier_external/pending/2`; **idempotent** (identical row set after the second run) |

Two late fixes landed after the first battery and every gate above was re-run afterwards:

* **Filter parity (real defect, fixed):** the Order Center sent `customerStatus`, which the list schema did
  not accept, so the UI filter was silently ignored. The lifecycle is now a server-side filter over the
  derived column, the stale unknown `withTotal` param was removed, the P4 suite round-trips every lifecycle
  value, and the contract smoke locks UI filter params to the server schema.
* **SEO integration test data (test-only, pre-existing latent bug):** `seo.integration.test.ts` asserted a
  `ProductGroup` schema node for a product seeded with only ONE variant, where the canonical rule
  (`storefront-html.ts`: a group is emitted when a product has more than one variant) means no group can
  exist. The assertion therefore only ever passed by matching the *inlined SPA bundle text* of a freshly
  built `dist/index.html`. The test now seeds a genuinely multi-variant retail product, so the check
  exercises real rendering. No production behaviour was changed and no check was weakened.

## 21. P4-OMS-001 … P4-OMS-025 → evidence map

| ID | Requirement | Evidence (test → assertion) |
| --- | --- | --- |
| P4-OMS-001 | VIP membership gate | `P4-OMS-001/002/003` → expired membership 403, no-membership 403; `scope=all` 403 for a buyer |
| P4-OMS-002 | Retail-only product rejection | same test → 403 `FORBIDDEN`, no master created |
| P4-OMS-003 | Server-authoritative price | same test → client price payload 400; server total 60,000,000 computed from the resolved 30,000,000/series |
| P4-OMS-004 | One master / multiple sources | `P4-OMS-004/005/024` + `…prescribed 4+3+2…` → 3 children, 1 master, allocation rows per source |
| P4-OMS-005 | Buyer privacy | `P4-OMS-004/005/024` → exact buyer key whitelist + leak scan (seller ids, offer ids, source types, internal terms) |
| P4-OMS-006 | Physical reservation | `P4-OMS-006/007/020` → on_hand 5 / reserved 3 + `order_series_reservations` active 3 |
| P4-OMS-007 | Physical over-allocation guard | same test → second order for 3 → 409 `INSUFFICIENT_SERIES`, master count unchanged, balance untouched |
| P4-OMS-008 | Supplier capacity allocation | `P4-OMS-008/009/026` → capacity 5 → pending allocation, zero stock/receipt/series rows, `not_ready` |
| P4-OMS-009 | Capacity double-consume guard | same test → over-capacity create 409; one active capacity reservation; `reserved_external` incremented once; (plan guard) unconfirmed plans hold no capacity |
| P4-OMS-010 | Cancellation releases | `P4-OMS-010/011/027` → reserved 4→0, capacity 0, allocations closed once, one event per child, wallet untouched |
| P4-OMS-011 | Creation idempotency | `P4-OMS-012/028` → same key/payload → same id, one master, reservation applied once |
| P4-OMS-012 | Idempotency payload conflict | same test → different payload under the same key → 409, still one master |
| P4-OMS-013 | Price snapshot | `P4-OMS-013/014` → snapshot 40,000,000 after a catalog reprice to 999,000,000 |
| P4-OMS-014 | Series snapshot | same test → `commercial_snapshot.perPiece` keeps the ordered composition after a composition change |
| P4-OMS-015 | Partial readiness | `P4-OMS-015/016` (after one pick → `partial`) + mixed-coverage scenario (10=3+2+5 → `partial`, never `ready`) |
| P4-OMS-016 | Final dispatch guard | `P4-OMS-015/016` → `ship`/`deliver` before consolidation → 409 `CONSOLIDATION_NOT_READY` |
| P4-OMS-017 | No direct Supplier → VIP shipping | same test → dispatch with a customer address 400; child not delivered; master `shipped_at` null |
| P4-OMS-018 | Source reassignment | `P4-OMS-017/018/019` → release A / assign B, demand conserved, audit + `negotiation_history`, price-neutral, reason required |
| P4-OMS-019 | Buyer-order authorization | `P4-OMS-017/018/019` → foreign buyer read 403 and cancel 403 |
| P4-OMS-020 | Master total consistency | `P4-OMS-006/007/020` → list `total_rial` == snapshot price × series == detail `totals.totalRial` |
| P4-OMS-021 | Retail / wholesale isolation | `P4-OMS-021/022/023` → retail `stock_balances` sum unchanged; mixed scenario keeps wholesale-only rows |
| P4-OMS-022 | Ownership preservation | `P4-OMS-004/005/024` (supplier-owned stays supplier-owned, no conversion for those variants) and `P4-OMS-017/018/019` |
| P4-OMS-023 | Capacity never becomes physical | `P4-OMS-008/009/026` (+ mixed scenario) → no stock, no receipt, no at-Kolbe balance, no Kolbe row |
| P4-OMS-024 | Distinct buyer/Admin projections | `P4-OMS-004/005/024` → buyer whitelist, ops-only fields, supplier token 403 on the ops projection |
| P4-OMS-025 | Transition guards | `P4-OMS-021/022/023` → pick/ship after cancel rejected; status filters consistent with the derived state |

## 21b. Requested report items → where each is answered

| Requested item (§29 of the prompt) | Section |
| --- | --- |
| starting SHA / final SHA / branch | §1 |
| exact Master Order model | §2, §3 |
| allocation model | §3 |
| coverage / readiness derivation | §4 |
| physical reservation integration | §5 |
| capacity reservation integration | §6 |
| source reassignment | §7 |
| cancellation behaviour | §8 |
| creation idempotency | §9 |
| Series / pricing snapshots | §10 |
| Buyer / Admin projections | §11 |
| VIP membership enforcement | §12 |
| supplier privacy | §13 |
| no-direct-shipping guarantee | §14 |
| final-dispatch guard | §14 |
| Order Center UX | §16 |
| customer status mapping | §15 |
| migrations / schema impact | §17 |
| open DEC-OMS items | §18 |
| dead code removed / retained | §19 |
| exact test counts | §20 |
| mapping P4-OMS-001..025 → evidence | §21 |
| browser status | §24 |
| commit SHAs / local == remote / clean tree | §1, §25 |
| explicit Prompt-5 / Prompt-6 deferrals | §23 |
| security audit (buyer isolation, supplier data, permissions) | §22 |
| UI/UX qualities: RTL Persian, no enums/ids, no overloaded clusters, clear hierarchy, loading/error/empty, destructive confirmation, a11y labels | §11, §13, §16 (and the static locks in §20: no rendered identifiers, status not colour-only labels, named action buttons, `aria`-labelled sections) |
| responsive 360 / 390 / 768 / 1024 / 1280 / 1440 with no whole-page overflow | §20 (responsive static QA, now covering the four P4 surfaces) |
| multi-supplier 4+3+2 scenario | §21 (P4-OMS-004/008/015/016/022 evidence) and §2 |
| mixed coverage 10 = 3 + 2 + 5 scenario | §21 (P4-OMS-008/023 evidence) |
| historical immutability | §10, §21 (P4-OMS-013/014) |
| order-creation idempotency + payload conflict | §9, §21 (P4-OMS-011/012) |

## 22. Security audit (buyer isolation / permissions)

Verified by the matrix: buyer A cannot read or cancel buyer B's master (403); a non-VIP cannot create a
wholesale order (403); a supplier cannot read a master's ops projection (403) and the supplier endpoints
expose child orders without buyer identity; a buyer cannot reassign allocations, cancel another buyer's
order, or drive WMS fulfilment mutations (ops-only routes); private supplier data is absent from buyer
payloads (asserted by exact key sets and a leak scan).

## 23. Explicit deferrals (Prompt 5 / Prompt 6 and out-of-scope)

* **Prompt 5 — Supplier Portal:** only the backend supplier contracts used by the OMS are touched
  (line respond + child dispatch); no supplier workspace/UX was built.
* **Prompt 6 — inbound / QC / consolidation / final shipment execution:** the Order Center *summarises*
  existing inbound/QC/consolidation data and explains readiness; no new physical workflow, no stocktake,
  no receiving UI, no consolidation execution UI beyond the existing routes.
* **Not implemented by design:** refunds/finance on cancellation (`cancel_refund_pending` flag + outbox hook
  only), supplier settlement/payouts, cashback, CRM redesign (deep-links only), Returns/Refund V2, payment
  gateway redesign, automatic customer-shipment splitting, automatic source-priority policy
  (DEC-OMS-001), automatic reallocation.

## 24. Browser status (§101–§106 of the request)

Exactly **one** bounded browser-availability check was performed; no Chromium/Firefox binary and no
playwright browser cache exist in this environment, and no download was attempted.

**Browser UAT: PENDING — LOCAL UAT REQUIRED.** Static gates (responsive lint at 360–1440 breakpoints,
FE/BE TypeScript, contract smoke, vite build) are **not** a browser PASS and are not reported as one.

---

## §114 Verdict

PROMPT 4 IMPLEMENTATION COMPLETE — LOCAL BROWSER UAT REQUIRED
