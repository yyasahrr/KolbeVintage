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
- unmapped colourways fall back to the same product gallery, rotated to a stable
  frame per colour (`mediaForColor`) so switching colour still changes the
  photograph without pretending a per-colour shoot exists.

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

Environment: no browser can be installed in this sandbox (Playwright's CDN is
unreachable, no Chromium/Firefox binary, no sudo). **Visual QA is therefore
incomplete** — no screenshots, no measured layout, no `document.scrollWidth`.
Everything below is what could actually be executed.

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
