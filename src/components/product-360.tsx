import { useCallback, useEffect, useState } from "react";
import { authBlobUrl, catalogOpsApi, productsApi, seriesTemplatesApi, sizeGuidesApi, specsApi } from "../data/api";
import { fmtToman, normalizeSizeGuide, readProductSpecs } from "../data/contracts";
import type { ProductSpecs, SizeGuide } from "../data/contracts";
import { Btn, Card, Empty, ErrorState, LoadingState, Segmented, WorkspaceModal } from "./primitives";
import { ProductInventoryDrawer } from "./product-inventory";

type Detail = Awaited<ReturnType<typeof productsApi.adminDetail>>;
type Series = Awaited<ReturnType<typeof seriesTemplatesApi.detail>>;
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
};
const fa = (n: unknown) => String(n ?? "—").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const noWarehouses: [] = [];

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
      const [detailResult, listResult, guideResult, specsResult] = await Promise.allSettled([
        productsApi.adminDetail(product.id),
        seriesTemplatesApi.list(product.id),
        sizeGuidesApi.productGuide(product.id),
        specsApi.productSpecs(product.id),
      ]);
      if (detailResult.status === "rejected") throw detailResult.reason;
      const detail = detailResult.value;
      const list = listResult.status === "fulfilled" ? listResult.value : { items: [] as Record<string, unknown>[] };
      const guideLink = guideResult.status === "fulfilled" ? guideResult.value as { mode?: string; guide?: unknown } : null;
      const specs = specsResult.status === "fulfilled" ? readProductSpecs(specsResult.value) : null;
      const [schemaResult, series] = await Promise.all([
        catalogOpsApi.categorySchema(String(detail.category)).catch(() => null),
        Promise.all((list.items ?? []).map((template) => seriesTemplatesApi.detail(String(template.id)).catch(() => null))),
      ]);
      const schema = schemaResult as { specFields?: Record<string, unknown>[] } | null;
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
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "خواندن اطلاعات محصول انجام نشد.");
    }
  }, [product.id]);
  useEffect(() => { void load(); }, [load]);
  const detail = data?.detail;
  const variants = (detail?.variants ?? []) as { id: string; sku: string; color?: string; size?: string; active?: boolean }[];
  const metadata = (detail?.metadata ?? {}) as Record<string, unknown> & { seo?: { title?: string; slug?: string }; compareAtRial?: string | number | null };
  const seo = metadata.seo ?? {};
  const variantSkus = new Map(variants.map((variant) => [variant.id, variant.sku]));
  const legacySpecs = Object.entries((detail?.specifications ?? {}) as Record<string, unknown>);
  const structuredSpecs = data?.specs?.values ?? [];

  return <WorkspaceModal open onClose={onClose} title={`نمای جامع محصول — ${product.name}`} subtitle="تعریف کاتالوگ، قیمت و موجودی واقعی؛ مالکیت کالا مستقل از محل نگهداری آن است.">
    <div className="space-y-5" dir="rtl">
      <div className="max-w-full overflow-x-auto" aria-label="بخش‌های نمای جامع محصول">
        <Segmented value={tab} onChange={(value) => setTab(value as Product360Tab)} options={[
          { v: "overview", label: "نمای کلی" }, { v: "variants", label: "واریانت‌ها" },
          { v: "specs", label: "مشخصات فنی" }, { v: "size-guide", label: "راهنمای سایز" },
          { v: "media", label: "رسانه" }, { v: "pricing", label: "قیمت‌گذاری خرده" },
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
            ["راه‌اندازی موجودی", detail!.inventory_setup === "pending" ? "نیازمند راه‌اندازی" : "راه‌اندازی‌شده"],
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

        {tab === "pricing" && <Card className="space-y-3 p-4 text-sm">
          {detail!.retail_enabled !== false ? <>
            <h3 className="font-bold">قیمت خرده‌فروشی</h3>
            <p>قیمت نقدی: <strong>{fmtToman(detail!.cash_price_rial)}</strong></p>
            <p>قیمت اقساطی: <strong>{fmtToman(detail!.installment_price_rial)}</strong></p>
            {metadata.compareAtRial ? <p>قیمت مرجع: <strong>{fmtToman(metadata.compareAtRial)}</strong></p> : null}
            <Btn onClick={onPricing}>مدیریت تخفیف و جشنواره</Btn>
          </> : <Empty title="فروش خرده فعال نیست" desc="تنظیم کانال فروش در استودیوی محصول انجام می‌شود." />}
        </Card>}

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
