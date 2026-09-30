import { useEffect, useState } from "react";
import { Btn, Card, Empty, ErrorState, LoadingState } from "../components/primitives";
import { ordersApi, invoicesApi } from "../data/api";
import { fmtMoney } from "../data/catalog";

export function CustomerOrdersPanel() {
  const [orders, setOrders] = useState<{ id: string; reference: string; status: string; total_rial: string; created_at: string }[] | null>(null);
  const [detail, setDetail] = useState<unknown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try { const r = await ordersApi.list() as { items: typeof orders }; setOrders(r.items); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!orders) return <LoadingState label="در حال بارگذاری سفارش‌ها…" />;
  if (orders.length === 0) return <Empty title="سفارشی نیست" desc="هنوز سفارشی ثبت نکرده‌اید." />;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
        <table className="kv-table min-w-[700px] text-xs">
          <thead><tr><th>مرجع</th><th>وضعیت</th><th>مبلغ</th><th>تاریخ</th><th>جزئیات</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="font-mono">{o.reference}</td>
                <td><span className="rounded bg-[var(--kv-surface-2)] px-2 py-1">{o.status}</span></td>
                <td className="tabular-nums">{fmtMoney(Number(o.total_rial))}</td>
                <td className="tabular-nums">{new Date(o.created_at).toLocaleDateString("fa-IR")}</td>
                <td><Btn variant="soft" size="sm" onClick={async () => { const d = await ordersApi.get(o.id); setDetail(d); }}>نمایش</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail !== null && (
        <Card className="p-4">
          <p className="text-[13px] font-bold">جزئیات سفارش / فاکتور / پرداخت / رهگیری</p>
          <pre className="mt-2 max-h-[400px] overflow-auto rounded bg-[var(--kv-surface-2)] p-3 text-xs">{String(JSON.stringify(detail as object, null, 2))}</pre>
          <div className="mt-3 flex gap-2">
            <a href={invoicesApi.pdfUrl((detail as { id: string }).id)} target="_blank" rel="noopener" className="rounded-[11px] bg-[var(--kv-accent)] px-4 py-2 text-xs font-bold text-white">دانلود PDF فاکتور</a>
            <Btn variant="ghost" size="sm" onClick={() => setDetail(null)}>بستن</Btn>
          </div>
        </Card>
      )}
    </div>
  );
}
