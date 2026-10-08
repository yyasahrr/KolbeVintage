import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Boxes, ClipboardCheck, PackageCheck, PackageOpen, Truck, TriangleAlert } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, Select, Textarea, WorkspaceModal } from "../components/primitives";
import { apiClient, wholesaleOmsApi, wmsInboundApi, type WmsConsolidationDetail, type WmsConsolidationQueueRow, type WmsDashboard, type WmsExceptionRow, type WmsInboundDetail, type WmsInboundRow } from "../data/api";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

/**
 * Prompt 6 — «دریافت، کنترل کیفیت و تجمیع» (warehouse operations workspace).
 *
 * §25/§26: Persian, RTL, task-oriented. Every counter, queue and permitted action is SERVER-derived
 * (§27) — the UI never decides what is allowed and never does arithmetic that the server must trust.
 * The label vocabulary is the approved operational one (محموله ورودی، در انتظار دریافت، دریافت فیزیکی،
 * کسری، آسیب‌دیده، کنترل کیفیت، تأییدشده، نیازمند بررسی، آماده تجمیع، آماده ارسال، ارسال‌شده).
 */

const fa = (value: number | string | null | undefined) =>
  value === null || value === undefined ? "—" : String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const SHIPMENT_STATUS: Record<string, { label: string; cls: string }> = {
  dispatched: { label: "ارسال‌شده از تأمین‌کننده", cls: "bg-sky-100 text-sky-800" },
  in_transit: { label: "در مسیر", cls: "bg-amber-100 text-amber-800" },
  arrived: { label: "رسیده به انبار", cls: "bg-amber-100 text-amber-800" },
  receiving: { label: "در حال دریافت فیزیکی", cls: "bg-amber-100 text-amber-800" },
  received: { label: "دریافت‌شده — در انتظار کنترل کیفیت", cls: "bg-indigo-100 text-indigo-800" },
  qc_completed: { label: "کنترل کیفیت انجام‌شده", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "لغوشده", cls: "bg-gray-200 text-gray-600" },
};
const FULFILLMENT_LABEL: Record<string, string> = {
  not_started: "شروع‌نشده", waiting_payment: "در انتظار پرداخت", preparing: "در حال آماده‌سازی",
  dispatched: "ارسال‌شده", qc_pending: "در انتظار کنترل کیفیت", in_transit: "در مسیر",
  ready_for_consolidation: "آماده تجمیع", consolidated: "تجمیع‌شده", exception: "نیازمند بررسی", delivered: "تحویل‌شده",
};
const EXCEPTION_LABEL: Record<string, string> = {
  shortage: "کسری", damaged: "آسیب‌دیده", qc_rejected: "رد کنترل کیفیت", wrong_product: "کالای اشتباه",
  wrong_variant: "تنوع اشتباه", wrong_series: "سری اشتباه", supplier_late: "تأخیر تأمین‌کننده",
  lost_inbound: "مفقود در مسیر", payment_late_callback: "بازگشت دیرهنگام پرداخت", over_receipt: "دریافت بیش از مقدار",
  incorrect_quantity: "تعداد نادرست", reconciliation_failed: "مغایرت در توازن", delayed_inbound: "تأخیر محموله ورودی",
  supplier_non_fulfillment: "عدم انجام تعهد تأمین‌کننده", wrong_master_order: "سفارش مادر اشتباه",
};
const RESOLUTION_OPTIONS = [
  { v: "supplier_redelivery", label: "ارسال مجدد توسط تأمین‌کننده" },
  { v: "accept_short", label: "پذیرش کسری (تعیین‌تکلیف نهایی)" },
  { v: "written_off", label: "ثبت به‌عنوان زیان انبار" },
  { v: "refund_pending", label: "ارجاع به مالی برای بازپرداخت" },
] as const;
const CONSOLIDATION_LABEL: Record<string, { label: string; cls: string }> = {
  started: { label: "در حال تجمیع", cls: "bg-amber-100 text-amber-800" },
  consolidated: { label: "تجمیع‌شده — آماده بسته‌بندی", cls: "bg-indigo-100 text-indigo-800" },
  ready_for_shipment: { label: "آماده ارسال", cls: "bg-emerald-100 text-emerald-800" },
  shipped: { label: "ارسال‌شده", cls: "bg-sky-100 text-sky-800" },
};

function Badge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const entry = map[value] ?? { label: value, cls: "bg-gray-100 text-gray-700" };
  return <span className={cn("inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold", entry.cls)}>{entry.label}</span>;
}
const Chip = ({ children, tone = "gray" }: { children: React.ReactNode; tone?: "gray" | "green" | "amber" | "red" }) => (
  <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold",
    tone === "green" && "bg-emerald-100 text-emerald-800", tone === "amber" && "bg-amber-100 text-amber-800",
    tone === "red" && "bg-red-100 text-red-700", tone === "gray" && "bg-gray-100 text-gray-700")}>{children}</span>
);

type View = "dashboard" | "receiving" | "qc" | "exceptions" | "consolidation";

export function WmsInboundOperations({ flash, initialView }: { flash: (msg: string) => void; initialView?: View }) {
  const [view, setView] = useState<View>(initialView ?? "dashboard");
  const [filter, setFilter] = useState<{ awaitingReceiving?: boolean; awaitingQc?: boolean; hasException?: boolean; masterId?: string }>({});
  const [me, setMe] = useState<{ id: string; permissions: string[] } | null>(null);
  useEffect(() => { void apiClient.get<{ id: string; permissions: string[] }>("/auth/me").then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { if (initialView) setView(initialView); }, [initialView]);

  const can = (permission: string) => me?.permissions.includes(permission) ?? false;
  const go = (next: View, nextFilter: typeof filter = {}) => { setFilter(nextFilter); setView(next); };

  return (
    <div className="space-y-4">
      <Segmented
        options={[
          { v: "dashboard", label: "داشبورد انبار" },
          { v: "receiving", label: "در انتظار دریافت" },
          { v: "qc", label: "کنترل کیفیت" },
          { v: "exceptions", label: "نیازمند بررسی" },
          { v: "consolidation", label: "تجمیع و ارسال" },
        ]}
        value={view} onChange={(next) => go(next as View)}
      />
      {view === "dashboard" && <DashboardPanel onDrill={go} />}
      {view === "receiving" && <InboundQueuePanel flash={flash} mode="receiving" canReceive={can("wms:receive")} canInspect={can("wms:qc")}
        filter={filter} onFilter={(next) => setFilter(next)} onOpenExceptions={(masterId) => go("exceptions", { masterId })} />}
      {view === "qc" && <InboundQueuePanel flash={flash} mode="qc" canReceive={can("wms:receive")} canInspect={can("wms:qc")}
        filter={filter} onFilter={(next) => setFilter(next)} onOpenExceptions={(masterId) => go("exceptions", { masterId })} />}
      {view === "exceptions" && <ExceptionCentre flash={flash} meId={me?.id ?? null} filter={filter} onFilter={(next) => setFilter(next)} />}
      {view === "consolidation" && <ConsolidationWorkspace flash={flash} canConsolidate={can("wms:consolidate")} canShip={can("wms:ship")} />}
    </div>
  );
}

/* ------------------------------------------------ dashboard (§24) ------------------------------------------------ */

type CounterCard = { key: string; label: string; view: View; filter?: Record<string, unknown>; tone: string; icon: React.ReactNode };

function DashboardPanel({ onDrill }: { onDrill: (view: View, filter?: Record<string, unknown>) => void }) {
  const [data, setData] = useState<WmsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await wmsInboundApi.dashboard()); } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری داشبورد"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <LoadingState />;

  const cards: CounterCard[] = [
    { key: "arriving", label: "محموله در راه", view: "receiving", filter: { awaitingReceiving: true }, tone: "amber", icon: <Truck size={16} /> },
    { key: "awaiting_receiving", label: "در انتظار دریافت فیزیکی", view: "receiving", filter: { awaitingReceiving: true }, tone: "amber", icon: <PackageOpen size={16} /> },
    { key: "awaiting_qc", label: "در انتظار کنترل کیفیت", view: "qc", filter: { awaitingQc: true }, tone: "indigo", icon: <ClipboardCheck size={16} /> },
    { key: "damaged", label: "سری آسیب‌دیده", view: "receiving", filter: { awaitingQc: true }, tone: "red", icon: <AlertTriangle size={16} /> },
    { key: "open_exceptions", label: "نیازمند بررسی", view: "exceptions", tone: "red", icon: <TriangleAlert size={16} /> },
    { key: "awaiting_consolidation", label: "آماده تجمیع", view: "consolidation", tone: "green", icon: <Boxes size={16} /> },
    { key: "ready_for_packing", label: "آماده بسته‌بندی", view: "consolidation", tone: "indigo", icon: <PackageCheck size={16} /> },
    { key: "ready_for_dispatch", label: "آماده ارسال", view: "consolidation", tone: "green", icon: <Truck size={16} /> },
    { key: "delayed_inbound", label: "تأخیر بیش از حد مجاز", view: "exceptions", tone: "amber", icon: <AlertTriangle size={16} /> },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-[var(--kv-muted)]">
          همه شمارنده‌ها از رکوردهای واقعی انبار محاسبه می‌شوند؛ روی هر کارت بزنید تا فهرست کارِ فیلترشده باز شود.
          {data.policy?.inboundDelayHours ? <> آستانه تأخیر محموله: {fa(data.policy.inboundDelayHours)} ساعت.</> : null}
        </p>
        <Btn variant="ghost" onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {cards.map((card) => {
          const value = Number(data.counters[card.key] ?? 0);
          return (
            <button key={card.key} type="button" onClick={() => onDrill(card.view, card.filter ?? {})}
              className={cn("kv-press flex min-h-[92px] flex-col items-start gap-1 rounded-2xl border p-3 text-right transition",
                "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:border-[var(--kv-accent)]", value === 0 && "opacity-70")}
              aria-label={`${card.label}: ${value}`}>
              <span className={cn("flex h-8 w-8 items-center justify-center rounded-xl",
                card.tone === "green" && "bg-emerald-100 text-emerald-800", card.tone === "amber" && "bg-amber-100 text-amber-800",
                card.tone === "red" && "bg-red-100 text-red-700", card.tone === "indigo" && "bg-indigo-100 text-indigo-800")}>{card.icon}</span>
              <span className="mt-1 text-[20px] font-extrabold tabular-nums">{fa(value)}</span>
              <span className="text-[11.5px] leading-4 text-[var(--kv-muted)]">{card.label}</span>
            </button>
          );
        })}
      </div>
      <Card className="overflow-hidden">
        <h3 className="border-b border-[var(--kv-border)] p-3 text-[13.5px] font-extrabold">سفارش‌های مادر در جریان انبار</h3>
        {data.masters.length === 0 ? <Empty title="سفارش مادری در جریان نیست" desc="وقتی تأمین‌کننده کالا را به انبار بفرستد یا تجمیع شروع شود، اینجا نمایش داده می‌شود." /> : (
          <div className="divide-y divide-[var(--kv-line)]">
            {data.masters.map((master) => {
              const remaining = Math.max(0, master.ordered_series - master.staged_series);
              return (
                <button key={master.id} type="button" onClick={() => onDrill("consolidation", {})}
                  className="kv-press flex w-full flex-wrap items-center justify-between gap-2 p-3 text-right hover:bg-[var(--kv-surface-2)]">
                  <span className="flex flex-col gap-1">
                    <span className="font-bold" dir="ltr">{master.reference}</span>
                    <span className="text-[11.5px] text-[var(--kv-muted)]">
                      {master.shipped_at ? `ارسال‌شده در ${formatPersianDateTimeFull(master.shipped_at)}`
                        : master.consolidation_status ? CONSOLIDATION_LABEL[master.consolidation_status]?.label ?? master.consolidation_status
                          : "در جریان آماده‌سازی"}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Chip tone="green">آماده‌شده: {fa(master.staged_series)}</Chip>
                    {remaining > 0 && <Chip tone="amber">باقی‌مانده: {fa(remaining)}</Chip>}
                    {master.open_exceptions > 0 && <Chip tone="red">نیازمند بررسی: {fa(master.open_exceptions)}</Chip>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------- inbound receiving / QC queues (§24/§25) ------------------------------------- */

function InboundQueuePanel({ flash, mode, canReceive, canInspect, filter, onFilter, onOpenExceptions }: {
  flash: (msg: string) => void; mode: "receiving" | "qc"; canReceive: boolean; canInspect: boolean;
  filter: { awaitingReceiving?: boolean; awaitingQc?: boolean; hasException?: boolean; masterId?: string };
  onFilter: (next: { awaitingReceiving?: boolean; awaitingQc?: boolean; hasException?: boolean; masterId?: string }) => void;
  onOpenExceptions: (masterId: string) => void;
}) {
  const [rows, setRows] = useState<WmsInboundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>(mode === "qc" ? "received" : "");
  const [openId, setOpenId] = useState<string | null>(null);

  const effective = useMemo(() => ({
    awaitingReceiving: mode === "receiving" ? (filter.awaitingReceiving ?? true) : undefined,
    awaitingQc: mode === "qc" ? (filter.awaitingQc ?? true) : undefined,
    hasException: filter.hasException,
    masterId: filter.masterId,
  }), [mode, filter]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await wmsInboundApi.shipments({ ...effective, status: status || undefined, q: q || undefined, limit: 80 });
      setRows(res.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری محموله‌ها"); }
  }, [effective, status, q]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="شماره محموله، سفارش مادر یا تأمین‌کننده…" />
        <Segmented
          options={[{ v: "", label: "همه" }, { v: "dispatched", label: "ارسال‌شده" }, { v: "in_transit", label: "در مسیر" },
            { v: "arrived", label: "رسیده" }, { v: "receiving", label: "در حال دریافت" }, { v: "received", label: "در انتظار QC" },
            { v: "qc_completed", label: "انجام‌شده" }]}
          value={status} onChange={setStatus} />
        {effective.masterId && (
          <Btn variant="ghost" onClick={() => onFilter(mode === "receiving" ? { awaitingReceiving: true } : { awaitingQc: true })}>
            حذف فیلتر سفارش مادر
          </Btn>
        )}
        <Btn variant="ghost" onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {error ? null : rows === null ? <LoadingState /> : rows.length === 0 ? (
        <Empty title={mode === "receiving" ? "محموله‌ای در انتظار دریافت نیست" : "محموله‌ای در انتظار کنترل کیفیت نیست"}
          desc={mode === "receiving" ? "وقتی تأمین‌کننده کالای سفارش‌محور را ارسال کند، در این فهرست ظاهر می‌شود." : "پس از ثبت رسید فیزیکی، محموله به صف کنترل کیفیت می‌آید."} />
      ) : (
        <>
          {/* موبایل: کارت‌ها (بدون جدول دسکتاپ) */}
          <div className="space-y-2 md:hidden">
            {rows.map((row) => (
              <button key={row.id} type="button" onClick={() => setOpenId(row.id)}
                className="kv-press w-full rounded-2xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-right">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold" dir="ltr">{row.reference}</span>
                  <Badge map={SHIPMENT_STATUS} value={row.status} />
                </div>
                <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                  سفارش مادر <span dir="ltr">{row.master_reference}</span> — {row.supplier_label}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip>ارسالی: {fa(row.dispatched_series)}</Chip>
                  <Chip tone="green">دریافتی: {fa(row.received_series)}</Chip>
                  {row.missing_series > 0 && <Chip tone="red">کسری: {fa(row.missing_series)}</Chip>}
                  {row.damaged_series > 0 && <Chip tone="red">آسیب‌دیده: {fa(row.damaged_series)}</Chip>}
                  {row.open_exceptions > 0 && <Chip tone="amber">نیازمند بررسی</Chip>}
                </div>
                <p className="mt-2 text-[11px] text-[var(--kv-muted)]">انبار مقصد: {row.destination_warehouse_name}</p>
              </button>
            ))}
          </div>
          {/* دسکتاپ */}
          <Card className="hidden overflow-hidden md:block">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table w-full text-[12.5px]">
                <thead><tr>
                  <th>محموله</th><th>سفارش مادر</th><th>تأمین‌کننده</th><th>وضعیت</th>
                  <th>ارسالی</th><th>دریافتی</th><th>کسری</th><th>آسیب‌دیده</th><th>QC تأییدشده</th><th>انبار</th><th></th>
                </tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="font-bold" dir="ltr">{row.reference}</td>
                      <td dir="ltr">{row.master_reference}</td>
                      <td>{row.supplier_label}</td>
                      <td><Badge map={SHIPMENT_STATUS} value={row.status} /></td>
                      <td className="tabular-nums">{fa(row.dispatched_series)}</td>
                      <td className="tabular-nums">{fa(row.received_series)}</td>
                      <td className={cn("tabular-nums", row.missing_series > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(row.missing_series)}</td>
                      <td className={cn("tabular-nums", row.damaged_series > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(row.damaged_series)}</td>
                      <td className="tabular-nums">{fa(row.qc_passed_series)}</td>
                      <td>{row.destination_warehouse_name}</td>
                      <td><Btn variant="ghost" onClick={() => setOpenId(row.id)}>{row.status === "received" ? "کنترل کیفیت" : "مشاهده و دریافت"}</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {openId && (
        <ShipmentWorkspace id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()}
          flash={flash} canReceive={canReceive} canInspect={canInspect} onOpenExceptions={onOpenExceptions} />
      )}
    </div>
  );
}

/* --------------------------------------- one inbound shipment workspace (§25) --------------------------------------- */

function ShipmentWorkspace({ id, onClose, onChanged, flash, canReceive, canInspect, onOpenExceptions }: {
  id: string; onClose: () => void; onChanged: () => void; flash: (msg: string) => void;
  canReceive: boolean; canInspect: boolean; onOpenExceptions: (masterId: string) => void;
}) {
  const [detail, setDetail] = useState<WmsInboundDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "receive" | "qc">("view");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<Record<string, { received: string; missing: string; damaged: string; passed: string; rejected: string; lineNote: string }>>({});

  const load = useCallback(async () => {
    setError(null);
    try { setDetail(await wmsInboundApi.shipment(id)); } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری محموله"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const lines = detail?.lines ?? [];
  const rowFor = (lineId: string) => draft[lineId] ?? {
    received: "", missing: "", damaged: "", passed: "", rejected: "", lineNote: "",
  };
  const setRow = (lineId: string, patch: Partial<ReturnType<typeof rowFor>>) =>
    setDraft((prev) => ({ ...prev, [lineId]: { ...rowFor(lineId), ...patch } }));
  const num = (value: string) => (value.trim() === "" ? 0 : Number(value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776))));

  const receivingLines = lines.filter((line) => !line.received_at && line.dispatched_series > 0);
  const qcLines = lines.filter((line) => line.received_at && !line.qc_at);

  const submitReceive = async () => {
    setBusy(true);
    try {
      await wmsInboundApi.receive(id, {
        note: note || undefined,
        lines: receivingLines.map((line) => {
          const row = rowFor(line.id);
          const received = num(row.received);
          return {
            allocationId: line.id, receivedSeries: received,
            missingSeries: row.missing === "" ? Math.max(0, line.dispatched_series - received) : num(row.missing),
            damagedSeries: num(row.damaged), note: row.lineNote || undefined,
          };
        }),
      }, newKey("wms-recv"));
      flash("رسید فیزیکی ثبت شد و مانده برای کنترل کیفیت آماده است.");
      setMode("view"); setDraft({}); setNote(""); await load(); onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : "ثبت رسید ناموفق بود."); }
    finally { setBusy(false); }
  };
  const submitQc = async () => {
    setBusy(true);
    try {
      await wmsInboundApi.qc(id, {
        note: note || undefined,
        lines: qcLines.map((line) => {
          const row = rowFor(line.id);
          return { allocationId: line.id, passedSeries: num(row.passed), rejectedSeries: num(row.rejected),
            damagedSeries: num(row.damaged), note: row.lineNote || undefined };
        }),
      }, newKey("wms-qc"));
      flash("نتیجه کنترل کیفیت ثبت شد. کالای آسیب‌دیده/رد‌شده قابل تخصیص نیست.");
      setMode("view"); setDraft({}); setNote(""); await load(); onChanged();
    } catch (e) { flash(e instanceof Error ? e.message : "ثبت کنترل کیفیت ناموفق بود."); }
    finally { setBusy(false); }
  };

  const serverAllowsReceive = detail?.actions.includes("receive") ?? false;
  const serverAllowsInspect = detail?.actions.includes("inspect") ?? false;

  return (
    <WorkspaceModal open onClose={onClose} title="محموله ورودی" subtitle={detail ? `${detail.shipment.reference} — سفارش مادر ${detail.shipment.master_reference}` : undefined}>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !detail ? <LoadingState /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge map={SHIPMENT_STATUS} value={detail.shipment.status} />
            <Chip>تأمین‌کننده: {detail.shipment.supplier_label}</Chip>
            <Chip>انبار مقصد: {detail.shipment.destination_warehouse_name}</Chip>
            <Chip>{FULFILLMENT_LABEL[detail.shipment.child_fulfillment] ?? detail.shipment.child_fulfillment}</Chip>
            {detail.shipment.tracking_code && <Chip>رهگیری: <span dir="ltr">{detail.shipment.tracking_code}</span></Chip>}
            {detail.shipment.dispatched_at && <Chip tone="amber">ارسال: {formatPersianDateTimeFull(detail.shipment.dispatched_at)}</Chip>}
            {detail.shipment.received_at && <Chip tone="green">دریافت: {formatPersianDateTimeFull(detail.shipment.received_at)}</Chip>}
            {detail.shipment.qc_completed_at && <Chip tone="green">کنترل کیفیت: {formatPersianDateTimeFull(detail.shipment.qc_completed_at)}</Chip>}
          </div>

          {mode === "view" && (
            <div className="flex flex-wrap gap-2">
              {serverAllowsReceive && canReceive && receivingLines.length > 0 && <Btn onClick={() => { setMode("receive"); setNote(""); }}>ثبت دریافت فیزیکی</Btn>}
              {serverAllowsInspect && canInspect && qcLines.length > 0 && <Btn onClick={() => { setMode("qc"); setNote(""); }}>ثبت کنترل کیفیت</Btn>}
              {detail.exceptions.some((e) => e.status === "open") && (
                <Btn variant="ghost" onClick={() => onOpenExceptions(detail.shipment.master_order_id)}>مشاهده موارد نیازمند بررسی</Btn>
              )}
            </div>
          )}

          {mode !== "view" && (
            <Card className="p-3">
              <h3 className="text-[13px] font-extrabold">{mode === "receive" ? "دریافت فیزیکی (رسید انبار)" : "کنترل کیفیت کالای دریافتی"}</h3>
              <p className="mt-1 text-[11.5px] leading-5 text-[var(--kv-muted)]">
                {mode === "receive"
                  ? "تعداد دریافتی و کسری باید با ارسالی تأمین‌کننده برابر باشد؛ آسیب‌دیده جدا از کسری ثبت می‌شود و هیچ‌کدام موجودی قابل فروش نمی‌سازد."
                  : "جمع تأییدشده، رد‌شده و آسیب‌دیده باید دقیقاً برابر مقدار رسیدشده باشد. تأیید کنترل کیفیت پیش‌نیاز تخصیص است."}
              </p>
              <div className="mt-3 space-y-3">
                {(mode === "receive" ? receivingLines : qcLines).map((line) => {
                  const row = rowFor(line.id);
                  const received = num(row.received);
                  const missing = row.missing === "" ? Math.max(0, line.dispatched_series - received) : num(row.missing);
                  const short = mode === "receive" && received > 0 && received + missing !== line.dispatched_series;
                  const qcTotal = num(row.passed) + num(row.rejected) + num(row.damaged);
                  const badQc = mode === "qc" && qcTotal !== line.received_series;
                  return (
                    <div key={line.id} className="rounded-xl border border-[var(--kv-line)] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[12.5px] font-bold">{line.product_name} — {line.series_name}</span>
                        <span className="flex flex-wrap gap-1.5 text-[11px]">
                          <Chip>ارسالی: {fa(line.dispatched_series)}</Chip>
                          <Chip tone="green">دریافتی: {fa(line.received_series)}</Chip>
                          {line.received_missing_series > 0 && <Chip tone="red">کسری: {fa(line.received_missing_series)}</Chip>}
                          {(line.received_damaged_series + line.qc_damaged_series) > 0 && <Chip tone="red">آسیب‌دیده: {fa(line.received_damaged_series + line.qc_damaged_series)}</Chip>}
                        </span>
                      </div>
                      {mode === "receive" ? (
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <Field label="دریافت‌شده"><Input inputMode="numeric" value={row.received} onChange={(v) => setRow(line.id, { received: v })} /></Field>
                          <Field label="کسری"><Input inputMode="numeric" value={row.missing} placeholder={String(Math.max(0, line.dispatched_series - received))} onChange={(v) => setRow(line.id, { missing: v })} /></Field>
                          <Field label="آسیب‌دیده"><Input inputMode="numeric" value={row.damaged} onChange={(v) => setRow(line.id, { damaged: v })} /></Field>
                          <Field label="یادداشت خط"><Input value={row.lineNote} onChange={(v) => setRow(line.id, { lineNote: v })} /></Field>
                        </div>
                      ) : (
                        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <Field label="تأییدشده"><Input inputMode="numeric" value={row.passed} onChange={(v) => setRow(line.id, { passed: v })} /></Field>
                          <Field label="رد‌شده"><Input inputMode="numeric" value={row.rejected} onChange={(v) => setRow(line.id, { rejected: v })} /></Field>
                          <Field label="آسیب‌دیده"><Input inputMode="numeric" value={row.damaged} onChange={(v) => setRow(line.id, { damaged: v })} /></Field>
                          <Field label="یادداشت بازرسی"><Input value={row.lineNote} onChange={(v) => setRow(line.id, { lineNote: v })} /></Field>
                        </div>
                      )}
                      {mode === "receive" ? (
                        short && <p role="alert" className="mt-2 text-[11.5px] font-bold text-[var(--kv-danger)]">
                          دریافتی + کسری باید برابر {fa(line.dispatched_series)} باشد (اکنون {fa(received + missing)}).
                        </p>
                      ) : (
                        badQc && <p role="alert" className="mt-2 text-[11.5px] font-bold text-[var(--kv-danger)]">
                          جمع سه بخش باید دقیقاً برابر مقدار رسیدشده ({fa(line.received_series)}) باشد (اکنون {fa(qcTotal)}).
                        </p>
                      )}
                    </div>
                  );
                })}
                <Field label="یادداشت کل"><Textarea value={note} onChange={setNote} rows={2} /></Field>
                <div className="flex flex-wrap gap-2">
                  <Btn onClick={() => void (mode === "receive" ? submitReceive() : submitQc())} disabled={busy}>
                    {mode === "receive" ? "ثبت نهایی دریافت" : "ثبت نهایی کنترل کیفیت"}
                  </Btn>
                  <Btn variant="ghost" onClick={() => { setMode("view"); setDraft({}); }} disabled={busy}>انصراف</Btn>
                </div>
              </div>
            </Card>
          )}

          <Card className="overflow-hidden">
            <h3 className="border-b border-[var(--kv-border)] p-3 text-[13px] font-extrabold">اقلام محموله</h3>
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table w-full min-w-[720px] text-[12.5px]">
                <thead><tr><th>کالا</th><th>سری</th><th>ارسالی</th><th>دریافتی</th><th>کسری</th><th>آسیب‌دیده</th><th>تأییدشده</th><th>رد‌شده</th><th>رسید</th><th>وضعیت</th></tr></thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.product_name}</td><td>{line.series_name}</td>
                      <td className="tabular-nums">{fa(line.dispatched_series)}</td>
                      <td className="tabular-nums">{fa(line.received_series)}</td>
                      <td className={cn("tabular-nums", line.received_missing_series > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(line.received_missing_series)}</td>
                      <td className={cn("tabular-nums", (line.received_damaged_series + line.qc_damaged_series) > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(line.received_damaged_series + line.qc_damaged_series)}</td>
                      <td className="tabular-nums font-bold text-emerald-700">{fa(line.qc_passed_series)}</td>
                      <td className="tabular-nums">{fa(line.qc_rejected_series)}</td>
                      <td dir="ltr" className="text-[11px]">{line.receipt_number || "—"}</td>
                      <td>{line.qc_at ? "کنترل کیفیت انجام‌شده" : line.received_at ? "در انتظار کنترل کیفیت" : line.dispatched_series > 0 ? "در انتظار دریافت" : "بدون مقدار ارسالی"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {(detail.receipts.length > 0 || detail.exceptions.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {detail.receipts.length > 0 && (
                <Card className="p-3">
                  <h3 className="text-[13px] font-extrabold">رسیدهای انبار (GRN)</h3>
                  <ul className="mt-2 space-y-2 text-[12px]">
                    {detail.receipts.map((receipt) => (
                      <li key={receipt.receipt_number} className="rounded-xl border border-[var(--kv-line)] p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span dir="ltr" className="font-bold">{receipt.receipt_number}</span>
                          <span className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(receipt.received_at)}</span>
                        </div>
                        <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                          کسری: {fa(receipt.shortage_series)} — آسیب‌دیده: {fa(receipt.damaged_series)}
                          {receipt.inspected_at ? ` — بازرسی: ${formatPersianDateTimeFull(receipt.inspected_at)}` : " — بازرسی: انجام نشده"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {detail.exceptions.length > 0 && (
                <Card className="p-3">
                  <h3 className="text-[13px] font-extrabold">موارد نیازمند بررسی این محموله</h3>
                  <ul className="mt-2 space-y-2 text-[12px]">
                    {detail.exceptions.map((item) => (
                      <li key={item.id} className="rounded-xl border border-[var(--kv-line)] p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold">{EXCEPTION_LABEL[item.exception_type] ?? item.exception_type}</span>
                          <Chip tone={item.status === "open" ? "red" : "green"}>{item.status === "open" ? "باز" : "تعیین‌تکلیف‌شده"}</Chip>
                        </div>
                        <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">مقدار: {fa(item.quantity)} — {item.note}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          )}
        </div>
      )}
    </WorkspaceModal>
  );
}

/* ------------------------------------------- exception centre (§14) ------------------------------------------- */

function ExceptionCentre({ flash, meId, filter, onFilter }: {
  flash: (msg: string) => void; meId: string | null;
  filter: { masterId?: string }; onFilter: (next: { masterId?: string }) => void;
}) {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [type, setType] = useState("");
  const [data, setData] = useState<{ items: WmsExceptionRow[]; openCount: number; overdueCount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<WmsExceptionRow | null>(null);
  const [resolution, setResolution] = useState<(typeof RESOLUTION_OPTIONS)[number]["v"]>("supplier_redelivery");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await wmsInboundApi.exceptions({ status, type: type || undefined, masterId: filter.masterId, limit: 120 })); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری موارد نیازمند بررسی"); }
  }, [status, type, filter.masterId]);
  useEffect(() => { void load(); }, [load]);

  const resolve = async () => {
    if (!resolving) return;
    setBusy(true);
    try {
      await wmsInboundApi.resolveException(resolving.id, { resolution, note: note || undefined });
      flash("مورد بررسی تعیین‌تکلیف شد و وضعیت زیرسفارش بازمحاسبه شد.");
      setResolving(null); setNote(""); await load();
    } catch (e) { flash(e instanceof Error ? e.message : "تعیین‌تکلیف ناموفق بود."); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={[{ v: "open", label: "باز" }, { v: "resolved", label: "تعیین‌تکلیف‌شده" }]} value={status}
          onChange={(next) => setStatus(next as "open" | "resolved")} />
        <Segmented options={[{ v: "", label: "همه انواع" }, ...Object.keys(EXCEPTION_LABEL).slice(0, 8).map((key) => ({ v: key, label: EXCEPTION_LABEL[key]! }))]}
          value={type} onChange={setType} />
        {filter.masterId && <Btn variant="ghost" onClick={() => onFilter({})}>حذف فیلتر سفارش مادر</Btn>}
        <Btn variant="ghost" onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !data ? <LoadingState /> : (
        <>
          <p className="text-[12px] text-[var(--kv-muted)]">
            موارد باز: {fa(data.openCount)}
            {data.overdueCount > 0 && <> — بیش از حد مجاز: <span className="font-bold text-[var(--kv-danger)]">{fa(data.overdueCount)}</span></>}
          </p>
          {data.items.length === 0 ? <Empty title="موردی برای بررسی نیست" desc="کسری، آسیب یا رد کنترل کیفیت به‌صورت خودکار اینجا ثبت می‌شود." /> : (
            <div className="space-y-2">
              {data.items.map((item) => (
                <Card key={item.id} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{EXCEPTION_LABEL[item.exception_type] ?? item.exception_type}</span>
                      <Chip tone={item.status === "open" ? "red" : "green"}>{item.status === "open" ? "باز" : "تعیین‌تکلیف‌شده"}</Chip>
                      {item.quantity !== null && <Chip>مقدار: {fa(item.quantity)}</Chip>}
                      {item.master_reference && <Chip>سفارش مادر <span dir="ltr">{item.master_reference}</span></Chip>}
                    </span>
                    <span className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(item.created_at)}</span>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--kv-muted)]">
                    {item.product_name ?? "—"}{item.series_name ? ` — ${item.series_name}` : ""}
                    {item.shipment_reference ? ` — محموله ${item.shipment_reference}` : ""}
                  </p>
                  <p className="mt-1 text-[12px]">{item.note}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[11.5px] text-[var(--kv-muted)]">
                      مسئول: {item.assigned_label ?? "تعیین نشده"}
                    </span>
                    {item.status === "open" && (
                      <>
                        {meId && item.assigned_to !== meId && (
                          <Btn variant="ghost" onClick={async () => {
                            try { await wmsInboundApi.assignException(item.id, meId); flash("مورد به شما واگذار شد."); await load(); }
                            catch (e) { flash(e instanceof Error ? e.message : "واگذاری ناموفق بود."); }
                          }}>واگذاری به من</Btn>
                        )}
                        <Btn onClick={() => { setResolving(item); setResolution("supplier_redelivery"); setNote(""); }}>تعیین تکلیف</Btn>
                      </>
                    )}
                    {item.resolution && <Chip tone="green">{RESOLUTION_OPTIONS.find((option) => option.v === item.resolution)?.label ?? item.resolution}</Chip>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {resolving && (
        <Modal open title="تعیین تکلیف مورد نیازمند بررسی" onClose={() => setResolving(null)}>
          <div className="space-y-3 p-4">
            <p className="text-[12px] text-[var(--kv-muted)]">
              {EXCEPTION_LABEL[resolving.exception_type] ?? resolving.exception_type} — مقدار {fa(resolving.quantity)}
              {resolving.master_reference ? ` — سفارش مادر ${resolving.master_reference}` : ""}
            </p>
            <Field label="روش تعیین تکلیف">
              <Select options={RESOLUTION_OPTIONS.map((option) => option.v)}
                labels={Object.fromEntries(RESOLUTION_OPTIONS.map((option) => [option.v, option.label]))}
                value={resolution} onChange={(v) => setResolution(v as typeof resolution)} />
            </Field>
            <p className="text-[11.5px] leading-5 text-[var(--kv-muted)]">
              پذیرش کسری یا ثبت زیان، تخصیص را با مقدار تأییدشده می‌بندد؛ ارسال مجدد، محموله ورودی جدید می‌سازد.
              بازپرداخت در مرکز مالی (Prompt 3) پیگیری می‌شود و در اینجا فقط ارجاع ثبت می‌شود.
            </p>
            <Field label="توضیح"><Textarea rows={2} value={note} onChange={setNote} /></Field>
            <div className="flex gap-2">
              <Btn onClick={() => void resolve()} disabled={busy}>ثبت تعیین تکلیف</Btn>
              <Btn variant="ghost" onClick={() => setResolving(null)} disabled={busy}>انصراف</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* -------------------------------------- consolidation + shipment (§17-§22) -------------------------------------- */

function ConsolidationWorkspace({ flash, canConsolidate, canShip }: { flash: (msg: string) => void; canConsolidate: boolean; canShip: boolean }) {
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{ items: WmsConsolidationQueueRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openMaster, setOpenMaster] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await wmsInboundApi.consolidationQueue({ status: status || undefined, limit: 60 })); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری صف تجمیع"); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  const items = data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented options={[{ v: "", label: "همه" }, { v: "waiting", label: "در انتظار" }, { v: "ready", label: "آماده تجمیع" },
          { v: "blocked", label: "نیازمند بررسی" }, { v: "in_progress", label: "در حال تجمیع" },
          { v: "packed", label: "آماده ارسال" }, { v: "shipped", label: "ارسال‌شده" }]}
          value={status} onChange={setStatus} />
        <Btn variant="ghost" onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !data ? <LoadingState /> : items.length === 0 ? (
        <Empty title="سفارش مادری در این وضعیت نیست" desc="سفارش‌ها وقتی همه منابع به‌صورت فیزیکی آماده شوند در این صف قرار می‌گیرند." />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const id = item.master_order_id;
            const consolidation = item.consolidation_status;
            const openExceptions = item.open_exceptions;
            const ordered = item.ordered_series;
            const staged = item.staged_series;
            return (
              <Card key={id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold" dir="ltr">{item.master_reference}</span>
                    {consolidation ? <Badge map={CONSOLIDATION_LABEL} value={consolidation} /> : <Chip tone="amber">تجمیع شروع نشده</Chip>}
                    {openExceptions > 0 && <Chip tone="red">نیازمند بررسی: {fa(openExceptions)}</Chip>}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]">
                    <Chip tone="green">آماده‌شده: {fa(staged)}</Chip>
                    {ordered > staged && <Chip tone="amber">باقی‌مانده: {fa(ordered - staged)}</Chip>}
                    {item.packed_at ? <Chip>بسته‌بندی: {formatPersianDateTimeFull(item.packed_at)}</Chip> : null}
                    {item.buyer_label ? <Chip>خریدار: {item.buyer_label}</Chip> : null}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Btn variant="ghost" onClick={() => setOpenMaster(id)}>کارگاه تجمیع</Btn>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {openMaster && <ConsolidationDetailWorkspace masterId={openMaster} onClose={() => setOpenMaster(null)} onChanged={() => void load()}
        flash={flash} canConsolidate={canConsolidate} canShip={canShip} />}
    </div>
  );
}

function ConsolidationDetailWorkspace({ masterId, onClose, onChanged, flash, canConsolidate, canShip }: {
  masterId: string; onClose: () => void; onChanged: () => void; flash: (msg: string) => void;
  canConsolidate: boolean; canShip: boolean;
}) {
  const [detail, setDetail] = useState<WmsConsolidationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<Record<string, string>>({});
  const [packing, setPacking] = useState({ packageCount: "", weightGrams: "", dimensions: "", note: "" });
  const [shipping, setShipping] = useState({ carrier: "", trackingCode: "" });

  const load = useCallback(async () => {
    setError(null);
    try { setDetail(await wmsInboundApi.consolidationDetail(masterId)); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری کارگاه تجمیع"); }
  }, [masterId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); flash(label); await load(); onChanged(); }
    catch (e) { flash(e instanceof Error ? e.message : "عملیات ناموفق بود."); }
    finally { setBusy(false); }
  };

  const actions = detail?.actions ?? [];
  const consolidation = detail?.consolidation ?? null;
  const verifiedCount = detail?.items.filter((item) => item.verified_at).length ?? 0;

  return (
    <WorkspaceModal open onClose={onClose} title="کارگاه تجمیع و ارسال"
      subtitle={detail ? `سفارش مادر ${detail.master.reference} — ${detail.children.length} منبع` : undefined}>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !detail ? <LoadingState /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {consolidation ? <Badge map={CONSOLIDATION_LABEL} value={consolidation.status} /> : <Chip tone="amber">تجمیع شروع نشده</Chip>}
            <Chip>وضعیت سفارش مادر: {detail.master.composition === "locked" ? "قطعی‌شده" : "باز"}</Chip>
            {consolidation && <Chip>اقلام تأییدشده: {fa(verifiedCount)} از {fa(detail.items.length)}</Chip>}
            {consolidation?.package_count ? <Chip tone="green">بسته‌ها: {fa(consolidation.package_count)}</Chip> : null}
            {consolidation?.weight_grams ? <Chip>وزن: {fa(Math.round(consolidation.weight_grams / 100) / 10)} کیلوگرم</Chip> : null}
            {consolidation?.dimensions ? <Chip>ابعاد: <span dir="ltr">{consolidation.dimensions}</span></Chip> : null}
          </div>

          <Card className="overflow-hidden">
            <h3 className="border-b border-[var(--kv-border)] p-3 text-[13px] font-extrabold">پیشرفت منابع (داخلی)</h3>
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table w-full min-w-[760px] text-[12.5px]">
                <thead><tr><th>منبع</th><th>وضعیت انبارش</th><th>سفارش‌شده</th><th>آماده‌شده</th><th>موجودی کلبه</th><th>موجودی تأمین‌کننده</th>
                  <th>در راه</th><th>کسری</th><th>نیازمند بررسی</th></tr></thead>
                <tbody>
                  {detail.children.map((child) => (
                    <tr key={child.id}>
                      <td>{child.seller_label}</td>
                      <td>{FULFILLMENT_LABEL[child.child_fulfillment] ?? child.child_fulfillment}</td>
                      <td className="tabular-nums">{fa(child.ordered_series)}</td>
                      <td className="tabular-nums">{fa(child.staged_series)}</td>
                      <td className="tabular-nums">{fa(child.kolbe_series)}</td>
                      <td className="tabular-nums">{fa(child.supplier_at_kolbe_series)}</td>
                      <td className="tabular-nums">{fa(child.external_series)}</td>
                      <td className={cn("tabular-nums", child.external_missing_series > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(child.external_missing_series)}</td>
                      <td className={cn("tabular-nums", child.open_exceptions > 0 && "font-bold text-[var(--kv-danger)]")}>{fa(child.open_exceptions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex flex-wrap gap-2">
            {actions.includes("start_consolidation") && canConsolidate && (
              <Btn disabled={busy} onClick={() => void run("تجمیع آغاز شد.", () => wholesaleOmsApi.consolidationStart(masterId))}>شروع تجمیع</Btn>
            )}
            {actions.includes("complete_consolidation") && canConsolidate && (
              <Btn disabled={busy} onClick={() => void run("تجمیع تکمیل شد.", () => wholesaleOmsApi.consolidationComplete(consolidation!.id))}>
                تکمیل تجمیع ({fa(verifiedCount)}/{fa(detail.items.length)} تأییدشده)
              </Btn>
            )}
            {actions.includes("ship") && canShip && (
              <span className="text-[11.5px] text-[var(--kv-muted)]">برای ثبت ارسال، اطلاعات باربری را در پایین تکمیل کنید.</span>
            )}
            {!actions.length && <p className="text-[12px] text-[var(--kv-muted)]">در وضعیت فعلی هیچ عملیاتی برای این سفارش مجاز نیست.</p>}
          </div>

          {detail.items.length > 0 && (
            <Card className="overflow-hidden">
              <h3 className="border-b border-[var(--kv-border)] p-3 text-[13px] font-extrabold">تأیید اقلام تجمیع</h3>
              <div className="divide-y divide-[var(--kv-line)]">
                {detail.items.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <span className="flex flex-col gap-1">
                      <span className="text-[12.5px] font-bold">{item.product_name} — {item.series_name}</span>
                      <span className="text-[11.5px] text-[var(--kv-muted)]">
                        مورد انتظار: {fa(item.expected_series)} سری — {item.verified_at ? `تأییدشده در ${formatPersianDateTimeFull(item.verified_at)}` : "تأییدنشده"}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      {item.verified_at ? <Chip tone="green">تأییدشده</Chip> : (
                        <>
                          <Input className="w-40" placeholder="کد اسکن/بازبینی" value={scan[item.id] ?? ""}
                            onChange={(v) => setScan((prev) => ({ ...prev, [item.id]: v }))} />
                          <Btn variant="ghost" disabled={busy || !actions.includes("verify_item")}
                            onClick={() => void run("قلم تأیید شد.", () => wholesaleOmsApi.consolidationVerify(consolidation!.id, { lineId: item.line_id }))}>
                            تأیید قلم
                          </Btn>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {actions.includes("pack") && (
            <Card className="p-3">
              <h3 className="text-[13px] font-extrabold">بسته‌بندی</h3>
              <p className="mt-1 text-[11.5px] leading-5 text-[var(--kv-muted)]">
                فقط مقادیر واقعی اندازه‌گیری‌شده را وارد کنید؛ وزن و ابعاد ساختگی ثبت نمی‌شود و خالی گذاشتن آن‌ها مجاز است.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Field label="تعداد بسته"><Input inputMode="numeric" value={packing.packageCount} onChange={(v) => setPacking({ ...packing, packageCount: v })} /></Field>
                <Field label="وزن (گرم)"><Input inputMode="numeric" value={packing.weightGrams} onChange={(v) => setPacking({ ...packing, weightGrams: v })} /></Field>
                <Field label="ابعاد (مثلاً ۴۰×۳۰×۲۰)"><Input value={packing.dimensions} onChange={(v) => setPacking({ ...packing, dimensions: v })} /></Field>
                <Field label="یادداشت بسته‌بندی"><Input value={packing.note} onChange={(v) => setPacking({ ...packing, note: v })} /></Field>
              </div>
              <div className="mt-3">
                <Btn disabled={busy} onClick={() => void run("بسته‌بندی ثبت شد.", () => wmsInboundApi.pack(consolidation!.id, {
                  packageCount: packing.packageCount ? Number(packing.packageCount) : undefined,
                  weightGrams: packing.weightGrams ? Number(packing.weightGrams) : undefined,
                  dimensions: packing.dimensions || undefined, note: packing.note || undefined,
                }))}>ثبت بسته‌بندی</Btn>
              </div>
            </Card>
          )}

          {actions.includes("ship") && canShip && (
            <Card className="p-3">
              <h3 className="text-[13px] font-extrabold">ارسال نهایی به خریدار</h3>
              <p className="mt-1 text-[11.5px] leading-5 text-[var(--kv-muted)]">
                ارسال نهایی کلبه است؛ تأمین‌کننده هرگز مستقیماً به خریدار ارسال نمی‌کند. تا زمان تعیین‌تکلیف همه موارد باز، ارسال مجاز نیست.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-2">
                <Field label="باربری"><Input value={shipping.carrier} onChange={(v) => setShipping({ ...shipping, carrier: v })} /></Field>
                <Field label="کد رهگیری"><Input value={shipping.trackingCode} onChange={(v) => setShipping({ ...shipping, trackingCode: v })} /></Field>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Btn disabled={busy || !shipping.carrier.trim() || !shipping.trackingCode.trim()}
                  onClick={() => void run("ارسال ثبت شد.", () => wholesaleOmsApi.ship(masterId, { carrier: shipping.carrier.trim(), trackingCode: shipping.trackingCode.trim() }))}>
                  ثبت ارسال نهایی
                </Btn>
                {detail.master.status !== "completed" && (
                  <Btn variant="ghost" disabled={busy} onClick={() => void run("تحویل ثبت شد.", () => wholesaleOmsApi.deliver(masterId))}>ثبت تحویل به خریدار</Btn>
                )}
              </div>
            </Card>
          )}
        </div>
      )}
    </WorkspaceModal>
  );
}
