/**
 * MASTER ORDER → CHILD ORDERS (زیرسفارش‌ها) — the operational content that used to live in the
 * removed «سفارشات عمده کلبه» / «سفارشات عمده تأمین‌کنندگان» primary tabs.
 *
 * PRODUCT-OWNER IA DECISION: source type is NOT an order type. The one canonical wholesale surface
 * («سفارشات عمده / VIP») lists Master Orders; a master may contain Kolbe physical stock, supplier
 * physical stock at Kolbe and supplier capacity AT THE SAME TIME. Its internal child orders are
 * therefore shown HERE — inside the master's «تخصیص و تأمین» workspace — with the operational tools
 * (status transition, invoice, shipping label, tracking) that operators used to reach from the
 * deleted per-seller centers. Nothing becomes a competing top-level order center.
 *
 * All data is the server's ops projection; all actions call the canonical domains
 * (orders transitions / invoices / shipments). No parallel renderer, no client-side truth.
 */
import { useCallback, useEffect, useState } from "react";
import { FileText, Printer, RefreshCw, Truck } from "lucide-react";
import { Btn, Checkbox, ErrorState, LoadingState, Modal, Textarea } from "../components/primitives";
import { authBlobUrl, invoicesApi, ordersApi, trackingApi } from "../data/api";
import type { OpsChild } from "../data/api";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const toman = (rial: string | null | undefined) => {
  if (!rial) return "—";
  try { return `${new Intl.NumberFormat("fa-IR").format(BigInt(rial) / 10n)} تومان`; } catch { return "—"; }
};
const PRINT_CAP = 20;

/** Canonical child-order lifecycle labels (projections of the backend enums — no raw codes). */
const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  pending_payment: { label: "در انتظار پرداخت", cls: "bg-amber-100 text-amber-800" },
  paid: { label: "پرداخت‌شده", cls: "bg-emerald-100 text-emerald-800" },
  processing: { label: "در حال پردازش", cls: "bg-amber-100 text-amber-800" },
  preparing: { label: "در حال آماده‌سازی", cls: "bg-amber-100 text-amber-800" },
  ready_to_ship: { label: "آماده ارسال", cls: "bg-amber-100 text-amber-800" },
  in_transit: { label: "در مسیر", cls: "bg-sky-100 text-sky-800" },
  shipped: { label: "ارسال‌شده", cls: "bg-emerald-100 text-emerald-800" },
  delivered: { label: "تحویل‌شده", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-600" },
  returned: { label: "مرجوع‌شده", cls: "bg-red-100 text-red-700" },
};
const SUPPLY_STATUS: Record<string, string> = {
  unresolved: "در انتظار تعیین منبع",
  stock_reserved: "رزرو از موجود کلبه",
  awaiting_supplier: "در انتظار تأیید تأمین‌کننده",
  partially_confirmed: "تأیید جزئی تأمین‌کننده",
  confirmed: "تأییدشده توسط تأمین‌کننده",
  supply_required: "نیازمند تأمین",
  blocked_supply_pending: "متوقف تا تأمین",
  ready: "آماده",
};
const PAYMENT_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "پرداخت‌شده", cls: "bg-emerald-100 text-emerald-800" },
  ready: { label: "قابل پرداخت", cls: "bg-amber-100 text-amber-800" },
  awaiting_supplier: { label: "در انتظار تأمین‌کننده", cls: "bg-amber-100 text-amber-800" },
  blocked_buyer_decision: { label: "منتظر تصمیم خریدار", cls: "bg-amber-100 text-amber-800" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-600" },
};
const FULFILLMENT: Record<string, string> = {
  not_started: "شروع نشده",
  preparing: "در حال آماده‌سازی",
  ready_for_consolidation: "آماده تجمیع",
  consolidated: "تجمیع‌شده",
  handed_over: "تحویل به حامل",
  in_transit: "در مسیر",
  delivered: "تحویل‌شده",
};

function Chip({ label, cls, title }: { label: string; cls: string; title?: string }) {
  return <span title={title} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold", cls)}>{label}</span>;
}

/**
 * Child orders of ONE master, with the operational actions migrated from the removed per-seller
 * centers. Collapsed by default so the master workspace stays the primary reading surface.
 */
export function MasterChildOrders({ children: childrenOrders, masterReference, onChanged, canOperate }: {
  children: OpsChild[]; masterReference: string; onChanged: () => void; canOperate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [trackingFor, setTrackingFor] = useState<OpsChild | null>(null);

  const active = childrenOrders.filter((child) => child.status !== "cancelled");
  const selectedRows = active.filter((child) => selected.has(child.id));
  const allChecked = active.length > 0 && active.every((child) => selected.has(child.id));
  useEffect(() => { setSelected(new Set()); }, [childrenOrders]);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });

  /** Server-rendered labels bundle (100×150 thermal or A4 grid) — same domain as the removed tab. */
  const printLabels = async (ids: string[]) => {
    if (!ids.length) return;
    setBusy(true); setError(null);
    try {
      const useA4 = window.confirm("چیدمان A4 (۴ لیبل در هر برگ)؟\n«تأیید» = شبکه A4 — «انصراف» = حرارتی ۱۰×۱۵ تک‌برگ");
      const url = await authBlobUrl(trackingApi.labelsBundlePath(ids.slice(0, PRINT_CAP), useA4 ? "a4" : "thermal"));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) { setError(err instanceof Error ? err.message : "دریافت لیبل‌ها ناموفق بود."); }
    finally { setBusy(false); }
  };

  /** Official invoices of the selected child orders (existing invoices; explicit confirmation to issue). */
  const printInvoices = async (rows: OpsChild[]) => {
    if (!rows.length) return;
    setBusy(true); setError(null);
    try {
      const slice = rows.slice(0, PRINT_CAP);
      const refOf = new Map(slice.map((row) => [row.id, row.reference]));
      let res = await invoicesApi.bulkForOrders(slice.map((row) => row.id), false);
      const missing = res.results.filter((r) => r.outcome === "missing");
      if (missing.length && window.confirm(`برای ${missing.length.toLocaleString("fa-IR")} زیرسفارش فاکتور صادر نشده است. همین حالا فاکتور رسمی صادر شود؟`)) {
        res = await invoicesApi.bulkForOrders(slice.map((row) => row.id), true);
      }
      const invoiceIds = res.results.map((r) => r.invoiceId).filter((id): id is string => Boolean(id));
      if (!invoiceIds.length) { setError("برای هیچ‌کدام از زیرسفارش‌های انتخابی فاکتوری موجود نیست."); return; }
      const url = await authBlobUrl(invoicesApi.bundlePath(invoiceIds));
      const win = window.open(url, "_blank");
      if (!win) setError("مرورگر اجازه باز کردن PDF را نداد.");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const stillMissing = res.results.filter((r) => r.outcome === "missing").map((r) => refOf.get(r.orderId) ?? r.orderId);
      const failed = res.results.filter((r) => r.outcome === "failed");
      const report: string[] = [];
      if (stillMissing.length) report.push(`بدون فاکتور: ${stillMissing.join("، ")}`);
      if (failed.length) report.push(`ناموفق: ${failed.map((f) => `${refOf.get(f.orderId) ?? f.orderId} (${f.error ?? ""})`).join("، ")}`);
      if (report.length) setError(report.join(" · "));
    } catch (err) { setError(err instanceof Error ? err.message : "چاپ فاکتور ناموفق بود."); }
    finally { setBusy(false); }
  };

  const submitStatus = async (status: string, note: string) => {
    setBusy(true); setError(null);
    try {
      const ids = selectedRows.map((row) => row.id);
      const res = await ordersApi.bulkTransitions({ orderIds: ids, status, ...(note.trim() ? { note: note.trim() } : {}) });
      if (res.failed > 0) setError(`${fa(res.succeeded)} زیرسفارش ثبت شد؛ ${fa(res.failed)} مورد ناموفق: ${res.results.filter((r) => !r.ok).map((r) => `${r.reference ?? ""} ${r.error ?? ""}`.trim()).join(" · ")}`);
      setStatusOpen(false); setSelected(new Set());
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "تغییر وضعیت ناموفق بود."); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-[12px] border border-[var(--kv-line)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-3 py-2">
        <button onClick={() => setOpen((v) => !v)} className="text-[12px] font-extrabold hover:text-[var(--kv-accent)]" aria-expanded={open}>
          {open ? "بستن زیرسفارش‌ها" : "نمایش زیرسفارش‌ها و ابزار عملیاتی"}
        </button>
        <span className="text-[11.5px] text-[var(--kv-muted)]">
          {fa(active.length)} زیرسفارش فعال از این سفارش مادر — تقسیم تأمین داخلی که هرگز به سفارش‌های جداگانه خریدار تبدیل نمی‌شود.
        </span>
        <div className="mr-auto flex flex-wrap items-center gap-2">
          <Btn size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onChanged}>به‌روزرسانی</Btn>
        </div>
      </div>

      {open && (
        <div className="space-y-2 p-3">
          {selected.size > 0 && canOperate && (
            <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--kv-action)] bg-[var(--kv-surface)] px-3 py-2">
              <b className="text-[12px]">{fa(selected.size)} انتخاب‌شده</b>
              <Btn size="sm" onClick={() => setStatusOpen(true)}>تغییر وضعیت گروهی</Btn>
              <Btn size="sm" variant="soft" disabled={busy} icon={<FileText size={14} />} onClick={() => void printInvoices(selectedRows)}>چاپ فاکتورها</Btn>
              <Btn size="sm" variant="soft" disabled={busy} icon={<Printer size={14} />} onClick={() => void printLabels([...selected])}>لیبل‌ها (PDF)</Btn>
            </div>
          )}
          {busy && <p role="status" className="text-[11.5px] text-[var(--kv-muted)]">در حال انجام عملیات…</p>}
          {error && <ErrorState message={error} onRetry={() => setError(null)} />}
          {active.length === 0 && <p className="text-[11.5px] text-[var(--kv-muted)]">زیرسفارش فعالی برای این سفارش مادر ثبت نشده است.</p>}

          {active.length > 0 && (
            <div className="overflow-x-auto rounded-[10px] border border-[var(--kv-line)]">
              <table className="kv-table min-w-[900px] text-[11.5px]">
                <thead>
                  <tr>
                    {canOperate && <th className="w-10">
                      <Checkbox checked={allChecked} label={<span className="sr-only">انتخاب همه زیرسفارش‌ها</span>}
                        onChange={() => setSelected(allChecked ? new Set() : new Set(active.map((c) => c.id)))} />
                    </th>}
                    <th>زیرسفارش</th><th>تأمین</th><th>وضعیت سفارش</th><th>وضعیت تأمین</th>
                    <th>پرداخت</th><th>تحویل به کلبه</th><th>مبلغ</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((child) => {
                    const status = ORDER_STATUS[child.status] ?? { label: child.status, cls: "bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" };
                    const payment = PAYMENT_STATUS[child.payment_eligibility] ?? { label: "—", cls: "bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" };
                    return (
                      <tr key={child.id}>
                        {canOperate && <td>
                          <Checkbox checked={selected.has(child.id)} label={<span className="sr-only">{`انتخاب زیرسفارش ${child.reference}`}</span>}
                            onChange={() => toggle(child.id)} />
                        </td>}
                        <td className="font-mono font-bold" dir="ltr">{child.reference}</td>
                        <td><Chip label={child.seller_type === "kolbe" ? "کلبه" : "تأمین‌کننده"} cls="bg-[var(--kv-surface-2)] text-[var(--kv-fg)]" /></td>
                        <td><Chip label={status.label} cls={status.cls} /></td>
                        <td>{SUPPLY_STATUS[child.supply_status] ?? "در جریان"}</td>
                        <td><Chip label={payment.label} cls={payment.cls} /></td>
                        <td>{child.child_fulfillment ? (FULFILLMENT[child.child_fulfillment] ?? "در جریان") : "شروع نشده"}</td>
                        <td className="tabular-nums">{toman(child.total_rial)}</td>
                        <td className="whitespace-nowrap">
                          <Btn size="sm" variant="ghost" icon={<Truck size={13} />} onClick={() => setTrackingFor(child)}>رهگیری</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => void printInvoices([child])}>فاکتور</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => void printLabels([child.id])}>لیبل</Btn>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-[var(--kv-muted)]">
            این زیرسفارش‌ها بخش داخلی همان سفارش {masterReference} هستند؛ خریدار یک سفارش واحد می‌بیند و
            تفاوت منابع فقط به‌صورت پوشش تأمین نمایش داده می‌شود.
          </p>
        </div>
      )}

      {statusOpen && (
        <ChildStatusModal ids={selectedRows.map((r) => r.id)} open={statusOpen} saving={busy}
          onClose={() => setStatusOpen(false)} onSubmit={submitStatus} />
      )}
      {trackingFor && (
        <ChildTrackingModal child={trackingFor} onClose={() => setTrackingFor(null)} onDone={() => { setTrackingFor(null); onChanged(); }} />
      )}
    </div>
  );
}

/** ONE canonical bulk transition call for the master's children (per-item results, never N requests). */
function ChildStatusModal({ ids, open, saving, onClose, onSubmit }: {
  ids: string[]; open: boolean; saving: boolean; onClose: () => void; onSubmit: (status: string, note: string) => Promise<void>;
}) {
  const [status, setStatus] = useState("processing");
  const [note, setNote] = useState("");
  useEffect(() => { if (open) { setStatus("processing"); setNote(""); } }, [open]);
  if (!open) return null;
  const options = Object.entries(ORDER_STATUS).filter(([code]) => code !== "cancelled");
  return (
    <Modal open onClose={onClose} title={`تغییر وضعیت ${fa(ids.length)} زیرسفارش`} max="max-w-[520px]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {options.map(([code, meta]) => (
            <button key={code} onClick={() => setStatus(code)} aria-pressed={status === code}
              className={cn("min-h-9 rounded-full border px-3 text-[12px] font-bold", status === code ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]" : "border-[var(--kv-line)]")}>
              {meta.label}
            </button>
          ))}
        </div>
        <Textarea rows={2} value={note} onChange={setNote} placeholder="یادداشت عملیاتی (در سابقه ثبت می‌شود)" />
        <p className="text-[11px] text-[var(--kv-muted)]">هر زیرسفارش مستقلاً بررسی می‌شود؛ نتیجه نهایی هر مورد گزارش می‌شود.</p>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>انصراف</Btn>
          <Btn disabled={saving} onClick={() => void onSubmit(status, note)}>{saving ? "در حال ثبت…" : "ثبت تغییر وضعیت"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/** Shipment tracking for one child order — the canonical shipments domain, not a parallel store. */
function ChildTrackingModal({ child, onClose, onDone }: { child: OpsChild; onClose: () => void; onDone: () => void }) {
  const [carrier, setCarrier] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [existingId, setExistingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await trackingApi.shipments({ search: child.reference, limit: 10 });
      const match = res.items.find((s) => String(s.order_reference ?? "") === child.reference);
      if (match) {
        setExistingId(String(match.id));
        setCarrier(String(match.carrier ?? ""));
        setCode(String(match.tracking_code ?? ""));
      }
    } catch (err) { setError(err instanceof Error ? err.message : "دریافت اطلاعات مرسوله ناموفق بود."); }
    finally { setLoading(false); }
  }, [child.reference]);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    if (!carrier.trim() || !code.trim()) { setError("حامل و کد رهگیری الزامی است."); return; }
    setSaving(true); setError(null);
    try {
      if (existingId) await trackingApi.updateShipment(existingId, { carrier: carrier.trim(), trackingCode: code.trim() });
      else await trackingApi.createShipment({ orderId: child.id, carrier: carrier.trim(), trackingCode: code.trim(), status: "handed_over" });
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : "ثبت رهگیری ناموفق بود."); }
    finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title={`رهگیری زیرسفارش ${child.reference}`} max="max-w-[520px]">
      <div className="space-y-3">
        {loading ? <LoadingState label="در حال دریافت مرسوله…" /> : (
          <>
            <label className="block text-[12px] font-bold">حامل
              <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="مثال: پست پیشتاز"
                className="mt-1.5 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm" />
            </label>
            <label className="block text-[12px] font-bold">کد رهگیری
              <input value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" placeholder="TRK-…"
                className="mt-1.5 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm" />
            </label>
            {error && <p role="alert" className="text-[12px] font-bold text-[var(--kv-danger)]">{error}</p>}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={onClose}>انصراف</Btn>
              <Btn disabled={saving} onClick={() => void submit()} icon={<Truck size={14} />}>{saving ? "در حال ثبت…" : "ثبت رهگیری"}</Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
