import type { ImgHTMLAttributes } from "react";
import { mediaSrc } from "../data/experience-api";

/* Responsive images (Req 234).
   - Kolbe media (/api/v1/media/:id) is served in fixed breakpoints as WebP (?w=…&fmt=webp), generated and cached on the server.
   - Unsplash-style CDNs get the same breakpoints via their width parameter.
   - Everything is lazy by default; heroes pass `priority` so the LCP image is never lazy-loaded. */

export const BREAKPOINTS = [320, 480, 640, 960, 1280, 1600] as const;

const isKolbeMedia = (url: string) => /\/api\/v1\/media\/[0-9a-f-]{36}(?:$|\?)/i.test(url);
const isUnsplash = (url: string) => /^https:\/\/images\.unsplash\.com\//.test(url);

/** URL of one width variant, or null when the source can't be resized (blob:, data:, unknown hosts). */
export function variantUrl(src: string, width: number): string | null {
  const full = mediaSrc(src) ?? src;
  if (isKolbeMedia(full)) {
    const base = full.split("?")[0];
    return `${base}?w=${width}&fmt=webp`;
  }
  if (isUnsplash(full)) {
    const url = new URL(full);
    url.searchParams.set("w", String(width));
    url.searchParams.set("auto", "format");
    if (!url.searchParams.has("q")) url.searchParams.set("q", "75");
    return url.toString();
  }
  return null;
}

export function srcSetFor(src: string | null | undefined, widths: readonly number[] = BREAKPOINTS): string | undefined {
  if (!src) return undefined;
  const parts = widths.map((w) => { const u = variantUrl(src, w); return u ? `${u} ${w}w` : null; }).filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "loading"> & {
  src: string | null | undefined;
  alt: string;
  /** CSS sizes hint, e.g. "(min-width: 1024px) 25vw, 50vw". */
  sizes?: string;
  /** Above-the-fold hero/LCP image: eager + high fetch priority. */
  priority?: boolean;
  widths?: readonly number[];
};

export function ResponsiveImg({ src, alt, sizes = "100vw", priority = false, widths, ...rest }: Props) {
  if (!src) return null;
  const resolved = mediaSrc(src) ?? src;
  const srcSet = srcSetFor(src, widths);
  // Fallback src: a mid-size variant when resizable, otherwise the original.
  const fallback = srcSet ? (variantUrl(src, 960) ?? resolved) : resolved;
  return (
    <img
      {...rest}
      src={fallback}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      loading={priority ? "eager" : "lazy"}
      decoding={priority ? "sync" : "async"}
      fetchPriority={priority ? "high" : "auto"}
    />
  );
}
