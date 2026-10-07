import { useEffect, useState } from "react";
import { Btn, Card, Empty, ErrorState, LoadingState, Segmented } from "../components/primitives";
import { formatPersianDateTime } from "../data/persian-date";
import { CmsPages } from "./cms-pages";
import { CmsJournal } from "./cms-journal";
import { CmsGlobalContent } from "./cms-global-content";
import { CmsComponentCatalog } from "./cms-component-catalog";
import { cmsWorkspaceApi, cmsError, PAGE_STATUS } from "./cms-api";
import { cmsApi } from '../data/api';

type Tab="overview"|"pages"|"journal"|"global"|"components";
export function CmsCenter({flash}:{flash:(m:string)=>void}) {
  const [tab,setTab]=useState<Tab>("overview");
  const [create,setCreate]=useState(false);
  return <div dir="rtl" className="min-w-0 space-y-5">
    <header><h2 className="text-xl font-bold">مدیریت محتوا</h2><p className="mt-1 text-sm text-[var(--kv-muted)]">محتوا را در پیش‌نویس ذخیره، بررسی و با اقدام صریح منتشر کنید.</p></header>
    <Segmented<Tab> options={[{v:"overview",label:"نمای کلی"},{v:"pages",label:"صفحات"},{v:"components",label:"کامپوننت‌ها"},{v:"journal",label:"مجله"},{v:"global",label:"اجزای سایت"}]} value={tab} onChange={(v)=>{setTab(v);setCreate(false);}}/>
    {tab==="overview"&&<CmsOverview onCreate={(v)=>{setTab(v);setCreate(true);}}/>}
    {tab==="pages"&&<CmsPages flash={flash} initialCreate={create}/>}
    {tab==="components"&&<CmsComponentCatalog/>}
    {tab==="journal"&&<CmsJournal flash={flash} initialCreate={create}/>}
    {tab==="global"&&<CmsGlobalContent flash={flash}/>}
  </div>;
}
function CmsOverview({onCreate}:{onCreate:(v:"pages"|"journal")=>void}) {
  const [data,setData]=useState<Awaited<ReturnType<typeof cmsWorkspaceApi.overview>>|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const load=()=>{setError("");void cmsWorkspaceApi.overview().then(setData).catch(e=>setError(cmsError(e)));};
  useEffect(load,[]);
  if(error)return <ErrorState message={error} onRetry={load}/>;
  if(!data)return <LoadingState/>;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Btn variant="accent" onClick={()=>onCreate("pages")}>+ صفحه جدید</Btn><Btn variant="soft" onClick={()=>onCreate("journal")}>+ مطلب جدید</Btn></div>
    {data.counts.length===0&&<Btn disabled={busy} variant="soft" onClick={async()=>{setBusy(true);try{await cmsApi.bootstrap();load();}catch(e){setError(cmsError(e));}finally{setBusy(false);}}}>{busy?'در حال ساخت…':'راه‌اندازی صفحه اصلی و صفحات اولیه در پیش‌نویس'}</Btn>}
    <div className="flex flex-wrap gap-6 border-y border-[var(--kv-line)] py-4">{data.counts.map(c=><div key={c.status}><p className="text-xs text-[var(--kv-muted)]">{PAGE_STATUS[c.status]??"محتوا"}</p><b className="text-xl">{c.count.toLocaleString("fa-IR")}</b></div>)}</div>
    <div className="grid gap-4 md:grid-cols-2"><Card className="p-4"><h3 className="mb-3 font-bold">آخرین تغییرات</h3>{!data.recent.length?<Empty title="هنوز صفحه‌ای ندارید" desc="با ایجاد یک صفحه شروع کنید."/>:<ul className="divide-y divide-[var(--kv-line)]">{data.recent.map(p=><li key={p.id} className="py-3"><b className="break-words text-sm">{p.title}</b><p className="text-xs text-[var(--kv-muted)]">{PAGE_STATUS[p.status]} · {formatPersianDateTime(p.updated_at)}</p></li>)}</ul>}</Card><Card className="p-4"><h3 className="mb-3 font-bold">انتشارهای پیش رو</h3>{!data.upcoming.length?<p className="text-sm text-[var(--kv-muted)]">انتشاری زمان‌بندی نشده است.</p>:data.upcoming.map((p,i)=><p key={i} className="py-2 text-sm">{p.title} · {formatPersianDateTime(p.starts_at)}</p>)}</Card></div>
  </div>;
}
