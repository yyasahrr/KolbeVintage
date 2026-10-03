/** Corrective §60-§63/§86: ONE shared Persian vocabulary for every CRM/360 surface.
 *  Raw backend enums must never leak into normal UI — unknown values fall back to a
 *  neutral Persian label instead of the technical code. */

export const ACCOUNT_STATUS_FA: Record<string, string> = {
  active: "فعال", inactive: "غیرفعال", suspended: "تعلیق‌شده", pending: "در انتظار",
  blocked: "مسدود", deleted: "حذف‌شده",
};

export const ROLE_FA: Record<string, string> = {
  customer: "مشتری", supplier: "تأمین‌کننده", admin: "مدیر", staff: "کارمند", buyer: "خریدار عمده",
};

export const ORDER_STATUS_FA: Record<string, string> = {
  pending_payment: "در انتظار پرداخت", paid: "پرداخت‌شده", processing: "در حال پردازش",
  preparing: "در حال آماده‌سازی", ready_to_ship: "آماده ارسال", in_transit: "در مسیر",
  shipped: "ارسال‌شده", delivered: "تحویل‌شده", cancelled: "لغوشده", returned: "مرجوع‌شده",
};

export const ORDER_TYPE_FA: Record<string, string> = { retail: "خرده", wholesale: "عمده" };

export const PAYMENT_MODE_FA: Record<string, string> = { cash: "نقدی", four_installments: "چهارقسطه" };

export const RETURN_STATUS_FA: Record<string, string> = {
  requested: "درخواست مرجوعی", approved: "مرجوعی تأییدشده", received: "مرجوعی دریافت‌شده",
  refunded: "بازپرداخت‌شده", rejected: "مرجوعی ردشده",
};

export const REVIEW_STATUS_FA: Record<string, string> = {
  pending: "در انتظار بررسی", approved: "تأییدشده", rejected: "ردشده", hidden: "پنهان",
};

export const TICKET_STATUS_FA: Record<string, string> = {
  open: "باز", pending: "در انتظار", in_progress: "در حال رسیدگی", answered: "پاسخ داده‌شده",
  resolved: "حل‌شده", closed: "بسته",
};

export const COOPERATION_STATUS_FA: Record<string, string> = {
  approved: "تأییدشده", pending: "در انتظار", pending_review: "در انتظار بررسی",
  suspended: "تعلیق", rejected: "ردشده", terminated: "خاتمه‌یافته",
};

/** §86: business timeline/event codes → Persian. Dotted codes map by prefix too. */
export const EVENT_TYPE_FA: Record<string, string> = {
  "account.created": "ایجاد حساب", "order.created": "سفارش ثبت شد", "order.paid": "سفارش پرداخت شد",
  "order.shipped": "سفارش ارسال شد", "order.delivered": "سفارش تحویل شد", "order.cancelled": "سفارش لغو شد",
  "payment.succeeded": "پرداخت موفق بود", "payment.failed": "پرداخت ناموفق بود",
  "shipment.created": "مرسوله ثبت شد", "shipment.delivered": "مرسوله تحویل شد",
  "return.requested": "درخواست مرجوعی ثبت شد", "return.refunded": "بازپرداخت انجام شد",
  "review.created": "بازبینی ثبت شد", "review.moderated": "بازبینی بررسی شد",
  "ticket.created": "تیکت ثبت شد", "ticket.resolved": "تیکت حل شد",
  "wishlist.added": "به علاقه‌مندی اضافه شد",
  "consent.updated": "رضایت بازاریابی به‌روزرسانی شد",
  "campaign.sent": "پیام کمپین ارسال شد",
  "settlement.paid": "تسویه پرداخت شد", "settlement.scheduled": "تسویه زمان‌بندی شد",
  login: "ورود به حساب", signup: "ثبت‌نام", purchase: "خرید", refund: "بازپرداخت",
};

const EVENT_PREFIX_FA: Record<string, string> = {
  order: "رویداد سفارش", payment: "رویداد پرداخت", shipment: "رویداد مرسوله", review: "رویداد بازبینی",
  return: "رویداد مرجوعی", ticket: "رویداد پشتیبانی", campaign: "رویداد کمپین", settlement: "رویداد تسویه",
  consent: "رویداد رضایت", account: "رویداد حساب", wishlist: "رویداد علاقه‌مندی",
};

export function faEvent(code: unknown): string {
  const key = String(code ?? "");
  if (EVENT_TYPE_FA[key]) return EVENT_TYPE_FA[key];
  const prefix = key.split(".")[0] ?? "";
  return EVENT_PREFIX_FA[prefix] ?? "رویداد";
}

/** Lookup with a safe Persian fallback — never echoes the raw enum into the UI. */
export function faLabel(map: Record<string, string>, value: unknown, fallback = "نامشخص"): string {
  const key = String(value ?? "");
  return map[key] ?? (key === "" ? fallback : fallback);
}
