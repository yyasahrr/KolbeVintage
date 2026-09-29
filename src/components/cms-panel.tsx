import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, Layers, Palette as PaletteIcon, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Select, Textarea } from "./primitives";
import { PersianDatePicker } from "./persian-date-picker";
import { cmsApi } from "../data/api";
import { formatPersianDateTime, todayIso } from "../data/persian-date";
import { CMS_BOOTSTRAP_SECTION_LABEL, PALETTE_COLOR_LABEL, PALETTE_MODE_LABEL, labelOf } from "../data/contracts";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

type Section = { id: string; title: string; visible: boolean; position: number; component_code: string; component_type: string; payload: Record<string, unknown> };
type Palette = { id: string; code: string; name: string; colors: Record<string, string>; activations: { mode: string; active: boolean; startsAt: string | null }[] };
type Page = { id: string; code: string; title: string; path: string; section_count: number; active: boolean };

const DEFAULT_PALETTE_COLORS = { primary: "#1B2A4A", secondary: "#C1613B", accent: "#C1613B", background: "#F9F6F1", surface: "#FFFFFF", text: "#0E1527" };

/**
 * CMS management: pages, sections, palettes.
 * A fresh database is no longer a dead end — «راه‌اندازی صفحه اصلی» performs a real, idempotent
 * server-side bootstrap (home page + hero + base sections + default palette).
 */
export function CmsPanel() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [palettes, setPalettes] = useState<Palette[] | null>(null);
  const [components, setComponents] = useState<{ code: string; component_type: string }[] | null>(null);
  const [sections, setSections] = useState<Record<string, Section[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPage, setNewPage] = useState({ code: "home", title: "صفحه اصلی", path: "/", description: "" });
  const [newPalette, setNewPalette] = useState({ code: "kolbe-default", name: "پالت اصلی کلبه", colors: { ...DEFAULT_PALETTE_COLORS } });
  const [activation, setActivation] = useState({ mode: "manual" as "manual" | "scheduled" | "festival", startsAt: todayIso(), endsAt: null as string | null });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pageRes, paletteRes, componentRes] = await Promise.all([
        cmsApi.pages() as Promise<{ items: Page[] }>,
        cmsApi.palettes() as Promise<{ items: Palette[] }>,
        cmsApi.components(),
      ]);
      setPages(pageRes.items); setPalettes(paletteRes.items);
      setComponents(componentRes.items as { code: string; component_type: string }[]);
      const home = pageRes.items.find((page) => page.code === "home");
      if (home) {
        const sectionRes = await cmsApi.sections(home.id) as { items: Section[] };
        setSections((current) => ({ ...current, [home.id]: sectionRes.items }));
      }
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری محتوای سایت"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runBootstrap = async () => {
    try {
      setBusy(true); setError(null);
      const result = await cmsApi.bootstrap();
      setNotice(result.pageCreated
        ? `صفحه اصلی ساخته شد؛ ${fa(result.sectionsCreated)} بخش پایه (هیرو، اسلایدر، دعوت به اقدام) و پالت اصلی فعال شد.`
        : "صفحه اصلی از قبل وجود داشت؛ بخش‌های پایه و پالت اصلی تکمیل شدند.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در راه‌اندازی صفحه اصلی"); }
    finally { setBusy(false); }
  };

  const createPage = async () => {
    try {
      setBusy(true); setError(null);
      await cmsApi.createPage({ code: newPage.code.trim(), title: newPage.title.trim(), path: newPage.path.trim(), description: newPage.description, seo: {}, active: true });
      setNotice("صفحه ساخته شد.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت صفحه"); }
    finally { setBusy(false); }
  };

  const addSection = async (pageId: string, componentCode: string) => {
    try {
      setBusy(true); setError(null);
      const payload = componentCode === "hero"
        ? { eyebrow: "کلبه وینتیج", title: "پوشاک انتخابی، برای سال‌ها", subtitle: "کالکشن کلبه وینتیج با تمرکز بر پارچه، دوخت و ماندگاری.", ctaLabel: "مشاهده کالکشن", ctaTarget: "shop", image: null }
        : { title: CMS_BOOTSTRAP_SECTION_LABEL[componentCode] ?? componentCode, text: "این بخش را از همین صفحه ویرایش کنید.", cta: "مشاهده", target: "shop" };
      await cmsApi.createSection(pageId, { componentCode, title: CMS_BOOTSTRAP_SECTION_LABEL[componentCode] ?? componentCode, payload, visible: true });
      setNotice("بخش به صفحه اضافه شد.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در افزودن بخش"); }
    finally { setBusy(false); }
  };

  const createDefaultPalette = async () => {
    try {
      setBusy(true); setError(null);
      const result = await cmsApi.defaultPalette();
      setNotice(result.created ? "پالت اصلی کلبه ساخته و فعال شد." : "پالت اصلی از قبل وجود داشت و فعال شد.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت پالت اصلی"); }
    finally { setBusy(false); }
  };

  const createPalette = async () => {
    try {
      setBusy(true); setError(null);
      await cmsApi.createPalette({ code: newPalette.code.trim(), name: newPalette.name.trim(), colors: newPalette.colors });
      setNotice("پالت رنگ ساخته شد.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ساخت پالت"); }
    finally { setBusy(false); }
  };

  const activatePalette = async (paletteId: string) => {
    try {
      setBusy(true); setError(null);
      await cmsApi.activatePalette(paletteId, { mode: activation.mode, startsAt: activation.startsAt, ...(activation.endsAt ? { endsAt: activation.endsAt } : {}) });
      setNotice(`پالت با حالت «${labelOf(PALETTE_MODE_LABEL, activation.mode)}» فعال شد.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در فعال‌سازی پالت"); }
    finally { setBusy(false); }
  };

  if (error && !pages) return <ErrorState message={error} onRetry={load} />;
  if (!pages || !palettes || !components) return <LoadingState label="در حال بارگذاری محتوای سایت…" />;

  const homePage = pages.find((page) => page.code === "home") ?? null;
  const homeSections = homePage ? sections[homePage.id] ?? [] : [];
  const heroSection = homeSections.find((section) => section.component_code === "hero") ?? null;

  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      {error && <ErrorState message={error} onRetry={load} />}
      {notice && <p role="status" className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-2 text-[12.5px] font-semibold">{notice}</p>}

      <Card className="p-5">
        <div className="flex-flex-wrap flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-[14px] font-extrabold"><Sparkles size={15} />وضعیت محتوای سایت</p>
            <p className="mt-1.5 text-[12.5px] leading-7 text-[var(--kv-muted)]">
              {homePage
                ? `صفحه اصلی موجود است با ${fa(homeSections.length)} بخش${heroSection ? " (هیرو فعال)" : " — هیرو ندارد"}.`
                : "صفحه اصلی ساخته نشده است؛ با یک کلیک، صفحه اصلی + هیرو + بخش‌های پایه + پالت اصلی ساخته می‌شود."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!homePage && <Btn variant="accent" disabled={busy} icon={<Wand2 size={15} />} onClick={() => void runBootstrap()}>راه‌اندازی صفحه اصلی</Btn>}
            {homePage && !heroSection && <Btn variant="accent" disabled={busy} icon={<Sparkles size={15} />} onClick={() => void addSection(homePage.id, "hero")}>ایجاد هیرو</Btn>}
            {homePage && heroSection && <span className="inline-flex items-center gap-1.5 rounded-full bg-[#3E6B4A]/10 px-3 py-2 text-[12px] font-bold text-[#3E6B4A]"><BadgeCheck size={14} />هیرو فعال است</span>}
            <Btn variant="soft" disabled={busy} icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
          </div>
        </div>
        {homePage && homeSections.length > 0 && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {homeSections.map((section) => (
              <div key={section.id} className="rounded-[12px] border border-[var(--kv-line)] px-3 py-2.5">
                <p className="text-[12.5px] font-bold">{labelOf(CMS_BOOTSTRAP_SECTION_LABEL, section.component_code, section.title)}</p>
                <p className="mt-0.5 text-[11px] text-[var(--kv-muted)]">
                  {section.component_code} · {section.visible ? "نمایش داده می‌شود" : "پنهان"} · جایگاه {fa(section.position + 1)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><Layers size={14} />صفحه جدید</p>
          <div className="mt-3 grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="کد صفحه"><Input value={newPage.code} onChange={(v) => setNewPage({ ...newPage, code: v.toLowerCase() })} placeholder="home" /></Field>
              <Field label="عنوان صفحه"><Input value={newPage.title} onChange={(v) => setNewPage({ ...newPage, title: v })} /></Field>
            </div>
            <Field label="نشانی صفحه"><Input value={newPage.path} onChange={(v) => setNewPage({ ...newPage, path: v })} placeholder="/ یا /campaign/yald" /></Field>
            <Field label="توضیح"><Textarea rows={2} value={newPage.description} onChange={(v) => setNewPage({ ...newPage, description: v })} /></Field>
            <Btn variant="accent" size="sm" disabled={busy || newPage.code.trim().length < 2 || newPage.title.trim().length < 2} onClick={() => void createPage()}>ایجاد صفحه</Btn>
          </div>
        </Card>

        <Card className="p-4">
          <p className="flex items-center gap-1.5 text-[13px] font-bold"><PaletteIcon size={14} />پالت رنگ</p>
          {palettes.length === 0 ? (
            <div className="mt-3">
              <p className="text-[12.5px] leading-7 text-[var(--kv-muted)]">
                هنوز پالتی ساخته نشده است. پالت اصلی کلبه را بسازید تا رنگ‌های سایت و جشنواره‌ها روی آن اعمال شود.
              </p>
              <Btn variant="accent" size="sm" className="mt-3" disabled={busy} icon={<Wand2 size={14} />} onClick={() => void createDefaultPalette()}>ایجاد پالت اصلی</Btn>
            </div>
          ) : (
            <div className="mt-3 grid gap-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="کد پالت"><Input value={newPalette.code} onChange={(v) => setNewPalette({ ...newPalette, code: v.toLowerCase() })} /></Field>
                <Field label="نام پالت"><Input value={newPalette.name} onChange={(v) => setNewPalette({ ...newPalette, name: v })} /></Field>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(newPalette.colors).map(([key, value]) => (
                  <Field key={key} label={labelOf(PALETTE_COLOR_LABEL, key, key)}>
                    <div className="flex items-center gap-2">
                      <input type="color" value={value} aria-label={labelOf(PALETTE_COLOR_LABEL, key, key)}
                        onChange={(event) => setNewPalette({ ...newPalette, colors: { ...newPalette.colors, [key]: event.target.value } })}
                        className="h-9 w-10 cursor-pointer rounded border border-[var(--kv-line)] bg-transparent" />
                      <span className="text-[11px] tabular-nums" dir="ltr">{value}</span>
                    </div>
                  </Field>
                ))}
              </div>
              <div className="flex gap-2">
                <Btn variant="accent" size="sm" disabled={busy || newPalette.code.trim().length < 2} onClick={() => void createPalette()}>ایجاد پالت</Btn>
                <Btn variant="soft" size="sm" disabled={busy} onClick={() => void createDefaultPalette()}>ایجاد پالت اصلی</Btn>
              </div>
            </div>
          )}
          <div className="mt-4 border-t border-[var(--kv-line)] pt-3">
            <p className="text-[12.5px] font-bold">زمان‌بندی فعال‌سازی</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <Field label="حالت">
                <Select options={Object.values(PALETTE_MODE_LABEL)} value={labelOf(PALETTE_MODE_LABEL, activation.mode)}
                  onChange={(label) => {
                    const entry = Object.entries(PALETTE_MODE_LABEL).find(([, value]) => value === label);
                    if (entry) setActivation({ ...activation, mode: entry[0] as typeof activation.mode });
                  }} />
              </Field>
              <PersianDatePicker label="شروع" value={activation.startsAt} withTime onChange={(iso) => setActivation({ ...activation, startsAt: iso ?? activation.startsAt })} />
              <PersianDatePicker label="پایان (اختیاری)" value={activation.endsAt} withTime onChange={(iso) => setActivation({ ...activation, endsAt: iso })} />
            </div>
            <p className="mt-2 text-[11px] text-[var(--kv-muted)]">حالت «جشنواره» فقط برای پالت متصل به جشنواره فعال اعمال می‌شود؛ اولویت سایت: جشنواره → زمان‌بندی‌شده → دستی.</p>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3">
          <p className="text-[13px] font-bold">
            صفحه‌های سایت ({fa(pages.length)}) — کامپوننت‌های در دسترس: {components.map((component) => CMS_BOOTSTRAP_SECTION_LABEL[component.code] ?? component.code).join("، ") || "بدون کامپوننت"}
          </p>
        </div>
        <div className="space-y-4 p-4">
          {pages.map((page) => (
            <div key={page.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[13px] font-bold">{page.title} <span className="font-mono text-[11px] text-[var(--kv-muted)]" dir="ltr">/{page.code}</span></p>
                  <p className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{page.path} · {fa(page.section_count)} بخش · {page.active ? "فعال" : "غیرفعال"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Select
                    options={components.map((component) => CMS_BOOTSTRAP_SECTION_LABEL[component.code] ?? component.code)}
                    value={CMS_BOOTSTRAP_SECTION_LABEL[components[0]?.code ?? ""] ?? ""}
                    onChange={(label) => {
                      const component = components.find((entry) => (CMS_BOOTSTRAP_SECTION_LABEL[entry.code] ?? entry.code) === label);
                      if (component) void addSection(page.id, component.code);
                    }}
                  />
                  <Btn size="sm" variant="soft" disabled={busy} onClick={() => void addSection(page.id, components[0]?.code ?? "hero")}>افزودن بخش</Btn>
                </div>
              </div>
              {(sections[page.id] ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[var(--kv-muted)]">
                  {(sections[page.id] ?? []).map((section) => (
                    <span key={section.id} className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-1">
                      {labelOf(CMS_BOOTSTRAP_SECTION_LABEL, section.component_code, section.title)}{section.visible ? "" : " (پنهان)"}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {pages.length === 0 && (
            <Empty title="صفحه‌ای ثبت نشده است" desc="با «راه‌اندازی صفحه اصلی» صفحه خانه، هیرو و بخش‌های پایه یک‌جا ساخته می‌شوند." />
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">پالت‌های رنگ ({fa(palettes.length)})</p></div>
        <div className="space-y-3 p-4">
          {palettes.map((palette) => (
            <div key={palette.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[var(--kv-line)] px-3 py-3">
              <div>
                <p className="text-[13px] font-bold">{palette.name} <span className="font-mono text-[11px]" dir="ltr">/{palette.code}</span></p>
                <div className="mt-1 flex items-center gap-1.5">
                  {Object.entries(palette.colors).map(([key, color]) => (
                    <span key={key} title={labelOf(PALETTE_COLOR_LABEL, key, key)} className="h-5 w-5 rounded-full border border-[var(--kv-line)]" style={{ background: color }} />
                  ))}
                  <span className="text-[11px] text-[var(--kv-muted)]">
                    {(palette.activations ?? []).filter((entry) => entry.active).length > 0
                      ? `فعال: ${(palette.activations ?? []).filter((entry) => entry.active).map((entry) => labelOf(PALETTE_MODE_LABEL, entry.mode)).join("، ")}${palette.activations.find((entry) => entry.active)?.startsAt ? ` — از ${formatPersianDateTime(palette.activations.find((entry) => entry.active)!.startsAt!)}` : ""}`
                      : "غیرفعال"}
                  </span>
                </div>
              </div>
              <Btn size="sm" variant="soft" disabled={busy} onClick={() => void activatePalette(palette.id)}>
                فعال‌سازی {labelOf(PALETTE_MODE_LABEL, activation.mode)}
              </Btn>
            </div>
          ))}
          {palettes.length === 0 && <Empty title="پالتی ثبت نشده است" desc="پالت اصلی کلبه را بسازید تا رنگ‌های سایت از سرور بیاید." />}
        </div>
      </Card>
    </div>
  );
}
