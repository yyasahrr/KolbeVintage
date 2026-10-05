import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock3, Plus, RefreshCw, UserRoundCheck } from "lucide-react";
import { crmApi } from "../data/api";
import { formatPersianDateTime } from "../data/persian-date";
import { Btn, Card, Empty, ErrorState, LoadingState, SearchBox, Segmented, Status, WorkspaceModal } from "./primitives";

type Row = Record<string, unknown>;
type Owner = { id: string; display_name: string };

const text = (value: unknown, fallback = "ثبت نشده") => value === null || value === undefined || value === "" ? fallback : String(value);
const dt = (value: unknown) => value ? formatPersianDateTime(String(value)) : "بدون موعد";

const LIFECYCLE_FA: Record<string,string> = {
  lead:"سرنخ", prospect:"در حال ارزیابی", active:"فعال", loyal:"وفادار", at_risk:"در خطر",
  dormant:"کم‌فعال", churned:"ریزش‌یافته", partner:"شریک",
};
const PRIORITY_FA: Record<string,string> = { low:"کم", normal:"عادی", high:"زیاد", urgent:"فوری" };
const ACTOR_FA: Record<string,string> = { customer:"مشتری", vip:"خریدار VIP", wholesale_buyer:"خریدار عمده", supplier:"تأمین‌کننده", partner:"شریک", other:"سرنخ" };

function toIso(local: string) {
  return local ? new Date(local).toISOString() : null;
}

export function CrmRelationshipCenter({ mode, flash }: { mode: "overview" | "followups"; flash: (message: string) => void }) {
  const [owners,setOwners]=useState<Owner[]>([]);
  const [summary,setSummary]=useState<Record<string,number>|null>(null);
  const [tasks,setTasks]=useState<Row[]|null>(null);
  const [view,setView]=useState("all");
  const [search,setSearch]=useState("");
  const [searchRows,setSearchRows]=useState<Row[]>([]);
  const [searching,setSearching]=useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const [detail,setDetail]=useState<{contact:Row;tasks:Row[];interactions:Row[]}|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [leadOpen,setLeadOpen]=useState(false);
  const [lead,setLead]=useState({name:"",phone:"",email:"",organization:"",ownerUserId:"",priority:"normal",nextFollowupAt:""});
  const [task,setTask]=useState({title:"",description:"",assignedTo:"",dueAt:"",priority:"normal"});
  const [interaction,setInteraction]=useState({channel:"call",outcome:"successful",subject:"",body:"",nextFollowupAt:""});

  const load=useCallback(async()=>{
    try{
      setError(null);
      const [s,o,a]=await Promise.all([
        crmApi.relationshipSummary(),
        crmApi.owners(),
        crmApi.actionCenter({view,limit:60}),
      ]);
      setSummary(s.kpis); setOwners(o.items); setTasks(a.items);
    }catch(e){setError(e instanceof Error?e.message:"خطا در بارگذاری CRM");}
  },[view]);

  useEffect(()=>{void load();},[load]);

  useEffect(()=>{
    if(search.trim().length<2){setSearchRows([]);return;}
    const timer=window.setTimeout(async()=>{
      try{setSearching(true);const r=await crmApi.globalSearch(search.trim(),20);setSearchRows(r.items);}
      catch{setSearchRows([]);} finally{setSearching(false);}
    },250);
    return()=>window.clearTimeout(timer);
  },[search]);

  const openDetail=async(id:string)=>{
    setSelected(id); setDetail(null);
    try{setDetail(await crmApi.relationship(id));}
    catch(e){flash(e instanceof Error?e.message:"خطا در باز کردن پرونده");setSelected(null);}
  };
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

  const kpis=useMemo(()=>[
    ["پیگیری عقب‌افتاده",summary?.overdue??0],
    ["پیگیری امروز",summary?.today??0],
    ["۷ روز آینده",summary?.next_7_days??0],
    ["بدون مسئول",summary?.unassigned??0],
    ["سرنخ",summary?.leads??0],
    ["در خطر",summary?.at_risk??0],
  ],[summary]);

  if(error&&!tasks)return <ErrorState message={error} onRetry={load}/>;

  return <div className="space-y-4">
    {mode==="overview"&&<>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {kpis.map(([label,value])=><Card key={String(label)} className="p-4">
          <p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums">{Number(value).toLocaleString("fa-IR")}</p>
        </Card>)}
      </div>
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><p className="font-extrabold">جست‌وجوی سراسری CRM</p><p className="text-[11.5px] text-[var(--kv-muted)]">نام، موبایل، ایمیل یا نام کسب‌وکار</p></div>
          <Btn variant="accent" size="sm" icon={<Plus size={14}/>} onClick={()=>setLeadOpen(true)}>ثبت سرنخ</Btn>
        </div>
        <div className="mt-3"><SearchBox value={search} onChange={setSearch} placeholder="حداقل دو حرف یا رقم…"/></div>
        {searching&&<div className="mt-3"><LoadingState label="در حال جست‌وجو…"/></div>}
        {!searching&&search.trim().length>=2&&searchRows.length===0&&<div className="mt-3"><Empty title="موردی پیدا نشد" desc="عبارت دیگری را امتحان کنید."/></div>}
        {searchRows.length>0&&<div className="mt-3 divide-y divide-[var(--kv-line)] rounded-[12px] border border-[var(--kv-line)]">
          {searchRows.map(row=><button key={String(row.contact_id)} onClick={()=>void openSearchResult(row)}
            className="flex w-full items-center justify-between gap-3 px-3 py-3 text-right hover:bg-[var(--kv-surface-2)]">
            <span><span className="block text-[12.5px] font-bold">{text(row.display_name,"بدون نام")}</span>
              <span className="text-[11px] text-[var(--kv-muted)]">{text(row.organization,"—")} · {text(row.phone,"بدون شماره")}</span></span>
            <span className="flex items-center gap-2"><Status value={ACTOR_FA[String(row.actor_type)]??"مخاطب"}/><span className="text-[11px] text-[var(--kv-muted)]">{text(row.owner_name,"بدون مسئول")}</span></span>
          </button>)}
        </div>}
      </Card>
    </>}

    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-extrabold">{mode==="overview"?"کارهای نیازمند اقدام":"پیگیری‌ها"}</p>
          <p className="text-[11.5px] text-[var(--kv-muted)]">صف واحد کارهای CRM؛ بدون ساخت گردش‌کار موازی با سفارش، مالی یا WMS</p></div>
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14}/>} onClick={()=>void load()}>به‌روزرسانی</Btn>
      </div>
      <div className="mt-3"><Segmented value={view} onChange={setView} options={[
        {v:"all",label:"همه"},{v:"overdue",label:"عقب‌افتاده"},{v:"today",label:"امروز"},{v:"upcoming",label:"آینده"},{v:"unassigned",label:"بدون مسئول"},
      ]}/></div>
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
              <Btn variant="soft" size="sm" icon={<Check size={13}/>} onClick={async()=>{await crmApi.updateTask(String(row.id),{status:"done"});flash("پیگیری انجام شد");await load();}}>انجام شد</Btn></span></td>
          </tr>)}</tbody>
        </table></div>}
    </Card>

    <WorkspaceModal open={!!selected} onClose={()=>{setSelected(null);setDetail(null);}} title="پرونده ارتباط و پیگیری">
      {!detail?<LoadingState label="در حال بارگذاری پرونده…"/>:<div className="space-y-4">
        <Card className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-[17px] font-extrabold">{text(detail.contact.display_name,"بدون نام")}</h3>
              <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{text(detail.contact.phone,"بدون شماره")} · {text(detail.contact.email,"بدون ایمیل")}</p></div>
            <div className="flex flex-wrap gap-2"><Status value={LIFECYCLE_FA[String(detail.contact.lifecycle_stage)]??"فعال"}/><Status value={PRIORITY_FA[String(detail.contact.priority)]??"عادی"}/></div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="text-[11.5px]">مسئول ارتباط<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.owner_user_id??"")} onChange={async e=>{await crmApi.updateRelationship(String(detail.contact.id),{ownerUserId:e.target.value||null});await reloadDetail();await load();}}>
              <option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select></label>
            <label className="text-[11.5px]">مرحله ارتباط<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.lifecycle_stage??"active")} onChange={async e=>{await crmApi.updateRelationship(String(detail.contact.id),{lifecycleStage:e.target.value});await reloadDetail();}}>
              {Object.entries(LIFECYCLE_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
            <label className="text-[11.5px]">اولویت<select className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2"
              value={String(detail.contact.priority??"normal")} onChange={async e=>{await crmApi.updateRelationship(String(detail.contact.id),{priority:e.target.value});await reloadDetail();}}>
              {Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4"><p className="font-extrabold">ثبت پیگیری</p>
            <div className="mt-3 space-y-2">
              <input className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" placeholder="عنوان پیگیری" value={task.title} onChange={e=>setTask({...task,title:e.target.value})}/>
              <textarea className="min-h-20 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-[12.5px]" placeholder="توضیح" value={task.description} onChange={e=>setTask({...task,description:e.target.value})}/>
              <div className="grid gap-2 sm:grid-cols-2"><input type="datetime-local" className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={task.dueAt} onChange={e=>setTask({...task,dueAt:e.target.value})}/>
                <select className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={task.priority} onChange={e=>setTask({...task,priority:e.target.value})}>{Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
              <Btn variant="accent" className="w-full" icon={<Clock3 size={14}/>} onClick={()=>void addTask()}>ثبت پیگیری</Btn>
            </div>
          </Card>
          <Card className="p-4"><p className="font-extrabold">ثبت تعامل</p>
            <div className="mt-3 space-y-2">
              <div className="grid gap-2 sm:grid-cols-2"><select className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={interaction.channel} onChange={e=>setInteraction({...interaction,channel:e.target.value})}>
                <option value="call">تماس تلفنی</option><option value="sms">پیامک</option><option value="whatsapp">واتساپ</option><option value="email">ایمیل</option><option value="meeting">جلسه</option><option value="other">سایر</option></select>
                <select className="h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={interaction.outcome} onChange={e=>setInteraction({...interaction,outcome:e.target.value})}>
                  <option value="successful">موفق</option><option value="no_answer">بدون پاسخ</option><option value="follow_up">نیازمند پیگیری</option><option value="closed">بسته شد</option><option value="neutral">ثبت اطلاعات</option></select></div>
              <input className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px]" placeholder="موضوع تعامل" value={interaction.subject} onChange={e=>setInteraction({...interaction,subject:e.target.value})}/>
              <textarea className="min-h-20 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-3 text-[12.5px]" placeholder="خلاصه گفتگو" value={interaction.body} onChange={e=>setInteraction({...interaction,body:e.target.value})}/>
              <input type="datetime-local" className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={interaction.nextFollowupAt} onChange={e=>setInteraction({...interaction,nextFollowupAt:e.target.value})}/>
              <Btn variant="accent" className="w-full" icon={<UserRoundCheck size={14}/>} onClick={()=>void addInteraction()}>ثبت تعامل</Btn>
            </div>
          </Card>
        </div>

        <Card className="p-4"><p className="font-extrabold">پیگیری‌های پرونده</p>
          <div className="mt-3 space-y-2">{detail.tasks.length===0?<p className="text-[12px] text-[var(--kv-muted)]">پیگیری ثبت نشده است.</p>:detail.tasks.map(row=><div key={String(row.id)} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--kv-line)] p-3">
            <span><b className="text-[12.5px]">{text(row.title)}</b><span className="block text-[11px] text-[var(--kv-muted)]">{dt(row.due_at)} · {text(row.assignee_name,"بدون مسئول")}</span></span>
            <Status value={String(row.status)==="done"?"انجام‌شده":String(row.status)==="cancelled"?"لغوشده":"باز"}/></div>)}</div>
        </Card>
        <Card className="p-4"><p className="font-extrabold">تعاملات اخیر</p>
          <div className="mt-3 space-y-2">{detail.interactions.length===0?<p className="text-[12px] text-[var(--kv-muted)]">تعاملی ثبت نشده است.</p>:detail.interactions.map(row=><div key={String(row.id)} className="rounded-[10px] border border-[var(--kv-line)] p-3">
            <div className="flex justify-between gap-3"><b className="text-[12.5px]">{text(row.subject)}</b><span className="text-[11px] text-[var(--kv-muted)]">{dt(row.occurred_at)}</span></div>
            <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{text(row.body,"بدون توضیح")}</p></div>)}</div>
        </Card>
      </div>}
    </WorkspaceModal>

    <WorkspaceModal open={leadOpen} onClose={()=>setLeadOpen(false)} title="ثبت سرنخ جدید">
      <div className="mx-auto max-w-2xl space-y-3">
        <input className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" placeholder="نام و نام خانوادگی / نام مخاطب" value={lead.name} onChange={e=>setLead({...lead,name:e.target.value})}/>
        <div className="grid gap-3 sm:grid-cols-2"><input className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" placeholder="موبایل" value={lead.phone} onChange={e=>setLead({...lead,phone:e.target.value})}/>
          <input className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" placeholder="ایمیل" value={lead.email} onChange={e=>setLead({...lead,email:e.target.value})}/></div>
        <input className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3" placeholder="کسب‌وکار / سازمان" value={lead.organization} onChange={e=>setLead({...lead,organization:e.target.value})}/>
        <div className="grid gap-3 sm:grid-cols-3"><select className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={lead.ownerUserId} onChange={e=>setLead({...lead,ownerUserId:e.target.value})}><option value="">بدون مسئول</option>{owners.map(o=><option key={o.id} value={o.id}>{o.display_name}</option>)}</select>
          <select className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={lead.priority} onChange={e=>setLead({...lead,priority:e.target.value})}>{Object.entries(PRIORITY_FA).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
          <input type="datetime-local" className="h-11 rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2" value={lead.nextFollowupAt} onChange={e=>setLead({...lead,nextFollowupAt:e.target.value})}/></div>
        <Btn variant="accent" className="w-full" icon={<Plus size={14}/>} onClick={()=>void saveLead()}>ثبت سرنخ</Btn>
      </div>
    </WorkspaceModal>
  </div>;
}
