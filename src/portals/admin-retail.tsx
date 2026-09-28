import { useState } from "react";
import {
  Plus, Pencil, Trash2, RefreshCw, Key, Send, Download, Percent, MessageSquare, Megaphone,
  Mail, Smartphone, BellRing, Search, Truck, Eye, Image as ImageIcon, Globe,
} from "lucide-react";
import { IMG, fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE, type ShippingMethod, type CmsItem, type Customer } from "../data/platform";
import { ProductStudio } from "./admin-product";
import { useEffect } from "react";
import { crmApi, shippingApi } from "../data/api";
import { Btn, Card, Status, SearchBox, Empty, Timeline, Field, Input, Select, Switch, Drawer, Segmented, Textarea, Checkbox } from "../components/primitives";
import { cn } from "../utils/cn";

type F = (m: string) => void;

/* ================= Retail orders ================= */
export function RetailOrders({ flash }: { flash: F }) {
  const { retailOrders, accounts, setRetailOrderStatus, setReturnStatus } = useStore();
  const rows = retailOrders.map((order) => ({ ...order,
    customer: accounts.find((account) => account.id === order.accountId)?.name ?? "مشتری کلبه",
    items: order.lines.reduce((sum, line) => sum + line.qty, 0),
  }));
  const [sel, setSel] = useState<string | null>(rows[0]?.id ?? null);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const statuses: typeof rows[number]["status"][] = ["در انتظار پرداخت", "پرداخت شد", "در حال پردازش", "در حال آماده‌سازی", "آماده ارسال", "در حال ارسال", "ارسال شد", "تحویل شد", "لغو شد", "مرجوعی"];
  const cur = rows.find((r) => r.id === sel);
  const list = rows.filter((r) => (!query.trim() || `${r.id} ${r.customer}`.includes(query.trim())) && (filter === "all" || (filter === "open" ? !["تحویل شد", "مرجوعی", "لغو شد"].includes(r.status) : ["تحویل شد", "مرجوعی", "لغو شد"].includes(r.status))));
  const setSt = (id: string, status: typeof rows[number]["status"]) => { setRetailOrderStatus(id, status, note); setNote(""); flash(`وضعیت ${id} به «${status}» تغییر کرد`); };
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_360px]">
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <div className="min-w-[200px] flex-1"><SearchBox value={query} onChange={setQuery} placeholder="جست‌وجوی شماره سفارش، مشتری…" /></div>
          <Segmented<"all" | "open" | "done"> options={[{ v: "all", label: "همه" }, { v: "open", label: "باز" }, { v: "done", label: "بسته" }]} value={filter} onChange={setFilter} />
        </div>
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>سفارش</th><th>مشتری</th><th>اقلام</th><th>مبلغ</th><th>وضعیت</th><th>تاریخ</th><th></th></tr></thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id} className={cn(sel === o.id && "bg-[var(--kv-accent)]/[0.05]")}>
                    <td className="font-bold tabular-nums">{o.id}</td><td>{o.customer}</td><td className="tabular-nums">{fmtNum(o.items)}</td>
                    <td className="font-bold tabular-nums">{fmtMoney(o.total)}</td><td><Status value={o.status} /></td><td className="text-[var(--kv-muted)]">{o.createdAt}</td>
                    <td><button onClick={() => setSel(o.id)} className="inline-flex items-center gap-1 text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline"><Eye size={13} />جزئیات</button></td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">سفارشی با این فیلتر پیدا نشد.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Card className="h-fit p-5">
        {!cur ? <Empty title="سفارشی انتخاب نشده" desc="یک سفارش را انتخاب کنید." /> : (
          <div>
            <p className="text-xs text-[var(--kv-muted)] tabular-nums">{cur.id}</p>
            <h3 className="mt-1 text-[16px] font-extrabold">{cur.customer}</h3>
            <p className="text-[12.5px] text-[var(--kv-muted)]">{fmtNum(cur.items)} قلم · {fmtMoney(cur.total)} · {cur.createdAt}</p>
            <div className="mt-3"><Status value={cur.status} /></div>
            <div className="mt-3 space-y-2 border-y border-[var(--kv-line)] py-3">{cur.lines.map((line, i) => <div key={`${line.productId}-${i}`} className="flex items-center gap-2"><img src={line.image} alt="" className="h-10 w-9 rounded-[7px] object-cover" /><span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{line.name} · {line.color} / {line.size} ×{fmtNum(line.qty)}</span><b className="text-[11px] tabular-nums">{fmtMoney(line.qty * line.unitPrice)}</b></div>)}</div>
            <p className="mt-3 text-[12px] text-[var(--kv-muted)]">ارسال با {cur.shippingMethod} به {cur.address.city} · {cur.address.line}</p>
            <div className="mt-4"><Timeline items={cur.events.map((event) => ({ t: event.title, d: [event.by, event.note].filter(Boolean).join(" · "), time: event.time, done: true }))} /></div>
            {cur.returnRequest && <div className="mt-4 rounded-[11px] bg-[var(--kv-surface-2)]/60 p-3 text-[12px]"><p className="font-bold">درخواست بازگشت: {cur.returnRequest.status}</p><p className="mt-1 text-[var(--kv-muted)]">{cur.returnRequest.reason}</p>{cur.returnRequest.status === "در انتظار بررسی" && <div className="mt-3 flex gap-2"><Btn variant="accent" size="sm" onClick={() => { setReturnStatus(cur.id, "تأیید شد"); flash("بازگشت تأیید شد"); }}>تأیید بازگشت</Btn><Btn variant="soft" size="sm" onClick={() => { setReturnStatus(cur.id, "رد شد"); flash("بازگشت رد شد"); }}>رد درخواست</Btn></div>}</div>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="col-span-2"><Field label="یادداشت تغییر وضعیت (اختیاری)"><Input value={note} onChange={setNote} placeholder="مثلاً زمان تحویل به پست" /></Field></div>
              <label className="col-span-2 text-[12px] font-semibold">تغییر وضعیت سفارش<select aria-label="تغییر وضعیت سفارش" value={cur.status} onChange={(e) => setSt(cur.id, e.target.value as typeof cur.status)} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">{statuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
              {cur.status === "پرداخت شد" && <Btn variant="accent" size="sm" className="col-span-2" onClick={() => setSt(cur.id, "در حال آماده‌سازی")}>شروع آماده‌سازی</Btn>}
              {cur.status === "در حال آماده‌سازی" && <Btn variant="accent" size="sm" className="col-span-2" icon={<Truck size={14} />} onClick={() => setSt(cur.id, "ارسال شد")}>ثبت ارسال با پست</Btn>}
              {cur.status === "ارسال شد" && <Btn variant="soft" size="sm" className="col-span-2" onClick={() => setSt(cur.id, "تحویل شد")}>ثبت تحویل</Btn>}
              {cur.status === "تحویل شد" && !cur.returnRequest && <p className="col-span-2 text-[11.5px] text-[var(--kv-muted)]">درخواست بازگشت از حساب مشتری ثبت می‌شود.</p>}
              <Btn variant="ghost" size="sm" className="col-span-2" onClick={() => flash("فاکتور PDF صادر شد")} icon={<Download size={14} />}>صدور فاکتور</Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ================= Full product definition (canonical: ProductStudio) ================= */
export function ProductDefinition({ flash }: { flash: F }) {
  // Canonical editor is ProductStudio (full page) — this wrapper prevents duplicate ProductDefinition drawer
  return <ProductStudio flash={flash} />;
}

/* ================= Shipping ================= */
export function ShippingAdmin({ flash }: { flash: F }) {
  const storeShip = useStore() as any;
  const [serverShipping, setServerShipping] = useState<any[] | null>(null);
  const isDemoShip = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  useEffect(()=>{ if(isDemoShip) return; shippingApi.adminList().then(r=> setServerShipping(r.items??[])).catch(()=> setServerShipping([])); },[isDemoShip]);
  const shipping = serverShipping ?? storeShip.shipping;
  const upsertShipping = async (m: any)=> { if(isDemoShip) return storeShip.upsertShipping(m); const exists = Boolean(m.id && serverShipping?.some((x:any)=>x.id===m.id)); if (exists) await shippingApi.update(m.id, m); else await shippingApi.create(m); const r = await shippingApi.adminList(); setServerShipping(r.items??[]); };
  const removeShipping = async (id:string)=> { if(isDemoShip) return storeShip.removeShipping(id); await shippingApi.remove(id); const r = await shippingApi.adminList(); setServerShipping(r.items??[]); };
  const [edit, setEdit] = useState<ShippingMethod | null>(null);
  const blank: ShippingMethod = { id: "", name: "", carrier: "", scope: "خرده", price: 0, freeAbove: null, eta: "", zones: "سراسر کشور", active: true };
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_320px]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[13px] text-[var(--kv-muted)]">روش‌های فعال در تسویه‌حساب خرده و ثبت سفارش عمده نمایش داده می‌شوند.</p>
          <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => setEdit({ ...blank, id: `ship-${Date.now()}` })}>روش ارسال جدید</Btn>
        </div>
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[760px]">
              <thead><tr><th>روش</th><th>حامل</th><th>کانال</th><th>هزینه</th><th>رایگان از</th><th>زمان</th><th>پوشش</th><th>فعال</th><th></th></tr></thead>
              <tbody>
                {shipping.map((m: any) => (
                  <tr key={m.id}>
                    <td><b>{m.name}</b></td><td>{m.carrier}</td><td><span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">{m.scope}</span></td>
                    <td className="tabular-nums">{m.price === 0 ? "پس‌کرایه" : fmtMoney(m.price)}</td><td className="tabular-nums">{m.freeAbove ? fmtMoney(m.freeAbove) : "—"}</td>
                    <td>{m.eta}</td><td className="text-[var(--kv-muted)]">{m.zones}</td>
                    <td><Switch on={m.active} onToggle={() => { upsertShipping({ ...m, active: !m.active }); flash(`${m.name} ${m.active ? "غیرفعال" : "فعال"} شد`); }} /></td>
                    <td><span className="flex gap-2"><button onClick={() => setEdit(m)} className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label="ویرایش"><Pencil size={15} /></button><button onClick={() => { removeShipping(m.id); flash("روش ارسال حذف شد"); }} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف"><Trash2 size={15} /></button></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Card className="h-fit p-5">
        <p className="text-sm font-bold">قوانین سراسری</p>
        <div className="mt-3 space-y-3">
          <Field label="ارسال رایگان خرده از مبلغ"><Input placeholder="۵٬۰۰۰٬۰۰۰" /></Field>
          <Field label="انبار پیش‌فرض ارسال"><Select options={["انبار مرکزی — تهران", "انبار اصفهان"]} /></Field>
          <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">رهگیری خودکار از API حامل<Switch on onToggle={() => {}} /></label>
          <Btn variant="soft" size="sm" onClick={() => flash("قوانین ارسال ذخیره شد")}>ذخیره</Btn>
        </div>
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.name ? `ویرایش ${edit.name}` : "روش ارسال جدید"}>
        {edit && (
          <div className="space-y-4">
            <Field label="نام روش"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="مثلاً پست پیشتاز" /></Field>
            <Field label="حامل"><Input value={edit.carrier} onChange={(v) => setEdit({ ...edit, carrier: v })} /></Field>
            <Field label="کانال"><Select options={["خرده", "عمده", "هر دو"]} value={edit.scope} onChange={(v) => setEdit({ ...edit, scope: v as ShippingMethod["scope"] })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="هزینه (تومان)" hint="۰ = پس‌کرایه"><Input value={String(edit.price)} onChange={(v) => setEdit({ ...edit, price: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
              <Field label="رایگان از مبلغ"><Input value={edit.freeAbove ? String(edit.freeAbove) : ""} onChange={(v) => setEdit({ ...edit, freeAbove: Number(v.replace(/\D/g, "")) || null })} placeholder="—" /></Field>
            </div>
            <Field label="زمان تحویل"><Input value={edit.eta} onChange={(v) => setEdit({ ...edit, eta: v })} placeholder="۲ تا ۴ روز کاری" /></Field>
            <Field label="پوشش جغرافیایی"><Input value={edit.zones} onChange={(v) => setEdit({ ...edit, zones: v })} /></Field>
            <Btn variant="accent" className="w-full" disabled={!edit.name.trim()} onClick={() => { upsertShipping(edit); setEdit(null); flash(`${edit.name} ذخیره شد`); }}>ذخیره روش ارسال</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= CRM ================= */
export function CrmAdmin({ flash }: { flash: F }) {
  const { integrations } = useStore();
  const [q, setQ] = useState("");
  const [seg, setSeg] = useState("همه");
  const [sel, setSel] = useState<Customer | null>(null);
  const [note, setNote] = useState("");
  const segs = ["همه", "وفادار", "پرخرج", "جدید", "در خطر ریزش"];
  const [serverCustomers, setServerCustomers] = useState<any[] | null>(null);
  const isDemoRetail = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  useEffect(()=>{ if(isDemoRetail) return; crmApi.contacts().then(r=> setServerCustomers(r.items??[])).catch(()=> setServerCustomers([])); },[isDemoRetail]);
  const source: Customer[] = serverCustomers ? serverCustomers.map((c:any)=>({ id: String(c.id ?? c.phone ?? ""), name:c.name??c.display_name??"—", phone:c.phone??c.phone_number??"", segment:c.segment??"فعال", city:c.city??"—", orders:Number(c.orders_count??c.orders??0), spent:Number(c.ltv_rial??c.spent??0), last:c.last_order_at??c.last??"—" } as Customer)) : [];
  const list = (isDemoRetail ? [] : source).filter((c) => (seg === "همه" || c.segment === seg) && (!q.trim() || c.name.includes(q.trim()) || c.phone.includes(q.trim())));
  const crm = integrations.find((i) => i.kind === "CRM" && i.connected);
  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {segs.slice(1).map((s) => { const n = (serverCustomers ? serverCustomers.filter((c:any)=> (c.segment??"فعال")===s).length : 0); return (
          <button key={s} onClick={() => setSeg(seg === s ? "همه" : s)} className={cn("rounded-[14px] border p-4 text-right transition-all", seg === s ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] bg-[var(--kv-surface)]")}>
            <p className="text-xl font-extrabold tabular-nums">{fmtNum(n)}</p><div className="mt-1"><Status value={s} /></div>
          </button>
        ); })}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2.5">
            <div className="min-w-[200px] flex-1"><SearchBox value={q} onChange={setQ} placeholder="نام یا شماره مشتری…" /></div>
            <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => flash(crm ? `همگام‌سازی با ${crm.name} انجام شد` : "هیچ CRM متصلی وجود ندارد — از یکپارچه‌سازی‌ها متصل کنید")}>همگام‌سازی CRM</Btn>
            <Btn variant="accent" size="sm" icon={<Megaphone size={14} />} onClick={() => flash(`کمپین برای ${fmtNum(list.length)} مشتری زمان‌بندی شد`)}>کمپین برای این بخش</Btn>
          </div>
          <Card className="overflow-hidden">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[720px]">
                <thead><tr><th>مشتری</th><th>شهر</th><th>سفارش</th><th>ارزش خرید</th><th>بخش</th><th>آخرین خرید</th><th></th></tr></thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id} className={cn(sel?.id === c.id && "bg-[var(--kv-accent)]/[0.05]")}>
                      <td><b>{c.name}</b><span className="block text-[11px] text-[var(--kv-muted)] tabular-nums">{c.phone}</span></td><td>{c.city}</td>
                      <td className="tabular-nums">{fmtNum(c.orders)}</td><td className="font-bold tabular-nums">{fmtMoney(c.spent)}</td>
                      <td><Status value={c.segment} /></td><td className="text-[var(--kv-muted)]">{c.last}</td>
                      <td><button onClick={() => setSel(c)} className="text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline">پروفایل</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <Card className="h-fit p-5">
          {!sel ? <Empty title="مشتری انتخاب نشده" desc="روی «پروفایل» بزنید تا ۳۶۰ درجه مشتری را ببینید." /> : (
            <div>
              <div className="flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-[var(--kv-accent)]/12 text-lg font-bold text-[var(--kv-accent)]">{sel.name[0]}</span><div><p className="text-[15px] font-extrabold">{sel.name}</p><p className="text-xs text-[var(--kv-muted)] tabular-nums">{sel.phone} · {sel.city}</p></div></div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                {[["سفارش", fmtNum(sel.orders)], ["LTV", fmtMoney(sel.spent)], ["میانگین", fmtMoney(Math.round(sel.spent / Math.max(1, sel.orders)))]].map(([l, v]) => <div key={l} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2"><p className="text-[12px] font-extrabold tabular-nums">{v}</p><p className="text-[10.5px] text-[var(--kv-muted)]">{l}</p></div>)}
              </div>
              <div className="mt-4"><Timeline items={[{ t: "آخرین خرید", d: "پیراهن کلاسیک نیم‌آستین", time: sel.last, done: true }, { t: "عضویت در خبرنامه", d: "ایمیل و پیامک", time: "۱۴۰۳", done: true }, { t: "ثبت‌نام", d: "از طریق اینستاگرام", time: "۱۴۰۲", done: true }]} /></div>
              <Field label="یادداشت CRM"><Textarea rows={2} value={note} onChange={setNote} placeholder="مثلاً: علاقه‌مند به کالکشن زمستان" /></Field>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Btn variant="soft" size="sm" onClick={() => { setNote(""); flash("یادداشت ثبت شد"); }} icon={<MessageSquare size={14} />}>ثبت یادداشت</Btn>
                <Btn variant="accent" size="sm" onClick={() => flash(`پیامک برای ${sel.name} ارسال شد`)} icon={<Send size={14} />}>ارسال پیامک</Btn>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ================= CMS ================= */
export function CmsAdmin({ flash }: { flash: F }) {
  const { cms, upsertCms } = useStore();
  const [type, setType] = useState<"همه" | CmsItem["type"]>("همه");
  const [draft, setDraft] = useState<CmsItem | null>(null);
  const [heroTitle, setHeroTitle] = useState("سبک‌های ماندگار برای امروز و فردا");
  const list = cms.filter((c) => type === "همه" || c.type === type);
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <Segmented<"همه" | CmsItem["type"]> options={[{ v: "همه", label: "همه" }, { v: "صفحه", label: "صفحات" }, { v: "بنر", label: "بنرها" }, { v: "مقاله", label: "مقالات مجله" }]} value={type} onChange={setType} />
          <Btn variant="accent" size="sm" className="mr-auto" icon={<Plus size={15} />} onClick={() => setDraft({ id: `m${Date.now()}`, title: "", type: "مقاله", slug: "", status: "پیش‌نویس", updated: "اکنون" })}>محتوای جدید</Btn>
        </div>
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[640px]">
              <thead><tr><th>عنوان</th><th>نوع</th><th>نامک</th><th>به‌روزرسانی</th><th>وضعیت</th><th>انتشار</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.title}</b></td><td><span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-[11px] font-bold">{c.type}</span></td>
                    <td className="tabular-nums text-[var(--kv-muted)]" dir="ltr">{c.slug}</td><td className="text-[var(--kv-muted)]">{c.updated}</td>
                    <td><Status value={c.status} /></td>
                    <td><Switch on={c.status === "منتشر"} onToggle={() => { upsertCms({ ...c, status: c.status === "منتشر" ? "پیش‌نویس" : "منتشر", updated: "اکنون" }); flash(`«${c.title}» ${c.status === "منتشر" ? "به پیش‌نویس برگشت" : "منتشر شد"}`); }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <Card className="h-fit overflow-hidden">
        <div className="relative h-40"><img src={IMG.trenchHero} alt="" className="h-full w-full object-cover" /><div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" /><p className="absolute bottom-3 right-4 left-4 text-[15px] font-extrabold leading-6 text-white">{heroTitle}</p></div>
        <div className="space-y-3 p-5">
          <p className="text-sm font-bold">بنر هیرو صفحه اصلی</p>
          <Field label="تیتر"><Input value={heroTitle} onChange={setHeroTitle} /></Field>
          <Field label="تصویر"><button onClick={() => flash("کتابخانه رسانه باز شد")} className="flex w-full items-center justify-center gap-2 rounded-[11px] border border-dashed border-[var(--kv-line-strong)] py-3 text-[12.5px] font-semibold text-[var(--kv-muted)]"><ImageIcon size={15} />تغییر تصویر</button></Field>
          <Btn variant="accent" size="sm" className="w-full" onClick={() => flash("بنر هیرو منتشر شد")}>انتشار تغییرات</Btn>
        </div>
      </Card>
      <Drawer open={!!draft} onClose={() => setDraft(null)} title="محتوای جدید">
        {draft && (
          <div className="space-y-4">
            <Field label="عنوان"><Input value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} /></Field>
            <Field label="نوع"><Select options={["صفحه", "بنر", "مقاله"]} value={draft.type} onChange={(v) => setDraft({ ...draft, type: v as CmsItem["type"] })} /></Field>
            <Field label="نامک"><Input value={draft.slug} onChange={(v) => setDraft({ ...draft, slug: v })} placeholder="/journal/…" /></Field>
            <Field label="متن"><Textarea rows={6} placeholder="محتوای صفحه یا مقاله…" /></Field>
            <div className="flex gap-2">
              <Btn variant="accent" size="sm" disabled={!draft.title.trim()} onClick={() => { upsertCms({ ...draft, status: "منتشر" }); setDraft(null); flash("منتشر شد"); }}>انتشار</Btn>
              <Btn variant="soft" size="sm" disabled={!draft.title.trim()} onClick={() => { upsertCms(draft); setDraft(null); flash("پیش‌نویس ذخیره شد"); }}>ذخیره پیش‌نویس</Btn>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Notifications ================= */
export function NotifAdmin({ flash }: { flash: F }) {
  const { notifs, setNotif } = useStore();
  const [aud, setAud] = useState("همه مشتریان خرده");
  const [msg, setMsg] = useState("");
  const [ch, setCh] = useState({ sms: true, email: false, push: true });
  const audiences = ["همه مشتریان خرده", "مشتریان وفادار", "در خطر ریزش", "خریداران عمده", "تأمین‌کنندگان"];
  const counts: Record<string, number> = { "همه مشتریان خرده": 12480, "مشتریان وفادار": 2140, "در خطر ریزش": 860, "خریداران عمده": 214, "تأمین‌کنندگان": 48 };
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_360px]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-5 pb-3"><div><p className="text-[15px] font-extrabold">قالب‌های رویدادی</p><p className="text-xs text-[var(--kv-muted)]">کانال هر رویداد را جداگانه روشن یا خاموش کنید</p></div></div>
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[680px]">
            <thead><tr><th>رویداد</th><th>مخاطب</th><th><span className="inline-flex items-center gap-1"><Smartphone size={12} />پیامک</span></th><th><span className="inline-flex items-center gap-1"><Mail size={12} />ایمیل</span></th><th><span className="inline-flex items-center gap-1"><BellRing size={12} />پوش</span></th><th>فعال</th></tr></thead>
            <tbody>
              {notifs.map((n) => (
                <tr key={n.id} className={cn(!n.active && "opacity-50")}>
                  <td><b>{n.event}</b></td><td className="text-[var(--kv-muted)]">{n.audience}</td>
                  <td><Switch on={n.sms} onToggle={() => setNotif(n.id, { sms: !n.sms })} /></td>
                  <td><Switch on={n.email} onToggle={() => setNotif(n.id, { email: !n.email })} /></td>
                  <td><Switch on={n.push} onToggle={() => setNotif(n.id, { push: !n.push })} /></td>
                  <td><Switch on={n.active} onToggle={() => { setNotif(n.id, { active: !n.active }); flash(`«${n.event}» ${n.active ? "غیرفعال" : "فعال"} شد`); }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="space-y-4">
        <Card className="p-5">
          <p className="flex items-center gap-2 text-sm font-bold"><Megaphone size={16} className="text-[var(--kv-accent)]" />ارسال اطلاع‌رسانی دستی</p>
          <div className="mt-3 space-y-3">
            <Field label="مخاطبان" hint={`${fmtNum(counts[aud])} نفر`}><Select options={audiences} value={aud} onChange={setAud} /></Field>
            <div className="flex flex-wrap gap-3">
              <Checkbox checked={ch.sms} onChange={(v) => setCh({ ...ch, sms: v })} label="پیامک" />
              <Checkbox checked={ch.email} onChange={(v) => setCh({ ...ch, email: v })} label="ایمیل" />
              <Checkbox checked={ch.push} onChange={(v) => setCh({ ...ch, push: v })} label="پوش" />
            </div>
            <Field label="متن پیام"><Textarea rows={4} value={msg} onChange={setMsg} placeholder="کالکشن زمستان کلبه رسید…" /></Field>
            <Btn variant="accent" size="sm" className="w-full" disabled={!msg.trim() || (!ch.sms && !ch.email && !ch.push)} icon={<Send size={14} />} onClick={() => { flash(`ارسال برای ${fmtNum(counts[aud])} نفر زمان‌بندی شد`); setMsg(""); }}>ارسال</Btn>
          </div>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-bold">ارسال‌های اخیر</p>
          <div className="mt-3 space-y-2 text-[12.5px]">
            {[["تأیید زیرسفارش WO-1002-1", "پیامک · بوتیک آوا", "۲ روز پیش"], ["کد رهگیری KV-88197", "پیامک + پوش · نگار کریمی", "دیروز"], ["کمپین پاییز ۱۴۰۴", "ایمیل · ۲٬۱۴۰ مشتری وفادار", "هفته پیش"]].map(([t, d, tm]) => (
              <div key={t} className="rounded-[10px] border border-[var(--kv-line)] px-3 py-2"><b>{t}</b><p className="text-[11.5px] text-[var(--kv-muted)]">{d} · {tm}</p></div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ================= Finance ================= */
export function FinanceAdmin({ flash }: { flash: F }) {
  const { orders, retailOrders, accounts } = useStore();
  const [tab, setTab] = useState<"tx" | "settle" | "inv">("tx");
  const paidSubs = orders.flatMap((o) => o.subOrders.filter((s) => ["paid", "preparing", "shipped", "delivered"].includes(s.status)).map((s) => ({ o, s })));
  const wholesaleGmv = paidSubs.reduce((a, x) => a + x.s.total, 0);
  const retailGmv = retailOrders.filter((o) => o.status !== "در انتظار پرداخت").reduce((a, o) => a + o.total, 0);
  const thirdParty = paidSubs.filter((x) => x.s.supplierId !== KOLBE.id);
  const commission = Math.round(thirdParty.reduce((a, x) => a + x.s.total, 0) * 0.08);
  const payable = thirdParty.filter((x) => x.s.status === "delivered" || x.s.status === "shipped").reduce((a, x) => a + Math.round(x.s.total * 0.92), 0);
  const bySupplier = Array.from(thirdParty.reduce((m, x) => { const c = m.get(x.s.supplierName) ?? { n: 0, gross: 0 }; m.set(x.s.supplierName, { n: c.n + 1, gross: c.gross + x.s.total }); return m; }, new Map<string, { n: number; gross: number }>()).entries());
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[["گردش عمده (پرداخت‌شده)", fmtMoney(wholesaleGmv)], ["گردش خرده", fmtMoney(retailGmv)], ["کارمزد کلبه از تأمین‌کنندگان (۸٪)", fmtMoney(commission)], ["قابل تسویه به تأمین‌کنندگان", fmtMoney(payable)]].map(([l, v]) => (
          <Card key={l} className="p-4"><p className="text-[15px] font-extrabold tabular-nums">{v}</p><p className="mt-1 text-xs text-[var(--kv-muted)]">{l}</p></Card>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented<"tx" | "settle" | "inv"> options={[{ v: "tx", label: "تراکنش‌ها" }, { v: "settle", label: "تسویه تأمین‌کنندگان" }, { v: "inv", label: "فاکتورها" }]} value={tab} onChange={setTab} />
        <Btn variant="soft" size="sm" className="mr-auto" icon={<Download size={14} />} onClick={() => flash("خروجی اکسل آماده شد")}>خروجی</Btn>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => flash("اسناد به سپیدار ارسال شد")}>ارسال به حسابداری</Btn>
      </div>
      <Card className="overflow-hidden">
        <div className="kv-scroll overflow-x-auto">
          {tab === "tx" && (
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>شناسه</th><th>نوع</th><th>طرف</th><th>فروشنده</th><th>مبلغ</th><th>وضعیت</th></tr></thead>
              <tbody>
                {paidSubs.map(({ o, s }) => <tr key={s.id}><td className="font-bold tabular-nums">TX-{s.id}</td><td>پرداخت عمده</td><td>{o.buyer}</td><td>{s.supplierName}</td><td className="font-bold tabular-nums">{fmtMoney(s.total)}</td><td><Status value="پرداخت شد" /></td></tr>)}
                {retailOrders.filter((o) => o.status !== "در انتظار پرداخت").map((o) => <tr key={o.id}><td className="font-bold tabular-nums">TX-{o.id}</td><td>پرداخت خرده</td><td>{accounts.find((a) => a.id === o.accountId)?.name ?? "مشتری کلبه"}</td><td>کلبه وینتیج</td><td className="font-bold tabular-nums">{fmtMoney(o.total)}</td><td><Status value="پرداخت شد" /></td></tr>)}
              </tbody>
            </table>
          )}
          {tab === "settle" && (
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>تأمین‌کننده</th><th>زیرسفارش پرداخت‌شده</th><th>ناخالص</th><th><span className="inline-flex items-center gap-1"><Percent size={12} />کارمزد</span></th><th>قابل پرداخت</th><th></th></tr></thead>
              <tbody>
                {bySupplier.map(([name, v]) => <tr key={name}><td><b>{name}</b></td><td className="tabular-nums">{fmtNum(v.n)}</td><td className="tabular-nums">{fmtMoney(v.gross)}</td><td className="tabular-nums">۸٪ · {fmtMoney(Math.round(v.gross * 0.08))}</td><td className="font-bold tabular-nums">{fmtMoney(Math.round(v.gross * 0.92))}</td><td><Btn variant="accent" size="sm" onClick={() => flash(`تسویه ${name} ثبت و به بانک ارسال شد`)}>تسویه</Btn></td></tr>)}
                {bySupplier.length === 0 && <tr><td colSpan={6} className="text-center text-[var(--kv-muted)]">تسویه معوقی وجود ندارد</td></tr>}
              </tbody>
            </table>
          )}
          {tab === "inv" && (
            <table className="kv-table min-w-[680px]">
              <thead><tr><th>فاکتور</th><th>خریدار</th><th>بابت</th><th>مبلغ</th><th>وضعیت</th><th></th></tr></thead>
              <tbody>
                {orders.flatMap((o) => o.subOrders.filter((s) => !["pending_supplier", "rejected", "cancelled"].includes(s.status)).map((s) => (
                  <tr key={s.id}><td className="font-bold tabular-nums">INV-{s.id}</td><td>{o.buyer}</td><td>{s.supplierName} · {s.lines.length} قلم</td><td className="font-bold tabular-nums">{fmtMoney(s.total)}</td><td><Status value={s.status === "approved" ? "در انتظار پرداخت" : "پرداخت شد"} /></td><td><button onClick={() => flash(`فاکتور INV-${s.id} دانلود شد`)} className="text-[12.5px] font-bold text-[var(--kv-accent)]">PDF</button></td></tr>
                )))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ================= Integrations ================= */
export function IntegrationsAdmin({ flash }: { flash: F }) {
  const { integrations, toggleIntegration } = useStore();
  const kinds = ["CRM", "حسابداری", "پیامک", "پرداخت", "لجستیک"] as const;
  const [hooks, setHooks] = useState<Record<string, boolean>>({ "order.created": true, "order.paid": true, "suborder.approved": true, "suborder.shipped": true, "product.approved": false, "buyer.approved": true });
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        {kinds.map((k) => (
          <section key={k}>
            <p className="mb-2.5 text-[13.5px] font-extrabold">{k}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {integrations.filter((i) => i.kind === k).map((i) => (
                <Card key={i.id} className="flex items-start gap-3 p-4">
                  <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] text-[13px] font-extrabold", i.connected ? "bg-[#E7F0E6] text-[#3E6B4A]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{i.name.replace(/\s*(CRM|API)\s*/g, "")[0]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2"><p className="text-[13.5px] font-bold">{i.name}</p><Switch on={i.connected} onToggle={() => { toggleIntegration(i.id); flash(i.connected ? `${i.name} قطع شد` : `${i.name} متصل شد`); }} /></div>
                    <p className="mt-0.5 text-[12px] leading-5 text-[var(--kv-muted)]">{i.desc}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <Status value={i.connected ? "متصل" : "قطع"} />
                      {i.connected && <button onClick={() => flash(`همگام‌سازی ${i.name} انجام شد`)} className="inline-flex items-center gap-1 text-[11.5px] font-bold text-[var(--kv-accent)]"><RefreshCw size={12} />همگام‌سازی · {i.lastSync}</button>}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="space-y-4">
        <Card className="p-5">
          <p className="flex items-center gap-2 text-sm font-bold"><Key size={15} className="text-[var(--kv-accent)]" />کلیدهای API</p>
          <div className="mt-3 rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2.5 text-[12px] tabular-nums" dir="ltr">kv_live_••••••••••••7f3a</div>
          <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">آخرین استفاده: امروز ۰۹:۱۲ · دسترسی: سفارش‌ها، محصولات (خواندن/نوشتن)</p>
          <Btn variant="soft" size="sm" className="mt-3 w-full" onClick={() => flash("کلید جدید ساخته شد؛ کلید قبلی تا ۲۴ ساعت معتبر است")}>ساخت کلید جدید</Btn>
        </Card>
        <Card className="p-5">
          <p className="flex items-center gap-2 text-sm font-bold"><Globe size={15} className="text-[var(--kv-accent)]" />وب‌هوک‌ها</p>
          <div className="mt-3 space-y-2">
            {Object.entries(hooks).map(([h, on]) => <div key={h} className="flex items-center justify-between rounded-[10px] border border-[var(--kv-line)] px-3 py-2"><span className="text-[12px] tabular-nums" dir="ltr">{h}</span><Switch on={on} onToggle={() => setHooks({ ...hooks, [h]: !on })} /></div>)}
          </div>
          <Field label="آدرس دریافت‌کننده"><Input placeholder="https://erp.example.ir/hooks/kolbe" /></Field>
          <Btn variant="soft" size="sm" className="mt-3 w-full" onClick={() => flash("رویداد آزمایشی ارسال شد")}>ارسال رویداد آزمایشی</Btn>
        </Card>
      </div>
      <span className="hidden"><Search size={8} /></span>
    </div>
  );
}
