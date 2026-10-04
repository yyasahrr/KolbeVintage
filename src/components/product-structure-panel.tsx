import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { Btn, Card, Drawer, Empty, Field, Input, LoadingState, Select, Segmented, Status, Switch, Textarea } from "./primitives";
import { filesApi, productStructureApi, specsApi, sizeGuidesApi } from "../data/api";
import {
  SPEC_TYPES, SPEC_TYPE_LABEL, SIZE_GUIDE_STATUS_LABEL, isSpecAttributeType,
  normalizeProductTypes, normalizeTaxonomies, normalizeSpecAttributes, normalizeSpecTemplate, normalizeSizeGuides, normalizeSizeGuide,
  type ProductType, type SpecAttribute, type SpecTemplate, type SizeGuide, type Taxonomy, type SpecAttributeType,
} from "../data/contracts";
import { cn } from "../utils/cn";
import { SeriesTemplateManager } from "../portals/series-templates";
import { KOLBE } from "../data/platform";

type F = (message: string) => void;

/* ================= Product types + sizes (items 4-7) ================= */

function TypesSection({ flash }: { flash: F }) {
  const [types, setTypes] = useState<ProductType[] | null>(null);
  const [templates, setTemplates] = useState<SpecTemplate[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; description: string; active: boolean; position: string; specTemplateId: string } | null>(null);
  const [sizeDraft, setSizeDraft] = useState({ code: "", label: "" });
  const [sizeRename, setSizeRename] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [typeList, templateList] = await Promise.all([
        productStructureApi.types().then(normalizeProductTypes),
        specsApi.templates().then((raw) => (((raw ?? {}) as { items?: unknown[] }).items ?? [])
          .map((entry) => normalizeSpecTemplate({ ...(entry as object), groups: [], attributes: [] }))
          .filter((t): t is SpecTemplate => t !== null)),
      ]);
      setTypes(typeList);
      setTemplates(templateList);
      setSel((current) => (current && typeList.some((t) => t.id === current) ? current : typeList[0]?.id ?? null));
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری انواع محصول"); }
  }, [flash]);
  useEffect(() => { void load(); }, [load]);

  const current = types?.find((t) => t.id === sel) ?? null;
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const payload = {
        code: edit.code.trim().toLowerCase(), name: edit.name.trim(), description: edit.description.trim(),
        active: edit.active, position: Number(edit.position) || 0,
        specTemplateId: edit.specTemplateId || null,
      };
      if (edit.id) await productStructureApi.updateType(edit.id, payload);
      else await productStructureApi.createType(payload);
      setEdit(null);
      await load();
      flash(edit.id ? "نوع محصول به‌روزرسانی شد" : "نوع محصول ساخته شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره نوع محصول"); }
    finally { setBusy(false); }
  };
  const addSize = async () => {
    if (!current || !sizeDraft.code.trim() || !sizeDraft.label.trim()) return;
    setBusy(true);
    try {
      await productStructureApi.createSize(current.id, {
        code: sizeDraft.code.trim(), label: sizeDraft.label.trim(),
        position: current.sizes.length + 1,
      });
      setSizeDraft({ code: "", label: "" });
      await load();
      flash(`سایز ${sizeDraft.label.trim()} اضافه شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن سایز"); }
    finally { setBusy(false); }
  };
  const moveSize = async (index: number, direction: -1 | 1) => {
    if (!current) return;
    const order = current.sizes.map((s) => s.id);
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    try {
      await productStructureApi.reorderSizes(current.id, order);
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در جابه‌جایی سایز"); }
  };

  if (!types) return <LoadingState label="در حال بارگذاری انواع محصول…" />;
  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="h-fit p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-extrabold">انواع محصول ({types.length.toLocaleString("fa-IR")})</p>
          <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ code: "", name: "", description: "", active: true, position: "0", specTemplateId: "" })}>نوع جدید</Btn>
        </div>
        <div className="space-y-1.5">
          {types.map((type) => (
            <button key={type.id} onClick={() => setSel(type.id)} className={cn("flex w-full items-center gap-2 rounded-[10px] border px-3 py-2.5 text-right", sel === type.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>
              <span className="min-w-0 flex-1"><b className="block truncate text-[13px]">{type.name}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{type.code} · {type.sizes.length.toLocaleString("fa-IR")} سایز</span></span>
              {!type.active && <Status value="غیرفعال" />}
            </button>
          ))}
          {types.length === 0 && <Empty title="نوعی ثبت نشده" desc="نخستین نوع محصول (مثلاً کت، کفش) را بسازید." />}
        </div>
      </Card>
      <Card className="h-fit p-5">
        {!current ? <Empty title="نوعی انتخاب نشده" desc="از فهرست سمت راست یک نوع محصول را انتخاب کنید." /> : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-[15px] font-extrabold">{current.name}</h3><p className="text-xs text-[var(--kv-muted)]">کد نوع: <span dir="ltr">{current.code}</span></p></div>
              <div className="flex gap-2">
                <Btn variant="soft" size="sm" icon={<Pencil size={13} />} onClick={() => setEdit({ id: current.id, code: current.code, name: current.name, description: current.description, active: current.active, position: String(current.position), specTemplateId: current.specTemplateId ?? "" })}>ویرایش</Btn>
                <Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={async () => { try { await productStructureApi.deleteType(current.id); await load(); flash("نوع محصول حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "حذف ممکن نیست — احتمالاً در محصولی استفاده شده است"); } }}>حذف</Btn>
              </div>
            </div>
            {current.description && <p className="mt-2 text-[12.5px] text-[var(--kv-muted)]">{current.description}</p>}
            <p className="mt-3 text-[12.5px] text-[var(--kv-muted)]">قالب مشخصات: <b className="text-[var(--kv-ink)]">{templates.find((t) => t.id === current.specTemplateId)?.name ?? "—"}</b></p>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">سایزها <span className="font-medium text-[var(--kv-muted)]">(به همین ترتیب در فروشگاه نمایش داده می‌شوند)</span></p>
              <div className="space-y-1.5">
                {current.sizes.map((size, index) => (
                  <div key={size.id} className={cn("flex items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2", !size.active && "opacity-55")}>
                    {sizeRename?.id === size.id ? (
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <Input value={sizeRename.label} onChange={(v) => setSizeRename({ id: size.id, label: v })} placeholder="برچسب نمایشی" />
                        <Btn variant="accent" size="sm" disabled={!sizeRename.label.trim()} onClick={() => void (async () => { try { await productStructureApi.updateSize(current.id, size.id, { label: sizeRename.label.trim() }); setSizeRename(null); await load(); flash("نام سایز به‌روز شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>ذخیره</Btn>
                        <Btn variant="ghost" size="sm" onClick={() => setSizeRename(null)}>انصراف</Btn>
                      </span>
                    ) : (
                      <>
                        <b className="min-w-[52px] text-[13px]">{size.label}</b>
                        <span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{size.code}</span>
                      </>
                    )}
                    <span className="mr-auto flex items-center gap-1">
                      {sizeRename?.id !== size.id && <button onClick={() => setSizeRename({ id: size.id, label: size.label })} className="rounded p-1 text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label={`ویرایش ${size.label}`}><Pencil size={14} /></button>}
                      <button onClick={() => void moveSize(index, -1)} disabled={index === 0} className="rounded p-1 hover:bg-[var(--kv-surface-2)] disabled:opacity-30" aria-label="بالا"><ArrowUp size={14} /></button>
                      <button onClick={() => void moveSize(index, 1)} disabled={index === current.sizes.length - 1} className="rounded p-1 hover:bg-[var(--kv-surface-2)] disabled:opacity-30" aria-label="پایین"><ArrowDown size={14} /></button>
                      <Switch on={size.active} onToggle={() => void (async () => { try { await productStructureApi.updateSize(current.id, size.id, { active: !size.active }); await load(); } catch (e) { flash(e instanceof Error ? e.message : "تغییر وضعیت سایز ممکن نشد"); } })()} />
                      <button onClick={() => void (async () => { try { await productStructureApi.deleteSize(current.id, size.id); await load(); flash("سایز حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "حذف سایز ممکن نیست — در واریانتی استفاده شده است"); } })()} className="rounded p-1 text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`حذف ${size.label}`}><Trash2 size={14} /></button>
                    </span>
                  </div>
                ))}
                {current.sizes.length === 0 && <p className="py-2 text-[12.5px] text-[var(--kv-muted)]">هنوز سایزی تعریف نشده است.</p>}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label="کد سایز"><Input value={sizeDraft.code} onChange={(v) => setSizeDraft({ ...sizeDraft, code: v })} placeholder="M" /></Field>
                <Field label="برچسب نمایشی"><Input value={sizeDraft.label} onChange={(v) => setSizeDraft({ ...sizeDraft, label: v })} placeholder="مدیوم" /></Field>
                <Btn variant="soft" size="sm" disabled={busy || !sizeDraft.code.trim() || !sizeDraft.label.trim()} onClick={() => void addSize()} icon={<Plus size={14} />}>افزودن سایز</Btn>
              </div>
            </div>
          </div>
        )}
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "ویرایش نوع محصول" : "نوع محصول جدید"}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد (انگلیسی، یکتا)"><Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v })} placeholder="coat" /></Field>
              <Field label="نام"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="کت / مانتو" /></Field>
            </div>
            <Field label="توضیحات"><Textarea rows={2} value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ترتیب نمایش"><Input value={edit.position} onChange={(v) => setEdit({ ...edit, position: v.replace(/\D/g, "") })} /></Field>
              <Field label="قالب مشخصات" hint="فرم مشخصات کالاهای این نوع از این قالب ساخته می‌شود">
                <Select options={["بدون قالب", ...templates.map((t) => t.name)]} value={templates.find((t) => t.id === edit.specTemplateId)?.name ?? "بدون قالب"} onChange={(label) => setEdit({ ...edit, specTemplateId: templates.find((t) => t.name === label)?.id ?? "" })} />
              </Field>
            </div>
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">فعال<Switch on={edit.active} onToggle={() => setEdit({ ...edit, active: !edit.active })} /></label>
            <Btn variant="accent" className="w-full" disabled={busy || !edit.code.trim() || edit.name.trim().length < 2} onClick={() => void save()}>ذخیره</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Gender / season taxonomies (items 245-247) ================= */

function TaxonomySection({ flash }: { flash: F }) {
  const [items, setItems] = useState<Taxonomy[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { code: string; label: string }>>({ gender: { code: "", label: "" }, season: { code: "", label: "" } });
  const load = useCallback(async () => {
    try { setItems(await productStructureApi.adminTaxonomies().then(normalizeTaxonomies)); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری رده‌بندی‌ها"); }
  }, [flash]);
  useEffect(() => { void load(); }, [load]);
  if (!items) return <LoadingState label="در حال بارگذاری رده‌بندی‌ها…" />;
  const kinds: { kind: "gender" | "season"; title: string }[] = [{ kind: "gender", title: "جنسیت مخاطب" }, { kind: "season", title: "فصل" }];
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      {kinds.map(({ kind, title }) => (
        <Card key={kind} className="h-fit p-5">
          <p className="text-sm font-extrabold">{title}</p>
          <p className="mt-1 text-[12px] text-[var(--kv-muted)]">مقادیر فعال همین‌جا در فرم تعریف محصول نمایش داده می‌شوند.</p>
          <div className="mt-3 space-y-1.5">
            {items.filter((item) => item.kind === kind).map((item) => (
              <div key={item.id} className={cn("flex items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2", !item.active && "opacity-55")}>
                <b className="text-[13px]">{item.label}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{item.code}</span>
                <span className="mr-auto"><Switch on={item.active} onToggle={() => void (async () => { try { await productStructureApi.updateTaxonomy(item.id, { active: !item.active }); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} /></span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="کد"><Input value={drafts[kind]!.code} onChange={(v) => setDrafts({ ...drafts, [kind]: { ...drafts[kind]!, code: v } })} placeholder={kind === "gender" ? "female" : "autumn"} /></Field>
            <Field label="برچسب"><Input value={drafts[kind]!.label} onChange={(v) => setDrafts({ ...drafts, [kind]: { ...drafts[kind]!, label: v } })} placeholder={kind === "gender" ? "زنانه" : "پاییز"} /></Field>
            <Btn variant="soft" size="sm" icon={<Plus size={14} />} disabled={!drafts[kind]!.code.trim() || !drafts[kind]!.label.trim()} onClick={() => void (async () => { try { await productStructureApi.createTaxonomy({ kind, code: drafts[kind]!.code.trim().toLowerCase(), label: drafts[kind]!.label.trim() }); setDrafts({ ...drafts, [kind]: { code: "", label: "" } }); await load(); flash("مقدار جدید اضافه شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن"); } })()}>افزودن</Btn>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ================= Spec attributes (items 122-126) ================= */

const blankAttribute = () => ({ code: "", label: "", description: "", type: "text" as SpecAttributeType, unit: "", required: false, searchable: false, filterable: false, scope: "product" as "product" | "variant", position: "0", validation: {} as Record<string, unknown>, active: true, options: [] as { value: string; label: string }[] });

function AttributesSection({ flash }: { flash: F }) {
  const [items, setItems] = useState<SpecAttribute[] | null>(null);
  const [edit, setEdit] = useState<(ReturnType<typeof blankAttribute> & { id?: string }) | null>(null);
  const [optionDraft, setOptionDraft] = useState({ value: "", label: "" });
  const load = useCallback(async () => {
    try { setItems(await specsApi.adminAttributes().then(normalizeSpecAttributes)); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری فیلدها"); }
  }, [flash]);
  useEffect(() => { void load(); }, [load]);
  if (!items) return <LoadingState label="در حال بارگذاری فیلدهای مشخصات…" />;

  const save = async () => {
    if (!edit) return;
    try {
      const payload = {
        code: edit.code.trim().toLowerCase(), label: edit.label.trim(), description: edit.description.trim(),
        type: edit.type, unit: edit.unit.trim() || null, required: edit.required, searchable: edit.searchable,
        filterable: edit.filterable, scope: edit.scope, position: Number(edit.position) || 0,
        validation: edit.validation, active: edit.active,
        options: (edit.type === "single_select" || edit.type === "multi_select") ? edit.options : [],
      };
      if (edit.id) await specsApi.updateAttribute(edit.id, payload);
      else await specsApi.createAttribute(payload);
      setEdit(null);
      await load();
      flash(edit.id ? "فیلد به‌روزرسانی شد" : "فیلد ساخته شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره فیلد"); }
  };
  const isSelect = edit?.type === "single_select" || edit?.type === "multi_select";
  const isNumber = edit?.type === "number" || edit?.type === "decimal" || edit?.type === "measurement";
  const isText = edit?.type === "text" || edit?.type === "textarea";

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--kv-muted)]">فیلدها یک‌بار اینجا تعریف می‌شوند و در قالب‌های مشخصات استفاده می‌شوند. مقادیر ذخیره‌شده با حذف فیلد پاک نمی‌شوند.</p>
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setEdit(blankAttribute()); setOptionDraft({ value: "", label: "" }); }}>فیلد جدید</Btn>
      </div>
      <Card className="overflow-hidden">
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[860px]">
            <thead><tr><th>برچسب</th><th>کد</th><th>نوع</th><th>سطح</th><th>الزامی</th><th>فیلتر فروشگاه</th><th>فعال</th><th></th></tr></thead>
            <tbody>
              {items.map((attribute) => (
                <tr key={attribute.id}>
                  <td><b>{attribute.label}</b>{attribute.unit && <span className="text-[11px] text-[var(--kv-muted)]"> ({attribute.unit})</span>}</td>
                  <td className="font-mono text-[12px]" dir="ltr">{attribute.code}</td>
                  <td>{SPEC_TYPE_LABEL[attribute.type]}{attribute.options.length > 0 && <span className="text-[11px] text-[var(--kv-muted)]"> · {attribute.options.length.toLocaleString("fa-IR")} گزینه</span>}</td>
                  <td>{attribute.scope === "variant" ? "واریانت" : "محصول"}</td>
                  <td>{attribute.required ? "بله" : "—"}</td>
                  <td>{attribute.filterable ? "بله" : "—"}</td>
                  <td><Switch on={attribute.active} onToggle={() => void (async () => { try { await specsApi.updateAttribute(attribute.id, { active: !attribute.active }); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} /></td>
                  <td><span className="flex gap-2">
                    <button onClick={() => { setEdit({ ...blankAttribute(), id: attribute.id, code: attribute.code, label: attribute.label, description: attribute.description, type: attribute.type, unit: attribute.unit ?? "", required: attribute.required, searchable: attribute.searchable, filterable: attribute.filterable, scope: attribute.scope, position: String(attribute.position), validation: attribute.validation, active: attribute.active, options: attribute.options.map((o) => ({ value: o.value, label: o.label })) }); setOptionDraft({ value: "", label: "" }); }} className="text-[var(--kv-muted)] hover:text-[var(--kv-ink)]" aria-label={`ویرایش ${attribute.label}`}><Pencil size={15} /></button>
                    <button onClick={() => void (async () => { try { await specsApi.deleteAttribute(attribute.id); await load(); flash("فیلد حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "حذف ممکن نیست — در قالب یا مقداری استفاده شده است"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`حذف ${attribute.label}`}><Trash2 size={15} /></button>
                  </span></td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-[var(--kv-muted)]">هنوز فیلدی تعریف نشده است.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "ویرایش فیلد" : "فیلد جدید"} wide>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد (انگلیسی، یکتا)"><Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v })} placeholder="fabric" /></Field>
              <Field label="برچسب"><Input value={edit.label} onChange={(v) => setEdit({ ...edit, label: v })} placeholder="جنس پارچه" /></Field>
            </div>
            <Field label="توضیح راهنما"><Textarea rows={2} value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="نوع فیلد"><Select options={SPEC_TYPES.map((t) => SPEC_TYPE_LABEL[t])} value={SPEC_TYPE_LABEL[edit.type]} onChange={(label) => { const found = SPEC_TYPES.find((t) => SPEC_TYPE_LABEL[t] === label); if (found && isSpecAttributeType(found)) setEdit({ ...edit, type: found }); }} /></Field>
              <Field label="سطح"><Select options={["محصول", "واریانت"]} value={edit.scope === "variant" ? "واریانت" : "محصول"} onChange={(v) => setEdit({ ...edit, scope: v === "واریانت" ? "variant" : "product" })} /></Field>
              <Field label="واحد (اختیاری)"><Input value={edit.unit} onChange={(v) => setEdit({ ...edit, unit: v })} placeholder="cm" /></Field>
            </div>
            {isSelect && (
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-2 text-[12.5px] font-bold">گزینه‌های مجاز</p>
                <div className="space-y-1.5">
                  {edit.options.map((option, index) => (
                    <div key={`${option.value}-${index}`} className="flex items-center gap-2 rounded-[8px] bg-[var(--kv-surface-2)]/60 px-3 py-1.5 text-[12.5px]">
                      <b>{option.label}</b><span className="text-[var(--kv-muted)]" dir="ltr">{option.value}</span>
                      <button onClick={() => setEdit({ ...edit, options: edit.options.filter((_, i) => i !== index) })} className="mr-auto text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف گزینه"><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Field label="مقدار"><Input value={optionDraft.value} onChange={(v) => setOptionDraft({ ...optionDraft, value: v })} placeholder="cotton" /></Field>
                  <Field label="برچسب"><Input value={optionDraft.label} onChange={(v) => setOptionDraft({ ...optionDraft, label: v })} placeholder="نخی" /></Field>
                  <Btn variant="soft" size="sm" disabled={!optionDraft.value.trim() || !optionDraft.label.trim()} onClick={() => { setEdit({ ...edit, options: [...edit.options, { value: optionDraft.value.trim(), label: optionDraft.label.trim() }] }); setOptionDraft({ value: "", label: "" }); }} icon={<Plus size={13} />}>افزودن گزینه</Btn>
                </div>
              </div>
            )}
            {isNumber && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="کمینه (اختیاری)"><Input value={String(edit.validation.min ?? "")} onChange={(v) => setEdit({ ...edit, validation: { ...edit.validation, min: v === "" ? undefined : Number(v) } })} /></Field>
                <Field label="بیشینه (اختیاری)"><Input value={String(edit.validation.max ?? "")} onChange={(v) => setEdit({ ...edit, validation: { ...edit.validation, max: v === "" ? undefined : Number(v) } })} /></Field>
              </div>
            )}
            {isText && (
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="حداقل طول"><Input value={String(edit.validation.minLength ?? "")} onChange={(v) => setEdit({ ...edit, validation: { ...edit.validation, minLength: v === "" ? undefined : Number(v) } })} /></Field>
                <Field label="حداکثر طول"><Input value={String(edit.validation.maxLength ?? "")} onChange={(v) => setEdit({ ...edit, validation: { ...edit.validation, maxLength: v === "" ? undefined : Number(v) } })} /></Field>
                <Field label="الگوی regex (اختیاری)"><Input value={String(edit.validation.pattern ?? "")} onChange={(v) => setEdit({ ...edit, validation: { ...edit.validation, pattern: v || undefined } })} placeholder="^[0-9]+$" /></Field>
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {[["required", "الزامی", edit.required], ["searchable", "قابل جست‌وجو", edit.searchable], ["filterable", "فیلتر فروشگاه", edit.filterable], ["active", "فعال", edit.active]].map(([key, label, value]) => (
                <label key={key as string} className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-2.5 text-[12.5px] font-bold">{label as string}<Switch on={value as boolean} onToggle={() => setEdit({ ...edit, [key as string]: !(value as boolean) })} /></label>
              ))}
            </div>
            <Btn variant="accent" className="w-full" disabled={!edit.code.trim() || edit.label.trim().length < 2} onClick={() => void save()}>ذخیره فیلد</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Spec templates (item 127) ================= */

function TemplatesSection({ flash }: { flash: F }) {
  const [templates, setTemplates] = useState<SpecTemplate[] | null>(null);
  const [attributes, setAttributes] = useState<SpecAttribute[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<SpecTemplate | null>(null);
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; description: string; active: boolean } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [attach, setAttach] = useState({ attributeId: "", groupId: "" });

  const load = useCallback(async () => {
    try {
      const [templateList, attributeList] = await Promise.all([
        specsApi.templates().then((raw) => (((raw ?? {}) as { items?: unknown[] }).items ?? [])
          .map((entry) => normalizeSpecTemplate({ ...(entry as object), groups: [], attributes: [] }))
          .filter((t): t is SpecTemplate => t !== null)),
        specsApi.adminAttributes().then(normalizeSpecAttributes),
      ]);
      setTemplates(templateList);
      setAttributes(attributeList);
      setSel((current) => (current && templateList.some((t) => t.id === current) ? current : templateList[0]?.id ?? null));
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری قالب‌ها"); }
  }, [flash]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let live = true;
    specsApi.templateDetail(sel).then(normalizeSpecTemplate).then((t) => { if (live) setDetail(t); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [sel]);

  const refreshDetail = async (id: string) => {
    try { setDetail(await specsApi.templateDetail(id).then(normalizeSpecTemplate)); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در خواندن قالب"); }
  };
  if (!templates) return <LoadingState label="در حال بارگذاری قالب‌ها…" />;

  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="h-fit p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-extrabold">قالب‌ها ({templates.length.toLocaleString("fa-IR")})</p>
          <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ code: "", name: "", description: "", active: true })}>قالب جدید</Btn>
        </div>
        <div className="space-y-1.5">
          {templates.map((template) => (
            <button key={template.id} onClick={() => setSel(template.id)} className={cn("flex w-full items-center gap-2 rounded-[10px] border px-3 py-2.5 text-right", sel === template.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>
              <span className="min-w-0 flex-1"><b className="block truncate text-[13px]">{template.name}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{template.code}</span></span>
              {!template.active && <Status value="غیرفعال" />}
            </button>
          ))}
          {templates.length === 0 && <Empty title="قالبی نیست" desc="قالب مشخصات هر نوع محصول را اینجا بسازید." />}
        </div>
      </Card>
      <Card className="h-fit p-5">
        {!detail ? <Empty title="قالبی انتخاب نشده" desc="از فهرست یک قالب را انتخاب کنید." /> : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-[15px] font-extrabold">{detail.name}</h3><p className="text-xs text-[var(--kv-muted)]">{detail.attributes.length.toLocaleString("fa-IR")} فیلد · {detail.groups.length.toLocaleString("fa-IR")} گروه</p></div>
              <div className="flex gap-2">
                <Btn variant="soft" size="sm" icon={<Pencil size={13} />} onClick={() => setEdit({ id: detail.id, code: detail.code, name: detail.name, description: detail.description, active: detail.active })}>ویرایش</Btn>
                <Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => void (async () => { try { await specsApi.deleteTemplate(detail.id); await load(); flash("قالب حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "حذف ممکن نیست — به نوع محصولی وصل است"); } })()}>حذف</Btn>
              </div>
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">گروه‌ها</p>
              <div className="flex flex-wrap gap-2">
                {detail.groups.map((group) => (
                  <span key={group.id} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-[12px] font-bold">{group.name}
                    <button onClick={() => void (async () => { try { await specsApi.deleteGroup(detail.id, group.id); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "حذف گروه ممکن نشد"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`حذف گروه ${group.name}`}><Trash2 size={12} /></button>
                  </span>
                ))}
                {detail.groups.length === 0 && <span className="text-[12px] text-[var(--kv-muted)]">بدون گروه — همه فیلدها در یک بخش نمایش داده می‌شوند.</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="گروه جدید"><Input value={groupName} onChange={setGroupName} placeholder="مثلاً مشخصات فنی" /></Field>
                <Btn variant="soft" size="sm" disabled={groupName.trim().length < 2} onClick={() => void (async () => { try { await specsApi.createGroup(detail.id, { name: groupName.trim() }); setGroupName(""); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت گروه"); } })()} icon={<Plus size={13} />}>افزودن گروه</Btn>
              </div>
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">فیلدهای قالب</p>
              <div className="space-y-1.5">
                {detail.attributes.map((attribute) => (
                  <div key={attribute.id} className="flex items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[12.5px]">
                    <b>{attribute.label}</b>
                    <span className="text-[var(--kv-muted)]">{SPEC_TYPE_LABEL[attribute.type]}</span>
                    {attribute.required && <span className="rounded-full bg-[var(--kv-danger)]/10 px-2 py-0.5 text-[10.5px] font-bold text-[var(--kv-danger)]">الزامی</span>}
                    <span className="mr-auto flex items-center gap-2">
                      <span className="text-[11.5px] text-[var(--kv-muted)]">{detail.groups.find((g) => g.id === attribute.groupId)?.name ?? "بدون گروه"}</span>
                      <button onClick={() => void (async () => { try { await specsApi.detachAttribute(detail.id, attribute.id); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`حذف ${attribute.label} از قالب`}><Trash2 size={14} /></button>
                    </span>
                  </div>
                ))}
                {detail.attributes.length === 0 && <p className="py-2 text-[12.5px] text-[var(--kv-muted)]">هنوز فیلدی به این قالب اضافه نشده است.</p>}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="فیلد"><Select options={["انتخاب فیلد…", ...attributes.filter((a) => !detail.attributes.some((x) => x.id === a.id)).map((a) => a.label)]} value={attributes.find((a) => a.id === attach.attributeId)?.label ?? "انتخاب فیلد…"} onChange={(label) => setAttach({ ...attach, attributeId: attributes.find((a) => a.label === label)?.id ?? "" })} /></Field>
                <Field label="گروه"><Select options={["بدون گروه", ...detail.groups.map((g) => g.name)]} value={detail.groups.find((g) => g.id === attach.groupId)?.name ?? "بدون گروه"} onChange={(label) => setAttach({ ...attach, groupId: detail.groups.find((g) => g.name === label)?.id ?? "" })} /></Field>
                <Btn variant="soft" size="sm" disabled={!attach.attributeId} onClick={() => void (async () => { try { await specsApi.attachAttribute(detail.id, { attributeId: attach.attributeId, groupId: attach.groupId || null, position: detail.attributes.length }); setAttach({ attributeId: "", groupId: "" }); await refreshDetail(detail.id); flash("فیلد به قالب اضافه شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن فیلد"); } })()} icon={<Plus size={13} />}>افزودن</Btn>
              </div>
            </div>
          </div>
        )}
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "ویرایش قالب" : "قالب جدید"}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد (انگلیسی، یکتا)"><Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v })} placeholder="coat" /></Field>
              <Field label="نام"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="قالب کت" /></Field>
            </div>
            <Field label="توضیحات"><Textarea rows={2} value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} /></Field>
            <label className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3 text-[13px] font-bold">فعال<Switch on={edit.active} onToggle={() => setEdit({ ...edit, active: !edit.active })} /></label>
            <Btn variant="accent" className="w-full" disabled={!edit.code.trim() || edit.name.trim().length < 2} onClick={() => void (async () => { try { if (edit.id) await specsApi.updateTemplate(edit.id, { name: edit.name.trim(), description: edit.description.trim(), active: edit.active }); else await specsApi.createTemplate({ code: edit.code.trim().toLowerCase(), name: edit.name.trim(), description: edit.description.trim(), active: edit.active }); setEdit(null); await load(); flash("قالب ذخیره شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره قالب"); } })()}>ذخیره</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Size guides (items 129-134) ================= */

function GuidesSection({ flash }: { flash: F }) {
  const [guides, setGuides] = useState<SizeGuide[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<SizeGuide | null>(null);
  const [edit, setEdit] = useState<{ id?: string; code: string; name: string; description: string; status: string } | null>(null);
  const [columnDraft, setColumnDraft] = useState({ code: "", label: "", unit: "" });
  const [rowDraft, setRowDraft] = useState<Record<string, string>>({});
  const [mediaDraft, setMediaDraft] = useState({ kind: "image", caption: "" });
  const [mediaBusy, setMediaBusy] = useState(false);
  // QA2-SIZE-005: in-place column rename + row edit state
  const [colEdit, setColEdit] = useState<{ id: string; label: string; unit: string } | null>(null);
  const [rowEdit, setRowEdit] = useState<{ id: string; values: Record<string, string> } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await sizeGuidesApi.adminList().then(normalizeSizeGuides);
      setGuides(list);
      setSel((current) => (current && list.some((g) => g.id === current) ? current : list[0]?.id ?? null));
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری راهنماها"); }
  }, [flash]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let live = true;
    sizeGuidesApi.detail(sel).then(normalizeSizeGuide).then((g) => { if (live) setDetail(g); }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [sel]);

  const refreshDetail = async (id: string) => {
    try { setDetail(await sizeGuidesApi.detail(id).then(normalizeSizeGuide)); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در خواندن راهنما"); }
  };
  if (!guides) return <LoadingState label="در حال بارگذاری راهنمای سایز…" />;

  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="h-fit p-4">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-sm font-extrabold">راهنماها ({guides.length.toLocaleString("fa-IR")})</p>
          <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => setEdit({ code: "", name: "", description: "", status: "active" })}>راهنمای جدید</Btn>
        </div>
        <div className="space-y-1.5">
          {guides.map((guide) => (
            <button key={guide.id} onClick={() => setSel(guide.id)} className={cn("flex w-full items-center gap-2 rounded-[10px] border px-3 py-2.5 text-right", sel === guide.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>
              <span className="min-w-0 flex-1"><b className="block truncate text-[13px]">{guide.name}</b><span className="text-[11px] text-[var(--kv-muted)]">نسخه {guide.version.toLocaleString("fa-IR")} · {SIZE_GUIDE_STATUS_LABEL[guide.status] ?? guide.status}</span></span>
            </button>
          ))}
          {guides.length === 0 && <Empty title="راهنمایی نیست" desc="جدول سایز هر دسته را اینجا بسازید." />}
        </div>
      </Card>
      <Card className="h-fit p-5">
        {!detail ? <Empty title="راهنمایی انتخاب نشده" desc="از فهرست یک راهنمای سایز را انتخاب کنید." /> : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 className="text-[15px] font-extrabold">{detail.name}</h3><p className="text-xs text-[var(--kv-muted)]" dir="ltr">{detail.code} · نسخه {detail.version.toLocaleString("fa-IR")}</p></div>
              <div className="flex gap-2">
                <Btn variant="soft" size="sm" icon={<RefreshCw size={13} />} onClick={() => void (async () => { try { await sizeGuidesApi.newVersion(detail.id); await refreshDetail(detail.id); flash("نسخه جدید ساخته شد؛ اتصال‌های detached دست نخورده ماند"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>نسخه جدید</Btn>
                <Btn variant="soft" size="sm" icon={<Pencil size={13} />} onClick={() => setEdit({ id: detail.id, code: detail.code, name: detail.name, description: detail.description, status: detail.status })}>ویرایش</Btn>
              </div>
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">ستون‌ها</p>
              <div className="flex flex-wrap gap-2">
                {detail.columns.map((column, index) => colEdit?.id === column.id ? (
                  <span key={column.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--kv-accent)] bg-[var(--kv-surface)] px-2 py-1 text-[12px]">
                    <input className="w-24 bg-transparent font-bold outline-none" value={colEdit.label} onChange={(e) => setColEdit({ ...colEdit, label: e.target.value })} aria-label="برچسب ستون" />
                    <input className="w-12 bg-transparent text-[var(--kv-muted)] outline-none" value={colEdit.unit} onChange={(e) => setColEdit({ ...colEdit, unit: e.target.value })} placeholder="واحد" aria-label="واحد ستون" />
                    <button disabled={!colEdit.label.trim()} onClick={() => void (async () => { try { await sizeGuidesApi.updateColumn(detail.id, column.id, { label: colEdit.label.trim(), unit: colEdit.unit.trim() || null }); setColEdit(null); await refreshDetail(detail.id); flash("ستون ویرایش شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-emerald-600" aria-label="ثبت ویرایش ستون"><Check size={13} /></button>
                    <button onClick={() => setColEdit(null)} className="text-[var(--kv-faint)]" aria-label="انصراف"><X size={13} /></button>
                  </span>
                ) : (
                  <span key={column.id} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1.5 text-[12px] font-bold">{column.label}{column.unit && <span className="text-[var(--kv-muted)]">({column.unit})</span>}
                    <button onClick={() => setColEdit({ id: column.id, label: column.label, unit: column.unit ?? "" })} className="text-[var(--kv-faint)] hover:text-[var(--kv-accent)]" aria-label={`ویرایش ستون ${column.label}`}><Pencil size={12} /></button>
                    {index > 0 && <button onClick={() => void (async () => { try { const prev = detail.columns[index - 1]!; await sizeGuidesApi.updateColumn(detail.id, column.id, { position: index - 1 }); await sizeGuidesApi.updateColumn(detail.id, prev.id, { position: index }); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-ink)]" aria-label={`جابه‌جایی ${column.label} به راست`}><ArrowRight size={12} /></button>}
                    {index < detail.columns.length - 1 && <button onClick={() => void (async () => { try { const next = detail.columns[index + 1]!; await sizeGuidesApi.updateColumn(detail.id, column.id, { position: index + 1 }); await sizeGuidesApi.updateColumn(detail.id, next.id, { position: index }); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-ink)]" aria-label={`جابه‌جایی ${column.label} به چپ`}><ArrowLeft size={12} /></button>}
                    <button onClick={() => void (async () => { try { await sizeGuidesApi.deleteColumn(detail.id, column.id); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label={`حذف ستون ${column.label}`}><Trash2 size={12} /></button>
                  </span>
                ))}
                {detail.columns.length === 0 && <span className="text-[12px] text-[var(--kv-muted)]">هنوز ستونی تعریف نشده است.</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <Field label="کد ستون"><Input value={columnDraft.code} onChange={(v) => setColumnDraft({ ...columnDraft, code: v })} placeholder="chest" /></Field>
                <Field label="برچسب"><Input value={columnDraft.label} onChange={(v) => setColumnDraft({ ...columnDraft, label: v })} placeholder="دور سینه" /></Field>
                <Field label="واحد"><Input value={columnDraft.unit} onChange={(v) => setColumnDraft({ ...columnDraft, unit: v })} placeholder="cm" /></Field>
                <Btn variant="soft" size="sm" disabled={!columnDraft.code.trim() || !columnDraft.label.trim()} onClick={() => void (async () => { try { await sizeGuidesApi.addColumn(detail.id, { code: columnDraft.code.trim().toLowerCase(), label: columnDraft.label.trim(), unit: columnDraft.unit.trim() || null }); setColumnDraft({ code: "", label: "", unit: "" }); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن ستون"); } })()} icon={<Plus size={13} />}>افزودن ستون</Btn>
              </div>
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">سطرهای جدول ({detail.rows.length.toLocaleString("fa-IR")})</p>
              {detail.columns.length > 0 && detail.rows.length > 0 && (
                <div className="kv-scroll mb-2 overflow-x-auto">
                  <table className="kv-table min-w-[480px]">
                    <thead><tr>{detail.columns.map((c) => <th key={c.id}>{c.label}</th>)}<th></th></tr></thead>
                    <tbody>
                      {detail.rows.map((row, rowIndex) => rowEdit?.id === row.id ? (
                        <tr key={row.id} className="bg-[var(--kv-accent)]/[0.05]">
                          {detail.columns.map((c) => (
                            <td key={c.id}><input className="w-20 rounded-[6px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-1.5 py-1 text-[12px] outline-none focus:border-[var(--kv-accent)]" value={rowEdit.values[c.code] ?? ""} onChange={(e) => setRowEdit({ ...rowEdit, values: { ...rowEdit.values, [c.code]: e.target.value } })} aria-label={`مقدار ${c.label}`} /></td>
                          ))}
                          <td className="whitespace-nowrap">
                            <button onClick={() => void (async () => { try { await sizeGuidesApi.replaceRows(detail.id, detail.rows.map((r) => r.id === row.id ? rowEdit.values : r.values)); setRowEdit(null); await refreshDetail(detail.id); flash("سطر ویرایش شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="text-emerald-600" aria-label="ثبت ویرایش سطر"><Check size={14} /></button>
                            <button onClick={() => setRowEdit(null)} className="mr-1.5 text-[var(--kv-faint)]" aria-label="انصراف"><X size={14} /></button>
                          </td>
                        </tr>
                      ) : (
                        <tr key={row.id}>{detail.columns.map((c) => <td key={c.id}>{row.values[c.code] ?? "—"}</td>)}
                          <td className="whitespace-nowrap">
                            <button onClick={() => setRowEdit({ id: row.id, values: Object.fromEntries(detail.columns.map((c) => [c.code, row.values[c.code] ?? ""])) })} className="text-[var(--kv-faint)] hover:text-[var(--kv-accent)]" aria-label="ویرایش سطر"><Pencil size={14} /></button>
                            {rowIndex > 0 && <button onClick={() => void (async () => { try { const next = detail.rows.map((r) => r.values); [next[rowIndex - 1], next[rowIndex]] = [next[rowIndex]!, next[rowIndex - 1]!]; await sizeGuidesApi.replaceRows(detail.id, next); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="mr-1.5 text-[var(--kv-faint)] hover:text-[var(--kv-ink)]" aria-label="انتقال سطر به بالا"><ArrowUp size={14} /></button>}
                            {rowIndex < detail.rows.length - 1 && <button onClick={() => void (async () => { try { const next = detail.rows.map((r) => r.values); [next[rowIndex + 1], next[rowIndex]] = [next[rowIndex]!, next[rowIndex + 1]!]; await sizeGuidesApi.replaceRows(detail.id, next); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="mr-1.5 text-[var(--kv-faint)] hover:text-[var(--kv-ink)]" aria-label="انتقال سطر به پایین"><ArrowDown size={14} /></button>}
                            <button onClick={() => void (async () => { try { await sizeGuidesApi.replaceRows(detail.id, detail.rows.filter((r) => r.id !== row.id).map((r) => r.values)); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="mr-1.5 text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف سطر"><Trash2 size={14} /></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {detail.columns.length > 0 ? (
                <div className="flex flex-wrap items-end gap-2">
                  {detail.columns.map((column) => (
                    <Field key={column.id} label={column.label}><Input value={rowDraft[column.code] ?? ""} onChange={(v) => setRowDraft({ ...rowDraft, [column.code]: v })} /></Field>
                  ))}
                  <Btn variant="soft" size="sm" icon={<Plus size={13} />} onClick={() => void (async () => { try { await sizeGuidesApi.replaceRows(detail.id, [...detail.rows.map((r) => r.values), rowDraft]); setRowDraft({}); await refreshDetail(detail.id); flash("سطر اضافه شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن سطر"); } })()}>افزودن سطر</Btn>
                </div>
              ) : <p className="text-[12px] text-[var(--kv-muted)]">ابتدا ستون بسازید.</p>}
            </div>
            <div className="mt-4 border-t border-[var(--kv-line)] pt-4">
              <p className="mb-2 text-[13px] font-extrabold">رسانه آموزشی ({detail.media.length.toLocaleString("fa-IR")})</p>
              <div className="space-y-1.5">
                {detail.media.map((media) => (
                  <div key={media.id} className="flex items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[12.5px]">
                    <b>{media.caption || media.originalName}</b><span className="text-[var(--kv-muted)]">{media.kind}</span>
                    <button onClick={() => void (async () => { try { await sizeGuidesApi.deleteMedia(detail.id, media.id); await refreshDetail(detail.id); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()} className="mr-auto text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف رسانه"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
              {/* QA2-SIZE-006: direct file upload — no raw UUID / API jargon for the operator */}
              <div className="mt-2 grid gap-2 sm:grid-cols-[140px_1fr_auto] sm:items-end">
                <Field label="نوع رسانه"><Select options={["تصویر", "نمودار", "ویدیو", "گیف"]} value={mediaDraft.kind === "image" ? "تصویر" : mediaDraft.kind === "diagram" ? "نمودار" : mediaDraft.kind === "video" ? "ویدیو" : "گیف"} onChange={(v) => setMediaDraft({ ...mediaDraft, kind: v === "تصویر" ? "image" : v === "نمودار" ? "diagram" : v === "ویدیو" ? "video" : "gif" })} /></Field>
                <Field label="زیرنویس (اختیاری)"><Input value={mediaDraft.caption} onChange={(v) => setMediaDraft({ ...mediaDraft, caption: v })} placeholder="مثلاً نحوه اندازه‌گیری دور سینه" /></Field>
                <div>
                  <input id={`sg-media-${detail.id}`} type="file" accept="image/*,video/mp4" className="sr-only" onChange={(e) => {
                    const file = e.target.files?.[0]; e.target.value = "";
                    if (!file) return;
                    setMediaBusy(true);
                    void (async () => {
                      try {
                        const uploaded = await filesApi.upload(file);
                        await sizeGuidesApi.addMedia(detail.id, { fileId: String((uploaded as { id: string }).id), kind: mediaDraft.kind as "image", caption: mediaDraft.caption.trim() });
                        setMediaDraft({ kind: "image", caption: "" });
                        await refreshDetail(detail.id);
                        flash("رسانه بارگذاری و اضافه شد");
                      } catch (err) { flash(err instanceof Error ? err.message : "خطا در بارگذاری رسانه"); }
                      finally { setMediaBusy(false); }
                    })();
                  }} />
                  <Btn variant="soft" size="sm" disabled={mediaBusy} icon={<Upload size={13} />} onClick={() => document.getElementById(`sg-media-${detail.id}`)?.click()}>{mediaBusy ? "در حال بارگذاری…" : "بارگذاری فایل"}</Btn>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "ویرایش راهنما" : "راهنمای جدید"}>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="کد (انگلیسی، یکتا)"><Input value={edit.code} onChange={(v) => setEdit({ ...edit, code: v })} placeholder="coat-size" /></Field>
              <Field label="نام"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="راهنمای سایز کت" /></Field>
            </div>
            <Field label="توضیحات"><Textarea rows={2} value={edit.description} onChange={(v) => setEdit({ ...edit, description: v })} /></Field>
            <Field label="وضعیت"><Select options={["active", "draft", "archived"]} value={edit.status} onChange={(v) => setEdit({ ...edit, status: v })} /></Field>
            <Btn variant="accent" className="w-full" disabled={!edit.code.trim() || edit.name.trim().length < 2} onClick={() => void (async () => { try { if (edit.id) await sizeGuidesApi.update(edit.id, { name: edit.name.trim(), description: edit.description.trim(), status: edit.status }); else await sizeGuidesApi.create({ code: edit.code.trim().toLowerCase(), name: edit.name.trim(), description: edit.description.trim(), status: edit.status }); setEdit(null); await load(); flash("راهنما ذخیره شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره راهنما"); } })()}>ذخیره</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Section shell (item 135) ================= */

export function ProductStructurePanel({ flash }: { flash: F }) {
  const [tab, setTab] = useState<"types" | "taxonomy" | "attributes" | "templates" | "guides" | "series">("types");
  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Segmented options={[
          { v: "types", label: "انواع محصول و سایز" },
          { v: "taxonomy", label: "جنسیت و فصل" },
          { v: "attributes", label: "فیلدهای مشخصات" },
          { v: "templates", label: "قالب‌های مشخصات" },
          { v: "guides", label: "راهنمای سایز" },
          { v: "series", label: "قالب‌های سری" },
        ]} value={tab} onChange={setTab} />
        <span className="mr-auto text-[12px] text-[var(--kv-muted)]">فرم تعریف محصول و فیلترهای فروشگاه از همین‌جا ساخته می‌شوند — بدون جدول ثابت در فرانت‌اند.</span>
      </div>
      {tab === "types" && <TypesSection flash={flash} />}
      {tab === "taxonomy" && <TaxonomySection flash={flash} />}
      {tab === "attributes" && <AttributesSection flash={flash} />}
      {tab === "templates" && <TemplatesSection flash={flash} />}
      {tab === "guides" && <GuidesSection flash={flash} />}
      {tab === "series" && (
        <Card className="p-5">
          <SeriesTemplateManager ownerId={KOLBE.id} ownerLabel="کلبه وینتیج" />
        </Card>
      )}
    </div>
  );
}
