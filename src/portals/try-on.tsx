/* KOLBE — Virtual Try-On (Phase 1, Non-Core workstream)
 *
 * Answers: «این محصول روی من چطور به نظر می‌رسد؟» — a different customer job
 * from the Style Builder (which answers what products work together). It has
 * its own surface and is entered from eligible retail Product Cards and PDPs.
 *
 * Provider honesty (§8): the pipeline is Product → Try-On → authentication →
 * quota/credit verification → provider → result. No real provider integration
 * exists in this repository, so after the shopper picks an eligible product
 * and prepares their photo, the flow states plainly that the service is not
 * connected yet. It NEVER fabricates a "result" image, never simulates
 * processing, and implements no client-side quota — those belong to the
 * server side of the boundary in `data/styling.ts` when a provider lands.
 *
 * The photo upload is real: a local file, previewed only, never stored or
 * transmitted anywhere (there is no endpoint to send it to).
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, PersonStanding, Plug, ScanFace, Upload, X } from "lucide-react";
import { fmtMoney, type Product } from "../data/catalog";
import { TRYON_PROVIDER, tryOnEligible } from "../data/styling";
import { Btn, Card } from "../components/primitives";
import { cn } from "../utils/cn";

export default function TryOn({ initialProductId, catalogue, onOpenProduct }: {
  /** presentation context: opened from a card/PDP on this product */
  initialProductId?: string;
  /** published retail products — eligibility is business logic, not CSS */
  catalogue: Product[];
  /** jump to a product's PDP */
  onOpenProduct?: (id: string) => void;
}) {
  const eligible = catalogue.filter(tryOnEligible);
  const [product, setProduct] = useState<Product | undefined>(
    () => catalogue.find((p) => p.id === initialProductId && tryOnEligible(p)) ?? eligible[0],
  );
  /* arriving with a product skips the picker — the shopper already chose (§6) */
  const [step, setStep] = useState<"product" | "photo" | "provider">(
    initialProductId && catalogue.some((p) => p.id === initialProductId && tryOnEligible(p)) ? "photo" : "product",
  );
  const [photo, setPhoto] = useState<{ url: string; name: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const objectUrl = useRef<string | null>(null);

  /* revoke the object URL when replaced/unmounted — nothing leaks, nothing persists */
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const onFile = (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    const url = URL.createObjectURL(file);
    objectUrl.current = url;
    setPhoto({ url, name: file.name });
  };

  const steps = [
    { id: "product", label: "انتخاب محصول" },
    { id: "photo", label: "آماده‌سازی عکس" },
    { id: "provider", label: "سرویس پرو" },
  ] as const;
  const stepIndex = steps.findIndex((s) => s.id === step);

  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pb-16 pt-6 md:px-8">
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><ScanFace size={14} />پرو مجازی کلبه</p>
      <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">قبل از خرید، تن‌خور را ببین</h1>

      <div className="mt-6 flex items-center gap-1 overflow-x-auto kv-no-scrollbar" role="tablist" aria-label="گام‌های پرو مجازی">
        {steps.map((s, i) => (
          <div key={s.id} className="flex flex-1 items-center gap-2">
            <button role="tab" aria-selected={step === s.id} onClick={() => { if (i < stepIndex) setStep(s.id); }}
              className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all",
                stepIndex >= i ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]")}>
              {stepIndex > i ? <Check size={15} /> : i + 1}
            </button>
            <span className={cn("whitespace-nowrap text-[12.5px] font-bold", stepIndex >= i ? "" : "text-[var(--kv-muted)]")}>{s.label}</span>
            {i < steps.length - 1 && <span className="mx-2 h-px min-w-4 flex-1 bg-[var(--kv-line)]" />}
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card className="min-h-[320px] p-6">
          {step === "product" && (
            <div>
              <p className="mb-3 text-sm font-bold">کدام محصول را می‌خواهی پرو کنی؟</p>
              {eligible.length === 0 ? (
                <p className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-4 text-[13px] leading-7 text-[var(--kv-muted)]">
                  فعلاً محصولی برای پرو مجازی آماده نیست.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                    {eligible.slice(0, 9).map((p) => (
                      <button key={p.id} onClick={() => { setProduct(p); }} aria-pressed={product?.id === p.id}
                        className={cn("kv-press overflow-hidden rounded-[14px] border text-right transition-all", product?.id === p.id ? "border-[var(--kv-accent)] ring-2 ring-[var(--kv-accent)]/20" : "border-[var(--kv-line)]")}>
                        <img src={p.images[0]} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover" />
                        <p className="truncate p-2 text-[12px] font-bold">{p.name}</p>
                      </button>
                    ))}
                  </div>
                  <Btn variant="accent" className="mt-4" disabled={!product} onClick={() => setStep("photo")} icon={<ArrowLeft size={16} />}>
                    ادامه با {product?.name ?? "…"}
                  </Btn>
                </>
              )}
            </div>
          )}

          {step === "photo" && product && (
            <div>
              <p className="mb-3 text-sm font-bold">یک عکس تمام‌قد آماده کن</p>
              {!photo ? (
                <button onClick={() => fileRef.current?.click()}
                  className="flex w-full flex-col items-center gap-2.5 rounded-[16px] border border-dashed border-[var(--kv-line-strong)] py-14 text-[13.5px] font-bold text-[var(--kv-muted)] hover:border-[var(--kv-accent)] hover:text-[var(--kv-accent)]">
                  <Upload size={24} />انتخاب عکس از دستگاه
                  <span className="max-w-[40ch] text-xs font-normal leading-6">بهترین نتیجه: نور طبیعی، پس‌زمینه ساده، ایستاده و روبه‌رو. عکس شما فقط روی همین دستگاه پیش‌نمایش می‌شود؛ جایی ارسال یا ذخیره نمی‌شود.</span>
                </button>
              ) : (
                <div className="flex flex-col gap-4 sm:flex-row">
                  <img src={photo.url} alt="پیش‌نمایش عکس شما" className="h-64 w-48 rounded-[14px] border border-[var(--kv-line)] object-cover" />
                  <div className="flex flex-col justify-center gap-2.5">
                    <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-success)]"><Check size={15} />عکس آماده است</p>
                    <p className="max-w-[36ch] text-[12px] leading-6 text-[var(--kv-muted)]">{photo.name}</p>
                    <Btn variant="soft" size="sm" icon={<X size={14} />} onClick={() => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; setPhoto(null); }}>عکس دیگر</Btn>
                    <Btn variant="accent" size="sm" onClick={() => setStep("provider")} icon={<ArrowLeft size={15} />}>ادامه</Btn>
                  </div>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-label="انتخاب عکس تمام‌قد"
                onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
              <div className="mt-4 flex gap-2">
                <Btn variant="soft" size="sm" onClick={() => setStep("product")} icon={<ArrowRight size={15} />}>محصول دیگر</Btn>
              </div>
            </div>
          )}

          {step === "provider" && product && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--kv-surface-2)] text-[var(--kv-muted)]"><Plug size={26} /></span>
              <p className="mt-4 text-[15px] font-extrabold">سرویس پرو مجازی هنوز به کلبه وصل نیست</p>
              <p className="mt-2 max-w-[46ch] text-[13px] leading-7 text-[var(--kv-muted)]">
                انتخاب محصول و عکس شما آماده شد، اما «{TRYON_PROVIDER.label}» به سرویس‌دهنده‌ای نیاز دارد که هنوز به فروشگاه متصل نشده است.
                به همین دلیل نتیجه‌ای نمایش داده نمی‌شود — ما نتیجهٔ پرو را شبیه‌سازی نمی‌کنیم.
                وقتی سرویس متصل شد، همین مسیر با بررسی حساب و سهمیهٔ پرو (سمت سرور) ادامه پیدا می‌کند.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2.5">
                <Btn variant="soft" size="sm" icon={<ArrowRight size={15} />} onClick={() => setStep("photo")}>بازگشت به عکس</Btn>
                <Btn variant="soft" size="sm" onClick={() => setStep("product")}>محصول دیگر</Btn>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <p className="text-sm font-bold">محصول انتخاب‌شده</p>
            {product ? (
              <div className="mt-3 flex gap-3">
                <img src={product.images[0]} alt="" className="h-20 w-16 rounded-[10px] object-cover" />
                <div>
                  {onOpenProduct ? (
                    <button onClick={() => onOpenProduct(product.id)} className="text-start text-[13.5px] font-bold hover:text-[var(--kv-accent)]">{product.name}</button>
                  ) : (
                    <p className="text-[13.5px] font-bold">{product.name}</p>
                  )}
                  <p className="mt-1 text-[13px] font-extrabold tabular-nums">{fmtMoney(product.retailPrice)}</p>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[12.5px] text-[var(--kv-muted)]">هنوز محصولی انتخاب نشده است.</p>
            )}
          </Card>
          <Card className="p-5">
            <p className="flex items-center gap-1.5 text-sm font-bold"><PersonStanding size={16} className="text-[var(--kv-accent)]" />راهنمای تن‌خور</p>
            <ul className="mt-3 space-y-2 text-[12.5px] leading-6 text-[var(--kv-muted)]">
              <li>· پرو مجازی فقط برای محصولاتی فعال است که کلبه آن را پشتیبانی می‌کند.</li>
              <li>· بهترین نتیجه با عکس تمام‌قد، رو به دوربین و در نور یکنواخت به دست می‌آید.</li>
              <li>· عکس شما پردازش یا ذخیره نمی‌شود؛ تا وصل‌شدن سرویس، همین‌طور روی دستگاه شما می‌ماند.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
