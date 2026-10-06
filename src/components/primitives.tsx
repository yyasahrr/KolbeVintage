import { ReactNode, useId, useEffect, useState } from "react";
import { Check, ChevronLeft, ImageOff, Minus, Plus, Search, X } from "lucide-react";
import { cn } from "../utils/cn";
import { useDialogFocus } from "./focus-trap";

/* ---------- Button ---------- */
export function Btn({
  children, variant = "primary", size = "md", className, icon, onClick, disabled,
}: {
  children: ReactNode; variant?: "primary" | "accent" | "soft" | "ghost" | "outline" | "dark";
  size?: "sm" | "md" | "lg"; className?: string; icon?: ReactNode; onClick?: () => void; disabled?: boolean;
}) {
  const styles: Record<string, string> = {
    primary: "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527] hover:opacity-90 shadow-[var(--shadow-soft-sm)]",
    accent: "bg-[var(--kv-accent)] text-white hover:bg-[var(--kv-accent)]/90 shadow-[var(--shadow-soft-sm)]",
    soft: "bg-[var(--kv-surface-2)] text-[var(--kv-ink)] border border-[var(--kv-line)] hover:bg-[var(--kv-surface-3)]",
    ghost: "text-[var(--kv-ink)] hover:bg-[var(--kv-surface-2)]",
    outline: "border border-[var(--kv-line-strong)] text-[var(--kv-ink)] hover:bg-[var(--kv-surface-2)]",
    dark: "bg-[#1B2A4A] text-[#FAF6EF] hover:bg-[#2C3D63] dark:bg-[#E8D9C3] dark:text-[#0E1527]",
  };
  const sizes: Record<string, string> = {
    sm: "h-10 px-3.5 text-[13px] gap-1.5",
    md: "h-11 px-5 text-sm gap-2",
    lg: "h-[52px] px-7 text-[15px] gap-2.5",
  };
  return (
    <button
      onClick={onClick} disabled={disabled}
      className={cn(
        "kv-press inline-flex items-center justify-center rounded-[11px] font-semibold whitespace-nowrap transition-all disabled:opacity-45 disabled:pointer-events-none",
        styles[variant], sizes[size], className
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/* ---------- Badge / Status ---------- */
const statusColor: Record<string, string> = {
  "فعال": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "در انتظار": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "تأیید شد": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "پرداخت شد": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "تحویل شد": "bg-[#E2E9F2] text-[#33415F] dark:bg-[#33415F]/30 dark:text-[#B9C4D8]",
  "ارسال شد": "bg-[#E6EFFA] text-[#2F5A9E] dark:bg-[#2F5A9E]/25 dark:text-[#8FB4EA]",
  "در حال آماده‌سازی": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "در حال بررسی": "bg-[#E6EFFA] text-[#2F5A9E] dark:bg-[#2F5A9E]/25 dark:text-[#8FB4EA]",
  "پیش‌فاکتور شد": "bg-[#EDE4F5] text-[#5E4A8A] dark:bg-[#5E4A8A]/25 dark:text-[#B9A8E0]",
  "رد شد": "bg-[#F6DFD9] text-[#8A3B30] dark:bg-[#A8483C]/20 dark:text-[#D07A6A]",
  "مرجوعی": "bg-[#F6DFD9] text-[#8A3B30] dark:bg-[#A8483C]/20 dark:text-[#D07A6A]",
  "در انتظار پرداخت": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "در انتظار تأیید": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "موجودی محدود": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "جدید": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "پرفروش": "bg-[var(--kv-accent)]/12 text-[var(--kv-accent)]",
  "اقتصادی": "bg-[#E2E9F2] text-[#33415F] dark:bg-[#33415F]/30 dark:text-[#B9C4D8]",
  "کالکشن ویژه": "bg-[#1B2A4A] text-[#E8D9C3] dark:bg-[#E8D9C3] dark:text-[#0E1527]",
  "در انتظار تأیید تأمین‌کننده": "bg-[#F6EBD3] text-[#8A6420] dark:bg-[#B98A2F]/20 dark:text-[#D6A94E]",
  "تأیید شد · در انتظار پرداخت": "bg-[#E6EFFA] text-[#2F5A9E] dark:bg-[#2F5A9E]/25 dark:text-[#8FB4EA]",
  "لغو شد": "bg-[#F6DFD9] text-[#8A3B30] dark:bg-[#A8483C]/20 dark:text-[#D07A6A]",
  "مسدود": "bg-[#F6DFD9] text-[#8A3B30] dark:bg-[#A8483C]/20 dark:text-[#D07A6A]",
  "منتشر": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "متصل": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "وفادار": "bg-[#E7F0E6] text-[#3E6B4A] dark:bg-[#3E6B4A]/20 dark:text-[#7FB08C]",
  "پرخرج": "bg-[#EDE4F5] text-[#5E4A8A] dark:bg-[#5E4A8A]/25 dark:text-[#B9A8E0]",
  "در خطر ریزش": "bg-[#F6DFD9] text-[#8A3B30] dark:bg-[#A8483C]/20 dark:text-[#D07A6A]",
  "پیش‌نویس": "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]",
  "قطع": "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]",
};

export function Status({ value, dot = true }: { value: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold whitespace-nowrap", statusColor[value] ?? "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {value}
    </span>
  );
}

export function Tag({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "kv-press min-h-10 rounded-full border px-4 py-2 text-[13px] font-medium transition-all whitespace-nowrap",
        active
          ? "bg-[var(--kv-accent)] border-[var(--kv-accent)] text-white shadow-[var(--shadow-soft-sm)]"
          : "border-[var(--kv-line)] bg-[var(--kv-surface)] text-[var(--kv-ink-2)] hover:border-[var(--kv-line-strong)]"
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Inputs ---------- */
export function Field({ label, children, hint, required }: { label: string; children: ReactNode; hint?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--kv-ink-2)]">
        <span>{label}</span>
        {/* §27: mandatory fields are visible up-front, not discovered by failing to save. */}
        {required && <span className="rounded-full bg-[var(--kv-danger)]/10 px-1.5 py-0.5 text-[9.5px] font-extrabold text-[var(--kv-danger)]">الزامی</span>}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-[var(--kv-muted)]">{hint}</span>}
    </label>
  );
}

/**
 * Shared text input. `inputMode`/`autoComplete`/`dir` exist because the locked auth surface needs
 * real mobile keyboards (`tel`/`numeric`), OTP autofill (`one-time-code`), password-manager
 * compatibility (`username`/`current-password`/`new-password`) and LTR digits inside an RTL page.
 */
export function Input({ placeholder, value, onChange, icon, className, type = "text", ariaLabel, inputMode,
  autoComplete, dir, name, autoFocus, maxLength }: {
    placeholder?: string; value?: string; onChange?: (v: string) => void; icon?: ReactNode; className?: string;
    type?: string; ariaLabel?: string; inputMode?: "text" | "tel" | "email" | "numeric" | "decimal" | "search" | "url";
    autoComplete?: string; dir?: "ltr" | "rtl" | "auto"; name?: string; autoFocus?: boolean; maxLength?: number;
  }) {
  return (
    <div className={cn("relative", className)}>
      {icon && <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--kv-faint)]">{icon}</span>}
      <input type={type} aria-label={ariaLabel} inputMode={inputMode} autoComplete={autoComplete} dir={dir}
        name={name} autoFocus={autoFocus} maxLength={maxLength}
        // `undefined` keeps the field uncontrolled; a null value made React warn on every render.
        value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder}
        className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-sm text-[var(--kv-ink)] outline-none transition-all placeholder:text-[var(--kv-faint)] focus:border-[var(--kv-accent)] focus:ring-2 focus:ring-[var(--kv-accent)]/15"
        style={icon ? { paddingRight: 42 } : undefined}
      />
    </div>
  );
}

export function SearchBox({ placeholder = "جست‌وجو…", value, onChange }: { placeholder?: string; value?: string; onChange?: (v: string) => void }) {
  return <Input placeholder={placeholder} value={value} onChange={onChange} icon={<Search size={17} />} />;
}

export function Select({ options, value, onChange, className, labels }: { options: string[]; value?: string; onChange?: (v: string) => void; className?: string; labels?: Record<string, string> }) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value} onChange={(e) => onChange?.(e.target.value)}
        className="h-11 w-full appearance-none rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 pl-9 text-sm font-medium text-[var(--kv-ink)] outline-none transition-all focus:border-[var(--kv-accent)] cursor-pointer"
      >
        {options.map((o) => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
      <ChevronLeft size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 rotate-[-90deg] text-[var(--kv-faint)]" />
    </div>
  );
}

export function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      onClick={onToggle} role="switch" aria-checked={on} aria-label={label}
      className={cn("relative h-6 w-11 rounded-full transition-colors", on ? "bg-[var(--kv-success)]" : "bg-[var(--kv-surface-3)]")}
    >
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "right-[22px]" : "right-0.5")} />
    </button>
  );
}

/** §14: a switch with a real 44px-tall hit area, a business label and a hint — the whole row
 *  toggles, and the label is clickable, so the operator never has to hit a 24px pill. */
export function SwitchRow({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => onChange(!on)}
      className="flex w-full min-h-11 items-center justify-between gap-3 rounded-[12px] border border-[var(--kv-line)] px-3 py-2 text-right transition-colors hover:bg-[var(--kv-surface-2)] disabled:opacity-60">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-bold">{label}</span>
        {hint && <span className="mt-0.5 block text-[10.5px] leading-4 text-[var(--kv-muted)]">{hint}</span>}
      </span>
      <span className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", on ? "bg-[var(--kv-success)]" : "bg-[var(--kv-surface-3)]")}>
        <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "right-[22px]" : "right-0.5")} />
      </span>
    </button>
  );
}

/** §15: a deliberate product-image placeholder — never a browser broken-image glyph.
 *  The element keeps its caller-provided size/aspect class in both states, so a missing or
 *  unreachable file can never distort a product row or a media grid. */
export function SafeImg({ src, alt, className, fallbackClassName }: { src?: string | null; alt: string; className?: string; fallbackClassName?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [src]);
  if (broken || !src) {
    return (
      <span role="img" aria-label={`${alt} — تصویر در دسترس نیست`}
        className={cn("flex items-center justify-center bg-[var(--kv-surface-2)] text-[var(--kv-faint)]", className, fallbackClassName)}>
        <ImageOff size={16} />
      </span>
    );
  }
  return <img src={src} alt={alt} className={className} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
}

export function Stepper({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-1">
      <button onClick={() => onChange(value + 1)} className="kv-press flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]" aria-label="افزایش"><Plus size={15} /></button>
      <span className="min-w-10 text-center text-[15px] font-bold tabular-nums">{value.toLocaleString("fa-IR")}</span>
      <button onClick={() => onChange(Math.max(min, value - 1))} className="kv-press flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]" aria-label="کاهش"><Minus size={15} /></button>
    </div>
  );
}

export function Swatch({ hex, name, selected, onSelect, size = "md" }: { hex: string; name: string; selected?: boolean; onSelect?: () => void; size?: "sm" | "md" }) {
  const s = size === "sm" ? "h-5 w-5" : "h-8 w-8";
  return (
    <button
      onClick={onSelect} title={name} aria-label={name} aria-pressed={selected}
      className={cn(
        "kv-press relative rounded-full border transition-all",
        s, selected ? "border-[var(--kv-accent)] ring-2 ring-[var(--kv-accent)]/30 ring-offset-2 ring-offset-[var(--kv-surface)]" : "border-black/15 dark:border-white/20 hover:scale-110"
      )}
      style={{ background: hex }}
    >
      {selected && <Check size={size === "sm" ? 10 : 14} className="absolute inset-0 m-auto" style={{ color: hex === "#FFFFFF" || hex === "#EDE3D0" ? "#1B2A4A" : "#fff" }} />}
    </button>
  );
}

/* ---------- Surfaces ---------- */
export function Card({ children, className, hover }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div className={cn("rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm", hover && "kv-card-hover", className)}>
      {children}
    </div>
  );
}

export function SectionHead({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h2 className="kv-editorial-title text-[22px] md:text-[26px]">{title}</h2>
        {desc && <p className="mt-1.5 max-w-[60ch] text-sm leading-7 text-[var(--kv-muted)]">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

/* ---------- Feedback ---------- */
export function Empty({ title, desc, action }: { title: string; desc: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-surface)]/60 px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--kv-surface-2)] text-[var(--kv-muted)]">
        <Search size={20} />
      </div>
      <p className="text-[15px] font-bold">{title}</p>
      <p className="mt-1.5 max-w-[38ch] text-[13px] leading-6 text-[var(--kv-muted)]">{desc}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-[var(--kv-surface-2)]", className)} />;
}

/* ---------- Overlays ---------- */
export function Drawer({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useDialogFocus<HTMLElement>(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-[#0E1527]/45 backdrop-blur-[2px] animate-[fadeIn_0.25s_ease]" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn("absolute left-0 top-0 flex h-full flex-col bg-[var(--kv-surface)] shadow-[var(--shadow-soft-lg)] animate-[drawerIn_0.3s_cubic-bezier(0.22,1,0.36,1)]", wide ? "w-full max-w-[560px]" : "w-full max-w-[420px]")}>
        <div className="flex items-center justify-between border-b border-[var(--kv-line)] px-6 py-4">
          <h3 id={titleId} className="text-[16px] font-bold">{title}</h3>
          <button data-autofocus onClick={onClose} className="kv-press flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]" aria-label="بستن"><X size={18} /></button>
        </div>
        <div className="kv-scroll flex-1 overflow-y-auto p-6">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({ open, onClose, children, max = "max-w-[560px]", title = "پنجره" }: { open: boolean; onClose: () => void; children: ReactNode; max?: string; title?: string }) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0E1527]/50 backdrop-blur-[3px] animate-[fadeIn_0.25s_ease]" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cn("relative w-full rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-7 shadow-[var(--shadow-soft-lg)] animate-[scaleIn_0.28s_cubic-bezier(0.22,1,0.36,1)]", max)}>
        <button data-autofocus onClick={onClose} className="kv-press absolute left-5 top-5 flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]" aria-label="بستن"><X size={18} /></button>
        {children}
      </div>
    </div>
  );
}

/** §60: LARGE operational editors live in a centered workspace modal — ~90vw (max 1360px) × ~90vh,
 *  fixed header, scrollable body, full-screen on mobile. Right-side drawers are forbidden for these. */
export function WorkspaceModal({ open, onClose, title, subtitle, children, footer }: {
  open: boolean; onClose: () => void; title: string; subtitle?: string; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-[#0E1527]/55 backdrop-blur-[3px] animate-[fadeIn_0.25s_ease]" onClick={onClose} aria-hidden="true" />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}
        className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--kv-surface)] shadow-[var(--shadow-soft-lg)] animate-[scaleIn_0.28s_cubic-bezier(0.22,1,0.36,1)] sm:h-[90vh] sm:w-[90vw] sm:max-w-[1360px] sm:rounded-[24px] sm:border sm:border-[var(--kv-line)]">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--kv-line)] px-5 py-4">
          <div>
            <h2 className="text-sm font-bold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11.5px] leading-5 text-[var(--kv-muted)]">{subtitle}</p>}
          </div>
          <button data-autofocus onClick={onClose} className="kv-press flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]" aria-label="بستن"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="shrink-0 border-t border-[var(--kv-line)] px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Full-screen media viewer with the same dialog focus rules (trap, Escape, restore); arrow keys via onKey. */
export function Lightbox({ open, onClose, label, children, onKey, caption, z = "z-[80]" }: { open: boolean; onClose: () => void; label: string; children: ReactNode;
  onKey?: (event: KeyboardEvent) => void; caption?: ReactNode; z?: string }) {
  const ref = useDialogFocus<HTMLDivElement>(open, onClose, { onKey });
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={cn("fixed inset-0 flex items-center justify-center bg-black/85 p-4", z)} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="contents">{children}</div>
      <button data-autofocus onClick={onClose} aria-label="بستن" className="absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white focus-visible:outline-2 focus-visible:outline-white"><X size={20} /></button>
      {caption && <p className="absolute bottom-4 text-[12px] text-white/80" aria-live="polite">{caption}</p>}
    </div>
  );
}

/* ---------- Segmented ---------- */
export function Segmented<T extends string>({ options, value, onChange }: { options: { v: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    /* max-w-full + flex-wrap: روی موبایل (۳۶۰px) تب‌ها می‌شکنند و از صفحه بیرون نمی‌زنند (§40) */
    <div className="inline-flex max-w-full flex-wrap rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/70 p-1">
      {options.map((o) => (
        <button
          key={o.v} onClick={() => onChange(o.v)}
          className={cn(
            "kv-press rounded-full px-4 py-1.5 text-[13px] font-semibold transition-all whitespace-nowrap",
            value === o.v ? "bg-[var(--kv-surface)] text-[var(--kv-ink)] shadow-[var(--shadow-soft-sm)] border border-[var(--kv-line)]" : "text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Timeline ---------- */
export function Timeline({ items }: { items: { t: string; d: string; time: string; done?: boolean }[] }) {
  return (
    <ol className="relative space-y-5 pr-1">
      {items.map((it, i) => (
        <li key={i} className="relative flex gap-3 pr-6">
          <span className={cn("absolute right-0 top-1.5 h-2.5 w-2.5 rounded-full", it.done ? "bg-[var(--kv-success)]" : "bg-[var(--kv-surface-3)] ring-2 ring-[var(--kv-surface-2)]")} />
          {i < items.length - 1 && <span className="absolute right-[4px] top-5 h-[calc(100%-8px)] w-px bg-[var(--kv-line)]" />}
          <div>
            <p className="text-[13.5px] font-bold">{it.t}</p>
            <p className="mt-0.5 text-xs leading-5 text-[var(--kv-muted)]">{it.d}</p>
            <p className="mt-1 text-[11px] text-[var(--kv-faint)]">{it.time}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Textarea({ placeholder, value, onChange, rows = 3 }: { placeholder?: string; value?: string; onChange?: (v: string) => void; rows?: number }) {
  return (
    <textarea
      rows={rows} value={value ?? ""} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder}
      className="w-full resize-y rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3 text-sm leading-6 text-[var(--kv-ink)] outline-none transition-all placeholder:text-[var(--kv-faint)] focus:border-[var(--kv-accent)] focus:ring-2 focus:ring-[var(--kv-accent)]/15"
    />
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#C1613B]" />
      {label}
    </label>
  );
}

/* ---------- Server-state helpers: Loading / Error / Empty / Permission ---------- */
export function LoadingState({ label = "در حال بارگذاری…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-6 py-10 text-center animate-[fadeIn_0.3s_ease]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--kv-line-strong)] border-t-[var(--kv-accent)]" aria-label="loading" />
      <p className="mt-3 text-[13px] font-medium text-[var(--kv-muted)]">{label}</p>
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[16px] border border-[var(--kv-danger)]/20 bg-[var(--kv-danger)]/[0.04] px-6 py-10 text-center">
      <p className="text-[13px] font-bold text-[var(--kv-danger)]">خطا در بارگذاری</p>
      <p className="mt-1.5 max-w-[40ch] text-[12.5px] leading-6 text-[var(--kv-muted)]">{message}</p>
      {onRetry && <Btn variant="soft" size="sm" className="mt-4" onClick={onRetry}>تلاش دوباره</Btn>}
    </div>
  );
}
export function PermissionDenied({ message = "دسترسی لازم را ندارید." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-surface)] px-6 py-10 text-center">
      <p className="text-[14px] font-bold">دسترسی محدود</p>
      <p className="mt-1.5 text-[12.5px] text-[var(--kv-muted)]">{message}</p>
    </div>
  );
}
