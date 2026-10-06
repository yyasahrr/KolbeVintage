import type { Product } from "../../data/catalog";

/**
 * Presentation-side product relations.
 *
 * There is no recommendation engine, no scoring service and no analytics feed
 * in this repository, and the catalogue states **no** product-to-product
 * relationships at all: `Product` has no `relatedProducts`, no `looks` and no
 * tags. Everything below therefore comes from one hand-written table
 * (`COMPLEMENTS`) applied deterministically to fields that do exist
 * (`Product.category`, `Product.status`, `Product.retailPrice`).
 *
 * That distinction is the whole point of this file, so it is stated plainly:
 * **the look rail is a curated styling opinion, not catalogue fact.** It is a
 * merchandiser's rule of thumb ("a coat wants a blouse under it"), presented as
 * a suggestion, which is why it may only ever *narrow* what is shown — when the
 * table has no opinion, the rail is hidden rather than filled with catalogue
 * neighbours dressed up as a recommendation.
 *
 * Nothing here reads inventory, pricing, wholesale or supplier data.
 *
 * ── Contract for a future engine ────────────────────────────────────────────
 * `productRelations` is the authoritative contract, and it does not exist yet.
 * If Core Commerce adds it, it should ship as
 * `productRelations: { productId, relatedProductId, kind: "look" | "similar",
 * reason: string }[]` on the retail payload, ordered by the backend. These two
 * functions then reduce to a filter over that array — including its empty case,
 * which must hide the rail exactly as `complementsOf` does today. `COMPLEMENTS`
 * is deleted at that point, because a curated table must not outlive real data.
 * The signature `(current, catalogue) => Product[]` is deliberately kept so the
 * swap stays local to this file.
 */

/**
 * A curated styling heuristic — **not** a relationship the catalogue declares.
 *
 * Keyed by the catalogue's real category names, written by hand on the
 * presentation side. Each key lists the categories that *may* complete that
 * category's look: an outer piece asks for what goes under it first, then for
 * the pieces that finish the outfit. Order is the order the rail should read in.
 *
 * Two consequences worth keeping in mind when editing this table:
 *   - it is an opinion, so it is never evidence that two products go together;
 *   - it is asymmetric on purpose in places (a shirt lists outerwear because a
 *     shirt is *styled under* a coat), so reading it as a graph is a mistake.
 *
 * Categories that are not stocked yet (شلوار، بافت، اکسسوری) are listed so the
 * rules keep working as the catalogue grows; they simply match nothing today.
 * When `productRelations` lands, this table is deleted rather than kept as a
 * fallback — a heuristic that outlives real data becomes the fake signal again.
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
 * «این استایل را کامل کن» — pieces from *other* categories, chosen by the
 * curated `COMPLEMENTS` heuristic above. Deterministic, duplicate-free and never
 * the product being viewed.
 *
 * There is no fallback and there must not be one: an unmapped category (or one
 * whose complementary categories are unstocked) returns an EMPTY array, and the
 * caller hides the section. An empty rail is honest; a rail padded with
 * catalogue neighbours would assert a styling relationship nothing supports.
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

  /* No explicit complement exists for this category (or the catalogue has no
     pieces in the complementary categories): the section is hidden rather than
     filled with unrelated products. An empty rail is honest; a rail of random
     neighbours is a styling claim the data does not support. */
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
