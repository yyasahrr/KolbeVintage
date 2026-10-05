import { useCallback, useEffect, useState } from "react";
import { Filter, Plus, RefreshCw, Send, Sparkles, Tags } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";
import { crmIntelApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented, Select, Status, Textarea, WorkspaceModal } from "./primitives";

const day = (value: unknown) => (value ? formatPersianDate(String(value)) : "—");
const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

type Tab = "labels" | "rules" | "segments" | "contacts" | "campaign" | "events";
const TABS: { v: Tab; label: string }[] = [
  { v: "labels", label: "برچسب‌ها" },
  { v: "rules", label: "قواعد هوشمند" },
  { v: "segments", label: "سگمنت‌ها" },
  { v: "campaign", label: "کمپین هدفمند" },
  { v: "events", label: "رویدادهای پیش‌رو" },
];

type Condition = { field: string; op: string; value: string };

const FIELD_FA: Record<string,string> = {
  order_count:"تعداد خرید", total_spent:"مجموع خرید", average_order:"میانگین مبلغ سفارش", max_order:"بیشترین مبلغ سفارش",
  days_since_last_order:"روز از آخرین خرید", register_days:"روز از ثبت‌نام", cancelled_orders:"سفارش لغوشده",
  returns_count:"تعداد مرجوعی", failed_payments:"پرداخت ناموفق", coupons_used:"تعداد کوپن استفاده‌شده",
  coupons_percent:"درصد خرید با کوپن", membership_status:"وضعیت عضویت", membership_days_left:"روز تا پایان عضویت",
  plan_code:"پلن عضویت", plan_tier:"سطح پلن", actor_type:"نوع مخاطب", city:"شهر", vip_level:"سطح VIP",
  category_interest:"علاقه‌مندی دسته‌بندی", color_interest:"علاقه‌مندی رنگ", size_interest:"علاقه‌مندی سایز",
};
const OP_FA: Record<string,string> = {
  "=":"برابر است با", "!=":"برابر نیست با", ">":"بیشتر از", ">=":"بیشتر یا مساوی",
  "<":"کمتر از", "<=":"کمتر یا مساوی", in:"یکی از", not_in:"هیچ‌کدام از", contains:"شامل می‌شود",
};
const KIND_FA: Record<string,string> = { manual:"دستی", behavioral:"رفتاری", dynamic:"پویا" };
const MATCH_FA: Record<string,string> = { all:"همه شرط‌ها", any:"حداقل یک شرط" };

/** CRM center (items 20-24 and 95-100): labels, server-side rule engine, dynamic
 *  segments, behavioural analytics, timeline and targeted SMS — all server-owned. */
export function CrmCenter({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("labels");
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, unknown>[]>([]);
  const [rules, setRules] = useState<Record<string, unknown>[]>([]);
  const [segments, setSegments] = useState<Record<string, unknown>[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [operators, setOperators] = useState<string[]>(["=", "!=", ">", ">=", "<", "<=", "in", "contains"]);
  const [loading, setLoading] = useState(true);
  const [ruleDraft, setRuleDraft] = useState({ open: false, code: "", title: "", labelCode: "", matchMode: "all", status: "test", requiresApproval: true, conditions: [] as Condition[] });
  const [segmentDraft, setSegmentDraft] = useState({ open: false, code: "", title: "", matchMode: "all", refreshIntervalMinutes: 60, conditions: [] as Condition[] });
  const [dryRun, setDryRun] = useState<{ matchCount: number; sample: Record<string, unknown>[] } | null>(null);
  const [campaign, setCampaign] = useState({ title: "", message: "", segmentId: "", labelCode: "", send: false });
  const [cap, setCap] = useState({ maxPerWindow: 2, windowDays: 7 });
  type CampaignPreview = Awaited<ReturnType<typeof crmIntelApi.createCampaign>>;
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [membersOpen, setMembersOpen] = useState<{ title: string; items: Record<string, unknown>[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [l, r, s, f, ev] = await Promise.all([
        crmIntelApi.labels(), crmIntelApi.rules(), crmIntelApi.segments(),
        crmIntelApi.conditionFields(), crmIntelApi.upcomingEvents(40),
      ]);
      setLabels(l.items); setRules(r.items); setSegments(s.items);
      setFields(f.fields); setOperators(f.operators); setEvents(ev.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری CRM"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void crmIntelApi.marketingSettings().then((r) => setCap(r.frequencyCap)).catch(() => undefined); }, []);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); flash(`${label} انجام شد`); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  if (loading && !labels.length) return <LoadingState label="در حال بارگذاری هوش مشتری…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const ConditionEditor = ({ conditions, setConditions }: { conditions: Condition[]; setConditions: (next: Condition[]) => void }) => (
    <div className="space-y-2">
      {conditions.map((condition, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_1fr_auto]">
          <Select options={fields} labels={FIELD_FA} value={condition.field} onChange={(v) => setConditions(conditions.map((c, i) => (i === index ? { ...c, field: v } : c)))} />
          <Select options={operators} labels={OP_FA} value={condition.op} onChange={(v) => setConditions(conditions.map((c, i) => (i === index ? { ...c, op: v } : c)))} />
          <Input value={condition.value} onChange={(v) => setConditions(conditions.map((c, i) => (i === index ? { ...c, value: v } : c)))} placeholder="مقدار" />
          <Btn variant="ghost" size="sm" onClick={() => setConditions(conditions.filter((_, i) => i !== index))}>حذف</Btn>
        </div>
      ))}
      <Btn variant="soft" size="sm" icon={<Plus size={14} />}
        onClick={() => setConditions([...conditions, { field: fields[0] ?? "order_count", op: ">=", value: "1" }])}>افزودن شرط</Btn>
    </div>
  );

  const toPayload = (conditions: Condition[]) => conditions.map((c) => ({
    field: c.field, op: c.op,
    value: /^-?\d+(\.\d+)?$/.test(c.value.trim()) ? Number(c.value) : (c.op === "in" ? c.value.split(",").map((v) => v.trim()) : c.value),
  }));

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4">
        <Segmented options={TABS} value={tab} onChange={setTab} />
      </Card>

      {tab === "labels" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Tags size={16} />برچسب‌های سیستم ({fmtNum(labels.length)})</div>
            <div className="space-y-2">
              {labels.map((label) => (
                <div key={String(label.code)} className="flex items-center justify-between gap-3 rounded-[11px] border border-[var(--kv-line)] px-3 py-2 text-[12.5px]">
                  <span className="flex flex-col">
                    <b>{text(label.title)}</b>
                    <span className="text-[11px] text-[var(--kv-muted)]">{KIND_FA[String(label.kind)] ?? "برچسب CRM"}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {label.is_system ? <Status value="سیستمی" /> : <Status value="سفارشی" />}
                  </span>
                </div>
              ))}
              {!labels.length && <Empty title="برچسبی ثبت نشده" desc="برچسب‌های پایه در مهاجرت ۰۱۷ ثبت می‌شوند." />}
            </div>
          </Card>
          <Card className="h-fit p-5">
            <p className="mb-3 text-[13px] font-extrabold">ساخت برچسب سفارشی</p>
            <LabelForm onDone={(message) => { flash(message); void load(); }} />
          </Card>
        </div>
      )}

      {tab === "rules" && (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-extrabold"><Sparkles size={16} />موتور قواعد سمت سرور</div>
              <Btn variant="soft" size="sm" icon={<Plus size={14} />} onClick={() => setRuleDraft({ ...ruleDraft, open: true })}>قاعده جدید</Btn>
            </div>
            <div className="space-y-3">
              {rules.map((rule) => (
                <div key={String(rule.id)} className="rounded-[13px] border border-[var(--kv-line)] p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[13px] font-bold">{text(rule.title)} → <span className="text-[var(--kv-accent)]">{text(rule.label_title ?? rule.label_code)}</span></p>
                      <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                        {text(rule.status)} · {listOf(rule.conditions).length || (Array.isArray(rule.conditions) ? rule.conditions.length : 0)} شرط ·
                        آخرین اجرا {stamp(rule.last_run_at)} · تطابق {fmtNum(Number(rule.last_match_count ?? 0))}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Btn variant="soft" size="sm" onClick={() => void run("اجرای آزمایشی", async () => {
                        const res = await crmIntelApi.dryRunRule(String(rule.id)); setDryRun(res);
                        flash(res.matchCount ? `این قانون روی ${fmtNum(res.matchCount)} کاربر Match می‌شود.` : "هیچ کاربری تطابق نداشت.");
                      })}>اجرای آزمایشی</Btn>
                      <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />} onClick={() => void run("اعمال قانون", () => crmIntelApi.applyRule(String(rule.id), false))}>اعمال</Btn>
                      <Btn variant="soft" size="sm" onClick={() => void run("تغییر وضعیت", () => crmIntelApi.updateRule(String(rule.id), { status: String(rule.status) === "active" ? "paused" : "active" }))}>
                        {String(rule.status) === "active" ? "توقف" : "فعال‌سازی"}
                      </Btn>
                      <Btn variant="accent" size="sm" disabled={!rule.requires_approval || !!rule.approved_at}
                        onClick={() => void run("تأیید و اعمال", () => crmIntelApi.applyRule(String(rule.id), true))}>تأیید دستی</Btn>
                    </div>
                  </div>
                </div>
              ))}
              {!rules.length && <Empty title="قاعده‌ای ثبت نشده" desc="قواعد پیش‌فرض در مهاجرت ۰۱۷ ساخته می‌شوند." />}
            </div>
          </Card>
          {dryRun && (
            <Card className="p-5">
              <p className="text-[13px] font-extrabold">نتیجه اجرای آزمایشی — {fmtNum(dryRun.matchCount)} کاربر Match شد</p>
              <div className="mt-3 space-y-1.5 text-[12px]">
                {dryRun.sample.map((row) => (
                  <div key={String(row.userId)} className="flex items-center justify-between border-b border-dashed border-[var(--kv-line)] pb-1.5 tabular-nums">
                    <span>{text(row.displayName, "بدون نام")}</span>
                    <span className="text-[var(--kv-muted)]">{text(row.phone)} · {fmtNum(Number(row.orderCount ?? 0))} سفارش · {text(row.daysSinceLastOrder, "—")} روز بی‌فعالیت</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === "segments" && (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-[13px] font-extrabold"><Filter size={16} />سگمنت‌های پویا (خودبه‌روز)</div>
              <Btn variant="soft" size="sm" icon={<Plus size={14} />} onClick={() => setSegmentDraft({ ...segmentDraft, open: true })}>سگمنت جدید</Btn>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {segments.map((segment) => (
                <div key={String(segment.id)} className="rounded-[13px] border border-[var(--kv-line)] p-3.5">
                  <p className="text-[13px] font-bold">{text(segment.title)}</p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {KIND_FA[String(segment.kind)] ?? "پویا"} · اعضا {fmtNum(Number(segment.member_count ?? 0))} · آخرین به‌روزرسانی {stamp(segment.last_refreshed_at)}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />}
                      onClick={() => void run("به‌روزرسانی سگمنت", () => crmIntelApi.refreshSegment(String(segment.id)))}>به‌روزرسانی</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => void crmIntelApi.segmentMembers(String(segment.id)).then((r) => {
                      setMembersOpen({ title: String(segment.title ?? "اعضای گروه"), items: r.items });
                    }).catch((e) => flash(e instanceof Error ? e.message : "خطا"))}>مشاهده اعضا</Btn>
                  </div>
                </div>
              ))}
              {!segments.length && <Empty title="سگمنتی ثبت نشده" desc="سگمنت‌های پیش‌فرض در مهاجرت ۰۱۷ ساخته می‌شوند." />}
            </div>
          </Card>
        </div>
      )}

      {/* Corrective §54/§58: the generic «پروفایل و تایم‌لاین» tab is retired — profile,
          timeline, notes and behavior analysis now live inside each entity's 360.
          The tab key stays legal so stale deep-links land here instead of crashing. */}
      {tab === "contacts" && (
        <Card className="p-6">
          <Empty title="این بخش به پروفایل ۳۶۰° منتقل شد"
            desc="پروفایل، تایم‌لاین، یادداشت‌ها و تحلیل رفتار هر مشتری اکنون داخل پروندهٔ ۳۶۰° همان مشتری است (CRM → مشتریان خرده → پروفایل ۳۶۰°)." />
          <div className="mt-3 text-center"><Btn variant="soft" size="sm" onClick={() => setTab("labels")}>بازگشت به برچسب‌ها</Btn></div>
        </Card>
      )}

      {tab === "campaign" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <p className="mb-3 text-[13px] font-extrabold">کمپین SMS هدفمند (برچسب یا سگمنت)</p>
            <div className="space-y-3">
              <Field label="عنوان"><Input value={campaign.title} onChange={(v) => setCampaign({ ...campaign, title: v })} /></Field>
              <Field label="متن پیام"><Textarea rows={3} value={campaign.message} onChange={(v) => setCampaign({ ...campaign, message: v })} /></Field>
              <Field label="گروه مقصد">
                <Select
                  options={["", ...segments.map((s) => String(s.id))]}
                  labels={Object.fromEntries([["","انتخاب گروه مشتریان"], ...segments.map((s) => [String(s.id), `${text(s.title, "گروه مشتریان")} — ${fmtNum(Number(s.member_count ?? 0))} نفر`])])}
                  value={campaign.segmentId}
                  onChange={(v) => setCampaign({ ...campaign, segmentId: v, labelCode: "" })} />
              </Field>
              <p className="text-[11.5px] text-[var(--kv-muted)]">شناسه فنی گروه‌ها پنهان است؛ گروه را با نام و تعداد اعضا انتخاب کنید.</p>
              <Field label="یا برچسب مقصد">
                <Select options={["", ...labels.map((l) => String(l.code))]} value={campaign.labelCode}
                  onChange={(v) => setCampaign({ ...campaign, labelCode: v, segmentId: "" })} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Btn variant="soft" size="sm" onClick={() => void run("پیش‌نمایش", async () => {
                  const res = await crmIntelApi.createCampaign({ title: campaign.title || "پیش‌نمایش", message: campaign.message || "متن آزمایشی", segmentId: campaign.segmentId || null, labelCode: campaign.labelCode || null, dryRun: true, send: false });
                  setPreview(res); flash(res.matchMessage);
                })}>پیش‌نمایش تطابق</Btn>
                <Btn variant="accent" size="sm" icon={<Send size={14} />} disabled={!campaign.send && (!campaign.title || campaign.message.trim().length < 5)}
                  onClick={() => void run("ارسال کمپین", async () => {
                    const res = await crmIntelApi.createCampaign({ title: campaign.title, message: campaign.message, segmentId: campaign.segmentId || null, labelCode: campaign.labelCode || null, dryRun: false, send: true });
                    setPreview(res); flash(`کمپین برای ${fmtNum(res.recipients)} کاربر دارای رضایت ارسال شد.`);
                  })}>ارسال با رعایت رضایت</Btn>
                <span className="text-[11.5px] text-[var(--kv-muted)]">کاربران بدون رضایت بازاریابی یا در فهرست عدم تماس حذف می‌شوند.</span>
              </div>
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-2 text-[12px] font-bold">سقف تکرار پیام تبلیغاتی (پیامک عملیاتی هرگز محدود نمی‌شود)</p>
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span>حداکثر</span>
                  <Input value={String(cap.maxPerWindow)} onChange={(v) => setCap({ ...cap, maxPerWindow: Number(v.replace(/\D/g, "")) || 0 })} />
                  <span>کمپین در</span>
                  <Input value={String(cap.windowDays)} onChange={(v) => setCap({ ...cap, windowDays: Number(v.replace(/\D/g, "")) || 1 })} />
                  <span>روز</span>
                  <Btn variant="soft" size="sm" onClick={() => void run("ذخیره سقف تکرار", async () => {
                    const res = await crmIntelApi.saveMarketingSettings(cap); setCap(res.frequencyCap);
                  })}>ذخیره</Btn>
                </div>
              </div>
            </div>
          </Card>
          <Card className="p-5">
            <p className="mb-3 text-[13px] font-extrabold">نتیجه پیش‌نمایش</p>
            {!preview ? <Empty title="پیش‌نمایشی گرفته نشده" desc="با «پیش‌نمایش تطابق» تعداد و نمونه کاربران را ببینید." /> : (
              <>
                <p className="text-[13px] font-bold">{text(preview.matchMessage)}</p>
                {preview.breakdown && (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-3">
                    {([
                      ["مخاطبان Match", preview.breakdown.matched],
                      ["قابل ارسال", preview.breakdown.eligible],
                      ["بدون رضایت (opt-out)", preview.breakdown.optedOut],
                      ["عدم تماس (DNC)", preview.breakdown.doNotContact],
                      ["شماره نامعتبر", preview.breakdown.invalidPhone],
                      ["حساب معلق", preview.breakdown.suspended],
                      [`سقف تکرار (${fmtNum(preview.breakdown.frequencyCap.maxPerWindow)} در ${fmtNum(preview.breakdown.frequencyCap.windowDays)} روز)`, preview.breakdown.capped],
                    ] as [string, number][]).map(([label, value]) => (
                      <div key={label} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2.5 py-2">
                        <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
                        <p className="font-extrabold tabular-nums">{fmtNum(Number(value ?? 0))}</p>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 space-y-1.5 text-[12px]">
                  {(preview.sample as Record<string, unknown>[]).map((row) => (
                    <div key={String(row.userId)} className="flex items-center justify-between border-b border-dashed border-[var(--kv-line)] pb-1.5">
                      <span>{text(row.displayName, "بدون نام")}</span>
                      <span className="text-[var(--kv-muted)] tabular-nums">{text(row.phone)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === "events" && (
        <Card className="p-5">
          <p className="mb-3 text-[13px] font-extrabold">رویدادهای پیش‌رو (تولد، انقضای عضویت…) — مبنای اتوماسیون‌ها</p>
          <div className="space-y-2">
            {events.map((row, index) => (
              <div key={index} className="flex items-center justify-between border-b border-dashed border-[var(--kv-line)] pb-2 text-[12.5px]">
                <span><b>{text(row.display_name ?? row.user_id)}</b> — {text(row.event_type ?? row.event)} <span className="text-[var(--kv-muted)]">{text(row.title)}</span></span>
                <span className="text-[11.5px] text-[var(--kv-muted)] tabular-nums">{day(row.occurred_at ?? row.due_at ?? row.date)}</span>
              </div>
            ))}
            {!events.length && <Empty title="رویدادی پیش‌رو نیست" desc="تاریخ تولد یا انقضای عضویت ثبت نشده است." />}
          </div>
        </Card>
      )}

      <WorkspaceModal open={!!membersOpen} onClose={() => setMembersOpen(null)} title={membersOpen ? `اعضای گروه: ${membersOpen.title}` : "اعضای گروه"}>
        <Card className="p-4">
          {!membersOpen?.items.length ? <Empty title="عضوی در این گروه نیست" desc="پس از به‌روزرسانی گروه دوباره بررسی کنید." /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-right text-[12.5px]">
                <thead><tr className="text-[11px] text-[var(--kv-muted)]">{["مخاطب","موبایل","رفتار","ارزش","آخرین خرید","دلیل عضویت"].map((h)=><th key={h} className="pb-2">{h}</th>)}</tr></thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {membersOpen.items.map((row,index)=><tr key={String(row.user_id ?? index)}>
                    <td className="py-2.5 font-bold">{text(row.display_name ?? row.name,"بدون نام")}</td>
                    <td className="py-2.5 tabular-nums">{text(row.phone,"ثبت نشده")}</td>
                    <td className="py-2.5">{text(row.behavior_label ?? row.behavior,"—")}</td>
                    <td className="py-2.5">{text(row.total_spent_rial ?? row.total_spent,"—")}</td>
                    <td className="py-2.5">{day(row.last_order_at)}</td>
                    <td className="py-2.5 text-[11.5px] text-[var(--kv-muted)]">{text(row.match_reason ?? row.reason,"عضویت بر اساس قواعد گروه")}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </WorkspaceModal>

      <Modal open={ruleDraft.open} onClose={() => setRuleDraft({ ...ruleDraft, open: false })} title="قاعده برچسب‌گذاری">
        <div className="space-y-3">
          <Field label="کد قاعده"><Input value={ruleDraft.code} onChange={(v) => setRuleDraft({ ...ruleDraft, code: v })} placeholder="loyal-30d" /></Field>
          <Field label="عنوان"><Input value={ruleDraft.title} onChange={(v) => setRuleDraft({ ...ruleDraft, title: v })} /></Field>
          <Field label="برچسب هدف"><Select options={labels.map((l) => String(l.code))} value={ruleDraft.labelCode} onChange={(v) => setRuleDraft({ ...ruleDraft, labelCode: v })} /></Field>
          <Field label="شرط‌ها (روی داده واقعی سرور)"><ConditionEditor conditions={ruleDraft.conditions} setConditions={(c) => setRuleDraft({ ...ruleDraft, conditions: c })} /></Field>
          <div className="flex items-center gap-3">
            <Select options={["all", "any"]} labels={MATCH_FA} value={ruleDraft.matchMode} onChange={(v) => setRuleDraft({ ...ruleDraft, matchMode: v })} />
            <label className="flex items-center gap-2 text-[12.5px] font-semibold">
              <input type="checkbox" checked={ruleDraft.requiresApproval} onChange={(e) => setRuleDraft({ ...ruleDraft, requiresApproval: e.target.checked })} className="h-4 w-4 accent-[#C1613B]" />
              نیازمند تأیید دستی
            </label>
          </div>
          <Btn variant="accent" className="w-full" disabled={!ruleDraft.code || !ruleDraft.title || !ruleDraft.conditions.length}
            onClick={() => void run("ساخت قاعده", async () => {
              await crmIntelApi.createRule({ ...ruleDraft, conditions: toPayload(ruleDraft.conditions) });
              setRuleDraft({ ...ruleDraft, open: false });
            })}>ثبت قاعده</Btn>
        </div>
      </Modal>

      <Modal open={segmentDraft.open} onClose={() => setSegmentDraft({ ...segmentDraft, open: false })} title="سگمنت پویا">
        <div className="space-y-3">
          <Field label="کد"><Input value={segmentDraft.code} onChange={(v) => setSegmentDraft({ ...segmentDraft, code: v })} /></Field>
          <Field label="عنوان"><Input value={segmentDraft.title} onChange={(v) => setSegmentDraft({ ...segmentDraft, title: v })} /></Field>
          <Field label="شرط‌ها"><ConditionEditor conditions={segmentDraft.conditions} setConditions={(c) => setSegmentDraft({ ...segmentDraft, conditions: c })} /></Field>
          <Field label="بازه به‌روزرسانی (دقیقه)"><Input value={String(segmentDraft.refreshIntervalMinutes)} onChange={(v) => setSegmentDraft({ ...segmentDraft, refreshIntervalMinutes: Number(v.replace(/\D/g, "")) || 60 })} /></Field>
          <Btn variant="accent" className="w-full" disabled={!segmentDraft.code || !segmentDraft.title || !segmentDraft.conditions.length}
            onClick={() => void run("ساخت سگمنت", async () => {
              await crmIntelApi.createSegment({ code: segmentDraft.code, title: segmentDraft.title, kind: "dynamic", refreshIntervalMinutes: segmentDraft.refreshIntervalMinutes, definition: { matchMode: segmentDraft.matchMode, conditions: toPayload(segmentDraft.conditions) } });
              setSegmentDraft({ ...segmentDraft, open: false });
            })}>ثبت سگمنت</Btn>
        </div>
      </Modal>
    </div>
  );
}

function LabelForm({ onDone }: { onDone: (message: string) => void }) {
  const [draft, setDraft] = useState({ code: "", title: "", kind: "manual", color: "#C1613B" });
  return (
    <div className="space-y-3">
      <Field label="کد (انگلیسی)"><Input value={draft.code} onChange={(v) => setDraft({ ...draft, code: v })} placeholder="loyal_30d" /></Field>
      <Field label="عنوان"><Input value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} placeholder="وفادار ۳۰ روزه" /></Field>
      <Field label="نوع"><Select options={["manual", "behavioral"]} labels={KIND_FA} value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v })} /></Field>
      <Btn variant="accent" className="w-full" disabled={!/^[a-z0-9_]{3,40}$/.test(draft.code) || draft.title.trim().length < 2}
        onClick={() => void (async () => {
          try { await crmIntelApi.createLabel(draft); onDone("برچسب ساخته شد"); setDraft({ code: "", title: "", kind: "manual", color: "#C1613B" }); }
          catch (e) { onDone(e instanceof Error ? e.message : "خطا در ساخت برچسب"); }
        })()}>ثبت برچسب</Btn>
    </div>
  );
}
