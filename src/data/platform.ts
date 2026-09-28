/* Platform-level definitions shared by storefront, supplier center and admin console */
import { IMG } from "./catalog";

export const KOLBE = { id: "kolbe", name: "کلبه وینتیج" };
export const BUYER_DEMO = "بوتیک آوا — تهران";
export const BUYER_ADDRESS = "تهران، بازار بزرگ، پاساژ آوا، پلاک ۱۲";

/* ---------------- Wholesale order workflow ---------------- */
export type SubStatus = "pending_supplier" | "approved" | "paid" | "preparing" | "ready_to_ship" | "in_transit" | "shipped" | "delivered" | "rejected" | "cancelled";

export const SUB_STATUS: Record<SubStatus, { label: string; step: number }> = {
  pending_supplier: { label: "در انتظار تأیید تأمین‌کننده", step: 1 },
  approved: { label: "تأیید شد · در انتظار پرداخت", step: 2 },
  paid: { label: "پرداخت شد", step: 3 },
  preparing: { label: "در حال آماده‌سازی", step: 4 },
  ready_to_ship: { label: "آماده ارسال", step: 5 },
  in_transit: { label: "در حال ارسال", step: 6 },
  shipped: { label: "ارسال شد", step: 7 },
  delivered: { label: "تحویل شد", step: 8 },
  rejected: { label: "رد شد", step: 0 },
  cancelled: { label: "لغو شد", step: 0 },
};
export const SUB_STEPS = ["ثبت سفارش", "تأیید تأمین‌کننده", "پرداخت", "آماده‌سازی", "آماده ارسال", "در حال ارسال", "ارسال شد", "تحویل"];
export const isTerminal = (s: SubStatus) => s === "delivered" || s === "rejected" || s === "cancelled";
export const canTransitionSub = (from: SubStatus, to: SubStatus) => {
  const next: Record<SubStatus, SubStatus[]> = {
    pending_supplier: ["approved", "rejected", "cancelled"], approved: ["paid", "cancelled"],
    paid: ["preparing", "cancelled"], preparing: ["ready_to_ship", "cancelled"],
    ready_to_ship: ["in_transit", "cancelled"], in_transit: ["shipped", "delivered"],
    shipped: ["delivered"], delivered: [], rejected: [], cancelled: [],
  };
  return next[from].includes(to);
};

export const EVENT_TEXT: Record<SubStatus, string> = {
  pending_supplier: "سفارش ثبت و برای تأمین‌کننده ارسال شد",
  approved: "تأمین‌کننده امکان تأمین را تأیید کرد",
  paid: "پرداخت انجام شد",
  preparing: "آماده‌سازی سفارش آغاز شد",
  ready_to_ship: "محصول آماده ارسال شد",
  in_transit: "محصول در حال ارسال است",
  shipped: "تحویل باربری شد",
  delivered: "سفارش تحویل داده شد",
  rejected: "تأمین‌کننده امکان تأمین ندارد",
  cancelled: "سفارش لغو شد",
};

export type OrderLine = { productId: string; name: string; image: string; seriesName: string; color: string; qtySeries: number; pieces: number; pricePerSeries: number };
export type OrderEvent = { t: string; time: string; by: string };
export type SubOrder = {
  id: string; supplierId: string; supplierName: string; status: SubStatus;
  lines: OrderLine[]; total: number; events: OrderEvent[];
  note?: string; tracking?: string; eta?: string;
};
export type ParentOrder = { id: string; buyer: string; accountId?: string; createdAt: string; shippingMethod: string; address: string; subOrders: SubOrder[] };
export type WholesaleCartLine = { accountId?: string; productId: string; seriesId: string; color: string; qtySeries: number };

export const nowLabel = () => `امروز ${new Date().toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}`;

const L = (productId: string, name: string, image: string, seriesName: string, color: string, qtySeries: number, pieces: number, pricePerSeries: number): OrderLine =>
  ({ productId, name, image, seriesName, color, qtySeries, pieces, pricePerSeries });
const E = (t: string, time: string, by: string): OrderEvent => ({ t, time, by });
const S = (id: string, supplierId: string, supplierName: string, status: SubStatus, lines: OrderLine[], events: OrderEvent[], extra: Partial<SubOrder> = {}): SubOrder =>
  ({ id, supplierId, supplierName, status, lines, events, total: lines.reduce((a, l) => a + l.pricePerSeries * l.qtySeries, 0), ...extra });

export const SEED_ORDERS: ParentOrder[] = [
  {
    id: "WO-1005", buyer: "گالری ماهور — اصفهان", createdAt: "امروز ۰۸:۴۵", shippingMethod: "باربری سراسری", address: "اصفهان، چهارباغ عباسی، پاساژ ماهور، واحد ۷",
    subOrders: [
      S("WO-1005-1", "s1", "نیلگون", "pending_supplier", [L("p2", "پیراهن کلاسیک نیم‌آستین", IMG.shirtRack, "سری کامل", "نارنجی آجری", 8, 96, 7400000)], [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "امروز ۰۸:۴۵", "گالری ماهور")]),
      S("WO-1005-2", "kolbe", "کلبه وینتیج", "pending_supplier", [L("p5", "پالتو بلند طراح‌دار", IMG.redCoat, "سری کامل", "زرشکی", 2, 24, 14900000)], [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "امروز ۰۸:۴۵", "گالری ماهور")]),
    ],
  },
  {
    id: "WO-1004", buyer: "پوشاک رادین — مشهد", createdAt: "دیروز ۱۶:۳۰", shippingMethod: "تیپاکس", address: "مشهد، خیابان امام رضا، مجتمع تجاری رادین",
    subOrders: [
      S("WO-1004-1", "s1", "نیلگون", "paid", [L("p8", "پیراهن چهارخانه مشکی", IMG.blackSuit, "سری کامل", "مشکی", 10, 120, 5300000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "دیروز ۱۶:۳۰", "پوشاک رادین"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "دیروز ۱۷:۱۰", "نیلگون"), E("پرداخت انجام شد", "امروز ۰۹:۰۰", "پوشاک رادین")]),
      S("WO-1004-2", "s2", "فراسو", "shipped", [L("p7", "بلیزر پاستلی دو‌تکه", IMG.pastelBlazer, "نیم‌سری", "کرمی", 4, 24, 5700000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "دیروز ۱۶:۳۰", "پوشاک رادین"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "دیروز ۱۶:۵۵", "فراسو"), E("پرداخت انجام شد", "دیروز ۱۸:۲۰", "پوشاک رادین"), E("آماده‌سازی سفارش آغاز شد", "امروز ۰۷:۳۰", "فراسو"), E("تحویل باربری شد · TPX-8802-114", "امروز ۱۰:۱۵", "فراسو")],
        { tracking: "TPX-8802-114", eta: "تحویل تا ۲ روز آینده" }),
    ],
  },
  {
    id: "WO-1003", buyer: BUYER_DEMO, createdAt: "دیروز ۱۱:۲۰", shippingMethod: "باربری سراسری", address: BUYER_ADDRESS,
    subOrders: [
      S("WO-1003-1", "kolbe", "کلبه وینتیج", "shipped", [L("p1", "مانتو بارانی کلاسیک", IMG.hijabTrench, "سری کامل", "مشکی", 4, 48, 8900000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "دیروز ۱۱:۲۰", "بوتیک آوا"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "دیروز ۱۲:۰۵", "کلبه وینتیج"), E("پرداخت انجام شد", "دیروز ۱۳:۴۰", "بوتیک آوا"), E("آماده‌سازی سفارش آغاز شد", "دیروز ۱۵:۰۰", "کلبه وینتیج"), E("تحویل باربری شد · BAR-4471-09", "امروز ۰۹:۱۰", "کلبه وینتیج")],
        { tracking: "BAR-4471-09", eta: "تحویل تا ۲ روز آینده" }),
      S("WO-1003-2", "s1", "نیلگون", "preparing", [L("p2", "پیراهن کلاسیک نیم‌آستین", IMG.shirtRack, "سری کامل", "نارنجی آجری", 5, 60, 7400000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "دیروز ۱۱:۲۰", "بوتیک آوا"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "دیروز ۱۴:۳۰", "نیلگون"), E("پرداخت انجام شد", "دیروز ۱۵:۱۰", "بوتیک آوا"), E("آماده‌سازی سفارش آغاز شد", "امروز ۰۸:۰۰", "نیلگون")]),
      S("WO-1003-3", "s3", "نوین استایل", "rejected", [L("p4", "شومیز کتان زنانه", IMG.whiteShirts, "نیم‌سری", "سفید", 6, 36, 3450000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "دیروز ۱۱:۲۰", "بوتیک آوا"), E("تأمین‌کننده امکان تأمین ندارد", "دیروز ۱۷:۴۵", "نوین استایل")],
        { note: "موجودی رنگ سفید در سایزهای L و XL تمام شده؛ تولید مجدد تا دو هفته دیگر." }),
    ],
  },
  {
    id: "WO-1002", buyer: BUYER_DEMO, createdAt: "۳ روز پیش", shippingMethod: "تیپاکس", address: BUYER_ADDRESS,
    subOrders: [
      S("WO-1002-1", "s2", "فراسو", "approved", [L("p3", "کت لینن مردانه", IMG.blazerDuo, "سری کامل", "شنی", 6, 72, 12400000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "۳ روز پیش", "بوتیک آوا"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "۲ روز پیش", "فراسو")]),
      S("WO-1002-2", "s1", "نیلگون", "pending_supplier", [L("p8", "پیراهن چهارخانه مشکی", IMG.blackSuit, "سری کامل", "سرمه‌ای", 6, 72, 5300000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "۳ روز پیش", "بوتیک آوا")]),
    ],
  },
  {
    id: "WO-1001", buyer: BUYER_DEMO, createdAt: "۲ هفته پیش", shippingMethod: "باربری سراسری", address: BUYER_ADDRESS,
    subOrders: [
      S("WO-1001-1", "kolbe", "کلبه وینتیج", "delivered", [L("p6", "ترنچ کت شنی کلاسیک", IMG.trenchWhite, "سری کامل", "شنی", 3, 36, 9900000)],
        [E("سفارش ثبت و برای تأمین‌کننده ارسال شد", "۲ هفته پیش", "بوتیک آوا"), E("تأمین‌کننده امکان تأمین را تأیید کرد", "۲ هفته پیش", "کلبه وینتیج"), E("پرداخت انجام شد", "۲ هفته پیش", "بوتیک آوا"), E("آماده‌سازی سفارش آغاز شد", "۱۳ روز پیش", "کلبه وینتیج"), E("تحویل باربری شد · BAR-4310-77", "۱۲ روز پیش", "کلبه وینتیج"), E("سفارش تحویل داده شد", "۹ روز پیش", "باربری")],
        { tracking: "BAR-4310-77" }),
    ],
  },
];

/* ---------------- VIP plans ---------------- */
export type PlanLimits = {
  showPrices: boolean;
  sources: "all" | "kolbe";
  maxOrdersPerMonth: number | null;
  maxOrderValue: number | null;
  discountPercent: number;
  creditDays: number;
  freeShipping: boolean;
  prioritySupport: boolean;
  maxSuppliersPerOrder: number | null;
};
export type VipPlan = { id: string; name: string; yearly: number; creditLimit: number; features: string[]; active: boolean; recommended?: boolean; limits?: PlanLimits };
export const DEFAULT_LIMITS: PlanLimits = { showPrices: true, sources: "all", maxOrdersPerMonth: 3, maxOrderValue: 150000000, discountPercent: 0, creditDays: 0, freeShipping: false, prioritySupport: false, maxSuppliersPerOrder: 2 };
export const limitsOf = (plan?: VipPlan): PlanLimits => ({ ...DEFAULT_LIMITS, ...(plan?.limits ?? {}) });
export const describeLimits = (plan: VipPlan): string[] => {
  const l = limitsOf(plan);
  const n = (v: number) => v.toLocaleString("fa-IR");
  return [
    l.showPrices ? "مشاهده قیمت سری‌ها" : "بدون نمایش قیمت عمده",
    l.sources === "all" ? "خرید از کلبه و همه تأمین‌کنندگان" : "فقط محصولات عمده کلبه وینتیج",
    l.maxOrdersPerMonth ? `حداکثر ${n(l.maxOrdersPerMonth)} سفارش در ماه` : "سفارش ماهانه نامحدود",
    l.maxOrderValue ? `سقف هر سفارش ${n(l.maxOrderValue)} تومان` : "بدون سقف مبلغ سفارش",
    l.maxSuppliersPerOrder ? `حداکثر ${n(l.maxSuppliersPerOrder)} تأمین‌کننده در هر سفارش` : "تأمین‌کننده نامحدود در هر سفارش",
    ...(l.discountPercent ? [`${n(l.discountPercent)}٪ تخفیف روی همه سری‌ها`] : []),
    ...(plan.creditLimit && l.creditDays ? [`اعتبار ${n(plan.creditLimit)} تومان · تسویه ${n(l.creditDays)} روزه`] : []),
    ...(l.freeShipping ? ["ارسال رایگان باربری"] : []),
    ...(l.prioritySupport ? ["پشتیبانی با اولویت"] : []),
  ];
};
export const SEED_PLANS: VipPlan[] = [
  { id: "silver", name: "نقره‌ای", yearly: 0, creditLimit: 0, active: true, features: ["پیش‌فاکتور رسمی"], limits: { showPrices: true, sources: "kolbe", maxOrdersPerMonth: 3, maxOrderValue: 150000000, discountPercent: 0, creditDays: 0, freeShipping: false, prioritySupport: false, maxSuppliersPerOrder: 1 } },
  { id: "gold", name: "طلایی", yearly: 24000000, creditLimit: 500000000, active: true, recommended: true, features: ["کارشناس اختصاصی حساب"], limits: { showPrices: true, sources: "all", maxOrdersPerMonth: 20, maxOrderValue: 800000000, discountPercent: 3, creditDays: 30, freeShipping: false, prioritySupport: true, maxSuppliersPerOrder: 5 } },
  { id: "platinum", name: "پلاتینیوم", yearly: 60000000, creditLimit: 2000000000, active: true, features: ["گزارش خرید فصلی"], limits: { showPrices: true, sources: "all", maxOrdersPerMonth: null, maxOrderValue: null, discountPercent: 6, creditDays: 60, freeShipping: true, prioritySupport: true, maxSuppliersPerOrder: null } },
];

/* ---------------- Shipping ---------------- */
export type ShippingMethod = { id: string; name: string; carrier: string; scope: "خرده" | "عمده" | "هر دو"; price: number; freeAbove: number | null; eta: string; zones: string; active: boolean };
export const SEED_SHIPPING: ShippingMethod[] = [
  { id: "post", name: "پست پیشتاز", carrier: "شرکت پست", scope: "خرده", price: 180000, freeAbove: 5000000, eta: "۲ تا ۴ روز کاری", zones: "سراسر کشور", active: true },
  { id: "tipax", name: "تیپاکس", carrier: "تیپاکس", scope: "هر دو", price: 260000, freeAbove: null, eta: "۱ تا ۳ روز کاری", zones: "مراکز استان", active: true },
  { id: "courier", name: "پیک فوری تهران", carrier: "ناوگان کلبه", scope: "خرده", price: 120000, freeAbove: 3000000, eta: "همان روز", zones: "تهران", active: true },
  { id: "freight", name: "باربری سراسری", carrier: "باربری طرف قرارداد", scope: "عمده", price: 0, freeAbove: null, eta: "۳ تا ۶ روز کاری · پس‌کرایه", zones: "سراسر کشور", active: true },
  { id: "chapar", name: "چاپار", carrier: "چاپار", scope: "خرده", price: 220000, freeAbove: null, eta: "۲ تا ۳ روز کاری", zones: "سراسر کشور", active: false },
];

/* ---------------- Integrations ---------------- */
export type Integration = { id: string; name: string; kind: "CRM" | "حسابداری" | "پیامک" | "پرداخت" | "لجستیک"; desc: string; connected: boolean; lastSync?: string };
export const SEED_INTEGRATIONS: Integration[] = [
  { id: "didar", name: "دیدار CRM", kind: "CRM", desc: "همگام‌سازی مشتریان، سرنخ‌ها و پیگیری‌های فروش", connected: true, lastSync: "۱۰ دقیقه پیش" },
  { id: "payamgostar", name: "پیام‌گستر", kind: "CRM", desc: "مدیریت ارتباط با خریداران عمده و تیکت‌ها", connected: false },
  { id: "hubspot", name: "HubSpot", kind: "CRM", desc: "اتوماسیون بازاریابی و ایمیل", connected: false },
  { id: "sepidar", name: "سپیدار", kind: "حسابداری", desc: "صدور سند فروش، فاکتور و تسویه تأمین‌کنندگان", connected: true, lastSync: "امروز ۰۸:۰۰" },
  { id: "holoo", name: "هلو", kind: "حسابداری", desc: "انبار، فاکتور و حسابداری فروشگاهی", connected: false },
  { id: "hesabfa", name: "حسابفا", kind: "حسابداری", desc: "حسابداری ابری و صورت‌حساب", connected: false },
  { id: "quickbooks", name: "QuickBooks", kind: "حسابداری", desc: "حسابداری بین‌المللی برای صادرات", connected: false },
  { id: "kavenegar", name: "کاوه‌نگار", kind: "پیامک", desc: "ارسال پیامک اعلان‌ها و کد ورود", connected: true, lastSync: "لحظاتی پیش" },
  { id: "zarinpal", name: "زرین‌پال", kind: "پرداخت", desc: "درگاه پرداخت خرده و عمده", connected: true, lastSync: "لحظاتی پیش" },
  { id: "behpardakht", name: "به‌پرداخت ملت", kind: "پرداخت", desc: "درگاه پشتیبان", connected: false },
  { id: "postapi", name: "API پست", kind: "لجستیک", desc: "ثبت مرسوله و رهگیری خودکار", connected: true, lastSync: "۱ ساعت پیش" },
  { id: "tipaxapi", name: "API تیپاکس", kind: "لجستیک", desc: "جمع‌آوری از انبار و رهگیری", connected: false },
];

/* ---------------- Wholesale buyers ---------------- */
export type Buyer = { id: string; name: string; city: string; planId: string; status: "فعال" | "در انتظار تأیید" | "مسدود"; since: string; contact: string; spent: number; accountId?: string; tradeCode?: string; submittedAt?: string };
export const SEED_BUYERS: Buyer[] = [
  { id: "b1", name: BUYER_DEMO, city: "تهران", planId: "gold", status: "فعال", since: "۱۴۰۲", contact: "۰۹۱۲ ۱۱۱ ۲۲۳۳", spent: 412000000, accountId: "acc-vip" },
  { id: "b2", name: "گالری ماهور — اصفهان", city: "اصفهان", planId: "silver", status: "فعال", since: "۱۴۰۳", contact: "۰۹۱۳ ۴۴۰ ۱۱۹۰", spent: 128000000 },
  { id: "b3", name: "پوشاک رادین — مشهد", city: "مشهد", planId: "gold", status: "فعال", since: "۱۴۰۲", contact: "۰۹۱۵ ۲۲۰ ۷۷۰۱", spent: 265000000 },
  { id: "b4", name: "مزون شیدا — شیراز", city: "شیراز", planId: "platinum", status: "فعال", since: "۱۴۰۱", contact: "۰۹۱۷ ۳۳۰ ۹۹۰۲", spent: 890000000 },
  { id: "b5", name: "فروشگاه نیک‌پوش — تبریز", city: "تبریز", planId: "silver", status: "در انتظار تأیید", since: "۱۴۰۴", contact: "۰۹۱۴ ۵۵۰ ۱۲۳۴", spent: 0 },
  { id: "b6", name: "بوتیک رز — کرج", city: "کرج", planId: "silver", status: "در انتظار تأیید", since: "۱۴۰۴", contact: "۰۹۱۲ ۹۸۰ ۴۵۶۷", spent: 0 },
  { id: "b7", name: "پوشاک آرین — اهواز", city: "اهواز", planId: "silver", status: "مسدود", since: "۱۴۰۳", contact: "۰۹۱۶ ۷۷۰ ۸۸۹۹", spent: 34000000 },
];

/* ---------------- Retail customers (CRM) ---------------- */
export type Customer = { id: string; name: string; phone: string; city: string; orders: number; spent: number; segment: "وفادار" | "جدید" | "در خطر ریزش" | "پرخرج"; last: string };
export const SEED_CUSTOMERS: Customer[] = [
  { id: "c1", name: "سارا محمدی", phone: "۰۹۱۲ ۳۴۵ ۶۷۸۹", city: "تهران", orders: 7, spent: 61400000, segment: "وفادار", last: "امروز" },
  { id: "c2", name: "نگار کریمی", phone: "۰۹۳۵ ۱۲۰ ۴۴۱۰", city: "کرج", orders: 2, spent: 15800000, segment: "جدید", last: "دیروز" },
  { id: "c3", name: "امیر رضایی", phone: "۰۹۱۹ ۸۸۰ ۲۳۲۳", city: "تهران", orders: 4, spent: 38200000, segment: "پرخرج", last: "۲ روز پیش" },
  { id: "c4", name: "مریم احمدی", phone: "۰۹۱۷ ۶۶۰ ۹۰۹۰", city: "شیراز", orders: 9, spent: 72500000, segment: "وفادار", last: "۵ روز پیش" },
  { id: "c5", name: "حسین نادری", phone: "۰۹۱۳ ۲۲۰ ۸۸۰۱", city: "اصفهان", orders: 1, spent: 6400000, segment: "در خطر ریزش", last: "۳ ماه پیش" },
  { id: "c6", name: "لیلا موسوی", phone: "۰۹۱۵ ۴۴۰ ۵۵۰۲", city: "مشهد", orders: 3, spent: 24900000, segment: "در خطر ریزش", last: "۲ ماه پیش" },
  { id: "c7", name: "پریسا شریفی", phone: "۰۹۱۲ ۰۰۹ ۷۷۷۰", city: "تهران", orders: 12, spent: 118000000, segment: "پرخرج", last: "هفته پیش" },
  { id: "c8", name: "کیان صادقی", phone: "۰۹۱۱ ۳۳۰ ۶۶۰۴", city: "رشت", orders: 1, spent: 8900000, segment: "جدید", last: "امروز" },
];

/* ---------------- CMS ---------------- */
export type CmsItem = { id: string; title: string; type: "صفحه" | "بنر" | "مقاله"; slug: string; status: "منتشر" | "پیش‌نویس"; updated: string };
export const SEED_CMS: CmsItem[] = [
  { id: "m1", title: "صفحه اصلی فروشگاه", type: "صفحه", slug: "/", status: "منتشر", updated: "امروز" },
  { id: "m2", title: "بنر هیرو — پاییز ۱۴۰۴", type: "بنر", slug: "hero-autumn", status: "منتشر", updated: "دیروز" },
  { id: "m3", title: "درباره کلبه", type: "صفحه", slug: "/about", status: "منتشر", updated: "هفته پیش" },
  { id: "m4", title: "راهنمای انتخاب بارانی برای پاییز امسال", type: "مقاله", slug: "/journal/raincoat-guide", status: "منتشر", updated: "۳ روز پیش" },
  { id: "m5", title: "از پارچه تا پوشاک: سفری به کارگاه نیلگون", type: "مقاله", slug: "/journal/nilgoon", status: "منتشر", updated: "هفته پیش" },
  { id: "m6", title: "پنج ترکیب رنگ که همیشه جواب می‌دهد", type: "مقاله", slug: "/journal/color-combos", status: "منتشر", updated: "۲ هفته پیش" },
  { id: "m7", title: "قوانین بازگشت کالا", type: "صفحه", slug: "/returns", status: "منتشر", updated: "ماه پیش" },
  { id: "m8", title: "بنر بازارچه عمده — کالکشن زمستان", type: "بنر", slug: "wholesale-winter", status: "پیش‌نویس", updated: "امروز" },
  { id: "m9", title: "لوک‌بوک زمستان ۱۴۰۴", type: "مقاله", slug: "/journal/winter-lookbook", status: "پیش‌نویس", updated: "دیروز" },
];

/* ---------------- Notifications ---------------- */
export type NotifTemplate = { id: string; event: string; audience: string; sms: boolean; email: boolean; push: boolean; active: boolean };
export const SEED_NOTIFS: NotifTemplate[] = [
  { id: "n1", event: "ثبت سفارش خرده", audience: "مشتری", sms: true, email: true, push: true, active: true },
  { id: "n2", event: "ارسال سفارش خرده + کد رهگیری", audience: "مشتری", sms: true, email: false, push: true, active: true },
  { id: "n3", event: "زیرسفارش جدید در انتظار تأیید", audience: "تأمین‌کننده", sms: true, email: true, push: true, active: true },
  { id: "n4", event: "تأیید زیرسفارش توسط تأمین‌کننده", audience: "خریدار عمده", sms: true, email: true, push: false, active: true },
  { id: "n5", event: "یادآوری پرداخت زیرسفارش (۲۴ ساعت)", audience: "خریدار عمده", sms: true, email: false, push: true, active: true },
  { id: "n6", event: "ارسال زیرسفارش عمده", audience: "خریدار عمده", sms: true, email: true, push: true, active: true },
  { id: "n7", event: "محصول جدید در انتظار بازبینی", audience: "اپراتور کلبه", sms: false, email: true, push: true, active: true },
  { id: "n8", event: "تأیید عضویت عمده", audience: "خریدار عمده", sms: true, email: true, push: false, active: true },
  { id: "n9", event: "هشدار موجودی کم", audience: "تأمین‌کننده", sms: false, email: true, push: true, active: false },
  { id: "n10", event: "کد ورود یک‌بارمصرف", audience: "همه", sms: true, email: false, push: false, active: true },
];
