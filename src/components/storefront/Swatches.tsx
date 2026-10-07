import { useState } from "react";
import type { Colorway } from "../../data/catalog";

/**
 * Circular colour swatches: a small disc inside a 38px touch target, selected state
 * carried by a concentric ring (not colour alone) and exposed through aria-pressed.
 */
export function Swatches({ colors, selectedId, onSelect, productName, unavailableIds = [], max = 4, labelledBy }: {
  colors: Colorway[];
  selectedId?: string;
  onSelect?: (color: Colorway) => void;
  productName: string;
  unavailableIds?: string[];
  max?: number;
  labelledBy?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (colors.length === 0) {
    return <p className="text-[11.5px] text-[var(--kvaf-faint)]">بدون تنوع رنگ</p>;
  }
  const visible = expanded ? colors : colors.slice(0, max);
  const hidden = colors.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={labelledBy ?? `رنگ‌های ${productName}`}>
      {visible.map((color) => {
        const unavailable = unavailableIds.includes(color.id);
        return (
          <button
            key={color.id}
            type="button"
            onClick={() => !unavailable && onSelect?.(color)}
            aria-pressed={selectedId === color.id}
            aria-label={`${productName} · رنگ ${color.name}${unavailable ? " (ناموجود)" : ""}`}
            data-unavailable={unavailable ? "true" : undefined}
            className="kv-sf-swatch"
            title={color.name}
          >
            <i style={{ background: color.hex }} aria-hidden="true" />
          </button>
        );
      })}
      {hidden > 0 && (
        <button
          type="button" onClick={() => setExpanded(true)}
          className="kv-sf-swatch-more"
          aria-label={`نمایش ${hidden.toLocaleString("fa-IR")} رنگ دیگر از ${productName}`}
        >
          +{hidden.toLocaleString("fa-IR")}
        </button>
      )}
    </div>
  );
}
