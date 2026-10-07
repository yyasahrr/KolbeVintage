import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock3, Plus, RefreshCw, UserRoundCheck } from "lucide-react";
import { crmApi, crmIntelApi } from "../data/api";
import { PersianDatePicker } from "./persian-date-picker";
import { formatPersianDateTime } from "../data/persian-date";
import { CRM_LIFECYCLE_FA as LIFECYCLE_FA, CRM_PRIORITY_FA as PRIORITY_FA } from "../data/fa-labels";
import { Btn, Card, Empty, ErrorState, LoadingState, SearchBox, Segmented, Status, WorkspaceModal } from "./primitives";

type Row = Record<string, unknown>;
type Owner = { id: string; display_name: string };

const text = (value: unknown, fallback = "ثبت نشده") => value === null || value === undefined || value === "" ? fallback : String(value);
const dt = (value: unknown) => value ? formatPersianDateTime(String(value)) : "بدون موعد";

const ACTOR_FA: Record<string,string> = { customer:"مشتری", vip:"خریدار VIP", wholesale_buyer:"خریدار عمده", supplier:"تأمین‌کننده", partner:"شریک", other:"سرنخ" };

function toIso(local: string) {
  return local ? new Date(local).toISOString() : null;
}

export function CrmRelationshipCenter({ mode, flash, userId, onClose }: { mode: "overview" | "followups" | "relationship" | "contacts"; flash: (message: string) => void; userId?: string; onClose?: () => void }) {
  const [owners,setOwners]=useState<Owner[]>([]);
  const [summary,setSummary]=useState<Record<string,number>|null>(null);
  const [tasks,setTasks]=useState<Row[]|null>(null);
  const [view,setView]=useState("all");
  const [ownerFilter,setOwnerFilter]=useState("");
  const [offset,setOffset]=useState(0);
  const [busy,setBusy]=useState(false);
  const pending=useRef(false);
  const [searchError,setSearchError]=useState<string|null>(null);
  const [detailError,setDetailError]=useState<string|null>(null);
  const selectedRef=useRef<string|null>(null);
  const mutate=async(run:()=>Promise<unknown>)=>{
    if(pending.current)return;
    pending.current=true;setBusy(true);
    try{await run();}catch(e){flash(e instanceof Error?e.message:"ثبت تغییر انجام نشد. دوباره تلاش کنید.");}
    finally{pending.current=false;setBusy(false);}
  };
  const [search,setSearch]=useState("");
  const [searchRows,setSearchRows]=useState<Row[]>([]);
  const [searching,setSearching]=useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<{contact:Row;tasks:Row[];interactions:Row[];notes:Row[];labels:Row[]}|null>(null);
  const [availableLabels,setAvailableLabels]=useState<Row[]>([]);
  const [labelCode,setLabelCode]=useState("");
  const [error,setError]=useState<string|null>(null);
  const [leadOpen,setLeadOpen]=useState(false);
  const [lead,setLead]=useState({name:"",phone:"",email:"",organization:"",ownerUserId:"",priority:"normal",nextFollowupAt:""});
  const [rescheduleDates,setRescheduleDates]=useState<Record<string,string|null>>({});
  const [task,setTask]=useState({title:"",description:"",assignedTo:"",dueAt:"",priority:"normal"});
  const [interaction,setInteraction]=useState({channel:"call",outcome:"successful",subject:"",body:"",nextFollowupAt:""});
  const [note,setNote]=useState("");
  const [linkSearch,setLinkSearch]=useState("");
  const [linkRows,setLinkRows]=useState<Row[]>([]);

  const load=useCallback(async()=>{
    try{
      setError(null);
      const [s,o,a]=await Promise.all([
        crmApi.relationshipSummary(),
        crmApi.owners(),
        crmApi.actionCenter({view,ownerId:ownerFilter||undefined,limit:60,offset}),
      ]);
      setSummary(s.kpis); setOwners(o.items); setTasks(a.items);
    }catch(e){setError(e instanceof Error?e.message:"خطا در بارگذاری CRM");}
  },[view,ownerFilter,offset]);

  useEffect(()=>{void load();},[load]);
  useEffect(()=>{void crmIntelApi.labels().then(r=>setAvailableLabels(r.items)).catch(e=>flash(e instanceof Error?e.message:"بارگذاری برچسب‌ها انجام نشد."));},[flash]);

  useEffect(()=>{
    let active=true;
    setSearchRows([]);setSearchError(null);
    if(search.trim().length<2&&(mode!=="contacts"||search.trim().length>0)){setSearching(false);return;}
    setSearching(true);
    const timer=window.setTimeout(async()=>{
      try{const r=await crmApi.globalSearch(search.trim(),20,mode==="contacts"?offset:0);if(active)setSearchRows(r.items);}
      catch(e){if(active)setSearchError(e instanceof Error?e.message:"جست‌وجو انجام نشد. دوباره تلاش کنید.");} finally{if(active)setSearching(false);}
    },250);
    return()=>{active=false;window.clearTimeout(timer);};
  },[search,mode,offset]);

  useEffect(()=>{
    let active=true;
    setLinkRows([]);
    if(linkSearch.trim().length<2)return;
    const timer=window.setTimeout(async()=>{
      try{const r=await crmApi.globalSearch(linkSearch.trim(),12);if(active)setLinkRows(r.items.filter((row)=>!!row.user_id));}
      catch(e){if(active)flash(e instanceof Error?e.message:"جست‌وجوی حساب انجام نشد.");}
    },250);
    return()=>{active=false;window.clearTimeout(timer);};
  },[linkSearch]);

  const openDetail=async(id:string)=>{
    selectedRef.current=id;setSelected(id);setDetail(null);setDetailError(null);
    try{const result=await crmApi.relationship(id);if(selectedRef.current===id)setDetail(result);}
    catch(e){if(selectedRef.current===id)setDetailError(e instanceof Error?e.message:"خطا در باز کردن پرونده");}
  };
  useEffect(()=>{
    if(!userId)return;
    let active=true;
    void crmApi.userRelationship(userId).then(result=>{if(active)void openDetail(String(result.contact.id));})
      .catch(e=>{if(active){setSelected(userId);setDetailError(e instanceof Error?e.message:"دریافت پرونده انجام نشد.");}});
    return()=>{active=false;selectedRef.current=null;};
  },[userId]);
  const openSearchResult=async(row:Row)=>{
    try{
      let contactId=row.contact_id?String(row.contact_id):"";
      if(!contactId&&row.user_id){
        const linked=await crmApi.userRelationship(String(row.user_id));
        contactId=String(linked.contact.id);
      }
      if(contactId) await openDetail(contactId);
    }catch(e){flash(e instanceof Error?e.message:"خطا در باز کردن پرونده");}
  };

  const saveLead=async()=>{
    if(lead.name.trim().length<2)return;
    try{
      const r=await crmApi.createLead({
        name:lead.name.trim(),phone:lead.phone.trim()||null,email:lead.email.trim()||null,
        organization:lead.organization.trim()||null,ownerUserId:lead.ownerUserId||null,
        priority:lead.priority,nextFollowupAt:toIso(lead.nextFollowupAt),
      });
      setLeadOpen(false);setLead({name:"",phone:"",email:"",organization:"",ownerUserId:"",priority:"normal",nextFollowupAt:""});
      flash("سرنخ ثبت شد");await load();await openDetail(r.id);
    }catch(e){flash(e instanceof Error?e.message:"ثبت سرنخ ناموفق بود");}
  };

  const reloadDetail=async()=>{if(selected)setDetail(await crmApi.relationship(selected));};

  const addTask=async()=>{
    if(!selected||task.title.trim().length<2)return;
    try{
      await crmApi.addTask(selected,{title:task.title.trim(),description:task.description.trim(),
        assignedTo:task.assignedTo||null,dueAt:toIso(task.dueAt),priority:task.priority});
      setTask({title:"",description:"",assignedTo:"",dueAt:"",priority:"normal"});
      flash("پیگیری ثبت شد");await Promise.all([reloadDetail(),load()]);
    }catch(e){flash(e instanceof Error?e.message:"ثبت پیگیری ناموفق بود");}
  };

  const addInteraction=async()=>{
    if(!selected||interaction.subject.trim().length<2)return;
    try{
      await crmApi.addInteraction(selected,{channel:interaction.channel,outcome:interaction.outcome,
        subject:interaction.subject.trim(),body:interaction.body.trim(),nextFollowupAt:toIso(interaction.nextFollowupAt)});
      setInteraction({channel:"call",outcome:"successful",subject:"",body:"",nextFollowupAt:""});
      flash("تعامل ثبت شد");await Promise.all([reloadDetail(),load()]);
    }catch(e){flash(e instanceof Error?e.message:"ثبت تعامل ناموفق بود");}
  };

  const addNote=async()=>{
    if(!selected||note.trim().length<2)return;
    try{await crmIntelApi.addNote(selected,{body:note.trim(),visibility:"internal"});setNote("");flash("یادداشت ثبت شد");await reloadDetail();}
    catch(e){flash(e instanceof Error?e.message:"ثبت یادداشت ناموفق بود");}
  };

  const linkLead=async(userId:string)=>{
    if(!selected)return;
    try{
      const merged=await crmApi.linkLeadToUser(selected,userId);
      const nextId=String(merged.id??selected);
      setLinkSearch("");setLinkRows([]);flash("سرنخ به حساب واقعی متصل شد");
      setSelected(nextId);setDetail(await crmApi.relationship(nextId));await load();
    }catch(e){flash(e instanceof Error?e.message:"اتصال سرنخ ناموفق بود");}
  };

  const kpis=useMemo(()=>[
    ["پیگیری عقب‌افتاده",summary?.overdue??0],
    ["پیگیری امروز",summary?.today??0],
    ["۷ روز آینده",summary?.next_7_days??0],
    ["بدون مسئول",summary?.unassigned??0],
    ["سرنخ",summary?.leads??0],
    ["در خطر",summary?.at_risk??0],
  ],[summary]);

  if(error&&!tasks&&mode!=="relationship")return <ErrorState message={error} onRetry={load}/>;

  return <div className="space-y-4">
    {(mode==="overview"||mode==="contacts")&&<>
      {mode==="overview"&&(!summary?<LoadingState label="در حال بارگذاری نمای کلی…"/>:
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {kpis.map(([label,value])=><Card key={String(label)} className="p-4">
          <p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums">{Number(value).toLocaleString("fa-IR")}</p>
        </Card>)}
      </div>)}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="font-extrabold">جست‌وجوی سراسری CRM</p><p className="text-[11.5px] text-[var(--kv-muted)]">نام، موبایل، ایمیل یا نام کسب‌وکار</p></div>
          <Btn variant="accent" size="sm" icon={<Plus size={14}/>} onClick={()=>setLeadOpen(true)}>ثبت سرنخ</Btn>
        </div>
        <div className="mt-3"><SearchBox value={search} onChange={value=>{setSearch(value);setOffset(0);}} placeholder="حداقل دو حرف یا رقم…"/></div>
        {searching&&<div className="mt-3"><LoadingState label="در حال جست‌وجو…"/></div>}
        {searchError&&<p role="alert" className="mt-3 text-sm text-[var(--kv-danger)]">{searchError}</p>}
        {!searching&&!searchError&&(search.trim().length>=2||mode==="contacts")&&searchRows.length===0&&<div className="mt-3"><Empty title="موردی پیدا نشد" desc="عبارت دیگری را امتحان کنید."/></div>}
        {searchRows.length>0&&<div className="mt-3 divide-y divide-[var(--kv-line)] rounded-[12px] border border-[var(--kv-line)]">
          {searchRows.map(row=><button key={String(row.contact_id??row.user_id)} onClick={()=>void openSearchResult(row)}
            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-[var(--kv-surface-2)]">
            <span><span className="block text-[12.5px] font-bold">{text(row.display_name,"بدون نام")}</span>
              <span className="text-[11px] text-[var(--kv-muted)]">{text(row.organization,"—")} · {text(row.phone,"بدون شماره")}</span></span>
            <span className="flex items-center gap-2"><Status value={ACTOR_FA[String(row.actor_type)]??"مخاطب"}/><Status value={LIFECYCLE_FA[String(row.lifecycle_stage)]??"فعال"}/><span className="text-[11px] text-[var(--kv-muted)]">{text(row.owner_name,"بدون مسئول")}</span></span>
          </button>)}
        </div>}
      {mode==="contacts"&&<div className="mt-3 flex gap-2"><Btn size="sm" variant="soft" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>قبلی</Btn><Btn size="sm" variant="soft" disabled={searchRows.length<20} onClick={()=>setOffset(offset+20)}>بعدی</Btn></div>}
      </Card>
    </>}

    {mode!=="relationship"&&mode!=="contacts"&&<Card className="p-4">
      {error&&<ErrorState message={error} onRetry={load}/>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-extrabold">{mode==="overview"?"کارهای نیازمند اقدام":"پیگیری‌ها"}</p>
          <p className="text-[11.5px] text-[var(--kv-muted)]">کارهای ارتباط با مخاطبان و اقدام‌های بعدی</p></div>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14}/>} onClick={()=>void load()}>به‌روزرسانی</Btn>
      </div>
      <div className="mt-3"><Segmented value={view} onChange={v=>{setView(v);setOffset(0);}} options={[
        {v:"all",label:"همه"},{v:"mine",label:"پیگیری‌های من"},{v:"overdue",label:"عقب‌افتاده"},{v:"today",label:"امروز"},{v:"upcoming",label:"آینده"},{v:"unassigned",label:"بدون مسئول"},{v:"done",label:"انجام‌شده"},
      ]}/></div>
      <label className="mt-3 block text-sm">مسئول ارتباط <select aria-label="فیلتر مسئول ارتباط" value={ownerFilter} onChange={e=>{setOwnerFilter(e.target.value);setOffset(0);}} className="h-10 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"><option value="">همه مسئولان</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>
      {!tasks?<div className="mt-4"><LoadingState label="در حال بارگذاری پیگیری‌ها…"/></div>:tasks.length===0?
        <div className="mt-4"><Empty title="پیگیری بازی وجود ندارد" desc="کارهای جدید از پرونده مخاطب ثبت می‌شوند."/></div>:
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[840px] text-right text-[12.5px]">
          <thead><tr className="text-[11px] text-[var(--kv-muted)]">{["مخاطب","کار","موعد","اولویت","مسئول","مرحله","اقدام"].map(x=><th key={x} className="pb-2">{x}</th>)}</tr></thead>
          <tbody className="divide-y divide-[var(--kv-line)]">{tasks.map(row=><tr key={String(row.id)}>
            <td className="py-2.5"><b>{text(row.contact_name,"بدون نام")}</b><span className="block text-[11px] text-[var(--kv-muted)]">{text(row.phone,"—")}</span></td>
            <td className="py-2.5">{text(row.title)}</td><td className="py-2.5 tabular-nums">{dt(row.due_at)}</td>
            <td className="py-2.5"><Status value={PRIORITY_FA[String(row.priority)]??"عادی"}/></td>
            <td className="py-2.5">{text(row.assignee_name??row.owner_name,"بدون مسئول")}</td>
            <td className="py-2.5">{LIFECYCLE_FA[String(row.lifecycle_stage)]??"فعال"}</td>
            <td className="py-2.5"><span className="flex gap-1"><Btn variant="soft" size="sm" onClick={()=>void openDetail(String(row.contact_id))}>پرونده</Btn>
              {row.status==="open"&&<Btn disabled={busy} variant="soft" size="sm" icon={<Check size={13}/>} onClick={()=>void mutate(async()=>{await crmApi.updateTask(String(row.id),{status:"done"});flash("پیگیری انجام شد");await load();})}>انجام شد</Btn>}</span></td>
          </tr>)}</tbody>
        </table></div>}
      <div className="mt-3 flex gap-2"><Btn size="sm" variant="soft" disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-60))}>قبلی</Btn><Btn size="sm" variant="soft" disabled={(tasks?.length??0)<60} onClick={()=>setOffset(offset+60)}>بعدی</Btn></div>
    </Card>}

    <WorkspaceModal open={!!selected||mode==="relationship"} onClose={()=>{selectedRef.current=null;setSelected(null);setDetail(null);onClose?.();}} title="پرونده ارتباط و پیگیری">
      {detailError?<ErrorState message={detailError} onRetry={()=>{if(selected)void openDetail(selected);}}/>:!detail?<LoadingState label="در حال بارگذاری پرونده…"/>:<div className="space-y-4">
        {busy&&<p role="status" className="text-sm text-[var(--kv-muted)]">در حال ثبت تغییر…</p>}
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-[17px] font-extrabold">{text(detail.contact.display_name,"بدون نام")}</h3>
              <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{text(detail.contact.phone,"بدون شماره")} · {text(detail.contact.email,"بدون ایمیل")}</p></div>
            <div className="flex flex-wrap gap-2"><Status value={LIFECYCLE_FA[String(detail.contact.lifecycle_stage)]??"فعال"}/><Status value={PRIORITY_FA[String(detail.contact.priority)]??"عادی"}/></div>
          </div>
          {!detail.contact.user_id && String(detail.contact.lifecycle_stage)==="lead" && <div className="mt-4 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-3">
            <p className="text-[12.5px] font-extrabold">تبدیل سرنخ به حساب واقعی</p>
            <p className="mt-1 text-[11px] text-[var(--kv-muted)]">پس از ثبت‌نام مخاطب، حساب او را پیدا کنید؛ یادداشت‌ها، پیگیری‌ها، تعاملات و برچسب‌ها حفظ و ادغام می‌شوند.</p>
            <div className="mt-2"><SearchBox value={linkSearch} onChange={setLinkSearch} placeholder="نام، موبایل یا ایمیل حساب…"/></div>
            {linkRows.length>0&&<div className="mt-2 divide-y divide-[var(--kv-line)] rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
              {linkRows.map(row=><button key={String(row.user_id)} className="flex w-full items-center justify-between px-3 py-2.5 text-right hover:bg-[var(--kv-surface-2)]" disabled={busy} onClick={()=>void mutate(()=>linkLead(String(row.user_id)))}>
                <span><b className="block text-[12px]">{text(row.display_name,"بدون نام")}</b><span className="text-[11px] text-[var(--kv-muted)]">{text(row.phone,"—")} · {text(row.email,"—")}</span></span>
                <span className="text-[11px] font-bold">اتصال</span>
              </button>)}
            </div>}
          </div>}
          <p className="mt-3 text-sm text-[var(--kv-muted)]">آخرین تعامل: {dt(detail.contact.last_interaction_at)} · پیگیری بعدی: {dt(detail.contact.next_followup_at)}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="text-[11.5px]">مسئول ارتباط<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.owner_user_id??"")} disabled={busy} onChange={e=>{const value=e.target.value;void mutate(async()=>{await crmApi.updateRelationship(String(detail.contact.id),{ownerUserId:value||null});await reloadDetail();await load();});}}>
              <option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>
            <label className="text-[11.5px]">مرحله ارتباط<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.lifecycle_stage??"active")} disabled={busy} onChange={e=>{const value=e.target.value;void mutate(async()=>{await crmApi.updateRelationship(String(detail.contact.id),{lifecycleStage:value});await reloadDetail();});}}>
              {Object.entries(LIFECYCLE_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
            <label className="text-[11.5px]">اولویت<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.priority??"normal")} disabled={busy} onChange={e=>{const value=e.target.value;void mutate(async()=>{await crmApi.updateRelationship(String(detail.contact.id),{priority:value});await reloadDetail();});}}>
              {Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4"><p className="font-extrabold">ثبت پیگیری</p>
            <div className="mt-3 space-y-2">
              <input className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" aria-label="عنوان پیگیری" placeholder="عنوان پیگیری" value={task.title} onChange={e=>setTask({...task,title:e.target.value})}/>
              <textarea className="min-h-20 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-[12.5px]" aria-label="توضیح" placeholder="توضیح" value={task.description} onChange={e=>setTask({...task,description:e.target.value})}/>
              <label className="block text-sm">مسئول پیگیری<select aria-label="مسئول پیگیری" className="mt-1 h-10 w-full rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={task.assignedTo} onChange={e=>setTask({...task,assignedTo:e.target.value})}><option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label><div className="grid gap-2 sm:grid-cols-2"><PersianDatePicker label="موعد پیگیری" withTime value={task.dueAt||null} onChange={value=>setTask({...task,dueAt:value||""})}/>
                <select aria-label="اولویت پیگیری" className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={task.priority} onChange={e=>setTask({...task,priority:e.target.value})}>{Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
              <Btn variant="accent" className="w-full" icon={<Clock3 size={14}/>} disabled={busy||task.title.trim().length<2} onClick={()=>void mutate(addTask)}>ثبت پیگیری</Btn>
            </div>
          </Card>
          <Card className="p-4"><p className="font-extrabold">ثبت تعامل</p>
            <div className="mt-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2"><select className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" aria-label="نوع تعامل" value={interaction.channel} onChange={e=>setInteraction({...interaction,channel:e.target.value})}>
                <option value="call">تماس تلفنی</option><option value="sms">پیامک</option><option value="whatsapp">واتساپ</option><option value="email">ایمیل</option><option value="meeting">جلسه</option><option value="other">سایر</option></select>
                <select className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" aria-label="نتیجه تعامل" value={interaction.outcome} onChange={e=>setInteraction({...interaction,outcome:e.target.value})}>
                  <option value="successful">موفق</option><option value="no_answer">بدون پاسخ</option><option value="follow_up">نیازمند پیگیری</option><option value="closed">بسته شد</option><option value="neutral">ثبت اطلاعات</option></select></div>
              <input className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" aria-label="موضوع تعامل" placeholder="موضوع تعامل" value={interaction.subject} onChange={e=>setInteraction({...interaction,subject:e.target.value})}/>
              <textarea className="min-h-20 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-[12.5px]" aria-label="خلاصه گفتگو" placeholder="خلاصه گفتگو" value={interaction.body} onChange={e=>setInteraction({...interaction,body:e.target.value})}/>
              <PersianDatePicker label="موعد بعدی تعامل" withTime value={interaction.nextFollowupAt||null} onChange={value=>setInteraction({...interaction,nextFollowupAt:value||""})}/>
              <Btn variant="accent" className="w-full" icon={<UserRoundCheck size={14}/>} disabled={busy||interaction.subject.trim().length<2} onClick={()=>void mutate(addInteraction)}>ثبت تعامل</Btn>
            </div>
          </Card>
        </div>

        <Card className="p-4"><p className="font-extrabold">برچسب‌های ارتباط</p>
          <div className="mt-2 flex flex-wrap gap-2">{detail.labels.length?detail.labels.map(label=><Status key={String(label.code)} value={text(label.title,"برچسب")}/>):<span className="text-sm text-[var(--kv-muted)]">برچسبی ثبت نشده است.</span>}</div>
          <div className="mt-3 flex flex-wrap gap-2"><select aria-label="افزودن برچسب ارتباط" className="h-10 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={labelCode} onChange={e=>setLabelCode(e.target.value)}><option value="">انتخاب برچسب</option>{availableLabels.filter(l=>l.active!==false).map(l=><option key={String(l.code)} value={String(l.code)}>{text(l.title,"برچسب")}</option>)}</select><Btn size="sm" variant="soft" disabled={busy||!labelCode} onClick={()=>void mutate(async()=>{if(!selected)return;await crmApi.addContactLabel(selected,labelCode);setLabelCode("");await reloadDetail();})}>افزودن برچسب</Btn></div>
        </Card>
        <Card className="p-4"><p className="font-extrabold">پیگیری‌های پرونده</p>
          <div className="mt-3 space-y-2">{detail.tasks.length===0?<p className="text-[12px] text-[var(--kv-muted)]">پیگیری ثبت نشده است.</p>:detail.tasks.map(row=><div key={String(row.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--kv-line)] p-3">
            <span><b className="text-[12.5px]">{text(row.title)}</b><span className="block text-[11px] text-[var(--kv-muted)]">{dt(row.due_at)} · {text(row.assignee_name,"بدون مسئول")}</span></span>
            <div className="flex flex-wrap items-center gap-2"><label className="text-sm">مسئول پیگیری<select aria-label="تغییر مسئول پیگیری" disabled={busy} className="mr-2 h-10 rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={String(row.assigned_to??"")} onChange={e=>{const assignedTo=e.target.value||null;void mutate(async()=>{await crmApi.updateTask(String(row.id),{assignedTo});await Promise.all([reloadDetail(),load()]);});}}><option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>{row.status!=="open"&&<Btn disabled={busy} size="sm" variant="soft" onClick={()=>void mutate(async()=>{await crmApi.updateTask(String(row.id),{status:"open"});await Promise.all([reloadDetail(),load()]);})}>بازگشایی</Btn>}{row.status==="open"&&<><Btn disabled={busy} size="sm" variant="soft" onClick={()=>void mutate(async()=>{await crmApi.updateTask(String(row.id),{status:"done"});await Promise.all([reloadDetail(),load()]);})}>انجام شد</Btn><Btn disabled={busy} size="sm" variant="soft" onClick={()=>void mutate(async()=>{await crmApi.updateTask(String(row.id),{status:"cancelled"});await Promise.all([reloadDetail(),load()]);})}>لغو</Btn><div className="w-full max-w-[260px]"><PersianDatePicker label="زمان‌بندی مجدد پیگیری" withTime value={rescheduleDates[String(row.id)]??null} onChange={value=>setRescheduleDates({...rescheduleDates,[String(row.id)]:value})}/><Btn disabled={busy||!rescheduleDates[String(row.id)]} size="sm" variant="soft" onClick={()=>void mutate(async()=>{await crmApi.updateTask(String(row.id),{dueAt:rescheduleDates[String(row.id)]});await Promise.all([reloadDetail(),load()]);})}>ثبت موعد جدید</Btn></div></>}<Status value={String(row.status)==="done"?"انجام‌شده":String(row.status)==="cancelled"?"لغوشده":"باز"}/></div></div>)}</div>
        </Card>
        <Card className="p-4"><p className="font-extrabold">تعاملات اخیر</p>
          <div className="mt-3 space-y-2">{detail.interactions.length===0?<p className="text-[12px] text-[var(--kv-muted)]">تعاملی ثبت نشده است.</p>:detail.interactions.map(row=><div key={String(row.id)} className="rounded-[10px] border border-[var(--kv-line)] p-3">
            <div className="flex justify-between gap-3"><b className="text-[12.5px]">{text(row.subject)}</b><span className="text-[11px] text-[var(--kv-muted)]">{dt(row.occurred_at)}</span></div>
            <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{text(row.body,"بدون توضیح")}</p></div>)}</div>
        </Card>
        <Card className="p-4"><div className="flex items-center justify-between gap-3"><p className="font-extrabold">یادداشت‌های داخلی</p><span className="text-[11px] text-[var(--kv-muted)]">فقط تیم داخلی</span></div>
          <div className="mt-3 flex gap-2"><input className="h-10 min-w-0 flex-1 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" aria-label="یادداشت کوتاه…" placeholder="یادداشت کوتاه…" value={note} onChange={e=>setNote(e.target.value)}/><Btn variant="accent" size="sm" disabled={busy||note.trim().length<2} onClick={()=>void mutate(addNote)}>ثبت</Btn></div>
          <div className="mt-3 space-y-2">{detail.notes.length===0?<p className="text-[12px] text-[var(--kv-muted)]">یادداشتی ثبت نشده است.</p>:detail.notes.map(row=><div key={String(row.id)} className="rounded-[10px] border border-[var(--kv-line)] p-3">
            <p className="text-[12px]">{text(row.body)}</p><span className="mt-1 block text-[10.5px] text-[var(--kv-muted)]">{text(row.author_name,"تیم CRM")} · {dt(row.created_at)}</span>
          </div>)}</div>
        </Card>
      </div>}
    </WorkspaceModal>

    <WorkspaceModal open={leadOpen} onClose={()=>setLeadOpen(false)} title="ثبت سرنخ جدید">
      <div className="mx-auto max-w-2xl space-y-3">
        <input className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" aria-label="نام و نام خانوادگی / نام مخاطب" placeholder="نام و نام خانوادگی / نام مخاطب" value={lead.name} onChange={e=>setLead({...lead,name:e.target.value})}/>
        <div className="grid gap-3 sm:grid-cols-2"><input className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" aria-label="موبایل" placeholder="موبایل" value={lead.phone} onChange={e=>setLead({...lead,phone:e.target.value})}/>
          <input className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" aria-label="ایمیل" placeholder="ایمیل" value={lead.email} onChange={e=>setLead({...lead,email:e.target.value})}/></div>
        <input className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" aria-label="کسب‌وکار / سازمان" placeholder="کسب‌وکار / سازمان" value={lead.organization} onChange={e=>setLead({...lead,organization:e.target.value})}/>
        <div className="grid gap-3 sm:grid-cols-3"><select className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={lead.ownerUserId} onChange={e=>setLead({...lead,ownerUserId:e.target.value})}><option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select>
          <select className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={lead.priority} onChange={e=>setLead({...lead,priority:e.target.value})}>{Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
          <PersianDatePicker label="موعد پیگیری اولیه" withTime value={lead.nextFollowupAt||null} onChange={value=>setLead({...lead,nextFollowupAt:value||""})}/></div>
        <Btn variant="accent" className="w-full" icon={<Plus size={14}/>} disabled={busy||lead.name.trim().length<2} onClick={()=>void mutate(saveLead)}>ثبت سرنخ</Btn>
      </div>
    </WorkspaceModal>
  </div>;
}
