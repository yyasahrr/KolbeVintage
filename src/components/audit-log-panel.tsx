import { useEffect, useState } from "react";
import { Card, LoadingState, ErrorState, Empty, SearchBox, Input, Btn } from "../components/primitives";
import { financeApi } from "../data/api";

export function AuditLogPanel() {
  const [items, setItems] = useState<unknown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState({ search: "", resourceType: "", actor: "" });
  const load = async () => {
    setError(null);
    try {
      const r = await financeApi.auditLogs({ search: q.search || undefined, resourceType: q.resourceType || undefined, actor: q.actor || undefined } as Record<string,string>);
      setItems((r as { items: unknown[] }).items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  };
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="در حال بارگذاری گزارش حسابرسی…" />;
  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap gap-2">
        <SearchBox value={q.search} onChange={(v) => setQ({ ...q, search: v })} placeholder="جست‌وجو action / resource" />
        <Input value={q.resourceType} onChange={(v) => setQ({ ...q, resourceType: v })} placeholder="resourceType" />
        <Input value={q.actor} onChange={(v) => setQ({ ...q, actor: v })} placeholder="actor" />
        <Btn variant="soft" size="sm" onClick={load}>اعمال فیلتر</Btn>
      </div>
      {!items.length ? <Empty title="رویدادی یافت نشد" desc="فیلترها را تغییر دهید." /> : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[1000px] text-xs">
              <thead><tr><th>زمان</th><th>actor</th><th>action</th><th>resource</th><th>IP</th><th>old → new</th></tr></thead>
              <tbody>
                {(items as { id: string; actor_name: string | null; actor_id: string | null; action: string; resource_type: string; resource_id: string; ip: string | null; created_at: string; old_value: unknown; new_value: unknown }[]).map((a) => (
                  <tr key={a.id}>
                    <td className="tabular-nums whitespace-nowrap">{new Date(a.created_at).toLocaleString("fa-IR")}</td>
                    <td>{a.actor_name ?? a.actor_id?.slice(0,8) ?? "system"}</td>
                    <td className="font-mono text-[11px]">{a.action}</td>
                    <td className="font-mono text-[11px]">{a.resource_type}:{a.resource_id.slice(0,8)}</td>
                    <td className="font-mono">{a.ip ?? "-"}</td>
                    <td className="max-w-[260px] truncate text-[11px]">
                      <span className="text-[var(--kv-muted)]">{JSON.stringify(a.old_value)?.slice(0,80)}</span>
                      <span className="mx-1">→</span>
                      <span className="text-[var(--kv-ink)]">{JSON.stringify(a.new_value)?.slice(0,80)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="text-xs text-[var(--kv-muted)]">Audit Log immutable است؛ تمام تغییرات حساس با actor, IP, timestamp, previous/new value ثبت می‌شود.</p>
    </div>
  );
}
