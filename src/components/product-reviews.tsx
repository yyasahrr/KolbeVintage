import { useEffect, useState } from "react";
import { BadgeCheck, Loader2, Star } from "lucide-react";
import { styleApi } from "../data/experience-api";
import { isAuthenticated } from "../data/api";
import { formatPersianDate } from "../data/persian-date";
import { Btn, Field, Input, Textarea } from "./primitives";
import { useToast } from "./toast";
import { cn } from "../utils/cn";

type ReviewData = Awaited<ReturnType<typeof styleApi.reviews>>;
const fa = (n: number) => n.toLocaleString("fa-IR");

export function StarInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label="امتیاز" className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${fa(n)} ستاره`} onClick={() => onChange(n)}
          className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--kv-surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--kv-accent)]">
          <Star size={22} fill={n <= value ? "#D6A94E" : "none"} strokeWidth={n <= value ? 0 : 1.5} />
        </button>
      ))}
    </div>
  );
}

/** Rating summary + verified reviews + submission (server: verified purchase detection & moderation). */
export function ProductReviews({ productId }: { productId: string }) {
  const [data, setData] = useState<ReviewData | null>(null);
  const [form, setForm] = useState({ rating: 5, title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = () => styleApi.reviews(productId).then(setData).catch(() => setData({ summary: { average: 0, total: 0, distribution: [] }, items: [] }));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [productId]);
  if (!data) return null;
  const submit = async () => {
    setBusy(true);
    try {
      const res = await styleApi.submitReview(productId, { rating: form.rating, title: form.title.trim(), body: form.body.trim() });
      toast.push(res.status === "approved" ? "دیدگاه شما (خرید تأییدشده) منتشر شد." : "دیدگاه ثبت شد و پس از بررسی منتشر می‌شود.");
      setForm({ rating: 5, title: "", body: "" });
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "ثبت دیدگاه ناموفق بود.", "error"); }
    finally { setBusy(false); }
  };
  const max = Math.max(1, ...data.summary.distribution.map((d) => d.n));
  return (
    <section className="mt-14 grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]" aria-labelledby={`reviews-${productId}`}>
      <div>
        <h2 id={`reviews-${productId}`} className="text-[19px] font-extrabold">امتیاز و دیدگاه‌ها</h2>
        <p className="mt-3 flex items-baseline gap-2"><b className="text-[36px] font-extrabold tabular-nums">{fa(data.summary.average)}</b><span className="text-[13px] text-[var(--kv-muted)]">از ۵ · {fa(data.summary.total)} دیدگاه</span></p>
        <div className="mt-3 space-y-1.5">
          {[5, 4, 3, 2, 1].map((r) => { const n = data.summary.distribution.find((d) => d.rating === r)?.n ?? 0; return (
            <div key={r} className="flex items-center gap-2 text-[12px]"><span className="w-4 tabular-nums">{fa(r)}</span><span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--kv-surface-2)]"><span className="block h-full rounded-full bg-[#D6A94E]" style={{ width: `${(n / max) * 100}%` }} /></span><span className="w-6 text-left tabular-nums text-[var(--kv-muted)]">{fa(n)}</span></div>
          ); })}
        </div>
        {isAuthenticated() ? (
          <div className="mt-6 space-y-3 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
            <p className="text-[13px] font-bold">دیدگاه شما</p>
            <StarInput value={form.rating} onChange={(rating) => setForm({ ...form, rating })} />
            <Field label="عنوان (اختیاری)"><Input value={form.title} onChange={(title) => setForm({ ...form, title })} /></Field>
            <Field label="متن دیدگاه"><Textarea rows={3} value={form.body} onChange={(body) => setForm({ ...form, body })} /></Field>
            <Btn variant="accent" size="sm" className="w-full" disabled={busy} onClick={submit} icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}>ثبت دیدگاه</Btn>
            <p className="text-[11px] leading-5 text-[var(--kv-muted)]">اگر این محصول را خریده باشید، دیدگاه با نشان «خرید تأییدشده» فوراً منتشر می‌شود.</p>
          </div>
        ) : <p className="mt-6 text-[12.5px] text-[var(--kv-muted)]">برای ثبت دیدگاه وارد حساب شوید.</p>}
      </div>
      <div className="divide-y divide-[var(--kv-line)] border-y border-[var(--kv-line)]">
        {data.items.length === 0 && <p className="py-8 text-center text-[13px] text-[var(--kv-muted)]">هنوز دیدگاهی برای این محصول ثبت نشده است.</p>}
        {data.items.map((r) => (
          <article key={r.id} className="py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex" aria-label={`${fa(r.rating)} از ۵`}>{Array.from({ length: 5 }, (_, i) => <Star key={i} size={13} fill={i < r.rating ? "#D6A94E" : "none"} strokeWidth={i < r.rating ? 0 : 1.5} />)}</span>
              <b className="text-[13px]">{r.display_name}</b>
              {r.verified_purchase && <span className="inline-flex items-center gap-1 rounded-full bg-[#E7F0E6] px-2 py-0.5 text-[10.5px] font-bold text-[#3E6B4A]"><BadgeCheck size={11} />خرید تأییدشده</span>}
              <span className="text-[11.5px] text-[var(--kv-muted)]">{formatPersianDate(r.created_at)}</span>
            </div>
            {r.title && <p className="mt-2 text-[13.5px] font-bold">{r.title}</p>}
            {r.body && <p className={cn("mt-1 text-[13px] leading-7 text-[var(--kv-ink-2)]")}>{r.body}</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
