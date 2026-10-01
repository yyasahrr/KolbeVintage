import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, PartyPopper, RefreshCw, Trash2 } from "lucide-react";
import { Btn, Checkbox, Drawer, Field, Input, LoadingState, Segmented, Select } from "./primitives";
import { productsApi, promotionRulesApi } from "../data/api";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const money = (v: string | number) => `${fa(Number(v).toLocaleString("en-US"))} ریال`;

type VariantRow = { id: string; sku: string; color: string | null; size: string | null; active: boolean };
type RuleRow = {
  id: string; name: string | null; target_type: string; color_id: string | null; size_code: string | null;
  variant_id: string | null; variant_sku: string | null; discount_type: string; discount_value: string;
  active: boolean; promotion_id: string | null; promotion_kind: string | null; promotion_name: string | null;
  effectively_suspended: boolean; suspended_by_name: string | null; starts_at: string | null; ends_at: string | null;
};
type Summary = {
  activeFestival: { promotionId: string; name: string; endsAt: string | null } | null;
  activeStandaloneRules: number;
  suspendedStandaloneRules: number;
};
type Festival = { id: string; name: string; kind: string; active: boolean };

/**
 * A2-A6: per-product discount & festival manager, opened from the product table row.
 * All state comes from the server (rules, summary, canonical pricing preview) —
 * there is no second pricing engine here.
 */
export function DiscountManager({ productId, productName, productImage, sku, onClose, flash }: {
  productId: string; productName: string; productImage?: string; sku?: string;
  onClose: () => void; flash: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [basePrice, setBasePrice] = useState<string | null>(null);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [festivals, setFestivals] = useState<Festival[]>([]);
  const [busy, setBusy] = useState(false);

  // discount form
  const [dType, setDType] = useState<"percent" | "fixed_rial">("percent");
  const [dValue, setDValue] = useState("");
  const [scope, setScope] = useState<"product" | "color" | "size" | "variant">("product");
  const [pickedColors, setPickedColors] = useState<Set<string>>(new Set());
  const [pickedSizes, setPickedSizes] = useState<Set<string>>(new Set());
  const [pickedVariants, setPickedVariants] = useState<Set<string>>(new Set());

  // festival attach form
  const [festivalPick, setFestivalPick] = useState("");
  const [festivalValue, setFestivalValue] = useState("");
  const [confirmMove, setConfirmMove] = useState(false);

  // preview
  const [previewVariant, setPreviewVariant] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, ruleList, sum, promoList] = await Promise.all([
        productsApi.adminDetail(productId),
        promotionRulesApi.rulesByProduct(productId),
        promotionRulesApi.productSummary(productId),
        promotionRulesApi.list(),
      ]);
      const vts = (detail.variants as Record<string, unknown>[]).map((v) => ({
        id: String(v.id), sku: String(v.sku), color: (v.color as string | null) ?? null,
        size: (v.size as string | null) ?? null, active: v.active !== false,
      }));
      setVariants(vts);
      setBasePrice(detail.cash_price_rial ? String(detail.cash_price_rial) : null);
      setRules(ruleList.items as unknown as RuleRow[]);
      setSummary(sum);
      setFestivals(((promoList.promotions ?? []) as unknown as Festival[]).filter((p) => p.kind === "festival" && p.active));
      if (vts.length > 0 && !previewVariant) setPreviewVariant(vts[0]!.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در بارگذاری اطلاعات تخفیف");
    } finally { setLoading(false); }
  }, [productId, flash, previewVariant]);
  useEffect(() => { void reload(); }, [reload]);

  // A3: pricing preview comes from the canonical server resolver.
  useEffect(() => {
    if (!previewVariant) return;
    let on = true;
    void promotionRulesApi.resolveVariantPrice(previewVariant).then((r) => { if (on) setPreview(r); }).catch(() => { if (on) setPreview(null); });
    return () => { on = false; };
  }, [previewVariant, rules, summary]);

  const colors = useMemo(() => [...new Set(variants.map((v) => v.color).filter(Boolean))] as string[], [variants]);
  const sizes = useMemo(() => [...new Set(variants.map((v) => v.size).filter(Boolean))] as string[], [variants]);
  const inFestival = !!summary?.activeFestival;

  const toggle = (set: Set<string>, value: string, apply: (next: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    apply(next);
  };

  const createStandalone = async () => {
    const value = Number(dValue);
    if (!value || value <= 0) { flash("مقدار تخفیف را وارد کنید."); return; }
    setBusy(true);
    try {
      const base = { discountType: dType, discountValue: value, productId };
      const key = () => `dm-${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (scope === "product") {
        await promotionRulesApi.createRule({ ...base, targetType: "product", name: `تخفیف ${productName}` }, key());
      } else if (scope === "color") {
        if (pickedColors.size === 0) { flash("حداقل یک رنگ انتخاب کنید."); setBusy(false); return; }
        for (const color of pickedColors) await promotionRulesApi.createRule({ ...base, targetType: "color", colorId: color, name: `تخفیف رنگ ${color}` }, key());
      } else if (scope === "size") {
        if (pickedSizes.size === 0) { flash("حداقل یک سایز انتخاب کنید."); setBusy(false); return; }
        for (const size of pickedSizes) await promotionRulesApi.createRule({ ...base, targetType: "size", sizeCode: size, name: `تخفیف سایز ${size}` }, key());
      } else {
        if (pickedVariants.size === 0) { flash("حداقل یک تنوع انتخاب کنید."); setBusy(false); return; }
        for (const variantId of pickedVariants) await promotionRulesApi.createRule({ ...base, targetType: "variant", variantId, name: "تخفیف تنوع دقیق" }, key());
      }
      flash("تخفیف ثبت شد.");
      setDValue(""); setPickedColors(new Set()); setPickedSizes(new Set()); setPickedVariants(new Set());
      await reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در ثبت تخفیف");
    } finally { setBusy(false); }
  };

  const attachFestival = async () => {
    const festival = festivals.find((f) => f.name === festivalPick);
    const value = Number(festivalValue);
    if (!festival) { flash("یک جشنواره انتخاب کنید."); return; }
    if (!value || value <= 0) { flash("درصد تخفیف جشنواره را وارد کنید."); return; }
    if (inFestival && summary?.activeFestival?.promotionId !== festival.id && !confirmMove) {
      flash("برای انتقال محصول بین دو جشنواره، تأیید صریح را فعال کنید."); return;
    }
    setBusy(true);
    try {
      await promotionRulesApi.createRule({
        promotionId: festival.id, targetType: "product", productId,
        discountType: "percent", discountValue: value, name: `جشنواره ${festival.name}`,
        ...(confirmMove ? { moveFromFestival: true } : {}),
      }, `dm-fest-${productId}-${Date.now()}`);
      flash(`محصول وارد جشنواره «${festival.name}» شد؛ تخفیف‌های مستقل تا پایان جشنواره معلق شدند.`);
      setFestivalPick(""); setFestivalValue(""); setConfirmMove(false);
      await reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در اتصال جشنواره");
    } finally { setBusy(false); }
  };

  const leaveFestival = async () => {
    const festivalRule = rules.find((r) => r.promotion_kind === "festival" && r.active && r.promotion_id === summary?.activeFestival?.promotionId);
    if (!festivalRule) return;
    setBusy(true);
    try {
      await promotionRulesApi.deactivateRule(festivalRule.id);
      flash("محصول از جشنواره خارج شد؛ تخفیف‌های مستقل معتبر به‌صورت خودکار برگشتند.");
      await reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در خروج از جشنواره");
    } finally { setBusy(false); }
  };

  const removeRule = async (rule: RuleRow) => {
    setBusy(true);
    try {
      await promotionRulesApi.deactivateRule(rule.id);
      flash("قانون تخفیف غیرفعال شد.");
      await reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در حذف قانون");
    } finally { setBusy(false); }
  };

  const ruleLabel = (rule: RuleRow) => {
    const target = rule.target_type === "product" ? "کل محصول"
      : rule.target_type === "color" ? `رنگ ${rule.color_id ?? ""}`
      : rule.target_type === "size" ? `سایز ${rule.size_code ?? ""}`
      : rule.target_type === "variant" ? `تنوع ${rule.variant_sku ?? ""}` : rule.target_type;
    const amount = rule.discount_type === "percent" ? `${fa(rule.discount_value)}٪` : money(rule.discount_value);
    return `${target} — ${amount}`;
  };

  return (
    <Drawer open onClose={onClose} title="تخفیف و جشنواره" wide>
      {loading ? <LoadingState /> : (
        <div className="space-y-4 pb-6">
          {/* product header */}
          <div className="flex items-center gap-3 rounded-[12px] bg-[var(--kv-surface-2)] p-3">
            {productImage && <img src={productImage} alt="" className="h-12 w-11 rounded-lg object-cover" />}
            <div className="min-w-0">
              <b className="block truncate">{productName}</b>
              <span className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{sku}</span>
              {basePrice && <span className="block text-[12px] font-bold">{money(basePrice)}</span>}
            </div>
            <div className="mr-auto flex flex-col items-end gap-1 text-[11.5px]">
              {summary?.activeFestival
                ? <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-800">جشنواره: {summary.activeFestival.name}</span>
                : <span className="rounded-full bg-[var(--kv-surface)] px-2 py-0.5 text-[var(--kv-muted)]">بدون جشنواره فعال</span>}
              <span className="text-[var(--kv-muted)]">
                {fa(summary?.activeStandaloneRules ?? 0)} تخفیف فعال · {fa(summary?.suspendedStandaloneRules ?? 0)} معلق
              </span>
            </div>
          </div>

          {/* A5: festival state — standalone controls are greyed out */}
          {inFestival && (
            <div className="rounded-[12px] border border-amber-300 bg-amber-50 p-3 text-[12.5px] leading-6 text-amber-900">
              این محصول در جشنواره فعال «{summary!.activeFestival!.name}» است. تخفیف‌های مستقل به حالت تعلیق درآمده‌اند و تا پایان یا خروج از جشنواره
              امکان ثبت یا ویرایش تخفیف مستقل وجود ندارد. با خروج از جشنواره، تخفیف‌های مستقلی که هنوز در بازه اعتبارشان هستند به‌صورت خودکار فعال می‌شوند.
              <div className="mt-2">
                <Btn size="sm" variant="soft" onClick={() => void leaveFestival()} disabled={busy}>خروج محصول از جشنواره</Btn>
              </div>
            </div>
          )}

          {/* existing rules */}
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold"><BadgePercent size={14} />قوانین فعلی</h4>
            {rules.filter((r) => r.active).length === 0
              ? <p className="text-[12px] text-[var(--kv-muted)]">هیچ تخفیفی برای این محصول ثبت نشده است.</p>
              : (
                <ul className="space-y-1.5">
                  {rules.filter((r) => r.active).map((rule) => (
                    <li key={rule.id} className={cn(
                      "flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[12.5px]",
                      rule.effectively_suspended ? "border-gray-200 bg-gray-50 text-gray-400" : "border-[var(--kv-border)]",
                    )}>
                      <span className="font-semibold">{ruleLabel(rule)}</span>
                      {rule.promotion_kind === "festival" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-bold text-amber-800">{rule.promotion_name}</span>}
                      {rule.effectively_suspended && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10.5px] font-bold text-gray-500">معلق به دلیل جشنواره</span>}
                      <button className="mr-auto text-red-400 hover:text-red-600" title="غیرفعال‌سازی" onClick={() => void removeRule(rule)} disabled={busy}>
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </div>

          {/* A2: standalone discount form (disabled while in a festival) */}
          <div className={cn("rounded-[12px] border border-[var(--kv-border)] p-3", inFestival && "pointer-events-none opacity-45")}>
            <h4 className="mb-2 text-[13px] font-extrabold">ثبت تخفیف مستقل</h4>
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="نوع تخفیف">
                <Segmented
                  options={[{ v: "percent", label: "درصدی" }, { v: "fixed_rial", label: "مبلغ ثابت" }]}
                  value={dType} onChange={setDType}
                />
              </Field>
              <Field label={dType === "percent" ? "درصد (۱ تا ۹۵)" : "مبلغ (ریال)"}>
                <Input value={dValue} onChange={setDValue} placeholder={dType === "percent" ? "مثلاً 20" : "مثلاً 500000"} />
              </Field>
              <Field label="محدوده اعمال">
                <Select
                  options={["کل محصول", "رنگ(های) خاص", "سایز(های) خاص", "تنوع دقیق (رنگ×سایز)"]}
                  value={scope === "product" ? "کل محصول" : scope === "color" ? "رنگ(های) خاص" : scope === "size" ? "سایز(های) خاص" : "تنوع دقیق (رنگ×سایز)"}
                  onChange={(v) => setScope(v === "کل محصول" ? "product" : v === "رنگ(های) خاص" ? "color" : v === "سایز(های) خاص" ? "size" : "variant")}
                />
              </Field>
            </div>

            {scope === "color" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {colors.map((color) => (
                  <Checkbox key={color} checked={pickedColors.has(color)} onChange={() => toggle(pickedColors, color, setPickedColors)} label={color} />
                ))}
              </div>
            )}
            {scope === "size" && (
              <div className="mt-2 flex flex-wrap gap-2">
                {sizes.map((size) => (
                  <Checkbox key={size} checked={pickedSizes.has(size)} onChange={() => toggle(pickedSizes, size, setPickedSizes)} label={size} />
                ))}
              </div>
            )}
            {scope === "variant" && colors.length > 0 && sizes.length > 0 && (
              <div className="kv-scroll mt-2 overflow-x-auto">
                {/* color × size matrix — nonexistent variants are disabled (stock 0 ≠ nonexistent) */}
                <table className="kv-table min-w-[320px] text-xs">
                  <thead><tr><th>رنگ \ سایز</th>{sizes.map((s) => <th key={s}>{s}</th>)}</tr></thead>
                  <tbody>
                    {colors.map((color) => (
                      <tr key={color}>
                        <td className="font-bold">{color}</td>
                        {sizes.map((size) => {
                          const variant = variants.find((v) => v.color === color && v.size === size);
                          return (
                            <td key={size} className="text-center">
                              {variant
                                ? <input type="checkbox" className="h-4 w-4 accent-[var(--kv-accent)]"
                                    checked={pickedVariants.has(variant.id)}
                                    onChange={() => toggle(pickedVariants, variant.id, setPickedVariants)} />
                                : <span className="text-gray-300" title="این ترکیب رنگ و سایز وجود ندارد">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-3">
              <Btn size="sm" variant="accent" onClick={() => void createStandalone()} disabled={busy}>ثبت تخفیف</Btn>
            </div>
          </div>

          {/* A4: festival selector */}
          <div className="rounded-[12px] border border-[var(--kv-border)] p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold"><PartyPopper size={14} />اتصال به جشنواره</h4>
            {festivals.length === 0
              ? <p className="text-[12px] text-[var(--kv-muted)]">جشنواره فعالی تعریف نشده است. ابتدا از بخش «کوپن و جشنواره» یک جشنواره بسازید.</p>
              : (
                <div className="flex flex-wrap items-end gap-2.5">
                  <Field label="جشنواره">
                    <Select options={festivals.map((f) => f.name)} value={festivalPick} onChange={setFestivalPick} />
                  </Field>
                  <Field label="درصد تخفیف جشنواره">
                    <Input value={festivalValue} onChange={setFestivalValue} placeholder="مثلاً 25" />
                  </Field>
                  {inFestival && (
                    <Checkbox checked={confirmMove} onChange={setConfirmMove}
                      label={<span className="text-[11.5px]">تأیید می‌کنم محصول از جشنواره فعلی خارج و به جشنواره جدید منتقل شود.</span>} />
                  )}
                  <Btn size="sm" variant="soft" onClick={() => void attachFestival()} disabled={busy}>اتصال محصول</Btn>
                </div>
              )}
          </div>

          {/* A3: canonical server-side pricing preview */}
          <div className="rounded-[12px] border border-[var(--kv-border)] p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold"><RefreshCw size={14} />پیش‌نمایش قیمت (محاسبه سرور)</h4>
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="تنوع">
                <Select options={variants.map((v) => v.sku)} value={variants.find((v) => v.id === previewVariant)?.sku ?? ""}
                  onChange={(skuPick) => { const v = variants.find((x) => x.sku === skuPick); if (v) setPreviewVariant(v.id); }} />
              </Field>
              {preview ? (
                <div className="text-[12.5px] leading-6">
                  <span className="block">قیمت پایه: <b>{money(String(preview.basePrice ?? "0"))}</b></span>
                  <span className="block">تخفیف: <b>{money(String(preview.discountAmount ?? "0"))}</b>{preview.source === "festival" ? " (جشنواره)" : preview.source === "promotion_rule" ? " (تخفیف مستقل)" : ""}</span>
                  <span className="block text-[13.5px] font-extrabold text-[var(--kv-accent)]">قیمت نهایی: {money(String(preview.finalPrice ?? "0"))}</span>
                </div>
              ) : <span className="text-[12px] text-[var(--kv-muted)]">برای این تنوع قیمت قابل محاسبه نیست.</span>}
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
