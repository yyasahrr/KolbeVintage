import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Colorway, SeriesDef } from "../data/catalog";
import { fmtMoney, fmtNum } from "../data/catalog";
import { seriesTemplatesApi } from "../data/api";
import { rialFromToman } from "../data/contracts";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Segmented } from "./primitives";

export function productSeriesPayload(series: SeriesDef[], colors: Colorway[]) {
  return series.map((s) => ({
    ...(/^[0-9a-f-]{36}$/i.test(s.id) ? { id: s.id } : {}), name: s.name, color: colors.find((c) => c.id === s.colorIds?.[0])?.name ?? "",
    active: s.available, pricingMode: s.pricingMode ?? "series_total", totalPriceRial: s.pricingMode === "component_sum" ? null : rialFromToman(s.pricePerSeries),
    minOrderSeries: s.moqSeries,
    items: Object.entries(s.composition).filter(([, quantity]) => quantity > 0).map(([size, quantityPerSeries]) => ({
      size, quantityPerSeries, ...(s.pricingMode === "component_sum" ? { unitPriceRial: rialFromToman(s.componentPrices?.[size]) } : {}),
    })),
  }));
}

/** Draft values belong to the product form; saving writes relational server recipes atomically. */
export function ProductSeriesEditor({ colors, sizes, value, onChange }: {
  colors: Colorway[]; sizes: string[]; value: SeriesDef[]; onChange: (value: SeriesDef[]) => void;
}) {
  const patch = (id: string, change: Partial<SeriesDef>) => onChange(value.map((s) => {
    if (s.id !== id) return s;
    const next = { ...s, ...change };
    next.pieces = Object.values(next.composition).reduce((sum, qty) => sum + qty, 0);
    if (next.pricingMode === "component_sum") next.pricePerSeries = Object.entries(next.composition)
      .reduce((sum, [size, qty]) => sum + qty * (next.componentPrices?.[size] ?? 0), 0);
    return next;
  }));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-[var(--kv-muted)]">هر سری ترکیب سایزهای یک رنگ است. ذخیرهٔ محصول، سری و قیمت آن را روی سرور ثبت می‌کند؛ موجودی از انبار وارد می‌شود.</p>
      <Btn size="sm" variant="accent" icon={<Plus size={14} />} disabled={!colors.length || !sizes.length} onClick={() => onChange([...value, {
        id: `draft-${crypto.randomUUID()}`, name: "", composition: Object.fromEntries(sizes.map((size) => [size, 1])),
        pieces: sizes.length, moqSeries: 1, pricePerSeries: 0, available: true, colorIds: [colors[0]!.id], pricingMode: "series_total", componentPrices: {},
      }])}>افزودن سری</Btn>
    </div>
    {!value.length && <Empty title="سری تعریف نشده" desc="رنگ و تعداد هر سایز را انتخاب و قیمت سری را تعیین کنید." />}
    {value.map((series) => <Card key={series.id} className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="نام سری"><Input value={series.name} onChange={(name) => patch(series.id, { name })} placeholder="مثلاً سری A" /></Field>
        <Field label="رنگ سری"><select aria-label="رنگ سری" className="h-11 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" value={series.colorIds?.[0] ?? ""} onChange={(e) => patch(series.id, { colorIds: [e.target.value] })}>
          <option value="">انتخاب رنگ…</option>{colors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></Field>
        <Field label="حداقل سفارش (سری)"><Input value={String(series.moqSeries)} onChange={(v) => patch(series.id, { moqSeries: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
      </div>
      <Segmented options={[{ v: "series_total", label: "قیمت کل سری" }, { v: "component_sum", label: "جمع قیمت اجزا" }]}
        value={series.pricingMode ?? "series_total"} onChange={(pricingMode) => patch(series.id, { pricingMode })} />
      <div className="overflow-x-auto"><table className="kv-table w-full min-w-[300px]"><thead><tr><th>سایز</th><th>تعداد در هر سری</th>{series.pricingMode === "component_sum" && <th>قیمت هر تکه (تومان)</th>}</tr></thead><tbody>
        {[...new Set([...sizes, ...Object.keys(series.composition)])].map((size) => <tr key={size}><td>{size}</td><td>
          <Input ariaLabel={`تعداد سایز ${size}`} value={String(series.composition[size] ?? 0)} onChange={(v) => patch(series.id, { composition: { ...series.composition, [size]: Number(v.replace(/\D/g, "")) || 0 } })} />
        </td>{series.pricingMode === "component_sum" && <td><Input ariaLabel={`قیمت سایز ${size}`} value={String(series.componentPrices?.[size] ?? "")} onChange={(v) => patch(series.id, { componentPrices: { ...series.componentPrices, [size]: Number(v.replace(/\D/g, "")) || 0 } })} /></td>}</tr>)}
      </tbody></table></div>
      {series.pricingMode !== "component_sum" && <Field label="قیمت کل سری (تومان)"><Input value={String(series.pricePerSeries || "")} onChange={(v) => patch(series.id, { pricePerSeries: Number(v.replace(/\D/g, "")) || 0 })} /></Field>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kv-line)] pt-3">
        <p className="text-sm">{fmtNum(series.pieces)} تکه · {fmtMoney(series.pricePerSeries)} · حداقل {fmtNum(series.moqSeries)} سری</p>
        <Btn size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => onChange(value.filter((s) => s.id !== series.id))}>حذف از فرم</Btn>
      </div>
    </Card>)}
  </div>;
}

export function CanonicalSeriesLibrary() {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState("");
  const load = () => { setError(""); seriesTemplatesApi.list().then((r) => setRows(r.items)).catch((e: unknown) => setError(e instanceof Error ? e.message : "دریافت سری‌ها انجام نشد.")); };
  useEffect(load, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <LoadingState label="دریافت سری‌های ثبت‌شده…" />;
  return <Card className="p-4"><p className="mb-4 text-sm text-[var(--kv-muted)]">سری‌ها از سرور خوانده می‌شوند. تعریف و ویرایش ترکیب و قیمت از مرحلهٔ «سری‌های عمده» استودیو همان محصول انجام می‌شود.</p>
    {!rows.length ? <Empty title="سری ثبت نشده" desc="در استودیو محصول، نوع فروش عمده را انتخاب و سری بسازید." /> : <div className="overflow-x-auto"><table className="kv-table w-full min-w-[420px]"><thead><tr><th>محصول</th><th>سری</th><th>تکه در سری</th><th>قیمت سری</th><th>وضعیت</th></tr></thead><tbody>{rows.map((r) => <tr key={String(r.id)}><td>{String(r.product_name)}</td><td>{String(r.name)}</td><td>{fmtNum(Number(r.pairs_per_series))}</td><td>{r.price_per_series_rial ? fmtMoney(Number(r.price_per_series_rial) / 10) : "تعیین نشده"}</td><td>{r.active ? "فعال" : "بایگانی"}</td></tr>)}</tbody></table></div>}
  </Card>;
}
