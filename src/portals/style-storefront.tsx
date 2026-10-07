/* KOLBE — Curated-style storefront (Phase 3, Non-Core workstream)
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
 *    pipeline (§48–§56). Every item exposes three actions — خرید محصول
 *    (its own product flow), ساخت استایل جدید (the existing Style Builder
 *    entered at that product) and پرو آنلاین لباس (the try-on surface, only
 *    when `tryOnEligible` says so — unsupported products never get a dead
 *    entry point), plus a field-driven «جزئیات» fold reusing the PDP's
 *    sections pattern so each product can be inspected properly.
 *
 * Honesty rules carried over from the domain: every number on screen is a
 * preview of `priceStyle` over the CURRENT catalogue; the cart mutation
 * revalidates with the existing retail rules and the order recompute happens
 * in the store (server-side in production). Nothing here executes a payment.
 */
import { useMemo, useState } from "react";
import { ArrowRight, Layers, Lock, ScanFace, ShieldCheck, Shirt, Sparkles } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../data/catalog";
import { FAILURE_TEXT, type LineFailure } from "../data/cart";
import {
  CURATED_ROLES, priceStyle, previewCompatibility, publicCuratedStyles,
  type CuratedStyle, type VariantRelation,
} from "../data/curated";
import { ROLE_LABEL, tryOnEligible, type OutfitRole } from "../data/styling";
import { Fold, preferredSize, sizesOf } from "../components/storefront/shared";
import { cn } from "../utils/cn";

export type StyleAdd = { productId: string; colorId: string; size: string; qty: number };

/* ============================================================
   Card — homepage «استایل‌های آماده»
   ============================================================ */

export function CuratedStyleCard({ style, catalogue, relations, onOpen, onPersonalize }: {
  style: CuratedStyle;
  catalogue: Product[];
  relations: VariantRelation[];
  onOpen: () => void;
  onPersonalize: () => void;
}) {
  const preview = useMemo(() => priceStyle(style, catalogue), [style, catalogue]);
  const cover = style.cover ?? catalogue.find((p) => p.id === style.items[0]?.productId)?.images[0];
  const compatibility = style.items.length >= 2 ? previewCompatibility(style, catalogue, relations) : null;
  const discountPercent = style.pricing.discountType === "percentage" && style.pricing.discountValue > 0
    ? fmtNum(style.pricing.discountValue)
    : null;
  const installmentHint = style.installments.installmentEnabled && preview.installments.mode !== "none" && preview.installments.perInstallment > 0
    ? `یا ۴ قسطِ ${fmtMoney(preview.installments.perInstallment)}`
    : null;
  return (
    <article className="kv-style-card group" aria-label={style.title}>
      <button type="button" onClick={onOpen} className="kv-style-cover" aria-label={`مشاهده استایل ${style.title}`}>
        {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" /> : <span className="flex h-full w-full items-center justify-center bg-[var(--kv-surface-2)]"><Layers size={28} className="text-[var(--kv-muted)]" /></span>}
        <span className="kv-style-cover-veil" aria-hidden="true" />
        {preview.discount.eligible && <span className="kv-style-flag">تخفیف استایل</span>}
        {style.installments.installmentEnabled && <span className="kv-style-flag kv-style-flag-quiet">خرید اقساطی</span>}
      </button>
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
   Public grid — published styles only (the lens is publicCuratedStyles)
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
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {published.map((style) => (
        <CuratedStyleCard key={style.id} style={style} catalogue={catalogue} relations={relations}
          onOpen={() => onOpen(style.slug)}
          onPersonalize={() => onPersonalize(style)} />
      ))}
    </div>
  );
}

/* ============================================================
   Detail — pinned colours, per-item sizes, live composition
   ============================================================ */

/**
 * Field-driven per-item facts, built with the SAME rule as the PDP: a section
 * exists only when a real catalogue field fills it (ProductDetail.tsx). No
 * size-guide table is invented — the contract does not exist yet, so the fold
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
  /** opens the product's own flow (PDP) — «خرید محصول» */
  onOpenProduct: (productId: string) => void;
  /** opens the EXISTING Style Builder entered at this product — «ساخت استایل جدید» */
  onBuildWith?: (productId: string, colorId?: string) => void;
  /** opens the try-on surface for this product; rendered only when eligible — «پرو آنلاین لباس» */
  onTryOn?: (productId: string) => void;
  onPersonalize: () => void;
  /** validated + merged by the EXISTING cart rules; failures come back named */
  onAddToCart: (adds: StyleAdd[]) => { ok: boolean; failures?: LineFailure[] };
}) {
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set());
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
    () => priceStyle(style, catalogue, { activeProductIds, sizes: new Map(Object.entries(sizes)), qtys: new Map() }),
    [style, catalogue, activeProductIds, sizes],
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
  /* editorial cover for the detail: the admin-picked cover, else the first
     item's first image — the same rule the grid card uses */
  const cover = style.cover ?? catalogue.find((p) => p.id === ordered[0]?.productId)?.images[0];
  /* only items that actually OFFER sizes can be missing one — one-size
     products (no series composition) are added with the empty size, exactly
     like the product card's quick add */
  const missingSizes = preview.lines.filter((line) => sizesOf(line.product).length > 0 && !sizes[line.item.productId]).length;
  const ctaLabel = preview.allActive ? "افزودن کل استایل به سبد" : `افزودن ${fmtNum(preview.activeCount)} آیتم انتخاب‌شده به سبد`;

  const add = () => {
    setError(null);
    const adds: StyleAdd[] = preview.lines
      .filter((line) => sizesOf(line.product).length === 0 || !!sizes[line.item.productId])
      .map((line) => ({ productId: line.item.productId, colorId: line.item.colorId, size: sizes[line.item.productId] ?? "", qty: 1 }));
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

      {cover && (
        <figure className="kv-style-hero">
          <img src={cover} alt={`کاور استایل ${style.title}`} fetchPriority="high" decoding="async" />
          <span className="kv-style-hero-veil" aria-hidden="true" />
          <figcaption className="kv-style-hero-caption">
            {preview.discount.eligible && <span className="kv-style-flag">تخفیف استایل</span>}
            <span className="kv-style-flag kv-style-flag-quiet tabular-nums">{fmtNum(preview.totalCount)} قطعه</span>
          </figcaption>
        </figure>
      )}

      <header className="mt-4 max-w-[62ch]">
        <p className="kv-style-eyebrow">استایل آمادهٔ کلبه</p>
        <h1 className="kv-style-heading">{style.title}</h1>
        {style.description && <p className="kv-style-desc mt-2">{style.description}</p>}
        {/* live style summary — same preview the panel below computes */}
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
            return (
              <li key={item.id} className={cn("kv-style-item", off && "kv-style-item-off")}>
                <div className="kv-style-item-top">
                  <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-item-media" aria-label={`مشاهده ${product.name}`}>
                    <img src={media} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
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
                      <p className="kv-style-item-price tabular-nums">{fmtMoney(product.retailPrice)}</p>
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
                    <p className="text-[11px] text-[var(--kv-muted)]">بدون سایزبندی — یک سایز</p>
                  )}
                </div>

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
          <p className="kv-style-fineprint">موجودی، قیمت و تخفیف در لحظهٔ افزودن به سبد دوباره کنترل می‌شود؛ سبداً همیشه خط واقعیِ محصول است.</p>
        </aside>
      </div>
    </div>
  );
}

/** Role chip legend shared by the detail page (kept tiny, taxonomy is shared). */
export const styleRoleLabel = (role: string) => ROLE_LABEL[role as OutfitRole] ?? (CURATED_ROLES.includes(role as OutfitRole) ? role : role);
