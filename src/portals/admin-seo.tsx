import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Loader2, Search } from "lucide-react";
import { seoApi, mediaSrc, type ResolvedSeo, type SeoEntityType, type SeoListItem, type SeoWrite } from "../data/experience-api";
import { formatPersianDateTime } from "../data/persian-date";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Segmented, Select, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";

/* SEO Domain console (Req 235). Pages, categories, vibes, collections and products are *connected* to the
   SEO Domain; this panel is its only editor. Everything is validated and resolved by the server — the
   previews below show exactly what the storefront will emit. */

type F = (m: string) => void;
const TYPES: { v: SeoEntityType; label: string }[] = [
  { v: "page", label: "صفحات" }, { v: "category", label: "دسته‌ها" }, { v: "vibe", label: "وایب‌ها" }, { v: "collection", label: "کالکشن‌ها" }, { v: "product", label: "محصولات" },
];
const SCHEMA_OPTIONS = ["پیش‌فرض خودکار", "WebPage", "AboutPage", "ContactPage", "CollectionPage", "ItemPage", "Product", "Organization"];
const HEALTH: Record<SeoListItem["health"], { label: string; cls: string }> = {
  good: { label: "خوب", cls: "bg-emerald-500" }, fair: { label: "قابل بهبود", cls: "bg-amber-500" }, poor: { label: "ضعیف", cls: "bg-rose-500" },
};
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "خطا");
const len = (s: string) => [...s].length;

type Form = {
  title: string; description: string; canonicalPath: string; robotsIndex: boolean; robotsFollow: boolean;
  ogTitle: string; ogDescription: string; ogImage: string; twitterCard: "summary" | "summary_large_image"; schemaType: string; schemaExtra: string;
};

const toWrite = (f: Form): SeoWrite | string => {
  let schemaExtra: Record<string, unknown> = {};
  if (f.schemaExtra.trim()) {
    try {
      const parsed = JSON.parse(f.schemaExtra) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "داده Schema باید یک شیء JSON باشد.";
      schemaExtra = parsed as Record<string, unknown>;
    } catch { return "داده Schema یک JSON معتبر نیست."; }
  }
  return {
    title: f.title || null, description: f.description || null, canonicalPath: f.canonicalPath || null, robotsIndex: f.robotsIndex, robotsFollow: f.robotsFollow,
    ogTitle: f.ogTitle || null, ogDescription: f.ogDescription || null, ogImage: f.ogImage || null, twitterCard: f.twitterCard,
    schemaType: f.schemaType === SCHEMA_OPTIONS[0] ? null : f.schemaType, schemaExtra,
  };
};

export function SeoDomainPanel({ flash, initialType = "page" }: { flash: F; initialType?: SeoEntityType }) {
  const [type, setType] = useState<SeoEntityType>(initialType);
  const [items, setItems] = useState<SeoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null); setItems(null);
    try { setItems((await seoApi.list(type)).items); } catch (e) { setError(errMsg(e)); }
  }, [type]);
  useEffect(() => { setSelected(null); void load(); }, [load]);
  const visible = useMemo(() => (items ?? []).filter((i) => !q.trim() || i.name.includes(q.trim()) || i.key.includes(q.trim())), [items, q]);
  const stats = useMemo(() => ({ total: items?.length ?? 0, poor: items?.filter((i) => i.health === "poor").length ?? 0, noindex: items?.filter((i) => !i.index).length ?? 0 }), [items]);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <p className="text-[14px] font-extrabold">دامنه سئو</p>
          <p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">عنوان، توضیح، Canonical، Schema، شبکه‌های اجتماعی و ایندکس هر صفحه/دسته/وایب/کالکشن/محصول فقط اینجا مدیریت می‌شود.</p>
        </div>
        <div className="flex gap-2 text-[12px]">
          <span className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1">{stats.total.toLocaleString("fa-IR")} مورد</span>
          <span className="rounded-full bg-rose-500/10 px-3 py-1 text-rose-600">{stats.poor.toLocaleString("fa-IR")} ضعیف</span>
          <span className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1">{stats.noindex.toLocaleString("fa-IR")} noindex</span>
        </div>
      </Card>
      <div className="flex flex-wrap items-center gap-2">
        <div className="kv-no-scrollbar max-w-full overflow-x-auto"><Segmented options={TYPES} value={type} onChange={setType} /></div>
        <div className="min-w-[200px] flex-1"><Input value={q} onChange={setQ} placeholder="جست‌وجو با نام یا شناسه…" icon={<Search size={15} />} /></div>
      </div>
      {error && <ErrorState message={error} onRetry={load} />}
      {!items && !error && <LoadingState />}
      {items && (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
          <ul className="max-h-[70vh] space-y-1.5 overflow-y-auto pl-1" aria-label="موجودیت‌ها">
            {visible.length === 0 && <Empty title="موردی یافت نشد" desc="نوع دیگری را انتخاب کنید." />}
            {visible.map((i) => (
              <li key={i.key}>
                <button onClick={() => setSelected(i.key)} aria-current={selected === i.key}
                  className={cn("flex w-full items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-right", selected === i.key ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)] hover:bg-[var(--kv-surface-2)]")}>
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", HEALTH[i.health].cls)} title={HEALTH[i.health].label} aria-label={`سلامت سئو: ${HEALTH[i.health].label}`} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-bold">{i.name}</span><span className="block truncate text-[11px] text-[var(--kv-muted)]" dir="ltr">{i.key}</span></span>
                  {!i.index && <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px]">noindex</span>}
                  {!i.active && <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10.5px] text-[var(--kv-muted)]">غیرفعال</span>}
                </button>
              </li>
            ))}
          </ul>
          {selected ? <SeoEditor key={`${type}:${selected}`} type={type} entityKey={selected} flash={flash} onSaved={load} />
            : <Empty title="یک مورد را انتخاب کنید" desc="پیش‌نمایش گوگل و شبکه‌های اجتماعی و داده ساختاریافته نمایش داده می‌شود." />}
        </div>
      )}
    </div>
  );
}

export function SeoEditor({ type, entityKey, flash, onSaved }: { type: SeoEntityType; entityKey: string; flash: F; onSaved?: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof seoApi.detail>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [preview, setPreview] = useState<{ resolved: ResolvedSeo; check: { errors: string[]; warnings: string[] } } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await seoApi.detail(type, entityKey);
      setData(d);
      const e = d.entry;
      setForm({
        title: e?.title ?? "", description: e?.description ?? "", canonicalPath: e?.canonical_path ?? "", robotsIndex: e?.robots_index ?? true, robotsFollow: e?.robots_follow ?? true,
        ogTitle: e?.og_title ?? "", ogDescription: e?.og_description ?? "", ogImage: e?.og_image ?? "", twitterCard: e?.twitter_card ?? "summary_large_image",
        schemaType: e?.schema_type ?? SCHEMA_OPTIONS[0]!, schemaExtra: e && Object.keys(e.schema_extra ?? {}).length ? JSON.stringify(e.schema_extra, null, 2) : "",
      });
      setPreview({ resolved: d.resolved, check: d.check });
    } catch (err) { setError(errMsg(err)); }
  }, [type, entityKey]);
  useEffect(() => { void load(); }, [load]);

  // Live server-side preview (debounced): the same resolver the storefront uses.
  useEffect(() => {
    if (!form || !data) return;
    const write = toWrite(form);
    if (typeof write === "string") { setLocalError(write); return; }
    setLocalError(null);
    const t = window.setTimeout(() => { seoApi.preview(type, entityKey, write).then(setPreview).catch(() => undefined); }, 350);
    return () => window.clearTimeout(t);
  }, [form, data, type, entityKey]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data || !form) return <LoadingState />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const r = preview?.resolved ?? data.resolved;
  const check = preview?.check ?? data.check;
  const save = async () => {
    const write = toWrite(form);
    if (typeof write === "string") { setLocalError(write); return; }
    setSaving(true);
    try {
      const res = await seoApi.save(type, entityKey, { ...write, ...(data.entry ? { expectedVersion: data.entry.version } : {}) });
      flash(res.warnings.length ? `ذخیره شد (نسخه ${res.version.toLocaleString("fa-IR")}) · ${res.warnings.length.toLocaleString("fa-IR")} پیشنهاد بهبود` : `تنظیمات سئو ذخیره شد (نسخه ${res.version.toLocaleString("fa-IR")})`);
      await load(); onSaved?.();
    } catch (e) { flash(errMsg(e)); } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-[14px] font-extrabold">{data.subject.name}</p><p className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{data.subject.path}</p></div>
          <span className={cn("rounded-full px-3 py-1 text-[11.5px] font-bold", r.source === "seo_domain" ? "bg-emerald-500/10 text-emerald-700" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
            {r.source === "seo_domain" ? `دامنه سئو · نسخه ${(r.version ?? 0).toLocaleString("fa-IR")}` : "مشتق‌شده خودکار از داده موجودیت"}
          </span>
        </div>
        <Field label={`عنوان سئو (${len(form.title).toLocaleString("fa-IR")}/۶۵)`} hint={`خالی = «${data.subject.name}»`}><Input value={form.title} onChange={(v) => set("title", v)} placeholder={data.subject.name} /></Field>
        <Field label={`توضیح متا (${len(form.description).toLocaleString("fa-IR")}/۱۶۰)`}><Textarea rows={3} value={form.description} onChange={(v) => set("description", v)} placeholder={data.subject.description || "توضیح کوتاه و جذاب برای نتایج جست‌وجو"} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Canonical" hint="مسیر نسبی (مثلاً /vibe/old-money) یا آدرس https"><Input value={form.canonicalPath} onChange={(v) => set("canonicalPath", v.trim())} placeholder={data.subject.path} /></Field>
          <div className="flex items-end gap-5 pb-2">
            <label className="flex items-center gap-2 text-[12.5px] font-semibold"><Switch on={form.robotsIndex} onToggle={() => set("robotsIndex", !form.robotsIndex)} /> ایندکس شود</label>
            <label className="flex items-center gap-2 text-[12.5px] font-semibold"><Switch on={form.robotsFollow} onToggle={() => set("robotsFollow", !form.robotsFollow)} /> دنبال‌کردن لینک‌ها</label>
          </div>
        </div>
        {!data.subject.active && <p className="rounded-[10px] bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800">این موجودیت منتشر/فعال نیست؛ تا زمان انتشار همیشه noindex خواهد بود.</p>}
      </Card>

      <Card className="space-y-3 p-4">
        <p className="text-[13px] font-extrabold">شبکه‌های اجتماعی</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="عنوان Open Graph"><Input value={form.ogTitle} onChange={(v) => set("ogTitle", v)} placeholder="پیش‌فرض: عنوان سئو" /></Field>
          <Field label="کارت توییتر"><Select options={["تصویر بزرگ", "خلاصه"]} value={form.twitterCard === "summary" ? "خلاصه" : "تصویر بزرگ"} onChange={(v) => set("twitterCard", v === "خلاصه" ? "summary" : "summary_large_image")} /></Field>
        </div>
        <Field label="توضیح Open Graph"><Textarea rows={2} value={form.ogDescription} onChange={(v) => set("ogDescription", v)} placeholder="پیش‌فرض: توضیح متا" /></Field>
        <Field label="تصویر اشتراک‌گذاری" hint="آدرس رسانه کلبه (/api/v1/media/…) یا https"><Input value={form.ogImage} onChange={(v) => set("ogImage", v.trim())} placeholder={data.subject.image ?? "/api/v1/media/…"} /></Field>
      </Card>

      <Card className="space-y-3 p-4">
        <p className="text-[13px] font-extrabold">داده ساختاریافته (Schema.org)</p>
        <Field label="نوع Schema"><Select options={SCHEMA_OPTIONS} value={form.schemaType} onChange={(v) => set("schemaType", v)} /></Field>
        <Field label="فیلدهای تکمیلی (JSON)" hint='مثلاً {"keywords": "پالتو پشمی، کت زمستانی"} — @context و @type توسط سرور تعیین می‌شود'><Textarea rows={4} value={form.schemaExtra} onChange={(v) => set("schemaExtra", v)} placeholder="{}" /></Field>
      </Card>

      {(localError || check.errors.length > 0 || check.warnings.length > 0) && (
        <Card className="space-y-1.5 p-4" >
          <p className="text-[13px] font-extrabold">بررسی سلامت</p>
          {localError && <p role="alert" className="text-[12.5px] text-[var(--kv-danger)]">• {localError}</p>}
          {check.errors.map((e) => <p key={e} role="alert" className="text-[12.5px] text-[var(--kv-danger)]">• {e}</p>)}
          {check.warnings.map((w) => <p key={w} className="text-[12.5px] text-amber-700">• {w}</p>)}
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-[12px] font-bold text-[var(--kv-muted)]">پیش‌نمایش نتیجه گوگل</p>
          <div className="rounded-[12px] bg-white p-4 text-left dark:bg-[#1f2330]" dir="auto">
            <p className="truncate text-[12px] text-[#188038]" dir="ltr">{r.canonical}</p>
            <p className="mt-1 line-clamp-1 text-[18px] leading-7 text-[#1a0dab] dark:text-[#8ab4f8]" dir="rtl">{r.title}</p>
            <p className="mt-1 line-clamp-2 text-[13px] leading-6 text-[#4d5156] dark:text-[#bdc1c6]" dir="rtl">{r.description}</p>
            {!r.index && <p className="mt-2 text-[11.5px] font-bold text-rose-600" dir="rtl">در نتایج جست‌وجو نمایش داده نمی‌شود ({r.robots})</p>}
          </div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-[12px] font-bold text-[var(--kv-muted)]">پیش‌نمایش اشتراک‌گذاری</p>
          <div className="overflow-hidden rounded-[12px] border border-[var(--kv-line)]">
            <div className="aspect-[1.91/1] bg-[var(--kv-surface-2)]">{r.og.image ? <img src={mediaSrc(r.og.image.replace(/^https?:\/\/[^/]+(?=\/api\/)/, ""))} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-[12px] text-[var(--kv-muted)]">بدون تصویر</div>}</div>
            <div className="p-3"><p className="truncate text-[11px] uppercase text-[var(--kv-muted)]" dir="ltr">{r.og.url.replace(/^https?:\/\//, "").split("/")[0]}</p><p className="mt-0.5 line-clamp-1 text-[13.5px] font-bold">{r.og.title}</p><p className="line-clamp-2 text-[12px] text-[var(--kv-muted)]">{r.og.description}</p></div>
          </div>
        </Card>
      </div>
      <Card className="p-4">
        <p className="mb-2 text-[12px] font-bold text-[var(--kv-muted)]">JSON-LD خروجی</p>
        <pre className="max-h-[260px] overflow-auto rounded-[10px] bg-[var(--kv-surface-2)] p-3 text-left text-[11px] leading-5" dir="ltr">{JSON.stringify(r.jsonLd, null, 2)}</pre>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Btn variant="accent" onClick={save} disabled={saving || Boolean(localError) || check.errors.length > 0} icon={saving ? <Loader2 size={14} className="animate-spin" /> : undefined}>ذخیره در دامنه سئو</Btn>
        {data.history.length > 0 && <span className="flex items-center gap-1.5 text-[12px] text-[var(--kv-muted)]"><History size={13} /> {data.history.length.toLocaleString("fa-IR")} نسخه · آخرین تغییر {formatPersianDateTime(data.history[0]!.created_at)}</span>}
      </div>
    </div>
  );
}

/** Entry point from CMS screens: the entity stays in the CMS, its SEO opens in the SEO Domain editor. */
export function SeoLinkButton({ type, entityKey, name, flash }: { type: SeoEntityType; entityKey: string; name: string; flash: F }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn size="sm" variant="ghost" onClick={() => setOpen(true)}>سئو</Btn>
      <Drawer open={open} onClose={() => setOpen(false)} title={`سئو · ${name}`} wide>
        {open && <SeoEditor type={type} entityKey={entityKey} flash={flash} />}
      </Drawer>
    </>
  );
}
