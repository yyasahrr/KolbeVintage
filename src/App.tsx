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
import { Btn, Modal } from "./components/primitives";
import { authApi, onAuthExpired } from "./data/api";
import { useSavedCart } from "./data/saved-cart";
import { CmsPageView } from "./components/cms-blocks";
import { useSiteExperience, useThemeTokens } from "./components/site-chrome";
import { siteApi } from "./data/experience-api";
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
type Section = "retail" | "vip" | "studio" | "auth" | "page";

function Storefront({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  const { accounts, buyers, products, ensureAccount, updateAccount, plans, shipping, curatedStyles, variantRelations } = useStore();
  /* the ONLY public lens on curated styles — drafts never leave the admin boundary */
  const publicStyles = useMemo(() => publicCuratedStyles(curatedStyles), [curatedStyles]);
  const ops = useOps();
  /* Auth is dual-mode by design. ?demo keeps the accepted local session flow so the
     seed store stays usable without a backend; production has NO local business
     identity — the server-backed JWT (/auth/me + refresh cookie) is the account,
     and the cart is the canonical server saved cart. */
  const isDemo = new URLSearchParams(window.location.search).has("demo");
  const [session, setSession] = useState<Session>(() => {
    if (!isDemo) return null;
    try {
      const stored = JSON.parse(localStorage.getItem("kolbe-session") || "null");
      if (stored?.accountId) return { accountId: stored.accountId };
      if (stored?.role === "vip") return { accountId: "acc-vip" };
      if (stored?.role === "customer") return { accountId: "acc-sara" };
    } catch { /* ignore unavailable storage */ }
    return null;
  });
  const [authUser, setAuthUser] = useState<{ id: string; displayName: string; roles: string[]; phone?: string } | null>(null);
  useEffect(() => {
    if (isDemo) return;
    let alive = true;
    (async () => {
      try {
        const me = await authApi.me() as { id: string; displayName: string; roles: string[]; phone?: string };
        if (alive) setAuthUser(me);
      } catch { if (alive) setAuthUser(null); }
    })();
    return onAuthExpired(() => { if (alive) setAuthUser(null); });
  }, []);
  const account = isDemo
    ? (accounts.find((a) => a.id === session?.accountId) ?? null)
    : (authUser ? (accounts.find((a) => a.id === authUser.id) ?? {
        id: authUser.id, name: authUser.displayName, phone: authUser.phone ?? "", addresses: [], wishlist: [], cart: [],
        preferences: { orderUpdates: true, offers: false, sms: true, email: false }, savedStyles: [], tickets: [],
      } as unknown as typeof accounts[number]) : null);
  const buyer = authUser && !isDemo ? buyers.find((b) => b.accountId === authUser.id) : buyers.find((b) => b.accountId === account?.id);
  const role = isDemo
    ? (!account ? "guest" : buyer?.status === "فعال" ? "vip" : "customer")
    : (!authUser ? "guest" : buyer?.status === "فعال" ? "vip" : authUser.roles.includes("vip") ? "vip" : "customer");
  const [section, setSection] = useState<Section>("retail");
  const [view, setView] = useState<RetailView>("home");
  const [returnTo, setReturnTo] = useState<{ section: Section; view: RetailView } | null>(null);
  const [guestCart, setGuestCart] = useState<CartLine[]>([]);
  const [guestWishlist, setGuestWishlist] = useState<string[]>([]);
  const wishlist = account?.wishlist ?? guestWishlist;
  /* Signed-in production cart = canonical server saved cart; demo keeps the store cart;
     guests stay in memory (no localStorage shadow of business state). */
  const savedCart = useSavedCart<CartLine>(!isDemo && authUser ? authUser.id : null, products as unknown as { id: string; variants?: { id: string; size: string | null; color: string | null }[] }[]);
  const cart = !isDemo && authUser ? savedCart.lines : (account?.cart ?? guestCart);
  const setCart = (lines: CartLine[]) =>
    !isDemo && authUser ? savedCart.save(lines) : account ? updateAccount(account.id, { cart: lines }) : setGuestCart(lines);
  const guestCartRef = useRef(guestCart);
  guestCartRef.current = guestCart;
  const loadSavedCart = savedCart.load;
  useEffect(() => {
    if (isDemo || !authUser?.id) return;
    // Restore the server cart for this user and merge whatever the guest collected before signing in (once).
    const guestLines = guestCartRef.current;
    setGuestCart([]);
    void loadSavedCart(guestLines);
  }, [authUser?.id, loadSavedCart]);
  const [accountTab, setAccountTab] = useState<AccountTab>("overview");
  const [cartOpen, setCartOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [pageCode, setPageCode] = useState("about");
  const [twoFactor, setTwoFactor] = useState<{ challengeId: string; devCode?: string; code: string; error: string } | null>(null);
  const [shopCategory, setShopCategory] = useState<{ name: string; nonce: number } | null>(null);
  const [navTaxonomy, setNavTaxonomy] = useState<{ categories: { slug: string; name: string }[]; vibes: { slug: string; name: string }[] } | null>(null);
  const { layout, theme } = useSiteExperience();
  useThemeTokens(theme, dark);
  /* Mobile navigation lists live categories when the server header config asks for them. */
  useEffect(() => {
    if (isDemo) return;
    const cfg = layout?.header?.mobileNav;
    if (!cfg || (!cfg.showCategories && !cfg.showVibes) || navTaxonomy) return;
    Promise.all([cfg.showCategories ? siteApi.categories().catch(() => ({ items: [] })) : { items: [] }, cfg.showVibes ? siteApi.vibes().catch(() => ({ items: [] })) : { items: [] }])
      .then(([c, v]) => setNavTaxonomy({ categories: (c.items as { slug: string; name: string; parent_id?: string | null; active?: boolean }[]).filter((x) => x.active !== false && !x.parent_id), vibes: v.items as { slug: string; name: string }[] }));
  }, [layout?.header?.mobileNav, navTaxonomy]);
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

  useEffect(() => { if (isDemo) localStorage.setItem("kolbe-session", JSON.stringify(session)); }, [session, isDemo]);

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

  /* Canonical paths issued by the SEO Domain (server pages, product/vibe routes)
     open the matching storefront surface. Demo keeps hash-only routing. */
  useEffect(() => {
    if (isDemo) return;
    const path = window.location.pathname.replace(/\/+$/, "");
    if (!path || path === "/" || window.location.hash.length > 2) return;
    const [, kind, key] = path.split("/");
    if (kind === "product" && key) { setSection("retail"); setView("shop"); setSelectedId(decodeURIComponent(key)); return; }
    if (kind === "vibe" && key) { setPageCode(`vibe-${decodeURIComponent(key)}`); setSection("page"); return; }
    if (kind === "collection" || kind === "category" || kind === "shop") { setSection("retail"); setView("shop"); return; }
    siteApi.resolvePath(path).then((r) => { setPageCode(r.code); setSection("page"); }).catch(() => undefined);
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
    if (!isDemo) {
      void authApi.logout().catch(() => undefined).then(() => setAuthUser(null));
      go("retail", "home");
      return;
    }
    /* demo logout — accepted local session */
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

  /* Server-managed header menus (CMS) take precedence when present; the accepted
     local link set stays the fallback so the shell never renders an empty header. */
  const header = layout?.header ?? null;
  const serverLinks: HeaderLink[] | null = header?.menus?.length
    ? header.menus.filter((m) => m.active).sort((a, b) => a.order - b.order).map((m) => ({
        id: m.target, label: m.label, vip: m.vip,
        active: (m.target === "home" && section === "retail" && view === "home" && !selectedId)
          || (m.target === "shop" && section === "retail" && (view === "shop" || !!selectedId))
          || (m.target === "vip" && section === "vip") || (m.target === "tryon" && section === "studio" && studioSurface === "tryon")
          || (m.target === "journal" && section === "retail" && view === "journal")
          || ((m.target === "about" || m.target.startsWith("page:")) && section === "page" && pageCode === (m.target === "about" ? "about" : m.target.slice(5))),
        onClick: () => siteNav(m.target),
      }))
    : null;
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
  const openPage = (code: string) => { setPageCode(code); go("page"); };
  /* CMS/server navigation grammar (menus, announcements, footer links, CMS blocks). */
  const siteNav = (target: string) => {
    if (target.startsWith("https://")) { window.open(target, "_blank", "noopener,noreferrer"); return; }
    if (target === "home") return go("retail", "home");
    if (target.startsWith("product:")) { go("retail", "shop"); setSelectedId(target.slice(8)); return; }
    if (target.startsWith("category:")) {
      const slug = target.slice(9);
      go("retail", "shop");
      const known = navTaxonomy?.categories.find((c) => c.slug === slug);
      if (known) { setShopCategory({ name: known.name, nonce: Date.now() }); return; }
      if (!isDemo) siteApi.categories().then((r) => { const c = (r.items as { slug: string; name: string }[]).find((x) => x.slug === slug); if (c) setShopCategory({ name: c.name, nonce: Date.now() }); }).catch(() => undefined);
      return;
    }
    if (target === "shop" || target.startsWith("collection:")) { setShopCategory(null); return go("retail", "shop"); }
    if (target === "journal") return go("retail", "journal");
    if (target === "vip") return go("vip");
    if (target === "tryon") return openStudio("tryon");
    if (target === "builder") return openStudio("builder");
    if (target === "supplier") { window.location.hash = "#/supplier"; return; }
    if (target === "account") return go("retail", "account");
    if (target === "about") return openPage("about");
    if (target.startsWith("page:")) return openPage(target.slice(5));
    if (target.startsWith("vibe:")) return openPage(`vibe-${target.slice(5)}`);
    go("retail", "shop");
  };

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

  const headerLinks = serverLinks?.length ? serverLinks : links;

  return (
    <div ref={rootRef} className="kv-storefront min-h-screen">
      <a href="#kv-sf-main" className="kv-sf-skip">پرش به محتوای اصلی</a>

      {/* CMS announcement — fixed so the floating header offset stays exact */}
      <div ref={announceRef} className="kv-sf-announce">
        <AnnouncementBar block={ops.blocks.find((b) => b.type === "announcement")} onNav={cmsNav} />
      </div>

      <CartToastProvider onViewCart={() => setCartOpen(true)}>
        <FloatingHeader
          links={headerLinks} menuItems={menuItems}
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
              shopCategory={shopCategory}
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
          {section === "page" && (
          <CmsPageView code={pageCode} onNav={siteNav}
            onOpenProduct={(id) => { go("retail", "shop"); setSelectedId(id); }}
            onQuickAdd={(cp) => {
              const variant = cp.variants.find((v) => v.available > 0);
              if (!variant) return false;
              const existing = cart.find((l) => l.id === cp.id && l.size === (variant.size ?? "") && l.color === (variant.color ?? ""));
              setCart(existing ? cart.map((l) => (l === existing ? { ...l, qty: l.qty + 1 } : l)) : [...cart, { id: cp.id, qty: 1, size: variant.size ?? "", color: variant.color ?? "" }]);
              return true;
            }} />
        )}
        {section === "auth" && (
            <AuthScreens portal="retail" onDone={async (phone) => {
              if (isDemo) {
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
                  return;
                }
                /* Production: real backend auth — register (idempotent) then login.
                   The session is only issued after a 2FA challenge is satisfied (Req 351). */
                try {
                  await authApi.register({ phone: digitsOnly(phone), password: "KolbeDemo123456!", displayName: "مشتری کلبه" }).catch(() => undefined);
                  const res = await authApi.login({ identity: digitsOnly(phone), password: "KolbeDemo123456!" });
                  if (res.twoFactorRequired && res.challengeId) {
                    setTwoFactor({ challengeId: res.challengeId, devCode: res.devCode, code: "", error: "" });
                    return;
                  }
                  const me = await authApi.me() as { id: string; displayName: string; roles: string[]; phone?: string };
                  setAuthUser(me);
                } catch { /* stay guest; no silent local account */ }
                // The guest cart merges into the server saved cart in the authUser effect above.
                setGuestWishlist([]);
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
      <Modal open={!!twoFactor} onClose={() => setTwoFactor(null)} max="max-w-[420px]" title="ورود دومرحله‌ای">
        {twoFactor && (
          <form className="space-y-4 pl-10" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await authApi.loginTwoFactor(twoFactor.challengeId, twoFactor.code);
              const me = await authApi.me() as { id: string; displayName: string; roles: string[]; phone?: string };
              setAuthUser(me); setTwoFactor(null);
              setSection(returnTo?.section ?? "retail"); setView(returnTo?.view ?? "account"); setReturnTo(null);
            } catch { setTwoFactor({ ...twoFactor, error: "کد واردشده صحیح نیست یا منقضی شده است." }); }
          }}>
            <p className="text-[17px] font-extrabold">کد تأیید ورود</p>
            <p className="text-[13px] leading-7 text-[var(--kv-muted)]">ورود دومرحله‌ای برای این حساب فعال است. کد ۶ رقمی پیامک‌شده را وارد کنید.</p>
            {twoFactor.devCode && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{twoFactor.devCode}</b></p>}
            <label className="block text-[13px] font-semibold">کد تأیید
              <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={twoFactor.code} onChange={(e) => setTwoFactor({ ...twoFactor, code: e.target.value.replace(/\D/g, ""), error: "" })}
                className="mt-2 h-12 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] text-center text-lg font-bold tracking-[0.3em] outline-none focus:border-[var(--kv-accent)]" dir="ltr" />
            </label>
            {twoFactor.error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{twoFactor.error}</p>}
            <Btn variant="accent" className="w-full" disabled={twoFactor.code.length !== 6}>تأیید و ورود</Btn>
          </form>
        )}
      </Modal>
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
