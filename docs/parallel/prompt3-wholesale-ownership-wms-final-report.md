# PROMPT 3 — WHOLESALE PRODUCTS / OWNERSHIP / WMS: canonical inventory domains, physical stock, ownership, Series & warehouse operations

Final report of Prompt 3 (of 8). Prompt 1 (unified Product Studio) and Prompt 2 (canonical pricing)
were accepted; this prompt hardens the existing WMS on top of the same canonical authorities and does
**not** start Prompts 4–8.

Baseline for this prompt: Prompt-2 HEAD `56db7e3dd8493c74dba85fcbc601975951372314`.

---

## 1. Repository state (as reported before implementation started)

| Item | Value |
| --- | --- |
| Session branch (all work committed here) | `arena/01a10ace-kolbevintage` |
| Baseline (Prompt-2 close) | `56db7e3dd8493c74dba85fcbc601975951372314` (`56db7e3`) |
| HEAD after this report commit | see §30 — **local == remote** after the pin commit |
| Merge-base with `origin/main` | `3cd9dace97e00e3131af018fb5b696f8c18d67fc` — `main` untouched, never merged |
| Working tree | clean (no `dist/`, `node_modules/`, `.scratch/` or browser artifacts committed) |
| Migration count | 51 — **no migration was added by Prompt 3** (see §23) |

**Branch note (transparency):** Prompt 3 §0 asks for a fresh prompt branch. A temporary
`prompt3/…` branch was created from `56db7e3`, but this Arena session is hard-bound to
`arena/01a10ace-kolbevintage` (work on any other branch is not tracked by the session), so the
temporary branch was deleted and every Prompt-3 commit lives on `arena/01a10ace-kolbevintage`, a direct
descendant of `56db7e3`. `main` was never merged into and never pushed.

## 2. Scope executed

Prompt 3’s acceptance matrix (`P3-WMS-001..020`) turned out to be **largely implemented already** by the
canonical WMS built in earlier prompts (domains, ownership, Series ledger, transfers, receipts,
capacity). Following §61/§20 (“prefer the current schema; do not redesign if correct”), the work was:

1. **Audit** the 13 concepts and the required invariants against code, migrations and tests (§5, §23).
2. **Verify** by writing an independent, numbered acceptance suite (`P3-WMS-001..020`).
3. **Fix only proven defects** — two idempotency holes were found and fixed (§14).
4. **Surface the approved vocabulary** for the wholesale→retail conversion in the WMS UI (§22).
5. **Record two open product decisions** rather than guessing them (§29).
6. **Run the full gate battery** on the frozen tree (§28) and report honestly, including the fact that
   browser UAT could not run here (§26).

Explicitly **not** done: OMS redesign (Prompt 4), supplier-portal workflow (Prompt 5), inbound/QC/
consolidation/outbound build (Prompt 6), finance/settlement (§59) or cashback (§60).

## 3. Knowledge pack read before any change (§1)

`AGENTS.md` → `docs/product/PRODUCT_DECISIONS_REQUIRED.md` → WMS/ownership slices of
`docs/product/KOLBE_DOMAIN_RULES.md` (RULE-SUP-001..004, RULE-PROD-001..002, RULE-WMS-001..004) →
`docs/product/KOLBE_SOURCE_OF_TRUTH.md` (WMS special rule: Physical Event → Document/Movement →
Ledger/Balance → Read Model; the UI never changes a balance without an operational document) →
journeys/expectations/scenario hits → the existing migrations and tests. Authority order applied as
specified: latest PO decision > AGENTS > Domain Rules > Source of Truth > Business Model > Journeys >
Expectations > scenarios > implementation > assumptions. Nothing was inferred where the docs are silent.

## 4. Skills check (§2)

Relevant UI/UX skills unavailable; repository design system used.

## 5. The canonical model — 13 distinct concepts (§3–§4)

| # | Concept | Canonical home | Explicitly **not** |
| --- | --- | --- | --- |
| 1 | Catalog definition (product/variant/Series recipe) | `products`, `product_variants`, `series_templates` | stock |
| 2 | Retail stock | `stock_balances.inventory_domain = 'retail'` | wholesale stock |
| 3 | Wholesale stock (pieces) | `stock_balances.inventory_domain = 'wholesale'` | retail stock |
| 4 | Supplier-owned-at-Kolbe | `products.owner_type / supplier_id` + `series_stock_balances.owner_type / supplier_id` | supplier-located |
| 5 | Kolbe-owned | same ownership fields with `owner_type = 'kolbe'` | “published” |
| 6 | Supplier **capacity** | `supplier_offers.declared_capacity − reserved_external − safety_buffer` | stock |
| 7 | Series inventory (units) | `series_stock_balances` + `series_stock_movements` | pieces |
| 8 | Retail units (pieces) | `stock_balances` retail rows | Series |
| 9 | Ownership conversion | `ownership_conversions` (+`used_quantity` capacity) | domain transfer |
| 10 | Series → unit conversion | `retail_supply_orders` document + events | ownership conversion |
| 11 | Warehouse transfer | `stock_transfers` document (Mode A single / Mode B multi-line) | instant A−10/B+10 |
| 12 | Reservations | `stock_reservations` (`inventory_domain`, order-line based) | capacity reservation |
| 13 | Stock ledger | `stock_movements` (+`series_stock_movements`) | a status field |

**Invariants enforced (and proven by the P3 suite):** definition ≠ stock · ownership ≠ warehouse ·
capacity ≠ stock · published ≠ in stock · wholesale stock ≠ retail stock · supplier-owned ≠
supplier-located · supplier capacity ≠ supplier stock-at-Kolbe · Series units ≠ pieces · never collapsed
into one status field. `stock_balances` is keyed `(variant_id, warehouse_id, inventory_domain)`;
ownership lives on the product/Series level, never in the balance key.

## 6. Domain independence + WMS as the only physical-stock authority (§5–§7)

* Retail and wholesale balances are separate rows with separate reservations; a retail reservation of
  3 against 10 leaves **7 retail allocatable and 5 wholesale untouched** (`P3-WMS-001`).
* Cross-domain movement is impossible through the adjustment endpoint (server rejects
  `sourceDomain/destinationDomain/transferToDomain` payloads with a business error) — the only legal
  path is the official transfer document.
* WMS remains the single physical-stock authority: Product Studio creates *definitions* only and
  bridges to stock through the canonical opening receipts (`POST /api/v1/admin/products/:id/inventory-setup`)
  or through embedded WMS actions that call the same APIs. No second stock authority was added.
* Prompt-1 Studio behaviour (definition-only, embedded initial inventory, continuous draft creation) is
  untouched — the only Studio/WMS file changed by Prompt 3 is a single UI wording line (§22).

## 7. Wholesale enablement per product + explicit ownership (§8–§11)

* A product can be retail-only, wholesale-only or both (`retail_enabled` / `wholesale_enabled`), on the
  same canonical product record; `016_commerce_product.sql` additionally enforces at DB level that a
  supplier-owned product is **wholesale-only** (`products_supplier_channel_check`) — a supplier product
  cannot be smuggled into retail by any API call.
* Ownership is always explicit (`products.owner_type`, `series_stock_balances.owner_type`) and is never
  inferred from warehouse, supplier account, domain, publication, Series or order source.
* **Supplier-owned at Kolbe is a valid canonical state**: `P3-WMS-003` receives 5 units into a Kolbe
  wholesale warehouse for a supplier-owned product and proves the product stays `owner_type='supplier'`,
  no retail stock appears, a manual retail adjustment is refused (403) and the official
  wholesale→retail transfer is refused without a completed ownership conversion.
* Receiving never converts ownership, never unpacks Series and never publishes a product.

## 8. Supplier capacity ≠ stock (§12)

* `GET /api/v1/products/:productId/wholesale-availability` returns, separated: verified Kolbe stock
  (`kolbeStock`, `source: kolbe_warehouse`, `confidence: verified`), per-offer verified stock-at-Kolbe
  (`stockAtKolbeSeries`) and the **declared external capacity** (`externalAvailableToRequest` =
  `declared_capacity − reserved_external − safety_buffer`, with `capacityConfirmedAt` + freshness).
* `P3-WMS-002` proves a declaration of 20 creates **zero** `stock_balances` rows, zero Series rows and
  zero rows in the WMS list, and that the capacity stays visible only as capacity.
* `P3-WMS-020` reserves 6 units of external capacity and proves the stock book is still empty, retail
  allocatable is 0, a warehouse transfer cannot be satisfied from capacity, and no inventory movement is
  written. Full supplier workflow stays Prompt 5; this prompt only guarantees the semantics.
* UI separation («موجود نزد کلبه» / «ظرفیت اعلامی تأمینکننده» / «در جریان تأمین») is present in
  `supplier-360.tsx` and `supplier-wholesale-panel.tsx` with an explicit note that WMS stock and declared
  capacity are different numbers.

## 9. Series units ≠ pieces, and historical snapshots (§13–§14)

* Series balances live in `series_stock_balances` with `owner_type/supplier_id/incoming/damaged/version`;
  piece-level wholesale balances live in `stock_balances` and are only created/consumed by the
  retail-supply document.
* `retail_supply_orders.recipe_snapshot` is immutable: `P3-WMS-009` edits the live recipe to 9 pieces per
  component after document creation and the dispatch still expands the snapshot (2 Series × 2 pieces = 4
  per component, total snapshot `piecesPerSeries = 6`).
* Overlay guard: intact Series counted in a warehouse must be covered by component pieces there — Series
  cannot be fabricated out of thin air.

## 10. Wholesale→retail conversion (§15–§17)

The canonical operation is the **retail-supply document**
(`POST /api/v1/retail-supplies` → `/dispatch` → `/receive`), not a new endpoint:

1. **validate** — warehouse purposes (wholesale source, retail destination), Series availability,
   component coverage;
2. **snapshot** — recipe frozen into the document;
3. **reserve** — Series units reserved server-side;
4. **deduct** — wholesale piece `on_hand` decreases when the Series is broken at dispatch;
5. **expand** — each Series expands through the snapshot to its component pieces;
6. **increment retail** — pieces arrive as retail `incoming` at dispatch and become `on_hand` only at
   receive (never before);
7. **movements** — every step writes `stock_movements` (`retail_supply` reference type) and
   `retail_supply_events`;
8. **record** — the document is the audit trail; there is no partial conversion.

* Exactly-18 proof (`P3-WMS-005`): recipe S2/M2/L2 × 3 Series → retail on_hand 6/6/6 = **18** units
  (incoming 0), wholesale Series 5 → **2**, owner `kolbe`, retail ledger sum 18.
* Idempotency (`P3-WMS-006/007`): same key + same payload → same document (`duplicate: true`, no second
  reservation — Series balance still 5/3); same key + different payload → deterministic `409`
  «کلید تکرار با درخواست دیگری استفاده شده است.» and no mutation.
* Atomicity (`P3-WMS-008`): an inconsistent piece balance makes dispatch fail with 409, leaves the Series
  balance untouched (5 on_hand / 3 reserved), writes **zero** `retail_supply` movements and creates no
  retail stock. No partial conversion is possible.

## 11. Ownership conversion (§18–§19)

* Only the existing `ownership_conversions` document is used — no parallel authority.
* `P3-WMS-011`: converting 3 of 5 units (variant-level purchase) leaves the physical book **bit-for-bit
  unchanged** (same `on_hand`, same `version`) and writes **no** stock movement (ownership ≠ quantity);
  only the receipt movement exists. The conversion is listed in
  `GET /api/v1/inventory/ownership-conversions`.
* The document’s remaining capacity (`quantity − used_quantity`) bounds retail entry: 3 units may enter a
  Kolbe retail warehouse; the next 2-unit transfer is refused with a Persian business error about the
  remaining acquisition capacity. Draft/incomplete conversions never permit retail entry.
* Ownership conversion is never a side effect of receiving, transferring, unpacking, editing or
  publishing; a unit-level purchase also does **not** silently enable retail sale on a supplier product
  (DB constraint + explicit product-level conversion). This boundary is recorded as DEC-WMS-006 (§29).

## 12. Balance keys, ledger, adjustments, warehouses (§20–§23)

* Balance key = variant + warehouse + domain (`stock_balances` PK), ownership where required
  (Series balances / product ownership). Audited and kept as-is; no redesign.
* Every mutation writes a movement or ledger row inside the same transaction (adjustments, damaged,
  receipts + confirmation, transfers, Series movements, retail supply, ownership conversion).
* **No free-form stock edit exists**: `PUT /api/v1/inventory` and `PATCH /api/v1/inventory/balance`
  return 404 (`P3-WMS-015`); the adjustment endpoint takes a non-zero `delta` + mandatory `reason` +
  `reference` + actor, writes a movement and returns before/after + available.
* Negative guard: an adjustment that would push `on_hand` below `reserved + damaged` is refused (409) and
  the balance is unchanged (`P3-WMS-016`).
* Warehouses are audited with name/status/purpose/holdings; `purpose` (`retail|wholesale|mixed`) is
  server-guarded (`assertWarehousePurpose`) and cannot be flipped while incompatible stock exists;
  deactivation semantics stay non-destructive (no delete of history).

## 13. Transfers, discrepancy and retry hardening (§24–§27)

* Mode A (single-variant domain transfer) lifecycle: `draft` (source **reserved**) → `approved/
  in_transit` (source `on_hand` decreases, destination `incoming` rises, in-transit visible) →
  `completed`/`completed_with_discrepancy`; Mode B adds multi-line documents.
* `P3-WMS-012`: 20 → 10 transfer never credits the destination early (draft reserves 10, destination
  still 0; after approve destination shows 10 incoming / 10 on_hand at source; after complete
  10/10 split, ledger −10/+10).
* `P3-WMS-013`: sending all 20 allocatable units demands explicit `confirmFullStock` (400 otherwise);
  19+2 is rejected (400, must equal the sent quantity); 18+2 closes as `completed_with_discrepancy`
  with `quantity=20, received_qty=18, damaged_qty=2` preserved, destination `on_hand=18, damaged=2`,
  readable history («۱۸ سالم، ۲ آسیب…») — never forced to `received == sent`.
* **Defect found and fixed (§25–§27, §48):** Mode B completion only treated `completed` as terminal, so
  a retry of a **discrepancy** transfer could run the per-line receive loop again and credit the
  destination twice. Both terminal statuses now replay the recorded receipt as a no-op
  (`duplicate: true`), and a retry that contradicts the record is a deterministic 409. Mode A shows the
  same idempotent behaviour instead of the previous bare 409.
* Receipt confirmation (`/inventory/receipts/:id/receive`) is idempotent the same way: same quantity →
  no-op replay with the recorded shortage; different quantity → 409.
* `P3-WMS-014` covers both double-receive paths and asserts that only one completion movement exists.

## 14. Reservations (§28)

Reservations stay the canonical order-line model (`stock_reservations`, now domain-aware) — no new table
and no OMS redesign (Prompt 4 owns OMS). The retail reservation in `P3-WMS-001` proves that a reservation
is domain-scoped, reduces only its own domain’s allocatable amount, and can never be exceeded
(`on_hand − reserved − damaged ≥ quantity` guard in the UPDATE). Reservation release stays idempotent in
the existing order/return flows.

## 15. Five quantities, never one ambiguous «موجودی» (§29)

Every read surface exposes physical / reserved / in-transit / damaged / allocatable separately:
`GET /api/v1/inventory` rows (on_hand, reserved, incoming, damaged, available + computed stock_status),
`GET /api/v1/inventory/summary` (KPI totals) and `GET /api/v1/inventory/variants/:id` (per domain).
The WMS KPI strip renders exactly «موجودی فیزیکی / رزرو شده / در راه / آسیب دیده / قابل تخصیص».

## 16. Publication ⟂ stock (§30)

`P3-WMS-017`: receiving stock into a **draft** product leaves it draft (`publicationStatus=draft` finds
the row, `published` does not); a published product keeps its publication through decreases down to zero
(`status` stays `published`), and the list exposes `product_status` (publication) separately from
`sale_status` — availability is never labelled «وضعیت فروش: فعال» as a publication state. Receiving never
publishes; stock changes never archive or unpublish.

## 17. WMS list contract, filters and detail surfaces (§31–§35)

* Server-side `sort` with deterministic default **newest** (newest product, then recently touched
  balance, then stable tiebreakers) plus oldest / stock high–low / allocatable high–low / name A→Z and
  Z→A; server-side filters for name/SKU search, canonical category, warehouse, domain, availability,
  publication state and ownership (plus incoming/reservation flags), combinable, with `limit/offset` and
  `withTotal`.
* `P3-WMS-018`: a six-filter combination returns exactly the matching row; an impossible combination
  returns empty (never the whole table); clearing the filters restores newest-first ordering
  (product_created_at descending) and `sort=oldest` flips it.
* WMS product detail lives in the hub row/detail surfaces (identity, SKU, sales mode, publication,
  ownership label, retail/wholesale inventory, Series, warehouse breakdown, reservations, damaged,
  in-transit, recent movements, contextual actions); Product 360 stays read-oriented with deep-links
  into WMS operations (no Studio duplication, no raw overwrite).
* Supplier 360 keeps the three separate concepts (§8). Persian-only vocabulary everywhere: no
  `inventory_domain`/`owner_type`/`stock_balance`/`movement_type`/UUIDs/raw enums in user-facing copy.

## 18. Initial inventory and receipts (§39–§41)

Opening stock flows through the canonical receipts (`inventory-setup` → `stock_receipts` → `receive`) for
both domains, creating real physical WMS stock; Series opening stock goes to
`series_stock_balances` with an explicit owner. Capacity never participates: it belongs to supplier
flows. Wholesale receipts carry the domain authoritatively (never hard-coded retail), shortages are
recorded as `missing_quantity` + a first-class discrepancy event, and a supplier-owned product’s
ownership is never changed by the receipt.

## 19. History and read models (§42–§44)

* Ownership change history: `GET /api/v1/inventory/ownership-conversions` (list/detail) + audit entries;
  the conversion is a document with reference number, quantity, capacity usage and status.
* Inventory history: `GET /api/v1/inventory/movements` (variant/product/domain filters, reason text with
  Persian wording, reference type/id, actor, warehouse) and `GET /api/v1/inventory/series/movements`;
  the WMS UI renders these with Persian labels («رسید»، «انتقال»، «اصلاح»، «باز کردن سری»…) and never raw
  DB vocabulary.
* Read models avoid N+1: the list uses one aggregated SQL with `count(*) OVER()`, summaries are computed
  server-side over all balances of the domain, movements are paginated/limited, and history is requested
  lazily by panel.

## 20. Transactions, concurrency, non-negativity (§45–§47)

Every balance change and its movement live in one `transaction(pool, …)` block; the guards are inside
the `UPDATE … WHERE` clauses, so concurrent requests cannot both win (reservations vs conversion,
transfer vs conversion, duplicate receipts). Normal stock can never go negative (SQL guards + explicit
409s). Series writes take the balance row `FOR UPDATE` and bump `version`.

## 21. Idempotency, audit infrastructure, RBAC (§48–§50)

* Idempotency reuses the existing `claimIdempotency`/`completeIdempotency` convention for adjustments,
  receipts, transfers, ownership conversions and retail supplies, plus the legacy unique-key fallback;
  same key + same payload → same result, same key + different payload → deterministic 409.
* No new audit/event system was built: the existing `audit` + `outbox` helpers are used, and the new
  no-op replays write **no** duplicate movements.
* RBAC unchanged: mutations require the existing `inventory:adjust` / `inventory:transfer` /
  `inventory:ownership` permissions (`inventory:read` for reads); supplier principals are warehouse-scoped
  to their own wholesale rows and never gain WMS admin access. `P3-WMS-019` proves a buyer cannot read WMS
  inventory (403) and another supplier sees zero rows of a product it does not own.

## 22. UI, IA, dashboards, RTL (§51–§58)

* The hub keeps the task-oriented IA with its existing tabs (خردهفروشی / نقلوانتقالات / انبار عمده /
  تنظیمات انبار) covering ورود کالا، انتقال بین انبارها، اصلاح موجودی، آسیب دیده، تاریخچه and the
  operational dashboard KPI strip; no duplicate catalog-management screen exists.
* The wholesale→retail conversion is surfaced as the approved «تأمین از عمده» flow and, as of this
  prompt, explicitly names **«تبدیل عمده به خرده»** in the retail entry so the WMS task list maps to a
  visible operation. It runs through the canonical document (create → dispatch → receive) with the
  Series panel showing the underlying ledger.
* Long workflows use the WorkspaceModal / full-page surfaces (no side drawers); the WMS tables scroll
  horizontally *inside* their container while the page itself never overflows (static lint below).
* Static responsive lint (`qa-responsive-static.mjs`) passes 1/1 over 11 Prompt-1 surfaces and 27
  wide/fixed-width elements at ≥ 320 px; the WMS surfaces are RTL, Persian-only and label-based.

## 23. Schema policy and legacy data (§61–§62)

**No migration was needed.** The audit found every required invariant already present:

* `stock_balances` PK `(variant_id, warehouse_id, inventory_domain)` + `CHECK (reserved + damaged <= on_hand)`;
* `stock_movements` domain column; `stock_reservations.inventory_domain`;
* `series_stock_balances.owner_type/supplier_id`, `series_stock_movements`;
* `ownership_conversions.(quantity, used_quantity, status)`;
* `stock_transfers` lifecycle + `068_transfer_discrepancy.sql` (`received_qty`/`damaged_qty`);
* `supplier_capacity_reservations` separated from stock;
* `retail_supply_orders/_events` with `recipe_snapshot`.

Legacy balances were **not** reinterpreted: the migration-055 reclassification heuristic is untouched,
no ownership was silently assigned, and the embedded battery re-verifies that all 51 migrations apply and
that a second run is a no-op.

## 24. Acceptance matrix — P3-WMS-001..020 → implementation → proof (§63–§82)

| Scenario | What is proven | Test in `backend/src/prompt3-wms.test.ts` |
| --- | --- | --- |
| P3-WMS-001 | retail 10 with reservation 3 → 7 allocatable, wholesale 5 untouched | `P3-WMS-001/004` |
| P3-WMS-002 | declared capacity 20 ≠ physical/allocatable stock (0 rows everywhere) | `P3-WMS-002` |
| P3-WMS-003 | supplier-owned at Kolbe, no auto-conversion, retail blocked | `P3-WMS-003/010` |
| P3-WMS-004 | Kolbe-owned wholesale operations never touch retail | `P3-WMS-001/004` |
| P3-WMS-005 | Series S2/M2/L2 × 3 → exactly 18 retail units; wholesale 5→2 | `P3-WMS-005` |
| P3-WMS-006 | same key + same payload → replay no-op, same document | `P3-WMS-006/007` |
| P3-WMS-007 | same key + different payload → deterministic 409 | `P3-WMS-006/007` |
| P3-WMS-008 | inconsistent pieces → whole conversion rolls back (no movements) | `P3-WMS-008` |
| P3-WMS-009 | dispatch uses the immutable recipe snapshot | `P3-WMS-009` |
| P3-WMS-010 | retail entry without a completed conversion is refused | `P3-WMS-003/010` |
| P3-WMS-011 | ownership conversion keeps quantities, is auditable, bounds retail entry | `P3-WMS-011` |
| P3-WMS-012 | transfer 20→10 with real in-transit state (never instant A−10/B+10) | `P3-WMS-012` |
| P3-WMS-013 | 20 sent / 18 usable / 2 damaged closes with preserved discrepancy | `P3-WMS-013/014` |
| P3-WMS-014 | double receive is a no-op (transfer **and** receipt confirmation) | `P3-WMS-013/014` |
| P3-WMS-015 | adjustment = delta + reason + movement; no raw overwrite endpoint (404) | `P3-WMS-015/016` |
| P3-WMS-016 | negative guard: adjustment below reserved+damaged refused, balance intact | `P3-WMS-015/016` |
| P3-WMS-017 | publication independent from stock (draft stays draft; published stays published) | `P3-WMS-017` |
| P3-WMS-018 | combined server filters narrow; clearing restores newest-first default | `P3-WMS-018` |
| P3-WMS-019 | supplier privacy: buyers see no supplier identity, no cross-supplier visibility | `P3-WMS-019` |
| P3-WMS-020 | capacity can never become dispatchable stock — no supplier→VIP direct path | `P3-WMS-020` |

Related suites kept green (never weakened): `inventory.test.ts`, `wms-workflows.test.ts`,
`series-inventory.test.ts` (PO acceptance: 18 units, replay 200/201, rollback, snapshot),
`wholesale_inventory_promotions.test.ts`, `supplier360.test.ts`, `suppliers.test.ts`,
`wholesale-oms.test.ts`, `product-wms-foundation.test.ts`, `product-draft-lifecycle.test.ts`,
`product-publication.test.ts`, `pricing-wms-structure.test.ts`.

## 25. Prompt-1 and Prompt-2 regressions (§83–§84)

The whole embedded battery (which contains the Prompt-1 lifecycle/publication suites and the Prompt-2
pricing matrix) is green **after** the Prompt-3 changes — see §28. No Prompt-1 or Prompt-2 expectation
was modified, weakened or re-interpreted; the only Prompt-2-adjacent file touched is the WMS UI wording
line in §22 (pricing code, resolver, contracts and pricing tests are untouched).

## 26. Browser UAT (§85–§89)

**PENDING — LOCAL BROWSER UAT REQUIRED.** One bounded browser availability check was already performed in
this environment during the Prompt-2 close-out: the Puppeteer cache directories exist but contain **no
browser binary** and no Chromium is on `PATH`; nothing in Prompt 3 changed that. Therefore the §85–§88
scenarios (Studio wholesale product + Series + initial wholesale stock staying draft; separate WMS
balances; ownership; 3 Series → exact retail units; refresh persistence; history showing the conversion;
transfer lifecycle with discrepancy; 360→1440 responsive walkthrough; no console/network 404/500 or
duplicate mutations; translated 409s) were **not executed** and are **not** claimed as passed. Static
gates are explicitly not a browser PASS.

## 27. Dead-code / duplicate-authority audit (§90)

* Direct writers of `stock_balances` outside the canonical WMS are limited to legitimate physical-event
  flows: `orders.ts` (order reservations/consumption), `manual-sales.ts` (POS sale), `wholesale-oms.ts`
  (wholesale child-order consumption of *its own* reservations), `supplier-requests.ts` /
  `supplier-consignment.ts` / `supplier-report.ts` (supplier inbound/consignment), `imports.ts` (data
  import), `product-lifecycle.ts` (canonical opening receipts) and `series-inventory.ts` (Series ledger +
  retail-supply document).
* **No free-form overwrite authority exists**: the only non-delta write is `applySeriesMovement`'
  computed write (delta + guards + movement, `FOR UPDATE`, `version` bump). `PUT`/`PATCH` balance
  endpoints do not exist (verified 404).
* No parallel/duplicate WMS module was found and none was added; no dead WMS code was found that could be
  removed safely without touching Prompt 4–6 ownership.
* Duplicate Series/piece ledgers are intentionally different tables (units vs pieces), not duplicates —
  documented in §5 and §9.

## 28. Security (§91)

* RBAC unchanged and enforced per route; supplier principals are scoped to their own warehouse/wholesale
  rows and cannot read other suppliers’ balances or WMS admin surfaces.
* Supplier privacy verified (`P3-WMS-019`): buyers/complainers see no supplier id/name through the
  availability surface; inventory responses never carry contact/banking/notes fields.
* No supplier→VIP direct-shipping path was introduced; capacity cannot be shipped from (§8, §24
  P3-WMS-020).
* No raw identifiers/UUIDs are exposed in WMS user-facing surfaces; idempotency keys are never echoed to
  the UI.

## 29. Performance (§92)

Server-side aggregation and ordering (one query with window count for the list, server-computed
summaries, explicit limits), no N+1 in the WMS read paths, history loaded lazily per panel. The P3 suite
adds no production queries; the two idempotency fixes replace a would-be second write with a read of the
recorded outcome.

## 30. Gate battery on the frozen tree (§93) — no stale counts

| Gate | Result |
| --- | --- |
| `npm run test:embedded` (migration verifier + all suites incl. P3) | **228/228 pass, 0 fail** (21 suites, 51 migrations applied, second run was a no-op) |
| `npm run test:contract` (frontend contract smoke) | **135/135** |
| `npm run test:pricing-routing` | **25/25** |
| `npm run test:dynamic-table` | **14/14** |
| `node scripts/qa-responsive-static.mjs` | **1/1 PASS** |
| `npx tsc -p backend/tsconfig.json --noEmit` | **0** |
| `tsc -p tsconfig.json --noEmit` (frontend) | **0** |
| `vite build` (production) | **0** — 2,377.34 kB / gzip 587.58 kB; `dist/index.html` restored, not committed |
| Browser | **not available — LOCAL BROWSER UAT REQUIRED** |

The new suite is registered in `backend/package.json` so it runs in the embedded battery on every future
gate run (the count rose from 213 to 228 accordingly).

## 31. Open items, decisions and commit table

**Open product decisions recorded (not guessed):**

1. **DEC-WMS-006** — partial (variant-level) ownership purchase leaves the product definition
   wholesale-only, so the acquired retail units exist but cannot be sold until a product-level conversion;
   `enableRetail` at variant level would require relaxing `products_supplier_channel_check`. Current
   behaviour documented as Option A with a recommendation.
2. **DEC-WMS-007** — `completed_with_discrepancy` transfers are not reversible through the reverse
   endpoint (only `completed` is); status quo documented (Option A) with a recommendation to settle it in
   Prompt 6.

**Deliberately untouched:** reverse of discrepancy transfers (see above); supplier-side workflow
(Prompt 5); OMS/order lifecycle (Prompt 4); inbound/QC/consolidation/outbound (Prompt 6);
finance/settlement and cashback (§59–§60).

**Commit table (baseline `56db7e3` → HEAD; code+tests +821/−5 in 4 files, plus this report and the
decision entries):**

| Commit | Subject |
| --- | --- |
| `9fae5a4` | fix(wms): idempotent destination receipt — `completed_with_discrepancy` is terminal and receipt confirmation replays |
| `f08db66` | feat(wms-fe): name the wholesale→retail conversion in the approved vocabulary |
| `a505c56` | test(wms): P3-WMS-001..020 acceptance matrix on the embedded harness (+ registration in `npm test`) |
| _(this report + DEC-WMS-006/007)_ | docs(wms): Prompt-3 report and open decisions |

**Verdict**

`PROMPT 3 IMPLEMENTATION COMPLETE — LOCAL BROWSER UAT REQUIRED`
