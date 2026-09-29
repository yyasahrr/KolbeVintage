# Agent D1 — contracts (final hardening pass)

Branch: `arena/01a0ed90-kolbevintage`
Scope: Buyer/Customer 360 · CRM labels & segments · CRM automation · consent-aware SMS ·
account security/2FA/sessions · server cart + abandoned cart · product reviews & verified
purchase & moderation · recommendation engine & analytics · automation center ·
shipment tracking automation.

This file is the **contract surface**: what the backend promises, what the frontend may
depend on, and which invariant each promise is enforced by. No new features were added in
this pass — only hardening, migration renumbering and documentation.

---

## 1. Migration contract

| Branch migration | Contents | Notes |
|---|---|---|
| `045_membership_buyer.sql` | memberships lifecycle, plans, `buyer_profiles`, `buyer_documents`, membership events | was `016_membership_buyer.sql` |
| `046_crm_intelligence.sql` | CRM labels, `crm_label_rules`, segments, `crm_activities` timeline, notes, `customer_consents`, contact-change requests, 2FA tables | was `017_crm_intelligence.sql` |
| `047_automation_tracking.sql` | automation subscriptions/deliveries/inbound receipts, shipments, tracking events/imports | was `018_automation_tracking.sql` |
| `048_reviews_recommendations.sql` | `customer_reviews`, reports, rating views, recommendation slots/manual items/events/signals | was `019_reviews_recommendations.sql` |
| `049_video_permissions_promo_growth_hardening.sql` | product media + video analytics, permission hardening, promo safety templates/runs, growth gaps (2FA challenges, carts, event catalog) **and the hardening section** | merges the former `020`–`023` |

* Range is **045–049**; `001`–`015` remain the upstream baseline (identical to `main`).
* Ordering is by filename (`migrate.ts` sorts with `readdir().sort()`), so a fresh database
  applies `001…015` then `045…049` — verified on an empty database and on a second run
  (idempotent, `schema_migrations` gate).
* `agent-commerce` (other branch) owns `016`–`044`, so there is no numeric overlap anymore.

## 2. Event contract (automation center)

Outbox row → n8n delivery. Payload is the envelope below; `eventId` is stable and is reused
on every retry.

```json
{ "event": "order.paid", "eventId": "<uuid>", "eventType": "order.paid", "schemaVersion": 1,
  "occurredAt": "2026-09-29T12:00:00.000Z", "entity": { "type": "order", "id": "<uuid>" },
  "data": { }, "source": "domain" }
```

Headers on the outbound POST: `x-kolbe-event`, `x-kolbe-event-id`, `x-kolbe-schema-version`,
`x-kolbe-delivery-id`, `x-kolbe-idempotency-key` (= `eventId:subscriptionId`), `x-kolbe-attempt`,
`x-kolbe-signature` (`t=<unix>,v1=<hmac-sha256(t.body)>`).

Guarantees (each proven by a test):

| Guarantee | Enforced by |
|---|---|
| events are written inside the state transaction (outbox pattern) | `emitEvent` / `outbox()` called with the same client |
| one delivery per `(eventId, subscriptionId)` even if the dispatcher runs twice | `automation_deliveries_unique_idx` + `ON CONFLICT DO NOTHING` |
| retries never create a second row, attempts/backoff are recorded per row | `processDeliveries` (`attempt`, exponential `next_attempt_at`, `dead` after `max_attempts`) |
| the event closes only when ≥1 subscriber succeeded and 0 are pending | `processDeliveries` tail |
| replay is safe (resets rows, does not duplicate them) | `POST /admin/automation/events/:id/replay` |
| inbound webhooks are signed + replay-protected | `verifySignedPayload` (300 s tolerance) + `automation_webhook_receipts(integration_id, signature_hash)` |

Catalog: `automation_event_catalog` (36 rows) — includes `customer.created`, `order.paid`,
`membership.*`, `cart.abandoned`, `cart.converted`, `cart.nudged`, `review.created`,
`shipment.tracking.updated`, `coupon.personal_issued`, `recommendation.clicked`, `video.progress`.

## 3. SMS contract (transactional vs marketing)

`sms_deliveries.category ∈ {transactional, marketing}` (default `transactional`) and
`status ∈ {queued, sending, sent, failed, unknown, blocked}`.

Transactional (never gated by marketing consent): order/ticket/membership notifications,
shipment tracking updates, contact-change OTP, 2FA challenge and 2FA setup codes.

Marketing (gated by `customer_consents.marketing_sms` **and** `NOT do_not_contact`): CRM
campaigns, bulk SMS panel, cart nudges (sweep + manual), birthday gift automation, personal
coupon issuance message, promo-safety automation messages.

Two-stage gate:
1. **Queue time** — `consentedRecipients()` decides who is even counted; the audience
   endpoints return `blockedByConsent`.
2. **Send time** — `drainSmsQueue()` re-reads consent for every `marketing` row; if consent is
   gone the row becomes `blocked` (+`blocked_reason`) and the provider is never called.
   Revoking consent also blocks what is already queued (`PATCH /customer/consent` returns
   `blockedQueuedSms`).

`do_not_contact` suppresses marketing only; security/transactional SMS is unaffected by it
(except shipment notifications, which respect `do_not_contact` as a stricter courtesy).

## 4. Reviews contract

* `POST /products/:id/reviews` → `201 {reviewId, status:'pending', verifiedPurchase}`.
  `verifiedPurchase` is **computed from a paid order line**, never from the request body.
* `POST /admin/reviews/:id/moderate` → `{id, status, rating}`; only `status`/`moderation_note`/
  `moderated_by`/`moderated_at` change. A database trigger rejects any change of `rating`,
  `verified_purchase`, `product_id` or `user_id` (`kolbe_customer_reviews_immutable`).
* Aggregation `productRatingSummary()` counts **approved** reviews only; `GET /products/:id/ratings`
  and `GET /admin/products/:id/review-analytics` are the same numbers.

## 5. Cart contract

* `GET /cart`, `POST /cart/items` (201), `PATCH|DELETE /cart/items/:itemId`, `POST /cart/merge`.
  Prices and availability are re-resolved server-side (`catalog.products.cash_price_rial`,
  `wms.stock_balances`); a stale `expectedUnitPriceRial` answers `409`.
* `cart.abandoned` is emitted **once** per cart: the sweep takes `FOR UPDATE`, flips
  `active → abandoned` and emits in the same transaction, so a repeated sweep emits nothing.
* `POST /orders` converts the active cart (`markCartConverted`) → `cart.converted`.

## 6. Recommendation contract

`GET /recommendations?slot=…&strategy=…&limit=…&sessionId=…` returns:

```json
{ "slot": "home.for_you", "strategy": "personalized", "items": [ { "id": "…", "cashPriceRial": "…",
  "availableStock": 3, "rating": 4.5, "position": 0 } ],
  "contextual": { "season": "autumn", "month": "September" },
  "sources": { "pricing": "catalog.products.cash_price_rial",
               "availability": "wms.stock_balances(on_hand - reserved - damaged)", "cached": false } }
```

* No recommendation table stores price or stock (`information_schema` is asserted in tests);
  `revenue_rial` on `recommendation_events` is realised order revenue, not a price cache.
* Availability is strict by default: an unsellable product is never published. A slot may opt
  into a sparse-catalogue fallback explicitly with `config.allowOutOfStockFallback = true`.
* Impressions are recorded server-side by the slot endpoint; clicks/ATC/purchase come from the
  client via `POST /recommendations/events` (privacy: user id when signed in, anonymous id
  otherwise).
* `GET /admin/recommendations/analytics?days=&slot=` → impressions, clicks, CTR, ATC, ATC rate,
  purchases, conversion, revenue per slot+strategy.

## 7. Customer/account contract (101–104)

`PATCH /customer/profile` accepts only `{displayName, firstName, lastName, birthday, gender, city}`.
Email/phone changes go through `POST /customer/profile/contact-change` (idempotency-key
required) → `email_link` or `sms_otp` (6 digits, 15 min, ≤5 attempts) →
`POST /customer/profile/contact-change/:id/confirm`. Security center: `GET /customer/security/sessions`,
`POST …/sessions/:id/revoke`, `POST …/sessions/revoke-others`, `POST …/password`,
`GET|POST /customer/security/2fa*`, `GET /customer/security/login-history`.
Recovery codes are single-use (removed from the stored hash list on first success) and are
returned **only once**, at `2fa/confirm`.

## 8. Admin console surface (frontend ⇄ backend)

| Admin tab | Component | Backend |
|---|---|---|
| `buyers360` | `src/components/buyer-360-panel.tsx` | `/admin/buyers*` |
| `crm-center` | `src/components/crm-center.tsx` | `/admin/crm/*` |
| `automation` | `src/components/automation-center.tsx` | `/admin/automation/*` |
| `tracking` | `src/components/tracking-center.tsx` | `/admin/shipments`, `/admin/tracking/*` |
| `reviews` | `src/components/reviews-center.tsx` | `/admin/reviews*` |
| `recs` | `src/components/recommendations-panel.tsx` | `/admin/recommendations/*` |
| `promo-safety` | `src/components/promo-safety-panel.tsx` | `/admin/promo/*` |
| account tab `security` | `src/components/security-center.tsx` | `/customer/profile`, `/customer/security/*` |
| storefront PDP | `src/components/product-social.tsx` | `/products/:id/media`, `/video/events`, `/products/:id/reviews`, `/recommendations*` |

## 9. Out of scope for this branch (do not extend here)

SEO, CMS, Finance, PIM, Import pipelines and the product-architecture work live on other
branches (`016`–`044`). This branch consumes their baseline (`001`–`015`) and must not add
files that overlap those domains.
