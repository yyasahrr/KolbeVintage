import { useEffect, useMemo, useRef, useState } from "react";
import { Star, ThumbsUp } from "lucide-react";
import { fmtNum, fmtMoney } from "../data/catalog";
import { formatPersianDate } from "../data/persian-date";
import { recommendationsApi, reviewsApi, videoApi } from "../data/api";
import { Btn, Card, Empty, Field, Input, LoadingState, Select, Status, Textarea } from "./primitives";

const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));

export const StarRow = ({ value, size = 14 }: { value: number; size?: number }) => (
  <span className="inline-flex items-center gap-0.5" title={`${value} از ۵`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <Star key={n} size={size}
        className={n <= Math.round(value) ? "fill-[#D6A94E] text-[#D6A94E]" : "text-[var(--kv-line)]"} />
    ))}
  </span>
);

/* ---------------------------------------------------------------------------------------
 * 313-314 — responsive product video: real poster, lazy loading (the source is only
 * attached when the player scrolls into view), adaptive sizing, muted optional preview
 * and full controls, plus analytics events play / 25 / 50 / 75 / complete.
 * ------------------------------------------------------------------------------------- */
export function ProductVideo({ productId, title, preview = true }: { productId: string; title: string; preview?: boolean }) {
  const [media, setMedia] = useState<{ url: string; posterUrl: string | null } | null>(null);
  const [inView, setInView] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sent = useRef<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!uuid(productId)) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await videoApi.productMedia(productId);
        const item = response.items.find((row) => String(row.role) === "video" || String(row.mimeType ?? "").startsWith("video/"));
        if (!cancelled && item?.url) setMedia({ url: String(item.url), posterUrl: item.posterUrl ? String(item.posterUrl) : null });
      } catch { /* a product without media simply renders nothing */ }
    })();
    return () => { cancelled = true; };
  }, [productId]);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || !media) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setInView(true);
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [media]);

  const track = (eventType: string, positionSeconds?: number) => {
    if (sent.current.has(eventType)) return;
    sent.current.add(eventType);
    void videoApi.track({
      events: [{ videoId: media?.url ?? productId, productId, eventType, surface: "product", source: "web",
        positionSeconds: positionSeconds ?? undefined, clientEventId: crypto.randomUUID() }],
    }).catch(() => undefined);
  };

  if (!media) return null;

  return (
    <div ref={wrapRef} className="overflow-hidden rounded-[18px] border border-[var(--kv-line)]">
      <video
        ref={videoRef}
        className="aspect-video w-full bg-black/5 object-cover"
        poster={media.posterUrl ?? undefined}
        src={inView ? media.url : undefined}
        controls
        playsInline
        muted={preview}
        preload={inView ? "metadata" : "none"}
        aria-label={`ویدیو ${title}`}
        onPlay={() => track("play", videoRef.current?.currentTime)}
        onTimeUpdate={() => {
          const node = videoRef.current;
          if (!node?.duration) return;
          const percent = (node.currentTime / node.duration) * 100;
          if (percent >= 25) track("25", node.currentTime);
          if (percent >= 50) track("50", node.currentTime);
          if (percent >= 75) track("75", node.currentTime);
        }}
        onEnded={() => track("complete", videoRef.current?.duration)}
        onError={() => track("error")}
      />
      <p className="border-t border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 px-3 py-2 text-[11.5px] text-[var(--kv-muted)]">
        ویدیو با پوستر و بارگذاری تنبل بارگذاری می‌شود؛ رویدادهای پخش و ۲۵٪ تا پایان برای تحلیل و CRM ثبت می‌شوند.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------
 * 105-109 — customer-facing reviews: real verified-purchase reviews, rating summary and a
 * submission form (what the customer writes is moderated before it becomes public).
 * ------------------------------------------------------------------------------------- */
export function ProductReviewsBlock({ productId, canReview, orderId }: { productId: string; canReview: boolean; orderId?: string | null }) {
  const [data, setData] = useState<{ items: Record<string, unknown>[]; summary: Record<string, unknown> } | null>(null);
  const [form, setForm] = useState({ rating: 5, title: "", comment: "" });
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = async () => {
    if (!uuid(productId)) return;
    try { setData(await reviewsApi.publicProductReviews(productId, { limit: 20 })); } catch { setData(null); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [productId]);

  const summary = data?.summary ?? {};
  const distribution = useMemo(() => (Array.isArray(summary.distribution)
    ? (summary.distribution as { star: number; count: number }[]) : []), [summary.distribution]);

  if (!data) return null;

  const submit = async () => {
    try {
      const result = await reviewsApi.submit(productId, {
        rating: form.rating, title: form.title || undefined, comment: form.comment || undefined, orderId: orderId ?? null,
      });
      setMessage(`نظر شما ثبت شد${result.verifiedPurchase ? " و به‌عنوان خرید تأییدشده علامت خورد" : ""}؛ پس از بازبینی نمایش داده می‌شود.`);
      setForm({ rating: 5, title: "", comment: "" });
      await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : "ثبت نظر انجام نشد."); }
  };

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="kv-editorial-title text-[22px]">دیدگاه خریداران</h2>
        {canReview && <Btn variant="soft" size="sm" onClick={() => setExpanded((v) => !v)}>{expanded ? "بستن فرم" : "ثبت دیدگاه"}</Btn>}
      </div>
      <div className="mt-4 grid gap-5 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit p-4">
          <p className="flex items-center gap-2 text-[26px] font-extrabold tabular-nums">
            {text(summary.averageRating, "—")} <StarRow value={Number(summary.averageRating ?? 0)} size={16} />
          </p>
          <p className="text-[12px] text-[var(--kv-muted)]">{num(summary.reviewCount)} دیدگاه · {num(summary.verifiedCount)} خرید تأییدشده</p>
          <div className="mt-3 space-y-1.5">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = Number(distribution.find((row) => row.star === star)?.count ?? 0);
              const percent = Number(summary.reviewCount) ? (count / Number(summary.reviewCount)) * 100 : 0;
              return (
                <div key={star} className="flex items-center gap-2 text-[11.5px]">
                  <span className="w-7 text-[var(--kv-muted)]">{star} ★</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--kv-surface-2)]">
                    <span className="block h-full rounded-full bg-[#D6A94E]" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="w-8 text-left tabular-nums">{num(count)}</span>
                </div>
              );
            })}
          </div>
        </Card>
        <div className="space-y-3">
          {expanded && canReview && (
            <Card className="p-4">
              <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                <Field label="امتیاز">
                  <Select options={["5", "4", "3", "2", "1"]} value={String(form.rating)} onChange={(v) => setForm({ ...form, rating: Number(v) })} />
                </Field>
                <Field label="عنوان"><Input value={form.title} onChange={(v) => setForm({ ...form, title: v })} /></Field>
              </div>
              <Field label="متن دیدگاه"><Textarea rows={3} value={form.comment} onChange={(v) => setForm({ ...form, comment: v })} /></Field>
              <Btn variant="accent" size="sm" className="mt-2" disabled={form.comment.trim().length < 3} onClick={() => void submit()}>ثبت دیدگاه</Btn>
            </Card>
          )}
          {message ? <p className="text-[12.5px] text-[var(--kv-accent)]">{message}</p> : null}
          {data.items.map((review) => (
            <div key={String(review.id)} className="border-b border-dashed border-[var(--kv-line)] pb-3">
              <p className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <StarRow value={Number(review.rating ?? 0)} />
                <b>{text(review.title, "بدون عنوان")}</b>
                {review.verified_purchase ? <Status value="خرید تأییدشده" /> : null}
                <span className="text-[var(--kv-muted)]">{text(review.author_name)} · {review.created_at ? formatPersianDate(String(review.created_at)) : ""}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-6">{text(review.comment, "")}</p>
              <button className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"
                onClick={() => void reviewsApi.markHelpful(String(review.id)).then(() => load()).catch(() => undefined)}>
                <ThumbsUp size={12} /> مفید بود ({num(review.helpful_count)})
              </button>
            </div>
          ))}
          {!data.items.length && <Empty title="هنوز دیدگاهی ثبت نشده" desc="اولین دیدگاه را خریداران همین محصول می‌نویسند؛ دیدگاه‌ها پس از بازبینی منتشر می‌شوند." />}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------
 * 110-121 — server-owned recommendation slot rendered in the storefront. Impressions are
 * recorded by the API itself; clicks and add-to-cart are reported back as events.
 * ------------------------------------------------------------------------------------- */
export function RecommendationStrip({
  slot, title, productId, limit = 4, onOpen, onAdd, localProducts,
}: {
  slot: string; title: string; productId?: string; limit?: number;
  onOpen: (id: string) => void;
  onAdd?: (item: { id: string; name: string; price: number }) => void;
  /** Local catalog used only to keep ids resolvable in the demo catalog. */
  localProducts?: { id: string; name: string; retailPrice: number; images: string[] }[];
}) {
  const [state, setState] = useState<{ items: { id: string; name: string; cashPriceRial: string; availableStock: number; rating: number | null; position: number }[]; strategy: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionId = useMemo(() => {
    const key = "kv-rec-session";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await recommendationsApi.slot({ slot, limit, productId: productId && uuid(productId) ? productId : undefined, sessionId });
        if (!cancelled) setState(response as unknown as typeof state);
      } catch { if (!cancelled) setState(null); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [slot, productId, limit, sessionId]);

  const track = (eventType: "clicked" | "added_to_cart", item: { id: string; position: number }) => {
    void recommendationsApi.track({
      sessionId,
      events: [{ slotCode: slot, strategy: state?.strategy ?? "unknown", eventType, productId: item.id, position: item.position }],
    }).catch(() => undefined);
  };

  const items = useMemo(() => {
    const list = state?.items ?? [];
    if (!list.length) return [];
    const byId = new Map((localProducts ?? []).map((product) => [product.id, product]));
    const hasLocal = (localProducts ?? []).length > 0;
    return list.filter((item) => !hasLocal || byId.has(item.id));
  }, [state, localProducts]);

  if (loading || !items.length) return null;

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-center gap-2">
        <h2 className="kv-editorial-title text-[22px]">{title}</h2>
        <span className="text-[11.5px] text-[var(--kv-muted)]">استراتژی سرور: {state?.strategy}</span>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {items.slice(0, limit).map((item) => {
          const local = localProducts?.find((product) => product.id === item.id);
          return (
            <Card key={item.id} hover className="group overflow-hidden">
              <button className="block w-full text-right" onClick={() => { track("clicked", item); onOpen(item.id); }}>
                {local?.images?.[0]
                  ? <img src={local.images[0]} alt={item.name} loading="lazy" className="aspect-[3/4] w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
                  : <div className="aspect-[3/4] w-full bg-[var(--kv-surface-2)]" />}
                <div className="p-3">
                  <p className="line-clamp-1 text-[13px] font-bold">{item.name}</p>
                  <p className="mt-1 text-[13px] font-extrabold tabular-nums">{fmtMoney(Number(item.cashPriceRial))}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--kv-muted)]">
                    {item.rating ? <StarRow value={item.rating} size={11} /> : null}
                    {item.availableStock > 0 ? `موجود (${num(item.availableStock)})` : "ناموجود"}
                  </p>
                </div>
              </button>
              {onAdd && local && (
                <div className="px-3 pb-3">
                  <Btn variant="soft" size="sm" className="w-full"
                    onClick={() => { track("added_to_cart", item); onAdd({ id: local.id, name: local.name, price: local.retailPrice }); }}>
                    افزودن به سبد
                  </Btn>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/** Loading placeholder kept separate so the strip never shifts the layout. */
export const RecommendationSkeleton = () => <div className="mt-10"><LoadingState label="در حال آوردن پیشنهادها…" /></div>;
