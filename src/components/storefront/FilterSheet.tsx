import { SlidersHorizontal } from "lucide-react";
import { fmtMoney } from "../../data/catalog";
import { Sheet } from "./shared";

/** One facet group: every group here is backed by a real product field. */
export type ListingFacets = {
  colors: string[];
  sizes: string[];
  brands: string[];
  maxPrice: number | null;
  inStock: boolean;
};

/**
 * Product-list filters — a FROST panel on every width (bottom sheet on touch,
 * side-anchored panel from 1024px up), so the grid always owns the page and no
 * permanent filter column eats the content width.
 *
 * Groups are rendered only when the catalogue can fill them. There is no
 * condition/grade field on a product, so no condition group exists.
 */
export default function FilterSheet({ open, onClose, categories, category, onCategory, sortOptions, sort, onSort, resultCount, colors = [], sizes = [], brands = [], facets, onFacets, priceBounds, onReset }: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  category: string;
  onCategory: (value: string) => void;
  sortOptions: string[];
  sort: string;
  onSort: (value: string) => void;
  resultCount: number;
  colors?: { name: string; hex: string }[];
  sizes?: string[];
  brands?: string[];
  facets?: ListingFacets;
  onFacets?: (facets: ListingFacets) => void;
  priceBounds?: { min: number; max: number };
  onReset: () => void;
}) {
  const empty: ListingFacets = { colors: [], sizes: [], brands: [], maxPrice: null, inStock: false };
  const state = facets ?? empty;
  const update = (next: Partial<ListingFacets>) => onFacets?.({ ...state, ...next });
  const toggleIn = (key: "colors" | "sizes" | "brands", value: string) => {
    const list = state[key];
    update({ [key]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value] } as Partial<ListingFacets>);
  };
  const priceStep = priceBounds ? Math.max(100000, Math.round((priceBounds.max - priceBounds.min) / 20 / 100000) * 100000) : 0;

  return (
    <Sheet
      open={open} onClose={onClose} title="فیلتر و مرتب‌سازی" panel
      footer={
        <button onClick={onClose} className="kv-sf-action w-full">
          نمایش {resultCount.toLocaleString("fa-IR")} محصول
        </button>
      }
    >
      <section>
        <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--kvaf-ink)]">
          <SlidersHorizontal size={14} /> دسته‌بندی
        </p>
        <div className="flex flex-wrap gap-2">
          {categories.map((item) => (
            <button
              key={item} onClick={() => onCategory(item)}
              data-on={category === item ? "true" : "false"}
              aria-pressed={category === item}
              className="kv-sf-chip"
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      {colors.length > 0 && (
        <section className="mt-6">
          <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">رنگ</p>
          <div className="flex flex-wrap gap-2">
            {colors.map((color) => (
              <button
                key={color.name} onClick={() => toggleIn("colors", color.name)}
                data-on={state.colors.includes(color.name) ? "true" : "false"}
                aria-pressed={state.colors.includes(color.name)}
                className="kv-sf-chip"
              >
                <i className="h-3 w-3 rounded-full ring-1 ring-[var(--kvaf-line-strong)]" style={{ background: color.hex }} aria-hidden="true" />
                {color.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {sizes.length > 0 && (
        <section className="mt-6">
          <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">سایز</p>
          <div className="flex flex-wrap gap-2">
            {sizes.map((size) => (
              <button
                key={size} onClick={() => toggleIn("sizes", size)}
                data-on={state.sizes.includes(size) ? "true" : "false"}
                aria-pressed={state.sizes.includes(size)}
                className="kv-sf-chip"
              >
                {size}
              </button>
            ))}
          </div>
        </section>
      )}

      {brands.length > 0 && (
        <section className="mt-6">
          <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">برند / تأمین‌کننده</p>
          <div className="flex flex-wrap gap-2">
            {brands.map((brand) => (
              <button
                key={brand} onClick={() => toggleIn("brands", brand)}
                data-on={state.brands.includes(brand) ? "true" : "false"}
                aria-pressed={state.brands.includes(brand)}
                className="kv-sf-chip"
              >
                {brand}
              </button>
            ))}
          </div>
        </section>
      )}

      {priceBounds && priceBounds.max > priceBounds.min && (
        <section className="mt-6">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-[12.5px] font-bold text-[var(--kvaf-ink)]">حداکثر قیمت</p>
            <p className="kvaf-num text-[12px] text-[var(--kvaf-muted)]">
              {state.maxPrice === null ? "بدون محدودیت" : `تا ${fmtMoney(state.maxPrice)}`}
            </p>
          </div>
          <input
            type="range" className="kv-sf-range"
            min={priceBounds.min} max={priceBounds.max} step={priceStep}
            value={state.maxPrice ?? priceBounds.max}
            onChange={(event) => {
              const value = Number(event.target.value);
              update({ maxPrice: value >= priceBounds.max ? null : value });
            }}
            aria-label="حداکثر قیمت"
            aria-valuetext={state.maxPrice === null ? "بدون محدودیت" : fmtMoney(state.maxPrice)}
          />
          <div className="kvaf-num mt-1.5 flex justify-between text-[11px] text-[var(--kvaf-faint)]">
            <span>{fmtMoney(priceBounds.min)}</span>
            <span>{fmtMoney(priceBounds.max)}</span>
          </div>
        </section>
      )}

      <section className="mt-6">
        <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">موجودی</p>
        <button
          onClick={() => update({ inStock: !state.inStock })}
          data-on={state.inStock ? "true" : "false"}
          aria-pressed={state.inStock}
          className="kv-sf-chip"
        >
          فقط کالاهای موجود
        </button>
      </section>

      <section className="mt-6">
        <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">مرتب‌سازی</p>
        <div className="flex flex-wrap gap-2">
          {sortOptions.map((item) => (
            <button
              key={item} onClick={() => onSort(item)}
              data-on={sort === item ? "true" : "false"}
              aria-pressed={sort === item}
              className="kv-sf-chip"
            >
              {item}
            </button>
          ))}
        </div>
      </section>

      <button onClick={onReset} className="mt-6 text-[12.5px] font-bold text-[var(--kvaf-muted)] underline underline-offset-4 hover:text-[var(--kvaf-ink)]">
        پاک کردن فیلترها
      </button>
    </Sheet>
  );
}
