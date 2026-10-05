import { useCallback, useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Btn, Card, Empty, ErrorState, LoadingState, WorkspaceModal } from "./primitives";
import { inventoryApi } from "../data/api";
import { cn } from "../utils/cn";

/** §23 (unified Product Studio): the canonical READ-ONLY inventory view of ONE product.
 *
 *  It is shared by the Studio's «موجودی اولیه» step (for products whose opening receipt is already
 *  registered) and by the «محصولات کلبه» hub. It never writes a balance: every physical change goes
 *  through a canonical WMS document, so the advanced operations stay a deep link to the WMS hub
 *  (`onOpenWms`) and this panel remains a read model — the Studio is not a stock authority. */

type BalanceRow = {
  variant_id: string; warehouse_id: string; inventory_domain: string; warehouse_name: string; sku: string;
  size_label: string | null; color_label: string | null; on_hand: number; reserved: number; damaged: number; available: number;
};
type MovementRow = {
  id: string; sku: string | null; warehouse_name: string | null; inventory_domain: string | null;
  on_hand_delta: number | null; reason: string | null; reference_type: string | null; created_at: string;
};

const fa = (value: number | string) => String(value ?? "—").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const domainFa = (domain: string | null) => domain === "wholesale" ? "عمده" : "خرده";

export function ProductInventoryPanel({ productId, productName, embedded = false, onOpenWms, onClose }: {
  productId: string; productName: string;
  embedded?: boolean;
  onOpenWms?: () => void;
  /** Required only by the non-embedded (modal) mount. */
  onClose?: () => void;
}) {
  const [rows, setRows] = useState<BalanceRow[] | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      inventoryApi.balances({ productId, limit: 100 }),
      inventoryApi.productMovements(productId),
    ])
      .then(([balances, moves]) => {
        setRows(balances.items as BalanceRow[]);
        setMovements((moves.items ?? []) as unknown as MovementRow[]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا در دریافت موجودی"));
  }, [productId]);
  useEffect(load, [load]);

  const body = (
    <div className="space-y-3">
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rows && <LoadingState label="در حال دریافت موجودی..." />}
      {!error && rows && !rows.length && (
        <Empty title="ردیف موجودی مستقلی برای این محصول ثبت نشده است"
          desc="اگر موجودی این محصول را قبلاً ثبت کرده‌اید، ردیف‌ها را در «انبار و موجودی (WMS)» ببینید؛ برای ثبت موجودی اولیهٔ باقی‌مانده هم سند انبار لازم است." />
      )}
      {!error && !!rows?.length && (
        <Card className="p-0">
          <div className="kv-scroll kv-scroll-x">
            <table className="kv-table min-w-[760px] w-full text-xs">
              <thead><tr>
                <th>کد کالا</th><th>رنگ / سایز</th><th>انبار</th><th>دامنه</th>
                <th>موجودی</th><th>رزرو</th><th>آسیب‌دیده</th><th>قابل تخصیص</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.variant_id}-${row.warehouse_id}-${row.inventory_domain}`}>
                    <td dir="ltr" className="font-mono">{row.sku}</td>
                    <td className="whitespace-nowrap">{row.color_label ?? "—"} / {row.size_label ?? "—"}</td>
                    <td className="whitespace-nowrap">{row.warehouse_name}</td>
                    <td className="whitespace-nowrap">{domainFa(row.inventory_domain)}</td>
                    <td className="font-bold tabular-nums">{fa(row.on_hand)}</td>
                    <td className="tabular-nums">{fa(row.reserved)}</td>
                    <td className="tabular-nums">{fa(row.damaged)}</td>
                    <td className="font-bold tabular-nums">{fa(row.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {!!movements.length && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-bold">آخرین حرکت‌های انبار</h3>
          <ul className="space-y-2">
            {movements.slice(0, 12).map((movement) => (
              <li key={movement.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[11.5px]">
                <span className="min-w-0">
                  <b dir="ltr" className="font-mono">{movement.sku ?? "—"}</b>
                  <span className="ms-2 text-[var(--kv-muted)]">{movement.warehouse_name ?? "—"} · {domainFa(movement.inventory_domain)}</span>
                </span>
                <span className="whitespace-nowrap">
                  <b className={cn("tabular-nums", Number(movement.on_hand_delta ?? 0) >= 0 ? "text-emerald-700" : "text-red-700")}>
                    {Number(movement.on_hand_delta ?? 0) >= 0 ? "+" : ""}{fa(movement.on_hand_delta ?? 0)}
                  </b>
                  <span className="ms-2 text-[var(--kv-muted)]">{movement.reason ?? "—"}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-3 py-2">
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            موجودی فیزیکی این محصول قبلاً ثبت شده است؛ این نما فقط خواندنی است و موجودی هرگز وضعیت انتشار محصول را تغییر نمی‌دهد.
          </p>
          {onOpenWms && <Btn size="sm" variant="soft" icon={<Boxes size={13} />} onClick={onOpenWms}>عملیات پیشرفتهٔ انبار (WMS)</Btn>}
        </div>
        {body}
      </div>
    );
  }

  return (
    <WorkspaceModal open onClose={onClose ?? (() => undefined)} title={`مدیریت موجودی — ${productName}`}
      subtitle="این فقط نمای موجودی واقعیِ همین محصول است؛ عملیات موجودی (رسید، اصلاح، انتقال، فروش) در «انبار و موجودی (WMS)» و با سند انجام می‌شود."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">هر تغییر فیزیکی فقط با سند انبار و ثبت حرکت انجام می‌شود؛ این صفحه موجودی را دستکاری نمی‌کند.</p>
          <div className="flex gap-2">
            {onOpenWms && <Btn variant="soft" onClick={onOpenWms} icon={<Boxes size={14} />}>رفتن به انبار و موجودی (WMS)</Btn>}
            {onClose && <Btn variant="ghost" onClick={onClose}>بستن</Btn>}
          </div>
        </div>
      }>
      {body}
    </WorkspaceModal>
  );
}
