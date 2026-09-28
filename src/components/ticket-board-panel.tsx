import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty, Field, Input, Textarea, Select } from "../components/primitives";
import { ticketsApi } from "../data/api";

export function TicketBoardPanel() {
  const [board, setBoard] = useState<Record<string,unknown[]>|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [detail, setDetail] = useState<Record<string,unknown>|null>(null);
  const [reply, setReply] = useState("");
  const [newTicket, setNewTicket] = useState({ subject:"مشکل در سفارش", body:"توضیح مشکل", priority:"normal" as "low"|"normal"|"high"|"urgent", channel:"order" as "order"|"product"|"payment"|"account"|"other" });
  const load = async () => {
    setError(null);
    try {
      const b = await ticketsApi.board() as {columns: Record<string,unknown[]>};
      setBoard(b.columns);
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const open = async (id:string) => {
    try { const d = await ticketsApi.get(id) as Record<string,unknown>; setDetail(d); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const create = async () => {
    try { await ticketsApi.create({ subject:newTicket.subject, body:newTicket.body, priority:newTicket.priority, channel:newTicket.channel }); await load(); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const sendReply = async () => {
    if(!detail || !reply.trim()) return;
    try { await ticketsApi.reply((detail as {id:string}).id, { message: reply }); setReply(""); await open((detail as {id:string}).id); await load(); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!board) return <LoadingState label="در حال بارگذاری بورد تیکت…" />;
  const columns = Object.entries(board);
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4">
        <p className="text-[13px] font-bold">تیکت جدید (shared domain: customer/supplier/admin همگی روی جدول tickets با owner_type)</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="موضوع"><Input value={newTicket.subject} onChange={v=>setNewTicket({...newTicket, subject:v})} /></Field>
          <Field label="priority"><Select options={["low","normal","high","urgent"]} value={newTicket.priority} onChange={v=>setNewTicket({...newTicket, priority:v as typeof newTicket.priority})} /></Field>
          <Field label="channel"><Select options={["order","product","payment","account","other"]} value={newTicket.channel} onChange={v=>setNewTicket({...newTicket, channel:v as typeof newTicket.channel})} /></Field>
          <Field label="متن"><Textarea rows={2} value={newTicket.body} onChange={(v)=>setNewTicket({...newTicket, body: v})} /></Field>
          <div className="flex items-end"><Btn variant="accent" size="sm" onClick={()=>void create()}>ثبت تیکت</Btn></div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--kv-muted)]">کانبان: open → pending → resolved → closed ؛ هر تغییر با append-only history و پیوست‌های مشترک.</p>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {columns.map(([status, items])=>(
          <Card key={status} className="p-3">
            <p className="mb-2 text-[13px] font-extrabold">{status} <span className="text-[11px] text-[var(--kv-muted)]">({(items as unknown[]).length})</span></p>
            <div className="space-y-2 max-h-[520px] overflow-y-auto kv-scroll">
              {(items as {id:string; subject:string; priority:string; owner_type:string; created_at:string}[]).map(t=>(
                <button key={t.id} onClick={()=>void open(t.id)} className="w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 text-right hover:border-[var(--kv-accent)]">
                  <p className="text-xs font-bold truncate">{t.subject}</p><p className="text-[11px] text-[var(--kv-muted)]">{t.priority} · {t.owner_type} · {new Date(t.created_at).toLocaleDateString("fa-IR")}</p>
                </button>
              ))}
              {(items as unknown[]).length===0 && <p className="text-xs text-[var(--kv-muted)] py-4 text-center">خالی</p>}
            </div>
          </Card>
        ))}
      </div>

      {detail && (
        <Card className="p-4">
          <p className="text-[13px] font-bold">{String((detail as Record<string,unknown>).subject ?? (detail as Record<string,unknown>).id)} <span className="text-[11px] text-[var(--kv-muted)]">#{String((detail as Record<string,unknown>).id).slice(0,8)}</span></p>
          <p className="text-xs text-[var(--kv-muted)]">وضعیت: {String((detail as Record<string,unknown>).status ?? "—")} · اولویت: {String((detail as Record<string,unknown>).priority ?? "—")}</p>
          <div className="mt-3 max-h-[240px] overflow-y-auto space-y-2 bg-[var(--kv-surface-2)]/60 p-3 rounded-[10px]">
            {(Array.isArray((detail as Record<string,unknown>).messages) ? (detail as Record<string,unknown>).messages as {id:string; author_type:string; message:string; created_at:string}[] : []).map(m=>(
              <div key={m.id} className="rounded-[10px] bg-[var(--kv-surface)] border border-[var(--kv-line)] px-3 py-2 text-xs"><b>{m.author_type}</b> · {new Date(m.created_at).toLocaleString("fa-IR")}<p className="mt-1 leading-5">{m.message}</p></div>
            ))}
            {!Array.isArray((detail as Record<string,unknown>).messages) && <p className="text-xs text-[var(--kv-muted)]">{String((detail as Record<string,unknown>).body ?? "بدون پیام")}</p>}
          </div>
          <div className="mt-3 flex gap-2"><Input value={reply} onChange={setReply} placeholder="پاسخ…" /><Btn variant="accent" size="sm" disabled={!reply.trim()} onClick={()=>void sendReply()}>ارسال</Btn><Btn variant="ghost" size="sm" onClick={()=>setDetail(null)}>بستن</Btn></div>
        </Card>
      )}
      {columns.length===0 && <Empty title="تیکتی نیست" desc="بورد مشترک: customer/supplier/admin روی یک منبع." />}
    </div>
  );
}
