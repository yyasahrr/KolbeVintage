# Master Prompt 2 — VIP Wholesale Master/Child OMS — Final Report

Branch: `arena/01a0f798-kolbevintage` · Date: 2026-10-03

## 1. BASELINE & DELIVERED COMMITS (all pushed)

- Starting SHA: `4821e89` (Prompt 1 complete; remote == local at start).
- Delivered commits:
  - `f9c309e` — W1 backend core: migration 064, `wholesale-oms.ts` (master create → children → lines → source allocations, supplier respond, buyer decision, eligibility recompute, TTL sweep), app wiring.
  - `f9aa635` — W2 payments: `payment_allocations` branch inside the EXISTING `applyVerifiedPayment` (atomic batch verification, per-child invoices, late-callback exception path), purpose-aware gateway guard.
  - `fc63cce` — W3 fulfillment: pick / dispatch / receive / QC / exceptions, consolidation start/verify/complete/pack, master-level ship + deliver, finance outbox hooks.
  - `2ec6e77` — W4 tests: 5 embedded suites (`wholesale-oms.test.ts`), 167/167 green.
  - `c5d2890` — W5 frontend + contract smoke: VIP checkout → `/wholesale/masters`, supplier child-orders panel, canonical master rows in orders hub, +8 smoke checks (102/102).

## 2. AUDIT — REUSE/EXTEND, NO PARALLEL OMS (§18, §154-§155)

| Capability | Existing canonical system | Action |
|---|---|---|
| Orders | `orders` + `order_lines` + `order_events` (001/055) | EXTENDED — children ARE rows in `orders`; thin `master_orders` shell on top. `master_order_id IS NULL` = legacy mode (documented below) |
| Payment verification | `payments.ts` `applyVerifiedPayment` | EXTENDED with an allocation branch (intent with neither `order_id` nor `membership_id` → child allocations). NO second payment pipeline |
| Invoices | `invoices.ts` `issueInvoiceForOrder` | REUSED per CHILD (child = financial truth §106); master = informational only |
| Series stock | `series-inventory.ts` `applySeriesMovement` + `order_series_reservations` | REUSED for kolbe/stock-at-kolbe reserve + pick consume; external NEVER touches it (§8) |
| Supplier capacity | `supplier-offers.ts` `reserveSupplierCapacity`/settle/expire (063) | REUSED — external confirm = atomic capacity reservation; settled `consumed` at dispatch; never in `stock_reservations` |
| Pricing | canonical wholesale price resolver (offer price / `wholesale_price_rial`) | REUSED (§64); line-level commercial snapshot frozen at READY (§66-§68) |
| RBAC/audit/outbox/idempotency | `auth.ts`, `operations.ts`, `idempotency_keys` | REUSED everywhere; `allowedActions` server-derived (§140) |
| Supplier earnings | `postSupplierEarnings` in `orders.ts` | UNTOUCHED, legacy-only. Master deliver emits `child_order.fulfillment_delivered` outbox per child and credits NOTHING (§128-§129; asserted by test) |
| Legacy wholesale flow | `POST /orders` orderType=wholesale | KEPT working (regression suites green). New VIP checkout uses masters; legacy rows have `master_order_id IS NULL` and keep their old lifecycle |

## 3. MIGRATION — `064_wholesale_master_oms.sql` (additive; 063 untouched)

- `master_orders` (+`MV-` seq): grouping/consolidation shell — composition `open/locked`, shipping estimate before lock + quote snapshot after (§110-§116), final shipment fields.
- `orders` + columns: `master_order_id`, `seller_type/seller_id`, `supply_status`, `payment_eligibility`, `payment_due_at`, `supplier_respond_by`, `child_fulfillment`, `composition_state`, `snapshot_locked_at` (all nullable → legacy-safe).
- `child_order_lines` (requested/proposed/confirmed immutable trio §35 + commercial snapshot + §91 trace counters: requested/confirmed/dispatched/received/qc_passed/accepted/delivered).
- `order_source_allocations` (A `kolbe_stock` / B `supplier_stock_at_kolbe` / C `supplier_external`; order-bound disposition; reservation TTL).
- `payment_intents.master_order_id` + purpose values; `payment_allocations` (SUM == amount enforced §60).
- `fulfillment_exceptions` (+ resolutions), `master_consolidations` + `consolidation_items` (+`CON-` seq).
- `site_settings['wholesale_oms_policy']` — all TTLs/response windows configurable, not hardcoded.
- NO 065 needed: 055 already provides `vip_dispatched_at/by`, `vip_tracking_code`, `vip_carrier`, `consolidated_at/by`, `packed_at`.
- `node scripts/verify-migrations.mjs` → **ALL CHECKS PASSED** (fresh 001…064 + second-run no-op).

## 4. BUSINESS RULES IMPLEMENTED (server-authoritative)

- **Sources §21-§25**: A/B reserve → READY instantly (B needs no reconfirmation); C requested → awaiting supplier → confirm = atomic capacity reservation → READY. Hybrid splits stock-at-kolbe first, external remainder — server-owned split. External never writes kolbe `stock_balances`/`series_stock_balances` (§8; tested).
- **Payment §53-§62, §139**: per-child eligibility; hard gate (no intent/manual-paid before READY — even admin); single active intent per child (`PAYMENT_INTENT_EXISTS`); batch intent = ONE gateway transaction over READY children of one master with `payment_allocations` SUM==amount; verification atomic (all paid or none); TTL sweep → `expired` + release + stale intents failed; late callback → `payment_late_callback` exception + `refund_requested` outbox, order NOT flipped paid, no oversell.
- **Supplier flow §35-§40, §70-§72**: confirm / counter (requested+proposed immutable; proposed ≥ physical portion, < requested) / reject per line; buyer accept revalidates & atomically resizes external reservation, totals recomputed server-side; counter below MOQ rejected; rejection never breaks siblings — child cancelled + `composition_state='removed'` → excluded from denominator (§43); respond_by timeout → `timed_out` (no auto-alternate V1 §70); supplier panel hides buyer identity (§72).
- **Fulfillment §77-§91**: kolbe/stock-at-kolbe = pick only (stock consumed at pick); external = dispatch (full allocation, destination server-resolved, strict schema rejects any client destination §137) → receive once → QC once (passed+rejected == received) → exceptions (`lost_inbound`, `qc_rejected`) with explicit resolutions — never silent shrink (§88-§90); QC-passed order-bound goods NEVER credit general stock-at-kolbe (§86-§87; tested); per-line §91 trace maintained.
- **Consolidation & shipment §93-§103**: starts only when every active paid child is `ready_for_consolidation`; scan verify rejects wrong (`WRONG_CONSOLIDATION_ITEM`) and duplicate (`DUPLICATE_CONSOLIDATION_SCAN`) items; double-start 409; complete → pack → ONE master-level shipment (ship/deliver write `vip_tracking_code`/`vip_carrier`); deliver emits per-child `fulfillment_delivered` hooks — zero supplier wallet credits (§129; tested).
- **RBAC/IDOR §132-§136**: VIP = own masters only; supplier = own children, no self-QC, no direct-to-VIP; warehouse ops = fulfillment only; all cross-tenant probes return 403/404 (tested).
- **Error codes §198**: machine codes + Persian messages: `PAYMENT_NOT_READY`, `SUPPLIER_CONFIRMATION_REQUIRED`, `SUPPLY_RESERVATION_EXPIRED`, `COUNTER_OFFER_PENDING`, `CHILD_ALREADY_PAID`, `PAYMENT_INTENT_EXISTS`, `BELOW_MIN_ORDER_SERIES`, `INSUFFICIENT_SERIES`, `MASTER_COMPOSITION_OPEN`, `CONSOLIDATION_NOT_READY`, `WRONG_CONSOLIDATION_ITEM`, `DUPLICATE_CONSOLIDATION_SCAN`, …

## 5. FRONTEND (W5)

- `src/data/api.ts` — `wholesaleOmsApi` (23 endpoints, typed rows).
- `src/portals/vip.tsx` — checkout posts `POST /wholesale/masters`; orders tab: «سفارش‌های مادر» card (one row per master, badge کلبه/تأمین‌کننده/ترکیبی, child/paid/ready counts, «پرداخت زیرسفارش‌های آماده» → single batch intent) + children listed as per-seller sub-orders. No credit fields anywhere.
- `src/components/supplier-child-orders-panel.tsx` — child orders with Persian status labels (3 separate domains); per requested line exactly **[تأیید کامل] [پیشنهاد کمتر] [عدم امکان]**; dispatch-to-kolbe only after payment; no buyer identity.
- `src/portals/orders-hub.tsx` — `MasterOrdersStrip`: ONE canonical master row above the wholesale tabs (§152), children remain in the existing tabs — no duplicate rows; existing 3-tab structure untouched.
- Backend addition for the hub: `GET /wholesale/masters?scope=all` (requires `orders:read`; non-admin → 403).

## 6. VALIDATION EVIDENCE (exact commands & counts)

| Check | Command | Result |
|---|---|---|
| Backend build | `cd backend && npm run build` | clean |
| Embedded tests (fresh PGlite, 001…064) | `node scripts/run-embedded-tests.mjs` | **167/167 pass** (162 Prompt-1/regression + 5 new OMS suites; 0 skipped/disabled) |
| Contract smoke | `npm run test:contract` | **102/102 pass** (94 previous + 8 Prompt-2 §190 checks) |
| Migration verifier | `node scripts/verify-migrations.mjs` | ALL CHECKS PASSED |
| Frontend types | `npx tsc -p tsconfig.json --noEmit` (repo root) | clean |
| Frontend build | `npx vite build` | built (dist/index.html regenerated then restored via `git checkout dist/index.html` — dist is not committed) |

New embedded suites (`backend/src/wholesale-oms.test.ts`):
1. **VIP-2048** (§165-§167): kolbe 2 + supplier-A stock-at-kolbe 3 + supplier-B external 4 → 1 master / 3 children; A+kolbe READY immediately with reservations, B blocked (`reserved_external` stays 0 until confirm → 4); payment gate 409; early lock 409; IDOR ×2; supplier privacy; batch intent SUM; duplicate intent 409; atomic batch pay → 2 paid + 2 invoices + 2 `payment_verified` hooks, B untouched; paid-child remove → `CHILD_ALREADY_PAID`.
2. **Hybrid 6+4 / counter / reject independence** (§25, §35-§40, §43, §118): MOQ reject; counter 10→8 keeps requested immutable; intent during counter → `COUNTER_OFFER_PENDING`; supplier cannot self-accept; accept resizes external 4→2 atomically + totals ×8; two-supplier master: reject cancels only its child, denominator excludes it, lock succeeds.
3. **TTL & late callback** (§47-§49, §61-§62): sweep → expired + series released + stale intent cannot pay + new intent → `SUPPLY_RESERVATION_EXPIRED`; late gateway callback → exception + `refund_requested`, order stays pending.
4. **QC shortage §177**: 5 confirmed / 5 dispatched / 4 received / 3+1 QC → `lost_inbound` + `qc_rejected` exceptions; §91 trace {5,5,5,4,3,1}; general stock & series stock UNTOUCHED; self-QC 403; client destination → 400; accept_short → accepted 3, ready_for_consolidation.
5. **Consolidation & master shipment** (§93-§103, §128-§129): start gates, wrong/duplicate scan 409s, double-start 409, pack→ship→deliver → children delivered + hooks; supplier `wallet_entries` count stays 0.

## 7. DOCUMENTED LEGACY / LIMITATIONS (honest)

- **Legacy mode**: `orders.master_order_id IS NULL` = pre-Prompt-2 wholesale order; untouched lifecycle, `postSupplierEarnings` still applies to it ONLY. New master-children rely on Prompt-3 settlement via outbox hooks.
- **V1 scope**: no auto-alternate sourcing after reject/timeout (§70); one final master shipment (no partial master shipments); refund execution is Prompt-3 (we open exceptions + emit `refund_requested`).
- Payment gateway redirect for batch intents is wired at intent level; the sandbox has no real gateway, so UI flashes the intent reference (verification path covered by tests calling `applyVerifiedPayment` exactly as the webhook does).
- Browser QA (visual click-through): **NOT RUN** — no browser available in the sandbox; UI validated by tsc, vite build, and source-level contract checks.
- Admin master DETAIL tabs (خلاصه/زیرسفارش‌ها/…) are served by `GET /wholesale/masters/:id` (returns everything incl. `allowedActions`); the admin hub currently shows the canonical strip + child tabs — a dedicated WorkspaceModal detail view can be layered on without API changes.

## 8. DoD (§219)

- All work committed & pushed to `arena/01a0f798-kolbevintage` (HEAD `c5d2890`).
- No test deleted/disabled; Prompt-1 and retail regressions green; migrations additive only; no parallel OMS/payment/invoice systems; money integer RIAL; server-authoritative throughout.
