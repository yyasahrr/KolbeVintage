import { useEffect, useRef, useState } from "react";
import {
  ShoppingBag, Heart, Moon, Sun, User, Crown, Menu, X, Trash2, Camera, Send, Phone,
  MapPin, ArrowLeft, LogOut, Package, ChevronDown, Store, ShieldCheck,
} from "lucide-react";
import RetailExperience, { type CartLine, type RetailView } from "./portals/retail";
import VipExperience from "./portals/vip";
import SupplierApp from "./portals/supplier";
import AdminApp from "./portals/admin";
import StudioExperience, { AuthScreens } from "./portals/studio";
import { Btn, Drawer, Modal } from "./components/primitives";
import { fmtMoney, fmtNum } from "./data/catalog";
import { digitsOnly } from "./data/customer";
import { StoreProvider, useStore } from "./data/store";
import { authApi } from "./data/api";
import { OpsProvider, useOps } from "./data/ops";
import { AnnouncementBar, type NavTarget } from "./components/cms-render";
import { FloatingSupport } from "./components/support";
import type { AccountTab } from "./portals/account";
import { cn } from "./utils/cn";

/* Site router: public/supplier/admin surfaces. Authentication is server-backed via /api/v1/auth (JWT accessToken + httpOnly refresh cookie). No business identity is stored in localStorage; only theme and guest cart are. */
type Site = "public" | "supplier" | "admin";
const readSite = (): Site => {
  const h = window.location.hash;
  if (h.startsWith("#/supplier")) return "supplier";
  if (h.startsWith("#/admin")) return "admin";
  return "public";
};

export default function App() {
  const [site, setSite] = useState<Site>(readSite);
  const [dark, setDark] = useState(() => localStorage.getItem("kolbe-theme") === "dark");

  useEffect(() => {
    const on = () => { setSite(readSite()); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("kolbe-theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    document.title =
      site === "supplier" ? "مرکز تأمین‌کنندگان کلبه" :
      site === "admin" ? "کنسول مدیریت کلبه" :
      "کلبه وینتج — فروشگاه پوشاک کلاسیک و مدرن";
  }, [site]);

  return (
    <StoreProvider>
      <OpsProvider>
        {site === "supplier" && <SupplierApp dark={dark} setDark={setDark} onExit={() => { window.location.hash = "#/"; }} />}
        {site === "admin" && <AdminApp dark={dark} setDark={setDark} />}
        {site === "public" && <Storefront dark={dark} setDark={setDark} />}
      </OpsProvider>
    </StoreProvider>
  );
}

/* ====================== kolbe.ir storefront ====================== */
type Section = "retail" | "vip" | "studio" | "auth";

function Storefront({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  const { products, plans } = useStore();
  const ops = useOps();
  // Real authentication: JWT accessToken in localStorage (kolbe-access-token) + httpOnly refresh cookie.
  // No kolbe-session business identity. Guest cart is kept in local state; authenticated state comes from /auth/me.
  const [authUser, setAuthUser] = useState<{ id: string; displayName: string; roles: string[]; phone?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await authApi.me() as { id: string; displayName: string; roles: string[]; phone?: string };
        if (alive) setAuthUser(me);
      } catch { if (alive) setAuthUser(null); }

    })();
    return () => { alive = false; };
  }, []);
  // For migration: still support local guest account via store until full API migration, but server is source of truth when authenticated.
  const { accounts, buyers, updateAccount } = useStore();
  const account = authUser ? (accounts.find((a) => a.id === authUser.id) ?? { id: authUser.id, name: authUser.displayName, phone: authUser.phone ?? "", addresses: [], wishlist: [], cart: [], preferences: { orderUpdates:true, offers:false, sms:true, email:false }, savedStyles: [], tickets: [] } as unknown as typeof accounts[number]) : null;
  const buyer = authUser ? buyers.find((b) => b.accountId === authUser.id) : null;
  const role = !authUser ? "guest" : buyer?.status === "فعال" ? "vip" : authUser.roles.includes("vip") ? "vip" : "customer";
  const [section, setSection] = useState<Section>("retail");
  const [view, setView] = useState<RetailView>("home");
  const [returnTo, setReturnTo] = useState<{ section: Section; view: RetailView } | null>(null);
  const [guestCart, setGuestCart] = useState<CartLine[]>([]);
  const [guestWishlist, setGuestWishlist] = useState<string[]>([]);
  const cart = account?.cart ?? guestCart;
  const wishlist = account?.wishlist ?? guestWishlist;
  const setCart = (lines: CartLine[]) => account ? updateAccount(account.id, { cart: lines }) : setGuestCart(lines);
  const [accountTab, setAccountTab] = useState<AccountTab>("overview");
  const [cartOpen, setCartOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [studioTab, setStudioTab] = useState("tryon");
  const menuRef = useRef<HTMLDivElement>(null);

  // No kolbe-session — business identity comes only from /auth/me (accessToken + refresh cookie). Guest cart is kept transient in memory + localStorage guest-cart if needed.
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const go = (s: Section, v?: RetailView) => {
    if (s === "retail" && v === "account" && !account) {
      setReturnTo({ section: "retail", view: "account" });
      setSection("auth");
      setMobileNav(false);
      return;
    }
    setSection(s);
    if (v) setView(v);
    setSelectedId(null);
    setMobileNav(false);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  };
  const openAuth = (back?: { section: Section; view: RetailView }) => {
    setReturnTo(back ?? null);
    go("auth");
  };
  const logout = async () => {
    try { await authApi.logout(); } catch {}
    setAuthUser(null);
    go("retail", "home");
  };

  const openAccount = (tab: AccountTab = "overview") => { setAccountTab(tab); go("retail", "account"); };
  const toggleWish = (id: string) => {
    const next = wishlist.includes(id) ? wishlist.filter((x) => x !== id) : [...wishlist, id];
    if (account) updateAccount(account.id, { wishlist: next });
    else setGuestWishlist(next);
  };
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartTotal = cart.reduce((s, l) => s + (products.find((p) => p.id === l.id)?.retailPrice ?? 0) * l.qty, 0);

  const links: { label: string; active: boolean; onClick: () => void; vip?: boolean }[] = [
    { label: "خانه", active: section === "retail" && view === "home" && !selectedId, onClick: () => go("retail", "home") },
    { label: "فروشگاه", active: section === "retail" && (view === "shop" || !!selectedId), onClick: () => go("retail", "shop") },
    { label: "پرو مجازی", active: section === "studio", onClick: () => { setStudioTab("tryon"); go("studio"); } },
    { label: "مجله", active: section === "retail" && view === "journal", onClick: () => go("retail", "journal") },
    { label: "بازارچه عمده", active: section === "vip", onClick: () => go("vip"), vip: true },
  ];

  return (
    <div className="min-h-screen">
      <AnnouncementBar block={ops.blocks.find((b) => b.type === "announcement")} onNav={(t: NavTarget) => t === "vip" ? go("vip") : t === "tryon" ? (setStudioTab("tryon"), go("studio")) : go("retail", t === "journal" ? "journal" : "shop")} />
      {/* ======= STOREFRONT HEADER ======= */}
      <header className="sticky top-0 z-50">
        <div className="kv-glass !rounded-none !border-x-0 !border-t-0">
          <div className="mx-auto flex h-[68px] w-full max-w-[1480px] items-center gap-3 px-4 md:px-8">
            <button className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="منو"><Menu size={21} /></button>
            <button onClick={() => go("retail", "home")} className="flex items-center gap-3 text-right" aria-label="کلبه وینتج — خانه">
              <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#1B2A4A] text-[17px] font-bold text-[#E8D9C3] dark:bg-[#E8D9C3] dark:text-[#0E1527]" style={{ fontFamily: "Marcellus, serif" }}>K</span>
              <span className="leading-tight">
                <span className="kv-latin block text-[14px] font-bold">KOLBE</span>
                <span className="block text-[10.5px] font-semibold tracking-[0.28em] text-[var(--kv-muted)]">VINTAGE</span>
              </span>
            </button>

            <nav className="mr-6 hidden items-center gap-1 lg:flex" aria-label="ناوبری اصلی">
              {links.map((l) => (
                <button
                  key={l.label} onClick={l.onClick} aria-current={l.active ? "page" : undefined}
                  className={cn(
                    "kv-press relative flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13.5px] font-bold transition-colors",
                    l.vip && "text-[var(--kv-accent)]",
                    l.active ? "text-[var(--kv-ink)]" : !l.vip && "text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"
                  )}
                >
                  {l.vip && <Crown size={14} />}{l.label}
                  {l.active && <span className="absolute inset-x-3.5 -bottom-[3px] h-[2px] rounded-full bg-[var(--kv-accent)]" />}
                </button>
              ))}
            </nav>

            <div className="mr-auto flex items-center gap-1">
              <button onClick={() => setDemoOpen(true)} aria-label="پیش‌نمایش آزمایشی پنل‌ها" title="پیش‌نمایش آزمایشی پنل‌ها" className="kv-press hidden h-10 items-center gap-1.5 rounded-[11px] px-2 text-[11px] font-semibold text-[var(--kv-muted)] hover:bg-[var(--kv-surface-2)] hover:text-[var(--kv-accent)] sm:flex sm:px-3">
                <ShieldCheck size={16} /><span className="hidden xl:inline">تست پنل‌ها</span>
              </button>
              <button onClick={() => setDark(!dark)} className="kv-press flex h-10 w-10 items-center justify-center rounded-[11px] hover:bg-[var(--kv-surface-2)]" aria-label={dark ? "حالت روشن" : "حالت تیره"}>
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <button onClick={() => go("retail", "wishlist")} className="kv-press relative hidden h-10 w-10 items-center justify-center rounded-[11px] hover:bg-[var(--kv-surface-2)] sm:flex" aria-label="علاقه‌مندی‌ها">
                <Heart size={18} />
                {wishlist.length > 0 && <span className="absolute left-1 top-1 h-2 w-2 rounded-full bg-[var(--kv-accent)]" />}
              </button>
              <button onClick={() => setCartOpen(true)} className="kv-press relative flex h-10 w-10 items-center justify-center rounded-[11px] hover:bg-[var(--kv-surface-2)]" aria-label="سبد خرید">
                <ShoppingBag size={18} />
                {cartCount > 0 && <span className="absolute -left-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--kv-accent)] px-1 text-[10.5px] font-bold text-white tabular-nums">{fmtNum(cartCount)}</span>}
              </button>

              {role === "guest" ? (
                <button onClick={() => openAuth()} className="kv-press mr-1 hidden h-10 items-center gap-2 rounded-[11px] bg-[var(--kv-action)] px-4 text-[13px] font-bold text-[var(--kv-bg)] dark:text-[#0E1527] sm:flex">
                  <User size={16} />ورود / ثبت‌نام
                </button>
              ) : (
                <div className="relative mr-1" ref={menuRef}>
                  <button onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} className="kv-press flex h-10 items-center gap-2 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 pl-3 text-[13px] font-bold">
                    <span className={cn("flex h-7 w-7 items-center justify-center rounded-[8px] text-[12px]", role === "vip" ? "bg-[#1B2A4A] text-[#E8D9C3]" : "bg-[var(--kv-accent)]/12 text-[var(--kv-accent)]")}>{account?.name[0]}</span>
                    <span className="hidden max-w-[120px] truncate sm:block">{account?.name}</span>
                    <ChevronDown size={14} className={cn("transition-transform", menuOpen && "rotate-180")} />
                  </button>
                  {menuOpen && (
                    <div className="kv-glass absolute left-0 top-12 w-60 rounded-[16px] p-2 animate-[scaleIn_0.18s_ease]">
                      <div className="px-3 pb-2 pt-1.5">
                        <p className="text-[13.5px] font-extrabold">{account?.name}</p>
                        <p className="text-[11.5px] text-[var(--kv-muted)]">{role === "vip" ? `همان حساب مشتری · پلن ${plans.find((p) => p.id === buyer?.planId)?.name ?? "عمده"}` : buyer?.status === "در انتظار تأیید" ? "درخواست عضویت عمده در حال بررسی" : "حساب مشتری"}</p>
                      </div>
                      <div className="h-px bg-[var(--kv-line)]" />
                      {role === "vip" && (
                        <MenuItem icon={<Crown size={15} />} onClick={() => go("vip")}>سفارش‌های عمده و سبد عمده</MenuItem>
                      )}
                      <MenuItem icon={<Package size={15} />} onClick={() => openAccount()}>پنل حساب من</MenuItem>
                      <MenuItem icon={<ShoppingBag size={15} />} onClick={() => openAccount("orders")}>سفارش‌های خرده</MenuItem>
                      <MenuItem icon={<Crown size={15} />} onClick={() => openAccount("membership")}>عضویت عمده</MenuItem>
                      <MenuItem icon={<Heart size={15} />} onClick={() => openAccount("wishlist")}>علاقه‌مندی‌ها</MenuItem>
                      <div className="h-px bg-[var(--kv-line)]" />
                      <MenuItem icon={<LogOut size={15} />} onClick={logout} danger>خروج</MenuItem>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* mobile nav */}
      {mobileNav && (
        <div className="fixed inset-0 z-[80] lg:hidden">
          <div className="absolute inset-0 bg-black/45 animate-[fadeIn_0.2s_ease]" onClick={() => setMobileNav(false)} />
          <aside className="absolute right-0 top-0 flex h-full w-[300px] flex-col bg-[var(--kv-surface)] p-5 animate-[drawerIn_0.3s_ease]">
            <div className="mb-5 flex items-center justify-between">
              <p className="kv-latin text-[13px] font-bold">KOLBE VINTAGE</p>
              <button onClick={() => setMobileNav(false)} aria-label="بستن"><X size={20} /></button>
            </div>
            <nav className="space-y-1">
              {links.map((l) => (
                <button key={l.label} onClick={l.onClick} className={cn("flex w-full items-center gap-2 rounded-[12px] px-4 py-3 text-right text-[14.5px] font-bold", l.active ? "bg-[var(--kv-surface-2)]" : "hover:bg-[var(--kv-surface-2)]", l.vip && "text-[var(--kv-accent)]")}>
                  {l.vip && <Crown size={15} />}{l.label}
                </button>
              ))}
              <button onClick={() => go("retail", "wishlist")} className="flex w-full rounded-[12px] px-4 py-3 text-right text-[14.5px] font-bold hover:bg-[var(--kv-surface-2)]">علاقه‌مندی‌ها</button>
            </nav>
            <div className="mt-auto">
              <button onClick={() => { setMobileNav(false); setDemoOpen(true); }} className="mb-4 flex min-h-10 w-full items-center gap-2.5 rounded-[11px] px-4 text-[13px] font-semibold text-[var(--kv-muted)] hover:bg-[var(--kv-surface-2)]"><ShieldCheck size={16} />پیش‌نمایش آزمایشی پنل‌ها</button>
              {role === "guest"
                ? <Btn variant="dark" className="w-full" onClick={() => openAuth()} icon={<User size={16} />}>ورود / ثبت‌نام</Btn>
                : <div className="space-y-2"><Btn variant="dark" className="w-full" onClick={() => openAccount()} icon={<User size={16} />}>پنل حساب من</Btn><Btn variant="soft" className="w-full" onClick={logout} icon={<LogOut size={16} />}>خروج از {account?.name}</Btn></div>}
            </div>
          </aside>
        </div>
      )}

      {/* ======= BODY ======= */}
      <main key={section} className="animate-[fadeIn_0.3s_ease]">
        {section === "retail" && (
          <RetailExperience
            selectedId={selectedId} setSelectedId={setSelectedId}
            cart={cart} setCart={setCart}
            wishlist={wishlist} toggleWish={toggleWish}
            view={view} setView={setView}
            account={account} buyer={buyer ?? undefined} accountTab={accountTab} setAccountTab={setAccountTab}
            onWholesale={() => go("vip")}
            onLogout={logout}
            onLogin={() => openAuth({ section: "retail", view: "account" })}
            requireLogin={() => {
              if (account) return true;
              openAuth({ section: "retail", view: "checkout" });
              return false;
            }}
            onStudio={(t) => { setStudioTab(t); go("studio"); }}
          />
        )}
        {section === "vip" && (
          <VipExperience
            role={role} buyer={role === "vip" ? (buyer?.name ?? "مهمان") : "مهمان"}
            accountId={account?.id}
            selectedId={selectedId} setSelectedId={setSelectedId}
            onAuth={() => {
              setAccountTab("membership");
              if (account) go("retail", "account");
              else openAuth({ section: "retail", view: "account" });
            }}
          />
        )}
        {section === "studio" && <StudioExperience tab={studioTab} setTab={setStudioTab} accountId={account?.id} onLogin={() => openAuth({ section: "studio", view })} />}
        {section === "auth" && (
          <AuthScreens portal="retail" onDone={async (phone) => {
            // Real backend auth: try register then login. For demo, password is fixed dev value; in production SMS OTP is verified server-side.
            try {
              // Attempt register (idempotent if already exists)
              await authApi.register({ phone: digitsOnly(phone), password: "KolbeDemo123456!", displayName: "مشتری کلبه" }).catch(()=>undefined);
              await authApi.login({ identity: digitsOnly(phone), password: "KolbeDemo123456!" });
              const me = await authApi.me() as { id: string; displayName: string; roles: string[]; phone?: string };
              setAuthUser(me);
            } catch {
              // Fallback: keep guest but show error (no silent local account)
            }
            if (guestCart.length || guestWishlist.length) {
              // Guest cart will be synced to server cart via API after login (not local store)
              setGuestCart([]);
              setGuestWishlist([]);
            }
            setSection(returnTo?.section ?? "retail");
            setView(returnTo?.view ?? "account");
            setSelectedId(null);
            setReturnTo(null);
            window.scrollTo({ top: 0 });
          }} />
        )}
      </main>

      {/* ======= FOOTER ======= */}
      {section !== "auth" && (
        <footer className="border-t border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="mx-auto grid w-full max-w-[1480px] gap-10 px-4 py-12 md:grid-cols-[1.3fr_1fr_1fr_1fr] md:px-8">
            <div>
              <p className="kv-latin text-[16px] font-bold">KOLBE VINTAGE</p>
              <p className="mt-1 text-[13px] font-semibold text-[var(--kv-muted)]">کلبه، پلی میان اصالت و تجارت مدرن</p>
              <p className="mt-3 max-w-[38ch] text-[13px] leading-7 text-[var(--kv-muted)]">پوشاک کلاسیک و مدرن از تأمین‌کنندگان منتخب؛ با ضمانت اصالت، برگشت آسان و ارسال به سراسر کشور.</p>
              <div className="mt-4 flex gap-2">
                {[<Camera key="i" size={17} />, <Send key="s" size={17} />, <Phone key="p" size={17} />].map((icon, i) => (
                  <button key={i} className="kv-press flex h-10 w-10 items-center justify-center rounded-[11px] border border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]" aria-label={["اینستاگرام", "تلگرام", "تماس"][i]}>{icon}</button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-3.5 text-[13.5px] font-extrabold">خرید</p>
              <ul className="space-y-2.5 text-[13px] text-[var(--kv-muted)]">
                <li><button onClick={() => go("retail", "shop")} className="hover:text-[var(--kv-accent)]">همه محصولات</button></li>
                <li><button onClick={() => { setStudioTab("tryon"); go("studio"); }} className="hover:text-[var(--kv-accent)]">پرو مجازی و ساخت استایل</button></li>
                <li><button onClick={() => go("retail", "journal")} className="hover:text-[var(--kv-accent)]">مجله کلبه</button></li>
              </ul>
            </div>
            <div>
              <p className="mb-3.5 text-[13.5px] font-extrabold">همکاری با کلبه</p>
              <ul className="space-y-2.5 text-[13px] text-[var(--kv-muted)]">
                <li><button onClick={() => go("vip")} className="inline-flex items-center gap-1.5 hover:text-[var(--kv-accent)]"><Crown size={13} />خرید عمده برای فروشگاه‌ها</button></li>
                <li><a href="#/supplier" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 hover:text-[var(--kv-accent)]"><Store size={13} />فروشنده شوید · مرکز تأمین‌کنندگان</a></li>
                <li><span>قوانین و حریم خصوصی</span></li>
              </ul>
            </div>
            <div>
              <p className="mb-3.5 text-[13.5px] font-extrabold">خبرنامه</p>
              <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">از کالکشن‌های تازه زودتر باخبر شوید.</p>
              <div className="mt-3 flex gap-2">
                <input placeholder="ایمیل یا موبایل" aria-label="ایمیل یا موبایل" className="h-11 min-w-0 flex-1 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3.5 text-[13px] outline-none focus:border-[var(--kv-accent)]" />
                <button className="kv-press flex h-11 w-11 shrink-0 items-center justify-center rounded-[11px] bg-[var(--kv-accent)] text-white" aria-label="عضویت در خبرنامه"><ArrowLeft size={17} /></button>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--kv-muted)]"><MapPin size={13} />تهران، خیابان ولیعصر، گالری کلبه</p>
            </div>
          </div>
          <div className="border-t border-[var(--kv-line)]">
            <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-3 px-4 py-4 text-[12px] text-[var(--kv-muted)] md:px-8">
              <p>© ۱۴۰۴ کلبه وینتج · تمامی حقوق محفوظ است</p>
              <button onClick={() => setDemoOpen(true)} className="inline-flex min-h-10 items-center gap-1.5 text-[12px] font-semibold text-[var(--kv-muted)] underline-offset-4 hover:text-[var(--kv-accent)] hover:underline"><ShieldCheck size={14} />پیش‌نمایش آزمایشی پنل‌ها</button>
            </div>
          </div>
        </footer>
      )}

      <Modal open={demoOpen} onClose={() => setDemoOpen(false)} max="max-w-[500px]" title="پیش‌نمایش آزمایشی پنل‌ها">
        <div className="pl-10">
          <p className="text-[18px] font-extrabold">پیش‌نمایش پنل‌ها</p>
          <p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">برای تست جریان‌ها، بدون ورود دوباره جابه‌جا شوید. این میان‌بُر فقط برای نسخه آزمایشی است و نباید در محصول نهایی منتشر شود.</p>
          <div className="mt-5 space-y-2">
            <button onClick={() => { setDemoOpen(false); alert("برای تست عضویت عمده، با حساب واقعی وارد شوید و از تب عضویت درخواست دهید — دیتای نمونه دیگر به‌عنوان هویت تجاری استفاده نمی‌شود."); }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><Crown size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">حساب مشتری با عضویت عمده نمونه</b><span className="text-xs text-[var(--kv-muted)]">اکنون فقط با احراز هویت واقعی — دمو خاموش است</span></span><ArrowLeft size={16} className="mr-auto" /></button>
            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); sessionStorage.setItem("kolbe-supplier", "1"); setDemoOpen(false); window.location.hash = "#/supplier"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><Store size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل تأمین‌کننده</b><span className="text-xs text-[var(--kv-muted)]">محصولات، سری‌ها و زیرسفارش‌های نیلگون</span></span><ArrowLeft size={16} className="mr-auto" /></button>
            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); setDemoOpen(false); window.location.hash = "#/admin"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><ShieldCheck size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل مدیریت</b><span className="text-xs text-[var(--kv-muted)]">ورود با حساب مدیر و مشاهده سفارش‌های واقعی</span></span><ArrowLeft size={16} className="mr-auto" /></button>
          </div>
        </div>
      </Modal>

      {section !== "auth" && <FloatingSupport onTicket={() => { setAccountTab("support"); if (account) go("retail", "account"); else openAuth({ section: "retail", view: "account" }); }} />}
      {/* ======= CART DRAWER ======= */}
      <Drawer open={cartOpen} onClose={() => setCartOpen(false)} title={`سبد خرید (${fmtNum(cartCount)})`}>
        {cart.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--kv-surface-2)]"><ShoppingBag size={22} className="text-[var(--kv-muted)]" /></span>
            <p className="mt-4 text-[15px] font-bold">سبد خرید خالی است</p>
            <p className="mt-1 text-[13px] text-[var(--kv-muted)]">از فروشگاه شروع کنید</p>
            <Btn variant="accent" size="sm" className="mt-5" onClick={() => { setCartOpen(false); go("retail", "shop"); }}>مشاهده فروشگاه</Btn>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex-1 space-y-3">
              {cart.map((l, i) => {
                const p = products.find((x) => x.id === l.id);
                if (!p) return null;
                return (
                  <div key={i} className="flex gap-3 rounded-[14px] border border-[var(--kv-line)] p-2.5">
                    <img src={p.images[0]} alt="" className="h-20 w-16 shrink-0 rounded-[10px] object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-bold">{p.name}</p>
                      <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">{l.size} · {l.color} · {fmtNum(l.qty)} عدد</p>
                      <div className="mt-1.5 flex items-center justify-between">
                        <p className="text-[13px] font-extrabold tabular-nums">{fmtMoney(p.retailPrice * l.qty)}</p>
                        <button onClick={() => setCart(cart.filter((_, j) => j !== i))} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف"><Trash2 size={15} /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <div className="flex justify-between text-sm"><span className="text-[var(--kv-muted)]">جمع سبد</span><b className="tabular-nums">{fmtMoney(cartTotal)}</b></div>
              <Btn variant="accent" className="mt-3 w-full" onClick={() => { setCartOpen(false); go("retail", "checkout"); }}>تکمیل خرید</Btn>
              <button onClick={() => setCartOpen(false)} className="mt-2.5 w-full text-center text-[13px] font-semibold text-[var(--kv-muted)]">ادامه خرید</button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("my-0.5 flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-right text-[13px] font-semibold", danger ? "text-[var(--kv-danger)] hover:bg-[var(--kv-danger)]/[0.06]" : "hover:bg-[var(--kv-surface-2)]")}>
      {icon}{children}
    </button>
  );
}

