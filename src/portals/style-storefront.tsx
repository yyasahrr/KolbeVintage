/* KOLBE · Curated-style storefront (Phase 3, Non-Core workstream)
 *
 * The customer-facing side of the admin-authored styles:
 *  - CuratedStyleCard: an EDITORIAL card, deliberately distinct from a product
 *    card (cover, title, summary, item count, live cash total, discount state,
 *    installment flag). It NEVER carries size selectors (§45). Its two actions
 *    sit in ONE row: a wide primary «مشاهده استایل» (~70%) beside a narrow
 *    quiet «ساخت استایل شخصی» (~30%).
 *  - CuratedStyleDetail: pinned colours are fixed and shown READ-ONLY; the
 *    shopper picks SIZES and may enable/disable any item; totals, discount
 *    eligibility and the installment plan update live from the ONE pricing
 *    pipeline (§48–§56). Every item exposes three actions · خرید محصول
 *    (its own product flow), ساخت استایل جدید (the existing Style Builder
 *    entered at that product) and پرو آنلاین لباس (the try-on surface, only
 *    when `tryOnEligible` says so · unsupported products never get a dead
 *    entry point), plus a field-driven «جزئیات» fold reusing the PDP's
 *    sections pattern so each product can be inspected properly.
 *
 * Honesty rules carried over from the domain: every number on screen is a
 * preview of `priceStyle` over the CURRENT catalogue; the cart mutation
 * revalidates with the existing retail rules and the order recompute happens
 * in the store (server-side in production). Nothing here executes a payment.
 */
import { useMemo, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Layers, Lock, Minus, Pause, Play, Plus, ScanFace, ShieldCheck, Shirt, Sparkles } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../data/catalog";
import { FAILURE_TEXT, type LineFailure } from "../data/cart";
import {
  CURATED_ROLES, priceStyle, previewCompatibility, publicCuratedStyles, styleMedia,
  type CuratedStyle, type VariantRelation,
} from "../data/curated";
import { mediaSrc } from "../data/experience-api";
import { ROLE_LABEL, tryOnEligible, type OutfitRole } from "../data/styling";
import { Fold, preferredSize, sizesOf } from "../components/storefront/shared";
import { cn } from "../utils/cn";

export type StyleAdd = { productId: string; colorId: string; size: string; qty: number };

/* ============================================================
   Card · homepage «استایل‌های آماده»
   ============================================================ */

export function CuratedStyleCard({ style, catalogue, relations, onOpen, onPersonalize }: {
  style: CuratedStyle;
  catalogue: Product[];
  relations: VariantRelation[];
  onOpen: () => void;
  onPersonalize: () => void;
}) {
  const preview = useMemo(() => priceStyle(style, catalogue), [style, catalogue]);
  const media = useMemo(() => {
    const list = styleMedia(style);
    if (list.length) return list;
    const fallback = catalogue.find((p) => p.id === style.items[0]?.productId)?.images[0];
    return fallback ? [{ kind: "image" as const, url: fallback }] : [];
  }, [style, catalogue]);
  const [slide, setSlide] = useState(0);
  const [playing, setPlaying] = useState(false);
  const active = media[Math.min(slide, media.length - 1)];
  const activeImage = active?.kind === "image" ? active.url : active?.poster ?? "";
  const compatibility = style.items.length >= 2 ? previewCompatibility(style, catalogue, relations) : null;
  const discountPercent = style.pricing.discountType === "percentage" && style.pricing.discountValue > 0
    ? fmtNum(style.pricing.discountValue)
    : null;
  const installmentHint = style.installments.installmentEnabled && preview.installments.mode !== "none" && preview.installments.perInstallment > 0
    ? `یا ۴ قسطِ ${fmtMoney(preview.installments.perInstallment)}`
    : null;
  return (
    <article className="kv-style-card group" aria-label={style.title}>
      <div className="kv-style-media">
        <button type="button" onClick={onOpen} className="kv-style-cover" aria-label={`مشاهده استایل ${style.title}`}>
          {active && (active.kind === "video" && playing ? (
            <video key={active.url} src={mediaSrc(active.url) ?? active.url} poster={mediaSrc(active.poster ?? "") ?? active.poster} autoPlay muted loop playsInline preload="none" className="kv-style-cover-video" aria-label={`ویدیوی استایل ${style.title}`} />
          ) : activeImage ? (
            <img src={mediaSrc(activeImage) ?? activeImage} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-[var(--kv-surface-2)]"><Layers size={28} className="text-[var(--kv-muted)]" /></span>
          ))}
          {preview.discount.eligible && <span className="kv-style-flag">تخفیف استایل</span>}
        </button>
        {active?.kind === "video" && (
          <button type="button" onClick={() => setPlaying((v) => !v)} className="kv-style-play-hit" aria-label={playing ? "توقف ویدیو" : "پخش ویدیوی استایل"} title={playing ? "توقف ویدیو" : "پخش ویدیوی استایل"}>
            {playing ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
          </button>
        )}
        {media.length > 1 && (
          <>
            <button type="button" onClick={() => { setSlide((i) => (i - 1 + media.length) % media.length); setPlaying(false); }} className="kv-style-media-nav" aria-label="رسانه قبلی"><ChevronRight size={15} aria-hidden="true" /></button>
            <button type="button" onClick={() => { setSlide((i) => (i + 1) % media.length); setPlaying(false); }} className="kv-style-media-nav kv-style-media-nav-end" aria-label="رسانه بعدی"><ChevronLeft size={15} aria-hidden="true" /></button>
            <div className="kv-style-dots" role="tablist" aria-label="رسانه‌های استایل">
              {media.map((m, index) => (
                <button key={`${m.url}-${index}`} type="button" role="tab" aria-selected={index === Math.min(slide, media.length - 1)}
                  aria-label={`${m.kind === "video" ? "ویدیو" : "تصویر"} ${(index + 1).toLocaleString("fa-IR")}`}
                  onClick={() => { setSlide(index); setPlaying(false); }} className="kv-style-dot" data-on={index === Math.min(slide, media.length - 1) ? "true" : "false"} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="kv-style-body">
        <h3 className="kv-style-title">{style.title}</h3>
        {style.description && <p className="kv-style-desc">{style.description}</p>}
        <div className="kv-style-chips">
          <span className="kv-style-chip">{fmtNum(preview.totalCount)} قطعه</span>
          {compatibility?.reasons.length ? <span className="kv-style-chip kv-style-chip-good">{compatibility.reasons[0]}</span> : null}
        </div>
        <div className="kv-style-price">
          {preview.discount.eligible && <s className="kv-style-price-was tabular-nums">{fmtMoney(preview.subtotal)}</s>}
          <span className="kv-style-price-now tabular-nums">{fmtMoney(preview.payable)}</span>
          {discountPercent && preview.discount.eligible && <span className="kv-style-price-badge tabular-nums">{discountPercent}٪ تخفیف</span>}
          {installmentHint && <span className="kv-style-price-inst tabular-nums">{installmentHint}</span>}
        </div>
        <div className="kv-style-ctas">
          <button type="button" onClick={onOpen} className="kv-style-cta-card">مشاهده استایل</button>
          <button type="button" onClick={onPersonalize} className="kv-style-cta-card kv-style-cta-card-alt">
            <Sparkles size={13} aria-hidden="true" /> ساخت استایل شخصی
          </button>
        </div>
      </div>
    </article>
  );
}

/* ============================================================
   Public grid · published styles only (the lens is publicCuratedStyles)
   ============================================================ */

export function CuratedStyleGrid({ styles, catalogue, relations, onOpen, onPersonalize }: {
  styles: CuratedStyle[];
  catalogue: Product[];
  relations: VariantRelation[];
  onOpen: (slug: string) => void;
  onPersonalize: (style: CuratedStyle) => void;
}) {
  const published = publicCuratedStyles(styles);
  if (!published.length) return null;
  /* the grid always composes intentionally: one style reads as a feature
     card (never one card floating beside two empty columns), two styles
     form a balanced pair, three or more keep the editorial 1/2/3 grid. */
  const gridClass = published.length === 1
    ? "mx-auto w-full max-w-[440px]"
    : published.length === 2
      ? "mx-auto grid w-full max-w-[920px] gap-5 sm:grid-cols-2"
      : published.length === 3
        ? "grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        : "grid grid-cols-2 items-start gap-x-[var(--kvaf-grid-gap)] gap-y-[var(--kvaf-grid-gap-y)] lg:grid-cols-2 xl:grid-cols-4";
  return (
    <div className={gridClass}>
      {published.map((style) => (
        <CuratedStyleCard key={style.id} style={style} catalogue={catalogue} relations={relations}
          onOpen={() => onOpen(style.slug)}
          onPersonalize={() => onPersonalize(style)} />
      ))}
    </div>
  );
}

/* ============================================================
   Detail · pinned colours, per-item sizes, live composition
   ============================================================ */

/**
 * Field-driven per-item facts, built with the SAME rule as the PDP: a section
 * exists only when a real catalogue field fills it (ProductDetail.tsx). No
 * size-guide table is invented · the contract does not exist yet, so the fold
 * lists the offered sizes instead and says nothing more.
 */
function StyleItemFacts({ product }: { product: Product }) {
  const specRows = [
    { term: "شناسه کالا", value: product.sku },
    { term: "دسته‌بندی", value: product.category },
    { term: "برند", value: product.brand },
    ...(product.badge ? [{ term: "برچسب کالا", value: product.badge }] : []),
    ...(product.soldNote ? [{ term: "یادداشت فروشنده", value: product.soldNote }] : []),
  ].filter((row) => !!row.value?.trim());
  const sizes = sizesOf(product);

  const about = product.desc?.trim();
  const fabric = product.fabric?.trim();
  if (!about && !fabric && !specRows.length) return null;
  return (
    <div className="kv-style-item-details">
    <Fold title="جزئیات محصول">
      <div className="kv-style-facts">
        {about && <p className="m-0">{about}</p>}
        {fabric && <p className="m-0"><b>جنس و متریال: </b>{fabric}</p>}
        {specRows.length > 0 && (
          <dl className="m-0">
            {specRows.map((row) => (
              <div key={row.term}>
                <dt>{row.term}</dt>
                <dd className={row.term === "شناسه کالا" ? "kvaf-num" : undefined} dir={row.term === "شناسه کالا" ? "ltr" : undefined}>{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {sizes.length > 0 && (
          <p className="m-0"><b>سایزبندی: </b><span className="kvaf-num">{sizes.map((size) => size).join(" · ")}</span></p>
        )}
      </div>
    </Fold>
    </div>
  );
}

export function CuratedStyleDetail({ style, catalogue, relations, onBack, onOpenProduct, onBuildWith, onTryOn, onPersonalize, onAddToCart }: {
  style: CuratedStyle;
  catalogue: Product[];
  relations: VariantRelation[];
  onBack: () => void;
  /** opens the product's own flow (PDP) · «خرید محصول» */
  onOpenProduct: (productId: string) => void;
  /** opens the EXISTING Style Builder entered at this product · «ساخت استایل جدید» */
  onBuildWith?: (productId: string, colorId?: string) => void;
  /** opens the try-on surface for this product; rendered only when eligible · «پرو آنلاین لباس» */
  onTryOn?: (productId: string) => void;
  onPersonalize: () => void;
  /** validated + merged by the EXISTING cart rules; failures come back named */
  onAddToCart: (adds: StyleAdd[]) => { ok: boolean; failures?: LineFailure[] };
}) {
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
  /* per-item quantity: the composition preview and the cart lines both read
     the ONE pipeline, so the stepper only feeds real inputs (stock-capped) */
  const [qtys, setQtys] = useState<Record<string, number>>({});
  /* per-item gallery index: the detail borrows the PDP's image-first voice */
  const [imgIdx, setImgIdx] = useState<Record<string, number>>({});
  const [sizes, setSizes] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const item of style.items) {
      const product = catalogue.find((p) => p.id === item.productId);
      if (product) initial[item.productId] = preferredSize(sizesOf(product));
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);

  const activeProductIds = useMemo(
    () => new Set(style.items.map((i) => i.productId).filter((id) => !disabled.has(id))),
    [style.items, disabled],
  );
  const preview = useMemo(
    () => priceStyle(style, catalogue, { activeProductIds, sizes: new Map(Object.entries(sizes)), qtys: new Map(Object.entries(qtys).map(([id, qty]) => [id, Math.max(1, qty)])) }),
    [style, catalogue, activeProductIds, sizes, qtys],
  );
  const compatibility = useMemo(
    () => (style.items.length >= 2 ? previewCompatibility(style, catalogue, relations) : null),
    [style, catalogue, relations],
  );
  const installmentHint = style.installments.installmentEnabled && preview.installments.mode !== "none" && preview.installments.perInstallment > 0
    ? `۴ × ${fmtMoney(preview.installments.perInstallment)}`
    : null;

  const toggle = (productId: string) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
    setError(null);
  };

  const ordered = [...style.items].sort((a, b) => a.sortOrder - b.sortOrder);
  /* editorial gallery for the detail: the admin media list, else the first
     item's first image · the same rule the grid card uses */
  const gallery = useMemo(() => {
    const list = styleMedia(style);
    if (list.length) return list;
    const fallback = catalogue.find((p) => p.id === ordered[0]?.productId)?.images[0];
    return fallback ? [{ kind: "image" as const, url: fallback }] : [];
  }, [style, catalogue]);
  const [heroSlide, setHeroSlide] = useState(0);
  const [heroPlaying, setHeroPlaying] = useState(false);
  const heroActive = gallery[Math.min(heroSlide, gallery.length - 1)];
  const heroImage = heroActive?.kind === "image" ? heroActive.url : heroActive?.poster ?? "";
  /* only items that actually OFFER sizes can be missing one · one-size
     products (no series composition) are added with the empty size, exactly
     like the product card's quick add */
  const missingSizes = preview.lines.filter((line) => sizesOf(line.product).length > 0 && !sizes[line.item.productId]).length;
  const ctaLabel = preview.allActive ? "افزودن کل استایل به سبد" : `افزودن ${fmtNum(preview.activeCount)} آیتم انتخاب‌شده به سبد`;

  const add = () => {
    setError(null);
    const adds: StyleAdd[] = preview.lines
      .filter((line) => sizesOf(line.product).length === 0 || !!sizes[line.item.productId])
      .map((line) => ({ productId: line.item.productId, colorId: line.item.colorId, size: sizes[line.item.productId] ?? "", qty: Math.max(1, qtys[line.item.productId] ?? 1) }));
    const result = onAddToCart(adds);
    if (!result.ok && result.failures?.length) {
      setError(result.failures.map((f) => `«${catalogue.find((p) => p.id === f.productId)?.name ?? f.productId}»: ${FAILURE_TEXT[f.reason]}`).join(" · "));
    }
  };

  return (
    <div className="kv-sf-shell kv-style-detail">
      <button type="button" onClick={onBack} className="kv-style-back">
        <ArrowRight size={15} /> بازگشت به فروشگاه
      </button>

      {heroImage && (
        <figure className="kv-style-hero">
          <div className="kv-style-hero-frame">
            {heroActive?.kind === "video" && heroPlaying ? (
              <video key={heroActive.url} src={mediaSrc(heroActive.url) ?? heroActive.url} poster={mediaSrc(heroActive.poster ?? "") ?? heroActive.poster} autoPlay muted loop playsInline preload="metadata" className="kv-style-hero-video" aria-label={`ویدیوی استایل ${style.title}`} />
            ) : (
              <img src={mediaSrc(heroImage) ?? heroImage} alt={`کاور استایل ${style.title}`} fetchPriority="high" decoding="async" />
            )}
            {heroActive?.kind === "video" && (
              <button type="button" onClick={() => setHeroPlaying((v) => !v)} className="kv-style-media-nav kv-style-hero-play" aria-label={heroPlaying ? "توقف ویدیو" : "پخش ویدیوی استایل"}>
                {heroPlaying ? "توقف" : <Play size={16} aria-hidden="true" />}
              </button>
            )}
            {gallery.length > 1 && (
              <>
                <button type="button" onClick={() => { setHeroSlide((i) => (i - 1 + gallery.length) % gallery.length); setHeroPlaying(false); }} className="kv-style-media-nav" aria-label="رسانه قبلی"><ChevronRight size={16} aria-hidden="true" /></button>
                <button type="button" onClick={() => { setHeroSlide((i) => (i + 1) % gallery.length); setHeroPlaying(false); }} className="kv-style-media-nav kv-style-media-nav-end" aria-label="رسانه بعدی"><ChevronLeft size={16} aria-hidden="true" /></button>
                <div className="kv-style-dots kv-style-hero-dots" role="tablist" aria-label="رسانه‌های استایل">
                  {gallery.map((m, index) => (
                    <button key={`${m.url}-${index}`} type="button" role="tab" aria-selected={index === Math.min(heroSlide, gallery.length - 1)}
                      aria-label={`${m.kind === "video" ? "ویدیو" : "تصویر"} ${(index + 1).toLocaleString("fa-IR")}`}
                      onClick={() => { setHeroSlide(index); setHeroPlaying(false); }} className="kv-style-dot" data-on={index === Math.min(heroSlide, gallery.length - 1) ? "true" : "false"} />
                  ))}
                </div>
              </>
            )}
          </div>
          <figcaption className="kv-style-hero-flags">
            {preview.discount.eligible && <span className="kv-style-flag">تخفیف استایل</span>}
            <span className="kv-style-flag kv-style-flag-quiet tabular-nums">{fmtNum(preview.totalCount)} قطعه</span>
          </figcaption>
        </figure>
      )}

      <header className="mt-4 max-w-[62ch]">
        <p className="kv-style-eyebrow">استایل آمادهٔ کلبه</p>
        <h1 className="kv-style-heading">{style.title}</h1>
        {style.description && <p className="kv-style-desc mt-2">{style.description}</p>}
        {/* live style summary · same preview the panel below computes */}
        <div className="kv-style-summary" role="group" aria-label="خلاصهٔ استایل">
          <span className="kv-style-chip tabular-nums">{fmtNum(preview.activeCount)} از {fmtNum(preview.totalCount)} قطعه فعال</span>
          <span className="kv-style-chip">
            پرداخت کامل <b className="tabular-nums">{fmtMoney(preview.payable)}</b>
            {preview.discount.eligible && <s className="tabular-nums">{fmtMoney(preview.subtotal)}</s>}
          </span>
          {preview.discount.eligible && <span className="kv-style-chip kv-style-chip-good tabular-nums">تخفیف استایل −{fmtMoney(preview.discount.discount)}</span>}
          {installmentHint && <span className="kv-style-chip tabular-nums">اقساط {installmentHint}</span>}
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* items */}
        <ol className="kv-style-list">
          {ordered.map((item) => {
            const product = catalogue.find((p) => p.id === item.productId);
            if (!product) return null;
            const pinned = product.colors.find((c) => c.id === item.colorId) ?? product.colors[0];
            const media = product.colorMedia?.[pinned?.id ?? ""]?.[0] ?? product.images[0];
            const off = disabled.has(item.productId);
            const sizeChoices = sizesOf(product);
            const soldOut = product.stock < 1;
            const tryOnOk = tryOnEligible(product);
            const gallery = product.images.filter(Boolean);
            const activeImage = gallery[Math.min(imgIdx[item.productId] ?? 0, gallery.length - 1)] ?? media;
            const qtyCap = Math.max(1, Math.min(product.stock, 9));
            const qty = Math.max(1, Math.min(qtys[item.productId] ?? 1, qtyCap));
            const setQty = (next: number) => { setQtys((prev) => ({ ...prev, [item.productId]: Math.max(1, Math.min(next, qtyCap)) })); setError(null); };
            return (
              <li key={item.id} className={cn("kv-style-item", off && "kv-style-item-off")}>
                <div className="kv-style-item-top">
                  <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-item-media" aria-label={`مشاهده ${product.name}`}>
                    <img src={activeImage} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-item-name">{product.name}</button>
                        <p className="kv-style-item-role"><span className="kv-style-role">{ROLE_LABEL[item.role as OutfitRole] ?? item.role}</span></p>
                      </div>
                    </div>
                    {/* pinned colour is ADMIN-fixed: display-only, never a control */}
                    <p className="kv-style-pinned">
                      <span className="kv-style-dot" style={{ background: pinned?.hex }} aria-hidden="true" />
                      رنگ {pinned?.name}
                      <span className="kv-style-pinned-note"><Lock size={11} aria-hidden="true" /> برای این استایل ثابت است</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <p className="kv-style-item-price tabular-nums">{fmtMoney(product.retailPrice * qty)}{qty > 1 && <span className="kv-style-item-price-x"> {fmtNum(qty)} × {fmtMoney(product.retailPrice)}</span>}</p>
                      <p className="kv-sf-stock" data-available={soldOut ? "false" : "true"}>
                        <i aria-hidden="true" />
                        {soldOut ? "ناموجود" : "موجود"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* selection controls: the toggle and the size row stay together */}
                <div className="kv-style-item-controls">
                  <label className="kv-style-switch">
                    <input type="checkbox" checked={!off} onChange={() => toggle(item.productId)} aria-label={`فعال بودن ${product.name}`} />
                    <span>{off ? "غیرفعال" : "فعال"}</span>
                  </label>
                  <div className="kv-style-qty" role="group" aria-label={`تعداد ${product.name}`}>
                    <button type="button" disabled={off || qty <= 1} onClick={() => setQty(qty - 1)} aria-label={`کاهش تعداد ${product.name}`} className="kv-style-qty-btn"><Minus size={13} aria-hidden="true" /></button>
                    <span className="kv-style-qty-n tabular-nums" aria-live="polite">{fmtNum(qty)}</span>
                    <button type="button" disabled={off || qty >= qtyCap} onClick={() => setQty(qty + 1)} aria-label={`افزایش تعداد ${product.name}`} className="kv-style-qty-btn"><Plus size={13} aria-hidden="true" /></button>
                  </div>
                  {sizeChoices.length > 0 ? (
                    <div className="kv-style-sizes" role="group" aria-label={`سایز ${product.name}`}>
                      {sizeChoices.map((size) => (
                        <button key={size} type="button" disabled={off}
                          aria-pressed={sizes[item.productId] === size}
                          onClick={() => { setSizes((prev) => ({ ...prev, [item.productId]: size })); setError(null); }}
                          className={cn("kv-sf-size", sizes[item.productId] === size && "kv-sf-size-on")}>
                          {size}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--kv-muted)]">بدون سایزبندی · یک سایز</p>
                  )}
                </div>

                {/* per-item gallery: same image-first voice as the PDP, only
                    when the catalogue actually carries more than one photo */}
                {gallery.length > 1 && (
                  <div className="kv-style-thumbs" role="group" aria-label={`تصاویر ${product.name}`}>
                    {gallery.slice(0, 4).map((src, index) => (
                      <button key={`${src}-${index}`} type="button" aria-pressed={(imgIdx[item.productId] ?? 0) === index}
                        aria-label={`تصویر ${(index + 1).toLocaleString("fa-IR")} ${product.name}`} onClick={() => setImgIdx((prev) => ({ ...prev, [item.productId]: index }))}
                        className={cn("kv-style-thumb", (imgIdx[item.productId] ?? 0) === index && "kv-style-thumb-on")}>
                        <img src={src} alt="" loading="lazy" />
                      </button>
                    ))}
                  </div>
                )}

                {/* per-item actions: buy its flow · build around it · try it on (business-eligibility only) */}
                <div className="kv-style-item-actions" role="group" aria-label={`اقدامات ${product.name}`}>
                  <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-act">خرید محصول</button>
                  {onBuildWith && (
                    <button type="button" onClick={() => onBuildWith(item.productId, pinned?.id)} className="kv-style-act">
                      <Shirt size={13} aria-hidden="true" /> ساخت استایل جدید
                    </button>
                  )}
                  {onTryOn && tryOnOk && (
                    <button type="button" onClick={() => onTryOn(item.productId)} className="kv-style-act">
                      <ScanFace size={13} aria-hidden="true" /> پرو آنلاین لباس
                    </button>
                  )}
                </div>

                <StyleItemFacts product={product} />
              </li>
            );
          })}
        </ol>

        {/* live composition panel */}
        <aside className="kv-style-panel lg:sticky lg:top-24" aria-live="polite">
          <p className="kv-style-panel-title">ترکیب استایل شما</p>
          <div className="kv-style-rows">
            <div className="kv-style-row"><span>قطعات فعال</span><b className="tabular-nums">{fmtNum(preview.activeCount)} از {fmtNum(preview.totalCount)}</b></div>
            <div className="kv-style-row"><span>جمع قطعات فعال</span><b className="tabular-nums">{fmtMoney(preview.subtotal)}</b></div>
            {preview.discount.eligible ? (
              <div className="kv-style-row kv-style-row-good"><span>تخفیف استایل</span><span className="tabular-nums">−{fmtMoney(preview.discount.discount)}</span></div>
            ) : preview.discount.reason ? (
              <p className="kv-style-note">{preview.discount.reason}</p>
            ) : null}
            {style.installments.installmentEnabled && preview.installments.mode !== "none" && preview.installments.perInstallment > 0 ? (
              <div className="kv-style-row">
                <span>اقساط {preview.installments.mode === "manual" ? "(قیمت دستی)" : "(محاسبهٔ خودکار)"}</span>
                <b className="tabular-nums">۴ × {fmtMoney(preview.installments.perInstallment)}</b>
              </div>
            ) : null}
            {preview.installments.manualInvalidReason && <p className="kv-style-note">{preview.installments.manualInvalidReason}</p>}
            <div className="kv-style-row kv-style-row-total"><span>مبلغ قابل پرداخت</span><b className="tabular-nums">{fmtMoney(preview.payable)}</b></div>
          </div>

          {compatibility && (compatibility.reasons.length || compatibility.warnings.length) ? (
            <div className="kv-style-compat-panel">
              <p className="flex items-center gap-1.5 text-[11.5px] font-extrabold text-[var(--kv-muted)]"><ShieldCheck size={13} /> هماهنگی این ترکیب</p>
              {compatibility.reasons.map((reason) => <p key={reason} className="text-[11.5px] font-bold text-[var(--kv-success)]">{reason}</p>)}
              {compatibility.warnings.map((warning) => <p key={warning} className="text-[11.5px] font-bold text-[var(--kv-accent)]">{warning}</p>)}
            </div>
          ) : null}

          {error && <p role="alert" className="kv-style-error">{error}</p>}
          {missingSizes > 0 && !error && <p className="kv-style-note">برای {fmtNum(missingSizes)} قطعهٔ فعال هنوز سایز انتخاب نشده است.</p>}

          <button type="button" onClick={add} disabled={preview.activeCount === 0 || missingSizes > 0} className="kv-style-cta">
            {ctaLabel}
          </button>
          <button type="button" onClick={onPersonalize} className="kv-style-cta kv-style-cta-quiet">
            <Sparkles size={14} className="inline" /> ساخت استایل شخصی با همین قطعات
          </button>
          <p className="kv-style-fineprint">موجودی، قیمت و تخفیف در لحظهٔ افزودن به سبد دوباره کنترل می‌شود؛ سبد همیشه خط واقعی محصول را نشان می‌دهد.</p>
        </aside>
      </div>
    </div>
  );
}

/** Role chip legend shared by the detail page (kept tiny, taxonomy is shared). */
export const styleRoleLabel = (role: string) => ROLE_LABEL[role as OutfitRole] ?? (CURATED_ROLES.includes(role as OutfitRole) ? role : role);
