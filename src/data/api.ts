/**
 * Unified API client for Kolbe Vintage — the ONLY component-facing API layer.
 *
 * Components must never call `src/data/admin-api.ts` directly. Everything
 * authenticated goes through `authFetch` here, which:
 *   1. attaches the access token automatically,
 *   2. on 401 performs exactly ONE refresh + retry,
 *   3. stores the refreshed token,
 *   4. clears session state and notifies subscribers when refresh fails.
 *
 * Public endpoints (login/register/catalog/public CMS) use `publicApi`.
 * Business data comes from PostgreSQL via Fastify; localStorage stores only the
 * access token and UI prefs.
 */
import {
  apiCall, refreshAdminToken, AdminApiError, getApiBaseUrl, setApiBaseUrl,
  type ApiRequest,
} from "./admin-api";
import type {
  TicketCreate, TicketReply, TicketUpdate, Ticket, TicketBoard,
  ShippingMethodInput, ShippingSettings,
} from "./contracts";
import {
  normalizeIntegrationLogs, normalizeIntegrations, normalizeShippingMethods, normalizeShippingSettings, readCmsBootstrap,
} from "./contracts";

export { AdminApiError, getApiBaseUrl, setApiBaseUrl };
export type { ApiRequest };

/* ------------------------------ session ------------------------------ */

let accessToken: string | null = (() => {
  try { return localStorage.getItem("kolbe-access-token"); } catch { return null; }
})();

export const setAccessToken = (token: string | null) => {
  accessToken = token;
  try {
    if (token) localStorage.setItem("kolbe-access-token", token);
    else localStorage.removeItem("kolbe-access-token");
  } catch { /* storage unavailable (Node smoke / private mode) */ }
};
export const getAccessToken = () => accessToken;
/** Session presence check for UI gating — components must not read the token itself. */
export const isAuthenticated = () => accessToken !== null;

type AuthExpiredHandler = () => void;
const authExpiredHandlers = new Set<AuthExpiredHandler>();

/** Subscribe to refresh failure (hard logout). Returns an unsubscribe function. */
export function onAuthExpired(handler: AuthExpiredHandler) {
  authExpiredHandlers.add(handler);
  return () => { authExpiredHandlers.delete(handler); };
}

function expireSession() {
  setAccessToken(null);
  for (const handler of [...authExpiredHandlers]) {
    try { handler(); } catch { /* subscriber errors must not break the client */ }
  }
}

let refreshPromise: Promise<{ accessToken: string }> | null = null;
function refreshOnce() {
  if (!refreshPromise) {
    refreshPromise = refreshAdminToken().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/** Authenticated transport with single-refresh retry. */
export async function authFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const initial = getAccessToken();
  try {
    return await apiCall<T>(path, init, initial ?? undefined);
  } catch (error) {
    if (!(error instanceof AdminApiError) || error.status !== 401) throw error;
    if (!initial) { expireSession(); throw error; }
    try {
      const refreshed = await refreshOnce();
      setAccessToken(refreshed.accessToken);
      return await apiCall<T>(path, init, refreshed.accessToken);
    } catch {
      expireSession();
      throw error;
    }
  }
}

/* --------------------------- generic client --------------------------- */

const withBody = (init: RequestInit, body: unknown): RequestInit =>
  body === undefined ? init : { ...init, body: JSON.stringify(body) };

export const apiClient = {
  request: authFetch,
  get: <T>(path: string, init?: RequestInit) => authFetch<T>(path, { ...init, method: "GET" }),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => authFetch<T>(path, withBody({ ...init, method: "POST" }, body)),
  patch: <T>(path: string, body?: unknown, init?: RequestInit) => authFetch<T>(path, withBody({ ...init, method: "PATCH" }, body)),
  put: <T>(path: string, body?: unknown, init?: RequestInit) => authFetch<T>(path, withBody({ ...init, method: "PUT" }, body)),
  del: <T>(path: string, init?: RequestInit) => authFetch<T>(path, { ...init, method: "DELETE" }),
  /** Multipart upload — no manual Content-Type (browser sets the boundary). */
  upload: <T>(path: string, form: FormData, init?: RequestInit) => authFetch<T>(path, { ...init, method: "POST", body: form }),
};

/** Public, unauthenticated endpoints only (login/register/catalog/public site). */
export const publicApi = {
  get: <T>(path: string, init?: RequestInit) => apiCall<T>(path, { ...init, method: "GET" }),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => apiCall<T>(path, withBody({ ...init, method: "POST" }, body)),
};

/* ------------------------------- auth ------------------------------- */

export const authApi = {
  register: (payload: { email?: string; phone?: string; password: string; displayName: string }) =>
    publicApi.post<{ id: string }>("/auth/register", payload),
  login: async (payload: { identity: string; password: string }) => {
    const res = await publicApi.post<{ accessToken: string }>("/auth/login", payload);
    setAccessToken(res.accessToken);
    return res;
  },
  refresh: refreshOnce,
  me: () => authFetch<{ id: string; displayName: string; roles: string[]; permissions: string[]; preferences?: Record<string, boolean> }>("/auth/me"),
  updateProfile: (payload: { displayName?: string; email?: string | null; birthday?: string | null }) =>
    authFetch<unknown>("/auth/me", { method: "PATCH", body: JSON.stringify(payload) }),
  updatePreference: (key: string, value: boolean) =>
    authFetch<{ preferences: Record<string, boolean> }>("/auth/me/preferences", { method: "PATCH", body: JSON.stringify({ [key]: value }) }),
  logout: async () => {
    await publicApi.post("/auth/logout").catch(() => undefined);
    setAccessToken(null);
  },
};

/* ------------------------------ catalog ------------------------------ */

export type CatalogItem = {
  id: string; brand: string; name: string; category: string; description: string;
  cashPriceRial: string; installmentPriceRial: string | null; metadata: Record<string, unknown>;
  variants: { id: string; sku: string; size: string | null; color: string | null }[]; createdAt: string;
};

export const catalogApi = {
  list: (params?: { category?: string; limit?: number; before?: string }) => {
    const q = new URLSearchParams();
    if (params?.category) q.set("category", params.category);
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.before) q.set("before", params.before);
    return publicApi.get<{ items: CatalogItem[] }>(`/products?${q.toString()}`);
  },
  create: (payload: unknown) => authFetch<{ id: string; status: string; variants: { id: string; sku: string }[] }>(
    "/products", { method: "POST", body: JSON.stringify(payload) }),
};

/** Product editor (ProductStudio) contract. */
export const productsApi = {
  /** Admin/product pickers need the full catalogue view (variants incl. ids). */
  list: async (params?: Record<string, string>) => {
    const query = new URLSearchParams(params);
    const raw = await publicApi.get<{ items: CatalogItem[] }>(`/products?${query.toString()}`);
    return { items: raw.items };
  },
  create: (payload: unknown) => apiClient.post<{ id: string; status: string; variants: { id: string; sku: string }[] }>("/products", payload),
  update: (id: string, payload: unknown) => apiClient.patch<{ id: string; updated: string[] }>(`/products/${id}`, payload),
  status: (id: string, status: "published" | "draft" | "rejected" | "archived") =>
    apiClient.patch<{ id: string; status: string }>(`/products/${id}/status`, { status }),
  /** Cutout/style-builder state has no dedicated column yet → metadata bucket. */
  cutout: async (id: string, metadata: Record<string, unknown>, cutout: unknown) =>
    apiClient.patch<{ id: string }>(`/products/${id}`, { metadata: { ...metadata, cutout } }),
};

/* -------------------------------- files -------------------------------- */

export type FileUploadResult = { id: string; storageKey: string; originalName: string; mime: string; size: number; sha256: string };

export const filesApi = {
  /** POST /files as multipart — the canonical way to persist any product/CMS/ticket media. */
  upload: (file: File | Blob, fileName?: string) => {
    const form = new FormData();
    form.append("file", file, fileName ?? (file instanceof File ? file.name : "upload.bin"));
    return apiClient.upload<FileUploadResult>("/files", form);
  },
  downloadPath: (fileId: string) => `/api/v1/files/${fileId}`,
};

/* ------------------------------ inventory ------------------------------ */

export const inventoryApi = {
  warehouses: () => authFetch<{ items: { id: string; code: string; name: string; owner_id: string | null }[] }>("/warehouses"),
  warehouseDetail: (id: string) => authFetch<{ id: string; code: string; name: string; locations: unknown[]; balances: unknown[] }>(`/warehouses/${id}`),
  createWarehouse: (payload: { code: string; name: string }) => authFetch<{ id: string }>("/warehouses", { method: "POST", body: JSON.stringify(payload) }),
  locations: (warehouseId: string) => authFetch<{ items: unknown[] }>(`/warehouses/${warehouseId}/locations`),
  createLocation: (warehouseId: string, payload: { code: string; name: string }) => authFetch<unknown>(`/warehouses/${warehouseId}/locations`, { method: "POST", body: JSON.stringify(payload) }),
  balances: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) q.set(k, String(v));
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
  /** Per-variant WMS inventory of one product (read-only view inside ProductStudio). */
  productInventory: (productId: string) => authFetch<unknown>(`/admin/products/${productId}/inventory`),
};

/* -------------------------------- orders -------------------------------- */

export type OrderSummary = { id: string; reference: string; status: string; total_rial: string; order_type: string; created_at: string };

export const ordersApi = {
  list: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: OrderSummary[] }>(`/orders?${q.toString()}`);
  },
  get: (id: string) => authFetch<unknown>(`/orders/${id}`),
  create: (payload: unknown, key: string) => authFetch<unknown>("/orders", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  transition: (id: string, payload: { status: string; note?: string }) => authFetch<unknown>(`/orders/${id}/transitions`, { method: "POST", body: JSON.stringify(payload) }),
  supplierList: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/supplier/orders?${q.toString()}`);
  },
  supplierDetail: (id: string) => authFetch<unknown>(`/supplier/orders/${id}`),
  supplierFulfillment: (id: string, payload: { status: string; note?: string; trackingCode?: string }) =>
    authFetch<unknown>(`/supplier/orders/${id}/fulfillment`, { method: "POST", body: JSON.stringify(payload) }),
};

/* -------------------------------- returns -------------------------------- */

export const returnsApi = {
  list: () => authFetch<{ items: Record<string, unknown>[] }>("/returns"),
  create: (payload: { orderId: string; reason: string; resolution: "refund" | "exchange" | "credit" }) =>
    authFetch<{ id: string; reference: string }>("/returns", { method: "POST", body: JSON.stringify(payload) }),
};

/* ------------------------------- membership ------------------------------- */

export const membershipApi = {
  request: (payload: { planId: string; businessName: string; city: string; tradeCode: string }) =>
    authFetch<unknown>("/memberships", { method: "POST", body: JSON.stringify(payload) }),
  current: () => authFetch<unknown>("/membership/current"),
  wholesaleProducts: (limit = 30) => authFetch<{ items: unknown[] }>(`/wholesale/products?limit=${limit}`),
};

/* -------------------------------- invoices -------------------------------- */

export const invoicesApi = {
  list: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/invoices?${q.toString()}`);
  },
  get: (id: string) => authFetch<unknown>(`/invoices/${id}`),
  create: (payload: unknown) => authFetch<unknown>("/invoices", { method: "POST", body: JSON.stringify(payload) }),
  pay: (id: string, payload: { amountRial: string; method?: string; traceCode?: string; note?: string }) =>
    authFetch<unknown>(`/invoices/${id}/payments`, { method: "POST", body: JSON.stringify(payload) }),
  pdfUrl: (id: string) => `${getApiBaseUrl()}/api/v1/invoices/${id}/pdf`,
};

/* --------------------------- wallet / settlements --------------------------- */

export const walletApi = {
  get: () => authFetch<unknown>("/wallet"),
  entries: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/wallet/entries?${q.toString()}`);
  },
  withdraw: (payload: { amountRial: string; destination: { bankName: string; iban: string; holderName: string } }, key: string) =>
    authFetch<unknown>("/wallet/withdrawals", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  withdrawals: () => authFetch<{ items: unknown[] }>("/wallet/withdrawals"),
  adminWithdrawals: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/withdrawals?${q.toString()}`);
  },
  updateWithdrawal: (id: string, payload: unknown) => authFetch<unknown>(`/admin/withdrawals/${id}/status`, { method: "POST", body: JSON.stringify(payload) }),
  settlements: () => authFetch<{ items: unknown[] }>("/settlements"),
  createSettlement: (payload: { partyUserId: string; amountRial: string; note?: string }) => authFetch<unknown>("/settlements", { method: "POST", body: JSON.stringify(payload) }),
  settle: (id: string, payload?: unknown) => authFetch<unknown>(`/settlements/${id}/settle`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
};

/* ------------------------------- supplier ------------------------------- */

export const supplierApi = {
  stats: (period = "30d") => authFetch<unknown>(`/supplier/stats?period=${period}`),
};

/* ------------------------------- wishlist ------------------------------- */

export const wishlistApi = {
  collections: () => authFetch<{ items: unknown[] }>("/wishlist/collections"),
  createCollection: (title: string) => authFetch<unknown>("/wishlist/collections", { method: "POST", body: JSON.stringify({ title }) }),
  deleteCollection: (id: string) => authFetch<unknown>(`/wishlist/collections/${id}`, { method: "DELETE" }),
  addItem: (collectionId: string, payload: { productId: string; variantId?: string | null }) =>
    authFetch<unknown>(`/wishlist/collections/${collectionId}/items`, { method: "POST", body: JSON.stringify(payload) }),
  removeItem: (itemId: string) => authFetch<unknown>(`/wishlist/items/${itemId}`, { method: "DELETE" }),
  collectionItems: (collectionId: string) => authFetch<{ items: unknown[] }>(`/wishlist/collections/${collectionId}/items`),
  alerts: () => authFetch<{ items: unknown[] }>("/wishlist/alerts"),
  addAlert: (payload: { productId: string; kind: string }) => authFetch<unknown>("/wishlist/alerts", { method: "POST", body: JSON.stringify(payload) }),
};

/* ------------------------------- addresses ------------------------------- */

export const addressesApi = {
  list: () => authFetch<{ items: unknown[] }>("/addresses"),
  create: (payload: unknown) => authFetch<unknown>("/addresses", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: unknown) => authFetch<unknown>(`/addresses/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  remove: (id: string) => authFetch<unknown>(`/addresses/${id}`, { method: "DELETE" }),
};

/* -------------------------------- finance -------------------------------- */

export const financeApi = {
  journal: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/journal?${q.toString()}`);
  },
  accounts: () => authFetch<{ items: unknown[] }>("/admin/journal/accounts"),
  stats: () => authFetch<unknown>("/admin/journal/stats"),
  auditLogs: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/audit-logs?${q.toString()}`);
  },
};

/* ---------------------------------- CRM ---------------------------------- */

export const crmApi = {
  contacts: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/crm/contacts?${q.toString()}`);
  },
  contact: (id: string) => authFetch<unknown>(`/admin/crm/contacts/${id}`),
  activities: (contactId: string) => authFetch<{ items: unknown[] }>(`/admin/crm/contacts/${contactId}/activities`),
  addActivity: (contactId: string, payload: { type: string; title: string; body: string }) =>
    authFetch<unknown>(`/admin/crm/contacts/${contactId}/activities`, { method: "POST", body: JSON.stringify(payload) }),
  automations: () => authFetch<{ items: unknown[] }>("/admin/crm/automations"),
  runAutomation: (id: string) => authFetch<unknown>(`/admin/crm/automations/${id}/run`, { method: "POST" }),
};

/* ---------------------------------- CMS ---------------------------------- */

export const cmsApi = {
  pages: () => authFetch<{ items: unknown[] }>("/admin/cms/pages"),
  createPage: (payload: { code: string; title: string; path: string; description: string; seo: Record<string, unknown>; active: boolean }) =>
    authFetch<unknown>("/admin/cms/pages", { method: "POST", body: JSON.stringify(payload) }),
  sections: (pageId: string) => authFetch<{ items: unknown[] }>(`/admin/cms/pages/${pageId}/sections`),
  createSection: (pageId: string, payload: unknown) =>
    authFetch<unknown>(`/admin/cms/pages/${pageId}/sections`, { method: "POST", body: JSON.stringify(payload) }),
  updateSection: (sectionId: string, payload: unknown) =>
    authFetch<unknown>(`/admin/cms/sections/${sectionId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteSection: (sectionId: string) => authFetch<unknown>(`/admin/cms/sections/${sectionId}`, { method: "DELETE" }),
  reorderSections: (pageId: string, sectionIds: string[]) =>
    authFetch<unknown>(`/admin/cms/pages/${pageId}/sections/reorder`, { method: "POST", body: JSON.stringify({ sectionIds }) }),
  components: () => authFetch<{ items: unknown[] }>("/admin/cms/components"),
  palettes: () => authFetch<{ items: unknown[] }>("/admin/cms/palettes"),
  createPalette: (payload: { code: string; name: string; colors: unknown }) =>
    authFetch<unknown>("/admin/cms/palettes", { method: "POST", body: JSON.stringify(payload) }),
  activatePalette: (paletteId: string, payload: { mode: string; startsAt: string; festivalId?: string }) =>
    authFetch<unknown>(`/admin/cms/palettes/${paletteId}/activations`, { method: "POST", body: JSON.stringify(payload) }),
  /** One-click, idempotent CMS bootstrap: home page + hero + base sections + default palette. */
  bootstrap: () => authFetch<unknown>("/admin/cms/bootstrap", { method: "POST" }).then(readCmsBootstrap),
  /** Idempotent creation of the default palette (used by the «ایجاد پالت اصلی» CTA). */
  defaultPalette: () => authFetch<{ palette: unknown; created: boolean; activated: boolean }>("/admin/cms/palettes/default", { method: "POST" }),
  supportWidget: () => authFetch<{ widget: unknown }>("/admin/site-settings/support-widget"),
  saveSupportWidget: (widget: unknown) => authFetch<unknown>("/admin/site-settings/support-widget", { method: "PUT", body: JSON.stringify(widget) }),
  /* public site rendering (no token) */
  activePalette: () => publicApi.get<{ palette: unknown | null }>("/site/active-palette"),
  sitePage: (code: string) => publicApi.get<unknown>(`/site/pages/${code}`),
};

/* ----------------------------- notifications ----------------------------- */

export const notificationsApi = {
  list: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/notifications?${q.toString()}`);
  },
  unreadCount: () => authFetch<{ count: number }>("/notifications/unread-count"),
  read: (id: string) => authFetch<unknown>(`/notifications/${id}/read`, { method: "POST" }),
  readAll: () => authFetch<unknown>("/notifications/read-all", { method: "POST" }),
  routes: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/notification-routes"),
  updateRoute: (id: string, payload: unknown) => authFetch<unknown>(`/admin/notification-routes/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
};

/* -------------------------------- tickets -------------------------------- */

export const ticketsApi = {
  list: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/tickets?${q.toString()}`);
  },
  board: () => authFetch<{ columns: Record<string, unknown[]> }>("/tickets/board"),
  get: (id: string) => authFetch<unknown>(`/tickets/${id}`),
  /** Payload built by `buildTicketCreatePayload` — subject/category/priority/orderId/message. */
  create: (payload: TicketCreate) => authFetch<{ id: string; reference: string; status: string; priority: string }>(
    "/tickets", { method: "POST", body: JSON.stringify(payload) }),
  reply: (id: string, payload: TicketReply) => authFetch<{ id: string; status: string }>(
    `/tickets/${id}/messages`, { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: TicketUpdate) => authFetch<{ id: string; status: string }>(
    `/tickets/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  /** Multipart attachment (FormData) — never JSON. */
  attach: (id: string, file: File | Blob, fileName?: string, title?: string) => {
    const form = new FormData();
    form.append("file", file, fileName ?? (file instanceof File ? file.name : "attachment.bin"));
    if (title) form.append("title", title);
    return apiClient.upload<unknown>(`/tickets/${id}/attachments`, form);
  },
  /** Adapter-friendly read of one ticket (callers map with `normalizeTicket`). */
  detail: async (id: string): Promise<Ticket> => {
    const raw = await authFetch<unknown>(`/tickets/${id}`);
    const { normalizeTicket } = await import("./contracts");
    const ticket = normalizeTicket(raw);
    if (!ticket) throw new AdminApiError("تیکت یافت نشد.", 404);
    return ticket;
  },
  /** Admin Kanban: consumes `columns` from the server. */
  boardMap: async (): Promise<TicketBoard> => {
    const raw = await authFetch<unknown>("/tickets/board");
    const { adaptTicketBoard } = await import("./contracts");
    return adaptTicketBoard(raw);
  },
};

/* --------------------------- coupons / festivals --------------------------- */

export const promoApi = {
  coupons: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: unknown[] }>(`/admin/coupons?${q.toString()}`);
  },
  createCoupon: (payload: unknown) => authFetch<unknown>("/admin/coupons", { method: "POST", body: JSON.stringify(payload) }),
  deleteCoupon: (id: string) => authFetch<unknown>(`/admin/coupons/${id}`, { method: "DELETE" }),
  festivals: () => authFetch<{ items: unknown[] }>("/admin/festivals"),
  createFestival: (payload: unknown) => authFetch<unknown>("/admin/festivals", { method: "POST", body: JSON.stringify(payload) }),
  validate: (payload: { code: string; orderType?: string; items: { productId: string; category: string; totalRial: string }[] }) =>
    authFetch<{ valid: boolean; discountRial: string; message?: string }>("/coupons/validate", { method: "POST", body: JSON.stringify(payload) }),
};

/* ------------------------------ integrations ------------------------------ */

export const integrationsApi = {
  list: () => authFetch<unknown>("/admin/integrations").then((raw) => ({ items: normalizeIntegrations(raw) })),
  create: (payload: unknown) => authFetch<unknown>("/admin/integrations", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: unknown) => authFetch<unknown>(`/admin/integrations/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  test: (id: string) => authFetch<{ status: string; httpStatus: number | null; error: string | null; attempt: number }>(
    `/admin/integrations/${id}/test`, { method: "POST" }),
  logs: (id: string) => authFetch<unknown>(`/admin/integrations/${id}/logs`).then((raw) => ({ items: normalizeIntegrationLogs(raw) })),
};

/* -------------------------------- shipping -------------------------------- */

export const shippingApi = {
  /** Public checkout methods (no token). */
  list: () => publicApi.get<{ items: Record<string, unknown>[] }>("/shipping-methods"),
  adminList: () => authFetch<{ items: unknown[] }>("/admin/shipping-methods").then((res) => ({ items: normalizeShippingMethods(res) })),
  create: (payload: ShippingMethodInput) => authFetch<unknown>("/admin/shipping-methods", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: Partial<ShippingMethodInput>) =>
    authFetch<unknown>(`/admin/shipping-methods/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  remove: (id: string) => authFetch<unknown>(`/admin/shipping-methods/${id}`, { method: "DELETE" }),
  /** Global shipping rules: the default fulfillment warehouse must be a real warehouse UUID. */
  settings: () => authFetch<unknown>("/admin/site-settings/shipping").then(normalizeShippingSettings),
  saveSettings: (payload: ShippingSettings) =>
    authFetch<unknown>("/admin/site-settings/shipping", { method: "PUT", body: JSON.stringify(payload) })
      .then(normalizeShippingSettings),
  publicSettings: () => publicApi.get<unknown>("/site/shipping-settings").then(normalizeShippingSettings),
};

/* --------------------------- console admin surface --------------------------- */

export const adminApi = {
  summary: () => authFetch<Record<string, number>>("/admin/dashboard/summary"),
  supportAgents: () => authFetch<{ items: { id: string; displayName: string; roles: string[] }[] }>("/admin/support-agents"),
  memberships: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, unknown>[] }>(`/admin/memberships?${q.toString()}`);
  },
  updateMembership: (id: string, payload: unknown) => authFetch<unknown>(`/admin/memberships/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  restrictions: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/restrictions"),
  createRestriction: (payload: { userId: string; scope: string; reason: string }) =>
    authFetch<unknown>("/admin/restrictions", { method: "POST", body: JSON.stringify(payload) }),
  updateRestriction: (id: string, payload: unknown) => authFetch<unknown>(`/admin/restrictions/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  smsCampaigns: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/sms-campaigns"),
  createSmsCampaign: (payload: unknown) => authFetch<unknown>("/admin/sms-campaigns", { method: "POST", body: JSON.stringify(payload) }),
  updateSmsCampaign: (id: string, payload: unknown) => authFetch<unknown>(`/admin/sms-campaigns/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  sendSmsCampaign: (id: string) => authFetch<{ status: string; reason?: string; recipients?: number }>(`/admin/sms-campaigns/${id}/send`, { method: "POST" }),
  users: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/users"),
  cooperationRequests: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/cooperation-requests"),
  reviewCooperationRequest: (id: string, payload: { status: string; note?: string }) =>
    authFetch<unknown>(`/admin/cooperation-requests/${id}/review`, { method: "POST", body: JSON.stringify(payload) }),
  cooperationForm: () => publicApi.get<{ items: Record<string, unknown>[] }>("/cooperation-form"),
  saveCooperationForm: (fields: unknown[]) =>
    authFetch<unknown>("/admin/cooperation-form", { method: "PUT", body: JSON.stringify({ fields }) }),
  plans: () => authFetch<{ items: Record<string, unknown>[] }>("/plans"),
  createPlan: (payload: unknown) => authFetch<unknown>("/plans", { method: "POST", body: JSON.stringify(payload) }),
  updatePlan: (id: string, payload: unknown) => authFetch<unknown>(`/plans/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
};
