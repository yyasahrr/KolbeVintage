/* Media helpers: file → URL, and the local fallback of the style-builder cutout pipeline. */

/** Small files become data URLs (persist across reloads); large ones get a session-only object URL. */
export function fileToUrl(file: File, maxInline = 600 * 1024): Promise<{ url: string; persistent: boolean }> {
  if (file.size > maxInline) return Promise.resolve({ url: URL.createObjectURL(file), persistent: false });
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ url: String(r.result), persistent: true });
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const cache = new Map<string, Promise<string>>();

/** Removes a near-uniform light background (sampled from the corners), trims, and returns a transparent PNG data URL. */
export function removeBackground(src: string, maxSide = 900): Promise<string> {
  const hit = cache.get(src);
  if (hit) return hit;
  const job = new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        const px = data.data;
        const sample = (x: number, y: number) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
        const alphaAt = (x: number, y: number) => px[(y * w + x) * 4 + 3];
        if ([alphaAt(2, 2), alphaAt(w - 3, 2), alphaAt(2, h - 3), alphaAt(w - 3, h - 3)].every((a) => a < 16)) { resolve(c.toDataURL("image/png")); return; } // already transparent
        const corners = [sample(2, 2), sample(w - 3, 2), sample(2, h - 3), sample(w - 3, h - 3)];
        const bg = [0, 1, 2].map((k) => corners.reduce((a, c2) => a + c2[k], 0) / 4);
        const dist = (i: number) => Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2]);
        // flood fill from the borders so interior light tones of the garment are preserved
        const seen = new Uint8Array(w * h);
        const stack: number[] = [];
        for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
        for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
        const T = 38, SOFT = 64;
        while (stack.length) {
          const p = stack.pop()!;
          if (seen[p]) continue;
          const d = dist(p * 4);
          if (d > SOFT) continue;
          seen[p] = 1;
          px[p * 4 + 3] = d < T ? 0 : Math.round(((d - T) / (SOFT - T)) * 255);
          const x = p % w, y = (p - x) / w;
          if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1);
          if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w);
        }
        ctx.putImageData(data, 0, 0);
        // trim transparent margins
        let minX = w, minY = h, maxX = 0, maxY = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (maxX <= minX || maxY <= minY) { resolve(c.toDataURL("image/png")); return; }
        const out = document.createElement("canvas");
        out.width = maxX - minX + 1; out.height = maxY - minY + 1;
        out.getContext("2d")!.drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
        resolve(out.toDataURL("image/png"));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error("تصویر بارگذاری نشد یا اجازه پردازش (CORS) ندارد"));
    img.src = src;
  });
  cache.set(src, job);
  job.catch(() => cache.delete(src));
  return job;
}

/** Sends the source image to an n8n webhook. Expects JSON {url} or an image/png body back. */
export async function sendToN8n(webhookUrl: string, src: string, productId: string): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const form = new FormData();
  form.append("image", blob, `${productId}.png`);
  form.append("productId", productId);
  form.append("task", "style-builder-cutout");
  const res = await fetch(webhookUrl, { method: "POST", body: form });
  if (!res.ok) throw new Error(`n8n پاسخ ${res.status} داد`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const json = await res.json();
    if (typeof json.url === "string") return json.url;
    throw new Error("پاسخ n8n فیلد url ندارد");
  }
  if (type.startsWith("image/")) return URL.createObjectURL(await res.blob());
  throw new Error("قالب پاسخ n8n پشتیبانی نمی‌شود");
}
