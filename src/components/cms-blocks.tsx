import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BadgeCheck, Camera, Check, ChevronLeft, ChevronRight, CreditCard, Loader2, Quote, Sparkles, Star } from "lucide-react";
import { mediaSrc, rialToToman, siteApi, type CommerceProduct, type PageSection, type SitePage } from "../data/experience-api";
import { fmtMoney } from "../data/catalog";
import { CmsHero, HeroVideo } from "./cms-hero";
import { CommerceCard } from "./commerce-card";
import { ResponsiveImg } from "./responsive-img";
import { applySeo, resetSeo } from "./seo-head";
import { Btn, Empty, ErrorState, Lightbox, LoadingState } from "./primitives";
import { useToast } from "./toast";
import { cn } from "../utils/cn";

/* Registered-component renderer. Admins compose pages from these blocks; data always comes from
   the commerce domains resolved server-side (products, WMS, pricing, campaigns, reviews). */

export type Nav = (target: string) => void;
export type QuickAdd = (product: CommerceProduct) => boolean;
const fa = (n: number) => n.toLocaleString("fa-IR");
/** Neutral paper tone used when a CMS block has no media yet (never an empty src). */
const PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"><rect width="4" height="5" fill="#EFE7DA"/></svg>');
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
type Responsive = { hideOnMobile?: boolean; hideOnTablet?: boolean; hideOnDesktop?: boolean; mobileColumns?: number; tabletColumns?: number; mobileAlign?: string; mobilePadding?: string; mobileTypeScale?: string };
const mediaList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : str(v).split("\n")).map((x) => x.split("|")[0]!.trim()).filter(Boolean);
const lines = (v: unknown) => str(v).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split("|"));

/** Fires `component.view` once per mount when the block becomes visible (Req 236). */
function useViewEvent(pageCode: string | undefined, section: PageSection) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || new URLSearchParams(window.location.search).has("kvPreview")) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { siteApi.event({ eventType: "component.view", pageCode, sectionId: section.id, componentCode: section.component_code }); io.disconnect(); }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, [pageCode, section.id, section.component_code]);
  return ref;
}

/* ============================ Product grid & countdown ============================ */

export { CommerceCard } from "./commerce-card";

function ProductGrid({ products, columns = 4, onOpen, onQuickAdd, pageCode, empty, variant, responsive }: { products: CommerceProduct[]; columns?: number; onOpen?: (id: string) => void; onQuickAdd?: QuickAdd; pageCode?: string; empty?: string; variant?: string; responsive?: Responsive }) {
  if (!products.length) return <p className="rounded-[14px] border border-dashed border-[var(--kv-line-strong)] p-6 text-center text-[12.5px] text-[var(--kv-muted)]">{empty ?? "محصولی برای این بخش یافت نشد."}</p>;
  const vars = { "--kv-cols-d": String(Math.min(Math.max(columns, 2), 5)), "--kv-cols-m": String(responsive?.mobileColumns ?? 2), ...(responsive?.tabletColumns ? { "--kv-cols-t": String(responsive.tabletColumns) } : { "--kv-cols-t": String(Math.min(columns, 3)) }) } as React.CSSProperties;
  return (
    <div className="kv-cms-grid" style={vars}>
      {products.map((p) => <CommerceCard key={p.id} product={p} onOpen={onOpen} onQuickAdd={onQuickAdd} pageCode={pageCode} variant={variant} />)}
    </div>
  );
}

const CD_TONE: Record<string, string> = { terra: "bg-[#A34E2E] text-white", navy: "bg-[#1B2A4A] text-[#F5EFE3]", dark: "bg-[#0B0F17] text-white", light: "bg-[var(--kv-surface)] text-[var(--kv-ink)] border border-[var(--kv-line)]", glass: "bg-[var(--kv-glass)] text-[var(--kv-ink)] border border-white/40 backdrop-blur-md" };
const CD_RADIUS: Record<string, string> = { none: "rounded-none", sm: "rounded-[10px]", md: "rounded-[16px]", lg: "rounded-[20px]", xl: "rounded-[28px]" };
type CountdownOpts = { layout?: string; tone?: string; background?: string; foreground?: string; radius?: string; fontFamily?: string; units?: { d: boolean; h: boolean; m: boolean; s: boolean } };
/** Countdown (Req 218-221): manual date or bound to a campaign; configurable units, layout, tone and colours. Hides itself at zero. */
function Countdown({ endsAt, title, tone, cta, onCta, opts = {} }: { endsAt?: string | null; title: string; tone: string; cta?: string; onCta?: () => void; opts?: CountdownOpts }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const left = endsAt ? Math.max(0, new Date(endsAt).getTime() - now) : 0;
  if (!left) return null;
  const u = opts.units ?? { d: true, h: true, m: true, s: true };
  const light = (opts.tone ?? tone) === "light";
  const cell = (v: number, l: string) => <div className={cn("min-w-[62px] rounded-[12px] px-3 py-2.5 text-center", light ? "bg-[var(--kv-surface-2)]" : "bg-white/12 backdrop-blur-md")}><p className="text-[22px] font-extrabold tabular-nums">{v.toLocaleString("fa-IR", { minimumIntegerDigits: 2 })}</p><p className="text-[11px] opacity-80">{l}</p></div>;
  // Hidden larger units fold into the next visible one so the total stays correct.
  const days = Math.floor(left / 86400000), hours = Math.floor(left / 3600000), mins = Math.floor(left / 60000), secs = Math.floor(left / 1000);
  const cells = [
    u.d && cell(days, "روز"),
    u.h && cell(u.d ? hours % 24 : hours, "ساعت"),
    u.m && cell(u.h ? mins % 60 : u.d ? mins % 1440 : mins, "دقیقه"),
    u.s && cell(u.m ? secs % 60 : secs, "ثانیه"),
  ].filter(Boolean);
  const layout = opts.layout ?? "inline";
  const style = { ...(opts.background ? { background: opts.background } : {}), ...(opts.foreground ? { color: opts.foreground } : {}), ...(opts.fontFamily === 'mono' ? { fontFamily: 'ui-monospace, monospace' } : {}), ...(opts.fontFamily === 'display' ? { fontFamily: 'var(--font-display)' } : {}) };
  return (
    <section style={style} className={cn("gap-5 p-6 md:p-8", CD_TONE[opts.tone ?? tone] ?? CD_TONE.terra, CD_RADIUS[opts.radius ?? "lg"],
      layout === "stacked" ? "flex flex-col items-center text-center" : layout === "split" ? "grid items-center md:grid-cols-2" : "flex flex-wrap items-center justify-between")}>
      <h2 className="text-[20px] font-extrabold md:text-[24px]">{title}</h2>
      <div className={cn("flex items-center gap-2", layout === "split" && "md:justify-end")} role="timer" aria-label="زمان باقی‌مانده">{cells}</div>
      {cta && <button onClick={onCta} className={cn("kv-press h-11 rounded-[11px] px-5 text-[13.5px] font-bold", light ? "bg-[var(--kv-accent)] text-white" : "bg-white text-[#1B2A4A]")}>{cta}</button>}
    </section>
  );
}

/** Compact lead-form fields (lead_form variant "compact") — same contract, stacked layout. */
function LeadCompactFields({ p, form, setForm, submit, error, state }: {
  p: Record<string, unknown>; form: { fullName: string; phone: string; email: string; consent: boolean };
  setForm: (next: { fullName: string; phone: string; email: string; consent: boolean }) => void;
  submit: (e: React.FormEvent) => void; error: string; state: string;
}) {
  return (
    <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
      {p.collectName !== false && <label className="block text-[12.5px] font-semibold">نام<input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="name" /></label>}
      <label className="block text-[12.5px] font-semibold">شماره همراه<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 11) })} inputMode="tel" dir="ltr" className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="tel" /></label>
      {p.collectEmail !== false && <label className="block text-[12.5px] font-semibold">ایمیل (اختیاری)<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} dir="ltr" className="mt-1 h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 outline-none focus:border-[var(--kv-accent)]" autoComplete="email" /></label>}
      <label className="flex items-start gap-2 text-[12px] leading-6 text-[var(--kv-muted)]"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} className="mt-1.5 h-4 w-4 accent-[#C1613B]" />{str(p.consentText, "دریافت پیام‌های اطلاع‌رسانی کلبه را می‌پذیرم.")}</label>
      {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
      <Btn variant="accent" className="w-full" disabled={state === "loading"} icon={state === "loading" ? <Loader2 size={15} className="animate-spin" /> : undefined}>{str(p.ctaLabel, "ثبت‌نام")}</Btn>
    </form>
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
  const variant = ["split", "compact"].includes(section.variant ?? "") ? section.variant! : "default";
  if (variant === "compact") return (
    <section className="mx-auto max-w-md rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6">
      <h2 className="kv-editorial-title text-[20px]">{str(p.title, section.title)}</h2><p className="mt-1 text-[13px] leading-6 text-[var(--kv-muted)]">{str(p.subtitle)}</p>
      <LeadCompactFields p={p} form={form} setForm={setForm} submit={submit} error={error} state={state} />
    </section>);
  return (
    <section className={cn("grid gap-6 rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:grid-cols-2 md:p-10", variant === "split" && "md:grid-cols-[1fr_1.2fr]")}>
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

/**
 * Theme / style-override / responsive attrs for a published section — the ONE
 * definition used by the CMS preview, CMS landing pages AND the storefront
 * homepage bands, so padding/background/width/hide-per-breakpoint controls
 * behave identically everywhere.
 */
export function sectionWrapAttrs(section: PageSection) {
  const responsive = (section.responsive_config ?? {}) as Responsive;
  const st = (section.style_overrides ?? {}) as Record<string, string | number | undefined>;
  const styleAttr = (k: string) => (st[k] && st[k] !== "inherit" && st[k] !== "auto" ? String(st[k]) : undefined);
  return {
    "data-component": section.component_code, "data-cms-section-id": section.id, "data-variant": section.variant || undefined, "data-kv-section": "",
    "data-kv-bg": styleAttr("background"), "data-kv-fg": styleAttr("foreground"), "data-kv-border": styleAttr("border") === "none" ? undefined : styleAttr("border"),
    "data-kv-radius": styleAttr("radius"), "data-kv-shadow": styleAttr("shadow") === "none" ? undefined : styleAttr("shadow"), "data-kv-pad": styleAttr("padding") === "none" ? undefined : styleAttr("padding"),
    "data-kv-gap": styleAttr("gap"), "data-kv-width": styleAttr("width"), "data-kv-minh": styleAttr("minHeight"), "data-kv-type": styleAttr("typeScale"),
    "data-kv-font": styleAttr("fontFamily"), "data-kv-align": styleAttr("align") === "start" ? undefined : styleAttr("align"), "data-kv-anim": styleAttr("animation") === "none" ? undefined : styleAttr("animation"),
    "data-kv-fit": styleAttr("mediaFit"),
    "data-kv-hide-m": responsive.hideOnMobile ? "" : undefined, "data-kv-hide-t": responsive.hideOnTablet ? "" : undefined, "data-kv-hide-d": responsive.hideOnDesktop ? "" : undefined,
    "data-kv-m-align": responsive.mobileAlign, "data-kv-m-pad": responsive.mobilePadding, "data-kv-m-type": responsive.mobileTypeScale,
    className: cn(section.section_theme === "dark" && "dark rounded-[24px] bg-[var(--kv-bg)] p-4 text-[var(--kv-ink)] md:p-6",
      section.section_theme === "campaign" && "rounded-[24px] bg-[var(--kv-accent)]/[0.07] p-4 md:p-6",
      section.section_theme === "muted" && "rounded-[24px] bg-[var(--kv-surface-2)] p-4 md:p-6"),
  } as const;
}

export function CmsSection({ section, pageCode, onNav, onOpenProduct, onQuickAdd, index = 99 }: { section: PageSection; pageCode: string; onNav: Nav; onOpenProduct?: (id: string) => void; onQuickAdd?: QuickAdd; index?: number }) {
  const eager = index === 0; // Req 234: only the first (above-the-fold) section loads media eagerly
  const ref = useViewEvent(pageCode, section);
  const p = section.payload;
  const r = section.resolved ?? {};
  const products = r.products ?? [];
  const cta = (_label: string, target: string, kind: "cta.click" | "banner.click" | "campaign.click" = "cta.click") => () => { siteApi.event({ eventType: kind, pageCode, sectionId: section.id, componentCode: section.component_code, targetId: target }); onNav(target); };
  const responsive = (section.responsive_config ?? {}) as Responsive;
  const wrap = (node: ReactNode) => (
    <div ref={ref} {...sectionWrapAttrs(section)}>
      {node}
    </div>
  );
  const heading = str(p.title ?? p.heading, section.title);

  switch (section.component_code) {
    case "hero": case "image_hero": case "video_hero": {
      const campaignEnds = r.campaign?.ends_at;
      const showCd = r.campaign?.live && (str(p.bindingType) === "campaign" || !str(p.bindingType)) && campaignEnds;
      return wrap(<><CmsHero section={section} eager={eager} onNav={(t) => cta("hero", t)()} onOpenProduct={onOpenProduct} />
        {showCd && <div className="mt-3"><Countdown endsAt={campaignEnds} title={`تا پایان ${r.campaign!.name}`} tone="terra" /></div>}</>);
    }
    case "countdown": {
      const endsAt = p.mode === "manual" ? str(p.targetDate ?? p.endsAt) : (r.campaign?.ends_at ?? str(p.targetDate ?? p.endsAt));
      /* Registry variants are honest presets (payload always wins where set):
         banner → split banner · minimal → quiet light · dark → dark ·
         glass → translucent panel · floating → detached card · compact → no seconds. */
      const v = section.variant && section.variant !== "default" ? section.variant : "";
      const preset = v === "banner" ? { layout: "split", tone: "terra" }
        : v === "minimal" ? { layout: "inline", tone: "light", radius: "sm" }
        : v === "dark" ? { layout: "inline", tone: "dark" }
        : v === "glass" ? { layout: "inline", tone: "glass" }
        : v === "floating" ? { layout: "split", tone: "navy", radius: "xl" }
        : v === "compact" ? { layout: "inline", tone: "terra", radius: "md" } : {};
      const units = { d: p.showDays !== false, h: p.showHours !== false, m: p.showMinutes !== false, s: p.showSeconds !== false && v !== "compact" };
      return wrap(<Countdown endsAt={endsAt} title={str(p.title, section.title)} tone={str(p.tone, String(preset.tone ?? "terra"))} cta={str(p.cta) || undefined} onCta={cta(str(p.cta), str(p.target, "shop"), "campaign.click")}
        opts={{ layout: str(p.layout, String(preset.layout ?? "inline")), tone: str(p.tone, String(preset.tone ?? "terra")), background: str(p.background) || undefined, foreground: str(p.foreground) || undefined, fontFamily: str(p.fontFamily, "site"), radius: str(p.radius, String(preset.radius ?? "lg")), units }} />);
    }
    case "recommendation_section": {
      const rec = r.recommendation;
      const note = rec ? (rec.fallback ? "هنوز داده کافی برای پیشنهاد شخصی نداریم؛ پرطرفدارترین‌ها را ببینید." : rec.personal ? "بر اساس بازدیدها و خریدهای شما" : rec.strategy === "similar" ? "بر اساس سبک، دسته و وایب مشابه" : rec.strategy === "trending" ? "پربازدیدترین‌های این هفته" : "محبوب‌ترین‌ها") : undefined;
      const rv = section.variant && section.variant !== "default" ? section.variant : "";
      const grid = <ProductGrid products={products} columns={Number(p.columns ?? 4)} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} responsive={responsive} empty="فعلاً پیشنهادی نداریم." />;
      if (rv === "dark") return wrap(<section data-strategy={rec?.strategy} className="rounded-[22px] bg-[#0B0F17] p-5 text-white md:p-7"><Heading title={heading} subtitle={str(p.subtitle) || note} />
        <div className="[&_.kv-cms-grid_a]:text-white">{grid}</div></section>);
      return wrap(<section data-strategy={rec?.strategy}>{rv === "minimal" ? null : <Heading title={heading} subtitle={str(p.subtitle) || note} action={rec?.personal ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--kv-accent)]/10 px-3 py-1 text-[11.5px] font-bold text-[var(--kv-accent)]"><Sparkles size={13} />مخصوص شما</span> : undefined} />}{grid}</section>);
    }
    case "product_card": {
      const x = products[0];
      if (!x) return wrap(<p className="rounded-[14px] border border-dashed border-[var(--kv-line-strong)] p-6 text-center text-[12.5px] text-[var(--kv-muted)]">محصول انتخاب‌شده در دسترس نیست.</p>);
      /* section.variant (sale/new/premium/editorial/wholesale) is the default card variant */
      const sectionCard = section.variant && section.variant !== "default" ? section.variant : "auto";
      if (p.layout === "vertical") return wrap(<section className="mx-auto max-w-[360px]">{str(p.title) && <Heading title={str(p.title)} />}<CommerceCard product={x} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} variant={str(p.variant, sectionCard)} /></section>);
      return wrap(<FeaturedProduct product={x} p={{ ...p, cardVariant: str(p.cardVariant, sectionCard) }} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} />);
    }
    case "gallery": return wrap(<Gallery title={str(p.title)} images={mediaList(p.images)} layout={str(p.layout, "grid")} columns={Number(p.columns ?? 3)} eager={eager} />);
    case "video_section": {
      const aspect = str(p.aspect, "16/9");
      const poster = mediaSrc(str(p.poster)) ?? PLACEHOLDER;
      return wrap(<section>{str(p.title) && <Heading title={str(p.title)} />}
        <figure className="overflow-hidden rounded-[20px] bg-black">
          <div className="relative w-full" style={{ aspectRatio: aspect }}>
            {p.controls !== false && p.autoplay !== true
              ? <video src={mediaSrc(str(p.video))} poster={poster} controls playsInline preload="none" muted={p.muted === true} loop={p.loop === true} className="absolute inset-0 h-full w-full object-cover" aria-label={str(p.title) || "ویدیو"} />
              : <HeroVideo payload={p} poster={poster} />}
          </div>
          {str(p.caption) && <figcaption className="bg-[var(--kv-surface)] px-4 py-3 text-[12.5px] text-[var(--kv-muted)]">{str(p.caption)}</figcaption>}
        </figure></section>);
    }
    case "collection_showcase": {
      const cols = r.collections ?? [];
      return wrap(<section><Heading title={heading} subtitle={str(p.subtitle)} />
        {cols.length ? <div className="grid gap-4 md:grid-cols-3">{cols.map((c) => (
          <button key={c.code} onClick={cta(c.title, `collection:${c.code}`)} className="group overflow-hidden rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] text-right">
            <div className="grid h-[220px] grid-cols-3 grid-rows-2 gap-1 bg-[var(--kv-surface-2)]">{[0, 1, 2].map((i) => <div key={i} className={cn("overflow-hidden", i === 0 && "col-span-2 row-span-2")}>{c.images[i] && <ResponsiveImg src={c.images[i]!} alt="" sizes="(min-width: 768px) 22vw, 60vw" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" />}</div>)}</div>
            <div className="p-4"><p className="text-[15px] font-extrabold">{c.title}</p><p className="mt-1 line-clamp-2 text-[12px] text-[var(--kv-muted)]">{c.description}</p><p className="mt-2 text-[11.5px] font-bold text-[var(--kv-accent)]">{fa(c.count)} محصول ←</p></div>
          </button>))}</div> : <p className="text-[13px] text-[var(--kv-muted)]">کالکشن فعالی وجود ندارد.</p>}</section>);
    }
    case "product_grid": case "product_carousel": case "product_slider": {
      /* Registry variants are density/card presets (explicit payload always wins):
         editorial → 3 columns + editorial card · compact → 5 columns ·
         luxury → 3 columns + premium card · minimal → 5 columns, quiet header. */
      const v = section.variant && section.variant !== "default" ? section.variant : "";
      const preset = v === "editorial" ? { columns: 3, card: "editorial" }
        : v === "compact" ? { columns: 5, card: "auto" }
        : v === "luxury" ? { columns: 3, card: "premium" }
        : v === "minimal" ? { columns: 5, card: "auto" } : { columns: 4, card: "auto" };
      const columns = Number(p.columns ?? preset.columns);
      const cardVariant = str(p.cardVariant, preset.card);
      return wrap(<section><Heading title={heading} subtitle={str(p.subtitle)} action={v === "minimal" ? undefined : <button onClick={cta("همه", "shop")} className="text-[13px] font-bold text-[var(--kv-accent)]">همه محصولات</button>} />
        {section.component_code === "product_carousel"
          ? <div className={cn("kv-no-scrollbar -mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2", v === "minimal" && "gap-3")}>{products.map((x) => <div key={x.id} className="w-[46%] shrink-0 snap-start md:w-[23%]"><CommerceCard product={x} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} variant={cardVariant} /></div>)}</div>
          : <ProductGrid products={products} columns={columns} onOpen={onOpenProduct} onQuickAdd={onQuickAdd} pageCode={pageCode} variant={cardVariant} responsive={responsive} />}
      </section>);
    }
    case "promotion_banner": case "banner": case "promotional": case "cta": {
      /* default → navy overlay · dark → near-black · terra → accent ·
         split → photograph as a side panel instead of a backdrop */
      const v = section.variant && section.variant !== "default" ? section.variant : "";
      const surface = v === "dark" ? "bg-[#0B0F17]" : v === "terra" ? "bg-[#A34E2E]" : "bg-[#1B2A4A]";
      if (v === "split") return wrap(
        <section className="grid overflow-hidden rounded-[20px] bg-[#1B2A4A] text-white kv-shadow-md md:grid-cols-2">
          <div className="flex flex-col justify-center p-7 md:p-10">
            <h2 className="text-[22px] font-extrabold md:text-[28px]">{str(p.title ?? p.text, section.title)}</h2>
            {str(p.subtitle ?? p.text) && <p className="mt-2 text-[14px] leading-7 text-white/85">{str(p.subtitle ?? p.text)}</p>}
            {r.campaign?.live && <p className="mt-2 text-[12.5px] text-white/80">کمپین {r.campaign.name} فعال است</p>}
            {str(p.cta ?? p.ctaLabel) && <span className="mt-5 inline-flex w-fit"><Btn variant="accent" onClick={cta(str(p.cta ?? p.ctaLabel), str(p.target ?? p.ctaTarget, "shop"), "banner.click")} icon={<ArrowLeft size={16} />}>{str(p.cta ?? p.ctaLabel)}</Btn></span>}
          </div>
          <div className="kv-img min-h-[200px] bg-white/10">{str(p.image) && <ResponsiveImg src={str(p.image)} alt="" priority={eager} sizes="(min-width: 768px) 50vw, 100vw" className="h-full w-full object-cover" />}</div>
        </section>);
      return wrap(<section className={cn("relative overflow-hidden rounded-[20px] text-white kv-shadow-md", surface)}>
        {str(p.image) && <ResponsiveImg src={str(p.image)} alt="" sizes="100vw" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
        <div className="relative flex flex-wrap items-center justify-between gap-4 p-7 md:p-10">
          <div className="max-w-[560px]"><h2 className="text-[22px] font-extrabold md:text-[28px]">{str(p.title ?? p.text, section.title)}</h2>{str(p.subtitle ?? p.text) && str(p.title) && <p className="mt-2 text-[14px] leading-7 text-white/85">{str(p.subtitle ?? p.text)}</p>}
            {r.campaign?.live && <p className="mt-2 text-[12.5px] text-white/80">کمپین {r.campaign.name} فعال است</p>}</div>
          {str(p.cta ?? p.ctaLabel) && <Btn variant="accent" onClick={cta(str(p.cta ?? p.ctaLabel), str(p.target ?? p.ctaTarget, "shop"), "banner.click")} icon={<ArrowLeft size={16} />}>{str(p.cta ?? p.ctaLabel)}</Btn>}
        </div></section>);
    }
    case "installment_card": {
      /* snapppay / digipay / generic → the default provider (payload.provider wins) */
      const v = ["snapppay", "digipay", "generic"].includes(section.variant ?? "") ? section.variant! : "";
      return wrap(<InstallmentCard p={{ ...p, provider: str(p.provider, v || "snapppay") }} section={section} onCta={cta(str(p.cta), str(p.target, "shop"))} />);
    }
    case "review_section": {
      /* default → reviews · summary → rating summary only ·
         editorial → quote-forward serif display */
      const v = section.variant && section.variant !== "default" ? section.variant : "";
      return wrap(<ReviewsBlock p={{ ...p, ...(v && str(p.display) === "" ? { display: v === "summary" ? "rating_summary" : v === "editorial" ? "editorial" : "" } : {}) }} section={section} heading={heading} />);
    }
    case "category_card": case "category_section": {
      const cats = r.categories ?? [];
      /* section.variant (image/editorial/minimal/glass/overlay/horizontal) is the
         default card template; an explicit payload.template still wins. */
      const v = section.variant && section.variant !== "default" ? section.variant : "";
      const tpl = str(p.template, ["image", "editorial", "minimal", "glass", "overlay", "horizontal"].includes(v) ? v : "editorial");
      return wrap(<section><Heading title={str(p.title, section.title)} />
        <div className={cn("grid gap-4", tpl === "horizontal" ? "md:grid-cols-2" : "grid-cols-2 md:grid-cols-3")}>
          {cats.map((c) => <CategoryCard key={c.id} category={c} fallbackTemplate={tpl} onClick={cta(c.name, `category:${c.slug}`)} />)}
        </div></section>);
    }
    case "newsletter":
      return wrap(<section className="flex flex-wrap items-center justify-between gap-4 rounded-[20px] bg-[var(--kv-surface-2)] p-6 md:p-8"><div><h2 className="text-[19px] font-extrabold">{str(p.title, section.title)}</h2><p className="mt-1 text-[13.5px] text-[var(--kv-muted)]">{str(p.text)}</p></div>
        <LeadInline pageCode={pageCode} /></section>);
    case "lead_form": return wrap(<LeadForm section={section} pageCode={pageCode} />);
    case "story_hero": {
      /* default → stacked (photograph above, copy below) · split → the two-column frame */
      /* default → stacked (photograph above, copy below) · split (and unset) → the two-column frame */
      const stacked = section.variant === "default";
      return wrap(<section className={cn("grid overflow-hidden rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)]", !stacked && "md:grid-cols-2")}>
        <div className={cn("flex flex-col justify-center p-8 md:p-14", stacked && "order-last")}><p className="text-[13px] font-bold text-[var(--kv-accent)]">{str(p.eyebrow)}</p><h1 className="kv-editorial-title mt-3 text-[30px] leading-[1.35] md:text-[44px]">{str(p.title, section.title)}</h1><p className="mt-4 text-[14.5px] leading-8 text-[var(--kv-muted)]">{str(p.subtitle)}</p>
          <p className="mt-6 text-[12.5px] text-[var(--kv-muted)]">{[str(p.yearFounded) && `از ${str(p.yearFounded)}`, str(p.location)].filter(Boolean).join(" · ")}</p></div>
        <div className={cn("kv-img min-h-[280px] bg-[var(--kv-surface-2)]", stacked && "min-h-[360px]")}>{str(p.image) && <ResponsiveImg src={str(p.image)} alt="" priority={eager} sizes="(min-width: 768px) 50vw, 100vw" className="h-full w-full object-cover" />}</div></section>);
    }
    case "text_section": case "brand_story": case "text_image": case "richtext": {
      /* centered → centered copy · editorial → eyebrow rule + larger serif ·
         default → the classic framed card. payload.alignment still wins. */
      const v = ["centered", "editorial"].includes(section.variant ?? "") ? section.variant! : "";
      const centered = p.alignment === "center" || (v === "centered" && p.alignment !== "start");
      return wrap(<section className={cn("rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-10", v === "editorial" && "border-0 bg-transparent px-0 md:px-6", centered && "text-center")}>
        {v === "editorial" && <span className="mb-4 block h-px w-16 bg-[var(--kv-accent)]" aria-hidden="true" />}
        <p className="text-[12.5px] font-bold text-[var(--kv-accent)]">{str(p.eyebrow)}</p>
        <h2 className={cn("kv-editorial-title mt-1 text-[24px]", v === "editorial" && "text-[28px] md:text-[34px]")}>{str(p.title, section.title)}</h2>
        <p className={cn("mt-3 whitespace-pre-line text-[14px] leading-8 text-[var(--kv-muted)]", centered ? "mx-auto max-w-[70ch]" : "max-w-[75ch]")}>{str(p.body ?? p.text)}</p></section>);
    }
    case "timeline": {
      /* vertical → the dated rail · default → milestone cards in a row */
      if (section.variant === "default") return wrap(<section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-10"><h2 className="kv-editorial-title text-[24px]">{str(p.title, section.title)}</h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-3">{lines(p.milestones).map(([year, text], i) => <li key={i} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] p-5"><p className="text-[13px] font-extrabold text-[var(--kv-accent)]">{year}</p><p className="mt-1 text-[14px] leading-7">{text}</p></li>)}</ol></section>);
      return wrap(<section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-10"><h2 className="kv-editorial-title text-[24px]">{str(p.title, section.title)}</h2>
        <ol className="mt-6 space-y-5 border-r-2 border-[var(--kv-line)] pr-6">{lines(p.milestones).map(([year, text], i) => <li key={i} className="relative"><span className="absolute -right-[33px] top-1 h-4 w-4 rounded-full border-4 border-[var(--kv-surface)] bg-[var(--kv-accent)]" /><p className="text-[13px] font-extrabold text-[var(--kv-accent)]">{year}</p><p className="mt-1 text-[14px] leading-7">{text}</p></li>)}</ol></section>);
    }
    case "values_grid": {
      const minimal = section.variant === "minimal";
      return wrap(<section><Heading title={str(p.title, section.title)} /><div className="grid gap-4 md:grid-cols-3">{lines(p.values).map(([t, d], i) => (
        <div key={i} className={cn(minimal ? "border-t-2 border-[var(--kv-accent)] pt-4" : "rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6")}>
          <p className="text-[16px] font-extrabold">{t}</p><p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">{d}</p></div>))}</div></section>);
    }
    case "stats_strip": {
      const dark = section.variant !== "default";
      return wrap(<section className={cn("grid grid-cols-2 gap-3 rounded-[20px] p-6 md:grid-cols-4 md:p-8", dark ? "bg-[#1B2A4A] text-[#F5EFE3]" : "border border-[var(--kv-line)] bg-[var(--kv-surface)] text-[var(--kv-ink)]")}>
        {lines(p.stats).map(([v, l], i) => <div key={i} className="text-center"><p className="text-[26px] font-extrabold">{v}</p><p className="text-[12.5px] opacity-80">{l}</p></div>)}</section>);
    }
    case "brand_strip": case "brand_section": {
      /* default → framed strip · minimal → plain row · marquee → slow moving rail */
      const v = ["minimal", "marquee"].includes(section.variant ?? "") ? section.variant! : "";
      const items = (str(p.items) ? str(p.items).split(/[،,\n]/) : ["ضمانت اصالت", "ارسال سریع", "برگشت ۷ روزه", "پرداخت چهارقسطه"]).map((x) => x.trim());
      const chip = (x: string) => <span key={x} className="inline-flex items-center gap-1.5"><BadgeCheck size={15} className="text-[var(--kv-accent)]" />{x}</span>;
      if (v === "marquee") return wrap(<section className="kv-marquee overflow-hidden py-2 text-[13px] font-bold text-[var(--kv-muted)]" aria-label={str(p.title, section.title)}><div className="kv-marquee-track" data-dir="rtl" style={{ ["--kv-marquee-duration" as string]: "30s" }}><div className="flex w-max items-center gap-x-12 pl-12">{items.map(chip)}</div><div className="flex w-max items-center gap-x-12 pl-12" aria-hidden="true">{items.map(chip)}</div></div></section>);
      return wrap(<section className={cn("flex flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-5 text-[13px] font-bold text-[var(--kv-muted)]", v !== "minimal" && "rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]")}>{items.map(chip)}</section>);
    }
    case "faq":
      return wrap(<section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-8"><h2 className="kv-editorial-title text-[22px]">{str(p.title, section.title)}</h2><div className="mt-3 divide-y divide-[var(--kv-line)]">{lines(p.items).map(([q, a], i) => <details key={i} className="group py-3"><summary className="cursor-pointer list-none text-[14px] font-bold">{q}</summary><p className="pt-2 text-[13.5px] leading-7 text-[var(--kv-muted)]">{a}</p></details>)}</div></section>);
    case "spacer": {
      const preset = section.variant === "sm" ? 24 : section.variant === "lg" ? 96 : 48;
      return wrap(<div aria-hidden data-spacer={section.variant ?? "md"} style={{ height: Number(p.heightPx ?? preset) }} />);
    }
    case "divider": {
      const style = str(p.style, ["line", "ornament", "dashed"].includes(section.variant ?? "") ? section.variant! : "line");
      const rule = cn("h-px flex-1 bg-[var(--kv-line)]", style === "dashed" && "[mask-image:repeating-linear-gradient(90deg,#000_0_8px,transparent_8px_16px)]");
      return wrap(<div aria-hidden data-divider={style} className="flex items-center gap-3 py-2"><span className={rule} />{style === "ornament" && <span className="text-[var(--kv-accent)]">◆</span>}<span className={rule} /></div>);
    }
    default:
      if (section.composition && Array.isArray(section.composition)) return wrap(<Composable nodes={section.composition as ComposableNode[]} payload={p} product={products[0]} onNav={onNav} />);
      return null;
  }
}

/* ============================ Block helpers ============================ */

type CategoryItem = NonNullable<NonNullable<PageSection["resolved"]>["categories"]>[number];
const CAT_RADIUS: Record<string, string> = { sm: "rounded-[10px]", md: "rounded-[14px]", lg: "rounded-[18px]", xl: "rounded-[26px]" };
/** Category card (Req 199-200): template + per-category card style tokens set in the Taxonomy panel. */
export function CategoryCard({ category: c, fallbackTemplate = "editorial", onClick }: { category: CategoryItem; fallbackTemplate?: string; onClick?: () => void }) {
  const cs = (c.card_style ?? {}) as { aspect?: string; radius?: string; overlay?: number; textAlign?: string; showDescription?: boolean; accent?: string };
  const tpl = c.card_template || fallbackTemplate;
  const img = c.cover_url || c.image_url;
  const overlaid = tpl === "overlay" || tpl === "glass" || tpl === "image";
  const accentBg = cs.accent === "accent" ? "bg-[var(--kv-accent)] text-white" : cs.accent === "primary" ? "bg-[var(--kv-action)] text-[var(--kv-bg)]" : "";
  return (
    <button onClick={onClick} data-category={c.slug} data-card-template={tpl}
      className={cn("group relative w-full text-right focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kv-accent)]", tpl === "circle" ? "text-center" : "overflow-hidden", tpl === "circle" ? "rounded-[20px] p-2" : CAT_RADIUS[cs.radius ?? "lg"], tpl === "minimal" ? "border border-[var(--kv-line)] p-5" : tpl === "circle" ? "" : "border border-[var(--kv-line)] bg-[var(--kv-surface)]", tpl === "horizontal" && "flex items-stretch", accentBg, cs.textAlign === "center" && "text-center")}>
      {tpl !== "minimal" && (
        <div className={cn("relative bg-[var(--kv-surface-2)]", tpl === "horizontal" ? "w-2/5 shrink-0" : "", tpl === "circle" && "aspect-square overflow-hidden rounded-full border border-[var(--kv-line)]")} style={tpl === "horizontal" || tpl === "circle" ? undefined : { aspectRatio: cs.aspect ?? "4/3" }}>
          {img && <ResponsiveImg src={img} alt={c.name} sizes="(min-width: 768px) 33vw, 50vw" className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" />}
          {overlaid && (cs.overlay ?? 30) > 0 && <div className="absolute inset-0" style={{ background: `linear-gradient(to top, rgba(14,21,39,${(cs.overlay ?? 30) / 100}), transparent 70%)` }} />}
        </div>
      )}
      <div className={cn(tpl === "glass" ? "absolute inset-x-2 bottom-2 rounded-[12px] bg-[var(--kv-glass)] p-3 backdrop-blur-md" : overlaid && tpl !== "glass" ? "absolute inset-x-0 bottom-0 p-4 text-white" : "p-4", tpl === "circle" && "px-1 py-3", tpl === "horizontal" && "flex flex-col justify-center")}>
        <p className="text-[14.5px] font-extrabold">{c.name}</p>
        {cs.showDescription !== false && c.description && <p className={cn("mt-1 line-clamp-2 text-[12px]", overlaid && tpl !== "glass" ? "text-white/85" : "text-[var(--kv-muted)]")}>{c.description}</p>}
        {typeof c.product_count === "number" && <p className="mt-1 text-[11px] opacity-75">{fa(c.product_count)} محصول</p>}
      </div>
    </button>
  );
}

function FeaturedProduct({ product: x, p, onOpen, onQuickAdd, pageCode }: { product: CommerceProduct; p: Record<string, unknown>; onOpen?: (id: string) => void; onQuickAdd?: QuickAdd; pageCode: string }) {
  const toast = useToast();
  const soldOut = x.available < 1;
  const offers = x.installmentOffers ?? [];
  const colors = [...new Set(x.variants.map((v) => v.color).filter(Boolean))] as string[];
  return (
    <section data-featured-product={x.id} className="grid items-center gap-6 overflow-hidden rounded-[22px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:p-6">
      <button onClick={() => { siteApi.event({ eventType: "product_card.click", pageCode, targetId: x.id }); onOpen?.(x.id); }} className="kv-img relative aspect-[4/5] overflow-hidden rounded-[16px] bg-[var(--kv-surface-2)]" aria-label={x.name}>
        {x.image && <ResponsiveImg src={x.image} alt={x.name} sizes="(min-width: 768px) 40vw, 100vw" className="h-full w-full object-cover" />}
        {p.showBadges !== false && x.discountPercent > 0 && <span className="absolute right-3 top-3 rounded-full bg-[var(--kv-danger)] px-3 py-1 text-[12px] font-bold text-white">٪{fa(x.discountPercent)} تخفیف</span>}
        {p.showBadges !== false && x.isNew && <span className="absolute left-3 top-3 rounded-full bg-[#2E5A44] px-3 py-1 text-[12px] font-bold text-white">تازه‌رسیده</span>}
      </button>
      <div>
        {str(p.title) && <p className="text-[12.5px] font-bold text-[var(--kv-accent)]">{str(p.title)}</p>}
        <p className="mt-1 text-[12px] text-[var(--kv-muted)]">{x.brand}</p>
        <h2 className="kv-editorial-title mt-1 text-[24px] leading-[1.4] md:text-[30px]">{x.name}</h2>
        {str(p.description) && <p className="mt-3 text-[14px] leading-8 text-[var(--kv-muted)]">{str(p.description)}</p>}
        <div className="mt-4 flex flex-wrap items-baseline gap-3"><b className="text-[22px] tabular-nums">{fmtMoney(rialToToman(x.priceRial))}</b>{x.compareAtRial && <s className="text-[14px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(rialToToman(x.compareAtRial))}</s>}</div>
        {p.showRating !== false && x.reviewCount > 0 && <p className="mt-2 flex items-center gap-1 text-[12.5px] text-[var(--kv-muted)]"><Star size={13} fill="#D6A94E" strokeWidth={0} />{fa(x.rating)} از ۵ · {fa(x.reviewCount)} دیدگاه</p>}
        {p.showSwatches !== false && colors.length > 0 && <p className="mt-2 text-[12px] text-[var(--kv-muted)]">رنگ‌ها: {colors.join("، ")}</p>}
        {p.showInstallment !== false && offers.length > 0 && <ul className="mt-4 space-y-1.5">{offers.map((o) => <li key={o.provider} className="flex items-center gap-2 text-[12.5px]"><span className="h-2 w-2 rounded-full" style={{ background: o.color }} /><b>{o.title}</b><span className="text-[var(--kv-muted)] tabular-nums">{fa(o.count)} قسط × {fmtMoney(rialToToman(o.perInstallmentRial))}</span></li>)}</ul>}
        <div className="mt-6 flex flex-wrap gap-3">
          <Btn variant="accent" disabled={soldOut} onClick={() => { if (!onQuickAdd) { onOpen?.(x.id); return; } if (onQuickAdd(x)) { toast.bumpCart(); toast.push(`«${x.name}» به سبد خرید اضافه شد.`); } else toast.push("این سایز دیگر موجود نیست.", "error"); }}>{soldOut ? "ناموجود" : "افزودن به سبد"}</Btn>
          <Btn variant="soft" onClick={() => onOpen?.(x.id)}>مشاهده جزئیات</Btn>
        </div>
      </div>
    </section>
  );
}

function Gallery({ title, images, layout, columns, eager }: { title: string; images: string[]; layout: string; columns: number; eager: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const srcs = images.map((m) => mediaSrc(m) ?? PLACEHOLDER);
  const step = (delta: number) => setOpen((i) => (i === null ? i : (i + delta + srcs.length) % srcs.length));
  if (!srcs.length) return <p className="text-[13px] text-[var(--kv-muted)]">تصویری برای گالری انتخاب نشده است.</p>;
  const item = (src: string, i: number, cls: string) => <button key={i} onClick={() => setOpen(i)} className={cn("kv-img group overflow-hidden rounded-[16px] bg-[var(--kv-surface-2)]", cls)} aria-label={`نمایش تصویر ${fa(i + 1)}`}><ResponsiveImg src={src} alt="" priority={eager && i === 0} sizes="(min-width: 768px) 33vw, 50vw" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" /></button>;
  return (
    <section data-gallery-layout={layout}>
      {title && <Heading title={title} />}
      {layout === "carousel" ? <div className="kv-no-scrollbar -mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">{srcs.map((src, i) => item(src, i, "aspect-[4/5] w-[70%] shrink-0 snap-start md:w-[32%]"))}</div>
        : layout === "masonry" ? <div className="gap-3 [column-fill:_balance]" style={{ columnCount: Math.min(columns, 4) }}>{srcs.map((src, i) => <div key={i} className="mb-3 break-inside-avoid">{item(src, i, cn("block w-full", i % 3 === 0 ? "aspect-[3/4]" : i % 3 === 1 ? "aspect-square" : "aspect-[4/5]"))}</div>)}</div>
        : <div className="kv-cms-grid" style={{ "--kv-cols-d": String(Math.min(columns, 4)), "--kv-cols-t": String(Math.min(columns, 3)) } as React.CSSProperties}>{srcs.map((src, i) => item(src, i, "aspect-square"))}</div>}
      <Lightbox open={open !== null} onClose={() => setOpen(null)} label="نمایش تصویر"
        onKey={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); step(1); } if (e.key === "ArrowRight") { e.preventDefault(); step(-1); } }}
        caption={open !== null ? `${fa(open + 1)} از ${fa(srcs.length)}` : null}>
        {open !== null && <img src={srcs[open]} alt={`تصویر ${fa(open + 1)} از ${fa(srcs.length)}`} className="max-h-[88vh] max-w-full rounded-[12px] object-contain" />}
        {srcs.length > 1 && <>
          <button onClick={() => step(-1)} aria-label="تصویر قبلی" className="absolute right-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white focus-visible:outline-2 focus-visible:outline-white"><ChevronRight size={20} /></button>
          <button onClick={() => step(1)} aria-label="تصویر بعدی" className="absolute left-4 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white focus-visible:outline-2 focus-visible:outline-white"><ChevronLeft size={20} /></button>
        </>}
      </Lightbox>
    </section>
  );
}

/** Installment card (Req 189-192): providers, counts, fees and limits come from the Installment Provider domain. */
function InstallmentCard({ p, section, onCta }: { p: Record<string, unknown>; section: PageSection; onCta: () => void }) {
  const r = section.resolved ?? {};
  const wanted = str(p.provider, "");
  const all = r.providers ?? [];
  const providers = wanted && wanted !== "generic" && wanted !== "all" ? all.filter((x) => x.code === wanted) : all;
  const sample = (r.products ?? [])[0];
  const offers = (sample?.installmentOffers ?? []).filter((o) => providers.some((x) => x.code === o.provider));
  const title = str(p.title) || (providers.length === 1 ? `خرید اقساطی با ${providers[0]!.title}` : "خرید اقساطی");
  if (!providers.length) return <p className="rounded-[14px] border border-dashed border-[var(--kv-line-strong)] p-6 text-center text-[12.5px] text-[var(--kv-muted)]">سرویس اقساطی فعالی تعریف نشده است.</p>;
  return (
    <section data-installment-providers={providers.map((x) => x.code).join(",")} className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--kv-accent)]"><CreditCard size={15} />پرداخت اقساطی</p><h2 className="mt-1 text-[20px] font-extrabold">{title}</h2>{str(p.subtitle) && <p className="mt-1.5 max-w-[60ch] text-[13px] leading-7 text-[var(--kv-muted)]">{str(p.subtitle)}</p>}</div>
        {str(p.cta) && <Btn variant="accent" onClick={onCta}>{str(p.cta)}</Btn>}
      </div>
      <div className={cn("mt-5 grid gap-3", providers.length > 1 && "md:grid-cols-2")}>
        {providers.map((pr) => {
          const offer = offers.find((o) => o.provider === pr.code);
          return (
            <div key={pr.code} className="rounded-[16px] border p-4" style={{ borderColor: `${pr.color}55` }}>
              <div className="flex items-center gap-2">{pr.logoUrl ? <img src={mediaSrc(pr.logoUrl)} alt="" className="h-7 w-7 rounded-md object-contain" /> : <span className="h-7 w-7 rounded-md" style={{ background: pr.color }} />}
                <b className="text-[14px]">{pr.title}</b>{pr.badge && <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold text-white" style={{ background: pr.color }}>{pr.badge}</span>}</div>
              {offer ? <p className="mt-3 text-[19px] font-extrabold tabular-nums">{fa(offer.count)} × {fmtMoney(rialToToman(offer.perInstallmentRial))}<span className="mr-2 text-[11.5px] font-normal text-[var(--kv-muted)]">مجموع {fmtMoney(rialToToman(offer.totalRial))}</span></p>
                : <p className="mt-3 text-[14px] font-bold">{fa(pr.count)} قسط{Number(pr.minOrderRial) > 0 ? <span className="mr-2 text-[11.5px] font-normal text-[var(--kv-muted)]">برای خرید از {fmtMoney(rialToToman(pr.minOrderRial))}</span> : null}</p>}
              {offer && sample && <p className="mt-1 text-[11px] text-[var(--kv-muted)]">نمونه برای «{sample.name}» — محاسبه سرور از قیمت فعلی</p>}
              {pr.terms && <p className="mt-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">{pr.terms}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Reviews (Req 201-205): approved reviews, rating summary with distribution, customer photos. */
function ReviewsBlock({ p, section, heading }: { p: Record<string, unknown>; section: PageSection; heading: string }) {
  const r = section.resolved ?? {};
  const known = ["reviews", "rating_summary", "customer_photos", "product_rating", "editorial"];
  const raw = str(p.display, section.variant && section.variant !== "default" ? section.variant : "reviews");
  const display = known.includes(raw) ? raw : "reviews";
  const reviews = r.reviews ?? [];
  const sum = r.reviewSummary;
  const photos = r.customerPhotos ?? [];
  const [lightbox, setLightbox] = useState<string | null>(null);
  const summary = sum && sum.total > 0 ? (
    <div className="grid items-center gap-5 rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5 md:grid-cols-[auto_1fr]" data-review-summary>
      <div className="text-center"><p className="text-[40px] font-extrabold leading-none tabular-nums">{fa(Math.round(sum.average * 10) / 10)}</p>
        <div className="mt-2 flex justify-center gap-0.5" aria-label={`${fa(Math.round(sum.average * 10) / 10)} از ۵`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={15} fill={i < Math.round(sum.average) ? "#D6A94E" : "none"} strokeWidth={i < Math.round(sum.average) ? 0 : 1.5} />)}</div>
        <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{fa(sum.total)} دیدگاه تأییدشده</p></div>
      <div className="space-y-1.5">{[5, 4, 3, 2, 1].map((star) => { const n = sum.distribution?.find((d) => d.rating === star)?.n ?? 0; const pct = sum.total ? Math.round((n / sum.total) * 100) : 0; return (
        <div key={star} className="flex items-center gap-2 text-[12px]"><span className="w-10 tabular-nums">{fa(star)} ستاره</span><div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--kv-surface-2)]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${fa(star)} ستاره`}><div className="h-full rounded-full bg-[#D6A94E]" style={{ width: `${pct}%` }} /></div><span className="w-8 text-left tabular-nums text-[var(--kv-muted)]">{fa(n)}</span></div>
      ); })}</div>
    </div>
  ) : null;
  const photoGrid = photos.length ? (
    <div className="grid grid-cols-3 gap-2 md:grid-cols-6" data-customer-photos>{photos.map((ph) => <button key={ph.url} onClick={() => setLightbox(ph.url)} className="kv-img aspect-square overflow-hidden rounded-[12px] bg-[var(--kv-surface-2)]" aria-label={`عکس ${ph.author} از ${ph.productName}`}><ResponsiveImg src={ph.url} alt={`عکس مشتری از ${ph.productName}`} sizes="(min-width: 768px) 16vw, 33vw" className="h-full w-full object-cover" /></button>)}</div>
  ) : null;
  const list = reviews.length ? (
    <div className="grid gap-4 md:grid-cols-3">{reviews.map((rv) => (
      <figure key={rv.id} className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
        <div className="flex items-center gap-0.5" aria-label={`${fa(rv.rating)} ستاره`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={14} fill={i < rv.rating ? "#D6A94E" : "none"} strokeWidth={i < rv.rating ? 0 : 1.5} />)}</div>
        <Quote size={18} className="mt-3 text-[var(--kv-accent)]" /><blockquote className="mt-2 text-[13.5px] leading-7">{rv.body || rv.title}</blockquote>
        {p.showPhotos !== false && rv.photos && rv.photos.length > 0 && <div className="mt-3 flex gap-2">{rv.photos.map((u) => <button key={u} onClick={() => setLightbox(u)} className="h-14 w-14 overflow-hidden rounded-[10px]" aria-label="بزرگ‌نمایی عکس"><img src={mediaSrc(u)} alt="" loading="lazy" className="h-full w-full object-cover" /></button>)}</div>}
        <figcaption className="mt-3 text-[12px] font-bold text-[var(--kv-muted)]">{rv.display_name} · {rv.product_name}{rv.verified_purchase && " · خرید تأییدشده"}</figcaption>
      </figure>))}</div>
  ) : <p className="text-[13px] text-[var(--kv-muted)]">هنوز دیدگاهی ثبت نشده است.</p>;
  const editorialList = reviews.length ? (
    <div className="space-y-8">{reviews.map((rv) => (
      <figure key={rv.id} className="border-r-2 border-[var(--kv-accent)] pr-5">
        <blockquote className="kv-editorial-title text-[19px] leading-9">«{rv.body || rv.title}»</blockquote>
        <figcaption className="mt-2 text-[12.5px] font-bold text-[var(--kv-muted)]">{rv.display_name} · {rv.product_name}{rv.verified_purchase && " · خرید تأییدشده"}</figcaption>
      </figure>))}</div>
  ) : <p className="text-[13px] text-[var(--kv-muted)]">هنوز دیدگاهی ثبت نشده است.</p>;
  return (
    <section data-review-display={display} className="space-y-4">
      <Heading title={heading} subtitle={display === "reviews" && sum?.total ? `میانگین ${fa(Math.round(sum.average * 10) / 10)} از ۵ · ${fa(sum.total)} دیدگاه تأییدشده` : undefined} action={display === "customer_photos" && photos.length ? <span className="inline-flex items-center gap-1 text-[12px] text-[var(--kv-muted)]"><Camera size={14} />{fa(photos.length)} عکس</span> : undefined} />
      {display === "rating_summary" && (summary ?? <p className="text-[13px] text-[var(--kv-muted)]">هنوز امتیازی ثبت نشده است.</p>)}
      {display === "customer_photos" && (photoGrid ?? <p className="text-[13px] text-[var(--kv-muted)]">هنوز عکس تأییدشده‌ای از مشتریان نداریم.</p>)}
      {display === "product_rating" && <>{summary}{list}</>}
      {display === "editorial" && editorialList}
      {display === "reviews" && <>{p.showSummary && summary}{list}</>}
      <Lightbox open={Boolean(lightbox)} onClose={() => setLightbox(null)} label="عکس مشتری">
        {lightbox && <img src={mediaSrc(lightbox)} alt="عکس ارسالی مشتری" className="max-h-[88vh] max-w-full rounded-[12px]" />}
      </Lightbox>
    </section>
  );
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
      case "image": return bind(pr.src) ? <ResponsiveImg key={i} src={bind(pr.src)} alt={bind(pr.alt)} sizes="(min-width: 768px) 33vw, 100vw" className="w-full rounded-[12px] object-cover" /> : null;
      case "badge": return <span key={i} className="inline-block rounded-full bg-[var(--kv-accent)] px-2.5 py-1 text-[11px] font-bold text-white">{bind(pr.value)}</span>;
      case "button": return <Btn key={i} variant="accent" size="sm" onClick={() => onNav(bind(pr.href) || "shop")}>{bind(pr.label) || "مشاهده"}</Btn>;
      case "product_image": return product?.image ? <ResponsiveImg key={i} src={product.image} alt={product.name} sizes="(min-width: 768px) 25vw, 50vw" className="aspect-[3/4] w-full rounded-[12px] object-cover" /> : null;
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
  return <div className="space-y-10">{page.sections.map((s, i) => <CmsSection key={s.id} index={i} section={s} pageCode={page.code} onNav={onNav} onOpenProduct={onOpenProduct} onQuickAdd={onQuickAdd} />)}</div>;
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
      applySeo(res.seo); // Req 235: head tags come from the SEO Domain
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) setMissing(true); else setError(e instanceof Error ? e.message : "خطا در بارگذاری صفحه");
    }
  };
  useEffect(() => { void load(); window.scrollTo({ top: 0 }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [code]);
  useEffect(() => () => resetSeo(), []);
  return (
    <div className="kv-sf-shell pb-20 pt-6">
      {error && <ErrorState message={error} onRetry={load} />}
      {missing && <Empty title="این صفحه منتشر نشده است" desc="ممکن است زمان‌بندی انتشار آن هنوز نرسیده یا به پایان رسیده باشد." action={<Btn variant="accent" size="sm" onClick={() => onNav("home")}>بازگشت به خانه</Btn>} />}
      {!page && !error && !missing && <LoadingState label="در حال بارگذاری صفحه…" />}
      {page && <CmsSections page={page} onNav={onNav} onOpenProduct={onOpenProduct} onQuickAdd={onQuickAdd} />}
    </div>
  );
}
