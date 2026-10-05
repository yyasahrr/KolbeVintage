import { useEffect, useMemo, useState } from "react";
import { Check, ImagePlus, Loader2, Sparkles, Wand2 } from "lucide-react";
import {
  siteApi, studioApi, mediaSrc, type AdminSection, type ComponentPreset, type FieldDef, type RegistryComponent,
} from "../data/experience-api";
import { filesApi, publicApi } from "../data/api";
import { Btn, Card, Field, Input, Segmented, Select, Switch, Textarea } from "../components/primitives";
import { PersianDatePicker } from "../components/persian-date-picker";
import { cn } from "../utils/cn";

/* Schema-driven section editor (Req 175-181, 211-217, 226-228).
   Every field comes from the component's typed Field Schema; the admin never edits raw JSON keys.
   Simple mode shows content + the few safe style tokens; Advanced adds layout, behaviour, detailed
   tokens and responsive settings. The server re-validates everything on save. */

type F = (m: string) => void;
export type PickerData = {
  errors: string[];
  collections: { code: string; title: string }[]; campaigns: { id: string; name: string }[]; categories: { name: string; slug: string }[];
  vibes: { slug: string; name: string }[]; providers: { code: string; title: string }[]; products: { id: string; name: string }[];
  images: { id: string; title: string; url: string }[]; videos: { id: string; title: string; url: string }[]; pages: { code: string; title: string }[];
};
let pickerCache: Promise<PickerData> | null = null;
export function loadPickers(): Promise<PickerData> {
  if (!pickerCache) {
    const errors: string[]=[];
    const safe = <T,>(p: Promise<T>, fallback: T) => p.catch((e:unknown) => { errors.push(e instanceof Error?e.message:'بارگذاری یکی از فهرست‌های انتخاب انجام نشد'); return fallback; });
    pickerCache = Promise.all([
      safe(studioApi.collections(), { items: [] }), safe(studioApi.festivals(), { items: [] }), safe(siteApi.categories(), { items: [] }), safe(siteApi.vibes(), { items: [] }),
      safe(siteApi.installmentProviders(), { items: [] }), safe(publicApi.get<{ items: { id: string; name: string }[] }>("/products?limit=100"), { items: [] }),
      safe(studioApi.assets({ type: "image" }), { items: [], uploaders: [] }), safe(studioApi.assets({ type: "video" }), { items: [], uploaders: [] }), safe(studioApi.pages(), { items: [], total:0 }),
    ]).then(([c, f, cat, v, prov, prod, img, vid, pages]) => ({
      errors, collections: c.items.map((x) => ({ code: x.code, title: x.title })), campaigns: f.items.map((x) => ({ id: x.id, name: x.name })),
      categories: cat.items.map((x) => ({ name: x.name, slug: x.slug })), vibes: v.items.map((x) => ({ slug: x.slug, name: x.name })),
      providers: prov.items.map((x) => ({ code: x.code, title: x.title })), products: prod.items.map((x) => ({ id: x.id, name: x.name })),
      images: img.items.map((x) => ({ id: x.id, title: x.title, url: x.url })), videos: vid.items.map((x) => ({ id: x.id, title: x.title, url: x.url })),
      pages: pages.items.map((x) => ({ code: x.code, title: x.title })),
    }));
    pickerCache.catch(() => { pickerCache = null; });
    void pickerCache.then(p=>{if(p.errors.length)pickerCache=null;});
  }
  return pickerCache;
}
export const resetPickerCache = () => { pickerCache = null; };

const GROUP_LABEL: Record<FieldDef["group"], string> = { content: "محتوا", data: "داده و اتصال", media: "رسانه", layout: "چیدمان", style: "ظاهر", behavior: "رفتار" };
const STYLE_LABEL: Record<string, string> = {
  background: "پس‌زمینه", foreground: "رنگ متن", border: "حاشیه", radius: "گردی گوشه", shadow: "سایه", padding: "فاصله داخلی", gap: "فاصله اجزا", width: "عرض",
  minHeight: "حداقل ارتفاع", typeScale: "اندازه تایپوگرافی", fontFamily: "فونت", align: "تراز", animation: "انیمیشن ورود", mediaFit: "برش رسانه",
};
const VALUE_LABEL: Record<string, string> = {
  inherit: "پیش‌فرض تم", background: "پس‌زمینه", surface: "سطح", surfaceSecondary: "سطح دوم", primary: "اصلی", accent: "تأکیدی", textPrimary: "متن اصلی", textSecondary: "متن فرعی",
  onPrimary: "روی رنگ اصلی", none: "هیچ", line: "خط نازک", strong: "پررنگ", sm: "کوچک", md: "متوسط", lg: "بزرگ", xl: "خیلی بزرگ", narrow: "باریک", content: "محتوا",
  wide: "عریض", full: "تمام‌عرض", auto: "خودکار", screen: "تمام صفحه", body: "متن (وزیرمتن)", display: "نمایشی", start: "راست", center: "وسط", end: "چپ", fade: "محو",
  rise: "بالا آمدن", zoom: "زوم", cover: "پرکردن", contain: "کامل",
  default:'پیش‌فرض', light:'روشن', dark:'تیره', campaign:'کمپین', static:'ثابت', marquee:'روان', ticker:'خبرخوان', slider:'اسلایدی', rotating:'چرخشی',
  split:'دو ستونه', fullviewport:'تمام صفحه', minimal:'ساده', mosaic:'موزاییکی', editorial:'روایی', cinematic:'سینمایی', video:'ویدیویی', carousel:'چرخشی',
  image:'تصویری', glass:'شفاف', overlay:'روی تصویر', horizontal:'افقی', vertical:'عمودی', compact:'فشرده', luxury:'لوکس', premium:'ویژه',
  sale:'تخفیف‌دار', new:'تازه‌رسیده', wholesale:'عمده', popular:'محبوب', trending:'پرطرفدار', for_you:'برای شما', similar:'مشابه',
  products:'محصولات', categories:'دسته‌ها', vibes:'وایب‌ها', collection:'کالکشن', product:'محصول', manual:'دستی', recommendations:'پیشنهادها', reviews:'دیدگاه‌ها',
  solid:'توپر', outline:'خطی', ghost:'بدون زمینه', link:'پیوند', terra:'آجری', navy:'سرمه‌ای', stone:'سنگی', beige:'بژ',
  slow:'آهسته', normal:'معمولی', fast:'سریع', rtl:'راست به چپ', ltr:'چپ به راست', banner:'بنر', floating:'شناور', grid:'شبکه', masonry:'چیدمان آزاد',
  snapppay:'اسنپ‌پی', digipay:'دیجی‌پی', generic:'عمومی', fade_up:'ورود از پایین', typewriter:'نوشتاری', serif:'نمایشی', sans:'ساده',
};
const vl = (v: string) => VALUE_LABEL[v] ?? v;

export const fieldsOf = (component?: RegistryComponent | null): FieldDef[] => {
  const schema = component?.field_schema as { fields?: FieldDef[] } | undefined;
  return Array.isArray(schema?.fields) ? schema!.fields! : [];
};
const isVisible = (f: FieldDef, payload: Record<string, unknown>, fields: FieldDef[]) =>
  !f.showIf || Object.entries(f.showIf).every(([k, v]) => String(payload[k] ?? fields.find((x) => x.key === k)?.default ?? "") === v);

/** Client-side mirror of the server schema check — instant feedback; the server remains the authority. */
export function clientValidate(fields: FieldDef[], payload: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!isVisible(f, payload, fields)) continue;
    const v = payload[f.key];
    const empty = v === undefined || v === null || v === "";
    if (f.required && empty) { errors[f.key] = "الزامی است"; continue; }
    if (empty) continue;
    if (typeof v === "string" && /<[a-z!/]|javascript:/i.test(v)) errors[f.key] = "HTML یا اسکریپت مجاز نیست";
    else if (f.type === "number" && (Number.isNaN(Number(v)) || (f.min !== undefined && Number(v) < f.min) || (f.max !== undefined && Number(v) > f.max))) errors[f.key] = `باید بین ${f.min ?? "…"} و ${f.max ?? "…"} باشد`;
    else if ((f.type === "media" || f.type === "video") && !/^(https:\/\/|\/api\/v1\/media\/)/.test(String(v))) errors[f.key] = "فقط رسانه کتابخانه یا https";
    else if ((f.type === "text" || f.type === "textarea") && f.max && String(v).length > f.max) errors[f.key] = `حداکثر ${f.max} نویسه`;
  }
  return errors;
}

export function SchemaSectionEditor({ section, component, styleSpec, simpleStyleKeys, flash, onSaved, onCancel }: {
  section: AdminSection; component: RegistryComponent | undefined; styleSpec: Record<string, { values: string[]; simple: boolean }>; simpleStyleKeys: string[];
  flash: F; onSaved: () => void; onCancel: () => void;
}) {
  const fields = useMemo(() => fieldsOf(component), [component]);
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [title, setTitle] = useState(section.title);
  const [payload, setPayload] = useState<Record<string, unknown>>({ ...section.payload });
  const [variant, setVariant] = useState(section.variant ?? component?.variants?.[0] ?? "default");
  const [sectionTheme, setSectionTheme] = useState(section.sectionTheme ?? "inherit");
  const [style, setStyle] = useState<Record<string, string | number>>({ ...(section.styleOverrides ?? {}) });
  const [responsive, setResponsive] = useState<Record<string, unknown>>({ ...(section.responsiveConfig ?? {}) });
  const [pickers, setPickers] = useState<PickerData | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => { void loadPickers().then(setPickers); }, []);

  const errors = clientValidate(fields, payload);
  const hasErrors = Object.keys(errors).length > 0;
  const groups = (Object.keys(GROUP_LABEL) as FieldDef["group"][])
    .map((g) => ({ g, items: fields.filter((f) => f.group === g && (mode === "advanced" || !f.advanced) && isVisible(f, payload, fields)) }))
    .filter((x) => x.items.length);
  const legacyKeys = Object.keys(payload).filter((k) => !fields.some((f) => f.key === k) && ["string", "number", "boolean"].includes(typeof payload[k]));
  const set = (key: string, value: unknown) => setPayload((p) => { const next = { ...p }; if (value === undefined || value === "") delete next[key]; else next[key] = value; return next; });
  const styleKeys = Object.keys(styleSpec).filter((k) => mode === "advanced" || simpleStyleKeys.includes(k));

  const save = async () => {
    setSaving(true); setServerError(null);
    try {
      await studioApi.updateSection(section.id, { title, payload, ...(variant && component?.variants?.includes(variant) ? { variant } : {}) });
      await studioApi.presentation(section.id, { sectionTheme, styleOverrides: Object.fromEntries(Object.entries(style).filter(([, v]) => v !== "" && v !== undefined)),
        responsiveConfig: Object.fromEntries(Object.entries(responsive).filter(([, v]) => v !== undefined && v !== "" && v !== false)) });
      flash("بخش در پیش‌نویس ذخیره شد"); onSaved();
    } catch (e) { setServerError(e instanceof Error ? e.message : "ذخیره نشد"); }
    finally { setSaving(false); }
  };
  const applyPreset = async (preset: ComponentPreset) => {
    try {
      const updated = await studioApi.applyPreset(section.id, preset.code) as { payload: Record<string, unknown>; variant: string; style_overrides: Record<string, string | number>; responsive_config: Record<string, unknown> };
      setPayload(updated.payload); setVariant(updated.variant); setStyle(updated.style_overrides ?? {}); setResponsive(updated.responsive_config ?? {});
      flash(`Preset «${preset.title}» اعمال شد — محتوای شما حفظ شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
  };

  return (
    <div data-testid="schema-editor"><Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px] font-extrabold">ویرایش «{title || component?.title}» <span className="text-[11px] font-normal text-[var(--kv-muted)]">· {component?.title ?? section.componentCode}</span></p>
        <Segmented<"simple" | "advanced"> options={[{ v: "simple", label: "ساده" }, { v: "advanced", label: "پیشرفته" }]} value={mode} onChange={setMode} />
      </div>

      {(component?.presetDefinitions?.length ?? 0) > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-bold"><Sparkles size={13} className="text-[var(--kv-accent)]" />Presetهای آماده</p>
          <div className="kv-no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {component!.presetDefinitions.map((p) => (
              <button key={p.code} onClick={() => applyPreset(p)} aria-pressed={section.preset === p.code}
                className={cn("shrink-0 rounded-[12px] border px-3 py-2 text-right text-[12px] transition-colors hover:border-[var(--kv-accent)]", section.preset === p.code ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.07]" : "border-[var(--kv-line)]")}>
                <b className="block">{p.title}</b><span className="text-[10.5px] text-[var(--kv-muted)]">{p.variant}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="عنوان داخلی"><Input value={title} onChange={setTitle} /></Field>
        <Field label="قالب (Variant)"><Select options={component?.variants?.length ? component.variants : ["default"]} value={variant} onChange={setVariant} /></Field>
        <Field label="تم بخش"><Select options={["inherit", "light", "dark", "campaign"]} value={sectionTheme} onChange={setSectionTheme} /></Field>
      </div>

      {fields.length === 0 && <p className="rounded-[10px] bg-[var(--kv-surface-2)] p-3 text-[12px] text-[var(--kv-muted)]">این کامپوننت Schema تایپ‌شده ندارد؛ فیلدهای ساده موجود قابل ویرایش‌اند.</p>}
      {groups.map(({ g, items }) => (
        <fieldset key={g} className="rounded-[14px] border border-[var(--kv-line)] p-3">
          <legend className="px-1.5 text-[12px] font-extrabold">{GROUP_LABEL[g]}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map((f) => (
              <div key={f.key} className={cn((f.type === "textarea" || f.type === "lines") && "sm:col-span-2")}>
                <FieldInput field={f} value={payload[f.key]} onChange={(v) => set(f.key, v)} pickers={pickers} flash={flash} />
                {errors[f.key] ? <p role="alert" className="mt-1 text-[11px] text-[var(--kv-danger)]">{errors[f.key]}</p>
                  : f.hint ? <p className="mt-1 text-[10.5px] text-[var(--kv-muted)]">{f.hint}</p> : null}
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      {mode === "advanced" && legacyKeys.length > 0 && (
        <fieldset className="rounded-[14px] border border-dashed border-[var(--kv-line)] p-3">
          <legend className="px-1.5 text-[12px] font-extrabold">فیلدهای قدیمی (خارج از Schema)</legend>
          <div className="grid gap-3 sm:grid-cols-2">{legacyKeys.map((k) => (
            <Field key={k} label={k}>{typeof payload[k] === "boolean" ? <Switch on={payload[k] as boolean} onToggle={() => set(k, !payload[k])} /> : <Input value={String(payload[k])} onChange={(v) => set(k, v)} />}</Field>
          ))}</div>
        </fieldset>
      )}

      <fieldset className="rounded-[14px] border border-[var(--kv-line)] p-3">
        <legend className="px-1.5 text-[12px] font-extrabold">ظاهر (فقط توکن‌های سیستم طراحی)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {styleKeys.map((k) => (
            <Field key={k} label={STYLE_LABEL[k] ?? k}>
              <Select options={["پیش‌فرض", ...styleSpec[k]!.values.map(vl)]} value={style[k] ? vl(String(style[k])) : "پیش‌فرض"}
                onChange={(l) => { const v = styleSpec[k]!.values.find((x) => vl(x) === l); setStyle((s) => { const n = { ...s }; if (v) n[k] = v; else delete n[k]; return n; }); }} />
            </Field>
          ))}
          {mode === "advanced" && <Field label="تیرگی لایه روی تصویر (٪)"><Input value={String(style.overlay ?? "")} onChange={(v) => setStyle((s) => { const n = { ...s }; if (v === "") delete n.overlay; else n.overlay = Math.min(90, Math.max(0, Number(v.replace(/\D/g, "")) || 0)); return n; })} /></Field>}
        </div>
      </fieldset>

      <fieldset className="rounded-[14px] border border-[var(--kv-line)] p-3">
        <legend className="px-1.5 text-[12px] font-extrabold">واکنش‌گرا (Responsive)</legend>
        <div className="flex flex-wrap gap-4 text-[12.5px]">
          {([["hideOnMobile", "پنهان در موبایل"], ["hideOnTablet", "پنهان در تبلت"], ["hideOnDesktop", "پنهان در دسکتاپ"]] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><Switch on={Boolean(responsive[k])} onToggle={() => setResponsive((r) => ({ ...r, [k]: !r[k] }))} />{l}</label>
          ))}
        </div>
        {mode === "advanced" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="ستون موبایل"><Select options={["خودکار", "1", "2", "3"]} value={String(responsive.mobileColumns ?? "خودکار")} onChange={(v) => setResponsive((r) => ({ ...r, mobileColumns: v === "خودکار" ? undefined : Number(v) }))} /></Field>
            <Field label="ستون تبلت"><Select options={["خودکار", "1", "2", "3", "4"]} value={String(responsive.tabletColumns ?? "خودکار")} onChange={(v) => setResponsive((r) => ({ ...r, tabletColumns: v === "خودکار" ? undefined : Number(v) }))} /></Field>
            <Field label="تراز موبایل"><Select options={["خودکار", "start", "center", "end"]} value={String(responsive.mobileAlign ?? "خودکار")} onChange={(v) => setResponsive((r) => ({ ...r, mobileAlign: v === "خودکار" ? undefined : v }))} /></Field>
            <Field label="تایپ موبایل"><Select options={["خودکار", "sm", "md", "lg"]} value={String(responsive.mobileTypeScale ?? "خودکار")} onChange={(v) => setResponsive((r) => ({ ...r, mobileTypeScale: v === "خودکار" ? undefined : v }))} /></Field>
          </div>
        )}
      </fieldset>

      {serverError && <p role="alert" className="rounded-[10px] bg-[var(--kv-danger)]/10 p-3 text-[12px] text-[var(--kv-danger)]">{serverError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="accent" size="sm" disabled={saving || hasErrors} onClick={save} icon={saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}>ذخیره در پیش‌نویس</Btn>
        <Btn variant="ghost" size="sm" onClick={onCancel}>انصراف</Btn>
        {hasErrors && <span className="text-[11.5px] text-[var(--kv-danger)]">{Object.keys(errors).length} فیلد نیاز به اصلاح دارد</span>}
      </div>
    </Card></div>
  );
}

export function FieldInput({ field: f, value, onChange, pickers, flash }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; pickers: PickerData | null; flash: F }) {
  const label = `${f.label}${f.required ? " *" : ""}`;
  const str = value === undefined || value === null ? "" : String(value);
  const none = "— انتخاب نشده —";
  const pick = (opts: { v: string; l: string }[]) => (
    <Select options={[none, ...opts.map((o) => o.l)]} value={opts.find((o) => o.v === str)?.l ?? (str ? "مرجع در دسترس نیست" : none)} onChange={(l) => onChange(opts.find((o) => o.l === l)?.v)} />
  );
  switch (f.type) {
    case "boolean": return <Field label={label}><Switch on={value === undefined ? Boolean(f.default) : Boolean(value)} onToggle={() => onChange(!(value === undefined ? Boolean(f.default) : Boolean(value)))} /></Field>;
    case "number": return <Field label={label}><Input value={str} onChange={(v) => onChange(v === "" ? undefined : Number(v.replace(/[^\d.-]/g, "")))} placeholder={f.default !== undefined ? String(f.default) : ""} /></Field>;
    case "textarea": return <Field label={label}><Textarea rows={3} value={str} onChange={onChange} /></Field>;
    case "lines": return <Field label={label}><Textarea rows={4} value={str} onChange={onChange} placeholder="هر مورد در یک خط؛ بخش‌ها با | جدا شوند" /></Field>;
    case "select": { const opts=(f.options??[]).map((v,i)=>({value:v,label:VALUE_LABEL[v]??(/^[\u0600-\u06ff\s\d]+$/.test(v)?v:`گزینه ${i+1}`)})); return <Field label={label}><Select options={opts.map(o=>o.label)} value={opts.find(o=>o.value===(str||String(f.default??f.options?.[0]??'')))?.label??'انتخاب کنید'} onChange={v=>onChange(opts.find(o=>o.label===v)?.value)}/></Field>; }
    case "color": return (
      <Field label={label}><div className="flex items-center gap-2">
        <Select options={["inherit", "background", "surface", "primary", "accent", "textPrimary", "textSecondary", "onPrimary", "سفارشی (hex)"]} value={str.startsWith("#") ? "سفارشی (hex)" : str || "inherit"} onChange={(v) => onChange(v === "سفارشی (hex)" ? "#1B2A4A" : v)} />
        {str.startsWith("#") && <input type="color" aria-label={f.label} value={str.length === 7 ? str : "#1B2A4A"} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 rounded border border-[var(--kv-line)]" />}
      </div></Field>
    );
    case "datetime": return <PersianDatePicker label={label} withTime value={str || null} onChange={(v) => onChange(v ?? undefined)} />;
    case "collection": return <Field label={label}>{pick((pickers?.collections ?? []).map((c) => ({ v: c.code, l: c.title })))}</Field>;
    case "campaign": return <Field label={label}>{pick((pickers?.campaigns ?? []).map((c) => ({ v: c.id, l: c.name })))}</Field>;
    case "category": return <Field label={label}>{pick((pickers?.categories ?? []).map((c) => ({ v: f.key.toLowerCase().includes("slug") ? c.slug : c.name, l: c.name })))}</Field>;
    case "vibe": return <Field label={label}>{pick((pickers?.vibes ?? []).map((c) => ({ v: c.slug, l: c.name })))}</Field>;
    case "installment_provider": return <Field label={label}>{pick((pickers?.providers ?? []).map((c) => ({ v: c.code, l: c.title })))}</Field>;
    case "product": return <Field label={label}>{pick((pickers?.products ?? []).map((c) => ({ v: c.id, l: c.name })))}</Field>;
    case "target": return <TargetInput label={label} value={str} onChange={onChange} pickers={pickers} />;
    case "media": case "video": return <MediaInput label={label} kind={f.type} value={str} onChange={onChange} pickers={pickers} flash={flash} />;
    default: return <Field label={label}><Input value={str} onChange={onChange} /></Field>;
  }
}

const STATIC_TARGETS = [{ v: "shop", l: "فروشگاه" }, { v: "home", l: "خانه" }, { v: "vip", l: "باشگاه VIP" }, { v: "about", l: "درباره ما" }, { v: "tryon", l: "اتاق پرو" }, { v: "journal", l: "ژورنال" }, { v: "account", l: "حساب کاربری" }];
export function TargetInput({ label, value, onChange, pickers }: { label: string; value: string; onChange: (v: unknown) => void; pickers: PickerData | null }) {
  const kind = value.startsWith("https://") ? "url" : value.includes(":") ? value.split(":")[0]! : value ? "static" : "static";
  const kinds = [{ v: "static", l: "صفحه ثابت" }, { v: "page", l: "صفحه CMS" }, { v: "vibe", l: "وایب" }, { v: "collection", l: "کالکشن" }, { v: "category", l: "دسته" }, { v: "product", l: "محصول" }, { v: "url", l: "لینک https" }];
  const sub: Record<string, { v: string; l: string }[]> = {
    static: STATIC_TARGETS, page: (pickers?.pages ?? []).map((p) => ({ v: `page:${p.code}`, l: p.title })), vibe: (pickers?.vibes ?? []).map((p) => ({ v: `vibe:${p.slug}`, l: p.name })),
    collection: (pickers?.collections ?? []).map((p) => ({ v: `collection:${p.code}`, l: p.title })), category: (pickers?.categories ?? []).map((p) => ({ v: `category:${p.name}`, l: p.name })),
    product: (pickers?.products ?? []).map((p) => ({ v: `product:${p.id}`, l: p.name })),
  };
  return (
    <Field label={label}>
      <div className="grid grid-cols-[120px_1fr] gap-2">
        <Select options={kinds.map((k) => k.l)} value={kinds.find((k) => k.v === kind)?.l ?? "صفحه ثابت"} onChange={(l) => { const k = kinds.find((x) => x.l === l)?.v ?? "static"; onChange(k === "url" ? "https://" : sub[k]?.[0]?.v); }} />
        {kind === "url" ? <Input value={value} onChange={onChange} placeholder="https://…" />
          : <Select options={(sub[kind] ?? []).map((o) => o.l)} value={(sub[kind] ?? []).find((o) => o.v === value)?.l ?? (sub[kind]?.[0]?.l ?? "")} onChange={(l) => onChange((sub[kind] ?? []).find((o) => o.l === l)?.v)} />}
      </div>
    </Field>
  );
}

export function MediaInput({ label, kind, value, onChange, pickers, flash }: { label: string; kind: "media" | "video"; value: string; onChange: (v: unknown) => void; pickers: PickerData | null; flash: F }) {
  const [busy, setBusy] = useState(false);
  const library = kind === "video" ? pickers?.videos ?? [] : pickers?.images ?? [];
  const upload = async (file: File) => {
    const okTypes = kind === "video" ? ["video/mp4", "video/webm"] : ["image/jpeg", "image/png", "image/webp", "image/avif"];
    if (!okTypes.includes(file.type)) { flash(kind === "video" ? "فقط ویدیوی MP4/WebM" : "فقط تصویر JPG/PNG/WebP/AVIF"); return; }
    setBusy(true);
    try {
      const uploaded = await filesApi.upload(file);
      const asset = await studioApi.createAsset({ fileId: uploaded.id, title: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 150) || "رسانه", assetType: kind === "video" ? "video" : "image", folder: "sections" });
      onChange(asset.url); resetPickerCache(); flash("رسانه بارگذاری و در کتابخانه ثبت شد (پردازش نسخه‌های واکنش‌گرا در صف است)");
    } catch (e) { flash(e instanceof Error ? e.message : "بارگذاری ناموفق بود"); }
    finally { setBusy(false); }
  };
  return (
    <Field label={label}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Select options={["— از کتابخانه —", ...library.map((a) => a.title)]} value={library.find((a) => a.url === value)?.title ?? "— از کتابخانه —"} onChange={(l) => { const a = library.find((x) => x.title === l); if (a) onChange(a.url); }} />
          <label className={cn("inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-[var(--kv-line)] px-3 text-[12px] font-bold hover:bg-[var(--kv-surface-2)]", busy && "pointer-events-none opacity-60")}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}بارگذاری
            <input type="file" className="sr-only" accept={kind === "video" ? "video/mp4,video/webm" : "image/jpeg,image/png,image/webp,image/avif"} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
          </label>
        </div>
        <Input value={value} onChange={onChange} placeholder="یا نشانی https:// / ‎/api/v1/media/…" />
        {value && kind === "media" && /^(https:\/\/|\/api\/v1\/media\/)/.test(value) && <img src={mediaSrc(value)} alt="" className="h-20 w-32 rounded-[8px] object-cover" />}
      </div>
    </Field>
  );
}

/** Preset picker used when adding a new section (Req 180): start from a curated preset instead of an empty block. */
export function PresetPicker({ component, value, onChange }: { component: RegistryComponent | undefined; value: string; onChange: (code: string) => void }) {
  if (!component?.presetDefinitions?.length) return null;
  return (
    <Field label="شروع از Preset">
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => onChange("")} aria-pressed={!value} className={cn("rounded-full border px-3 py-1.5 text-[11.5px]", !value ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 font-bold" : "border-[var(--kv-line)]")}>پیش‌فرض</button>
        {component.presetDefinitions.map((p) => (
          <button key={p.code} onClick={() => onChange(p.code)} aria-pressed={value === p.code} className={cn("inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-[11.5px]", value === p.code ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 font-bold" : "border-[var(--kv-line)]")}><Wand2 size={11} />{p.title}</button>
        ))}
      </div>
    </Field>
  );
}
