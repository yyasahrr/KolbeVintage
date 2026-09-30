# Agent D1 — hardening & finalize report

Branch `arena/01a0ed90-kolbevintage` · PR #4 · scope frozen: **no new features, no merges of other branches**.
This pass only renumbered migrations, hardened the invariants the audits demanded, and wrote documentation.

## 1. Git state

| | |
|---|---|
| Local HEAD (this pass) | `34bbab2` "chore(hardening): renumber migrations to 045–049 and lock the growth invariants" + this report (branch tip) |
| Remote HEAD before this pass | `3008e89` (same branch) |
| history | `3cd9dac` (main) → `ce01186` → `3008e89` → `34bbab2` (+ docs) |
| PR | #4, base `main` |
| working tree | only `node_modules/**` differs (pnpm/npm local install artifacts, not committed) |

**Baseline verification (task 2).** `git merge-base HEAD ff10906` = `3cd9dac`; `git diff ff10906..HEAD` (excluding
`node_modules`) lists exactly this branch's own files — new modules `automation.ts`, `buyer360.ts`, `cart.ts`,
`crm-intelligence.ts`, `events.ts`, `membership.ts`, `profile.ts`, `promo-safety.ts`, `recommendations.ts`,
`reviews.ts`, `tracking.ts`, `video.ts`, `growth.test.ts`, 5 migrations, 9 frontend components, plus 18 modified
files — and nothing else. `git diff ec41e11..ff10906` (tip of the `arena/01a0e916` line vs the baseline) contains
only `docs/KOLBE_REQUIREMENTS_1-356_FA.md`, and that file is byte-identical in our HEAD
(`git diff ec41e11 HEAD -- docs/KOLBE_REQUIREMENTS_1-356_FA.md` is empty). Conclusion: **only the baseline
`ff10906` (plus its requirement doc) entered this branch — no foreign commits or files.**
Note: the branch is a *content*-level continuation of the baseline (re-created on `main`), so `ff10906` is not a
parent in `git log`; the verification is therefore diff-based, as above.

## 2. Migrations (task 1) — now 045–049

| File | Replaces | Content |
|---|---|---|
| `045_membership_buyer.sql` | `016_membership_buyer.sql` | memberships, buyer profile/documents |
| `046_crm_intelligence.sql` | `017_crm_intelligence.sql` | CRM labels/rules/segments, consent, 2FA tables |
| `047_automation_tracking.sql` | `018_automation_tracking.sql` | automation outbox/deliveries, shipments, tracking imports |
| `048_reviews_recommendations.sql` | `019_reviews_recommendations.sql` | reviews/reports, recommendation slots/signals/events |
| `049_video_permissions_promo_growth_hardening.sql` | `020`+`021`+`022`+`023` + hardening | product media/video analytics, permissions, promo safety, growth gaps, **plus** the hardening SQL |

Fresh-database evidence (empty database, real `migrate.ts`): **20 migrations applied in order `001…015` then
`045…049`**, second `migrate` run = **0 applied (idempotent)**, **114 tables**, spot-checked `carts`,
`two_factor_challenges`, `customer_reviews`, `recommendation_slots`. `016`–`044` is left free for the
Agent-Commerce line by design; the runner sorts by filename and simply skips the gap.

Hardening SQL added inside `049`: `sms_deliveries.category` (`transactional|marketing`, back-filled),
`blocked_reason`, `status` CHECK extended with `blocked`, `sms_deliveries_category_idx`; trigger
`kolbe_customer_reviews_immutable` (rejects changes to `rating`, `verified_purchase`, `product_id`, `user_id`);
`COMMENT`s on the recommendation tables stating they must not cache price or stock.

## 3. Test evidence (task 5)

| Command | Result |
|---|---|
| `cd backend && npm run test:embedded` | **65/65 pass, 0 fail** (real migrations on embedded PGlite, full API surface) |
| `cd backend && npm run test:contract` | **46/46 checks pass** |
| `cd backend && tsc -p tsconfig.json --noEmit` | clean |
| `tsc -p tsconfig.json --noEmit` (frontend) | clean |
| `npm run build` (vite) | OK — `dist/index.html` 1,176.11 kB (301.80 kB gzip) |
| `cd backend && npm run test:browser` | **BLOCKED (environment)**: needs `/tmp/chromium`, the sandbox cannot download Chrome (`storage.googleapis.com` unreachable, exit 35). Not in the required evidence list; the admin/account/storefront flows it covers are exercised through the embedded API tests. |

New assertions added to `growth.test.ts` test 19 (≈150 lines) — one per audit:
retroactive consent revocation blocks queued marketing SMS while the transactional 2FA/OTP SMS is still sent;
the DB trigger rejects a rating rewrite and a `verified_purchase` flip while moderation may still change
`status`; moderation never alters the rating; a catalog price change is reflected in the product payload;
a zero-stock product disappears from recommendations (and is absent from the recommendation tables' columns);
the dispatcher is idempotent (a second pass creates 0 deliveries); a retry reuses the same delivery row;
`cart.abandoned` is emitted once; a low-confidence tracking import is stored as `needs_review` and never
reaches the customer, and the same rule holds on the `POST /admin/shipments/:id/events` path.

## 4. Audit results (task 3) — DONE

| # | Audit | Status | Enforcement |
|---|---|---|---|
| 1 | No marketing SMS without consent | **DONE** | `customer_consents.marketing_sms` + `do_not_contact` checked at queue time (`consentedRecipients`) **and** at send time (`drainSmsQueue` re-reads consent per `marketing` row → `blocked`/`consent_missing_at_send`); `PATCH /customer/consent` blocks already-queued rows and returns `blockedQueuedSms`; test asserts a revoked customer is skipped while OTP still delivers |
| 2 | Transactional vs marketing separated | **DONE** | `sms_deliveries.category` column + back-fill + CHECK; all 11 insert sites tagged (auth/profile/tracking/worker = transactional; crm, crm-intelligence, console, cart, promo-safety = marketing); only marketing rows are consent-gated |
| 3 | 2FA recovery codes one-time | **DONE** | `consumeRecoveryCode()` verifies against the stored hash list and removes the consumed hash; the plain list is returned only once at `2fa/confirm` |
| 4 | Abandoned-cart event idempotent | **DONE** | sweep takes the carts `FOR UPDATE`, flips `active → abandoned` and emits `cart.abandoned` in the same transaction; a repeated sweep emits 0 (asserted: single event row) |
| 5 | Recommendations never cache/source price or stock | **DONE** | items are joined live to `catalog.products.cash_price_rial` and `wms.stock_balances(on_hand - reserved - damaged)`; `sources {pricing, availability, cached:false}` returned; `information_schema` test asserts no price/stock columns exist in the recommendation tables; `COMMENT`s document the rule |
| 6 | Ratings not editable by Admin | **DONE** | `kolbe_customer_reviews_immutable` trigger (ERRCODE 23514) + moderation endpoint only writes `status`/note/reviewer/date; test proves a rating UPDATE fails and moderation leaves the rating intact |
| 7 | Verified purchase from a real order | **DONE** | computed from a paid order line at insert; `verified_purchase` is covered by the same immutability trigger, so it cannot be flipped afterwards |
| 8 | Low-confidence tracking enters review | **DONE** | `REVIEW_CONFIDENCE_THRESHOLD = 0.7` → import rows `needs_review` (no shipment timeline entry) and manual/API events stored with `review_status = 'needs_review'`; a human approve/reject endpoint resolves them, and unconfirmed rows never notify the customer |
| 9 | Automation events idempotent / retry-safe | **DONE** | outbox written in the state transaction; unique `(event_id, subscription_id)` with `ON CONFLICT DO NOTHING`; retries update the same row (attempt/backoff/dead); inbound webhooks signed with 300 s tolerance and replay-protected by `automation_webhook_receipts` |
| 10 | Consent-aware bulk SMS panel + Promo safety | **DONE** | the console's bulk sender counts `blockedByConsent` and never enqueues non-consenting recipients; promo-safety automations emit `marketing` rows through the same gate |

## 5. API / event surface (task 6)

- **Buyer/Customer 360** — `buyer360.ts` (12 routes): `/admin/buyers`, `/admin/buyers/:id` (+ timeline, notes, labels, segments, documents).
- **CRM** — `crm-intelligence.ts` (24) + `crm.ts` (11): labels, rules, segments (preview/refresh), activities, notes, contact-change requests, campaigns, consent PATCH.
- **Automation center** — `automation.ts` (13): event catalog, subscriptions, deliveries, retry/replay, inbound webhooks (signed), health stats. Event catalog seeds **36 event types** (`order.paid`, `cart.abandoned`, `cart.converted`, `cart.nudged`, `membership.*`, `review.created`, `shipment.tracking.updated`, `coupon.personal_issued`, `recommendation.clicked`, `video.progress`, …).
- **Tracking** — `tracking.ts` (10): `/admin/shipments*`, `/admin/tracking/imports*` (+ item review), `POST /automation/tracking/:integration`.
- **Reviews** — `reviews.ts` (12): public create/list with `verifiedPurchase`, ratings summary, admin moderation & analytics, reports.
- **Recommendations** — `recommendations.ts` (8): slot rendering (`home.for_you`, `pdp.related`, `cart.cross_sell`, …), `/recommendations/events` (click/ATC/purchase), admin slots/manual items/analytics.
- **Account security** — `profile.ts` (14): profile, contact change (idempotency-key + `email_link`/`sms_otp`), settings, addresses; security centre: sessions list/revoke/revoke-others, password change, 2FA setup/confirm/verify/disable, login history.
- **Cart** — `cart.ts` (8): get/add/update/remove/merge/convert (server-side price & stock re-resolution, 409 on stale price; `cart.abandoned` / `cart.converted` outbox events).
- **Promo safety** — `promo-safety.ts` (13): templates, runs, checks, personal coupons.
- **Membership** — `membership.ts` (12): plans, subscribe/renew/upgrade, buyer documents.
- **Console/admin extras** — `console.ts` (11) incl. consent-aware bulk SMS; `video.ts` media + analytics events.
- **Frontend** — `buyer-360-panel`, `crm-center`, `automation-center`, `tracking-center`, `reviews-center`,
  `recommendations-panel`, `promo-safety-panel`, `security-center`, `product-social` (+ `portals/admin.tsx`,
  `account.tsx`, `retail.tsx`, `data/api.ts` wiring).

## 6. Dependencies on other branches

* **Required**: `main` baseline `3cd9dac` / content baseline `ff10906` (migrations `001`–`015`, catalog, WMS,
  pricing, orders, auth). Nothing else is needed.
* **Reserved**: `016`–`044` are left to the Agent-Commerce line; this branch owns `045`–`049`, so the two can
  coexist without renumbering.
* **Consumed read-only**: `catalog.products`, `wms.stock_balances`, `orders/order_items`, `users`,
  `notifications`, `coupons` — via existing services, never via new cross-branch tables.
* **Not merged / not required**: `arena/01a0ed8e`, `arena/01a0ed8f`, `arena/01a0ed9a`, `arena/01a0e859`
  (their `016`+ migrations are untouched here). No other branch was merged in this pass.

## 7. Remaining risk / follow-up (not blockers)

* Browser smoke (`test:browser`) could not run in this sandbox (no Chrome binary, downloads blocked); it should
  be run once in an environment that has Chromium before release sign-off.
* `dist/**` build output is committed on this branch (pre-existing); rebuild it if the storefront changes.
* `node_modules/**` is tracked in this repository's history, so a local `npm install` shows noise in
  `git status`; nothing under `node_modules` is part of this pass's commit.
* The scratch harnesses `backend/scripts/debug-migration-order.mjs` and `debug-trigger.mjs` used for evidence
  were deleted before the commit; their results are recorded in §2.
