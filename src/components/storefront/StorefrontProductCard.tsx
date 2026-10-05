import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Heart, Plus } from "lucide-react";
import { fmtMoney, type Colorway, type Product } from "../../data/catalog";
import QuickAddPopover from "./QuickAddPopover";
import QuickAddSheet from "./QuickAddSheet";
import { Swatches } from "./Swatches";
import { useCartToast } from "./CartToast";
import { preferredSize, sizesOf, useDismissOnOutside, useIsDesktopPointer } from "./shared";

const POPOVER_W = 300;
const ADDED_MS = 1800;

/**
 * Image-first product cell: the photograph is the card.
 * Price and stock always come from the product record — nothing is recomputed here.
 */
export default function StorefrontProductCard({ p, wished, onWish, onOpen, onAdd }: {
  p: Product;
  wished: boolean;
  onWish: () => void;
  onOpen: () => void;
  /** existing cart + stock rules; returns whether the line was accepted */
  onAdd: (size: string, color: string) => boolean;
}) {
  const sizes = useMemo(() => sizesOf(p), [p]);
  const [color, setColor] = useState<Colorway | undefined>(p.colors[0]);
  const [size, setSize] = useState(() => preferredSize(sizesOf(p)));
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; below: boolean } | null>(null);
  const isDesktop = useIsDesktopPointer();
  const toast = useCartToast();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const addedTimer = useRef<number | null>(null);

  const needsChoice = sizes.length > 1 || p.colors.length > 1;
  const soldOut = p.stock < 1;

  useEffect(() => () => { if (addedTimer.current) window.clearTimeout(addedTimer.current); }, []);

  const dismissRef = useDismissOnOutside<HTMLElement>(open && isDesktop, () => setOpen(false));

  useEffect(() => {
    if (!open || !isDesktop) { setAnchor(null); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(POPOVER_W, window.innerWidth - 32);
    const rtl = document.documentElement.dir === "rtl";
    const raw = rtl ? rect.left : rect.right - width;
    const left = Math.max(16, Math.min(raw, window.innerWidth - width - 16));
    setAnchor({ top: rect.top < 360 ? rect.bottom + 10 : rect.top - 10, left, below: rect.top < 360 });
  }, [open, isDesktop]);

  // a scrolling page would leave a fixed popover behind, so it steps aside
  useEffect(() => {
    if (!open || !isDesktop) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close); window.removeEventListener("resize", close); };
  }, [open, isDesktop]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const confirm = (chosenSize: string, chosenColor?: Colorway) => {
    const accepted = onAdd(chosenSize, chosenColor?.name ?? "");
    setOpen(false);
    if (!accepted) return false;
    setAdded(true);
    if (addedTimer.current) window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setAdded(false), ADDED_MS);
    toast({ image: p.images[0], name: p.name, meta: `${chosenColor?.name ?? ""}${chosenColor ? " · " : ""}سایز ${chosenSize}` });
    return true;
  };

  const onTrigger = () => {
    if (soldOut) return;
    if (!needsChoice) { confirm(size, color); return; }
    setOpen((value) => !value);
  };

  return (
    <article className="kv-sf-cell group" ref={dismissRef}>
      <div className="kv-sf-cell-figure">
        <button onClick={onOpen} className="block h-full w-full text-start" aria-label={p.name}>
          {p.images[0]
            ? <img src={p.images[0]} alt="" loading="lazy" decoding="async" />
            : <span className="grid h-full w-full place-items-center px-4 text-center text-[12px] text-[var(--kvaf-muted)]">تصویر این محصول در دسترس نیست</span>}
        </button>

        {p.badge && <span className="kv-sf-cell-flag">{p.badge}</span>}

        <button
          onClick={onWish}
          data-on={wished ? "true" : "false"}
          aria-pressed={wished}
          aria-label={wished ? `حذف ${p.name} از علاقه‌مندی‌ها` : `ذخیره ${p.name} در علاقه‌مندی‌ها`}
          className="kv-sf-wish"
        >
          <Heart size={17} fill={wished ? "currentColor" : "none"} />
        </button>

        {soldOut && (
          <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[rgba(247,244,237,0.55)] text-[13px] font-extrabold text-[var(--kvaf-charcoal)]">
            ناموجود
          </span>
        )}

        <button
          ref={triggerRef}
          onClick={onTrigger}
          disabled={soldOut}
          data-open={open ? "true" : "false"}
          aria-expanded={needsChoice && !soldOut ? open : undefined}
          aria-haspopup={needsChoice && !soldOut ? "dialog" : undefined}
          aria-label={`افزودن ${p.name} به سبد خرید`}
          data-added={added ? "true" : undefined}
          className="kv-sf-quickadd kv-liquid"
        >
          {added ? <><Check size={15} strokeWidth={3} />اضافه شد</> : <><Plus size={16} />افزودن سریع</>}
        </button>
      </div>

      {open && isDesktop && anchor && (
        <div
          className="kv-sf-anchor"
          data-below={anchor.below ? "true" : "false"}
          style={{
            top: anchor.top,
            left: anchor.left,
            width: Math.min(POPOVER_W, typeof window === "undefined" ? POPOVER_W : window.innerWidth - 32),
            transform: anchor.below ? undefined : "translateY(-100%)",
          }}
        >
          <QuickAddPopover
            p={p} sizes={sizes} size={size} color={color} stock={p.stock}
            onSize={setSize} onColor={setColor}
            onConfirm={() => confirm(size, color)}
          />
        </div>
      )}

      <QuickAddSheet
        open={open && !isDesktop} onClose={() => setOpen(false)}
        p={p} sizes={sizes} size={size} color={color} stock={p.stock}
        onSize={setSize} onColor={setColor}
        onConfirm={() => confirm(size, color)}
      />

      <div className="pt-3">
        <button onClick={onOpen} className="block w-full text-start">
          <h3 className="line-clamp-2 text-[14px] font-bold leading-6 text-[var(--kvaf-ink)] transition-colors group-hover:text-[var(--kvaf-brass-deep)] [overflow-wrap:anywhere]">
            {p.name}
          </h3>
        </button>
        <p className="mt-0.5 text-[11.5px] text-[var(--kvaf-muted)]">{p.category}</p>
        <p className="kvaf-num mt-1.5 text-[14.5px] font-extrabold text-[var(--kvaf-ink)]">{fmtMoney(p.retailPrice)}</p>
        <div className="mt-2">
          <Swatches colors={p.colors} selectedId={color?.id} onSelect={(next) => setColor(next)} productName={p.name} />
        </div>
      </div>
    </article>
  );
}
