import { useCallback, useEffect, useState } from "react";
import { authBlobUrl, catalogOpsApi, productsApi, promotionRulesApi, seriesTemplatesApi, sizeGuidesApi, specsApi } from "../data/api";
import { fmtToman, INSTALLMENT_POLICIES, INSTALLMENT_POLICY_LABEL, normalizeSizeGuide, readProductSpecs } from "../data/contracts";
import type { InstallmentPolicy, ProductSpecs, SizeGuide } from "../data/contracts";
import { Btn, Card, Empty, ErrorState, LoadingState, Segmented, WorkspaceModal } from "./primitives";
import { ProductInventoryDrawer } from "./product-inventory";

type Detail = Awaited<ReturnType<typeof productsApi.adminDetail>>;
type Series = Awaited<ReturnType<typeof seriesTemplatesApi.detail>>;
type PricingSummary = Awaited<ReturnType<typeof promotionRulesApi.productSummary>>;
type PricingRule = {
  id: string; name: string | null; channel: string; target_type: string; color_id: string | null; size_code: string | null;
  variant_id: string | null; variant_sku: string | null; discount_type: "percent" | "fixed_rial"; discount_value: string;
  active: boolean; promotion_id: string | null; promotion_name: string | null; effectively_suspended: boolean;
  suspended_by_name: string | null;
};
type PricingLine = {
  variantId: string; sku: string; color: string | null; size: string | null;
  basePrice: string; discountAmount: string; finalPrice: string;
  source: "none" | "promotion_rule" | "festival";
  matchedRule: { id: string; name: string | null; promotionId: string | null } | null;
};
type Product360Tab = "overview" | "variants" | "specs" | "size-guide" | "media" | "pricing" | "wholesale" | "inventory" | "seo" | "history";
type Product360Data = {
  detail: Detail;
  series: Series[];
  specs: ProductSpecs | null;
  sizeGuide: SizeGuide | null;
  sizeGuideMode: string | null;
  specLabels: Record<string, string>;
  images: string[];
  videoUrl: string;
  pricing: { summary: PricingSummary | null; rules: PricingRule[]; preview: PricingLine[]; error: string | null };
};
const fa = (n: unknown) => String(n ?? "—").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const noWarehouses: [] = [];
/** §23/§26: Product 360 shows the canonical publication state in Persian — raw enums never leak. */
const PUBLICATION_FA: Record<string, string> = {
  draft: "پیش‌نویس", published: "منتشرشده", pending: "در انتظار تأیید", rejected: "ردشده", archived: "آرشیوشده",
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (Array.isArray(value)) return value.map(displayValue).join("، ") || "—";
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(displayValue).join("، ") || "—";
  return String(value);
}

/** Product facts are read from their owners; this workspace never writes stock. */
export function Product360({ product, onClose, onPricing }: {
  product: { id: string; name: string }; onClose: () => void; onPricing: () => void;
}) {
  const [tab, setTab] = useState<Product360Tab>("overview");
  const [data, setData] = useState<Product360Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setData(null);
    try {
      const [detailResult, listResult, guideResult, specsResult, summaryResult, rulesResult] = await Promise.allSettled([
        productsApi.adminDetail(product.id),
        seriesTemplatesApi.list(product.id),
        sizeGuidesApi.productGuide(product.id),
        specsApi.productSpecs(product.id),
        promotionRulesApi.productSummary(product.id),
        promotionRulesApi.rulesByProduct(product.id),
      ]);
      if (detailResult.status === "rejected") throw detailResult.reason;
      const detail = detailResult.value;
      const list = listResult.status === "fulfilled" ? listResult.value : { items: [] as Record<string, unknown>[] };
      const guideLink = guideResult.status === "fulfilled" ? guideResult.value as { mode?: string; guide?: unknown } : null;
      const specs = specsResult.status === "fulfilled" ? readProductSpecs(specsResult.value) : null;
      const pricingSummary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
      const pricingRules = rulesResult.status === "fulfilled" ? rulesResult.value.items as unknown as PricingRule[] : [];
      const [schemaResult, series] = await Promise.all([
        catalogOpsApi.categorySchema(String(detail.category)).catch(() => null),
        Promise.all((list.items ?? []).map((template) => seriesTemplatesApi.detail(String(template.id)).catch(() => null))),
      ]);
      const schema = schemaResult as { specFields?: Record<string, unknown>[] } | null;
      const activeVariants = (detail.variants ?? []).filter((variant) => variant.active !== false).slice(0, 100);
      let pricingPreview: PricingLine[] = [];
      let pricingError = summaryResult.status === "rejected" || rulesResult.status === "rejected"
        ? "خلاصهٔ تخفیف از مرکز مرکزی در دسترس نیست." : null;
      if (detail.retail_enabled !== false && activeVariants.length) {
        try {
          const resolved = await promotionRulesApi.resolvePrices({
            orderType: "retail", paymentMode: "cash",
            items: activeVariants.map((variant) => ({ variantId: variant.id, quantity: 1 })),
          });
          pricingPreview = resolved.lines as unknown as PricingLine[];
        } catch (priceError) {
          pricingError ??= priceError instanceof Error ? priceError.message : "پیش‌نمایش Pricing Resolver در دسترس نیست.";
        }
      }
      const metadata = (detail.metadata ?? {}) as Record<string, unknown> & {
        images?: { fileId?: string; url?: string }[]; videoFileId?: string | null;
      };
      const images = await Promise.all((metadata.images ?? []).map((image) => image.fileId
        ? authBlobUrl(`/files/${image.fileId}`).catch(() => "")
        : Promise.resolve(image.url ?? "")));
      const videoUrl = metadata.videoFileId
        ? await authBlobUrl(`/files/${metadata.videoFileId}`).catch(() => "")
        : "";
      const specLabels = Object.fromEntries((schema?.specFields ?? []).map((field) => [String(field.code), String(field.label)]));
      setData({
        detail, series: series.filter((item): item is Series => item !== null), specs,
        sizeGuide: normalizeSizeGuide(guideLink?.guide), sizeGuideMode: guideLink?.mode ?? null,
        images: images.filter(Boolean), videoUrl, specLabels,
        pricing: { summary: pricingSummary, rules: pricingRules, preview: pricingPreview, error: pricingError },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "خواندن اطلاعات محصول انجام نشد.");
    }
  }, [product.id]);
  useEffect(() => { void load(); }, [load]);
  const detail = data?.detail;
  const variants = (detail?.variants ?? []) as { id: string; sku: string; color?: string; size?: string; active?: boolean }[];
  const metadata = (detail?.metadata ?? {}) as Record<string, unknown> & { seo?: { title?: string; slug?: string } };
  const seo = metadata.seo ?? {};
  const variantSkus = new Map(variants.map((variant) => [variant.id, variant.sku]));
  const legacySpecs = Object.entries((detail?.specifications ?? {}) as Record<string, unknown>);
  const structuredSpecs = data?.specs?.values ?? [];
  const pricingSummary = data?.pricing.summary ?? null;
  const standaloneRules = data?.pricing.rules.filter((rule) => rule.promotion_id === null) ?? [];
  const variantDiscountRules = standaloneRules.filter((rule) => rule.target_type === "variant");
  const assignedFestival = pricingSummary?.assignedFestival ?? null;
  const installmentPolicy = INSTALLMENT_POLICIES.includes(detail?.installment_policy as InstallmentPolicy)
    ? detail!.installment_policy as InstallmentPolicy : "disabled";
  const standaloneStatus = pricingSummary?.activeStandaloneRules
    ? "فعال"
    : pricingSummary?.suspendedStandaloneRules
      ? "معلق با Festival — برای بازگشت نیازمند فعال‌سازی صریح"
      : pricingSummary?.configuredStandaloneRules ? "خاموش" : "تنظیم نشده";
  const festivalStatus = !assignedFestival ? "تعریف نشده"
    : assignedFestival.effective ? "فعال اکنون"
      : assignedFestival.active && assignedFestival.promotionActive ? "فعال اما خارج از پنجرهٔ زمانی"
        : "خاموش یا پایان‌یافته";
  const discountLabel = (rule: PricingRule) => rule.discount_type === "percent"
    ? `${fa(rule.discount_value)}٪` : fmtToman(rule.discount_value);

  return <WorkspaceModal open onClose={onClose} title={`نمای جامع محصول — ${product.name}`} subtitle="تعریف کاتالوگ، قیمت و موجودی واقعی؛ مالکیت کالا مستقل از محل نگهداری آن است.">
    <div className="space-y-5" dir="rtl">
      <div className="max-w-full overflow-x-auto" aria-label="بخش‌های نمای جامع محصول">
        <Segmented value={tab} onChange={(value) => setTab(value as Product360Tab)} options={[
          { v: "overview", label: "نمای کلی" }, { v: "variants", label: "واریانت‌ها" },
          { v: "specs", label: "مشخصات فنی" }, { v: "size-guide", label: "راهنمای سایز" },
          { v: "media", label: "رسانه" }, { v: "pricing", label: "قیمت‌گذاری" },
          { v: "wholesale", label: "عمده و سری‌ها" }, { v: "inventory", label: "موجودی" },
          { v: "seo", label: "SEO" }, { v: "history", label: "تاریخچه" },
        ]} />
      </div>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : !data ? <LoadingState label="در حال خواندن اطلاعات محصول…" /> : <>
        {tab === "overview" && <div className="space-y-4 text-sm">
          <dl className="grid gap-4 sm:grid-cols-3">{[
            ["نام", detail!.name], ["برند", detail!.brand], ["دسته", detail!.category],
            ["مالک محصول", detail!.owner_type === "supplier" ? "تأمین‌کننده" : "کلبه"],
            ["روش فروش", detail!.retail_enabled && detail!.wholesale_enabled ? "خرده و عمده" : detail!.retail_enabled ? "خرده" : "عمده"],
            // §10/§23: the ONLY user-facing lifecycle state is the publication state.
            // «inventory_setup» stays an internal technical invariant — «پیش‌نویس» already
            // communicates «سفر ایجاد محصول کامل نشده است».
            ["وضعیت انتشار", PUBLICATION_FA[String(detail!.status ?? "")] ?? "پیش‌نویس"],
          ].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-[var(--kv-muted)]">{String(label)}</dt><dd className="mt-1 break-words font-bold">{String(value ?? "—")}</dd></div>)}</dl>
          <Card className="p-4"><h3 className="font-bold">توضیحات محصول</h3><p className="mt-2 whitespace-pre-wrap leading-7">{String(detail!.description ?? "توضیحی ثبت نشده است.")}</p></Card>
        </div>}

        {tab === "variants" && (variants.length ? <div className="overflow-x-auto rounded-xl border border-[var(--kv-line)]">
          <table className="kv-table min-w-[520px] w-full text-sm"><thead><tr><th>کد کالا (SKU)</th><th>رنگ</th><th>سایز</th><th>وضعیت</th></tr></thead><tbody>
            {variants.map((variant) => <tr key={variant.id}><td dir="ltr" className="font-mono tabular-nums">{variant.sku}</td><td>{variant.color ?? "—"}</td><td>{variant.size ?? "—"}</td><td>{variant.active === false ? "غیرفعال" : "فعال"}</td></tr>)}
          </tbody></table>
        </div> : <Empty title="واریانتی ثبت نشده است" desc="رنگ و سایز محصول را در استودیوی محصول تعریف کنید." />)}

        {tab === "specs" && <div className="space-y-4">
          {structuredSpecs.length > 0 && <Card className="overflow-hidden"><h3 className="border-b border-[var(--kv-line)] px-4 py-3 text-sm font-bold">مشخصات ثبت‌شده</h3>
            <div className="divide-y divide-[var(--kv-line)]">{structuredSpecs.map((spec) => <div key={`${spec.id}-${spec.variantId ?? "product"}`} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-sm">
              <span className="text-[var(--kv-muted)]">{spec.label}{spec.variantId ? ` · ${variantSkus.get(spec.variantId) ?? "واریانت"}` : ""}</span><strong className="max-w-full break-words text-left">{displayValue(spec.value)}{spec.unit ? ` ${spec.unit}` : ""}</strong>
            </div>)}</div>
          </Card>}
          {legacySpecs.length > 0 && <Card className="overflow-hidden"><h3 className="border-b border-[var(--kv-line)] px-4 py-3 text-sm font-bold">ویژگی‌های کاتالوگ</h3>
            <div className="divide-y divide-[var(--kv-line)]">{legacySpecs.map(([key, value]) => <div key={key} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-sm"><span className="text-[var(--kv-muted)]">{data.specLabels[key] ?? key}</span><strong className="max-w-full break-words text-left">{displayValue(value)}</strong></div>)}</div>
          </Card>}
          {!structuredSpecs.length && !legacySpecs.length && <Empty title="مشخصات فنی ثبت نشده" desc="مشخصات را در استودیوی محصول تعریف کنید." />}
        </div>}

        {tab === "size-guide" && (data.sizeGuide ? <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-bold">{data.sizeGuide.name}</h3><p className="mt-1 text-xs text-[var(--kv-muted)]">{data.sizeGuide.description || "راهنمای اندازهٔ متصل به این محصول"}</p></div>
            <span className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1 text-xs font-semibold">{data.sizeGuideMode === "detached" ? "نسخهٔ مستقل محصول" : "اتصال زنده"} · نسخه {fa(data.sizeGuide.version)}</span>
          </div>
          {data.sizeGuide.rows.length ? <div className="overflow-x-auto rounded-lg border border-[var(--kv-line)]"><table className="kv-table min-w-[520px] w-full text-sm"><thead><tr>{data.sizeGuide.columns.map((column) => <th key={column.id}>{column.label}{column.unit ? ` (${column.unit})` : ""}</th>)}</tr></thead><tbody>
            {data.sizeGuide.rows.map((row) => <tr key={row.id}>{data.sizeGuide!.columns.map((column) => <td key={column.id}>{row.values[column.code] ?? "—"}</td>)}</tr>)}
          </tbody></table></div> : <Empty title="راهنما جدول اندازه ندارد" desc="می‌توانید ستون‌ها و اندازه‌ها را در بخش ساختار محصولات تکمیل کنید." />}
        </Card> : <Empty title="راهنمای سایز متصل نیست" desc="راهنمای اندازه را پس از ذخیره در استودیوی محصول به این محصول متصل کنید." />)}

        {tab === "media" && (data.images.length || data.videoUrl ? <div className="space-y-4">
          {data.images.length > 0 && <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{data.images.map((src, index) => <img key={`${src}-${index}`} src={src} alt={`${product.name} — تصویر ${fa(index + 1)}`} className="aspect-[3/4] w-full rounded-xl object-cover" />)}</div>}
          {data.videoUrl && <video src={data.videoUrl} controls className="max-h-[420px] w-full rounded-xl bg-black" aria-label={`ویدیوی ${product.name}`} />}
        </div> : <Empty title="رسانه‌ای ثبت نشده" desc="تصاویر و ویدیو را در استودیوی محصول بارگذاری کنید." />)}

        {tab === "pricing" && <div className="space-y-3 text-sm">
          <Card className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-bold">خلاصهٔ قیمت‌گذاری محصول</h3><p className="mt-1 text-xs leading-5 text-[var(--kv-muted)]">قیمت پایه از کاتالوگ، تخفیف‌ها از Promotion Center و مبلغ نهایی از Pricing Resolver خوانده می‌شوند.</p></div>
              {(detail!.retail_enabled !== false || detail!.wholesale_enabled !== false) && <Btn variant="accent" aria-label="مدیریت قیمت‌گذاری" onClick={onPricing}>مدیریت قیمت‌گذاری</Btn>}
            </div>
            {detail!.retail_enabled === false && detail!.wholesale_enabled === false ? <Empty title="کانال فروشی فعال نیست" desc="کانال‌های فروش را در تعریف محصول تنظیم کنید." /> : <div className="grid gap-3 sm:grid-cols-2">
              {detail!.retail_enabled !== false && <div className="space-y-2 rounded-xl border border-[var(--kv-line)] p-3">
                <h4 className="font-bold">فروش خرده</h4>
                <p className="flex flex-wrap justify-between gap-2"><span>قیمت پایهٔ نقدی</span><strong>{fmtToman(detail!.cash_price_rial)}</strong></p>
                <p className="flex flex-wrap justify-between gap-2"><span>قیمت چهارقسطه</span><strong>{installmentPolicy === "disabled" ? "خاموش" : detail!.installment_price_rial ? fmtToman(detail!.installment_price_rial) : "برابر قیمت نقدی"}</strong></p>
                <p className="flex flex-wrap justify-between gap-2 text-xs text-[var(--kv-muted)]"><span>سیاست اقساط</span><strong>{INSTALLMENT_POLICY_LABEL[installmentPolicy]}</strong></p>
              </div>}
              {detail!.wholesale_enabled !== false && <div className="space-y-2 rounded-xl border border-[var(--kv-line)] p-3">
                <h4 className="font-bold">فروش عمده</h4>
                <p className="flex flex-wrap justify-between gap-2"><span>قیمت پایهٔ هر قطعه</span><strong>{fmtToman(detail!.wholesale_price_rial)}</strong></p>
                <p className="text-xs leading-5 text-[var(--kv-muted)]">قیمت سری و ترکیب آن از رکورد Series خوانده می‌شود.</p>
              </div>}
            </div>}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-[var(--kv-surface-2)] p-3"><span className="text-xs text-[var(--kv-muted)]">Discount مستقل</span><p className="mt-1 font-bold">{standaloneStatus}</p>
                <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{fa(pricingSummary?.activeStandaloneRules ?? 0)} فعال · {fa(pricingSummary?.suspendedStandaloneRules ?? 0)} معلق · {fa(pricingSummary?.configuredStandaloneRules ?? 0)} ذخیره‌شده</p>
              </div>
              <div className="rounded-xl bg-[var(--kv-surface-2)] p-3"><span className="text-xs text-[var(--kv-muted)]">Festival</span>
                <p className="mt-1 font-bold">{festivalStatus}{assignedFestival ? ` · ${assignedFestival.name}` : ""}</p>
                {assignedFestival?.endsAt && <p className="mt-1 text-[11px] text-[var(--kv-muted)]">پایان: {new Date(assignedFestival.endsAt).toLocaleDateString("fa-IR")}</p>}
              </div>
            </div>
            {data!.pricing.error && <p role="status" className="rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">{data!.pricing.error}</p>}
          </Card>

          <Card className="space-y-3 p-4">
            <div><h4 className="font-bold">تخفیف‌های مستقیم واریانت</h4><p className="mt-1 text-xs leading-5 text-[var(--kv-muted)]">مقادیر پیکربندی‌شده از قوانین canonical؛ وضعیت تعلیق از مرکز تخفیف خوانده می‌شود.</p></div>
            {variantDiscountRules.length ? <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{variantDiscountRules.map((rule) => <li key={rule.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--kv-line)] p-3">
              <span className="min-w-0 break-words"><b dir="ltr" className="font-mono text-xs">{rule.variant_sku ?? "واریانت"}</b><span className="ms-2 text-[10px] text-[var(--kv-muted)]">{rule.channel === "retail" ? "خرده" : rule.channel === "wholesale" ? "عمده" : "همه"}</span></span>
              <strong className="whitespace-nowrap">{discountLabel(rule)}</strong>
              <span className="w-full text-[10px] text-[var(--kv-muted)]">{rule.effectively_suspended ? `معلق با ${rule.suspended_by_name ?? "Festival"}` : rule.active ? "فعال" : "خاموش"}</span>
            </li>)}</ul> : <Empty title="تخفیف مستقیم واریانت ثبت نشده" desc="قواعد سطح محصول، رنگ و سایز در شمارندهٔ Discount آمده‌اند؛ مبلغ نهایی از Resolver محاسبه می‌شود." />}
          </Card>

          <Card className="space-y-3 p-4">
            <div><h4 className="font-bold">نتیجهٔ Pricing Resolver · خرده / نقدی</h4><p className="mt-1 text-xs leading-5 text-[var(--kv-muted)]">پیش‌نمایش سرور برای واریانت‌های فعال؛ این بخش هیچ قیمت محلی محاسبه یا ذخیره نمی‌کند.</p></div>
            {detail!.retail_enabled === false ? <Empty title="فروش خرده فعال نیست" desc="پیش‌نمایش Resolver خرده برای این محصول ارائه نمی‌شود." />
              : data!.pricing.preview.length ? <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{data!.pricing.preview.map((line) => <li key={line.variantId} className="min-w-0 space-y-2 rounded-lg border border-[var(--kv-line)] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2"><b dir="ltr" className="break-all font-mono text-xs">{line.sku}</b><span className="text-[10px] text-[var(--kv-muted)]">{line.color ?? "—"} / {line.size ?? "—"}</span></div>
                <div className="grid grid-cols-3 gap-1 text-[10px]"><div><span className="block text-[var(--kv-muted)]">پایه</span><b className="block break-words">{fmtToman(line.basePrice)}</b></div><div><span className="block text-[var(--kv-muted)]">تخفیف</span><b className="block break-words">{fmtToman(line.discountAmount)}</b></div><div><span className="block text-[var(--kv-muted)]">نهایی</span><b className="block break-words text-emerald-800">{fmtToman(line.finalPrice)}</b></div></div>
                <p className="text-[10px] text-[var(--kv-muted)]">منبع: {line.source === "festival" ? "Festival" : line.source === "promotion_rule" ? "قانون تخفیف" : "بدون تخفیف"}{line.matchedRule?.name ? ` · ${line.matchedRule.name}` : ""}</p>
              </li>)}</ul> : <Empty title={data!.pricing.error ? "پیش‌نمایش در دسترس نیست" : "واریانت فعالی برای محاسبه نیست"} desc={data!.pricing.error ?? "پس از تعریف واریانت، نتیجهٔ canonical اینجا نمایش داده می‌شود."} />}
          </Card>
          <p className="px-1 text-xs leading-6 text-[var(--kv-muted)]">فضای کامل تنظیم قیمت، اقساط، قوانین Discount و Festival از Product Studio و Product 360 مشترک است.</p>
        </div>}

        {tab === "wholesale" && <div className="space-y-4">
          {detail!.wholesale_enabled === false ? <Empty title="فروش عمده فعال نیست" desc="تنظیم کانال فروش در استودیوی محصول انجام می‌شود." /> : <>
            <Card className="grid gap-4 p-4 sm:grid-cols-2"><div><p className="text-xs text-[var(--kv-muted)]">قیمت پایه عمده برای هر قطعه</p><p className="mt-1 font-bold">{fmtToman(detail!.wholesale_price_rial)}</p></div><div><p className="text-xs text-[var(--kv-muted)]">حداقل سفارش محصول (سری)</p><p className="mt-1 font-bold">{fa(detail!.wholesale_moq)}</p></div>
              <p className="sm:col-span-2 text-xs leading-6 text-[var(--kv-muted)]">قیمت و ترکیب هر سری از قالب تجاری همان سری خوانده می‌شود؛ ظرفیت تأمین‌کننده موجودی فیزیکی کلبه نیست.</p>
            </Card>
            {data.series.length ? <div className="grid gap-4 sm:grid-cols-2">{data.series.map((series) => <section key={String(series.id)} className="rounded-xl border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="font-bold">{series.name}</h3><span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1 text-xs">{series.active ? "قابل عرضه" : "آرشیوشده"}</span></div>
              <p className="mt-2">ترکیب: {series.items.map((item) => `${item.size_label ?? "بدون سایز"}: ${fa(item.quantity_per_series)}`).join(" · ")}</p>
              <p className="mt-1">{fa(series.pairsPerSeries)} قطعه در هر سری · حداقل {fa(series.moqSeries)} سری</p>
              <p className="mt-2 font-bold">قیمت هر سری: {fmtToman(series.pricePerSeriesRial)}</p>
            </section>)}</div> : <Empty title="سری‌ای تعریف نشده" desc="سری استاندارد فرضی ایجاد نمی‌شود؛ ترکیب واقعی و قیمت را در استودیوی محصول تعریف کنید." />}
          </>}
        </div>}

        {tab === "inventory" && <ProductInventoryDrawer product={product} warehouses={noWarehouses} onClose={onClose} onFlash={() => undefined} view="inventory" showClose={false} />}
        {tab === "history" && <ProductInventoryDrawer product={product} warehouses={noWarehouses} onClose={onClose} onFlash={() => undefined} view="history" showClose={false} />}

        {tab === "seo" && <Card className="space-y-3 p-4 text-sm">
          <h3 className="font-bold">تنظیمات جست‌وجوی محصول</h3>
          <div><p className="text-xs text-[var(--kv-muted)]">عنوان SEO</p><p className="mt-1 break-words font-semibold">{String(seo.title ?? "عنوان پیش‌فرض از نام محصول")}</p></div>
          <div><p className="text-xs text-[var(--kv-muted)]">نامک صفحه</p><p dir="ltr" className="break-all text-left font-mono text-xs">{String(seo.slug ?? "—")}</p></div>
          <p className="rounded-lg bg-[var(--kv-surface-2)] px-3 py-2 text-xs leading-6 text-[var(--kv-muted)]">توضیح متا، Canonical، ایندکس و دادهٔ ساخت‌یافته در مرکز SEO مدیریت می‌شوند.</p>
        </Card>}
      </>}
    </div>
  </WorkspaceModal>;
}
