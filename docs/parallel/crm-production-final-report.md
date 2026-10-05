# CRM production final verification — 2026-10-05

## Git and scope

- CURRENT_BRANCH: `arena/crm-production-final`
- START_SHA: `0c4aa9927d7a5c4c97ad38c0c827132dacbef544`
- END_SHA (tested implementation): `f31b60725c1c440fb16dd0afb40bd34b6c3d6def`.
- Handoff report commit: documentation-only child of the tested implementation; its exact SHA is printed in the final handoff. A committed file cannot contain its own Git commit hash.
- Initial working tree was clean. No merge, force push, history rewrite, branch deletion, production database migration, or live-provider campaign was performed.
- Product Lifecycle, Pricing, Wholesale OMS, WMS, Supplier Fulfillment, Inbound/QC, Shipment, and Discount/Festival business implementations are unchanged. Shared `WorkspaceModal` now renders through a body portal to escape transformed ancestors; this presentation change also applies to existing workspace consumers.
- All ten `docs/product/` references were read before editing. Domain rules and source-of-truth ownership were used ahead of current code behavior. No business-knowledge documents or product rules were changed.

## Canonical IA

1. نمای کلی: persisted relationship KPIs, search, lead creation, canonical action queue.
2. مخاطبان: همه, مشتریان خرده, خریداران VIP, تأمین‌کنندگان. Entity 360s open the same relationship composer.
3. پیگیری‌ها: all/open, overdue, Tehran calendar today, upcoming, unassigned, mine, done; owner filter and paging.
4. بازاریابی: labels, rules, dynamic segments, campaign preview/send, consent-aware audiences, existing event surfaces.

Existing admin navigation aliases continue through the existing `go`/hub routing. There is one operational interaction/note/task composer; entity views retain contextual read-only history.

## Source-of-truth ownership

| State | Canonical owner | CRM use / authorized write |
| --- | --- | --- |
| Account identity, role, phone/email | users and existing account APIs | Search/read; lead link references the existing user, never creates a parallel account |
| Standalone lead, owner, lifecycle, priority | crm_contacts | Relationship APIs, permission checked and audited |
| Follow-up | crm_tasks | Create, assign, reschedule, complete, reopen/cancel; contact.next_followup_at is a derived minimum of dated open tasks |
| Real contact interaction | crm_interactions | Transactional interaction and optional task creation |
| Internal notes | crm_notes | Shared composer; legacy note history remains readable |
| Label definition / assignment | crm_labels / crm_contact_labels | Active catalog titles and canonical assignments; no new tags-array system |
| Segments / membership | crm_segments / crm_segment_members | Existing canonical definition/refresh engine, paginated membership reads |
| Consent and marketing suppression | customer_consents, existing campaign and SMS delivery services | Marketing fields only from marketing toggles; no implicit transactional opt-out |
| Human relationship timeline | customer_timeline projection | Meaningful interaction/task/label events, linked history projection, no raw audit dumps |
| Technical audit | audit_logs | Existing audited writes; not used as the relationship timeline |
| Orders, memberships, finance, cashback, stock/QC | Respective Core domains | Existing read models and module navigation; no duplicate finance/WMS/membership engine |

## Confirmed defects, remediation and evidence

Domain: CRM relationship layer. Actor: authenticated admin with crm:manage unless stated otherwise. Environment: disposable seeded/migrated PostgreSQL-compatible PGlite stack, real Fastify API and frontend client/browser. No production customer records were touched.

| Finding / severity / confidence | Reproduction and actual result before fix | Expected rule and remediation | Verification |
| --- | --- | --- | --- |
| Lead follow-up was only a hint / P1 / high | Create a dated lead; tasks length was 0 | A next action must remain actionable; create task atomically and derive the hint | New lead-date integration test, frontend contract and browser persisted ISO date check |
| Earliest follow-up hidden / P1 / high | Add later interaction follow-up after an earlier task; hint became later | Earliest open dated task wins; recalculate under contact lock after writes/status changes | Later/historical interaction integration assertions, completion/reopen/cancel tests |
| Duplicate identity missed / P1 / high | Same Iranian phone with +98/Persian digits returned 201; existing user without contact was ignored | Normalize comparison identity, include all canonical users, serialize lead checks inside retried serializable transaction | International/Persian digit and existing-user duplicate tests now return 409 |
| Invalid relationship owner / P2 / high | Owner was accepted without active CRM-manager validation | Assignment uses existing permissions; validate active authorized account | Valid owner persists, unknown owner 400, audit row asserted |
| Merge timeline incomplete / P2 / high | Standalone interactions were not projected to newly linked user | Preserve canonical children and project meaningful linked history without duplicate refs | Merge verifies notes/tasks/interactions/labels/legacy activity rows and target timeline |
| VIP label payload mismatch / P1 / high | Client sent labelCode but existing server expects labels array | Correct client wire contract and choose human-readable active catalog labels | Real client addLabel persists canonical assignment |
| Note visibility mismatch / P2 / high | Client exposed support visibility while server accepts internal/team | Use existing canonical visibility, shared notes writer | Real client team-note contract persists |
| Consent collision / P1 / high | Absent consent UI could submit transactionalSms=false with a marketing toggle | Marketing intent must not silently suppress transactional messages | Client sends only requested marketing fields; contract asserts transactional consent remains true |
| Duplicate activity writers / P2 / high | Legacy activity POST could create another note/contact-event store | Existing legacy reads remain; reject new note/call/sms/email activity writes with canonical guidance | Route inspection and full regression suite; existing history is preserved |
| Supplier history used audit actions / P2 / high | Raw supplier action strings shown as relationship events | Read customer_timeline projection, use Persian status labels and retry/error states | Supplier 360 browser context, no operational/audit dump assertions |
| Workspace obscured by admin header / P3 / high | Screenshot showed modal clipped inside transformed page parent | Centered accessible workspace independent of parent transform | Body portal; final screenshots show visible header/close and centered bounds |
| Technical/default English labels / P3 / high | Document, membership, source, priority and native datetime values visible | Shared Persian dictionaries, safe fallbacks, existing Jalali picker with time | Render/typecheck; relationship enum/UUID check and six responsive widths |
| Mutation re-entry / P2 / high | Buttons could submit multiple times; review found busy guard lacked reset | Immediate ref guard, progress/disabled state, finally reset; explicit bulk-send confirmation | Diff review, builds and repeated real UI writes |

## Canonical wiring and legacy paths

- Notes remain in crm_notes. Entity 360 note tabs are read surfaces and links to the shared composer, not second writers.
- `crm_activities` historical records remain intact. Legacy note/call/sms/email writes now fail with Persian canonical-location guidance. Other historical system activity types remain compatible.
- `crm_contacts.tags` and legacy segment PATCH writes are rejected. Existing data is retained; canonical catalog assignments and segments are used.
- Existing `crm_automations` API/worker is retained for compatibility and has no new competing primary CRM screen. It is not fully migrated or made globally read-only in this change. Its API-only status is explicit below.
- Existing VIP compatibility label/note endpoints use the same canonical tables. The client contract is corrected; operator notes use the shared composer.
- Retail shortcuts navigate to orders/cashback; VIP to plans/finance; supplier to orders/WMS/finance through actual existing admin `go`. These are module-level routes, not invented order-specific selectors. Precise item selection remains dependent on Core route support.
- VIP CRM has no membership payment/refund/suspension/credit mutation controls. Supplier CRM has no receipt, QC decision or settlement posting controls. Existing account/document controls and unique supplier change-request review are retained.

## Migration safety

New: `backend/src/migrations/072_crm_followup_projection.sql`.

- Additive recovery: creates a canonical dated task for a legacy contact hint only if that contact has no dated open task.
- Recomputes contact hint as min(open task due_at). No Core tables, drop, truncate, or customer-history deletion.
- Existing 071 was already on the branch and is not a new migration in this implementation. Embedded runner's expected list was stale; it now includes 071 and 072.
- Fresh migration run: 53 versions. Immediate second run: unchanged migration versions/timestamps and no duplicate migration application, verified by existing runner.
- Verification applied only to disposable test databases. No production/staging migration was applied.

## Executed gates and exact results

Clean verification checkout: `D:/1/Project-folders/KolbeVintage-crm-verification-20261005`, cloned without hardlinks on the same starting branch, then populated with the implementation files. Root and backend `npm ci` both completed successfully. Tracked root node_modules/dist/package-lock were restored after initial local EPERM; no dependency/generated-artifact changes are included in the handoff.

| Command | Final evidence | Result |
| --- | --- | --- |
| root npm run build | crm-root-build-handoff.log | PASS |
| root npx tsc --noEmit | crm-typecheck-handoff.log | PASS, zero diagnostics |
| backend npm run build | crm-backend-build-final.log | PASS |
| backend npm run test:embedded | backend/crm-tests-serial.log | 198 passed, 0 failed, 0 skipped, 0 cancelled; 21 suites |
| backend npm run test:contract | backend/crm-contract-retry.log | 110/110 passed, 0 failed |
| backend npm run test:browser with KV_CHROME_PATH pointing to installed Chrome | backend/crm-browser-handoff.log | 125/125 passed, 0 failed |
| git diff --check | final working diff | PASS |

Browser exercises actual UI → API → persisted state for lead/task/interaction/note, Jalali due date, entity 360 contexts and shared composer, segment membership criteria, Escape/focus behavior, and workspace widths 360/390/768/1024/1280/1440. It additionally walks the existing console and existing warehouse/pricing regression scenarios. Screenshots and API-call/report JSON are in `%TEMP%/kolbe-admin-smoke/`; logs remain in the local verification checkout and are not committed.

Final source-file hash comparison found no differences between the verification checkout and implementation files. The last frontend-only copy refinement translated a remaining rule-preview toast; root build/typecheck were rerun after it. Backend implementation files remained unchanged after the serial backend/contract gates.

Backend evidence includes anonymous 401 and ordinary customer 403, owner audit, query bounds/nonmutating search, task transitions/projection, canonical merge preservation, retail/VIP/supplier read models, campaign dry-run eligibility, consented send, subsequent frequency-cap exclusion, and persisted marketing delivery categories. Campaign delivery is tested against the isolated architecture, not a live SMS provider.

### Failed runs retained in the assessment

- Initial added invariant checks reproduced task-count 0, overwritten earliest follow-up and duplicate-phone 201 before remediation. An incomplete test-user password_hash fixture was also corrected.
- Original embedded runner rejected existing 071 because its migration expectation omitted it. This was a test-runner mismatch, now fixed.
- Concurrent isolated suites: 196/198 backend tests passed, 2 failed with resource/memory allocation and SEO integration failure; frontend contract attempt stopped at 88/89 with login 500; browser attempt 112/113 hit insufficient Chromium resources. Serial reruns passed. These runs are not counted as successful gates.
- Initial local browser 97/99 had CMS palette/sidebar HMR failures. A later serial run 66/69 included premature Retail modal assertion, VIP read-text false positive, and a warehouse receive wait timeout. The next run reached 121/122, with only the premature Retail assertion remaining. Selectors now wait for actual modal content and inspect mutation buttons for VIP. A subsequent unchanged-snapshot run passed 122/122 before the final Jalali picker and error-state refinements. The next run passed 123/123, including the persisted Jalali input; the final run passed 125/125 and additionally exercises task reassignment and closed-task reopening controls.
- Initial install attempts hit EPERM on native binaries already in use; a clean checkout install succeeded. One concurrent root build hit UNKNOWN copying a public cutout; serial build passed.
- The first body-portal edit missed its container argument; typecheck caught it before commit, the argument was corrected, and subsequent typechecks passed.

No failed assertion was removed or marked skipped to obtain a green gate; the modal and VIP assertions were corrected to test their stated behavior.

## Capability assessment

VERIFIED below means only the stated scenario/evidence, not every possible customer dataset or external provider behavior. FULLY_CONNECTED means inspected real UI/API/canonical wiring without exhaustive browser coverage of every control.

| Capability | Status | Evidence / boundary |
| --- | --- | --- |
| Canonical IA and all contacts | FULLY_CONNECTED | Existing hub routing, canonical search-backed contacts, offset pages |
| Relationship KPIs/action center | VERIFIED | Integration reads and browser overview; canonical open tasks |
| Global relationship search | VERIFIED | Standalone/client search, duplicate platform identities, nonmutating GET, bounds |
| Lead create and duplicate protection | VERIFIED | Real browser lead, API normalized duplicate rejection |
| Lead link/merge | VERIFIED | Integration canonical child preservation and timeline projection; linking UI inspected |
| Owner/lifecycle/priority | FULLY_CONNECTED | Shared composer and persisted APIs; owner validation/audit integration verified |
| Task create/transitions | VERIFIED | UI create/persist/reassign/done/reopen/cancel; API reschedule and minimum projection |
| Task filters/paging | FULLY_CONNECTED | Existing queue bound, owner filter, mine/done, UI pages; overdue integration |
| Interactions | VERIFIED | UI/API/persist; historical/next-action invariant and linked timeline |
| Notes | VERIFIED | UI/persist and client team visibility; one canonical operational composer |
| Human timeline | VERIFIED | Merge projection integration; entity views use readable events; bounded history |
| Retail 360 | VERIFIED | Seeded customer purchase context, centered workspace, shared composer; individual tab controls are connected |
| VIP 360 | VERIFIED | Seeded membership context, shared composer and absence of Core membership mutation buttons |
| Supplier CRM 360 | VERIFIED | Seeded performance context, shared composer, no WMS/QC/settlement/audit dump |
| Labels | VERIFIED | Canonical assignment through actual client and merge; catalog/rule title wiring inspected |
| Segments and member workspace | VERIFIED | Real client refresh/members and browser Persian criteria/metrics; pagination connected |
| Marketing consent isolation | VERIFIED | Real client marketing update preserves transactional consent |
| Campaign preview/cap/send | VERIFIED | Backend real preview/send/delivery/cap integration; UI confirmation wired; no live provider delivery |
| Label-rule forms/events | FULLY_CONNECTED | Existing canonical engine and Persian input wiring, no exhaustive browser rule-authoring flow |
| Core module navigation | FULLY_CONNECTED | Actual existing go routes; not item-specific deep-link validation |
| Responsive relationship workspace | VERIFIED | Six exact widths, bounds/action presence and visual screenshots; not every entity tab at every width |
| Permissions/audit | VERIFIED | Server 401/403 and owner audit checks; not every custom production role combination |
| Legacy automations | BACKEND_ONLY | Compatibility API/worker retained, not a new operator UI |

## Known limitations and rollout boundary

- Dossier tasks/interactions/notes are bounded to 100 and timeline reads to existing limits; there is no full historical paging/export in these 360 dossiers. Contacts/queue/segment member pages are bounded/paginated.
- Module links do not promise item-specific Core selection. Existing Core pages own their mutation flows.
- Dynamic segment membership reasons describe the stored definition at read time; membership is refreshed by the existing engine, not continuously recalculated per rendered row.
- Legacy automation compatibility still exists. This handoff does not claim all legacy backend endpoints have been removed.
- Testing used isolated PGlite and seeded data on Windows Chrome. Production PostgreSQL deployment, large-volume latency/load plans, live SMS delivery and every custom permission combination were not exercised.
- Current UI mappings and tested workspaces avoid raw IDs/enums; historical free-text stored by previous versions is retained and was not rewritten or globally scrubbed.
- Native dependency locks were worked around using the disposable checkout; no unrelated user's processes were terminated.

P0_BLOCKERS: none confirmed. PRODUCTION_READY_CRM: YES for the implemented relationship layer under the completed isolated build/data/API/browser gate, with the known limitations above. This is not a claim that live-provider delivery, production deployment or large-volume load validation was performed. Normal push to the same branch is authorized; its final remote SHA and success/failure are recorded in the final handoff.

## Changed files

- backend/scripts/browser-admin-smoke.mjs
- backend/scripts/crm-relationship-browser.mjs (new)
- backend/scripts/frontend-contract-smoke.ts
- backend/scripts/run-embedded-tests.mjs
- backend/src/crm-intelligence.ts
- backend/src/crm-relationship.test.ts
- backend/src/crm-relationship.ts
- backend/src/crm.ts
- backend/src/migrations/072_crm_followup_projection.sql (new)
- src/components/buyer-360-panel.tsx
- src/components/crm-center.tsx
- src/components/crm-relationship-center.tsx
- src/components/crm-retail-panel.tsx
- src/components/primitives.tsx
- src/components/supplier-crm-workspace.tsx
- src/data/api.ts
- src/data/fa-labels.ts
- src/portals/admin.tsx
- docs/parallel/crm-production-final-report.md
