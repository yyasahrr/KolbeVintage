import { useEffect, useState } from "react";
import {
  Sparkles, Check, RotateCcw, Save, Share2, Layers, Trash2,
  User, Store, ShieldCheck, ChevronLeft,
} from "lucide-react";
import { PRODUCTS, fmtMoney } from "../data/catalog";
import { digitsOnly } from "../data/customer";
import { useStore } from "../data/store";
import { Btn, Card, Field, Input } from "../components/primitives";
import { authApi } from "../data/api";
import { StyleCanvas } from "./style-canvas";
import { StyleStudio, type CartAddLine } from "./style-studio";
import { TryOn } from "./try-on";
import { cn } from "../utils/cn";

/* ================= STYLE BUILDER ================= */
export function StyleBuilder({ accountId, onLogin }: { accountId?: string; onLogin: () => void }) {
  const store = useStore();
  const [layers, setLayers] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem("kolbe-look-draft") || "[\"p1\",\"p4\"]") as string[]; }
    catch { return ["p1", "p4"]; }
  });
  const [active, setActive] = useState("p1");
  const [saved, setSaved] = useState(false);
  useEffect(() => { sessionStorage.setItem("kolbe-look-draft", JSON.stringify(layers)); }, [layers]);
  const toggle = (id: string) => {
    setLayers((ls) => (ls.includes(id) ? ls.filter((x) => x !== id) : [...ls, id]));
    setActive(id);
  };
  const save = () => {
    if (!layers.length) return;
    if (!accountId) { onLogin(); return; }
    store.saveStyle(accountId, layers, `استایل ${new Date().toLocaleDateString("fa-IR")}`);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 3200);
  };
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-16 pt-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Sparkles size={14} />استایل‌بیلدر کلبه</p>
          <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">بوم استایل تو</h1>
        </div>
        <div className="flex gap-2">
          <Btn variant="soft" size="sm" icon={<RotateCcw size={15} />} onClick={() => { setLayers([]); setSaved(false); }}>پاک‌سازی</Btn>
          <Btn variant="soft" size="sm" icon={<Save size={15} />} disabled={!layers.length} onClick={save}>ذخیره در حساب من</Btn>
          <Btn variant="accent" size="sm" icon={<Share2 size={15} />} disabled={!layers.length} onClick={save}>ثبت استایل</Btn>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[300px_1fr_250px]">
        {/* product drawer */}
        <Card className="h-fit p-4">
          <p className="mb-3 text-[13px] font-bold">افزودن به بوم</p>
          <div className="kv-scroll max-h-[560px] space-y-2 overflow-y-auto pl-1">
            {PRODUCTS.map((p) => {
              const on = layers.includes(p.id);
              return (
                <button key={p.id} onClick={() => toggle(p.id)} className={cn("kv-press flex w-full items-center gap-3 rounded-[12px] border p-2 text-right transition-all", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                  <img src={p.images[0]} alt="" className="h-14 w-12 shrink-0 rounded-[8px] object-cover" />
                  <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-bold">{p.name}</span><span className="text-[11.5px] text-[var(--kv-muted)] tabular-nums">{fmtMoney(p.retailPrice)}</span></span>
                  {on && <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--kv-accent)] text-white"><Check size={13} /></span>}
                </button>
              );
            })}
          </div>
        </Card>

        {/* canvas */}
        <div className="kv-dotted-light relative min-h-[480px] overflow-hidden rounded-[24px] border border-[var(--kv-line)] shadow-[var(--shadow-soft-md)]">
          {layers.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--kv-surface)] shadow"><Layers size={22} className="text-[var(--kv-muted)]" /></span>
              <p className="mt-4 text-[15px] font-bold">بوم خالی است</p>
              <p className="mt-1 max-w-[36ch] text-[13px] leading-6 text-[var(--kv-muted)]">از کشوی سمت راست محصولات را انتخاب کن تا لایه‌لایه روی بوم بچینیم.</p>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center gap-0 p-10">
              {layers.map((id, i) => {
                const p = PRODUCTS.find((x) => x.id === id)!;
                return (
                  <button
                    key={id} onClick={() => setActive(id)}
                    className={cn("kv-press relative w-44 shrink-0 overflow-hidden rounded-[18px] border-2 bg-white shadow-xl transition-all md:w-56",
                      active === id ? "z-10 scale-105 border-[var(--kv-accent)]" : "border-white/60",
                      i > 0 && "-mr-10 md:-mr-14")}
                    style={{ transform: `rotate(${(i - (layers.length - 1) / 2) * 5}deg) ${active === id ? "scale(1.05)" : ""}` }}
                  >
                    <img src={p.images[0]} alt={p.name} className="aspect-[3/4] w-full object-cover" />
                    <span className="absolute bottom-2 right-2 left-2 truncate rounded-lg bg-black/55 px-2 py-1 text-center text-[11px] font-bold text-white backdrop-blur-sm">{p.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {/* floating glass toolbar */}
          <div className="kv-glass absolute bottom-5 right-1/2 flex translate-x-1/2 items-center gap-1 rounded-full p-1.5">
            <span className="whitespace-nowrap px-3 text-xs font-bold">{layers.length.toLocaleString("fa-IR")} لایه</span>
            <span className="h-5 w-px bg-[var(--kv-line)]" />
            <Btn variant="ghost" size="sm" onClick={() => setActive(layers[layers.length - 1] ?? "")}>پیش‌نمایش</Btn>
            <Btn variant="dark" size="sm" disabled={!layers.length} onClick={save}>ذخیره استایل</Btn>
          </div>
          {saved && (
            <div className="absolute right-5 top-5 animate-[scaleIn_0.25s_ease]">
              <div className="kv-glass flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[13px] font-bold"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--kv-success)] text-white"><Check size={13} /></span>استایل ذخیره شد</div>
            </div>
          )}
        </div>

        {/* layer controls */}
        <Card className="h-fit p-4">
          <p className="mb-3 text-[13px] font-bold">لایه‌ها</p>
          {layers.length === 0 ? <p className="text-xs leading-6 text-[var(--kv-muted)]">هنوز لایه‌ای نداری.</p> : (
            <div className="space-y-2">
              {[...layers].reverse().map((id, i) => {
                const p = PRODUCTS.find((x) => x.id === id)!;
                return (
                  <div key={id} className={cn("flex items-center gap-2.5 rounded-[12px] border p-2", active === id ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)]")}>
                    <img src={p.images[0]} alt="" className="h-10 w-9 rounded-[7px] object-cover" />
                    <div className="min-w-0 flex-1"><p className="truncate text-[12px] font-bold">{p.name}</p><p className="text-[10.5px] text-[var(--kv-muted)]">لایه {(layers.length - i).toLocaleString("fa-IR")}</p></div>
                    <button onClick={() => setLayers(layers.filter((x) => x !== id))} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]" aria-label="حذف لایه"><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-4 rounded-[12px] bg-[var(--kv-surface-2)]/70 p-3 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            نکته: ترتیب لایه‌ها را با انتخاب محصول عوض کن؛ جدیدترین انتخاب همیشه روی بوم می‌آید.
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ================= AUTH ================= */
/*
 * ================= AUTH (locked remediation) =================
 *
 * ONE account/auth system for CUSTOMER and VIP:
 *   • موبایل + کد یکبارمصرف  → POST /auth/otp/request + /auth/otp/verify (real, server-issued, hashed)
 *   • ایمیل + رمز عبور        → POST /auth/login (same user row, same session model; 2FA honoured)
 *   • ثبت‌نام واقعی مشتری      → POST /auth/register
 * VIP is NOT a separate login or account: it is the canonical active membership on this same
 * account (the entitlement is exposed by GET /auth/me and gated server-side by the order endpoints).
 *
 * ADMIN and SUPPLIER keep SEPARATE logins (this component renders login-only for them — no public
 * admin registration; suppliers apply through «درخواست عضویت تأمین‌کننده» and are provisioned after
 * review). The production demo shortcuts are gone: no fixed code, no client-side session.
 */
export function AuthScreens({ portal, onDone }: { portal: string; onDone: (identity?: string) => void | Promise<void> }) {
  const isRetail = portal === "retail";
  const isAdmin = portal === "admin";
  const [mode, setMode] = useState<"login" | "register" | "recover" | "activate">("login");
  /** §5: only ONE mode's inputs are active at a time. */
  const [loginMethod, setLoginMethod] = useState<"otp" | "password">("otp");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  /* ---- login by EMAIL + PASSWORD (same account, same session model) ---- */
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState<{ challengeId: string; devCode?: string; code: string } | null>(null);

  /* ---- login / signup by MOBILE + one-time code ---- */
  const [phone, setPhone] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; masked: string; devCode?: string } | null>(null);
  const [code, setCode] = useState("");

  /* ---- registration (mobile-first; the number is verified BEFORE the account exists) ---- */
  const [signupPhone, setSignupPhone] = useState("");
  const [signupChallenge, setSignupChallenge] = useState<{ id: string; masked: string; devCode?: string } | null>(null);
  const [signupCode, setSignupCode] = useState("");
  const [signupName, setSignupName] = useState("");
  const [signupFamily, setSignupFamily] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  /* ---- password recovery (canonical one-time token → set-password) ---- */
  const [recover, setRecover] = useState({ identity: "", token: "", password: "", confirm: "" });

  /* ---- legacy/migrated account activation (secondary; operator-issued token) ---- */
  const [activate, setActivate] = useState({ token: "", password: "", confirm: "" });

  const title = isAdmin ? "ورود مدیریت" : isRetail ? "ورود یا ثبت‌نام" : "ورود تأمین‌کنندگان";
  const subtitle = isAdmin
    ? "دسترسی امن کارکنان کلبه به کنسول عملیات. حساب مدیریت از طریق ثبت‌نام عمومی ساخته نمی‌شود."
    : isRetail
      ? "با شماره موبایل و کد یکبارمصرف، یا با ایمیل و رمز عبور وارد شوید. عضویت VIP روی همین حساب فعال می‌شود."
      : "ورود تأمین‌کنندگان تأییدشده. برای همکاری جدید از «درخواست عضویت تأمین‌کننده» استفاده کنید.";

  const finish = async () => { await onDone(); };

  /** §23: technical failures never reach the customer as raw codes. */
  const friendly = (err: unknown) => {
    const message = err instanceof Error ? err.message : "";
    if (!message) return "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.";
    if (/^\s*\{/.test(message) || /INTERNAL_ERROR|ECONN|Failed to fetch/.test(message)) return "خطای موقت در سرور رخ داد؛ کمی بعد دوباره تلاش کنید.";
    if (/^[A-Z][A-Z_]{3,}$/.test(message)) return "انجام این عملیات ممکن نشد؛ دوباره تلاش کنید.";
    return message;
  };
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (err) { setError(friendly(err)); } finally { setBusy(false); }
  };

  /* ---------------- mobile + code: sign-in ---------------- */
  const requestLoginCode = () => run(async () => {
    if (!/^09\d{9}$/.test(digitsOnly(phone))) throw new Error("شماره موبایل نامعتبر است؛ نمونهٔ درست: ۰۹۱۲۳۴۵۶۷۸۹.");
    const res = await authApi.requestOtp({ phone: digitsOnly(phone) });
    setChallenge({ id: res.challengeId, masked: res.phoneMasked, ...(res.devCode ? { devCode: res.devCode } : {}) });
    setCode("");
    setNotice(`کد ورود به شماره ${res.phoneMasked} پیامک شد.`);
  });
  const verifyLoginCode = () => run(async () => {
    if (!challenge) throw new Error("ابتدا کد ورود را دریافت کنید.");
    if (digitsOnly(code).length !== 6) throw new Error("کد واردشده باید ۶ رقم باشد.");
    await authApi.verifyOtp({ challengeId: challenge.id, code: digitsOnly(code) });
    await finish();
  });

  /* ---------------- email + password: sign-in ---------------- */
  const passwordLogin = () => run(async () => {
    if (email.trim().length < 5) throw new Error("ایمیل یا شماره موبایل را کامل وارد کنید.");
    if (!password) throw new Error("رمز عبور را وارد کنید.");
    const res = await authApi.login({ identity: email.trim().toLowerCase(), password });
    if (res.twoFactorRequired && res.challengeId) {
      setTwoFactor({ challengeId: res.challengeId, code: "", ...(res.devCode ? { devCode: res.devCode } : {}) });
      setNotice("برای ادامه، کد تأیید پیامک‌شده را وارد کنید.");
      return;
    }
    await finish();
  });
  const verifyTwoFactor = () => run(async () => {
    if (!twoFactor) return;
    if (digitsOnly(twoFactor.code).length !== 6) throw new Error("کد واردشده باید ۶ رقم باشد.");
    await authApi.loginTwoFactor(twoFactor.challengeId, digitsOnly(twoFactor.code));
    await finish();
  });

  /* ---------------- registration: mobile → code → account ---------------- */
  const requestSignupCode = () => run(async () => {
    if (!/^09\d{9}$/.test(digitsOnly(signupPhone))) throw new Error("شماره موبایل نامعتبر است؛ نمونهٔ درست: ۰۹۱۲۳۴۵۶۷۸۹.");
    const res = await authApi.requestOtp({ phone: digitsOnly(signupPhone), purpose: "signup" });
    setSignupChallenge({ id: res.challengeId, masked: res.phoneMasked, ...(res.devCode ? { devCode: res.devCode } : {}) });
    setSignupCode("");
    setNotice(`کد تأیید به شماره ${res.phoneMasked} پیامک شد.`);
  });
  const submitRegistration = () => run(async () => {
    if (!signupChallenge) throw new Error("ابتدا کد تأیید را دریافت کنید.");
    const displayName = `${signupName} ${signupFamily}`.trim();
    if (displayName.length < 3) throw new Error("نام و نام خانوادگی را کامل وارد کنید.");
    if (digitsOnly(signupCode).length !== 6) throw new Error("کد واردشده باید ۶ رقم باشد.");
    if (signupPassword && signupPassword.length < 12) throw new Error("رمز عبور باید دست‌کم ۱۲ نویسه باشد.");
    await authApi.register({
      displayName,
      phone: digitsOnly(signupPhone),
      code: digitsOnly(signupCode),
      ...(signupEmail.trim() ? { email: signupEmail.trim().toLowerCase() } : {}),
      ...(signupPassword ? { password: signupPassword } : {}),
    });
    await finish();
  });

  /* ---------------- recovery ---------------- */
  const requestRecovery = () => run(async () => {
    if (recover.identity.trim().length < 5) throw new Error("شماره موبایل یا ایمیل حساب را وارد کنید.");
    const res = await authApi.forgotPassword(recover.identity.trim().toLowerCase());
    setRecover({ ...recover, token: res.devToken ?? "" });
    setNotice(res.devToken
      ? "لینک بازیابی برای شما ثبت شد. در محیط توسعه، کد بازیابی به‌صورت خودکار تکمیل شده است."
      : "اگر این شناسه به حسابی متعلق باشد، لینک بازیابی برای شما ارسال می‌شود.");
  });
  const submitRecovery = () => run(async () => {
    if (recover.token.trim().length < 20) throw new Error("کد بازیابی معتبر نیست.");
    if (recover.password.length < 12) throw new Error("گذرواژه جدید باید دست‌کم ۱۲ نویسه باشد.");
    if (recover.password !== recover.confirm) throw new Error("تکرار گذرواژه با گذرواژه جدید یکسان نیست.");
    await authApi.setPassword({ token: recover.token.trim(), newPassword: recover.password });
    const res = await authApi.login({ identity: recover.identity.trim().toLowerCase(), password: recover.password });
    if (res.twoFactorRequired && res.challengeId) {
      setMode("login"); setEmail(recover.identity.trim().toLowerCase()); setPassword(recover.password);
      setTwoFactor({ challengeId: res.challengeId, code: "", ...(res.devCode ? { devCode: res.devCode } : {}) });
      setNotice("گذرواژه جدید ثبت شد؛ کد تأیید پیامک‌شده را وارد کنید.");
      return;
    }
    await finish();
  });

  /* ---------------- legacy activation (secondary) ---------------- */
  const submitActivation = () => run(async () => {
    if (activate.token.trim().length < 20) throw new Error("کد فعال‌سازی معتبر نیست.");
    if (activate.password.length < 12) throw new Error("گذرواژه جدید باید دست‌کم ۱۲ نویسه باشد.");
    if (activate.password !== activate.confirm) throw new Error("تکرار گذرواژه با گذرواژه جدید یکسان نیست.");
    await authApi.setPassword({ token: activate.token.trim(), newPassword: activate.password });
    setNotice("حساب فعال شد؛ حالا با ایمیل یا موبایل خود وارد شوید.");
    setMode("login");
    setActivate({ token: "", password: "", confirm: "" });
  });

  const tab = (value: typeof mode, label: string) => (
    <button key={value} onClick={() => { setMode(value); setError(""); setNotice(""); }} aria-pressed={mode === value}
      className={cn("min-h-10 flex-1 rounded-full px-3 text-[13px] font-bold transition-colors", mode === value ? "bg-[var(--kv-surface)] text-[var(--kv-ink)] shadow-[var(--shadow-soft-sm)]" : "text-[var(--kv-muted)] hover:text-[var(--kv-ink)]")}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto w-full max-w-[460px] px-4 pb-16 pt-6">
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-[var(--kv-accent)] text-white">
            {isAdmin ? <ShieldCheck size={20} /> : isRetail ? <User size={20} /> : <Store size={20} />}
          </span>
          <div>
            <h1 className="text-[17px] font-extrabold">{title}</h1>
            <p className="text-[12.5px] text-[var(--kv-muted)]">حساب واحد کلبه — بدون حساب جداگانه برای VIP</p>
          </div>
        </div>
        <p className="mt-4 text-[13px] leading-7 text-[var(--kv-muted)]">{subtitle}</p>

        {isRetail && (
          <div className="mt-5 flex gap-1 rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/70 p-1" role="tablist">
            {tab("login", "ورود")}
            {tab("register", "ثبت‌نام")}
          </div>
        )}

        {error && <p role="alert" className="mt-4 rounded-[11px] bg-[#FBEDEC] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#8C2F23]">{error}</p>}
        {notice && !error && <p aria-live="polite" className="mt-4 rounded-[11px] bg-[var(--kv-surface-2)] px-3.5 py-2.5 text-[12.5px] text-[var(--kv-muted)]">{notice}</p>}

        {/* ============ LOGIN ============ */}
        {mode === "login" && (!isAdmin) && (
          <div className="mt-5 space-y-4">
            {isRetail && (
              <div className="flex gap-1 rounded-[11px] bg-[var(--kv-surface-2)]/70 p-1 text-[12.5px] font-bold" role="tablist">
                {(["otp", "password"] as const).map((m) => (
                  <button key={m} role="tab" aria-selected={loginMethod === m} onClick={() => { setLoginMethod(m); setError(""); }}
                    className={cn("min-h-9 flex-1 rounded-[9px]", loginMethod === m ? "bg-[var(--kv-surface)] shadow-[var(--shadow-soft-sm)]" : "text-[var(--kv-muted)]")}>
                    {m === "otp" ? "شماره موبایل و کد یکبارمصرف" : "ایمیل و رمز عبور"}
                  </button>
                ))}
              </div>
            )}

            {(!isRetail || loginMethod === "otp") ? (
              <>
                <Field label="شماره موبایل"><Input value={phone} onChange={(v) => { setPhone(v); setError(""); }} placeholder="09123456789"
                  inputMode="tel" autoComplete="tel" ariaLabel="شماره موبایل" /></Field>
                {!challenge ? (
                  <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void requestLoginCode()}>
                    {busy ? "در حال ارسال کد…" : "ارسال کد ورود"}
                  </Btn>
                ) : (
                  <>
                    <Field label="کد یکبارمصرف" hint={`کد به ${challenge.masked} پیامک شد.`}>
                      <Input value={code} onChange={(v) => { setCode(digitsOnly(v).slice(0, 6)); setError(""); }} placeholder="------"
                        inputMode="numeric" autoComplete="one-time-code" ariaLabel="کد یکبارمصرف" dir="ltr" />
                    </Field>
                    {challenge.devCode && <p className="rounded-[11px] bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{challenge.devCode}</b></p>}
                    <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void verifyLoginCode()}>
                      {busy ? "در حال بررسی…" : "ورود به حساب"}
                    </Btn>
                    <button onClick={() => void requestLoginCode()} className="w-full text-[12.5px] font-semibold text-[var(--kv-accent)] hover:underline">ارسال دوبارهٔ کد</button>
                    <button onClick={() => { setChallenge(null); setCode(""); }} className="w-full text-[12.5px] text-[var(--kv-muted)] hover:underline">تغییر شماره موبایل</button>
                  </>
                )}
              </>
            ) : (
              <>
                <Field label={isAdmin ? "ایمیل کارکنان" : "ایمیل یا شماره موبایل"}>
                  <Input value={email} onChange={(v) => { setEmail(v); setError(""); }} placeholder={isAdmin ? "name@kolbe.ir" : "you@example.com"}
                    inputMode={isAdmin ? "email" : "text"} autoComplete="username" ariaLabel="ایمیل یا شماره موبایل" dir="ltr" />
                </Field>
                <Field label="رمز عبور">
                  <Input type="password" value={password} onChange={(v) => { setPassword(v); setError(""); }}
                    autoComplete="current-password" ariaLabel="رمز عبور" dir="ltr" />
                </Field>
                {twoFactor ? (
                  <>
                    <Field label="کد تأیید دومرحله‌ای">
                      <Input value={twoFactor.code} onChange={(v) => setTwoFactor({ ...twoFactor, code: digitsOnly(v).slice(0, 6) })}
                        inputMode="numeric" autoComplete="one-time-code" ariaLabel="کد تأیید دومرحله‌ای" dir="ltr" />
                    </Field>
                    {twoFactor.devCode && <p className="rounded-[11px] bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{twoFactor.devCode}</b></p>}
                    <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void verifyTwoFactor()}>
                      {busy ? "در حال بررسی…" : "تأیید و ورود"}
                    </Btn>
                  </>
                ) : (
                  <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void passwordLogin()}>
                    {busy ? "در حال ورود…" : "ورود"}
                  </Btn>
                )}
                <button onClick={() => { setMode("recover"); setRecover({ identity: email, token: "", password: "", confirm: "" }); setError(""); setNotice(""); }}
                  className="w-full text-[12.5px] font-semibold text-[var(--kv-accent)] hover:underline">رمز عبور را فراموش کرده‌ام</button>
                {isAdmin && <p className="text-center text-[12px] text-[var(--kv-muted)]">ورود مدیریت فقط با حساب کارکنان کلبه. ثبت‌نام عمومی ندارد.</p>}
              </>
            )}
          </div>
        )}

        {/* ============ ADMIN LOGIN (no public registration) ============ */}
        {mode === "login" && isAdmin && (
          <div className="mt-5 space-y-4">
            <Field label="ایمیل کارکنان">
              <Input value={email} onChange={(v) => { setEmail(v); setError(""); }} placeholder="name@kolbe.ir" inputMode="email" autoComplete="username" ariaLabel="ایمیل کارکنان" dir="ltr" />
            </Field>
            <Field label="رمز عبور">
              <Input type="password" value={password} onChange={(v) => { setPassword(v); setError(""); }} autoComplete="current-password" ariaLabel="رمز عبور" dir="ltr" />
            </Field>
            {twoFactor ? (
              <>
                <Field label="کد تأیید دومرحله‌ای">
                  <Input value={twoFactor.code} onChange={(v) => setTwoFactor({ ...twoFactor, code: digitsOnly(v).slice(0, 6) })} inputMode="numeric" autoComplete="one-time-code" ariaLabel="کد تأیید دومرحله‌ای" dir="ltr" />
                </Field>
                {twoFactor.devCode && <p className="rounded-[11px] bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{twoFactor.devCode}</b></p>}
                <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void verifyTwoFactor()}>{busy ? "در حال بررسی…" : "تأیید و ورود"}</Btn>
              </>
            ) : (
              <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void passwordLogin()}>{busy ? "در حال ورود…" : "ورود"}</Btn>
            )}
            <p className="text-center text-[12px] text-[var(--kv-muted)]">دسترسی مدیریت از طریق RBAC سرور تعیین می‌شود و ثبت‌نام عمومی ندارد.</p>
          </div>
        )}

        {/* ============ REGISTRATION ============ */}
        {mode === "register" && (
          <div className="mt-5 space-y-4">
            <Field label="شماره موبایل" hint="ثبت‌نام با تأیید شماره موبایل انجام می‌شود.">
              <Input value={signupPhone} onChange={(v) => { setSignupPhone(v); setError(""); }} placeholder="09123456789" inputMode="tel" autoComplete="tel" ariaLabel="شماره موبایل" />
            </Field>
            {!signupChallenge ? (
              <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void requestSignupCode()}>
                {busy ? "در حال ارسال کد…" : "ارسال کد تأیید"}
              </Btn>
            ) : (
              <>
                <Field label="کد تأیید" hint={`کد به ${signupChallenge.masked} پیامک شد.`}>
                  <Input value={signupCode} onChange={(v) => { setSignupCode(digitsOnly(v).slice(0, 6)); setError(""); }} placeholder="------" inputMode="numeric" autoComplete="one-time-code" ariaLabel="کد تأیید" dir="ltr" />
                </Field>
                {signupChallenge.devCode && <p className="rounded-[11px] bg-amber-50 px-3 py-2 text-[12px] text-amber-900">محیط توسعه — کد: <b dir="ltr">{signupChallenge.devCode}</b></p>}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="نام"><Input value={signupName} onChange={(v) => { setSignupName(v); setError(""); }} autoComplete="given-name" ariaLabel="نام" /></Field>
                  <Field label="نام خانوادگی"><Input value={signupFamily} onChange={(v) => { setSignupFamily(v); setError(""); }} autoComplete="family-name" ariaLabel="نام خانوادگی" /></Field>
                </div>
                <Field label="ایمیل (اختیاری)" hint="برای ورود با ایمیل و رمز عبور در آینده.">
                  <Input value={signupEmail} onChange={(v) => { setSignupEmail(v); setError(""); }} autoComplete="email" inputMode="email" ariaLabel="ایمیل" dir="ltr" />
                </Field>
                <Field label="رمز عبور (اختیاری)" hint="دست‌کم ۱۲ نویسه. اگر خالی بماند، همیشه با کد پیامکی وارد می‌شوید.">
                  <Input type="password" value={signupPassword} onChange={(v) => { setSignupPassword(v); setError(""); }} autoComplete="new-password" ariaLabel="رمز عبور" dir="ltr" />
                </Field>
                <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void submitRegistration()}>
                  {busy ? "در حال ساخت حساب…" : "ساخت حساب"}
                </Btn>
                <button onClick={() => void requestSignupCode()} className="w-full text-[12.5px] font-semibold text-[var(--kv-accent)] hover:underline">ارسال دوبارهٔ کد</button>
              </>
            )}
            <p className="text-[12px] leading-6 text-[var(--kv-muted)]">
              عضویت VIP/عمده روی همین حساب فعال می‌شود و ورود جداگانه ندارد. تأمین‌کنندگان از مسیر «درخواست عضویت تأمین‌کننده» ثبت‌نام می‌کنند.
            </p>
          </div>
        )}

        {/* ============ PASSWORD RECOVERY ============ */}
        {mode === "recover" && (
          <div className="mt-5 space-y-4">
            <Field label="ایمیل یا شماره موبایل حساب">
              <Input value={recover.identity} onChange={(v) => setRecover({ ...recover, identity: v })} autoComplete="username" ariaLabel="ایمیل یا شماره موبایل" dir="ltr" />
            </Field>
            {!recover.token ? (
              <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void requestRecovery()}>{busy ? "در حال ارسال…" : "ارسال لینک بازیابی"}</Btn>
            ) : (
              <>
                <Field label="کد بازیابی" hint="کد یکبارمصرف بازیابی؛ فقط یک بار قابل استفاده است.">
                  <Input value={recover.token} onChange={(v) => setRecover({ ...recover, token: v })} ariaLabel="کد بازیابی" dir="ltr" />
                </Field>
                <Field label="گذرواژه جدید"><Input type="password" value={recover.password} onChange={(v) => setRecover({ ...recover, password: v })} autoComplete="new-password" ariaLabel="گذرواژه جدید" dir="ltr" /></Field>
                <Field label="تکرار گذرواژه جدید"><Input type="password" value={recover.confirm} onChange={(v) => setRecover({ ...recover, confirm: v })} autoComplete="new-password" ariaLabel="تکرار گذرواژه جدید" dir="ltr" /></Field>
                <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void submitRecovery()}>{busy ? "در حال ثبت…" : "تعیین گذرواژه و ورود"}</Btn>
              </>
            )}
            <button onClick={() => { setMode("login"); setError(""); setNotice(""); }} className="flex w-full items-center justify-center gap-1 text-[12.5px] font-semibold text-[var(--kv-muted)] hover:underline">
              <ChevronLeft size={14} /> بازگشت به ورود
            </button>
          </div>
        )}

        {/* ============ LEGACY ACTIVATION (secondary) ============ */}
        {mode === "activate" && (
          <div className="mt-5 space-y-4">
            <p className="rounded-[11px] bg-[var(--kv-surface-2)] px-3.5 py-2.5 text-[12.5px] leading-6 text-[var(--kv-muted)]">
              اگر حساب شما در انتقال‌های قبلی کلبه ایجاد شده و کد فعال‌سازی دریافت کرده‌اید، از این بخش گذرواژه تعیین کنید.
            </p>
            <Field label="کد فعال‌سازی"><Input value={activate.token} onChange={(v) => setActivate({ ...activate, token: v })} autoComplete="one-time-code" ariaLabel="کد فعال‌سازی" dir="ltr" /></Field>
            <Field label="گذرواژه جدید"><Input type="password" value={activate.password} onChange={(v) => setActivate({ ...activate, password: v })} autoComplete="new-password" ariaLabel="گذرواژه جدید" dir="ltr" /></Field>
            <Field label="تکرار گذرواژه جدید"><Input type="password" value={activate.confirm} onChange={(v) => setActivate({ ...activate, confirm: v })} autoComplete="new-password" ariaLabel="تکرار گذرواژه جدید" dir="ltr" /></Field>
            <Btn variant="accent" size="lg" className="w-full" disabled={busy} onClick={() => void submitActivation()}>{busy ? "در حال فعال‌سازی…" : "فعال‌سازی حساب"}</Btn>
            <button onClick={() => { setMode("login"); setError(""); }} className="flex w-full items-center justify-center gap-1 text-[12.5px] font-semibold text-[var(--kv-muted)] hover:underline">
              <ChevronLeft size={14} /> بازگشت به ورود
            </button>
          </div>
        )}

        {(mode === "login" || mode === "register") && (
          <div className="mt-6 border-t border-[var(--kv-line)] pt-4 text-center">
            {isRetail && mode === "login" && (
              <p className="text-[12.5px] text-[var(--kv-muted)]">
                حساب ندارید؟ <button onClick={() => { setMode("register"); setError(""); setNotice(""); }} className="font-bold text-[var(--kv-accent)] hover:underline">ثبت‌نام کنید</button>
              </p>
            )}
            <button onClick={() => { setMode("activate"); setError(""); setNotice(""); }} className="mt-2 text-[12px] text-[var(--kv-muted)] hover:underline">
              فعال‌سازی حساب‌های قدیمی (کد فعال‌سازی)
            </button>
          </div>
        )}
        {isAdmin && (
          <p className="mt-5 text-center text-[12px] text-[var(--kv-muted)]">ثبت‌نام ادمین وجود ندارد؛ حساب کارکنان فقط توسط تیم کلبه ساخته می‌شود.</p>
        )}
        {!isRetail && !isAdmin && (
          <p className="mt-5 text-center text-[12.5px] leading-6 text-[var(--kv-muted)]">
            تأمین‌کنندهٔ تأییدشده نیستید؟ از دکمهٔ «درخواست عضویت تأمین‌کننده» استفاده کنید — درخواست شما بررسی می‌شود و پس از تأیید دسترسی عملیاتی فعال خواهد شد.
          </p>
        )}
      </Card>
    </div>
  );
}

export default function StudioExperience({ tab, setTab, accountId, onLogin, onAddItems }: { tab: string; setTab: (t: string) => void; accountId?: string; onLogin: () => void; onAddItems?: (lines: CartAddLine[]) => void }) {
  const demo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  return (
    <div>
      <div className="mx-auto flex w-full max-w-[1400px] justify-center px-4 pt-5 md:px-8">
        <div className="kv-glass inline-flex rounded-full p-1">
          {(["tryon", "builder"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("kv-press rounded-full px-5 py-2 text-[13.5px] font-bold transition-all", tab === t ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "text-[var(--kv-muted)]")}>
              {t === "builder" ? "ساخت استایل" : "پرو مجازی"}
            </button>
          ))}
        </div>
      </div>
      {tab === "builder" ? (demo ? <StyleCanvas accountId={accountId} onLogin={onLogin} /> : <StyleStudio accountId={accountId} onLogin={onLogin} onAddItems={onAddItems} />) : <TryOn onLogin={onLogin} />}
    </div>
  );
}
