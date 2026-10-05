import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ShoppingBag, X } from "lucide-react";

export type CartToastInput = { image?: string; name: string; meta?: string };
type CartToastItem = CartToastInput & { id: number; leaving?: boolean };

const ToastCtx = createContext<(toast: CartToastInput) => void>(() => {});

/** Fires the storefront "added to bag" confirmation. The cart itself stays owned by
    the store state — this only announces what already happened. */
export const useCartToast = () => useContext(ToastCtx);

const AUTO_DISMISS = 4200;
const LEAVE_MS = 200;

export function CartToastProvider({ children, onViewCart }: { children: ReactNode; onViewCart: () => void }) {
  const [items, setItems] = useState<CartToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    timers.current.push(window.setTimeout(
      () => setItems((list) => list.filter((item) => item.id !== id)), LEAVE_MS));
  }, []);

  const push = useCallback((toast: CartToastInput) => {
    const id = ++seq.current;
    // one confirmation at a time keeps the surface calm when several adds land quickly
    setItems([{ ...toast, id }]);
    timers.current.push(window.setTimeout(() => dismiss(id), AUTO_DISMISS));
  }, [dismiss]);

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="kv-sf-toasts" role="status" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} className="kv-sf-toast kv-liquid" data-leaving={item.leaving ? "true" : "false"}>
            <span className="relative block h-12 w-11 shrink-0 overflow-hidden rounded-[10px] bg-[var(--kvaf-sand)]">
              {item.image
                ? <img src={item.image} alt="" className="h-full w-full object-cover" />
                : <span className="flex h-full w-full items-center justify-center"><ShoppingBag size={16} className="text-[var(--kvaf-muted)]" /></span>}
              <span className="absolute -bottom-1 -left-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--kvaf-success)] text-white ring-2 ring-[var(--kvaf-surface)]">
                <Check size={12} strokeWidth={3} />
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-extrabold text-[var(--kvaf-ink)]">به سبد اضافه شد</p>
              <p className="truncate text-[12px] text-[var(--kvaf-muted)]">
                {item.name}{item.meta ? ` · ${item.meta}` : ""}
              </p>
            </div>
            <button
              onClick={() => { dismiss(item.id); onViewCart(); }}
              className="kv-sf-press shrink-0 rounded-[10px] px-3 py-2 text-[12.5px] font-bold text-[var(--kvaf-ink)] hover:bg-[rgba(28,28,25,0.06)]"
            >
              مشاهده سبد
            </button>
            <button
              onClick={() => dismiss(item.id)} aria-label="بستن پیام"
              className="kv-sf-press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--kvaf-muted)] hover:bg-[rgba(28,28,25,0.06)]"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- cart count badge ----------
   The number is derived from cart state by the caller; only the paint animates,
   and it handles 1 / 9 / 10 / 99+ without changing the badge box. */
export function CartCountBadge({ count }: { count: number }) {
  const [bump, setBump] = useState(false);
  const previous = useRef(count);

  useEffect(() => {
    const grew = count > previous.current;
    previous.current = count;
    if (!grew) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setBump(true);
    const t = window.setTimeout(() => setBump(false), 500);
    return () => window.clearTimeout(t);
  }, [count]);

  if (count < 1) return null;
  return (
    <span className="kv-sf-badge" data-bump={bump ? "true" : undefined} aria-hidden="true">
      {count > 99 ? "۹۹+" : count.toLocaleString("fa-IR")}
    </span>
  );
}
