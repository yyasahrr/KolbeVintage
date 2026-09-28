import { useState } from "react";
import { MessageCircle, Send, X, Phone, Mail, Headset, Clock, Check, RotateCcw, Truck, Ban } from "lucide-react";
import { fmtMoney } from "../data/catalog";
import { useOps, opsNow, channelHref, TICKET_STATUS, RETURN_STATUS, type Ticket, type ReturnReq, type QuickChannelId } from "../data/ops";
import { Btn, Empty, Field, Input, Select, Status, Textarea, Timeline, Segmented } from "./primitives";
import { cn } from "../utils/cn";

const CATEGORIES = ["پیگیری سفارش", "مرجوعی و بازگشت", "پرداخت و مالی", "عضویت عمده", "محصول و موجودی", "مالی و تسویه", "سایر موارد"];
const PRIORITY: Record<Ticket["priority"], string> = { low: "کم", normal: "عادی", high: "فوری" };
const DEPARTMENTS = ["پشتیبانی عمومی", "سفارش و ارسال", "مالی و تسویه", "محصول و انبار", "همکاری تأمین‌کنندگان"];
const STATUS_OPTIONS: Ticket["status"][] = ["open", "reviewing", "waiting", "answered", "escalated", "resolved", "closed"];

/* ================= Ticket center (customer / supplier / admin) ================= */
export function TicketCenter({ perspective, ownerId, ownerName, ownerType }: {
  perspective: "owner" | "admin"; ownerId?: string; ownerName?: string; ownerType?: Ticket["ownerType"];
}) {
  const ops = useOps();
  const list = ops.tickets.filter((t) => perspective === "admin" || (t.ownerId === ownerId && t.ownerType === ownerType));
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  const visible = list.filter((t) => filter === "all" || (filter === "open" ? t.status !== "closed" : t.status === "closed"));
  const [sel, setSel] = useState<string | null>(visible[0]?.id ?? null);
  const [composing, setComposing] = useState(perspective === "owner" && list.length === 0);
  const [draft, setDraft] = useState({ subject: "", category: CATEGORIES[0], priority: "normal" as Ticket["priority"], orderRef: "", text: "", attachment: null as File | null });
  const [reply, setReply] = useState("");
  const cur = list.find((t) => t.id === sel);

  const create = async () => {
    if (!ownerId || !ownerName || !ownerType || draft.subject.trim().length < 3 || draft.text.trim().length < 8) return;
    if (draft.attachment && draft.attachment.size > 700_000) return;
    const attachment = draft.attachment ? await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود"));
      reader.readAsDataURL(draft.attachment!);
    }) : null;
    const createdAt = opsNow();
    const due = new Date(Date.now() + (draft.priority === "high" ? 4 : draft.priority === "normal" ? 24 : 48) * 3600000).toISOString();
    const t: Ticket = {
      id: `TK-${Date.now().toString().slice(-5)}`, ownerType, ownerId, ownerName, subject: draft.subject.trim(), category: draft.category,
      priority: draft.priority, status: "open", orderRef: draft.orderRef.trim() || undefined, createdAt,
      department: "پشتیبانی عمومی", slaDueAt: due, events: [{ at: createdAt, by: ownerName, action: "تیکت ثبت شد" }],
      attachments: draft.attachment && attachment ? [{ name: draft.attachment.name, dataUrl: attachment, size: draft.attachment.size }] : [],
      messages: [{ from: "user", name: ownerName, text: draft.text.trim(), at: createdAt }],
    };
    ops.upsert("tickets", t, true);
    setSel(t.id); setComposing(false); setDraft({ subject: "", category: CATEGORIES[0], priority: "normal", orderRef: "", text: "", attachment: null });
  };
  const change = (ticket: Ticket, patch: Partial<Ticket>, action: string) => ops.upsert("tickets", {
    ...ticket, ...patch, events: [...(ticket.events ?? []), { at: opsNow(), by: perspective === "admin" ? "پشتیبانی کلبه" : ticket.ownerName, action }],
  });
  const send = () => {
    if (!cur || !reply.trim()) return;
    const fromAgent = perspective === "admin";
    change(cur, { status: fromAgent ? "answered" : "open", messages: [...cur.messages, { from: fromAgent ? "agent" : "user", name: fromAgent ? "پشتیبانی کلبه" : cur.ownerName, text: reply.trim(), at: opsNow() }] }, fromAgent ? "پاسخ کارشناس ثبت شد" : "پاسخ درخواست‌کننده ثبت شد");
    setReply("");
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <Segmented<"all" | "open" | "closed"> options={[{ v: "all", label: "همه" }, { v: "open", label: "باز" }, { v: "closed", label: "بسته" }]} value={filter} onChange={setFilter} />
          {perspective === "owner" && <Btn variant="accent" size="sm" onClick={() => { setComposing(true); setSel(null); }}>تیکت جدید</Btn>}
        </div>
        <div className="space-y-2">
          {visible.length === 0 && <p className="rounded-[12px] border border-dashed border-[var(--kv-line-strong)] p-4 text-center text-[12.5px] text-[var(--kv-muted)]">تیکتی در این دسته نیست.</p>}
          {visible.map((t) => (
            <button key={t.id} onClick={() => { setSel(t.id); setComposing(false); }} className={cn("w-full rounded-[12px] border p-3 text-right transition-colors", sel === t.id && !composing ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:border-[var(--kv-line-strong)]")}>
              <div className="flex items-center justify-between gap-2"><b className="truncate text-[13px]">{t.subject}</b><Status value={TICKET_STATUS[t.status]} dot={false} /></div>
              <p className="mt-1 truncate text-[11.5px] text-[var(--kv-muted)]">{perspective === "admin" ? `${t.ownerName} · ${t.ownerType === "supplier" ? "تأمین‌کننده" : "مشتری"} · ` : ""}{t.category} · {t.id}</p>
              <p className="mt-0.5 text-[11px] text-[var(--kv-faint)]">{t.messages[t.messages.length - 1]?.at}{t.priority === "high" && <span className="mr-2 font-bold text-[var(--kv-danger)]">فوری</span>}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-[360px] rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
        {composing ? (
          <div className="max-w-[560px] space-y-4">
            <h3 className="text-[15px] font-extrabold">ثبت تیکت جدید</h3>
            <Field label="موضوع"><Input value={draft.subject} onChange={(v) => setDraft({ ...draft, subject: v })} placeholder="خلاصه مسئله در یک جمله" /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="دسته"><Select options={CATEGORIES} value={draft.category} onChange={(v) => setDraft({ ...draft, category: v })} /></Field>
              <Field label="اولویت"><Select options={["کم", "عادی", "فوری"]} value={PRIORITY[draft.priority]} onChange={(v) => setDraft({ ...draft, priority: v === "کم" ? "low" : v === "فوری" ? "high" : "normal" })} /></Field>
              <Field label="شماره سفارش (اختیاری)"><Input value={draft.orderRef} onChange={(v) => setDraft({ ...draft, orderRef: v })} placeholder="KV-…" /></Field>
            </div>
            <Field label="شرح"><Textarea rows={5} value={draft.text} onChange={(v) => setDraft({ ...draft, text: v })} placeholder="جزئیات را بنویسید تا سریع‌تر پاسخ بگیرید…" /></Field>
            <label className="block text-[12.5px] font-semibold">ضمیمه (اختیاری، حداکثر ۷۰۰ کیلوبایت)<input type="file" accept="image/*,.pdf,.txt" className="mt-2 block w-full text-[12px]" onChange={(e) => setDraft({ ...draft, attachment: e.target.files?.[0] ?? null })} /></label>
            {draft.attachment && draft.attachment.size > 700_000 && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">حجم فایل بیش از حد مجاز است.</p>}
            <Btn variant="accent" disabled={draft.subject.trim().length < 3 || draft.text.trim().length < 8 || !!draft.attachment && draft.attachment.size > 700_000} onClick={create} icon={<Send size={15} />}>ارسال تیکت</Btn>
          </div>
        ) : !cur ? <Empty title="تیکتی انتخاب نشده" desc="از فهرست یک گفت‌وگو را باز کنید." /> : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--kv-line)] pb-4">
              <div><p className="text-[16px] font-extrabold">{cur.subject}</p><p className="mt-1 text-[12px] text-[var(--kv-muted)]">{cur.id} · {cur.category} · اولویت {PRIORITY[cur.priority]}{cur.orderRef ? ` · سفارش ${cur.orderRef}` : ""}{perspective === "admin" ? ` · ${cur.ownerName}` : ""}</p></div>
              <div className="flex items-center gap-2">
                <Status value={TICKET_STATUS[cur.status]} />
                {cur.status !== "closed"
                  ? <Btn variant="ghost" size="sm" onClick={() => change(cur, { status: "closed" }, "تیکت بسته شد")}>بستن تیکت</Btn>
                  : <Btn variant="ghost" size="sm" onClick={() => change(cur, { status: "open" }, "تیکت بازگشایی شد")}>بازگشایی</Btn>}
              </div>
            </div>
            <div className="grid gap-2 border-b border-[var(--kv-line)] py-3 text-[12px] sm:grid-cols-2">
              <p>واحد مسئول: <b>{cur.department ?? "پشتیبانی عمومی"}</b></p>
              <p>مسئول رسیدگی: <b>{cur.assignee || "هنوز تعیین نشده"}</b></p>
              <p>آخرین پاسخ: <b>{cur.messages[cur.messages.length - 1]?.at ?? "—"}</b></p>
              <p>مهلت پاسخ: <b>{cur.slaDueAt ? new Date(cur.slaDueAt).toLocaleString("fa-IR") : "تعیین نشده"}</b></p>
            </div>
            {perspective === "admin" && <div className="grid gap-2 border-b border-[var(--kv-line)] py-3 sm:grid-cols-3">
              <label className="text-[12px]">وضعیت<select aria-label="وضعیت تیکت" value={cur.status} onChange={(e) => { const status = e.target.value as Ticket["status"]; change(cur, { status }, `وضعیت به ${TICKET_STATUS[status]} تغییر کرد`); }} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">{STATUS_OPTIONS.map((status) => <option key={status} value={status}>{TICKET_STATUS[status]}</option>)}</select></label>
              <label className="text-[12px]">واحد<select aria-label="واحد رسیدگی" value={cur.department ?? DEPARTMENTS[0]} onChange={(e) => change(cur, { department: e.target.value }, `ارجاع به ${e.target.value}`)} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">{DEPARTMENTS.map((department) => <option key={department}>{department}</option>)}</select></label>
              <Field label="مسئول رسیدگی"><Input value={cur.assignee ?? ""} onChange={(value) => change(cur, { assignee: value }, `مسئول: ${value || "تعیین نشده"}`)} placeholder="نام کارشناس" /></Field>
            </div>}
            {!!cur.attachments?.length && <div className="border-b border-[var(--kv-line)] py-3 text-[12px]"><b>ضمیمه‌ها</b><div className="mt-1 flex flex-wrap gap-2">{cur.attachments.map((attachment, i) => <a key={i} href={attachment.dataUrl} download={attachment.name} className="rounded-lg border border-[var(--kv-line)] px-2 py-1 hover:bg-[var(--kv-surface-2)]">{attachment.name}</a>)}</div></div>}
            <div className="flex-1 space-y-3 py-4" aria-live="polite">
              {cur.messages.map((m, i) => (
                <div key={i} className={cn("max-w-[85%] rounded-[14px] px-4 py-3 text-[13px] leading-7", m.from === "agent" ? "mr-auto bg-[var(--kv-surface-2)]" : "ml-auto bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]")}>
                  <p className="mb-0.5 text-[11px] font-bold opacity-75">{m.name} · {m.at}</p>{m.text}
                </div>
              ))}
            </div>
            {!!cur.events?.length && <details className="border-t border-[var(--kv-line)] py-3 text-[12px]"><summary className="cursor-pointer font-semibold">تاریخچه رسیدگی ({cur.events.length.toLocaleString("fa-IR")})</summary><ol className="mt-2 space-y-1 text-[var(--kv-muted)]">{cur.events.map((event, i) => <li key={i}>{event.at} · {event.by} · {event.action}</li>)}</ol></details>}
            {cur.status !== "closed" ? (
              <div className="flex gap-2 border-t border-[var(--kv-line)] pt-4">
                <Input className="flex-1" value={reply} onChange={setReply} placeholder={perspective === "admin" ? "پاسخ به کاربر…" : "پیام خود را بنویسید…"} />
                <Btn variant="accent" disabled={!reply.trim()} onClick={send} icon={<Send size={15} />}>ارسال</Btn>
              </div>
            ) : <p className="border-t border-[var(--kv-line)] pt-4 text-[12.5px] text-[var(--kv-muted)]">این تیکت بسته شده است. برای ادامه، آن را بازگشایی کنید.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Returns center (admin) ================= */
export function ReturnsCenter({ onSync }: { onSync?: (r: ReturnReq) => void }) {
  const ops = useOps();
  const [ch, setCh] = useState<"all" | "retail" | "wholesale">("all");
  const list = ops.returns.filter((r) => ch === "all" || r.channel === ch);
  const [sel, setSel] = useState<string | null>(list[0]?.id ?? null);
  const cur = ops.returns.find((r) => r.id === sel);
  const move = (r: ReturnReq, status: ReturnReq["status"], t: string) => {
    const next = { ...r, status, events: [...r.events, { t, at: opsNow() }] };
    ops.upsert("returns", next);
    onSync?.(next);
  };
  const RES: Record<ReturnReq["resolution"], string> = { refund: "بازپرداخت وجه", exchange: "تعویض کالا", credit: "اعتبار کیف پول" };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented<"all" | "retail" | "wholesale"> options={[{ v: "all", label: "همه" }, { v: "retail", label: "خرده" }, { v: "wholesale", label: "عمده" }]} value={ch} onChange={setCh} />
          <p className="text-[12px] text-[var(--kv-muted)]">{ops.returns.filter((r) => r.status === "requested").length.toLocaleString("fa-IR")} درخواست منتظر بررسی</p>
        </div>
        <div className="overflow-hidden rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>شناسه</th><th>سفارش</th><th>درخواست‌دهنده</th><th>کانال</th><th>راه‌حل</th><th>مبلغ</th><th>وضعیت</th></tr></thead>
              <tbody>
                {list.map((r) => <tr key={r.id} onClick={() => setSel(r.id)} className={cn("cursor-pointer", sel === r.id && "bg-[var(--kv-accent)]/[0.05]")}>
                  <td className="font-bold tabular-nums">{r.id}</td><td className="tabular-nums">{r.orderId}</td><td>{r.ownerName}</td>
                  <td>{r.channel === "retail" ? "خرده" : "عمده"}</td><td>{RES[r.resolution]}</td><td className="tabular-nums">{fmtMoney(r.amount)}</td><td><Status value={RETURN_STATUS[r.status]} /></td>
                </tr>)}
                {list.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">درخواست مرجوعی ثبت نشده است.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="h-fit rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
        {!cur ? <Empty title="درخواستی انتخاب نشده" desc="یک ردیف را انتخاب کنید." /> : (
          <div>
            <div className="flex items-center justify-between gap-2"><p className="text-[15px] font-extrabold">{cur.id}</p><Status value={RETURN_STATUS[cur.status]} /></div>
            <p className="mt-1 text-[12px] text-[var(--kv-muted)]">{cur.ownerName} · سفارش {cur.orderId}</p>
            <div className="mt-3 space-y-1.5 rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[12.5px]">
              <p><b>اقلام:</b> {cur.items}</p><p><b>دلیل:</b> {cur.reason}</p><p><b>درخواست:</b> {RES[cur.resolution]} · {fmtMoney(cur.amount)}</p>
            </div>
            <div className="mt-4"><Timeline items={cur.events.map((e) => ({ t: e.t, d: "", time: e.at, done: true }))} /></div>
            <div className="mt-4 flex flex-wrap gap-2">
              {cur.status === "requested" && <><Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => move(cur, "approved", "مرجوعی تأیید شد؛ جمع‌آوری کالا برنامه‌ریزی شد")}>تأیید</Btn><Btn variant="soft" size="sm" icon={<Ban size={14} />} onClick={() => move(cur, "rejected", "درخواست رد شد")}>رد</Btn></>}
              {cur.status === "approved" && <Btn variant="accent" size="sm" icon={<Truck size={14} />} onClick={() => move(cur, "received", "کالا در انبار دریافت و کنترل کیفیت شد")}>ثبت دریافت کالا</Btn>}
              {cur.status === "received" && <Btn variant="accent" size="sm" icon={<RotateCcw size={14} />} onClick={() => move(cur, "refunded", cur.resolution === "exchange" ? "کالای جایگزین ارسال شد" : cur.resolution === "credit" ? "مبلغ به کیف پول مشتری افزوده شد" : "مبلغ به حساب مشتری بازپرداخت شد")}>{cur.resolution === "exchange" ? "ارسال جایگزین" : "بازپرداخت"}</Btn>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Floating quick support ================= */
const ICON: Record<QuickChannelId, React.ReactNode> = {
  telegram: <Send size={17} />, instagram: <MessageCircle size={17} />, whatsapp: <MessageCircle size={17} />,
  bale: <MessageCircle size={17} />, eitaa: <MessageCircle size={17} />, phone: <Phone size={17} />, email: <Mail size={17} />,
};
const TINT: Record<QuickChannelId, string> = { telegram: "#2AABEE", instagram: "#C13584", whatsapp: "#25D366", bale: "#1FA89A", eitaa: "#E86E1C", phone: "#1B2A4A", email: "#6E7B8E" };

export function FloatingSupport({ onTicket }: { onTicket: () => void }) {
  const { quickSupport } = useOps();
  const [open, setOpen] = useState(false);
  if (!quickSupport.enabled) return null;
  const channels = quickSupport.channels.filter((c) => c.enabled && c.value.trim());
  return (
    <div className="fixed bottom-5 left-5 z-[60] flex flex-col items-start gap-2">
      {open && (
        <div role="dialog" aria-label={quickSupport.title} className="kv-glass w-[270px] rounded-[18px] p-3 animate-[scaleIn_0.2s_ease]">
          <div className="flex items-start justify-between gap-2 px-1.5 pb-2">
            <div><p className="text-[13.5px] font-extrabold">{quickSupport.title}</p><p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--kv-muted)]"><Clock size={11} />{quickSupport.hours}</p></div>
            <button onClick={() => setOpen(false)} aria-label="بستن پشتیبانی" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><X size={15} /></button>
          </div>
          <div className="space-y-1">
            {channels.map((c) => (
              <a key={c.id} href={channelHref(c)} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-3 rounded-[12px] px-2.5 py-2 text-[13px] font-semibold hover:bg-[var(--kv-surface-2)]">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] text-white" style={{ background: TINT[c.id] }}>{ICON[c.id]}</span>
                <span className="flex-1">{c.label}</span><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{c.value}</span>
              </a>
            ))}
            <button onClick={() => { setOpen(false); onTicket(); }} className="flex min-h-11 w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-right text-[13px] font-semibold hover:bg-[var(--kv-surface-2)]">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--kv-accent)] text-white"><Headset size={17} /></span>ثبت تیکت پشتیبانی
            </button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label="پشتیبانی سریع" className="kv-press flex h-13 items-center gap-2 rounded-full bg-[var(--kv-accent)] px-4 py-3 text-[13px] font-bold text-white shadow-[var(--shadow-soft-lg)]">
        {open ? <X size={19} /> : <Headset size={19} />}<span className="hidden sm:inline">پشتیبانی</span>
      </button>
    </div>
  );
}
