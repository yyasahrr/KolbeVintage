import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, FileText, Package, Printer, RefreshCw, Tag, Truck } from "lucide-react";
import { Btn, Checkbox, Drawer, Empty, ErrorState, LoadingState, Modal, SearchBox, Segmented, Textarea } from "../components/primitives";
import { invoicesApi, manualSalesApi, omsApi, ordersApi, trackingApi, wholesaleFulfillmentApi } from "../data/api";
import { CHANNEL_LABEL } from "../components/manual-sales-panel";
import { ManualOrderForm } from "../components/manual-order-form";
import { TrackingCenter } from "../components/tracking-center";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

/* ----------------------------- shared vocabulary ----------------------------- */
/* All labels are projections of the CANONICAL backend enums — no parallel status systems. */

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const toman = (rial: string | null | undefined) => {
  if (!rial) return "—";
  try { return `${new Intl.NumberFormat("fa-IR").format(BigInt(rial) / 10n)} تومان`; } catch { return "—"; }
};
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type Badge = { label: string; cls: string };
const G = "bg-emerald-100 text-emerald-800"; const Y = "bg-amber-100 text-amber-800";
const R = "bg-red-100 text-red-700"; const N = "bg-gray-100 text-gray-600";

/** orders.status (canonical state machine). */
export const ORDER_BADGE: Record<string, Badge> = {
  pending_payment: { label: "در انتظار پرداخت", cls: Y },
  paid: { label: "پرداخت‌شده", cls: G },
  processing: { label: "در حال پردازش", cls: Y },
  preparing: { label: "در حال آماده‌سازی", cls: Y },
  ready_to_ship: { label: "آماده ارسال", cls: Y },
  in_transit: { label: "در مسیر", cls: Y },
  shipped: { label: "ارسال‌شده", cls: G },
  delivered: { label: "تحویل‌شده", cls: G },
  cancelled: { label: "لغوشده", cls: N },
  returned: { label: "مرجوع‌شده", cls: R },
  // manual-sale lifecycle (same unified retail table)
  pending_verification: { label: "در انتظار تأیید پرداخت", cls: Y },
  completed: { label: "تکمیل‌شده", cls: G },
};
const PAYMENT_BADGE: Record<string, Badge> = {
  succeeded: { label: "موفق", cls: G }, pending: { label: "در انتظار", cls: Y },
  failed: { label: "ناموفق", cls: R }, refunded: { label: "استردادشده", cls: N },
  none: { label: "بدون تراکنش", cls: N },
};
const SHIPMENT_BADGE: Record<string, Badge> = {
  created: { label: "ثبت‌شده", cls: N }, handed_over: { label: "تحویل به حامل", cls: Y },
  preparing: { label: "در حال آماده‌سازی", cls: Y }, sent: { label: "ارسال‌شده", cls: Y },
  in_transit: { label: "در مسیر", cls: Y }, out_for_delivery: { label: "در حال توزیع", cls: Y },
  shipped: { label: "ارسال‌شده", cls: G }, delivered: { label: "تحویل‌شده", cls: G },
  returned: { label: "مرجوعی", cls: R }, failed: { label: "ناموفق", cls: R },
};
const METHOD_LABEL: Record<string, string> = {
  gateway: "درگاه آنلاین", installments: "اقساط ۴ مرحله", card_to_card: "کارت‌به‌کارت",
  cash: "نقدی", pos: "کارتخوان (POS)", other: "سایر",
};
const EXCEPTION_LABEL: Record<string, string> = {
  payment_failed: "پرداخت ناموفق", payment_overdue: "پرداخت‌نشده بیش از ۲۴ ساعت",
  missing_tracking: "کد رهگیری ثبت نشده", missing_carrier: "حامل نامشخص",
  invalid_address: "کد پستی نامعتبر", qc_issue: "مشکل کنترل کیفیت",
  payment_unverified: "پرداخت تأییدنشده",
};
/** wholesale_fulfillment_status — ONE canonical column, projected into two display stages (§21). */
const SUPPLIER_STAGE = new Set(["awaiting_supplier", "supplier_preparing", "supplier_dispatched", "dispatched_to_kolbe"]);
const WS_LABEL: Record<string, string> = {
  not_applicable: "—", awaiting_supplier: "در انتظار تأمین‌کننده", supplier_preparing: "آماده‌سازی تأمین‌کننده",
  supplier_dispatched: "ارسال تأمین‌کننده", dispatched_to_kolbe: "در مسیر انبار کلبه", arrived_at_kolbe: "رسیده به انبار کلبه",
  partially_received_at_kolbe: "دریافت ناقص", received_at_kolbe: "دریافت‌شده در کلبه", receiving: "در حال دریافت",
  under_inspection: "در حال بازرسی", under_qc: "در حال کنترل کیفیت", partially_accepted: "پذیرش ناقص",
  qc_issue: "مشکل QC", accepted: "پذیرفته‌شده", qc_passed: "QC تأیید شد", rejected: "ردشده",
  awaiting_consolidation: "در انتظار تجمیع", consolidated: "تجمیع‌شده", ready_for_vip: "آماده ارسال VIP",
  ready_for_vip_dispatch: "آماده ارسال VIP", vip_dispatched: "ارسال‌شده به VIP", delivered: "تحویل‌شده",
};
const supplierStage = (ws: string | null | undefined) => {
  if (!ws || ws === "not_applicable") return "—";
  return SUPPLIER_STAGE.has(ws) ? (WS_LABEL[ws] ?? ws) : "تحویل‌شده به کلبه";
};
const kolbeStage = (ws: string | null | undefined) => {
  if (!ws || ws === "not_applicable") return "—";
  return SUPPLIER_STAGE.has(ws) ? "در انتظار دریافت" : (WS_LABEL[ws] ?? ws);
};
/** Mirror of the backend transition map — DISPLAY ONLY; the server is the rulebook. */
const NEXT_STATUS: Record<string, string[]> = {
  pending_payment: ["paid", "cancelled"], paid: ["processing", "preparing", "cancelled"],
  processing: ["preparing", "ready_to_ship", "in_transit", "shipped", "cancelled"],
  preparing: ["ready_to_ship", "in_transit", "shipped", "cancelled"],
  ready_to_ship: ["in_transit", "shipped"], in_transit: ["shipped", "delivered"],
  shipped: ["delivered", "returned"], delivered: ["returned"], cancelled: [], returned: [],
};
const CARRIERS = ["پست پیشتاز", "پست سفارشی", "تیپاکس", "اسنپ‌باکس", "الوپیک", "پیک شهری", "باربری"];

function BadgePill({ map, value }: { map: Record<string, Badge>; value: string | null | undefined }) {
  if (!value) return <span className="text-xs text-[var(--kv-muted)]">—</span>;
  const meta = map[value] ?? { label: value, cls: N };
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>;
}

/* ----------------------------- row types ----------------------------- */

type OrderRow = {
  id: string; reference: string; status: string; order_type: string; payment_mode: string;
  total_rial: string; created_at: string; buyer_name: string | null; buyer_phone: string | null;
  lines_count: number; payment_status: string | null; fulfillment_status: string | null;
  wholesale_fulfillment_status?: string | null; consolidated_at?: string | null; vip_dispatched_at?: string | null;
  supplier_names?: string[] | null; first_supplier?: string | null;
  tracking_code?: string | null; shipment_carrier?: string | null; shipment_status?: string | null;
  exception_reasons?: string[] | null;
};
type RetailRow = {
  kind: "order" | "manual_sale"; id: string; reference: string; created_at: string;
  buyer_name: string | null; buyer_phone: string | null; channel: string; lines_count: number;
  total_rial: string; payment_method: string | null; payment_provider: string | null; payment_status: string;
  status: string; shipment_status: string | null; tracking_code: string | null; carrier: string | null;
  exception_reasons: string[];
};
type OrderDetail = OrderRow & {
  subtotal_rial: string; discount_rial: string; shipping_rial: string;
  shipping_address: { recipient?: string; phone?: string; province?: string; city?: string; line?: string; postalCode?: string } | null;
  shipping_name: string | null;
  lines: { id: string; sku: string; product_name: string; quantity: number; unit_price_rial: string; line_total_rial: string; qc_status?: string | null }[];
  events: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
  payments: { id: string; reference: string; provider: string | null; amount_rial: string; status: string; created_at: string }[];
  fulfillments?: { id: string; reference: string; brand_name: string | null; status: string; dispatched_at: string | null; arrived_at: string | null; accepted_at: string | null }[];
};

/* ----------------------------- print helpers (§35-§37) ----------------------------- */

const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function openPrintWindow(title: string, css: string, body: string) {
  const win = window.open("", "_blank", "width=960,height=720");
  if (!win) { alert("مرورگر اجازه باز کردن پنجره چاپ را نداد."); return; }
  win.document.write(`<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8" /><title>${esc(title)}</title><style>${css}</style></head><body>${body}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

const INVOICE_CSS = `
  * { box-sizing: border-box; font-family: Tahoma, 'Vazirmatn', sans-serif; }
  body { margin: 0; color: #1b2335; }
  .invoice { page-break-after: always; padding: 14mm 12mm; }
  .invoice:last-child { page-break-after: auto; }
  .head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1b2335; padding-bottom: 6mm; margin-bottom: 6mm; }
  h1 { font-size: 16pt; margin: 0; } .meta { font-size: 9pt; color: #555; text-align: left; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-top: 4mm; }
  th, td { border: 1px solid #c9c9c9; padding: 2.5mm 2mm; text-align: right; }
  th { background: #f1ece2; } .totals { margin-top: 5mm; width: 60mm; margin-right: auto; font-size: 10pt; }
  .totals div { display: flex; justify-content: space-between; padding: 1.5mm 0; }
  .totals .grand { border-top: 1.5px solid #1b2335; font-weight: bold; }
  .missing { padding: 10mm; font-size: 11pt; color: #8a1f1f; }
  @page { size: A4; margin: 0; }
`;

const LABEL_CSS = `
  * { box-sizing: border-box; font-family: Tahoma, 'Vazirmatn', sans-serif; }
  body { margin: 0; }
  .label { width: 100mm; height: 150mm; padding: 6mm; page-break-after: always; display: flex; flex-direction: column; gap: 3mm; color: #111; }
  .label:last-child { page-break-after: auto; }
  .brand { display: flex; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 2.5mm; font-weight: bold; }
  .ref { font-size: 15pt; font-weight: 800; letter-spacing: 1px; }
  .block { border: 1px solid #999; border-radius: 2mm; padding: 2.5mm; font-size: 9.5pt; }
  .block b { display: block; font-size: 8pt; color: #666; margin-bottom: 1mm; }
  .track { font-size: 12pt; font-weight: 800; text-align: center; border: 2px dashed #111; padding: 3mm; border-radius: 2mm; }
  .items { flex: 1; overflow: hidden; font-size: 8.5pt; }
  @page { size: 100mm 150mm; margin: 0; }
`;

function labelHtml(detail: OrderDetail): string {
  const addr = detail.shipping_address ?? {};
  const items = detail.lines.slice(0, 6).map((l) => `<div>• ${esc(l.product_name)} (${esc(l.sku)}) ×${fa(l.quantity)}</div>`).join("");
  const more = detail.lines.length > 6 ? `<div>و ${fa(detail.lines.length - 6)} قلم دیگر…</div>` : "";
  return `<div class="label">
    <div class="brand"><span>کلبه وینتیج</span><span>${esc(formatPersianDateTimeFull(detail.created_at))}</span></div>
    <div class="ref">${esc(detail.reference)}</div>
    <div class="block"><b>گیرنده</b>${esc(addr.recipient ?? detail.buyer_name ?? "—")} — ${esc(addr.phone ?? detail.buyer_phone ?? "—")}<br/>${esc(addr.province ?? "")}، ${esc(addr.city ?? "")}، ${esc(addr.line ?? "")}<br/>کد پستی: ${esc(addr.postalCode ?? "—")}</div>
    <div class="block"><b>مبدأ</b>انبار کلبه وینتیج</div>
    <div class="block"><b>روش ارسال / حامل</b>${esc(detail.shipping_name ?? "—")} — ${esc(detail.shipment_carrier ?? "—")}</div>
    <div class="track">رهگیری: ${esc(detail.tracking_code ?? "ثبت نشده")}</div>
    <div class="items"><b>اقلام (${fa(detail.lines.length)}):</b>${items}${more}</div>
  </div>`;
}

type InvoiceSummary = { id: string; reference: string; status: string; total_rial: string; issue_date: string | null; created_at: string };
type InvoiceDetail = InvoiceSummary & {
  buyer: { name?: string; displayName?: string; phone?: string } | null;
  subtotal_rial: string; discount_rial: string; shipping_rial: string; paid_rial: string; remaining_rial: string;
  lines: { line_no: number; title: string; sku: string | null; quantity: number; unit_price_rial: string; total_rial: string }[];
};

function invoiceHtml(inv: InvoiceDetail, fallbackBuyer: string): string {
  const buyer = inv.buyer?.name ?? inv.buyer?.displayName ?? fallbackBuyer;
  const rows = inv.lines.map((l) => `<tr><td>${fa(l.line_no)}</td><td>${esc(l.title)}${l.sku ? ` <small>(${esc(l.sku)})</small>` : ""}</td><td>${fa(l.quantity)}</td><td>${esc(toman(l.unit_price_rial))}</td><td>${esc(toman(l.total_rial))}</td></tr>`).join("");
  return `<div class="invoice">
    <div class="head"><div><h1>کلبه وینتیج</h1><div>فاکتور فروش</div></div>
    <div class="meta">شماره: ${esc(inv.reference)}<br/>تاریخ: ${esc(formatPersianDateTimeFull(inv.issue_date ?? inv.created_at))}<br/>خریدار: ${esc(buyer)}</div></div>
    <table><thead><tr><th>#</th><th>شرح</th><th>تعداد</th><th>مبلغ واحد</th><th>جمع</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="totals">
      <div><span>جمع اقلام</span><span>${esc(toman(inv.subtotal_rial))}</span></div>
      <div><span>تخفیف</span><span>${esc(toman(inv.discount_rial))}</span></div>
      <div><span>هزینه ارسال</span><span>${esc(toman(inv.shipping_rial))}</span></div>
      <div class="grand"><span>مبلغ نهایی</span><span>${esc(toman(inv.total_rial))}</span></div>
      <div><span>پرداخت‌شده</span><span>${esc(toman(inv.paid_rial))}</span></div>
    </div>
  </div>`;
}

/* ----------------------------- small UI pieces ----------------------------- */

function PresetChips<T extends string>({ presets, active, onPick }: { presets: { id: T; label: string }[]; active: T; onPick: (id: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {presets.map((p) => (
        <button key={p.id} onClick={() => onPick(p.id)}
          className={cn("kv-press rounded-full border px-3 py-1.5 text-[11.5px] font-bold transition-colors",
            active === p.id ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] text-[var(--kv-ink)] hover:border-[var(--kv-line-strong)]")}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function LSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { v: string; label: string }[] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--kv-muted)]">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2.5 text-[12.5px] font-semibold text-[var(--kv-ink)]">
        {options.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
      </select>
    </label>
  );
}

function ExceptionBadges({ reasons }: { reasons: string[] | null | undefined }) {
  if (!reasons?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reasons.map((r) => <span key={r} className={cn("rounded-full px-1.5 py-0.5 text-[9.5px] font-bold", R)}>{EXCEPTION_LABEL[r] ?? r}</span>)}
    </div>
  );
}

/* ----------------------------- tracking modal (§28-29) ----------------------------- */

function TrackingModal({ order, onClose, onDone }: { order: { id: string; reference: string; tracking_code?: string | null; shipment_carrier?: string | null } | null; onClose: () => void; onDone: () => void }) {
  const [carrier, setCarrier] = useState(CARRIERS[0]!);
  const [customCarrier, setCustomCarrier] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (order) { setCode(order.tracking_code ?? ""); setCustomCarrier(""); setError(null);
      if (order.shipment_carrier && !CARRIERS.includes(order.shipment_carrier)) { setCarrier("سایر"); setCustomCarrier(order.shipment_carrier); }
      else setCarrier(order.shipment_carrier ?? CARRIERS[0]!); }
  }, [order]);
  if (!order) return null;
  const submit = async () => {
    const finalCarrier = carrier === "سایر" ? customCarrier.trim() : carrier;
    if (!code.trim() || !finalCarrier) { setError("حامل و کد رهگیری الزامی است."); return; }
    setSaving(true); setError(null);
    try {
      // Single source of truth: shipments domain. Update the existing shipment if one exists, otherwise create it.
      const existing = await trackingApi.shipments({ search: order.reference, limit: 10 });
      const match = existing.items.find((s) => s.order_reference === order.reference);
      if (match) await trackingApi.updateShipment(String(match.id), { carrier: finalCarrier, trackingCode: code.trim() });
      else await trackingApi.createShipment({ orderId: order.id, carrier: finalCarrier, trackingCode: code.trim(), status: "handed_over" });
      onDone(); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : "ثبت رهگیری ناموفق بود."); }
    finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={`ثبت کد رهگیری — ${order.reference}`}>
      <div className="space-y-3">
        <LSelect label="حامل" value={carrier} onChange={setCarrier} options={[...CARRIERS, "سایر"].map((c) => ({ v: c, label: c }))} />
        {carrier === "سایر" && (
          <input value={customCarrier} onChange={(e) => setCustomCarrier(e.target.value)} placeholder="نام حامل"
            className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm" />
        )}
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="کد رهگیری مرسوله" dir="ltr"
          className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm" />
        {error && <p className="text-xs font-bold text-[var(--kv-danger)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Btn variant="soft" size="sm" onClick={onClose}>انصراف</Btn>
          <Btn size="sm" disabled={saving} onClick={() => void submit()} icon={<Truck size={14} />}>{saving ? "در حال ثبت…" : "ثبت رهگیری"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ----------------------------- bulk status modal (§33-34) ----------------------------- */

function BulkStatusModal({ ids, open, onClose, onDone }: { ids: string[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState("processing");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<{ orderId: string; reference?: string; ok: boolean; error?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setResults(null); setError(null); setNote(""); } }, [open]);
  if (!open) return null;
  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const res = await ordersApi.bulkTransitions({ orderIds: ids, status, note: note.trim() || undefined });
      setResults(res.results);
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : "عملیات گروهی ناموفق بود."); }
    finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={`تغییر وضعیت گروهی (${fa(ids.length)} سفارش)`}>
      {!results ? (
        <div className="space-y-3">
          <LSelect label="وضعیت مقصد" value={status} onChange={setStatus}
            options={Object.keys(NEXT_STATUS).map((s) => ({ v: s, label: ORDER_BADGE[s]?.label ?? s }))} />
          <Textarea placeholder="یادداشت (برای «پرداخت‌شده» بدون تراکنش موفق درگاه، ثبت مستند پرداخت آفلاین الزامی است)" value={note} onChange={setNote} rows={2} />
          {error && <p className="text-xs font-bold text-[var(--kv-danger)]">{error}</p>}
          <div className="flex justify-end gap-2">
            <Btn variant="soft" size="sm" onClick={onClose}>انصراف</Btn>
            <Btn size="sm" disabled={saving} onClick={() => void submit()}>{saving ? "در حال اعمال…" : "اعمال روی همه"}</Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-bold">
            {fa(results.filter((r) => r.ok).length)} موفق، {fa(results.filter((r) => !r.ok).length)} ناموفق
          </p>
          <div className="max-h-64 space-y-1.5 overflow-auto">
            {results.map((r) => (
              <div key={r.orderId} className={cn("rounded-[10px] border px-3 py-2 text-xs", r.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700")}>
                <b>{r.reference ?? r.orderId.slice(0, 8)}</b> — {r.ok ? "انجام شد" : r.error}
              </div>
            ))}
          </div>
          <div className="flex justify-end"><Btn size="sm" variant="soft" onClick={onClose}>بستن</Btn></div>
        </div>
      )}
    </Modal>
  );
}

/* ----------------------------- order details drawer (§39-40) ----------------------------- */

function eventLabel(toStatus: string): string {
  if (toStatus.startsWith("fulfillment:")) return `آماده‌سازی: ${ORDER_BADGE[toStatus.slice(12)]?.label ?? toStatus.slice(12)}`;
  return ORDER_BADGE[toStatus]?.label ?? WS_LABEL[toStatus] ?? toStatus;
}

function OrderDrawer({ orderId, onClose, onChanged, onTracking }: {
  orderId: string | null; onClose: () => void; onChanged: () => void;
  onTracking: (order: { id: string; reference: string; tracking_code?: string | null; shipment_carrier?: string | null }) => void;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true); setError(null);
    try { setDetail(await ordersApi.get(orderId) as OrderDetail); }
    catch (err) { setError(err instanceof Error ? err.message : "خطا در دریافت سفارش"); }
    finally { setLoading(false); }
  }, [orderId]);
  useEffect(() => { setDetail(null); setNote(""); setActionError(null); void load(); }, [load]);

  if (!orderId) return null;
  const transition = async (status: string) => {
    setSaving(true); setActionError(null);
    try { await ordersApi.transition(orderId, { status, note: note.trim() || undefined }); setNote(""); await load(); onChanged(); }
    catch (err) { setActionError(err instanceof Error ? err.message : "تغییر وضعیت ناموفق بود."); }
    finally { setSaving(false); }
  };
  const wholesaleAction = async (kind: "consolidate" | "dispatch") => {
    setSaving(true); setActionError(null);
    try {
      if (kind === "consolidate") await wholesaleFulfillmentApi.consolidateOrder(orderId, newKey("cons"), note.trim() || undefined);
      else await wholesaleFulfillmentApi.dispatchVipOrder(orderId, newKey("vip"), note.trim() || undefined);
      setNote(""); await load(); onChanged();
    } catch (err) { setActionError(err instanceof Error ? err.message : "عملیات ناموفق بود."); }
    finally { setSaving(false); }
  };
  const printLabel = () => { if (detail) openPrintWindow(`لیبل ${detail.reference}`, LABEL_CSS, labelHtml(detail)); };
  const printInvoice = async () => {
    if (!detail) return;
    try {
      const list = await invoicesApi.list({ orderId: detail.id }) as { items: InvoiceSummary[] };
      const first = list.items[0];
      if (!first) { setActionError("برای این سفارش فاکتوری در سیستم فاکتور صادر نشده است."); return; }
      const inv = await invoicesApi.get(first.id) as InvoiceDetail;
      openPrintWindow(`فاکتور ${inv.reference}`, INVOICE_CSS, invoiceHtml(inv, detail.buyer_name ?? "—"));
    } catch (err) { setActionError(err instanceof Error ? err.message : "دریافت فاکتور ناموفق بود."); }
  };

  const addr = detail?.shipping_address;
  return (
    <Drawer open onClose={onClose} title={detail ? `سفارش ${detail.reference}` : "جزئیات سفارش"} wide>
      <div className="space-y-4 p-5">
        {loading && <LoadingState />}
        {error && <ErrorState message={error} onRetry={() => void load()} />}
        {detail && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <BadgePill map={ORDER_BADGE} value={detail.status} />
              <BadgePill map={PAYMENT_BADGE} value={detail.payment_status ?? "none"} />
              {detail.shipment_status && <BadgePill map={SHIPMENT_BADGE} value={detail.shipment_status} />}
              {detail.order_type === "wholesale" && detail.wholesale_fulfillment_status && (
                <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", Y)}>{WS_LABEL[detail.wholesale_fulfillment_status] ?? detail.wholesale_fulfillment_status}</span>
              )}
            </div>
            <ExceptionBadges reasons={detail.exception_reasons} />

            <section className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12.5px]">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">خریدار و آدرس</h3>
              <p className="font-bold">{detail.buyer_name ?? "—"} — <span dir="ltr">{detail.buyer_phone ?? ""}</span></p>
              {addr && <p className="mt-1 text-[var(--kv-muted)]">{addr.recipient} — {addr.province}، {addr.city}، {addr.line} — کد پستی {addr.postalCode}</p>}
              <p className="mt-1 text-[var(--kv-muted)]">روش ارسال: {detail.shipping_name ?? "—"} · حامل: {detail.shipment_carrier ?? "—"} · رهگیری: <span dir="ltr">{detail.tracking_code ?? "ثبت نشده"}</span></p>
            </section>

            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">اقلام ({fa(detail.lines.length)})</h3>
              <div className="space-y-1.5">
                {detail.lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[12px]">
                    <div className="min-w-0">
                      <p className="truncate font-bold">{l.product_name}</p>
                      <p className="text-[10.5px] text-[var(--kv-muted)]" dir="ltr">{l.sku}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3 tabular-nums">
                      {l.qc_status && l.qc_status !== "pending" && <span className={cn("rounded-full px-1.5 py-0.5 text-[9.5px] font-bold", l.qc_status === "accepted" ? G : R)}>{l.qc_status === "accepted" ? "QC تأیید" : l.qc_status === "rejected" ? "QC رد" : "QC ناقص"}</span>}
                      <span>×{fa(l.quantity)}</span><b>{toman(l.line_total_rial)}</b>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between border-t border-[var(--kv-line)] pt-2 text-[12.5px] font-extrabold">
                <span>مبلغ نهایی</span><span>{toman(detail.total_rial)}</span>
              </div>
            </section>

            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">پرداخت‌ها</h3>
              {detail.payments.length === 0 && <p className="text-xs text-[var(--kv-muted)]">تراکنشی ثبت نشده (پرداخت آفلاین/نقدی باید با یادداشت در تغییر وضعیت مستند شود).</p>}
              <div className="space-y-1.5">
                {detail.payments.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px]">
                    <div><b dir="ltr">{p.reference}</b><p className="text-[10px] text-[var(--kv-muted)]">درگاه: {p.provider ?? "—"} · {formatPersianDateTimeFull(p.created_at)}</p></div>
                    <div className="flex items-center gap-2"><span className="tabular-nums font-bold">{toman(p.amount_rial)}</span><BadgePill map={PAYMENT_BADGE} value={p.status} /></div>
                  </div>
                ))}
              </div>
            </section>

            {detail.order_type === "wholesale" && (detail.fulfillments?.length ?? 0) > 0 && (
              <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">زنجیره تأمین (تأمین‌کننده → انبار کلبه)</h3>
                <div className="space-y-1.5">
                  {detail.fulfillments!.map((f) => (
                    <div key={f.id} className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px]">
                      <div className="flex items-center justify-between"><b>{f.brand_name ?? "تأمین‌کننده"}</b><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold", Y)}>{WS_LABEL[f.status] ?? f.status}</span></div>
                      <p className="mt-0.5 text-[10px] text-[var(--kv-muted)]">
                        ارسال: {f.dispatched_at ? formatPersianDateTimeFull(f.dispatched_at) : "—"} · رسید: {f.arrived_at ? formatPersianDateTimeFull(f.arrived_at) : "—"} · پذیرش: {f.accepted_at ? formatPersianDateTimeFull(f.accepted_at) : "—"}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">تایم‌لاین (رویدادهای واقعی ثبت‌شده)</h3>
              <div className="space-y-1">
                {detail.events.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11.5px]">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--kv-action)]" />
                    <div>
                      <b>{eventLabel(e.to_status)}</b>
                      {e.note && <span className="text-[var(--kv-muted)]"> — {e.note}</span>}
                      <p className="text-[10px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(e.created_at)}</p>
                    </div>
                  </div>
                ))}
                {detail.events.length === 0 && <p className="text-xs text-[var(--kv-muted)]">رویدادی ثبت نشده است.</p>}
              </div>
            </section>

            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">عملیات</h3>
              <Textarea placeholder="یادداشت تغییر وضعیت (برای «پرداخت‌شده» بدون تراکنش موفق، الزامی است)" value={note} onChange={setNote} rows={2} />
              {actionError && <p className="mt-2 text-xs font-bold text-[var(--kv-danger)]">{actionError}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(NEXT_STATUS[detail.status] ?? []).map((s) => (
                  <Btn key={s} size="sm" variant={s === "cancelled" || s === "returned" ? "outline" : "soft"} disabled={saving} onClick={() => void transition(s)}>
                    {ORDER_BADGE[s]?.label ?? s}
                  </Btn>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.order_type === "wholesale" && !detail.consolidated_at && (
                  <Btn size="sm" variant="dark" disabled={saving} onClick={() => void wholesaleAction("consolidate")} icon={<Package size={14} />}>تجمیع سفارش در انبار کلبه</Btn>
                )}
                {detail.order_type === "wholesale" && detail.consolidated_at && !detail.vip_dispatched_at && (
                  <Btn size="sm" variant="dark" disabled={saving} onClick={() => void wholesaleAction("dispatch")} icon={<Truck size={14} />}>ارسال به VIP</Btn>
                )}
                <Btn size="sm" variant="soft" onClick={() => onTracking({ id: detail.id, reference: detail.reference, tracking_code: detail.tracking_code, shipment_carrier: detail.shipment_carrier })} icon={<Tag size={14} />}>
                  {detail.tracking_code ? "ویرایش رهگیری" : "+ ثبت رهگیری"}
                </Btn>
                <Btn size="sm" variant="soft" onClick={() => void printInvoice()} icon={<FileText size={14} />}>چاپ فاکتور</Btn>
                <Btn size="sm" variant="soft" onClick={printLabel} icon={<Printer size={14} />}>چاپ لیبل</Btn>
              </div>
            </section>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ----------------------------- manual sale drawer ----------------------------- */

function ManualSaleDrawer({ saleId, onClose }: { saleId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!saleId) return;
    setDetail(null); setError(null);
    manualSalesApi.detail(saleId).then(setDetail).catch((err) => setError(err instanceof Error ? err.message : "خطا"));
  }, [saleId]);
  if (!saleId) return null;
  const sale = detail?.sale as Record<string, unknown> | undefined ?? detail ?? undefined;
  const lines = (detail?.lines ?? (sale?.lines as unknown)) as Record<string, unknown>[] | undefined;
  const payments = (detail?.payments ?? (sale?.payments as unknown)) as Record<string, unknown>[] | undefined;
  return (
    <Drawer open onClose={onClose} title={`فروش ثبت‌دستی ${sale?.reference ?? ""}`}>
      <div className="space-y-4 p-5 text-[12.5px]">
        {error && <ErrorState message={error} />}
        {!detail && !error && <LoadingState />}
        {sale && (
          <>
            <div className="flex flex-wrap gap-2">
              <BadgePill map={ORDER_BADGE} value={String(sale.status ?? "")} />
              <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", N)}>کانال: {CHANNEL_LABEL[String(sale.channel) as keyof typeof CHANNEL_LABEL] ?? String(sale.channel)}</span>
            </div>
            <p className="font-bold">{String(sale.customer_name ?? "مشتری")} — <span dir="ltr">{String(sale.customer_phone ?? "")}</span></p>
            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">اقلام</h3>
              {(lines ?? []).map((l, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 text-[12px]">
                  <span className="truncate">{String(l.product_name ?? l.sku)}</span>
                  <span className="shrink-0 tabular-nums">×{fa(Number(l.quantity ?? 0))} — {toman(String(l.line_total_rial ?? l.unit_price_rial ?? "0"))}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between border-t border-[var(--kv-line)] pt-2 font-extrabold">
                <span>جمع</span><span>{toman(String(sale.total_rial ?? "0"))}</span>
              </div>
            </section>
            <section className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <h3 className="mb-2 text-xs font-extrabold text-[var(--kv-muted)]">پرداخت‌ها</h3>
              {(payments ?? []).map((p, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 text-[11.5px]">
                  <span>{METHOD_LABEL[String(p.payment_method)] ?? String(p.payment_method)} {p.reference ? `— ${String(p.reference)}` : ""}</span>
                  <span className="tabular-nums">{toman(String(p.amount_rial ?? "0"))} · {String(p.verification_status) === "verified" ? "تأییدشده" : String(p.verification_status) === "rejected" ? "ردشده" : "در انتظار تأیید"}</span>
                </div>
              ))}
            </section>
            <p className="text-[10.5px] text-[var(--kv-muted)]">مدیریت کامل فروش‌های ثبت‌دستی (تأیید پرداخت، لغو و…) در همین مرکز سفارشات از مسیر «فروش حضوری» موجود است؛ این رکورد یک سفارش واقعی است و موجودی خرده را مصرف کرده است.</p>
          </>
        )}
      </div>
    </Drawer>
  );
}

/* ----------------------------- bulk print actions ----------------------------- */

const PRINT_CAP = 30;

async function bulkPrintLabels(ids: string[], setBusy: (b: boolean) => void, setError: (m: string | null) => void) {
  setBusy(true); setError(null);
  try {
    const details: OrderDetail[] = [];
    for (const id of ids.slice(0, PRINT_CAP)) details.push(await ordersApi.get(id) as OrderDetail);
    openPrintWindow("لیبل‌های ارسال", LABEL_CSS, details.map(labelHtml).join(""));
  } catch (err) { setError(err instanceof Error ? err.message : "چاپ لیبل ناموفق بود."); }
  finally { setBusy(false); }
}

async function bulkPrintInvoices(rows: { id: string; reference: string; buyer_name: string | null }[], setBusy: (b: boolean) => void, setError: (m: string | null) => void) {
  setBusy(true); setError(null);
  try {
    const pages: string[] = [];
    const missing: string[] = [];
    for (const row of rows.slice(0, PRINT_CAP)) {
      const list = await invoicesApi.list({ orderId: row.id }) as { items: InvoiceSummary[] };
      const first = list.items[0];
      if (!first) { missing.push(row.reference); continue; }
      const inv = await invoicesApi.get(first.id) as InvoiceDetail;
      pages.push(invoiceHtml(inv, row.buyer_name ?? "—"));
    }
    if (missing.length) pages.push(`<div class="invoice missing">برای سفارش‌های زیر فاکتوری در سیستم فاکتور صادر نشده است:<br/>${missing.map(esc).join("، ")}</div>`);
    if (!pages.length) { setError("برای هیچ‌کدام از سفارش‌های انتخابی فاکتور صادر نشده است."); return; }
    openPrintWindow("چاپ گروهی فاکتورها", INVOICE_CSS, pages.join(""));
  } catch (err) { setError(err instanceof Error ? err.message : "چاپ فاکتور ناموفق بود."); }
  finally { setBusy(false); }
}

/* ----------------------------- presets (§32) ----------------------------- */

type PresetId = "all" | "needs_action" | "pending_payment" | "processing" | "preparing" | "ready_to_ship" | "shipped" | "delivered" | "problem" | "no_tracking";
const PRESETS: { id: PresetId; label: string }[] = [
  { id: "all", label: "همه" }, { id: "needs_action", label: "نیازمند اقدام" },
  { id: "pending_payment", label: "در انتظار پرداخت" }, { id: "processing", label: "در حال آماده‌سازی" },
  { id: "preparing", label: "آماده بسته‌بندی" }, { id: "ready_to_ship", label: "آماده ارسال" },
  { id: "shipped", label: "ارسال‌شده" }, { id: "delivered", label: "تحویل‌شده" },
  { id: "problem", label: "مشکل‌دار" }, { id: "no_tracking", label: "بدون کد رهگیری" },
];
function presetParams(preset: PresetId): Record<string, string> {
  switch (preset) {
    case "needs_action": return { status: "paid" };
    case "pending_payment": return { status: "pending_payment" };
    case "processing": return { status: "processing" };
    case "preparing": return { status: "preparing" };
    case "ready_to_ship": return { status: "ready_to_ship" };
    case "shipped": return { status: "shipped" };
    case "delivered": return { status: "delivered" };
    case "problem": return { problem: "1" };
    case "no_tracking": return { hasTracking: "0" };
    default: return {};
  }
}

const PAGE = 30;

/* ----------------------------- wholesale tab (§20-21) ----------------------------- */

function WholesaleTab({ scope }: { scope: "kolbe" | "supplier" }) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>("all");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [trackingOrder, setTrackingOrder] = useState<{ id: string; reference: string; tracking_code?: string | null; shipment_carrier?: string | null } | null>(null);

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true); setError(null);
    try {
      const params: Record<string, string> = {
        orderType: "wholesale", sellerScope: scope, withTotal: "1",
        limit: String(PAGE), offset: String(nextOffset), ...presetParams(preset),
      };
      if (applied) params.search = applied;
      if (paymentFilter) params.paymentStatus = paymentFilter;
      const res = await ordersApi.list(params) as unknown as { items: OrderRow[]; total?: number };
      setRows(res.items); setTotal(res.total ?? res.items.length); setOffset(nextOffset); setSelected(new Set());
    } catch (err) { setError(err instanceof Error ? err.message : "خطا در دریافت سفارش‌ها"); }
    finally { setLoading(false); }
  }, [scope, preset, applied, paymentFilter]);
  useEffect(() => { void load(0); }, [load]);

  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedRows = rows.filter((r) => selected.has(r.id));

  return (
    <div className="space-y-3">
      <PresetChips presets={PRESETS} active={preset} onPick={(p) => { setPreset(p); }} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full max-w-xs"><SearchBox placeholder="جست‌وجو: شماره، خریدار VIP، تلفن، SKU، رهگیری…" value={search} onChange={setSearch} /></div>
        <Btn size="sm" variant="soft" onClick={() => setApplied(search.trim())}>اعمال جست‌وجو</Btn>
        <LSelect label="وضعیت پرداخت" value={paymentFilter} onChange={setPaymentFilter}
          options={[{ v: "", label: "همه" }, ...Object.entries(PAYMENT_BADGE).map(([v, b]) => ({ v, label: b.label }))]} />
        <Btn size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load(offset)}>به‌روزرسانی</Btn>
        <span className="mr-auto text-[11px] font-bold text-[var(--kv-muted)]">{fa(total)} سفارش</span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-action)] bg-[var(--kv-surface)] px-3 py-2">
          <b className="text-[12px]">{fa(selected.size)} انتخاب‌شده</b>
          <Btn size="sm" onClick={() => setBulkOpen(true)}>تغییر وضعیت گروهی</Btn>
          <Btn size="sm" variant="soft" disabled={busy} icon={<FileText size={14} />} onClick={() => void bulkPrintInvoices(selectedRows, setBusy, setBulkError)}>چاپ فاکتورها</Btn>
          <Btn size="sm" variant="soft" disabled={busy} icon={<Printer size={14} />} onClick={() => void bulkPrintLabels([...selected], setBusy, setBulkError)}>چاپ لیبل‌ها</Btn>
          {bulkError && <span className="text-[11px] font-bold text-[var(--kv-danger)]">{bulkError}</span>}
        </div>
      )}

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={() => void load(offset)} />}
      {!loading && !error && rows.length === 0 && <Empty title="سفارشی یافت نشد" desc="با این فیلترها سفارش عمده‌ای ثبت نشده است." />}
      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-[14px] border border-[var(--kv-line)]">
          <table className="w-full min-w-[1100px] text-right text-[11.5px]">
            <thead className="bg-[var(--kv-surface-2)] text-[10.5px] text-[var(--kv-muted)]">
              <tr>
                <th className="p-2.5"><Checkbox checked={allChecked} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.id)) : new Set())} label="" /></th>
                <th className="p-2.5">شماره</th><th className="p-2.5">خریدار VIP</th>
                {scope === "supplier" && <th className="p-2.5">تأمین‌کننده</th>}
                <th className="p-2.5">اقلام</th><th className="p-2.5">مبلغ</th><th className="p-2.5">پرداخت</th>
                <th className="p-2.5">وضعیت سفارش</th>
                {scope === "supplier" && <th className="p-2.5">مرحله تأمین‌کننده</th>}
                {scope === "supplier" && <th className="p-2.5">مرحله انبار کلبه</th>}
                {scope === "kolbe" && <th className="p-2.5">مرحله عمده</th>}
                <th className="p-2.5">حمل</th><th className="p-2.5">رهگیری</th><th className="p-2.5">تاریخ</th><th className="p-2.5">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-[var(--kv-line)] hover:bg-[var(--kv-surface-2)]/60">
                  <td className="p-2.5"><Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} label="" /></td>
                  <td className="p-2.5 font-bold" dir="ltr">{r.reference}<ExceptionBadges reasons={r.exception_reasons} /></td>
                  <td className="p-2.5">{r.buyer_name ?? "—"}<p className="text-[10px] text-[var(--kv-muted)]" dir="ltr">{r.buyer_phone}</p></td>
                  {scope === "supplier" && <td className="p-2.5">{r.first_supplier ?? (r.supplier_names?.filter((s) => s !== "کلبه وینتیج")[0] ?? "—")}</td>}
                  <td className="p-2.5 tabular-nums">{fa(r.lines_count)}</td>
                  <td className="p-2.5 font-bold tabular-nums">{toman(r.total_rial)}</td>
                  <td className="p-2.5"><BadgePill map={PAYMENT_BADGE} value={r.payment_status ?? "none"} /></td>
                  <td className="p-2.5"><BadgePill map={ORDER_BADGE} value={r.status} /></td>
                  {scope === "supplier" && <td className="p-2.5 text-[10.5px] font-bold">{supplierStage(r.wholesale_fulfillment_status)}</td>}
                  {scope === "supplier" && <td className="p-2.5 text-[10.5px] font-bold">{kolbeStage(r.wholesale_fulfillment_status)}</td>}
                  {scope === "kolbe" && <td className="p-2.5 text-[10.5px] font-bold">{r.wholesale_fulfillment_status ? (WS_LABEL[r.wholesale_fulfillment_status] ?? r.wholesale_fulfillment_status) : "—"}</td>}
                  <td className="p-2.5"><BadgePill map={SHIPMENT_BADGE} value={r.shipment_status} /></td>
                  <td className="p-2.5" dir="ltr">
                    {r.tracking_code ?? (
                      <button className="rounded-full border border-dashed border-[var(--kv-line-strong)] px-2 py-0.5 text-[10px] font-bold text-[var(--kv-muted)] hover:border-[var(--kv-action)]"
                        onClick={() => setTrackingOrder({ id: r.id, reference: r.reference, tracking_code: r.tracking_code, shipment_carrier: r.shipment_carrier })}>+ ثبت</button>
                    )}
                  </td>
                  <td className="p-2.5 text-[10.5px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(r.created_at)}</td>
                  <td className="p-2.5"><Btn size="sm" variant="ghost" onClick={() => setDrawerId(r.id)}>جزئیات</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager offset={offset} total={total} onPage={(o) => void load(o)} />

      <BulkStatusModal ids={[...selected]} open={bulkOpen} onClose={() => setBulkOpen(false)} onDone={() => void load(offset)} />
      <TrackingModal order={trackingOrder} onClose={() => setTrackingOrder(null)} onDone={() => void load(offset)} />
      <OrderDrawer orderId={drawerId} onClose={() => setDrawerId(null)} onChanged={() => void load(offset)} onTracking={(o) => setTrackingOrder(o)} />
    </div>
  );
}

function Pager({ offset, total, onPage }: { offset: number; total: number; onPage: (o: number) => void }) {
  if (total <= PAGE) return null;
  return (
    <div className="flex items-center justify-center gap-3 text-[11.5px] font-bold">
      <Btn size="sm" variant="soft" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - PAGE))}>صفحه قبل</Btn>
      <span className="tabular-nums text-[var(--kv-muted)]">{fa(offset + 1)}–{fa(Math.min(offset + PAGE, total))} از {fa(total)}</span>
      <Btn size="sm" variant="soft" disabled={offset + PAGE >= total} onClick={() => onPage(offset + PAGE)}>صفحه بعد</Btn>
    </div>
  );
}

/* ----------------------------- retail tab (§19, §22-23) ----------------------------- */

function RetailTab() {
  const [rows, setRows] = useState<RetailRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<PresetId>("all");
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [channel, setChannel] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [manualSaleId, setManualSaleId] = useState<string | null>(null);
  const [trackingOrder, setTrackingOrder] = useState<{ id: string; reference: string; tracking_code?: string | null; shipment_carrier?: string | null } | null>(null);

  const load = useCallback(async (nextOffset = 0) => {
    setLoading(true); setError(null);
    try {
      const pp = presetParams(preset);
      const params: Record<string, string> = { limit: String(PAGE), offset: String(nextOffset) };
      if (pp.status) params.status = pp.status;
      if (pp.problem) params.problem = pp.problem;
      if (pp.hasTracking) { params.hasTracking = pp.hasTracking; params.kind = "order"; }
      if (applied) params.search = applied;
      if (channel) params.channel = channel;
      if (paymentFilter) params.paymentStatus = paymentFilter;
      const res = await omsApi.retailSales(params);
      setRows(res.items as unknown as RetailRow[]); setTotal(res.total); setOffset(nextOffset); setSelected(new Set());
    } catch (err) { setError(err instanceof Error ? err.message : "خطا در دریافت فروش‌های خرده"); }
    finally { setLoading(false); }
  }, [preset, applied, channel, paymentFilter]);
  useEffect(() => { void load(0); }, [load]);

  const orderRows = rows.filter((r) => r.kind === "order");
  const allChecked = orderRows.length > 0 && orderRows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectedRows = orderRows.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, reference: r.reference, buyer_name: r.buyer_name }));

  return (
    <div className="space-y-3">
      <PresetChips presets={PRESETS} active={preset} onPick={setPreset} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-full max-w-xs"><SearchBox placeholder="جست‌وجو: شماره، مشتری، تلفن، کد رهگیری…" value={search} onChange={setSearch} /></div>
        <Btn size="sm" variant="soft" onClick={() => setApplied(search.trim())}>اعمال جست‌وجو</Btn>
        <LSelect label="کانال فروش" value={channel} onChange={setChannel}
          options={[{ v: "", label: "همه کانال‌ها" }, ...Object.entries(CHANNEL_LABEL).map(([v, label]) => ({ v, label }))]} />
        <LSelect label="وضعیت پرداخت" value={paymentFilter} onChange={setPaymentFilter}
          options={[{ v: "", label: "همه" }, { v: "succeeded", label: "موفق" }, { v: "pending", label: "در انتظار" }, { v: "failed", label: "ناموفق" }, { v: "refunded", label: "استردادشده" }, { v: "none", label: "بدون تراکنش" }]} />
        <Btn size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load(offset)}>به‌روزرسانی</Btn>
        <span className="mr-auto text-[11px] font-bold text-[var(--kv-muted)]">{fa(total)} رکورد (سفارش سایت + فروش ثبت‌دستی)</span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-action)] bg-[var(--kv-surface)] px-3 py-2">
          <b className="text-[12px]">{fa(selected.size)} سفارش انتخاب‌شده</b>
          <Btn size="sm" onClick={() => setBulkOpen(true)}>تغییر وضعیت گروهی</Btn>
          <Btn size="sm" variant="soft" disabled={busy} icon={<FileText size={14} />} onClick={() => void bulkPrintInvoices(selectedRows, setBusy, setBulkError)}>چاپ فاکتورها</Btn>
          <Btn size="sm" variant="soft" disabled={busy} icon={<Printer size={14} />} onClick={() => void bulkPrintLabels([...selected], setBusy, setBulkError)}>چاپ لیبل‌ها</Btn>
          {bulkError && <span className="text-[11px] font-bold text-[var(--kv-danger)]">{bulkError}</span>}
        </div>
      )}

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={() => void load(offset)} />}
      {!loading && !error && rows.length === 0 && <Empty title="فروشی یافت نشد" desc="با این فیلترها فروش خرده‌ای ثبت نشده است." />}
      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-[14px] border border-[var(--kv-line)]">
          <table className="w-full min-w-[1150px] text-right text-[11.5px]">
            <thead className="bg-[var(--kv-surface-2)] text-[10.5px] text-[var(--kv-muted)]">
              <tr>
                <th className="p-2.5"><Checkbox checked={allChecked} onChange={(v) => setSelected(v ? new Set(orderRows.map((r) => r.id)) : new Set())} label="" /></th>
                <th className="p-2.5">شماره</th><th className="p-2.5">خریدار</th><th className="p-2.5">کانال</th>
                <th className="p-2.5">اقلام</th><th className="p-2.5">مبلغ</th><th className="p-2.5">روش پرداخت</th>
                <th className="p-2.5">وضعیت پرداخت</th><th className="p-2.5">وضعیت سفارش</th><th className="p-2.5">حمل</th>
                <th className="p-2.5">کد رهگیری</th><th className="p-2.5">تاریخ</th><th className="p-2.5">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}-${r.id}`} className="border-t border-[var(--kv-line)] hover:bg-[var(--kv-surface-2)]/60">
                  <td className="p-2.5">
                    {r.kind === "order"
                      ? <Checkbox checked={selected.has(r.id)} onChange={() => toggle(r.id)} label="" />
                      : <span title="فروش ثبت‌دستی چرخه وضعیت سفارش سایت را ندارد" className="text-[var(--kv-muted)]">—</span>}
                  </td>
                  <td className="p-2.5 font-bold" dir="ltr">
                    {r.reference}
                    {r.kind === "manual_sale" && <span className={cn("mr-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold", N)}>ثبت‌دستی</span>}
                    <ExceptionBadges reasons={r.exception_reasons} />
                  </td>
                  <td className="p-2.5">{r.buyer_name ?? "—"}<p className="text-[10px] text-[var(--kv-muted)]" dir="ltr">{r.buyer_phone}</p></td>
                  <td className="p-2.5 text-[10.5px] font-bold">{CHANNEL_LABEL[r.channel as keyof typeof CHANNEL_LABEL] ?? r.channel}</td>
                  <td className="p-2.5 tabular-nums">{fa(r.lines_count)}</td>
                  <td className="p-2.5 font-bold tabular-nums">{toman(r.total_rial)}</td>
                  <td className="p-2.5 text-[10.5px]">
                    {r.payment_method ? (METHOD_LABEL[r.payment_method] ?? r.payment_method) : "—"}
                    {r.payment_provider && <p className="text-[9.5px] text-[var(--kv-muted)]" dir="ltr">{r.payment_provider}</p>}
                  </td>
                  <td className="p-2.5"><BadgePill map={PAYMENT_BADGE} value={r.payment_status} /></td>
                  <td className="p-2.5"><BadgePill map={ORDER_BADGE} value={r.status} /></td>
                  <td className="p-2.5"><BadgePill map={SHIPMENT_BADGE} value={r.shipment_status} /></td>
                  <td className="p-2.5" dir="ltr">
                    {r.tracking_code ?? (r.kind === "order" ? (
                      <button className="rounded-full border border-dashed border-[var(--kv-line-strong)] px-2 py-0.5 text-[10px] font-bold text-[var(--kv-muted)] hover:border-[var(--kv-action)]"
                        onClick={() => setTrackingOrder({ id: r.id, reference: r.reference, tracking_code: r.tracking_code, shipment_carrier: r.carrier })}>+ ثبت</button>
                    ) : "—")}
                  </td>
                  <td className="p-2.5 text-[10.5px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(r.created_at)}</td>
                  <td className="p-2.5">
                    <Btn size="sm" variant="ghost" onClick={() => r.kind === "order" ? setDrawerId(r.id) : setManualSaleId(r.id)}>جزئیات</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager offset={offset} total={total} onPage={(o) => void load(o)} />

      <BulkStatusModal ids={[...selected]} open={bulkOpen} onClose={() => setBulkOpen(false)} onDone={() => void load(offset)} />
      <TrackingModal order={trackingOrder} onClose={() => setTrackingOrder(null)} onDone={() => void load(offset)} />
      <OrderDrawer orderId={drawerId} onClose={() => setDrawerId(null)} onChanged={() => void load(offset)} onTracking={(o) => setTrackingOrder(o)} />
      <ManualSaleDrawer saleId={manualSaleId} onClose={() => setManualSaleId(null)} />
    </div>
  );
}

/* ----------------------------- hub (§18: exactly three tabs) ----------------------------- */

export function OrdersHub() {
  const [tab, setTab] = useState<"retail" | "kolbe" | "supplier">("retail");
  const [trackingOpen, setTrackingOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [retailReload, setRetailReload] = useState(0);
  const tabs = useMemo(() => ([
    { v: "retail" as const, label: "سفارشات خرده" },
    { v: "kolbe" as const, label: "سفارشات عمده کلبه" },
    { v: "supplier" as const, label: "سفارشات عمده تأمین‌کنندگان" },
  ]), []);
  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)]"><ClipboardList size={18} /></span>
        <Segmented options={tabs} value={tab} onChange={setTab} />
        <div className="mr-auto flex flex-wrap gap-2">
          {/* §31: manual sale lives inside مرکز سفارشات (retail). §1.3: operational tracking lives here too. */}
          {tab === "retail" && <Btn size="sm" onClick={() => setManualOpen(true)}>+ ثبت سفارش دستی</Btn>}
          <Btn size="sm" variant="soft" icon={<Truck size={14} />} onClick={() => setTrackingOpen(true)}>مرکز رهگیری مرسوله‌ها</Btn>
        </div>
      </div>
      {tab === "retail" && <RetailTab key={retailReload} />}
      {tab === "kolbe" && <WholesaleTab scope="kolbe" key="kolbe" />}
      {tab === "supplier" && <WholesaleTab scope="supplier" key="supplier" />}
      {trackingOpen && (
        <Drawer open onClose={() => setTrackingOpen(false)} title="مرکز رهگیری مرسوله‌ها" wide>
          <div className="p-5"><TrackingCenter flash={() => undefined} /></div>
        </Drawer>
      )}
      {manualOpen && (
        <Drawer open onClose={() => { setManualOpen(false); setRetailReload((n) => n + 1); }} title="ثبت سفارش دستی (سفارش واقعی)" wide>
          {/* §31-§35: creates a REAL order on the canonical pipeline; legacy «ثبت‌دستی» records stay readable in the unified retail list. */}
          <div className="p-5"><ManualOrderForm /></div>
        </Drawer>
      )}
    </div>
  );
}
