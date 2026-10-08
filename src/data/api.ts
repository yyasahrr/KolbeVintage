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
  type ApiErrorDetails, type ApiRequest,
} from "./admin-api";
import type {
  TicketCreate, TicketReply, TicketUpdate, Ticket, TicketBoard,
  ShippingMethodInput, ShippingSettings,
} from "./contracts";
import {
  normalizeIntegrationLogs, normalizeIntegrations, normalizeShippingMethods, normalizeShippingSettings, readCmsBootstrap,
} from "./contracts";

export { AdminApiError, getApiBaseUrl, setApiBaseUrl };

/** Shared authenticated request for admin panels that are mounted outside AdminConsole (canonical hubs). */
export const serverRequest: ApiRequest = (path, init) => apiClient.request(path, init);
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

/**
 * Authorized binary fetch for documents the server protects (invoice PDFs,
 * template previews, report exports). Returns an object URL the caller must
 * revoke with `URL.revokeObjectURL` when it is done with it.
 */
export async function authBlobUrl(path: string, init: RequestInit = {}): Promise<string> {
  const request = (token: string | null) => fetch(`${getApiBaseUrl()}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  let response = await request(getAccessToken());
  if (response.status === 401 && getAccessToken()) {
    try {
      const refreshed = await refreshOnce();
      setAccessToken(refreshed.accessToken);
      response = await request(refreshed.accessToken);
    } catch {
      expireSession();
    }
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string; details?: ApiErrorDetails } | null;
    throw new AdminApiError(error?.message ?? `خطای سرویس (${response.status})`, response.status, error?.code, error?.details);
  }
  return URL.createObjectURL(await response.blob());
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
  /**
   * PUBLIC REGISTRATION — two entry points on ONE identity model:
   *   • mobile-first: `{ phone, code, displayName, email?, password? }` (the number is verified first)
   *   • email+password: `{ email, password, displayName }`
   * Both return the canonical account plus a real session, exactly like the two login methods.
   */
  register: async (payload: { displayName: string; phone?: string; code?: string; email?: string; password?: string }) => {
    const res = await publicApi.post<{ id: string; displayName: string; accessToken?: string; linking?: string }>("/auth/register", payload);
    if (res.accessToken) setAccessToken(res.accessToken);
    return res;
  },
  /** Self-service recovery: the server issues a one-time token and never reveals whether the identity exists. */
  forgotPassword: (identity: string) =>
    publicApi.post<{ delivered: boolean; devToken?: string; devExpiresAt?: string }>("/auth/password/forgot", { identity }),
  login: async (payload: { identity: string; password: string }) => {
    const res = await publicApi.post<{ accessToken?: string; twoFactorRequired?: boolean; challengeId?: string; devCode?: string }>("/auth/login", payload);
    if (res.accessToken) setAccessToken(res.accessToken);
    return res;
  },
  /** Second step of two-factor login: exchanges the SMS code for the session. */
  loginTwoFactor: async (challengeId: string, code: string) => {
    const res = await publicApi.post<{ accessToken: string }>("/auth/login/2fa", { challengeId, code });
    setAccessToken(res.accessToken);
    return res;
  },
  /**
   * CUSTOMER/VIP PRIMARY OTP LOGIN (mobile + code) — the second real method on the SAME account.
   * The server issues and stores the code hashed; the browser only ever sends it back. `devCode`
   * is a non-production convenience and is never returned in production.
   */
  requestOtp: (payload: { phone: string; purpose?: "login" | "signup" }) =>
    publicApi.post<{ challengeId: string; phoneMasked: string; deliveryHint: string; purpose?: string; devCode?: string }>("/auth/otp/request", payload),
  verifyOtp: async (payload: { challengeId: string; code: string }) => {
    const res = await publicApi.post<{ accessToken: string }>("/auth/otp/verify", payload);
    setAccessToken(res.accessToken);
    return res;
  },
  refresh: refreshOnce,
  /** Canonical identity + entitlement: `membership`/`isWholesaleMember` are SERVER-derived (the same
   *  active-membership gate the order endpoints use) — never a frontend/demo role. */
  me: () => authFetch<{ id: string; displayName: string; roles: string[]; permissions: string[]; preferences?: Record<string, boolean>;
    email?: string | null; phone?: string | null;
    membership?: { status: string; endsAt: string; planCode: string; planTitle: string; tier: string | null } | null;
    isWholesaleMember?: boolean;
    supplier?: { cooperationStatus: string; activityStatus: string; brandName: string } | null }>("/auth/me"),
  updateProfile: (payload: { displayName?: string; email?: string | null; birthday?: string | null }) =>
    authFetch<unknown>("/auth/me", { method: "PATCH", body: JSON.stringify(payload) }),
  updatePreference: (key: string, value: boolean) =>
    authFetch<{ preferences: Record<string, boolean> }>("/auth/me/preferences", { method: "PATCH", body: JSON.stringify({ [key]: value }) }),
  logout: async () => {
    await publicApi.post("/auth/logout").catch(() => undefined);
    setAccessToken(null);
  },
  /** One-time activation: legacy/migrated users set their first password with an issued token. */
  setPassword: (payload: { token: string; newPassword: string }) =>
    publicApi.post<{ userId: string; activated: boolean }>("/auth/set-password", payload),
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
  /** §39: `idempotencyKey` makes a retried [ذخیره پیش‌نویس] / [ذخیره و ادامه] replay-safe —
   *  the server returns the SAME canonical product instead of a duplicate identity. */
  create: (payload: unknown, idempotencyKey?: string) =>
    apiClient.post<{ id: string; status: string; ownerType?: string; retailEnabled?: boolean; wholesaleEnabled?: boolean; variants: { id: string; sku: string }[] }>(
      "/products", payload, idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined),
  update: (id: string, payload: unknown, idempotencyKey?: string) =>
    apiClient.patch<{ id: string; updated: string[] }>(`/products/${id}`, payload,
      idempotencyKey ? { headers: { "Idempotency-Key": idempotencyKey } } : undefined),
  /** §27-§30: scoped sale status (product | color | variant) — one transactional call, per-item results. */
  saleStatusScoped: (payload: {
    scope: "product" | "color" | "variant"; enabled: boolean;
    productIds?: string[]; colorTargets?: { productId: string; colorLabel: string }[]; variantIds?: string[];
  }) => apiClient.post<{ results: { key: string; label: string; ok: boolean; error?: string; affectedVariants?: number }[]; succeeded: number; failed: number }>("/products/sale-status-scoped", payload),
  status: (id: string, status: "published" | "draft" | "rejected" | "archived") =>
    apiClient.patch<{ id: string; status: string }>(`/products/${id}/status`, { status }),
  /** §11/§12: ONE backend call with per-item results — never N client requests. */
  bulkSaleStatus: (payload: { productIds: string[]; enabled: boolean }) =>
    apiClient.post<{ results: { productId: string; ok: boolean; name?: string; error?: string }[]; succeeded: number; failed: number }>("/products/bulk/sale-status", payload),
  bulkArchive: (payload: { productIds: string[] }) =>
    apiClient.post<{ results: { productId: string; ok: boolean; name?: string; error?: string }[]; succeeded: number; failed: number }>("/products/bulk/archive", payload),
  /** Full server detail for the unified create/edit studio — includes inactive variants (Req 38). */
  adminDetail: (id: string) => authFetch<Record<string, unknown> & {
    variants: { id: string; sku: string; color: string | null; size: string | null; weight_grams: number | null; active: boolean; available: number; on_hand: number }[];
  }>(`/admin/products/${id}`),
  /** Enabling a blank Color×Size matrix cell creates a real variant (Req 26/32). */
  createVariant: (productId: string, payload: { color?: string; size?: string; weightGrams?: number | null; priceOverrideRial?: string | null }) =>
    apiClient.post<{ id: string; sku: string; color: string | null; size: string | null; active: boolean }>(`/products/${productId}/variants`, payload),
  updateVariant: (productId: string, variantId: string, payload: { active?: boolean; weightGrams?: number | null; priceOverrideRial?: string | null }) =>
    apiClient.patch<{ id: string }>(`/products/${productId}/variants/${variantId}`, payload),
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

/** §2-§8: explicit series inventory of the central wholesale warehouse. */
export type SeriesStockRow = {
  series_template_id: string; template_name: string; template_active: boolean;
  product_id: string; product_name: string; color_label: string | null;
  pieces_per_series: number;
  warehouse_id: string | null; warehouse_name: string | null;
  owner_type: "kolbe" | "supplier"; supplier_id: string | null; supplier_name: string | null;
  on_hand: number; reserved: number; incoming: number; damaged: number; sellable: number;
  tracked: boolean; legacy_available: number; retail_supply_allowed: boolean;
  items?: { variant_id: string; quantity_per_series: number; sku: string; color_label: string | null; size_label: string | null }[];
};

export type RetailSupplyRow = {
  id: string; reference: string; series_template_id: string; template_name: string;
  product_id: string; product_name: string; color_label: string | null;
  source_warehouse_id: string; source_warehouse_name: string;
  destination_warehouse_id: string; destination_warehouse_name: string;
  series_count: number; pieces_total: number; status: "reserved" | "dispatched" | "received" | "cancelled";
  note: string; created_by_name: string | null; created_at: string;
  dispatched_at: string | null; received_at: string | null; cancelled_at: string | null;
};

export const seriesInventoryApi = {
  list: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined) q.set(k, String(v));
    return authFetch<{ items: SeriesStockRow[]; total: number }>(`/inventory/series?${q.toString()}`);
  },
  stocktake: (payload: {
    seriesTemplateId: string; warehouseId: string; countedSeries: number;
    ownerType?: "kolbe" | "supplier"; supplierId?: string; note?: string; idempotencyKey?: string;
  }) => authFetch<{ onHand?: number; delta?: number; duplicate?: boolean }>("/inventory/series/stocktake", { method: "POST", body: JSON.stringify(payload) }),
  movements: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined) q.set(k, String(v));
    return authFetch<{ items: {
      id: string; template_name: string; product_name: string; color_label: string | null;
      warehouse_name: string; owner_type: string; movement_type: string; quantity: number;
      reference_type: string | null; note: string; actor_name: string | null; created_at: string;
    }[] }>(`/inventory/series/movements?${q.toString()}`);
  },
  reconciliation: () => authFetch<{
    untracked_templates: { id: string; name: string; product_name: string; color_label: string | null; derived_available_series: number }[];
    mixed_purpose_warehouses: { id: string; code: string; name: string; purpose: string }[];
    templates_without_color: { id: string; name: string; product_name: string }[];
    note: string;
  }>("/inventory/series/reconciliation"),
  setWarehousePurpose: (id: string, purpose: "retail" | "wholesale" | "mixed") =>
    authFetch<{ id: string; purpose: string }>(`/warehouses/${id}/purpose`, { method: "PATCH", body: JSON.stringify({ purpose }) }),
};

/** §9-§19: «تأمین خرده از عمده» — break kolbe-owned series into retail pieces (SUP documents). */
export const retailSuppliesApi = {
  list: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) if (v !== "" && v !== undefined) q.set(k, String(v));
    return authFetch<{ items: RetailSupplyRow[]; total: number }>(`/retail-supplies?${q.toString()}`);
  },
  detail: (id: string) => authFetch<RetailSupplyRow & {
    recipe_snapshot: { piecesPerSeries: number; items: { sku: string; sizeLabel: string | null; colorLabel: string | null; quantityPerSeries: number }[] };
    events: { id: string; event_type: string; note: string; actor_name: string | null; created_at: string }[];
  }>(`/retail-supplies/${id}`),
  create: (payload: {
    seriesTemplateId: string; sourceWarehouseId: string; destinationWarehouseId: string;
    seriesCount: number; note?: string; idempotencyKey?: string;
  }) => authFetch<{ id: string; reference: string; status: string; duplicate?: boolean }>("/retail-supplies", { method: "POST", body: JSON.stringify(payload) }),
  dispatch: (id: string) => authFetch<{ status: string }>(`/retail-supplies/${id}/dispatch`, { method: "POST", body: JSON.stringify({}) }),
  receive: (id: string) => authFetch<{ status: string }>(`/retail-supplies/${id}/receive`, { method: "POST", body: JSON.stringify({}) }),
  cancel: (id: string, reason?: string) => authFetch<{ status: string }>(`/retail-supplies/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
};

export const inventoryApi = {
  warehouses: () => authFetch<{ items: { id: string; code: string; name: string; owner_id: string | null; purpose?: "retail" | "wholesale" | "mixed" }[] }>("/warehouses"),
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
  /** §5: server-computed KPI header (on-hand/reserved/incoming/damaged/available) for a domain. */
  summary: (params?: { inventoryDomain?: "retail" | "wholesale"; warehouseId?: string }) => {
    const q = new URLSearchParams(Object.entries(params ?? {}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    return authFetch<{ on_hand: number; reserved: number; incoming: number; damaged: number; available: number; variants: number; low_stock_lines: number; out_of_stock_lines: number }>(`/inventory/summary?${q.toString()}`);
  },
  movements: (variantId: string) => authFetch<{ items: unknown[] }>(`/inventory/movements?variantId=${variantId}`),
  productMovements: (productId: string) => authFetch<{ items: Record<string, unknown>[] }>(`/inventory/movements?productId=${productId}`),
  adjust: (payload: { variantId: string; warehouseId: string; delta: number; reason: string; reference: string; inventoryDomain?: "retail" | "wholesale" }, idempotencyKey: string) =>
    authFetch<unknown>("/inventory/adjustments", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
  damaged: (payload: { variantId: string; warehouseId: string; quantity: number; reason: string }) =>
    authFetch<unknown>("/inventory/damaged", { method: "POST", body: JSON.stringify(payload) }),
  receipt: (payload: { warehouseId: string; variantId: string; quantity: number; reference?: string; inventoryDomain?: "retail" | "wholesale"; batchReference?: string }, key: string) =>
    authFetch<unknown>("/inventory/receipts", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  receiveReceipt: (id: string, payload?: { receivedQuantity?: number; note?: string }) =>
    authFetch<unknown>(`/inventory/receipts/${id}/receive`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
  /** Item 52 + §13: transactional bulk adjustment (≤200 lines) — `partial: true` returns per-line results. */
  bulkAdjust: (payload: {
    lines: { variantId: string; warehouseId: string; inventoryDomain?: "retail" | "wholesale"; delta: number }[];
    reason: string; reference: string; partial?: boolean;
  }, key: string) =>
    authFetch<{ results: { variantId: string; warehouseId: string; ok: boolean; error?: string }[]; succeeded: number; failed: number }>(
      "/inventory/bulk-adjustments", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  /** §14: bulk rule-aware transfers — server enforces ownership/reserved/full-stock per line. */
  bulkTransfers: (payload: {
    sourceDomain: "retail" | "wholesale"; destinationDomain: "retail" | "wholesale";
    sourceWarehouseId: string; destinationWarehouseId: string; reason: string;
    lines: { variantId: string; quantity: number; ownershipConversionId?: string; confirmFullStock?: boolean }[];
  }, key: string) =>
    authFetch<{ results: { variantId: string; ok: boolean; reference?: string; error?: string }[]; succeeded: number; failed: number }>(
      "/inventory/bulk-transfers", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  /** Mode A: official single-variant domain/warehouse transfer (G1-G6). */
  domainTransfer: (payload: {
    variantId: string; sourceDomain: "retail" | "wholesale"; destinationDomain: "retail" | "wholesale";
    sourceWarehouseId: string; destinationWarehouseId: string; quantity: number; reason: string;
    ownershipConversionId?: string; confirmFullStock?: boolean; batchReference?: string;
  }, key: string) =>
    authFetch<Record<string, unknown>>("/inventory/transfers", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  approveTransfer: (id: string) => authFetch<unknown>(`/inventory/transfers/${id}/approve`, { method: "POST" }),
  cancelTransfer: (id: string) => authFetch<unknown>(`/inventory/transfers/${id}/cancel`, { method: "POST" }),
  /** H: partial/full reverse of a completed transfer (RTRF). */
  reverseTransfer: (id: string, payload: { quantity: number; reason: string }, key: string) =>
    authFetch<Record<string, unknown>>(`/inventory/transfers/${id}/reverse`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  receipts: (params?: { variantId?: string; warehouseId?: string; inventoryDomain?: "retail" | "wholesale"; status?: "pending"; offset?: number }) => {
    const query = new URLSearchParams(Object.entries(params ?? {}).map(([key, value]) => [key, String(value)]));
    return authFetch<{ items: unknown[] }>(`/inventory/receipts?${query.toString()}`);
  },
  pendingReceipts: async (params: { variantId?: string; warehouseId?: string; inventoryDomain: "retail" | "wholesale" }): Promise<{ items: unknown[] }> => {
    const items: unknown[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await inventoryApi.receipts({ ...params, status: "pending", offset });
      items.push(...page.items);
      if (page.items.length < 100) return { items };
    }
  },
  transfer: (payload: { fromWarehouseId: string; toWarehouseId: string; lines: { variantId: string; quantity: number }[]; reference?: string }) =>
    authFetch<unknown>("/inventory/transfers", { method: "POST", body: JSON.stringify(payload) }),
  completeTransfer: (id: string, receipt?: { receivedQty: number; damagedQty: number }) =>
    authFetch<unknown>(`/inventory/transfers/${id}/complete`, { method: "POST", ...(receipt ? { body: JSON.stringify(receipt) } : {}) }),
  transfers: () => authFetch<{ items: unknown[] }>("/inventory/transfers"),

  /** Item 52: bulk receipt — creates and immediately receives (≤200 lines). */
  bulkReceipt: (payload: { lines: { variantId: string; warehouseId: string; quantity: number }[]; reference?: string }, idempotencyKey: string) =>
    authFetch<unknown>("/inventory/bulk-receipts", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
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
  /** §34: ONE transactional backend call with per-order results — never N client requests. */
  bulkTransitions: (payload: { orderIds: string[]; status: string; note?: string }) =>
    authFetch<{ results: { orderId: string; reference?: string; ok: boolean; error?: string }[]; succeeded: number; failed: number }>(
      "/orders/bulk-transitions", { method: "POST", body: JSON.stringify(payload) }),
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

/* ------------------------------- cashback -------------------------------- */

export type CashbackWallet = {
  pendingRial: string; availableRial: string; usedRial: string; expiredRial: string;
  policy: { redemptionEnabled: boolean; maxPercentOfOrder: number; minRedeemRial: string; redeemOnInstallments: boolean };
  items: Record<string, unknown>[];
};

export const cashbackApi = {
  wallet: () => authFetch<CashbackWallet>("/cashback/wallet"),
  redemptionQuote: (merchNetRial: string, paymentMode: "cash" | "four_installments" = "cash") =>
    authFetch<{ enabled: boolean; reason: string | null; availableRial: string; maxRedeemRial: string }>(
      `/cashback/redemption-quote?merchNetRial=${merchNetRial}&paymentMode=${paymentMode}`),
  adminOverview: () => authFetch<Record<string, unknown>>("/admin/cashback/overview"),
  adminRules: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/cashback/rules"),
  createRule: (payload: unknown) => authFetch<{ id: string }>("/admin/cashback/rules", { method: "POST", body: JSON.stringify(payload) }),
  updateRule: (id: string, payload: unknown) => authFetch<{ id: string }>(`/admin/cashback/rules/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  adminWallets: (params?: Record<string, string | number>) => authFetch<{ total: number; items: Record<string, unknown>[] }>(`/admin/cashback/wallets${query(params)}`),
  adminTransactions: (params?: Record<string, string | number>) => authFetch<{ total: number; items: Record<string, unknown>[] }>(`/admin/cashback/transactions${query(params)}`),
  adminExpiring: (days = 30) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/cashback/expiring?days=${days}`),
  adjust: (payload: { customerId: string; direction: "credit" | "debit"; amountRial: string; reason: string }) =>
    authFetch<{ id: string | null }>("/admin/cashback/adjust", { method: "POST", body: JSON.stringify(payload) }),
  settings: () => authFetch<Record<string, unknown>>("/admin/cashback/settings"),
  saveSettings: (payload: unknown) => authFetch<Record<string, unknown>>("/admin/cashback/settings", { method: "PUT", body: JSON.stringify(payload) }),
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
  /* Master §H: canonical order→invoice issuance + multi-invoice bundle (server PDFs). */
  issueForOrder: (orderId: string) =>
    authFetch<{ id: string; reference: string; existing: boolean }>(`/admin/orders/${orderId}/invoice`, { method: "POST" }),
  bulkForOrders: (orderIds: string[], issueMissing: boolean) =>
    authFetch<{ results: { orderId: string; outcome: "existing" | "issued" | "missing" | "failed"; invoiceId?: string; reference?: string; error?: string }[];
      summary: { existing: number; issued: number; missing: number; failed: number } }>(
      "/admin/orders/invoices/bulk", { method: "POST", body: JSON.stringify({ orderIds, issueMissing }) }),
  bundlePath: (invoiceIds: string[]) => `/admin/invoices/bundle?ids=${invoiceIds.join(",")}`,
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

/* ------------- supplier financial core (Prompt 3: payable→hold→settlement) ------------- */

export const supplierFinanceApi = {
  summary: () => authFetch<Record<string, unknown>>("/supplier/finance/summary"),
  payables: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[]; total: number }>(`/supplier/finance/payables${query(params)}`),
  holds: () => authFetch<{ items: Record<string, unknown>[] }>("/supplier/finance/holds"),
  settlements: () => authFetch<{ items: Record<string, unknown>[] }>("/supplier/finance/settlements"),
  settlement: (id: string) => authFetch<Record<string, unknown>>(`/supplier/finance/settlements/${id}`),
  ledger: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[]; total: number }>(`/supplier/finance/ledger${query(params)}`),
  bankAccounts: () => authFetch<{ items: Record<string, unknown>[] }>("/supplier/finance/bank-accounts"),
  addBankAccount: (payload: { bankName: string; iban: string; holderName: string }) =>
    authFetch<{ id: string; status: string }>("/supplier/finance/bank-accounts", { method: "POST", body: JSON.stringify(payload) }),
  archiveBankAccount: (id: string) =>
    authFetch<unknown>(`/supplier/finance/bank-accounts/${id}/archive`, { method: "POST" }),
};

export const settlementAdminApi = {
  upcoming: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/finance/supplier-settlements/upcoming"),
  generate: (payload: { supplierId?: string; force?: boolean }) =>
    authFetch<{ created: Record<string, unknown>[]; skipped: Record<string, unknown>[] }>(
      "/admin/finance/supplier-settlements/generate", { method: "POST", body: JSON.stringify(payload) }),
  settlements: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/supplier-settlements${query(params)}`),
  settlement: (id: string) => authFetch<Record<string, unknown>>(`/admin/finance/supplier-settlements/${id}`),
  block: (id: string, reason: string) =>
    authFetch<unknown>(`/admin/finance/supplier-settlements/${id}/block`, { method: "POST", body: JSON.stringify({ reason }) }),
  transition: (id: string, action: "cancel" | "fail", reason: string) =>
    authFetch<unknown>(`/admin/finance/supplier-settlements/${id}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }),
  approvalAction: (approvalId: string, action: "review" | "approve" | "reject", note?: string) =>
    authFetch<unknown>(`/admin/finance/approvals/${approvalId}/${action}`, { method: "POST", body: JSON.stringify({ note }) }),
  pay: (id: string, payload: { reference: string; paidAmountRial: string; sourceBank?: string; note?: string }) =>
    authFetch<unknown>(`/admin/finance/settlements/${id}/pay`, { method: "POST", body: JSON.stringify(payload) }),
  payables: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/supplier-payables${query(params)}`),
  refundPayable: (id: string, payload: { amountRial: string; reason: string }) =>
    authFetch<unknown>(`/admin/finance/supplier-payables/${id}/refund`, { method: "POST", body: JSON.stringify(payload) }),
  holds: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/settlement-holds${query(params)}`),
  holdAction: (id: string, action: "block" | "unblock" | "extend" | "release", payload?: { reason?: string; hours?: number }) =>
    authFetch<unknown>(`/admin/finance/settlement-holds/${id}/${action}`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
  runHoldRelease: () => authFetch<{ released: number; blocked: number }>("/admin/finance/settlement-holds/run-release", { method: "POST" }),
  policies: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/finance/settlement-policies"),
  createPolicy: (payload: Record<string, unknown>) =>
    authFetch<{ id: string }>("/admin/finance/settlement-policies", { method: "POST", body: JSON.stringify(payload) }),
  assignPolicy: (supplierId: string, policyId: string | null) =>
    authFetch<unknown>("/admin/finance/settlement-policies/assign", { method: "POST", body: JSON.stringify({ supplierId, policyId }) }),
  bankAccounts: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/bank-accounts${query(params)}`),
  bankAction: (id: string, action: "verify" | "reject" | "disable", reason?: string) =>
    authFetch<unknown>(`/admin/finance/bank-accounts/${id}/${action}`, { method: "POST", body: JSON.stringify({ reason }) }),
  recoveries: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/supplier-recoveries${query(params)}`),
  writeOffRecovery: (id: string, reason: string) =>
    authFetch<unknown>(`/admin/finance/supplier-recoveries/${id}/write-off`, { method: "POST", body: JSON.stringify({ reason }) }),
  diagnostic: (supplierId: string) => authFetch<Record<string, unknown>>(`/admin/finance/reconciliation-diagnostic/${supplierId}`),
  shippingPolicies: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/finance/shipping-policies"),
  createShippingPolicy: (payload: Record<string, unknown>) =>
    authFetch<{ id: string; version: number }>("/admin/finance/shipping-policies", { method: "POST", body: JSON.stringify(payload) }),
  providerReconciliations: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ items: Record<string, unknown>[]; unreconciledIntents: number }>(`/admin/finance/provider-reconciliations${query(params)}`),
  recordProviderReconciliation: (payload: Record<string, unknown>) =>
    authFetch<unknown>("/admin/finance/provider-reconciliations", { method: "POST", body: JSON.stringify(payload) }),
  financePolicy: () => authFetch<Record<string, unknown>>("/admin/finance/supplier-finance-policy"),
  updateFinancePolicy: (payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>("/admin/finance/supplier-finance-policy", { method: "PUT", body: JSON.stringify(payload) }),
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
  /* Master phase §5-§10: server read models for the consolidated CRM hub. */
  retailCustomers: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ total: number; limit: number; offset: number; items: Record<string, unknown>[] }>(`/admin/crm/retail-customers${query(params)}`),
  summary: () => authFetch<{ kpis: Record<string, number>; generatedAt: string }>("/admin/crm/summary"),
  suppliers: (params?: Record<string, string | number | undefined>) =>
    authFetch<{ total: number; limit: number; offset: number; items: Record<string, unknown>[] }>(`/admin/crm/suppliers${query(params)}`),
  user360: (userId: string) => authFetch<Record<string, unknown>>(`/admin/crm/users/${userId}/360`),
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
  rules: (methodId: string) => authFetch<{ items: unknown[] }>(`/admin/shipping-methods/${methodId}/rules`),
  createRule: (methodId: string, payload: unknown) =>
    authFetch<unknown>(`/admin/shipping-methods/${methodId}/rules`, { method: "POST", body: JSON.stringify(payload) }),
  updateRule: (ruleId: string, payload: unknown) =>
    authFetch<unknown>(`/admin/shipping-rules/${ruleId}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteRule: (ruleId: string) => authFetch<unknown>(`/admin/shipping-rules/${ruleId}`, { method: "DELETE" }),
  /** Public quote — checkout shows the same fee the server will charge. */
  quote: (payload: { methodId: string; items: { variantId: string; quantity: number }[]; subtotalRial?: string; province?: string; city?: string }) =>
    publicApi.post<unknown>("/shipping/quote", payload),
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
  /** Server-side user directory (Req 19-20): search + filters + pagination run in PostgreSQL. */
  users: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) { if (v !== "" && v !== undefined) q.set(k, String(v)); }
    return authFetch<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>(`/admin/users?${q.toString()}`);
  },
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

/* --------------------- product structure (types, taxonomy) --------------------- */

export const productStructureApi = {
  types: () => publicApi.get<{ items: unknown[] }>("/product-types"),
  typeDetail: (id: string) => publicApi.get<unknown>(`/product-types/${id}`),
  createType: (payload: { code: string; name: string; description?: string; active?: boolean; position?: number; specTemplateId?: string | null }) =>
    apiClient.post<unknown>("/admin/product-types", payload),
  updateType: (id: string, payload: unknown) => apiClient.patch<unknown>(`/admin/product-types/${id}`, payload),
  deleteType: (id: string) => apiClient.del<unknown>(`/admin/product-types/${id}`),
  createSize: (typeId: string, payload: { code: string; label: string; active?: boolean; position?: number }) =>
    apiClient.post<unknown>(`/admin/product-types/${typeId}/sizes`, payload),
  updateSize: (typeId: string, sizeId: string, payload: unknown) =>
    apiClient.patch<unknown>(`/admin/product-types/${typeId}/sizes/${sizeId}`, payload),
  reorderSizes: (typeId: string, sizeIds: string[]) =>
    apiClient.post<unknown>(`/admin/product-types/${typeId}/sizes/reorder`, { sizeIds }),
  deleteSize: (typeId: string, sizeId: string) =>
    apiClient.del<unknown>(`/admin/product-types/${typeId}/sizes/${sizeId}`),
  taxonomies: (kind?: "gender" | "season") =>
    publicApi.get<{ items: unknown[] }>(kind ? `/taxonomies?kind=${kind}` : "/taxonomies"),
  /** §15: longer structural lists are filterable ON THE SERVER (q / active) with a real total. */
  adminTaxonomies: (kind?: "gender" | "season", params?: { q?: string; active?: boolean }) => {
    const search = new URLSearchParams();
    if (kind) search.set("kind", kind);
    if (params?.q?.trim()) search.set("q", params.q.trim());
    if (params?.active !== undefined) search.set("active", params.active ? "1" : "0");
    const qs = search.toString();
    return apiClient.get<{ items: unknown[]; total?: number }>(`/admin/taxonomies${qs ? `?${qs}` : ""}`);
  },
  createTaxonomy: (payload: { kind: "gender" | "season"; code: string; label: string; active?: boolean; position?: number }) =>
    apiClient.post<unknown>("/admin/taxonomies", payload),
  updateTaxonomy: (id: string, payload: unknown) => apiClient.patch<unknown>(`/admin/taxonomies/${id}`, payload),
  /** §13: safe delete — unreferenced values are removed, referenced ones answer 409 + a Persian reason. */
  deleteTaxonomy: (id: string) => apiClient.del<unknown>(`/admin/taxonomies/${id}`),
};

/* --------------------- product colors (Req 30) --------------------- */

export type ProductColor = { id: string; name: string; hex: string; active: boolean; position: number };

export const productColorsApi = {
  list: () => publicApi.get<{ items: ProductColor[] }>("/product-colors"),
  create: (payload: { name: string; hex: string }) => apiClient.post<ProductColor>("/admin/product-colors", payload),
  update: (id: string, payload: Partial<Pick<ProductColor, "name" | "hex" | "active" | "position">>) =>
    apiClient.patch<ProductColor>(`/admin/product-colors/${id}`, payload),
};

/* --------------------- manual sales (Req 13-16) --------------------- */

export type ManualSaleChannel = "website" | "instagram" | "in_person" | "phone" | "whatsapp" | "telegram" | "other";
export type ManualSaleCreate = {
  channel: ManualSaleChannel;
  warehouseId: string;
  customerId?: string | null;
  customerName?: string;
  customerPhone?: string;
  customerNote?: string;
  note?: string;
  discountRial?: string;
  lines: { variantId: string; quantity: number; unitPriceRial: string }[];
  payment: { method: "card_to_card" | "cash" | "pos" | "gateway" | "other"; amountRial: string; reference?: string; paidAt?: string; note?: string };
};

/** §31-§35: manual sale = a REAL retail order (canonical pipeline, server-side pricing). */
export type ManualOrderCreate = {
  customer: { customerId?: string; name?: string; mobile?: string };
  channel: "instagram" | "in_person" | "whatsapp" | "telegram" | "phone" | "other";
  warehouseId: string;
  items: { variantId: string; quantity: number }[];
  payment: { method: "cash" | "card_to_card" | "gateway" | "cod"; status: "paid" | "pending"; reference?: string };
  deliverNow?: boolean;
  note?: string;
};
export const manualOrdersApi = {
  create: (payload: ManualOrderCreate, idempotencyKey: string) =>
    authFetch<{ id: string; reference: string; salesChannel: string; status: string; buyerId: string;
      customerCreated: boolean; subtotalRial: string; discountRial: string; totalRial: string }>(
      "/admin/manual-orders", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
};

export const manualSalesApi = {
  list: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) { if (v !== "" && v !== undefined) q.set(k, String(v)); }
    return authFetch<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number;
      channels: { channel: string; sales: number; totalRial: string }[] }>(`/admin/manual-sales?${q.toString()}`);
  },
  detail: (id: string) => authFetch<Record<string, unknown>>(`/admin/manual-sales/${id}`),
  create: (payload: ManualSaleCreate, idempotencyKey: string) =>
    authFetch<{ id: string; reference: string; status: string; payment: { id: string; verificationStatus: string } }>(
      "/admin/manual-sales", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
  verifyPayment: (saleId: string, paymentId: string, action: "verify" | "reject", note?: string) =>
    authFetch<{ id: string; status: string; verificationStatus: string }>(
      `/admin/manual-sales/${saleId}/payments/${paymentId}/verification`, { method: "POST", body: JSON.stringify({ action, note }) }),
};

/* ------------------- OMS unified retail read model (§22-23) ------------------- */

export const omsApi = {
  /** Website retail orders + manual sales in ONE server-side table (read model, no second order system). */
  retailSales: (params?: Record<string, string | number>) => {
    const q = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) { if (v !== "" && v !== undefined) q.set(k, String(v)); }
    return authFetch<{ items: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
      `/oms/retail-sales?${q.toString()}`);
  },
};

/* --------------------- dynamic specs + size guides --------------------- */

export const specsApi = {
  attributes: () => publicApi.get<{ items: unknown[] }>("/spec-attributes"),
  adminAttributes: () => apiClient.get<{ items: unknown[] }>("/admin/spec-attributes"),
  createAttribute: (payload: unknown) => apiClient.post<unknown>("/admin/spec-attributes", payload),
  updateAttribute: (id: string, payload: unknown) => apiClient.patch<unknown>(`/admin/spec-attributes/${id}`, payload),
  deleteAttribute: (id: string) => apiClient.del<unknown>(`/admin/spec-attributes/${id}`),
  addOption: (attributeId: string, payload: { value: string; label: string; position?: number }) =>
    apiClient.post<unknown>(`/admin/spec-attributes/${attributeId}/options`, payload),
  deleteOption: (attributeId: string, optionId: string) =>
    apiClient.del<unknown>(`/admin/spec-attributes/${attributeId}/options/${optionId}`),
  templates: () => publicApi.get<{ items: unknown[] }>("/spec-templates"),
  templateDetail: (id: string) => publicApi.get<unknown>(`/spec-templates/${id}`),
  createTemplate: (payload: { code: string; name: string; description?: string; active?: boolean }) =>
    apiClient.post<unknown>("/admin/spec-templates", payload),
  updateTemplate: (id: string, payload: unknown) => apiClient.patch<unknown>(`/admin/spec-templates/${id}`, payload),
  deleteTemplate: (id: string) => apiClient.del<unknown>(`/admin/spec-templates/${id}`),
  createGroup: (templateId: string, payload: { name: string; position?: number }) =>
    apiClient.post<unknown>(`/admin/spec-templates/${templateId}/groups`, payload),
  deleteGroup: (templateId: string, groupId: string) =>
    apiClient.del<unknown>(`/admin/spec-templates/${templateId}/groups/${groupId}`),
  attachAttribute: (templateId: string, payload: { attributeId: string; groupId?: string | null; position?: number }) =>
    apiClient.post<unknown>(`/admin/spec-templates/${templateId}/attributes`, payload),
  moveAttribute: (templateId: string, attributeId: string, payload: { groupId?: string | null; position?: number }) =>
    apiClient.patch<unknown>(`/admin/spec-templates/${templateId}/attributes/${attributeId}`, payload),
  detachAttribute: (templateId: string, attributeId: string) =>
    apiClient.del<unknown>(`/admin/spec-templates/${templateId}/attributes/${attributeId}`),
  productSpecs: (productId: string) => publicApi.get<unknown>(`/products/${productId}/specs`),
  /** §12: `table` is the canonical arbitrary 2D representation stored in `products.metadata.tables.specs`.
      Sending it persists the table WITHOUT touching the legacy `product_spec_values` rows. */
  saveProductSpecs: (productId: string, payload: { values?: { attributeId?: string; attributeCode?: string; variantId?: string | null; value: unknown }[]; addToTemplate?: boolean; table?: unknown | null }) =>
    apiClient.put<unknown>(`/products/${productId}/specs`, payload),
};

export const sizeGuidesApi = {
  list: () => publicApi.get<{ items: unknown[] }>("/size-guides"),
  detail: (id: string) => publicApi.get<unknown>(`/size-guides/${id}`),
  adminList: () => apiClient.get<{ items: unknown[] }>("/admin/size-guides"),
  create: (payload: { code: string; name: string; description?: string; status?: string }) =>
    apiClient.post<unknown>("/admin/size-guides", payload),
  update: (id: string, payload: unknown) => apiClient.patch<unknown>(`/admin/size-guides/${id}`, payload),
  remove: (id: string) => apiClient.del<unknown>(`/admin/size-guides/${id}`),
  addColumn: (guideId: string, payload: { code: string; label: string; unit?: string | null; position?: number }) =>
    apiClient.post<unknown>(`/admin/size-guides/${guideId}/columns`, payload),
  /** QA2-SIZE-005: in-place column rename / unit / reorder. */
  updateColumn: (guideId: string, columnId: string, payload: { label?: string; unit?: string | null; position?: number }) =>
    apiClient.patch<unknown>(`/admin/size-guides/${guideId}/columns/${columnId}`, payload),
  deleteColumn: (guideId: string, columnId: string) =>
    apiClient.del<unknown>(`/admin/size-guides/${guideId}/columns/${columnId}`),
  replaceRows: (guideId: string, rows: Record<string, string>[]) =>
    apiClient.put<unknown>(`/admin/size-guides/${guideId}/rows`, { rows }),
  addMedia: (guideId: string, payload: { fileId: string; kind: "image" | "diagram" | "video" | "gif"; caption?: string; position?: number }) =>
    apiClient.post<unknown>(`/admin/size-guides/${guideId}/media`, payload),
  deleteMedia: (guideId: string, mediaId: string) =>
    apiClient.del<unknown>(`/admin/size-guides/${guideId}/media/${mediaId}`),
  newVersion: (guideId: string) => apiClient.post<unknown>(`/admin/size-guides/${guideId}/version`),
  productGuide: (productId: string) => apiClient.get<unknown>(`/products/${productId}/size-guide`),
  /** §12: `table` is stored in `products.metadata.tables.sizeGuide` — independent from the spec table. */
  saveProductTableGuide: (productId: string, table: unknown | null) =>
    apiClient.put<unknown>(`/products/${productId}/size-guide`, { table }),
  attachToProduct: (productId: string, payload: { guideId: string; mode: "link" | "detached" }) =>
    apiClient.put<unknown>(`/products/${productId}/size-guide`, payload),
  detachFromProduct: (productId: string) => apiClient.del<unknown>(`/products/${productId}/size-guide`),
};

/* --------------------- marketplace review --------------------- */

export const marketplaceApi = {
  reviewReasons: () => apiClient.get<{ items: unknown[] }>("/admin/marketplace/review-reasons"),
  supplierReasons: () => apiClient.get<{ items: unknown[] }>("/marketplace/review-reasons"),
  queue: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return apiClient.get<{ items: unknown[] }>(`/admin/marketplace/products?${q.toString()}`);
  },
  detail: (id: string) => apiClient.get<unknown>(`/admin/marketplace/products/${id}`),
  review: (id: string, payload: { decision: "approved" | "rejected" | "changes_requested"; documentsChecked?: boolean; checklist?: Record<string, boolean>; reasonCode?: string; note?: string }) =>
    apiClient.post<unknown>(`/admin/marketplace/products/${id}/review`, payload),
  adminResubmit: (id: string) => apiClient.post<unknown>(`/admin/marketplace/products/${id}/resubmit`),
  archive: (id: string, reason: string) => apiClient.post<unknown>(`/admin/marketplace/products/${id}/archive`, { reason }),
  supplierProducts: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return apiClient.get<{ items: unknown[] }>(`/supplier/products?${q.toString()}`);
  },
  supplierDetail: (id: string) => apiClient.get<unknown>(`/supplier/products/${id}`),
  supplierResubmit: (id: string) => apiClient.post<unknown>(`/supplier/products/${id}/resubmit`),
  uploadDocument: (id: string, file: File | Blob, fileName?: string, title?: string) => {
    const form = new FormData();
    form.append("file", file, fileName ?? (file instanceof File ? file.name : "document.bin"));
    if (title) form.append("title", title);
    return apiClient.upload<unknown>(`/products/${id}/documents`, form);
  },
};

/* --------------------- import / migration center --------------------- */

export const importsApi = {
  upload: (file: File | Blob, fileName: string, params: { type: string; mode?: string; matchBy?: string }) => {
    const form = new FormData();
    form.append("file", file, fileName);
    const q = new URLSearchParams({ type: params.type });
    if (params.mode) q.set("mode", params.mode);
    if (params.matchBy) q.set("matchBy", params.matchBy);
    return apiClient.upload<unknown>(`/admin/imports/upload?${q.toString()}`, form);
  },
  history: (limit = 30) => apiClient.get<{ items: unknown[] }>(`/admin/imports?limit=${limit}`),
  detail: (id: string) => apiClient.get<unknown>(`/admin/imports/${id}`),
  updateMapping: (id: string, payload: { mapping: Record<string, string>; imageHeaders?: string[] }) =>
    apiClient.put<unknown>(`/admin/imports/${id}/mapping`, payload),
  dryRun: (id: string) => apiClient.post<unknown>(`/admin/imports/${id}/dry-run`),
  run: (id: string) => apiClient.post<unknown>(`/admin/imports/${id}/run`),
  retry: (id: string) => apiClient.post<unknown>(`/admin/imports/${id}/retry`),
  cancel: (id: string) => apiClient.post<unknown>(`/admin/imports/${id}/cancel`),
  remove: (id: string) => apiClient.del<unknown>(`/admin/imports/${id}`),
  /** Authenticated CSV download — opens the file via a blob URL (no token in the URL). */
  downloadErrorsCsv: async (id: string) => {
    const token = getAccessToken();
    const res = await fetch(`${getApiBaseUrl()}/api/v1/admin/imports/${id}/errors.csv`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new AdminApiError("دریافت فایل خطاها ناموفق بود.", res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `import-${id}-errors.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

/* ------------------- supplier 360 lifecycle (items 11-14) ------------------- */

export type SupplierActivityStatus = "pending_review" | "active" | "restricted" | "suspended" | "blocked" | "rejected";

export type Supplier360Overview = {
  supplier: Record<string, unknown>;
  status: { current: SupplierActivityStatus; label: string; reason: string | null; note: string | null;
    restrictedUntil: string | null; changedAt: string | null };
  restrictions: Record<string, unknown>[];
  caps: { product_caps: number; sales_caps: number };
  /** The supplier_finance_accounts row (aggregates refreshed from the ledger). */
  finance: Record<string, string>;
  financeSummary: { payableRial: string; availableRial: string; blockedRial: string; settledRial: string };
  performance: Record<string, unknown>;
  /** Corrective §70-§76: canonical lists behind the 360 tabs (products/offers/orders/QC). */
  productList: Record<string, unknown>[];
  offers: Record<string, unknown>[];
  supplierOrders: Record<string, unknown>[];
  qc: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  /** Real WMS position of this supplier's variants (never a typed-in number). */
  inventory: { product_count: number; variant_count: number; on_hand: number; reserved: number; damaged: number; available: number };
  tickets: { openCount: number; items: Record<string, unknown>[] };
  profileVersions: Record<string, unknown>[];
  statusHistory: Record<string, unknown>[];
  timeline: { id: string; at: string; action: string; resourceType: string; resourceId: string | null;
    actor: string | null; detail: unknown; ip: string | null }[];
  range: { days: number; from: string };
};

/**
 * Supplier 360°. Every number comes from PostgreSQL through these endpoints —
 * the console never derives supplier status, caps or money on its own.
 */
export const supplier360Api = {
  list: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, unknown>[] }>(`/admin/suppliers?${q.toString()}`);
  },
  overview: (id: string, days = 90) =>
    authFetch<Supplier360Overview>(`/admin/suppliers/${id}/360?days=${days}`),
  setActivityStatus: (id: string, payload: { status: SupplierActivityStatus; reason: string; note?: string; durationDays?: number }) =>
    authFetch<{ userId: string; status: SupplierActivityStatus; label: string; restrictedUntil: string | null }>(
      `/admin/suppliers/${id}/activity-status`, { method: "POST", body: JSON.stringify(payload) }),
  statusHistory: (id: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/suppliers/${id}/status-history`),
  restrictions: (id: string) => authFetch<{ items: Record<string, unknown>[]; scopes: string[] }>(`/admin/suppliers/${id}/restrictions`),
  addRestriction: (id: string, payload: { scope: string; reason: string; note?: string; limitValue?: string; durationDays?: number; featureCode?: string }) =>
    authFetch<{ id: string; scope: string; expiresAt: string | null }>(`/admin/suppliers/${id}/restrictions`,
      { method: "POST", body: JSON.stringify(payload) }),
  liftRestriction: (id: string, restrictionId: string, note: string) =>
    authFetch<{ id: string; status: string; remainingActive: number }>(
      `/admin/suppliers/${id}/restrictions/${restrictionId}/lift`, { method: "POST", body: JSON.stringify({ note }) }),
  finance: (id: string, limit = 20) => authFetch<{
    account: Record<string, string> | null;
    entries: Record<string, unknown>[]; settlements: Record<string, unknown>[];
    links: { statement: string; settlements: string; report: string };
  }>(`/admin/suppliers/${id}/finance?limit=${limit}`),
  /** Legacy cooperation status — kept in sync with the activity lifecycle server-side. */
  setCooperationStatus: (id: string, payload: { status: "pending" | "approved" | "suspended" | "rejected"; note?: string }) =>
    authFetch<unknown>(`/admin/suppliers/${id}/status`, { method: "POST", body: JSON.stringify(payload) }),
};

/* ----------------- unified documents & templates (items 25-34) ----------------- */

export type InvoiceTemplateSummary = {
  id: string; code: string; title: string; kind: string; active: boolean; current_version: number;
  definition: Record<string, unknown>; change_note: string | null; usage_count: number;
};

export const invoiceDocsApi = {
  templates: () => authFetch<{ items: InvoiceTemplateSummary[] }>("/invoices/templates"),
  template: (id: string) => authFetch<Record<string, unknown>>(`/invoices/templates/${id}`),
  variables: () => authFetch<{ groups: { group: string; label: string; items: { path: string; label: string }[] }[] }>(
    "/invoices/templates/variables"),
  createTemplate: (payload: { code: string; title: string; kind: string; definition: Record<string, unknown>; changeNote?: string }) =>
    authFetch<{ id: string; code: string; version: number }>("/invoices/templates", { method: "POST", body: JSON.stringify(payload) }),
  addVersion: (id: string, payload: { definition: Record<string, unknown>; changeNote?: string }) =>
    authFetch<{ id: string; version: number }>(`/invoices/templates/${id}/versions`, { method: "POST", body: JSON.stringify(payload) }),
  activate: (id: string, active: boolean) =>
    authFetch<{ id: string; active: boolean }>(`/invoices/templates/${id}/activate`, { method: "POST", body: JSON.stringify({ active }) }),
  /** Renders a stored template (or an unsaved definition) to a PDF object URL. */
  preview: (id: string, payload: { invoiceId?: string; version?: number; definition?: Record<string, unknown> } = {}) =>
    authBlobUrl(`/invoices/templates/${id}/preview`, { method: "POST", body: JSON.stringify(payload) }),
  issue: (id: string) => authFetch<{ id: string; reference: string; status: string; pdfUrl: string }>(
    `/invoices/${id}/issue`, { method: "POST", body: JSON.stringify({}) }),
  void: (id: string, reason: string) => authFetch<{ id: string; status: string }>(
    `/invoices/${id}/void`, { method: "POST", body: JSON.stringify({ reason }) }),
  refund: (id: string, payload: { reason: string; full?: boolean; kind?: string;
    lines?: { productName: string; quantity: number; sku?: string }[] }) =>
    authFetch<{ id: string; reference: string; amountRial: string; pdfUrl: string }>(
      `/invoices/${id}/refunds`, { method: "POST", body: JSON.stringify(payload) }),
  supplierStatement: (payload: { supplierId: string; from: string; to: string; settlementId?: string }) =>
    authFetch<{ id: string; reference: string; netRial: string; pdfUrl: string }>(
      "/invoices/statements/supplier", { method: "POST", body: JSON.stringify(payload) }),
  pdfUrl: (id: string) => `${getApiBaseUrl()}/api/v1/invoices/${id}/pdf`,
  /** PDFs are permission-gated, so a download must carry the bearer token. */
  downloadPdf: (id: string) => authBlobUrl(`/invoices/${id}/pdf`),
};

/* ----------------- financial operations (items 144-172) ----------------- */

export type FinanceSummary = {
  range: { from: string; to: string };
  metrics: Record<string, string>;
  comparison: { from: string; to: string; metrics: Record<string, string> } | null;
};

export type FinanceTargets = {
  month: string; targetRial: string; actualRial: string; achievementPercent: number | null; orders: number;
};

/** Try-On monetization (Prompt 4 §42-§47): packages, credits, canonical payment intents. */
export type TryonPackage = { id: string; name: string; credits: number; price_rial: string; expiry_days: number | null };
export const tryonCreditApi = {
  packages: () => authFetch<{ salesEnabled: boolean; freeQuota: number; freeGranted: boolean; balance: number; packages: TryonPackage[] }>("/tryon/packages"),
  purchase: (packageId: string) =>
    authFetch<{ id: string; reference: string; paymentIntentId: string; amountRial: string; status: string }>(
      "/tryon/purchases", { method: "POST", body: JSON.stringify({ packageId }) }),
  purchases: () => authFetch<{ items: { id: string; reference: string; credits: number; price_rial: string; status: string; created_at: string; paid_at: string | null }[] }>("/tryon/purchases"),
};
export const tryonAdminApi = {
  packages: () => authFetch<{ items: (TryonPackage & { active: boolean; sort: number; paid_count: number; created_at: string })[];
    policy: { freeQuota: number; salesEnabled: boolean } }>("/admin/tryon/packages"),
  createPackage: (payload: { name: string; credits: number; priceRial: string; expiryDays?: number | null; sort?: number }) =>
    authFetch<{ id: string }>("/admin/tryon/packages", { method: "POST", body: JSON.stringify(payload) }),
  updatePackage: (id: string, payload: Partial<{ name: string; credits: number; priceRial: string; active: boolean; sort: number; expiryDays: number | null }>) =>
    authFetch<{ id: string }>(`/admin/tryon/packages/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  savePolicy: (payload: Partial<{ freeQuota: number; salesEnabled: boolean }>) =>
    authFetch<{ freeQuota: number; salesEnabled: boolean }>("/admin/tryon/policy", { method: "PUT", body: JSON.stringify(payload) }),
  finance: () => authFetch<{ revenueRial: string; paidPurchases: number; pendingPurchases: number;
    creditsPurchased: number; creditsFreeGranted: number; creditsConsumed: number; creditsOutstanding: number;
    knownGenerationCostRial: string; generationsWithUnknownCost: number; costStatus: string;
    purchases: { reference: string; user_name: string; credits: number; price_rial: string; status: string; paid_at: string | null; created_at: string }[] }>("/admin/tryon/finance"),
};

export const financeOpsApi = {
  summary: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<FinanceSummary>(`/admin/finance/summary?${q.toString()}`);
  },
  analytics: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<Record<string, unknown>>(`/admin/finance/analytics?${q.toString()}`);
  },
  targets: (month?: string) =>
    authFetch<FinanceTargets>(`/admin/finance/targets${month ? `?month=${month}` : ""}`),
  saveTarget: (payload: { month: string; targetRial: string }) =>
    authFetch<{ month: string; targetRial: string }>("/admin/finance/targets", { method: "PUT", body: JSON.stringify(payload) }),
  revenueStreams: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ range: { from: string; to: string }; streams: {
      key: string; title: string; revenueRial: string; count: number; enabled: boolean;
      supported: boolean; costRial: string | null; costStatus: string }[] }>(
      `/admin/finance/revenue-streams?${q.toString()}`);
  },
  aging: (side: "payable" | "receivable" = "payable") =>
    authFetch<Record<string, { buckets: string[]; items: Record<string, string>[]; totals: Record<string, string> }>>(
      `/admin/finance/aging?side=${side}`),
  suppliers: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, string>[] }>(`/admin/finance/suppliers?${q.toString()}`);
  },
  supplierStatement: (id: string, params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ supplier: Record<string, string>; openingBalanceRial: string; account: Record<string, string> | null;
      orders: Record<string, unknown>[]; entries: Record<string, unknown>[];
      settlementPosition: Record<string, string>; paidSettlements: Record<string, unknown>[];
      range: { from: string; to: string } }>(`/admin/finance/suppliers/${id}/statement?${q.toString()}`);
  },
  settlements: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, string>[] }>(`/admin/finance/settlements?${q.toString()}`);
  },
  settlement: (id: string) => authFetch<Record<string, unknown>>(`/admin/finance/settlements/${id}`),
  createSettlement: (payload: { supplierId: string; from: string; to: string; shippingRule?: string;
    deductShipping?: boolean; adjustmentIds?: string[]; note?: string }) =>
    authFetch<Record<string, unknown>>("/admin/finance/settlements", { method: "POST", body: JSON.stringify(payload) }),
  approvalAction: (id: string, action: "review" | "approve" | "reject" | "mark-paid", note?: string) =>
    authFetch<{ id: string; status: string }>(`/admin/finance/approvals/${id}/${action}`,
      { method: "POST", body: JSON.stringify({ note }) }),
  paySettlement: (id: string, payload: { method?: string; reference: string; note?: string }) =>
    authFetch<{ id: string; status: string; reconciliationStatus: string; amountRial: string }>(
      `/admin/finance/settlements/${id}/pay`, { method: "POST", body: JSON.stringify(payload) }),
  reconcile: (id: string, payload: { actualRial: string; note?: string }) =>
    authFetch<{ id: string; reconciliationStatus: string }>(`/admin/finance/settlements/${id}/reconcile`,
      { method: "POST", body: JSON.stringify(payload) }),
  resolveException: (settlementId: string, exceptionId: string, payload: { resolution: "resolved" | "waived"; note: string }) =>
    authFetch<unknown>(`/admin/finance/settlements/${settlementId}/exceptions/${exceptionId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }),
  adjustments: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, string>[] }>(`/admin/finance/adjustments?${q.toString()}`);
  },
  createAdjustment: (payload: { supplierId: string; direction: "credit" | "debit"; amountRial: string;
    category?: string; reason: string; note?: string }) =>
    authFetch<{ id: string; reference: string; status: string }>("/admin/finance/adjustments",
      { method: "POST", body: JSON.stringify(payload) }),
  applyAdjustment: (id: string, note?: string) =>
    authFetch<{ id: string; status: string; ledgerEntryId: string | null }>(`/admin/finance/adjustments/${id}/apply`,
      { method: "POST", body: JSON.stringify({ note }) }),
  advances: (params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ items: Record<string, string>[] }>(`/admin/finance/advances?${q.toString()}`);
  },
  createAdvance: (payload: { supplierId: string; amountRial: string; reason: string; note?: string }) =>
    authFetch<{ id: string; reference: string }>("/admin/finance/advances", { method: "POST", body: JSON.stringify(payload) }),
  payAdvance: (id: string, payload: { reference: string; method?: string }) =>
    authFetch<{ id: string; status: string }>(`/admin/finance/advances/${id}/pay`, { method: "POST", body: JSON.stringify(payload) }),
  applyAdvance: (id: string, amountRial?: string) =>
    authFetch<{ id: string; appliedRial: string; status: string }>(`/admin/finance/advances/${id}/apply`,
      { method: "POST", body: JSON.stringify(amountRial ? { amountRial } : {}) }),
  shippingAllocations: () => authFetch<{ items: Record<string, string>[] }>("/admin/finance/shipping-allocations"),
  createShippingAllocation: (payload: { orderId: string; totalCostRial: string; rule: string; carrier?: string }) =>
    authFetch<{ id: string; reference: string; rule: string; lines: { supplierId: string; amountRial: string }[] }>(
      "/admin/finance/shipping-allocations", { method: "POST", body: JSON.stringify(payload) }),
  periods: () => authFetch<{ items: Record<string, string>[] }>("/admin/finance/periods"),
  periodAction: (code: string, action: "close" | "lock" | "reopen", note?: string) =>
    authFetch<{ code: string; status: string }>(`/admin/finance/periods/${code}/${action}`,
      { method: "POST", body: JSON.stringify({ note }) }),
  reports: () => authFetch<{ items: { code: string; title: string; description: string; category: string;
    columns: { key: string; label: string; kind?: string }[] }[] }>("/admin/finance/reports"),
  runReport: (code: string, params?: Record<string, string>) => {
    const q = new URLSearchParams(params);
    return authFetch<{ code: string; title: string; description: string; category: string; rows: Record<string, unknown>[];
      totals: Record<string, string>; columns: { key: string; label: string; kind?: string }[];
      range: { from: string; to: string }; generatedAt: string }>(`/admin/finance/reports/${code}?${q.toString()}`);
  },
  /** CSV/XLSX/PDF export needs the bearer token, so it streams into a blob URL. */
  exportReport: (code: string, format: "csv" | "xlsx" | "pdf", params?: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, format });
    return authBlobUrl(`/admin/finance/reports/${code}?${q.toString()}`);
  },
  events: (limit = 30) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/finance/events?limit=${limit}`),};

/* =====================================================================================
 * Growth domains (items 15-24, 85-121, 136-143, 313-314)
 * Buyer 360, CRM intelligence, automation center, tracking, reviews, recommendations,
 * customer security and promotion safety. Every call goes through the same transport
 * (token + single refresh + retry) and the browser never sees integration secrets.
 * ===================================================================================== */

const query = (params?: Record<string, string | number | boolean | undefined | null>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

/* ------------------------------ buyer 360 (18-19) ------------------------------ */

export type Buyer360Payload = {
  account: Record<string, unknown>;
  membership: Record<string, unknown> | null;
  membershipHistory: Record<string, unknown>[];
  purchase: { orders: number; total_rial: string; average_order_rial: string; favourites: Record<string, unknown>[]; returns: { count: number; amount_rial: string } };
  finance: Record<string, unknown>;
  support: { tickets: Record<string, unknown>[]; notifications: Record<string, unknown>[]; sms: Record<string, unknown>[]; crmActivities: Record<string, unknown>[] };
  crm: { labels: Record<string, unknown>[]; segments: Record<string, unknown>[]; reviews: Record<string, unknown>[]; timeline: Record<string, unknown>[]; consent: Record<string, unknown> | null };
  documents: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  summary: Record<string, unknown>;
};

export const buyersApi = {
  list: (params?: Record<string, string | number | undefined>) => authFetch<{ total?: number; items: Record<string, unknown>[] }>(`/admin/buyers${query(params)}`),
  view360: (userId: string) => authFetch<Buyer360Payload>(`/admin/buyers/${userId}/360`),
  updateProfile: (userId: string, payload: unknown, reason?: string) =>
    authFetch<unknown>(`/admin/buyers/${userId}/profile`, { method: "PATCH", body: JSON.stringify({ ...(payload as object), reason }) }),
  addDocument: (userId: string, payload: { docType: string; title: string; fileId?: string | null; note?: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/documents`, { method: "POST", body: JSON.stringify(payload) }),
  verifyDocument: (userId: string, docId: string, payload: { status: "verified" | "rejected"; note?: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/documents/${docId}/verify`, { method: "POST", body: JSON.stringify(payload) }),
  setCreditLimit: (userId: string, payload: { creditLimitRial: string; approvalPolicy?: "auto" | "manual" | "prepaid"; reason: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/credit-limit`, { method: "POST", body: JSON.stringify(payload) }),
  block: (userId: string, payload: { blocked: boolean; reason: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/block`, { method: "POST", body: JSON.stringify(payload) }),
  addNote: (userId: string, payload: { body: string; visibility?: "internal" | "support" }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/notes`, { method: "POST", body: JSON.stringify(payload) }),
  addLabel: (userId: string, payload: { labelCode: string; note?: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/labels`, { method: "POST", body: JSON.stringify(payload) }),
  removeLabel: (userId: string, labelCode: string) =>
    authFetch<unknown>(`/admin/buyers/${userId}/labels/${encodeURIComponent(labelCode)}`, { method: "DELETE" }),
  saveConsent: (userId: string, payload: { marketingSms?: boolean; transactionalSms?: boolean; emailMarketing?: boolean; doNotContact?: boolean; reason?: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/consent`, { method: "POST", body: JSON.stringify(payload) }),
  /** Only non-identifying fields: email/phone changes must pass the customer's own
   *  verification flow (item 102) — admins cannot silently rewrite them. */
  profileCorrection: (userId: string, payload: { field: "firstName" | "lastName" | "birthday" | "city"; newValue: string; reason: string }) =>
    authFetch<unknown>(`/admin/buyers/${userId}/profile-correction`, { method: "POST", body: JSON.stringify({ [payload.field]: payload.newValue, reason: payload.reason }) }),
};

/* --------------------------- CRM intelligence (20-24) --------------------------- */

export const crmIntelApi = {
  labels: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/crm/labels"),
  createLabel: (payload: { code: string; title: string; kind?: string; description?: string; color?: string }) =>
    authFetch<unknown>("/admin/crm/labels", { method: "POST", body: JSON.stringify(payload) }),
  rules: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/crm/label-rules"),
  createRule: (payload: unknown) => authFetch<unknown>("/admin/crm/label-rules", { method: "POST", body: JSON.stringify(payload) }),
  updateRule: (id: string, payload: unknown) => authFetch<unknown>(`/admin/crm/label-rules/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  dryRunRule: (id: string) => authFetch<{ matchCount: number; totalCustomers: number; sample: Record<string, unknown>[] }>(
    `/admin/crm/label-rules/${id}/dry-run`, { method: "POST" }),
  applyRule: (id: string, approve = false) => authFetch<{ matchCount: number; assigned: number; removed: number }>(
    `/admin/crm/label-rules/${id}/apply`, { method: "POST", body: JSON.stringify({ approve }) }),
  segments: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/crm/segments"),
  createSegment: (payload: unknown) => authFetch<unknown>("/admin/crm/segments", { method: "POST", body: JSON.stringify(payload) }),
  updateSegment: (id: string, payload: unknown) => authFetch<unknown>(`/admin/crm/segments/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  refreshSegment: (id: string) => authFetch<{ members: number; totalCustomers: number }>(`/admin/crm/segments/${id}/refresh`, { method: "POST" }),
  segmentMembers: (id: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/crm/segments/${id}/members`),
  contactNotes: (contactId: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/crm/contacts/${contactId}/notes`),
  addNote: (contactId: string, payload: { body: string; visibility?: "internal" | "team" }) =>
    authFetch<unknown>(`/admin/crm/contacts/${contactId}/notes`, { method: "POST", body: JSON.stringify(payload) }),
  updateNote: (id: string, payload: { body?: string; visibility?: string }) =>
    authFetch<unknown>(`/admin/crm/notes/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteNote: (id: string) => authFetch<unknown>(`/admin/crm/notes/${id}`, { method: "DELETE" }),
  timeline: (contactId: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/crm/contacts/${contactId}/timeline`),
  behavior: (contactId: string) => authFetch<Record<string, unknown>>(`/admin/crm/contacts/${contactId}/behavior`),
  view360: (contactId: string) => authFetch<Record<string, unknown>>(`/admin/crm/contacts/${contactId}/360`),
  createCampaign: (payload: { title: string; message: string; segmentId?: string | null; labelCode?: string | null; dryRun?: boolean; send?: boolean }) =>
    authFetch<{ campaignId: string; recipients: number; blockedByConsent: number; audienceLabel: string; status: string; dryRun: boolean; matchMessage: string; sample: Record<string, unknown>[];
      breakdown?: { matched: number; eligible: number; optedOut: number; doNotContact: number; invalidPhone: number; suspended: number; capped: number; frequencyCap: { maxPerWindow: number; windowDays: number } } }>(
      "/admin/crm/campaigns", { method: "POST", body: JSON.stringify(payload) }),
  marketingSettings: () => authFetch<{ frequencyCap: { maxPerWindow: number; windowDays: number } }>("/admin/crm/marketing-settings"),
  saveMarketingSettings: (payload: { maxPerWindow: number; windowDays: number }) =>
    authFetch<{ frequencyCap: { maxPerWindow: number; windowDays: number } }>("/admin/crm/marketing-settings", { method: "PUT", body: JSON.stringify(payload) }),
  conditionFields: () => authFetch<{ fields: string[]; operators: string[] }>("/admin/crm/condition-fields"),
  contacts: (params?: Record<string, string | number | undefined>) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/crm/contacts${query(params)}`),
  upcomingEvents: (limit = 30) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/crm/upcoming-events${query({ limit })}`),
  consent: () => authFetch<{ consent: Record<string, unknown> }>("/customer/consent"),
  saveConsent: (payload: { marketingSms?: boolean; emailMarketing?: boolean; doNotContact?: boolean }) =>
    authFetch<{ consent: Record<string, unknown> }>("/customer/consent", { method: "PATCH", body: JSON.stringify(payload) }),
};

/* ---------------------------- automation center (85-89) ---------------------------- */

export const automationApi = {
  overview: () => authFetch<Record<string, unknown>>("/admin/automation/overview"),
  catalog: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/automation/catalog"),
  readiness: () => authFetch<{ ok: boolean; checks: { item: string; ok: boolean; note: string }[] }>("/admin/automation/readiness"),
  subscriptions: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/automation/subscriptions"),
  createSubscription: (payload: unknown) => authFetch<unknown>("/admin/automation/subscriptions", { method: "POST", body: JSON.stringify(payload) }),
  updateSubscription: (id: string, payload: unknown) => authFetch<unknown>(`/admin/automation/subscriptions/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  testSubscription: (id: string) => authFetch<{ status: string; httpStatus: number | null; error: string | null }>(
    `/admin/automation/subscriptions/${id}/test`, { method: "POST" }),
  events: (params?: Record<string, string | number>) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/automation/events${query(params)}`),
  event: (id: string) => authFetch<Record<string, unknown>>(`/admin/automation/events/${id}`),
  replay: (id: string) => authFetch<unknown>(`/admin/automation/events/${id}/replay`, { method: "POST" }),
  retryDelivery: (id: string) => authFetch<unknown>(`/admin/automation/deliveries/${id}/retry`, { method: "POST" }),
  dispatch: (limit = 50) => authFetch<Record<string, number>>("/admin/automation/dispatch", { method: "POST", body: JSON.stringify({ limit }) }),
};

/* ------------------------------ tracking (90-94) ------------------------------ */

export const trackingApi = {
  shipments: (params?: Record<string, string | number>) => authFetch<{ items: Record<string, unknown>[]; stats: Record<string, string> }>(
    `/admin/shipments${query(params)}`),
  shipment: (id: string) => authFetch<{ shipment: Record<string, unknown>; timeline: Record<string, unknown>[] }>(`/admin/shipments/${id}`),
  createShipment: (payload: unknown) => authFetch<unknown>("/admin/shipments", { method: "POST", body: JSON.stringify(payload) }),
  updateShipment: (id: string, payload: unknown) => authFetch<unknown>(`/admin/shipments/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  /* Master Spec: server-rendered shipping labels (100x150mm thermal single, A4 batch grid). */
  labelPath: (orderId: string) => `/admin/orders/${orderId}/label`,
  labelsBundlePath: (orderIds: string[], format: "thermal" | "a4" = "thermal") =>
    `/admin/orders/labels/bundle?ids=${orderIds.join(",")}&format=${format}`,
  addEvent: (id: string, payload: { status: string; location?: string | null; occurredAt: string; source?: string; rawReference?: string | null; confidence?: number; note?: string | null }) =>
    authFetch<{ eventId: string; reviewStatus: string }>(`/admin/shipments/${id}/events`, { method: "POST", body: JSON.stringify(payload) }),
  imports: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/tracking/imports"),
  importItems: (id: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/tracking/imports/${id}/items`),
  import: (payload: { source?: string; fileRef?: string | null; items: unknown[] }) =>
    authFetch<{ importId: string; matched: number; needsReview: number; failed: number; status: string }>(
      "/admin/tracking/imports", { method: "POST", body: JSON.stringify(payload) }),
  reviewItem: (itemId: string, payload: { decision: "confirm" | "reject"; orderId?: string | null; note?: string }) =>
    authFetch<unknown>(`/admin/tracking/imports/items/${itemId}/review`, { method: "POST", body: JSON.stringify(payload) }),
};

/* -------------------------------- reviews (105-109) -------------------------------- */

export const reviewsApi = {
  productReviews: (productId: string, params?: Record<string, string | number>) =>
    authFetch<{ items: Record<string, unknown>[]; summary: RatingSummary }>(`/products/${productId}/reviews${query(params)}`),
  publicProductReviews: (productId: string, params?: Record<string, string | number>) =>
    publicApi.get<{ items: Record<string, unknown>[]; summary: RatingSummary }>(`/products/${productId}/reviews${query(params)}`),
  publicRatings: (productId: string) => publicApi.get<{ summary: RatingSummary }>(`/products/${productId}/ratings`),
  submit: (productId: string, payload: { rating: number; title?: string; comment?: string; images?: string[]; orderId?: string | null }) =>
    authFetch<{ reviewId: string; status: string; verifiedPurchase: boolean }>(`/products/${productId}/reviews`, { method: "POST", body: JSON.stringify(payload) }),
  myReviews: () => authFetch<{ items: Record<string, unknown>[] }>("/customer/reviews"),
  markHelpful: (id: string) => authFetch<{ helpfulCount: number }>(`/reviews/${id}/helpful`, { method: "POST" }),
  report: (id: string, reason: string) => authFetch<{ reportId: string }>(`/reviews/${id}/report`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminList: (params?: Record<string, string | number>) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/reviews${query(params)}`),
  moderate: (id: string, payload: { action: "approve" | "reject" | "hide" | "restore"; note?: string }) =>
    authFetch<{ id: string; status: string; rating: number }>(`/admin/reviews/${id}/moderate`, { method: "POST", body: JSON.stringify(payload) }),
  reports: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/review-reports"),
  resolveReport: (id: string, status: "resolved" | "dismissed") =>
    authFetch<unknown>(`/admin/review-reports/${id}/resolve`, { method: "POST", body: JSON.stringify({ status }) }),
  productAnalytics: (productId: string) => authFetch<Record<string, unknown>>(`/admin/products/${productId}/review-analytics`),
  overallAnalytics: () => authFetch<Record<string, unknown>>("/admin/reviews/analytics/overall"),
};

export type RatingSummary = {
  reviewCount: number; averageRating: number | null; verifiedCount: number;
  distribution: { star: number; count: number }[]; ratingPercent: number | null;
};

/* ---------------------------- recommendations (110-121) ---------------------------- */

export const recommendationsApi = {
  slot: (params: { slot: string; strategy?: string; productId?: string; limit?: number; sessionId?: string; exclude?: string }) =>
    publicApi.get<{ slot: string; slotTitle: string; strategy: string; items: Record<string, unknown>[]; contextual: Record<string, unknown>; tracking: Record<string, unknown> }>(
      `/recommendations${query(params)}`),
  track: (payload: { sessionId?: string; anonymousId?: string; events: unknown[] }) =>
    publicApi.post<{ recorded: number }>("/recommendations/events", payload),
  signals: (signals: { type: string; key: string; weight?: number }[]) =>
    authFetch<{ accepted: number }>("/recommendations/signals", { method: "POST", body: JSON.stringify({ signals }) }),
  adminSlots: () => authFetch<{ items: Record<string, unknown>[]; strategies: string[] }>("/admin/recommendations/slots"),
  updateSlot: (code: string, payload: { defaultStrategy?: string; strategies?: string[]; config?: Record<string, unknown>; active?: boolean }) =>
    authFetch<unknown>(`/admin/recommendations/slots/${code}`, { method: "PATCH", body: JSON.stringify(payload) }),
  setManualItems: (code: string, payload: { productIds: string[]; replace?: boolean }) =>
    authFetch<unknown>(`/admin/recommendations/slots/${code}/items`, { method: "POST", body: JSON.stringify(payload) }),
  removeManualItem: (code: string, productId: string) =>
    authFetch<unknown>(`/admin/recommendations/slots/${code}/items/${productId}`, { method: "DELETE" }),
  analytics: (params?: { days?: number; slot?: string }) =>
    authFetch<{ items: Record<string, unknown>[]; totals: Record<string, unknown>; privacyNote: string }>(`/admin/recommendations/analytics${query(params)}`),
};

/* ------------------------- profile + security center (101-104) ------------------------- */

export const profileApi = {
  get: () => authFetch<Record<string, unknown>>("/customer/profile"),
  update: (payload: Record<string, unknown>) => authFetch<{ updated: boolean }>("/customer/profile", { method: "PATCH", body: JSON.stringify(payload) }),
  requestContactChange: (payload: { kind: "email" | "phone"; newValue: string; idempotencyKey: string }) =>
    authFetch<{ requestId: string; channel: string; status: string; developmentCode?: string; deliveryHint: string }>(
      "/customer/profile/contact-change", { method: "POST", body: JSON.stringify(payload) }),
  confirmContactChange: (requestId: string, code: string) =>
    authFetch<{ updated: boolean; kind: string }>(`/customer/profile/contact-change/${requestId}/confirm`, { method: "POST", body: JSON.stringify({ code }) }),
  sessions: () => authFetch<{ items: Record<string, unknown>[] }>("/customer/security/sessions"),
  revokeSession: (id: string) => authFetch<{ revoked: boolean }>(`/customer/security/sessions/${id}/revoke`, { method: "POST" }),
  revokeOtherSessions: () => authFetch<{ revoked: number }>("/customer/security/sessions/revoke-others", { method: "POST" }),
  loginHistory: (limit = 30) => authFetch<{ items: Record<string, unknown>[] }>(`/customer/security/login-history${query({ limit })}`),
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    authFetch<{ updated: boolean; revokedOtherSessions: number }>("/customer/security/password", { method: "POST", body: JSON.stringify(payload) }),
  twoFactor: () => authFetch<{ twoFactor: Record<string, unknown> }>("/customer/security/2fa"),
  setupTwoFactor: (method: "otp_sms" | "authenticator") =>
    authFetch<{ method: string; status: string; otpauthUrl?: string; manualEntryKey?: string; developmentCode?: string; deliveryHint?: string }>(
      "/customer/security/2fa/setup", { method: "POST", body: JSON.stringify({ method }) }),
  confirmTwoFactor: (code: string) =>
    authFetch<{ enabled: boolean; method: string; recoveryCodes: string[] }>("/customer/security/2fa/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  disableTwoFactor: (password: string) =>
    authFetch<{ enabled: boolean }>("/customer/security/2fa/disable", { method: "POST", body: JSON.stringify({ password }) }),
};

/* ------------------------------ video + media (313-314) ------------------------------ */

export const videoApi = {
  productMedia: (productId: string) =>
    publicApi.get<{ items: Record<string, unknown>[]; player: Record<string, unknown> }>(`/products/${productId}/media`),
  get: (id: string) => publicApi.get<{ video: Record<string, unknown>; player: Record<string, unknown> }>(`/videos/${id}`),
  track: (payload: { sessionId?: string; anonymousId?: string; events: unknown[] }) =>
    publicApi.post<{ recorded: number }>("/video/events", payload),
  analytics: (params?: { days?: number; productId?: string; videoId?: string }) =>
    authFetch<{ items: Record<string, unknown>[]; topViewers: Record<string, unknown>[] }>(`/admin/video/analytics${query(params)}`),
  addMedia: (productId: string, payload: unknown) => authFetch<unknown>(`/admin/products/${productId}/media`, { method: "POST", body: JSON.stringify(payload) }),
};

/* ------------------------- promotion safety + templates (136-143) ------------------------- */

export const promoSafetyApi = {
  triggers: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/promo/triggers"),
  templates: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/promo/templates"),
  createTemplate: (payload: unknown) => authFetch<unknown>("/admin/promo/templates", { method: "POST", body: JSON.stringify(payload) }),
  updateTemplate: (code: string, payload: unknown) => authFetch<unknown>(`/admin/promo/templates/${code}`, { method: "PATCH", body: JSON.stringify(payload) }),
  dryRunTemplate: (code: string, payload: { triggerCode?: string | null; targetKind?: string | null; targetRef?: string | null; config?: Record<string, unknown>; sampleSize?: number }) =>
    authFetch<{ message: string; matchCount: number; consentedCount: number; blockedByConsent: number; estimatedDiscountRial: string; sample: Record<string, unknown>[] }>(
      `/admin/promo/templates/${code}/dry-run`, { method: "POST", body: JSON.stringify(payload) }),
  issueTemplate: (code: string, payload: { triggerCode?: string | null; targetKind?: string | null; targetRef?: string | null; config?: Record<string, unknown>; dryRun: boolean; confirmMatchCount?: number; reason?: string }) =>
    authFetch<{ runId: string; matched: number; issued: number; skipped: { userId: string; reason: string }[]; dryRun: boolean }>(
      `/admin/promo/templates/${code}/issue`, { method: "POST", body: JSON.stringify(payload) }),
  automations: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/promo/automations"),
  updateAutomation: (id: string, payload: unknown) => authFetch<unknown>(`/admin/promo/automations/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  dryRunAutomation: (id: string, payload: { config?: Record<string, unknown>; sampleSize?: number } = {}) =>
    authFetch<{ message: string; matchCount: number; consentedCount: number; willSend: boolean; safety: Record<string, unknown>; sample: Record<string, unknown>[] }>(
      `/admin/promo/automations/${id}/dry-run`, { method: "POST", body: JSON.stringify(payload) }),
  runAutomation: (id: string, payload: { mode: "test" | "live"; note?: string }) =>
    authFetch<{ runId: string; mode: string; matched: number; sent: number; coupons: number; safety: Record<string, unknown> }>(
      `/admin/promo/automations/${id}/run`, { method: "POST", body: JSON.stringify(payload) }),
  runs: (id: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/promo/automations/${id}/runs`),
  personalCoupons: (params?: Record<string, string>) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/promo/personal-coupons${query(params)}`),
  issuePersonalCoupon: (payload: { userId: string; templateCode: string; percent?: number; reason: string; expiresInDays?: number }) =>
    authFetch<{ couponId: string; code: string }>("/admin/promo/personal-coupons", { method: "POST", body: JSON.stringify(payload) }),
};

/* --------------------------- customer-facing membership --------------------------- */

export const membershipLifecycleApi = {
  quote: (params: { planId: string; kind?: "auto" | "renewal" | "upgrade" | "downgrade" }) =>
    authFetch<{ direction: string; targetPlan: Record<string, unknown>; targetPriceRial: string; creditRial: string; payableRial: string; policy: Record<string, unknown> }>(
      `/memberships/quote${query(params)}`),
  renew: (idempotencyKey: string) => authFetch<Record<string, unknown>>("/memberships/renew",
    { method: "POST", headers: { "idempotency-key": idempotencyKey } }),
  upgrade: (planId: string, idempotencyKey: string) => authFetch<Record<string, unknown>>("/memberships/upgrade",
    { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify({ planId }) }),
  downgrade: (planId: string, immediate = false, reason?: string) => authFetch<Record<string, unknown>>("/memberships/downgrade",
    { method: "POST", body: JSON.stringify({ planId, immediate, reason }) }),
  cancel: (immediate = false, reason?: string) => authFetch<Record<string, unknown>>("/memberships/cancel",
    { method: "POST", body: JSON.stringify({ immediate, reason }) }),
  history: () => authFetch<{ memberships: Record<string, unknown>[]; events: Record<string, unknown>[] }>("/memberships/history"),
  adminEvents: (userId: string) => authFetch<{ items: Record<string, unknown>[] }>(`/admin/memberships/${userId}/events`),
  suspend: (membershipId: string, reason: string) => authFetch<unknown>(`/admin/memberships/${membershipId}/suspend`, { method: "POST", body: JSON.stringify({ reason }) }),
  reactivate: (membershipId: string) => authFetch<unknown>(`/admin/memberships/${membershipId}/reactivate`, { method: "POST" }),
  refund: (membershipId: string, amountRial: string, note?: string) =>
    authFetch<unknown>(`/admin/memberships/${membershipId}/refund`, { method: "POST", body: JSON.stringify({ amountRial, note }) }),
  changePlan: (membershipId: string, planId: string, reason?: string) =>
    authFetch<unknown>(`/admin/memberships/${membershipId}/change-plan`, { method: "POST", body: JSON.stringify({ planId, reason }) }),
  runExpiry: () => authFetch<Record<string, number>>("/admin/memberships/run-expiry", { method: "POST" }),
};

/* ---------- wholesale Kolbe-intermediated fulfillment + inventory domains + promotion rules ---------- */

export const wholesaleFulfillmentApi = {
  supplierFulfillments: () => authFetch<{ items: Record<string, unknown>[] }>("/wholesale/supplier/fulfillments"),
  dispatchToKolbe: (id: string, payload: { destinationWarehouseId?: string; carrier?: string; trackingCode?: string; note?: string }, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/fulfillments/${id}/dispatch-to-kolbe`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    }),
  inboundShipments: () => authFetch<{ items: Record<string, unknown>[] }>("/wholesale/inbound-shipments"),
  receiveShipment: (id: string, payload: { stage: "arrived_at_kolbe" | "receiving" | "under_inspection"; note?: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/inbound-shipments/${id}/receive`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  inspectShipment: (id: string, payload: Record<string, unknown>, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/inbound-shipments/${id}/inspect`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    }),
  consolidateOrder: (orderId: string, idempotencyKey: string, note?: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/orders/${orderId}/consolidate`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ note }),
    }),
  dispatchVipOrder: (orderId: string, idempotencyKey: string, reason?: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/orders/${orderId}/dispatch-vip`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({ reason }),
    }),
};

export const inventoryDomainApi = {
  variantBreakdown: (variantId: string) => authFetch<Record<string, unknown>>(`/inventory/variants/${variantId}`),
  ownershipConversions: () => authFetch<{ items: Record<string, unknown>[] }>("/inventory/ownership-conversions"),
  createOwnershipConversion: (payload: Record<string, unknown>, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>("/inventory/ownership-conversions", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    }),
  completeOwnershipConversion: (id: string, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>(`/inventory/ownership-conversions/${id}/complete`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
    }),
  transfers: () => authFetch<{ items: Record<string, unknown>[] }>("/inventory/transfers"),
  transferDetail: (id: string) => authFetch<Record<string, unknown>>(`/inventory/transfers/${id}`),
};

export const promotionRulesApi = {
  list: () => authFetch<{ promotions: Record<string, unknown>[]; rules: Record<string, unknown>[]; items: Record<string, unknown>[] }>("/promotions"),
  rules: () => authFetch<{ items: Record<string, unknown>[] }>("/promotions/rules"),
  createRule: (payload: Record<string, unknown>, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>("/promotions/rules", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
    }),
  updateRule: (id: string, payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>(`/promotions/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deactivateRule: (id: string) =>
    authFetch<Record<string, unknown>>(`/promotions/rules/${id}`, { method: "DELETE" }),
  /** DEC-PRICING-001 (Option A): explicit reactivation of a festival-suspended rule. */
  reactivateRule: (id: string) =>
    authFetch<Record<string, unknown>>(`/promotions/rules/${id}/reactivate`, { method: "POST" }),
  /** Canonical, transactional product-level Festival/standalone mode switch. */
  setProductMode: (productId: string, payload:
    | { mode: "standalone"; enabled: boolean; confirmFestivalExit?: boolean }
    | { mode: "festival"; promotionId: string | null; channel?: "retail" | "wholesale" | "all"; discountType?: "percent" | "fixed_rial"; discountValue?: number | string; moveFromFestival?: boolean }) =>
    authFetch<Record<string, unknown>>(`/promotions/products/${productId}/mode`, { method: "POST", body: JSON.stringify(payload) }),
  /** Canonical batch preview from the same resolver used by checkout. */
  resolvePrices: (payload: { orderType: "retail" | "wholesale"; paymentMode: "cash" | "four_installments"; items: { variantId: string; quantity: number }[] }) =>
    authFetch<{ lines: Record<string, unknown>[]; subtotalRial: string; discountRial: string; totalRial: string }>("/pricing/resolve", { method: "POST", body: JSON.stringify(payload) }),
  /** §17.10: bulk festival assignment from «همه کالاها» — one call, per-item results. */
  festivalBulk: (payload: { promotionId: string; productIds: string[]; discountType: "percent" | "fixed_rial"; discountValue: number | string; moveFromFestival?: boolean }) =>
    authFetch<{
      promotionId: string; promotionName: string;
      summary: { total: number; added: number; moved: number; alreadyInFestival: number; needsConfirmation: number; errors: number };
      results: { productId: string; productName: string | null; status: string; message: string }[];
    }>("/promotions/festival-bulk", { method: "POST", body: JSON.stringify(payload) }),
  resolveVariantPrice: (variantId: string, orderType: "retail" | "wholesale" = "retail", paymentMode: "cash" | "four_installments" = "cash") =>
    authFetch<Record<string, unknown>>(`/pricing/variants/${variantId}?orderType=${orderType}&paymentMode=${paymentMode}`),
  /** A1/A4/A5: per-product promotion snapshot for the «تخفیف و جشنواره» column. */
  productSummary: (productId: string) => authFetch<{
    productId: string;
    activeFestival: { promotionId: string; name: string; endsAt: string | null } | null;
    assignedFestival: { ruleId: string; promotionId: string; name: string; channel: string; active: boolean; promotionActive: boolean; startsAt: string | null; endsAt: string | null; effective: boolean } | null;
    activeStandaloneRules: number;
    suspendedStandaloneRules: number;
    configuredStandaloneRules: number;
  }>(`/promotions/product-summary?productId=${productId}`),
  rulesByProduct: (productId: string) => authFetch<{ items: Record<string, unknown>[] }>(`/promotions/rules?productId=${productId}`),
  createPromotion: (payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>("/promotions", { method: "POST", body: JSON.stringify(payload) }),
  updatePromotion: (id: string, payload: { active?: boolean; endsAt?: string | null; priority?: number }) =>
    authFetch<Record<string, unknown>>(`/promotions/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
};

/* ---------- supplier supply requests (section I) ---------- */
export const supplierRequestsApi = {
  create: (payload: { note?: string; items: Record<string, unknown>[] }, key: string) =>
    authFetch<Record<string, unknown>>("/supplier-requests", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  list: (status?: string) => authFetch<{ items: Record<string, unknown>[] }>(`/supplier-requests${status ? `?status=${status}` : ""}`),
  detail: (id: string) => authFetch<Record<string, unknown>>(`/supplier-requests/${id}`),
  review: (id: string, payload: { decision: "approve" | "reject" | "request_revision"; reason?: string }) =>
    authFetch<Record<string, unknown>>(`/supplier-requests/${id}/review`, { method: "POST", body: JSON.stringify(payload) }),
  revise: (id: string, payload: { note?: string; items: Record<string, unknown>[] }) =>
    authFetch<Record<string, unknown>>(`/supplier-requests/${id}/revise`, { method: "POST", body: JSON.stringify(payload) }),
  dispatch: (id: string, payload: { warehouseId: string; batchReference?: string; carrier?: string; note?: string }) =>
    authFetch<Record<string, unknown>>(`/supplier-requests/${id}/dispatch`, { method: "POST", body: JSON.stringify(payload) }),
  close: (id: string) => authFetch<Record<string, unknown>>(`/supplier-requests/${id}/close`, { method: "POST" }),
};

/* ---------- relational series templates (section K) ---------- */
export const seriesTemplatesApi = {
  create: (payload: { productId: string; name: string; description?: string; items: { variantId: string; quantityPerSeries: number }[] }) =>
    authFetch<Record<string, unknown>>("/series-templates", { method: "POST", body: JSON.stringify(payload) }),
  list: (productId?: string) => authFetch<{ items: Record<string, unknown>[] }>(`/series-templates${productId ? `?productId=${productId}` : ""}`),
  /** VIP marketplace view: composition + server-computed availableSeries + price/MOQ per series in one call. */
  vipList: (productId: string) => authFetch<{ items: {
    id: string; product_id: string; name: string; active: boolean;
    pairs_per_series: number; price_per_series_rial: string | null; moq_series: number; available_series: number;
    items: { variant_id: string; quantity_per_series: number; sku: string; color_label: string | null; size_label: string | null; unit_price_rial?: string | null }[];
  }[] }>(`/series-templates?productId=${productId}&withAvailability=1`),
  detail: (id: string) => authFetch<Record<string, unknown> & {
    items: { variant_id: string; quantity_per_series: number; sku: string; color_label: string | null; size_label: string | null; unit_price_rial?: string | null }[];
    pairsPerSeries: number; availableSeries: number; name: string; productName: string; productId: string;
    pricePerSeriesRial: string | null; moqSeries: number; active: boolean;
  }>(`/series-templates/${id}`),
  update: (id: string, payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>(`/series-templates/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
};

/* ------------------- Prompt-1: product lifecycle + supplier wholesale (§14-§44) ------------------- */

export type NeedsSetupRow = {
  id: string; name: string; brand: string | null; category: string; status: string;
  retail_enabled: boolean; wholesale_enabled: boolean; inventory_setup: string; created_at: string; variant_count: number;
};
/** §5/§19: one row of «محصولات کلبه» — catalog identity, commercial summary and the two
 *  independent WMS domains. `inventory_setup` is an internal technical invariant only. */
export type AdminProductRow = NeedsSetupRow & {
  owner_type: string; supplier_id: string | null; supplier_name: string | null;
  retail_available: number; wholesale_series_available: number; active_offers: number;
  updated_at?: string;
  cash_price_rial?: string | null;
  installment_price_rial?: string | null;
  wholesale_price_rial?: string | null;
  /** Cover image file id (metadata.images[0].fileId) — resolved through /product-media/:id. */
  cover_file_id?: string | null;
  /** First active variant SKU — enough to recognise a product without opening it. */
  sku?: string | null;
  /** §34: canonical price projection of the row (ONE server resolver, batched for the whole page). */
  pricing?: {
    retailBasePriceRial: string | null; retailFinalPriceRial: string | null; retailDiscountRial: string;
    discountSource: string; compareAtPriceRial: string | null;
    installmentBasePriceRial: string | null; installmentEnabled: boolean; installmentDiscountAllowed: boolean;
    minSeriesTotalRial: string | null;
  } | null;
};
/** §5: the five canonical «محصولات کلبه» views. */
export type ProductCenterView = "all" | "drafts" | "published" | "out_of_stock" | "archived";

/** §14-§20: کالاها — definition→setup lifecycle + the §44 admin product read model. */
export const catalogOpsApi = {
  needsSetup: (params?: Record<string, string | number>) =>
    authFetch<{ items: NeedsSetupRow[]; total: number }>(`/admin/products/needs-setup${query(params)}`),
  adminProducts: (params?: Record<string, string | number>) =>
    authFetch<{ items: AdminProductRow[]; total: number }>(`/admin/products${query(params)}`),
  /** §19: audited opening stock — the ONLY bridge from «تعریف» to «موجودی». Server re-validates everything. */
  inventorySetup: (productId: string, payload: {
    retail?: { warehouseId: string; mode: "zero" | "equal" | "per_variant"; quantity?: number; perVariant?: { variantId: string; quantity: number }[] };
    wholesale?: { warehouseId: string; seriesTemplateId: string; seriesCount: number };
  }, idempotencyKey: string) =>
    authFetch<Record<string, unknown>>(`/admin/products/${productId}/inventory-setup`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload) }),
  categoryProfiles: () => authFetch<{ items: Record<string, unknown>[] }>("/admin/category-profiles"),
  saveCategoryProfile: (category: string, payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>(`/admin/category-profiles/${encodeURIComponent(category)}`, { method: "PUT", body: JSON.stringify(payload) }),
  categorySchema: (category: string) =>
    authFetch<{ category: string; configured: boolean; specFields: Record<string, unknown>[]; sizeGuide: { id: string; name: string } | null; allowedSizes: string[] }>(
      `/catalog/categories/${encodeURIComponent(category)}/schema`),
  /** §4: canonical publication checklist — the SERVER decides what blocks publication,
   *  so the Studio never invents requirements and never fails silently. */
  publicationReadiness: (productId: string) => apiClient.get<{
    productId: string; status: string; publishable: boolean; stockIndependent: boolean;
    issues: { code: string; label: string; step: "base" | "variant" | "media" | "cutout" | "price" | "specs" | "seo" | "review" }[];
  }>(`/admin/products/${productId}/publication-readiness`),

};

export type SupplierOfferRow = Record<string, unknown> & {
  id: string; productId: string; productName?: string; supplierName?: string; colorLabel: string | null;
  seriesTemplateId: string | null; seriesTemplateName: string | null; status: string;
  minOrderSeries: number; maxOrderSeries: number | null; declaredCapacity: number;
  reservedExternal: number; safetyBuffer: number; availableToRequest: number;
  freshness: string; capacityConfirmedAt: string | null; fulfillmentMode: string; wholesalePriceRial: string | null;
};
export type SupplierInboundRow = Record<string, unknown> & {
  id: string; reference: string; status: string; expected_series: number;
  received_series: number | null; shortage_series: number; passed_series: number | null; rejected_series: number | null;
  product_name?: string; supplier_name?: string; color_label?: string | null; created_at: string;
};

/** §28-§34: supplier wholesale offers + declared external capacity (NEVER kolbe stock). */
export const supplierOffersApi = {
  list: (params?: Record<string, string | number>) => authFetch<{ items: SupplierOfferRow[] }>(`/supplier/offers${query(params)}`),
  upsert: (payload: Record<string, unknown>) => authFetch<SupplierOfferRow>("/supplier/offers", { method: "POST", body: JSON.stringify(payload) }),
  capacity: (offerId: string, payload: { declaredCapacity?: number; confirmOnly?: boolean }) =>
    authFetch<{ id: string; declaredCapacity: number; availableToRequest: number; freshness: string }>(
      `/supplier/offers/${offerId}/capacity`, { method: "POST", body: JSON.stringify(payload) }),
  setStatus: (offerId: string, status: "active" | "paused" | "archived") =>
    authFetch<{ id: string; status: string }>(`/supplier/offers/${offerId}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  /** §36: marketplace availability — kolbe stock vs declared capacity, never merged. */
  availability: (productId: string) => authFetch<Record<string, unknown>>(`/products/${productId}/wholesale-availability`),
};

/** §25-§27, §35, §37: consignment inbound → QC → stock-at-kolbe → returns (+§50 stock ownership conversion). */
export const supplierConsignmentApi = {
  createInbound: (payload: Record<string, unknown>) =>
    authFetch<{ id: string; reference: string }>("/supplier/inbounds", { method: "POST", body: JSON.stringify(payload) }),
  inbounds: (params?: Record<string, string | number>) => authFetch<{ items: SupplierInboundRow[] }>(`/supplier/inbounds${query(params)}`),
  dispatch: (inboundId: string, payload?: { batchReference?: string }) =>
    authFetch<Record<string, unknown>>(`/supplier/inbounds/${inboundId}/dispatch`, { method: "POST", body: JSON.stringify(payload ?? {}) }),
  cancel: (inboundId: string) => authFetch<Record<string, unknown>>(`/supplier/inbounds/${inboundId}/cancel`, { method: "POST", body: JSON.stringify({}) }),
  review: (inboundId: string, payload: { decision: "approve" | "reject"; warehouseId?: string; reason?: string }) =>
    authFetch<Record<string, unknown>>(`/admin/supplier-inbounds/${inboundId}/review`, { method: "POST", body: JSON.stringify(payload) }),
  receive: (inboundId: string, payload: { receivedSeries: number; note?: string }) =>
    authFetch<Record<string, unknown>>(`/admin/supplier-inbounds/${inboundId}/receive`, { method: "POST", body: JSON.stringify(payload) }),
  qc: (inboundId: string, payload: { passedSeries: number; rejectedSeries: number; note?: string }) =>
    authFetch<Record<string, unknown>>(`/admin/supplier-inbounds/${inboundId}/qc`, { method: "POST", body: JSON.stringify(payload) }),
  /** §23-B/§43: WMS-grade supplier stock at kolbe (owner=supplier, custodian=kolbe). */
  supplierStock: (params?: Record<string, string | number>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/admin/supplier-stock${query(params)}`),
  createReturn: (payload: Record<string, unknown>) =>
    authFetch<{ id: string; reference: string }>("/supplier/stock-returns", { method: "POST", body: JSON.stringify(payload) }),
  returns: (params?: Record<string, string | number>) =>
    authFetch<{ items: Record<string, unknown>[] }>(`/supplier/stock-returns${query(params)}`),
  reviewReturn: (returnId: string, payload: { decision: "approve" | "reject" | "complete"; reason?: string }) =>
    authFetch<Record<string, unknown>>(`/admin/supplier-returns/${returnId}/review`, { method: "POST", body: JSON.stringify(payload) }),
  /** §50: audited series-stock ownership conversion (supplier → kolbe) — never a silent flip. */
  convertOwnership: (payload: Record<string, unknown>) =>
    authFetch<Record<string, unknown>>("/admin/inventory/series-ownership-conversions", { method: "POST", body: JSON.stringify(payload) }),
};

/* ---------------------- VIP wholesale Master/Child OMS ---------------------- */

/** Prompt-2 §17-§18: master order = grouping/consolidation shell; each CHILD order (one per seller) is the financial truth. */
/** §24/§62: the small customer-facing lifecycle derived on the server from internal statuses. */
export type MasterReadiness = "not_ready" | "partial" | "ready" | "shipped" | "delivered" | "cancelled";
/** §21-§23/§56-§61: ONE list row — every coverage/readiness number is DERIVED server-side. */
export type MasterOrderSummary = {
  id: string; reference: string; composition: string; status: string;
  shipping_estimate_rial: string | null; tracking_code: string | null; carrier: string | null;
  created_at: string; locked_at: string | null; shipped_at: string | null; delivered_at: string | null;
  buyer_name: string | null;
  child_count: number; included_children: number; paid_children: number; supplier_children: number;
  ready_children: number; progressed_children: number;
  ordered_series: number; kolbe_series: number; supplier_at_kolbe_series: number;
  supply_required_series: number; inbound_series: number;
  total_rial: string; readiness: MasterReadiness; customer_status: string;
};
/** Always `{items, limit, sort, total}` — `total` is the count of rows matching the SAME filters. */
export type MasterOrderPage = { items: MasterOrderSummary[]; limit: number; sort: "newest" | "oldest"; total: number };

/** §49/§77: the STRICT buyer projection — order facts, items and derived lifecycle only. No supplier,
 *  allocation, capacity, warehouse or internal-state field can ever appear here (enforced in the serializer). */
export type BuyerMasterDetail = {
  view: "buyer"; id: string; reference: string; composition: string; status: string;
  createdAt: string; lockedAt: string | null; shippedAt: string | null; deliveredAt: string | null;
  customerStatus: string; customerStatusLabel: string;
  items: Array<{ productName: string; seriesName: string; colorLabel: string | null; seriesCount: number;
    piecesPerSeries: number; pieces: number; unitSeriesPriceRial: string; lineTotalRial: string }>;
  subOrders: Array<{ reference: string; totalRial: string; statusLabel: string; payable: boolean; cancelled: boolean }>;
  totals: { subtotalRial: string; discountRial: string; shippingRial: string; totalRial: string };
  shippingEstimateRial: string | null;
  shipping: Record<string, string | null>;
  actions: { payableChildIds: string[]; canPay: boolean; canDecide: boolean; canLock: boolean; canCancel: boolean };
  timeline: Array<{ at: string; label: string }>;
};

/** Prompt-4 §21-§23/§56-§61: canonical admin projection of a master order (serializers, not UI masking). */
export type OpsAllocation = {
  id: string; source_type: "kolbe_stock" | "supplier_stock_at_kolbe" | "supplier_external";
  quantity: number; status: string; owner_supplier_id: string | null; offer_id: string | null;
  warehouse_id: string | null; received_series: number; qc_passed_series: number; qc_rejected_series: number;
  reservation_expires_at: string | null;
  supplier_response_status: string; supplier_response_note: string | null; supplier_committed_series: number;
  supplier_responded_at: string | null; supplier_committed_at: string | null; supplier_ready_at: string | null;
};
/** §59-§61: the THREE allocatable buckets are always separate numbers, never one merged stock figure. */
export type OpsLineSupply = {
  line_id: string; kolbe_available: number; supplier_at_kolbe_available: number; offer_capacity_available: number;
};
export type OpsLine = {
  id: string; product_id: string; product_name: string; series_template_id: string; series_name: string;
  color_label: string | null; requested_series: number; confirmed_series: number | null;
  pieces_per_series: number; unit_series_price_rial: string; line_total_rial: string; status: string;
  supply: OpsLineSupply | null;
  allocations: OpsAllocation[];
};
export type OpsChild = {
  id: string; reference: string; seller_type: string; seller_id: string | null; status: string;
  supply_status: string; payment_eligibility: string; payment_due_at: string | null; supplier_respond_by: string | null;
  child_fulfillment: string | null; composition_state: string; subtotal_rial: string; discount_rial: string;
  total_rial: string; created_at: string; allowedActions: string[]; lines: OpsLine[];
};
export type OpsCoverage = {
  orderedSeries: number; kolbeSeries: number; supplierAtKolbeSeries: number;
  capacitySeries: number; receivedSeries: number; qcPassedSeries: number;
};
export type OpsMasterDetail = {
  view: "ops"; id: string; reference: string; buyer_id: string; composition: string; status: string;
  created_at: string; locked_at: string | null; shipped_at: string | null; delivered_at: string | null;
  carrier: string | null; tracking_code: string | null;
  shipping_address: Record<string, string> | null; shipping_estimate_rial: string | null;
  buyer: { id: string; name: string; email: string | null; membership_status: string | null } | null;
  coverage: OpsCoverage; readiness: MasterReadiness;
  customerStatus: string; customerStatusLabel: string;
  totals: { subtotalRial: string; discountRial: string; shippingRial: string; totalRial: string };
  children: OpsChild[];
  exceptions: Array<{ id: string; child_order_id: string; exception_type: string; quantity: number | null;
    status: string; resolution: string | null; note: string | null; created_at: string }>;
  consolidation: { id: string; status: string; created_at: string; updated_at: string } | null;
  timeline: Array<{ at: string; label: string; code: string }>;
  allowedActions: string[];
};
export type MasterChildSummary = {
  id: string; reference: string; sellerType: "kolbe" | "supplier"; sellerId: string | null;
  supplyStatus: string; paymentEligibility: string; paymentDueAt: string | null;
  subtotalRial: string; discountRial: string; totalRial: string;
};
export type SupplierChildLine = {
  id: string; productId: string; seriesTemplateId: string; requestedSeries: number;
  proposedSeries: number | null; confirmedSeries: number | null; status: string;
  piecesPerSeries: number; productName?: string; templateName?: string;
  externalSeries: number; stockAtKolbeSeries: number;
};
export type SupplierChildOrder = {
  id: string; reference: string; status: string; supply_status: string; payment_eligibility: string;
  child_fulfillment: string | null; supplier_respond_by: string | null; created_at: string;
  master_reference: string; lines: SupplierChildLine[];
};
export type SupplierSupplyRequest = {
  allocationId: string; lineId: string; childOrderId: string; orderReference: string;
  childStatus: string; paymentEligibility: string; childFulfillment: string | null;
  productName: string; seriesName: string; colorLabel: string | null;
  requestedSeries: number; externalSeries: number; proposedSeries: number | null;
  confirmedSeries: number | null; lineStatus: string; allocationStatus: string;
  responseStatus: "unanswered" | "accepted" | "revised" | "rejected" | "committed" | "ready" | "cancelled" | string;
  responseNote: string | null; committedSeries: number; respondedAt: string | null;
  committedAt: string | null; readyAt: string | null; createdAt: string; updatedAt: string;
};
export type SupplierPortalDashboard = {
  supplier: { id: string; brandName: string; cooperationStatus: string; activityStatus: string };
  products: { published: number; pending: number; total: number; series: number };
  supplyRequests: { open: number; committedSeries: number; readySeries: number; history: number };
  capacity: { declared: number; reserved: number; availableToRequest: number };
  stockAtKolbeSeries: number;
};
export type SupplierPortalProduct = {
  id: string; brand: string; name: string; category: string; status: string; wholesale_enabled: boolean;
  created_at: string; colors: string[]; sizes: string[];
  series: { id: string; name: string; colorLabel: string | null; active: boolean;
    pricingMode: string; minOrderSeries: number; seriesCount: number; pricePerSeriesRial: string | null;
    items: { size: string; quantityPerSeries: number; unitPriceRial: string | null }[] }[];
};
export type SupplierPortalHistoryItem = SupplierSupplyRequest & { orderStatus: string };

const supplierActionKey = (scope: string, payload: unknown) => {
  const text = JSON.stringify(payload) ?? String(payload);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${scope}-${(hash >>> 0).toString(36)}`;
};

export const supplierPortalApi = {
  dashboard: () => authFetch<SupplierPortalDashboard>("/supplier/portal/dashboard"),
  products: (limit = 100) => authFetch<{ items: SupplierPortalProduct[] }>(`/supplier/portal/products${query({ limit })}`),
  history: (limit = 50) => authFetch<{ items: SupplierPortalHistoryItem[] }>(`/supplier/portal/history${query({ limit })}`),
};

export const wholesaleOmsApi = {
  /** VIP checkout → ONE master + one child per seller; server expands series recipes and reserves atomically. */
  createMaster: (payload: {
    items: { seriesTemplateId: string; count: number; offerId?: string }[];
    shippingAddress?: { recipient: string; phone: string; province: string; city: string; line: string; postalCode: string };
    shippingMethodId?: string; note?: string;
  }, key: string) =>
    authFetch<{ id: string; reference: string; composition: string; status: string; subtotalRial: string; children: MasterChildSummary[] }>(
      "/wholesale/masters", { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify(payload) }),
  masters: (params?: Record<string, string | number>) =>
    authFetch<MasterOrderPage>(`/wholesale/masters${query(params)}`),
  /** ONE canonical read model, TWO SERVER-SIDE projections (§64/§96): staff receive `ops`, the VIP owner
   *  receives `buyer`. The projection is chosen by the server from the caller's role — a client cannot ask
   *  for (or widen into) the operational view. */
  master: (id: string) => authFetch<OpsMasterDetail | BuyerMasterDetail>(`/wholesale/masters/${id}`),
  /** §30-§31: cancellation unwinds safe holds server-side; idempotent and audited. */
  cancelMaster: (id: string, reason: string, key: string) =>
    authFetch<{ id: string; reference: string; status: string; duplicate: boolean; cancelledChildren: number;
      refundPendingChildren: number; released: { series: number; capacity: number; requirements: number } }>(
      `/wholesale/masters/${id}/cancel`, { method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({ reason }) }),
  /** §33: explicit, audited source reassignment (release A → assign B); demand is conserved. */
  reassignAllocation: (allocationId: string, payload: { toOfferId?: string; toSource?: "supplier_external" | "supplier_stock_at_kolbe"; reason: string }) =>
    authFetch<{ allocationId: string; replacementAllocationId: string; replacementStatus: string;
      source: string; supplierChanged: boolean; quantity: number; supplierConfirmationRequired: boolean; history: number }>(
      `/wholesale/allocations/${allocationId}/reassign`, { method: "POST",
        headers: { "Idempotency-Key": supplierActionKey(`oms-reassign-${allocationId}`, payload) }, body: JSON.stringify(payload) }),
  lock: (id: string) => authFetch<Record<string, unknown>>(`/wholesale/masters/${id}/lock`, { method: "POST", body: "{}" }),
  removeChild: (childId: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/children/${childId}/remove`, { method: "POST", body: "{}" }),
  /** Buyer decision on a countered line: accept the supplier's lower proposal or remove the line. */
  buyerDecision: (lineId: string, action: "accept_counter" | "remove") =>
    authFetch<Record<string, unknown>>(`/wholesale/lines/${lineId}/decision`, { method: "POST", body: JSON.stringify({ action }) }),
  /** §53-§58: payment intents — per child, or ONE gateway transaction across several READY children. */
  childPaymentIntent: (childId: string) =>
    authFetch<{ intentId: string; reference: string; amountRial: string; children: { id: string; reference: string; amountRial: string }[] }>(
      `/wholesale/children/${childId}/payment-intent`, { method: "POST", body: "{}" }),
  batchPaymentIntent: (masterId: string, childIds: string[]) =>
    authFetch<{ intentId: string; reference: string; amountRial: string; children: { id: string; reference: string; amountRial: string }[] }>(
      `/wholesale/masters/${masterId}/batch-payment-intent`, { method: "POST", body: JSON.stringify({ childIds }) }),
  /** §71-§72: supplier panel — child orders only; buyer identity is never exposed. */
  supplierChildOrders: (params?: Record<string, string | number>) =>
    authFetch<{ items: SupplierChildOrder[] }>(`/wholesale/supplier/child-orders${query(params)}`),
  supplierSupplyRequests: (params?: { state?: "open" | "history" | "all"; limit?: number }) =>
    authFetch<{ items: SupplierSupplyRequest[] }>(`/wholesale/supplier/supply-requests${query(params)}`),
  supplierRespondAllocation: (allocationId: string, payload: { action: "confirm" | "counter" | "reject"; proposedSeries?: number; note?: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/supply-requests/${allocationId}/respond`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-alloc-${allocationId}`, payload) }, body: JSON.stringify(payload) }),
  supplierCommit: (allocationId: string, payload: { note?: string } = {}) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/supply-requests/${allocationId}/commit`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-commit-${allocationId}`, payload) }, body: JSON.stringify(payload) }),
  supplierReady: (allocationId: string, payload: { note?: string } = {}) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/supply-requests/${allocationId}/ready`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-ready-${allocationId}`, payload) }, body: JSON.stringify(payload) }),
  supplierCancelCommitment: (allocationId: string, payload: { note?: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/supply-requests/${allocationId}/cancel`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-cancel-${allocationId}`, payload) }, body: JSON.stringify(payload) }),
  /** Backward-compatible line response path used by existing Supplier clients. */
  supplierRespond: (lineId: string, payload: { action: "confirm" | "counter" | "reject"; proposedSeries?: number; note?: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/supplier/lines/${lineId}/respond`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-line-${lineId}`, payload) }, body: JSON.stringify(payload) }),
  supplierDispatch: (childId: string, payload?: { trackingNote?: string }) => {
    const body = payload ?? {};
    return authFetch<Record<string, unknown>>(`/wholesale/supplier/children/${childId}/dispatch`, {
      method: "POST", headers: { "Idempotency-Key": supplierActionKey(`sup-dispatch-${childId}`, body) }, body: JSON.stringify(body) });
  },
  /** Warehouse/ops fulfillment + consolidation (§77-§103). */
  pick: (childId: string) => authFetch<Record<string, unknown>>(`/wholesale/children/${childId}/pick`, { method: "POST", body: "{}" }),
  receive: (childId: string, payload: { allocations: { allocationId: string; receivedSeries: number }[] }) =>
    authFetch<Record<string, unknown>>(`/wholesale/children/${childId}/receive`, { method: "POST", body: JSON.stringify(payload) }),
  qc: (childId: string, payload: { allocations: { allocationId: string; passedSeries: number; rejectedSeries: number }[] }) =>
    authFetch<Record<string, unknown>>(`/wholesale/children/${childId}/qc`, { method: "POST", body: JSON.stringify(payload) }),
  resolveException: (exceptionId: string, payload: { resolution: string; note?: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/exceptions/${exceptionId}/resolve`, { method: "POST", body: JSON.stringify(payload) }),
  consolidationStart: (masterId: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/masters/${masterId}/consolidation/start`, { method: "POST", body: "{}" }),
  consolidationVerify: (consolidationId: string, payload: { lineId: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/consolidations/${consolidationId}/verify-item`, { method: "POST", body: JSON.stringify(payload) }),
  consolidationComplete: (consolidationId: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/consolidations/${consolidationId}/complete`, { method: "POST", body: "{}" }),
  consolidationPack: (consolidationId: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/consolidations/${consolidationId}/pack`, { method: "POST", body: "{}" }),
  ship: (masterId: string, payload: { carrier: string; trackingCode: string }) =>
    authFetch<Record<string, unknown>>(`/wholesale/masters/${masterId}/ship`, { method: "POST", body: JSON.stringify(payload) }),
  deliver: (masterId: string) =>
    authFetch<Record<string, unknown>>(`/wholesale/masters/${masterId}/deliver`, { method: "POST", body: "{}" }),
};
