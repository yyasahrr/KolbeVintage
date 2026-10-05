/**
 * Low-level HTTP transport. NOT a component-facing API.
 *
 * Components must use the canonical authenticated client in `src/data/api.ts`
 * (`apiClient` / domain APIs). Only that client knows about tokens and refresh.
 *
 * Rules enforced here:
 * - `Content-Type: application/json` is set only for string (JSON) bodies.
 *   FormData/Blob/URLSearchParams bodies must keep the browser-generated
 *   Content-Type so multipart boundaries stay valid.
 * - The API base URL is resolved from Vite env → browser origin → localhost,
 *   so the same module also runs under Node (contract smoke tests).
 */

let apiBaseUrl: string = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const configured = env?.VITE_API_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin.replace(/\/$/, "");
  return "http://127.0.0.1:4000";
})();

export const setApiBaseUrl = (base: string) => { apiBaseUrl = base.replace(/\/$/, ""); };
export const getApiBaseUrl = () => apiBaseUrl;

export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

/** §4: structured failure details forwarded by the API (e.g. the publication issue list). */
export type ApiErrorDetails = {
  issues?: { code: string; label: string; step: string }[];
  labels?: string[];
  [key: string]: unknown;
} | undefined;

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: ApiErrorDetails) { super(message); }
}

/** JSON string bodies get a Content-Type header; FormData and friends must not. */
const hasJsonBody = (body: BodyInit | null | undefined) => typeof body === "string";

export async function apiCall<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasJsonBody(init.body) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string; details?: ApiErrorDetails } | null;
    throw new AdminApiError(error?.message ?? `خطای سرویس (${response.status})`, response.status, error?.code, error?.details);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

let refreshPromise: Promise<{ accessToken: string }> | null = null;
/** Single-flight refresh call. Never call this outside the canonical client. */
export function refreshAdminToken() {
  if (!refreshPromise) {
    refreshPromise = apiCall<{ accessToken: string }>("/auth/refresh", { method: "POST" })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
