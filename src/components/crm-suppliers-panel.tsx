import { useCallback, useEffect, useState } from "react";
import { Factory, HelpCircle, RefreshCw } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { crmApi } from "../data/api";
import { COOPERATION_STATUS_FA, faLabel } from "../data/fa-labels";
import { Btn, Card, Empty, ErrorState, LoadingState, SearchBox, Segmented, Status } from "./primitives";

const toman = (value: unknown) => `${fmtNum(Math.round(Number(String(value ?? "0")) / 10))} تومان`;
const text = (value: unknown) => (value === null || value === undefined || value === "" ? "ثبت نشده" : String(value));

type Row = Record<string, unknown>;

const PERF_TONE: Record<string, string> = {
  excellent: "bg-emerald-500/10 text-emerald-700 border-emerald-300",
  top_seller: "bg-amber-500/10 text-amber-700 border-amber-300",
  reliable: "bg-sky-500/10 text-sky-700 border-sky-300",
  new: "bg-teal-500/10 text-teal-700 border-teal-300",
  low_activity: "bg-zinc-500/10 text-zinc-600 border-zinc-300",
  needs_review: "bg-orange-500/10 text-orange-700 border-orange-300",
  qc_weak: "bg-red-500/10 text-red-700 border-red-300",
  suspended: "bg-red-500/10 text-red-700 border-red-300",
};

const VIEWS = [
  { v: "all", label: "همه" },
  { v: "needs_review", label: "نیازمند بررسی" },
  { v: "qc_weak", label: "QC ضعیف" },
  { v: "top_sales", label: "پرفروش" },
  { v: "low_activity", label: "کم‌فعال" },
];

const PAGE = 25;

/** تأمین‌کنندگان در CRM — projection از WMS/Orders/Finance؛ منبع حقیقت همان دامنه‌هاست (§17-§19). */
export function CrmSuppliersPanel({ onOpen360 }: { onOpen360?: (userId: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("all");
  const [whyFor, setWhyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await crmApi.suppliers({ search: search || undefined, view, limit: PAGE, offset });
      setRows(res.items); setTotal(res.total);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری تأمین‌کنندگان"); }
  }, [search, view, offset]);

  useEffect(() => { void load(); }, [load]);

  if (error && !rows) return <ErrorState message={error} onRetry={load} />;

  return (
    <Card className="p-4 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] font-extrabold"><Factory size={16} />عملکرد تأمین‌کنندگان</div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox placeholder="برند، نام یا موبایل…" value={search} onChange={(v) => { setOffset(0); setSearch(v); }} />
          <Segmented options={VIEWS} value={view} onChange={(v) => { setOffset(0); setView(v); }} />
          <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()}>به‌روزرسانی</Btn>
        </div>
      </div>

      {!rows ? <LoadingState label="در حال بارگذاری…" /> : rows.length === 0 ? (
        <Empty title="تأمین‌کننده‌ای یافت نشد" desc="فیلتر یا جست‌وجو را تغییر دهید." />
      ) : (
        <div className="kv-scroll mt-4 overflow-x-auto">
          <table className="w-full min-w-[1020px] text-right text-[12.5px]">
            <thead>
              <tr className="text-[11.5px] text-[var(--kv-muted)]">
                {["تأمین‌کننده", "موبایل", "وضعیت همکاری", "وضعیت عملکرد", "نرخ قبولی QC", "محصول فعال", "سری موجود", "سری فروخته", "فروش کل", "تیکت باز", "عملیات"].map((h) => (
                  <th key={h} className="pb-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--kv-line)]">
              {rows.map((row) => {
                const id = String(row.user_id);
                const reasons = (row.performance_reasons as string[]) ?? [];
                const tone = PERF_TONE[String(row.performance)] ?? PERF_TONE.reliable;
                return (
                  <tr key={id} className="hover:bg-[var(--kv-surface-2)]/60">
                    <td className="py-2.5">
                      <span className="block font-bold">{text(row.brand_name)}</span>
                      <span className="text-[11px] text-[var(--kv-muted)]">{text(row.display_name)}</span>
                    </td>
                    <td className="py-2.5 tabular-nums">{text(row.phone)}</td>
                    <td className="py-2.5"><Status value={faLabel(COOPERATION_STATUS_FA, row.cooperation_status)} /></td>
                    <td className="py-2.5">
                      <span className="relative inline-flex items-center gap-1">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${tone}`}>{text(row.performance_label)}</span>
                        {reasons.length > 0 && (
                          <button className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" title="چرا؟" aria-label="دلایل وضعیت عملکرد"
                            onClick={() => setWhyFor(whyFor === id ? null : id)}><HelpCircle size={14} /></button>
                        )}
                        {whyFor === id && (
                          <span className="absolute left-0 top-7 z-30 w-60 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-right shadow-xl">
                            {reasons.map((reason) => <span key={reason} className="block py-0.5 text-[11px] text-[var(--kv-muted)]">• {reason}</span>)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 tabular-nums">{row.qc_pass_rate === null || row.qc_pass_rate === undefined ? "بدون بازرسی" : `${fmtNum(Number(row.qc_pass_rate))}٪`}</td>
                    <td className="py-2.5 tabular-nums">{fmtNum(Number(row.active_products ?? 0))}</td>
                    <td className="py-2.5 tabular-nums">{fmtNum(Number(row.series_on_hand ?? 0))}</td>
                    <td className="py-2.5 tabular-nums">{fmtNum(Number(row.series_sold ?? 0))}</td>
                    <td className="py-2.5 tabular-nums">{toman(row.total_sales)}</td>
                    <td className="py-2.5 tabular-nums">{fmtNum(Number(row.open_tickets ?? 0))}</td>
                    <td className="py-2.5">
                      {onOpen360 ? <Btn variant="soft" size="sm" onClick={() => onOpen360(id)}>پرونده ۳۶۰°</Btn> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between text-[12px] text-[var(--kv-muted)]">
        <span className="tabular-nums">{fmtNum(total)} تأمین‌کننده · صفحه {fmtNum(Math.floor(offset / PAGE) + 1)}</span>
        <div className="flex gap-2">
          <Btn variant="soft" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>قبلی</Btn>
          <Btn variant="soft" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>بعدی</Btn>
        </div>
      </div>
    </Card>
  );
}
