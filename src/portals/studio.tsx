import { useEffect, useState } from "react";
import {
  Sparkles, Upload, Check, RotateCcw, Save, Share2, Layers, Trash2, Eye,
  Shirt, PersonStanding, Wand2, Camera, ArrowLeft, Lock, User, Store, ShieldCheck, ChevronLeft,
} from "lucide-react";
import { PRODUCTS, IMG, fmtMoney } from "../data/catalog";
import { digitsOnly } from "../data/customer";
import { useStore } from "../data/store";
import { Btn, Card, Field, Input } from "../components/primitives";
import { authApi } from "../data/api";
import { StyleCanvas } from "./style-canvas";
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

/* ================= TRY-ON ================= */
export function TryOn() {
  const [step, setStep] = useState(0);
  const [product, setProduct] = useState(PRODUCTS[0]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const steps = [
    { t: "انتخاب محصول", i: <Shirt size={16} /> },
    { t: "آپلود عکس", i: <Camera size={16} /> },
    { t: "پردازش", i: <Wand2 size={16} /> },
    { t: "نتیجه", i: <Eye size={16} /> },
    { t: "ذخیره", i: <Save size={16} /> },
  ];
  const process = () => {
    setBusy(true);
    setTimeout(() => { setBusy(false); setStep(3); }, 1800);
  };
  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pb-16 pt-6 md:px-8">
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Wand2 size={14} />پرو مجازی کلبه</p>
      <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">قبل از خرید، تن‌خور را ببین</h1>

      <div className="mt-6 flex items-center gap-1 overflow-x-auto kv-no-scrollbar">
        {steps.map((s, i) => (
          <div key={s.t} className="flex flex-1 items-center gap-2">
            <button onClick={() => i < step && setStep(i)} className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all", step >= i ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
              {step > i ? <Check size={15} /> : s.i}
            </button>
            <span className={cn("whitespace-nowrap text-[12.5px] font-bold", step >= i ? "" : "text-[var(--kv-muted)]")}>{s.t}</span>
            {i < 4 && <span className="mx-2 h-px min-w-4 flex-1 bg-[var(--kv-line)]" />}
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
        <Card className="min-h-[380px] p-6">
          {step === 0 && (
            <div>
              <p className="mb-3 text-sm font-bold">کدام محصول را می‌خواهی پرو کنی؟</p>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {PRODUCTS.slice(0, 6).map((p) => (
                  <button key={p.id} onClick={() => setProduct(p)} className={cn("kv-press overflow-hidden rounded-[14px] border text-right transition-all", product.id === p.id ? "border-[var(--kv-accent)] ring-2 ring-[var(--kv-accent)]/20" : "border-[var(--kv-line)]")}>
                    <img src={p.images[0]} alt="" className="aspect-[3/4] w-full object-cover" />
                    <p className="truncate p-2 text-[12px] font-bold">{p.name}</p>
                  </button>
                ))}
              </div>
              <Btn variant="accent" className="mt-4" onClick={() => setStep(1)} icon={<ArrowLeft size={16} />}>ادامه با {product.name}</Btn>
            </div>
          )}
          {step === 1 && (
            <div>
              <p className="mb-3 text-sm font-bold">یک عکس تمام‌قد آپلود کن</p>
              {!photo ? (
                <button onClick={() => setPhoto(IMG.trenchStreet)} className="flex w-full flex-col items-center gap-2.5 rounded-[16px] border border-dashed border-[var(--kv-line-strong)] py-14 text-[13.5px] font-bold text-[var(--kv-muted)] hover:border-[var(--kv-accent)] hover:text-[var(--kv-accent)]">
                  <Upload size={24} />انتخاب عکس از گالری
                  <span className="max-w-[40ch] text-xs font-normal leading-6">بهترین نتیجه: نور طبیعی، پس‌زمینه ساده، ایستاده و روبه‌رو. عکست فقط برای پرو استفاده می‌شود و ذخیره نمی‌کنیم.</span>
                </button>
              ) : (
                <div className="flex gap-4">
                  <img src={photo} alt="عکس کاربر" className="h-64 w-48 rounded-[14px] object-cover" />
                  <div className="flex flex-col justify-center gap-2.5">
                    <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-success)]"><Check size={15} />عکس آماده پردازش است</p>
                    <Btn variant="soft" size="sm" onClick={() => setPhoto(null)}>انتخاب عکس دیگر</Btn>
                    <Btn variant="accent" size="sm" onClick={() => { setStep(2); process(); }} icon={<Wand2 size={15} />}>شروع پرو مجازی</Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="flex min-h-[320px] flex-col items-center justify-center text-center">
              <span className="flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]"><Wand2 size={26} /></span>
              <p className="mt-4 text-[15px] font-extrabold">{busy ? "داریم لباس را روی عکست می‌نشینیم…" : "آماده شد!"}</p>
              <p className="mt-1 text-[13px] text-[var(--kv-muted)]">معمولاً کمتر از ۳۰ ثانیه طول می‌کشد</p>
              <div className="mt-4 h-1.5 w-56 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><div className={cn("h-full rounded-full bg-[var(--kv-accent)] transition-all duration-1000", busy ? "w-2/3" : "w-full")} /></div>
            </div>
          )}
          {step >= 3 && (
            <div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><p className="mb-2 text-xs font-bold text-[var(--kv-muted)]">عکس اصلی</p><img src={photo ?? IMG.trenchStreet} alt="" className="aspect-[3/4] w-full rounded-[14px] object-cover" /></div>
                <div><p className="mb-2 flex items-center gap-1 text-xs font-bold text-[var(--kv-accent)]"><Sparkles size={12} />نتیجه پرو مجازی</p>
                  <div className="relative overflow-hidden rounded-[14px]">
                    <img src={product.images[0]} alt="" className="aspect-[3/4] w-full object-cover" />
                    <span className="absolute bottom-3 right-3 left-3 rounded-[10px] bg-black/55 px-3 py-2 text-center text-[12px] font-bold text-white backdrop-blur-sm">{product.name} · شبیه‌سازی تن‌خور</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Btn variant="accent" size="sm" icon={<Save size={15} />} onClick={() => setStep(4)}>ذخیره نتیجه</Btn>
                <Btn variant="soft" size="sm" icon={<RotateCcw size={15} />} onClick={() => setStep(0)}>تلاش دوباره</Btn>
                {step === 4 && <p className="flex w-full items-center gap-1.5 pt-1 text-[13px] font-bold text-[var(--kv-success)]"><Check size={15} />در گالری پروهای تو ذخیره شد</p>}
              </div>
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card className="p-5">
            <p className="text-sm font-bold">محصول انتخاب‌شده</p>
            <div className="mt-3 flex gap-3">
              <img src={product.images[0]} alt="" className="h-20 w-16 rounded-[10px] object-cover" />
              <div><p className="text-[13.5px] font-bold">{product.name}</p><p className="mt-1 text-[13px] font-extrabold tabular-nums">{fmtMoney(product.retailPrice)}</p></div>
            </div>
          </Card>
          <Card className="p-5">
            <p className="flex items-center gap-1.5 text-sm font-bold"><PersonStanding size={16} className="text-[var(--kv-accent)]" />راهنمای تن‌خور</p>
            <ul className="mt-3 space-y-2 text-[12.5px] leading-6 text-[var(--kv-muted)]">
              <li>· برش این مدل آزاد است؛ اگر بین دو سایز هستی، کوچک‌تر را بردار.</li>
              <li>· قد مدل در عکس مرجع ۱۷۲ و سایز M است.</li>
              <li>· نتیجه شبیه‌سازی است و ۹۰٪ به واقعیت نزدیک است.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ================= AUTH ================= */
export function AuthScreens({ portal, onDone }: { portal: string; onDone: (phone: string) => void }) {
  const [mode, setMode] = useState<"login" | "otp" | "activate">("login");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [activate, setActivate] = useState({ token: "", password: "", confirm: "" });
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);

  const submitActivation = async () => {
    if (!activate.token.trim()) { setError("توکن فعال‌سازی را وارد کنید."); return; }
    if (activate.password.length < 8) { setError("گذرواژه دست‌کم ۸ نویسه باشد."); return; }
    if (activate.password !== activate.confirm) { setError("تکرار گذرواژه مطابقت ندارد."); return; }
    setActivating(true); setError("");
    try {
      await authApi.setPassword({ token: activate.token.trim(), newPassword: activate.password });
      setActivated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "فعال‌سازی ناموفق بود.");
    } finally { setActivating(false); }
  };
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
            <button onClick={() => { setMode("activate"); setError(""); setActivated(false); }} className="w-full text-center text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline">حساب منتقل‌شده از فروشگاه قبلی دارم (فعال‌سازی با توکن)</button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--kv-muted)]"><Lock size={12} />نسخه آزمایشی: پیامک واقعی ارسال نمی‌شود.</p>
          </div>
        ) : mode === "activate" ? (
          <div className="space-y-4">
            <p className="text-center text-[13px] leading-7 text-[var(--kv-muted)]">توکن یک‌بارمصرفی که پس از مهاجرت حساب دریافت کرده‌اید وارد کنید و گذرواژه جدید بسازید.</p>
            {activated ? (
              <p role="status" className="rounded-[10px] bg-emerald-500/10 px-4 py-3 text-center text-[13px] font-bold text-emerald-700 dark:text-emerald-400">حساب شما فعال شد — حالا با شماره همراه وارد شوید.</p>
            ) : (
              <>
                <Field label="توکن فعال‌سازی"><Input placeholder="مثلاً ۹f3a…" value={activate.token} onChange={(v) => { setActivate({ ...activate, token: v }); setError(""); }} /></Field>
                <Field label="گذرواژه جدید (دست‌کم ۸ نویسه)"><Input type="password" value={activate.password} onChange={(v) => { setActivate({ ...activate, password: v }); setError(""); }} /></Field>
                <Field label="تکرار گذرواژه جدید"><Input type="password" value={activate.confirm} onChange={(v) => { setActivate({ ...activate, confirm: v }); setError(""); }} /></Field>
                {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
                <Btn variant={portal === "admin" ? "dark" : "accent"} className="w-full" size="lg" disabled={activating} onClick={() => void submitActivation()}>{activating ? "در حال فعال‌سازی…" : "فعال‌سازی حساب"}</Btn>
              </>
            )}
            {!activated && error === "" && null}
            <button onClick={() => { setMode("login"); setError(""); }} className="flex w-full items-center justify-center gap-1 text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"><ChevronLeft size={14} className="rotate-180" />بازگشت به ورود</button>
          </div>
          ) : (
          <div className="space-y-4">
            <p className="text-center text-[13px] text-[var(--kv-muted)]">شماره همراه: <b className="text-[var(--kv-ink)] tabular-nums" dir="ltr">{digitsOnly(phone)}</b></p>
            <Field label="کد آزمایشی (۱۲۳۴۵)"><input inputMode="numeric" autoComplete="one-time-code" maxLength={5} value={code} onChange={(e) => { setCode(digitsOnly(e.target.value)); setError(""); }} className="h-12 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-4 text-center text-lg font-bold tracking-[0.3em] text-[var(--kv-ink)] outline-none focus:border-[var(--kv-accent)]" dir="ltr" /></Field>
            {error && <p role="alert" className="text-[12px] text-[var(--kv-danger)]">{error}</p>}
            <Btn variant={portal === "admin" ? "dark" : "accent"} className="w-full" size="lg" onClick={() => { if (code !== "12345") { setError("کد آزمایشی ۱۲۳۴۵ است."); return; } onDone(digitsOnly(phone)); }}>ورود به حساب</Btn>
            <button onClick={() => setMode("login")} className="flex w-full items-center justify-center gap-1 text-[13px] font-semibold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"><ChevronLeft size={14} className="rotate-180" />تغییر شماره</button>
          </div>
          )
        }
      </Card>
      <p className="mt-5 text-center text-xs leading-6 text-[var(--kv-muted)]">با ورود، <b>قوانین استفاده</b> و <b>حریم خصوصی</b> کلبه را می‌پذیرید.</p>
    </div>
  );
}

export default function StudioExperience({ tab, setTab, accountId, onLogin }: { tab: string; setTab: (t: string) => void; accountId?: string; onLogin: () => void }) {
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
      {tab === "builder" ? <StyleCanvas accountId={accountId} onLogin={onLogin} /> : <TryOn />}
    </div>
  );
}
