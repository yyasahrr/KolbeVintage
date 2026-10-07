/* KOLBE — Curated-style storefront (Phase 3, Non-Core workstream)
 *
 * The customer-facing side of the admin-authored styles:
 *  - CuratedStyleCard: an EDITORIAL card, deliberately distinct from a product
 *    card (cover, title, item count, summary, complete cash total, discount
 *    state, installment flag). It NEVER carries size selectors (§45).
 *  - CuratedStyleDetail: pinned colours are fixed; the shopper picks SIZES and
 *    may enable/disable any item; totals, discount eligibility and the
 *    installment plan update live from the ONE pricing pipeline (§48–§56).
 *
 * Honesty rules carried over from the domain: every number on screen is a
 * preview of `priceStyle` over the CURRENT catalogue; the cart mutation
 * revalidates with the existing retail rules and the order recompute happens
 * in the store (server-side in production). Nothing here executes a payment.
 */
import { useMemo, useState } from "react";
import { ArrowRight, Layers, ShieldCheck, Sparkles } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../data/catalog";
import { FAILURE_TEXT, type LineFailure } from "../data/cart";
import {
  CURATED_ROLES, priceStyle, previewCompatibility, publicCuratedStyles,
  type CuratedStyle, type VariantRelation,
} from "../data/curated";
import { ROLE_LABEL, type OutfitRole } from "../data/styling";
import { preferredSize, sizesOf } from "../components/storefront/shared";
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
  return (
    <article className="kv-style-card" aria-label={style.title}>
      <button type="button" onClick={onOpen} className="kv-style-cover" aria-label={`مشاهده استایل ${style.title}`}>
        {cover ? <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" /> : <span className="flex h-full w-full items-center justify-center bg-[var(--kv-surface-2)]"><Layers size={28} className="text-[var(--kv-muted)]" /></span>}
        <span className="kv-style-cover-veil" aria-hidden="true" />
        {preview.discount.eligible && <span className="kv-style-flag">تخفیف استایل</span>}
        {style.installments.installmentEnabled && <span className="kv-style-flag kv-style-flag-quiet">خرید اقساطی</span>}
      </button>
      <div className="kv-style-body">
        <h3 className="kv-style-title">{style.title}</h3>
        {style.description && <p className="kv-style-desc">{style.description}</p>}
        <p className="kv-style-meta">
          <span>{fmtNum(preview.totalCount)} قطعه</span>
          <span aria-hidden="true">·</span>
          <span>جمع کامل <b className="tabular-nums">{fmtMoney(preview.subtotal)}</b></span>
          {preview.discount.eligible && <span className="kv-style-discount tabular-nums">با تخفیف {fmtMoney(preview.payable)}</span>}
        </p>
        {compatibility?.reasons.length ? <p className="kv-style-compat">{compatibility.reasons[0]}</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={onOpen} className="kv-sf-action">مشاهده استایل</button>
          <button type="button" onClick={onPersonalize} className="kv-sf-action kv-sf-action-quiet">
            <Sparkles size={13} className="inline" /> ساخت استایل شخصی
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

export function CuratedStyleDetail({ style, catalogue, relations, onBack, onOpenProduct, onPersonalize, onAddToCart }: {
  style: CuratedStyle;
  catalogue: Product[];
  relations: VariantRelation[];
  onBack: () => void;
  onOpenProduct: (productId: string) => void;
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

      <header className="mt-4 max-w-[62ch]">
        <p className="kv-style-eyebrow">استایل آمادهٔ کلبه</p>
        <h1 className="kv-style-heading">{style.title}</h1>
        {style.description && <p className="kv-style-desc mt-2">{style.description}</p>}
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* items */}
        <ol className="space-y-3">
          {ordered.map((item) => {
            const product = catalogue.find((p) => p.id === item.productId);
            if (!product) return null;
            const pinned = product.colors.find((c) => c.id === item.colorId) ?? product.colors[0];
            const media = product.colorMedia?.[pinned?.id ?? ""]?.[0] ?? product.images[0];
            const off = disabled.has(item.productId);
            const sizeChoices = sizesOf(product);
            return (
              <li key={item.id} className={cn("kv-style-item", off && "kv-style-item-off")}>
                <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-item-media" aria-label={`مشاهده ${product.name}`}>
                  <img src={media} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button type="button" onClick={() => onOpenProduct(item.productId)} className="kv-style-item-name">{product.name}</button>
                      <p className="kv-style-item-role">{ROLE_LABEL[item.role as OutfitRole] ?? item.role}</p>
                    </div>
                    <label className="kv-style-switch">
                      <input type="checkbox" checked={!off} onChange={() => toggle(item.productId)} aria-label={`فعال بودن ${product.name}`} />
                      <span>{off ? "غیرفعال" : "فعال"}</span>
                    </label>
                  </div>
                  <p className="kv-style-pinned">
                    <span className="kv-style-dot" style={{ background: pinned?.hex }} />
                    رنگ {pinned?.name} <span className="text-[var(--kv-faint)]">(برای این استایل ثابت است)</span>
                  </p>
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
                  <p className="kv-style-item-price tabular-nums">{fmtMoney(product.retailPrice)}</p>
                </div>
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
