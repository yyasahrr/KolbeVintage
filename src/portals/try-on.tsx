import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, Download, Eye, Loader2, RotateCcw, Shirt, Sparkles, Upload, Wand2 } from "lucide-react";
import { Btn, Card } from "../components/primitives";
import { fmtMoney } from "../data/catalog";
import { apiClient, catalogApi, isAuthenticated, type CatalogItem } from "../data/api";
import { cn } from "../utils/cn";

type TryOnJob = { jobToken?: string; status: "processing" | "ready" | "failed"; percent: number | null; outputUrl: string | null; message: string | null };
type TryOnProduct = CatalogItem & { image: string };

function productImage(item: CatalogItem): string | null {
  const images = item.metadata?.images;
  const first = Array.isArray(images) ? images[0] : null;
  const url = typeof first === "string" ? first : first && typeof first.url === "string" ? first.url : null;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

export function TryOn({ onLogin }: { onLogin: () => void }) {
  const [products, setProducts] = useState<TryOnProduct[]>([]);
  const [productId, setProductId] = useState("");
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [step, setStep] = useState(0);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [consent, setConsent] = useState(false);
  const [jobToken, setJobToken] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const [resultUrl, setResultUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const product = products.find((item) => item.id === productId);

  useEffect(() => {
    let live = true;
    setLoadingProducts(true);
    catalogApi.list({ limit: 60 }).then(({ items }) => {
      if (!live) return;
      const available = items.flatMap((item) => { const image = productImage(item); return image ? [{ ...item, image }] : []; });
      setProducts(available);
      setProductId((current) => current && available.some((item) => item.id === current) ? current : available[0]?.id ?? "");
      setError("");
    }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "بارگذاری محصولات ناموفق بود."); })
      .finally(() => { if (live) setLoadingProducts(false); });
    return () => { live = false; };
  }, [catalogRetry]);

  useEffect(() => {
    if (!photo) { setPreview(""); return; }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    if (step !== 2 || !jobToken) return;
    let live = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const job = await apiClient.post<TryOnJob>("/tryon/jobs/status", { token: jobToken });
        if (!live) return;
        setPercent(job.percent);
        setError("");
        if (job.status === "ready") {
          if (!job.outputUrl) throw new Error("تصویر خروجی از سرویس دریافت نشد.");
          setResultUrl(job.outputUrl);
          setStep(3);
        } else if (job.status === "failed") {
          setError(job.message || "ساخت تصویر ناموفق بود. دوباره تلاش کنید.");
          setStep(1);
        }
      } catch (cause) { if (live) setError(cause instanceof Error ? cause.message : "پیگیری وضعیت ناموفق بود."); }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => void check(), 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [jobToken, step]);

  const choosePhoto = (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setError("فرمت عکس باید JPG، PNG یا WebP باشد."); return; }
    if (file.size > 5 * 1024 * 1024) { setError("حجم عکس نباید بیش از ۵ مگابایت باشد."); return; }
    setPhoto(file);
    setError("");
  };

  const start = async () => {
    if (!product || !photo || !consent) { setError("محصول، عکس و تأیید ارسال عکس را بررسی کنید."); return; }
    if (!isAuthenticated()) { onLogin(); return; }
    const form = new FormData();
    form.append("productId", product.id);
    form.append("photo", photo, photo.name);
    setError(""); setBusy(true); setStep(2); setPercent(null); setResultUrl(""); setJobToken("");
    try {
      const job = await apiClient.upload<TryOnJob>("/tryon/jobs", form);
      if (job.status === "ready" && job.outputUrl) { setResultUrl(job.outputUrl); setStep(3); }
      else if (job.status === "processing" && job.jobToken) { setJobToken(job.jobToken); setPercent(job.percent); }
      else throw new Error(job.message || "پاسخ سرویس پرو مجازی معتبر نبود.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "شروع پرو مجازی ناموفق بود.");
      setStep(1);
    } finally { setBusy(false); }
  };

  const reset = () => { setStep(0); setJobToken(""); setPercent(null); setResultUrl(""); setError(""); };
  const steps = [{ label: "انتخاب محصول", icon: Shirt }, { label: "عکس شما", icon: Camera }, { label: "پردازش", icon: Wand2 }, { label: "نتیجه", icon: Eye }];

  return <div className="mx-auto w-full max-w-[1040px] px-4 pb-16 pt-6 md:px-8">
    <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Wand2 size={14} />پرو مجازی کلبه</p>
    <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">لباس را روی عکس خودت ببین</h1>
    <p className="mt-2 max-w-[62ch] text-[13px] leading-7 text-[var(--kv-muted)]">یک محصول و عکس واضح از خودت انتخاب کن. تصویر با هوش مصنوعی ساخته می‌شود و ممکن است با تن‌خور واقعی تفاوت داشته باشد.</p>

    <ol className="mt-6 flex gap-2 overflow-x-auto kv-no-scrollbar" aria-label="مراحل پرو مجازی">
      {steps.map(({ label, icon: Icon }, index) => <li key={label} className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap text-xs font-bold">
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", step >= index ? "bg-[var(--kv-action)] text-white" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
          {step > index ? <Check size={15} /> : <Icon size={15} />}</span><span className={step >= index ? "" : "text-[var(--kv-muted)]"}>{label}</span>
      </li>)}
    </ol>

    {error && <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
    <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="min-h-[380px] p-5 md:p-6">
        {step === 0 && <div>
          <h2 className="mb-4 text-sm font-bold">کدام محصول را می‌خواهی پرو کنی؟</h2>
          {loadingProducts ? <p role="status" className="text-sm text-[var(--kv-muted)]">در حال بارگذاری محصولات…</p> : products.length === 0 ?
            <div className="text-sm text-[var(--kv-muted)]">محصول عکس‌دار در دسترس نیست. <button className="mr-2 font-bold text-[var(--kv-accent)] underline" onClick={() => setCatalogRetry((n) => n + 1)}>تلاش دوباره</button></div> :
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{products.map((item) => <button key={item.id} type="button" onClick={() => setProductId(item.id)} aria-pressed={item.id === productId}
              className={cn("overflow-hidden rounded-lg border text-right transition-colors", item.id === productId ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.04]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]") }>
              <img src={item.image} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover"/><span className="block truncate px-2.5 py-2 text-xs font-bold">{item.name}</span></button>)}</div>}
          <Btn variant="accent" className="mt-5" disabled={!product} onClick={() => setStep(1)} icon={<ArrowLeft size={16}/>}>ادامه</Btn>
        </div>}

        {step === 1 && <div>
          <h2 className="text-sm font-bold">عکس تمام‌قد یا نیم‌تنهٔ واضح انتخاب کن</h2>
          <p className="mt-1 text-xs leading-6 text-[var(--kv-muted)]">نور مناسب، روبه‌روی دوربین و پس‌زمینهٔ ساده نتیجه را بهتر می‌کند. JPG، PNG یا WebP تا ۵ مگابایت.</p>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="انتخاب عکس شخص" onChange={(event) => { choosePhoto(event.target.files?.[0]); event.target.value = ""; }}/>
          {preview ? <div className="mt-5 flex flex-wrap items-center gap-4"><img src={preview} alt="پیش‌نمایش عکس انتخاب‌شده" className="h-56 w-44 rounded-lg object-cover"/><Btn variant="soft" size="sm" onClick={() => fileInput.current?.click()} icon={<RotateCcw size={15}/>}>تعویض عکس</Btn></div> :
            <button type="button" onClick={() => fileInput.current?.click()} className="mt-5 flex min-h-48 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--kv-line-strong)] text-sm font-bold text-[var(--kv-muted)] hover:border-[var(--kv-accent)] hover:text-[var(--kv-accent)]"><Upload size={23}/>انتخاب عکس از دستگاه</button>}
          <label className="mt-5 flex cursor-pointer items-start gap-2 text-xs leading-6 text-[var(--kv-muted)]"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 accent-[var(--kv-accent)]"/><span>موافقم عکس من و تصویر محصول برای پردازش به سرویس آلفا فرستاده شود. کلبه عکس من را در پایگاه‌داده ذخیره نمی‌کند.</span></label>
          <div className="mt-5 flex flex-wrap gap-2"><Btn variant="accent" disabled={!photo || !consent || busy} onClick={() => void start()} icon={<Wand2 size={15}/>}>{isAuthenticated() ? "شروع پرو مجازی" : "ورود و شروع پرو مجازی"}</Btn><Btn variant="soft" onClick={() => setStep(0)}>بازگشت</Btn></div>
        </div>}

        {step === 2 && <div className="flex min-h-[320px] flex-col items-center justify-center text-center" role="status" aria-live="polite">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--kv-accent)]/10 text-[var(--kv-accent)]"><Loader2 size={24} className="animate-spin"/></span>
          <h2 className="mt-4 text-base font-bold">{busy ? "در حال فرستادن عکس…" : "در حال ساخت تصویر شما…"}</h2>
          <p className="mt-2 text-xs leading-6 text-[var(--kv-muted)]">پردازش ممکن است چند دقیقه طول بکشد. این صفحه را باز نگه دار.</p>
          {percent !== null ? <div className="mt-5 w-full max-w-xs"><div className="h-2 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><div className="h-full bg-[var(--kv-accent)] transition-[width]" style={{ width: `${percent}%` }}/></div><p className="mt-2 text-xs tabular-nums">{percent.toLocaleString("fa-IR")}٪</p></div> : <p className="mt-5 text-xs text-[var(--kv-muted)]">در انتظار گزارش پیشرفت از سرویس…</p>}
        </div>}

        {step === 3 && resultUrl && <div>
          <h2 className="flex items-center gap-2 text-sm font-bold"><Sparkles size={16} className="text-[var(--kv-accent)]"/>نتیجهٔ پرو مجازی</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2"><div><p className="mb-2 text-xs text-[var(--kv-muted)]">عکس شما</p><img src={preview} alt="عکس اصلی" className="aspect-[3/4] w-full rounded-lg object-cover"/></div><div><p className="mb-2 text-xs text-[var(--kv-muted)]">تصویر ساخته‌شده</p><img src={resultUrl} alt={`پرو مجازی ${product?.name ?? "محصول"}`} className="aspect-[3/4] w-full rounded-lg object-cover"/></div></div>
          <div className="mt-5 flex flex-wrap items-center gap-2"><a href={resultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-[var(--kv-action)] px-4 py-2 text-sm font-bold text-white"><Download size={15}/>باز کردن و ذخیرهٔ تصویر</a><Btn variant="soft" size="sm" onClick={reset} icon={<RotateCcw size={15}/>}>پرو محصول دیگر</Btn></div>
          <p className="mt-3 text-xs leading-6 text-[var(--kv-muted)]">نشانی خروجی ممکن است موقت باشد؛ اگر تصویر را می‌خواهی، همین حالا ذخیره‌اش کن.</p>
        </div>}
      </Card>
      <div className="space-y-4"><Card className="p-5"><h2 className="text-sm font-bold">محصول انتخاب‌شده</h2>{product ? <div className="mt-3 flex gap-3"><img src={product.image} alt="" className="h-20 w-16 rounded-lg object-cover"/><div className="min-w-0"><p className="text-sm font-bold">{product.name}</p><p className="mt-1 text-xs text-[var(--kv-muted)]">{fmtMoney(Number(product.cashPriceRial))}</p></div></div> : <p className="mt-3 text-xs text-[var(--kv-muted)]">محصولی انتخاب نشده است.</p>}</Card>
        <Card className="p-5"><h2 className="text-sm font-bold">دربارهٔ نتیجه</h2><p className="mt-2 text-xs leading-6 text-[var(--kv-muted)]">تصویر با مدل ویرایش تصویر آلفا ساخته می‌شود. رنگ، فرم و اندازه ممکن است دقیقاً با کالای واقعی یکی نباشد؛ برای انتخاب سایز از مشخصات محصول استفاده کن.</p></Card></div>
    </div>
  </div>;
}
