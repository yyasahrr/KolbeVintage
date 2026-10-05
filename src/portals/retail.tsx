import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Truck, Check, Minus, Plus, Trash2, CreditCard, MapPin, SlidersHorizontal,
} from "lucide-react";
import { IMG, JOURNAL, fmtMoney, fmtNum, type Product } from "../data/catalog";
import { digitsOnly, type CustomerAccount, type CustomerAddress } from "../data/customer";
import type { Buyer } from "../data/platform";
import { useStore } from "../data/store";
import AccountExperience, { type AccountTab } from "./account";
import { useOps } from "../data/ops";
import { BlockRenderer, type NavTarget } from "../components/cms-render";
import { Btn, Card, Empty, Field, Input, SearchBox, Select } from "../components/primitives";
import EditorialHero from "../components/storefront/EditorialHero";
import ProductDetail from "../components/storefront/ProductDetail";
import StorefrontProductCard from "../components/storefront/StorefrontProductCard";
import FilterSheet from "../components/storefront/FilterSheet";
import { CategoryRail } from "../components/storefront/CategoryCircles";
import { cn } from "../utils/cn";

export type CartLine = { id: string; qty: number; size: string; color: string };
/** Navigation seed handed down by the storefront shell (search / category medallions). */
export type ShopSeed = { cat?: string; q?: string; nonce: number } | null;

/* Editorial section head — hairline rule + Latin index, no card chrome. */
function Section({ title, latin, desc, action }: { title: string; latin?: string; desc?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        {latin && <p className="kvaf-rule max-w-[20rem]"><span className="shrink-0">{latin}</span></p>}
        <h2 className="kvaf-h2 mt-3 text-[var(--kvaf-ink)]">{title}</h2>
        {desc && <p className="kvaf-body mt-2.5 max-w-[58ch] text-[13.5px] text-[var(--kvaf-muted)]">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

const LinkToShop = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className="kv-sf-press inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-bold text-[var(--kvaf-ink)] hover:text-[var(--kvaf-brass-deep)]">
    {children}<ArrowLeft size={15} />
  </button>
);

const ProductGrid = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-start gap-x-3 gap-y-6 sm:gap-x-4 md:gap-x-5 md:gap-y-7 lg:grid-cols-3 xl:grid-cols-4">{children}</div>
);

/* ============ MAIN RETAIL ============ */
export type RetailView = "home" | "shop" | "checkout" | "journal" | "wishlist" | "account" | "success";

export default function RetailExperience({ selectedId, setSelectedId, cart, setCart, wishlist, toggleWish, onStudio, view, setView, requireLogin, account, buyer, accountTab, setAccountTab, onWholesale, onLogout, onLogin, shopSeed, categories = [] }: {
  selectedId: string | null; setSelectedId: (id: string | null) => void;
  cart: CartLine[]; setCart: (c: CartLine[]) => void;
  wishlist: string[]; toggleWish: (id: string) => void;
  onStudio: (tab: string) => void;
  view: RetailView; setView: (v: RetailView) => void;
  requireLogin?: () => boolean;
  account: CustomerAccount | null; buyer?: Buyer;
  accountTab: AccountTab; setAccountTab: (v: AccountTab) => void;
  onWholesale: () => void; onLogout: () => void; onLogin: () => void;
  shopSeed?: ShopSeed;
  categories?: { name: string; count: number; image: string }[];
}) {
  useEffect(() => { window.scrollTo({ top: 0 }); }, [view, selectedId]);
  /* the shell hands over a category or query picked from search / category medallions */
  useEffect(() => {
    if (!shopSeed) return;
    if (shopSeed.cat !== undefined) setCat(shopSeed.cat);
    if (shopSeed.q !== undefined) setQ(shopSeed.q);
  }, [shopSeed]);
  const [cat, setCat] = useState("همه");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("پیشنهاد کلبه");
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  const selected = useMemo(() => retailProducts.find((p) => p.id === selectedId) ?? null, [selectedId, retailProducts]);

  const filtered = useMemo(() => {
    let list = [...retailProducts];
    if (cat !== "همه") list = list.filter((p) => p.category === cat);
    if (q.trim()) list = list.filter((p) => p.name.includes(q.trim()) || p.supplier.includes(q.trim()));
    if (sort === "ارزان‌ترین") list.sort((a, b) => a.retailPrice - b.retailPrice);
    if (sort === "گران‌ترین") list.sort((a, b) => b.retailPrice - a.retailPrice);
    if (sort === "پربازدیدترین") list.sort((a, b) => b.reviews - a.reviews);
    return list;
  }, [cat, q, sort, retailProducts]);

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
    setPlacedOrderId(orderId);
    setCheckStep(0);
    setView("success");
  };

  /* ----- PDP overlay ----- */
  if (selected) {
    const related = retailProducts.filter((p) => p.id !== selected.id && p.category === selected.category);
    const relatedList = (related.length ? related : retailProducts.filter((p) => p.id !== selected.id)).slice(0, 4);
    return (
      <div className="kv-sf-bottom pb-20">
        <ProductDetail
          p={selected} wished={wishlist.includes(selected.id)}
          onWish={() => toggleWish(selected.id)}
          onBack={() => setSelectedId(null)}
          onAdd={(size, color) => addToCart(selected.id, size, color)}
        />
        <div className="kv-sf-shell mt-20">
          <Section title="شاید بپسندید" latin="You may also like" />
          <ProductGrid>
            {relatedList.map((p) => (
              <StorefrontProductCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />
            ))}
          </ProductGrid>
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
                        <img src={p.images[0]} alt={p.name} className="h-24 w-20 shrink-0 rounded-[10px] object-cover" />
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
      <div className="kv-sf-shell pb-20">
        <Section title="علاقه‌مندی‌ها" latin="Saved" desc="چیزهایی که چشم‌تان را گرفته؛ هر وقت آماده بودید به سبد اضافه کنید." />
        {items.length === 0 ? <Empty title="هنوز چیزی ذخیره نکرده‌اید" desc="روی قلب هر محصول بزنید تا اینجا ذخیره شود." action={<Btn variant="accent" size="sm" onClick={() => setView("shop")}>کشف محصولات</Btn>} /> : (
          <ProductGrid>{items.map((p) => <StorefrontProductCard key={p.id} p={p} wished onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />)}</ProductGrid>
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
      <div className="kv-sf-shell pb-20">
        <Section title="مجله کلبه" latin="Journal" desc="درباره استایل، پارچه و آدم‌هایی که لباس‌های شما را می‌دوزند." />
        <div className="grid gap-x-6 gap-y-12 md:grid-cols-3">
          {JOURNAL.map((j) => (
            <article key={j.id} className="group">
              <div className="overflow-hidden rounded-[18px] bg-[var(--kvaf-sand)]">
                <img src={j.img} alt={j.title} loading="lazy" className="aspect-[4/5] w-full object-cover transition-transform duration-[620ms] ease-[var(--kvaf-ease-out)] group-hover:scale-[1.04]" />
              </div>
              <p className="mt-4 text-[11.5px] font-bold text-[var(--kvaf-muted)]">{j.cat} · {j.read}</p>
              <h3 className="mt-1.5 text-[16px] font-bold leading-8 text-[var(--kvaf-ink)]">{j.title}</h3>
              <button className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--kvaf-ink)]">
                خواندن<ArrowLeft size={14} />
              </button>
            </article>
          ))}
        </div>
      </div>
    );
  }

  /* ----- SHOP ----- */
  if (view === "shop") {
    const sorts = ["پیشنهاد کلبه", "ارزان‌ترین", "گران‌ترین", "پربازدیدترین"];
    return (
      <div className="kv-sf-shell pb-24">
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div>
            <p className="kvaf-rule max-w-[16rem]"><span className="shrink-0">Archive</span></p>
            <h1 className="kvaf-h1 mt-3 text-[var(--kvaf-ink)]">فروشگاه</h1>
            <p className="kvaf-num mt-2 text-[13px] text-[var(--kvaf-muted)]">
              {fmtNum(filtered.length)} محصول{cat !== "همه" ? ` در ${cat}` : ""} · ارسال به سراسر کشور
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="hidden w-60 md:block">
              <SearchBox value={q} onChange={setQ} placeholder="جست‌وجوی محصول، برند…" />
            </div>
            <div className="hidden w-44 md:block">
              <Select options={sorts} value={sort} onChange={setSort} />
            </div>
            <button onClick={() => setFiltersOpen(true)} className="kv-sf-chip md:hidden">
              <SlidersHorizontal size={14} /> فیلتر و مرتب‌سازی
            </button>
          </div>
        </header>

        <div className="kv-sf-scrollx mt-7 hidden md:flex">
          {cats.map((c) => (
            <button key={c} onClick={() => setCat(c)} data-on={cat === c ? "true" : "false"} aria-pressed={cat === c} className="kv-sf-chip">
              {c}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="mt-10">
            <Empty
              title="محصولی پیدا نشد" desc="عبارت دیگری را امتحان کنید یا فیلترها را بردارید."
              action={<Btn variant="soft" size="sm" onClick={() => { setQ(""); setCat("همه"); }}>حذف فیلترها</Btn>}
            />
          </div>
        ) : (
          <div className="mt-10">
            <ProductGrid>
              {filtered.map((p) => (
                <StorefrontProductCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />
              ))}
            </ProductGrid>
          </div>
        )}

        <FilterSheet
          open={filtersOpen} onClose={() => setFiltersOpen(false)}
          categories={cats} category={cat} onCategory={setCat}
          sortOptions={sorts} sort={sort} onSort={setSort}
          resultCount={filtered.length}
          onReset={() => { setQ(""); setCat("همه"); setSort("پیشنهاد کلبه"); }}
        />
      </div>
    );
  }

  /* ----- HOME ----- */
  const latestDrop = [
    ...retailProducts.filter((p) => p.badge === "جدید"),
    ...retailProducts.filter((p) => p.badge !== "جدید"),
  ].slice(0, 4);
  const featured = retailProducts.filter((p) => !latestDrop.includes(p)).slice(0, 4);

  return (
    <div>
      <EditorialHero h={ops.hero} onNav={cmsNav} />

      {/* circular categories — real catalogue data, swipe rail on touch */}
      <section className="kv-sf-shell pt-14 md:pt-20">
        <Section title="از کدام قفسه شروع کنیم؟" latin="Categories" desc="هر دایره یک دسته از آرشیو کلبه است؛ تصویرها از خود محصولات انتخاب شده‌اند." />
        <CategoryRail
          items={categories}
          onPick={(name) => { setCat(name); setView("shop"); window.scrollTo({ top: 0 }); }}
        />
      </section>

      {/* latest drop */}
      <section className="kv-sf-shell pt-16 md:pt-24">
        <Section
          title="تازه‌رسیده‌ها" latin="Latest drop"
          desc="جدیدترین مدل‌هایی که همین هفته به آرشیو اضافه شدند."
          action={<LinkToShop onClick={() => setView("shop")}>مشاهده همه</LinkToShop>}
        />
        <ProductGrid>
          {latestDrop.map((p) => (
            <StorefrontProductCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />
          ))}
        </ProductGrid>
      </section>

      {/* CMS-driven editorial content */}
      {ops.blocks.filter((b) => b.enabled && b.type !== "announcement").length > 0 && (
        <section className="kv-sf-shell space-y-14 pt-16 md:pt-24">
          {ops.blocks.filter((b) => b.enabled && b.type !== "announcement").map((b) => (
            <BlockRenderer key={b.id} block={b} onNav={cmsNav} products={retailProducts} onOpenProduct={setSelectedId} />
          ))}
        </section>
      )}

      {/* editorial story */}
      <section className="pt-16 md:pt-24">
        <div className="grid gap-0 md:grid-cols-2">
          <div className="relative min-h-[320px] overflow-hidden bg-[var(--kvaf-sand)] md:min-h-[560px]">
            <img src={IMG.atelierCut} alt="کارگاه دوخت کلبه" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
          </div>
          <div className="flex flex-col justify-center bg-[var(--kvaf-surface)] px-6 py-12 md:px-14 md:py-20">
            <p className="kvaf-rule max-w-[16rem]"><span className="shrink-0">The making</span></p>
            <h2 className="kvaf-h2 mt-4 text-[var(--kvaf-ink)]">از پارچه تا پوشاک، زیر یک سقف</h2>
            <p className="kvaf-body mt-4 max-w-[46ch] text-[14px] text-[var(--kvaf-muted)]">
              هر لباس کلبه مسیر مشخصی را طی می‌کند: انتخاب پارچه از بافندگان معتبر، برش دقیق،
              دوخت تمیز و کنترل کیفیت سه‌مرحله‌ای. نتیجه، لباسی است که سال‌ها می‌ماند.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button onClick={() => setView("journal")} className="kv-sf-action">داستان ما</button>
              <button onClick={() => onStudio("tryon")} className="kv-sf-action kv-sf-action-quiet">پرو مجازی</button>
            </div>
          </div>
        </div>
      </section>

      {/* featured */}
      <section className="kv-sf-shell pt-16 md:pt-24">
        <Section
          title="منتخب هفته" latin="Selected"
          action={<LinkToShop onClick={() => setView("shop")}>مشاهده همه</LinkToShop>}
        />
        <ProductGrid>
          {featured.map((p) => (
            <StorefrontProductCard key={p.id} p={p} wished={wishlist.includes(p.id)} onWish={() => toggleWish(p.id)} onOpen={() => setSelectedId(p.id)} onAdd={quickAdd(p)} />
          ))}
        </ProductGrid>
      </section>

      {/* service information — from the live shipping configuration */}
      <section className="kv-sf-shell pt-16 md:pt-24">
        <div className="kv-sf-hairline grid gap-x-8 gap-y-6 pt-8 md:grid-cols-4">
          {retailShipping.slice(0, 3).map((m) => (
            <div key={m.id}>
              <p className="text-[13.5px] font-extrabold text-[var(--kvaf-ink)]">{m.name}</p>
              <p className="mt-1.5 text-[12.5px] leading-6 text-[var(--kvaf-muted)]">
                {m.eta} · {m.zones}
                {m.freeAbove !== null && ` · رایگان بالای ${fmtMoney(m.freeAbove)}`}
              </p>
            </div>
          ))}
          <div>
            <p className="text-[13.5px] font-extrabold text-[var(--kvaf-ink)]">ضمانت اصالت و برگشت</p>
            <p className="mt-1.5 text-[12.5px] leading-6 text-[var(--kvaf-muted)]">
              کنترل کیفیت سه‌مرحله‌ای و ۷ روز مهلت برگشت بدون قید و شرط.
            </p>
          </div>
        </div>
      </section>

      {/* journal */}
      <section className="kv-sf-shell pt-16 pb-24 md:pt-24">
        <Section
          title="از مجله کلبه" latin="Journal"
          action={<LinkToShop onClick={() => setView("journal")}>همه مطالب</LinkToShop>}
        />
        <div className="grid gap-x-6 gap-y-10 md:grid-cols-3">
          {JOURNAL.map((j) => (
            <button key={j.id} onClick={() => setView("journal")} className="group text-start">
              <div className="overflow-hidden rounded-[18px] bg-[var(--kvaf-sand)]">
                <img src={j.img} alt={j.title} loading="lazy" className="aspect-[4/5] w-full object-cover transition-transform duration-[620ms] ease-[var(--kvaf-ease-out)] group-hover:scale-[1.04]" />
              </div>
              <p className="mt-4 text-[11.5px] font-bold text-[var(--kvaf-muted)]">{j.cat} · {j.read}</p>
              <h3 className="mt-1.5 text-[15.5px] font-bold leading-7 text-[var(--kvaf-ink)]">{j.title}</h3>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
