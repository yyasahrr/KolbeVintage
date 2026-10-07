import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty } from "../components/primitives";
import { supplierApi } from "../data/api";
import { fmtMoney, fmtNum } from "../data/catalog";

type Stats = {
  sales: { todayRial: string; weekRial: string; monthRial: string; yearRial: string; ordersCount: number; avgOrderRial: string; returnedOrders: number; revenueRial: string };
  topProducts: { product_name: string; sku: string; qty: number; totalRial: string }[];
  lowProducts: { product_name: string; sku: string; qty: number; totalRial: string }[];
  wallet: { availableRial: string; pendingRial: string; earnedRial: string; withdrawnRial: string; settledRial: string; pendingSettlementRial: string } | null;
};

export function SupplierStatsPanel() {
  const [period, setPeriod] = useState("30d");
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await supplierApi.stats(period) as unknown as Stats;
      setData(r);
    } catch (e) { setError(e instanceof Error ? e.message : "خطای بارگذاری"); }
    setLoading(false);
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);
  if (loading) return <LoadingState label="در حال محاسبه گزارش…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Empty title="داده‌ای نیست" desc="سفارشی ثبت نشده است." />;
  const s = data.sales;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="kv-editorial-title text-[22px] flex-1">داشبورد تأمین‌کننده — گزارش واقعی</h2>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 text-sm">
          <option value="7d">۷ روز</option><option value="30d">۳۰ روز</option><option value="3m">۳ ماه</option><option value="6m">۶ ماه</option><option value="1y">۱ سال</option>
        </select>
        <Btn variant="soft" size="sm" onClick={load}>بروزرسانی</Btn>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">فروش امروز</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.todayRial))}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">فروش هفته</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.weekRial))}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">فروش ماه</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.monthRial))}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">فروش سال</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.yearRial))}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">تعداد سفارش</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtNum(s.ordersCount)}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">میانگین سفارش</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.avgOrderRial))}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">مرجوعی</p><p className="mt-1 text-[18px] font-extrabold tabular-nums text-[var(--kv-danger)]">{fmtNum(s.returnedOrders)}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">درآمد کل</p><p className="mt-1 text-[18px] font-extrabold tabular-nums">{fmtMoney(Number(s.revenueRial))}</p></Card>
      </div>

      {data.wallet && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">کیف پول در دسترس</p><p className="mt-1 font-extrabold tabular-nums">{fmtMoney(Number(data.wallet.availableRial))}</p></Card>
          <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">در انتظار تسویه</p><p className="mt-1 font-extrabold tabular-nums">{fmtMoney(Number(data.wallet.pendingSettlementRial))}</p></Card>
          <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">تسویه‌شده</p><p className="mt-1 font-extrabold tabular-nums">{fmtMoney(Number(data.wallet.settledRial))}</p></Card>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4 overflow-hidden">
          <p className="text-[13px] font-bold">پرفروش‌ترین محصولات</p>
          <div className="mt-3 space-y-2">
            {data.topProducts.length === 0 ? <p className="text-xs text-[var(--kv-muted)]">داده‌ای نیست</p> : data.topProducts.map((p) => (
              <div key={p.sku} className="flex justify-between rounded-lg bg-[var(--kv-surface-2)]/60 px-3 py-2 text-xs">
                <span className="font-bold">{p.product_name} <span className="font-mono text-[var(--kv-muted)]">{p.sku}</span></span>
                <span className="tabular-nums">{fmtMoney(Number(p.totalRial))} · {fmtNum(p.qty)} عدد</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-4 overflow-hidden">
          <p className="text-[13px] font-bold">کم‌فروش‌ترین</p>
          <div className="mt-3 space-y-2">
            {data.lowProducts.map((p) => (
              <div key={p.sku} className="flex justify-between rounded-lg bg-[var(--kv-surface-2)]/60 px-3 py-2 text-xs">
                <span>{p.product_name} <span className="font-mono text-[var(--kv-muted)]">{p.sku}</span></span>
                <span className="tabular-nums">{fmtMoney(Number(p.totalRial))}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
