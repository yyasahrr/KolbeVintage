import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, Info, X } from "lucide-react";
import { cn } from "../utils/cn";

/* Global feedback layer (Req 270-272, 320-321): loading/success/error for every important action.
   One polite live region for screen readers; errors use role="alert". Respects reduced motion via CSS. */

type Tone = "success" | "error" | "info";
type ToastItem = { id: number; message: string; tone: Tone; action?: { label: string; onClick: () => void } };
type ToastApi = { push: (message: string, tone?: Tone, action?: ToastItem["action"]) => void; cartPulse: number; bumpCart: () => void };

const ToastContext = createContext<ToastApi>({ push: () => undefined, cartPulse: 0, bumpCart: () => undefined });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [cartPulse, setCartPulse] = useState(0);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback((message: string, tone: Tone = "success", action?: ToastItem["action"]) => {
    const id = ++seq.current;
    setItems((list) => [...list.slice(-2), { id, message, tone, action }]);
    window.setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3500);
  }, [dismiss]);
  const bumpCart = useCallback(() => setCartPulse((n) => n + 1), []);
  const api = useMemo(() => ({ push, cartPulse, bumpCart }), [push, cartPulse, bumpCart]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[120] flex flex-col items-center gap-2 px-4" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} role={t.tone === "error" ? "alert" : undefined}
            className={cn("kv-toast pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-[14px] border px-4 py-3 text-[13px] font-bold shadow-[var(--shadow-soft-lg)]",
              t.tone === "error" ? "border-[var(--kv-danger)]/40 bg-[var(--kv-surface)] text-[var(--kv-danger)]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] text-[var(--kv-ink)]")}>
            <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white",
              t.tone === "success" ? "bg-[var(--kv-success)]" : t.tone === "error" ? "bg-[var(--kv-danger)]" : "bg-[var(--kv-action)]")}>
              {t.tone === "success" ? <Check size={15} className="kv-check-pop" /> : t.tone === "error" ? <AlertCircle size={15} /> : <Info size={15} />}
            </span>
            <span className="min-w-0 flex-1 leading-6">{t.message}</span>
            {t.action && <button onClick={() => { t.action!.onClick(); dismiss(t.id); }} className="shrink-0 rounded-[9px] px-2 py-1 text-[12px] text-[var(--kv-accent)] hover:bg-[var(--kv-surface-2)]">{t.action.label}</button>}
            <button onClick={() => dismiss(t.id)} aria-label="بستن اعلان" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--kv-muted)] hover:bg-[var(--kv-surface-2)]"><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Button state machine for async actions: idle → loading → success/error (Req 271-272). */
export function useActionState() {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const run = useCallback(async <T,>(fn: () => Promise<T> | T): Promise<T | undefined> => {
    setState("loading");
    try {
      const result = await fn();
      setState("success");
      window.setTimeout(() => setState("idle"), 1400);
      return result;
    } catch (error) {
      setState("error");
      window.setTimeout(() => setState("idle"), 2200);
      throw error;
    }
  }, []);
  return { state, run };
}
