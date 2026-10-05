import { useEffect, useState } from 'react';
import { studioApi } from '../data/experience-api';
import { formatPersianDateTime } from '../data/persian-date';
import { Btn, Empty, ErrorState, Field, Input, LoadingState, Select, WorkspaceModal } from '../components/primitives';
import { cmsError, cmsWorkspaceApi, PAGE_STATUS, PAGE_TYPE } from './cms-api';
import { PageWorkspace } from './cms-page-workspace';
type Page=Awaited<ReturnType<typeof studioApi.pages>>['items'][number];
const templates=[{label:'صفحه ساده',type:'generic',template:'blank'},{label:'لندینگ کمپین',type:'campaign',template:'campaign'},{label:'درباره ما',type:'about',template:'about'},{label:'کالکشن',type:'collection',template:'blank'},{label:'جذب سرنخ',type:'lead_generation',template:'lead'}];
export function CmsPages({flash,initialCreate=false}:{flash:(m:string)=>void;initialCreate?:boolean}) {
  const [offset,setOffset]=useState(0),[total,setTotal]=useState(0);
  const [pages,setPages]=useState<Page[]|null>(null),[error,setError]=useState(''),[q,setQ]=useState('');
  const [editing,setEditing]=useState<Page|null>(null),[create,setCreate]=useState(initialCreate),[copy,setCopy]=useState<Page|null>(null);
  const [title,setTitle]=useState(''),[path,setPath]=useState('/'),[template,setTemplate]=useState(templates[0]!.label),[busy,setBusy]=useState(false),[formError,setFormError]=useState('');
  const load=()=>{setError('');void studioApi.pages({search:q,limit:25,offset}).then(r=>{setPages(r.items);setTotal(r.total);}).catch(e=>setError(cmsError(e)));};
  useEffect(()=>{const t=window.setTimeout(load,250);return()=>window.clearTimeout(t);},[q,offset]);
  const openCreate=()=>{setTitle('');setPath('/');setFormError('');setCreate(true);};
  const run=async(fn:()=>Promise<unknown>)=>{setBusy(true);setFormError('');try{await fn();setCreate(false);setCopy(null);load();}catch(e){setFormError(cmsError(e));}finally{setBusy(false);}};
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-3"><div className="min-w-0 flex-1"><Input value={q} onChange={v=>{setQ(v);setOffset(0);}} placeholder="جست‌وجوی عنوان یا مسیر صفحه"/></div><Btn variant="accent" onClick={openCreate}>+ صفحه جدید</Btn></div>
    {error?<ErrorState message={error} onRetry={load}/>:!pages?<LoadingState/>:!pages.length?<Empty title="صفحه‌ای ساخته نشده" desc="یک صفحه پیش‌نویس ایجاد کنید؛ انتشار یک اقدام جداگانه است." action={<Btn onClick={openCreate}>صفحه جدید</Btn>}/>:<div className="divide-y divide-[var(--kv-line)] rounded-xl border border-[var(--kv-line)]">{pages.map(p=><article key={p.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
      <div className="min-w-0 flex-1"><b className="block break-words text-sm">{p.title}</b><p dir="ltr" className="break-all text-xs text-[var(--kv-muted)]">{p.path}</p><p className="mt-1 text-xs">{PAGE_TYPE[p.page_type]??'صفحه'} · {PAGE_STATUS[p.status]??'نیازمند بررسی'}{p.unpublished_changes?' · تغییرات منتشرنشده':''}</p><p className="mt-1 text-xs text-[var(--kv-muted)]">{formatPersianDateTime(String(p.updated_at))}{p.scheduled_start_at?` · شروع ${formatPersianDateTime(p.scheduled_start_at)}`:''}{p.scheduled_end_at?` · پایان ${formatPersianDateTime(p.scheduled_end_at)}`:''}</p></div>
      <div className="flex flex-wrap gap-2"><Btn size="sm" variant="accent" onClick={()=>setEditing(p)}>ویرایش</Btn><Btn size="sm" variant="soft" onClick={()=>{setCopy(p);setTitle(`${p.title} — کپی`);setPath('');setFormError('');}}>تکثیر</Btn>
      {p.code!=='home'&&<Btn size="sm" variant="ghost" disabled={busy} onClick={()=>void run(async()=>{await studioApi.unpublish(p.id,p.status!=='archived');flash(p.status==='archived'?'صفحه به پیش‌نویس برگشت':'صفحه بایگانی شد');})}>{p.status==='archived'?'بازگردانی':'بایگانی'}</Btn>}</div>
    </article>)}</div>}
    {total>25&&<div className="flex items-center gap-3"><Btn size="sm" disabled={offset===0} onClick={()=>setOffset(offset-25)}>قبلی</Btn><span className="text-xs">{Math.floor(offset/25)+1} / {Math.ceil(total/25)}</span><Btn size="sm" disabled={offset+25>=total} onClick={()=>setOffset(offset+25)}>بعدی</Btn></div>}
    {formError&&!create&&!copy&&<ErrorState message={formError} onRetry={load}/>}
    <WorkspaceModal open={create||!!copy} onClose={()=>{if(!busy){setCreate(false);setCopy(null);}}} title={copy?'تکثیر صفحه در پیش‌نویس':'صفحه جدید'}>
      <div className="mx-auto max-w-2xl space-y-4">{!copy&&<Field label="نوع صفحه"><Select options={templates.map(t=>t.label)} value={template} onChange={setTemplate}/></Field>}<Field label="عنوان"><Input value={title} onChange={setTitle}/></Field><Field label="مسیر یکتا" hint="مثلاً /campaign/autumn"><Input value={path} onChange={setPath}/></Field>{copy&&<p className="text-sm text-[var(--kv-muted)]">نسخه‌ها، زمان‌بندی و سابقهٔ انتشار کپی نمی‌شوند؛ مسیر جدید الزامی است.</p>}{formError&&<p role="alert" className="text-sm text-[var(--kv-danger)]">{formError}</p>}<Btn variant="accent" disabled={busy||title.trim().length<2||!/^\/[a-z0-9/_-]{1,120}$/.test(path)} onClick={()=>void run(async()=>{if(copy)await cmsWorkspaceApi.duplicate(copy.id,title,path);else{const t=templates.find(t=>t.label===template)!;await studioApi.createLanding({code:`page-${crypto.randomUUID().slice(0,8)}`,title,path,pageType:t.type,template:t.template});}flash('صفحه در پیش‌نویس ساخته شد');})}>{busy?'در حال ذخیره…':'ایجاد پیش‌نویس'}</Btn></div>
    </WorkspaceModal>
    {editing&&<PageWorkspace pageId={editing.id} flash={flash} onClose={()=>{setEditing(null);load();}}/>}
  </div>;
}
