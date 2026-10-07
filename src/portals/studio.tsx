/* KOLBE — Studio surfaces (Phase 1, Non-Core workstream)
 *
 * The studio is no longer a try-on/builder tab pair: the two are separate
 * customer jobs with separate surfaces.
 *   - «پرو مجازی» → try-on.tsx (how does THIS product look on me?)
 *   - «ساخت استایل» → style-builder.tsx (what works together as an outfit?)
 * The retail auth screens (OTP demo) stay here because every portal shares
 * them.
 */
import { useState } from "react";
import { ChevronLeft, Lock, ShieldCheck, Store, User } from "lucide-react";
import StyleBuilder, { type BuilderEntry } from "./style-builder";
import { TryOn } from "./try-on";
import { digitsOnly } from "../data/customer";
import type { Product } from "../data/catalog";
import type { LineFailure } from "../data/cart";
import { Btn, Card, Field, Input } from "../components/primitives";
import { cn } from "../utils/cn";

export type StudioSurface = "tryon" | "builder";

export function StudioExperience({ surface, accountId, entry, onEntryConsumed, onLogin, onAddOutfit }: {
  surface: StudioSurface;
  accountId?: string;
  catalogue: Product[];
  entry: BuilderEntry;
  onEntryConsumed: () => void;
  onLogin: () => void;
  onAddOutfit: (lines: { productId: string; size: string; color: string; qty: number }[]) => { ok: boolean; failures: LineFailure[] };
  onOpenProduct: (id: string) => void;
}) {
  if (surface === "builder") {
    return (
      <StyleBuilder
        accountId={accountId}
        entry={entry}
        onEntryConsumed={onEntryConsumed}
        onLogin={onLogin}
        onAddOutfit={onAddOutfit}
      />
    );
  }
  // the integrated server-backed try-on (credits + real provider) — it
  // fetches its own catalogue; the entry-product preselect from the PDP
  // cards is an accepted integration gap until that contract grows one
  return <TryOn onLogin={onLogin} />;
}

export default StudioExperience;

/* ================= AUTH ================= */
export function AuthScreens({ portal, onDone }: { portal: string; onDone: (phone: string) => void }) {
  const [mode, setMode] = useState<"login" | "otp">("login");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const conf: Record<string, { t: string; d: string; icon: React.ReactNode; tone: string }> = {
    retail: { t: "ورود به حساب کلبه", d: "یک حساب برای خرید خرده، عضویت عمده و استایل‌های شما.", icon: <User size={20} />, tone: "bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]" },
    supplier: { t: "ورود تأمین‌کننده", d: "مدیریت محصولات، سفارش‌ها و تسویه.", icon: <Store size={20} />, tone: "bg-[var(--kv-surface-2)] text-[var(--kv-ink)]" },
    admin: { t: "ورود مدیریت", d: "دسترسی امن به کنسول عملیات کلبه.", icon: <ShieldCheck size={20} />, tone: "bg-[#1B2A4A] text-white" },
  };
  const c = conf[portal] ?? conf.retail;
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-[440px] flex-col justify-center px-4 py-14">
      <div className="text-center">
        <p className="kv-latin text-[13px]">KOLBE VINTAGE</p>
        <div className={cn("mx-auto mt-5 flex h-14 w-14 items-center justify-center rounded-2xl", c.tone)}>{c.icon}</div>
        <h1 className="kv-editorial-title mt-4 text-[24px]">{c.t}</h1>
        <p className="mt-2 text-sm text-[var(--kv-muted)]">{c.d}</p>
      </div>
      <Card className="mt-7 p-6">
        {mode === "login" ? (
          <div className="space-y-4">
            <Field label="شماره موبایل"><Input placeholder="۰۹۱۲ ۳۴۵ ۶۷۸۹" value={phone} onChange={(v) => { setPhone(v); setError(""); }} /></Field>
            {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
            <Btn variant={portal === "admin" ? "dark" : "accent"} className="w-full" size="lg" onClick={() => { if (!/^09\d{9}$/.test(digitsOnly(phone))) { setError("شماره همراه ۱۱ رقمی معتبر وارد کنید."); return; } setMode("otp"); setError(""); }}>ادامه با شماره همراه</Btn>
            <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--kv-muted)]"><Lock size={12} />نسخه آزمایشی: پیامک واقعی ارسال نمی‌شود.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-center text-[13px] text-[var(--kv-muted)]">شماره همراه: <b className="text-[var(--kv-ink)] tabular-nums" dir="ltr">{digitsOnly(phone)}</b></p>
            <Field label="کد آزمایشی (۱۲۳۴۵)"><input inputMode="numeric" autoComplete="one-time-code" maxLength={5} value={code} onChange={(e) => { setCode(digitsOnly(e.target.value)); setError(""); }} className="h-12 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-center text-lg font-bold tracking-[0.3em] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" dir="ltr" /></Field>
            {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
            <Btn variant={portal === "admin" ? "dark" : "accent"} className="w-full" size="lg" onClick={() => { if (code !== "12345") { setError("کد آزمایشی ۱۲۳۴۵ است."); return; } onDone(digitsOnly(phone)); }}>ورود به حساب</Btn>
            <button onClick={() => setMode("login")} className="flex w-full items-center justify-center gap-1 text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"><ChevronLeft size={14} className="rotate-180" />تغییر شماره</button>
          </div>
        )}
      </Card>
      <p className="mt-5 text-center text-xs leading-6 text-[var(--kv-muted)]">با ورود، <b>قوانین استفاده</b> و <b>حریم خصوصی</b> کلبه را می‌پذیرید.</p>
    </div>
  );
}
