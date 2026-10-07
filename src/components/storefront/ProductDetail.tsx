import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, Heart, Plus, ScanFace, Shirt, Star } from "lucide-react";
import { JOURNAL, fmtMoney, fmtNum, type Colorway, type Product } from "../../data/catalog";
import { tryOnEligible } from "../../data/styling";
import type { ShippingMethod } from "../../data/platform";
import { Swatches } from "./Swatches";
import StorefrontProductCard from "./StorefrontProductCard";
import { useCartToast } from "./CartToast";
import { Fold, SizeRow, hasOwnMedia, mediaForColor, preferredSize, sizesOf, useCrossfadeKey } from "./shared";
import { complementsOf, similarTo } from "./recommendations";

/**
 * Product detail page — Archive Fluid.
 *
 * The top is a focused purchase interface: what the product is, what it costs,
 * which colour and size, whether it can be bought, and the three actions. Every
 * technical or editorial fact lives below it in `جزئیات محصول`.
 *
 * Nothing on this page is invented. A row, a badge or a claim only appears when
 * the catalogue or the live configuration actually carries it:
 *   - stock is stated as presence, never a quantity (there is no colour×size
 *     availability contract yet — see docs/storefront-archive-fluid.md);
 *   - shipping lines come from the store's active shipping methods;
 *   - there is no returns or authenticity claim because no policy source exists;
 *   - the size guide control is gone until a sizeGuide contract exists.
 *
 * The page recomputes no price and no stock; it calls the cart rules it is
 * handed and reports what they returned.
 */
export default function ProductDetail({ p, wished, onWish, onAdd, onBack, catalogue = [], wishlist = [], onToggleWish, onAddProduct, onOpenProduct, onTryOn, onAddToStyle, shipping = [] }: {
  p: Product;
  wished: boolean;
  onWish: () => void;
  /** existing cart + stock rules; returns whether the line was accepted */
  onAdd: (size: string, color: string) => boolean;
  onBack: () => void;
  /** published retail products — the recommendation rails are derived from this */
  catalogue?: Product[];
  wishlist?: string[];
  onToggleWish?: (id: string) => void;
  onAddProduct?: (id: string, size: string, color: string) => boolean;
  onOpenProduct?: (id: string) => void;
  /** virtual try-on entry; eligibility and usage rules stay in the studio */
  onTryOn?: () => void;
  /** opens the existing Style Builder with this product preloaded */
  onAddToStyle?: (colorId?: string) => void;
  /** active retail shipping methods, straight from the store */
  shipping?: ShippingMethod[];
}) {
  /* try-on eligibility is business logic (data/styling.ts), never a CSS hide */
  const tryOnOffered = !!onTryOn && tryOnEligible(p);
  const [color, setColor] = useState<Colorway | undefined>(p.colors[0]);
  const sizes = useMemo(() => sizesOf(p), [p]);
  /** the gallery follows the chosen colourway only when that colour was photographed */
  const media = useMemo(() => mediaForColor(p, color?.id), [p, color?.id]);
  const [size, setSize] = useState(() => preferredSize(sizesOf(p)));
  const [shot, setShot] = useState(0);
  const [added, setAdded] = useState(false);
  const toast = useCartToast();
  const timer = useRef<number | null>(null);
  const fade = useCrossfadeKey(media[shot] ?? "");

  /* Deterministic, presentation-side relations. Memoised so a rail never
     reshuffles while the buyer is reading it. */
  const looks = useMemo(() => complementsOf(p, catalogue), [p, catalogue]);
  const alike = useMemo(() => similarTo(p, catalogue), [p, catalogue]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  /* a colour with its own photographs starts on its first frame; a colour without
     them leaves the gallery untouched */
  useEffect(() => { if (hasOwnMedia(p, color?.id)) setShot(0); }, [p, color?.id]);
  /* the rails navigate inside this page, so every piece of state belongs to the
     product being viewed: reset it when the buyer jumps to another one */
  useEffect(() => {
    setShot(0);
    setAdded(false);
    setColor(p.colors[0]);
    setSize(preferredSize(sizesOf(p)));
  }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const accepted = onAdd(size, color?.name ?? "");
    if (!accepted) return;
    setAdded(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAdded(false), 1800);
    toast({ image: media[0], name: p.name, meta: `${color?.name ?? ""}${color ? " · " : ""}سایز ${size}` });
  };

  const soldOut = p.stock < 1;
  const installmentPrice = p.installmentPrice ?? 0;
  const installment = installmentPrice > 0 ? Math.ceil(installmentPrice / 4) : 0;
  const delivery = shipping.slice(0, 2);

  /**
   * Detail rows, built from fields that actually exist on the product record.
   * Anything undefined is filtered out, so a section can never render with an
   * empty value and the page never grows a section "because the layout wants
   * four". Add a field to the contract and it appears here; leave it out and it
   * stays invisible.
   */
  const specRows: { term: string; value: string }[] = [
    { term: "شناسه کالا", value: p.sku },
    { term: "دسته‌بندی", value: p.category },
    { term: "برند", value: p.brand },
    ...(p.badge ? [{ term: "برچسب کالا", value: p.badge }] : []),
    ...(p.soldNote ? [{ term: "یادداشت فروشنده", value: p.soldNote }] : []),
    { term: "وضعیت موجودی", value: soldOut ? "ناموجود" : "موجود" },
  ].filter((row) => !!row.value?.trim());

  const sections = [
    p.desc?.trim()
      ? { id: "about", title: "درباره محصول", defaultOpen: true, body: <p className="m-0">{p.desc}</p> }
      : null,
    p.fabric?.trim()
      ? { id: "material", title: "جنس و متریال", defaultOpen: false, body: <p className="m-0">{p.fabric}</p> }
      : null,
    specRows.length
      ? {
        id: "specs", title: "مشخصات کالا", defaultOpen: false,
        body: (
          <dl className="m-0">
            {specRows.map((row) => (
              <div key={row.term}>
                <dt>{row.term}</dt>
                <dd className={row.term === "شناسه کالا" ? "kvaf-num" : undefined} dir={row.term === "شناسه کالا" ? "ltr" : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        ),
      }
      : null,
    delivery.length
      ? {
        id: "delivery", title: "ارسال", defaultOpen: false,
        body: (
          <dl className="m-0">
            {delivery.map((method) => (
              <div key={method.id}>
                <dt>{method.name} — {method.zones}</dt>
                <dd>
                  {method.eta}
                  {method.freeAbove !== null && method.freeAbove > 0
                    ? <> · رایگان برای خرید بالای <span className="kvaf-num">{fmtMoney(method.freeAbove)}</span>، در غیر این صورت <span className="kvaf-num">{fmtMoney(method.price)}</span></>
                    : <> · <span className="kvaf-num">{fmtMoney(method.price)}</span></>}
                </dd>
              </div>
            ))}
          </dl>
        ),
      }
      : null,
  ].filter((section): section is NonNullable<typeof section> => section !== null);

  const rail = (items: Product[]) => items.map((item) => (
    <StorefrontProductCard
      key={item.id} p={item}
      wished={wishlist.includes(item.id)}
      onWish={() => onToggleWish?.(item.id)}
      onOpen={() => onOpenProduct?.(item.id)}
      onAdd={(itemSize, itemColor) => onAddProduct?.(item.id, itemSize, itemColor) ?? false}
    />
  ));

  return (
    <div className="kv-sf-shell kv-sf-shell-pdp">
      <nav aria-label="مسیر" className="mb-6 flex min-w-0 flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--kvaf-muted)]">
        <button onClick={onBack} className="kv-sf-press inline-flex items-center gap-1 font-semibold hover:text-[var(--kvaf-ink)]">
          <ChevronLeft size={15} /> فروشگاه
        </button>
        <span aria-hidden="true">/</span>
        <span>{p.category}</span>
        <span aria-hidden="true">/</span>
        <span className="min-w-0 truncate text-[var(--kvaf-ink)]">{p.name}</span>
      </nav>

      <div className="kv-sf-pdp">
        {/* ---- information: first in the DOM, on the right in RTL ---- */}
        <div className="kv-sf-pdp-info">
          <p className="text-[12px] font-bold text-[var(--kvaf-ink-2)]">{p.brand}</p>
          <h1 className="kvaf-feature-title mt-1.5 text-[var(--kvaf-ink)]">{p.name}</h1>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--kvaf-muted)]">
            <span className="kv-sf-rating">
              <span className="kv-sf-rating-stars" aria-hidden="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <Star key={index} size={13} fill={index < Math.round(p.rating) ? "currentColor" : "none"} />
                ))}
              </span>
              <span className="kvaf-num font-bold text-[var(--kvaf-ink)]">{p.rating.toLocaleString("fa-IR")}</span>
              <span>از ۵</span>
            </span>
            <span className="kvaf-num">({fmtNum(p.reviews)} دیدگاه)</span>
          </div>

          <div className="mt-5">
            <p className="kvaf-num text-[26px] font-extrabold leading-none text-[var(--kvaf-ink)]">{fmtMoney(p.retailPrice)}</p>
            {installment > 0 && (
              <p className="kvaf-num mt-1.5 text-[12px] text-[var(--kvaf-muted)]">
                یا ۴ قسطِ <span className="font-bold text-[var(--kvaf-ink-2)]">{fmtMoney(installment)}</span>
              </p>
            )}
          </div>

          <div className="mt-6">
            <p className="mb-1.5 text-[13px] font-bold text-[var(--kvaf-ink)]">
              رنگ{color ? <span className="font-medium text-[var(--kvaf-muted)]"> — {color.name}</span> : null}
            </p>
            <Swatches colors={p.colors} selectedId={color?.id} onSelect={setColor} productName={p.name} max={8} />
          </div>

          <div className="mt-5">
            <p className="mb-1.5 text-[13px] font-bold text-[var(--kvaf-ink)]">سایز</p>
            <SizeRow sizes={sizes} value={size} onChange={setSize} idPrefix={`pdp-${p.id}`} />
          </div>

          {/* Product-level stock only: the colour×size quantity does not exist in
              the data yet, so the page states presence and never a number. */}
          <p className="kv-sf-stock mt-4" data-available={soldOut ? "false" : "true"}>
            <i aria-hidden="true" />
            {soldOut ? "ناموجود" : "موجود"}
          </p>

          {/* assistive tech gets the live selection summary; it is not repeated
              visually, where the swatch and the size chip already show it */}
          <p className="sr-only" aria-live="polite">
            انتخاب شما:{color ? ` رنگ ${color.name}` : " رنگ انتخاب نشده"}
            {size ? ` · سایز ${size}` : " · سایز انتخاب نشده"}
          </p>

          <div className="kv-sf-buyrow">
            <button onClick={submit} disabled={soldOut} data-added={added ? "true" : undefined} className="kv-sf-action flex-1">
              {added ? <><Check size={17} strokeWidth={3} />به سبد اضافه شد</> : <><Plus size={17} />افزودن به سبد خرید</>}
            </button>
            <button
              onClick={onWish} aria-pressed={wished} data-on={wished ? "true" : undefined}
              aria-label={wished ? "حذف از علاقه‌مندی‌ها" : "ذخیره در علاقه‌مندی‌ها"}
              className="kv-sf-press kv-sf-iconaction"
            >
              <Heart size={19} fill={wished ? "currentColor" : "none"} />
            </button>
          </div>

          {/* try-on and «+ استایل» stay secondary: quiet buttons below the
              primary action, rendered once for every width. Whether try-on
              appears is business logic (`tryOnEligible`) — unsupported products
              never show a dead entry point. Both hand off to their own studio
              surfaces, where login and usage rules stay authoritative. */}
          {(tryOnOffered || onAddToStyle) && (
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
              {tryOnOffered && (
                <button onClick={onTryOn} className="kv-sf-action kv-sf-action-quiet w-full">
                  <ScanFace size={17} /> پرو مجازی
                </button>
              )}
              {onAddToStyle && (
                <button onClick={() => onAddToStyle(color?.id)} className="kv-sf-action kv-sf-action-quiet w-full">
                  <Shirt size={17} /> + استایل
                </button>
              )}
            </div>
          )}
        </div>

        {/* ---- gallery: second in the DOM, visually first below lg ---- */}
        <div className="kv-sf-pdp-gallery">
          {/* touch: swipeable strip · pointer: one calm frame with thumbnails */}
          <div className="kv-sf-scrollx kv-sf-pdp-strip snap-x" aria-label={`تصاویر ${p.name}`}>
            {media.map((image, index) => (
              <img
                key={image + index} src={image} alt={`${p.name} — نمای ${(index + 1).toLocaleString("fa-IR")}`}
                className="aspect-[4/5] w-[74vw] max-w-[380px] shrink-0 snap-start rounded-[20px] object-cover"
                loading={index === 0 ? "eager" : "lazy"}
              />
            ))}
          </div>

          <div className="kv-sf-gallery">
            <div className="kv-sf-gallery-main">
              <img key={fade.key} src={media[shot]} alt={`${p.name}${color ? ` — ${color.name}` : ""}`} />
              {p.badge && <span className="kv-sf-cell-flag">{p.badge}</span>}
            </div>
            {media.length > 1 && (
              <div className="kv-sf-thumbs" role="group" aria-label="انتخاب نما">
                {media.map((image, index) => (
                  <button
                    key={image + index} type="button" onClick={() => setShot(index)}
                    aria-label={`نمای ${(index + 1).toLocaleString("fa-IR")}`}
                    aria-current={shot === index ? "true" : undefined}
                    className="kv-sf-thumb"
                  >
                    <img src={image} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="mt-3 text-center text-[12px] text-[var(--kvaf-muted)] lg:text-start">
            {color ? `رنگ ${color.name}` : p.name}
            {media.length > 1 && <> · <span className="kvaf-num">{(shot + 1).toLocaleString("fa-IR")} از {media.length.toLocaleString("fa-IR")}</span></>}
          </p>
        </div>
      </div>

      {/* ---- details: a section exists only when a real field fills it ---- */}
      {sections.length > 0 && (
        <section aria-labelledby="pdp-details-title" className="mt-14">
          <h2 id="pdp-details-title" className="kvaf-h2 text-[19px] text-[var(--kvaf-ink)]">جزئیات محصول</h2>
          <div className="mt-4">
            {sections.map((section) => (
              <Fold key={section.id} title={section.title} defaultOpen={section.defaultOpen}>
                {section.body}
              </Fold>
            ))}
          </div>
        </section>
      )}

      {/* ---- complete the look: only when a real complementary match exists ---- */}
      {looks.length > 0 && (
        <section aria-labelledby="pdp-look-title" className="kv-sf-sect">
          <div className="kv-sf-sect-head">
            <h2 id="pdp-look-title" className="kv-sf-sect-title kvaf-h2 text-[var(--kvaf-ink)]">این استایل را کامل کن</h2>
            <p className="text-[12px] text-[var(--kvaf-muted)]">قطعه‌های مکمل</p>
          </div>
          <div className="kv-sf-recs">{rail(looks)}</div>
        </section>
      )}

      {/* ---- similar / alternatives ---- */}
      {alike.length > 0 && (
        <section aria-labelledby="pdp-alike-title" className="kv-sf-sect">
          <div className="kv-sf-sect-head">
            <h2 id="pdp-alike-title" className="kv-sf-sect-title kvaf-h2 text-[var(--kvaf-ink)]">شاید بپسندید</h2>
          </div>
          <div className="kv-sf-recs">{rail(alike)}</div>
        </section>
      )}

      {/* ---- journal ---- */}
      {JOURNAL.length > 0 && (
        <section aria-labelledby="pdp-journal-title" className="kv-sf-sect">
          <div className="kv-sf-sect-head">
            <h2 id="pdp-journal-title" className="kv-sf-sect-title kvaf-h2 text-[var(--kvaf-ink)]">از مجله کلبه</h2>
          </div>
          <div className="kv-sf-jrnl-grid">
            {JOURNAL.slice(0, 3).map((entry) => (
              <article key={entry.id} className="kv-sf-jrnl-card">
                <div className="kv-sf-jrnl-media">
                  <img src={entry.img} alt="" loading="lazy" />
                </div>
                <p className="kv-sf-jrnl-cat">{entry.cat} · <span className="kvaf-num font-medium text-[var(--kvaf-muted)]">{entry.read}</span></p>
                <h3 className="kv-sf-jrnl-title">{entry.title}</h3>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* mobile purchase bar — the primary action stays reachable while scrolling */}
      <div className="kv-sf-buybar kv-liquid">
        <button onClick={submit} disabled={soldOut} data-added={added ? "true" : undefined} className="kv-sf-action flex-1">
          {added ? <><Check size={17} strokeWidth={3} />به سبد اضافه شد</> : <><Plus size={17} />افزودن به سبد</>}
        </button>
        <button
          onClick={onWish} aria-pressed={wished} data-on={wished ? "true" : undefined}
          aria-label={wished ? "حذف از علاقه‌مندی‌ها" : "ذخیره در علاقه‌مندی‌ها"}
          className="kv-sf-press kv-sf-iconaction"
        >
          <Heart size={19} fill={wished ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}
