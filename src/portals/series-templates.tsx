import { useEffect, useState } from "react";
import { Check, Copy, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { fmtMoney, fmtNum, type Colorway, type SeriesDef } from "../data/catalog";
import { useOps, type SeriesCategory, type SeriesTemplate } from "../data/ops";
import { Btn, Drawer, Empty, Field, Input, Select, Switch, Textarea } from "../components/primitives";
import { productStructureApi } from "../data/api";
import { normalizeProductTypes, type ProductType } from "../data/contracts";
import { cn } from "../utils/cn";

const SIZE_OPTIONS: Record<SeriesCategory, string[]> = {
  لباس: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"],
  شلوار: ["28", "30", "32", "34", "36", "38", "40", "42"],
  کفش: ["36", "37", "38", "39", "40", "41", "42", "43", "44"],
  اکسسوری: ["تک‌سایز", "کوچک", "متوسط", "بزرگ"],
  سایر: ["مدل ۱", "مدل ۲", "مدل ۳", "تک‌سایز"],
};
export const seriesCategoryOf = (category: string): SeriesCategory =>
  /کفش|کتانی|بوت/.test(category) ? "کفش" : /شلوار|جین/.test(category) ? "شلوار" :
  /اکسسوری|کیف|کمربند|روسری|شال|زیور/.test(category) ? "اکسسوری" : "لباس";
export const seriesSizesFor = (category: string) => SIZE_OPTIONS[seriesCategoryOf(category)];
const pieces = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const compLabel = (c: Record<string, number>) => Object.entries(c).filter(([, n]) => n > 0).map(([s, n]) => `${s}×${fmtNum(n)}`).join("  ");

/* ================= Manager: define series templates once per owner ================= */
export function SeriesTemplateManager({ ownerId, ownerLabel, readOnly }: { ownerId: string; ownerLabel: string; readOnly?: boolean }) {
  const ops = useOps();
  const mine = ops.seriesTemplates.filter((t) => t.ownerId === ownerId);
  const [edit, setEdit] = useState<SeriesTemplate | null>(null);
  const [error, setError] = useState("");
  const isDemoTpl = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [types, setTypes] = useState<ProductType[]>([]);
  useEffect(() => {
    let live = true;
    productStructureApi.types().then(normalizeProductTypes)
      .then((list) => { if (live) setTypes(list.filter((t) => t.active)); })
      .catch(() => { if (live) setTypes([]); });
    return () => { live = false; };
  }, []);
  const typeOf = (template: SeriesTemplate | null) => types.find((t) => t.id === template?.productTypeId);
  /** Item 9: template sizes come from the Product Type size system — never a fixed list. */
  const sizesFor = (template: SeriesTemplate): { code: string; label: string }[] => {
    const type = typeOf(template);
    if (type) return type.sizes.filter((s) => s.active).map((s) => ({ code: s.code, label: s.label }));
    return SIZE_OPTIONS[template.category ?? "لباس"].map((s) => ({ code: s, label: s }));
  };
  const blank = (): SeriesTemplate => ({ id: `tpl-${ownerId}-${Date.now()}`, ownerId, name: "", category: "لباس", productTypeId: types[0]?.id ?? "", composition: { S: 0, M: 0, L: 0, XL: 0, "2XL": 0 }, defaultMoq: 1, note: "" });
  const save = () => {
    if (!edit) return;
    if (!edit.name.trim()) return setError("نام قالب را وارد کنید.");
    if (!isDemoTpl && !edit.productTypeId) return setError("نوع محصول را انتخاب کنید — سایزها فقط از نوع محصول می‌آیند.");
    if (mine.some((t) => t.id !== edit.id && t.name.trim() === edit.name.trim())) return setError("قالب دیگری با همین نام دارید.");
    if (pieces(edit.composition) < 1) return setError("دست‌کم یک تکه در ترکیب سایز لازم است.");
    if (edit.defaultMoq < 1) return setError("حداقل سفارش پیش‌فرض باید حداقل ۱ سری باشد.");
    ops.upsert("seriesTemplates", { ...edit, name: edit.name.trim() });
    setEdit(null); setError("");
  };
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div><h3 className="text-[16px] font-extrabold">قالب‌های سری {ownerLabel}</h3><p className="mt-1 max-w-[62ch] text-[12.5px] leading-6 text-[var(--kv-muted)]">ترکیب سایز هر سری را یک‌بار تعریف کنید. هنگام تعریف محصول فقط قالب را انتخاب می‌کنید و قیمت و رنگ‌ها را برای همان محصول تعیین می‌کنید.</p></div>
        {!readOnly && <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setError(""); setEdit(blank()); }}>قالب جدید</Btn>}
      </div>
      {mine.length === 0 ? <Empty title="قالب سری ندارید" desc="اولین قالب را بسازید تا در تعریف محصول قابل انتخاب شود." /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {mine.map((t) => (
            <div key={t.id} className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
              <div className="flex items-start justify-between gap-2">
                <div><p className="text-[14px] font-extrabold">{t.name}</p><p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">{typeOf(t)?.name ?? t.category ?? "لباس"} · {fmtNum(pieces(t.composition))} تکه در هر سری · حداقل {fmtNum(t.defaultMoq)} سری</p></div>
                <Layers size={18} className="text-[var(--kv-accent)]" />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">{Object.entries(t.composition).filter(([, n]) => n > 0).map(([s, n]) => <span key={s} className="rounded-md border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 px-2 py-1 text-[11.5px] font-bold tabular-nums">{s} <span className="text-[var(--kv-accent)]">×{fmtNum(n)}</span></span>)}</div>
              {t.note && <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">{t.note}</p>}
              {!readOnly && <div className="mt-3 flex gap-1 border-t border-[var(--kv-line)] pt-3">
                <Btn variant="ghost" size="sm" icon={<Pencil size={13} />} onClick={() => { setError(""); setEdit({ ...t, composition: { ...t.composition } }); }}>ویرایش</Btn>
                <Btn variant="ghost" size="sm" icon={<Copy size={13} />} onClick={() => ops.upsert("seriesTemplates", { ...t, id: `tpl-${ownerId}-${Date.now()}`, name: `${t.name} (کپی)`, composition: { ...t.composition } })}>کپی</Btn>
                <Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => ops.remove("seriesTemplates", t.id)}>حذف</Btn>
              </div>}
            </div>
          ))}
        </div>
      )}
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.name ? `ویرایش ${edit.name}` : "قالب سری جدید"}>
        {edit && (
          <div className="space-y-4">
            <Field label="نام قالب"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="مثلاً سری کامل ۱۲ تایی" /></Field>
            <Field label="نوع محصول" hint="سایزها از سیستم سایز همین نوع محصول می‌آیند">
              <Select
                options={isDemoTpl ? ["بدون نوع (قدیمی)", ...types.map((t) => t.name)] : ["— انتخاب نوع محصول —", ...types.map((t) => t.name)]}
                value={typeOf(edit)?.name ?? (isDemoTpl ? "بدون نوع (قدیمی)" : "— انتخاب نوع محصول —")}
                onChange={(label) => {
                  const found = types.find((t) => t.name === label);
                  const composition = found
                    ? Object.fromEntries(found.sizes.filter((s) => s.active).map((s) => [s.code, edit.composition[s.code] ?? edit.composition[s.label] ?? 0]))
                    : Object.fromEntries(SIZE_OPTIONS[edit.category ?? "لباس"].map((size) => [size, edit.composition[size] ?? 0]));
                  setEdit({ ...edit, productTypeId: found?.id ?? "", composition });
                }}
              />
            </Field>
            {isDemoTpl && !typeOf(edit) && (
              <Field label="دسته‌بندی قدیمی"><Select options={Object.keys(SIZE_OPTIONS)} value={edit.category ?? "لباس"} onChange={(value) => setEdit({ ...edit, category: value as SeriesCategory, composition: Object.fromEntries(SIZE_OPTIONS[value as SeriesCategory].map((size) => [size, 0])) })} /></Field>
            )}
            <div>
              <p className="mb-2 text-[13px] font-semibold text-[var(--kv-ink-2)]">ترکیب سایز در هر سری{typeOf(edit) ? ` — ${typeOf(edit)!.sizes.filter((s) => s.active).length.toLocaleString("fa-IR")} سایز فعال نوع «${typeOf(edit)!.name}»` : ""}</p>
              {!isDemoTpl && !typeOf(edit) ? <p className="rounded-[10px] border border-dashed border-[var(--kv-line-strong)] p-3 text-[12.5px] text-[var(--kv-muted)]">ابتدا نوع محصول را انتخاب کنید تا سایزهای سرور نمایش داده شود.</p> :
              sizesFor(edit).length === 0 ? <p className="text-[12.5px] text-[var(--kv-muted)]">این نوع محصول سایز فعالی ندارد؛ از «ساختار محصولات» سایز اضافه کنید.</p> : (
              <div className="grid grid-cols-2 gap-2">
                {sizesFor(edit).map(({ code, label }) => { const n = edit.composition[code] ?? 0; return (
                  <div key={code} className="flex items-center justify-between rounded-[10px] border border-[var(--kv-line)] px-2 py-1">
                    <b className="min-w-10 text-[12.5px]" title={label !== code ? label : undefined}>{label}</b>
                    <button aria-label={`کاهش ${label}`} onClick={() => setEdit({ ...edit, composition: { ...edit.composition, [code]: Math.max(0, n - 1) } })} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]">−</button>
                    <b className="w-6 text-center tabular-nums">{fmtNum(n)}</b>
                    <button aria-label={`افزایش ${label}`} onClick={() => setEdit({ ...edit, composition: { ...edit.composition, [code]: n + 1 } })} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]">+</button>
                  </div>
                ); })}
              </div>
              )}
              <p className="mt-2 text-[12px] text-[var(--kv-muted)]">جمع: <b className="text-[var(--kv-ink)] tabular-nums">{fmtNum(pieces(edit.composition))} تکه</b></p>
            </div>
            <Field label="حداقل سفارش پیش‌فرض (سری)" hint="هنگام انتخاب قالب در محصول قابل تغییر است"><Input value={String(edit.defaultMoq)} onChange={(v) => setEdit({ ...edit, defaultMoq: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
            <Field label="یادداشت (اختیاری)"><Textarea rows={2} value={edit.note ?? ""} onChange={(v) => setEdit({ ...edit, note: v })} /></Field>
            {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
            <Btn variant="accent" className="w-full" onClick={save} icon={<Check size={15} />}>ذخیره قالب</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Picker: choose templates while defining a product ================= */
export function SeriesTemplatePicker({ ownerId, category, colors, value, onChange, onManage, productTypeId }: {
  ownerId: string; category: string; colors: Colorway[]; value: SeriesDef[]; onChange: (v: SeriesDef[]) => void; onManage?: () => void; productTypeId?: string;
}) {
  const ops = useOps();
  const templates = ops.seriesTemplates.filter((t) => t.ownerId === ownerId
    && (productTypeId ? t.productTypeId === productTypeId : (t.category ?? "لباس") === seriesCategoryOf(category)));
  const idOf = (t: SeriesTemplate) => `from-${t.id}`;
  const toggle = (t: SeriesTemplate) => {
    const exists = value.some((s) => s.id === idOf(t));
    onChange(exists ? value.filter((s) => s.id !== idOf(t)) : [...value, {
      id: idOf(t), name: t.name, composition: { ...t.composition }, pieces: pieces(t.composition),
      moqSeries: t.defaultMoq, pricePerSeries: 0, available: true, colorIds: colors.map((c) => c.id),
    }]);
  };
  const patch = (id: string, p: Partial<SeriesDef>) => onChange(value.map((s) => (s.id === id ? { ...s, ...p } : s)));
  if (!templates.length) return <Empty title={productTypeId ? "برای این نوع محصول قالبی نیست" : "هنوز قالب سری ندارید"} desc={productTypeId ? "در بخش «قالب‌های سری» یک قالب برای همین نوع محصول بسازید." : "ابتدا در بخش «قالب‌های سری» ترکیب‌های پرکاربرد را تعریف کنید."} action={onManage && <Btn variant="accent" size="sm" onClick={onManage}>تعریف قالب سری</Btn>} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2"><p className="text-[13px] font-bold">سری‌های قابل عرضه برای این محصول</p>{onManage && <button onClick={onManage} className="text-[12px] font-bold text-[var(--kv-accent)]">مدیریت قالب‌ها</button>}</div>
      {templates.map((t) => {
        const s = value.find((x) => x.id === idOf(t));
        return (
          <div key={t.id} className={cn("rounded-[14px] border p-4 transition-colors", s ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.04]" : "border-[var(--kv-line)] bg-[var(--kv-surface)]")}>
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" checked={!!s} onChange={() => toggle(t)} className="mt-1 h-4 w-4 accent-[#C1613B]" />
              <span className="flex-1"><b className="text-[13.5px]">{t.name}</b><span className="mt-0.5 block text-[11.5px] text-[var(--kv-muted)] tabular-nums">{fmtNum(pieces(t.composition))} تکه · {compLabel(t.composition)}</span></span>
            </label>
            {s && (
              <div className="mt-3 space-y-3 border-t border-[var(--kv-line)] pt-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="قیمت هر سری (تومان)"><Input value={s.pricePerSeries ? String(s.pricePerSeries) : ""} onChange={(v) => patch(s.id, { pricePerSeries: Number(v.replace(/\D/g, "")) || 0 })} placeholder="مثلاً ۷۴۰۰۰۰۰" /></Field>
                  <Field label="حداقل سفارش (سری)"><Input value={String(s.moqSeries)} onChange={(v) => patch(s.id, { moqSeries: Number(v.replace(/\D/g, "")) || 0 })} /></Field>
                </div>
                <div>
                  <p className="mb-1.5 text-[12px] font-semibold text-[var(--kv-ink-2)]">رنگ‌های قابل سفارش در این سری</p>
                  <div className="flex flex-wrap gap-1.5">{colors.map((c) => { const on = (s.colorIds ?? []).includes(c.id); return (
                    <button key={c.id} aria-pressed={on} onClick={() => patch(s.id, { colorIds: on ? (s.colorIds ?? []).filter((x) => x !== c.id) : [...(s.colorIds ?? []), c.id] })} className={cn("flex min-h-10 items-center gap-1.5 rounded-[9px] border px-2.5 text-[11.5px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}><span className="h-3.5 w-3.5 rounded-full border border-black/15" style={{ background: c.hex }} />{c.name}</button>
                  ); })}</div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                  <span className="text-[var(--kv-muted)]">حداقل خرید: <b className="text-[var(--kv-ink)] tabular-nums">{fmtNum(s.pieces * s.moqSeries)} تکه · {fmtMoney(s.pricePerSeries * s.moqSeries)}</b></span>
                  <span className="flex items-center gap-2">قابل سفارش<Switch on={s.available} onToggle={() => patch(s.id, { available: !s.available })} /></span>
                </div>
                {(!s.pricePerSeries || !s.moqSeries || !(s.colorIds ?? []).length) && <p className="text-[11.5px] text-[var(--kv-danger)]">قیمت، حداقل سفارش و دست‌کم یک رنگ لازم است.</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const seriesComplete = (list: SeriesDef[]) => list.length > 0 && list.some((s) => s.available) && list.every((s) => s.pieces > 0 && s.pricePerSeries > 0 && s.moqSeries > 0 && (s.colorIds?.length ?? 1) > 0);
