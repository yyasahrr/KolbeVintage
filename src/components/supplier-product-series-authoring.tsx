import { useEffect, useMemo, useState } from "react";
import { Save, ShieldCheck, X } from "lucide-react";
import { Btn, Card, Field, Input, Textarea } from "./primitives";
import { ProductSeriesEditor, productSeriesPayload } from "./product-series-editor";
import { COLORS, type Colorway, type SeriesDef } from "../data/catalog";
import { rialFromToman, tomanFromRial } from "../data/contracts";
import { catalogOpsApi, productsApi, type SupplierPortalProduct } from "../data/api";
import { cn } from "../utils/cn";

type Flash = (message: string) => void;
type Props = {
  supplierName: string;
  initialProduct?: SupplierPortalProduct;
  onCancel: () => void;
  onSaved: () => void;
  flash: Flash;
};
type CategoryField = { code: string; label: string; type: string; unit: string | null; required: boolean; options: { value: string; label: string }[] };

function colorsForProduct(product?: SupplierPortalProduct): Colorway[] {
  if (!product) return Object.values(COLORS);
  const labels = [...new Set([
    ...(product.colors ?? []),
    ...product.series.map((series) => series.colorLabel ?? ""),
  ].filter(Boolean))];
  return labels.map((name, index) => Object.values(COLORS).find((color) => color.name === name)
    ?? { id: `supplier-color-${index}`, name, hex: "#A58A70" });
}

function seriesForProduct(product: SupplierPortalProduct | undefined, colors: Colorway[]): SeriesDef[] {
  if (!product) return [];
  // Archived rows remain visible in the catalogue but are not put back into the write payload;
  // the canonical series writer retains/keeps them archived when omitted.
  return product.series.filter((series) => series.active).map((series) => {
    const composition = Object.fromEntries(series.items.map((item) => [item.size, item.quantityPerSeries]));
    const componentPrices = Object.fromEntries(series.items
      .filter((item) => item.unitPriceRial !== null)
      .map((item) => [item.size, tomanFromRial(item.unitPriceRial)]));
    const pieces = Object.values(composition).reduce((sum, quantity) => sum + quantity, 0);
    return {
      id: series.id,
      name: series.name,
      pieces,
      composition,
      moqSeries: series.minOrderSeries,
      pricePerSeries: tomanFromRial(series.pricePerSeriesRial),
      available: series.active,
      colorIds: [colors.find((color) => color.name === series.colorLabel)?.id ?? colors[0]?.id ?? ""],
      pricingMode: series.pricingMode === "component_sum" ? "component_sum" : "series_total",
      componentPrices,
    };
  });
}

function optionsOf(value: unknown): { value: string; label: string }[] {
  if (!Array.isArray(value)) return [];
  return value.map((option) => {
    if (typeof option === "string") return { value: option, label: option };
    const row = (option ?? {}) as Record<string, unknown>;
    return { value: String(row.value ?? ""), label: String(row.label ?? row.value ?? "") };
  }).filter((option) => option.value.length > 0);
}

function splitSizes(value: string) {
  return [...new Set(value.split(/[،,\s]+/u).map((size) => size.trim()).filter(Boolean))];
}

export function SupplierProductSeriesAuthoring({ supplierName, initialProduct, onCancel, onSaved, flash }: Props) {
  const editing = Boolean(initialProduct);
  const colors = useMemo(() => colorsForProduct(initialProduct), [initialProduct]);
  const [brand, setBrand] = useState(initialProduct?.brand ?? supplierName);
  const [name, setName] = useState(initialProduct?.name ?? "");
  const [category, setCategory] = useState(initialProduct?.category ?? "");
  const [description, setDescription] = useState("");
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>(initialProduct
    ? colors.map((color) => color.id) : ["orange", "black", "cream"]);
  const [sizesText, setSizesText] = useState(initialProduct?.sizes?.join(", ") ?? "S, M, L, XL");
  const [allowedSizeSelection, setAllowedSizeSelection] = useState<string[]>(initialProduct?.sizes ?? []);
  const [categoryFields, setCategoryFields] = useState<CategoryField[]>([]);
  const [allowedSizes, setAllowedSizes] = useState<string[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [specifications, setSpecifications] = useState<Record<string, unknown>>({});
  const [series, setSeries] = useState<SeriesDef[]>(() => seriesForProduct(initialProduct, colors));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyNonce, setIdempotencyNonce] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (editing || !category.trim()) {
      setCategoryFields([]);
      setAllowedSizes([]);
      setSchemaError(null);
      setSchemaLoading(false);
      return;
    }
    let live = true;
    const categoryName = category.trim();
    setSchemaError(null);
    setSchemaLoading(true);
    setCategoryFields([]);
    const timer = window.setTimeout(() => {
      catalogOpsApi.categorySchema(categoryName).then((schema) => {
        if (!live) return;
        setCategoryFields(schema.specFields.map((field) => {
          const row = field as Record<string, unknown>;
          return {
            code: String(row.code ?? ""), label: String(row.label ?? row.code ?? ""),
            type: String(row.type ?? "text"), unit: row.unit == null ? null : String(row.unit),
            required: Boolean(row.required), options: optionsOf(row.options),
          };
        }).filter((field) => field.code));
        setAllowedSizes(schema.allowedSizes);
        if (schema.allowedSizes.length) {
          setAllowedSizeSelection((current) => {
            const retained = schema.allowedSizes.filter((size) => current.includes(size));
            return retained.length ? retained : schema.allowedSizes;
          });
        }
      }).catch((cause: unknown) => {
        if (live) setSchemaError(cause instanceof Error ? cause.message : "دریافت ساختار دسته‌بندی انجام نشد.");
      }).finally(() => { if (live) setSchemaLoading(false); });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [category, editing]);

  const sizes = editing
    ? [...new Set([...(initialProduct?.sizes ?? []), ...series.flatMap((row) => Object.keys(row.composition))])]
    : allowedSizes.length ? allowedSizeSelection.filter((size) => allowedSizes.includes(size)) : splitSizes(sizesText);
  const selectedColors = colors.filter((color) => selectedColorIds.includes(color.id));
  const activeSeries = series.filter((row) => row.available);

  const setChanged = (setter: (value: string) => void, value: string) => {
    setter(value);
    setIdempotencyNonce(crypto.randomUUID());
    setError(null);
  };

  const setSpec = (code: string, value: unknown) => {
    setSpecifications((current) => ({ ...current, [code]: value }));
    setIdempotencyNonce(crypto.randomUUID());
    setError(null);
  };

  const toggleColor = (colorId: string) => {
    const next = selectedColorIds.includes(colorId)
      ? selectedColorIds.filter((id) => id !== colorId) : [...selectedColorIds, colorId];
    setSelectedColorIds(next);
    setSeries((current) => current.map((row) => {
      if (row.colorIds?.every((id) => next.includes(id))) return row;
      return { ...row, colorIds: next.length ? [next[0]!] : [] };
    }));
    setIdempotencyNonce(crypto.randomUUID());
    setError(null);
  };

  const updateSeries = (next: SeriesDef[]) => {
    setSeries(next);
    setIdempotencyNonce(crypto.randomUUID());
    setError(null);
  };

  const missingSpecs = categoryFields.filter((field) => {
    if (!field.required) return false;
    const value = specifications[field.code];
    return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
  });
  const maxQuantity = selectedColors.length * sizes.length;
  const malformedSeries = series.filter((row) => row.available && (
    row.name.trim().length < 2 || row.moqSeries < 1 || row.pieces < 1 || row.pricePerSeries < 1
    || !row.colorIds?.[0] || !selectedColors.some((color) => color.id === row.colorIds?.[0])
    || !Object.values(row.composition).some((quantity) => quantity > 0)
  ));
  const cannotSave = busy || schemaLoading || (!editing && (!category.trim() || Boolean(schemaError)))
    || !brand.trim() || name.trim().length < 2 || !sizes.length || !selectedColors.length
    || !activeSeries.length || activeSeries.some((row) => malformedSeries.includes(row))
    || missingSpecs.length > 0 || sizes.length > 60 || maxQuantity > 100 || series.length > 50;

  const submit = async () => {
    setError(null);
    if (schemaError && !editing) { setError(schemaError); return; }
    if (cannotSave) {
      setError(missingSpecs.length
        ? `مشخصه‌های الزامی را تکمیل کنید: ${missingSpecs.map((field) => field.label).join("، ")}`
        : "نام، دسته‌بندی، رنگ، سایز و دست‌کم یک سری فعال با قیمت و حداقل سفارش معتبر لازم است.");
      return;
    }
    const recipes = productSeriesPayload(series, selectedColors);
    const minimumUnitToman = Math.max(1, Math.floor(Math.min(...activeSeries.map((row) => row.pricePerSeries / row.pieces))));
    const wholesaleSeries = recipes;
    setBusy(true);
    try {
      if (initialProduct) {
        await productsApi.update(initialProduct.id, {
          wholesalePriceRial: rialFromToman(minimumUnitToman), wholesaleSeries,
        }, `supplier-series-${idempotencyNonce}`);
        flash("سری‌ها و قیمت عمده در کاتالوگ خودتان ذخیره شد؛ ترکیب سری دارای موجودی فقط طبق محدودیت سرور قابل تغییر است.");
      } else {
        const variants = selectedColors.flatMap((color) => sizes.map((size) => ({
          color: color.name, size, weightGrams: null, attributes: {},
        })));
        const result = await productsApi.create({
          saveIntent: "draft", brand: brand.trim(), name: name.trim(), category: category.trim(),
          description: description.trim(), cashPriceRial: "0", wholesalePriceRial: rialFromToman(minimumUnitToman),
          wholesaleMoq: Math.min(...activeSeries.map((row) => row.moqSeries)),
          retailEnabled: false, wholesaleEnabled: true, installmentEnabled: false,
          installmentPolicy: "disabled", specifications, variants, wholesaleSeries,
        }, `supplier-product-${idempotencyNonce}`);
        flash(`محصول «${name.trim()}» با ${result.variants.length} واریانت برای بازبینی کلبه ثبت شد؛ وضعیت فعلی در انتظار بررسی است.`);
      }
      onSaved();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ذخیره محصول و سری‌ها انجام نشد.";
      setError(message);
      flash(message);
    } finally {
      setBusy(false);
    }
  };

  const productColors = editing ? colors : selectedColors;

  return (
    <Card className="space-y-5 border-[var(--kv-accent)]/30 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-extrabold">{editing ? `ویرایش سری‌های ${initialProduct?.name ?? "محصول"}` : "ثبت محصول و سری‌های عمده"}</h3>
          <p className="mt-1 max-w-[80ch] text-[11.5px] leading-6 text-[var(--kv-muted)]">
            {editing ? "سری‌ها و قیمت‌های محصول متعلق به حساب شما ویرایش می‌شوند؛ محدودیت ترکیب موجودی‌دار را سرور اعمال می‌کند." : "محصول و سری‌ها به کاتالوگ سرور ارسال و برای بازبینی کلبه ثبت می‌شوند. این فرم هیچ موجودی فیزیکی ایجاد نمی‌کند."}
          </p>
        </div>
        <Btn size="sm" variant="ghost" disabled={busy} icon={<X size={14} />} onClick={onCancel}>بستن</Btn>
      </div>

      {!editing && <div className="space-y-4 border-t border-[var(--kv-line)] pt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام برند" required><Input value={brand} onChange={(value) => setChanged(setBrand, value)} maxLength={120} /></Field>
          <Field label="نام محصول" required><Input value={name} onChange={(value) => setChanged(setName, value)} maxLength={240} /></Field>
          <Field label="دسته‌بندی" required hint="ساختار مشخصات و سایز از پروفایل دسته‌بندی کلبه خوانده می‌شود.">
            <Input value={category} onChange={(value) => setChanged(setCategory, value)} maxLength={120} placeholder="مثلاً پیراهن" />
          </Field>
          <div className="flex items-end text-[11px] text-[var(--kv-muted)]">
            {schemaLoading ? "در حال دریافت مشخصات دسته‌بندی…" : schemaError ? <span className="text-[var(--kv-danger)]">{schemaError}</span>
              : category.trim() ? allowedSizes.length ? `سایزهای مجاز: ${allowedSizes.join("، ")}` : "برای این دسته محدودیت سایز تعریف نشده است." : "دسته‌بندی را وارد کنید تا ساختار رسمی خوانده شود."}
          </div>
        </div>
        <Field label="توضیح کوتاه"><Textarea rows={3} value={description} onChange={(value) => setChanged(setDescription, value)} /></Field>
        {categoryFields.length > 0 && <div className="space-y-3 rounded-[12px] border border-[var(--kv-line)] p-3 sm:p-4">
          <p className="text-[12px] font-bold">مشخصات فنی دسته‌بندی</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {categoryFields.map((field) => {
              const value = specifications[field.code];
              const label = `${field.label}${field.unit ? ` (${field.unit})` : ""}`;
              if (["boolean"].includes(field.type)) return <label key={field.code} className="flex min-h-10 items-center gap-2 text-[12px] font-semibold">
                <input type="checkbox" checked={value === true} onChange={(event) => setSpec(field.code, event.target.checked)} className="h-4 w-4 accent-[#C1613B]" />
                {label}{field.required ? " *" : ""}
              </label>;
              if (["multi_select", "multiselect"].includes(field.type)) {
                const selected = Array.isArray(value) ? value.map(String) : [];
                return <fieldset key={field.code} className="rounded-[10px] border border-[var(--kv-line)] p-3">
                  <legend className="px-1 text-[12px] font-semibold">{label}{field.required ? " *" : ""}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">{field.options.map((option) => <label key={option.value} className="flex items-center gap-1.5 text-[11px]">
                    <input type="checkbox" checked={selected.includes(option.value)} onChange={(event) => setSpec(field.code,
                      event.target.checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} className="h-4 w-4 accent-[#C1613B]" />{option.label}
                  </label>)}</div>
                </fieldset>;
              }
              if (["single_select", "select"].includes(field.type) && field.options.length) return <Field key={field.code} label={label} required={field.required}>
                <select value={String(value ?? "")} onChange={(event) => setSpec(field.code, event.target.value)}
                  className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm">
                  <option value="">انتخاب کنید…</option>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>;
              if (["textarea"].includes(field.type)) return <Field key={field.code} label={label} required={field.required}><Textarea rows={3} value={String(value ?? "")} onChange={(next) => setSpec(field.code, next)} /></Field>;
              return <Field key={field.code} label={label} required={field.required}>
                <Input type={["number", "decimal"].includes(field.type) ? "number" : "text"}
                  inputMode={["number", "decimal"].includes(field.type) ? "decimal" : "text"}
                  value={String(value ?? "")} onChange={(next) => setSpec(field.code, next)} />
              </Field>;
            })}
          </div>
        </div>}
      </div>}

      {!editing && <div className="space-y-4 border-t border-[var(--kv-line)] pt-4">
        <h4 className="text-[13px] font-extrabold">رنگ‌ها و سایزهای واریانت</h4>
        <div className="flex flex-wrap gap-2">
          {colors.map((color) => <button key={color.id} type="button" aria-pressed={selectedColorIds.includes(color.id)} onClick={() => toggleColor(color.id)}
            className={cn("flex min-h-10 items-center gap-2 rounded-[10px] border px-3 text-[11.5px] font-semibold",
              selectedColorIds.includes(color.id) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.07]" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>
            <span className="h-4 w-4 rounded-full border border-black/15" style={{ backgroundColor: color.hex }} />{color.name}
          </button>)}
        </div>
        {allowedSizes.length > 0 ? <fieldset>
          <legend className="mb-2 text-[11.5px] font-semibold">سایزهای فعال در محصول</legend>
          <div className="flex flex-wrap gap-2">{allowedSizes.map((size) => <button key={size} type="button" aria-pressed={sizes.includes(size)}
            onClick={() => {
              const next = sizes.includes(size) ? sizes.filter((item) => item !== size) : [...sizes, size];
              setAllowedSizeSelection(next); setIdempotencyNonce(crypto.randomUUID()); setError(null);
            }} className={cn("min-h-9 rounded-[9px] border px-3 text-[11.5px] font-semibold",
              sizes.includes(size) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.07]" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>
            {size}
          </button>)}</div>
        </fieldset> : <Field label="سایزها" hint="سایزها را با کاما یا فاصله جدا کنید؛ حداکثر ۶۰ مقدار.">
          <Input value={sizesText} onChange={(value) => setChanged(setSizesText, value)} placeholder="S, M, L, XL" />
        </Field>}
        {!!sizes.length && <p className="text-[10.5px] text-[var(--kv-muted)]">{sizes.length} سایز · {selectedColors.length * sizes.length} واریانت سرور ساخته خواهد شد (حداکثر ۱۰۰).</p>}
      </div>}

      {editing && <div className="rounded-[11px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11px] leading-5 text-[var(--kv-muted)]">
        رنگ و سایز فقط از واریانت‌های همین محصول انتخاب می‌شود؛ برای افزودن رنگ/سایز تازه از گردش‌کار تأییدشده کاتالوگ استفاده کنید.
      </div>}
      <div className="border-t border-[var(--kv-line)] pt-4">
        <ProductSeriesEditor colors={productColors} sizes={sizes} value={series} onChange={updateSeries} />
      </div>

      {error && <p role="alert" className="rounded-[10px] border border-[var(--kv-danger)]/25 bg-[var(--kv-danger)]/[0.06] px-3 py-2 text-[11.5px] leading-5 text-[var(--kv-danger)]">{error}</p>}
      {series.length > 0 && <p className="flex items-start gap-2 rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[10.5px] leading-5 text-[var(--kv-muted)]">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />تعریف یا ویرایش محصول و سری، موجودی فیزیکی، ظرفیت تأمین یا رسید WMS ایجاد نمی‌کند. محصول جدید پس از ثبت در صف بازبینی کلبه قرار می‌گیرد.
      </p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--kv-line)] pt-4">
        <Btn size="sm" variant="ghost" disabled={busy} onClick={onCancel}>انصراف</Btn>
        <Btn size="sm" variant="accent" disabled={cannotSave} icon={busy ? undefined : <Save size={14} />} onClick={() => void submit()}>
          {busy ? "در حال ذخیره…" : editing ? "ذخیره سری‌ها" : "ثبت محصول برای بازبینی"}
        </Btn>
      </div>
    </Card>
  );
}
