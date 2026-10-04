import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowLeftRight, CheckCircle2, PackageCheck, Plus, RefreshCw, ShieldCheck, Tag, Truck, Warehouse } from "lucide-react";
import type { ApiRequest } from "../data/api";
import { ORDER_SORTS, ORDER_SORT_LABEL, readPricingSnapshot, type OrderSort } from "../data/contracts";

type OrderStatus = "pending_payment" | "paid" | "processing" | "preparing" | "ready_to_ship" | "in_transit" | "shipped" | "delivered" | "cancelled" | "returned";
type Order = {
  id: string; reference: string; buyer_id: string; buyer_name: string | null; buyer_phone: string | null;
  order_type: "retail" | "wholesale"; payment_mode: string; status: OrderStatus; total_rial: string;
  subtotal_rial?: string; discount_rial?: string;
  wholesale_fulfillment_status?: string | null; consolidated_at?: string | null; vip_dispatched_at?: string | null;
  created_at: string; updated_at: string; lines_count: number; payment_status: string | null;
  supplier_names: string[] | null;
};
type OrderDetail = Order & {
  subtotal_rial: string; discount_rial: string; shipping_rial: string;
  shipping_address: { recipient: string; phone: string; province: string; city: string; line: string; postalCode: string };
  shipping_code: string | null; shipping_name: string | null;
  pricing_snapshot: unknown;
  lines: {
    id: string; sku: string; product_name: string; brand_display_name?: string; quantity: number;
    base_unit_price_rial?: string; unit_price_rial: string; discount_amount_rial?: string; line_total_rial: string;
    qc_status?: string; received_at_kolbe?: string | null;
  }[];
  events: { from_status: string | null; to_status: string; note: string | null; created_at: string }[];
  payments: { id: string; reference: string; provider: string; amount_rial: string; status: string; created_at: string }[];
  fulfillments?: {
    id: string; reference: string; brand_name: string | null; status: string;
    dispatched_at: string | null; arrived_at: string | null; accepted_at: string | null;
  }[];
};

type InboundShipmentLine = {
  id: string;
  orderLineId: string;
  variantId: string;
  sku: string;
  productName: string;
  expectedQuantity: number;
  receivedQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  damagedQuantity: number;
  missingQuantity: number;
  inspectionNote?: string | null;
};

type InboundShipment = {
  id: string;
  shipment_number: string;
  order_id: string;
  order_reference: string;
  brand_name: string | null;
  destination_warehouse_name: string;
  status: string;
  carrier: string | null;
  tracking_code: string | null;
  created_at: string;
  lines: InboundShipmentLine[];
};

type StockBalanceRow = {
  variant_id: string;
  warehouse_id: string;
  inventory_domain: "retail" | "wholesale";
  warehouse_name: string;
  warehouse_code: string;
  sku: string;
  size_label: string | null;
  color_label: string | null;
  product_id: string;
  product_name: string;
  owner_type: "kolbe" | "supplier";
  on_hand: number;
  reserved: number;
  incoming: number;
  damaged: number;
  available: number;
};

type StockTransferRow = {
  id: string;
  reference: string;
  variant_id: string;
  sku: string;
  product_name: string;
  owner_type: "kolbe" | "supplier";
  source_domain: "retail" | "wholesale";
  destination_domain: "retail" | "wholesale";
  source_warehouse_name: string;
  destination_warehouse_name: string;
  quantity: number;
  reason: string;
  status: "draft" | "approved" | "in_transit" | "completed" | "cancelled";
  created_at: string;
};

type OwnershipConversionRow = {
  id: string;
  reference: string;
  product_id: string;
  product_name: string;
  variant_id: string | null;
  variant_sku: string | null;
  conversion_type: string;
  quantity: number;
  used_quantity: number;
  unit_cost_rial: string;
  status: string;
  created_at: string;
};

type ServerPromotionRule = {
  id: string;
  name: string | null;
  channel: string;
  target_type: "variant" | "color" | "size" | "product" | "category";
  product_id: string | null;
  product_name: string | null;
  color_id: string | null;
  size_code: string | null;
  variant_id: string | null;
  variant_sku: string | null;
  discount_type: "percent" | "fixed_rial";
  discount_value: string;
  priority: number;
  active: boolean;
};

const labels: Record<OrderStatus, string> = {
  pending_payment: "در انتظار پرداخت", paid: "پرداخت‌شده", processing: "در حال پردازش", preparing: "در حال آماده‌سازی",
  ready_to_ship: "آمادهٔ ارسال", in_transit: "در حال ارسال", shipped: "ارسال‌شده", delivered: "تحویل‌شده",
  cancelled: "لغوشده", returned: "مرجوع‌شده",
};
const paymentLabels: Record<string, string> = { pending: "در انتظار", succeeded: "موفق", failed: "ناموفق", refunded: "برگشتی" };
const wholesaleStageLabels: Record<string, string> = {
  awaiting_supplier: "در انتظار تأمین‌کننده",
  supplier_preparing: "در حال آماده‌سازی تأمین‌کننده",
  supplier_dispatched: "ارسال شده به انبار کلبه",
  arrived_at_kolbe: "رسیده به انبار کلبه",
  receiving: "در حال تحویل‌گیری انبار کلبه",
  under_inspection: "در حال کنترل کیفیت (QC)",
  partially_accepted: "تأیید جزئی در QC (دارای کسری/معیوب)",
  accepted: "تأیید کامل QC",
  rejected: "رد شده در QC",
  awaiting_consolidation: "آماده تجمیع در انبار کلبه",
  ready_for_vip: "تجمیع‌شده · آماده ارسال به VIP",
  vip_dispatched: "ارسال شده از انبار کلبه به VIP",
  delivered: "تحویل نهایی به VIP",
};
const nextStatus: Partial<Record<OrderStatus, OrderStatus>> = {
  paid: "processing", processing: "preparing", preparing: "ready_to_ship", ready_to_ship: "in_transit",
  in_transit: "shipped", shipped: "delivered",
};
/** Canonical admin display unit is تومان (storage stays integer rial; ÷۱۰ for display only). */
const money = (value: string | undefined) => value ? `${new Intl.NumberFormat("fa-IR").format(BigInt(value) / 10n)} تومان` : "۰ تومان";
const date = (value: string) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const makeIdemKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type ServerOpsSection = "orders" | "inbound-qc" | "inventory-transfers" | "server-promotions";

export function AdminServerOrders({ request, hideOrders = false, only }: { request: ApiRequest; hideOrders?: boolean; only?: ServerOpsSection }) {
  // §1.2: the old «QC و عملیات سرور» top-level entry is gone. Each capability now mounts inside
  // its canonical domain hub via `only` (inbound-qc → WMS wholesale, inventory-transfers → WMS
  // transfers, server-promotions → کوپن و جشنواره). Nothing is deleted, only relocated.
  const [section, setSection] = useState<ServerOpsSection>(only ?? (hideOrders ? "inbound-qc" : "orders"));

  // 1. Orders state
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [sort, setSort] = useState<OrderSort>("newest");
  const [orderType, setOrderType] = useState<"" | "retail" | "wholesale">("");
  const [paymentStatus, setPaymentStatus] = useState("");
  const [status, setStatus] = useState("");

  // 2. Inbound Shipments & QC state
  const [shipments, setShipments] = useState<InboundShipment[]>([]);
  const [selectedShipmentId, setSelectedShipmentId] = useState<string | null>(null);
  const [qcInputs, setQcInputs] = useState<Record<string, { received: number; accepted: number; rejected: number; damaged: number; missing: number; note: string }>>({});
  const [qcInspectorNote, setQcInspectorNote] = useState("");

  // 3. Inventory Domains, Stock Transfers & Ownership Conversions state
  const [balances, setBalances] = useState<StockBalanceRow[]>([]);
  const [domainFilter, setDomainFilter] = useState<"" | "wholesale" | "retail">("");
  const [transfers, setTransfers] = useState<StockTransferRow[]>([]);
  const [conversions, setConversions] = useState<OwnershipConversionRow[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; code: string; name: string }[]>([]);
  const [newTransfer, setNewTransfer] = useState({
    variantId: "",
    sourceDomain: "wholesale" as "wholesale" | "retail",
    destinationDomain: "retail" as "wholesale" | "retail",
    sourceWarehouseId: "",
    destinationWarehouseId: "",
    quantity: 5,
    reason: "تأمین موجودی خرده‌فروشی از موجودی عمده کلبه",
  });
  const [newConversion, setNewConversion] = useState({
    productId: "",
    variantId: "",
    conversionType: "purchase_acquisition" as "purchase_acquisition" | "ownership_transfer" | "consignment_conversion",
    quantity: 10,
    unitCostRial: "5000000",
    note: "تملک رسمی کالا توسط کلبه جهت عرضه در خرده‌فروشی",
  });

  // 4. Server Promotions state
  const [promoRules, setPromoRules] = useState<ServerPromotionRule[]>([]);
  const [newRule, setNewRule] = useState({
    name: "",
    targetType: "variant" as "variant" | "color" | "size" | "product",
    productId: "",
    colorId: "black",
    sizeCode: "XL",
    variantId: "",
    discountType: "percent" as "percent" | "fixed_rial",
    discountValue: "15",
    priority: 10,
  });

  const buildQuery = useCallback((offset: number) => {
    const params = new URLSearchParams({ limit: "50", offset: String(offset), sort });
    if (orderType) params.set("orderType", orderType);
    if (paymentStatus) params.set("paymentStatus", paymentStatus);
    if (status) params.set("status", status);
    if (appliedQuery.trim()) params.set("search", appliedQuery.trim());
    return params.toString();
  }, [sort, orderType, paymentStatus, status, appliedQuery]);

  const loadOrders = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>(`/orders?${buildQuery(0)}`);
      setOrders(result.items);
      setHasMore(result.items.length === 50);
      setSelected((current) => current && result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "دریافت سفارش‌ها ناموفق بود."); }
    finally { setLoading(false); }
  }, [request, buildQuery]);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true); setError(null);
    try {
      const result = await request<{ items: Order[] }>(`/orders?${buildQuery(orders.length)}`);
      setOrders((current) => [...current, ...result.items.filter((item) => !current.some((old) => old.id === item.id))]);
      setHasMore(result.items.length === 50);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "دریافت سفارش‌های بیشتر ناموفق بود."); }
    finally { setLoadingMore(false); }
  };

  const loadInboundShipments = useCallback(async () => {
    setError(null);
    try {
      const res = await request<{ items: InboundShipment[] }>("/wholesale/inbound-shipments");
      setShipments(res.items);
      const first = res.items[0];
      if (first && !selectedShipmentId) {
        setSelectedShipmentId(first.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "دریافت مرسولات ورودی انبار کلبه ناموفق بود.");
    }
  }, [request, selectedShipmentId]);

  const loadInventoryAndTransfers = useCallback(async () => {
    setError(null);
    try {
      const [invRes, trRes, ocRes, whRes] = await Promise.all([
        request<{ items: StockBalanceRow[] }>(`/inventory${domainFilter ? `?inventoryDomain=${domainFilter}` : ""}`),
        request<{ items: StockTransferRow[] }>("/inventory/transfers"),
        request<{ items: OwnershipConversionRow[] }>("/inventory/ownership-conversions"),
        request<{ items: { id: string; code: string; name: string }[] }>("/warehouses"),
      ]);
      setBalances(invRes.items);
      setTransfers(trRes.items);
      setConversions(ocRes.items);
      setWarehouses(whRes.items);
      if (whRes.items[0] && !newTransfer.sourceWarehouseId) {
        setNewTransfer((prev) => ({
          ...prev,
          sourceWarehouseId: whRes.items[0]!.id,
          destinationWarehouseId: whRes.items[0]!.id,
          variantId: invRes.items[0]?.variant_id ?? prev.variantId,
        }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "دریافت اطلاعات انبار و حواله‌ها ناموفق بود.");
    }
  }, [request, domainFilter, newTransfer.sourceWarehouseId]);

  const loadServerPromotions = useCallback(async () => {
    setError(null);
    try {
      const res = await request<{ rules: ServerPromotionRule[] }>("/promotions");
      setPromoRules(res.rules ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "دریافت قوانین تخفیف سرور ناموفق بود.");
    }
  }, [request]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);
  useEffect(() => {
    if (section === "inbound-qc") void loadInboundShipments();
    if (section === "inventory-transfers") void loadInventoryAndTransfers();
    if (section === "server-promotions") void loadServerPromotions();
  }, [section, loadInboundShipments, loadInventoryAndTransfers, loadServerPromotions]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null); setDetailLoading(true);
    request<OrderDetail>(`/orders/${selected}`).then((result) => { if (!cancelled) setDetail(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "دریافت جزئیات ناموفق بود."); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [request, selected]);

  const transition = async (next: OrderStatus) => {
    if (!detail || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/orders/${detail.id}/transitions`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("ord-tr") },
        body: JSON.stringify({ status: next, note: note.trim() || undefined }),
      });
      setNote("");
      const updated = await request<OrderDetail>(`/orders/${detail.id}`);
      setDetail(updated);
      setOrders((items) => items.map((item) => item.id === updated.id ? { ...item, status: updated.status } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تغییر وضعیت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const consolidateWholesaleOrder = async () => {
    if (!detail || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/wholesale/orders/${detail.id}/consolidate`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("wh-cons") },
      });
      const updated = await request<OrderDetail>(`/orders/${detail.id}`);
      setDetail(updated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تجمیع سفارش عمده ناموفق بود."); }
    finally { setSaving(false); }
  };

  const dispatchVipOrder = async () => {
    if (!detail || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/wholesale/orders/${detail.id}/dispatch-vip`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("wh-vip") },
        body: JSON.stringify({ reason: note.trim() || "ارسال بسته تجمیع‌شده از انبار مرکزی کلبه به مشتری VIP" }),
      });
      const updated = await request<OrderDetail>(`/orders/${detail.id}`);
      setDetail(updated);
      setOrders((items) => items.map((item) => item.id === updated.id ? { ...item, status: updated.status } : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ارسال به مشتری VIP ناموفق بود."); }
    finally { setSaving(false); }
  };

  const selectedShipment = shipments.find((s) => s.id === selectedShipmentId) ?? shipments[0] ?? null;

  useEffect(() => {
    if (!selectedShipment) return;
    const init: Record<string, { received: number; accepted: number; rejected: number; damaged: number; missing: number; note: string }> = {};
    for (const line of selectedShipment.lines) {
      init[line.id] = {
        received: line.receivedQuantity || line.expectedQuantity,
        accepted: line.acceptedQuantity || line.expectedQuantity,
        rejected: line.rejectedQuantity || 0,
        damaged: line.damagedQuantity || 0,
        missing: line.missingQuantity || 0,
        note: line.inspectionNote ?? "",
      };
    }
    setQcInputs(init);
  }, [selectedShipment]);

  const markShipmentStage = async (stage: "arrived_at_kolbe" | "receiving" | "under_inspection") => {
    if (!selectedShipment || saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/wholesale/inbound-shipments/${selectedShipment.id}/receive`, {
        method: "POST",
        body: JSON.stringify({ stage }),
      });
      await loadInboundShipments();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ثبت مرحله دریافت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const submitQcInspection = async () => {
    if (!selectedShipment || saving) return;
    setSaving(true); setError(null);
    try {
      const lines = selectedShipment.lines.map((l) => {
        const inp = qcInputs[l.id] ?? {
          received: l.expectedQuantity,
          accepted: l.expectedQuantity,
          rejected: 0,
          damaged: 0,
          missing: 0,
          note: "",
        };
        return {
          shipmentLineId: l.id,
          receivedQuantity: Number(inp.received),
          acceptedQuantity: Number(inp.accepted),
          rejectedQuantity: Number(inp.rejected),
          damagedQuantity: Number(inp.damaged),
          missingQuantity: Number(inp.missing),
          inspectionNote: inp.note || undefined,
        };
      });
      await request(`/wholesale/inbound-shipments/${selectedShipment.id}/inspect`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("qc-insp") },
        body: JSON.stringify({ inspectorNote: qcInspectorNote || undefined, lines }),
      });
      setQcInspectorNote("");
      await loadInboundShipments();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ثبت کنترل کیفیت (QC) ناموفق بود."); }
    finally { setSaving(false); }
  };

  const createStockTransfer = async () => {
    if (saving || !newTransfer.variantId || !newTransfer.sourceWarehouseId || !newTransfer.destinationWarehouseId) return;
    setSaving(true); setError(null);
    try {
      await request("/inventory/transfers", {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("str-create") },
        body: JSON.stringify(newTransfer),
      });
      await loadInventoryAndTransfers();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ایجاد حواله انتقال ناموفق بود."); }
    finally { setSaving(false); }
  };

  const advanceTransfer = async (id: string, action: "approve" | "complete" | "cancel") => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/inventory/transfers/${id}/${action}`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey(`str-${action}`) },
      });
      await loadInventoryAndTransfers();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تغییر وضعیت حواله انتقال ناموفق بود."); }
    finally { setSaving(false); }
  };

  const createOwnershipConversion = async () => {
    if (saving || !newConversion.productId) return;
    setSaving(true); setError(null);
    try {
      await request("/inventory/ownership-conversions", {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("oc-create") },
        body: JSON.stringify({
          productId: newConversion.productId,
          variantId: newConversion.variantId || undefined,
          conversionType: newConversion.conversionType,
          quantity: Number(newConversion.quantity),
          unitCostRial: newConversion.unitCostRial,
          note: newConversion.note || undefined,
        }),
      });
      await loadInventoryAndTransfers();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ثبت انتقال مالکیت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const completeOwnershipConversion = async (id: string) => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/inventory/ownership-conversions/${id}/complete`, {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("oc-comp") },
      });
      await loadInventoryAndTransfers();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تکمیل انتقال مالکیت ناموفق بود."); }
    finally { setSaving(false); }
  };

  const createServerPromoRule = async () => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await request("/promotions/rules", {
        method: "POST",
        headers: { "idempotency-key": makeIdemKey("promo-rule") },
        body: JSON.stringify({
          name: newRule.name || undefined,
          targetType: newRule.targetType,
          productId: newRule.productId || undefined,
          colorId: newRule.targetType === "color" ? newRule.colorId : undefined,
          sizeCode: newRule.targetType === "size" ? newRule.sizeCode : undefined,
          variantId: newRule.targetType === "variant" ? newRule.variantId : undefined,
          discountType: newRule.discountType,
          discountValue: newRule.discountValue,
          priority: Number(newRule.priority),
        }),
      });
      setNewRule((prev) => ({ ...prev, name: "" }));
      await loadServerPromotions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "ثبت قانون تخفیف سرور ناموفق بود."); }
    finally { setSaving(false); }
  };

  const deactivateServerPromoRule = async (id: string) => {
    if (saving) return;
    setSaving(true); setError(null);
    try {
      await request(`/promotions/rules/${id}`, { method: "DELETE" });
      await loadServerPromotions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "غیرفعال‌سازی قانون تخفیف ناموفق بود."); }
    finally { setSaving(false); }
  };

  const selectClass = "mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]";
  const snapshot = detail ? readPricingSnapshot(detail.pricing_snapshot) : null;

  return (
    <section aria-label="سفارش‌های واقعی" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* ADM-WMS-003: when mounted inside another hub via `only`, the header must describe THAT
            capability — the old «سفارش‌های ثبت‌شده در سرور» title leaked into every WMS tab. */}
        <div>
          <h2 className="text-lg font-bold">{
            only === "inbound-qc" ? "دریافت انبار کلبه و کنترل کیفیت (QC)"
            : only === "inventory-transfers" ? "دامنه‌های موجودی و حواله انتقال"
            : only === "server-promotions" ? "قوانین تخفیف سمت سرور"
            : "سفارش‌های ثبت‌شده در سرور"}</h2>
          <p className="text-xs text-[var(--kv-muted)]">{
            only ? "داده‌ها مستقیم از پایگاه‌داده خوانده و ثبت می‌شوند."
            : "مرتب‌سازی، فیلتر و مبالغ همگی از پایگاه‌داده می‌آیند."}</p>
        </div>
        <div className={only ? "hidden" : "flex flex-wrap items-center gap-2"}>
          {!hideOrders && <button
            type="button"
            onClick={() => setSection("orders")}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold transition-colors ${
              section === "orders"
                ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]"
                : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]"
            }`}
          >
            <PackageCheck size={15} />
            سفارش‌های سرور
          </button>}
          <button
            type="button"
            onClick={() => setSection("inbound-qc")}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold transition-colors ${
              section === "inbound-qc"
                ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]"
                : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]"
            }`}
          >
            <ShieldCheck size={15} />
            دریافت انبار کلبه و کنترل کیفیت (QC)
          </button>
          <button
            type="button"
            onClick={() => setSection("inventory-transfers")}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold transition-colors ${
              section === "inventory-transfers"
                ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]"
                : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]"
            }`}
          >
            <ArrowLeftRight size={15} />
            دامنه‌های موجودی (عمده/خرده) و حواله انتقال
          </button>
          <button
            type="button"
            onClick={() => setSection("server-promotions")}
            className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-3.5 text-xs font-bold transition-colors ${
              section === "server-promotions"
                ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]"
                : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]"
            }`}
          >
            <Tag size={15} />
            موتور تخفیف سرور (Variant/Color/Size/Product)
          </button>
          <button
            type="button"
            onClick={() => {
              if (section === "orders") void loadOrders();
              if (section === "inbound-qc") void loadInboundShipments();
              if (section === "inventory-transfers") void loadInventoryAndTransfers();
              if (section === "server-promotions") void loadServerPromotions();
            }}
            disabled={loading}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--kv-line)] px-3 text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50"
          >
            <RefreshCw size={15} />به‌روزرسانی
          </button>
        </div>
      </div>

      {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900"><span>{error}</span><button type="button" onClick={() => void loadOrders()} className="font-bold underline">تلاش دوباره</button></div>}

      {/* ================= SECTION 1: ORDERS ================= */}
      {section === "orders" && !hideOrders && (
        <>
        {/* B: retail vs wholesale deals are two different worlds — hard split up front. */}
        <div className="flex flex-wrap items-center gap-2">
          {([["", "همه معاملات"], ["retail", "معاملات خرده"], ["wholesale", "معاملات عمده"]] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setOrderType(value)}
              className={`inline-flex min-h-10 items-center gap-2 rounded-lg border px-4 text-sm font-bold transition-colors ${
                orderType === value
                  ? "border-[var(--kv-action)] bg-[var(--kv-action)] text-[var(--kv-bg)]"
                  : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:bg-[var(--kv-surface-2)]"
              }`}>{label}</button>
          ))}
          {orderType === "wholesale" && (
            <span className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              زنجیره عمده: ثبت VIP ← آماده‌سازی تأمین‌کننده ← ارسال به کلبه ← ورود و QC ← تجمیع ← ارسال نهایی به خریدار (تأمین‌کننده هرگز مستقیم برای VIP نمی‌فرستد).
            </span>
          )}
        </div>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
          <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)]">
            <div className="grid gap-2 border-b border-[var(--kv-line)] p-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-xs font-semibold">جست‌وجو (شماره، خریدار، SKU)<input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setAppliedQuery(query); }} className="mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label>
              <label className="block text-xs font-semibold">مرتب‌سازی<select value={sort} onChange={(event) => setSort(event.target.value as OrderSort)} className={selectClass}>{ORDER_SORTS.map((value) => <option key={value} value={value}>{ORDER_SORT_LABEL[value]}</option>)}</select></label>
              <label className="block text-xs font-semibold">نوع سفارش<select value={orderType} onChange={(event) => setOrderType(event.target.value as "" | "retail" | "wholesale")} className={selectClass}><option value="">همه</option><option value="retail">خرده</option><option value="wholesale">عمده</option></select></label>
              <label className="block text-xs font-semibold">وضعیت پرداخت<select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} className={selectClass}><option value="">همه</option><option value="pending">در انتظار</option><option value="succeeded">موفق</option><option value="failed">ناموفق</option><option value="refunded">برگشتی</option><option value="none">بدون پرداخت</option></select></label>
              <label className="block text-xs font-semibold">وضعیت سفارش<select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass}><option value="">همه</option>{(Object.keys(labels) as OrderStatus[]).map((value) => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
              <div className="flex items-end"><button type="button" onClick={() => setAppliedQuery(query)} className="min-h-10 w-full rounded-lg bg-[var(--kv-action)] px-4 text-sm font-bold text-[var(--kv-bg)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]">اعمال جست‌وجو</button></div>
            </div>
            {loading ? <p role="status" className="p-5 text-sm text-[var(--kv-muted)]">در حال دریافت سفارش‌ها…</p> :
              orders.length === 0 ? <p className="p-5 text-sm text-[var(--kv-muted)]">سفارشی با این فیلتر پیدا نشد.</p> :
                <div className="max-h-[650px] divide-y divide-[var(--kv-line)] overflow-y-auto">
                  {orders.map((order) => <button key={order.id} type="button" onClick={() => setSelected(order.id)} aria-current={selected === order.id ? "true" : undefined}
                    className="flex w-full items-center gap-3 p-3 text-right hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] aria-current:bg-[var(--kv-surface-2)]">
                    <span className="min-w-0 flex-1"><strong className="block text-sm" dir="ltr">{order.reference}</strong>
                      <span className="mt-1 block truncate text-xs text-[var(--kv-muted)]">{order.buyer_name ?? "—"} · {order.order_type === "retail" ? "خرده" : "عمده"} · {(order.lines_count ?? 0).toLocaleString("fa-IR")} قلم · پرداخت: {order.payment_status ? paymentLabels[order.payment_status] ?? order.payment_status : "—"}</span>
                      <span className="block text-[11px] text-[var(--kv-muted)]">{date(order.created_at)}{(order.supplier_names?.length ?? 0) > 0 && ` · ${(order.supplier_names ?? []).join("، ")}`}</span>
                      {order.wholesale_fulfillment_status && (
                        <span className="mt-1 inline-block rounded bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px] font-bold">
                          {wholesaleStageLabels[order.wholesale_fulfillment_status] ?? order.wholesale_fulfillment_status}
                        </span>
                      )}
                    </span>
                    <span className="text-left"><span className="block text-sm font-bold tabular-nums">{money(order.total_rial)}</span><span className="text-xs text-[var(--kv-muted)]">{labels[order.status]}</span></span><ArrowLeft size={15} className="shrink-0" />
                  </button>)}
                </div>}
            {hasMore && !loading && <div className="border-t border-[var(--kv-line)] p-3"><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="min-h-10 w-full rounded-lg border border-[var(--kv-line)] text-sm font-semibold hover:bg-[var(--kv-surface-2)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{loadingMore ? "در حال دریافت…" : "نمایش سفارش‌های بیشتر"}</button></div>}
          </div>
          <div className="min-w-0 rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
            {detailLoading ? <p role="status" className="text-sm text-[var(--kv-muted)]">در حال دریافت جزئیات…</p> : !detail ? <p className="text-sm text-[var(--kv-muted)]">یک سفارش را برای دیدن جزئیات انتخاب کنید.</p> : <div className="space-y-4">
              <div>
                <p className="text-xs text-[var(--kv-muted)]" dir="ltr">{detail.reference}</p>
                <h3 className="mt-1 text-base font-bold">{detail.shipping_address.recipient}</h3>
                <p className="text-xs text-[var(--kv-muted)]">{labels[detail.status]} · {money(detail.total_rial)} · {detail.payment_mode === "four_installments" ? "چهار قسط" : "نقدی"}</p>
                {detail.order_type === "wholesale" && detail.wholesale_fulfillment_status && (
                  <p className="mt-2 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-3 py-2 text-xs font-bold">
                    وضعیت زنجیره تأمین انبار کلبه: {wholesaleStageLabels[detail.wholesale_fulfillment_status] ?? detail.wholesale_fulfillment_status}
                  </p>
                )}
              </div>
              <div className="space-y-2 border-y border-[var(--kv-line)] py-3 text-sm">
                {detail.lines.map((line) => (
                  <div key={line.id} className="space-y-1">
                    <div className="flex justify-between gap-2"><span className="min-w-0">{line.product_name} <span className="text-xs text-[var(--kv-muted)]" dir="ltr">{line.sku}</span> × {line.quantity}</span><span className="shrink-0 tabular-nums">{money(line.line_total_rial)}</span></div>
                    {detail.order_type === "wholesale" && (
                      <p className="text-[11px] text-[var(--kv-muted)]">
                        وضعیت QC انبار کلبه: <b>{line.qc_status ?? "pending"}</b>
                        {line.received_at_kolbe ? ` · دریافت در کلبه: ${date(line.received_at_kolbe)}` : " · هنوز در انبار کلبه دریافت نشده"}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {detail.order_type === "wholesale" && (
                <div className="flex flex-wrap gap-2">
                  {detail.wholesale_fulfillment_status === "awaiting_consolidation" && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void consolidateWholesaleOrder()}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      <CheckCircle2 size={14} />
                      تجمیع نهایی اقلام در انبار کلبه (Ready for VIP)
                    </button>
                  )}
                  {detail.wholesale_fulfillment_status === "ready_for_vip" && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void dispatchVipOrder()}
                      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--kv-action)] px-3.5 text-xs font-bold text-[var(--kv-bg)] hover:opacity-90 disabled:opacity-50"
                    >
                      <Truck size={14} />
                      ارسال بسته تجمیع‌شده از انبار کلبه به مشتری VIP
                    </button>
                  )}
                </div>
              )}
              {snapshot && (
                <div className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[12.5px]">
                  <p className="mb-1.5 font-extrabold">صورت‌حساب سرور (لحظه ثبت)</p>
                  <div className="space-y-1">
                    <div className="flex justify-between"><span className="text-[var(--kv-muted)]">جمع اقلام</span><b className="tabular-nums">{money(snapshot.baseSubtotalRial)}</b></div>
                    {BigInt(snapshot.planDiscountRial) > 0n && <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تخفیف پلن عمده</span><b className="tabular-nums">−{money(snapshot.planDiscountRial)}</b></div>}
                    {BigInt(snapshot.promoDiscountRial) > 0n && <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تخفیف جشنواره/کوپن ({snapshot.promoSource})</span><b className="tabular-nums">−{money(snapshot.promoDiscountRial)}</b></div>}
                    {BigInt(snapshot.walletRedeemedRial ?? "0") > 0n && <div className="flex justify-between"><span className="text-[var(--kv-muted)]">کیف پول کش‌بک</span><b className="tabular-nums">−{money(snapshot.walletRedeemedRial)}</b></div>}
                    <div className="flex justify-between"><span className="text-[var(--kv-muted)]">هزینه ارسال{detail.shipping_name ? ` (${detail.shipping_name})` : ""}{snapshot.shipping ? ` · ${snapshot.shipping.totalWeightGrams.toLocaleString("fa-IR")} گرم` : ""}</span><b className="tabular-nums">{snapshot.shippingRial === "0" ? "رایگان" : money(snapshot.shippingRial)}</b></div>
                    <div className="flex justify-between border-t border-[var(--kv-line)] pt-1"><span className="font-bold">جمع کل</span><b className="tabular-nums">{money(snapshot.totalRial)}</b></div>
                    {snapshot.installment && (
                      <p className="pt-1 text-[var(--kv-muted)]">{snapshot.installment.eligible
                        ? snapshot.installment.perInstallmentRial ? `۴ قسط ${money(snapshot.installment.perInstallmentRial)}` : "قسط: مجاز"
                        : `قسط غیرمجاز: ${snapshot.installment.reason ?? "—"}`}</p>
                    )}
                  </div>
                </div>
              )}
              {(detail.payments ?? []).length > 0 && (
                <div className="text-xs leading-6"><p className="text-sm font-bold">پرداخت‌ها</p>{(detail.payments ?? []).map((payment) => <p key={payment.id} className="text-[var(--kv-muted)]"><span dir="ltr">{payment.reference}</span> · {payment.provider} · {money(payment.amount_rial)} · {paymentLabels[payment.status] ?? payment.status}</p>)}</div>
              )}
              <div className="text-xs leading-6 text-[var(--kv-muted)]"><p>گیرنده: {detail.shipping_address.phone}</p><p>نشانی: {detail.shipping_address.province}، {detail.shipping_address.city}، {detail.shipping_address.line}</p></div>
              <div><h4 className="text-sm font-bold">تاریخچه وضعیت</h4><ol className="mt-2 space-y-2 border-r border-[var(--kv-line)] pr-3">{(detail.events ?? []).map((event, index) => <li key={`${event.created_at}-${index}`} className="text-xs"><span className="font-semibold">{labels[event.to_status as OrderStatus] ?? event.to_status}</span><span className="mr-2 text-[var(--kv-muted)]">{date(event.created_at)}</span>{event.note && <p className="mt-1 text-[var(--kv-muted)]">{event.note}</p>}</li>)}</ol></div>
              {nextStatus[detail.status] && <div className="space-y-2 border-t border-[var(--kv-line)] pt-3"><label className="block text-xs font-semibold">یادداشت تغییر وضعیت<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2 text-sm focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label><button type="button" disabled={saving} onClick={() => void transition(nextStatus[detail.status]!)} className="min-h-10 rounded-lg bg-[var(--kv-action)] px-4 text-sm font-bold text-[var(--kv-bg)] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{saving ? "در حال ثبت…" : `ثبت وضعیت «${labels[nextStatus[detail.status]!] }»`}</button></div>}
            </div>}
          </div>
        </div>
        </>
      )}

      {/* ================= SECTION 2: INBOUND SHIPMENTS & QC ================= */}
      {section === "inbound-qc" && (
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 space-y-2">
            <h3 className="text-sm font-bold">مرسولات ورودی تأمین‌کنندگان به انبار کلبه</h3>
            <p className="text-xs text-[var(--kv-muted)]">تمام کالاهای عمده تأمین‌کنندگان ابتدا وارد انبار کلبه شده و پس از QC برای VIP ارسال می‌شوند.</p>
            {shipments.length === 0 ? (
              <p className="py-6 text-xs text-[var(--kv-muted)]">مرسوله ورودی ثبت نشده است.</p>
            ) : (
              <div className="divide-y divide-[var(--kv-line)]">
                {shipments.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedShipmentId(s.id)}
                    className={`w-full py-3 px-2 text-right text-xs transition-colors ${
                      selectedShipment?.id === s.id ? "bg-[var(--kv-surface-2)] font-bold" : "hover:bg-[var(--kv-surface-2)]/50"
                    }`}
                  >
                    <div className="flex justify-between">
                      <span dir="ltr">{s.shipment_number}</span>
                      <span>{wholesaleStageLabels[s.status] ?? s.status}</span>
                    </div>
                    <div className="mt-1 text-[var(--kv-muted)]">
                      سفارش {s.order_reference} · مقصد: {s.destination_warehouse_name}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
            {!selectedShipment ? (
              <p className="text-sm text-[var(--kv-muted)]">یک مرسوله ورودی را جهت دریافت و بازرسی کنترل کیفیت (QC) انتخاب کنید.</p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--kv-line)] pb-3">
                  <div>
                    <h4 className="text-base font-bold" dir="ltr">{selectedShipment.shipment_number}</h4>
                    <p className="text-xs text-[var(--kv-muted)]">
                      سفارش: {selectedShipment.order_reference} · مقصد: {selectedShipment.destination_warehouse_name} · وضعیت:{" "}
                      <b>{wholesaleStageLabels[selectedShipment.status] ?? selectedShipment.status}</b>
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void markShipmentStage("arrived_at_kolbe")}
                      className="rounded-lg border border-[var(--kv-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--kv-surface-2)]"
                    >
                      ثبت ورود به انبار کلبه
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void markShipmentStage("under_inspection")}
                      className="rounded-lg border border-[var(--kv-line)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--kv-surface-2)]"
                    >
                      شروع بازرسی کیفی (QC)
                    </button>
                  </div>
                </div>

                <div className="kv-scroll kv-scroll-x">
                  <table className="w-full text-right text-xs">
                    <thead>
                      <tr className="border-b border-[var(--kv-line)] text-[var(--kv-muted)]">
                        <th className="py-2">SKU / محصول</th>
                        <th className="py-2">مورد انتظار</th>
                        <th className="py-2">دریافتی</th>
                        <th className="py-2">تأیید شده (Accepted)</th>
                        <th className="py-2">رد شده (Rejected)</th>
                        <th className="py-2">آسیب‌دیده (Damaged)</th>
                        <th className="py-2">کسری (Missing)</th>
                        <th className="py-2">یادداشت QC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--kv-line)]">
                      {selectedShipment.lines.map((line) => {
                        const row = qcInputs[line.id] ?? {
                          received: line.expectedQuantity,
                          accepted: line.expectedQuantity,
                          rejected: 0,
                          damaged: 0,
                          missing: 0,
                          note: "",
                        };
                        const setRow = (patch: Partial<typeof row>) =>
                          setQcInputs((prev) => ({ ...prev, [line.id]: { ...row, ...patch } }));
                        return (
                          <tr key={line.id}>
                            <td className="py-2 font-semibold">
                              {line.productName} <span className="text-[var(--kv-muted)]" dir="ltr">({line.sku})</span>
                            </td>
                            <td className="py-2 tabular-nums font-bold">{line.expectedQuantity}</td>
                            <td className="py-2">
                              <input
                                type="number"
                                min={0}
                                value={row.received}
                                onChange={(e) => setRow({ received: Number(e.target.value) })}
                                className="w-16 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                min={0}
                                value={row.accepted}
                                onChange={(e) => setRow({ accepted: Number(e.target.value) })}
                                className="w-16 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                min={0}
                                value={row.rejected}
                                onChange={(e) => setRow({ rejected: Number(e.target.value) })}
                                className="w-16 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                min={0}
                                value={row.damaged}
                                onChange={(e) => setRow({ damaged: Number(e.target.value) })}
                                className="w-16 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="number"
                                min={0}
                                value={row.missing}
                                onChange={(e) => setRow({ missing: Number(e.target.value) })}
                                className="w-16 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                            <td className="py-2">
                              <input
                                type="text"
                                value={row.note}
                                onChange={(e) => setRow({ note: e.target.value })}
                                placeholder="یادداشت بازرس…"
                                className="w-36 rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] px-2 py-1"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[var(--kv-line)] pt-3">
                  <label className="flex-1 text-xs font-semibold">
                    توضیح کلی رسید انبار و بازرسی کیفیت (GRN Note)
                    <input
                      value={qcInspectorNote}
                      onChange={(e) => setQcInspectorNote(e.target.value)}
                      placeholder="همه اقلام شمارش و کنترل کیفیت شد…"
                      className="mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2 text-sm"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={saving || ["accepted", "partially_accepted", "rejected"].includes(selectedShipment.status)}
                    onClick={() => void submitQcInspection()}
                    className="min-h-10 rounded-lg bg-[var(--kv-action)] px-4 text-xs font-bold text-[var(--kv-bg)] hover:opacity-90 disabled:opacity-50"
                  >
                    ثبت قطعی رسید انبار کلبه (GRN) و نتیجه QC
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= SECTION 3: INVENTORY DOMAINS & TRANSFERS ================= */}
      {section === "inventory-transfers" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold flex items-center gap-1.5"><Warehouse size={16} /> موجودی به تفکیک دامنه (Wholesale vs Retail) و مالکیت (Kolbe vs Supplier)</h3>
                <p className="text-xs text-[var(--kv-muted)]">فروش عمده فقط از دامنه Wholesale و فروش تکی فقط از دامنه Retail کسر می‌کند.</p>
              </div>
              <select
                value={domainFilter}
                onChange={(e) => setDomainFilter(e.target.value as "" | "wholesale" | "retail")}
                className="rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-1.5 text-xs font-bold"
              >
                <option value="">همه دامنه‌ها (Wholesale + Retail)</option>
                <option value="wholesale">فقط دامنه عمده (Wholesale)</option>
                <option value="retail">فقط دامنه خرده‌فروشی (Retail)</option>
              </select>
            </div>
            <div className="kv-scroll kv-scroll-x">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-[var(--kv-line)] text-[var(--kv-muted)]">
                    <th className="py-2">SKU</th>
                    <th className="py-2">محصول / رنگ / سایز</th>
                    <th className="py-2">مالکیت کالا</th>
                    <th className="py-2">انبار</th>
                    <th className="py-2">دامنه موجودی</th>
                    <th className="py-2">On Hand</th>
                    <th className="py-2">Reserved</th>
                    <th className="py-2">Incoming</th>
                    <th className="py-2">Damaged</th>
                    <th className="py-2">Available</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {balances.map((b) => (
                    <tr key={`${b.variant_id}-${b.warehouse_id}-${b.inventory_domain}`}>
                      <td className="py-2 font-mono font-bold" dir="ltr">{b.sku}</td>
                      <td className="py-2">{b.product_name} ({b.color_label ?? "—"} / {b.size_label ?? "—"})</td>
                      <td className="py-2">
                        <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${b.owner_type === "kolbe" ? "bg-blue-100 text-blue-900" : "bg-amber-100 text-amber-900"}`}>
                          {b.owner_type === "kolbe" ? "ملکی کلبه (Kolbe)" : "متعلق به تأمین‌کننده (Supplier)"}
                        </span>
                      </td>
                      <td className="py-2">{b.warehouse_name}</td>
                      <td className="py-2 font-bold">{b.inventory_domain === "wholesale" ? "عمده (Wholesale)" : "خرده (Retail)"}</td>
                      <td className="py-2 tabular-nums">{b.on_hand}</td>
                      <td className="py-2 tabular-nums">{b.reserved}</td>
                      <td className="py-2 tabular-nums">{b.incoming}</td>
                      <td className="py-2 tabular-nums">{b.damaged}</td>
                      <td className="py-2 tabular-nums font-extrabold">{b.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {/* Stock Transfer Form & List */}
            <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 space-y-3">
              <h3 className="text-sm font-bold">۱. حواله رسمی انتقال موجودی بین دامنه‌ها (Stock Transfer)</h3>
              <p className="text-xs text-[var(--kv-muted)]">
                انتقال مستقیم بدون حواله ممنوع است. برای کالاهای Supplier-owned، انتقال به دامنه Retail بدون ثبت انتقال مالکیت مسدود است.
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label>
                  واریانت (Variant)
                  <select
                    value={newTransfer.variantId}
                    onChange={(e) => setNewTransfer({ ...newTransfer, variantId: e.target.value })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    <option value="">انتخاب واریانت…</option>
                    {Array.from(new Map(balances.map((b) => [b.variant_id, b])).values()).map((b) => (
                      <option key={b.variant_id} value={b.variant_id}>
                        {b.sku} — {b.product_name} ({b.owner_type})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  تعداد انتقال
                  <input
                    type="number"
                    min={1}
                    value={newTransfer.quantity}
                    onChange={(e) => setNewTransfer({ ...newTransfer, quantity: Number(e.target.value) })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  />
                </label>
                <label>
                  دامنه مبدأ
                  <select
                    value={newTransfer.sourceDomain}
                    onChange={(e) => setNewTransfer({ ...newTransfer, sourceDomain: e.target.value as "wholesale" | "retail" })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    <option value="wholesale">عمده (wholesale)</option>
                    <option value="retail">خرده (retail)</option>
                  </select>
                </label>
                <label>
                  دامنه مقصد
                  <select
                    value={newTransfer.destinationDomain}
                    onChange={(e) => setNewTransfer({ ...newTransfer, destinationDomain: e.target.value as "wholesale" | "retail" })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    <option value="retail">خرده (retail)</option>
                    <option value="wholesale">عمده (wholesale)</option>
                  </select>
                </label>
                <label>
                  انبار مبدأ
                  <select
                    value={newTransfer.sourceWarehouseId}
                    onChange={(e) => setNewTransfer({ ...newTransfer, sourceWarehouseId: e.target.value })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                  </select>
                </label>
                <label>
                  انبار مقصد
                  <select
                    value={newTransfer.destinationWarehouseId}
                    onChange={(e) => setNewTransfer({ ...newTransfer, destinationWarehouseId: e.target.value })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.code})</option>)}
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={saving || !newTransfer.variantId}
                onClick={() => void createStockTransfer()}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--kv-action)] px-3 text-xs font-bold text-[var(--kv-bg)]"
              >
                <Plus size={14} /> ایجاد پیش‌نویس حواله انتقال و رزرو مبدأ
              </button>

              <div className="divide-y divide-[var(--kv-line)] pt-2 text-xs">
                {transfers.map((t) => (
                  <div key={t.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <b dir="ltr">{t.reference}</b> · {t.sku} × {t.quantity} ({t.source_domain} → {t.destination_domain})
                      <span className="mr-2 rounded bg-[var(--kv-surface-2)] px-2 py-0.5 font-bold">{t.status}</span>
                    </div>
                    <div className="flex gap-1.5">
                      {t.status === "draft" && (
                        <>
                          <button
                            type="button"
                            onClick={() => void advanceTransfer(t.id, "approve")}
                            className="rounded bg-blue-700 px-2.5 py-1 text-white font-bold"
                          >
                            تأیید و ارسال (In Transit)
                          </button>
                          <button
                            type="button"
                            onClick={() => void advanceTransfer(t.id, "cancel")}
                            className="rounded border border-[var(--kv-line)] px-2 py-1"
                          >
                            لغو
                          </button>
                        </>
                      )}
                      {t.status === "in_transit" && (
                        <button
                          type="button"
                          onClick={() => void advanceTransfer(t.id, "complete")}
                          className="rounded bg-emerald-700 px-2.5 py-1 text-white font-bold"
                        >
                          دریافت قطعی در مقصد (Complete)
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Ownership Conversion Form & List */}
            <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 space-y-3">
              <h3 className="text-sm font-bold">۲. فرآیند رسمی انتقال مالکیت کالا (Ownership Conversion)</h3>
              <p className="text-xs text-[var(--kv-muted)]">
                کالای متعلق به تأمین‌کننده (`owner_type = supplier`) فقط پس از ثبت و تکمیل قرارداد خرید/تملک توسط کلبه مجاز به انتقال به دامنه خرده‌فروشی است.
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label>
                  محصول تأمین‌کننده
                  <select
                    value={newConversion.productId}
                    onChange={(e) => setNewConversion({ ...newConversion, productId: e.target.value })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  >
                    <option value="">انتخاب محصول…</option>
                    {Array.from(new Map(balances.filter((b) => b.owner_type === "supplier").map((b) => [b.product_id, b])).values()).map((b) => (
                      <option key={b.product_id} value={b.product_id}>{b.product_name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  تعداد مورد تملک
                  <input
                    type="number"
                    min={1}
                    value={newConversion.quantity}
                    onChange={(e) => setNewConversion({ ...newConversion, quantity: Number(e.target.value) })}
                    className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-1.5"
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={saving || !newConversion.productId}
                onClick={() => void createOwnershipConversion()}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--kv-action)] px-3 text-xs font-bold text-[var(--kv-bg)]"
              >
                <Plus size={14} /> ثبت سند انتقال مالکیت (Purchase Acquisition)
              </button>

              <div className="divide-y divide-[var(--kv-line)] pt-2 text-xs">
                {conversions.map((oc) => (
                  <div key={oc.id} className="py-2 flex items-center justify-between gap-2">
                    <div>
                      <b dir="ltr">{oc.reference}</b> · {oc.product_name} · ظرفیت: {oc.used_quantity}/{oc.quantity} · وضعیت: <b>{oc.status}</b>
                    </div>
                    {oc.status === "pending" && (
                      <button
                        type="button"
                        onClick={() => void completeOwnershipConversion(oc.id)}
                        className="rounded bg-emerald-700 px-2.5 py-1 text-white font-bold"
                      >
                        تأیید و تکمیل انتقال مالکیت
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================= SECTION 4: SERVER PROMOTION ENGINE ================= */}
      {section === "server-promotions" && (
        <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 space-y-3 text-xs">
            <h3 className="text-sm font-bold">تعریف قانون تخفیف در سرور (Promotion Rule)</h3>
            <label className="block">
              عنوان قانون
              <input
                value={newRule.name}
                onChange={(e) => setNewRule({ ...newRule, name: e.target.value })}
                placeholder="مثلاً: تخفیف ۲۵٪ مشکی سایز XL"
                className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
              />
            </label>
            <label className="block">
              سطح هدف‌گذاری (Target Type)
              <select
                value={newRule.targetType}
                onChange={(e) => setNewRule({ ...newRule, targetType: e.target.value as "variant" | "color" | "size" | "product" })}
                className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
              >
                <option value="variant">variant (واریانت دقیق)</option>
                <option value="color">color (همه سایزهای یک رنگ در محصول)</option>
                <option value="size">size (همه رنگ‌های یک سایز در محصول)</option>
                <option value="product">product (کل واریانت‌های محصول)</option>
              </select>
            </label>
            {newRule.targetType === "variant" ? (
              <label className="block">
                شناسه واریانت (variantId)
                <input
                  value={newRule.variantId}
                  onChange={(e) => setNewRule({ ...newRule, variantId: e.target.value })}
                  dir="ltr"
                  placeholder="UUID واریانت"
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                />
              </label>
            ) : (
              <label className="block">
                شناسه محصول (productId)
                <input
                  value={newRule.productId}
                  onChange={(e) => setNewRule({ ...newRule, productId: e.target.value })}
                  dir="ltr"
                  placeholder="UUID محصول"
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                />
              </label>
            )}
            {newRule.targetType === "color" && (
              <label className="block">
                رنگ هدف (colorId)
                <input
                  value={newRule.colorId}
                  onChange={(e) => setNewRule({ ...newRule, colorId: e.target.value })}
                  dir="ltr"
                  placeholder="black / olive / مشکی"
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                />
              </label>
            )}
            {newRule.targetType === "size" && (
              <label className="block">
                سایز هدف (sizeCode)
                <input
                  value={newRule.sizeCode}
                  onChange={(e) => setNewRule({ ...newRule, sizeCode: e.target.value })}
                  dir="ltr"
                  placeholder="XL / L / M"
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                />
              </label>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label>
                نوع تخفیف
                <select
                  value={newRule.discountType}
                  onChange={(e) => setNewRule({ ...newRule, discountType: e.target.value as "percent" | "fixed_rial" })}
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                >
                  <option value="percent">درصدی (percent)</option>
                  <option value="fixed_rial">مبلغ ثابت ریال (fixed_rial)</option>
                </select>
              </label>
              <label>
                مقدار تخفیف
                <input
                  value={newRule.discountValue}
                  onChange={(e) => setNewRule({ ...newRule, discountValue: e.target.value })}
                  className="mt-1 w-full rounded border border-[var(--kv-line)] bg-[var(--kv-bg)] p-2"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void createServerPromoRule()}
              className="min-h-10 w-full rounded-lg bg-[var(--kv-action)] font-bold text-[var(--kv-bg)]"
            >
              ثبت قانون در سرور
            </button>
          </div>

          <div className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
            <h3 className="mb-3 text-sm font-bold">قوانین تخفیف ثبت‌شده در پایگاه‌داده</h3>
            <div className="kv-scroll kv-scroll-x">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-[var(--kv-line)] text-[var(--kv-muted)]">
                    <th className="py-2">عنوان</th>
                    <th className="py-2">سطح (target_type)</th>
                    <th className="py-2">هدف</th>
                    <th className="py-2">مقدار</th>
                    <th className="py-2">اولویت</th>
                    <th className="py-2">وضعیت</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {promoRules.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 font-bold">{r.name ?? "—"}</td>
                      <td className="py-2 font-mono" dir="ltr">{r.target_type}</td>
                      <td className="py-2">
                        {r.product_name ?? r.variant_sku ?? ""}
                        {r.color_id ? ` · رنگ: ${r.color_id}` : ""}
                        {r.size_code ? ` · سایز: ${r.size_code}` : ""}
                      </td>
                      <td className="py-2 font-bold">
                        {r.discount_type === "percent" ? `${r.discount_value}٪` : money(r.discount_value)}
                      </td>
                      <td className="py-2 tabular-nums">{r.priority}</td>
                      <td className="py-2">{r.active ? "فعال" : "غیرفعال"}</td>
                      <td className="py-2">
                        {r.active && (
                          <button
                            type="button"
                            onClick={() => void deactivateServerPromoRule(r.id)}
                            className="text-red-600 underline"
                          >
                            غیرفعال‌سازی
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
