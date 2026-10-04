import { useCallback, useEffect, useState } from "react";
import { HelpCircle, RefreshCw, UserRound } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";
import { buyersApi, cashbackApi, crmApi, crmIntelApi } from "../data/api";
import { Btn, Card, Checkbox, Empty, ErrorState, LoadingState, SearchBox, Segmented, Status, Textarea, WorkspaceModal } from "./primitives";
import { ACCOUNT_STATUS_FA, ORDER_STATUS_FA, ORDER_TYPE_FA, PAYMENT_MODE_FA, RETURN_STATUS_FA, REVIEW_STATUS_FA, TICKET_STATUS_FA, CASHBACK_TX_FA, faEvent, faLabel } from "../data/fa-labels";

/** Money arrives as rial strings; UI copy shows toman (÷۱۰). */
const toman = (value: unknown) => `${fmtNum(Math.round(Number(String(value ?? "0")) / 10))} تومان`;
const day = (value: unknown) => (value ? formatPersianDate(String(value)) : "ثبت نشده");
const text = (value: unknown) => (value === null || value === undefined || value === "" ? "ثبت نشده" : String(value));

type Row = Record<string, unknown>;

const BEHAVIOR_TONE: Record<string, string> = {
  high_value: "bg-amber-500/10 text-amber-700 border-amber-300",
  loyal: "bg-emerald-500/10 text-emerald-700 border-emerald-300",
  active: "bg-sky-500/10 text-sky-700 border-sky-300",
  returned: "bg-violet-500/10 text-violet-700 border-violet-300",
  new: "bg-teal-500/10 text-teal-700 border-teal-300",
  at_risk: "bg-orange-500/10 text-orange-700 border-orange-300",
  inactive: "bg-zinc-500/10 text-zinc-600 border-zinc-300",
};

/** رفتار + «چرا؟» — evidence from the server rule engine, never a black box. */
function BehaviorChip({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const reasons = (row.behavior_reasons as string[]) ?? [];
  const tone = BEHAVIOR_TONE[String(row.behavior)] ?? BEHAVIOR_TONE.inactive;
  return (
    <span className="relative inline-flex items-center gap-1">
      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${tone}`}>{text(row.behavior_label)}</span>
      {reasons.length > 0 && (
        <button className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" title="چرا؟" aria-label="دلایل وضعیت رفتاری" onClick={() => setOpen((v) => !v)}>
          <HelpCircle size={14} />
        </button>
      )}
      {open && (
        <span className="absolute left-0 top-7 z-30 w-56 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-right shadow-xl">
          <span className="mb-1 block text-[11px] font-extrabold">چرا این وضعیت؟</span>
          {reasons.map((reason) => <span key={reason} className="block py-0.5 text-[11px] text-[var(--kv-muted)]">• {reason}</span>)}
        </span>
      )}
    </span>
  );
}

const VIEWS = [
  { v: "", label: "همه" },
  { v: "high_value", label: "پرارزش" },
  { v: "loyal", label: "وفادار" },
  { v: "at_risk", label: "در خطر ریزش" },
  { v: "returned", label: "بازگشته" },
  { v: "inactive", label: "غیرفعال" },
  { v: "new", label: "جدید" },
];

const PAGE = 25;

/** مشتریان خرده — server-backed list + full-width 360 workspace (master §6-§10). */
export function CrmRetailPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("");
  const [kpis, setKpis] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Row | null>(null);
  const [profileUser, setProfileUser] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await crmApi.retailCustomers({ search: search || undefined, behavior: view || undefined, limit: PAGE, offset });
      setRows(res.items); setTotal(res.total);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری مشتریان"); }
  }, [search, view, offset]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void crmApi.summary().then((r) => setKpis(r.kpis)).catch(() => setKpis(null)); }, []);

  const open360 = async (userId: string) => {
    setProfileUser(userId); setProfile(null);
    try { setProfile(await crmApi.user360(userId)); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت پروفایل ۳۶۰"); setProfileUser(null); }
  };

  if (error && !rows) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      {kpis && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {([
            ["مشتریان فعال (۹۰ روز)", kpis.active_customers],
            ["VIP فعال", kpis.active_vip],
            ["تأمین‌کنندگان فعال", kpis.active_suppliers],
            ["در خطر ریزش", kpis.at_risk],
            ["تولد این ماه", kpis.birthdays_this_month],
            ["سبد رهاشده", kpis.abandoned_carts],
            ["VIP نزدیک انقضا", kpis.vip_expiring],
            ["تأمین‌کننده با QC منفی", kpis.suppliers_qc_flagged],
          ] as [string, number | undefined][]).map(([label, value]) => (
            <Card key={label} className="p-3">
              <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
              <p className="mt-0.5 text-[15px] font-extrabold tabular-nums">{fmtNum(Number(value ?? 0))}</p>
            </Card>
          ))}
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox placeholder="نام، موبایل یا ایمیل مشتری…" value={search} onChange={(v) => { setOffset(0); setSearch(v); }} />
            <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()}>به‌روزرسانی</Btn>
          </div>
          <Segmented options={VIEWS} value={view} onChange={(v) => { setOffset(0); setView(v); }} />
        </div>

        {!rows ? <LoadingState label="در حال بارگذاری مشتریان…" /> : rows.length === 0 ? (
          <Empty title="مشتری‌ای یافت نشد" desc="فیلتر یا جست‌وجو را تغییر دهید." />
        ) : (
          <div className="kv-scroll mt-4 overflow-x-auto">
            <table className="w-full min-w-[980px] text-right text-[12.5px]">
              <thead>
                <tr className="text-[11.5px] text-[var(--kv-muted)]">
                  {["مشتری", "موبایل", "وضعیت حساب", "رفتار مشتری", "عضویت", "تعداد خرید", "ارزش کل", "آخرین فعالیت", "شهر", "عملیات"].map((h) => (
                    <th key={h} className="pb-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--kv-line)]">
                {rows.map((row) => (
                  <tr key={String(row.id)} className="hover:bg-[var(--kv-surface-2)]/60">
                    <td className="py-2.5 font-bold">{text(row.display_name)}</td>
                    <td className="py-2.5 tabular-nums">{text(row.phone)}</td>
                    <td className="py-2.5"><Status value={faLabel(ACCOUNT_STATUS_FA, row.account_status)} /></td>
                    <td className="py-2.5"><BehaviorChip row={row} /></td>
                    <td className="py-2.5 tabular-nums">{day(row.created_at)}</td>
                    <td className="py-2.5 tabular-nums">{fmtNum(Number(row.order_count ?? 0))}</td>
                    <td className="py-2.5 tabular-nums">{toman(row.total_spent)}</td>
                    <td className="py-2.5 tabular-nums">{row.last_activity_at ? formatPersianDate(String(row.last_activity_at)) : "ثبت نشده"}</td>
                    <td className="py-2.5">{text(row.city)}</td>
                    <td className="py-2.5">
                      <Btn variant="soft" size="sm" icon={<UserRound size={13} />} onClick={() => void open360(String(row.id))}>پروفایل ۳۶۰°</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-[12px] text-[var(--kv-muted)]">
          <span className="tabular-nums">{fmtNum(total)} مشتری · صفحه {fmtNum(Math.floor(offset / PAGE) + 1)}</span>
          <div className="flex gap-2">
            <Btn variant="soft" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>قبلی</Btn>
            <Btn variant="soft" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>بعدی</Btn>
          </div>
        </div>
      </Card>

      {profileUser && (
        <Customer360Workspace loading={!profile} data={profile} userId={profileUser}
          onRefresh={async () => { try { setProfile(await crmApi.user360(profileUser)); } catch { /* keep last state */ } }}
          onClose={() => { setProfileUser(null); setProfile(null); }} />
      )}
    </div>
  );
}

type TabKey = "overview" | "purchases" | "wallet" | "activity" | "interests" | "support" | "marketing" | "history";
const TABS: { v: TabKey; label: string }[] = [
  { v: "overview", label: "نمای کلی" },
  { v: "purchases", label: "خریدها" },
  { v: "wallet", label: "کیف پول کش‌بک" },
  { v: "activity", label: "فعالیت‌ها" },
  { v: "interests", label: "علاقه‌مندی‌ها" },
  { v: "support", label: "پشتیبانی" },
  { v: "marketing", label: "بازاریابی" },
  { v: "history", label: "تاریخچه" },
];

/** کیف پول کش‌بک مشتری — موجودی‌ها از دفترکل سرور؛ اعتبار وفاداری، غیرقابل برداشت/انتقال. */
function CustomerWalletTab({ userId }: { userId: string }) {
  const [wallet, setWallet] = useState<Row | null | undefined>(undefined);
  const [txs, setTxs] = useState<Row[] | null>(null);
  useEffect(() => {
    let active = true;
    void cashbackApi.adminWallets({ customerId: userId }).then((r) => { if (active) setWallet((r.items[0] as Row) ?? null); }).catch(() => { if (active) setWallet(null); });
    void cashbackApi.adminTransactions({ customerId: userId, limit: 50 }).then((r) => { if (active) setTxs(r.items as Row[]); }).catch(() => { if (active) setTxs([]); });
    return () => { active = false; };
  }, [userId]);
  if (wallet === undefined || txs === null) return <LoadingState label="در حال بارگذاری کیف پول…" />;
  if (!wallet && txs.length === 0) return <Empty title="کیف پول کش‌بک خالی است" desc="با نخستین کش‌بکِ تعلق‌گرفته (پس از پرداخت سفارش خرده)، این بخش فعال می‌شود." />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([
          ["در انتظار آزادسازی", toman(wallet?.pending_rial)],
          ["قابل استفاده", toman(wallet?.available_rial)],
          ["استفاده‌شده", toman(wallet?.used_rial)],
          ["منقضی‌شده", toman(wallet?.expired_rial)],
        ] as [string, React.ReactNode][]).map(([label, value]) => (
          <div key={label} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2.5">
            <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
            <p className="mt-0.5 text-[13px] font-extrabold tabular-nums">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-[var(--kv-muted)]">اعتبار وفاداری است؛ قابل برداشت یا انتقال نیست و فقط در پرداخت سفارش خرده مصرف می‌شود. اصلاح دستی از «کیف پول کش‌بک» در بخش مالی انجام می‌شود.</p>
      <Mini head={["زمان", "نوع", "مبلغ", "سفارش", "شرح"]} empty="تراکنشی ثبت نشده است."
        rows={txs.map((t) => [
          t.created_at ? formatPersianDateTime(String(t.created_at)) : "ثبت نشده",
          faLabel(CASHBACK_TX_FA, t.tx_type),
          toman(t.amount_rial),
          text(t.order_reference),
          text(t.description),
        ])} />
    </div>
  );
}

function Mini({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="py-3 text-[12.5px] text-[var(--kv-muted)]">{empty}</p>;
  return (
    <div className="kv-scroll overflow-x-auto">
      <table className="w-full min-w-[480px] text-right text-[12.5px]">
        <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">{head.map((h) => <th key={h} className="pb-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-[var(--kv-line)]">
          {rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="py-2 align-top">{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** Customer 360 — Corrective §55/§66: a CENTERED WorkspaceModal (same family as
 *  VIP/Supplier 360) composed from existing domains; missing data reads «ثبت نشده»،
 *  and consent toggles actually persist through the canonical consent endpoint. */
function Customer360Workspace({ loading, data, userId, onRefresh, onClose }: {
  loading: boolean; data: Row | null; userId: string; onRefresh: () => Promise<void>; onClose: () => void;
}) {
  const [tab, setTab] = useState<TabKey>("overview");
  const [sortDesc, setSortDesc] = useState(true);
  const [consentBusy, setConsentBusy] = useState<string | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [behavior, setBehavior] = useState<Row | null>(null);
  const contact = (data?.contact ?? {}) as Row;
  const kpis = (data?.kpis ?? {}) as Record<string, string | number>;
  const membership = data?.membership as Row | null;
  const consent = data?.consent as Row | null;
  const purchases = (data?.purchases as Row[]) ?? [];
  const timeline = (data?.timeline as Row[]) ?? [];
  const wishlist = (data?.wishlist as Row[]) ?? [];
  const tickets = (data?.tickets as Row[]) ?? [];
  const addresses = (data?.addresses as Row[]) ?? [];
  const notes = (data?.notes as Row[]) ?? [];
  const reviews = (data?.reviews as Row[]) ?? [];
  const labels = (data?.labels as Row[]) ?? [];
  const segments = (data?.segments as Row[]) ?? [];

  /* Migrated from the legacy «پروفایل و تایم‌لاین» tab: server-side purchase-behavior analysis. */
  const contactId = String(contact.id ?? "");
  useEffect(() => {
    if (!contactId) return;
    let active = true;
    void crmIntelApi.behavior(contactId).then((res) => { if (active) setBehavior(res as Row); }).catch(() => { /* behavior card is optional */ });
    return () => { active = false; };
  }, [contactId]);

  /* §56: item-level chronology, newest-first by default and sortable. */
  const sortedPurchases = [...purchases].sort((a, b) => {
    const ta = new Date(String(a.created_at ?? 0)).getTime();
    const tb = new Date(String(b.created_at ?? 0)).getTime();
    return sortDesc ? tb - ta : ta - tb;
  });

  /* §63: consent writes go through the canonical admin endpoint with loading /
     success / error-rollback semantics — the checkbox only flips after the server agrees. */
  const setConsent = async (key: "marketingSms" | "transactionalSms" | "emailMarketing" | "doNotContact", value: boolean) => {
    setConsentBusy(key); setConsentError(null);
    try {
      await buyersApi.saveConsent(userId, { [key]: value, reason: "به‌روزرسانی توسط اپراتور از پروفایل ۳۶۰°" });
      await onRefresh();
    } catch (error) {
      setConsentError(error instanceof Error ? error.message : "ذخیرهٔ رضایت ناموفق بود؛ دوباره تلاش کنید.");
    } finally { setConsentBusy(null); }
  };

  const consentRows: { key: "marketingSms" | "transactionalSms" | "emailMarketing" | "doNotContact"; label: string; hint: string; checked: boolean }[] = [
    { key: "marketingSms", label: "پیامک تبلیغاتی", hint: "کمپین‌ها و پیشنهادهای بازاریابی", checked: consent?.marketing_sms === true },
    { key: "transactionalSms", label: "پیامک تراکنشی", hint: "اطلاع‌رسانی سفارش و پرداخت — مستقل از بازاریابی", checked: consent?.transactional_sms !== false },
    { key: "emailMarketing", label: "ایمیل تبلیغاتی", hint: "خبرنامه و کمپین‌های ایمیلی", checked: consent?.email_marketing === true },
    { key: "doNotContact", label: "عدم تماس (DNC)", hint: "هیچ پیام بازاریابی برای این مشتری ارسال نمی‌شود", checked: consent?.do_not_contact === true },
  ];

  return (
    <WorkspaceModal open onClose={onClose} title={`${text(contact.display_name)} — پروفایل ۳۶۰°`}
      subtitle={`موبایل: ${text(contact.phone)} — پروندهٔ کامل مشتری خرده‌فروشی`}>
      {loading || !data ? <LoadingState label="در حال بارگذاری پروفایل…" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([
              ["تعداد خرید", fmtNum(Number(kpis.order_count ?? 0))],
              ["ارزش کل خرید", toman(kpis.total_spent_rial)],
              ["میانگین سفارش", toman(kpis.average_order_rial)],
              ["آخرین خرید", kpis.last_order_at ? formatPersianDate(String(kpis.last_order_at)) : "ثبت نشده"],
              ["مرجوعی", fmtNum(Number(kpis.returns_count ?? 0))],
              ["تیکت باز", fmtNum(Number(kpis.open_tickets ?? 0))],
              ["علاقه‌مندی", fmtNum(Number(kpis.wishlist_count ?? 0))],
              ["دیدگاه", fmtNum(Number(kpis.review_count ?? 0))],
            ] as [string, React.ReactNode][]).map(([label, value]) => (
              <div key={label} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2.5">
                <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
                <p className="mt-0.5 text-[13px] font-extrabold tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          <Segmented options={TABS} value={tab} onChange={setTab} />

          {tab === "overview" && (
            <div className="space-y-4">
              <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {([
                  ["نام و نام خانوادگی", `${text(contact.first_name)} ${contact.last_name ? String(contact.last_name) : ""}`.trim() || "ثبت نشده"],
                  ["موبایل", text(contact.phone)],
                  ["ایمیل", text(contact.email)],
                  ["تاریخ تولد", contact.birthday ? formatPersianDate(String(contact.birthday)) : "ثبت نشده"],
                  ["جنسیت", contact.gender === "female" ? "زن" : contact.gender === "male" ? "مرد" : "ثبت نشده"],
                  ["تاریخ عضویت", day(contact.registered_at)],
                  ["وضعیت حساب", faLabel(ACCOUNT_STATUS_FA, contact.status)],
                  ["عضویت VIP", membership ? `${text(membership.title ?? membership.code)} (تا ${day(membership.ends_at)})` : "ندارد"],
                ] as [string, React.ReactNode][]).map(([label, value]) => (
                  <div key={label} className="flex items-start justify-between gap-3 border-b border-dashed border-[var(--kv-line)] pb-2 text-[12.5px]">
                    <dt className="text-[var(--kv-muted)]">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <div>
                <p className="mb-2 text-[12.5px] font-bold">نشانی‌ها</p>
                <Mini head={["عنوان", "استان/شهر", "نشانی", "پیش‌فرض"]} empty="نشانی ثبت نشده است."
                  rows={addresses.map((a) => [text(a.title), `${text(a.province)} / ${text(a.city)}`, text(a.line), a.is_default ? "بله" : "خیر"])} />
              </div>
              <div>
                <p className="mb-2 text-[12.5px] font-bold">برچسب‌ها و سگمنت‌ها</p>
                <div className="flex flex-wrap gap-2 text-[11.5px]">
                  {labels.map((l) => <span key={String(l.label_code)} className="rounded-full border border-[var(--kv-line)] px-3 py-1">{text(l.title ?? l.label_code)}</span>)}
                  {segments.map((s) => <span key={String(s.code)} className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1">{text(s.title)}</span>)}
                  {!labels.length && !segments.length && <span className="text-[var(--kv-muted)]">برچسبی ثبت نشده است.</span>}
                </div>
              </div>
              {behavior && (
                <div>
                  <p className="mb-2 text-[12.5px] font-bold">تحلیل رفتار خرید</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {([
                      ["سفارش", fmtNum(Number((behavior.metrics as Row)?.orders ?? 0))],
                      ["مجموع خرید", toman((behavior.metrics as Row)?.totalSpentRial)],
                      ["میانگین سفارش", toman((behavior.metrics as Row)?.averageOrderRial)],
                      ["فاصله خرید (روز)", behavior.averagePurchaseIntervalDays ? fmtNum(Number(behavior.averagePurchaseIntervalDays)) : "ثبت نشده"],
                    ] as [string, React.ReactNode][]).map(([label, value]) => (
                      <div key={label} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2">
                        <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
                        <p className="text-[13px] font-extrabold tabular-nums">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 grid gap-4 md:grid-cols-3">
                    {([["محصولات محبوب", behavior.products], ["دسته‌های موردعلاقه", behavior.categories], ["کوپن‌های استفاده‌شده", behavior.coupons]] as [string, unknown][]).map(([title, rows]) => (
                      <div key={title}>
                        <p className="mb-1.5 text-[11.5px] font-bold">{title}</p>
                        {((rows as Row[]) ?? []).slice(0, 5).map((row, i) => (
                          <p key={i} className="text-[11px] text-[var(--kv-muted)] tabular-nums">
                            {text(row.product_name ?? row.category ?? row.code)} · {fmtNum(Number(row.quantity ?? row.count ?? row.discount_rial ?? 0))}
                          </p>
                        ))}
                        {!(rows as unknown[])?.length && <p className="text-[11px] text-[var(--kv-muted)]">داده‌ای نیست</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "purchases" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[11.5px] text-[var(--kv-muted)]">تاریخچهٔ خرید در سطح قلم کالا — چه چیزی، با چه مشخصاتی و در چه تاریخی.</p>
                <Btn variant="soft" size="sm" onClick={() => setSortDesc((v) => !v)}>{sortDesc ? "جدیدترین اول" : "قدیمی‌ترین اول"}</Btn>
              </div>
              <Mini head={["تاریخ", "مرجع سفارش", "محصول", "رنگ", "سایز", "تعداد", "قیمت واحد", "جمع قلم", "نوع", "روش پرداخت", "وضعیت", "مرجوعی"]}
                empty="خریدی ثبت نشده است."
                rows={sortedPurchases.map((l) => [
                  day(l.created_at),
                  <span key="ref" className="font-bold tabular-nums">{text(l.reference)}</span>,
                  <span key="p">{text(l.product_name)}<span className="block text-[10.5px] text-[var(--kv-muted)]" dir="ltr">{String(l.sku ?? "")}</span></span>,
                  text(l.color_label),
                  text(l.size_label),
                  fmtNum(Number(l.quantity ?? 0)),
                  toman(l.unit_price_rial),
                  toman(l.line_total_rial),
                  faLabel(ORDER_TYPE_FA, l.order_type),
                  faLabel(PAYMENT_MODE_FA, l.payment_mode),
                  <Status key="st" value={faLabel(ORDER_STATUS_FA, l.order_status)} />,
                  l.return_status ? faLabel(RETURN_STATUS_FA, l.return_status) : "ندارد",
                ])} />
            </div>
          )}

          {tab === "wallet" && <CustomerWalletTab userId={userId} />}

          {tab === "activity" && (
            <Mini head={["رویداد", "عنوان", "زمان"]} empty="فعالیتی ثبت نشده است."
              rows={timeline.filter((t) => !String(t.event_type ?? "").startsWith("order")).map((t) => [faEvent(t.event_type), text(t.title), t.occurred_at ? formatPersianDateTime(String(t.occurred_at)) : "ثبت نشده"])} />
          )}

          {tab === "interests" && (
            <div className="space-y-4">
              <p className="text-[11.5px] text-[var(--kv-muted)]">علاقه‌مندی‌ها فقط از رفتار واقعی (لیست علاقه‌مندی و خرید) ساخته می‌شوند؛ هیچ حدسی در کار نیست.</p>
              <Mini head={["محصول", "دسته", "تاریخ افزودن"]} empty="موردی در لیست علاقه‌مندی نیست."
                rows={wishlist.map((w) => [text(w.product_name), text(w.category), day(w.created_at)])} />
            </div>
          )}

          {tab === "support" && (
            <div className="space-y-4">
              <Mini head={["مرجع", "موضوع", "دسته", "وضعیت", "تاریخ"]} empty="تیکتی ثبت نشده است."
                rows={tickets.map((t) => [text(t.reference), text(t.subject), text(t.category), faLabel(TICKET_STATUS_FA, t.status), day(t.created_at)])} />
              <div>
                <p className="mb-2 text-[12.5px] font-bold">دیدگاه‌ها</p>
                <Mini head={["محصول", "امتیاز", "عنوان", "وضعیت"]} empty="دیدگاهی ثبت نشده است."
                  rows={reviews.map((r) => [text(r.product_name), `${fmtNum(Number(r.rating ?? 0))}/۵`, text(r.title), faLabel(REVIEW_STATUS_FA, r.status)])} />
              </div>
            </div>
          )}

          {tab === "marketing" && (
            <div className="space-y-4">
              <p className="text-[11.5px] text-[var(--kv-muted)]">پیام تراکنشی (اطلاع‌رسانی سفارش) از بازاریابی جداست؛ تغییرها با دلیل در حسابرسی ثبت می‌شوند.</p>
              {consentError && <p className="rounded-[10px] bg-rose-500/10 px-3 py-2 text-[11.5px] font-bold text-rose-700">{consentError}</p>}
              <div className="grid gap-2.5 sm:grid-cols-2">
                {consentRows.map((row) => (
                  <div key={row.key} className="flex items-start justify-between gap-3 rounded-[12px] border border-[var(--kv-line)] px-3 py-2.5">
                    <div>
                      <Checkbox checked={row.checked} onChange={(v) => { if (!consentBusy) void setConsent(row.key, v); }} label={row.label} />
                      <p className="mt-1 text-[10.5px] text-[var(--kv-muted)]">{row.hint}</p>
                    </div>
                    {consentBusy === row.key && <span className="text-[10.5px] text-[var(--kv-muted)]">در حال ذخیره…</span>}
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-2 text-[12.5px] font-bold">یادداشت‌های داخلی (هرگز برای مشتری نمایش داده نمی‌شود)</p>
                <Mini head={["یادداشت", "نویسنده", "تاریخ"]} empty="یادداشتی ثبت نشده است."
                  rows={notes.map((n) => [text(n.body), text(n.author_name), day(n.created_at)])} />
                {/* Migrated from the legacy «پروفایل و تایم‌لاین» tab — note-writing now lives inside the 360. */}
                <div className="mt-2 space-y-2">
                  <Textarea rows={2} value={noteBody} onChange={setNoteBody} placeholder="یادداشت داخلی…" />
                  <Btn variant="soft" size="sm" disabled={noteBusy || noteBody.trim().length < 3}
                    onClick={() => { setNoteBusy(true); void (async () => {
                      try { await crmIntelApi.addNote(String(contact.id), { body: noteBody, visibility: "internal" }); setNoteBody(""); await onRefresh(); }
                      catch (error) { setConsentError(error instanceof Error ? error.message : "ثبت یادداشت ناموفق بود."); }
                      finally { setNoteBusy(false); }
                    })(); }}>{noteBusy ? "در حال ثبت…" : "ثبت یادداشت"}</Btn>
                </div>
              </div>
            </div>
          )}

          {tab === "history" && (
            <div className="space-y-2">
              <p className="text-[11.5px] text-[var(--kv-muted)]">تاریخچهٔ کامل رویدادهای این مشتری از منبع واحد رویدادها.</p>
              <Mini head={["رویداد", "عنوان", "منبع", "زمان"]} empty="رویدادی ثبت نشده است."
                rows={timeline.map((t) => [faEvent(t.event_type), text(t.title), text(t.source), t.occurred_at ? formatPersianDateTime(String(t.occurred_at)) : "ثبت نشده"])} />
            </div>
          )}
        </div>
      )}
    </WorkspaceModal>
  );
}
