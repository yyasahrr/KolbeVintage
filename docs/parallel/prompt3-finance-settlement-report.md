# Master Prompt 3 — Financial Core: Supplier Settlement Engine — Final Report

Branch: `arena/01a0f798-kolbevintage` · Date: 2026-10-03

## 1. BASELINE & DELIVERED COMMITS

- Starting SHA: `19bb775` (Prompt 2 complete; remote == local at start).
- Delivered commits:
  - `3edd10a` — F1: migration `065_supplier_settlement_core.sql`, verifier/test-list registration, `PAYB`/`RCV` document sequences.
  - `66eadd7` — F2/F3: `settlement-core.ts` (accrual/holds/refunds/diagnostic/scheduler) + `settlement-routes.ts` (supplier + admin APIs), wiring into `app.ts`, `wholesale-oms.ts` (delivery → accrual), `worker.ts` (hold-release sweep), `finance.ts` (approve/pay hardening), `wallet.ts` (legacy withdrawal flag).
  - `a77ab64` — F4: `settlement.test.ts` registered and green — full suite 170/170.
  - `f1d160e` — F5: settlement-first UI — supplier wallet rebuilt around scheduled settlements (NO withdraw), admin `SettlementCenter` inside the canonical finance ops hub, `supplierFinanceApi`/`settlementAdminApi` client wrappers.
  - `e01a55e` — F6: this report + `prompt3-financial-security-audit.md`.
- Push status: ALL Prompt-3 commits pushed to `origin/arena/01a0f798-kolbevintage` (remote HEAD `e01a55e`). Note: F5/F6 were first committed as `4006a4b`+1 during a sandbox session whose git objects were lost to an environment reset; the identical working-tree content was re-committed as `f1d160e`/`e01a55e` — no work was redone or lost.

## 2. AUDIT — REUSE/EXTEND, NO PARALLEL FINANCE ENGINE

| Capability | Existing canonical system | Action |
|---|---|---|
| Supplier ledger | `supplier_ledger_entries` (027) | REUSED as the single source of truth (§18). Payable accrual, refunds, settlement payment, recovery write-off all post through the SAME `accrueSupplier`/ledger path. Wallet summary = projection only |
| Double-entry journal | `journal_entries`/GL (027) | REUSED — settlement PAID posts the same balanced journal as before; no second journal |
| Settlements | `settlements` + `settlement_lines` + `settlement_events` + `settlement_exceptions` (027) | EXTENDED with `kind='scheduled'` + policy/bank snapshots + `paid_amount/paid_reference` evidence columns. Legacy rows keep `kind='legacy'` untouched |
| Approvals / Maker-Checker | `finance_approvals` (027) + `/admin/finance/approvals/:id/:action` | REUSED — scheduled settlements go through the existing review→approve flow; approve re-verifies destination bank + cooldown + dual-control threshold |
| Manual payment | `/admin/finance/settlements/:id/pay` | EXTENDED for `kind='scheduled'`: requires approved status, verified frozen bank snapshot, `paidAmountRial === net`, globally unique bank `reference`. NO payout adapter call (§50, §171) |
| Withdrawals | `wallet.ts` withdrawal flow | DEPRECATED for the new model — `site_settings['supplier_finance_policy'].legacyWithdrawalsEnabled` gates creation; history stays read-only; supplier UI shows no withdraw button |
| RBAC / audit / outbox | `auth.ts` permissions, `audit`, `outbox_events` | REUSED — 2 new permission codes only (`bank:verify`, `finance:reconcile`); every transition audited; hold/settlement/bank transitions emit outbox finance events |
| Scheduler | existing `worker.ts` loop | EXTENDED with idempotent `releaseDueHolds` sweep — no new daemon |
| Supplier earnings on delivery | Prompt-2 outbox hook `child_order.fulfillment_delivered` | CONSUMED — delivery accrues a CHILD-level payable; Master never posts supplier earnings; Kolbe children accrue nothing |

## 3. MIGRATION — `065_supplier_settlement_core.sql` (additive; 063/064 untouched)

- `settlement_policies` — weekly / monthly / month_days (e.g. 15 & 30) / manual, `minimum_settlement_rial`, per-policy `hold_hours` (NULL = global default), `requires_verified_bank`, `requires_manual_review`, versioned; **`automatic_bank_payout boolean DEFAULT false CHECK (automatic_bank_payout = false)`** — auto payout impossible at DB level. `supplier_profiles.settlement_policy_id` = supplier override.
- `supplier_bank_accounts` — `pending_verification → verified / rejected / disabled / archived`; one primary per supplier (partial unique index); `settlement_enabled_at` = post-verification cooldown; any new/changed account restarts at `pending_verification`.
- `shipping_financial_policies` — versioned legs `supplier_inbound_order` / `supplier_inbound_stock` / `master_final`, payer `customer|supplier|kolbe|shared|promotion`, method `fixed|per_series|actual_cost`; change = new version row; snapshot frozen on the payable — never retroactive.
- `supplier_child_payables` (`PAYB-` seq) — ONE row per supplier CHILD with immutable component snapshot: gross / commission (+percent) / shipping share / refunds / adjustments / net, `quantity_snapshot` (§91 trace), `shipping_policy_snapshot`; status `held → eligible → scheduled → settled` (+`blocked`, `cancelled`); a payable joins at most one active settlement (partial unique `settlement_lines(payable_id)`).
- `settlement_holds` — first-class hold per payable: `active/blocked/released/cancelled`, `release_at`, `manual_block`, `blocked_reason`, policy snapshot.
- `supplier_recoveries` (`RCV-` seq) — post-PAID refunds become offsets against future settlements: `open → offset / written_off`; history immutable.
- `provider_reconciliations` — `api|statement|manual` source, `matched|exception`; unreconciled succeeded intents counted as honest "unknown".
- `settlements` extensions — `kind`, `scheduled_for`, policy id/version/snapshot, `bank_account_id` + frozen `bank_snapshot`, `recovery_offset_rial`, `paid_amount_rial/paid_by/source_bank/paid_note`; **unique partial index on `paid_reference`** (one bank reference closes at most one settlement).
- Exception taxonomy extended (`post_delivery_refund`, `bank_reconciliation_mismatch`, …); `financial_adjustments` categories extended for FUTURE storage/handling/QC fees (data kept, no new fee engine).
- Seeds: default policy (15 & 30), three default shipping policies (leg A payer=customer, leg B payer=supplier, leg C payer=customer), `site_settings['supplier_finance_policy']` (holdHours 72, cooldown, dual-control threshold, `legacyWithdrawalsEnabled`).
- `node scripts/verify-migrations.mjs` → **ALL CHECKS PASSED** (fresh 001…065 + second-run no-op).

## 4. BUSINESS RULES (server-authoritative)

- **Accrual (§20-§25)**: child delivered → `accrueChildPayable` computes from FINAL accepted qty (requested/confirmed/dispatched/received/qc_passed/accepted/delivered retained in `quantity_snapshot`); commission & shipping policy snapshotted at accrual, immutable afterwards; Kolbe child → no payable; rejected child → zero; hybrid → earnings only on the ONE supplier child, never doubled.
- **Ledger truth (§18)**: every money movement is a ledger entry; summary buckets and the reconciliation diagnostic are projections over payables/holds/settlements/recoveries and must agree with the ledger.
- **Holds (§26-§32)**: policy resolution child-override → supplier policy → global `supplier_finance_policy.holdHours` (configurable, not hardcoded); release job = idempotent `releaseDueHolds` on the existing worker (manual trigger `/settlement-holds/run-release` runs the same function); blockers (open return/refund/dispute/exception/manual block) → `blocked`, excluded from eligible; release → **eligible-for-settlement**, never withdrawable.
- **Scheduling (§33-§41)**: `runScheduledSettlements` groups ALL eligible payables of a supplier into ONE settlement with component totals + per-child lines; requires verified bank (frozen snapshot at creation), minimum amount, and a clean reconciliation diagnostic (`FINANCIAL_RECONCILIATION_REQUIRED` otherwise); open recoveries are offset into `recovery_offset_rial` at generation.
- **Approve → manual pay (§46-§57)**: approve re-verifies bank status + cooldown (`BANK_ACCOUNT_COOLDOWN`) and enforces dual control above the configured threshold; approve performs **no payout call**; `pay` demands prior approval, exact amount match (`SETTLEMENT_AMOUNT_CHANGED`), globally unique bank tracking reference, no open blocking exception; PAID is immutable (`SETTLEMENT_ALREADY_PAID` on any further mutation).
- **Refund reconciliation at every stage (§89-§95)**: before release → hold + payable reduced; eligible → reduced; scheduled → blocking exception + recompute path (cancel reopens payables); after PAID → `supplier_recoveries` offsets future settlements; written-off recoveries post a forgiving ledger credit. History never rewritten.
- **Shipping money flow (§75-§82)**: leg defaults A=customer, B=supplier, C=customer; SHARED requires share>0 (`INVALID_SHIPPING_POLICY`); every payable carries its policy snapshot — version changes affect only NEW payables (tested).
- **Provider reconciliation (§69-§73)**: SnappPay/DigiPay bank-settlement status is never fabricated — a succeeded intent with no reconciliation row is reported as honest "unknown"; recording requires explicit source (api/statement/manual) and statement id for statement mode.
- **Error codes (§198)**: `SETTLEMENT_HOLD_ACTIVE`, `BANK_ACCOUNT_UNVERIFIED`, `BANK_ACCOUNT_COOLDOWN`, `SETTLEMENT_ALREADY_PAID`, `SETTLEMENT_AMOUNT_CHANGED`, `FINANCIAL_RECONCILIATION_REQUIRED`, `SUPPLIER_RESTRICTED`, `PAYABLE_ALREADY_ASSIGNED`, `INVALID_SHIPPING_POLICY` — all with Persian messages.

## 5. FRONTEND (F5)

- `src/data/api.ts` — `supplierFinanceApi` (9 wrappers) + `settlementAdminApi` (27 wrappers); paths and payloads verified line-by-line against `settlement-routes.ts` / `finance.ts`.
- `src/portals/supplier-wallet.tsx` — rebuilt around settlements: six buckets (در انتظار تکمیل سفارش / Settlement Hold / آماده تسویه / تسویه بعدی + تاریخ و سیاست / تسویه‌شده / مسدود + Recovery باز), tabs خلاصه / فروش‌ها (component-wise payables — هرگز «+24M» خالی) / تراکنش‌ها (ledger projection) / Holds / تسویه‌ها (detail with components + lines + masked bank + paid reference) / حساب بانکی. **NO withdraw button**; banner explains scheduled settlements replace withdrawal requests. Supplier sees own full IBAN; everywhere else masked.
- `src/components/settlement-center.tsx` — admin «تسویه تأمین‌کنندگان» tab inside the EXISTING finance ops hub (no new top-level entry, no drawer): upcoming + generate, settlement list + `WorkspaceModal` detail driven by server-derived `allowedActions` (review / approve-without-payout / manual-pay form per §114: tracking reference + exact amount + source bank / block / cancel / fail), hold operations + sweep trigger, policy CRUD + assign (auto-payout shown as DB-locked), bank verify/reject/disable, recoveries + write-off, shipping policy versions, provider reconciliation recording, read-only ledger diagnostic.
- `src/components/finance-ops.tsx` — single added tab wired into the existing TABS/switch; legacy settlement/withdrawal tabs retained read-only (Prompt 4 relocates IA).

## 6. SCENARIO EVIDENCE (§207-§210, embedded tests)

- **§207 end-to-end** (`settlement.test.ts` test 1): supplier child, 5 requested → 3 accepted × 180M = gross 540M − commission 10% (snapshot) 54M − shipping leg A (customer) 0 → net 486M → hold (active, policy hours) → release → eligible → policy 15/30 → generate → ONE pending settlement → review/approve (**zero `%payout%` outbox events asserted — §171**) → manual pay with bank reference → PAID immutable → post-PAID refund 40M → `RCV-` recovery; diagnostic OK end-to-end.
- **§208-§209** (test 2): Kolbe child → NO payable; 3 payables (8/12/7M-scale) → ONE settlement, 3 lines, ONE bank snapshot, ONE tracking reference; duplicate bank reference → 409; refund before release and while scheduled (blocking exception) both reconcile; recovery 4M offsets next settlement 10M → 6M; cancel reopens payables + recovery.
- **§210 + security** (test 3): leg defaults A/B/C; `INVALID_SHIPPING_POLICY`; policy v2 non-retroactive (old payable keeps v1 snapshot); unverified bank blocks generation; `bank:verify` RBAC (operations role → 403); bank takeover (change IBAN → verification lost, approve blocked); rogue ledger entry → diagnostic MISMATCH → `FINANCIAL_RECONCILIATION_REQUIRED` blocks generation; §168 payment replay regression still green.

## 7. VALIDATION EVIDENCE (exact commands & counts)

| Command | Result |
|---|---|
| `cd backend && npm run build` | clean (tsc) |
| `cd backend && node scripts/run-embedded-tests.mjs` | **170 pass / 0 fail** (includes 3 new settlement suites + all Prompt-1/2 regressions) |
| `cd backend && npm run test:contract` | **102/102 checks passed** |
| `cd backend && node scripts/verify-migrations.mjs` | ALL CHECKS PASSED (fresh + upgrade no-op) |
| root `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | clean |
| root `node node_modules/vite/bin/vite.js build` | built (dist/index.html 2,231 kB; tracked dist restored, never staged) |

## 8. DoD CHECKLIST (§204)

- [x] Child-level supplier finance; Master posts nothing; Kolbe child accrues nothing.
- [x] Ledger = truth; projections reconcile; read-only diagnostic blocks generation on mismatch.
- [x] First-class holds, configurable policy chain, idempotent release on existing worker; release → eligible, not withdrawable.
- [x] Scheduled settlements replace withdrawals (no withdraw button/API path in the new model; early settlement NOT built — future).
- [x] Review → approve (no payout) → manual transfer to frozen verified IBAN → unique reference → immutable PAID.
- [x] `automatic_bank_payout` hard-false at DB level; §171 payout-adapter-never-called asserted in tests.
- [x] Refunds reconcilable at all four stages incl. post-PAID recovery offsets.
- [x] Versioned shipping financial policy, snapshot per child, non-retroactive.
- [x] Honest provider reconciliation (unknown ≠ settled).
- [x] Error codes + Persian messages; IBAN masked except supplier-self/authorized finance; never logged raw.
- [x] Additive migration, verifier green; all prior suites green (no regression).

## 9. DOCUMENTED LEGACY / LIMITATIONS (honest)

- **Browser QA: NOT RUN** — no Chromium in the sandbox; UI verified via tsc, vite build, and the contract smoke driving the real client code.
- Legacy withdrawal/advance history remains read-only under the old finance tabs; `legacyWithdrawalsEnabled` currently `true` for backward compatibility during cutover — flipping it off blocks new withdrawal creation (admin-controlled, documented in security audit).
- Early settlement (zoodtar) intentionally NOT implemented (future, disabled by scope).
- Finance Center visual IA redesign deferred to Prompt 4 (the new tab lives inside the existing hub by design).
- `settlement-policies/:id/revise` endpoint exists and is tested server-side; the admin UI exposes create/assign — revise ships with the Prompt-4 IA pass.
