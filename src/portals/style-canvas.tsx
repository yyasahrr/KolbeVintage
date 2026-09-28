import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Check, Layers, Minus, Plus, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import { fmtMoney } from "../data/catalog";
import { useStore } from "../data/store";
import { CutoutImg } from "./admin-product";
import { Btn, Card, Empty } from "../components/primitives";
import { cn } from "../utils/cn";

type Item = { id: string; x: number; y: number; scale: number; z: number };
const DRAFT = "kolbe-canvas-v2";

/* Style builder: transparent PNG cutouts arranged freely on a dotted canvas */
export function StyleCanvas({ accountId, onLogin }: { accountId?: string; onLogin: () => void }) {
  const { products, saveStyle } = useStore();
  const ready = products.filter((p) => p.status === "published" && p.cutout?.status === "ready" && p.cutout.src);
  const [items, setItems] = useState<Item[]>(() => {
    try { const v = JSON.parse(sessionStorage.getItem(DRAFT) || "null"); if (Array.isArray(v)) return v; } catch { /* ignore */ }
    return [];
  });
  const [active, setActive] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  useEffect(() => { sessionStorage.setItem(DRAFT, JSON.stringify(items)); }, [items]);
  useEffect(() => { if (!items.length && ready.length >= 2) setItems([{ id: ready[0].id, x: 34, y: 48, scale: 1, z: 1 }, { id: ready[1].id, x: 66, y: 52, scale: 0.9, z: 2 }]); /* starter look */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.length]);

  const maxZ = Math.max(0, ...items.map((i) => i.z));
  const toggle = (id: string) => {
    if (items.some((i) => i.id === id)) { setItems(items.filter((i) => i.id !== id)); if (active === id) setActive(null); return; }
    setItems([...items, { id, x: 30 + ((items.length * 17) % 45), y: 45 + ((items.length * 9) % 15), scale: 1, z: maxZ + 1 }]);
    setActive(id);
  };
  const patch = (id: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));
  const onDown = (e: React.PointerEvent, it: Item) => {
    const rect = canvas.current?.getBoundingClientRect(); if (!rect) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: it.id, dx: ((e.clientX - rect.left) / rect.width) * 100 - it.x, dy: ((e.clientY - rect.top) / rect.height) * 100 - it.y };
    setActive(it.id); patch(it.id, { z: maxZ + 1 });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; const rect = canvas.current?.getBoundingClientRect(); if (!d || !rect) return;
    const x = Math.min(92, Math.max(8, ((e.clientX - rect.left) / rect.width) * 100 - d.dx));
    const y = Math.min(90, Math.max(10, ((e.clientY - rect.top) / rect.height) * 100 - d.dy));
    patch(d.id, { x, y });
  };
  const onKey = (e: React.KeyboardEvent, it: Item) => {
    const step = e.shiftKey ? 5 : 1.5;
    const map: Record<string, Partial<Item>> = { ArrowLeft: { x: Math.max(8, it.x - step) }, ArrowRight: { x: Math.min(92, it.x + step) }, ArrowUp: { y: Math.max(10, it.y - step) }, ArrowDown: { y: Math.min(90, it.y + step) }, "+": { scale: Math.min(1.8, it.scale + 0.1) }, "-": { scale: Math.max(0.4, it.scale - 0.1) } };
    if (map[e.key]) { e.preventDefault(); patch(it.id, map[e.key]); }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); toggle(it.id); }
  };
  const save = () => {
    if (!items.length) return;
    if (!accountId) { onLogin(); return; }
    saveStyle(accountId, [...items].sort((a, b) => a.z - b.z).map((i) => i.id), `استایل ${new Date().toLocaleDateString("fa-IR")}`);
    setSaved(true); window.setTimeout(() => setSaved(false), 3000);
  };
  const cur = items.find((i) => i.id === active);
  const total = items.reduce((a, i) => a + (products.find((p) => p.id === i.id)?.retailPrice ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Sparkles size={14} />ساخت استایل</p>
          <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">لباس‌ها را روی بوم بچین</h1>
          <p className="mt-1 text-[13px] text-[var(--kv-muted)]">بکشید و رها کنید؛ با کلیدهای جهت جابه‌جا و با + و − بزرگ و کوچک کنید.</p>
        </div>
        <div className="flex gap-2">
          <Btn variant="soft" size="sm" icon={<RotateCcw size={15} />} disabled={!items.length} onClick={() => { setItems([]); setActive(null); }}>پاک‌سازی بوم</Btn>
          <Btn variant="accent" size="sm" icon={<Save size={15} />} disabled={!items.length} onClick={save}>{accountId ? "ذخیره در حساب من" : "ورود و ذخیره"}</Btn>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)_240px]">
        <Card className="h-fit p-4">
          <p className="mb-3 text-[13px] font-bold">لباس‌های آماده استایل‌بیلدر</p>
          {ready.length === 0 ? <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">هنوز محصولی تصویر PNG استایل‌بیلدر ندارد.</p> : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-2">
              {ready.map((p) => { const on = items.some((i) => i.id === p.id); return (
                <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={on} className={cn("kv-dotted-light relative flex aspect-square items-center justify-center overflow-hidden rounded-[12px] border-2 p-2", on ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                  <CutoutImg src={p.cutout!.src!} alt={p.name} className="max-h-full max-w-full object-contain" />
                  {on && <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--kv-accent)] text-white"><Check size={11} /></span>}
                  <span className="absolute inset-x-1 bottom-1 truncate rounded-md bg-[var(--kv-surface)]/85 px-1 text-[10px] font-bold">{p.name}</span>
                </button>
              ); })}
            </div>
          )}
        </Card>

        <div ref={canvas} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          className="kv-dotted-light relative min-h-[520px] touch-none select-none overflow-hidden rounded-[24px] border border-[var(--kv-line)] shadow-[var(--shadow-soft-md)]" aria-label="بوم استایل">
          {items.length === 0 && <div className="absolute inset-0 flex items-center justify-center p-6"><Empty title="بوم خالی است" desc="از فهرست کنار، لباس‌ها را انتخاب کنید تا روی بوم قرار بگیرند." /></div>}
          {items.map((it) => { const p = products.find((x) => x.id === it.id); if (!p?.cutout?.src) return null; return (
            <div key={it.id} role="button" tabIndex={0} aria-label={`${p.name}؛ برای جابه‌جایی بکشید یا از کلیدهای جهت استفاده کنید`}
              onPointerDown={(e) => onDown(e, it)} onKeyDown={(e) => onKey(e, it)} onFocus={() => setActive(it.id)}
              className={cn("absolute w-[34%] max-w-[260px] cursor-grab active:cursor-grabbing outline-offset-4", active === it.id && "outline outline-2 outline-dashed outline-[var(--kv-accent)]")}
              style={{ left: `${it.x}%`, top: `${it.y}%`, zIndex: it.z, transform: `translate(-50%, -50%) scale(${it.scale})` }}>
              <CutoutImg src={p.cutout.src} alt={p.name} className="pointer-events-none w-full object-contain drop-shadow-[0_18px_22px_rgba(27,42,74,0.22)]" />
            </div>
          ); })}
          {saved && <div role="status" className="kv-glass absolute right-4 top-4 z-[999] flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[13px] font-bold"><Check size={15} className="text-[var(--kv-success)]" />استایل در حساب شما ذخیره شد</div>}
        </div>

        <Card className="h-fit p-4">
          <p className="mb-3 flex items-center gap-1.5 text-[13px] font-bold"><Layers size={15} />لایه‌ها</p>
          {!items.length ? <p className="text-[12px] text-[var(--kv-muted)]">لایه‌ای ندارید.</p> : (
            <div className="space-y-1.5">{[...items].sort((a, b) => b.z - a.z).map((it) => { const p = products.find((x) => x.id === it.id); return (
              <button key={it.id} onClick={() => setActive(it.id)} className={cn("flex w-full items-center gap-2 rounded-[10px] border px-2 py-1.5 text-right", active === it.id ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)]")}>
                <span className="truncate text-[12px] font-bold">{p?.name}</span><span className="mr-auto text-[11px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(p?.retailPrice ?? 0)}</span>
              </button>
            ); })}</div>
          )}
          {cur && <div className="mt-4 space-y-2 border-t border-[var(--kv-line)] pt-3">
            <p className="text-[12px] font-bold">لایه انتخاب‌شده</p>
            <div className="flex items-center gap-1"><button aria-label="کوچک‌تر" onClick={() => patch(cur.id, { scale: Math.max(0.4, cur.scale - 0.1) })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><Minus size={14} /></button><span className="flex-1 text-center text-[12px] tabular-nums">{Math.round(cur.scale * 100).toLocaleString("fa-IR")}٪</span><button aria-label="بزرگ‌تر" onClick={() => patch(cur.id, { scale: Math.min(1.8, cur.scale + 0.1) })} className="flex h-10 w-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><Plus size={14} /></button></div>
            <div className="grid grid-cols-3 gap-1">
              <button aria-label="آوردن به جلو" onClick={() => patch(cur.id, { z: maxZ + 1 })} className="flex h-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><ArrowUpToLine size={14} /></button>
              <button aria-label="بردن به عقب" onClick={() => patch(cur.id, { z: Math.min(...items.map((i) => i.z)) - 1 })} className="flex h-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)]"><ArrowDownToLine size={14} /></button>
              <button aria-label="حذف از بوم" onClick={() => toggle(cur.id)} className="flex h-10 items-center justify-center rounded-[9px] border border-[var(--kv-line)] text-[var(--kv-danger)]"><Trash2 size={14} /></button>
            </div>
          </div>}
          {items.length > 0 && <p className="mt-4 border-t border-[var(--kv-line)] pt-3 text-[12px] text-[var(--kv-muted)]">قیمت کل این استایل: <b className="text-[var(--kv-ink)] tabular-nums">{fmtMoney(total)}</b></p>}
        </Card>
      </div>
    </div>
  );
}
