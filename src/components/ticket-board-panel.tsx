import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Field, Input, Textarea, Select } from "../components/primitives";
import { adminApi, ticketsApi } from "../data/api";
import {
  TICKET_CATEGORIES, TICKET_DEPARTMENTS, TICKET_PRIORITIES, TICKET_PRIORITY_LABEL, TICKET_STATUSES,
  TICKET_STATUS_LABEL, buildTicketCreatePayload, buildTicketReplyPayload, buildTicketUpdatePayload,
  type Ticket as ApiTicket, type TicketBoard, type TicketPriority, type TicketStatus,
} from "../data/contracts";

/** Admin Kanban — consumes the server board contract `{ columns: { new: [], … } }` directly. */
export function TicketBoardPanel() {
  const [board, setBoard] = useState<TicketBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiTicket | null>(null);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [newTicket, setNewTicket] = useState({
    subject: "", category: TICKET_CATEGORIES[0] as string,
    message: "", priority: "normal" as TicketPriority,
  });

  const load = async () => {
    setError(null);
    try {
      const [mapped] = await Promise.all([ticketsApi.boardMap(), adminApi.supportAgents().then((r) => setAgents(r.items ?? [])).catch(() => setAgents([]))]);
      setBoard(mapped);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); }, []);
  const open = async (id: string) => {
    try { setDetail(await ticketsApi.detail(id)); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  const create = async () => {
    try {
      const created = await ticketsApi.create(buildTicketCreatePayload(newTicket));
      await load();
      await open(created.id);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  const sendReply = async () => {
    if (!detail) return;
    try {
      await ticketsApi.reply(detail.id, buildTicketReplyPayload(reply, internal));
      setReply(""); setInternal(false);
      await open(detail.id); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  const patch = async (status: TicketStatus, assigneeId?: string | null, department?: string) => {
    if (!detail) return;
    try {
      await ticketsApi.update(detail.id, buildTicketUpdatePayload({ status, assigneeId, department }));
      await open(detail.id); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!board) return <LoadingState label="در حال بارگذاری بورد تیکت…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4">
        <p className="text-[13px] font-bold">ثبت تیکت جدید</p>
        <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">تیکت از طرف پشتیبانی ثبت می‌شود؛ مشتری و تأمین‌کننده هم از پنل خودشان تیکت می‌فرستند و همه در همین بورد دیده می‌شوند.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="موضوع"><Input value={newTicket.subject} onChange={(v) => setNewTicket({ ...newTicket, subject: v })} placeholder="مثلاً پیگیری مرسوله سفارش ۱۲۳" /></Field>
          <Field label="دسته"><Select options={[...TICKET_CATEGORIES]} value={newTicket.category} onChange={(v) => setNewTicket({ ...newTicket, category: v })} /></Field>
          <Field label="اولویت"><Select options={TICKET_PRIORITIES.map((p) => TICKET_PRIORITY_LABEL[p])} value={TICKET_PRIORITY_LABEL[newTicket.priority]} onChange={(v) => setNewTicket({ ...newTicket, priority: TICKET_PRIORITIES.find((p) => TICKET_PRIORITY_LABEL[p] === v) ?? "normal" })} /></Field>
          <Field label="متن"><Textarea rows={2} value={newTicket.message} onChange={(v) => setNewTicket({ ...newTicket, message: v })} placeholder="شرح کامل موضوع…" /></Field>
          <div className="flex items-end"><Btn variant="accent" size="sm" disabled={!newTicket.subject.trim() || !newTicket.message.trim()} onClick={() => void create()}>ثبت تیکت</Btn></div>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
        {TICKET_STATUSES.map((status) => (
          <Card key={status} className="p-3">
            <p className="mb-2 text-[13px] font-extrabold">{TICKET_STATUS_LABEL[status]} <span className="text-[11px] text-[var(--kv-muted)]">({board[status].length.toLocaleString("fa-IR")})</span></p>
            <div className="max-h-[520px] space-y-2 overflow-y-auto kv-scroll">
              {board[status].map((ticket) => (
                <button key={ticket.id} onClick={() => void open(ticket.id)} className="w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 text-right hover:border-[var(--kv-accent)]">
                  <p className="truncate text-xs font-bold">{ticket.subject}</p>
                  <p className="text-[11px] text-[var(--kv-muted)]">{ticket.reference} · {TICKET_PRIORITY_LABEL[ticket.priority]} · {ticket.category}</p>
                  {ticket.attachments.length > 0 && <p className="text-[10.5px] text-[var(--kv-faint)]">{ticket.attachments.length.toLocaleString("fa-IR")} پیوست</p>}
                </button>
              ))}
              {board[status].length === 0 && <p className="py-4 text-center text-xs text-[var(--kv-muted)]">خالی</p>}
            </div>
          </Card>
        ))}
      </div>

      {detail && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-bold">{detail.subject} <span className="text-[11px] text-[var(--kv-muted)]">{detail.reference}</span></p>
            <div className="flex flex-wrap items-center gap-2">
              <Select options={TICKET_STATUSES.map((s) => TICKET_STATUS_LABEL[s])} value={TICKET_STATUS_LABEL[detail.status]} onChange={(v) => void patch(TICKET_STATUSES.find((s) => TICKET_STATUS_LABEL[s] === v) ?? detail.status)} />
              <Select options={["تعیین نشده", ...agents.map((a) => a.displayName)]} value={detail.assigneeId ? agents.find((a) => a.id === detail.assigneeId)?.displayName ?? "تعیین نشده" : "تعیین نشده"} onChange={(v) => void patch(detail.status, agents.find((a) => a.displayName === v)?.id ?? null)} />
              <Select options={[...TICKET_DEPARTMENTS]} value={detail.department ?? TICKET_DEPARTMENTS[0]} onChange={(v) => void patch(detail.status, undefined, v)} />
              <Btn variant="ghost" size="sm" onClick={() => setDetail(null)}>بستن</Btn>
            </div>
          </div>
          <p className="mt-1 text-xs text-[var(--kv-muted)]">اولویت: {TICKET_PRIORITY_LABEL[detail.priority]} · مهلت: {detail.slaDueAt ? new Date(detail.slaDueAt).toLocaleString("fa-IR") : "—"}{detail.orderId ? ` · سفارش ${detail.orderId.slice(0, 8)}` : ""}</p>
          {detail.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              {detail.attachments.map((attachment) => attachment.url
                ? <a key={attachment.id} href={attachment.url} download={attachment.title} className="rounded-lg border border-[var(--kv-line)] px-2 py-1 hover:bg-[var(--kv-surface-2)]">{attachment.title} ({Math.ceil(attachment.size / 1024).toLocaleString("fa-IR")} KB)</a>
                : <span key={attachment.id} className="rounded-lg border border-[var(--kv-line)] px-2 py-1">{attachment.title}</span>)}
            </div>
          )}
          <div className="mt-3 max-h-[240px] space-y-2 overflow-y-auto rounded-[10px] bg-[var(--kv-surface-2)]/60 p-3">
            {detail.messages.map((message) => (
              <div key={message.id} className="rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 text-xs">
                <b>{message.internal ? "یادداشت داخلی" : message.senderId === detail.ownerId ? "کاربر" : "پشتیبانی"}</b> · {message.createdAt ? new Date(message.createdAt).toLocaleString("fa-IR") : "—"}
                <p className="mt-1 leading-5">{message.body}</p>
              </div>
            ))}
            {detail.messages.length === 0 && <p className="text-xs text-[var(--kv-muted)]">بدون پیام</p>}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Input value={reply} onChange={setReply} placeholder="پاسخ…" />
            <Btn variant="accent" size="sm" disabled={!reply.trim()} onClick={() => void sendReply()}>ارسال</Btn>
            <label className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-[var(--kv-muted)]"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> داخلی</label>
          </div>
        </Card>
      )}
    </div>
  );
}
