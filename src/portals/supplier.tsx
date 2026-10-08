import { useEffect, useState } from "react";
import { Check, FileSignature, KeyRound, Moon, Send, ShieldCheck, Sun } from "lucide-react";
import { Btn, Card, Field, Input, LoadingState, Select } from "../components/primitives";
import { AuthScreens } from "./studio";
import { SupplierPortalWorkspace } from "./supplier-portal-workspace";
import { apiClient, authApi, isAuthenticated } from "../data/api";
import { useOps } from "../data/ops";
import { cn } from "../utils/cn";

type SupplierSession = {
  id: string;
  identity: string;
  cooperationStatus: string;
  activityStatus: string;
} | null;

/* Login or apply: preserve the existing public application form and its server-backed workflow. */
function SupplierEntry({ onLogin }: { onLogin: () => void }) {
  const ops = useOps();
  const form = ops.applicationForm;
  const [mode, setMode] = useState<"login" | "apply">("login");
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const submit = async () => {
    const e = form.fields.filter((f) => f.required && !(values[f.id] ?? "").trim()).map((f) => `«${f.label}» الزامی است.`);
    form.fields.forEach((f) => {
      const v = (values[f.id] ?? "").replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 1776));
      if (v && f.type === "phone" && !/^09\d{9}$/.test(v)) e.push(`«${f.label}» باید شماره همراه ۱۱ رقمی باشد.`);
      if (v && f.type === "email" && !/^\S+@\S+\.\S+$/.test(v)) e.push(`«${f.label}» ایمیل معتبر نیست.`);
      if (v && f.type === "number" && !/^\d+$/.test(v)) e.push(`«${f.label}» باید عدد باشد.`);
      if (f.type === "file" && values[f.id]) {
        const ext = values[f.id].split(".").pop()?.toLowerCase() ?? "";
        if (!["pdf", "jpg", "jpeg", "png", "webp"].includes(ext)) e.push(`«${f.label}» فقط PDF یا تصویر مجاز است.`);
      }
    });
    setErrors(e);
    if (e.length) return;
    try {
      const payload: Record<string, string> = {};
      for (const field of form.fields) payload[field.id] = values[field.id] ?? "";
      const result = await apiClient.post<{ id: string; reference: string }>("/cooperation-requests", { payload });
      setSent(result.reference ?? result.id);
      setValues({});
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "خطا در ارسال درخواست"]);
    }
  };
  return (
    <div className="w-full">
      <div className="mb-4 flex justify-center"><div className="inline-flex rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/70 p-1">
        {([["login", "ورود تأمین‌کنندگان", <KeyRound key="k" size={14} />], ["apply", "درخواست همکاری", <FileSignature key="f" size={14} />]] as const).map(([value, label, icon]) =>
          <button key={value} onClick={() => setMode(value)} className={cn("flex min-h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold", mode === value ? "bg-[var(--kv-surface)] shadow-[var(--shadow-soft-sm)]" : "text-[var(--kv-muted)]")}>{icon}{label}</button>)}
      </div></div>
      {mode === "login" ? <AuthScreens portal="supplier" onDone={onLogin} /> : !form.active ? (
        <Card className="p-6 text-center"><p className="text-[15px] font-extrabold">پذیرش تأمین‌کننده موقتاً متوقف است</p><p className="mt-2 text-[13px] text-[var(--kv-muted)]">لطفاً بعداً دوباره مراجعه کنید یا با پشتیبانی کلبه تماس بگیرید.</p></Card>
      ) : sent ? (
        <Card className="p-6 text-center"><span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#E7F0E6] text-[#3E6B4A]"><Check size={22} /></span><p className="mt-3 text-[16px] font-extrabold">درخواست {sent} ثبت شد</p><p className="mt-2 text-[13px] leading-7 text-[var(--kv-muted)]">تیم کلبه درخواست را بررسی می‌کند و نتیجه را به شماره همراه اعلام‌شده اطلاع می‌دهد.</p><Btn variant="soft" size="sm" className="mt-4" onClick={() => setSent(null)}>ثبت درخواست دیگر</Btn></Card>
      ) : (
        <Card className="p-6">
          <p className="text-[16px] font-extrabold">{form.title}</p><p className="mt-1.5 text-[13px] leading-7 text-[var(--kv-muted)]">{form.intro}</p>
          <div className="mt-5 space-y-4">
            {form.fields.map((field) => {
              const label = `${field.label}${field.required ? " *" : ""}`;
              const value = values[field.id] ?? "";
              const set = (next: string) => setValues({ ...values, [field.id]: next });
              if (field.type === "textarea") return <Field key={field.id} label={label} hint={field.hint}><textarea rows={3} value={value} onChange={(event) => set(event.target.value)} className="w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 py-3 text-sm text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" /></Field>;
              if (field.type === "select") return <Field key={field.id} label={label} hint={field.hint}><Select options={["انتخاب کنید", ...(field.options ?? [])]} value={value || "انتخاب کنید"} onChange={(next) => set(next === "انتخاب کنید" ? "" : next)} /></Field>;
              if (field.type === "checkbox") return <label key={field.id} className="flex items-start gap-2 text-[13px] font-medium"><input type="checkbox" checked={value === "بله"} onChange={(event) => set(event.target.checked ? "بله" : "")} className="mt-1 h-4 w-4 accent-[#C1613B]" />{label}</label>;
              if (field.type === "file") return <Field key={field.id} label={label} hint={field.hint ?? "PDF یا تصویر · حداکثر ۵ مگابایت"}><input type="file" accept="image/*,application/pdf" onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) { set(""); return; }
                if (file.size > 5 * 1024 * 1024) { setErrors((previous) => [...previous, `«${field.label}» حداکثر ۵ مگابایت مجاز است.`]); return; }
                if (!["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(file.type)) { setErrors((previous) => [...previous, `«${field.label}» نوع فایل مجاز نیست.`]); return; }
                set(file.name);
              }} className="block w-full text-[12.5px] file:ml-3 file:rounded-[9px] file:border-0 file:bg-[var(--kv-surface-2)] file:px-3 file:py-2 file:text-[12px] file:font-semibold" /></Field>;
              return <Field key={field.id} label={label} hint={field.hint}><Input value={value} onChange={set} /></Field>;
            })}
          </div>
          {errors.length > 0 && <ul role="alert" className="mt-4 space-y-1 rounded-[12px] bg-[var(--kv-danger)]/[0.06] p-3 text-[12px] text-[var(--kv-danger)]">{errors.map((message) => <li key={message}>• {message}</li>)}</ul>}
          <Btn variant="accent" className="mt-5 w-full" onClick={submit} icon={<Send size={15} />}>ارسال درخواست</Btn>
          <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">درخواست همکاری از مسیر ثبت‌شده در سامانه ارسال می‌شود؛ دسترسی عملیاتی پس از تأیید کلبه فعال خواهد شد.</p>
        </Card>
      )}
    </div>
  );
}

function SupplierBrand() {
  return <div className="flex items-center gap-3">
    <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-accent)] text-[17px] font-bold text-white" style={{ fontFamily: "Marcellus, serif" }}>K</span>
    <span className="leading-tight"><span className="block text-[14px] font-bold" style={{ fontFamily: "Marcellus, serif", letterSpacing: "0.2em" }}>KOLBE</span><span className="block text-[11px] font-bold text-[var(--kv-muted)]">مرکز تأمین‌کنندگان</span></span>
  </div>;
}

export default function SupplierApp({ dark, setDark, onExit }: { dark: boolean; setDark: (value: boolean) => void; onExit: () => void }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<SupplierSession>(null);
  const [signedIn, setSignedIn] = useState(false);

  const verify = async () => {
    setLoading(true);
    try {
      if (!isAuthenticated()) { setSession(null); setSignedIn(false); return; }
      const identity = await authApi.me();
      const isSupplier = identity.roles.includes("supplier");
      const status = identity.supplier?.cooperationStatus ?? "not_submitted";
      const activity = identity.supplier?.activityStatus ?? "inactive";
      setSession({ id: identity.id, identity: identity.supplier?.brandName?.trim() || identity.displayName, cooperationStatus: status, activityStatus: activity });
      setSignedIn(isSupplier && status === "approved" && activity === "active");
    } catch {
      setSession(null);
      setSignedIn(false);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void verify(); }, []);

  if (loading) return <div dir="rtl" className="min-h-screen"><div className="mx-auto flex max-w-[1200px] items-center justify-between px-4 py-4"><SupplierBrand /><button onClick={() => setDark(!dark)} aria-label="تغییر تم" className="flex h-10 w-10 items-center justify-center rounded-[11px] border border-[var(--kv-line)]">{dark ? <Sun size={17} /> : <Moon size={17} />}</button></div><div className="mx-auto max-w-[1200px] px-4 py-12"><LoadingState label="در حال بررسی مجوز عملیاتی تأمین‌کننده با سرور…" /></div></div>;
  if (signedIn && session) return <SupplierPortalWorkspace dark={dark} setDark={setDark} supplierId={session.id} supplierName={session.identity} onLogout={async () => { await authApi.logout().catch(() => undefined); setSession(null); setSignedIn(false); }} />;

  const statusMessage = session?.cooperationStatus === "rejected"
    ? "درخواست همکاری تأیید نشده است. برای پیگیری با پشتیبانی کلبه تماس بگیرید."
    : session?.cooperationStatus === "approved" && session.activityStatus !== "active"
      ? "حساب تأمین‌کننده تأیید شده، اما در حال حاضر غیرفعال است؛ دسترسی عملیاتی در دسترس نیست."
      : session && session.cooperationStatus !== "not_submitted"
        ? "درخواست همکاری شما هنوز تأیید نشده است. پس از تأیید و فعال‌سازی توسط کلبه، دسترسی عملیاتی فعال می‌شود."
        : null;

  return (
    <div dir="rtl" className="min-h-screen">
      <header className="mx-auto flex h-[68px] w-full max-w-[1200px] items-center justify-between px-4 md:px-8">
        <SupplierBrand />
        <div className="flex items-center gap-2">
          {session && <Btn variant="ghost" size="sm" onClick={async () => { await authApi.logout().catch(() => undefined); setSession(null); }}>خروج</Btn>}
          <button onClick={() => setDark(!dark)} className="kv-press flex h-10 w-10 items-center justify-center rounded-[11px] hover:bg-[var(--kv-surface-2)]" aria-label="تغییر تم">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
          <Btn variant="ghost" size="sm" onClick={onExit}>رفتن به kolbe.ir</Btn>
        </div>
      </header>
      <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 px-4 pb-16 pt-6 md:px-8 lg:grid-cols-[1fr_440px]">
        <div className="hidden lg:block">
          <h1 className="kv-editorial-title text-[34px]">محصولاتت را به هزاران بوتیک و فروشگاه برسان</h1>
          <p className="mt-4 max-w-[52ch] text-[15px] leading-8 text-[var(--kv-muted)]">مرکز تأمین‌کنندگان کلبه جایی است که کاتالوگ عمده، سری‌ها، ظرفیت اعلامی و موجودی فیزیکیِ متعلق به خودت نزد کلبه را می‌بینی. ظرفیت OMS از موجودی انبار جداست؛ کلبه سفارش VIP را برای خریدار نهایی تکمیل می‌کند.</p>
          <ol className="mt-7 space-y-4">{[
            ["محصول و سری", "مدیریت کاتالوگ و مشاهده وضعیت بازبینی"],
            ["تخصیص OMS", "پاسخ، تعهد و اعلام آمادگی برای سفارش متصل به سفارش مادر"],
            ["تحویل به کلبه", "ارسال فقط به انبار کلبه؛ دریافت و QC خارج از این پنل"],
          ].map(([title, desc], index) => <li key={title} className="flex gap-4"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--kv-surface-2)] text-sm font-extrabold tabular-nums">{(index + 1).toLocaleString("fa-IR")}</span><div><p className="text-[14.5px] font-bold">{title}</p><p className="text-[13px] text-[var(--kv-muted)]">{desc}</p></div></li>)}</ol>
        </div>
        <div>
          {statusMessage && <Card className="mb-4 flex items-start gap-2 p-4 text-[12px] leading-7"><ShieldCheck size={17} className="mt-1 shrink-0 text-[var(--kv-accent)]" /><span>{statusMessage}</span></Card>}
          <SupplierEntry onLogin={() => void verify()} />
        </div>
      </div>
    </div>
  );
}
