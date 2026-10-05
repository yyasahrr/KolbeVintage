import { SlidersHorizontal } from "lucide-react";
import { Sheet } from "./shared";

/** Product-list filters on touch widths — the grid stays dominant on desktop. */
export default function FilterSheet({ open, onClose, categories, category, onCategory, sortOptions, sort, onSort, resultCount, onReset }: {
  open: boolean;
  onClose: () => void;
  categories: string[];
  category: string;
  onCategory: (value: string) => void;
  sortOptions: string[];
  sort: string;
  onSort: (value: string) => void;
  resultCount: number;
  onReset: () => void;
}) {
  return (
    <Sheet
      open={open} onClose={onClose} title="فیلتر و مرتب‌سازی"
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
