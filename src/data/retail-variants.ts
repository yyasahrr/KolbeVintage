/* RETAIL VARIANT CONTRACT — the single source of retail colour×size availability.
 *
 * Retail availability NEVER derives from wholesale series data (`SeriesDef.colorIds`,
 * `series.available`, `series.composition` are wholesale/commercial definitions — they describe
 * what a supplier sells as a series, not what retail variants exist or are in stock).
 *
 * The canonical server contract (backend/src/catalog.ts) returns, per product variant:
 *   { id, sku, size, color, attributes,
 *     available, reserved, incoming, damaged, retailAvailableStock }   // WMS-derived counters
 *
 * What the storefront hydrates from (GET /api/v1/products, the list the store needs) ships those
 * counters too, so this module:
 *     • uses the variant contract for the retail colour×size STRUCTURE,
 *     • uses the availability counters only when the row actually carries them (never invents a
 *       number, never disables a size on absence of data), preferring `retailAvailableStock`
 *       (retail-domain availability) over the all-domain `available`,
 *     • keeps a demo-only legacy fallback (offline LOCAL PRODUCTS seed) exactly as before.
 *   Contract + gaps are documented for the Core Commerce agent in
 *   docs/parallel/agent-a-contracts.md §8.
 */
import type { Product, ProductVideo } from "./catalog";

export type RetailVariant = NonNullable<Product["variants"]>[number];

const norm = (value?: string | null) => (value ?? "").trim().toLowerCase();

/** Does this product expose the retail variant contract at all? (demo/offline rows do not) */
export const hasRetailVariants = (p: Product): boolean => Boolean(p.variants?.length);

/** Colour identity is a name on server rows and an id on demo rows — match either. */
const matchesColor = (variantColor: string | null | undefined, colorIdOrName?: string) => {
  if (!colorIdOrName) return true;
  const a = norm(variantColor);
  const b = norm(colorIdOrName);
  return Boolean(a) && a === b;
};

/** Sizes that exist for this product in the retail variant contract (optionally for one colour). */
export function retailVariantSizes(p: Product, colorIdOrName?: string): string[] {
  const variants = (p.variants ?? []).filter((v) => matchesColor(v.color, colorIdOrName));
  return Array.from(new Set(variants.map((v) => v.size).filter((s): s is string => Boolean(s))));
}

/** WMS availability of one retail variant — `undefined` when the row does not carry counters. */
export function retailVariantAvailability(p: Product, colorIdOrName?: string, size?: string):
{ available: boolean; stock?: number } | undefined {
  const variant = (p.variants ?? []).find((v) => matchesColor(v.color, colorIdOrName) && norm(v.size) === norm(size))
    ?? (p.variants ?? []).find((v) => matchesColor(v.color, colorIdOrName) && !size);
  if (!variant) return undefined;
  const stock = variant.retailAvailableStock ?? variant.available;
  if (typeof stock !== "number") return undefined; // contract without counters → no claim
  return { available: stock > 0, stock };
}

/** Demo-only legacy fallback (offline seed): wholesale series composition used to shape the demo
 *  catalogue. Kept for the demo storefront — never used when the retail variant contract exists. */
const legacyDemoSizes = (p: Product): string[] =>
  Array.from(new Set(p.series.flatMap((series) => Object.keys(series.composition ?? {}))));

/** THE retail size source: variant contract → hydrated `sizes` → demo-only legacy fallback. */
export function retailSizes(p: Product, colorIdOrName?: string): string[] {
  if (hasRetailVariants(p)) {
    const scoped = retailVariantSizes(p, colorIdOrName);
    // A colour with no variant rows keeps the product-level retail sizes (no empty size picker).
    if (scoped.length) return scoped;
    const all = retailVariantSizes(p);
    if (all.length) return all;
  }
  if (p.sizes?.length) return p.sizes;
  return legacyDemoSizes(p);
}

/**
 * Colour-scoped media, when — and only when — the product actually carries it:
 *   1. an explicit `Product.colorMedia[colorId]` map (Product/CMS media contract),
 *   2. else colour-scoped CMS videos (`ProductVideo.colorId`),
 *   3. else `undefined` — the caller MUST keep the normal `product.images` gallery unchanged.
 * Never rotates, reorders or re-indexes the product gallery to fake a colour photo.
 */
export function mediaForColor(p: Product, colorIdOrName?: string): { images: string[]; videos: ProductVideo[] } | undefined {
  const key = (colorIdOrName ?? "").trim();
  if (!key) return undefined;
  const map = p.colorMedia ?? {};
  const explicit = map[key] ?? Object.entries(map).find(([k]) => norm(k) === norm(key))?.[1];
  if (explicit?.length) return { images: explicit, videos: [] };
  const scopedVideos = (p.videos ?? []).filter((video) => norm(video.colorId) === norm(key) && Boolean(video.colorId));
  if (scopedVideos.length) return { images: [], videos: scopedVideos };
  return undefined;
}
