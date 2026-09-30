# Agent C — cross-domain overlap report

Branch `arena/01a0ed9a-kolbevintage` (PR #3) · baseline `ff10906f4251cf89fc66a8c73ed9fef5a37087c6` · migrations `035`–`037` (reserved range 035–044).

Purpose: Agent C owns the **CMS / experience layer**. This file lists every place where this branch touches, or had to implement,
a domain that the integration plan may assign to another agent. **Nothing was deleted.** Each row says whether the code is a thin
adapter (CMS only binds and renders canonical data) or a full domain implementation (a candidate duplicate). **The integrator decides
who owns what.**

Legend: **Adapter**: reads the canonical domain and renders it, stores no business values. **Full domain**: owns tables, rules and
write APIs. **DUPLICATE?**: another agent may deliver the same domain; the integrator should merge or pick one.

---

## 0. CMS-owned scope (Agent C, not an overlap)

CMS V2 page model, component registry and typed field schema (`cms-schema.ts`), schema-driven section editor, component presets,
hero templates, countdown binding, product-card templates/rules (presentation only), theme engine / design tokens / campaign theme,
live preview (iframe), draft → publish → versions / restore, scheduling, header / footer / mega menu / announcement bar, page builder,
About / landing / vibe / lead pages, CMS permissions and audit, storefront micro-interactions, a11y.

- Backend: `cms.ts`, `cms-studio.ts`, `cms-schema.ts`, `cms-starter.ts`.
- Frontend: `cms-blocks.tsx`, `cms-render.tsx`, `cms-hero.tsx`, `cms-preview-frame.tsx`, `commerce-card.tsx` (render only),
  `site-chrome.tsx`, `toast.tsx`, `admin-cms-studio.tsx`, `admin-section-editor.tsx`, `admin-cms.tsx`.
- Tables: `cms_*` (pages, sections, page_versions, components, component_presets, announcements, product_card_templates / rules,
  collections, assets / asset_usages, analytics_events, leads), `color_palettes` (+ design_tokens), `site_settings` (layout keys).
- Rule enforced in this branch: **fresh database = empty CMS.** Migrations carry schema and reference data only. The About, Vibe and
  VIP-lead starter pages and the announcement (inactive) are created by `POST /api/v1/admin/cms/bootstrap` (`cms-starter.ts`). A unit
  test fails if 035–044 ever insert into `cms_pages`, `cms_sections` or `cms_announcements`, or seed an active installment provider.

---

## 1. SEO: **Full domain · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `backend/src/seo.ts` (resolve / validate / JSON-LD / sitemap / robots); `cms-studio.ts` keeps legacy `cms_pages.seo` in sync via `legacySeoToWrite` / `renameSeoKey` |
| Tables / migrations | `seo_entries`, `seo_entry_versions` (036); 036 backfills from `cms_pages.seo`, `cms_categories.seo`, `cms_vibes.seo` (no-op on a fresh DB) |
| Endpoints | `GET /api/v1/seo/:type/:key`, `GET /api/v1/seo/sitemap.xml`, `GET /api/v1/seo/robots.txt`, `GET /api/v1/admin/seo`, `GET\|PUT /api/v1/admin/seo/:type/:key`, `POST /api/v1/admin/seo/:type/:key/preview` |
| Frontend | `src/portals/admin-seo.tsx` (editor + Google preview), `src/components/seo-head.ts` (head tags from the SEO domain) |
| Tests | `experience.test.ts`: "SEO Domain (Req 235) and media processing" (unit), "SEO Domain is the single source of head tags…" (e2e); browser smoke: About/vibe head + SEO editor |
| Nature | Full domain: entity types page / product / category / vibe, versioning, robots and canonical rules |
| Proposed owner | SEO / Marketing agent, if one exists. Otherwise keep it here as a standalone module (it is not coupled to CMS internals) |
| Notes | CMS only calls `resolveSeo`/`upsertSeoEntry`. Legacy `cms_pages.seo` jsonb (baseline 010) is still written for backward compatibility, so there are two storage places for page SEO. The integrator should drop the legacy column once every reader uses `seo_entries` |

## 2. Recommendation: **Full domain · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `backend/src/recommendations.ts` (strategies: similar, popular, recently viewed, complete-the-look; `similarityScore`) |
| Tables / migrations | No own table. Reads `products`, `stock_balances`, `order_lines`, `product_views` (035), `product_style_features` (035), `saved_styles` |
| Endpoints | `GET /api/v1/recommendations?strategy=&productId=&limit=` |
| Frontend | `recommendation_section` block in `cms-blocks.tsx`; account "پیشنهاد شخصی" card in `account-center.tsx` |
| Tests | `experience.test.ts`: "Installment policy & recommendation scoring" (unit), "Round 3 …" (e2e) |
| Nature | Full domain (scoring and ranking logic). The CMS block itself is only an adapter (`strategy` + `limit` props) |
| Proposed owner | Recommendation / Personalisation agent. The CMS block should keep calling `GET /api/v1/recommendations` whatever the implementation |

## 3. Reviews (customer reviews and review photos): **Full domain · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `backend/src/style.ts` (review routes), `profile.ts` (`/me` aggregates), `commerce-view.ts` (rating / reviewCount on cards, read-only), `cms-studio.ts` (review_section binding) |
| Tables / migrations | `customer_reviews` (035; photos and moderation columns in 037). **Not** the baseline `product_reviews`, which is supplier-product *moderation* (`marketplace.ts`, decision / documents_checked). The names are similar but the domains differ |
| Endpoints | `GET\|POST /api/v1/products/:id/reviews`, `GET /api/v1/me/reviews`, `GET /api/v1/admin/reviews`, `GET /api/v1/admin/reviews/:id/photos`, `PATCH /api/v1/admin/reviews/:id` |
| Frontend | `src/components/product-reviews.tsx`, ReviewsPanel in `admin-cms-studio.tsx` (moderation + thumbnails), `review_section` block |
| Tests | `experience.test.ts` "Round 3 …" e2e (review photos, moderation) |
| Nature | Full domain (submission, verified-purchase flag, moderation, photos) |
| Proposed owner | Catalog / UGC / CRM agent. Review moderation UI sits in the CMS Studio only for convenience; move it if another console owns UGC |
| Not done | Storefront **photo-upload UI** (the backend accepts `photoFileIds`) |

## 4. Media (upload pipeline, variants, product media): **Full domain · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `images.ts` (sharp: responsive WebP variants, avatar processing; served by `GET /api/v1/media/:fileId` in `cms-studio.ts`), `media-pipeline.ts` (per-upload run with step status), `style.ts` (product media CRUD), `worker.ts` (pipeline/analysis jobs); baseline `files.ts` is unchanged |
| Tables / migrations | `media_variants` (036), `media_pipeline_runs` (037), `product_media` (035), `cms_assets` / `cms_asset_usages` (035, CMS library) |
| Endpoints | `GET /api/v1/media/:fileId?w=&fmt=`, `GET /api/v1/admin/media-pipeline/runs`, `POST /api/v1/admin/media-pipeline/process`, `GET /api/v1/products/:id/media`, `POST /api/v1/admin/products/:id/media`, `DELETE /api/v1/admin/products/:productId/media/:mediaId`; uploads use the baseline `POST /api/v1/files` |
| Frontend | `src/components/responsive-img.tsx`, AssetsPanel in `admin-cms-studio.tsx` (filters + pipeline runs), product media in `admin-product.tsx` |
| Tests | `experience.test.ts`: "avatar is resized to 512 WebP…", variants never upscale (unit); media pipeline in "Round 3 …" (e2e); smoke: card `srcset` / lazy, hero eager |
| Nature | Full domain |
| Proposed owner | Catalog / Media agent. `cms_assets` stays CMS-owned (editorial library) |
| Notes | **Two product-image sources**: `product_media` (new) and the baseline `products.metadata.images`. `commerce-view.ts` prefers `product_media` and falls back to `metadata.images`. The integrator should choose one canonical store. Background removal is partial (`cutout_url` support, no external remover) |

## 5. Installments: **Full domain (policy) · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `backend/src/installments.ts` (providers + `installmentOffers` maths), `commerce-view.ts` (`applyInstallmentPolicy` for card numbers) |
| Tables / migrations | `installment_providers` (037). SnappPay and DigiPay rows are seeded **inactive**; storefront offers appear only after an admin enables a provider |
| Endpoints | `GET /api/v1/installment-providers`, `GET /api/v1/admin/installment-providers`, `PUT /api/v1/admin/installment-providers/:code` |
| Frontend | `src/portals/admin-installments.tsx`, `installment_card` block, instalment line in `commerce-card.tsx` (render only) |
| Tests | `experience.test.ts`: "per-instalment amount = ceil(base × (1 + fee) / count)…", "provider policy drives card numbers…" (unit), "Round 3 …" (e2e, permission + audit) |
| Nature | Full domain for provider *policy* (count, limits, fee, wording). No payment/checkout integration: `integration_code` only references the baseline `integrations` table |
| Proposed owner | Payments / Pricing agent. With no active provider, cards fall back to the baseline product instalment price (Pricing) |

## 6. Customer / Profile (profile, security, saved cart): **Full domain · DUPLICATE?**

| Item | Detail |
|---|---|
| Backend files | `backend/src/profile.ts` (profile, avatar, contact change, password/OTP, security, sessions, account dashboard/timeline/coupons/invoices, saved cart, supplier public profile, product types), `auth.ts` (login_history, contact_change_requests, `POST /api/v1/auth/login/2fa`), `catalog.ts` (product_type / vibes / seasons on products), `suppliers.ts` (profile change requests) |
| Tables / migrations | `login_history`, `contact_change_requests`, `saved_styles`, `saved_style_versions`, `supplier_profile_change_requests`, `product_types` (035); `saved_carts` (037); new columns on `users`, `sessions`, `orders`, `products`, `supplier_profiles` (035) |
| Endpoints | `GET\|PATCH /api/v1/profile`, `POST\|DELETE /api/v1/profile/avatar`, `POST /api/v1/profile/contact-change[/:id/verify]`, `POST /api/v1/profile/password[/otp[/:id]]`, `GET /api/v1/profile/security`, `POST /api/v1/profile/security/2fa`, `DELETE /api/v1/profile/sessions/:id`, `POST /api/v1/profile/sessions/logout-all`, `GET /api/v1/account/{dashboard,timeline,coupons,invoices}`, `POST /api/v1/account/views`, `GET\|PUT /api/v1/profile/saved-cart`, supplier-profile routes, product-type routes |
| Frontend | `account-center.tsx`, `account.tsx`, `supplier-profile-settings.tsx`, `admin-product-types.tsx` |
| Tests | `experience.test.ts`: "Profile & product-type rules (Req 325-341)" (unit), "CMS studio, style intelligence and unified profile…" (e2e); smoke: dashboard, profile, security |
| Nature | Full domain (identity / account). Clearly outside CMS |
| Proposed owner | Identity / Customer agent. The saved cart stores only `{variantId, quantity}`; prices are always re-read from Pricing |
| Not done | Saved-cart **frontend sync** (backend only). The email OTP returns a dev code outside production; SMS 2FA needs a real SMS provider configured |

## 7. Other overlaps worth a decision

| Area | Files / tables | Nature | Note |
|---|---|---|---|
| Style intelligence | `style.ts`, `product_style_features`, `style_category_matrix`, `saved_styles` | Full domain | Not CMS. Proposed owner: a Style / Catalog agent |
| CMS categories and vibes | `cms_categories`, `cms_vibes` (035) | Taxonomy (presentation) | **DUPLICATE?** with the baseline catalog `products.category` (free text). CMS uses them for navigation, landing pages and SEO. Catalog should own the canonical taxonomy |
| Leads → CRM | `cms_leads` (035), `POST /api/v1/site/leads` | Adapter | Writes the canonical `crm_contacts` row; `cms_leads` keeps only page/campaign attribution + `crm_contact_id` |
| Commerce view | `commerce-view.ts` | Adapter (read-only) | Reads catalog, pricing, WMS (`stock_balances`), reviews and installments to build cards and collections. Writes nothing |
| Collections | `cms_collections` (035) | Rule definitions only | Dynamic query rules (vibe / inStock / season); results always come from the catalog and WMS |

## 8. Integrator notes (outside Agent C scope, not changed)

- The PR against `main` shows about 7187 deletions: generated files (`node_modules`, `dist`, `.playwright-cli`) still tracked on `main`
  and removed by baseline commit `2ffc53b` (before `ff10906`). Compare with `ff10906` to see only Agent C's 64 files.
- Zod 4 `partial().parse()` fills defaults on PATCH. This branch fixed its own routes via `patchBody` (`errors.ts`). The same pattern
  remains in other modules: `addresses.ts:45`, `crm.ts:233`, `integrations.ts:27`, `payments.ts:156`, `promo.ts:142`, `shipping.ts:32`.
- `retail.tsx` still contains the baseline static home fallback (`COLLECTIONS` counts from `src/data/catalog.ts`). This branch only
  limits it to "no CMS home page composed yet".
