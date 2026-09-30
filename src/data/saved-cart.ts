/* Saved cart (Req 343) — thin frontend adapter over the canonical GET/PUT /api/v1/profile/saved-cart.
   For a signed-in customer the server copy IS the cart: edits are applied optimistically in memory and
   written through (debounced) to the endpoint; the server response (re-validated product/variant/stock)
   is then adopted. Nothing is persisted to localStorage — no shadow cart. Guests keep an in-memory cart
   that is merged into the server cart once at login. Prices are never stored; they are re-read from Pricing. */
import { useCallback, useEffect, useRef, useState } from "react";
import { profileApi, type SavedCart } from "./experience-api";

export type CartLineLike = { id: string; qty: number; size: string; color: string };
type VariantLike = { id: string; size: string | null; color: string | null };
type ProductLike = { id: string; variants?: VariantLike[] };
export type SavedCartStatus = "idle" | "loading" | "saving" | "ready" | "error";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QTY = 20;

/** Storefront line → canonical item (variant resolved from the catalogue's size/colour). */
export function toSavedItems(lines: CartLineLike[], products: ProductLike[]) {
  return lines.filter((l) => UUID.test(l.id) && l.qty > 0).map((l) => {
    const variants = products.find((p) => p.id === l.id)?.variants ?? [];
    const variant = variants.find((v) => (v.size ?? "") === l.size && (v.color ?? "") === l.color)
      ?? variants.find((v) => (v.size ?? "") === l.size) ?? null;
    return { productId: l.id, variantId: variant?.id ?? null, quantity: Math.min(MAX_QTY, Math.max(1, Math.round(l.qty))) };
  });
}

/** Canonical response → storefront lines; unavailable items are dropped and counted so the UI can explain it. */
export function fromSavedCart(cart: SavedCart): { lines: CartLineLike[]; dropped: number; adjusted: number } {
  let dropped = 0; let adjusted = 0;
  const lines: CartLineLike[] = [];
  for (const item of cart.items) {
    if (item.unavailable || item.quantityAdjusted < 1) { dropped += 1; continue; }
    if (item.quantityAdjusted < item.quantity) adjusted += 1;
    lines.push({ id: item.productId, qty: item.quantityAdjusted, size: item.variant?.size ?? "", color: item.variant?.color ?? "" });
  }
  return { lines, dropped, adjusted };
}

/** Sum quantities of identical lines (same product/size/colour), capped at the server limit. */
export function mergeLines(a: CartLineLike[], b: CartLineLike[]): CartLineLike[] {
  const out: CartLineLike[] = a.map((l) => ({ ...l }));
  for (const line of b) {
    const hit = out.find((l) => l.id === line.id && l.size === line.size && l.color === line.color);
    if (hit) hit.qty = Math.min(MAX_QTY, hit.qty + line.qty); else out.push({ ...line, qty: Math.min(MAX_QTY, line.qty) });
  }
  return out;
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : "ارتباط با سرور برقرار نشد.");

export function useSavedCart<L extends CartLineLike>(userId: string | null, products: ProductLike[]) {
  const [lines, setLines] = useState<L[]>([]);
  const [status, setStatus] = useState<SavedCartStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const edit = useRef(0);                         // bumps on every local edit; stale responses are ignored
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productsRef = useRef(products);
  productsRef.current = products;
  const userRef = useRef(userId);
  userRef.current = userId;

  const adopt = useCallback((cart: SavedCart) => {
    const { lines: next, dropped, adjusted } = fromSavedCart(cart);
    setLines(next as L[]);
    setUpdatedAt(cart.updatedAt);
    setNotice(dropped ? `${dropped} کالا دیگر موجود نیست و از سبد حذف شد.` : adjusted ? "تعداد برخی کالاها با موجودی انبار هماهنگ شد." : null);
  }, []);

  const push = useCallback(async (next: CartLineLike[], version: number) => {
    setStatus("saving");
    try {
      const cart = await profileApi.saveCart(toSavedItems(next, productsRef.current));
      if (version !== edit.current || !userRef.current) return;   // a newer edit is on its way
      adopt(cart); setError(null); setStatus("ready");
    } catch (e) {
      if (version !== edit.current) return;
      setError(errText(e)); setStatus("error");
    }
  }, [adopt]);

  /** Load (restore) from the server; optionally merge a guest cart into it and write the result back. */
  const load = useCallback(async (mergeWith: CartLineLike[] = []) => {
    if (!userRef.current) return;
    const version = ++edit.current;
    setStatus("loading"); setError(null);
    try {
      const cart = await profileApi.savedCart();
      if (version !== edit.current) return;
      adopt(cart);
      if (mergeWith.length) {
        const merged = mergeLines(fromSavedCart(cart).lines, mergeWith);
        setLines(merged as L[]);
        await push(merged, ++edit.current);
      } else setStatus("ready");
    } catch (e) {
      if (version !== edit.current) return;
      setError(errText(e)); setStatus("error");
    }
  }, [adopt, push]);

  /** Local edit → optimistic state + debounced write-through to the canonical endpoint. */
  const save = useCallback((next: L[]) => {
    const version = ++edit.current;
    setLines(next); setNotice(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void push(next, version); }, 350);
  }, [push]);

  /** Empties the server cart (PUT items: []) — used by «پاک کردن سبد» and after a completed order. */
  const clear = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const version = ++edit.current;
    setLines([]); setNotice(null);
    await push([], version);
  }, [push]);

  /** Retry the last failed write (current lines) or reload when nothing was loaded yet. */
  const retry = useCallback(() => {
    if (updatedAt === null && !lines.length) return load();
    return push(lines, ++edit.current);
  }, [lines, load, push, updatedAt]);

  useEffect(() => {
    if (userId) return;
    // Signed out: drop the in-memory copy; the server keeps the saved cart for the next session.
    if (timer.current) clearTimeout(timer.current);
    edit.current += 1;
    setLines([]); setStatus("idle"); setError(null); setNotice(null); setUpdatedAt(null);
  }, [userId]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { lines, status, error, notice, updatedAt, load, save, clear, retry };
}
