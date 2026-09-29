import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Btn, Card, Empty, Field, Input, LoadingState, Segmented, Select, Switch, Textarea } from "./primitives";
import { inventoryApi, specsApi, sizeGuidesApi } from "../data/api";
import {
  SPEC_TYPES, SPEC_TYPE_LABEL, normalizeSizeGuide, normalizeSizeGuides, normalizeSpecAttributes, readProductInventory,
  readProductSpecs, type ProductSpecs, type SizeGuide, type SpecAttribute, type SpecAttributeType,
} from "../data/contracts";
import { cn } from "../utils/cn";

type F = (message: string) => void;
type VariantOption = { variantId: string; sku: string; color: string | null; size: string | null };

const faNum = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

function ValueInput({ attribute, value, onChange }: { attribute: SpecAttribute; value: unknown; onChange: (value: unknown) => void }) {
  const type: SpecAttributeType = attribute.type;
  if (type === "boolean") {
    return <Switch on={value === true} onToggle={() => onChange(value !== true)} />;
  }
  if (type === "single_select") {
    return (
      <Select
        options={["—", ...attribute.options.map((o) => o.label)]}
        value={attribute.options.find((o) => o.value === value)?.label ?? "—"}
        onChange={(label) => onChange(label === "—" ? null : attribute.options.find((o) => o.label === label)?.value ?? null)}
      />
    );
  }
  if (type === "multi_select") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-wrap gap-1.5">
        {attribute.options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button key={option.id} onClick={() => onChange(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])}
              className={cn("rounded-full border px-3 py-1.5 text-[12px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.08]" : "border-[var(--kv-line)]")}>
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }
  if (type === "textarea") return <Textarea rows={3} value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v)} />;
  if (type === "color") {
    return (
      <span className="flex items-center gap-2">
        <input type="color" value={typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#8A6A4F"} onChange={(e) => onChange(e.target.value)} className="h-11 w-14 cursor-pointer rounded-[10px] border border-[var(--kv-line)] bg-transparent" aria-label={attribute.label} />
        <span className="text-[12px] tabular-nums" dir="ltr">{typeof value === "string" ? value : "—"}</span>
      </span>
    );
  }
  if (type === "number" || type === "decimal" || type === "measurement") {
    return <Input value={value === null || value === undefined ? "" : String(value)} onChange={(v) => onChange(v === "" ? null : Number(v))} placeholder={attribute.unit ?? ""} />;
  }
  if (type === "file" || type === "image" || type === "video") {
    return <Input value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v)} placeholder="شناسه فایل (POST /files)" />;
  }
  return <Input value={typeof value === "string" || typeof value === "number" ? String(value) : ""} onChange={(v) => onChange(v)} placeholder={attribute.unit ?? ""} />;
}

/**
 * Server-driven spec editor + size-guide attach for an existing product.
 * The form renders the product-type template (product- and variant-scoped
 * fields); nothing is hardcoded. Extra per-product fields can stay local to
 * the product or be promoted into the template (item 127).
 */
export function ProductSpecsEditor({ productId, flash }: { productId: string; flash: F }) {
  const [specs, setSpecs] = useState<ProductSpecs | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [variantValues, setVariantValues] = useState<Record<string, Record<string, unknown>>>({});
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [selVariant, setSelVariant] = useState("");
  const [allAttributes, setAllAttributes] = useState<SpecAttribute[]>([]);
  const [extra, setExtra] = useState<{ attributeId: string; value: unknown; mode: "product" | "template" } | null>(null);
  const [newAttr, setNewAttr] = useState({ label: "", code: "", type: "text" as SpecAttributeType });
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [guides, setGuides] = useState<SizeGuide[]>([]);
  const [attached, setAttached] = useState<{ mode: string; guide: SizeGuide | null } | null>(null);
  const [attachDraft, setAttachDraft] = useState({ guideId: "", mode: "link" as "link" | "detached" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      specsApi.productSpecs(productId).then(readProductSpecs).catch(() => null),
      sizeGuidesApi.adminList().then(normalizeSizeGuides).catch(() => [] as SizeGuide[]),
      sizeGuidesApi.productGuide(productId).catch(() => null),
      inventoryApi.productInventory(productId).then(readProductInventory).catch(() => null),
      specsApi.attributes().then((raw) => normalizeSpecAttributes((raw as { items?: unknown[] }).items ?? raw)).catch(() => [] as SpecAttribute[]),
    ]).then(([specData, guideList, productGuide, inventory, attributes]) => {
      if (!live) return;
      setSpecs(specData);
      setGuides(guideList);
      const initial: Record<string, unknown> = {};
      const perVariant: Record<string, Record<string, unknown>> = {};
      for (const entry of specData?.values ?? []) {
        if (entry.variantId) {
          perVariant[entry.variantId] = { ...(perVariant[entry.variantId] ?? {}), [entry.attributeId]: entry.value };
        } else {
          initial[entry.attributeId] = entry.value;
        }
      }
      setValues(initial);
      setVariantValues(perVariant);
      const variantList = (inventory?.variants ?? []).map((v) => ({ variantId: v.variantId, sku: v.sku, color: v.color, size: v.size }));
      setVariants(variantList);
      setSelVariant(variantList[0]?.variantId ?? "");
      setAllAttributes(attributes.filter((a) => a.active));
      const link = (productGuide ?? {}) as { mode?: string; guide?: unknown };
      setAttached({ mode: link.mode ?? "link", guide: link.guide ? normalizeSizeGuide(link.guide) : null });
      setLoading(false);
    });
    return () => { live = false; };
  }, [productId]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = [
        ...Object.entries(values).filter(([, value]) => !isEmpty(value)).map(([attributeId, value]) => ({ attributeId, value })),
        ...Object.entries(variantValues).flatMap(([variantId, entries]) =>
          Object.entries(entries).filter(([, value]) => !isEmpty(value)).map(([attributeId, value]) => ({ attributeId, variantId, value }))),
      ];
      const result = await specsApi.saveProductSpecs(productId, { values: payload }) as { saved?: number; warnings?: string[] };
      setWarnings(result.warnings ?? []);
      flash(`مشخصات ذخیره شد (${faNum(result.saved ?? 0)} فیلد)`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره مشخصات"); }
    finally { setSaving(false); }
  };

  /** Item 127: an off-template field for this product only — or promoted into the template. */
  const saveExtra = async () => {
    if (!extra?.attributeId || isEmpty(extra.value)) return;
    const attribute = allAttributes.find((a) => a.id === extra.attributeId);
    if (!attribute) return;
    setSaving(true);
    try {
      const result = await specsApi.saveProductSpecs(productId, {
        values: [{ attributeCode: attribute.code, value: extra.value }],
        addToTemplate: extra.mode === "template",
      }) as { saved?: number; warnings?: string[] };
      setValues((current) => ({ ...current, [attribute.id]: extra.value }));
      setExtra(null);
      setWarnings(result.warnings ?? []);
      flash(extra.mode === "template" ? "مشخصه به قالب اضافه و مقدار ذخیره شد" : "مشخصه اختصاصی فقط برای این محصول ذخیره شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره مشخصه اختصاصی"); }
    finally { setSaving(false); }
  };

  const createExtraAttribute = async () => {
    if (newAttr.label.trim().length < 2 || !newAttr.code.trim()) { flash("نام و کد انگلیسی مشخصه لازم است."); return; }
    setSaving(true);
    try {
      const created = await specsApi.createAttribute({ label: newAttr.label.trim(), code: newAttr.code.trim().toLowerCase(), type: newAttr.type, scope: "product", active: true }) as { id?: string };
      const refreshed = await specsApi.attributes().then((raw) => normalizeSpecAttributes((raw as { items?: unknown[] }).items ?? raw)).catch(() => allAttributes);
      setAllAttributes(refreshed.filter((a) => a.active));
      const createdId = created?.id ?? refreshed.find((a) => a.code === newAttr.code.trim().toLowerCase())?.id ?? "";
      setNewAttr({ label: "", code: "", type: "text" });
      if (createdId) setExtra({ attributeId: createdId, value: null, mode: "product" });
      flash("مشخصه ساخته شد؛ مقدار را وارد و ذخیره کنید");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت مشخصه"); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingState label="در حال بارگذاری مشخصات…" />;
  if (!specs) return <Empty title="خطا در بارگذاری" desc="مشخصات این محصول خوانده نشد." />;

  const templateAttributes = specs.template?.attributes ?? [];
  const productAttrs = templateAttributes.filter((a) => a.scope !== "variant");
  const variantAttrs = templateAttributes.filter((a) => a.scope === "variant");
  const groups = specs.template?.groups ?? [];
  const extraCandidates = allAttributes.filter((a) => a.scope === "product" && !templateAttributes.some((t) => t.id === a.id));
  const extraAttribute = extra ? allAttributes.find((a) => a.id === extra.attributeId) ?? null : null;
  const selVariantLabel = variants.find((v) => v.variantId === selVariant);

  const renderField = (attribute: SpecAttribute, value: unknown, onChange: (value: unknown) => void) => (
    <Field key={attribute.id} label={`${attribute.label}${attribute.required ? " *" : ""}${attribute.unit ? ` (${attribute.unit})` : ""}`}>
      <ValueInput attribute={attribute} value={value} onChange={onChange} />
    </Field>
  );

  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1 text-[13px] font-extrabold">مشخصات فنی</p>
        {!specs.template ? (
          <p className="text-[12.5px] text-[var(--kv-muted)]">این محصول نوع/قالب مشخصات ندارد؛ مقادیر آزاد زیر همان‌طور ذخیره می‌شوند.</p>
        ) : (
          <p className="text-[12.5px] text-[var(--kv-muted)]">قالب «{specs.template.name}» · {faNum(productAttrs.length)} فیلد محصول · {faNum(variantAttrs.length)} فیلد واریانت</p>
        )}
        {warnings.length > 0 && (
          <div className="mt-2 space-y-1">{warnings.map((warning, i) => <p key={i} className="rounded-[8px] bg-[#B7791F]/10 px-3 py-1.5 text-[12px]">{warning}</p>)}</div>
        )}
        <div className="mt-3 space-y-4">
          {groups.map((group) => {
            const fields = productAttrs.filter((a) => a.groupId === group.id);
            if (!fields.length) return null;
            return (
              <div key={group.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-2 text-[12.5px] font-extrabold">{group.name}</p>
                <div className="space-y-3">
                  {fields.map((attribute) => renderField(attribute, values[attribute.id], (value) => setValues({ ...values, [attribute.id]: value })))}
                </div>
              </div>
            );
          })}
          <div className="space-y-3">
            {productAttrs.filter((a) => !a.groupId).map((attribute) => renderField(attribute, values[attribute.id], (value) => setValues({ ...values, [attribute.id]: value })))}
          </div>
          {productAttrs.length === 0 && specs.values.filter((v) => !v.variantId).map((entry) => (
            <Field key={entry.id} label={`${entry.label}${entry.unit ? ` (${entry.unit})` : ""}`}>
              <ValueInput attribute={{ id: entry.attributeId, code: entry.code, label: entry.label, description: "", type: entry.type, unit: entry.unit, required: false, searchable: false, filterable: false, scope: "product", position: 0, validation: {}, active: true, options: [] }} value={values[entry.attributeId]} onChange={(value) => setValues({ ...values, [entry.attributeId]: value })} />
            </Field>
          ))}
          {productAttrs.length === 0 && specs.values.filter((v) => !v.variantId).length === 0 && (
            <p className="text-[12.5px] text-[var(--kv-muted)]">فیلد سطح محصولی برای این محصول تعریف نشده است.</p>
          )}
        </div>
        <Btn variant="accent" size="sm" className="mt-3" disabled={saving} onClick={() => void save()}>ذخیره مشخصات</Btn>
      </div>

      {variantAttrs.length > 0 && (
        <Card className="p-4">
          <p className="text-[13px] font-extrabold">مشخصات سطح واریانت</p>
          <p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">این فیلدها برای هر واریانت جداگانه ذخیره می‌شوند (مثلاً وزن، SKU).</p>
          {variants.length === 0 ? <p className="mt-2 text-[12.5px] text-[var(--kv-muted)]">این محصول واریانتی ندارد.</p> : (
            <div className="mt-3 space-y-3">
              <Field label="واریانت">
                <Select
                  options={variants.map((v) => `${v.sku}${v.color ? ` / ${v.color}` : ""}${v.size ? ` / ${v.size}` : ""}`)}
                  value={selVariantLabel ? `${selVariantLabel.sku}${selVariantLabel.color ? ` / ${selVariantLabel.color}` : ""}${selVariantLabel.size ? ` / ${selVariantLabel.size}` : ""}` : ""}
                  onChange={(label) => setSelVariant(variants.find((v) => `${v.sku}${v.color ? ` / ${v.color}` : ""}${v.size ? ` / ${v.size}` : ""}` === label)?.variantId ?? "")}
                />
              </Field>
              {variantAttrs.map((attribute) => renderField(attribute, variantValues[selVariant]?.[attribute.id], (value) =>
                setVariantValues({ ...variantValues, [selVariant]: { ...(variantValues[selVariant] ?? {}), [attribute.id]: value } })))}
              <Btn variant="soft" size="sm" disabled={saving || !selVariant} onClick={() => void save()}>ذخیره مشخصات واریانت</Btn>
            </div>
          )}
        </Card>
      )}

      <Card className="p-4">
        <p className="text-[13px] font-extrabold">+ افزودن مشخصه اختصاصی</p>
        <p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">ویژگی خارج از قالب: فقط همین محصول، یا افزودن به قالب برای محصولات بعدی (نیازمند دسترسی ساختار).</p>
        {!extra ? (
          <Btn variant="ghost" size="sm" className="mt-2" icon={<Plus size={14} />} onClick={() => setExtra({ attributeId: extraCandidates[0]?.id ?? "", value: null, mode: "product" })}>مشخصه اختصاصی</Btn>
        ) : (
          <div className="mt-3 space-y-3">
            <Field label="مشخصه">
              <Select
                options={["ساخت مشخصه جدید…", ...extraCandidates.map((a) => a.label)]}
                value={extraAttribute?.label ?? "ساخت مشخصه جدید…"}
                onChange={(label) => setExtra({ ...extra, attributeId: extraCandidates.find((a) => a.label === label)?.id ?? "" })}
              />
            </Field>
            {!extra.attributeId && (
              <div className="grid gap-2 rounded-[10px] border border-dashed border-[var(--kv-line-strong)] p-3 sm:grid-cols-3">
                <Field label="نام"><Input value={newAttr.label} onChange={(v) => setNewAttr({ ...newAttr, label: v })} placeholder="جنس زیپ" /></Field>
                <Field label="کد انگلیسی"><Input value={newAttr.code} onChange={(v) => setNewAttr({ ...newAttr, code: v })} placeholder="zipper" /></Field>
                <Field label="نوع"><Select options={SPEC_TYPES.map((t) => SPEC_TYPE_LABEL[t])} value={SPEC_TYPE_LABEL[newAttr.type]} onChange={(label) => setNewAttr({ ...newAttr, type: SPEC_TYPES.find((t) => SPEC_TYPE_LABEL[t] === label) ?? "text" })} /></Field>
                <Btn variant="soft" size="sm" className="sm:col-span-3" disabled={saving} onClick={() => void createExtraAttribute()}>ساخت مشخصه</Btn>
              </div>
            )}
            {extraAttribute && (
              <Field label={`مقدار — ${extraAttribute.label}${extraAttribute.unit ? ` (${extraAttribute.unit})` : ""}`}>
                <ValueInput attribute={extraAttribute} value={extra.value} onChange={(value) => setExtra({ ...extra, value })} />
              </Field>
            )}
            <Field label="دامنه">
              <Segmented<"product" | "template"> options={[{ v: "product", label: "فقط این محصول" }, { v: "template", label: "افزودن به قالب" }]} value={extra.mode} onChange={(v) => setExtra({ ...extra, mode: v })} />
            </Field>
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" onClick={() => setExtra(null)}>انصراف</Btn>
              <Btn variant="accent" size="sm" className="flex-1" disabled={saving || !extra.attributeId || isEmpty(extra.value)} onClick={() => void saveExtra()}>ذخیره مشخصه اختصاصی</Btn>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4">
        <p className="text-[13px] font-extrabold">راهنمای سایز</p>
        {attached?.guide ? (
          <div className="mt-2">
            <p className="text-[12.5px]"><b>{attached.guide.name}</b> <span className="text-[var(--kv-muted)]">(نسخه {faNum(attached.guide.version)} · {attached.mode === "detached" ? "کپی ثابت" : "اتصال زنده"})</span></p>
            {attached.guide.columns.length > 0 && attached.guide.rows.length > 0 && (
              <div className="kv-scroll mt-2 overflow-x-auto">
                <table className="kv-table min-w-[420px]">
                  <thead><tr>{attached.guide.columns.map((c) => <th key={c.id}>{c.label}</th>)}</tr></thead>
                  <tbody>{attached.guide.rows.map((row) => <tr key={row.id}>{attached.guide!.columns.map((c) => <td key={c.id}>{row.values[c.code] ?? "—"}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <Btn variant="ghost" size="sm" className="mt-2" onClick={() => void (async () => { try { await sizeGuidesApi.detachFromProduct(productId); setAttached({ mode: "link", guide: null }); flash("راهنمای سایز جدا شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>جدا کردن راهنما</Btn>
          </div>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_150px_auto] sm:items-end">
            <Field label="راهنما"><Select options={["انتخاب…", ...guides.map((g) => `${g.name} (نسخه ${g.version})`)]} value={guides.find((g) => g.id === attachDraft.guideId) ? `${guides.find((g) => g.id === attachDraft.guideId)!.name} (نسخه ${guides.find((g) => g.id === attachDraft.guideId)!.version})` : "انتخاب…"} onChange={(label) => setAttachDraft({ ...attachDraft, guideId: guides.find((g) => `${g.name} (نسخه ${g.version})` === label)?.id ?? "" })} /></Field>
            <Field label="حالت" hint="کپی ثابت با نسخه‌های بعدی تغییر نمی‌کند"><Select options={["اتصال زنده", "کپی ثابت"]} value={attachDraft.mode === "detached" ? "کپی ثابت" : "اتصال زنده"} onChange={(v) => setAttachDraft({ ...attachDraft, mode: v === "کپی ثابت" ? "detached" : "link" })} /></Field>
            <Btn variant="soft" size="sm" disabled={!attachDraft.guideId} icon={<Plus size={14} />} onClick={() => void (async () => { try { await sizeGuidesApi.attachToProduct(productId, { guideId: attachDraft.guideId, mode: attachDraft.mode }); const link = await sizeGuidesApi.productGuide(productId) as { mode?: string; guide?: unknown }; setAttached({ mode: link.mode ?? "link", guide: link.guide ? normalizeSizeGuide(link.guide) : null }); flash("راهنمای سایز متصل شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>اتصال</Btn>
          </div>
        )}
      </Card>
    </div>
  );
}
