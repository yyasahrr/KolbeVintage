import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Film, Image as ImageIcon, LayoutTemplate, Pencil, Plus, Trash2, Upload, Headset } from "lucide-react";
import { IMG } from "../data/catalog";
import { useStore } from "../data/store";
import { useOps, HERO_VIDEO, HERO_VIDEO_ALT, type BlockType, type CmsBlock, type HeroConfig, type HeroTemplate } from "../data/ops";
import { HeroRenderer, BlockRenderer } from "../components/cms-render";
import { fileToUrl } from "../components/media";
import { Btn, Card, Drawer, Field, Input, Segmented, Select, Switch, Textarea } from "../components/primitives";
import { CmsAdmin } from "./admin-retail";
import { cn } from "../utils/cn";

type F = (m: string) => void;
const TEMPLATES: { v: HeroTemplate; label: string; desc: string }[] = [
  { v: "split", label: "دوستونه", desc: "متن کنار تصویر بزرگ" },
  { v: "fullbleed", label: "تمام‌عرض تصویری", desc: "تصویر پس‌زمینه با متن روی آن" },
  { v: "video", label: "ویدیویی", desc: "ویدیوی بی‌صدای حلقه‌ای با کنترل توقف" },
  { v: "carousel", label: "اسلایدر", desc: "چند اسلاید با پخش خودکار" },
  { v: "minimal", label: "مینیمال متنی", desc: "تیتر بزرگ بدون تصویر" },
  { v: "mosaic", label: "موزاییک کالکشن", desc: "متن + شبکه چهار تصویر" },
];
const TARGETS = [{ v: "shop", l: "فروشگاه" }, { v: "vip", l: "بازارچه عمده" }, { v: "tryon", l: "پرو مجازی" }, { v: "journal", l: "مجله" }] as const;
const targetLabel = (v: string) => TARGETS.find((t) => t.v === v)?.l ?? "فروشگاه";
const targetValue = (l: string) => (TARGETS.find((t) => t.l === l)?.v ?? "shop") as HeroConfig["ctaTarget"];
const IMAGES = [IMG.trenchHero, IMG.trenchArch, IMG.blazerDuo, IMG.redCoat, IMG.neutralRack, IMG.hijabTrench, IMG.atelierCut, IMG.shirtsColor];

export const LIBRARY: { type: BlockType; label: string; desc: string }[] = [
  { type: "announcement", label: "نوار اعلان", desc: "پیام کوتاه بالای همه صفحات" },
  { type: "countdown", label: "تایمر شمارش معکوس", desc: "برای جشنواره و پیشنهاد محدود" },
  { type: "banner", label: "بنر تبلیغاتی", desc: "تصویر، تیتر و دکمه" },
  { type: "products", label: "شبکه محصولات", desc: "محصولات یک دسته" },
  { type: "trust", label: "نوار اعتماد", desc: "ارسال، اصالت، مرجوعی، پشتیبانی" },
  { type: "testimonials", label: "نظرات مشتریان", desc: "نقل‌قول‌ها در سه ستون" },
  { type: "faq", label: "پرسش‌های پرتکرار", desc: "آکاردئون پرسش و پاسخ" },
  { type: "newsletter", label: "عضویت خبرنامه", desc: "فرم ایمیل" },
  { type: "richtext", label: "متن آزاد", desc: "تیتر و پاراگراف" },
];

function MediaPicker({ label, value, onChange, accept, flash }: { label: string; value: string; onChange: (v: string) => void; accept: "image" | "video"; flash: F }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <Field label={label}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input className="flex-1" value={value.startsWith("data:") ? "فایل بارگذاری‌شده" : value} onChange={onChange} placeholder="نشانی فایل (https://…)" />
          <input ref={ref} type="file" accept={accept === "image" ? "image/*" : "video/mp4,video/webm"} className="sr-only" onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            if (accept === "video" && file.size > 40 * 1024 * 1024) { flash("حجم ویدیو باید کمتر از ۴۰ مگابایت باشد"); return; }
            const r = await fileToUrl(file, accept === "video" ? 0 : 600 * 1024);
            onChange(r.url);
            flash(r.persistent ? "فایل بارگذاری شد" : "فایل برای همین نشست بارگذاری شد؛ برای انتشار دائمی، نشانی فایل روی سرور را وارد کنید");
          }} />
          <Btn variant="soft" icon={accept === "image" ? <Upload size={15} /> : <Film size={15} />} onClick={() => ref.current?.click()}>بارگذاری</Btn>
        </div>
        {accept === "image" && <div className="flex gap-1.5 overflow-x-auto kv-no-scrollbar">{IMAGES.map((src) => <button key={src} onClick={() => onChange(src)} aria-label="انتخاب تصویر" className={cn("h-12 w-12 shrink-0 overflow-hidden rounded-[8px] border-2", value === src ? "border-[var(--kv-accent)]" : "border-transparent")}><img src={src} alt="" className="h-full w-full object-cover" /></button>)}</div>}
        {accept === "video" && <div className="flex flex-wrap gap-2">{[HERO_VIDEO, HERO_VIDEO_ALT].map((v, i) => <button key={v} onClick={() => onChange(v)} className={cn("min-h-10 rounded-[9px] border px-3 text-[12px] font-semibold", value === v ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>ویدیوی نمونه {i + 1}</button>)}</div>}
      </div>
    </Field>
  );
}

export function CmsCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const { products } = useStore();
  const [tab, setTab] = useState<"home" | "blocks" | "pages" | "support">("home");
  const [h, setH] = useState<HeroConfig>(ops.hero);
  const [edit, setEdit] = useState<CmsBlock | null>(null);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const dirty = JSON.stringify(h) !== JSON.stringify(ops.hero);
  const blocks = ops.blocks;
  const move = (i: number, d: -1 | 1) => { const n = [...blocks]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; ops.set("blocks", n); };
  const add = (type: BlockType) => {
    const base: Record<BlockType, CmsBlock["props"]> = {
      announcement: { text: "پیام اعلان", tone: "navy", target: "shop" },
      countdown: { title: "پیشنهاد محدود", text: "تا پایان زمان", endsAt: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 16), cta: "مشاهده", target: "shop", tone: "terra" },
      banner: { title: "تیتر بنر", text: "توضیح کوتاه", image: IMG.neutralRack, cta: "مشاهده", target: "shop" },
      products: { title: "منتخب کلبه", category: "همه", count: 4 },
      trust: {}, testimonials: { title: "نظرات مشتریان", items: "متن نظر|نام مشتری" },
      faq: { title: "پرسش‌های پرتکرار", items: "پرسش؟|پاسخ" }, newsletter: { title: "عضویت در خبرنامه", text: "", tone: "stone" }, richtext: { title: "عنوان", text: "متن" },
    };
    const b: CmsBlock = { id: `b-${Date.now()}`, type, name: LIBRARY.find((l) => l.type === type)!.label, enabled: true, props: base[type] };
    ops.set("blocks", [...blocks, b]); setAdding(false); setEdit(b);
  };
  const saveBlock = (b: CmsBlock) => { ops.set("blocks", blocks.map((x) => (x.id === b.id ? b : x))); setEdit(null); flash(`«${b.name}» ذخیره و در صفحه اصلی اعمال شد`); };
  const cats = ["همه", ...Array.from(new Set(products.map((p) => p.category)))];

  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <Segmented<"home" | "blocks" | "pages" | "support"> options={[{ v: "home", label: "هیرو صفحه اصلی" }, { v: "blocks", label: `کامپوننت‌ها (${blocks.filter((b) => b.enabled).length.toLocaleString("fa-IR")} فعال)` }, { v: "pages", label: "صفحات و مقالات" }, { v: "support", label: "پشتیبانی سریع" }]} value={tab} onChange={setTab} />

      {tab === "home" && (
        <div className="grid gap-5 2xl:grid-cols-[440px_minmax(0,1fr)]">
          <Card className="h-fit p-5">
            <p className="mb-3 flex items-center gap-2 text-[15px] font-extrabold"><LayoutTemplate size={17} className="text-[var(--kv-accent)]" />قالب هیرو</p>
            <div className="grid grid-cols-2 gap-2">{TEMPLATES.map((t) => <button key={t.v} onClick={() => setH({ ...h, template: t.v })} aria-pressed={h.template === t.v} className={cn("rounded-[12px] border p-3 text-right transition-colors", h.template === t.v ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}><b className="block text-[13px]">{t.label}</b><span className="text-[11px] text-[var(--kv-muted)]">{t.desc}</span></button>)}</div>
            <div className="mt-5 space-y-4">
              <Field label="روتیتر"><Input value={h.eyebrow} onChange={(v) => setH({ ...h, eyebrow: v })} /></Field>
              <Field label="تیتر" hint="برای شکستن خط، Enter بزنید"><Textarea rows={2} value={h.title} onChange={(v) => setH({ ...h, title: v })} /></Field>
              <Field label="زیرتیتر"><Textarea rows={2} value={h.subtitle} onChange={(v) => setH({ ...h, subtitle: v })} /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="دکمه اصلی"><Input value={h.ctaLabel} onChange={(v) => setH({ ...h, ctaLabel: v })} /></Field><Field label="مقصد"><Select options={TARGETS.map((t) => t.l)} value={targetLabel(h.ctaTarget)} onChange={(v) => setH({ ...h, ctaTarget: targetValue(v) })} /></Field></div>
              <div className="grid grid-cols-2 gap-3"><Field label="دکمه دوم (اختیاری)"><Input value={h.secondaryLabel} onChange={(v) => setH({ ...h, secondaryLabel: v })} /></Field><Field label="مقصد"><Select options={TARGETS.map((t) => t.l)} value={targetLabel(h.secondaryTarget)} onChange={(v) => setH({ ...h, secondaryTarget: targetValue(v) })} /></Field></div>
              {["split", "fullbleed", "video"].includes(h.template) && <MediaPicker label={h.template === "video" ? "تصویر پوستر (پیش از پخش)" : "تصویر"} value={h.template === "video" ? h.poster : h.image} onChange={(v) => setH(h.template === "video" ? { ...h, poster: v } : { ...h, image: v })} accept="image" flash={flash} />}
              {h.template === "video" && <MediaPicker label="ویدیو (MP4 یا WebM)" value={h.video} onChange={(v) => setH({ ...h, video: v })} accept="video" flash={flash} />}
              {["fullbleed", "video", "carousel"].includes(h.template) && <>
                <Field label={`تیرگی روی تصویر: ${h.overlay.toLocaleString("fa-IR")}٪`} hint="برای خوانایی متن سفید"><input type="range" min={0} max={80} value={h.overlay} onChange={(e) => setH({ ...h, overlay: Number(e.target.value) })} className="w-full accent-[#C1613B]" /></Field>
                <Field label="چینش متن"><Select options={["راست", "وسط"]} value={h.align === "right" ? "راست" : "وسط"} onChange={(v) => setH({ ...h, align: v === "راست" ? "right" : "center" })} /></Field>
              </>}
              {h.template === "carousel" && <div className="space-y-3">{h.slides.map((s, i) => (
                <div key={i} className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <div className="mb-2 flex items-center justify-between"><b className="text-[12.5px]">اسلاید {(i + 1).toLocaleString("fa-IR")}</b><button aria-label="حذف اسلاید" disabled={h.slides.length < 2} onClick={() => setH({ ...h, slides: h.slides.filter((_, j) => j !== i) })} className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--kv-danger)] disabled:opacity-30"><Trash2 size={14} /></button></div>
                  <div className="space-y-2"><Input value={s.title} onChange={(v) => setH({ ...h, slides: h.slides.map((x, j) => (j === i ? { ...x, title: v } : x)) })} placeholder="تیتر اسلاید" /><Input value={s.subtitle} onChange={(v) => setH({ ...h, slides: h.slides.map((x, j) => (j === i ? { ...x, subtitle: v } : x)) })} placeholder="زیرتیتر" /><MediaPicker label="تصویر" value={s.image} onChange={(v) => setH({ ...h, slides: h.slides.map((x, j) => (j === i ? { ...x, image: v } : x)) })} accept="image" flash={flash} /></div>
                </div>
              ))}<Btn variant="soft" size="sm" icon={<Plus size={14} />} onClick={() => setH({ ...h, slides: [...h.slides, { image: IMG.trenchArch, title: "", subtitle: "" }] })}>افزودن اسلاید</Btn></div>}
              {h.template === "mosaic" && <div className="grid grid-cols-2 gap-2">{h.mosaic.map((m, i) => <MediaPicker key={i} label={`تصویر ${(i + 1).toLocaleString("fa-IR")}`} value={m} onChange={(v) => setH({ ...h, mosaic: h.mosaic.map((x, j) => (j === i ? v : x)) })} accept="image" flash={flash} />)}</div>}
              <div className="flex gap-2 border-t border-[var(--kv-line)] pt-4"><Btn variant="accent" disabled={!dirty || !h.title.trim()} onClick={() => { ops.set("hero", h); flash("هیرو منتشر شد"); }}>انتشار هیرو</Btn><Btn variant="ghost" disabled={!dirty} onClick={() => setH(ops.hero)}>بازگردانی</Btn></div>
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
            <div className="mb-3 flex items-center justify-between gap-2"><div><p className="text-[15px] font-extrabold">چیدمان صفحه اصلی</p><p className="text-[12px] text-[var(--kv-muted)]">کامپوننت‌ها به همین ترتیب زیر هیرو نمایش داده می‌شوند؛ نوار اعلان همیشه بالای سایت است.</p></div><Btn size="sm" variant="accent" icon={<Plus size={14} />} onClick={() => setAdding(true)}>افزودن کامپوننت</Btn></div>
            <div className="space-y-2">{blocks.map((b, i) => (
              <div key={b.id} className={cn("flex items-center gap-3 rounded-[12px] border p-3", b.enabled ? "border-[var(--kv-line)] bg-[var(--kv-surface)]" : "border-dashed border-[var(--kv-line-strong)] opacity-60")}>
                <div className="flex flex-col"><button aria-label="بالا" onClick={() => move(i, -1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowUp size={14} /></button><button aria-label="پایین" onClick={() => move(i, 1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowDown size={14} /></button></div>
                <div className="min-w-0 flex-1"><p className="truncate text-[13.5px] font-bold">{b.name}</p><p className="truncate text-[11.5px] text-[var(--kv-muted)]">{LIBRARY.find((l) => l.type === b.type)?.label}{b.props.title ? ` · ${b.props.title}` : b.props.text ? ` · ${b.props.text}` : ""}</p></div>
                <button aria-label="پیش‌نمایش" onClick={() => setPreview(preview === b.id ? null : b.id)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]">{preview === b.id ? <EyeOff size={15} /> : <Eye size={15} />}</button>
                <button aria-label="ویرایش" onClick={() => setEdit(b)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><Pencil size={15} /></button>
                <Switch on={b.enabled} onToggle={() => ops.set("blocks", blocks.map((x) => (x.id === b.id ? { ...x, enabled: !x.enabled } : x)))} />
                <button aria-label="حذف" onClick={() => ops.set("blocks", blocks.filter((x) => x.id !== b.id))} className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={15} /></button>
              </div>
            ))}</div>
            {preview && (() => { const b = blocks.find((x) => x.id === preview); return b ? <div className="mt-4 rounded-[20px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-bg)] p-4">{b.type === "announcement" ? <div className="rounded-[10px] bg-[#1B2A4A] px-4 py-2 text-center text-[12.5px] font-semibold text-[#F5EFE3]">{b.props.text}</div> : <BlockRenderer block={b} onNav={() => {}} products={products.filter((p) => p.status === "published")} />}</div> : null; })()}
          </Card>
          <Card className="h-fit p-5">
            <p className="mb-3 text-[14px] font-extrabold">کتابخانه کامپوننت‌ها</p>
            <ul className="space-y-2">{LIBRARY.map((l) => <li key={l.type}><button onClick={() => add(l.type)} className="flex w-full items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] px-3 py-2.5 text-right hover:border-[var(--kv-accent)]"><span><b className="block text-[12.5px]">{l.label}</b><span className="text-[11px] text-[var(--kv-muted)]">{l.desc}</span></span><Plus size={15} className="text-[var(--kv-accent)]" /></button></li>)}</ul>
          </Card>
        </div>
      )}

      {tab === "pages" && <CmsAdmin flash={flash} />}

      {tab === "support" && (
        <Card className="max-w-[720px] p-5">
          <div className="mb-4 flex items-center justify-between gap-3"><p className="flex items-center gap-2 text-[15px] font-extrabold"><Headset size={17} className="text-[var(--kv-accent)]" />دکمه پشتیبانی سریع</p><Switch on={ops.quickSupport.enabled} onToggle={() => ops.set("quickSupport", { ...ops.quickSupport, enabled: !ops.quickSupport.enabled })} /></div>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="عنوان"><Input value={ops.quickSupport.title} onChange={(v) => ops.set("quickSupport", { ...ops.quickSupport, title: v })} /></Field><Field label="ساعات پاسخ‌گویی"><Input value={ops.quickSupport.hours} onChange={(v) => ops.set("quickSupport", { ...ops.quickSupport, hours: v })} /></Field></div>
          <div className="mt-4 divide-y divide-[var(--kv-line)] rounded-[12px] border border-[var(--kv-line)] px-4">{ops.quickSupport.channels.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 py-3">
              <b className="w-24 text-[13px]">{c.label}</b>
              <input aria-label={`شناسه ${c.label}`} value={c.value} onChange={(e) => ops.set("quickSupport", { ...ops.quickSupport, channels: ops.quickSupport.channels.map((x) => (x.id === c.id ? { ...x, value: e.target.value } : x)) })} dir="ltr" placeholder={c.id === "phone" ? "021…" : c.id === "whatsapp" ? "98912…" : c.id === "email" ? "support@…" : "username"} className="h-10 min-w-[180px] flex-1 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] outline-none focus:border-[var(--kv-accent)]" />
              <Switch on={c.enabled} onToggle={() => ops.set("quickSupport", { ...ops.quickSupport, channels: ops.quickSupport.channels.map((x) => (x.id === c.id ? { ...x, enabled: !x.enabled } : x)) })} />
            </div>
          ))}</div>
          <p className="mt-3 text-[12px] text-[var(--kv-muted)]">تغییرات بلافاصله در دکمه شناور پایین فروشگاه اعمال می‌شوند.</p>
        </Card>
      )}

      <Drawer open={adding} onClose={() => setAdding(false)} title="افزودن کامپوننت">
        <ul className="space-y-2">{LIBRARY.map((l) => <li key={l.type}><button onClick={() => add(l.type)} className="w-full rounded-[12px] border border-[var(--kv-line)] p-3 text-right hover:border-[var(--kv-accent)]"><b className="block text-[13px]">{l.label}</b><span className="text-[12px] text-[var(--kv-muted)]">{l.desc}</span></button></li>)}</ul>
      </Drawer>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit ? `ویرایش ${edit.name}` : ""}>
        {edit && <BlockEditor block={edit} cats={cats} onSave={saveBlock} flash={flash} />}
      </Drawer>
    </div>
  );
}

function BlockEditor({ block, cats, onSave, flash }: { block: CmsBlock; cats: string[]; onSave: (b: CmsBlock) => void; flash: F }) {
  const [b, setB] = useState(block);
  const p = b.props;
  const setP = (x: Partial<CmsBlock["props"]>) => setB({ ...b, props: { ...p, ...x } });
  const t = b.type;
  return (
    <div className="space-y-4">
      <Field label="نام داخلی"><Input value={b.name} onChange={(v) => setB({ ...b, name: v })} /></Field>
      {["countdown", "banner", "products", "testimonials", "faq", "newsletter", "richtext"].includes(t) && <Field label="تیتر"><Input value={p.title ?? ""} onChange={(v) => setP({ title: v })} /></Field>}
      {["announcement", "countdown", "banner", "newsletter", "richtext"].includes(t) && <Field label={t === "announcement" ? "متن اعلان" : "متن"}><Textarea rows={t === "richtext" ? 6 : 2} value={p.text ?? ""} onChange={(v) => setP({ text: v })} /></Field>}
      {t === "countdown" && <Field label="زمان پایان" hint="تایمر پس از این زمان خودکار پنهان می‌شود"><input type="datetime-local" value={p.endsAt ?? ""} onChange={(e) => setP({ endsAt: e.target.value })} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /></Field>}
      {t === "banner" && <MediaPicker label="تصویر پس‌زمینه" value={p.image ?? ""} onChange={(v) => setP({ image: v })} accept="image" flash={flash} />}
      {["countdown", "banner"].includes(t) && <Field label="متن دکمه"><Input value={p.cta ?? ""} onChange={(v) => setP({ cta: v })} /></Field>}
      {["announcement", "countdown", "banner"].includes(t) && <Field label="مقصد کلیک"><Select options={TARGETS.map((x) => x.l)} value={targetLabel(p.target ?? "shop")} onChange={(v) => setP({ target: targetValue(v) })} /></Field>}
      {["announcement", "countdown", "newsletter"].includes(t) && <Field label="رنگ"><Select options={["سرمه‌ای", "آجری", "سنگی"]} value={p.tone === "terra" ? "آجری" : p.tone === "stone" ? "سنگی" : "سرمه‌ای"} onChange={(v) => setP({ tone: v === "آجری" ? "terra" : v === "سنگی" ? "stone" : "navy" })} /></Field>}
      {t === "products" && <div className="grid grid-cols-2 gap-3"><Field label="دسته"><Select options={cats} value={p.category ?? "همه"} onChange={(v) => setP({ category: v })} /></Field><Field label="تعداد"><Select options={["4", "8"]} value={String(p.count ?? 4)} onChange={(v) => setP({ count: Number(v) })} /></Field></div>}
      {["testimonials", "faq"].includes(t) && <Field label={t === "faq" ? "پرسش‌ها" : "نظرات"} hint={t === "faq" ? "هر خط: پرسش|پاسخ" : "هر خط: متن نظر|نام و شهر"}><Textarea rows={6} value={p.items ?? ""} onChange={(v) => setP({ items: v })} /></Field>}
      <Btn variant="accent" className="w-full" icon={<ImageIcon size={15} />} onClick={() => onSave(b)}>ذخیره و انتشار</Btn>
    </div>
  );
}
