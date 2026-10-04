import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudOff, RefreshCw } from "lucide-react";
import { Btn } from "./primitives";
import {
  adminApi, apiClient, automationApi, cmsApi, crmApi, financeApi, importsApi, integrationsApi, inventoryApi,
  invoicesApi, notificationsApi, ordersApi, promoApi, recommendationsApi, reviewsApi, shippingApi, ticketsApi,
} from "../data/api";
import { productTypesApi, seoApi } from "../data/experience-api";

type Probe = { label: string; run: () => Promise<unknown> };

/**
 * Every admin section declares the API it actually depends on. The console therefore reports
 * «متصل» only when that section's own request succeeds — the previous build showed a hardcoded
 * "not connected to server" banner for every tab, which was false.
 */
const PROBES: Record<string, Probe> = {
  tower: { label: "داشبورد عملیات", run: () => adminApi.summary() },
  "server-orders": { label: "سفارش‌های سرور", run: () => ordersApi.list({ limit: "1" }) },
  shipping: { label: "روش‌های ارسال", run: () => shippingApi.adminList() },
  wms: { label: "انبارها و موجودی", run: () => inventoryApi.warehouses() },
  crm: { label: "مشتریان", run: () => crmApi.contacts({ limit: "1" }) },
  promo: { label: "کوپن و جشنواره", run: () => promoApi.coupons() },
  cms: { label: "محتوای سایت", run: () => cmsApi.pages() },
  sms: { label: "پنل پیامک", run: () => adminApi.smsCampaigns() },
  notifs: { label: "اعلان‌ها", run: () => notificationsApi.routes() },
  finance: { label: "تسویه‌ها", run: () => financeApi.stats() },
  "finance-ledger": { label: "دفتر کل", run: () => financeApi.journal({ limit: "1" }) },
  integrations: { label: "یکپارچه‌سازی‌ها", run: () => integrationsApi.list() },
  support: { label: "تیکت‌ها", run: () => ticketsApi.list({ limit: "1" }) },
  audit: { label: "گزارش حسابرسی", run: () => financeApi.auditLogs({ limit: "1" }) },
  applications: { label: "درخواست همکاری", run: () => adminApi.cooperationRequests() },
  buyers: { label: "خریداران عمده", run: () => adminApi.memberships({ limit: "1" }) },
  suppliers: { label: "تأمین‌کنندگان", run: () => adminApi.users() },
  restrictions: { label: "محدودیت کاربران", run: () => adminApi.restrictions() },
  plans: { label: "پلن‌های عضویت", run: () => adminApi.plans() },
  users: { label: "کاربران", run: () => adminApi.users() },
  // Prompt 5 QA: settings now hosts server-backed modules (پیکربندی حمل‌ونقل + کاربران سیستم),
  // so it must probe the server instead of claiming to be local.
  settings: { label: "پیکربندی حمل‌ونقل و کاربران", run: () => shippingApi.adminList() },
  // Admin-finalization: these sections previously showed «روی داده محلی اجرا می‌شود» although they
  // are fully server-backed — each now probes its own real endpoint so the banner is truthful.
  imports: { label: "مرکز ورود داده", run: () => importsApi.history(1) },
  "supplier-docs": { label: "اسناد و صورت‌حساب", run: () => invoicesApi.list({ limit: "1" }) },
  structure: { label: "ساختار محصولات", run: () => productTypesApi.adminList() },
  seo: { label: "مرکز SEO", run: () => seoApi.list() },
  media: { label: "مجله و رسانه‌ها", run: () => apiClient.get("/admin/editorial?limit=1") },
  reviews: { label: "نظرات و امتیازها", run: () => reviewsApi.adminList({ limit: 1 }) },
  recs: { label: "توصیه‌گر هوشمند", run: () => recommendationsApi.adminSlots() },
  automation: { label: "اتوماسیون و رویدادها", run: () => automationApi.readiness() },
};

type State =
  | { kind: "checking"; tab: string }
  | { kind: "connected"; tab: string; label: string }
  | { kind: "error"; tab: string; message: string }
  | { kind: "local"; tab: string; label: string };

/** Sections that run entirely on local operational state — reported honestly, not as a failure. */
const LOCAL_ONLY: Record<string, string> = {
  worders: "سفارش‌های عمده در این نسخه روی داده محلی کنسول مدیریت می‌شود.",
  kolbe: "میز عملیات کلبه روی داده محلی کنسول مدیریت می‌شود.",
  wproducts: "بازبینی محصولات بازارچه محلی است.",
  rorders: "سفارش‌های خردهٔ محلی؛ نسخه سروری در «سفارش‌های واقعی» است.",
  rproducts: "تعریف محصول از کاتالوگ واقعی سرور خوانده و روی آن ذخیره می‌شود.",
  series: "قالب‌های سری کلبه محلی‌اند.",
};

/**
 * Per-section server connection state.
 * - `error` is shown only when this section's own API request truly fails.
 * - local-only sections say so explicitly instead of pretending to be disconnected.
 */
export function ServerConnectionState({ tab }: { tab: string }) {
  const [state, setState] = useState<State>({ kind: "checking", tab });
  const check = useCallback(async () => {
    const probe = PROBES[tab];
    if (!probe) { setState({ kind: "local", tab, label: LOCAL_ONLY[tab] ?? "این بخش روی داده محلی کنسول اجرا می‌شود." }); return; }
    setState({ kind: "checking", tab });
    try {
      await probe.run();
      // Stale responses are dropped: a probe that resolves after the operator switched tabs must
      // never describe (or index into) the new tab — that threw and blanked the whole console.
      setState((current) => (current.tab === tab ? { kind: "connected", tab, label: probe.label } : current));
    } catch (error) {
      const message = error instanceof Error ? error.message : "ارتباط با سرور برقرار نشد";
      setState((current) => (current.tab === tab ? { kind: "error", tab, message } : current));
    }
  }, [tab]);
  useEffect(() => { void check(); }, [check]);
  // While the operator is switching sections the previous verdict is not shown for the new one.
  if (state.tab !== tab) return (
    <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--kv-muted)]">
      <RefreshCw size={13} className="animate-spin" />در حال بررسی اتصال این بخش به سرور…
    </p>
  );

  if (state.kind === "checking") {
    return (
      <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--kv-muted)]">
        <RefreshCw size={13} className="animate-spin" />در حال بررسی اتصال این بخش به سرور…
      </p>
    );
  }
  if (state.kind === "connected") {
    return (
      <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-[#3E6B4A]/25 bg-[#3E6B4A]/8 px-4 py-2 text-xs font-semibold text-[#31603D]">
        <CheckCircle2 size={13} />داده‌های این بخش از سرور خوانده می‌شود ({state.label}).
      </p>
    );
  }
  if (state.kind === "local") {
    return (
      <p role="note" className="mb-4 flex items-center gap-2 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--kv-muted)]">
        <CloudOff size={13} />{state.label}
      </p>
    );
  }
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--kv-danger)]/40 bg-[var(--kv-danger)]/5 px-4 py-2.5 text-xs">
      <AlertTriangle size={14} className="text-[var(--kv-danger)]" />
      <span className="font-semibold text-[var(--kv-danger)]">خطا در ارتباط این بخش با سرور: {state.message}</span>
      <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />} onClick={() => void check()}>تلاش مجدد</Btn>
    </div>
  );
}
