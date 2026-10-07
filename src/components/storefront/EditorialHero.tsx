import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import type { HeroConfig } from "../../data/ops";
import type { NavTarget } from "../cms-render";
import { mediaSrc } from "../../data/experience-api";
import { ResponsiveImg } from "../responsive-img";
import { usePrefersReducedMotion, useScrollOffset } from "./shared";
import { cn } from "../../utils/cn";

const SLIDE_MS = 6000;

/**
 * Presentation-only focal points for the campaign photograph.
 *
 * These are **not** part of the CMS `HeroConfig` contract and are not persisted
 * anywhere: they exist so a hero can be cropped deliberately per breakpoint
 * without touching the CMS or the backend. When neither is supplied the
 * stylesheet's tokens win (`--kvaf-hero-focus-mobile` / `--kvaf-hero-focus`),
 * which are already portrait-safe on handheld layouts.
 */
export type HeroFocalPoint = { mobilePosition?: string; desktopPosition?: string };

type HeroWithFocalPoint = HeroConfig & HeroFocalPoint;

/**
 * Full-viewport editorial hero — a presentation adapter over the existing CMS
 * `HeroConfig` contract. It reads the same fields the CMS renderer does
 * (title/subtitle/eyebrow/CTAs/media/overlay/slides/video) and composes them as
 * one full-bleed fashion frame instead of a card.
 */
export default function EditorialHero({ h, onNav }: { h: HeroWithFocalPoint; onNav: (target: NavTarget) => void }) {
  const reduced = usePrefersReducedMotion();
  const [slide, setSlide] = useState(0);
  const [playing, setPlaying] = useState(true);
  const isCarousel = h.template === "carousel" && h.slides.length > 1;

  useEffect(() => {
    if (!isCarousel || !playing || reduced) return;
    const timer = window.setInterval(() => setSlide((index) => (index + 1) % h.slides.length), SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [isCarousel, playing, reduced, h.slides.length]);

  const offset = useScrollOffset(!reduced);
  // one motion system: media drifts down and settles, copy drifts up slightly
  const drift = Math.min(offset, 700);
  const scale = 1 + Math.min(offset / 6000, 0.06);

  const current = isCarousel ? h.slides[slide] ?? h.slides[0] : undefined;
  const image = current?.image || h.image;
  const title = current?.title || h.title;
  const subtitle = current?.subtitle || h.subtitle;
  const overlayOpacity = Math.min(0.9, Math.max(0.15, h.overlay / 100 + 0.2));
  const centered = h.align === "center";

  /* only forwarded when a campaign actually supplies one, so the stylesheet
     keeps ownership of the default crop */
  const focal = h as HeroWithFocalPoint;

  return (
    <section
      className="kv-sf-hero"
      style={{
        "--kvaf-hero-y": reduced ? 0 : drift * 0.16,
        "--kvaf-hero-scale": reduced ? 1 : scale,
        ...(focal.mobilePosition ? { "--kvaf-hero-focus-mobile": focal.mobilePosition } : null),
        ...(focal.desktopPosition ? { "--kvaf-hero-focus": focal.desktopPosition } : null),
      } as CSSProperties}
      aria-roledescription={isCarousel ? "اسلایدر" : undefined}
      aria-label={isCarousel ? "اسلایدهای کمپین" : undefined}
    >
      <div className="kv-sf-hero-media">
        {/* CMS-uploaded media is stored as a relative `/api/v1/media/<id>` URL;
            mediaSrc() resolves it against the API base so the hero never
            requests the wrong origin. ResponsiveImg adds the backed `?w=&fmt=`
            srcset for kolbe media while still rendering a plain <img>, so the
            `.kv-sf-hero-media img` stylesheet keeps ownership of the crop. */}
        {h.template === "video" && h.video
          ? <HeroVideo src={mediaSrc(h.video) ?? ""} poster={mediaSrc(h.poster || h.image || "") ?? ""} reduced={reduced} />
          : <ResponsiveImg src={image} alt="" priority sizes="100vw" />}
      </div>
      <div
        className="kv-sf-hero-scrim"
        style={{ background: `linear-gradient(to top, rgba(20,20,15,${overlayOpacity}) 4%, rgba(20,20,15,${overlayOpacity * 0.42}) 46%, rgba(20,20,15,${overlayOpacity * 0.14}) 76%)` }}
      />

      <span className="kv-sf-hero-caption" aria-hidden="true">Kolbe Archive</span>

      <div className={cn("kv-sf-hero-copy kv-sf-shell relative", centered && "mx-auto max-w-[46rem] text-center")}>
        {h.eyebrow && (
          <p className={cn("kvaf-rule max-w-[22rem]", centered && "mx-auto justify-center")}>
            <span className="shrink-0">{h.eyebrow}</span>
          </p>
        )}
        <h1 className="kvaf-display mt-5 text-[var(--kvaf-bone)]" aria-live={isCarousel ? "polite" : undefined}>
          {title.split("\n").map((line, index) => (
            <span key={index} className="block">{index > 0 && <br className="hidden sm:block" />}{line}</span>
          ))}
        </h1>
        <p className="kvaf-body mt-5 max-w-[46ch] text-[15px] text-[rgba(247,244,237,0.82)] [text-wrap:pretty]">
          {subtitle}
        </p>
        <div className={cn("kv-sf-hero-actions", centered && "justify-center")}>
          {h.ctaLabel && (
            <button onClick={() => onNav(h.ctaTarget)} data-variant="solid" className="kv-sf-hero-cta">
              {h.ctaLabel}<ArrowLeft size={17} />
            </button>
          )}
          {h.secondaryLabel && (
            <button onClick={() => onNav(h.secondaryTarget)} data-variant="ghost" className="kv-sf-hero-cta">
              {h.secondaryLabel}
            </button>
          )}
        </div>

        {isCarousel && (
          <div className={cn("mt-9 flex items-center gap-3", centered && "justify-center")}>
            <div className="flex items-center gap-1.5" role="tablist" aria-label="انتخاب اسلاید">
              {h.slides.map((_slide, index) => (
                <button
                  key={index} role="tab" aria-selected={index === slide}
                  onClick={() => setSlide(index)}
                  aria-label={`اسلاید ${(index + 1).toLocaleString("fa-IR")}`}
                  className="kv-sf-hero-dot" data-active={index === slide ? "true" : "false"}
                />
              ))}
            </div>
            <button
              onClick={() => setPlaying((value) => !value)}
              aria-label={playing ? "توقف اسلایدها" : "پخش اسلایدها"}
              className="kv-sf-press flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(247,244,237,0.32)] text-[rgba(247,244,237,0.85)] hover:bg-[rgba(247,244,237,0.12)]"
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={() => setSlide((index) => (index - 1 + h.slides.length) % h.slides.length)}
              aria-label="اسلاید قبلی"
              className="kv-sf-press flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(247,244,237,0.32)] text-[rgba(247,244,237,0.85)] hover:bg-[rgba(247,244,237,0.12)]"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setSlide((index) => (index + 1) % h.slides.length)}
              aria-label="اسلاید بعدی"
              className="kv-sf-press flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(247,244,237,0.32)] text-[rgba(247,244,237,0.85)] hover:bg-[rgba(247,244,237,0.12)]"
            >
              <ChevronLeft size={16} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function HeroVideo({ src, poster, reduced }: { src: string; poster: string; reduced: boolean }) {
  const [paused, setPaused] = useState(reduced);
  const [ref, setRef] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!ref) return;
    if (paused || reduced) ref.pause();
    else ref.play().catch(() => setPaused(true));
  }, [paused, reduced, ref]);
  return (
    <>
      <video ref={setRef} src={src} poster={poster} muted loop playsInline autoPlay={!paused && !reduced} aria-hidden="true" />
      <button
        onClick={() => setPaused((value) => !value)}
        aria-label={paused ? "پخش ویدیو" : "توقف ویدیو"}
        className="kv-sf-press absolute bottom-5 left-5 flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(247,244,237,0.32)] text-[rgba(247,244,237,0.85)] hover:bg-[rgba(247,244,237,0.12)]"
      >
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
    </>
  );
}
