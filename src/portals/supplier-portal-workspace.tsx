import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Archive, Boxes, ClipboardList, History as HistoryIcon, LayoutDashboard, Layers3, LogOut, Moon, Package, Plus,
  RefreshCw, Settings, ShieldCheck, Sun, Warehouse,
} from "lucide-react";
import { Btn, Card, Empty, ErrorState, LoadingState } from "../components/primitives";
import { SupplierOffersPanel } from "../components/supplier-wholesale-panel";
import { SupplierRequestsPortal } from "../components/supplier-requests-portal";
import { SupplierSupplyRequestsPanel } from "../components/supplier-supply-requests-panel";
import { SupplierProductSeriesAuthoring } from "../components/supplier-product-series-authoring";
import { supplierConsignmentApi, supplierPortalApi, type SupplierPortalDashboard, type SupplierPortalHistoryItem, type SupplierPortalProduct } from "../data/api";
import { SupplierProfileSettings } from "./supplier-profile-settings";
import { cn } from "../utils/cn";

type Tab = "dashboard" | "supply" | "products" | "stock" | "capacity" | "requests" | "history" | "account";
type Props = { dark: boolean; setDark: (value: boolean) => void; supplierName: string; onLogout: () => void };
type StockRow = Record<string, unknown>;
type Flash = (message: string) => void;

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const money = (rial: string | null | undefined) => {
  if (!rial) return "—";
  try { return `${new Intl.NumberFormat("fa-IR").format(BigInt(rial) / 10n)} تومان`; } catch { return "—"; }
};
const PRODUCT_STATUS: Record<string, string> = {
  published: "منتشرشده در بازارچه عمده", pending: "در انتظار بازبینی کلبه", draft: "پیش‌نویس",
  rejected: "نیازمند اصلاح", archived: "بایگانی‌شده",
};
const RESPONSE_STATUS: Record<string, string> = {
  unanswered: "در انتظار پاسخ", accepted: "پذیرفته‌شده", revised: "پیشنهاد اصلاح؛ منتظر خریدار",
  rejected: "رد شده؛ نیازمند بازتخصیص", committed: "تعهد نهایی", ready: "آماده ارسال به کلبه",
  cancelled: "لغو تعهد؛ نیاز سفارش حفظ شد",
};
const RESPONSE_STYLE: Record<string, string> = {
  unanswered: "bg-amber-100 text-amber-800", accepted: "bg-sky-100 text-sky-800",
  revised: "bg-violet-100 text-violet-800", rejected: "bg-red-100 text-red-700",
  committed: "bg-indigo-100 text-indigo-800", ready: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-red-100 text-red-700",
};
const tabs: { id: Tab; title: string; icon: ReactNode }[] = [
  { id: "dashboard", title: "داشبورد", icon: <LayoutDashboard size={17} /> },
  { id: "supply", title: "تخصیص و تأمین OMS", icon: <ClipboardList size={17} /> },
  { id: "products", title: "محصولات و سری‌ها", icon: <Package size={17} /> },
  { id: "stock", title: "موجودی من نزد کلبه", icon: <Warehouse size={17} /> },
  { id: "capacity", title: "ظرفیت اعلامی", icon: <Layers3 size={17} /> },
  { id: "requests", title: "درخواست‌های قبلی", icon: <Archive size={17} /> },
  { id: "history", title: "تاریخچه تأمین", icon: <HistoryIcon size={17} /> },
  { id: "account", title: "حساب و پروفایل", icon: <Settings size={17} /> },
];

function Dashboard({ supplierName, onNavigate, flash }: { supplierName: string; onNavigate: (tab: Tab) => void; flash: Flash }) {
  const [data, setData] = useState<SupplierPortalDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setData(await supplierPortalApi.dashboard()); }
    catch (e) { setError(e instanceof Error ? e.message : "داشبورد تأمین‌کننده دریافت نشد."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  void flash;
  if (!data) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState label="در حال دریافت اطلاعات واقعی تأمین‌کننده…" />;

  const metrics = [
    { title: "درخواست باز OMS", value: data.supplyRequests.open, note: "متصل به تخصیص سفارش مادر", icon: <ClipboardList size={17} />, target: "supply" as Tab },
    { title: "محصولات من", value: data.products.total, note: `${fa(data.products.published)} منتشر · ${fa(data.products.pending)} در بررسی`, icon: <Package size={17} />, target: "products" as Tab },
    { title: "تعهد تأمین‌شده", value: data.supplyRequests.committedSeries, note: "سری متعهدشده؛ نه موجودی فیزیکی", icon: <ShieldCheck size={17} />, target: "supply" as Tab },
    { title: "موجودی فیزیکی نزد کلبه", value: data.stockAtKolbeSeries, note: "مالکیت متعلق به شما؛ WMS کلبه", icon: <Boxes size={17} />, target: "stock" as Tab },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-[18px] font-extrabold">خوش آمدید، {supplierName}</h2><p className="mt-1 text-[12px] text-[var(--kv-muted)]">اطلاعات این صفحه از پروفایل، OMS، کاتالوگ، ظرفیت و WMS کلبه بارگذاری می‌شود.</p></div>
        <Btn size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => <button key={metric.title} onClick={() => onNavigate(metric.target)} className="text-right">
          <Card className="h-full p-4 transition hover:-translate-y-0.5 hover:border-[var(--kv-line-strong)]">
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{metric.icon}</span>
            <p className="mt-3 text-[23px] font-extrabold tabular-nums">{fa(metric.value)}</p>
            <p className="text-[12px] font-bold">{metric.title}</p><p className="mt-1 text-[10.5px] leading-5 text-[var(--kv-muted)]">{metric.note}</p>
          </Card>
        </button>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-2"><div><h3 className="text-[14px] font-extrabold">ظرفیت اعلامی (تعهد، نه موجودی)</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">اعداد اعلامی و رزروشده مستقل از موجودی فیزیکی WMS هستند.</p></div><Layers3 size={18} className="text-[var(--kv-accent)]" /></div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[11px]">
            <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-3"><b className="block text-[17px] tabular-nums">{fa(data.capacity.declared)}</b><span>اعلامی</span></div>
            <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-3"><b className="block text-[17px] tabular-nums">{fa(data.capacity.reserved)}</b><span>رزروشده OMS</span></div>
            <div className="rounded-[10px] bg-emerald-50 p-3 text-emerald-800"><b className="block text-[17px] tabular-nums">{fa(data.capacity.availableToRequest)}</b><span>قابل درخواست</span></div>
          </div>
          <Btn size="sm" variant="soft" className="mt-4" onClick={() => onNavigate("capacity")}>مدیریت ظرفیت اعلامی</Btn>
        </Card>
        <Card className="p-5">
          <div className="flex items-start justify-between gap-2"><div><h3 className="text-[14px] font-extrabold">پیشرفت تأمین</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">آماده‌بودن برای ارسال فقط یک وضعیت عملیاتی است؛ رسید، QC یا موجودی WMS ایجاد نمی‌کند.</p></div><ShieldCheck size={18} className="text-[var(--kv-success)]" /></div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-[11.5px]">
            <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-3"><dt className="text-[var(--kv-muted)]">سری‌های آماده برای کلبه</dt><dd className="mt-1 text-[17px] font-extrabold tabular-nums">{fa(data.supplyRequests.readySeries)}</dd></div>
            <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-3"><dt className="text-[var(--kv-muted)]">سری‌های سری‌بندی‌شده</dt><dd className="mt-1 text-[17px] font-extrabold tabular-nums">{fa(data.products.series)}</dd></div>
          </dl>
          <Btn size="sm" variant="soft" className="mt-4" onClick={() => onNavigate("supply")}>مشاهده درخواست‌های متصل به OMS</Btn>
        </Card>
      </div>
      <div className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 px-4 py-3 text-[11.5px] leading-6 text-[var(--kv-muted)]">
        پذیرش درخواست ظرفیت را در OMS رزرو می‌کند و پرداخت/تخصیص را در همان سفارش مادر به‌روزرسانی می‌کند. این کار موجودی کلبه، رسید، مقدار دریافتی یا QC را تغییر نمی‌دهد.
      </div>
    </div>
  );
}

function ProductsAndSeries({ onNavigate, supplierName, flash }: { onNavigate: (tab: Tab) => void; supplierName: string; flash: Flash }) {
  const [items, setItems] = useState<SupplierPortalProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authoring, setAuthoring] = useState<{ product?: SupplierPortalProduct } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems((await supplierPortalApi.products()).items); }
    catch (e) { setError(e instanceof Error ? e.message : "محصولات تأمین‌کننده دریافت نشد."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!items) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState label="در حال دریافت محصولات و سری‌های خودتان…" />;
  const saved = async () => { setAuthoring(null); await load(); };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-[15px] font-extrabold">کاتالوگ و سری‌های متعلق به شما</h2><p className="text-[11.5px] text-[var(--kv-muted)]">پیش‌نویس و محصول در انتظار بازبینی هم در این فهرست هستند.</p></div>
        <div className="flex flex-wrap gap-2">
          <Btn size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCw size={14} />}>به‌روزرسانی</Btn>
          <Btn size="sm" variant="accent" onClick={() => setAuthoring({})} icon={<Plus size={14} />}>ثبت محصول و سری</Btn>
        </div>
      </div>
      {authoring && <SupplierProductSeriesAuthoring key={authoring.product?.id ?? "new-supplier-product"}
        supplierName={supplierName} initialProduct={authoring.product} onCancel={() => setAuthoring(null)} onSaved={() => void saved()} flash={flash} />}
      {!items.length && <Empty title="هنوز محصولی برای حساب شما ثبت نشده" desc="برای ساخت کاتالوگ عمده و تعریف سری، محصول جدید ثبت کنید." action={<Btn size="sm" variant="soft" onClick={() => onNavigate("requests")}>مشاهده درخواست‌های قبلی</Btn>} />}
      {items.map((product) => (
        <Card key={product.id} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-3">
            <div><h3 className="text-[14px] font-extrabold">{product.name}</h3><p className="mt-0.5 text-[11px] text-[var(--kv-muted)]">{product.brand} · {product.category}</p></div>
            <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[var(--kv-surface)] px-3 py-1 text-[10.5px] font-bold">{PRODUCT_STATUS[product.status] ?? "در حال بررسی"}</span>
              <Btn size="sm" variant="soft" onClick={() => setAuthoring({ product })} icon={<Layers3 size={14} />}>ویرایش سری‌ها</Btn>
            </div>
          </div>
          <div className="space-y-2 p-4">
            {!product.series.length && <p className="text-[11.5px] text-[var(--kv-muted)]">برای این محصول هنوز قالب سری ثبت نشده است.</p>}
            {product.series.map((series) => (
              <div key={series.id} className="grid gap-2 rounded-[11px] border border-[var(--kv-line)] p-3 text-[11.5px] sm:grid-cols-[1fr_auto] sm:items-center">
                <div><div className="flex flex-wrap items-center gap-2"><b>{series.name}</b>{series.colorLabel && <span className="text-[var(--kv-muted)]">· {series.colorLabel}</span>}<span className={cn("rounded-full px-2 py-0.5 text-[10px]", series.active ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600")}>{series.active ? "فعال" : "غیرفعال"}</span></div>
                  <p className="mt-1 text-[10.5px] leading-5 text-[var(--kv-muted)]">ترکیب: {fa(series.seriesCount)} تکه · حداقل سفارش: {fa(series.minOrderSeries)} سری</p></div>
                <div className="sm:text-left"><span className="text-[10px] text-[var(--kv-muted)]">قیمت پایه سری</span><b className="block tabular-nums">{money(series.pricePerSeriesRial)}</b></div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function StockAtKolbe() {
  const [items, setItems] = useState<StockRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems((await supplierConsignmentApi.supplierStock({ limit: 100 })).items); }
    catch (e) { setError(e instanceof Error ? e.message : "موجودی نزد کلبه دریافت نشد."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!items) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState label="در حال دریافت موجودی فیزیکی متعلق به شما نزد کلبه…" />;
  return (
    <div className="space-y-4">
      <Card className="p-4 text-[11.5px] leading-6 text-[var(--kv-muted)]"><b className="text-[var(--kv-ink)]">موجودی فیزیکی مالکیت شماست و کلبه نگهدارنده آن است.</b> این صفحه فقط‌خواندنی است؛ ظرفیت بیرونی OMS در این عدد ادغام نشده و پذیرش درخواست تأمین نیز موجودی WMS را تغییر نمی‌دهد.</Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 p-4"><div><h3 className="text-[13px] font-extrabold">مانده فیزیکی سری‌ها در انبار کلبه</h3><p className="text-[10.5px] text-[var(--kv-muted)]">قابل استفاده = موجود − رزرو − آسیب‌دیده/قرنطینه</p></div><Btn size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCw size={14} />}>به‌روزرسانی</Btn></div>
        {!items.length && <div className="p-4 pt-0"><Empty title="موجودی فیزیکی نزد کلبه ثبت نشده" desc="ظرفیت اعلامی سفارش‌ها در این بخش دیده نمی‌شود." /></div>}
        {!!items.length && <div className="overflow-x-auto"><table className="kv-table min-w-[720px] w-full text-xs"><thead><tr><th>محصول / سری</th><th>انبار</th><th>موجود</th><th>رزرو</th><th>آسیب‌دیده</th><th>قابل استفاده</th></tr></thead><tbody>
          {items.map((row) => <tr key={`${String(row.series_template_id)}-${String(row.warehouse_id)}`}>
            <td><b>{String(row.product_name ?? "—")}</b><p className="text-[10.5px] text-[var(--kv-muted)]">{String(row.series_template_name ?? "")}{row.color_label ? ` · ${String(row.color_label)}` : ""}</p></td>
            <td>{String(row.warehouse_name ?? "—")}</td><td className="tabular-nums">{fa(Number(row.on_hand ?? 0))}</td>
            <td className="tabular-nums">{fa(Number(row.reserved ?? 0))}</td><td className="tabular-nums">{fa(Number(row.damaged ?? 0))}</td>
            <td className="font-bold tabular-nums">{fa(Number(row.available ?? 0))}</td>
          </tr>)}
        </tbody></table></div>}
      </Card>
    </div>
  );
}

function History({ flash }: { flash: Flash }) {
  const [items, setItems] = useState<SupplierPortalHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setItems((await supplierPortalApi.history()).items); }
    catch (e) { setError(e instanceof Error ? e.message : "تاریخچه تأمین دریافت نشد."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  void flash;
  if (!items) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState label="در حال دریافت تاریخچه OMS…" />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2"><div><h2 className="text-[15px] font-extrabold">تاریخچه پاسخ‌ها و تعهدهای OMS</h2><p className="text-[11px] text-[var(--kv-muted)]">فقط درخواست‌های متصل به تخصیص‌های خودتان؛ بدون اطلاعات خریدار یا تأمین‌کننده دیگر.</p></div><Btn size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCw size={14} />}>به‌روزرسانی</Btn></div>
      {!items.length && <Empty title="تاریخچه تأمین ندارید" desc="پاسخ‌ها و تعهدهای سفارش مادر بعداً در این صفحه ثبت می‌شوند." />}
      {items.map((item) => <Card key={item.allocationId} className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><b className="text-[13px]">{item.productName} · {item.seriesName}</b><p className="mt-1 text-[11px] text-[var(--kv-muted)]">سفارش <span dir="ltr" className="font-mono">{item.orderReference}</span> · {fa(item.requestedSeries)} سری</p></div>
          <span className={cn("rounded-full px-2 py-1 text-[10px] font-bold", RESPONSE_STYLE[item.responseStatus] ?? "bg-gray-100 text-gray-700")}>{RESPONSE_STATUS[item.responseStatus] ?? item.responseStatus}</span></div>
        {item.responseNote && <p className="mt-2 rounded-[9px] bg-[var(--kv-surface-2)] p-2 text-[11px] leading-5">یادداشت: {item.responseNote}</p>}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-[var(--kv-muted)]">
          <span>وضع تخصیص: {item.allocationStatus}</span>{item.committedAt && <span>تعهد: {new Date(item.committedAt).toLocaleDateString("fa-IR")}</span>}{item.readyAt && <span>آماده: {new Date(item.readyAt).toLocaleDateString("fa-IR")}</span>}
        </div>
      </Card>)}
    </div>
  );
}

export function SupplierPortalWorkspace({ dark, setDark, supplierName, onLogout }: Props) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [toast, setToast] = useState<string | null>(null);
  const flash: Flash = (message) => { setToast(message); window.setTimeout(() => setToast(null), 4000); };
  const selected = tabs.find((item) => item.id === tab) ?? tabs[0]!;

  return (
    <div dir="rtl" className="min-h-screen px-3 pb-8 sm:px-5">
      <header className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-accent)] text-lg font-bold text-white" style={{ fontFamily: "Marcellus, serif" }}>K</span>
          <div><p className="text-[13px] font-bold tracking-[0.18em]" style={{ fontFamily: "Marcellus, serif" }}>KOLBE</p><p className="text-[10.5px] text-[var(--kv-muted)]">مرکز تأمین‌کنندگان</p></div>
        </div>
        <div className="mr-auto flex items-center gap-2">
          <span className="hidden text-[12px] font-bold sm:block">{supplierName}</span>
          <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[10.5px] font-bold text-emerald-800"><ShieldCheck size={13} />تأمین‌کننده تأییدشده و فعال</span>
          <button onClick={() => setDark(!dark)} aria-label="تغییر تم" className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
          <Btn size="sm" variant="ghost" icon={<LogOut size={14} />} onClick={onLogout}>خروج</Btn>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 lg:block">
          <div className="mb-3 rounded-[13px] bg-[var(--kv-surface-2)] px-3 py-3"><p className="text-[13px] font-extrabold">{supplierName}</p><p className="mt-1 text-[10.5px] leading-5 text-[var(--kv-muted)]">دسترسی از پروفایل تأییدشده سرور</p></div>
          <nav className="space-y-1" aria-label="بخش‌های پنل تأمین‌کننده">
            {tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined}
              className={cn("flex min-h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-right text-[12px] font-semibold transition",
                tab === item.id ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]")}>
              {item.icon}{item.title}
            </button>)}
          </nav>
        </aside>

        <main className="min-w-0">
          <nav className="kv-scroll mb-4 flex gap-1.5 overflow-x-auto rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2 lg:hidden" aria-label="بخش‌های پنل تأمین‌کننده">
            {tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined}
              className={cn("flex min-h-10 shrink-0 items-center gap-2 rounded-[10px] px-3 text-[11px] font-semibold",
                tab === item.id ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "text-[var(--kv-muted)] hover:bg-[var(--kv-surface-2)]")}>
              {item.icon}{item.title}
            </button>)}
          </nav>
          <section className="min-h-[420px] rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 shadow-sm sm:p-5" aria-labelledby="supplier-page-title">
            <div className="mb-5 border-b border-[var(--kv-line)] pb-4"><h1 id="supplier-page-title" className="text-[16px] font-extrabold">{selected.title}</h1><p className="mt-1 text-[11px] text-[var(--kv-muted)]">پنل فارسی، راست‌چین و متصل به سامانه‌های کلبه</p></div>
            {tab === "dashboard" && <Dashboard supplierName={supplierName} onNavigate={setTab} flash={flash} />}
            {tab === "supply" && <SupplierSupplyRequestsPanel flash={flash} />}
            {tab === "products" && <ProductsAndSeries onNavigate={setTab} supplierName={supplierName} flash={flash} />}
            {tab === "stock" && <StockAtKolbe />}
            {tab === "capacity" && <div className="space-y-3"><div className="rounded-[12px] bg-[var(--kv-surface-2)] px-4 py-3 text-[11.5px] leading-6 text-[var(--kv-muted)]">ظرفیت یک تعهد در منبع بیرونی است، نه موجودی انبار. رزروهای متصل به سفارش مادر تا تصمیم OMS (لغو معتبر، بازتخصیص یا مرحله بعدی تحقق) دوام دارند و با sweep مستقل منقضی نمی‌شوند.</div><SupplierOffersPanel flash={flash} /></div>}
            {tab === "requests" && <SupplierRequestsPortal flash={flash} />}
            {tab === "history" && <History flash={flash} />}
            {tab === "account" && <SupplierProfileSettings flash={flash} />}
          </section>
        </main>
      </div>
      {toast && <div role="status" aria-live="polite" className="fixed bottom-4 left-4 right-4 z-[100] mx-auto max-w-[560px] rounded-[12px] bg-[var(--kv-action)] px-4 py-3 text-center text-[12px] font-semibold text-[var(--kv-bg)] shadow-xl sm:left-auto sm:right-5">{toast}</div>}
    </div>
  );
}
