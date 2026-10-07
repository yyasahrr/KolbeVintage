import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine, ArrowUpToLine, Check, Copy, Download, Layers, Link2, Loader2, Minus, Plus, RotateCcw, Save, ShoppingBag,
  Sparkles, Trash2, Wand2,
} from "lucide-react";
import { mediaSrc, rialToToman, styleApi, type CommerceProduct, type StyleFeatures, type StyleItem, type StyleScore, type StyleValidation } from "../data/experience-api";
import { isAuthenticated } from "../data/api";
import { fmtMoney } from "../data/catalog";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented } from "../components/primitives";
import { useToast } from "../components/toast";
import { cn } from "../utils/cn";

type CatalogItem = CommerceProduct & { styleCategory: string; features: StyleFeatures };
export type CartAddLine = { id: string; size: string; color: string };
const DRAFT = "kolbe-style-studio-v1";
const fa = (n: number) => n.toLocaleString("fa-IR");

const CATEGORY_LABEL: Record<string, string> = { all: "همه", coat: "کت و پالتو", knitwear: "بافت", shirt: "پیراهن", trousers: "شلوار", shoes: "کفش", accessory: "اکسسوری" };
const BREAKDOWN_LABEL: Record<keyof StyleScore["breakdown"], string> = {
  colorHarmony: "هماهنگی رنگ", vibeMatch: "هماهنگی استایل", seasonMatch: "فصل", formalityMatch: "فرم لباس",
  silhouetteBalance: "تعادل سیلوئت", categoryCompatibility: "تناسب آیتم‌ها", patternCompatibility: "هماهنگی طرح",
};

/** Style Builder backed by the canonical catalogue — no local product, price or stock copies (Req 319). */
export function StyleStudio({ accountId, onLogin, onAddItems }: { accountId?: string; onLogin: () => void; onAddItems?: (lines: CartAddLine[]) => void }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<StyleItem[]>(() => { try { const v = JSON.parse(sessionStorage.getItem(DRAFT) || "null"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [score, setScore] = useState<StyleScore | null>(null);
  const [scoring, setScoring] = useState(false);
  const [loaded, setLoaded] = useState<{ id: string; name: string; version: number; shareCode: string; privacy: "private" | "unlisted" | "public" } | null>(null);
  const [shared, setShared] = useState<{ owner: string; name: string } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveForm, setSaveForm] = useState({ name: "", privacy: "private" as "private" | "unlisted" | "public" });
  const [busy, setBusy] = useState<"" | "save" | "cart" | "look" | "export">("");
  const [validation, setValidation] = useState<StyleValidation | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const createdEvent = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try { setCatalog((await styleApi.catalog()).items); } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت محصولات"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { sessionStorage.setItem(DRAFT, JSON.stringify(items)); }, [items]);

  // Shared link (#/style/CODE) or "edit" request from the account dashboard.
  useEffect(() => {
    const match = /#\/style\/([A-Z0-9]{5,10})/.exec(window.location.hash);
    const editId = sessionStorage.getItem("kolbe-edit-style");
    if (match) {
      styleApi.shared(match[1]!).then((s) => { setItems(s.items); setShared({ owner: s.owner_name, name: s.name }); }).catch(() => toast.push("این استایل یافت نشد یا خصوصی است.", "error"));
    } else if (editId && isAuthenticated()) {
      sessionStorage.removeItem("kolbe-edit-style");
      styleApi.list().then((res) => {
        const s = res.items.find((x) => x.id === editId);
        if (s) { setItems(s.items); setLoaded({ id: s.id, name: s.name, version: s.version, shareCode: s.share_code, privacy: s.privacy }); setSaveForm({ name: s.name, privacy: s.privacy }); }
      }).catch(() => undefined);
    }
  }, [toast]);

  const byId = useMemo(() => new Map((catalog ?? []).map((p) => [p.id, p])), [catalog]);
  const onCanvas = items.filter((i) => byId.has(i.productId));

  // Live hybrid score (server, deterministic v1) — debounced.
  useEffect(() => {
    if (onCanvas.length < 2) { setScore(null); return; }
    if (!createdEvent.current) { createdEvent.current = true; styleApi.event("style.created", undefined, onCanvas.map((i) => i.productId)); }
    const t = window.setTimeout(async () => {
      setScoring(true);
      try { setScore(await styleApi.score(onCanvas.map((i) => ({ productId: i.productId })))); } catch { setScore(null); } finally { setScoring(false); }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCanvas.map((i) => i.productId).join(",")]);

  const maxZ = Math.max(0, ...items.map((i) => i.z));
  const toggle = (id: string) => {
    if (items.some((i) => i.productId === id)) { setItems(items.filter((i) => i.productId !== id)); if (active === id) setActive(null); return; }
    setItems([...items, { productId: id, x: 25 + ((items.length * 17) % 50), y: 40 + ((items.length * 11) % 25), scale: 1, z: maxZ + 1 }]);
    setActive(id);
  };
  const patch = (id: string, p: Partial<StyleItem>) => setItems((list) => list.map((i) => (i.productId === id ? { ...i, ...p } : i)));
  const onDown = (e: React.PointerEvent, it: StyleItem) => {
    const rect = canvas.current?.getBoundingClientRect(); if (!rect) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: it.productId, dx: ((e.clientX - rect.left) / rect.width) * 100 - it.x, dy: ((e.clientY - rect.top) / rect.height) * 100 - it.y };
    setActive(it.productId); patch(it.productId, { z: maxZ + 1 });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; const rect = canvas.current?.getBoundingClientRect(); if (!d || !rect) return;
    patch(d.id, { x: Math.min(92, Math.max(8, ((e.clientX - rect.left) / rect.width) * 100 - d.dx)), y: Math.min(90, Math.max(10, ((e.clientY - rect.top) / rect.height) * 100 - d.dy)) });
  };
  const onKey = (e: React.KeyboardEvent, it: StyleItem) => {
    const step = e.shiftKey ? 5 : 1.5;
    const map: Record<string, Partial<StyleItem>> = { ArrowLeft: { x: Math.max(8, it.x - step) }, ArrowRight: { x: Math.min(92, it.x + step) }, ArrowUp: { y: Math.max(10, it.y - step) }, ArrowDown: { y: Math.min(90, it.y + step) }, "+": { scale: Math.min(1.8, it.scale + 0.1) }, "-": { scale: Math.max(0.4, it.scale - 0.1) } };
    if (map[e.key]) { e.preventDefault(); patch(it.productId, map[e.key]!); }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); toggle(it.productId); }
  };

  const replace = (fromId: string, to: CommerceProduct) => {
    const old = items.find((i) => i.productId === fromId);
    setItems(items.map((i) => (i.productId === fromId ? { ...i, productId: to.id } : i)));
    if (!byId.has(to.id)) setCatalog((c) => c ? [...c, { ...to, styleCategory: byId.get(fromId)?.styleCategory ?? "shirt", features: byId.get(fromId)!.features }] : c);
    if (old) setActive(to.id);
    toast.push(`«${to.name}» جایگزین شد.`);
  };

  const completeLook = async () => {
    if (!onCanvas.length) return;
    setBusy("look");
    try {
      const res = await styleApi.completeLook(onCanvas.map((i) => i.productId));
      if (!res.added.length) { toast.push("آیتم مناسب و موجودی برای تکمیل این استایل پیدا نشد.", "info"); return; }
      setCatalog((c) => { const map = new Map((c ?? []).map((p) => [p.id, p])); for (const p of res.added) if (!map.has(p.id)) map.set(p.id, { ...p, styleCategory: "shirt", features: { dominantColors: [], productType: "shirt", vibes: p.vibes, seasons: p.seasons, formality: 0.6, pattern: "solid", fit: "regular", visualWeight: "medium" } }); return [...map.values()]; });
      let z = maxZ;
      setItems((list) => [...list, ...res.added.map((p, i) => ({ productId: p.id, x: 20 + i * 18, y: 70 - i * 8, scale: 0.85, z: ++z }))]);
      toast.push(`${fa(res.added.length)} آیتم از موجودی واقعی به استایل اضافه شد.`);
    } catch (e) { toast.push(e instanceof Error ? e.message : "خطا در تکمیل استایل", "error"); }
    finally { setBusy(""); }
  };

  const buyAll = async () => {
    if (!onCanvas.length) return;
    setBusy("cart");
    try {
      const res = await styleApi.validate(onCanvas.map((i) => ({ productId: i.productId, variantId: i.variantId ?? null })));
      setValidation(res);
      const ok = res.items.filter((i) => i.purchasable && i.variant);
      if (ok.length && onAddItems) {
        onAddItems(ok.map((i) => ({ id: i.productId, size: i.variant!.size ?? "", color: i.variant!.color ?? "" })));
        toast.bumpCart();
        styleApi.event("style.purchased", loaded?.id, ok.map((i) => i.productId));
      }
      toast.push(res.message, ok.length === res.total ? "success" : ok.length ? "info" : "error");
    } catch (e) { toast.push(e instanceof Error ? e.message : "اعتبارسنجی ناموفق بود", "error"); }
    finally { setBusy(""); }
  };

  /** Renders the canvas into an image (Req 268). Same-origin/CORS media only; tainted canvases fail loudly. */
  const renderImage = async (type: "image/png" | "image/jpeg", width = 1080): Promise<string> => {
    const height = Math.round(width * 1.25);
    const c = document.createElement("canvas"); c.width = width; c.height = height;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#F6F1E8"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(27,42,74,0.12)";
    for (let x = 12; x < width; x += 24) for (let y = 12; y < height; y += 24) { ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill(); }
    const sorted = [...onCanvas].sort((a, b) => a.z - b.z);
    for (const it of sorted) {
      const p = byId.get(it.productId); const src = mediaSrc(p?.flatLay ?? p?.image);
      if (!src) continue;
      const img = await new Promise<HTMLImageElement>((resolve, reject) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => resolve(im); im.onerror = reject; im.src = src; });
      const w = width * 0.34 * it.scale; const h = w * (img.naturalHeight / Math.max(1, img.naturalWidth));
      ctx.drawImage(img, (it.x / 100) * width - w / 2, (it.y / 100) * height - h / 2, w, h);
    }
    ctx.fillStyle = "#1B2A4A"; ctx.font = `bold ${Math.round(width / 36)}px Vazirmatn, sans-serif`; ctx.textAlign = "right";
    ctx.fillText(`KOLBE VINTAGE${score ? ` · امتیاز استایل ${fa(score.total)}` : ""}`, width - 32, height - 32);
    return c.toDataURL(type, 0.85);
  };
  const exportImage = async (type: "image/png" | "image/jpeg") => {
    setBusy("export");
    try {
      const url = await renderImage(type);
      const a = document.createElement("a"); a.href = url; a.download = `kolbe-style-${Date.now()}.${type === "image/png" ? "png" : "jpg"}`; a.click();
      toast.push("تصویر استایل آماده دانلود شد.");
    } catch { toast.push("ساخت تصویر ممکن نشد؛ برخی تصاویر اجازه استفاده بین‌دامنه‌ای ندارند.", "error"); }
    finally { setBusy(""); }
  };

  const save = async (mode: "update" | "new") => {
    if (!accountId || !isAuthenticated()) { onLogin(); return; }
    if (!saveForm.name.trim()) { toast.push("برای استایل یک نام انتخاب کنید.", "error"); return; }
    setBusy("save");
    try {
      let preview: string | null = null;
      try { preview = await renderImage("image/jpeg", 420); } catch { preview = null; }
      if (mode === "update" && loaded) {
        const res = await styleApi.update(loaded.id, { name: saveForm.name.trim(), items: onCanvas, privacy: saveForm.privacy, previewDataUrl: preview });
        setLoaded({ ...loaded, name: res.name, version: res.version, privacy: res.privacy });
        toast.push(`استایل به‌روزرسانی شد (نسخه ${fa(res.version)}).`);
        if (saveForm.privacy !== "private") setShareLink(`${window.location.origin}${window.location.pathname}#/style/${loaded.shareCode}`);
      } else {
        const res = await styleApi.save({ name: saveForm.name.trim(), items: onCanvas, privacy: saveForm.privacy, previewDataUrl: preview });
        setLoaded({ id: res.id, name: saveForm.name.trim(), version: 1, shareCode: res.shareCode, privacy: saveForm.privacy });
        toast.push("استایل در حساب شما ذخیره شد.");
        if (saveForm.privacy !== "private") { setShareLink(`${window.location.origin}${window.location.pathname}#/style/${res.shareCode}`); styleApi.event("style.shared", res.id); }
      }
      setSaveOpen(false);
    } catch (e) { toast.push(e instanceof Error ? e.message : "ذخیره ناموفق بود", "error"); }
    finally { setBusy(""); }
  };

  if (error) return <div className="mx-auto max-w-[900px] px-4 py-10"><ErrorState message={error} onRetry={load} /></div>;
  if (!catalog) return <div className="mx-auto max-w-[900px] px-4 py-10"><LoadingState label="در حال آماده‌سازی استایل‌بیلدر…" /></div>;

  const cur = items.find((i) => i.productId === active);
  const categories = ["all", ...Array.from(new Set(catalog.map((p) => p.styleCategory)))];
  const list = catalog.filter((p) => filter === "all" || p.styleCategory === filter);
  const bundle = onCanvas.reduce((sum, i) => sum + rialToToman(byId.get(i.productId)?.priceRial ?? "0"), 0);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Sparkles size={14} />استایل‌بیلدر هوشمند کلبه</p>
          <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">{loaded ? loaded.name : shared ? `استایل «${shared.name}» از ${shared.owner}` : "استایل خودت را بساز"}</h1>
          <p className="mt-1 text-[13px] text-[var(--kv-muted)]">بکشید و رها کنید؛ امتیاز سازگاری، دلیل آن و پیشنهاد جایگزین از موجودی واقعی کلبه محاسبه می‌شود.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="soft" size="sm" icon={<RotateCcw size={15} />} disabled={!items.length} onClick={() => { setItems([]); setActive(null); setLoaded(null); setShared(null); setValidation(null); }}>بوم جدید</Btn>
          <Btn variant="soft" size="sm" icon={busy === "export" ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} disabled={!onCanvas.length || !!busy} onClick={() => exportImage("image/png")}>PNG</Btn>
          <Btn variant="soft" size="sm" disabled={!onCanvas.length || !!busy} onClick={() => exportImage("image/jpeg")}>JPEG</Btn>
          <Btn variant="accent" size="sm" icon={<Save size={15} />} disabled={!onCanvas.length} onClick={() => { if (!accountId) { onLogin(); return; } setSaveForm((f) => ({ ...f, name: f.name || loaded?.name || `استایل ${new Date().toLocaleDateString("fa-IR")}` })); setSaveOpen(true); }}>{accountId ? "ذخیره استایل" : "ورود و ذخیره"}</Btn>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[270px_minmax(0,1fr)_320px]">
        {/* product drawer */}
        <Card className="h-fit p-4 lg:sticky lg:top-24">
          <p className="mb-2 text-[13px] font-bold">محصولات موجود</p>
          <div className="kv-no-scrollbar -mx-1 mb-3 flex gap-1 overflow-x-auto px-1">
            {categories.map((c) => <button key={c} onClick={() => setFilter(c)} aria-pressed={filter === c} className={cn("shrink-0 rounded-full px-3 py-1.5 text-[11.5px] font-bold", filter === c ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)]")}>{CATEGORY_LABEL[c] ?? c}</button>)}
          </div>
          {list.length === 0 ? <p className="text-[12.5px] text-[var(--kv-muted)]">محصولی در این دسته منتشر نشده است.</p> : (
            <div className="kv-scroll grid max-h-[560px] grid-cols-2 gap-2 overflow-y-auto pl-1">
              {list.map((p) => { const on = items.some((i) => i.productId === p.id); return (
                <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={on} aria-label={`${p.name}${p.available < 1 ? "، ناموجود" : ""}`} className={cn("kv-dotted-light relative flex aspect-[3/4] flex-col items-center justify-center overflow-hidden rounded-[12px] border-2 p-1.5", on ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                  {(p.flatLay || p.image) ? <img src={mediaSrc(p.flatLay ?? p.image)} alt="" className="max-h-[78%] max-w-full object-contain" loading="lazy" /> : <span className="text-[10px] text-[var(--kv-muted)]">بدون تصویر</span>}
                  {on && <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--kv-accent)] text-white"><Check size={11} /></span>}
                  {p.available < 1 && <span className="absolute right-1.5 top-1.5 rounded-full bg-black/55 px-1.5 text-[9.5px] font-bold text-white">ناموجود</span>}
                  <span className="absolute inset-x-1 bottom-1 truncate rounded-md bg-[var(--kv-surface)]/90 px-1 text-[10px] font-bold">{p.name}</span>
                </button>
              ); })}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-5 text-[var(--kv-muted)]">تصاویر از نقش «flat-lay» رسانه محصول خوانده می‌شوند؛ در نبود آن از تصویر اصلی استفاده می‌شود.</p>
        </Card>

        {/* canvas */}
        <div>
          <div ref={canvas} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            className="kv-dotted-light relative aspect-[4/5] touch-none select-none overflow-hidden rounded-[24px] border border-[var(--kv-line)] shadow-[var(--shadow-soft-md)]" aria-label="بوم استایل">
            {onCanvas.length === 0 && <div className="absolute inset-0 flex items-center justify-center p-6"><Empty title="بوم خالی است" desc="از فهرست کنار، دست‌کم دو آیتم انتخاب کنید تا امتیاز سازگاری محاسبه شود." /></div>}
            {onCanvas.map((it) => { const p = byId.get(it.productId)!; return (
              <div key={it.productId} role="button" tabIndex={0} aria-label={`${p.name}؛ برای جابه‌جایی بکشید یا از کلیدهای جهت استفاده کنید`}
                onPointerDown={(e) => onDown(e, it)} onKeyDown={(e) => onKey(e, it)} onFocus={() => setActive(it.productId)}
                className={cn("absolute w-[34%] max-w-[260px] cursor-grab outline-offset-4 active:cursor-grabbing", active === it.productId && "outline outline-2 outline-dashed outline-[var(--kv-accent)]")}
                style={{ left: `${it.x}%`, top: `${it.y}%`, zIndex: it.z, transform: `translate(-50%, -50%) scale(${it.scale})` }}>
                {(p.flatLay || p.image) && <img src={mediaSrc(p.flatLay ?? p.image)} alt={p.name} draggable={false} className="pointer-events-none w-full rounded-[10px] object-contain drop-shadow-[0_18px_22px_rgba(27,42,74,0.22)]" />}
              </div>
            ); })}
            {score && (
              <div className="kv-glass absolute left-4 top-4 z-[999] flex items-center gap-2 rounded-full px-3 py-1.5 text-[12.5px] font-extrabold" aria-live="polite">
                <span className={cn("h-2.5 w-2.5 rounded-full", score.total >= 85 ? "bg-[var(--kv-success)]" : score.total >= 65 ? "bg-[var(--kv-warning)]" : "bg-[var(--kv-danger)]")} />امتیاز {fa(score.total)}/۱۰۰
              </div>
            )}
          </div>
          {cur && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">
              <span className="px-2 text-[12px] font-bold">{byId.get(cur.productId)?.name}</span>
              <button aria-label="کوچک‌تر" onClick={() => patch(cur.productId, { scale: Math.max(0.4, cur.scale - 0.1) })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><Minus size={14} /></button>
              <span className="w-12 text-center text-[12px] tabular-nums">{fa(Math.round(cur.scale * 100))}٪</span>
              <button aria-label="بزرگ‌تر" onClick={() => patch(cur.productId, { scale: Math.min(1.8, cur.scale + 0.1) })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><Plus size={14} /></button>
              <button aria-label="آوردن به جلو" onClick={() => patch(cur.productId, { z: maxZ + 1 })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><ArrowUpToLine size={14} /></button>
              <button aria-label="بردن به عقب" onClick={() => patch(cur.productId, { z: Math.min(...items.map((i) => i.z)) - 1 })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><ArrowDownToLine size={14} /></button>
              <button aria-label="حذف از بوم" onClick={() => toggle(cur.productId)} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)] text-[var(--kv-danger)]"><Trash2 size={14} /></button>
            </div>
          )}
          {shareLink && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[14px] border border-[var(--kv-accent)]/40 bg-[var(--kv-accent)]/[0.05] p-3 text-[12.5px]">
              <Link2 size={15} className="text-[var(--kv-accent)]" /><span className="min-w-0 flex-1 truncate" dir="ltr">{shareLink}</span>
              <Btn size="sm" variant="soft" icon={<Copy size={13} />} onClick={() => { void navigator.clipboard?.writeText(shareLink); toast.push("لینک اشتراک کپی شد."); }}>کپی لینک</Btn>
            </div>
          )}
        </div>

        {/* intelligence panel */}
        <div className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center justify-between"><p className="flex items-center gap-1.5 text-[13.5px] font-extrabold"><Wand2 size={15} className="text-[var(--kv-accent)]" />امتیاز سازگاری</p>{scoring && <Loader2 size={14} className="animate-spin text-[var(--kv-muted)]" />}</div>
            {!score ? <p className="mt-2 text-[12.5px] leading-6 text-[var(--kv-muted)]">دست‌کم دو آیتم روی بوم بگذارید.</p> : (
              <>
                <div className="mt-3 flex items-end gap-2"><b className="text-[40px] font-extrabold leading-none tabular-nums">{fa(score.total)}</b><span className="pb-1 text-[12px] text-[var(--kv-muted)]">از ۱۰۰ · الگوریتم {score.scoreVersion}</span></div>
                <div className="mt-3 space-y-2">
                  {(Object.keys(BREAKDOWN_LABEL) as (keyof StyleScore["breakdown"])[]).map((k) => (
                    <div key={k}><div className="flex justify-between text-[11.5px]"><span>{BREAKDOWN_LABEL[k]}</span><b className="tabular-nums">{fa(score.breakdown[k])}</b></div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--kv-surface-2)]"><div className={cn("h-full rounded-full", score.breakdown[k] >= 85 ? "bg-[var(--kv-success)]" : score.breakdown[k] >= 65 ? "bg-[var(--kv-warning)]" : "bg-[var(--kv-danger)]")} style={{ width: `${score.breakdown[k]}%` }} /></div></div>
                  ))}
                </div>
                {score.explanation && <p className="mt-3 rounded-[12px] bg-[var(--kv-surface-2)] p-3 text-[12.5px] leading-7">{score.explanation}</p>}
                {score.issues.length > 1 && <ul className="mt-2 list-inside list-disc text-[11.5px] leading-6 text-[var(--kv-muted)]">{score.issues.slice(1).map((i) => <li key={i}>{i}</li>)}</ul>}
                {!!score.suggestions?.length && (
                  <div className="mt-3 space-y-2 border-t border-[var(--kv-line)] pt-3">
                    <p className="text-[12px] font-bold">پیشنهاد بهتر (موجود در انبار)</p>
                    {score.suggestions.map((sg) => (
                      <div key={sg.candidate.id} className="flex items-center gap-2 rounded-[12px] border border-[var(--kv-line)] p-2">
                        {sg.candidate.image && <img src={mediaSrc(sg.candidate.image)} alt="" className="h-12 w-10 rounded-[8px] object-cover" />}
                        <div className="min-w-0 flex-1"><p className="truncate text-[12px] font-bold">{sg.candidate.name}</p><p className="text-[11px] text-[var(--kv-muted)]">به‌جای {sg.replaceName} · امتیاز {fa(sg.newScore)}</p></div>
                        <Btn size="sm" variant="soft" onClick={() => replace(sg.replaceProductId, sg.candidate)}>جایگزین</Btn>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <Btn variant="soft" size="sm" className="mt-4 w-full" disabled={!onCanvas.length || !!busy} icon={busy === "look" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} onClick={completeLook}>تکمیل استایل از موجودی کلبه</Btn>
          </Card>

          <Card className="p-4">
            <p className="flex items-center gap-1.5 text-[13.5px] font-extrabold"><Layers size={15} />قیمت کل استایل</p>
            {onCanvas.length === 0 ? <p className="mt-2 text-[12px] text-[var(--kv-muted)]">آیتمی روی بوم نیست.</p> : (
              <ul className="mt-3 space-y-1.5 text-[12.5px]">
                {onCanvas.map((it) => { const p = byId.get(it.productId)!; return <li key={it.productId} className="flex justify-between gap-2"><span className="truncate">{p.name}{p.available < 1 && <span className="mr-1 text-[10.5px] text-[var(--kv-danger)]">(ناموجود)</span>}</span><span className="shrink-0 tabular-nums">{fmtMoney(rialToToman(p.priceRial))}</span></li>; })}
                <li className="flex justify-between border-t border-[var(--kv-line)] pt-2 font-extrabold"><span>جمع</span><span className="tabular-nums">{fmtMoney(bundle)}</span></li>
              </ul>
            )}
            <p className="mt-2 text-[11px] text-[var(--kv-muted)]">قیمت‌ها از موتور قیمت‌گذاری سرور است و هنگام افزودن به سبد دوباره بررسی می‌شود.</p>
            <Btn variant="accent" className="mt-3 w-full" disabled={!onCanvas.length || !!busy} icon={busy === "cart" ? <Loader2 size={15} className="animate-spin" /> : <ShoppingBag size={15} />} onClick={buyAll}>افزودن کل استایل به سبد</Btn>
            {validation && validation.purchasableCount < validation.total && (
              <div className="mt-3 space-y-2 rounded-[12px] border border-[var(--kv-warning)]/40 bg-[var(--kv-warning)]/[0.06] p-3" role="status">
                <p className="text-[12px] font-bold">{validation.message}</p>
                {validation.items.filter((i) => !i.purchasable).map((i) => (
                  <div key={i.productId} className="text-[11.5px] leading-6">
                    <p><b>{i.name}</b>: {i.reason}</p>
                    {i.alternatives.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{i.alternatives.map((a) => <button key={a.id} onClick={() => replace(i.productId, a)} className="rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 py-0.5 hover:border-[var(--kv-accent)]">جایگزین: {a.name}</button>)}</div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} max="max-w-[460px]" title="ذخیره استایل">
        <div className="space-y-4 pl-10">
          <p className="text-[17px] font-extrabold">ذخیره استایل</p>
          <Field label="نام استایل"><Input value={saveForm.name} onChange={(name) => setSaveForm({ ...saveForm, name })} /></Field>
          <div><p className="mb-2 text-[13px] font-semibold">حریم خصوصی</p>
            <Segmented<"private" | "unlisted" | "public"> options={[{ v: "private", label: "خصوصی" }, { v: "unlisted", label: "با لینک" }, { v: "public", label: "عمومی" }]} value={saveForm.privacy} onChange={(privacy) => setSaveForm({ ...saveForm, privacy })} /></div>
          <div className="flex flex-wrap gap-2">
            {loaded && <Btn variant="accent" disabled={busy === "save"} onClick={() => save("update")}>به‌روزرسانی (نسخه {fa(loaded.version + 1)})</Btn>}
            <Btn variant={loaded ? "soft" : "accent"} disabled={busy === "save"} icon={busy === "save" ? <Loader2 size={14} className="animate-spin" /> : undefined} onClick={() => save("new")}>{loaded ? "ذخیره به‌عنوان استایل جدید" : "ذخیره"}</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
