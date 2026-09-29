# Agent D2 — SEO/Search/Media integration contract

Branch: `arena/01a0ed97-kolbevintage`

## Shared database and migrations

- The SEO/Search/Media schema is `backend/src/migrations/050_seo_search_media.sql`. This branch reserves only `050` within the requested `050–054` band; the next number is not assumed to be available.
- Migrations `004–015` in this branch are the existing shared baseline SQL from `arena/01a0e916-kolbevintage`, carried here because the checked-out `main` snapshot stopped at `003`. `001–003` were hash-compared against that baseline and match. Do not renumber or rewrite these shared migrations in this branch.
- The runner sorts numbered SQL names and records the exact filename in `schema_migrations`; it must be run twice against a fresh DB in CI to prove second-run no-op.
- No known migration basename in the inspected remote heads collides with `050_seo_search_media.sql`. Other parallel heads contain conflicting/overlapping `016–023` names; those are outside D2’s ownership and must be reconciled by the integration owner before a combined all-agent migration chain is cut.
- A parallel SEO work item (`arena/01a0ed9a-kolbevintage`, migration `017_seo_domain_media_variants.sql`) defines `seo_entries`/`seo_entry_versions`, while D2 uses `seo_pages`/`seo_page_revisions`. Names do not collide, but they represent overlapping SEO domains. Before merging both implementations, select one source of truth or add a reviewed compatibility/data migration; do not silently write SEO metadata to both stores.

## API contracts

All admin routes are under `/api/v1` and use the authenticated bearer token plus server-side permissions. CORS permits GET/POST/PUT/PATCH/DELETE.

- SEO pages: `GET /admin/seo/pages`, `PUT /admin/seo/pages/:entityType/:entityKey` (`seo:read`, `seo:manage`). Updates append immutable revisions.
- Redirects: `GET/POST /admin/seo/redirects`, `DELETE /admin/seo/redirects/:id` (`seo:redirects`). Targets are local paths only; cycles are rejected on write and detected as HTTP 508 when legacy/corrupt rows are encountered.
- Technical SEO: settings, facets, crawls/issues, and persistent 404 summaries (`seo:technical`); `/robots.txt` and `/sitemap.xml` are public.
- Search: `/search` reads catalog price and inventory as source of truth; synonyms affect textual matching only. Public event ingestion is anonymous and aggregated/retained for at most 30 days; admin analytics/synonyms use `search:analytics` / `search:manage`.
- Editorial: public read endpoints and authenticated `/admin/editorial` CRUD (`content:manage`).
- Media: `/admin/media`, upload intents/complete, product-media relations (`media:manage`); public product media only returns ready assets for published products.
- External integrations: Google Search Console, Merchant Center, and CDN status are explicitly `not_configured` until real credentials/adapters are supplied. S3-compatible upload signing is server-side; status is `not_configured` or `configured` (not a connectivity claim) and routes return `STORAGE_UNAVAILABLE` when the complete storage configuration is absent. Never substitute a mock as connected.

## Crawl/index boundaries

- The sitemap uses canonical URLs when present, otherwise stored SEO slugs, and only includes indexable pages on `https://kolbe.ir`. Published supplier products (`supplier_id IS NOT NULL`) are excluded from the retail sitemap.
- No AggregateRating is synthesized. Product rating is not inferred for structured data by this API.
- The React storefront is a client-rendered single-file SPA. SEO-critical product data is not present in initial HTML; SSR/prerender remains a release blocker and must not be described as crawlable.
- Redirect resolution is restricted to local paths, coalesces valid chains to one response, and limits traversal. The persistent 404 monitor stores path/day counts and last referrer only; it does not retain account identity.
