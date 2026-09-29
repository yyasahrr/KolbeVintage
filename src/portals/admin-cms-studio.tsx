import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, Copy, GripVertical, Eye, EyeOff, History, Image as ImageIcon, Loader2, Monitor, Plus, Search, Smartphone, Tablet, Trash2, Upload,
} from "lucide-react";
import {
  studioApi, mediaSrc, type Announcement, type CommerceProduct, type FooterConfig, type HeaderConfig, type AccountAppearance, type SitePage,
} from "../data/experience-api";
import { filesApi } from "../data/api";
import { useStore } from "../data/store";
import { formatPersianDateTime } from "../data/persian-date";
import { CategoryCard, Composable, CommerceCard, type ComposableNode } from "../components/cms-blocks";
import { ServerAnnouncementBar } from "../components/site-chrome";
import { PreviewFrame } from "../components/cms-preview-frame";
import { invalidateCardTemplates, type CardPreviewState, type CardTemplate } from "../components/commerce-card";
import { PersianDatePicker } from "../components/persian-date-picker";
import { Btn, Card, Drawer, Empty, ErrorState, Field, Input, LoadingState, Segmented, Select, Status, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";
import { SeoDomainPanel, SeoLinkButton } from "./admin-seo";
import { InstallmentsPanel } from "./admin-installments";
import { PresetPicker, SchemaSectionEditor, fieldsOf } from "./admin-section-editor";
import type { MegaMenuColumn, RegistryComponent } from "../data/experience-api";

/** A new section starts with the schema defaults plus a title, so required fields are never empty. */
const defaultPayload = (c: RegistryComponent): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fieldsOf(c)) if (f.default !== undefined && f.default !== "") out[f.key] = f.default;
  if (fieldsOf(c).some((f) => f.key === "title") || fieldsOf(c).length === 0) out.title = c.title;
  return out;
};

/* CMS Studio (Req 173-244, 274-283, 322-332): the console for the server-side CMS domains.
   Everything here persists through /admin/cms/*; server validation is the source of truth. */

type F = (m: string) => void;
type Tab = "pages" | "seo" | "themes" | "cards" | "taxonomy" | "collections" | "assets" | "announcements" | "layout" | "builder" | "style" | "reviews" | "insights" | "installments";
const fa = (n: number) => n.toLocaleString("fa-IR");
const errMsg = (e: unknown, d = "خطا") => (e instanceof Error ? e.message : d);

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => { setError(null); try { setData(await fn()); } catch (e) { setError(errMsg(e)); } }, deps);
  useEffect(() => { void load(); }, [load]);
  return { data, error, load };
}

const PAGE_STATUS: Record<string, string> = { draft: "پیش‌نویس", scheduled: "زمان‌بندی‌شده", published: "منتشر شده", archived: "بایگانی" };
const PAGE_TYPE: Record<string, string> = { home: "خانه", about: "درباره ما", landing: "لندینگ", campaign: "کمپین", collection: "کالکشن", vibe: "وایب", lead_generation: "جذب سرنخ", blog_index: "بلاگ", generic: "عمومی" };

export function CmsStudio({ flash }: { flash: F }) {
  const [tab, setTab] = useState<Tab>("pages");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; code: string; title: string; kind: string }[] | null>(null);
  const tabs: { v: Tab; label: string }[] = [
    { v: "pages", label: "صفحات و انتشار" }, { v: "seo", label: "سئو" }, { v: "themes", label: "تم و توکن‌ها" }, { v: "cards", label: "کارت محصول" }, { v: "installments", label: "اقساط" }, { v: "taxonomy", label: "دسته و وایب" },
    { v: "collections", label: "کالکشن‌ها" }, { v: "assets", label: "رسانه‌ها" }, { v: "announcements", label: "نوار اعلان" }, { v: "layout", label: "هدر و فوتر" },
    { v: "builder", label: "کامپوننت‌ساز" }, { v: "style", label: "هوش استایل" }, { v: "reviews", label: "نظرات" }, { v: "insights", label: "سرنخ و آمار" },
  ];
  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!q.trim()) return; try { setResults((await studioApi.search(q.trim())).items); } catch (err) { flash(errMsg(err)); } }}>
        <div className="flex-1"><Input value={q} onChange={setQ} placeholder="جست‌وجو در صفحات، کامپوننت‌ها، قالب‌ها، کمپین‌ها، دسته‌ها، وایب‌ها و رسانه‌ها…" icon={<Search size={15} />} /></div>
        <Btn variant="soft">جست‌وجو</Btn>
      </form>
      {results && <Card className="p-3"><div className="flex flex-wrap gap-2">{results.length === 0 ? <span className="text-[12.5px] text-[var(--kv-muted)]">نتیجه‌ای یافت نشد.</span> : results.map((r) => <span key={`${r.kind}-${r.id}`} className="rounded-full bg-[var(--kv-surface-2)] px-3 py-1 text-[12px]"><b>{r.title}</b> <span className="text-[var(--kv-muted)]">· {r.kind} · {r.code}</span></span>)}<button onClick={() => setResults(null)} className="text-[12px] text-[var(--kv-accent)]">بستن</button></div></Card>}
      <div className="kv-no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1">{tabs.map((t) => <button key={t.v} onClick={() => setTab(t.v)} aria-pressed={tab === t.v} className={cn("shrink-0 rounded-full px-3.5 py-2 text-[12.5px] font-bold", tab === t.v ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)]")}>{t.label}</button>)}</div>
      {tab === "pages" && <PagesPanel flash={flash} />}
      {tab === "seo" && <SeoDomainPanel flash={flash} />}
      {tab === "themes" && <ThemesPanel flash={flash} />}
      {tab === "cards" && <CardsPanel flash={flash} />}
      {tab === "installments" && <InstallmentsPanel flash={flash} />}
      {tab === "taxonomy" && <TaxonomyPanel flash={flash} />}
      {tab === "collections" && <CollectionsPanel flash={flash} />}
      {tab === "assets" && <AssetsPanel flash={flash} />}
      {tab === "announcements" && <AnnouncementsPanel flash={flash} />}
      {tab === "layout" && <LayoutPanel flash={flash} />}
      {tab === "builder" && <BuilderPanel flash={flash} />}
      {tab === "style" && <StylePanel flash={flash} />}
      {tab === "reviews" && <ReviewsPanel flash={flash} />}
      {tab === "insights" && <InsightsPanel />}
    </div>
  );
}

/* ============================ Pages: draft → preview → publish/schedule → versions ============================ */

function PagesPanel({ flash }: { flash: F }) {
  const { data, error, load } = useAsync(() => studioApi.pages());
  const festivals = useAsync(() => studioApi.festivals());
  const [editing, setEditing] = useState<{ id: string; title: string; code: string } | null>(null);
  const [preview, setPreview] = useState<SitePage | null>(null);
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [versions, setVersions] = useState<{ pageId: string; items: Awaited<ReturnType<typeof studioApi.versions>>["items"] } | null>(null);
  const [publishFor, setPublishFor] = useState<{ id: string; title: string; start: string | null; end: string | null; summary: string } | null>(null);
  const [form, setForm] = useState({ code: "", title: "", path: "/", pageType: "landing", template: "blank", campaignId: "" });
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const create = async () => {
    try { await studioApi.createLanding({ code: form.code.trim(), title: form.title.trim(), path: form.path.trim(), pageType: form.pageType, template: form.template, campaignId: form.campaignId || null }); flash("صفحه به‌صورت پیش‌نویس ساخته شد"); setForm({ ...form, code: "", title: "" }); await load(); }
    catch (e) { flash(errMsg(e)); }
  };
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-extrabold">ساخت صفحه / لندینگ جدید</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="کد (انگلیسی)"><Input value={form.code} onChange={(v) => setForm({ ...form, code: v.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="black-friday" /></Field>
          <Field label="عنوان"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field>
          <Field label="مسیر"><Input value={form.path} onChange={(path) => setForm({ ...form, path })} placeholder="/campaign/black-friday" /></Field>
          <Field label="نوع صفحه"><Select options={Object.values(PAGE_TYPE).filter((l) => l !== "خانه" && l !== "بلاگ")} value={PAGE_TYPE[form.pageType]} onChange={(l) => setForm({ ...form, pageType: Object.entries(PAGE_TYPE).find(([, v]) => v === l)?.[0] ?? "landing" })} /></Field>
          <Field label="قالب شروع"><Select options={["خالی", "درباره ما", "کمپین", "وایب", "جذب سرنخ"]} value={({ blank: "خالی", about: "درباره ما", campaign: "کمپین", vibe: "وایب", lead: "جذب سرنخ" } as Record<string, string>)[form.template]} onChange={(l) => setForm({ ...form, template: ({ "خالی": "blank", "درباره ما": "about", "کمپین": "campaign", "وایب": "vibe", "جذب سرنخ": "lead" } as Record<string, string>)[l] ?? "blank" })} /></Field>
          <Field label="اتصال به کمپین (اختیاری)"><Select options={["بدون کمپین", ...(festivals.data?.items ?? []).map((f) => f.name)]} value={(festivals.data?.items ?? []).find((f) => f.id === form.campaignId)?.name ?? "بدون کمپین"} onChange={(l) => setForm({ ...form, campaignId: (festivals.data?.items ?? []).find((f) => f.name === l)?.id ?? "" })} /></Field>
        </div>
        <Btn variant="accent" size="sm" className="mt-3" disabled={form.code.length < 2 || form.title.trim().length < 2 || !form.path.startsWith("/")} onClick={create} icon={<Plus size={14} />}>ایجاد پیش‌نویس</Btn>
      </Card>
      <Card className="overflow-hidden">
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[860px]">
            <thead><tr><th>صفحه</th><th>نوع</th><th>وضعیت</th><th>بخش</th><th>نسخه</th><th>زمان‌بندی</th><th>عملیات</th></tr></thead>
            <tbody>{data.items.map((p) => (
              <tr key={p.id}>
                <td><b className="block">{p.title}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{p.path}</span></td>
                <td>{PAGE_TYPE[p.page_type] ?? p.page_type}</td>
                <td><Status value={PAGE_STATUS[p.status] ?? p.status} /></td>
                <td className="tabular-nums">{fa(Number(p.section_count ?? 0))}</td>
                <td className="tabular-nums">{fa(Number(p.version ?? 1))}</td>
                <td className="text-[11.5px]">{p.scheduled_start_at ? `${formatPersianDateTime(p.scheduled_start_at)}${p.scheduled_end_at ? ` تا ${formatPersianDateTime(p.scheduled_end_at)}` : ""}` : "—"}</td>
                <td><div className="flex flex-wrap gap-1">
                  <Btn size="sm" variant="soft" onClick={() => setEditing({ id: p.id, title: p.title, code: p.code })}>بخش‌ها</Btn>
                  <Btn size="sm" variant="ghost" icon={<Eye size={13} />} onClick={async () => { try { setPreview(await studioApi.preview(p.id)); } catch (e) { flash(errMsg(e)); } }}>پیش‌نمایش</Btn>
                  <Btn size="sm" variant="accent" onClick={() => setPublishFor({ id: p.id, title: p.title, start: null, end: null, summary: "" })}>انتشار</Btn>
                  <SeoLinkButton type="page" entityKey={p.code} name={p.title} flash={flash} />
                  <Btn size="sm" variant="ghost" icon={<History size={13} />} onClick={async () => { try { setVersions({ pageId: p.id, items: (await studioApi.versions(p.id)).items }); } catch (e) { flash(errMsg(e)); } }}>نسخه‌ها</Btn>
                  {p.status !== "draft" && <Btn size="sm" variant="ghost" onClick={async () => { try { await studioApi.unpublish(p.id); flash("صفحه به پیش‌نویس برگشت"); await load(); } catch (e) { flash(errMsg(e)); } }}>لغو انتشار</Btn>}
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <Drawer open={!!editing} onClose={() => { setEditing(null); void load(); }} title={editing ? `بخش‌های «${editing.title}» (پیش‌نویس)` : ""} wide>
        {editing && <SectionsEditor pageId={editing.id} flash={flash} />}
      </Drawer>
      <Drawer open={!!preview} onClose={() => setPreview(null)} title={preview ? `پیش‌نمایش پیش‌نویس · ${preview.title}` : ""} wide>
        {preview && (
          <div className="space-y-3">
            <Segmented<"desktop" | "tablet" | "mobile"> options={[{ v: "desktop", label: "دسکتاپ" }, { v: "tablet", label: "تبلت" }, { v: "mobile", label: "موبایل" }]} value={device} onChange={setDevice} />
            <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]">{device === "desktop" ? <Monitor size={13} /> : device === "tablet" ? <Tablet size={13} /> : <Smartphone size={13} />}پیش‌نمایش با داده واقعی کاتالوگ، قیمت و موجودی — تا انتشار، کاربران نسخه قبلی را می‌بینند.</p>
            <PreviewFrame page={preview} device={device} />
          </div>
        )}
      </Drawer>
      <Drawer open={!!versions} onClose={() => setVersions(null)} title="تاریخچه نسخه‌ها">
        {versions && (versions.items.length === 0 ? <Empty title="هنوز منتشر نشده" desc="با هر انتشار یک نسخه کامل ثبت می‌شود." /> : (
          <ul className="space-y-2">{versions.items.map((v) => (
            <li key={v.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <div className="flex items-center justify-between"><b className="text-[13px]">نسخه {fa(v.version)} · {PAGE_STATUS[v.status] ?? v.status}</b><Btn size="sm" variant="soft" onClick={async () => { try { await studioApi.restore(versions.pageId, v.version); flash(`نسخه ${fa(v.version)} به پیش‌نویس بازگردانده شد؛ برای نمایش در سایت دوباره منتشر کنید`); } catch (e) { flash(errMsg(e)); } }}>بازگردانی</Btn></div>
              <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{formatPersianDateTime(v.created_at)} · {v.changed_by_name ?? "—"} · {fa(v.section_count)} بخش{v.change_summary && ` · ${v.change_summary}`}</p>
            </li>
          ))}</ul>
        ))}
      </Drawer>
      <Drawer open={!!publishFor} onClose={() => setPublishFor(null)} title={publishFor ? `انتشار «${publishFor.title}»` : ""}>
        {publishFor && (
          <div className="space-y-4">
            <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">بدون تاریخ شروع، صفحه همین حالا منتشر می‌شود. با تعیین شروع/پایان، صفحه خودکار فعال و غیرفعال می‌شود.</p>
            <PersianDatePicker label="شروع (اختیاری)" withTime value={publishFor.start} onChange={(start) => setPublishFor({ ...publishFor, start })} />
            <PersianDatePicker label="پایان (اختیاری)" withTime value={publishFor.end} onChange={(end) => setPublishFor({ ...publishFor, end })} />
            <Field label="خلاصه تغییرات"><Input value={publishFor.summary} onChange={(summary) => setPublishFor({ ...publishFor, summary })} /></Field>
            <Btn variant="accent" className="w-full" onClick={async () => {
              try { const r = await studioApi.publish(publishFor.id, { scheduledStartAt: publishFor.start, scheduledEndAt: publishFor.end, changeSummary: publishFor.summary || undefined }); flash(r.status === "scheduled" ? `زمان‌بندی شد (نسخه ${fa(r.version)})` : `منتشر شد (نسخه ${fa(r.version)})`); setPublishFor(null); await load(); }
              catch (e) { flash(errMsg(e)); }
            }}>{publishFor.start ? "زمان‌بندی انتشار" : "انتشار فوری"}</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

function SectionsEditor({ pageId, flash }: { pageId: string; flash: F }) {
  const sections = useAsync(() => studioApi.sections(pageId), [pageId]);
  const registry = useAsync(() => studioApi.registry());
  const [editId, setEditId] = useState<string | null>(null);
  const [addCode, setAddCode] = useState("");
  const [addPreset, setAddPreset] = useState("");
  // Req 177: drag & drop reorder (mouse/pen); arrow buttons remain for keyboard and touch.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ id: string }[] | null>(null);
  if (sections.error) return <ErrorState message={sections.error} onRetry={sections.load} />;
  if (!sections.data || !registry.data) return <LoadingState />;
  const serverItems = sections.data.items;
  const items = optimistic ? optimistic.map((o) => serverItems.find((s) => s.id === o.id)!).filter(Boolean) : serverItems;
  const dropOn = async (targetId: string, sourceId: string | null) => {
    const from = items.findIndex((x) => x.id === sourceId); const to = items.findIndex((x) => x.id === targetId);
    setDragId(null); setOverId(null);
    if (from < 0 || to < 0 || from === to) return;
    const list = [...items]; const [moved] = list.splice(from, 1); list.splice(to, 0, moved!);
    setOptimistic(list.map((x) => ({ id: x.id })));
    try { await studioApi.reorder(pageId, list.map((x) => x.id)); await sections.load(); flash("ترتیب بخش‌ها در پیش‌نویس ذخیره شد"); }
    catch (e) { flash(errMsg(e)); } finally { setOptimistic(null); }
  };
  const comps = registry.data.items;
  const editing = editId ? items.find((x) => x.id === editId) : undefined;
  const move = async (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= items.length) return;
    const list = [...items]; [list[i], list[j]] = [list[j]!, list[i]!];
    try { await studioApi.reorder(pageId, list.map((s) => s.id)); await sections.load(); } catch (e) { flash(errMsg(e)); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1"><Field label="افزودن کامپوننت از رجیستری"><Select options={["انتخاب کنید", ...comps.filter((c) => c.active !== false).map((c) => c.title)]} value={comps.find((c) => c.code === addCode)?.title ?? "انتخاب کنید"} onChange={(l) => setAddCode(comps.find((c) => c.title === l)?.code ?? "")} /></Field></div>
        <Btn variant="accent" size="sm" disabled={!addCode} icon={<Plus size={14} />} onClick={async () => {
          const c = comps.find((x) => x.code === addCode)!;
          try {
            const created = await studioApi.addSection(pageId, { componentCode: c.code, title: c.title, payload: defaultPayload(c), visible: true, ...(addPreset ? { presetCode: addPreset } : {}) });
            setAddCode(""); setAddPreset(""); await sections.load(); setEditId(created.id);
          } catch (e) { flash(errMsg(e)); }
        }}>افزودن</Btn>
      </div>
      {addCode && <PresetPicker component={comps.find((c) => c.code === addCode)} value={addPreset} onChange={setAddPreset} />}
      {items.length === 0 && <Empty title="این صفحه بخشی ندارد" desc="از رجیستری یک کامپوننت اضافه کنید." />}
      <ul className="space-y-2">{items.map((s, i) => {
        const comp = comps.find((c) => c.code === s.componentCode);
        return (
          <li key={s.id} draggable data-section-id={s.id}
            onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.id); }}
            onDragOver={(e) => { if (!e.dataTransfer.types.includes("text/plain")) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overId !== s.id) setOverId(s.id); }}
            onDragLeave={() => { if (overId === s.id) setOverId(null); }}
            onDrop={(e) => { e.preventDefault(); void dropOn(s.id, e.dataTransfer.getData("text/plain") || dragId); }}
            onDragEnd={() => { setDragId(null); setOverId(null); }}
            aria-roledescription="بخش قابل جابه‌جایی"
            className={cn("flex flex-wrap items-center gap-2 rounded-[12px] border p-2.5 transition-colors", s.visible ? "border-[var(--kv-line)]" : "border-dashed opacity-60",
              dragId === s.id && "opacity-40", overId === s.id && dragId !== s.id && "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]")}>
            <span className="hidden cursor-grab select-none px-1 text-[var(--kv-muted)] active:cursor-grabbing sm:block" title="برای جابه‌جایی بکشید" aria-hidden><GripVertical size={16} /></span>
            <div className="flex flex-col"><button aria-label="بالا" onClick={() => move(i, -1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowUp size={13} /></button><button aria-label="پایین" onClick={() => move(i, 1)} className="flex h-7 w-8 items-center justify-center rounded hover:bg-[var(--kv-surface-2)]"><ArrowDown size={13} /></button></div>
            <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-bold">{s.title || s.componentCode}</p><p className="text-[11px] text-[var(--kv-muted)]">{comp?.title ?? s.componentCode}{s.variant && s.variant !== "default" ? ` · ${s.variant}` : ""}{s.preset ? ` · Preset: ${s.preset}` : ""}</p></div>
            <Btn size="sm" variant="soft" onClick={() => setEditId(editId === s.id ? null : s.id)}>ویرایش</Btn>
            <button aria-label="تکثیر" onClick={async () => { await studioApi.duplicateSection(s.id); await sections.load(); }} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><Copy size={14} /></button>
            <button aria-label={s.visible ? "پنهان کردن" : "نمایش"} onClick={async () => { await studioApi.updateSection(s.id, { visible: !s.visible }); await sections.load(); }} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]">{s.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
            <button aria-label="حذف" onClick={async () => { await studioApi.deleteSection(s.id); await sections.load(); }} className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={14} /></button>
          </li>
        );
      })}</ul>
      {editing && <SchemaSectionEditor key={editing.id} section={editing} component={comps.find((c) => c.code === editing.componentCode)} styleSpec={registry.data.styleSpec ?? {}}
        simpleStyleKeys={registry.data.simpleStyleKeys ?? []} flash={flash} onCancel={() => setEditId(null)} onSaved={() => { setEditId(null); void sections.load(); }} />}
    </div>
  );
}

/* ============================ Themes (Req 218-228) ============================ */

const TOKEN_LABEL: Record<string, string> = { background: "پس‌زمینه", surface: "سطح کارت", surfaceSecondary: "سطح دوم", textPrimary: "متن اصلی", textSecondary: "متن فرعی", primary: "رنگ اصلی/هدر", secondary: "رنگ دوم", accent: "تأکیدی", border: "خط", success: "موفق", warning: "هشدار", danger: "خطا" };
function ThemesPanel({ flash }: { flash: F }) {
  const { data, error, load } = useAsync(() => studioApi.themes());
  const festivals = useAsync(() => studioApi.festivals());
  const [schedule, setSchedule] = useState<{ id: string; start: string | null; end: string | null } | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "", tokens: { background: "#FFF7F9", surface: "#FFFFFF", surfaceSecondary: "#FCE8EE", textPrimary: "#2D0C18", textSecondary: "#7A4458", primary: "#5C162E", secondary: "#C93B61", accent: "#C93B61", border: "#F3CEDB", success: "#2E6B47", warning: "#B7791F", danger: "#B42318" } as Record<string, string> });
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((t) => {
          const tk = t.design_tokens ?? {}; const live = t.activations.some((a) => a.active && new Date(a.startsAt) <= new Date() && (!a.endsAt || new Date(a.endsAt) > new Date()));
          return (
            <Card key={t.id} className="overflow-hidden">
              <div className="p-4" style={{ background: tk.background, color: tk.textPrimary }}>
                <div className="flex items-center justify-between"><b className="text-[14px]">{t.name}</b>{live && <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: tk.accent, color: "#fff" }}>فعال</span>}</div>
                <div className="mt-3 rounded-[12px] p-3" style={{ background: tk.surface, border: `1px solid ${tk.border}` }}><p className="text-[12px]" style={{ color: tk.textSecondary }}>پیش‌نمایش کارت</p><span className="mt-2 inline-block rounded-[8px] px-3 py-1 text-[11.5px] font-bold text-white" style={{ background: tk.accent }}>دکمه</span></div>
                <div className="mt-3 flex gap-1">{Object.values(tk).filter((v) => typeof v === "string" && v.startsWith("#")).slice(0, 8).map((c, i) => <span key={i} className="h-4 w-4 rounded-full border border-black/10" style={{ background: c }} />)}</div>
              </div>
              <div className="space-y-2 p-3">
                {t.campaign_name && <p className="text-[11.5px] text-[var(--kv-muted)]">متصل به کمپین: {t.campaign_name}</p>}
                <div className="flex flex-wrap gap-1.5">
                  <Btn size="sm" variant="accent" onClick={async () => { try { await studioApi.activateTheme(t.id, { mode: "manual" }); flash(`تم «${t.name}» فعال شد`); await load(); } catch (e) { flash(errMsg(e)); } }}>فعال‌سازی</Btn>
                  <Btn size="sm" variant="soft" onClick={() => setSchedule({ id: t.id, start: null, end: null })}>زمان‌بندی</Btn>
                </div>
                <Select options={["بدون کمپین", ...(festivals.data?.items ?? []).map((f) => f.name)]} value={t.campaign_name ?? "بدون کمپین"} onChange={async (l) => { const f = (festivals.data?.items ?? []).find((x) => x.name === l); try { await studioApi.bindThemeCampaign(t.id, f?.id ?? null); flash(f ? `با شروع «${f.name}» این تم فعال می‌شود` : "اتصال کمپین حذف شد"); await load(); } catch (e) { flash(errMsg(e)); } }} />
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="p-4">
        <p className="mb-3 text-[14px] font-extrabold">ساخت تم جدید</p>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="کد"><Input value={draft.code} onChange={(v) => setDraft({ ...draft, code: v.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} placeholder="valentine-2027" /></Field><Field label="نام"><Input value={draft.name} onChange={(name) => setDraft({ ...draft, name })} /></Field></div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {Object.entries(draft.tokens).map(([k, v]) => <label key={k} className="flex flex-col gap-1 text-[11.5px] font-semibold">{TOKEN_LABEL[k] ?? k}<span className="flex items-center gap-1.5"><input type="color" value={v} onChange={(e) => setDraft({ ...draft, tokens: { ...draft.tokens, [k]: e.target.value } })} className="h-9 w-10 cursor-pointer rounded border border-[var(--kv-line)]" aria-label={TOKEN_LABEL[k]} /><span dir="ltr" className="text-[10.5px]">{v}</span></span></label>)}
        </div>
        <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">محافظ طراحی: کنتراست متن اصلی با پس‌زمینه و کارت باید حداقل ۴٫۵ باشد؛ در غیر این صورت سرور تم را نمی‌پذیرد.</p>
        <Btn variant="accent" size="sm" className="mt-3" disabled={draft.code.length < 2 || draft.name.length < 2} onClick={async () => { try { const r = await studioApi.createTheme({ code: draft.code, name: draft.name, tokens: draft.tokens }); flash(`تم ساخته شد (کنتراست ${fa(r.contrast.bodyContrast)})`); await load(); } catch (e) { flash(errMsg(e)); } }}>ساخت تم</Btn>
      </Card>
      <Drawer open={!!schedule} onClose={() => setSchedule(null)} title="زمان‌بندی تم">
        {schedule && <div className="space-y-4"><PersianDatePicker label="شروع" withTime value={schedule.start} onChange={(start) => setSchedule({ ...schedule, start })} /><PersianDatePicker label="پایان" withTime value={schedule.end} onChange={(end) => setSchedule({ ...schedule, end })} />
          <p className="text-[11.5px] text-[var(--kv-muted)]">پس از پایان، تم قبلی (دستی) خودکار برمی‌گردد.</p>
          <Btn variant="accent" className="w-full" disabled={!schedule.start || !schedule.end} onClick={async () => { try { await studioApi.activateTheme(schedule.id, { mode: "scheduled", startsAt: schedule.start!, endsAt: schedule.end }); flash("تم زمان‌بندی شد"); setSchedule(null); await load(); } catch (e) { flash(errMsg(e)); } }}>ثبت زمان‌بندی</Btn></div>}
      </Drawer>
    </div>
  );
}

/* ============================ Product cards & rules (Req 192-198) ============================ */

const BLOCKS = ["image", "badge", "brand", "name", "original_price", "discount_price", "installment", "rating", "cta", "countdown", "swatches"];
const BLOCK_LABEL: Record<string, string> = { image: "تصویر", badge: "نشان", brand: "برند", name: "نام", original_price: "قیمت قبل", discount_price: "قیمت نهایی", installment: "اقساط", rating: "امتیاز", cta: "دکمه", countdown: "شمارش", swatches: "رنگ‌ها" };
function CardsPanel({ flash }: { flash: F }) {
  const templates = useAsync(() => studioApi.cardTemplates());
  const rules = useAsync(() => studioApi.cardRules());
  const { products: storeProducts } = useStore();
  const [tpl, setTpl] = useState({ id: "", code: "", name: "", variant: "custom", blocks: ["image", "badge", "name", "discount_price", "installment", "cta"], accentColor: "#1B2A4A", radius: "18px",
    aspectRatio: "3/4", ctaStyle: "solid", hoverEffect: "zoom", titleLines: 2, badgeText: "", darkSurface: false, serifTitle: false, prominentInstallment: false, highlightDiscount: false });
  const [previewState, setPreviewState] = useState<CardPreviewState>("default");
  const [sampleKind, setSampleKind] = useState<"long" | "image" | "sale" | "soldout">("long");
  const styles = { accentColor: tpl.accentColor, radius: tpl.radius, aspectRatio: tpl.aspectRatio, ctaStyle: tpl.ctaStyle, hoverEffect: tpl.hoverEffect, titleLines: tpl.titleLines,
    ...(tpl.badgeText.trim() ? { badgeText: tpl.badgeText.trim() } : {}), ...(tpl.darkSurface ? { darkSurface: true } : {}), ...(tpl.serifTitle ? { serifTitle: true } : {}),
    ...(tpl.prominentInstallment ? { prominentInstallment: true } : {}), ...(tpl.highlightDiscount ? { highlightDiscount: true } : {}) };
  const [gate, setGate] = useState<{ passed: boolean; checks: Record<string, boolean>; contrast: number } | null>(null);
  const [rule, setRule] = useState({ name: "", priority: 10, minDiscountPercent: "", isNew: false, installmentEnabled: false, templateCode: "kolbe-sale" });
  const styleKey = JSON.stringify(styles);
  useEffect(() => { const t = window.setTimeout(() => { studioApi.qualityCheck({ blocks: tpl.blocks, styles: JSON.parse(styleKey) }).then(setGate).catch(() => setGate(null)); }, 300); return () => window.clearTimeout(t); }, [tpl.blocks, styleKey]);
  if (templates.error) return <ErrorState message={templates.error} onRetry={templates.load} />;
  if (!templates.data || !rules.data) return <LoadingState />;
  const base: CommerceProduct = { id: "sample", name: "کت پشمی دو‌دکمه کلبه با عنوان طولانی برای تست حالت چندخطی", brand: "Kolbe", category: "کت", productType: "coat", gender: "unisex", seasons: [], vibes: [], priceRial: "89000000", installmentPriceRial: "92000000", perInstallmentRial: "23000000", compareAtRial: "129000000", discountPercent: 31, installmentEnabled: true, installmentProviders: [], image: null, flatLay: null, available: 3, isNew: true, createdAt: new Date().toISOString(), rating: 4.6, reviewCount: 12,
    variants: [{ id: "v1", sku: "S-1", size: "M", color: "مشکی", available: 2 }, { id: "v2", sku: "S-2", size: "L", color: "کرم", available: 1 }] };
  const storeImage = storeProducts.find((p) => p.images?.[0])?.images[0] ?? null;
  const sample: CommerceProduct = sampleKind === "image" ? { ...base, name: "پیراهن کتان", image: storeImage, compareAtRial: null, discountPercent: 0 }
    : sampleKind === "sale" ? { ...base, name: "بارانی کلاسیک", image: storeImage, discountPercent: 45, compareAtRial: "162000000" }
    : sampleKind === "soldout" ? { ...base, name: "ژاکت بافت", image: storeImage, available: 0 } : base;
  const draftTemplate: CardTemplate = { code: tpl.code || "draft", name: tpl.name || "پیش‌نویس", variant: tpl.variant, blocks: tpl.blocks, styles };
  const editTemplate = (t: { id: string; code: string; name: string; variant: string; blocks: string[]; styles: Record<string, unknown> }) => {
    const st = t.styles as Record<string, string | number | boolean | undefined>;
    setTpl({ id: t.id, code: t.code, name: t.name, variant: t.variant, blocks: t.blocks, accentColor: String(st.accentColor ?? "#1B2A4A"), radius: String(st.radius ?? "18px"), aspectRatio: String(st.aspectRatio ?? "3/4"),
      ctaStyle: String(st.ctaStyle ?? "solid"), hoverEffect: String(st.hoverEffect ?? "zoom"), titleLines: Number(st.titleLines ?? 2), badgeText: String(st.badgeText ?? ""), darkSurface: !!st.darkSurface,
      serifTitle: !!st.serifTitle, prominentInstallment: !!st.prominentInstallment, highlightDiscount: !!st.highlightDiscount });
  };
  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">پیش‌نمایش حالت‌ها (Req 183، 198): هر قالب با داده نمونه و در حالت‌های عادی، hover، در حال افزودن، افزوده‌شده، ناموجود و اسکلتون نمایش داده می‌شود.</p>
      <div className="flex flex-wrap gap-3" data-testid="card-state-controls">
        <Segmented<CardPreviewState> options={[{ v: "default", label: "عادی" }, { v: "hover", label: "Hover" }, { v: "loading", label: "در حال افزودن" }, { v: "added", label: "افزوده شد" }, { v: "soldout", label: "ناموجود" }, { v: "skeleton", label: "اسکلتون" }]} value={previewState} onChange={setPreviewState} />
        <Segmented<"long" | "image" | "sale" | "soldout"> options={[{ v: "long", label: "عنوان بلند، بی‌تصویر" }, { v: "image", label: "با تصویر" }, { v: "sale", label: "تخفیف" }, { v: "soldout", label: "موجودی صفر" }]} value={sampleKind} onChange={setSampleKind} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {templates.data.items.map((t) => (
          <div key={t.id} className="space-y-1.5"><CommerceCard product={sample} template={{ code: t.code, name: t.name, variant: t.variant, blocks: t.blocks, styles: t.styles as CardTemplate["styles"] }} previewState={previewState} />
            <button onClick={() => editTemplate(t)} className="text-[11px] font-bold text-[var(--kv-accent)]">{t.is_system ? "کپی و ویرایش" : "ویرایش"}</button><p className="text-[11.5px] font-bold">{t.name}</p><p className={cn("text-[10.5px]", t.quality_report?.passed ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]")}>{t.quality_report?.passed ? "کنترل کیفیت: قبول" : "کنترل کیفیت: رد"} · {t.active ? "فعال" : "غیرفعال"}</p></div>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between"><p className="text-[14px] font-extrabold">{tpl.id ? `ویرایش قالب «${tpl.name}»` : "طراح کارت محصول"}</p>{tpl.id && <button className="text-[11.5px] text-[var(--kv-muted)]" onClick={() => setTpl({ ...tpl, id: "", code: "", name: "" })}>قالب جدید</button>}</div>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="کد"><Input value={tpl.code} onChange={(v) => setTpl({ ...tpl, code: v.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field><Field label="نام"><Input value={tpl.name} onChange={(name) => setTpl({ ...tpl, name })} /></Field></div>
          <div className="flex flex-wrap gap-1.5">{BLOCKS.map((b) => <button key={b} onClick={() => setTpl({ ...tpl, blocks: tpl.blocks.includes(b) ? tpl.blocks.filter((x) => x !== b) : [...tpl.blocks, b] })} aria-pressed={tpl.blocks.includes(b)} className={cn("rounded-full border px-3 py-1 text-[11.5px] font-bold", tpl.blocks.includes(b) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)]")}>{BLOCK_LABEL[b]}</button>)}</div>
          <div className="flex flex-wrap items-end gap-3"><label className="text-[12px] font-semibold">رنگ تأکیدی <input type="color" value={tpl.accentColor} onChange={(e) => setTpl({ ...tpl, accentColor: e.target.value })} className="mr-2 h-9 w-10 rounded border border-[var(--kv-line)]" /></label><Field label="گردی گوشه"><Select options={["12px", "14px", "18px", "22px", "28px"]} value={tpl.radius} onChange={(radius) => setTpl({ ...tpl, radius })} /></Field>
            <Field label="نسبت تصویر"><Select options={["3/4", "4/5", "1/1"]} value={tpl.aspectRatio} onChange={(aspectRatio) => setTpl({ ...tpl, aspectRatio })} /></Field>
            <Field label="دکمه"><Select options={["solid", "outline", "ghost"]} value={tpl.ctaStyle} onChange={(ctaStyle) => setTpl({ ...tpl, ctaStyle })} /></Field>
            <Field label="Hover"><Select options={["zoom", "lift", "shadow", "none"]} value={tpl.hoverEffect} onChange={(hoverEffect) => setTpl({ ...tpl, hoverEffect })} /></Field>
            <Field label="خطوط عنوان"><Select options={["1", "2", "3"]} value={String(tpl.titleLines)} onChange={(v) => setTpl({ ...tpl, titleLines: Number(v) })} /></Field>
            <Field label="متن نشان"><Input className="w-32" value={tpl.badgeText} onChange={(badgeText) => setTpl({ ...tpl, badgeText })} /></Field></div>
          <div className="flex flex-wrap gap-4 text-[12px]">
            {([["darkSurface", "سطح تیره"], ["serifTitle", "عنوان سریف"], ["prominentInstallment", "اقساط برجسته"], ["highlightDiscount", "تأکید تخفیف"]] as const).map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={tpl[k]} onChange={(e) => setTpl({ ...tpl, [k]: e.target.checked })} />{l}</label>)}
          </div>
          <div className="grid grid-cols-2 gap-3 rounded-[14px] bg-[var(--kv-surface-2)] p-3" data-testid="card-draft-preview">
            <CommerceCard product={sample} template={draftTemplate} previewState={previewState} />
            <CommerceCard product={{ ...sample, image: null, name: base.name }} template={draftTemplate} previewState={previewState === "default" ? "hover" : "default"} />
          </div>
          {gate && <div className="rounded-[12px] bg-[var(--kv-surface-2)] p-3 text-[11.5px]"><b className={gate.passed ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]"}>{gate.passed ? "از کنترل کیفیت طراحی عبور کرد" : "کنترل کیفیت رد شد"}</b> · کنتراست {fa(gate.contrast)}<div className="mt-1 flex flex-wrap gap-1.5">{Object.entries(gate.checks).map(([k, v]) => <span key={k} className={v ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]"}>{v ? "✓" : "✗"} {k}</span>)}</div></div>}
          <Btn variant="accent" size="sm" disabled={!tpl.code || !tpl.name || !gate?.passed} onClick={async () => {
            const current = templates.data!.items.find((t) => t.id === tpl.id);
            try {
              if (current && !current.is_system) await studioApi.updateCardTemplate(tpl.id, { name: tpl.name, variant: tpl.variant, blocks: tpl.blocks, styles });
              else await studioApi.createCardTemplate({ code: current?.is_system && current.code === tpl.code ? `${tpl.code}-custom` : tpl.code, name: tpl.name, variant: tpl.variant, blocks: tpl.blocks, styles });
              invalidateCardTemplates(); flash(current && !current.is_system ? "قالب به‌روزرسانی شد" : "قالب کارت ساخته شد"); await templates.load();
            } catch (e) { flash(errMsg(e)); }
          }}>{tpl.id && !templates.data.items.find((t) => t.id === tpl.id)?.is_system ? "به‌روزرسانی قالب" : "ذخیره قالب"}</Btn>
        </Card>
        <Card className="space-y-3 p-4">
          <p className="text-[14px] font-extrabold">قوانین انتخاب کارت (اولویت کمتر = مهم‌تر)</p>
          <ul className="space-y-1.5">{rules.data.items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[12px]">
              <b className="w-6 tabular-nums">{fa(r.priority)}</b><span className="min-w-0 flex-1">{r.name} → <code dir="ltr">{r.template_code}</code></span>
              <Switch on={r.active} onToggle={async () => { await studioApi.updateCardRule(r.id, { active: !r.active }); await rules.load(); }} />
              <button aria-label="حذف قانون" onClick={async () => { await studioApi.deleteCardRule(r.id); await rules.load(); }} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button>
            </li>
          ))}</ul>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="نام قانون"><Input value={rule.name} onChange={(name) => setRule({ ...rule, name })} /></Field><Field label="اولویت"><Input value={String(rule.priority)} onChange={(v) => setRule({ ...rule, priority: Number(v.replace(/\D/g, "")) || 1 })} /></Field>
            <Field label="حداقل تخفیف ٪"><Input value={rule.minDiscountPercent} onChange={(v) => setRule({ ...rule, minDiscountPercent: v.replace(/\D/g, "") })} /></Field>
            <Field label="قالب"><Select options={templates.data.items.filter((t) => t.active).map((t) => t.code)} value={rule.templateCode} onChange={(templateCode) => setRule({ ...rule, templateCode })} /></Field></div>
          <div className="flex gap-4 text-[12px]"><label className="flex items-center gap-1.5"><input type="checkbox" checked={rule.isNew} onChange={(e) => setRule({ ...rule, isNew: e.target.checked })} />فقط محصولات جدید</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={rule.installmentEnabled} onChange={(e) => setRule({ ...rule, installmentEnabled: e.target.checked })} />فقط اقساطی</label></div>
          <Btn variant="accent" size="sm" disabled={!rule.name} onClick={async () => { try { await studioApi.createCardRule({ name: rule.name, priority: rule.priority, templateCode: rule.templateCode, conditions: { ...(rule.minDiscountPercent ? { minDiscountPercent: Number(rule.minDiscountPercent) } : {}), ...(rule.isNew ? { isNew: true } : {}), ...(rule.installmentEnabled ? { installmentEnabled: true } : {}) } }); flash("قانون افزوده شد"); await rules.load(); } catch (e) { flash(errMsg(e)); } }}>افزودن قانون</Btn>
        </Card>
      </div>
    </div>
  );
}

/* ============================ Taxonomy (Req 199-205) ============================ */

function TaxonomyPanel({ flash }: { flash: F }) {
  const [kind, setKind] = useState<"categories" | "vibes">("vibes");
  const { data, error, load } = useAsync(() => studioApi.taxonomy(kind), [kind]);
  const [form, setForm] = useState({ name: "", slug: "", description: "", coverUrl: "", cardTemplate: "editorial" });
  const [styleFor, setStyleFor] = useState<{ id: string; name: string; slug: string; description: string; cover: string | null; cardTemplate: string; cardStyle: CategoryCardStyle } | null>(null);
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <div className="space-y-4">
      <Segmented<"categories" | "vibes"> options={[{ v: "vibes", label: "وایب‌ها" }, { v: "categories", label: "دسته‌بندی‌ها" }]} value={kind} onChange={setKind} />
      {!data ? <LoadingState /> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.items.map((t) => (
          <Card key={t.id} className="flex items-start justify-between gap-2 p-4">
            <div className="min-w-0"><p className="text-[13.5px] font-bold">{t.name}</p><p className="text-[11px] text-[var(--kv-muted)]" dir="ltr">/{kind === "vibes" ? "vibe" : "category"}/{t.slug}</p><p className="mt-1 line-clamp-2 text-[12px] text-[var(--kv-muted)]">{t.description}</p><p className="mt-1 text-[11px]">{fa(t.product_count)} محصول</p></div>
            <div className="flex flex-col items-end gap-2">
              <Switch on={t.active} onToggle={async () => { try { await studioApi.updateTaxonomy(kind, t.id, { active: !t.active }); await load(); } catch (e) { flash(errMsg(e)); } }} />
              <SeoLinkButton type={kind === "vibes" ? "vibe" : "category"} entityKey={t.slug} name={t.name} flash={flash} />
              {kind === "categories" && <Btn size="sm" variant="ghost" onClick={() => setStyleFor({ id: t.id, name: t.name, slug: t.slug, description: t.description, cover: (t.cover_url as string | null) ?? (t.image_url as string | null) ?? null, cardTemplate: String(t.card_template ?? "editorial"), cardStyle: (t.card_style as CategoryCardStyle) ?? {} })}>ظاهر کارت</Btn>}
            </div>
          </Card>
        ))}</div>
      )}
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">{kind === "vibes" ? "وایب جدید" : "دسته جدید"}</p>
        <div className="grid gap-2 sm:grid-cols-2"><Field label="نام"><Input value={form.name} onChange={(name) => setForm({ ...form, name })} /></Field><Field label="Slug"><Input value={form.slug} onChange={(v) => setForm({ ...form, slug: v.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field>
          <Field label="کاور (https یا مسیر رسانه)"><Input value={form.coverUrl} onChange={(coverUrl) => setForm({ ...form, coverUrl })} /></Field>
          {kind === "categories" && <Field label="قالب کارت"><Select options={["image", "editorial", "minimal", "glass", "overlay", "horizontal"]} value={form.cardTemplate} onChange={(cardTemplate) => setForm({ ...form, cardTemplate })} /></Field>}</div>
        <Field label="توضیح"><Textarea rows={2} value={form.description} onChange={(description) => setForm({ ...form, description })} /></Field>
        <Btn variant="accent" size="sm" disabled={!form.name || form.slug.length < 2} onClick={async () => { try { await studioApi.createTaxonomy(kind, { name: form.name, slug: form.slug, description: form.description, coverUrl: form.coverUrl || null, ...(kind === "categories" ? { cardTemplate: form.cardTemplate } : {}) }); flash("ذخیره شد"); setForm({ name: "", slug: "", description: "", coverUrl: "", cardTemplate: "editorial" }); await load(); } catch (e) { flash(errMsg(e)); } }}>ذخیره</Btn>
      </Card>
      <Drawer open={!!styleFor} onClose={() => setStyleFor(null)} title={styleFor ? `ظاهر کارت «${styleFor.name}»` : ""}>
        {styleFor && (() => {
          const cs = styleFor.cardStyle;
          const set = (patch: Partial<CategoryCardStyle>) => setStyleFor({ ...styleFor, cardStyle: { ...cs, ...patch } });
          return (
            <div className="space-y-3" data-testid="category-style-editor">
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="قالب"><Select options={["image", "editorial", "minimal", "glass", "overlay", "horizontal"]} value={styleFor.cardTemplate} onChange={(cardTemplate) => setStyleFor({ ...styleFor, cardTemplate })} /></Field>
                <Field label="نسبت تصویر"><Select options={["4/3", "1/1", "3/4", "16/9"]} value={cs.aspect ?? "4/3"} onChange={(aspect) => set({ aspect: aspect as CategoryCardStyle["aspect"] })} /></Field>
                <Field label="گردی"><Select options={["sm", "md", "lg", "xl"]} value={cs.radius ?? "lg"} onChange={(radius) => set({ radius: radius as CategoryCardStyle["radius"] })} /></Field>
                <Field label="رنگ زمینه"><Select options={["surface", "accent", "primary"]} value={cs.accent ?? "surface"} onChange={(accent) => set({ accent: accent as CategoryCardStyle["accent"] })} /></Field>
                <Field label="چینش متن"><Select options={["start", "center"]} value={cs.textAlign ?? "start"} onChange={(textAlign) => set({ textAlign: textAlign as CategoryCardStyle["textAlign"] })} /></Field>
                <Field label={`تیرگی لایه (${fa(cs.overlay ?? 30)}٪)`}><input type="range" min={0} max={80} step={5} value={cs.overlay ?? 30} onChange={(e) => set({ overlay: Number(e.target.value) })} className="w-full accent-[var(--kv-accent)]" /></Field>
              </div>
              <label className="flex items-center gap-2 text-[12.5px]"><Switch on={cs.showDescription !== false} onToggle={() => set({ showDescription: cs.showDescription === false })} />نمایش توضیح</label>
              <div className="rounded-[14px] bg-[var(--kv-surface-2)] p-3"><p className="mb-2 text-[11.5px] font-bold text-[var(--kv-muted)]">پیش‌نمایش زنده</p>
                <div className="max-w-[280px]"><CategoryCard category={{ id: styleFor.id, name: styleFor.name, slug: styleFor.slug, description: styleFor.description, image_url: styleFor.cover, cover_url: styleFor.cover, card_template: styleFor.cardTemplate, card_style: cs }} /></div></div>
              <Btn variant="accent" className="w-full" onClick={async () => { try { await studioApi.updateTaxonomy("categories", styleFor.id, { cardTemplate: styleFor.cardTemplate, cardStyle: cs }); flash("ظاهر کارت ذخیره شد"); setStyleFor(null); await load(); } catch (e) { flash(errMsg(e)); } }}>ذخیره ظاهر</Btn>
            </div>
          );
        })()}
      </Drawer>
    </div>
  );
}

type CategoryCardStyle = { aspect?: "4/3" | "1/1" | "3/4" | "16/9"; radius?: "sm" | "md" | "lg" | "xl"; overlay?: number; textAlign?: "start" | "center"; showDescription?: boolean; accent?: "accent" | "primary" | "surface" };

/* ============================ Collections (Req 206-208) ============================ */

function CollectionsPanel({ flash }: { flash: F }) {
  const { products } = useStore();
  const { data, error, load } = useAsync(() => studioApi.collections());
  const vibes = useAsync(() => studioApi.taxonomy("vibes"));
  const [form, setForm] = useState({ code: "", title: "", mode: "dynamic" as "dynamic" | "manual", category: "", vibe: "", season: "", gender: "", minDiscountPercent: "", inStockOnly: true, installmentEnabled: false, sortBy: "newest", limit: "8", productIds: [] as string[] });
  const [preview, setPreview] = useState<CommerceProduct[] | null>(null);
  const rules = useMemo(() => ({ ...(form.category ? { category: form.category } : {}), ...(form.vibe ? { vibe: form.vibe } : {}), ...(form.season ? { season: form.season } : {}), ...(form.gender ? { gender: form.gender } : {}),
    ...(form.minDiscountPercent ? { minDiscountPercent: Number(form.minDiscountPercent) } : {}), inStockOnly: form.inStockOnly, ...(form.installmentEnabled ? { installmentEnabled: true } : {}), sortBy: form.sortBy, limit: Number(form.limit) || 8 }), [form]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const cats = Array.from(new Set(products.map((p) => p.category)));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{data.items.map((c) => <Card key={c.id} className="p-4"><div className="flex items-center justify-between"><b className="text-[13px]">{c.title}</b><Status value={c.mode === "manual" ? "دستی" : "پویا"} /></div><p className="mt-1 text-[11px] text-[var(--kv-muted)]" dir="ltr">{c.code}</p><p className="mt-2 text-[11px] leading-5 text-[var(--kv-muted)]" dir="ltr">{c.mode === "manual" ? `${c.product_ids.length} products` : JSON.stringify(c.query_rules)}</p><div className="mt-2"><SeoLinkButton type="collection" entityKey={c.code} name={c.title} flash={flash} /></div></Card>)}</div>
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">کالکشن جدید</p>
        <div className="grid gap-2 sm:grid-cols-3"><Field label="کد"><Input value={form.code} onChange={(v) => setForm({ ...form, code: v.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field><Field label="عنوان"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field>
          <Field label="نوع"><Segmented<"dynamic" | "manual"> options={[{ v: "dynamic", label: "پویا (Query)" }, { v: "manual", label: "دستی" }]} value={form.mode} onChange={(mode) => setForm({ ...form, mode })} /></Field></div>
        {form.mode === "dynamic" ? (
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="دسته"><Select options={["همه", ...cats]} value={form.category || "همه"} onChange={(v) => setForm({ ...form, category: v === "همه" ? "" : v })} /></Field>
            <Field label="وایب"><Select options={["همه", ...(vibes.data?.items ?? []).map((v) => v.slug)]} value={form.vibe || "همه"} onChange={(v) => setForm({ ...form, vibe: v === "همه" ? "" : v })} /></Field>
            <Field label="فصل"><Select options={["همه", "spring", "summer", "autumn", "winter"]} value={form.season || "همه"} onChange={(v) => setForm({ ...form, season: v === "همه" ? "" : v })} /></Field>
            <Field label="جنسیت"><Select options={["همه", "men", "women", "unisex", "kids"]} value={form.gender || "همه"} onChange={(v) => setForm({ ...form, gender: v === "همه" ? "" : v })} /></Field>
            <Field label="حداقل تخفیف ٪"><Input value={form.minDiscountPercent} onChange={(v) => setForm({ ...form, minDiscountPercent: v.replace(/\D/g, "") })} /></Field>
            <Field label="مرتب‌سازی"><Select options={["newest", "popular", "price_asc", "price_desc", "discount"]} value={form.sortBy} onChange={(sortBy) => setForm({ ...form, sortBy })} /></Field>
            <Field label="تعداد"><Input value={form.limit} onChange={(v) => setForm({ ...form, limit: v.replace(/\D/g, "") })} /></Field>
            <div className="flex flex-col justify-end gap-1 text-[12px]"><label className="flex items-center gap-1.5"><input type="checkbox" checked={form.inStockOnly} onChange={(e) => setForm({ ...form, inStockOnly: e.target.checked })} />فقط موجود (WMS)</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={form.installmentEnabled} onChange={(e) => setForm({ ...form, installmentEnabled: e.target.checked })} />فقط اقساطی</label></div>
          </div>
        ) : (
          <div className="kv-scroll grid max-h-[240px] gap-1 overflow-y-auto sm:grid-cols-2">{products.map((p) => <label key={p.id} className="flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12px] hover:bg-[var(--kv-surface-2)]"><input type="checkbox" checked={form.productIds.includes(p.id)} onChange={(e) => setForm({ ...form, productIds: e.target.checked ? [...form.productIds, p.id] : form.productIds.filter((x) => x !== p.id) })} />{p.name}</label>)}</div>
        )}
        <div className="flex gap-2">
          <Btn variant="soft" size="sm" onClick={async () => { try { setPreview((await studioApi.previewCollection({ mode: form.mode, queryRules: rules, productIds: form.productIds })).items); } catch (e) { flash(errMsg(e)); } }}>پیش‌نمایش نتیجه</Btn>
          <Btn variant="accent" size="sm" disabled={form.code.length < 2 || !form.title} onClick={async () => { try { await studioApi.createCollection({ code: form.code, title: form.title, mode: form.mode, queryRules: rules, productIds: form.productIds }); flash("کالکشن ذخیره شد"); await load(); } catch (e) { flash(errMsg(e)); } }}>ذخیره کالکشن</Btn>
        </div>
        {preview && <div><p className="mb-2 text-[12px] font-bold">{fa(preview.length)} محصول مطابق قوانین</p><div className="grid grid-cols-2 gap-2 md:grid-cols-4">{preview.map((p) => <CommerceCard key={p.id} product={p} />)}</div></div>}
      </Card>
    </div>
  );
}

/* ============================ Assets (Req 229-230, 305) ============================ */

const localDay = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const PIPE_LABEL: Record<string, string> = { queued: "در صف", running: "در حال پردازش", completed: "پردازش کامل", partial: "پردازش ناقص", failed: "خطا", skipped: "رد شد", pending: "در انتظار" };
const STEP_LABEL: Record<string, string> = { validate: "اعتبارسنجی", inspect: "بررسی", responsive_variants: "نسخه‌های واکنش‌گرا", background_removal: "حذف پس‌زمینه" };

function AssetsPanel({ flash }: { flash: F }) {
  const [filters, setFilters] = useState({ search: "", type: "", from: "", to: "", uploader: "", sort: "newest" });
  const { data, error, load } = useAsync(() => studioApi.assets(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))), [filters.search, filters.type, filters.from, filters.to, filters.uploader, filters.sort]);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof studioApi.mediaRuns>>["items"] | null>(null);
  const [usage, setUsage] = useState<{ id: string; title: string; items: { type: string; label: string }[] } | null>(null);
  const [form, setForm] = useState({ title: "", url: "", folder: "general", tags: "", altText: "" });
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState message={error} onRetry={load} />;
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const f = await filesApi.upload(file);
      await studioApi.createAsset({ fileId: f.id, title: form.title || file.name, assetType: file.type.startsWith("video/") ? "video" : file.type === "application/pdf" ? "document" : "image", folder: form.folder, tags: form.tags.split(/[،,]/).map((t) => t.trim()).filter(Boolean), altText: form.altText });
      flash("رسانه در کتابخانه ثبت شد"); await load();
    } catch (e) { flash(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="grid gap-2 sm:grid-cols-4"><Field label="عنوان"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field><Field label="پوشه"><Input value={form.folder} onChange={(v) => setForm({ ...form, folder: v.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} /></Field><Field label="برچسب‌ها"><Input value={form.tags} onChange={(tags) => setForm({ ...form, tags })} placeholder="hero، کمپین" /></Field><Field label="متن جایگزین (Alt)"><Input value={form.altText} onChange={(altText) => setForm({ ...form, altText })} /></Field></div>
        <div className="flex flex-wrap items-end gap-2">
          <label className={cn("kv-press inline-flex h-10 cursor-pointer items-center gap-2 rounded-[11px] bg-[var(--kv-action)] px-4 text-[13px] font-bold text-[var(--kv-bg)]", busy && "opacity-60")}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}بارگذاری فایل<input type="file" className="sr-only" accept="image/*,video/mp4,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} /></label>
          <div className="min-w-[220px] flex-1"><Input value={form.url} onChange={(url) => setForm({ ...form, url })} placeholder="یا نشانی https رسانه (CDN)" /></div>
          <Btn variant="soft" disabled={!/^https:\/\//.test(form.url) || !form.title} onClick={async () => { try { await studioApi.createAsset({ url: form.url, title: form.title, assetType: /\.(mp4|webm)$/i.test(form.url) ? "video" : "image", folder: form.folder, tags: form.tags.split(/[،,]/).map((t) => t.trim()).filter(Boolean), altText: form.altText }); flash("ثبت شد"); await load(); } catch (e) { flash(errMsg(e)); } }}>ثبت نشانی</Btn>
        </div>
      </Card>
      <div className="flex flex-wrap items-end gap-2" data-testid="asset-filters">
        <div className="min-w-[200px] flex-1"><Input value={filters.search} onChange={(search) => setFilters({ ...filters, search })} placeholder="جست‌وجو در عنوان، Alt و برچسب" /></div>
        <Select options={["همه", "image", "video", "icon", "document"]} value={filters.type || "همه"} onChange={(v) => setFilters({ ...filters, type: v === "همه" ? "" : v })} />
        <Select options={["همه آپلودکننده‌ها", ...(data?.uploaders ?? []).map((u) => u.display_name)]} value={(data?.uploaders ?? []).find((u) => u.id === filters.uploader)?.display_name ?? "همه آپلودکننده‌ها"} onChange={(l) => setFilters({ ...filters, uploader: (data?.uploaders ?? []).find((u) => u.display_name === l)?.id ?? "" })} />
        <Select options={["جدیدترین", "قدیمی‌ترین", "بزرگ‌ترین", "عنوان"]} value={({ newest: "جدیدترین", oldest: "قدیمی‌ترین", largest: "بزرگ‌ترین", title: "عنوان" } as Record<string, string>)[filters.sort]} onChange={(l) => setFilters({ ...filters, sort: ({ "جدیدترین": "newest", "قدیمی‌ترین": "oldest", "بزرگ‌ترین": "largest", "عنوان": "title" } as Record<string, string>)[l] ?? "newest" })} />
        <div className="w-[170px]"><PersianDatePicker label="از تاریخ" value={filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : null} onChange={(v) => setFilters({ ...filters, from: v ? localDay(v) : "" })} /></div>
        <div className="w-[170px]"><PersianDatePicker label="تا تاریخ" value={filters.to ? new Date(`${filters.to}T00:00:00`).toISOString() : null} onChange={(v) => setFilters({ ...filters, to: v ? localDay(v) : "" })} /></div>
        <Btn size="sm" variant="ghost" onClick={async () => { try { setRuns((await studioApi.mediaRuns()).items); } catch (e) { flash(errMsg(e)); } }}>اجراهای پردازش</Btn>
      </div>
      {!data ? <LoadingState /> : data.items.length === 0 ? <Empty title="کتابخانه خالی است" desc="اولین رسانه را بارگذاری کنید." /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">{data.items.map((a) => (
          <Card key={a.id} className="overflow-hidden">
            <div className="flex aspect-square items-center justify-center bg-[var(--kv-surface-2)]">{a.asset_type === "image" ? <img src={mediaSrc(a.url)} alt={a.alt_text} loading="lazy" className="h-full w-full object-cover" /> : a.asset_type === "video" ? <video src={mediaSrc(a.url)} muted className="h-full w-full object-cover" /> : <ImageIcon size={22} className="text-[var(--kv-muted)]" />}</div>
            <div className="p-2"><p className="truncate text-[12px] font-bold">{a.title}</p><p className="truncate text-[10.5px] text-[var(--kv-muted)]">{a.folder} · {a.tags.join("، ")}</p>
              <p className="mt-0.5 truncate text-[10.5px] text-[var(--kv-muted)]">{a.uploader_name ?? "سیستم"} · {formatPersianDateTime(a.created_at)}{a.size_bytes ? ` · ${fa(Math.round(a.size_bytes / 1024))}KB` : ""}</p>
              {a.pipeline && <span data-pipeline={a.pipeline.status} className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold", a.pipeline.status === "completed" ? "bg-[var(--kv-success)]/12 text-[var(--kv-success)]" : a.pipeline.status === "failed" ? "bg-[var(--kv-danger)]/12 text-[var(--kv-danger)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{PIPE_LABEL[a.pipeline.status] ?? a.pipeline.status}</span>}
              <div className="mt-1.5 flex gap-1"><Btn size="sm" variant="ghost" onClick={async () => setUsage({ id: a.id, title: a.title, items: (await studioApi.assetUsage(a.id)).items })}>کاربردها</Btn>
                <button aria-label="کپی نشانی" onClick={() => { void navigator.clipboard?.writeText(a.url); flash("نشانی کپی شد"); }} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><Copy size={13} /></button>
                <button aria-label="حذف" onClick={async () => { try { await studioApi.deleteAsset(a.id); flash("حذف شد"); await load(); } catch (e) { setUsage({ id: a.id, title: a.title, items: (await studioApi.assetUsage(a.id)).items }); flash(errMsg(e)); } }} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={13} /></button></div></div>
          </Card>
        ))}</div>
      )}
      <Drawer open={!!runs} onClose={() => setRuns(null)} title="اجراهای پایپ‌لاین رسانه" wide>
        {runs && <div className="space-y-3">
          <Btn size="sm" variant="soft" onClick={async () => { try { const r = await studioApi.processMedia(); flash(`${fa(r.processed)} مورد پردازش شد`); setRuns((await studioApi.mediaRuns()).items); await load(); } catch (e) { flash(errMsg(e)); } }}>پردازش صف اکنون</Btn>
          {runs.length === 0 ? <p className="text-[13px] text-[var(--kv-muted)]">هنوز اجرایی ثبت نشده است.</p> : <ul className="space-y-2">{runs.map((r) => (
            <li key={r.id} className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12px]">
              <div className="flex flex-wrap items-center justify-between gap-2"><b>{r.subject_type} · <span dir="ltr" className="font-normal">{r.subject_id.slice(0, 8)}</span></b><span>{PIPE_LABEL[r.status] ?? r.status} · {formatPersianDateTime(r.created_at)}</span></div>
              <div className="mt-2 flex flex-wrap gap-1.5">{r.steps.map((st) => <span key={st.step} title={st.detail} className={cn("rounded-full px-2 py-0.5 text-[10.5px]", st.status === "completed" ? "bg-[var(--kv-success)]/12 text-[var(--kv-success)]" : st.status === "failed" ? "bg-[var(--kv-danger)]/12 text-[var(--kv-danger)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>{STEP_LABEL[st.step] ?? st.step}: {PIPE_LABEL[st.status] ?? st.status}</span>)}</div>
            </li>))}</ul>}
        </div>}
      </Drawer>
      <Drawer open={!!usage} onClose={() => setUsage(null)} title={usage ? `کاربردهای «${usage.title}»` : ""}>
        {usage && <div className="space-y-3">{usage.items.length === 0 ? <p className="text-[13px] text-[var(--kv-muted)]">این رسانه جایی استفاده نشده و حذف آن امن است.</p> : <ul className="space-y-1.5">{usage.items.map((u, i) => <li key={i} className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[12.5px]"><b>{u.label}</b> <span className="text-[var(--kv-muted)]">· {u.type}</span></li>)}</ul>}
          {usage.items.length > 0 && <Btn variant="soft" className="w-full text-[var(--kv-danger)]" onClick={async () => { try { await studioApi.deleteAsset(usage.id, true); flash("با وجود کاربرد، حذف شد"); setUsage(null); await load(); } catch (e) { flash(errMsg(e)); } }}>حذف اجباری</Btn>}</div>}
      </Drawer>
    </div>
  );
}

/* ============================ Announcements (Req 327-332) ============================ */

type AnnForm = { id?: string; title: string; messages: string; mode: Announcement["mode"]; backgroundColor: string; textColor: string; speed: "slow" | "normal" | "fast"; direction: "rtl" | "ltr"; heightPx: number; dismissible: boolean; ctaLabel: string; ctaTarget: string; bindingType: BindingKind; bindingId: string; showCountdown: boolean; priority: number; startsAt: string | null; endsAt: string | null; active: boolean };
const emptyAnn = (): AnnForm => ({ title: "", messages: "ارسال رایگان بالای ۳ میلیون تومان|shop\nخرید چهارقسطی بدون کارمزد|shop", mode: "rotating", backgroundColor: "#1B2A4A", textColor: "#F9F6F1", speed: "normal", direction: "rtl", heightPx: 40, dismissible: true, ctaLabel: "", ctaTarget: "shop", bindingType: "none", bindingId: "", showCountdown: false, priority: 10, startsAt: null, endsAt: null, active: true });
type BindingKind = "none" | "campaign" | "promotion" | "coupon" | "collection" | "landing_page";
const BINDING_LABEL: Record<BindingKind, string> = { none: "بدون اتصال", campaign: "کمپین", promotion: "پروموشن (تخفیف کمپین)", coupon: "کوپن عمومی", collection: "کالکشن", landing_page: "صفحه لندینگ" };
function AnnouncementsPanel({ flash }: { flash: F }) {
  const { data, error, load } = useAsync(() => studioApi.announcements());
  const festivals = useAsync(() => studioApi.festivals());
  const coupons = useAsync(() => studioApi.publicCoupons().catch(() => ({ items: [] })));
  const collectionsList = useAsync(() => studioApi.collections());
  const pagesList = useAsync(() => studioApi.pages());
  const [form, setForm] = useState<AnnForm>(emptyAnn());
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const messages = form.messages.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [text, link] = l.split("|"); return { text: text!.trim(), ...(link?.trim() ? { link: link.trim() } : {}) }; });
  const payload = { title: form.title, messages, mode: form.mode, priority: form.priority, active: form.active, startsAt: form.startsAt, endsAt: form.endsAt,
    bindingType: form.bindingId ? form.bindingType : "none", bindingId: form.bindingType === "none" ? null : form.bindingId || null,
    style: { backgroundColor: form.backgroundColor, textColor: form.textColor, speed: form.speed, direction: form.direction, heightPx: form.heightPx, dismissible: form.dismissible, showCountdown: form.showCountdown, ...(form.ctaLabel ? { ctaLabel: form.ctaLabel, ctaTarget: form.ctaTarget } : {}) } };
  // Binding options: value = what the server stores (festival id, public coupon code, collection/page code).
  const bindingOptions: { value: string; label: string }[] = form.bindingType === "campaign" || form.bindingType === "promotion" ? (festivals.data?.items ?? []).map((f) => ({ value: f.id, label: f.name }))
    : form.bindingType === "coupon" ? (coupons.data?.items ?? []).filter((c) => !c.recipient_user_id).map((c) => ({ value: c.code, label: `${c.code}${c.campaign_name ? ` · ${c.campaign_name}` : ""}` }))
    : form.bindingType === "collection" ? (collectionsList.data?.items ?? []).map((c) => ({ value: c.code, label: c.title }))
    : form.bindingType === "landing_page" ? (pagesList.data?.items ?? []).filter((p) => p.page_type !== "home").map((p) => ({ value: p.code, label: p.title })) : [];
  const chosen = bindingOptions.find((o) => o.value === form.bindingId);
  const previewBinding: Announcement["binding"] = !chosen ? null : form.bindingType === "coupon" ? { kind: "coupon", code: chosen.value }
    : form.bindingType === "promotion" ? { kind: "promotion", discountPercent: Number((festivals.data?.items ?? []).find((f) => f.id === form.bindingId)?.discount_percent ?? 0) || null, target: "shop" }
    : form.bindingType === "collection" ? { kind: "collection", target: `collection:${chosen.value}`, title: chosen.label }
    : form.bindingType === "landing_page" ? { kind: "landing_page", target: `page:${chosen.value}`, title: chosen.label } : null;
  const previewAnn: Announcement = { id: "preview", title: form.title, mode: form.mode, priority: 0, messages, style: { ...payload.style, dismissible: false }, bindingType: form.bindingType, bindingId: form.bindingId || null, binding: previewBinding,
    campaign: form.bindingId && (form.bindingType === "campaign" || form.bindingType === "promotion") ? (() => { const f = (festivals.data?.items ?? []).find((x) => x.id === form.bindingId); return f ? { id: f.id, name: f.name, starts_at: f.starts_at, ends_at: f.ends_at } : null; })() : null };
  return (
    <div className="space-y-4">
      <ul className="space-y-2">{data.items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2.5 text-[12.5px]">
          <span className="h-5 w-5 rounded-full border border-black/10" style={{ background: a.style.backgroundColor }} /><b>{a.title}</b><span className="text-[var(--kv-muted)]">{a.mode} · اولویت {fa(a.priority)}{a.starts_at && ` · از ${formatPersianDateTime(a.starts_at)}`}{a.ends_at && ` تا ${formatPersianDateTime(a.ends_at)}`}</span>
          <span className="mr-auto flex items-center gap-2"><Switch on={a.active} onToggle={async () => { await studioApi.updateAnnouncement(a.id, { active: !a.active }); await load(); }} />
            <Btn size="sm" variant="soft" onClick={() => setForm({ id: a.id, title: a.title, messages: a.messages.map((m) => [m.text, m.link].filter(Boolean).join("|")).join("\n"), mode: a.mode, backgroundColor: a.style.backgroundColor, textColor: a.style.textColor, speed: a.style.speed ?? "normal", direction: a.style.direction ?? "rtl", heightPx: a.style.heightPx ?? 40, dismissible: a.style.dismissible !== false, ctaLabel: a.style.ctaLabel ?? "", ctaTarget: a.style.ctaTarget ?? "shop", bindingType: (a.binding_type as BindingKind) ?? "none", bindingId: a.binding_id ?? "", showCountdown: Boolean(a.style.showCountdown), priority: a.priority, startsAt: a.starts_at, endsAt: a.ends_at, active: a.active })}>ویرایش</Btn>
            <button aria-label="حذف" onClick={async () => { await studioApi.deleteAnnouncement(a.id); await load(); }} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button></span>
        </li>
      ))}</ul>
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">{form.id ? "ویرایش اعلان" : "اعلان جدید"}</p>
        <div className="overflow-hidden rounded-[12px] border border-dashed border-[var(--kv-line-strong)]"><ServerAnnouncementBar announcements={[previewAnn]} onNav={() => undefined} /></div>
        <div className="grid gap-2 sm:grid-cols-3"><Field label="عنوان داخلی"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field>
          <Field label="حالت نمایش"><Select options={["static", "marquee", "ticker", "slider", "rotating"]} value={form.mode} onChange={(mode) => setForm({ ...form, mode: mode as AnnForm["mode"] })} /></Field>
          <Field label="اولویت"><Input value={String(form.priority)} onChange={(v) => setForm({ ...form, priority: Number(v.replace(/\D/g, "")) || 0 })} /></Field></div>
        <Field label="پیام‌ها (هر خط: متن|مقصد)" hint="مقصد: shop، vip، about، page:code یا https://…"><Textarea rows={3} value={form.messages} onChange={(messages) => setForm({ ...form, messages })} /></Field>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="text-[12px] font-semibold">پس‌زمینه<input type="color" value={form.backgroundColor} onChange={(e) => setForm({ ...form, backgroundColor: e.target.value })} className="mt-1 block h-9 w-full rounded border border-[var(--kv-line)]" /></label>
          <label className="text-[12px] font-semibold">رنگ متن<input type="color" value={form.textColor} onChange={(e) => setForm({ ...form, textColor: e.target.value })} className="mt-1 block h-9 w-full rounded border border-[var(--kv-line)]" /></label>
          <Field label="سرعت"><Select options={["slow", "normal", "fast"]} value={form.speed} onChange={(speed) => setForm({ ...form, speed: speed as AnnForm["speed"] })} /></Field>
          <Field label="جهت حرکت"><Select options={["rtl", "ltr"]} value={form.direction} onChange={(direction) => setForm({ ...form, direction: direction as AnnForm["direction"] })} /></Field>
          <Field label="ارتفاع (px)"><Input value={String(form.heightPx)} onChange={(v) => setForm({ ...form, heightPx: Math.min(64, Math.max(28, Number(v.replace(/\D/g, "")) || 40)) })} /></Field>
          <Field label="متن CTA"><Input value={form.ctaLabel} onChange={(ctaLabel) => setForm({ ...form, ctaLabel })} /></Field>
          <Field label="مقصد CTA"><Input value={form.ctaTarget} onChange={(ctaTarget) => setForm({ ...form, ctaTarget })} /></Field>
          <Field label="نوع اتصال"><Select options={Object.values(BINDING_LABEL)} value={BINDING_LABEL[form.bindingType]} onChange={(l) => setForm({ ...form, bindingType: (Object.entries(BINDING_LABEL).find(([, v]) => v === l)?.[0] as BindingKind) ?? "none", bindingId: "" })} /></Field>
          {form.bindingType !== "none" && <Field label={`انتخاب ${BINDING_LABEL[form.bindingType]}`}><Select options={["—", ...bindingOptions.map((o) => o.label)]} value={chosen?.label ?? "—"} onChange={(l) => setForm({ ...form, bindingId: bindingOptions.find((o) => o.label === l)?.value ?? "" })} /></Field>}
        </div>
        <div className="grid gap-2 sm:grid-cols-2"><PersianDatePicker label="شروع نمایش" withTime value={form.startsAt} onChange={(startsAt) => setForm({ ...form, startsAt })} /><PersianDatePicker label="پایان نمایش" withTime value={form.endsAt} onChange={(endsAt) => setForm({ ...form, endsAt })} /></div>
        <div className="flex flex-wrap gap-4 text-[12px]"><label className="flex items-center gap-1.5"><input type="checkbox" checked={form.dismissible} onChange={(e) => setForm({ ...form, dismissible: e.target.checked })} />قابل بستن توسط کاربر</label><label className="flex items-center gap-1.5"><input type="checkbox" checked={form.showCountdown} onChange={(e) => setForm({ ...form, showCountdown: e.target.checked })} />نمایش شمارش معکوس کمپین</label></div>
        <div className="flex gap-2"><Btn variant="accent" size="sm" disabled={!form.title || !messages.length} onClick={async () => { try { if (form.id) await studioApi.updateAnnouncement(form.id, payload); else await studioApi.createAnnouncement(payload); flash("اعلان ذخیره شد"); setForm(emptyAnn()); await load(); } catch (e) { flash(errMsg(e)); } }}>ذخیره</Btn>{form.id && <Btn variant="ghost" size="sm" onClick={() => setForm(emptyAnn())}>اعلان جدید</Btn>}</div>
      </Card>
    </div>
  );
}

/* ============================ Global layout (Req 275-280, 323, 354) ============================ */

function LayoutPanel({ flash }: { flash: F }) {
  const { data, error, load } = useAsync(() => studioApi.layout());
  const [header, setHeader] = useState<HeaderConfig | null>(null);
  const [footer, setFooter] = useState<FooterConfig | null>(null);
  const [account, setAccount] = useState<AccountAppearance | null>(null);
  useEffect(() => { if (data) { setHeader(data.header); setFooter(data.footer); setAccount(data.accountAppearance); } }, [data]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!header || !footer || !account) return <LoadingState />;
  const save = async (key: "global_header" | "global_footer" | "account_appearance", value: unknown) => { try { await studioApi.saveLayout(key, value); flash("ذخیره شد؛ سرور ساختار را اعتبارسنجی کرد"); await load(); } catch (e) { flash(errMsg(e)); } };
  const bool = (k: keyof HeaderConfig, label: string) => <label className="flex items-center gap-2 text-[12.5px]"><Switch on={Boolean(header[k])} onToggle={() => setHeader({ ...header, [k]: !header[k] })} />{label}</label>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">هدر</p>
        <p className="text-[11.5px] text-[var(--kv-muted)]">فقط کامپوننت‌ها و لینک‌های ثبت‌شده مجازند؛ HTML یا JS دلخواه پذیرفته نمی‌شود.</p>
        <div className="grid gap-2 sm:grid-cols-3"><Field label="Preset"><Select options={["default", "minimal", "transparent", "campaign", "dark"]} value={header.variant} onChange={(v) => setHeader({ ...header, variant: v as HeaderConfig["variant"] })} /></Field><Field label="لوگو"><Input value={header.logoText} onChange={(logoText) => setHeader({ ...header, logoText })} /></Field><Field label="زیرعنوان لوگو"><Input value={header.logoSubtext} onChange={(logoSubtext) => setHeader({ ...header, logoSubtext })} /></Field></div>
        <div className="flex flex-wrap gap-3">{bool("showSearch", "جست‌وجو")}{bool("showWishlist", "علاقه‌مندی")}{bool("showCart", "سبد")}{bool("showAccount", "حساب")}{bool("showThemeToggle", "حالت تیره")}</div>
        <p className="pt-2 text-[12.5px] font-bold">منوها</p>
        {header.menus.map((m, i) => (
          <div key={m.id} className="flex flex-wrap items-center gap-2">
            <Input className="w-32" value={m.label} onChange={(label) => setHeader({ ...header, menus: header.menus.map((x, j) => (j === i ? { ...x, label } : x)) })} />
            <Input className="w-40" value={m.target} onChange={(target) => setHeader({ ...header, menus: header.menus.map((x, j) => (j === i ? { ...x, target } : x)) })} />
            <Input className="w-16" value={String(m.order)} onChange={(v) => setHeader({ ...header, menus: header.menus.map((x, j) => (j === i ? { ...x, order: Number(v) || 0 } : x)) })} />
            <Switch on={m.active} onToggle={() => setHeader({ ...header, menus: header.menus.map((x, j) => (j === i ? { ...x, active: !x.active } : x)) })} />
            <label className="flex items-center gap-1 text-[11.5px]"><input type="checkbox" checked={Boolean(m.hasMegaMenu)} onChange={(e) => setHeader({ ...header, menus: header.menus.map((x, j) => (j === i ? { ...x, hasMegaMenu: e.target.checked } : x)) })} />مگامنو</label>
            <button aria-label="حذف منو" onClick={() => setHeader({ ...header, menus: header.menus.filter((_, j) => j !== i) })} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button>
          </div>
        ))}
        <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setHeader({ ...header, menus: [...header.menus, { id: `m${Date.now().toString(36)}`, label: "منوی جدید", target: "shop", order: header.menus.length + 1, active: true }] })}>افزودن منو</Btn>
        <label className="flex items-center gap-2 pt-2 text-[12.5px]"><Switch on={header.showAnnouncement !== false} onToggle={() => setHeader({ ...header, showAnnouncement: header.showAnnouncement === false })} />نمایش نوار اعلان بالای هدر</label>
        <MobileNavEditor value={header.mobileNav ?? { showCategories: true, showVibes: true, items: [] }} onChange={(mobileNav) => setHeader({ ...header, mobileNav })} />
        <MegaMenuEditor columns={header.megaMenu} menus={header.menus} onChange={(megaMenu) => setHeader({ ...header, megaMenu })} />
        <Btn variant="accent" size="sm" onClick={() => { const bad = badTargets([...header.menus.map((m) => m.target), ...(header.mobileNav?.items ?? []).map((i) => i.target), ...header.megaMenu.flatMap((c) => c.items.map((i) => i.target ?? "shop"))]); if (bad) { flash(`مقصد «${bad}» مجاز نیست.`); return; } void save("global_header", header); }}>ذخیره هدر</Btn>
      </Card>
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">فوتر</p>
        <div className="grid gap-2 sm:grid-cols-2"><Field label="عنوان برند"><Input value={footer.brandTitle} onChange={(brandTitle) => setFooter({ ...footer, brandTitle })} /></Field><Field label="زیرعنوان"><Input value={footer.brandSubtitle} onChange={(brandSubtitle) => setFooter({ ...footer, brandSubtitle })} /></Field></div>
        <Field label="توضیح برند"><Textarea rows={2} value={footer.brandDescription} onChange={(brandDescription) => setFooter({ ...footer, brandDescription })} /></Field>
        {footer.columns.map((col, i) => (
          <div key={i} className="space-y-1.5 rounded-[12px] border border-[var(--kv-line)] p-2.5">
          <div className="flex items-center gap-2"><Input className="flex-1" value={col.title} onChange={(title) => setFooter({ ...footer, columns: footer.columns.map((c, j) => (j === i ? { ...c, title } : c)) })} />
            <button aria-label="حذف ستون" onClick={() => setFooter({ ...footer, columns: footer.columns.filter((_, j) => j !== i) })} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button></div>
          <Field label="لینک‌ها (هر خط: متن|مقصد — مثل shop، page:about، category:slug)"><Textarea rows={3} value={col.links.map((l) => `${l.label}|${l.target}`).join("\n")} onChange={(v) => setFooter({ ...footer, columns: footer.columns.map((c, j) => (j === i ? { ...c, links: v.split("\n").map((l) => l.split("|")).filter((p) => p[0]?.trim()).map(([label, target]) => ({ label: label!.trim(), target: (target ?? "shop").trim() })) } : c)) })} /></Field>
          </div>
        ))}
        {footer.columns.length < 5 && <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setFooter({ ...footer, columns: [...footer.columns, { title: "ستون جدید", links: [] }] })}>افزودن ستون</Btn>}
        <p className="pt-1 text-[12.5px] font-bold">شبکه‌های اجتماعی</p>
        {footer.social.map((so, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select className="w-32" options={["instagram", "telegram", "whatsapp", "youtube", "linkedin", "x"]} value={so.platform} onChange={(platform) => setFooter({ ...footer, social: footer.social.map((x, j) => (j === i ? { ...x, platform } : x)) })} />
            <Input className="w-28" value={so.label} onChange={(label) => setFooter({ ...footer, social: footer.social.map((x, j) => (j === i ? { ...x, label } : x)) })} />
            <Input className="min-w-0 flex-1" value={so.url} placeholder="https://…" onChange={(url) => setFooter({ ...footer, social: footer.social.map((x, j) => (j === i ? { ...x, url } : x)) })} />
            <button aria-label="حذف" onClick={() => setFooter({ ...footer, social: footer.social.filter((_, j) => j !== i) })} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button>
          </div>
        ))}
        {footer.social.length < 8 && <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => setFooter({ ...footer, social: [...footer.social, { platform: "instagram", label: "اینستاگرام", url: "https://instagram.com/" }] })}>افزودن شبکه</Btn>}
        <label className="flex items-center gap-2 text-[12.5px]"><Switch on={footer.newsletterEnabled} onToggle={() => setFooter({ ...footer, newsletterEnabled: !footer.newsletterEnabled })} />فرم عضویت خبرنامه در فوتر</label>
        <div className="grid gap-2 sm:grid-cols-3"><Field label="تلفن"><Input value={footer.contact.phone} onChange={(phone) => setFooter({ ...footer, contact: { ...footer.contact, phone } })} /></Field><Field label="ایمیل"><Input value={footer.contact.email} onChange={(email) => setFooter({ ...footer, contact: { ...footer.contact, email } })} /></Field><Field label="کپی‌رایت"><Input value={footer.copyright} onChange={(copyright) => setFooter({ ...footer, copyright })} /></Field></div>
        <Field label="آدرس"><Input value={footer.contact.address} onChange={(address) => setFooter({ ...footer, contact: { ...footer.contact, address } })} /></Field>
        <Field label="نشان‌های اعتماد (با ، جدا کنید)"><Input value={footer.trustBadges.join("، ")} onChange={(v) => setFooter({ ...footer, trustBadges: v.split(/[،,]/).map((x) => x.trim()).filter(Boolean) })} /></Field>
        <Btn variant="accent" size="sm" onClick={() => { const bad = badTargets(footer.columns.flatMap((c) => c.links.map((l) => l.target))); if (bad) { flash(`مقصد «${bad}» مجاز نیست.`); return; } if (footer.social.some((x) => !/^https:\/\/\S+$/.test(x.url))) { flash("نشانی شبکه اجتماعی باید با https شروع شود."); return; } void save("global_footer", footer); }}>ذخیره فوتر</Btn>
      </Card>
      <Card className="space-y-3 p-4 xl:col-span-2">
        <p className="text-[14px] font-extrabold">ظاهر داشبورد مشتری</p>
        <div className="grid gap-2 sm:grid-cols-3"><Field label="روتیتر بنر"><Input value={account.welcomeBanner.eyebrow} onChange={(eyebrow) => setAccount({ ...account, welcomeBanner: { ...account.welcomeBanner, eyebrow } })} /></Field><Field label="زیرتیتر بنر"><Input value={account.welcomeBanner.subtitle} onChange={(subtitle) => setAccount({ ...account, welcomeBanner: { ...account.welcomeBanner, subtitle } })} /></Field><Field label="رنگ بنر"><Select options={["navy", "terra", "stone"]} value={account.welcomeBanner.tone} onChange={(tone) => setAccount({ ...account, welcomeBanner: { ...account.welcomeBanner, tone: tone as "navy" } })} /></Field>
          <Field label="عنوان کارت تبلیغ"><Input value={account.promoCard.title} onChange={(title) => setAccount({ ...account, promoCard: { ...account.promoCard, title } })} /></Field><Field label="توضیح کارت تبلیغ"><Input value={account.promoCard.subtitle} onChange={(subtitle) => setAccount({ ...account, promoCard: { ...account.promoCard, subtitle } })} /></Field><Field label="عنوان پیشنهادها"><Input value={account.recommendationHeading} onChange={(recommendationHeading) => setAccount({ ...account, recommendationHeading })} /></Field></div>
        <label className="flex items-center gap-2 text-[12.5px]"><Switch on={account.promoCard.enabled} onToggle={() => setAccount({ ...account, promoCard: { ...account.promoCard, enabled: !account.promoCard.enabled } })} />نمایش کارت تبلیغ</label>
        <Btn variant="accent" size="sm" onClick={() => save("account_appearance", account)}>ذخیره ظاهر حساب</Btn>
      </Card>
    </div>
  );
}

/** Same grammar as the server's NAV_TARGET — early feedback only; the server still validates. */
const NAV_RE = /^(home|shop|vip|tryon|journal|about|supplier|account|https:\/\/[^\s<>"]+|page:[a-z0-9_-]{2,40}|vibe:[a-z0-9-]{2,40}|collection:[a-z0-9-]{2,40}|category:[^\s<>"]{1,60}|product:[0-9a-f-]{36})$/;
const badTargets = (targets: string[]) => targets.find((t) => !NAV_RE.test(t.trim())) ?? null;

function LinkRows({ items, onChange, max, addLabel }: { items: { label: string; target: string }[]; onChange: (v: { label: string; target: string }[]) => void; max: number; addLabel: string }) {
  return (
    <div className="space-y-1.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="w-36" value={it.label} onChange={(label) => onChange(items.map((x, j) => (j === i ? { ...x, label } : x)))} />
          <Input className={cn("min-w-0 flex-1", !NAV_RE.test(it.target) && "[&_input]:border-[var(--kv-danger)]")} value={it.target} placeholder="shop / category:slug / page:code" onChange={(target) => onChange(items.map((x, j) => (j === i ? { ...x, target } : x)))} />
          <button aria-label="حذف" onClick={() => onChange(items.filter((_, j) => j !== i))} className="text-[var(--kv-danger)]"><Trash2 size={14} /></button>
        </div>
      ))}
      {items.length < max && <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => onChange([...items, { label: "لینک جدید", target: "shop" }])}>{addLabel}</Btn>}
    </div>
  );
}

function MobileNavEditor({ value, onChange }: { value: NonNullable<HeaderConfig["mobileNav"]>; onChange: (v: NonNullable<HeaderConfig["mobileNav"]>) => void }) {
  return (
    <div className="space-y-2 rounded-[12px] border border-[var(--kv-line)] p-3" data-testid="mobile-nav-editor">
      <p className="text-[12.5px] font-bold">منوی موبایل</p>
      <div className="flex flex-wrap gap-4 text-[12.5px]">
        <label className="flex items-center gap-2"><Switch on={value.showCategories} onToggle={() => onChange({ ...value, showCategories: !value.showCategories })} />نمایش دسته‌بندی‌ها</label>
        <label className="flex items-center gap-2"><Switch on={value.showVibes} onToggle={() => onChange({ ...value, showVibes: !value.showVibes })} />نمایش وایب‌ها</label>
      </div>
      <LinkRows items={value.items} max={8} addLabel="افزودن لینک موبایل" onChange={(items) => onChange({ ...value, items })} />
    </div>
  );
}

/** Mega menu (Req 278): columns tied to a header menu, links, and a featured vibe / collection / campaign promo with media. */
function MegaMenuEditor({ columns, menus, onChange }: { columns: MegaMenuColumn[]; menus: HeaderConfig["menus"]; onChange: (v: MegaMenuColumn[]) => void }) {
  const set = (i: number, patch: Partial<MegaMenuColumn>) => onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const megaMenus = menus.filter((m) => m.hasMegaMenu);
  const clean = (v: string) => (v.trim() ? v.trim() : undefined);
  return (
    <div className="space-y-2 rounded-[12px] border border-[var(--kv-line)] p-3" data-testid="mega-menu-editor">
      <div className="flex items-center justify-between"><p className="text-[12.5px] font-bold">مگامنو ({columns.length.toLocaleString("fa-IR")} ستون)</p>
        {!megaMenus.length && <span className="text-[11px] text-[var(--kv-warning,#B7791F)]">هیچ منویی «مگامنو» فعال ندارد.</span>}</div>
      {columns.map((c, i) => (
        <details key={c.id} className="rounded-[10px] bg-[var(--kv-surface-2)] p-2.5">
          <summary className="cursor-pointer text-[12.5px] font-bold">{c.title || "ستون بدون عنوان"} <span className="font-normal text-[var(--kv-muted)]">· {c.items.length.toLocaleString("fa-IR")} لینک</span></summary>
          <div className="mt-2 space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="عنوان ستون"><Input value={c.title} onChange={(title) => set(i, { title })} /></Field>
              <Field label="منوی والد"><Select options={["—", ...megaMenus.map((m) => m.id)]} value={c.menuId ?? "—"} onChange={(v) => set(i, { menuId: v === "—" ? undefined : v })} /></Field>
            </div>
            <LinkRows items={c.items.map((x) => ({ label: x.label, target: x.target ?? (x.category ? `category:${x.category}` : "shop") }))} max={12} addLabel="افزودن لینک"
              onChange={(items) => set(i, { items: items.map((x) => ({ label: x.label, target: x.target })) })} />
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="وایب ویژه (slug)"><Input value={c.featuredVibe ?? ""} onChange={(v) => set(i, { featuredVibe: clean(v) })} /></Field>
              <Field label="کالکشن ویژه (code)"><Input value={c.featuredCollection ?? ""} onChange={(v) => set(i, { featuredCollection: clean(v) })} /></Field>
              <Field label="کمپین ویژه (code)"><Input value={c.featuredCampaign ?? ""} onChange={(v) => set(i, { featuredCampaign: clean(v) })} /></Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="متن تبلیغ"><Input value={c.promoTitle ?? ""} onChange={(v) => set(i, { promoTitle: clean(v) })} /></Field>
              <Field label="تصویر (https یا /api/v1/media/…)"><Input value={c.image ?? ""} onChange={(v) => set(i, { image: clean(v) })} /></Field>
              <Field label="متن جایگزین تصویر"><Input value={c.imageAlt ?? ""} onChange={(v) => set(i, { imageAlt: clean(v) })} /></Field>
            </div>
            <div className="flex gap-2">
              <Btn size="sm" variant="soft" disabled={i === 0} onClick={() => { const n = [...columns]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; onChange(n); }}>بالا</Btn>
              <Btn size="sm" variant="soft" disabled={i === columns.length - 1} onClick={() => { const n = [...columns]; [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; onChange(n); }}>پایین</Btn>
              <Btn size="sm" variant="soft" icon={<Trash2 size={13} />} onClick={() => onChange(columns.filter((_, j) => j !== i))}>حذف ستون</Btn>
            </div>
          </div>
        </details>
      ))}
      {columns.length < 8 && <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => onChange([...columns, { id: `mm${Date.now().toString(36)}`, title: "ستون جدید", menuId: megaMenus[0]?.id, items: [] }])}>افزودن ستون مگامنو</Btn>}
    </div>
  );
}

/* ============================ Composable component builder (Req 178-179) ============================ */

const PRIMITIVE_LABEL: Record<string, string> = { text: "متن", image: "تصویر", badge: "نشان", button: "دکمه", product_image: "تصویر محصول", product_title: "نام محصول", price: "قیمت", installment_info: "اقساط", rating: "امتیاز", spacer: "فاصله" };
function BuilderPanel({ flash }: { flash: F }) {
  const registry = useAsync(() => studioApi.registry());
  const [code, setCode] = useState(""); const [title, setTitle] = useState("");
  const [nodes, setNodes] = useState<ComposableNode[]>([{ type: "product_image" }, { type: "badge", props: { value: "ویژه" } }, { type: "product_title" }, { type: "price" }, { type: "installment_info" }, { type: "button", props: { label: "خرید", href: "shop" } }]);
  if (registry.error) return <ErrorState message={registry.error} onRetry={registry.load} />;
  if (!registry.data) return <LoadingState />;
  const composables = (registry.data.items as { id: string; code: string; title: string; kind: string }[]).filter((c) => c.kind === "composable");
  const sample: CommerceProduct = { id: "s", name: "پیراهن کتان کلبه", brand: "Kolbe", category: "پیراهن", productType: "shirt", gender: "unisex", seasons: [], vibes: [], priceRial: "38000000", installmentPriceRial: null, perInstallmentRial: "9500000", compareAtRial: null, discountPercent: 0, installmentEnabled: true, installmentProviders: [], image: null, flatLay: null, available: 4, isNew: true, createdAt: "", rating: 4.8, reviewCount: 9, variants: [] };
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="space-y-3 p-4">
        <p className="text-[14px] font-extrabold">ساخت کامپوننت بدون کدنویسی</p>
        <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">فقط از اجزای امن: {registry.data.primitives.join("، ")}. اجرای کد دلخواه ممنوع است؛ کامپوننت‌های کدنویسی‌شده فقط توسط توسعه‌دهنده ثبت می‌شوند.</p>
        <div className="grid gap-2 sm:grid-cols-2"><Field label="کد"><Input value={code} onChange={(v) => setCode(v.toLowerCase().replace(/[^a-z0-9_]/g, ""))} /></Field><Field label="عنوان"><Input value={title} onChange={setTitle} /></Field></div>
        <ul className="space-y-1.5">{nodes.map((n, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-[var(--kv-line)] px-2 py-1.5">
            <b className="w-24 text-[12px]">{PRIMITIVE_LABEL[n.type] ?? n.type}</b>
            {["text", "badge"].includes(n.type) && <Input className="flex-1" value={String(n.props?.value ?? "")} onChange={(value) => setNodes(nodes.map((x, j) => (j === i ? { ...x, props: { ...x.props, value } } : x)))} />}
            {n.type === "button" && <><Input className="w-28" value={String(n.props?.label ?? "")} onChange={(label) => setNodes(nodes.map((x, j) => (j === i ? { ...x, props: { ...x.props, label } } : x)))} /><Input className="w-28" value={String(n.props?.href ?? "")} onChange={(href) => setNodes(nodes.map((x, j) => (j === i ? { ...x, props: { ...x.props, href } } : x)))} /></>}
            {n.type === "image" && <Input className="flex-1" value={String(n.props?.src ?? "")} onChange={(src) => setNodes(nodes.map((x, j) => (j === i ? { ...x, props: { ...x.props, src } } : x)))} placeholder="https://…" />}
            <span className="mr-auto flex gap-1"><button aria-label="بالا" onClick={() => { if (!i) return; const l = [...nodes]; [l[i - 1], l[i]] = [l[i]!, l[i - 1]!]; setNodes(l); }}><ArrowUp size={13} /></button><button aria-label="حذف" onClick={() => setNodes(nodes.filter((_, j) => j !== i))} className="text-[var(--kv-danger)]"><Trash2 size={13} /></button></span>
          </li>
        ))}</ul>
        <div className="flex flex-wrap gap-1.5">{Object.keys(PRIMITIVE_LABEL).map((t) => <button key={t} onClick={() => setNodes([...nodes, { type: t, props: t === "text" ? { value: "متن" } : t === "button" ? { label: "مشاهده", href: "shop" } : {} }])} className="rounded-full border border-[var(--kv-line)] px-2.5 py-1 text-[11.5px] hover:border-[var(--kv-accent)]">+ {PRIMITIVE_LABEL[t]}</button>)}</div>
        <Btn variant="accent" size="sm" disabled={code.length < 2 || title.length < 2 || !nodes.length} onClick={async () => { try { await studioApi.createComposable({ code, title, composition: [{ type: "container", children: nodes }] }); flash("کامپوننت ثبت شد و در رجیستری در دسترس است"); await registry.load(); } catch (e) { flash(errMsg(e)); } }}>ثبت در رجیستری</Btn>
        {composables.length > 0 && <div className="border-t border-[var(--kv-line)] pt-3"><p className="mb-2 text-[12.5px] font-bold">کامپوننت‌های ساخته‌شده</p><div className="flex flex-wrap gap-2">{composables.map((c) => <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--kv-surface-2)] px-3 py-1 text-[12px]">{c.title}<button aria-label="حذف" onClick={async () => { try { await studioApi.deleteComponent(c.id); await registry.load(); } catch (e) { flash(errMsg(e)); } }} className="text-[var(--kv-danger)]"><Trash2 size={12} /></button></span>)}</div></div>}
      </Card>
      <div><p className="mb-2 text-[12px] font-bold text-[var(--kv-muted)]">پیش‌نمایش زنده (همان رندرکننده سایت)</p><div className="rounded-[18px] border border-dashed border-[var(--kv-line-strong)] bg-[var(--kv-bg)] p-3"><Composable nodes={[{ type: "container", children: nodes }]} payload={{}} product={sample} onNav={() => undefined} /></div></div>
    </div>
  );
}

/* ============================ Style intelligence admin (Req 252, 256, 259) ============================ */

const STYLE_CAT: Record<string, string> = { coat: "کت/پالتو", knitwear: "بافت", shirt: "پیراهن", trousers: "شلوار", shoes: "کفش", accessory: "اکسسوری" };
function StylePanel({ flash }: { flash: F }) {
  const { data, error, load } = useAsync(() => studioApi.styleMatrix());
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const cell = (a: string, b: string) => data.items.find((r) => (r.category_a === a && r.category_b === b) || (r.category_a === b && r.category_b === a));
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><p className="text-[14px] font-extrabold">تحلیل ویژگی‌های استایل محصولات</p><p className="mt-1 text-[12px] text-[var(--kv-muted)]">درخواست‌های «product.style_analysis_requested» توسط Worker به‌صورت غیرهمزمان پردازش می‌شوند؛ این دکمه صف را فوراً اجرا می‌کند.</p></div>
        <Btn variant="soft" size="sm" disabled={busy} onClick={async () => { setBusy(true); try { const r = await studioApi.analyzePending(); flash(`${fa(r.processed)} محصول تحلیل شد`); } catch (e) { flash(errMsg(e)); } finally { setBusy(false); } }}>{busy ? "در حال اجرا…" : "اجرای صف تحلیل"}</Btn>
      </Card>
      <Card className="overflow-hidden">
        <p className="p-4 text-[14px] font-extrabold">ماتریس سازگاری دسته‌ها (کلیک برای تغییر)</p>
        <div className="kv-scroll overflow-x-auto p-4 pt-0">
          <table className="kv-table min-w-[640px] text-center"><thead><tr><th></th>{data.categories.map((c) => <th key={c}>{STYLE_CAT[c] ?? c}</th>)}</tr></thead>
            <tbody>{data.categories.map((a) => <tr key={a}><th>{STYLE_CAT[a] ?? a}</th>{data.categories.map((b) => { const r = cell(a, b); return (
              <td key={b}><button onClick={async () => {
                const compatible = r ? !r.compatible : a !== b;
                try { await studioApi.saveMatrix({ categoryA: a, categoryB: b, compatible, scoreWeight: compatible ? 90 : 15, reason: compatible ? "" : "این ترکیب معتبر نیست." }); await load(); } catch (e) { flash(errMsg(e)); }
              }} className={cn("min-w-14 rounded-[8px] px-2 py-1 text-[11.5px] font-bold", !r ? "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]" : r.compatible ? "bg-[#E7F0E6] text-[#3E6B4A]" : "bg-[var(--kv-danger)]/10 text-[var(--kv-danger)]")}>{!r ? "پیش‌فرض" : r.compatible ? fa(r.score_weight) : "نامعتبر"}</button></td>
            ); })}</tr>)}</tbody></table>
        </div>
      </Card>
    </div>
  );
}

function ReviewsPanel({ flash }: { flash: F }) {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const { data, error, load } = useAsync(() => studioApi.reviews(status), [status]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <div className="space-y-3">
      <Segmented<"pending" | "approved" | "rejected"> options={[{ v: "pending", label: "در انتظار" }, { v: "approved", label: "منتشرشده" }, { v: "rejected", label: "ردشده" }]} value={status} onChange={setStatus} />
      {!data ? <LoadingState /> : data.items.length === 0 ? <Empty title="موردی نیست" desc="دیدگاه‌های خرید تأییدشده خودکار منتشر می‌شوند؛ بقیه اینجا بررسی می‌شوند." /> : data.items.map((r) => (
        <Card key={r.id} className="flex flex-wrap items-start gap-3 p-4">
          <div className="min-w-0 flex-1"><p className="text-[13px] font-bold">{r.product_name} · <span className="text-[#D6A94E]">{"★".repeat(r.rating)}</span></p><p className="text-[11.5px] text-[var(--kv-muted)]">{r.display_name} · {formatPersianDateTime(r.created_at)}{r.verified_purchase && " · خرید تأییدشده"}</p>{r.body && <p className="mt-1 text-[12.5px] leading-6">{r.body}</p>}{(r.photo_file_ids?.length ?? 0) > 0 && <ReviewThumbs id={r.id} count={r.photo_file_ids!.length} />}</div>
          {status !== "approved" && <Btn size="sm" variant="accent" onClick={async () => { await studioApi.moderateReview(r.id, "approved"); flash("منتشر شد"); await load(); }}>انتشار</Btn>}
          {status !== "rejected" && <Btn size="sm" variant="ghost" onClick={async () => { await studioApi.moderateReview(r.id, "rejected"); flash("رد شد"); await load(); }}>رد</Btn>}
        </Card>
      ))}
    </div>
  );
}

/** Pending review photos are private — moderators get server-rendered thumbnails (Req 203). */
function ReviewThumbs({ id, count }: { id: string; count: number }) {
  const [items, setItems] = useState<{ fileId: string; dataUrl: string }[] | null>(null);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => { let alive = true; studioApi.reviewPhotos(id).then((r) => alive && setItems(r.items)).catch(() => alive && setItems([])); return () => { alive = false; }; }, [id]);
  return (
    <div className="mt-2 flex gap-2" data-testid="review-thumbs">
      {items === null ? Array.from({ length: count }, (_, i) => <span key={i} className="h-16 w-16 animate-pulse rounded-[10px] bg-[var(--kv-surface-2)]" />)
        : items.map((p) => <button key={p.fileId} onClick={() => setBig(p.dataUrl)} className="h-16 w-16 overflow-hidden rounded-[10px] border border-[var(--kv-line)]" aria-label="بزرگ‌نمایی عکس"><img src={p.dataUrl} alt="عکس ارسالی مشتری" className="h-full w-full object-cover" /></button>)}
      {big && <div role="dialog" aria-modal="true" aria-label="عکس مشتری" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-4" onClick={() => setBig(null)}><img src={big} alt="" className="max-h-[80vh] rounded-[12px]" /></div>}
    </div>
  );
}

function InsightsPanel() {
  const leads = useAsync(() => studioApi.leads());
  const analytics = useAsync(() => studioApi.analytics());
  const EVENT: Record<string, string> = { "component.view": "نمایش کامپوننت", "banner.click": "کلیک بنر", "product_card.click": "کلیک کارت محصول", "campaign.click": "کلیک کمپین", "cta.click": "کلیک CTA" };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="overflow-hidden"><p className="p-4 text-[14px] font-extrabold">سرنخ‌های صفحات (متصل به CRM)</p>
        {!leads.data ? <LoadingState /> : <div className="kv-scroll max-h-[420px] overflow-auto"><table className="kv-table min-w-[480px]"><thead><tr><th>نام</th><th>تماس</th><th>صفحه</th><th>زمان</th></tr></thead><tbody>{leads.data.items.map((l) => <tr key={l.id}><td>{l.full_name ?? "—"}</td><td dir="ltr">{l.phone ?? l.email}</td><td>{l.page_code}</td><td className="text-[11px]">{formatPersianDateTime(l.created_at)}</td></tr>)}</tbody></table></div>}
      </Card>
      <Card className="overflow-hidden"><p className="p-4 text-[14px] font-extrabold">رویدادهای کامپوننت‌ها (۳۰ روز)</p>
        {!analytics.data ? <LoadingState /> : <div className="kv-scroll max-h-[420px] overflow-auto"><table className="kv-table min-w-[420px]"><thead><tr><th>رویداد</th><th>کامپوننت</th><th>صفحه</th><th>تعداد</th></tr></thead><tbody>{analytics.data.items.map((a, i) => <tr key={i}><td>{EVENT[a.event_type] ?? a.event_type}</td><td>{a.component_code ?? "—"}</td><td>{a.page_code ?? "—"}</td><td className="tabular-nums">{fa(a.total)}</td></tr>)}</tbody></table></div>}
      </Card>
    </div>
  );
}
