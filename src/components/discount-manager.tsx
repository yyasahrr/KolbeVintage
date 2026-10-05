import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, Check, PartyPopper, RefreshCw, Save } from "lucide-react";
import { Btn, Card, Empty, Field, Input, LoadingState, Segmented, Select, Switch, WorkspaceModal } from "./primitives";
import { productsApi, promotionRulesApi } from "../data/api";
import {
  fmtToman, INSTALLMENT_POLICIES, INSTALLMENT_POLICY_LABEL, rialFromToman, tomanFromRial,
  type InstallmentPolicy,
} from "../data/contracts";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const rialForRule = (type: "percent" | "fixed_rial", value: string) => type === "percent" ? String(Number(value)) : rialFromToman(value);
const newKey = (productId: string) => `product-pricing-${productId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

type Channel = "retail" | "wholesale";
type VariantRow = { id: string; sku: string; color: string | null; size: string | null; active: boolean };
type RuleRow = {
  id: string; name: string | null; channel: Channel | "all"; target_type: string; product_id: string | null;
  color_id: string | null; size_code: string | null; variant_id: string | null; variant_sku: string | null;
  discount_type: "percent" | "fixed_rial"; discount_value: string; active: boolean;
  promotion_id: string | null; promotion_kind: string | null; promotion_name: string | null;
  effectively_suspended: boolean; suspended_by_name: string | null; starts_at: string | null; ends_at: string | null;
};
type Festival = {
  id: string; name: string; kind: string; channel: Channel | "all"; active: boolean;
  starts_at: string | null; ends_at: string | null;
};
type Summary = Awaited<ReturnType<typeof promotionRulesApi.productSummary>>;
type ResolverLine = {
  variantId: string; sku: string; color: string | null; size: string | null;
  basePrice: string; discountAmount: string; finalPrice: string; source: "none" | "promotion_rule" | "festival";
  matchedRule: { id: string; name: string | null; promotionId: string | null } | null;
};
type BaseDraft = { cashToman: string; installmentToman: string; wholesaleToman: string; installmentPolicy: InstallmentPolicy };

/**
 * Product-specific commercial workspace shared by Product Studio and Product 360.
 * Prices live in catalog price columns; Discount/Festival rules stay in the canonical
 * promotion_rules/promotions tables and every preview comes from the checkout resolver.
 */
export function DiscountManager({ productId, productName, productImage, sku, onClose, flash }: {
  productId: string; productName: string; productImage?: string; sku?: string;
  onClose: () => void; flash: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [festivals, setFestivals] = useState<Festival[]>([]);
  const [channel, setChannel] = useState<Channel>("retail");
  const [paymentMode, setPaymentMode] = useState<"cash" | "four_installments">("cash");
  const [base, setBase] = useState<BaseDraft>({ cashToman: "", installmentToman: "", wholesaleToman: "", installmentPolicy: "enabled" });
  const [busy, setBusy] = useState(false);
  const [showDiscountDetails, setShowDiscountDetails] = useState(false);
  const [showFestivalDetails, setShowFestivalDetails] = useState(false);
  const [ruleType, setRuleType] = useState<"percent" | "fixed_rial">("percent");
  const [ruleValue, setRuleValue] = useState("");
  const [ruleScope, setRuleScope] = useState<"product" | "color" | "size" | "variant">("product");
  const [ruleTarget, setRuleTarget] = useState("");
  const [festivalPick, setFestivalPick] = useState("");
  const [festivalValue, setFestivalValue] = useState("15");
  const [confirmFestivalExit, setConfirmFestivalExit] = useState(false);
  const [confirmFestivalMove, setConfirmFestivalMove] = useState(false);
  const [editingRule, setEditingRule] = useState<{ id: string; value: string } | null>(null);
  const [previewLines, setPreviewLines] = useState<ResolverLine[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const [product, ruleList, productSummary, promotionList] = await Promise.all([
        productsApi.adminDetail(productId),
        promotionRulesApi.rulesByProduct(productId),
        promotionRulesApi.productSummary(productId),
        promotionRulesApi.list(),
      ]);
      const rows = (product.variants ?? []).map((raw) => {
        const variant = raw as unknown as Record<string, unknown>;
        return {
          id: String(variant.id), sku: String(variant.sku),
          color: variant.color === null || variant.color === undefined ? null : String(variant.color),
          size: variant.size === null || variant.size === undefined ? null : String(variant.size),
          active: variant.active !== false,
        } satisfies VariantRow;
      });
      setDetail(product);
      setVariants(rows);
      setRules(ruleList.items as unknown as RuleRow[]);
      setSummary(productSummary);
      setShowDiscountDetails(productSummary.activeStandaloneRules > 0);
      setShowFestivalDetails(Boolean(productSummary.assignedFestival?.active && productSummary.assignedFestival.promotionActive
        && (!productSummary.assignedFestival.endsAt || new Date(productSummary.assignedFestival.endsAt).getTime() > Date.now())));
      setFestivals((promotionList.promotions ?? []).filter((promotion) => {
        const row = promotion as unknown as Festival;
        return row.kind === "festival" && row.active && (!row.ends_at || new Date(row.ends_at).getTime() > Date.now());
      }) as unknown as Festival[]);
      setBase({
        cashToman: product.cash_price_rial === null || product.cash_price_rial === undefined ? "" : String(tomanFromRial(product.cash_price_rial)),
        installmentToman: product.installment_price_rial === null || product.installment_price_rial === undefined ? "" : String(tomanFromRial(product.installment_price_rial)),
        wholesaleToman: product.wholesale_price_rial === null || product.wholesale_price_rial === undefined ? "" : String(tomanFromRial(product.wholesale_price_rial)),
        installmentPolicy: INSTALLMENT_POLICIES.includes(product.installment_policy as InstallmentPolicy)
          ? product.installment_policy as InstallmentPolicy : "enabled",
      });
      const retailAvailable = product.retail_enabled !== false;
      const wholesaleAvailable = product.wholesale_enabled !== false;
      setChannel((current) => current === "retail" && retailAvailable || current === "wholesale" && wholesaleAvailable
        ? current : retailAvailable ? "retail" : "wholesale");
      setPaymentMode("cash");
      setRuleTarget(rows.find((row) => row.active)?.id ?? "");
      setFestivalPick(productSummary.assignedFestival?.promotionId ?? "");
      const assignedFestivalRule = ruleList.items.find((rule) =>
        (rule as unknown as RuleRow).promotion_id === productSummary.assignedFestival?.promotionId
        && (rule as unknown as RuleRow).target_type === "product");
      if (assignedFestivalRule && (assignedFestivalRule as unknown as RuleRow).discount_type === "percent") {
        setFestivalValue(String(Number((assignedFestivalRule as unknown as RuleRow).discount_value)));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "بارگذاری فضای قیمت‌گذاری ناموفق بود.";
      setLoadError(message); flash(message);
    } finally { setLoading(false); }
  }, [productId, flash]);
  useEffect(() => { void reload(); }, [reload]);

  const activeVariants = useMemo(() => variants.filter((variant) => variant.active), [variants]);
  const visibleRules = useMemo(() => rules.filter((rule) => rule.channel === "all" || rule.channel === channel), [rules, channel]);
  const standaloneRules = useMemo(() => visibleRules.filter((rule) => !rule.promotion_id), [visibleRules]);
  const festivalRules = useMemo(() => visibleRules.filter((rule) => rule.promotion_id), [visibleRules]);
  const selectedFestival = festivals.find((festival) => festival.id === festivalPick);
  const normalOn = Boolean(summary?.activeStandaloneRules);
  const assigned = summary?.assignedFestival ?? null;
  const festivalBlocksNormal = Boolean(assigned?.active && assigned.promotionActive && (!assigned.endsAt || new Date(assigned.endsAt).getTime() > Date.now()));
  const festivalOn = festivalBlocksNormal;
  const canEditRetail = detail?.retail_enabled !== false;
  const canEditWholesale = detail?.wholesale_enabled !== false;
  const hasRetail = detail?.retail_enabled !== false;
  const hasWholesale = detail?.wholesale_enabled !== false;
  const installmentsOn = base.installmentPolicy !== "disabled";

  useEffect(() => {
    if ((channel === "wholesale" || !installmentsOn) && paymentMode !== "cash") setPaymentMode("cash");
  }, [channel, installmentsOn, paymentMode]);

  // One batched preview per selected channel, resolved by the exact server function used at checkout.
  useEffect(() => {
    if (!activeVariants.length) { setPreviewLines([]); setPreviewError(null); return; }
    let alive = true;
    setPreviewLoading(true); setPreviewError(null);
    promotionRulesApi.resolvePrices({
      orderType: channel,
      paymentMode,
      items: activeVariants.slice(0, 100).map((variant) => ({ variantId: variant.id, quantity: 1 })),
    }).then((result) => {
      if (alive) setPreviewLines(result.lines as unknown as ResolverLine[]);
    }).catch((error) => {
      if (alive) { setPreviewLines([]); setPreviewError(error instanceof Error ? error.message : "پیش‌نمایش موتور قیمت‌گذاری در دسترس نیست."); }
    }).finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [activeVariants, channel, paymentMode, rules, summary]);

  const saveBasePrices = async () => {
    if (!detail || busy) return;
    setBusy(true); setActionError(null);
    try {
      const patch: Record<string, unknown> = { installmentPolicy: base.installmentPolicy };
      if (canEditRetail) {
        const cashRial = rialFromToman(base.cashToman);
        if (BigInt(cashRial) <= 0n) throw new Error("قیمت نقدی خرده باید بزرگ‌تر از صفر باشد.");
        patch.cashPriceRial = cashRial;
        patch.installmentPriceRial = base.installmentToman.trim() ? rialFromToman(base.installmentToman) : null;
      }
      if (canEditWholesale) patch.wholesalePriceRial = base.wholesaleToman.trim() ? rialFromToman(base.wholesaleToman) : null;
      await productsApi.update(productId, patch);
      flash("قیمت پایه و سیاست اقساط در رکورد اصلی محصول ذخیره شد.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ذخیره قیمت پایه ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const setStandaloneMode = async (enabled: boolean, confirmExit = false) => {
    if (busy) return;
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.setProductMode(productId, { mode: "standalone", enabled, ...(confirmExit ? { confirmFestivalExit: true } : {}) });
      setConfirmFestivalExit(false);
      setShowDiscountDetails(enabled);
      if (enabled) setShowFestivalDetails(false);
      flash(enabled ? "قوانین ذخیره‌شدهٔ تخفیف محصول صریحاً فعال شدند." : "تخفیف مستقل خاموش شد؛ مقادیر و قوانین محفوظ ماندند.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "تغییر وضعیت تخفیف ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const setFestivalMode = async (promotionId: string | null, move = false) => {
    if (busy) return;
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.setProductMode(productId, promotionId === null
        ? { mode: "festival", promotionId: null }
        : {
            mode: "festival", promotionId, channel: selectedFestival?.channel === "all" ? channel : selectedFestival?.channel ?? channel,
            discountType: "percent", discountValue: Number(festivalValue), moveFromFestival: move,
          });
      setConfirmFestivalMove(false);
      setShowFestivalDetails(Boolean(promotionId));
      if (promotionId) setShowDiscountDetails(false);
      flash(promotionId ? "جشنواره از رکورد مرکزی اعمال شد؛ قوانین مستقل محفوظ و معلق شدند." : "جشنوارهٔ محصول خاموش شد؛ تخفیف‌های مستقل همچنان خاموش/معلق می‌مانند.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "تغییر وضعیت جشنواره ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const requestFestivalOn = () => {
    if (!selectedFestival) { setShowFestivalDetails(true); setActionError("یک Festival فعال از مرکز مرکزی انتخاب کنید."); return; }
    if (!Number.isInteger(Number(festivalValue)) || Number(festivalValue) < 1 || Number(festivalValue) > 95) {
      setActionError("درصد Festival باید بین ۱ تا ۹۵ باشد."); return;
    }
    if (festivalBlocksNormal && assigned?.promotionId !== selectedFestival.id) {
      setConfirmFestivalMove(true); return;
    }
    void setFestivalMode(selectedFestival.id, false);
  };

  const createStandalone = async () => {
    if (busy) return;
    const raw = ruleValue.trim();
    const numeric = Number(raw);
    if (!raw || !Number.isFinite(numeric) || numeric <= 0 || (ruleType === "percent" && (!Number.isInteger(numeric) || numeric > 95))) {
      setActionError(ruleType === "percent" ? "درصد تخفیف باید عددی بین ۱ تا ۹۵ باشد." : "مبلغ تخفیف را به تومان وارد کنید."); return;
    }
    if (ruleScope !== "product" && !ruleTarget) { setActionError("محدودهٔ تخفیف را انتخاب کنید."); return; }
    const targetVariant = activeVariants.find((variant) => variant.id === ruleTarget);
    const fields: Record<string, unknown> = {
      channel, targetType: ruleScope, productId,
      discountType: ruleType, discountValue: rialForRule(ruleType, raw),
      active: normalOn && !festivalBlocksNormal,
    };
    if (ruleScope === "color") fields.colorId = ruleTarget;
    if (ruleScope === "size") fields.sizeCode = ruleTarget;
    if (ruleScope === "variant") fields.variantId = ruleTarget;
    const duplicate = rules.find((rule) => !rule.promotion_id && rule.channel === channel && rule.target_type === ruleScope
      && (ruleScope === "product" || ruleScope === "color" && rule.color_id === ruleTarget
        || ruleScope === "size" && rule.size_code?.toUpperCase() === ruleTarget.toUpperCase()
        || ruleScope === "variant" && rule.variant_id === ruleTarget));
    if (duplicate) { setActionError("برای این هدف و کانال قانون مستقلی وجود دارد؛ مقدار همان قانون را در فهرست پایین ویرایش کنید."); return; }
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.createRule({
        ...fields,
        name: ruleScope === "product" ? `تخفیف ${productName}`
          : ruleScope === "color" ? `تخفیف رنگ ${ruleTarget}`
          : ruleScope === "size" ? `تخفیف سایز ${ruleTarget}`
          : `تخفیف ${targetVariant?.sku ?? "واریانت"}`,
      }, newKey(productId));
      setRuleValue("");
      flash(normalOn && !festivalBlocksNormal ? "قانون تخفیف ذخیره و فعال شد." : "قانون تخفیف ذخیره شد و تا فعال‌سازی صریح خاموش می‌ماند.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ثبت تخفیف ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const updateRuleValue = async (rule: RuleRow) => {
    if (busy || !editingRule || editingRule.id !== rule.id) return;
    const value = editingRule.value.trim();
    const numeric = Number(value);
    if (!value || !Number.isFinite(numeric) || numeric <= 0 || rule.discount_type === "percent" && (!Number.isInteger(numeric) || numeric > 95)) {
      setActionError("مقدار قانون معتبر نیست."); return;
    }
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.updateRule(rule.id, { discountValue: rialForRule(rule.discount_type, value) });
      setEditingRule(null); flash("مقدار قانون canonical به‌روزرسانی شد."); await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ویرایش قانون ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const toggleRule = async (rule: RuleRow) => {
    if (busy || festivalBlocksNormal && !rule.promotion_id) return;
    setBusy(true); setActionError(null);
    try {
      if (rule.effectively_suspended) await promotionRulesApi.reactivateRule(rule.id);
      else await promotionRulesApi.updateRule(rule.id, { active: !rule.active });
      flash(rule.active && !rule.effectively_suspended ? "قانون خاموش شد؛ تنظیمات آن باقی است." : "فعال‌سازی صریح قانون ثبت شد.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "تغییر قانون ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const scopeLabel = (rule: RuleRow) => rule.target_type === "product" ? "کل محصول"
    : rule.target_type === "color" ? `رنگ ${rule.color_id ?? ""}`
    : rule.target_type === "size" ? `سایز ${rule.size_code ?? ""}`
    : rule.target_type === "variant" ? `واریانت ${rule.variant_sku ?? ""}` : rule.target_type;
  const valueLabel = (rule: RuleRow) => rule.discount_type === "percent" ? `${fa(rule.discount_value)}٪` : fmtToman(rule.discount_value);

  const ruleTargetOptions = ruleScope === "color"
    ? [...new Set(activeVariants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))]
    : ruleScope === "size"
      ? [...new Set(activeVariants.map((variant) => variant.size).filter((size): size is string => Boolean(size)))]
      : ruleScope === "variant" ? activeVariants.map((variant) => variant.id) : [];
  const discountMatrix = useMemo(() => {
    const sizes = [...new Set(activeVariants.map((variant) => variant.size).filter((size): size is string => Boolean(size)))];
    const colors = [...new Set(activeVariants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))];
    return {
      sizes,
      rows: colors.map((color) => ({
        color,
        cells: sizes.map((size) => {
          const variant = activeVariants.find((candidate) => candidate.color === color && candidate.size === size) ?? null;
          const exactRules = variant ? standaloneRules.filter((rule) => rule.target_type === "variant" && rule.variant_id === variant.id) : [];
          const rule = exactRules.find((candidate) => candidate.channel === channel)
            ?? exactRules.find((candidate) => candidate.channel === "all") ?? null;
          return { size, variant, rule };
        }),
      })),
    };
  }, [activeVariants, standaloneRules, channel]);

  return (
    <WorkspaceModal open onClose={onClose} title={`قیمت‌گذاری محصول · ${productName}`} subtitle="قیمت پایه در کاتالوگ محصول، قواعد تخفیف در Promotion Center و نتیجه نهایی در Pricing Resolver نگه‌داری می‌شود.">
      {loading ? <LoadingState label="در حال دریافت قیمت‌ها و قوانین canonical…" /> : loadError ? (
        <div className="space-y-3"><p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{loadError}</p><Btn variant="soft" onClick={() => void reload()}><RefreshCw size={14} />تلاش دوباره</Btn></div>
      ) : (
        <div className="space-y-5 pb-4" dir="rtl">
          <Card className="flex flex-wrap items-center gap-3 p-3">
            {productImage && <img src={productImage} alt="" className="h-14 w-12 rounded-lg object-cover" />}
            <div className="min-w-0"><b className="block break-words">{productName}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{sku ?? productId}</span></div>
            <div className="mr-auto flex flex-wrap items-center gap-2 text-[11px]">
              <span className={cn("rounded-full px-2.5 py-1 font-bold", normalOn ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600")}>تخفیف مستقل: {normalOn ? "ON" : "OFF"}</span>
              <span className={cn("rounded-full px-2.5 py-1 font-bold", festivalOn ? "bg-amber-100 text-amber-900" : "bg-gray-100 text-gray-600")}>Festival: {festivalOn ? "ON" : "OFF"}</span>
            </div>
          </Card>

          {(hasRetail && hasWholesale) && <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold text-[var(--kv-muted)]">کانال قیمت</span>
            <Segmented<Channel> options={[{ v: "retail", label: "خرده" }, { v: "wholesale", label: "عمده" }]} value={channel} onChange={setChannel} />
          </div>}

          <section className="space-y-3" aria-label="قیمت پایه و اقساط">
            <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-bold">قیمت پایه و اقساط</h3><p className="text-[11px] text-[var(--kv-muted)]">مقادیر در ستون‌های اصلی محصول ذخیره می‌شوند، نه در metadata یا قوانین تخفیف.</p></div>
              <Btn size="sm" variant="accent" disabled={busy} onClick={() => void saveBasePrices()}><Save size={13} />ذخیره قیمت و اقساط</Btn>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {hasRetail && <Card className="space-y-3 p-4">
                <h4 className="text-sm font-bold">فروش خرده</h4>
                <Field label="قیمت نقدی پایه (تومان)"><Input value={base.cashToman} onChange={(value) => setBase((current) => ({ ...current, cashToman: value.replace(/\D/g, "") }))} /></Field>
                <div className="rounded-xl border border-[var(--kv-line)] p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div><b className="text-sm">خرید چهارقسطه</b><p className="mt-1 text-[10px] leading-5 text-[var(--kv-muted)]">تنظیم قیمت و امکان اعمال تخفیف برای پرداخت اقساطی.</p></div>
                    <div className="flex items-center gap-2"><span className="text-xs font-bold">{installmentsOn ? "ON" : "OFF"}</span><Switch label="خرید چهارقسطه" on={installmentsOn} onToggle={() => setBase((current) => ({ ...current, installmentPolicy: current.installmentPolicy === "disabled" ? "enabled" : "disabled" }))} /></div>
                  </div>
                  {installmentsOn && <div className="mt-3 space-y-3">
                    <Field label="قیمت پایهٔ چهارقسطه (تومان)" hint="خالی یعنی Resolver از قیمت پایهٔ نقدی استفاده می‌کند."><Input value={base.installmentToman} onChange={(value) => setBase((current) => ({ ...current, installmentToman: value.replace(/\D/g, "") }))} /></Field>
                    <Field label="سیاست تخفیف در پرداخت اقساطی" hint="مشخص می‌کند Discount عادی در سفارش چهارقسطه مجاز است یا نه."><Select options={INSTALLMENT_POLICIES.filter((policy) => policy !== "disabled")} labels={INSTALLMENT_POLICY_LABEL} value={base.installmentPolicy} onChange={(value) => setBase((current) => ({ ...current, installmentPolicy: value as InstallmentPolicy }))} /></Field>
                  </div>}
                </div>
              </Card>}
              {hasWholesale && <Card className="space-y-3 p-4">
                <h4 className="text-sm font-bold">قیمت پایه عمده</h4>
                <Field label="قیمت هر قطعهٔ عمده (تومان)" hint="قیمت سری و ترکیب آن همچنان از رکورد Series خوانده می‌شود."><Input value={base.wholesaleToman} onChange={(value) => setBase((current) => ({ ...current, wholesaleToman: value.replace(/\D/g, "") }))} /></Field>
              </Card>}
              {!hasRetail && !hasWholesale && <Empty title="کانال فروش فعالی ندارد" desc="ابتدا کانال فروش را در تعریف محصول تنظیم کنید." />}
            </div>
            {hasRetail && <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-[var(--kv-muted)]">حالت قیمت خرده</span>
              <Segmented<"cash" | "four_installments"> options={installmentsOn
                ? [{ v: "cash", label: "نقدی" }, { v: "four_installments", label: "چهارقسطه" }]
                : [{ v: "cash", label: "نقدی" }]}
                value={paymentMode} onChange={setPaymentMode} />
            </div>}
          </section>

          <section className="space-y-3" aria-label="حالت تخفیف مستقل">
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="font-bold">تخفیف مستقل محصول و واریانت‌ها</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">خاموش‌کردن فقط وضعیت را تغییر می‌دهد؛ درصدها، محدوده‌ها و history حفظ می‌شوند.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs font-bold">{normalOn ? "ON" : "OFF"}</span><Switch label="Discount مستقل" on={normalOn} onToggle={() => {
                  if (busy) return;
                  if (!normalOn && !summary?.configuredStandaloneRules) {
                    setShowDiscountDetails(true); setActionError("ابتدا یک قانون محصول یا واریانت بسازید؛ قانون تا روشن‌کردن صریح Discount خاموش می‌ماند."); return;
                  }
                  if (!normalOn && festivalBlocksNormal) { setConfirmFestivalExit(true); return; }
                  void setStandaloneMode(!normalOn);
                }} /></div>
              </div>
              <p className="text-[11px] text-[var(--kv-muted)]">{fa(summary?.activeStandaloneRules ?? 0)} قانون فعال · {fa(summary?.suspendedStandaloneRules ?? 0)} قانون معلق · {fa(summary?.configuredStandaloneRules ?? 0)} قانون ذخیره‌شده</p>
              {confirmFestivalExit && <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                <p className="font-bold">فعال‌کردن تخفیف مستقل، Festival فعال/زمان‌بندی‌شدهٔ این محصول را خاموش می‌کند. این اقدام صریح است و قیمت Festival دیگر اعمال نمی‌شود.</p>
                <div className="flex flex-wrap gap-2"><Btn size="sm" variant="accent" disabled={busy} onClick={() => void setStandaloneMode(true, true)}><Check size={13} />تأیید خروج و فعال‌سازی Discount</Btn><Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalExit(false)}>انصراف</Btn></div>
              </div>}
              {festivalBlocksNormal && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">{assigned?.name} این محصول را در وضعیت Festival نگه می‌دارد؛ قوانین مستقل تا خروج صریح معلق هستند.</p>}
              {!summary?.configuredStandaloneRules && <p className="text-[11px] text-[var(--kv-muted)]">برای روشن‌کردن Discount، ابتدا قانون محصول/واریانت ثبت کنید.</p>}
              <div className="flex justify-end"><Btn size="sm" variant="ghost" onClick={() => setShowDiscountDetails((open) => !open)}>{showDiscountDetails ? "بستن تنظیمات تخفیف" : summary?.configuredStandaloneRules ? "مشاهده / ویرایش تنظیمات ذخیره‌شده" : "افزودن قانون تخفیف"}</Btn></div>
            </Card>

            {showDiscountDetails && <div className="space-y-3">
              <Card className="space-y-3 p-4">
                <div><h4 className="text-sm font-bold">افزودن قانون تخفیف</h4><p className="text-[11px] text-[var(--kv-muted)]">در حالت OFF قانون حفظ می‌شود ولی مؤثر نیست؛ همهٔ تغییرات در رکورد canonical ثبت می‌شوند.</p></div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Field label="محدوده"><Select options={["product", "color", "size", "variant"]} labels={{ product: "کل محصول", color: "رنگ", size: "سایز", variant: "واریانت دقیق" }} value={ruleScope} onChange={(value) => { setRuleScope(value as typeof ruleScope); setRuleTarget(""); }} /></Field>
                  {ruleScope !== "product" && <Field label={ruleScope === "variant" ? "واریانت" : ruleScope === "color" ? "رنگ" : "سایز"}>
                    <Select options={ruleTargetOptions} labels={ruleScope === "variant" ? Object.fromEntries(activeVariants.map((variant) => [variant.id, `${variant.sku} · ${variant.color ?? "—"}/${variant.size ?? "—"}`])) : undefined} value={ruleTarget} onChange={setRuleTarget} />
                  </Field>}
                  <Field label="نوع"><Select options={["percent", "fixed_rial"]} labels={{ percent: "درصد", fixed_rial: "مبلغ ثابت" }} value={ruleType} onChange={(value) => setRuleType(value as typeof ruleType)} /></Field>
                  <Field label={ruleType === "percent" ? "درصد (۱–۹۵)" : "مبلغ (تومان)"}><Input value={ruleValue} onChange={(value) => setRuleValue(value.replace(/\D/g, ""))} /></Field>
                </div>
                <div className="flex justify-end"><Btn size="sm" variant="accent" disabled={busy || (ruleScope !== "product" && !ruleTarget)} onClick={() => void createStandalone()}><BadgePercent size={13} />ثبت قانون تخفیف</Btn></div>
              </Card>

              <Card className="space-y-3 p-4">
                <div><h4 className="text-sm font-bold">ماتریس تخفیف واریانت · رنگ × سایز</h4><p className="text-[10px] leading-5 text-[var(--kv-muted)]">این ماتریس فقط Discount صریحِ واریانت را نشان می‌دهد؛ قوانین محصول/رنگ/سایز در فهرست پایین و مبلغ نهایی در Resolver دیده می‌شود.</p></div>
                {discountMatrix.rows.length && discountMatrix.sizes.length ? <div className="max-w-full overflow-x-auto rounded-lg border border-[var(--kv-line)]">
                  <table className="kv-table min-w-[420px] w-full text-xs"><thead><tr><th>رنگ / سایز</th>{discountMatrix.sizes.map((size) => <th key={size}>{size}</th>)}</tr></thead><tbody>
                    {discountMatrix.rows.map((row) => <tr key={row.color}><th>{row.color}</th>{row.cells.map((cell) => <td key={`${row.color}-${cell.size}`} className="text-center">
                      {!cell.variant ? <span className="text-[var(--kv-faint)]">—</span> : cell.rule ? <div className="flex flex-col items-center gap-1"><b>{valueLabel(cell.rule)}</b><span className="text-[9px] text-[var(--kv-muted)]">{cell.rule.effectively_suspended ? "معلق" : cell.rule.active ? "فعال" : "خاموش"}</span></div> : <span className="text-[var(--kv-faint)]">—</span>}
                    </td>)}</tr>)}
                  </tbody></table>
                </div> : <Empty title="ماتریس واریانت خالی است" desc="برای نمایش خانه‌های رنگ × سایز ابتدا واریانت بسازید." />}
              </Card>

              <Card className="p-4">
                <h4 className="mb-3 text-sm font-bold">قوانین تخفیف محصول ({fa(standaloneRules.length)})</h4>
                {!standaloneRules.length ? <Empty title="قانون مستقلی برای این کانال ثبت نشده" desc="یک قانون سطح محصول، رنگ، سایز یا واریانت اضافه کنید." /> : <ul className="space-y-2">
                  {standaloneRules.map((rule) => <li key={rule.id} className={cn("rounded-xl border p-3", rule.effectively_suspended ? "border-amber-200 bg-amber-50/50" : "border-[var(--kv-line)]")}>
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="min-w-0 flex-1"><b className="break-words">{scopeLabel(rule)}</b><span className="ms-2 text-[10px] text-[var(--kv-muted)]">{rule.channel === "all" ? "همه کانال‌ها" : rule.channel === "retail" ? "خرده" : "عمده"}</span>
                        <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{rule.name ?? "قانون تخفیف"} · {rule.effectively_suspended ? `معلق با ${rule.suspended_by_name ?? "Festival"}` : rule.active ? "فعال" : "خاموش"}</p>
                      </div>
                      {editingRule?.id === rule.id ? <div className="flex items-center gap-1"><Input className="w-24" value={editingRule.value} onChange={(value) => setEditingRule({ id: rule.id, value: value.replace(/\D/g, "") })} /><span>{rule.discount_type === "percent" ? "٪" : "تومان"}</span><Btn size="sm" variant="accent" disabled={busy} onClick={() => void updateRuleValue(rule)}><Save size={12} />ذخیره</Btn></div>
                        : <div className="flex items-center gap-2"><strong className="whitespace-nowrap">{valueLabel(rule)}</strong><Btn size="sm" variant="ghost" disabled={busy} onClick={() => setEditingRule({ id: rule.id, value: rule.discount_type === "percent" ? rule.discount_value : String(tomanFromRial(rule.discount_value)) })}>ویرایش</Btn></div>}
                      <Btn size="sm" variant={rule.active && !rule.effectively_suspended ? "soft" : "accent"} disabled={busy || (festivalBlocksNormal && !rule.promotion_id)} onClick={() => void toggleRule(rule)}>{rule.active && !rule.effectively_suspended ? "خاموش" : "فعال‌سازی صریح"}</Btn>
                    </div>
                  </li>)}
                </ul>}
              </Card>
            </div>}
          </section>

          <section className="space-y-3" aria-label="انتخاب جشنواره">
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="flex items-center gap-2 font-bold"><PartyPopper size={16} />جشنوارهٔ محصول از مرکز مرکزی</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">ورود به Festival، تخفیف‌های مستقل را معلق می‌کند. خروج یا پایان Festival آن‌ها را خودکار روشن نمی‌کند.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs font-bold">{festivalOn ? "ON" : "OFF"}</span><Switch label="Festival محصول" on={festivalOn} onToggle={() => {
                  if (busy) return;
                  if (festivalOn) void setFestivalMode(null);
                  else if (!selectedFestival) { setShowFestivalDetails(true); setActionError("برای روشن‌کردن Festival، ابتدا یک تعریف فعال از مرکز مرکزی انتخاب کنید."); }
                  else requestFestivalOn();
                }} /></div>
              </div>
              {assigned && <p className="rounded-lg bg-[var(--kv-surface-2)] px-3 py-2 text-[11px]">{assigned.effective ? "موثر اکنون" : assigned.active && assigned.promotionActive ? "زمان‌بندی‌شده/خارج از پنجرهٔ اثر" : "خاموش یا پایان‌یافته"} · {assigned.name}{assigned.endsAt ? ` · پایان ${new Date(assigned.endsAt).toLocaleDateString("fa-IR")}` : ""}</p>}
              {!showFestivalDetails && <p className="text-[11px] text-[var(--kv-muted)]">{festivalOn ? "تعریف انتخاب‌شده فعال است؛ برای دیدن یا تغییر جزئیات باز کنید." : "جزئیات Festival بسته است؛ خاموش‌بودن وضعیت و مقدار ذخیره‌شده را حذف نمی‌کند."}</p>}
              <div className="flex justify-end"><Btn size="sm" variant="ghost" onClick={() => setShowFestivalDetails((open) => !open)}>{showFestivalDetails ? "بستن تنظیمات Festival" : "تنظیم Festival"}</Btn></div>
            </Card>

            {showFestivalDetails && <div className="space-y-3">
              <Card className="space-y-3 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="تعریف Festival">
                    <Select options={festivals.filter((festival) => festival.channel === "all" || festival.channel === channel).map((festival) => festival.id)} labels={Object.fromEntries(festivals.filter((festival) => festival.channel === "all" || festival.channel === channel).map((festival) => [festival.id, `${festival.name} · ${festival.channel}`]))} value={festivalPick} onChange={setFestivalPick} />
                  </Field>
                  <Field label="درصد تخفیف محصول در Festival"><Input value={festivalValue} onChange={(value) => setFestivalValue(value.replace(/\D/g, ""))} /></Field>
                </div>
                {confirmFestivalMove && <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"><p className="font-bold">محصول به «{assigned?.name}» متصل است. انتقال به «{selectedFestival?.name}» جشنواره قبلی را خاموش می‌کند.</p><div className="flex flex-wrap gap-2"><Btn size="sm" variant="accent" disabled={busy} onClick={() => selectedFestival && void setFestivalMode(selectedFestival.id, true)}>تأیید انتقال</Btn><Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalMove(false)}>انصراف</Btn></div></div>}
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10.5px] text-[var(--kv-muted)]">تعریف‌های قابل انتخاب: {fa(festivals.filter((festival) => festival.channel === "all" || festival.channel === channel).length)}</span><Btn size="sm" variant="soft" disabled={busy || !festivalPick} onClick={requestFestivalOn}><PartyPopper size={13} />اعمال Festival انتخاب‌شده</Btn></div>
              </Card>
              {festivalRules.length > 0 && <Card className="p-4"><h4 className="mb-2 text-sm font-bold">قوانین Festival این محصول</h4><ul className="space-y-2">{festivalRules.map((rule) => <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--kv-line)] p-3 text-xs"><span><b>{scopeLabel(rule)}</b> · {rule.promotion_name ?? "Festival"} · {valueLabel(rule)}</span><span className={rule.active && !rule.effectively_suspended ? "text-amber-800" : "text-[var(--kv-muted)]"}>{rule.active ? rule.effectively_suspended ? "معلق" : "فعال" : "خاموش"}</span></li>)}</ul></Card>}
            </div>}
          </section>

          <section className="space-y-3" aria-label="پیش‌نمایش resolver">
            <div><h3 className="font-bold">پیش‌نمایش قطعی Pricing Resolver</h3><p className="text-[11px] text-[var(--kv-muted)]">نتیجهٔ محاسبه‌شده از API سرور برای همهٔ واریانت‌های فعال (تا ۱۰۰ مورد)؛ پیش‌نمایش محلی وجود ندارد.</p></div>
            {previewLoading && <LoadingState label="در حال محاسبه در Resolver…" />}
            {previewError && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{previewError}</p>}
            {!previewLoading && !previewError && previewLines.length > 0 && <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {previewLines.map((line) => <Card key={line.variantId} className="space-y-2 p-3">
                <div className="flex items-start justify-between gap-2"><b dir="ltr" className="font-mono text-xs">{line.sku}</b><span className="text-[10px] text-[var(--kv-muted)]">{line.color ?? "—"} / {line.size ?? "—"}</span></div>
                <div className="grid grid-cols-3 gap-1 text-[10px]"><div><span className="block text-[var(--kv-muted)]">پایه</span><b className="block break-words">{fmtToman(line.basePrice)}</b></div><div><span className="block text-[var(--kv-muted)]">تخفیف</span><b className="block break-words">{fmtToman(line.discountAmount)}</b></div><div><span className="block text-[var(--kv-muted)]">نهایی</span><b className="block break-words text-emerald-800">{fmtToman(line.finalPrice)}</b></div></div>
                <p className="text-[10px] text-[var(--kv-muted)]">منبع: {line.source === "festival" ? "Festival" : line.source === "promotion_rule" ? "قانون تخفیف" : "بدون تخفیف"}{line.matchedRule?.name ? ` · ${line.matchedRule.name}` : ""}</p>
              </Card>)}
            </div>}
            {!previewLoading && !previewError && !previewLines.length && <Empty title="واریانت فعالی برای محاسبه نیست" desc="پس از تعریف واریانت‌های محصول، پیش‌نمایش canonical اینجا ظاهر می‌شود." />}
          </section>

          {actionError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">{actionError}</p>}
          <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--kv-line)] pt-3"><Btn variant="ghost" onClick={() => void reload()}><RefreshCw size={13} />بازخوانی قوانین مرکزی</Btn><Btn variant="soft" onClick={onClose}>بستن</Btn></div>
        </div>
      )}
    </WorkspaceModal>
  );
}

export const ProductPricingWorkspace = DiscountManager;
