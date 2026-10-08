/**
 * Prompt-4 §21-§23 / §56-§61 — WHOLESALE ORDER CENTER (VIP master orders).
 *
 * One canonical surface for the whole VIP order lifecycle:
 *   1. a filterable LIST (§56-§58): search, readiness, customer lifecycle, supply-required, date window, sort;
 *      clearing filters always returns to "newest first".
 *   2. a FULL-PAGE DETAIL workspace (§22-§23): خلاصه سفارش / خریدار VIP / اقلام سفارش / تخصیص و تأمین /
 *      وضعیت انبار / ورودی-QC / تجمیع / ارسال نهایی / تایملاین — never a narrow side drawer.
 *   3. the manual ALLOCATION workspace (§59-§61): the three source buckets are shown separately
 *      (موجودی کلبه / موجود تأمین‌کننده نزد کلبه / ظرفیت تأمین‌کننده) with demand vs allocatable vs planned
 *      and an explicit audited reassignment; every save reloads the canonical server state.
 *
 * Every number and label here is a projection of the server read model — no client-side truth,
 * no raw enums, no UUIDs, no supplier topology beyond what an operator is allowed to see.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, BadgeCheck, Boxes, ClipboardList, PackageCheck, RefreshCw, Truck, Warehouse } from "lucide-react";
import { Btn, Empty, ErrorState, LoadingState, Modal, SearchBox, Select, Textarea } from "../components/primitives";
import {
  wholesaleOmsApi,
  type MasterOrderSummary, type MasterReadiness, type OpsAllocation, type OpsMasterDetail,
} from "../data/api";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { MasterChildOrders } from "../components/master-child-orders";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const num = (value: number | string | null | undefined) => fa(new Intl.NumberFormat("fa-IR").format(Number(value ?? 0)));
const toman = (rial: string | null | undefined) => {
  if (!rial) return "—";
  try { return `${new Intl.NumberFormat("fa-IR").format(BigInt(rial) / 10n)} تومان`; } catch { return "—"; }
};
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/* ------------------------- Persian vocabulary (no raw enums) ------------------------- */

const READINESS: Record<MasterReadiness, { label: string; cls: string; hint: string }> = {
  not_ready: { label: "شروع نشده", cls: "bg-gray-100 text-gray-700", hint: "هنوز کالایی آماده نشده است." },
  partial: { label: "نیمه‌آماده", cls: "bg-amber-100 text-amber-800", hint: "بخشی از سفارش آماده و بخشی در جریان است." },
  ready: { label: "آماده ارسال از انبار کلبه", cls: "bg-emerald-100 text-emerald-800", hint: "همه اقلام حاضر و پرداخت‌شده؛ آماده تجمیع و ارسال نهایی." },
  shipped: { label: "ارسال شده", cls: "bg-sky-100 text-sky-800", hint: "مرسوله نهایی کلبه ارسال شده است." },
  delivered: { label: "تحویل شده", cls: "bg-emerald-100 text-emerald-800", hint: "سفارش به خریدار تحویل داده شده است." },
  cancelled: { label: "لغو شده", cls: "bg-red-100 text-red-700", hint: "سفارش مادر لغو شده است." },
};

const CUSTOMER_STATUS: Record<string, string> = {
  processing: "در حال آماده‌سازی سفارش",
  awaiting_payment: "در انتظار پرداخت",
  needs_decision: "نیازمند تأیید خریدار",
  preparing: "در حال آماده‌سازی سفارش",
  ready_to_ship: "آماده ارسال از انبار کلبه",
  shipped: "ارسال شده",
  delivered: "تحویل شده",
  cancelled: "لغو شده",
};

const SUPPLY_STATUS: Record<string, string> = {
  unresolved: "در انتظار تعیین منبع",
  stock_reserved: "رزرو از موجود کلبه",
  awaiting_supplier: "در انتظار تأیید تأمین‌کننده",
  partially_confirmed: "تأیید جزئی تأمین‌کننده",
  awaiting_buyer: "در انتظار تصمیم خریدار",
  confirmed: "تأییدشده",
  rejected: "ردشده",
  timed_out: "بدون پاسخ در مهلت",
  exception: "نیازمند بررسی",
};

const PAYMENT_STATUS: Record<string, string> = {
  not_ready: "آماده پرداخت نیست",
  blocked_supply_pending: "منتظر تأمین",
  blocked_buyer_decision: "منتظر تصمیم خریدار",
  ready: "آماده پرداخت",
  expired: "مهلت پرداخت گذشته",
  blocked_exception: "متوقف تا رفع مشکل",
  paid: "پرداخت‌شده",
};

const FULFILLMENT_STATUS: Record<string, string> = {
  not_started: "شروع نشده",
  waiting_payment: "منتظر پرداخت",
  preparing: "آماده‌سازی در انبار",
  dispatched: "ارسال‌شده به کلبه",
  in_transit: "در مسیر کلبه",
  received: "رسیده به انبار کلبه",
  qc_pending: "در انتظار کنترل کیفیت",
  qc_partial: "کنترل کیفیت جزئی",
  qc_failed: "مشکل در کنترل کیفیت",
  ready_for_consolidation: "آماده تجمیع",
  consolidated: "تجمیع‌شده",
  exception: "نیازمند بررسی",
  delivered: "تحویل‌شده به خریدار",
};

const ALLOC_STATUS: Record<string, string> = {
  pending: "در انتظار تأیید تأمین",
  reserved: "رزروشده",
  consumed: "مصرف‌شده",
  released: "آزادشده",
  cancelled: "لغوشده",
  expired: "منقضی",
  exception: "نیازمند بررسی",
};

const SUPPLIER_RESPONSE: Record<string, { label: string; cls: string }> = {
  unanswered: { label: "در انتظار پاسخ تأمین‌کننده", cls: "bg-amber-100 text-amber-800" },
  accepted: { label: "تأمین پذیرفته‌شده", cls: "bg-sky-100 text-sky-800" },
  revised: { label: "پیشنهاد اصلاحی؛ منتظر خریدار", cls: "bg-violet-100 text-violet-800" },
  rejected: { label: "رد شده؛ نیازمند بازتخصیص", cls: "bg-red-100 text-red-700" },
  committed: { label: "تعهد نهایی تأمین", cls: "bg-indigo-100 text-indigo-800" },
  ready: { label: "آماده ارسال به انبار کلبه", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "لغو تعهد؛ نیاز حفظ شد", cls: "bg-red-100 text-red-700" },
};

const SOURCE: Record<string, { label: string; short: string; cls: string; hint: string }> = {
  kolbe_stock: { label: "موجودی کلبه", short: "موجودی کلبه", cls: "bg-emerald-100 text-emerald-800",
    hint: "کالای فیزیکی متعلق به کلبه در انبار کلبه — رزرو واقعی WMS." },
  supplier_stock_at_kolbe: { label: "موجود تأمین‌کننده نزد کلبه", short: "تأمین‌کننده نزد کلبه", cls: "bg-sky-100 text-sky-800",
    hint: "کالای فیزیکی تأمین‌کننده که همین حالا در انبار کلبه است (مالکیت همچنان تأمین‌کننده)." },
  supplier_external: { label: "ظرفیت تأمین‌کننده", short: "نیازمند تأمین", cls: "bg-amber-100 text-amber-800",
    hint: "ظرفیت اعلامی تأمین‌کننده: تعهد تأمین، نه موجودی فیزیکی — تا تحویل به انبار کلبه موجودی محسوب نمی‌شود." },
};

type Filters = {
  search: string; readiness: string; customerStatus: string; supplyRequired: "" | "1" | "0";
  /* Source coverage is a FILTER on the one Master Order list (never a separate order center). */
  coverage: "" | "kolbe" | "supplier_at_kolbe" | "supply_required" | "mixed";
  dateFrom: string; dateTo: string; sort: "newest" | "oldest";
};
const EMPTY_FILTERS: Filters = { search: "", readiness: "", customerStatus: "", supplyRequired: "", coverage: "", dateFrom: "", dateTo: "", sort: "newest" };

/** PRODUCT-OWNER IA: source differences live INSIDE the order; these chips only narrow the list. */
const COVERAGE_FILTERS: { v: Filters["coverage"]; label: string; hint: string }[] = [
  { v: "", label: "همه", hint: "همه سفارش‌های مادر، بدون توجه به منبع تأمین." },
  { v: "kolbe", label: "دارای موجودی کلبه", hint: "سفارش‌هایی که دست‌کم بخشی از اقلام از موجود فیزیکی کلبه رزرو شده است." },
  { v: "supplier_at_kolbe", label: "دارای موجودی تأمین‌کننده نزد کلبه", hint: "سفارش‌هایی که از موجود فیزیکی تأمین‌کننده در انبار کلبه تأمین می‌شوند." },
  { v: "supply_required", label: "نیازمند تأمین", hint: "سفارش‌هایی که بخشی از آن‌ها نیاز به تأمین دارد (ظرفیت تأمین‌کننده)." },
  { v: "mixed", label: "ترکیبی", hint: "سفارش‌هایی که هم‌زمان بیش از یک منبع تأمین دارند." },
];
const isoDay = (value: string, endOfDay: boolean) =>
  value ? new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString() : "";

function Chip({ label, cls, title }: { label: string; cls: string; title?: string }) {
  // §72: status is never colour-only — the Persian label always carries the meaning.
  return <span title={title} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold", cls)}>{label}</span>;
}

function CoverageCells({ m }: { m: MasterOrderSummary }) {
  const buckets = [
    { key: "kolbe", value: m.kolbe_series ?? 0, source: SOURCE.kolbe_stock! },
    { key: "atKolbe", value: m.supplier_at_kolbe_series ?? 0, source: SOURCE.supplier_stock_at_kolbe! },
    { key: "required", value: m.supply_required_series ?? 0, source: SOURCE.supplier_external! },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {buckets.map((b) => (
        <span key={b.key} title={b.source.hint}
          className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums",
            b.value > 0 ? b.source.cls : "bg-gray-100 text-gray-500")}>
          <span className="font-bold">{num(b.value)}</span>
          <span className="font-medium">{b.source.short}</span>
        </span>
      ))}
      <span className="text-[11px] text-[var(--kv-muted)]">از {num(m.ordered_series ?? 0)} سری</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-[11.5px] font-bold text-[var(--kv-muted)]">
      {label}
      {children}
    </label>
  );
}

/* --------------------------------- list (§56-§58) --------------------------------- */

function MasterList({ onOpen }: { onOpen: (id: string) => void }) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<MasterOrderSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => {
    const p: Record<string, string | number> = { scope: "all", limit: 50, sort: filters.sort };
    if (filters.search.trim()) p.search = filters.search.trim();
    if (filters.readiness) p.readiness = filters.readiness;
    if (filters.customerStatus) p.customerStatus = filters.customerStatus;
    if (filters.supplyRequired !== "") p.supplyRequired = filters.supplyRequired;
    if (filters.coverage) p.coverage = filters.coverage;
    const from = isoDay(filters.dateFrom, false);
    const to = isoDay(filters.dateTo, true);
    if (from) p.dateFrom = from;
    if (to) p.dateTo = to;
    return p;
  }, [filters]);

  const load = useCallback(async () => {
    setError(null);
    try { const res = await wholesaleOmsApi.masters(params); setItems(res.items); setTotal(res.total ?? res.items.length); }
    catch (err) { setError(err instanceof Error ? err.message : "خطا در دریافت سفارش‌های مادر"); }
  }, [params]);
  useEffect(() => { void load(); }, [load]);

  const dirty = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3">
        <div className="min-w-[220px] flex-1">
          <SearchBox placeholder="جست‌وجوی مرجع سفارش یا نام خریدار…" value={filters.search}
            onChange={(v) => setFilters((f) => ({ ...f, search: v }))} />
        </div>
        <Field label="آمادگی سفارش">
          <Select options={["", "not_ready", "partial", "ready", "shipped", "delivered", "cancelled"]}
            value={filters.readiness} labels={{ "": "همه", ...Object.fromEntries(Object.entries(READINESS).map(([k, v]) => [k, v.label])) }}
            onChange={(v) => setFilters((f) => ({ ...f, readiness: v }))} />
        </Field>
        <Field label="وضعیت خریدار">
          <Select options={["", ...Object.keys(CUSTOMER_STATUS)]} value={filters.customerStatus}
            labels={{ "": "همه", ...CUSTOMER_STATUS }} onChange={(v) => setFilters((f) => ({ ...f, customerStatus: v }))} />
        </Field>
        <Field label="نیاز به تأمین">
          <Select options={["", "1", "0"]} value={filters.supplyRequired}
            labels={{ "": "همه", "1": "فقط نیازمند تأمین", "0": "بدون نیاز به تأمین" }}
            onChange={(v) => setFilters((f) => ({ ...f, supplyRequired: v as Filters["supplyRequired"] }))} />
        </Field>
        <Field label="از تاریخ"><input type="date" dir="ltr" value={filters.dateFrom}
          aria-label="از تاریخ"
          className="h-9 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]"
          onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} /></Field>
        <Field label="تا تاریخ"><input type="date" dir="ltr" value={filters.dateTo}
          aria-label="تا تاریخ"
          className="h-9 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]"
          onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} /></Field>
        <Field label="ترتیب">
          <Select options={["newest", "oldest"]} value={filters.sort} labels={{ newest: "جدیدترین", oldest: "قدیمی‌ترین" }}
            onChange={(v) => setFilters((f) => ({ ...f, sort: v as Filters["sort"] }))} />
        </Field>
        <Btn size="sm" variant="soft" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
        <Btn size="sm" variant="ghost" disabled={!dirty} onClick={() => setFilters(EMPTY_FILTERS)}>پاک‌کردن فیلترها</Btn>
      </div>

      {/* §Product-Owner IA: ONE Master Order list; sources narrow it, they never split it. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="فیلتر منبع تأمین">
        <span className="text-[11.5px] font-bold text-[var(--kv-muted)]">منبع تأمین:</span>
        {COVERAGE_FILTERS.map((option) => (
          <button key={option.v || "all"} title={option.hint} aria-pressed={filters.coverage === option.v}
            onClick={() => setFilters((f) => ({ ...f, coverage: option.v }))}
            className={cn("kv-press min-h-9 rounded-full border px-3.5 text-[12px] font-bold transition-all",
              filters.coverage === option.v ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
            {option.label}
          </button>
        ))}
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !items && <LoadingState label="در حال دریافت سفارش‌های مادر…" />}
      {!error && items && items.length === 0 && (
        <Empty title="سفارشی یافت نشد" desc={dirty ? "با فیلترهای فعلی سفارشی پیدا نشد — فیلترها را پاک کنید." : "هنوز سفارش مادر VIP ثبت نشده است."} />
      )}
      {!error && items && items.length > 0 && (
        <div className="overflow-x-auto rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-2.5">
            <p className="text-[12.5px] font-extrabold">سفارش‌های مادر VIP (یک فهرست واحد — منبع تأمین فقط فیلتر است)</p>
            <p className="text-[11.5px] text-[var(--kv-muted)]">{num(total)} سفارش{dirty ? " (فیلترشده)" : ""}</p>
          </div>
          <table className="kv-table min-w-[1020px] text-xs">
            <thead>
              <tr>
                <th>مرجع سفارش</th><th>خریدار</th><th>تاریخ ثبت</th><th>پوشش اقلام</th>
                <th>آمادگی عملیات</th><th>وضعیت سفارش</th><th>مبلغ کل</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => {
                const readiness = READINESS[(m.readiness ?? "not_ready") as MasterReadiness] ?? READINESS.not_ready;
                return (
                  <tr key={m.id}>
                    <td className="font-mono font-bold" dir="ltr">{m.reference}</td>
                    <td>{m.buyer_name || "—"}</td>
                    <td className="whitespace-nowrap text-[11.5px]">{formatPersianDateTimeFull(m.created_at)}</td>
                    <td><CoverageCells m={m} /></td>
                    <td><Chip label={readiness.label} cls={readiness.cls} title={readiness.hint} /></td>
                    <td><Chip label={CUSTOMER_STATUS[m.customer_status ?? ""] ?? "در حال آماده‌سازی سفارش"} cls="bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" /></td>
                    <td className="tabular-nums whitespace-nowrap">{toman(m.total_rial)}</td>
                    <td>
                      <Btn size="sm" variant="soft" onClick={() => onOpen(m.id)}>مشاهده پرونده</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------- allocation workspace (§59-§61) ------------------------- */

function AllocationRow({ allocation, onChanged, flash }: {
  allocation: OpsAllocation; onChanged: () => void; flash: (message: string, kind?: "ok" | "err") => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("supplier_stock_at_kolbe");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const source = SOURCE[allocation.source_type] ?? SOURCE.kolbe_stock!;
  const supplierResponse = SUPPLIER_RESPONSE[allocation.supplier_response_status] ?? SUPPLIER_RESPONSE.unanswered!;
  const canReassign = ["pending", "reserved"].includes(allocation.status)
    && allocation.received_series === 0 && allocation.qc_passed_series === 0;

  const submit = async () => {
    setBusy(true);
    try {
      await wholesaleOmsApi.reassignAllocation(allocation.id, {
        toSource: target === "supplier_external" ? "supplier_external" : "supplier_stock_at_kolbe",
        reason: reason.trim(),
      });
      flash("بازتخصیص ثبت شد؛ رزرو قبلی آزاد و منبع جدید ثبت شد.");
      setOpen(false); setReason("");
      onChanged();   // canonical reload — never client-only optimistic truth (§61)
    } catch (err) {
      flash(err instanceof Error ? err.message : "بازتخصیص انجام نشد", "err");
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-[12px] border border-[var(--kv-line)] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label={source.label} cls={source.cls} title={source.hint} />
        <span className="text-[11.5px] tabular-nums">{num(allocation.quantity)} سری</span>
        <Chip label={ALLOC_STATUS[allocation.status] ?? "نامشخص"} cls={allocation.status === "reserved" ? "bg-emerald-100 text-emerald-800" : "bg-[var(--kv-surface-2)] text-[var(--kv-fg)]"} />
        {allocation.source_type === "supplier_external" && <Chip label={supplierResponse.label} cls={supplierResponse.cls} />}
        {allocation.source_type === "supplier_external" && allocation.supplier_committed_series > 0 && <Chip label={`تعهد ${num(allocation.supplier_committed_series)} سری`} cls="bg-indigo-50 text-indigo-800" />}
        {allocation.received_series > 0 && <Chip label={`ورود ${num(allocation.received_series)}`} cls="bg-sky-100 text-sky-800" />}
        {allocation.qc_passed_series > 0 && <Chip label={`QC تأیید ${num(allocation.qc_passed_series)}`} cls="bg-emerald-100 text-emerald-800" />}
        {allocation.qc_rejected_series > 0 && <Chip label={`QC مردود ${num(allocation.qc_rejected_series)}`} cls="bg-red-100 text-red-700" />}
        {canReassign && (
          <Btn size="sm" variant="ghost" className="mr-auto" onClick={() => setOpen(true)}>بازتخصیص منبع</Btn>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-5 text-[var(--kv-muted)]">{source.hint}</p>
      {allocation.source_type === "supplier_external" && (allocation.supplier_response_note || allocation.supplier_responded_at || allocation.supplier_committed_at || allocation.supplier_ready_at) && (
        <p className="mt-1 text-[10.5px] leading-5 text-[var(--kv-muted)]">
          {allocation.supplier_responded_at && <>پاسخ: {new Date(allocation.supplier_responded_at).toLocaleDateString("fa-IR")} · </>}
          {allocation.supplier_committed_at && <>تعهد: {new Date(allocation.supplier_committed_at).toLocaleDateString("fa-IR")} · </>}
          {allocation.supplier_ready_at && <>آمادگی: {new Date(allocation.supplier_ready_at).toLocaleDateString("fa-IR")} · </>}
          {allocation.supplier_response_note && <>یادداشت: {allocation.supplier_response_note}</>}
        </p>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="بازتخصیص منبع تخصیص" max="max-w-[520px]">
        <div className="space-y-3 p-1">
          <p className="text-[12px] leading-6">
            منبع فعلی: <b>{source.label}</b> ({num(allocation.quantity)} سری). با ثبت این عملیات، رزرو منبع قبلی
            آزاد و منبع جدید ثبت می‌شود؛ سابقه سفارش حفظ می‌شود و مبلغ خریدار تغییر نمی‌کند.
          </p>
          <Field label="منبع مقصد">
            <Select options={["supplier_stock_at_kolbe", "supplier_external"]} value={target}
              labels={{ supplier_stock_at_kolbe: SOURCE.supplier_stock_at_kolbe!.label, supplier_external: SOURCE.supplier_external!.label }}
              onChange={setTarget} />
          </Field>
          <p className="text-[11px] text-[var(--kv-muted)]">
            {target === "supplier_stock_at_kolbe"
              ? "ظرفیت تأمین‌کننده به موجود فیزیکی نزد کلبه ارتقا می‌یابد (همان تأمین‌کننده)."
              : "موجود فیزیکی آزاد و به نیاز به تأمین تبدیل می‌شود؛ تأمین‌کننده باید تأیید کند."}
          </p>
          <Field label="دلیل بازتخصیص (ثبت در سابقه)">
            <Textarea rows={2} value={reason} onChange={setReason} placeholder="مثال: موجودی فیزیکی تأمین‌کننده رسید" />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setOpen(false)}>انصراف</Btn>
            <Btn disabled={busy || reason.trim().length < 4} onClick={() => void submit()}>ثبت بازتخصیص</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ------------------------------- detail (§22-§23) ------------------------------- */

function Section({ title, icon, action, children }: {
  title: string; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-[10px] bg-[var(--kv-surface)]">{icon}</span>
        <h3 className="text-[12.5px] font-extrabold">{title}</h3>
        <div className="mr-auto flex items-center gap-2">{action}</div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MasterDetail({ id, onBack, flash }: { id: string; onBack: () => void; flash: (message: string, kind?: "ok" | "err") => void }) {
  const [detail, setDetail] = useState<OpsMasterDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await wholesaleOmsApi.master(id);
      // §20/§64: the operational workspace only ever renders the SERVER's ops projection.
      if (res.view !== "ops") { setError("دسترسی به پرونده عملیاتی این سفارش برای نقش شما مجاز نیست."); return; }
      setDetail(res);
    } catch (err) { setError(err instanceof Error ? err.message : "خطا در دریافت پرونده سفارش"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const cancelMaster = async () => {
    setBusy(true);
    try {
      const res = await wholesaleOmsApi.cancelMaster(id, reason.trim(), newKey("p4-cancel"));
      flash(res.duplicate ? "این سفارش قبلاً لغو شده بود؛ نتیجه بدون تغییر مجدد نمایش داده می‌شود."
        : `سفارش لغو شد — ${num(res.released.series)} سری فیزیکی آزاد، ${num(res.released.capacity)} سری ظرفیت آزاد، ${num(res.released.requirements)} نیاز به تأمین بسته شد.`);
      setCancelOpen(false); setReason("");
      await load();
    } catch (err) {
      flash(err instanceof Error ? err.message : "لغو سفارش انجام نشد", "err");
    } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!detail) return <LoadingState label="در حال دریافت پرونده سفارش…" />;

  const readiness = READINESS[detail.readiness] ?? READINESS.not_ready;
  const inbound = detail.coverage.receivedSeries + detail.coverage.qcPassedSeries;
  const consolidation = detail.consolidation;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" variant="ghost" icon={<ArrowRight size={14} />} onClick={onBack}>بازگشت به فهرست سفارش‌ها</Btn>
        <span className="font-mono text-[12.5px] font-extrabold" dir="ltr">{detail.reference}</span>
        <Chip label={readiness.label} cls={readiness.cls} title={readiness.hint} />
        <Chip label={detail.customerStatusLabel} cls="bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" />
        <div className="mr-auto flex flex-wrap items-center gap-2">
          <Btn size="sm" variant="soft" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
          {detail.allowedActions.includes("cancel_master") && (
            <Btn size="sm" variant="outline" onClick={() => setCancelOpen(true)}>لغو سفارش مادر…</Btn>
          )}
        </div>
      </div>

      <Section title="خلاصه سفارش" icon={<ClipboardList size={15} />}>
        <dl className="grid grid-cols-2 gap-3 text-[12px] md:grid-cols-4">
          <div><dt className="text-[var(--kv-muted)]">تاریخ ثبت</dt><dd className="font-bold">{formatPersianDateTimeFull(detail.created_at)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">ترکیب سفارش</dt><dd className="font-bold">{detail.composition === "locked" ? "قفل‌شده" : "باز"}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">جمع اقلام (اسنپ‌شات)</dt><dd className="font-bold tabular-nums">{toman(detail.totals.subtotalRial)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">مبلغ کل سفارش</dt><dd className="font-extrabold tabular-nums">{toman(detail.totals.totalRial)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">تخفیف</dt><dd className="tabular-nums">{toman(detail.totals.discountRial)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">هزینه ارسال</dt><dd className="tabular-nums">{detail.totals.shippingRial === "0" ? "—" : toman(detail.totals.shippingRial)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">زیرسفارش‌های فعال</dt><dd className="tabular-nums">{num(detail.children.filter((c) => c.status !== "cancelled").length)}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">استثناهای باز</dt><dd className="tabular-nums">{num(detail.exceptions.filter((e) => e.status === "open").length)}</dd></div>
        </dl>
      </Section>

      <Section title="خریدار VIP" icon={<BadgeCheck size={15} />}
        action={detail.buyer && (
          <Btn size="sm" variant="ghost" onClick={() => { window.location.hash = "#/admin/crm"; }}>
            پرونده CRM خریدار
          </Btn>
        )}>
        {detail.buyer ? (
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <b>{detail.buyer.name}</b>
            {detail.buyer.email && <span dir="ltr" className="text-[var(--kv-muted)]">{detail.buyer.email}</span>}
            <Chip label={detail.buyer.membership_status === "active" ? "عضویت فعال VIP" : "وضعیت عضویت نیازمند بررسی"}
              cls={detail.buyer.membership_status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"} />
          </div>
        ) : <p className="text-[12px] text-[var(--kv-muted)]">اطلاعات خریدار در دسترس نیست.</p>}
      </Section>

      <Section title="اقلام سفارش" icon={<PackageCheck size={15} />}>
        <div className="space-y-3">
          {detail.children.flatMap((child) => child.lines.map((line) => {
            const demand = line.confirmed_series ?? line.requested_series;
            const sumOf = (source: string) => line.allocations
              .filter((a) => a.source_type === source && a.status !== "released" && a.status !== "cancelled")
              .reduce((sum, a) => sum + a.quantity, 0);
            const kolbe = sumOf("kolbe_stock");
            const atKolbe = sumOf("supplier_stock_at_kolbe");
            const capacity = sumOf("supplier_external");
            const physical = kolbe + atKolbe;
            const planned = physical + capacity;
            const unmet = Math.max(0, demand - planned);
            const coverage = unmet > 0
              ? { label: `پوشش ناقص — ${num(unmet)} سری`, cls: "bg-red-100 text-red-700" }
              : physical === demand
                ? { label: "پوشش فیزیکی کامل", cls: "bg-emerald-100 text-emerald-800" }
                : physical > 0
                  ? { label: "پوشش فیزیکی جزئی + نیاز به تأمین", cls: "bg-amber-100 text-amber-800" }
                  : { label: "در انتظار تأمین", cls: "bg-amber-100 text-amber-800" };
            return (
            <div key={line.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <b>{line.product_name}</b>
                <span className="text-[var(--kv-muted)]">{line.series_name}{line.color_label ? ` · ${line.color_label}` : ""}</span>
                <span className="tabular-nums">{num(demand)} سری × {num(line.pieces_per_series)} تکه = {num(demand * line.pieces_per_series)} تکه</span>
                <span className="tabular-nums" title="اسنپ‌شات قیمت زمان ثبت سفارش">{toman(line.unit_series_price_rial)} / سری</span>
                <span className="tabular-nums font-bold">{toman(line.line_total_rial)}</span>
                <Chip label={child.seller_type === "kolbe" ? "تأمین: کلبه" : "تأمین: تأمین‌کننده"} cls="bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" />
                <Chip label={SUPPLY_STATUS[child.supply_status] ?? "در جریان"} cls="bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" />
                <Chip label={PAYMENT_STATUS[child.payment_eligibility] ?? "—"} cls={child.payment_eligibility === "paid" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"} />
                {child.child_fulfillment && <Chip label={FULFILLMENT_STATUS[child.child_fulfillment] ?? "در جریان"} cls="bg-sky-100 text-sky-800" />}
                <Chip label={coverage.label} cls={coverage.cls} />
              </div>
              <div className="mt-2 grid gap-2 text-[11.5px] sm:grid-cols-3">
                <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2">
                  <b>{SOURCE.kolbe_stock!.label}</b>
                  <p className="tabular-nums">تخصیص‌یافته: {num(kolbe)} · قابل تخصیص: {num(line.supply?.kolbe_available ?? 0)}</p>
                </div>
                <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2">
                  <b>{SOURCE.supplier_stock_at_kolbe!.label}</b>
                  <p className="tabular-nums">تخصیص‌یافته: {num(atKolbe)} · قابل تخصیص: {num(line.supply?.supplier_at_kolbe_available ?? 0)}</p>
                </div>
                <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2">
                  <b>{SOURCE.supplier_external!.label}</b>
                  <p className="tabular-nums">نیاز به تأمین: {num(capacity)} · ظرفیت آزاد: {num(line.supply?.offer_capacity_available ?? 0)}</p>
                </div>
              </div>
              <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">
                جمع برنامه‌ریزی‌شده: <b className="tabular-nums">{num(planned)}</b> از <b className="tabular-nums">{num(demand)}</b> سری
                {unmet > 0 ? <> — <b className="text-red-700 tabular-nums">{num(unmet)} سری</b> هنوز پوشش ندارد.</> : " — همه سری‌ها منبع دارند."}
              </p>
            </div>
            );
          }))}
        </div>
      </Section>

      <Section title="تخصیص و تأمین" icon={<Boxes size={15} />}>
        <div className="space-y-3">
          {detail.children.flatMap((child) => child.lines.map((line) => (
            <div key={line.id} className="space-y-2">
              {line.allocations.length === 0 && <p className="text-[11.5px] text-[var(--kv-muted)]">تخصیص منبعی ثبت نشده است.</p>}
              {line.allocations.map((allocation) => (
                <AllocationRow key={allocation.id} allocation={allocation} flash={flash} onChanged={() => void load()} />
              ))}
            </div>
          )))}
          {/* IA consolidation: the internal child orders + their operational tools live HERE —
              inside the one Master Order workspace, never in a competing wholesale order center. */}
          <MasterChildOrders children={detail.children} masterReference={detail.reference}
            canOperate={detail.allowedActions.length > 0} onChanged={() => void load()} />
        </div>
      </Section>

      <Section title="وضعیت انبار" icon={<Warehouse size={15} />}>
        <div className="grid gap-3 text-[12px] sm:grid-cols-4">
          <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2"><dt className="text-[var(--kv-muted)]">موجودی کلبه (رزروشده)</dt><dd className="font-extrabold tabular-nums">{num(detail.coverage.kolbeSeries)} سری</dd></div>
          <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2"><dt className="text-[var(--kv-muted)]">تأمین‌کننده نزد کلبه</dt><dd className="font-extrabold tabular-nums">{num(detail.coverage.supplierAtKolbeSeries)} سری</dd></div>
          <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2"><dt className="text-[var(--kv-muted)]">نیازمند تأمین</dt><dd className="font-extrabold tabular-nums">{num(detail.coverage.capacitySeries)} سری</dd></div>
          <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2"><dt className="text-[var(--kv-muted)]">آماده فیزیکی</dt><dd className="font-extrabold tabular-nums">{num(detail.coverage.kolbeSeries + detail.coverage.supplierAtKolbeSeries + detail.coverage.qcPassedSeries)} سری</dd></div>
        </div>
        <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">{readiness.hint} آخرین وضعیت محاسبه‌شده: <b>{readiness.label}</b> (از داده واقعی انبار و پرداخت).</p>
      </Section>

      <Section title="ورودی و کنترل کیفیت" icon={<Truck size={15} />}>
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <span>سری‌های در راه/رسیده (ورودی): <b className="tabular-nums">{num(inbound)}</b></span>
          <span>استثناهای باز: <b className="tabular-nums">{num(detail.exceptions.filter((e) => e.status === "open").length)}</b></span>
        </div>
        {detail.exceptions.length > 0 && (
          <ul className="mt-2 space-y-1 text-[11.5px]">
            {detail.exceptions.slice(0, 6).map((e) => (
              <li key={e.id} className="rounded-[10px] bg-[var(--kv-surface-2)] p-2">
                {e.status === "open" ? "باز" : "رسیدگی‌شده"} — {e.note || "نیازمند بررسی عملیاتی"}
                {e.quantity ? ` · ${num(e.quantity)} سری` : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-[var(--kv-muted)]">
          ورود کالا، کنترل کیفیت و ثبت رسید در انبار کلبه انجام می‌شود؛ مالکیت کالای تأمین‌کننده تا تبدیل مالکیت رسمی تغییر نمی‌کند.
        </p>
      </Section>

      <Section title="تجمیع و ارسال نهایی" icon={<Truck size={15} />}>
        <div className="grid gap-3 text-[12px] sm:grid-cols-4">
          <div><dt className="text-[var(--kv-muted)]">وضعیت تجمیع</dt><dd className="font-bold">{consolidation ? (consolidation.status === "ready_for_shipment" ? "آماده ارسال نهایی" : consolidation.status === "shipped" ? "ارسال‌شده" : "در حال تجمیع") : "شروع نشده"}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">ارسال‌کننده</dt><dd className="font-bold">{detail.carrier || "—"}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">کد رهگیری</dt><dd className="font-mono font-bold" dir="ltr">{detail.tracking_code || "—"}</dd></div>
          <div><dt className="text-[var(--kv-muted)]">تحویل</dt><dd className="font-bold">{detail.delivered_at ? formatPersianDateTimeFull(detail.delivered_at) : "—"}</dd></div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--kv-muted)]">
          ارسال نهایی فقط از انبار کلبه به خریدار VIP انجام می‌شود؛ تأمین‌کننده هرگز مستقیم به خریدار ارسال نمی‌کند.
        </p>
      </Section>

      <Section title="تایم‌لاین سفارش" icon={<RefreshCw size={15} />}>
        <ol className="space-y-2">
          {detail.timeline.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <span className="h-2 w-2 rounded-full bg-[var(--kv-accent)]" aria-hidden="true" />
              <b>{entry.label}</b>
              <span className="text-[var(--kv-muted)]">{formatPersianDateTimeFull(entry.at)}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="لغو سفارش مادر" max="max-w-[520px]">
        <div className="space-y-3 p-1">
          <p className="text-[12px] leading-6">
            با لغو این سفارش، رزروهای فیزیکی آزاد، ظرفیت تأمین‌کننده رها و نیازهای تأمین تأییدنشده بسته می‌شوند و
            ادامه عملیات انبار متوقف می‌شود. ردیف‌های پرداخت‌شده فقط برای بازگشت مالی علامت‌گذاری می‌شوند و
            بازپرداخت از این مسیر انجام نمی‌شود. این عملیات در سابقه ثبت می‌شود.
          </p>
          <Field label="دلیل لغو (ثبت در سابقه)">
            <Textarea rows={2} value={reason} onChange={setReason} placeholder="مثال: درخواست خریدار VIP" />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setCancelOpen(false)}>انصراف</Btn>
            <Btn variant="dark" disabled={busy || reason.trim().length < 4} onClick={() => void cancelMaster()}>تأیید و لغو سفارش</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* --------------------------------- the center --------------------------------- */

export function WholesaleOrderCenter({ flash = () => undefined }: { flash?: (message: string, kind?: "ok" | "err") => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)]"><ClipboardList size={18} /></span>
        <div>
          <h2 className="text-[13.5px] font-extrabold">سفارشات عمده / VIP</h2>
          <p className="text-[11.5px] text-[var(--kv-muted)]">
            یک خرید خریدار = یک سفارش؛ منابع تأمین (موجودی کلبه، موجود تأمین‌کننده نزد کلبه و نیاز به تأمین) داخل همان پرونده نمایش داده می‌شوند — تفاوت منبع، نوع سفارش نیست.
          </p>
        </div>
      </div>
      {openId ? <MasterDetail id={openId} onBack={() => setOpenId(null)} flash={flash} /> : <MasterList onOpen={setOpenId} />}
    </div>
  );
}
