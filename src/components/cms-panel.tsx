import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty, Field, Input, Select, Textarea } from "../components/primitives";
import { cmsApi } from "../data/api";

export function CmsPanel() {
  const [pages, setPages] = useState<unknown[]|null>(null);
  const [palettes, setPalettes] = useState<unknown[]|null>(null);
  const [components, setComponents] = useState<unknown[]|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [newPage, setNewPage] = useState({ code:"home", title:"خانه", path:"/", description:"" });
  const [newPalette, setNewPalette] = useState({ code:"default-warm", name:"گرم پیش‌فرض", colors:{ primary:"#1B2A4A", secondary:"#C1613B", accent:"#C1613B", background:"#F9F6F1", surface:"#FFFFFF", text:"#0E1527" } });

  const load = async () => {
    setError(null);
    try {

      const [p, pal, comp] = await Promise.all([
        cmsApi.pages() as Promise<{items:unknown[]}>,
        cmsApi.palettes() as Promise<{items:unknown[]}>,
        cmsApi.components(),
      ]);
      setPages(p.items); setPalettes(pal.items); setComponents(comp.items);
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const createPage = async () => {
    try {

      await cmsApi.createPage({ code:newPage.code, title:newPage.title, path:newPage.path, description:newPage.description, seo:{}, active:true });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const addSection = async (pageId:string, componentCode:string) => {
    try {

      await cmsApi.createSection(pageId, { componentCode, title: componentCode, payload:{ text:"نمونه" }, visible:true });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const createPalette = async () => {
    try {

      await cmsApi.createPalette({ code:newPalette.code, name:newPalette.name, colors:newPalette.colors });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const activatePalette = async (paletteId:string, mode:"manual"|"scheduled"|"festival") => {
    try {

      await cmsApi.activatePalette(paletteId, { mode, startsAt: new Date().toISOString() });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!pages || !palettes || !components) return <LoadingState label="در حال بارگذاری CMS…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="text-[13px] font-bold">صفحه جدید (Page Builder)</p>
          <div className="mt-3 grid gap-3">
            <div className="grid grid-cols-2 gap-3"><Field label="code"><Input value={newPage.code} onChange={v=>setNewPage({...newPage, code:v})} /></Field><Field label="title"><Input value={newPage.title} onChange={v=>setNewPage({...newPage, title:v})} /></Field></div>
            <Field label="path"><Input value={newPage.path} onChange={v=>setNewPage({...newPage, path:v})} placeholder="/ یا /campaign/yald" /></Field>
            <Field label="description"><Textarea rows={2} value={newPage.description} onChange={(v)=>setNewPage({...newPage, description: v})} /></Field>
            <Btn variant="accent" size="sm" onClick={()=>void createPage()}>ایجاد صفحه</Btn>
            <p className="text-[11px] text-[var(--kv-muted)]">عمومی: GET /site/pages/:code — بخش‌ها بر اساس position مرتب و فقط visible نمایش داده می‌شوند. ترتیب با drag&amp;drop و POST /admin/cms/pages/:id/sections/reorder ذخیره می‌شود.</p>
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-[13px] font-bold">پالت رنگ (Color Palette) + فعال‌سازی</p>
          <div className="mt-3 grid gap-3">
            <div className="grid grid-cols-2 gap-3"><Field label="code"><Input value={newPalette.code} onChange={v=>setNewPalette({...newPalette, code:v})} /></Field><Field label="name"><Input value={newPalette.name} onChange={v=>setNewPalette({...newPalette, name:v})} /></Field></div>
            <div className="grid grid-cols-3 gap-2">{Object.entries(newPalette.colors).map(([k,v])=>(
              <Field key={k} label={k}><Input value={v as string} onChange={nv=>setNewPalette({...newPalette, colors:{...newPalette.colors, [k]:nv}})} /></Field>
            ))}</div>
            <Btn variant="accent" size="sm" onClick={()=>void createPalette()}>ایجاد پالت</Btn>
            <p className="text-[11px] text-[var(--kv-muted)]">فعال‌سازی: manual / scheduled / festival. حالت festival فقط وقتی معتبر است که جشنواره لینک‌شده (festival_id) فعال و در بازه باشد. اولویت سایت: festival → scheduled → manual — GET /site/active-palette.</p>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">صفحات CMS ({pages.length}) — رجیستری کامپوننت‌ها: {(components as {code:string; component_type:string}[]).map(c=>`${c.code}(${c.component_type})`).join("، ") || "بدون کامپوننت"}</p></div>
        <div className="space-y-4 p-4">
          {(pages as {id:string; code:string; title:string; path:string; section_count:number; active:boolean}[]).map(p=>(
            <div key={p.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
              <div className="flex items-center justify-between"><div><p className="text-[13px] font-bold">{p.title} <span className="font-mono text-[11px] text-[var(--kv-muted)]">/{p.code}</span></p><p className="text-[11px] text-[var(--kv-muted)]">{p.path} · {p.section_count} بخش · {p.active?"فعال":"غیرفعال"}</p></div>
                <div className="flex gap-2">
                  <Select options={(components as {code:string}[]).map(c=>c.code)} value={(components as {code:string}[])[0]?.code ?? ""} onChange={v=>void addSection(p.id, v)} />
                  <Btn size="sm" variant="soft" onClick={()=>void addSection(p.id, (components as {code:string}[])[0]?.code ?? "hero")}>افزودن بخش</Btn>
                </div>
              </div>
              <p className="mt-2 text-[11px] text-[var(--kv-muted)]">عمومی: <a href={`${(import.meta.env.VITE_API_BASE_URL ?? "")}/api/v1/site/pages/${p.code}`} target="_blank" rel="noopener" className="underline">GET /site/pages/{p.code}</a></p>
            </div>
          ))}
          {pages.length===0 && <Empty title="صفحه‌ای نیست" desc="صفحه خانه و کمپین‌ها را بسازید." />}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">پالت‌ها ({palettes.length})</p></div>
        <div className="space-y-3 p-4">
          {(palettes as {id:string; code:string; name:string; colors:Record<string,string>; activations:{mode:string; active:boolean; festivalId:string|null}[]}[]).map(pal=>(
            <div key={pal.id} className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-3 py-3">
              <div><p className="text-[13px] font-bold">{pal.name} <span className="font-mono text-[11px]">/{pal.code}</span></p><div className="mt-1 flex gap-1">{Object.values(pal.colors).slice(0,4).map(c=> <span key={c} className="h-5 w-5 rounded-full border border-[var(--kv-line)]" style={{background:c}} /> )}<span className="text-[11px] text-[var(--kv-muted)]">{pal.activations.filter(a=>a.active).length} فعال</span></div></div>
              <div className="flex gap-2"><Btn size="sm" variant="soft" onClick={()=>void activatePalette(pal.id,"manual")}>فعال‌سازی manual</Btn><Btn size="sm" variant="ghost" onClick={()=>void activatePalette(pal.id,"scheduled")}>scheduled</Btn></div>
            </div>
          ))}
          {palettes.length===0 && <Empty title="پالتی نیست" desc="پالت‌های مناسبتی را برای جشنواره بسازید." />}
        </div>
      </Card>
    </div>
  );
}
