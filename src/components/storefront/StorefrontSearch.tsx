import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Search, X } from "lucide-react";
import { fmtMoney, type Product } from "../../data/catalog";
import { useFocusTrap, useScrollLock } from "./shared";

/**
 * Storefront search over the live catalogue: products by name/brand/category and
 * categories by name. No recents or trending lists — the app does not store any,
 * and inventing analytics would be fake data.
 */
export default function StorefrontSearch({ open, onClose, products, categories, onOpenProduct, onPickCategory }: {
  open: boolean;
  onClose: () => void;
  products: Product[];
  categories: { name: string; count: number }[];
  onOpenProduct: (id: string) => void;
  onPickCategory: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useScrollLock(open);

  useEffect(() => { if (open) setQuery(""); }, [open]);

  const term = query.trim();
  const results = useMemo(() => {
    if (!term) return [];
    return products
      /* supplier is deliberately absent: it is operational data, and matching it
         would let anyone enumerate which supplier makes which product */
      .filter((p) => p.name.includes(term) || p.brand.includes(term) || p.category.includes(term))
      .slice(0, 6);
  }, [products, term]);
  const matchedCategories = useMemo(() => {
    if (!term) return [];
    return categories.filter((category) => category.name.includes(term)).slice(0, 4);
  }, [categories, term]);

  if (!open) return null;

  return (
    <>
      <div className="kv-sf-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={trapRef} role="dialog" aria-modal="true" aria-label="جست‌وجوی محصول" className="kv-sf-search-panel kv-frost">
        <div className="flex items-center gap-3 border-b border-[var(--kvaf-line)] px-4 py-3">
          <Search size={18} className="shrink-0 text-[var(--kvaf-muted)]" />
          <label className="sr-only" htmlFor="kv-sf-search-input">جست‌وجوی محصول</label>
          <input
            id="kv-sf-search-input"
            data-autofocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جست‌وجوی محصول، برند یا دسته…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--kvaf-ink)] outline-none placeholder:text-[var(--kvaf-faint)]"
          />
          <button onClick={onClose} aria-label="بستن جست‌وجو" className="kv-sf-press flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--kvaf-muted)] hover:bg-[rgba(28,28,25,0.06)]">
            <X size={17} />
          </button>
        </div>

        <div className="kv-scroll flex-1 overflow-y-auto p-3">
          {!term && (
            <div className="px-2 py-6 text-center">
              <p className="text-[13.5px] font-bold text-[var(--kvaf-ink)]">نام محصول یا دسته را بنویسید</p>
              <p className="mt-1.5 text-[12.5px] leading-6 text-[var(--kvaf-muted)]">
                میان {products.length.toLocaleString("fa-IR")} محصول منتشرشده و {categories.length.toLocaleString("fa-IR")} دسته جست‌وجو می‌شود.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {categories.slice(0, 6).map((category) => (
                  <button
                    key={category.name}
                    onClick={() => { onPickCategory(category.name); onClose(); }}
                    className="kv-sf-chip"
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {term && (
            <>
              {matchedCategories.length > 0 && (
                <section className="mb-4">
                  <p className="kvaf-meta mb-2 px-1">دسته‌ها</p>
                  <div className="flex flex-wrap gap-2">
                    {matchedCategories.map((category) => (
                      <button
                        key={category.name}
                        onClick={() => { onPickCategory(category.name); onClose(); }}
                        className="kv-sf-chip"
                      >
                        {category.name}<span className="kvaf-num text-[var(--kvaf-muted)]">{category.count.toLocaleString("fa-IR")}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <p className="kvaf-meta mb-2 px-1">محصول‌ها</p>
                {results.length === 0 ? (
                  <p className="px-1 py-4 text-[13px] text-[var(--kvaf-muted)]">
                    محصولی برای «{term}» پیدا نشد. عبارت کوتاه‌تری را امتحان کنید.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {results.map((product) => (
                      <li key={product.id}>
                        <button
                          onClick={() => { onOpenProduct(product.id); onClose(); }}
                          className="flex w-full items-center gap-3 rounded-[12px] p-2 text-start transition-colors hover:bg-[rgba(28,28,25,0.05)]"
                        >
                          <img src={product.images[0]} alt="" className="h-14 w-11 shrink-0 rounded-[10px] object-cover" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-bold text-[var(--kvaf-ink)]">{product.name}</span>
                            <span className="block truncate text-[11.5px] text-[var(--kvaf-muted)]">{product.category} · {product.brand}</span>
                          </span>
                          <span className="kvaf-num shrink-0 text-[12.5px] font-bold text-[var(--kvaf-ink)]">{fmtMoney(product.retailPrice)}</span>
                          <ArrowLeft size={15} className="shrink-0 text-[var(--kvaf-muted)]" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
