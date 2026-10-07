# Prompt 4 — Integration Gap Matrix (pre-coding audit)

Date: 2026-10-03 · Starting SHA: `09acfda3c8da1fa279f68ec0c2532f152718f34f` · Latest migration: 065
Baseline: embedded 170/170 · contract 102/102 · migrations PASS · tsc PASS · build PASS · browser NOT RUN.

Status legend: OK = matches target architecture · GAP = work planned this phase · DEFER = documented, left for later (honest).

| # | Feature | Expected (Prompt-4 target) | Current implementation | Gap | Risk | Planned fix | Domain | Test evidence |
|---|---|---|---|---|---|---|---|---|
| 1 | Product / ownership | Admin=Kolbe-only, supplier via submission, approval≠stock | Enforced server-side since Prompt 1 (`catalog.ts`, review flow) | OK | — | regression only | Product | `product-wms-foundation.test.ts` |
| 2 | WMS (piece/series, ownership, order-bound) | Canonical since Prompt 1 | `series-inventory.ts`, `inventory.ts`, ownership ledger | OK | — | regression only | WMS | `series-inventory.test.ts`, `wms-workflows.test.ts` |
| 3 | OMS master/child/allocations/payment gate | Canonical since Prompt 2 | `wholesale-oms.ts` + `payment_allocations` | OK | — | regression only | OMS | `wholesale-oms.test.ts` (5 suites) |
| 4 | Payments | One pipeline, purpose-aware, replay-safe | `payments.ts` `applyVerifiedPayment` | OK | — | regression only | Payments | §168 test in `settlement.test.ts` |
| 5 | Supplier finance core | Ledger=truth, payable→hold→eligible→scheduled→manual PAID | Canonical since Prompt 3 (`settlement-core/routes`) | OK | — | regression only | Finance | `settlement.test.ts` (3 suites) |
| 6 | **Finance Center IA** | 6 domains: داشبورد/حوزه‌های مالی/پرداخت و تسویه/اسناد و گزارش‌ها/حسابداری/تنظیمات مالی | ONE flat 11-tab strip (`finance-ops.tsx` TABS) + 3 sibling hub tabs (ops/ledger/wallet) | **GAP** | operator confusion; accounting concepts at first level | Regroup existing panels under 6 domains; no backend change | Finance UX | tsc/build + contract smoke |
| 7 | «تخصیص حمل» first-level tab | Under تنظیمات مالی → سیاست هزینه حمل | First-level finance tab `shipping` | **GAP** | low | move tab into finance-settings group (same component) | Finance UX | build |
| 8 | Finance Events tab | Removed from primary nav (audit/timeline cover it) | First-level tab `events` | **GAP** | low | fold under حسابداری/گزارش حسابرسی; events data untouched | Finance UX | build |
| 9 | Supplier advances | No create action; history read-only, honestly labeled | `AdvancesTab` has CREATE form + pay/apply actions | **GAP** | medium (reintroduces dead business flow) | remove create/pay UI, keep read-only history with legacy label; backend endpoints untouched | Finance | build + grep |
| 10 | Legacy withdrawal UI | No new-flow withdrawal anywhere; history read-only | Supplier portal clean (Prompt 3); `admin-ops.tsx` FinanceCenter still shows demo «قابل برداشت»/withdraw queue wording | **GAP** | medium | relabel legacy wallet view read-only/history; no `withdrawal:create` calls remain | Finance | grep + build |
| 11 | Supplier Statement V2 | Settlement-model concepts (hold/eligible/scheduled/paid/recovery), ledger-sourced | `supplier-report.ts` uses `balance/pending/withdrawn` wallet projection | **GAP** | high (statement contradicts new model) | extend statement payload+PDF with payable/hold/settlement sections from canonical tables; legacy withdrawal line kept for history | Documents | new embedded assertions |
| 12 | Provider reconciliation UX | Volume/reconciled/unreconciled/last/source; unknown honest | Implemented in Prompt 3 F5 (`settlement-center.tsx` recon section) | OK (polish only) | — | keep; relocate under پرداخت و تسویه | Finance | `settlement.test.ts` test 3 |
| 13 | **Try-On finance** | Packages/credits/purchase/consumption/revenue; costs honest-unknown | `tryon.ts` = free rate-limited jobs only; NO packages/credits/payment | **GAP (build)** | medium | migration 066 (packages/credits/ledger + payment link), endpoints, admin config, finance classification, tests | Try-On | new embedded suite |
| 14 | Other revenue report | Streams: plans/commission/try-on/fees(enabled-vs-supported) | Reports center has revenue groupings; no stream classification view | **GAP** | low | add «درآمدها و خدمات جانبی» view fed by real sources (plans, commission from settlements, try-on) ; inactive fees shown as supported-not-enabled | Finance | build |
| 15 | Product review decision UX | Two-step: تأیید و انتشار / عدم تأیید → (نیازمند اصلاح | رد نهایی); explicit verbs | `marketplace-review-panel.tsx` has 3-way decision + reason codes + filters already | small GAP | low | split primary/secondary choice, explicit action buttons, keep server contract | Product | build |
| 16 | Shared reasons | One canonical reasons source per context, snapshotted | `product_review_reasons` (016) canonical for review; other contexts use free-text reasons audited | PARTIAL → DEFER expansion | low | document; review reasons stay canonical; no second reasons system created | Platform | grep |
| 17 | CRM hub | 4 tabs, one hub; legacy blocks removed/redirected | 4 tabs exist; two legacy `<details>` blocks (CrmPanel «قدیمی», UsersDirectory) nested in customers tab | **GAP** | low | audit uniqueness → remove/relocate legacy blocks; no data deleted | CRM | build |
| 18 | Customer debt/credit | Must not exist | Not present (verified Prompt 2/3) | OK | — | guard in review | Finance | grep |
| 19 | WorkspaceModal adoption | Large workspaces use WorkspaceModal | Settlement/review/360s use it; some legacy drawers remain (invoice-docs, supplier-360 sections, product-inventory) | PARTIAL | low | convert worst offenders encountered; no WorkspaceModal2 | UX | build |
| 20 | Status localization | No raw English statuses in admin | Mostly localized; sweep needed for new finance strings | small GAP | low | targeted sweep | UX | grep |
| 21 | Accounting layer | Journal/GL/periods under حسابداری, not first-level | GL = sibling hub tab; periods = first-level ops tab | **GAP** | low | regroup under حسابداری domain | Accounting | build |
| 22 | Balance sheet / cash flow | Only if data supports; else PARTIAL honest | Not implemented; CoA/journal exist | DEFER | — | mark PARTIAL / DATA MODEL INCOMPLETE in report (no fake reports) | Accounting | — |
| 23 | Promotion/festival/exact-variant | One engine, festival authority | Canonical engine + exclusivity since 061; scope builder exists | OK | — | regression only | Promotion | `promo.test.ts`, `wholesale_inventory_promotions.test.ts` |
| 24 | Audit center | One audit system, filterable | `audit-log-panel.tsx` + canonical audit table | OK | — | keep | Audit | existing tests |
| 25 | PDF canonical | Server PDFs; no document.write/about:blank | server `pdf.ts`; grep confirms no client invoice hacks | OK | — | regression grep | Documents | `pdf.test.ts` |
| 26 | Requirements audit | docs/KOLBE_REQUIREMENTS_1-356_FA.md re-audit | last audited pre-Prompt-1 | **GAP** | — | status matrix in final report (DONE/PARTIAL/NOT DONE/SUPERSEDED/NA) | Docs | — |
| 27 | Glossary/invariants docs | Required artifacts | not present for final model | **GAP** | — | write docs | Docs | — |
| 28 | Browser QA | If environment allows | No Chromium in sandbox | DEFER | — | report NOT RUN honestly | QA | — |

## Commit plan (adjusted from §200)
- C1 this matrix · C2 Finance Center final IA + shipping/events/advances/withdrawal cleanup · C3 Supplier Statement V2 ·
- C4 Try-On finance (066 + API + UI + tests) · C5 review UX polish + CRM legacy cleanup · C6 localization sweep + docs (glossary/invariants/requirements) + final report. Push after every commit.
