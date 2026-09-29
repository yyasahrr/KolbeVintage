import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Headset, Image as ImageIcon, LayoutTemplate, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useStore } from "../data/store";
import { BlockRenderer, HeroRenderer } from "../components/cms-render";
import type { CmsBlock, HeroConfig } from "../data/ops";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Segmented, Select, Switch, Textarea } from "../components/primitives";
import { cmsApi, filesApi, publicApi } from "../data/api";
import { CmsPanel } from "../components/cms-panel";
import { cn } from "../utils/cn";

type F = (m: string) => void;

/* Canonical CMS editor — every published field lives in PostgreSQL through the CMS API.
   Local state is only used for the draft form and the live preview (never for published content). */

type Section = { id: string; pageId: string; componentCode: string; title: string; payload: Record<string, unknown>; visible: boolean; position: number };
type Page = { id: string; code: string; title: string; path: string };

const BLOCK_LIBRARY: { code: string; label: string; desc: string; payload: Record<string, unknown> }[] = [
  { code: "banner", label: "بنر تبلیغاتی", desc: "تصویر، تیتر و دکمه", payload: { title: "تیتر بنر", text: "توضیح کوتاه", cta: "مشاهده", target: "shop" } },
  { code: "text_image", label: "متن و تصویر", desc: "متن کنار تصویر", payload: { title: "تیتر", text: "متن" } },
  { code: "promotional", label: "بخش تبلیغاتی", desc: "پیشنهاد محدود", payload: { title: "پیشنهاد محدود", text: "تا پایان زمان", cta: "مشاهده", target: "shop" } },
  { code: "product_slider", label: "اسلایدر محصولات", desc: "محصولات یک دسته", payload: { title: "منتخب کلبه", category: "همه", count: 4 } },
  { code: "category_section", label: "بخش دسته‌بندی", desc: "ورود به دسته‌ها", payload: { title: "دسته‌بندی‌ها" } },
  { code: "faq", label: "پرسش‌های متداول", desc: "پرسش و پاسخ", payload: { title: "پرسش‌های پرتکرار", items: "پرسش؟|پاسخ" } },
  { code: "cta", label: "دکمه اقدام", desc: "فراخوان کلیک", payload: { title: "همین حالا خرید کنید", cta: "ورود به فروشگاه", target: "shop" } },
  { code: "blog_section", label: "بخش مقالات", desc: "آخرین مطالب مجله", payload: { title: "از مجله کلبه" } },
  { code: "brand_section", label: "بخش برندها", desc: "معرفی برندها", payload: { title: "برندهای کلبه" } },
];

const HERO_TEMPLATES: HeroConfig["template"][] = ["split", "fullbleed", "video", "carousel", "minimal", "mosaic"];
/** Persian labels for the hero templates (the stored value stays the English template code). */
const HERO_TEMPLATE_LABEL: Record<HeroConfig["template"], string> = {
  split: "دو ستونه", fullbleed: "تمام‌عرض", video: "ویدیویی", carousel: "اسلایدری", minimal: "مینیمال", mosaic: "موزاییک",
};
const TARGETS = [{ v: "shop", l: "فروشگاه" }, { v: "vip", l: "بازارچه عمده" }, { v: "tryon", l: "پرو مجازی" }, { v: "journal", l: "مجله" }] as const;

const defaultHero = (): HeroConfig => ({
  template: "split", eyebrow: "", title: "", subtitle: "", ctaLabel: "ورود به فروشگاه", ctaTarget: "shop",
  secondaryLabel: "", secondaryTarget: "vip", image: "", video: "", poster: "", overlay: 35, align: "right",
  slides: [{ image: "", title: "", subtitle: "" }], mosaic: ["", "", "", ""],
});

/** Uploads media through the File Storage domain; published CMS keeps only the returned URL/file id. */
async function uploadMedia(file: File, flash: F): Promise<string | null> {
  if (file.size > 10 * 1024 * 1024) { flash("حجم فایل باید کمتر از ۱۰ مگابایت باشد"); return null; }
  try {
    const uploaded = await filesApi.upload(file);   // multipart; browser sets the boundary
    return uploaded.id;
  } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری فایل"); return null; }
}

function MediaField({ label, value, onChange, kind, flash }: { label: string; value: string; onChange: (v: string) => void; kind: "image" | "video"; flash: F }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const shown = value ? (value.startsWith("http") ? value : `/api/v1/files/${value}`) : "";
  return (
    <Field label={label}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input className="flex-1" value={value} onChange={onChange} placeholder="نشانی رسانه یا شناسه فایل سرور" />
          <input ref={ref} type="file" accept={kind === "image" ? "image/*" : "video/mp4,video/webm"} className="sr-only" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            const id = await uploadMedia(file, flash);
            setBusy(false);
            if (id) { onChange(id); flash("فایل روی سرور ذخیره شد"); }
          }} />
          <Btn variant="soft" disabled={busy} icon={<Upload size={15} />} onClick={() => ref.current?.click()}>{busy ? "در حال بارگذاری…" : "بارگذاری"}</Btn>
        </div>
        {shown && kind === "image" && <img src={shown} alt="" className="h-24 w-20 rounded-[10px] object-cover" />}
        {shown && kind === "video" && <video src={shown} controls muted className="max-h-40 rounded-[10px]" />}
      </div>
    </Field>
  );
}

export function CmsCenter({ flash }: { flash: F }) {
  const { products } = useStore();
  const [pages, setPages] = useState<Page[] | null>(null);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"hero" | "blocks" | "pages" | "support">("hero");
  const [h, setH] = useState<HeroConfig | null>(null);
  const [edit, setEdit] = useState<Section | null>(null);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [widget, setWidget] = useState<{ enabled: boolean; position: "left" | "right"; channels: { type: string; label: string; value: string }[]; appearance: { color: string; size: "small" | "medium" | "large"; icon: string } } | null>(null);
  const homePage = pages?.find((p) => p.code === "home") ?? pages?.[0] ?? null;

  const loadPages = async () => {
    setError(null);
    try {
      const res = await cmsApi.pages() as { items: Page[] };
      setPages(res.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت صفحات"); }
  };
  const loadSections = async (pageId: string) => {
    try {
      const res = await cmsApi.sections(pageId) as { items: Section[] };
      setSections(res.items);
    } catch { setSections([]); }
  };
  const loadWidget = async () => {
    try {
      const res = await publicApi.get<{ widget: typeof widget }>("/site/support-widget");
      setWidget(res.widget);
    } catch { /* keep empty draft */ }
  };
  useEffect(() => { void loadPages(); void loadWidget(); }, []);
  useEffect(() => { if (homePage) void loadSections(homePage.id); }, [homePage?.id]);

  const heroSection = sections?.find((s) => s.componentCode === "hero") ?? null;
  const blocks = (sections ?? []).filter((s) => s.componentCode !== "hero");

  useEffect(() => {
    if (heroSection) setH({ ...defaultHero(), ...(heroSection.payload as Partial<HeroConfig>) });
    else if (sections) setH((prev) => prev ?? defaultHero());
  }, [heroSection?.id, sections?.length]);

  /** Real, idempotent server bootstrap; reloads pages so the UI reflects PostgreSQL state. */
  const bootstrapHome = async () => {
    setBusy(true); setError(null);
    try {
      const result = await cmsApi.bootstrap();
      flash(result.pageCreated
        ? `صفحه اصلی با ${result.sectionsCreated.toLocaleString("fa-IR")} بخش ساخته شد`
        : "صفحه اصلی از قبل موجود بود؛ ساختار و پالت تکمیل شد");
      await loadPages();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در راه‌اندازی صفحه اصلی"); }
    setBusy(false);
  };

  const persistHero = async () => {
    if (!homePage || !h) return;
    setBusy(true);
    try {
      if (heroSection) await cmsApi.updateSection(heroSection.id, { title: "هیرو صفحه اصلی", payload: h, visible: true });
      else await cmsApi.createSection(homePage.id, { componentCode: "hero", title: "هیرو صفحه اصلی", payload: h, visible: true });
      await loadSections(homePage.id);
      flash("هیرو روی سرور منتشر شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در انتشار هیرو"); }
    setBusy(false);
  };

  const addBlock = async (code: string) => {
    if (!homePage) return;
    const meta = BLOCK_LIBRARY.find((b) => b.code === code)!;
    try {
      await cmsApi.createSection(homePage.id, { componentCode: code, title: meta.label, payload: meta.payload, visible: true });
      await loadSections(homePage.id); setAdding(false);
      flash(`«${meta.label}» ساخته شد (شناسه از سرور)`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت بخش"); }
  };
  const saveBlock = async (s: Section) => {
    try {
      await cmsApi.updateSection(s.id, { title: s.title, payload: s.payload, visible: s.visible });
      await loadSections(homePage!.id); setEdit(null);
      flash(`«${s.title}» روی سرور ذخیره شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره بخش"); }
  };
  const toggleBlock = async (s: Section) => {
    try {
      await cmsApi.updateSection(s.id, { visible: !s.visible });
      await loadSections(homePage!.id);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
  };
  const removeBlock = async (s: Section) => {
    try { await cmsApi.deleteSection(s.id); await loadSections(homePage!.id); flash("بخش حذف شد"); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در حذف"); }
  };
  const moveBlock = async (i: number, d: -1 | 1) => {
    const list = [...blocks];
    const j = i + d;
    if (j < 0 || j >= list.length || !homePage) return;
    [list[i], list[j]] = [list[j], list[i]];
    setSections([...(heroSection ? [heroSection] : []), ...list]);
    try {
      await cmsApi.reorderSections(homePage.id, list.map((s) => s.id));
      await loadSections(homePage.id);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر ترتیب"); await loadSections(homePage.id); }
  };
  const saveWidget = async () => {
    if (!widget) return;
    try {
      await cmsApi.saveSupportWidget(widget);
      flash("دکمه پشتیبانی روی سرور ذخیره شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره دکمه پشتیبانی"); }
  };

  const cats = ["همه", ...Array.from(new Set(products.map((p) => p.category)))];
  const dirty = Boolean(h && heroSection && JSON.stringify(h) !== JSON.stringify(heroSection.payload));

  if (error) return <ErrorState message={`دسترسی به CMS سرور ممکن نشد: ${error}`} onRetry={() => void loadPages()} />;
  if (!pages) return <LoadingState />;

  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <p className="text-[12px] leading-6 text-[var(--kv-muted)]">
        محتوای منتشرشده فقط در PostgreSQL (CMS API) ذخیره می‌شود؛ پیش‌نمایش و فرم در حال ویرایش محلی است. رسانه‌ها از دامنه فایل (POST /files) بارگذاری و شناسه سرور ذخیره می‌شود.
      </p>
      {pages.length === 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-[var(--kv-accent)]/40 p-4">
          <div>
            <p className="text-[13.5px] font-extrabold">صفحه‌ای در سرور ثبت نشده است</p>
            <p className="mt-1 max-w-[620px] text-[12px] leading-6 text-[var(--kv-muted)]">
              با «راه‌اندازی صفحه اصلی» یک عملیات اتمی و تکرارپذیر روی سرور اجرا می‌شود: صفحه home، بخش هیرو،
              بخش‌های پایه (اسلایدر محصولات و دعوت به اقدام) و پالت اصلی کلبه ساخته و فعال می‌شوند.
            </p>
          </div>
          <Btn variant="accent" size="sm" disabled={busy} icon={<Plus size={14} />} onClick={() => void bootstrapHome()}>راه‌اندازی صفحه اصلی</Btn>
        </Card>
      )}
      {pages.length > 0 && !heroSection && (
        <p className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2.5 text-[12px] text-[var(--kv-muted)]">
          صفحه اصلی هیرو ندارد؛ با زدن «انتشار هیرو روی سرور» در همین تب، بخش هیرو ساخته می‌شود.
        </p>
      )}
      <Segmented<"hero" | "blocks" | "pages" | "support">
        options={[{ v: "hero", label: "هیرو صفحه اصلی" }, { v: "blocks", label: `کامپوننت‌ها (${blocks.filter((b) => b.visible).length.toLocaleString("fa-IR")} فعال)` }, { v: "pages", label: "صفحات و پالت" }, { v: "support", label: "پشتیبانی سریع" }]}
        value={tab} onChange={setTab}
      />

      {tab === "hero" && h && (
        <div className="grid gap-5 2xl:grid-cols-[440px_minmax(0,1fr)]">
          <Card className="h-fit p-5">
            <p className="mb-3 flex items-center gap-2 text-[15px] font-extrabold"><LayoutTemplate size={17} className="text-[var(--kv-accent)]" />قالب هیرو (بخش سرور {heroSection ? "· موجود" : "· ساخته می‌شود"})</p>
            <div className="grid grid-cols-2 gap-2">{HERO_TEMPLATES.map((t) => <button key={t} onClick={() => setH({ ...h, template: t })} aria-pressed={h.template === t} className={cn("rounded-[12px] border p-3 text-right text-[12.5px] font-semibold", h.template === t ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>{HERO_TEMPLATE_LABEL[t]}</button>)}</div>
            <div className="mt-5 space-y-4">
              <Field label="روتیتر"><Input value={h.eyebrow} onChange={(v) => setH({ ...h, eyebrow: v })} /></Field>
              <Field label="تیتر"><Textarea rows={2} value={h.title} onChange={(v) => setH({ ...h, title: v })} /></Field>
              <Field label="زیرتیتر"><Textarea rows={2} value={h.subtitle} onChange={(v) => setH({ ...h, subtitle: v })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="دکمه اصلی"><Input value={h.ctaLabel} onChange={(v) => setH({ ...h, ctaLabel: v })} /></Field>
                <Field label="مقصد"><Select options={TARGETS.map((t) => t.l)} value={TARGETS.find((t) => t.v === h.ctaTarget)?.l ?? "فروشگاه"} onChange={(v) => setH({ ...h, ctaTarget: (TARGETS.find((t) => t.l === v)?.v ?? "shop") as HeroConfig["ctaTarget"] })} /></Field>
              </div>
              <MediaField label="تصویر هیرو" value={h.image} onChange={(v) => setH({ ...h, image: v })} kind="image" flash={flash} />
              <Field label={`تیرگی روی تصویر: ${h.overlay.toLocaleString("fa-IR")}٪`}><input type="range" min={0} max={80} value={h.overlay} onChange={(e) => setH({ ...h, overlay: Number(e.target.value) })} className="w-full accent-[#C1613B]" /></Field>
              <div className="flex gap-2 border-t border-[var(--kv-line)] pt-4">
                <Btn variant="accent" disabled={busy || !h.title.trim()} onClick={persistHero}>{busy ? "در حال ذخیره…" : "انتشار هیرو روی سرور"}</Btn>
                <Btn variant="ghost" disabled={!heroSection} onClick={() => heroSection && setH({ ...defaultHero(), ...(heroSection.payload as Partial<HeroConfig>) })}>بازگردانی</Btn>
              </div>
            </div>
          </Card>
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-bold text-[var(--kv-muted)]"><Eye size={14} />پیش‌نمایش زنده{dirty && <span className="text-[var(--kv-accent)]"> · تغییرات منتشر نشده</span>}</p>
            <div className="rounded-[26px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-bg)] p-3"><HeroRenderer h={h} onNav={() => {}} preview /></div>
          </div>
        </div>
      )}

      {tab === "blocks" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[15px] font-extrabold">چیدمان صفحه {homePage?.code ?? "—"}</p>
              <Btn size="sm" variant="accent" icon={<Plus size={14} />} onClick={() => setAdding(true)}>افزودن کامپوننت</Btn>
            </div>
            {blocks.length === 0 && <Empty title="بخشی ثبت نشده" desc="از کتابخانه یک کامپوننت اضافه کنید؛ شناسه را سرور می‌سازد." />}
            <div className="space-y-2">{blocks.map((b, i) => (
              <div key={b.id} className={cn("flex items-center gap-3 rounded-[12px] border p-3", b.visible ? "border-[var(--kv-line)] bg-[var(--kv-surface)]" : "border-dashed border-[var(--kv-line-strong)] opacity-60")}>
                <div className="flex flex-col">
                  <button aria-label="بالا" onClick={() => void moveBlock(i, -1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowUp size={14} /></button>
                  <button aria-label="پایین" onClick={() => void moveBlock(i, 1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowDown size={14} /></button>
                </div>
                <div className="min-w-0 flex-1"><p className="truncate text-[13.5px] font-bold">{b.title || b.componentCode}</p><p className="truncate text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{b.componentCode} · {b.id.slice(0, 8)}</p></div>
                <button aria-label="پیش‌نمایش" onClick={() => setPreview(preview === b.id ? null : b.id)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]">{preview === b.id ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button aria-label="ویرایش" onClick={() => setEdit(b)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><Pencil size={15} /></button>
                <Switch on={b.visible} onToggle={() => void toggleBlock(b)} />
                <button aria-label="حذف" onClick={() => void removeBlock(b)} className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={15} /></button>
              </div>
            ))}</div>
            {preview && (() => {
              const b = blocks.find((x) => x.id === preview);
              if (!b) return null;
              const block = { id: b.id, type: b.componentCode as CmsBlock["type"], name: b.title, enabled: b.visible, props: b.payload } as unknown as CmsBlock;
              return <div className="mt-4 rounded-[20px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-bg)] p-4"><BlockRenderer block={block} onNav={() => {}} products={products.filter((p) => p.status === "published")} /></div>;
            })()}
          </Card>
          <Card className="h-fit p-5">
            <p className="mb-3 text-[14px] font-extrabold">کتابخانه کامپوننت‌های سرور</p>
            <ul className="space-y-2">{BLOCK_LIBRARY.map((l) => <li key={l.code}><button onClick={() => void addBlock(l.code)} className="flex w-full items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] px-3 py-2.5 text-right hover:border-[var(--kv-accent)]"><span><b className="block text-[12.5px]">{l.label}</b><span className="text-[11px] text-[var(--kv-muted)]">{l.desc}</span></span><Plus size={15} className="text-[var(--kv-accent)]" /></button></li>)}</ul>
          </Card>
        </div>
      )}

      {tab === "pages" && <CmsPanel />}

      {tab === "support" && widget && (
        <Card className="max-w-[720px] p-5">
          <div className="mb-4 flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-[15px] font-extrabold"><Headset size={17} className="text-[var(--kv-accent)]" />دکمه پشتیبانی سریع (سرور)</p><Switch on={widget.enabled} onToggle={() => setWidget({ ...widget, enabled: !widget.enabled })} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="جای دکمه"><Select options={["چپ", "راست"]} value={widget.position === "left" ? "چپ" : "راست"} onChange={(v) => setWidget({ ...widget, position: v === "چپ" ? "left" : "right" })} /></Field>
            <Field label="اندازه"><Select options={["کوچک", "متوسط", "بزرگ"]} value={widget.appearance.size === "small" ? "کوچک" : widget.appearance.size === "large" ? "بزرگ" : "متوسط"} onChange={(v) => setWidget({ ...widget, appearance: { ...widget.appearance, size: v === "کوچک" ? "small" : v === "بزرگ" ? "large" : "medium" } })} /></Field>
            <Field label="رنگ"><Input value={widget.appearance.color} onChange={(v) => setWidget({ ...widget, appearance: { ...widget.appearance, color: v } })} /></Field>
          </div>
          <div className="mt-4 space-y-3">
            {widget.channels.map((c, i) => (
              <div key={i} className="grid gap-2 rounded-[12px] border border-[var(--kv-line)] p-3 sm:grid-cols-[140px_1fr_1fr_auto]">
                <Select options={["whatsapp", "telegram", "phone", "chat", "ticket"]} value={c.type} onChange={(v) => setWidget({ ...widget, channels: widget.channels.map((x, j) => j === i ? { ...x, type: v } : x) })} />
                <Input value={c.label} onChange={(v) => setWidget({ ...widget, channels: widget.channels.map((x, j) => j === i ? { ...x, label: v } : x) })} placeholder="برچسب" />
                <Input value={c.value} onChange={(v) => setWidget({ ...widget, channels: widget.channels.map((x, j) => j === i ? { ...x, value: v } : x) })} placeholder="شناسه" />
                <Btn size="sm" variant="ghost" onClick={() => setWidget({ ...widget, channels: widget.channels.filter((_, j) => j !== i) })}>حذف</Btn>
              </div>
            ))}
            <Btn size="sm" variant="soft" icon={<Plus size={14} />} onClick={() => setWidget({ ...widget, channels: [...widget.channels, { type: "phone", label: "تلفن", value: "021" }] })}>افزودن کانال</Btn>
          </div>
          <Btn variant="accent" className="mt-4" onClick={saveWidget} icon={<ImageIcon size={15} />}>ذخیره روی سرور</Btn>
        </Card>
      )}

      <Drawer open={adding} onClose={() => setAdding(false)} title="افزودن کامپوننت">
        <ul className="space-y-2">{BLOCK_LIBRARY.map((l) => <li key={l.code}><button onClick={() => void addBlock(l.code)} className="w-full rounded-[12px] border border-[var(--kv-line)] p-3 text-right hover:border-[var(--kv-accent)]"><b className="block text-[13px]">{l.label}</b><span className="text-[12px] text-[var(--kv-muted)]">{l.desc}</span></button></li>)}</ul>
      </Drawer>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit ? `ویرایش ${edit.title || edit.componentCode}` : ""}>
        {edit && <BlockEditor block={edit} cats={cats} onSave={saveBlock} flash={flash} />}
      </Drawer>
    </div>
  );
}

function BlockEditor({ block, cats, onSave, flash }: { block: Section; cats: string[]; onSave: (b: Section) => void; flash: F }) {
  const [b, setB] = useState(block);
  const p = b.payload as Record<string, string | number | undefined>;
  const setP = (x: Record<string, unknown>) => setB({ ...b, payload: { ...p, ...x } });
  const t = b.componentCode;
  return (
    <div className="space-y-4">
      <Field label="نام داخلی"><Input value={b.title} onChange={(v) => setB({ ...b, title: v })} /></Field>
      {["banner", "text_image", "promotional", "product_slider", "category_section", "faq", "cta", "blog_section", "brand_section"].includes(t) && <Field label="تیتر"><Input value={String(p.title ?? "")} onChange={(v) => setP({ title: v })} /></Field>}
      {["banner", "text_image", "promotional"].includes(t) && <Field label="متن"><Textarea rows={2} value={String(p.text ?? "")} onChange={(v) => setP({ text: v })} /></Field>}
      {["banner", "promotional", "cta"].includes(t) && <Field label="متن دکمه"><Input value={String(p.cta ?? "")} onChange={(v) => setP({ cta: v })} /></Field>}
      {["banner", "text_image"].includes(t) && <MediaField label="تصویر" value={String(p.image ?? "")} onChange={(v) => setP({ image: v })} kind="image" flash={flash} />}
      {t === "product_slider" && <div className="grid grid-cols-2 gap-3"><Field label="دسته"><Select options={cats} value={String(p.category ?? "همه")} onChange={(v) => setP({ category: v })} /></Field><Field label="تعداد"><Select options={["4", "8"]} value={String(p.count ?? 4)} onChange={(v) => setP({ count: Number(v) })} /></Field></div>}
      {t === "faq" && <Field label="پرسش‌ها" hint="هر خط: پرسش|پاسخ"><Textarea rows={6} value={String(p.items ?? "")} onChange={(v) => setP({ items: v })} /></Field>}
      <Btn variant="accent" className="w-full" onClick={() => onSave(b)}>ذخیره روی سرور</Btn>
    </div>
  );
}
