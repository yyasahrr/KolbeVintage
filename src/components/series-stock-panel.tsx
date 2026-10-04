import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, Layers, PackageOpen, History } from "lucide-react";
import { Btn, Card, WorkspaceModal, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Select, Textarea } from "./primitives";
import { retailSuppliesApi, seriesInventoryApi, type SeriesStockRow } from "../data/api";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

type F = (msg: string) => void;
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const OWNER_LABEL: Record<string, string> = { kolbe: "کلبه", supplier: "تأمین‌کننده (امانی)" };
export const SERIES_MOVE_LABEL: Record<string, string> = {
  stocktake: "شمارش سری", receipt: "دریافت سری", reserve: "رزرو", release: "آزادسازی رزرو",
  consume: "مصرف (ارسال)", dispatch_break: "باز کردن سری", incoming: "در راه",
  incoming_receive: "دریافت در راه", incoming_cancel: "لغو در راه", qc_reject: "رد در QC", adjust: "اصلاح",
};

function seriesStatus(row: SeriesStockRow): { label: string; cls: string } {
  if (row.sellable > 0) return { label: "موجود", cls: "bg-emerald-100 text-emerald-800" };
  if (row.incoming > 0) return { label: "در راه", cls: "bg-amber-100 text-amber-800" };
  if (row.on_hand > 0) return { label: "تماماً رزرو", cls: "bg-amber-100 text-amber-800" };
  if (!row.tracked) return { label: "شمارش‌نشده", cls: "bg-gray-100 text-gray-600" };
  return { label: "ناموجود", cls: "bg-red-100 text-red-700" };
}

/**
 * §7/§42: series-centric wholesale stock — the PRIMARY representation of the central wholesale
 * warehouse. One row = Product + Color + Owner + Series template; expanding shows the recipe.
 * Loose piece counts are never shown as wholesale stock here.
 */
export function SeriesStockPanel({ flash }: { flash: F }) {
  const [rows, setRows] = useState<SeriesStockRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({ warehouseId: "", ownerType: "", color: "", status: "" });
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; purpose?: string }[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [stocktakeFor, setStocktakeFor] = useState<SeriesStockRow | null>(null);
  const [supplyFor, setSupplyFor] = useState<SeriesStockRow | null>(null);
  const [historyFor, setHistoryFor] = useState<SeriesStockRow | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await seriesInventoryApi.list({
        withItems: 1, limit: 100,
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
        ...(filters.ownerType ? { ownerType: filters.ownerType } : {}),
        ...(filters.color.trim() ? { color: filters.color.trim() } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی سری"); }
  }, [search, filters]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    import("../data/api").then(({ inventoryApi }) =>
      inventoryApi.warehouses().then((res) => setWarehouses(res.items)).catch(() => setWarehouses([])));
  }, []);

  const wholesaleWarehouses = useMemo(() => warehouses.filter((w) => w.purpose !== "retail"), [warehouses]);

  const kpi = useMemo(() => {
    const list = rows ?? [];
    return {
      onHand: list.reduce((s, r) => s + r.on_hand, 0),
      reserved: list.reduce((s, r) => s + r.reserved, 0),
      sellable: list.reduce((s, r) => s + r.sellable, 0),
      incoming: list.reduce((s, r) => s + r.incoming, 0),
    };
  }, [rows]);

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  const rowId = (row: SeriesStockRow) => `${row.series_template_id}|${row.warehouse_id ?? "none"}|${row.owner_type}|${row.supplier_id ?? ""}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "سری موجود", value: kpi.onHand, cls: "text-[var(--kv-ink)]" },
          { label: "رزروشده", value: kpi.reserved, cls: "text-amber-700" },
          { label: "قابل فروش", value: kpi.sellable, cls: "text-emerald-700" },
          { label: "در راه", value: kpi.incoming, cls: "text-sky-700" },
        ].map((item) => (
          <Card key={item.label} className="p-3 text-center">
            <p className="text-[11px] font-bold text-[var(--kv-muted)]">{item.label}</p>
            <p className={cn("mt-1 text-[20px] font-black tabular-nums", item.cls)}>{fa(item.value)} <span className="text-[11px] font-bold">سری</span></p>
          </Card>
        ))}
      </div>

      <Card className="p-3">
        <div className="grid gap-2 md:grid-cols-5">
          <SearchBox placeholder="محصول یا نام سری…" value={search} onChange={setSearch} />
          <Select options={["همه انبارها", ...wholesaleWarehouses.map((w) => w.name)]}
            value={wholesaleWarehouses.find((w) => w.id === filters.warehouseId)?.name ?? "همه انبارها"}
            onChange={(v) => setFilters((f) => ({ ...f, warehouseId: wholesaleWarehouses.find((w) => w.name === v)?.id ?? "" }))} />
          <Select options={["همه مالکیت‌ها", "کلبه", "تأمین‌کننده (امانی)"]}
            value={filters.ownerType === "kolbe" ? "کلبه" : filters.ownerType === "supplier" ? "تأمین‌کننده (امانی)" : "همه مالکیت‌ها"}
            onChange={(v) => setFilters((f) => ({ ...f, ownerType: v === "کلبه" ? "kolbe" : v === "تأمین‌کننده (امانی)" ? "supplier" : "" }))} />
          <Input value={filters.color} onChange={(v) => setFilters((f) => ({ ...f, color: v }))} placeholder="رنگ…" />
          <Select options={["همه وضعیت‌ها", "قابل فروش", "رزروشده", "در راه", "خالی"]}
            value={filters.status === "available" ? "قابل فروش" : filters.status === "reserved" ? "رزروشده" : filters.status === "incoming" ? "در راه" : filters.status === "empty" ? "خالی" : "همه وضعیت‌ها"}
            onChange={(v) => setFilters((f) => ({ ...f, status: v === "قابل فروش" ? "available" : v === "رزروشده" ? "reserved" : v === "در راه" ? "incoming" : v === "خالی" ? "empty" : "" }))} />
        </div>
      </Card>

      {rows.length === 0 ? (
        <Empty title="سری‌ای یافت نشد" desc="قالب سری در «ساختار محصولات و سری‌ها» تعریف می‌شود؛ موجودی واقعی با «شمارش سری» ثبت می‌شود." />
      ) : (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[980px] text-[12.5px]">
              <thead><tr>
                <th></th><th>محصول</th><th>رنگ</th><th>سری</th><th>مالکیت</th><th>انبار</th>
                <th>سری موجود</th><th>رزروشده</th><th>قابل فروش</th><th>در راه</th><th>وضعیت</th><th>عملیات</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => {
                  const id = rowId(row);
                  const open = expanded.has(id);
                  const status = seriesStatus(row);
                  return (
                    <SeriesRowGroup key={id} head={
                      <tr className={cn(!row.tracked && "bg-amber-50/30")}>
                        <td>
                          <button aria-label="جزئیات ترکیب" className="p-1" onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}>
                            {open ? <ChevronDown size={14} /> : <ChevronLeft size={14} />}
                          </button>
                        </td>
                        <td className="font-bold">{row.product_name}</td>
                        <td>{row.color_label ?? "—"}</td>
                        <td className="text-[11.5px]">{row.template_name}<span className="mr-1 text-[10.5px] text-[var(--kv-muted)]">({fa(row.pieces_per_series)} عدد در سری)</span></td>
                        <td>
                          <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", row.owner_type === "kolbe" ? "bg-emerald-100 text-emerald-800" : "bg-violet-100 text-violet-800")}>
                            {OWNER_LABEL[row.owner_type]}{row.supplier_name ? ` — ${row.supplier_name}` : ""}
                          </span>
                        </td>
                        <td className="text-[11.5px]">{row.warehouse_name ?? "—"}</td>
                        <td className="tabular-nums font-bold">{row.tracked ? fa(row.on_hand) : <span className="text-amber-700" title="شمارش‌نشده — برآورد از اجزا">≈{fa(row.legacy_available)}</span>}</td>
                        <td className="tabular-nums">{fa(row.reserved)}</td>
                        <td className="tabular-nums font-bold text-emerald-700">{row.tracked ? fa(row.sellable) : "—"}</td>
                        <td className="tabular-nums">{fa(row.incoming)}</td>
                        <td><span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", status.cls)}>{status.label}</span></td>
                        <td className="whitespace-nowrap">
                          <div className="flex flex-wrap gap-1.5">
                            <Btn size="sm" variant="soft" disabled={busy} onClick={() => setStocktakeFor(row)}>شمارش سری</Btn>
                            {row.retail_supply_allowed ? (
                              <Btn size="sm" variant="accent" disabled={busy || !row.tracked || row.sellable <= 0}
                                onClick={() => setSupplyFor(row)}>تأمین خرده از عمده</Btn>
                            ) : (
                              <span className="self-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-500" title="سری امانی تأمین‌کننده فقط برای فروش عمده VIP مجاز است (قانون سرور).">فقط فروش VIP</span>
                            )}
                            <button className="p-1 text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" title="تاریخچه حرکت سری" onClick={() => setHistoryFor(row)}><History size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    } body={open ? (
                      <tr className="bg-[var(--kv-surface-2)]/50">
                        <td colSpan={12} className="p-3">
                          <p className="mb-2 text-[11.5px] font-bold text-[var(--kv-muted)]"><Layers size={12} className="ml-1 inline" />ترکیب هر سری کامل:</p>
                          <div className="flex flex-wrap gap-2">
                            {(row.items ?? []).map((item) => (
                              <span key={item.variant_id} className="rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2.5 py-1 text-[11.5px]">
                                {item.size_label ?? "—"} {item.color_label ? `/ ${item.color_label}` : ""} × {fa(item.quantity_per_series)} عدد
                                <span className="mr-1 text-[10px] text-[var(--kv-muted)]" dir="ltr">{item.sku}</span>
                              </span>
                            ))}
                          </div>
                          {!row.tracked && (
                            <p className="mt-2 rounded-[10px] bg-amber-50 px-3 py-2 text-[11.5px] leading-6 text-amber-800">
                              برای این قالب هنوز شمارش واقعی سری ثبت نشده است؛ عدد نمایش‌داده‌شده فقط برآوردی از موجودی اجزاست. با «شمارش سری» تعداد سری‌های دست‌نخورده واقعی را اعلام کنید.
                            </p>
                          )}
                        </td>
                      </tr>
                    ) : null} />
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > rows.length && <p className="border-t border-[var(--kv-line)] p-3 text-[11.5px] text-[var(--kv-muted)]">نمایش {fa(rows.length)} از {fa(total)} ردیف — جست‌وجو را دقیق‌تر کنید.</p>}
        </Card>
      )}

      {stocktakeFor && (
        <StocktakeModal row={stocktakeFor} warehouses={wholesaleWarehouses} flash={flash} busy={busy} setBusy={setBusy}
          onClose={() => setStocktakeFor(null)} onDone={async () => { setStocktakeFor(null); await reload(); }} />
      )}
      {supplyFor && (
        <SupplyWizard preset={supplyFor} flash={flash}
          onClose={() => setSupplyFor(null)} onDone={async () => { setSupplyFor(null); await reload(); }} />
      )}
      {historyFor && (
        <SeriesHistoryDrawer row={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  );
}

function SeriesRowGroup({ head, body }: { head: React.ReactNode; body: React.ReactNode }) {
  return <>{head}{body}</>;
}

function StocktakeModal({ row, warehouses, flash, busy, setBusy, onClose, onDone }: {
  row: SeriesStockRow; warehouses: { id: string; name: string }[]; flash: F;
  busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [warehouseName, setWarehouseName] = useState(row.warehouse_name ?? warehouses[0]?.name ?? "");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const submit = async () => {
    const warehouseId = warehouses.find((w) => w.name === warehouseName)?.id;
    if (!warehouseId) { flash("انبار عمده را انتخاب کنید."); return; }
    const value = Number(counted);
    if (!counted.trim() || !Number.isInteger(value) || value < 0) { flash("تعداد سری شمارش‌شده را به عدد صحیح وارد کنید."); return; }
    setBusy(true);
    try {
      await seriesInventoryApi.stocktake({
        seriesTemplateId: row.series_template_id, warehouseId, countedSeries: value,
        ownerType: row.owner_type, ...(row.supplier_id ? { supplierId: row.supplier_id } : {}),
        ...(note.trim() ? { note: note.trim() } : {}), idempotencyKey: newKey("stk"),
      });
      flash("شمارش سری ثبت شد.");
      await onDone();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت شمارش"); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="شمارش سری">
      <h3 className="mb-1 text-[15px] font-extrabold">شمارش سری — {row.product_name}{row.color_label ? ` (${row.color_label})` : ""}</h3>
      <p className="mb-4 text-[12px] leading-6 text-[var(--kv-muted)]">
        تعداد «سری کامل دست‌نخورده» که واقعاً در انبار وجود دارد را اعلام کنید. سرور اجازه نمی‌دهد بیش از آنچه موجودی عددی اجزا پوشش می‌دهد سری اعلام شود.
      </p>
      <div className="space-y-3">
        <Field label="انبار عمده"><Select options={warehouses.map((w) => w.name)} value={warehouseName} onChange={setWarehouseName} /></Field>
        <Field label={`تعداد سری کامل (فعلی: ${row.tracked ? fa(row.on_hand) : "شمارش‌نشده"})`}>
          <Input value={counted} onChange={setCounted} placeholder="مثلاً ۴" />
        </Field>
        <Field label="توضیح (اختیاری)"><Textarea value={note} onChange={setNote} placeholder="مثلاً شمارش انبارگردانی مهر" /></Field>
        <div className="flex gap-2">
          <Btn variant="accent" disabled={busy} onClick={() => void submit()}>ثبت شمارش</Btn>
          <Btn variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

/**
 * §10/§11: «تأمین از عمده» wizard — starts at Product level, never variant picking.
 * Product → Color (series template) → source wholesale WH (REAL per-warehouse availability,
 * suggested but never hidden-auto-selected) → destination retail WH → series count →
 * composition preview → confirm. Creates a real SUP document (reserved).
 */
export function SupplyWizard({ preset, flash, onClose, onDone }: {
  preset?: SeriesStockRow | null; flash: F; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<SeriesStockRow[] | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; purpose?: string }[]>([]);
  const [productId, setProductId] = useState(preset?.product_id ?? "");
  const [templateId, setTemplateId] = useState(preset?.series_template_id ?? "");
  const [sourceWhId, setSourceWhId] = useState("");
  const [destWhId, setDestWhId] = useState("");
  const [count, setCount] = useState("");
  const [note, setNote] = useState("");
  const [submissionKey] = useState(() => newKey("sup"));
  const [doneRef, setDoneRef] = useState<string | null>(null);

  useEffect(() => {
    // Only kolbe-owned tracked series can feed retail (§8) — the wizard never offers anything else.
    seriesInventoryApi.list({ withItems: 1, ownerType: "kolbe", limit: 100 })
      .then((res) => setOptions(res.items.filter((r) => r.tracked)))
      .catch((e) => flash(e instanceof Error ? e.message : "خطا در بارگذاری سری‌ها"));
    import("../data/api").then(({ inventoryApi }) =>
      inventoryApi.warehouses().then((res) => setWarehouses(res.items)).catch(() => setWarehouses([])));
  }, [flash]);

  const products = useMemo(() => {
    const map = new Map<string, { id: string; name: string; sellable: number }>();
    for (const row of options ?? []) {
      const existing = map.get(row.product_id);
      map.set(row.product_id, { id: row.product_id, name: row.product_name, sellable: (existing?.sellable ?? 0) + row.sellable });
    }
    return [...map.values()];
  }, [options]);
  const colorRows = useMemo(() => {
    // one entry per template (color); availability aggregated per warehouse below
    const map = new Map<string, { templateId: string; color: string; name: string; pieces: number; sellable: number }>();
    for (const row of (options ?? []).filter((r) => r.product_id === productId)) {
      const existing = map.get(row.series_template_id);
      map.set(row.series_template_id, {
        templateId: row.series_template_id, color: row.color_label ?? "—", name: row.template_name,
        pieces: row.pieces_per_series, sellable: (existing?.sellable ?? 0) + row.sellable,
      });
    }
    return [...map.values()];
  }, [options, productId]);
  const sourceRows = useMemo(() =>
    (options ?? []).filter((r) => r.series_template_id === templateId && r.warehouse_id && r.sellable > 0),
  [options, templateId]);
  const bestSource = useMemo(() =>
    sourceRows.length ? sourceRows.reduce((a, b) => (b.sellable > a.sellable ? b : a)) : null,
  [sourceRows]);
  const retailWarehouses = useMemo(() => warehouses.filter((w) => w.purpose === "retail" || w.purpose === "mixed"), [warehouses]);
  const chosen = sourceRows.find((r) => r.warehouse_id === sourceWhId) ?? null;
  const countNum = Number(count);
  const validCount = Number.isInteger(countNum) && countNum > 0 && chosen !== null && countNum <= chosen.sellable;

  const steps = ["محصول", "رنگ / سری", "انبار مبدأ", "انبار مقصد", "تعداد و پیش‌نمایش", "تأیید"];

  const submit = async () => {
    if (!chosen || !destWhId || !validCount) return;
    setBusy(true);
    try {
      const res = await retailSuppliesApi.create({
        seriesTemplateId: templateId, sourceWarehouseId: chosen.warehouse_id!, destinationWarehouseId: destWhId,
        seriesCount: countNum, ...(note.trim() ? { note: note.trim() } : {}), idempotencyKey: submissionKey,
      });
      setDoneRef(res.reference);
      flash(`سند ${res.reference} ثبت شد و ${fa(countNum)} سری رزرو شد. ارسال و دریافت از «نقل‌وانتقالات» انجام می‌شود.`);
      await onDone();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت سند تأمین"); }
    finally { setBusy(false); }
  };

  return (
    <WorkspaceModal open onClose={onClose} title="تأمین خرده از عمده">
      <h3 className="mb-1 flex items-center gap-1.5 text-[15px] font-extrabold"><PackageOpen size={16} />تأمین خرده از عمده</h3>
      <p className="mb-3 text-[12px] leading-6 text-[var(--kv-muted)]">
        باز کردن سری کامل از انبار مرکزی عمده و انتقال همهٔ عددهای آن به انبار خرده‌فروشی. انتخاب از سطح محصول شروع می‌شود؛ چیدن تکی تنوع‌ها از عمده ممکن نیست.
      </p>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {steps.map((label, index) => (
          <span key={label} className={cn("rounded-full px-2.5 py-1 text-[10.5px] font-bold",
            index === step ? "bg-[var(--kv-accent)] text-white" : index < step ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-500")}>
            {fa(index + 1)}. {label}
          </span>
        ))}
      </div>

      {options === null ? <LoadingState /> : doneRef ? (
        <div className="space-y-3 text-center">
          <p className="text-[14px] font-extrabold text-emerald-700">سند {doneRef} ثبت شد ✓</p>
          <p className="text-[12px] text-[var(--kv-muted)]">سری‌ها رزرو شدند. ارسال (باز کردن سری) و دریافت در انبار خرده از تب «نقل‌وانتقالات» پیگیری می‌شود.</p>
          <Btn variant="accent" onClick={onClose}>بستن</Btn>
        </div>
      ) : (
        <div className="space-y-4">
          {step === 0 && (
            products.length === 0 ? <Empty title="سری قابل تأمین وجود ندارد" desc="فقط سری‌های شمارش‌شدهٔ مالکیت کلبه قابل تأمین به خرده هستند." /> : (
              <div className="grid gap-2 md:grid-cols-2">
                {products.map((p) => (
                  <button key={p.id} className={cn("rounded-[12px] border p-3 text-right transition-all",
                    productId === p.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)] hover:border-[var(--kv-accent)]/50")}
                    onClick={() => { setProductId(p.id); setTemplateId(""); setSourceWhId(""); }}>
                    <p className="text-[13px] font-bold">{p.name}</p>
                    <p className="mt-1 text-[11px] text-[var(--kv-muted)]">قابل فروش: {fa(p.sellable)} سری</p>
                  </button>
                ))}
              </div>
            )
          )}
          {step === 1 && (
            colorRows.length === 0 ? <Empty title="سری‌ای برای این محصول نیست" desc="ابتدا محصول را انتخاب کنید." /> : (
              <div className="grid gap-2 md:grid-cols-2">
                {colorRows.map((c) => (
                  <button key={c.templateId} className={cn("rounded-[12px] border p-3 text-right transition-all",
                    templateId === c.templateId ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)] hover:border-[var(--kv-accent)]/50")}
                    onClick={() => { setTemplateId(c.templateId); setSourceWhId(""); }}>
                    <p className="text-[13px] font-bold">رنگ {c.color}</p>
                    <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{c.name} — {fa(c.pieces)} عدد در سری — قابل فروش {fa(c.sellable)} سری</p>
                  </button>
                ))}
              </div>
            )
          )}
          {step === 2 && (
            sourceRows.length === 0 ? <Empty title="موجودی قابل فروش نیست" desc="در هیچ انبار عمده‌ای سری قابل فروش (کلبه‌ای) برای این رنگ نیست." /> : (
              <div className="space-y-2">
                {sourceRows.map((r) => (
                  <button key={r.warehouse_id} className={cn("flex w-full items-center justify-between rounded-[12px] border p-3 text-right transition-all",
                    sourceWhId === r.warehouse_id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)] hover:border-[var(--kv-accent)]/50")}
                    onClick={() => setSourceWhId(r.warehouse_id!)}>
                    <span className="text-[13px] font-bold">{r.warehouse_name}{bestSource?.warehouse_id === r.warehouse_id && <span className="mr-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">پیشنهاد (بیشترین موجودی)</span>}</span>
                    <span className="text-[12px] tabular-nums">قابل فروش: <b className="text-emerald-700">{fa(r.sellable)}</b> سری{r.reserved > 0 ? ` (رزرو: ${fa(r.reserved)})` : ""}</span>
                  </button>
                ))}
                <p className="text-[11px] text-[var(--kv-muted)]">رزروشده و آسیب‌دیده از «قابل فروش» کم شده است؛ انتخاب مبدأ همیشه با شماست.</p>
              </div>
            )
          )}
          {step === 3 && (
            retailWarehouses.length === 0 ? <Empty title="انبار خرده‌ای تعریف نشده" desc="در تنظیمات انبار، یک انبار با کاربری خرده‌فروشی مشخص کنید." /> : (
              <div className="grid gap-2 md:grid-cols-2">
                {retailWarehouses.map((w) => (
                  <button key={w.id} className={cn("rounded-[12px] border p-3 text-right transition-all",
                    destWhId === w.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)] hover:border-[var(--kv-accent)]/50")}
                    onClick={() => setDestWhId(w.id)}>
                    <p className="text-[13px] font-bold">{w.name}</p>
                    <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{w.purpose === "mixed" ? "کاربری ترکیبی (قدیمی)" : "انبار خرده‌فروشی"}</p>
                  </button>
                ))}
              </div>
            )
          )}
          {step === 4 && chosen && (
            <div className="space-y-3">
              <Field label={`تعداد سری (قابل فروش در مبدأ: ${fa(chosen.sellable)})`}>
                <Input value={count} onChange={setCount} placeholder="مثلاً ۲" />
              </Field>
              {validCount && (
                <div className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 p-3">
                  <p className="mb-2 text-[12px] font-bold">پیش‌نمایش ترکیب — {fa(countNum)} سری باز می‌شود و همهٔ عددها به خرده می‌رود:</p>
                  <div className="flex flex-wrap gap-2">
                    {(chosen.items ?? []).map((item) => (
                      <span key={item.variant_id} className="rounded-[10px] bg-[var(--kv-surface)] px-2.5 py-1 text-[11.5px] border border-[var(--kv-line)]">
                        {item.size_label ?? "—"} × {fa(item.quantity_per_series * countNum)} عدد
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">جمع: {fa(chosen.pieces_per_series * countNum)} عدد — موجودی عددِ شل در عمده باقی نمی‌ماند.</p>
                </div>
              )}
              <Field label="توضیح (اختیاری)"><Textarea value={note} onChange={setNote} placeholder="مثلاً تأمین ویترین شعبه مرکزی" /></Field>
            </div>
          )}
          {step === 5 && chosen && (
            <div className="rounded-[12px] border border-[var(--kv-line)] p-4 text-[12.5px] leading-7">
              <p><b>محصول:</b> {chosen.product_name} — رنگ {chosen.color_label ?? "—"}</p>
              <p><b>مسیر:</b> {chosen.warehouse_name} ← {retailWarehouses.find((w) => w.id === destWhId)?.name}</p>
              <p><b>تعداد:</b> {fa(countNum)} سری کامل = {fa(chosen.pieces_per_series * countNum)} عدد</p>
              <p className="mt-1 text-[11.5px] text-amber-800">با تأیید، سری‌ها رزرو می‌شوند و سند SUP واقعی ساخته می‌شود؛ باز کردن سری هنگام «ارسال» رخ می‌دهد و پس از آن لغو خودکار ممکن نیست.</p>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-[var(--kv-line)] pt-3">
            {step > 0 && <Btn variant="soft" onClick={() => setStep((s) => s - 1)}>مرحله قبل</Btn>}
            {step < 5 && (
              <Btn variant="accent"
                disabled={(step === 0 && !productId) || (step === 1 && !templateId) || (step === 2 && !sourceWhId) || (step === 3 && !destWhId) || (step === 4 && !validCount)}
                onClick={() => setStep((s) => s + 1)}>مرحله بعد</Btn>
            )}
            {step === 5 && <Btn variant="accent" disabled={busy} onClick={() => void submit()}>تأیید و رزرو</Btn>}
            <Btn variant="ghost" onClick={onClose}>انصراف</Btn>
          </div>
        </div>
      )}
    </WorkspaceModal>
  );
}

function SeriesHistoryDrawer({ row, onClose }: { row: SeriesStockRow; onClose: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof seriesInventoryApi.movements>>["items"] | null>(null);
  useEffect(() => {
    seriesInventoryApi.movements({ seriesTemplateId: row.series_template_id, limit: 100 })
      .then((res) => setItems(res.items)).catch(() => setItems([]));
  }, [row.series_template_id]);
  return (
    <WorkspaceModal open onClose={onClose} title={`تاریخچه سری — ${row.product_name}`}>
      <div className="p-5">
        {items === null ? <LoadingState /> : items.length === 0 ? (
          <Empty title="حرکتی ثبت نشده" desc="رزرو، شمارش، باز کردن سری و دریافت‌ها اینجا ثبت می‌شوند." />
        ) : (
          <ol className="space-y-2">
            {items.map((m) => (
              <li key={m.id} className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b>{SERIES_MOVE_LABEL[m.movement_type] ?? m.movement_type}</b>
                  <span className={cn("tabular-nums font-bold", m.quantity > 0 ? "text-emerald-700" : "text-red-600")}>{m.quantity > 0 ? `+${fa(m.quantity)}` : `−${fa(Math.abs(m.quantity))}`} سری</span>
                </div>
                <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{m.warehouse_name} · {m.actor_name ?? "سیستم"} · {formatPersianDateTimeFull(m.created_at)}</p>
                {m.note && <p className="mt-1 text-[11.5px]">{m.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </WorkspaceModal>
  );
}

const SUPPLY_BADGE: Record<string, { label: string; cls: string }> = {
  reserved: { label: "رزروشده", cls: "bg-amber-100 text-amber-800" },
  dispatched: { label: "در راه (سری باز شد)", cls: "bg-sky-100 text-sky-800" },
  received: { label: "تکمیل‌شده", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};
const SUPPLY_EVENT_LABEL: Record<string, string> = {
  created: "ثبت سند و رزرو سری", dispatched: "باز کردن سری و ارسال", received: "دریافت در انبار خرده", cancelled: "لغو سند",
};

/** §16/§17: unified «تأمین خرده از عمده» history + real-event timeline + lifecycle actions. */
export function SupplyOpsPanel({ flash, status }: { flash: F; status?: "" | "reserved" | "dispatched" | "received" | "cancelled" }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof retailSuppliesApi.list>>["items"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [timelineFor, setTimelineFor] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res = await retailSuppliesApi.list({ limit: 100, ...(status ? { status } : {}), ...(search.trim() ? { search: search.trim() } : {}) });
      setRows(res.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری اسناد تأمین"); }
  }, [status, search]);
  useEffect(() => { void reload(); }, [reload]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); flash(ok); await reload(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در عملیات"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--kv-border)] p-3">
        <h3 className="flex items-center gap-1.5 text-[14px] font-extrabold"><PackageOpen size={15} />تأمین خرده از عمده (باز کردن سری)</h3>
        <div className="flex items-center gap-2">
          <SearchBox placeholder="شماره سند یا محصول…" value={search} onChange={setSearch} />
          <Btn size="sm" variant="accent" onClick={() => setWizardOpen(true)}>+ تأمین جدید</Btn>
        </div>
      </div>
      {rows.length === 0 ? (
        <Empty title="سند تأمینی نیست" desc="با «+ تأمین جدید»، سری کامل از انبار عمده برای خرده‌فروشی رزرو کنید." />
      ) : (
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[920px] text-[12.5px]">
            <thead><tr><th>سند</th><th>محصول / رنگ</th><th>مسیر</th><th>سری</th><th>عدد</th><th>وضعیت</th><th>ثبت</th><th>عملیات</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className="font-bold" dir="ltr">{s.reference}</td>
                  <td>{s.product_name}{s.color_label ? <span className="mr-1 text-[11px] text-[var(--kv-muted)]">({s.color_label})</span> : null}</td>
                  <td className="text-[11.5px]">{s.source_warehouse_name} ← {s.destination_warehouse_name}</td>
                  <td className="tabular-nums font-bold">{fa(s.series_count)}</td>
                  <td className="tabular-nums">{fa(s.pieces_total)}</td>
                  <td><span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", SUPPLY_BADGE[s.status]?.cls)}>{SUPPLY_BADGE[s.status]?.label ?? s.status}</span></td>
                  <td className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(s.created_at)}</td>
                  <td className="whitespace-nowrap space-x-2 space-x-reverse">
                    {s.status === "reserved" && (<>
                      <button className="text-[11.5px] font-bold text-[var(--kv-accent)]" disabled={busy}
                        onClick={() => void act(() => retailSuppliesApi.dispatch(s.id), "سری باز شد؛ عددها به سمت انبار خرده در راه‌اند.")}>ارسال (باز کردن سری)</button>
                      <button className="text-[11.5px] font-bold text-red-500" disabled={busy}
                        onClick={() => void act(() => retailSuppliesApi.cancel(s.id), "سند لغو و رزرو آزاد شد.")}>لغو</button>
                    </>)}
                    {s.status === "dispatched" && (
                      <button className="text-[11.5px] font-bold text-emerald-600" disabled={busy}
                        onClick={() => void act(() => retailSuppliesApi.receive(s.id), "عددها در انبار خرده دریافت و قابل فروش شدند.")}>دریافت در خرده</button>
                    )}
                    <button className="text-[11.5px] font-bold text-[var(--kv-muted)]" onClick={() => setTimelineFor(s.id)}>تایم‌لاین</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {timelineFor && <SupplyTimelineDrawer id={timelineFor} onClose={() => setTimelineFor(null)} />}
      {wizardOpen && <SupplyWizard flash={flash} onClose={() => setWizardOpen(false)} onDone={async () => { await reload(); }} />}
    </Card>
  );
}

function SupplyTimelineDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof retailSuppliesApi.detail>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    retailSuppliesApi.detail(id).then(setDetail).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, [id]);
  return (
    <WorkspaceModal open onClose={onClose} title={`تایم‌لاین سند ${detail?.reference ?? ""}`}>
      <div className="space-y-4 p-5">
        {error ? <ErrorState message={error} onRetry={() => undefined} /> : detail === null ? <LoadingState /> : (<>
          <Card className="p-4 text-[12.5px] leading-7">
            <p><b>{detail.product_name}</b>{detail.color_label ? ` — رنگ ${detail.color_label}` : ""}</p>
            <p>{detail.source_warehouse_name} ← {detail.destination_warehouse_name} · {fa(detail.series_count)} سری = {fa(detail.pieces_total)} عدد</p>
            <p className="text-[11.5px] text-[var(--kv-muted)]">ترکیب ثبت‌شده در سند (تغییر بعدی دستور ساخت روی این سند بی‌اثر است):</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {detail.recipe_snapshot.items.map((item) => (
                <span key={item.sku} className="rounded-[9px] border border-[var(--kv-line)] px-2 py-0.5 text-[11px]">
                  {item.sizeLabel ?? "—"} × {fa(item.quantityPerSeries * detail.series_count)}
                </span>
              ))}
            </div>
          </Card>
          <ol className="relative space-y-3 border-r-2 border-[var(--kv-line)] pr-4">
            {detail.events.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute -right-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-[var(--kv-accent)]" />
                <p className="text-[12.5px] font-bold">{SUPPLY_EVENT_LABEL[e.event_type] ?? e.event_type}</p>
                <p className="text-[11.5px] text-[var(--kv-muted)]">{e.actor_name ?? "سیستم"} · {formatPersianDateTimeFull(e.created_at)}</p>
                {e.note && <p className="mt-0.5 text-[11.5px]">{e.note}</p>}
              </li>
            ))}
          </ol>
        </>)}
      </div>
    </WorkspaceModal>
  );
}
