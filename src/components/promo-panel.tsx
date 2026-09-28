import { useEffect, useState } from "react";
import { Card, Btn, LoadingState, ErrorState, Empty, Field, Input, Select } from "../components/primitives";
import { promoApi } from "../data/api";
import { fmtMoney } from "../data/catalog";

export function PromoPanel() {
  const [coupons, setCoupons] = useState<unknown[]|null>(null);
  const [festivals, setFestivals] = useState<unknown[]|null>(null);
  const [error, setError] = useState<string|null>(null);
  const [tab, setTab] = useState<"coupons"|"festivals">("coupons");
  const [newCoupon, setNewCoupon] = useState({ code:"", type:"percent" as "percent"|"fixed", value:"100000", endsAt:new Date(Date.now()+7*864e5).toISOString().slice(0,10), minOrderRial:"0" });
  const [newFestival, setNewFestival] = useState({ code:"yald-2025", name:"جشنواره یلدا", startsAt:new Date().toISOString(), endsAt:new Date(Date.now()+7*864e5).toISOString(), discountPercent:15, themePaletteCode:"" });
  const load = async () => {
    setError(null);
    try {
      const [c, f] = await Promise.all([promoApi.coupons() as Promise<{items:unknown[]}>, promoApi.festivals() as Promise<{items:unknown[]}>]);
      setCoupons(c.items); setFestivals(f.items);
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  useEffect(()=>{ void load(); },[]);
  const createCoupon = async () => {
    try {
      const endsAt = new Date(newCoupon.endsAt).toISOString();
      await promoApi.createCoupon({ code: newCoupon.code || undefined, type: newCoupon.type, value: newCoupon.value, minOrderRial: newCoupon.minOrderRial, endsAt, audience:["customer"] });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  const createFestival = async () => {
    try {
      await promoApi.createFestival({ code: newFestival.code, name: newFestival.name, startsAt: new Date(newFestival.startsAt).toISOString(), endsAt: new Date(newFestival.endsAt).toISOString(), discountPercent: newFestival.discountPercent, themePaletteCode: newFestival.themePaletteCode || null, audience:["customer"], scope:{ productIds:[], categories:[] } });
      await load();
    } catch(e){ setError(e instanceof Error?e.message:"خطا"); }
  };
  if(error) return <ErrorState message={error} onRetry={load} />;
  if(!coupons || !festivals) return <LoadingState label="در حال بارگذاری کوپن/جشنواره…" />;
  return (
    <div className="space-y-6 animate-[fadeUp_0.35s_ease]">
      <div className="flex gap-2">
        <Btn variant={tab==="coupons"?"accent":"soft"} size="sm" onClick={()=>setTab("coupons")}>کوپن‌ها</Btn>
        <Btn variant={tab==="festivals"?"accent":"soft"} size="sm" onClick={()=>setTab("festivals")}>جشنواره‌ها (Festivals)</Btn>
      </div>
      {tab==="coupons" ? (
        <>
          <Card className="p-4">
            <p className="text-[13px] font-bold">ایجاد کوپن جدید (فقط با موتور سرور validate می‌شود؛ با کوپن CRM و جشنواره تجمیع نمی‌شود)</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="کد (اختیاری، اگر خالی باشد سرور تولید می‌کند)"><Input value={newCoupon.code} onChange={v=>setNewCoupon({...newCoupon, code:v.toUpperCase()})} placeholder="مثلاً SUMMER15" /></Field>
              <Field label="نوع"><Select options={["percent","fixed"]} value={newCoupon.type} onChange={v=>setNewCoupon({...newCoupon, type:v as "percent"|"fixed"})} /></Field>
              <Field label={newCoupon.type==="percent"?"درصد (۱-۱۰۰)":"مبلغ ثابت (ریال)"}><Input value={newCoupon.value} onChange={v=>setNewCoupon({...newCoupon, value:v.replace(/\D/g,"")})} /></Field>
              <Field label="حداقل سفارش (ریال)"><Input value={newCoupon.minOrderRial} onChange={v=>setNewCoupon({...newCoupon, minOrderRial:v.replace(/\D/g,"")})} /></Field>
              <Field label="انقضا (date)"><Input value={newCoupon.endsAt} onChange={v=>setNewCoupon({...newCoupon, endsAt:v})} /></Field>
              <div className="flex items-end"><Btn variant="accent" onClick={()=>void createCoupon()}>ایجاد کوپن</Btn></div>
            </div>
            <p className="mt-2 text-[11px] text-[var(--kv-muted)]">اعتبارسنجی: POST /coupons/validate — روزانه/ساعتی (dailyStartTime) و scope (productIds/categories) و audience (customer/vip/wholesale) در سرور چک می‌شود.</p>
          </Card>
          <Card className="overflow-hidden">
            <div className="px-4 py-3"><p className="text-[13px] font-bold">فهرست کوپن‌ها ({coupons.length})</p></div>
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[900px] text-xs">
                <thead><tr><th>کد</th><th>نوع</th><th>مقدار</th><th>حداقل سفارش</th><th>مصرف</th><th>انقضا</th><th>منبع</th></tr></thead>
                <tbody>
                  {(coupons as {id:string; code:string; type:string; value:string; min_order_rial:string; used_count:number; usage_limit_total:number|null; ends_at:string; source:string}[]).map(c=>(
                    <tr key={c.id}><td className="font-mono" dir="ltr">{c.code}</td><td>{c.type}</td><td className="tabular-nums">{c.type==="percent"? `${Number(c.value)}٪`: fmtMoney(Number(c.value))}</td><td className="tabular-nums">{fmtMoney(Number(c.min_order_rial))}</td><td className="tabular-nums">{c.used_count}/{c.usage_limit_total ?? "∞"}</td><td className="tabular-nums">{new Date(c.ends_at).toLocaleDateString("fa-IR")}</td><td className="text-[var(--kv-muted)]">{c.source}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {coupons.length===0 && <Empty title="کوپنی ثبت نشده" desc="کوپن خوش‌آمدگویی/جشنواره/CRM از موتور واحد می‌آید." />}
          </Card>
        </>
      ) : (
        <>
          <Card className="p-4">
            <p className="text-[13px] font-bold">ایجاد جشنواره (Festival) — با پالت رنگ مرتبط می‌شود؛ تایمر صفحه تمدید خودکار دارد</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <Field label="کد"><Input value={newFestival.code} onChange={v=>setNewFestival({...newFestival, code:v})} /></Field>
              <Field label="نام"><Input value={newFestival.name} onChange={v=>setNewFestival({...newFestival, name:v})} /></Field>
              <Field label="شروع (ISO)"><Input value={newFestival.startsAt} onChange={v=>setNewFestival({...newFestival, startsAt:v})} /></Field>
              <Field label="پایان (ISO)"><Input value={newFestival.endsAt} onChange={v=>setNewFestival({...newFestival, endsAt:v})} /></Field>
              <Field label="درصد تخفیف"><Input value={String(newFestival.discountPercent)} onChange={v=>setNewFestival({...newFestival, discountPercent: Number(v.replace(/\D/g,""))||0})} /></Field>
              <Field label="کد پالت تم (اختیاری، palette_activations.mode=festival)"><Input value={newFestival.themePaletteCode} onChange={v=>setNewFestival({...newFestival, themePaletteCode:v})} placeholder="مثلاً yalda-warm" /></Field>
              <div className="flex items-end"><Btn variant="accent" onClick={()=>void createFestival()}>ایجاد جشنواره</Btn></div>
            </div>
            <p className="mt-2 text-[11px] text-[var(--kv-muted)]">جشنواره فعال (active + بازه زمانی + audience/scope) در GET /site/active-palette اولویت دارد (festival → scheduled → manual).</p>
          </Card>
          <Card className="overflow-hidden">
            <div className="px-4 py-3"><p className="text-[13px] font-bold">فهرست جشنواره‌ها ({festivals.length})</p></div>
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[900px] text-xs">
                <thead><tr><th>کد</th><th>نام</th><th>بازه</th><th>درصد</th><th>پالت</th><th>وضعیت</th></tr></thead>
                <tbody>
                  {(festivals as {id:string; code:string; name:string; starts_at:string; ends_at:string; discount_percent:number|null; theme_palette_code:string|null; active:boolean}[]).map(f=>(
                    <tr key={f.id}><td className="font-mono">{f.code}</td><td className="font-bold">{f.name}</td><td className="tabular-nums">{new Date(f.starts_at).toLocaleDateString("fa-IR")} → {new Date(f.ends_at).toLocaleDateString("fa-IR")}</td><td>{f.discount_percent ?? "—"}%</td><td className="font-mono">{f.theme_palette_code ?? "—"}</td><td>{f.active ? "فعال" : "غیرفعال"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {festivals.length===0 && <Empty title="جشنواره‌ای نیست" desc="جشنواره‌ها به کوپن‌های festival_id و به پالت جشنواره لینک می‌شوند." />}
          </Card>
        </>
      )}
    </div>
  );
}
