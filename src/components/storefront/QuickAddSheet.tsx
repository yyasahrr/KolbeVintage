import type { Colorway, Product } from "../../data/catalog";
import { fmtMoney } from "../../data/catalog";
import { Sheet } from "./shared";
import { SizeRow } from "./QuickAddPopover";
import { Swatches } from "./Swatches";

/**
 * Mobile Quick Add — FROST bottom sheet. Variant choice never gets squeezed into
 * the product cell; it moves here, with real touch targets and safe-area padding.
 */
export default function QuickAddSheet({ open, onClose, p, sizes, size, color, onSize, onColor, onConfirm, stock }: {
  open: boolean; onClose: () => void; p: Product; sizes: string[]; size: string;
  color?: Colorway; onSize: (size: string) => void; onColor: (color: Colorway) => void;
  onConfirm: () => void; stock: number;
}) {
  return (
    <Sheet
      open={open} onClose={onClose}
      footer={
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="kvaf-num text-[15px] font-extrabold text-[var(--kvaf-ink)]">{fmtMoney(p.retailPrice)}</p>
            <p className="truncate text-[11.5px] text-[var(--kvaf-muted)]">
              {color ? `${color.name} · ` : ""}{size ? `سایز ${size}` : "بدون سایزبندی"}
            </p>
          </div>
          <button onClick={onConfirm} disabled={stock < 1} data-autofocus className="kv-sf-action">افزودن به سبد</button>
        </div>
      }
    >
      <div className="flex gap-3">
        <img src={p.images[0]} alt="" className="h-24 w-20 shrink-0 rounded-[12px] object-cover" />
        <div className="min-w-0">
          <p className="text-[15px] font-extrabold leading-7 text-[var(--kvaf-ink)]">{p.name}</p>
          <p className="mt-1 text-[12px] text-[var(--kvaf-muted)]">{p.category}</p>
          <p className="mt-2 text-[12px] font-semibold text-[var(--kvaf-ink)]">
            {stock > 0 ? "موجود در انبار" : "ناموجود"}
          </p>
        </div>
      </div>

      {p.colors.length > 1 && (
        <div className="mt-5">
          <p className="mb-1 text-[12.5px] font-bold text-[var(--kvaf-ink)]">
            رنگ{color ? <span className="font-medium text-[var(--kvaf-muted)]"> — {color.name}</span> : null}
          </p>
          <Swatches colors={p.colors} selectedId={color?.id} onSelect={onColor} productName={p.name} max={8} />
        </div>
      )}

      <div className="mt-5">
        <p className="mb-2 text-[12.5px] font-bold text-[var(--kvaf-ink)]">سایز</p>
        {sizes.length
          ? <SizeRow sizes={sizes} value={size} onChange={onSize} idPrefix={`qas-${p.id}`} />
          : <p className="text-[12px] text-[var(--kvaf-muted)]">این محصول سایزبندی ندارد.</p>}
      </div>

      {stock < 1 && <p className="mt-4 text-[12px] font-semibold text-[var(--kvaf-danger)]">این محصول ناموجود است؛ به‌زودی شارژ می‌شود.</p>}
    </Sheet>
  );
}
