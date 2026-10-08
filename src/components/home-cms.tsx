import type { HeroConfig, HeroTemplate } from "../data/ops";
import type { PageSection } from "../data/experience-api";
import type { HeroFocalPoint } from "./storefront/EditorialHero";
import type { NavTarget } from "./cms-render";

/**
 * Homepage hero adapter (docs/cms-functional-audit.md §4).
 *
 * The accepted storefront homepage keeps its own visual identity (the
 * full-bleed EditorialHero and its section rhythm), but its CONTENT is owned
 * by the published CMS `home` page: the hero section's payload feeds the
 * EditorialHero adapter, so title, eyebrow, media, video, poster, overlay,
 * alignment, CTAs and slides are all CMS-controlled while the hero keeps its
 * accepted look. All other published sections render inside retail.tsx through
 * the storefront bands or the shared CmsSection component — preview and
 * storefront stay one renderer apart, never two universes.
 *
 * Honest template mapping: the accepted hero is a single full-bleed editorial
 * frame with three modes. `carousel` (with 2+ slides) renders the accepted
 * slider; `video` (any of video_hero/video/cinematic/fullviewport) with a
 * video URL renders the accepted video hero; every other variant/template
 * renders the accepted static frame. The 12-template CmsHero presentation
 * remains the renderer of dedicated CMS landing pages (/page/:code) — the two
 * never mix on the homepage.
 */
const HERO_CODES = ["hero", "image_hero", "video_hero"];

export const isHeroSection = (section: PageSection) => HERO_CODES.includes(section.component_code);

type HeroPayload = Record<string, unknown>;
const str = (v: unknown, fallback = "") => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const navTarget = (v: string): NavTarget => (["shop", "vip", "tryon", "journal"].includes(v) ? (v as NavTarget) : "shop");

/** Published hero payload → the accepted EditorialHero contract. */
export function cmsHeroToEditorial(section: PageSection): HeroConfig & HeroFocalPoint {
  const p = (section.payload ?? {}) as HeroPayload;
  const template = str(p.template, section.variant || "split").toLowerCase();
  const video = str(p.video);
  const slides = Array.isArray(p.slides)
    ? (p.slides as HeroPayload[]).slice(0, 6).map((s) => ({
        image: str(s.image),
        title: str(s.title),
        subtitle: str(s.subtitle),
      })).filter((s) => s.image)
    : [];
  const overlay = Math.min(90, Math.max(0, typeof p.overlay === "number" ? p.overlay : 35));
  const resolved: HeroTemplate =
    template === "carousel" && slides.length > 1 ? "carousel"
    : video && ["video", "cinematic", "fullviewport", "video_hero"].includes(template) ? "video"
    : "fullbleed";
  return {
    template: resolved,
    eyebrow: str(p.eyebrow),
    title: str(p.title ?? p.headline, "کلبه وینتیج"),
    subtitle: str(p.subtitle ?? p.description),
    ctaLabel: str(p.ctaLabel ?? p.cta),
    ctaTarget: navTarget(str(p.ctaTarget ?? p.target, "shop")),
    secondaryLabel: str(p.secondaryLabel ?? p.secondaryCta),
    secondaryTarget: navTarget(str(p.secondaryTarget, "shop")),
    image: str(p.image ?? p.media),
    video,
    poster: str(p.poster),
    overlay,
    align: str(p.alignment ?? p.align, "right") === "center" ? "center" : "right",
    slides,
    mosaic: [],
    ...(str(p.mobilePosition) ? { mobilePosition: str(p.mobilePosition) } : {}),
    ...(str(p.desktopPosition) ? { desktopPosition: str(p.desktopPosition) } : {}),
  };
}
