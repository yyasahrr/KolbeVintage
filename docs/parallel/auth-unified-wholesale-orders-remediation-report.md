# AUTH + UNIFIED OMS IA REMEDIATION — REPORT

**Task:** the Product-Owner locked remediation gate executed **after Prompt 4 and before Prompt 5**:
(1) ONE canonical AUTH system for Customer + VIP, admin and supplier kept separate; (2) ONE canonical
primary wholesale order surface — «سفارشات عمده / VIP» — where **fulfillment source is a property of the
order and a filter on one list, never an order type**.

| Field | Value |
| --- | --- |
| Repository | `https://github.com/yyasahrr/KolbeVintage` |
| Branch | `arena/01a10ace-kolbevintage` |
| Canonical Prompt-4 baseline | `de5aa71` (verified ancestor of this HEAD) |
| Force-pushed remediation commit | `31774e8` — `feat(auth+oms-ia): ONE customer/VIP identity and ONE wholesale/VIP order surface` |
| Final HEAD (report commit) | recorded in §12 below and returned in the local answer |
| Storefront branch content (`561e49a`, `feature/storefront-retail-variant-fix`) | **absent** — not merged, not cherry-picked, not recreated; verified with `git cat-file -e origin/arena/01a10ace-kolbevintage:src/data/retail-variants.ts` → *absent* |
| `origin/main` | untouched (`3cd9dac`) |
| Working tree | clean (no `dist`, no Vite cache, no temporary harness files commit) |

Scope discipline: only **AUTH** and the **Admin OMS IA/UX** changed. Prompt-4 OMS semantics, Prompt-3 WMS
domain separation, Prompt-2 pricing snapshots and Prompt-1 Product Studio are preserved (evidence in §6).
**Prompt 5 was not started.**

---

## 1. §59 report items 1–36

| # | Item | Answer / evidence |
| --- | --- | --- |
| 1 | ONE canonical primary wholesale surface | `src/portals/orders-hub.tsx` — `OrdersHub` renders exactly two tabs: `سفارشات خرده` and `سفارشات عمده / VIP`; the wholesale tab mounts `WholesaleOrderCenter` (`orders-hub.tsx:757,774`) |
| 2 | No separate «سفارشات عمده کلبه» / «سفارشات عمده تأمین‌کنندگان» primary centers | `grep -rn 'سفارشات عمده کلبه\|سفارشات عمده تأمین‌کنندگان' src/` → **0 hits**; `WholesaleTab`/`MasterOrdersStrip` components deleted (`grep -rn 'WholesaleTab\|MasterOrdersStrip' src/` → **0 hits**) |
| 3 | Not a mere rename | the per-source **routes** were removed and their authority merged into the master detail; the two components are gone from the bundle, and the child tooling moved into `src/components/master-child-orders.tsx` |
| 4 | Admin primary order IA = مرکز سفارشات → خرده / عمده / VIP | sidebar has ONE order entry `{ v: "server-orders", label: "مرکز سفارشات" }` (`admin.tsx:287`) whose description names the two operational views (`admin.tsx:319`) |
| 5 | ONE Master Order list inside the wholesale surface | `WholesaleOrderCenter` has a single list query (`GET /api/v1/wholesale/masters`) — every source bucket returns the SAME master rows (§5, live evidence 7) |
| 6 | Source differences INSIDE the order | detail panel «تخصیص و تأمین» shows «موجودی کلبه (رزروشده)» / «تأمین‌کننده نزد کلبه» / «نیازمند تأمین» per master (`wholesale-order-center.tsx:540–542`) plus per-line source allocation |
| 7 | MV-2000-style single order with 10 = 3 + 2 + 5 | seeded `MV-2000` is ONE master with 3 children and coverage 2 کلبه + 2 تأمین‌کننده نزد کلبه + 2 نیازمند تأمین (live evidence 8); the prompt's 10=3+2+5 shape is locked by the Prompt-4 test `P4-OMS-004/008/015/016/022 — prescribed 4+3+2 multi-supplier master and 10=3+2+5 mixed coverage` (embedded subtest 132) |
| 8 | Source-specific visibility = FILTERS on the same list | `COVERAGE_FILTERS` = همه / دارای موجودی کلبه / دارای موجودی تأمین‌کننده نزد کلبه / نیازمند تأمین / ترکیبی (`wholesale-order-center.tsx:123–129`), sent as `coverage=` to the ONE list endpoint |
| 9 | Filters are server-side, not client slicing | `coverage` is a Zod enum in the master list schema (`backend/src/wholesale-oms.ts` list route) with an explicit comment that source type is not an order type |
| 10 | Audit of the old tabs (KEEP/MERGE/RENAME/DEMOTE/REMOVE) | §2 table below — nothing was merely renamed; two centres removed, their data/features merged, zero duplicate authority left |
| 11 | Old routes redirect to the unified surface | `TAB_REDIRECT` in `admin.tsx:129–160`: `worders`, `kolbe`, `supporders`, `masters`, `wholesale` → `server-orders:wholesale`; retail-side legacy keys → `server-orders:retail`; hash routing keeps the hub sub-target |
| 12 | No duplicate authority hidden behind another route | legacy keys are *redirects only* (no component mounts them); `TAB_REDIRECT[key] ?? key` is applied both on tab click and on cold deep-link (`admin.tsx:245,257,270–271`) |
| 13 | Child/suborders only INSIDE the master detail | `MasterChildOrders` is imported and rendered only by the detail workspace (`wholesale-order-center.tsx:24,533`) |
| 14 | Supplier supply tasks are not a second order centre | supplier-side legacy keys `supporders` redirect to the unified tab; the supplier portal keeps its own child-order queue (its own portal, not an admin order centre) |
| 15 | Buyer sees ONE order | live evidence 10: buyer `view=buyer` payload = order facts, items, own `subOrders` references, totals, shipping, actions, timeline; leak scan for `seller_id/source_type/allocation/offer_id/warehouse_note/capacity` → **clean** |
| 16 | Customer-facing status separate from operational readiness | list returns `customer_status` *and* `readiness` as two independent server-derived columns; readiness is used only in the ops projection |
| 17 | «unclear extra Order Center section» resolved | the former third wholesale list inside the Orders Hub was removed, not documented away: the hub now has exactly two tabs, and the strip component that duplicated master rows is gone |
| 18 | Customer + VIP = ONE auth system | one `users` row, one session, one login surface; `/auth/me` → `roles:["customer"]`, `isWholesaleMember:true`, `membership:{status,endsAt,planCode,planTitle,tier}` (live evidence 9) |
| 19 | Login methods: mobile+OTP **and** email+password | OTP: `POST /api/v1/auth/otp/request` + `/auth/otp/verify`; password: `POST /api/v1/auth/login` (with the existing 2FA step-up). Only one input group is active in the UI (`loginMethod` state in `AuthScreens`) |
| 20 | Both methods produce the SAME canonical session | both end in `createSession` + `kolbe_refresh` cookie; `/auth/me` is identical for both (contract smoke locks) |
| 21 | Real customer registration | mobile → OTP → تأیید → نام → نام خانوادگی (email optional); `POST /auth/register` validates the `customer_signup` challenge (hashed code, attempt cap, single use, `FOR UPDATE`), creates the user, grants `customer`, seeds consents, emits `customer.created` + timeline, returns `201 {id, displayName, accessToken, expiresIn:900, linking}` |
| 22 | VIP = Customer + canonical membership | entitlement is the active `memberships` row projected by `principal()`; no VIP role, no demo flag, no URL flag, no hardcoded VIP email (`grep -rni 'demoRole\|isDemoVip\|demoVip' src/` → 0) |
| 23 | Admin: separate login, no public admin registration | admin login surface separate; live evidence 9: a public `POST /auth/register` with `role:"admin"` → **HTTP 400**, no admin minted |
| 24 | Supplier: separate login + separate «درخواست عضویت تأمین‌کننده» | supplier entry column has both actions; application is the canonical `cooperation_requests` flow (11 required fields), never a login |
| 25 | A visitor cannot become operational instantly | portal access = `admin` OR (`supplier` role AND `cooperation_status='approved'`); unapproved → real backend state card `درخواست عضویت تأمین‌کننده در حال بررسی است` / `... تأیید نشد` (`src/portals/supplier.tsx`) |
| 26 | No «کاربر پیدا نشد» for a live applicant | `POST /auth/login` for a known number with a live request returns `403 SUPPLIER_APPLICATION_PENDING` / `SUPPLIER_APPLICATION_REJECTED` derived from `cooperation_requests.payload` (live evidence 9) |
| 27 | Password recovery | `POST /api/v1/auth/password/forgot` — rate-limited, hash-only token in the canonical `password_reset_tokens`, invalidates prior live tokens, always `{delivered:true}` (no enumeration), completes through the existing `set-password`; `devToken` only outside production |
| 28 | Identity linking — one person ≠ two customers | a verified mobile resolves to ONE user: legacy/one-time-credential account ⇒ in-place activation (`linking='legacy_activation'`); live account ⇒ `409` (no silent merge); extra identity via the verified contact-change flow (AUTH-001b/016 test) |
| 29 | OTP/password logic server-side only | hashed codes (`sha256(id:code:JWT_SECRET)`), TTL 3 min, one live code per number, attempt caps, single-use, `sms_deliveries` queue; no frontend-only success, no plaintext compare (`grep -rn '"[0-9]\{5\}"' src/` → 0) |
| 30 | Single canonical session, no duplicate truth | one auth store + `api` module token; `customerUser`/`vipUser`/`demoUser`/`legacyUser`/`authRole` are not used as authority (`grep -rni 'demoRole\|isDemoVip\|demoVip' src/` → 0); logout revokes the session **and** the refresh capability (AUTH-018) |
| 31 | Destination preservation | checkout → checkout, VIP area without membership → membership-required state (no login loop), admin → admin workspace, supplier → supplier portal; no generic homepage redirect (`App.tsx` return-to-destination; contract-smoke lock) |
| 32 | Persian UX only | no 401/403/OTP_EXPIRED/INVALID_CREDENTIALS/snake_case/JSON/stack traces in the UI; server messages are Persian and the auth screens surface only friendly text with loading/error states |
| 33 | Accessibility / RTL / responsive | `Input` primitive extended with `ariaLabel/inputMode/autoComplete/dir/name/autoFocus/maxLength`; correct autocomplete + `inputMode` for password managers and OTP autofill; visible focus; widths 360/390/768/1024/1280/1440 covered by the responsive static QA (`1/1 PASS`) |
| 34 | Auth matrix AUTH-001…018 | all 12 dedicated subtests green inside the embedded run (subtests 2–13); plus the live contract round-trips (signup → register → login; duplicate-signup refusal; forgot → set-password → old password rejected) |
| 35 | Dead-code / duplicate-authority audit | §7 — every removed item listed with what replaced it, plus the retained compatibility paths and their justification |
| 36 | Tests, counts, git state, evidence, browser status | §8–§12 — exact counts after the LAST change, `local == remote`, clean tree, static evidence file, preview URLs and the browser verdict |

---

## 2. Audit of every top-level order tab (KEEP / MERGE / RENAME / DEMOTE / REMOVE)

| Old surface (route key) | Decision | What happened |
| --- | --- | --- |
| `masters` — «مرکز سفارش‌های مادر VIP» | **REMOVE (primary) → MERGE** | its master list became the ONE list of «سفارشات عمده / VIP»; route now redirects to `server-orders:wholesale` |
| `kolbe` — «سفارشات عمده کلبه» | **REMOVE → MERGE** | Kolbe-sourced rows are no longer an order centre: they are the `coverage=kolbe` filter and the `موجودی کلبه` block inside the order |
| `supporders` — «سفارشات عمده تأمین‌کنندگان» | **REMOVE → MERGE** | supplier-sourced rows became the `coverage=supplier_at_kolbe` / `coverage=supply_required` filters + the «تخصیص و تأمین» panel |
| `worders` — demo wholesale order list | **REMOVE → MERGE** | same list, one surface; the operational tooling moved into `components/master-child-orders.tsx` |
| `wholesale` — a second wholesale entry point | **MERGE** | alias that lands on the unified tab; kept as a redirect only |
| Orders-Hub strip (`MasterOrdersStrip`) + `WholesaleTab` | **REMOVE** | deleted components; they duplicated master rows and re-split the surface by source |
| `retail-orders` / `rorders` | **KEEP (as `سفارشات خرده`)** | retail stays a first-class sibling tab under مرکز سفارشات |
| `manual-sales`, `tracking` | **DEMOTE (inside مرکز سفارشات)** | manual sale + tracking are drawers/actions inside the retail tab, not top-level order centres |
| `server-ops`, `shipping`, `wproducts`, `mreview` | **DEMOTE (different domain)** | redirected to `wms` / `settings` (`wms:wholesale-review`) — no order authority behind them |

Resulting IA (exactly): **مرکز سفارشات → سفارشات خرده + سفارشات عمده / VIP**, with the wholesale tab holding
ONE master list whose filters are sources, whose detail holds «تخصیص و تأمین», and whose children are never
promoted back into a top-level centre.

## 3. Route redirects (cold deep links, old bookmarks, Control-Tower shortcuts)

| Legacy route | Lands on |
| --- | --- |
| `#/admin/worders`, `#/admin/kolbe`, `#/admin/supporders`, `#/admin/masters`, `#/admin/wholesale` | `#/admin/server-orders:wholesale` (ONE Master Order list) |
| `#/admin/retail-orders`, `#/admin/rorders`, `#/admin/manual-sales`, `#/admin/tracking` | `#/admin/server-orders:retail` |
| `#/admin/server-ops` | `#/admin/wms` |
| `#/admin/shipping` | `#/admin/settings` |
| `#/admin/wproducts`, `#/admin/mreview` | `#/admin/wms:wholesale-review` |

Redirects are pure aliases evaluated before mount (`TAB_REDIRECT[key] ?? key`), so no legacy route can render
a second authority, and the unified hash target (`server-orders:wholesale`) survives a cold load.

## 4. AUTH changes completed

| Area | Change |
| --- | --- |
| Registration | mobile-first, OTP-verified **before** the account exists (`purpose:'signup'` on the canonical `two_factor_challenges`); email+password registration on the same identity model; `linking='new' \| 'legacy_activation'` |
| Login | mobile+OTP and email+password, both producing the canonical session; unknown identity with a live supplier request returns the real application state instead of a generic failure |
| Recovery | new `POST /auth/password/forgot` (canonical `password_reset_tokens`, hash-only, single live token, no enumeration) completing through the existing set-password |
| `/auth/me` | adds `supplier:{cooperationStatus,activityStatus,brandName} \| null`; membership stays the VIP authority |
| UI | redesigned `AuthScreens` (`src/portals/studio.tsx`): two login methods with one input group active, mobile-first signup, real Persian errors, autocomplete/inputMode, OTP UX, secondary legacy-account activation, return-to-destination; the dead inline 2FA modal and every demo shortcut (fixed code, demo VIP button, hardcoded demo password, supplier bypass) removed |
| Supplier gate | portal access from the server cooperation state (`/auth/me.supplier`), with the accurate pending/rejected card in the supplier entry column |
| Schema | additive migration `072_customer_otp_login.sql` (nullable `user_id` on `two_factor_challenges`/`sms_deliveries`, `customer_signup` purpose, index, comments) — no new auth tables, no destructive reset |

## 5. Live verification (same requests the browser makes, through the preview proxy)

Static + live evidence file: **`docs/parallel/evidence/auth-unified-wholesale-orders-remediation-evidence.txt`**
(in-repo copy; regenerated from the seeded local stack — a workspace copy also lives at
`/home/user/kolbe-ia-evidence.txt`). Highlights:

```
coverage=all               total=1 | MV-2000 | کلبه 2 | تأمین‌کننده نزد کلبه 2 | نیازمند تأمین 2 | partial | awaiting_payment
coverage=kolbe             total=1 | MV-2000 | …identical single order…
coverage=supplier_at_kolbe total=1 | MV-2000 | …identical single order…
coverage=supply_required   total=1 | MV-2000 | …identical single order…
coverage=mixed             total=1 | MV-2000 | …identical single order…
master MV-2000 | view=ops | readiness=partial | children=3
  child KV-100000 status=pending_payment supply=stock_reserved     (موجودی کلبه)
  child KV-100001 status=pending_payment supply=stock_reserved     (موجودی تأمین‌کننده نزد کلبه)
  child KV-100002 status=pending_payment supply=awaiting_supplier  (نیازمند تأمین)
pending supplier applicant login -> 403 SUPPLIER_APPLICATION_PENDING «درخواست عضویت تأمین‌کننده شما در حال بررسی است…»
public admin registration attempt -> 400
buyer ?scope=all -> 403 FORBIDDEN          ← buyer isolation
buyer view=buyer leak scan -> clean        ← no source topology / seller ids / allocations
```

## 6. Prompt-4 / Prompt-3 / Prompt-2 preservation

All Prompt-4 OMS invariants are still enforced by their own suites, untouched by this remediation:
master-order multi-source allocation, WMS physical reservation (never decrementing stock), capacity as
«نیاز به تأمین» only, cancellation releasing each source exactly once, explicit audited reassignment,
derived readiness, Kolbe-only final dispatch guard, immutable price/Series snapshots, buyer/ops projections
and supplier privacy (embedded subtests 122–132). Prompt-2 pricing snapshots and Prompt-1 studio behaviour
are covered by the same embedded run and the pricing-routing smoke.

## 7. Dead-code / duplicate-authority audit (and what was retained)

| Removed | Why it was dead/authoritative duplication |
| --- | --- |
| `WholesaleTab`, `MasterOrdersStrip` | two components re-split the ONE master list by source |
| legacy route keys `worders/kolbe/supporders/masters/wholesale` as mounts | each mounted its own order authority |
| demo auth shortcuts (fixed OTP code, demo VIP button, hardcoded demo password, supplier session bypass) | frontend authority over identity/membership |
| `src/data/retail-variants.ts` + storefront smoke block | not part of this branch's scope (storefront work belongs to `561e49a`) |

**Retained compatibility paths (justified):** the legacy route keys as *redirects* (old bookmarks must not
break, and they carry no authority); the legacy account activation entry (a secondary affordance — the
migration capability must not be deleted); the supplier portal's own child-order queue (operational, not an
admin order centre); the buyer list's aggregate counters, which are the reviewed Prompt-4 projection used by
the VIP coverage strip — they contain counts only, no supplier identity, no ids and no topology.

## 7b. OMS-IA-001…011 → evidence map

| ID | Requirement | Evidence |
| --- | --- | --- |
| OMS-IA-001 | ONE canonical primary wholesale surface named «سفارشات عمده / VIP» | `orders-hub.tsx:757` tab + `:774` single mount of `WholesaleOrderCenter`; live: one list, `total=1` |
| OMS-IA-002 | No separate «سفارشات عمده کلبه» / «سفارشات عمده تأمین‌کنندگان» primary tabs — removed, not renamed | `grep -rn 'سفارشات عمده کلبه\|سفارشات عمده تأمین‌کنندگان' src/` → 0; `WholesaleTab|MasterOrdersStrip` → 0 (components deleted) |
| OMS-IA-003 | Top-level order IA = مرکز سفارشات → خرده + عمده / VIP | one sidebar entry `server-orders` (`admin.tsx:287`, description `:319`) containing exactly the two tabs |
| OMS-IA-004 | ONE Master Order list; **source type is not an order type** | single endpoint `GET /api/v1/wholesale/masters`; live: `all/kolbe/supplier_at_kolbe/supply_required/mixed` → the SAME single `MV-2000` row |
| OMS-IA-005 | Source visibility = FILTERS on that same list (5 values) | `COVERAGE_FILTERS` (`wholesale-order-center.tsx:123–129`) ↔ server Zod enum `coverage` with the PO comment on the list route |
| OMS-IA-006 | Mixed sources shown INSIDE one order | detail panel «موجودی کلبه (رزروشده)» `:540`, «تأمین‌کننده نزد کلبه» `:541`, «نیازمند تأمین» `:542`; live MV-2000 = 2/2/2 with 3 children of different sources |
| OMS-IA-007 | Children only inside «تخصیص و تأمین»; no child-level authority | `MasterChildOrders` imported/rendered only at `wholesale-order-center.tsx:24,533`; the per-seller tooling moved there from the deleted tabs |
| OMS-IA-008 | Legacy routes redirect; cold deep links safe; no hidden duplicate authority | `TAB_REDIRECT` table (§3) applied on click **and** deep-link (`admin.tsx:245,257,270–271`); legacy keys are aliases only, no component mounts them |
| OMS-IA-009 | Buyer projection hides topology; admin authority server-side | live: buyer payload leak scan **clean**, `?scope=all` → **403**, supplier reading a buyer master → **403**; masking happens server-side (`wholesale-oms.ts` buyer/ops projections) |
| OMS-IA-010 | Customer-facing status separate from operational readiness | the list returns `customer_status` and `readiness` as independent derived columns; readiness is ops-only |
| OMS-IA-011 | Supplier supply tasks are not a second order centre; a supplier sees only its own queues | supplier portal queue is a separate portal, legacy `supporders` route redirects to the unified tab; live: supplier queue `rows=1`, leak scan (buyer id / master id / address / allocation) **clean** |

## 7c. Additional live end-to-end auth verification (through the preview proxy)

Full transcript in the evidence file above (§10–§14). Highlights:

* signup OTP request for a brand-new number → `{challengeId, phoneMasked, purpose:'signup', deliveryHint:'sms_queued', devCode (non-production only)}`; register → `201`, `linking:'new'`, access token + 900 s expiry.
* re-requesting a signup code for the same number → `409 CONFLICT «این شماره همراه قبلاً ثبت شده است؛ وارد شوید.»`
* that fresh account: `roles:["customer"]`, `isWholesaleMember:false`, `membership:null`, `supplier:null` — a real account with no invented entitlement.
* password recovery: `forgot` → identical `{delivered:true}` for a known and an unknown identity (no enumeration); `set-password {token,newPassword}` → `200 {activated:true}`; the **same token twice → 400** (single-use); the new password signs in; **the pre-recovery session is revoked (401)** because `set-password` bumps `token_version`.
* role forging: `register` schemas are `.strict()`, so a `roles` field is rejected by validation, and the handler grants exactly `customer` (`auth.ts:230`); the embedded AUTH-014 test asserts `roles === ["customer"]`, no `users:manage` permission and `403` on admin routes.
* supplier isolation: the supplier queue returns only its own supply tasks and exposes no buyer identity, master id, address or allocation.

**UAT note — intentional rate limits** (per process, reset when the local stack restarts):
`/auth/register` 5/hour, `/auth/otp/request` 5/5 min, `/auth/login` 10/min,
`/auth/password/forgot` 5/15 min, `/auth/set-password` 10/hour. During Browser UAT, if the 5-registration
budget is exhausted, restart `npm run demo:stack` (in-memory counters reset) — do not read `429` as a bug.

## 8. Exact test counts — frozen after the LAST code change

| Gate | Result |
| --- | --- |
| Full embedded backend suite (`npm run test:embedded`, fresh PGlite + 53 migrations) | **251/251 pass, 0 fail, 21 suites** (162 top-level subtests) |
| ↳ dedicated Auth matrix inside it (AUTH-001…018) | **12/12 pass** (subtests 2–13) |
| ↳ Prompt-4 OMS acceptance inside it (P4-OMS-001…026) | **11/11 pass** (subtests 122–132) |
| Migration verifier (`node scripts/verify-migrations.mjs`, cwd `backend/`) | **ALL CHECKS PASSED** (53 files unique ids; populated upgrade safe) |
| Contract smoke (`npm run test:contract`) | **174/174** (incl. live signup/OTP/recovery round-trips and the IA static locks) |
| Dynamic-table smoke (`npm run test:dynamic-table`) | **14/14** |
| Pricing-routing smoke (`npm run test:pricing-routing`) | **25/25** |
| Responsive static QA (`backend/scripts/qa-responsive-static.mjs`) | **1/1 PASS** (360/390/768/1024/1280/1440) |
| Frontend TypeScript (`tsc -p tsconfig.json --noEmit`) | **0 errors** |
| Backend TypeScript (`tsc -p backend/tsconfig.json --noEmit`) | **0 errors** |
| Production build (`vite build`) | OK — `dist/index.html` 2,425.47 kB / gzip 597.58 kB; `dist` restored, nothing built committed |
| Demo/UAT seed (`npm run demo:stack` → migrations + `seed:local`) | **76 idempotent steps**, fresh DB, all credentials printed |

## 9. Seed identities for the next Browser UAT (documented, safe, idempotent)

| Identity | Credentials | Expected result |
| --- | --- | --- |
| Admin (separate surface, no public registration) | `admin@kolbe.ir` / `ChangeMe-Admin-123456` | admin workspace |
| **Ordinary customer** (no entitlement) | `demo.customer@kolbe.ir` / `Demo-Customer-123456` — seeded with an explicit assertion that it holds **no** active membership (`isWholesaleMember:false`, `membership:null`) | signed in, sees the membership-required state instead of VIP features; its wholesale list is empty (no leak) |
| **VIP customer** (customer + active membership) | `seed.customer@kolbe.ir` / `Seed-Customer-123456` | VIP workspace on the SAME account (`isWholesaleMember:true`, plan «عضویت عمده نمونه») |
| Approved supplier | `seed.supplier@kolbe.ir` / `Seed-Supplier-123456` | supplier portal (`cooperation_status=approved`) |
| **Pending supplier applicant** | mobile `09990000009` (any password) / `pending.supplier@example.test` | `403 SUPPLIER_APPLICATION_PENDING` + «درخواست عضویت تأمین‌کننده شما در حال بررسی است» — never an operational portal |
| Mixed-source wholesale Master Order | — | `MV-2000` (کلبه 2 / تأمین‌کننده نزد کلبه 2 / نیازمند تأمین 2) in ONE list, ONE order |

## 10. Migration / schema impact

Only ONE additive migration: `072_customer_otp_login.sql` — nullable `user_id` on `two_factor_challenges`
and `sms_deliveries`, the `customer_signup` purpose on the existing challenge table, one index and comments.
No new auth or order tables, no data reset, deterministic and idempotent, covered by the verifier.

## 11. Browser status and local UAT instructions

No real browser is available in this environment (bounded check: no Chromium/Chrome binary, no Playwright
runtime, no browser package in either manifest) ⇒ **LOCAL BROWSER UAT REQUIRED**. A bounded UI/UX skill
check was also performed: no skill/marketplace source is mounted in this environment, therefore
**“Relevant UI/UX skills unavailable; repository design system used.”** — the auth and order surfaces are
built from the existing primitives (`Input`, `Btn`, `Card`, `Segmented`, `Drawer`) and the repository's
design tokens. What was verified instead
for the new HEAD: Vite serves the app and every changed module transforms without error through the preview
host, the API proxy answers exactly as the browser would, and the live API evidence in §5 was captured
against the seeded stack.

Local stack for the PO's UAT (already running in this workspace):

* API: `cd backend && KV_SEED_LOCAL=1 npm run demo:stack` → `http://127.0.0.1:4000`
* App: `node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173` → preview at
  `https://5173-<sandbox-id>.e2b.app`
* Walkthrough: sign in as admin → **مرکز سفارشات** must show exactly `سفارشات خرده` + `سفارشات عمده / VIP`
  (no «سفارشات عمده کلبه» / «سفارشات عمده تأمین‌کنندگان» tab) → open **MV-2000** → one order with mixed
  coverage inside «تخصیص و تأمین» → narrow the ONE list with the five coverage filters → then customer OTP
  signup/login, VIP view without membership, and the pending-applicant supplier state.

## 12. Git state

* Force-pushed remediation commit: `31774e8` on `arena/01a10ace-kolbevintage` (baseline `de5aa71`), forced
  with `--force-with-lease`; the previous remote head `08abd42` — which still contained the forbidden
  storefront commit `be7b818` — was replaced, so the branch history no longer carries storefront content.
* `origin/main` untouched at `3cd9dac`.
* Commit chain on `arena/01a10ace-kolbevintage`: `31774e8` (remediation) → `1114c5d` (report + pending-applicant
  seed) → `eaf1351` (ordinary non-VIP UAT customer + corrected credentials table) → `31c4bd2` (OMS-IA
  evidence matrix, live E2E auth transcript, UAT rate-limit note) → this final report-pinning commit.
  **The branch tip is the authoritative final SHA** and is returned in the completion answer.
* Verified at the end of the session: `git rev-parse HEAD` = `origin/arena/01a10ace-kolbevintage`
  (**local == remote**), working tree **clean**, `origin/main` still `3cd9dac`, and the forbidden storefront
  commit is neither reachable nor present as an object.

## §60 Verdict

AUTH + UNIFIED OMS REMEDIATION COMPLETE — LOCAL BROWSER UAT REQUIRED
