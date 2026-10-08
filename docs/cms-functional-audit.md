# CMS Functional Audit — Editor → Draft → Publication → Storefront

Status legend: **PASS** (automated evidence in this repo) · **FAIL** (broken, documented below) · **UNVERIFIED** (needs a real browser; exact commands supplied) · **SKIPPED** (out of scope this round).

Date: 2026-10-08 · Branch: `arena/a2909e7e-kolbevintage`

---

## A. Root causes (Phase 1 — trace of editor → draft → API → PostgreSQL → published snapshot → public API → storefront renderer)

The publication pipeline itself was sound end-to-end:

```
CMS Studio (cms-page-workspace.tsx) → studioApi (draft PUT, optimistic revision)
  → POST /admin/cms/pages/:id/publish → cms_page_versions (immutable sections_snapshot)
  → GET /api/v1/site/pages/:code (loadPublicPage: draft/archived→404, active snapshot, visible-only, enriched)
  → CmsPageView (/page/:code) + studio preview iframe
```

Three disconnections made the storefront ignore it:

1. **Homepage never consumed the published snapshot (FAIL → fixed).** `retail.tsx` HOME was hardcoded from `ops` (EditorialHero `ops.hero`, CategoryRail, latest-drop grid, `ops.blocks` BlockRenderer, hardcoded story/featured). `ops` comes from `GET /admin/cms/pages`, which needs `cms:read`; every guest got 401 → `.catch(() => null)` → the SEED fallback forever. The published snapshots were served by `/api/v1/site/pages/home` whose only consumers were `/page/:code` and the preview iframe.
2. **Announcement bar ignored the CMS announcement system (FAIL → fixed).** `App.tsx` rendered the legacy `AnnouncementBar(ops.blocks)` even though `ServerAnnouncementBar` (site-chrome) — which renders `/api/v1/site/layout` announcements with bindings, countdown, dismiss — existed unused.
3. **Footer ignored the CMS footer (FAIL → fixed).** `App.tsx` rendered the static `StorefrontFooter` while `ServerFooter` (layout `global_footer`) existed unused.

Already server-driven (no change needed): header menus (`layout.header.menus` with local fallback) and theme tokens (`useThemeTokens`).

Additional findings fixed this round:

4. **Registry variants were advertised but unread (Phase 3).** 21 components × ~70 options in migration 035; the renderer (`CmsSection`) ignored `section.variant` for countdown, product grids, category cards, banners, installment, brand strip, reviews (summary/editorial rendered *nothing*), recommendation, text, lead form, story hero, timeline, values, stats, spacer, divider. Only the hero trio already mapped variants into `CmsHero` templates.
5. **`muted` section theme is a dead branch.** The frontend `CmsSection` styles `section_theme === "muted"` but the backend schema accepts only `inherit|light|dark|campaign` — the value can never be saved. Left in place (harmless), documented here as dead code to remove in a future cleanup.
6. **Demo mode was unlabeled (Phase 2.3).** `?demo` switched the entire app to seeded sample data with no visual distinction from live data.

## B. Fixed features (what works now, per the Definition of Done)

**Homepage = published CMS `home` snapshot** (siteApi.page("home") → App → RetailPortal):

- Hero: the accepted full-bleed `EditorialHero` keeps its identity; its *content* (eyebrow, title, subtitle, image, video, poster, overlay, CTAs, slides, alignment) is the published hero payload (`home-cms.tsx` adapter). Honest template mapping, documented in code: carousel renders the accepted slider; video renders the accepted video hero; everything else renders the accepted static frame. The 12-template `CmsHero` remains the renderer of dedicated CMS landing pages — the two never mix on the homepage.
- Body: every published non-hero section renders **in published order**, honoring visibility, variant, theme, and style overrides (padding/background/width/radius/border/animation + hide-per-breakpoint), either as a storefront band (product sliders/grids with the accepted `StorefrontProductCard` incl. wishlist, try-on, quick-add, add-to-style; category rails) or through the shared `CmsSection` preview components. **Preview and storefront share one renderer by construction.**
- Product bands resolve real catalogue products: explicit `productIds`/`productCodes` → catalogue by id; else server-resolved (`enrichSections`) products; else the accepted local fallback. No mock data.
- Fallback: when nothing is published (fresh install, demo, offline) the accepted local composition renders — never a blank page. **No double render:** with a published page, the legacy ops bands, story and featured blocks are not rendered (verified by DOM assertions on leaked copy).
- Announcements: `/site/layout` announcements own the bar (static/marquee/ticker/slider/rotating + bindings); the legacy ops bar is the fallback only when no server announcement exists.
- Footer: `ServerFooter` owns it when `global_footer` is configured; the accepted static footer remains the fallback.
- Demo labeling: `?demo` shows a persistent «حالت نمایشی · داده‌های نمونه» badge and never fetches or renders live CMS content (verified).
- Quick add from CMS commerce cards and homepage bands shares ONE rule with the `/page` route (first available variant, merge identical lines).

Per-control DoD: edit → editor state → server save (optimistic revision) → survives reload → draft preview → publish visible on `/` → survives public refresh → responsive attrs → no regressions elsewhere. The server-side chain and the storefront render/reload are proven by the E2E (§D/§E). The **interactive editor steps in a real browser are UNVERIFIED** (§F).

## C. Variant matrix (Phase 3) — every registry option now renders, or is an explicit preset

Implemented in `src/components/cms-blocks.tsx` (`section.variant`; explicit payload fields always win). Verified per-option with real rendering diffs in `.smoke/cms-variants.mjs` (56/56):

| Component | Registry variants | Behavior now |
|---|---|---|
| hero | split, fullbleed, video, carousel, minimal, mosaic, editorial, cinematic | variant → `CmsHero` template (pre-existing, still PASS) |
| video_hero | default, cinematic, split | → cinematic / split / video template (PASS) |
| image_hero | default, editorial, minimal | → editorial / minimal / static template (PASS) |
| countdown | banner, minimal, dark, floating, glass, compact | presets: split+terra / light+sm / dark / glass blur / navy+xl / no-seconds (PASS) |
| product_grid | default, editorial, compact, luxury | 4-col / 3-col+editorial card / 5-col / 3-col+premium card (PASS) |
| product_carousel | default, editorial, minimal | card preset / editorial / 5-col dense, no header action (PASS) |
| product_card | default, sale, new, premium, editorial, wholesale | section variant → default card template (payload wins) (PASS) |
| category_card | image, editorial, minimal, glass, overlay, horizontal | variant → card template (`payload.template` wins); horizontal → 2 cols (PASS) |
| promotion_banner | default, dark, terra, split | navy overlay / #0B0F17 / #A34E2E / side-panel split layout (PASS) |
| installment_card | snapppay, digipay, generic | default provider filter (`payload.provider` wins) (PASS) |
| brand_strip | default, minimal, marquee | framed / frameless / `.kv-marquee` moving rail (PASS) |
| review_section | default, summary, editorial | cards / rating-summary-only / serif quote list — **summary/editorial previously rendered nothing** (PASS) |
| recommendation_section | default, minimal, dark | heading+grid / grid-only / dark panel (PASS) |
| text_section | default, centered, editorial | framed card / centered / frameless serif with accent rule (PASS) |
| lead_form | default, split, compact | 2-col / asymmetric split / narrow single card (PASS) |
| story_hero | default, split | stacked / accepted two-column frame (PASS) |
| timeline | default, vertical | milestone cards row / dated rail (PASS) |
| values_grid | default, minimal | framed cards / rule-topped plain (PASS) |
| stats_strip | default, dark | light strip / navy strip (PASS) |
| spacer | sm, md, lg | 24 / 48 / 96 px (`heightPx` wins) (PASS) |
| divider | line, ornament, dashed | hairline / ◆ marker / dashed rule (PASS) |

Section Variant vs Hero Template vs Style Overrides are distinct and documented: hero look = template/variant; product card look = card-template (`cardVariant`); page-wide tokens = style overrides + section theme.

## D. Publishing evidence (real backend, real HTTP, real DOM — `backend/scripts/cms-home-e2e.mjs`, 22/22)

Embedded PostgreSQL (PGlite) → migrations → the canonical development seed (`seed:local`: real published products with WMS stock, CMS bootstrap, live announcement) → Fastify **listening** on 127.0.0.1 → admin HTTP flow:

1. Draft saved via `PUT /admin/cms/pages/:id/draft` (retitle hero, retitle/hide/limit sections, insert text_section, hide newsletter) → **public `GET /site/pages/home` stays 404**, zero `cms_page_versions` rows.
2. Publish → snapshot v1: public API returns the exact composition (hero copy, section order, hidden section absent, added section present, `limit` honored, visible-only).
3. The **storefront bundle boots against the running server in JSDOM** and renders: CMS marker + version, published hero copy in the accepted `.kv-sf-hero`, all non-hero sections in published order, real catalogue cards, override attrs (`data-kv-pad=lg`, `data-kv-width=narrow`, `data-kv-bg=surfaceSecondary`), server announcement (legacy ops copy absent), no demo badge, **no fallback copy leaking next to published sections**.
4. Scheduled publish (`scheduledStartAt` +6h) → status `scheduled`, **not public early**; previous publication stays live; immediate publish returns it to the public site.
5. Republish v2 → fresh JSDOM boot (full reload) shows v2 hero copy and version marker 2.
6. `?demo` boot: no `[data-cms-home]`, accepted fallback composition, prominent demo badge.
7. `unpublish` → public 404; archiving home refused (400); home restored by publishing again.
8. Server permissions: guest 401 on admin routes (no auth weakening anywhere).

**Fail-against-broken proof (Phase 9):** with `cmsHome` forced to `null` in App (broken build), the same E2E fails 11 checks (marker, hero copy, order, added section, cards, double-render leak, overrides, reload) — then passes again after restore. The suite was written to fail against the pre-fix behavior first.

## E. Test results

| Suite | Result |
|---|---|
| `backend/src/cms-home-integration.test.ts` (embedded PG, npm run test:cms-home) | **PASS 8/8** |
| `backend/scripts/cms-home-e2e.mjs` (real HTTP + real DOM, npm run test:cms-home:e2e) | **PASS 22/22** |
| backend `test:cms` pristine order (production, cms, experience, seo) | **PASS 53/53** |
| `.smoke/cms-variants.mjs` (variant matrix) | **PASS 56/56** |
| `.smoke/run.mjs` (storefront DOM) | **PASS 155/155** |
| `.smoke/units.mjs` | **PASS 118/118** |
| `.smoke/curated-commerce.mjs` | **PASS 41/41** |
| `.smoke/admin-styling.mjs` | **PASS 31/31** |
| `.smoke/break.mjs` | **PASS 72/72** |
| `.smoke/styling-units.mjs` | **PASS 77/77** |
| `tsc --noEmit` | **PASS** |

No assertion was weakened to get green; the new suites failed against broken behavior first (§D.8, plus the variant suite failing on the pre-Phase-3 renderer by construction — it asserted variant diffs that did not exist before).

## F. Remaining issues (nothing concealed)

1. **Real-browser visual verification: UNVERIFIED.** This sandbox has no browser. Automated DOM checks cover structure, classes, attributes and copy — they are not visual acceptance. On your Windows machine:
   ```powershell
   # backend (any free port; embedded PostgreSQL, seeded, listening)
   cd backend
   npm install
   $env:NODE_ENV="development"; $env:DATABASE_URL="postgres://127.0.0.1:55441/pglite"  # or your local PostgreSQL
   npm run migrate ; npm run bootstrap:admin ; npm run seed:local ; npm run dev
   # frontend
   cd ..
   npm install ; npm run dev -- --host
   ```
   Then verify visually at `http://localhost:5173/` (published home), `/admin` → CMS Studio (edit → save states «تغییرات ذخیره‌نشده / در حال ذخیره… / ذخیره شد / ذخیره انجام نشد», drag-and-drop + ↑/↓ reorder, device preview, publish drawer with schedule, version history/restore) and `http://localhost:5173/?demo` (badge + fallback composition). The automated equivalents of all of these pass; the pixel-level check is yours.
2. **Admin Curated-Style CRUD has no persistent backend (standing blocker, unchanged).** The public «استایل‌های آماده» surface and its admin styling editor run on the in-app store (4 published seeds, cs-demo-1..4). `/api/v1/styles` is the *customer* saved-styles domain, not admin curated styles. Demo data must not be reported as live CMS output — it is labeled as demo. A `curated_style_groups` table + admin routes remain a separate implementation workstream.
3. **`muted` section theme is dead code** in `CmsSection` (backend schema rejects the value). Harmless; remove in a later cleanup.
4. **node --test multi-file suites share one embedded database and are order-sensitive.** The CMS suites assert pristine-DB state (no active palette, starter pages created exactly once). Running several suites in one `node --test` invocation in an arbitrary order can cross-pollute them; each suite passes alone and in the committed script order. That is why `cms-home-integration.test.ts` has its own script (`test:cms-home`) and its own embedded-DB runner.
5. **Intentionally non-CMS elements (documented, not fake controls):** the curated-styles band, the atelier story band and the service-information band (live shipping config) — the first two are storefront signatures rendered below the CMS content on a published homepage (story is fallback-only), the third is owned by the Shipping domain; the legacy ops announcement bar survives only as the no-server-announcement fallback; the hero's focal-point crops are presentation-only by design.
6. **Hero template honesty:** the homepage hero accepts one editorial presentation (static/slider/video). A published `template` that has no homepage equivalent (e.g. mosaic/product) renders the accepted static frame instead of silently rendering a foreign template — the 12-template renderer stays exclusive to CMS landing pages.

## G. GitHub

- Branch: `arena/a2909e7e-kolbevintage` (pushed, no force)
- Commit: see `git log -1` on the branch (single cohesive commit for this task)
- Remote tip verified via `git ls-remote --heads origin arena/a2909e7e-kolbevintage`
