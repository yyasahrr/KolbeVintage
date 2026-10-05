# CMS production remediation — 2026-10-05

CURRENT_BRANCH: `arena/cms-production-final`  
START_SHA: `c89ff119c9ecc6f0b02a7310c5ffa5ef523ce7c0`  
END_SHA: `cedeb6d6040fcc264cd069a34aa0b4f669bf50ca` (tested implementation). The final handoff commit is its report-only child; use branch HEAD for the final delivered SHA. A report cannot embed its own commit hash without changing that hash.  
COMMITS_CREATED: `cedeb6d6040fcc264cd069a34aa0b4f669bf50ca` — `feat(cms): consolidate workspace and isolate draft publication`; one report-only child — `docs(cms): record production remediation evidence`.  
FILES_CHANGED: 35 files total: 34 implementation/test/build/screenshot files plus this report. See the manifest below.  
MIGRATIONS_CREATED: `backend/src/migrations/073_cms_draft_publication.sql`

## 1. Initial state

Fetched origin and verified the authorized branch and its remote both started at START_SHA. No checkout, merge, rebase, cherry-pick or write to main/Core branches occurred. All ten repository product documents were read before changes. The explicit owner's brief defines scope: CMS pages, editorial and global presentation content; canonical commerce, CRM, SEO and media ownership remain authoritative.

## 2. Existing uncommitted diff resolution

The only pre-existing dirty file was `src/portals/admin-cms.tsx`: a partial import refactor referring to three nonexistent modules while retaining the old Hero/Blocks implementation. Classification: PARTIAL_BROKEN_WORK. Completed the intended consolidation with real pages, journal and global-content modules. No unrelated user changes were discarded. Generated tracked Vite dependency files were restored after verification; the production single-file dist artifact is rebuilt intentionally.

## 3. Audit findings

Primary findings were frozen from source/route/data inspection before implementation; corrected behavior was then exercised against real PostgreSQL-compatible persisted data and the browser. Additional schema/consumer defects confirmed during verification were recorded, remediated and retested.

| Finding | Type / severity | Role, route and reproduction | Expected / observed initial evidence | Verification |
|---|---|---|---|---|
| Parallel CMS editors | ARCHITECTURE_DEFECT / high | Content operator, admin CMS; follow Hero/Blocks and studio surfaces | One workflow expected; admin-cms implemented a separate operational model alongside registry studio | One routed CmsCenter; normal navigation exposes four destinations |
| Editing changed live content | BUG / P0 | Editor, existing published page; edit content and fetch public page | Draft isolation expected; public loader read mutable cms_sections | Public API/HTML use immutable version snapshots; draft/public API assertions and browser failure injection |
| New setup auto-published | DOMAIN_DEFECT / P0 | Admin, bootstrap and starter templates | New content should be draft; CMS defaults/starter states used published | Bootstrap/template tests assert draft and public 404 until explicit publish |
| Editorial fallback claimed browser persistence | BUG / P0 | Operator, old ContentMediaCenter; fail editorial API | Server persistence required; localStorage fallback stored editorial data | Canonical Journal has no storage fallback; aborted browser request leaves editor open and retries to real API |
| Lost updates possible | BUG / high | Two editors, same page | Stale writes should fail; working-copy writes had no revision check | Optimistic revision/version conflicts return 409, including legacy writes invalidating canonical revision |
| Restore could affect live page | DOMAIN_DEFECT / high | Publisher, restore historical version | Restore only draft expected; mutable public loader exposed restored sections | Historical preview and restore leave publication snapshot unchanged |
| Bootstrap payload invalid for registry | BUG / high | Admin, bootstrap then explicit publish | Schema-valid CTA required; legacy CTA seed omitted required title | Canonical seed fields corrected; contract/bootstrap/publish tests pass |
| Media/editorial/product ownership mixed | ARCHITECTURE_DEFECT / high | Operator, content-media destination | Independent Media Center and Journal expected; editor combined domains | Media Center uses canonical cms_assets/files; Journal moved inside CMS; no product writes |

## 4. Capability classification

| Capability | Classification | Owner / action |
|---|---|---|
| Registry, schemas, sections, variants and presets | KEEP / MERGE | Reused existing registry and FieldInput; no second section schema |
| Page list, templates, draft editor, preview, history | MERGE | Canonical Pages and centered PageWorkspace |
| Editorial articles/video | MOVE / MERGE | Canonical CMS Journal; existing editorial_posts APIs |
| Header, footer, announcements | KEEP / MERGE | Global Site Content using existing layout/announcement APIs |
| Assets/files | MOVE | Independent Media Center; shared reference picker |
| Hero/Blocks quick editor | REMOVE from normal UX | Replaced by registry sections in PageWorkspace |
| Old CmsStudio/CmsPanel | ADVANCED_ONLY / unrouted | Code retained for compatibility, no normal admin entry |
| Component registry/debug/technical payload surfaces | ADVANCED_ONLY | Backend capabilities and permissions retained |
| SEO, CRM, commerce, reviews, promotion operations | HOLD | Canonical external owners; read-only references, no operational redesign |

## 5. Final canonical IA

`CmsCenter` has exactly Overview, Pages, Journal, Global Site Content. Overview shows real counts, recent edits, upcoming publication starts, empty/bootstrap states and shortcuts. Pages and Journal are bounded, paginated server lists with search. There is one normal section-editing destination per page.

## 6. KEEP / MERGE / MOVE / REMOVE / ADVANCED_ONLY

The table above is the disposition ledger. Removal means normal-route removal rather than deleting backend contracts. No capability-bearing domain tables were dropped. Media management remains an independent admin destination, while its picker is shared. No normal operator enters component codes, UUIDs or payload JSON.

## 7. Page Workspace architecture

Reuses existing centered WorkspaceModal and focus management. Desktop has section list, actual storefront renderer iframe and selected-section properties; tablets use contextual panels; phones use Sections/Properties/Preview tabs. Registry fields, targets, media controls, theme/style presets and section variants reuse the existing schema and pickers. Persian labels replace technical option values. Loading, empty, retry and picker failures are visible. Selected references remain actual canonical IDs internally.

## 8. Draft / Preview / Publish lifecycle

cms_pages/cms_sections are the working copy. cms_page_versions freezes title, path, description, active state, section data and publication windows. Public reads select the newest eligible publication, never mutable draft content. A future publication retains the previous eligible snapshot until start; an expired latest eligible snapshot hides the page without resurrecting an older one. Archive removes the page from public reads; restore from archive goes to draft. Explicit Publish checks saved revision and readiness, then records an audited snapshot atomically. SEO public-page subject metadata is derived from the frozen snapshot while canonical SEO overrides remain owned by SEO.

## 9. Autosave behavior

Debounced 750 ms server-backed PUT with expectedRevision, one in-flight write and edit-generation tracking. Older acknowledgements cannot replace newer local edits. Successful writes advance revision; failed/stale writes retain unsaved content and show retry or server reload/discard. Publish is disabled during pending, failed or conflicting save. Close is guarded when unsaved/in flight; beforeunload protects navigation. No browser storage pretends a draft is saved.

## 10. Publish readiness

Checks saved revision, path validity, duplicate draft/live paths, active components, canonical field/style/responsive schemas and referenced product/collection/campaign/page/internal file existence, product publication, collection/campaign activity and destination-page live availability. Errors block publication; empty visible content is an explicit warning. Publication uses a transaction, row lock and shared advisory lock for live-path conflict serialization. External URL availability is not claimed or network-probed.

## 11. Publish Diff

Human Persian differences cover page title/path, added/removed sections, order, visibility, field content and appearance. First publication is labeled explicitly. No raw payload JSON is displayed as the normal diff. Schedule start/end and change summary are confirmed separately.

## 12. Version/Restore

Versions retain publication metadata and section snapshots. Historical preview uses renderer enrichment without writes. Restore locks the page and restores the working copy, increments draft revision and preserves live publication. Publish remains a separate action. Duplicate requires a new path and creates new page/section identities without versions, schedule, SEO entry or analytics history.

## 13. Journal architecture

One Persian Journal inside CMS for article/video list, server search/status filters, create/edit, cover picker, source/body/excerpt/author/category/tags, save draft, explicit publish, archive and restore. Dates/status are read from real persisted records. Existing SEO and related-product reference fields are preserved instead of creating an overlapping owner/editor.

## 14. Editorial persistence

Existing editorial_posts remains canonical. published_snapshot and publication_enabled freeze published content across draft saves; editorial_live exposes the frozen record. Public APIs, storefront HTML and journal sitemap/crawl consumers use that view. Archive disables publication; restoring to draft stays unpublished. expectedVersion rejects stale updates. Transactional API readiness and the publication trigger serialize Journal slug reservations and rejects collisions with another frozen live slug, including after that article changes its draft slug. Editorial create/update and publication state changes have transactional audit events. Failed requests do not close the editor or show saved success; retry writes to PostgreSQL.

## 15. Global Site Content

Header branding/menu/CTA, footer brand/contact/link fields and announcement message/target/window controls use existing APIs. Save and Apply clearly performs an immediate global update. Existing unedited menu/footer/announcement fields are preserved. Announcement editor modifies its first message and preserves any additional messages and technical mode/style settings.

## 16. Media boundary

Independent Media Center uses canonical cms_assets and uploaded files; no parallel editorial or commerce asset database was created. Section/cover pickers reuse media APIs. Asset deletion considers draft references, all historical/publication snapshots and editorial cover snapshots; referenced files remain protected. Other asset backend contracts are retained for compatibility.

## 17. SEO boundary

No SEO Center redesign or second SEO store. Published page metadata and editorial public consumers were corrected to avoid draft leakage. Existing canonical SEO overrides and aliases remain effective. The legacy public SEO resolver and CMS sitemap projection also read eligible frozen metadata; admin SEO subjects continue to expose their existing working-copy workflow.

## 18. CRM boundary

No CRM operations changed. Lead/form configuration stays content; canonical submissions and lead ownership remain existing CRM. Existing CRM browser smoke and API contracts remain regression checks.

## 19. Product/Core boundary

No product/pricing/inventory/order/WMS/settlement algorithms or migrations changed. References use existing canonical records. Shared app route registration, CMS fixture in seed-local, existing SEO/editorial consumers and CMS tests are the only integration edits. No Core branch operations occurred.

## 20. Legacy compatibility retained

Legacy backend page/section/layout/media/registry endpoints and schemas remain available. Their mutations trigger working-copy revision changes so canonical editors detect concurrent writes. Old frontend studio/panel files remain unrouted. Legacy callers may omit new optional publication/editorial concurrency tokens; canonical UI always supplies them. Technical features not promoted to normal UI were not destructively removed.

## 21. Migrations

073 is additive and ordered after 072. Adds page draft revisions, snapshot metadata, revision triggers and editorial frozen-publication fields/view/trigger. Backfills existing eligible published pages lacking any publication history with one frozen snapshot, preserving their current live content. Existing historical versions receive available page metadata; historical metadata that was never captured cannot be reconstructed. No business-row deletion. All 54 migrations applied successfully on a fresh embedded PostgreSQL instance; a repeated runner was a no-op. This does not claim a production database was migrated or deployed.

## 22. Tests executed

Frontend build and TypeScript; backend build; full embedded backend tests; focused CMS test command; frontend-contract API smoke; real Chrome/Puppeteer admin/browser smoke using isolated embedded PostgreSQL and real Vite/API processes. Browser assertions compare UI actions against saved draft/public API responses and inject genuine failed network requests.

## 23. Exact test counts

Final backend: 214 tests / 21 suites, 214 passed, zero failed/cancelled/skipped, 176118.5319 ms. Focused CMS: 52 tests / 8 suites, 52 passed, zero failed/cancelled/skipped, 22024.6634 ms. The new production suite includes 14 persisted integration journeys plus its parent and the human-diff unit test. Frontend API contracts: 110/110 passed. Final Chrome browser: 179/179 passed; all 25 console sections rendered, no unhandled page errors or banned/standalone English chrome labels. Initial baseline full backend run: 198 tests, 21 suites, 198 passed, zero failed/skipped. A parallel final run hit authentication Memory allocation error before unrelated contracts setup; 200 passed and 14 cancelled. Browser parallel retry also hit that login allocation error. These suites were subsequently rerun sequentially; only those final results determine readiness. A subsequent browser run exposed a test-harness issue: its new-document initialization cleared the shared session in every preview iframe. Initialization is now restricted to the top-level window; actual application authentication was unchanged. Focus tests now focus the opener and account for keyboard focus inside the preview iframe. A full intermediate browser run passed 176/179 checks; its three remaining assertions referenced removed Hero/Palette controls and the old Media navigation label. Those assertions now validate canonical Pages, the retained advanced palette API and Media Center.

## 24. Responsive/browser UAT

Viewport widths 360, 390, 768, 1024, 1280, 1440. Tests measure document/dialog/content bounds for all page panels and publication checklist, plus Journal/global views. Keyboard forward/reverse focus trap, Escape/focus restoration, version preview/restore, autosave/error/retry/concurrency, explicit page and editorial publication, global header persistence and no editorial localStorage fallback are asserted. Workspace screenshots captured at each width and preserved under [cms-uat](cms-uat/); 360 px and 1440 px output were visually inspected.

## 25. Known limitations

External media/target URLs are validated syntactically rather than fetched for availability. Pickers reuse existing bounded canonical endpoints (up to 200 assets/100 product records/default bounded pages), so very large catalogs need existing owner tools or future searchable picker pagination. Announcement simple editor exposes the first message and preserves others. Journal exposes immediate publication and existing dates; no new editorial scheduling/version-history engine. Existing optional legacy concurrency contracts remain backward compatible. Historical pre-migration page metadata cannot be recovered beyond available current metadata. No load benchmark or real production database upgrade was executed. Old unrouted code is retained deliberately.

## 26. Environment blockers

Parallel embedded databases and argon2 login caused Memory allocation error on this Windows host. Final suites are executed sequentially. There are no unresolved environment blockers. No production credentials or deployment are required for the authorized implementation/commit/push scope.

## 27. P0 blockers

The discovered auto-publish and fake editorial persistence defects are corrected and regression-covered. No P0 CMS blockers remain in the tested implementation; no unrelated product decision was inferred.

## 28. Production readiness conclusion

The authorized CMS implementation passes final build, typecheck, backend, CMS, contract and browser verification. Ready refers to the tested branch implementation, not an assertion that production was deployed. PostgreSQL owns drafts/publications/editorial/global content; other domains retain their canonical ownership.

## Completion evidence

| Check | Command / evidence | Final result |
|---|---|---|
| Frontend production | `npm run build` | PASS; dist/index.html 2,191.09 kB, gzip 543.74 kB |
| Frontend TypeScript | `npx tsc --noEmit` | PASS, exit 0 |
| Backend TypeScript | `npm run build --prefix backend` | PASS, exit 0 |
| Full backend | `PGLITE_PORT=55582 npm run test:embedded --prefix backend` | 214/214, 21 suites, no failures/cancellations/skips |
| Focused CMS | `CMS_TEST_ONLY=1 PGLITE_PORT=55582 npm run test:embedded --prefix backend` | 52/52, 8 suites, no failures/cancellations/skips |
| API/frontend contracts | `npm run test:contract --prefix backend` | 110/110 |
| Browser | `KV_CHROME_PATH=<installed Chrome> npm run test:browser --prefix backend` | 179/179; 25 console sections; six responsive widths |
| Migration safety | Embedded runner | 54 fresh migrations; second run no-op |
| Diff integrity | `git diff --check`, `git diff --cached --check` | PASS |
| Core branch boundary | Current branch + remote ref verified | Only arena/cms-production-final written |

Final local logs: cms-embedded-final.log, cms-focused-final.log, cms-contract-final.log, cms-browser-final.log, cms-frontend-build-final.log, cms-typecheck-final.log, cms-backend-build-final.log. These ignored runtime logs are not shipped; reproducible tests and six screenshots are committed. No production database migration or website deployment was performed. Push targets only origin/arena/cms-production-final; the final response records the resulting remote-verified HEAD.

## Implementation manifest

- `backend/package.json`
- `backend/scripts/browser-admin-smoke.mjs`
- `backend/scripts/cms-production-browser.mjs`
- `backend/scripts/frontend-contract-smoke.ts`
- `backend/scripts/run-embedded-tests.mjs`
- `backend/src/app.ts`
- `backend/src/cms-production.test.ts`
- `backend/src/cms-starter.ts`
- `backend/src/cms-studio.ts`
- `backend/src/cms-workspace.ts`
- `backend/src/cms.test.ts`
- `backend/src/cms.ts`
- `backend/src/experience.test.ts`
- `backend/src/migrations/073_cms_draft_publication.sql`
- `backend/src/seed-local.ts`
- `backend/src/seo.ts`
- `backend/src/storefront-html.ts`
- `dist/index.html`
- `docs/parallel/cms-production-final-report.md`
- `docs/parallel/cms-uat/cms-workspace-1024.png`
- `docs/parallel/cms-uat/cms-workspace-1280.png`
- `docs/parallel/cms-uat/cms-workspace-1440.png`
- `docs/parallel/cms-uat/cms-workspace-360.png`
- `docs/parallel/cms-uat/cms-workspace-390.png`
- `docs/parallel/cms-uat/cms-workspace-768.png`
- `src/data/experience-api.ts`
- `src/portals/admin-cms.tsx`
- `src/portals/admin-section-editor.tsx`
- `src/portals/admin.tsx`
- `src/portals/cms-api.ts`
- `src/portals/cms-global-content.tsx`
- `src/portals/cms-journal.tsx`
- `src/portals/cms-page-workspace.tsx`
- `src/portals/cms-pages.tsx`
- `src/portals/content-media.tsx`
