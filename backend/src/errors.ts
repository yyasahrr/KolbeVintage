export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message);
export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'ورود به حساب لازم است.');
export const forbidden = () => new ApiError(403, 'FORBIDDEN', 'دسترسی به این عملیات مجاز نیست.');
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'موردی پیدا نشد.');
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);
