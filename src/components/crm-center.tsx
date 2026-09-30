import { useCallback, useEffect, useState } from "react";
import { Activity, Filter, Plus, RefreshCw, Send, Sparkles, Tags, UserSearch } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";
import { crmIntelApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented, Select, Status, Tag, Textarea } from "./primitives";

const day = (value: unknown) => (value ? formatPersianDate(String(value)) : "—");
const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const rial = (value: unknown) => `${fmtNum(Number(String(value ?? "0")))} ریال`;
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

type Tab = "labels" | "rules" | "segments" | "contacts" | "campaign" | "events";
const TABS: { v: Tab; label: string }[] = [
  { v: "labels", label: "برچسب‌ها" },
  { v: "rules", label: "قواعد هوشمند" },
  { v: "segments", label: "سگمنت‌ها" },
  { v: "contacts", label: "پروفایل و تایم‌لاین" },
  { v: "campaign", label: "کمپین هدفمند" },
  { v: "events", label: "رویدادهای پیش‌رو" },
];

type Condition = { field: string; op: string; value: string };

/** CRM center (items 20-24 and 95-100): labels, server-side rule engine, dynamic
 *  segments, behavioural analytics, timeline and targeted SMS — all server-owned. */
export function CrmCenter({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("labels");
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, unknown>[]>([]);
  const [rules, setRules] = useState<Record<string, unknown>[]>([]);
  const [segments, setSegments] = useState<Record<string, unknown>[]>([]);
  const [contacts, setContacts] = useState<Record<string, unknown>[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [fields, setFields] = useState<string[]>([]);
  const [operators, setOperators] = useState<string[]>(["=", "!=", ">", ">=", "<", "<=", "in", "contains"]);
  const [loading, setLoading] = useState(true);
  const [ruleDraft, setRuleDraft] = useState({ open: false, code: "", title: "", labelCode: "", matchMode: "all", status: "test", requiresApproval: true, conditions: [] as Condition[] });
  const [segmentDraft, setSegmentDraft] = useState({ open: false, code: "", title: "", matchMode: "all", refreshIntervalMinutes: 60, conditions: [] as Condition[] });
  const [contactSearch, setContactSearch] = useState("");
  const [contact, setContact] = useState<Record<string, unknown> | null>(null);
  const [behavior, setBehavior] = useState<Record<string, unknown> | null>(null);
  const [timeline, setTimeline] = useState<Record<string, unknown>[]>([]);
  const [notes, setNotes] = useState<Record<string, unknown>[]>([]);
  const [noteDraft, setNoteDraft] = useState<{ body: string; visibility: "internal" | "team" }>({ body: "", visibility: "internal" });
  const [dryRun, setDryRun] = useState<{ matchCount: number; sample: Record<string, unknown>[] } | null>(null);
  const [campaign, setCampaign] = useState({ title: "", message: "", segmentId: "", labelCode: "", send: false });
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

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

  const loadContacts = useCallback(async () => {
    try {
      const res = await crmIntelApi.contacts({ search: contactSearch || undefined, limit: 40 });
      setContacts(res.items);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری مخاطبان"); }
  }, [contactSearch, flash]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadContacts(); }, [loadContacts]);

  const openContact = async (id: string) => {
    try {
      const [full, beh] = await Promise.all([crmIntelApi.view360(id), crmIntelApi.behavior(id)]);
      setContact(full); setBehavior(beh);
      setTimeline((full.timeline as Record<string, unknown>[]) ?? []);
      setNotes((full.notes as Record<string, unknown>[]) ?? []);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری پرونده مشتری"); }
  };

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
          <Select options={fields} value={condition.field} onChange={(v) => setConditions(conditions.map((c, i) => (i === index ? { ...c, field: v } : c)))} />
          <Select options={operators} value={condition.op} onChange={(v) => setConditions(conditions.map((c, i) => (i === index ? { ...c, op: v } : c)))} />
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
                    <span className="text-[11px] text-[var(--kv-muted)]">{text(label.code)} · {text(label.kind)}</span>
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
                  <p className="text-[13px] font-bold">{text(segment.title)} <span className="text-[11px] text-[var(--kv-muted)]">({text(segment.code)})</span></p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {text(segment.kind)} · اعضا {fmtNum(Number(segment.member_count ?? 0))} · آخرین به‌روزرسانی {stamp(segment.last_refreshed_at)}
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />}
                      onClick={() => void run("به‌روزرسانی سگمنت", () => crmIntelApi.refreshSegment(String(segment.id)))}>به‌روزرسانی</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => void crmIntelApi.segmentMembers(String(segment.id)).then((r) => {
                      flash(`اعضای سگمنت: ${fmtNum(r.items.length)} نفر`);
                    }).catch((e) => flash(e instanceof Error ? e.message : "خطا"))}>مشاهده اعضا</Btn>
                  </div>
                </div>
              ))}
              {!segments.length && <Empty title="سگمنتی ثبت نشده" desc="سگمنت‌های پیش‌فرض در مهاجرت ۰۱۷ ساخته می‌شوند." />}
            </div>
          </Card>
        </div>
      )}

      {tab === "contacts" && (
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="h-fit p-4">
            <p className="mb-3 text-[13px] font-extrabold">مخاطبان CRM</p>
            <div className="flex gap-2">
              <Input value={contactSearch} onChange={setContactSearch} placeholder="نام یا همراه" />
              <Btn variant="soft" size="sm" icon={<UserSearch size={14} />} onClick={() => void loadContacts()}>جست‌وجو</Btn>
            </div>
            <div className="kv-scroll mt-3 max-h-[520px] space-y-1 overflow-y-auto">
              {contacts.map((row) => (
                <button key={String(row.id)} onClick={() => void openContact(String(row.id))}
                  className="kv-press flex w-full flex-col items-start rounded-[11px] border border-[var(--kv-line)] px-3 py-2 text-right text-[12.5px] hover:bg-[var(--kv-surface-2)]">
                  <span className="font-bold">{text(row.display_name ?? row.phone)}</span>
                  <span className="text-[11px] text-[var(--kv-muted)] tabular-nums">
                    {fmtNum(Number(row.order_count ?? 0))} سفارش · {rial(row.total_spent_rial)}
                  </span>
                </button>
              ))}
              {!contacts.length && <Empty title="مخاطبی یافت نشد" desc="با ثبت سفارش یا عضویت، مخاطب ساخته می‌شود." />}
            </div>
          </Card>

          <div className="space-y-4">
            {!contact ? <Card className="p-6"><Empty title="مشتری انتخاب نشده" desc="از فهرست سمت راست یک مشتری را باز کنید." /></Card> : (() => {
              const profile = (contact.contact ?? {}) as Record<string, unknown>;
              const membership = contact.membership as Record<string, unknown> | null;
              const contactId = String(profile.id ?? "");
              return (
              <>
                <Card className="p-5">
                  <h3 className="text-[16px] font-extrabold">{text(profile.display_name)}</h3>
                  <p className="mt-1 text-[12px] text-[var(--kv-muted)] tabular-nums">
                    {text(profile.phone)} · {text(profile.email)} · وضعیت {text(profile.status)} ·
                    عضویت {text(membership?.title ?? membership?.code, "—")} {membership ? `(${text(membership.status)})` : ""} · آخرین ورود {stamp(profile.last_login_at)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(contact.labels as { label_code: string; title: string }[] ?? []).map((label) => <Tag key={label.label_code}>{label.title}</Tag>)}
                    {(contact.segments as { code: string; title: string }[] ?? []).map((segment) => <Tag key={segment.code}>{segment.title}</Tag>)}
                    {!(contact.labels as unknown[])?.length && !(contact.segments as unknown[])?.length && <span className="text-[12px] text-[var(--kv-muted)]">برچسب یا سگمنتی ثبت نشده است.</span>}
                  </div>
                </Card>
                {behavior && (
                  <Card className="p-5">
                    <p className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Activity size={15} />تحلیل رفتار خرید</p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        ["سفارش", fmtNum(Number((behavior.metrics as Record<string, unknown>)?.orders ?? 0))],
                        ["مجموع خرید", rial((behavior.metrics as Record<string, unknown>)?.totalSpentRial)],
                        ["میانگین سفارش", rial((behavior.metrics as Record<string, unknown>)?.averageOrderRial)],
                        ["فاصله خرید (روز)", text(behavior.averagePurchaseIntervalDays, "—")],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-[12px] bg-[var(--kv-surface-2)]/70 px-3 py-2">
                          <p className="text-[11px] text-[var(--kv-muted)]">{label}</p>
                          <p className="text-[13px] font-extrabold tabular-nums">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-4 md:grid-cols-3">
                      {[["محصولات محبوب", behavior.products], ["دسته‌های موردعلاقه", behavior.categories], ["کوپن‌های استفاده‌شده", behavior.coupons]].map(([title, rows]) => (
                        <div key={title as string}>
                          <p className="mb-1.5 text-[12px] font-bold">{title as string}</p>
                          {(rows as Record<string, unknown>[])?.slice(0, 5).map((row, i) => (
                            <p key={i} className="text-[11.5px] text-[var(--kv-muted)] tabular-nums">
                              {text(row.product_name ?? row.category ?? row.code)} · {fmtNum(Number(row.quantity ?? row.count ?? row.discount_rial ?? 0))}
                            </p>
                          ))}
                          {!(rows as unknown[])?.length && <p className="text-[11.5px] text-[var(--kv-muted)]">داده‌ای نیست</p>}
                        </div>
                      ))}
                    </div>
                  </Card>
                )}
                <Card className="p-5">
                  <p className="mb-3 text-[13px] font-extrabold">یادداشت داخلی (هرگز برای مشتری نمایش داده نمی‌شود)</p>
                  <div className="space-y-2">
                    {notes.map((note) => (
                      <div key={String(note.id)} className="rounded-[11px] bg-[var(--kv-surface-2)]/60 px-3 py-2 text-[12px]">
                        <p>{text(note.body)}</p>
                        <p className="mt-1 text-[10.5px] text-[var(--kv-muted)]">
                          {text(note.author_name ?? note.author_id)} · {stamp(note.created_at)}
                          {note.edited_at ? ` · ویرایش ${stamp(note.edited_at)}` : ""} · {text(note.visibility)}
                        </p>
                      </div>
                    ))}
                    {!notes.length && <p className="text-[12px] text-[var(--kv-muted)]">یادداشتی ثبت نشده است.</p>}
                  </div>
                  <Textarea rows={3} value={noteDraft.body} onChange={(v) => setNoteDraft({ ...noteDraft, body: v })} placeholder="یادداشت…" />
                  <div className="mt-2 flex items-center gap-2">
                    <Select options={["internal", "team"]} value={noteDraft.visibility} onChange={(v) => setNoteDraft({ ...noteDraft, visibility: v as "internal" | "team" })} />
                    <Btn variant="soft" size="sm" disabled={noteDraft.body.trim().length < 3}
                      onClick={() => void run("ثبت یادداشت", async () => {
                        await crmIntelApi.addNote(String(contactId), noteDraft);
                        setNoteDraft({ body: "", visibility: "internal" });
                        if (contact) await openContact(String(contact.id));
                      })}>ثبت یادداشت</Btn>
                  </div>
                </Card>
                <Card className="p-5">
                  <p className="mb-3 text-[13px] font-extrabold">تایم‌لاین کامل فعالیت</p>
                  <div className="space-y-2">
                    {timeline.slice(0, 25).map((row) => (
                      <div key={String(row.id)} className="flex items-start justify-between gap-3 border-b border-dashed border-[var(--kv-line)] pb-2 text-[12px]">
                        <span><b>{text(row.title)}</b><span className="text-[var(--kv-muted)]"> — {text(row.source)}</span></span>
                        <span className="shrink-0 text-[11px] text-[var(--kv-muted)]">{stamp(row.occurred_at)}</span>
                      </div>
                    ))}
                    {!timeline.length && <p className="text-[12px] text-[var(--kv-muted)]">فعالیتی ثبت نشده است.</p>}
                  </div>
                </Card>
              </>
              );
            })()}
          </div>
        </div>
      )}

      {tab === "campaign" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-5">
            <p className="mb-3 text-[13px] font-extrabold">کمپین SMS هدفمند (برچسب یا سگمنت)</p>
            <div className="space-y-3">
              <Field label="عنوان"><Input value={campaign.title} onChange={(v) => setCampaign({ ...campaign, title: v })} /></Field>
              <Field label="متن پیام"><Textarea rows={3} value={campaign.message} onChange={(v) => setCampaign({ ...campaign, message: v })} /></Field>
              <Field label="سگمنت مقصد">
                <Select options={["", ...segments.map((s) => String(s.id))]} value={campaign.segmentId}
                  onChange={(v) => setCampaign({ ...campaign, segmentId: v, labelCode: "" })} />
              </Field>
              <p className="text-[11.5px] text-[var(--kv-muted)]">برای انتخاب سگمنت، شناسه آن را از تب سگمنت‌ها بردارید یا از برچسب استفاده کنید.</p>
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
            </div>
          </Card>
          <Card className="p-5">
            <p className="mb-3 text-[13px] font-extrabold">نتیجه پیش‌نمایش</p>
            {!preview ? <Empty title="پیش‌نمایشی گرفته نشده" desc="با «پیش‌نمایش تطابق» تعداد و نمونه کاربران را ببینید." /> : (
              <>
                <p className="text-[13px] font-bold">{text(preview.matchMessage)}</p>
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

      <Modal open={ruleDraft.open} onClose={() => setRuleDraft({ ...ruleDraft, open: false })} title="قاعده برچسب‌گذاری">
        <div className="space-y-3">
          <Field label="کد قاعده"><Input value={ruleDraft.code} onChange={(v) => setRuleDraft({ ...ruleDraft, code: v })} placeholder="loyal-30d" /></Field>
          <Field label="عنوان"><Input value={ruleDraft.title} onChange={(v) => setRuleDraft({ ...ruleDraft, title: v })} /></Field>
          <Field label="برچسب هدف"><Select options={labels.map((l) => String(l.code))} value={ruleDraft.labelCode} onChange={(v) => setRuleDraft({ ...ruleDraft, labelCode: v })} /></Field>
          <Field label="شرط‌ها (روی داده واقعی سرور)"><ConditionEditor conditions={ruleDraft.conditions} setConditions={(c) => setRuleDraft({ ...ruleDraft, conditions: c })} /></Field>
          <div className="flex items-center gap-3">
            <Select options={["all", "any"]} value={ruleDraft.matchMode} onChange={(v) => setRuleDraft({ ...ruleDraft, matchMode: v })} />
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
      <Field label="نوع"><Select options={["manual", "behavioral"]} value={draft.kind} onChange={(v) => setDraft({ ...draft, kind: v })} /></Field>
      <Btn variant="accent" className="w-full" disabled={!/^[a-z0-9_]{3,40}$/.test(draft.code) || draft.title.trim().length < 2}
        onClick={() => void (async () => {
          try { await crmIntelApi.createLabel(draft); onDone("برچسب ساخته شد"); setDraft({ code: "", title: "", kind: "manual", color: "#C1613B" }); }
          catch (e) { onDone(e instanceof Error ? e.message : "خطا در ساخت برچسب"); }
        })()}>ثبت برچسب</Btn>
    </div>
  );
}
