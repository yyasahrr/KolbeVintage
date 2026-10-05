import { useEffect, useState } from "react";
import { crmApi, crmIntelApi, supplier360Api, type Supplier360Overview } from "../data/api";
import { formatPersianDateTime } from "../data/persian-date";
import { fmtNum } from "../data/catalog";
import { fmtToman } from "../data/contracts";
import { Btn, Card, ErrorState, LoadingState, Status, WorkspaceModal } from "./primitives";
import { COOPERATION_STATUS_FA, CRM_LIFECYCLE_FA, CRM_PRIORITY_FA, PERSON_TYPE_FA, TICKET_STATUS_FA, faLabel } from "../data/fa-labels";
import { CrmRelationshipCenter } from "./crm-relationship-center";

const text=(v:unknown,f="ثبت نشده")=>v===null||v===undefined||v===""?f:String(v);
const when=(v:unknown)=>v?formatPersianDateTime(String(v)):"ثبت نشده";

export function SupplierCrmWorkspace({supplierId,onClose,onNavigate}:{supplierId:string;onClose:()=>void;onNavigate?:(domain:string)=>void}){
  const [view,setView]=useState<Supplier360Overview|null>(null);
  const [relationship,setRelationship]=useState<Record<string,unknown>|null>(null);
  const [timeline,setTimeline]=useState<Record<string,unknown>[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [retry,setRetry]=useState(0);
  const [editing,setEditing]=useState(false);
  const [message,setMessage]=useState("");
  useEffect(()=>{
    let active=true;
    setError(null);setView(null);
    void Promise.all([
      supplier360Api.overview(supplierId,90),
      crmApi.userRelationship(supplierId),
    ]).then(async([v,r])=>{
      const history=await crmIntelApi.timeline(String(r.contact.id));
      if(active){setView(v);setRelationship(r.contact);setTimeline(history.items);}
    }).catch(e=>{if(active)setError(e instanceof Error?e.message:"دریافت پرونده تأمین‌کننده انجام نشد.");});
    return()=>{active=false;};
  },[supplierId,retry]);

  const supplier=(view?.supplier??{}) as Record<string,unknown>;
  const performance=(view?.performance??{}) as Record<string,unknown>;
  const finance=view?.financeSummary;
  return <WorkspaceModal open onClose={onClose} title="پرونده CRM تأمین‌کننده">
    {error?<ErrorState message={error} onRetry={()=>setRetry(retry+1)}/>:!view?<LoadingState label="در حال بارگذاری پرونده ارتباط…"/>:<div className="space-y-4">
      {message&&<p role="status" className="text-sm">{message}</p>}
      <Btn variant="soft" onClick={()=>setEditing(true)}>تعاملات، یادداشت‌ها و پیگیری‌ها</Btn>
      {onNavigate&&<div className="flex flex-wrap gap-2">{[["orders","مرکز سفارش‌ها"],["wms","انبار و کنترل کیفیت"],["finance","مرکز مالی"]].map(([domain,label])=><Btn key={domain} size="sm" variant="soft" onClick={()=>onNavigate(domain!)}>{label}</Btn>)}</div>}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-[18px] font-extrabold">{text(supplier.brand_name??supplier.legal_name??supplier.display_name,"تأمین‌کننده")}</h2>
            <p className="mt-1 text-[12px] text-[var(--kv-muted)]">{text(supplier.display_name,"—")} · {text(supplier.phone,"بدون موبایل")} · {text(supplier.email,"بدون ایمیل")}</p></div>
          <div className="flex flex-wrap gap-2"><Status value={faLabel(COOPERATION_STATUS_FA,supplier.cooperation_status??view.status.current)}/>
            <Status value={relationship?text(relationship.owner_name,"بدون مسئول"):"بدون مسئول CRM"}/></div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["آخرین تعامل CRM",when(relationship?.last_interaction_at)],
            ["اقدام بعدی",when(relationship?.next_followup_at)],
            ["اولویت",faLabel(CRM_PRIORITY_FA,relationship?.priority)],
            ["مرحله ارتباط",faLabel(CRM_LIFECYCLE_FA,relationship?.lifecycle_stage)],
          ].map(([l,v])=><div key={l} className="rounded-[12px] bg-[var(--kv-surface-2)] p-3"><p className="text-[11px] text-[var(--kv-muted)]">{l}</p><p className="mt-1 text-[12.5px] font-bold">{v}</p></div>)}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5"><h3 className="font-extrabold">اطلاعات رابطه</h3>
          <dl className="mt-3 space-y-2 text-[12.5px]">
            {[
              ["نام حقوقی",supplier.legal_name],["نام برند",supplier.brand_name],["شهر",supplier.city],
              ["تلفن",supplier.phone],["ایمیل",supplier.email],["نوع شخصیت",faLabel(PERSON_TYPE_FA,supplier.person_type)],
              ["شروع همکاری",supplier.created_at],
            ].map(([l,v])=><div key={String(l)} className="flex justify-between gap-4 border-b border-dashed border-[var(--kv-line)] pb-2"><dt className="text-[var(--kv-muted)]">{String(l)}</dt><dd className="font-semibold">{l==="شروع همکاری"?when(v):text(v)}</dd></div>)}
          </dl>
        </Card>
        <Card className="p-5"><h3 className="font-extrabold">خلاصه عملکرد — فقط خواندنی</h3>
          <p className="mt-1 text-[11px] text-[var(--kv-muted)]">منبع حقیقت سفارش، WMS، QC و مالی در دامنه‌های اصلی باقی می‌ماند.</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {[
              ["امتیاز عملکرد",text(performance.score??performance.performance_score,"—")],
              ["نرخ قبولی QC",performance.qc_acceptance_rate===undefined?"—":`${fmtNum(Number(performance.qc_acceptance_rate))}٪`],
              ["موجودی نزد کلبه",fmtNum(Number(view.inventory?.on_hand??0))],
              ["تیکت باز",fmtNum(Number(view.tickets?.openCount??0))],
            ].map(([l,v])=><div key={l} className="rounded-[11px] bg-[var(--kv-surface-2)] p-3"><p className="text-[11px] text-[var(--kv-muted)]">{l}</p><p className="mt-1 font-extrabold">{v}</p></div>)}
          </div>
        </Card>
      </div>

      <Card className="p-5"><h3 className="font-extrabold">خلاصه مالی — فقط خواندنی</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          {[
            ["قابل پرداخت",fmtToman(finance?.payableRial??"0")],["قابل تسویه",fmtToman(finance?.availableRial??"0")],
            ["مسدود",fmtToman(finance?.blockedRial??"0")],["تسویه‌شده",fmtToman(finance?.settledRial??"0")],
          ].map(([l,v])=><div key={l} className="rounded-[11px] bg-[var(--kv-surface-2)] p-3"><p className="text-[11px] text-[var(--kv-muted)]">{l}</p><p className="mt-1 font-bold">{v}</p></div>)}
        </div>
      </Card>

      <Card className="p-5"><h3 className="font-extrabold">پشتیبانی و تاریخچه رابطه</h3>
        <div className="mt-3 space-y-2">
          {view.tickets.items.length===0&&timeline.length===0?<p className="text-[12px] text-[var(--kv-muted)]">رویدادی ثبت نشده است.</p>:null}
          {view.tickets.items.slice(0,5).map((row)=><div key={String(row.id)} className="rounded-[10px] border border-[var(--kv-line)] p-3 text-[12px]"><b>{text(row.subject,"تیکت")}</b><span className="mr-2 text-[var(--kv-muted)]">{faLabel(TICKET_STATUS_FA,row.status)}</span></div>)}
          {timeline.slice(0,12).map((row)=><div key={String(row.id)} className="flex justify-between gap-4 rounded-[10px] border border-[var(--kv-line)] p-3 text-[12px]"><span>{text(row.title,"رویداد ارتباط")}</span><span className="text-[11px] text-[var(--kv-muted)]">{when(row.occurred_at)}</span></div>)}
        </div>
      </Card>
    </div>}
    {editing&&<CrmRelationshipCenter mode="relationship" userId={supplierId} flash={setMessage} onClose={()=>{setEditing(false);setRetry(retry+1);}}/>}
  </WorkspaceModal>;
}
