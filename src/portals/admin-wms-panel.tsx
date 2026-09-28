import { useEffect, useState } from "react";
import { Btn, Card, Field, Input, LoadingState, ErrorState, Empty, SearchBox } from "../components/primitives";
import { inventoryApi } from "../data/api";

export function AdminWmsPanel() {
  const [warehouses, setWarehouses] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWh, setSelectedWh] = useState<string | null>(null);
  const [balances, setBalances] = useState<unknown[] | null>(null);
  const [movements, setMovements] = useState<Record<string, unknown[]>>({});
  const [search, setSearch] = useState("");
  const [threshold, setThreshold] = useState(10);
  const [newWh, setNewWh] = useState({ code: "", name: "" });
  const [newLoc, setNewLoc] = useState({ code: "", name: "" });
  const [transfer, setTransfer] = useState({ from: "", to: "", variant: "", qty: "1" });
  const [receipt, setReceipt] = useState({ warehouseId: "", variantId: "", qty: "10" });
  const [adjust, setAdjust] = useState({ warehouseId: "", variantId: "", delta: "10", reason: "", reference: "" });

  const reload = async () => {
    setLoading(true); setError(null);
    try {
      const wh = await inventoryApi.warehouses();
      setWarehouses(wh.items as never);
      if (wh.items[0] && !selectedWh) setSelectedWh((wh.items[0] as { id: string }).id);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
    setLoading(false);
  };
  useEffect(() => { void reload(); }, []);
  const loadBalances = async () => {
    if (!selectedWh) return;
    try {
      const params: Record<string,string> = { warehouseId: String(selectedWh) }; if (search) params.search = search;
      const b = await inventoryApi.balances(params);
      setBalances(b.items as never);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void loadBalances(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWh, search]);

  if (loading) return <LoadingState label="در حال بارگذاری انبارها…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!warehouses || warehouses.length === 0) return <Empty title="انباری ثبت نشده" desc="اولین انبار را بسازید تا موجودی هر SKU را مدیریت کنید." action={<Btn variant="accent" onClick={() => setNewWh({ code: "KV-MAIN", name: "انبار مرکزی" })}>ساخت انبار نمونه</Btn>} />;

  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="kv-editorial-title text-[22px] flex-1">انبار و موجودی (WMS)</h2>
        <SearchBox value={search} onChange={setSearch} placeholder="جست‌وجو SKU / نام محصول…" />
      </div>

      {/* Warehouse selector & low stock */}
      <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
        <Card className="p-4">
          <p className="text-[13px] font-bold">انبارها</p>
          <select value={selectedWh ?? ""} onChange={(e) => setSelectedWh(e.target.value)} className="mt-2 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2.5 text-sm">
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </select>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Field label="کد انبار جدید"><Input value={newWh.code} onChange={(v) => setNewWh({ ...newWh, code: v })} placeholder="مثال: KV-TEH-01" /></Field>
            <Field label="نام انبار"><Input value={newWh.name} onChange={(v) => setNewWh({ ...newWh, name: v })} placeholder="انبار تهران" /></Field>
          </div>
          <Btn variant="accent" size="sm" className="mt-3" onClick={async () => {
            try { await inventoryApi.createWarehouse(newWh); void reload(); setNewWh({ code: "", name: "" }); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
          }}>ساخت انبار</Btn>

          <div className="mt-6 border-t border-[var(--kv-line)] pt-4">
            <p className="text-[13px] font-bold">مکان انبار (Location)</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="کد مکان"><Input value={newLoc.code} onChange={(v) => setNewLoc({ ...newLoc, code: v })} placeholder="A-01" /></Field>
              <Field label="نام مکان"><Input value={newLoc.name} onChange={(v) => setNewLoc({ ...newLoc, name: v })} placeholder="قفسه A1" /></Field>
            </div>
            <Btn variant="soft" size="sm" className="mt-3" onClick={async () => {
              if (!selectedWh) return;
              try { await inventoryApi.createLocation(selectedWh, newLoc); setNewLoc({ code: "", name: "" }); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
            }}>افزودن مکان</Btn>
          </div>
        </Card>

        <Card className="p-4">
          <p className="text-[13px] font-bold">موجودی کم (Low Stock)</p>
          <div className="mt-2 flex items-center gap-2">
            <Field label="آستانه"><Input value={String(threshold)} onChange={(v) => setThreshold(Number(v) || 0)} /></Field>
            <Btn variant="soft" size="sm" onClick={async () => {
              try { const r = await inventoryApi.lowStock(threshold); setBalances(r.items as never); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
            }}>نمایش</Btn>
          </div>
          <p className="mt-3 text-xs leading-6 text-[var(--kv-muted)]">موجودی قابل فروش = on_hand - reserved - damaged. موجودی incoming تا رسید قابل فروش نیست.</p>
        </Card>
      </div>

      {/* Balances table responsive */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between">
          <p className="text-[13px] font-bold">تراز موجودی هر SKU</p>
          <Btn variant="ghost" size="sm" onClick={loadBalances}>بروزرسانی</Btn>
        </div>
        {!balances ? <LoadingState /> : balances.length === 0 ? <Empty title="موجودی یافت نشد" desc="فیلتر را تغییر دهید یا رسید ثبت کنید." /> : (
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[900px] text-xs">
              <thead><tr><th>SKU</th><th>محصول</th><th>انبار</th><th>on_hand</th><th>reserved</th><th>damaged</th><th>incoming</th><th>available</th><th>عملیات</th></tr></thead>
              <tbody>
                {(balances as { sku: string; product_name: string; warehouse_name: string; on_hand: number; reserved: number; damaged: number; incoming: number; available: number; variant_id: string; warehouse_id: string }[]).map((b) => (
                  <tr key={`${b.variant_id}-${b.warehouse_id}`}>
                    <td className="font-mono tabular-nums">{b.sku}</td>
                    <td className="font-bold">{b.product_name}</td>
                    <td>{b.warehouse_name}</td>
                    <td className="tabular-nums">{b.on_hand.toLocaleString("fa-IR")}</td>
                    <td className="tabular-nums text-[var(--kv-accent)]">{b.reserved.toLocaleString("fa-IR")}</td>
                    <td className="tabular-nums text-[var(--kv-danger)]">{b.damaged.toLocaleString("fa-IR")}</td>
                    <td className="tabular-nums text-[var(--kv-muted)]">{b.incoming.toLocaleString("fa-IR")}</td>
                    <td className="font-extrabold tabular-nums text-[#3E6B4A]">{b.available.toLocaleString("fa-IR")}</td>
                    <td><Btn variant="soft" size="sm" onClick={async () => {
                      try {
                        const d = await inventoryApi.movements(b.variant_id);
                        setMovements((m) => ({ ...m, [b.variant_id]: d.items }));
                      } catch { /* ignore */ }
                    }}>تاریخچه</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {Object.entries(movements).map(([vid, items]) => (
          <div key={vid} className="border-t border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-3">
            <p className="text-xs font-bold">Movement History — {vid.slice(0, 8)}</p>
            <div className="mt-2 space-y-1 text-xs leading-6">
              {(items as { reason: string; on_hand_delta: number; reserved_delta: number; incoming_delta: number; damaged_delta: number; created_at: string }[]).slice(0, 10).map((m, i) => (
                <div key={i} className="flex justify-between rounded-lg bg-white/60 px-3 py-1.5 dark:bg-white/5">
                  <span>{m.reason} — OH:{m.on_hand_delta} R:{m.reserved_delta} IN:{m.incoming_delta} DM:{m.damaged_delta}</span>
                  <span className="text-[var(--kv-muted)]">{new Date(m.created_at).toLocaleString("fa-IR")}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>

      {/* Actions */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <p className="text-[13px] font-bold">ثبت رسید (Receiving)</p>
          <Field label="Warehouse ID"><Input value={receipt.warehouseId} onChange={(v) => setReceipt({ ...receipt, warehouseId: v })} placeholder={selectedWh ?? "uuid"} /></Field>
          <Field label="Variant ID"><Input value={receipt.variantId} onChange={(v) => setReceipt({ ...receipt, variantId: v })} placeholder="uuid واریانت" /></Field>
          <Field label="تعداد"><Input value={receipt.qty} onChange={(v) => setReceipt({ ...receipt, qty: v })} /></Field>
          <Btn variant="accent" size="sm" className="mt-3 w-full" onClick={async () => {
            try { await inventoryApi.receipt({ warehouseId: receipt.warehouseId || selectedWh!, variantId: receipt.variantId, quantity: Number(receipt.qty) }, `rcpt-${Date.now()}`); setReceipt({ ...receipt, variantId: "" }); void loadBalances(); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
          }}>ثبت incoming</Btn>
          <Btn variant="ghost" size="sm" className="mt-2 w-full" onClick={async () => {
            try { const rs = await inventoryApi.receipts(); const pending = (rs.items as { id: string; status: string }[]).find((r) => r.status === "pending"); if (pending) { await inventoryApi.receiveReceipt(pending.id); void loadBalances(); } } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
          }}>تأیید رسید نمونه</Btn>
        </Card>

        <Card className="p-4">
          <p className="text-[13px] font-bold">اصلاح موجودی (Adjustment)</p>
          <Field label="Warehouse"><Input value={adjust.warehouseId} onChange={(v) => setAdjust({ ...adjust, warehouseId: v })} placeholder={selectedWh ?? "uuid"} /></Field>
          <Field label="Variant"><Input value={adjust.variantId} onChange={(v) => setAdjust({ ...adjust, variantId: v })} placeholder="uuid" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Delta"><Input value={adjust.delta} onChange={(v) => setAdjust({ ...adjust, delta: v })} /></Field>
            <Field label="Reference"><Input value={adjust.reference} onChange={(v) => setAdjust({ ...adjust, reference: v })} placeholder="ADJ-001" /></Field>
          </div>
          <Field label="Reason"><Input value={adjust.reason} onChange={(v) => setAdjust({ ...adjust, reason: v })} placeholder="شمارش دوره‌ای" /></Field>
          <Btn variant="soft" size="sm" className="mt-3 w-full" onClick={async () => {
            try { await inventoryApi.adjust({ warehouseId: adjust.warehouseId || selectedWh!, variantId: adjust.variantId, delta: Number(adjust.delta), reason: adjust.reason || "Adjustment", reference: adjust.reference || `ADJ-${Date.now()}` }, `adj-${Date.now()}`); void loadBalances(); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
          }}>ثبت Adjustment</Btn>
        </Card>

        <Card className="p-4">
          <p className="text-[13px] font-bold">انتقال بین انبار (Transfer)</p>
          <Field label="From"><Input value={transfer.from} onChange={(v) => setTransfer({ ...transfer, from: v })} placeholder="from warehouse id" /></Field>
          <Field label="To"><Input value={transfer.to} onChange={(v) => setTransfer({ ...transfer, to: v })} placeholder="to warehouse id" /></Field>
          <Field label="Variant"><Input value={transfer.variant} onChange={(v) => setTransfer({ ...transfer, variant: v })} placeholder="variant id" /></Field>
          <Field label="Qty"><Input value={transfer.qty} onChange={(v) => setTransfer({ ...transfer, qty: v })} /></Field>
          <Btn variant="soft" size="sm" className="mt-3 w-full" onClick={async () => {
            try {
              const res = await inventoryApi.transfer({ fromWarehouseId: transfer.from || warehouses[0]?.id, toWarehouseId: transfer.to || warehouses[1]?.id || warehouses[0]?.id, lines: [{ variantId: transfer.variant, quantity: Number(transfer.qty) }] }) as { id: string };
              if (res?.id) await inventoryApi.completeTransfer(res.id);
              void loadBalances();
            } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
          }}>ایجاد و تکمیل Transfer</Btn>
        </Card>
      </div>
    </div>
  );
}
