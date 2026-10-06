import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../src/data/store";
import { complementsOf, similarTo } from "../src/components/storefront/recommendations";
import { sizesOf, mediaForColor, hasOwnMedia, lineThumbnail } from "../src/components/storefront/shared";

/**
 * Runs the presentation helpers against the store's real product list — the same
 * list the storefront renders — and dumps the result as data for units.mjs.
 */
function Probe() {
  const store = useStore();
  useEffect(() => {
    const retail = store.products.filter((p) => p.status === "published" && p.retailPrice > 0);
    const per: Record<string, unknown> = {};
    for (const product of retail) {
      const looks = complementsOf(product, retail);
      const alike = similarTo(product, retail);
      per[product.id] = {
        name: product.name,
        category: product.category,
        looks: looks.map((p) => p.id),
        lookCategories: looks.map((p) => p.category),
        alike: alike.map((p) => p.id),
        alikeCategories: alike.map((p) => p.category),
        sizes: sizesOf(product),
        colors: product.colors.map((c) => c.id),
        mediaOwn: Object.keys(product.colorMedia ?? {}).filter((id) => hasOwnMedia(product, id)),
        mediaLeaks: Object.entries(product.colorMedia ?? {})
          .flatMap(([colorId, list]) => (list ?? []).filter((url) => !product.images.includes(url)).map((url) => `${colorId}:${url}`)),
        colorMediaForeign: Object.entries(product.colorMedia ?? {})
          .filter(([colorId]) => !product.colors.some((c) => c.id === colorId))
          .map(([colorId]) => colorId),
        galleryFor: mediaForColor(product, product.colors[0]?.id).length,
        /* the same resolver the cart drawer and checkout use for a line thumbnail */
        thumbs: product.colors.map((color) => ({
          name: color.name,
          own: hasOwnMedia(product, color.id),
          src: lineThumbnail(product, color.name),
          /* the image the line *should* show: the colour's own first frame when it
             has one, otherwise the product's first frame */
          expected: mediaForColor(product, color.id)[0] ?? product.images[0] ?? "",
          ownFirst: (product.colorMedia?.[color.id] ?? [])[0] ?? "",
        })),
        thumbAnonymous: lineThumbnail(product, undefined),
        images: product.images,
      };
    }
    const stranger = { ...retail[0], id: "zz", category: "دسته‌ای که وجود ندارد" };
    const report = {
      products: retail.length,
      names: retail.map((p) => p.name),
      categories: Array.from(new Set(retail.map((p) => p.category))),
      perProduct: per,
      deterministic: retail.every((product) =>
        JSON.stringify(complementsOf(product, retail).map((p) => p.id)) === JSON.stringify(complementsOf(product, retail).map((p) => p.id)) &&
        JSON.stringify(similarTo(product, retail).map((p) => p.id)) === JSON.stringify(similarTo(product, retail).map((p) => p.id))),
      unknownCategory: {
        looks: complementsOf(stranger, retail).length,
        alike: similarTo(stranger, retail).length,
        /* no mapped complement must mean an empty rail, never a padded one */
        names: complementsOf(stranger, retail).map((p) => p.name),
      },
      unpublishedLeak: retail.some((p) =>
        complementsOf(p, retail).some((r) => r.status !== "published" || r.retailPrice <= 0) ||
        similarTo(p, retail).some((r) => r.status !== "published" || r.retailPrice <= 0)),
    };
    const target = document.getElementById("out");
    if (target) target.textContent = JSON.stringify(report);
  }, [store.products]);
  return null;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StoreProvider><Probe /></StoreProvider>,
);
