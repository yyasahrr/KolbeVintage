import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "../utils/cn";
import {
  JALALI_MONTHS, JALALI_WEEKDAYS, daysInJalaliMonth, formatPersianDate, fromJalali, jalaliWeekday,
  parseIso, persianInputToIso, toJalali,
} from "../data/persian-date";

/**
 * Jalali date picker for admin forms.
 *
 * - `value` / `onChange` are ISO-8601 Gregorian instants (the only thing ever sent to the API).
 * - The UI shows and accepts Jalali dates with Persian digits.
 * - `withTime` adds an hour/minute stepper that keeps the stored instant in sync.
 * Conversion lives entirely in `src/data/persian-date.ts`.
 */
export function PersianDatePicker({
  value, onChange, label, hint, withTime = false, clearable = true, placeholder = "۱۴۰۵/۰۷/۱۳", minIso, className,
}: {
  value: string | null;
  onChange: (iso: string | null) => void;
  label?: string;
  hint?: string;
  withTime?: boolean;
  clearable?: boolean;
  placeholder?: string;
  minIso?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value ? formatPersianDate(value) : "");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setText(value ? formatPersianDate(value) : ""); }, [value]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const cursor = useMemo(() => {
    if (value) return toJalali(parseIso(value));
    const today = toJalali(new Date());
    return today;
  }, [value]);
  const [view, setView] = useState({ jy: cursor.jy, jm: cursor.jm });
  useEffect(() => { setView({ jy: cursor.jy, jm: cursor.jm }); }, [cursor.jy, cursor.jm]);

  const selected = value ? toJalali(parseIso(value)) : null;
  const today = toJalali(new Date());
  const digits = (n: number) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

  const commit = (jy: number, jm: number, jd: number) => {
    const { gy, gm, gd } = fromJalali({ jy, jm, jd });
    const previous = value ? parseIso(value) : null;
    const next = new Date(gy, gm - 1, gd, previous?.getHours() ?? 9, previous?.getMinutes() ?? 0, 0, 0);
    onChange(next.toISOString());
  };

  const setTimePart = (hours: number, minutes: number) => {
    const base = value ? parseIso(value) : new Date();
    base.setHours(hours, minutes, 0, 0);
    onChange(base.toISOString());
  };

  const shiftMonth = (delta: number) => {
    let jm = view.jm + delta;
    let jy = view.jy;
    if (jm < 1) { jm = 12; jy -= 1; }
    if (jm > 12) { jm = 1; jy += 1; }
    setView({ jy, jm });
  };

  const days = daysInJalaliMonth(view.jy, view.jm);
  const lead = jalaliWeekday(view.jy, view.jm, 1); // 0 = شنبه
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const time = value ? parseIso(value) : null;

  return (
    <div className={cn("relative", className)} ref={wrapRef}>
      {label && <span className="mb-2 block text-[13px] font-semibold text-[var(--kv-ink-2)]">{label}</span>}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            inputMode="numeric"
            dir="ltr"
            value={text}
            placeholder={placeholder}
            aria-label={label ?? "تاریخ"}
            onChange={(event) => {
              setText(event.target.value);
              const iso = persianInputToIso(event.target.value);
              if (iso) onChange(iso);
            }}
            onFocus={() => setOpen(true)}
            className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 pl-9 text-center tabular-nums focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]"
          />
          <button type="button" onClick={() => setOpen((o) => !o)} aria-label="باز کردن تقویم" className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--kv-muted)] hover:text-[var(--kv-ink)]">
            <CalendarDays size={16} />
          </button>
        </div>
        {clearable && value && (
          <button type="button" onClick={() => { onChange(null); setText(""); }} aria-label="پاک کردن تاریخ" className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--kv-line)] text-[var(--kv-muted)] hover:text-[var(--kv-danger)]">
            <X size={14} />
          </button>
        )}
      </div>
      {hint && <span className="mt-1.5 block text-[11.5px] text-[var(--kv-muted)]">{hint}</span>}

      {open && (
        <div className="absolute z-50 mt-2 w-[290px] rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 kv-shadow-lg">
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="ماه قبل" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><ChevronRight size={16} /></button>
            <span className="text-[13px] font-extrabold">{JALALI_MONTHS[view.jm - 1]} {digits(view.jy)}</span>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="ماه بعد" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><ChevronLeft size={16} /></button>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[11px] font-bold text-[var(--kv-muted)]">
            {JALALI_WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {cells.map((day, index) => {
              if (day === null) return <span key={`e-${index}`} />;
              const isSelected = selected?.jy === view.jy && selected?.jm === view.jm && selected?.jd === day;
              const isToday = today.jy === view.jy && today.jm === view.jm && today.jd === day;
              const candidate = fromJalali({ jy: view.jy, jm: view.jm, jd: day });
              const candidateIso = new Date(candidate.gy, candidate.gm - 1, candidate.gd).toISOString();
              const disabled = Boolean(minIso && candidateIso < new Date(parseIso(minIso).toDateString()).toISOString());
              return (
                <button
                  key={`d-${day}`}
                  type="button"
                  disabled={disabled}
                  onClick={() => { commit(view.jy, view.jm, day); setOpen(false); }}
                  className={cn("h-8 rounded-lg text-[12.5px] font-semibold tabular-nums transition-colors",
                    isSelected ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]"
                      : isToday ? "border border-[var(--kv-accent)] text-[var(--kv-accent)]"
                        : "hover:bg-[var(--kv-surface-2)]",
                    disabled && "opacity-40")}
                >
                  {digits(day)}
                </button>
              );
            })}
          </div>
          {withTime && (
            <div className="mt-3 flex items-center gap-2 border-t border-[var(--kv-line)] pt-3">
              <span className="text-[12px] font-semibold text-[var(--kv-muted)]">ساعت</span>
              <select
                aria-label="ساعت"
                value={time?.getHours() ?? 9}
                onChange={(event) => setTimePart(Number(event.target.value), time?.getMinutes() ?? 0)}
                className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1.5 text-[12.5px] tabular-nums"
              >
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{digits(h)}</option>)}
              </select>
              <span className="text-[var(--kv-muted)]">:</span>
              <select
                aria-label="دقیقه"
                value={time?.getMinutes() ?? 0}
                onChange={(event) => setTimePart(time?.getHours() ?? 9, Number(event.target.value))}
                className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1.5 text-[12.5px] tabular-nums"
              >
                {[0, 15, 30, 45].map((m) => <option key={m} value={m}>{digits(m)}</option>)}
              </select>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-[var(--kv-line)] pt-2">
            <button type="button" onClick={() => { const now = new Date(); commit(toJalali(now).jy, toJalali(now).jm, toJalali(now).jd); setOpen(false); }} className="text-[12px] font-bold text-[var(--kv-accent)]">امروز</button>
            <span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{value ? value.slice(0, 10) : "—"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
