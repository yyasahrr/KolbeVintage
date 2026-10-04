import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Btn, Card, Empty, ErrorState, LoadingState } from "./primitives";
import { inventoryApi } from "../data/api";
import {
  readProductInventory, WMS_LABEL as L,
  type ProductInventory, type StockBalance, type Warehouse,
} from "../data/contracts";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

/**
 * Read-only inventory summary for one product.
 *
 * There is deliberately NO stock write path here: quantity changes only happen through the WMS
 * movements (`receipt → receive`, `adjustment`, `transfer`) — never a `PATCH /products`.
 */
export function ProductInventoryDrawer({
  product, warehouses, onClose,
}: {
  product: { id: string; name: string } | null;
  warehouses: Warehouse[];
  onClose: () => void;
  onFlash: (message: string) => void;
}) {
  const [data, setData] = useState<ProductInventory | null>(null);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [movements, setMovements] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const load = useCallback(async () => {
    if (!product) return;
    setLoading(true); setError(null);
    try {
      const [rawInventory, history] = await Promise.all([inventoryApi.productInventory(product.id), inventoryApi.productMovements(product.id)]);
      const inventory = readProductInventory(rawInventory);
      setData(inventory);
      setBalances(inventory.items);
      setMovements(history.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی محصول");
    } finally { setLoading(false); }
  }, [product, warehouses]);
  useEffect(() => { void load(); }, [load]);

  if (!product) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[14px] font-extrabold">{product.name}</p>
        </div>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>

      <p className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-4 py-2.5 text-[12px] leading-6 text-[var(--kv-muted)]">
        موجودی این محصول فقط از انبار (WMS) خوانده می‌شود؛ تغییر مقدار تنها با رسید ورودی، اصلاح موجودی یا انتقال انجام می‌شود.
      </p>

      {loading && <LoadingState label="در حال خواندن تراز انبار…" />}
      {error && <ErrorState message={error} onRetry={load} />}
      {data && !loading && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            {([
              [L.onHand, data.totals.available + data.totals.reserved + data.totals.damaged, ""],
              [L.reserved, data.totals.reserved, "text-[var(--kv-accent)]"],
              [L.damaged, data.totals.damaged, "text-[var(--kv-danger)]"],
              [L.available, data.totals.available, "font-extrabold text-[#3E6B4A]"],
            ] as const).map(([label, value, tone]) => (
              <Card key={label} className="p-3">
                <p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p>
                <p className={cn("mt-1 text-lg font-extrabold tabular-nums", tone)}>{fa(value)}</p>
              </Card>
            ))}
          </div>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 text-[13px] font-bold">موجودی به تفکیک واریانت و انبار</div>
            {balances.length === 0 ? (
              <Empty title="موجودی‌ای ثبت نشده است" desc="برای این محصول هنوز رسید ورودی ثبت نشده؛ راه‌اندازی و دریافت کالا را از بخش انبار انجام دهید." />
            ) : (
              <div className="overflow-x-auto">
                <table className="kv-table min-w-[760px] text-xs">
                  <thead>
                    <tr>
                      <th>{L.sku}</th><th>{L.color}</th><th>{L.size}</th><th>{L.warehouse}</th>
                      <th>{L.onHand}</th><th>{L.reserved}</th><th>{L.damaged}</th><th>{L.incoming}</th><th>{L.available}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {balances.map((row) => (
                      <tr key={`${row.variantId}-${row.warehouseId}`}>
                        <td className="font-mono tabular-nums" dir="ltr">{row.sku}</td>
                        <td>{row.color ?? "—"}</td><td>{row.size ?? "—"}</td><td>{row.warehouseName}</td>
                        <td className="tabular-nums">{fa(row.onHand)}</td>
                        <td className="tabular-nums text-[var(--kv-accent)]">{fa(row.reserved)}</td>
                        <td className="tabular-nums text-[var(--kv-danger)]">{fa(row.damaged)}</td>
                        <td className="tabular-nums text-[var(--kv-muted)]">{fa(row.incoming)}</td>
                        <td className="font-extrabold tabular-nums text-[#3E6B4A]">{fa(row.available)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-4"><h3 className="mb-3 text-sm font-bold">تاریخچه گردش موجودی (۵۰ رویداد اخیر)</h3>
            {!movements.length ? <Empty title="گردشی ثبت نشده" desc="ثبت رسید، انتقال و بازکردن سری در انبار، در اینجا قابل پیگیری است." /> : <div className="overflow-x-auto"><table className="kv-table min-w-[650px] w-full text-xs"><thead><tr><th>تاریخ</th><th>کد کالا</th><th>انبار</th><th>بخش</th><th>تغییر موجودی</th><th>علت</th></tr></thead><tbody>{movements.map((m) => <tr key={String(m.id)}><td>{new Date(String(m.created_at)).toLocaleString("fa-IR")}</td><td>{String(m.sku)}</td><td>{String(m.warehouse_name)}</td><td>{m.inventory_domain === "wholesale" ? "عمده" : "خرده"}</td><td>{fa(String(m.on_hand_delta))}</td><td>{String(m.reason ?? "—")}</td></tr>)}</tbody></table></div>}
          </Card>
        </>
      )}
      <div className="flex justify-end"><Btn variant="ghost" size="sm" onClick={onClose}>بستن</Btn></div>
    </div>
  );
}
