import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { ApiRequest } from "../data/admin-api";

type OrderStatus = "pending_payment" | "paid" | "processing" | "preparing" | "ready_to_ship" | "in_transit" | "shipped" | "delivered" | "cancelled" | "returned";
type Order = { id: string; reference: string; buyer_id: string; order_type: "retail" | "wholesale"; payment_mode: string; status: OrderStatus; total_rial: string; created_at: string };
type OrderDetail = Order & {
  shipping_address: { recipient: string; phone: string; province: string; city: string; line: string; postalCode: string };
  lines: { id: string; sku: string; product_name: string; quantity: number; unit_price_rial: string; line_total_rial: string }[];
  events: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
};

const labels: Record<OrderStatus, string> = {
  pending_payment: "در انتظار پرداخت", paid: "پرداخت‌شده", processing: "در حال پردازش", preparing: "در حال آماده‌سازی",
  ready_to_ship: "آمادهٔ ارسال", in_transit: "در حال ارسال", shipped: "ارسال‌شده", delivered: "تحویل‌شده",
  cancelled: "لغوشده", returned: "مرجوع‌شده",
};
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

  const loadOrders = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>("/orders?limit=100");
      setOrders(result.items);
      setHasMore(result.items.length === 100);
      setSelected((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "دریافت سفارش‌ها ناموفق بود."); }
    finally { setLoading(false); }
  }, [request]);

  const loadMore = async () => {
    const last = orders[orders.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>(`/orders?limit=100&before=${encodeURIComponent(last.created_at)}`);
      setOrders((current) => [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))]);
      setHasMore(result.items.length === 100);
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

  const transition = async (status: OrderStatus) => {
    if (!detail || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/orders/${detail.id}/transitions`, { method: "POST", body: JSON.stringify({ status, note: note.trim() || undefined }) });
      setNote("");
      const updated = await request<OrderDetail>(`/orders/${detail.id}`);
      setDetail(updated);
      setOrders((items) => items.map((item) => item.id === updated.id ? { ...item, status: updated.status } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تغییر وضعیت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const visible = orders.filter((order) => !query.trim() || `${order.reference} ${order.buyer_id}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <section aria-label="سفارش‌های واقعی" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-bold">سفارش‌های ثبت‌شده در سرور</h2><p className="text-xs text-[var(--kv-muted)]">مبلغ و وضعیت از پایگاه‌داده خوانده می‌شود.</p></div>
        <button type="button" onClick={() => void loadOrders()} disabled={loading} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--kv-line)] px-3 text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50"><RefreshCw size={15} />به‌روزرسانی</button>
      </div>
      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"><span>{error}</span><button type="button" onClick={() => void loadOrders()} className="font-bold underline">تلاش دوباره</button></div>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
        <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="border-b border-[var(--kv-line)] p-3"><label className="block text-xs font-semibold">جست‌وجوی شماره سفارش یا شناسه خریدار<input value={query} onChange={(event) => setQuery(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label></div>
          {loading ? <p role="status" className="p-5 text-sm text-[var(--kv-muted)]">در حال دریافت سفارش‌ها…</p> :
            visible.length === 0 ? <p className="p-5 text-sm text-[var(--kv-muted)]">سفارشی برای نمایش پیدا نشد.</p> :
              <div className="max-h-[650px] divide-y divide-[var(--kv-line)] overflow-y-auto">
                {visible.map((order) => <button key={order.id} type="button" onClick={() => setSelected(order.id)} aria-current={selected === order.id ? "true" : undefined}
                  className="flex w-full items-center gap-3 p-3 text-right hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] aria-current:bg-[var(--kv-surface-2)]">
                  <span className="min-w-0 flex-1"><strong className="block text-sm" dir="ltr">{order.reference}</strong><span className="mt-1 block text-xs text-[var(--kv-muted)]">{order.order_type === "retail" ? "خرده" : "عمده"} · {date(order.created_at)}</span></span>
                  <span className="text-left"><span className="block text-sm font-bold tabular-nums">{money(order.total_rial)}</span><span className="text-xs text-[var(--kv-muted)]">{labels[order.status]}</span></span><ArrowLeft size={15} className="shrink-0" />
                </button>)}
              </div>}
          {hasMore && !loading && <div className="border-t border-[var(--kv-line)] p-3"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="min-h-10 w-full rounded-lg border border-[var(--kv-line)] text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{loadingMore ? "در حال دریافت…" : "نمایش سفارش‌های بیشتر"}</button></div>}
        </div>
        <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
          {detailLoading ? <p role="status" className="text-sm text-[var(--kv-muted)]">در حال دریافت جزئیات…</p> : !detail ? <p className="text-sm text-[var(--kv-muted)]">یک سفارش را برای دیدن جزئیات انتخاب کنید.</p> : <div className="space-y-4">
            <div><p className="text-xs text-[var(--kv-muted)]" dir="ltr">{detail.reference}</p><h3 className="mt-1 text-base font-bold">{detail.shipping_address.recipient}</h3><p className="text-xs text-[var(--kv-muted)]">{labels[detail.status]} · {money(detail.total_rial)}</p></div>
            <div className="space-y-2 border-y border-[var(--kv-line)] py-3 text-sm">{detail.lines.map((line) => <div key={line.id} className="flex justify-between gap-2"><span className="min-w-0">{line.product_name} <span className="text-xs text-[var(--kv-muted)]" dir="ltr">{line.sku}</span> × {line.quantity}</span><span className="shrink-0 tabular-nums">{money(line.line_total_rial)}</span></div>)}</div>
            <div className="text-xs leading-6 text-[var(--kv-muted)]"><p>گیرنده: {detail.shipping_address.phone}</p><p>نشانی: {detail.shipping_address.province}، {detail.shipping_address.city}، {detail.shipping_address.line}</p></div>
            <div><h4 className="text-sm font-bold">تاریخچه وضعیت</h4><ol className="mt-2 space-y-2 border-r border-[var(--kv-line)] pr-3">{detail.events.map((event, index) => <li key={`${event.created_at}-${index}`} className="text-xs"><span className="font-semibold">{labels[event.to_status as OrderStatus] ?? event.to_status}</span><span className="mr-2 text-[var(--kv-muted)]">{date(event.created_at)}</span>{event.note && <p className="mt-1 text-[var(--kv-muted)]">{event.note}</p>}</li>)}</ol></div>
            {nextStatus[detail.status] && <div className="space-y-2 border-t border-[var(--kv-line)] pt-3"><label className="block text-xs font-semibold">یادداشت تغییر وضعیت<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label><button type="button" disabled={saving} onClick={() => void transition(nextStatus[detail.status]!)} className="min-h-10 rounded-lg bg-[var(--kv-action)] px-4 text-sm font-bold text-[var(--kv-bg)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{saving ? "در حال ثبت…" : `ثبت وضعیت «${labels[nextStatus[detail.status]!] }»`}</button></div>}
          </div>}
        </div>
      </div>
    </section>
  );
}
