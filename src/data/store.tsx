/* Shared marketplace store — plays the role of the backend API that the three
   separate apps (kolbe.ir storefront, seller center, admin console) talk to.
   Persisted to localStorage and synced across tabs. */
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { PRODUCTS, IMG, COLORS, nextSku, type Product, type ProductStatus } from "./catalog";
import {
  SEED_ACCOUNTS, SEED_RETAIL_ORDERS, digitsOnly,
  type CustomerAccount, type CustomerAddress, type CustomerTicket, type RetailCartLine, type RetailOrder, type SavedStyle,
} from "./customer";
import {
  SEED_ORDERS, SEED_PLANS, SEED_SHIPPING, SEED_INTEGRATIONS, SEED_BUYERS, SEED_NOTIFS, SEED_CMS,
  EVENT_TEXT, nowLabel, canTransitionSub,
  type ParentOrder, type SubOrder, type SubStatus, type WholesaleCartLine, type VipPlan,
  type ShippingMethod, type Integration, type Buyer, type NotifTemplate, type CmsItem, type OrderLine,
} from "./platform";

const SEED_EXTRA: Product[] = [
  {
    status: "pending", id: "p9", sku: "NL-PNT-012", brand: "Nilgoon", name: "شلوار پارچه‌ای راسته", supplier: "نیلگون", supplierId: "s1",
    category: "شلوار", retailPrice: 6900000, wholesaleFrom: 5600000, rating: 0, reviews: 0,
    colors: [COLORS.black, COLORS.sand, COLORS.navy], images: [IMG.neutralRack, IMG.shirtRack, IMG.whiteShirts, IMG.neutralRack],
    series: [{ id: "full", name: "سری کامل", pieces: 12, composition: { S: 2, M: 2, L: 2, XL: 2, "2XL": 2, "3XL": 2 }, moqSeries: 3, pricePerSeries: 5600000, available: true }],
    seriesCount: 1, moq: 3, stock: 180, fabric: "فاستونی سبک", desc: "شلوار راسته با فاق متوسط و پیلی جلو؛ مناسب ست با کت و بلیزر.",
  },
  {
    status: "pending", id: "p10", sku: "BF-KNT-004", brand: "Baftineh", name: "ژاکت بافت دست‌دوز", supplier: "بافتینه", supplierId: "s4",
    category: "بافت", retailPrice: 8400000, wholesaleFrom: 7100000, rating: 0, reviews: 0,
    colors: [COLORS.cream, COLORS.olive], images: [IMG.greenShirt, IMG.neutralRack, IMG.shirtsColor, IMG.greenShirt],
    series: [{ id: "full", name: "سری کامل", pieces: 8, composition: { S: 1, M: 2, L: 2, XL: 2, "2XL": 1 }, moqSeries: 2, pricePerSeries: 7100000, available: true }],
    seriesCount: 1, moq: 2, stock: 64, fabric: "پشم مرینو", desc: "ژاکت بافت با یقه گرد، بافته‌شده توسط کارگاه‌های یزد.",
  },
];

type State = {
  products: Product[];
  orders: ParentOrder[];
  accounts: CustomerAccount[];
  retailOrders: RetailOrder[];
  wcart: WholesaleCartLine[];
  plans: VipPlan[];
  shipping: ShippingMethod[];
  integrations: Integration[];
  buyers: Buyer[];
  notifs: NotifTemplate[];
  cms: CmsItem[];
};

type Store = State & {
  setStatus: (id: string, s: ProductStatus) => void;
  addProduct: (p: Product) => void;
  updateProductSeries: (id: string, series: Product["series"]) => void;
  ensureAccount: (phone: string) => string;
  updateAccount: (id: string, patch: Partial<Omit<CustomerAccount, "id" | "phone">>) => void;
  requestVip: (accountId: string, application: { businessName: string; city: string; tradeCode: string; planId: string }) => void;
  saveStyle: (accountId: string, productIds: string[], title: string) => void;
  addTicket: (accountId: string, subject: string, message: string) => void;
  setTicketStatus: (accountId: string, ticketId: string, status: CustomerTicket["status"]) => void;
  placeRetailOrder: (accountId: string, cart: RetailCartLine[], address: CustomerAddress, shippingMethod: string, shippingFee: number, discount?: number, discountNote?: string, paymentMode?: "cash" | "four_installments") => string | null;
  requestRetailReturn: (accountId: string, orderId: string, reason: string) => void;
  setRetailOrderStatus: (id: string, status: RetailOrder["status"], note?: string) => void;
  setReturnStatus: (id: string, status: NonNullable<RetailOrder["returnRequest"]>["status"]) => void;
  wcartAdd: (line: WholesaleCartLine) => void;
  wcartRemove: (i: number) => void;
  wcartQty: (i: number, q: number) => void;
  wcartClear: () => void;
  placeOrder: (buyer: string, shippingMethod: string, address: string, accountId: string, discountPercent?: number) => string;
  updateProduct: (id: string, patch: Partial<Product>) => void;
  transitionSub: (parentId: string, subId: string, status: SubStatus, by: string, extra?: { note?: string; tracking?: string; eta?: string }) => void;
  paySub: (parentId: string, subId: string, by: string) => void;
  payParent: (parentId: string, by: string) => void;
  upsertPlan: (p: VipPlan) => void;
  removePlan: (id: string) => void;
  upsertShipping: (m: ShippingMethod) => void;
  removeShipping: (id: string) => void;
  toggleIntegration: (id: string) => void;
  setBuyer: (id: string, patch: Partial<Buyer>) => void;
  setNotif: (id: string, patch: Partial<NotifTemplate>) => void;
  upsertCms: (item: CmsItem) => void;
  reset: () => void;
};

const Ctx = createContext<Store | null>(null);
const KEY = "kolbe-store-v3";

/* Source garment shots on white; the style-builder pipeline removes the background and emits transparent PNG. */
export const CUTOUT_SEED: Record<string, NonNullable<Product["cutout"]>> = {
  p1: { status: "ready", src: "/cutouts/trench.png", source: "local" },
  p6: { status: "ready", src: "/cutouts/trench.png", source: "local" },
  p2: { status: "ready", src: "/cutouts/shirt.png", source: "local" },
  p3: { status: "ready", src: "/cutouts/blazer.png", source: "local" },
  p7: { status: "ready", src: "/cutouts/blazer.png", source: "local" },
  p9: { status: "ready", src: "/cutouts/trousers.png", source: "local" },
};

const initial = (): State => ({
  products: [...PRODUCTS.map((p) => ({ ...p, status: "published" as ProductStatus })), ...SEED_EXTRA].map((p) => ({ ...p, cutout: CUTOUT_SEED[p.id] ?? { status: "none" as const } })),
  orders: SEED_ORDERS,
  accounts: SEED_ACCOUNTS,
  retailOrders: SEED_RETAIL_ORDERS,
  wcart: [],
  plans: SEED_PLANS,
  shipping: SEED_SHIPPING,
  integrations: SEED_INTEGRATIONS,
  buyers: SEED_BUYERS,
  notifs: SEED_NOTIFS,
  cms: SEED_CMS,
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() => {
    try {
      const raw = localStorage.getItem(KEY) ?? localStorage.getItem("kolbe-store-v2");
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.orders) && Array.isArray(s.plans) && Array.isArray(s.products)) {
          return {
            ...initial(), ...s,
            accounts: Array.isArray(s.accounts) ? s.accounts : SEED_ACCOUNTS,
            retailOrders: Array.isArray(s.retailOrders) ? s.retailOrders : SEED_RETAIL_ORDERS,
            buyers: (s.buyers ?? SEED_BUYERS).map((b: Buyer) => b.id === "b1" ? { ...b, accountId: "acc-vip" } : b),
            wcart: (s.wcart ?? []).map((l: WholesaleCartLine) => l.accountId ? l : { ...l, accountId: "acc-vip" }),
            plans: (s.plans as VipPlan[]).map((p) => p.limits ? p : { ...p, limits: SEED_PLANS.find((x) => x.id === p.id)?.limits }),
            products: (s.products as Product[]).map((p) => p.cutout ? p : { ...p, cutout: CUTOUT_SEED[p.id] ?? { status: "none" as const } }),
          };
        }
      }
    } catch { /* ignore */ }
    return initial();
  });

  useEffect(() => {
    try {
      const next = JSON.stringify(state);
      if (localStorage.getItem(KEY) !== next) localStorage.setItem(KEY, next);
    } catch { /* ignore */ }
  }, [state]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && e.newValue) {
        try { setState(JSON.parse(e.newValue)); } catch { /* ignore */ }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const patchSub = (parentId: string, subId: string, fn: (s: SubOrder) => SubOrder) =>
    setState((st) => ({ ...st, orders: st.orders.map((o) => (o.id !== parentId ? o : { ...o, subOrders: o.subOrders.map((s) => (s.id === subId ? fn(s) : s)) })) }));

  const move = (s: SubOrder, status: SubStatus, by: string, extra?: { note?: string; tracking?: string; eta?: string }): SubOrder =>
    !canTransitionSub(s.status, status) ? s : ({
      ...s, ...extra, status,
      events: [...s.events, { t: EVENT_TEXT[status] + (extra?.tracking ? ` · ${extra.tracking}` : "") + (extra?.note ? ` · ${extra.note}` : ""), time: nowLabel(), by }],
    });

  const value: Store = {
    ...state,
    setStatus: (id, s) => setState((st) => ({ ...st, products: st.products.map((p) => (p.id === id ? { ...p, status: s } : p)) })),
    addProduct: (p) => setState((st) => {
      const sku = p.sku.trim() && !st.products.some((item) => item.sku === p.sku.trim())
        ? p.sku.trim() : nextSku(st.products, p.supplierId, p.category);
      return { ...st, products: [{ ...p, sku }, ...st.products] };
    }),
    updateProduct: (id, patch) => setState((st) => ({ ...st, products: st.products.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
    updateProductSeries: (id, series) => setState((st) => {
      const clean = series.map((s) => ({ ...s, pieces: Object.values(s.composition).reduce((n, count) => n + count, 0) }));
      if (!clean.length || clean.some((s) => !s.name.trim() || !s.pieces || s.moqSeries < 1 || s.pricePerSeries < 1)) return st;
      return {
        ...st,
        products: st.products.map((p) => {
          if (p.id !== id) return p;
          const offered = clean.filter((s) => s.available);
          return {
            ...p, series: clean, seriesCount: clean.length,
            wholesaleFrom: Math.min(...(offered.length ? offered : clean).map((s) => s.pricePerSeries)),
            moq: Math.min(...(offered.length ? offered : clean).map((s) => s.moqSeries)),
            // Published supplier edits go through marketplace moderation again.
            status: p.supplierId !== "kolbe" && p.status === "published" ? "pending" : p.status,
          };
        }),
        wcart: st.wcart.filter((l) => l.productId !== id || clean.some((s) => s.id === l.seriesId && s.available)),
      };
    }),
    ensureAccount: (phone) => {
      const normalized = digitsOnly(phone);
      const existing = state.accounts.find((a) => a.phone === normalized);
      if (existing) return existing.id;
      const id = `acc-${Date.now()}`;
      setState((st) => {
        if (st.accounts.some((a) => a.phone === normalized)) return st;
        return { ...st, accounts: [...st.accounts, {
          id, phone: normalized, name: "مشتری کلبه", email: "", birthday: "", joinedAt: new Date().toLocaleDateString("fa-IR"),
          addresses: [], wishlist: [], cart: [],
          preferences: { orderUpdates: true, offers: false, sms: true, email: false },
          savedStyles: [], tickets: [],
        }] };
      });
      return id;
    },
    updateAccount: (id, patch) => setState((st) => ({ ...st, accounts: st.accounts.map((a) => a.id === id ? { ...a, ...patch } : a) })),
    requestVip: (accountId, application) => setState((st) => {
      const account = st.accounts.find((a) => a.id === accountId);
      if (!account || st.buyers.some((b) => b.accountId === accountId)) return st;
      const plan = st.plans.find((p) => p.id === application.planId && p.active);
      if (!plan) return st;
      return { ...st, buyers: [{
        id: `b-${Date.now()}`, accountId, name: `${application.businessName.trim()} — ${application.city.trim()}`,
        city: application.city.trim(), planId: plan.id, status: "در انتظار تأیید" as const,
        since: new Date().toLocaleDateString("fa-IR"), submittedAt: new Date().toLocaleDateString("fa-IR"),
        contact: account.phone, tradeCode: application.tradeCode.trim(), spent: 0,
      }, ...st.buyers] };
    }),
    saveStyle: (accountId, productIds, title) => setState((st) => ({
      ...st, accounts: st.accounts.map((a) => a.id === accountId
        ? { ...a, savedStyles: [{ id: `look-${Date.now()}`, title: title.trim() || "استایل من", productIds, savedAt: new Date().toLocaleDateString("fa-IR") } as SavedStyle, ...a.savedStyles] }
        : a),
    })),
    addTicket: (accountId, subject, message) => setState((st) => ({
      ...st, accounts: st.accounts.map((a) => a.id === accountId
        ? { ...a, tickets: [{ id: `TK-${Date.now()}`, subject: subject.trim(), message: message.trim(), createdAt: new Date().toLocaleDateString("fa-IR"), status: "در انتظار" as const }, ...a.tickets] }
        : a),
    })),
    setTicketStatus: (accountId, ticketId, status) => setState((st) => ({
      ...st, accounts: st.accounts.map((a) => a.id === accountId
        ? { ...a, tickets: a.tickets.map((ticket) => ticket.id === ticketId ? { ...ticket, status } : ticket) }
        : a),
    })),
    placeRetailOrder: (accountId, cart, address, shippingMethod, shippingFee, discount = 0, discountNote, paymentMode = "cash") => {
      const account = state.accounts.find((a) => a.id === accountId);
      const counts = new Map<string, number>();
      cart.forEach((line) => counts.set(line.id, (counts.get(line.id) ?? 0) + line.qty));
      const lines = cart.map((line) => {
        const p = state.products.find((product) => product.id === line.id && product.status === "published");
        return p && line.qty > 0 && p.stock >= (counts.get(line.id) ?? 0)
          ? { productId: p.id, name: p.name, image: p.images[0], color: line.color, size: line.size, qty: line.qty, unitPrice: paymentMode === "four_installments" ? p.installmentPrice ?? p.retailPrice : p.retailPrice }
          : null;
      });
      if (!account || !cart.length || lines.some((line) => !line) || !shippingMethod || !address.line || !address.city) return null;
      const id = `KV-${Math.max(88214, ...state.retailOrders.map((o) => Number(o.id.replace("KV-", "")) || 0)) + 1}`;
      const validLines = lines.filter((line): line is NonNullable<typeof line> => line !== null);
      const order: RetailOrder = {
        id, accountId, createdAt: new Date().toLocaleString("fa-IR"), status: "پرداخت شد", lines: validLines, paymentMode,
        shippingMethod, shippingFee, address,
        total: Math.max(0, validLines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0) - discount) + shippingFee,
        events: [{ title: `سفارش و پرداخت آزمایشی ثبت شد${discountNote ? ` · ${discountNote}` : ""}`, time: new Date().toLocaleString("fa-IR") }],
      };
      setState((st) => ({ ...st,
        retailOrders: [order, ...st.retailOrders],
        products: st.products.map((p) => counts.has(p.id) ? { ...p, stock: Math.max(0, p.stock - (counts.get(p.id) ?? 0)) } : p),
        accounts: st.accounts.map((a) => a.id === accountId ? { ...a, cart: [] } : a),
      }));
      return id;
    },
    requestRetailReturn: (accountId, orderId, reason) => setState((st) => ({
      ...st, retailOrders: st.retailOrders.map((o) => o.id === orderId && o.accountId === accountId && o.status === "تحویل شد" && !o.returnRequest
        ? { ...o, returnRequest: { reason: reason.trim(), createdAt: new Date().toLocaleDateString("fa-IR"), status: "در انتظار بررسی" as const } }
        : o),
    })),
    setRetailOrderStatus: (id, status, note) => setState((st) => {
      const order = st.retailOrders.find((item) => item.id === id);
      if (!order || order.status === status) return st;
      const delta = order.status !== "لغو شد" && status === "لغو شد" ? 1
        : order.status === "لغو شد" && status !== "لغو شد" ? -1 : 0;
      const quantities = new Map<string, number>();
      order.lines.forEach((line) => quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.qty));
      if (delta < 0 && st.products.some((product) => quantities.has(product.id) && product.stock < quantities.get(product.id)!)) return st;
      return {
        ...st,
        products: delta ? st.products.map((product) => quantities.has(product.id)
          ? { ...product, stock: product.stock + delta * quantities.get(product.id)! } : product) : st.products,
        retailOrders: st.retailOrders.map((item) => item.id === id ? {
          ...item, status, events: [...item.events, { title: `وضعیت سفارش: ${status}`, time: new Date().toLocaleString("fa-IR"), by: "تیم عملیات کلبه", note: note?.trim() || undefined }],
        } : item),
      };
    }),
    setReturnStatus: (id, status) => setState((st) => ({ ...st,
      retailOrders: st.retailOrders.map((o) => o.id === id && o.returnRequest ? { ...o, returnRequest: { ...o.returnRequest, status }, status: status === "تأیید شد" ? "مرجوعی" : o.status } : o),
    })),

    wcartAdd: (line) => setState((st) => {
      const i = st.wcart.findIndex((l) => l.accountId === line.accountId && l.productId === line.productId && l.seriesId === line.seriesId && l.color === line.color);
      if (i >= 0) { const w = [...st.wcart]; w[i] = { ...w[i], qtySeries: w[i].qtySeries + line.qtySeries }; return { ...st, wcart: w }; }
      return { ...st, wcart: [...st.wcart, line] };
    }),
    wcartRemove: (i) => setState((st) => ({ ...st, wcart: st.wcart.filter((_, j) => j !== i) })),
    wcartQty: (i, q) => setState((st) => ({ ...st, wcart: st.wcart.map((l, j) => (j === i ? { ...l, qtySeries: Math.max(1, q) } : l)) })),
    wcartClear: () => setState((st) => ({ ...st, wcart: [] })),

    placeOrder: (buyer, shippingMethod, address, accountId, discountPercent = 0) => {
      const n = Math.max(1000, ...state.orders.map((o) => Number(o.id.replace("WO-", "")) || 0)) + 1;
      const id = `WO-${n}`;
      setState((st) => {
        const groups = new Map<string, WholesaleCartLine[]>();
        st.wcart.filter((l) => l.accountId === accountId).forEach((l) => {
          const p = st.products.find((x) => x.id === l.productId);
          if (!p) return;
          groups.set(p.supplierId, [...(groups.get(p.supplierId) ?? []), l]);
        });
        const subOrders: SubOrder[] = Array.from(groups.entries()).map(([sid, lines], i) => {
          const p0 = st.products.find((x) => x.id === lines[0].productId)!;
          const ol: OrderLine[] = lines.map((l) => {
            const p = st.products.find((x) => x.id === l.productId)!;
            const s = p.series.find((x) => x.id === l.seriesId) ?? p.series[0];
            return { productId: p.id, name: p.name, image: p.images[0], seriesName: s.name, color: l.color, qtySeries: l.qtySeries, pieces: s.pieces * l.qtySeries, pricePerSeries: Math.round(s.pricePerSeries * (1 - Math.min(90, Math.max(0, discountPercent)) / 100)) };
          });
          return {
            id: `${id}-${i + 1}`, supplierId: sid, supplierName: p0.supplier, lines: ol,
            total: ol.reduce((a, l) => a + l.pricePerSeries * l.qtySeries, 0),
            status: "pending_supplier", events: [{ t: EVENT_TEXT.pending_supplier, time: nowLabel(), by: buyer }],
          };
        });
        if (subOrders.length === 0) return st;
        return { ...st, orders: [{ id, buyer, accountId, createdAt: nowLabel(), shippingMethod, address, subOrders }, ...st.orders], wcart: st.wcart.filter((l) => l.accountId !== accountId) };
      });
      return id;
    },
    transitionSub: (parentId, subId, status, by, extra) => patchSub(parentId, subId, (s) => move(s, status, by, extra)),
    paySub: (parentId, subId, by) => patchSub(parentId, subId, (s) => (s.status === "approved" ? move(s, "paid", by) : s)),
    payParent: (parentId, by) => setState((st) => ({ ...st, orders: st.orders.map((o) => (o.id !== parentId ? o : { ...o, subOrders: o.subOrders.map((s) => (s.status === "approved" ? move(s, "paid", by) : s)) })) })),

    upsertPlan: (p) => setState((st) => ({ ...st, plans: st.plans.some((x) => x.id === p.id) ? st.plans.map((x) => (x.id === p.id ? p : x)) : [...st.plans, p] })),
    removePlan: (id) => setState((st) => ({ ...st, plans: st.plans.filter((x) => x.id !== id) })),
    upsertShipping: (m) => setState((st) => ({ ...st, shipping: st.shipping.some((x) => x.id === m.id) ? st.shipping.map((x) => (x.id === m.id ? m : x)) : [...st.shipping, m] })),
    removeShipping: (id) => setState((st) => ({ ...st, shipping: st.shipping.filter((x) => x.id !== id) })),
    toggleIntegration: (id) => setState((st) => ({ ...st, integrations: st.integrations.map((i) => (i.id === id ? { ...i, connected: !i.connected, lastSync: !i.connected ? "لحظاتی پیش" : undefined } : i)) })),
    setBuyer: (id, patch) => setState((st) => ({ ...st, buyers: st.buyers.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
    setNotif: (id, patch) => setState((st) => ({ ...st, notifs: st.notifs.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),
    upsertCms: (item) => setState((st) => ({ ...st, cms: st.cms.some((x) => x.id === item.id) ? st.cms.map((x) => (x.id === item.id ? item : x)) : [item, ...st.cms] })),
    reset: () => setState(initial()),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore() {
  const c = useContext(Ctx);
  if (!c) throw new Error("StoreProvider missing");
  return c;
}
