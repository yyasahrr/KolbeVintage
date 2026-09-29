import { useCallback, useEffect, useState } from "react";
import {
  Radar, Package, ClipboardList, Store, Wallet, Headset, Bell, Menu, AlertTriangle, Check, X, Ban, Eye,
  ShieldCheck, Sun, Moon, LogOut, Warehouse, Users, Crown, ShoppingBag, Tags, Truck, Contact,
  LayoutTemplate, BellRing, Plug, Settings, Plus, Pencil, Trash2,
} from "lucide-react";
import { STATUS_LABEL, fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE, SUB_STATUS, isTerminal, type SubStatus, type VipPlan } from "../data/platform";
import { ParentOrderCard, SubOrderDesk, SupplierChip } from "../components/orders";
import { Btn, Card, Status, SearchBox, Empty, Timeline, Field, Input, Select, Switch, Drawer, Segmented, Textarea, Checkbox } from "../components/primitives";
import { RetailOrders, ShippingAdmin } from "./admin-retail";
import { ProductStudio } from "./admin-product";
import { FinanceCenter, PlansCenter, RestrictionsCenter, ApplicationsCenter } from "./admin-ops";
import { SmsCenter } from "./admin-growth";

import { SeriesTemplateManager } from "./series-templates";
import { useOps } from "../data/ops";
import { Layers, FileSignature, ShieldAlert, MessageSquareText, TicketPercent, Boxes, FileText, ScrollText } from "lucide-react";
import { cn } from "../utils/cn";
import { AdminApiError, apiClient, isAuthenticated, inventoryApi, onAuthExpired, shippingApi, type ApiRequest } from "../data/api";
import { normalizeWarehouses } from "../data/contracts";
import { AdminServerOrders } from "./admin-server-orders";
import { AdminWmsPanel } from "./admin-wms-panel";
import { FinanceLedgerPanel } from "../components/finance-ledger";
import { AuditLogPanel } from "../components/audit-log-panel";
import { CrmPanel } from "../components/crm-panel";
import { PromoPanel } from "../components/promo-panel";
import { CmsCenter } from "./admin-cms";
import { authApi } from "../data/api";
import { IntegrationsPanel } from "../components/integrations-panel";
import { ServerConnectionState } from "../components/server-connection";
import { ModuleBoundary, moduleBoundary } from "../components/boundary";
import { NotificationsPanel } from "../components/notifications-panel";
import { TicketBoardPanel } from "../components/ticket-board-panel";
import { Supplier360Panel } from "../components/supplier-360";
import { InvoiceDocumentsPanel } from "../components/invoice-docs";
import { FinanceOpsPanel } from "../components/finance-ops";
import { ReceiptText, HandCoins } from "lucide-react";

/* ====== Standalone app: KOLBE Admin Console (internal; never linked from the public site) ====== */
export default function AdminApp({ dark, setDark }: { dark: boolean; setDark: (v: boolean) => void }) {
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    if (sessionStorage.getItem("kolbe-admin-auth") !== "1") { setChecking(false); return; }
    let active = true;
    // The shared client owns the token, refresh and retry; the console only gates on permissions.
    apiClient.get<{ permissions: string[] }>("/auth/me").then((me) => {
      if (active && isAuthenticated() && me.permissions.includes("orders:read")) setSignedIn(true);
    }).catch(() => { sessionStorage.removeItem("kolbe-admin-auth"); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);
  // Console requests go through the shared authenticated client (one place for token + single refresh + retry).
  useEffect(() => onAuthExpired(() => { setSignedIn(false); sessionStorage.removeItem("kolbe-admin-auth"); }), []);

  const request = useCallback(<T,>(path: string, init?: RequestInit) => {
    if (!isAuthenticated()) return Promise.reject(new AdminApiError("نشست مدیریت منقضی شده است.", 401));
    return apiClient.request<T>(path, init).catch((error: unknown) => {
        if (error instanceof AdminApiError && error.status === 401) { sessionStorage.removeItem("kolbe-admin-auth"); }
        throw error;
      });
  }, []) as ApiRequest;

  const login = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setAuthError(null);
    try {
      await authApi.login({ identity: email.trim(), password });
      const me = await apiClient.get<{ permissions: string[] }>("/auth/me");
      if (!me.permissions.includes("orders:read")) throw new Error("این حساب دسترسی مدیریت سفارش‌ها را ندارد.");
      setSignedIn(true); sessionStorage.setItem("kolbe-admin-auth", "1"); setPassword("");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "ورود ناموفق بود."); }
    finally { setSubmitting(false); }
  };
  const logout = async () => {
    await authApi.logout().catch(() => undefined);
    setSignedIn(false); sessionStorage.removeItem("kolbe-admin-auth"); setPassword("");
  };
  if (checking) return <div role="status" className="flex min-h-screen items-center justify-center text-sm text-[var(--kv-muted)]">در حال بررسی نشست مدیریت…</div>;
  if (!signedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--kv-bg)] px-4">
        <div className="w-full max-w-[400px]">
          <div className="text-center">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1B2A4A] text-white"><ShieldCheck size={22} /></span>
            <h1 className="mt-4 text-[22px] font-extrabold">کنسول مدیریت کلبه</h1>
            <p className="mt-1.5 text-[13px] text-[var(--kv-muted)]">ورود با حساب ثبت‌شده در سرور</p>
          </div>
          <Card className="mt-6 p-6">
            <form onSubmit={(event) => void login(event)} className="space-y-4">
              <label className="block text-sm font-semibold">ایمیل یا شماره همراه<input type="text" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label>
              <label className="block text-sm font-semibold">گذرواژه<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-bg)] px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]" /></label>
              {authError && <p role="alert" className="text-sm text-[var(--kv-danger)]">{authError}</p>}
              <button type="submit" disabled={submitting} className="min-h-11 w-full rounded-lg bg-[var(--kv-action)] px-4 font-bold text-[var(--kv-bg)] focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)] disabled:opacity-50">{submitting ? "در حال ورود…" : "ورود به کنسول"}</button>
            </form>
          </Card>
          <button onClick={() => setDark(!dark)} className="mx-auto mt-5 flex items-center gap-1.5 text-xs font-semibold text-[var(--kv-muted)]">{dark ? <Sun size={13} /> : <Moon size={13} />}{dark ? "حالت روشن" : "حالت تیره"}</button>
        </div>
      </div>
    );
  }
  return <AdminConsole dark={dark} setDark={setDark} request={request} onLogout={() => void logout()} />;
}

type NavItem = { g: string } | { v: string; label: string; icon: React.ReactNode; badge?: number };

function AdminConsole({ dark, setDark, request, onLogout }: { dark: boolean; setDark: (v: boolean) => void; request: ApiRequest; onLogout: () => void }) {
  const store = useStore();
  const { products, orders, buyers, plans, accounts, setStatus, transitionSub, setBuyer, upsertPlan, removePlan, setTicketStatus } = store;
  const pending = products.filter((p) => p.status === "pending");
  const allSubs = orders.flatMap((o) => (o.subOrders ?? []).map((sub) => ({ parent: o, sub })));
  const kolbeSubs = allSubs.filter((i) => i.sub.supplierId === KOLBE.id);
  const kolbePending = kolbeSubs.filter((i) => i.sub.status === "pending_supplier" || i.sub.status === "paid" || i.sub.status === "preparing");
  const activeSubs = allSubs.filter((i) => !isTerminal(i.sub.status));
  const awaitingPay = allSubs.filter((i) => i.sub.status === "approved");
  const pendingBuyers = buyers.filter((b) => b.status === "در انتظار تأیید");
  const ops = useOps();
  const customerTickets = accounts.flatMap((account) => account.tickets.map((ticket) => ({ account, ticket })));
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  // Settings reads the real warehouses and the configured default fulfillment warehouse.
  const [settingsWarehouses, setSettingsWarehouses] = useState<{ id: string; code: string; name: string }[] | null>(null);
  const [shippingSettings, setShippingSettings] = useState<{ defaultWarehouseId: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [list, settings] = await Promise.all([inventoryApi.warehouses(), shippingApi.settings()]);
        if (!active) return;
        setSettingsWarehouses(normalizeWarehouses(list));
        setShippingSettings(settings);
      } catch { if (active) setSettingsWarehouses([]); }
    })();
    return () => { active = false; };
  }, []);
  // Server-backed dashboard summary — canonical source for sidebar badges (item 12)
  const [summary, setSummary] = useState<{ pendingProducts: number; activeOrders: number; pendingSupplierActions: number; pendingMemberships: number; openTickets: number; pendingReturns: number; pendingWithdrawals: number } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  useEffect(() => {
    if (isDemo) return;
    let live = true;
    apiClient.get<{ pendingProducts: number; activeOrders: number; pendingSupplierActions: number; pendingMemberships: number; openTickets: number; pendingReturns: number; pendingWithdrawals: number }>("/admin/dashboard/summary")
      .then((r) => { if (live) setSummary(r); })
      .catch((e) => { if (live) setSummaryError(e instanceof Error ? e.message : "خطا در دریافت خلاصه داشبورد"); });
    return () => { live = false; };
  }, [isDemo]);
  const badge = (server: number | undefined, local: number): number | undefined => {
    const value = server ?? local;
    return value || undefined;
  };

  const [tab, setTab] = useState("server-orders");
  const [drawer, setDrawer] = useState(false);
  const [side, setSide] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [oq, setOq] = useState("");
  const [of, setOf] = useState<"all" | "active" | "done">("all");
  const [buyerSel, setBuyerSel] = useState<string | null>(null);
  const [planEdit, setPlanEdit] = useState<VipPlan | null>(null);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2800); };

  const nav: NavItem[] = [
    { g: "دادهٔ واقعی" },
    { v: "server-orders", label: "سفارش‌های سرور", icon: <ClipboardList size={17} /> },
    { g: "نمای کلی" },
    { v: "tower", label: "برج کنترل", icon: <Radar size={17} />, badge: badge(summary ? summary.pendingProducts + summary.pendingSupplierActions + summary.pendingMemberships : undefined, pending.length + kolbePending.length + pendingBuyers.length) },
    { g: "بازار عمده" },
    { v: "worders", label: "سفارش‌های عمده", icon: <ClipboardList size={17} />, badge: badge(summary?.activeOrders, activeSubs.length) },
    { v: "kolbe", label: "میز عملیات کلبه", icon: <Warehouse size={17} />, badge: kolbePending.length || undefined },
    { v: "wproducts", label: "محصولات و بازبینی", icon: <Package size={17} />, badge: badge(summary?.pendingProducts, pending.length) },
    { v: "series", label: "قالب‌های سری کلبه", icon: <Layers size={17} /> },
    { v: "suppliers", label: "تأمین‌کنندگان ۳۶۰°", icon: <Store size={17} /> },
    { v: "supplier-docs", label: "اسناد و صورت‌حساب", icon: <ReceiptText size={17} /> },
    { v: "applications", label: "درخواست همکاری", icon: <FileSignature size={17} />, badge: badge(summary?.pendingSupplierActions, ops.applications.filter((a) => a.status === "new").length) },
    { v: "buyers", label: "خریداران عمده", icon: <Users size={17} />, badge: badge(summary?.pendingMemberships, pendingBuyers.length) },
    { v: "plans", label: "پلن‌های عضویت", icon: <Crown size={17} /> },
    { g: "خرده‌فروشی" },
    { v: "rorders", label: "سفارش‌های خرده", icon: <ShoppingBag size={17} /> },
    { v: "rproducts", label: "تعریف محصول", icon: <Tags size={17} /> },
    { v: "shipping", label: "حمل‌ونقل", icon: <Truck size={17} /> },
    { v: "wms", label: "انبار و موجودی (WMS)", icon: <Boxes size={17} /> },
    { v: "crm", label: "مشتریان (CRM)", icon: <Contact size={17} /> },
    { v: "promo", label: "کوپن و جشنواره", icon: <TicketPercent size={17} /> },
    { v: "cms", label: "محتوا (CMS)", icon: <LayoutTemplate size={17} /> },
    { v: "sms", label: "پنل پیامک", icon: <MessageSquareText size={17} /> },
    { v: "notifs", label: "اعلان‌ها", icon: <BellRing size={17} /> },
    { v: "finance", label: "مالی و تسویه", icon: <Wallet size={17} />, badge: badge(summary?.pendingWithdrawals, ops.withdrawals.filter((w) => w.status === "requested").length + Object.values(ops.banks).filter((b) => b.status === "pending").length) },
    { v: "finance-ledger", label: "دفتر کل", icon: <ScrollText size={17} /> },
    { v: "finance-wallet", label: "کیف پول و کارمزد", icon: <HandCoins size={17} /> },
    { v: "integrations", label: "یکپارچه‌سازی‌ها", icon: <Plug size={17} /> },
    { g: "سیستم" },
    { v: "support", label: "تیکت و مرجوعی", icon: <Headset size={17} />, badge: badge(summary ? summary.openTickets + summary.pendingReturns : undefined, ops.tickets.filter((t) => t.status !== "closed").length + ops.returns.filter((r) => r.status === "requested").length) },
    { v: "audit", label: "گزارش حسابرسی", icon: <FileText size={17} /> },
    { v: "restrictions", label: "محدودیت کاربران", icon: <ShieldAlert size={17} /> },
    { v: "settings", label: "تنظیمات و دسترسی", icon: <Settings size={17} /> },
  ];
  const titles: Record<string, [string, string]> = {
    "server-orders": ["سفارش‌های واقعی", "خواندن و مدیریت سفارش‌های ثبت‌شده در PostgreSQL"],
    tower: ["برج کنترل عملیات", "همه صف‌ها بر اساس فوریت"],
    worders: ["سفارش‌های عمده در جریان", "سفارش مادر و زیرسفارش‌های هر تأمین‌کننده"],
    kolbe: ["میز عملیات کلبه", "تأیید، آماده‌سازی و ارسال زیرسفارش‌های محصولات خود کلبه"],
    wproducts: ["محصولات بازارچه و بازبینی", "تأیید محصولات تأمین‌کنندگان برای ورود به بازارچه عمده"],
    suppliers: ["تأمین‌کنندگان ۳۶۰°", "وضعیت فعالیت، محدودیت‌ها، عملکرد و حساب مالی هر تأمین‌کننده"],
    "supplier-docs": ["اسناد و صورت‌حساب", "قالب‌های نسخه‌دار، صدور/ابطال/بازپرداخت و صورت‌حساب تأمین‌کننده"],
    "finance-wallet": ["کیف پول، کارمزد و برداشت", "نمای عملیاتی پرداخت‌های تأمین‌کننده و تأیید برداشت‌ها"],
    buyers: ["مدیریت خریداران عمده", "تأیید عضویت، پلن و وضعیت حساب"],
    plans: ["پلن‌های عضویت عمده", "تعریف سطوح، اعتبار و قابلیت‌ها"],
    rorders: ["سفارش‌های خرده", "آماده‌سازی، ارسال، مرجوعی"],
    rproducts: ["تعریف محصول", "کاتالوگ کامل، واریانت‌ها، سئو و کانال‌های فروش"],
    shipping: ["حمل‌ونقل", "روش‌های ارسال خرده و عمده"],
    wms: ["انبار و موجودی (WMS)", "موجودی قابل فروش، رزرو، ورودی و آسیب‌دیده — انتقال و رسید"],
    crm: ["مدیریت ارتباط با مشتری", "بخش‌بندی، پروفایل ۳۶۰ و کمپین"],
    cms: ["مدیریت محتوا", "صفحات، بنرها و مجله"],
    notifs: ["سیستم اعلان", "قالب‌های رویدادی و ارسال دستی"],
    finance: ["مرکز عملیات مالی", "دفتر کل دوسویه، حساب تأمین‌کنندگان، تسویه، مغایرت‌یابی، پیش‌پرداخت، گزارش و دوره‌ها"],
    "finance-ledger": ["دفتر کل", "روزنامه، حساب‌ها، بدهکار/بستانکار و مغایرت"],
    integrations: ["یکپارچه‌سازی‌ها", "CRM، حسابداری، پیامک، پرداخت و لجستیک"],
    support: ["پشتیبانی و تیکت‌ها", "SLA و صف پاسخ‌گویی"],
    audit: ["گزارش حسابرسی", "تمام عملیات حساس با actor, IP, مقدار قبلی/جدید"],
    settings: ["تنظیمات و دسترسی", "نقش‌ها، انبارها و اطلاعات فروشگاه"],
    series: ["قالب‌های سری کلبه", "یک‌بار تعریف کنید، در تعریف محصول انتخاب کنید"],
    applications: ["درخواست‌های همکاری تأمین‌کنندگان", "طراحی فرم و بررسی درخواست‌ها"],
    promo: ["کوپن و جشنواره", "کدهای تخفیف خرده و عمده و جشنواره‌های زمان‌دار"],
    sms: ["پنل پیامک", "اتصال سرویس‌دهنده و ارسال همگانی"],
    restrictions: ["محدودیت کاربران", "مسدودسازی و محدودیت دسترسی تأمین‌کنندگان و کاربران"],
  };
  const [t, d] = titles[tab] ?? titles.tower;

  const kolbeTransition = (pid: string, sid: string, status: SubStatus, extra?: { note?: string; tracking?: string; eta?: string }) => {
    transitionSub(pid, sid, status, "تیم عملیات کلبه", extra);
    flash(`${sid}: ${SUB_STATUS[status].label}`);
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 pb-4 pt-6">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[#1B2A4A] text-sm font-bold text-[#E8D9C3]">KV</span>
        <div><p className="text-sm font-extrabold">کنسول مدیریت</p><p className="text-[11.5px] text-[var(--kv-muted)]">دسترسی کامل · ادمین ارشد</p></div>
      </div>
      <nav className="kv-scroll flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {nav.map((n, i) =>
          "g" in n ? <p key={i} className="px-3 pb-1 pt-4 text-[11px] font-bold text-[var(--kv-faint)]">{n.g}</p> : (
            <button key={n.v} onClick={() => { setTab(n.v); setDrawer(false); setSide(null); }}
              className={cn("kv-press flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold",
                tab === n.v ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527] shadow" : "text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]")}>
              {n.icon}{n.label}
              {n.badge && <span className="mr-auto rounded-full bg-[var(--kv-danger)] px-2 py-0.5 text-[10.5px] font-bold text-white tabular-nums">{fmtNum(n.badge)}</span>}
              {summaryError && !isDemo && <p role="alert" className="px-2 py-1 text-[10.5px] leading-5 text-[var(--kv-muted)]">خلاصه سرور در دسترس نیست — اعداد محلی موقت است.</p>}
            </button>
          )
        )}
      </nav>
      <div className="space-y-1 border-t border-[var(--kv-line)] p-3">
        {sessionStorage.getItem("kolbe-preview") === "1" && <button onClick={() => { window.location.hash = "#/"; }} className="kv-press flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]"><Store size={16} />بازگشت به فروشگاه</button>}
        <button onClick={() => setDark(!dark)} className="kv-press flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold text-[var(--kv-ink-2)] hover:bg-[var(--kv-surface-2)]">{dark ? <Sun size={16} /> : <Moon size={16} />}{dark ? "حالت روشن" : "حالت تیره"}</button>
        <button onClick={onLogout} className="kv-press flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold text-[var(--kv-danger)] hover:bg-[var(--kv-danger)]/[0.06]"><LogOut size={16} />خروج از کنسول</button>
      </div>
    </div>
  );

  const queues = [
    { t: "زیرسفارش‌های کلبه نیازمند اقدام", d: kolbePending.length ? `${fmtNum(kolbePending.length)} مورد: تأیید، آماده‌سازی یا ارسال` : "صف خالی است", n: kolbePending.length, tone: "terracotta", tab: "kolbe" },
    { t: "بازبینی محصول تأمین‌کنندگان", d: pending.length ? `${fmtNum(pending.length)} محصول منتظر ورود به بازارچه` : "صف خالی است", n: pending.length, tone: "ochre", tab: "wproducts" },
    { t: "درخواست عضویت عمده", d: pendingBuyers.length ? pendingBuyers.map((b) => b.name.split(" — ")[0]).join("، ") : "درخواستی نیست", n: pendingBuyers.length, tone: "navy", tab: "buyers" },
    { t: "منتظر پرداخت خریدار", d: `${fmtNum(awaitingPay.length)} زیرسفارش تأیید شده · یادآوری خودکار ۲۴ ساعته`, n: awaitingPay.length, tone: "navy", tab: "worders" },
    { t: "زیرسفارش در جریان", d: "همه تأمین‌کنندگان و کلبه", n: activeSubs.length, tone: "ochre", tab: "worders" },
    { t: "تیکت نزدیک به نقض SLA", d: "پشتیبانی خرده و عمده", n: 5, tone: "brick", tab: "support" },
  ];
  const toneBg: Record<string, string> = {
    terracotta: "bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]",
    navy: "bg-[#1B2A4A]/10 text-[#1B2A4A] dark:text-[#B9C4D8] dark:bg-white/10",
    ochre: "bg-[#B98A2F]/10 text-[#8A6420] dark:text-[#D6A94E]",
    brick: "bg-[#A8483C]/10 text-[#8A3B30] dark:text-[#D07A6A]",
  };
  const feed = allSubs.flatMap((i) => (i.sub.events ?? []).map((e) => ({ ...e, sub: i.sub.id, buyer: i.parent.buyer }))).slice(-7).reverse();

  const filteredOrders = orders.filter((o) => {
    const q = oq.trim();
    if (q && !o.id.includes(q) && !o.buyer?.includes(q) && !(o.subOrders ?? []).some((s) => s.supplierName.includes(q))) return false;
    if (of === "active") return (o.subOrders ?? []).some((s) => !isTerminal(s.status));
    if (of === "done") return (o.subOrders ?? []).length > 0 && (o.subOrders ?? []).every((s) => isTerminal(s.status));
    return true;
  });

  return (
    <div className="mx-auto w-full max-w-[1600px] pb-16 md:px-5">
      <div className="flex min-h-screen gap-5 pt-4">
        <aside className="sticky top-4 hidden h-[calc(100vh-32px)] w-[250px] shrink-0 overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm lg:block">{sidebar}</aside>
        {drawer && (
          <div className="fixed inset-0 z-[70] lg:hidden">
            <div className="absolute inset-0 bg-black/45" onClick={() => setDrawer(false)} />
            <aside className="absolute right-0 top-0 h-full w-[270px] bg-[var(--kv-surface)]">{sidebar}</aside>
          </div>
        )}

        <div className="min-w-0 flex-1 px-4 md:px-2">
          <div className="kv-glass sticky top-4 z-30 mb-5 flex items-center gap-3 rounded-[14px] px-4 py-2.5">
            <button className="lg:hidden" onClick={() => setDrawer(true)} aria-label="منو"><Menu size={19} /></button>
            <div className="min-w-0"><h1 className="truncate text-[15px] font-extrabold">{t}</h1><p className="hidden truncate text-xs text-[var(--kv-muted)] sm:block">{d}</p></div>
            <div className="mr-auto flex items-center gap-2">
              <div className="hidden w-64 md:block"><SearchBox placeholder="جست‌وجوی سراسری: سفارش، محصول، کاربر… (⌘K)" /></div>
              <button onClick={() => setTab("tower")} className="kv-press relative flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)]" aria-label="اعلان‌ها"><Bell size={16} />{(pending.length + kolbePending.length) > 0 && <span className="absolute left-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--kv-danger)] px-1 text-[9px] font-bold text-white tabular-nums">{fmtNum(pending.length + kolbePending.length)}</span>}</button>
            </div>
          </div>

          {moduleBoundary("وضعیت اتصال", <ServerConnectionState tab={tab} key={tab} />)}
          <ModuleBoundary name={t} key={tab}>
          {tab === "server-orders" && <AdminServerOrders request={request} />}

          {/* ---------- Tower ---------- */}
          {tab === "tower" && (
            <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {queues.map((q) => (
                  <button key={q.t} onClick={() => setTab(q.tab)} className="kv-press flex items-center gap-3.5 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 text-right kv-shadow-sm hover:border-[var(--kv-line-strong)]">
                    <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] text-lg font-extrabold tabular-nums", toneBg[q.tone])}>{fmtNum(q.n)}</span>
                    <span className="min-w-0"><span className="block text-[13.5px] font-extrabold">{q.t}</span><span className="mt-0.5 block truncate text-xs text-[var(--kv-muted)]">{q.d}</span></span>
                  </button>
                ))}
              </div>
              <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
                <Card className="p-0">
                  <p className="p-5 pb-3 text-[14px] font-extrabold">اقدامات فوری</p>
                  <div className="kv-scroll max-h-[400px] space-y-2 overflow-y-auto px-5 pb-5">
                    {kolbePending.map(({ parent, sub }) => (
                      <button key={sub.id} onClick={() => setTab("kolbe")} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-right hover:border-[var(--kv-line-strong)]">
                        <span className="h-8 w-1 shrink-0 rounded-full bg-[var(--kv-accent)]" />
                        <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-bold">{sub.id} · {parent.buyer}</p><p className="truncate text-xs text-[var(--kv-muted)]">{(sub.lines ?? []).map((l) => l.name).join("، ")} · {fmtMoney(sub.total)}</p></div>
                        <Status value={SUB_STATUS[sub.status].label} />
                      </button>
                    ))}
                    {pending.map((p) => (
                      <button key={p.id} onClick={() => { setTab("wproducts"); setSide(p.id); }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-right hover:border-[var(--kv-line-strong)]">
                        <span className="h-8 w-1 shrink-0 rounded-full bg-[#D6A94E]" />
                        <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-bold">بازبینی «{p.name}»</p><p className="truncate text-xs text-[var(--kv-muted)]">{p.supplier} · {fmtMoney(p.wholesaleFrom)} / سری</p></div>
                        <Status value="در انتظار تأیید" />
                      </button>
                    ))}
                    {pendingBuyers.map((b) => (
                      <button key={b.id} onClick={() => { setTab("buyers"); setBuyerSel(b.id); }} className="flex w-full items-center gap-3 rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-right hover:border-[var(--kv-line-strong)]">
                        <span className="h-8 w-1 shrink-0 rounded-full bg-[#1B2A4A]" />
                        <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-bold">عضویت عمده «{b.name}»</p><p className="truncate text-xs text-[var(--kv-muted)]">{b.city} · مدارک بارگذاری شده</p></div>
                        <Status value="در انتظار تأیید" />
                      </button>
                    ))}
                    {kolbePending.length + pending.length + pendingBuyers.length === 0 && <p className="py-6 text-center text-[13px] text-[var(--kv-muted)]">همه صف‌ها خالی است.</p>}
                  </div>
                </Card>
                <Card className="p-5">
                  <p className="text-[14px] font-extrabold">فعالیت زنده بازارچه</p>
                  <div className="mt-4"><Timeline items={feed.map((e) => ({ t: e.t, d: `${e.sub} · ${e.buyer} · ${e.by}`, time: e.time, done: true }))} /></div>
                </Card>
              </div>
            </div>
          )}

          {/* ---------- Wholesale orders ---------- */}
          {tab === "worders" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 flex flex-wrap items-center gap-2.5">
                <div className="min-w-[220px] flex-1"><SearchBox value={oq} onChange={setOq} placeholder="شماره سفارش، خریدار یا تأمین‌کننده…" /></div>
                <Segmented<"all" | "active" | "done"> options={[{ v: "all", label: "همه" }, { v: "active", label: "در جریان" }, { v: "done", label: "بسته‌شده" }]} value={of} onChange={setOf} />
              </div>
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {[["در انتظار تأیید تأمین‌کننده", allSubs.filter((i) => i.sub.status === "pending_supplier").length], ["منتظر پرداخت", awaitingPay.length], ["آماده‌سازی و ارسال", allSubs.filter((i) => ["paid", "preparing", "shipped"].includes(i.sub.status)).length], ["رد/لغو شده", allSubs.filter((i) => i.sub.status === "rejected" || i.sub.status === "cancelled").length]].map(([l, n]) => (
                  <Card key={l as string} className="p-3.5"><p className="text-lg font-extrabold tabular-nums">{fmtNum(n as number)}</p><p className="text-xs text-[var(--kv-muted)]">{l as string}</p></Card>
                ))}
              </div>
              {filteredOrders.length === 0 ? <Empty title="سفارشی پیدا نشد" desc="عبارت یا فیلتر دیگری را امتحان کنید." /> : (
                <div className="space-y-3">
                  {filteredOrders.map((o, i) => (
                    <ParentOrderCard key={o.id} order={o} perspective="admin" defaultOpen={i === 0} onCancelSub={(sid) => { transitionSub(o.id, sid, "cancelled", "کلبه (ادمین)", { note: "لغو توسط پشتیبانی کلبه" }); flash(`${sid} لغو شد و به خریدار و تأمین‌کننده اطلاع داده شد`); }} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ---------- Kolbe ops desk ---------- */}
          {tab === "kolbe" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 flex flex-wrap items-center gap-3 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-4 py-3 text-[12.5px] leading-6 text-[var(--kv-muted)]">
                <SupplierChip id={KOLBE.id} name={KOLBE.name} />برای محصولات خود کلبه، تیم عملیات نقش تأمین‌کننده را دارد: تأیید امکان تأمین ← (پرداخت خریدار) ← آماده‌سازی ← ارسال.
              </div>
              <SubOrderDesk items={kolbeSubs} actor="تیم عملیات کلبه" onTransition={kolbeTransition} emptyTitle="زیرسفارشی برای کلبه نیست" emptyDesc="سفارش‌های محصولات کلبه وینتیج اینجا مدیریت می‌شود." />
            </div>
          )}

          {/* ---------- Wholesale products / review ---------- */}
          {tab === "wproducts" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[760px]">
                    <thead><tr><th>محصول</th><th>مالک</th><th>قیمت سری از</th><th>حداقل</th><th>موجودی</th><th>وضعیت</th><th></th></tr></thead>
                    <tbody>
                      {[...pending, ...products.filter((p) => p.status !== "pending")].map((p) => (
                        <tr key={p.id} className={cn(side === p.id && "bg-[var(--kv-accent)]/[0.05]")}>
                          <td><span className="flex items-center gap-2.5"><img src={p.images?.[0] ?? undefined} alt="" className="h-10 w-9 rounded-lg object-cover" /><b className="whitespace-nowrap">{p.name}</b></span></td>
                          <td><SupplierChip id={p.supplierId} name={p.supplier} /></td>
                          <td className="font-bold tabular-nums">{fmtMoney(p.wholesaleFrom)}</td>
                          <td className="tabular-nums">{fmtNum(p.moq)} سری</td>
                          <td className="tabular-nums">{fmtNum(p.stock)}</td>
                          <td><Status value={p.status === "published" ? "فعال" : STATUS_LABEL[p.status ?? "published"]} /></td>
                          <td><button onClick={() => setSide(p.id)} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline"><Eye size={13} />بازبینی</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-[var(--kv-line)] px-5 py-3 text-xs text-[var(--kv-muted)]">
                  <span>{fmtNum(products.length)} محصول · {fmtNum(pending.length)} در صف بازبینی</span>
                  <Btn variant="soft" size="sm" disabled={pending.length === 0} onClick={() => { pending.forEach((p) => setStatus(p.id, "published")); flash(`${fmtNum(pending.length)} محصول تأیید و در بازارچه منتشر شد`); }}>تأیید همه موارد صف</Btn>
                </div>
              </Card>
              <Card className="h-fit p-5">
                {!side ? <Empty title="محصولی انتخاب نشده" desc="روی «بازبینی» هر سطر بزنید." /> : (() => {
                  const p = products.find((x) => x.id === side);
                  if (!p) return <Empty title="محصولی انتخاب نشده" desc="روی «بازبینی» هر سطر بزنید." />;
                  return (
                    <div>
                      <img src={p.images?.[0] ?? undefined} alt="" className="aspect-[16/10] w-full rounded-[12px] object-cover" />
                      <h3 className="mt-3 text-[15px] font-extrabold">{p.name}</h3>
                      <p className="text-xs text-[var(--kv-muted)]">{p.sku} · {p.supplier}</p>
                      <div className="mt-3 space-y-1.5 text-[12.5px]">
                        <div className="flex justify-between"><span className="text-[var(--kv-muted)]">قیمت سری</span><b className="tabular-nums">{fmtMoney(p.wholesaleFrom)}</b></div>
                        <div className="flex justify-between"><span className="text-[var(--kv-muted)]">حداقل سفارش</span><b className="tabular-nums">{fmtNum(p.moq)} سری</b></div>
                        <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تعداد سری</span><b className="tabular-nums">{fmtNum(p.series.length)}</b></div>
                        <div className="flex justify-between"><span className="text-[var(--kv-muted)]">وضعیت</span><Status value={p.status === "published" ? "فعال" : STATUS_LABEL[p.status ?? "published"]} /></div>
                      </div>
                      <div className="mt-3 space-y-2 border-t border-[var(--kv-line)] pt-3">{p.series.map((series) => <div key={series.id} className="rounded-[10px] bg-[var(--kv-surface-2)]/60 p-3 text-[11.5px]"><p className="font-bold">{series.name} · {fmtNum(series.pieces)} تکه · {series.available ? "فعال" : "غیرفعال"}</p><p className="mt-1 text-[var(--kv-muted)]">{Object.entries(series.composition).filter(([, n]) => n > 0).map(([s, n]) => `${s}×${fmtNum(n)}`).join("، ")}</p><p className="mt-1 font-semibold">{fmtMoney(series.pricePerSeries)} / سری · حداقل {fmtNum(series.moqSeries)} سری</p><p className="mt-1 text-[var(--kv-muted)]">رنگ‌های مجاز: {(series.colorIds ?? p.colors.map((c) => c.id)).map((id) => p.colors.find((c) => c.id === id)?.name ?? id).join("، ")}</p></div>)}</div>
                      <p className="mt-3 text-[12px] leading-6 text-[var(--kv-muted)]">{p.desc}</p>
                      <div className="mt-4 grid grid-cols-2 gap-2">
                        {p.status === "published" ? (
                          <Btn variant="soft" size="sm" className="col-span-2" onClick={() => { setStatus(p.id, "draft"); flash("محصول از بازارچه عمده خارج شد"); }} icon={<Ban size={14} />}>توقف نمایش در بازارچه</Btn>
                        ) : (
                          <>
                            <Btn variant="accent" size="sm" onClick={() => { setStatus(p.id, "published"); flash(`«${p.name}» تأیید و در بازارچه عمده منتشر شد`); }} icon={<Check size={14} />}>تأیید و انتشار</Btn>
                            <Btn variant="soft" size="sm" disabled={p.status === "rejected"} onClick={() => { setStatus(p.id, "rejected"); flash("به تأمین‌کننده برگشت خورد"); }} icon={<X size={14} />}>رد</Btn>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </Card>
            </div>
          )}

          {/* ---------- Suppliers (360°: items 11-14) ---------- */}
          {tab === "suppliers" && moduleBoundary("تأمین‌کنندگان ۳۶۰°", <Supplier360Panel flash={flash} />)}
          {tab === "supplier-docs" && moduleBoundary("اسناد و صورت‌حساب", <InvoiceDocumentsPanel flash={flash} />)}

          {/* ---------- Buyers ---------- */}
          {tab === "buyers" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[760px]">
                    <thead><tr><th>خریدار</th><th>شهر</th><th>پلن</th><th>سفارش‌ها</th><th>ارزش خرید</th><th>وضعیت</th><th></th></tr></thead>
                    <tbody>
                      {buyers.map((b) => (
                        <tr key={b.id} className={cn(buyerSel === b.id && "bg-[var(--kv-accent)]/[0.05]")}>
                          <td><b>{b.name}</b><span className="block text-[11px] text-[var(--kv-muted)]">از {b.since} · {b.contact}</span></td><td>{b.city}</td>
                          <td><span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">{plans.find((p) => p.id === b.planId)?.name ?? b.planId}</span></td>
                          <td className="tabular-nums">{fmtNum(orders.filter((o) => o.buyer === b.name).length)}</td>
                          <td className="font-bold tabular-nums">{fmtMoney(b.spent)}</td>
                          <td><Status value={b.status} /></td>
                          <td><button onClick={() => setBuyerSel(b.id)} className="text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline">مدیریت</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card className="h-fit p-5">
                {(() => {
                  const b = buyers.find((x) => x.id === buyerSel);
                  if (!b) return <Empty title="خریداری انتخاب نشده" desc="روی «مدیریت» بزنید تا پرونده باز شود." />;
                  const bo = orders.filter((o) => o.buyer === b.name);
                  return (
                    <div>
                      <p className="text-[15px] font-extrabold">{b.name}</p>
                      <p className="text-xs text-[var(--kv-muted)]">{b.city} · {b.contact}</p>
                      {b.accountId && <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">مرتبط با همان حساب مشتری: {accounts.find((a) => a.id === b.accountId)?.name ?? b.accountId}</p>}
                      <div className="mt-3"><Status value={b.status} /></div>
                      <div className="mt-4 space-y-3">
                        <Field label="پلن عضویت"><Select options={plans.map((p) => p.name)} value={plans.find((p) => p.id === b.planId)?.name} onChange={(v) => { const p = plans.find((x) => x.name === v); if (p) { setBuyer(b.id, { planId: p.id }); flash(`پلن ${b.name} به ${p.name} تغییر کرد`); } }} /></Field>
                        {b.tradeCode && <p className="text-[12px] text-[var(--kv-muted)]">شناسه صنفی: <b className="text-[var(--kv-ink)]">{b.tradeCode}</b> · ثبت: {b.submittedAt}</p>}
                        <div className="rounded-[12px] bg-[var(--kv-surface-2)]/60 px-3.5 py-3 text-[12.5px]"><p className="flex justify-between"><span className="text-[var(--kv-muted)]">سفارش‌ها</span><b className="tabular-nums">{fmtNum(bo.length)}</b></p><p className="mt-1 flex justify-between"><span className="text-[var(--kv-muted)]">زیرسفارش باز</span><b className="tabular-nums">{fmtNum(bo.flatMap((o) => o.subOrders ?? []).filter((s) => !isTerminal(s.status)).length)}</b></p></div>
                        {b.status === "در انتظار تأیید" ? (
                          <div className="grid grid-cols-2 gap-2">
                            <Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => { setBuyer(b.id, { status: "فعال" }); flash(`عضویت عمده ${b.name} تأیید شد؛ قیمت‌ها برایش فعال است`); }}>تأیید عضویت</Btn>
                            <Btn variant="soft" size="sm" icon={<X size={14} />} onClick={() => { setBuyer(b.id, { status: "مسدود" }); flash("درخواست رد شد"); }}>رد</Btn>
                          </div>
                        ) : b.status === "فعال"
                          ? <Btn variant="soft" size="sm" className="w-full" icon={<Ban size={14} />} onClick={() => { setBuyer(b.id, { status: "مسدود" }); flash(`${b.name} مسدود شد`); }}>مسدودسازی حساب</Btn>
                          : <Btn variant="soft" size="sm" className="w-full" onClick={() => { setBuyer(b.id, { status: "فعال" }); flash(`${b.name} فعال شد`); }}>فعال‌سازی مجدد</Btn>}
                      </div>
                    </div>
                  );
                })()}
              </Card>
            </div>
          )}

          {/* ---------- Plans ---------- */}
          {tab === "plans" && <PlansCenter flash={flash} />}
          {tab === "series" && <div className="animate-[fadeUp_0.35s_ease]"><SeriesTemplateManager ownerId={KOLBE.id} ownerLabel="کلبه وینتیج" /></div>}
          {tab === "applications" && <ApplicationsCenter flash={flash} />}
          {tab === "restrictions" && <RestrictionsCenter flash={flash} />}
          {tab === "support" && <TicketBoardPanel />}
          {tab === "plans-legacy" && (
            <div className="animate-[fadeUp_0.35s_ease]">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-[13px] text-[var(--kv-muted)]">این پلن‌ها در صفحه عضویت بازارچه عمده به خریداران نمایش داده می‌شود.</p>
                <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => setPlanEdit({ id: `plan-${Date.now()}`, name: "", yearly: 0, creditLimit: 0, features: [], active: true })}>پلن جدید</Btn>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {plans.map((p) => (
                  <Card key={p.id} className={cn("flex flex-col p-5", !p.active && "opacity-60")}>
                    <div className="flex items-center justify-between"><p className="text-[16px] font-extrabold">{p.name}</p><div className="flex items-center gap-2">{p.recommended && <span className="rounded-full bg-[var(--kv-accent)]/12 px-2 py-0.5 text-[10.5px] font-bold text-[var(--kv-accent)]">پیشنهادی</span>}<Switch on={p.active} onToggle={() => { upsertPlan({ ...p, active: !p.active }); flash(`پلن ${p.name} ${p.active ? "غیرفعال" : "فعال"} شد`); }} /></div></div>
                    <p className="mt-2 text-[18px] font-extrabold tabular-nums">{p.yearly === 0 ? "رایگان" : fmtMoney(p.yearly)}{p.yearly > 0 && <span className="text-[11px] font-medium text-[var(--kv-muted)]"> / سال</span>}</p>
                    <p className="text-xs text-[var(--kv-muted)]">اعتبار: {p.creditLimit ? fmtMoney(p.creditLimit) : "—"} · {fmtNum(buyers.filter((b) => b.planId === p.id).length)} عضو</p>
                    <ul className="mt-3 flex-1 space-y-1.5 text-[12.5px]">{p.features.map((f) => <li key={f} className="flex items-center gap-1.5"><Check size={13} className="text-[var(--kv-success)]" />{f}</li>)}</ul>
                    <div className="mt-4 flex gap-2"><Btn variant="soft" size="sm" icon={<Pencil size={13} />} onClick={() => setPlanEdit(p)}>ویرایش</Btn><Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={buyers.some((b) => b.planId === p.id)} onClick={() => { removePlan(p.id); flash("پلن حذف شد"); }}>حذف</Btn></div>
                  </Card>
                ))}
              </div>
              <Drawer open={!!planEdit} onClose={() => setPlanEdit(null)} title={planEdit?.name ? `ویرایش پلن ${planEdit.name}` : "پلن جدید"}>
                {planEdit && (
                  <div className="space-y-4">
                    <Field label="نام پلن"><Input value={planEdit.name} onChange={(v) => setPlanEdit({ ...planEdit, name: v })} /></Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="هزینه سالانه (تومان)" hint="۰ = رایگان"><Input value={String(planEdit.yearly)} onChange={(v) => setPlanEdit({ ...planEdit, yearly: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
                      <Field label="سقف اعتبار"><Input value={String(planEdit.creditLimit)} onChange={(v) => setPlanEdit({ ...planEdit, creditLimit: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
                    </div>
                    <Field label="قابلیت‌ها" hint="هر خط یک قابلیت"><Textarea rows={5} value={planEdit.features.join("\n")} onChange={(v) => setPlanEdit({ ...planEdit, features: v.split("\n").map((x) => x.trim()).filter(Boolean) })} /></Field>
                    <Checkbox checked={!!planEdit.recommended} onChange={(v) => setPlanEdit({ ...planEdit, recommended: v })} label="نمایش به‌عنوان پیشنهاد کلبه" />
                    <Btn variant="accent" className="w-full" disabled={!planEdit.name.trim()} onClick={() => { upsertPlan(planEdit); setPlanEdit(null); flash(`پلن ${planEdit.name} ذخیره شد`); }}>ذخیره پلن</Btn>
                  </div>
                )}
              </Drawer>
            </div>
          )}

          {/* ---------- Retail modules ---------- */}
          {tab === "rorders" && moduleBoundary("سفارش‌های خرده", <RetailOrders flash={flash} />)}
          {tab === "rproducts" && moduleBoundary("تعریف محصول", <ProductStudio flash={flash} />)}
          {tab === "shipping" && moduleBoundary("حمل‌ونقل", <ShippingAdmin flash={flash} />)}
          {tab === "wms" && moduleBoundary("انبار و موجودی", <AdminWmsPanel />)}
          {tab === "crm" && moduleBoundary("مشتریان", <CrmPanel />)}
          {tab === "cms" && moduleBoundary("محتوا", <CmsCenter flash={flash} />)}
          {tab === "notifs" && moduleBoundary("اعلان‌ها", <NotificationsPanel />)}
          {tab === "finance" && moduleBoundary("مرکز عملیات مالی", <FinanceOpsPanel flash={flash} />)}
          {tab === "finance-ledger" && moduleBoundary("دفتر کل", <FinanceLedgerPanel />)}
          {tab === "finance-wallet" && moduleBoundary("کیف پول و کارمزد", <FinanceCenter flash={flash} />)}
          {tab === "integrations" && moduleBoundary("یکپارچه‌سازی‌ها", <IntegrationsPanel />)}
          {tab === "promo" && moduleBoundary("کوپن و جشنواره", <PromoPanel />)}
          {tab === "sms" && moduleBoundary("پنل پیامک", <SmsCenter flash={flash} />)}

          {/* ---------- Support ---------- */}
          {tab === "audit" && <AuditLogPanel />}
          {tab === "support-legacy" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] lg:grid-cols-[1fr_360px]">
              <Card className="overflow-hidden">
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[640px]">
                    <thead><tr><th>تیکت</th><th>موضوع</th><th>کاربر</th><th>کانال</th><th>اولویت</th><th>وضعیت</th><th>اقدام / SLA</th></tr></thead>
                    <tbody>
                      {customerTickets.map(({ account, ticket }) => <tr key={ticket.id}>
                        <td className="font-bold tabular-nums">{ticket.id}</td><td><b>{ticket.subject}</b><p className="max-w-[240px] truncate text-[11px] text-[var(--kv-muted)]">{ticket.message}</p></td><td>{account.name}</td><td>حساب مشتری</td><td>عادی</td><td><Status value={ticket.status} /></td>
                        <td>{ticket.status === "در انتظار" ? <button onClick={() => { setTicketStatus(account.id, ticket.id, "در حال بررسی"); flash("تیکت به کارشناس ارجاع شد"); }} className="text-[12px] font-bold text-[var(--kv-accent)]">شروع بررسی</button> : ticket.status === "در حال بررسی" ? <button onClick={() => { setTicketStatus(account.id, ticket.id, "تأیید شد"); flash("تیکت بسته شد"); }} className="text-[12px] font-bold text-[var(--kv-success)]">بستن تیکت</button> : <span className="text-[var(--kv-muted)]">بسته</span>}</td>
                      </tr>)}
                      {[
                        ["#4412", "تأخیر باربری زیرسفارش WO-1004-2", "پوشاک رادین", "عمده", "بالا", "در حال بررسی", "۲ ساعت"],
                        ["#4410", "اعتراض به رد زیرسفارش WO-1003-3", "بوتیک آوا", "عمده", "بالا", "در انتظار", "۴ ساعت"],
                        ["#4408", "درخواست مرجوعی KV-88176", "امیر رضایی", "خرده", "متوسط", "در حال بررسی", "۸ ساعت"],
                        ["#4405", "خطای آپلود تصویر محصول", "فراسو", "تأمین‌کننده", "پایین", "در انتظار", "۱۲ ساعت"],
                        ["#4399", "درخواست ارتقا به پلاتینیوم", "پوشاک رادین", "عمده", "پایین", "تأیید شد", "—"],
                      ].map((r) => (
                        <tr key={r[0]}>
                          <td className="font-bold tabular-nums" dir="ltr">{r[0]}</td><td><b>{r[1]}</b></td><td>{r[2]}</td><td><span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px] font-bold">{r[3]}</span></td>
                          <td><span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", r[4] === "بالا" ? "bg-[#A8483C]/10 text-[#8A3B30] dark:text-[#D07A6A]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{r[4]}</span></td>
                          <td><Status value={r[5]} /></td><td className="tabular-nums text-[var(--kv-muted)]">{r[6]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <Card className="h-fit p-5">
                <p className="text-[14px] font-extrabold">عملکرد SLA</p>
                <p className="mt-2 text-3xl font-extrabold tabular-nums">۹۴٪ <span className="text-[13px] font-medium text-[var(--kv-muted)]">پاسخ در مهلت</span></p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><div className="h-full w-[94%] rounded-full bg-[var(--kv-success)]" /></div>
                <div className="mt-4 space-y-2 text-[12.5px]">
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">میانگین پاسخ</span><b className="tabular-nums">۴۷ دقیقه</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">تیکت باز</span><b className="tabular-nums">{fmtNum(18)}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">رضایت</span><b className="tabular-nums">۴.۷ / ۵</b></div>
                </div>
              </Card>
            </div>
          )}

          {/* ---------- Settings ---------- */}
          {tab === "settings" && (
            <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_360px]">
              <Card className="overflow-hidden">
                <p className="p-5 pb-3 text-[14px] font-extrabold">نقش‌ها و دسترسی‌ها</p>
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[720px]">
                    <thead><tr><th>ماژول</th>{["مدیر ارشد", "اپراتور عمده", "اپراتور خرده", "مالی", "پشتیبانی"].map((r) => <th key={r}>{r}</th>)}</tr></thead>
                    <tbody>
                      {[["سفارش‌های عمده", [1, 1, 0, 1, 1]], ["میز عملیات کلبه", [1, 1, 0, 0, 0]], ["بازبینی محصولات", [1, 1, 0, 0, 0]], ["خریداران و پلن‌ها", [1, 1, 0, 0, 1]], ["سفارش‌ها و محصولات خرده", [1, 0, 1, 0, 1]], ["CRM و اعلان‌ها", [1, 0, 1, 0, 1]], ["مالی و تسویه", [1, 0, 0, 1, 0]], ["یکپارچه‌سازی‌ها", [1, 0, 0, 1, 0]]].map(([m, perms]) => (
                        <tr key={m as string}><td><b>{m as string}</b></td>{(perms as number[]).map((v, i) => <td key={i}><input type="checkbox" defaultChecked={!!v} className="h-4 w-4 accent-[#C1613B]" aria-label={`${m}`} /></td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-[var(--kv-line)] px-5 py-3"><Btn variant="accent" size="sm" onClick={() => flash("ماتریس دسترسی ذخیره شد")}>ذخیره دسترسی‌ها</Btn></div>
              </Card>
              <div className="space-y-4">
                <Card className="p-5">
                  <p className="text-sm font-bold">انبارها</p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">فهرست واقعی انبارهای ثبت‌شده روی سرور؛ تعریف و موجودی در بخش «انبار و موجودی» انجام می‌شود.</p>
                  {settingsWarehouses === null ? (
                    <p className="mt-3 text-[12.5px] text-[var(--kv-muted)]">در حال خواندن انبارها از سرور…</p>
                  ) : settingsWarehouses.length === 0 ? (
                    <p className="mt-3 text-[12.5px] text-[var(--kv-muted)]">هنوز انباری ثبت نشده است.</p>
                  ) : (
                    settingsWarehouses.map((warehouse) => (
                      <div key={warehouse.id} className="mt-2 flex items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2.5 text-[12.5px]">
                        <Warehouse size={15} className="text-[var(--kv-muted)]" />
                        <span>
                          <b>{warehouse.name}</b>
                          <span className="block text-[11px] text-[var(--kv-muted)]" dir="ltr">{warehouse.code}</span>
                        </span>
                        {shippingSettings?.defaultWarehouseId === warehouse.id && (
                          <span className="mr-auto rounded-full bg-[var(--kv-accent)]/12 px-2 py-0.5 text-[10.5px] font-bold text-[var(--kv-accent)]">انبار پیش‌فرض ارسال</span>
                        )}
                      </div>
                    ))
                  )}
                  <Btn variant="ghost" size="sm" className="mt-2" onClick={() => setTab("wms")}>مدیریت انبارها</Btn>
                </Card>
                <Card className="p-5">
                  <p className="text-sm font-bold">اطلاعات فروشگاه</p>
                  <div className="mt-3 space-y-3">
                    <Field label="نام قانونی"><Input placeholder="کلبه وینتیج (سهامی خاص)" /></Field>
                    <Field label="شناسه مالیاتی"><Input placeholder="۱۴۰۰…" /></Field>
                    <Field label="کارمزد پیش‌فرض تأمین‌کنندگان"><Input placeholder="۸٪" /></Field>
                    <Btn variant="soft" size="sm" onClick={() => flash("ذخیره شد")}>ذخیره</Btn>
                  </div>
                </Card>
              </div>
            </div>
          )}
          </ModuleBoundary>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-1/2 z-[90] translate-x-1/2 animate-[scaleIn_0.25s_ease]">
          <div className="kv-glass flex items-center gap-2.5 rounded-[14px] px-5 py-3.5 text-[13.5px] font-bold"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--kv-success)] text-white"><Check size={15} /></span>{toast}</div>
        </div>
      )}
      <span className="hidden"><AlertTriangle size={8} /></span>
    </div>
  );
}
