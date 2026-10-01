import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronLeft, ClipboardCheck, RotateCcw, Store, Truck } from "lucide-react";
import { Btn, Card, Checkbox, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, Select, Textarea } from "../components/primitives";
import { inventoryApi, manualSalesApi, productsApi, supplierRequestsApi, type ManualSaleCreate } from "../data/api";
import { CHANNEL_LABEL } from "../components/manual-sales-panel";
import { AdminWmsPanel } from "./admin-wms-panel";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Fixed color semantics (V): green=received/active, yellow=incoming/pending, red=blocked/error, gray=suspended. */
const STOCK_BADGE: Record<string, { label: string; cls: string }> = {
  in_stock: { label: "موجود", cls: "bg-emerald-100 text-emerald-800" },
  low_stock: { label: "رو به اتمام", cls: "bg-amber-100 text-amber-800" },
  out_of_stock: { label: "ناموجود", cls: "bg-red-100 text-red-700" },
  incoming: { label: "در راه", cls: "bg-amber-100 text-amber-800" },
  fully_reserved: { label: "تماماً رزرو", cls: "bg-amber-100 text-amber-800" },
};
const TRANSFER_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: "پیش‌نویس", cls: "bg-gray-100 text-gray-600" },
  approved: { label: "تأییدشده", cls: "bg-amber-100 text-amber-800" },
  in_transit: { label: "در راه", cls: "bg-amber-100 text-amber-800" },
  completed: { label: "تکمیل‌شده", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};
const REQUEST_BADGE: Record<string, { label: string; cls: string }> = {
  submitted: { label: "در انتظار بررسی", cls: "bg-amber-100 text-amber-800" },
  approved: { label: "تأییدشده", cls: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  needs_revision: { label: "نیازمند اصلاح", cls: "bg-amber-100 text-amber-800" },
  dispatched: { label: "ارسال‌شده", cls: "bg-amber-100 text-amber-800" },
  received: { label: "دریافت‌شده", cls: "bg-emerald-100 text-emerald-800" },
  closed: { label: "بسته‌شده", cls: "bg-gray-100 text-gray-600" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};

function Badge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const meta = map[value] ?? { label: value, cls: "bg-gray-100 text-gray-600" };
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>;
}

type InvRow = {
  variant_id: string; warehouse_id: string; inventory_domain: "retail" | "wholesale";
  warehouse_name: string; sku: string; size_label: string | null; color_label: string | null;
  product_id: string; product_name: string; owner_type: string; supplier_id: string | null;
  retail_enabled: boolean; product_status: string;
  on_hand: number; reserved: number; incoming: number; damaged: number; available: number;
  stock_status: string;
};
type TransferRow = {
  id: string; transfer_number: string | null; reference: string; variant_id: string | null;
  source_domain: string | null; destination_domain: string | null; quantity: number | null; status: string;
  is_reverse: boolean; original_transfer_id: string | null; reversed_quantity: number; batch_reference: string | null;
  sku: string | null; product_name: string | null; reason: string; created_at: string;
  source_warehouse_name?: string | null; destination_warehouse_name?: string | null;
};
type ReceiptRow = {
  id: string; reference: string; variant_id: string | null; quantity: number | null; status: string;
  inventory_domain: string; received_quantity: number | null; missing_quantity: number; batch_reference: string | null;
  supplier_request_id: string | null; created_at: string;
};
type RequestRow = {
  id: string; request_number: string; supplier_name: string; status: string; item_count: number;
  total_quantity: number; rejection_reason: string | null; revision_note: string | null; created_at: string;
};

type F = (msg: string) => void;

/**
 * C: «انبار و نقل‌وانتقالات» — the single warehouse hub.
 * Tabs: retail inventory / transfers (incl. reverse) / wholesale (inventory, supplier
 * requests, inbound & QC) / warehouse settings (the original WMS panel, kept as-is).
 */
export function WarehouseHub({ flash }: { flash: F }) {
  const [tab, setTab] = useState<"retail" | "transfers" | "wholesale" | "settings">("retail");
  return (
    <div className="animate-[fadeUp_0.35s_ease] space-y-4">
      <Segmented
        options={[
          { v: "retail", label: "خرده‌فروشی" },
          { v: "transfers", label: "نقل‌وانتقالات" },
          { v: "wholesale", label: "انبار عمده" },
          { v: "settings", label: "تنظیمات انبار" },
        ]}
        value={tab} onChange={setTab}
      />
      {tab === "retail" && <DomainInventory domain="retail" flash={flash} />}
      {tab === "transfers" && <TransfersCenter flash={flash} />}
      {tab === "wholesale" && <WholesaleCenter flash={flash} />}
      {tab === "settings" && <AdminWmsPanel />}
    </div>
  );
}

/* ------------------------------ inventory tables (C1/C3, L/M, O) ------------------------------ */

function DomainInventory({ domain, flash }: { domain: "retail" | "wholesale"; flash: F }) {
  const [rows, setRows] = useState<InvRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [receiptFor, setReceiptFor] = useState<InvRow | null>(null);
  const [saleFor, setSaleFor] = useState<InvRow | null>(null);
  const [adjustFor, setAdjustFor] = useState<InvRow | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const params: Record<string, string | number> = { inventoryDomain: domain, limit: 100 };
      if (search.trim()) params.search = search.trim();
      if (lowOnly) params.lowStock = 5;
      const res = await inventoryApi.balances(params);
      setRows(res.items as unknown as InvRow[]);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی"); }
  }, [domain, search, lowOnly]);
  useEffect(() => { void reload(); }, [reload]);

  // L/M: product-centric expandable grouping (product → variants).
  const groups = useMemo(() => {
    const map = new Map<string, { product: InvRow; rows: InvRow[] }>();
    for (const row of rows ?? []) {
      const g = map.get(row.product_id);
      if (g) g.rows.push(row); else map.set(row.product_id, { product: row, rows: [row] });
    }
    return [...map.values()];
  }, [rows]);

  const toggleSale = async (row: InvRow, enable: boolean) => {
    setBusy(true);
    try {
      await productsApi.update(row.product_id, { retailEnabled: enable });
      flash(enable ? "فروش محصول فعال شد." : "فروش محصول متوقف شد (موجودی دست‌نخورده می‌ماند).");
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت فروش"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-[var(--kv-border)] p-3">
        <div className="min-w-[220px] flex-1">
          <SearchBox value={search} onChange={setSearch} placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…" />
        </div>
        <Checkbox checked={lowOnly} onChange={setLowOnly} label={<span className="text-[12px]">فقط موجودی کم</span>} />
      </div>
      {groups.length === 0 ? <Empty title="موجودی یافت نشد" desc="برای این دامنه هنوز موجودی ثبت نشده است." /> : (
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[900px] text-[12.5px]">
            <thead><tr>
              <th></th><th>محصول / تنوع</th><th>انبار</th>
              {domain === "wholesale" && <th>مالکیت</th>}
              <th>موجودی</th><th>در راه</th><th>رزرو</th><th>قابل فروش</th>
              <th>وضعیت موجودی</th>
              {domain === "retail" && <th>وضعیت فروش</th>}
              <th>عملیات</th>
            </tr></thead>
            <tbody>
              {groups.map(({ product, rows: vRows }) => {
                const open = expanded.has(product.product_id);
                const sum = vRows.reduce((acc, r) => ({
                  on_hand: acc.on_hand + r.on_hand, incoming: acc.incoming + r.incoming,
                  reserved: acc.reserved + r.reserved, available: acc.available + Number(r.available),
                }), { on_hand: 0, incoming: 0, reserved: 0, available: 0 });
                return (
                  <FragmentRows key={product.product_id}
                    head={
                      <tr className="cursor-pointer bg-[var(--kv-surface-2)]/50" onClick={() => {
                        const next = new Set(expanded);
                        if (next.has(product.product_id)) next.delete(product.product_id); else next.add(product.product_id);
                        setExpanded(next);
                      }}>
                        <td>{open ? <ChevronDown size={14} /> : <ChevronLeft size={14} />}</td>
                        <td><b>{product.product_name}</b> <span className="text-[11px] text-[var(--kv-muted)]">({fa(vRows.length)} تنوع)</span></td>
                        <td>{product.warehouse_name}</td>
                        {domain === "wholesale" && <td>{product.owner_type === "kolbe" ? "کلبه" : "تأمین‌کننده"}</td>}
                        <td className="tabular-nums font-bold">{fa(sum.on_hand)}</td>
                        <td className="tabular-nums">{sum.incoming > 0 ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-800">+{fa(sum.incoming)} در راه</span> : "—"}</td>
                        <td className="tabular-nums">{fa(sum.reserved)}</td>
                        <td className="tabular-nums font-bold">{fa(sum.available)}</td>
                        <td><Badge map={STOCK_BADGE} value={sum.available <= 0 ? (sum.incoming > 0 ? "incoming" : "out_of_stock") : sum.available <= 5 ? "low_stock" : "in_stock"} /></td>
                        {domain === "retail" && (
                          <td>{product.product_status === "archived"
                            ? <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10.5px] font-bold text-gray-600">آرشیو</span>
                            : product.retail_enabled
                              ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-bold text-emerald-800">فعال</span>
                              : <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10.5px] font-bold text-gray-600">فروش متوقف</span>}</td>
                        )}
                        <td onClick={(e) => e.stopPropagation()}>
                          {domain === "retail" && (
                            <button disabled={busy} className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline"
                              onClick={() => void toggleSale(product, !product.retail_enabled)}>
                              {product.retail_enabled ? "توقف فروش" : "فعال‌سازی فروش"}
                            </button>
                          )}
                        </td>
                      </tr>
                    }
                    body={open ? vRows.map((row) => (
                      <tr key={`${row.variant_id}-${row.warehouse_id}`}>
                        <td></td>
                        <td>
                          <span dir="ltr" className="text-[11.5px] text-[var(--kv-muted)]">{row.sku}</span>
                          <span className="mr-2 text-[12px]">{row.color_label ?? "—"} / {row.size_label ?? "—"}</span>
                        </td>
                        <td>{row.warehouse_name}</td>
                        {domain === "wholesale" && <td>{row.owner_type === "kolbe" ? "کلبه" : "تأمین‌کننده"}</td>}
                        <td className="tabular-nums">{fa(row.on_hand)}</td>
                        <td className="tabular-nums">{row.incoming > 0 ? <span className="text-amber-700">+{fa(row.incoming)}</span> : "—"}</td>
                        <td className="tabular-nums">{fa(row.reserved)}</td>
                        <td className="tabular-nums font-bold">{fa(Number(row.available))}</td>
                        <td><Badge map={STOCK_BADGE} value={row.stock_status} /></td>
                        {domain === "retail" && <td></td>}
                        <td className="whitespace-nowrap space-x-2 space-x-reverse">
                          <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline" onClick={() => setReceiptFor(row)}>رسید ورود</button>
                          {domain === "retail" && (
                            <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline" onClick={() => setSaleFor(row)}>ثبت فروش دستی</button>
                          )}
                          <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline" onClick={() => setAdjustFor(row)}>اصلاح</button>
                        </td>
                      </tr>
                    )) : null}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {receiptFor && <ReceiptModal row={receiptFor} domain={domain} onClose={() => setReceiptFor(null)} onDone={() => { setReceiptFor(null); void reload(); }} flash={flash} />}
      {saleFor && <QuickManualSaleModal row={saleFor} onClose={() => setSaleFor(null)} onDone={() => { setSaleFor(null); void reload(); }} flash={flash} />}
      {adjustFor && <AdjustModal row={adjustFor} domain={domain} onClose={() => setAdjustFor(null)} onDone={() => { setAdjustFor(null); void reload(); }} flash={flash} />}
    </Card>
  );
}

/** react fragments inside tbody need a tiny helper to keep keys happy */
function FragmentRows({ head, body }: { head: React.ReactNode; body: React.ReactNode }) {
  return <>{head}{body}</>;
}

/* ------------------------------ row modals (D2/F/J) ------------------------------ */

function ReceiptModal({ row, domain, onClose, onDone, flash }: { row: InvRow; domain: "retail" | "wholesale"; onClose: () => void; onDone: () => void; flash: F }) {
  const [qty, setQty] = useState("");
  const [batch, setBatch] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="رسید ورود موجودی">
      <div className="space-y-3 p-4">
        <p className="text-[12.5px] text-[var(--kv-muted)]">«{row.product_name}» ({row.sku}) — انبار {row.warehouse_name} — دامنه {domain === "retail" ? "خرده‌فروشی" : "عمده"}.
          مقدار واردشده ابتدا «در راه» ثبت می‌شود و پس از دریافت و تأیید به موجودی اضافه می‌شود.</p>
        <Field label="تعداد"><Input value={qty} onChange={setQty} placeholder="مثلاً 50" /></Field>
        <Field label="شماره بسته / کارتن (اختیاری)"><Input value={batch} onChange={setBatch} placeholder="مثلاً CTN-12" /></Field>
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
            const quantity = Number(qty);
            if (!quantity || quantity <= 0) { flash("تعداد معتبر وارد کنید."); return; }
            setBusy(true);
            try {
              await inventoryApi.receipt(
                { warehouseId: row.warehouse_id, variantId: row.variant_id, quantity,
                  ...(batch.trim() ? { batchReference: batch.trim() } : {}), inventoryDomain: domain },
                newKey("rcpt"));
              flash("رسید ورود ثبت شد؛ کالا در وضعیت «در راه» است.");
              onDone();
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت رسید"); }
            finally { setBusy(false); }
          }}>ثبت رسید</Btn>
          <Btn size="sm" variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

function QuickManualSaleModal({ row, onClose, onDone, flash }: { row: InvRow; onClose: () => void; onDone: () => void; flash: F }) {
  const channels = Object.entries(CHANNEL_LABEL);
  const [channel, setChannel] = useState(channels[1]?.[1] ?? "اینستاگرام");
  const [qty, setQty] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [method, setMethod] = useState("نقدی");
  const [reference, setReference] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const METHODS: Record<string, ManualSaleCreate["payment"]["method"]> = {
    "نقدی": "cash", "کارت‌به‌کارت": "card_to_card", "دستگاه پوز": "pos", "درگاه": "gateway", "سایر": "other",
  };
  return (
    <Modal open onClose={onClose} title="ثبت فروش دستی" max="max-w-[640px]">
      <div className="space-y-3 p-4">
        <p className="text-[12.5px] text-[var(--kv-muted)]">«{row.product_name}» ({row.sku}) — قابل فروش فعلی: {fa(Number(row.available))} عدد.
          این عملیات یک فروش واقعی ثبت می‌کند (رکورد مالی + کسر موجودی + حسابرسی)، نه اصلاح موجودی.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="کانال فروش"><Select options={channels.map(([, l]) => l)} value={channel} onChange={setChannel} /></Field>
          <Field label="تعداد"><Input value={qty} onChange={setQty} /></Field>
          <Field label="قیمت واحد (ریال)"><Input value={unitPrice} onChange={setUnitPrice} placeholder="مثلاً 2500000" /></Field>
          <Field label="روش پرداخت"><Select options={Object.keys(METHODS)} value={method} onChange={setMethod} /></Field>
          {METHODS[method] === "card_to_card" && (
            <Field label="کد پیگیری کارت‌به‌کارت"><Input value={reference} onChange={setReference} placeholder="شماره پیگیری بانک" /></Field>
          )}
          <Field label="نام مشتری (اختیاری)"><Input value={customerName} onChange={setCustomerName} /></Field>
          <Field label="تلفن مشتری (اختیاری)"><Input value={customerPhone} onChange={setCustomerPhone} placeholder="09…" /></Field>
        </div>
        <Field label="یادداشت (اختیاری)"><Textarea value={note} onChange={setNote} rows={2} /></Field>
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
            const quantity = Number(qty); const unit = unitPrice.replace(/[^\d]/g, "");
            if (!quantity || quantity <= 0 || !unit) { flash("تعداد و قیمت واحد را کامل کنید."); return; }
            const total = (BigInt(unit) * BigInt(quantity)).toString();
            setBusy(true);
            try {
              const channelCode = (channels.find(([, l]) => l === channel)?.[0] ?? "other") as ManualSaleCreate["channel"];
              await manualSalesApi.create({
                channel: channelCode, warehouseId: row.warehouse_id,
                ...(customerName ? { customerName } : {}), ...(customerPhone ? { customerPhone } : {}),
                ...(note ? { note } : {}),
                lines: [{ variantId: row.variant_id, quantity, unitPriceRial: unit }],
                payment: { method: METHODS[method] ?? "cash", amountRial: total, ...(reference ? { reference } : {}) },
              }, newKey("qms"));
              flash("فروش دستی ثبت شد و موجودی کسر گردید.");
              onDone();
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت فروش"); }
            finally { setBusy(false); }
          }}>ثبت فروش</Btn>
          <Btn size="sm" variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

function AdjustModal({ row, domain, onClose, onDone, flash }: { row: InvRow; domain: "retail" | "wholesale"; onClose: () => void; onDone: () => void; flash: F }) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("شمارش دوره‌ای انبار");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="اصلاح موجودی (سند تعدیلی)">
      <div className="space-y-3 p-4">
        <p className="text-[12.5px] text-[var(--kv-muted)]">هر اصلاح به‌صورت سند گردش با دلیل، مرجع و کاربر ثبت می‌شود؛ هرگز بازنویسی مستقیم انجام نمی‌شود.</p>
        <Field label="تغییر (مثبت یا منفی)"><Input value={delta} onChange={setDelta} placeholder="مثلاً 3 یا -2" /></Field>
        <Field label="دلیل"><Input value={reason} onChange={setReason} /></Field>
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
            const d = Number(delta);
            if (!d) { flash("مقدار تغییر معتبر نیست."); return; }
            if (reason.trim().length < 4) { flash("دلیل اصلاح الزامی است."); return; }
            setBusy(true);
            try {
              await inventoryApi.adjust(
                { variantId: row.variant_id, warehouseId: row.warehouse_id, delta: d, reason: reason.trim(),
                  reference: newKey("adj"), inventoryDomain: domain },
                newKey("adjk"));
              flash("سند اصلاح موجودی ثبت شد.");
              onDone();
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در اصلاح موجودی"); }
            finally { setBusy(false); }
          }}>ثبت سند</Btn>
          <Btn size="sm" variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ transfers center (C2/G/H) ------------------------------ */

function TransfersCenter({ flash }: { flash: F }) {
  const [transfers, setTransfers] = useState<TransferRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reverseFor, setReverseFor] = useState<TransferRow | null>(null);

  // creation form
  const [inv, setInv] = useState<InvRow[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; owner_id: string | null }[]>([]);
  const [pickSku, setPickSku] = useState("");
  const [srcDomain, setSrcDomain] = useState<"wholesale" | "retail">("wholesale");
  const [dstDomain, setDstDomain] = useState<"wholesale" | "retail">("retail");
  const [srcWh, setSrcWh] = useState("");
  const [dstWh, setDstWh] = useState("");
  const [qty, setQty] = useState(""); // G3: never prefilled
  const [reason, setReason] = useState("");
  const [batch, setBatch] = useState("");
  const [confirmFull, setConfirmFull] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [t, b, w] = await Promise.all([
        inventoryApi.transfers(),
        inventoryApi.balances({ limit: 100 }),
        inventoryApi.warehouses(),
      ]);
      setTransfers(t.items as unknown as TransferRow[]);
      setInv(b.items as unknown as InvRow[]);
      setWarehouses(w.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری انتقال‌ها"); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const picked = inv.find((r) => r.sku === pickSku && r.inventory_domain === srcDomain && (!srcWh || warehouses.find((w) => w.name === srcWh)?.id === r.warehouse_id));
  const availableAtSource = picked ? Number(picked.available) : null;
  const isFullTransfer = availableAtSource !== null && Number(qty) === availableAtSource && availableAtSource > 0;

  const createTransfer = async () => {
    const srcWhId = warehouses.find((w) => w.name === srcWh)?.id;
    const dstWhId = warehouses.find((w) => w.name === dstWh)?.id;
    const quantity = Number(qty);
    if (!picked || !srcWhId || !dstWhId) { flash("کالا و انبار مبدأ/مقصد را انتخاب کنید."); return; }
    if (!quantity || quantity <= 0) { flash("تعداد انتقال را وارد کنید (پیش‌فرض خالی است)."); return; }
    if (reason.trim().length < 4) { flash("دلیل انتقال الزامی است."); return; }
    setBusy(true);
    try {
      await inventoryApi.domainTransfer({
        variantId: picked.variant_id, sourceDomain: srcDomain, destinationDomain: dstDomain,
        sourceWarehouseId: srcWhId, destinationWarehouseId: dstWhId, quantity, reason: reason.trim(),
        ...(batch.trim() ? { batchReference: batch.trim() } : {}),
        ...(isFullTransfer && confirmFull ? { confirmFullStock: true } : {}),
      }, newKey("trf"));
      flash("انتقال ثبت شد (پیش‌نویس). برای خروج از مبدأ آن را تأیید کنید.");
      setQty(""); setReason(""); setBatch(""); setConfirmFull(false);
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت انتقال"); }
    finally { setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); await reload(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در عملیات"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (transfers === null) return <LoadingState />;

  const skuOptions = [...new Set(inv.filter((r) => r.inventory_domain === srcDomain).map((r) => r.sku))];

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-extrabold"><ArrowLeftRight size={15} />انتقال رسمی بین دامنه‌ها / انبارها</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="دامنه مبدأ">
            <Select options={["عمده", "خرده"]} value={srcDomain === "wholesale" ? "عمده" : "خرده"}
              onChange={(v) => setSrcDomain(v === "عمده" ? "wholesale" : "retail")} />
          </Field>
          <Field label="دامنه مقصد">
            <Select options={["خرده", "عمده"]} value={dstDomain === "retail" ? "خرده" : "عمده"}
              onChange={(v) => setDstDomain(v === "خرده" ? "retail" : "wholesale")} />
          </Field>
          <Field label="کالا (SKU)"><Select options={skuOptions} value={pickSku} onChange={setPickSku} /></Field>
          <Field label="انبار مبدأ"><Select options={warehouses.map((w) => w.name)} value={srcWh} onChange={setSrcWh} /></Field>
          <Field label="انبار مقصد"><Select options={warehouses.map((w) => w.name)} value={dstWh} onChange={setDstWh} /></Field>
          <Field label={`تعداد${availableAtSource !== null ? ` (قابل انتقال: ${fa(availableAtSource)})` : ""}`}>
            <Input value={qty} onChange={setQty} placeholder="تعداد را وارد کنید" />
          </Field>
          <Field label="دلیل انتقال"><Input value={reason} onChange={setReason} placeholder="مثلاً تأمین ویترین خرده‌فروشی" /></Field>
          <Field label="شماره بسته / کارتن (اختیاری)"><Input value={batch} onChange={setBatch} placeholder="مثلاً BAG-7" /></Field>
        </div>
        {picked && dstDomain === "retail" && picked.owner_type !== "kolbe" && (
          <p className="mt-2 rounded-[10px] bg-red-50 px-3 py-2 text-[12px] leading-6 text-red-700">
            این کالا متعلق به تأمین‌کننده است. انتقال به خرده‌فروشی فقط پس از ثبت سند رسمی خرید/تملک توسط کلبه (با ظرفیت کافی) ممکن است؛ سرور این قاعده را اعمال می‌کند.
          </p>
        )}
        {isFullTransfer && (
          <div className="mt-2">
            <Checkbox checked={confirmFull} onChange={setConfirmFull}
              label={<span className="text-[12px] font-bold text-amber-800">تأیید می‌کنم که تمام موجودی قابل‌فروش مبدأ منتقل شود.</span>} />
          </div>
        )}
        <div className="mt-3"><Btn size="sm" variant="accent" disabled={busy} onClick={() => void createTransfer()}>ثبت انتقال</Btn></div>
      </Card>

      <Card className="overflow-hidden">
        <h3 className="flex items-center gap-1.5 border-b border-[var(--kv-border)] p-3 text-[14px] font-extrabold"><Truck size={15} />سوابق نقل‌وانتقال</h3>
        {transfers.length === 0 ? <Empty title="انتقالی ثبت نشده" desc="اولین انتقال را از فرم بالا بسازید." /> : (
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[860px] text-[12.5px]">
              <thead><tr><th>شماره</th><th>کالا</th><th>مسیر</th><th>تعداد</th><th>بسته</th><th>وضعیت</th><th>تاریخ</th><th>عملیات</th></tr></thead>
              <tbody>
                {transfers.map((t) => (
                  <tr key={t.id} className={cn(t.is_reverse && "bg-amber-50/40")}>
                    <td className="font-bold" dir="ltr">{t.transfer_number ?? t.reference}{t.is_reverse && <span className="mr-1 rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">برگشتی</span>}</td>
                    <td>{t.product_name ?? "—"} <span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{t.sku ?? ""}</span></td>
                    <td className="text-[11.5px]">{t.source_domain === "wholesale" ? "عمده" : "خرده"} ← {t.destination_domain === "retail" ? "خرده" : "عمده"}</td>
                    <td className="tabular-nums">{t.quantity !== null ? fa(t.quantity) : "—"}{t.reversed_quantity > 0 && <span className="mr-1 text-[10.5px] text-amber-700">({fa(t.reversed_quantity)} برگشت)</span>}</td>
                    <td className="text-[11.5px]" dir="ltr">{t.batch_reference ?? "—"}</td>
                    <td><Badge map={TRANSFER_BADGE} value={t.status} /></td>
                    <td className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(t.created_at)}</td>
                    <td className="whitespace-nowrap space-x-2 space-x-reverse">
                      {t.status === "draft" && (<>
                        <button className="text-[11.5px] font-bold text-[var(--kv-accent)]" disabled={busy}
                          onClick={() => void act(() => inventoryApi.approveTransfer(t.id), "کالا از مبدأ خارج شد (در راه).")}>تأیید و خروج</button>
                        <button className="text-[11.5px] font-bold text-red-500" disabled={busy}
                          onClick={() => void act(() => inventoryApi.cancelTransfer(t.id), "انتقال لغو و رزرو آزاد شد.")}>لغو</button>
                      </>)}
                      {(t.status === "in_transit" || t.status === "approved") && (
                        <button className="text-[11.5px] font-bold text-emerald-600" disabled={busy}
                          onClick={() => void act(() => inventoryApi.completeTransfer(t.id), "کالا در مقصد دریافت و نهایی شد.")}>دریافت در مقصد</button>
                      )}
                      {t.status === "completed" && !t.is_reverse && t.quantity !== null && t.quantity - t.reversed_quantity > 0 && (
                        <button className="inline-flex items-center gap-1 text-[11.5px] font-bold text-amber-700" disabled={busy}
                          onClick={() => setReverseFor(t)}><RotateCcw size={12} />برگشت</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reverseFor && (
        <ReverseModal transfer={reverseFor} onClose={() => setReverseFor(null)}
          onDone={() => { setReverseFor(null); void reload(); }} flash={flash} />
      )}
    </div>
  );
}

function ReverseModal({ transfer, onClose, onDone, flash }: { transfer: TransferRow; onClose: () => void; onDone: () => void; flash: F }) {
  const remaining = (transfer.quantity ?? 0) - transfer.reversed_quantity;
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title={`برگشت انتقال ${transfer.transfer_number ?? ""}`}>
      <div className="space-y-3 p-4">
        <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">
          انتقال تکمیل‌شده قابل ویرایش یا حذف نیست؛ اصلاح فقط با سند برگشتی (RTRF) انجام می‌شود.
          حداکثر مقدار قابل برگشت {fa(remaining)} عدد است و کالای فروخته‌شده یا رزروشده برگشت‌پذیر نیست.
        </p>
        <Field label="تعداد برگشتی"><Input value={qty} onChange={setQty} placeholder={`حداکثر ${fa(remaining)}`} /></Field>
        <Field label="دلیل برگشت"><Input value={reason} onChange={setReason} placeholder="مثلاً عدم فروش در خرده‌فروشی" /></Field>
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
            const quantity = Number(qty);
            if (!quantity || quantity <= 0) { flash("تعداد برگشتی را وارد کنید."); return; }
            if (reason.trim().length < 4) { flash("دلیل برگشت الزامی است."); return; }
            setBusy(true);
            try {
              const res = await inventoryApi.reverseTransfer(transfer.id, { quantity, reason: reason.trim() }, newKey("rtrf"));
              flash(`سند برگشتی ${String(res.transferNumber ?? "")} ثبت شد.`);
              onDone();
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت برگشت"); }
            finally { setBusy(false); }
          }}>ثبت برگشت</Btn>
          <Btn size="sm" variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------ wholesale center (C3/I/J/QC) ------------------------------ */

function WholesaleCenter({ flash }: { flash: F }) {
  const [sub, setSub] = useState<"inventory" | "requests" | "inbound">("inventory");
  return (
    <div className="space-y-4">
      <Segmented
        options={[
          { v: "inventory", label: "موجودی عمده" },
          { v: "requests", label: "درخواست‌های تأمین‌کنندگان" },
          { v: "inbound", label: "ورودی انبار و QC" },
        ]}
        value={sub} onChange={setSub}
      />
      {sub === "inventory" && <DomainInventory domain="wholesale" flash={flash} />}
      {sub === "requests" && <SupplierRequestsAdmin flash={flash} />}
      {sub === "inbound" && <InboundReceipts flash={flash} />}
    </div>
  );
}

function SupplierRequestsAdmin({ flash }: { flash: F }) {
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject" | "request_revision">("approve");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try { setRows((await supplierRequestsApi.list()).items as unknown as RequestRow[]); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری درخواست‌ها"); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  const openDetail = async (id: string) => {
    try { setDetail(await supplierRequestsApi.detail(id)); setDecision("approve"); setReason(""); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری جزئیات"); }
  };

  return (
    <Card className="overflow-hidden">
      <h3 className="flex items-center gap-1.5 border-b border-[var(--kv-border)] p-3 text-[14px] font-extrabold"><Store size={15} />درخواست‌های تأمین</h3>
      {rows.length === 0 ? <Empty title="درخواستی ثبت نشده" desc="تأمین‌کنندگان از پنل خود درخواست تأمین ثبت می‌کنند." /> : (
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[760px] text-[12.5px]">
            <thead><tr><th>شماره</th><th>تأمین‌کننده</th><th>اقلام</th><th>جمع تعداد</th><th>وضعیت</th><th>تاریخ</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-bold" dir="ltr">{r.request_number}</td>
                  <td>{r.supplier_name}</td>
                  <td className="tabular-nums">{fa(r.item_count)}</td>
                  <td className="tabular-nums">{fa(r.total_quantity)}</td>
                  <td><Badge map={REQUEST_BADGE} value={r.status} /></td>
                  <td className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(r.created_at)}</td>
                  <td><button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline" onClick={() => void openDetail(r.id)}>جزئیات و بررسی</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <Modal open onClose={() => setDetail(null)} title={`درخواست ${String(detail.request_number)}`} max="max-w-[720px]">
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <Badge map={REQUEST_BADGE} value={String(detail.status)} />
              {typeof detail.rejection_reason === "string" && detail.rejection_reason && (
                <span className="text-[12px] text-red-600">دلیل رد: {detail.rejection_reason}</span>
              )}
            </div>
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[560px] text-xs">
                <thead><tr><th>نوع</th><th>کالا</th><th>رنگ/سایز</th><th>تعداد</th><th>یادداشت</th></tr></thead>
                <tbody>
                  {(detail.items as Record<string, unknown>[]).map((item) => (
                    <tr key={String(item.id)}>
                      <td>{item.item_type === "new_product"
                        ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-800">محصول جدید — در حال اضافه شدن</span>
                        : <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px] font-bold">شارژ موجودی</span>}</td>
                      <td>{String(item.product_name ?? item.proposed_name ?? "—")} {item.variant_sku ? <span dir="ltr" className="text-[10.5px] text-[var(--kv-muted)]">{String(item.variant_sku)}</span> : null}</td>
                      <td>{String(item.color_label ?? item.proposed_color ?? "—")} / {String(item.size_label ?? item.proposed_size ?? "—")}</td>
                      <td className="tabular-nums">{fa(Number(item.quantity))}</td>
                      <td className="text-[11px] text-[var(--kv-muted)]">{String(item.note ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {(detail.revisions as unknown[]).length > 1 && (
              <p className="text-[11.5px] text-[var(--kv-muted)]">این درخواست {fa((detail.revisions as unknown[]).length)} نسخه دارد؛ تاریخچه کامل در سرور محفوظ است.</p>
            )}
            {(detail.receipts as Record<string, unknown>[]).length > 0 && (
              <div className="rounded-[10px] bg-[var(--kv-surface-2)] p-2 text-[12px]">
                رسیدهای ورودی: {(detail.receipts as Record<string, unknown>[]).map((r) => `${String(r.reference)} (${String(r.status) === "received" ? "دریافت‌شده" : "در راه"})`).join("، ")}
              </div>
            )}

            {String(detail.status) === "submitted" && (
              <div className="space-y-2 rounded-[12px] border border-[var(--kv-border)] p-3">
                <Segmented
                  options={[{ v: "approve", label: "تأیید" }, { v: "request_revision", label: "درخواست اصلاح" }, { v: "reject", label: "رد" }]}
                  value={decision} onChange={setDecision}
                />
                {decision !== "approve" && (
                  <Field label={decision === "reject" ? "دلیل دقیق رد (برای تأمین‌کننده نمایش داده می‌شود)" : "توضیح اصلاح"}>
                    <Textarea value={reason} onChange={setReason} rows={2} />
                  </Field>
                )}
                <p className="text-[11.5px] text-[var(--kv-muted)]">تأیید درخواست موجودی را افزایش نمی‌دهد؛ کالا پس از ارسال تأمین‌کننده، دریافت و کنترل کیفیت به موجودی اضافه می‌شود.</p>
                <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    await supplierRequestsApi.review(String(detail.id), { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) });
                    flash("نتیجه بررسی ثبت و به تأمین‌کننده اطلاع داده شد.");
                    setDetail(null); await reload();
                  } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت بررسی"); }
                  finally { setBusy(false); }
                }}>ثبت نتیجه بررسی</Btn>
              </div>
            )}
            {["received", "dispatched"].includes(String(detail.status)) && (
              <Btn size="sm" variant="soft" disabled={busy} onClick={async () => {
                setBusy(true);
                try { await supplierRequestsApi.close(String(detail.id)); flash("درخواست بسته شد."); setDetail(null); await reload(); }
                catch (e) { flash(e instanceof Error ? e.message : "خطا در بستن درخواست"); }
                finally { setBusy(false); }
              }}>بستن درخواست</Btn>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function InboundReceipts({ flash }: { flash: F }) {
  const [rows, setRows] = useState<ReceiptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receiveFor, setReceiveFor] = useState<ReceiptRow | null>(null);
  const [receivedQty, setReceivedQty] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try { setRows((await inventoryApi.receipts()).items as unknown as ReceiptRow[]); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری رسیدها"); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  return (
    <Card className="overflow-hidden">
      <h3 className="flex items-center gap-1.5 border-b border-[var(--kv-border)] p-3 text-[14px] font-extrabold"><ClipboardCheck size={15} />رسیدهای ورودی و کنترل کیفیت</h3>
      {rows.length === 0 ? <Empty title="رسیدی ثبت نشده" desc="رسیدهای ورود کالا (دستی یا از درخواست تأمین) اینجا دیده می‌شوند." /> : (
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[760px] text-[12.5px]">
            <thead><tr><th>مرجع</th><th>دامنه</th><th>مورد انتظار</th><th>دریافتی</th><th>کسری</th><th>بسته</th><th>وضعیت</th><th>تاریخ</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="font-bold" dir="ltr">{r.reference}</td>
                  <td>{r.inventory_domain === "wholesale" ? "عمده" : "خرده"}</td>
                  <td className="tabular-nums">{r.quantity !== null ? fa(r.quantity) : "—"}</td>
                  <td className="tabular-nums">{r.received_quantity !== null ? fa(r.received_quantity) : "—"}</td>
                  <td className="tabular-nums">{r.missing_quantity > 0 ? <span className="font-bold text-red-600">{fa(r.missing_quantity)}</span> : "—"}</td>
                  <td dir="ltr" className="text-[11.5px]">{r.batch_reference ?? "—"}</td>
                  <td>{r.status === "received"
                    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-bold text-emerald-800">دریافت‌شده</span>
                    : r.status === "cancelled"
                      ? <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10.5px] font-bold text-gray-600">لغوشده</span>
                      : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-800">در انتظار دریافت</span>}</td>
                  <td className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(r.created_at)}</td>
                  <td>{r.status === "pending" && (
                    <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline"
                      onClick={() => { setReceiveFor(r); setReceivedQty(""); }}>دریافت و شمارش</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {receiveFor && (
        <Modal open onClose={() => setReceiveFor(null)} title={`دریافت رسید ${receiveFor.reference}`}>
          <div className="space-y-3 p-4">
            <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">
              تعداد مورد انتظار: {fa(receiveFor.quantity ?? 0)} عدد. اگر تعداد واقعی کمتر است همان را وارد کنید؛
              کسری به‌صورت مغایرت رسمی ثبت و اطلاع‌رسانی می‌شود — هرگز کورکورانه تأیید نکنید.
            </p>
            <Field label="تعداد واقعی دریافتی">
              <Input value={receivedQty} onChange={setReceivedQty} placeholder={`پیش‌فرض: ${fa(receiveFor.quantity ?? 0)}`} />
            </Field>
            <div className="flex gap-2">
              <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  const payload = receivedQty.trim() ? { receivedQuantity: Number(receivedQty) } : {};
                  const res = await inventoryApi.receiveReceipt(receiveFor.id, payload) as Record<string, unknown>;
                  const missing = Number(res.missingQuantity ?? 0);
                  flash(missing > 0 ? `رسید دریافت شد؛ کسری ${fa(missing)} عدد ثبت و اطلاع‌رسانی شد.` : "رسید کامل دریافت شد.");
                  setReceiveFor(null); await reload();
                } catch (e) { flash(e instanceof Error ? e.message : "خطا در دریافت رسید"); }
                finally { setBusy(false); }
              }}>ثبت دریافت</Btn>
              <Btn size="sm" variant="soft" onClick={() => setReceiveFor(null)}>انصراف</Btn>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}
