import { useEffect, useMemo, useRef, useState } from "react";
import {
  ShoppingBag, Heart, User, Crown, ArrowLeft, LogOut, Package, Store,
  ShieldCheck, Home, LayoutGrid, Shirt,
} from "lucide-react";
import RetailExperience, { type CartLine, type RetailView, type ShopSeed } from "./portals/retail";
import VipExperience from "./portals/vip";
import SupplierApp from "./portals/supplier";
import AdminApp from "./portals/admin";
import StudioExperience, { AuthScreens, type StudioSurface } from "./portals/studio";
import type { BuilderEntry } from "./portals/style-builder";
import { Modal } from "./components/primitives";
import { digitsOnly } from "./data/customer";
import { StoreProvider, useStore } from "./data/store";
import { publicCuratedStyles, type CuratedStyle } from "./data/curated";
import { OpsProvider, useOps } from "./data/ops";
import { OutfitProvider } from "./data/outfit";
import { validateRetailLines } from "./data/cart";
import { AnnouncementBar, type NavTarget } from "./components/cms-render";
import { FloatingSupport } from "./components/support";
import type { AccountTab } from "./portals/account";
/* Archive Fluid presentation layer (storefront only) */
import FloatingHeader, { type HeaderLink, type HeaderMenuItem } from "./components/storefront/FloatingHeader";
import MobileBottomNav from "./components/storefront/MobileBottomNav";
import CartDrawer from "./components/storefront/CartDrawer";
import StorefrontSearch from "./components/storefront/StorefrontSearch";
import StorefrontFooter from "./components/storefront/StorefrontFooter";
import { CartToastProvider } from "./components/storefront/CartToast";

/* These are separate demo surfaces sharing local data, not server-backed authentication. */
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
    // the storefront paints its own page background (overscroll, rubber band)
    document.documentElement.dataset.surface = site === "public" ? "storefront" : "other";
  }, [site]);
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
type Session = { accountId: string } | null;
type Section = "retail" | "vip" | "studio" | "auth";

function Storefront({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  const { accounts, buyers, products, ensureAccount, updateAccount, plans, shipping, curatedStyles, variantRelations } = useStore();
  /* the ONLY public lens on curated styles — drafts never leave the admin boundary */
  const publicStyles = useMemo(() => publicCuratedStyles(curatedStyles), [curatedStyles]);
  const ops = useOps();
  const [session, setSession] = useState<Session>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("kolbe-session") || "null");
      if (stored?.accountId) return { accountId: stored.accountId };
      if (stored?.role === "vip") return { accountId: "acc-vip" };
      if (stored?.role === "customer") return { accountId: "acc-sara" };
    } catch { /* ignore unavailable storage */ }
    return null;
  });
  const account = accounts.find((a) => a.id === session?.accountId) ?? null;
  const buyer = buyers.find((b) => b.accountId === account?.id);
  const role = !account ? "guest" : buyer?.status === "فعال" ? "vip" : "customer";
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  /* Studio surfaces are separate customer jobs: try-on («how does this look on
     me») and the style builder («what works together as an outfit»). The entry
     carries the product/colour context the shopper came from; a nonce makes
     every «+ استایل» click a fresh preload even for the same product. */
  const [studioSurface, setStudioSurface] = useState<StudioSurface>("tryon");
  const [studioEntry, setStudioEntry] = useState<BuilderEntry>(null);
  /* Demo-only shortcuts (panel previews) exist for development and the sandbox
     preview build. They are never part of production storefront navigation. */
  const demoEnabled = import.meta.env.DEV;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [styleSlug, setStyleSlug] = useState<string | null>(null);
  const [shopSeed, setShopSeed] = useState<ShopSeed>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const announceRef = useRef<HTMLDivElement>(null);

  useEffect(() => { localStorage.setItem("kolbe-session", JSON.stringify(session)); }, [session]);

  /* The announcement strip is fixed, so the floating header needs its live height. */
  useEffect(() => {
    const node = announceRef.current;
    const root = rootRef.current;
    if (!node || !root) return;
    const apply = () => root.style.setProperty("--kvaf-announce-h", `${node.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const go = (s: Section, v?: RetailView) => {
    if (s === "retail" && v === "account" && !account) {
      setReturnTo({ section: "retail", view: "account" });
      setSection("auth");
      return;
    }
    setSection(s);
    if (v) setView(v);
    setSelectedId(null);
    window.scrollTo({ top: 0 });
  };
  const openAuth = (back?: { section: Section; view: RetailView }) => {
    setReturnTo(back ?? null);
    go("auth");
  };
  const logout = () => {
    setSession(null);
    go("retail", "home");
  };

  const openAccount = (tab: AccountTab = "overview") => { setAccountTab(tab); go("retail", "account"); };
  /* Curated style navigation — a sibling of the product detail, reachable from
     the homepage «استایل‌های آماده» section (§43) */
  const openStyle = (slug: string) => { setStyleSlug(slug); go("retail"); setView("style"); window.scrollTo({ top: 0 }); };
  const personalizeStyle = (style: CuratedStyle) => {
    openStudio("builder", undefined, undefined,
      [...style.items].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => ({ productId: item.productId, colorId: item.colorId })));
  };
  /* a curated style open in the reader gets its own document title (§68 SEO) */
  useEffect(() => {
    if (!styleSlug) return;
    const style = publicStyles.find((s) => s.slug === styleSlug);
    if (style) document.title = `${style.title} | استایل آمادهٔ کلبه`;
  }, [styleSlug, publicStyles]);

  const toggleWish = (id: string) => {
    const next = wishlist.includes(id) ? wishlist.filter((x) => x !== id) : [...wishlist, id];
    if (account) updateAccount(account.id, { wishlist: next });
    else setGuestWishlist(next);
  };
  /* studio entry — one door for both surfaces, carrying shopper context (§10) */
  const openStudio = (surface: StudioSurface, productId?: string, colorId?: string, preload?: { productId: string; colorId?: string }[]) => {
    setStudioSurface(surface);
    setStudioEntry(productId || preload ? { productId, colorId, nonce: Date.now(), preload } : null);
    go("studio");
  };
  /* Style Builder → cart: the SAME lines and rules as a single add, extended to
     all-or-nothing batches (§19). Checkout keeps revalidating in place. */
  const addOutfitLines = (lines: { productId: string; size: string; color: string; qty: number }[]) => {
    const incoming: CartLine[] = lines.map((line) => ({ id: line.productId, qty: line.qty, size: line.size, color: line.color }));
    const check = validateRetailLines(products, cart, incoming);
    if (!check.ok) return check;
    const merged = [...cart];
    for (const line of incoming) {
      const index = merged.findIndex((m) => m.id === line.id && m.size === line.size && m.color === line.color);
      if (index >= 0) merged[index] = { ...merged[index], qty: merged[index].qty + line.qty };
      else merged.push(line);
    }
    setCart(merged);
    return check;
  };
  /* Curated style → cart (§64–§66): the SAME retail validation as a single
     add and as the builder outfit, extended with the style/group metadata.
     Totals on screen are previews — lines revalidate as they land and the
     store recomputes the style snapshot again at order time. */
  const addStyleToCart = (style: CuratedStyle, adds: { productId: string; colorId: string; size: string; qty: number }[]) => {
    const groupId = `sg-${style.id}-${Date.now()}`;
    const incoming: CartLine[] = adds.map((add) => {
      const product = products.find((p) => p.id === add.productId);
      const colorName = product?.colors.find((c) => c.id === add.colorId)?.name ?? add.colorId;
      return { id: add.productId, qty: add.qty, size: add.size, color: colorName, curatedStyleId: style.id, stylePurchaseGroupId: groupId };
    });
    const check = validateRetailLines(products, cart, incoming);
    if (!check.ok) return check;
    const merged = [...cart];
    for (const line of incoming) {
      const index = merged.findIndex((m) => m.id === line.id && m.size === line.size && m.color === line.color);
      if (index >= 0) merged[index] = { ...merged[index], qty: merged[index].qty + line.qty, curatedStyleId: merged[index].curatedStyleId ?? line.curatedStyleId, stylePurchaseGroupId: merged[index].stylePurchaseGroupId ?? line.stylePurchaseGroupId };
      else merged.push(line);
    }
    setCart(merged);
    return check;
  };
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartTotal = cart.reduce((s, l) => s + (products.find((p) => p.id === l.id)?.retailPrice ?? 0) * l.qty, 0);

  /* Same published-retail scope the shop view uses — read-only, for search and categories. */
  const retailProducts = useMemo(
    () => products.filter((p) => p.status === "published" && p.retailPrice > 0),
    [products],
  );
  const categories = useMemo(() => {
    const counts = new Map<string, { name: string; count: number; image: string }>();
    retailProducts.forEach((p) => {
      const entry = counts.get(p.category);
      if (entry) entry.count += 1;
      else counts.set(p.category, { name: p.category, count: 1, image: p.images[0] });
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
  }, [retailProducts]);

  const seedShop = (patch: { cat?: string; q?: string }) => {
    setShopSeed({ ...patch, nonce: Date.now() });
    setSection("retail");
    setView("shop");
    setSelectedId(null);
    window.scrollTo({ top: 0 });
  };

  const links: HeaderLink[] = [
    { id: "home", label: "خانه", active: section === "retail" && view === "home" && !selectedId, onClick: () => go("retail", "home") },
    { id: "shop", label: "فروشگاه", active: section === "retail" && (view === "shop" || !!selectedId), onClick: () => go("retail", "shop") },
    { id: "studio", label: "پرو مجازی", active: section === "studio" && studioSurface === "tryon", onClick: () => openStudio("tryon") },
    { id: "journal", label: "مجله", active: section === "retail" && view === "journal", onClick: () => go("retail", "journal") },
    { id: "vip", label: "بازارچه عمده", active: section === "vip", onClick: () => go("vip"), vip: true },
  ];

  const menuItems: HeaderMenuItem[] = [
    ...(role === "vip" ? [{ id: "vip-orders", label: "سفارش‌های عمده و سبد عمده", icon: <Crown size={15} />, onClick: () => go("vip") }] : []),
    { id: "builder", label: "ساخت استایل", icon: <Shirt size={15} />, onClick: () => openStudio("builder") },
    { id: "account", label: "پنل حساب من", icon: <Package size={15} />, onClick: () => openAccount() },
    { id: "orders", label: "سفارش‌های خرده", icon: <ShoppingBag size={15} />, onClick: () => openAccount("orders") },
    { id: "membership", label: "عضویت عمده", icon: <Crown size={15} />, onClick: () => openAccount("membership") },
    { id: "wishlist", label: "علاقه‌مندی‌ها", icon: <Heart size={15} />, onClick: () => openAccount("wishlist") },
    { id: "logout", label: "خروج", icon: <LogOut size={15} />, onClick: logout, danger: true },
  ];

  const bottomNav = [
    { id: "home", label: "خانه", icon: <Home size={19} />, active: section === "retail" && view === "home" && !selectedId, onClick: () => go("retail", "home") },
    { id: "shop", label: "فروشگاه", icon: <LayoutGrid size={19} />, active: section === "retail" && (view === "shop" || !!selectedId), onClick: () => go("retail", "shop") },
    { id: "wishlist", label: "علاقه‌مندی", icon: <Heart size={19} />, active: section === "retail" && view === "wishlist", onClick: () => go("retail", "wishlist"), badge: wishlist.length },
    { id: "vip", label: "عمده", icon: <Crown size={19} />, active: section === "vip", onClick: () => go("vip") },
    { id: "account", label: "حساب", icon: <User size={19} />, active: section === "retail" && view === "account", onClick: () => go("retail", "account") },
  ];

  const cmsNav = (t: NavTarget) =>
    t === "vip" ? go("vip") : t === "tryon" ? openStudio("tryon") : go("retail", t === "journal" ? "journal" : "shop");

  const isHome = section === "retail" && view === "home" && !selectedId;
  /* The PDP's fixed purchase bar exists below 1024px; while it is on screen the
     support launcher lifts above it so the two never overlap. */
  const purchaseBarVisible = section === "retail" && !!selectedId;
  /* Only an *active* retail shipping method that declares a free-shipping
     threshold can produce footer copy; otherwise this stays empty and the footer
     renders no delivery claim at all. */
  const retailShippingNote = shipping.filter((s) => s.active && s.scope !== "عمده" && s.freeAbove !== null)
    .map((s) => `${s.name}: ارسال رایگان بالای ${(s.freeAbove! / 1000000).toLocaleString("fa-IR")} میلیون تومان`)
    .slice(0, 1)
    .join(" · ");

  return (
    <div ref={rootRef} className="kv-storefront min-h-screen">
      <a href="#kv-sf-main" className="kv-sf-skip">پرش به محتوای اصلی</a>

      {/* CMS announcement — fixed so the floating header offset stays exact */}
      <div ref={announceRef} className="kv-sf-announce">
        <AnnouncementBar block={ops.blocks.find((b) => b.type === "announcement")} onNav={cmsNav} />
      </div>

      <CartToastProvider onViewCart={() => setCartOpen(true)}>
        <FloatingHeader
          links={links} menuItems={menuItems}
          cartCount={cartCount} wishlistCount={wishlist.length}
          role={role} accountName={account?.name}
          accountNote={role === "vip"
            ? `همان حساب مشتری · پلن ${plans.find((p) => p.id === buyer?.planId)?.name ?? "عمده"}`
            : buyer?.status === "در انتظار تأیید" ? "درخواست عضویت عمده در حال بررسی" : account ? "حساب مشتری" : undefined}
          onHome={() => go("retail", "home")}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenCart={() => setCartOpen(true)}
          onWishlist={() => go("retail", "wishlist")}
          onAuth={() => openAuth()}
          onDemo={demoEnabled ? () => setDemoOpen(true) : undefined}
          dark={dark}
          onToggleDark={() => setDark(!dark)}
        />

        {/* ======= BODY ======= */}
        <main id="kv-sf-main" key={section} className={`kv-sf-bottom animate-[fadeIn_0.3s_ease] ${isHome ? "" : "kv-sf-page"}`}>
          {section === "retail" && (
            <RetailExperience
              selectedId={selectedId} setSelectedId={setSelectedId}
              cart={cart} setCart={setCart}
              wishlist={wishlist} toggleWish={toggleWish}
              view={view} setView={setView}
              account={account} buyer={buyer} accountTab={accountTab} setAccountTab={setAccountTab}
              shopSeed={shopSeed}
              categories={categories}
              styles={publicStyles}
              relations={variantRelations}
              styleSlug={styleSlug}
              openStyle={openStyle}
              personalizeStyle={personalizeStyle}
              addStyleToCart={addStyleToCart}
              onOpenProductFromStyle={(id) => { setView("shop"); setSelectedId(id); window.scrollTo({ top: 0 }); }}
              onWholesale={() => go("vip")}
              onLogout={logout}
              onLogin={() => openAuth({ section: "retail", view: "account" })}
              requireLogin={() => {
                if (account) return true;
                openAuth({ section: "retail", view: "checkout" });
                return false;
              }}
              onStudio={openStudio}
            />
          )}
          {section === "vip" && (
            <VipExperience
              role={role} buyer={role === "vip" ? buyer!.name : "مهمان"}
              accountId={account?.id}
              selectedId={selectedId} setSelectedId={setSelectedId}
              onAuth={() => {
                setAccountTab("membership");
                if (account) go("retail", "account");
                else openAuth({ section: "retail", view: "account" });
              }}
            />
          )}
          {section === "studio" && (
            <OutfitProvider>
              <StudioExperience
                surface={studioSurface}
                accountId={account?.id}
                catalogue={retailProducts}
                entry={studioEntry}
                onEntryConsumed={() => setStudioEntry(null)}
                onLogin={() => openAuth({ section: "studio", view })}
                onAddOutfit={addOutfitLines}
                onOpenProduct={(id) => { setSection("retail"); setSelectedId(id); window.scrollTo({ top: 0 }); }}
              />
            </OutfitProvider>
          )}
          {section === "auth" && (
            <AuthScreens portal="retail" onDone={(phone) => {
              const id = ensureAccount(phone);
              const current = accounts.find((a) => a.phone === digitsOnly(phone));
              if (guestCart.length || guestWishlist.length) {
                const mergedCart = [...(current?.cart ?? [])];
                guestCart.forEach((item) => {
                  const index = mergedCart.findIndex((line) => line.id === item.id && line.size === item.size && line.color === item.color);
                  if (index >= 0) mergedCart[index] = { ...mergedCart[index], qty: mergedCart[index].qty + item.qty };
                  else mergedCart.push(item);
                });
                updateAccount(id, { cart: mergedCart, wishlist: Array.from(new Set([...(current?.wishlist ?? []), ...guestWishlist])) });
                setGuestCart([]);
                setGuestWishlist([]);
              }
              setSession({ accountId: id });
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
          <StorefrontFooter
            onShop={() => go("retail", "shop")}
            onJournal={() => go("retail", "journal")}
            onStudio={() => openStudio("tryon")}
            onVip={() => go("vip")}
            onDemo={demoEnabled ? () => setDemoOpen(true) : undefined}
            dark={dark}
            onToggleDark={() => setDark(!dark)}
            productCount={retailProducts.length}
            shippingNote={retailShippingNote || undefined}
          />
        )}

        {/* search and cart are never duplicated in the bottom navigation */}
        <StorefrontSearch
          open={searchOpen} onClose={() => setSearchOpen(false)}
          products={retailProducts} categories={categories}
          onOpenProduct={(id) => { setSection("retail"); setSelectedId(id); window.scrollTo({ top: 0 }); }}
          onPickCategory={(name) => seedShop({ cat: name })}
        />

        <CartDrawer
          open={cartOpen} onClose={() => setCartOpen(false)}
          cart={cart} products={products} subtotal={cartTotal}
          onRemove={(index) => setCart(cart.filter((_, i) => i !== index))}
          onCheckout={() => { setCartOpen(false); go("retail", "checkout"); }}
          onContinue={() => { setCartOpen(false); go("retail", "shop"); }}
        />

        {section !== "auth" && (
          <MobileBottomNav items={bottomNav} />
        )}

        {/* Inside the shell on purpose: the support surface is a storefront
            widget, so it must inherit the Archive Fluid scope (and therefore the
            dark-mode tokens) without depending on the admin console. */}
        {section !== "auth" && (
          <FloatingSupport lift={purchaseBarVisible} onTicket={() => { setAccountTab("support"); if (account) go("retail", "account"); else openAuth({ section: "retail", view: "account" }); }} />
        )}
      </CartToastProvider>

      <Modal open={demoEnabled && demoOpen} onClose={() => setDemoOpen(false)} max="max-w-[500px]" title="پیش‌نمایش آزمایشی پنل‌ها">
        <div className="pl-10">
          <p className="text-[18px] font-extrabold">پیش‌نمایش پنل‌ها</p>
          <p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">برای تست جریان‌ها، بدون ورود دوباره جابه‌جا شوید. این میان‌بُر فقط برای نسخه آزمایشی است و نباید در محصول نهایی منتشر شود.</p>
          <div className="mt-5 space-y-2">
            <button onClick={() => { setDemoOpen(false); setSession({ accountId: "acc-vip" }); setAccountTab("membership"); setSection("retail"); setView("account"); setSelectedId(null); window.scrollTo({ top: 0 }); }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><Crown size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">حساب مشتری با عضویت عمده نمونه</b><span className="text-xs text-[var(--kv-muted)]">سفارش‌های مادر و قیمت عمده را ببینید</span></span><ArrowLeft size={16} className="mr-auto" /></button>
            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); sessionStorage.setItem("kolbe-supplier", "1"); setDemoOpen(false); window.location.hash = "#/supplier"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><Store size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل تأمین‌کننده</b><span className="text-xs text-[var(--kv-muted)]">محصولات، سری‌ها و زیرسفارش‌های نیلگون</span></span><ArrowLeft size={16} className="mr-auto" /></button>
            <button onClick={() => { sessionStorage.setItem("kolbe-preview", "1"); setDemoOpen(false); window.location.hash = "#/admin"; }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] p-4 text-right hover:border-[var(--kv-accent)]"><ShieldCheck size={20} className="text-[var(--kv-accent)]" /><span><b className="block text-[13.5px]">پنل مدیریت</b><span className="text-xs text-[var(--kv-muted)]">ورود با حساب مدیر و مشاهده سفارش‌های واقعی</span></span><ArrowLeft size={16} className="mr-auto" /></button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
