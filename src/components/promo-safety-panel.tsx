import { useCallback, useEffect, useState } from "react";
import { BadgePercent, CalendarClock, Gift, ShieldAlert, Sparkles, Ticket, Workflow } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDateTime } from "../data/persian-date";
import { promoSafetyApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Segmented, Select, Status, Switch, Textarea } from "./primitives";

const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));
const rial = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : `${fmtNum(Number(String(value)))} ریال`);

type Tab = "automations" | "templates" | "coupons" | "triggers";
const TABS: { v: Tab; label: string }[] = [
  { v: "automations", label: "قواعد و ایمنی اجرا" },
  { v: "templates", label: "قالب‌های کمپین" },
  { v: "coupons", label: "کوپن‌های شخصی" },
  { v: "triggers", label: "تریگرهای CRM" },
];

const emptyTemplate = {
  code: "", title: "", description: "", type: "percent" as "percent" | "fixed", value: "10",
  maxDiscountRial: "", minOrderRial: "0", usageLimitPerUser: 1, validityDays: 14, codePrefix: "KV",
  messageTemplate: "{name} عزیز، کد تخفیف اختصاصی شما: {code}", installmentPolicy: "inherit",
  categories: "", audience: "all", triggerCode: "", active: true,
};

/** CRM ↔ promotion flow with safety rails (items 136-143): rule-based automations
 *  with dry-run previews, campaign templates, personal coupons and the trigger list. */
export function PromoSafetyPanel({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("automations");
  const [automations, setAutomations] = useState<Record<string, unknown>[]>([]);
  const [templates, setTemplates] = useState<Record<string, unknown>[]>([]);
  const [coupons, setCoupons] = useState<Record<string, unknown>[]>([]);
  const [triggers, setTriggers] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [runs, setRuns] = useState<{ automation: Record<string, unknown>; items: Record<string, unknown>[] } | null>(null);
  const [templateModal, setTemplateModal] = useState<{ open: boolean; mode: "create" | "edit" } & typeof emptyTemplate>({ open: false, mode: "create", ...emptyTemplate });
  const [couponModal, setCouponModal] = useState({ open: false, userId: "", templateCode: "", percent: "", reason: "", expiresInDays: 14 });
  const [couponSearch, setCouponSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [automationList, templateList, couponList, triggerList] = await Promise.all([
        promoSafetyApi.automations(), promoSafetyApi.templates(),
        promoSafetyApi.personalCoupons(couponSearch ? { search: couponSearch } : undefined),
        promoSafetyApi.triggers(),
      ]);
      setAutomations(automationList.items); setTemplates(templateList.items);
      setCoupons(couponList.items); setTriggers(triggerList.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری اتوماسیون تخفیف"); }
    finally { setLoading(false); }
  }, [couponSearch]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { const result = await action(); flash(`${label} انجام شد`); await load(); return result; }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); return null; }
  };

  const dryRunAutomation = async (automation: Record<string, unknown>) => {
    const result = await run("تست خشک", () => promoSafetyApi.dryRunAutomation(String(automation.id))) as Record<string, unknown> | null;
    if (result) { setPreview(result); setPreviewTitle(`تست خشک «${text(automation.name)}»`); }
  };
  const dryRunTemplate = async (template: Record<string, unknown>) => {
    const result = await run("تست خشک", () => promoSafetyApi.dryRunTemplate(String(template.code), {})) as Record<string, unknown> | null;
    if (result) { setPreview(result); setPreviewTitle(`تست خشک قالب «${text(template.title)}»`); }
  };

  if (loading && !automations.length && !templates.length) return <LoadingState label="در حال بارگذاری ابزار تخفیف…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4"><Segmented options={TABS} value={tab} onChange={setTab} /></Card>

      {tab === "automations" && (
        <div className="space-y-3">
          {automations.map((automation) => {
            const capped = automation.audience_cap !== null && Number(automation.last_dry_run_match_count ?? 0) > Number(automation.audience_cap);
            return (
              <Card key={String(automation.id)} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-extrabold">
                      {text(automation.name)}
                      <Status value={text(automation.status)} />
                      {automation.manual_approval_required && !automation.approved_at ? <Status value="در انتظار تأیید" /> : null}
                      {automation.dry_run_required && !automation.last_dry_run_at ? <Status value="نیازمند تست خشک" /> : null}
                    </p>
                    <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                      کد {text(automation.code)} · تریگر {text(automation.trigger_code)} · مخاطب {text(automation.target_kind)}:{text(automation.target_ref)} ·
                      قالب {text(automation.coupon_template_code)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      سقف اجرای روزانه {text(automation.daily_run_cap, "بی‌نهایت")} (امروز {num(automation.runs_today)}) ·
                      سقف مخاطب {text(automation.audience_cap, "بی‌نهایت")} · خنک‌سازی {num(automation.cooldown_hours)} ساعت ·
                      بودجه {rial(automation.budget_cap_rial)} (مصرف {rial(automation.budget_spent_rial)}) · انقضا {stamp(automation.expires_at)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      آخرین اجرا {stamp(automation.last_run_at)} · آخرین تست خشک {stamp(automation.last_dry_run_at)}
                      {automation.last_dry_run_match_count !== null ? ` (${num(automation.last_dry_run_match_count)} تطابق)` : ""}
                      {capped ? " · تعداد تطابق از سقف مخاطب بیشتر است" : ""}
                    </p>
                    {automation.last_error ? <p className="mt-1 text-[11.5px] text-[var(--kv-danger)]">{text(automation.last_error)}</p> : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Switch on={text(automation.status) === "active"}
                      onToggle={() => void run("تغییر وضعیت", () => promoSafetyApi.updateAutomation(String(automation.id), {
                        status: text(automation.status) === "active" ? "paused" : "active",
                      }))} />
                    <Btn variant="soft" size="sm" onClick={() => void dryRunAutomation(automation)}>تست خشک</Btn>
                    <Btn variant="soft" size="sm" disabled={!automation.last_dry_run_at}
                      onClick={() => void run("اجرای آزمایشی", () => promoSafetyApi.runAutomation(String(automation.id), { mode: "test" }))}>اجرای آزمایشی</Btn>
                    <Btn variant="accent" size="sm" disabled={!automation.last_dry_run_at}
                      onClick={() => void run("اجرای واقعی", () => promoSafetyApi.runAutomation(String(automation.id), { mode: "live" }))}>اجرای واقعی</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => void (async () => {
                      try { const result = await promoSafetyApi.runs(String(automation.id)); setRuns({ automation, items: result.items }); }
                      catch (e) { flash(e instanceof Error ? e.message : "خطا در دریافت تاریخچه"); }
                    })()}>تاریخچه</Btn>
                  </div>
                </div>
              </Card>
            );
          })}
          {!automations.length && <Empty title="قاعده‌ای ثبت نشده" desc="قواعد از قالب‌های کمپین ساخته می‌شوند و تا فعال‌سازی صریح اجرا نمی‌شوند." />}
          <p className="text-[11.5px] text-[var(--kv-muted)]">
            اجرای واقعی فقط وقتی مجاز است که همه قیدها (وضعیت فعال، انقضا، سقف روزانه، سقف مخاطب، خنک‌سازی، تأیید انسانی، بودجه و تست خشک) عبور کنند؛
            در غیر این صورت دلیل دقیق فارسی نمایش داده می‌شود و اجرا در لاگ ثبت می‌گردد. اجرای زمان‌بندی‌شده هم در سرور (worker) انجام می‌شود.
          </p>
        </div>
      )}

      {tab === "templates" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Btn variant="soft" size="sm" onClick={() => setTemplateModal({ open: true, mode: "create", ...emptyTemplate })}>قالب جدید</Btn>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {templates.map((template) => (
              <Card key={String(template.code)} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="flex items-center gap-2 text-[13px] font-extrabold"><Ticket size={15} />{text(template.title)}</p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      <code>{text(template.code)}</code> · {template.type === "percent" ? `${num(template.value)}٪` : rial(template.value)} ·
                      حداقل سفارش {rial(template.min_order_rial)} · حداقل به‌ازای هر کاربر {num(template.usage_limit_per_user)} ·
                      اعتبار {num(template.validity_days)} روز · پیشوند {text(template.code_prefix)}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--kv-muted)]">
                      تریگر {text(template.trigger_code)} · سیاست اقساط {text(template.installment_policy)} · صادرشده {num(template.issued_count)}
                    </p>
                  </div>
                  <Switch on={Boolean(template.active)}
                    onToggle={() => void run("تغییر وضعیت قالب", () => promoSafetyApi.updateTemplate(String(template.code), { active: !template.active }))} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Btn variant="soft" size="sm" onClick={() => void dryRunTemplate(template)}>تست خشک</Btn>
                  <Btn variant="soft" size="sm" onClick={() => setTemplateModal({
                    open: true, mode: "edit", ...emptyTemplate,
                    code: text(template.code), title: text(template.title, ""), description: text(template.description, ""),
                    type: template.type === "fixed" ? "fixed" : "percent", value: text(template.value, "10"),
                    maxDiscountRial: template.max_discount_rial ? String(template.max_discount_rial) : "",
                    minOrderRial: text(template.min_order_rial, "0"), usageLimitPerUser: Number(template.usage_limit_per_user ?? 1),
                    validityDays: Number(template.validity_days ?? 14), codePrefix: text(template.code_prefix, "KV"),
                    messageTemplate: text(template.message_template, emptyTemplate.messageTemplate),
                    installmentPolicy: text(template.installment_policy, "inherit"), triggerCode: text(template.trigger_code, ""),
                    active: Boolean(template.active),
                  })}>ویرایش</Btn>
                  <Btn variant="accent" size="sm" disabled={!template.active}
                    onClick={() => void (async () => {
                      const result = await run("صدور خودکار", async () => {
                        const check = await promoSafetyApi.dryRunTemplate(String(template.code), {}) as Record<string, unknown>;
                        if (!Number(check.matchCount ?? 0)) return check;
                        return promoSafetyApi.issueTemplate(String(template.code), { dryRun: false, confirmMatchCount: Number(check.matchCount), reason: "صدور از پنل" });
                      }) as Record<string, unknown> | null;
                      if (result) { setPreview(result); setPreviewTitle(`نتیجه صدور «${text(template.title)}»`); }
                    })()}>صدور کوپن برای مخاطبان</Btn>
                </div>
              </Card>
            ))}
          </div>
          {!templates.length && <Empty title="قالبی ثبت نشده" desc="هر قالب کمپین، «Campaign Template → Coupon Instance» را ممکن می‌کند." />}
        </div>
      )}

      {tab === "coupons" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input value={couponSearch} onChange={setCouponSearch} placeholder="جست‌وجو بر اساس کد کوپن یا شماره همراه" className="w-72" />
            <Btn variant="soft" size="sm" onClick={() => void load()}>اعمال</Btn>
            <span className="flex-1" />
            <Btn variant="soft" size="sm" icon={<Gift size={14} />} onClick={() => setCouponModal({ ...couponModal, open: true })}>صدور دستی کوپن شخصی</Btn>
          </div>
          <Card className="p-5">
            <div className="kv-scroll overflow-x-auto">
              <table className="w-full min-w-[820px] text-right text-[12.5px]">
                <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">
                  <th className="pb-2">کد</th><th className="pb-2">دارنده</th><th className="pb-2">تخفیف</th><th className="pb-2">حداقل سفارش</th>
                  <th className="pb-2">انقضا</th><th className="pb-2">استفاده</th><th className="pb-2">قالب</th><th className="pb-2">سیاست اقساط</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {coupons.map((coupon) => (
                    <tr key={String(coupon.id)}>
                      <td className="py-2 font-semibold"><code>{text(coupon.code)}</code></td>
                      <td className="py-2 text-[11.5px]">{text(coupon.owner_name)}<span className="block text-[10.5px] text-[var(--kv-muted)]">{text(coupon.owner_phone)}</span></td>
                      <td className="py-2">{coupon.type === "percent" ? `${num(coupon.value)}٪` : rial(coupon.value)}</td>
                      <td className="py-2">{rial(coupon.min_order_rial)}</td>
                      <td className="py-2 text-[11.5px]">{stamp(coupon.ends_at)}</td>
                      <td className="py-2 tabular-nums">{num(coupon.used_count)}/{num(coupon.redemptions)}</td>
                      <td className="py-2 text-[11.5px]">{text(coupon.template_code)}</td>
                      <td className="py-2 text-[11.5px]">{text(coupon.installment_policy)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!coupons.length && <Empty title="کوپن شخصی‌ای صادر نشده" desc="کوپن‌های شخصی یک‌بارمصرف‌اند، انقضا و حداقل سفارش دارند و به کاربر مشخصی تعلق دارند." />}
            </div>
          </Card>
        </div>
      )}

      {tab === "triggers" && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Workflow size={16} />تریگرهای CRM ({num(triggers.length)})</div>
          <div className="grid gap-2 md:grid-cols-2">
            {triggers.map((trigger) => (
              <div key={String(trigger.code)} className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12px]">
                <p className="flex items-center gap-2 font-bold">
                  {text(trigger.title)}
                  <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px] text-[var(--kv-muted)]">{text(trigger.category)}</span>
                  {Number(trigger.automations) > 0 ? <span className="text-[10.5px] text-[var(--kv-muted)]">{num(trigger.automations)} قاعده</span> : null}
                </p>
                <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]"><code>{text(trigger.code)}</code> → رویداد {text(trigger.event_type)}</p>
                <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{text(trigger.description)}</p>
                <p className="mt-1 text-[11px] text-[var(--kv-muted)]">
                  اقدام پیش‌فرض {text(trigger.default_action)} · کانال {text(trigger.default_channel)} · خنک‌سازی {num(trigger.cooldown_hours)} ساعت
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
            <ShieldAlert size={14} />پیامک بازاریابی فقط برای کاربران دارای رضایت ارسال می‌شود؛ پیامک عملیاتی (سفارش و امنیت) از این قید جدا است.
          </p>
        </Card>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={previewTitle || "پیش‌نمایش"} max="max-w-[680px]">
        {preview && (
          <div className="space-y-3 text-[12.5px]">
            {preview.message ? <p className="rounded-[12px] bg-[var(--kv-surface-2)]/70 p-3 font-bold">{text(preview.message)}</p> : null}
            <div className="flex flex-wrap gap-3">
              {preview.matchCount !== undefined && <span>تطابق: <b>{num(preview.matchCount)}</b></span>}
              {preview.consentedCount !== undefined && <span>با رضایت بازاریابی: <b>{num(preview.consentedCount)}</b></span>}
              {preview.blockedByConsent !== undefined && <span>بدون رضایت (حذف‌شده): <b>{num(preview.blockedByConsent)}</b></span>}
              {preview.issued !== undefined && <span>کوپن صادرشده: <b>{num(preview.issued)}</b></span>}
              {preview.sent !== undefined && <span>پیام ارسال‌شده: <b>{num(preview.sent)}</b></span>}
              {preview.estimatedDiscountRial ? <span>تخمین تخفیف: <b>{rial(preview.estimatedDiscountRial)}</b></span> : null}
            </div>
            {preview.couponPreview ? (
              <div className="rounded-[12px] border border-dashed border-[var(--kv-line)] p-3">
                <p className="mb-1 flex items-center gap-2 font-bold"><BadgePercent size={14} />پیش‌نمایش کوپن شخصی</p>
                <p className="text-[11.5px] text-[var(--kv-muted)]">
                  نمونه کد: <code>{text((preview.couponPreview as Record<string, unknown>).codeExample)}</code> ·
                  {text((preview.couponPreview as Record<string, unknown>).title)} ·
                  {text((preview.couponPreview as Record<string, unknown>).type) === "percent"
                    ? ` ${num((preview.couponPreview as Record<string, unknown>).percent)}٪`
                    : ` ${rial((preview.couponPreview as Record<string, unknown>).value)}`}
                  {` · حداقل سفارش ${rial((preview.couponPreview as Record<string, unknown>).minOrderRial)}`}
                  {` · اعتبار ${num((preview.couponPreview as Record<string, unknown>).validityDays)} روز`}
                </p>
                <p className="mt-1 text-[11.5px]">{text((preview.couponPreview as Record<string, unknown>).messagePreview)}</p>
              </div>
            ) : null}
            {preview.safety ? (
              <div className="rounded-[12px] bg-[var(--kv-surface-2)]/70 p-3 text-[11.5px]">
                <p className="font-bold">وضعیت قیدهای ایمنی: {Boolean((preview.safety as Record<string, unknown>).allowed) ? "مجاز" : "غیرمجاز"}</p>
                {(() => {
                  const reasons = (preview.safety as Record<string, unknown>).reasons;
                  return Array.isArray(reasons) && reasons.length
                    ? <ul className="mt-1 list-inside list-disc text-[var(--kv-danger)]">{(reasons as string[]).map((reason) => <li key={reason}>{reason}</li>)}</ul>
                    : <p className="text-[var(--kv-muted)]">همه قیدها عبور کرده‌اند.</p>;
                })()}
              </div>
            ) : null}
            {Array.isArray(preview.sample) && (preview.sample as Record<string, unknown>[]).length > 0 && (
              <div>
                <p className="mb-1 font-bold">نمونه مخاطبان</p>
                <div className="space-y-1">
                  {(preview.sample as Record<string, unknown>[]).map((row) => (
                    <div key={String(row.userId)} className="flex items-center justify-between gap-2 rounded-[10px] border border-[var(--kv-line)] px-2.5 py-1.5 text-[11.5px]">
                      <span>{text(row.displayName)} · {text(row.phoneMasked)}</span>
                      <span className="flex items-center gap-2 text-[var(--kv-muted)]">
                        {text(row.reason)}
                        {row.consent ? <Status value="رضایت دارد" /> : <Status value="بدون رضایت" />}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {preview.note ? <p className="text-[11.5px] text-[var(--kv-muted)]">{text(preview.note)}</p> : null}
          </div>
        )}
      </Modal>

      <Modal open={!!runs} onClose={() => setRuns(null)} title={runs ? `تاریخچه اجرای ${text(runs.automation.name)}` : "تاریخچه"} max="max-w-[720px]">
        <div className="space-y-2 text-[12px]">
          {runs?.items.map((row) => (
            <div key={String(row.id)} className="rounded-[11px] border border-[var(--kv-line)] p-2.5">
              <p className="font-bold">
                {row.dry_run ? "تست خشک" : text(row.mode)} · {stamp(row.started_at)} · تطابق {num(row.matched_count)} · ارسال {num(row.sent_count)} · کوپن {num(row.coupon_count)}
              </p>
              <p className="text-[11px] text-[var(--kv-muted)]">
                توسط {text(row.triggered_by_name)} · منبع {text(row.source)} · وضعیت {text(row.status)} {row.trigger_code ? `· تریگر ${text(row.trigger_code)}` : ""}
              </p>
              {row.last_error ? <p className="text-[11px] text-[var(--kv-danger)]">{text(row.last_error)}</p> : null}
              {row.note ? <p className="text-[11px] text-[var(--kv-muted)]">{text(row.note)}</p> : null}
            </div>
          ))}
          {!runs?.items.length && <Empty title="اجرایی ثبت نشده" desc="هر اجرا (حتی اجرای ردشده) با دلیل در این تاریخچه می‌ماند." />}
        </div>
      </Modal>

      <Modal open={templateModal.open}
        onClose={() => setTemplateModal({ ...templateModal, open: false })}
        title={templateModal.mode === "create" ? "قالب کمپین جدید" : `ویرایش ${templateModal.code}`}
        max="max-w-[680px]">
        <div className="space-y-3">
          {templateModal.mode === "create" && (
            <Field label="کد قالب"><Input value={templateModal.code} onChange={(v) => setTemplateModal({ ...templateModal, code: v })} placeholder="birthday_gift" /></Field>
          )}
          <Field label="عنوان"><Input value={templateModal.title} onChange={(v) => setTemplateModal({ ...templateModal, title: v })} /></Field>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="نوع"><Select options={["percent", "fixed"]} value={templateModal.type} onChange={(v) => setTemplateModal({ ...templateModal, type: v as "percent" | "fixed" })} /></Field>
            <Field label={templateModal.type === "percent" ? "درصد (۱–۱۰۰)" : "مبلغ (ریال)"}><Input value={templateModal.value} onChange={(v) => setTemplateModal({ ...templateModal, value: v.replace(/\D/g, "") })} /></Field>
            <Field label="حداکثر تخفیف (ریال، اختیاری)"><Input value={templateModal.maxDiscountRial} onChange={(v) => setTemplateModal({ ...templateModal, maxDiscountRial: v.replace(/\D/g, "") })} /></Field>
            <Field label="حداقل سفارش (ریال)"><Input value={templateModal.minOrderRial} onChange={(v) => setTemplateModal({ ...templateModal, minOrderRial: v.replace(/\D/g, "") || "0" })} /></Field>
            <Field label="سقف استفاده هر کاربر"><Input value={String(templateModal.usageLimitPerUser)} onChange={(v) => setTemplateModal({ ...templateModal, usageLimitPerUser: Number(v.replace(/\D/g, "")) || 1 })} /></Field>
            <Field label="اعتبار (روز)"><Input value={String(templateModal.validityDays)} onChange={(v) => setTemplateModal({ ...templateModal, validityDays: Number(v.replace(/\D/g, "")) || 1 })} /></Field>
            <Field label="پیشوند کد"><Input value={templateModal.codePrefix} onChange={(v) => setTemplateModal({ ...templateModal, codePrefix: v.toUpperCase().replace(/[^A-Z0-9-]/g, "") })} /></Field>
            <Field label="تریگر"><Select options={["", ...triggers.map((trigger) => String(trigger.code))]} value={templateModal.triggerCode} onChange={(v) => setTemplateModal({ ...templateModal, triggerCode: v })} /></Field>
            <Field label="مخاطب"><Select options={["all", "customer", "vip", "wholesale"]} value={templateModal.audience} onChange={(v) => setTemplateModal({ ...templateModal, audience: v })} /></Field>
            <Field label="سیاست اقساط"><Select options={["inherit", "cash_only", "installment_only", "no_interest"]} value={templateModal.installmentPolicy} onChange={(v) => setTemplateModal({ ...templateModal, installmentPolicy: v })} /></Field>
          </div>
          <Field label="دسته‌های مجاز (با کاما جدا کنید، اختیاری)"><Input value={templateModal.categories} onChange={(v) => setTemplateModal({ ...templateModal, categories: v })} /></Field>
          <Field label="متن پیامک (پیش‌فرض {name} و {code})"><Textarea rows={2} value={templateModal.messageTemplate} onChange={(v) => setTemplateModal({ ...templateModal, messageTemplate: v })} /></Field>
          <Btn variant="accent" className="w-full"
            disabled={!templateModal.title.trim() || (templateModal.mode === "create" && !/^[a-z0-9_]{3,40}$/.test(templateModal.code))}
            onClick={() => void (async () => {
              const categories = templateModal.categories.split(",").map((item) => item.trim()).filter(Boolean);
              const payload: Record<string, unknown> = {
                title: templateModal.title, description: templateModal.description || "",
                type: templateModal.type, value: templateModal.value, minOrderRial: templateModal.minOrderRial,
                usageLimitPerUser: templateModal.usageLimitPerUser, validityDays: templateModal.validityDays,
                codePrefix: templateModal.codePrefix, messageTemplate: templateModal.messageTemplate,
                installmentPolicy: templateModal.installmentPolicy, audience: [templateModal.audience],
                scope: categories.length ? { categories } : {},
                triggerCode: templateModal.triggerCode || null, active: templateModal.active,
                maxDiscountRial: templateModal.maxDiscountRial || null,
              };
              await run(templateModal.mode === "create" ? "ساخت قالب" : "ویرایش قالب", () =>
                templateModal.mode === "create"
                  ? promoSafetyApi.createTemplate({ ...payload, code: templateModal.code })
                  : promoSafetyApi.updateTemplate(templateModal.code, payload));
              setTemplateModal({ ...templateModal, open: false });
            })()}>
            {templateModal.mode === "create" ? "ثبت قالب" : "ذخیره تغییرات"}
          </Btn>
          <p className="flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]"><CalendarClock size={13} />هر کوپن صادرشده از قالب، کد یکتای خود را می‌گیرد و به یک کاربر تعلق دارد.</p>
        </div>
      </Modal>

      <Modal open={couponModal.open} onClose={() => setCouponModal({ ...couponModal, open: false })} title="صدور دستی کوپن شخصی">
        <div className="space-y-3">
          <Field label="شناسه کاربر" hint="از پروفایل ۳۶۰° خریدار کپی کنید.">
            <Input value={couponModal.userId} onChange={(v) => setCouponModal({ ...couponModal, userId: v.trim() })} />
          </Field>
          <Field label="قالب"><Select options={templates.map((template) => String(template.code))} value={couponModal.templateCode} onChange={(v) => setCouponModal({ ...couponModal, templateCode: v })} /></Field>
          <Field label="درصد دلخواه (اختیاری، برای کوپن دستی)"><Input value={couponModal.percent} onChange={(v) => setCouponModal({ ...couponModal, percent: v.replace(/\D/g, "") })} /></Field>
          <Field label="اعتبار (روز)"><Input value={String(couponModal.expiresInDays)} onChange={(v) => setCouponModal({ ...couponModal, expiresInDays: Number(v.replace(/\D/g, "")) || 14 })} /></Field>
          <Field label="دلیل صدور (در گزارش ممیزی ثبت می‌شود)"><Textarea rows={2} value={couponModal.reason} onChange={(v) => setCouponModal({ ...couponModal, reason: v })} /></Field>
          <Btn variant="accent" className="w-full"
            disabled={!/^[0-9a-f-]{36}$/i.test(couponModal.userId) || !couponModal.templateCode || couponModal.reason.trim().length < 3}
            onClick={() => void (async () => {
              await run("صدور کوپن شخصی", () => promoSafetyApi.issuePersonalCoupon({
                userId: couponModal.userId, templateCode: couponModal.templateCode,
                percent: couponModal.percent ? Number(couponModal.percent) : undefined,
                reason: couponModal.reason, expiresInDays: couponModal.expiresInDays,
              }));
              setCouponModal({ ...couponModal, open: false });
            })()}>صدور کوپن</Btn>
          <p className="flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]"><Sparkles size={13} />کوپن‌های شخصی یک‌بارمصرف، دارای انقضا و قابل محدودسازی به دسته/محصول و سیاست اقساط هستند.</p>
        </div>
      </Modal>
    </div>
  );
}
