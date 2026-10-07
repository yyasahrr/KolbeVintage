/* KOLBE — Curated Style + Variant Compatibility domain (Phase 2)
 *
 * A Curated Style is an admin-created composition of EXISTING retail products.
 * It is NOT a product, not an inventory owner, not a bundle product and not
 * another cart entity: every purchasable line inside it remains an ordinary
 * retail Product Variant line (Phase 3 adds them to the EXISTING cart).
 *
 * Colour-Variant compatibility (§23) is defined at the Product Colour /
 * Presentation Variant level — NEVER per size SKU. Relations are canonical and
 * symmetric: one record per unordered pair, resolvable from either side (§28).
 *
 * Money rules (used by the admin preview here and by the storefront pricing in
 * Phase 3 — one source, never two):
 *  - all amounts are integers; only round/ceil, never float arithmetic;
 *  - the base subtotal is always computed from the CURRENT authoritative
 *    product price at call time;
 *  - UI totals are previews; the cart/order path recomputes before mutation.
 */
import type { Product } from "./catalog";
import { colorHarmony, outfitRoleOf, type OutfitRole, type CompatibilityAdjustment } from "./styling";

/* ============================================================
   Colour-variant compatibility relations (§23–§28)
   ============================================================ */

export type VariantRef = { productId: string; colorId: string };
export type RelationLevel = "strong_match" | "match" | "neutral" | "conflict";

export const RELATION_LABEL: Record<RelationLevel, string> = {
  strong_match: "خیلی مناسب",
  match: "مناسب",
  neutral: "خنثی",
  conflict: "نامناسب",
};

/**
 * One canonical record per unordered pair: `id` IS the sorted pair key, so
 * duplicates are structurally impossible and reverse lookup is exact.
 * Numeric weights stay inside the recommendation domain — admins only ever
 * see the four Persian labels (§27).
 */
export type VariantRelation = {
  id: string;
  a: VariantRef;
  b: VariantRef;
  level: RelationLevel;
  updatedAt: string;
};

export const canonicalKey = (x: VariantRef, y: VariantRef): string => {
  const ka = `${x.productId}::${x.colorId}`;
  const kb = `${y.productId}::${y.colorId}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/** The SAME relation resolves from either side (§28). */
export function levelBetween(relations: VariantRelation[], x: VariantRef, y: VariantRef): RelationLevel | undefined {
  if (x.productId === y.productId && x.colorId === y.colorId) return undefined;
  const key = canonicalKey(x, y);
  return relations.find((r) => r.id === key)?.level;
}

export type RelationRejection =
  | "self"             // a variant cannot relate to itself
  | "invalid_variant"  // product/colour does not exist
  | "not_retail"       // wholesale-only or unpublished product
  | "ok";

/** Pure pre-flight shared by the store action (authority) and the admin UI. */
export function checkRelation(catalogue: Product[], x: VariantRef, y: VariantRef): RelationRejection {
  if (x.productId === y.productId && x.colorId === y.colorId) return "self";
  const px = catalogue.find((p) => p.id === x.productId);
  const py = catalogue.find((p) => p.id === y.productId);
  if (!px || !py) return "invalid_variant";
  if (!px.colors.some((c) => c.id === x.colorId) || !py.colors.some((c) => c.id === y.colorId)) return "invalid_variant";
  /* retail domain only: published products with a real cash price */
  if (!(px.status === "published" && px.retailPrice > 0)) return "not_retail";
  if (!(py.status === "published" && py.retailPrice > 0)) return "not_retail";
  return "ok";
}

/**
 * Explicit relations touching the given selection, in the engine's adjustment
 * shape — the bridge between the admin graph and the recommendation engine
 * (§30). Manual relations supplement automatic scoring; they never replace it.
 */
export function relationsToAdjustments(relations: VariantRelation[], items: { productId: string; colorId?: string }[]): CompatibilityAdjustment[] {
  const out = new Map<string, CompatibilityAdjustment["level"]>();
  for (const item of items) {
    if (!item.colorId) continue;
    for (const relation of relations) {
      const isA = relation.a.productId === item.productId && relation.a.colorId === item.colorId;
      const isB = relation.b.productId === item.productId && relation.b.colorId === item.colorId;
      const other = isA ? relation.b : isB ? relation.a : null;
      if (!other) continue;
      const existing = out.get(other.productId);
      /* stronger knowledge wins; a conflict always wins */
      if (existing === "conflict") continue;
      if (relation.level === "conflict") out.set(other.productId, "conflict");
      else if (existing === "strong_match") continue;
      else if (relation.level !== "neutral") out.set(other.productId, relation.level);
    }
  }
  return Array.from(out, ([productId, level]) => ({ productId, level }));
}

/* ============================================================
   Curated Style records (§34–§40)
   ============================================================ */

export type CuratedStyleStatus = "draft" | "published" | "archived";

export const CURATED_STATUS_LABEL: Record<CuratedStyleStatus, string> = {
  draft: "پیش‌نویس",
  published: "منتشر شده",
  archived: "آرشیو شده",
};

export type CuratedStyleItem = {
  id: string;
  productId: string;
  /** pinned colour/presentation variant — customers pick SIZE, not colour (§48) */
  colorId: string;
  role: OutfitRole;
  sortOrder: number;
};

export type CuratedStylePricing = {
  discountType: "none" | "percentage" | "fixed";
  /** percentage (0–90) or fixed amount; ignored when discountType is "none" */
  discountValue: number;
  /** style discount needs at least this many active items */
  minimumActiveItems: number;
  /** when set, every listed role must be active for eligibility */
  requiredCoreItems: OutfitRole[];
};

export type CuratedStyleInstallments = {
  installmentEnabled: boolean;
  installmentPricingMode: "automatic" | "manual";
  /** ONE manual 4-installment total — never four unrelated values (§57) */
  manualInstallmentTotal?: number;
  applyStyleDiscountToInstallments: boolean;
};

export type CuratedStyle = {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: CuratedStyleStatus;
  items: CuratedStyleItem[];
  cover?: string;
  pricing: CuratedStylePricing;
  installments: CuratedStyleInstallments;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_PRICING: CuratedStylePricing = {
  discountType: "none",
  discountValue: 0,
  minimumActiveItems: 0,
  requiredCoreItems: [],
};

export const DEFAULT_INSTALLMENTS: CuratedStyleInstallments = {
  installmentEnabled: false,
  installmentPricingMode: "automatic",
  applyStyleDiscountToInstallments: true,
};

/** Roles a curated item can take — the shared outfit taxonomy (§36). */
export const CURATED_ROLES: OutfitRole[] = ["top", "bottom", "outerwear", "dress", "shoes", "headwear", "accessory"];

/**
 * The ONLY lens public surfaces may read curated styles through: anything that
 * is not published never leaves the admin boundary (§39).
 */
export const publicCuratedStyles = (styles: CuratedStyle[]): CuratedStyle[] =>
  styles.filter((s) => s.status === "published");

/* ============================================================
   Validation
   ============================================================ */

export type CuratedValidationIssue =
  | { code: "title"; note: string }
  | { code: "items"; note: string }
  | { code: "item_product"; note: string; productId: string }
  | { code: "item_color"; note: string; productId: string }
  | { code: "duplicate_role"; note: string; role: OutfitRole };

/** A curated product must be published retail; wholesale-only records are rejected. */
export const curatableProduct = (p: Product | undefined): boolean =>
  !!p && p.status === "published" && p.retailPrice > 0;

export function validateCuratedStyle(style: Pick<CuratedStyle, "title" | "items">, catalogue: Product[]): CuratedValidationIssue[] {
  const issues: CuratedValidationIssue[] = [];
  if (!style.title.trim()) issues.push({ code: "title", note: "عنوان استایل الزامی است." });
  if (!style.items.length) issues.push({ code: "items", note: "دست‌کم یک محصول انتخاب کنید." });
  const seenRoles = new Set<OutfitRole>();
  for (const item of style.items) {
    const product = catalogue.find((p) => p.id === item.productId);
    if (!curatableProduct(product)) {
      issues.push({ code: "item_product", note: "محصول نامعتبر یا غیرقابل خرده‌فروش است.", productId: item.productId });
      continue;
    }
    if (!product!.colors.some((c) => c.id === item.colorId)) {
      issues.push({ code: "item_color", note: "رنگ پین‌شده روی این محصول وجود ندارد.", productId: item.productId });
      continue;
    }
    if (seenRoles.has(item.role)) issues.push({ code: "duplicate_role", note: "برای هر نقش فقط یک قطعه.", role: item.role });
    seenRoles.add(item.role);
  }
  return issues;
}

/* ============================================================
   Pricing — active items, eligibility, discount, installments.
   `active` is the customer's enable/disable state (Phase 3); the
   admin preview passes every item as active.
   ============================================================ */

export type PricedLine = {
  item: CuratedStyleItem;
  product: Product;
  /** current authoritative unit price — never a client-stored price (§52) */
  unitPrice: number;
};

/**
 * Resolve priced lines for a style against the CURRENT catalogue. Items whose
 * product vanished, got unpublished or lost the pinned colour drop out
 * honestly; the caller surfaces them.
 */
export function resolveLines(style: CuratedStyle, catalogue: Product[], activeProductIds?: Set<string>): { lines: PricedLine[]; dropped: CuratedStyleItem[] } {
  const lines: PricedLine[] = [];
  const dropped: CuratedStyleItem[] = [];
  for (const item of [...style.items].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (activeProductIds && !activeProductIds.has(item.productId)) continue;
    const product = catalogue.find((p) => p.id === item.productId);
    if (!curatableProduct(product) || !product!.colors.some((c) => c.id === item.colorId)) {
      dropped.push(item);
      continue;
    }
    lines.push({ item, product: product!, unitPrice: product!.retailPrice });
  }
  return { lines, dropped };
}

export const subtotalOf = (lines: PricedLine[]): number =>
  lines.reduce((sum, line) => sum + line.unitPrice, 0);

export type DiscountAssessment = {
  eligible: boolean;
  /** why eligibility failed — shown verbatim in the UI (§53) */
  reason?: string;
  discount: number;
};

/** Style discount eligibility: minimumActiveItems + requiredCoreItems. */
export function assessDiscount(style: CuratedStyle, lines: PricedLine[]): DiscountAssessment {
  const { pricing } = style;
  if (pricing.discountType === "none" || pricing.discountValue <= 0) {
    return { eligible: false, discount: 0 };
  }
  if (lines.length < pricing.minimumActiveItems) {
    return {
      eligible: false,
      reason: `این تخفیف به دست‌کم ${pricing.minimumActiveItems} قلم فعال نیاز دارد.`,
      discount: 0,
    };
  }
  const missing = pricing.requiredCoreItems.filter((role) => !lines.some((line) => line.item.role === role));
  if (missing.length) {
    return { eligible: false, reason: "برای این تخفیف همه قطعات اصلی استایل باید فعال باشند.", discount: 0 };
  }
  const subtotal = subtotalOf(lines);
  const discount = pricing.discountType === "percentage"
    ? Math.min(subtotal, Math.round(subtotal * Math.min(90, Math.max(0, pricing.discountValue)) / 100))
    : Math.min(subtotal, Math.max(0, Math.round(pricing.discountValue)));
  return { eligible: true, discount };
}

export type InstallmentAssessment = {
  mode: "none" | "manual" | "automatic";
  total: number;
  /** deterministic quarter — displayed as 4 × perInstallment (§56) */
  perInstallment: number;
  /** the manual total was rejected because the composition changed (§58) */
  manualInvalidReason?: string;
};

/**
 * Installment precedence, implemented EXACTLY once (§59):
 *   manual    IF installmentEnabled AND mode=manual AND the full published
 *             composition is active with its pinned colours;
 *   automatic IF installmentEnabled;
 *   none      otherwise.
 * `applyStyleDiscountToInstallments` affects AUTOMATIC only — a manual total
 * is never recomputed and never proportionally redistributed (§58).
 */
export function assessInstallments(style: CuratedStyle, lines: PricedLine[], discount: DiscountAssessment): InstallmentAssessment {
  if (!style.installments.installmentEnabled) return { mode: "none", total: 0, perInstallment: 0 };

  const fullComposition = style.items.length > 0
    && lines.length === style.items.length
    && lines.every((line) => line.item.colorId === style.items.find((i) => i.id === line.item.id)?.colorId);

  if (style.installments.installmentPricingMode === "manual") {
    const manual = style.installments.manualInstallmentTotal ?? 0;
    if (fullComposition && manual > 0) {
      return { mode: "manual", total: manual, perInstallment: Math.ceil(manual / 4) };
    }
    if (!fullComposition) {
      const changed = style.items.length - lines.length;
      return {
        mode: "automatic",
        total: 0,
        perInstallment: 0,
        manualInvalidReason: changed > 0
          ? `قسط دستی فقط برای استایل کامل معتبر است (${changed} قلم غیرفعال شده است). محاسبه خودکار جایگزین شد.`
          : "قسط دستی فقط برای استایل کامل با رنگ‌های پین‌شده معتبر است. محاسبه خودکار جایگزین شد.",
      };
    }
    // manual mode with no configured total → automatic fallback below
  }

  const subtotal = subtotalOf(lines);
  const base = style.installments.applyStyleDiscountToInstallments && discount.eligible
    ? subtotal - discount.discount
    : subtotal;
  return { mode: "automatic", total: base, perInstallment: Math.ceil(base / 4) };
}

/* ============================================================
   Commerce math — discount allocation + order snapshots (§64–§68)
   One implementation; the storefront preview and the order-time
   recompute both call THESE functions, never parallel copies.
   ============================================================ */

/**
 * Deterministic style-discount allocation (§68): proportional to each line's
 * pre-discount subtotal, floored, with the remainder handed out one unit at a
 * time in catalogue order (item sortOrder, then item id). The SUM of the
 * allocations ALWAYS equals the style discount exactly — no rounding dust.
 */
export function allocateStyleDiscount(lines: PricedLine[], discount: number, qtys: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (discount <= 0 || !lines.length) return out;
  const qty = (line: PricedLine) => qtys.get(line.item.productId) ?? 1;
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * qty(line), 0);
  if (subtotal <= 0) return out;
  let allocated = 0;
  const ranked = [...lines].sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.item.id.localeCompare(b.item.id));
  for (const line of ranked) {
    const share = Math.floor((discount * line.unitPrice * qty(line)) / subtotal);
    out.set(line.item.productId, share);
    allocated += share;
  }
  let remainder = discount - allocated;
  let index = 0;
  while (remainder > 0 && ranked.length) {
    const line = ranked[index % ranked.length];
    out.set(line.item.productId, (out.get(line.item.productId) ?? 0) + 1);
    remainder -= 1;
    index += 1;
  }
  return out;
}

export type StyleSelection = {
  /** product ids the customer left active */
  activeProductIds: Set<string>;
  /** chosen size per active product — sizes may change without breaking a manual plan */
  sizes: Map<string, string>;
  /** effective quantity per active product (default 1) */
  qtys: Map<string, number>;
};

export type StylePricingPreview = {
  lines: PricedLine[];
  dropped: CuratedStyleItem[];
  activeCount: number;
  totalCount: number;
  allActive: boolean;
  subtotal: number;
  discount: DiscountAssessment;
  installments: InstallmentAssessment;
  payable: number;
};

/**
 * The ONE style-pricing pipeline: resolve → assess → totals. `resolveLines`
 * prices from the CURRENT catalogue, so every caller (card, detail, cart
 * revalidation, order snapshot) sees the same authoritative numbers (§52).
 */
export function priceStyle(style: CuratedStyle, catalogue: Product[], selection?: StyleSelection): StylePricingPreview {
  const { lines, dropped } = resolveLines(style, catalogue, selection?.activeProductIds);
  const qtys = selection?.qtys ?? new Map<string, number>();
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * (qtys.get(line.item.productId) ?? 1), 0);
  const discount = assessDiscount(
    style,
    lines.map((line) => ({ ...line, unitPrice: line.unitPrice * (qtys.get(line.item.productId) ?? 1) })),
  );
  const installments = assessInstallments(style, lines.map((line) => ({ ...line, unitPrice: line.unitPrice * (qtys.get(line.item.productId) ?? 1) })), discount);
  const payable = Math.max(0, subtotal - discount.discount);
  return {
    lines, dropped,
    activeCount: lines.length,
    totalCount: style.items.length,
    allActive: !selection || lines.length === style.items.length,
    subtotal,
    discount,
    installments,
    payable,
  };
}

/* ============================================================
   Compatibility preview — the SAME recommendation domain (§38)
   ============================================================ */

export type StyleCompatibilityPreview = {
  score: number;
  reasons: string[];
  warnings: string[];
  strongRelations: number;
};

/**
 * Score a style's composition with the shared styling factors, enriched by the
 * explicit colour-variant relations that touch its items. Deterministic; no
 * random numbers, no invented metadata.
 */
export function previewCompatibility(style: CuratedStyle, catalogue: Product[], relations: VariantRelation[]): StyleCompatibilityPreview {
  const reasons: string[] = [];
  const warnings: string[] = [];

  /* relations that connect two items INSIDE this style */
  const inside = relations.filter((r) =>
    style.items.some((i) => i.productId === r.a.productId && i.colorId === r.a.colorId)
    && style.items.some((i) => i.productId === r.b.productId && i.colorId === r.b.colorId));
  const strong = inside.filter((r) => r.level === "strong_match").length;
  if (strong) reasons.push(`✓ ${strong} ارتباط خیلی مناسب`);
  for (const relation of inside) {
    if (relation.level === "conflict") warnings.push("⚠ دو قطعه از این استایل هماهنگی ضعیف دارند");
  }

  const items = style.items
    .map((item) => ({ item, product: catalogue.find((p) => p.id === item.productId) }))
    .filter((entry): entry is { item: CuratedStyleItem; product: Product } => curatableProduct(entry.product));

  let score = 0;
  if (items.length >= 2) {
    let sum = 0, count = 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        sum += pairScore(items[i].product, items[i].item.colorId, items[j].product, items[j].item.colorId, relations);
        count++;
      }
    }
    score = Math.round((sum / count) * 100);
  } else if (items.length === 1) {
    score = 100;
  }
  if (strong) reasons.push("انتخاب کلبه");

  return { score, reasons: reasons.slice(0, 3), warnings: Array.from(new Set(warnings)).slice(0, 2), strongRelations: strong };
}

function pairScore(a: Product, aColorId: string, b: Product, bColorId: string, relations: VariantRelation[]): number {
  const aColor = a.colors.find((c) => c.id === aColorId) ?? a.colors[0];
  const bColor = b.colors.find((c) => c.id === bColorId) ?? b.colors[0];
  let score = aColor && bColor ? colorHarmony(aColor, bColor) : 0.5;
  /* different outfit slots are complements by construction */
  if (outfitRoleOf(a) !== outfitRoleOf(b)) score = Math.max(score, 0.55);
  const level = levelBetween(relations, { productId: a.id, colorId: aColorId }, { productId: b.id, colorId: bColorId });
  if (level === "strong_match") score = Math.min(1, score + 0.35);
  if (level === "match") score = Math.min(1, score + 0.15);
  if (level === "conflict") score = Math.min(score, 0.3);
  return score;
}
