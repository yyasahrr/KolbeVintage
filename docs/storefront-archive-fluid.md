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
