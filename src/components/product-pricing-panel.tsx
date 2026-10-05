import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, Check, ExternalLink, PartyPopper, RefreshCw } from "lucide-react";
import { Btn, Card, Empty, Field, Input, LoadingState, Segmented, Select } from "./primitives";
import { productsApi, promotionRulesApi } from "../data/api";
import { fmtToman, rialFromToman, tomanFromRial } from "../data/contracts";
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
type ServerPriceLine = {
  variantId: string; sku: string; color: string | null; size: string | null;
  basePrice: string; discountAmount: string; finalPrice: string; source: "none" | "promotion_rule" | "festival";
  matchedRule: { id: string; name: string | null; promotionId: string | null } | null;
};

const CHANNEL_LABEL: Record<Channel, string> = { retail: "خرده", wholesale: "عمده" };
/**
 * §6/§7/§12 (unified Product Studio): the canonical discount/festival editor, EMBEDDED as
 * Studio step «قیمت‌گذاری و تخفیف» (and reused by any other surface that needs product pricing).
 *
 *  Discount and festival rules are read/written ONLY through the canonical promotion API
 *  (promotion_rules/promotions tables) and every preview comes from the checkout resolver.
 *  Base prices (قیمت نقدی/چهارقسطه/عمده) stay in Product Studio: the Studio draft owns the
 *  catalog price columns, so this panel never becomes a second price authority.
 *
 *  Sales Mode is owned by the Product Studio (step «اطلاعات پایه») — this panel only REFLECTS it.
 *  The rejected «حالت قیمت خرده/عمده» selector is gone: retail and wholesale sections appear
 *  because the product's canonical sales mode enables them, and each section manages only its
 *  own channel's rules.
 */
export function ProductPricingPanel({ productId, productName, flash, onOpenPromotionCenter, refreshToken }: {
  productId: string; productName: string;
  flash: (msg: string) => void;
  /** §29: the owning Studio bumps this after a base-price save, so the preview reloads the
   *  canonical resolution instead of showing a stale price next to fresh catalog columns. */
  refreshToken?: number;
  /** Optional: jump to the central Promotion Center (cross-product campaigns stay there). */
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
  const [busy, setBusy] = useState(false);
  const [festivalPick, setFestivalPick] = useState("");
  const [festivalValue, setFestivalValue] = useState("15");
  const [confirmFestivalExit, setConfirmFestivalExit] = useState(false);
  const [confirmFestivalMove, setConfirmFestivalMove] = useState(false);
  const [previews, setPreviews] = useState<Record<Channel, ServerPriceLine[]>>({ retail: [], wholesale: [] });
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
      setFestivals((promotionList.promotions ?? []).filter((promotion) => {
        const row = promotion as unknown as Festival;
        return row.kind === "festival" && row.active && (!row.ends_at || new Date(row.ends_at).getTime() > Date.now());
      }) as unknown as Festival[]);
      setPaymentMode("cash");
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
  }, [productId, flash, refreshToken]);
  useEffect(() => { void reload(); }, [reload]);

  const hasRetail = detail?.retail_enabled !== false;
  const hasWholesale = detail?.wholesale_enabled !== false;
  const channels = useMemo<Channel[]>(() => [...(hasRetail ? ["retail" as const] : []), ...(hasWholesale ? ["wholesale" as const] : [])], [hasRetail, hasWholesale]);
  const salesModeLabel = hasRetail && hasWholesale ? "خرده + عمده" : hasRetail ? "فقط خرده" : hasWholesale ? "فقط عمده" : "بدون کانال فروش";
  const activeVariants = useMemo(() => variants.filter((variant) => variant.active), [variants]);
  const assigned = summary?.assignedFestival ?? null;
  const festivalBlocksNormal = Boolean(assigned?.active && assigned.promotionActive && (!assigned.endsAt || new Date(assigned.endsAt).getTime() > Date.now()));
  const festivalOn = festivalBlocksNormal;

  const channelRules = useCallback((channel: Channel) => rules.filter((rule) => rule.channel === "all" || rule.channel === channel), [rules]);
  const standaloneRules = useCallback((channel: Channel) => channelRules(channel).filter((rule) => !rule.promotion_id), [channelRules]);
  const festivalRules = useCallback((channel: Channel) => channelRules(channel).filter((rule) => rule.promotion_id), [channelRules]);
  const assignedFestivalRule = useMemo(() => rules.find((rule) => rule.promotion_id
    && rule.promotion_id === (summary?.assignedFestival?.promotionId ?? null) && rule.target_type === "product") ?? null,
    [rules, summary]);

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
    }).then((result) => [channel, result.lines as unknown as ServerPriceLine[]] as const)
      .catch((error) => { throw error; })))
      .then((pairs) => {
        if (!alive) return;
        const next: Record<Channel, ServerPriceLine[]> = { retail: [], wholesale: [] };
        for (const [channel, lines] of pairs) next[channel] = lines;
        setPreviews(next);
      })
      .catch((error) => { if (alive) { setPreviews({ retail: [], wholesale: [] }); setPreviewError(error instanceof Error ? error.message : "پیش‌نمایش موتور قیمت‌گذاری در دسترس نیست."); } })
      .finally(() => { if (alive) setPreviewLoading(false); });
    return () => { alive = false; };
  }, [activeVariants, channels, paymentMode, rules, summary]);

  const setStandaloneMode = async (enabled: boolean, confirmExit = false) => {
    if (busy) return;
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.setProductMode(productId, { mode: "standalone", enabled, ...(confirmExit ? { confirmFestivalExit: true } : {}) });
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
      flash(promotionId ? "جشنواره از رکورد مرکزی اعمال شد؛ قوانین مستقل محفوظ و معلق شدند." : "جشنوارهٔ محصول خاموش شد؛ تخفیف‌های مستقل همچنان خاموش/معلق می‌مانند.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "تغییر وضعیت جشنواره ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  const requestFestivalOn = () => {
    if (!selectedFestival) { setActionError("یک جشنوارهٔ فعال از مرکز مرکزی انتخاب کنید."); return; }
    if (!Number.isInteger(Number(festivalValue)) || Number(festivalValue) < 1 || Number(festivalValue) > 95) {
      setActionError("درصد جشنواره باید بین ۱ تا ۹۵ باشد."); return;
    }
    if (festivalBlocksNormal && assigned?.promotionId !== selectedFestival.id) { setConfirmFestivalMove(true); return; }
    void setFestivalMode(selectedFestival.id, false);
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

  /* ------------------------- §11/§12: operational discount editing ---------------------------
     One editor serves every canonical scope (product / color / size / exact variant) and the
     Color × Size matrix is the fast path: click a cell, or a row/column header, and apply a
     percentage or a fixed amount. Every write goes to the SAME canonical promotion records —
     the server resolver stays the only authority for the final price. */
  const [matrixDraft, setMatrixDraft] = useState<{
    channel: Channel; scope: "product" | "color" | "size" | "variant";
    color: string; size: string; variantId: string; type: "percent" | "fixed_rial"; value: string;
  }>({ channel: "retail", scope: "product", color: "", size: "", variantId: "", type: "percent", value: "" });

  const matrixFor = (channel: Channel) => {
    const sizes = [...new Set(activeVariants.map((variant) => variant.size).filter((size): size is string => Boolean(size)))];
    const colors = [...new Set(activeVariants.map((variant) => variant.color).filter((color): color is string => Boolean(color)))];
    return {
      sizes,
      colors,
      rows: colors.map((color) => ({
        color,
        cells: sizes.map((size) => {
          const variant = activeVariants.find((candidate) => candidate.color === color && candidate.size === size) ?? null;
          const exact = variant ? standaloneRules(channel).filter((rule) => rule.target_type === "variant" && rule.variant_id === variant.id) : [];
          const rule = exact.find((candidate) => candidate.channel === channel) ?? exact.find((candidate) => candidate.channel === "all") ?? null;
          const colorRule = standaloneRules(channel).find((candidate) => candidate.target_type === "color" && candidate.color_id === color) ?? null;
          const sizeRule = standaloneRules(channel).find((candidate) => candidate.target_type === "size" && (candidate.size_code ?? "").toUpperCase() === size.toUpperCase()) ?? null;
          const productRule = standaloneRules(channel).find((candidate) => candidate.target_type === "product"
            && (candidate.channel === channel || candidate.channel === "all")) ?? null;
          return { size, variant, rule, inherited: !rule ? (sizeRule ?? colorRule ?? productRule) : null };
        }),
      })),
    };
  };

  const scopeValue = (draft: typeof matrixDraft) => draft.scope === "color" ? draft.color
    : draft.scope === "size" ? draft.size : draft.scope === "variant" ? draft.variantId : "";
  const existingRuleFor = (channel: Channel, scope: string, target: string) => standaloneRules(channel).find((rule) =>
    (rule.channel === channel || rule.channel === "all") && rule.target_type === scope
    && (scope === "product" || scope === "color" && rule.color_id === target
      || scope === "size" && (rule.size_code ?? "").toUpperCase() === target.toUpperCase()
      || scope === "variant" && rule.variant_id === target)) ?? null;

  const clearStandalone = async (rule: RuleRow) => {
    if (busy) return;
    setBusy(true); setActionError(null);
    try {
      await promotionRulesApi.deactivateRule(rule.id);
      flash("تخفیف این محدوده برداشته شد؛ سایر قوانین دست‌نخورده ماندند.");
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "حذف تخفیف ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  /** ONE canonical write path for every scope — create or update the matching rule. */
  const applyDiscount = async () => {
    if (busy) return;
    const draft = matrixDraft;
    const target = scopeValue(draft);
    const raw = draft.value.trim();
    const numeric = Number(raw);
    if (!raw || !Number.isFinite(numeric) || numeric <= 0 || (draft.type === "percent" && (!Number.isInteger(numeric) || numeric > 95))) {
      setActionError(draft.type === "percent" ? "درصد تخفیف باید عددی بین ۱ تا ۹۵ باشد." : "مبلغ تخفیف را به تومان وارد کنید."); return;
    }
    if (draft.scope !== "product" && !target) { setActionError("محدودهٔ تخفیف را انتخاب کنید."); return; }
    const existing = existingRuleFor(draft.channel, draft.scope, target);
    const variant = draft.scope === "variant" ? activeVariants.find((candidate) => candidate.id === target) : undefined;
    const name = draft.scope === "product" ? `تخفیف ${productName}`
      : draft.scope === "color" ? `تخفیف رنگ ${target}`
      : draft.scope === "size" ? `تخفیف سایز ${target}` : `تخفیف ${variant?.sku ?? "واریانت"}`;
    setBusy(true); setActionError(null);
    try {
      if (existing) {
        await promotionRulesApi.updateRule(existing.id, { discountType: draft.type, discountValue: rialForRule(draft.type, raw), active: true });
        flash("تخفیف ذخیره‌شده به‌روزرسانی و فعال شد.");
      } else {
        await promotionRulesApi.createRule({
          channel: draft.channel, targetType: draft.scope, productId,
          discountType: draft.type, discountValue: rialForRule(draft.type, raw),
          /* A discount the operator just created must actually apply: reactivate the product's
             standalone mode — unless a festival currently owns the price, which needs the
             explicit confirmation below (canonical override semantics). */
          active: !festivalBlocksNormal,
          ...(draft.scope === "color" ? { colorId: target } : {}),
          ...(draft.scope === "size" ? { sizeCode: target } : {}),
          ...(draft.scope === "variant" ? { variantId: target } : {}),
          name,
        }, newKey(productId));
        if (festivalBlocksNormal) { setConfirmFestivalExit(true); }
        else {
          if (!summary?.activeStandaloneRules) await promotionRulesApi.setProductMode(productId, { mode: "standalone", enabled: true });
          flash("تخفیف ثبت و روی محصول اعمال شد.");
        }
      }
      setMatrixDraft((current) => ({ ...current, value: "" }));
      await reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : "ثبت تخفیف ناموفق بود.";
      setActionError(message); flash(message);
    } finally { setBusy(false); }
  };

  if (loading) return <LoadingState label="در حال دریافت قوانین تخفیف و جشنوارهٔ canonical…" />;
  if (loadError) return (
    <Card className="space-y-3 p-4">
      <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{loadError}</p>
      <Btn variant="soft" onClick={() => void reload()}><RefreshCw size={14} />تلاش دوباره</Btn>
    </Card>
  );

  const normalRules = channels.flatMap((channel) => standaloneRules(channel));
  const configured = normalRules.length;
  const activeCount = normalRules.filter((rule) => rule.active && !rule.effectively_suspended).length;

  return (
    <div className="space-y-4" data-workspace="product-pricing" data-panel="studio-pricing">
      {/* §15: one compact status strip instead of large summary cards. */}
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 px-3 py-2 text-[11.5px]">
        <span className={cn("rounded-full px-2.5 py-1 font-bold", activeCount > 0 ? "bg-emerald-100 text-emerald-800" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
          {activeCount > 0 ? `${fa(activeCount)} تخفیف فعال` : "تخفیف فعالی وجود ندارد"}
        </span>
        <span className="text-[var(--kv-muted)]">{fa(configured)} قانون ثبت‌شده · حالت فروش: {salesModeLabel}</span>
        <span className="mr-auto flex flex-wrap items-center gap-2">
          <Btn size="sm" variant="ghost" onClick={() => void reload()}><RefreshCw size={13} />بازخوانی از سرور</Btn>
          {onOpenPromotionCenter && <Btn size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => onOpenPromotionCenter("discount")}>مرکز تخفیف و جشنواره</Btn>}
        </span>
      </div>

      {festivalBlocksNormal && (
        <p role="status" className="rounded-[10px] border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] leading-6 text-amber-950">
          جشنوارهٔ «{assigned?.name}» اکنون قیمت این محصول را تعیین می‌کند؛ تخفیف‌های مستقل معلق‌اند و پس از پایان/خروج جشنواره خودکار روشن نمی‌شوند.
        </p>
      )}
      {confirmFestivalExit && (
        <div className="space-y-2 rounded-[12px] border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <p className="font-bold">اعمال تخفیف مستقل، جشنوارهٔ فعال/زمان‌بندی‌شدهٔ این محصول را خاموش می‌کند. این اقدام صریح است.</p>
          <div className="flex flex-wrap gap-2">
            <Btn size="sm" variant="accent" disabled={busy} onClick={() => void setStandaloneMode(true, true)}><Check size={13} />تأیید خروج و فعال‌سازی تخفیف‌ها</Btn>
            <Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalExit(false)}>انصراف</Btn>
          </div>
        </div>
      )}

      {/* §12: the color × size matrix IS the editor — click a cell, a row or a column header. */}
      {channels.map((channel) => {
        const matrix = matrixFor(channel);
        const hasGrid = matrix.rows.length > 0 && matrix.sizes.length > 0;
        return (
          <Card key={channel} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-[13px] font-extrabold">تخفیف فروش {CHANNEL_LABEL[channel]}</h4>
                <p className="mt-0.5 text-[11px] leading-5 text-[var(--kv-muted)]">
                  روی هر خانه بزنید تا همان ترکیب رنگ × سایز را ویرایش کنید؛ از سرستون‌ها می‌توانید همان تخفیف را روی همهٔ رنگ‌ها یا همهٔ سایزها اعمال کنید.
                </p>
              </div>
              <span className="text-[10.5px] text-[var(--kv-muted)]">{fa(standaloneRules(channel).length)} قانون در این کانال</span>
            </div>

            {hasGrid ? (
              <div className="kv-scroll-x rounded-[10px] border border-[var(--kv-line)]">
                <table className="kv-table w-full min-w-[460px] text-[11.5px]">
                  <thead>
                    <tr>
                      <th className="sticky right-0 z-10 bg-[var(--kv-surface)] text-right">رنگ / سایز</th>
                      {matrix.sizes.map((size) => (
                        <th key={size} className="text-center">
                          <button type="button" dir="ltr" className="font-bold hover:text-[var(--kv-accent)]"
                            aria-label={`اعمال تخفیف روی همهٔ رنگ‌های سایز ${size}`}
                            onClick={() => setMatrixDraft({ channel, scope: "size", color: "", size, variantId: "", type: "percent", value: "" })}>
                            {size} ▾
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => (
                      <tr key={row.color}>
                        <th className="sticky right-0 z-10 whitespace-nowrap bg-[var(--kv-surface)] text-right">
                          <button type="button" className="font-bold hover:text-[var(--kv-accent)]"
                            aria-label={`اعمال تخفیف روی همهٔ سایزهای رنگ ${row.color}`}
                            onClick={() => setMatrixDraft({ channel, scope: "color", color: row.color, size: "", variantId: "", type: "percent", value: "" })}>
                            {row.color} ▾
                          </button>
                        </th>
                        {row.cells.map((cell) => {
                          const shown = cell.rule ? valueLabel(cell.rule) : cell.inherited ? valueLabel(cell.inherited) : "—";
                          const own = Boolean(cell.rule);
                          return (
                            <td key={`${row.color}-${cell.size}`} className="p-1 text-center">
                              <button type="button" disabled={!cell.variant}
                                aria-label={`تخفیف ${row.color} سایز ${cell.size}`}
                                className={cn("min-h-9 w-full min-w-[64px] rounded-[8px] border px-2 text-[11.5px] font-bold transition-colors",
                                  own ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.08]"
                                    : cell.inherited ? "border-dashed border-[var(--kv-line)] text-[var(--kv-muted)]"
                                      : "border-[var(--kv-line)]",
                                  !cell.variant && "opacity-40")}
                                onClick={() => cell.variant && setMatrixDraft({
                                  channel, scope: "variant", color: row.color, size: cell.size, variantId: cell.variant.id,
                                  type: cell.rule?.discount_type ?? "percent",
                                  value: cell.rule ? (cell.rule.discount_type === "percent" ? cell.rule.discount_value : String(tomanFromRial(cell.rule.discount_value))) : "",
                                })}>
                                {shown}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="ماتریس رنگ × سایز خالی است" desc="برای نمایش خانه‌ها ابتدا در گام «رنگ، سایز و واریانت‌ها» واریانت بسازید." />
            )}

            <div className="grid gap-3 rounded-[12px] border border-[var(--kv-line)] p-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="محدوده">
                <Select options={["product", "color", "size", "variant"]}
                  labels={{ product: "کل محصول", color: "همهٔ سایزهای یک رنگ", size: "همهٔ رنگ‌های یک سایز", variant: "دقیقاً یک رنگ × سایز" }}
                  value={matrixDraft.scope}
                  onChange={(value) => setMatrixDraft((current) => ({ ...current, channel, scope: value as typeof current.scope, color: "", size: "", variantId: "" }))} />
              </Field>
              {matrixDraft.scope === "color" && (
                <Field label="رنگ">
                  <Select options={matrix.colors} value={matrixDraft.color} onChange={(value) => setMatrixDraft((current) => ({ ...current, color: value }))} />
                </Field>
              )}
              {matrixDraft.scope === "size" && (
                <Field label="سایز">
                  <Select options={matrix.sizes} value={matrixDraft.size} onChange={(value) => setMatrixDraft((current) => ({ ...current, size: value }))} />
                </Field>
              )}
              {matrixDraft.scope === "variant" && (
                <Field label="رنگ × سایز">
                  <Select options={activeVariants.map((variant) => variant.id)}
                    labels={Object.fromEntries(activeVariants.map((variant) => [variant.id, `${variant.color ?? "—"} / ${variant.size ?? "—"} · ${variant.sku}`]))}
                    value={matrixDraft.variantId} onChange={(value) => setMatrixDraft((current) => ({ ...current, variantId: value }))} />
                </Field>
              )}
              <Field label="نوع تخفیف">
                <Select options={["percent", "fixed_rial"]} labels={{ percent: "درصد", fixed_rial: "مبلغ ثابت (تومان)" }}
                  value={matrixDraft.type} onChange={(value) => setMatrixDraft((current) => ({ ...current, type: value as typeof current.type }))} />
              </Field>
              <Field label={matrixDraft.type === "percent" ? "درصد (۱ تا ۹۵)" : "مبلغ (تومان)"}>
                <Input value={matrixDraft.value} onChange={(value) => setMatrixDraft((current) => ({ ...current, value: value.replace(/\D/g, "") }))} />
              </Field>
              <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
                <Btn size="sm" variant="accent" disabled={busy} onClick={() => void applyDiscount()} icon={<BadgePercent size={13} />}>اعمال تخفیف</Btn>
                <Btn size="sm" variant="soft" disabled={busy} onClick={() => { setMatrixDraft({ channel, scope: "product", color: "", size: "", variantId: "", type: "percent", value: "" }); }}>اعمال روی کل محصول</Btn>
                {(() => {
                  const target = scopeValue(matrixDraft);
                  const existing = matrixDraft.channel === channel ? existingRuleFor(channel, matrixDraft.scope, target) : null;
                  return existing ? (
                    <>
                      <span className="text-[11px] text-[var(--kv-muted)]">مقدار فعلی این محدوده: <b className="text-[var(--kv-ink)]">{valueLabel(existing)}</b></span>
                      <Btn size="sm" variant="ghost" className="text-[var(--kv-danger)]" disabled={busy} onClick={() => void clearStandalone(existing)}>حذف تخفیف این محدوده</Btn>
                    </>
                  ) : (
                    <span className="text-[11px] text-[var(--kv-muted)]">برای این محدوده تخفیف مستقلی ثبت نشده است.</span>
                  );
                })()}
              </div>
            </div>

            <details className="rounded-[10px] border border-[var(--kv-line)] p-3">
              <summary className="cursor-pointer text-[12px] font-bold">قوانین ثبت‌شدهٔ این کانال ({fa(standaloneRules(channel).length)})</summary>
              {!standaloneRules(channel).length ? <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">هنوز تخفیفی ثبت نشده است.</p> : (
                <ul className="mt-2 space-y-2">
                  {standaloneRules(channel).map((rule) => (
                    <li key={rule.id} className={cn("flex flex-wrap items-center gap-2 rounded-[10px] border p-2.5 text-[11.5px]", rule.effectively_suspended ? "border-amber-200 bg-amber-50/50" : "border-[var(--kv-line)]")}>
                      <b>{scopeLabel(rule)}</b>
                      <span className="text-[var(--kv-muted)]">{rule.effectively_suspended ? `معلق با ${rule.suspended_by_name ?? "جشنواره"}` : rule.active ? "فعال" : "خاموش"}</span>
                      <strong className="mr-auto">{valueLabel(rule)}</strong>
                      <Btn size="sm" variant="ghost" disabled={busy || (festivalBlocksNormal && !rule.promotion_id)} onClick={() => void toggleRule(rule)}>
                        {rule.active && !rule.effectively_suspended ? "خاموش کردن" : "فعال‌سازی"}
                      </Btn>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </Card>
        );
      })}

      {/* §13: real festival management — assign, inspect the window, or exit; never a dead switch. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="flex items-center gap-2 text-[13px] font-extrabold"><PartyPopper size={15} />جشنواره</h4>
            <p className="mt-0.5 text-[11px] leading-5 text-[var(--kv-muted)]">جشنواره از تعریف‌های مرکز تخفیف می‌آید؛ ورود به آن تخفیف‌های مستقل را معلق می‌کند و خروج، آن‌ها را خودکار روشن نمی‌کند.</p>
          </div>
          <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", festivalOn ? "bg-amber-100 text-amber-900" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
            {festivalOn ? `جشنواره فعال: ${assigned?.name ?? ""}` : assigned ? `عضو جشنوارهٔ «${assigned.name}» (اعمال نشده)` : "بدون جشنواره"}
          </span>
        </div>
        {assigned && (
          <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6">
            {assigned.effective ? "اکنون روی قیمت اعمال می‌شود" : assigned.active && assigned.promotionActive ? "زمان‌بندی‌شده یا خارج از بازهٔ اثر" : "خاموش یا پایان‌یافته"}
            {assigned.endsAt ? ` · پایان ${new Date(assigned.endsAt).toLocaleDateString("fa-IR")}` : ""}
            {assignedFestivalRule ? ` · تخفیف ${valueLabel(assignedFestivalRule)}` : ""}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {channels.length > 1 && (
            <Field label="کانال اعمال جشنواره">
              <Select options={channels} labels={CHANNEL_LABEL} value={festivalChannel} onChange={(value) => setFestivalChannel(value as Channel)} />
            </Field>
          )}
          <Field label="انتخاب جشنواره">
            <Select options={festivalOptions.map((festival) => festival.id)}
              labels={Object.fromEntries(festivalOptions.map((festival) => [festival.id, `${festival.name} · ${festival.channel === "all" ? "همه کانال‌ها" : CHANNEL_LABEL[festival.channel]}`]))}
              value={festivalPick} onChange={setFestivalPick} />
          </Field>
          <Field label="درصد تخفیف محصول در جشنواره">
            <Input value={festivalValue} onChange={(value) => setFestivalValue(value.replace(/\D/g, ""))} />
          </Field>
        </div>
        {confirmFestivalMove && (
          <div className="space-y-2 rounded-[12px] border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
            <p className="font-bold">محصول به «{assigned?.name}» متصل است. انتقال به «{selectedFestival?.name}» جشنوارهٔ قبلی را خاموش می‌کند.</p>
            <div className="flex flex-wrap gap-2">
              <Btn size="sm" variant="accent" disabled={busy} onClick={() => selectedFestival && void setFestivalMode(selectedFestival.id, true)}>تأیید انتقال</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setConfirmFestivalMove(false)}>انصراف</Btn>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Btn size="sm" variant="accent" disabled={busy || !festivalPick} onClick={requestFestivalOn}><PartyPopper size={13} />اعمال جشنوارهٔ انتخاب‌شده</Btn>
          {assigned && <Btn size="sm" variant="ghost" className="text-[var(--kv-danger)]" disabled={busy} onClick={() => void setFestivalMode(null)}>خروج از جشنواره</Btn>}
          <span className="text-[11px] text-[var(--kv-muted)]">{fa(festivalOptions.length)} تعریف فعال قابل انتخاب است.</span>
        </div>
        {festivalRules(festivalChannel).length > 0 && (
          <details className="rounded-[10px] border border-[var(--kv-line)] p-3">
            <summary className="cursor-pointer text-[12px] font-bold">قوانین جشنوارهٔ این محصول ({fa(festivalRules(festivalChannel).length)})</summary>
            <ul className="mt-2 space-y-1.5">
              {festivalRules(festivalChannel).map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--kv-line)] px-2.5 py-2 text-[11.5px]">
                  <span><b>{scopeLabel(rule)}</b> · {rule.promotion_name ?? "جشنواره"} · {valueLabel(rule)}</span>
                  <span className={rule.active && !rule.effectively_suspended ? "text-amber-800" : "text-[var(--kv-muted)]"}>{rule.active ? rule.effectively_suspended ? "معلق" : "فعال" : "خاموش"}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {/* §2: the final price is ALWAYS the server resolver's answer — never computed locally. */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-[13px] font-extrabold">پیش‌نمایش قیمت نهایی (محاسبهٔ سرور)</h4>
            <p className="mt-0.5 text-[11px] text-[var(--kv-muted)]">برای همهٔ واریانت‌های فعال، با همان موتور قیمت‌گذاری لحظهٔ خرید.</p>
          </div>
          {hasRetail && <Segmented options={[{ v: "cash", label: "نقدی" }, { v: "four_installments", label: "چهارقسطه" }]} value={paymentMode} onChange={(value) => setPaymentMode(value as typeof paymentMode)} />}
        </div>
        {previewLoading && <LoadingState label="در حال محاسبه در سرور…" />}
        {previewError && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{previewError}</p>}
        {!previewLoading && !previewError && channels.map((channel) => (
          <div key={channel} className="space-y-2">
            <h5 className="text-[12px] font-bold">کانال {CHANNEL_LABEL[channel]}{channel === "retail" ? paymentMode === "four_installments" ? " · چهارقسطه" : " · نقدی" : ""}</h5>
            {previews[channel].length ? (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {previews[channel].map((line) => (
                  <div key={`${channel}-${line.variantId}`} className="space-y-1.5 rounded-[10px] border border-[var(--kv-line)] p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <b dir="ltr" className="font-mono text-[11px]">{line.sku}</b>
                      <span className="text-[10px] text-[var(--kv-muted)]">{line.color ?? "—"} / {line.size ?? "—"}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px]">
                      <div><span className="block text-[var(--kv-muted)]">پایه</span><b className="block break-words">{fmtToman(line.basePrice)}</b></div>
                      <div><span className="block text-[var(--kv-muted)]">تخفیف</span><b className="block break-words">{fmtToman(line.discountAmount)}</b></div>
                      <div><span className="block text-[var(--kv-muted)]">نهایی</span><b className="block break-words text-emerald-800">{fmtToman(line.finalPrice)}</b></div>
                    </div>
                    <p className="text-[10px] text-[var(--kv-muted)]">منبع: {line.source === "festival" ? "جشنواره" : line.source === "promotion_rule" ? "قانون تخفیف" : "بدون تخفیف"}{line.matchedRule?.name ? ` · ${line.matchedRule.name}` : ""}</p>
                  </div>
                ))}
              </div>
            ) : <p className="text-[11.5px] text-[var(--kv-muted)]">واریانت فعالی برای محاسبه نیست.</p>}
          </div>
        ))}
      </Card>

      {actionError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-800">{actionError}</p>}
    </div>
  );
}
