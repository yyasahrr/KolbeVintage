import { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { mediaSrc, rialToToman, type CommerceProduct, type PageSection } from "../data/experience-api";
import { fmtMoney } from "../data/catalog";
import { ResponsiveImg } from "./responsive-img";
import { cn } from "../utils/cn";

/* Hero System (Req 208-217): 12 templates, each with its own layout — not one layout with swapped
   images. Content can be manual or bound to a campaign / product / category / vibe / collection; the
   bound entity is resolved server-side (`resolved.heroEntity`). Motion respects reduced-motion,
   video has a poster + pause control, and the first hero is the LCP image (never lazy). */

export const HERO_TEMPLATES = ["static", "video", "split", "editorial", "product", "collection", "minimal", "fullviewport", "horizontal", "cinematic", "carousel", "mosaic"] as const;
export type HeroTemplate = (typeof HERO_TEMPLATES)[number];
const ALIASES: Record<string, HeroTemplate> = { fullbleed: "fullviewport", fullscreen: "fullviewport", "full-screen": "fullviewport", image: "static", slider: "carousel", campaign: "cinematic" };
export const normaliseTemplate = (value: string, componentCode: string): HeroTemplate => {
  const v = ALIASES[value] ?? value;
  if ((HERO_TEMPLATES as readonly string[]).includes(v)) return v as HeroTemplate;
  return componentCode === "video_hero" ? "video" : componentCode === "image_hero" ? "static" : "split";
};

const PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 5"><rect width="4" height="5" fill="#EFE7DA"/></svg>');
const str = (v: unknown, d = "") => (typeof v === "string" && v ? v : d);
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const HEIGHT: Record<string, string> = { sm: "min-h-[260px] md:min-h-[320px]", md: "min-h-[360px] md:min-h-[460px]", lg: "min-h-[440px] md:min-h-[580px]", viewport: "min-h-[88svh]" };
const TYPE: Record<string, string> = { sm: "text-[24px] md:text-[34px]", md: "text-[28px] md:text-[42px]", lg: "text-[30px] md:text-[50px]", xl: "text-[34px] md:text-[64px]" };
const WIDTH: Record<string, string> = { narrow: "max-w-[34ch]", normal: "max-w-[46ch]", wide: "max-w-[64ch]" };
const OBJECT_POS: Record<string, string> = { start: "object-right", end: "object-left", center: "object-center", top: "object-top", bottom: "object-bottom" };

type HeroProps = { section: PageSection; eager: boolean; onNav: (target: string) => void; onOpenProduct?: (id: string) => void };

export function CmsHero({ section, eager, onNav, onOpenProduct }: HeroProps) {
  const p = section.payload;
  const r = section.resolved ?? {};
  const entity = r.heroEntity ?? null;
  const products: CommerceProduct[] = r.products ?? [];
  const template = normaliseTemplate(str(p.template) || str(section.variant) || "", section.component_code);
  const binding = str(p.bindingType, "manual");
  // Bound entity fills the gaps; explicit manual text always wins (Req 212).
  const title = str(p.title ?? p.headline) || entity?.title || section.title;
  const subtitle = str(p.subtitle ?? p.description) || entity?.subtitle || "";
  const image = mediaSrc(str(p.image) || entity?.image || products[0]?.image) ?? PLACEHOLDER;
  const mobileImage = mediaSrc(str(p.mobileImage)) ?? undefined;
  const ctaTarget = str(p.ctaTarget) || entity?.target || "shop";
  const ctaLabel = str(p.ctaLabel) || (binding === "product" && entity ? "مشاهده و خرید" : "");
  const height = HEIGHT[str(p.height, template === "fullviewport" ? "viewport" : template === "horizontal" ? "sm" : "lg")] ?? HEIGHT.lg!;
  const typeCls = TYPE[str(p.typeScale, "lg")] ?? TYPE.lg!;
  const widthCls = WIDTH[str(p.contentWidth, "normal")] ?? WIDTH.normal!;
  const align = str(p.align, "start");
  const motion = reducedMotion() ? "none" : str(p.motion, "fade");
  const overlayPct = Math.min(90, Math.max(0, Number(section.style_overrides?.overlay ?? p.overlay ?? 35)));
  const overlayColor = str(p.overlayColor, "ink");
  const overlay = overlayColor === "none" ? "transparent" : overlayColor === "accent"
    ? `linear-gradient(to left, color-mix(in srgb, var(--kv-accent) ${overlayPct + 15}%, transparent), color-mix(in srgb, var(--kv-accent) ${Math.round(overlayPct / 2)}%, transparent))`
    : `linear-gradient(to left, rgba(14,21,39,${overlayPct / 100 + 0.15}), rgba(14,21,39,${(overlayPct / 100) * 0.55}) 55%, rgba(14,21,39,${overlayPct / 220}))`;
  const imgPos = OBJECT_POS[str(p.mediaPosition, "center")] ?? "object-center";
  const nav = (t: string) => { if (t.startsWith("product:") && onOpenProduct) onOpenProduct(t.slice(8)); else onNav(t); };
  const textAlign = align === "center" ? "items-center text-center" : align === "end" ? "items-end text-left" : "";
  const enter = motion === "rise" ? "kv-hero-rise" : motion === "fade" ? "kv-hero-fade" : "";

  const Title = ({ light, className }: { light?: boolean; className?: string }) => (
    <>
      {str(p.eyebrow) && <p className={cn("text-[13px] font-bold", light ? "text-[#E8D9C3]" : "text-[var(--kv-accent)]")}>{str(p.eyebrow)}</p>}
      <h1 className={cn("kv-editorial-title mt-3 leading-[1.3]", typeCls, className)}>{title.split("\n").map((l, i) => <span key={i}>{i > 0 && <br />}{l}</span>)}</h1>
      {subtitle && <p className={cn("mt-4 text-[14.5px] leading-8", widthCls, light ? "text-white/85" : "text-[var(--kv-muted)]")}>{subtitle}</p>}
    </>
  );
  const Ctas = ({ light }: { light?: boolean }) => (
    <HeroCtas light={light} style={str(p.ctaStyle, "solid")} primary={ctaLabel ? { label: ctaLabel, target: ctaTarget } : null}
      secondary={str(p.secondaryLabel) ? { label: str(p.secondaryLabel), target: str(p.secondaryTarget, "vip") } : null} onNav={nav} center={align === "center"} />
  );
  const Media = ({ className, sizes = "100vw" }: { className?: string; sizes?: string }) => (
    <picture className="contents">
      {mobileImage && <source media="(max-width: 767px)" srcSet={mobileImage} />}
      <ResponsiveImg src={image} alt={entity?.title ? String(entity.title) : ""} priority={eager} sizes={sizes}
        className={cn("h-full w-full object-cover", imgPos, motion === "kenburns" && "kv-kenburns", className)} />
    </picture>
  );
  const Scroll = () => (p.scrollIndicator ? <span aria-hidden className="absolute bottom-4 left-1/2 -translate-x-1/2 animate-bounce text-white/80 motion-reduce:animate-none"><ChevronDown size={22} /></span> : null);
  const priceLine = entity?.priceRial ? (
    <div className="mt-4 flex flex-wrap items-baseline gap-3">
      <b className="text-[22px] tabular-nums">{fmtMoney(rialToToman(entity.priceRial))}</b>
      {entity.compareAtRial && <s className="text-[14px] tabular-nums opacity-60">{fmtMoney(rialToToman(entity.compareAtRial))}</s>}
      {entity.perInstallmentRial && <span className="text-[12.5px] opacity-80">{entity.installmentsCount ?? 4} قسط × {fmtMoney(rialToToman(entity.perInstallmentRial))}</span>}
      {entity.available !== undefined && entity.available < 1 && <span className="rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-white">ناموجود</span>}
    </div>
  ) : null;

  const shell = (children: React.ReactNode, cls?: string) => <section data-hero-template={template} aria-label={title} className={cn("relative overflow-hidden rounded-[24px]", cls)}>{children}</section>;

  switch (template) {
    case "split": {
      const mediaFirst = str(p.mediaPosition) === "start";
      return shell(
        <div className={cn("grid md:grid-cols-[1.05fr_1fr]", mediaFirst && "md:[direction:ltr]")}>
          <div className={cn("flex flex-col justify-center bg-[var(--kv-surface)] p-8 md:p-14 md:[direction:rtl]", textAlign, enter)}><Title /><Ctas /></div>
          <div className={cn("kv-img relative md:[direction:rtl]", height)}><div className="absolute inset-0"><Media sizes="(min-width: 768px) 50vw, 100vw" /></div></div>
        </div>, "border border-[var(--kv-line)] kv-shadow-md");
    }
    case "editorial":
      return shell(
        <div className={cn("grid gap-6 bg-[var(--kv-surface)] p-6 md:grid-cols-[1.4fr_1fr] md:p-12", height)}>
          <div className={cn("flex flex-col justify-end", textAlign, enter)}>
            <span className="mb-6 h-px w-24 bg-[var(--kv-accent)]" aria-hidden />
            <Title className="kv-serif" /><Ctas />
          </div>
          <figure className="relative min-h-[260px] overflow-hidden rounded-[18px]"><div className="absolute inset-0"><Media sizes="(min-width: 768px) 40vw, 100vw" /></div>
            {str(p.secondaryLabel) ? null : entity?.type && <figcaption className="absolute bottom-3 right-3 rounded-full bg-black/45 px-3 py-1 text-[11px] text-white">{entity.type === "vibe" ? "وایب" : entity.type === "category" ? "دسته" : "ویژه"}</figcaption>}</figure>
        </div>, "border border-[var(--kv-line)]");
    case "product": {
      const product = products[0];
      return shell(
        <div className="grid items-center gap-6 bg-[var(--kv-surface)] p-6 md:grid-cols-[1fr_1fr] md:p-10">
          <button onClick={() => product && nav(`product:${product.id}`)} className="kv-img relative aspect-[4/5] overflow-hidden rounded-[20px] bg-[var(--kv-surface-2)]" aria-label={product?.name ?? title}>
            <div className="absolute inset-0"><Media sizes="(min-width: 768px) 45vw, 100vw" /></div>
            {product && product.discountPercent > 0 && <span className="absolute right-3 top-3 rounded-full bg-[var(--kv-danger)] px-3 py-1 text-[12px] font-bold text-white">٪{product.discountPercent.toLocaleString("fa-IR")} تخفیف</span>}
          </button>
          <div className={cn("flex flex-col", textAlign, enter)}><Title />{priceLine}<Ctas /></div>
        </div>, "border border-[var(--kv-line)] kv-shadow-md");
    }
    case "collection": {
      const imgs = (entity?.mosaic?.filter(Boolean) as string[] | undefined) ?? products.slice(0, 4).map((x) => x.image).filter(Boolean) as string[];
      const tiles = [...imgs, image].slice(0, 4);
      return shell(
        <div className={cn("grid gap-4 bg-[var(--kv-surface-2)] p-4 md:grid-cols-[1fr_1.3fr] md:p-6", height)}>
          <div className={cn("flex flex-col justify-center rounded-[20px] bg-[var(--kv-surface)] p-7 md:p-10", textAlign, enter)}>
            {r.collection && <p className="text-[12px] font-bold text-[var(--kv-muted)]">کالکشن · {products.length.toLocaleString("fa-IR")} محصول</p>}
            <Title /><Ctas />
          </div>
          <div className="grid grid-cols-3 grid-rows-2 gap-3">
            {tiles.map((m, i) => <div key={i} className={cn("kv-img overflow-hidden rounded-[16px]", i === 0 ? "col-span-2 row-span-2" : "")}><ResponsiveImg src={mediaSrc(m) ?? PLACEHOLDER} alt="" priority={eager && i === 0} sizes="(min-width: 768px) 30vw, 50vw" className="h-full w-full object-cover" /></div>)}
          </div>
        </div>);
    }
    case "minimal":
      return shell(<div className={cn("flex flex-col justify-center border border-[var(--kv-line)] bg-[var(--kv-surface)] px-6 py-16 md:py-24", align === "start" ? "" : textAlign, align !== "end" && "items-center text-center", enter)}><Title className="mx-auto max-w-[18ch]" /><Ctas /></div>);
    case "horizontal":
      return shell(
        <div className={cn("relative flex items-center", height)}>
          <div className="absolute inset-0"><Media /></div>
          <div className="absolute inset-0" style={{ background: overlay }} />
          <div className={cn("relative flex w-full flex-wrap items-center justify-between gap-4 p-6 text-white md:px-12", enter)}>
            <div className={cn("flex flex-col", widthCls)}><Title light className="mt-1 !text-[24px] md:!text-[34px]" /></div>
            <Ctas light />
          </div>
        </div>, "kv-shadow-md");
    case "cinematic":
      return shell(
        <div className={cn("relative bg-[#07090F]", height)}>
          <div className="absolute inset-x-0 top-[8%] bottom-[8%] overflow-hidden md:top-[10%] md:bottom-[10%]">
            {str(p.video) ? <HeroVideo payload={p} poster={image} /> : <Media className="kv-kenburns" />}
            <div className="absolute inset-0" style={{ background: overlay }} />
          </div>
          <div className={cn("relative flex h-full flex-col justify-end p-8 text-white md:p-16", height, textAlign, enter)}>
            <Title light className="tracking-tight" />
            {entity?.endsAt && <p className="mt-3 text-[12.5px] text-white/75">تا پایان کمپین — {new Date(entity.endsAt).toLocaleDateString("fa-IR")}</p>}
            <Ctas light />
          </div>
          <Scroll />
        </div>);
    case "carousel":
      return <HeroCarousel section={section} title={title} subtitle={subtitle} image={image} overlay={overlay} height={height} eager={eager} ctas={<Ctas light />} align={textAlign} />;
    case "mosaic": {
      const mosaic = (Array.isArray(p.mosaic) ? (p.mosaic as string[]) : products.slice(0, 4).map((x) => x.image ?? "")).map((m) => mediaSrc(m) ?? PLACEHOLDER).concat(Array(4).fill(PLACEHOLDER)).slice(0, 4);
      return (
        <section data-hero-template="mosaic" aria-label={title} className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
          <div className={cn("flex flex-col justify-center rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-8 md:p-12", textAlign, enter)}><Title /><Ctas /></div>
          <div className="grid h-[360px] grid-cols-2 gap-3 md:h-[560px]">{mosaic.map((m, i) => <div key={i} className={cn("kv-img overflow-hidden rounded-[18px]", i === 0 && "row-span-2")}><ResponsiveImg src={m} alt="" priority={eager && i === 0} sizes="(min-width: 768px) 25vw, 50vw" className="h-full w-full object-cover" /></div>)}</div>
        </section>
      );
    }
    case "video":
    case "static":
    case "fullviewport":
    default:
      return shell(
        <>
          <div className="absolute inset-0">{template === "video" && str(p.video) ? <HeroVideo payload={p} poster={image} /> : <Media />}</div>
          <div className="absolute inset-0" style={{ background: overlay }} />
          <div className={cn("relative flex h-full flex-col justify-center p-8 text-white md:p-14", height, textAlign, enter)}><Title light />{priceLine}<Ctas light /></div>
          {template === "fullviewport" && <Scroll />}
        </>, "kv-shadow-md");
  }
}

function HeroCtas({ primary, secondary, light, style, onNav, center }: { primary: { label: string; target: string } | null; secondary: { label: string; target: string } | null; light?: boolean; style: string; onNav: (t: string) => void; center?: boolean }) {
  if (!primary && !secondary) return null;
  const base = "kv-press inline-flex h-[50px] items-center gap-2 rounded-[11px] px-7 text-[15px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--kv-accent)]";
  const primaryCls = style === "outline" ? cn(base, "border-2", light ? "border-white text-white hover:bg-white/10" : "border-[var(--kv-accent)] text-[var(--kv-accent)] hover:bg-[var(--kv-accent)]/10")
    : style === "ghost" ? cn(base, light ? "bg-white/15 text-white backdrop-blur-md hover:bg-white/25" : "bg-[var(--kv-surface-2)] hover:bg-[var(--kv-line)]")
    : style === "link" ? "inline-flex items-center gap-1.5 text-[15px] font-bold underline underline-offset-8 " + (light ? "text-white" : "text-[var(--kv-accent)]")
    : cn(base, "bg-[var(--kv-accent)] text-white hover:brightness-110");
  return (
    <div className={cn("mt-7 flex flex-wrap gap-3", center && "justify-center")}>
      {primary && <button onClick={() => onNav(primary.target)} className={primaryCls}>{primary.label}<ArrowLeft size={17} /></button>}
      {secondary && <button onClick={() => onNav(secondary.target)} className={cn(base, light ? "border border-white/40 bg-white/10 text-white backdrop-blur-md hover:bg-white/20" : "border border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]")}>{secondary.label}</button>}
    </div>
  );
}

/** Background video: poster first, mobile source, autoplay only when allowed, always pausable (Req 214, 234). */
export function HeroVideo({ payload: p, poster }: { payload: Record<string, unknown>; poster: string }) {
  const [paused, setPaused] = useState(() => reducedMotion() || p.autoplay === false);
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  useEffect(() => { const on = () => setMobile(window.innerWidth < 768); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, []);
  useEffect(() => { if (!el) return; if (paused) el.pause(); else el.play().catch(() => setPaused(true)); }, [paused, el]);
  const src = mediaSrc(mobile && str(p.mobileVideo) ? str(p.mobileVideo) : str(p.video));
  const posterSrc = mediaSrc(mobile && str(p.mobilePoster) ? str(p.mobilePoster) : str(p.poster)) ?? poster;
  return (
    <>
      <video key={src} ref={setEl} src={src} poster={posterSrc} muted={p.muted !== false} loop={p.loop !== false} playsInline preload={paused ? "none" : "metadata"} autoPlay={!paused}
        className="absolute inset-0 h-full w-full object-cover" aria-hidden />
      <button onClick={() => setPaused(!paused)} aria-label={paused ? "پخش ویدیو" : "توقف ویدیو"} className="absolute bottom-5 left-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25">{paused ? <Play size={16} /> : <Pause size={16} />}</button>
    </>
  );
}

function HeroCarousel({ section, title, subtitle, image, overlay, height, eager, ctas, align }: { section: PageSection; title: string; subtitle: string; image: string; overlay: string; height: string; eager: boolean; ctas: React.ReactNode; align: string }) {
  const p = section.payload;
  const slides = (Array.isArray(p.slides) ? (p.slides as { image: string; title?: string; subtitle?: string }[])
    : (section.resolved?.products ?? []).slice(0, 4).filter((x) => x.image).map((x) => ({ image: x.image!, title: x.name, subtitle: x.brand })))
    .map((s) => ({ ...s, image: mediaSrc(s.image) ?? PLACEHOLDER }));
  const list = slides.length ? slides : [{ image, title: "", subtitle: "" }];
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(!reducedMotion());
  useEffect(() => { if (list.length < 2 || !playing) return; const t = window.setInterval(() => setI((x) => (x + 1) % list.length), 5500); return () => window.clearInterval(t); }, [list.length, playing]);
  const s = list[i] ?? list[0]!;
  return (
    <section data-hero-template="carousel" className={cn("relative overflow-hidden rounded-[24px] kv-shadow-md", height)} aria-roledescription="اسلایدر" aria-label={title}>
      {list.map((sl, k) => <ResponsiveImg key={k} src={sl.image} alt="" priority={eager && k === 0} sizes="100vw" className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-700", k === i ? "opacity-100" : "opacity-0")} />)}
      <div className="absolute inset-0" style={{ background: overlay }} />
      <div className={cn("relative flex h-full flex-col justify-center p-8 text-white md:p-14", height, align)}>
        {str(p.eyebrow) && <p className="text-[13px] font-bold text-[#E8D9C3]">{str(p.eyebrow)}</p>}
        <h1 className="kv-editorial-title mt-3 max-w-[20ch] text-[30px] leading-[1.3] md:text-[48px]" aria-live="polite">{s.title || title}</h1>
        <p className="mt-3 max-w-[48ch] text-[15px] leading-8 text-white/85">{s.subtitle || subtitle}</p>
        {ctas}
      </div>
      {list.length > 1 && (
        <div className="absolute bottom-5 left-5 flex items-center gap-2">
          <button onClick={() => setI((i - 1 + list.length) % list.length)} aria-label="اسلاید قبلی" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25"><ChevronRight size={18} /></button>
          <button onClick={() => setPlaying(!playing)} aria-label={playing ? "توقف اسلایدر" : "پخش اسلایدر"} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <button onClick={() => setI((i + 1) % list.length)} aria-label="اسلاید بعدی" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25"><ChevronLeft size={18} /></button>
          <div className="mr-2 flex gap-1.5">{list.map((_, k) => <button key={k} onClick={() => setI(k)} aria-label={`اسلاید ${k + 1}`} aria-current={k === i} className={cn("h-1.5 rounded-full transition-all", k === i ? "w-6 bg-white" : "w-1.5 bg-white/50")} />)}</div>
        </div>
      )}
    </section>
  );
}
