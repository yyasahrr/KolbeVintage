import { useCallback, useEffect, useState } from "react";
import { productsApi, seriesTemplatesApi, catalogOpsApi } from "../data/api";
import { authBlobUrl } from "../data/api";
import { fmtToman } from "../data/contracts";
import { Btn, Empty, ErrorState, LoadingState, Segmented, WorkspaceModal } from "./primitives";
import { ProductInventoryDrawer } from "./product-inventory";

type Detail = Awaited<ReturnType<typeof productsApi.adminDetail>>;
type Series = Awaited<ReturnType<typeof seriesTemplatesApi.detail>>;
const fa = (n: unknown) => String(n ?? "—").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const noWarehouses: [] = [];

/** Product facts are read from their owners; this workspace never writes stock. */
export function Product360({ product, onClose, onPricing }: {
  product: { id: string; name: string }; onClose: () => void; onPricing: () => void;
}) {
  const [tab, setTab] = useState("identity");
  const [data, setData] = useState<{ detail: Detail; series: Series[]; specLabels: Record<string, string>; images: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setData(null);
    try {
      const [detail, list] = await Promise.all([productsApi.adminDetail(product.id), seriesTemplatesApi.list(product.id)]);
      const schema = await catalogOpsApi.categorySchema(String(detail.category));
      const series = await Promise.all(list.items.map((t) => seriesTemplatesApi.detail(String(t.id))));
      const metadata = (detail.metadata ?? {}) as { images?: { fileId?: string; url?: string }[] };
      const images = await Promise.all((metadata.images ?? []).map((i) => i.fileId ? authBlobUrl(`/files/${i.fileId}`) : Promise.resolve(i.url ?? "")));
      setData({ detail, series, images: images.filter(Boolean), specLabels: Object.fromEntries(schema.specFields.map((f) => [String(f.code), String(f.label)])) });
    } catch (e) { setError(e instanceof Error ? e.message : "خواندن اطلاعات محصول انجام نشد."); }
  }, [product.id]);
  useEffect(() => { void load(); }, [load]);
  const detail = data?.detail;
  const variants = (detail?.variants ?? []) as { id: string; sku: string; color?: string; size?: string }[];
  return <WorkspaceModal open onClose={onClose} title={`نمای جامع محصول — ${product.name}`} subtitle="تعریف کاتالوگ، قیمت و موجودی واقعی؛ مالکیت کالا مستقل از محل نگهداری آن است.">
    <div className="space-y-5" dir="rtl">
      <div className="overflow-x-auto"><Segmented value={tab} onChange={setTab} options={[
        { v: "identity", label: "مشخصات" }, { v: "variants", label: "رنگ و سایز" }, { v: "media", label: "رسانه" },
        { v: "pricing", label: "قیمت‌گذاری" }, { v: "series", label: "سری‌های عمده" }, { v: "inventory", label: "موجودی و تاریخچه" },
      ]} /></div>
      {error ? <ErrorState message={error} onRetry={load} /> : !data ? <LoadingState label="در حال خواندن اطلاعات محصول…" /> : <>
        {tab === "identity" && <div className="space-y-4 text-sm">
          <dl className="grid gap-4 sm:grid-cols-3">{[
            ["نام", detail!.name], ["برند", detail!.brand], ["دسته", detail!.category],
            ["مالک", detail!.owner_type === "supplier" ? "تأمین‌کننده" : "کلبه"],
            ["روش فروش", detail!.retail_enabled && detail!.wholesale_enabled ? "خرده و عمده" : detail!.retail_enabled ? "خرده" : "عمده"],
            ["راه‌اندازی موجودی", detail!.inventory_setup === "pending" ? "نیازمند راه‌اندازی" : "راه‌اندازی‌شده"],
          ].map(([label, value]) => <div key={String(label)}><dt className="text-xs text-[var(--kv-muted)]">{String(label)}</dt><dd className="mt-1 font-bold">{String(value ?? "—")}</dd></div>)}</dl>
          <p className="leading-7">{String(detail!.description ?? "توضیحی ثبت نشده است.")}</p>
          <h3 className="font-bold">مشخصات فنی</h3>
          {Object.entries((detail!.specifications ?? {}) as Record<string, unknown>).map(([key, value]) => <p key={key}>{data.specLabels[key] ?? "مشخصه"}: {Array.isArray(value) ? value.join("، ") : String(value)}</p>)}
          {!Object.keys((detail!.specifications ?? {}) as object).length && <Empty title="مشخصات فنی ثبت نشده" desc="مشخصات و راهنمای اندازه از بخش تعریف محصول مدیریت می‌شوند." />}
        </div>}
        {tab === "variants" && <div className="overflow-x-auto"><table className="kv-table w-full text-sm"><thead><tr><th>شناسه کالا</th><th>رنگ</th><th>سایز</th></tr></thead><tbody>{variants.map((v) => <tr key={v.id}><td>{v.sku}</td><td>{v.color ?? "—"}</td><td>{v.size ?? "—"}</td></tr>)}</tbody></table></div>}
        {tab === "media" && (data.images.length ? <div className="grid grid-cols-2 gap-4 md:grid-cols-4">{data.images.map((src, i) => <img key={src} src={src} alt={`${product.name} — تصویر ${fa(i + 1)}`} className="aspect-[3/4] w-full rounded-xl object-cover" />)}</div> : <Empty title="تصویری ثبت نشده" desc="رسانه را در استودیوی محصول بارگذاری کنید." />)}
        {tab === "pricing" && <div className="space-y-4 text-sm">{detail!.retail_enabled !== false && <><p>قیمت نقدی: <strong>{fmtToman(detail!.cash_price_rial)}</strong></p><p>قیمت اقساطی: <strong>{fmtToman(detail!.installment_price_rial)}</strong></p></>}<p>قیمت عمده به‌ازای سری در بخش «سری‌های عمده» نمایش داده می‌شود.</p><Btn onClick={onPricing}>تخفیف و جشنواره</Btn></div>}
        {tab === "series" && (data.series.length ? <div className="grid gap-4 sm:grid-cols-2">{data.series.map((s) => <section key={String(s.id)} className="rounded-xl border border-[var(--kv-line)] p-4 text-sm"><h3 className="font-bold">{s.name}</h3><p className="mt-2">{s.items.map((i) => `${i.size_label}: ${fa(i.quantity_per_series)}`).join(" · ")}</p><p className="mt-2">{fa(s.pairsPerSeries)} قطعه · حداقل {fa(s.moqSeries)} سری</p><p className="mt-2 font-bold">{fmtToman(s.pricePerSeriesRial)}</p><p className="mt-1 text-xs text-[var(--kv-muted)]">{s.active ? "قابل عرضه" : "آرشیوشده"}</p></section>)}</div> : <Empty title="سری‌ای تعریف نشده" desc="سری استاندارد فرضی ایجاد نمی‌شود؛ ترکیب واقعی را در استودیوی محصول تعریف کنید." />)}
        {tab === "inventory" && <ProductInventoryDrawer product={product} warehouses={noWarehouses} onClose={onClose} onFlash={() => undefined} />}
      </>}
    </div>
  </WorkspaceModal>;
}
