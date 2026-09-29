import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { ApiRequest } from "../data/api";
import { ORDER_SORTS, ORDER_SORT_LABEL, readPricingSnapshot, type OrderSort } from "../data/contracts";

type OrderStatus = "pending_payment" | "paid" | "processing" | "preparing" | "ready_to_ship" | "in_transit" | "shipped" | "delivered" | "cancelled" | "returned";
type Order = {
  id: string; reference: string; buyer_id: string; buyer_name: string | null; buyer_phone: string | null;
  order_type: "retail" | "wholesale"; payment_mode: string; status: OrderStatus; total_rial: string;
  created_at: string; updated_at: string; lines_count: number; payment_status: string | null;
  supplier_names: string[] | null;
};
type OrderDetail = Order & {
  subtotal_rial: string; discount_rial: string; shipping_rial: string;
  shipping_address: { recipient: string; phone: string; province: string; city: string; line: string; postalCode: string };
  shipping_code: string | null; shipping_name: string | null;
  pricing_snapshot: unknown;
  lines: { id: string; sku: string; product_name: string; quantity: number; unit_price_rial: string; line_total_rial: string }[];
  events: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
  payments: { id: string; reference: string; provider: string; amount_rial: string; status: string; created_at: string }[];
};

const labels: Record<OrderStatus, string> = {
  pending_payment: "در انتظار پرداخت", paid: "پرداخت‌شده", processing: "در حال پردازش", preparing: "در حال آماده‌سازی",
  ready_to_ship: "آمادهٔ ارسال", in_transit: "در حال ارسال", shipped: "ارسال‌شده", delivered: "تحویل‌شده",
  cancelled: "لغوشده", returned: "مرجوع‌شده",
};
const paymentLabels: Record<string, string> = { pending: "در انتظار", succeeded: "موفق", failed: "ناموفق", refunded: "برگشتی" };
const nextStatus: Partial<Record<OrderStatus, OrderStatus>> = {
  paid: "processing", processing: "preparing", preparing: "ready_to_ship", ready_to_ship: "in_transit",
  in_transit: "shipped", shipped: "delivered",
};
const money = (value: string) => `${new Intl.NumberFormat("fa-IR").format(BigInt(value))} ریال`;
const date = (value: string) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function AdminServerOrders({ request }: { request: ApiRequest }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sort, setSort] = useState<OrderSort>("newest");
  const [orderType, setOrderType] = useState<"" | "retail" | "wholesale">("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [status, setStatus] = useState("");

  const buildQuery = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: "50", offset: String(offset), sort });
    if (orderType) params.set("orderType", orderType);
    if (paymentStatus) params.set("paymentStatus", paymentStatus);
    if (status) params.set("status", status);
    if (appliedQuery.trim()) params.set("search", appliedQuery.trim());
    return params.toString();
  }, [sort, orderType, paymentStatus, status, appliedQuery]);

  const loadOrders = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>(`/orders?${buildQuery(0)}`);
      setOrders(result.items);
      setHasMore(result.items.length === 50);
      setSelected((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "دریافت سفارش‌ها ناموفق بود."); }
    finally { setLoading(false); }
  }, [request, buildQuery]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>(`/orders?${buildQuery(orders.length)}`);
      setOrders((current) => [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))]);
      setHasMore(result.items.length === 50);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "دریافت سفارش‌های بیشتر ناموفق بود."); }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { void loadOrders(); }, [loadOrders]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null); setDetailLoading(true);
    request<OrderDetail>(`/orders/${selected}`).then((result) => { if (!cancelled) setDetail(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "دریافت جزئیات ناموفق بود."); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [request, selected]);

  const transition = async (next: OrderStatus) => {
    if (!detail || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/orders/${detail.id}/transitions`, { method: "POST", body: JSON.stringify({ status: next, note: note.trim() || undefined }) });
      setNote("");
      const updated = await request<OrderDetail>(`/orders/${detail.id}`);
      setDetail(updated);
      setOrders((items) => items.map((item) => item.id === updated.id ? { ...item, status: updated.status } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تغییر وضعیت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const selectClass = "mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]";
  const snapshot = detail ? readPricingSnapshot(detail.pricing_snapshot) : null;

  return (
    <section aria-label="سفارش‌های واقعی" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-bold">سفارش‌های ثبت‌شده در سرور</h2><p className="text-xs text-[var(--kv-muted)]">مرتب‌سازی، فیلتر و مبالغ همگی از پایگاه‌داده می‌آیند.</p></div>
        <button type="button" onClick={() => void loadOrders()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--kv-line)] px-3 text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50"><RefreshCw size={15} />به‌روزرسانی</button>
      </div>
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"><span>{error}</span><button type="button" onClick={() => void loadOrders()} className="font-bold underline">تلاش دوباره</button></div>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
        <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="grid gap-2 border-b border-[var(--kv-line)] p-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="block text-xs font-semibold">جست‌وجو (شماره، خریدار، SKU)<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setAppliedQuery(query); }} className="mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label>
            <label className="block text-xs font-semibold">مرتب‌سازی<select value={sort} onChange={(event) => setSort(event.target.value as OrderSort)} className={selectClass}>{ORDER_SORTS.map((value) => <option key={value} value={value}>{ORDER_SORT_LABEL[value]}</option>)}</select></label>
            <label className="block text-xs font-semibold">نوع سفارش<select value={orderType} onChange={(event) => setOrderType(event.target.value as "" | "retail" | "wholesale")} className={selectClass}><option value="">همه</option><option value="retail">خرده</option><option value="wholesale">عمده</option></select></label>
            <label className="block text-xs font-semibold">وضعیت پرداخت<select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} className={selectClass}><option value="">همه</option><option value="pending">در انتظار</option><option value="succeeded">موفق</option><option value="failed">ناموفق</option><option value="refunded">برگشتی</option><option value="none">بدون پرداخت</option></select></label>
            <label className="block text-xs font-semibold">وضعیت سفارش<select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass}><option value="">همه</option>{(Object.keys(labels) as OrderStatus[]).map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
            <div className="flex items-end"><button type="button" onClick={() => setAppliedQuery(query)} className="min-h-10 w-full rounded-lg bg-[var(--kv-action)] px-4 text-sm font-bold text-[var(--kv-bg)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]">اعمال جست‌وجو</button></div>
          </div>
          {loading ? <p role="status" className="p-5 text-sm text-[var(--kv-muted)]">در حال دریافت سفارش‌ها…</p> :
            orders.length === 0 ? <p className="p-5 text-sm text-[var(--kv-muted)]">سفارشی با این فیلتر پیدا نشد.</p> :
              <div className="max-h-[650px] divide-y divide-[var(--kv-line)] overflow-y-auto">
                {orders.map((order) => <button key={order.id} type="button" onClick={() => setSelected(order.id)} aria-current={selected === order.id ? "true" : undefined}
                  className="flex w-full items-center gap-3 p-3 text-right hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] aria-current:bg-[var(--kv-surface-2)]">
                  <span className="min-w-0 flex-1"><strong className="block text-sm" dir="ltr">{order.reference}</strong>
                    <span className="mt-1 block truncate text-xs text-[var(--kv-muted)]">{order.buyer_name ?? "—"} · {order.order_type === "retail" ? "خرده" : "عمده"} · {order.lines_count.toLocaleString("fa-IR")} قلم · پرداخت: {order.payment_status ? paymentLabels[order.payment_status] ?? order.payment_status : "—"}</span>
                    <span className="block text-[11px] text-[var(--kv-muted)]">{date(order.created_at)}{(order.supplier_names?.length ?? 0) > 0 && ` · ${(order.supplier_names ?? []).join("، ")}`}</span></span>
                  <span className="text-left"><span className="block text-sm font-bold tabular-nums">{money(order.total_rial)}</span><span className="text-xs text-[var(--kv-muted)]">{labels[order.status]}</span></span><ArrowLeft size={15} className="shrink-0" />
                </button>)}
              </div>}
          {hasMore && !loading && <div className="border-t border-[var(--kv-line)] p-3"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="min-h-10 w-full rounded-lg border border-[var(--kv-line)] text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{loadingMore ? "در حال دریافت…" : "نمایش سفارش‌های بیشتر"}</button></div>}
        </div>
        <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
          {detailLoading ? <p role="status" className="text-sm text-[var(--kv-muted)]">در حال دریافت جزئیات…</p> : !detail ? <p className="text-sm text-[var(--kv-muted)]">یک سفارش را برای دیدن جزئیات انتخاب کنید.</p> : <div className="space-y-4">
            <div><p className="text-xs text-[var(--kv-muted)]" dir="ltr">{detail.reference}</p><h3 className="mt-1 text-base font-bold">{detail.shipping_address.recipient}</h3><p className="text-xs text-[var(--kv-muted)]">{labels[detail.status]} · {money(detail.total_rial)} · {detail.payment_mode === "four_installments" ? "چهار قسط" : "نقدی"}</p></div>
            <div className="space-y-2 border-y border-[var(--kv-line)] py-3 text-sm">{detail.lines.map((line) => <div key={line.id} className="flex justify-between gap-2"><span className="min-w-0">{line.product_name} <span className="text-xs text-[var(--kv-muted)]" dir="ltr">{line.sku}</span> × {line.quantity}</span><span className="shrink-0 tabular-nums">{money(line.line_total_rial)}</span></div>)}</div>
            {snapshot && (
              <div className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[12.5px]">
                <p className="mb-1.5 font-extrabold">صورت‌حساب سرور (لحظه ثبت)</p>
                <div className="space-y-1">
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">جمع اقلام</span><b className="tabular-nums">{money(snapshot.baseSubtotalRial)}</b></div>
                  {BigInt(snapshot.planDiscountRial) > 0n && <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تخفیف پلن عمده</span><b className="tabular-nums">−{money(snapshot.planDiscountRial)}</b></div>}
                  {BigInt(snapshot.promoDiscountRial) > 0n && <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تخفیف جشنواره/کوپن ({snapshot.promoSource})</span><b className="tabular-nums">−{money(snapshot.promoDiscountRial)}</b></div>}
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">هزینه ارسال{detail.shipping_name ? ` (${detail.shipping_name})` : ""}{snapshot.shipping ? ` · ${snapshot.shipping.totalWeightGrams.toLocaleString("fa-IR")} گرم` : ""}</span><b className="tabular-nums">{snapshot.shippingRial === "0" ? "رایگان" : money(snapshot.shippingRial)}</b></div>
                  <div className="flex justify-between border-t border-[var(--kv-line)] pt-1"><span className="font-bold">جمع کل</span><b className="tabular-nums">{money(snapshot.totalRial)}</b></div>
                  {snapshot.installment && (
                    <p className="pt-1 text-[var(--kv-muted)]">{snapshot.installment.eligible
                      ? snapshot.installment.perInstallmentRial ? `۴ قسط ${money(snapshot.installment.perInstallmentRial)}` : "قسط: مجاز"
                      : `قسط غیرمجاز: ${snapshot.installment.reason ?? "—"}`}</p>
                  )}
                </div>
              </div>
            )}
            {detail.payments.length > 0 && (
              <div className="text-xs leading-6"><p className="text-sm font-bold">پرداخت‌ها</p>{detail.payments.map((payment) => <p key={payment.id} className="text-[var(--kv-muted)]"><span dir="ltr">{payment.reference}</span> · {payment.provider} · {money(payment.amount_rial)} · {paymentLabels[payment.status] ?? payment.status}</p>)}</div>
            )}
            <div className="text-xs leading-6 text-[var(--kv-muted)]"><p>گیرنده: {detail.shipping_address.phone}</p><p>نشانی: {detail.shipping_address.province}، {detail.shipping_address.city}، {detail.shipping_address.line}</p></div>
            <div><h4 className="text-sm font-bold">تاریخچه وضعیت</h4><ol className="mt-2 space-y-2 border-r border-[var(--kv-line)] pr-3">{detail.events.map((event, index) => <li key={`${event.created_at}-${index}`} className="text-xs"><span className="font-semibold">{labels[event.to_status as OrderStatus] ?? event.to_status}</span><span className="mr-2 text-[var(--kv-muted)]">{date(event.created_at)}</span>{event.note && <p className="mt-1 text-[var(--kv-muted)]">{event.note}</p>}</li>)}</ol></div>
            {nextStatus[detail.status] && <div className="space-y-2 border-t border-[var(--kv-line)] pt-3"><label className="block text-xs font-semibold">یادداشت تغییر وضعیت<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label><button type="button" disabled={saving} onClick={() => void transition(nextStatus[detail.status]!)} className="min-h-10 rounded-lg bg-[var(--kv-action)] px-4 text-sm font-bold text-[var(--kv-bg)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{saving ? "در حال ثبت…" : `ثبت وضعیت «${labels[nextStatus[detail.status]!] }»`}</button></div>}
          </div>}
        </div>
      </div>
    </section>
  );
}
