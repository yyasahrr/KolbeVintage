import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty } from "../components/primitives";
import { notificationsApi } from "../data/api";

export function NotificationsPanel() {
  const [items, setItems] = useState<unknown[]|null>(null);
  const [routes, setRoutes] = useState<unknown[]|null>(null);
  const [error, setError] = useState<string|null>(null);
  const load = async () => {
    setError(null);
    try {

      const [n, r] = await Promise.all([
        notificationsApi.list() as Promise<{items:unknown[]}>,
        notificationsApi.routes().catch(()=>({items:[] as Record<string,unknown>[]})),
      ]);
      setItems(n.items); setRoutes(r.items);
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const markAll = async () => {
    try { await notificationsApi.readAll(); await load(); } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!items) return <LoadingState label="در حال بارگذاری اعلان‌ها…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold">صندوق اعلان‌ها (In-App) — outbox + notification_routes</p>
        <Btn size="sm" variant="soft" onClick={()=>void markAll()}>خواندن همه</Btn>
      </div>
      <Card className="overflow-hidden">
        <div className="divide-y divide-[var(--kv-line)]">
          {(items as {id:string; title:string; body:string; event_type:string; channels:string[]; read_at:string|null; created_at:string}[]).slice(0,50).map(n=>(
            <div key={n.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0"><p className="text-[13px] font-bold">{n.title} <span className="text-[11px] text-[var(--kv-muted)]">#{n.event_type}</span></p><p className="text-xs text-[var(--kv-muted)] leading-6">{n.body}</p><p className="text-[11px] text-[var(--kv-faint)] tabular-nums">{new Date(n.created_at).toLocaleString("fa-IR")} · {n.channels.join("، ")}</p></div>
              <span className={"rounded-full px-2 py-0.5 text-[11px] font-bold " + (n.read_at ? "bg-[var(--kv-surface-2)]" : "bg-[var(--kv-accent)] text-white")}>{n.read_at ? "خوانده" : "جدید"}</span>
            </div>
          ))}
          {items.length===0 && <Empty title="اعلانی نیست" desc="رویدادهای سفارش/پرداخت/تیکت اعلان تولید می‌کنند (outbox_events)." />}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">مسیرهای اعلان (notification_routes) — کدام نقش‌ها با کدام کانال (in_app/sms/email) و priority</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[700px] text-xs">
            <thead><tr><th>event_type</th><th>roles</th><th>channels</th><th>priority</th><th>active</th></tr></thead>
            <tbody>
              {(routes ?? []).length ? (routes as {id:string; event_type:string; roles:string[]; channels:string[]; priority:string; active:boolean}[]).map(r=>(
                <tr key={r.id}><td className="font-mono">{r.event_type}</td><td>{r.roles.join("، ")}</td><td>{r.channels.join("، ")}</td><td>{r.priority}</td><td>{r.active ? "بله" : "خیر"}</td></tr>
              )) : <tr><td colSpan={5} className="text-center text-[var(--kv-muted)]">مسیری تعریف نشده</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-[11px] text-[var(--kv-muted)]">ویرایش مسیر: PATCH /admin/notification-routes/:id (roles/priority/channels/active) با حسابرسی کامل.</p>
      </Card>
    </div>
  );
}
