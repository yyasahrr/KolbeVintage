import { useEffect, useState } from 'react';
import { studioApi, mediaSrc } from '../data/experience-api';
import { filesApi } from '../data/api';
import { Btn, Empty, ErrorState, Field, Input, LoadingState } from '../components/primitives';
import { resetPickerCache } from './admin-section-editor';
import { cmsError } from './cms-api';

type Request=<T>(path:string,init?:RequestInit)=>Promise<T>;
export default function ContentMediaCenter({flash}:{flash:(m:string)=>void;request?:Request}) {
  const [assets,setAssets]=useState<Awaited<ReturnType<typeof studioApi.assets>>['items']|null>(null),[error,setError]=useState(''),[q,setQ]=useState(''),[busy,setBusy]=useState(false);
  const load=()=>{setError('');void studioApi.assets({search:q}).then(r=>setAssets(r.items)).catch(e=>setError(cmsError(e)));};
  useEffect(()=>{const t=window.setTimeout(load,300);return()=>window.clearTimeout(t);},[q]);
  const upload=async(file:File)=>{setBusy(true);setError('');try{const stored=await filesApi.upload(file);await studioApi.createAsset({fileId:stored.id,title:file.name.slice(0,150),assetType:file.type.startsWith('video/')?'video':'image',folder:'content'});resetPickerCache();flash('رسانه در سرور ثبت شد');load();}catch(e){setError(cmsError(e));}finally{setBusy(false);}};
  return <div dir="rtl" className="min-w-0 space-y-4"><header><h2 className="text-xl font-bold">مرکز رسانه</h2><p className="mt-1 text-sm text-[var(--kv-muted)]">دارایی‌های سایت و انتخاب رسانه برای صفحات. نویسندگی مجله در مدیریت محتوا انجام می‌شود.</p></header><div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><Field label="جست‌وجوی رسانه"><Input value={q} onChange={setQ}/></Field></div><label className="rounded-lg border border-[var(--kv-line)] px-3 py-2 text-sm">{busy?'در حال بارگذاری…':'بارگذاری رسانه'}<input disabled={busy} type="file" className="mt-2 block max-w-full text-xs" accept="image/jpeg,image/png,image/webp,image/avif,video/mp4,video/webm" onChange={e=>{const f=e.target.files?.[0];if(f)void upload(f);e.target.value='';}}/></label></div>{error&&<ErrorState message={error} onRetry={load}/>} {!assets?<LoadingState/>:!assets.length?<Empty title="رسانه‌ای پیدا نشد" desc="یک رسانه بارگذاری کنید یا جست‌وجو را تغییر دهید."/>:<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{assets.map(a=><article key={a.id} className="min-w-0 overflow-hidden rounded-lg border border-[var(--kv-line)]">{a.asset_type==='video'?<video src={mediaSrc(a.url)} controls className="aspect-video w-full"/>:<img src={mediaSrc(a.url)} alt={a.alt_text||a.title} className="aspect-video w-full object-cover" loading="lazy"/>}<div className="space-y-2 p-3"><b className="block break-words text-sm">{a.title}</b><Btn size="sm" variant="ghost" disabled={busy} onClick={async()=>{setBusy(true);try{await studioApi.deleteAsset(a.id);resetPickerCache();load();}catch(e){setError(cmsError(e));}finally{setBusy(false);}}}>حذف رسانهٔ بدون استفاده</Btn></div></article>)}</div>}</div>;
}
