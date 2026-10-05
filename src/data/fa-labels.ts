/** Corrective §60-§63/§86: ONE shared Persian vocabulary for every CRM/360 surface.
 *  Raw backend enums must never leak into normal UI — unknown values fall back to a
 *  neutral Persian label instead of the technical code. */

export const ACCOUNT_STATUS_FA: Record<string, string> = {
  active: "فعال", inactive: "غیرفعال", suspended: "تعلیق‌شده", pending: "در انتظار",
  blocked: "مسدود", deleted: "حذف‌شده",
};

export const ROLE_FA: Record<string, string> = {
  customer: "مشتری", supplier: "تأمین‌کننده", admin: "مدیر", staff: "کارمند", buyer: "خریدار عمده",
  vip: "خریدار VIP", wholesale_buyer: "خریدار عمده", support: "پشتیبانی", finance: "مالی", operator: "اپراتور",
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

export const PRODUCT_STATUS_FA: Record<string, string> = {
  draft: "پیش‌نویس", pending_review: "در انتظار بررسی", approved: "تأییدشده", active: "فعال",
  rejected: "ردشده", archived: "بایگانی", inactive: "غیرفعال",
};

export const OFFER_STATUS_FA: Record<string, string> = { active: "فعال", paused: "متوقف", archived: "بایگانی" };

export const FULFILLMENT_MODE_FA: Record<string, string> = {
  order_driven: "سفارش‌محور", stock_at_kolbe: "موجودی نزد کلبه", hybrid: "ترکیبی",
};

export const CONTRACT_STATUS_FA: Record<string, string> = {
  none: "بدون قرارداد", draft: "پیش‌نویس", active: "فعال", suspended: "تعلیق", terminated: "خاتمه‌یافته", signed: "امضاشده",
};

export const PRIORITY_FA: Record<string, string> = {
  low: "کم", normal: "عادی", medium: "متوسط", high: "زیاد", urgent: "فوری", critical: "بحرانی",
};

export const SETTLEMENT_STATUS_FA: Record<string, string> = {
  pending: "در انتظار", approved: "تأییدشده", processing: "در حال پردازش", paid: "پرداخت‌شده",
  reconciled: "مغایرت‌گیری‌شده", cancelled: "لغوشده", failed: "ناموفق",
};

export const RECONCILIATION_STATUS_FA: Record<string, string> = {
  pending: "در انتظار", matched: "تطبیق‌شده", mismatch: "مغایرت", manual: "دستی", unknown: "نامشخص",
  not_required: "نیاز ندارد",
};

export const INSPECTION_RESULT_FA: Record<string, string> = { sellable: "قابل فروش", damaged: "آسیب‌دیده" };

export const RETURN_RESOLUTION_FA: Record<string, string> = { refund: "بازپرداخت", exchange: "تعویض", credit: "اعتبار" };

/** §10/§14/§26: `inventory_setup` is an INTERNAL technical invariant only.
 *  The final Product Owner decision removed «نیازمند راه‌اندازی» as a user-facing
 *  Product lifecycle — the only unfinished state Admin ever sees is «پیش‌نویس».
 *  These labels describe whether a WMS record exists for a domain, never a lifecycle. */
export const INVENTORY_SETUP_FA: Record<string, string> = {
  pending: "موجودی ثبت‌نشده", configured: "دارای موجودی", legacy: "قدیمی",
};

export const PERSON_TYPE_FA: Record<string, string> = { real: "حقیقی", legal: "حقوقی" };

export const SMS_STATUS_FA: Record<string, string> = {
  queued: "در صف ارسال", sent: "ارسال‌شده", delivered: "تحویل‌شده", failed: "ناموفق", pending: "در انتظار",
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

/** Cashback wallet ledger vocabulary (admin + customer surfaces). */
export const CASHBACK_TX_FA: Record<string, string> = {
  cashback_pending: "کش‌بک در انتظار",
  cashback_released: "آزادسازی اعتبار",
  cashback_redeemed: "استفاده در خرید",
  cashback_reversed: "برگشت اعتبار",
  cashback_expired: "انقضای اعتبار",
  refund_restore: "بازگشت اعتبار پس از مرجوعی",
  admin_credit: "افزایش دستی (ادمین)",
  admin_debit: "کاهش دستی (ادمین)",
};

/** Notification routing vocabulary (admin «اعلان‌ها»): channels/roles/priorities in Persian. */
export const NOTIF_CHANNEL_FA: Record<string, string> = {
  in_app: "داخل برنامه", inapp: "داخل برنامه", email: "ایمیل", sms: "پیامک", webhook: "وب‌هوک", push: "پوش",
};

export const NOTIF_PRIORITY_FA: Record<string, string> = {
  low: "کم", normal: "عادی", medium: "متوسط", high: "زیاد", urgent: "فوری", critical: "بحرانی",
};

/** Lookup with a safe Persian fallback — never echoes the raw enum into the UI. */
export function faLabel(map: Record<string, string>, value: unknown, fallback = "نامشخص"): string {
  const key = String(value ?? "");
  return map[key] ?? (key === "" ? fallback : fallback);
}
