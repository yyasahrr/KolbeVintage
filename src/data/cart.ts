/* KOLBE — Retail cart line rules (Phase 1, Non-Core workstream)
 *
 * Pure validation shared by the storefront's single add-to-cart and the Style
 * Builder's "add the whole outfit" batch. The rules are exactly the ones the
 * storefront has always enforced (published retail product, per-product stock
 * respected across the whole cart); batching adds all-or-nothing semantics on
 * top WITHOUT creating a second cart — the lines stay ordinary RetailCartLine
 * entries and checkout keeps revalidating in `placeRetailOrder`.
 */
import type { Product } from "./catalog";
import type { RetailCartLine } from "./customer";

export type LineFailure = {
  productId: string;
  reason: "not_found" | "not_retail" | "out_of_stock" | "insufficient_stock";
};

export type BatchResult = {
  ok: boolean;
  failures: LineFailure[];
};

export const FAILURE_TEXT: Record<LineFailure["reason"], string> = {
  not_found: "این محصول دیگر در فروشگاه موجود نیست.",
  not_retail: "این محصول خرده‌فروشی نیست.",
  out_of_stock: "ناموجود شد.",
  insufficient_stock: "موجودی برای این تعداد کافی نیست.",
};

/**
 * Validate `incoming` lines against the catalogue and the cart they are about
 * to join. Never mutates anything. Aggregate stock is checked per product
 * across BOTH the existing cart and the batch, so a split outfit cannot slip
 * through in two halves.
 */
export function validateRetailLines(products: Product[], cart: RetailCartLine[], incoming: RetailCartLine[]): BatchResult {
  const failures: LineFailure[] = [];
  const requested = new Map<string, number>();
  for (const line of incoming) {
    if (line.qty <= 0) continue;
    requested.set(line.id, (requested.get(line.id) ?? 0) + line.qty);
  }
  const alreadyInCart = new Map<string, number>();
  for (const line of cart) alreadyInCart.set(line.id, (alreadyInCart.get(line.id) ?? 0) + line.qty);

  for (const [productId, qty] of requested) {
    const product = products.find((p) => p.id === productId);
    if (!product) { failures.push({ productId, reason: "not_found" }); continue; }
    if (!(product.retailPrice > 0)) { failures.push({ productId, reason: "not_retail" }); continue; }
    if (product.status !== "published") { failures.push({ productId, reason: "not_retail" }); continue; }
    if (product.stock < 1) { failures.push({ productId, reason: "out_of_stock" }); continue; }
    if ((alreadyInCart.get(productId) ?? 0) + qty > product.stock) { failures.push({ productId, reason: "insufficient_stock" }); continue; }
  }

  return { ok: failures.length === 0, failures };
}
