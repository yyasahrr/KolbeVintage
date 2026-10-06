import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X, ChevronDown } from "lucide-react";
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

/** `panel` renders the same FROST surface as a side-anchored panel from 1024px
    up instead of a bottom sheet, so listing filters never need a page column. */
export function Sheet({ open, onClose, title, description, children, footer, labelledBy, panel = false }: {
  open: boolean; onClose: () => void; title?: string; description?: string;
  children: ReactNode; footer?: ReactNode; labelledBy?: string; panel?: boolean;
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
        data-panel={panel ? "true" : undefined}
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

/* ---------- accordion (product details) ---------- */

/**
 * A single disclosure row: a real <button aria-expanded> over a labelled
 * region. Native keyboard support and focus come free from the button, the
 * open state lives in the DOM (so assistive tech and tests can read it) and no
 * library is involved. Motion is a short opacity/height reveal that the global
 * reduced-motion rule neutralises.
 */
export function Fold({ title, children, defaultOpen = false, icon }: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const generated = useId();
  const panelId = `${generated}-panel`;
  const headingId = `${generated}-heading`;
  return (
    <div className="kv-sf-fold">
      <h3 className="m-0 text-inherit">
        <button
          type="button" id={headingId}
          className="kv-sf-fold-btn"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          {icon}
          {title}
          <ChevronDown size={16} className="kv-sf-fold-chevron" aria-hidden="true" />
        </button>
      </h3>
      <div
        id={panelId} role="region" aria-labelledby={headingId}
        hidden={!open} className="kv-sf-fold-body"
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- product helpers (presentation only, no pricing logic) ---------- */

/**
 * Sizes offered to retail buyers — the storefront's existing size list.
 *
 * NOTE for Core Commerce: this is a size *list*, not an availability signal.
 * Retail colour×size availability must come from the variant contract described
 * in docs/storefront-archive-fluid.md ("Required contract: retailVariants"),
 * not from wholesale series data. Until that contract exists every colour of a
 * product offers the same sizes, which is what the data can honestly support.
 */
export function sizesOf(p: Product): string[] {
  return Array.from(new Set(p.series.flatMap((series) => Object.keys(series.composition))));
}

/**
 * Media shown for a colourway.
 * Only `Product.colorMedia` — photographs actually captured for that colour —
 * may change the image. When a colour has no dedicated media the product
 * gallery is returned unchanged: an unrelated photograph is never presented as
 * that colour, and the gallery is never reordered to fake a change.
 */
export function mediaForColor(p: Product, colorId?: string): string[] {
  const own = colorId ? p.colorMedia?.[colorId] : undefined;
  return own?.length ? own : p.images;
}

/**
 * Thumbnail for a cart/checkout line, matched to the colour the shopper chose.
 *
 * `CartLine.color` is the colour *name* the storefront writes at add-to-cart
 * time (there is no variantId in the cart identity yet), so the name is resolved
 * back to a colourway and its own media when — and only when — that colour was
 * actually photographed. With no dedicated media the product's first frame is
 * used, which is the honest fallback: never a photo of a different colour
 * presented as the chosen one.
 */
export function lineThumbnail(p: Product, colorName?: string): string {
  const match = colorName ? p.colors.find((color) => color.name === colorName) : undefined;
  if (match && hasOwnMedia(p, match.id)) return mediaForColor(p, match.id)[0];
  return p.images[0] ?? "";
}

/** True when this colourway has photographs of its own. */
export const hasOwnMedia = (p: Product, colorId?: string): boolean =>
  !!colorId && !!p.colorMedia?.[colorId]?.length;

export const preferredSize = (sizes: string[]) => sizes.includes("M") ? "M" : sizes[0] ?? "";

/** Size chips — shared by the product card's inline purchase area and the PDP. */
export function SizeRow({ sizes, value, onChange, idPrefix }: {
  sizes: string[]; value: string; onChange: (size: string) => void; idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="انتخاب سایز">
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


