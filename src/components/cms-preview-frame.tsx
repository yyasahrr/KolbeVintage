import { useEffect, useRef, useState } from "react";
import type { SitePage } from "../data/experience-api";
import { CmsSections } from "./cms-blocks";
import { useSiteExperience, useThemeTokens } from "./site-chrome";
import { ToastProvider } from "./toast";

/* Real-viewport preview (Req 185, 231): the draft is rendered inside an iframe whose width IS the device
   width, so Tailwind breakpoints, responsive visibility and mobile media behave exactly like on a phone.
   The draft travels by same-origin postMessage — never through the URL and never published. */

type Msg = { type: "kv-preview"; page: SitePage } | { type: "kv-preview-ready" };
export const isPreviewFrame = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("kvPreview");
const WIDTH = { desktop: 1280, tablet: 820, mobile: 390 } as const;

export function PreviewFrame({ page, device }: { page: SitePage; device: keyof typeof WIDTH }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const send = () => ref.current?.contentWindow?.postMessage({ type: "kv-preview", page } satisfies Msg, window.location.origin);
  useEffect(() => {
    const on = (e: MessageEvent<Msg>) => { if (e.origin === window.location.origin && e.source === ref.current?.contentWindow && e.data?.type === "kv-preview-ready") send(); };
    window.addEventListener("message", on);
    send();
    return () => window.removeEventListener("message", on);
  });
  useEffect(() => {
    if (!box) return;
    const fit = () => setScale(Math.min(1, box.clientWidth / WIDTH[device]));
    fit();
    const ro = new ResizeObserver(fit); ro.observe(box);
    return () => ro.disconnect();
  }, [box, device]);
  const w = WIDTH[device];
  const h = 760;
  return (
    <div ref={setBox} className="w-full overflow-hidden" style={{ height: h * scale + 2 }}>
      <iframe ref={ref} title={`پیش‌نمایش ${device}`} src="/?kvPreview=1" data-device={device} data-width={w}
        className="mx-auto block origin-top-right rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-bg)]"
        style={{ width: w, height: h, transform: `scale(${scale})`, marginInlineStart: scale < 1 ? 0 : "auto" }} />
    </div>
  );
}

/** Rendered by main.tsx when the document is the preview iframe. */
export function PreviewFrameApp() {
  const [page, setPage] = useState<SitePage | null>(null);
  const { theme } = useSiteExperience();
  useThemeTokens(theme, false);
  useEffect(() => {
    const on = (e: MessageEvent<Msg>) => { if (e.origin === window.location.origin && e.source === window.parent && e.data?.type === "kv-preview") setPage(e.data.page); };
    window.addEventListener("message", on);
    window.parent.postMessage({ type: "kv-preview-ready" } satisfies Msg, window.location.origin);
    return () => window.removeEventListener("message", on);
  }, []);
  return (
    <ToastProvider>
      <main className="mx-auto max-w-[1480px] px-4 py-6 md:px-8" data-preview-frame>
        {page ? <CmsSections page={page} onNav={() => undefined} /> : <p className="py-20 text-center text-[13px] text-[var(--kv-muted)]">در انتظار پیش‌نویس…</p>}
      </main>
    </ToastProvider>
  );
}
