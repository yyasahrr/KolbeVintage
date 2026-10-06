import type { Product } from "../../data/catalog";

/**
 * Presentation-side product relations.
 *
 * There is no recommendation engine, no scoring service and no analytics feed
 * in this repository, so both lists below are deterministic rules over data
 * that already exists (`Product.category`, `Product.status`). Nothing here
 * invents a relation that the catalogue does not state, and nothing here reads
 * inventory, pricing or wholesale data.
 *
 * ── Contract for a future engine ────────────────────────────────────────────
 * If Core Commerce later exposes relations, it should ship them as
 * `productRelations: { productId, relatedProductId, kind: "look" | "similar",
 * reason: string }[]` on the retail payload, ordered by the backend. These two
 * functions are then reduced to a filter over that array plus the deterministic
 * fallback below when the backend returns nothing for a product. The signature
 * `(current, catalogue) => Product[]` is deliberately kept so the swap is local.
 */

/**
 * Styling complements, keyed by the catalogue's real category names.
 *
 * The order matters: it is the order a stylist would layer an outfit — an outer
 * piece first asks for what goes under it, then for the pieces that finish the
 * look. Categories that are not stocked yet (شلوار، بافت، اکسسوری) are listed so
 * the rules keep working as the catalogue grows; they simply match nothing today.
 */
const COMPLEMENTS: Record<string, string[]> = {
  "مانتو و بارانی": ["شومیز", "پیراهن", "کت و بلیزر", "بافت", "شلوار", "اکسسوری"],
  "پالتو": ["بافت", "شومیز", "پیراهن", "شلوار", "اکسسوری"],
  "کت و بلیزر": ["شومیز", "پیراهن", "شلوار", "بافت", "اکسسوری"],
  "شومیز": ["مانتو و بارانی", "کت و بلیزر", "پالتو", "شلوار", "اکسسوری"],
  "پیراهن": ["کت و بلیزر", "مانتو و بارانی", "بافت", "پالتو", "اکسسوری"],
  "شلوار": ["شومیز", "کت و بلیزر", "بافت", "پیراهن"],
  "بافت": ["شلوار", "مانتو و بارانی", "پالتو", "اکسسوری"],
  "اکسسوری": ["مانتو و بارانی", "پالتو", "کت و بلیزر", "پیراهن"],
};

/** Only published retail products may ever be recommended. */
const sellable = (p: Product) => p.status === "published" && p.retailPrice > 0;

/**
 * «این استایل را کامل کن» — complementary pieces from *other* categories.
 * Deterministic, duplicate-free, and never the product being viewed.
 */
export function complementsOf(current: Product, catalogue: Product[], limit = 4): Product[] {
  const order = COMPLEMENTS[current.category] ?? [];
  const pool = catalogue.filter((p) => p.id !== current.id && sellable(p));
  const picked: Product[] = [];
  const seen = new Set<string>();

  for (const category of order) {
    for (const product of pool) {
      if (product.category !== category || seen.has(product.id)) continue;
      seen.add(product.id);
      picked.push(product);
      break; // one piece per complementary category keeps the look readable
    }
    if (picked.length >= limit) return picked.slice(0, limit);
  }

  /* Nothing complements this category yet: fall back to other products from the
     same wardrobe rather than showing an empty rail. Still no similarity claim
     is made — this is the same "complete the look" surface, not "similar". */
  if (picked.length === 0) {
    for (const product of pool) {
      if (seen.has(product.id)) continue;
      seen.add(product.id);
      picked.push(product);
      if (picked.length >= limit) break;
    }
  }
  return picked.slice(0, limit);
}

/**
 * «شاید بپسندید» — alternatives and near-neighbours: same category first, then
 * the categories that share a complement list with it. Distinct logic from
 * `complementsOf`, which only ever returns other categories, and disjoint from
 * it: a piece already shown in the look rail is never repeated here.
 */
export function similarTo(current: Product, catalogue: Product[], limit = 4): Product[] {
  /* anything the "complete the look" rail already shows is claimed: the two
     sections must never repeat a product */
  const claimed = new Set(complementsOf(current, catalogue, limit).map((p) => p.id));
  const pool = catalogue.filter((p) => p.id !== current.id && !claimed.has(p.id) && sellable(p));
  const siblings = COMPLEMENTS[current.category] ?? [];
  const ranked = [...pool].sort((a, b) => score(b) - score(a));

  function score(p: Product): number {
    if (p.category === current.category) return 3;
    if (siblings.includes(p.category)) return 2;
    if (COMPLEMENTS[p.category]?.includes(current.category)) return 1;
    return 0;
  }

  /* a stable tie-break so the rail never reshuffles between renders */
  const stable = ranked.map((p, index) => ({ p, index })).sort((a, b) => {
    const delta = score(b.p) - score(a.p);
    return delta !== 0 ? delta : a.index - b.index;
  });
  return stable.filter((entry) => score(entry.p) > 0).slice(0, limit).map((entry) => entry.p);
}
