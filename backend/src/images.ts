/* Server-side image processing (Req 234 responsive images, Req 334 avatar resize).
   `sharp` is loaded lazily; if the native module is unavailable the original bytes are used so uploads
   never break, and the caller is told that no processing happened. */

type SharpFactory = typeof import('sharp');
let sharpPromise: Promise<SharpFactory | null> | null = null;

async function loadSharp(): Promise<SharpFactory | null> {
  sharpPromise ??= import('sharp').then((m) => (m.default ?? m) as unknown as SharpFactory).catch(() => null);
  return sharpPromise;
}

export const RESPONSIVE_WIDTHS = [160, 320, 480, 640, 960, 1280, 1600] as const;
export type VariantFormat = 'webp' | 'jpeg' | 'png';
export const AVATAR_SIZE = 512;
const RESIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const isResizable = (mime: string) => RESIZABLE.has(mime);

/** Snaps an arbitrary requested width to the nearest allowed breakpoint (prevents cache-busting abuse). */
export function snapWidth(requested: number): number {
  const allowed = RESPONSIVE_WIDTHS as readonly number[];
  return allowed.find((w) => w >= requested) ?? allowed[allowed.length - 1]!;
}

/** Avatar pipeline: auto-orient → square crop (attention) → 512×512 → WebP. EXIF/GPS metadata is stripped. */
export async function processAvatar(buffer: Buffer): Promise<{ buffer: Buffer; mime: string; width: number; height: number; processed: boolean }> {
  const sharp = await loadSharp();
  if (!sharp) return { buffer, mime: '', width: 0, height: 0, processed: false };
  const out = await sharp(buffer, { limitInputPixels: 4096 * 4096 })
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: out.data, mime: 'image/webp', width: out.info.width, height: out.info.height, processed: true };
}

/** Responsive variant for public media: never upscales, strips metadata. Returns null if processing is unavailable. */
export async function renderVariant(buffer: Buffer, width: number, format: VariantFormat): Promise<{ buffer: Buffer; mime: string; width: number } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const pipeline = sharp(buffer, { limitInputPixels: 8192 * 8192 }).rotate().resize({ width, withoutEnlargement: true });
  const encoded = format === 'webp' ? pipeline.webp({ quality: 78 }) : format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 80, mozjpeg: true });
  const out = await encoded.toBuffer({ resolveWithObject: true });
  return { buffer: out.data, mime: `image/${format}`, width: out.info.width };
}
