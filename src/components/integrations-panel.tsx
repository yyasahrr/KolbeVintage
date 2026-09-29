import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cable, CheckCircle2, KeyRound, Plug, RefreshCw, RotateCcw, Settings2 } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Select, Textarea } from "./primitives";
import { integrationsApi } from "../data/api";
import { formatPersianDateTime } from "../data/persian-date";
import {
  INTEGRATION_ACTION_LABEL, INTEGRATION_CATEGORIES, INTEGRATION_CATEGORY_LABEL, INTEGRATION_ENVIRONMENT_LABEL,
  INTEGRATION_LOG_STATUS_LABEL, INTEGRATION_STATUS_LABEL, normalizedProvider, PROVIDER_PRESETS, providerPreset, labelOf,
  type IntegrationLog, type IntegrationView, type ProviderField, type ProviderPreset,
} from "../data/contracts";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

const chip = (tone: "ok" | "warn" | "bad" | "muted") => ({
  ok: "bg-[#3E6B4A]/12 text-[#31603D]",
  warn: "bg-[#C1613B]/12 text-[#A24E2C]",
  bad: "bg-red-500/12 text-red-700",
  muted: "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]",
}[tone]);

/**
 * Integration Center — provider-agnostic connections with real test calls and real logs.
 * Secrets are never displayed: the server only ever returns `hasSecret` + `secretHint`.
 */
export function IntegrationsPanel() {
  const [items, setItems] = useState<IntegrationView[] | null>(null);
  const [logs, setLogs] = useState<Record<string, IntegrationLog[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    code: "zibal", title: "درگاه پرداخت زیبال", category: "payment" as IntegrationView["category"],
    provider: "zibal", environment: "test" as IntegrationView["environment"], enabled: false,
    secret: "", config: {} as Record<string, string>, extra: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try { const res = await integrationsApi.list(); setItems(res.items); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری اتصال‌ها"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const preset: ProviderPreset | undefined = providerPreset(form.provider);
  const fields: ProviderField[] = preset?.fields ?? [{ key: "testUrl", label: "نشانی آزمایش اتصال", kind: "url" }];

  const applyPreset = (provider: string) => {
    const next = providerPreset(provider);
    setForm((current) => ({
      ...current, provider,
      category: next?.category ?? current.category,
      title: next?.title ?? current.title,
    }));
  };

  const create = async () => {
    try {
      setBusy(true); setError(null);
      const config: Record<string, unknown> = { ...form.config };
      if (form.extra.trim()) { try { Object.assign(config, JSON.parse(form.extra)); } catch { throw new Error("JSON پیشرفته معتبر نیست."); } }
      await integrationsApi.create({
        code: form.code.trim(), title: form.title.trim(), category: form.category, provider: form.provider,
        environment: form.environment, enabled: form.enabled, config,
        ...(form.secret ? { secret: form.secret } : {}),
      });
      setNotice("اتصال ساخته شد؛ کلید یا رمز ذخیره‌شده هرگز از سرور بازگردانده نمی‌شود.");
      setForm({ ...form, code: "", title: "", secret: "", config: {}, extra: "" });
      setCreateOpen(false);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت اتصال"); }
    finally { setBusy(false); }
  };

  const test = async (id: string) => {
    try {
      setBusy(true); setError(null);
      const result = await integrationsApi.test(id);
      setNotice(result.status === "success"
        ? `آزمایش اتصال موفق بود${result.httpStatus ? ` (پاسخ HTTP ${fa(result.httpStatus)})` : ""}.`
        : `آزمایش اتصال ناموفق بود${result.error ? `: ${result.error}` : ""} — تلاش شماره ${fa(result.attempt)}.`);
      await load();
      const list = await integrationsApi.logs(id);
      setLogs((current) => ({ ...current, [id]: list.items }));
      setOpenLogs(id);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در آزمایش اتصال"); }
    finally { setBusy(false); }
  };

  const openLogList = async (id: string) => {
    try {
      const list = await integrationsApi.logs(id);
      setLogs((current) => ({ ...current, [id]: list.items }));
      setOpenLogs(openLogs === id ? null : id);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری گزارش‌ها"); }
  };

  const toggleEnabled = async (item: IntegrationView) => {
    try {
      setBusy(true); setError(null);
      await integrationsApi.update(item.id, { enabled: !item.enabled });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در تغییر وضعیت اتصال"); }
    finally { setBusy(false); }
  };

  /** Corrects row labels AFTER hooks so hook order is never conditional. */
  const statusTone = (status: string) => status === "connected" ? "ok" : status === "error" ? "bad" : "muted";

  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-[14px] font-extrabold"><Cable size={15} />مرکز اتصال‌ها</p>
          <p className="mt-1 text-[12px] text-[var(--kv-muted)]">اتصال به درگاه پرداخت، پیامک، حمل‌ونقل، بازارچه، مالی، مدیریت ارتباط با مشتری و اتوماسیون.</p>
        </div>
        <span className="flex-1" />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
        <Btn variant="accent" size="sm" icon={<Plug size={14} />} onClick={() => setCreateOpen((v) => !v)}>اتصال جدید</Btn>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {notice && <p role="status" className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-[12.5px] font-semibold">{notice}</p>}

      {createOpen && (
        <Card className="p-4">
          <p className="text-[13px] font-bold">اتصال جدید</p>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="نام سرویس" hint="برای نمایش در همین صفحه">
              <Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} placeholder="درگاه پرداخت زیبال" />
            </Field>
            <Field label="دسته">
              <Select
                options={INTEGRATION_CATEGORIES.map((category) => INTEGRATION_CATEGORY_LABEL[category]!)}
                value={INTEGRATION_CATEGORY_LABEL[form.category]!}
                onChange={(label) => {
                  const entry = INTEGRATION_CATEGORIES.find((category) => INTEGRATION_CATEGORY_LABEL[category] === label);
                  if (entry) setForm({ ...form, category: entry });
                }}
              />
            </Field>
            <Field label="ارائه‌دهنده">
              <Select
                options={Object.keys(PROVIDER_PRESETS).map((key) => normalizedProvider(key))}
                value={normalizedProvider(form.provider)}
                onChange={(label) => {
                  const entry = Object.keys(PROVIDER_PRESETS).find((key) => normalizedProvider(key) === label);
                  if (entry) applyPreset(entry);
                }}
              />
            </Field>
            <Field label="محیط">
              <Select
                options={[INTEGRATION_ENVIRONMENT_LABEL.test!, INTEGRATION_ENVIRONMENT_LABEL.production!]}
                value={INTEGRATION_ENVIRONMENT_LABEL[form.environment]}
                onChange={(label) => setForm({ ...form, environment: label === INTEGRATION_ENVIRONMENT_LABEL.production ? "production" : "test" })}
              />
            </Field>
            <Field label="کد یکتا (لاتین)" hint="حروف کوچک، عدد، - و _">
              <Input value={form.code} onChange={(v) => setForm({ ...form, code: v.toLowerCase() })} placeholder="zibal" />
            </Field>
            <Field label="کلید/رمز (اختیاری)" hint="ذخیره‌شده و رمزنگاری می‌شود؛ دیگر هرگز نمایش داده نمی‌شود">
              <Input type="password" value={form.secret} onChange={(v) => setForm({ ...form, secret: v })} placeholder="••••••••" />
            </Field>
            {fields.map((field) => (
              <Field key={field.key} label={field.label}>
                <Input value={form.config[field.key] ?? ""} onChange={(v) => setForm({ ...form, config: { ...form.config, [field.key]: v } })} placeholder={field.hint ?? ""} />
              </Field>
            ))}
            <Field label="فعال در ابتدا">
              <Select options={["خیر", "بله"]} value={form.enabled ? "بله" : "خیر"} onChange={(label) => setForm({ ...form, enabled: label === "بله" })} />
            </Field>
            <div className="md:col-span-3">
              <Field label="تنظیمات پیشرفته (JSON)" hint="فقط برای پارامترهای خاص ارائه‌دهنده">
                <Textarea rows={2} value={form.extra} onChange={(v) => setForm({ ...form, extra: v })} placeholder='مثلاً {"terminalId":"123"}' />
              </Field>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Btn variant="accent" size="sm" disabled={busy || form.code.trim().length < 2 || form.title.trim().length < 2} onClick={() => void create()}>ساخت اتصال</Btn>
            <Btn variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>انصراف</Btn>
          </div>
          <p className="mt-2 text-[11px] text-[var(--kv-muted)]">
            فرم‌های پیش‌تنظیم برای زیبال، نکست‌پی، ملی‌پیامک، n8n، S3، ایمیل، ERP/انبار و مدیریت ارتباط با مشتری آماده است؛
            کلید و رمز فقط رمزنگاری‌شده روی سرور می‌ماند.
          </p>
        </Card>
      )}

      {!items ? <LoadingState label="در حال بارگذاری اتصال‌ها…" /> : items.length === 0 ? (
        <Card><Empty title="اتصالی ثبت نشده است" desc="در حالت عملیاتی هیچ اتصالی به‌صورت پیش‌فرض ساخته نمی‌شود؛ نخستین اتصال را از دکمه «اتصال جدید» بسازید." /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13.5px] font-extrabold">
                    {item.title}
                    <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${chip(statusTone(item.status) as "ok" | "warn" | "bad" | "muted")}`}>
                      {labelOf(INTEGRATION_STATUS_LABEL, item.status)}
                    </span>
                    {item.enabled ? <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px]">فعال</span> : <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px] text-[var(--kv-muted)]">غیرفعال</span>}
                  </p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {labelOf(INTEGRATION_CATEGORY_LABEL, item.category)} · {normalizedProvider(item.provider)} · {labelOf(INTEGRATION_ENVIRONMENT_LABEL, item.environment)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn variant="soft" size="sm" disabled={busy} icon={<Plug size={13} />} onClick={() => void test(item.id)}>تست اتصال</Btn>
                  <Btn variant="ghost" size="sm" onClick={() => void openLogList(item.id)}>گزارش‌ها</Btn>
                  <Btn variant="ghost" size="sm" disabled={busy} onClick={() => void toggleEnabled(item)}>{item.enabled ? "غیرفعال‌سازی" : "فعال‌سازی"}</Btn>
                </div>
              </div>

              <div className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-2">
                <p className="flex items-center gap-1.5"><CheckCircle2 size={12} className="text-[#3E6B4A]" />آخرین اتصال موفق: {item.lastSuccessAt ? formatPersianDateTime(item.lastSuccessAt) : "ثبت نشده"}</p>
                <p className="flex items-center gap-1.5 text-[var(--kv-muted)]"><AlertTriangle size={12} className={item.lastError ? "text-red-600" : ""} />آخرین خطا: {item.lastError ?? "بدون خطا"}{item.lastErrorAt ? ` (${formatPersianDateTime(item.lastErrorAt)})` : ""}</p>
                <p className="flex items-center gap-1.5"><KeyRound size={12} />کلید/رمز: {item.hasSecret ? `تنظیم شده${item.secretHint ? ` (${item.secretHint})` : ""}` : "تنظیم نشده"}</p>
                <p className="flex items-center gap-1.5 text-[var(--kv-muted)]">وضعیت همگام‌سازی: {item.syncStatus === "not_configured" ? "پیکربندی نشده" : item.syncStatus}</p>
              </div>

              {openLogs === item.id && (
                <div className="mt-3 rounded-[12px] border border-[var(--kv-line)]">
                  <p className="px-3 py-2 text-[12px] font-bold">گزارش تلاش‌ها</p>
                  {(logs[item.id] ?? []).length === 0 ? (
                    <p className="px-3 pb-3 text-[11.5px] text-[var(--kv-muted)]">گزارشی ثبت نشده است.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="kv-table min-w-[620px] text-[11.5px]">
                        <thead><tr><th>زمان</th><th>کار</th><th>وضعیت</th><th>پاسخ HTTP</th><th>تلاش</th></tr></thead>
                        <tbody>
                          {(logs[item.id] ?? []).map((log) => (
                            <tr key={log.id}>
                              <td className="tabular-nums">{formatPersianDateTime(log.createdAt)}</td>
                              <td>{labelOf(INTEGRATION_ACTION_LABEL, log.action, log.action)}</td>
                              <td>{labelOf(INTEGRATION_LOG_STATUS_LABEL, log.status, log.status)}</td>
                              <td className="tabular-nums">{log.httpStatus === null ? "—" : fa(log.httpStatus)}</td>
                              <td className="tabular-nums">{fa(log.attempt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              <button onClick={() => setAdvanced(advanced === item.id ? null : item.id)} className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-bold text-[var(--kv-muted)] hover:text-[var(--kv-text)]">
                <Settings2 size={12} />{advanced === item.id ? "بستن تنظیمات پیشرفته" : "تنظیمات پیشرفته"}
              </button>
              {advanced === item.id && (
                <div className="mt-2 rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[11px]">
                  <p className="font-bold">کد یکتا: <span className="font-mono" dir="ltr">{item.code}</span></p>
                  <p className="mt-1.5 font-bold">پیکربندی (JSON):</p>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--kv-surface)] p-2 font-mono text-[10.5px]" dir="ltr">{JSON.stringify(item.config, null, 2)}</pre>
                  {item.webhookUrl && <p className="mt-1.5 font-mono text-[10.5px]" dir="ltr">{item.webhookUrl}</p>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {items && items.some((item) => item.status === "error") && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]"><RotateCcw size={12} />برای اتصال‌های خطادار، پس از اصلاح پیکربندی دوباره «تست اتصال» را بزنید تا شمارش تلاش و آخرین وضعیت به‌روز شود.</p>
      )}
    </div>
  );
}
