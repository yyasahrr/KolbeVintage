import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, BadgeCheck, Truck, RotateCcw, ShieldCheck, Heart, Star, ShoppingBag,
  SlidersHorizontal, Eye, Sparkles, Ruler, Check, ChevronLeft, Minus, Plus, Trash2, CreditCard, MapPin,
} from "lucide-react";
import { COLLECTIONS, JOURNAL, IMG, fmtMoney, fmtNum, type Product } from "../data/catalog";
import { digitsOnly, type CustomerAccount, type CustomerAddress } from "../data/customer";
import type { Buyer } from "../data/platform";
import { useStore } from "../data/store";
import AccountExperience, { type AccountTab } from "./account";
import { useOps } from "../data/ops";
import { HeroRenderer, BlockRenderer, type NavTarget } from "../components/cms-render";
void Hero; void TrustBar;
import { Btn, Card, SectionHead, Status, Tag, SearchBox, Select, Swatch, Empty, Field, Input } from "../components/primitives";
import { cn } from "../utils/cn";
import { recordSearchEvent } from "../data/search-analytics";

export type CartLine = { id: string; qty: number; size: string; color: string };
type JournalPost = { id: string; kind: "article" | "video"; status: "published"; title: string; description: string; image: string; url: string; category: string; author: string; duration: string; publishDate: string };
type RetailSEORecord = { title?: string; description?: string; slug?: string; canonical?: string; index?: boolean; follow?: boolean; socialTitle?: string; socialDescription?: string; socialImage?: string };
type RetailSEOState = { records?: Record<string, RetailSEORecord>; templateTitle?: string; templateDescription?: string };
function getPublishedPosts(kind: JournalPost["kind"]): JournalPost[] { try { const raw = JSON.parse(localStorage.getItem("kolbe-editorial-media-v1") || "[]"); return Array.isArray(raw) ? raw.filter((p): p is JournalPost => p?.kind === kind && p?.status === "published" && typeof p.title === "string") : []; } catch { return []; } }

/* ============ Retail product card — image-first, 70% visual ============ */
export function RetailCard({ p, wished, onWish, onOpen, onAdd }: {
  p: Product; wished: boolean; onWish: () => void; onOpen: () => void; onAdd: (size: string, color: string) => boolean;
}) {
  const [colorId, setColorId] = useState(p.colors[0]?.id ?? "");
  const sizes = Array.from(new Set(p.series.flatMap((series) => Object.keys(series.composition))));
  const [size, setSize] = useState(sizes.includes("M") ? "M" : sizes[0] ?? "M");
  const [message, setMessage] = useState("");
  const chosenColor = p.colors.find((color) => color.id === colorId) ?? p.colors[0];
  const quickAdd = () => {
    if (!chosenColor) { setMessage("رنگی برای این محصول تعریف نشده است"); return; }
    const added = onAdd(size, chosenColor.name);
    setMessage(added ? "به سبد اضافه شد" : "موجودی کافی نیست");
    window.setTimeout(() => setMessage(""), 2200);
  };
  return (
    <article className="group">
      <div className="kv-img-zoom relative overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm">
        <button onClick={onOpen} className="block w-full text-right" aria-label={p.name}>
          <div className="kv-img aspect-[3/4] w-full overflow-hidden">
            <img src={p.images[0]} alt={p.imageMeta?.[0]?.alt || p.name} loading="lazy" className="h-full w-full object-cover" />
          </div>
        </button>
        {p.badge && (
          <span className="absolute right-3 top-3 rounded-full bg-[var(--kv-glass)] px-3 py-1 text-[11.5px] font-bold backdrop-blur-md border border-white/40 shadow-sm">
            {p.badge}
          </span>
        )}
        <button
          onClick={onWish} aria-label="علاقه‌مندی"
          className={cn("kv-press absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-md transition-all",
            wished ? "bg-[var(--kv-accent)] border-[var(--kv-accent)] text-white" : "bg-[var(--kv-glass)] border-white/40 text-[var(--kv-ink)]")}
        >
          <Heart size={16} fill={wished ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="px-1 pt-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <button onClick={onOpen} className="text-[14px] font-bold leading-6 hover:text-[var(--kv-accent)] transition-colors">{p.name}</button>
            <p className="mt-0.5 text-xs text-[var(--kv-muted)]">{p.supplier} · {p.category}</p>
          </div>
          <span className="flex items-center gap-1 text-xs font-semibold text-[var(--kv-muted)]"><Star size={12} fill="#D6A94E" strokeWidth={0} />{p.rating.toLocaleString("fa-IR")}</span>
        </div>
        <p className="mt-2 text-[14.5px] font-extrabold tabular-nums">{fmtMoney(p.retailPrice)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1" role="group" aria-label={`انتخاب رنگ ${p.name}`}>
          {p.colors.map((color) => (
            <button key={color.id} title={color.name} aria-label={`${p.name}، رنگ ${color.name}`} aria-pressed={color.id === colorId} onClick={() => setColorId(color.id)}
              className={cn("kv-press flex h-10 w-10 items-center justify-center rounded-full border transition-all", color.id === colorId ? "border-[var(--kv-accent)]" : "border-transparent hover:border-[var(--kv-line-strong)]")}>
              <span className="h-5 w-5 rounded-full border border-black/15" style={{ background: color.hex }} />
            </button>
          ))}
          <span className="mr-1 text-[11px] text-[var(--kv-muted)]">{chosenColor?.name ?? "بدون رنگ"}</span>
        </div>
        <div className="mt-2 flex gap-2">
          <label className="sr-only" htmlFor={`size-${p.id}`}>سایز {p.name}</label>
          <select id={`size-${p.id}`} value={size} onChange={(event) => setSize(event.target.value)} className="h-10 w-[68px] shrink-0 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-1 text-center text-[12px] font-bold text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]">
            {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={quickAdd} disabled={p.stock < 1 || !chosenColor} aria-label={`افزودن ${p.name} رنگ ${chosenColor?.name ?? ""} سایز ${size} به سبد خرید`} className="kv-press flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[var(--kv-action)] px-2 text-[12px] font-semibold text-[var(--kv-bg)] disabled:opacity-40 dark:text-[#0E1527]">
            <ShoppingBag size={15} className="shrink-0" /><span className="hidden sm:inline">افزودن</span>
          </button>
        </div>
        <p role="status" aria-live="polite" className="h-5 pt-1 text-[11px] font-semibold text-[var(--kv-success)]">{message || (p.stock < 1 ? "ناموجود" : "")}</p>
      </div>
    </article>
  );
}

/* ============ HERO ============ */
function Hero({ onShop, onLook }: { onShop: () => void; onLook: () => void }) {
  return (
    <section className="relative overflow-hidden rounded-[24px] border border-[var(--kv-line)] kv-shadow-md">
      <div className="grid md:grid-cols-[1.05fr_1fr]">
        <div className="relative flex flex-col justify-center bg-[var(--kv-surface)] p-8 md:p-14">
          <div className="kv-latin text-[11px] text-[var(--kv-muted)]">KOLBE · AUTUMN 1404</div>
          <h1 className="kv-editorial-title mt-4 text-[30px] leading-[1.35] md:text-[44px] md:leading-[1.3]">
            سبک‌های ماندگار
            <br />
            برای امروز و فردا
          </h1>
          <p className="mt-4 max-w-[44ch] text-[14.5px] leading-8 text-[var(--kv-muted)]">
            منتخب‌ترین پوشاک کلاسیک و مدرن از بهترین تأمین‌کنندگان؛ با ضمانت اصالت کالا،
            برگشت آسان و ارسال سریع به سراسر کشور.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Btn variant="accent" size="lg" onClick={onShop} icon={<ArrowLeft size={17} />}>مشاهده کالکشن‌ها</Btn>
            <Btn variant="soft" size="lg" onClick={onLook} icon={<Sparkles size={17} />}>استایل من</Btn>
          </div>
          <div className="mt-9 flex items-center gap-6 border-t border-[var(--kv-line)] pt-5">
            {[
              ["۱۲هزار+", "مشتری وفادار"],
              ["۴.۹", "امتیاز فروشگاه"],
              ["۴۸ ساعته", "ارسال سریع"],
            ].map(([v, l]) => (
              <div key={l}>
                <p className="text-lg font-extrabold tabular-nums">{v}</p>
                <p className="text-xs text-[var(--kv-muted)]">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="kv-img relative min-h-[340px] md:min-h-[560px]">
          <img src={IMG.trenchHero} alt="ترنچ‌کت شنی کلبه" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/35 to-transparent" />
          <div className="kv-glass absolute bottom-5 right-5 left-5 flex items-center justify-between rounded-[14px] px-4 py-3">
            <div>
              <p className="text-[13px] font-bold">ترنچ‌کت شنی کلاسیک</p>
              <p className="text-xs text-[var(--kv-muted)]">از {fmtMoney(9900000)}</p>
            </div>
            <Btn size="sm" variant="dark" onClick={onShop}>مشاهده</Btn>
          </div>
        </div>
      </div>
    </section>
  );
}

function TrustBar() {
  const items = [
    { i: <Truck size={18} />, t: "ارسال سریع", d: "به سراسر کشور" },
    { i: <ShieldCheck size={18} />, t: "ضمانت اصالت کالا", d: "۱۰۰٪ اورجینال" },
    { i: <RotateCcw size={18} />, t: "برگشت آسان", d: "تا ۷ روز" },
    { i: <BadgeCheck size={18} />, t: "پشتیبانی ۲۴ ساعته", d: "پاسخ‌گویی سریع" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it) => (
        <div key={it.t} className="flex items-center gap-3 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3.5 kv-shadow-sm">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]">{it.i}</span>
          <div><p className="text-[13px] font-bold">{it.t}</p><p className="text-xs text-[var(--kv-muted)]">{it.d}</p></div>
        </div>
      ))}
    </div>
  );
}

/* ============ PDP (Retail) ============ */
export function RetailPDP({ p, onBack, onAdd, wished, onWish }: {
  p: Product; onBack: () => void; onAdd: (size: string, color: string) => void; wished: boolean; onWish: () => void;
}) {
  const [img, setImg] = useState(0);
  const gallery: { kind: "image" | "video"; src: string; title: string; thumbnail?: string }[] = [...p.images.map((src, i) => ({ kind: "image" as const, src, title: p.imageMeta?.[i]?.alt || p.name })), ...(p.videos ?? []).map((video) => ({ kind: "video" as const, src: video.src, title: video.title || p.name, thumbnail: video.thumbnail })), ...(!p.videos?.length && p.video ? [{ kind: "video" as const, src: p.video, title: `${p.name} · ویدیو`, thumbnail: undefined }] : [])];
  const selectedMedia = gallery[img] ?? gallery[0];
  const [color, setColor] = useState(p.colors[0]);
  const sizes = Array.from(new Set(p.series.flatMap((series) => Object.keys(series.composition))));
  const [size, setSize] = useState(sizes.includes("M") ? "M" : sizes[0] ?? "M");
  return (
    <div className="animate-[fadeUp_0.4s_ease]">
      <button onClick={onBack} className="kv-press mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]">
        <ChevronLeft size={16} className="rotate-180" /> بازگشت به فروشگاه
      </button>
      <div className="grid gap-8 lg:grid-cols-[1.15fr_1fr]">
        {/* gallery 55% */}
        <div className="flex gap-3">
          <div className="flex w-[76px] shrink-0 flex-col gap-2.5">
            {gallery.map((media, i) => (
              <button key={`${media.kind}-${i}`} onClick={() => setImg(i)} aria-label={media.title} className={cn("relative overflow-hidden rounded-[12px] border-2 transition-all", img === i ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] opacity-70 hover:opacity-100")}>
                {media.kind === "image" ? <img src={media.src} alt={media.title} loading="lazy" className="aspect-[3/4] w-full object-cover" /> : <><img src={media.thumbnail || p.images[0]} alt={media.title} className="aspect-[3/4] w-full object-cover"/><span className="absolute inset-0 grid place-items-center bg-black/20 text-white">▶</span></>}
              </button>
            ))}
          </div>
          <div className="kv-img relative flex-1 overflow-hidden rounded-[24px] border border-[var(--kv-line)] kv-shadow-md">
            {selectedMedia?.kind === "video" ? (selectedMedia.src.includes("youtube") || selectedMedia.src.includes("youtu.be") ? <iframe key={img} src={selectedMedia.src} title={selectedMedia.title} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="aspect-[3/4] w-full bg-black" /> : <video key={img} src={selectedMedia.src} poster={selectedMedia.thumbnail} controls playsInline preload="metadata" className="aspect-[3/4] w-full bg-black object-contain" />) : <img key={img} src={selectedMedia?.src || p.images[0]} alt={selectedMedia?.title || p.name} fetchPriority={img === 0 ? "high" : "auto"} loading={img === 0 ? "eager" : "lazy"} className="aspect-[3/4] w-full object-cover animate-[fadeIn_0.35s_ease]" />}
            {p.badge && <span className="absolute right-4 top-4"><Status value={p.badge} dot={false} /></span>}
          </div>
        </div>
        {/* config 45% */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-[13px] font-semibold text-[var(--kv-muted)]">{p.brand} · کد {p.sku}</p>
          <h1 className="kv-editorial-title mt-2 text-[26px] md:text-[30px]">{p.name}</h1>
          <div className="mt-2.5 flex items-center gap-3 text-[13px] text-[var(--kv-muted)]">
            <span className="flex items-center gap-1 font-bold text-[var(--kv-ink)]"><Star size={14} fill="#D6A94E" strokeWidth={0} /> {p.rating.toLocaleString("fa-IR")}</span>
            <span>({fmtNum(p.reviews)} دیدگاه)</span>
            <span>·</span>
            <span>فروشنده: {p.supplier}</span>
          </div>
          <p className="mt-4 text-[24px] font-extrabold tabular-nums">{fmtMoney(p.retailPrice)}</p>
          <div className="mt-6">
            <p className="mb-2.5 text-[13px] font-bold">انتخاب رنگ <span className="font-medium text-[var(--kv-muted)]">— {color.name}</span></p>
            <div className="flex gap-2.5">{p.colors.map((c) => <Swatch key={c.id} hex={c.hex} name={c.name} selected={color.id === c.id} onSelect={() => setColor(c)} />)}</div>
          </div>
          <div className="mt-5">
            <div className="mb-2.5 flex items-center justify-between">
              <p className="text-[13px] font-bold">انتخاب سایز</p>
              <button className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-accent)]"><Ruler size={13} /> راهنمای سایز</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {sizes.map((s) => (
                <button key={s} onClick={() => setSize(s)} className={cn("kv-press min-w-[52px] rounded-[11px] border px-3 py-2.5 text-sm font-bold transition-all", size === s ? "border-[var(--kv-ink)] bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>{s}</button>
              ))}
            </div>
          </div>
          <div className="mt-5 flex items-center gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 px-4 py-3 text-[13px]">
            <span className={cn("h-2 w-2 rounded-full", p.stock > 0 ? "bg-[var(--kv-success)]" : "bg-[var(--kv-danger)]")} />
            <span className="font-semibold">{p.stock > 0 ? `موجود در انبار — ${fmtNum(p.stock)} عدد` : "ناموجود"}</span>
            <span className="text-[var(--kv-muted)]">· ارسال از فردا</span>
          </div>
          <div className="sticky bottom-4 z-10 mt-4 flex gap-2.5 lg:static">
            <Btn variant="accent" size="lg" className="flex-1 shadow-[var(--shadow-soft-lg)] lg:shadow-none" disabled={p.stock < 1} icon={<ShoppingBag size={17} />} onClick={() => onAdd(size, color.name)}>افزودن به سبد خرید</Btn>
            <button onClick={onWish} aria-label="علاقه‌مندی" className={cn("kv-press flex w-[52px] items-center justify-center rounded-[11px] border transition-all", wished ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
              <Heart size={19} fill={wished ? "currentColor" : "none"} />
            </button>
          </div>
          <div className="mt-5 space-y-3 border-t border-[var(--kv-line)] pt-5 text-[13px] leading-7 text-[var(--kv-muted)]">
            <p><span className="font-bold text-[var(--kv-ink)]">درباره این محصول — </span>{p.desc}</p>
            <p><span className="font-bold text-[var(--kv-ink)]">جنس پارچه: </span>{p.fabric}</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><Truck size={13} /> ارسال رایگان بالای ۵ میلیون</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><RotateCcw size={13} /> ۷ روز مهلت برگشت</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-semibold"><ShieldCheck size={13} /> ضمانت اصالت</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ MAIN RETAIL ============ */
export type RetailView = "home" | "shop" | "checkout" | "journal" | "wishlist" | "account" | "success";

export default function RetailExperience({ selectedId, setSelectedId, cart, setCart, wishlist, toggleWish, onStudio, view, setView, requireLogin, account, buyer, accountTab, setAccountTab, onWholesale, onLogout, onLogin }: {
  selectedId: string | null; setSelectedId: (id: string | null) => void;
  cart: CartLine[]; setCart: (c: CartLine[]) => void;
  wishlist: string[]; toggleWish: (id: string) => void;
  onStudio: (tab: string) => void;
  view: RetailView; setView: (v: RetailView) => void;
  requireLogin?: () => boolean;
  account: CustomerAccount | null; buyer?: Buyer;
  accountTab: AccountTab; setAccountTab: (v: AccountTab) => void;
  onWholesale: () => void; onLogout: () => void; onLogin: () => void;
}) {
  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, selectedId]);
  const [cat, setCat] = useState(() => new URLSearchParams(window.location.search).get("category") || "همه");
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") || "");
  const [sort, setSort] = useState("پیشنهاد کلبه");
  const [brandFilter, setBrandFilter] = useState(() => new URLSearchParams(window.location.search).get("brand") || "");
  const [genderFilter, setGenderFilter] = useState(() => new URLSearchParams(window.location.search).get("gender") || "");
  const [seasonFilter, setSeasonFilter] = useState(() => new URLSearchParams(window.location.search).get("season") || "");
  const [vibeFilter, setVibeFilter] = useState(() => new URLSearchParams(window.location.search).get("vibe") || "");
  const [attributeFilter, setAttributeFilter] = useState(() => new URLSearchParams(window.location.search).get("attribute") || "");
  const [ratingFilter, setRatingFilter] = useState(() => new URLSearchParams(window.location.search).get("rating") || "");
  const [discountOnly, setDiscountOnly] = useState(() => new URLSearchParams(window.location.search).get("discount") === "1");
  const [colorFilter, setColorFilter] = useState(() => new URLSearchParams(window.location.search).get("color") || "");
  const [sizeFilter, setSizeFilter] = useState(() => new URLSearchParams(window.location.search).get("size") || "");
  const [stockOnly, setStockOnly] = useState(() => new URLSearchParams(window.location.search).get("stock") === "1");
  const [installmentOnly, setInstallmentOnly] = useState(() => new URLSearchParams(window.location.search).get("installment") === "1");
  const [maxPrice, setMaxPrice] = useState(() => new URLSearchParams(window.location.search).get("maxPrice") || "");
  const committedSearch = useRef(window.location.search);
  const [checkStep, setCheckStep] = useState(0);
  const [checkoutAddressId, setCheckoutAddressId] = useState("");
  const [checkoutAddress, setCheckoutAddress] = useState<CustomerAddress>({ id: "", title: "خانه", recipient: "", phone: "", province: "", city: "", line: "", postalCode: "", isDefault: false });
  const [saveCheckoutAddress, setSaveCheckoutAddress] = useState(true);
  const [checkoutError, setCheckoutError] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "four_installments">("cash");
  const [placedOrderId, setPlacedOrderId] = useState("");
  const store = useStore();
  const ops = useOps();
  const retailProducts = store.products.filter((p) => p.status === "published" && p.retailPrice > 0);
  const cmsNav = (t: NavTarget) => (t === "vip" ? onWholesale() : t === "tryon" ? onStudio("tryon") : setView(t === "journal" ? "journal" : "shop"));
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponMsg, setCouponMsg] = useState("");
  const [journalMode, setJournalMode] = useState<"article" | "video">("article");
  const [publishedVideoPosts, setPublishedVideoPosts] = useState<JournalPost[]>(() => getPublishedPosts("video"));
  const [publishedArticles, setPublishedArticles] = useState<JournalPost[]>(() => getPublishedPosts("article"));
  useEffect(() => { const refreshEditorial = () => { setPublishedVideoPosts(getPublishedPosts("video")); setPublishedArticles(getPublishedPosts("article")); }; window.addEventListener("storage", refreshEditorial); return () => window.removeEventListener("storage", refreshEditorial); }, []);

  const selected = useMemo(() => retailProducts.find((p) => p.id === selectedId) ?? null, [selectedId, retailProducts]);
  useEffect(() => {
    const originalTitle = document.title;
    const old: { element: HTMLMetaElement | HTMLLinkElement; content: string | null }[] = [];
    const addOrSet = (selector: string, tag: "meta" | "link", attrs: Record<string, string>, value: string) => {
      let element = document.head.querySelector(selector) as HTMLMetaElement | HTMLLinkElement | null;
      if (!element) { element = document.createElement(tag); Object.entries(attrs).forEach(([key, val]) => element!.setAttribute(key, val)); document.head.appendChild(element); old.push({ element, content: null }); }
      else { old.push({ element, content: tag === "meta" ? (element as HTMLMetaElement).content : element.getAttribute("href") }); }
      if (tag === "meta") (element as HTMLMetaElement).content = value; else element.setAttribute("href", value);
    };
    let savedSEO: RetailSEOState = {};
    try { savedSEO = JSON.parse(localStorage.getItem("kolbe-seo-center-v1") || "{}"); } catch { /* default templates */ }
    const key = selected ? `product:${selected.id}` : view === "shop" && cat !== "همه" ? `category:${cat}` : view === "home" ? "site" : view === "journal" ? "blog" : "site";
    const record = savedSEO.records?.[key] ?? {};
    const product = selected;
    const titleTemplate = savedSEO.templateTitle || "{{product.name}} | خرید از کلبه وینتیج";
    const descriptionTemplate = savedSEO.templateDescription || "خرید {{product.name}} با قیمت {{product.price}} و ارسال به سراسر ایران";
    const pageTitle = record.title || (product ? titleTemplate.replace(/\\{\\{product\\.name\\}\\}/g, product.name).replace(/\\{\\{product\\.price\\}\\}/g, fmtMoney(product.retailPrice)) : `${cat !== "همه" && view === "shop" ? cat : view === "journal" ? "مجله کلبه" : "کلبه وینتیج"} | KOLBE`);
    const pageDescription = record.description || (product ? descriptionTemplate.replace(/\\{\\{product\\.name\\}\\}/g, product.name).replace(/\\{\\{product\\.price\\}\\}/g, fmtMoney(product.retailPrice)) : "پوشاک کلاسیک و مدرن کلبه وینتیج؛ خرید مستقیم از فروشگاه.");
    const path = record.slug || (product ? `/product/${product.sku.toLowerCase()}` : view === "shop" ? "/shop" : view === "journal" ? "/journal" : "/");
    const canonical = record.canonical || `https://kolbe.ir${path.startsWith("/") ? path : `/${path}`}`;
    document.title = pageTitle;
    addOrSet('meta[name="description"]', "meta", { name: "description" }, pageDescription);
    addOrSet('meta[name="robots"]', "meta", { name: "robots" }, `${record.index === false ? "noindex" : "index"},${record.follow === false ? "nofollow" : "follow"}`);
    addOrSet('link[rel="canonical"]', "link", { rel: "canonical" }, canonical);
    addOrSet('meta[property="og:title"]', "meta", { property: "og:title" }, record.socialTitle || pageTitle);
    addOrSet('meta[property="og:description"]', "meta", { property: "og:description" }, record.socialDescription || pageDescription);
    addOrSet('meta[property="og:image"]', "meta", { property: "og:image" }, record.socialImage || product?.images[0] || "");
    addOrSet('meta[name="twitter:card"]', "meta", { name: "twitter:card" }, "summary_large_image");
    addOrSet('meta[name="twitter:title"]', "meta", { name: "twitter:title" }, record.socialTitle || pageTitle);
    addOrSet('meta[name="twitter:description"]', "meta", { name: "twitter:description" }, record.socialDescription || pageDescription);
    const priorSchema = document.head.querySelector('script[data-kolbe-jsonld="1"]'); const previousSchema = priorSchema?.textContent ?? null;
    if (product) { let script = priorSchema as HTMLScriptElement | null; if (!script) { script = document.createElement("script"); script.type = "application/ld+json"; script.dataset.kolbeJsonld = "1"; document.head.appendChild(script); } script.textContent = JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Product", name: product.name, sku: product.sku, brand: { "@type": "Brand", name: product.brand }, description: product.desc, image: product.images, offers: { "@type": "Offer", priceCurrency: "IRR", price: Math.round(product.retailPrice * 10), availability: product.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", url: canonical } }, { "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "خانه", item: "https://kolbe.ir/" }, { "@type": "ListItem", position: 2, name: product.category, item: `https://kolbe.ir/category/${encodeURIComponent(product.category)}` }, { "@type": "ListItem", position: 3, name: product.name, item: canonical }] }] }); }
    else if (priorSchema) priorSchema.remove();
    return () => { document.title = originalTitle; old.forEach(({ element, content }) => { if (content === null) element.remove(); else if (element.tagName === "META") (element as HTMLMetaElement).content = content; else element.setAttribute("href", content); }); if (priorSchema && previousSchema !== null) priorSchema.textContent = previousSchema; else if (product) document.head.querySelector('script[data-kolbe-jsonld="1"]')?.remove(); };
  }, [selected, view, cat]);

  const filtered = useMemo(() => {
    let list = [...retailProducts];
    if (cat !== "همه") list = list.filter((p) => p.category === cat);
    if (brandFilter) list = list.filter((p) => p.brand === brandFilter);
    if (genderFilter) list = list.filter((p) => p.gender === genderFilter);
    if (seasonFilter) list = list.filter((p) => p.seasons?.includes(seasonFilter));
    if (vibeFilter) list = list.filter((p) => p.vibes?.includes(vibeFilter));
    if (attributeFilter) { const [key, value] = attributeFilter.split(":"); list = list.filter((p) => { const item = p.attributes?.[key]; return Array.isArray(item) ? item.includes(value) : item === value; }); }
    if (ratingFilter) list = list.filter((p) => p.rating >= Number(ratingFilter));
    if (discountOnly) list = list.filter((p) => (p.discountPercent ?? 0) > 0);
    if (colorFilter) list = list.filter((p) => p.colors.some((c) => c.id === colorFilter || c.name === colorFilter));
    if (sizeFilter) list = list.filter((p) => p.series.some((s) => Object.keys(s.composition).includes(sizeFilter)));
    if (stockOnly) list = list.filter((p) => p.stock > 0);
    if (installmentOnly) list = list.filter((p) => p.installmentPrice != null);
    if (maxPrice && Number(maxPrice) > 0) list = list.filter((p) => p.retailPrice <= Number(maxPrice));
    const query = normalizeSearch(q.trim());
    if (query) list = list.filter((p) => {
      const fields = [p.name, p.sku, p.brand, p.category, p.supplier, p.desc, p.fabric, ...p.colors.map((c) => c.name), ...(p.seasons ?? []), ...(p.vibes ?? []), ...Object.entries(p.attributes ?? {}).flatMap(([k, v]) => [k, ...(Array.isArray(v) ? v : [v])]), ...p.series.flatMap((s) => Object.keys(s.composition))];
      return fields.some((field) => normalizeSearch(field).includes(query) || fuzzyMatch(query, normalizeSearch(field)));
    });
    if (sort === "ارزان‌ترین") list.sort((a, b) => a.retailPrice - b.retailPrice);
    else if (sort === "گران‌ترین") list.sort((a, b) => b.retailPrice - a.retailPrice);
    else if (sort === "پربازدیدترین") list.sort((a, b) => b.reviews - a.reviews);
    else if (q.trim()) list.sort((a, b) => relevanceScore(b, q) - relevanceScore(a, q) || Number(b.stock > 0) - Number(a.stock > 0) || b.reviews - a.reviews);
    else list.sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || b.reviews - a.reviews);
    return list;
  }, [cat, brandFilter, genderFilter, seasonFilter, vibeFilter, attributeFilter, ratingFilter, discountOnly, colorFilter, sizeFilter, stockOnly, installmentOnly, maxPrice, q, sort, retailProducts]);

  const addToCart = (id: string, size: string, color: string): boolean => {
    const product = retailProducts.find((p) => p.id === id);
    if (!product || product.stock < 1) return false;
    const ex = cart.find((l) => l.id === id && l.size === size && l.color === color);
    if (cart.filter((line) => line.id === id).reduce((total, line) => total + line.qty, 0) >= product.stock) return false;
    if (ex) setCart(cart.map((l) => l === ex ? { ...l, qty: l.qty + 1 } : l));
    else setCart([...cart, { id, qty: 1, size, color }]);
    return true;
  };
  const quickAdd = (p: Product) => (size: string, color: string) => addToCart(p.id, size, color);
  const cartTotal = cart.reduce((s, l) => s + (retailProducts.find((p) => p.id === l.id)?.retailPrice ?? 0) * l.qty, 0);
  const installmentCartTotal = cart.reduce((s, l) => {
    const product = retailProducts.find((p) => p.id === l.id);
    return s + (product?.installmentPrice ?? product?.retailPrice ?? 0) * l.qty;
  }, 0);
  const cats = ["همه", ...Array.from(new Set(retailProducts.map((p) => p.category)))];
  const brands = Array.from(new Set(retailProducts.map((p) => p.brand)));
  const genders = Array.from(new Set(retailProducts.map((p) => p.gender).filter((v): v is string => Boolean(v))));
  const seasons = Array.from(new Set(retailProducts.flatMap((p) => p.seasons ?? [])));
  const vibes = Array.from(new Set(retailProducts.flatMap((p) => p.vibes ?? [])));
  const attributes = Array.from(new Set(retailProducts.flatMap((p) => Object.entries(p.attributes ?? {}).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((v) => `${key}:${v}`)))));
  const filterColors = Array.from(new Map(retailProducts.flatMap((p) => p.colors).map((c) => [c.id, c])).values());
  const filterSizes = Array.from(new Set(retailProducts.flatMap((p) => p.series.flatMap((s) => Object.keys(s.composition)))));
  useEffect(() => {
    if (view !== "shop") return;
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim()); if (cat !== "همه") params.set("category", cat);
    if (brandFilter) params.set("brand", brandFilter); if (genderFilter) params.set("gender", genderFilter); if (seasonFilter) params.set("season", seasonFilter); if (vibeFilter) params.set("vibe", vibeFilter); if (attributeFilter) params.set("attribute", attributeFilter); if (ratingFilter) params.set("rating", ratingFilter); if (discountOnly) params.set("discount", "1"); if (colorFilter) params.set("color", colorFilter); if (sizeFilter) params.set("size", sizeFilter);
    if (stockOnly) params.set("stock", "1"); if (installmentOnly) params.set("installment", "1"); if (maxPrice) params.set("maxPrice", maxPrice);
    const suffix = params.toString(); const nextSearch = suffix ? `?${suffix}` : ""; const next = `${window.location.pathname}${nextSearch}${window.location.hash}`;
    if (nextSearch === committedSearch.current) return;
    const timer = window.setTimeout(() => { window.history.pushState({}, "", next); committedSearch.current = nextSearch; }, 350);
    return () => window.clearTimeout(timer);
  }, [view, q, cat, brandFilter, genderFilter, seasonFilter, vibeFilter, attributeFilter, ratingFilter, discountOnly, colorFilter, sizeFilter, stockOnly, installmentOnly, maxPrice]);
  useEffect(() => {
    const restore = () => { committedSearch.current = window.location.search; const p = new URLSearchParams(window.location.search); setQ(p.get("q") || ""); setCat(p.get("category") || "همه"); setBrandFilter(p.get("brand") || ""); setGenderFilter(p.get("gender") || ""); setSeasonFilter(p.get("season") || ""); setVibeFilter(p.get("vibe") || ""); setAttributeFilter(p.get("attribute") || ""); setRatingFilter(p.get("rating") || ""); setDiscountOnly(p.get("discount") === "1"); setColorFilter(p.get("color") || ""); setSizeFilter(p.get("size") || ""); setStockOnly(p.get("stock") === "1"); setInstallmentOnly(p.get("installment") === "1"); setMaxPrice(p.get("maxPrice") || ""); };
    window.addEventListener("popstate", restore); return () => window.removeEventListener("popstate", restore);
  }, []);
  useEffect(() => {
    if (!q.trim()) return;
    const timer = window.setTimeout(() => recordSearchEvent(q, "search", filtered.length), 700);
    return () => window.clearTimeout(timer);
  }, [q, filtered.length]);
  useEffect(() => { if (selectedId && q.trim()) recordSearchEvent(q, "click"); }, [selectedId]);
  const { shipping } = store;
  const retailShipping = shipping.filter((s) => s.active && s.scope !== "عمده");
  const [shipId, setShipId] = useState("");
  const ship = retailShipping.find((s) => s.id === shipId) ?? retailShipping[0];
  const today = new Date().toISOString().slice(0, 10);
  const liveFestivals = ops.festivals.filter((f) => f.active && f.starts <= today && f.ends >= today);
  const festivalDiscount = cart.reduce((sum, l) => {
    const p = retailProducts.find((x) => x.id === l.id);
    const pct = p ? Math.max(0, ...liveFestivals.filter((f) => f.categories.includes(p.category)).map((f) => f.discountPercent)) : 0;
    return sum + Math.round((p?.retailPrice ?? 0) * l.qty * pct / 100);
  }, 0);
  const coupon = ops.coupons.find((c) => c.code === couponCode && c.channel === "retail");
  const couponError = !coupon ? "" : !coupon.active ? "این کوپن غیرفعال است." : coupon.expires < today ? "مهلت این کوپن تمام شده است." : coupon.used >= coupon.maxUses ? "ظرفیت این کوپن تکمیل شده است." : cartTotal < coupon.minOrder ? `حداقل خرید برای این کوپن ${fmtMoney(coupon.minOrder)} است.` : "";
  const validCoupon = coupon && !couponError ? coupon : undefined;
  const afterFestival = Math.max(0, cartTotal - festivalDiscount);
  const couponDiscount = !validCoupon ? 0 : validCoupon.type === "percent" ? Math.round(afterFestival * validCoupon.value / 100) : validCoupon.type === "fixed" ? Math.min(afterFestival, validCoupon.value) : 0;
  const baseShip = !ship || cart.length === 0 ? 0 : ship.freeAbove !== null && cartTotal >= ship.freeAbove ? 0 : ship.price;
  const shipCost = validCoupon?.type === "freeShip" ? 0 : baseShip;
  const totalDiscount = festivalDiscount + couponDiscount;
  const custRestrict = account ? ops.restrictionFor("customer", account.id) : null;
  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    const c = ops.coupons.find((x) => x.code === code);
    if (!c) { setCouponCode(""); setCouponMsg("کوپنی با این کد پیدا نشد."); return; }
    if (c.channel !== "retail") { setCouponCode(""); setCouponMsg("این کوپن مخصوص خرید عمده است."); return; }
    setCouponCode(code); setCouponMsg("");
  };
  const savedAddress = account?.addresses.find((a) => a.id === checkoutAddressId)
    ?? (checkoutAddressId === "new" ? undefined : account?.addresses.find((a) => a.isDefault) ?? account?.addresses[0]);
  const deliveryAddress = savedAddress ?? checkoutAddress;
  const finishCheckout = () => {
    setCheckoutError("");
    if (checkStep === 0) {
      if (requireLogin && !requireLogin()) return;
      setCheckStep(1);
      return;
    }
    if (checkStep === 1) {
      if (!deliveryAddress.recipient.trim() || !deliveryAddress.province.trim() || !deliveryAddress.city.trim() || !deliveryAddress.line.trim()
        || !/^09\d{9}$/.test(digitsOnly(deliveryAddress.phone)) || !/^\d{10}$/.test(digitsOnly(deliveryAddress.postalCode))) {
        setCheckoutError("نام گیرنده، نشانی کامل، شماره همراه ۱۱ رقمی و کد پستی ۱۰ رقمی را وارد کنید.");
        return;
      }
      if (!ship) { setCheckoutError("هیچ روش ارسال فعالی وجود ندارد."); return; }
      setCheckStep(2);
      return;
    }
    if (!account || !ship) { setCheckoutError("برای ثبت سفارش وارد حساب شوید و روش ارسال را انتخاب کنید."); return; }
    if (custRestrict?.block || custRestrict?.noOrder) { setCheckoutError(`ثبت سفارش برای حساب شما محدود شده است${custRestrict.reason ? `: ${custRestrict.reason}` : ""}. از پشتیبانی پیگیری کنید.`); return; }
    const normalized = { ...deliveryAddress, id: deliveryAddress.id || `addr-${Date.now()}`, phone: digitsOnly(deliveryAddress.phone), postalCode: digitsOnly(deliveryAddress.postalCode), isDefault: !account.addresses.length };
    const note = [festivalDiscount && `تخفیف جشنواره ${fmtMoney(festivalDiscount)}`, validCoupon && `کوپن ${validCoupon.code}`].filter(Boolean).join(" · ");
    const orderId = store.placeRetailOrder(account.id, cart, normalized, ship.name, shipCost, totalDiscount, note || undefined, paymentMode);
    if (orderId && validCoupon) ops.upsert("coupons", { ...validCoupon, used: validCoupon.used + 1 });
    if (!orderId) { setCheckoutError("موجودی یکی از محصولات تغییر کرده است. سبد خرید را بررسی کنید."); return; }
    if (!savedAddress && saveCheckoutAddress) store.updateAccount(account.id, { addresses: [...account.addresses, normalized] });
    if (q.trim()) recordSearchEvent(q, "conversion");
    setPlacedOrderId(orderId);
    setCheckStep(0);
    setView("success");
  };

  /* ----- PDP overlay ----- */
  if (selected) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-6 md:px-8">
        <RetailPDP
          p={selected} wished={wishlist.includes(selected.id)}
          onWish={() => toggleWish(selected.id)}
          onBack={() => setSelectedId(null)}
          onAdd={(size, color) => { if (addToCart(selected.id, size, color)) { setSelectedId(null); setView("shop"); } }}
        />
        <div className="mt-14">
          <SectionHead title="شاید بپسندید" />
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">
            {retailProducts.filter((p) => p.id !== selected.id).slice(0, 4).map((p) => (
              <RetailCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ----- CHECKOUT ----- */
  if (view === "checkout" || view === "success") {
    if (view === "success") {
      return (
        <div className="mx-auto max-w-[560px] px-4 py-16 text-center animate-[scaleIn_0.35s_ease]">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#E7F0E6] text-[#3E6B4A]"><Check size={28} /></div>
          <h2 className="kv-editorial-title text-[26px]">سفارش آزمایشی شما ثبت شد</h2>
          <p className="mt-3 text-sm leading-7 text-[var(--kv-muted)]">شماره سفارش: <span className="font-bold text-[var(--kv-ink)] tabular-nums">{placedOrderId}</span>. در این نسخه پرداخت شبیه‌سازی شده و تراکنش بانکی یا پیامک واقعی انجام نشده است. جزئیات در پنل حساب شما قرار دارد.</p>
          <div className="mt-7 flex justify-center gap-3">
            <Btn variant="accent" onClick={() => setView("home")}>بازگشت به فروشگاه</Btn>
            <Btn variant="soft" onClick={() => { setAccountTab("orders"); setView("account"); }}>دیدن سفارش در حساب</Btn>
          </div>
        </div>
      );
    }
    const steps = ["سبد خرید", "نشانی", "پرداخت"];
    return (
      <div className="mx-auto w-full max-w-[1100px] px-4 pb-20 pt-8 md:px-8">
        <h1 className="kv-editorial-title text-[26px]">تکمیل خرید</h1>
        <div className="mt-5 flex items-center gap-2">
          {steps.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <button onClick={() => setCheckStep(Math.min(i, 2))} className={cn("flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold transition-all", checkStep >= i ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
                {checkStep > i ? <Check size={15} /> : (i + 1).toLocaleString("fa-IR")}
              </button>
              <span className={cn("text-[13px] font-semibold", checkStep >= i ? "" : "text-[var(--kv-muted)]")}>{s}</span>
              {i < 2 && <span className="mx-2 h-px flex-1 bg-[var(--kv-line)]" />}
            </div>
          ))}
        </div>
        <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card className="p-6">
            {checkStep === 0 && (
              cart.length === 0 ? <Empty title="سبد خرید خالی است" desc="هنوز چیزی به سبد اضافه نکرده‌اید. از کالکشن‌های تازه شروع کنید." action={<Btn variant="accent" size="sm" onClick={() => setView("shop")}>مشاهده محصولات</Btn>} /> : (
                <div className="space-y-4">
                  {cart.map((l, i) => {
                    const p = store.products.find((x) => x.id === l.id);
                    if (!p) return null;
                    return (
                      <div key={i} className="flex gap-4 rounded-[14px] border border-[var(--kv-line)] p-3">
                        <img src={p.images[0]} alt={p.imageMeta?.[0]?.alt || p.name} className="h-24 w-20 shrink-0 rounded-[10px] object-cover" />
                        <div className="flex flex-1 flex-col">
                          <div className="flex items-start justify-between gap-2">
                            <div><p className="text-sm font-bold">{p.name}</p><p className="mt-1 text-xs text-[var(--kv-muted)]">سایز {l.size} · {l.color}</p></div>
                            <button onClick={() => setCart(cart.filter((_, j) => j !== i))} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف"><Trash2 size={16} /></button>
                          </div>
                          <div className="mt-auto flex items-center justify-between pt-2">
                            <div className="inline-flex items-center gap-2 rounded-lg border border-[var(--kv-line)] px-1 py-0.5">
                              <button onClick={() => setCart(cart.map((x, j) => j === i ? { ...x, qty: x.qty + 1 } : x))} className="p-1.5"><Plus size={13} /></button>
                              <span className="text-[13px] font-bold tabular-nums">{fmtNum(l.qty)}</span>
                              <button onClick={() => setCart(cart.map((x, j) => j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x))} className="p-1.5"><Minus size={13} /></button>
                            </div>
                            <p className="text-sm font-extrabold tabular-nums">{fmtMoney(p.retailPrice * l.qty)}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            )}
            {checkStep === 1 && (
              <div className="space-y-5">
                {!!account?.addresses.length && <div><p className="mb-2 text-[13px] font-semibold text-[var(--kv-ink-2)]">نشانی‌های ذخیره‌شده</p><div className="grid gap-2 sm:grid-cols-2">{account.addresses.map((address) => <button key={address.id} onClick={() => setCheckoutAddressId(address.id)} className={cn("flex min-h-18 items-start gap-2 rounded-[11px] border p-3 text-right text-[12px]", savedAddress?.id === address.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)]")}><MapPin size={15} className="mt-1 shrink-0 text-[var(--kv-accent)]" /><span><b>{address.title} · {address.recipient}</b><span className="mt-1 block leading-5 text-[var(--kv-muted)]">{address.city}، {address.line}</span></span></button>)}</div><button onClick={() => setCheckoutAddressId("new")} className="mt-2 text-[12.5px] font-bold text-[var(--kv-accent)]">+ نشانی جدید</button></div>}
                {!savedAddress && <div className="grid gap-4 md:grid-cols-2">
                  <Field label="نام و نام خانوادگی گیرنده"><Input value={checkoutAddress.recipient} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, recipient: v })} placeholder={account?.name ?? "نام گیرنده"} /></Field>
                  <Field label="شماره تماس"><Input value={checkoutAddress.phone} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, phone: v })} placeholder={account?.phone ?? "۰۹۱۲…"} /></Field>
                  <Field label="استان"><Input value={checkoutAddress.province} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, province: v })} placeholder="تهران" /></Field>
                  <Field label="شهر"><Input value={checkoutAddress.city} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, city: v })} placeholder="تهران" /></Field>
                  <div className="md:col-span-2"><Field label="نشانی کامل"><Input value={checkoutAddress.line} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, line: v })} placeholder="خیابان، کوچه، پلاک، واحد" icon={<MapPin size={16} />} /></Field></div>
                  <Field label="کد پستی"><Input value={checkoutAddress.postalCode} onChange={(v) => setCheckoutAddress({ ...checkoutAddress, postalCode: v })} placeholder="۱۰ رقمی" /></Field>
                  <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={saveCheckoutAddress} onChange={(e) => setSaveCheckoutAddress(e.target.checked)} className="h-4 w-4 accent-[#C1613B]" />ذخیره نشانی در حساب</label>
                </div>}
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-[var(--kv-ink-2)]">روش ارسال</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {retailShipping.map((m) => {
                      const free = m.freeAbove !== null && cartTotal >= m.freeAbove;
                      return (
                        <button key={m.id} onClick={() => setShipId(m.id)} className={cn("flex items-center gap-3 rounded-[12px] border px-4 py-3 text-right transition-all", ship?.id === m.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                          <Truck size={17} className="shrink-0 text-[var(--kv-muted)]" />
                          <span className="flex-1"><b className="text-[13px]">{m.name}</b><span className="block text-xs text-[var(--kv-muted)]">{m.eta} · {m.zones}</span></span>
                          <span className="text-[12.5px] font-bold">{free ? "رایگان" : fmtMoney(m.price)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
            {checkStep === 2 && (
              <div className="rounded-[14px] border border-[var(--kv-accent)]/40 bg-[var(--kv-accent)]/[0.05] p-5"><div className="flex items-center gap-3"><CreditCard size={20} className="text-[var(--kv-accent)]" /><p className="text-[14px] font-bold">پرداخت آزمایشی</p></div><p className="mt-2 text-[12.5px] leading-7 text-[var(--kv-muted)]">برای تست پنل، پرداخت این سفارش شبیه‌سازی می‌شود. هیچ وجهی دریافت نمی‌شود و تراکنش بانکی واقعی انجام نمی‌گیرد.</p><fieldset className="mt-4 space-y-2"><legend className="mb-2 text-[12px] font-bold">روش پرداخت</legend><label className="flex items-center gap-2 text-[13px]"><input type="radio" name="payment-mode" checked={paymentMode === "cash"} onChange={() => setPaymentMode("cash")} />نقدی · {fmtMoney(Math.max(0, cartTotal - totalDiscount) + shipCost)}</label><label className="flex items-center gap-2 text-[13px]"><input type="radio" name="payment-mode" checked={paymentMode === "four_installments"} onChange={() => setPaymentMode("four_installments")} />چهار قسط · هر قسط {fmtMoney(Math.ceil((Math.max(0, installmentCartTotal - totalDiscount) + shipCost) / 4))}</label></fieldset></div>
            )}
          </Card>
          <Card className="h-fit p-6 lg:sticky lg:top-24">
            <p className="text-[15px] font-bold">خلاصه سفارش</p>
            <div className="mt-4 space-y-2.5 text-[13px]">
              <div className="flex justify-between text-[var(--kv-muted)]"><span>جمع اقلام ({fmtNum(cart.reduce((s, l) => s + l.qty, 0))})</span><span className="tabular-nums">{fmtMoney(paymentMode === "cash" ? cartTotal : installmentCartTotal)}</span></div>
              {festivalDiscount > 0 && <div className="flex justify-between text-[var(--kv-success)]"><span>تخفیف {liveFestivals.map((f) => f.name).join("، ")}</span><span className="tabular-nums">−{fmtMoney(festivalDiscount)}</span></div>}
              {couponDiscount > 0 && <div className="flex justify-between text-[var(--kv-success)]"><span>کوپن {validCoupon?.code}</span><span className="tabular-nums">−{fmtMoney(couponDiscount)}</span></div>}
              <div className="flex justify-between text-[var(--kv-muted)]"><span>هزینه ارسال{ship ? ` (${ship.name})` : ""}</span><span>{shipCost === 0 ? "رایگان" : fmtMoney(shipCost)}</span></div>
              <div className="flex justify-between border-t border-[var(--kv-line)] pt-3 text-[15px] font-extrabold"><span>مبلغ نهایی</span><span className="tabular-nums">{fmtMoney(Math.max(0, (paymentMode === "cash" ? cartTotal : installmentCartTotal) - totalDiscount) + shipCost)}</span></div>
              {paymentMode === "four_installments" && <p className="text-[12px] text-[var(--kv-muted)]">۴ قسطِ {fmtMoney(Math.ceil((Math.max(0, installmentCartTotal - totalDiscount) + shipCost) / 4))} بر پایه قیمت چهارقسطه محصولات</p>}
              <div className="pt-2">
                <label className="mb-1.5 block text-[12px] font-semibold text-[var(--kv-ink-2)]" htmlFor="coupon">کد تخفیف</label>
                <div className="flex gap-2"><input id="coupon" value={couponInput} onChange={(e) => setCouponInput(e.target.value)} placeholder="مثلاً PAIZ1404" dir="ltr" className="h-10 min-w-0 flex-1 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] uppercase text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /><Btn size="sm" variant="soft" disabled={!couponInput.trim()} onClick={applyCoupon}>اعمال</Btn></div>
                {(couponMsg || couponError) && <p role="alert" className="mt-1.5 text-[11.5px] text-[var(--kv-danger)]">{couponMsg || couponError}</p>}
                {validCoupon && <p className="mt-1.5 text-[11.5px] font-semibold text-[var(--kv-success)]">کوپن {validCoupon.code} اعمال شد{validCoupon.type === "freeShip" ? " · ارسال رایگان" : ""} <button onClick={() => { setCouponCode(""); setCouponInput(""); }} className="mr-1 underline">حذف</button></p>}
              </div>
            </div>
            {checkoutError && <p role="alert" className="mt-4 text-[12px] leading-6 text-[var(--kv-danger)]">{checkoutError}</p>}
            <Btn variant="accent" className="mt-5 w-full" disabled={cart.length === 0} onClick={finishCheckout}>
              {checkStep === 2 ? "ثبت سفارش با پرداخت آزمایشی" : "ادامه"}
            </Btn>
            <button onClick={() => setView("shop")} className="mt-3 w-full text-center text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]">بازگشت به فروشگاه</button>
          </Card>
        </div>
      </div>
    );
  }

  /* ----- WISHLIST / ACCOUNT / JOURNAL ----- */
  if (view === "wishlist") {
    const items = retailProducts.filter((p) => wishlist.includes(p.id));
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-8 md:px-8">
        <SectionHead title="علاقه‌مندی‌ها" desc="چیزهایی که چشم‌تان را گرفته؛ هر وقت آماده بودید به سبد اضافه کنید." />
        {items.length === 0 ? <Empty title="هنوز چیزی ذخیره نکرده‌اید" desc="روی قلب هر محصول بزنید تا اینجا ذخیره شود." action={<Btn variant="accent" size="sm" onClick={() => setView("shop")}>کشف محصولات</Btn>} /> : (
          <div className="grid grid-cols-2 gap-5 md:grid-cols-4">{items.map((p) => <RetailCard key={p.id} p={p} wished onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />)}</div>
        )}
      </div>
    );
  }
  if (view === "account") {
    if (!account) return <div className="mx-auto max-w-[600px] px-4 py-12"><Empty title="برای دیدن حساب وارد شوید" desc="سفارش‌ها و نشانی‌های شما بعد از ورود در دسترس‌اند." action={<Btn variant="accent" onClick={onLogin}>ورود به حساب</Btn>} /></div>;
    return <AccountExperience key={account.id} account={account} buyer={buyer} tab={accountTab} setTab={setAccountTab} onShop={() => setView("shop")} onWholesale={onWholesale} onOpenProduct={setSelectedId} onCheckout={() => setView("checkout")} onStudio={() => onStudio("builder")} onLogout={onLogout} />;
  }
  if (view === "journal") {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-8 md:px-8">
        <SectionHead title="مجله کلبه" desc="مقالات و محتوای ویدیویی درباره استایل، پارچه و آدم‌هایی که لباس‌های شما را می‌دوزند." />
        <div className="mb-6 flex gap-2" role="tablist" aria-label="نوع محتوای مجله">
          <button role="tab" aria-selected={journalMode === "article"} onClick={() => setJournalMode("article")} className={cn("rounded-full px-4 py-2 text-sm font-bold", journalMode === "article" ? "bg-[var(--kv-action)] text-white" : "border border-[var(--kv-line)]")}>مقالات</button>
          <button role="tab" aria-selected={journalMode === "video"} onClick={() => setJournalMode("video")} className={cn("rounded-full px-4 py-2 text-sm font-bold", journalMode === "video" ? "bg-[var(--kv-action)] text-white" : "border border-[var(--kv-line)]")}>ویدیوها <span className="mr-1 text-xs opacity-70">({fmtNum(publishedVideoPosts.length)})</span></button>
        </div>
        {journalMode === "article" ? <div className="grid gap-5 md:grid-cols-3">
          {[...JOURNAL.map((j) => ({ id: j.id, title: j.title, image: j.img, category: j.cat, detail: j.read, description: "" })), ...publishedArticles.map((j) => ({ id: j.id, title: j.title, image: j.image, category: j.category, detail: j.author, description: j.description }))].map((j) => <article key={j.id} className="kv-card-hover overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm"><div className="kv-img aspect-[16/10] overflow-hidden">{j.image ? <img src={j.image} alt={j.title} loading="lazy" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-[var(--kv-muted)]">مجله کلبه</div>}</div><div className="p-5"><p className="text-xs font-bold text-[var(--kv-accent)]">{j.category} · {j.detail}</p><h3 className="mt-2 text-[15px] font-bold leading-7">{j.title}</h3><p className="mt-1 line-clamp-2 text-xs leading-6 text-[var(--kv-muted)]">{j.description}</p><button className="mt-3 inline-flex items-center gap-1 text-[13px] font-bold text-[var(--kv-ink)]">خواندن <ArrowLeft size={14} /></button></div></article>)}
        </div> : publishedVideoPosts.length ? <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">{publishedVideoPosts.map((item) => <article key={item.id} className="overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]"><div className="aspect-video bg-black">{item.url.includes("youtube-nocookie.com/embed") ? <iframe src={item.url} title={item.title} loading="lazy" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowFullScreen className="h-full w-full"/> : item.url ? <video src={item.url} poster={item.image || undefined} controls playsInline preload="metadata" className="h-full w-full"/> : <img src={item.image} alt={item.title} loading="lazy" className="h-full w-full object-cover"/>}</div><div className="p-5"><p className="text-xs font-bold text-[var(--kv-accent)]">{item.category}{item.duration ? ` · ${fmtNum(Number(item.duration))} ثانیه` : ""}</p><h3 className="mt-2 text-base font-extrabold">{item.title}</h3><p className="mt-2 line-clamp-3 text-sm leading-7 text-[var(--kv-muted)]">{item.description}</p><p className="mt-3 text-xs text-[var(--kv-muted)]">{item.author} {item.publishDate && `· ${item.publishDate}`}</p></div></article>)}</div> : <Empty title="هنوز ویدیویی منتشر نشده است" desc="ویدیوهای منتشرشده از مرکز مدیریت محتوا در این بخش نمایش داده می‌شوند." />}
      </div>
    );
  }

  /* ----- SHOP ----- */
  if (view === "shop") {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="kv-editorial-title text-[26px] md:text-[30px]">فروشگاه</h1>
            <p className="mt-1.5 text-sm text-[var(--kv-muted)]">{fmtNum(filtered.length)} محصول · ارسال به سراسر کشور</p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchBox value={q} onChange={setQ} placeholder="جست‌وجوی محصول، برند…" />
            <Select options={["پیشنهاد کلبه", "ارزان‌ترین", "گران‌ترین", "پربازدیدترین"]} value={sort} onChange={setSort} className="w-44" />
          </div>
        </div>
        <div className="kv-no-scrollbar mt-5 flex gap-2 overflow-x-auto pb-1">
          {cats.map((c) => <Tag key={c} active={cat === c} onClick={() => setCat(c)}>{c}{c !== "همه" && <span className="mr-1 opacity-60">({fmtNum(retailProducts.filter((p) => p.category === c).length)})</span>}</Tag>)}
        </div>
        <details className="mt-3 rounded-2xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold"><SlidersHorizontal size={16}/>فیلترهای پیشرفته <span className="text-xs font-normal text-[var(--kv-muted)]">· نتایج: {fmtNum(filtered.length)}</span></summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-xs font-bold">برند<Select className="mt-1.5 w-full" options={["همه برندها", ...brands]} value={brandFilter || "همه برندها"} onChange={(v) => setBrandFilter(v === "همه برندها" ? "" : v)}/></label>
            {genders.length > 0 && <label className="text-xs font-bold">جنسیت<Select className="mt-1.5 w-full" options={["همه", ...genders]} value={genderFilter || "همه"} onChange={(v) => setGenderFilter(v === "همه" ? "" : v)}/></label>}
            {seasons.length > 0 && <label className="text-xs font-bold">فصل<Select className="mt-1.5 w-full" options={["همه فصل‌ها", ...seasons]} value={seasonFilter || "همه فصل‌ها"} onChange={(v) => setSeasonFilter(v === "همه فصل‌ها" ? "" : v)}/></label>}
            {vibes.length > 0 && <label className="text-xs font-bold">استایل / Vibe<Select className="mt-1.5 w-full" options={["همه استایل‌ها", ...vibes]} value={vibeFilter || "همه استایل‌ها"} onChange={(v) => setVibeFilter(v === "همه استایل‌ها" ? "" : v)}/></label>}
            {attributes.length > 0 && <label className="text-xs font-bold">ویژگی پویا<Select className="mt-1.5 w-full" options={["همه ویژگی‌ها", ...attributes]} value={attributeFilter || "همه ویژگی‌ها"} onChange={(v) => setAttributeFilter(v === "همه ویژگی‌ها" ? "" : v)}/></label>}
            <label className="text-xs font-bold">حداقل امتیاز<Select className="mt-1.5 w-full" options={["هر امتیازی", "3.5", "4", "4.5"]} value={ratingFilter || "هر امتیازی"} onChange={(v) => setRatingFilter(v === "هر امتیازی" ? "" : v)}/></label>
            <label className="text-xs font-bold">رنگ<Select className="mt-1.5 w-full" options={["همه رنگ‌ها", ...filterColors.map((c) => `${c.name} (${fmtNum(retailProducts.filter((p) => p.colors.some((x) => x.id === c.id)).length)})`)]} value={filterColors.find((c) => c.id === colorFilter)?.name ? `${filterColors.find((c) => c.id === colorFilter)!.name} (${fmtNum(retailProducts.filter((p) => p.colors.some((x) => x.id === colorFilter)).length)})` : "همه رنگ‌ها"} onChange={(v) => setColorFilter(filterColors.find((c) => v.startsWith(c.name))?.id ?? "")}/></label>
            <label className="text-xs font-bold">سایز<Select className="mt-1.5 w-full" options={["همه سایزها", ...filterSizes.map((s) => `${s} (${fmtNum(retailProducts.filter((p) => p.series.some((x) => Object.keys(x.composition).includes(s))).length)})`)]} value={sizeFilter ? `${sizeFilter} (${fmtNum(retailProducts.filter((p) => p.series.some((x) => Object.keys(x.composition).includes(sizeFilter))).length)})` : "همه سایزها"} onChange={(v) => setSizeFilter(filterSizes.find((s) => v.startsWith(`${s} (`) || v === s) ?? "")}/></label>
            <label className="text-xs font-bold">حداکثر قیمت (تومان)<input inputMode="numeric" type="number" min="0" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} placeholder="بدون محدودیت" className="mt-1.5 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 text-sm"/></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={stockOnly} onChange={(e) => setStockOnly(e.target.checked)} className="accent-[#1B2A4A]"/>فقط موجود</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={discountOnly} onChange={(e) => setDiscountOnly(e.target.checked)} className="accent-[#1B2A4A]"/>فقط تخفیف‌دار</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={installmentOnly} onChange={(e) => setInstallmentOnly(e.target.checked)} className="accent-[#1B2A4A]"/>قابل خرید اقساطی</label>
            <button className="text-right text-xs font-bold text-[var(--kv-accent)]" onClick={() => { setBrandFilter(""); setGenderFilter(""); setSeasonFilter(""); setVibeFilter(""); setAttributeFilter(""); setRatingFilter(""); setDiscountOnly(false); setColorFilter(""); setSizeFilter(""); setStockOnly(false); setInstallmentOnly(false); setMaxPrice(""); }}>پاک‌کردن فیلترها</button>
          </div>
        </details>
        {(q || cat !== "همه" || brandFilter || genderFilter || seasonFilter || vibeFilter || attributeFilter || ratingFilter || discountOnly || colorFilter || sizeFilter || stockOnly || installmentOnly || maxPrice) && <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="فیلترهای فعال">{[
          ...(q ? [[`جست‌وجو: ${q}`, () => setQ("") ] as const] : []), ...(cat !== "همه" ? [[cat, () => setCat("همه")] as const] : []), ...(brandFilter ? [[brandFilter, () => setBrandFilter("")] as const] : []), ...(genderFilter ? [[genderFilter, () => setGenderFilter("")] as const] : []), ...(seasonFilter ? [[seasonFilter, () => setSeasonFilter("")] as const] : []), ...(vibeFilter ? [[vibeFilter, () => setVibeFilter("")] as const] : []), ...(attributeFilter ? [[attributeFilter.split(":").slice(1).join(":"), () => setAttributeFilter("")] as const] : []), ...(ratingFilter ? [[`امتیاز ${ratingFilter}+`, () => setRatingFilter("")] as const] : []), ...(discountOnly ? [["تخفیف‌دار", () => setDiscountOnly(false)] as const] : []), ...(colorFilter ? [[filterColors.find((c) => c.id === colorFilter)?.name || colorFilter, () => setColorFilter("")] as const] : []), ...(sizeFilter ? [[`سایز ${sizeFilter}`, () => setSizeFilter("")] as const] : []), ...(stockOnly ? [["موجود", () => setStockOnly(false)] as const] : []), ...(installmentOnly ? [["اقساطی", () => setInstallmentOnly(false)] as const] : []), ...(maxPrice ? [[`تا ${fmtNum(Number(maxPrice))} تومان`, () => setMaxPrice("")] as const] : [])
        ].map(([label, remove]) => <button key={label} onClick={remove} className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-xs font-bold">{label} ×</button>)}</div>}
        {q.trim() && filtered.length > 0 && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--kv-muted)]"><span>پیشنهادهای جست‌وجو:</span>{filtered.slice(0, 4).map((p) => <button key={p.id} className="rounded-full border border-[var(--kv-line)] px-2.5 py-1" onClick={() => setSelectedId(p.id)}>{p.name}</button>)}</div>}
        {filtered.length === 0 ? (
          <div className="mt-8"><Empty title="محصولی پیدا نشد" desc="عبارت دیگری را امتحان کنید یا فیلترها را بردارید." action={<Btn variant="soft" size="sm" onClick={() => { setQ(""); setCat("همه"); }}>حذف فیلترها</Btn>} /></div>
        ) : (
          <div className="mt-7 grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-3 lg:grid-cols-4">
            {filtered.map((p) => <RetailCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />)}
          </div>
        )}
      </div>
    );
  }

  /* ----- HOME ----- */
  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-12 px-4 pb-20 pt-6 md:px-8">
      <HeroRenderer h={ops.hero} onNav={cmsNav} />
      {ops.blocks.filter((b) => b.enabled && b.type !== "announcement").map((b) => <BlockRenderer key={b.id} block={b} onNav={cmsNav} products={retailProducts} onOpenProduct={setSelectedId} />)}

      {/* curated collections */}
      <section>
        <SectionHead title="کالکشن‌های ویژه" desc="دسته‌بندی‌های منتخب فصل؛ هر کدام با وسواس از میان صدها مدل انتخاب شده‌اند." action={<Btn variant="ghost" size="sm" onClick={() => setView("shop")} icon={<ArrowLeft size={15} />}>همه محصولات</Btn>} />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {COLLECTIONS.map((c) => (
            <button key={c.name} onClick={() => { setCat(c.name === "بارانی و مانتو" ? "مانتو و بارانی" : c.name === "پیراهن‌ها" ? "پیراهن" : c.name === "کت و بلیزر" ? "کت و بلیزر" : "شومیز"); setView("shop"); }} className="kv-card-hover group relative overflow-hidden rounded-[18px] border border-[var(--kv-line)] text-right">
              <div className="kv-img aspect-[4/5]"><img src={c.img} alt={c.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" /></div>
              <div className="absolute inset-0 bg-gradient-to-t from-[#0E1527]/70 via-transparent to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-4 text-[#FAF6EF]">
                <p className="text-[15px] font-extrabold">{c.name}</p>
                <p className="mt-0.5 text-xs opacity-80">{fmtNum(c.count)} مدل</p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* new arrivals */}
      <section>
        <SectionHead title="تازه‌رسیده‌ها" desc="جدیدترین مدل‌هایی که همین هفته به فروشگاه اضافه شدند." action={<Btn variant="ghost" size="sm" onClick={() => setView("shop")} icon={<ArrowLeft size={15} />}>مشاهده همه</Btn>} />
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-4">
          {retailProducts.slice(0, 4).map((p) => <RetailCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />)}
        </div>
      </section>

      {/* editorial story */}
      <section className="grid overflow-hidden rounded-[24px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-md md:grid-cols-2">
        <div className="kv-img relative min-h-[280px]"><img src={IMG.atelierCut} alt="کارگاه کلبه" className="absolute inset-0 h-full w-full object-cover" /></div>
        <div className="flex flex-col justify-center p-8 md:p-12">
          <p className="text-[13px] font-bold text-[var(--kv-accent)]">هنر ساخت</p>
          <h2 className="kv-editorial-title mt-2 text-[24px] md:text-[30px]">از پارچه تا پوشاک، زیر یک سقف</h2>
          <p className="mt-3 text-sm leading-8 text-[var(--kv-muted)]">هر لباس کلبه مسیر مشخصی را طی می‌کند: انتخاب پارچه از بافندگان معتبر، برش دقیق، دوخت تمیز و کنترل کیفیت سه‌مرحله‌ای. نتیجه، لباسی است که سال‌ها می‌ماند.</p>
          <div className="mt-6 flex gap-3">
            <Btn variant="dark" onClick={() => setView("journal")}>داستان ما</Btn>
            <Btn variant="soft" onClick={() => onStudio("tryon")} icon={<Eye size={16} />}>پرو مجازی</Btn>
          </div>
        </div>
      </section>

      {/* featured */}
      <section>
        <SectionHead title="منتخب هفته" action={<Btn variant="ghost" size="sm" onClick={() => setView("shop")} icon={<ArrowLeft size={15} />}>مشاهده همه</Btn>} />
        <div className="grid grid-cols-2 gap-x-5 gap-y-8 md:grid-cols-4">
          {retailProducts.slice(4, 8).map((p) => <RetailCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />)}
        </div>
      </section>

      {/* style inspiration */}
      <section className="rounded-[24px] border border-[var(--kv-line)] bg-[#1B2A4A] p-8 text-[#F5EFE3] md:p-12 dark:bg-[#16203A]">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[13px] font-bold text-[#E8D9C3]">استایل‌بیلدر کلبه</p>
            <h2 className="kv-editorial-title mt-2 text-[24px] md:text-[30px]">ست خودت را بچین، بعد بخر</h2>
            <p className="mt-2 max-w-[52ch] text-sm leading-7 text-[#B9C4D8]">محصولات را روی بوم بکش، ترکیب کن و استایل نهایی را ذخیره یا منتشر کن.</p>
          </div>
          <Btn variant="accent" size="lg" onClick={() => onStudio("builder")} icon={<Sparkles size={17} />}>شروع استایل‌سازی</Btn>
        </div>
        <div className="mt-7 grid grid-cols-3 gap-3 md:gap-4">
          {[IMG.trenchArch, IMG.blazerDuo, IMG.whiteShirts].map((im, i) => (
            <div key={i} className="overflow-hidden rounded-[16px]"><img src={im} alt="" className="aspect-[4/3] w-full object-cover" /></div>
          ))}
        </div>
      </section>

      {/* journal preview */}
      <section>
        <SectionHead title="از مجله کلبه" action={<Btn variant="ghost" size="sm" onClick={() => setView("journal")} icon={<ArrowLeft size={15} />}>همه مطالب</Btn>} />
        <div className="grid gap-5 md:grid-cols-3">
          {JOURNAL.map((j) => (
            <article key={j.id} className="kv-card-hover overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm">
              <div className="kv-img aspect-[16/10] overflow-hidden"><img src={j.img} alt={j.title} loading="lazy" className="h-full w-full object-cover" /></div>
              <div className="p-5">
                <p className="text-xs font-bold text-[var(--kv-accent)]">{j.cat} · {j.read}</p>
                <h3 className="mt-2 text-[15px] font-bold leading-7">{j.title}</h3>
              </div>
            </article>
          ))}
        </div>
      </section>

    </div>
  );
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[\u064B-\u065F\u0670]/g, "").replace(/\s+/g, " ").trim();
}
function fuzzyMatch(query: string, field: string) {
  const q = normalizeSearch(query);
  if (q.length < 3) return false;
  return field.split(/[\s،,/_-]+/).some((word) => word.length >= 3 && editDistance(q, word) <= Math.max(1, Math.floor(q.length * 0.22)));
}
function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old; }
  }
  return row[b.length];
}
function relevanceScore(product: Product, term: string) {
  const q = normalizeSearch(term); const name = normalizeSearch(product.name); const sku = normalizeSearch(product.sku); const brand = normalizeSearch(product.brand);
  return (name === q ? 100 : name.startsWith(q) ? 60 : name.includes(q) ? 40 : 0) + (sku === q ? 50 : sku.includes(q) ? 25 : 0) + (brand.includes(q) ? 15 : 0) + Math.min(product.reviews, 100) / 100;
}
