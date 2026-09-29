import { useEffect, useMemo, useState } from "react";
import {
  Card, Btn, Status, SearchBox, Empty, LoadingState, ErrorState, Field, Input, Select, Textarea,
  Drawer, Segmented, SectionHead,
} from "./primitives";
import { BarList } from "./charts";
import { formatPersianDateTime, formatPersianDate } from "../data/persian-date";
import { fmtToman } from "../data/contracts";
import { supplier360Api, type SupplierActivityStatus, type Supplier360Overview } from "../data/api";
import { fmtNum } from "../data/catalog";
import {
  UserCog, Ban, CheckCircle2, FileText, History, Plus, Unlock, RefreshCw, AlertTriangle, Clock,
} from "lucide-react";

/* Supplier 360° (items 11-14): one screen per supplier that answers
 * "what is this supplier, what may they do, what do we owe them and what happened".
 * Status changes, restrictions and every number come from the server; the console
 * only decides how to display them. */

const STATUS_LABEL: Record<SupplierActivityStatus, string> = {
  pending_review: "در انتظار بررسی",
  active: "فعال",
  restricted: "محدودشده",
  suspended: "تعلیق‌شده",
  blocked: "مسدود",
  rejected: "ردشده",
};

const STATUS_TONE: Record<SupplierActivityStatus, string> = {
  pending_review: "bg-[var(--kv-warn)]/12 text-[var(--kv-warn)]",
  active: "bg-[var(--kv-success)]/12 text-[var(--kv-success)]",
  restricted: "bg-[var(--kv-warn)]/12 text-[var(--kv-warn)]",
  suspended: "bg-[var(--kv-danger)]/12 text-[var(--kv-danger)]",
  blocked: "bg-[var(--kv-danger)]/14 text-[var(--kv-danger)]",
  rejected: "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]",
};

const SCOPE_LABEL: Record<string, string> = {
  product_create: "ایجاد محصول",
  product_edit: "ویرایش محصول",
  product_publish: "انتشار محصول",
  order_intake: "پذیرش سفارش",
  withdrawal: "برداشت از کیف پول",
  settlement_request: "درخواست تسویه",
  product_limit: "سقف تعداد محصول",
  sales_limit: "سقف فروش ماهانه",
  feature: "یک قابلیت خاص",
};

export const RESTRICTION_SCOPE_OPTIONS = Object.keys(SCOPE_LABEL);

const ACTION_LABEL: Record<string, string> = {
  "supplier.activity_status_changed": "تغییر وضعیت فعالیت",
  "supplier.restriction_created": "ثبت محدودیت",
  "supplier.restriction_lifted": "رفع محدودیت",
  "supplier.action_blocked": "تلاش مسدودشده",
  "supplier.status_changed": "تغییر وضعیت همکاری",
  "supplier.document_verified": "تأیید مدرک",
  "product.created": "ثبت محصول",
  "product.updated": "ویرایش محصول",
  "product.status_changed": "تغییر وضعیت محصول",
  "invoice.created": "صدور سند",
  "invoice.issued": "صدور سند",
  "settlement.created": "ایجاد تسویه",
  "settlement.paid": "پرداخت تسویه",
};

const statusOf = (row: Record<string, unknown>) =>
  (String(row.activity_status ?? "pending_review") as SupplierActivityStatus);

export function Supplier360Panel({ flash }: { flash?: (message: string) => void }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | SupplierActivityStatus>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const response = await supplier360Api.list();
      setItems(response.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت فهرست تأمین‌کنندگان"); }
  };
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => (items ?? []).filter((row) => {
    if (statusFilter !== "all" && statusOf(row) !== statusFilter) return false;
    if (!search.trim()) return true;
    const haystack = [row.brand_name, row.legal_name, row.display_name, row.phone, row.email]
      .map((value) => String(value ?? "")).join(" ");
    return haystack.includes(search.trim());
  }), [items, search, statusFilter]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="در حال بارگذاری پرونده تأمین‌کنندگان…" />;

  const counts = items.reduce<Record<string, number>>((acc, row) => {
    acc[statusOf(row)] = (acc[statusOf(row)] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {(Object.keys(STATUS_LABEL) as SupplierActivityStatus[]).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(statusFilter === status ? "all" : status)}
            className={`kv-press rounded-[14px] border p-3 text-right transition ${
              statusFilter === status ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/6" : "border-[var(--kv-line)] bg-[var(--kv-surface)]"
            }`}
          >
            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
            <p className="mt-2 text-[18px] font-extrabold tabular-nums">{fmtNum(counts[status] ?? 0)}</p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox placeholder="جست‌وجوی نام، برند، تلفن…" value={search} onChange={setSearch} />
        {statusFilter !== "all" && <Btn variant="ghost" size="sm" onClick={() => setStatusFilter("all")}>حذف فیلتر</Btn>}
        <span className="mr-auto text-[12px] text-[var(--kv-muted)]">
          {fmtNum(filtered.length)} از {fmtNum(items.length)} تأمین‌کننده
        </span>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>بروزرسانی</Btn>
      </div>

      {filtered.length === 0
        ? <Empty title="تأمین‌کننده‌ای یافت نشد" desc="با فیلترها و عبارت جست‌وجو بازی کنید یا از درخواست‌های همکاری تأیید کنید." />
        : (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {filtered.map((row) => {
              const status = statusOf(row);
              const id = String(row.user_id);
              return (
                <Card key={id} hover className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-[#1B2A4A] text-[15px] font-bold text-[#E8D9C3]">
                        {String(row.brand_name ?? row.display_name ?? "?").charAt(0)}
                      </span>
                      <div>
                        <p className="text-[15px] font-extrabold">{String(row.brand_name ?? row.display_name ?? "—")}</p>
                        <p className="text-[11.5px] text-[var(--kv-muted)]">
                          {String(row.legal_name ?? row.display_name ?? "")} · کارمزد {String(row.commission_percent ?? "0")}٪
                        </p>
                      </div>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-[11.5px] font-bold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
                  </div>
                  {row.activity_reason ? (
                    <p className="mt-3 rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2 text-[11.5px] text-[var(--kv-ink-2)]">
                      دلیل: {String(row.activity_reason)}
                    </p>
                  ) : null}
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2">
                      <p className="text-[13px] font-extrabold">{fmtNum(Number(row.version ?? 1))}</p>
                      <p className="text-[10.5px] text-[var(--kv-muted)]">نسخه پروفایل</p>
                    </div>
                    <div className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2">
                      <p className="text-[13px] font-extrabold">{row.contract_status === "signed" ? "امضاشده" : "—"}</p>
                      <p className="text-[10.5px] text-[var(--kv-muted)]">قرارداد</p>
                    </div>
                    <div className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2">
                      <p className="text-[13px] font-extrabold tabular-nums">
                        {row.activity_restricted_until ? formatPersianDate(String(row.activity_restricted_until)) : "—"}
                      </p>
                      <p className="text-[10.5px] text-[var(--kv-muted)]">پایان محدودیت</p>
                    </div>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Btn variant="accent" size="sm" icon={<UserCog size={14} />} onClick={() => setSelected(id)}>پرونده ۳۶۰°</Btn>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

      {selected && (
        <Supplier360Drawer
          supplierId={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { void load(); flash?.("وضعیت تأمین‌کننده بروزرسانی شد"); }}
        />
      )}
    </div>
  );
}

/* ------------------------------- 360° drawer ------------------------------- */

function Supplier360Drawer({ supplierId, onClose, onChanged }: {
  supplierId: string; onClose: () => void; onChanged: () => void;
}) {
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Supplier360Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"overview" | "restrictions" | "finance" | "timeline">("overview");
  const [finance, setFinance] = useState<Awaited<ReturnType<typeof supplier360Api.finance>> | null>(null);

  const load = async () => {
    setError(null);
    try { setData(await supplier360Api.overview(supplierId, days)); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت پرونده"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [supplierId, days]);
  useEffect(() => {
    if (tab !== "finance") return;
    let live = true;
    void (async () => {
      try {
        const detail = await supplier360Api.finance(supplierId, 30);
        if (live) setFinance(detail);
      } catch (e) { if (live) setError(e instanceof Error ? e.message : "خطا در دریافت پرونده مالی"); }
    })();
    return () => { live = false; };
  }, [tab, supplierId]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await task(); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "عملیات ناموفق بود"); }
    finally { setBusy(false); }
  };

  if (error && !data) return <Drawer open onClose={onClose} title="پرونده تأمین‌کننده" wide><ErrorState message={error} onRetry={load} /></Drawer>;
  if (!data) return <Drawer open onClose={onClose} title="پرونده تأمین‌کننده" wide><LoadingState label="در حال بارگذاری پرونده ۳۶۰°…" /></Drawer>;

  const status = data.status.current;
  const performance = data.performance as Record<string, unknown>;
  const productsByStatus = (performance.products as { status: string; count: number }[] | undefined) ?? [];

  return (
    <Drawer open onClose={onClose} wide title={`پرونده ۳۶۰° — ${String(data.supplier.brand_name ?? data.supplier.display_name ?? "")}`}>
      <div className="space-y-5">
        {error && (
          <div className="flex items-start gap-2 rounded-[12px] border border-[var(--kv-danger)]/40 bg-[var(--kv-danger)]/6 px-3 py-2 text-[12.5px]">
            <AlertTriangle size={15} className="mt-0.5 text-[var(--kv-danger)]" /><span>{error}</span>
          </div>
        )}

        {/* status card ------------------------------------------------ */}
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${STATUS_TONE[status]}`}>{data.status.label}</span>
              {data.status.restrictedUntil && (
                <span className="text-[11.5px] text-[var(--kv-muted)]">
                  تا {formatPersianDateTime(data.status.restrictedUntil)}
                </span>
              )}
              {data.status.changedAt && (
                <span className="text-[11.5px] text-[var(--kv-muted)]">آخرین تغییر {formatPersianDateTime(data.status.changedAt)}</span>
              )}
            </div>
            <Segmented<"7" | "30" | "90" | "365">
              options={[{ v: "7", label: "۷ روز" }, { v: "30", label: "۳۰ روز" }, { v: "90", label: "۹۰ روز" }, { v: "365", label: "۱ سال" }]}
              value={String(days) as "7" | "30" | "90" | "365"} onChange={(v) => setDays(Number(v))} />
          </div>
          {data.status.reason && (
            <p className="mt-3 rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2 text-[12px]">
              <span className="text-[var(--kv-muted)]">دلیل وضعیت:</span> {data.status.reason}
              {data.status.note ? <span className="text-[var(--kv-muted)]"> — {data.status.note}</span> : null}
            </p>
          )}
          <StatusActions busy={busy} onRun={run} supplierId={supplierId} current={status} />
        </Card>

        {/* KPIs ------------------------------------------------------- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="p-4">
            <p className="text-[11.5px] text-[var(--kv-muted)]">مانده پرداختنی</p>
            <p className="mt-1 text-[16px] font-extrabold tabular-nums">{fmtToman(data.financeSummary.payableRial)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-[11.5px] text-[var(--kv-muted)]">قابل پرداخت</p>
            <p className="mt-1 text-[16px] font-extrabold tabular-nums">{fmtToman(data.financeSummary.availableRial)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-[11.5px] text-[var(--kv-muted)]">فروش {fmtNum(days)} روز</p>
            <p className="mt-1 text-[16px] font-extrabold tabular-nums">
              {fmtToman((performance.orders as { gross_rial?: string } | undefined)?.gross_rial)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-[11.5px] text-[var(--kv-muted)]">میانگین زمان تحویل</p>
            <p className="mt-1 text-[16px] font-extrabold tabular-nums">{fmtNum(Number(performance.avg_delivery_days ?? 0))} روز</p>
          </Card>
        </div>

        <Segmented<"overview" | "restrictions" | "finance" | "timeline">
          options={[
            { v: "overview", label: "عملکرد و اسناد" },
            { v: "restrictions", label: `محدودیت‌ها (${fmtNum(data.restrictions.filter((r) => r.status === "active").length)})` },
            { v: "finance", label: "مالی" },
            { v: "timeline", label: "تایم‌لاین" },
          ]}
          value={tab} onChange={setTab} />

        {tab === "overview" && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Card className="p-4">
                <SectionHead title="شاخص‌های عملکرد" desc="محاسبه‌شده در سرور از سفارش‌ها، رویدادها و مرجوعی‌ها" />
                <div className="mt-3 space-y-2 text-[12.5px]">
                  {[
                    ["سطرهای تحویل‌شده", fmtNum(Number(performance.delivered_lines ?? 0))],
                    ["سطرهای لغوشده", fmtNum(Number(performance.cancelled_lines ?? 0))],
                    ["درخواست مرجوعی", fmtNum(Number(performance.return_requests ?? 0))],
                    ["سفارش‌های بازگشتی", fmtNum(Number(performance.returned_orders ?? 0))],
                    ["سفارش ۳۰ روز اخیر", fmtNum(Number(performance.orders_30d ?? 0))],
                    ["مغایرت باز تسویه", fmtNum(Number(performance.open_exceptions ?? 0))],
                    ["سند مالی ۳۶۰", fmtNum(Number((performance.invoices as { invoices?: number } | undefined)?.invoices ?? 0))],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between rounded-[10px] bg-[var(--kv-surface-2)]/60 px-3 py-2">
                      <span className="text-[var(--kv-muted)]">{label}</span>
                      <span className="font-extrabold tabular-nums">{value}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="p-4">
                <SectionHead title="محصولات" desc="توزیع وضعیت محصولات تأمین‌کننده" />
                <div className="mt-3">
                  {productsByStatus.length
                    ? <BarList items={productsByStatus.map((row) => ({ label: row.status, value: row.count }))} />
                    : <p className="text-[12.5px] text-[var(--kv-muted)]">محصولی ثبت نشده است.</p>}
                </div>
              </Card>
            </div>

            <Card className="overflow-hidden">
              <div className="px-4 py-3"><p className="text-[13px] font-bold">مدارک پروفایل</p></div>
              <div className="overflow-x-auto">
                <table className="kv-table min-w-[520px] text-xs">
                  <thead><tr><th>نوع</th><th>عنوان</th><th>وضعیت تأیید</th><th>تاریخ</th></tr></thead>
                  <tbody>
                    {data.documents.length === 0 && <tr><td colSpan={4} className="text-center text-[var(--kv-muted)]">مدرکی بارگذاری نشده است.</td></tr>}
                    {data.documents.map((doc) => (
                      <tr key={String(doc.id)}>
                        <td>{String(doc.doc_type)}</td>
                        <td>{String(doc.title ?? "—")}</td>
                        <td>{doc.verified ? <Status value="تأییدشده" /> : <Status value="در انتظار" />}</td>
                        <td className="tabular-nums">{formatPersianDate(String(doc.created_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {tab === "restrictions" && (
          <RestrictionsTab supplierId={supplierId} overview={data} busy={busy} run={run} />
        )}

        {tab === "finance" && (
          <div className="space-y-4">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3">
                <p className="text-[13px] font-bold">گردش حساب تأمین‌کننده</p>
                <span className="text-[11.5px] text-[var(--kv-muted)]">
                  مانده پرداختنی: {fmtToman(data.finance.pending_payable_rial)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="kv-table min-w-[680px] text-xs">
                  <thead><tr><th>تاریخ</th><th>رویداد</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>مرجع</th></tr></thead>
                  <tbody>
                    {(finance?.entries ?? []).length === 0 && (
                      <tr><td colSpan={6} className="text-center text-[var(--kv-muted)]">گردشی ثبت نشده است.</td></tr>
                    )}
                    {(finance?.entries ?? []).map((entry) => (
                      <tr key={String(entry.id)}>
                        <td className="tabular-nums">{formatPersianDate(String(entry.occurred_at))}</td>
                        <td>{String(entry.event)}</td>
                        <td className="tabular-nums">{entry.direction === "debit" ? fmtToman(entry.amount_rial) : "—"}</td>
                        <td className="tabular-nums">{entry.direction === "credit" ? fmtToman(entry.amount_rial) : "—"}</td>
                        <td className="tabular-nums">{fmtToman(entry.balance_after_rial)}</td>
                        <td className="font-mono text-[11px]">{String(entry.reference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="overflow-hidden">
              <div className="px-4 py-3"><p className="text-[13px] font-bold">تسویه‌ها</p></div>
              <div className="overflow-x-auto">
                <table className="kv-table min-w-[620px] text-xs">
                  <thead><tr><th>مرجع</th><th>وضعیت</th><th>مغایرت‌یابی</th><th>خالص</th><th>تاریخ</th></tr></thead>
                  <tbody>
                    {(finance?.settlements ?? []).length === 0 && (
                      <tr><td colSpan={5} className="text-center text-[var(--kv-muted)]">تسویه‌ای ثبت نشده است.</td></tr>
                    )}
                    {(finance?.settlements ?? []).map((row) => (
                      <tr key={String(row.id)}>
                        <td className="font-mono text-[11px]">{String(row.reference)}</td>
                        <td>{String(row.status)}</td>
                        <td>{String(row.reconciliation_status)}</td>
                        <td className="tabular-nums">{fmtToman(row.net_rial)}</td>
                        <td className="tabular-nums">{formatPersianDate(String(row.created_at))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {tab === "timeline" && (
          <Card className="p-4">
            <SectionHead title="تایم‌لاین یکپارچه" desc="تغییر وضعیت‌ها، محدودیت‌ها، اسناد و تلاش‌های مسدودشده" />
            <ol className="mt-4 space-y-3">
              {data.timeline.map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    event.action === "supplier.action_blocked" ? "bg-[var(--kv-danger)]/12 text-[var(--kv-danger)]"
                      : event.action.includes("status") ? "bg-[var(--kv-accent)]/12 text-[var(--kv-accent)]"
                        : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]"
                  }`}>
                    {event.action === "supplier.action_blocked" ? <Ban size={14} />
                      : event.action.includes("status") ? <History size={14} /> : <FileText size={14} />}
                  </span>
                  <div className="flex-1">
                    <p className="text-[12.5px] font-bold">{ACTION_LABEL[event.action] ?? event.action}</p>
                    <p className="text-[11.5px] text-[var(--kv-muted)]">
                      {event.actor ?? "سیستم"} · {formatPersianDateTime(event.at)}
                      {event.resourceId ? ` · ${event.resourceType}/${event.resourceId.slice(0, 8)}` : ""}
                    </p>
                    {event.action === "supplier.action_blocked" && event.detail ? (
                      <p className="mt-1 rounded-[8px] bg-[var(--kv-surface-2)]/70 px-2 py-1 text-[11px]">
                        {String((event.detail as { reason?: string }).reason ?? "")}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
              {data.timeline.length === 0 && <li className="text-[12.5px] text-[var(--kv-muted)]">رویدادی ثبت نشده است.</li>}
            </ol>
          </Card>
        )}
      </div>
    </Drawer>
  );
}

/* ---------------------------- status actions ---------------------------- */

function StatusActions({ supplierId, current, busy, onRun }: {
  supplierId: string; current: SupplierActivityStatus; busy: boolean; onRun: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const [target, setTarget] = useState<SupplierActivityStatus | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [duration, setDuration] = useState("");

  return (
    <div className="mt-4 grid gap-3 rounded-[12px] border border-[var(--kv-line)] p-3 md:grid-cols-4">
      <Field label="وضعیت جدید">
        <Select
          options={["", ...(Object.keys(STATUS_LABEL) as SupplierActivityStatus[]).filter((s) => s !== current)]}
          value={target}
          onChange={(value) => setTarget(value as SupplierActivityStatus | "")}
        />
      </Field>
      <Field label="دلیل (اجباری)" hint="در تاریخچه و تایم‌لاین ثبت می‌شود">
        <Input value={reason} onChange={setReason} placeholder="مثلاً تخلف کیفی یا تأیید مدارک" />
      </Field>
      <Field label="یادداشت" hint="برای فعال‌سازی، یادداشت اجباری است">
        <Input value={note} onChange={setNote} placeholder="توضیح تکمیلی" />
      </Field>
      <Field label="مدت محدودیت (روز)" hint="خالی = بدون پایان">
        <Input value={duration} onChange={setDuration} placeholder="۳۰" />
      </Field>
      <div className="md:col-span-4 flex justify-end">
        <Btn
          variant="accent" size="sm" disabled={busy || !target || reason.trim().length < 3}
          icon={<CheckCircle2 size={14} />}
          onClick={() => void onRun(() => supplier360Api.setActivityStatus(supplierId, {
            status: target as SupplierActivityStatus,
            reason: reason.trim(),
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(duration.trim() ? { durationDays: Number(duration) } : {}),
          }))}
        >
          ثبت تغییر وضعیت
        </Btn>
      </div>
    </div>
  );
}

/* --------------------------- restrictions tab --------------------------- */

function RestrictionsTab({ supplierId, overview, busy, run }: {
  supplierId: string; overview: Supplier360Overview; busy: boolean; run: (task: () => Promise<unknown>) => Promise<void>;
}) {
  const [scope, setScope] = useState("product_create");
  const [reason, setReason] = useState("");
  const [limitValue, setLimitValue] = useState("");
  const [duration, setDuration] = useState("");
  const [liftNote, setLiftNote] = useState("");

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionHead title="محدودیت جدید" desc="هر محدودیت بلافاصله در سرور اعمال می‌شود (ایجاد/ویرایش/انتشار، سفارش، برداشت، تسویه، سقف‌ها)" />
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="دامنه محدودیت">
            <Select options={RESTRICTION_SCOPE_OPTIONS} value={scope} onChange={setScope} />
          </Field>
          <Field label="دلیل (اجباری)">
            <Input value={reason} onChange={setReason} placeholder="مثلاً شکایت مالی باز" />
          </Field>
          <Field label="مقدار حد (سقف‌ها)" hint="برای product_limit و sales_limit">
            <Input value={limitValue} onChange={setLimitValue} placeholder="۲۵" />
          </Field>
          <Field label="مدت (روز)" hint="خالی = بدون پایان">
            <Input value={duration} onChange={setDuration} placeholder="۳۰" />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Btn variant="soft" size="sm" icon={<Plus size={14} />} disabled={busy || reason.trim().length < 3}
            onClick={() => void run(() => supplier360Api.addRestriction(supplierId, {
              scope, reason: reason.trim(),
              ...(limitValue.trim() ? { limitValue: limitValue.trim() } : {}),
              ...(duration.trim() ? { durationDays: Number(duration) } : {}),
            }))}>
            ثبت محدودیت
          </Btn>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-[13px] font-bold">محدودیت‌ها</p>
          <span className="text-[11.5px] text-[var(--kv-muted)]">
            سقف محصول: {fmtNum(Number(overview.caps.product_caps))} · سقف فروش: {fmtNum(Number(overview.caps.sales_caps))}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[720px] text-xs">
            <thead><tr><th>دامنه</th><th>دلیل</th><th>حد</th><th>وضعیت</th><th>انقضا</th><th>ثبت‌کننده</th><th></th></tr></thead>
            <tbody>
              {overview.restrictions.length === 0 && (
                <tr><td colSpan={7} className="text-center text-[var(--kv-muted)]">محدودیتی ثبت نشده است.</td></tr>
              )}
              {overview.restrictions.map((row) => (
                <tr key={String(row.id)}>
                  <td>{SCOPE_LABEL[String(row.scope)] ?? String(row.scope)}</td>
                  <td>{String(row.reason)}</td>
                  <td className="tabular-nums">{row.limit_value ? fmtNum(Number(row.limit_value)) : "—"}</td>
                  <td>{String(row.status) === "active" ? <Status value="فعال" /> : <Status value="رفع‌شده" />}</td>
                  <td className="tabular-nums">{row.expires_at ? formatPersianDate(String(row.expires_at)) : "بدون پایان"}</td>
                  <td>{String(row.created_by_name ?? "—")}</td>
                  <td>
                    {row.status === "active" && (
                      <Btn variant="ghost" size="sm" icon={<Unlock size={13} />} disabled={busy || liftNote.trim().length < 3}
                        onClick={() => void run(() => supplier360Api.liftRestriction(supplierId, String(row.id), liftNote.trim()))}>
                        رفع
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-[var(--kv-line)] px-4 py-3">
          <Field label="یادداشت رفع محدودیت (اجباری)">
            <Textarea value={liftNote} onChange={setLiftNote} rows={2} placeholder="دلیل رفع محدودیت — در حسابرسی ثبت می‌شود" />
          </Field>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">تاریخچه وضعیت</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[620px] text-xs">
            <thead><tr><th>از</th><th>به</th><th>دلیل</th><th>تا</th><th>تاریخ</th></tr></thead>
            <tbody>
              {overview.statusHistory.length === 0 && (
                <tr><td colSpan={5} className="text-center text-[var(--kv-muted)]">تغییری ثبت نشده است.</td></tr>
              )}
              {overview.statusHistory.map((row) => (
                <tr key={String(row.id)}>
                  <td>{STATUS_LABEL[String(row.from_status) as SupplierActivityStatus] ?? String(row.from_status ?? "—")}</td>
                  <td>{STATUS_LABEL[String(row.to_status) as SupplierActivityStatus] ?? String(row.to_status)}</td>
                  <td>{String(row.reason)}</td>
                  <td className="tabular-nums">{row.restricted_until ? formatPersianDate(String(row.restricted_until)) : "—"}</td>
                  <td className="tabular-nums">{formatPersianDateTime(String(row.created_at))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------ supplier picker ------------------------------ */

/** Shared supplier selector used by the finance and document modules. */
export function useSupplierOptions() {
  const [options, setOptions] = useState<{ v: string; label: string }[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await supplier360Api.list();
        if (!live) return;
        setOptions(response.items.map((row) => ({
          v: String(row.user_id),
          label: `${String(row.brand_name ?? row.display_name ?? "")} — ${STATUS_LABEL[statusOf(row)]}`,
        })));
      } catch { if (live) setOptions([]); }
    })();
    return () => { live = false; };
  }, []);
  return options;
}

/* ------------------------------ small helpers ------------------------------ */

export function SupplierStatusChip({ status }: { status: string }) {
  const key = (status in STATUS_LABEL ? status : "pending_review") as SupplierActivityStatus;
  return <span className={`rounded-full px-3 py-1 text-[11.5px] font-bold ${STATUS_TONE[key]}`}>{STATUS_LABEL[key]}</span>;
}

export const supplierIcons = { UserCog, Clock };
