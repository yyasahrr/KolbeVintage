import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty, Field, Textarea } from "../components/primitives";
import { crmApi } from "../data/api";

export function CrmPanel() {
  const [contacts, setContacts] = useState<unknown[] | null>(null);
  const [automations, setAutomations] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string|null>(null);
  const [selected, setSelected] = useState<Record<string,unknown>|null>(null);
  const [activities, setActivities] = useState<unknown[]|null>(null);
  const [note, setNote] = useState("");
  const load = async () => {
    setError(null);
    try {
      const [c, a] = await Promise.all([
        crmApi.contacts() as Promise<{items:unknown[]}>,
        crmApi.automations() as Promise<{items:unknown[]}>,
      ]);
      setContacts(c.items); setAutomations(a.items);
    } catch(e){ setError(e instanceof Error? e.message: "خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const openContact = async (id:string) => {
    try {
      const detail = await crmApi.contact(id) as Record<string,unknown>;
      setSelected(detail);
      const acts = await crmApi.activities(id) as {items:unknown[]};
      setActivities(acts.items);
    } catch(e){ setError(e instanceof Error? e.message:"خطا"); }
  };
  const addNote = async () => {
    if(!selected || !note.trim()) return;
    try {
      const id = (selected as {id:string}).id;
      await crmApi.addActivity(id, { type: "note", title: note.slice(0, 60), body: note });
      setNote(""); const acts = await crmApi.activities(id) as {items:unknown[]}; setActivities(acts.items);
    } catch(e){ setError(e instanceof Error? e.message:"خطا"); }
  };
  const runAutomation = async (id:string) => {
    try { await crmApi.runAutomation(id); await load(); } catch(e){ setError(e instanceof Error? e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!contacts || !automations) return <LoadingState label="در حال بارگذاری CRM…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">مخاطبان</p><p className="text-lg font-extrabold tabular-nums">{contacts.length}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">اتوماسیون‌ها</p><p className="text-lg font-extrabold tabular-nums">{automations.length}</p></Card>
        <Card className="p-4"><p className="text-xs text-[var(--kv-muted)]">یادداشت‌ها</p><p className="text-[11px] text-[var(--kv-muted)]">فعالیت‌ها در سرور PostgreSQL ذخیره می‌شوند</p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_0.9fr]">
        <Card className="overflow-hidden">
          <div className="px-4 py-3 flex items-center justify-between"><p className="text-[13px] font-bold">مخاطبان (crm_contacts)</p><Btn variant="ghost" size="sm" onClick={load}>بروزرسانی</Btn></div>
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[900px] text-xs">
              <thead><tr><th>نام</th><th>نوع</th><th>بخش</th><th>سفارش‌ها</th><th>کل خرید</th><th>برچسب‌ها</th><th></th></tr></thead>
              <tbody>
                {(contacts as {id:string; display_name:string; phone:string; actor_type:string; segment:string|null; tags:string[]; order_count:number; total_spent_rial:string}[]).slice(0,50).map(c=>(
                  <tr key={c.id}>
                    <td><b>{c.display_name ?? c.phone ?? c.id.slice(0,8)}</b><p className="text-[11px] text-[var(--kv-muted)] tabular-nums">{c.phone ?? ""}</p></td>
                    <td>{c.actor_type}</td><td>{c.segment ?? "—"}</td><td className="tabular-nums">{c.order_count}</td><td className="tabular-nums">{Number(c.total_spent_rial).toLocaleString("fa-IR")}</td>
                    <td><div className="flex flex-wrap gap-1">{(c.tags ?? []).map(t=> <span key={t} className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10px]">{t}</span>)}</div></td>
                    <td><Btn size="sm" variant="soft" onClick={()=>void openContact(c.id)}>جزئیات</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {contacts.length===0 && <Empty title="مخاطبی یافت نشد" desc="مخاطبان از کاربران سایت و تأمین‌کنندگان ساخته می‌شوند." />}
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <p className="text-[13px] font-bold">اتوماسیون‌ها</p>
            <div className="mt-3 space-y-2">
              {(automations as {id:string; code:string; name:string; automation_type:string; active:boolean; last_run_at:string|null}[]).map(a=>(
                <div key={a.id} className="flex items-center justify-between rounded-[10px] border border-[var(--kv-line)] px-3 py-2">
                  <div><p className="text-[12px] font-bold">{a.name}</p><p className="text-[11px] text-[var(--kv-muted)]">{a.code} · {a.automation_type} · {a.active ? "فعال" : "غیرفعال"}</p></div>
                  <Btn size="sm" variant="soft" onClick={()=>void runAutomation(a.id)}>اجرای دستی</Btn>
                </div>
              ))}
              {automations.length===0 && <p className="text-xs text-[var(--kv-muted)]">اتوماسیونی ثبت نشده — birthday_sms, winback, order_followup</p>}
            </div>
          </Card>

          <Card className="p-4">
            <p className="text-[13px] font-bold">پروفایل ۳۶۰</p>
            {!selected ? <p className="mt-2 text-xs text-[var(--kv-muted)]">روی «جزئیات» یک مخاطب بزنید.</p> : (
              <div className="mt-3 space-y-3">
                <div className="rounded-[10px] bg-[var(--kv-surface-2)]/60 p-3 text-xs leading-6">
                  <p className="font-bold">{String((selected as Record<string,unknown>).display_name ?? (selected as Record<string,unknown>).phone ?? (selected as Record<string,unknown>).id)}</p>
                  <p className="text-[var(--kv-muted)]">نوع: {String((selected as Record<string,unknown>).actor_type ?? "—")} · بخش: {String((selected as Record<string,unknown>).segment ?? "—")}</p>
                </div>
                <Field label="فعالیت‌ها"><div className="max-h-[260px] overflow-y-auto space-y-2">
                  {(activities ?? []).length ? (activities as {id:string; type:string; title:string; body:string; created_at:string}[]).map(act=>(
                    <div key={act.id} className="rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-xs"><b>{act.type}</b> — {act.title}<p className="text-[11px] text-[var(--kv-muted)]">{new Date(act.created_at).toLocaleString("fa-IR")}</p><p className="mt-1 leading-5">{act.body}</p></div>
                  )) : <p className="text-xs text-[var(--kv-muted)]">فعالیتی ثبت نشده</p>}
                </div></Field>
                <Field label="یادداشت جدید"><Textarea rows={3} value={note} onChange={setNote} placeholder="یادداشت یا تماس…" /></Field>
                <Btn variant="accent" size="sm" disabled={!note.trim()} onClick={()=>void addNote()}>ثبت یادداشت</Btn>
                <div className="text-[11px] leading-5 text-[var(--kv-muted)]">اتوماسیون تولد: هر روز ساعت Asia/Tehran چک می‌شود؛ کوپن از موتور کوپن ساخته و SMS از پنل پیامک صف‌بندی می‌شود؛ نتیجه در activities لاگ می‌شود.</div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
