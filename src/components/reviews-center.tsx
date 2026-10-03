import { useCallback, useEffect, useState } from "react";
import { Flag, MessageSquareQuote, ShieldCheck, Star, ThumbsUp } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDateTime } from "../data/persian-date";
import { reviewsApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, LoadingState, Modal, Segmented, Select, Status, Textarea } from "./primitives";

const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));

export const Stars = ({ value }: { value: number }) => (
  <span className="inline-flex items-center gap-0.5" title={`${value} از ۵`}>
    {[1, 2, 3, 4, 5].map((n) => (
      <Star key={n} size={13} className={n <= Math.round(value) ? "fill-[var(--kv-accent)] text-[var(--kv-accent)]" : "text-[var(--kv-line)]"} />
    ))}
  </span>
);

type Tab = "moderation" | "reports" | "analytics";
const TABS: { v: Tab; label: string }[] = [
  { v: "moderation", label: "بازبینی نظرات" },
  { v: "reports", label: "گزارش‌های کاربران" },
  { v: "analytics", label: "تحلیل امتیازها" },
];

type StatusFilter = "pending" | "approved" | "rejected" | "hidden" | "all";

const REVIEW_STATUS_LABEL: Record<string, string> = {
  pending: "در انتظار تأیید", approved: "تأییدشده", rejected: "ردشده", hidden: "پنهان‌شده", all: "همه وضعیت‌ها",
};
const REPORT_STATUS_LABEL: Record<string, string> = { open: "باز", resolved: "رسیدگی‌شده", dismissed: "ردشده" };
type ProductStat = { id: string; name: string; review_count: number; average: string };

/** Review moderation + product rating analytics (items 105-109). Moderation only
 *  ever changes visibility; ratings are aggregated from real, approved reviews. */
export function ReviewsCenter({ flash }: { flash: (message: string) => void }) {
  const [tab, setTab] = useState<Tab>("moderation");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [reportedOnly, setReportedOnly] = useState<"false" | "true">("false");
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [reports, setReports] = useState<Record<string, unknown>[]>([]);
  const [overall, setOverall] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moderating, setModerating] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState("");
  const [action, setAction] = useState<"approve" | "reject" | "hide" | "restore">("approve");
  const [drill, setDrill] = useState<{ product: ProductStat; data: Record<string, unknown> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, reportList, stats] = await Promise.all([
        reviewsApi.adminList({ status: statusFilter, reported: reportedOnly, limit: 100 }),
        reviewsApi.reports(),
        reviewsApi.overallAnalytics(),
      ]);
      setItems(list.items); setReports(reportList.items); setOverall(stats);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری نظرات"); }
    finally { setLoading(false); }
  }, [statusFilter, reportedOnly]);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action2: () => Promise<unknown>) => {
    try { await action2(); flash(`${label} انجام شد`); setModerating(null); setNote(""); setDrill(null); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  const openDrill = async (product: ProductStat) => {
    try { setDrill({ product, data: await reviewsApi.productAnalytics(product.id) }); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در دریافت تحلیل محصول"); }
  };

  if (loading && !items.length && !overall) return <LoadingState label="در حال بارگذاری نظرات…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const totals = (overall?.totals ?? {}) as Record<string, string>;
  const topProducts = (overall?.topProducts ?? []) as unknown as ProductStat[];
  const lowRated = (overall?.lowRated ?? []) as unknown as { id: string; name: string; one_star: number; review_count: number }[];
  const openReports = reports.filter((report) => text(report.status) === "open");

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented options={TABS} value={tab} onChange={setTab} />
        {tab === "moderation" && (
          <div className="flex items-center gap-2">
            <Select options={["pending", "approved", "rejected", "hidden", "all"]} labels={REVIEW_STATUS_LABEL} value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)} />
            <Select options={["false", "true"]} labels={{ false: "همه نظرات", true: "فقط گزارش‌شده‌ها" }} value={reportedOnly} onChange={(v) => setReportedOnly(v as "false" | "true")} />
          </div>
        )}
      </Card>

      {tab === "moderation" && (
        <div className="space-y-3">
          {items.map((review) => (
            <Card key={String(review.id)} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-extrabold">
                    <Stars value={Number(review.rating ?? 0)} />
                    {text(review.title, "بدون عنوان")}
                    {review.verified_purchase ? <Status value="خرید تأییدشده" /> : <Status value="بدون تأیید خرید" />}
                    <Status value={REVIEW_STATUS_LABEL[String(review.status)] ?? text(review.status)} />
                  </p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {text(review.product_name)} · {text(review.customer_name)} · {text(review.customer_phone)} · {stamp(review.created_at)}
                    {Number(review.report_count ?? 0) > 0 ? ` · ${num(review.report_count)} گزارش` : ""}
                    {Number(review.helpful_count ?? 0) > 0 ? ` · ${num(review.helpful_count)} مفید` : ""}
                  </p>
                  <p className="mt-2 max-w-3xl whitespace-pre-wrap text-[12.5px]">{text(review.comment, "—")}</p>
                  {Array.isArray(review.images) && (review.images as string[]).length > 0 && (
                    <div className="mt-2 flex gap-2">
                      {(review.images as string[]).slice(0, 4).map((url) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer" className="text-[11.5px] text-[var(--kv-accent)] underline">تصویر</a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Btn variant="soft" size="sm" onClick={() => { setModerating(review); setAction("approve"); setNote(""); }}>بازبینی</Btn>
                </div>
              </div>
              {review.moderation_note ? <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">یادداشت بازبینی: {text(review.moderation_note)}</p> : null}
            </Card>
          ))}
          {!items.length && <Empty title="نظری در این وضعیت نیست" desc="امتیاز فقط توسط خریداران واقعی و پس از تأیید نمایش داده می‌شود." />}
        </div>
      )}

      {tab === "reports" && (
        <div className="space-y-3">
          {reports.map((report) => (
            <Card key={String(report.id)} className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-[13px] font-extrabold">
                    <Flag size={14} />گزارش {text(report.reason)}
                    <Status value={REPORT_STATUS_LABEL[String(report.status)] ?? text(report.status)} />
                  </p>
                  <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
                    {text(report.product_name)} · امتیاز {num(report.rating)} · گزارش‌دهنده {text(report.reporter_name)} · {stamp(report.created_at)}
                  </p>
                  {report.title || report.comment ? (
                    <p className="mt-2 text-[12.5px]">{text(report.title, "بدون عنوان")} — {text(report.comment, "—")}</p>
                  ) : null}
                </div>
                {report.status === "open" && (
                  <div className="flex gap-2">
                    <Btn variant="soft" size="sm" onClick={() => void run("بررسی گزارش", () => reviewsApi.resolveReport(String(report.id), "resolved"))}>رسیدگی شد</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => void run("رد گزارش", () => reviewsApi.resolveReport(String(report.id), "dismissed"))}>رد گزارش</Btn>
                  </div>
                )}
              </div>
            </Card>
          ))}
          {!reports.length && <Empty title="گزارشی ثبت نشده" desc="گزارش‌های کاربران روی نظرات در این صف بررسی می‌شوند." />}
          <p className="text-[11.5px] text-[var(--kv-muted)]">{num(openReports.length)} گزارش باز در انتظار رسیدگی است.</p>
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[["کل نظرات", num(totals.total)], ["در انتظار تأیید", num(totals.pending)], ["خرید تأییدشده", num(totals.verified)], ["میانگین امتیاز", text(totals.average, "—")]]
              .map(([label, value]) => (
                <Card key={label as string} className="p-4">
                  <p className="text-[11.5px] text-[var(--kv-muted)]">{label as string}</p>
                  <p className="mt-1 text-[20px] font-extrabold tabular-nums">{value}</p>
                </Card>
              ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Star size={15} />پرنظرترین محصولات</div>
              <div className="space-y-2">
                {topProducts.map((product) => (
                  <button key={product.id} onClick={() => void openDrill(product)}
                    className="flex w-full items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-2.5 text-right text-[12.5px] hover:bg-[var(--kv-surface-2)]">
                    <span className="font-semibold">{product.name}</span>
                    <span className="flex items-center gap-2 text-[var(--kv-muted)]"><Stars value={Number(product.average)} />{text(product.average)} · {num(product.review_count)} نظر</span>
                  </button>
                ))}
                {!topProducts.length && <Empty title="داده‌ای نیست" desc="پس از تأیید نظرات، آمار اینجا ساخته می‌شود." />}
              </div>
            </Card>
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><MessageSquareQuote size={15} />کم‌امتیازترین محصولات</div>
              <div className="space-y-2">
                {lowRated.map((product) => (
                  <div key={product.id} className="flex items-center justify-between gap-2 rounded-[11px] border border-dashed border-[var(--kv-line)] p-2.5 text-[12.5px]">
                    <span className="font-semibold">{product.name}</span>
                    <span className="text-[var(--kv-muted)]">{num(product.one_star)} نظر ۱–۲ ستاره از {num(product.review_count)}</span>
                  </div>
                ))}
                {!lowRated.length && <Empty title="موردی نیست" desc="نظرات کم‌امتیاز تأییدشده اینجا برای پیگیری کیفیت فهرست می‌شوند." />}
              </div>
            </Card>
          </div>
          <p className="flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
            <ShieldCheck size={14} />امتیازها فقط از نظرات واقعی محاسبه می‌شوند؛ بازبینی صرفاً وضعیت نمایش را تغییر می‌دهد و امتیاز دست‌کاری نمی‌شود. نظرات در پروفایل ۳۶۰° مشتری و تایم‌لاین CRM نیز دیده می‌شوند.
          </p>
        </div>
      )}

      <Modal open={!!moderating} onClose={() => setModerating(null)} title="بازبینی نظر">
        {moderating && (
          <div className="space-y-3">
            <div className="rounded-[12px] bg-[var(--kv-surface-2)]/70 p-3 text-[12.5px]">
              <Stars value={Number(moderating.rating ?? 0)} />
              <p className="mt-1 font-bold">{text(moderating.title, "بدون عنوان")}</p>
              <p className="mt-1 whitespace-pre-wrap">{text(moderating.comment)}</p>
            </div>
            <Select options={["approve", "reject", "hide", "restore"]} value={action} onChange={(v) => setAction(v as typeof action)} />
            <Textarea rows={3} value={note} onChange={setNote} placeholder="دلیل بازبینی (در گزارش ممیزی و تایم‌لاین مشتری ثبت می‌شود)" />
            <p className="flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
              <ThumbsUp size={13} />تصمیم با نام بازبین، زمان و دلیل ذخیره می‌شود؛ «restore» نظر را به حالت در انتظار بازمی‌گرداند.
            </p>
            <Btn variant="accent" className="w-full" disabled={action !== "approve" && action !== "restore" && note.trim().length < 3}
              onClick={() => void run("ثبت بازبینی", () => reviewsApi.moderate(String(moderating.id), { action, note: note || undefined }))}>
              ثبت تصمیم
            </Btn>
          </div>
        )}
      </Modal>

      <Modal open={!!drill} onClose={() => setDrill(null)} title={drill ? `تحلیل نظرات ${drill.product.name}` : "تحلیل"} max="max-w-[720px]">
        {drill && (
          <div className="space-y-3 text-[12.5px]">
            <div className="grid grid-cols-3 gap-2">
              {(() => {
                const summary = (drill.data.summary ?? {}) as Record<string, unknown>;
                return (
                  <>
                    <div className="rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3"><p className="text-[11px] text-[var(--kv-muted)]">میانگین</p><p className="text-[16px] font-extrabold">{text(summary.averageRating, "—")}</p></div>
                    <div className="rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3"><p className="text-[11px] text-[var(--kv-muted)]">تعداد</p><p className="text-[16px] font-extrabold">{num(summary.reviewCount)}</p></div>
                    <div className="rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3"><p className="text-[11px] text-[var(--kv-muted)]">خرید تأییدشده</p><p className="text-[16px] font-extrabold">{num(summary.verifiedCount)}</p></div>
                  </>
                );
              })()}
            </div>
            <div>
              <p className="mb-1 font-extrabold">توزیع امتیاز</p>
              {(Array.isArray((drill.data.summary as Record<string, unknown>)?.distribution)
                ? ((drill.data.summary as Record<string, unknown>).distribution as { star: number; count: number }[])
                : []).map((row) => (
                <div key={row.star} className="flex items-center gap-2 text-[12px]">
                  <span className="w-8 text-[var(--kv-muted)]">{row.star} ★</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--kv-surface-2)]">
                    <span className="block h-full rounded-full bg-[var(--kv-accent)]"
                      style={{ width: `${(Number((drill.data.summary as Record<string, unknown>).reviewCount) ? (row.count / Number((drill.data.summary as Record<string, unknown>).reviewCount)) * 100 : 0)}%` }} />
                  </span>
                  <span className="w-10 text-left tabular-nums">{num(row.count)}</span>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-1 font-extrabold">پرتکرارترین واژه‌ها</p>
              <div className="flex flex-wrap gap-2">
                {(Array.isArray(drill.data.topics) ? (drill.data.topics as { topic: string; count: number }[]) : []).map((topic) => (
                  <span key={topic.topic} className="rounded-full border border-[var(--kv-line)] px-2.5 py-1 text-[11.5px]">{topic.topic} ({num(topic.count)})</span>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-[var(--kv-muted)]">{text(drill.data.topicsNote, "")}</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
