import { useEffect, useState } from "react";
import { Btn, Card, LoadingState, ErrorState, Empty } from "../components/primitives";
import { ordersApi } from "../data/api";
import { fmtMoney } from "../data/catalog";

type Order = { id: string; reference: string; status: string; total_rial: string; created_at: string; buyer_name: string };

export function SupplierOrdersPanel() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [selected, setSelected] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await ordersApi.supplierList() as { items: Order[] };
      setOrders(r.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);
  const open = async (id: string) => {
    try { const d = await ordersApi.supplierDetail(id); setSelected(d); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  if (loading) return <LoadingState label="در حال بارگذاری سفارش‌های تأمین‌کننده…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!orders || orders.length === 0) return <Empty title="سفارشی نیست" desc="هنوز سفارشی شامل محصولات شما ثبت نشده است." />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="overflow-x-auto rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
        <table className="kv-table min-w-[900px] text-xs">
          <thead><tr><th>شماره مرجع</th><th>نوع سفارش</th><th>خریدار</th><th>مبلغ</th><th>وضعیت</th><th>جزئیات</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="font-mono font-bold">{o.reference}</td>
                <td>عمده/خرده</td>
                <td>{o.buyer_name ?? "—"}</td>
                <td className="tabular-nums">{fmtMoney(Number(o.total_rial))}</td>
                <td><span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-1 text-[11px]">{o.status}</span></td>
                <td><Btn variant="soft" size="sm" onClick={() => void open(o.id)}>نمایش</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(selected !== null) && (
        <Card className="p-4">
          <p className="text-[13px] font-extrabold">جزئیات سفارش</p>
          <pre className="mt-3 overflow-auto rounded-lg bg-[var(--kv-surface-2)] p-3 text-xs leading-6">{String(JSON.stringify(selected as object, null, 2))}</pre>
          <div className="mt-4 grid gap-2 md:grid-cols-3">
            {["confirmed","preparing","ready_to_ship"].map((st) => (
              <Btn key={st} variant="soft" size="sm" onClick={async () => {
                try { await ordersApi.supplierFulfillment((selected as { id: string }).id, { status: st as never }); void open((selected as { id: string }).id); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
              }}>{st}</Btn>
            ))}
          </div>
          <Btn variant="ghost" size="sm" className="mt-3" onClick={() => setSelected(null)}>بستن</Btn>
        </Card>
      )}
      <div className="rounded-lg bg-[var(--kv-surface-2)] p-3 text-xs leading-6 text-[var(--kv-muted)]">
        chaque transition server-side validate می‌شود. وضعیت‌های مجاز: received → confirmed → sourcing → preparing → ready_to_ship → handed_to_carrier → shipped → delivered → completed
      </div>
    </div>
  );
}
