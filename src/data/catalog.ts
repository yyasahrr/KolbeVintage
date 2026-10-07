/* KOLBE FLUID HERITAGE — Single source of truth (frontend store simulating backend contracts) */

export type Colorway = { id: string; name: string; hex: string };
export type SeriesDef = {
  id: string;
  name: string;
  pieces: number;
  composition: Record<string, number>;
  moqSeries: number;
  pricePerSeries: number;
  available: boolean;
  colorIds?: string[];
};
export type ProductStatus = "published" | "pending" | "draft" | "rejected";
export const STATUS_LABEL: Record<ProductStatus, string> = {
  published: "منتشر در بازارچه",
  pending: "در انتظار تأیید",
  draft: "پیش‌نویس",
  rejected: "رد شد",
};

export type Product = {
  status?: ProductStatus;
  video?: string;
  /**
   * Virtual try-on capability flag (Non-Core styling workstream). Optional and
   * additive: when absent, eligibility is derived from the product category
   * (garments yes, accessories no — see `tryOnEligible` in data/styling.ts).
   * When present it is the single authority, so an unsupported garment can be
   * switched off and a future supported accessory switched on without code
   * changes. Wholesale-only records are never eligible regardless of this flag.
   */
  tryOn?: boolean;
  cutout?: { status: "none" | "queued" | "processing" | "ready" | "failed"; src?: string; source?: "n8n" | "local"; note?: string };
  id: string;
  sku: string;
  brand: string;
  name: string;
  supplier: string;
  supplierId: string;
  category: string;
  retailPrice: number;
  installmentPrice?: number;
  wholesaleFrom: number;
  rating: number;
  reviews: number;
  colors: Colorway[];
  images: string[];
  /**
   * Presentation-only media map: colourway id -> photographs of THIS product in
   * that colour. Optional and backward compatible.
   *
   * Rules it follows:
   *  - every URL must already exist in `images` (no invented media, no new URLs);
   *  - only colourways whose photograph is unambiguous are listed;
   *  - a colour with no entry keeps the plain product gallery: the storefront
   *    never reorders gallery photos to imply they belong to that colour.
   *
   * LONG TERM: colour-to-media assignment belongs to the real Product/CMS media
   * contract (backend `product_variants` already carries `color_label`), not to
   * hand-maintained storefront data. When that contract exposes per-variant
   * media, this field becomes a compatibility shim and should be dropped.
   */
  colorMedia?: Record<string, string[]>;
  series: SeriesDef[];
  seriesCount: number;
  moq: number;
  badge?: string;
  stock: number;
  soldNote?: string;
  fabric: string;
  desc: string;
};

export const fmtMoney = (n: number) =>
  n.toLocaleString("fa-IR") + " تومان";

export const fourPaymentAmount = (product: Product) => Math.ceil((product.installmentPrice ?? product.retailPrice) / 4);

export const nextSku = (products: Product[], supplierId: string, category: string) => {
  const owner = supplierId === "kolbe" ? "KV" : supplierId.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const categoryCode = /کفش|کتانی|بوت/.test(category) ? "SHOE" : /شلوار|جین/.test(category) ? "PANT"
    : /اکسسوری|کیف|کمربند|روسری|شال|زیور/.test(category) ? "ACCS"
    : /کت|بلیزر/.test(category) ? "COAT" : /پیراهن|شومیز/.test(category) ? "SHRT"
    : /مانتو|بارانی/.test(category) ? "TRNC" : "ITEM";
  const prefix = `${owner}-${categoryCode}-`;
  const highest = products.reduce((max, product) => product.sku.startsWith(prefix)
    ? Math.max(max, Number(product.sku.slice(prefix.length)) || 0) : max, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
};

export const fmtNum = (n: number) => n.toLocaleString("fa-IR");

export const IMG = {
  trenchHero:
    "https://images.pexels.com/photos/12349052/pexels-photo-12349052.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  trenchBack:
    "https://images.pexels.com/photos/7760027/pexels-photo-7760027.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  trenchWhite:
    "https://images.pexels.com/photos/7760026/pexels-photo-7760026.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  trenchStreet:
    "https://images.pexels.com/photos/9968536/pexels-photo-9968536.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  trenchArch:
    "https://images.pexels.com/photos/20284091/pexels-photo-20284091.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  shirtRack:
    "https://images.pexels.com/photos/7671168/pexels-photo-7671168.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  shirtsColor:
    "https://images.pexels.com/photos/8483478/pexels-photo-8483478.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  greenShirt:
    "https://images.pexels.com/photos/9594681/pexels-photo-9594681.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  blueShirt:
    "https://images.pexels.com/photos/9558723/pexels-photo-9558723.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  whiteShirts:
    "https://images.pexels.com/photos/8306364/pexels-photo-8306364.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  neutralRack:
    "https://images.pexels.com/photos/36593273/pexels-photo-36593273.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  blazerDuo:
    "https://images.pexels.com/photos/8483838/pexels-photo-8483838.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  blackSuit:
    "https://images.pexels.com/photos/20447402/pexels-photo-20447402.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  checkedSuit:
    "https://images.pexels.com/photos/19778358/pexels-photo-19778358.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  pastelBlazer:
    "https://images.pexels.com/photos/8484005/pexels-photo-8484005.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  atelierCut:
    "https://images.pexels.com/photos/9849651/pexels-photo-9849651.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200",
  atelierSew:
    "https://images.pexels.com/photos/7147652/pexels-photo-7147652.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200",
  atelierPattern:
    "https://images.pexels.com/photos/6461086/pexels-photo-6461086.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=627&w=1200",
  hijabTrench:
    "https://images.pexels.com/photos/36168977/pexels-photo-36168977.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  redCoat:
    "https://images.pexels.com/photos/36379088/pexels-photo-36379088.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  hijabCoat:
    "https://images.pexels.com/photos/10541444/pexels-photo-10541444.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  lakeCoat:
    "https://images.pexels.com/photos/16943649/pexels-photo-16943649.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
  burgundyCoat:
    "https://images.pexels.com/photos/36379080/pexels-photo-36379080.jpeg?auto=compress&cs=tinysrgb&fit=crop&h=1200&w=800",
};

export const COLORS: Record<string, Colorway> = {
  orange: { id: "orange", name: "نارنجی آجری", hex: "#C1613B" },
  black: { id: "black", name: "مشکی", hex: "#1E1E22" },
  cream: { id: "cream", name: "کرمی", hex: "#EDE3D0" },
  olive: { id: "olive", name: "زیتونی", hex: "#5A6350" },
  sand: { id: "sand", name: "شنی", hex: "#C9B18F" },
  navy: { id: "navy", name: "سرمه‌ای", hex: "#1B2A4A" },
  white: { id: "white", name: "سفید", hex: "#FFFFFF" },
  burgundy: { id: "burgundy", name: "زرشکی", hex: "#6E2230" },
};

const fullSeries = (price: number, moq = 2): SeriesDef => ({
  id: "full",
  name: "سری کامل",
  pieces: 12,
  composition: { S: 2, M: 2, L: 2, XL: 2, "2XL": 2, "3XL": 2 },
  moqSeries: moq,
  pricePerSeries: price,
  available: true,
});
const halfSeries = (price: number): SeriesDef => ({
  id: "half",
  name: "نیم‌سری",
  pieces: 6,
  composition: { S: 1, M: 1, L: 1, XL: 1, "2XL": 1, "3XL": 1 },
  moqSeries: 4,
  pricePerSeries: Math.round(price / 2),
  available: true,
});
const selectSeries = (price: number): SeriesDef => ({
  id: "select",
  name: "سری منتخب",
  pieces: 8,
  composition: { S: 1, M: 2, L: 2, XL: 2, "2XL": 1 },
  moqSeries: 3,
  pricePerSeries: Math.round(price * 0.68),
  available: false,
});

export const PRODUCTS: Product[] = [
  {
    id: "p1",
    sku: "KOLBE-TR-001",
    brand: "Kolbe",
    name: "مانتو بارانی کلاسیک",
    supplier: "کلبه وینتیج",
    supplierId: "kolbe",
    category: "مانتو و بارانی",
    retailPrice: 9900000,
    installmentPrice: 10200000,
    wholesaleFrom: 8900000,
    rating: 4.9,
    reviews: 212,
    colors: [COLORS.orange, COLORS.black, COLORS.cream, COLORS.olive],
    images: [IMG.hijabTrench, IMG.trenchHero, IMG.trenchBack, IMG.trenchStreet],
    series: [fullSeries(8900000), halfSeries(8900000), selectSeries(8900000)],
    seriesCount: 3,
    moq: 2,
    badge: "پرفروش",
    stock: 128,
    fabric: "گاباردین پنبه، ضدآب",
    desc: "مانتو بارانی بلند با برش کلاسیک، دکمه‌های شاخ طبیعی و آستر تنفسی. دوخته‌شده در کارگاه نیلگون با دقت خیاطی درجه یک.",
  },
  {
    id: "p2",
    sku: "NL-CLASSIC-08",
    brand: "Nilgoon",
    name: "پیراهن کلاسیک نیم‌آستین",
    supplier: "نیلگون",
    supplierId: "s1",
    category: "پیراهن",
    retailPrice: 8900000,
    wholesaleFrom: 7400000,
    rating: 4.8,
    reviews: 184,
    colors: [COLORS.orange, COLORS.black, COLORS.cream, COLORS.olive],
    images: [IMG.shirtRack, IMG.shirtsColor, IMG.greenShirt, IMG.whiteShirts],
    colorMedia: {
      cream: [IMG.whiteShirts, IMG.shirtsColor, IMG.shirtRack],
      olive: [IMG.greenShirt, IMG.shirtRack, IMG.shirtsColor],
    },
    series: [fullSeries(7400000), halfSeries(7400000), selectSeries(7400000)],
    seriesCount: 3,
    moq: 2,
    badge: "جدید",
    stock: 240,
    fabric: "لینن صددرصد، بافت سنگین",
    desc: "پیراهن نیم‌آستین با یقه کلاسیک و دوخت تمیز فرانسوی. رنگ آجری آن با تکنیک garment-dye تثبیت شده تا در شست‌وشو نرود.",
  },
  {
    id: "p3",
    sku: "FS-BLZ-214",
    brand: "Farasootal",
    name: "کت لینن مردانه",
    supplier: "فراسو",
    supplierId: "s2",
    category: "کت و بلیزر",
    retailPrice: 14500000,
    wholesaleFrom: 12400000,
    rating: 4.7,
    reviews: 96,
    colors: [COLORS.sand, COLORS.navy, COLORS.black],
    images: [IMG.blazerDuo, IMG.checkedSuit, IMG.pastelBlazer, IMG.blackSuit],
    colorMedia: { black: [IMG.blackSuit, IMG.blazerDuo, IMG.checkedSuit] },
    series: [fullSeries(12400000, 5), halfSeries(12400000)],
    seriesCount: 2,
    moq: 5,
    stock: 86,
    fabric: "لینن و پشم سبک",
    desc: "کت تک‌دکمه با لایه‌دوزی نیمه‌کتیبه، جیب‌های فلپ و برش راسته مدرن. مناسب استایل رسمی-روزمره.",
  },
  {
    id: "p4",
    sku: "NS-SHM-042",
    brand: "Novin Style",
    name: "شومیز کتان زنانه",
    supplier: "نوین استایل",
    supplierId: "s3",
    category: "شومیز",
    retailPrice: 7900000,
    wholesaleFrom: 6900000,
    rating: 4.6,
    reviews: 143,
    colors: [COLORS.white, COLORS.cream, COLORS.sand],
    images: [IMG.whiteShirts, IMG.blueShirt, IMG.neutralRack, IMG.shirtsColor],
    colorMedia: { white: [IMG.whiteShirts, IMG.neutralRack, IMG.shirtsColor] },
    series: [fullSeries(6900000, 4), halfSeries(6900000)],
    seriesCount: 2,
    moq: 4,
    badge: "موجودی محدود",
    stock: 54,
    fabric: "کتان درجه یک، آهار ملایم",
    desc: "شومیز اورسایز با سرآستین دکمه‌دار و برش آزاد. انتخاب اول استایل مینیمال روزمره.",
  },
  {
    id: "p5",
    sku: "KB-CT-109",
    brand: "Kolbe",
    name: "پالتو بلند طراح‌دار",
    supplier: "کلبه وینتیج",
    supplierId: "kolbe",
    category: "پالتو",
    retailPrice: 16800000,
    wholesaleFrom: 14900000,
    rating: 4.9,
    reviews: 67,
    colors: [COLORS.burgundy, COLORS.black, COLORS.sand],
    images: [IMG.redCoat, IMG.burgundyCoat, IMG.lakeCoat, IMG.hijabCoat],
    colorMedia: { burgundy: [IMG.burgundyCoat, IMG.redCoat, IMG.lakeCoat] },
    series: [fullSeries(14900000, 2), selectSeries(14900000)],
    seriesCount: 2,
    moq: 2,
    badge: "کالکشن ویژه",
    stock: 42,
    fabric: "پشمی دو‌رو، آستر ویسکوز",
    desc: "پالتو بلند با یقه انگلیسی و کمربند هم‌جنس. دوخته‌شده از پارچه پشمی دو‌رو با ایستایی عالی.",
  },
  {
    id: "p6",
    sku: "TR-ST-077",
    brand: "Kolbe",
    name: "ترنچ کت شنی کلاسیک",
    supplier: "کلبه وینتیج",
    supplierId: "kolbe",
    category: "مانتو و بارانی",
    retailPrice: 11900000,
    wholesaleFrom: 9900000,
    rating: 4.8,
    reviews: 158,
    colors: [COLORS.sand, COLORS.black, COLORS.olive],
    images: [IMG.trenchWhite, IMG.trenchArch, IMG.trenchHero, IMG.trenchBack],
    colorMedia: { sand: [IMG.trenchWhite, IMG.trenchArch, IMG.trenchHero] },
    series: [fullSeries(9900000), halfSeries(9900000)],
    seriesCount: 2,
    moq: 3,
    stock: 97,
    fabric: "گاباردین ضدآب، آستر چهارخانه",
    desc: "ترنچ‌کت شنی با اپل‌گذاری کلاسیک، بند سرآستین و برش آزاد. امضای کالکشن بارانی کلبه.",
  },
  {
    id: "p7",
    sku: "BL-PC-310",
    brand: "Farasootal",
    name: "بلیزر پاستلی دو‌تکه",
    supplier: "فراسو",
    supplierId: "s2",
    category: "کت و بلیزر",
    retailPrice: 13200000,
    wholesaleFrom: 11400000,
    rating: 4.5,
    reviews: 41,
    colors: [COLORS.cream, COLORS.olive, COLORS.navy],
    images: [IMG.pastelBlazer, IMG.blazerDuo, IMG.checkedSuit, IMG.trenchStreet],
    colorMedia: { cream: [IMG.pastelBlazer, IMG.blazerDuo, IMG.trenchStreet] },
    series: [fullSeries(11400000, 3), halfSeries(11400000)],
    seriesCount: 2,
    moq: 3,
    stock: 63,
    fabric: "کرپ مازراتی، آستر ساتن",
    desc: "ست بلیزر و شلوار راسته در پالت پاستلی. برش تمیز و دوخت صنعتی درجه یک.",
  },
  {
    id: "p8",
    sku: "SH-CH-055",
    brand: "Nilgoon",
    name: "پیراهن چهارخانه مشکی",
    supplier: "نیلگون",
    supplierId: "s1",
    category: "پیراهن",
    retailPrice: 6400000,
    wholesaleFrom: 5300000,
    rating: 4.6,
    reviews: 203,
    colors: [COLORS.black, COLORS.navy, COLORS.cream],
    images: [IMG.blackSuit, IMG.shirtRack, IMG.greenShirt, IMG.neutralRack],
    colorMedia: { black: [IMG.blackSuit, IMG.shirtRack, IMG.neutralRack] },
    series: [fullSeries(5300000, 6), halfSeries(5300000)],
    seriesCount: 2,
    moq: 6,
    badge: "اقتصادی",
    stock: 310,
    fabric: "فلانل نخی، بافت نرم",
    desc: "پیراهن چهارخانه با برش راحت و جیب سینه. گزینه اقتصادی برای خرید عمده با حاشیه سود بالا.",
  },
];

export type Request = {
  id: string;
  productId: string;
  buyer: string;
  seriesName: string;
  color: string;
  qtySeries: number;
  pieces: number;
  total: number;
  status: "در انتظار" | "تأیید شد" | "رد شد" | "در حال بررسی" | "پیش‌فاکتور شد";
  updated: string;
  deadline: string;
};

export const REQUESTS: Request[] = [
  { id: "RQ-2401", productId: "p2", buyer: "بوتیک آوا — تهران", seriesName: "سری کامل", color: "نارنجی آجری", qtySeries: 5, pieces: 60, total: 37000000, status: "در انتظار", updated: "۲ ساعت پیش", deadline: "۳ روز مانده" },
  { id: "RQ-2398", productId: "p1", buyer: "گالری ماهور — اصفهان", seriesName: "سری کامل", color: "مشکی", qtySeries: 8, pieces: 96, total: 71200000, status: "تأیید شد", updated: "دیروز", deadline: "تحویل ۱۲ بهمن" },
  { id: "RQ-2395", productId: "p3", buyer: "پوشاک رادین — مشهد", seriesName: "نیم‌سری", color: "شنی", qtySeries: 6, pieces: 36, total: 37200000, status: "در حال بررسی", updated: "۲ روز پیش", deadline: "۵ روز مانده" },
  { id: "RQ-2391", productId: "p5", buyer: "مزون شیدا — شیراز", seriesName: "سری کامل", color: "زرشکی", qtySeries: 3, pieces: 36, total: 44700000, status: "پیش‌فاکتور شد", updated: "۳ روز پیش", deadline: "پرداخت تا فردا" },
  { id: "RQ-2387", productId: "p4", buyer: "بوتیک آوا — تهران", seriesName: "نیم‌سری", color: "سفید", qtySeries: 10, pieces: 60, total: 34500000, status: "رد شد", updated: "۵ روز پیش", deadline: "—" },
];

export type Order = {
  id: string;
  customer: string;
  items: number;
  total: number;
  status: "پرداخت شد" | "در حال آماده‌سازی" | "ارسال شد" | "تحویل شد" | "مرجوعی" | "در انتظار پرداخت";
  date: string;
  channel: "خرده" | "عمده";
  seller: string;
};

export const ORDERS: Order[] = [
  { id: "KV-88214", customer: "سارا محمدی", items: 3, total: 21400000, status: "در حال آماده‌سازی", date: "امروز ۱۰:۲۴", channel: "خرده", seller: "کلبه" },
  { id: "KV-88209", customer: "بوتیک آوا", items: 60, total: 37000000, status: "پرداخت شد", date: "امروز ۰۹:۱۰", channel: "عمده", seller: "نیلگون" },
  { id: "KV-88197", customer: "نگار کریمی", items: 1, total: 9900000, status: "ارسال شد", date: "دیروز", channel: "خرده", seller: "کلبه" },
  { id: "KV-88190", customer: "مزون شیدا", items: 36, total: 44700000, status: "در انتظار پرداخت", date: "دیروز", channel: "عمده", seller: "نوین استایل" },
  { id: "KV-88176", customer: "امیر رضایی", items: 2, total: 15300000, status: "تحویل شد", date: "۲ روز پیش", channel: "خرده", seller: "کلبه" },
  { id: "KV-88160", customer: "پوشاک رادین", items: 48, total: 63600000, status: "ارسال شد", date: "۳ روز پیش", channel: "عمده", seller: "فراسو" },
];

export const SUPPLIERS = [
  { id: "s1", name: "نیلگون", city: "تهران", products: 48, rating: 4.8, status: "فعال", since: "۱۴۰۱" },
  { id: "s2", name: "فراسو", city: "اصفهان", products: 32, rating: 4.6, status: "فعال", since: "۱۴۰۲" },
  { id: "s3", name: "نوین استایل", city: "مشهد", products: 56, rating: 4.7, status: "در انتظار تأیید", since: "۱۴۰۳" },
  { id: "s4", name: "بافتینه", city: "یزد", products: 21, rating: 4.5, status: "فعال", since: "۱۴۰۲" },
];

export const JOURNAL = [
  { id: "j1", title: "راهنمای انتخاب بارانی برای پاییز امسال", cat: "استایل", read: "۶ دقیقه", img: IMG.trenchStreet },
  { id: "j2", title: "از پارچه تا پوشاک: سفری به کارگاه نیلگون", cat: "هنر ساخت", read: "۹ دقیقه", img: IMG.atelierCut },
  { id: "j3", title: "پنج ترکیب رنگ که همیشه جواب می‌دهد", cat: "استایل", read: "۴ دقیقه", img: IMG.neutralRack },
];

export const COLLECTIONS = [
  { name: "پیراهن‌ها", count: 24, img: IMG.shirtsColor },
  { name: "کت و بلیزر", count: 18, img: IMG.blazerDuo },
  { name: "بارانی و مانتو", count: 21, img: IMG.trenchHero },
  { name: "شومیز", count: 16, img: IMG.whiteShirts },
];
