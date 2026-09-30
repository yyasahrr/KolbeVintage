export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message);
export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'ورود به حساب لازم است.');
export const forbidden = (message?: string) => new ApiError(403, 'FORBIDDEN', message ?? 'دسترسی به این عملیات مجاز نیست.');
export const notFound = (message?: string) => new ApiError(404, 'NOT_FOUND', message ?? 'موردی پیدا نشد.');
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);

/**
 * PATCH bodies: Zod 4 still applies `.default()` inside `.partial()`, which would silently overwrite
 * fields the client never sent (e.g. reset `active`, `description`, `position`). Keep only the keys
 * actually present in the request.
 */
export function patchBody<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const sent = raw && typeof raw === 'object' ? new Set(Object.keys(raw as object)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
}
