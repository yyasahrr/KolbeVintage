import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Heart, ScanFace, Shirt, ShoppingBag, X } from "lucide-react";
import { fmtMoney, type Colorway, type Product } from "../../data/catalog";
import { tryOnEligible } from "../../data/styling";
import { Swatches } from "./Swatches";
import { useCartToast } from "./CartToast";
import { SizeRow, hasOwnMedia, mediaForColor, sizesOf } from "./shared";

const ADDED_MS = 2000;
/** One card reveals its purchase controls at a time · keeps a grid of cards calm. */
const EXPAND_EVENT = "kv-sf-card-expand";

/**
 * Image-first product cell: the photograph leads, the purchase controls live
 * below it and reveal inline · no popover, no bottom sheet, nothing leaves the grid.
 *
 * Flow: pick a colour -> the photograph follows that colour, the card expands and
 * shows the sizes that colour actually has -> pick a size -> the action enables ->
 * the existing cart rules run and the toast/badge confirm.
 * Price, stock and cart validation always come from the product record and the
 * store state; nothing is recomputed here.
 */
export default function StorefrontProductCard({ p, wished, onWish, onOpen, onAdd, onTryOn, onAddToStyle }: {
  p: Product;
  wished: boolean;
  onWish: () => void;
  onOpen: () => void;
  /** existing cart + stock rules; returns whether the line was accepted */
  onAdd: (size: string, color: string) => boolean;
  /**
   * Retail only. The card never decides eligibility: it simply offers the entry
   * point and the studio keeps login and usage rules authoritative. Rendered as
   * a quiet text action inside the already-expanded purchase area, so the
   * collapsed card keeps its approved geometry and no second CTA is added.
   * Whether the action appears at all is business logic (`tryOnEligible`) ·
   * unsupported products never show a dead entry point.
   */
  onTryOn?: () => void;
  /**
   * Retail only. Opens the existing Style Builder with this product preloaded
   * (colour context preserved). Same quiet placement as the try-on action.
   */
  onAddToStyle?: (colorId?: string) => void;
}) {
  /* eligibility is business logic (data/styling.ts), never a CSS hide */
  const tryOnOffered = !!onTryOn && tryOnEligible(p);
  const [color, setColor] = useState<Colorway | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [size, setSize] = useState("");
  const [frame, setFrame] = useState(0);
  const [added, setAdded] = useState(false);
  const [notice, setNotice] = useState("");
  const toast = useCartToast();
  const addedTimer = useRef<number | null>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);

  const media = useMemo(() => mediaForColor(p, color?.id), [p, color?.id]);
  /* one retail size list per product: availability per colour is not part of the
     data yet, so no colour claims sizes another colour does not have */
  const sizes = useMemo(() => sizesOf(p), [p]);
  const soldOut = p.stock < 1;
  const current = media[Math.min(frame, media.length - 1)] ?? "";
  const ready = !soldOut && (!!color) && (sizes.length === 0 || !!size);
  const frameLabel = `${(Math.min(frame, media.length - 1) + 1).toLocaleString("fa-IR")} از ${media.length.toLocaleString("fa-IR")}`;

  useEffect(() => () => { if (addedTimer.current) window.clearTimeout(addedTimer.current); }, []);
  /* only a colour with photographs of its own moves the gallery · otherwise the
     product gallery stays exactly where the shopper left it */
  useEffect(() => { if (hasOwnMedia(p, color?.id)) setFrame(0); }, [p, color?.id]);

  /* collapse when another card in any grid opens its purchase area */
  useEffect(() => {
    const onOther = (event: Event) => {
      if ((event as CustomEvent).detail === p.id) return;
      setExpanded(false);
      /* if the keyboard was inside the purchase area, hand it back to the swatches
         instead of letting focus fall to <body> when the controls unmount */
      const active = document.activeElement;
      if (active && rootRef.current?.contains(active)) {
        rootRef.current.querySelector<HTMLButtonElement>('.kv-sf-swatch[aria-pressed="true"], .kv-sf-swatch')
          ?.focus({ preventScroll: true });
      }
    };
    window.addEventListener(EXPAND_EVENT, onOther);
    return () => window.removeEventListener(EXPAND_EVENT, onOther);
  }, [p.id]);

  const collapse = () => { setExpanded(false); setColor(undefined); setSize(""); setNotice(""); };

  const chooseColor = (next: Colorway) => {
    if (soldOut) return;
    setNotice("");
    if (color?.id === next.id) { collapse(); return; }   // tapping the chosen colour closes again
    setColor(next);
    setSize(sizes.length === 1 ? sizes[0] : "");  // a single size needs no decision
    setExpanded(true);
    window.dispatchEvent(new CustomEvent(EXPAND_EVENT, { detail: p.id }));
  };

  const step = (direction: 1 | -1) => {
    setFrame((index) => Math.min(media.length - 1, Math.max(0, index + direction)));
  };

  const confirm = () => {
    if (!ready) return;
    const accepted = onAdd(size, color?.name ?? "");
    if (!accepted) {
      setAdded(false);
      setNotice("افزودن ممکن نشد · موجودی این محصول برای این تعداد کافی نیست.");
      return;
    }
    setNotice("");
    setAdded(true);
    if (addedTimer.current) window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setAdded(false), ADDED_MS);
    toast({
      image: current,
      name: p.name,
      meta: `${color?.name ?? ""}${color ? " · " : ""}${size ? `سایز ${size}` : "بدون سایزبندی"}`,
    });
  };

  const onTouchStart = (event: React.TouchEvent) => {
    const touch = event.touches[0];
    swipe.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || media.length < 2) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;  // a scroll, not a swipe
    step(dx > 0 ? -1 : 1);                                          // RTL: swipe right = back
  };

  return (
    <article className="kv-sf-cell" ref={rootRef} data-expanded={expanded ? "true" : "false"}>
      {/* ---------- media ---------- */}
      <div className="kv-sf-cell-figure" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <button onClick={onOpen} className="kv-sf-cell-shot" aria-label={`${p.name} · دیدن جزئیات محصول`}>
          {current
            ? (
              <img
                key={current}
                src={current}
                alt=""
                loading="lazy"
                decoding="async"
                className="kv-sf-cell-img"
              />
            )
            : <span className="kv-sf-cell-noimg">تصویر این محصول در دسترس نیست</span>}
        </button>

        {media.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={frame === 0}
              data-side="start"
              aria-label={`تصویر قبلی ${p.name} · ${frameLabel}`}
              className="kv-sf-nav"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={frame >= media.length - 1}
              data-side="end"
              aria-label={`تصویر بعدی ${p.name} · ${frameLabel}`}
              className="kv-sf-nav"
            >
              <ChevronLeft size={16} />
            </button>
            <div className="kv-sf-dots" aria-hidden="true">
              {media.map((image, index) => (
                <i key={image + index} data-on={index === frame ? "true" : "false"} />
              ))}
            </div>
          </>
        )}

        {p.badge && <span className="kv-sf-cell-flag">{p.badge}</span>}

        <button
          type="button"
          onClick={onWish}
          data-on={wished ? "true" : "false"}
          aria-pressed={wished}
          aria-label={wished ? `حذف ${p.name} از علاقه‌مندی‌ها` : `ذخیره ${p.name} در علاقه‌مندی‌ها`}
          className="kv-sf-wish"
        >
          <Heart size={17} fill={wished ? "currentColor" : "none"} />
        </button>

        {soldOut && <span className="kv-sf-cell-sold" aria-hidden="true">ناموجود</span>}
      </div>

      {/* ---------- information + inline purchase ---------- */}
      <div className="kv-sf-cell-body">
        <button onClick={onOpen} className="block w-full text-start">
          <h3 className="kv-sf-cell-name">{p.name}</h3>
        </button>
        <p className="kv-sf-cell-cat">{p.category}</p>
        <p className="kv-sf-cell-price kvaf-num">{fmtMoney(p.retailPrice)}</p>

        <div className="kv-sf-cell-variant">
          <div className="kv-sf-cell-row">
            <p className="kv-sf-cell-label" id={`${p.id}-color-label`}>
              رنگ{color ? <span className="kv-sf-cell-chosen"> · {color.name}</span> : null}
            </p>
            {expanded && (
              <button type="button" onClick={collapse} className="kv-sf-cell-collapse" aria-label={`بستن انتخاب ${p.name}`}>
                <X size={13} /> بستن
              </button>
            )}
          </div>
          <Swatches
            colors={p.colors}
            selectedId={color?.id}
            onSelect={chooseColor}
            productName={p.name}
            labelledBy={`${p.id}-color-label`}
          />
        </div>

        {expanded ? (
          <div className="kv-sf-cell-purchase">
            {sizes.length ? (
              <>
                <p className="kv-sf-cell-label">سایز{size ? <span className="kv-sf-cell-chosen"> · {size}</span> : null}</p>
                <SizeRow
                  sizes={sizes} value={size} idPrefix={`cell-${p.id}`}
                  onChange={(next) => { setSize(next); setNotice(""); }}
                />
              </>
            ) : (
              <p className="kv-sf-cell-note">این محصول سایزبندی ندارد.</p>
            )}

            <button
              type="button"
              onClick={confirm}
              disabled={!ready}
              data-added={added ? "true" : undefined}
              className="kv-sf-action kv-sf-cell-cta"
            >
              {added
                ? <><Check size={16} strokeWidth={3} />به سبد اضافه شد</>
                : ready
                  ? <><ShoppingBag size={16} />افزودن به سبد</>
                  : "سایز را انتخاب کنید"}
            </button>
            {notice && <p className="kv-sf-cell-notice" role="status">{notice}</p>}
            {(tryOnOffered || onAddToStyle) && (
              <div className="kv-sf-cell-secondary">
                {tryOnOffered && (
                  <button type="button" onClick={onTryOn} className="kv-sf-cell-tryon">
                    <ScanFace size={13} aria-hidden="true" /> پرو مجازی
                  </button>
                )}
                {onAddToStyle && (
                  <button type="button" onClick={() => onAddToStyle(color?.id)} className="kv-sf-cell-tryon">
                    <Shirt size={13} aria-hidden="true" /> + استایل
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="kv-sf-cell-hint">
            {soldOut ? "این محصول ناموجود است" : "برای انتخاب سایز، یک رنگ را انتخاب کنید"}
          </p>
        )}
      </div>
    </article>
  );
}
