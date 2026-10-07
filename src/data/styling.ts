/* KOLBE — Styling domain (Phase 1, Non-Core workstream)
 *
 * One reusable, deterministic, explainable styling-recommendation domain shared
 * by the Style Builder wizard, the Final Look score and (from Phase 2) the
 * Curated Style compatibility preview.
 *
 * Principles this file is bound to (see the phase contract):
 *  - deterministic: same inputs → same outputs, no randomness, no clock;
 *  - explainable: every candidate carries Persian `reasons` a shopper can read;
 *  - inexpensive: pure functions over the in-memory retail catalogue;
 *  - honest: nothing is invented — style/occasion knowledge lives in one
 *    curated, hand-written profile table (the same "curated styling opinion,
 *    not catalogue fact" contract the storefront's COMPLEMENTS table follows),
 *    and the catalogue's real fields (category, colours, price, stock, status)
 *    stay the only per-product evidence.
 *
 * Phase 2 will add explicit colour-variant compatibility as a separate
 * adjustment layer (see `CompatibilityAdjustment` below) — the engine already
 * accepts it so the extension is additive, not a rewrite.
 */
import type { Product, Colorway } from "./catalog";

/* ============================================================
   Outfit roles — the taxonomy the wizard and canvas speak.
   Mapped from the catalogue's REAL categories (never hardcoded
   per product); unknown categories degrade to "accessory".
   ============================================================ */

export type OutfitRole = "top" | "bottom" | "outerwear" | "dress" | "shoes" | "headwear" | "accessory";

export const ROLE_LABEL: Record<OutfitRole, string> = {
  top: "بالاتنه",
  bottom: "شلوار",
  outerwear: "اورکت",
  dress: "پیراهن یک‌تکه",
  shoes: "کفش",
  headwear: "کلاه",
  accessory: "اکسسوری",
};

/** Wizard order — accessories are optional, dress replaces top+bottom. */
export const WIZARD_ROLES: OutfitRole[] = ["top", "bottom", "shoes", "accessory"];

/**
 * category → outfit role. Derived from the categories that actually exist in
 * the catalogue; new categories keep working through the prefix rules and the
 * `accessory` fallback, so nothing here has to be edited per product.
 */
const CATEGORY_ROLE: Record<string, OutfitRole> = {
  "مانتو و بارانی": "outerwear",
  "پالتو": "outerwear",
  "کت و بلیزر": "outerwear",
  "بافت": "top",
  "شومیز": "top",
  "پیراهن": "top",
  "شلوار": "bottom",
  "کفش": "shoes",
  "کتانی": "shoes",
  "بوت": "shoes",
  "اورکت": "outerwear",
  "کلاه": "headwear",
  "اکسسوری": "accessory",
  "کیف": "accessory",
  "کمربند": "accessory",
  "روسری": "accessory",
  "شال": "accessory",
  "زیورآلات": "accessory",
};

/** Category names that mean a one-piece dress (replaces top + bottom). */
const DRESS_CATEGORY = /^(پیراهن یک‌تکه|سرهم|دوم‌تکه لباس)$/;

export function outfitRoleOf(product: Pick<Product, "category">): OutfitRole {
  if (DRESS_CATEGORY.test(product.category.trim())) return "dress";
  return CATEGORY_ROLE[product.category.trim()] ?? "accessory";
}

/* ============================================================
   Curated styling profiles — structured, extensible data.
   Phase contract §15/§16: no giant forms, no fabricated product
   metadata. Like the storefront's COMPLEMENTS table this is a
   merchandiser's opinion keyed by real category names; the
   engine reads it, the UI only ever shows the resulting reasons.
   ============================================================ */

export type StyleKey = "casual" | "formal" | "semiformal" | "streetwear" | "sporty";

export const STYLE_LABEL: Record<StyleKey, string> = {
  casual: "کژوال",
  formal: "رسمی",
  semiformal: "نیمه‌رسمی",
  streetwear: "استریت‌ویر",
  sporty: "اسپرت",
};

export const STYLE_OPTIONS: StyleKey[] = ["casual", "formal", "semiformal", "streetwear", "sporty"];

export type OccasionKey =
  | "university" | "work" | "date" | "party" | "everyday" | "travel" | "ceremony" | "any";

export const OCCASION_LABEL: Record<OccasionKey, string> = {
  university: "دانشگاه",
  work: "محل کار",
  date: "قرار",
  party: "مهمانی",
  everyday: "بیرون / روزمره",
  travel: "سفر",
  ceremony: "مراسم",
  any: "فرقی نمی‌کند",
};

export const OCCASION_OPTIONS: OccasionKey[] = ["university", "work", "date", "party", "everyday", "travel", "ceremony", "any"];

/**
 * Per-category styling opinion (0–2 per axis; 0 = no opinion).
 * Written once for the categories the catalogue stocks, in the same spirit as
 * `COMPLEMENTS` in the storefront presentation layer. A category with no row
 * simply has no style/occasion opinion — the engine still scores colour,
 * category fit and availability, and the reasons stay honest.
 */
type CategoryProfile = { styles: Partial<Record<StyleKey, number>>; occasions: Partial<Record<OccasionKey, number>> };

const CATEGORY_PROFILE: Record<string, CategoryProfile> = {
  "مانتو و بارانی": { styles: { casual: 2, semiformal: 1, streetwear: 1 }, occasions: { everyday: 2, university: 1, work: 1, travel: 2, date: 1 } },
  "پالتو": { styles: { formal: 2, semiformal: 2, casual: 1 }, occasions: { work: 2, ceremony: 2, date: 1, everyday: 1 } },
  "کت و بلیزر": { styles: { formal: 2, semiformal: 2, casual: 1 }, occasions: { work: 2, ceremony: 1, university: 1, date: 1, party: 1 } },
  "شومیز": { styles: { semiformal: 2, casual: 1, formal: 1 }, occasions: { work: 2, date: 2, university: 1, party: 1, ceremony: 1 } },
  "پیراهن": { styles: { casual: 2, streetwear: 1, sporty: 1 }, occasions: { everyday: 2, university: 2, travel: 1, party: 1 } },
  "شلوار": { styles: { casual: 2, formal: 1, semiformal: 1, streetwear: 1 }, occasions: { everyday: 2, university: 2, work: 1, travel: 2 } },
  "بافت": { styles: { casual: 2, semiformal: 1 }, occasions: { everyday: 2, university: 1, work: 1, travel: 1 } },
  "کفش": { styles: { casual: 2, sporty: 2, streetwear: 1 }, occasions: { everyday: 2, university: 1, travel: 1 } },
  "کلاه": { styles: { streetwear: 2, casual: 1, sporty: 1 }, occasions: { everyday: 1, travel: 1 } },
  "اکسسوری": { styles: { casual: 1, semiformal: 1 }, occasions: { party: 1, date: 1, everyday: 1 } },
};

/* ============================================================
   Try-On eligibility — business logic, not CSS.
   Retail AND try-on-capable AND sellable. Wholesale never.
   `Product.tryOn` is the minimum extensible capability flag
   (additive, backward compatible); derived permission for
   garment categories seeds it where the store can honestly
   support the flow today. Accessories are never eligible.
   ============================================================ */

/** Garment categories the try-on flow can honestly serve today. */
const TRYON_CAPABLE_CATEGORIES =
  /^(مانتو و بارانی|پالتو|کت و بلیزر|پیراهن|شومیز|شلوار|بافت|کفش|کتانی|بوت|پیراهن یک‌تکه)$/;

/**
 * The single authority for “does this product offer پرو مجازی?”.
 * Called by the Product Card, the PDP and the try-on surface — the entry
 * points render the action only when this returns true, so eligibility is
 * never decided by hiding CSS.
 */
export function tryOnEligible(p: Product): boolean {
  // Wholesale-only records never try on. Retail means: a real cash price.
  if (!(p.retailPrice > 0)) return false;
  // Only published products may enter a shopper-facing flow.
  if (p.status !== "published") return false;
  // Explicit capability flag wins when the catalogue carries one.
  if (p.tryOn !== undefined) return p.tryOn;
  // Derived capability: garments yes, accessories no.
  return TRYON_CAPABLE_CATEGORIES.test(p.category.trim());
}

/* ============================================================
   Try-On provider boundary (§8)

   The intended pipeline is: Product → Try-On → authentication (if required)
   → quota/credit verification → provider → result.

   No real try-on provider integration exists in this repository. The boundary
   below is therefore honest by construction: `configured` is false, so the
   try-on surface presents a clear "service not connected" state instead of a
   fabricated result. Quota/credit checks belong on the server side of this
   boundary when a provider lands — no client-only quota is implemented. When
   a real provider is wired, replace this constant with the provider contract;
   the UI is already shaped around it.
   ============================================================ */

export const TRYON_PROVIDER: { configured: boolean; label: string } = {
  configured: false,
  label: "پرو مجازی",
};

/* ============================================================
   Colour harmony — deterministic, explainable.
   ============================================================ */

type Hsl = { h: number; s: number; l: number };

function hexToHsl(hex: string): Hsl {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

/** A colour is "quiet" when it plays well with anything: neutrals and near-neutrals. */
export function isQuietColor(color: Colorway): boolean {
  const { s, l } = hexToHsl(color.hex);
  return s < 0.28 || l < 0.16 || l > 0.86;
}

/**
 * 0–1 harmony between two colourways. Explainable families:
 *  - a quiet colour harmonises with everything (سفید با زرشکی);
 *  - identical/similar hues harmonise (tonal);
 *  - clearly clashing loud colours simply earn nothing.
 */
export function colorHarmony(a: Colorway, b: Colorway): number {
  if (isQuietColor(a) || isQuietColor(b)) return 1;
  const x = hexToHsl(a.hex), y = hexToHsl(b.hex);
  const dh = Math.min(Math.abs(x.h - y.h), 1 - Math.abs(x.h - y.h)); // 0..0.5
  if (dh < 0.083) return x.l * y.l > 0.56 && Math.min(x.l, y.l) < 0.44 ? 0.9 : 0.7; // tonal, needs light/dark contrast
  if (Math.abs(dh - 0.5) < 0.083) return 0.6; // complementary — deliberate contrast
  if (dh < 0.166) return 0.7;                 // analogous
  return 0;                                    // two loud, unrelated colours — no claim
}

/* ============================================================
   Recommendation engine v1
 * ============================================================ */

export type OutfitSelection = Partial<Record<OutfitRole, { productId: string; colorId?: string }>>;

export type RecommendationContext = {
  style?: StyleKey;
  occasion?: OccasionKey;
  /** what is already on the outfit — colour harmony is scored against it */
  selection?: OutfitSelection;
  /** role the candidate would fill */
  role: OutfitRole;
};

export type RecommendationCandidate = {
  product: Product;
  /** 0–100, monotonic in the factors below; NOT a percentage claim */
  score: number;
  /** deterministic Persian reasons, ordered by the factor that earned them */
  reasons: string[];
  /** score dimensions where meaningful (Final Look breakdown) */
  dimensions: { categoryFit: number; colorHarmony: number; style: number; occasion: number };
};

export type CompatibilityAdjustment = {
  /** product id the adjustment targets */
  productId: string;
  /** strong_match | match | neutral | conflict (Phase 2 explicit relations) */
  level: "strong_match" | "match" | "neutral" | "conflict";
};

/** Weights stay inside the domain and are never shown to admins or shoppers. */
const WEIGHTS = { categoryFit: 34, colorHarmony: 26, style: 20, occasion: 12, adjustment: 26 } as const;

const ADJUSTMENT_DELTA: Record<CompatibilityAdjustment["level"], number> = {
  strong_match: WEIGHTS.adjustment,
  match: Math.round(WEIGHTS.adjustment * 0.55),
  neutral: 0,
  conflict: -1000, // excluded from normal recommendations entirely
};

/**
 * Which roles can legitimately fill a given outfit slot. A dress may stand in
 * for top or bottom (and ousts both); headwear is a kind of accessory; nothing
 * else crosses — a shirt is never a pair of trousers.
 */
const ROLE_FILL: Record<OutfitRole, OutfitRole[]> = {
  top: ["top", "dress"],
  bottom: ["bottom", "dress"],
  dress: ["dress"],
  outerwear: ["outerwear"],
  shoes: ["shoes"],
  headwear: ["headwear"],
  accessory: ["accessory", "headwear"],
};

const roleCategoryAffinity = (candidateRole: OutfitRole, presentRole: OutfitRole): number => {
  if (candidateRole === presentRole) return 0;      // same slot: no complement claim
  if (candidateRole === "accessory" || presentRole === "accessory") return 0.6;
  if (candidateRole === "outerwear" || presentRole === "outerwear") return 1;  // outer layer completes anything beneath
  if (candidateRole === "shoes" || presentRole === "shoes") return 0.9;
  if (candidateRole === "bottom" || presentRole === "bottom") return 0.9;
  return 0.7; // top↔dress style neighbours
};

/**
 * Rank published retail products for one outfit slot.
 *
 * Guarantees:
 *  - only published retail products with stock are ever returned;
 *  - the product itself (and any product already selected for THIS role) is
 *    never a candidate — the wizard replaces by slot instead of duplicating;
 *  - output is deterministically ordered (score desc, catalogue index asc);
 *  - every candidate carries at least one honest reason.
 */
export function recommendFor(
  catalogue: Product[],
  ctx: RecommendationContext,
  adjustments: CompatibilityAdjustment[] = [],
  limit = 12,
): RecommendationCandidate[] {
  const selection = ctx.selection ?? {};
  const selectedProducts = Object.values(selection)
    .map((item) => catalogue.find((p) => p.id === item?.productId))
    .filter((p): p is Product => !!p);

  const pool = catalogue.filter((p) =>
    p.status === "published" && p.retailPrice > 0 && p.stock > 0
    && p.id !== selection[ctx.role]?.productId
    && ROLE_FILL[ctx.role].includes(outfitRoleOf(p)),
  );

  const adjustmentFor = new Map<string, CompatibilityAdjustment["level"]>();
  for (const adj of adjustments) adjustmentFor.set(adj.productId, adj.level);

  const scored = pool.map((product) => {
    const reasons: string[] = [];
    const candidateRole = outfitRoleOf(product);

    /* ── category / role fit against what is already selected ── */
    let categoryFit = 0.5;
    if (selectedProducts.length) {
      categoryFit = selectedProducts.reduce(
        (sum, sel) => sum + roleCategoryAffinity(candidateRole, outfitRoleOf(sel)),
        0,
      ) / selectedProducts.length;
    }

    /* ── colour harmony against the selected pieces ── */
    let harmony = 0.5;
    const harmonyNotes: string[] = [];
    if (selectedProducts.length) {
      const chosen = product.colors[0];
      const pairs = selectedProducts
        .map((sel) => {
          const selColor = selection[outfitRoleOf(sel)]?.colorId;
          const other = sel.colors.find((c) => c.id === selColor) ?? sel.colors[0];
          if (!chosen || !other) return 0.5;
          return colorHarmony(chosen, other);
        });
      harmony = pairs.reduce((a, b) => a + b, 0) / pairs.length;
      if (pairs.length && harmony >= 0.9) harmonyNotes.push("✓ هماهنگی رنگ");
    }

    /* ── curated style / occasion opinion ── */
    const profile = CATEGORY_PROFILE[product.category.trim()];
    const styleScore = ctx.style ? (profile?.styles[ctx.style] ?? 0) / 2 : 0.5;
    if (ctx.style && (profile?.styles[ctx.style] ?? 0) >= 2) reasons.push(`✓ مناسب استایل ${STYLE_LABEL[ctx.style]}`);
    const occasionScore = ctx.occasion && ctx.occasion !== "any"
      ? (profile?.occasions[ctx.occasion] ?? 0) / 2
      : 0.5;
    if (ctx.occasion && ctx.occasion !== "any" && (profile?.occasions[ctx.occasion] ?? 0) >= 2)
      reasons.push(`✓ مناسب ${OCCASION_LABEL[ctx.occasion]}`);

    /* ── explicit relations (Phase 2) — supplement, never replace ── */
    let adjustment = 0;
    const level = adjustmentFor.get(product.id);
    if (level && level !== "neutral") {
      adjustment = ADJUSTMENT_DELTA[level];
      if (level === "strong_match") reasons.push("انتخاب کلبه");
      if (level === "conflict") reasons.push("با این ست هماهنگی ندارد");
    }

    const base =
      WEIGHTS.categoryFit * categoryFit +
      WEIGHTS.colorHarmony * harmony +
      WEIGHTS.style * styleScore +
      WEIGHTS.occasion * occasionScore;

    const score = Math.max(0, Math.min(100, Math.round(base + adjustment)));

    reasons.unshift(...harmonyNotes);
    if (!reasons.length && categoryFit >= 0.9) reasons.push("✓ مکمل قطعات انتخاب‌شده");
    if (!reasons.length) reasons.push("✓ موجود در آرشیو کلبه");

    return {
      product,
      score,
      reasons: Array.from(new Set(reasons)).slice(0, 3),
      dimensions: { categoryFit, colorHarmony: harmony, style: styleScore, occasion: occasionScore },
    } satisfies RecommendationCandidate;
  });

  const visible = scored.filter((c) => adjustmentFor.get(c.product.id) !== "conflict");

  return visible
    .sort((a, b) =>
      b.score - a.score
      || a.product.id.localeCompare(b.product.id)) // stable tie-break: never reshuffles
    .slice(0, limit);
}

/* ============================================================
   Final Look — one compatibility score from the SAME engine.
   ============================================================ */

export type LookAssessment = {
  /** 0–100 coherence of the current outfit */
  score: number;
  dimensions: { colorHarmony: number; style: number; occasion: number };
  reasons: string[];
};

function pairScore(a: Product, aColorId: string | undefined, b: Product, bColorId: string | undefined, ctx: { style?: StyleKey; occasion?: OccasionKey }) {
  const aColor = a.colors.find((c) => c.id === aColorId) ?? a.colors[0];
  const bColor = b.colors.find((c) => c.id === bColorId) ?? b.colors[0];
  const harmony = aColor && bColor ? colorHarmony(aColor, bColor) : 0.5;
  const aRole = outfitRoleOf(a), bRole = outfitRoleOf(b);
  const fit = roleCategoryAffinity(aRole, bRole);
  const aProfile = CATEGORY_PROFILE[a.category.trim()], bProfile = CATEGORY_PROFILE[b.category.trim()];
  const style = ctx.style
    ? ((aProfile?.styles[ctx.style] ?? 0) + (bProfile?.styles[ctx.style] ?? 0)) / 4
    : 0.5;
  const occasion = ctx.occasion && ctx.occasion !== "any"
    ? ((aProfile?.occasions[ctx.occasion] ?? 0) + (bProfile?.occasions[ctx.occasion] ?? 0)) / 4
    : 0.5;
  const score = (WEIGHTS.categoryFit * fit + WEIGHTS.colorHarmony * harmony) / (WEIGHTS.categoryFit + WEIGHTS.colorHarmony) * 0.7
    + (WEIGHTS.style * style + WEIGHTS.occasion * occasion) / (WEIGHTS.style + WEIGHTS.occasion) * 0.3;
  return { score, harmony, style, occasion, fit };
}

/**
 * Coherence of a whole outfit — deterministic, derived from the same factors
 * the recommendation ranking uses, so the Final Look score and the wizard's
 * suggestions can never disagree about the same pair.
 */
export function assessLook(
  catalogue: Product[],
  selection: OutfitSelection,
  ctx: { style?: StyleKey; occasion?: OccasionKey } = {},
): LookAssessment {
  const entries = Object.entries(selection).filter(([, item]) => !!item) as [OutfitRole, { productId: string; colorId?: string }][];
  const items = entries
    .map(([role, item]) => ({ role, product: catalogue.find((p) => p.id === item.productId) }))
    .filter((entry): entry is { role: OutfitRole; product: Product } => !!entry.product);
  if (items.length < 2) {
    return { score: items.length ? 100 : 0, dimensions: { colorHarmony: 1, style: 0.5, occasion: 0.5 }, reasons: [] };
  }

  let sum = 0, harmonySum = 0, styleSum = 0, occasionSum = 0, count = 0;
  const reasons: string[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const result = pairScore(a.product, entries.find(([role]) => role === a.role)?.[1]?.colorId, b.product, entries.find(([role]) => role === b.role)?.[1]?.colorId, ctx);
      sum += result.score; harmonySum += result.harmony; styleSum += result.style; occasionSum += result.occasion; count++;
      if (result.harmony >= 0.9) reasons.push("✓ هماهنگی رنگ");
      if (result.score < 0.45) reasons.push(`⚠ ${ROLE_LABEL[a.role]} و ${ROLE_LABEL[b.role]} هماهنگی ضعیف دارند`);
    }
  }

  /* capture the keys first: property narrowing is lost inside the `every` callback */
  const styleKey = ctx.style;
  const occasionKey = ctx.occasion && ctx.occasion !== "any" ? ctx.occasion : undefined;
  if (styleKey && items.every(({ product }) => (CATEGORY_PROFILE[product.category.trim()]?.styles[styleKey] ?? 0) >= 1))
    reasons.push(`✓ مناسب استایل ${STYLE_LABEL[styleKey]}`);
  if (occasionKey && items.every(({ product }) => (CATEGORY_PROFILE[product.category.trim()]?.occasions[occasionKey] ?? 0) >= 1))
    reasons.push(`✓ مناسب ${OCCASION_LABEL[occasionKey]}`);

  return {
    score: Math.round((sum / count) * 100),
    dimensions: { colorHarmony: harmonySum / count, style: styleSum / count, occasion: occasionSum / count },
    reasons: Array.from(new Set(reasons)).slice(0, 4),
  };
}
