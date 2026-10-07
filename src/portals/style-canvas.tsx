import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine, Check, Layers, Minus, Plus, Trash2 } from "lucide-react";
import { fmtMoney, type Product } from "../data/catalog";
import { useStore } from "../data/store";
import { CutoutImg } from "./admin-product";
import { Card, Empty } from "../components/primitives";
import { outfitRoleOf, ROLE_LABEL } from "../data/styling";
import { cn } from "../utils/cn";

type Item = { id: string; x: number; y: number; scale: number; z: number };
export type CanvasItem = Item;
const DRAFT = "kolbe-canvas-v2";

/**
 * Style builder canvas — transparent PNG cutouts arranged freely on a dotted
 * canvas. The interaction contract is preserved (drag, keyboard move, scale,
 * layer order, remove; every removal has a non-drag path):
 *
 *  - **uncontrolled** (no `items`): owns its draft in sessionStorage exactly as
 *    before, including the two-piece starter look;
 *  - **controlled** (`items` + `onItemsChange`): the Shared Outfit State owns
 *    the composition and this component stays a pure view of it — wizard and
 *    canvas can never disagree.
 *
 * Proportion is portrait/editorial (aspect 3:4, responsive, clamped to the
 * viewport) instead of a wide dashboard board; the arrangement maths is all
 * percentage-based so the change is safe.
 *
 * Products whose background-cutout is not ready yet render as their framed
 * photograph — an honest fallback: the piece is still placeable, movable and
 * removable, and nothing pretends to be a cutout that does not exist.
 */
export function StyleCanvas({ items: controlled, onItemsChange, pickable }: {
  items?: Item[];
  onItemsChange?: (items: Item[]) => void;
  /**
   * Controlled mode only: the products the drawer offers for free placement.
   * When absent the drawer keeps its original behaviour (cutout-ready only).
   */
  pickable?: Product[];
}) {
  const { products } = useStore();
  const isControlled = Array.isArray(controlled);
  const ready = products.filter((p) => p.status === "published" && p.cutout?.status === "ready" && p.cutout.src);
  const [uncontrolledItems, setUncontrolledItems] = useState<Item[]>(() => {
    if (isControlled) return [];
    try { const v = JSON.parse(sessionStorage.getItem(DRAFT) || "null"); if (Array.isArray(v)) return v; } catch { /* ignore */ }
    return [];
  });
  const items = isControlled ? controlled! : uncontrolledItems;
  const [active, setActive] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => { if (!isControlled) sessionStorage.setItem(DRAFT, JSON.stringify(items)); }, [items, isControlled]);
  useEffect(() => {
    if (isControlled) return;
    if (!items.length && ready.length >= 2) setUncontrolledItems([{ id: ready[0].id, x: 34, y: 48, scale: 1, z: 1 }, { id: ready[1].id, x: 66, y: 52, scale: 0.9, z: 2 }]); /* starter look */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.length, isControlled]);

  /* every mutation goes through one gate so controlled/uncontrolled stay symmetric */
  const setList = (updater: (list: Item[]) => Item[]) => {
    if (isControlled) onItemsChange!(updater(items));
    else setUncontrolledItems((list) => updater(list));
  };

  const maxZ = Math.max(0, ...items.map((i) => i.z));
  const toggle = (id: string) => {
    if (items.some((i) => i.id === id)) { setList((list) => list.filter((i) => i.id !== id)); if (active === id) setActive(null); return; }
    const next = [...items, { id, x: 30 + ((items.length * 17) % 45), y: 45 + ((items.length * 9) % 15), scale: 1, z: maxZ + 1 }];
    setList(() => next);
    setActive(id);
  };
  const patch = (id: string, p: Partial<Item>) => setList((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));
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
  const cur = items.find((i) => i.id === active);
  const total = items.reduce((a, i) => a + (products.find((p) => p.id === i.id)?.retailPrice ?? 0), 0);

  /** the piece's product, or null when the id no longer exists in the catalogue */
  const productOf = (id: string): Product | undefined => products.find((x) => x.id === id);
  /** true when the transparent cutout exists; otherwise the framed photo fallback renders */
  const hasCutout = (p?: Product) => !!p?.cutout?.status && p.cutout.status === "ready" && !!p.cutout.src;
  /** controlled mode may widen the free-placement drawer to a supplied list */
  const drawerProducts = isControlled && pickable ? pickable : ready;

  return (
    <div className={cn("grid gap-5", isControlled
      ? "lg:grid-cols-[minmax(0,1fr)_220px] xl:grid-cols-[210px_minmax(0,1fr)_210px]"
      : "lg:grid-cols-[240px_minmax(0,1fr)_240px]")}>
      {/* product drawer */}
      <Card className={cn("h-fit p-4", isControlled && "hidden xl:block")}>
        <p className="mb-3 text-[13px] font-bold">{isControlled && pickable ? "افزودن آزاد به بوم" : "لباس‌های آماده استایل‌بیلدر"}</p>
        {drawerProducts.length === 0 ? <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">هنوز محصولی تصویر PNG استایل‌بیلدر ندارد.</p> : (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-2">
            {drawerProducts.map((p) => { const on = items.some((i) => i.id === p.id); const framed = !hasCutout(p); return (
              <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={on} title={p.name} className={cn("kv-dotted-light relative flex aspect-square items-center justify-center overflow-hidden rounded-[12px] border-2 p-2", on ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                {framed
                  ? <img src={p.images[0]} alt="" loading="lazy" className="h-full w-full rounded-[8px] object-cover" />
                  : <CutoutImg src={p.cutout!.src!} alt={p.name} className="max-h-full max-w-full object-contain" />}
                {on && <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--kv-accent)] text-white"><Check size={11} /></span>}
                <span className="absolute inset-x-1 bottom-1 truncate rounded-md bg-[var(--kv-surface)]/85 px-1 text-[10px] font-bold">{p.name}</span>
              </button>
            ); })}
          </div>
        )}
      </Card>

      {/* canvas — portrait/editorial: taller than wide, never a dashboard board */}
      <div ref={canvas} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        className="kv-dotted-light kv-sb-canvas relative aspect-[3/4] w-full touch-none select-none overflow-hidden rounded-[24px] border border-[var(--kv-line)] shadow-[var(--shadow-soft-md)]" aria-label="بوم استایل">
        {items.length === 0 && <div className="absolute inset-0 flex items-center justify-center p-6"><Empty title="بوم خالی است" desc="از فهرست کنار یا گام‌های راهنما، لباس‌ها را انتخاب کنید تا روی بوم قرار بگیرند." /></div>}
        {items.map((it) => { const p = productOf(it.id); if (!p) return null;
          const framed = !hasCutout(p);
          return (
            <div key={it.id} role="button" tabIndex={0} aria-label={`${p.name} (${ROLE_LABEL[outfitRoleOf(p)]})؛ برای جابه‌جایی بکشید یا از کلیدهای جهت استفاده کنید؛ حذف با کلید Delete`}
              onPointerDown={(e) => onDown(e, it)} onKeyDown={(e) => onKey(e, it)} onFocus={() => setActive(it.id)}
              className={cn("absolute outline-offset-4", framed ? "w-[46%] max-w-[300px]" : "w-[34%] max-w-[260px]", "cursor-grab active:cursor-grabbing", active === it.id && "outline outline-2 outline-dashed outline-[var(--kv-accent)]")}
              style={{ left: `${it.x}%`, top: `${it.y}%`, zIndex: it.z, transform: `translate(-50%, -50%) scale(${it.scale})` }}>
              {framed ? (
                <img src={p.images[0]} alt={p.name} draggable={false} className="pointer-events-none aspect-[3/4] w-full rounded-[14px] border-2 border-white/70 object-cover shadow-[0_18px_22px_rgba(27,42,74,0.22)]" />
              ) : (
                <CutoutImg src={p.cutout!.src!} alt={p.name} className="pointer-events-none w-full object-contain drop-shadow-[0_18px_22px_rgba(27,42,74,0.22)]" />
              )}
            </div>
          );
        })}
      </div>

      {/* layer controls */}
      <Card className="h-fit p-4">
        <p className="mb-3 flex items-center gap-1.5 text-[13px] font-bold"><Layers size={15} />لایه‌ها</p>
        {!items.length ? <p className="text-[12px] text-[var(--kv-muted)]">لایه‌ای ندارید.</p> : (
          <div className="space-y-1.5">{[...items].sort((a, b) => b.z - a.z).map((it) => { const p = productOf(it.id); if (!p) return null; return (
            <div key={it.id} className={cn("flex w-full items-center gap-2 rounded-[10px] border px-2 py-1.5", active === it.id ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)]")}>
              <button onClick={() => setActive(it.id)} className="flex min-w-0 flex-1 items-center gap-2 text-right">
                <span className="truncate text-[12px] font-bold">{p.name}</span>
                <span className="mr-auto shrink-0 text-[10.5px] text-[var(--kv-muted)]">{ROLE_LABEL[outfitRoleOf(p)]}</span>
              </button>
              <button onClick={() => toggle(it.id)} aria-label={`حذف ${p.name} از بوم`} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]"><Trash2 size={13} /></button>
            </div>
          ); })}</div>
        )}
        {cur && productOf(cur.id) && <div className="mt-4 space-y-2 border-t border-[var(--kv-line)] pt-3">
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
  );
}
