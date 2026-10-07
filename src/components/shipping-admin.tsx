import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Ruler, Trash2, Truck } from "lucide-react";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Select, Switch, Textarea } from "./primitives";
import { cn } from "../utils/cn";
import { shippingApi, inventoryApi } from "../data/api";
import { fmtMoney } from "../data/catalog";
import {
  SHIPPING_TYPES, SHIPPING_TYPE_LABEL, SHIPPING_PRICING_TYPES, SHIPPING_PRICING_TYPE_LABEL,
  SHIPPING_RULE_TYPES, SHIPPING_RULE_TYPE_LABEL, buildShippingMethodPayload, buildShippingRulePayload,
  normalizeShippingSettings, normalizeWarehouses, readShippingQuote,
  type ShippingMethod, type ShippingMethodInput, type ShippingPricingType, type ShippingPriceRule,
  type ShippingRuleInput, type ShippingRuleType, type ShippingSettings, type ShippingType, type Warehouse,
} from "../data/contracts";

/** Persian digits for read-only money/eta display. */
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

const blankMethod = (): ShippingMethodInput => ({
  code: "", name: "", type: "standard", pricingType: "flat", active: true,
  baseFeeRial: "0", freeAboveRial: null, estimatedMinDays: 1, estimatedMaxDays: 3, config: {},
});
const blankRule = (): ShippingRuleInput => ({
  ruleType: "weight", minWeightGrams: 0, maxWeightGrams: null,
  minOrderRial: null, maxOrderRial: null, province: null, city: null,
  feeRial: "0", position: 0, active: true,
});

/**
 * Shipping management — speaks the canonical backend contract:
 * `code, name, active, type, baseFeeRial, freeAboveRial, estimatedMinDays, estimatedMaxDays, config`
 * plus the global rules in site_settings (default fulfillment warehouse is a real warehouse UUID).
 *
 * The legacy carrier/scope/price/freeAbove/eta/zones model is gone.
 */
export function ShippingAdmin({ flash }: { flash: (message: string) => void }) {
  const [items, setItems] = useState<ShippingMethod[] | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [settings, setSettings] = useState<ShippingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<ShippingMethodInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rulesFor, setRulesFor] = useState<string | null>(null);
  const [ruleEdit, setRuleEdit] = useState<ShippingRuleInput | null>(null);
  const [ruleEditId, setRuleEditId] = useState<string | null>(null);
  const [quote, setQuote] = useState({ variantId: "", quantity: "1", subtotalRial: "0", province: "" });
  const [quoteResult, setQuoteResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [methods, warehouseList, shippingSettings] = await Promise.all([
        shippingApi.adminList(),
        inventoryApi.warehouses().then(normalizeWarehouses).catch(() => [] as Warehouse[]),
        shippingApi.settings().catch(() => null),
      ]);
      setItems(methods.items);
      setWarehouses(warehouseList);
      setSettings(shippingSettings ? normalizeShippingSettings({ settings: shippingSettings }) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در بارگذاری روش‌های ارسال");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!edit) return;
    try {
      setBusy(true);
      const payload = buildShippingMethodPayload(edit);
      if (editId) await shippingApi.update(editId, payload);
      else await shippingApi.create(payload);
      await load();
      setEdit(null); setEditId(null);
      flash(editId ? `روش ارسال «${payload.name}» به‌روزرسانی شد` : `روش ارسال «${payload.name}» ثبت شد`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ذخیره روش ارسال");
    } finally { setBusy(false); }
  };

  const saveRule = async () => {
    if (!rulesFor || !ruleEdit) return;
    try {
      setBusy(true);
      const payload = buildShippingRulePayload(ruleEdit);
      if (ruleEditId) await shippingApi.updateRule(ruleEditId, payload);
      else await shippingApi.createRule(rulesFor, payload);
      await load();
      setRuleEdit(null); setRuleEditId(null);
      flash(ruleEditId ? "قانون قیمت‌گذاری به‌روزرسانی شد" : "قانون قیمت‌گذاری ثبت شد");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ذخیره قانون");
    } finally { setBusy(false); }
  };

  const testQuote = async () => {
    if (!rulesFor || !quote.variantId.trim()) return;
    try {
      setBusy(true);
      const result = readShippingQuote(await shippingApi.quote({
        methodId: rulesFor,
        items: [{ variantId: quote.variantId.trim(), quantity: Number(quote.quantity) || 1 }],
        subtotalRial: quote.subtotalRial.replace(/\D/g, "") || "0",
        ...(quote.province.trim() ? { province: quote.province.trim() } : {}),
      }));
      setQuoteResult(`هزینه: ${result.feeRial === "0" ? "رایگان" : fmtMoney(Number(result.feeRial))} · وزن کل: ${result.totalWeightGrams.toLocaleString("fa-IR")} گرم${result.ruleId ? ` · قانون ${result.ruleId.slice(0, 8)}…` : " · بدون تطبیق قانون (هزینه پایه)"}`);
    } catch (e) {
      setQuoteResult(e instanceof Error ? e.message : "خطا در محاسبه نرخ");
    } finally { setBusy(false); }
  };

  const toggle = async (method: ShippingMethod) => {
    try {
      await shippingApi.update(method.id, { active: !method.active });
      await load();
      flash(`${method.name} ${method.active ? "غیرفعال" : "فعال"} شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت"); }
  };

  const remove = async (method: ShippingMethod) => {
    try {
      await shippingApi.remove(method.id);
      await load();
      flash(`روش ارسال «${method.name}» غیرفعال شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در حذف روش ارسال"); }
  };

  const saveSettings = async () => {
    if (!settings) return;
    try {
      setBusy(true);
      const next = await shippingApi.saveSettings(settings);
      setSettings(next); setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
      flash("قوانین سراسری ارسال ذخیره شد");
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ذخیره قوانین ارسال");
    } finally { setBusy(false); }
  };

  if (loading) return <LoadingState label="در حال بارگذاری روش‌های ارسال…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const activeCount = (items ?? []).filter((method) => method.active).length;

  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[1fr_340px]">
      {/* min-w-0: جداول min-w داخلی باید داخل کارت اسکرول شوند، نه اینکه کارت از لبه viewport بیرون بزند (ممیزی §23 — بریدگی ۱۴۴۰ و سرریز ۳۶۰) */}
      <div className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] text-[var(--kv-muted)]">
            روش‌های فعال در تسویه‌حساب خرده و ثبت سفارش عمده نمایش داده می‌شوند. ({fa(activeCount)} فعال از {fa(items?.length ?? 0)})
          </p>
          <div className="flex gap-2">
            <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
            <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setEditId(null); setEdit(blankMethod()); }}>روش ارسال جدید</Btn>
          </div>
        </div>

        {!items || items.length === 0 ? (
          <Card className="p-2">
            <Empty
              title="روش ارسالی ثبت نشده است"
              desc="برای فعال شدن ارسال در فروشگاه، نخستین روش ارسال را با کد، هزینه پایه و بازه تحویل بسازید."
              action={<Btn variant="accent" onClick={() => { setEditId(null); setEdit(blankMethod()); }} icon={<Truck size={15} />}>ایجاد اولین روش ارسال</Btn>}
            />
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[880px]">
                <thead>
                  <tr>
                    <th>کد روش ارسال</th><th>نام روش</th><th>نوع ارسال</th><th>قیمت‌گذاری</th><th>هزینه پایه</th>
                    <th>ارسال رایگان از مبلغ</th><th>زمان تحویل</th><th>فعال</th><th>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((method) => (
                    <tr key={method.id}>
                      <td className="font-mono text-[12px]" dir="ltr">{method.code}</td>
                      <td><b>{method.name}</b></td>
                      <td>
                        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold",
                          method.type === "express" ? "bg-[#C1613B]/12 text-[#8A3B30]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
                          {SHIPPING_TYPE_LABEL[method.type]}
                        </span>
                      </td>
                      <td><button onClick={() => { setRulesFor(rulesFor === method.id ? null : method.id); setQuoteResult(null); }} className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", rulesFor === method.id ? "bg-[var(--kv-accent)]/15 text-[var(--kv-accent)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{SHIPPING_PRICING_TYPE_LABEL[method.pricingType]}{method.rules.length > 0 && ` · ${method.rules.length.toLocaleString("fa-IR")}`}</button></td>
                      <td className="tabular-nums">{Number(method.baseFeeRial) === 0 ? "رایگان" : fmtMoney(Number(method.baseFeeRial))}</td>
                      <td className="tabular-nums">{method.freeAboveRial ? fmtMoney(Number(method.freeAboveRial)) : "—"}</td>
                      <td className="tabular-nums">{fa(`${method.estimatedMinDays} تا ${method.estimatedMaxDays} روز`)}</td>
                      <td><Switch on={method.active} onToggle={() => void toggle(method)} /></td>
                      <td>
                        <span className="flex gap-2">
                          <button
                            onClick={() => { setEditId(method.id); setEdit({ ...method }); }}
                            className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label={`ویرایش ${method.name}`}
                          ><Pencil size={15} /></button>
                          <button
                            onClick={() => void remove(method)}
                            className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`غیرفعال کردن ${method.name}`}
                          ><Trash2 size={15} /></button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
        {rulesFor && (() => {
          const method = (items ?? []).find((m) => m.id === rulesFor);
          if (!method) return null;
          const rules = [...method.rules].sort((a, b) => a.position - b.position);
          return (
            <Card className="mt-4 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
                <div><p className="text-sm font-extrabold">قوانین قیمت‌گذاری «{method.name}»</p>
                  <p className="text-[11.5px] text-[var(--kv-muted)]">نخستین قانونِ منطبق (بر اساس ترتیب) اعمال می‌شود؛ در صورت عدم تطبیق، هزینه پایه.</p></div>
                <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => { setRuleEditId(null); setRuleEdit({ ...blankRule(), position: rules.length }); }}>قانون جدید</Btn>
              </div>
              {rules.length === 0 ? <p className="px-4 pb-4 text-[12.5px] text-[var(--kv-muted)]">قانونی ثبت نشده — هزینه پایه ({method.baseFeeRial === "0" ? "رایگان" : fmtMoney(Number(method.baseFeeRial))}) اعمال می‌شود.</p> : (
                <div className="kv-scroll overflow-x-auto">
                  <table className="kv-table min-w-[760px]">
                    <thead><tr><th>ترتیب</th><th>نوع</th><th>شرط</th><th>هزینه</th><th>فعال</th><th></th></tr></thead>
                    <tbody>
                      {rules.map((rule: ShippingPriceRule) => (
                        <tr key={rule.id}>
                          <td className="tabular-nums">{rule.position.toLocaleString("fa-IR")}</td>
                          <td>{SHIPPING_RULE_TYPE_LABEL[rule.ruleType]}</td>
                          <td className="text-[12px] tabular-nums">
                            {[rule.minWeightGrams != null || rule.maxWeightGrams != null ? `وزن ${rule.minWeightGrams?.toLocaleString("fa-IR") ?? "۰"} تا ${rule.maxWeightGrams?.toLocaleString("fa-IR") ?? "∞"} گرم` : null,
                              rule.minOrderRial || rule.maxOrderRial ? `مبلغ ${rule.minOrderRial ? fmtMoney(Number(rule.minOrderRial)) : "۰"} تا ${rule.maxOrderRial ? fmtMoney(Number(rule.maxOrderRial)) : "∞"}` : null,
                              rule.province ? `استان ${rule.province}` : null, rule.city ? `شهر ${rule.city}` : null].filter(Boolean).join(" · ") || "—"}
                          </td>
                          <td className="font-bold tabular-nums">{rule.feeRial === "0" ? "رایگان" : fmtMoney(Number(rule.feeRial))}</td>
                          <td><Switch on={rule.active} onToggle={() => void (async () => { try { await shippingApi.updateRule(rule.id, { active: !rule.active }); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} /></td>
                          <td><span className="flex gap-2">
                            <button onClick={() => { setRuleEditId(rule.id); setRuleEdit({ ruleType: rule.ruleType, minWeightGrams: rule.minWeightGrams, maxWeightGrams: rule.maxWeightGrams, minOrderRial: rule.minOrderRial, maxOrderRial: rule.maxOrderRial, province: rule.province, city: rule.city, feeRial: rule.feeRial, position: rule.position, active: rule.active }); }} className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label="ویرایش قانون"><Pencil size={14} /></button>
                            <button onClick={() => void (async () => { try { await shippingApi.deleteRule(rule.id); await load(); flash("قانون حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف قانون"><Trash2 size={14} /></button>
                          </span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="border-t border-[var(--kv-line)] p-4">
                <p className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold"><Ruler size={14} />تست نرخ (همان موتوری که تسویه‌حساب استفاده می‌کند)</p>
                <div className="grid gap-2 sm:grid-cols-2 sm:items-end xl:grid-cols-[1fr_90px_140px_140px_auto]">
                  <Field label="شناسه واریانت"><Input value={quote.variantId} onChange={(v) => setQuote({ ...quote, variantId: v })} placeholder="uuid — از کشوی موجودی محصول" /></Field>
                  <Field label="تعداد"><Input value={quote.quantity} onChange={(v) => setQuote({ ...quote, quantity: v.replace(/\D/g, "") })} /></Field>
                  <Field label="جمع سبد (ریال)"><Input value={quote.subtotalRial} onChange={(v) => setQuote({ ...quote, subtotalRial: v.replace(/\D/g, "") })} /></Field>
                  <Field label="استان"><Input value={quote.province} onChange={(v) => setQuote({ ...quote, province: v })} placeholder="تهران" /></Field>
                  <Btn variant="soft" size="sm" disabled={busy || !quote.variantId.trim()} onClick={() => void testQuote()}>محاسبه</Btn>
                </div>
                {quoteResult && <p className="mt-2 rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2 text-[12.5px] font-bold">{quoteResult}</p>}
              </div>
            </Card>
          );
        })()}
      </div>

      <Card className="h-fit p-5">
        <p className="text-sm font-bold">قوانین سراسری ارسال</p>
        {!settings ? (
          <p className="mt-3 text-[12.5px] text-[var(--kv-muted)]">قوانین سراسری از سرور خوانده نشد؛ بازخوانی کنید.</p>
        ) : (
          <div className="mt-3 space-y-3">
            <Field label="ارسال رایگان از مبلغ (ریال)" hint="۰ = غیرفعال">
              <Input
                value={settings.freeShippingThresholdRial}
                onChange={(v) => setSettings({ ...settings, freeShippingThresholdRial: v.replace(/\D/g, "") || "0" })}
              />
            </Field>
            <Field label="انبار پیش‌فرض ارسال" hint="از فهرست واقعی انبارهای ثبت‌شده انتخاب می‌شود">
              <Select
                options={["انتخاب انبار…", ...(warehouses ?? []).map((w) => `${w.code} — ${w.name}`)]}
                value={settings.defaultWarehouseId
                  ? (warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)
                    ? `${(warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)!.code} — ${(warehouses ?? []).find((w) => w.id === settings.defaultWarehouseId)!.name}`
                    : "انتخاب انبار…"
                  : "انتخاب انبار…"}
                onChange={(label) => {
                  const match = (warehouses ?? []).find((w) => `${w.code} — ${w.name}` === label);
                  setSettings({ ...settings, defaultWarehouseId: match?.id ?? null });
                }}
              />
            </Field>
            {settings.defaultWarehouseId && (
              <p className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{settings.defaultWarehouseId}</p>
            )}
            {!(warehouses ?? []).length && (
              <p className="text-[11.5px] leading-6 text-[var(--kv-warn,#B7791F)]">
                هنوز انباری ثبت نشده است؛ از بخش «انبار و موجودی» نخستین انبار را بسازید.
              </p>
            )}
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">
              رهگیری خودکار از API حامل
              <Switch on={settings.autoTracking} onToggle={() => setSettings({ ...settings, autoTracking: !settings.autoTracking })} />
            </label>
            <Btn variant="soft" size="sm" disabled={busy} onClick={() => void saveSettings()}>
              {saved ? "ذخیره شد ✓" : "ذخیره قوانین"}
            </Btn>
          </div>
        )}
      </Card>

      <Drawer open={!!edit} onClose={() => { setEdit(null); setEditId(null); }} title={editId ? `ویرایش ${edit?.name ?? ""}` : "روش ارسال جدید"}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد روش ارسال" hint="حروف انگلیسی کوچک، عدد، - و _">
                <Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v.toLowerCase() })} placeholder="post-pishtaz" />
              </Field>
              <Field label="نام روش"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="مثلاً پست پیشتاز" /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="نوع ارسال">
                <Select
                  options={SHIPPING_TYPES.map((type) => SHIPPING_TYPE_LABEL[type])}
                  value={SHIPPING_TYPE_LABEL[edit.type]}
                  onChange={(label) => {
                    const type = (Object.keys(SHIPPING_TYPE_LABEL) as ShippingType[]).find((key) => SHIPPING_TYPE_LABEL[key] === label);
                    if (type) setEdit({ ...edit, type });
                  }}
                />
              </Field>
              <Field label="نحوه قیمت‌گذاری" hint="وزنی/مبلغی/مقصدی با جدول قوانین زیر محاسبه می‌شود">
                <Select
                  options={SHIPPING_PRICING_TYPES.map((type) => SHIPPING_PRICING_TYPE_LABEL[type])}
                  value={SHIPPING_PRICING_TYPE_LABEL[edit.pricingType ?? "flat"]}
                  onChange={(label) => {
                    const pricingType = (Object.keys(SHIPPING_PRICING_TYPE_LABEL) as ShippingPricingType[]).find((key) => SHIPPING_PRICING_TYPE_LABEL[key] === label);
                    if (pricingType) setEdit({ ...edit, pricingType });
                  }}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="هزینه پایه (ریال)" hint="۰ = ارسال رایگان">
                <Input value={edit.baseFeeRial} onChange={(v) => setEdit({ ...edit, baseFeeRial: v.replace(/\D/g, "") || "0" })} />
              </Field>
              <Field label="ارسال رایگان از مبلغ (ریال)" hint="خالی = بدون ارسال رایگان">
                <Input
                  value={edit.freeAboveRial ?? ""}
                  onChange={(v) => setEdit({ ...edit, freeAboveRial: v.replace(/\D/g, "") || null })}
                  placeholder="—"
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="حداقل زمان تحویل (روز)">
                <Input value={String(edit.estimatedMinDays)} onChange={(v) => setEdit({ ...edit, estimatedMinDays: Number(v.replace(/\D/g, "")) || 0 })} />
              </Field>
              <Field label="حداکثر زمان تحویل (روز)">
                <Input value={String(edit.estimatedMaxDays)} onChange={(v) => setEdit({ ...edit, estimatedMaxDays: Number(v.replace(/\D/g, "")) || 0 })} />
              </Field>
            </div>
            {edit.pricingType === "carrier" && (
              <p role="alert" className="rounded-[12px] bg-[#B7791F]/10 px-4 py-3 text-[12.5px] leading-6">
                قیمت‌گذاری از سامانه باربری خوانده می‌شود. تا زمان پیکربندی اتصال، موتور نرخ برای این روش خطا می‌دهد و تسویه‌حساب با هزینه پایه ادامه پیدا نمی‌کند — مشخصات اتصال را در پیکربندی زیر ثبت کنید.
              </p>
            )}
            <Field label="پیکربندی (JSON)" hint="اختیاری · مثلاً مشخصات اتصال سامانه باربری">
              <Textarea
                rows={3}
                value={typeof edit.config === "object" ? JSON.stringify(edit.config ?? {}) : String(edit.config ?? "")}
                onChange={(v) => {
                  try {
                    setEdit({ ...edit, config: v.trim() ? (JSON.parse(v) as Record<string, unknown>) : {} });
                  } catch { /* keep typing; invalid JSON is rejected on save */ }
                }}
              />
            </Field>
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">
              فعال در فروشگاه
              <Switch on={edit.active} onToggle={() => setEdit({ ...edit, active: !edit.active })} />
            </label>
            <Btn variant="accent" className="w-full" disabled={busy || !edit.name.trim() || !edit.code.trim()} onClick={() => void save()}>
              ذخیره روش ارسال
            </Btn>
          </div>
        )}
      </Drawer>

      <Drawer open={!!ruleEdit} onClose={() => { setRuleEdit(null); setRuleEditId(null); }} title={ruleEditId ? "ویرایش قانون" : "قانون جدید"}>
        {ruleEdit && (
          <div className="space-y-4">
            <Field label="نوع قانون">
              <Select
                options={SHIPPING_RULE_TYPES.map((type) => SHIPPING_RULE_TYPE_LABEL[type])}
                value={SHIPPING_RULE_TYPE_LABEL[ruleEdit.ruleType]}
                onChange={(label) => {
                  const ruleType = (Object.keys(SHIPPING_RULE_TYPE_LABEL) as ShippingRuleType[]).find((key) => SHIPPING_RULE_TYPE_LABEL[key] === label);
                  if (ruleType) setRuleEdit({ ...ruleEdit, ruleType });
                }}
              />
            </Field>
            {(ruleEdit.ruleType === "weight" || ruleEdit.minWeightGrams != null || ruleEdit.maxWeightGrams != null) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="کف وزن (گرم)" hint="خالی = بدون کف"><Input value={ruleEdit.minWeightGrams == null ? "" : String(ruleEdit.minWeightGrams)} onChange={(v) => setRuleEdit({ ...ruleEdit, minWeightGrams: v === "" ? null : Number(v.replace(/\D/g, "")) })} /></Field>
                <Field label="سقف وزن (گرم)" hint="خالی = بدون سقف"><Input value={ruleEdit.maxWeightGrams == null ? "" : String(ruleEdit.maxWeightGrams)} onChange={(v) => setRuleEdit({ ...ruleEdit, maxWeightGrams: v === "" ? null : Number(v.replace(/\D/g, "")) })} /></Field>
              </div>
            )}
            {(ruleEdit.ruleType === "order_value" || ruleEdit.minOrderRial || ruleEdit.maxOrderRial) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="کف مبلغ سفارش (ریال)"><Input value={ruleEdit.minOrderRial ?? ""} onChange={(v) => setRuleEdit({ ...ruleEdit, minOrderRial: v.replace(/\D/g, "") || null })} /></Field>
                <Field label="سقف مبلغ سفارش (ریال)"><Input value={ruleEdit.maxOrderRial ?? ""} onChange={(v) => setRuleEdit({ ...ruleEdit, maxOrderRial: v.replace(/\D/g, "") || null })} /></Field>
              </div>
            )}
            {(ruleEdit.ruleType === "destination" || ruleEdit.province || ruleEdit.city) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="استان (اختیاری)"><Input value={ruleEdit.province ?? ""} onChange={(v) => setRuleEdit({ ...ruleEdit, province: v.trim() || null })} placeholder="تهران" /></Field>
                <Field label="شهر (اختیاری)"><Input value={ruleEdit.city ?? ""} onChange={(v) => setRuleEdit({ ...ruleEdit, city: v.trim() || null })} /></Field>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="هزینه (ریال)" hint="۰ = رایگان"><Input value={ruleEdit.feeRial} onChange={(v) => setRuleEdit({ ...ruleEdit, feeRial: v.replace(/\D/g, "") || "0" })} /></Field>
              <Field label="ترتیب اعمال" hint="عدد کمتر = اولویت بیشتر"><Input value={String(ruleEdit.position ?? 0)} onChange={(v) => setRuleEdit({ ...ruleEdit, position: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
            </div>
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">
              فعال
              <Switch on={ruleEdit.active ?? true} onToggle={() => setRuleEdit({ ...ruleEdit, active: !(ruleEdit.active ?? true) })} />
            </label>
            <Btn variant="accent" className="w-full" disabled={busy} onClick={() => void saveRule()}>ذخیره قانون</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}
