import type { Colorway, Product, ProductPricing } from "./catalog";
import { mediaSrc, rialToToman } from "./experience-api";

/* Single normalisation point: GET /products (rial, variants, metadata) → storefront Product (toman, images, sizes).
   Availability stays WMS-derived (`available`), prices stay server-derived — nothing is invented here. */

/** Agent C uses `gender` (men/women/…) while the taxonomy tables use codes (male/female/…): bridge the two vocabularies. */
const GENDER_BRIDGE: Record<string, string> = { men: "male", women: "female", unisex: "unisex", kids: "kids" };

const COLOR_HEX: [RegExp, string][] = [
  [/مشکی|سیاه/, "#1F1F1F"], [/سفید|یخی/, "#F7F7F5"], [/کرم|استخوانی|بژ/, "#EFE4CF"], [/شنی|خاکی/, "#CDB891"], [/شتری/, "#B5895A"],
  [/طوسی|خاکستری|زغالی|ذغالی/, "#8C8F94"], [/سرمه/, "#1F2C4D"], [/قهوه|کاراملی|شکلاتی/, "#6B4A33"], [/زیتونی|یشمی/, "#6E7147"],
  [/زرشکی|شرابی/, "#6E1F2B"], [/صورتی|گلبهی/, "#E7A9B5"], [/قرمز/, "#B3261E"], [/نارنجی|آجری/, "#C1613B"], [/زرد|خردلی/, "#D1A33A"],
  [/سبز/, "#3F6B4E"], [/آبی|جین/, "#3C5E8C"], [/بنفش|یاسی/, "#6D4E8C"],
];
export const colorHex = (name: string) => COLOR_HEX.find(([re]) => re.test(name))?.[1] ?? "#9AA3B5";

type CatalogRow = {
  id: string; brand: string; name: string; category: string; description?: string; cashPriceRial: string; installmentPriceRial: string | null;
  wholesalePriceRial?: string | null; wholesaleMoq?: number | null; ownerType?: string;
  genderCode?: string | null; gender?: string | null; seasons?: string[];
  metadata?: Record<string, unknown>; variants?: { id: string; sku: string; size: string | null; color: string | null; available?: number; retailAvailableStock?: number; reserved?: number; incoming?: number; damaged?: number }[];
  available?: number; supplierId?: string | null; discountPercent?: number; installmentEnabled?: boolean;
  pricing?: ProductPricing;
  series?: { id: string; name: string; colorLabel: string | null; pieces: number; composition: Record<string, number>; minOrderSeries: number; pricePerSeriesRial: string | null; availableSeries: number }[];
};

export function adaptCatalogProduct(row: CatalogRow): Product & { variants: NonNullable<CatalogRow["variants"]>; sizes: string[]; installmentEnabled?: boolean } {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const variants = row.variants ?? [];
  const colorNames = [...new Set(variants.map((v) => v.color).filter((c): c is string => Boolean(c)))];
  const colors: Colorway[] = colorNames.map((name) => ({ id: name, name, hex: colorHex(name) }));
  const images = (Array.isArray(meta.images) ? meta.images : [])
    .map((ref) => {
      const r = ref as { fileId?: string | null; url?: string };
      return r.fileId ? mediaSrc(`/api/v1/product-media/${r.fileId}`) : r.url && /^https?:\/\//.test(r.url) ? r.url : undefined;
    }).filter((u): u is string => Boolean(u));
  const cutout = meta.cutout as Product["cutout"] | null | undefined;
  // Wholesale channel data (items 245-247): series definitions, MOQ and audience/season codes ride the server row.
  const wholesaleFrom = rialToToman(row.wholesalePriceRial);
  const sizeCodes = [...new Set(variants.map((v) => v.size).filter((s): s is string => Boolean(s)))];
  // Colour-scoped media comes from the CMS-owned metadata (`metadata.colorMedia`) when it exists —
  // we only pass it through, we never hand-maintain demo colour→photo mappings here.
  const colorMedia = (() => {
    const raw = meta.colorMedia;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => [key, Array.isArray(value) ? value.filter((u): u is string => typeof u === "string" && Boolean(u)) : []])
      .filter(([, urls]) => (urls as string[]).length);
    return entries.length ? Object.fromEntries(entries) as Record<string, string[]> : undefined;
  })();
  const series: Product["series"] = (row.series ?? []).map((entry) => ({
    id: entry.id, name: entry.name, pieces: entry.pieces, composition: entry.composition,
    moqSeries: entry.minOrderSeries, pricePerSeries: rialToToman(entry.pricePerSeriesRial),
    available: entry.availableSeries > 0, colorIds: entry.colorLabel ? [entry.colorLabel] : [],
  }));
  const isSupplierProduct = row.ownerType === "supplier" || Boolean(row.supplierId);
  return {
    id: row.id, status: "published", sku: variants[0]?.sku ?? "", brand: row.brand, name: row.name,
    supplier: isSupplierProduct ? "تأمین‌کننده بازارچه" : "کلبه وینتیج", supplierId: row.supplierId ?? "kolbe", category: row.category,
    retailPrice: rialToToman(row.cashPriceRial), installmentPrice: row.installmentPriceRial ? rialToToman(row.installmentPriceRial) : undefined,
    wholesaleFrom, rating: 0, reviews: 0, colors: colors.length ? colors : [{ id: "default", name: "تک‌رنگ", hex: "#9AA3B5" }],
    images: images.length ? images : ["data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3 4"><rect width="3" height="4" fill="#EFE7DA"/></svg>')],
    series, seriesCount: series.length, moq: row.wholesaleMoq ?? 1, stock: Number(row.available ?? 0),
    fabric: String(meta.fabric ?? "—") || "—", desc: row.description || "توضیحات این محصول در حال تکمیل است.",
    cutout: cutout ?? undefined,
    // §9/§36: the badge derives from the canonical resolved discount — never from a manual column.
    badge: row.pricing && row.pricing.discountPercent > 0 ? `٪${row.pricing.discountPercent.toLocaleString("fa-IR")} تخفیف` : undefined,
    pricing: row.pricing,
    genderCode: row.genderCode ?? GENDER_BRIDGE[row.gender ?? ""] ?? null,
    seasons: Array.isArray(row.seasons) ? row.seasons : [],
    variants, sizes: sizeCodes, installmentEnabled: row.installmentEnabled,
    ...(colorMedia ? { colorMedia } : {}),
  };
}
