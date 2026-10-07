# Master Prompt 3 — Financial Security Audit (Supplier Settlement Engine)

Branch: `arena/01a0f798-kolbevintage` · Date: 2026-10-03 · Scope: §150-§171 + §116-§117 + §138

## 1. THREAT MODEL SUMMARY

| Threat | Defense | Where enforced | Proof |
|---|---|---|---|
| Automatic money exfiltration via "approve" | Approve is a pure state transition; the ONLY money-out step is a human recording an already-executed manual bank transfer | `finance.ts` approvals route; `settlements/:id/pay` | §171 test: after approve, `SELECT COUNT(*) FROM outbox_events WHERE event_type ILIKE '%payout%'` == 0 (`settlement.test.ts` L321-324). No payout adapter is imported anywhere in the settlement path |
| Policy flipped to auto-payout | `automatic_bank_payout boolean DEFAULT false CHECK (automatic_bank_payout = false)` — DB-level hard lock; create/revise APIs never accept the field (mass-assignment impossible) | migration 065; `settlement-routes.ts` zod schemas | migration verifier + zod strict parse |
| Bank account takeover (IBAN swap) | New/changed account ⇒ `pending_verification` (verification never carried over); settlement freezes a bank SNAPSHOT at generation; approve re-verifies live status + cooldown (`BANK_ACCOUNT_COOLDOWN`); pay re-verifies snapshot account is still `verified` | `settlement-routes.ts` bank POST; `finance.ts` approve/pay | §170 test (test 3): swap → approve blocked `BANK_ACCOUNT_UNVERIFIED` |
| Duplicate / replayed bank reference | Partial unique index `settlements(paid_reference)` + explicit 409 pre-check: one tracking reference closes at most one settlement (§54) | migration 065; pay route | test 2: duplicate reference → 409 |
| Amount tampering at pay time | `paidAmountRial` must equal frozen `net_rial` exactly → `SETTLEMENT_AMOUNT_CHANGED` 409 | pay route | test 1 & 2 |
| Paying twice / mutating PAID | `SETTLEMENT_ALREADY_PAID` on pay/block/cancel of paid|reconciled rows; post-PAID corrections ONLY via `supplier_recoveries` (history immutable) | pay/block/cancel routes | tests 1-2 |
| Self-approval / single-person payout | Existing Maker/Checker reused: requester cannot review/approve own approval; above `dualControlThresholdRial` the settlement creator cannot be the approver | approvals route | test 1 (dual-control path) |
| Payable double-settlement | Partial unique `settlement_lines(payable_id)`; payable status machine (`eligible→scheduled` under `FOR UPDATE`); `PAYABLE_ALREADY_ASSIGNED` | migration 065; `runScheduledSettlements` | test 2: ONE settlement per supplier run |
| Ledger drift hiding theft | Read-only `reconciliationDiagnostic` (ledger vs payables vs holds vs eligible vs settlements vs recoveries); MISMATCH ⇒ `FINANCIAL_RECONCILIATION_REQUIRED` blocks new settlement generation | `settlement-core.ts` | test 3: rogue ledger row → generation blocked |
| Hold bypass to cash out early | Release → `eligible` only (never withdrawable); blockers (manual block/refund/exception) force `blocked`; release sweep idempotent and audited; manual early release runs the SAME blocker-checked sweep | `releaseDueHolds`; hold routes | tests 1-3 |

## 2. RBAC / IDOR (§169)

- Supplier endpoints derive `supplierId` from the authenticated principal only — no client-supplied supplier id anywhere under `/supplier/finance/*`; settlement detail is scoped `AND party_user_id = $supplier` (IDOR probe = 404).
- Admin surfaces: read = finance-read roles; mutations split: `settlements:manage` (holds/policies/generate/block/cancel/refund/shipping), `finance:approve` (approve + pay + recovery write-off), `bank:verify` (bank verify/reject/disable), `finance:reconcile` (diagnostic + provider reconciliation). Seeded to admin+finance only; test 3 proves operations role gets 403 on `bank:verify`.
- No giant endpoint: every action is a narrow route; `allowedActions` are server-derived from status + open blocking exceptions — the UI renders only what the server permits.

## 3. PII / IBAN HANDLING (§116-§117)

- Supplier self-view and `bank:verify` holders see full IBAN; every other surface gets `maskIban` (settlement list/detail for supplier shows `ibanMasked` from the frozen snapshot).
- Audit rows store `ibanMasked`, never the raw IBAN; no IBAN in log lines; bank snapshot lives in the settlement row (authorized-read only), not in events.

## 4. PAYMENT SECURITY REGRESSION (§168) + PROMPT-2 INVARIANTS

- Prompt-2 replay/allocation guards re-asserted in test 3: a second verification callback on an already-verified intent cannot double-credit; `payment_allocations` SUM==amount invariant untouched (Prompt-2 suites all green in the same run: 170/170).
- Customer payment ≠ supplier settlement: verification writes customer-side records only; supplier money appears exclusively via child-payable accrual on delivery.

## 5. HONESTY GUARANTEES (§70, §129)

- Provider settlement status is NEVER fabricated: a succeeded `payment_intent` without a `provider_reconciliations` row is surfaced as an explicit "unknown" count; recording requires declared source (`api|statement|manual`) and `statementBatch` for statement mode; exceptions emit outbox events.
- `pendingFulfillmentRial` is labeled an estimate (gross of undelivered paid children) — it is a projection, not a ledger claim.

## 6. AUDIT & EVENTS (§138)

- Every transition audited with actor + before/after: payable accrual/refund, hold block/unblock/extend/release, policy create/revise/assign, bank submit/verify/reject/disable/archive, settlement generate/review/approve/block/cancel/fail/pay, recovery create/offset/write-off.
- Outbox finance events for hold released/blocked, settlement created/approved/paid/cancelled/failed, bank submitted/verified/disabled, reconciliation exceptions — consumed by the existing outbox pipeline; no new eventing system.

## 7. RESIDUAL RISKS (honest)

- `legacyWithdrawalsEnabled` is still `true` (cutover compatibility): the legacy withdrawal route remains callable until finance flips the flag. Mitigation: flag is admin-gated config, history read-only, and the new supplier UI exposes no withdrawal path. Recommend flipping to `false` after the first real scheduled-settlement cycle.
- Manual-pay truthfulness depends on the human entering the real bank reference; mitigations are uniqueness, exact-amount match, dual control, and immutable audit — the system cannot verify the bank transfer itself without a bank API (out of scope by design, §50).
- Browser-level session/XSS testing NOT RUN (no browser in sandbox); server-side authz is enforced regardless of client.
