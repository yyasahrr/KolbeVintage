import { useEffect, useId, useRef, useState } from "react";
import { MessageCircle, Send, X, Phone, Mail, Headset, Clock, Check, RotateCcw, Truck, Ban, Paperclip, ShieldAlert } from "lucide-react";
import { fmtMoney } from "../data/catalog";
import { useOps, opsNow, channelHref, RETURN_STATUS, type ReturnReq, type Ticket as DemoTicket, type QuickChannelId } from "../data/ops";
import { Btn, Empty, Field, Input, Select, Status, Textarea, Timeline, Segmented } from "./primitives";
import { adminApi, apiClient, ordersApi, ticketsApi } from "../data/api";
import {
  TICKET_CATEGORIES, TICKET_DEPARTMENTS, TICKET_PRIORITIES, TICKET_PRIORITY_LABEL, TICKET_STATUS_LABEL,
  TICKET_STATUSES, adaptTicketList, buildTicketCreatePayload, buildTicketReplyPayload, buildTicketUpdatePayload,
  type Ticket as ApiTicket, type TicketAttachment, type TicketPriority, type TicketStatus,
} from "../data/contracts";
import { cn } from "../utils/cn";
import { useDismissOnOutside } from "./storefront/shared";

const CATEGORIES: string[] = [...TICKET_CATEGORIES];
const DEPARTMENTS: string[] = [...TICKET_DEPARTMENTS];
const STATUS_OPTIONS: TicketStatus[] = [...TICKET_STATUSES];
const PRIORITY_LABEL = TICKET_PRIORITY_LABEL;
const TICKET_STATUS = TICKET_STATUS_LABEL;

/* View model shared by the server-backed and the ?demo=1 paths. */
type ViewMessage = { id: string; from: "user" | "agent"; name: string; text: string; at: string; internal: boolean };
type ViewTicket = {
  id: string; reference: string; subject: string; category: string;
  priority: TicketPriority; status: TicketStatus;
  ownerId: string; ownerName: string; ownerType: "customer" | "supplier";
  department: string | null; assigneeId: string | null;
  orderRef: string | null; createdAt: string; slaDueAt: string | null;
  messages: ViewMessage[]; attachments: TicketAttachment[];
  events: { at: string; by: string; action: string }[];
};

const shortId = (id: string) => (id ? id.slice(0, 8) : "—");

function fromApiTicket(ticket: ApiTicket, ownerName?: string): ViewTicket {
  return {
    id: ticket.id, reference: ticket.reference || shortId(ticket.id), subject: ticket.subject, category: ticket.category,
    priority: ticket.priority, status: ticket.status,
    ownerId: ticket.ownerId, ownerName: ownerName ?? `${shortId(ticket.ownerId)}`, ownerType: "customer",
    department: ticket.department, assigneeId: ticket.assigneeId,
    orderRef: ticket.orderId ? shortId(ticket.orderId) : null, createdAt: ticket.createdAt, slaDueAt: ticket.slaDueAt,
    messages: ticket.messages.map((message) => ({
      id: message.id,
      from: message.senderId && message.senderId === ticket.ownerId ? "user" : "agent",
      name: message.senderId && message.senderId === ticket.ownerId ? (ownerName ?? "کاربر") : "پشتیبانی کلبه",
      text: message.body, at: message.createdAt, internal: message.internal,
    })),
    attachments: ticket.attachments,
    events: [],
  };
}

function fromDemoTicket(ticket: DemoTicket): ViewTicket {
  return {
    id: ticket.id, reference: ticket.id, subject: ticket.subject, category: ticket.category,
    priority: ticket.priority, status: ticket.status,
    ownerId: ticket.ownerId, ownerName: ticket.ownerName, ownerType: ticket.ownerType,
    department: ticket.department ?? null, assigneeId: null,
    orderRef: ticket.orderRef ?? null, createdAt: ticket.createdAt, slaDueAt: ticket.slaDueAt ?? null,
    messages: (ticket.messages ?? []).map((message, index) => ({
      id: `${ticket.id}-m${index}`, from: message.from, name: message.name, text: message.text, at: message.at, internal: false,
    })),
    attachments: (ticket.attachments ?? []).map((attachment, index) => ({
      id: `${ticket.id}-a${index}`, ticketId: ticket.id, fileId: null, title: attachment.name,
      mime: "application/octet-stream", size: attachment.size, createdAt: ticket.createdAt, url: attachment.dataUrl,
    })),
    events: ticket.events ?? [],
  };
}

/* ================= Ticket center (customer / supplier / admin) ================= */
export function TicketCenter({ perspective, ownerId, ownerName, ownerType }: {
  perspective: "owner" | "admin"; ownerId?: string; ownerName?: string; ownerType?: "customer" | "supplier";
}) {
  const ops = useOps();
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [rows, setRows] = useState<ApiTicket[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiTicket | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isDemo);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [internalNote, setInternalNote] = useState(false);
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [orders, setOrders] = useState<{ id: string; reference: string }[]>([]);

  const load = async () => {
    setLoading(true); setServerError(null);
    try {
      if (perspective === "admin") {
        const board = await ticketsApi.boardMap();
        setRows(TICKET_STATUSES.flatMap((status) => board[status]));
      } else {
        setRows(adaptTicketList(await ticketsApi.list()));
      }
    } catch (e) { setServerError(e instanceof Error ? e.message : "خطا در بارگذاری تیکت‌ها"); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (!isDemo) void load(); }, [isDemo, perspective, ownerId]);
  useEffect(() => {
    if (isDemo || perspective !== "admin") return;
    adminApi.supportAgents().then((r) => setAgents(r.items ?? [])).catch(() => setAgents([]));
  }, [isDemo, perspective]);
  useEffect(() => {
    if (isDemo || perspective !== "owner") return;
    ordersApi.list({ limit: "30" }).then((r) => setOrders((r.items ?? []).map((o) => ({ id: o.id, reference: o.reference })))).catch(() => setOrders([]));
  }, [isDemo, perspective]);
  useEffect(() => {
    if (isDemo || !sel) { setDetail(null); return; }
    let live = true;
    ticketsApi.detail(sel).then((ticket) => { if (live) setDetail(ticket); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [isDemo, sel]);

  const demoList: ViewTicket[] = ops.tickets
    .filter((t) => perspective === "admin" || (t.ownerId === ownerId && t.ownerType === ownerType))
    .map(fromDemoTicket);
  const serverList: ViewTicket[] = rows.map((row) => fromApiTicket(row, row.ownerId === ownerId ? ownerName : undefined));
  const list: ViewTicket[] = isDemo ? demoList : serverList;
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  const visible = list.filter((t) => filter === "all" || (filter === "open" ? t.status !== "closed" : t.status === "closed"));
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState({ subject: "", category: CATEGORIES[0]!, priority: "normal" as TicketPriority, orderId: "", text: "", attachment: null as File | null });
  const [reply, setReply] = useState("");
  const current = (detail ? fromApiTicket(detail, detail.ownerId === ownerId ? ownerName : undefined) : undefined)
    ?? list.find((t) => t.id === sel)
    ?? undefined;
  const assigneeName = (ticket: ViewTicket) =>
    ticket.assigneeId ? agents.find((agent) => agent.id === ticket.assigneeId)?.displayName ?? shortId(ticket.assigneeId) : "هنوز تعیین نشده";

  const create = async () => {
    if (!ownerId || !ownerName || !ownerType) return;
    if (draft.attachment && draft.attachment.size > 10 * 1024 * 1024) { setUploadState("error"); return; }
    if (isDemo) {
      if (draft.attachment && draft.attachment.size > 700_000) return;
      const attachmentUrl = draft.attachment ? await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود"));
        reader.readAsDataURL(draft.attachment!);
      }) : null;
      const createdAt = opsNow();
      const due = new Date(Date.now() + (draft.priority === "high" ? 4 : draft.priority === "normal" ? 24 : 48) * 3600000).toISOString();
      const ticket: DemoTicket = {
        id: `TK-${Date.now().toString().slice(-5)}`, ownerType, ownerId, ownerName, subject: draft.subject.trim(), category: draft.category,
        priority: draft.priority, status: "new", orderRef: orders.find((o) => o.id === draft.orderId)?.reference, createdAt,
        department: "پشتیبانی عمومی", slaDueAt: due, events: [{ at: createdAt, by: ownerName, action: "تیکت ثبت شد" }],
        attachments: draft.attachment && attachmentUrl ? [{ name: draft.attachment.name, dataUrl: attachmentUrl, size: draft.attachment.size }] : [],
        messages: [{ from: "user", name: ownerName, text: draft.text.trim(), at: createdAt }],
      };
      ops.upsert("tickets", ticket, true);
      setSel(ticket.id); setComposing(false);
      setDraft({ subject: "", category: CATEGORIES[0]!, priority: "normal", orderId: "", text: "", attachment: null });
      return;
    }
    try {
      setUploadState("uploading"); setUploadProgress(20); setServerError(null);
      // Canonical create payload: subject / category / priority / orderId (real UUID) / message
      const payload = buildTicketCreatePayload({
        subject: draft.subject, category: draft.category, priority: draft.priority,
        orderId: draft.orderId || undefined, message: draft.text,
      });
      const created = await ticketsApi.create(payload);
      setUploadProgress(70);
      if (draft.attachment) {
        setUploadProgress(85);
        await ticketsApi.attach(created.id, draft.attachment, draft.attachment.name, draft.attachment.name);
      }
      setUploadProgress(100); setUploadState("success");
      await load();
      setSel(created.id); setComposing(false);
      setDraft({ subject: "", category: CATEGORIES[0]!, priority: "normal", orderId: "", text: "", attachment: null });
      setTimeout(() => { setUploadState("idle"); setUploadProgress(null); }, 2000);
    } catch (e) {
      setUploadState("error");
      setServerError(e instanceof Error ? e.message : "خطا در ثبت تیکت");
    }
  };

  const change = async (ticket: ViewTicket, patch: { status?: TicketStatus; department?: string; assigneeId?: string | null }) => {
    if (isDemo) { ops.upsert("tickets", { ...ops.tickets.find((t) => t.id === ticket.id)!, ...patch } as DemoTicket); return; }
    try {
      await ticketsApi.update(ticket.id, buildTicketUpdatePayload({
        status: patch.status ?? ticket.status,
        department: patch.department,
        ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
      }));
      await load();
      const refreshed = await ticketsApi.detail(ticket.id);
      setDetail(refreshed);
    } catch (e) { setServerError(e instanceof Error ? e.message : "خطا در به‌روزرسانی تیکت"); }
  };

  const send = async () => {
    if (!current || !reply.trim()) return;
    if (isDemo) {
      const fromAgent = perspective === "admin";
      const ticket = ops.tickets.find((t) => t.id === current.id)!;
      ops.upsert("tickets", {
        ...ticket, status: fromAgent ? "answered" : "new",
        messages: [...ticket.messages, { from: fromAgent ? "agent" : "user", name: fromAgent ? "پشتیبانی کلبه" : ticket.ownerName, text: reply.trim(), at: opsNow() }],
        events: [...(ticket.events ?? []), { at: opsNow(), by: fromAgent ? "پشتیبانی کلبه" : ticket.ownerName, action: fromAgent ? "پاسخ کارشناس ثبت شد" : "پاسخ درخواست‌کننده ثبت شد" }],
      } as DemoTicket);
      setReply(""); return;
    }
    try {
      await ticketsApi.reply(current.id, buildTicketReplyPayload(reply, perspective === "admin" && internalNote));
      setReply(""); setInternalNote(false);
      await load();
      setDetail(await ticketsApi.detail(current.id));
    } catch (e) { setServerError(e instanceof Error ? e.message : "خطا در ارسال پاسخ"); }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <Segmented<"all" | "open" | "closed"> options={[{ v: "all", label: "همه" }, { v: "open", label: "باز" }, { v: "closed", label: "بسته" }]} value={filter} onChange={setFilter} />
          {perspective === "owner" && <Btn variant="accent" size="sm" onClick={() => { setComposing(true); setSel(null); }}>تیکت جدید</Btn>}
        </div>
        {loading && <p className="rounded-[12px] border border-[var(--kv-line)] p-3 text-center text-[12px] text-[var(--kv-muted)]">در حال بارگذاری…</p>}
        {serverError && <p role="alert" className="mb-2 rounded-[12px] border border-[var(--kv-danger)]/40 p-2 text-[11.5px] text-[var(--kv-danger)]">{serverError}</p>}
        <div className="space-y-2">
          {visible.length === 0 && !loading && <p className="rounded-[12px] border border-dashed border-[var(--kv-line-strong)] p-4 text-center text-[12.5px] text-[var(--kv-muted)]">تیکتی در این دسته نیست.</p>}
          {visible.map((t) => (
            <button key={t.id} onClick={() => { setSel(t.id); setComposing(false); }} className={cn("w-full rounded-[12px] border p-3 text-right transition-colors", sel === t.id && !composing ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:border-[var(--kv-line-strong)]")}>
              <div className="flex items-center justify-between gap-2"><b className="truncate text-[13px]">{t.subject}</b><Status value={TICKET_STATUS[t.status]} dot={false} /></div>
              <p className="mt-1 truncate text-[11.5px] text-[var(--kv-muted)]">{perspective === "admin" ? `${t.ownerName} · ${t.ownerType === "supplier" ? "تأمین‌کننده" : "مشتری"} · ` : ""}{t.category} · {t.reference}</p>
              <p className="mt-0.5 text-[11px] text-[var(--kv-faint)]">{t.messages[t.messages.length - 1]?.at}{(t.priority === "high" || t.priority === "urgent") && <span className="mr-2 font-bold text-[var(--kv-danger)]">{PRIORITY_LABEL[t.priority]}</span>}</p>
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
              <Field label="اولویت"><Select options={TICKET_PRIORITIES.map((p) => PRIORITY_LABEL[p])} value={PRIORITY_LABEL[draft.priority]} onChange={(v) => setDraft({ ...draft, priority: TICKET_PRIORITIES.find((p) => PRIORITY_LABEL[p] === v) ?? "normal" })} /></Field>
              <Field label="سفارش مرتبط (اختیاری)" hint={isDemo ? "demo" : "شناسه واقعی سفارش از سرور"}>
                <Select
                  options={["بدون سفارش", ...orders.map((o) => o.reference)]}
                  value={draft.orderId ? orders.find((o) => o.id === draft.orderId)?.reference ?? "بدون سفارش" : "بدون سفارش"}
                  onChange={(v) => setDraft({ ...draft, orderId: orders.find((o) => o.reference === v)?.id ?? "" })}
                />
              </Field>
            </div>
            <Field label="شرح"><Textarea rows={5} value={draft.text} onChange={(v) => setDraft({ ...draft, text: v })} placeholder="جزئیات را بنویسید تا سریع‌تر پاسخ بگیرید…" /></Field>
            <label className="block text-[12.5px] font-semibold">ضمیمه (اختیاری، حداکثر ۱۰ مگابایت){!isDemo && " — multipart روی سرور"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,video/mp4,text/plain" className="mt-2 block w-full text-[12px]" onChange={(e) => setDraft({ ...draft, attachment: e.target.files?.[0] ?? null })} />
            </label>
            {draft.attachment && <p className="text-[11px] text-[var(--kv-muted)]">نام: {draft.attachment.name} · MIME: {draft.attachment.type || "—"} · حجم: {(draft.attachment.size / 1024).toFixed(1)} KB</p>}
            {uploadState === "uploading" && uploadProgress !== null && <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--kv-surface-2)]"><div className="h-full bg-[var(--kv-accent)] transition-all" style={{ width: `${uploadProgress}%` }} /></div>}
            {uploadState === "error" && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">خطا در ثبت یا آپلود — دوباره تلاش کنید.</p>}
            {uploadState === "success" && <p className="text-[12px] text-green-600">ثبت و آپلود موفق ✓</p>}
            <Btn variant="accent" disabled={draft.subject.trim().length < 3 || draft.text.trim().length < 8 || (!!draft.attachment && draft.attachment.size > 10 * 1024 * 1024) || uploadState === "uploading"} onClick={create} icon={<Send size={15} />}>{uploadState === "uploading" ? "در حال آپلود…" : "ارسال تیکت"}</Btn>
          </div>
        ) : !current ? <Empty title="تیکتی انتخاب نشده" desc="از فهرست یک گفت‌وگو را باز کنید." /> : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--kv-line)] pb-4">
              <div><p className="text-[16px] font-extrabold">{current.subject}</p><p className="mt-1 text-[12px] text-[var(--kv-muted)]">{current.reference} · {current.category} · اولویت {PRIORITY_LABEL[current.priority]}{current.orderRef ? ` · سفارش ${current.orderRef}` : ""}{perspective === "admin" ? ` · ${current.ownerName}` : ""}</p></div>
              <div className="flex items-center gap-2">
                <Status value={TICKET_STATUS[current.status]} />
                {perspective === "admin" && (current.status !== "closed"
                  ? <Btn variant="ghost" size="sm" onClick={() => void change(current, { status: "closed" })}>بستن تیکت</Btn>
                  : <Btn variant="ghost" size="sm" onClick={() => void change(current, { status: "reviewing" })}>بازگشایی</Btn>)}
              </div>
            </div>
            <div className="grid gap-2 border-b border-[var(--kv-line)] py-3 text-[12px] sm:grid-cols-2">
              <p>واحد مسئول: <b>{current.department ?? "پشتیبانی عمومی"}</b></p>
              <p>مسئول رسیدگی: <b>{assigneeName(current)}</b></p>
              <p>آخرین پاسخ: <b>{current.messages[current.messages.length - 1]?.at ?? "—"}</b></p>
              <p>مهلت پاسخ: <b>{current.slaDueAt ? new Date(current.slaDueAt).toLocaleString("fa-IR") : "تعیین نشده"}</b></p>
            </div>
            {perspective === "admin" && (
              <div className="grid gap-2 border-b border-[var(--kv-line)] py-3 sm:grid-cols-3">
                <label className="text-[12px]">وضعیت<select aria-label="وضعیت تیکت" value={current.status} onChange={(e) => void change(current, { status: e.target.value as TicketStatus })} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">{STATUS_OPTIONS.map((status) => <option key={status} value={status}>{TICKET_STATUS[status]}</option>)}</select></label>
                <label className="text-[12px]">واحد<select aria-label="واحد رسیدگی" value={current.department ?? DEPARTMENTS[0]} onChange={(e) => void change(current, { department: e.target.value })} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">{DEPARTMENTS.map((department) => <option key={department}>{department}</option>)}</select></label>
                <label className="text-[12px]">مسئول رسیدگی<select aria-label="مسئول رسیدگی" value={current.assigneeId ?? ""} onChange={(e) => void change(current, { assigneeId: e.target.value || null })} className="mt-1 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] p-2">
                  <option value="">تعیین نشده</option>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
                </select></label>
              </div>
            )}
            {!!current.attachments.length && (
              <div className="border-b border-[var(--kv-line)] py-3 text-[12px]"><b>ضمیمه‌ها</b>
                <div className="mt-1 flex flex-wrap gap-2">
                  {current.attachments.map((attachment) => attachment.url
                    ? <a key={attachment.id} href={attachment.url} download={attachment.title} className="inline-flex items-center gap-1 rounded-lg border border-[var(--kv-line)] px-2 py-1 hover:bg-[var(--kv-surface-2)]"><Paperclip size={12} />{attachment.title} · {attachment.size ? `${(attachment.size / 1024).toFixed(1)} KB` : ""}</a>
                    : <span key={attachment.id} className="rounded-lg border border-[var(--kv-line)] px-2 py-1 text-[var(--kv-muted)]">{attachment.title}</span>)}
                </div>
              </div>
            )}
            <div className="flex-1 space-y-3 py-4" aria-live="polite">
              {current.messages.map((message) => (
                <div key={message.id} className={cn("max-w-[85%] rounded-[14px] px-4 py-3 text-[13px] leading-7", message.internal ? "mx-auto border border-dashed border-[var(--kv-warn,var(--kv-line-strong))] bg-[var(--kv-surface-2)]" : message.from === "agent" ? "mr-auto bg-[var(--kv-surface-2)]" : "ml-auto bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]")}>
                  <p className="mb-0.5 text-[11px] font-bold opacity-75">{message.internal && <ShieldAlert size={11} className="inline" />} {message.name} · {message.at}{message.internal ? " · یادداشت داخلی" : ""}</p>{message.text}
                </div>
              ))}
            </div>
            {!!current.events.length && <details className="border-t border-[var(--kv-line)] py-3 text-[12px]"><summary className="cursor-pointer font-semibold">تاریخچه رسیدگی ({current.events.length.toLocaleString("fa-IR")})</summary><ol className="mt-2 space-y-1 text-[var(--kv-muted)]">{current.events.map((event, i) => <li key={i}>{event.at} · {event.by} · {event.action}</li>)}</ol></details>}
            {current.status !== "closed" ? (
              <div className="border-t border-[var(--kv-line)] pt-4">
                <div className="flex gap-2">
                  <Input className="flex-1" value={reply} onChange={setReply} placeholder={perspective === "admin" ? "پاسخ به کاربر…" : "پیام خود را بنویسید…"} />
                  <Btn variant="accent" disabled={!reply.trim()} onClick={send} icon={<Send size={15} />}>ارسال</Btn>
                </div>
                {perspective === "admin" && (
                  <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--kv-muted)]">
                    <input type="checkbox" checked={internalNote} onChange={(e) => setInternalNote(e.target.checked)} /> یادداشت داخلی (فقط برای کارشناسان)
                  </label>
                )}
              </div>
            ) : <p className="border-t border-[var(--kv-line)] pt-4 text-[12.5px] text-[var(--kv-muted)]">این تیکت بسته شده است.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Returns center (admin) ================= */
type RetView = {
  id: string; serverId: string; orderId: string; ownerName: string; channel: "retail" | "wholesale";
  resolution: ReturnReq["resolution"]; amount: number; status: ReturnReq["status"];
  reason: string; items: string; events: { t: string; at: string }[];
};
export function ReturnsCenter({ onSync }: { onSync?: (r: ReturnReq) => void }) {
  const ops = useOps();
  const isDemoRet = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [serverReturns, setServerReturns] = useState<Record<string, unknown>[] | null>(null);
  const load = () => {
    if (isDemoRet) return;
    apiClient.get<{ items: Record<string, unknown>[] }>("/admin/returns").then((r) => setServerReturns(r.items ?? [])).catch(() => setServerReturns([]));
  };
  useEffect(load, [isDemoRet]);
  const [ch, setCh] = useState<"all" | "retail" | "wholesale">("all");
  const opsList = ops.returns.filter((r) => ch === "all" || r.channel === ch);
  const serverList: RetView[] = (serverReturns ?? []).filter((r) => ch === "all" || (r.channel ?? (r.order_type ?? "retail")) === ch).map((r): RetView => ({
    id: String(r.reference ?? r.id), serverId: String(r.id),
    orderId: String(r.order_reference ?? r.order_id ?? ""), ownerName: String(r.requester_name ?? ""),
    channel: (r.channel === "wholesale" || r.order_type === "wholesale" ? "wholesale" : "retail"),
    resolution: (r.resolution ?? "refund") as ReturnReq["resolution"], amount: Number(r.amount_rial ?? r.amount ?? 0),
    status: (r.status ?? "requested") as ReturnReq["status"], reason: String(r.reason ?? ""), items: String(r.items ?? r.reason ?? ""),
    events: [{ t: "ثبت درخواست", at: String(r.created_at ?? "") }],
  }));
  const list: RetView[] = isDemoRet ? (opsList as unknown as RetView[]) : serverList;
  const [sel, setSel] = useState<string | null>(null);
  const selected = sel ?? list[0]?.id ?? null;
  const cur: RetView | undefined = list.find((r) => r.id === selected);
  const move = async (r: RetView, status: ReturnReq["status"], tStr: string) => {
    if (isDemoRet) {
      const next = { ...r, status, events: [...(r.events ?? []), { t: tStr, at: opsNow() }] };
      ops.upsert("returns", next as unknown as ReturnReq);
      onSync?.(next as unknown as ReturnReq);
      return;
    }
    try {
      await apiClient.patch(`/admin/returns/${r.serverId}`, { status, note: tStr });
      load();
      onSync?.(r as unknown as ReturnReq);
    } catch { /* surfaced by the list refresh */ }
  };
  // بازرسی کالا پس از دریافت: قابل فروش → برگشت به موجودی قابل فروش، آسیب‌دیده → شمارش damaged.
  // سرور به‌صورت ایدمپوتنت (idempotency_key) سند انبار می‌سازد و وضعیت را «دریافت‌شده» می‌کند.
  const [inspectError, setInspectError] = useState<string | null>(null);
  const inspect = async (r: RetView, result: "sellable" | "damaged") => {
    if (isDemoRet) return;
    setInspectError(null);
    try {
      await apiClient.post(`/returns/${r.serverId}/inspect`, { result });
      load();
    } catch (e) { setInspectError(e instanceof Error ? e.message : "بازرسی ثبت نشد"); }
  };
  const RES: Record<ReturnReq["resolution"], string> = { refund: "بازپرداخت وجه", exchange: "تعویض کالا", credit: "اعتبار کیف پول" };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented<"all" | "retail" | "wholesale"> options={[{ v: "all", label: "همه" }, { v: "retail", label: "خرده" }, { v: "wholesale", label: "عمده" }]} value={ch} onChange={setCh} />
          <p className="text-[12px] text-[var(--kv-muted)]">{list.filter((r) => r.status === "requested").length.toLocaleString("fa-IR")} درخواست منتظر بررسی</p>
        </div>
        <div className="overflow-hidden rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[720px]">
              <thead><tr><th>شناسه</th><th>سفارش</th><th>درخواست‌دهنده</th><th>کانال</th><th>راه‌حل</th><th>مبلغ</th><th>وضعیت</th></tr></thead>
              <tbody>
                {list.map((r) => <tr key={r.id} onClick={() => setSel(r.id)} className={cn("cursor-pointer", selected === r.id && "bg-[var(--kv-accent)]/[0.05]")}>
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
              {cur.status === "requested" && <><Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => void move(cur, "approved", "مرجوعی تأیید شد؛ جمع‌آوری کالا برنامه‌ریزی شد")}>تأیید</Btn><Btn variant="soft" size="sm" icon={<Ban size={14} />} onClick={() => void move(cur, "rejected", "درخواست رد شد")}>رد</Btn></>}
              {cur.status === "approved" && !isDemoRet && <>
                <Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => void inspect(cur, "sellable")}>دریافت و بازرسی: قابل فروش (برگشت به موجودی)</Btn>
                <Btn variant="soft" size="sm" icon={<Ban size={14} />} onClick={() => void inspect(cur, "damaged")}>دریافت و بازرسی: آسیب‌دیده</Btn>
              </>}
              {cur.status === "approved" && isDemoRet && <Btn variant="accent" size="sm" icon={<Truck size={14} />} onClick={() => void move(cur, "received", "کالا در انبار دریافت و کنترل کیفیت شد")}>ثبت دریافت کالا</Btn>}
              {cur.status === "received" && <Btn variant="accent" size="sm" icon={<RotateCcw size={14} />} onClick={() => void move(cur, "refunded", cur.resolution === "exchange" ? "کالای جایگزین ارسال شد" : cur.resolution === "credit" ? "مبلغ به کیف پول مشتری افزوده شد" : "مبلغ به حساب مشتری بازپرداخت شد")}>{cur.resolution === "exchange" ? "ارسال جایگزین" : "بازپرداخت"}</Btn>}
            </div>
            {inspectError && <p role="alert" className="mt-2 text-[12px] font-semibold text-[var(--kv-danger)]">{inspectError}</p>}
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

/**
 * Floating quick-support launcher for the public storefront.
 *
 * Geometry is fixed: the launcher is always 52px tall with a 20px icon slot and
 * a fixed padding, so closed / hover / focus / open render in exactly the same
 * box. The open state swaps the glyph *inside* the slot (both are stacked and
 * cross-faded) and changes colour — it never adds or removes a flex child, so
 * the label cannot move and the row cannot reflow.
 *
 * It is a non-modal quick-support surface: no focus trap, Escape and outside
 * clicks close it, and focus stays where the user put it.
 *
 * Material: the launcher is LIQUID (it floats over content), the panel is FROST
 * (it must stay readable over content). Channels come from `quickSupport`; the
 * ticket action still hands off to the existing ticket centre.
 */
export function FloatingSupport({ onTicket, lift = false }: { onTicket: () => void; lift?: boolean }) {
  const { quickSupport } = useOps();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const panelId = `${generatedId}-support-panel`;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    /* Capture phase: the storefront's sheets also listen for Escape, and this
       surface closes before any of them react. */
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const dismissRef = useDismissOnOutside<HTMLDivElement>(open, () => setOpen(false));

  if (!quickSupport.enabled) return null;
  const channels = quickSupport.channels.filter((c) => c.enabled && c.value.trim());

  return (
    <div
      className="kv-sf-support"
      data-lift={lift ? "true" : "false"}
      ref={dismissRef}
    >
      <div className="kv-sf-support-inner">
        {open && (
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={quickSupport.title}
            className="kv-sf-support-panel kv-frost"
          >
            <div className="kv-sf-support-head">
              <p className="kv-sf-support-title">{quickSupport.title}</p>
              {quickSupport.hours && (
                <p className="kv-sf-support-hours"><Clock size={11} aria-hidden="true" />{quickSupport.hours}</p>
              )}
            </div>
            <div className="kv-sf-support-list">
              {channels.map((channel) => (
                <a
                  key={channel.id} href={channelHref(channel)}
                  target="_blank" rel="noopener noreferrer"
                  className="kv-sf-support-row"
                >
                  <span className="kv-sf-support-glyph" style={{ background: TINT[channel.id] }} aria-hidden="true">
                    {ICON[channel.id]}
                  </span>
                  <span className="kv-sf-support-label">{channel.label}</span>
                  <span className="kv-sf-support-value" dir="ltr">{channel.value}</span>
                </a>
              ))}
              <button
                type="button"
                onClick={() => { setOpen(false); onTicket(); }}
                className="kv-sf-support-row"
              >
                <span className="kv-sf-support-glyph" style={{ background: "var(--kvaf-charcoal)" }} aria-hidden="true">
                  <Headset size={17} />
                </span>
                <span className="kv-sf-support-label">ثبت تیکت پشتیبانی</span>
              </button>
            </div>
          </div>
        )}

        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "بستن پشتیبانی سریع" : "پشتیبانی سریع"}
          data-open={open ? "true" : "false"}
          className="kv-sf-support-launch kv-liquid kv-sf-press"
        >
          <span className="kv-sf-support-slot" aria-hidden="true">
            <Headset size={19} data-slot="closed" />
            <X size={19} data-slot="open" />
          </span>
          {/* Decorative here: the button's aria-label is the accessible name, and
              on narrow phones this caption is hidden so the launcher becomes a
              compact pill that cannot read as part of the hero's call to action. */}
          <span className="kv-sf-support-caption" aria-hidden="true">پشتیبانی</span>
        </button>
      </div>
    </div>
  );
}
