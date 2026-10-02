/** Prompt-1 W4: supplier-side wholesale panels + admin consignment operations.
 *
 *  Supplier side (§28-§34, §25-§27, §37):
 *   - SupplierOffersPanel:  offers + declared capacity + freshness + pause/resume.
 *     Declared capacity is a COMMITMENT, never kolbe stock; availableToRequest is
 *     server-computed (declared − reservedExternal − safetyBuffer) and read-only here.
 *   - SupplierConsignmentPanel: advance inbound requests (request→dispatch), the
 *     supplier's verified stock at kolbe, and stored-stock return requests.
 *
 *  Admin side (§40-§43, §50):
 *   - AdminSupplierInboundsPanel: approve/reject (capacity control, NOT marketplace
 *     approval), receive with shortage, QC pass/reject split.
 *   - AdminSupplierStockPanel: §43 stock-at-kolbe table + audited ownership
 *     conversion + return-request review. Owner column is explicit (§49).
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, LoadingState, Modal } from "./primitives";
import {
  inventoryApi, supplierConsignmentApi, supplierOffersApi,
  type SupplierInboundRow, type SupplierOfferRow,
} from "../data/api";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

type F = (message: string) => void;
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const toToman = (rial: string | null | undefined) => rial ? fa(Math.floor(Number(rial) / 10).toLocaleString("en-US").replace(/,/g, "٬")) : "—";

const SELECT_CLS = "h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const NUM_CLS = "h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";

/** §32: freshness states — stale NEVER un-approves; it only degrades ordering confidence. */
const FRESHNESS_BADGE: Record<string, { label: string; cls: string }> = {
  fresh: { label: "تازه", cls: "bg-emerald-100 text-emerald-800" },
  acceptable: { label: "قابل قبول", cls: "bg-emerald-50 text-emerald-700" },
  needs_update: { label: "نیازمند به‌روزرسانی", cls: "bg-amber-100 text-amber-800" },
  stale: { label: "منقضی — فقط استعلامی", cls: "bg-red-100 text-red-700" },
};
const INBOUND_BADGE: Record<string, { label: string; cls: string }> = {
  requested: { label: "در انتظار تأیید ظرفیت", cls: "bg-amber-100 text-amber-800" },
  approved: { label: "تأیید انبار — آماده ارسال", cls: "bg-sky-100 text-sky-800" },
  dispatched: { label: "ارسال‌شده (در راه)", cls: "bg-amber-100 text-amber-800" },
  received: { label: "دریافت‌شده — در انتظار QC", cls: "bg-indigo-100 text-indigo-800" },
  qc_completed: { label: "QC تکمیل شد", cls: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};
const RETURN_BADGE: Record<string, { label: string; cls: string }> = {
  requested: { label: "در انتظار بررسی", cls: "bg-amber-100 text-amber-800" },
  approved: { label: "تأییدشده — در انتظار خروج", cls: "bg-sky-100 text-sky-800" },
  completed: { label: "خارج شد", cls: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};
const OFFER_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: "فعال", cls: "bg-emerald-100 text-emerald-800" },
  paused: { label: "موقتاً متوقف", cls: "bg-amber-100 text-amber-800" },
  archived: { label: "آرشیو", cls: "bg-gray-100 text-gray-500" },
};
const Pill = ({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) => {
  const meta = map[value] ?? { label: value, cls: "bg-gray-100 text-gray-600" };
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>;
};

/* ============================= SUPPLIER: offers & capacity ============================= */

export function SupplierOffersPanel({ flash }: { flash: F }) {
  const [rows, setRows] = useState<SupplierOfferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capFor, setCapFor] = useState<SupplierOfferRow | null>(null);
  const [capValue, setCapValue] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    supplierOffersApi.list().then((r) => setRows(r.items)).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  const saveCapacity = async (confirmOnly: boolean) => {
    if (!capFor) return;
    setBusy(true);
    try {
      const res = await supplierOffersApi.capacity(capFor.id, confirmOnly ? { confirmOnly: true } : { declaredCapacity: Math.max(0, Number(capValue) || 0) });
      flash(`ظرفیت به‌روزرسانی شد — قابل درخواست: ${fa(res.availableToRequest)} سری`);
      setCapFor(null); load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <LoadingState label="در حال دریافت پیشنهادها..." />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">پیشنهادهای عمده و ظرفیت اعلامی</h3>
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            ظرفیت اعلامی «تعهد تأمین» است، نه موجودی انبار کلبه؛ «قابل درخواست» را سرور محاسبه می‌کند
            (ظرفیت − رزرو خارجی − حاشیه اطمینان). با گذشت زمان، تازگی اعلام کاهش می‌یابد — تأیید مجدد کنید.
          </p>
        </div>
        <Btn size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /></Btn>
      </div>
      {!rows.length && <Empty title="هنوز پیشنهادی ثبت نشده" desc="پیشنهاد عمده روی محصولات تأییدشده شما از بخش محصولات ساخته می‌شود." />}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            <thead><tr><th>محصول / رنگ</th><th>حداقل-حداکثر (سری)</th><th>قیمت سری (تومان)</th><th>ظرفیت اعلامی</th><th>رزرو خارجی</th><th>قابل درخواست</th><th>تازگی اعلام</th><th>وضعیت</th><th>اقدام</th></tr></thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td><div className="font-bold">{o.productName}</div><div className="text-[10.5px] text-[var(--kv-muted)]">{o.colorLabel ?? "همه رنگ‌ها"}{o.seriesTemplateName ? ` · ${o.seriesTemplateName}` : ""}</div></td>
                  <td>{fa(o.minOrderSeries)} تا {o.maxOrderSeries === null ? "∞" : fa(o.maxOrderSeries)}</td>
                  <td>{toToman(o.wholesalePriceRial)}</td>
                  <td className="font-bold">{fa(o.declaredCapacity)}</td>
                  <td>{fa(o.reservedExternal)}</td>
                  <td className="font-bold text-emerald-700">{fa(o.availableToRequest)}</td>
                  <td><Pill map={FRESHNESS_BADGE} value={o.freshness} /></td>
                  <td><Pill map={OFFER_BADGE} value={o.status} /></td>
                  <td className="whitespace-nowrap">
                    <Btn size="sm" variant="soft" onClick={() => { setCapFor(o); setCapValue(String(o.declaredCapacity)); }}>به‌روزرسانی ظرفیت</Btn>{" "}
                    {o.status !== "archived" && (
                      <Btn size="sm" variant="ghost" onClick={async () => {
                        try {
                          await supplierOffersApi.setStatus(o.id, o.status === "active" ? "paused" : "active");
                          flash(o.status === "active" ? "پیشنهاد موقتاً متوقف شد." : "پیشنهاد فعال شد."); load();
                        } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
                      }}>{o.status === "active" ? "توقف" : "فعال‌سازی"}</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {capFor && (
        <Modal open onClose={() => setCapFor(null)} title="به‌روزرسانی ظرفیت اعلامی">
          <h3 className="mb-1 text-sm font-bold">ظرفیت اعلامی — {capFor.productName}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            ظرفیت را نمی‌توانید کمتر از رزرو خارجی فعلی ({fa(capFor.reservedExternal)} سری) اعلام کنید.
            اگر مقدار تغییری نکرده، فقط «تأیید مجدد» بزنید تا تازگی اعلام نو شود.
          </p>
          <Field label="ظرفیت اعلامی (سری)">
            <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={capValue} onChange={(e) => setCapValue(e.target.value)} aria-label="ظرفیت اعلامی" />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" disabled={busy} onClick={() => void saveCapacity(true)}>فقط تأیید مجدد</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void saveCapacity(false)}>{busy ? "..." : "ذخیره ظرفیت"}</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/* ============================= SUPPLIER: consignment (inbounds / stock / returns) ============================= */

export function SupplierConsignmentPanel({ flash }: { flash: F }) {
  const [inbounds, setInbounds] = useState<SupplierInboundRow[] | null>(null);
  const [stock, setStock] = useState<Record<string, unknown>[] | null>(null);
  const [returns, setReturns] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [returnFor, setReturnFor] = useState<Record<string, unknown> | null>(null);
  const [returnQty, setReturnQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      supplierConsignmentApi.inbounds({ limit: 50 }),
      supplierConsignmentApi.supplierStock({ limit: 100 }),
      supplierConsignmentApi.returns({ limit: 50 }),
    ]).then(([i, s, r]) => { setInbounds(i.items); setStock(s.items); setReturns(r.items); })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!inbounds || !stock || !returns) return <LoadingState label="در حال دریافت اطلاعات امانی..." />;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold">موجودی من نزد انبار کلبه (امانی)</h3>
            <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              مالکیت این موجودی با شماست؛ کلبه امانت‌دار است. فقط «در دسترس» (موجود منهای رزرو) قابل بازپس‌گیری است.
            </p>
          </div>
          <Btn size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /></Btn>
        </div>
        {!stock.length && <Empty title="موجودی امانی ندارید" desc="با ثبت «ارسال پیش‌از سفارش» و عبور از QC، موجودی تأییدشده این‌جا می‌نشیند." />}
        {stock.length > 0 && (
          <div className="overflow-x-auto">
            <table className="kv-table w-full text-xs">
              <thead><tr><th>محصول / سری</th><th>انبار</th><th>موجود (سری)</th><th>رزرو</th><th>در دسترس</th><th>خراب/قرنطینه</th><th>آخرین رسید</th><th>اقدام</th></tr></thead>
              <tbody>
                {stock.map((row) => {
                  const available = Number(row.available ?? 0);
                  return (
                    <tr key={`${row.series_template_id}-${row.warehouse_id}`}>
                      <td><div className="font-bold">{String(row.product_name)}</div><div className="text-[10.5px] text-[var(--kv-muted)]">{String(row.series_template_name)}{row.color_label ? ` — ${String(row.color_label)}` : ""}</div></td>
                      <td>{String(row.warehouse_name)}</td>
                      <td className="font-bold">{fa(Number(row.on_hand ?? 0))}</td>
                      <td>{fa(Number(row.reserved ?? 0))}</td>
                      <td className="font-bold text-emerald-700">{fa(available)}</td>
                      <td>{fa(Number(row.damaged ?? 0))}</td>
                      <td>{row.last_receipt_at ? formatPersianDateTimeFull(String(row.last_receipt_at)) : "—"}</td>
                      <td>
                        <Btn size="sm" variant="soft" disabled={available <= 0}
                          onClick={() => { setReturnFor(row); setReturnQty("1"); }}>درخواست بازپس‌گیری</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-1 text-sm font-bold">ارسال‌های پیش‌ازسفارش (ورودی امانی)</h3>
        <p className="mb-3 text-[11.5px] leading-6 text-[var(--kv-muted)]">
          گردش کار: درخواست → تأیید انبار (کنترل ظرفیت؛ ربطی به تأیید بازارچه ندارد) → ارسال → دریافت (کسری ثبت می‌شود) → QC
          (فقط «قبول‌شده» وارد موجودی تأییدشده می‌شود).
        </p>
        {!inbounds.length && <Empty title="ارسالی ثبت نشده" desc="برای نگهداری کالا نزد کلبه، درخواست ارسال پیش‌ازسفارش ثبت کنید." />}
        {inbounds.length > 0 && (
          <div className="overflow-x-auto">
            <table className="kv-table w-full text-xs">
              <thead><tr><th>مرجع</th><th>محصول / سری</th><th>اعلامی</th><th>دریافتی</th><th>کسری</th><th>QC قبول/رد</th><th>وضعیت</th><th>اقدام</th></tr></thead>
              <tbody>
                {inbounds.map((i) => (
                  <tr key={i.id}>
                    <td dir="ltr" className="font-bold">{i.reference}</td>
                    <td>{String(i.product_name ?? "")}<div className="text-[10.5px] text-[var(--kv-muted)]">{String(i.series_template_name ?? "")}</div></td>
                    <td>{fa(i.expected_series)}</td>
                    <td>{i.received_series === null ? "—" : fa(i.received_series)}</td>
                    <td className={i.shortage_series > 0 ? "font-bold text-red-600" : ""}>{fa(i.shortage_series ?? 0)}</td>
                    <td>{i.passed_series === null ? "—" : `${fa(i.passed_series)} / ${fa(i.rejected_series ?? 0)}`}</td>
                    <td><Pill map={INBOUND_BADGE} value={i.status} /></td>
                    <td className="whitespace-nowrap">
                      {i.status === "approved" && (
                        <Btn size="sm" variant="accent" disabled={busy}
                          onClick={() => void act(() => supplierConsignmentApi.dispatch(i.id), "ارسال ثبت شد — کالا «در راه» است.")}>اعلام ارسال</Btn>
                      )}
                      {(i.status === "requested" || i.status === "approved") && (
                        <Btn size="sm" variant="ghost" disabled={busy}
                          onClick={() => void act(() => supplierConsignmentApi.cancel(i.id), "درخواست لغو شد.")}>لغو</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-bold">درخواست‌های بازپس‌گیری</h3>
        {!returns.length && <Empty title="درخواستی ثبت نشده" desc="از جدول موجودی امانی، روی «درخواست بازپس‌گیری» بزنید." />}
        {returns.length > 0 && (
          <div className="overflow-x-auto">
            <table className="kv-table w-full text-xs">
              <thead><tr><th>مرجع</th><th>سری</th><th>تعداد</th><th>وضعیت</th><th>تاریخ</th></tr></thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={String(r.id)}>
                    <td dir="ltr" className="font-bold">{String(r.reference)}</td>
                    <td>{String(r.series_template_name ?? r.series_template_id)}</td>
                    <td>{fa(Number(r.series_count ?? 0))}</td>
                    <td><Pill map={RETURN_BADGE} value={String(r.status)} /></td>
                    <td>{formatPersianDateTimeFull(String(r.created_at))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {returnFor && (
        <Modal open onClose={() => setReturnFor(null)} title="درخواست بازپس‌گیری">
          <h3 className="mb-1 text-sm font-bold">بازپس‌گیری — {String(returnFor.product_name)}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            حداکثر {fa(Number(returnFor.available ?? 0))} سری در دسترس است؛ سری‌های رزروشده قابل بازپس‌گیری نیستند.
          </p>
          <Field label="تعداد سری">
            <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={returnQty} onChange={(e) => setReturnQty(e.target.value)} aria-label="تعداد سری بازپس‌گیری" />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setReturnFor(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void act(async () => {
              await supplierConsignmentApi.createReturn({
                seriesTemplateId: returnFor.series_template_id, warehouseId: returnFor.warehouse_id,
                seriesCount: Math.max(1, Number(returnQty) || 1), idempotencyKey: newKey("srt"),
              });
              setReturnFor(null);
            }, "درخواست بازپس‌گیری ثبت شد و برای بررسی ارسال شد.")}>{busy ? "..." : "ثبت درخواست"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================= ADMIN: inbound queue (approve/receive/QC) ============================= */

export function AdminSupplierInboundsPanel({ flash }: { flash: F }) {
  const [rows, setRows] = useState<SupplierInboundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; purpose?: string }[]>([]);
  const [approveFor, setApproveFor] = useState<SupplierInboundRow | null>(null);
  const [approveWh, setApproveWh] = useState("");
  const [receiveFor, setReceiveFor] = useState<SupplierInboundRow | null>(null);
  const [receivedQty, setReceivedQty] = useState("");
  const [qcFor, setQcFor] = useState<SupplierInboundRow | null>(null);
  const [qcPass, setQcPass] = useState("");
  const [qcReject, setQcReject] = useState("0");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    supplierConsignmentApi.inbounds({ limit: 100 }).then((r) => setRows(r.items)).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
    inventoryApi.warehouses().then((r) => setWarehouses(r.items.filter((w) => w.purpose === "wholesale"))).catch(() => setWarehouses([]));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <LoadingState label="در حال دریافت ورودی‌های امانی..." />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">ورودی امانی تأمین‌کنندگان (پیش‌ازسفارش)</h3>
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            تأیید این‌جا یعنی کنترل ظرفیت انبار — نه تأیید بازارچه و نه ایجاد موجودی. موجودی تأییدشده فقط بعد از QC ساخته می‌شود؛ کسری دریافت به‌عنوان مغایرت ثبت می‌شود.
          </p>
        </div>
        <Btn size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /></Btn>
      </div>
      {!rows.length && <Empty title="ورودی امانی در جریان نیست" desc="درخواست‌های ارسال پیش‌ازسفارش تأمین‌کنندگان این‌جا می‌نشیند." />}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            <thead><tr><th>مرجع</th><th>تأمین‌کننده</th><th>محصول / سری</th><th>اعلامی</th><th>دریافتی</th><th>کسری</th><th>QC قبول/رد</th><th>انبار</th><th>وضعیت</th><th>اقدام</th></tr></thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td dir="ltr" className="font-bold">{i.reference}</td>
                  <td>{String(i.supplier_name ?? "")}</td>
                  <td>{String(i.product_name ?? "")}<div className="text-[10.5px] text-[var(--kv-muted)]">{String(i.series_template_name ?? "")}</div></td>
                  <td>{fa(i.expected_series)}</td>
                  <td>{i.received_series === null ? "—" : fa(i.received_series)}</td>
                  <td className={i.shortage_series > 0 ? "font-bold text-red-600" : ""}>{fa(i.shortage_series ?? 0)}</td>
                  <td>{i.passed_series === null ? "—" : `${fa(i.passed_series)} / ${fa(i.rejected_series ?? 0)}`}</td>
                  <td>{String(i.warehouse_name ?? "—")}</td>
                  <td><Pill map={INBOUND_BADGE} value={i.status} /></td>
                  <td className="whitespace-nowrap">
                    {i.status === "requested" && (<>
                      <Btn size="sm" variant="accent" onClick={() => { setApproveFor(i); setApproveWh(warehouses[0]?.id ?? ""); }}>تأیید</Btn>{" "}
                      <Btn size="sm" variant="ghost" disabled={busy} onClick={() => {
                        const reason = window.prompt("دلیل رد درخواست:");
                        if (reason) void act(() => supplierConsignmentApi.review(i.id, { decision: "reject", reason }), "درخواست رد شد.");
                      }}>رد</Btn>
                    </>)}
                    {i.status === "dispatched" && (
                      <Btn size="sm" variant="accent" onClick={() => { setReceiveFor(i); setReceivedQty(String(i.expected_series)); }}>ثبت دریافت</Btn>
                    )}
                    {i.status === "received" && (
                      <Btn size="sm" variant="accent" onClick={() => { setQcFor(i); setQcPass(String(i.received_series ?? 0)); setQcReject("0"); }}>ثبت QC</Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {approveFor && (
        <Modal open onClose={() => setApproveFor(null)} title="تأیید ورودی امانی">
          <h3 className="mb-1 text-sm font-bold">تأیید ظرفیت — {approveFor.reference}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">فقط انبار با کاربری «عمده» مجاز است؛ تأیید هیچ موجودی‌ای نمی‌سازد.</p>
          <Field label="انبار مقصد (عمده)">
            <select className={SELECT_CLS} value={approveWh} onChange={(e) => setApproveWh(e.target.value)} aria-label="انبار مقصد">
              <option value="">انتخاب انبار...</option>
              {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setApproveFor(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy || !approveWh} onClick={() => void act(async () => {
              await supplierConsignmentApi.review(approveFor.id, { decision: "approve", warehouseId: approveWh });
              setApproveFor(null);
            }, "ورودی تأیید شد — در انتظار ارسال تأمین‌کننده.")}>تأیید</Btn>
          </div>
        </Modal>
      )}
      {receiveFor && (
        <Modal open onClose={() => setReceiveFor(null)} title="ثبت دریافت">
          <h3 className="mb-1 text-sm font-bold">دریافت فیزیکی — {receiveFor.reference}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            اعلامی: {fa(receiveFor.expected_series)} سری. اگر کمتر رسید، کسری به‌عنوان مغایرت ثبت و اطلاع‌رسانی می‌شود.
          </p>
          <Field label="تعداد سری دریافتی">
            <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={receivedQty} onChange={(e) => setReceivedQty(e.target.value)} aria-label="تعداد دریافتی" />
          </Field>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setReceiveFor(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void act(async () => {
              await supplierConsignmentApi.receive(receiveFor.id, { receivedSeries: Math.max(0, Number(receivedQty) || 0) });
              setReceiveFor(null);
            }, "دریافت ثبت شد — در انتظار QC.")}>ثبت دریافت</Btn>
          </div>
        </Modal>
      )}
      {qcFor && (
        <Modal open onClose={() => setQcFor(null)} title="ثبت نتیجه QC">
          <h3 className="mb-1 text-sm font-bold">کنترل کیفیت — {qcFor.reference}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            جمع «قبول + رد» باید دقیقاً برابر {fa(qcFor.received_series ?? 0)} سریِ دریافتی باشد. فقط قبول‌شده‌ها وارد موجودی تأییدشده
            (به مالکیت تأمین‌کننده) می‌شوند؛ ردشده‌ها به قرنطینه می‌روند.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="سری‌های قبول‌شده">
              <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={qcPass} onChange={(e) => setQcPass(e.target.value)} aria-label="قبول‌شده" />
            </Field>
            <Field label="سری‌های ردشده">
              <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={qcReject} onChange={(e) => setQcReject(e.target.value)} aria-label="ردشده" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setQcFor(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void act(async () => {
              await supplierConsignmentApi.qc(qcFor.id, { passedSeries: Math.max(0, Number(qcPass) || 0), rejectedSeries: Math.max(0, Number(qcReject) || 0) });
              setQcFor(null);
            }, "نتیجه QC ثبت شد — قبول‌شده‌ها وارد موجودی امانی شدند.")}>ثبت QC</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/* ============================= ADMIN: supplier stock-at-kolbe (§43) + conversion (§50) + returns review ============================= */

export function AdminSupplierStockPanel({ flash }: { flash: F }) {
  const [stock, setStock] = useState<Record<string, unknown>[] | null>(null);
  const [returns, setReturns] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convFor, setConvFor] = useState<Record<string, unknown> | null>(null);
  const [convQty, setConvQty] = useState("1");
  const [convCost, setConvCost] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      supplierConsignmentApi.supplierStock({ limit: 200 }),
      supplierConsignmentApi.returns({ limit: 100 }),
    ]).then(([s, r]) => { setStock(s.items); setReturns(r.items); })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!stock || !returns) return <LoadingState label="در حال دریافت موجودی تأمین‌کنندگان..." />;
  const openReturns = returns.filter((r) => r.status === "requested" || r.status === "approved");
  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold">موجودی تأمین‌کنندگان نزد کلبه (امانی)</h3>
            <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              مالک این موجودی «تأمین‌کننده» است و کلبه فقط امانت‌دار؛ ورود به عرضه خرده بدون سند «تبدیل مالکیت» ممنوع است (§50).
            </p>
          </div>
          <Btn size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /></Btn>
        </div>
        {!stock.length && <Empty title="موجودی امانی وجود ندارد" desc="موجودی تأییدشده تأمین‌کنندگان پس از QC این‌جا می‌نشیند." />}
        {stock.length > 0 && (
          <div className="overflow-x-auto">
            <table className="kv-table w-full text-xs">
              <thead><tr><th>تأمین‌کننده</th><th>محصول / سری</th><th>انبار</th><th>موجود</th><th>رزرو</th><th>در دسترس</th><th>قرنطینه</th><th>آخرین رسید</th><th>اقدام</th></tr></thead>
              <tbody>
                {stock.map((row) => (
                  <tr key={`${row.series_template_id}-${row.warehouse_id}-${row.supplier_id}`}>
                    <td className="font-bold">{String(row.supplier_name)}</td>
                    <td>{String(row.product_name)}<div className="text-[10.5px] text-[var(--kv-muted)]">{String(row.series_template_name)}{row.color_label ? ` — ${String(row.color_label)}` : ""}</div></td>
                    <td>{String(row.warehouse_name)}</td>
                    <td className="font-bold">{fa(Number(row.on_hand ?? 0))}</td>
                    <td>{fa(Number(row.reserved ?? 0))}</td>
                    <td className="font-bold text-emerald-700">{fa(Number(row.available ?? 0))}</td>
                    <td>{fa(Number(row.damaged ?? 0))}</td>
                    <td>{row.last_receipt_at ? formatPersianDateTimeFull(String(row.last_receipt_at)) : "—"}</td>
                    <td>
                      <Btn size="sm" variant="soft" disabled={Number(row.available ?? 0) <= 0}
                        onClick={() => { setConvFor(row); setConvQty("1"); setConvCost(""); }}>تبدیل مالکیت به کلبه</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-bold">درخواست‌های بازپس‌گیری تأمین‌کنندگان {openReturns.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-800">{fa(openReturns.length)} باز</span>}</h3>
        {!returns.length && <Empty title="درخواستی ثبت نشده" desc="درخواست‌های خروج موجودی امانی این‌جا بررسی می‌شوند." />}
        {returns.length > 0 && (
          <div className="overflow-x-auto">
            <table className="kv-table w-full text-xs">
              <thead><tr><th>مرجع</th><th>تأمین‌کننده</th><th>سری</th><th>تعداد</th><th>وضعیت</th><th>اقدام</th></tr></thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={String(r.id)}>
                    <td dir="ltr" className="font-bold">{String(r.reference)}</td>
                    <td>{String(r.supplier_name ?? "")}</td>
                    <td>{String(r.series_template_name ?? "")}</td>
                    <td>{fa(Number(r.series_count ?? 0))}</td>
                    <td><Pill map={RETURN_BADGE} value={String(r.status)} /></td>
                    <td className="whitespace-nowrap">
                      {r.status === "requested" && (<>
                        <Btn size="sm" variant="accent" disabled={busy}
                          onClick={() => void act(() => supplierConsignmentApi.reviewReturn(String(r.id), { decision: "approve" }), "بازپس‌گیری تأیید شد.")}>تأیید</Btn>{" "}
                        <Btn size="sm" variant="ghost" disabled={busy} onClick={() => {
                          const reason = window.prompt("دلیل رد:");
                          if (reason) void act(() => supplierConsignmentApi.reviewReturn(String(r.id), { decision: "reject", reason }), "درخواست رد شد.");
                        }}>رد</Btn>
                      </>)}
                      {r.status === "approved" && (
                        <Btn size="sm" variant="accent" disabled={busy}
                          onClick={() => void act(() => supplierConsignmentApi.reviewReturn(String(r.id), { decision: "complete" }), "خروج فیزیکی ثبت شد و موجودی کسر شد.")}>ثبت خروج فیزیکی</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {convFor && (
        <Modal open onClose={() => setConvFor(null)} title="تبدیل مالکیت موجودی">
          <h3 className="mb-1 text-sm font-bold">تبدیل مالکیت — {String(convFor.product_name)}</h3>
          <p className="mb-4 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            سند حسابرسی‌پذیر «تبدیل مالکیت» ثبت می‌شود: {String(convFor.supplier_name)} ← کلبه.
            حداکثر {fa(Number(convFor.available ?? 0))} سری در دسترس است. مبلغ برای تسویه آینده نگه داشته می‌شود (پرامپت ۳).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="تعداد سری">
              <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={convQty} onChange={(e) => setConvQty(e.target.value)} aria-label="تعداد سری تبدیل" />
            </Field>
            <Field label="بهای هر سری (ریال — اختیاری)">
              <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={convCost} onChange={(e) => setConvCost(e.target.value)} aria-label="بهای هر سری" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConvFor(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void act(async () => {
              await supplierConsignmentApi.convertOwnership({
                seriesTemplateId: convFor.series_template_id, warehouseId: convFor.warehouse_id,
                supplierId: convFor.supplier_id, seriesCount: Math.max(1, Number(convQty) || 1),
                ...(convCost.trim() ? { unitCostRial: convCost.trim() } : {}),
                idempotencyKey: newKey("own-conv"),
              });
              setConvFor(null);
            }, "مالکیت با سند تبدیل شد — موجودی به مالکیت کلبه منتقل شد.")}>{busy ? "..." : "ثبت سند تبدیل"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
