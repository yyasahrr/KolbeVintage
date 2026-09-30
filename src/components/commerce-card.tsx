import { useEffect, useState } from "react";
import { Check, Loader2, ShoppingBag, Star, Timer } from "lucide-react";
import { rialToToman, siteApi, type CommerceProduct } from "../data/experience-api";
import { fmtMoney } from "../data/catalog";
import { ResponsiveImg } from "./responsive-img";
import { useToast } from "./toast";
import { cn } from "../utils/cn";

/* Product Card System (Req 193-200). The card is driven by the DB template (`cms_product_card_templates`):
   its block list decides WHAT is shown and in which order, its style tokens decide HOW. The server picks
   the template per product via card rules (`product.cardTemplate`); a section may force a variant. */

export type CardTemplate = { code: string; name: string; variant: string; blocks: string[]; styles: CardStyles };
export type CardStyles = {
  aspectRatio?: string; radius?: string; badgeTone?: string; accentColor?: string; darkSurface?: boolean; serifTitle?: boolean;
  highlightDiscount?: boolean; prominentInstallment?: boolean; borderless?: boolean; luxuryBorder?: boolean; showSwatches?: boolean;
  titleLines?: number; hoverEffect?: string; ctaStyle?: string; focusRing?: string; textAlign?: string; imageFit?: string; badgeText?: string;
};
export type CardPreviewState = "default" | "hover" | "loading" | "added" | "soldout" | "skeleton";

const FALLBACK: CardTemplate = { code: "kolbe-classic", name: "کلاسیک", variant: "classic", blocks: ["image", "badge", "brand", "name", "discount_price", "installment", "rating", "cta"], styles: { aspectRatio: "3/4", radius: "18px", accentColor: "#1B2A4A", titleLines: 2, hoverEffect: "zoom", ctaStyle: "solid" } };
const BADGE_TONE: Record<string, string> = {
  danger: "bg-[var(--kv-danger)] text-white", terra: "bg-[#A34E2E] text-white", navy: "bg-[#1B2A4A] text-white", gold: "bg-[#8A6A3E] text-white",
  emerald: "bg-[#2E5A44] text-white", glass: "bg-white/75 text-[#0E1527] backdrop-blur-md", surface: "bg-[var(--kv-surface)] text-[var(--kv-ink)] border border-[var(--kv-line)]",
};
const VARIANT_BADGE: Record<string, string> = { new: "تازه‌رسیده", premium: "Premium", "flash-sale": "فروش فوری", installment: "اقساطی" };
const fa = (n: number) => n.toLocaleString("fa-IR");

let cache: Promise<CardTemplate[]> | null = null;
let loaded: CardTemplate[] | null = null;
export const invalidateCardTemplates = () => { cache = null; loaded = null; };
export function useCardTemplates(): CardTemplate[] {
  const [items, setItems] = useState<CardTemplate[]>(loaded ?? []);
  useEffect(() => {
    if (loaded) return;
    cache ??= siteApi.cardTemplates().then((r) => (loaded = r.items as CardTemplate[])).catch(() => (loaded = []));
    let alive = true;
    void cache.then((x) => alive && setItems(x));
    return () => { alive = false; };
  }, []);
  return items;
}
/** Section-level forced variant (product_grid.cardVariant) → first active template with that variant. */
export function pickTemplate(templates: CardTemplate[], product: CommerceProduct, forcedVariant?: string, forcedCode?: string): CardTemplate {
  const byCode = (c?: string) => (c ? templates.find((t) => t.code === c) : undefined);
  const forced = forcedVariant && forcedVariant !== "auto" ? templates.find((t) => t.variant === (forcedVariant === "default" ? "classic" : forcedVariant)) : undefined;
  return byCode(forcedCode) ?? forced ?? byCode(product.cardTemplate) ?? byCode("kolbe-classic") ?? FALLBACK;
}

export function CommerceCard({ product, onOpen, onQuickAdd, pageCode, variant, template: explicit, previewState }: {
  product: CommerceProduct; onOpen?: (id: string) => void; onQuickAdd?: (p: CommerceProduct) => boolean; pageCode?: string;
  variant?: string; template?: CardTemplate; previewState?: CardPreviewState;
}) {
  const templates = useCardTemplates();
  const tpl = explicit ?? pickTemplate(templates, product, variant);
  const s = { ...FALLBACK.styles, ...tpl.styles };
  const toast = useToast();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const shownState = previewState === "loading" ? "loading" : previewState === "added" ? "done" : state;
  const soldOut = previewState === "soldout" || product.available < 1;
  const has = (b: string) => tpl.blocks.includes(b);
  const price = rialToToman(product.priceRial);
  const compare = product.compareAtRial ? rialToToman(product.compareAtRial) : 0;
  const badgeText = s.badgeText || (tpl.variant === "sale" || s.highlightDiscount ? (product.discountPercent ? `٪${fa(product.discountPercent)} تخفیف` : null) : VARIANT_BADGE[tpl.variant] ?? (product.isNew ? "جدید" : null));
  const dark = !!s.darkSurface;
  const offer = product.installmentOffers?.[0];
  const perInstallment = offer?.perInstallmentRial ?? product.perInstallmentRial;
  const count = offer?.count ?? product.installmentsCount ?? 4;
  const colors = [...new Set(product.variants.map((v) => v.color).filter(Boolean))] as string[];
  const add = () => {
    if (!onQuickAdd || soldOut || previewState) return;
    setState("loading");
    window.setTimeout(() => {
      const ok = onQuickAdd(product);
      setState(ok ? "done" : "idle");
      if (ok) { toast.bumpCart(); toast.push(`«${product.name}» به سبد خرید اضافه شد.`); window.setTimeout(() => setState("idle"), 1400); }
      else toast.push("این سایز دیگر موجود نیست.", "error");
    }, 250);
  };

  if (previewState === "skeleton") return (
    <div aria-hidden className="animate-pulse p-2" style={{ borderRadius: s.radius }}>
      <div className="rounded-[14px] bg-[var(--kv-surface-2)]" style={{ aspectRatio: s.aspectRatio }} />
      <div className="mt-3 h-3 w-1/3 rounded bg-[var(--kv-surface-2)]" /><div className="mt-2 h-4 w-3/4 rounded bg-[var(--kv-surface-2)]" /><div className="mt-2 h-4 w-1/2 rounded bg-[var(--kv-surface-2)]" />
    </div>
  );

  const hover = previewState === "hover";
  const ctaCls = s.ctaStyle === "outline" ? "border border-current bg-transparent" : s.ctaStyle === "ghost" ? "bg-[var(--kv-surface-2)] text-[var(--kv-ink)]" : "text-white";
  return (
    <article data-card-template={tpl.code} data-card-state={previewState ?? "live"}
      className={cn("group overflow-hidden p-2 transition-all duration-300",
        !s.borderless && "border", dark ? "dark border-white/10 bg-[#111622] text-[#F9F6F1]" : "border-[var(--kv-line)] bg-[var(--kv-surface)]",
        s.borderless && "bg-transparent",
        s.hoverEffect === "lift" && "hover:-translate-y-1 hover:shadow-[var(--shadow-soft-md)]", s.hoverEffect === "shadow" && "hover:shadow-[var(--shadow-soft-md)]",
        hover && (s.hoverEffect === "lift" ? "-translate-y-1 shadow-[var(--shadow-soft-md)]" : "shadow-[var(--shadow-soft-md)]"))}
      style={{ borderRadius: s.radius, borderColor: s.luxuryBorder ? `${s.accentColor}73` : s.highlightDiscount ? `${s.accentColor}59` : undefined, textAlign: s.textAlign === "center" ? "center" : undefined }}>
      <button onClick={() => { if (previewState) return; siteApi.event({ eventType: "product_card.click", pageCode, targetId: product.id }); onOpen?.(product.id); }}
        className={cn("block w-full text-right focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2", s.focusRing === "ink" ? "focus-visible:outline-[var(--kv-ink)]" : "focus-visible:outline-[var(--kv-accent)]")} aria-label={product.name}>
        {has("image") && (
          <div className="kv-img relative overflow-hidden rounded-[14px] bg-[var(--kv-surface-2)]" style={{ aspectRatio: s.aspectRatio }}>
            {product.image ? <ResponsiveImg src={product.image} alt={product.name} sizes="(min-width: 768px) 25vw, 50vw"
              className={cn("h-full w-full transition-transform duration-500", s.imageFit === "contain" ? "object-contain" : "object-cover", s.hoverEffect === "zoom" && "group-hover:scale-105", hover && s.hoverEffect === "zoom" && "scale-105")} />
              : <div className="flex h-full w-full items-center justify-center text-[12px] text-[var(--kv-muted)]">بدون تصویر</div>}
            {has("badge") && badgeText && <span className={cn("absolute right-2 top-2 rounded-full px-2.5 py-1 text-[11px] font-bold", BADGE_TONE[s.badgeTone ?? ""] ?? "text-white")} style={!BADGE_TONE[s.badgeTone ?? ""] ? { background: s.accentColor } : undefined}>{badgeText}</span>}
            {soldOut && <span className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 py-1 text-center text-[11.5px] font-bold text-white">ناموجود</span>}
          </div>
        )}
        <div className="px-1.5 pt-3">
          {has("brand") && <p className="text-[11.5px] text-[var(--kv-muted)]">{product.brand}</p>}
          {has("name") && <p className={cn("mt-0.5 font-bold leading-6", s.serifTitle ? "kv-serif text-[17px]" : "text-[14px]")} style={{ display: "-webkit-box", WebkitLineClamp: s.titleLines ?? 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{product.name}</p>}
          {(has("discount_price") || has("original_price")) && (
            <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
              {has("discount_price") && <b className="text-[14.5px] tabular-nums" style={s.highlightDiscount && compare > price ? { color: s.accentColor } : undefined}>{fmtMoney(price)}</b>}
              {has("original_price") && compare > price && <s className="text-[12px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(compare)}</s>}
              {!has("original_price") && has("discount_price") && compare > price && <s className="text-[12px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(compare)}</s>}
            </div>
          )}
          {has("installment") && perInstallment && (
            <p className={cn("mt-1 text-[11.5px] tabular-nums", s.prominentInstallment ? "font-bold" : "text-[var(--kv-muted)]")} style={s.prominentInstallment ? { color: s.accentColor } : undefined}>
              {fa(count)} قسط × {fmtMoney(rialToToman(perInstallment))}{offer ? ` · ${offer.title}` : ""}
            </p>
          )}
          {has("rating") && product.reviewCount > 0 && <p className="mt-1 flex items-center gap-1 text-[11.5px] text-[var(--kv-muted)]"><Star size={12} fill="#D6A94E" strokeWidth={0} />{fa(product.rating)} ({fa(product.reviewCount)})</p>}
          {has("countdown") && product.discountPercent > 0 && <p className="mt-1 flex items-center gap-1 text-[11.5px] font-bold" style={{ color: s.accentColor }}><Timer size={12} />پیشنهاد محدود</p>}
          {(has("swatches") || s.showSwatches) && colors.length > 1 && <p className="mt-1.5 text-[11px] text-[var(--kv-muted)]">{fa(colors.length)} رنگ: {colors.slice(0, 3).join("، ")}</p>}
        </div>
      </button>
      {has("cta") && (onQuickAdd || previewState) && (
        <button onClick={add} disabled={soldOut || shownState === "loading"} aria-label={`افزودن ${product.name} به سبد خرید`}
          className={cn("kv-press mx-1.5 mb-1.5 mt-3 flex h-10 w-[calc(100%-12px)] items-center justify-center gap-1.5 rounded-[10px] text-[12.5px] font-semibold disabled:opacity-40", ctaCls)}
          style={s.ctaStyle === "solid" || !s.ctaStyle ? { background: dark ? "#F9F6F1" : s.accentColor, color: dark ? "#0E1527" : "#fff" } : s.ctaStyle === "outline" ? { color: s.accentColor } : undefined}>
          {shownState === "loading" ? <Loader2 size={15} className="animate-spin" /> : shownState === "done" ? <Check size={15} className="kv-check-pop" /> : <ShoppingBag size={15} />}
          {shownState === "done" ? "اضافه شد" : soldOut ? "ناموجود" : "افزودن به سبد"}
        </button>
      )}
    </article>
  );
}
