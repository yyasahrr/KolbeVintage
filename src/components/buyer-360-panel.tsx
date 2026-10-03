import { useCallback, useEffect, useState } from "react";
import { Ban, Check, FileText, HelpCircle, ShieldCheck, UserCog } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";
import { buyersApi, membershipLifecycleApi, type Buyer360Payload } from "../data/api";
import { Btn, Card, Checkbox, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, Select, Status, Tag, Textarea, WorkspaceModal } from "./primitives";

/** Rial values arrive as strings (money is never a JS float). */
const rial = (value: unknown) => `${fmtNum(Number(String(value ?? "0")))} ریال`;
const day = (value: unknown) => (value ? formatPersianDate(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));

type Section = "market" | "business" | "purchase" | "finance" | "support" | "crm";

const SECTIONS: { v: Section; label: string }[] = [
  { v: "market", label: "حساب و عضویت" },
  { v: "business", label: "کسب‌وکار و مدارک" },
  { v: "purchase", label: "رفتار خرید" },
  { v: "finance", label: "مالی" },
  { v: "support", label: "پشتیبانی و پیام‌ها" },
  { v: "crm", label: "CRM و تایم‌لاین" },
];

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-3 border-b border-dashed border-[var(--kv-line)] pb-2 text-[12.5px]">
          <dt className="text-[var(--kv-muted)]">{label}</dt>
          <dd className="font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MiniTable({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="py-3 text-[12.5px] text-[var(--kv-muted)]">{empty}</p>;
  return (
    <div className="kv-scroll -mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[520px] text-right text-[12.5px]">
        <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">{head.map((h) => <th key={h} className="pb-2 font-semibold">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-[var(--kv-line)]">
          {rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} className="py-2 align-top">{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** Buyer 360° (items 18-19): one page with every dimension of a wholesale buyer plus
 *  audited admin controls (membership, credit, block, labels, notes, documents). */
export function Buyer360Panel({ flash }: { flash: (message: string) => void }) {
  const [list, setList] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [listView, setListView] = useState<"all" | "expiring" | "top_buyers" | "low_activity" | "expired_plan">("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<Buyer360Payload | null>(null);
  const [section, setSection] = useState<Section>("market");
  const [error, setError] = useState<string | null>(null);
  const [whyFor, setWhyFor] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState("");
  const [labelForm, setLabelForm] = useState({ labelCode: "", note: "" });
  const [noteForm, setNoteForm] = useState({ body: "", visibility: "internal" as "internal" | "support" });
  const [correction, setCorrection] = useState({ field: "city" as "firstName" | "lastName" | "birthday" | "city", newValue: "", reason: "" });
  const [document, setDocument] = useState({ open: false, docType: "trade_license", title: "", note: "" });
  const [plan, setPlan] = useState({ open: false, planId: "", reason: "" });
  const [plans, setPlans] = useState<Record<string, unknown>[]>([]);

  const PAGE = 25;
  const loadList = useCallback(async () => {
    try {
      const res = await buyersApi.list({ search: search || undefined, view: listView, limit: PAGE, offset });
      setList(res.items); setTotal(Number(res.total ?? res.items.length));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری خریداران"); }
  }, [search, listView, offset]);

  const loadView = useCallback(async (userId: string) => {
    try {
      const res = await buyersApi.view360(userId);
      setView(res);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت نمای ۳۶۰"); }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { if (selected) void loadView(selected); }, [selected, loadView]);
  useEffect(() => { void buyersApi.list({ limit: 1 }).catch(() => undefined); }, []);
  useEffect(() => {
    // Wholesale plans power the "change membership" control; failures are non-fatal.
    void import("../data/api").then(({ adminApi }) => adminApi.plans().then((r) => setPlans(r.items)).catch(() => setPlans([])));
  }, []);

  const act = async (label: string, run: () => Promise<unknown>) => {
    try { await run(); flash(`${label} انجام شد`);
      if (selected) await loadView(selected); void loadList();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  if (error && !view) return <ErrorState message={error} onRetry={() => { setError(null); void loadList(); }} />;
  const account = (view?.account ?? {}) as Record<string, unknown>;
  const membership = view?.membership as Record<string, unknown> | null;
  const crm = view?.crm;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[13px] font-extrabold"><UserCog size={16} />خریداران VIP (عمده)</div>
          <div className="flex flex-wrap items-center gap-2">
            <SearchBox placeholder="نام، همراه، کسب‌وکار…" value={search} onChange={(v) => { setOffset(0); setSearch(v); }} />
            <Segmented options={[
              { v: "all", label: "همه" }, { v: "expiring", label: "نزدیک انقضا" }, { v: "top_buyers", label: "پرخرید" },
              { v: "low_activity", label: "کم‌فعال" }, { v: "expired_plan", label: "پلن منقضی" },
            ]} value={listView} onChange={(v) => { setOffset(0); setListView(v as typeof listView); }} />
          </div>
        </div>
        {!list ? <LoadingState label="در حال بارگذاری…" /> : list.length === 0 ? <Empty title="خریداری یافت نشد" desc="عبارت یا نمای دیگری را امتحان کنید." /> : (
          <div className="kv-scroll mt-4 overflow-x-auto">
            <table className="w-full min-w-[1020px] text-right text-[12.5px]">
              <thead>
                <tr className="text-[11.5px] text-[var(--kv-muted)]">
                  {["خریدار", "موبایل", "پلن", "انقضای پلن", "سفارش عمده", "سری خریداری‌شده", "ارزش کل خرید", "آخرین سفارش", "رفتار", "عملیات"].map((h) => (
                    <th key={h} className="pb-2 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--kv-line)]">
                {list.map((row) => {
                  const id = String(row.id ?? row.user_id);
                  const reasons = (row.behavior_reasons as string[]) ?? [];
                  return (
                    <tr key={id} className="hover:bg-[var(--kv-surface-2)]/60">
                      <td className="py-2.5">
                        <span className="block font-bold">{text(row.display_name ?? row.business_name, "بدون نام")}</span>
                        <span className="text-[11px] text-[var(--kv-muted)]">{text(row.business_name, "—")} · {text(row.city, "ثبت نشده")}</span>
                      </td>
                      <td className="py-2.5 tabular-nums">{text(row.phone, "ثبت نشده")}</td>
                      <td className="py-2.5">{row.plan_code ? <Status value={String(row.plan_code)} /> : "بدون پلن"}</td>
                      <td className="py-2.5 tabular-nums">{day(row.plan_ends_at)}</td>
                      <td className="py-2.5 tabular-nums">{fmtNum(Number(row.wholesale_order_count ?? 0))}</td>
                      <td className="py-2.5 tabular-nums">{fmtNum(Number(row.series_purchased ?? 0))}</td>
                      <td className="py-2.5 tabular-nums">{rial(row.total_spent_rial ?? 0)}</td>
                      <td className="py-2.5 tabular-nums">{day(row.last_order_at)}</td>
                      <td className="py-2.5">
                        <span className="relative inline-flex items-center gap-1">
                          <span className="rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">{text(row.behavior_label, "—")}</span>
                          {reasons.length > 0 && (
                            <button className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" title="چرا؟" aria-label="دلایل وضعیت"
                              onClick={() => setWhyFor(whyFor === id ? null : id)}><HelpCircle size={14} /></button>
                          )}
                          {whyFor === id && (
                            <span className="absolute left-0 top-7 z-30 w-56 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-right shadow-xl">
                              {reasons.map((reason) => <span key={reason} className="block py-0.5 text-[11px] text-[var(--kv-muted)]">• {reason}</span>)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5"><Btn variant="soft" size="sm" onClick={() => { setView(null); setSelected(id); }}>نمای ۳۶۰°</Btn></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex items-center justify-between text-[12px] text-[var(--kv-muted)]">
          <span className="tabular-nums">{fmtNum(total)} خریدار · صفحه {fmtNum(Math.floor(offset / PAGE) + 1)}</span>
          <div className="flex gap-2">
            <Btn variant="soft" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>قبلی</Btn>
            <Btn variant="soft" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>بعدی</Btn>
          </div>
        </div>
      </Card>

      {/* §67 (corrective): VIP 360 is a CENTERED WorkspaceModal — same family as Customer/Supplier 360. */}
      {selected && (
      <WorkspaceModal open onClose={() => { setSelected(null); setView(null); }} title="نمای ۳۶۰ درجه خریدار VIP">
      <div className="space-y-4">
        {!view ? <Card className="p-6"><LoadingState label="در حال بارگذاری نمای ۳۶۰ درجه…" /></Card> : (
          <>
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[19px] font-extrabold">{text(account.display_name, "خریدار عمده")}</h2>
                  <p className="mt-1 text-[12.5px] text-[var(--kv-muted)] tabular-nums">
                    {text(account.phone)} · {text(account.email)} · عضویت از {day(account.created_at)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {membership ? <Status value={String(membership.status) === "active" ? "فعال" : String(membership.status)} /> : <Status value="بدون عضویت" />}
                    {membership && <span className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1 text-[11.5px] font-bold">{text(membership.plan_title ?? membership.plan_code)} · سطح {fmtNum(Number(membership.plan_tier ?? 0))}</span>}
                    {membership && <span className="text-[11.5px] text-[var(--kv-muted)]">تا {day(membership.ends_at)}</span>}
                    {account.blocked ? <Status value="مسدود" /> : null}
                    {account.vip_level && String(account.vip_level) !== "none" ? <Status value={`VIP ${account.vip_level}`} /> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="دلیل مسدودسازی"
                    aria-label="دلیل مسدودسازی"
                    className="h-10 w-40 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" />
                  <Btn variant="soft" size="sm" icon={<ShieldCheck size={14} />}
                    onClick={() => void act("به‌روزرسانی حساب", () => buyersApi.updateProfile(String(selected), {
                      businessName: account.business_name ?? null, city: account.city ?? null,
                    }, "به‌روزرسانی از نمای ۳۶۰"))}>به‌روزرسانی حساب</Btn>
                  <Btn variant={account.blocked ? "accent" : "soft"} size="sm" icon={<Ban size={14} />}
                    onClick={() => void act(account.blocked ? "رفع مسدودی" : "مسدودسازی", () => buyersApi.block(String(selected), { blocked: !account.blocked, reason: blockReason || "اقدام مدیریتی" }))}>
                    {account.blocked ? "رفع مسدودی" : "مسدودسازی"}
                  </Btn>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ["سفارش‌های موفق", fmtNum(Number(view.purchase.orders ?? 0))],
                  ["ارزش خرید", rial(view.summary.lifetime_rial)],
                  ["کوپن‌های شخصی", fmtNum(Number(view.summary.personal_coupons ?? 0))],
                  ["مانده کیف پول", rial(view.finance.wallet_balance_rial)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2.5">
                    <p className="text-[11px] text-[var(--kv-muted)]">{label}</p>
                    <p className="mt-0.5 text-[13.5px] font-extrabold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <Segmented options={SECTIONS} value={section} onChange={setSection} />

              {section === "market" && (
                <div className="mt-4 space-y-4">
                  <Rows rows={[
                    ["نام کسب‌وکار", text(account.business_name, "—")],
                    ["کد صنفی", text(account.trade_code, "—")],
                    ["شهر / استان", `${text(account.city, "—")} / ${text(account.province, "—")}`],
                    ["وضعیت حساب", account.blocked ? "مسدود" : text(account.status, "فعال")],
                    ["تلفن ثابت", text(account.business_phone, "—")],
                    ["وب‌سایت", text(account.website, "—")],
                  ]} />
                  <div className="flex flex-wrap items-center gap-2 border-t border-[var(--kv-line)] pt-4">
                    <Btn variant="soft" size="sm" onClick={() => setPlan({ open: true, planId: String(plans[0]?.id ?? ""), reason: "" })}>تغییر پلن عضویت</Btn>
                    {membership && <Btn variant="soft" size="sm" onClick={() => void act("تعلیق عضویت", () => membershipLifecycleApi.suspend(String(membership.id), "تعلیق مدیریتی"))}>تعلیق عضویت</Btn>}
                    {membership && <Btn variant="soft" size="sm" onClick={() => void act("فعال‌سازی مجدد", () => membershipLifecycleApi.reactivate(String(membership.id)))}>فعال‌سازی مجدد</Btn>}
                    {membership && <Btn variant="soft" size="sm" onClick={() => void act("ثبت مرجوعی عضویت", () => membershipLifecycleApi.refund(String(membership.id), "0"))}>بازگشت وجه</Btn>}
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">تاریخچه عضویت</p>
                    <MiniTable head={["رویداد", "از → به", "مبلغ", "تاریخ"]} empty="رویدادی ثبت نشده است."
                      rows={(view.membershipHistory ?? []).map((row) => [
                        text(row.event_type ?? row.action),
                        `${text(row.from_status ?? row.from_plan_code, "—")} → ${text(row.to_status ?? row.to_plan_code, "—")}`,
                        rial(row.amount_rial ?? 0), day(row.created_at ?? row.occurred_at),
                      ])} />
                  </div>
                </div>
              )}

              {section === "business" && (
                <div className="mt-4 space-y-4">
                  <Rows rows={[
                    ["نام کسب‌وکار", text(account.business_name, "—")],
                    ["کد اقتصادی", text(account.economic_code ?? account.trade_code, "—")],
                    ["آدرس انبار", text(account.address_line, "—")],
                    ["امتیاز داخلی", text(account.internal_score, "—")],
                    ["سیاست تسویه", text(account.settlement_policy, "—")],
                  ]} />
                  <div className="flex items-center justify-between border-t border-[var(--kv-line)] pt-4">
                    <p className="text-[12.5px] font-bold">مدارک احراز هویت ({fmtNum(view.documents.length)})</p>
                    <Btn variant="soft" size="sm" icon={<FileText size={14} />} onClick={() => setDocument({ ...document, open: true })}>ثبت مدرک</Btn>
                  </div>
                  <MiniTable head={["نوع", "عنوان", "وضعیت", "تأیید", "اقدام"]} empty="مدرکی ثبت نشده است."
                    rows={view.documents.map((doc) => [
                      text(doc.doc_type), text(doc.title), text(doc.status),
                      day(doc.verified_at),
                      <span key="a" className="flex gap-1">
                        <Btn variant="soft" size="sm" icon={<Check size={13} />} onClick={() => void act("تأیید مدرک", () => buyersApi.verifyDocument(String(selected), String(doc.id), { status: "verified" }))}>تأیید</Btn>
                        <Btn variant="soft" size="sm" onClick={() => void act("رد مدرک", () => buyersApi.verifyDocument(String(selected), String(doc.id), { status: "rejected", note: "ناخوانا" }))}>رد</Btn>
                      </span>,
                    ])} />
                  <div className="border-t border-[var(--kv-line)] pt-4">
                    <p className="mb-2 text-[12.5px] font-bold">اصلاح اطلاعات با دلیل (ثبت در حسابرسی)</p>
                    <p className="mb-2 text-[11.5px] text-[var(--kv-muted)]">تغییر ایمیل/شماره همراه فقط با لینک تأیید یا کد یک‌بارمصرف برای خود مشتری انجام می‌شود؛ مدیر نمی‌تواند بی‌سروصدا آن را عوض کند.</p>
                    <div className="grid gap-2 sm:grid-cols-4">
                      <Select options={["firstName", "lastName", "birthday", "city"]} value={correction.field} onChange={(v) => setCorrection({ ...correction, field: v as typeof correction.field })} />
                      <Input placeholder="مقدار جدید" value={correction.newValue} onChange={(v) => setCorrection({ ...correction, newValue: v })} />
                      <Input placeholder="دلیل (الزامی)" value={correction.reason} onChange={(v) => setCorrection({ ...correction, reason: v })} />
                      <Btn variant="soft" size="sm" disabled={!correction.newValue || correction.reason.trim().length < 3}
                        onClick={() => void act("اصلاح اطلاعات", () => buyersApi.profileCorrection(String(selected), correction))}>ثبت اصلاح</Btn>
                    </div>
                  </div>
                </div>
              )}

              {section === "purchase" && (
                <div className="mt-4 space-y-4">
                  <Rows rows={[
                    ["تعداد سفارش", fmtNum(Number(view.purchase.orders ?? 0))],
                    ["مجموع خرید", rial(view.purchase.total_rial)],
                    ["میانگین سفارش", rial(view.purchase.average_order_rial)],
                    ["مرجوعی", `${fmtNum(Number(view.purchase.returns?.count ?? 0))} مورد · ${rial(view.purchase.returns?.amount_rial)}`],
                    ["آخرین سفارش", day((view.purchase as { last_order_at?: string }).last_order_at)],
                    ["سفارش لغوشده", fmtNum(Number((view.purchase as { cancelled_orders?: number }).cancelled_orders ?? 0))],
                  ]} />
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">محصولات پرخرید</p>
                    <MiniTable head={["محصول", "تعداد", "سفارش‌ها"]} empty="خریدی ثبت نشده است."
                      rows={view.purchase.favourites.map((row) => [text(row.product_name), fmtNum(Number(row.quantity ?? 0)), fmtNum(Number(row.orders ?? 0))])} />
                  </div>
                </div>
              )}

              {section === "finance" && (
                <div className="mt-4 space-y-4">
                  <Rows rows={[
                    ["فاکتورهای باز", rial(view.finance.open_invoices_rial)],
                    ["تعداد فاکتور", fmtNum(Number(view.finance.invoice_count ?? 0))],
                    ["پرداخت موفق", rial(view.finance.paid_rial)],
                    ["پرداخت ناموفق", fmtNum(Number(view.finance.failed_payments ?? 0))],
                    ["کیف پول", rial(view.finance.wallet_balance_rial)],
                    ["جمع بازگشت وجه", rial(view.finance.refunded_rial)],
                  ]} />
                  {/* VIP = دسترسی مبتنی بر پلن؛ هیچ سیستم اعتبار خریدی در UI وجود ندارد (master §13). */}
                </div>
              )}

              {section === "support" && (
                <div className="mt-4 space-y-5">
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">تیکت‌ها</p>
                    <MiniTable head={["موضوع", "دسته", "وضعیت", "تاریخ"]} empty="تیکتی ثبت نشده است."
                      rows={view.support.tickets.map((row) => [text(row.subject), text(row.category), text(row.status), day(row.created_at)])} />
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">اعلان‌ها</p>
                    <MiniTable head={["عنوان", "اولویت", "خوانده‌شده", "تاریخ"]} empty="اعلانی ثبت نشده است."
                      rows={view.support.notifications.map((row) => [text(row.title), text(row.priority), row.read_at ? "بله" : "خیر", day(row.created_at)])} />
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">پیامک‌های ارسالی</p>
                    <MiniTable head={["متن", "وضعیت", "ارسال"]} empty="پیامکی ارسال نشده است."
                      rows={view.support.sms.map((row) => [text(row.message), text(row.status), day(row.sent_at ?? row.created_at)])} />
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">یادداشت داخلی</p>
                    <Textarea placeholder="یادداشت فقط برای تیم داخلی…" value={noteForm.body} onChange={(v) => setNoteForm({ ...noteForm, body: v })} rows={3} />
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <Select options={["internal", "support"]} value={noteForm.visibility} onChange={(v) => setNoteForm({ ...noteForm, visibility: v as typeof noteForm.visibility })} />
                      <Btn variant="soft" size="sm" disabled={noteForm.body.trim().length < 3}
                        onClick={() => void act("ثبت یادداشت", async () => { await buyersApi.addNote(String(selected), noteForm); setNoteForm({ body: "", visibility: "internal" }); })}>ثبت یادداشت</Btn>
                      <span className="text-[11.5px] text-[var(--kv-muted)]">یادداشت‌ها هرگز به مشتری نمایش داده نمی‌شوند.</span>
                    </div>
                  </div>
                </div>
              )}

              {section === "crm" && (
                <div className="mt-4 space-y-5">
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">برچسب‌ها و سگمنت‌ها</p>
                    <div className="flex flex-wrap gap-2">
                      {(crm?.labels ?? []).map((label) => (
                        <span key={String(label.label_code)} className="inline-flex items-center gap-2 rounded-full border border-[var(--kv-line)] px-3 py-1.5 text-[11.5px]">
                          {text(label.title ?? label.label_code)}
                          <button className="text-[var(--kv-danger)]" title="حذف برچسب"
                            onClick={() => void act("حذف برچسب", () => buyersApi.removeLabel(String(selected), String(label.label_code)))}>×</button>
                        </span>
                      ))}
                      {(crm?.segments ?? []).map((segment) => <Tag key={String(segment.code)}>{text(segment.title)}</Tag>)}
                      {!(crm?.labels ?? []).length && !(crm?.segments ?? []).length && <span className="text-[12.5px] text-[var(--kv-muted)]">برچسبی ثبت نشده است.</span>}
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <Input placeholder="کد برچسب (مثلاً loyal_customer)" value={labelForm.labelCode} onChange={(v) => setLabelForm({ ...labelForm, labelCode: v })} />
                      <Input placeholder="یادداشت" value={labelForm.note} onChange={(v) => setLabelForm({ ...labelForm, note: v })} />
                      <Btn variant="soft" size="sm" disabled={!labelForm.labelCode.trim()}
                        onClick={() => void act("افزودن برچسب", async () => { await buyersApi.addLabel(String(selected), labelForm); setLabelForm({ labelCode: "", note: "" }); })}>افزودن برچسب</Btn>
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">رضایت بازاریابی</p>
                    <div className="flex flex-wrap gap-4 text-[12.5px]">
                      <Checkbox checked={!!crm?.consent?.marketing_sms} label="پیامک تبلیغاتی"
                        onChange={(v) => void act("ثبت رضایت", () => buyersApi.saveConsent(String(selected), { marketingSms: v, transactionalSms: !!crm?.consent?.transactional_sms, emailMarketing: !!crm?.consent?.email_marketing, doNotContact: !!crm?.consent?.do_not_contact, reason: "تنظیم از پنل مدیریت" }))} />
                      <Checkbox checked={!!crm?.consent?.email_marketing} label="ایمیل تبلیغاتی"
                        onChange={(v) => void act("ثبت رضایت", () => buyersApi.saveConsent(String(selected), { marketingSms: !!crm?.consent?.marketing_sms, transactionalSms: !!crm?.consent?.transactional_sms, emailMarketing: v, doNotContact: !!crm?.consent?.do_not_contact, reason: "تنظیم از پنل مدیریت" }))} />
                      <Checkbox checked={!!crm?.consent?.do_not_contact} label="عدم تماس (do-not-contact)"
                        onChange={(v) => void act("ثبت رضایت", () => buyersApi.saveConsent(String(selected), { marketingSms: !!crm?.consent?.marketing_sms, transactionalSms: !!crm?.consent?.transactional_sms, emailMarketing: !!crm?.consent?.email_marketing, doNotContact: v, reason: "تنظیم از پنل مدیریت" }))} />
                    </div>
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">دیدگاه‌های ثبت‌شده</p>
                    <MiniTable head={["محصول", "امتیاز", "عنوان", "وضعیت"]} empty="دیدگاهی ثبت نشده است."
                      rows={(crm?.reviews ?? []).map((row) => [text(row.product_name), `${fmtNum(Number(row.rating ?? 0))}/۵`, text(row.title), text(row.status)])} />
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">تایم‌لاین کامل فعالیت</p>
                    <MiniTable head={["رویداد", "عنوان", "منبع", "زمان"]} empty="فعالیتی ثبت نشده است."
                      rows={(crm?.timeline ?? []).map((row) => [text(row.event_type), text(row.title), text(row.source), row.occurred_at ? formatPersianDateTime(String(row.occurred_at)) : "—"])} />
                  </div>
                  <div>
                    <p className="mb-2 text-[12.5px] font-bold">حسابرسی اقدامات مدیریتی</p>
                    <MiniTable head={["اقدام", "مقدار قبلی", "مقدار جدید", "زمان"]} empty="موردی ثبت نشده است."
                      rows={view.audit.map((row) => [
                        text(row.action),
                        <code key="o" className="text-[11px] text-[var(--kv-muted)]">{JSON.stringify(row.old_value ?? {}).slice(0, 60)}</code>,
                        <code key="n" className="text-[11px]">{JSON.stringify(row.new_value ?? {}).slice(0, 60)}</code>,
                        row.created_at ? formatPersianDateTime(String(row.created_at)) : "—",
                      ])} />
                  </div>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
      </WorkspaceModal>
      )}

      <Modal open={document.open} onClose={() => setDocument({ ...document, open: false })} title="ثبت مدرک خریدار">
        <div className="space-y-3">
          <Field label="نوع مدرک"><Select options={["trade_license", "business_card", "national_id", "store_photo", "other"]} value={document.docType} onChange={(v) => setDocument({ ...document, docType: v })} /></Field>
          <Field label="عنوان"><Input value={document.title} onChange={(v) => setDocument({ ...document, title: v })} placeholder="پروانه کسب ۱۴۰۳" /></Field>
          <Field label="یادداشت"><Textarea value={document.note} onChange={(v) => setDocument({ ...document, note: v })} /></Field>
          <Btn variant="accent" className="w-full" disabled={document.title.trim().length < 2}
            onClick={() => void act("ثبت مدرک", async () => { await buyersApi.addDocument(String(selected), { docType: document.docType, title: document.title, note: document.note }); setDocument({ open: false, docType: "trade_license", title: "", note: "" }); })}>ثبت</Btn>
        </div>
      </Modal>

      <Modal open={plan.open} onClose={() => setPlan({ ...plan, open: false })} title="تغییر پلن عضویت">
        <div className="space-y-3">
          <Field label="پلن هدف">
            <Select options={plans.map((p) => String(p.code ?? p.id))} value={plan.planId}
              onChange={(v) => { const found = plans.find((p) => String(p.code ?? p.id) === v); setPlan({ ...plan, planId: String(found?.id ?? v) }); }} />
          </Field>
          <Field label="دلیل (ثبت در حسابرسی)"><Input value={plan.reason} onChange={(v) => setPlan({ ...plan, reason: v })} /></Field>
          <Btn variant="accent" className="w-full" disabled={!plan.planId || plan.reason.trim().length < 3}
            onClick={() => void act("تغییر پلن", async () => { await membershipLifecycleApi.changePlan(String(membership?.id), plan.planId, plan.reason); setPlan({ open: false, planId: "", reason: "" }); })}>تغییر پلن</Btn>
        </div>
      </Modal>
    </div>
  );
}
