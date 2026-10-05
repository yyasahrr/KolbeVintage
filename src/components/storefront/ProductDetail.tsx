import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Heart, Plus, RotateCcw, Ruler, ShieldCheck, Truck } from "lucide-react";
import { fmtMoney, fmtNum, type Colorway, type Product } from "../../data/catalog";
import { Swatches } from "./Swatches";
import { useCartToast } from "./CartToast";
import { SizeRow, mediaForColor, preferredSize, sizesForColor, useCrossfadeKey } from "./shared";
import { cn } from "../../utils/cn";

/**
 * Product detail page in the Archive Fluid system: the gallery leads, the
 * configuration stays out of the way, and nothing here recomputes price or stock.
 */
export default function ProductDetail({ p, wished, onWish, onAdd, onBack }: {
  p: Product;
  wished: boolean;
  onWish: () => void;
  /** existing cart + stock rules; returns whether the line was accepted */
  onAdd: (size: string, color: string) => boolean;
  onBack: () => void;
}) {
  const [color, setColor] = useState<Colorway | undefined>(p.colors[0]);
  const sizes = useMemo(() => sizesForColor(p, color?.id), [p, color?.id]);
  /** the gallery follows the chosen colourway, exactly like the product card */
  const media = useMemo(() => mediaForColor(p, color?.id), [p, color?.id]);
  const [size, setSize] = useState(() => preferredSize(sizesForColor(p, p.colors[0]?.id)));
  const [shot, setShot] = useState(0);
  const [added, setAdded] = useState(false);
  const toast = useCartToast();
  const timer = useRef<number | null>(null);
  const fade = useCrossfadeKey(media[shot] ?? "");

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  /* another colour = another set of photographs and possibly another size run */
  useEffect(() => {
    setShot(0);
    setSize((previous) => (sizes.includes(previous) ? previous : preferredSize(sizes)));
  }, [color?.id, sizes]);

  const submit = () => {
    const accepted = onAdd(size, color?.name ?? "");
    if (!accepted) return;
    setAdded(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAdded(false), 1800);
    toast({ image: media[0], name: p.name, meta: `${color?.name ?? ""}${color ? " · " : ""}سایز ${size}` });
  };

  return (
    <div className="kv-sf-shell">
      <button
        onClick={onBack}
        className="kv-sf-press mb-6 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--kvaf-muted)] hover:text-[var(--kvaf-ink)]"
      >
        <ChevronRight size={16} /> بازگشت به فروشگاه
      </button>

      <div className="grid gap-8 lg:grid-cols-[1.08fr_1fr] lg:gap-14">
        {/* gallery */}
        <div>
          {/* touch: swipeable strip · pointer: single frame with thumbnails */}
          <div className="kv-sf-scrollx lg:hidden">
            {media.map((image, index) => (
              <img
                key={image + index} src={image} alt={`${p.name} — نمای ${(index + 1).toLocaleString("fa-IR")}`}
                className="aspect-[3/4] w-[78vw] max-w-[420px] shrink-0 rounded-[20px] object-cover"
                loading={index === 0 ? "eager" : "lazy"}
              />
            ))}
          </div>

          <div className="hidden lg:flex lg:gap-4">
            <div className="flex w-[86px] shrink-0 flex-col gap-3">
              {media.map((image, index) => (
                <button
                  key={image + index} onClick={() => setShot(index)}
                  aria-label={`نمای ${(index + 1).toLocaleString("fa-IR")}`}
                  aria-current={shot === index ? "true" : undefined}
                  className={cn(
                    "overflow-hidden rounded-[12px] transition-opacity",
                    shot === index ? "ring-1 ring-[var(--kvaf-ink)]" : "opacity-60 hover:opacity-100",
                  )}
                >
                  <img src={image} alt="" className="aspect-[3/4] w-full object-cover" />
                </button>
              ))}
            </div>
            <div className="relative flex-1 overflow-hidden rounded-[24px] bg-[var(--kvaf-sand)]">
              <img
                key={fade.key} src={media[shot]} alt={p.name}
                className="aspect-[3/4] w-full object-cover animate-[kvaf-fade_320ms_var(--kvaf-ease-out)]"
              />
              {p.badge && <span className="kv-sf-cell-flag">{p.badge}</span>}
            </div>
          </div>
        </div>

        {/* configuration */}
        <div className="lg:sticky lg:top-[calc(var(--kvaf-header-space)+8px)] lg:self-start">
          <p className="text-[12.5px] text-[var(--kvaf-muted)]">
            {p.brand} · <span className="kvaf-num" dir="ltr">{p.sku}</span>
          </p>
          <h1 className="kvaf-h1 mt-2 text-[var(--kvaf-ink)]">{p.name}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--kvaf-muted)]">
            <span className="font-bold text-[var(--kvaf-ink)]">{p.rating.toLocaleString("fa-IR")} از ۵</span>
            <span>({fmtNum(p.reviews)} دیدگاه)</span>
            <span aria-hidden="true">·</span>
            <span>فروشنده: {p.supplier}</span>
          </div>

          <p className="kvaf-num mt-5 text-[26px] font-extrabold text-[var(--kvaf-ink)]">{fmtMoney(p.retailPrice)}</p>

          <div className="mt-7">
            <p className="mb-2 text-[13px] font-bold text-[var(--kvaf-ink)]">
              رنگ{color ? <span className="font-medium text-[var(--kvaf-muted)]"> — {color.name}</span> : null}
            </p>
            <Swatches colors={p.colors} selectedId={color?.id} onSelect={setColor} productName={p.name} max={8} />
          </div>

          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[13px] font-bold text-[var(--kvaf-ink)]">سایز</p>
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--kvaf-muted)]">
                <Ruler size={13} /> راهنمای سایز
              </span>
            </div>
            <SizeRow sizes={sizes} value={size} onChange={setSize} idPrefix={`pdp-${p.id}`} />
          </div>

          <p className="mt-5 flex items-center gap-2 text-[12.5px] text-[var(--kvaf-muted)]">
            <span className={cn("h-2 w-2 rounded-full", p.stock > 0 ? "bg-[var(--kvaf-success)]" : "bg-[var(--kvaf-danger)]")} aria-hidden="true" />
            {p.stock > 0
              ? <span>موجود در انبار — <span className="kvaf-num font-bold text-[var(--kvaf-ink)]">{fmtNum(p.stock)}</span> عدد</span>
              : <span className="font-semibold text-[var(--kvaf-danger)]">ناموجود</span>}
          </p>

          <div className="mt-5 hidden gap-3 lg:flex">
            <button onClick={submit} disabled={p.stock < 1} data-added={added ? "true" : undefined} className="kv-sf-action flex-1">
              {added ? <><Check size={17} strokeWidth={3} />به سبد اضافه شد</> : <><Plus size={17} />افزودن به سبد خرید</>}
            </button>
            <button
              onClick={onWish} aria-pressed={wished}
              aria-label={wished ? "حذف از علاقه‌مندی‌ها" : "ذخیره در علاقه‌مندی‌ها"}
              className={cn("kv-sf-press flex w-[52px] items-center justify-center rounded-[12px] border", wished ? "border-[var(--kvaf-sienna)] text-[var(--kvaf-sienna)]" : "border-[var(--kvaf-line-strong)] text-[var(--kvaf-ink)]")}
            >
              <Heart size={19} fill={wished ? "currentColor" : "none"} />
            </button>
          </div>

          <div className="mt-7 space-y-3 border-t border-[var(--kvaf-line)] pt-6 text-[13px] leading-8 text-[var(--kvaf-muted)]">
            <p><span className="font-bold text-[var(--kvaf-ink)]">درباره این محصول — </span>{p.desc}</p>
            <p><span className="font-bold text-[var(--kvaf-ink)]">جنس پارچه: </span>{p.fabric}</p>
          </div>

          <ul className="mt-5 flex flex-wrap gap-2 text-[12px] font-semibold text-[var(--kvaf-ink-2)]">
            <li className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kvaf-sand)]/70 px-3 py-1.5"><Truck size={13} /> ارسال به سراسر کشور</li>
            <li className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kvaf-sand)]/70 px-3 py-1.5"><RotateCcw size={13} /> ۷ روز مهلت برگشت</li>
            <li className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kvaf-sand)]/70 px-3 py-1.5"><ShieldCheck size={13} /> ضمانت اصالت</li>
          </ul>
        </div>
      </div>

      {/* mobile purchase bar */}
      <div className="kv-sf-buybar kv-liquid">
        <button onClick={submit} disabled={p.stock < 1} data-added={added ? "true" : undefined} className="kv-sf-action flex-1">
          {added ? <><Check size={17} strokeWidth={3} />به سبد اضافه شد</> : <><Plus size={17} />افزودن به سبد</>}
        </button>
        <button
          onClick={onWish} aria-pressed={wished}
          aria-label={wished ? "حذف از علاقه‌مندی‌ها" : "ذخیره در علاقه‌مندی‌ها"}
          className={cn("kv-sf-press flex w-[52px] items-center justify-center rounded-[12px] border", wished ? "border-[var(--kvaf-sienna)] text-[var(--kvaf-sienna)]" : "border-[var(--kvaf-line-strong)] text-[var(--kvaf-ink)]")}
        >
          <Heart size={19} fill={wished ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}
