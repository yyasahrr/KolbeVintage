import { useCallback, useEffect, useRef, useState } from "react";
import type { SitePage } from "../data/experience-api";
import { CmsSections } from "./cms-blocks";
import { useSiteExperience, useThemeTokens } from "./site-chrome";
import { ToastProvider } from "./toast";

/* Real-viewport preview (Req 185, 231): the draft is rendered inside an iframe whose width IS the device
   width, so Tailwind breakpoints, responsive visibility and mobile media behave exactly like on a phone.
   The draft travels by same-origin postMessage — never through the URL and never published. */

type Msg = { type: "kv-preview"; page: SitePage; selectedId?: string } | { type: "kv-preview-ready" } | { type: "kv-preview-select"; sectionId: string };
export const isPreviewFrame = () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("kvPreview");
const WIDTH = { desktop: 1280, tablet: 820, mobile: 390 } as const;

export function PreviewFrame({ page, device, selectedId, onSelect }: { page: SitePage; device: keyof typeof WIDTH; selectedId?: string; onSelect?: (id: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const onSelectRef = useRef(onSelect);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const send = useCallback(() => ref.current?.contentWindow?.postMessage({ type: "kv-preview", page, selectedId } satisfies Msg, window.location.origin), [page, selectedId]);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    const on = (e: MessageEvent<Msg>) => {
      if (e.origin !== window.location.origin || e.source !== ref.current?.contentWindow) return;
      if (e.data?.type === "kv-preview-ready") send();
      if (e.data?.type === "kv-preview-select") onSelectRef.current?.(e.data.sectionId);
    };
    window.addEventListener("message", on);
    send();
    return () => window.removeEventListener("message", on);
  }, [send]);
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
  const [selectedId, setSelectedId] = useState('');
  const { theme } = useSiteExperience();
  useThemeTokens(theme, false);
  useEffect(() => {
    const on = (e: MessageEvent<Msg>) => { if (e.origin === window.location.origin && e.source === window.parent && e.data?.type === "kv-preview") { setPage(e.data.page); setSelectedId(e.data.selectedId ?? ''); } };
    window.addEventListener("message", on);
    window.parent.postMessage({ type: "kv-preview-ready" } satisfies Msg, window.location.origin);
    return () => window.removeEventListener("message", on);
  }, []);
  useEffect(() => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-preview-frame] [data-cms-section-id]')) {
      element.dataset.cmsSelected = element.dataset.cmsSectionId === selectedId ? 'true' : 'false';
    }
  }, [page, selectedId]);
  const selectSection = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-cms-section-id]') : null;
    if (!target?.dataset.cmsSectionId) return;
    event.preventDefault(); event.stopPropagation();
    window.parent.postMessage({ type: 'kv-preview-select', sectionId: target.dataset.cmsSectionId } satisfies Msg, window.location.origin);
  };
  return (
    <ToastProvider>
      <main className="mx-auto max-w-[1480px] px-4 py-6 md:px-8" data-preview-frame onClickCapture={selectSection}>
        {page ? <CmsSections page={page} onNav={() => undefined} /> : <p className="py-20 text-center text-[13px] text-[var(--kv-muted)]">در انتظار پیش‌نویس…</p>}
      </main>
    </ToastProvider>
  );
}
