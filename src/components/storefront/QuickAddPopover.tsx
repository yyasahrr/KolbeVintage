import { useEffect, useRef } from "react";
import { ShoppingBag } from "lucide-react";
import type { Colorway, Product } from "../../data/catalog";
import { fmtMoney } from "../../data/catalog";
import { Swatches } from "./Swatches";
import { cn } from "../../utils/cn";

/** Size chips — shared by the desktop popover and the mobile sheet. */
export function SizeRow({ sizes, value, onChange, idPrefix }: {
  sizes: string[]; value: string; onChange: (size: string) => void; idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="انتخاب سایز">
      {sizes.map((size) => (
        <button
          key={`${idPrefix}-${size}`} type="button"
          onClick={() => onChange(size)}
          data-on={value === size ? "true" : "false"}
          aria-pressed={value === size}
          className="kv-sf-size"
        >
          {size}
        </button>
      ))}
    </div>
  );
}

/**
 * Desktop Quick Add — a FROST popover anchored to the card control.
 * It never bypasses the storefront cart rules: `onAdd` returns whether the
 * existing stock validation accepted the line.
 */
export default function QuickAddPopover({ p, sizes, size, color, onSize, onColor, onConfirm, stock }: {
  p: Product; sizes: string[]; size: string; color?: Colorway;
  onSize: (size: string) => void; onColor: (color: Colorway) => void;
  onConfirm: () => void; stock: number;
}) {
  const firstSize = useRef<HTMLDivElement>(null);
  useEffect(() => {
    firstSize.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="kv-sf-popover kv-frost" role="dialog" aria-label={`افزودن ${p.name} به سبد`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-extrabold text-[var(--kvaf-ink)]">{p.name}</p>
          <p className="kvaf-num mt-0.5 text-[12.5px] font-semibold text-[var(--kvaf-muted)]">{fmtMoney(p.retailPrice)}</p>
        </div>
        <img src={p.images[0]} alt="" className="h-14 w-11 shrink-0 rounded-[10px] object-cover" />
      </div>

      {p.colors.length > 1 && (
        <div className="mb-3">
          <p className="mb-1 text-[12px] font-bold text-[var(--kvaf-ink)]">
            رنگ{color ? <span className="font-medium text-[var(--kvaf-muted)]"> — {color.name}</span> : null}
          </p>
          <Swatches colors={p.colors} selectedId={color?.id} onSelect={onColor} productName={p.name} />
        </div>
      )}

      <div className="mb-3.5" ref={firstSize}>
        <p className="mb-1.5 text-[12px] font-bold text-[var(--kvaf-ink)]">سایز</p>
        {sizes.length
          ? <SizeRow sizes={sizes} value={size} onChange={onSize} idPrefix={`qa-${p.id}`} />
          : <p className="text-[12px] text-[var(--kvaf-muted)]">این محصول سایزبندی ندارد.</p>}
      </div>

      <button onClick={onConfirm} disabled={stock < 1} className={cn("kv-sf-action w-full")}>
        <ShoppingBag size={16} />افزودن به سبد
      </button>
      {stock < 1 && <p className="mt-2 text-center text-[11.5px] font-semibold text-[var(--kvaf-danger)]">این محصول ناموجود است</p>}
    </div>
  );
}
