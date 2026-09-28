import { useMemo, useState } from "react";
import { Check, MessageSquare, Phone, Plug, Plus, Send, Tag, Ticket as TicketIcon, Trash2, Users, CalendarClock, Megaphone } from "lucide-react";
import { SUPPLIERS, fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { useOps, opsNow, smsParts, type Coupon, type Festival, type Lead, type LeadStage } from "../data/ops";
import { useEffect } from "react";
import { apiCall } from "../data/admin-api";
import { BarList, Kpi } from "../components/charts";
import { Btn, Card, Checkbox, Drawer, Empty, Field, Input, Segmented, Select, Status, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";

type F = (m: string) => void;
const faDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));

/* Unified customer view: CRM server + real storefront accounts — SEED removed, server is source of truth */
function useCustomers() {
  const { accounts, retailOrders } = useStore();
  const [serverContacts, setServerContacts] = useState<any[] | null>(null);
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  useEffect(() => {
    if (isDemo) return;
    apiCall<{ items: any[] }>("/admin/crm/contacts").then((res:any)=> setServerContacts(res.items ?? [])).catch(()=> setServerContacts([]));
  }, [isDemo]);
  return useMemo(() => {
    const fromAccounts = accounts.map((a) => {
      const orders = retailOrders.filter((o) => o.accountId === a.id);
      const spent = orders.reduce((s, o) => s + o.total, 0);
      return { id: a.id, name: a.name, phone: a.phone, city: a.addresses[0]?.city ?? "—", orders: orders.length, spent, last: orders[0]?.createdAt ?? "—", source: "حساب سایت" };
    });
    const crmContacts = (serverContacts ?? []).map((c:any)=> ({ id: c.id, name: c.name ?? c.display_name, phone: c.phone ?? c.phone_number ?? "", city: c.city ?? "—", orders: Number(c.orders_count ?? 0), spent: Number(c.ltv_rial ?? c.spent ?? 0), last: c.last_order_at ?? "—", source: "CRM" }));
    const known = new Set(fromAccounts.map((c) => c.phone));
    const filtered = crmContacts.filter((c) => !known.has(faDigits(c.phone).replace(/\s/g, "")));
    const merged = isDemo ? [...fromAccounts] : [...fromAccounts, ...filtered];
    return merged.map((c) => ({ ...c, segment: c.orders >= 7 ? "وفادار" : c.spent >= 30000000 ? "پرخرج" : c.orders <= 1 ? "جدید" : "فعال" }));
  }, [accounts, retailOrders, serverContacts, isDemo]);
}

/* ================= SMS ================= */
const PROVIDERS = ["کاوه‌نگار", "ملی‌پیامک", "قاصدک", "SMS.ir", "فراز اس‌ام‌اس", "آی‌پی‌پنل"];

export function SmsCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const { buyers } = useStore();
  const customers = useCustomers();
  const [tab, setTab] = useState<"send" | "connect" | "history">(ops.sms.connected ? "send" : "connect");
  const [cfg, setCfg] = useState(ops.sms);
  const [audience, setAudience] = useState("همه مشتریان");
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("{name} عزیز، ");
  const [schedule, setSchedule] = useState("");
  const [optOut, setOptOut] = useState(true);
  const lists: Record<string, number> = {
    "همه مشتریان": customers.length, "مشتریان وفادار": customers.filter((c) => c.segment === "وفادار").length,
    "مشتریان پرخرج": customers.filter((c) => c.segment === "پرخرج").length, "مشتریان جدید": customers.filter((c) => c.segment === "جدید").length,
    "خریداران عمده فعال": buyers.filter((b) => b.status === "فعال").length, "تأمین‌کنندگان": SUPPLIERS.length + ops.extraSuppliers.length,
    "شماره‌های دستی": custom.split(/[\s,،\n]+/).filter((n) => /^09\d{9}$/.test(faDigits(n))).length,
  };
  const body = text + (optOut ? "\nلغو۱۱" : "");
  const parts = smsParts(body);
  const recipients = lists[audience] ?? 0;
  const cost = parts * recipients * ops.sms.pricePerPart;
  const testConnection = () => {
    if (cfg.apiKey.trim().length < 16) { flash("کلید API باید دست‌کم ۱۶ کاراکتر باشد"); return; }
    if (!/^\d{4,14}$/.test(faDigits(cfg.sender))) { flash("شماره خط ارسال معتبر نیست"); return; }
    ops.set("sms", { ...cfg, connected: true, lastCheck: opsNow() });
    flash(`تنظیمات ${cfg.provider} ذخیره شد`);
    setTab("send");
  };
  const send = () => {
    if (!ops.sms.connected) { setTab("connect"); return; }
    if (!name.trim() || text.trim().length < 5 || recipients < 1) return;
    ops.upsert("smsCampaigns", { id: `SMS-${Date.now().toString().slice(-4)}`, name: name.trim(), audience, recipients, message: body, parts, cost, status: schedule ? "scheduled" : "sent", at: schedule ? new Date(schedule).toLocaleString("fa-IR") : opsNow() }, true);
    flash(schedule ? "ارسال زمان‌بندی شد" : `پیامک برای ${fmtNum(recipients)} نفر در صف ارسال قرار گرفت`);
    setName(""); setText("{name} عزیز، "); setSchedule("");
  };
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<"send" | "connect" | "history"> options={[{ v: "send", label: "ارسال همگانی" }, { v: "connect", label: "اتصال پنل پیامکی" }, { v: "history", label: "سوابق ارسال" }]} value={tab} onChange={setTab} />
        <Status value={ops.sms.connected ? "متصل" : "قطع"} />
      </div>
      {tab === "connect" && (
        <Card className="max-w-[640px] p-5">
          <p className="flex items-center gap-2 text-[15px] font-extrabold"><Plug size={17} className="text-[var(--kv-accent)]" />تنظیمات سرویس‌دهنده پیامک</p>
          <div className="mt-4 space-y-4">
            <Field label="سرویس‌دهنده"><Select options={PROVIDERS} value={cfg.provider} onChange={(v) => setCfg({ ...cfg, provider: v })} /></Field>
            <Field label="کلید API" hint="فقط در همین نشست نگه داشته می‌شود؛ اتصال واقعی نیازمند ذخیره امن در سرور است"><Input type="password" value={cfg.apiKey} onChange={(v) => setCfg({ ...cfg, apiKey: v.trim() })} placeholder="••••••••••••••••" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="شماره خط ارسال"><Input value={cfg.sender} onChange={(v) => setCfg({ ...cfg, sender: v })} /></Field>
              <Field label="هزینه هر بخش (تومان)"><Input value={String(cfg.pricePerPart)} onChange={(v) => setCfg({ ...cfg, pricePerPart: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>
            </div>
            <p className="rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3 text-[12px] leading-6 text-[var(--kv-muted)]">برای امنیت، کلید API در نسخه نهایی فقط روی سرور نگهداری و درخواست‌ها از طریق بک‌اند ارسال می‌شود. در این نسخه آزمایشی قالب کلید بررسی و ارسال‌ها شبیه‌سازی می‌شوند.</p>
            <div className="flex gap-2"><Btn variant="accent" onClick={testConnection} icon={<Check size={15} />}>ذخیره و اتصال</Btn>{ops.sms.connected && <Btn variant="ghost" onClick={() => { ops.set("sms", { ...ops.sms, connected: false }); setCfg({ ...cfg, connected: false }); flash("اتصال قطع شد"); }}>قطع اتصال</Btn>}</div>
            {ops.sms.lastCheck && <p className="text-[11.5px] text-[var(--kv-muted)]">آخرین ذخیره: {ops.sms.lastCheck}</p>}
          </div>
        </Card>
      )}
      {tab === "send" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="p-5">
            <p className="mb-4 flex items-center gap-2 text-[15px] font-extrabold"><Megaphone size={17} className="text-[var(--kv-accent)]" />پیامک همگانی</p>
            <div className="space-y-4">
              <Field label="نام کمپین"><Input value={name} onChange={setName} placeholder="مثلاً جشنواره پاییزه" /></Field>
              <Field label="مخاطبان"><Select options={Object.keys(lists).map((k) => k)} value={audience} onChange={setAudience} /></Field>
              {audience === "شماره‌های دستی" && <Field label="شماره‌ها" hint="با فاصله، ویرگول یا خط جدید جدا کنید"><Textarea rows={3} value={custom} onChange={setCustom} placeholder="09121234567, 09351234567" /></Field>}
              <Field label="متن پیامک" hint="متغیر {name} با نام هر مخاطب جایگزین می‌شود"><Textarea rows={5} value={text} onChange={setText} /></Field>
              <Checkbox checked={optOut} onChange={setOptOut} label="افزودن «لغو۱۱» (الزام مقررات پیامک تبلیغاتی)" />
              <Field label="زمان‌بندی (اختیاری)"><input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /></Field>
              <Btn variant="accent" disabled={!name.trim() || text.trim().length < 5 || recipients < 1} onClick={send} icon={<Send size={15} />}>{!ops.sms.connected ? "ابتدا پنل پیامکی را متصل کنید" : schedule ? "زمان‌بندی ارسال" : "ارسال"}</Btn>
            </div>
          </Card>
          <div className="space-y-4">
            <Card className="p-5">
              <p className="mb-3 text-[13px] font-bold">پیش‌نمایش گوشی</p>
              <div className="rounded-[18px] bg-[var(--kv-surface-2)] p-4"><div className="max-w-[240px] whitespace-pre-line rounded-[14px] rounded-tr-sm bg-[var(--kv-surface)] p-3 text-[12.5px] leading-6 kv-shadow-sm">{body.replace("{name}", "سارا")}</div></div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
                <dt className="text-[var(--kv-muted)]">تعداد کاراکتر</dt><dd className="font-bold tabular-nums">{fmtNum(body.length)}</dd>
                <dt className="text-[var(--kv-muted)]">بخش پیامک</dt><dd className="font-bold tabular-nums">{fmtNum(parts)}</dd>
                <dt className="text-[var(--kv-muted)]">گیرندگان</dt><dd className="font-bold tabular-nums">{fmtNum(recipients)}</dd>
                <dt className="text-[var(--kv-muted)]">هزینه تخمینی</dt><dd className="font-bold tabular-nums">{fmtMoney(cost)}</dd>
              </dl>
            </Card>
          </div>
        </div>
      )}
      {tab === "history" && (
        <Card className="overflow-hidden"><div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[720px]"><thead><tr><th>کمپین</th><th>مخاطبان</th><th>گیرنده</th><th>بخش</th><th>هزینه</th><th>زمان</th><th>وضعیت</th></tr></thead><tbody>
          {ops.smsCampaigns.map((c) => <tr key={c.id}><td><b>{c.name}</b><p className="max-w-[260px] truncate text-[11px] text-[var(--kv-muted)]">{c.message}</p></td><td>{c.audience}</td><td className="tabular-nums">{fmtNum(c.recipients)}</td><td className="tabular-nums">{fmtNum(c.parts)}</td><td className="tabular-nums">{fmtMoney(c.cost)}</td><td className="text-[var(--kv-muted)]">{c.at}</td><td><Status value={c.status === "sent" ? "ارسال شد" : c.status === "scheduled" ? "در انتظار" : "پیش‌نویس"} /></td></tr>)}
        </tbody></table></div></Card>
      )}
    </div>
  );
}

/* ================= CRM ================= */
const STAGES: { v: LeadStage; label: string }[] = [{ v: "new", label: "جدید" }, { v: "contacted", label: "تماس گرفته شد" }, { v: "qualified", label: "واجد شرایط" }, { v: "won", label: "موفق" }, { v: "lost", label: "از دست رفته" }];

export function CrmCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const customers = useCustomers();
  const [tab, setTab] = useState<"customers" | "pipeline" | "tasks" | "segments">("customers");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [tag, setTag] = useState("");
  const [lead, setLead] = useState<Lead | null>(null);
  const [task, setTask] = useState({ title: "", customer: "", due: "امروز", type: "call" as "call" | "sms" | "meeting" });
  const [rule, setRule] = useState({ minSpent: "", minOrders: "", city: "همه", segment: "همه" });
  const cur = customers.find((c) => c.id === sel);
  const list = customers.filter((c) => !q.trim() || c.name.includes(q.trim()) || faDigits(c.phone).includes(faDigits(q.trim())));
  const segmentHits = customers.filter((c) => (!rule.minSpent || c.spent >= Number(faDigits(rule.minSpent))) && (!rule.minOrders || c.orders >= Number(faDigits(rule.minOrders))) && (rule.city === "همه" || c.city === rule.city) && (rule.segment === "همه" || c.segment === rule.segment));
  const cities = ["همه", ...Array.from(new Set(customers.map((c) => c.city).filter((c) => c !== "—")))];
  const pipelineValue = ops.leads.filter((l) => l.stage !== "lost" && l.stage !== "won").reduce((a, l) => a + l.value, 0);
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="مخاطبان CRM" value={fmtNum(customers.length)} hint={`${fmtNum(customers.filter((c) => c.source === "حساب سایت").length)} حساب سایت`} />
        <Kpi label="ارزش قیف فروش باز" value={fmtMoney(pipelineValue)} />
        <Kpi label="نرخ تبدیل سرنخ" value={`${fmtNum(Math.round(ops.leads.filter((l) => l.stage === "won").length / Math.max(1, ops.leads.length) * 100))}٪`} />
        <Kpi label="وظایف امروز" value={fmtNum(ops.tasks.filter((t) => !t.done && t.due === "امروز").length)} hint={`${fmtNum(ops.tasks.filter((t) => !t.done).length)} باز`} />
      </div>
      <Segmented<"customers" | "pipeline" | "tasks" | "segments"> options={[{ v: "customers", label: "مشتریان" }, { v: "pipeline", label: "قیف فروش" }, { v: "tasks", label: "وظایف و پیگیری" }, { v: "segments", label: "بخش‌بندی" }]} value={tab} onChange={setTab} />

      {tab === "customers" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="overflow-hidden">
            <div className="p-4"><Input value={q} onChange={setQ} placeholder="جست‌وجوی نام یا شماره…" /></div>
            <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[680px]"><thead><tr><th>مشتری</th><th>شهر</th><th>سفارش</th><th>ارزش خرید</th><th>بخش</th><th>برچسب‌ها</th></tr></thead><tbody>
              {list.map((c) => <tr key={c.id} onClick={() => setSel(c.id)} className={cn("cursor-pointer", sel === c.id && "bg-[var(--kv-accent)]/[0.05]")}><td><b>{c.name}</b><p className="text-[11px] text-[var(--kv-muted)] tabular-nums">{c.phone} · {c.source}</p></td><td>{c.city}</td><td className="tabular-nums">{fmtNum(c.orders)}</td><td className="font-bold tabular-nums">{fmtMoney(c.spent)}</td><td><Status value={c.segment} /></td><td><div className="flex flex-wrap gap-1">{(ops.tags[c.id] ?? []).map((t) => <span key={t} className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px] font-semibold">{t}</span>)}</div></td></tr>)}
            </tbody></table></div>
          </Card>
          <Card className="h-fit p-5">
            {!cur ? <Empty title="مشتری انتخاب نشده" desc="برای دیدن پروفایل ۳۶۰، روی یک ردیف بزنید." /> : (
              <div>
                <div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-[var(--kv-accent)]/12 text-lg font-bold text-[var(--kv-accent)]">{cur.name[0]}</span><div><p className="text-[15px] font-extrabold">{cur.name}</p><p className="text-xs text-[var(--kv-muted)] tabular-nums">{cur.phone} · {cur.city}</p></div></div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">{[["سفارش", fmtNum(cur.orders)], ["LTV", fmtMoney(cur.spent)], ["آخرین خرید", cur.last]].map(([l, v]) => <div key={l} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2"><p className="text-[11.5px] font-extrabold tabular-nums">{v}</p><p className="text-[10.5px] text-[var(--kv-muted)]">{l}</p></div>)}</div>
                <p className="mb-1.5 mt-4 text-[12.5px] font-bold">برچسب‌ها</p>
                <div className="flex flex-wrap gap-1.5">{(ops.tags[cur.id] ?? []).map((t) => <button key={t} onClick={() => ops.set("tags", { ...ops.tags, [cur.id]: (ops.tags[cur.id] ?? []).filter((x) => x !== t) })} className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11.5px] font-semibold hover:line-through">{t} ×</button>)}</div>
                <div className="mt-2 flex gap-2"><Input className="flex-1" value={tag} onChange={setTag} placeholder="برچسب جدید" /><Btn size="sm" variant="soft" disabled={!tag.trim()} onClick={() => { ops.set("tags", { ...ops.tags, [cur.id]: Array.from(new Set([...(ops.tags[cur.id] ?? []), tag.trim()])) }); setTag(""); }} icon={<Tag size={13} />}>افزودن</Btn></div>
                <p className="mb-1.5 mt-4 text-[12.5px] font-bold">یادداشت‌ها</p>
                <div className="space-y-1.5">{ops.notes.filter((n) => n.customerId === cur.id).map((n) => <p key={n.id} className="rounded-[10px] bg-[var(--kv-surface-2)]/60 px-3 py-2 text-[12px] leading-6">{n.text}<span className="block text-[10.5px] text-[var(--kv-faint)]">{n.at}</span></p>)}</div>
                <Textarea rows={2} value={note} onChange={setNote} placeholder="یادداشت جدید…" />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Btn size="sm" variant="soft" disabled={!note.trim()} onClick={() => { ops.upsert("notes", { id: `n-${Date.now()}`, customerId: cur.id, text: note.trim(), at: opsNow() }, true); setNote(""); flash("یادداشت ثبت شد"); }} icon={<MessageSquare size={13} />}>ثبت یادداشت</Btn>
                  <Btn size="sm" variant="accent" onClick={() => { ops.upsert("tasks", { id: `t-${Date.now()}`, title: "تماس پیگیری", customer: cur.name, due: "فردا", done: false, type: "call" }, true); flash("وظیفه پیگیری برای فردا ساخته شد"); }} icon={<Phone size={13} />}>پیگیری فردا</Btn>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "pipeline" && (
        <div>
          <div className="mb-3 flex justify-end"><Btn size="sm" variant="accent" icon={<Plus size={14} />} onClick={() => setLead({ id: `ld-${Date.now()}`, name: "", phone: "", source: "سایت", stage: "new", value: 0, owner: "نیلوفر", note: "", createdAt: opsNow() })}>سرنخ جدید</Btn></div>
          <div className="kv-scroll grid auto-cols-[minmax(230px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2">
            {STAGES.map((st) => { const items = ops.leads.filter((l) => l.stage === st.v); return (
              <div key={st.v} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 p-3">
                <div className="mb-2 flex items-center justify-between"><p className="text-[13px] font-extrabold">{st.label}</p><span className="text-[11.5px] text-[var(--kv-muted)] tabular-nums">{fmtNum(items.length)} · {fmtNum(Math.round(items.reduce((a, l) => a + l.value, 0) / 1e6))}م</span></div>
                <div className="space-y-2">{items.map((l) => (
                  <div key={l.id} className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3">
                    <button onClick={() => setLead(l)} className="w-full text-right"><p className="text-[13px] font-bold">{l.name}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{l.source} · {l.owner}</p><p className="mt-1 text-[12px] font-bold tabular-nums">{fmtMoney(l.value)}</p></button>
                    <label className="sr-only" htmlFor={`st-${l.id}`}>مرحله</label>
                    <select id={`st-${l.id}`} value={l.stage} onChange={(e) => { ops.upsert("leads", { ...l, stage: e.target.value as LeadStage }); flash(`${l.name} به «${STAGES.find((s) => s.v === e.target.value)?.label}» منتقل شد`); }} className="mt-2 h-9 w-full rounded-[8px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 text-[11.5px] outline-none">{STAGES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select>
                  </div>
                ))}</div>
              </div>
            ); })}
          </div>
          <Drawer open={!!lead} onClose={() => setLead(null)} title={lead?.name || "سرنخ جدید"}>
            {lead && <div className="space-y-4">
              <Field label="نام"><Input value={lead.name} onChange={(v) => setLead({ ...lead, name: v })} /></Field>
              <Field label="شماره تماس"><Input value={lead.phone} onChange={(v) => setLead({ ...lead, phone: v })} /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="منبع"><Select options={["سایت", "اینستاگرام", "فرم عضویت عمده", "نمایشگاه", "معرفی"]} value={lead.source} onChange={(v) => setLead({ ...lead, source: v })} /></Field><Field label="مسئول"><Select options={["نیلوفر", "آرش", "سارا"]} value={lead.owner} onChange={(v) => setLead({ ...lead, owner: v })} /></Field></div>
              <Field label="ارزش تخمینی (تومان)"><Input value={String(lead.value)} onChange={(v) => setLead({ ...lead, value: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>
              <Field label="یادداشت"><Textarea rows={3} value={lead.note} onChange={(v) => setLead({ ...lead, note: v })} /></Field>
              <div className="flex gap-2"><Btn variant="accent" disabled={!lead.name.trim()} onClick={() => { ops.upsert("leads", lead, true); setLead(null); flash("سرنخ ذخیره شد"); }}>ذخیره</Btn><Btn variant="ghost" icon={<Trash2 size={14} />} onClick={() => { ops.remove("leads", lead.id); setLead(null); }}>حذف</Btn></div>
            </div>}
          </Drawer>
        </div>
      )}

      {tab === "tasks" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="p-5">
            <div className="divide-y divide-[var(--kv-line)]">{ops.tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 py-3">
                <input type="checkbox" aria-label={`انجام ${t.title}`} checked={t.done} onChange={() => ops.upsert("tasks", { ...t, done: !t.done })} className="h-4 w-4 accent-[#C1613B]" />
                <div className={cn("flex-1", t.done && "opacity-50 line-through")}><p className="text-[13px] font-bold">{t.title}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{t.customer} · {t.type === "call" ? "تماس" : t.type === "sms" ? "پیامک" : "جلسه"}</p></div>
                <span className="flex items-center gap-1 text-[12px] text-[var(--kv-muted)]"><CalendarClock size={13} />{t.due}</span>
                <button aria-label="حذف وظیفه" onClick={() => ops.remove("tasks", t.id)} className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--kv-faint)] hover:text-[var(--kv-danger)]"><Trash2 size={14} /></button>
              </div>
            ))}</div>
          </Card>
          <Card className="h-fit p-5">
            <p className="mb-3 text-[14px] font-extrabold">وظیفه جدید</p>
            <div className="space-y-3">
              <Field label="عنوان"><Input value={task.title} onChange={(v) => setTask({ ...task, title: v })} /></Field>
              <Field label="مشتری"><Select options={["—", ...customers.map((c) => c.name), ...ops.leads.map((l) => l.name)]} value={task.customer || "—"} onChange={(v) => setTask({ ...task, customer: v })} /></Field>
              <div className="grid grid-cols-2 gap-2"><Field label="موعد"><Select options={["امروز", "فردا", "این هفته", "هفته بعد"]} value={task.due} onChange={(v) => setTask({ ...task, due: v })} /></Field><Field label="نوع"><Select options={["تماس", "پیامک", "جلسه"]} value={task.type === "call" ? "تماس" : task.type === "sms" ? "پیامک" : "جلسه"} onChange={(v) => setTask({ ...task, type: v === "تماس" ? "call" : v === "پیامک" ? "sms" : "meeting" })} /></Field></div>
              <Btn variant="accent" className="w-full" disabled={!task.title.trim()} onClick={() => { ops.upsert("tasks", { id: `t-${Date.now()}`, ...task, customer: task.customer === "—" ? "" : task.customer, done: false }, true); setTask({ title: "", customer: "", due: "امروز", type: "call" }); flash("وظیفه اضافه شد"); }}>افزودن وظیفه</Btn>
            </div>
          </Card>
        </div>
      )}

      {tab === "segments" && (
        <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <Card className="h-fit p-5">
            <p className="mb-3 flex items-center gap-2 text-[14px] font-extrabold"><Users size={16} className="text-[var(--kv-accent)]" />قواعد بخش‌بندی</p>
            <div className="space-y-3">
              <Field label="حداقل مبلغ خرید (تومان)"><Input value={rule.minSpent} onChange={(v) => setRule({ ...rule, minSpent: v.replace(/[^\d۰-۹]/g, "") })} /></Field>
              <Field label="حداقل تعداد سفارش"><Input value={rule.minOrders} onChange={(v) => setRule({ ...rule, minOrders: v.replace(/[^\d۰-۹]/g, "") })} /></Field>
              <Field label="شهر"><Select options={cities} value={rule.city} onChange={(v) => setRule({ ...rule, city: v })} /></Field>
              <Field label="بخش رفتاری"><Select options={["همه", "وفادار", "پرخرج", "فعال", "جدید"]} value={rule.segment} onChange={(v) => setRule({ ...rule, segment: v })} /></Field>
              <p className="rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3 text-[13px]"><b className="tabular-nums">{fmtNum(segmentHits.length)}</b> مخاطب با این قواعد</p>
              <Btn variant="soft" className="w-full" disabled={!segmentHits.length} onClick={() => flash(`${fmtNum(segmentHits.length)} مخاطب برای کمپین پیامکی آماده شد؛ از بخش پیامک «شماره‌های دستی» استفاده کنید`)}>ارسال به کمپین</Btn>
            </div>
          </Card>
          <Card className="p-5"><p className="mb-4 text-[14px] font-extrabold">ارزش خرید مخاطبان این بخش</p>{segmentHits.length ? <BarList items={segmentHits.sort((a, b) => b.spent - a.spent).slice(0, 10).map((c) => ({ label: c.name, value: c.spent, sub: `${fmtNum(c.orders)} سفارش` }))} /> : <Empty title="مخاطبی پیدا نشد" desc="قواعد را کمی باز کنید." />}</Card>
        </div>
      )}
    </div>
  );
}

/* ================= Promotions ================= */
export function PromoCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const { products } = useStore();
  const cats = Array.from(new Set(products.map((p) => p.category)));
  const [tab, setTab] = useState<"coupons" | "festivals">("coupons");
  const [cp, setCp] = useState<Coupon | null>(null);
  const [fs, setFs] = useState<Festival | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<"coupons" | "festivals"> options={[{ v: "coupons", label: "کوپن‌ها" }, { v: "festivals", label: "جشنواره‌ها" }]} value={tab} onChange={setTab} />
        {tab === "coupons"
          ? <Btn size="sm" variant="accent" icon={<Plus size={14} />} onClick={() => setCp({ id: `cp-${Date.now()}`, code: "", type: "percent", value: 10, minOrder: 0, maxUses: 100, used: 0, channel: "retail", expires: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), active: true })}>کوپن جدید</Btn>
          : <Btn size="sm" variant="accent" icon={<Plus size={14} />} onClick={() => setFs({ id: `fs-${Date.now()}`, name: "", starts: today, ends: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), discountPercent: 10, categories: [], active: true, bannerText: "" })}>جشنواره جدید</Btn>}
      </div>
      {tab === "coupons" ? (
        <Card className="overflow-hidden"><div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[800px]"><thead><tr><th>کد</th><th>نوع</th><th>کانال</th><th>حداقل خرید</th><th>مصرف</th><th>انقضا</th><th>فعال</th><th></th></tr></thead><tbody>
          {ops.coupons.map((c) => <tr key={c.id}>
            <td><b className="tabular-nums" dir="ltr">{c.code}</b></td>
            <td>{c.type === "percent" ? `${fmtNum(c.value)}٪ تخفیف` : c.type === "fixed" ? `${fmtMoney(c.value)} تخفیف` : "ارسال رایگان"}</td>
            <td>{c.channel === "retail" ? "خرده" : "عمده"}</td><td className="tabular-nums">{fmtMoney(c.minOrder)}</td>
            <td><div className="flex items-center gap-2"><span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--kv-surface-2)]"><span className="block h-full bg-[var(--kv-accent)]" style={{ width: `${Math.min(100, c.used / Math.max(1, c.maxUses) * 100)}%` }} /></span><span className="text-[11.5px] tabular-nums">{fmtNum(c.used)}/{fmtNum(c.maxUses)}</span></div></td>
            <td className={c.expires < today ? "text-[var(--kv-danger)]" : "text-[var(--kv-muted)]"}>{new Date(c.expires).toLocaleDateString("fa-IR")}</td>
            <td><Switch on={c.active} onToggle={() => ops.upsert("coupons", { ...c, active: !c.active })} /></td>
            <td><Btn size="sm" variant="ghost" onClick={() => setCp(c)}>ویرایش</Btn></td>
          </tr>)}
        </tbody></table></div></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {ops.festivals.map((f) => { const live = f.active && f.starts <= today && f.ends >= today; return (
            <Card key={f.id} className="p-5">
              <div className="flex items-center justify-between gap-2"><p className="text-[15px] font-extrabold">{f.name}</p><Status value={live ? "فعال" : f.ends < today ? "بسته شد" : "پیش‌نویس"} /></div>
              <p className="mt-1 text-[12.5px] text-[var(--kv-muted)]">{new Date(f.starts).toLocaleDateString("fa-IR")} تا {new Date(f.ends).toLocaleDateString("fa-IR")} · {fmtNum(f.discountPercent)}٪ تخفیف</p>
              <div className="mt-3 flex flex-wrap gap-1.5">{f.categories.map((c) => <span key={c} className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11.5px] font-semibold">{c}</span>)}</div>
              <p className="mt-3 text-[12px] text-[var(--kv-muted)]">تخفیف جشنواره در سبد خرید خرده روی محصولات دسته‌های بالا خودکار اعمال می‌شود. برای نمایش تایمر، کامپوننت «تایمر» را در CMS فعال کنید.</p>
              <div className="mt-3 flex gap-2"><Btn size="sm" variant="soft" onClick={() => setFs(f)}>ویرایش</Btn><Switch on={f.active} onToggle={() => ops.upsert("festivals", { ...f, active: !f.active })} /></div>
            </Card>
          ); })}
          {ops.festivals.length === 0 && <Empty title="جشنواره‌ای تعریف نشده" desc="بازه زمانی، درصد و دسته‌ها را تعریف کنید." />}
        </div>
      )}
      <Drawer open={!!cp} onClose={() => setCp(null)} title={cp?.code ? `کوپن ${cp.code}` : "کوپن جدید"}>
        {cp && <div className="space-y-4">
          <Field label="کد"><Input value={cp.code} onChange={(v) => setCp({ ...cp, code: v.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="SUMMER10" /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="نوع"><Select options={["درصدی", "مبلغ ثابت", "ارسال رایگان"]} value={cp.type === "percent" ? "درصدی" : cp.type === "fixed" ? "مبلغ ثابت" : "ارسال رایگان"} onChange={(v) => setCp({ ...cp, type: v === "درصدی" ? "percent" : v === "مبلغ ثابت" ? "fixed" : "freeShip" })} /></Field><Field label="کانال"><Select options={["خرده", "عمده"]} value={cp.channel === "retail" ? "خرده" : "عمده"} onChange={(v) => setCp({ ...cp, channel: v === "خرده" ? "retail" : "wholesale", type: v === "عمده" && cp.type !== "percent" ? "percent" : cp.type })} /></Field></div>
          {cp.type !== "freeShip" && <Field label={cp.type === "percent" ? "درصد تخفیف" : "مبلغ تخفیف (تومان)"} hint={cp.channel === "wholesale" ? "کوپن عمده فقط درصدی است و به تخفیف پلن اضافه می‌شود" : undefined}><Input value={String(cp.value)} onChange={(v) => setCp({ ...cp, value: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>}
          <div className="grid grid-cols-2 gap-3"><Field label="حداقل خرید (تومان)"><Input value={String(cp.minOrder)} onChange={(v) => setCp({ ...cp, minOrder: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field><Field label="سقف دفعات استفاده"><Input value={String(cp.maxUses)} onChange={(v) => setCp({ ...cp, maxUses: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field></div>
          <Field label="تاریخ انقضا"><input type="date" value={cp.expires} onChange={(e) => setCp({ ...cp, expires: e.target.value })} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none" /></Field>
          <div className="flex gap-2"><Btn variant="accent" disabled={cp.code.length < 3 || (cp.type === "percent" && (cp.value < 1 || cp.value > 90)) || ops.coupons.some((x) => x.code === cp.code && x.id !== cp.id)} onClick={() => { ops.upsert("coupons", cp, true); setCp(null); flash(`کوپن ${cp.code} ذخیره شد`); }} icon={<TicketIcon size={14} />}>ذخیره کوپن</Btn><Btn variant="ghost" onClick={() => { ops.remove("coupons", cp.id); setCp(null); }}>حذف</Btn></div>
        </div>}
      </Drawer>
      <Drawer open={!!fs} onClose={() => setFs(null)} title={fs?.name || "جشنواره جدید"}>
        {fs && <div className="space-y-4">
          <Field label="نام جشنواره"><Input value={fs.name} onChange={(v) => setFs({ ...fs, name: v })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="شروع"><input type="date" value={fs.starts} onChange={(e) => setFs({ ...fs, starts: e.target.value })} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none" /></Field><Field label="پایان"><input type="date" value={fs.ends} onChange={(e) => setFs({ ...fs, ends: e.target.value })} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none" /></Field></div>
          <Field label="درصد تخفیف"><Input value={String(fs.discountPercent)} onChange={(v) => setFs({ ...fs, discountPercent: Math.min(70, Number(faDigits(v).replace(/\D/g, "")) || 0) })} /></Field>
          <div><p className="mb-2 text-[13px] font-semibold">دسته‌های مشمول</p><div className="flex flex-wrap gap-2">{cats.map((c) => <button key={c} aria-pressed={fs.categories.includes(c)} onClick={() => setFs({ ...fs, categories: fs.categories.includes(c) ? fs.categories.filter((x) => x !== c) : [...fs.categories, c] })} className={cn("min-h-10 rounded-full border px-3 text-[12px] font-semibold", fs.categories.includes(c) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.07]" : "border-[var(--kv-line)]")}>{c}</button>)}</div></div>
          <Field label="متن کوتاه بنر"><Input value={fs.bannerText} onChange={(v) => setFs({ ...fs, bannerText: v })} /></Field>
          <Btn variant="accent" disabled={!fs.name.trim() || !fs.categories.length || fs.ends < fs.starts || fs.discountPercent < 1} onClick={() => { ops.upsert("festivals", fs, true); setFs(null); flash("جشنواره ذخیره شد"); }}>ذخیره جشنواره</Btn>
        </div>}
      </Drawer>
    </div>
  );
}
