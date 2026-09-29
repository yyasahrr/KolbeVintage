import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, PackageCheck, RefreshCw, Scale, Truck } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Select } from "./primitives";
import { inventoryApi } from "../data/api";
import {
  readProductInventory, WMS_LABEL as L,
  type ProductInventory, type StockBalance, type Warehouse,
} from "../data/contracts";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

/**
 * Read/operational inventory view for one product.
 *
 * There is deliberately NO stock write path here: quantity changes only happen through the WMS
 * movements (`receipt → receive`, `adjustment`, `transfer`) — never a `PATCH /products`.
 */
export function ProductInventoryDrawer({
  product, warehouses, onClose, onFlash,
}: {
  product: { id: string; name: string } | null;
  warehouses: Warehouse[];
  onClose: () => void;
  onFlash: (message: string) => void;
}) {
  const [data, setData] = useState<ProductInventory | null>(null);
  const [balances, setBalances] = useState<StockBalance[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [receipt, setReceipt] = useState({ variantId: "", quantity: "1" });
  const [adjust, setAdjust] = useState({ variantId: "", delta: "1", reason: "شمارش دوره‌ای", reference: "" });
  const [transfer, setTransfer] = useState({ to: "", variantId: "", quantity: "1" });

  const load = useCallback(async () => {
    if (!product) return;
    setLoading(true); setError(null);
    try {
      const inventory = readProductInventory(await inventoryApi.productInventory(product.id));
      setData(inventory);
      setBalances(inventory.items);
      setWarehouseId((current) => current || warehouses[0]?.id || "");
      setReceipt((current) => ({ ...current, variantId: current.variantId || inventory.variants[0]?.variantId || "" }));
      setAdjust((current) => ({ ...current, variantId: current.variantId || inventory.variants[0]?.variantId || "" }));
      setTransfer((current) => ({ ...current, variantId: current.variantId || inventory.variants[0]?.variantId || "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی محصول");
    } finally { setLoading(false); }
  }, [product, warehouses]);
  useEffect(() => { void load(); }, [load]);

  if (!product) return null;

  const lines = data?.variants ?? [];
  const runReceipt = async () => {
    if (!warehouseId || !receipt.variantId) { setError("واریانت و انبار را انتخاب کنید."); return; }
    try {
      setBusy(true);
      const created = await inventoryApi.receipt({
        warehouseId, variantId: receipt.variantId, quantity: Number(receipt.quantity) || 1, reference: `RCV-${Date.now()}`,
      }, `rcpt-${receipt.variantId}-${Date.now()}`) as { id?: string };
      if (created?.id) await inventoryApi.receiveReceipt(created.id);
      onFlash("رسید ورودی ثبت و تأیید شد");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ثبت رسید"); }
    finally { setBusy(false); }
  };
  const runAdjust = async () => {
    if (!warehouseId || !adjust.variantId) { setError("واریانت و انبار را انتخاب کنید."); return; }
    try {
      setBusy(true);
      await inventoryApi.adjust({
        warehouseId, variantId: adjust.variantId, delta: Number(adjust.delta) || 0,
        reason: adjust.reason.trim() || "اصلاح موجودی", reference: adjust.reference.trim() || `ADJ-${Date.now()}`,
      }, `adj-${Date.now()}`);
      onFlash("اصلاح موجودی ثبت شد");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در اصلاح موجودی"); }
    finally { setBusy(false); }
  };
  const runTransfer = async () => {
    if (!warehouseId || !transfer.to || !transfer.variantId) { setError("مبدأ، مقصد و واریانت را انتخاب کنید."); return; }
    if (warehouseId === transfer.to) { setError("مبدأ و مقصد باید متفاوت باشند."); return; }
    try {
      setBusy(true);
      const created = await inventoryApi.transfer({
        fromWarehouseId: warehouseId, toWarehouseId: transfer.to,
        lines: [{ variantId: transfer.variantId, quantity: Number(transfer.quantity) || 1 }],
      }) as { id?: string };
      if (created?.id) await inventoryApi.completeTransfer(created.id);
      onFlash("انتقال بین انبارها انجام شد");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در انتقال"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[14px] font-extrabold">{product.name}</p>
          <p className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{product.id}</p>
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
              <Empty title="موجودی‌ای ثبت نشده است" desc="برای این محصول هنوز رسید ورودی ثبت نشده؛ از فرم پایین استفاده کنید." />
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

          <div className="grid gap-3 lg:grid-cols-3">
            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-[13px] font-bold"><PackageCheck size={14} />{L.receipt}</p>
              <div className="mt-2 space-y-2">
                <Select
                  options={["انتخاب کد کالا…", ...lines.map((line) => `${line.sku}${line.color ? ` / ${line.color}` : ""}${line.size ? ` / ${line.size}` : ""}`)]}
                  value={lines.find((line) => line.variantId === receipt.variantId) ? `${lines.find((line) => line.variantId === receipt.variantId)!.sku}` : "انتخاب کد کالا…"}
                  onChange={(label) => setReceipt({ ...receipt, variantId: lines.find((line) => label.startsWith(line.sku))?.variantId ?? "" })}
                />
                <Field label={L.qty}><Input value={receipt.quantity} onChange={(v) => setReceipt({ ...receipt, quantity: v.replace(/\D/g, "") || "1" })} /></Field>
                <Btn variant="accent" size="sm" className="w-full" disabled={busy} onClick={() => void runReceipt()}>ثبت و تأیید رسید ورودی</Btn>
              </div>
            </Card>

            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-[13px] font-bold"><Scale size={14} />{L.adjustment}</p>
              <div className="mt-2 space-y-2">
                <Select
                  options={["انتخاب کد کالا…", ...lines.map((line) => line.sku)]}
                  value={lines.find((line) => line.variantId === adjust.variantId)?.sku ?? "انتخاب کد کالا…"}
                  onChange={(label) => setAdjust({ ...adjust, variantId: lines.find((line) => line.sku === label)?.variantId ?? "" })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="مقدار تغییر"><Input value={adjust.delta} onChange={(v) => setAdjust({ ...adjust, delta: v })} /></Field>
                  <Field label={L.reference}><Input value={adjust.reference} onChange={(v) => setAdjust({ ...adjust, reference: v })} /></Field>
                </div>
                <Field label={L.reason}><Input value={adjust.reason} onChange={(v) => setAdjust({ ...adjust, reason: v })} /></Field>
                <Btn variant="soft" size="sm" className="w-full" disabled={busy} onClick={() => void runAdjust()}>ثبت اصلاح موجودی</Btn>
              </div>
            </Card>

            <Card className="p-4">
              <p className="flex items-center gap-1.5 text-[13px] font-bold"><Truck size={14} />{L.transfer}</p>
              <div className="mt-2 space-y-2">
                <Field label={L.from}>
                  <Select options={warehouses.map((w) => w.name)} value={warehouses.find((w) => w.id === warehouseId)?.name ?? ""}
                    onChange={(label) => setWarehouseId(warehouses.find((w) => w.name === label)?.id ?? "")} />
                </Field>
                <Field label={L.to}>
                  <Select options={warehouses.filter((w) => w.id !== warehouseId).map((w) => w.name)}
                    value={warehouses.find((w) => w.id === transfer.to)?.name ?? ""}
                    onChange={(label) => setTransfer({ ...transfer, to: warehouses.find((w) => w.name === label)?.id ?? "" })} />
                </Field>
                <Select
                  options={["انتخاب کد کالا…", ...lines.map((line) => line.sku)]}
                  value={lines.find((line) => line.variantId === transfer.variantId)?.sku ?? "انتخاب کد کالا…"}
                  onChange={(label) => setTransfer({ ...transfer, variantId: lines.find((line) => line.sku === label)?.variantId ?? "" })}
                />
                <Field label={L.qty}><Input value={transfer.quantity} onChange={(v) => setTransfer({ ...transfer, quantity: v.replace(/\D/g, "") || "1" })} /></Field>
                <Btn variant="soft" size="sm" className="w-full" disabled={busy || warehouses.length < 2} onClick={() => void runTransfer()}>ثبت انتقال</Btn>
                {warehouses.length < 2 && <p className="text-[11.5px] text-[var(--kv-muted)]"><AlertTriangle size={11} className="inline" /> برای انتقال حداقل دو انبار لازم است.</p>}
              </div>
            </Card>
          </div>
        </>
      )}
      <div className="flex justify-end"><Btn variant="ghost" size="sm" onClick={onClose}>بستن</Btn></div>
    </div>
  );
}
