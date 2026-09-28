/**
 * Unified API client for Kolbe Vintage — single source of truth.
 * Business data (orders, products, inventory, wallet, etc.) comes from PostgreSQL via Fastify.
 * LocalStorage is only for theme/UI prefs, not business state.
 */
import { apiCall, refreshAdminToken, AdminApiError } from "./admin-api";

export { AdminApiError };

// Keep token in memory; also handle refresh via httpOnly cookie.
let accessToken: string | null = (() => {
  try { return localStorage.getItem("kolbe-access-token"); } catch { return null; }
})();
export const setAccessToken = (t: string | null) => {
  accessToken = t;
  try {
    if (t) localStorage.setItem("kolbe-access-token", t);
    else localStorage.removeItem("kolbe-access-token");
  } catch { /* ignore */ }
};
export const getAccessToken = () => accessToken;

async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const call = (token?: string) => apiCall<T>(path, init, token);
  try {
    return await call(accessToken ?? undefined);
  } catch (e) {
    if (e instanceof AdminApiError && e.status === 401 && accessToken) {
      try {
        const refreshed = await refreshAdminToken();
        setAccessToken(refreshed.accessToken);
        return await call(refreshed.accessToken);
      } catch { setAccessToken(null); throw e; }
    }
    throw e;
  }
}

// Auth
export const authApi = {
  register: (payload: { email?: string; phone?: string; password: string; displayName: string }) =>
    apiCall<{ id: string }>("/auth/register", { method: "POST", body: JSON.stringify(payload) }),
  login: async (payload: { identity: string; password: string }) => {
    const res = await apiCall<{ accessToken: string }>("/auth/login", { method: "POST", body: JSON.stringify(payload) });
    setAccessToken(res.accessToken);
    return res;
  },
  refresh: refreshAdminToken,
  me: () => authFetch<{ id: string; displayName: string; roles: string[]; permissions: string[] }>("/auth/me"),
  logout: async () => {
    await apiCall("/auth/logout", { method: "POST" });
    setAccessToken(null);
  },
};

// Catalog
export const catalogApi = {
  list: (params?: { category?: string; limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (params?.category) q.set("category", params.category);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.before) q.set("before", params.before);
    return apiCall<{ items: unknown[] }>(`/products?${q.toString()}`);
  },
  create: (payload: unknown, token?: string) => apiCall<{ id: string; variants: { id: string; sku: string }[] }>("/products", { method: "POST", body: JSON.stringify(payload) }, token),
};

// Inventory WMS
export const inventoryApi = {
  warehouses: () => authFetch<{ items: { id: string; code: string; name: string; owner_id: string | null }[] }>("/warehouses"),
  warehouseDetail: (id: string) => authFetch<{ id: string; code: string; name: string; locations: unknown[]; balances: unknown[] }>(`/warehouses/${id}`),
  createWarehouse: (payload: { code: string; name: string }) => authFetch<{ id: string }>("/warehouses", { method: "POST", body: JSON.stringify(payload) }),
  locations: (warehouseId: string) => authFetch<{ items: unknown[] }>(`/warehouses/${warehouseId}/locations`),
  createLocation: (warehouseId: string, payload: { code: string; name: string }) => authFetch<unknown>(`/warehouses/${warehouseId}/locations`, { method: "POST", body: JSON.stringify(payload) }),
  balances: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k,v] of Object.entries(params)) q.set(k, String(v));
    return authFetch<{ items: unknown[] }>(`/inventory?${q.toString()}`);
  },
  lowStock: (threshold = 10) => authFetch<{ items: unknown[] }>(`/inventory/low-stock?threshold=${threshold}`),
  movements: (variantId: string) => authFetch<{ items: unknown[] }>(`/inventory/movements?variantId=${variantId}`),
  adjust: (payload: { variantId: string; warehouseId: string; delta: number; reason: string; reference: string }, idempotencyKey: string) =>
    authFetch<unknown>("/inventory/adjustments", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
  damaged: (payload: { variantId: string; warehouseId: string; quantity: number; reason: string }) =>
    authFetch<unknown>("/inventory/damaged", { method: "POST", body: JSON.stringify(payload) }),
  receipt: (payload: { warehouseId: string; variantId: string; quantity: number; reference?: string }, key: string) =>
    authFetch<unknown>("/inventory/receipts", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  receiveReceipt: (id: string) => authFetch<unknown>(`/inventory/receipts/${id}/receive`, { method: "POST" }),
  receipts: () => authFetch<{ items: unknown[] }>("/inventory/receipts"),
  transfer: (payload: { fromWarehouseId: string; toWarehouseId: string; lines: { variantId: string; quantity: number }[]; reference?: string }) =>
    authFetch<unknown>("/inventory/transfers", { method: "POST", body: JSON.stringify(payload) }),
  completeTransfer: (id: string) => authFetch<unknown>(`/inventory/transfers/${id}/complete`, { method: "POST" }),
  transfers: () => authFetch<{ items: unknown[] }>("/inventory/transfers"),
};

// Orders
export const ordersApi = {
  list: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/orders?${q.toString()}`);
  },
  get: (id: string) => authFetch<unknown>(`/orders/${id}`),
  create: (payload: unknown, key: string) => authFetch<unknown>("/orders", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  transition: (id: string, payload: { status: string; note?: string }) => authFetch<unknown>(`/orders/${id}/transitions`, { method: "POST", body: JSON.stringify(payload) }),
  supplierList: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/supplier/orders?${q.toString()}`);
  },
  supplierDetail: (id: string) => authFetch<unknown>(`/supplier/orders/${id}`),
  supplierFulfillment: (id: string, payload: { status: string; note?: string; trackingCode?: string }) =>
    authFetch<unknown>(`/supplier/orders/${id}/fulfillment`, { method: "POST", body: JSON.stringify(payload) }),
};

// Invoices
export const invoicesApi = {
  list: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/invoices?${q.toString()}`);
  },
  get: (id: string) => authFetch<unknown>(`/invoices/${id}`),
  create: (payload: unknown) => authFetch<unknown>("/invoices", { method: "POST", body: JSON.stringify(payload) }),
  pay: (id: string, payload: { amountRial: string; method?: string; traceCode?: string; note?: string }) =>
    authFetch<unknown>(`/invoices/${id}/payments`, { method: "POST", body: JSON.stringify(payload) }),
  pdfUrl: (id: string) => `${(import.meta.env.VITE_API_BASE_URL ?? window.location.origin).replace(/\/$/,"")}/api/v1/invoices/${id}/pdf`,
};

// Wallet / Withdrawals / Settlements
export const walletApi = {
  get: () => authFetch<unknown>("/wallet"),
  entries: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/wallet/entries?${q.toString()}`);
  },
  withdraw: (payload: { amountRial: string; destination: { bankName: string; iban: string; holderName: string } }, key: string) =>
    authFetch<unknown>("/wallet/withdrawals", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  withdrawals: () => authFetch<{ items: unknown[] }>("/wallet/withdrawals"),
  adminWithdrawals: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/withdrawals?${q.toString()}`);
  },
  updateWithdrawal: (id: string, payload: unknown) => authFetch<unknown>(`/admin/withdrawals/${id}/status`, { method: "POST", body: JSON.stringify(payload) }),
  settlements: () => authFetch<{ items: unknown[] }>("/settlements"),
  createSettlement: (payload: { partyUserId: string; amountRial: string; note?: string }) => authFetch<unknown>("/settlements", { method: "POST", body: JSON.stringify(payload) }),
  settle: (id: string, payload?: unknown) => authFetch<unknown>(`/settlements/${id}/settle`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
};

// Supplier stats
export const supplierApi = {
  stats: (period: string = "30d") => authFetch<unknown>(`/supplier/stats?period=${period}`),
};

// Wishlist
export const wishlistApi = {
  collections: () => authFetch<{ items: unknown[] }>("/wishlist/collections"),
  createCollection: (title: string) => authFetch<unknown>("/wishlist/collections", { method: "POST", body: JSON.stringify({ title }) }),
  deleteCollection: (id: string) => authFetch<unknown>(`/wishlist/collections/${id}`, { method: "DELETE" }),
  addItem: (collectionId: string, payload: { productId: string; variantId?: string | null }) =>
    authFetch<unknown>(`/wishlist/collections/${collectionId}/items`, { method: "POST", body: JSON.stringify(payload) }),
  removeItem: (itemId: string) => authFetch<unknown>(`/wishlist/items/${itemId}`, { method: "DELETE" }),
  alerts: () => authFetch<{ items: unknown[] }>("/wishlist/alerts"),
  addAlert: (payload: { productId: string; kind: string }) => authFetch<unknown>("/wishlist/alerts", { method: "POST", body: JSON.stringify(payload) }),
};

// Addresses
export const addressesApi = {
  list: () => authFetch<{ items: unknown[] }>("/addresses"),
  create: (payload: unknown) => authFetch<unknown>("/addresses", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: unknown) => authFetch<unknown>(`/addresses/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  remove: (id: string) => authFetch<unknown>(`/addresses/${id}`, { method: "DELETE" }),
};

// Journal / Finance
export const financeApi = {
  journal: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/journal?${q.toString()}`);
  },
  accounts: () => authFetch<{ items: unknown[] }>("/admin/journal/accounts"),
  stats: () => authFetch<unknown>("/admin/journal/stats"),
  auditLogs: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/audit-logs?${q.toString()}`);
  },
};

// CRM
export const crmApi = {
  contacts: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/crm/contacts?${q.toString()}`);
  },
  contact: (id: string) => authFetch<unknown>(`/admin/crm/contacts/${id}`),
  activities: (contactId: string) => authFetch<{ items: unknown[] }>(`/admin/crm/contacts/${contactId}/activities`),
  automations: () => authFetch<{ items: unknown[] }>("/admin/crm/automations"),
  runAutomation: (id: string) => authFetch<unknown>(`/admin/crm/automations/${id}/run`, { method: "POST" }),
};

// CMS / Palettes
export const cmsApi = {
  pages: () => authFetch<{ items: unknown[] }>("/admin/cms/pages"),
  palettes: () => authFetch<{ items: unknown[] }>("/admin/cms/palettes"),
  activePalette: () => apiCall<{ palette: unknown | null }>("/site/active-palette"),
  sitePage: (code: string) => apiCall<unknown>(`/site/pages/${code}`),
};

// Notifications
export const notificationsApi = {
  list: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/notifications?${q.toString()}`);
  },
  unreadCount: () => authFetch<{ count: number }>("/notifications/unread-count"),
  read: (id: string) => authFetch<unknown>(`/notifications/${id}/read`, { method: "POST" }),
  readAll: () => authFetch<unknown>("/notifications/read-all", { method: "POST" }),
};

// Tickets
export const ticketsApi = {
  list: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/tickets?${q.toString()}`);
  },
  board: () => authFetch<{ columns: Record<string, unknown[]> }>("/tickets/board"),
  get: (id: string) => authFetch<unknown>(`/tickets/${id}`),
  create: (payload: unknown) => authFetch<unknown>("/tickets", { method: "POST", body: JSON.stringify(payload) }),
  reply: (id: string, payload: { message: string; internal?: boolean }) =>
    authFetch<unknown>(`/tickets/${id}/messages`, { method: "POST", body: JSON.stringify(payload) }),
  attach: (id: string, payload: unknown) => authFetch<unknown>(`/tickets/${id}/attachments`, { method: "POST", body: JSON.stringify(payload) }),
};

// Coupons / Festivals
export const promoApi = {
  coupons: (params?: Record<string,string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/coupons?${q.toString()}`);
  },
  festivals: () => authFetch<{ items: unknown[] }>("/admin/festivals"),
  createCoupon: (payload: unknown) => authFetch<unknown>("/admin/coupons", { method: "POST", body: JSON.stringify(payload) }),
  createFestival: (payload: unknown) => authFetch<unknown>("/admin/festivals", { method: "POST", body: JSON.stringify(payload) }),
  validate: (payload: { code: string; orderType?: string; items: { productId: string; category: string; totalRial: string }[] }) =>
    authFetch<{ valid: boolean; discountRial: string; message?: string }>("/coupons/validate", { method: "POST", body: JSON.stringify(payload) }),
};

// Integrations
export const integrationsApi = {
  list: () => authFetch<{ items: unknown[] }>("/admin/integrations"),
  test: (id: string) => authFetch<unknown>(`/admin/integrations/${id}/test`, { method: "POST" }),
  logs: (id: string) => authFetch<{ items: unknown[] }>(`/admin/integrations/${id}/logs`),
};
