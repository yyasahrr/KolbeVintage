import { useState } from "react";
import { fmtNum } from "../data/catalog";

const compact = (n: number) => n >= 1e9 ? `${(n / 1e9).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} میلیارد` : n >= 1e6 ? `${(n / 1e6).toLocaleString("fa-IR", { maximumFractionDigits: 0 })} م` : fmtNum(n);

export type Series = { name: string; color: string; values: number[] };

/* Area/line chart with axis, gridlines and hover readout */
export function AreaChart({ labels, series, height = 220 }: { labels: string[]; series: Series[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, P = { l: 8, r: 56, t: 14, b: 26 };
  const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.1;
  const x = (i: number) => P.l + (i / Math.max(1, labels.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`نمودار ${series.map((s) => s.name).join(" و ")}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--kv-line)" /><text x={W - P.r + 6} y={y(t) + 4} fontSize="10" fill="var(--kv-muted)">{compact(t)}</text></g>)}
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
          return <g key={s.name}>
            <path d={`${d} L${x(s.values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={s.color} opacity={0.1} />
            <path d={d} fill="none" stroke={s.color} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          </g>;
        })}
        {labels.map((l, i) => <text key={i} x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--kv-muted)">{i % Math.ceil(labels.length / 8) === 0 ? l : ""}</text>)}
        {labels.map((_, i) => <rect key={i} x={x(i) - (W / labels.length) / 2} y={0} width={W / labels.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--kv-line-strong)" strokeDasharray="3 3" />}
        {hover !== null && series.map((s) => <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="var(--kv-surface)" strokeWidth={2} />)}
      </svg>
      {hover !== null && (
        <div className="kv-glass pointer-events-none absolute top-2 left-2 rounded-[10px] px-3 py-2 text-[11.5px]">
          <p className="font-bold">{labels[hover]}</p>
          {series.map((s) => <p key={s.name} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}: <b className="tabular-nums">{compact(s.values[hover])}</b></p>)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-4 text-[11.5px] text-[var(--kv-muted)]">{series.map((s) => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-full" style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

/* Horizontal bars — readable labels in RTL */
export function BarList({ items, color = "var(--kv-accent)", format = compact }: { items: { label: string; value: number; sub?: string }[]; color?: string; format?: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1 flex items-center justify-between gap-2 text-[12.5px]"><span className="font-semibold">{i.label}{i.sub && <span className="mr-1.5 text-[11px] font-normal text-[var(--kv-muted)]">{i.sub}</span>}</span><b className="tabular-nums">{format(i.value)}</b></div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--kv-surface-2)]"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${(i.value / max) * 100}%`, background: color }} /></div>
        </li>
      ))}
    </ul>
  );
}

/* Vertical grouped columns */
export function Columns({ labels, series, height = 180 }: { labels: string[]; series: Series[]; height?: number }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height }}>
        {labels.map((l, i) => (
          <div key={l} className="flex h-full flex-1 flex-col justify-end">
            <div className="flex h-full items-end justify-center gap-0.5">
              {series.map((s) => <div key={s.name} title={`${s.name}: ${compact(s.values[i])}`} className="w-full max-w-[18px] rounded-t-[4px] transition-all duration-500" style={{ height: `${(s.values[i] / max) * 100}%`, background: s.color }} />)}
            </div>
            <p className="mt-1.5 truncate text-center text-[10.5px] text-[var(--kv-muted)]">{l}</p>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[11.5px] text-[var(--kv-muted)]">{series.map((s) => <span key={s.name} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}</span>)}</div>
    </div>
  );
}

export function DonutChart({ segs, center, sub }: { segs: { label: string; value: number; color: string }[]; center: string; sub: string }) {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  const R = 44, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative">
        <svg width={132} height={132} viewBox="0 0 120 120" role="img" aria-label={segs.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}٪`).join("، ")}>
          <circle cx={60} cy={60} r={R} fill="none" stroke="var(--kv-surface-2)" strokeWidth={14} />
          {segs.map((s) => { const f = s.value / total; const el = <circle key={s.label} cx={60} cy={60} r={R} fill="none" stroke={s.color} strokeWidth={14} strokeDasharray={`${f * C} ${C - f * C}`} strokeDashoffset={-acc * C} transform="rotate(-90 60 60)" />; acc += f; return el; })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center"><p className="text-[15px] font-extrabold tabular-nums">{center}</p><p className="text-[10.5px] text-[var(--kv-muted)]">{sub}</p></div>
      </div>
      <ul className="space-y-1.5 text-[12px]">{segs.map((s) => <li key={s.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />{s.label}<b className="tabular-nums">{Math.round((s.value / total) * 100).toLocaleString("fa-IR")}٪</b></li>)}</ul>
    </div>
  );
}

export function Kpi({ label, value, delta, hint }: { label: string; value: string; delta?: number; hint?: string }) {
  return (
    <div className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 kv-shadow-sm">
      <p className="text-[12px] text-[var(--kv-muted)]">{label}</p>
      <p className="mt-1.5 text-[18px] font-extrabold tabular-nums">{value}</p>
      <p className="mt-1 text-[11.5px]">{delta !== undefined && <span className={delta >= 0 ? "font-bold text-[var(--kv-success)]" : "font-bold text-[var(--kv-danger)]"}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toLocaleString("fa-IR")}٪</span>}{hint && <span className="mr-1.5 text-[var(--kv-muted)]">{hint}</span>}</p>
    </div>
  );
}
