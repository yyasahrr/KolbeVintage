import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BadgePercent, Check, ExternalLink, PartyPopper, RefreshCw, Save } from "lucide-react";
import { Btn, Card, Empty, Field, Input, LoadingState, SafeImg, Select, Switch } from "./primitives";
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

const CHANNEL_LABEL: Record<Channel, string> = { retail: "خرده", wholesale: "عمده" };
const PUBLICATION_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: "پیش‌نویس", cls: "bg-slate-100 text-slate-700" },
  published: { label: "منتشرشده", cls: "bg-emerald-100 text-emerald-800" },
  pending: { label: "در انتظار تأیید", cls: "bg-amber-100 text-amber-800" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  archived: { label: "آرشیوشده", cls: "bg-slate-200 text-slate-600" },
};

/**
 * §1/§2/§16/§18 (browser-UAT delta): the ONE canonical Product Pricing workspace.
 *
 *  It is a FULL PAGE, never a modal: «محصولات کلبه → قیمت‌گذاری» navigates here with the product
 *  id, and the same workspace is reached from Product Studio and Product 360. Prices live in the
 *  canonical catalog columns; discount/festival rules stay in the canonical
 *  promotion_rules/promotions tables and every preview comes from the checkout resolver.
 *
 *  Sales Mode is owned by the Product Studio (step «اطلاعات پایه») — this page only REFLECTS it.
 *  The rejected «حالت قیمت خرده/عمده» selector is gone: retail and wholesale sections appear
 *  because the product's canonical sales mode enables them, and each section manages only its
 *  own channel's rules.
 */
export function ProductPricingWorkspace({ productId, productName, productImage, sku, onClose, backLabel = "بازگشت به محصول", flash, anchor, onOpenPromotionCenter }: {
  productId: string; productName: string; productImage?: string; sku?: string;
  onClose: () => void; backLabel?: string;
  flash: (msg: string) => void;
  /** §17: the Studio deep-links straight into one section of this canonical workspace. */
  anchor?: "discount" | "festival";
  onOpenPromotionCenter?: (anchor?: "discount" | "festival") => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [festivals, setFestivals] = useState<Festival[]>([]);
  const [festivalChannel, setFestivalChannel] = useState<Channel>("retail");
  const [paymentMode, setPaymentMode] = useState<"cash" | "four_installments">("cash");
  const [base, setBase] = useState<BaseDraft>({ cashToman: "", installmentToman: "", wholesaleToman: "", installmentPolicy: "enabled" });
  const [busy, setBusy] = useState(false);
  const [showDiscountDetails, setShowDiscountDetails] = useState(false);
  const [showFestivalDetails, setShowFestivalDetails] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Record<Channel, { type: "percent" | "fixed_rial"; value: string; scope: "product" | "color" | "size" | "variant"; target: string }>>({
    retail: { type: "percent", value: "", scope: "product", target: "" },
    wholesale: { type: "percent", value: "", scope: "product", target: "" },
  });
  const [festivalPick, setFestivalPick] = useState("");
  const [festivalValue, setFestivalValue] = useState("15");
  const [confirmFestivalExit, setConfirmFestivalExit] = useState(false);
  const [confirmFestivalMove, setConfirmFestivalMove] = useState(false);
  const [editingRule, setEditingRule] = useState<{ id: string; value: string } | null>(null);
  const [previews, setPreviews] = useState<Record<Channel, ResolverLine[]>>({ retail: [], wholesale: [] });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const festivalSection = useRef<HTMLElement | null>(null);
  const discountSection = useRef<HTMLElement | null>(null);

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
      setPaymentMode("cash");
      setRuleDraft((current) => ({
        retail: { ...current.retail, target: current.retail.target || (rows.find((row) => row.active)?.id ?? "") },
        wholesale: { ...current.wholesale, target: current.wholesale.target || (rows.find((row) => row.active)?.id ?? "") },
      }));
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

  const hasRetail = detail?.retail_enabled !== false;
  const hasWholesale = detail?.wholesale_enabled !== false;
  const channels = useMemo<Channel[]>(() => [...(hasRetail ? ["retail" as const] : []), ...(hasWholesale ? ["wholesale" as const] : [])], [hasRetail, hasWholesale]);
  const salesModeLabel = hasRetail && hasWholesale ? "خرده + عمده" : hasRetail ? "فقط خرده" : hasWholesale ? "فقط عمده" : "بدون کانال فروش";
  const publication = PUBLICATION_LABEL[String(detail?.status ?? "draft")] ?? PUBLICATION_LABEL.draft!;
  const activeVariants = useMemo(() => variants.filter((variant) => variant.active), [variants]);
  const installmentsOn = base.installmentPolicy !== "disabled";
  const normalOn = Boolean(summary?.activeStandaloneRules);
  const assigned = summary?.assignedFestival ?? null;
  const festivalBlocksNormal = Boolean(assigned?.active && assigned.promotionActive && (!assigned.endsAt || new Date(assigned.endsAt).getTime() > Date.now()));
  const festivalOn = festivalBlocksNormal;

  const channelRules = useCallback((channel: Channel) => rules.filter((rule) => rule.channel === "all" || rule.channel === channel), [rules]);
  const standaloneRules = useCallback((channel: Channel) => channelRules(channel).filter((rule) => !rule.promotion_id), [channelRules]);
  const festivalRules = useCallback((channel: Channel) => channelRules(channel).filter((rule) => rule.promotion_id), [channelRules]);

  useEffect(() => {
    if (festivalChannel === "wholesale" && !hasWholesale) setFestivalChannel("retail");
    if (festivalChannel === "retail" && !hasRetail && hasWholesale) setFestivalChannel("wholesale");
  }, [hasRetail, hasWholesale, festivalChannel]);

  const selectedFestival = festivals.find((festival) => festival.id === festivalPick);
  /* §2: read-only festival summary card — no local ON/OFF authority lives in Product Studio. */
  const festivalOptions = useMemo(
    () => festivals.filter((festival) => festival.channel === "all" || festival.channel === festivalChannel),
    [festivals, festivalChannel]);

  /* One batched preview per ENABLED channel, resolved by the exact server function used at checkout. */
  useEffect(() => {
    if (!activeVariants.length || !channels.length) { setPreviews({ retail: [], wholesale: [] }); setPreviewError(null); return; }
    let alive = true;
    setPreviewLoading(true); setPreviewError(null);
    Promise.all(channels.map((channel) => promotionRulesApi.resolvePrices({
      orderType: channel,
      paymentMode: channel === "retail" ? paymentMode : "cash",
      items: activeVariants.slice(0, 100).map((variant) => ({ variantId: variant.id, quantity: 1 })),
    }).then((result) => [channel, result.lines as unknown as ResolverLine[]] as const)
      .catch((error) => { throw error; })))
      .then((pairs) => {
        if (!alive) return;
        const next: Record<Channel, ResolverLine[]> = { retail: [], wholesale: [] };
        for (const [channel, lines] of pairs) next[channel] = lines;
        setPreviews(next);
      })
      .catch((error) => { if (alive) { setPreviews({ retail: [], wholesale: [] }); setPreviewError(error instanceof Error ? error.message : "پیش‌نمایش موتور قیمت‌گذاری در دسترس نیست."); } })
      .finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [activeVariants, channels, paymentMode, rules, summary]);

  const saveBasePrices = async () => {
    if (!detail || busy) return;
    setBusy(true); setActionError(null);
    try {
      const patch: Record<string, unknown> = { installmentPolicy: base.installmentPolicy };
      if (hasRetail) {
        const cashRial = rialFromToman(base.cashToman);
        if (BigInt(cashRial) <= 0n) throw new Error("قیمت نقدی خرده باید بزرگ‌تر از صفر باشد.");
        patch.cashPriceRial = cashRial;
        patch.installmentPriceRial = base.installmentToman.trim() ? rialFromToman(base.installmentToman) : null;
      }
      if (hasWholesale) patch.wholesalePriceRial = base.wholesaleToman.trim() ? rialFromToman(base.wholesaleToman) : null;
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
            mode: "festival", promotionId,
            channel: selectedFestival?.channel === "all" ? festivalChannel : selectedFestival?.channel ?? festivalChannel,
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
    if (!selectedFestival) { setShowFestivalDetails(true); setActionError("یک جشنوارهٔ فعال از مرکز مرکزی انتخاب کنید."); return; }
    if (!Number.isInteger(Number(festivalValue)) || Number(festivalValue) < 1 || Number(festivalValue) > 95) {
      setActionError("درصد جشنواره باید بین ۱ تا ۹۵ باشد."); return;
    }
    if (festivalBlocksNormal && assigned?.promotionId !== selectedFestival.id) { setConfirmFestivalMove(true); return; }
    void setFestivalMode(selectedFestival.id, false);
  };

  const createStandalone = async (channel: Channel) => {
    if (busy) return;
    const draft = ruleDraft[channel];
    const raw = draft.value.trim();
    const numeric = Number(raw);
    if (!raw || !Number.isFinite(numeric) || numeric <= 0 || (draft.type === "percent" && (!Number.isInteger(numeric) || numeric > 95))) {
      setActionError(draft.type === "percent" ? "درصد تخفیف باید عددی بین ۱ تا ۹۵ باشد." : "مبلغ تخفیف را به تومان وارد کنید."); return;
    }
    if (draft.scope !== "product" && !draft.target) { setActionError("محدودهٔ تخفیف را انتخاب کنید."); return; }
    const targetVariant = activeVariants.find((variant) => variant.id === draft.target);
    const fields: Record<string, unknown> = {
      channel, targetType: draft.scope, productId,
      discountType: draft.type, discountValue: rialForRule(draft.type, raw),
      active: normalOn && !festivalBlocksNormal,
    };
    if (draft.scope === "color") fields.colorId = draft.target;
    if (draft.scope === "size") fields.sizeCode = draft.target;
    if (draft.scope === "variant") fields.variantId = draft.target;
    const duplicate = rules.find((rule) => !rule.promotion_id && rule.channel === channel && rule.target_type === draft.scope
      && (draft.scope === "product" || draft.scope === "color" && rule.color_id === draft.target
        || draft.scope === "size" && rule.size_code?.toUpperCase() === draft.target.toUpperCase()
        || draft.scope === "variant" && rule.variant_id === draft.target));
    if (duplicate) { setActionError("برای این هدف و کانال قانون مستقلی وجود دارد؛ مقدار همان قانون را در فهرست پایین ویرایش کنید."); return; }
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.createRule({
        ...fields,
        name: draft.scope === "product" ? `تخفیف ${productName}`
          : draft.scope === "color" ? `تخفیف رنگ ${draft.target}`
          : draft.scope === "size" ? `تخفیف سایز ${draft.target}`
          : `تخفیف ${targetVariant?.sku ?? "واریانت"}`,
      }, newKey(productId));
      setRuleDraft((current) => ({ ...current, [channel]: { ...current[channel], value: "" } }));
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

  const ruleTargetOptions = (scope: string) => scope === "color"
    ? [...new Set(activeVariants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))]
    : scope === "size"
      ? [...new Set(activeVariants.map((variant) => variant.size).filter((size): size is string => Boolean(size)))]
      : scope === "variant" ? activeVariants.map((variant) => variant.id) : [];

  /** §17: the Studio deep-links straight to the promotion section of this page. */
  useEffect(() => {
    if (loading) return;
    const target = anchor === "festival" ? festivalSection.current : anchor === "discount" ? discountSection.current : null;
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [anchor, loading]);

  const matrixFor = (channel: Channel) => {
    const sizes = [...new Set(activeVariants.map((variant) => variant.size).filter((size): size is string => Boolean(size)))];
    const colors = [...new Set(activeVariants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))];
    return {
      sizes,
      rows: colors.map((color) => ({
        color,
        cells: sizes.map((size) => {
          const variant = activeVariants.find((candidate) => candidate.color === color && candidate.size === size) ?? null;
          const exactRules = variant ? standaloneRules(channel).filter((rule) => rule.target_type === "variant" && rule.variant_id === variant.id) : [];
          const rule = exactRules.find((candidate) => candidate.channel === channel)
            ?? exactRules.find((candidate) => candidate.channel === "all") ?? null;
          return { size, variant, rule };
        }),
      })),
    };
  };

  if (loading) return <div className="space-y-4" dir="rtl"><PageHeader {...{ productName, productImage, sku, salesModeLabel, publication, onClose, backLabel }} /><LoadingState label="در حال دریافت قیمت‌ها و قوانین canonical…" /></div>;

  return (
    <div className="space-y-5 pb-10" dir="rtl" data-workspace="product-pricing">
      <PageHeader {...{ productName, productImage, sku, salesModeLabel, publication, onClose, backLabel }} />

      {loadError ? (
        <Card className="space-y-3 p-4">
          <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{loadError}</p>
          <Btn variant="soft" onClick={() => void reload()}><RefreshCw size={14} />تلاش دوباره</Btn>
        </Card>
      ) : (
        <>
          {/* §2: promotion summary — READ-ONLY facts + deep-links. No local ON/OFF authority here. */}
          <section className="space-y-3" aria-label="خلاصه تخفیف و جشنواره">
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="flex items-center gap-2 text-sm"><BadgePercent size={15} />تخفیف محصول</b>
                  <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", normalOn ? "bg-emerald-100 text-emerald-800" : "bg-gray-100 text-gray-600")}>{normalOn ? "فعال" : "خاموش"}</span>
                </div>
                <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
                  {fa(summary?.activeStandaloneRules ?? 0)} قانون فعال · {fa(summary?.suspendedStandaloneRules ?? 0)} قانون معلق · {fa(summary?.configuredStandaloneRules ?? 0)} قانون ذخیره‌شده
                </p>
                <div className="flex flex-wrap gap-2">
                  {onOpenPromotionCenter
                    ? <Btn size="sm" variant="accent" icon={<ExternalLink size={13} />} onClick={() => onOpenPromotionCenter("discount")}>مدیریت تخفیف</Btn>
                    : <Btn size="sm" variant="soft" onClick={() => discountSection.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>ویرایش قوانین همین محصول</Btn>}
                  {onOpenPromotionCenter && <Btn size="sm" variant="ghost" onClick={() => discountSection.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>ویرایش قوانین همین محصول</Btn>}
                </div>
              </Card>
              <Card className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <b className="flex items-center gap-2 text-sm"><PartyPopper size={15} />جشنواره</b>
                  <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", festivalOn ? "bg-amber-100 text-amber-900" : "bg-gray-100 text-gray-600")}>{festivalOn ? "فعال" : "خاموش"}</span>
                </div>
                <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">{assigned ? assigned.name : "این محصول به جشنوارهٔ فعالی متصل نیست."}</p>
                <div className="flex flex-wrap gap-2">
                  {onOpenPromotionCenter
                    ? <Btn size="sm" variant="accent" icon={<ExternalLink size={13} />} onClick={() => onOpenPromotionCenter("festival")}>مدیریت جشنواره</Btn>
                    : <Btn size="sm" variant="soft" onClick={() => festivalSection.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>جشنواره‌های این محصول</Btn>}
                  {onOpenPromotionCenter && <Btn size="sm" variant="ghost" onClick={() => festivalSection.current?.scrollIntoView({ block: "start", behavior: "smooth" })}>جشنواره‌های این محصول</Btn>}
                </div>
              </Card>
            </div>
          </section>

          <section className="space-y-3" aria-label="قیمت پایه و اقساط">
            <div className="flex flex-wrap items-end justify-between gap-2"><div><h3 className="font-bold">قیمت پایه و اقساط</h3><p className="text-[11px] text-[var(--kv-muted)]">مقادیر در ستون‌های اصلی محصول ذخیره می‌شوند، نه در metadata یا قوانین تخفیف. حالت فروش این محصول: <b>{salesModeLabel}</b>.</p></div>
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
                    <Field label="قیمت پایهٔ چهارقسطه (تومان)" hint="خالی یعنی سرور از قیمت پایهٔ نقدی استفاده می‌کند."><Input value={base.installmentToman} onChange={(value) => setBase((current) => ({ ...current, installmentToman: value.replace(/\D/g, "") }))} /></Field>
                    <Field label="سیاست تخفیف در پرداخت اقساطی" hint="مشخص می‌کند تخفیف عادی در سفارش چهارقسطه مجاز است یا نه."><Select options={INSTALLMENT_POLICIES.filter((policy) => policy !== "disabled")} labels={INSTALLMENT_POLICY_LABEL} value={base.installmentPolicy} onChange={(value) => setBase((current) => ({ ...current, installmentPolicy: value as InstallmentPolicy }))} /></Field>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-bold text-[var(--kv-muted)]">نمایش قیمت</span>
                      <Select options={["cash", "four_installments"]} labels={{ cash: "نقدی", four_installments: "چهارقسطه" }} value={paymentMode} onChange={(value) => setPaymentMode(value as typeof paymentMode)} />
                    </div>
                  </div>}
                </div>
              </Card>}
              {hasWholesale && <Card className="space-y-3 p-4">
                <h4 className="text-sm font-bold">فروش عمده</h4>
                <Field label="قیمت هر قطعهٔ عمده (تومان)" hint="قیمت سری و ترکیب آن همچنان از رکورد سری خوانده می‌شود؛ اگر سری قیمت‌گذاری‌شده داشته باشید همان مرجع است."><Input value={base.wholesaleToman} onChange={(value) => setBase((current) => ({ ...current, wholesaleToman: value.replace(/\D/g, "") }))} /></Field>
                <p className="text-[11px] leading-5 text-[var(--kv-muted)]">ترکیب و قیمت سری‌ها در «قیمت‌گذاری» محصول (گام فروش عمده) مدیریت می‌شود؛ این‌جا فقط قیمت پایهٔ عمده ثبت می‌شود.</p>
              </Card>}
              {!hasRetail && !hasWholesale && <Empty title="کانال فروش فعالی ندارد" desc="ابتدا حالت فروش را در «اطلاعات پایه» محصول تنظیم کنید." />}
            </div>
          </section>

          <section ref={discountSection} className="space-y-3 scroll-mt-24" aria-label="تخفیف محصول" id="pricing-discount">
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="font-bold">تخفیف مستقل محصول و واریانت‌ها</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">برای هر کانال جداگانه مدیریت می‌شود. خاموش‌کردن فقط وضعیت را تغییر می‌دهد؛ درصدها، محدوده‌ها و تاریخچه حفظ می‌شوند.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs font-bold">{normalOn ? "ON" : "OFF"}</span><Switch label="تخفیف مستقل" on={normalOn} onToggle={() => {
                  if (busy) return;
                  if (!normalOn && !summary?.configuredStandaloneRules) {
                    setShowDiscountDetails(true); setActionError("ابتدا یک قانون محصول یا واریانت بسازید؛ قانون تا روشن‌کردن صریح تخفیف خاموش می‌ماند."); return;
                  }
                  if (!normalOn && festivalBlocksNormal) { setConfirmFestivalExit(true); return; }
                  void setStandaloneMode(!normalOn);
                }} /></div>
              </div>
              <p className="text-[11px] text-[var(--kv-muted)]">{fa(summary?.activeStandaloneRules ?? 0)} قانون فعال · {fa(summary?.suspendedStandaloneRules ?? 0)} قانون معلق · {fa(summary?.configuredStandaloneRules ?? 0)} قانون ذخیره‌شده</p>
              {confirmFestivalExit && <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                <p className="font-bold">فعال‌کردن تخفیف مستقل، جشنوارهٔ فعال/زمان‌بندی‌شدهٔ این محصول را خاموش می‌کند. این اقدام صریح است و قیمت جشنواره دیگر اعمال نمی‌شود.</p>
                <div className="flex flex-wrap gap-2"><Btn size="sm" variant="accent" disabled={busy} onClick={() => void setStandaloneMode(true, true)}><Check size={13} />تأیید خروج و فعال‌سازی تخفیف</Btn><Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalExit(false)}>انصراف</Btn></div>
              </div>}
              {festivalBlocksNormal && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">{assigned?.name} این محصول را در وضعیت جشنواره نگه می‌دارد؛ قوانین مستقل تا خروج صریح معلق هستند.</p>}
              {!summary?.configuredStandaloneRules && <p className="text-[11px] text-[var(--kv-muted)]">برای روشن‌کردن تخفیف، ابتدا قانون محصول/واریانت ثبت کنید.</p>}
              <div className="flex justify-end"><Btn size="sm" variant="ghost" onClick={() => setShowDiscountDetails((open) => !open)}>{showDiscountDetails ? "بستن تنظیمات تخفیف" : summary?.configuredStandaloneRules ? "مشاهده / ویرایش تنظیمات ذخیره‌شده" : "افزودن قانون تخفیف"}</Btn></div>
            </Card>

            {showDiscountDetails && (
              <div className="grid gap-4 xl:grid-cols-2">
                {channels.map((channel) => {
                  const draft = ruleDraft[channel];
                  const matrix = matrixFor(channel);
                  const list = standaloneRules(channel);
                  const targetOptions = ruleTargetOptions(draft.scope);
                  return (
                    <div key={channel} className="space-y-3" data-channel={channel}>
                      <Card className="space-y-3 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-sm font-bold">افزودن قانون تخفیف — کانال {CHANNEL_LABEL[channel]}</h4>
                          <span className="text-[10.5px] text-[var(--kv-muted)]">{fa(list.length)} قانون در این کانال</span>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="محدوده"><Select options={["product", "color", "size", "variant"]} labels={{ product: "کل محصول", color: "رنگ", size: "سایز", variant: "واریانت دقیق" }} value={draft.scope} onChange={(value) => setRuleDraft((current) => ({ ...current, [channel]: { ...current[channel], scope: value as typeof draft.scope, target: "" } }))} /></Field>
                          {draft.scope !== "product" && <Field label={draft.scope === "variant" ? "واریانت" : draft.scope === "color" ? "رنگ" : "سایز"}>
                            <Select options={targetOptions} labels={draft.scope === "variant" ? Object.fromEntries(activeVariants.map((variant) => [variant.id, `${variant.sku} · ${variant.color ?? "—"}/${variant.size ?? "—"}`])) : undefined} value={draft.target} onChange={(value) => setRuleDraft((current) => ({ ...current, [channel]: { ...current[channel], target: value } }))} />
                          </Field>}
                          <Field label="نوع"><Select options={["percent", "fixed_rial"]} labels={{ percent: "درصد", fixed_rial: "مبلغ ثابت" }} value={draft.type} onChange={(value) => setRuleDraft((current) => ({ ...current, [channel]: { ...current[channel], type: value as typeof draft.type } }))} /></Field>
                          <Field label={draft.type === "percent" ? "درصد (۱–۹۵)" : "مبلغ (تومان)"}><Input value={draft.value} onChange={(value) => setRuleDraft((current) => ({ ...current, [channel]: { ...current[channel], value: value.replace(/\D/g, "") } }))} /></Field>
                        </div>
                        <div className="flex justify-end"><Btn size="sm" variant="accent" disabled={busy || (draft.scope !== "product" && !draft.target)} onClick={() => void createStandalone(channel)}><BadgePercent size={13} />ثبت قانون تخفیف</Btn></div>
                      </Card>

                      <Card className="space-y-3 p-4">
                        <div><h4 className="text-sm font-bold">ماتریس تخفیف واریانت — {CHANNEL_LABEL[channel]}</h4><p className="text-[10px] leading-5 text-[var(--kv-muted)]">این ماتریس فقط تخفیف صریحِ واریانت را نشان می‌دهد؛ قوانین محصول/رنگ/سایز در فهرست پایین و مبلغ نهایی در سرور محاسبه می‌شود.</p></div>
                        {matrix.rows.length && matrix.sizes.length ? <div className="max-w-full overflow-x-auto rounded-lg border border-[var(--kv-line)]">
                          <table className="kv-table min-w-[420px] w-full text-xs"><thead><tr><th>رنگ / سایز</th>{matrix.sizes.map((size) => <th key={size}>{size}</th>)}</tr></thead><tbody>
                            {matrix.rows.map((row) => <tr key={row.color}><th>{row.color}</th>{row.cells.map((cell) => <td key={`${row.color}-${cell.size}`} className="text-center">
                              {!cell.variant ? <span className="text-[var(--kv-faint)]">—</span> : cell.rule ? <div className="flex flex-col items-center gap-1"><b>{valueLabel(cell.rule)}</b><span className="text-[9px] text-[var(--kv-muted)]">{cell.rule.effectively_suspended ? "معلق" : cell.rule.active ? "فعال" : "خاموش"}</span></div> : <span className="text-[var(--kv-faint)]">—</span>}
                            </td>)}</tr>)}
                          </tbody></table>
                        </div> : <Empty title="ماتریس واریانت خالی است" desc="برای نمایش خانه‌های رنگ × سایز ابتدا واریانت بسازید." />}
                      </Card>

                      <Card className="p-4">
                        <h4 className="mb-3 text-sm font-bold">قوانین تخفیف — کانال {CHANNEL_LABEL[channel]} ({fa(list.length)})</h4>
                        {!list.length ? <Empty title="قانون مستقلی برای این کانال ثبت نشده" desc="یک قانون سطح محصول، رنگ، سایز یا واریانت اضافه کنید." /> : <ul className="space-y-2">
                          {list.map((rule) => <li key={rule.id} className={cn("rounded-xl border p-3", rule.effectively_suspended ? "border-amber-200 bg-amber-50/50" : "border-[var(--kv-line)]")}>
                            <div className="flex flex-wrap items-start gap-2">
                              <div className="min-w-0 flex-1"><b className="break-words">{scopeLabel(rule)}</b>
                                <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{rule.name ?? "قانون تخفیف"} · {rule.effectively_suspended ? `معلق با ${rule.suspended_by_name ?? "جشنواره"}` : rule.active ? "فعال" : "خاموش"}</p>
                              </div>
                              {editingRule?.id === rule.id ? <div className="flex items-center gap-1"><Input className="w-24" value={editingRule.value} onChange={(value) => setEditingRule({ id: rule.id, value: value.replace(/\D/g, "") })} /><span>{rule.discount_type === "percent" ? "٪" : "تومان"}</span><Btn size="sm" variant="accent" disabled={busy} onClick={() => void updateRuleValue(rule)}><Save size={12} />ذخیره</Btn></div>
                                : <div className="flex items-center gap-2"><strong className="whitespace-nowrap">{valueLabel(rule)}</strong><Btn size="sm" variant="ghost" disabled={busy} onClick={() => setEditingRule({ id: rule.id, value: rule.discount_type === "percent" ? rule.discount_value : String(tomanFromRial(rule.discount_value)) })}>ویرایش</Btn></div>}
                              <Btn size="sm" variant={rule.active && !rule.effectively_suspended ? "soft" : "accent"} disabled={busy || (festivalBlocksNormal && !rule.promotion_id)} onClick={() => void toggleRule(rule)}>{rule.active && !rule.effectively_suspended ? "خاموش" : "فعال‌سازی صریح"}</Btn>
                            </div>
                          </li>)}
                        </ul>}
                      </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section ref={festivalSection} className="space-y-3 scroll-mt-24" aria-label="جشنواره" id="pricing-festival">
            <Card className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h3 className="flex items-center gap-2 font-bold"><PartyPopper size={16} />جشنوارهٔ محصول از مرکز مرکزی</h3><p className="mt-1 text-[11px] leading-5 text-[var(--kv-muted)]">ورود به جشنواره، تخفیف‌های مستقل را معلق می‌کند. خروج یا پایان جشنواره آن‌ها را خودکار روشن نمی‌کند.</p></div>
                <div className="flex items-center gap-2"><span className="text-xs font-bold">{festivalOn ? "ON" : "OFF"}</span><Switch label="جشنواره محصول" on={festivalOn} onToggle={() => {
                  if (busy) return;
                  if (festivalOn) void setFestivalMode(null);
                  else if (!selectedFestival) { setShowFestivalDetails(true); setActionError("برای روشن‌کردن جشنواره، ابتدا یک تعریف فعال از مرکز مرکزی انتخاب کنید."); }
                  else requestFestivalOn();
                }} /></div>
              </div>
              {assigned && <p className="rounded-lg bg-[var(--kv-surface-2)] px-3 py-2 text-[11px]">{assigned.effective ? "موثر اکنون" : assigned.active && assigned.promotionActive ? "زمان‌بندی‌شده/خارج از پنجرهٔ اثر" : "خاموش یا پایان‌یافته"} · {assigned.name}{assigned.endsAt ? ` · پایان ${new Date(assigned.endsAt).toLocaleDateString("fa-IR")}` : ""}</p>}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--kv-muted)]">{showFestivalDetails ? "جزئیات جشنواره باز است." : "جزئیات جشنواره بسته است؛ خاموش‌بودن وضعیت، مقدار ذخیره‌شده را حذف نمی‌کند."}</span>
                <div className="flex flex-wrap gap-2">
                  {onOpenPromotionCenter && <Btn size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => onOpenPromotionCenter("festival")}>تعریف جشنواره در مرکز تخفیف</Btn>}
                  <Btn size="sm" variant="ghost" onClick={() => setShowFestivalDetails((open) => !open)}>{showFestivalDetails ? "بستن تنظیمات جشنواره" : "تنظیم جشنواره"}</Btn>
                </div>
              </div>
            </Card>

            {showFestivalDetails && <div className="space-y-3">
              <Card className="space-y-3 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  {channels.length > 1 && <Field label="کانال اعمال جشنواره">
                    <Select options={channels} labels={CHANNEL_LABEL} value={festivalChannel} onChange={(value) => setFestivalChannel(value as Channel)} />
                  </Field>}
                  <Field label="تعریف جشنواره">
                    <Select options={festivalOptions.map((festival) => festival.id)} labels={Object.fromEntries(festivalOptions.map((festival) => [festival.id, `${festival.name} · ${festival.channel === "all" ? "همه کانال‌ها" : CHANNEL_LABEL[festival.channel]}`]))} value={festivalPick} onChange={setFestivalPick} />
                  </Field>
                  <Field label="درصد تخفیف محصول در جشنواره"><Input value={festivalValue} onChange={(value) => setFestivalValue(value.replace(/\D/g, ""))} /></Field>
                </div>
                {confirmFestivalMove && <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"><p className="font-bold">محصول به «{assigned?.name}» متصل است. انتقال به «{selectedFestival?.name}» جشنواره قبلی را خاموش می‌کند.</p><div className="flex flex-wrap gap-2"><Btn size="sm" variant="accent" disabled={busy} onClick={() => selectedFestival && void setFestivalMode(selectedFestival.id, true)}>تأیید انتقال</Btn><Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalMove(false)}>انصراف</Btn></div></div>}
                <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10.5px] text-[var(--kv-muted)]">تعریف‌های قابل انتخاب: {fa(festivalOptions.length)}</span><Btn size="sm" variant="soft" disabled={busy || !festivalPick} onClick={requestFestivalOn}><PartyPopper size={13} />اعمال جشنوارهٔ انتخاب‌شده</Btn></div>
              </Card>
              {festivalRules(festivalChannel).length > 0 && <Card className="p-4"><h4 className="mb-2 text-sm font-bold">قوانین جشنوارهٔ این محصول</h4><ul className="space-y-2">{festivalRules(festivalChannel).map((rule) => <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--kv-line)] p-3 text-xs"><span><b>{scopeLabel(rule)}</b> · {rule.promotion_name ?? "جشنواره"} · {valueLabel(rule)}</span><span className={rule.active && !rule.effectively_suspended ? "text-amber-800" : "text-[var(--kv-muted)]"}>{rule.active ? rule.effectively_suspended ? "معلق" : "فعال" : "خاموش"}</span></li>)}</ul></Card>}
            </div>}
          </section>

          <section className="space-y-3" aria-label="پیش‌نمایش قیمت نهایی">
            <div><h3 className="font-bold">پیش‌نمایش قیمت نهایی از سرور</h3><p className="text-[11px] text-[var(--kv-muted)]">نتیجهٔ محاسبه‌شده توسط سرور برای همهٔ واریانت‌های فعال (تا ۱۰۰ مورد)، به تفکیک کانال؛ پیش‌نمایش محلی وجود ندارد.</p></div>
            {previewLoading && <LoadingState label="در حال محاسبه در سرور…" />}
            {previewError && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{previewError}</p>}
            {!previewLoading && !previewError && channels.map((channel) => (
              <div key={channel} className="space-y-2">
                <h4 className="text-[12.5px] font-bold">کانال {CHANNEL_LABEL[channel]}{channel === "retail" ? paymentMode === "four_installments" ? " · چهارقسطه" : " · نقدی" : ""}</h4>
                {previews[channel].length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {previews[channel].map((line) => <Card key={`${channel}-${line.variantId}`} className="space-y-2 p-3">
                    <div className="flex items-start justify-between gap-2"><b dir="ltr" className="font-mono text-xs">{line.sku}</b><span className="text-[10px] text-[var(--kv-muted)]">{line.color ?? "—"} / {line.size ?? "—"}</span></div>
                    <div className="grid grid-cols-3 gap-1 text-[10px]"><div><span className="block text-[var(--kv-muted)]">پایه</span><b className="block break-words">{fmtToman(line.basePrice)}</b></div><div><span className="block text-[var(--kv-muted)]">تخفیف</span><b className="block break-words">{fmtToman(line.discountAmount)}</b></div><div><span className="block text-[var(--kv-muted)]">نهایی</span><b className="block break-words text-emerald-800">{fmtToman(line.finalPrice)}</b></div></div>
                    <p className="text-[10px] text-[var(--kv-muted)]">منبع: {line.source === "festival" ? "جشنواره" : line.source === "promotion_rule" ? "قانون تخفیف" : "بدون تخفیف"}{line.matchedRule?.name ? ` · ${line.matchedRule.name}` : ""}</p>
                  </Card>)}
                </div> : <Empty title="واریانت فعالی برای محاسبه نیست" desc="پس از تعریف واریانت‌های محصول، پیش‌نمایش اینجا ظاهر می‌شود." />}
              </div>
            ))}
          </section>

          {actionError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">{actionError}</p>}
          <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--kv-line)] pt-3">
            <Btn variant="ghost" onClick={() => void reload()}><RefreshCw size={13} />بازخوانی قوانین مرکزی</Btn>
            <Btn variant="soft" onClick={onClose} icon={<ArrowRight size={14} />}>{backLabel}</Btn>
          </div>
        </>
      )}
    </div>
  );
}

/** The stable header of the workspace: identity, sales mode, publication state and the way back. */
function PageHeader({ productName, productImage, sku, salesModeLabel, publication, onClose, backLabel }: {
  productName: string; productImage?: string; sku?: string; salesModeLabel: string;
  publication: { label: string; cls: string }; onClose: () => void; backLabel: string;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3" >
      <Btn size="sm" variant="ghost" onClick={onClose} icon={<ArrowRight size={14} />}>{backLabel}</Btn>
      <SafeImg src={productImage} alt={productName} className="h-14 w-12 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0">
        <b className="block break-words">{productName}</b>
        {/* §14/§19: the operator never sees a database identifier — only the real SKU. */}
        {sku
          ? <span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{sku}</span>
          : <span className="text-[11px] text-[var(--kv-muted)]">کد کالا ثبت نشده است</span>}
      </div>
      <div className="mr-auto flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 font-bold">حالت فروش: {salesModeLabel}</span>
        <span className={cn("rounded-full px-2.5 py-1 font-bold", publication.cls)}>وضعیت انتشار: {publication.label}</span>
      </div>
    </Card>
  );
}
