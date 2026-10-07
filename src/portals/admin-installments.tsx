import { useEffect, useState } from "react";
import { CreditCard, Plus } from "lucide-react";
import { studioApi, rialToToman, type InstallmentProviderAdmin } from "../data/experience-api";
import { fmtMoney } from "../data/catalog";
import { Btn, Card, ErrorState, Field, Input, LoadingState, Select, Status, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";

/* Installment Provider domain admin (Req 189-192): SnappPay, DigiPay and any future provider are data,
   not code. Counts, fees, limits, badge and terms drive every installment card / product card, and the
   storefront always receives server-computed offers. */

type F = (m: string) => void;
type Form = { code: string; title: string; installmentsCount: string; minOrderRial: string; maxOrderRial: string; feePercent: string; badgeText: string; terms: string; brandColor: string; logoUrl: string; position: string; active: boolean; integrationCode: string };
const fa = (n: number) => n.toLocaleString("fa-IR");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "خطا");
const empty: Form = { code: "", title: "", installmentsCount: "4", minOrderRial: "0", maxOrderRial: "", feePercent: "0", badgeText: "", terms: "", brandColor: "#1B2A4A", logoUrl: "", position: "10", active: false, integrationCode: "" };
const toForm = (p: InstallmentProviderAdmin): Form => ({ code: p.code, title: p.title, installmentsCount: String(p.installments_count), minOrderRial: p.min_order_rial, maxOrderRial: p.max_order_rial ?? "", feePercent: String(Number(p.fee_percent)),
  badgeText: p.badge_text, terms: p.terms, brandColor: p.brand_color, logoUrl: p.logo_url ?? "", position: String(p.position), active: p.active, integrationCode: p.integration_code ?? "" });

/** Admin-only estimate so the editor sees the effect of a change before saving; the storefront uses the server figure. */
function estimate(priceRial: bigint, f: Form) {
  const count = Number(f.installmentsCount) || 0;
  if (count < 2) return null;
  if (priceRial < BigInt(f.minOrderRial || "0")) return { reason: "کمتر از حداقل مبلغ" } as const;
  if (f.maxOrderRial && priceRial > BigInt(f.maxOrderRial)) return { reason: "بیشتر از سقف مبلغ" } as const;
  const feeBp = BigInt(Math.round((Number(f.feePercent) || 0) * 100));
  const total = (priceRial * (10000n + feeBp) + 9999n) / 10000n;
  const per = (total + BigInt(count) - 1n) / BigInt(count);
  return { total, per, count } as const;
}

export function InstallmentsPanel({ flash }: { flash: F }) {
  const [data, setData] = useState<{ items: InstallmentProviderAdmin[]; integrations: { code: string; title: string; enabled: boolean; status: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [samplePrice, setSamplePrice] = useState("25000000");
  const [busy, setBusy] = useState(false);
  const load = async () => { setError(null); try { setData(await studioApi.installmentProviders()); } catch (e) { setError(errMsg(e)); } };
  useEffect(() => { void load(); }, []);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState />;
  const save = async () => {
    if (!form) return;
    if (!/^[a-z0-9-]{2,30}$/.test(form.code)) { flash("کد باید انگلیسی کوچک، عدد یا خط تیره باشد."); return; }
    setBusy(true);
    try {
      await studioApi.saveInstallmentProvider(form.code, {
        title: form.title.trim(), installmentsCount: Number(form.installmentsCount), minOrderRial: form.minOrderRial || "0", maxOrderRial: form.maxOrderRial || null,
        feePercent: Number(form.feePercent) || 0, badgeText: form.badgeText.trim(), terms: form.terms.trim(), brandColor: form.brandColor, logoUrl: form.logoUrl.trim() || null,
        position: Number(form.position) || 0, active: form.active, integrationCode: form.integrationCode || null,
      });
      flash("سرویس اقساطی ذخیره شد؛ کارت‌ها و محصولات با محاسبه جدید سرور نمایش داده می‌شوند.");
      setForm(null); await load();
    } catch (e) { flash(errMsg(e)); } finally { setBusy(false); }
  };
  const price = (() => { try { return BigInt(samplePrice.replace(/\D/g, "") || "0"); } catch { return 0n; } })();
  return (
    <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]" data-testid="installments-panel">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--kv-line)] p-4">
          <p className="flex items-center gap-2 text-[14px] font-extrabold"><CreditCard size={16} />سرویس‌های اقساطی</p>
          <Btn size="sm" variant="soft" icon={<Plus size={13} />} onClick={() => { setIsNew(true); setForm({ ...empty }); }}>سرویس جدید</Btn>
        </div>
        <ul className="divide-y divide-[var(--kv-line)]">
          {data.items.map((p) => (
            <li key={p.code} className="flex flex-wrap items-center gap-3 p-4">
              <span className="h-9 w-9 shrink-0 rounded-[10px]" style={{ background: p.brand_color }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-bold">{p.title} <span className="font-normal text-[var(--kv-muted)]" dir="ltr">· {p.code}</span></p>
                <p className="text-[11.5px] text-[var(--kv-muted)]">{fa(p.installments_count)} قسط · کارمزد {fa(Number(p.fee_percent))}٪ · از {fmtMoney(rialToToman(p.min_order_rial))}{p.max_order_rial ? ` تا ${fmtMoney(rialToToman(p.max_order_rial))}` : ""}</p>
              </div>
              <Status value={p.active ? "فعال" : "غیرفعال"} />
              <Btn size="sm" variant="soft" onClick={() => { setIsNew(false); setForm(toForm(p)); }}>ویرایش</Btn>
            </li>
          ))}
        </ul>
        <div className="border-t border-[var(--kv-line)] p-4">
          <Field label="قیمت نمونه برای پیش‌نمایش (ریال)"><Input value={samplePrice} onChange={(v) => setSamplePrice(v.replace(/\D/g, ""))} /></Field>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {data.items.filter((p) => p.active).map((p) => { const est = estimate(price, toForm(p)); return (
              <div key={p.code} className="rounded-[12px] border p-3 text-[12px]" style={{ borderColor: `${p.brand_color}55` }}>
                <b>{p.title}</b>
                {!est ? null : "reason" in est ? <p className="mt-1 text-[var(--kv-muted)]">نمایش داده نمی‌شود — {est.reason}</p>
                  : <p className="mt-1 tabular-nums">{fa(est.count)} × {fmtMoney(rialToToman(est.per.toString()))} <span className="text-[var(--kv-muted)]">(مجموع {fmtMoney(rialToToman(est.total.toString()))})</span></p>}
              </div>
            ); })}
          </div>
        </div>
      </Card>

      {form ? (
        <Card className="space-y-3 p-4" data-testid="installment-form">
          <p className="text-[14px] font-extrabold">{isNew ? "سرویس اقساطی جدید" : `ویرایش «${form.title}»`}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="کد (انگلیسی)"><Input value={form.code} onChange={(v) => isNew && setForm({ ...form, code: v.toLowerCase().replace(/[^a-z0-9-]/g, "") })} /></Field>
            <Field label="عنوان نمایشی"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field>
            <Field label="تعداد اقساط"><Select options={["2", "3", "4", "6", "8", "10", "12", "18", "24"]} value={form.installmentsCount} onChange={(installmentsCount) => setForm({ ...form, installmentsCount })} /></Field>
            <Field label="کارمزد (٪)"><Input value={form.feePercent} onChange={(v) => setForm({ ...form, feePercent: v.replace(/[^\d.]/g, "") })} /></Field>
            <Field label="حداقل مبلغ سفارش (ریال)"><Input value={form.minOrderRial} onChange={(v) => setForm({ ...form, minOrderRial: v.replace(/\D/g, "") })} /></Field>
            <Field label="سقف مبلغ (ریال، خالی = بدون سقف)"><Input value={form.maxOrderRial} onChange={(v) => setForm({ ...form, maxOrderRial: v.replace(/\D/g, "") })} /></Field>
            <Field label="متن نشان"><Input value={form.badgeText} onChange={(badgeText) => setForm({ ...form, badgeText })} placeholder="بدون کارمزد" /></Field>
            <Field label="ترتیب نمایش"><Input value={form.position} onChange={(v) => setForm({ ...form, position: v.replace(/\D/g, "") })} /></Field>
            <Field label="لوگو (https یا /api/v1/media/…)"><Input value={form.logoUrl} onChange={(logoUrl) => setForm({ ...form, logoUrl })} /></Field>
            <Field label="اتصال به یکپارچه‌سازی درگاه"><Select options={["—", ...data.integrations.map((i) => i.code)]} value={form.integrationCode || "—"} onChange={(v) => setForm({ ...form, integrationCode: v === "—" ? "" : v })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-[12px] font-semibold">رنگ برند <input type="color" value={form.brandColor} onChange={(e) => setForm({ ...form, brandColor: e.target.value })} className="h-9 w-10 rounded border border-[var(--kv-line)]" /></label>
          <Field label="شرایط و توضیحات"><Textarea rows={3} value={form.terms} onChange={(terms) => setForm({ ...form, terms })} /></Field>
          <label className="flex items-center gap-2 text-[12.5px]"><Switch on={form.active} onToggle={() => setForm({ ...form, active: !form.active })} />فعال در فروشگاه</label>
          {form.integrationCode && !data.integrations.find((i) => i.code === form.integrationCode)?.enabled && <p className="rounded-[10px] bg-[var(--kv-warning,#B7791F)]/10 p-2 text-[11.5px] text-[var(--kv-warning,#B7791F)]">یکپارچه‌سازی درگاه انتخاب‌شده هنوز فعال نیست؛ پرداخت نهایی تا فعال‌سازی آن امکان‌پذیر نیست.</p>}
          <div className={cn("rounded-[12px] bg-[var(--kv-surface-2)] p-3 text-[12px]")}>
            {(() => { const est = estimate(price, form); return !est ? "تعداد اقساط نامعتبر است." : "reason" in est ? `با قیمت نمونه: ${est.reason}` : <>با قیمت نمونه: <b className="tabular-nums">{fa(est.count)} × {fmtMoney(rialToToman(est.per.toString()))}</b></>; })()}
          </div>
          <div className="flex gap-2"><Btn variant="accent" disabled={busy || form.title.trim().length < 2} onClick={save}>ذخیره</Btn><Btn variant="ghost" onClick={() => setForm(null)}>انصراف</Btn></div>
        </Card>
      ) : (
        <Card className="p-6 text-[12.5px] leading-7 text-[var(--kv-muted)]">یک سرویس را برای ویرایش انتخاب کنید. تغییر تعداد اقساط، کارمزد یا محدوده مبلغ فوراً روی کارت‌های اقساطی، کارت محصول و صفحه محصول اعمال می‌شود — محاسبه همیشه در سرور انجام می‌شود.</Card>
      )}
    </div>
  );
}
