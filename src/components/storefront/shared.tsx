import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Product } from "../../data/catalog";

/* ---------- capability hooks (media queries, never UA sniffing) ---------- */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Pointer users get the popover; everyone else (touch, narrow screens) gets the sheet. */
export const useIsDesktopPointer = () => useMediaQuery("(min-width: 1024px) and (hover: hover) and (pointer: fine)");

/* ---------- overlay behaviour ---------- */

let lockCount = 0;
let savedOverflow = "";

/** Locks background scroll while any storefront overlay is open; ref-counted so
    stacked overlays (sheet over drawer) do not unlock each other. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Move focus in on open, keep Tab inside, close on Escape, restore focus on close. */
export function useFocusTrap<T extends HTMLElement>(active: boolean, onClose: () => void, autoFocus = true) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    if (node && autoFocus) {
      const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus({ preventScroll: true });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onCloseRef.current(); return; }
      if (event.key !== "Tab" || !node) return;
      const all = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      /* keep the visible-only list in a layout engine; fall back to every focusable
         control where offsets are unavailable so the trap never silently stops */
      const visible = all.filter((el) => el.offsetParent !== null);
      const items = visible.length ? visible : all;
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previous?.focus?.({ preventScroll: true });
    };
  }, [active, autoFocus]);

  return ref;
}

/** Closes when the pointer goes down outside the referenced node. */
export function useDismissOnOutside<T extends HTMLElement>(active: boolean, onDismiss: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [active, onDismiss]);
  return ref;
}

/* ---------- FROST bottom sheet ---------- */

export function Sheet({ open, onClose, title, description, children, footer, labelledBy }: {
  open: boolean; onClose: () => void; title?: string; description?: string;
  children: ReactNode; footer?: ReactNode; labelledBy?: string;
}) {
  const generatedId = useId();
  const titleId = labelledBy ?? `${generatedId}-title`;
  const trapRef = useFocusTrap<HTMLDivElement>(open, onClose);
  useScrollLock(open);
  if (!open) return null;
  return (
    <>
      <div className="kv-sf-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={trapRef} role="dialog" aria-modal="true"
        aria-label={title} aria-labelledby={title ? undefined : labelledBy}
        className="kv-sf-sheet kv-frost"
      >
        <div className="kv-sf-sheet-grip" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3 px-5 pt-2">
          <div className="min-w-0">
            {title && <h2 id={titleId} className="kvaf-h2 text-[17px] leading-7">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] text-[var(--kvaf-muted)]">{description}</p>}
          </div>
          <button
            onClick={onClose} aria-label="بستن"
            className="kv-sf-press -me-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--kvaf-muted)] hover:bg-[rgba(28,28,25,0.06)]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="kv-sf-sheet-body">{children}</div>
        {footer && <div className="kv-sf-sheet-foot">{footer}</div>}
      </div>
    </>
  );
}

/* ---------- product helpers (presentation only, no pricing logic) ---------- */

/** Sizes offered to retail buyers, derived from the existing wholesale series composition. */
export function sizesOf(p: Product): string[] {
  return Array.from(new Set(p.series.flatMap((series) => Object.keys(series.composition))));
}

/**
 * Sizes a buyer can actually choose for one colourway.
 * Derived from the existing catalogue only — no new variant system:
 *  - series the supplier switched off (`available: false`) contribute nothing;
 *  - a size counts when at least one live series still has pieces of it;
 *  - `SeriesDef.colorIds` (the admin/supplier "رنگ‌های مجاز" field) narrows the
 *    run per colour when it is set; when it is absent every colour gets the run.
 */
export function sizesForColor(p: Product, colorId?: string): string[] {
  const live = p.series.filter((series) => series.available
    && (!colorId || !series.colorIds || series.colorIds.includes(colorId)));
  return Array.from(new Set(
    live.flatMap((series) => Object.entries(series.composition)
      .filter(([, pieces]) => pieces > 0)
      .map(([size]) => size)),
  ));
}

/**
 * Media shown for a colourway.
 * 1. the product's own per-colour photos (`Product.colorMedia`) when they exist;
 * 2. otherwise the same product gallery, started on a stable frame for that
 *    colour so switching colour still changes the photograph instead of lying
 *    about a per-colour shoot that does not exist.
 * Never invents a URL: every result is an entry of `p.images`.
 */
export function mediaForColor(p: Product, colorId?: string): string[] {
  const own = colorId ? p.colorMedia?.[colorId] : undefined;
  if (own?.length) return own;
  if (!colorId || p.images.length < 2) return p.images;
  const index = Math.max(0, p.colors.findIndex((color) => color.id === colorId)) % p.images.length;
  return index === 0 ? p.images : [...p.images.slice(index), ...p.images.slice(0, index)];
}

export const preferredSize = (sizes: string[]) => sizes.includes("M") ? "M" : sizes[0] ?? "";

/** Size chips — shared by the product card's inline purchase area and the PDP. */
export function SizeRow({ sizes, value, onChange, idPrefix, unavailable = [] }: {
  sizes: string[]; value: string; onChange: (size: string) => void; idPrefix: string; unavailable?: string[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="انتخاب سایز">
      {sizes.map((size) => {
        const blocked = unavailable.includes(size);
        return (
          <button
            key={`${idPrefix}-${size}`} type="button"
            onClick={() => !blocked && onChange(size)}
            disabled={blocked}
            data-on={value === size ? "true" : "false"}
            aria-pressed={value === size}
            className="kv-sf-size"
          >
            {size}
          </button>
        );
      })}
    </div>
  );
}

/** Crossfade helper: keeps the outgoing image mounted for one frame of the transition. */
export function useCrossfadeKey(value: string) {
  const [state, setState] = useState({ value, key: 0 });
  useEffect(() => { setState((prev) => (prev.value === value ? prev : { value, key: prev.key + 1 })); }, [value]);
  return state;
}

/** Throttled scroll offset in px, updated on rAF. Returns 0 when motion is reduced. */
export function useScrollOffset(enabled: boolean) {
  const [offset, setOffset] = useState(0);
  const frame = useRef(0);
  const update = useCallback(() => {
    frame.current = 0;
    setOffset(window.scrollY || 0);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(update); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [enabled, update]);
  return offset;
}


