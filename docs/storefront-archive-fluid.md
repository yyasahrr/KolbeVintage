# KOLBE / ARCHIVE FLUID — Storefront Design System v1

Presentation layer for the public retail/VIP storefront (Agent C scope).
Everything here lives under the `.kv-storefront` scope and in `src/components/storefront/`,
so the admin console, supplier center and studio surfaces keep their existing tokens.

## Design read

Redesign-preserve of a Persian/RTL curated vintage-fashion storefront for design-conscious
shoppers plus wholesale buyers. Editorial archive language, restrained commerce chrome,
adaptive liquid glass only on floating interaction surfaces.

Dials: `DESIGN_VARIANCE 7` · `MOTION_INTENSITY 4` · `VISUAL_DENSITY 3`.

Self-critique gate — "could this belong to any random fashion store?" The answers that make it
Kolbe: the archive palette (bone/sand/charcoal/olive/tobacco/denim/brass, no saturated accent),
circular category medallions instead of rectangular category tiles, a full-bleed editorial hero
with a vertical Latin archive caption, image-as-card product cells, and liquid glass restricted to
four floating objects (header, bottom nav, quick-add, toast).

## Materials

| Material | Class | Where | Recipe |
| --- | --- | --- | --- |
| CLEAR | `.kv-clear` | page, product cells, editorial content, grids | solid surface, hairline only when it carries grouping |
| FROST | `.kv-frost` | cart panel, search panel, filters, sheets, popovers, menus | `blur(20px) saturate(135%)`, 82% surface fill, hairline |
| LIQUID | `.kv-liquid` | floating header, mobile bottom nav, quick-add control, toast | `blur(14–22px) saturate(150%)`, gradient fill, specular highlight, inner rim, restrained shadow |

Liquid is never used on product cards, section surfaces or the page. Every material has a
`@supports` fallback to a solid surface, and the mobile blur radius is smaller than desktop.

## Palette

Primitives: `#F7F4ED` bone · `#E8E0D4` sand · `#DBD1C1` sand deep · `#1C1C19` charcoal ·
`#626754` oxidized olive · `#60483A` tobacco · `#687789` faded denim · `#A28B64` muted brass ·
`#85653F` brass deep.

Measured on bone `#F7F4ED` (WCAG): charcoal ink **15.7:1**, muted `#6B665B` **5.2:1**,
olive **5.3:1**, tobacco **7.7:1**, brass deep **4.86:1**, success `#4E5C46` **6.5:1**,
danger `#96463A` **5.9:1**. Raw brass `#A28B64` is **2.97:1** on bone, so it is decorative only
(hairlines, VIP marker, swatch rims) and brass deep is used wherever brass carries text.

One filled action per view: charcoal. Brass deep means "emphasis / selected", olive means
"confirmed", sienna means "unavailable or destructive". Product photography supplies the rest of
the colour.

## Typography

Three families, all already loaded by the project — no new CDN dependency:

* `Vazirmatn` — all Persian UI and body copy.
* `Marcellus` — the KOLBEVINTAGE wordmark and the archive caption only.
* `Cormorant Garamond` — campaign/editorial Latin lines and numerals.

Scale: display `clamp(2.6rem, 6.4vw, 5.25rem)` / h1 `clamp(1.9rem, 3.4vw, 2.9rem)` /
h2 `clamp(1.45rem, 2.2vw, 2rem)` / body `15px` / meta `12px`.
Persian needs air: display line-height `1.22`, body `1.85`. Tracked caps are limited to the
wordmark; no eyebrow label above every heading.

## Radius / shadow / motion

Radius hierarchy — controls `10–12`, cells `16`, panels `20–24`, sheets `26`, floating chrome
`999`, category medallions `50%`. Inner elements stay at least one step tighter than their
container (concentric radii).

Shadows are tinted with charcoal, never pure black.

| Token | Value | Use |
| --- | --- | --- |
| `--kvaf-t-fast` | 140ms | press feedback, swatch, badge |
| `--kvaf-t-base` | 220ms | popover, menu, hover |
| `--kvaf-t-pop` | 260ms | cart badge bump, toast |
| `--kvaf-t-sheet` | 320ms | bottom sheet, cart panel |
| `--kvaf-t-slow` | 620ms | hero parallax settle only |

Easings: `--kvaf-ease-out` `cubic-bezier(.23,1,.32,1)` for anything entering,
`--kvaf-ease-sheet` `cubic-bezier(.32,.72,0,1)` for sheets, `--kvaf-ease-spring`
`cubic-bezier(.34,1.32,.64,1)` for the single cart-badge bump. Nothing enters with `ease-in`.
`prefers-reduced-motion` removes transform motion and keeps opacity.

Animated motion is limited to: hero parallax, header compaction, cart badge bump, quick-add
"✓ Added" state, toast enter/exit, sheet enter, product-image crossfade, category hover.
No section-level reveal cascades, no ambient floating, no scroll hijacking.

## Breakpoints

`360 · 390 · 430 · 768 · 820 · 1024 · 1280 · 1440 · 1920`.
Product grid: 2 columns to 1023, 3 at `lg`, 4 at `xl`. Header: floating capsule at `lg+`,
compact floating bar plus liquid bottom nav below `lg`.

## CMS contract notes

`EditorialHero` is a presentation adapter over the existing `HeroConfig` contract
(`src/data/ops.tsx`) — it consumes `template / eyebrow / title / subtitle / ctaLabel / ctaTarget /
secondaryLabel / secondaryTarget / image / video / poster / overlay / align / slides`, renders a
full-viewport editorial composition, and preserves the carousel and video behaviour.
`src/components/cms-render.tsx` is untouched; CMS blocks keep rendering through `BlockRenderer`
and inherit the archive palette from the scoped `--kv-*` overrides.

**Requested CMS enhancement (not implemented here, owned by the CMS track):** `HeroConfig` has no
field for a short Latin/archive caption or a "campaign index" label, so the vertical archive
caption in the hero is presentation-side static brand text rather than CMS content. Adding an
optional `caption?: string` to `HeroConfig` would let editorial control it.

## Verification record

Run in the sandbox on 2026-10-05 (`node_modules` ships platform binaries for Windows only, so
tools are invoked through `node` directly rather than the missing `node_modules/.bin` shims):

| Check | Command | Result |
| --- | --- | --- |
| Types | `node node_modules/typescript/bin/tsc --noEmit` | 0 errors (strict, `noUnusedLocals`) |
| Production build | `node node_modules/vite/bin/vite.js build` | ✓ 1944 modules, `dist/index.html` 932,209 B (gzip 238 kB) |
| Bundle cost | vs. `HEAD:dist/index.html` 872,963 B | +59,909 B (+6.9 %), no new runtime dependencies |
| Behaviour (desktop) | jsdom smoke run over the real app bundle | 44/44 assertions, 0 runtime errors |
| Behaviour (mobile) | same suite, `(min-width: 1024px)` false | 45/45 assertions, 0 runtime errors |
| Worst case | 8 adversarial product fixtures | 17/17 assertions, 0 runtime errors |

The smoke suite drives the shipped bundle in a real DOM and covers: liquid header + announcement
measurement, editorial hero, category medallions (5 real categories), product cells (8 published
products), circular swatches, desktop quick-add popover vs. mobile quick-add sheet, real
`addToCart` (size + colour + stock), badge `۰ → ۱ → ۲`, "به سبد اضافه شد" toast with
"مشاهده سبد" and its `aria-live="polite"` region, FROST cart panel contents, wishlist
`aria-pressed`, bottom-nav navigation, category chip + filter-sheet narrowing, search overlay
(`aria-modal`) returning real catalogue hits and opening the PDP, PDP gallery/swatches/sizes and
its add action, focus trap wrap (Tab and Shift+Tab) with background scroll lock, and an audit
that every icon-only button has an accessible name (0 unnamed).

Worst-case fixtures: 100-character name, 8 colours, 1 colour, 0 colours, no series, stock 0,
no image, and a 9-digit price with a long category name. Outcomes: clamped name, `+۴` overflow
chip, "بدون تنوع رنگ", "این محصول سایزبندی ندارد", disabled quick add with "ناموجود", image
fallback message, `۹۹۹٬۹۹۹٬۹۹۹`, badge capped at `۹۹+`.

`--kvaf-bottomnav-space` is 0 at `lg+` and 76px below it (nav = 64px tall floating 12px up),
which is what keeps the last row of products, the add-to-cart toast and the support launcher
clear of the floating nav. It is present in the shipped CSS as
`@media (max-width:1023px){.kv-storefront{--kvaf-bottomnav-space:76px}}`.

**Not verified here:** there is no Chromium in the sandbox and the Playwright download is
blocked, so the layer has not been reviewed as rendered pixels and no screenshots are attached.
Colour contrast figures in this document are computed from the hex pairs, not sampled from a
rendered page; the responsive matrix and the glass/blur fallbacks are specified in CSS but were
not visually confirmed.

---

# Phase 2 — product card refinement (inline purchase)

> **Superseded in part by Phase 4.** The card itself is unchanged and still
> authoritative. The paragraphs below about *per-colour gallery fallbacks* and
> *derived colour×size availability* describe code that Phase 2.1 and Phase 4
> removed; treat the Phase 4 section at the end of this document as current.

## What changed on the card

The card is now a framed miniature purchase surface instead of a photo with a
floating quick-add button:

- **Frame.** 1px hairline (`--kvaf-line`), soft shadow (`--kvaf-shadow-sm`,
  `--kvaf-shadow-md` on hover/expand), 24px radius concentric with the 16px
  photograph, 8px inner padding so the image still leads.
- **Two zones.** Media on top, information below a hairline rule; the purchase
  zone is separated by a quieter dashed rule. Collapsed cards carry the same
  rule with a hint, so the grid rhythm never changes between states.
- **Colour drives the media.** Choosing a swatch swaps the photograph to that
  colourway's own media and starts the carousel on its first frame.
- **Card carousel.** Two glass discs (`chevron`) plus a dot indicator, swipe on
  touch (40px threshold, horizontal only, RTL-aware), no autoplay, no library.
  Arrows are hidden until hover/focus for pointer users and lightly visible on
  touch; they disable at both ends.
- **Inline expansion, no overlay.** Colour → the card grows downward, sizes
  appear under the swatches, the action sits below them. No popover, no bottom
  sheet, nothing leaves the grid. One card is expanded at a time; tapping the
  chosen swatch again (or "بستن") collapses it.
- **Honest states.** No colour yet → "برای انتخاب سایز، یک رنگ را انتخاب کنید".
  Colour, no size → disabled "سایز را انتخاب کنید". Ready → "افزودن به سبد".
  Success → "به سبد اضافه شد" inline plus the existing toast and badge bump.
  Rejected by the stock rule → inline notice, never a success message.
  Sold out → the card cannot expand at all.

`QuickAddPopover.tsx` and `QuickAddSheet.tsx` are deleted; `SizeRow` moved into
`shared.tsx` because the PDP still uses it. The cart drawer, search overlay,
filter sheet and account menu keep their overlay behaviour untouched.

## Data extension (presentation only)

`Product.colorMedia?: Record<string, string[]>` — colourway id → that product's
photographs in that colour. Rules:

- optional, so every existing product and every admin/supplier form keeps working;
- every URL must already exist in that product's `images` (enforced by a test);
- only colourways whose photograph is unambiguous are mapped — 8 entries across
  the catalogue (p2 cream/olive, p3 black, p4 white, p5 burgundy, p6 sand,
  p7 cream, p8 black);
- ~~unmapped colourways fall back to the same product gallery, rotated to a stable
  frame per colour (`mediaForColor`)~~ — **superseded by Phase 4.** Rotation is
  gone: a colour with no mapped media shows the product's own gallery, starting at
  its first frame, and never a photo that was taken for a different colour.

No new variant system, no pricing/stock/OMS change. When real per-colour studio
photography arrives, only this table changes.

Per-colour sizes are **derived**, not stored: `sizesForColor` reads the existing
`SeriesDef.colorIds` ("رنگ‌های مجاز" in the admin/supplier UI), skips series the
supplier switched off (`available: false`) and skips sizes with zero pieces.
Where no series restricts a colour, every colour offers the same run — which is
what the data says today.

## Verification record (Phase 2)

| Check | Command | Result |
| --- | --- | --- |
| Types | `node node_modules/typescript/bin/tsc --noEmit` | 0 errors |
| Production build | `node node_modules/vite/bin/vite.js build` | ✓ `dist/index.html` 934,478 B (gzip 239 kB) |
| Card + storefront flows, desktop | jsdom run over the real bundle | 57/57, 0 runtime errors |
| Same, mobile profile | `(min-width: 1024px)` false | 57/57, 0 runtime errors |
| Worst-case fixtures | 12 adversarial products | 29/29, 0 runtime errors |
| Catalogue integrity | per-colour media map | 8 entries, 0 foreign URLs, 0 unknown colour ids |

Covered: no overlay markup left on the card; collapsed card has no CTA and no
sizes; arrows change the photograph, clamp at both ends and are named for AT;
choosing a colour changes the photograph, expands the card and reveals sizes in
reading order below the swatches; the CTA lives in the lower section, waits for a
size, then runs the real `addToCart` and bumps the badge; the toast stays a
polite live region with "مشاهده سبد"; opening a second card collapses the first;
the PDP gallery now follows the colour too; focus stays trapped in the cart.
Worst cases: one photo (no arrows/dots), one colour, no colour, one size
(pre-chosen), sold out (cannot expand), no photo, no size run, eight colours
(`+۴`), nine-digit price, colour-restricted size runs (`S,M` vs `L,XL`, and a
deactivated series contributes nothing), rejected add reported inline.

**Still not verified:** no browser in the sandbox, so the refined card has not
been reviewed as rendered pixels; spacing, shadow weight and the reveal timing
are specified in CSS but not visually confirmed.

---

# Phase 2.1 — correctness fix (variant data source + media honesty)

> **Superseded in part by Phase 4.** This section's diagnosis still holds, and
> `sizesForColor` is gone for good. The media rule it left behind — *"unmapped
> colourways fall back to the same product gallery, rotated to a stable frame per
> colour"* — is **no longer true**: `mediaForColor()` now returns
> `colorMedia[colorId] ?? product.images`, with no rotation. See Phase 4.

## What was wrong in Phase 2

`sizesForColor()` derived retail colour×size availability from wholesale series
data (`SeriesDef.colorIds`, `series.available`, `series.composition`), and
`mediaForColor()` rotated the plain product gallery per colour so the photograph
would appear to change. Both were wrong: wholesale series describe how a product
is *packed for bulk buyers*, not what a retail customer can buy, and a gallery
photo of another shoot must never be presented as a colourway.

Both are removed. `sizesForColor` is deleted, `mediaForColor` returns
`colorMedia[colorId]` when it exists and `p.images` **unchanged** otherwise, and
the card/PDP only reset their frame when the colour genuinely has its own
photographs (`hasOwnMedia`). A colour without dedicated media still selects
visibly, expands the card and allows size selection — it just does not claim any
photograph as its own.

## Repository inspection: is there a retail variant contract today?

| Layer | What exists | Retail-usable? |
| --- | --- | --- |
| `backend/src/migrations/001_core.sql` | `product_variants(id, product_id, sku, size_label, color_label, attributes, active)` and `stock_balances(variant_id, warehouse_id, on_hand, reserved, incoming, damaged)` with `CHECK (reserved + damaged <= on_hand)` | Domain model only — not exposed as retail availability |
| `backend/src/catalog.ts` → `GET /api/v1/products` | Public, unauthenticated. Returns `variants: [{ id, sku, size, color }]` for `active` variants of published products | Variant identity yes, **availability/stock no** |
| `backend/src/inventory.ts` → `GET /api/v1/inventory` | Per-warehouse `on_hand / reserved / damaged` and `available = on_hand - reserved - damaged` | No — requires `inventory:read` or supplier ownership, and is warehouse/supplier scoped |
| `src/data/admin-api.ts` | The only frontend API client; consumed by `src/portals/admin.tsx` and `admin-server-orders.tsx` | Admin only |
| `src/data/catalog.ts` + `src/data/store.tsx` | The storefront's actual source of truth (`PRODUCTS` via `useStore()`) — product-level `stock` only | What the storefront uses today |

**Conclusion:** no reliable retail colour×size availability contract exists, so
none was invented. Retail size behaviour is preserved exactly as before Phase 2
(`sizesOf()` = the union of `series.composition` keys — a size *list*, documented
in code as not an availability signal), and availability remains the single
product-level `stock` that `addToCart` already enforces.

## Required contract for Core Commerce

The storefront will consume this as soon as it exists; the field names follow the
repository's own domain model (`product_variants` / `stock_balances`):

```ts
type RetailVariant = {
  variantId: string;    // product_variants.id
  sku: string;          // product_variants.sku
  colorId: string;      // stable id, see note below
  size: string;         // product_variants.size_label
  available: boolean;   // product_variants.active && sellable stock > 0
  stock?: number;       // optional; aggregated over retail-eligible warehouses
};

// on the retail product payload (GET /api/v1/products):
retailVariants: RetailVariant[];
```

Open points Core Commerce needs to settle:

1. **`color_label` is free text today.** The storefront keys colourways by
   `Colorway.id` (`orange`, `black`, …), so a stable `colorId` needs either a
   colour dictionary table or a normalisation rule agreed with the CMS.
2. **Warehouse scoping.** `stock_balances` is per warehouse and the existing
   inventory endpoint is supplier-scoped; retail availability needs an explicit
   "retail-eligible warehouse" rule and a single aggregated number.
3. **Reserved stock.** `available` should keep meaning `on_hand - reserved -
   damaged` so the storefront never offers a size that checkout cannot honour.
4. **Publication rule.** Variants of unpublished/rejected products must not
   leak; the existing `v.active` + `p.status = 'published'` filter is the right
   starting point.

Until then, every colour of a product offers the same sizes and the card never
states per-colour availability.

## Media, long term

`Product.colorMedia` stays as a backward-compatible presentation shim (8 entries,
each URL already present in that product's `images`). Colour-to-media assignment
properly belongs to the Product/CMS media contract — `product_variants` already
carries `color_label`, so per-variant media should come from there. When it does,
this field should be deleted rather than maintained by hand.

## Verification record (Phase 2.1)

| Check | Command | Result |
| --- | --- | --- |
| Types | `node node_modules/typescript/bin/tsc --noEmit` | 0 errors |
| Production build | `node node_modules/vite/bin/vite.js build` | ✓ `dist/index.html` 936,349 B |
| Storefront flows, desktop | jsdom run over the real bundle | 55/55, 0 runtime errors |
| Same, mobile profile | `(min-width: 1024px)` false | 55/55, 0 runtime errors |
| Worst-case fixtures | 13 adversarial products | 33/33, 0 runtime errors |
| Catalogue integrity | per-colour media map | 8 entries, 0 foreign URLs, 0 unknown colour ids |

New assertions: a colour without dedicated media keeps both the photograph and
the carousel frame, still selects, still expands and still offers sizes; a
photographed colour swaps the media and shows its own carousel; an unphotographed
colour restores the untouched gallery; wholesale colour restrictions and
deactivated series do not shrink the retail size run; the PDP does not fake a
photo for an unphotographed colour. `addToCart` is byte-identical to the base
commit and `backend/` is untouched.

---

# Phase 3 — density, product detail and editorial refinement

The direction from Phases 1–2 is unchanged: floating Liquid Glass header, editorial
type, circular categories, hairline product cards with inline purchase, glass
material, dark mode. Phase 3 changes scale, density and information architecture —
not the visual language.

## Scale system (four levels)

Four levels, each with one token. Nothing between them: a size either speaks for
the brand, introduces a section, sells a product, or labels something.

| Level | Token | Value | Used for |
| --- | --- | --- | --- |
| **Hero** | `--kvaf-fs-display` | `clamp(2.6rem, 6.4vw, 5.25rem)` | the editorial hero headline only (`EditorialHero`) — unchanged from Phase 1 |
| **Feature** | `--kvaf-fs-feature` | `clamp(1.5rem, 2.1vw, 1.9375rem)` | section titles, story titles, the product name on a PDP (`.kvaf-feature-title`) |
| | `--kvaf-fs-h2` | `clamp(1.45rem, 2.2vw, 2rem)` | the shared `h2` voice (`Section`, journal lead, sheet titles) — same level |
| **Commerce** | `--kvaf-fs-commerce-title` | `0.8438rem` (13.5px) | product name in a card |
| | `--kvaf-fs-commerce-price` | `0.8438rem` | card price |
| | `--kvaf-fs-h1` | `clamp(1.9rem, 3.4vw, 2.9rem)` | page-level headings that are not marketing (VIP portal) |
| **Utility** | `--kvaf-fs-utility` | `0.75rem` (12px) | labels, metadata, `.kvaf-meta`, accordion terms |
| | `--kvaf-fs-utility-sm` | `0.6875rem` (11px) | **floor** — category labels, chips, flags. Nothing renders below 11px |

Rules that came out of this:

* The hero is the only place above 40px. The listing title dropped from `--kvaf-fs-h1`
  (30–46px) to Feature scale (24–31px); a product grid does not need a poster.
* Body copy under a Feature heading stays at 14px, line-height ≥ 1.7.
* Utility text is never the only carrier of a decision — price and stock are
  Commerce level, and the add-to-cart label is 15px.

## Density system

The card's rhythm is now tokenised so it can be tuned in one place:

```css
--kvaf-card-radius: 20px;          /* was 24px */
--kvaf-card-media-radius: 12px;    /* concentric: 20px − 7px padding */
--kvaf-grid-gap: 0.875rem;         /* was 12–20px depending on breakpoint */
--kvaf-grid-gap-y: 1.75rem;        /* was 24–28px */
--kvaf-thumb: 72px;
--kvaf-gallery-max: 580px;
--kvaf-gallery-vh: 74vh;
```

Measured on the collapsed card (arithmetic from the CSS values above; the media
ratio moved 3:4 → 4:5):

| Viewport | before | after | area |
| --- | --- | --- | --- |
| 390 (2 cols) | 172 × 480 | 172 × 426 | **−11.1 %** |
| 768 (2 cols) | 337 × 700 | 337 × 633 | **−9.6 %** |
| 1024 (3 cols) | 295 × 644 | 293 × 578 | **−10.9 %** |
| 1280 (4 cols) | 289 × 636 | 293 × 578 | **−7.9 %** |
| ≥1440 (4 cols) | 329 × 689 | 303 × 590 | **−21.1 %** |

At 1280 the old card was already 289px — inside the 280–320px target — so the
reduction there is limited by the 280px floor, not by the tokens. Commerce
surfaces now share a capped measure (`.kv-sf-shell-shop` 1320px, `.kv-sf-shell-pdp`
1120px) so a desktop card lands at 303px instead of stretching to 329px.

Kept intact: hairline border, soft shadow, inline expansion, image carousel,
circular swatches, inline size chips, cart feedback wording.
Shrunk: media ratio, card padding, information block spacing, swatch target
(38 → 32px inside a card; still 38px on the PDP), size chip (40×38 → 36×34),
CTA height (46 → 42px).

## Grid

`grid-cols-2` up to 1023px · `lg:grid-cols-3` at 1024 · `xl:grid-cols-4` from 1280.
Five columns was rejected on purpose: at any shell width this storefront considers
comfortable, a fifth column pushes cards to ~255px, below the 280px floor.

## Product detail

Two columns, DOM order **information first, gallery second**. In RTL that puts the
information on the right and the gallery on the left, which is the requested
layout, and it keeps a logical reading order for screen readers (name before
photograph). Below `lg` the gallery is pulled up with `order: -1` — visual order
changes, DOM order does not.

* Columns: `minmax(0, 2fr) minmax(0, 3fr)` = 40 / 60 at ≥1024px, gap 56px.
* Gallery: `max-width: 580px`, `aspect-ratio: 4/5`, `max-height: 74vh`, centred in
  its column. It never becomes a full-viewport poster; the tallest frame at 1440×900
  is 725px wide × 74vh.
* Thumbnails: 72px, 4:5, a vertical rail on desktop and a swipeable strip on
  touch. Rendered only when the product has more than one photograph.
* Mobile: swipeable strip (`74vw`, capped 380px), `loading="eager"` on the first
  frame and `lazy` on the rest, fixed purchase bar with `env(safe-area-inset-bottom)`.
* Try-on is a quiet secondary button under the primary action, retail only, and it
  routes to the existing studio tab — no try-on logic is reimplemented.

### Information architecture (only fields that exist)

brand · SKU (`<bdi dir="ltr">`) → name (Feature) → rating + review count →
retail price + four-installment figure → colour swatches + selected colour →
sizes + size-guide label → stock → selection summary (`aria-live="polite"`) →
add to cart + wishlist → try-on → delivery/return/authenticity strip.

### Details section — accordions and the missing contract

`Fold` (in `shared.tsx`) is a real `<button aria-expanded aria-controls>` over a
`role="region"` panel: native keyboard support, state readable in the DOM, no
library. Motion is a short reveal that the existing `prefers-reduced-motion`
block neutralises.

Four disclosures ship, because four are all the data can fill:

| Disclosure | Source |
| --- | --- |
| درباره محصول | `Product.desc` |
| جنس و متریال | `Product.fabric` |
| وضعیت کالا | `badge` (when present), `soldNote` (when present), `stock`, `supplier`, `category` |
| ارسال و مرجوعی | live `shipping` methods (`name`, `zones`, `eta`, `price`, `freeAbove`) + the store's existing 7-day label |

**Not rendered, because no field exists** — and none was invented:

* form/Fit, design details, care instructions
* condition grade, wear description, era/year, country of origin, unique-piece
  flag, restoration history

Required contract for Core Commerce (presentation-ready, additive):

```ts
type ProductProvenance = {
  conditionGrade?: "نو" | "در حد نو" | "کارکرده تمیز" | "نیاز به تعمیر";
  wear?: string;              // free text from the merchandiser
  era?: string;               // "دهه ۸۰ میلادی"
  origin?: string;
  uniquePiece?: boolean;
  restoration?: string;
  fit?: string;
  care?: string;
};
type JournalEntry = {
  id: string; cat: string; read: string; title: string; img: string;
  slug?: string;              // join to the CMS article (m4/m5/m6 already exist)
  excerpt?: string;           // card summary
  body?: CmsBlock[];          // rendered by the existing BlockRenderer
  publishedAt?: string; author?: string;
};
```

When a field appears, the accordion gains a row; nothing else changes. Until then
the sections stay out rather than showing placeholder prose.

**Reviews:** the catalogue carries `rating` and `reviews` (a count) and no review
bodies, so the PDP shows the summary and count only. No review text is generated.

**Journal read action:** `JOURNAL` entries have no `slug` or body, so a "خواندن"
link would be a dead control. The previous journal view had one; it is gone. The
home preview still navigates to the journal view, which is a real destination.

## Recommendations

`src/components/storefront/recommendations.ts` — deterministic, presentation-side,
no engine, no analytics, no invented relations.

* `complementsOf` («این استایل را کامل کن»): walks a styling-complement map keyed
  by the catalogue's real category names and takes **one** piece per complementary
  category, in layering order (an outer piece first asks for what goes under it).
  Categories that are not stocked yet (شلوار، بافت، اکسسوری) are in the map so the
  rule keeps working as the catalogue grows; today they match nothing and the rail
  falls back to other pieces from the same wardrobe.
* `similarTo` («شاید بپسندید»): same category first, then categories that share a
  complement list, then the reverse relation. Products already shown in the look
  rail are claimed, so the two sections never repeat a product.
* Both take `(current, catalogue)`, filter to `status === "published" &&
  retailPrice > 0`, exclude the product being viewed, cap at 4, and are stable
  across renders (verified for all 8 products).

Future engine contract: `productRelations: { productId, relatedProductId,
kind: "look" | "similar", reason: string }[]`, backend-ordered; these two functions
then become a filter over that array with the same deterministic fallback.

Cards in both rails are the standard product card at compact width — 4 across on
desktop, a snap-scrolling rail below 768px with the last card peeking past the
shell edge.

## Product listing

* One compact toolbar row: `[search] [filter] [sort]`. The search field is
  full-width on touch and 260px from 768px; the sort is a native `<select>`
  labelled «مرتب‌سازی»; the filter button carries a live count of active facets.
* Category chips stay, one row below, secondary, swipeable.
* Filters open the existing FROST `Sheet` as a **side-anchored panel** from
  1024px (`data-panel="true"`), so no permanent filter column eats the grid.
* Facet groups, each backed by a real field: دسته‌بندی (`category`), رنگ
  (`colors[].name`), سایز (`sizesOf`), برند (`supplier`), حداکثر قیمت
  (native range slider bounded by the real min/max), موجودی (`stock > 0`).
  **No condition group** — the field does not exist.
* The grid uses the full capped content width; 2/3/4 columns as above.

## Journal

One large lead story (4:3 media, Feature-scale title) plus standard cards at
2/3 across (`.kv-sf-jrnl-grid`, 4:3 media, category · reading time · title).
Category chips are derived from the entries themselves — today that is exactly
`همه / استایل / هنر ساخت`; nothing is added to the taxonomy.

## Horizontal overflow — what was checked

Static audit (no browser is available in this environment — see the verification
record):

* `grep 100vw` across `src/`: **0 hits**. Nothing in the storefront sizes itself
  to the viewport.
* Every `overflow-x: auto` rule in the built CSS belongs to a deliberate scroller:
  `.kv-sf-scrollx` (product/press rails, hidden scrollbar + scroll snap),
  `.kv-sf-cats` (circular categories), `.kv-sf-thumbs`, `.kv-sf-recs` (below
  768px, with `-1rem` bleed + matching padding so the last card peeks), and the
  Tailwind `.overflow-x-auto` utility used only by admin tables — never by a
  storefront component.
* The one structural cause that can produce accidental page scroll in an image
  grid is a grid item whose automatic minimum size is the photograph's intrinsic
  width. `.kv-sf-cell` now sets `min-width: 0`, and both new grids use
  `minmax(0, …)`/`min-w-0` columns.
* Fixed widths were reviewed against 360px: thumbnails 72px, icon actions 50px,
  toolbar controls 42px, mobile gallery frames `min(74vw, 380px)` inside a rail.

No global `overflow-x: hidden` was added. **`document.scrollWidth <= innerWidth`
was not measured** — jsdom has no layout engine and no browser can be installed
here, so this remains an open item for a real device pass.

## Accessibility

* Accordions: real buttons, `aria-expanded`, `aria-controls`, `role="region"`,
  `aria-labelledby`; Enter/Space come free from the button.
* Selection summary is `aria-live="polite"`, so a colour or size change is
  announced without moving focus.
* Swatches keep `aria-pressed` + a concentric ring (state is never colour alone);
  size chips keep `aria-pressed`; the thumbnail rail is a labelled group with
  `aria-current`.
* The filter panel is `role="dialog" aria-modal="true"` with the existing focus
  trap, Escape and focus restore; the range slider is a native input.
* Gallery controls are buttons with Persian labels; decorative images are `alt=""`.
* Touch targets: 42–50px for purchase controls, 32px swatches inside a card,
  38px on the PDP — nothing interactive below 32px.
* Measured contrast (WCAG, computed): card name 16.4:1, category label 5.5:1,
  journal category 5.1:1, CTA 15.6:1, wishlist-on 6.2:1 (light); card name 14.9:1,
  category 6.5:1, journal category 5.2:1 (dark). Two defects found and fixed while
  measuring: the collapsed-card hint used `--kvaf-faint` at **3.43:1** and is now
  `--kvaf-muted` at 5.48:1; the no-image placeholder is `--kvaf-ink-2` at 7.45:1.

## Performance

* No new dependency: gallery, accordion, filters, rails and the journal are CSS +
  native elements.
* Non-primary images are `loading="lazy"` — card frames, thumbnails, journal
  media; only the first mobile gallery frame is eager.
* No eager full-resolution thumbnails: thumbnails are the same URLs as the frames
  (the catalogue ships one size per image — a `thumb` field is the obvious
  contract addition) but are rendered at 72px and deferred.
* Animations use transform/opacity only; the accordion reveal is CSS, and the
  reduced-motion block still neutralises everything.

## Verification record (Phase 3)

> **Superseded in part by Phase 4.** The limitation described below no longer
> applies: a Chromium build was later made to run in this sandbox, and Phase 4
> carries out the visual QA this section could not — measured overflow, support
> geometry, responsive behaviour at ten widths, and screenshots. The Phase 3
> *counts* below remain accurate for the code as it stood at that commit.

Environment: no browser can be installed in this sandbox (Playwright's CDN is
unreachable, no Chromium/Firefox binary, no sudo). **Visual QA was therefore
incomplete at the time of this record** — no screenshots, no measured layout, no
`document.scrollWidth`. Everything below is what could actually be executed then.

| Check | Result |
| --- | --- |
| `tsc --noEmit` | 0 errors |
| `vite build` | `dist/index.html` 955.8 kB (gzip 243.6 kB) |
| jsdom suite — desktop + mobile flows, PDP, accordion, filters, rails, journal, CSS audit | **107 / 107** |
| jsdom worst-case fixtures (13 hostile products × card + PDP) | **72 / 72** |
| unit checks — recommendations + media integrity over all 8 products | **84 / 84** |
| runtime errors during every flow | 0 |

Harness: `.smoke/` (`entry.tsx`, `break.tsx`, `units.tsx`, `build.mjs`, `dom.mjs`,
`run.mjs`, `break.mjs`, `units.mjs`). Rebuild a bundle with
`SMOKE_NAME=app SMOKE_ENTRY=.smoke/entry.tsx node .smoke/build.mjs`, then
`node .smoke/run.mjs`. `.smoke/out/` holds generated bundles and is not committed.

Still open, and stated plainly: measured horizontal overflow, real-device
responsive behaviour, and any visual judgement about balance and whitespace.

---

# Phase 4 — correctness, data honesty, support stabilisation

Not a redesign. The Archive Fluid identity, the floating header, the product card,
the PDP gallery scale, the grid density, the journal hierarchy and the mobile
bottom navigation are all unchanged. Phase 4 removes things the interface could
not honestly support.

## Product detail page

The top of the page now answers only *"can I buy this exact option?"*:

gallery | brand, name, rating, price, real instalment | colour | size |
availability | Add to Cart | Wishlist | Try-on (secondary).

* **No SKU in the purchase area.** The SKU is published in the
  `مشخصات کالا` disclosure, where technical metadata belongs. A test reads the real
  SKU value out of that row and asserts the purchase area never contains it.
* **Stock is presence only.** `Product.stock` is a product-level count; it cannot
  describe the selected colour × size. The page renders `موجود` / `ناموجود` from
  `data-available` and never a number. A test fails if a digit or `عدد` appears in
  that element.
* **The size-guide control is gone.** There is no `sizeGuide` contract, no size
  chart and no measurement table anywhere in the catalogue, so the control was a
  dead end. It may return only when the field exists.
* **No hardcoded promises.** `۷ روز مهلت برگشت`, `ضمانت اصالت` and the delivery
  promises are deleted. Delivery rows come from the live shipping configuration
  (`SEED_SHIPPING`-shaped: name, carrier, eta, price, free-above, zones), and when
  that list is empty the delivery disclosure is **omitted** rather than stubbed.
* **Details are backend-driven.** `p.desc`, `p.fabric`, the spec rows and the
  delivery rows each render only when their data exists — so a product yields three
  or four disclosures, never an empty one. The section is one coherent accordion
  group; there is no dashboard table and no per-property card.
* **Assistive tech keeps the selection.** `انتخاب شما: رنگ … · سایز …` is a
  `sr-only` `aria-live="polite"` region, so the visible column stays quiet.

## Recommendations

* `complementsOf()` no longer falls back to arbitrary catalogue items. No curated
  complement → **the rail is hidden**. The category map is a *presentation
  heuristic*: it is curated, it lives in `recommendations.ts`, and it is documented
  there as a stand-in until `productRelations` exists.
* `شاید بپسندید` remains the broad discovery surface and is disjoint from the look
  rail (tested).

## Journal

Browse-only, and locked that way. There is no article route, no body, no slug, no
excerpt, no `publishedAt`, no author, no generated editorial text and no Read
control — because `JOURNAL` carries only `id`, `title`, `cat`, `read` and `img`.
Cards show that real metadata and navigate to browsing. When the CMS ships a
`JournalEntry`, the card grows a destination; nothing parallel is built.

## Support widget

* **Zero layout shift.** One fixed 52px launcher; both glyphs live in a single
  20px slot, cross-faded and rotated in place, so opening never changes padding,
  gap, border, width or the icon centre. Measured across
  closed/hover/focus/open/closing in Chromium at 390 and 1440: **max drift 0.00px**
  for x, y, width, height, icon centre and slot width.
* **The panel cannot move the trigger**: it is `position: absolute; bottom: 100%`.
* **RTL**: the launcher anchors to the *physical* left of the viewport. A logical
  `inset-inline-start` resolves to the right in an RTL page and covered the PDP
  purchase column at 1024–1200px — the trap is recorded in the source comment.
* **Size**: `width: min(320px, calc(100vw - 32px))`, `max-height` with internal
  scroll, so it fits 360px viewports and long channel names.
* **Behaviour**: Escape (capture phase, so it closes before any storefront sheet),
  click-outside, `aria-expanded`, `aria-controls`, non-modal `dialog` with no focus
  trap, and focus returns to the launcher.
* **Material**: launcher LIQUID, panel FROST — Archive Fluid tokens, not the legacy
  `kv-glass`/`kv-accent` pair. Because the widget now renders *inside* the
  storefront shell, it inherits the dark-mode scope (it previously stayed light on
  a dark page).
* Data still comes from `quickSupport`; the ticket action still hands off to the
  existing ticket centre.

## Stacking order and the mobile bands

Named tokens only, in ascending order:

| Token | Value | Surface |
| --- | --- | --- |
| `--kvaf-z-header` | 60 | floating header |
| `--kvaf-z-bnav` | 62 | mobile bottom navigation |
| `--kvaf-z-support` | 64 | support launcher |
| `--kvaf-z-drawer` | 70 | cart drawer |
| `--kvaf-z-search` | 86 | search overlay |
| `--kvaf-z-sheet` | 88 | filter sheet |
| `--kvaf-z-toast` | 95 | cart toast |

Every fixed surface on a product page derives its offset from one token
(`--kvaf-bottomnav-space: 76px` on mobile), in this order from the bottom:

    0–76px    bottom navigation              (z 62)
    76–80px   gap
    80–152px  purchase bar                  (z = bnav − 1)
    164–216px support launcher, lifted      (lift 84px)
    164–234px toast, when a purchase bar exists (+160px)

The toast used to land on top of the buy bar — the button the shopper had just
pressed — and the buy bar overlapped the bottom nav by 2px. Both are fixed and
verified in Chromium at 360/390/430/768: all six pairwise intersections are 0.

## Footer

No address, no phone number, no Instagram/Telegram/WhatsApp handles, no newsletter
form and no `ثبت شد` success message — none of those had an authoritative source.
What remains is six real actions: theme toggle, all products, studio, journal,
wholesale, supplier centre. The Persian year is computed via `Intl` inside a
`try/catch`.

## Cart and checkout

A line's thumbnail is resolved by `lineThumbnail(product, colorName)`: the chosen
colour's own first frame when that colour has media, otherwise the product's first
photo. Verified end-to-end in the browser — card → toast → cart drawer → checkout
all show the *same* frame (the checkout order line previously showed
`images[0]` while the drawer showed the colour frame). Cart business state,
`CartLine` and `variantId` are untouched.

## Production gating

`تست پنل‌ها` and `پیش‌نمایش پنل‌ها` are behind `import.meta.env.DEV`. In the
production bundle the footer control renders nothing, the header callback is
`onDemo: void 0`, and the modal is not mounted; a test asserts no
`تست پنل‌ها`/`پیش‌نمایش پنل‌ها` text exists in the production DOM while the source
keeps its dev flag.

## Horizontal overflow (measured, not masked)

`document.scrollWidth === document.documentElement.clientWidth` at 360/390/430/768/820/1024/1280/1440/1600/1920
across home, shop, shop-with-filters, PDP, journal, cart and search — **0
offenders**. No global `overflow-x: hidden` was added; the only horizontal
scrollers are the explicit rails, which are asserted against an allow-list.

## Missing contracts (nothing was invented)

| Contract | What is blocked | Current behaviour |
| --- | --- | --- |
| `retailVariants` / `RetailVariant{variantId,sku,colorId,size,available,stock?}` | per-variant availability and quantity | presence-only stock; size list stays the derived union |
| `ProductProvenance` (`conditionGrade`, `wear`, `era`, `origin`, `uniquePiece`, `restoration`, `fit`, `care`) | the vintage-specific details | omitted entirely |
| `JournalEntry` (`slug`, `excerpt`, `body`, `publishedAt`, `author`) | article pages | browse-only cards |
| `productRelations` (`{productId, relatedProductId, kind, reason}`) | authoritative complement/similar data | curated presentation heuristic |
| `sizeGuide` | the size-guide control | removed |
| newsletter/lead endpoint | the footer newsletter | removed |
| authoritative site contact data | address, phone, socials | omitted |
| per-image `thumb` | lighter thumbnails | same URLs rendered at 72px |

## Phase 4.1 — footer delivery copy, recommendation docs

Two honesty leaks closed, nothing else touched:

* **The footer no longer promises delivery.** `با ارسال به سراسر کشور` was
  hardcoded brand copy, and `App.tsx` fell back to the same claim whenever the
  shipping configuration had nothing to say. `shippingNote` is now an **optional**
  prop, `App.tsx` passes `retailShippingNote || undefined` with no literal
  fallback, and the footer renders the line only when it exists — and it exists
  only when an *active* retail shipping method declares a free-shipping threshold.
  No authoritative shipping data therefore means no delivery claim at all.
* **The look rail is documented as what it is.** `recommendations.ts` previously
  said "nothing here invents a relation that the catalogue does not state", which
  was the opposite of the truth: `COMPLEMENTS` is the *only* source of those
  relations and the catalogue declares none. The file now states plainly that the
  rail is a curated styling opinion rather than catalogue fact, that `[]` is the
  correct answer when the table has no opinion (so the rail hides — runtime
  behaviour is unchanged), and that `productRelations` supersedes the table
  entirely rather than living alongside it.

## Debt, recorded rather than hidden

* **`.smoke/` was not moved to `tests/storefront-smoke/`.** Another agent's work
  lives in the same tree and the move was not provably conflict-free, so the
  harness stayed where it is; `.smoke/out/` remains untracked scratch.
* **`dist/` is an input to its own build.** `dist/index.html` is committed and
  nothing excludes it from Tailwind's file scan, so a rebuild on top of a stale
  bundle inherits utility classes from that bundle's own output — 52 dead classes
  (dashboard-only) in this instance. Measured: building with `dist/` present emits
  1511 selectors, building with it removed emits 1442; the difference is entirely
  classes that no longer exist in `src/`. The committed bundle here is the clean
  one. Excluding `dist/` from the scan is a one-line fix for a future pass, left
  out of Phase 4.1 deliberately to keep the change set tiny.
* **Legacy dashboards still use arbitrary z-index utilities** —
  `primitives.tsx` (`z-[70]`, `z-[80]`), `portals/admin.tsx`, `portals/supplier.tsx`
  (`z-[70]`, `z-[90]`), `portals/style-canvas.tsx` (`z-[999]`) and
  `portals/account.tsx` (`z-[90]`). They are outside the storefront stack; the
  Phase 4 audit covers the shopper-facing surfaces only and fails if a `z-[…]`
  utility reappears there.

## Verification record (Phase 4)

Environment: Chromium (via `@sparticuz/chromium`) driven by `puppeteer-core` from a
harness outside the repository; `dist/` rebuilt before every run.

| Check | Result |
| --- | --- |
| `tsc --noEmit` | 0 errors |
| `vite build` | `dist/index.html` 958.2 kB (gzip 243.2 kB) |
| DOM suite — desktop + mobile flows, PDP, support semantics, footer honesty, demo gating, privacy regressions, z-index and band audits | **152 / 152** |
| worst-case fixtures (13 hostile products × card + PDP) | **72 / 72** |
| unit checks — recommendations, media integrity, line thumbnails | **118 / 118** |
| overflow, 10 widths × 7 surfaces | scrollWidth == clientWidth, 0 offenders |
| support drift, closed/hover/focus/open/closing @390 and @1440 | max 0.00px |
| mobile band intersections @360/390/430/768 | all 0 |
| runtime errors across every flow | 0 |

Harness: `.smoke/` (`entry.tsx`, `break.tsx`, `units.tsx`, `build.mjs`, `dom.mjs`,
`run.mjs`, `break.mjs`, `units.mjs`). Rebuild each bundle with its own entry —
`SMOKE_NAME=app SMOKE_ENTRY=.smoke/entry.tsx node .smoke/build.mjs` — then run
`node .smoke/run.mjs`. Omitting `SMOKE_ENTRY` silently builds the default entry for
all three names, which reads as a passing run against the wrong code.

---

# Phase 4.2 — retail privacy and the mobile hero

Two independent jobs: stop the retail storefront leaking supplier identity, and
make the mobile homepage a composed frame instead of a squeezed desktop one.
Desktop presentation is untouched.

## Retail supplier privacy (P0)

`Product.supplier` / `supplierId` are operational data. They are still on the
product record — the admin console, the supplier centre, wholesale and the order
components read them exactly as before — but **nothing shopper-facing renders
them any more**:

| Surface | Before | After |
| --- | --- | --- |
| Filter panel | `برند / تأمین‌کننده`, built from `p.supplier` | `برند`, built from `p.brand` |
| Listing search | matched `p.name` **or `p.supplier`** | matched `p.name` or `p.brand` |
| Search overlay | matched supplier, byline `category · supplier` | matches name/brand/category, byline `category · brand` |
| PDP specifications | row `تأمین‌کننده` | removed (rows are built from real product fields only) |
| Product cards | never showed it | unchanged, verified by test |
| Recommendation metadata | never showed it, verified | unchanged |

Two of those were worse than a leak: the *brand* filter was filtering on
`p.supplier`, and the search boxes matched supplier names — so typing a supplier
returned that supplier's entire range, which is an enumeration oracle, not a
search box. Brand and supplier happen to be distinct fields today (`Kolbe` vs
`کلبه وینتیج`), so the fix was a real split rather than a rename.

Wholesale masking is explicitly **unchanged**: `portals/vip.tsx` still renders
`SupplierChip` with `p.supplier` for approved buyers, and a test fails if that
attribution is altered or if the storefront layer starts importing the supplier
display helper.

## The mobile hero

`min-height: 96svh - announcement` measured 689px on an 844px viewport, so the
next section began **41px above the fold** — the first thing a phone visitor saw
below the CTAs was somebody else's content. The hero now uses **`100svh`** with no
fixed pixel height, and the announcement strip and floating header are fixed
overlays, so covering the full small viewport *is* "viewport minus announcement"
(verified: 844 = 844, 800 = 800, 932 = 932, 1024 = 1024, 1180 = 1180). `svh`
rather than `dvh` on purpose: the frame must not resize while mobile browser
chrome collapses mid-scroll.

The bottom of the hero now accounts for the fixed mobile navigation
(`--kvaf-bottomnav-space` + `env(safe-area-inset-bottom)`), so hero content can
never sit under it — CTA bottoms land 18px above the nav at every handheld width.

Mobile composition, all below the 1024px breakpoint:

* headline `clamp(1.9rem, 8.6vw, 2.5rem)` (was a flat 41.6px) — always **2 lines**
  at 360/390/430 instead of dominating the frame;
* paragraph constrained to `36ch` (was an unconstrained 388px measure);
* actions become a **column** below 640px, so the primary CTA is full-width
  (244–314px) and the secondary sits underneath it rather than competing beside it;
* the actions block reserves the support launcher's lane
  (`--kvaf-support-lane`, 5.25rem on narrow phones), so a floating utility can
  never be mistaken for part of the campaign's call to action;
* tablet (768–1023px) gets its own scale — `clamp(2.6rem, 5.4vw, 3.6rem)`,
  a `44ch` measure and side-by-side actions — rather than inheriting the phone
  composition.

Campaign photography keeps `object-fit: cover` and gains a responsive focal
point: `--kvaf-hero-focus-mobile` (default `50% 32%`, portrait-safe) and
`--kvaf-hero-focus` (default `50% 45%`) on desktop. A hero may override either
through the presentation-only `HeroFocalPoint` fields (`mobilePosition` /
`desktopPosition`); they are not part of `HeroConfig` and are not persisted
anywhere — when neither is supplied the stylesheet's defaults win, so no CMS or
backend change is implied.

One deliberate exception to "nothing after the hero competes": at 1440 the
approved desktop frame still ends at 96svh, leaving its 71px peek. That is the
frozen desktop language, and the desktop hero is unchanged.

## Verification record (Phase 4.2)

| Check | Result |
| --- | --- |
| `tsc --noEmit` | 0 errors |
| `vite build` | `dist/index.html` 958.2 kB (gzip 243.2 kB) |
| DOM suite | **152 / 152** (20 new privacy checks) |
| worst-case fixtures | **72 / 72** |
| unit checks | **118 / 118** |
| browser acceptance pass (hero geometry, support, filters, PDP, desktop, tablet) | **54 / 54** |
| overflow, 4 widths × 6 surfaces | 24 / 24 clean |
| desktop identity | hero bottom 829 (expected 829), headline 84px, bar 1180px, nav visible, actions in a row |

Measured hero geometry (Chromium):

| Width | Hero bottom | Next section top | First CTA | CTA bottom | Support | Bottom nav |
| --- | --- | --- | --- | --- | --- | --- |
| 360×800 | 800 | 800 (hidden) | 244px wide | 704 | y 572 | y 722 |
| 390×844 | 844 | 844 (hidden) | 274px wide | 748 | y 616 | y 766 |
| 430×932 | 932 | 932 (hidden) | 314px wide | 836 | y 704 | y 854 |
| 768×1024 | 1024 | 1024 (hidden) | 197px + 119px | 928 | y 796 | y 946 |
| 820×1180 | 1180 | 1180 (hidden) | 197px + 119px | 1084 | y 952 | y 1102 |
| 1440×900 | 829 | 829 (desktop peek) | 197px + 119px | 765 | y 816 | — |

The narrow-phone support launcher becomes a 52px icon pill (same height, same
single 20px icon slot, same cross-fade, caption hidden below 640px). The
launcher's own geometry is untouched: opening still moves it by **0.00px**, and
the open panel clears the hero CTAs.
