import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty, Field, Input, Select } from "../components/primitives";
import { integrationsApi } from "../data/api";
import { apiCall } from "../data/admin-api";

export function IntegrationsPanel() {
  const [items, setItems] = useState<unknown[]|null>(null);
  const [logs, setLogs] = useState<Record<string,unknown[]>>({});
  const [error, setError] = useState<string|null>(null);
  const [form, setForm] = useState({ code:"crm-test", title:"CRM تستی", category:"crm" as "payment"|"sms"|"shipping"|"marketplace"|"finance"|"crm"|"other", provider:"generic", environment:"test" as "test"|"production", secret:"demo-secret-1234", config: JSON.stringify({ testUrl:"https://example.com/health" }), enabled:false });
  const load = async () => {
    setError(null);
    try { const r = await integrationsApi.list() as {items:unknown[]}; setItems(r.items); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const create = async () => {
    try {
      const token = localStorage.getItem("kolbe-access-token") ?? undefined;
      let cfg:Record<string,unknown> = {}; try{ cfg = JSON.parse(form.config); }catch{ cfg={}; }
      await apiCall("/admin/integrations", { method:"POST", body: JSON.stringify({ code:form.code, title:form.title, category:form.category, provider:form.provider, environment:form.environment, enabled:form.enabled, config:cfg, secret:form.secret }) }, token);
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const test = async (id:string) => {
    try { await integrationsApi.test(id); await load(); const l = await integrationsApi.logs(id) as {items:unknown[]}; setLogs(s=>({...s, [id]: l.items})); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const openLogs = async (id:string) => {
    try { const l = await integrationsApi.logs(id) as {items:unknown[]}; setLogs(s=>({...s, [id]: l.items})); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!items) return <LoadingState label="در حال بارگذاری یکپارچه‌سازی‌ها…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4">
        <p className="text-[13px] font-bold">افزودن اتصال جدید (secret با AES-GCM رمزگذاری شده؛ هرگز در لاگ/پاسخ نمایش داده نمی‌شود؛ webhook با HMAC تأیید می‌شود)</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Field label="code"><Input value={form.code} onChange={v=>setForm({...form, code:v})} /></Field>
          <Field label="title"><Input value={form.title} onChange={v=>setForm({...form, title:v})} /></Field>
          <Field label="category"><Select options={["payment","sms","shipping","marketplace","finance","crm","other"]} value={form.category} onChange={v=>setForm({...form, category:v as typeof form.category})} /></Field>
          <Field label="provider"><Input value={form.provider} onChange={v=>setForm({...form, provider:v})} /></Field>
          <Field label="environment"><Select options={["test","production"]} value={form.environment} onChange={v=>setForm({...form, environment:v as "test"|"production"})} /></Field>
          <Field label="secret (encrypted at rest)"><Input value={form.secret} onChange={v=>setForm({...form, secret:v})} /></Field>
          <div className="md:col-span-3"><Field label='config JSON (مثلاً {"testUrl":"https://example.com/health","authHeaderName":"X-API-Key"})'><Input value={form.config} onChange={v=>setForm({...form, config:v})} /></Field></div>
          <div className="flex items-end"><Btn variant="accent" onClick={()=>void create()}>ایجاد و رمزگذاری</Btn></div>
        </div>
        <p className="mt-2 text-[11px] text-[var(--kv-muted)]">وضعیت‌ها: not_configured / connected / error · تست اتصال: GET config.testUrl با هدِر authHeaderName + secret (timeout 5s) · لاگ هر تلاش با attempt؛ retry لاگ قبلی را بازنویسی نمی‌کند · inbound webhook: POST /integrations/webhook/:code با X-Signature=HMAC(secret, rawBody).</p>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">اتصالات ({items.length})</p></div>
        <div className="space-y-3 p-4">
          {(items as {id:string; code:string; title:string; category:string; environment:string; enabled:boolean; status:string; lastError:string|null; hasSecret:boolean; secretHint:string|null}[]).map(it=>(
            <div key={it.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-[13px] font-bold">{it.title} <span className="font-mono text-[11px]">/{it.code}</span> · {it.category} · {it.environment}</p><p className="text-[11px] text-[var(--kv-muted)]">وضعیت: {it.status} · secret: {it.hasSecret ? `دارد (${it.secretHint})` : "ندارد"} · {it.lastError ?? "بدون خطا"}</p></div>
                <div className="flex gap-2"><Btn size="sm" variant="soft" onClick={()=>void test(it.id)}>تست اتصال</Btn><Btn size="sm" variant="ghost" onClick={()=>void openLogs(it.id)}>لاگ‌ها</Btn></div>
              </div>
              {logs[it.id] && <div className="mt-3 overflow-x-auto"><table className="kv-table min-w-[700px] text-xs"><thead><tr><th>زمان</th><th>action</th><th>status</th><th>attempt</th><th>http</th></tr></thead><tbody>
                {(logs[it.id] as {id:string; created_at:string; action:string; status:string; attempt:number; http_status:number|null}[]).slice(0,20).map(l=>(
                  <tr key={l.id}><td className="tabular-nums">{new Date(l.created_at).toLocaleString("fa-IR")}</td><td>{l.action}</td><td>{l.status}</td><td>{l.attempt}</td><td>{l.http_status ?? "—"}</td></tr>
                ))}
              </tbody></table></div>}
            </div>
          ))}
          {items.length===0 && <Empty title="اتصالی نیست" desc="اتصال پرداخت/پیامک/لجستیک را با secret رمزگذاری‌شده ثبت کنید." />}
        </div>
      </Card>
    </div>
  );
}
