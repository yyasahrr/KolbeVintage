/* Operations store: now delegates to server APIs (/api/v1/*) for CMS, finance, CRM, coupons, etc.
   localStorage is retained only for non-sensitive UI prefs; authoritative operations state lives in PostgreSQL. */
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { IMG } from "./catalog";
import { apiClient } from "./api";
import { TICKET_STATUSES, TICKET_STATUS_LABEL, TICKET_PRIORITY_LABEL, type TicketStatus, type TicketPriority } from "./contracts";

/* ---------------- CMS ---------------- */
export type HeroTemplate = "split" | "fullbleed" | "video" | "carousel" | "minimal" | "mosaic";
export type HeroSlide = { image: string; title: string; subtitle: string };
export type HeroConfig = {
  template: HeroTemplate; eyebrow: string; title: string; subtitle: string;
  ctaLabel: string; ctaTarget: "shop" | "vip" | "tryon" | "journal";
  secondaryLabel: string; secondaryTarget: "shop" | "vip" | "tryon" | "journal";
  image: string; video: string; poster: string; overlay: number; align: "right" | "center";
  slides: HeroSlide[]; mosaic: string[];
};
export type BlockType = "announcement" | "countdown" | "banner" | "products" | "trust" | "newsletter" | "testimonials" | "faq" | "richtext";
export type BlockProps = {
  title?: string; text?: string; image?: string; target?: "shop" | "vip" | "tryon" | "journal";
  cta?: string; endsAt?: string; category?: string; count?: number; tone?: "navy" | "terra" | "stone"; items?: string;
};
export type CmsBlock = { id: string; type: BlockType; name: string; enabled: boolean; props: BlockProps };

/* ---------------- Quick support ---------------- */
export type QuickChannelId = "telegram" | "instagram" | "whatsapp" | "bale" | "eitaa" | "phone" | "email";
export type QuickChannel = { id: QuickChannelId; label: string; value: string; enabled: boolean };
export type QuickSupport = { enabled: boolean; title: string; hours: string; channels: QuickChannel[] };
export const channelHref = (c: QuickChannel) => {
  const v = c.value.trim().replace(/^@/, "");
  switch (c.id) {
    case "telegram": return `https://t.me/${v}`;
    case "instagram": return `https://instagram.com/${v}`;
    case "whatsapp": return `https://wa.me/${v.replace(/\D/g, "")}`;
    case "bale": return `https://ble.ir/${v}`;
    case "eitaa": return `https://eitaa.com/${v}`;
    case "phone": return `tel:${v.replace(/\s/g, "")}`;
    case "email": return `mailto:${v}`;
  }
};

/* ---------------- Series templates ---------------- */
export type SeriesCategory = "لباس" | "شلوار" | "کفش" | "اکسسوری" | "سایر";
export type SeriesTemplate = { id: string; ownerId: string; name: string; category?: SeriesCategory; productTypeId?: string; composition: Record<string, number>; defaultMoq: number; note?: string };

/* ---------------- Supplier finance ---------------- */
export type SupplierBank = {
  legalName: string; nationalId: string; economicCode: string; holder: string; iban: string; card: string;
  bankName: string; address: string; postalCode: string; status: "draft" | "pending" | "verified" | "rejected"; note?: string; updatedAt?: string;
};
export type Withdrawal = { id: string; supplierId: string; supplierName: string; amount: number; status: "requested" | "approved" | "paid" | "rejected"; createdAt: string; iban: string; ref?: string; note?: string };

/* ---------------- Supplier onboarding ---------------- */
export type FieldType = "text" | "textarea" | "number" | "phone" | "email" | "select" | "checkbox" | "file";
export type FormField = { id: string; label: string; type: FieldType; required: boolean; options?: string[]; hint?: string };
export type ApplicationForm = { title: string; intro: string; active: boolean; fields: FormField[] };
export type Application = { id: string; name: string; values: Record<string, string>; status: "new" | "reviewing" | "approved" | "rejected"; createdAt: string; note?: string };
export type ExtraSupplier = { id: string; name: string; city: string; since: string };

/* ---------------- Restrictions ---------------- */
export type RestrictionFlags = { block: boolean; noOrder: boolean; noWholesale: boolean; noReturn: boolean; noPublish: boolean; noWithdraw: boolean };
export type Restriction = { id: string; subjectType: "supplier" | "customer"; subjectId: string; subjectName: string; flags: RestrictionFlags; reason: string; until?: string; createdAt: string };
export const NO_FLAGS: RestrictionFlags = { block: false, noOrder: false, noWholesale: false, noReturn: false, noPublish: false, noWithdraw: false };

/* ---------------- Support ---------------- */
export type TicketMessage = { from: "user" | "agent"; name: string; text: string; at: string };
export type TicketAttachment = { name: string; dataUrl: string; size: number };
export type TicketEvent = { at: string; by: string; action: string };
export type { TicketStatus, TicketPriority };
export type Ticket = {
  id: string; ownerType: "customer" | "supplier"; ownerId: string; ownerName: string; subject: string; category: string;
  priority: TicketPriority; status: TicketStatus;
  orderRef?: string; createdAt: string; messages: TicketMessage[]; department?: string; assignee?: string;
  slaDueAt?: string; attachments?: TicketAttachment[]; events?: TicketEvent[];
};
/** Single source of truth for statuses (backend enum) and their UI labels. */
export const TICKET_STATUSES_LIST = TICKET_STATUSES;
export const TICKET_STATUS = TICKET_STATUS_LABEL;
export const TICKET_PRIORITY = TICKET_PRIORITY_LABEL;
export type ReturnReq = {
  id: string; channel: "retail" | "wholesale"; orderId: string; ownerId: string; ownerName: string; items: string; reason: string;
  resolution: "refund" | "exchange" | "credit"; status: "requested" | "approved" | "received" | "refunded" | "rejected"; amount: number; createdAt: string; events: { t: string; at: string }[];
};
export const RETURN_STATUS: Record<ReturnReq["status"], string> = { requested: "در انتظار بررسی", approved: "تأیید شد", received: "کالا دریافت شد", refunded: "بازپرداخت شد", rejected: "رد شد" };

/* ---------------- SMS ---------------- */
export type SmsConfig = { provider: string; apiKey: string; sender: string; connected: boolean; pricePerPart: number; lastCheck?: string };
export type SmsCampaign = { id: string; name: string; audience: string; recipients: number; message: string; parts: number; cost: number; status: "scheduled" | "sent" | "draft"; at: string };

/* ---------------- Promotions ---------------- */
export type Coupon = { id: string; code: string; type: "percent" | "fixed" | "freeShip"; value: number; minOrder: number; maxUses: number; used: number; channel: "retail" | "wholesale"; expires: string; active: boolean };
export type Festival = { id: string; name: string; starts: string; ends: string; discountPercent: number; categories: string[]; active: boolean; bannerText: string };
export type PromotionTargetType = "product" | "color" | "size" | "variant";
export type PromotionRule = {
  id: string;
  name: string;
  targetType: PromotionTargetType;
  productId: string;
  colorId?: string;
  sizeCode?: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  starts?: string;
  ends?: string;
  priority: number;
  active: boolean;
  /** DEC-PRICING-001 (Option A): a rule suspended by a festival stays dormant until explicit reactivation. */
  suspendedByPromotionId?: string | null;
};

export type ResolvedPromotionPrice = {
  basePrice: number;
  matchedRule: {
    id: string;
    name: string;
    targetType: PromotionTargetType | "festival";
    priority: number;
  } | null;
  discountType: "percent" | "fixed" | null;
  discountValue: number | null;
  discountAmount: number;
  finalPrice: number;
  startsAt: string | null;
  endsAt: string | null;
  source: "promotion_rule" | "festival" | "none";
};

const COLOR_NORMALIZE: Record<string, string> = {
  black: "black", "مشکی": "black",
  orange: "orange", "نارنجی آجری": "orange", "نارنجی": "orange",
  cream: "cream", "کرمی": "cream",
  olive: "olive", "زیتونی": "olive",
  sand: "sand", "شنی": "sand",
  navy: "navy", "سرمه‌ای": "navy",
  white: "white", "سفید": "white",
  burgundy: "burgundy", "زرشکی": "burgundy",
  brown: "brown", "قهوه‌ای": "brown",
  gray: "gray", "طوسی": "gray",
};

const normColor = (v?: string) => {
  if (!v) return "";
  const k = v.trim().toLowerCase();
  return COLOR_NORMALIZE[k] ?? k;
};
const normSize = (v?: string) => (v ? v.trim().toUpperCase() : "");

const targetSpecificity = (t: PromotionTargetType) =>
  t === "variant" ? 40 : t === "color" ? 30 : t === "size" ? 20 : 10;

export function resolveVariantPromotion(
  product: { id: string; category: string; retailPrice: number; installmentPrice?: number },
  colorIdOrName: string | undefined,
  sizeCode: string | undefined,
  rules: PromotionRule[],
  festivals: Festival[],
  paymentMode: "cash" | "four_installments" = "cash",
): ResolvedPromotionPrice {
  const basePrice = paymentMode === "four_installments"
    ? (product.installmentPrice ?? product.retailPrice)
    : product.retailPrice;
  const today = new Date().toISOString().slice(0, 10);
  const cKey = normColor(colorIdOrName);
  const sKey = normSize(sizeCode);

  const matchingRules = (rules ?? []).filter((r) => {
    if (!r.active) return false;
    // DEC-PRICING-001 (Option A): festival-suspended rules never price the storefront.
    if (r.suspendedByPromotionId || (r as unknown as Record<string, unknown>).suspended_by_promotion_id) return false;
    if (r.starts && r.starts > today) return false;
    if (r.ends && r.ends < today) return false;
    if (r.productId !== product.id) return false;
    if (r.targetType === "variant") {
      return normColor(r.colorId) === cKey && normSize(r.sizeCode) === sKey;
    }
    if (r.targetType === "color") {
      return normColor(r.colorId) === cKey;
    }
    if (r.targetType === "size") {
      return normSize(r.sizeCode) === sKey;
    }
    return r.targetType === "product";
  });

  if (matchingRules.length > 0) {
    const sorted = [...matchingRules].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const spec = targetSpecificity(b.targetType) - targetSpecificity(a.targetType);
      if (spec !== 0) return spec;
      const amtA = a.discountType === "percent" ? Math.round((basePrice * a.discountValue) / 100) : Math.min(basePrice, a.discountValue);
      const amtB = b.discountType === "percent" ? Math.round((basePrice * b.discountValue) / 100) : Math.min(basePrice, b.discountValue);
      return amtB - amtA;
    });
    const winner = sorted[0]!;
    const discountAmount = winner.discountType === "percent"
      ? Math.round((basePrice * Math.min(95, winner.discountValue)) / 100)
      : Math.min(basePrice, winner.discountValue);
    return {
      basePrice,
      matchedRule: {
        id: winner.id,
        name: winner.name,
        targetType: winner.targetType,
        priority: winner.priority,
      },
      discountType: winner.discountType,
      discountValue: winner.discountValue,
      discountAmount,
      finalPrice: Math.max(0, basePrice - discountAmount),
      startsAt: winner.starts ?? null,
      endsAt: winner.ends ?? null,
      source: "promotion_rule",
    };
  }

  const liveFestivals = (festivals ?? []).filter(
    (f) => f.active && f.starts <= today && f.ends >= today && f.categories.includes(product.category),
  );
  if (liveFestivals.length > 0) {
    const bestFest = [...liveFestivals].sort((a, b) => b.discountPercent - a.discountPercent)[0]!;
    const discountAmount = Math.round((basePrice * bestFest.discountPercent) / 100);
    return {
      basePrice,
      matchedRule: {
        id: bestFest.id,
        name: bestFest.name,
        targetType: "festival",
        priority: 0,
      },
      discountType: "percent",
      discountValue: bestFest.discountPercent,
      discountAmount,
      finalPrice: Math.max(0, basePrice - discountAmount),
      startsAt: bestFest.starts,
      endsAt: bestFest.ends,
      source: "festival",
    };
  }

  return {
    basePrice,
    matchedRule: null,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    finalPrice: basePrice,
    startsAt: null,
    endsAt: null,
    source: "none",
  };
}

/* ---------------- CRM ---------------- */
export type LeadStage = "new" | "contacted" | "qualified" | "won" | "lost";
export type Lead = { id: string; name: string; phone: string; source: string; stage: LeadStage; value: number; owner: string; note: string; createdAt: string };
export type CrmTask = { id: string; title: string; customer: string; due: string; done: boolean; type: "call" | "sms" | "meeting" };
export type CrmNote = { id: string; customerId: string; text: string; at: string };

export type OpsState = {
  hero: HeroConfig; blocks: CmsBlock[]; quickSupport: QuickSupport; n8n: { webhookUrl: string; enabled: boolean };
  seriesTemplates: SeriesTemplate[]; banks: Record<string, SupplierBank>; withdrawals: Withdrawal[]; commissions: Record<string, number>;
  applicationForm: ApplicationForm; applications: Application[]; extraSuppliers: ExtraSupplier[];
  restrictions: Restriction[]; tickets: Ticket[]; returns: ReturnReq[];
  sms: SmsConfig; smsCampaigns: SmsCampaign[]; coupons: Coupon[]; festivals: Festival[]; promotionRules: PromotionRule[];
  leads: Lead[]; tasks: CrmTask[]; notes: CrmNote[]; tags: Record<string, string[]>;
};

const now = () => new Date().toLocaleString("fa-IR");
const inDays = (d: number) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 16);
export const HERO_VIDEO = "https://videos.pexels.com/video-files/5822173/5822173-hd_1920_1080_25fps.mp4";
export const HERO_VIDEO_ALT = "https://videos.pexels.com/video-files/8485166/8485166-hd_1920_1080_25fps.mp4";

const USE_DEMO_SEED_OPS = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
const seed = (): OpsState => USE_DEMO_SEED_OPS ? ({
  hero: {
    template: "split", eyebrow: "کالکشن پاییز ۱۴۰۴", title: "سبک‌های ماندگار\nبرای امروز و فردا",
    subtitle: "منتخب پوشاک کلاسیک و مدرن از بهترین تأمین‌کنندگان؛ با ضمانت اصالت، برگشت آسان و ارسال به سراسر کشور.",
    ctaLabel: "مشاهده کالکشن‌ها", ctaTarget: "shop", secondaryLabel: "پرو مجازی", secondaryTarget: "tryon",
    image: IMG.trenchHero, video: HERO_VIDEO, poster: IMG.trenchStreet, overlay: 45, align: "right",
    slides: [
      { image: IMG.trenchHero, title: "بارانی‌های فصل", subtitle: "برش کلاسیک، پارچه ضدآب" },
      { image: IMG.blazerDuo, title: "کت و بلیزر", subtitle: "رسمی، سبک، روزمره" },
      { image: IMG.redCoat, title: "پالتوهای طراح‌دار", subtitle: "کالکشن ویژه زمستان" },
    ],
    mosaic: [IMG.trenchArch, IMG.shirtsColor, IMG.blazerDuo, IMG.burgundyCoat],
  },
  blocks: [
    { id: "b-ann", type: "announcement", name: "نوار اعلان بالای سایت", enabled: true, props: { text: "ارسال رایگان خریدهای بالای ۵ میلیون تومان · کد PAIZ1404 برای ۱۰٪ تخفیف", target: "shop", tone: "navy" } },
    { id: "b-count", type: "countdown", name: "تایمر جشنواره پاییزه", enabled: true, props: { title: "جشنواره پاییزه کلبه", text: "۱۵٪ تخفیف روی همه بارانی‌ها و پالتوها", endsAt: inDays(3), cta: "خرید از جشنواره", target: "shop", tone: "terra" } },
    { id: "b-banner", type: "banner", name: "بنر بازارچه عمده", enabled: true, props: { title: "خرید عمده برای بوتیک‌ها", text: "با همان حساب کلبه عضو عمده شوید و سری‌ها را مستقیم از تأمین‌کننده بخرید.", image: IMG.neutralRack, cta: "ورود به بازارچه", target: "vip", tone: "navy" } },
    { id: "b-test", type: "testimonials", name: "نظرات مشتریان", enabled: true, props: { title: "مشتری‌ها درباره کلبه", items: "کیفیت دوخت بارانی فوق‌العاده بود و دقیقاً اندازه راهنمای سایز شد.|مریم احمدی · شیراز\nبرای بوتیکم سری کامل سفارش دادم؛ تأمین‌کننده همان روز تأیید کرد.|بوتیک آوا · تهران\nمرجوعی سایز خیلی ساده انجام شد و پول برگشت.|امیر رضایی · تهران" } },
    { id: "b-faq", type: "faq", name: "پرسش‌های پرتکرار", enabled: false, props: { title: "پرسش‌های پرتکرار", items: "زمان ارسال چقدر است؟|سفارش‌های تهران همان روز و شهرستان‌ها ۲ تا ۴ روز کاری ارسال می‌شوند.\nچطور مرجوع کنم؟|از حساب من › سفارش‌ها تا ۷ روز پس از تحویل درخواست بازگشت ثبت کنید." } },
    { id: "b-news", type: "newsletter", name: "عضویت در خبرنامه", enabled: false, props: { title: "از کالکشن‌های تازه زودتر باخبر شوید", text: "ماهی یک ایمیل؛ بدون تبلیغ اضافه." } },
  ],
  quickSupport: {
    enabled: true, title: "پشتیبانی سریع کلبه", hours: "شنبه تا پنجشنبه · ۹ تا ۲۱",
    channels: [
      { id: "telegram", label: "تلگرام", value: "kolbevintage", enabled: true },
      { id: "instagram", label: "اینستاگرام", value: "kolbe.vintage", enabled: true },
      { id: "whatsapp", label: "واتس‌اپ", value: "989121234567", enabled: true },
      { id: "bale", label: "بله", value: "kolbevintage", enabled: true },
      { id: "eitaa", label: "ایتا", value: "kolbevintage", enabled: false },
      { id: "phone", label: "تماس تلفنی", value: "02191008800", enabled: true },
      { id: "email", label: "ایمیل", value: "support@kolbe.ir", enabled: false },
    ],
  },
  n8n: { webhookUrl: "", enabled: false },
  seriesTemplates: [
    { id: "tpl-k-full", ownerId: "kolbe", name: "سری کامل ۱۲ تایی", composition: { S: 2, M: 2, L: 2, XL: 2, "2XL": 2, "3XL": 2 }, defaultMoq: 2 },
    { id: "tpl-k-half", ownerId: "kolbe", name: "نیم‌سری ۶ تایی", composition: { S: 1, M: 1, L: 1, XL: 1, "2XL": 1, "3XL": 1 }, defaultMoq: 4 },
    { id: "tpl-k-core", ownerId: "kolbe", name: "سری پرفروش ۸ تایی", composition: { M: 2, L: 3, XL: 2, "2XL": 1 }, defaultMoq: 3 },
    { id: "tpl-s1-full", ownerId: "s1", name: "سری کامل نیلگون", composition: { S: 2, M: 2, L: 2, XL: 2, "2XL": 2, "3XL": 2 }, defaultMoq: 2 },
    { id: "tpl-s1-mini", ownerId: "s1", name: "سری آزمایشی ۴ تایی", composition: { M: 1, L: 2, XL: 1 }, defaultMoq: 5, note: "برای بوتیک‌هایی که اولین خریدشان است" },
  ],
  banks: {
    s1: { legalName: "تولیدی پوشاک نیلگون", nationalId: "14006543210", economicCode: "411122223333", holder: "محمد نیلگون", iban: "IR820540102680020817909002", card: "6104337712345678", bankName: "بانک پارسیان", address: "تهران، خیابان جمهوری، پاساژ نیلگون", postalCode: "1134567890", status: "verified", updatedAt: "۱۴۰۴/۰۶/۱۲" },
  },
  withdrawals: [
    { id: "WD-1021", supplierId: "s1", supplierName: "نیلگون", amount: 42000000, status: "paid", createdAt: "۱۰ روز پیش", iban: "IR820540102680020817909002", ref: "PAYA-88213" },
    { id: "WD-1034", supplierId: "s2", supplierName: "فراسو", amount: 18500000, status: "requested", createdAt: "دیروز", iban: "IR530560611828005470117001" },
  ],
  commissions: { s1: 8, s2: 8, s3: 10, s4: 7 },
  applicationForm: {
    title: "درخواست همکاری به‌عنوان تأمین‌کننده", active: true,
    intro: "اطلاعات کسب‌وکار خود را وارد کنید. تیم کلبه ظرف دو روز کاری درخواست را بررسی و نتیجه را پیامک می‌کند.",
    fields: [
      { id: "f-brand", label: "نام برند یا تولیدی", type: "text", required: true },
      { id: "f-owner", label: "نام و نام خانوادگی مسئول", type: "text", required: true },
      { id: "f-phone", label: "شماره همراه", type: "phone", required: true },
      { id: "f-city", label: "شهر", type: "select", required: true, options: ["تهران", "اصفهان", "مشهد", "شیراز", "تبریز", "یزد", "سایر"] },
      { id: "f-cat", label: "دسته‌بندی اصلی محصولات", type: "select", required: true, options: ["پیراهن و شومیز", "مانتو و بارانی", "کت و شلوار", "بافت", "پالتو", "چند دسته"] },
      { id: "f-cap", label: "ظرفیت تولید ماهانه (تکه)", type: "number", required: false },
      { id: "f-desc", label: "معرفی کوتاه تولیدی", type: "textarea", required: false, hint: "سابقه، نوع پارچه و بازار فعلی" },
      { id: "f-license", label: "تصویر جواز کسب یا ثبت شرکت", type: "file", required: true },
      { id: "f-terms", label: "قوانین همکاری و کارمزد کلبه را می‌پذیرم", type: "checkbox", required: true },
    ],
  },
  applications: [
    { id: "APP-311", name: "پوشاک ماهرخ", status: "new", createdAt: "امروز", values: { "f-brand": "پوشاک ماهرخ", "f-owner": "زهرا ماهرخ", "f-phone": "09128887766", "f-city": "تبریز", "f-cat": "مانتو و بارانی", "f-cap": "1500", "f-desc": "تولید مانتو کتان و لینن از ۱۳۹۶", "f-license": "license-mahrokh.pdf", "f-terms": "بله" } },
    { id: "APP-309", name: "بافت سپید", status: "reviewing", createdAt: "۲ روز پیش", values: { "f-brand": "بافت سپید", "f-owner": "حمید سپیدی", "f-phone": "09135554433", "f-city": "یزد", "f-cat": "بافت", "f-cap": "800", "f-desc": "بافت دستی و ماشینی پشمی", "f-license": "sepid.jpg", "f-terms": "بله" } },
  ],
  extraSuppliers: [],
  restrictions: [
    { id: "RS-1", subjectType: "customer", subjectId: "acc-demo-blocked", subjectName: "پوشاک آرین — اهواز", flags: { ...NO_FLAGS, noWholesale: true, noReturn: true }, reason: "سه مرجوعی ناموجه پیاپی", createdAt: "هفته پیش" },
  ],
  tickets: [
    { id: "TK-5102", ownerType: "customer", ownerId: "acc-sara", ownerName: "سارا محمدی", subject: "زمان ارسال سفارش KV-88214", category: "پیگیری سفارش", priority: "normal", status: "answered", orderRef: "KV-88214", createdAt: "امروز", messages: [
      { from: "user", name: "سارا محمدی", text: "سلام، سفارشم کی ارسال می‌شود؟", at: "امروز ۱۱:۲۰" },
      { from: "agent", name: "پشتیبانی کلبه", text: "سلام سارا جان، سفارش در حال بسته‌بندی است و تا عصر امروز تحویل پست می‌شود.", at: "امروز ۱۱:۴۲" },
    ] },
    { id: "TK-5097", ownerType: "supplier", ownerId: "s1", ownerName: "نیلگون", subject: "تأخیر در تسویه هفته گذشته", category: "مالی و تسویه", priority: "high", status: "new", createdAt: "دیروز", messages: [
      { from: "user", name: "نیلگون", text: "تسویه شنبه گذشته هنوز به حساب ما نرسیده است.", at: "دیروز ۱۶:۰۵" },
    ] },
  ],
  returns: [
    { id: "RT-2201", channel: "wholesale", orderId: "WO-1001-1", ownerId: "acc-vip", ownerName: "بوتیک آوا — تهران", items: "ترنچ کت شنی کلاسیک · ۱ سری", reason: "دو تکه در سری ایراد دوخت آستین داشت", resolution: "exchange", status: "approved", amount: 9900000, createdAt: "۵ روز پیش", events: [{ t: "درخواست ثبت شد", at: "۵ روز پیش" }, { t: "تأیید شد؛ باربر برای جمع‌آوری اعزام می‌شود", at: "۴ روز پیش" }] },
  ],
  sms: { provider: "کاوه‌نگار", apiKey: "", sender: "10008663", connected: false, pricePerPart: 180 },
  smsCampaigns: [
    { id: "SMS-88", name: "کمپین پاییز", audience: "مشتریان وفادار", recipients: 2140, message: "{name} عزیز، کالکشن پاییز کلبه رسید. کد PAIZ1404 = ۱۰٪ تخفیف", parts: 2, cost: 770400, status: "sent", at: "هفته پیش" },
  ],
  coupons: [
    { id: "cp1", code: "PAIZ1404", type: "percent", value: 10, minOrder: 3000000, maxUses: 500, used: 128, channel: "retail", expires: inDays(20).slice(0, 10), active: true },
    { id: "cp2", code: "FREESHIP", type: "freeShip", value: 0, minOrder: 2000000, maxUses: 1000, used: 342, channel: "retail", expires: inDays(40).slice(0, 10), active: true },
    { id: "cp3", code: "BOUTIQUE2", type: "percent", value: 2, minOrder: 50000000, maxUses: 100, used: 11, channel: "wholesale", expires: inDays(30).slice(0, 10), active: true },
  ],
  festivals: [
    { id: "fs1", name: "جشنواره پاییزه", starts: inDays(-2).slice(0, 10), ends: inDays(3).slice(0, 10), discountPercent: 15, categories: ["مانتو و بارانی", "پالتو"], active: true, bannerText: "۱۵٪ تخفیف بارانی و پالتو" },
  ],
  promotionRules: [
    { id: "pr-variant-xl-orange", name: "تخفیف تک‌سایز XL رنگ نارنجی آجری", targetType: "variant", productId: "p1", colorId: "orange", sizeCode: "XL", discountType: "percent", discountValue: 25, starts: inDays(-5).slice(0, 10), ends: inDays(14).slice(0, 10), priority: 100, active: true },
    { id: "pr-color-orange", name: "تخفیف ویژه رنگ نارنجی آجری", targetType: "color", productId: "p1", colorId: "orange", discountType: "percent", discountValue: 18, starts: inDays(-5).slice(0, 10), ends: inDays(14).slice(0, 10), priority: 80, active: true },
    { id: "pr-size-2xl", name: "تخفیف سایز 2XL ژاکت کشباف", targetType: "size", productId: "p4", sizeCode: "2XL", discountType: "fixed", discountValue: 350000, starts: inDays(-3).slice(0, 10), ends: inDays(10).slice(0, 10), priority: 70, active: true },
  ],
  leads: [
    { id: "ld1", name: "بوتیک رز — کرج", phone: "09129804567", source: "فرم عضویت عمده", stage: "qualified", value: 120000000, owner: "نیلوفر", note: "علاقه‌مند به سری کامل پیراهن", createdAt: "۳ روز پیش" },
    { id: "ld2", name: "فروشگاه نیک‌پوش — تبریز", phone: "09145501234", source: "اینستاگرام", stage: "contacted", value: 60000000, owner: "آرش", note: "", createdAt: "هفته پیش" },
    { id: "ld3", name: "کیان صادقی", phone: "09113306604", source: "سایت", stage: "new", value: 9000000, owner: "نیلوفر", note: "سبد رها شده", createdAt: "امروز" },
    { id: "ld4", name: "مزون الماس — قم", phone: "09127776655", source: "نمایشگاه", stage: "won", value: 210000000, owner: "آرش", note: "پلن طلایی خرید", createdAt: "ماه پیش" },
    { id: "ld5", name: "حسین نادری", phone: "09132208801", source: "سایت", stage: "lost", value: 6400000, owner: "نیلوفر", note: "قیمت", createdAt: "ماه پیش" },
  ],
  tasks: [
    { id: "t1", title: "تماس پیگیری پیش‌فاکتور", customer: "بوتیک رز — کرج", due: "امروز", done: false, type: "call" },
    { id: "t2", title: "ارسال کد تخفیف بازگشت", customer: "حسین نادری", due: "فردا", done: false, type: "sms" },
    { id: "t3", title: "جلسه معرفی پلن پلاتینیوم", customer: "مزون شیدا — شیراز", due: "پنجشنبه", done: false, type: "meeting" },
  ],
  notes: [{ id: "n1", customerId: "c1", text: "سایز M در بارانی و L در پیراهن؛ رنگ‌های خنثی را ترجیح می‌دهد.", at: "هفته پیش" }],
  tags: { c1: ["VIP بالقوه", "رنگ خنثی"], c7: ["پرخرج"] },
}) : ({
  hero: { template: "split", eyebrow: "", title: "", subtitle: "", ctaLabel: "", ctaTarget: "shop", secondaryLabel: "", secondaryTarget: "shop", image: "", video: "", poster: "", overlay: 0, align: "right", slides: [], mosaic: [] },
  blocks: [],
  quickSupport: { enabled: false, title: "", hours: "", channels: [] },
  n8n: { webhookUrl: "", enabled: false },
  seriesTemplates: [],
  banks: {},
  withdrawals: [],
  commissions: {},
  applicationForm: { title: "", intro: "", active: false, fields: [] },
  applications: [],
  extraSuppliers: [],
  restrictions: [],
  tickets: [],
  returns: [],
  sms: { provider: "", apiKey: "", sender: "", connected: false, pricePerPart: 0 },
  smsCampaigns: [],
  coupons: [],
  festivals: [],
  promotionRules: [],
  leads: [],
  tasks: [],
  notes: [],
  tags: {},
});

type ListKey = { [K in keyof OpsState]: OpsState[K] extends { id: string }[] ? K : never }[keyof OpsState];
type ItemOf<K extends ListKey> = OpsState[K] extends (infer U)[] ? U : never;

type Ops = OpsState & { loading: boolean; error: string | null; clearError: () => void;
  set: <K extends keyof OpsState>(key: K, value: OpsState[K]) => void;
  upsert: <K extends ListKey>(key: K, item: ItemOf<K>, prepend?: boolean) => void;
  remove: <K extends ListKey>(key: K, id: string) => void;
  restrictionFor: (type: Restriction["subjectType"], id: string) => RestrictionFlags & { reason?: string };
  reset: () => void;
};

const Ctx = createContext<Ops | null>(null);
const KEY = "kolbe-ops-v1";

export function OpsProvider({ children }: { children: ReactNode }) {
  // Operations state is authoritative in PostgreSQL. This provider is a facade cache over /api/v1/admin/*.
  // No business data is produced/edited independently; every mutation is request → backend → cache.
  // Demo mode ?demo=1 uses in-memory seed; normal runtime hydrates from server and shows loading/error.
  const [state, setState] = useState<OpsState>(() => seed());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (USE_DEMO_SEED_OPS) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [cmsPages, coupons, festivals, promotionRules, tickets, crmContacts] = await Promise.all([
          apiClient.get<{ items: unknown[] }>("/admin/cms/pages").catch(() => null),
          apiClient.get<{ items: Coupon[] }>("/admin/coupons").catch(() => null),
          apiClient.get<{ items: Festival[] }>("/admin/festivals").catch(() => null),
          apiClient.get<{ items: PromotionRule[] }>("/promotions/rules").catch(() => null),
          apiClient.get<{ items: unknown[] }>("/tickets").catch(() => null),
          apiClient.get<{ items: Lead[] }>("/admin/crm/contacts").catch(() => null),
        ]);
        if (cancelled) return;
        setState((s) => ({
          ...s,
          blocks: (cmsPages as any)?.items?.[0]?.blocks ?? s.blocks,
          hero: (cmsPages as any)?.items?.[0]?.hero ?? s.hero,
          coupons: (coupons as any)?.items ?? s.coupons,
          festivals: (festivals as any)?.items ?? s.festivals,
          promotionRules: (promotionRules as any)?.items ?? s.promotionRules,
          tickets: (tickets as any)?.items ?? s.tickets,
          leads: (crmContacts as any)?.items ?? s.leads,
        }));
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "خطا در بارگذاری ops"); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (USE_DEMO_SEED_OPS && e.key === KEY && e.newValue) { try { setState(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  const value: Ops = {
    ...state, loading, error, clearError: () => setError(null),
    set: (key, v) => {
      if (USE_DEMO_SEED_OPS) { setState((s) => ({ ...s, [key]: v })); return; }
      // Map known keys to backend; otherwise treat as transient local (not business authoritative)
      const map: Record<string,string> = {
        hero: "/admin/cms/pages", blocks: "/admin/cms/pages",
        quickSupport: "/admin/site-settings/support-widget",
      };
      const path = map[key as string];
      if (!path) { // no backend mapping — keep local but warn
        console.warn(`ops.set ${String(key)} has no backend mapping — treating as local UI pref`);
        setState((s) => ({ ...s, [key]: v }));
        return;
      }
      const body = key === "quickSupport" ? v : { hero: key === "hero" ? v : undefined, blocks: key === "blocks" ? v : undefined };
      apiClient.request(path, { method: key === "quickSupport" ? "PUT" : "PATCH", body: JSON.stringify(body) })
        .then(() => setState((s) => ({ ...s, [key]: v })))
        .catch((e) => { setError(e instanceof Error ? e.message : "خطا"); throw e; });
    },
    upsert: (key, item, prepend) => {
      if (USE_DEMO_SEED_OPS) {
        setState((s) => {
          const list = s[key] as unknown as { id: string }[];
          const it = item as unknown as { id: string };
          const exists = list.some((x) => x.id === it.id);
          const next = exists ? list.map((x) => (x.id === it.id ? it : x)) : prepend ? [it, ...list] : [...list, it];
          return { ...s, [key]: next };
        });
        return;
      }
      const it = item as unknown as { id: string };
      const list = state[key] as unknown as { id: string }[];
      const exists = list.some((x) => x.id === it.id);
      const endpoint: Record<string,{ create: string; update: (id:string)=>string }> = {
        coupons: { create: "/admin/coupons", update: (id) => `/admin/coupons/${id}` },
        festivals: { create: "/admin/festivals", update: (id) => `/admin/festivals/${id}` },
        promotionRules: { create: "/promotions/rules", update: (id) => `/promotions/rules/${id}` },
        tickets: { create: "/tickets", update: (id) => `/tickets/${id}` },
        returns: { create: "/returns", update: (id) => `/returns/${id}/inspect` },
        applications: { create: "/cooperation-requests", update: (id) => `/admin/cooperation-requests/${id}/review` },
        leads: { create: "/admin/crm/contacts", update: (id) => `/admin/crm/contacts/${id}` },
      };
      const ep = endpoint[key as string];
      if (!ep) {
        console.warn(`ops.upsert ${String(key)} has no backend mapping — local only`);
        setState((s) => {
          const list2 = s[key] as unknown as { id: string }[];
          const next = exists ? list2.map((x) => (x.id === it.id ? it : x)) : prepend ? [it, ...list2] : [...list2, it];
          return { ...s, [key]: next };
        });
        return;
      }
      const path = exists ? ep.update(it.id) : ep.create;
      const method = exists ? "PATCH" : "POST";
      apiClient.request(path, { method, body: JSON.stringify(item) })
        .then((res: any) => {
          const returnedId = res?.id ?? it.id;
          setState((s) => {
            const list2 = s[key] as unknown as { id: string }[];
            const next = exists ? list2.map((x) => (x.id === it.id ? { ...it, id: returnedId } : x)) : prepend ? [{ ...it, id: returnedId }, ...list2] : [...list2, { ...it, id: returnedId }];
            return { ...s, [key]: next };
          });
        })
        .catch((e) => { setError(e instanceof Error ? e.message : "خطا"); throw e; });
    },
    remove: (key, id) => {
      if (USE_DEMO_SEED_OPS) { setState((s) => ({ ...s, [key]: (s[key] as unknown as { id: string }[]).filter((x) => x.id !== id) })); return; }
      const delMap: Record<string,string> = {
        coupons: `/admin/coupons/${id}/deactivate`,
        festivals: `/admin/festivals/${id}`,
        promotionRules: `/promotions/rules/${id}`,
        tickets: `/tickets/${id}`,
      };
      const path = delMap[key as string];
      if (!path) {
        console.warn(`ops.remove ${String(key)} has no backend mapping`);
        setState((s) => ({ ...s, [key]: (s[key] as unknown as { id: string }[]).filter((x) => x.id !== id) }));
        return;
      }
      apiClient.request(path, { method: key === "coupons" ? "POST" : "DELETE" })
        .then(() => setState((s) => ({ ...s, [key]: (s[key] as unknown as { id: string }[]).filter((x) => x.id !== id) })))
        .catch((e) => { setError(e instanceof Error ? e.message : "خطا"); throw e; });
    },
    restrictionFor: (type, id) => {
      const today = new Date().toISOString().slice(0, 10);
      const active = state.restrictions.filter((r) => r.subjectType === type && r.subjectId === id && (!r.until || r.until >= today));
      return active.reduce<RestrictionFlags & { reason?: string }>((acc, r) => ({
        block: acc.block || r.flags.block, noOrder: acc.noOrder || r.flags.noOrder, noWholesale: acc.noWholesale || r.flags.noWholesale,
        noReturn: acc.noReturn || r.flags.noReturn, noPublish: acc.noPublish || r.flags.noPublish, noWithdraw: acc.noWithdraw || r.flags.noWithdraw,
        reason: r.reason || acc.reason,
      }), { ...NO_FLAGS });
    },
    reset: () => setState(seed()),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOps() {
  const c = useContext(Ctx);
  if (!c) throw new Error("OpsProvider missing");
  return c;
}

export const opsNow = now;

/* ---------------- Validation helpers ---------------- */
const BANKS: Record<string, string> = {
  "010": "بانک مرکزی", "011": "صنعت و معدن", "012": "بانک ملت", "013": "بانک رفاه", "014": "بانک مسکن", "015": "بانک سپه", "016": "بانک کشاورزی",
  "017": "بانک ملی", "018": "بانک تجارت", "019": "بانک صادرات", "020": "توسعه صادرات", "021": "پست بانک", "053": "بانک کارآفرین", "054": "بانک پارسیان",
  "055": "اقتصاد نوین", "056": "بانک سامان", "057": "بانک پاسارگاد", "058": "بانک سرمایه", "059": "بانک سینا", "060": "مهر ایران", "062": "بانک آینده",
  "066": "بانک دی", "069": "ایران زمین", "070": "بانک رسالت", "078": "خاورمیانه",
};
export const normalizeIban = (v: string) => v.replace(/[\s-]/g, "").toUpperCase().replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
export const bankFromIban = (iban: string) => BANKS[normalizeIban(iban).slice(4, 7)] ?? "";
export const isValidIban = (raw: string) => {
  const iban = normalizeIban(raw);
  if (!/^IR\d{24}$/.test(iban)) return false;
  const moved = iban.slice(4) + "1827" + iban.slice(2, 4);
  let rem = 0;
  for (const ch of moved) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
};
export const isValidCard = (raw: string) => {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) { let n = Number(d[i]); if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
};
export const smsParts = (text: string) => {
  const unicode = /[^\u0000-\u007F]/.test(text);
  const single = unicode ? 70 : 160, multi = unicode ? 67 : 153;
  if (!text.length) return 0;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
};
