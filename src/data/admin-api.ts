const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? window.location.origin).replace(/\/$/, "");

export type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export class AdminApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function apiCall<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null;
    throw new AdminApiError(error?.message ?? `خطای سرویس (${response.status})`, response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

let refreshPromise: Promise<{ accessToken: string }> | null = null;
export function refreshAdminToken() {
  if (!refreshPromise) {
    refreshPromise = apiCall<{ accessToken: string }>("/auth/refresh", { method: "POST" })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}
