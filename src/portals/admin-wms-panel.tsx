import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Boxes, History, MapPin, PackagePlus, RefreshCw, Scale, Truck } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, SearchBox, Select } from "../components/primitives";
import { inventoryApi, productsApi } from "../data/api";
import { normalizeStockBalances, normalizeWarehouses, WMS_LABEL as L, type StockBalance, type Warehouse } from "../data/contracts";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

type VariantOption = { id: string; sku: string; label: string };
type Movement = {
  reason: string; on_hand_delta: number; reserved_delta: number; incoming_delta: number; damaged_delta: number; created_at: string;
};

/**
 * Warehouse management (WMS). The API/DB field names never change; every visible string is Persian.
 * Balances come from `/inventory` (`available = on_hand - reserved - damaged`), and the first-run
 * empty state creates a real warehouse through `POST /warehouses` — nothing is faked locally.
 */
export function AdminWmsPanel() {
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWh, setSelectedWh] = useState<string | null>(null);
  const [balances, setBalances] = useState<StockBalance[] | null>(null);
  const [movements, setMovements] = useState<Record<string, Movement[]>>({});
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [search, setSearch] = useState("");
  const [threshold, setThreshold] = useState(10);
  const [lowStockMode, setLowStockMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newWh, setNewWh] = useState({ code: "KV-MAIN", name: "انبار مرکزی" });
  const [newLoc, setNewLoc] = useState({ code: "", name: "" });
  const [transfer, setTransfer] = useState({ from: "", to: "", variant: "", qty: "1" });
  const [adjustMeta, setAdjustMeta] = useState({ reason: "شمارش دوره‌ای", reference: "" });
  const [adjustLines, setAdjustLines] = useState<{ variantId: string; delta: string }[]>([{ variantId: "", delta: "10" }]);
  const [receiptLines, setReceiptLines] = useState<{ variantId: string; quantity: string }[]>([{ variantId: "", quantity: "1" }]);

  /** Loads warehouses; when the DB has none the caller shows the actionable first-run state. */
  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = normalizeWarehouses(await inventoryApi.warehouses());
      setWarehouses(list);
      setSelectedWh((current) => (current && list.some((w) => w.id === current) ? current : list[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری انبارها");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  /** Variant picker options — real variants from the published catalogue. */
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await productsApi.list({ limit: "100" });
        if (!active) return;
        setVariants(res.items.flatMap((product) => product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          label: `${variant.sku} — ${product.name}${variant.color ? ` / ${variant.color}` : ""}${variant.size ? ` / ${variant.size}` : ""}`,
        }))));
      } catch { /* picker stays empty; balances still render */ }
    })();
    return () => { active = false; };
  }, []);

  const loadBalances = useCallback(async () => {
    if (!selectedWh) { setBalances([]); return; }
    try {
      const params: Record<string, string | number> = { warehouseId: selectedWh };
      if (search.trim()) params.search = search.trim();
      setBalances(normalizeStockBalances(await inventoryApi.balances(params)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی");
    }
  }, [selectedWh, search]);
  useEffect(() => { void loadBalances(); }, [loadBalances]);

  /** First-run: create the real warehouse, then select it and render the normal screen. */
  const createFirstWarehouse = async (code: string, name: string) => {
    try {
      setBusy(true); setError(null);
      const created = await inventoryApi.createWarehouse({ code: code.trim().toUpperCase(), name: name.trim() });
      await reload();
      setSelectedWh(created.id);
      setNotice(`انبار «${name.trim()}» ساخته شد.`);
      setNewWh({ code: "", name: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در ساخت انبار");
    } finally { setBusy(false); }
  };

  const createLocation = async () => {
    if (!selectedWh || !newLoc.code.trim() || !newLoc.name.trim()) return;
    try {
      setBusy(true);
      await inventoryApi.createLocation(selectedWh, { code: newLoc.code.trim().toUpperCase(), name: newLoc.name.trim() });
      setNewLoc({ code: "", name: "" });
      setNotice("مکان انبار ثبت شد.");
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ثبت مکان"); }
    finally { setBusy(false); }
  };

  /** Bulk adjustment: one server transaction for every line (atomic, idempotent). */
  const submitAdjustment = async () => {
    const lines = adjustLines.filter((line) => line.variantId && Number(line.delta) !== 0);
    if (!selectedWh || !lines.length) { setError("برای اصلاح موجودی، واریانت و مقدار تغییر را وارد کنید."); return; }
    try {
      setBusy(true);
      const result = await inventoryApi.bulkAdjust({
        lines: lines.map((line) => ({ variantId: line.variantId, warehouseId: selectedWh, delta: Number(line.delta) })),
        reason: adjustMeta.reason.trim() || "اصلاح موجودی", reference: adjustMeta.reference.trim() || `ADJ-${Date.now()}`,
      }, `bulk-adj-${Date.now()}`);
      setNotice(`${(result as { lines?: number }).lines ?? lines.length} قلم اصلاح موجودی در یک تراکنش ثبت شد.`);
      setAdjustLines([{ variantId: "", delta: "10" }]);
      await loadBalances();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در اصلاح موجودی"); }
    finally { setBusy(false); }
  };

  /** Bulk receipt: every line lands as confirmed, sellable stock in one transaction. */
  const submitReceipt = async () => {
    const lines = receiptLines.filter((line) => line.variantId && Number(line.quantity) > 0);
    if (!selectedWh || !lines.length) { setError("برای ثبت رسید، واریانت و تعداد را انتخاب کنید."); return; }
    try {
      setBusy(true);
      const result = await inventoryApi.bulkReceipt({
        lines: lines.map((line) => ({ variantId: line.variantId, warehouseId: selectedWh, quantity: Number(line.quantity) })),
        reference: `RCV-${Date.now()}`,
      }, `bulk-rcpt-${Date.now()}`);
      setNotice(`${(result as { lines?: number }).lines ?? lines.length} قلم رسید ورودی ثبت و تأیید شد.`);
      setReceiptLines([{ variantId: "", quantity: "1" }]);
      await loadBalances();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ثبت رسید"); }
    finally { setBusy(false); }
  };

  const submitTransfer = async () => {
    if (!transfer.from || !transfer.to || !transfer.variant) { setError("برای انتقال، مبدأ، مقصد و واریانت را انتخاب کنید."); return; }
    if (transfer.from === transfer.to) { setError("مبدأ و مقصد انتقال باید متفاوت باشند."); return; }
    try {
      setBusy(true);
      const created = await inventoryApi.transfer({
        fromWarehouseId: transfer.from, toWarehouseId: transfer.to,
        lines: [{ variantId: transfer.variant, quantity: Number(transfer.qty) || 1 }],
      }) as { id?: string };
      if (created?.id) await inventoryApi.completeTransfer(created.id);
      setNotice("انتقال بین انبارها انجام شد.");
      await loadBalances();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در انتقال موجودی"); }
    finally { setBusy(false); }
  };

  const showLowStock = async () => {
    try {
      setBusy(true);
      setLowStockMode(true);
      setBalances(normalizeStockBalances(await inventoryApi.lowStock(threshold)));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در گزارش موجودی کم"); }
    finally { setBusy(false); }
  };

  const openHistory = async (variantId: string) => {
    try {
      const data = await inventoryApi.movements(variantId) as { items: Movement[] };
      setMovements((current) => ({ ...current, [variantId]: data.items ?? [] }));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در تاریخچه گردش"); }
  };

  if (loading) return <LoadingState label="در حال بارگذاری انبارها…" />;

  // First-run guard: the empty state is actionable and server-backed (no local/demo rows).
  if (!warehouses || warehouses.length === 0) {
    return (
      <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
        {error && <ErrorState message={error} onRetry={reload} />}
        <Card className="p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]"><Boxes size={20} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-extrabold">هنوز انباری ثبت نشده است</p>
              <p className="mt-1 text-[13px] leading-7 text-[var(--kv-muted)]">
                موجودی هر SKU فقط از طریق انبار مدیریت می‌شود؛ نخستین انبار را بسازید تا رسید ورودی، اصلاح موجودی و انتقال فعال شوند.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="کد انبار" hint="حروف انگلیسی بزرگ، عدد، - و _"><Input value={newWh.code} onChange={(v) => setNewWh({ ...newWh, code: v.toUpperCase() })} placeholder="KV-MAIN" /></Field>
                <Field label="نام انبار"><Input value={newWh.name} onChange={(v) => setNewWh({ ...newWh, name: v })} placeholder="انبار مرکزی" /></Field>
              </div>
              <Btn variant="accent" className="mt-3" disabled={busy || newWh.code.trim().length < 3 || newWh.name.trim().length < 2}
                onClick={() => void createFirstWarehouse(newWh.code, newWh.name)}>
                ایجاد اولین انبار
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const selectedWarehouse = warehouses.find((w) => w.id === selectedWh) ?? warehouses[0]!;
  const rows = balances ?? [];
  const totals = rows.reduce((sum, row) => ({
    onHand: sum.onHand + row.onHand, reserved: sum.reserved + row.reserved, damaged: sum.damaged + row.damaged,
    incoming: sum.incoming + row.incoming, available: sum.available + row.available,
  }), { onHand: 0, reserved: 0, damaged: 0, incoming: 0, available: 0 });

  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="kv-editorial-title flex-1 text-[22px]">انبار و موجودی (WMS)</h2>
        <SearchBox value={search} onChange={setSearch} placeholder="جست‌وجو بر اساس کد کالا یا نام محصول…" />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void loadBalances()}>به‌روزرسانی</Btn>
      </div>

      {error && <ErrorState message={error} onRetry={() => void loadBalances()} />}
      {notice && <p role="status" className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-[12.5px] font-semibold">{notice}</p>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {([
          [L.onHand, totals.onHand, ""],
          [L.reserved, totals.reserved, "text-[var(--kv-accent)]"],
          [L.damaged, totals.damaged, "text-[var(--kv-danger)]"],
          [L.incoming, totals.incoming, "text-[var(--kv-muted)]"],
          [L.available, totals.available, "text-[#3E6B4A] font-extrabold"],
        ] as const).map(([label, value, tone]) => (
          <Card key={label} className="p-4">
            <p className="text-[12px] text-[var(--kv-muted)]">{label}</p>
            <p className={cn("mt-1 text-xl font-extrabold tabular-nums", tone)}>{fa(value)}</p>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
        <Card className="p-4">
          <p className="text-[13px] font-bold">انبارها</p>
          <select
            aria-label="انتخاب انبار"
            value={selectedWh ?? ""}
            onChange={(e) => { setSelectedWh(e.target.value); setLowStockMode(false); }}
            className="mt-2 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2.5 text-sm"
          >
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
          </select>
          <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">
            انبار جاری: <b>{selectedWarehouse.name}</b> ({selectedWarehouse.code})
          </p>

          <div className="mt-5 border-t border-[var(--kv-line)] pt-4">
            <p className="flex items-center gap-1.5 text-[13px] font-bold"><MapPin size={14} />افزودن انبار</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="کد انبار"><Input value={newWh.code} onChange={(v) => setNewWh({ ...newWh, code: v.toUpperCase() })} placeholder="KV-TEH-02" /></Field>
              <Field label="نام انبار"><Input value={newWh.name} onChange={(v) => setNewWh({ ...newWh, name: v })} placeholder="انبار تهران" /></Field>
            </div>
            <Btn variant="accent" size="sm" className="mt-3" disabled={busy || newWh.code.trim().length < 3 || newWh.name.trim().length < 2}
              onClick={() => void createFirstWarehouse(newWh.code, newWh.name)}>ساخت انبار</Btn>
          </div>

          <div className="mt-5 border-t border-[var(--kv-line)] pt-4">
            <p className="text-[13px] font-bold">مکان‌های انبار</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Field label="کد مکان"><Input value={newLoc.code} onChange={(v) => setNewLoc({ ...newLoc, code: v.toUpperCase() })} placeholder="A-01" /></Field>
              <Field label="نام مکان"><Input value={newLoc.name} onChange={(v) => setNewLoc({ ...newLoc, name: v })} placeholder="قفسه A1" /></Field>
            </div>
            <Btn variant="soft" size="sm" className="mt-3" disabled={busy || !newLoc.code.trim() || !newLoc.name.trim()} onClick={() => void createLocation()}>افزودن مکان</Btn>
          </div>
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><AlertTriangle size={14} />{L.lowStock}</p>
          <div className="mt-2 flex items-end gap-2">
            <Field label={L.threshold}><Input value={String(threshold)} onChange={(v) => setThreshold(Number(v.replace(/\D/g, "")) || 0)} /></Field>
            <Btn variant="soft" size="sm" disabled={busy} onClick={() => void showLowStock()}>نمایش</Btn>
            {lowStockMode && <Btn variant="ghost" size="sm" onClick={() => { setLowStockMode(false); void loadBalances(); }}>همه اقلام</Btn>}
          </div>
          <p className="mt-3 text-[12px] leading-6 text-[var(--kv-muted)]">
            {L.available} = {L.onHand} − {L.reserved} − {L.damaged}. موجودی «{L.incoming}» تا زم�ید {L.receipt} قابل فروش نیست.
          </p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-[13px] font-bold">تراز موجودی هر کد کالا {lowStockMode ? "(گزارش موجودی کم)" : ""}</p>
          <span className="text-[11.5px] text-[var(--kv-muted)]">{fa(rows.length)} ردیف</span>
        </div>
        {!balances ? <LoadingState /> : rows.length === 0 ? (
          <Empty title="موجودی‌ای یافت نشد" desc="برای این انبار هنوز رسید ورودی ثبت نشده است؛ از کارت «رسید ورودی» استفاده کنید." />
        ) : (
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[980px] text-xs">
              <thead>
                <tr>
                  <th>{L.sku}</th><th>{L.product}</th><th>{L.warehouse}</th><th>{L.color}</th><th>{L.size}</th>
                  <th>{L.onHand}</th><th>{L.reserved}</th><th>{L.damaged}</th><th>{L.incoming}</th><th>{L.available}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.variantId}-${row.warehouseId}`}>
                    <td className="font-mono tabular-nums" dir="ltr">{row.sku}</td>
                    <td className="font-bold">{row.productName}</td>
                    <td>{row.warehouseName}</td>
                    <td>{row.color ?? "—"}</td>
                    <td>{row.size ?? "—"}</td>
                    <td className="tabular-nums">{fa(row.onHand)}</td>
                    <td className="tabular-nums text-[var(--kv-accent)]">{fa(row.reserved)}</td>
                    <td className="tabular-nums text-[var(--kv-danger)]">{fa(row.damaged)}</td>
                    <td className="tabular-nums text-[var(--kv-muted)]">{fa(row.incoming)}</td>
                    <td className="font-extrabold tabular-nums text-[#3E6B4A]">{fa(row.available)}</td>
                    <td>
                      <Btn variant="soft" size="sm" icon={<History size={13} />} onClick={() => void openHistory(row.variantId)}>{L.movementHistory}</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {Object.entries(movements).map(([variantId, items]) => (
          <div key={variantId} className="border-t border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-3">
            <p className="text-xs font-bold">{L.movementHistory} — <span className="font-mono" dir="ltr">{variantId.slice(0, 8)}</span></p>
            <div className="mt-2 space-y-1 text-xs leading-6">
              {items.slice(0, 10).map((movement, index) => (
                <div key={index} className="flex flex-wrap justify-between gap-2 rounded-lg bg-white/60 px-3 py-1.5 dark:bg-white/5">
                  <span>
                    {movement.reason} — {L.onHand}: {fa(movement.on_hand_delta)} · {L.reserved}: {fa(movement.reserved_delta)} · {L.incoming}: {fa(movement.incoming_delta)} · {L.damaged}: {fa(movement.damaged_delta)}
                  </span>
                  <span className="text-[var(--kv-muted)]">{formatPersianDateTimeFull(movement.created_at)}</span>
                </div>
              ))}
              {items.length === 0 && <p className="text-[var(--kv-muted)]">گردشی برای این کد کالا ثبت نشده است.</p>}
            </div>
          </div>
        ))}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><PackagePlus size={14} />{L.receipt}</p>
          <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">انبار مقصد: {selectedWarehouse.name}</p>
          <div className="mt-3 space-y-2">
            {receiptLines.map((line, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_90px]">
                <Select
                  options={["انتخاب کد کالا…", ...variants.map((variant) => variant.label)]}
                  value={variants.find((variant) => variant.id === line.variantId)?.label ?? "انتخاب کد کالا…"}
                  onChange={(label) => {
                    const variant = variants.find((item) => item.label === label);
                    setReceiptLines((lines) => lines.map((entry, i) => (i === index ? { ...entry, variantId: variant?.id ?? "" } : entry)));
                  }}
                />
                <Field label={L.qty}><Input value={line.quantity} onChange={(v) => setReceiptLines((lines) => lines.map((entry, i) => (i === index ? { ...entry, quantity: v.replace(/\D/g, "") || "1" } : entry)))} /></Field>
              </div>
            ))}
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" icon={<PackagePlus size={13} />} onClick={() => setReceiptLines((lines) => [...lines, { variantId: "", quantity: "1" }])}>افزودن قلم</Btn>
              <Btn variant="accent" size="sm" disabled={busy} onClick={() => void submitReceipt()}>ثبت و تأیید رسید ورودی</Btn>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><Scale size={14} />{L.adjustment}</p>
          <div className="mt-3 space-y-2">
            {adjustLines.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_90px_32px] items-end gap-2">
                <Select
                  options={["انتخاب کد کالا…", ...variants.map((variant) => variant.label)]}
                  value={variants.find((variant) => variant.id === line.variantId)?.label ?? "انتخاب کد کالا…"}
                  onChange={(label) => setAdjustLines((lines) => lines.map((entry, i) => i === index ? { ...entry, variantId: variants.find((item) => item.label === label)?.id ?? "" } : entry))}
                />
                <Field label="تغییر (+/−)"><Input value={line.delta} onChange={(v) => setAdjustLines((lines) => lines.map((entry, i) => i === index ? { ...entry, delta: v } : entry))} /></Field>
                <button onClick={() => setAdjustLines((lines) => lines.length > 1 ? lines.filter((_, i) => i !== index) : [{ variantId: "", delta: "10" }])} className="mb-1 text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف قلم">✕</button>
              </div>
            ))}
            <Field label={L.reason}><Input value={adjustMeta.reason} onChange={(v) => setAdjustMeta({ ...adjustMeta, reason: v })} placeholder="شمارش دوره‌ای" /></Field>
            <Field label={L.reference}><Input value={adjustMeta.reference} onChange={(v) => setAdjustMeta({ ...adjustMeta, reference: v })} placeholder="اختیاری · ADJ-001" /></Field>
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setAdjustLines((lines) => [...lines, { variantId: "", delta: "10" }])}>افزودن قلم</Btn>
              <Btn variant="soft" size="sm" className="flex-1" disabled={busy} onClick={() => void submitAdjustment()}>ثبت اصلاح گروهی</Btn>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><Truck size={14} />{L.transfer}</p>
          <div className="mt-3 space-y-2">
            <Field label={L.from}>
              <select value={transfer.from || selectedWarehouse.id} onChange={(e) => setTransfer({ ...transfer, from: e.target.value })}
                className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 text-[13px]">
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
            <Field label={L.to}>
              <select value={transfer.to || (warehouses.find((w) => w.id !== selectedWarehouse.id)?.id ?? selectedWarehouse.id)}
                onChange={(e) => setTransfer({ ...transfer, to: e.target.value })}
                className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 text-[13px]">
                {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
            <Select
              options={["انتخاب کد کالا…", ...variants.map((variant) => variant.label)]}
              value={variants.find((variant) => variant.id === transfer.variant)?.label ?? "انتخاب کد کالا…"}
              onChange={(label) => setTransfer({ ...transfer, variant: variants.find((item) => item.label === label)?.id ?? "" })}
            />
            <Field label={L.qty}><Input value={transfer.qty} onChange={(v) => setTransfer({ ...transfer, qty: v.replace(/\D/g, "") || "1" })} /></Field>
            <Btn variant="soft" size="sm" className="w-full" disabled={busy || warehouses.length < 2} onClick={() => void submitTransfer()}>ایجاد و تکمیل انتقال</Btn>
            {warehouses.length < 2 && <p className="text-[11.5px] text-[var(--kv-muted)]">برای انتقال حداقل دو انبار لازم است.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
