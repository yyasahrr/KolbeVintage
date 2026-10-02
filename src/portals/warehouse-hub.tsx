import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketplaceReviewPanel } from "../components/marketplace-review-panel";
import { CatalogHub } from "../components/catalog-hub";
import { ArrowLeftRight, ChevronDown, ChevronLeft, ClipboardCheck, RotateCcw, Settings, Store, Truck } from "lucide-react";
import { Btn, Card, Checkbox, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, Select, Textarea } from "../components/primitives";
import { inventoryApi, manualSalesApi, productsApi, serverRequest, supplierRequestsApi, type ManualSaleCreate } from "../data/api";
import { AdminServerOrders } from "./admin-server-orders";
import { CHANNEL_LABEL } from "../components/manual-sales-panel";
import { SeriesStockPanel, SupplyOpsPanel, SupplyWizard } from "../components/series-stock-panel";
import { WarehouseSettings, type LowStock } from "../components/warehouse-settings";
import { adjustmentPreview, pendingForRows } from "../data/warehouse-ux";
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
  retail_enabled: boolean; variant_sale_enabled?: boolean; effective_retail_sellable?: boolean;
  sale_status?: "active" | "paused" | "variant_paused" | "archived"; product_status: string;
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
  id: string; reference: string; warehouse_id: string; variant_id: string | null; quantity: number | null; status: string;
  inventory_domain: string; received_quantity: number | null; missing_quantity: number; batch_reference: string | null;
  supplier_request_id: string | null; created_at: string;
};
type RequestRow = {
  id: string; request_number: string; supplier_name: string; status: string; item_count: number;
  total_quantity: number; rejection_reason: string | null; revision_note: string | null; created_at: string;
};

type F = (msg: string) => void;

/**
 * §3: «انبار و نقل‌وانتقالات» — the single warehouse hub.
 * Exactly FOUR primary tabs: retail inventory / transfers (incl. reverse) /
 * wholesale (inventory, supplier requests, inbound & QC) / warehouse settings.
 * Settings is configuration-only (§4); operations stay in their domain tabs.
 */
export function WarehouseHub({ flash, initial }: { flash: F; initial?: string | null }) {
  // §2 deep link: legacy wproducts/mreview routes land on انبار عمده → محصولات و بازبینی.
  const [tab, setTab] = useState<"goods" | "retail" | "transfers" | "wholesale" | "settings">(initial === "wholesale-review" ? "wholesale" : "goods");
  useEffect(() => { if (initial === "wholesale-review") setTab("wholesale"); }, [initial]);
  const [lowStockReport, setLowStockReport] = useState<LowStock[] | null>(null);
  return (
    <div className="animate-[fadeUp_0.35s_ease] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          options={[
            { v: "goods", label: "کالاها" },
            { v: "retail", label: "خرده‌فروشی" },
            { v: "transfers", label: "نقل‌وانتقالات" },
            { v: "wholesale", label: "انبار عمده" },
            { v: "settings", label: "تنظیمات انبار" },
          ]}
          value={tab} onChange={setTab}
        />
      </div>
      {/* §14: کالاها = single home of product definition + lifecycle (تعریف/نیازمند راه‌اندازی/بازبینی/همه/آرشیو). */}
      {tab === "goods" && <CatalogHub flash={flash} />}
      {tab === "retail" && <RetailInventoryTab flash={flash} />}
      {tab === "transfers" && <TransfersOpsCenter flash={flash} />}
      {tab === "wholesale" && <WholesaleCenter flash={flash} initialSub={initial === "wholesale-review" ? "review" : undefined} />}
      {tab === "settings" && (
        <Card className="p-4">
          <div className="mb-4 flex items-center gap-2 border-b border-[var(--kv-line)] pb-3">
            <Settings size={16} />
            <div>
              <h2 className="text-sm font-bold">تنظیمات انبار</h2>
              <p className="text-[11.5px] text-[var(--kv-muted)]">فقط پیکربندی — عملیات موجودی (رسید، اصلاح، انتقال، فروش) در تب‌های عملیاتی انجام می‌شود.</p>
            </div>
          </div>
          <WarehouseSettings onReport={(rows) => setLowStockReport(rows)} />
        </Card>
      )}
      {lowStockReport && <Modal open title="گزارش موجودی کم — همه انبارها و دامنه‌ها" onClose={() => setLowStockReport(null)}><div className="overflow-x-auto p-4"><p className="text-xs text-[var(--kv-muted)]">حداکثر ۵۰ قلم با کمترین موجودی</p><table className="kv-table w-full text-xs"><thead><tr><th>کد کالا</th><th>انبار</th><th>دامنه</th><th>قابل فروش</th></tr></thead><tbody>{lowStockReport.map((item) => <tr key={`${item.variant_id}-${item.warehouse_id}-${item.inventory_domain}`}><td dir="ltr">{item.sku}</td><td>{item.warehouse_name}</td><td>{item.inventory_domain === "retail" ? "خرده" : "عمده"}</td><td>{fa(item.available)}</td></tr>)}</tbody></table>{!lowStockReport.length && <p className="text-sm">موجودی کم یافت نشد.</p>}</div></Modal>}
    </div>
  );
}

/* ------------------------------ inventory tables (C1/C3, L/M, O) ------------------------------ */

/** §9/§20: retail replenishment starts at Product level via «تأمین از عمده» — direct receipt is no longer the normal path. */
function RetailInventoryTab({ flash }: { flash: F }) {
  const [wizardOpen, setWizardOpen] = useState(false);
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
        <p className="text-[12px] leading-6 text-[var(--kv-muted)]">
          تأمین موجودی خرده از انبار مرکزی عمده انجام می‌شود (باز کردن سری کامل). «اصلاح موجودی» فقط برای اصلاح/مرجوعی است.
        </p>
        <Btn size="sm" variant="accent" onClick={() => setWizardOpen(true)}>تأمین از عمده</Btn>
      </Card>
      <DomainInventory domain="retail" flash={flash} />
      {wizardOpen && <SupplyWizard flash={flash} onClose={() => setWizardOpen(false)} onDone={async () => undefined} />}
    </div>
  );
}

/** §7/§43: series view is the PRIMARY wholesale representation; piece view stays as advanced detail. */
function WholesaleInventoryTab({ flash }: { flash: F }) {
  const [view, setView] = useState<"series" | "pieces">("series");
  return (
    <div className="space-y-4">
      <Segmented options={[{ v: "series", label: "موجودی سری (اصلی)" }, { v: "pieces", label: "اجزای عددی (پیشرفته)" }]} value={view} onChange={setView} />
      {view === "series" && <SeriesStockPanel flash={flash} />}
      {view === "pieces" && (
        <div className="space-y-2">
          <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[11.5px] leading-6 text-amber-800">
            این نما فقط اجزای عددیِ همان سری‌هاست (برای ممیزی)؛ واحد فروش و تأمین در عمده همیشه «سری» است.
          </p>
          <DomainInventory domain="wholesale" flash={flash} />
        </div>
      )}
    </div>
  );
}

type OpsView = "all" | "supply" | "transfer" | "in_transit" | "needs_receive" | "done" | "cancelled";
/** §16: transfers tab = operations center — unified views over supplies + inter-warehouse transfers. */
function TransfersOpsCenter({ flash }: { flash: F }) {
  const [view, setView] = useState<OpsView>("all");
  const views: { v: OpsView; label: string }[] = [
    { v: "all", label: "همه" },
    { v: "supply", label: "تأمین خرده از عمده" },
    { v: "transfer", label: "انتقال بین انبارها" },
    { v: "in_transit", label: "در راه" },
    { v: "needs_receive", label: "نیازمند دریافت" },
    { v: "done", label: "تکمیل‌شده" },
    { v: "cancelled", label: "لغوشده" },
  ];
  const supplyStatus: "" | "reserved" | "dispatched" | "received" | "cancelled" =
    view === "in_transit" || view === "needs_receive" ? "dispatched"
      : view === "done" ? "received" : view === "cancelled" ? "cancelled" : "";
  const transferStatuses: string[] | undefined =
    view === "in_transit" ? ["approved", "in_transit"]
      : view === "needs_receive" ? ["in_transit"]
        : view === "done" ? ["completed"] : view === "cancelled" ? ["cancelled"] : undefined;
  const showSupplies = view !== "transfer";
  const showTransfers = view !== "supply";
  return (
    <div className="space-y-4">
      <Segmented options={views} value={view} onChange={setView} />
      {showSupplies && <SupplyOpsPanel flash={flash} status={supplyStatus} />}
      {showTransfers && <TransfersCenter flash={flash} statusFilter={transferStatuses} hideCreate={view !== "all" && view !== "transfer"} />}
      {(view === "all" || view === "transfer") && (
        <AdminServerOrders request={serverRequest} only="inventory-transfers" />
      )}
    </div>
  );
}

function DomainInventory({ domain, flash }: { domain: "retail" | "wholesale"; flash: F }) {
  const [rows, setRows] = useState<InvRow[] | null>(null);
  const [pendingReceipts, setPendingReceipts] = useState<ReceiptRow[]>([]);
  const reloadSequence = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [receiptFor, setReceiptFor] = useState<InvRow | null>(null);
  const [pendingSelection, setPendingSelection] = useState<{ receipts: ReceiptRow[]; rows: InvRow[] } | null>(null);
  const [receiveFor, setReceiveFor] = useState<{ receipt: ReceiptRow; row: InvRow } | null>(null);
  const [archiveFor, setArchiveFor] = useState<InvRow | null>(null);
  const [detailFor, setDetailFor] = useState<InvRow | null>(null);
  const [saleFor, setSaleFor] = useState<InvRow | null>(null);
  const [adjustFor, setAdjustFor] = useState<InvRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ on_hand: number; reserved: number; incoming: number; damaged: number; available: number } | null>(null);
  // §6: server-backed filters — every change goes back to the API, no client-side dataset filtering.
  const [filters, setFilters] = useState({ warehouseId: "", stockStatus: "", saleStatus: "", color: "", size: "", hasIncoming: false, hasReservation: false });
  const [warehouses, setWarehouses] = useState<{ id: string; code: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  // §10: selection keys = `${variant_id}|${warehouse_id}` so bulk ops stay variant-level.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState<null | "adjust" | "transfer">(null);
  const [bulkResults, setBulkResults] = useState<{ title: string; items: { label: string; ok: boolean; error?: string }[] } | null>(null);

  const serverParams = useCallback((limit: number, offset: number) => {
    const params: Record<string, string | number> = { inventoryDomain: domain, limit, offset, withTotal: 1 };
    if (search.trim()) params.search = search.trim();
    if (lowOnly) params.lowStock = 5;
    if (filters.warehouseId) params.warehouseId = filters.warehouseId;
    if (filters.stockStatus) params.stockStatus = filters.stockStatus;
    if (filters.saleStatus) params.saleStatus = filters.saleStatus;
    if (filters.color.trim()) params.colorLabel = filters.color.trim();
    if (filters.size.trim()) params.sizeLabel = filters.size.trim();
    if (filters.hasIncoming) params.hasIncoming = 1;
    if (filters.hasReservation) params.hasReservation = 1;
    return params;
  }, [domain, search, lowOnly, filters]);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    setError(null);
    try {
      const [res, pending, kpi] = await Promise.all([
        inventoryApi.balances(serverParams(100, 0)),
        inventoryApi.pendingReceipts({ inventoryDomain: domain }),
        inventoryApi.summary({ inventoryDomain: domain }).catch(() => null),
      ]);
      if (sequence === reloadSequence.current) {
        setRows(res.items as InvRow[]);
        setTotal(Number((res as { total?: number }).total ?? (res.items as unknown[]).length));
        setPendingReceipts(pending.items as ReceiptRow[]);
        setSummary(kpi);
      }
    } catch (e) { if (sequence === reloadSequence.current) setError(e instanceof Error ? e.message : "خطا در بارگذاری موجودی"); }
  }, [domain, serverParams]);
  useEffect(() => { void reload(); return () => { reloadSequence.current++; }; }, [reload]);
  useEffect(() => { setSelectedKeys(new Set()); }, [domain, search, lowOnly, filters]);
  useEffect(() => {
    inventoryApi.warehouses().then((res) => setWarehouses(res.items)).catch(() => setWarehouses([]));
  }, []);

  const loadMore = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      const res = await inventoryApi.balances(serverParams(100, rows.length));
      setRows([...rows, ...(res.items as InvRow[])]);
      setTotal(Number((res as { total?: number }).total ?? total));
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری موارد بیشتر"); }
    finally { setBusy(false); }
  };

  const rowKey = (row: InvRow) => `${row.variant_id}|${row.warehouse_id}`;
  const selectedRows = useMemo(() => (rows ?? []).filter((row) => selectedKeys.has(rowKey(row))), [rows, selectedKeys]);
  const toggleKeys = (keys: string[], on: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      for (const key of keys) { if (on) next.add(key); else next.delete(key); }
      return next;
    });
  };
  const runBulkSale = async (enable: boolean) => {
    const productIds = [...new Set(selectedRows.map((row) => row.product_id))];
    if (!productIds.length) return;
    setBusy(true);
    try {
      const res = await productsApi.bulkSaleStatus({ productIds, enabled: enable });
      setBulkResults({
        title: enable ? "نتیجه فعال‌سازی فروش گروهی" : "نتیجه توقف فروش گروهی",
        items: res.results.map((item) => ({ label: item.name ?? item.productId, ok: item.ok, error: item.error })),
      });
      setSelectedKeys(new Set());
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در عملیات گروهی"); }
    finally { setBusy(false); }
  };
  const runBulkArchive = async () => {
    const productIds = [...new Set(selectedRows.map((row) => row.product_id))];
    if (!productIds.length) return;
    setBusy(true);
    try {
      const res = await productsApi.bulkArchive({ productIds });
      setBulkResults({
        title: "نتیجه آرشیو گروهی (موجودی و تاریخچه حفظ می‌شود)",
        items: res.results.map((item) => ({ label: item.name ?? item.productId, ok: item.ok, error: item.error })),
      });
      setSelectedKeys(new Set());
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در آرشیو گروهی"); }
    finally { setBusy(false); }
  };

  // L/M: product-centric expandable grouping (product → variants).
  const groups = useMemo(() => {
    const map = new Map<string, { product: InvRow; rows: InvRow[] }>();
    for (const row of rows ?? []) {
      const g = map.get(row.product_id);
      if (g) g.rows.push(row); else map.set(row.product_id, { product: row, rows: [row] });
    }
    return [...map.values()];
  }, [rows]);

  // §28: sale status needs an EXPLICIT scope — متوقف کردن یک تنوع هرگز کل محصول را نمی‌بندد.
  const [saleScopeFor, setSaleScopeFor] = useState<{ row: InvRow; productLevel: boolean } | null>(null);

  const openIncoming = async (targetRows: InvRow[]) => {
    setBusy(true);
    try {
      const receipts = (await Promise.all(targetRows.map((row) => inventoryApi.pendingReceipts({
        variantId: row.variant_id, warehouseId: row.warehouse_id, inventoryDomain: domain,
      })))).flatMap((result) => result.items) as ReceiptRow[];
      const matching = [...new Map(pendingForRows(receipts, targetRows).map((receipt) => [receipt.id, receipt])).values()];
      if (!matching.length) { flash("رسید در انتظار دریافت یافت نشد؛ ورودی ممکن است مربوط به انتقال باشد. نقل‌وانتقالات را بررسی کنید."); await reload(); }
      else if (matching.length === 1) {
        const receipt = matching[0]!;
        setReceiveFor({ receipt, row: targetRows.find((row) => row.variant_id === receipt.variant_id && row.warehouse_id === receipt.warehouse_id)! });
      } else setPendingSelection({ receipts: matching, rows: targetRows });
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری رسیدهای در انتظار"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  return (
    <Card className="overflow-hidden">
      {summary && (
        <div className="grid grid-cols-2 gap-2 border-b border-[var(--kv-border)] p-3 sm:grid-cols-5" aria-label="شاخص‌های موجودی">
          {([
            ["موجودی فیزیکی", summary.on_hand, ""],
            ["رزرو شده", summary.reserved, "text-amber-700"],
            ["در راه", summary.incoming, "text-sky-700"],
            ["آسیب‌دیده", summary.damaged, "text-red-700"],
            ["قابل فروش", summary.available, "text-emerald-700"],
          ] as const).map(([label, value, tone]) => (
            <div key={label} className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-3 py-2">
              <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
              <p className={`text-base font-bold tabular-nums ${tone}`}>{fa(value)}</p>
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2 border-b border-[var(--kv-border)] p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="min-w-[220px] flex-1">
            <SearchBox value={search} onChange={setSearch} placeholder="جست‌وجو بر اساس نام، SKU، رنگ یا سایز…" />
          </div>
          <Checkbox checked={lowOnly} onChange={setLowOnly} label={<span className="text-[12px]">فقط موجودی کم</span>} />
        </div>
        <div className="flex flex-wrap items-end gap-2 text-[11.5px]">
          <label className="block">انبار
            <select aria-label="فیلتر انبار" value={filters.warehouseId} onChange={(e) => setFilters({ ...filters, warehouseId: e.target.value })} className="mt-1 block rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">
              <option value="">همه انبارها</option>
              {warehouses.map((wh) => <option key={wh.id} value={wh.id}>{wh.name}</option>)}
            </select>
          </label>
          <label className="block">وضعیت موجودی
            <select aria-label="فیلتر وضعیت موجودی" value={filters.stockStatus} onChange={(e) => setFilters({ ...filters, stockStatus: e.target.value })} className="mt-1 block rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">
              <option value="">همه</option><option value="in_stock">موجود</option><option value="low_stock">رو به اتمام</option>
              <option value="out_of_stock">ناموجود</option><option value="incoming">در راه</option><option value="fully_reserved">کاملاً رزرو</option>
            </select>
          </label>
          {domain === "retail" && (
            <label className="block">وضعیت فروش
              <select aria-label="فیلتر وضعیت فروش" value={filters.saleStatus} onChange={(e) => setFilters({ ...filters, saleStatus: e.target.value })} className="mt-1 block rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">
                <option value="">همه</option><option value="active">فعال</option><option value="paused">فروش متوقف</option><option value="archived">آرشیو</option>
              </select>
            </label>
          )}
          <label className="block">رنگ
            <input aria-label="فیلتر رنگ" value={filters.color} onChange={(e) => setFilters({ ...filters, color: e.target.value })} className="mt-1 block w-24 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2" />
          </label>
          <label className="block">سایز
            <input aria-label="فیلتر سایز" value={filters.size} onChange={(e) => setFilters({ ...filters, size: e.target.value })} className="mt-1 block w-20 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2" />
          </label>
          <Checkbox checked={filters.hasIncoming} onChange={(v) => setFilters({ ...filters, hasIncoming: v })} label={<span className="text-[11.5px]">دارای «در راه»</span>} />
          <Checkbox checked={filters.hasReservation} onChange={(v) => setFilters({ ...filters, hasReservation: v })} label={<span className="text-[11.5px]">دارای رزرو</span>} />
          <span className="mr-auto text-[11px] text-[var(--kv-muted)]">{fa(total)} ردیف مطابق فیلتر (سمت سرور)</span>
        </div>
      </div>
      {selectedKeys.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--kv-line)] bg-[var(--kv-surface)] p-2.5 shadow-sm" role="toolbar" aria-label="عملیات گروهی">
          <b className="text-[12.5px]">{fa(selectedKeys.size)} مورد انتخاب شده</b>
          {domain === "retail" && <Btn size="sm" variant="soft" disabled={busy} onClick={() => void runBulkSale(true)}>فعال‌سازی فروش</Btn>}
          {domain === "retail" && <Btn size="sm" variant="soft" disabled={busy} onClick={() => void runBulkSale(false)}>توقف فروش</Btn>}
          <Btn size="sm" variant="soft" disabled={busy} onClick={() => setBulkModal("adjust")}>اصلاح گروهی</Btn>
          <Btn size="sm" variant="soft" disabled={busy} onClick={() => setBulkModal("transfer")}>انتقال گروهی</Btn>
          {domain === "retail" && <Btn size="sm" variant="soft" className="text-[var(--kv-danger)]" disabled={busy} onClick={() => void runBulkArchive()}>آرشیو امن</Btn>}
          <Btn size="sm" variant="soft" disabled={busy} onClick={() => setSelectedKeys(new Set())}>لغو انتخاب</Btn>
        </div>
      )}
      {groups.length === 0 ? <Empty title="موجودی یافت نشد" desc="برای این دامنه هنوز موجودی ثبت نشده است." /> : (
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[900px] text-[12.5px]">
            <thead><tr>
              <th>
                <input type="checkbox" aria-label="انتخاب همه ردیف‌های این صفحه"
                  checked={(rows?.length ?? 0) > 0 && (rows ?? []).every((row) => selectedKeys.has(rowKey(row)))}
                  onChange={(e) => toggleKeys((rows ?? []).map(rowKey), e.target.checked)} />
              </th>
              <th></th><th>محصول / تنوع</th><th>انبار</th>
              {domain === "wholesale" && <th>مالکیت</th>}
              <th>موجودی فیزیکی</th><th>در راه</th><th>رزرو</th><th>قابل فروش</th>
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
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" aria-label={`انتخاب همه تنوع‌های ${product.product_name}`}
                            checked={vRows.every((row) => selectedKeys.has(rowKey(row)))}
                            onChange={(e) => toggleKeys(vRows.map(rowKey), e.target.checked)} />
                        </td>
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
                          <div className="flex flex-wrap gap-2">
                            {sum.incoming > 0 && <Btn size="sm" variant="soft" disabled={busy} onClick={() => void openIncoming(vRows)}>دریافت کالا</Btn>}
                            <select aria-label={`عملیات ${product.product_name}`} value="" disabled={busy} className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2 text-xs" onChange={(e) => {
                              if (e.target.value === "details") setExpanded(new Set(expanded).add(product.product_id));
                              if (e.target.value === "sale") setSaleScopeFor({ row: product, productLevel: true });
                              if (e.target.value === "archive") setArchiveFor(product);
                            }}>
                              <option value="">عملیات ▾</option><option value="details">مشاهده جزئیات</option>
                              {domain === "retail" && product.product_status !== "archived" && <option value="sale">وضعیت فروش…</option>}
                              {domain === "retail" && product.product_status !== "archived" && <option value="archive">آرشیو محصول…</option>}
                            </select>
                          </div>
                        </td>
                      </tr>
                    }
                    body={open ? vRows.map((row) => (
                      <tr key={`${row.variant_id}-${row.warehouse_id}`}>
                        <td>
                          <input type="checkbox" aria-label={`انتخاب ${row.sku}`}
                            checked={selectedKeys.has(rowKey(row))}
                            onChange={(e) => toggleKeys([rowKey(row)], e.target.checked)} />
                        </td>
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
                        {domain === "retail" && <td><span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", row.sale_status === "active" ? "bg-emerald-100 text-emerald-800" : row.sale_status === "variant_paused" ? "bg-amber-100 text-amber-800" : "bg-gray-200 text-gray-600")}>{row.sale_status === "archived" || row.product_status === "archived" ? "آرشیو" : row.sale_status === "variant_paused" ? "توقف این تنوع" : row.sale_status === "paused" || !row.retail_enabled ? "فروش متوقف (محصول)" : "فعال"}</span></td>}
                        <td>
                          <div className="flex flex-wrap gap-2">
                            {row.incoming > 0 && <Btn size="sm" variant="soft" disabled={busy} onClick={() => void openIncoming([row])}>دریافت کالا</Btn>}
                            <select aria-label={`عملیات ${row.sku}`} value="" disabled={busy} className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2 text-xs" onChange={(e) => {
                              if (e.target.value === "details") setDetailFor(row);
                              if (e.target.value === "receipt") setReceiptFor(row);
                              if (e.target.value === "manual") setSaleFor(row);
                              if (e.target.value === "adjust") setAdjustFor(row);
                              if (e.target.value === "receive") void openIncoming([row]);
                              if (e.target.value === "sale") setSaleScopeFor({ row, productLevel: false });
                              if (e.target.value === "archive") setArchiveFor(row);
                            }}>
                              <option value="">عملیات ▾</option><option value="details">مشاهده جزئیات</option>
                              {domain === "wholesale" && <option value="receipt">ورود کالا</option>}
                              {domain === "retail" && <option value="manual">ثبت فروش دستی</option>}
                              <option value="adjust">اصلاح موجودی</option>
                              {row.incoming > 0 && pendingForRows(pendingReceipts, [row]).length > 0 && <option value="receive">دریافت کالای در راه</option>}
                              {domain === "retail" && row.product_status !== "archived" && <option value="sale">وضعیت فروش…</option>}
                              {domain === "retail" && row.product_status !== "archived" && <option value="archive">آرشیو محصول…</option>}
                            </select>
                          </div>
                        </td>
                      </tr>
                    )) : null}
                  />
                );
              })}
            </tbody>
          </table>
          {rows.length < total && (
            <div className="border-t border-[var(--kv-line)] p-3">
              <Btn size="sm" variant="soft" disabled={busy} onClick={() => void loadMore()}>نمایش موارد بیشتر ({fa(rows.length)} از {fa(total)})</Btn>
            </div>
          )}
        </div>
      )}

      {bulkModal === "adjust" && selectedRows.length > 0 && (
        <BulkAdjustModal rows={selectedRows} domain={domain} flash={flash}
          onClose={() => setBulkModal(null)}
          onDone={async (report) => { setBulkModal(null); setBulkResults(report); setSelectedKeys(new Set()); await reload(); }} />
      )}
      {bulkModal === "transfer" && selectedRows.length > 0 && (
        <BulkTransferModal rows={selectedRows} domain={domain} warehouses={warehouses} flash={flash}
          onClose={() => setBulkModal(null)}
          onDone={async (report) => { setBulkModal(null); setBulkResults(report); setSelectedKeys(new Set()); await reload(); }} />
      )}
      {bulkResults && (
        <Modal open title={bulkResults.title} onClose={() => setBulkResults(null)}>
          <div className="max-h-[70vh] space-y-2 overflow-y-auto p-4">
            <p className="text-sm font-bold">
              {fa(bulkResults.items.filter((item) => item.ok).length)} مورد موفق · {fa(bulkResults.items.filter((item) => !item.ok).length)} مورد ناموفق
            </p>
            <ul className="space-y-1.5 text-[12.5px]">
              {bulkResults.items.map((item, index) => (
                <li key={index} className={cn("flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2", item.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50")}>
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.ok ? <span className="text-[11px] font-bold text-emerald-700">انجام شد</span> : <span className="text-[11px] font-bold text-red-700">{item.error ?? "ناموفق"}</span>}
                </li>
              ))}
            </ul>
          </div>
        </Modal>
      )}

      {archiveFor && <Modal open title="آرشیو محصول" onClose={() => { if (!busy) setArchiveFor(null); }}><div className="space-y-3 p-4"><p className="text-sm leading-7">آرشیو «{archiveFor.product_name}» برای همه تنوع‌های این محصول اعمال می‌شود. موجودی و تاریخچه گردش حفظ می‌شوند.</p><div className="flex gap-2"><Btn size="sm" variant="soft" disabled={busy} onClick={() => setArchiveFor(null)}>انصراف</Btn><Btn size="sm" variant="soft" className="text-[var(--kv-danger)]" disabled={busy} onClick={async () => { setBusy(true); try { await productsApi.status(archiveFor.product_id, "archived"); setArchiveFor(null); flash("محصول آرشیو شد؛ موجودی و تاریخچه حفظ شدند."); await reload(); } catch (e) { flash(e instanceof Error ? e.message : "خطا در آرشیو محصول"); } finally { setBusy(false); } }}>آرشیو محصول</Btn></div></div></Modal>}
      {detailFor && <Modal open title="جزئیات موجودی" onClose={() => setDetailFor(null)}><div className="space-y-2 p-4"><InventoryContext row={detailFor} /><p>موجودی: {fa(detailFor.on_hand)} · رزرو: {fa(detailFor.reserved)} · آسیب‌دیده: {fa(detailFor.damaged)} · قابل فروش: {fa(detailFor.available)}</p><Badge map={STOCK_BADGE} value={detailFor.stock_status} /></div></Modal>}
      {pendingSelection && <Modal open title="رسیدهای در انتظار" onClose={() => setPendingSelection(null)}>
        <div className="max-h-[75vh] space-y-2 overflow-y-auto p-4"><h3 className="text-base font-bold">رسیدهای در انتظار</h3><p className="text-sm text-[var(--kv-muted)]">یک رسید را برای دریافت انتخاب کنید.</p>
          {pendingSelection.receipts.map((receipt) => {
            const row = pendingSelection.rows.find((item) => item.variant_id === receipt.variant_id && item.warehouse_id === receipt.warehouse_id)!;
            return <button key={receipt.id} className="flex w-full flex-wrap justify-between gap-2 rounded-lg border border-[var(--kv-line)] p-3 text-sm hover:bg-[var(--kv-surface-2)] focus-visible:outline-2" onClick={() => { setReceiveFor({ receipt, row }); setPendingSelection(null); }}>
              <span dir="ltr">{receipt.reference}</span><span>{row.color_label} / {row.size_label} · {row.warehouse_name}</span><span>+{fa(receipt.quantity ?? 0)}</span><span dir="ltr">{receipt.batch_reference ?? "—"}</span>
            </button>;
          })}
        </div>
      </Modal>}
      {receiveFor && <ReceiveModal receipt={receiveFor.receipt} row={receiveFor.row} onClose={() => setReceiveFor(null)} onDone={async () => { setReceiveFor(null); await reload(); }} flash={flash} />}

      {receiptFor && <ReceiptModal row={receiptFor} domain={domain} onClose={() => setReceiptFor(null)} onDone={() => { setReceiptFor(null); void reload(); }} flash={flash} />}
      {saleFor && <QuickManualSaleModal row={saleFor} onClose={() => setSaleFor(null)} onDone={() => { setSaleFor(null); void reload(); }} flash={flash} />}
      {adjustFor && <AdjustModal row={adjustFor} domain={domain} onClose={() => setAdjustFor(null)} onDone={() => { setAdjustFor(null); void reload(); }} flash={flash} />}
      {saleScopeFor && <SaleScopeModal target={saleScopeFor} onClose={() => setSaleScopeFor(null)}
        onDone={() => { setSaleScopeFor(null); void reload(); }} flash={flash} />}
    </Card>
  );
}

/** react fragments inside tbody need a tiny helper to keep keys happy */
/**
 * §28/§30: scope-aware sale status. The admin explicitly picks WHAT stops/starts:
 * فقط همین تنوع / همهٔ تنوع‌های این رنگ / کل محصول — with a confirmation that names the
 * exact selection. One transactional backend call, per-item results.
 */
function SaleScopeModal({ target, onClose, onDone, flash }: {
  target: { row: InvRow; productLevel: boolean }; onClose: () => void; onDone: () => void; flash: F;
}) {
  const { row } = target;
  /* Master §G: the entry context LOCKS the scope — a product-row action confirms the
   * product scope only (no representative variant!), a variant action confirms exactly
   * that variant. Wider scopes are a secondary, explicit opt-in (variant entry only). */
  const locked: "variant" | "product" = target.productLevel ? "product" : "variant";
  const [scope, setScope] = useState<"variant" | "color" | "product">(locked);
  const [advanced, setAdvanced] = useState(false);
  const [enable, setEnable] = useState(() => {
    if (target.productLevel) return !row.retail_enabled;
    return !(row.variant_sale_enabled ?? true) || !row.retail_enabled ? true : false;
  });
  const [busy, setBusy] = useState(false);
  const scopeLabel = scope === "variant"
    ? `فقط تنوع ${row.color_label ?? "—"} / ${row.size_label ?? "—"} (${row.sku})`
    : scope === "color"
      ? `همهٔ تنوع‌های رنگ «${row.color_label ?? "—"}» از ${row.product_name}`
      : `کل محصول «${row.product_name}» (همهٔ رنگ‌ها و سایزها)`;
  const submit = async () => {
    setBusy(true);
    try {
      const res = await productsApi.saleStatusScoped(
        scope === "product" ? { scope, enabled: enable, productIds: [row.product_id] }
          : scope === "color" ? { scope, enabled: enable, colorTargets: [{ productId: row.product_id, colorLabel: row.color_label ?? "" }] }
            : { scope, enabled: enable, variantIds: [row.variant_id] });
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length) flash(`ناموفق: ${failed.map((f) => `${f.label}: ${f.error ?? ""}`).join("؛ ")}`);
      else flash(enable ? `فروش ${scopeLabel} فعال شد.` : `فروش ${scopeLabel} متوقف شد (موجودی دست‌نخورده می‌ماند).`);
      onDone();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت فروش"); }
    finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="وضعیت فروش خرده">
      <h3 className="mb-1 text-[15px] font-extrabold">وضعیت فروش — {row.product_name}</h3>
      <p className="mb-3 text-[12px] leading-6 text-[var(--kv-muted)]">
        {locked === "product"
          ? "این عملیات روی کل محصول اعمال می‌شود (همهٔ رنگ‌ها و سایزها). قابل فروش بودن نهایی را سرور محاسبه می‌کند."
          : "این عملیات فقط روی همین تنوع اعمال می‌شود؛ توقف یک تنوع هرگز کل محصول را متوقف نمی‌کند. قابل فروش بودن نهایی را سرور محاسبه می‌کند."}
      </p>
      <div className="space-y-2">
        {([
          ...(locked === "variant" ? [["variant", `فقط همین تنوع — ${row.color_label ?? "—"} / ${row.size_label ?? "—"}`, `وضعیت فعلی: ${(row.variant_sale_enabled ?? true) ? "فعال" : "متوقف"}`] as const] : []),
          ...(locked === "variant" && advanced ? [["color", `همهٔ تنوع‌های رنگ «${row.color_label ?? "—"}»`, "یک عملیات سروری برای همهٔ سایزهای این رنگ"] as const] : []),
          ...(locked === "product" || advanced ? [["product", "کل محصول (کلید اصلی)", `وضعیت فعلی محصول: ${row.retail_enabled ? "فعال" : "متوقف"}`] as const] : []),
        ] as readonly (readonly ["variant" | "color" | "product", string, string])[]).map(([value, label, hint]) => (
          <button key={value} className={cn("w-full rounded-[12px] border p-3 text-right",
            scope === value ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)]")}
            onClick={() => setScope(value)} disabled={value === "color" && !row.color_label}>
            <p className="text-[13px] font-bold">{label}</p>
            <p className="text-[11px] text-[var(--kv-muted)]">{hint}</p>
          </button>
        ))}
        {locked === "variant" && !advanced && (
          <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline" onClick={() => setAdvanced(true)}>
            تغییر دامنه (پیشرفته): رنگ یا کل محصول…
          </button>
        )}
        <Segmented options={[{ v: "stop", label: "توقف فروش" }, { v: "start", label: "فعال‌سازی فروش" }]}
          value={enable ? "start" : "stop"} onChange={(v) => setEnable(v === "start")} />
        <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[12px] font-bold leading-6 text-amber-800">
          {enable ? "فعال‌سازی" : "توقف"} فروش برای: {scopeLabel}
        </p>
        <div className="flex gap-2">
          <Btn variant="accent" disabled={busy} onClick={() => void submit()}>تأیید و اعمال</Btn>
          <Btn variant="soft" onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

function FragmentRows({ head, body }: { head: React.ReactNode; body: React.ReactNode }) {
  return <>{head}{body}</>;
}

type BulkReport = { title: string; items: { label: string; ok: boolean; error?: string }[] };
const rowLabel = (row: InvRow) => `${row.product_name} — ${row.color_label ?? "—"} / ${row.size_label ?? "—"} (${row.sku})`;

/** §13: group adjustment — per-variant independent signed delta, shared reason, ledger per movement. */
function BulkAdjustModal({ rows, domain, onClose, onDone, flash }: {
  rows: InvRow[]; domain: "retail" | "wholesale"; onClose: () => void; onDone: (report: BulkReport) => void; flash: F;
}) {
  const [entries, setEntries] = useState(() => rows.map((row) => ({ row, direction: "increase" as "increase" | "decrease", qty: "" })));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="اصلاح گروهی موجودی" max="max-w-[760px]">
      <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
        <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">
          برای هر تنوع، نوع تغییر و تعداد را جداگانه مشخص کنید. هر ردیف به صورت یک حرکت مستقل در دفتر موجودی ثبت می‌شود؛
          ردیف‌های نامعتبر فقط همان ردیف را ناموفق می‌کنند. ردیف‌های بدون تعداد اعمال نمی‌شوند.
        </p>
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table w-full text-[12px]">
            <thead><tr><th>تنوع</th><th>انبار</th><th>قابل فروش</th><th>نوع تغییر</th><th>تعداد</th></tr></thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.row.variant_id}-${entry.row.warehouse_id}`}>
                  <td>{rowLabel(entry.row)}</td>
                  <td>{entry.row.warehouse_name}</td>
                  <td className="tabular-nums">{fa(Number(entry.row.available))}</td>
                  <td>
                    <Segmented options={[{ v: "increase", label: "افزایش +" }, { v: "decrease", label: "کاهش −" }]}
                      value={entry.direction}
                      onChange={(direction) => setEntries(entries.map((item, i) => i === index ? { ...item, direction } : item))} />
                  </td>
                  <td>
                    <Input value={entry.qty} onChange={(qty) => { if (/^\d*$/.test(qty)) setEntries(entries.map((item, i) => i === index ? { ...item, qty } : item)); }} placeholder="مثلاً 3" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Field label="دلیل مشترک اصلاح"><Textarea value={reason} onChange={setReason} rows={2} placeholder="مثلاً شمارش انبارگردانی مهر" /></Field>
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy} onClick={async () => {
            const lines = entries
              .filter((entry) => Number(entry.qty) > 0)
              .map((entry) => ({
                variantId: entry.row.variant_id, warehouseId: entry.row.warehouse_id, inventoryDomain: domain,
                delta: entry.direction === "increase" ? Number(entry.qty) : -Number(entry.qty),
              }));
            if (!lines.length) { flash("برای حداقل یک ردیف تعداد وارد کنید."); return; }
            if (reason.trim().length < 4) { flash("دلیل اصلاح را کامل بنویسید."); return; }
            setBusy(true);
            try {
              const res = await inventoryApi.bulkAdjust(
                { lines, reason: reason.trim(), reference: `ADJ-${Date.now()}`, partial: true }, newKey("badj"));
              onDone({
                title: "نتیجه اصلاح گروهی موجودی",
                items: res.results.map((item) => {
                  const row = rows.find((candidate) => candidate.variant_id === item.variantId && candidate.warehouse_id === item.warehouseId);
                  return { label: row ? rowLabel(row) : item.variantId, ok: item.ok, error: item.error };
                }),
              });
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در اصلاح گروهی"); }
            finally { setBusy(false); }
          }}>ثبت اصلاح گروهی</Btn>
          <Btn size="sm" variant="soft" disabled={busy} onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
}

/** §14: rule-aware bulk transfer — preview shows eligible/blocked, server enforces every rule per line. */
function BulkTransferModal({ rows, domain, warehouses, onClose, onDone, flash }: {
  rows: InvRow[]; domain: "retail" | "wholesale"; warehouses: { id: string; code: string; name: string }[];
  onClose: () => void; onDone: (report: BulkReport) => void; flash: F;
}) {
  const sourceWarehouses = [...new Set(rows.map((row) => row.warehouse_id))];
  const sameSource = sourceWarehouses.length === 1;
  const [destWarehouseId, setDestWarehouseId] = useState("");
  const [destDomain, setDestDomain] = useState<"retail" | "wholesale">(domain);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [confirmFull, setConfirmFull] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = rows.map((row) => {
    if (destDomain === "retail" && row.owner_type === "supplier") {
      return { row, reason: "کالای متعلق به تأمین‌کننده بدون سند تملک کلبه قابل انتقال به خرده‌فروشی نیست." };
    }
    if (Number(row.available) <= 0) return { row, reason: "موجودی قابل فروش برای انتقال صفر است." };
    return null;
  }).filter((item): item is { row: InvRow; reason: string } => item !== null);
  const eligible = rows.filter((row) => !blocked.some((item) => item.row === row));
  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="انتقال گروهی موجودی" max="max-w-[760px]">
      <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
        {!sameSource && <ErrorState message="ردیف‌های انتخاب‌شده از چند انبار مبدأ هستند؛ انتقال گروهی فقط از یک انبار مبدأ مجاز است. انتخاب را محدود کنید." />}
        <p className="text-[12.5px] font-bold">
          {fa(eligible.length)} مورد قابل انتقال · {fa(blocked.length)} مورد مسدود
          {blocked.length > 0 && <Btn size="sm" variant="soft" className="mr-2" onClick={() => setShowBlocked(!showBlocked)}>مشاهده موارد مسدود</Btn>}
        </p>
        {showBlocked && blocked.length > 0 && (
          <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11.5px]">
            {blocked.map((item) => <li key={`${item.row.variant_id}-${item.row.warehouse_id}`}>{rowLabel(item.row)} — {item.reason}</li>)}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="انبار مقصد">
            <select aria-label="انبار مقصد" value={destWarehouseId} onChange={(e) => setDestWarehouseId(e.target.value)} className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2.5 text-sm">
              <option value="">انتخاب کنید…</option>
              {warehouses.map((wh) => <option key={wh.id} value={wh.id}>{wh.name}</option>)}
            </select>
          </Field>
          <Field label="دامنه مقصد">
            <Segmented options={[{ v: "retail", label: "خرده" }, { v: "wholesale", label: "عمده" }]} value={destDomain} onChange={setDestDomain} />
          </Field>
        </div>
        {eligible.length > 0 && (
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table w-full text-[12px]">
              <thead><tr><th>تنوع</th><th>قابل فروش مبدأ</th><th>تعداد انتقال</th></tr></thead>
              <tbody>
                {eligible.map((row) => (
                  <tr key={`${row.variant_id}-${row.warehouse_id}`}>
                    <td>{rowLabel(row)}</td>
                    <td className="tabular-nums">{fa(Number(row.available))}</td>
                    <td><Input value={qty[row.variant_id] ?? ""} onChange={(value) => { if (/^\d*$/.test(value)) setQty({ ...qty, [row.variant_id]: value }); }} placeholder="تعداد" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Checkbox checked={confirmFull} onChange={setConfirmFull}
          label={<span className="text-[11.5px]">تأیید صریح: اگر ردیفی تمام موجودی قابل فروش مبدأ را جابه‌جا می‌کند، انجام شود.</span>} />
        <div className="flex gap-2">
          <Btn size="sm" variant="accent" disabled={busy || !sameSource || !destWarehouseId} onClick={async () => {
            const lines = eligible
              .filter((row) => Number(qty[row.variant_id]) > 0)
              .map((row) => ({ variantId: row.variant_id, quantity: Number(qty[row.variant_id]), ...(confirmFull ? { confirmFullStock: true } : {}) }));
            if (!lines.length) { flash("برای حداقل یک ردیف تعداد انتقال وارد کنید."); return; }
            setBusy(true);
            try {
              const res = await inventoryApi.bulkTransfers({
                sourceDomain: domain, destinationDomain: destDomain,
                sourceWarehouseId: sourceWarehouses[0]!, destinationWarehouseId: destWarehouseId,
                reason: "انتقال گروهی از کنسول انبار", lines,
              }, newKey("btrf"));
              onDone({
                title: "نتیجه انتقال گروهی (حواله‌ها در تب نقل‌وانتقالات برای تأیید و تکمیل هستند)",
                items: [
                  ...res.results.map((item) => {
                    const row = rows.find((candidate) => candidate.variant_id === item.variantId);
                    return { label: `${row ? rowLabel(row) : item.variantId}${item.reference ? ` — ${item.reference}` : ""}`, ok: item.ok, error: item.error };
                  }),
                  ...blocked.map((item) => ({ label: rowLabel(item.row), ok: false, error: item.reason })),
                ],
              });
            } catch (e) { flash(e instanceof Error ? e.message : "خطا در انتقال گروهی"); }
            finally { setBusy(false); }
          }}>انتقال {fa(eligible.length)} مورد</Btn>
          <Btn size="sm" variant="soft" disabled={busy} onClick={onClose}>انصراف</Btn>
        </div>
      </div>
    </Modal>
  );
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

function InventoryContext({ row }: { row: InvRow }) {
  return <p className="text-sm leading-7">{row.product_name} · {row.color_label ?? "—"} / {row.size_label ?? "—"}<br />انبار: {row.warehouse_name} · دامنه: {row.inventory_domain === "retail" ? "خرده" : "عمده"}</p>;
}

function AdjustModal({ row, domain, onClose, onDone, flash }: { row: InvRow; domain: "retail" | "wholesale"; onClose: () => void; onDone: () => void; flash: F }) {
  const [direction, setDirection] = useState<"increase" | "decrease">("increase");
  const [quantity, setQuantity] = useState("");
  const reasons = ["شمارش دوره‌ای", "اصلاح خطای ثبت", "مغایرت موجودی", "خرابی / ضایعات", "مرجوعی", "سایر"];
  const [reason, setReason] = useState(reasons[0]!);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = adjustmentPreview(row, direction, quantity);
  const auditReason = reason === "سایر" ? `سایر: ${note.trim()}` : reason;
  const reasonValid = reason !== "سایر" || note.trim().length >= 4;
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="اصلاح موجودی (سند تعدیلی)">
    <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
      <h3 className="text-base font-bold">اصلاح موجودی</h3>
      <InventoryContext row={row} />
      <Field label="نوع تغییر"><Segmented options={[{ v: "increase", label: "افزایش +" }, { v: "decrease", label: "کاهش −" }]} value={direction} onChange={setDirection} /></Field>
      <Field label="مقدار"><input aria-label="مقدار" type="number" min="1" max="100000" step="1" value={quantity} onChange={(e) => { if (/^\d*$/.test(e.target.value)) setQuantity(e.target.value); }} onKeyDown={(e) => { if (["+", "-", "e", "."].includes(e.key)) e.preventDefault(); }} className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 focus-visible:outline-2" /></Field>
      <div aria-live="polite" className="rounded-lg bg-[var(--kv-surface-2)] p-3 text-sm">
        <p>موجودی فعلی: {fa(row.on_hand)}</p><p>تغییر: <b dir="ltr">{preview.delta > 0 ? "+" : ""}{fa(preview.delta)}</b></p><p>موجودی جدید: {fa(preview.next)}</p>
        {!preview.valid && <p role="alert" className="mt-2 text-[var(--kv-danger)]">{preview.message}</p>}
      </div>
      <Field label="دلیل"><Select options={reasons} value={reason} onChange={setReason} /></Field>
      {reason === "سایر" && <Field label="توضیح اصلاح (الزامی)"><Textarea value={note} onChange={setNote} rows={3} /></Field>}
      <p className="text-xs text-[var(--kv-muted)]">دلیل، مرجع و کاربر در سند ثبت می‌شوند. فروش خارج از سایت را با «ثبت فروش دستی» ثبت کنید.</p>
      <div className="flex gap-2">
        <Btn size="sm" variant="accent" disabled={busy || !preview.valid || !reasonValid} onClick={async () => {
          if (!preview.valid || !reasonValid) return;
          setBusy(true);
          try {
            await inventoryApi.adjust({ variantId: row.variant_id, warehouseId: row.warehouse_id, delta: preview.delta, reason: auditReason, reference: newKey("adj"), inventoryDomain: domain }, newKey("adjk"));
            flash("سند اصلاح موجودی ثبت شد."); onDone();
          } catch (e) { flash(e instanceof Error ? e.message : "خطا در اصلاح موجودی"); }
          finally { setBusy(false); }
        }}>ثبت سند</Btn><Btn size="sm" variant="soft" disabled={busy} onClick={onClose}>انصراف</Btn>
      </div>
    </div>
  </Modal>;
}

function ReceiveModal({ receipt, row, onClose, onDone, flash }: { receipt: ReceiptRow; row?: InvRow; onClose: () => void; onDone: () => void | Promise<void>; flash: F }) {
  const [context, setContext] = useState<InvRow | null>(row ?? null);
  const [contextError, setContextError] = useState<string | null>(null);
  useEffect(() => {
    if (row || !receipt.variant_id) return;
    let active = true;
    inventoryApi.balances({ variantId: receipt.variant_id, warehouseId: receipt.warehouse_id, inventoryDomain: receipt.inventory_domain }).then((result) => {
      if (!active) return;
      const match = (result.items as InvRow[]).find((item) => item.variant_id === receipt.variant_id && item.warehouse_id === receipt.warehouse_id && item.inventory_domain === receipt.inventory_domain);
      if (match) setContext(match); else setContextError("اطلاعات محصول این رسید یافت نشد.");
    }).catch((e: unknown) => { if (active) setContextError(e instanceof Error ? e.message : "خطا در بارگذاری اطلاعات رسید"); });
    return () => { active = false; };
  }, [row, receipt.variant_id, receipt.warehouse_id, receipt.inventory_domain]);
  const expected = receipt.quantity ?? 0;
  const [quantity, setQuantity] = useState(String(expected));
  const [busy, setBusy] = useState(false);
  const actual = Number(quantity);
  const valid = /^\d+$/.test(quantity) && Number.isSafeInteger(actual) && actual >= 0 && actual <= expected;
  const missing = valid ? expected - actual : 0;
  return <Modal open title={`دریافت رسید ${receipt.reference}`} onClose={() => { if (!busy) onClose(); }}>
    <div className="max-h-[75vh] space-y-3 overflow-y-auto p-4">
      <h3 className="text-base font-bold">دریافت رسید {receipt.reference}</h3>
      {context ? <InventoryContext row={context} /> : contextError ? <p role="alert" className="text-sm text-red-700">{contextError}</p> : <LoadingState label="در حال خواندن اطلاعات رسید…" />}
      <p className="text-sm">دامنه: {receipt.inventory_domain === "retail" ? "خرده" : "عمده"} · شماره رسید: <span dir="ltr">{receipt.reference}</span><br />شماره بسته / کارتن: <span dir="ltr">{receipt.batch_reference ?? "—"}</span></p>
      <p>مقدار مورد انتظار: {fa(expected)}</p>
      <Field label="تعداد واقعی دریافتی"><input aria-label="تعداد واقعی دریافتی" type="number" min="0" max={expected} step="1" value={quantity} onChange={(e) => { if (/^\d*$/.test(e.target.value)) setQuantity(e.target.value); }} onKeyDown={(e) => { if (["+", "-", "e", "."].includes(e.key)) e.preventDefault(); }} className="w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 focus-visible:outline-2" /></Field>
      <div aria-live="polite" className="text-sm">
        {!valid && <p role="alert" className="text-red-700">تعداد باید عدد صحیح از صفر تا مقدار مورد انتظار باشد.</p>}
        {missing > 0 && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">مورد انتظار: {fa(expected)} · دریافتی: {fa(actual)} · کسری: {fa(missing)}<br />کسری به‌صورت مغایرت ثبت می‌شود.</p>}
      </div>
      <div className="flex gap-2"><Btn size="sm" variant="soft" disabled={busy} onClick={onClose}>انصراف</Btn>
        <Btn size="sm" variant="accent" disabled={busy || !valid || !context} onClick={async () => {
          if (!valid || !context) return;
          setBusy(true);
          try {
            await inventoryApi.receiveReceipt(receipt.id, { receivedQuantity: actual });
            flash(missing > 0 ? `رسید دریافت شد؛ کسری ${fa(missing)} عدد ثبت شد.` : "رسید کامل دریافت شد.");
            await onDone();
          } catch (e) { flash(e instanceof Error ? e.message : "خطا در دریافت رسید"); }
          finally { setBusy(false); }
        }}>{busy ? "در حال ثبت…" : "ثبت دریافت"}</Btn>
      </div>
    </div>
  </Modal>;
}

/* ------------------------------ transfers center (C2/G/H) ------------------------------ */

function TransfersCenter({ flash, statusFilter, hideCreate }: { flash: F; statusFilter?: string[]; hideCreate?: boolean }) {
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
  const visibleTransfers = statusFilter ? transfers.filter((t) => statusFilter.includes(t.status)) : transfers;

  return (
    <div className="space-y-4">
      {!hideCreate && <Card className="p-4">
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
      </Card>}

      <Card className="overflow-hidden">
        <h3 className="flex items-center gap-1.5 border-b border-[var(--kv-border)] p-3 text-[14px] font-extrabold"><Truck size={15} />سوابق نقل‌وانتقال</h3>
        {visibleTransfers.length === 0 ? <Empty title="انتقالی ثبت نشده" desc="اولین انتقال را از فرم بالا بسازید." /> : (
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[860px] text-[12.5px]">
              <thead><tr><th>شماره</th><th>کالا</th><th>مسیر</th><th>تعداد</th><th>بسته</th><th>وضعیت</th><th>تاریخ</th><th>عملیات</th></tr></thead>
              <tbody>
                {visibleTransfers.map((t) => (
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

function WholesaleCenter({ flash, initialSub }: { flash: F; initialSub?: "review" }) {
  const [sub, setSub] = useState<"inventory" | "review" | "requests" | "inbound">(initialSub ?? "inventory");
  useEffect(() => { if (initialSub) setSub(initialSub); }, [initialSub]);
  return (
    <div className="space-y-4">
      <Segmented
        options={[
          { v: "inventory", label: "موجودی عمده" },
          { v: "review", label: "محصولات و بازبینی" },
          { v: "requests", label: "درخواست‌های تأمین‌کنندگان" },
          { v: "inbound", label: "ورودی انبار و QC" },
        ]}
        value={sub} onChange={setSub}
      />
      {sub === "inventory" && <WholesaleInventoryTab flash={flash} />}
      {/* §2 + §55: the ONE canonical wholesale product review queue (ex wproducts + ex بازبینی بازارچه). */}
      {sub === "review" && <MarketplaceReviewPanel flash={flash} />}
      {sub === "requests" && <SupplierRequestsAdmin flash={flash} />}
      {sub === "inbound" && (
        <div className="space-y-5">
          {/* §1.2 + §21: supplier inbound shipments / QC inspections — Central WHOLESALE warehouse only. */}
          <AdminServerOrders request={serverRequest} only="inbound-qc" />
          <InboundReceipts flash={flash} />
        </div>
      )}
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

  const reload = useCallback(async () => {
    setError(null);
    try {
      // §21: this view belongs to the CENTRAL WHOLESALE warehouse — retail receipts must not appear here.
      const items = (await inventoryApi.receipts()).items as unknown as ReceiptRow[];
      setRows(items.filter((row) => row.inventory_domain === 'wholesale'));
    }
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
                      onClick={() => setReceiveFor(r)}>دریافت و شمارش</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {receiveFor && <ReceiveModal receipt={receiveFor} onClose={() => setReceiveFor(null)} onDone={async () => { setReceiveFor(null); await reload(); }} flash={flash} />}
    </Card>
  );
}
