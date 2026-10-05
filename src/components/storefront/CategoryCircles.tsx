import { fmtNum } from "../../data/catalog";

export type CategoryItem = { name: string; image: string; count: number };

/**
 * Circular category medallions built from real catalogue data
 * (category name, a representative product photograph, published count).
 * Desktop: a centred row with an alternating baseline. Mobile: a native swipe rail
 * with scroll snapping — no carousel library, no clipped circles, labels always visible.
 */
export function CategoryRail({ items, onPick }: { items: CategoryItem[]; onPick: (name: string) => void }) {
  if (items.length === 0) return null;
  return (
    <div className="kv-sf-cats" role="group" aria-label="دسته‌بندی محصولات">
      {items.map((item) => (
        <button
          key={item.name}
          onClick={() => onPick(item.name)}
          className="kv-sf-cat"
          aria-label={`${item.name} — ${fmtNum(item.count)} محصول`}
        >
          <span className="kv-sf-cat-disc" aria-hidden="true">
            <img src={item.image} alt="" loading="lazy" decoding="async" />
            <span className="kv-sf-cat-count kv-frost">{fmtNum(item.count)} مدل</span>
          </span>
          <span className="w-full truncate text-center text-[12.5px] font-bold text-[var(--kvaf-ink)]">{item.name}</span>
        </button>
      ))}
    </div>
  );
}
