import { IMG, PRODUCTS } from "./catalog";

export type RetailCartLine = { id: string; qty: number; size: string; color: string };
export type CustomerAddress = {
  id: string;
  title: string;
  recipient: string;
  phone: string;
  province: string;
  city: string;
  line: string;
  postalCode: string;
  isDefault: boolean;
};
export type CustomerPreferences = {
  orderUpdates: boolean;
  offers: boolean;
  sms: boolean;
  email: boolean;
};
export type SavedStyle = { id: string; title: string; productIds: string[]; savedAt: string };
export type CustomerTicket = {
  id: string;
  subject: string;
  message: string;
  createdAt: string;
  status: "در انتظار" | "در حال بررسی" | "تأیید شد";
};
export type CustomerAccount = {
  id: string;
  phone: string;
  name: string;
  email: string;
  birthday: string;
  joinedAt: string;
  addresses: CustomerAddress[];
  wishlist: string[];
  cart: RetailCartLine[];
  preferences: CustomerPreferences;
  savedStyles: SavedStyle[];
  tickets: CustomerTicket[];
};
export type RetailOrderLine = {
  productId: string;
  name: string;
  image: string;
  color: string;
  size: string;
  qty: number;
  unitPrice: number;
};
export type RetailOrder = {
  id: string;
  accountId: string;
  createdAt: string;
  status: "در انتظار پرداخت" | "پرداخت شد" | "در حال پردازش" | "در حال آماده‌سازی" | "آماده ارسال" | "در حال ارسال" | "ارسال شد" | "تحویل شد" | "لغو شد" | "مرجوعی";
  lines: RetailOrderLine[];
  shippingMethod: string;
  shippingFee: number;
  address: CustomerAddress;
  total: number;
  paymentMode?: "cash" | "four_installments";
  events: { title: string; time: string; by?: string; note?: string }[];
  tracking?: string;
  returnRequest?: { reason: string; createdAt: string; status: "در انتظار بررسی" | "تأیید شد" | "رد شد" };
};

export const digitsOnly = (value: string) => value
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
  .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
  .replace(/\D/g, "");

const demoAddress: CustomerAddress = {
  id: "addr-sara-home",
  title: "خانه",
  recipient: "سارا محمدی",
  phone: "09123456789",
  province: "تهران",
  city: "تهران",
  line: "خیابان ولیعصر، کوچه بهار، پلاک ۱۲، واحد ۴",
  postalCode: "1234567890",
  isDefault: true,
};

export const SEED_ACCOUNTS: CustomerAccount[] = [
  {
    id: "acc-sara", phone: "09123456789", name: "سارا محمدی", email: "sara@example.com", birthday: "", joinedAt: "۱۴۰۳",
    addresses: [demoAddress], wishlist: ["p1", "p5"], cart: [],
    preferences: { orderUpdates: true, offers: false, sms: true, email: false },
    savedStyles: [], tickets: [],
  },
  {
    id: "acc-vip", phone: "09121112233", name: "علی رضایی", email: "ali@example.com", birthday: "", joinedAt: "۱۴۰۲",
    addresses: [{ id: "addr-vip", title: "بوتیک آوا", recipient: "علی رضایی", phone: "09121112233", province: "تهران", city: "تهران", line: "بازار بزرگ، پاساژ آوا، پلاک ۱۲", postalCode: "1111111111", isDefault: true }],
    wishlist: ["p2"], cart: [],
    preferences: { orderUpdates: true, offers: true, sms: true, email: true },
    savedStyles: [], tickets: [],
  },
];

// These are explicitly sample orders for the two demo accounts, not new-user data.
export const SEED_RETAIL_ORDERS: RetailOrder[] = [
  {
    id: "KV-88214", accountId: "acc-sara", createdAt: "امروز ۱۰:۲۴", status: "در حال آماده‌سازی",
    lines: [
      { productId: "p1", name: PRODUCTS[0].name, image: IMG.hijabTrench, color: "کرمی", size: "M", qty: 1, unitPrice: PRODUCTS[0].retailPrice },
      { productId: "p2", name: PRODUCTS[1].name, image: IMG.shirtRack, color: "نارنجی آجری", size: "M", qty: 1, unitPrice: PRODUCTS[1].retailPrice },
    ],
    shippingMethod: "پست پیشتاز", shippingFee: 0, address: demoAddress, total: PRODUCTS[0].retailPrice + PRODUCTS[1].retailPrice,
    events: [{ title: "سفارش ثبت و پرداخت شد", time: "امروز ۱۰:۲۴" }, { title: "آماده‌سازی در انبار کلبه آغاز شد", time: "امروز ۱۱:۱۰" }],
  },
  {
    id: "KV-88018", accountId: "acc-sara", createdAt: "۱۲ روز پیش", status: "تحویل شد",
    lines: [{ productId: "p8", name: PRODUCTS[7].name, image: IMG.blackSuit, color: "مشکی", size: "L", qty: 1, unitPrice: PRODUCTS[7].retailPrice }],
    shippingMethod: "پیک فوری تهران", shippingFee: 0, address: demoAddress, total: PRODUCTS[7].retailPrice,
    tracking: "KVB-88018",
    events: [{ title: "سفارش ثبت و پرداخت شد", time: "۱۲ روز پیش" }, { title: "بسته از انبار ارسال شد", time: "۱۰ روز پیش" }, { title: "سفارش تحویل داده شد", time: "۹ روز پیش" }],
  },
];
