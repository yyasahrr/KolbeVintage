import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Cable, Plug, RefreshCw, Send, Waypoints } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDateTime } from "../data/persian-date";
import { automationApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented, Select, Status, Switch, Textarea } from "./primitives";

const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));

type Tab = "overview" | "workflows" | "events" | "errors" | "readiness";
const TABS: { v: Tab; label: string }[] = [
  { v: "overview", label: "نمای کلی" },
  { v: "workflows", label: "جریان‌های کاری" },
  { v: "events", label: "رویدادها و صف" },
  { v: "errors", label: "خطاها و تلاش مجدد" },
  { v: "readiness", label: "آمادگی اتصال" },
];

type Workflow = {
  id: string; code: string; title: string; eventPatterns: string[]; enabled: boolean; hmacEnabled: boolean;
  timeoutMs: number; maxAttempts: number; backoffSeconds: number; maxEventsPerMinute: number;
  integrationId: string | null; targetUrl: string | null; integrationTitle: string | null;
  lastSuccessAt: string | null; lastFailureAt: string | null; lastError: string | null;
};

const emptyWorkflow = {
  open: false, code: "", title: "", eventPatterns: "order.paid\ncart.abandoned",
  integrationId: "", targetUrl: "", enabled: true, hmacEnabled: true,
  timeoutMs: 5000, maxAttempts: 5, backoffSeconds: 30, maxEventsPerMinute: 120,
};

/** Automation center (items 85-89): connection state, workflows, event stream with
 *  retry/error logs and the readiness report. Secrets never reach the browser. */
export function AutomationCenter({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [readiness, setReadiness] = useState<{ ok: boolean; checks: { item: string; ok: boolean; note: string }[] } | null>(null);
  const [draft, setDraft] = useState({ ...emptyWorkflow });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [o, e, r] = await Promise.all([automationApi.overview(), automationApi.events({ limit: 50 }), automationApi.readiness()]);
      setOverview(o); setEvents(e.items); setReadiness(r);
    } catch (err) { setError(err instanceof Error ? err.message : "خطا در بارگذاری مرکز اتوماسیون"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); flash(`${label} انجام شد`); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  if (loading && !overview) return <LoadingState label="در حال بارگذاری مرکز اتوماسیون…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const counts = (overview?.counts ?? {}) as { deliveries?: Record<string, string>; events?: Record<string, string>; workflows?: number; errorLogs?: number };
  const connections = (overview?.connections ?? []) as Record<string, unknown>[];
  const workflows = (overview?.workflows ?? []) as unknown as Workflow[];
  const errors = (overview?.errors ?? []) as Record<string, unknown>[];

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4"><Segmented options={TABS} value={tab} onChange={setTab} /></Card>

      {tab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["تحویل موفق", num(counts.deliveries?.success)],
              ["در انتظار", num(counts.deliveries?.pending)],
              ["ناموفق", num(counts.deliveries?.failure)],
              ["رهاشده (dead)", num(counts.deliveries?.dead)],
            ].map(([label, value]) => (
              <Card key={label} className="p-4">
                <p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p>
                <p className="mt-1 text-[20px] font-extrabold tabular-nums">{value}</p>
              </Card>
            ))}
          </div>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Cable size={16} />اتصال‌ها ({num(connections.length)})</div>
            <div className="grid gap-2 md:grid-cols-2">
              {connections.map((connection) => (
                <div key={String(connection.id)} className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12.5px]">
                  <div className="flex items-center justify-between gap-2">
                    <b>{text(connection.title)}</b>
                    <Status value={String(connection.enabled) === "true" ? "متصل" : text(connection.status)} />
                  </div>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {text(connection.provider)} · لاگ ۲۴ ساعت: {num(connection.logs24h)} · آخرین موفقیت {stamp(connection.lastSuccessAt)}
                  </p>
                  {connection.lastError ? <p className="mt-1 text-[11.5px] text-[var(--kv-danger)]">{text(connection.lastError)}</p> : null}
                  <p className="mt-1 text-[11px] text-[var(--kv-muted)]">آدرس و کلید رمزنگاری‌شده فقط در سرور نگهداری می‌شود.</p>
                </div>
              ))}
              {!connections.length && <Empty title="اتصالی ثبت نشده" desc="در بخش یکپارچه‌سازی‌ها یک اتصال CRM/n8n بسازید." />}
            </div>
          </Card>
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Waypoints size={16} />صف رویداد</div>
            <div className="grid gap-3 sm:grid-cols-4">
              {[["در انتظار", counts.events?.pending], ["تحویل‌شده", counts.events?.delivered], ["با خطا", counts.events?.failed], ["۲۴ ساعت اخیر", counts.events?.last_24h]]
                .map(([label, value]) => (
                  <div key={label as string} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2">
                    <p className="text-[11px] text-[var(--kv-muted)]">{label as string}</p>
                    <p className="text-[14px] font-extrabold tabular-nums">{num(value)}</p>
                  </div>
                ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Btn variant="soft" size="sm" icon={<Send size={14} />} onClick={() => void run("ارسال دسته‌ای رویدادها", () => automationApi.dispatch(50))}>ارسال فوری صف</Btn>
              <Btn variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
            </div>
          </Card>
        </div>
      )}

      {tab === "workflows" && (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] font-extrabold"><Plug size={16} />جریان‌های کاری n8n ({num(workflows.length)})</div>
            <Btn variant="soft" size="sm" onClick={() => setDraft({ ...emptyWorkflow, open: true })}>جریان جدید</Btn>
          </div>
          <div className="space-y-3">
            {workflows.map((workflow) => (
              <div key={workflow.id} className="rounded-[13px] border border-[var(--kv-line)] p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-bold">{workflow.title} <span className="text-[11px] text-[var(--kv-muted)]">({workflow.code})</span></p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      رویدادها: {workflow.eventPatterns.join("، ")} · مقصد: {workflow.integrationTitle ?? workflow.targetUrl ?? "—"} ·
                      HMAC {workflow.hmacEnabled ? "فعال" : "غیرفعال"} · تلاش ≤{workflow.maxAttempts} · timeout {workflow.timeoutMs}ms
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      آخرین موفقیت {stamp(workflow.lastSuccessAt)} · آخرین خطا {stamp(workflow.lastFailureAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch on={workflow.enabled} onToggle={() => void run("تغییر وضعیت جریان", () => automationApi.updateSubscription(workflow.id, { enabled: !workflow.enabled }))} />
                    <Btn variant="soft" size="sm" onClick={() => void run("تست اتصال", () => automationApi.testSubscription(workflow.id))}>تست اتصال</Btn>
                  </div>
                </div>
                {workflow.lastError ? <p className="mt-2 text-[11.5px] text-[var(--kv-danger)]">آخرین خطا: {workflow.lastError}</p> : null}
              </div>
            ))}
            {!workflows.length && <Empty title="جریانی ثبت نشده" desc="یک جریان بسازید و الگوی رویداد (مثلاً order.paid یا cart.*) را تعیین کنید." />}
          </div>
        </Card>
      )}

      {tab === "events" && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold">آخرین رویدادهای صف (outbox)</div>
          <div className="kv-scroll overflow-x-auto">
            <table className="w-full min-w-[760px] text-right text-[12.5px]">
              <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">
                <th className="pb-2">رویداد</th><th className="pb-2">شناسه</th><th className="pb-2">موجودیت</th><th className="pb-2">زمان</th><th className="pb-2">وضعیت</th><th className="pb-2"></th>
              </tr></thead>
              <tbody className="divide-y divide-[var(--kv-line)]">
                {events.map((event) => (
                  <tr key={String(event.id)}>
                    <td className="py-2 font-semibold">{text(event.event_type)}</td>
                    <td className="py-2 text-[11px] text-[var(--kv-muted)]"><code>{String(event.id).slice(0, 8)}</code></td>
                    <td className="py-2 text-[11.5px]">{text(event.aggregate_type)}</td>
                    <td className="py-2 text-[11.5px]">{stamp(event.occurred_at ?? event.created_at)}</td>
                    <td className="py-2">
                      {event.delivered_at ? <Status value="تحویل شد" />
                        : event.last_error ? <Status value="خطا" /> : <Status value="در انتظار" />}
                    </td>
                    <td className="py-2"><Btn variant="soft" size="sm" onClick={() => void run("بازپخش رویداد", () => automationApi.replay(String(event.id)))}>بازپخش</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!events.length && <Empty title="رویدادی در صف نیست" desc="با ثبت سفارش یا رویدادهای CRM، صف پر می‌شود." />}
          </div>
        </Card>
      )}

      {tab === "errors" && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><AlertTriangle size={16} />خطاها و تلاش مجدد</div>
          <div className="space-y-2">
            {errors.map((row) => (
              <div key={String(row.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-3 text-[12px]">
                <div>
                  <p className="font-bold">{text(row.event_type)} → {text(row.subscription_title)}</p>
                  <p className="text-[11.5px] text-[var(--kv-muted)]">
                    تلاش {num(row.attempt)} · HTTP {text(row.http_status)} · {stamp(row.created_at)} · وضعیت {text(row.status)}
                  </p>
                  <p className="text-[11.5px] text-[var(--kv-danger)]">{text(row.error)}</p>
                </div>
                <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />}
                  onClick={() => void run("تلاش مجدد", () => automationApi.retryDelivery(String(row.id)))}>تلاش مجدد</Btn>
              </div>
            ))}
            {!errors.length && <Empty title="خطایی ثبت نشده" desc="خطاهای تحویل با backoff نمایی تا سقف تلاش دوباره ارسال می‌شوند." />}
          </div>
        </Card>
      )}

      {tab === "readiness" && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold">
            آمادگی اتوماسیون {readiness?.ok ? <Status value="فعال" /> : <Status value="در انتظار" />}
          </div>
          <div className="space-y-2">
            {(readiness?.checks ?? []).map((check) => (
              <div key={check.item} className="flex items-start gap-2 border-b border-dashed border-[var(--kv-line)] pb-2 text-[12.5px]">
                {check.ok ? <Check size={15} className="mt-0.5 text-[var(--kv-success)]" /> : <AlertTriangle size={15} className="mt-0.5 text-[var(--kv-danger)]" />}
                <div><b>{check.item}</b><p className="text-[11.5px] text-[var(--kv-muted)]">{check.note}</p></div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11.5px] text-[var(--kv-muted)]">
            قرارداد رویداد: eventId، eventType، schemaVersion، occurredAt، entity، payload و امضای HMAC با هدر
            x-kolbe-signature؛ جلوگیری از تکرار با x-kolbe-delivery-id و محافظت بازپخش با مهر زمانی (۳۰۰ ثانیه).
          </p>
        </Card>
      )}

      <Modal open={draft.open} onClose={() => setDraft({ ...draft, open: false })} title="جریان کاری جدید">
        <div className="space-y-3">
          <Field label="کد"><Input value={draft.code} onChange={(v) => setDraft({ ...draft, code: v })} placeholder="n8n-orders" /></Field>
          <Field label="عنوان"><Input value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} /></Field>
          <Field label="الگوهای رویداد (هر خط یک الگو)"><Textarea rows={3} value={draft.eventPatterns} onChange={(v) => setDraft({ ...draft, eventPatterns: v })} /></Field>
          <Field label="یا آدرس مقصد (n8n webhook)"><Input value={draft.targetUrl} onChange={(v) => setDraft({ ...draft, targetUrl: v })} placeholder="https://n8n.example/webhook/…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="timeout (ms)"><Input value={String(draft.timeoutMs)} onChange={(v) => setDraft({ ...draft, timeoutMs: Number(v.replace(/\D/g, "")) || 5000 })} /></Field>
            <Field label="حداکثر تلاش"><Input value={String(draft.maxAttempts)} onChange={(v) => setDraft({ ...draft, maxAttempts: Number(v.replace(/\D/g, "")) || 5 })} /></Field>
            <Field label="backoff (ثانیه)"><Input value={String(draft.backoffSeconds)} onChange={(v) => setDraft({ ...draft, backoffSeconds: Number(v.replace(/\D/g, "")) || 30 })} /></Field>
            <Field label="سقف رویداد در دقیقه"><Input value={String(draft.maxEventsPerMinute)} onChange={(v) => setDraft({ ...draft, maxEventsPerMinute: Number(v.replace(/\D/g, "")) || 120 })} /></Field>
          </div>
          <Select options={["hmac-on", "hmac-off"]} value={draft.hmacEnabled ? "hmac-on" : "hmac-off"}
            onChange={(v) => setDraft({ ...draft, hmacEnabled: v === "hmac-on" })} />
          <Btn variant="accent" className="w-full" disabled={!draft.code || !draft.title || (!draft.targetUrl && !draft.integrationId)}
            onClick={() => void run("ساخت جریان", async () => {
              await automationApi.createSubscription({
                code: draft.code, title: draft.title,
                eventPatterns: draft.eventPatterns.split("\n").map((line) => line.trim()).filter(Boolean),
                targetUrl: draft.targetUrl || null, enabled: draft.enabled, hmacEnabled: draft.hmacEnabled,
                timeoutMs: draft.timeoutMs, maxAttempts: draft.maxAttempts, backoffSeconds: draft.backoffSeconds,
                maxEventsPerMinute: draft.maxEventsPerMinute,
              });
              setDraft({ ...emptyWorkflow });
            })}>ثبت جریان</Btn>
        </div>
      </Modal>
    </div>
  );
}
