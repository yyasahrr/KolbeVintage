import { useCallback, useEffect, useState } from "react";
import { Minus, Plus, Search } from "lucide-react";
import { Btn, Checkbox, Empty, Field, Input, Textarea } from "./primitives";
import { inventoryApi, manualOrdersApi, type ManualOrderCreate } from "../data/api";
import { cn } from "../utils/cn";

/**
 * §31-§35: «ثبت سفارش دستی» creates a REAL retail order on the canonical pipeline.
 * - pricing is resolved SERVER-side (same resolver as website checkout) — no price input here;
 * - inventory moves through the normal order lifecycle (reserve → consume) — no direct mutation;
 * - customer is found-or-created by mobile; channel is recorded on orders.sales_channel.
 * Legacy manual_sales stay readable in the unified retail list («ثبت‌دستی» rows).
 */

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const toman = (rial: string | null | undefined) => {
  if (!rial) return "—";
  try { return `${new Intl.NumberFormat("fa-IR").format(BigInt(rial) / 10n)} تومان`; } catch { return "—"; }
};

const CHANNELS: { v: ManualOrderCreate["channel"]; label: string }[] = [
  { v: "instagram", label: "اینستاگرام" }, { v: "in_person", label: "حضوری" },
  { v: "whatsapp", label: "واتس‌اپ" }, { v: "telegram", label: "تلگرام" },
  { v: "phone", label: "تلفنی" }, { v: "other", label: "سایر" },
];
const METHODS: { v: ManualOrderCreate["payment"]["method"]; label: string }[] = [
  { v: "cash", label: "نقدی" }, { v: "card_to_card", label: "کارت‌به‌کارت" },
  { v: "gateway", label: "درگاه" }, { v: "cod", label: "پرداخت در محل" },
];

type Warehouse = { id: string; code: string; name: string; purpose?: "retail" | "wholesale" | "mixed" };
type PickRow = {
  variant_id: string; warehouse_id: string; sku: string; product_name: string;
  color_label: string | null; size_label: string | null; available: number;
  effective_retail_sellable?: boolean; sale_status?: string;
};
type CartLine = { variantId: string; sku: string; label: string; available: number; quantity: number };

export function ManualOrderForm({ onDone }: { onDone?: () => void }) {
  // customer + channel
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [channel, setChannel] = useState<ManualOrderCreate["channel"]>("instagram");
  // warehouse
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  // item picking (server-backed search over retail balances)
  const [search, setSearch] = useState("");
  const [picks, setPicks] = useState<PickRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  // payment
  const [method, setMethod] = useState<ManualOrderCreate["payment"]["method"]>("cash");
  const [paid, setPaid] = useState(true);
  const [payRef, setPayRef] = useState("");
  const [deliverNow, setDeliverNow] = useState(false);
  const [note, setNote] = useState("");
  // submit
  const [key] = useState(() => `mo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ reference: string; status: string; totalRial: string; customerCreated: boolean } | null>(null);

  useEffect(() => {
    void inventoryApi.warehouses().then((res) => {
      // §40: manual retail sale only from retail-purpose warehouses (server enforces too).
      const retail = res.items.filter((w) => w.purpose !== "wholesale");
      setWarehouses(retail);
      if (retail.length === 1) setWarehouseId(retail[0]!.id);
    }).catch(() => setWarehouses([]));
  }, []);

  const runSearch = useCallback(async () => {
    if (!warehouseId) { setError("ابتدا انبار خرده را انتخاب کنید."); return; }
    setSearching(true); setError(null);
    try {
      const res = await inventoryApi.balances({
        warehouseId, inventoryDomain: "retail", limit: 30,
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      setPicks((res.items as PickRow[]).filter((r) => r.available > 0));
    } catch (err) { setError(err instanceof Error ? err.message : "خطا در جست‌وجوی کالا"); }
    finally { setSearching(false); }
  }, [warehouseId, search]);

  const addToCart = (row: PickRow) => {
    if (row.effective_retail_sellable === false) return;
    setCart((prev) => prev.some((l) => l.variantId === row.variant_id) ? prev : [...prev, {
      variantId: row.variant_id, sku: row.sku,
      label: `${row.product_name}${row.color_label ? ` — ${row.color_label}` : ""}${row.size_label ? ` / ${row.size_label}` : ""}`,
      available: row.available, quantity: 1,
    }]);
  };
  const setQty = (variantId: string, delta: number) => setCart((prev) => prev
    .map((l) => l.variantId === variantId ? { ...l, quantity: Math.min(l.available, Math.max(0, l.quantity + delta)) } : l)
    .filter((l) => l.quantity > 0));

  const mobileOk = /^09\d{9}$/.test(mobile.trim());
  const canSubmit = !busy && !result && name.trim().length >= 2 && mobileOk && warehouseId && cart.length > 0
    && (!paid || method !== "card_to_card" || payRef.trim().length > 0);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await manualOrdersApi.create({
        customer: { name: name.trim(), mobile: mobile.trim() },
        channel, warehouseId,
        items: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        payment: { method, status: paid ? "paid" : "pending", ...(payRef.trim() ? { reference: payRef.trim() } : {}) },
        deliverNow: deliverNow && paid && channel === "in_person",
        ...(note.trim() ? { note: note.trim() } : {}),
      }, key);
      setResult({ reference: res.reference, status: res.status, totalRial: res.totalRial, customerCreated: res.customerCreated });
      onDone?.();
    } catch (err) { setError(err instanceof Error ? err.message : "ثبت سفارش دستی ناموفق بود"); }
    finally { setBusy(false); }
  };

  if (result) {
    return (
      <div className="space-y-3 rounded-[14px] border border-emerald-300 bg-emerald-50 p-5 text-right">
        <p className="text-[14px] font-black text-emerald-800">سفارش {result.reference} ثبت شد ✓</p>
        <p className="text-[12px] text-emerald-700">
          مبلغ کل (قیمت‌گذاری رسمی سرور): <b className="tabular-nums">{toman(result.totalRial)}</b>
          {" · "}وضعیت: <b>{result.status === "delivered" ? "تحویل‌شده" : result.status === "paid" ? "پرداخت‌شده" : "در انتظار پرداخت"}</b>
          {result.customerCreated && " · مشتری جدید ساخته شد"}
        </p>
        <p className="text-[11px] text-emerald-700">سفارش در فهرست «سفارشات خرده» در کنار سفارش‌های سایت نمایش داده می‌شود و چرخه وضعیت عادی را طی می‌کند.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-right">
      {/* customer + channel */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="نام مشتری *"><Input placeholder="مثلاً سارا محمدی" value={name} onChange={setName} /></Field>
        <Field label="موبایل مشتری *" hint={mobile && !mobileOk ? "فرمت: 09xxxxxxxxx" : "مشتری با این شماره پیدا یا ساخته می‌شود"}>
          <Input placeholder="09xxxxxxxxx" value={mobile} onChange={setMobile} />
        </Field>
        <Field label="کانال فروش *">
          <div className="flex flex-wrap gap-1.5">
            {CHANNELS.map((c) => (
              <button key={c.v} type="button" onClick={() => setChannel(c.v)}
                className={cn("rounded-full border px-2.5 py-1 text-[11px] font-bold",
                  channel === c.v ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-white" : "border-[var(--kv-line)] text-[var(--kv-muted)] hover:border-[var(--kv-action)]")}>
                {c.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {/* warehouse */}
      <Field label="انبار خرده *" hint="فقط انبارهای خرده‌فروشی؛ فروش دستی از انبار عمده مجاز نیست.">
        <div className="flex flex-wrap gap-1.5">
          {warehouses.length === 0 && <span className="text-[11px] text-[var(--kv-muted)]">انبار خرده فعالی یافت نشد.</span>}
          {warehouses.map((w) => (
            <button key={w.id} type="button" onClick={() => { setWarehouseId(w.id); setPicks([]); setCart([]); }}
              className={cn("rounded-[10px] border px-3 py-1.5 text-[11.5px] font-bold",
                warehouseId === w.id ? "border-[var(--kv-action)] bg-[var(--kv-action)]/10 text-[var(--kv-action)]" : "border-[var(--kv-line)] hover:border-[var(--kv-action)]")}>
              {w.name} <span className="text-[9.5px] text-[var(--kv-muted)]" dir="ltr">{w.code}</span>
            </button>
          ))}
        </div>
      </Field>

      {/* item picking */}
      <div className="space-y-2 rounded-[14px] border border-[var(--kv-line)] p-3">
        <p className="text-[12px] font-black">اقلام سفارش</p>
        <div className="flex gap-2">
          <div className="flex-1"><Input placeholder="جست‌وجوی کالا: نام یا SKU…" value={search} onChange={setSearch} icon={<Search size={14} />} /></div>
          <Btn size="sm" variant="soft" disabled={searching || !warehouseId} onClick={() => void runSearch()}>{searching ? "در حال جست‌وجو…" : "جست‌وجو"}</Btn>
        </div>
        {picks.length > 0 && (
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {picks.map((r) => {
              const sellable = r.effective_retail_sellable !== false;
              const inCart = cart.some((l) => l.variantId === r.variant_id);
              return (
                <button key={r.variant_id} type="button" disabled={!sellable || inCart} onClick={() => addToCart(r)}
                  className={cn("flex w-full items-center justify-between gap-2 rounded-[10px] border px-2.5 py-1.5 text-[11px]",
                    !sellable ? "cursor-not-allowed border-[var(--kv-line)] opacity-50" : inCart ? "border-emerald-300 bg-emerald-50" : "border-[var(--kv-line)] hover:border-[var(--kv-action)]")}>
                  <span className="font-bold">{r.product_name}{r.color_label ? ` — ${r.color_label}` : ""}{r.size_label ? ` / ${r.size_label}` : ""}
                    <span className="mr-1 text-[9.5px] text-[var(--kv-muted)]" dir="ltr">{r.sku}</span></span>
                  <span className="shrink-0 tabular-nums text-[var(--kv-muted)]">
                    {sellable ? `${fa(r.available)} عدد قابل فروش` : "فروش متوقف"}
                    {inCart && " · افزوده شد"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {picks.length === 0 && !searching && <p className="text-[10.5px] text-[var(--kv-muted)]">کالاها را جست‌وجو کنید؛ فقط موجودی قابل فروش انبار انتخابی نمایش داده می‌شود. قیمت‌ها را سرور با قیمت‌گذاری رسمی (شامل تخفیف‌های فعال) محاسبه می‌کند.</p>}

        {cart.length > 0 && (
          <div className="space-y-1 border-t border-[var(--kv-line)] pt-2">
            {cart.map((l) => (
              <div key={l.variantId} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="font-bold">{l.label} <span className="text-[9.5px] text-[var(--kv-muted)]" dir="ltr">{l.sku}</span></span>
                <span className="flex items-center gap-1.5">
                  <button type="button" className="rounded-full border border-[var(--kv-line)] p-1 hover:border-[var(--kv-action)]" onClick={() => setQty(l.variantId, -1)}><Minus size={11} /></button>
                  <b className="w-8 text-center tabular-nums">{fa(l.quantity)}</b>
                  <button type="button" className="rounded-full border border-[var(--kv-line)] p-1 hover:border-[var(--kv-action)]" disabled={l.quantity >= l.available} onClick={() => setQty(l.variantId, 1)}><Plus size={11} /></button>
                  <span className="text-[10px] text-[var(--kv-muted)]">از {fa(l.available)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {cart.length === 0 && picks.length > 0 && <Empty title="هنوز کالایی انتخاب نشده" desc="روی کالا کلیک کنید تا به سفارش افزوده شود." />}
      </div>

      {/* payment */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="روش پرداخت *">
          <div className="flex flex-wrap gap-1.5">
            {METHODS.map((m) => (
              <button key={m.v} type="button" onClick={() => { setMethod(m.v); if (m.v === "cod") setPaid(false); }}
                className={cn("rounded-full border px-2.5 py-1 text-[11px] font-bold",
                  method === m.v ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-white" : "border-[var(--kv-line)] text-[var(--kv-muted)] hover:border-[var(--kv-action)]")}>
                {m.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="وضعیت پرداخت *" hint={paid && method === "card_to_card" ? "برای کارت‌به‌کارت پرداخت‌شده، کد پیگیری الزامی است." : undefined}>
          <div className="space-y-1.5">
            <Checkbox checked={paid} onChange={(v) => { setPaid(v); if (!v) setDeliverNow(false); }} label="پرداخت انجام شده است" />
            {paid && method === "card_to_card" && <Input placeholder="کد پیگیری کارت‌به‌کارت" value={payRef} onChange={setPayRef} />}
            {paid && channel === "in_person" && <Checkbox checked={deliverNow} onChange={setDeliverNow} label="تحویل حضوری همین حالا (پرداخت + تحویل یک‌جا ثبت می‌شود)" />}
          </div>
        </Field>
      </div>

      <Field label="یادداشت (اختیاری)"><Textarea rows={2} placeholder="توضیحات، آدرس توافقی، …" value={note} onChange={setNote} /></Field>

      {error && <p className="rounded-[10px] border border-red-200 bg-red-50 p-2.5 text-[11.5px] font-bold text-red-700">{error}</p>}
      <div className="flex items-center gap-2">
        <Btn disabled={!canSubmit} onClick={() => void submit()}>{busy ? "در حال ثبت…" : "ثبت سفارش دستی"}</Btn>
        <span className="text-[10.5px] text-[var(--kv-muted)]">سفارش واقعی ساخته می‌شود؛ موجودی از چرخه عادی سفارش (رزرو → مصرف) کم می‌شود.</span>
      </div>
    </div>
  );
}
