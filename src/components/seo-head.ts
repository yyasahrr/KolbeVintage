import { useEffect } from "react";
import { seoApi, type ResolvedSeo, type SeoEntityType } from "../data/experience-api";

/* Head manager for the SEO Domain (Req 235). Every storefront surface (CMS page, vibe landing, collection,
   product) applies the head resolved by the server — title, description, canonical, robots, Open Graph,
   Twitter and JSON-LD. The CMS never writes head tags itself. */

const MARK = "data-kv-seo";
export const DEFAULT_TITLE = "کلبه وینتج — فروشگاه پوشاک کلاسیک و مدرن";

/** Static tags shipped in index.html are reused (never duplicated) and restored on reset. */
const originals = new Map<Element, string | null>();

function upsertMeta(attr: "name" | "property", key: string, content: string | null | undefined) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (el && !el.hasAttribute(MARK) && !originals.has(el)) originals.set(el, el.getAttribute("content"));
  if (!content) { if (el?.hasAttribute(MARK)) el.remove(); return; }
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); el.setAttribute(MARK, ""); document.head.appendChild(el); }
  el.setAttribute("content", content);
}

function upsertCanonical(href: string | null) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="canonical"][${MARK}]`);
  if (!href) { el?.remove(); return; }
  if (!el) { el = document.createElement("link"); el.rel = "canonical"; el.setAttribute(MARK, ""); document.head.appendChild(el); }
  el.href = href;
}

function setJsonLd(items: Record<string, unknown>[]) {
  document.head.querySelectorAll(`script[type="application/ld+json"][${MARK}]`).forEach((n) => n.remove());
  for (const item of items) {
    const script = document.createElement("script");
    script.type = "application/ld+json";
    script.setAttribute(MARK, "");
    // textContent never parses HTML, so JSON values can't break out of the script element.
    script.textContent = JSON.stringify(item);
    document.head.appendChild(script);
  }
}

export function applySeo(seo: ResolvedSeo | null | undefined) {
  if (typeof document === "undefined") return;
  if (!seo) { resetSeo(); return; }
  document.title = seo.title;
  upsertMeta("name", "description", seo.description);
  upsertMeta("name", "robots", seo.robots);
  upsertCanonical(seo.canonical);
  upsertMeta("property", "og:title", seo.og.title);
  upsertMeta("property", "og:description", seo.og.description);
  upsertMeta("property", "og:image", seo.og.image);
  upsertMeta("property", "og:url", seo.og.url);
  upsertMeta("property", "og:type", seo.og.type);
  upsertMeta("property", "og:site_name", seo.og.siteName);
  upsertMeta("property", "og:locale", seo.og.locale);
  upsertMeta("name", "twitter:card", seo.twitter.card);
  upsertMeta("name", "twitter:title", seo.twitter.title);
  upsertMeta("name", "twitter:description", seo.twitter.description);
  upsertMeta("name", "twitter:image", seo.twitter.image);
  setJsonLd(seo.jsonLd);
}

export function resetSeo(title = DEFAULT_TITLE) {
  if (typeof document === "undefined") return;
  document.title = title;
  document.head.querySelectorAll(`[${MARK}]`).forEach((n) => n.remove());
  originals.forEach((content, el) => { if (content === null) el.removeAttribute("content"); else el.setAttribute("content", content); });
}

/** Fetches and applies the SEO Domain head for an entity while the component is mounted. */
export function useEntitySeo(type: SeoEntityType, key: string | null | undefined, fallbackTitle = DEFAULT_TITLE) {
  useEffect(() => {
    if (!key) return;
    let alive = true;
    seoApi.resolve(type, key).then((seo) => { if (alive) applySeo(seo); }).catch(() => undefined);
    return () => { alive = false; resetSeo(fallbackTitle); };
  }, [type, key, fallbackTitle]);
}
