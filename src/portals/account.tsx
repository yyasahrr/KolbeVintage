import { useEffect, useState } from "react";
import {
  ArrowLeft, Bell, CircleHelp, Crown, Heart, Home, LogOut, ShieldCheck,
  MapPin, Package, Pencil, Plus, ShoppingBag, Sparkles,
  Trash2, User,
} from "lucide-react";
import { PRODUCTS, fmtMoney, fmtNum } from "../data/catalog";
import { digitsOnly, type CustomerAccount, type CustomerAddress } from "../data/customer";
import { ORDER_STATUS_FA } from "../data/fa-labels";
import { type Buyer } from "../data/platform";
import { useStore } from "../data/store";
import { TicketCenter } from "../components/support";
import { useOps, RETURN_STATUS } from "../data/ops";
import { Btn, Drawer, Empty, Field, Input, Status, Switch, Textarea } from "../components/primitives";
import { WishlistPanel } from "../components/wishlist-panel";
import { CustomerAddressesPanel } from "../components/customer-addresses";
import { CustomerOrdersPanel } from "../components/customer-orders-panel";
import { SecurityCenter as CustomerSecurityCenter } from "../components/security-center";
import { cn } from "../utils/cn";
import { addressesApi, authApi, membershipApi, ordersApi, returnsApi, wishlistApi } from "../data/api";
import { CashbackWalletView, CouponWallet, CustomerTimelineView, DashboardOverview, InvoiceCenter, ProfileCenter, ReviewCenter, SavedStylesCenter, SecurityCenter } from "./account-center";
import { Coins, FileText, Gift, History, Star } from "lucide-react";

export type AccountTab = "overview" | "orders" | "wholesale" | "wishlist" | "addresses" | "styles" | "membership" | "support" | "notifications" | "profile"
  | "coupons" | "reviews" | "invoices" | "security" | "timeline" | "wallet";

const emptyAddress = (account: CustomerAccount): CustomerAddress => ({
  id: "", title: "خانه", recipient: account.name === "مشتری کلبه" ? "" : account.name,
  phone: account.phone, province: "", city: "", line: "", postalCode: "", isDefault: false,
});

export default function AccountExperience({
  account, buyer, tab, setTab, onShop, onWholesale, onOpenProduct, onCheckout, onStudio, onLogout, cartCount = 0, onAddItems,
}: {
  cartCount?: number;
  onAddItems?: (lines: { id: string; size: string; color: string }[]) => void;
  account: CustomerAccount;
  buyer?: Buyer;
  tab: AccountTab;
  setTab: (v: AccountTab) => void;
  onShop: () => void;
  onWholesale: () => void;
  onOpenProduct: (id: string) => void;
  onCheckout: () => void;
  onStudio: () => void;
  onLogout: () => void;
}) {
  const store = useStore();
  const ops = useOps();
  const restrict = ops.restrictionFor("customer", account.id);
  const [profile, setProfile] = useState({ name: account.name, email: account.email, birthday: account.birthday });
  const [serverPrefs, setServerPrefs] = useState<Record<string, boolean> | null>(null);
  const [editingAddress, setEditingAddress] = useState<CustomerAddress | null>(null);
  const [addressError, setAddressError] = useState("");
  const [returnOrder, setReturnOrder] = useState<string | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [business, setBusiness] = useState({ name: "", city: "", tradeCode: "", planId: "silver" });
  const [feedback, setFeedback] = useState("");
  const flash = (text: string) => { setFeedback(text); window.setTimeout(() => setFeedback(""), 3500); };

  // Server-backed data: addresses, wishlist, orders, returns, profile
  const [serverAddresses, setServerAddresses] = useState<CustomerAddress[] | null>(null);
  const [serverWishlistIds, setServerWishlistIds] = useState<string[] | null>(null);
  const [serverOrders, setServerOrders] = useState<any[] | null>(null);
  const [serverReturns, setServerReturns] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const [me, addrs, wish, orders, rets] = await Promise.all([
          authApi.me().catch(() => null),
          addressesApi.list().catch(() => ({ items: [] })),
          // wishlist: collect all item productIds across collections
          wishlistApi.collections().catch(() => ({ items: [] })),
          ordersApi.list().catch(() => ({ items: [] })),
          returnsApi.list().catch(() => ({ items: [] })),
        ]);
        if (cancelled) return;
        if (me?.preferences) setServerPrefs(me.preferences);
        if ((addrs as any).items) setServerAddresses((addrs as any).items.map((a: any) => ({
          id: a.id, title: a.title, recipient: a.recipient, phone: a.phone, province: a.province, city: a.city, line: a.line, postalCode: a.postal_code ?? a.postalCode, isDefault: a.is_default ?? a.isDefault
        })));
        if ((wish as any).items) {
          // For simplicity, flatten wishlist items to productIds (would need items fetch per collection)
          const cols = (wish as any).items as any[];
          // Try to fetch items per collection if available
          let ids: string[] = [];
          for (const c of cols) {
            try {
              const colItems = await wishlistApi.collectionItems(c.id).catch(()=>null);
              if (colItems) ids.push(...(colItems as any).items.map((it:any)=> it.product_id ?? it.productId));
            } catch {}
          }
          // Fallback to account.wishlist if no server items
          setServerWishlistIds(ids.length ? ids : null);
        }
        if ((orders as any).items) setServerOrders((orders as any).items);
        if ((rets as any).items) setServerReturns((rets as any).items);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "خطا در بارگذاری");
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [isDemo, account.id]);

  const prefs: Record<string, boolean> = { ...account.preferences, ...(serverPrefs ?? {}) };
  const togglePreference = async (key: string) => {
    const next = !prefs[key];
    if (isDemo) { store.updateAccount(account.id, { preferences: { ...account.preferences, [key]: next } }); return; }
    const previous = serverPrefs;
    setServerPrefs({ ...prefs, [key]: next });
    try { const res = await authApi.updatePreference(key, next); setServerPrefs(res.preferences); }
    catch (e) { setServerPrefs(previous); setError(e instanceof Error ? e.message : "خطا در ذخیره تنظیمات اعلان"); }
  };
  const effectiveAddresses = serverAddresses ?? account.addresses;
  const effectiveWishlist = serverWishlistIds ?? account.wishlist;
  const effectiveRetailOrders = serverOrders ? serverOrders.filter((o:any)=> o.order_type === 'retail' || o.orderType === 'retail') : store.retailOrders.filter((order) => order.accountId === account.id);
  const effectiveWholesaleOrders = serverOrders ? serverOrders.filter((o:any)=> o.order_type === 'wholesale') : (buyer ? store.orders.filter((order) => order.accountId ? order.accountId === account.id : order.buyer === buyer.name) : []);
  const savedProducts = store.products.filter((p) => effectiveWishlist.includes(p.id));
  const defaultAddress = effectiveAddresses.find((address) => address.isDefault) ?? effectiveAddresses[0];
  const plan = buyer ? store.plans.find((p) => p.id === buyer.planId) : undefined;
  const selectedPlan = store.plans.find((p) => p.id === business.planId && p.active) ?? store.plans.find((p) => p.active);
  const isVip = buyer?.status === "فعال";
  const pending = buyer?.status === "در انتظار تأیید";

  const items: { id: AccountTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "overview", label: "نمای کلی", icon: <Home size={17} /> },
    { id: "orders", label: "سفارش‌های من", icon: <Package size={17} />, count: effectiveRetailOrders.length },
    { id: "wholesale", label: "سفارش‌های عمده", icon: <ShoppingBag size={17} />, count: effectiveWholesaleOrders.length },
    { id: "wishlist", label: "علاقه‌مندی‌ها", icon: <Heart size={17} />, count: savedProducts.length },
    { id: "addresses", label: "نشانی‌ها", icon: <MapPin size={17} /> },
    { id: "styles", label: "استایل‌های ذخیره‌شده", icon: <Sparkles size={17} /> },
    { id: "membership", label: "عضویت عمده", icon: <Crown size={17} /> },
    { id: "support", label: "پشتیبانی", icon: <CircleHelp size={17} /> },
    { id: "wallet", label: "کیف پول کش‌بک", icon: <Coins size={17} /> },
    { id: "coupons", label: "کوپن‌های من", icon: <Gift size={17} /> },
    { id: "reviews", label: "مرکز نظرات", icon: <Star size={17} /> },
    { id: "invoices", label: "فاکتورها", icon: <FileText size={17} /> },
    { id: "timeline", label: "فعالیت‌های من", icon: <History size={17} /> },
    { id: "notifications", label: "اعلان‌ها", icon: <Bell size={17} /> },
    { id: "profile", label: "اطلاعات حساب", icon: <User size={17} /> },
    { id: "security", label: "امنیت حساب", icon: <ShieldCheck size={17} /> },
  ];
  const go = (next: string) => (next === "cart" ? onCheckout() : setTab(next as AccountTab));

  const saveAddress = async () => {
    if (!editingAddress) return;
    if (!editingAddress.recipient.trim() || !editingAddress.city.trim() || !editingAddress.province.trim() || !editingAddress.line.trim()) {
      setAddressError("نام گیرنده، استان، شهر و نشانی کامل را وارد کنید.");
      return;
    }
    if (!/^09\d{9}$/.test(digitsOnly(editingAddress.phone)) || !/^\\d{10}$/.test(digitsOnly(editingAddress.postalCode))) {
      setAddressError("شماره موبایل ۱۱ رقمی و کد پستی ۱۰ رقمی معتبر وارد کنید.");
      return;
    }
    if (isDemo) {
      const address = { ...editingAddress, id: editingAddress.id || `addr-${Date.now()}`, phone: digitsOnly(editingAddress.phone), postalCode: digitsOnly(editingAddress.postalCode), isDefault: editingAddress.isDefault || effectiveAddresses.length === 0 };
      let addresses = effectiveAddresses.some((a) => a.id === address.id) ? effectiveAddresses.map((a) => a.id === address.id ? address : a) : [...effectiveAddresses, address];
      if (address.isDefault) addresses = addresses.map((a) => ({ ...a, isDefault: a.id === address.id }));
      // Demo only: update local store
      store.updateAccount(account.id, { addresses });
      setEditingAddress(null); setAddressError(""); flash("نشانی ذخیره شد. (demo)");
      return;
    }
    try {
      const payload = {
        title: editingAddress.title,
        recipient: editingAddress.recipient.trim(),
        phone: digitsOnly(editingAddress.phone),
        province: editingAddress.province.trim(),
        city: editingAddress.city.trim(),
        line: editingAddress.line.trim(),
        postalCode: digitsOnly(editingAddress.postalCode),
        isDefault: editingAddress.isDefault || effectiveAddresses.length === 0,
      };
      if (editingAddress.id && serverAddresses?.some(a=>a.id===editingAddress.id)) {
        await addressesApi.update(editingAddress.id, payload);
      } else {
        await addressesApi.create(payload);
      }
      const refreshed = await addressesApi.list();
      setServerAddresses((refreshed as any).items.map((a: any) => ({
        id: a.id, title: a.title, recipient: a.recipient, phone: a.phone, province: a.province, city: a.city, line: a.line, postalCode: a.postal_code ?? a.postalCode, isDefault: a.is_default ?? a.isDefault
      })));
      setEditingAddress(null); setAddressError(""); flash("نشانی ذخیره شد.");
    } catch (e) {
      setAddressError(e instanceof Error ? e.message : "خطا در ذخیره نشانی");
    }
  };

  const submitVip = async () => {
    if (!selectedPlan) { flash("در حال حاضر پلن فعالی برای درخواست وجود ندارد."); return; }
    if (!business.name.trim() || !business.city.trim() || !business.tradeCode.trim()) {
      flash("نام کسب‌وکار، شهر و شناسه صنفی را کامل کنید.");
      return;
    }
    if (isDemo) {
      store.requestVip(account.id, { businessName: business.name, city: business.city, tradeCode: business.tradeCode, planId: selectedPlan.id });
      flash("درخواست عضویت عمده در همین حساب ثبت شد و منتظر بررسی کلبه است. (demo)");
      return;
    }
    try {
      await membershipApi.request({ planId: selectedPlan.id, businessName: business.name.trim(), city: business.city.trim(), tradeCode: business.tradeCode.trim() });
      flash("درخواست عضویت عمده ثبت شد و منتظر بررسی کلبه است.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ثبت درخواست");
    }
  };

  const removeWishlist = async (productId: string) => {
    if (isDemo) {
      store.updateAccount(account.id, { wishlist: effectiveWishlist.filter((id) => id !== productId) });
      if (serverWishlistIds) setServerWishlistIds(effectiveWishlist.filter((id)=> id!==productId));
      return;
    }
    try {
      // Find collection containing product
      const cols = await wishlistApi.collections() as any;
      for (const c of cols.items) {
        const items = await wishlistApi.collectionItems(c.id).catch(()=>null);
        const it = (items as any)?.items?.find((x:any)=> (x.product_id ?? x.productId) === productId);
        if (it) { await wishlistApi.removeItem(it.id); break; }
      }
      // Refresh
      const refreshedCols = await wishlistApi.collections() as any;
      let ids: string[] = [];
      for (const c of refreshedCols.items) {
        const itms = await wishlistApi.collectionItems(c.id).catch(()=>null);
        if (itms) ids.push(...(itms as any).items.map((x:any)=> x.product_id ?? x.productId));
      }
      setServerWishlistIds(ids);
      flash("از علاقه‌مندی‌ها حذف شد.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا");
    }
  };

  const deleteAddress = async (addressId: string, isDefault: boolean) => {
    if (isDemo) {
      const remaining = effectiveAddresses.filter((a) => a.id !== addressId);
      store.updateAccount(account.id, { addresses: isDefault && remaining.length ? remaining.map((a, i) => ({ ...a, isDefault: i === 0 })) : remaining });
      flash("نشانی حذف شد. (demo)");
      return;
    }
    try {
      await addressesApi.remove(addressId);
      const refreshed = await addressesApi.list();
      setServerAddresses((refreshed as any).items.map((a: any) => ({
        id: a.id, title: a.title, recipient: a.recipient, phone: a.phone, province: a.province, city: a.city, line: a.line, postalCode: a.postal_code ?? a.postalCode, isDefault: a.is_default ?? a.isDefault
      })));
      flash("نشانی حذف شد.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا");
    }
  };

  const setDefaultAddress = async (addressId: string) => {
    if (isDemo) {
      store.updateAccount(account.id, { addresses: effectiveAddresses.map((a) => ({ ...a, isDefault: a.id === addressId })) });
      flash("نشانی پیش‌فرض تغییر کرد. (demo)");
      return;
    }
    try {
      await addressesApi.update(addressId, { isDefault: true });
      const refreshed = await addressesApi.list();
      setServerAddresses((refreshed as any).items.map((a: any) => ({
        id: a.id, title: a.title, recipient: a.recipient, phone: a.phone, province: a.province, city: a.city, line: a.line, postalCode: a.postal_code ?? a.postalCode, isDefault: a.is_default ?? a.isDefault
      })));
      flash("نشانی پیش‌فرض تغییر کرد.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا");
    }
  };

  const saveProfile = async () => {
    if (!profile.name.trim()) { flash("نام الزامی است."); return; }
    if (isDemo) {
      store.updateAccount(account.id, { name: profile.name.trim(), email: profile.email.trim(), birthday: profile.birthday.trim() });
      flash("اطلاعات حساب ذخیره شد. (demo)");
      return;
    }
    try {
      await authApi.updateProfile({ displayName: profile.name.trim(), email: profile.email.trim() || null, birthday: profile.birthday.trim() || null });
      flash("اطلاعات حساب ذخیره شد.");
    } catch (e) {
      // Fallback to store if API not yet available
      try { store.updateAccount(account.id, { name: profile.name.trim(), email: profile.email.trim(), birthday: profile.birthday.trim() }); } catch {}
      flash(e instanceof Error ? e.message : "خطا در ذخیره");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-8 md:px-8">
      {loading && <div className="mb-4 rounded-[12px] bg-[var(--kv-surface-2)] px-4 py-2 text-xs text-[var(--kv-muted)]">در حال بارگذاری اطلاعات حساب…</div>}
      {error && <div className="mb-4 rounded-[12px] border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error} <button onClick={()=>window.location.reload()} className="underline">تلاش دوباره</button></div>}
      {isDemo && <div className="mb-4 rounded-[12px] border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">DEMO MODE — داده‌ها محلی و نمایشی هستند (?demo=1)</div>}
      <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[var(--kv-muted)]">حساب شخصی کلبه</p>
          <h1 className="kv-editorial-title mt-1 text-[27px] md:text-[34px]">سلام، {account.name}</h1>
          <p className="mt-2 text-[13px] text-[var(--kv-muted)]">یک حساب برای خرید روزمره و خرید عمده. عضویت عمده به همین حساب اضافه می‌شود.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!!account.cart.length && <Btn variant="soft" size="sm" icon={<ShoppingBag size={15} />} onClick={onCheckout}>سبد خرید ({fmtNum(account.cart.length)})</Btn>}
          {isVip ? <span className="inline-flex items-center gap-2 rounded-full bg-[#1B2A4A] px-4 py-2 text-[12.5px] font-bold text-[#E8D9C3]"><Crown size={15} />عضو عمده · {plan?.name}</span> : pending ? <Status value="در انتظار تأیید" /> : <Btn variant="soft" size="sm" icon={<Crown size={15} />} onClick={() => setTab("membership")}>درخواست عضویت عمده</Btn>}
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-7 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <nav aria-label="بخش‌های حساب من" className="kv-no-scrollbar flex gap-1 overflow-x-auto border-b border-[var(--kv-line)] pb-2 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-l lg:pb-0 lg:pl-3">
            {items.map((item) => (
              <button key={item.id} onClick={() => setTab(item.id)} aria-current={tab === item.id ? "page" : undefined}
                className={cn("kv-press flex min-h-10 shrink-0 items-center gap-2.5 rounded-[11px] px-3 py-2 text-right text-[13px] font-semibold whitespace-nowrap transition-colors lg:w-full", tab === item.id ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]")}>
                {item.icon}{item.label}{!!item.count && <span className="mr-auto text-[11px] opacity-65 tabular-nums">{fmtNum(item.count)}</span>}
              </button>
            ))}
            <button onClick={onLogout} className="kv-press hidden min-h-10 items-center gap-2.5 rounded-[11px] px-3 py-2 text-[13px] font-semibold text-[var(--kv-danger)] hover:bg-[var(--kv-danger)]/[0.06] lg:flex"><LogOut size={17} />خروج از حساب</button>
          </nav>
        </aside>

        <div className="min-w-0 animate-[fadeIn_0.25s_ease]" key={tab}>
          {tab === "overview" && !isDemo && <DashboardOverview go={go} onOpenProduct={onOpenProduct} onShop={onShop} onStudio={onStudio} cartCount={cartCount} />}
          {tab === "wallet" && <CashbackWalletView />}
          {tab === "coupons" && <CouponWallet />}
          {tab === "reviews" && <ReviewCenter />}
          {tab === "invoices" && <InvoiceCenter />}
          {tab === "timeline" && <CustomerTimelineView />}
          {tab === "security" && <SecurityCenter onLoggedOut={onLogout} />}
          {tab === "overview" && isDemo && (
            <div className="space-y-9">
              <section>
                <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-[19px] font-extrabold">سفارش‌های اخیر</h2><button onClick={() => setTab("orders")} className="inline-flex items-center gap-1 text-[13px] font-bold text-[var(--kv-accent)]">همه سفارش‌ها <ArrowLeft size={14} /></button></div>
                {effectiveRetailOrders.length ? <div className="divide-y divide-[var(--kv-line)] border-y border-[var(--kv-line)]">{effectiveRetailOrders.slice(0, 2).map((order:any) => (
                  <button key={order.id} onClick={() => { setTab("orders"); }} className="flex w-full flex-wrap items-center gap-4 py-4 text-right hover:text-[var(--kv-accent)]">
                    <img src={order.lines?.[0]?.image ?? order.items?.[0]?.image ?? ""} alt="" className="h-16 w-13 rounded-[10px] object-cover" />
                    <span className="min-w-0 flex-1"><b className="block text-sm tabular-nums">{order.reference ?? order.id}</b><span className="text-[12px] text-[var(--kv-muted)]">{order.created_at ?? order.createdAt} · {fmtNum(order.lines?.reduce((n:any,l:any)=>n+(l.qty??l.quantity),0) ?? 0)} قلم</span></span>
                    <Status value={ORDER_STATUS_FA[String(order.status)] ?? order.status} /><b className="text-sm tabular-nums">{fmtMoney(order.total_rial ?? order.total ?? 0)}</b>
                  </button>
                ))}</div> : <Empty title="هنوز سفارشی ندارید" desc="اولین خرید شما پس از ثبت، همین‌جا دیده می‌شود." action={<Btn variant="accent" size="sm" onClick={onShop}>دیدن فروشگاه</Btn>} />}
              </section>

              <section className="grid gap-5 md:grid-cols-2">
                <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
                  <p className="mb-3 flex items-center gap-2 text-[14px] font-extrabold"><MapPin size={16} className="text-[var(--kv-accent)]" />نشانی پیش‌فرض</p>
                  {defaultAddress ? <><p className="text-[13px] font-semibold">{defaultAddress.title} · {defaultAddress.recipient}</p><p className="mt-1 text-[12.5px] leading-6 text-[var(--kv-muted)]">{defaultAddress.province}، {defaultAddress.city}، {defaultAddress.line}</p></> : <p className="text-[13px] leading-6 text-[var(--kv-muted)]">برای خرید آسان‌تر یک نشانی اضافه کنید.</p>}
                  <button onClick={() => setTab("addresses")} className="mt-4 text-[12.5px] font-bold text-[var(--kv-accent)]">مدیریت نشانی‌ها</button>
                </div>
                <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
                  <p className="mb-3 flex items-center gap-2 text-[14px] font-extrabold"><Crown size={16} className="text-[var(--kv-accent)]" />عضویت عمده</p>
                  <p className="text-[13px] font-semibold">{isVip ? `پلن ${plan?.name} فعال است` : pending ? "درخواست شما در حال بررسی است" : "عضویت عمده ندارید"}</p>
                  <p className="mt-1 text-[12.5px] leading-6 text-[var(--kv-muted)]">{isVip ? "قیمت‌های عمده و سفارش‌های سری در همین حساب در دسترس‌اند." : pending ? "بعد از تأیید کلبه، بدون ورود دوباره قیمت‌های عمده فعال می‌شوند." : "همین حساب را به حساب خرید عمده ارتقا دهید؛ ورود جدیدی لازم نیست."}</p>
                  <button onClick={() => setTab("membership")} className="mt-4 text-[12.5px] font-bold text-[var(--kv-accent)]">{isVip ? "جزئیات عضویت" : "پیگیری یا درخواست عضویت"}</button>
                </div>
              </section>

              <section>
                <div className="mb-4 flex items-center justify-between"><h2 className="text-[19px] font-extrabold">انتخاب‌های شما</h2><button onClick={() => setTab("wishlist")} className="text-[13px] font-bold text-[var(--kv-accent)]">علاقه‌مندی‌ها</button></div>
                {savedProducts.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{savedProducts.slice(0, 3).map((p) => <button key={p.id} onClick={() => onOpenProduct(p.id)} className="group text-right"><div className="overflow-hidden rounded-[12px]"><img src={p.images[0]} alt={p.name} className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-105" /></div><p className="mt-2 text-[12.5px] font-bold">{p.name}</p></button>)}</div> : <p className="text-[13px] text-[var(--kv-muted)]">هنوز محصولی ذخیره نکرده‌اید.</p>}
              </section>
            </div>
          )}

          {tab === "orders" && (
            <div className="space-y-6"><div className="rounded-[14px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/5 p-3 text-xs leading-6"><b>سفارش‌های سرور</b> — از PostgreSQL با فاکتور و PDF.</div><CustomerOrdersPanel /></div>
          )}

          {tab === "wholesale" && (
            <section>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-[21px] font-extrabold">سفارش‌های عمده</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">همان حساب مشتری، با خریدهای تجاری مستقل از سفارش خرده.</p></div>{isVip && <Btn variant="soft" size="sm" onClick={onWholesale}>ورود به بازارچه</Btn>}</div>
              {isVip ? effectiveWholesaleOrders.length ? <div className="space-y-3">{effectiveWholesaleOrders.map((order:any) => <div key={order.id} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4"><p className="text-sm font-bold">{order.reference ?? order.id}</p><p className="text-xs text-[var(--kv-muted)]">{order.created_at ?? order.createdAt} · {ORDER_STATUS_FA[String(order.status)] ?? order.status}</p></div>)}</div> : <Empty title="سفارش عمده ندارید" desc="پس از اولین خرید سری از بازارچه، سفارش مادر و زیرسفارش‌ها اینجا دیده می‌شوند." action={<Btn variant="accent" size="sm" onClick={onWholesale}>مشاهده بازارچه عمده</Btn>} />
                : <Empty title={pending ? "درخواست عضویت در حال بررسی است" : "برای خرید عمده، همین حساب را ارتقا دهید"} desc={pending ? "بعد از تأیید کلبه، قیمت‌ها و سفارش‌های عمده همین‌جا فعال می‌شوند." : "حساب جدید لازم نیست؛ عضویت عمده به حساب فعلی شما اضافه می‌شود."} action={<Btn variant="accent" size="sm" onClick={() => setTab("membership")}>{pending ? "پیگیری درخواست" : "درخواست عضویت"}</Btn>} />}
            </section>
          )}

          {tab === "wishlist" && (
            <section><div className="mb-5"><h2 className="text-[21px] font-extrabold">علاقه‌مندی‌ها</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">محصولاتی که نگه داشته‌اید تا بعداً ببینید.</p></div>
              <div className="mb-6 rounded-[14px] border border-[var(--kv-accent)]/30 bg-[var(--kv-accent)]/5 p-3 text-xs leading-6"><b>علاقه‌مندی‌های سرور</b> — چند کالکشن، ذخیره محصول/برند، اعلان قیمت/موجودی.</div>
              <WishlistPanel />
              {savedProducts.length ? <div className="mt-6 divide-y divide-[var(--kv-line)] border-y border-[var(--kv-line)]">{savedProducts.map((p) => <div key={p.id} className="flex items-center gap-4 py-4"><img src={p.images[0]} alt="" className="h-21 w-17 rounded-[10px] object-cover" /><div className="min-w-0 flex-1"><p className="text-[14px] font-bold">{p.name}</p><p className="mt-1 text-[13px] font-semibold tabular-nums">{fmtMoney(p.retailPrice)}</p></div><Btn variant="soft" size="sm" onClick={() => onOpenProduct(p.id)}>دیدن محصول</Btn><button onClick={() => removeWishlist(p.id)} aria-label={`حذف ${p.name} از علاقه‌مندی‌ها`} className="flex h-10 w-10 items-center justify-center text-[var(--kv-muted)] hover:text-[var(--kv-danger)]"><Trash2 size={17} /></button></div>)}</div> : <Empty title="علاقه‌مندی‌ها خالی است" desc="روی قلب محصول بزنید تا برای بعد نگهش دارید." action={<Btn variant="accent" size="sm" onClick={onShop}>دیدن محصولات</Btn>} />}
            </section>
          )}

          {tab === "addresses" && (
            <div className="space-y-6"><CustomerAddressesPanel /><div className="border-t border-[var(--kv-line)] pt-6"><section><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-[21px] font-extrabold">نشانی‌های تحویل</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">در مرحله خرید یکی از نشانی‌ها را انتخاب کنید.</p></div><Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setAddressError(""); setEditingAddress(emptyAddress(account)); }}>افزودن نشانی</Btn></div>
              {effectiveAddresses.length ? <div className="space-y-3">{effectiveAddresses.map((address) => <div key={address.id} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><b className="text-[14px]">{address.title}</b>{address.isDefault && <span className="rounded-full bg-[#E7F0E6] px-2.5 py-1 text-[11px] font-semibold text-[#3E6B4A]">پیش‌فرض</span>}</div><p className="mt-2 text-[13px] font-semibold">{address.recipient} · {address.phone}</p><p className="mt-1 text-[12.5px] leading-6 text-[var(--kv-muted)]">{address.province}، {address.city}، {address.line} · کد پستی {address.postalCode}</p></div><div className="flex gap-1"><button onClick={() => { setAddressError(""); setEditingAddress({ ...address }); }} aria-label={`ویرایش ${address.title}`} className="flex h-10 w-10 items-center justify-center rounded-[9px] hover:bg-[var(--kv-surface-2)]"><Pencil size={16} /></button><button onClick={() => deleteAddress(address.id, !!address.isDefault)} aria-label={`حذف ${address.title}`} className="flex h-10 w-10 items-center justify-center rounded-[9px] text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={16} /></button></div></div>{!address.isDefault && <button onClick={() => setDefaultAddress(address.id)} className="mt-3 text-[12px] font-bold text-[var(--kv-accent)]">انتخاب به‌عنوان پیش‌فرض</button>}</div>)}</div> : <Empty title="نشانی ندارید" desc="برای سریع‌تر شدن خرید، نخستین نشانی تحویل را ثبت کنید." />}
            </section></div></div>
          )}

          {tab === "styles" && !isDemo && <SavedStylesCenter onStudio={onStudio} onAddItems={onAddItems} />}
          {tab === "styles" && isDemo && (
            <section><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-[21px] font-extrabold">استایل‌های ذخیره‌شده</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">ترکیب‌هایی که در بوم استایلِ پرو مجازی ذخیره کرده‌اید.</p></div><Btn variant="soft" size="sm" onClick={onStudio} icon={<Sparkles size={15} />}>ساخت استایل</Btn></div>
              {account.savedStyles.length ? <div className="grid gap-4 sm:grid-cols-2">{account.savedStyles.map((style) => <div key={style.id} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4"><div className="flex gap-1.5">{style.productIds.slice(0, 3).map((id) => { const p = PRODUCTS.find((x) => x.id === id); return p ? <img key={id} src={p.images[0]} alt={p.name} className="aspect-[3/4] min-w-0 flex-1 rounded-[9px] object-cover" /> : null; })}</div><div className="mt-3 flex items-center justify-between gap-2"><div><p className="text-[13.5px] font-bold">{style.title}</p><p className="text-xs text-[var(--kv-muted)]">{style.savedAt} · {fmtNum(style.productIds.length)} محصول</p></div><button onClick={() => { if(isDemo) store.updateAccount(account.id, { savedStyles: account.savedStyles.filter((s) => s.id !== style.id) }); }} aria-label="حذف استایل" className="text-[var(--kv-muted)] hover:text-[var(--kv-danger)]"><Trash2 size={16} /></button></div></div>)}</div> : <Empty title="استایلی ذخیره نشده" desc="از صفحه پرو مجازی وارد بوم استایل شوید و ترکیب دلخواه را ذخیره کنید." action={<Btn variant="accent" size="sm" onClick={onStudio}>رفتن به پرو مجازی</Btn>} />}
            </section>
          )}

          {tab === "membership" && (
            <section><div className="mb-6"><h2 className="text-[21px] font-extrabold">عضویت عمده، در همین حساب</h2><p className="mt-1 max-w-[65ch] text-[13px] leading-7 text-[var(--kv-muted)]">برای دیدن قیمت سری و خرید از بازارچه، عضویت تجاری این حساب بررسی می‌شود؛ ورود یا حساب دوم لازم نیست.</p></div>
              {buyer ? <div className="mb-6 rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[15px] font-extrabold">{buyer.name}</p><p className="mt-1 text-[12.5px] text-[var(--kv-muted)]">پلن انتخاب‌شده: {plan?.name ?? buyer.planId} · شناسه صنفی: {buyer.tradeCode || "ثبت نشده"}</p></div><Status value={buyer.status} /></div><p className="mt-4 text-[13px] leading-7 text-[var(--kv-muted)]">{isVip ? "عضویت عمده فعال است. با همین حساب وارد بازارچه شوید؛ سفارش‌های خرده و عمده جداگانه در پنل شما باقی می‌مانند." : pending ? "درخواست شما برای بررسی به تیم کلبه ارسال شده است. پس از تأیید در پنل مدیریت، قیمت‌های عمده در همین حساب باز می‌شوند." : "حساب تجاری فعلاً فعال نیست. از طریق پشتیبانی پیگیری کنید."}</p>{isVip && <Btn variant="accent" size="sm" className="mt-4" onClick={onWholesale}>ورود به بازارچه عمده</Btn>}</div> : <>
                <div className="grid gap-3 sm:grid-cols-3">{store.plans.filter((p) => p.active).map((p) => <button key={p.id} onClick={() => setBusiness({ ...business, planId: p.id })} className={cn("rounded-[14px] border p-4 text-right transition-colors", selectedPlan?.id === p.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:border-[var(--kv-line-strong)]")}><p className="font-extrabold">{p.name}</p><p className="mt-1 text-[14px] font-bold tabular-nums">{p.yearly === 0 ? "رایگان" : `${fmtMoney(p.yearly)} / سال`}</p><p className="mt-2 text-[11.5px] leading-5 text-[var(--kv-muted)]">{p.features.slice(0, 2).join(" · ")}</p></button>)}</div>
                <div className="mt-5 max-w-[620px] space-y-4 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5"><h3 className="text-[15px] font-extrabold">درخواست عضویت تجاری</h3><div className="grid gap-3 sm:grid-cols-2"><Field label="نام فروشگاه یا کسب‌وکار"><Input value={business.name} onChange={(v) => setBusiness({ ...business, name: v })} placeholder="مثلاً بوتیک آوا" /></Field><Field label="شهر فعالیت"><Input value={business.city} onChange={(v) => setBusiness({ ...business, city: v })} placeholder="مثلاً تهران" /></Field></div><Field label="شناسه صنفی یا شماره جواز" hint="برای بررسی توسط تیم کلبه"><Input value={business.tradeCode} onChange={(v) => setBusiness({ ...business, tradeCode: v })} placeholder="شماره ثبت کسب‌وکار" /></Field><p className="text-[12px] text-[var(--kv-muted)]">شماره تماس حساب: {account.phone} · پلن درخواستی: {selectedPlan?.name ?? "نامشخص"}</p><Btn variant="accent" disabled={!selectedPlan || !business.name.trim() || !business.city.trim() || !business.tradeCode.trim()} onClick={submitVip}>ثبت درخواست در همین حساب</Btn></div>
              </>}
            </section>
          )}

          {tab === "support" && (
            <section><div className="mb-5"><h2 className="text-[21px] font-extrabold">پشتیبانی و تیکت‌ها</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">گفت‌وگو با تیم کلبه؛ پاسخ‌ها همین‌جا نمایش داده می‌شوند.</p></div>
              <TicketCenter perspective="owner" ownerId={account.id} ownerName={account.name} ownerType="customer" />
              <div className="mt-8"><h3 className="mb-3 text-[15px] font-extrabold">درخواست‌های مرجوعی من</h3>{(serverReturns ?? ops.returns.filter((r) => r.ownerId === account.id)).length ? <div className="space-y-2">{(serverReturns ?? ops.returns.filter((r) => r.ownerId === account.id)).map((r:any) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3"><div><p className="text-[13px] font-bold">{r.reference ?? r.id} · سفارش {r.orderId ?? r.order_id}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{r.items ?? r.reason}</p></div><Status value={RETURN_STATUS[r.status as keyof typeof RETURN_STATUS] ?? r.status} /></div>)}</div> : <p className="text-[13px] text-[var(--kv-muted)]">درخواست مرجوعی ندارید.</p>}</div>
            </section>
          )}

          {tab === "notifications" && (
            <section className="max-w-[650px]"><div className="mb-5"><h2 className="text-[21px] font-extrabold">تنظیمات اعلان‌ها</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">مشخص کنید کدام اطلاع‌رسانی‌ها و از چه راهی به شما برسد.</p></div>
              <div className="divide-y divide-[var(--kv-line)] border-y border-[var(--kv-line)]">{([
                ["orderUpdates", "وضعیت سفارش", "ثبت، پرداخت، ارسال و تحویل هر خرید"],
                ["offers", "خبر کالکشن‌ها", "تازه‌رسیده‌ها و پیشنهادهای کلبه"],
                ["sms", "دریافت پیامک", "ارسال اعلان‌ها به شماره ثبت‌شده"],
                ["email", "دریافت ایمیل", "ارسال به نشانی ایمیل حساب شما"],
              ] as const).map(([key, label, desc]) => <div key={key} className="flex items-center justify-between gap-4 py-4"><div><p className="text-[13.5px] font-bold">{label}</p><p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">{desc}</p></div><Switch on={prefs[key] ?? false} onToggle={() => { void togglePreference(key); }} /></div>)}</div>
              <p className="mt-4 text-xs leading-6 text-[var(--kv-muted)]">این تنظیمات در حساب شما ذخیره می‌شوند.</p>
            </section>
          )}

          {tab === "profile" && !isDemo && <ProfileCenter onUpdated={(name) => setProfile((prev) => ({ ...prev, name }))} />}
          {tab === "profile" && isDemo && (
            <section className="max-w-[620px]"><div className="mb-5"><h2 className="text-[21px] font-extrabold">اطلاعات حساب</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">همین اطلاعات برای سفارش‌های خرده و عمده استفاده می‌شوند.</p></div><div className="space-y-4 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5"><Field label="نام و نام خانوادگی"><Input value={profile.name} onChange={(v) => setProfile({ ...profile, name: v })} /></Field><Field label="شماره همراه" hint="برای تغییر شماره همراه باید دوباره احراز هویت شوید."><div className="rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-3 text-[13px] text-[var(--kv-muted)] tabular-nums">{account.phone}</div></Field><Field label="ایمیل"><Input value={profile.email} onChange={(v) => setProfile({ ...profile, email: v })} placeholder="name@example.com" /></Field><Field label="تاریخ تولد (اختیاری)"><Input value={profile.birthday} onChange={(v) => setProfile({ ...profile, birthday: v })} placeholder="۱۴۰۰/۰۱/۰۱" /></Field><Btn variant="accent" size="sm" disabled={!profile.name.trim()} onClick={saveProfile}>ذخیره تغییرات</Btn></div><p className="mt-4 text-[12px] text-[var(--kv-muted)]">عضو کلبه از {account.joinedAt}</p></section>
          )}
          {tab === "security" && (
            <section className="max-w-[900px]">
              <div className="mb-5"><h2 className="text-[21px] font-extrabold">امنیت حساب</h2><p className="mt-1 text-[13px] text-[var(--kv-muted)]">اطلاعات هویتی، نشست‌ها، رمز عبور، ورود دومرحله‌ای و تاریخچه ورود.</p></div>
              <CustomerSecurityCenter flash={flash} />
            </section>
          )}
        </div>
      </div>

      <Drawer open={!!editingAddress} onClose={() => { setEditingAddress(null); setAddressError(""); }} title={editingAddress?.id ? "ویرایش نشانی" : "نشانی جدید"}>
        {editingAddress && <div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><Field label="نام نشانی"><Input value={editingAddress.title} onChange={(v) => setEditingAddress({ ...editingAddress, title: v })} placeholder="خانه یا محل کار" /></Field><Field label="نام گیرنده"><Input value={editingAddress.recipient} onChange={(v) => setEditingAddress({ ...editingAddress, recipient: v })} /></Field><Field label="شماره همراه"><Input value={editingAddress.phone} onChange={(v) => setEditingAddress({ ...editingAddress, phone: v })} /></Field><Field label="کد پستی"><Input value={editingAddress.postalCode} onChange={(v) => setEditingAddress({ ...editingAddress, postalCode: v })} /></Field><Field label="استان"><Input value={editingAddress.province} onChange={(v) => setEditingAddress({ ...editingAddress, province: v })} /></Field><Field label="شهر"><Input value={editingAddress.city} onChange={(v) => setEditingAddress({ ...editingAddress, city: v })} /></Field></div><Field label="نشانی کامل"><Textarea value={editingAddress.line} onChange={(v) => setEditingAddress({ ...editingAddress, line: v })} placeholder="خیابان، کوچه، پلاک، واحد" /></Field><label className="flex items-center gap-2 text-[13px] font-semibold"><input type="checkbox" checked={editingAddress.isDefault} onChange={(e) => setEditingAddress({ ...editingAddress, isDefault: e.target.checked })} className="h-4 w-4 accent-[#C1613B]" />نشانی پیش‌فرض</label>{addressError && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{addressError}</p>}<Btn variant="accent" className="w-full" onClick={saveAddress}>ذخیره نشانی</Btn></div>}
      </Drawer>
      <Drawer open={!!returnOrder} onClose={() => setReturnOrder(null)} title="درخواست بازگشت کالا">
        <p className="mb-4 text-[13px] leading-7 text-[var(--kv-muted)]">برای سفارش {returnOrder} دلیل بازگشت را بنویسید. درخواست برای بررسی ثبت می‌شود.</p>
        <Field label="دلیل بازگشت"><Textarea rows={5} value={returnReason} onChange={setReturnReason} placeholder="مثلاً سایز با سفارش من مطابقت ندارد…" /></Field>
        <Btn variant="accent" className="mt-4 w-full" disabled={returnReason.trim().length < 8} onClick={async () => {
          if (!returnOrder) return;
          if (restrict.block || restrict.noReturn) { flash(`ثبت مرجوعی برای حساب شما محدود شده است${restrict.reason ? `: ${restrict.reason}` : ""}.`); return; }
          if (isDemo) {
            const o = store.retailOrders.find((x) => x.id === returnOrder);
            const sub = !o ? store.orders.flatMap((po) => po.subOrders ?? []).find((s) => s.id === returnOrder) as any : undefined;
            if (o) store.requestRetailReturn(account.id, returnOrder, returnReason);
            ops.upsert("returns", {
              id: `RT-${Date.now().toString().slice(-4)}`, channel: o ? "retail" : "wholesale", orderId: returnOrder, ownerId: account.id, ownerName: buyer?.status === "فعال" && !o ? buyer.name : account.name,
              items: o ? o.lines.map((l) => `${l.name} ×${l.qty}`).join("، ") : sub ? sub.lines.map((l:any) => `${l.name} · ${l.qtySeries} سری`).join("، ") : "—",
              reason: returnReason.trim(), resolution: o ? "refund" : "exchange", status: "requested", amount: o?.total ?? sub?.total ?? 0, createdAt: new Date().toLocaleDateString("fa-IR"), events: [{ t: "درخواست ثبت شد", at: new Date().toLocaleDateString("fa-IR") }],
            } as any, true);
            setReturnOrder(null); flash("درخواست مرجوعی ثبت شد و در پنل پشتیبانی قابل پیگیری است. (demo)");
            return;
          }
          try {
            const res = await returnsApi.create({ orderId: returnOrder, reason: returnReason.trim(), resolution: "refund" });
            setReturnOrder(null); flash(`درخواست مرجوعی ${res.reference} ثبت شد.`);
            const refreshed = await returnsApi.list();
            setServerReturns((refreshed as any).items);
          } catch (e) {
            flash(e instanceof Error ? e.message : "خطا در ثبت مرجوعی");
          }
        }}>ثبت درخواست بازگشت</Btn>
      </Drawer>
      {feedback && <div role="status" aria-live="polite" className="kv-glass fixed bottom-5 left-1/2 z-[90] -translate-x-1/2 rounded-[12px] px-5 py-3 text-[13px] font-bold kv-shadow-md">{feedback}</div>}
    </div>
  );
}
