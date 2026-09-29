import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { productTypesApi, type ProductType, type SizeDef, type SpecField } from "../data/experience-api";
import { Btn, Card, ErrorState, Field, Input, LoadingState, Select, Switch } from "../components/primitives";
import { cn } from "../utils/cn";

/* Product Type → Specification Template → Generated Product Form (Req 325-326).
   New types/fields/sizes are pure data: no frontend change is needed to support them. */

const FIELD_TYPE_LABEL: Record<SpecField["fieldType"], string> = { text: "متن", number: "عدد", select: "انتخابی", multiselect: "چندانتخابی", boolean: "بله/خیر" };

/** Renders the form generated from a type's template; values are validated again on the server. */
export function AdaptiveSpecForm({ type, values, onChange }: { type: ProductType; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const groups = Array.from(new Set(type.spec_template.map((f) => f.group || "مشخصات")));
  if (!type.spec_template.length) return <p className="text-[12px] text-[var(--kv-muted)]">برای این نوع محصول هنوز قالب مشخصاتی تعریف نشده است.</p>;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <fieldset key={g} className="rounded-[12px] border border-[var(--kv-line)] p-3">
          <legend className="px-1 text-[12.5px] font-bold">{g}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {type.spec_template.filter((f) => (f.group || "مشخصات") === g).map((f) => {
              const label = `${f.label}${f.required ? " *" : ""}${f.unit ? ` (${f.unit})` : ""}`;
              const v = values[f.code];
              if (f.fieldType === "boolean") return <label key={f.code} className="flex items-center justify-between gap-2 rounded-[10px] bg-[var(--kv-surface-2)]/60 px-3 py-2 text-[12.5px] font-semibold">{label}<Switch on={v === true} onToggle={() => onChange({ ...values, [f.code]: v !== true })} /></label>;
              if (f.fieldType === "select") return <Field key={f.code} label={label}><Select options={["—", ...f.options]} value={typeof v === "string" && v ? v : "—"} onChange={(val) => onChange({ ...values, [f.code]: val === "—" ? "" : val })} /></Field>;
              if (f.fieldType === "multiselect") {
                const list = Array.isArray(v) ? (v as string[]) : [];
                return <Field key={f.code} label={label}><div className="flex flex-wrap gap-1.5">{f.options.map((o) => <button key={o} type="button" aria-pressed={list.includes(o)} onClick={() => onChange({ ...values, [f.code]: list.includes(o) ? list.filter((x) => x !== o) : [...list, o] })} className={cn("rounded-full border px-2.5 py-1 text-[11.5px]", list.includes(o) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)]")}>{o}</button>)}</div></Field>;
              }
              return <Field key={f.code} label={label}><Input value={v === undefined || v === null ? "" : String(v)} onChange={(val) => onChange({ ...values, [f.code]: f.fieldType === "number" ? val.replace(/[^\d.]/g, "") : val })} /></Field>;
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export const missingRequiredSpecs = (type: ProductType | undefined, values: Record<string, unknown>) =>
  (type?.spec_template ?? []).filter((f) => f.required && (values[f.code] === undefined || values[f.code] === "" || (Array.isArray(values[f.code]) && !(values[f.code] as unknown[]).length))).map((f) => f.label);

export function ProductTypesManager({ flash, onChanged }: { flash: (m: string) => void; onChanged?: () => void }) {
  const [items, setItems] = useState<ProductType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProductType | null>(null);
  const [newSize, setNewSize] = useState("");
  const [newType, setNewType] = useState({ code: "", name: "" });
  const load = useCallback(async () => {
    setError(null);
    try { const res = await productTypesApi.adminList(); setItems(res.items); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = items?.find((x) => x.id === selected); setDraft(t ? JSON.parse(JSON.stringify(t)) as ProductType : null); }, [selected, items]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState />;
  const sizes = draft ? [...draft.sizes].sort((a, b) => a.position - b.position) : [];
  const setSizes = (list: SizeDef[]) => draft && setDraft({ ...draft, sizes: list.map((s, i) => ({ ...s, position: i + 1 })) });
  const save = async () => {
    if (!draft) return;
    try { await productTypesApi.update(draft.id, { name: draft.name, description: draft.description, sizes: draft.sizes, specTemplate: draft.spec_template, active: draft.active }); flash("نوع محصول ذخیره شد؛ فرم محصول و سایزها همین حالا به‌روز شدند"); await load(); onChanged?.(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره"); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="space-y-2">
        {items.map((t) => <button key={t.id} onClick={() => setSelected(t.id)} className={cn("flex w-full items-center justify-between rounded-[10px] border px-3 py-2 text-right text-[12.5px]", selected === t.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/5" : "border-[var(--kv-line)]", t.active === false && "opacity-50")}><span className="font-bold">{t.name}</span><span className="text-[10.5px] text-[var(--kv-muted)]">{t.product_count ?? 0} محصول</span></button>)}
        <Card className="space-y-2 p-3">
          <p className="text-[12px] font-bold">نوع محصول جدید</p>
          <Input value={newType.code} onChange={(v) => setNewType({ ...newType, code: v.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="کد: kids" />
          <Input value={newType.name} onChange={(name) => setNewType({ ...newType, name })} placeholder="نام: لباس بچگانه" />
          <Btn size="sm" variant="accent" className="w-full" disabled={newType.code.length < 2 || newType.name.length < 2} onClick={async () => { try { await productTypesApi.create({ code: newType.code, name: newType.name, sizes: [], specTemplate: [], position: items.length + 1 }); setNewType({ code: "", name: "" }); flash("نوع محصول ساخته شد"); await load(); onChanged?.(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } }}>ایجاد</Btn>
        </Card>
      </div>
      {!draft ? <p className="text-[12.5px] text-[var(--kv-muted)]">یک نوع محصول را انتخاب کنید.</p> : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]"><Field label="نام"><Input value={draft.name} onChange={(name) => setDraft({ ...draft, name })} /></Field><label className="flex items-end gap-2 pb-2 text-[12.5px]"><Switch on={draft.active !== false} onToggle={() => setDraft({ ...draft, active: draft.active === false })} />فعال</label></div>
          <Card className="space-y-2 p-3">
            <p className="text-[13px] font-bold">سایزها (ترتیب نمایش قابل مدیریت است)</p>
            <div className="flex flex-wrap gap-2">{sizes.map((s, i) => (
              <span key={s.code} className={cn("inline-flex items-center gap-1 rounded-[10px] border px-2 py-1", s.active ? "border-[var(--kv-line)]" : "border-dashed opacity-50")}>
                <button aria-label="قبل" onClick={() => { if (!i) return; const l = [...sizes]; [l[i - 1], l[i]] = [l[i]!, l[i - 1]!]; setSizes(l); }}><ArrowUp size={11} className="-rotate-90" /></button>
                <input value={s.label} onChange={(e) => setSizes(sizes.map((x) => (x.code === s.code ? { ...x, label: e.target.value } : x)))} className="w-12 bg-transparent text-center text-[12px] font-bold outline-none" aria-label={`نام سایز ${s.code}`} />
                <button aria-label="بعد" onClick={() => { if (i === sizes.length - 1) return; const l = [...sizes]; [l[i + 1], l[i]] = [l[i]!, l[i + 1]!]; setSizes(l); }}><ArrowDown size={11} className="-rotate-90" /></button>
                <button aria-label={s.active ? "غیرفعال‌سازی" : "فعال‌سازی"} onClick={() => setSizes(sizes.map((x) => (x.code === s.code ? { ...x, active: !x.active } : x)))} className="text-[10px] text-[var(--kv-muted)]">{s.active ? "✓" : "○"}</button>
              </span>
            ))}</div>
            <div className="flex gap-2"><Input className="w-32" value={newSize} onChange={(v) => setNewSize(v.trim())} placeholder="مثلاً 45 یا 44.5" /><Btn size="sm" variant="soft" icon={<Plus size={13} />} disabled={!newSize || sizes.some((s) => s.code === newSize)} onClick={() => { setSizes([...sizes, { code: newSize, label: newSize, position: sizes.length + 1, active: true }]); setNewSize(""); }}>افزودن سایز</Btn></div>
            <p className="text-[11px] text-[var(--kv-muted)]">سایز استفاده‌شده در محصولات حذف نمی‌شود؛ فقط غیرفعال می‌شود.</p>
          </Card>
          <Card className="space-y-2 p-3">
            <p className="text-[13px] font-bold">قالب مشخصات (فرم محصول از این فیلدها ساخته می‌شود)</p>
            {draft.spec_template.map((f, i) => (
              <div key={i} className="grid items-end gap-2 rounded-[10px] border border-[var(--kv-line)] p-2 sm:grid-cols-[1fr_1fr_110px_1fr_auto]">
                <Field label="کد"><Input value={f.code} onChange={(code) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, code: code.toLowerCase().replace(/[^a-z0-9_]/g, "") } : x)) })} /></Field>
                <Field label="عنوان"><Input value={f.label} onChange={(label) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, label } : x)) })} /></Field>
                <Field label="نوع"><Select options={Object.values(FIELD_TYPE_LABEL)} value={FIELD_TYPE_LABEL[f.fieldType]} onChange={(l) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, fieldType: (Object.entries(FIELD_TYPE_LABEL).find(([, v]) => v === l)?.[0] ?? "text") as SpecField["fieldType"] } : x)) })} /></Field>
                <Field label="گزینه‌ها (با ، )"><Input value={f.options.join("، ")} onChange={(v) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, options: v.split(/[،,]/).map((o) => o.trim()).filter(Boolean) } : x)) })} /></Field>
                <div className="flex items-center gap-2 pb-2 text-[11px]"><label className="flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={(e) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />الزامی</label><label className="flex items-center gap-1"><input type="checkbox" checked={f.filterable} onChange={(e) => setDraft({ ...draft, spec_template: draft.spec_template.map((x, j) => (j === i ? { ...x, filterable: e.target.checked } : x)) })} />فیلتر</label><button aria-label="حذف فیلد" onClick={() => setDraft({ ...draft, spec_template: draft.spec_template.filter((_, j) => j !== i) })} className="text-[var(--kv-danger)]"><Trash2 size={13} /></button></div>
              </div>
            ))}
            <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setDraft({ ...draft, spec_template: [...draft.spec_template, { code: `field_${draft.spec_template.length + 1}`, label: "فیلد جدید", group: "مشخصات", fieldType: "text", options: [], required: false, filterable: false }] })}>افزودن فیلد</Btn>
          </Card>
          <Btn variant="accent" onClick={save}>ذخیره نوع محصول</Btn>
        </div>
      )}
    </div>
  );
}
