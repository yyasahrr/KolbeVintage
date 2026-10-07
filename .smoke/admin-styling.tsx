import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore } from "../src/data/store";
import { CompatibilityStudio, CuratedStyleStudio } from "../src/portals/admin-styling";
import { publicCuratedStyles, resolveLines, subtotalOf, assessDiscount, assessInstallments } from "../src/data/curated";

/**
 * Admin styling DOM probe (Phase 2). Mounts the REAL admin components over the
 * REAL store — the same surfaces the console renders — and mirrors the store
 * state into pre#out after every interaction. No fake backend needed: these
 * components are pure store consumers.
 */
function Reporter() {
  const { products, variantRelations, curatedStyles } = useStore();
  useEffect(() => {
    const out = document.getElementById("out") ?? (() => { const p = document.createElement("pre"); p.id = "out"; document.body.appendChild(p); return p; })();
    const seed = curatedStyles.find((s) => s.id === "cs-demo-1");
    const priced = seed ? resolveLines(seed, products) : null;
    out.textContent = JSON.stringify({
      products: products.length,
      relations: variantRelations.map((r) => ({ id: r.id, level: r.level })),
      styles: curatedStyles.map((s) => ({ id: s.id, status: s.status, items: s.items.length, title: s.title })),
      publicStyles: publicCuratedStyles(curatedStyles).length,
      seedDemo1: priced ? {
        subtotal: subtotalOf(priced.lines),
        discount: assessDiscount(seed!, priced.lines).discount,
        installment: assessInstallments(seed!, priced.lines, assessDiscount(seed!, priced.lines)),
      } : null,
    });
  }, [products, variantRelations, curatedStyles]);
  return null;
}

function Harness() {
  const { products } = useStore();
  const source = products.find((p) => p.status === "published" && p.retailPrice > 0 && p.colors.length >= 2) ?? products[0]!;
  const flash = (message: string) => {
    const el = document.getElementById("flash") ?? (() => { const p = document.createElement("pre"); p.id = "flash"; document.body.appendChild(p); return p; })();
    el.textContent = message;
  };
  if (!source) return null;
  return (
    <div>
      <section id="compat" aria-label="هماهنگی استایل"><CompatibilityStudio source={source} flash={flash} /></section>
      <section id="curated" aria-label="استایل‌های آماده"><CuratedStyleStudio flash={flash} /></section>
      <Reporter />
    </div>
  );
}

export default function Entry() {
  createRoot(document.getElementById("root")!).render(<StoreProvider><Harness /></StoreProvider>);
}

Entry();
