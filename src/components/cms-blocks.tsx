import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BadgeCheck, Check, Loader2, Quote, ShoppingBag, Star } from "lucide-react";
import { mediaSrc, rialToToman, siteApi, type CommerceProduct, type PageSection, type SitePage } from "../data/experience-api";
import { fmtMoney } from "../data/catalog";
import { HeroRenderer } from "./cms-render";
import type { HeroConfig } from "../data/ops";
import { Btn, Empty, ErrorState, LoadingState } from "./primitives";
import { useToast } from "./toast";
import { cn } from "../utils/cn";

/* Registered-component renderer. Admins compose pages from these blocks; data always comes from
   the commerce domains resolved server-side (products, WMS, pricing, campaigns, reviews). */

type Nav = (target: string) => void;
type QuickAdd = (product: CommerceProduct) => boolean;
const fa = (n: number) => n.toLocaleString("fa-IR");
/** Neutral paper tone used when a CMS block has no media yet (never an empty src). */
const PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"><rect width="4" height="5" fill="#EFE7DA"/></svg>');
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const lines = (v: unknown) => str(v).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split("|"));

/** Fires `component.view` once per mount when the block becomes visible (Req 236). */
function useViewEvent(pageCode: string | undefined, section: PageSection) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { siteApi.event({ eventType: "component.view", pageCode, sectionId: section.id, componentCode: section.component_code }); io.disconnect(); }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [pageCode, section.id, section.component_code]);
  return ref;
}

/* ============================ Product card (rule-aware) ============================ */

const TEMPLATE_STYLE: Record<string, { ratio: string; frame: string; title?: string; badge?: { label: (p: CommerceProduct) => string | null; cls: string } }> = {
  "kolbe-classic": { ratio: "aspect-[3/4]", frame: "rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]" },
  "kolbe-editorial": { ratio: "aspect-[4/5]", frame: "rounded-[22px] border border-[var(--kv-line)] bg-[var(--kv-surface)]", title: "kv-serif text-[17px]" },
  "kolbe-minimal": { ratio: "aspect-[3/4]", frame: "rounded-[14px]" },
  "kolbe-sale": { ratio: "aspect-[3/4]", frame: "rounded-[18px] border border-[var(--kv-danger)]/35 bg-[var(--kv-surface)]", badge: { label: (p) => (p.discountPercent ? `٪${fa(p.discountPercent)} تخفیف` : null), cls: "bg-[var(--kv-danger)] text-white" } },
  "kolbe-flash-sale": { ratio: "aspect-[3/4]", frame: "rounded-[18px] border border-[var(--kv-accent)]/40 bg-[var(--kv-surface)]", badge: { label: () => "فروش فوری", cls: "bg-[var(--kv-accent)] text-white" } },
  "kolbe-new-arrival": { ratio: "aspect-[3/4]", frame: "rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)]", badge: { label: () => "تازه‌رسیده", cls: "bg-[#2E5A44] text-white" } },
  "kolbe-premium": { ratio: "aspect-[4/5]", frame: "rounded-[22px] border border-[#8A6A3E]/45 bg-[var(--kv-surface)]", title: "kv-serif text-[17px]", badge: { label: () => "Premium", cls: "bg-[#8A6A3E] text-white" } },
  "kolbe-installment": { ratio: "aspect-[3/4]", frame: "rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]", badge: { label: () => "۴ قسط", cls: "bg-[var(--kv-action)] text-[var(--kv-bg)]" } },
  "kolbe-dark": { ratio: "aspect-[3/4]", frame: "dark rounded-[18px] border border-white/10 bg-[#111622] text-[#F9F6F1]" },
};

export function CommerceCard({ product, onOpen, onQuickAdd, pageCode }: { product: CommerceProduct; onOpen?: (id: string) => void; onQuickAdd?: QuickAdd; pageCode?: string }) {
  const tpl = TEMPLATE_STYLE[product.cardTemplate ?? "kolbe-classic"] ?? TEMPLATE_STYLE["kolbe-classic"]!;
  const toast = useToast();
  const [state, setState] = useState<"idle" | "loading" | "done">("idle");
  const badge = tpl.badge?.label(product);
  const price = rialToToman(product.priceRial);
  const compare = product.compareAtRial ? rialToToman(product.compareAtRial) : 0;
  const soldOut = product.available < 1;
  const add = () => {
    if (!onQuickAdd || soldOut) return;
    setState("loading");
    window.setTimeout(() => {
      const ok = onQuickAdd(product);
      setState(ok ? "done" : "idle");
      if (ok) { toast.bumpCart(); toast.push(`«${product.name}» به سبد خرید اضافه شد.`); window.setTimeout(() => setState("idle"), 1400); }
      else toast.push("این سایز دیگر موجود نیست.", "error");
    }, 250);
  };
  return (
    <article className={cn("group overflow-hidden p-2 transition-shadow hover:shadow-[var(--shadow-soft-md)]", tpl.frame)}>
      <button onClick={() => { siteApi.event({ eventType: "product_card.click", pageCode, targetId: product.id }); onOpen?.(product.id); }} className="block w-full text-right" aria-label={product.name}>
        <div className={cn("kv-img relative overflow-hidden rounded-[14px]", tpl.ratio)}>
          {product.image ? <img src={mediaSrc(product.image)} alt={product.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
            : <div className="flex h-full w-full items-center justify-center bg-[var(--kv-surface-2)] text-[12px] text-[var(--kv-muted)]">بدون تصویر</div>}
          {badge && <span className={cn("absolute right-2 top-2 rounded-full px-2.5 py-1 text-[11px] font-bold", tpl.badge!.cls)}>{badge}</span>}
          {soldOut && <span className="absolute inset-x-2 bottom-2 rounded-lg bg-black/60 py-1 text-center text-[11.5px] font-bold text-white">ناموجود</span>}
        </div>
        <div className="px-1.5 pt-3">
          <p className="text-[11.5px] text-[var(--kv-muted)]">{product.brand}</p>
          <p className={cn("mt-0.5 line-clamp-2 font-bold leading-6", tpl.title ?? "text-[14px]")}>{product.name}</p>
          <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
            <b className={cn("text-[14.5px] tabular-nums", product.cardTemplate === "kolbe-sale" && "text-[var(--kv-danger)]")}>{fmtMoney(price)}</b>
            {compare > price && <s className="text-[12px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(compare)}</s>}
          </div>
          {product.perInstallmentRial && (
            <p className={cn("mt-1 text-[11.5px] tabular-nums", product.cardTemplate === "kolbe-installment" ? "font-bold text-[var(--kv-accent)]" : "text-[var(--kv-muted)]")}>
              ۴ قسط × {fmtMoney(rialToToman(product.perInstallmentRial))}
            </p>
          )}
          {product.reviewCount > 0 && <p className="mt-1 flex items-center gap-1 text-[11.5px] text-[var(--kv-muted)]"><Star size={12} fill="#D6A94E" strokeWidth={0} />{fa(product.rating)} ({fa(product.reviewCount)})</p>}
        </div>
      </button>
      {onQuickAdd && (
        <button onClick={add} disabled={soldOut || state === "loading"} aria-label={`افزودن ${product.name} به سبد خرید`}
          className="kv-press mx-1.5 mb-1.5 mt-3 flex h-10 w-[calc(100%-12px)] items-center justify-center gap-1.5 rounded-[10px] bg-[var(--kv-action)] text-[12.5px] font-semibold text-[var(--kv-bg)] disabled:opacity-40 dark:text-[#0E1527]">
          {state === "loading" ? <Loader2 size={15} className="animate-spin" /> : state === "done" ? <Check size={15} className="kv-check-pop" /> : <ShoppingBag size={15} />}
          {state === "done" ? "اضافه شد" : soldOut ? "ناموجود" : "افزودن به سبد"}
        </button>
      )}
    </article>
  );
}

function ProductGrid({ products, columns = 4, onOpen, onQuickAdd, pageCode, empty }: { products: CommerceProduct[]; columns?: number; onOpen?: (id: string) => void; onQuickAdd?: QuickAdd; pageCode?: string; empty?: string }) {
  if (!products.length) return <p className="rounded-[14px] border border-dashed border-[var(--kv-line-strong)] p-6 text-center text-[12.5px] text-[var(--kv-muted)]">{empty ?? "محصولی برای این بخش یافت نشد."}</p>;
  return (
    <div className={cn("grid grid-cols-2 gap-4", columns >= 4 ? "md:grid-cols-4" : columns === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
      {products.map((p) => <CommerceCard key={p.id} product={p} onOpen={onOpen} onQuickAdd={onQuickAdd} pageCode={pageCode} />)}
    </div>
  );
}

function Countdown({ endsAt, title, tone, cta, onCta }: { endsAt?: string | null; title: string; tone: string; cta?: string; onCta?: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const left = endsAt ? Math.max(0, new Date(endsAt).getTime() - now) : 0;
  if (!left) return null;
  const cell = (v: number, l: string) => <div className="min-w-[62px] rounded-[12px] bg-white/12 px-3 py-2.5 text-center backdrop-blur-md"><p className="text-[22px] font-extrabold tabular-nums">{v.toLocaleString("fa-IR", { minimumIntegerDigits: 2 })}</p><p className="text-[11px] opacity-80">{l}</p></div>;
  return (
    <section className={cn("flex flex-wrap items-center justify-between gap-5 rounded-[20px] p-6 md:p-8", tone === "dark" ? "bg-[#0B0F17] text-white" : tone === "navy" ? "bg-[#1B2A4A] text-[#F5EFE3]" : "bg-[#A34E2E] text-white")}>
      <h2 className="text-[20px] font-extrabold md:text-[24px]">{title}</h2>
      <div className="flex items-center gap-2" role="timer" aria-label="زمان باقی‌مانده">{cell(Math.floor(left / 86400000), "روز")}{cell(Math.floor(left / 3600000) % 24, "ساعت")}{cell(Math.floor(left / 60000) % 60, "دقیقه")}{cell(Math.floor(left / 1000) % 60, "ثانیه")}</div>
      {cta && <button onClick={onCta} className="kv-press h-11 rounded-[11px] bg-white px-5 text-[13.5px] font-bold text-[#1B2A4A]">{cta}</button>}
    </section>
  );
}

function LeadForm({ section, pageCode }: { section: PageSection; pageCode: string }) {
  const p = section.payload;
  const [form, setForm] = useState({ fullName: "", phone: "", email: "", consent: false });
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError("");
    if (!form.consent) { setError("برای ارسال، پذیرش شرایط لازم است."); return; }
    if (!/^09\d{9}$/.test(form.phone) && !form.email) { setError("شماره همراه ۱۱ رقمی یا ایمیل را وارد کنید."); return; }
    setState("loading");
    try {
      await siteApi.lead({ pageCode, campaignSource: str(p.campaignSource) || pageCode, fullName: form.fullName || undefined, phone: form.phone || undefined, email: form.email || undefined, consent: true });
      setState("done");
    } catch (err) { setState("error"); setError(err instanceof Error ? err.message : "ارسال ناموفق بود."); }
  };
  if (state === "done") return <section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-8 text-center"><BadgeCheck className="mx-auto text-[var(--kv-success)]" size={32} /><p className="mt-3 text-[16px] font-extrabold">ثبت شد؛ به‌زودی با شما تماس می‌گیریم.</p></section>;
  return (
    <section className="grid gap-6 rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:grid-cols-2 md:p-10">
      <div><h2 className="kv-editorial-title text-[24px]">{str(p.title, section.title)}</h2><p className="mt-2 text-[13.5px] leading-7 text-[var(--kv-muted)]">{str(p.subtitle)}</p></div>
      <form onSubmit={submit} className="space-y-3" noValidate>
        {p.collectName !== false && <label className="block text-[12.5px] font-semibold">نام<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="name" /></label>}
        <label className="block text-[12.5px] font-semibold">شماره همراه<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 11) })} inputMode="tel" dir="ltr" className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="tel" /></label>
        {p.collectEmail !== false && <label className="block text-[12.5px] font-semibold">ایمیل (اختیاری)<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} dir="ltr" className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="email" /></label>}
        <label className="flex items-start gap-2 text-[12px] leading-6 text-[var(--kv-muted)]"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} className="mt-1.5 h-4 w-4 accent-[#C1613B]" />{str(p.consentText, "دریافت پیام‌های اطلاع‌رسانی کلبه را می‌پذیرم.")}</label>
        {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
        <Btn variant="accent" className="w-full" disabled={state === "loading"} icon={state === "loading" ? <Loader2 size={15} className="animate-spin" /> : undefined}>{str(p.ctaLabel, "ثبت‌نام")}</Btn>
      </form>
    </section>
  );
}

function Heading({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h2 className="kv-editorial-title text-[22px] md:text-[26px]">{title}</h2>{subtitle && <p className="mt-1 text-[13px] text-[var(--kv-muted)]">{subtitle}</p>}</div>{action}</div>;
}

/* ============================ Section switch ============================ */

export function CmsSection({ section, pageCode, onNav, onOpenProduct, onQuickAdd }: { section: PageSection; pageCode: string; onNav: Nav; onOpenProduct?: (id: string) => void; onQuickAdd?: QuickAdd }) {
  const ref = useViewEvent(pageCode, section);
  const p = section.payload;
  const r = section.resolved ?? {};
  const products = r.products ?? [];
  const cta = (_label: string, target: string, kind: "cta.click" | "banner.click" | "campaign.click" = "cta.click") => () => { siteApi.event({ eventType: kind, pageCode, sectionId: section.id, componentCode: section.component_code, targetId: target }); onNav(target); };
  const responsive = (section.responsive_config ?? {}) as { hideOnMobile?: boolean; hideOnDesktop?: boolean };
  const wrap = (node: ReactNode) => (
    <div ref={ref} data-component={section.component_code}
      className={cn(responsive.hideOnMobile && "hidden md:block", responsive.hideOnDesktop && "md:hidden",
        section.section_theme === "dark" && "dark rounded-[24px] bg-[var(--kv-bg)] p-4 text-[var(--kv-ink)] md:p-6",
        section.section_theme === "campaign" && "rounded-[24px] bg-[var(--kv-accent)]/[0.07] p-4 md:p-6")}>
      {node}
    </div>
  );

  switch (section.component_code) {
    case "hero": case "image_hero": case "video_hero": {
      const campaignEnds = r.campaign?.ends_at;
      const hero: HeroConfig = {
        template: (str(p.template) || (section.component_code === "video_hero" ? "video" : "split")) as HeroConfig["template"],
        eyebrow: str(p.eyebrow), title: str(p.title ?? p.headline, section.title), subtitle: str(p.subtitle ?? p.description),
        ctaLabel: str(p.ctaLabel), ctaTarget: (str(p.ctaTarget, "shop")) as HeroConfig["ctaTarget"], secondaryLabel: str(p.secondaryLabel), secondaryTarget: (str(p.secondaryTarget, "vip")) as HeroConfig["secondaryTarget"],
        image: mediaSrc(str(p.image) || products[0]?.image) ?? PLACEHOLDER, video: mediaSrc(str(p.video)) ?? "", poster: mediaSrc(str(p.poster)) ?? "",
        overlay: Number(p.overlay ?? 35), align: p.align === "center" ? "center" : "right",
        slides: Array.isArray(p.slides) ? (p.slides as HeroConfig["slides"]) : [{ image: mediaSrc(str(p.image)) ?? PLACEHOLDER, title: "", subtitle: "" }],
        mosaic: (Array.isArray(p.mosaic) ? (p.mosaic as string[]).map((m) => mediaSrc(m) ?? PLACEHOLDER) : products.slice(0, 4).map((x) => mediaSrc(x.image) ?? PLACEHOLDER)).concat(Array(4).fill(PLACEHOLDER)).slice(0, 4),
      };
      return wrap(<><HeroRenderer h={hero} onNav={(t) => cta(hero.ctaLabel, t)()} />{campaignEnds && r.campaign?.live && <div className="mt-3"><Countdown endsAt={campaignEnds} title={`تا پایان ${r.campaign.name}`} tone="terra" /></div>}</>);
    }
    case "countdown": {
      const endsAt = p.mode === "campaign" || r.campaign ? r.campaign?.ends_at : str(p.targetDate ?? p.endsAt);
      return wrap(<Countdown endsAt={endsAt} title={str(p.title, section.title)} tone={str(p.tone, "terra")} cta={str(p.cta) || undefined} onCta={cta(str(p.cta), str(p.target, "shop"), "campaign.click")} />);
    }
    case "product_grid": case "product_carousel": case "product_slider": case "recommendation_section":
      return wrap(<section><Heading title={str(p.title ?? p.heading, section.title)} subtitle={str(p.subtitle)} action={<button onClick={cta("همه", "shop")} className="text-[13px] font-bold text-[var(--kv-accent)]">همه محصولات</button>} />
        {section.component_code === "product_carousel"
          ? <div className="kv-no-scrollbar -mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">{products.map((x) => <div key={x.id} className="w-[46%] shrink-0 snap-start md:w-[23%]"><CommerceCard product={x} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} /></div>)}</div>
          : <ProductGrid products={products} columns={Number(p.columns ?? 4)} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} />}
      </section>);
    case "promotion_banner": case "banner": case "promotional": case "cta":
      return wrap(<section className="relative overflow-hidden rounded-[20px] bg-[#1B2A4A] text-white kv-shadow-md">
        {str(p.image) && <img src={mediaSrc(str(p.image))} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
        <div className="relative flex flex-wrap items-center justify-between gap-4 p-7 md:p-10">
          <div className="max-w-[560px]"><h2 className="text-[22px] font-extrabold md:text-[28px]">{str(p.title ?? p.text, section.title)}</h2>{str(p.subtitle ?? p.text) && str(p.title) && <p className="mt-2 text-[14px] leading-7 text-white/85">{str(p.subtitle ?? p.text)}</p>}
            {r.campaign?.live && <p className="mt-2 text-[12.5px] text-white/80">کمپین {r.campaign.name} فعال است</p>}</div>
          {str(p.cta ?? p.ctaLabel) && <Btn variant="accent" onClick={cta(str(p.cta ?? p.ctaLabel), str(p.target ?? p.ctaTarget, "shop"), "banner.click")} icon={<ArrowLeft size={16} />}>{str(p.cta ?? p.ctaLabel)}</Btn>}
        </div></section>);
    case "installment_card": {
      const sample = products[0];
      const provider = str(p.provider, "generic");
      const providerLabel = provider === "snapppay" ? "اسنپ‌پی" : provider === "digipay" ? "دیجی‌پی" : "خرید اقساطی";
      return wrap(<section className="grid items-center gap-5 rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:grid-cols-[1fr_auto] md:p-8">
        <div><p className="text-[12.5px] font-bold text-[var(--kv-accent)]">{providerLabel}</p><h2 className="mt-1 text-[20px] font-extrabold">{str(p.title, "خرید چهارقسطه")}</h2><p className="mt-1.5 text-[13px] leading-7 text-[var(--kv-muted)]">{str(p.subtitle)}</p></div>
        {sample?.perInstallmentRial ? <div className="rounded-[16px] bg-[var(--kv-surface-2)] px-5 py-4 text-center"><p className="text-[12px] text-[var(--kv-muted)]">مثلاً برای «{sample.name}»</p><p className="mt-1 text-[20px] font-extrabold tabular-nums">۴ × {fmtMoney(rialToToman(sample.perInstallmentRial))}</p><p className="text-[11px] text-[var(--kv-muted)]">محاسبه‌شده توسط سرور از قیمت فعلی</p></div>
          : <p className="text-[12px] text-[var(--kv-muted)]">محصول اقساطی فعالی وجود ندارد.</p>}
      </section>);
    }
    case "review_section":
      return wrap(<section><Heading title={str(p.title, section.title)} subtitle={r.reviewSummary && r.reviewSummary.total ? `میانگین ${fa(Math.round(r.reviewSummary.average * 10) / 10)} از ۵ · ${fa(r.reviewSummary.total)} دیدگاه تأییدشده` : undefined} />
        {(r.reviews ?? []).length ? <div className="grid gap-4 md:grid-cols-3">{(r.reviews ?? []).map((rv) => <figure key={rv.id} className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5"><div className="flex items-center gap-0.5" aria-label={`${fa(rv.rating)} ستاره`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={14} fill={i < rv.rating ? "#D6A94E" : "none"} strokeWidth={i < rv.rating ? 0 : 1.5} />)}</div><Quote size={18} className="mt-3 text-[var(--kv-accent)]" /><blockquote className="mt-2 text-[13.5px] leading-7">{rv.body || rv.title}</blockquote><figcaption className="mt-3 text-[12px] font-bold text-[var(--kv-muted)]">{rv.display_name} · {rv.product_name}{rv.verified_purchase && " · خرید تأییدشده"}</figcaption></figure>)}</div>
          : <p className="text-[13px] text-[var(--kv-muted)]">هنوز دیدگاهی ثبت نشده است.</p>}</section>);
    case "category_card": case "category_section": {
      const cats = r.categories ?? [];
      const tpl = str(p.template, "editorial");
      return wrap(<section><Heading title={str(p.title, section.title)} />
        <div className={cn("grid gap-4", tpl === "horizontal" ? "md:grid-cols-2" : "grid-cols-2 md:grid-cols-3")}>
          {cats.map((c) => <button key={c.id} onClick={cta(c.name, "shop")} className={cn("group relative overflow-hidden text-right", tpl === "minimal" ? "rounded-[14px] border border-[var(--kv-line)] p-5" : "rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]")}>
            {tpl !== "minimal" && <div className={cn("bg-[var(--kv-surface-2)]", tpl === "horizontal" ? "h-28" : "aspect-[4/3]")}>{(c.cover_url || c.image_url) && <img src={mediaSrc(c.cover_url ?? c.image_url)} alt={c.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" />}</div>}
            <div className={cn(tpl === "overlay" || tpl === "glass" ? "absolute inset-x-2 bottom-2 rounded-[12px] bg-[var(--kv-glass)] p-3 backdrop-blur-md" : "p-4")}><p className="text-[14.5px] font-extrabold">{c.name}</p><p className="mt-1 line-clamp-2 text-[12px] text-[var(--kv-muted)]">{c.description}</p></div>
          </button>)}
        </div></section>);
    }
    case "newsletter":
      return wrap(<section className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-[var(--kv-surface-2)] p-6 md:p-8"><div><h2 className="text-[19px] font-extrabold">{str(p.title, section.title)}</h2><p className="mt-1 text-[13.5px] text-[var(--kv-muted)]">{str(p.text)}</p></div>
        <LeadInline pageCode={pageCode} /></section>);
    case "lead_form": return wrap(<LeadForm section={section} pageCode={pageCode} />);
    case "story_hero":
      return wrap(<section className="grid overflow-hidden rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)] md:grid-cols-2">
        <div className="flex flex-col justify-center p-8 md:p-14"><p className="text-[13px] font-bold text-[var(--kv-accent)]">{str(p.eyebrow)}</p><h1 className="kv-editorial-title mt-3 text-[30px] leading-[1.35] md:text-[44px]">{str(p.title, section.title)}</h1><p className="mt-4 text-[14.5px] leading-8 text-[var(--kv-muted)]">{str(p.subtitle)}</p>
          <p className="mt-6 text-[12.5px] text-[var(--kv-muted)]">{[str(p.yearFounded) && `از ${str(p.yearFounded)}`, str(p.location)].filter(Boolean).join(" · ")}</p></div>
        <div className="kv-img min-h-[280px] bg-[var(--kv-surface-2)]">{str(p.image) && <img src={mediaSrc(str(p.image))} alt="" className="h-full w-full object-cover" />}</div></section>);
    case "text_section": case "brand_story": case "text_image": case "richtext":
      return wrap(<section className={cn("rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-10", p.alignment === "center" && "text-center")}><p className="text-[12.5px] font-bold text-[var(--kv-accent)]">{str(p.eyebrow)}</p><h2 className="kv-editorial-title mt-1 text-[24px]">{str(p.title, section.title)}</h2><p className={cn("mt-3 whitespace-pre-line text-[14px] leading-8 text-[var(--kv-muted)]", p.alignment === "center" ? "mx-auto max-w-[70ch]" : "max-w-[75ch]")}>{str(p.body ?? p.text)}</p></section>);
    case "timeline":
      return wrap(<section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-10"><h2 className="kv-editorial-title text-[24px]">{str(p.title, section.title)}</h2>
        <ol className="mt-6 space-y-5 border-r-2 border-[var(--kv-line)] pr-6">{lines(p.milestones).map(([year, text], i) => <li key={i} className="relative"><span className="absolute -right-[33px] top-1 h-4 w-4 rounded-full border-4 border-[var(--kv-surface)] bg-[var(--kv-accent)]" /><p className="text-[13px] font-extrabold text-[var(--kv-accent)]">{year}</p><p className="mt-1 text-[14px] leading-7">{text}</p></li>)}</ol></section>);
    case "values_grid":
      return wrap(<section><Heading title={str(p.title, section.title)} /><div className="grid gap-4 md:grid-cols-3">{lines(p.values).map(([t, d], i) => <div key={i} className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6"><p className="text-[16px] font-extrabold">{t}</p><p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">{d}</p></div>)}</div></section>);
    case "stats_strip":
      return wrap(<section className="grid grid-cols-2 gap-3 rounded-[20px] bg-[#1B2A4A] p-6 text-[#F5EFE3] md:grid-cols-4 md:p-8">{lines(p.stats).map(([v, l], i) => <div key={i} className="text-center"><p className="text-[26px] font-extrabold">{v}</p><p className="text-[12.5px] opacity-80">{l}</p></div>)}</section>);
    case "brand_strip": case "brand_section":
      return wrap(<section className="flex flex-wrap items-center justify-center gap-x-10 gap-y-3 rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-6 py-5 text-[13px] font-bold text-[var(--kv-muted)]">{(str(p.items) ? str(p.items).split(/[،,\n]/) : ["ضمانت اصالت", "ارسال سریع", "برگشت ۷ روزه", "پرداخت چهارقسطه"]).map((x) => <span key={x} className="inline-flex items-center gap-1.5"><BadgeCheck size={15} className="text-[var(--kv-accent)]" />{x.trim()}</span>)}</section>);
    case "faq":
      return wrap(<section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-8"><h2 className="kv-editorial-title text-[22px]">{str(p.title, section.title)}</h2><div className="mt-3 divide-y divide-[var(--kv-line)]">{lines(p.items).map(([q, a], i) => <details key={i} className="group py-3"><summary className="cursor-pointer list-none text-[14px] font-bold">{q}</summary><p className="pt-2 text-[13.5px] leading-7 text-[var(--kv-muted)]">{a}</p></details>)}</div></section>);
    case "spacer": return <div aria-hidden style={{ height: Number(p.heightPx ?? 48) }} />;
    case "divider": return <div aria-hidden className="flex items-center gap-3 py-2"><span className="h-px flex-1 bg-[var(--kv-line)]" />{p.style === "ornament" && <span className="text-[var(--kv-accent)]">◆</span>}<span className="h-px flex-1 bg-[var(--kv-line)]" /></div>;
    default:
      if (section.composition && Array.isArray(section.composition)) return wrap(<Composable nodes={section.composition as ComposableNode[]} payload={p} product={products[0]} onNav={onNav} />);
      return null;
  }
}

function LeadInline({ pageCode }: { pageCode: string }) {
  const [phone, setPhone] = useState(""); const [state, setState] = useState<"idle" | "loading" | "done">("idle"); const [error, setError] = useState("");
  if (state === "done") return <p className="flex items-center gap-2 text-[13px] font-bold text-[var(--kv-success)]"><Check size={16} />عضویت شما ثبت شد.</p>;
  return (
    <form className="flex w-full max-w-[400px] flex-col gap-1" onSubmit={async (e) => {
      e.preventDefault(); setError("");
      if (!/^09\d{9}$/.test(phone)) { setError("شماره همراه ۱۱ رقمی وارد کنید."); return; }
      setState("loading");
      try { await siteApi.lead({ pageCode, campaignSource: "newsletter", phone, consent: true }); setState("done"); } catch (err) { setState("idle"); setError(err instanceof Error ? err.message : "خطا"); }
    }}>
      <div className="flex gap-2"><label className="sr-only" htmlFor={`nl-${pageCode}`}>شماره همراه</label>
        <input id={`nl-${pageCode}`} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))} inputMode="tel" dir="ltr" placeholder="09…" className="h-11 min-w-0 flex-1 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-[13px] outline-none focus:border-[var(--kv-accent)]" />
        <Btn variant="accent" disabled={state === "loading"}>{state === "loading" ? <Loader2 size={15} className="animate-spin" /> : "عضویت"}</Btn></div>
      {error && <p role="alert" className="text-[11.5px] text-[var(--kv-danger)]">{error}</p>}
      <p className="text-[11px] text-[var(--kv-muted)]">با عضویت، دریافت پیامک اطلاع‌رسانی را می‌پذیرید.</p>
    </form>
  );
}

/* Admin-composed components render from safe primitives only (Req 178-179). */
export type ComposableNode = { type: string; props?: Record<string, unknown>; children?: ComposableNode[] };
export function Composable({ nodes, payload, product, onNav }: { nodes: ComposableNode[]; payload: Record<string, unknown>; product?: CommerceProduct; onNav: Nav }) {
  const bind = (v: unknown) => { const s = str(v); return s.startsWith("{{") && s.endsWith("}}") ? str(payload[s.slice(2, -2).trim()]) : s; };
  return <>{nodes.map((n, i) => {
    const pr = n.props ?? {};
    const kids = n.children?.length ? <Composable nodes={n.children} payload={payload} product={product} onNav={onNav} /> : null;
    switch (n.type) {
      case "container": return <div key={i} className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">{kids}</div>;
      case "grid": return <div key={i} className={cn("grid gap-3", Number(pr.columns) === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>{kids}</div>;
      case "stack": return <div key={i} className="flex flex-col gap-2">{kids}</div>;
      case "text": return <p key={i} className={cn("leading-7", pr.size === "lg" ? "text-[18px] font-extrabold" : "text-[13.5px]")}>{bind(pr.value)}</p>;
      case "image": return bind(pr.src) ? <img key={i} src={mediaSrc(bind(pr.src))} alt={bind(pr.alt)} loading="lazy" className="w-full rounded-[12px] object-cover" /> : null;
      case "badge": return <span key={i} className="inline-block rounded-full bg-[var(--kv-accent)] px-2.5 py-1 text-[11px] font-bold text-white">{bind(pr.value)}</span>;
      case "button": return <Btn key={i} variant="accent" size="sm" onClick={() => onNav(bind(pr.href) || "shop")}>{bind(pr.label) || "مشاهده"}</Btn>;
      case "product_image": return product?.image ? <img key={i} src={mediaSrc(product.image)} alt={product.name} className="aspect-[3/4] w-full rounded-[12px] object-cover" /> : null;
      case "product_title": return product ? <p key={i} className="text-[14px] font-bold">{product.name}</p> : null;
      case "price": return product ? <p key={i} className="text-[14px] font-extrabold tabular-nums">{fmtMoney(rialToToman(product.priceRial))}</p> : null;
      case "installment_info": return product?.perInstallmentRial ? <p key={i} className="text-[12px] text-[var(--kv-muted)]">۴ قسط × {fmtMoney(rialToToman(product.perInstallmentRial))}</p> : null;
      case "rating": return product && product.reviewCount ? <p key={i} className="text-[12px]">★ {fa(product.rating)}</p> : null;
      case "spacer": return <div key={i} style={{ height: Number(pr.height ?? 16) }} />;
      default: return null;
    }
  })}</>;
}

/* ============================ Page view (About, landings, vibes) ============================ */

export function CmsSections({ page, onNav, onOpenProduct, onQuickAdd }: { page: SitePage; onNav: Nav; onOpenProduct?: (id: string) => void; onQuickAdd?: QuickAdd }) {
  return <div className="space-y-10">{page.sections.map((s) => <CmsSection key={s.id} section={s} pageCode={page.code} onNav={onNav} onOpenProduct={onOpenProduct} onQuickAdd={onQuickAdd} />)}</div>;
}

export function CmsPageView({ code, onNav, onOpenProduct, onQuickAdd }: { code: string; onNav: Nav; onOpenProduct?: (id: string) => void; onQuickAdd?: QuickAdd }) {
  const [page, setPage] = useState<SitePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const load = async () => {
    setError(null); setMissing(false); setPage(null);
    try {
      const res = await siteApi.page(code);
      setPage(res);
      if (res.seo?.title) document.title = res.seo.title;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setMissing(true); else setError(e instanceof Error ? e.message : "خطا در بارگذاری صفحه");
    }
  };
  useEffect(() => { void load(); window.scrollTo({ top: 0 }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [code]);
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-6 md:px-8">
      {error && <ErrorState message={error} onRetry={load} />}
      {missing && <Empty title="این صفحه منتشر نشده است" desc="ممکن است زمان‌بندی انتشار آن هنوز نرسیده یا به پایان رسیده باشد." action={<Btn variant="accent" size="sm" onClick={() => onNav("home")}>بازگشت به خانه</Btn>} />}
      {!page && !error && !missing && <LoadingState label="در حال بارگذاری صفحه…" />}
      {page && <CmsSections page={page} onNav={onNav} onOpenProduct={onOpenProduct} onQuickAdd={onQuickAdd} />}
    </div>
  );
}
