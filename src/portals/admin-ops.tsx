import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Ban, Check, Crown, Eye, Landmark, Pencil, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { SUPPLIERS, fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE, describeLimits, limitsOf, DEFAULT_LIMITS, type VipPlan, type PlanLimits } from "../data/platform";
import { useOps, opsNow, NO_FLAGS, type Application, type FieldType, type FormField, type Restriction, type RestrictionFlags } from "../data/ops";
import { AreaChart, BarList, Columns, DonutChart, Kpi } from "../components/charts";
import { ReturnsCenter } from "../components/support";
import { TicketBoardPanel } from "../components/ticket-board-panel";
import { useWallet } from "./supplier-wallet";
import { Btn, Card, Checkbox, Drawer, Empty, Field, Input, Segmented, Select, Status, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";
import { apiCall } from "../data/admin-api";

type F = (m: string) => void;
const faDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
/** Maps relative Persian timestamps ("امروز", "۲ هفته پیش") to a week index, 0 = this week. */
const weekIndex = (label: string) => {
  const t = faDigits(label); const n = Number(t.match(/\d+/)?.[0] ?? 1);
  if (t.includes("ماه")) return 4 * n; if (t.includes("هفته")) return n; if (t.includes("روز")) return Math.floor(n / 7); return 0;
};
const WEEKS = 8;
const weekLabels = Array.from({ length: WEEKS }, (_, i) => (i === WEEKS - 1 ? "این هفته" : `${fmtNum(WEEKS - 1 - i)} هفته قبل`));

/* ================= Finance ================= */
function SupplierPayoutRow({ id, name }: { id: string; name: string }) {
  const w = useWallet(id);
  return <tr><td><b>{name}</b></td><td className="tabular-nums">{fmtMoney(w.gross)}</td><td className="tabular-nums">{fmtNum(w.rate)}٪ · {fmtMoney(w.commission)}</td><td className="tabular-nums">{fmtMoney(w.escrowNet)}</td><td className="font-bold tabular-nums">{fmtMoney(w.balance)}</td></tr>;
}

export function FinanceCenter({ flash }: { flash: F }) {
  const { orders, retailOrders } = useStore();
  const ops = useOps();
  const [tab, setTab] = useState<"overview" | "payouts" | "banks" | "commission">("overview");
  const [refs, setRefs] = useState<Record<string, string>>({});
  const paidSubs = orders.flatMap((o) => o.subOrders.filter((s) => ["paid", "preparing", "shipped", "delivered"].includes(s.status)).map((s) => ({ o, s })));
  const retailPaid = retailOrders.filter((o) => o.status !== "در انتظار پرداخت");
  const retailByWeek = Array(WEEKS).fill(0), wholesaleByWeek = Array(WEEKS).fill(0), commissionByWeek = Array(WEEKS).fill(0);
  retailPaid.forEach((o) => { const i = WEEKS - 1 - Math.min(WEEKS - 1, weekIndex(o.createdAt)); retailByWeek[i] += o.total; });
  paidSubs.forEach(({ o, s }) => {
    const i = WEEKS - 1 - Math.min(WEEKS - 1, weekIndex(o.createdAt));
    wholesaleByWeek[i] += s.total;
    if (s.supplierId !== KOLBE.id) commissionByWeek[i] += Math.round(s.total * (ops.commissions[s.supplierId] ?? 8) / 100);
  });
  const retailGmv = retailPaid.reduce((a, o) => a + o.total, 0);
  const wholesaleGmv = paidSubs.reduce((a, x) => a + x.s.total, 0);
  const kolbeOwn = paidSubs.filter((x) => x.s.supplierId === KOLBE.id).reduce((a, x) => a + x.s.total, 0);
  const commission = commissionByWeek.reduce((a, b) => a + b, 0);
  const awaiting = orders.flatMap((o) => o.subOrders).filter((s) => s.status === "approved").reduce((a, s) => a + s.total, 0);
  const pendingPayouts = ops.withdrawals.filter((w) => w.status === "requested" || w.status === "approved");
  const bySupplier = Array.from(paidSubs.filter((x) => x.s.supplierId !== KOLBE.id).reduce((m, x) => m.set(x.s.supplierName, (m.get(x.s.supplierName) ?? 0) + x.s.total), new Map<string, number>()).entries()).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  const allSuppliers = [...SUPPLIERS.map((s) => ({ id: s.id, name: s.name })), ...ops.extraSuppliers.map((s) => ({ id: s.id, name: s.name }))];
  const pendingBanks = Object.entries(ops.banks).filter(([, b]) => b.status === "pending");
  const setBank = (id: string, status: "verified" | "rejected", note?: string) => ops.set("banks", { ...ops.banks, [id]: { ...ops.banks[id], status, note } });

  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <Segmented<"overview" | "payouts" | "banks" | "commission"> options={[{ v: "overview", label: "نمای مالی" }, { v: "payouts", label: `تسویه تأمین‌کنندگان (${fmtNum(pendingPayouts.length)})` }, { v: "banks", label: `احراز بانکی (${fmtNum(pendingBanks.length)})` }, { v: "commission", label: "کمیسیون‌ها" }]} value={tab} onChange={setTab} />
      {tab === "overview" && <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <Kpi label="گردش خرده (پرداخت‌شده)" value={fmtMoney(retailGmv)} />
          <Kpi label="گردش عمده (پرداخت‌شده)" value={fmtMoney(wholesaleGmv)} />
          <Kpi label="فروش عمده محصولات کلبه" value={fmtMoney(kolbeOwn)} />
          <Kpi label="درآمد کمیسیون" value={fmtMoney(commission)} hint="از تأمین‌کنندگان" />
          <Kpi label="تأییدشده، منتظر پرداخت" value={fmtMoney(awaiting)} />
        </div>
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Card className="p-5"><p className="text-[15px] font-extrabold">روند گردش مالی</p><p className="mb-3 text-xs text-[var(--kv-muted)]">۸ هفته اخیر · بر اساس تاریخ ثبت سفارش‌های پرداخت‌شده</p>
            <AreaChart labels={weekLabels} series={[{ name: "عمده", color: "#1B2A4A", values: wholesaleByWeek }, { name: "خرده", color: "var(--kv-accent)", values: retailByWeek }]} />
          </Card>
          <Card className="p-5"><p className="mb-4 text-[15px] font-extrabold">سهم کانال‌ها</p>
            <DonutChart center={fmtNum(Math.round((retailGmv + wholesaleGmv) / 1e6))} sub="میلیون تومان" segs={[{ label: "خرده‌فروشی", value: retailGmv, color: "var(--kv-accent)" }, { label: "عمده · کلبه", value: kolbeOwn, color: "#1B2A4A" }, { label: "عمده · تأمین‌کنندگان", value: wholesaleGmv - kolbeOwn, color: "#D6A94E" }]} />
          </Card>
        </div>
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="p-5"><p className="mb-4 text-[15px] font-extrabold">کمیسیون هفتگی کلبه</p><Columns labels={weekLabels.map((l) => l.replace(" هفته قبل", "هـ"))} series={[{ name: "کمیسیون", color: "var(--kv-success)", values: commissionByWeek }]} /></Card>
          <Card className="p-5"><p className="mb-4 text-[15px] font-extrabold">فروش عمده به تفکیک تأمین‌کننده</p>{bySupplier.length ? <BarList items={bySupplier} color="#1B2A4A" /> : <p className="text-[13px] text-[var(--kv-muted)]">فروش پرداخت‌شده‌ای ثبت نشده.</p>}</Card>
        </div>
        <Card className="overflow-hidden"><p className="p-5 pb-3 text-[15px] font-extrabold">وضعیت کیف پول تأمین‌کنندگان</p><div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[680px]"><thead><tr><th>تأمین‌کننده</th><th>فروش تسویه‌شده</th><th>کمیسیون</th><th>در امانت</th><th>قابل برداشت</th></tr></thead><tbody>{allSuppliers.map((s) => <SupplierPayoutRow key={s.id} id={s.id} name={s.name} />)}</tbody></table></div></Card>
      </>}
      {tab === "payouts" && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[860px]">
              <thead><tr><th>شناسه</th><th>تأمین‌کننده</th><th>مبلغ</th><th>شبا</th><th>زمان</th><th>وضعیت</th><th>اقدام</th></tr></thead>
              <tbody>
                {ops.withdrawals.map((w) => <tr key={w.id}>
                  <td className="font-bold tabular-nums">{w.id}</td><td>{w.supplierName}</td><td className="font-bold tabular-nums">{fmtMoney(w.amount)}</td>
                  <td className="tabular-nums text-[var(--kv-muted)]" dir="ltr">{w.iban.slice(0, 8)}…{w.iban.slice(-4)}</td><td className="text-[var(--kv-muted)]">{w.createdAt}</td>
                  <td><Status value={{ requested: "در انتظار", approved: "تأیید شد", paid: "پرداخت شد", rejected: "رد شد" }[w.status]} /></td>
                  <td>
                    {w.status === "requested" && <div className="flex gap-1.5"><Btn size="sm" variant="accent" onClick={() => { ops.upsert("withdrawals", { ...w, status: "approved" }); flash(`${w.id} برای پرداخت تأیید شد`); }}>تأیید</Btn><Btn size="sm" variant="ghost" onClick={() => { ops.upsert("withdrawals", { ...w, status: "rejected", note: "مغایرت اطلاعات بانکی" }); flash(`${w.id} رد شد و مبلغ به کیف پول برگشت`); }}>رد</Btn></div>}
                    {w.status === "approved" && <div className="flex gap-1.5"><input aria-label="شماره پیگیری پایا" value={refs[w.id] ?? ""} onChange={(e) => setRefs({ ...refs, [w.id]: e.target.value })} placeholder="پیگیری پایا" className="h-10 w-28 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 text-[12px] outline-none focus:border-[var(--kv-accent)]" /><Btn size="sm" variant="accent" disabled={!(refs[w.id] ?? "").trim()} onClick={() => { ops.upsert("withdrawals", { ...w, status: "paid", ref: refs[w.id].trim() }); flash(`${w.id} پرداخت‌شده ثبت شد`); }}>ثبت واریز</Btn></div>}
                    {(w.status === "paid" || w.status === "rejected") && <span className="text-[12px] text-[var(--kv-muted)]">{w.ref ?? w.note ?? "—"}</span>}
                  </td>
                </tr>)}
                {ops.withdrawals.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">درخواست برداشتی ثبت نشده.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === "banks" && (
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(ops.banks).map(([id, b]) => (
            <Card key={id} className="p-5">
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]"><Landmark size={18} /></span><div><p className="text-[14px] font-extrabold">{allSuppliers.find((s) => s.id === id)?.name ?? id}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{b.legalName} · {b.updatedAt}</p></div></div><Status value={{ draft: "ثبت نشده", pending: "در انتظار تأیید", verified: "تأیید شد", rejected: "رد شد" }[b.status]} /></div>
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
                <dt className="text-[var(--kv-muted)]">صاحب حساب</dt><dd className="font-semibold">{b.holder}</dd>
                <dt className="text-[var(--kv-muted)]">شبا</dt><dd className="font-semibold tabular-nums" dir="ltr">{b.iban}</dd>
                <dt className="text-[var(--kv-muted)]">بانک</dt><dd>{b.bankName || "—"}</dd>
                <dt className="text-[var(--kv-muted)]">شناسه ملی</dt><dd className="tabular-nums">{b.nationalId}</dd>
              </dl>
              {b.status === "pending" && <div className="mt-4 flex gap-2"><Btn size="sm" variant="accent" icon={<Check size={14} />} onClick={() => { setBank(id, "verified"); flash("اطلاعات بانکی تأیید شد؛ برداشت فعال شد"); }}>تأیید اطلاعات</Btn><Btn size="sm" variant="soft" icon={<X size={14} />} onClick={() => { setBank(id, "rejected", "نام صاحب حساب با اطلاعات حقوقی مطابقت ندارد"); flash("اطلاعات بانکی رد شد"); }}>رد</Btn></div>}
            </Card>
          ))}
          {Object.keys(ops.banks).length === 0 && <Empty title="اطلاعات بانکی ثبت نشده" desc="وقتی تأمین‌کننده اطلاعات مالی را ارسال کند، اینجا برای تأیید نمایش داده می‌شود." />}
        </div>
      )}
      {tab === "commission" && (
        <Card className="max-w-[640px] p-5">
          <p className="mb-1 text-[15px] font-extrabold">نرخ کمیسیون هر تأمین‌کننده</p>
          <p className="mb-4 text-[12px] text-[var(--kv-muted)]">روی فروش‌های تحویل‌شده بعدی اعمال می‌شود و در کیف پول تأمین‌کننده کسر می‌گردد.</p>
          <div className="divide-y divide-[var(--kv-line)]">{allSuppliers.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 py-3"><b className="text-[13px]">{s.name}</b><span className="flex items-center gap-2"><input aria-label={`کمیسیون ${s.name}`} value={String(ops.commissions[s.id] ?? 8)} onChange={(e) => { const v = Math.min(50, Number(faDigits(e.target.value).replace(/\D/g, "")) || 0); ops.set("commissions", { ...ops.commissions, [s.id]: v }); }} className="h-10 w-16 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] text-center text-[13px] font-bold outline-none focus:border-[var(--kv-accent)]" /><span className="text-[var(--kv-muted)]">٪</span></span></div>
          ))}</div>
        </Card>
      )}
    </div>
  );
}

/* ================= Plans with real limits ================= */
function NumOrUnlimited({ label, value, onChange, suffix }: { label: string; value: number | null; onChange: (v: number | null) => void; suffix: string }) {
  return (
    <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
      <div className="flex items-center justify-between gap-2"><p className="text-[13px] font-semibold">{label}</p><label className="flex items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]"><input type="checkbox" checked={value === null} onChange={(e) => onChange(e.target.checked ? null : 1)} className="h-4 w-4 accent-[#C1613B]" />نامحدود</label></div>
      {value !== null && <div className="mt-2 flex items-center gap-2"><input aria-label={label} value={String(value)} onChange={(e) => onChange(Number(faDigits(e.target.value).replace(/\D/g, "")) || 0)} className="h-10 flex-1 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] outline-none focus:border-[var(--kv-accent)]" /><span className="text-[12px] text-[var(--kv-muted)]">{suffix}</span></div>}
    </div>
  );
}

export function PlansCenter({ flash }: { flash: F }) {
  const { plans: localPlans, buyers, upsertPlan, removePlan } = useStore();
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [serverPlans, setServerPlans] = useState<VipPlan[] | null>(null);
  useEffect(() => {
    if (isDemo) return;
    apiCall<{ items: any[] }>("/plans")
      .then((r) => setServerPlans(r.items.map((p: any): VipPlan => ({
        id: p.id, name: p.title ?? p.name ?? "", yearly: Math.round(Number(p.annual_price_rial ?? 0) / 10),
        creditLimit: Math.round(Number(p.limits?.maxOrderValueRial ?? 0) / 10),
        features: p.features ?? [], active: Boolean(p.active),
        limits: {
          showPrices: p.limits?.showPrices !== false, freeShipping: Boolean(p.limits?.freeShipping ?? true),
          prioritySupport: Boolean(p.limits?.prioritySupport), sources: p.limits?.sources === "kolbe" ? "kolbe" : "all",
          maxOrdersPerMonth: p.limits?.maxOrdersPerMonth ?? null, maxOrderValue: Math.round(Number(p.limits?.maxOrderValueRial ?? 0) / 10),
          maxSuppliersPerOrder: p.limits?.maxSuppliersPerOrder ?? null, discountPercent: Number(p.limits?.discountPercent ?? 0),
          creditDays: p.limits?.creditDays ?? 0,
        },
      }))))
      .catch((e) => flash(e instanceof Error ? e.message : "خطا در دریافت پلن‌ها از سرور"));
  }, [isDemo, flash]);
  const plans = serverPlans ?? localPlans;
  const [edit, setEdit] = useState<VipPlan | null>(null);
  const savePlan = async (plan: VipPlan, isNew: boolean) => {
    if (isDemo) {
      if (isNew) upsertPlan({ ...plan, id: plan.id || `plan-${Date.now()}` });
      else upsertPlan(plan);
      return true;
    }
    const body = {
      title: plan.name, description: "",
      annualPriceRial: String(plan.yearly * 10),
      limits: {
        sources: plan.limits?.sources ?? "all", discountPercent: plan.limits?.discountPercent ?? 0,
        maxOrdersPerMonth: plan.limits?.maxOrdersPerMonth ?? null, maxOrderValueRial: null, minOrderValueRial: null,
        maxSuppliersPerOrder: plan.limits?.maxSuppliersPerOrder ?? null, maxQuantityPerLine: null,
        prioritySupport: Boolean(plan.limits?.prioritySupport), installmentAccess: false,
        showPrices: plan.limits?.showPrices !== false, freeShipping: plan.limits?.freeShipping !== false,
      },
      features: (plan.features ?? []).filter((f) => /^[a-z0-9_-]{2,40}$/.test(f)), permissions: [],
    };
    try {
      if (isNew) await apiCall("/plans", { method: "POST", body: JSON.stringify({ ...body, code: `plan_${Date.now().toString(36)}` }) });
      else await apiCall(`/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify(body) });
      const refreshed = await apiCall<{ items: any[] }>("/plans");
      setServerPlans((prev) => prev ? prev.map((x) => {
        const hit = refreshed.items.find((i: any) => i.id === x.id);
        return hit ? { ...x, name: hit.title ?? x.name, active: Boolean(hit.active), yearly: Math.round(Number(hit.annual_price_rial ?? 0) / 10) } : x;
      }) : prev);
      return true;
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره پلن"); return false; }
  };
  const L = edit ? limitsOf(edit) : DEFAULT_LIMITS;
  const setL = (p: Partial<PlanLimits>) => edit && setEdit({ ...edit, limits: { ...limitsOf(edit), ...p } });
  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-[13px] leading-6 text-[var(--kv-muted)]">محدودیت‌های هر پلن در بازارچه عمده اجرا می‌شوند: نمایش قیمت، دسترسی به تأمین‌کنندگان، سقف سفارش ماهانه و مبلغ، تعداد تأمین‌کننده در سفارش، تخفیف خودکار و ارسال رایگان.</p>
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => setEdit(isDemo ? { id: `plan-${Date.now()}`, name: "", yearly: 0, creditLimit: 0, features: [], active: true, limits: { ...DEFAULT_LIMITS } } : { id: "", name: "", yearly: 0, creditLimit: 0, features: [], active: true, limits: { ...DEFAULT_LIMITS } })}>پلن جدید</Btn>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((p) => (
          <Card key={p.id} className={cn("flex flex-col p-5", !p.active && "opacity-60")}>
            <div className="flex items-center justify-between"><p className="flex items-center gap-2 text-[16px] font-extrabold"><Crown size={16} className="text-[var(--kv-accent)]" />{p.name}</p><Switch on={p.active} onToggle={async () => { if (await savePlan({ ...p, active: !p.active }, false)) flash(`پلن ${p.name} ${p.active ? "غیرفعال" : "فعال"} شد`); }} /></div>
            <p className="mt-2 text-[18px] font-extrabold tabular-nums">{p.yearly === 0 ? "رایگان" : fmtMoney(p.yearly)}{p.yearly > 0 && <span className="text-[11px] font-medium text-[var(--kv-muted)]"> / سال</span>}</p>
            <p className="text-xs text-[var(--kv-muted)]">{fmtNum(buyers.filter((b) => b.planId === p.id).length)} عضو{serverPlans ? " · سرور" : ""}</p>
            <ul className="mt-3 flex-1 space-y-1.5 text-[12.5px]">{describeLimits(p).map((f) => <li key={f} className="flex items-start gap-1.5"><Check size={13} className="mt-1 shrink-0 text-[var(--kv-success)]" />{f}</li>)}{p.features.map((f) => <li key={f} className="flex items-start gap-1.5 text-[var(--kv-muted)]"><Check size={13} className="mt-1 shrink-0" />{f}</li>)}</ul>
            <div className="mt-4 flex gap-2"><Btn variant="soft" size="sm" icon={<Pencil size={13} />} onClick={() => setEdit({ ...p, limits: limitsOf(p) })}>ویرایش محدودیت‌ها</Btn><Btn variant="ghost" size="sm" icon={<Trash2 size={13} />} disabled={buyers.some((b) => b.planId === p.id)} onClick={async () => { if (isDemo) { removePlan(p.id); flash("پلن حذف شد (demo)"); return; } try { await apiCall(`/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: false }) }); setServerPlans((prev) => prev ? prev.map((x) => x.id === p.id ? { ...x, active: false } : x) : prev); flash("پلن غیرفعال شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } }}>حذف</Btn></div>
          </Card>
        ))}
      </div>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit?.name ? `پلن ${edit.name}` : "پلن جدید"} wide>
        {edit && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="نام پلن"><Input value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} /></Field>
              <Field label="هزینه سالانه (تومان)"><Input value={String(edit.yearly)} onChange={(v) => setEdit({ ...edit, yearly: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>
              <Field label="سقف اعتبار (تومان)"><Input value={String(edit.creditLimit)} onChange={(v) => setEdit({ ...edit, creditLimit: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>
            </div>
            <p className="pt-1 text-[13.5px] font-extrabold">دسترسی‌ها</p>
            <div className="divide-y divide-[var(--kv-line)] rounded-[12px] border border-[var(--kv-line)] px-4">
              {([["showPrices", "نمایش قیمت سری‌ها", "بدون آن، خریدار فقط محصولات را می‌بیند"], ["freeShipping", "ارسال رایگان باربری", "هزینه ارسال سفارش عمده صفر می‌شود"], ["prioritySupport", "پشتیبانی با اولویت", "تیکت‌ها با برچسب فوری وارد صف می‌شوند"]] as const).map(([k, t, d]) => (
                <div key={k} className="flex items-center justify-between gap-3 py-3"><div><p className="text-[13px] font-semibold">{t}</p><p className="text-[11.5px] text-[var(--kv-muted)]">{d}</p></div><Switch on={L[k]} onToggle={() => setL({ [k]: !L[k] } as Partial<PlanLimits>)} /></div>
              ))}
              <div className="flex items-center justify-between gap-3 py-3"><div><p className="text-[13px] font-semibold">منابع قابل خرید</p><p className="text-[11.5px] text-[var(--kv-muted)]">محصولات سایر تأمین‌کنندگان برای این پلن قفل می‌شود</p></div><Select className="w-48" options={["همه تأمین‌کنندگان", "فقط کلبه وینتیج"]} value={L.sources === "all" ? "همه تأمین‌کنندگان" : "فقط کلبه وینتیج"} onChange={(v) => setL({ sources: v === "همه تأمین‌کنندگان" ? "all" : "kolbe" })} /></div>
            </div>
            <p className="pt-1 text-[13.5px] font-extrabold">سقف‌ها و مزایای مالی</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumOrUnlimited label="سفارش در ماه" value={L.maxOrdersPerMonth} onChange={(v) => setL({ maxOrdersPerMonth: v })} suffix="سفارش" />
              <NumOrUnlimited label="سقف مبلغ هر سفارش" value={L.maxOrderValue} onChange={(v) => setL({ maxOrderValue: v })} suffix="تومان" />
              <NumOrUnlimited label="تأمین‌کننده در هر سفارش" value={L.maxSuppliersPerOrder} onChange={(v) => setL({ maxSuppliersPerOrder: v })} suffix="تأمین‌کننده" />
              <div className="grid grid-cols-2 gap-3">
                <Field label="تخفیف خودکار (٪)"><Input value={String(L.discountPercent)} onChange={(v) => setL({ discountPercent: Math.min(50, Number(faDigits(v).replace(/\D/g, "")) || 0) })} /></Field>
                <Field label="مهلت اعتبار (روز)"><Input value={String(L.creditDays)} onChange={(v) => setL({ creditDays: Number(faDigits(v).replace(/\D/g, "")) || 0 })} /></Field>
              </div>
            </div>
            <Field label="مزایای غیرسیستمی (اختیاری)" hint="هر خط یک مورد؛ فقط نمایشی است، مثل «کارشناس اختصاصی»"><Textarea rows={2} value={edit.features.join("\n")} onChange={(v) => setEdit({ ...edit, features: v.split("\n").map((x) => x.trim()).filter(Boolean) })} /></Field>
            <Checkbox checked={!!edit.recommended} onChange={(v) => setEdit({ ...edit, recommended: v })} label="نمایش به‌عنوان پیشنهاد کلبه" />
            <div className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3"><p className="mb-1.5 text-[12px] font-bold">پیش‌نمایش برای خریدار</p><ul className="space-y-1 text-[12px]">{describeLimits({ ...edit }).map((f) => <li key={f}>• {f}</li>)}</ul></div>
            <Btn variant="accent" className="w-full" disabled={!edit.name.trim()} onClick={async () => { const isNew = !edit.id; if (isDemo && isNew) { upsertPlan({ ...edit, id: `plan-${Date.now()}` }); setEdit(null); flash(`پلن ${edit.name} ذخیره شد (demo)`); return; } if (await savePlan(edit, isNew)) { setEdit(null); flash(`پلن ${edit.name} ذخیره شد و محدودیت‌ها فوراً اعمال می‌شوند`); } }}>ذخیره پلن</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}

/* ================= Restrictions ================= */
const FLAG_META: { k: keyof RestrictionFlags; label: string; for: ("supplier" | "customer")[] }[] = [
  { k: "block", label: "مسدودسازی کامل حساب", for: ["supplier", "customer"] },
  { k: "noOrder", label: "ممنوعیت ثبت سفارش خرده", for: ["customer"] },
  { k: "noWholesale", label: "ممنوعیت خرید عمده", for: ["customer"] },
  { k: "noReturn", label: "ممنوعیت درخواست مرجوعی", for: ["customer"] },
  { k: "noPublish", label: "ممنوعیت انتشار و ویرایش محصول", for: ["supplier"] },
  { k: "noWithdraw", label: "توقف برداشت از کیف پول", for: ["supplier"] },
];

const SCOPE_LABEL: Record<string, string> = { purchase: "خرید (خرده و عمده)", ticket: "ثبت تیکت", return: "درخواست مرجوعی", withdrawal: "برداشت از کیف پول", all: "همه عملیات (مسدود کامل)" };

export function RestrictionsCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const { accounts } = useStore();
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [serverRows, setServerRows] = useState<any[] | null>(null);
  const [serverUsers, setServerUsers] = useState<{ id: string; name: string }[] | null>(null);
  const load = () => {
    if (isDemo) return;
    apiCall<{ items: any[] }>("/admin/restrictions").then((r) => setServerRows(r.items)).catch(() => setServerRows([]));
    apiCall<{ items: any[] }>("/admin/users").then((r) => setServerUsers((r.items ?? []).map((u: any) => ({ id: u.id, name: `${u.displayName ?? u.display_name ?? u.phone ?? u.id}` })))).catch(() => setServerUsers([]));
  };
  useEffect(load, [isDemo]);
  const suppliers = [...SUPPLIERS.map((s) => ({ id: s.id, name: s.name })), ...ops.extraSuppliers];
  const [type, setType] = useState<"supplier" | "customer">("supplier");
  const subjects = serverUsers && serverUsers.length
    ? serverUsers
    : type === "supplier" ? suppliers : accounts.map((a) => ({ id: a.id, name: `${a.name} · ${a.phone}` }));
  const [subject, setSubject] = useState("");
  const [flags, setFlags] = useState<RestrictionFlags>({ ...NO_FLAGS });
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const chosen = subjects.find((s) => s.id === subject) ?? subjects[0];
  const any = Object.values(flags).some(Boolean);
  const add = async () => {
    if (!chosen || !any || reason.trim().length < 4) return;
    if (!isDemo) {
      // Server scopes: block→all, noOrder/noWholesale→purchase, noReturn→return, noWithdraw→withdrawal, noPublish→(not a server scope)
      const scopes: string[] = [];
      if (flags.block) scopes.push("all");
      if (flags.noOrder) scopes.push("purchase");
      if (flags.noWholesale && !scopes.includes("purchase")) scopes.push("purchase");
      if (flags.noReturn) scopes.push("return");
      if (flags.noWithdraw) scopes.push("withdrawal");
      if (flags.noPublish) flash("محدودیت انتشار محصول در دامنه سرور پشتیبانی نمی‌شود؛ سایر موارد اعمال شد.");
      try {
        for (const scope of scopes) {
          await apiCall("/admin/restrictions", { method: "POST", body: JSON.stringify({ userId: chosen.id, scope, reason: reason.trim() }) });
        }
        load();
        setFlags({ ...NO_FLAGS }); setReason(""); setUntil("");
        flash(`محدودیت برای ${chosen.name} روی سرور اعمال شد`);
      } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت محدودیت"); }
      return;
    }
    const r: Restriction = { id: `RS-${Date.now().toString().slice(-5)}`, subjectType: type, subjectId: chosen.id, subjectName: chosen.name, flags, reason: reason.trim(), until: until || undefined, createdAt: opsNow() };
    ops.upsert("restrictions", r, true);
    setFlags({ ...NO_FLAGS }); setReason(""); setUntil("");
    flash(`محدودیت برای ${chosen.name} اعمال شد (demo)`);
  };
  const serverList = (serverRows ?? []).map((r) => ({ id: r.id, name: r.userName ?? r.userId, scope: r.scope, reason: r.reason, status: r.status, createdAt: String(r.createdAt ?? "").slice(0, 10) }));
  return (
    <div className="grid gap-5 animate-[fadeUp_0.35s_ease] xl:grid-cols-[400px_minmax(0,1fr)]">
      <Card className="h-fit p-5">
        <p className="mb-4 flex items-center gap-2 text-[15px] font-extrabold"><ShieldAlert size={17} className="text-[var(--kv-danger)]" />اعمال محدودیت</p>
        <div className="space-y-4">
          <Segmented<"supplier" | "customer"> options={[{ v: "supplier", label: "تأمین‌کننده" }, { v: "customer", label: "کاربر / خریدار" }]} value={type} onChange={(v) => { setType(v); setSubject(""); setFlags({ ...NO_FLAGS }); }} />
          <Field label="حساب"><Select options={subjects.map((s) => s.name)} value={chosen?.name} onChange={(v) => setSubject(subjects.find((s) => s.name === v)?.id ?? "")} /></Field>
          <div className="space-y-2">{FLAG_META.filter((m) => m.for.includes(type)).map((m) => <Checkbox key={m.k} checked={flags[m.k]} onChange={(v) => setFlags({ ...flags, [m.k]: v })} label={m.label} />)}</div>
          <Field label="دلیل (به کاربر نمایش داده می‌شود)"><Textarea rows={2} value={reason} onChange={setReason} /></Field>
          <Field label="تا تاریخ (اختیاری)" hint="خالی = تا رفع دستی"><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[13px] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /></Field>
          <Btn variant="accent" className="w-full" disabled={!any || reason.trim().length < 4} onClick={add} icon={<Ban size={15} />}>اعمال محدودیت</Btn>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <p className="p-5 pb-3 text-[15px] font-extrabold">محدودیت‌های فعال {!isDemo && <span className="text-[11px] font-medium text-[var(--kv-muted)]">(سرور · اجرا در بک‌اند)</span>}</p>
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[720px]">
            <thead><tr><th>حساب</th><th>نوع</th><th>محدودیت‌ها</th><th>دلیل</th><th>انقضا</th><th></th></tr></thead>
            <tbody>
              {!isDemo && serverList.map((r) => <tr key={r.id}>
                <td><b>{r.name}</b><p className="text-[11px] text-[var(--kv-muted)]">{r.createdAt}</p></td><td>کاربر</td>
                <td><span className="rounded-full bg-[var(--kv-danger)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--kv-danger)]">{SCOPE_LABEL[r.scope] ?? r.scope}</span></td>
                <td className="max-w-[200px] text-[12px]">{r.reason}</td><td className="text-[var(--kv-muted)]">{r.status === "active" ? "فعال" : "رفع‌شده"}</td>
                <td><Btn size="sm" variant="ghost" onClick={async () => { try { await apiCall(`/admin/restrictions/${r.id}`, { method: "PATCH", body: JSON.stringify({ status: "lifted" }) }); load(); flash(`محدودیت ${r.name} برداشته شد`); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } }}>رفع</Btn></td>
              </tr>)}
              {isDemo && ops.restrictions.map((r) => <tr key={r.id}>
                <td><b>{r.subjectName}</b><p className="text-[11px] text-[var(--kv-muted)]">{r.createdAt}</p></td><td>{r.subjectType === "supplier" ? "تأمین‌کننده" : "کاربر"}</td>
                <td><div className="flex flex-wrap gap-1">{FLAG_META.filter((m) => r.flags[m.k]).map((m) => <span key={m.k} className="rounded-full bg-[var(--kv-danger)]/10 px-2 py-0.5 text-[11px] font-semibold text-[var(--kv-danger)]">{m.label}</span>)}</div></td>
                <td className="max-w-[200px] text-[12px]">{r.reason}</td><td className="text-[var(--kv-muted)]">{r.until ?? "دستی"}</td>
                <td><Btn size="sm" variant="ghost" onClick={() => { ops.remove("restrictions", r.id); flash(`محدودیت ${r.subjectName} برداشته شد (demo)`); }}>رفع</Btn></td>
              </tr>)}
              {((isDemo && ops.restrictions.length === 0) || (!isDemo && serverList.filter((r) => r.status === "active").length === 0)) && <tr><td colSpan={6} className="py-8 text-center text-[var(--kv-muted)]">محدودیت فعالی وجود ندارد.</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ================= Supplier applications + form builder ================= */
const TYPE_LABEL: Record<FieldType, string> = { text: "متن کوتاه", textarea: "متن بلند", number: "عدد", phone: "شماره همراه", email: "ایمیل", select: "انتخاب از فهرست", checkbox: "تیک تأیید", file: "بارگذاری فایل" };
const APP_STATUS: Record<Application["status"], string> = { new: "جدید", reviewing: "در حال بررسی", approved: "تأیید شد", rejected: "رد شد" };

export function ApplicationsCenter({ flash }: { flash: F }) {
  const ops = useOps();
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const [serverApps, setServerApps] = useState<any[] | null>(null);
  const [serverFields, setServerFields] = useState<FormField[] | null>(null);
  const load = () => {
    if (isDemo) return;
    apiCall<{ items: any[] }>("/admin/cooperation-requests").then((r) => setServerApps(r.items)).catch(() => setServerApps([]));
    apiCall<{ items: any[] }>("/cooperation-form").then((r) => setServerFields((r.items ?? []).map((f: any, i: number) => ({ id: f.code ?? `f-${i}`, label: f.label, type: f.fieldType ?? f.field_type ?? "text", required: Boolean(f.required), options: f.options ?? [] })))).catch(() => setServerFields([]));
  };
  useEffect(load, [isDemo]);
  const [tab, setTab] = useState<"inbox" | "builder">("inbox");
  const applications: Application[] = !isDemo && serverApps
    ? serverApps.map((a): Application => ({ id: a.id, name: a.brand_name ?? a.brandName ?? a.payload?.brand_name ?? "—", status: (a.status === "new" ? "new" : a.status === "reviewing" ? "reviewing" : a.status === "approved" ? "approved" : "rejected") as Application["status"], createdAt: String(a.created_at ?? "").slice(0, 10), values: a.payload ?? {}, note: a.review_note }))
    : ops.applications;
  const [sel, setSel] = useState<string | null>(applications[0]?.id ?? null);
  const [note, setNote] = useState("");
  const form = serverFields ? { title: "فرم همکاری کلبه", intro: "", active: true, fields: serverFields } : ops.applicationForm;
  const cur = applications.find((a) => a.id === sel);
  const setForm = (p: Partial<typeof form>) => {
    if (serverFields) { setServerFields(p.fields ?? serverFields); return; }
    ops.set("applicationForm", { ...form, ...p } as any);
  };
  const setField = (id: string, p: Partial<FormField>) => setForm({ fields: form.fields.map((f) => (f.id === id ? { ...f, ...p } : f)) });
  const move = (i: number, d: -1 | 1) => { const next = [...form.fields]; const j = i + d; if (j < 0 || j >= next.length) return; [next[i], next[j]] = [next[j], next[i]]; setForm({ fields: next }); };
  const saveForm = async () => {
    if (!serverFields) { flash("فرم ذخیره شد (demo)"); return; }
    try {
      await apiCall("/admin/cooperation-form", { method: "PUT", body: JSON.stringify({ fields: (serverFields ?? []).map((f, i) => ({ code: f.id, label: f.label, fieldType: f.type, required: !!f.required, options: f.options ?? [], active: true, position: i + 1 })) }) });
      flash("فرم همکاری روی سرور ذخیره شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره فرم"); }
  };
  const decide = async (a: Application, status: Application["status"]) => {
    if (!isDemo && serverApps) {
      try {
        await apiCall(`/admin/cooperation-requests/${a.id}/review`, { method: "POST", body: JSON.stringify({ status, note: note.trim() || undefined }) });
        load(); setNote("");
        flash(status === "approved" ? `${a.name} تأیید شد و حساب تأمین‌کننده ساخته شد` : status === "rejected" ? `درخواست ${a.name} رد شد` : "در حال بررسی");
      } catch (e) { flash(e instanceof Error ? e.message : "خطا در بررسی درخواست"); }
      return;
    }
    ops.upsert("applications", { ...a, status, note: note.trim() || a.note });
    if (status === "approved" && !ops.extraSuppliers.some((s) => s.id === `sx-${a.id}`)) ops.upsert("extraSuppliers", { id: `sx-${a.id}`, name: a.name, city: a.values["f-city"] ?? "—", since: new Date().toLocaleDateString("fa-IR") });
    setNote("");
    flash(status === "approved" ? `${a.name} تأیید شد و به فهرست تأمین‌کنندگان اضافه شد (demo)` : status === "rejected" ? `درخواست ${a.name} رد شد (demo)` : "در حال بررسی (demo)");
  };
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <Segmented<"inbox" | "builder"> options={[{ v: "inbox", label: `درخواست‌ها (${fmtNum(applications.filter((a) => a.status === "new").length)} جدید)` }, { v: "builder", label: "طراحی فرم همکاری" }]} value={tab} onChange={setTab} />
      {tab === "inbox" ? (
        <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-2">
            {applications.length === 0 && <Empty title="درخواستی نرسیده" desc="درخواست‌های فرم همکاری اینجا نمایش داده می‌شوند." />}
            {applications.map((a) => <button key={a.id} onClick={() => setSel(a.id)} className={cn("w-full rounded-[12px] border p-3 text-right", sel === a.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05]" : "border-[var(--kv-line)] bg-[var(--kv-surface)]")}><div className="flex items-center justify-between gap-2"><b className="text-[13px]">{a.name}</b><Status value={APP_STATUS[a.status]} /></div><p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{a.id} · {a.createdAt} · {a.values["f-city"] ?? ""}</p></button>)}
          </div>
          <Card className="p-5">
            {!cur ? <Empty title="درخواستی انتخاب نشده" desc="یک درخواست را باز کنید." /> : (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--kv-line)] pb-3"><div><p className="text-[16px] font-extrabold">{cur.name}</p><p className="text-[12px] text-[var(--kv-muted)]">{cur.id} · ارسال {cur.createdAt}</p></div><Status value={APP_STATUS[cur.status]} /></div>
                <dl className="mt-4 grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  {form.fields.map((f) => <div key={f.id}><dt className="text-[11.5px] text-[var(--kv-muted)]">{f.label}</dt><dd className="mt-0.5 text-[13px] font-semibold">{cur.values[f.id] || "—"}</dd></div>)}
                </dl>
                {cur.note && <p className="mt-4 rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[12px]">یادداشت: {cur.note}</p>}
                {cur.status !== "approved" && cur.status !== "rejected" && <div className="mt-5 space-y-3 border-t border-[var(--kv-line)] pt-4">
                  <Field label="یادداشت داخلی / پیام به متقاضی"><Textarea rows={2} value={note} onChange={setNote} /></Field>
                  <div className="flex flex-wrap gap-2"><Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => decide(cur, "approved")}>تأیید و ساخت حساب تأمین‌کننده</Btn>{cur.status === "new" && <Btn variant="soft" size="sm" icon={<Eye size={14} />} onClick={() => decide(cur, "reviewing")}>در حال بررسی</Btn>}<Btn variant="ghost" size="sm" icon={<X size={14} />} onClick={() => decide(cur, "rejected")}>رد</Btn></div>
                </div>}
              </div>
            )}
          </Card>
        </div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3"><p className="text-[15px] font-extrabold">فیلدهای فرم</p><span className="flex items-center gap-2 text-[12.5px]">فرم فعال<Switch on={form.active} onToggle={() => setForm({ active: !form.active })} /></span></div>
            <div className="mb-4 grid gap-3"><Field label="عنوان فرم"><Input value={form.title} onChange={(v) => setForm({ title: v })} /></Field><Field label="متن معرفی"><Textarea rows={2} value={form.intro} onChange={(v) => setForm({ intro: v })} /></Field></div>
            <div className="space-y-2">
              {form.fields.map((f, i) => (
                <div key={f.id} className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <div className="grid gap-2 sm:grid-cols-[1fr_160px_auto]">
                    <Input value={f.label} onChange={(v) => setField(f.id, { label: v })} placeholder="برچسب فیلد" />
                    <Select options={Object.values(TYPE_LABEL)} value={TYPE_LABEL[f.type]} onChange={(v) => setField(f.id, { type: (Object.keys(TYPE_LABEL) as FieldType[]).find((k) => TYPE_LABEL[k] === v) ?? "text" })} />
                    <div className="flex items-center gap-1">
                      <button aria-label="بالا" onClick={() => move(i, -1)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><ArrowUp size={15} /></button>
                      <button aria-label="پایین" onClick={() => move(i, 1)} className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)]"><ArrowDown size={15} /></button>
                      <button aria-label="حذف فیلد" onClick={() => setForm({ fields: form.fields.filter((x) => x.id !== f.id) })} className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--kv-danger)] hover:bg-[var(--kv-surface-2)]"><Trash2 size={15} /></button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4">
                    <Checkbox checked={f.required} onChange={(v) => setField(f.id, { required: v })} label="الزامی" />
                    {f.type === "select" && <input aria-label="گزینه‌ها" value={(f.options ?? []).join("، ")} onChange={(e) => setField(f.id, { options: e.target.value.split(/[،,]/).map((x) => x.trim()).filter(Boolean) })} placeholder="گزینه‌ها با ویرگول" className="h-10 min-w-[220px] flex-1 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12px] outline-none focus:border-[var(--kv-accent)]" />}
                  </div>
                </div>
              ))}
            </div>
            {serverFields && <Btn variant="accent" size="sm" className="mt-3 ml-2" onClick={saveForm} icon={<Check size={14} />}>ذخیره فرم روی سرور</Btn>}
            <Btn variant="soft" size="sm" className="mt-3" icon={<Plus size={14} />} onClick={() => { if (!serverFields && !isDemo) { flash("افزودن فیلد باید از API فرم باشد"); return; } setForm({ fields: [...form.fields, { id: serverFields ? `field_${Date.now().toString(36)}` : `f-${Date.now()}`, label: "فیلد جدید", type: "text", required: false }] }); }}>افزودن فیلد</Btn>
          </Card>
          <Card className="h-fit p-5">
            <p className="text-[13px] font-bold text-[var(--kv-muted)]">پیش‌نمایش فرم در مرکز تأمین‌کنندگان</p>
            <p className="mt-3 text-[15px] font-extrabold">{form.title}</p><p className="mt-1 text-[12px] leading-6 text-[var(--kv-muted)]">{form.intro}</p>
            <div className="mt-3 space-y-2">{form.fields.map((f) => <div key={f.id} className="rounded-[10px] border border-dashed border-[var(--kv-line-strong)] px-3 py-2 text-[12px]"><b>{f.label}</b>{f.required && <span className="text-[var(--kv-danger)]"> *</span>}<span className="mr-2 text-[var(--kv-muted)]">{TYPE_LABEL[f.type]}</span></div>)}</div>
            {!form.active && <p className="mt-3 text-[12px] text-[var(--kv-danger)]">فرم غیرفعال است و به متقاضیان نمایش داده نمی‌شود.</p>}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ================= Support hub ================= */
export function SupportHub() {
  const store = useStore();
  const [tab, setTab] = useState<"tickets" | "returns">("tickets");
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <Segmented<"tickets" | "returns"> options={[{ v: "tickets", label: "تیکت‌ها" }, { v: "returns", label: "مرجوعی‌ها" }]} value={tab} onChange={setTab} />
      {tab === "tickets" ? <TicketBoardPanel /> : <ReturnsCenter onSync={(r) => {
        if (typeof window !== "undefined" && !new URLSearchParams(window.location.search).has("demo")) return; // server mode: returns are canonical on the server
        if (r.channel !== "retail") return;
        if (r.status === "approved" || r.status === "refunded") store.setReturnStatus(r.orderId, "تأیید شد");
        if (r.status === "rejected") store.setReturnStatus(r.orderId, "رد شد");
      }} />}
    </div>
  );
}
