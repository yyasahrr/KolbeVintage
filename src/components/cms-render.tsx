import { useEffect, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play, Truck, ShieldCheck, RotateCcw, BadgeCheck, Quote, ChevronDown, X } from "lucide-react";
import type { HeroConfig, CmsBlock, BlockProps } from "../data/ops";
import type { Product } from "../data/catalog";
import { fmtMoney } from "../data/catalog";
import { Btn } from "./primitives";
import { cn } from "../utils/cn";
import { ResponsiveImg } from "./responsive-img";

export type NavTarget = NonNullable<BlockProps["target"]>;
const TONE: Record<string, string> = {
  navy: "bg-[#1B2A4A] text-[#F5EFE3]",
  terra: "bg-[#A34E2E] text-white",
  stone: "bg-[var(--kv-surface-2)] text-[var(--kv-ink)]",
};

function Lines({ text }: { text: string }) {
  return <>{text.split("\n").map((l, i) => <span key={i}>{i > 0 && <br />}{l}</span>)}</>;
}

function Ctas({ h, onNav, light }: { h: HeroConfig; onNav: (t: NavTarget) => void; light?: boolean }) {
  return (
    <div className="mt-7 flex flex-wrap gap-3">
      {h.ctaLabel && <Btn variant="accent" size="lg" onClick={() => onNav(h.ctaTarget)} icon={<ArrowLeft size={17} />}>{h.ctaLabel}</Btn>}
      {h.secondaryLabel && (
        light
          ? <button onClick={() => onNav(h.secondaryTarget)} className="kv-press h-[52px] rounded-[11px] border border-white/40 bg-white/10 px-7 text-[15px] font-semibold text-white backdrop-blur-md hover:bg-white/20">{h.secondaryLabel}</button>
          : <Btn variant="soft" size="lg" onClick={() => onNav(h.secondaryTarget)}>{h.secondaryLabel}</Btn>
      )}
    </div>
  );
}

/* ================= Hero templates ================= */
export function HeroRenderer({ h, onNav, preview, priority = true }: { h: HeroConfig; onNav: (t: NavTarget) => void; preview?: boolean; priority?: boolean }) {
  // Req 234: the main hero is the LCP element — never lazy-loaded (unless it is only a preview).
  const eager = priority && !preview;
  const [slide, setSlide] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (h.template !== "carousel" || h.slides.length < 2 || !playing) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = window.setInterval(() => setSlide((s) => (s + 1) % h.slides.length), 5500);
    return () => window.clearInterval(t);
  }, [h.template, h.slides.length, playing]);
  const minH = preview ? "min-h-[300px]" : "min-h-[440px] md:min-h-[580px]";
  const center = h.align === "center";
  const overlay = `linear-gradient(to left, rgba(14,21,39,${h.overlay / 100 + 0.2}), rgba(14,21,39,${h.overlay / 100 * 0.6}) 55%, rgba(14,21,39,${h.overlay / 200}))`;
  const titleCls = cn("kv-editorial-title", preview ? "text-[22px]" : "text-[30px] md:text-[48px]", "leading-[1.3]");

  if (h.template === "split") return (
    <section className="overflow-hidden rounded-[24px] border border-[var(--kv-line)] kv-shadow-md">
      <div className="grid md:grid-cols-[1.05fr_1fr]">
        <div className={cn("flex flex-col justify-center bg-[var(--kv-surface)]", preview ? "p-6" : "p-8 md:p-14")}>
          {h.eyebrow && <p className="text-[13px] font-bold text-[var(--kv-accent)]">{h.eyebrow}</p>}
          <h1 className={cn(titleCls, "mt-3")}><Lines text={h.title} /></h1>
          <p className="mt-4 max-w-[46ch] text-[14.5px] leading-8 text-[var(--kv-muted)]">{h.subtitle}</p>
          <Ctas h={h} onNav={onNav} />
        </div>
        <div className={cn("kv-img relative", preview ? "min-h-[240px]" : "min-h-[340px] md:min-h-[560px]")}><ResponsiveImg src={h.image} alt="" priority={eager} sizes="(min-width: 768px) 50vw, 100vw" className="absolute inset-0 h-full w-full object-cover" /></div>
      </div>
    </section>
  );

  if (h.template === "minimal") return (
    <section className={cn("rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)] text-center", preview ? "px-6 py-12" : "px-6 py-20 md:py-28")}>
      {h.eyebrow && <p className="text-[13px] font-bold text-[var(--kv-accent)]">{h.eyebrow}</p>}
      <h1 className={cn(titleCls, "mx-auto mt-3 max-w-[18ch]")}><Lines text={h.title} /></h1>
      <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-8 text-[var(--kv-muted)]">{h.subtitle}</p>
      <div className="flex justify-center"><Ctas h={h} onNav={onNav} /></div>
    </section>
  );

  if (h.template === "mosaic") return (
    <section className="grid gap-4 md:grid-cols-[1fr_1.2fr]">
      <div className={cn("flex flex-col justify-center rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)]", preview ? "p-6" : "p-8 md:p-12")}>
        {h.eyebrow && <p className="text-[13px] font-bold text-[var(--kv-accent)]">{h.eyebrow}</p>}
        <h1 className={cn(titleCls, "mt-3")}><Lines text={h.title} /></h1>
        <p className="mt-4 text-[14.5px] leading-8 text-[var(--kv-muted)]">{h.subtitle}</p>
        <Ctas h={h} onNav={onNav} />
      </div>
      <div className={cn("grid grid-cols-2 gap-3", preview ? "h-[280px]" : "h-[360px] md:h-[560px]")}>
        {h.mosaic.slice(0, 4).map((m, i) => <div key={i} className={cn("kv-img overflow-hidden rounded-[18px]", i === 0 && "row-span-2")}><ResponsiveImg src={m} alt="" priority={eager && i === 0} sizes="(min-width: 768px) 25vw, 50vw" className="h-full w-full object-cover" /></div>)}
      </div>
    </section>
  );

  if (h.template === "carousel") {
    const s = h.slides[slide] ?? h.slides[0];
    return (
      <section className={cn("relative overflow-hidden rounded-[24px] kv-shadow-md", minH)} aria-roledescription="اسلایدر" aria-label="اسلایدهای هیرو">
        {h.slides.map((sl, i) => <ResponsiveImg key={i} src={sl.image} alt="" priority={eager && i === 0} sizes="100vw" className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-700", i === slide ? "opacity-100" : "opacity-0")} />)}
        <div className="absolute inset-0" style={{ background: overlay }} />
        <div className={cn("relative flex h-full flex-col justify-center p-8 text-white md:p-14", minH, center && "items-center text-center")}>
          {h.eyebrow && <p className="text-[13px] font-bold text-[#E8D9C3]">{h.eyebrow}</p>}
          <h1 className={cn(titleCls, "mt-3 max-w-[20ch]")} aria-live="polite">{s?.title || <Lines text={h.title} />}</h1>
          <p className="mt-3 max-w-[48ch] text-[15px] leading-8 text-white/85">{s?.subtitle || h.subtitle}</p>
          <Ctas h={h} onNav={onNav} light />
        </div>
        <div className="absolute bottom-5 left-5 flex items-center gap-2">
          <button onClick={() => setSlide((slide - 1 + h.slides.length) % h.slides.length)} aria-label="اسلاید قبلی" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25"><ChevronRight size={18} /></button>
          <button onClick={() => setPlaying(!playing)} aria-label={playing ? "توقف اسلایدر" : "پخش اسلایدر"} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25">{playing ? <Pause size={16} /> : <Play size={16} />}</button>
          <button onClick={() => setSlide((slide + 1) % h.slides.length)} aria-label="اسلاید بعدی" className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25"><ChevronLeft size={18} /></button>
          <div className="mr-2 flex gap-1.5">{h.slides.map((_, i) => <button key={i} onClick={() => setSlide(i)} aria-label={`اسلاید ${i + 1}`} className={cn("h-1.5 rounded-full transition-all", i === slide ? "w-6 bg-white" : "w-1.5 bg-white/50")} />)}</div>
        </div>
      </section>
    );
  }

  // fullbleed + video share the overlay layout
  return (
    <section className={cn("relative overflow-hidden rounded-[24px] kv-shadow-md", minH)}>
      {h.template === "video" && h.video
        ? <VideoBg src={h.video} poster={h.poster || h.image} />
        : <ResponsiveImg src={h.image} alt="" priority={eager} sizes="100vw" className="absolute inset-0 h-full w-full object-cover" />}
      <div className="absolute inset-0" style={{ background: overlay }} />
      <div className={cn("relative flex h-full flex-col justify-center p-8 text-white md:p-14", minH, center && "items-center text-center")}>
        {h.eyebrow && <p className="text-[13px] font-bold text-[#E8D9C3]">{h.eyebrow}</p>}
        <h1 className={cn(titleCls, "mt-3 max-w-[20ch]")}><Lines text={h.title} /></h1>
        <p className="mt-3 max-w-[48ch] text-[15px] leading-8 text-white/85">{h.subtitle}</p>
        <Ctas h={h} onNav={onNav} light />
      </div>
    </section>
  );
}

function VideoBg({ src, poster }: { src: string; poster: string }) {
  const [paused, setPaused] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [ref, setRef] = useState<HTMLVideoElement | null>(null);
  useEffect(() => { if (!ref) return; if (paused) ref.pause(); else ref.play().catch(() => setPaused(true)); }, [paused, ref]);
  return (
    <>
      <video ref={setRef} src={src} poster={poster} muted loop playsInline preload={paused ? "none" : "metadata"} autoPlay={!paused} className="absolute inset-0 h-full w-full object-cover" aria-hidden />
      <button onClick={() => setPaused(!paused)} aria-label={paused ? "پخش ویدیو" : "توقف ویدیو"} className="absolute bottom-5 left-5 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md hover:bg-white/25">{paused ? <Play size={16} /> : <Pause size={16} />}</button>
    </>
  );
}

/* ================= Countdown ================= */
export function useCountdown(endsAt?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  const end = endsAt ? new Date(endsAt).getTime() : 0;
  const left = Math.max(0, end - now);
  return { done: !endsAt || left === 0, d: Math.floor(left / 86400000), h: Math.floor(left / 3600000) % 24, m: Math.floor(left / 60000) % 60, s: Math.floor(left / 1000) % 60 };
}

function Countdown({ p, onNav }: { p: BlockProps; onNav: (t: NavTarget) => void }) {
  const c = useCountdown(p.endsAt);
  if (c.done) return null;
  const cell = (v: number, l: string) => <div className="min-w-[64px] rounded-[12px] bg-white/12 px-3 py-2.5 text-center backdrop-blur-md"><p className="text-[22px] font-extrabold tabular-nums">{v.toLocaleString("fa-IR", { minimumIntegerDigits: 2 })}</p><p className="text-[11px] opacity-80">{l}</p></div>;
  return (
    <section className={cn("flex flex-wrap items-center justify-between gap-5 rounded-[20px] p-6 md:p-8", TONE[p.tone ?? "terra"])}>
      <div><h2 className="text-[20px] font-extrabold md:text-[24px]">{p.title}</h2><p className="mt-1.5 text-[14px] opacity-90">{p.text}</p></div>
      <div className="flex items-center gap-2" role="timer" aria-label="زمان باقی‌مانده">{cell(c.d, "روز")}{cell(c.h, "ساعت")}{cell(c.m, "دقیقه")}{cell(c.s, "ثانیه")}</div>
      {p.cta && <button onClick={() => onNav(p.target ?? "shop")} className="kv-press h-11 rounded-[11px] bg-white px-5 text-[13.5px] font-bold text-[#1B2A4A]">{p.cta}</button>}
    </section>
  );
}

function Faq({ p }: { p: BlockProps }) {
  const [open, setOpen] = useState<number | null>(0);
  const items = (p.items ?? "").split("\n").filter(Boolean).map((l) => l.split("|"));
  return (
    <section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-8">
      <h2 className="kv-editorial-title text-[22px]">{p.title}</h2>
      <div className="mt-4 divide-y divide-[var(--kv-line)]">
        {items.map(([q, a], i) => (
          <div key={i}>
            <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} className="flex min-h-12 w-full items-center justify-between gap-3 py-3 text-right text-[14px] font-bold">{q}<ChevronDown size={17} className={cn("shrink-0 transition-transform", open === i && "rotate-180")} /></button>
            {open === i && <p className="pb-4 text-[13.5px] leading-7 text-[var(--kv-muted)]">{a}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ================= Block renderer ================= */
export function BlockRenderer({ block, onNav, products = [], onOpenProduct }: { block: CmsBlock; onNav: (t: NavTarget) => void; products?: Product[]; onOpenProduct?: (id: string) => void }) {
  const p = block.props;
  switch (block.type) {
    case "announcement": return null; // rendered by AnnouncementBar at the top of the site
    case "countdown": return <Countdown p={p} onNav={onNav} />;
    case "banner": return (
      <section className="relative overflow-hidden rounded-[20px] kv-shadow-md">
        {p.image && <ResponsiveImg src={p.image} alt="" sizes="100vw" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-l from-[#0E1527]/90 via-[#0E1527]/65 to-[#0E1527]/20" />
        <div className="relative max-w-[560px] p-8 text-white md:p-10">
          <h2 className="text-[22px] font-extrabold md:text-[28px]">{p.title}</h2>
          <p className="mt-2 text-[14px] leading-7 text-white/85">{p.text}</p>
          {p.cta && <Btn variant="accent" className="mt-5" onClick={() => onNav(p.target ?? "shop")} icon={<ArrowLeft size={16} />}>{p.cta}</Btn>}
        </div>
      </section>
    );
    case "trust": return (
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[[<Truck key="a" size={18} />, "ارسال سریع", "به سراسر کشور"], [<ShieldCheck key="b" size={18} />, "ضمانت اصالت", "۱۰۰٪ اورجینال"], [<RotateCcw key="c" size={18} />, "برگشت آسان", "تا ۷ روز"], [<BadgeCheck key="d" size={18} />, "پشتیبانی", "پاسخ‌گویی سریع"]].map(([i, t, d]) => (
          <div key={t as string} className="flex items-center gap-3 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3.5"><span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{i}</span><div><p className="text-[13px] font-bold">{t}</p><p className="text-xs text-[var(--kv-muted)]">{d}</p></div></div>
        ))}
      </section>
    );
    case "products": {
      const list = products.filter((x) => !p.category || p.category === "همه" || x.category === p.category).slice(0, p.count ?? 4);
      return (
        <section>
          <div className="mb-4 flex items-end justify-between"><h2 className="kv-editorial-title text-[22px] md:text-[26px]">{p.title}</h2><button onClick={() => onNav("shop")} className="text-[13px] font-bold text-[var(--kv-accent)]">همه محصولات</button></div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {list.map((x) => <button key={x.id} onClick={() => onOpenProduct?.(x.id)} className="group text-right"><div className="kv-img overflow-hidden rounded-[16px]"><ResponsiveImg src={x.images[0]} alt={x.name} sizes="(min-width: 768px) 25vw, 50vw" className="aspect-[3/4] w-full object-cover transition-transform duration-500 group-hover:scale-105" /></div><p className="mt-2 text-[13.5px] font-bold">{x.name}</p><p className="text-[13px] font-semibold tabular-nums text-[var(--kv-muted)]">{fmtMoney(x.retailPrice)}</p></button>)}
          </div>
        </section>
      );
    }
    case "testimonials": {
      const items = (p.items ?? "").split("\n").filter(Boolean).map((l) => l.split("|"));
      return (
        <section>
          <h2 className="kv-editorial-title mb-4 text-[22px] md:text-[26px]">{p.title}</h2>
          <div className="grid gap-4 md:grid-cols-3">
            {items.map(([q, who], i) => <figure key={i} className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5"><Quote size={20} className="text-[var(--kv-accent)]" /><blockquote className="mt-3 text-[14px] leading-7">{q}</blockquote><figcaption className="mt-3 text-[12.5px] font-bold text-[var(--kv-muted)]">{who}</figcaption></figure>)}
          </div>
        </section>
      );
    }
    case "faq": return <Faq p={p} />;
    case "newsletter": return (
      <section className={cn("flex flex-wrap items-center justify-between gap-4 rounded-[20px] p-6 md:p-8", TONE[p.tone ?? "stone"])}>
        <div><h2 className="text-[19px] font-extrabold">{p.title}</h2><p className="mt-1 text-[13.5px] opacity-80">{p.text}</p></div>
        <form onSubmit={(e) => e.preventDefault()} className="flex w-full max-w-[380px] gap-2"><label className="sr-only" htmlFor={`nl-${block.id}`}>ایمیل</label><input id={`nl-${block.id}`} type="email" required placeholder="ایمیل شما" className="h-11 min-w-0 flex-1 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /><Btn variant="accent">عضویت</Btn></form>
      </section>
    );
    case "richtext": return (
      <section className="rounded-[20px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6 md:p-8"><h2 className="kv-editorial-title text-[22px]">{p.title}</h2><p className="mt-3 max-w-[70ch] whitespace-pre-line text-[14px] leading-8 text-[var(--kv-muted)]">{p.text}</p></section>
    );
  }
}

export function AnnouncementBar({ block, onNav }: { block?: CmsBlock; onNav: (t: NavTarget) => void }) {
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(`kv-ann-${block?.id}`) === "1");
  if (!block || !block.enabled || hidden || !block.props.text) return null;
  return (
    <div className={cn("relative px-10 py-2 text-center text-[12.5px] font-semibold", TONE[block.props.tone ?? "navy"])}>
      <button onClick={() => block.props.target && onNav(block.props.target)} className="hover:underline">{block.props.text}</button>
      <button onClick={() => { sessionStorage.setItem(`kv-ann-${block.id}`, "1"); setHidden(true); }} aria-label="بستن اعلان" className="absolute left-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg opacity-80 hover:opacity-100"><X size={14} /></button>
    </div>
  );
}
