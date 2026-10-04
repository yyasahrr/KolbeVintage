import { useEffect, useMemo, useState } from "react";
import {
  Card, Btn, Status, SearchBox, Empty, LoadingState, ErrorState, Field, Input, Select,
  Textarea, Drawer, Segmented, SectionHead, Switch, Modal, Tag, WorkspaceModal,
} from "./primitives";
import { AreaChart, BarList, Kpi } from "./charts";
import { PersianDatePicker } from "./persian-date-picker";
import { formatPersianDate, formatPersianDateTime, todayIso, addDaysIso, isoDateOnly } from "../data/persian-date";
import { fmtToman, tomanFromRial, rialFromToman } from "../data/contracts";
import { fmtNum } from "../data/catalog";
import { financeOpsApi, invoiceDocsApi, ordersApi, settlementAdminApi, tryonAdminApi } from "../data/api";
import { SettlementCenter } from "./settlement-center";
import { FinanceLedgerPanel } from "./finance-ledger";
import { useSupplierOptions } from "./supplier-360";
import { useFetch } from "../hooks/useApi";
import { cn } from "../utils/cn";
import {
  Banknote,
  Wallet, Building2, Scale, HandCoins, Truck, FileBarChart2, CalendarClock, Radio,
  RefreshCw, Plus, Check, X, CreditCard, AlertTriangle, ShieldCheck, Download, BadgeCheck,
  Undo2, Percent,
} from "lucide-react";

/* Financial operations centre (items 144-172).
 *
 * Every figure on this screen is read from PostgreSQL through the finance API:
 * the double-entry ledger, supplier accounts, statements, A/P aging, the
 * settlement chain (request → review → approve → pay → reconcile), shipping
 * allocation with a stored rule snapshot, prepayments, adjustments, the report
 * centre (JSON/CSV/XLSX/PDF) and accounting periods (open/closed/locked).
 * No demo numbers are fabricated here — an empty ledger renders as empty.
 */

type Row = Record<string, unknown>;
type Flash = (message: string) => void;

const text = (row: Row | null | undefined, key: string, fallback = "—"): string => {
  const value = row?.[key];
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const has = (row: Row | null | undefined, key: string): boolean => row?.[key] !== null && row?.[key] !== undefined;
const num = (row: Row | null | undefined, key: string): number =>
  Number(String(row?.[key] ?? "0").replace(/[^\d-]/g, "") || 0);

const SETTLEMENT_STATUS: Record<string, string> = {
  draft: "پیش‌نویس", pending: "در انتظار بررسی", processing: "در حال بررسی",
  approved: "تأییدشده", paid: "پرداخت‌شده", reconciled: "مغایرت‌یابی‌شده", cancelled: "لغوشده",
};
const RECONCILIATION_STATUS: Record<string, string> = {
  pending: "مغایرت‌یابی نشده", paid: "پرداخت‌شده", reconciled: "تطبیق کامل", mismatch: "مغایرت",
};
const APPROVAL_STATUS: Record<string, string> = {
  requested: "درخواست‌شده", reviewed: "بررسی‌شده", approved: "تأییدشده", rejected: "رد‌شده", paid: "پرداخت‌شده",
};
const ADJUSTMENT_STATUS: Record<string, string> = { requested: "در انتظار تأیید", applied: "اعمال‌شده", rejected: "رد‌شده" };
const ADVANCE_STATUS: Record<string, string> = { requested: "در انتظار", paid: "پرداخت‌شده", applied: "اعمال‌شده", cancelled: "لغوشده" };
const PERIOD_STATUS: Record<string, string> = { open: "باز", closed: "بسته", locked: "قفل‌شده" };
const SHIPPING_RULES: { v: string; label: string }[] = [
  { v: "value", label: "بر پایه ارزش سطر" },
  { v: "weight", label: "بر پایه وزن" },
  { v: "quantity", label: "بر پایه تعداد" },
  { v: "volume", label: "بر پایه حجم" },
  { v: "equal", label: "مساوی" },
];
const ADJUSTMENT_CATEGORIES = ["manual", "penalty", "bonus", "tax", "withholding", "shipping", "return"];
const PAY_METHODS = [
  { v: "transfer", label: "حواله بانکی" }, { v: "card", label: "کارت به کارت" }, { v: "cash", label: "نقدی" },
  { v: "cheque", label: "چک" }, { v: "wallet", label: "کیف پول" }, { v: "gateway", label: "درگاه پرداخت" },
  { v: "other", label: "سایر" },
];
const CATEGORY_LABEL: Record<string, string> = {
  manual: "دستی", penalty: "جریمه", bonus: "پاداش", tax: "مالیات",
  withholding: "کسر از پرداخت", shipping: "حمل‌ونقل", return: "مرجوعی",
};

const rangePresets = () => [
  { v: "7", label: "۷ روز" },
  { v: "30", label: "۳۰ روز" },
  { v: "90", label: "۹۰ روز" },
  { v: "365", label: "۱ سال" },
];

type Range = { from: string; to: string };

/** Picker values are instants; every date-range API parameter is date-only. */
const apiRange = (range: Range) => ({ from: isoDateOnly(range.from), to: isoDateOnly(range.to) });

/** Shared label/value cell pair used across the finance tables. */
function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[12.5px]">
      <span className="text-[var(--kv-muted)]">{label}</span>
      <b className={cn("tabular-nums", strong && "text-[14px]")}>{value}</b>
    </div>
  );
}

/** A <Select> over Persian labels that maps back to the underlying server id. */
function LabelSelect({ options, value, onChange, placeholder = "— انتخاب کنید —" }: {
  options: { v: string; label: string }[]; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const chosen = options.find((option) => option.v === value);
  return (
    <Select options={chosen ? [chosen.label, ...options.filter((o) => o.v !== value).map((o) => o.label)] : [placeholder, ...options.map((o) => o.label)]}
      value={chosen?.label ?? placeholder}
      onChange={(label) => onChange(options.find((option) => option.label === label)?.v ?? "")} className="w-full" />
  );
}

/* ============================== Dashboard ============================== */

function DashboardTab({ range, setRange, flash }: { range: Range; setRange: (r: Range) => void; flash: Flash }) {
  const [dimension, setDimension] = useState("channel");
  const [bucket, setBucket] = useState("day");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [targetToman, setTargetToman] = useState("");
  const dates = apiRange(range);
  const summary = useFetch(() => financeOpsApi.summary({ from: dates.from, to: dates.to, compare: "previous" }), [dates.from, dates.to]);
  const analytics = useFetch(() => financeOpsApi.analytics({ from: dates.from, to: dates.to, dimension, bucket }), [dates.from, dates.to, dimension, bucket]);
  const targets = useFetch(() => financeOpsApi.targets(month), [month]);

  useEffect(() => { if (targets.data) setTargetToman(String(tomanFromRial(targets.data.targetRial) || "")); }, [targets.data]);

  if (summary.loading && !summary.data) return <LoadingState label="در حال خواندن داشبورد مالی از سرور…" />;
  if (summary.error) return <ErrorState message={summary.error} onRetry={summary.reload} />;
  const metrics = summary.data?.metrics ?? {};
  const previous = summary.data?.comparison?.metrics ?? {};
  const keys = Object.keys(metrics).filter((key) => key !== "dummy");
  const delta = (key: string) => {
    const current = Number(metrics[key] ?? "0");
    const before = Number(previous[key] ?? "0");
    if (!before) return undefined;
    return Math.round(((current - before) / Math.abs(before)) * 1000) / 10;
  };

  const seriesRows = ((analytics.data?.series ?? []) as Row[]);
  const labels = seriesRows.map((row) => formatPersianDate(String(row.bucket)));
  const series = [
    { name: "درآمد", color: "var(--kv-accent)", values: seriesRows.map((row) => tomanFromRial(row.revenue_rial)) },
    { name: "هزینه", color: "var(--kv-danger)", values: seriesRows.map((row) => tomanFromRial(row.expense_rial)) },
    { name: "خالص", color: "var(--kv-success)", values: seriesRows.map((row) => tomanFromRial(row.net_rial)) },
  ];
  const breakdown = ((analytics.data?.breakdown ?? []) as Row[])
    .filter((row) => tomanFromRial(row.revenue_rial) + tomanFromRial(row.expense_rial) !== 0)
    .map((row) => ({ label: text(row, "label"), value: Math.abs(tomanFromRial(row.revenue_rial) || tomanFromRial(row.expense_rial)), sub: `${fmtNum(num(row, "entries"))} سند` }));

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[190px]"><PersianDatePicker label="از تاریخ" value={range.from} onChange={(iso) => iso && setRange({ ...range, from: iso })} /></div>
          <div className="w-[190px]"><PersianDatePicker label="تا تاریخ" value={range.to} onChange={(iso) => iso && setRange({ ...range, to: iso })} /></div>
          <div className="flex flex-wrap gap-1.5">
            {rangePresets().map((preset) => (
              <Tag key={preset.v} active={(range.to === todayIso()) && range.from === addDaysIso(todayIso(), -Number(preset.v) + 1)}
                onClick={() => setRange({ from: addDaysIso(todayIso(), -Number(preset.v) + 1), to: todayIso() })}>{preset.label}</Tag>
            ))}
          </div>
          <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => { summary.reload(); analytics.reload(); targets.reload(); }}>به‌روزرسانی</Btn>
        </div>
        <p className="mt-3 text-[11.5px] text-[var(--kv-muted)]">
          بازه پرس‌وجو: {formatPersianDate(summary.data?.range.from)} تا {formatPersianDate(summary.data?.range.to)}
          {summary.data?.comparison && ` · مقایسه با ${formatPersianDate(summary.data.comparison.from)} تا ${formatPersianDate(summary.data.comparison.to)}`}
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {keys.map((key) => (
          <Kpi key={key} label={METRIC_LABEL[key] ?? key} value={fmtToman(metrics[key])} delta={delta(key)}
            hint={summary.data?.comparison ? "نسبت به بازه پیشین" : undefined} />
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Card className="p-5">
          <SectionHead title="روند درآمد، هزینه و خالص" desc="همه اعداد از دفتر کل دوسویه خوانده می‌شوند" />
          <div className="mt-4 flex flex-wrap gap-2">
            {/* Persian labels over the raw server bucket/dimension values (browser-smoke sweep). */}
            <div className="w-[130px]"><LabelSelect value={bucket} onChange={setBucket}
              options={[{ v: "day", label: "روزانه" }, { v: "week", label: "هفتگی" }, { v: "month", label: "ماهانه" }]} /></div>
            <div className="w-[170px]"><LabelSelect value={dimension} onChange={setDimension}
              options={[
                { v: "channel", label: "کانال فروش" }, { v: "supplier", label: "تأمین‌کننده" }, { v: "category", label: "دسته‌بندی" },
                { v: "warehouse", label: "انبار" }, { v: "campaign", label: "کمپین" }, { v: "provider", label: "ارائه‌دهنده" },
                { v: "carrier", label: "حامل" }, { v: "order", label: "سفارش" }, { v: "account", label: "حساب" },
              ]} /></div>
          </div>
          <div className="mt-4">
            {labels.length === 0
              ? <Empty title="رویداد مالی در این بازه نیست" desc="با ثبت نخستین پرداخت یا تسویه، نمودار از دفتر کل پر می‌شود." />
              : <AreaChart labels={labels} series={series} />}
          </div>
        </Card>
        <Card className="p-5">
          <SectionHead title="تفکیک بر پایه بُعد تحلیلی" desc={`بُعد فعال: ${DIMENSION_LABEL[dimension] ?? dimension}`} />
          <div className="mt-4">
            {breakdown.length === 0
              ? <Empty title="تفکیکی موجود نیست" desc="بُعدهای تحلیلی روی سند‌های دفتر کل ثبت می‌شوند." />
              : <BarList items={breakdown.slice(0, 10)} format={(value) => fmtToman(String(Math.round(value * 10)))} />}
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <SectionHead title="هدف ماهانه" desc="هدف در تنظیمات سرور ذخیره و با فروش واقعی همان ماه مقایسه می‌شود" />
        <div className="mt-4 grid gap-3 sm:grid-cols-[160px_220px_auto] sm:items-end">
          <Field label="ماه هدف" hint="کلید ذخیره سرور به شکل سال-ماه، مثلاً 2026-09"><Input value={month} onChange={setMonth} placeholder="2026-09" /></Field>
          <Field label="هدف (تومان)" hint={targets.data ? `فروش واقعی: ${fmtToman(targets.data.actualRial)} · سفارش: ${fmtNum(targets.data.orders)}` : undefined}>
            <Input value={targetToman} onChange={setTargetToman} placeholder="مثلاً ۵۰۰۰۰۰۰۰" />
          </Field>
          <Btn variant="accent" icon={<BadgeCheck size={15} />} disabled={!targetToman.trim() || !/^\d+$/.test(targetToman.replace(/[^\d]/g, ""))}
            onClick={() => void (async () => {
              try {
                await financeOpsApi.saveTarget({ month, targetRial: rialFromToman(targetToman) });
                flash("هدف ماهانه ذخیره شد");
                targets.reload();
              } catch (error) { flash(error instanceof Error ? error.message : "ذخیره هدف ناموفق بود"); }
            })()}>ذخیره هدف</Btn>
        </div>
        {targets.data && (
          <p className="mt-3 text-[12.5px]">
            تحقق هدف: <b className="tabular-nums">{targets.data.achievementPercent === null ? "هدف ثبت نشده" : `${fmtNum(targets.data.achievementPercent)}٪`}</b>
          </p>
        )}
      </Card>
    </div>
  );
}

const METRIC_LABEL: Record<string, string> = {
  revenue: "درآمد (دفتر کل)", expense: "هزینه (دفتر کل)", supplier_paid: "پرداخت به تأمین‌کنندگان",
  customer_received: "دریافت از مشتریان", payable_balance: "مانده پرداختنی", receivable_balance: "مانده دریافتنی",
  settlements_count: "تعداد تسویه در بازه", settlements_net: "خالص تسویه در بازه",
  active_restrictions: "محدودیت فعال تأمین‌کننده", open_exceptions: "مغایرت باز",
};
const DIMENSION_LABEL: Record<string, string> = {
  channel: "کانال فروش", supplier: "تأمین‌کننده", category: "دسته کالا", warehouse: "انبار",
  campaign: "کمپین", provider: "درگاه پرداخت", carrier: "شرکت حمل", order: "سفارش", account: "حساب دفتر کل",
};

/* ======================= Supplier accounts / statements ======================= */

function AccountsTab({ range, flash }: { range: Range; flash: Flash }) {
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const suppliers = useFetch(() => financeOpsApi.suppliers({ search: search.trim(), limit: "100" }), [search]);
  const rows = (suppliers.data?.items ?? []) as Row[];

  const totals = useMemo(() => rows.reduce<{ pending: number; available: number; settled: number }>((accumulator, row) => ({
    pending: accumulator.pending + tomanFromRial(row.pending_payable_rial),
    available: accumulator.available + tomanFromRial(row.available_payable_rial),
    settled: accumulator.settled + tomanFromRial(row.settled_rial),
  }), { pending: 0, available: 0, settled: 0 }), [rows]);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[240px] flex-1"><SearchBox placeholder="جست‌وجوی نام یا برند تأمین‌کننده…" value={search} onChange={setSearch} /></div>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => suppliers.reload()}>به‌روزرسانی</Btn>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi label="جمع پرداختنی معلق" value={fmtToman(BigInt(Math.round(totals.pending)) * 10n)} />
        <Kpi label="جمع قابل پرداخت" value={fmtToman(BigInt(Math.round(totals.available)) * 10n)} />
        <Kpi label="جمع تسویه‌شده" value={fmtToman(BigInt(Math.round(totals.settled)) * 10n)} />
      </div>

      {suppliers.loading && !suppliers.data && <LoadingState label="در حال خواندن حساب‌های تأمین‌کنندگان…" />}
      {suppliers.error && <ErrorState message={suppliers.error} onRetry={suppliers.reload} />}
      {suppliers.data && rows.length === 0 && <Empty title="حساب تأمین‌کننده‌ای ثبت نشده" desc="با نخستین فروش تحویل‌شده، حساب مالی تأمین‌کننده ساخته می‌شود." />}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[1200px]">
              <thead>
                <tr>
                  <th>تأمین‌کننده</th><th>کارمزد</th><th>فروش ناخالص</th><th>کارمزد کل</th><th>حمل</th>
                  <th>هزینه مرجوعی</th><th>بازگشت وجه</th><th>اصلاحات</th><th>پرداختنی معلق</th><th>قابل پرداخت</th><th>تسویه‌شده</th><th>پیش‌پرداخت</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={text(row, "user_id")}>
                    <td>
                      <b>{text(row, "brand_name", text(row, "display_name"))}</b>
                      <span className="block text-[11px] text-[var(--kv-muted)]">{text(row, "display_name")} · {text(row, "phone", "—")}</span>
                    </td>
                    <td className="tabular-nums">{fmtNum(num(row, "commission_percent"))}٪</td>
                    <td className="tabular-nums">{fmtToman(row.gross_sales_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.commission_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.shipping_charges_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.return_costs_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.refunds_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.adjustments_rial)}</td>
                    <td className="font-bold tabular-nums">{fmtToman(row.pending_payable_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.available_payable_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.settled_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.prepayments_rial)}</td>
                    <td>
                      <Btn variant="soft" size="sm" icon={<Scale size={14} />} onClick={() => setOpenId(text(row, "user_id"))}>صورت‌حساب</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {openId && <StatementDrawer supplierId={openId} range={range} onClose={() => setOpenId(null)} flash={flash} />}
    </div>
  );
}

function StatementDrawer({ supplierId, range, onClose, flash }: { supplierId: string; range: Range; onClose: () => void; flash: Flash }) {
  const [local, setLocal] = useState<Range>(range);
  const [busy, setBusy] = useState(false);
  const dates = apiRange(local);
  const statement = useFetch(() => financeOpsApi.supplierStatement(supplierId, { from: dates.from, to: dates.to, limit: "300" }), [supplierId, dates.from, dates.to]);
  const account = statement.data?.account as Row | null;
  const entries = (statement.data?.entries ?? []) as Row[];
  const orders = (statement.data?.orders ?? []) as Row[];

  const issueStatement = async () => {
    setBusy(true);
    try {
      const document = await invoiceDocsApi.supplierStatement({ supplierId, from: isoDateOnly(local.from), to: isoDateOnly(local.to) });
      flash(`صورت‌حساب ${document.reference} صادر شد`);
      const url = await invoiceDocsApi.downloadPdf(document.id);
      window.open(url, "_blank", "noopener");
    } catch (error) {
      flash(error instanceof Error ? error.message : "صدور صورت‌حساب ناموفق بود");
    } finally { setBusy(false); }
  };

  const pos = statement.data?.settlementPosition as Record<string, string> | undefined;
  const paidSettlements = ((statement.data?.paidSettlements ?? []) as Row[]);
  return (
    <WorkspaceModal open onClose={onClose} title={`مالی تأمین‌کننده — ${text(statement.data?.supplier as Row | null, "display_name", "تأمین‌کننده")}`}
      subtitle="صورت‌حساب بر پایه دفتر کل تأمین‌کننده و موقعیت تسویه زمان‌بندی‌شده">
      <div className="space-y-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[180px]"><PersianDatePicker label="از" value={local.from} onChange={(iso) => iso && setLocal({ ...local, from: iso })} /></div>
          <div className="w-[180px]"><PersianDatePicker label="تا" value={local.to} onChange={(iso) => iso && setLocal({ ...local, to: iso })} /></div>
          <Btn variant="accent" size="sm" icon={<FileBarChart2 size={14} />} disabled={busy} onClick={() => void issueStatement()}>صدور سند صورت‌حساب</Btn>
          <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => statement.reload()}>به‌روزرسانی</Btn>
        </div>

        {statement.loading && !statement.data && <LoadingState label="در حال خواندن صورت‌حساب…" />}
        {statement.error && <ErrorState message={statement.error} onRetry={statement.reload} />}

        {statement.data && (
          <>
            {pos && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {([["نگه‌داشت تسویه (Hold)", pos.heldRial], ["مسدود", pos.blockedRial], ["آماده تسویه", pos.eligibleRial],
                  ["در تسویه برنامه‌ریزی‌شده", pos.scheduledRial], ["تسویه‌شده", pos.settledRial],
                  ["مطالبات بازگشتی باز (Recovery)", pos.openRecoveryRial]] as const).map(([label, v]) => (
                  <div key={label} className="rounded-[12px] border border-[var(--kv-line)] p-3">
                    <p className="text-[11px] text-[var(--kv-muted)]">{label}</p>
                    <p className="text-[13.5px] font-extrabold tabular-nums">{fmtToman(v)}</p>
                  </div>
                ))}
              </div>
            )}
            {paidSettlements.length > 0 && (
              <Card className="overflow-hidden">
                <p className="px-4 py-3 text-[13px] font-bold">تسویه‌های پرداخت‌شده در بازه ({fmtNum(paidSettlements.length)})</p>
                <table className="kv-table text-xs"><thead><tr><th>سند تسویه</th><th>خالص واریز</th><th>کد پیگیری بانکی</th><th>تاریخ واریز</th></tr></thead><tbody>
                  {paidSettlements.map((row) => (
                    <tr key={text(row, "reference")}>
                      <td className="font-mono text-[11px]">{text(row, "reference")}</td>
                      <td className="tabular-nums">{fmtToman(row.net_rial)}</td>
                      <td className="font-mono text-[11px]" dir="ltr">{text(row, "paid_reference")}</td>
                      <td className="tabular-nums">{formatPersianDate(text(row, "paid_at"))}</td>
                    </tr>
                  ))}
                </tbody></table>
              </Card>
            )}
            <details className="rounded-[14px] border border-[var(--kv-line)] p-4">
              <summary className="cursor-pointer text-[12.5px] font-bold text-[var(--kv-muted)]">حساب قدیمی (بایگانی — مدل پیش از تسویه زمان‌بندی‌شده)</summary>
              <div className="mt-3 space-y-2">
                <Line label="مانده آغاز دوره" value={fmtToman(statement.data.openingBalanceRial)} strong />
                <Line label="پرداختنی معلق" value={fmtToman(account?.pending_payable_rial)} />
                <Line label="قابل پرداخت (قدیمی)" value={fmtToman(account?.available_payable_rial)} />
                <Line label="مسدود" value={fmtToman(account?.blocked_rial)} />
                <Line label="تسویه‌شده" value={fmtToman(account?.settled_rial)} />
                <Line label="پیش‌پرداخت (بایگانی)" value={fmtToman(account?.prepayments_rial)} />
              </div>
            </details>

            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-[13px] font-bold">گردش حساب ({fmtNum(entries.length)} سطر)</p>
                <span className="text-[11.5px] text-[var(--kv-muted)]">{formatPersianDate(local.from)} تا {formatPersianDate(local.to)}</span>
              </div>
              <div className="kv-scroll overflow-x-auto">
                <table className="kv-table min-w-[820px] text-xs">
                  <thead><tr><th>تاریخ</th><th>رویداد</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>مرجع</th></tr></thead>
                  <tbody>
                    {entries.length === 0 && <tr><td colSpan={7} className="text-center text-[var(--kv-muted)]">گردشی در این بازه نیست.</td></tr>}
                    {entries.map((entry) => (
                      <tr key={text(entry, "id")}>
                        <td className="tabular-nums">{formatPersianDate(text(entry, "occurred_at"))}</td>
                        <td>{EVENT_LABEL[text(entry, "event")] ?? text(entry, "event")}</td>
                        <td className="max-w-[220px] truncate" title={text(entry, "description")}>{text(entry, "description")}</td>
                        <td className="tabular-nums">{entry.direction === "debit" ? fmtToman(entry.amount_rial) : "—"}</td>
                        <td className="tabular-nums">{entry.direction === "credit" ? fmtToman(entry.amount_rial) : "—"}</td>
                        <td className="tabular-nums">{fmtToman(entry.balance_after_rial)}</td>
                        <td className="font-mono text-[11px]">
                          {text(entry, "settlement_reference", text(entry, "order_reference", text(entry, "reference")))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="px-4 py-3"><p className="text-[13px] font-bold">سفارش‌های مرتبط ({fmtNum(orders.length)})</p></div>
              <div className="kv-scroll overflow-x-auto">
                <table className="kv-table min-w-[560px] text-xs">
                  <thead><tr><th>مرجع سفارش</th><th>وضعیت</th><th>سطر</th><th>ناخالص</th><th>آخرین تغییر</th></tr></thead>
                  <tbody>
                    {orders.length === 0 && <tr><td colSpan={5} className="text-center text-[var(--kv-muted)]">سفارشی در این بازه نیست.</td></tr>}
                    {orders.map((order) => (
                      <tr key={text(order, "id")}>
                        <td className="font-mono text-[11px]">{text(order, "reference")}</td>
                        <td>{text(order, "status")}</td>
                        <td className="tabular-nums">{fmtNum(num(order, "lines"))}</td>
                        <td className="tabular-nums">{fmtToman(order.gross_rial)}</td>
                        <td className="tabular-nums">{formatPersianDateTime(text(order, "updated_at"))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </WorkspaceModal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  payable_accrual: "ثبت سند فروش (Payable)", refund: "بازپرداخت", recovery: "مطالبات بازگشتی (Recovery)", settlement_paid: "واریز تسویه",
  order_sale: "فروش سفارش", commission: "کارمزد", shipping_charge: "هزینه حمل",
  return_cost: "مرجوعی", adjustment_credit: "اصلاح بستانکار", adjustment_debit: "اصلاح بدهکار",
  settlement: "تسویه/پرداخت", prepayment: "پیش‌پرداخت", prepayment_applied: "اعمال پیش‌پرداخت",
  penalty: "جریمه", bonus: "پاداش", tax: "مالیات", withholding: "کسر از پرداخت", withdrawal: "برداشت (قدیمی)",
};

/* ============================== A/P aging ============================== */

function AgingTab() {
  const [side, setSide] = useState<"payable" | "receivable">("payable");
  const aging = useFetch(() => financeOpsApi.aging(side), [side]);
  const group = aging.data?.[side];
  const rows = (group?.items ?? []) as Row[];
  const totals = group?.totals ?? {};
  const buckets = group?.buckets ?? [];

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <Segmented options={[{ v: "payable", label: "بستانکاران (پرداختنی)" }, { v: "receivable", label: "بدهکاران (دریافتنی)" }]} value={side} onChange={setSide} />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => aging.reload()}>به‌روزرسانی</Btn>
      </Card>

      {aging.loading && !aging.data && <LoadingState label="در حال محاسبه سنین بدهی…" />}
      {aging.error && <ErrorState message={aging.error} onRetry={aging.reload} />}

      {aging.data && (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {buckets.map((label, index) => {
              const key = ["not_due", "days_1_7", "days_8_30", "days_31_60", "days_61_90", "days_over_90"][index];
              return <Kpi key={label} label={label} value={fmtToman(totals[key as keyof typeof totals])} />;
            })}
          </div>
          <Card className="overflow-hidden">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[980px]">
                <thead><tr><th>{side === "payable" ? "تأمین‌کننده" : "مشتری"}</th>{buckets.map((label) => <th key={label}>{label}</th>)}<th>جمع</th></tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={8} className="text-center text-[var(--kv-muted)]">مانده‌ای برای گروه‌بندی سنی وجود ندارد.</td></tr>}
                  {rows.map((row) => (
                    <tr key={text(row, "party_id", text(row, "party"))}>
                      <td><b>{text(row, "party")}</b><span className="block font-mono text-[10.5px] text-[var(--kv-muted)]">{text(row, "party_id")}</span></td>
                      <td className="tabular-nums">{fmtToman(row.not_due)}</td>
                      <td className="tabular-nums">{fmtToman(row.days_1_7)}</td>
                      <td className="tabular-nums">{fmtToman(row.days_8_30)}</td>
                      <td className="tabular-nums">{fmtToman(row.days_31_60)}</td>
                      <td className="tabular-nums">{fmtToman(row.days_61_90)}</td>
                      <td className="tabular-nums">{fmtToman(row.days_over_90)}</td>
                      <td className="font-bold tabular-nums">{fmtToman(row.total_rial)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

/* ============================== Settlements ============================== */

function SettlementsTab({ range, flash }: { range: Range; flash: Flash }) {
  const suppliers = useSupplierOptions();
  const [status, setStatus] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ supplierId: string; from: string; to: string; rule: string; deduct: boolean; note: string }>(
    { supplierId: "", from: range.from, to: range.to, rule: "value", deduct: true, note: "" });
  const [busy, setBusy] = useState(false);
  const list = useFetch(() => financeOpsApi.settlements({
    ...(status ? { status } : {}), ...(supplierFilter ? { supplierId: supplierFilter } : {}), limit: "100",
  }), [status, supplierFilter]);

  const rows = (list.data?.items ?? []) as Row[];

  const create = async () => {
    if (!draft.supplierId) { flash("تأمین‌کننده را انتخاب کنید"); return; }
    setBusy(true);
    try {
      const created = await financeOpsApi.createSettlement({
        supplierId: draft.supplierId, from: isoDateOnly(draft.from), to: isoDateOnly(draft.to),
        shippingRule: draft.rule, deductShipping: draft.deduct, note: draft.note.trim() || undefined,
      });
      flash(`تسویه ${text(created, "reference")} با خالص ${fmtToman(created.netRial)} ساخته شد`);
      setCreating(false);
      list.reload();
      setOpenId(text(created, "id"));
    } catch (error) {
      flash(error instanceof Error ? error.message : "ایجاد تسویه ناموفق بود");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-[190px]">
          <Select options={["همه وضعیت‌ها", ...Object.values(SETTLEMENT_STATUS)]}
            value={status ? SETTLEMENT_STATUS[status] ?? status : "همه وضعیت‌ها"}
            onChange={(label) => setStatus(Object.entries(SETTLEMENT_STATUS).find(([, value]) => value === label)?.[0] ?? "")} className="w-full" />
        </div>
        <div className="w-[240px]">
          <LabelSelect options={suppliers} value={supplierFilter} onChange={setSupplierFilter} placeholder="همه تأمین‌کنندگان" />
        </div>
        <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => setCreating((value) => !value)}>تسویه جدید</Btn>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => list.reload()}>به‌روزرسانی</Btn>
        <span className="text-[11.5px] text-[var(--kv-muted)]">
          فیلتر وضعیت: {status ? SETTLEMENT_STATUS[status] ?? status : "همه"} · فیلتر تأمین‌کننده: {supplierFilter ? suppliers.find((option) => option.v === supplierFilter)?.label ?? supplierFilter : "همه"}
        </span>
      </Card>

      {creating && (
        <Card className="space-y-3 p-5">
          <SectionHead title="ساخت تسویه از سفارش‌های تحویل‌شده" desc="مبنای تخصیص حمل به‌عنوان snapshot ذخیره می‌شود" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="تأمین‌کننده">
              <LabelSelect options={suppliers} value={draft.supplierId} onChange={(v) => setDraft({ ...draft, supplierId: v })} />
            </Field>
            <div><PersianDatePicker label="از تاریخ" value={draft.from} onChange={(iso) => iso && setDraft({ ...draft, from: iso })} /></div>
            <div><PersianDatePicker label="تا تاریخ" value={draft.to} onChange={(iso) => iso && setDraft({ ...draft, to: iso })} /></div>
            <Field label="قاعده تخصیص حمل">
              <Select options={SHIPPING_RULES.map((rule) => rule.label)} value={SHIPPING_RULES.find((rule) => rule.v === draft.rule)?.label ?? SHIPPING_RULES[0]!.label}
                onChange={(label) => setDraft({ ...draft, rule: SHIPPING_RULES.find((rule) => rule.label === label)?.v ?? "value" })} className="w-full" />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-[12.5px] font-semibold">
              <Switch on={draft.deduct} onToggle={() => setDraft({ ...draft, deduct: !draft.deduct })} /> کسر هزینه حمل از تسویه
            </label>
            <span className="text-[11.5px] text-[var(--kv-muted)]">
              {SHIPPING_RULES.find((rule) => rule.v === draft.rule)?.label}
            </span>
          </div>
          <Field label="یادداشت"><Input value={draft.note} onChange={(v) => setDraft({ ...draft, note: v })} placeholder="مثلاً تسویه دوره مهر" /></Field>
          <div className="flex gap-2">
            <Btn variant="accent" icon={<Check size={15} />} disabled={busy} onClick={() => void create()}>ساخت تسویه</Btn>
            <Btn variant="soft" onClick={() => setCreating(false)}>انصراف</Btn>
          </div>
        </Card>
      )}

      {list.loading && !list.data && <LoadingState label="در حال خواندن تسویه‌ها…" />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && <Empty title="تسویه‌ای نیست" desc="پس از تحویل سفارش‌ها، از همین صفحه تسویه بسازید؛ زنجیره درخواست→بررسی→تأیید→پرداخت→مغایرت‌یابی طی می‌شود." />}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[1200px]">
              <thead><tr>
                <th>مرجع</th><th>تأمین‌کننده</th><th>وضعیت</th><th>مغایرت‌یابی</th><th>ناخالص</th><th>کارمزد</th>
                <th>حمل</th><th>مرجوعی</th><th>اصلاحات</th><th>خالص</th><th>مغایرت باز</th><th>تاریخ</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={text(row, "id")}>
                    <td className="font-mono text-[11px]">{text(row, "reference")}</td>
                    <td>{text(row, "supplier_name")}</td>
                    <td><Status value={SETTLEMENT_STATUS[text(row, "status")] ?? text(row, "status")} /></td>
                    <td className="text-[12px]">{RECONCILIATION_STATUS[text(row, "reconciliation_status")] ?? text(row, "reconciliation_status")}</td>
                    <td className="tabular-nums">{fmtToman(row.gross_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.commission_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.shipping_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.returns_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.adjustments_rial)}</td>
                    <td className="font-bold tabular-nums">{fmtToman(row.net_rial)}</td>
                    <td className={cn("tabular-nums", num(row, "open_exceptions") > 0 && "font-bold text-[var(--kv-danger)]")}>{fmtNum(num(row, "open_exceptions"))}</td>
                    <td className="tabular-nums">{formatPersianDate(text(row, "created_at"))}</td>
                    <td><Btn variant="soft" size="sm" onClick={() => setOpenId(text(row, "id"))}>جزئیات</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {openId && <SettlementDrawer id={openId} onClose={() => { setOpenId(null); list.reload(); }} flash={flash} />}
    </div>
  );
}

function SettlementDrawer({ id, onClose, flash }: { id: string; onClose: () => void; flash: Flash }) {
  const detail = useFetch(() => financeOpsApi.settlement(id), [id]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [payMethod, setPayMethod] = useState("transfer");
  const [payReference, setPayReference] = useState("");
  const [actualToman, setActualToman] = useState("");
  const data = detail.data;
  const approval = (data?.approval ?? null) as Row | null;
  const lines = (data?.lines ?? []) as Row[];
  const exceptions = (data?.exceptions ?? []) as Row[];
  const events = (data?.events ?? []) as Row[];
  const status = text(data, "status", "");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); detail.reload(); }
    catch (error) { flash(error instanceof Error ? error.message : "عملیات ناموفق بود"); }
    finally { setBusy(false); }
  };

  const openStatement = async () => {
    const statementId = text(data, "statement_invoice_id", "");
    if (!statementId) { flash("سند تسویه پس از پرداخت صادر می‌شود"); return; }
    try { window.open(await invoiceDocsApi.downloadPdf(statementId), "_blank", "noopener"); }
    catch (error) { flash(error instanceof Error ? error.message : "باز کردن سند ممکن نشد"); }
  };

  return (
    <Drawer open onClose={onClose} title={`تسویه ${text(data, "reference", "…")}`} wide>
      <div className="space-y-5">
        {detail.loading && !data && <LoadingState label="در حال خواندن تسویه…" />}
        {detail.error && <ErrorState message={detail.error} onRetry={detail.reload} />}

        {data && (
          <>
            <Card className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-bold">{text(data, "supplier_name")}</p>
                <div className="flex items-center gap-2">
                  <Status value={SETTLEMENT_STATUS[status] ?? status} />
                  <span className="text-[11.5px] text-[var(--kv-muted)]">{RECONCILIATION_STATUS[text(data, "reconciliation_status", "")] ?? ""}</span>
                </div>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <Line label="ناخالص" value={fmtToman(data.gross_rial)} />
                <Line label="کارمزد" value={fmtToman(data.commission_rial)} />
                <Line label="حمل" value={fmtToman(data.shipping_rial)} />
                <Line label="مرجوعی" value={fmtToman(data.returns_rial)} />
                <Line label="اصلاحات" value={fmtToman(data.adjustments_rial)} />
                <Line label="خالص قابل پرداخت" value={fmtToman(data.net_rial)} strong />
                <Line label="ایجاد" value={formatPersianDateTime(text(data, "created_at"))} />
                <Line label="پرداخت" value={data.paid_at ? formatPersianDateTime(text(data, "paid_at")) : "—"} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Btn variant="soft" size="sm" icon={<Download size={14} />} onClick={() => void openStatement()}>سند تسویه (PDF)</Btn>
                <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => detail.reload()}>به‌روزرسانی</Btn>
              </div>
            </Card>

            <Card className="space-y-3 p-4">
              <SectionHead title="گردش تأیید (دو‌مرحله‌ای)" desc="درخواست → بررسی → تأیید → پرداخت؛ تأییدکننده نمی‌تواند درخواست‌کننده باشد" />
              {approval ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Line label="وضعیت تأیید" value={APPROVAL_STATUS[text(approval, "status", "")] ?? text(approval, "status")} />
                    <Line label="مبلغ" value={fmtToman(approval.amount_rial)} />
                    <Line label="درخواست‌کننده" value={text(approval, "requested_by_name")} />
                    <Line label="بررسی‌کننده" value={text(approval, "reviewed_by_name")} />
                    <Line label="تأییدکننده" value={text(approval, "approved_by_name")} />
                  </div>
                  <Textarea placeholder="یادداشت تأیید/رد (اختیاری)" value={note} onChange={setNote} rows={2} />
                  <div className="flex flex-wrap gap-2">
                    {["review", "approve", "reject", "mark-paid"].map((action) => (
                      <Btn key={action} size="sm" variant={action === "approve" ? "accent" : "soft"}
                        icon={action === "reject" ? <X size={14} /> : action === "approve" ? <Check size={14} /> : undefined}
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await financeOpsApi.approvalAction(text(approval, "id"), action as "review" | "approve" | "reject" | "mark-paid", note.trim() || undefined);
                          flash(`تأیید: ${APPROVAL_ACTION_LABEL[action] ?? action}`);
                        })}>{APPROVAL_ACTION_LABEL[action] ?? action}</Btn>
                    ))}
                  </div>
                </>
              ) : <p className="text-[12.5px] text-[var(--kv-muted)]">برای این تسویه درخواست تأییدی ثبت نشده است.</p>}
            </Card>

            <Card className="space-y-3 p-4">
              <SectionHead title="پرداخت و مغایرت‌یابی" desc="پرداخت فقط پس از تأیید و بدون مغایرت بازدارنده انجام می‌شود" />
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="روش پرداخت">
                  <Select options={PAY_METHODS.map((method) => method.label)} value={PAY_METHODS.find((method) => method.v === payMethod)?.label ?? PAY_METHODS[0]!.label}
                    onChange={(label) => setPayMethod(PAY_METHODS.find((method) => method.label === label)?.v ?? "transfer")} className="w-full" />
                </Field>
                <Field label="مرجع پرداخت"><Input value={payReference} onChange={setPayReference} placeholder="شماره پیگیری بانکی" /></Field>
                <div className="flex items-end">
                  <Btn variant="accent" icon={<CreditCard size={15} />} disabled={busy || payReference.trim().length < 2 || status !== "approved"}
                    onClick={() => void run(async () => {
                      const result = await financeOpsApi.paySettlement(id, { method: payMethod, reference: payReference.trim() });
                      flash(`تسویه پرداخت شد: ${fmtToman(result.amountRial)}`);
                      setPayReference("");
                    })}>ثبت پرداخت</Btn>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="مبلغ واقعی پرداختی (تومان)" hint="اگر با خالص تسویه بیش از ۱٬۰۰۰ ریال اختلاف داشته باشد، مغایرت بازدارنده ثبت می‌شود">
                  <Input value={actualToman} onChange={setActualToman} placeholder="مثلاً ۱۰۰۰۰۰۰" />
                </Field>
                <div className="flex items-end">
                  <Btn variant="soft" icon={<Scale size={15} />} disabled={busy || status !== "paid" || !actualToman.replace(/[^\d]/g, "")}
                    onClick={() => void run(async () => {
                      const result = await financeOpsApi.reconcile(id, { actualRial: rialFromToman(actualToman), note: note.trim() || undefined });
                      flash(result.reconciliationStatus === "reconciled" ? "تطبیق کامل ثبت شد" : "مغایرت ثبت شد؛ در فهرست مغایرت‌ها حل کنید");
                    })}>مغایرت‌یابی با بانک</Btn>
                </div>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="px-4 py-3"><p className="text-[13px] font-bold">مغایرت‌ها ({fmtNum(exceptions.length)})</p></div>
              <div className="kv-scroll overflow-x-auto">
                <table className="kv-table min-w-[720px] text-xs">
                  <thead><tr><th>کد</th><th>شدت</th><th>شرح</th><th>انتظار</th><th>یافته</th><th>وضعیت</th><th></th></tr></thead>
                  <tbody>
                    {exceptions.length === 0 && <tr><td colSpan={7} className="text-center text-[var(--kv-muted)]">مغایرتی ثبت نشده است.</td></tr>}
                    {exceptions.map((row) => (
                      <tr key={text(row, "id")}>
                        <td className="font-mono text-[11px]">{text(row, "code")}</td>
                        <td>{text(row, "severity") === "blocking" ? "بازدارنده" : "هشدار"}</td>
                        <td className="max-w-[240px] truncate" title={text(row, "detail")}>{text(row, "detail")}</td>
                        <td className="tabular-nums">{has(row, "expected_rial") ? fmtToman(row.expected_rial) : "—"}</td>
                        <td className="tabular-nums">{has(row, "found_rial") ? fmtToman(row.found_rial) : "—"}</td>
                        <td>{text(row, "status") === "open" ? "باز" : text(row, "status") === "waived" ? "چشم‌پوشی‌شده" : "حل‌شده"}</td>
                        <td>
                          {text(row, "status") === "open" && (
                            <div className="flex gap-1.5">
                              <Btn variant="soft" size="sm" disabled={busy}
                                onClick={() => void run(async () => {
                                  await financeOpsApi.resolveException(id, text(row, "id"), { resolution: "resolved", note: note.trim() || "حل‌شده در کنسول" });
                                  flash("مغایرت حل شد");
                                })}>حل</Btn>
                              <Btn variant="soft" size="sm" disabled={busy}
                                onClick={() => void run(async () => {
                                  await financeOpsApi.resolveException(id, text(row, "id"), { resolution: "waived", note: note.trim() || "چشم‌پوشی مدیر مالی" });
                                  flash("مغایرت با چشم‌پوشی بسته شد");
                                })}>چشم‌پوشی</Btn>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="px-4 py-3"><p className="text-[13px] font-bold">سطرهای تسویه ({fmtNum(lines.length)})</p></div>
              <div className="kv-scroll overflow-x-auto">
                <table className="kv-table min-w-[1000px] text-xs">
                  <thead><tr>
                    <th>سفارش</th><th>کالا</th><th>تعداد</th><th>تحویل</th><th>ناخالص</th>
                    <th>کارمزد</th><th>حمل</th><th>مرجوعی</th><th>اصلاحات</th><th>خالص</th>
                  </tr></thead>
                  <tbody>
                    {lines.length === 0 && <tr><td colSpan={10} className="text-center text-[var(--kv-muted)]">سطری ثبت نشده است.</td></tr>}
                    {lines.map((row) => (
                      <tr key={text(row, "id")}>
                        <td className="font-mono text-[11px]">{text(row, "order_reference")}</td>
                        <td>{text(row, "product_name")}</td>
                        <td className="tabular-nums">{fmtNum(num(row, "quantity"))}</td>
                        <td className="tabular-nums">{formatPersianDate(text(row, "delivered_at"))}</td>
                        <td className="tabular-nums">{fmtToman(row.gross_rial)}</td>
                        <td className="tabular-nums">{fmtToman(row.commission_rial)}</td>
                        <td className="tabular-nums">{fmtToman(row.shipping_rial)}</td>
                        <td className="tabular-nums">{fmtToman(row.returns_rial)}</td>
                        <td className="tabular-nums">{fmtToman(row.adjustments_rial)}</td>
                        <td className="tabular-nums">{fmtToman(row.net_rial)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="p-4">
              <p className="text-[13px] font-bold">رویدادهای تسویه</p>
              <ol className="mt-3 space-y-3">
                {events.length === 0 && <li className="text-[12.5px] text-[var(--kv-muted)]">رویدادی ثبت نشده است.</li>}
                {events.map((row) => (
                  <li key={text(row, "id")} className="flex items-start gap-3">
                    <span className="mt-1 h-2 w-2 rounded-full bg-[var(--kv-accent)]" />
                    <div>
                      <p className="text-[12.5px] font-semibold">
                        {text(row, "from_status", "—")} → {text(row, "to_status")}
                        <span className="mr-2 text-[11px] font-normal text-[var(--kv-muted)]">{formatPersianDateTime(text(row, "created_at"))}</span>
                      </p>
                      <p className="text-[11.5px] text-[var(--kv-muted)]">{text(row, "note")} · {text(row, "actor_name", "سیستم")}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </>
        )}
      </div>
    </Drawer>
  );
}

const APPROVAL_ACTION_LABEL: Record<string, string> = {
  review: "ثبت بررسی", approve: "تأیید", reject: "رد", "mark-paid": "علامت‌گذاری پرداخت",
};

/* ======================= Adjustments & advances ======================= */

function AdjustmentsTab({ flash }: { flash: Flash }) {
  const suppliers = useSupplierOptions();
  const [draft, setDraft] = useState({ supplierId: "", direction: "credit", amount: "", category: "manual", reason: "" });
  const [busy, setBusy] = useState(false);
  const list = useFetch(() => financeOpsApi.adjustments({ limit: "100" }), []);
  const rows = (list.data?.items ?? []) as Row[];

  const create = async () => {
    setBusy(true);
    try {
      const result = await financeOpsApi.createAdjustment({
        supplierId: draft.supplierId, direction: draft.direction as "credit" | "debit",
        amountRial: rialFromToman(draft.amount), category: draft.category, reason: draft.reason.trim(),
      });
      flash(`اصلاح ${result.reference} ثبت شد و در انتظار تأیید است`);
      setDraft({ supplierId: "", direction: "credit", amount: "", category: "manual", reason: "" });
      list.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "ثبت اصلاح ناموفق بود"); }
    finally { setBusy(false); }
  };

  const valid = draft.supplierId && /^\d+$/.test(draft.amount.replace(/[^\d]/g, "")) && draft.reason.trim().length >= 3;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <SectionHead title="اصلاح مالی جدید" desc="جریمه، پاداش، مالیات، کسر از پرداخت یا اصلاح دستی — با گردش تأیید مستقل" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Field label="تأمین‌کننده"><LabelSelect options={suppliers} value={draft.supplierId} onChange={(v) => setDraft({ ...draft, supplierId: v })} /></Field>
          <Field label="جهت">
            <Select options={["بستانکار (به نفع تأمین‌کننده)", "بدهکار (به زیان تأمین‌کننده)"]}
              value={draft.direction === "credit" ? "بستانکار (به نفع تأمین‌کننده)" : "بدهکار (به زیان تأمین‌کننده)"}
              onChange={(label) => setDraft({ ...draft, direction: label.startsWith("بستانکار") ? "credit" : "debit" })} className="w-full" />
          </Field>
          <Field label="مبلغ (تومان)"><Input value={draft.amount} onChange={(v) => setDraft({ ...draft, amount: v })} placeholder="مثلاً ۲۵۰۰۰۰" /></Field>
          <Field label="دسته">
            <Select options={ADJUSTMENT_CATEGORIES.map((category) => CATEGORY_LABEL[category] ?? category)}
              value={CATEGORY_LABEL[draft.category] ?? draft.category}
              onChange={(label) => setDraft({ ...draft, category: ADJUSTMENT_CATEGORIES.find((c) => (CATEGORY_LABEL[c] ?? c) === label) ?? "manual" })} className="w-full" />
          </Field>
          <Field label="دلیل (الزامی)"><Input value={draft.reason} onChange={(v) => setDraft({ ...draft, reason: v })} placeholder="مثلاً کسر هزینه بسته‌بندی" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Btn variant="accent" icon={<Percent size={15} />} disabled={busy || !valid} onClick={() => void create()}>ثبت اصلاح</Btn>
          <span className="text-[11.5px] text-[var(--kv-muted)]">
            دسته‌ها: {ADJUSTMENT_CATEGORIES.map((category) => CATEGORY_LABEL[category] ?? category).join(" · ")}
          </span>
        </div>
      </Card>

      {list.loading && !list.data && <LoadingState label="در حال خواندن اصلاحات…" />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && <Empty title="اصلاحی ثبت نشده" desc="اصلاحات مالی با گردش تأیید ثبت و سپس در حساب تأمین‌کننده اعمال می‌شوند." />}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[900px]">
              <thead><tr><th>مرجع</th><th>تأمین‌کننده</th><th>جهت</th><th>دسته</th><th>مبلغ</th><th>دلیل</th><th>وضعیت</th><th>تاریخ</th><th></th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={text(row, "id")}>
                    <td className="font-mono text-[11px]">{text(row, "reference")}</td>
                    <td>{text(row, "supplier_name")}</td>
                    <td>{text(row, "direction") === "credit" ? "بستانکار (به نفع تأمین‌کننده)" : "بدهکار (به زیان تأمین‌کننده)"}</td>
                    <td>{CATEGORY_LABEL[text(row, "category", "")] ?? text(row, "category")}</td>
                    <td className="tabular-nums">{fmtToman(row.amount_rial)}</td>
                    <td className="max-w-[220px] truncate" title={text(row, "reason")}>{text(row, "reason")}</td>
                    <td><Status value={ADJUSTMENT_STATUS[text(row, "status", "")] ?? text(row, "status")} /></td>
                    <td className="tabular-nums">{formatPersianDate(text(row, "created_at"))}</td>
                    <td>
                      {!has(row, "applied_at") && (
                        <Btn variant="soft" size="sm" icon={<Check size={14} />} disabled={busy}
                          onClick={() => void (async () => {
                            setBusy(true);
                            try {
                              await financeOpsApi.applyAdjustment(text(row, "id"));
                              flash("اصلاح در حساب تأمین‌کننده اعمال شد");
                              list.reload();
                            } catch (error) { flash(error instanceof Error ? error.message : "اعمال اصلاح ناموفق بود"); }
                            finally { setBusy(false); }
                          })()}>اعمال</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function AdvancesTab() {
  /** Prompt 4 (§32): supplier advances are NOT part of the active business model.
   *  History stays read-only and honestly labeled; create/pay/apply actions removed. */
  const list = useFetch(() => financeOpsApi.advances({ limit: "100" }), []);
  const rows = (list.data?.items ?? []) as Row[];
  return (
    <div className="space-y-4">
      <div role="note" className="rounded-[12px] border border-[var(--kv-warning,#b58900)]/40 bg-[var(--kv-surface-2)] px-4 py-3 text-[12.5px]">
        <b>بایگانی قدیمی.</b> پیش‌پرداخت تأمین‌کننده در مدل مالی جدید فعال نیست؛ پرداخت به تأمین‌کننده تنها از مسیر
        «تسویه زمان‌بندی‌شده» انجام می‌شود. رکوردهای زیر فقط برای حسابرسی تاریخی نگه داشته شده‌اند.
      </div>
      {list.loading && !list.data && <LoadingState label="در حال خواندن سوابق پیش‌پرداخت…" />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && <Empty title="سابقه‌ای وجود ندارد" desc="هیچ پیش‌پرداخت تاریخی ثبت نشده است — این بخش صرفاً بایگانی است." />}
      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[860px]">
              <thead><tr><th>مرجع</th><th>تأمین‌کننده</th><th>مبلغ</th><th>اعمال‌شده</th><th>دلیل</th><th>وضعیت</th><th>تاریخ</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={text(row, "id")}>
                    <td className="font-mono text-[11px]">{text(row, "reference")}</td>
                    <td>{text(row, "supplier_name")}</td>
                    <td className="tabular-nums">{fmtToman(row.amount_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.applied_rial)}</td>
                    <td className="max-w-[240px] truncate" title={text(row, "reason")}>{text(row, "reason")}</td>
                    <td><Status value={ADVANCE_STATUS[text(row, "status", "")] ?? text(row, "status", "")} /></td>
                    <td className="tabular-nums">{formatPersianDate(text(row, "created_at"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ====================== Shipping cost allocation ====================== */

function ShippingTab({ flash }: { flash: Flash }) {
  const [draft, setDraft] = useState({ orderId: "", cost: "", rule: "value", carrier: "" });
  const [busy, setBusy] = useState(false);
  const orders = useFetch(() => ordersApi.list({ limit: "50" }), []);
  const list = useFetch(() => financeOpsApi.shippingAllocations(), []);
  const rows = (list.data?.items ?? []) as Row[];
  const orderRows = (orders.data?.items ?? []) as Row[];

  const create = async () => {
    setBusy(true);
    try {
      const result = await financeOpsApi.createShippingAllocation({
        orderId: draft.orderId, totalCostRial: rialFromToman(draft.cost), rule: draft.rule, carrier: draft.carrier.trim() || undefined,
      });
      flash(`تخصیص ${result.reference} با ${fmtNum(result.lines.length)} سطر ثبت شد`);
      setDraft({ orderId: "", cost: "", rule: "value", carrier: "" });
      list.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "تخصیص حمل ناموفق بود"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-5">
        <SectionHead title="تخصیص هزینه حمل سفارش" desc="سهم هر تأمین‌کننده از هزینه حمل با قاعده انتخابی محاسبه و به‌عنوان snapshot ذخیره می‌شود" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="سفارش" hint={orderRows.length === 0 ? "سفارش واقعی برای انتخاب وجود ندارد" : undefined}>
            <LabelSelect options={orderRows.map((order) => ({ v: text(order, "id"), label: `${text(order, "reference")} · ${text(order, "status")}` }))}
              value={draft.orderId} onChange={(v) => setDraft({ ...draft, orderId: v })} placeholder="— سفارش را انتخاب کنید —" />
          </Field>
          <Field label="هزینه کل حمل (تومان)"><Input value={draft.cost} onChange={(v) => setDraft({ ...draft, cost: v })} placeholder="مثلاً ۴۵۰۰۰۰" /></Field>
          <Field label="قاعده تخصیص">
            <Select options={SHIPPING_RULES.map((rule) => rule.label)} value={SHIPPING_RULES.find((rule) => rule.v === draft.rule)?.label ?? SHIPPING_RULES[0]!.label}
              onChange={(label) => setDraft({ ...draft, rule: SHIPPING_RULES.find((rule) => rule.label === label)?.v ?? "value" })} className="w-full" />
          </Field>
          <Field label="شرکت حمل (اختیاری)"><Input value={draft.carrier} onChange={(v) => setDraft({ ...draft, carrier: v })} placeholder="مثلاً تیپاکس" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Btn variant="accent" icon={<Truck size={15} />} disabled={busy || !draft.orderId || !/^\d+$/.test(draft.cost.replace(/[^\d]/g, ""))} onClick={() => void create()}>ثبت تخصیص</Btn>
          <span className="text-[11.5px] text-[var(--kv-muted)]">
            {orderRows.length === 0 ? "سفارشی برای انتخاب نیست؛ ابتدا سفارش واقعی ثبت کنید." : `${fmtNum(orderRows.length)} سفارش اخیر برای انتخاب`}
          </span>
        </div>
      </Card>

      {list.loading && !list.data && <LoadingState label="در حال خواندن تخصیص‌ها…" />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && <Empty title="تخصیصی ثبت نشده" desc="هزینه حمل سفارش‌های چند‌تأمین‌کننده با قاعده وزن/تعداد/ارزش/حجم/مساوی تقسیم می‌شود." />}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>مرجع</th><th>سفارش</th><th>قاعده</th><th>هزینه کل</th><th>تعداد سطر</th><th>تاریخ</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={text(row, "id")}>
                    <td className="font-mono text-[11px]">{text(row, "reference")}</td>
                    <td className="font-mono text-[11px]">{text(row, "order_reference")}</td>
                    <td>{SHIPPING_RULES.find((rule) => rule.v === text(row, "rule", ""))?.label ?? text(row, "rule")}</td>
                    <td className="tabular-nums">{fmtToman(row.total_cost_rial)}</td>
                    <td className="tabular-nums">{fmtNum(num(row, "line_count"))}</td>
                    <td className="tabular-nums">{formatPersianDate(text(row, "created_at"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ============================== Report centre ============================== */

function ReportsTab({ range, flash }: { range: Range; flash: Flash }) {
  const catalog = useFetch(() => financeOpsApi.reports(), []);
  const [code, setCode] = useState<string | null>(null);
  const [local, setLocal] = useState<Range>(range);
  const [busy, setBusy] = useState(false);
  const dates = apiRange(local);
  const report = useFetch(() => code ? financeOpsApi.runReport(code, { from: dates.from, to: dates.to, limit: "500" }) : Promise.resolve(null), [code, dates.from, dates.to]);

  const exportReport = async (format: "csv" | "xlsx" | "pdf") => {
    if (!code) return;
    setBusy(true);
    try {
      const url = await financeOpsApi.exportReport(code, format, { from: isoDateOnly(local.from), to: isoDateOnly(local.to) });
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${code}-${isoDateOnly(local.from)}.${format}`;
      anchor.click();
      flash(`گزارش ${code} در قالب ${format.toUpperCase()} آماده شد`);
    } catch (error) { flash(error instanceof Error ? error.message : "خروجی گرفتن ناموفق بود"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="p-4">
          <SectionHead title="مرکز گزارش‌ها" desc="همه گزارش‌ها از دفتر کل و اسناد واقعی ساخته می‌شوند" />
          <ul className="mt-3 space-y-1.5">
            {((catalog.data?.items ?? []) as { code: string; title: string; category: string }[]).map((item) => (
              <li key={item.code}>
                <button onClick={() => setCode(item.code)}
                  className={cn("kv-press w-full rounded-[10px] px-3 py-2 text-right text-[12.5px] font-semibold",
                    code === item.code ? "bg-[var(--kv-accent)]/12 text-[var(--kv-accent)]" : "hover:bg-[var(--kv-surface-2)]")}>
                  {item.title}
                  <span className="block text-[10.5px] font-normal text-[var(--kv-muted)]">{item.category} · {item.code}</span>
                </button>
              </li>
            ))}
          </ul>
          {catalog.loading && !catalog.data && <LoadingState label="در حال خواندن فهرست گزارش‌ها…" />}
          {catalog.error && <ErrorState message={catalog.error} onRetry={catalog.reload} />}
        </Card>

        <div className="space-y-4">
          <Card className="flex flex-wrap items-end gap-3 p-4">
            <div className="w-[180px]"><PersianDatePicker label="از" value={local.from} onChange={(iso) => iso && setLocal({ ...local, from: iso })} /></div>
            <div className="w-[180px]"><PersianDatePicker label="تا" value={local.to} onChange={(iso) => iso && setLocal({ ...local, to: iso })} /></div>
            <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} disabled={!code} onClick={() => report.reload()}>اجرا</Btn>
            {(["csv", "xlsx", "pdf"] as const).map((format) => (
              <Btn key={format} size="sm" variant="soft" icon={<Download size={14} />} disabled={!code || busy} onClick={() => void exportReport(format)}>{format.toUpperCase()}</Btn>
            ))}
          </Card>

          {!code && <Empty title="یک گزارش انتخاب کنید" desc="خروجی JSON برای نمایش و CSV/XLSX/PDF برای بایگانی حسابداری در دسترس است (خروجی نیازمند مجوز finance:export است)." />}
          {code && report.loading && !report.data && <LoadingState label="در حال اجرای گزارش…" />}
          {code && report.error && <ErrorState message={report.error} onRetry={report.reload} />}

          {code && report.data && (() => {
            const result = report.data;
            return (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <p className="text-[13px] font-bold">{result.title}</p>
                <span className="text-[11.5px] text-[var(--kv-muted)]">
                  {fmtNum(result.rows.length)} سطر · {formatPersianDate(result.range.from)} تا {formatPersianDate(result.range.to)} · تولید {formatPersianDateTime(result.generatedAt)}
                </span>
              </div>
              <div className="kv-scroll overflow-x-auto">
                <table className="kv-table min-w-[720px] text-xs">
                  <thead><tr>{result.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.length === 0 && <tr><td colSpan={result.columns.length} className="text-center text-[var(--kv-muted)]">سطری در این بازه نیست.</td></tr>}
                    {result.rows.map((row, index) => (
                      <tr key={index}>
                        {result.columns.map((column) => (
                          <td key={column.key} className={cn("tabular-nums", column.kind === "money" && "font-semibold")}>
                            {column.kind === "money" ? fmtToman(row[column.key]) : text(row as Row, column.key)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {Object.keys(result.totals ?? {}).length > 0 && (
                    <tfoot>
                      <tr>
                        {result.columns.map((column) => (
                          <td key={column.key} className="font-bold tabular-nums">
                            {has(result.totals, column.key) ? fmtToman(result.totals[column.key]) : ""}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </Card>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

/* ========================== Periods & event feed ========================== */

function PeriodsTab({ flash }: { flash: Flash }) {
  const list = useFetch(() => financeOpsApi.periods(), []);
  const rows = (list.data?.items ?? []) as Row[];
  const [pending, setPending] = useState<{ code: string; action: "close" | "lock" | "reopen" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await financeOpsApi.periodAction(pending.code, pending.action, note.trim() || undefined);
      flash(`دوره ${result.code} → ${PERIOD_STATUS[result.status] ?? result.status}`);
      setPending(null); setNote(""); list.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "تغییر وضعیت دوره ناموفق بود"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <SectionHead title="دوره‌های حسابداری" desc="بسته‌شدن دوره بدون سند نامتوازن ممکن است؛ سند جدید در دوره بسته ثبت نمی‌شود" />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => list.reload()}>به‌روزرسانی</Btn>
      </Card>

      {list.loading && !list.data && <LoadingState label="در حال خواندن دوره‌ها…" />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && rows.length === 0 && <Empty title="دوره‌ای ثبت نشده" desc="دوره‌های ماهانه به‌صورت خودکار از تاریخ اسناد دفتر کل ساخته می‌شوند." />}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[860px]">
              <thead><tr><th>دوره</th><th>عنوان</th><th>شروع</th><th>پایان</th><th>وضعیت</th><th>درآمد دوره</th><th>سند</th><th>عملیات</th></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const state = text(row, "status", "");
                  return (
                    <tr key={text(row, "code")}>
                      <td className="font-mono text-[12px]">{text(row, "code")}</td>
                      <td>{text(row, "title")}</td>
                      <td className="tabular-nums">{formatPersianDate(text(row, "starts_on"))}</td>
                      <td className="tabular-nums">{formatPersianDate(text(row, "ends_on"))}</td>
                      <td><Status value={PERIOD_STATUS[state] ?? state} /></td>
                      <td className="tabular-nums">{fmtToman(row.revenue_rial)}</td>
                      <td className="tabular-nums">{fmtNum(num(row, "entries"))}</td>
                      <td>
                        <div className="flex flex-wrap gap-1.5">
                          {state === "open" && <Btn variant="soft" size="sm" icon={<Check size={14} />} onClick={() => setPending({ code: text(row, "code"), action: "close" })}>بستن دوره</Btn>}
                          {state !== "locked" && <Btn variant="soft" size="sm" icon={<ShieldCheck size={14} />} onClick={() => setPending({ code: text(row, "code"), action: "lock" })}>قفل</Btn>}
                          {state !== "open" && <Btn variant="soft" size="sm" icon={<Undo2 size={14} />} onClick={() => setPending({ code: text(row, "code"), action: "reopen" })}>بازگشایی</Btn>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={pending !== null} onClose={() => setPending(null)} title="تغییر وضعیت دوره" max="max-w-[460px]">
        <div className="space-y-3">
          <p className="text-[12.5px] text-[var(--kv-muted)]">
            دوره {pending?.code} — عملیات: {pending?.action === "close" ? "بستن" : pending?.action === "lock" ? "قفل" : "بازگشایی"}
          </p>
          <Field label="یادداشت (اختیاری)"><Input value={note} onChange={setNote} placeholder="مثلاً پایان ماه و بستن حساب‌ها" /></Field>
          <div className="flex gap-2">
            <Btn variant="accent" disabled={busy} onClick={() => void submit()}>اعمال</Btn>
            <Btn variant="soft" onClick={() => setPending(null)}>انصراف</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function EventsTab() {
  const events = useFetch(() => financeOpsApi.events(80), []);
  const rows = (events.data?.items ?? []) as Row[];
  return (
    <div className="space-y-4">
      <Card className="flex items-center justify-between p-4">
        <SectionHead title="جریان رویدادهای مالی" desc="رویدادهای دامنه (تسویه، فاکتور، پرداخت، اصلاح، حمل) از outbox خوانده می‌شوند" />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => events.reload()}>به‌روزرسانی</Btn>
      </Card>
      {events.loading && !events.data && <LoadingState label="در حال خواندن رویدادها…" />}
      {events.error && <ErrorState message={events.error} onRetry={events.reload} />}
      {events.data && rows.length === 0 && <Empty title="رویدادی ثبت نشده" desc="با نخستین پرداخت یا تسویه، رویدادها همین‌جا ظاهر می‌شوند." />}
      {rows.length > 0 && (
        <Card className="divide-y divide-[var(--kv-line)]">
          {rows.map((row) => (
            <div key={text(row, "id")} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--kv-surface-2)]"><Radio size={14} className="text-[var(--kv-accent)]" /></span>
              <div className="min-w-[200px] flex-1">
                <p className="text-[12.5px] font-bold">{text(row, "event_type")}</p>
                <p className="font-mono text-[10.5px] text-[var(--kv-muted)]">{text(row, "aggregate_type")} · {text(row, "aggregate_id")}</p>
              </div>
              <p className="max-w-[420px] flex-1 truncate text-[11.5px] text-[var(--kv-muted)]" title={JSON.stringify(row.payload)}>{JSON.stringify(row.payload)}</p>
              <span className="text-[11.5px] tabular-nums text-[var(--kv-muted)]">{formatPersianDateTime(text(row, "created_at"))}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ================================ Shell ================================ */

/* ================== Other revenue / finance settings (Prompt 4) ================== */

function OtherRevenueTab({ range }: { range: Range }) {
  const dates = apiRange(range);
  const list = useFetch(() => financeOpsApi.revenueStreams({ from: dates.from, to: dates.to }), [dates.from, dates.to]);
  if (list.loading && !list.data) return <LoadingState label="در حال خواندن جریان‌های درآمدی…" />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  const streams = list.data?.streams ?? [];
  return (
    <div className="space-y-4">
      <SectionHead title="درآمدها و خدمات جانبی" desc="هر عدد از منبع واقعی خودش خوانده می‌شود؛ سرویس بدون اتصال مالی «غیرفعال» نمایش داده می‌شود، نه صفرِ ساختگی" />
      <Card className="overflow-hidden">
        <table className="kv-table">
          <thead><tr><th>جریان درآمدی</th><th>درآمد بازه</th><th>تعداد</th><th>هزینه مستقیم</th><th>وضعیت</th></tr></thead>
          <tbody>
            {streams.map((row) => (
              <tr key={row.key}>
                <td className="font-bold">{row.title}</td>
                <td className="tabular-nums">{row.enabled ? fmtToman(row.revenueRial) : "—"}</td>
                <td className="tabular-nums">{row.enabled ? fmtNum(row.count) : "—"}</td>
                <td className="text-[12px] text-[var(--kv-muted)]">
                  {row.costRial !== null ? fmtToman(row.costRial)
                    : row.costStatus === "not_connected" ? "متصل نیست"
                    : row.costStatus === "unknown" ? "نامشخص (صادقانه)" : "ثبت نمی‌شود"}
                </td>
                <td>{row.enabled
                  ? <Status value="فعال" />
                  : <span className="text-[11.5px] font-bold text-[var(--kv-muted)]">پشتیبانی‌شده · غیرفعال</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-[var(--kv-line)] p-3 text-[11.5px] text-[var(--kv-muted)]">
          هزینه‌های انبارداری/هندلینگ/QC/پردازش در طبقه‌بندی مالی پشتیبانی می‌شوند ولی تا فعال‌سازی تجاری، هیچ مبلغی از تأمین‌کننده کسر نمی‌شود (§41).
        </p>
      </Card>
    </div>
  );
}

/** Prompt 4 (§42-§47): Try-On as a real revenue stream — admin-configurable packages,
 *  honest cost reporting (unknown stays unknown), credits through the canonical ledger. */
function TryOnFinanceTab({ flash }: { flash: Flash }) {
  const packs = useFetch(() => tryonAdminApi.packages(), []);
  const finance = useFetch(() => tryonAdminApi.finance(), []);
  const [draft, setDraft] = useState({ name: "", credits: "5", priceToman: "100000" });
  const [policyDraft, setPolicyDraft] = useState<{ freeQuota: string; salesEnabled: boolean } | null>(null);
  useEffect(() => {
    if (packs.data && !policyDraft) setPolicyDraft({ freeQuota: String(packs.data.policy.freeQuota), salesEnabled: packs.data.policy.salesEnabled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packs.data]);
  if ((packs.loading && !packs.data) || (finance.loading && !finance.data)) return <LoadingState label="در حال خواندن مالی پرو مجازی…" />;
  if (packs.error) return <ErrorState message={packs.error} onRetry={packs.reload} />;
  const f = finance.data;
  const createPack = async () => {
    try {
      const credits = Number(draft.credits || 0);
      const priceRial = String(Math.max(0, Number(draft.priceToman.replace(/\D/g, "") || 0)) * 10);
      await tryonAdminApi.createPackage({ name: draft.name.trim(), credits, priceRial });
      flash("بسته جدید ساخته شد."); setDraft({ name: "", credits: "5", priceToman: "100000" }); packs.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "ساخت بسته ناموفق بود"); }
  };
  const toggle = async (id: string, active: boolean) => {
    try { await tryonAdminApi.updatePackage(id, { active: !active }); flash(!active ? "بسته فعال شد." : "بسته غیرفعال شد."); packs.reload(); }
    catch (error) { flash(error instanceof Error ? error.message : "به‌روزرسانی ناموفق بود"); }
  };
  const savePolicy = async () => {
    if (!policyDraft) return;
    try {
      await tryonAdminApi.savePolicy({ freeQuota: Number(policyDraft.freeQuota || 0), salesEnabled: policyDraft.salesEnabled });
      flash("سیاست پرو مجازی ذخیره شد."); packs.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "ذخیره ناموفق بود"); }
  };
  return (
    <div className="space-y-4">
      <SectionHead title="سرویس پرو مجازی" desc="بسته‌های اعتبار و سهمیه رایگان، قابل تنظیم توسط ادمین — فروش از خط پرداخت یکتا و اعتبار از دفتر تغییرناپذیر خوانده می‌شود" />
      {f && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="درآمد پرداخت‌شده" value={fmtToman(f.revenueRial)} />
        <Kpi label="خرید موفق" value={fmtNum(f.paidPurchases)} />
        <Kpi label="اعتبار مصرف‌شده" value={fmtNum(f.creditsConsumed)} />
        <Kpi label="اعتبار باقی‌مانده کاربران" value={fmtNum(f.creditsOutstanding)} />
      </div>}
      {f && <Card className="p-4 text-[12px] leading-6 text-[var(--kv-muted)]">
        هزینه هر ساخت تصویر نزد سرویس آلفا: {f.generationsWithUnknownCost > 0 || f.knownGenerationCostRial === "0"
          ? <b>نامشخص — اتصال هزینه برقرار نیست (Cost Not Connected)</b>
          : <b>{fmtToman(f.knownGenerationCostRial)}</b>}؛ سود این سرویس تا اتصال هزینه واقعی، «درآمد ناخالص» گزارش می‌شود (§46).
      </Card>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="overflow-hidden">
          <table className="kv-table">
            <thead><tr><th>بسته</th><th>اعتبار</th><th>قیمت</th><th>فروش موفق</th><th>وضعیت</th><th /></tr></thead>
            <tbody>
              {(packs.data?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td className="font-bold">{row.name}</td>
                  <td className="tabular-nums">{fmtNum(row.credits)}</td>
                  <td className="tabular-nums">{fmtToman(row.price_rial)}</td>
                  <td className="tabular-nums">{fmtNum(row.paid_count)}</td>
                  <td>{row.active ? <Status value="فعال" /> : <span className="text-[11.5px] font-bold text-[var(--kv-muted)]">غیرفعال</span>}</td>
                  <td><Btn size="sm" variant="soft" onClick={() => void toggle(row.id, row.active)}>{row.active ? "غیرفعال کن" : "فعال کن"}</Btn></td>
                </tr>
              ))}
              {(packs.data?.items ?? []).length === 0 && <tr><td colSpan={6} className="p-4 text-center text-[12px] text-[var(--kv-muted)]">بسته‌ای تعریف نشده است.</td></tr>}
            </tbody>
          </table>
        </Card>
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <h4 className="text-[13px] font-bold">بسته جدید</h4>
            <Field label="نام بسته"><Input value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} /></Field>
            <Field label="تعداد اعتبار (ساخت تصویر)"><Input value={draft.credits} onChange={(v) => setDraft({ ...draft, credits: v.replace(/\D/g, "") })} /></Field>
            <Field label="قیمت (تومان)"><Input value={draft.priceToman} onChange={(v) => setDraft({ ...draft, priceToman: v.replace(/\D/g, "") })} /></Field>
            <Btn variant="accent" className="w-full" disabled={draft.name.trim().length < 2 || !Number(draft.credits) || !Number(draft.priceToman)} onClick={() => void createPack()}>ساخت بسته</Btn>
          </Card>
          {policyDraft && <Card className="space-y-3 p-4">
            <h4 className="text-[13px] font-bold">سیاست سرویس</h4>
            <Field label="سهمیه رایگان هر کاربر (یک‌بار)"><Input value={policyDraft.freeQuota} onChange={(v) => setPolicyDraft({ ...policyDraft, freeQuota: v.replace(/\D/g, "") })} /></Field>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={policyDraft.salesEnabled} onChange={(e) => setPolicyDraft({ ...policyDraft, salesEnabled: e.target.checked })} />
              <span>فروش بسته و کسر اعتبار فعال باشد</span>
            </label>
            <Btn variant="accent" className="w-full" onClick={() => void savePolicy()}>ذخیره سیاست</Btn>
          </Card>}
        </div>
      </div>
      {f && f.purchases.length > 0 && <Card className="overflow-hidden">
        <div className="border-b border-[var(--kv-line)] p-3 text-[13px] font-bold">آخرین خریدهای بسته</div>
        <table className="kv-table">
          <thead><tr><th>مرجع</th><th>خریدار</th><th>اعتبار</th><th>مبلغ</th><th>وضعیت</th><th>پرداخت</th></tr></thead>
          <tbody>
            {f.purchases.map((row) => (
              <tr key={row.reference}>
                <td className="font-mono text-[12px]">{row.reference}</td>
                <td>{row.user_name}</td>
                <td className="tabular-nums">{fmtNum(row.credits)}</td>
                <td className="tabular-nums">{fmtToman(row.price_rial)}</td>
                <td>{row.status === "paid" ? <Status value="پرداخت‌شده" /> : row.status === "pending" ? "در انتظار پرداخت" : "لغوشده"}</td>
                <td className="text-[12px] text-[var(--kv-muted)]">{row.paid_at ? formatPersianDateTime(row.paid_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>}
    </div>
  );
}

function FinancePolicyTab({ flash }: { flash: Flash }) {
  const policy = useFetch(() => settlementAdminApi.financePolicy(), []);
  const [draft, setDraft] = useState<{ holdHours: string; bankCooldownHours: string; dualControlToman: string; legacy: boolean } | null>(null);
  useEffect(() => {
    if (policy.data && !draft) setDraft({
      holdHours: String(policy.data.holdHours ?? 72),
      bankCooldownHours: String(policy.data.bankCooldownHours ?? 0),
      dualControlToman: String(tomanFromRial(String(policy.data.dualControlThresholdRial ?? "0"))),
      legacy: Boolean(policy.data.legacyWithdrawalsEnabled),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy.data]);
  if (policy.loading && !policy.data) return <LoadingState label="در حال خواندن سیاست مالی…" />;
  if (policy.error) return <ErrorState message={policy.error} onRetry={policy.reload} />;
  if (!draft) return null;
  const save = async () => {
    try {
      await settlementAdminApi.updateFinancePolicy({
        holdHours: Number(draft.holdHours || 0),
        bankCooldownHours: Number(draft.bankCooldownHours || 0),
        dualControlThresholdRial: String(Math.max(0, Number(draft.dualControlToman.replace(/\D/g, "") || 0)) * 10),
        legacyWithdrawalsEnabled: draft.legacy,
      });
      flash("سیاست مالی ذخیره شد.");
      policy.reload();
    } catch (error) { flash(error instanceof Error ? error.message : "ذخیره ناموفق بود"); }
  };
  return (
    <div className="max-w-[640px] space-y-4">
      <SectionHead title="سیاست مالی تأمین‌کننده" desc="پیکربندی سراسری Hold، دوره انتظار حساب بانکی، کنترل دوگانه و کلید قطع برداشت قدیمی" />
      <Card className="space-y-3 p-5">
        <Field label="مدت پیش‌فرض Settlement Hold (ساعت)"><Input value={draft.holdHours} onChange={(v) => setDraft({ ...draft, holdHours: v.replace(/\D/g, "") })} /></Field>
        <Field label="دوره انتظار امنیتی پس از تأیید حساب بانکی (ساعت)"><Input value={draft.bankCooldownHours} onChange={(v) => setDraft({ ...draft, bankCooldownHours: v.replace(/\D/g, "") })} /></Field>
        <Field label="آستانه کنترل دوگانه تسویه (تومان)" hint="بالاتر از این مبلغ، تأییدکننده باید غیر از ایجادکننده باشد"><Input value={draft.dualControlToman} onChange={(v) => setDraft({ ...draft, dualControlToman: v.replace(/\D/g, "") })} /></Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={draft.legacy} onChange={(e) => setDraft({ ...draft, legacy: e.target.checked })} />
          <span>برداشت قدیمی تأمین‌کننده فعال بماند <b className="text-[var(--kv-danger)]">(فقط برای دوره گذار — مدل جدید تسویه زمان‌بندی‌شده است)</b></span>
        </label>
        <Btn variant="accent" onClick={() => void save()}>ذخیره سیاست</Btn>
      </Card>
    </div>
  );
}

/* ----------------------------- shell ----------------------------- */

/** Prompt 4 (§15): final Finance Center IA — six business-facing domains.
 *  All previous capabilities keep living under one of these groups; nothing deleted. */
const GROUPS = [
  { v: "overview", label: "داشبورد", tabs: [
    { v: "dashboard", label: "نمای کسب‌وکار" },
  ] },
  { v: "domains", label: "حوزه‌های مالی", tabs: [
    { v: "accounts", label: "مالی Marketplace تأمین‌کنندگان" },
    { v: "aging", label: "مانده پرداختنی تأمین‌کنندگان" },
    { v: "streams", label: "درآمدها و خدمات جانبی" },
    { v: "tryon", label: "سرویس پرو مجازی" },
  ] },
  { v: "settlement", label: "پرداخت و تسویه", tabs: [
    { v: "supplier-settlements", label: "تسویه تأمین‌کنندگان" },
    { v: "settlements", label: "تاریخچه تسویه/پرداخت (قدیمی)" },
    { v: "advances", label: "پیش‌پرداخت‌ها (بایگانی)" },
  ] },
  { v: "docs", label: "اسناد و گزارش‌ها", tabs: [
    { v: "reports", label: "مرکز گزارش‌ها" },
  ] },
  { v: "accounting", label: "حسابداری", tabs: [
    { v: "ledger", label: "دفتر کل" },
    { v: "periods", label: "دوره‌های مالی" },
    { v: "adjustments", label: "اصلاحات حسابداری" },
    { v: "events", label: "رویدادهای مالی" },
  ] },
  { v: "settings", label: "تنظیمات مالی", tabs: [
    { v: "shipping", label: "سیاست هزینه حمل" },
    { v: "finance-policy", label: "سیاست مالی تأمین‌کننده" },
  ] },
] as const;
type GroupKey = typeof GROUPS[number]["v"];
type TabKey = typeof GROUPS[number]["tabs"][number]["v"];

const TAB_ICON: Partial<Record<TabKey, React.ReactNode>> = {
  dashboard: <Wallet size={15} />,
  "supplier-settlements": <Banknote size={15} />,
  accounts: <Building2 size={15} />,
  aging: <Scale size={15} />,
  settlements: <BadgeCheck size={15} />,
  adjustments: <Percent size={15} />,
  advances: <HandCoins size={15} />,
  shipping: <Truck size={15} />,
  reports: <FileBarChart2 size={15} />,
  periods: <CalendarClock size={15} />,
  events: <Radio size={15} />,
  streams: <HandCoins size={15} />,
  "finance-policy": <Scale size={15} />,
};

export function FinanceOpsPanel({ flash }: { flash: Flash }) {
  const [group, setGroup] = useState<GroupKey>("overview");
  const [tab, setTab] = useState<TabKey>("dashboard");
  const [range, setRange] = useState<Range>({ from: addDaysIso(todayIso(), -29), to: todayIso() });
  const [notice, setNotice] = useState<string | null>(null);

  const fire = (message: string) => {
    setNotice(message);
    flash(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 4000);
  };

  const content = useMemo(() => {
    switch (tab) {
      case "dashboard": return <DashboardTab range={range} setRange={setRange} flash={fire} />;
      case "accounts": return <AccountsTab range={range} flash={fire} />;
      case "aging": return <AgingTab />;
      case "supplier-settlements": return <SettlementCenter flash={fire} />;
      case "settlements": return <SettlementsTab range={range} flash={fire} />;
      case "adjustments": return <AdjustmentsTab flash={fire} />;
      case "advances": return <AdvancesTab />;
      case "ledger": return <FinanceLedgerPanel />;
      case "streams": return <OtherRevenueTab range={range} />;
      case "tryon": return <TryOnFinanceTab flash={fire} />;
      case "finance-policy": return <FinancePolicyTab flash={fire} />;
      case "shipping": return <ShippingTab flash={fire} />;
      case "reports": return <ReportsTab range={range} flash={fire} />;
      case "periods": return <PeriodsTab flash={fire} />;
      case "events": return <EventsTab />;
      default: return null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }
  }, [tab, range]);

  return (
    <div className="space-y-5">
      <SectionHead title="مرکز مالی" desc="داشبورد کسب‌وکار، حوزه‌های مالی، پرداخت و تسویه، اسناد و گزارش‌ها، حسابداری حرفه‌ای و تنظیمات مالی — همه از دفتر کل واحد" />
      {notice && (
        <div role="status" className="flex items-center gap-2 rounded-[10px] bg-[var(--kv-accent)]/10 px-3 py-2 text-[12.5px] font-semibold text-[var(--kv-accent)]">
          <AlertTriangle size={14} />{notice}
        </div>
      )}
      <div className="kv-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {GROUPS.map((g) => (
          <button key={g.v} onClick={() => { setGroup(g.v); setTab(g.tabs[0].v); }}
            className={cn("kv-press flex shrink-0 items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-extrabold",
              group === g.v ? "bg-[var(--kv-action)] text-[var(--kv-bg)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)] hover:text-[var(--kv-text)]")}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="kv-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {GROUPS.find((g) => g.v === group)!.tabs.map((item) => (
          <button key={item.v} onClick={() => setTab(item.v)}
            className={cn("kv-press flex shrink-0 items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-bold",
              tab === item.v ? "bg-[var(--kv-accent)]/15 text-[var(--kv-accent)]" : "bg-transparent text-[var(--kv-muted)] hover:text-[var(--kv-text)]")}>
            {TAB_ICON[item.v]}{item.label}
          </button>
        ))}
      </div>
      <div className="animate-[fadeUp_0.3s_ease]">{content}</div>
    </div>
  );
}
