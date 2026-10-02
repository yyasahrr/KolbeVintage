import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, RotateCcw, X } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, LoadingState, SearchBox, Select, Segmented, Status, Textarea, Checkbox } from "./primitives";
import { marketplaceApi } from "../data/api";
import {
  REVIEW_DECISION_LABEL, normalizeMarketplaceProducts, normalizeProductReview, normalizeReviewReasons,
  type MarketplaceProduct, type ProductReview, type ReviewReason,
} from "../data/contracts";
import { fmtMoney } from "../data/catalog";
import { cn } from "../utils/cn";

type F = (message: string) => void;
type Detail = MarketplaceProduct & {
  description: string; ownerType: string; retailEnabled: boolean; wholesaleEnabled: boolean;
  variants: { id: string; sku: string; size: string | null; color: string | null }[];
  reviews: ProductReview[];
};

const STATUS_LABEL: Record<string, string> = { draft: "پیش‌نویس", pending: "در انتظار بازبینی", published: "منتشر", rejected: "ردشده", archived: "بایگانی" };

export function MarketplaceReviewPanel({ flash }: { flash: F }) {
  const [items, setItems] = useState<MarketplaceProduct[] | null>(null);
  const [reasons, setReasons] = useState<ReviewReason[]>([]);
  const [status, setStatus] = useState<"pending" | "draft" | "published" | "rejected" | "archived" | "all">("pending");
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | "changes_requested">("approved");
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [documentsChecked, setDocumentsChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params: Record<string, string> = { limit: "100" };
      if (status !== "all") params.status = status;
      if (query.trim()) params.search = query.trim();
      const [list, reasonList] = await Promise.all([
        marketplaceApi.queue(params).then(normalizeMarketplaceProducts),
        marketplaceApi.reviewReasons().then(normalizeReviewReasons).catch(() => [] as ReviewReason[]),
      ]);
      setItems(list);
      setReasons(reasonList);
      setSel((current) => (current && list.some((item) => item.id === current) ? current : list[0]?.id ?? null));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری صف بازبینی"); }
  }, [status, query]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let live = true;
    marketplaceApi.detail(sel).then((raw) => {
      if (!live) return;
      const row = (raw ?? {}) as Record<string, unknown>;
      const normalized = normalizeMarketplaceProducts({ items: [raw] })[0];
      if (!normalized) { setDetail(null); return; }
      setDetail({
        ...normalized,
        description: String(row.description ?? ""),
        ownerType: String(row.ownerType ?? row.owner_type ?? ""),
        retailEnabled: (row.retailEnabled ?? row.retail_enabled) === true,
        wholesaleEnabled: (row.wholesaleEnabled ?? row.wholesale_enabled) !== false,
        variants: (Array.isArray(row.variants) ? (row.variants as Record<string, unknown>[]) : []).map((variant) => ({
          id: String(variant.id), sku: String(variant.sku ?? ""),
          size: (variant.size ?? variant.size_label ?? null) as string | null,
          color: (variant.color ?? variant.color_label ?? null) as string | null,
        })),
        reviews: (Array.isArray(row.reviews) ? (row.reviews as unknown[]) : [])
          .map(normalizeProductReview).filter((r): r is ProductReview => r !== null),
      });
      setDecision("approved"); setReasonCode(""); setNote(""); setDocumentsChecked(false);
    }).catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [sel]);

  const review = async () => {
    if (!detail) return;
    if (decision === "rejected" && !reasonCode) { flash("رد محصول بدون انتخاب دلیل مجاز نیست"); return; }
    if (decision === "changes_requested" && !reasonCode && note.trim().length < 3) { flash("درخواست اصلاح بدون دلیل یا توضیح مجاز نیست"); return; }
    setBusy(true);
    try {
      await marketplaceApi.review(detail.id, {
        decision, documentsChecked,
        ...(reasonCode ? { reasonCode } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      flash(decision === "approved" ? `«${detail.name}» تأیید و در بازارچه عمده منتشر شد` : decision === "rejected" ? "محصول رد شد و دلیل برای تأمین‌کننده ارسال شد" : "بازخورد اصلاح برای تأمین‌کننده ارسال شد");
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت بازبینی"); }
    finally { setBusy(false); }
  };

  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="min-w-[220px] flex-1"><SearchBox value={query} onChange={setQuery} placeholder="جست‌وجوی نام محصول، برند یا تأمین‌کننده…" /></div>
        <Segmented<"pending" | "draft" | "published" | "rejected" | "archived" | "all"> options={[
          { v: "pending", label: "در انتظار بررسی" }, { v: "draft", label: "نیازمند اصلاح" }, { v: "published", label: "فعال (منتشر)" },
          { v: "rejected", label: "ردشده" }, { v: "archived", label: "آرشیوشده" }, { v: "all", label: "همه" },
        ]} value={status} onChange={setStatus} />
        <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
      </div>
      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => void load()} /></div>}
      {!items ? <LoadingState label="در حال بارگذاری صف بازبینی…" /> : (
        <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
          <Card className="overflow-hidden">
            <div className="kv-scroll overflow-x-auto">
              <table className="kv-table min-w-[760px]">
                <thead><tr><th>محصول</th><th>تأمین‌کننده</th><th>قیمت عمده</th><th>حداقل</th><th>واریانت</th><th>آخرین بازبینی</th><th>وضعیت</th><th></th></tr></thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className={cn(sel === item.id && "bg-[var(--kv-accent)]/[0.05]")}>
                      <td><b className="whitespace-nowrap">{item.name}</b><span className="block text-[11px] text-[var(--kv-muted)]">{item.brand} · {item.category}</span></td>
                      <td className="text-[12.5px]">{item.supplierName ?? "—"}</td>
                      <td className="font-bold tabular-nums">{item.wholesalePriceRial ? fmtMoney(Number(item.wholesalePriceRial)) : "—"}</td>
                      <td className="tabular-nums">{item.wholesaleMoq ?? "—"}</td>
                      <td className="tabular-nums">{item.variantCount.toLocaleString("fa-IR")}</td>
                      <td className="max-w-[200px] truncate text-[11.5px] text-[var(--kv-muted)]">{item.lastReason ?? "—"}</td>
                      <td><Status value={STATUS_LABEL[item.status] ?? item.status} /></td>
                      <td><button onClick={() => setSel(item.id)} className="text-[12.5px] font-bold text-[var(--kv-accent)] hover:underline">بازبینی</button></td>
                    </tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-[var(--kv-muted)]">موردی در این صف نیست.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>
          <Card className="h-fit p-5">
            {!detail ? <Empty title="محصولی انتخاب نشده" desc="روی «بازبینی» هر سطر بزنید." /> : (
              <div>
                <h3 className="text-[15px] font-extrabold">{detail.name}</h3>
                <p className="text-xs text-[var(--kv-muted)]">{detail.brand} · {detail.category} · {detail.supplierName ?? "کلبه"}</p>
                <div className="mt-3 space-y-1.5 text-[12.5px]">
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">قیمت عمده</span><b className="tabular-nums">{detail.wholesalePriceRial ? fmtMoney(Number(detail.wholesalePriceRial)) : "—"}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">حداقل سفارش</span><b className="tabular-nums">{detail.wholesaleMoq ?? "—"}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">کانال</span><b>{[detail.retailEnabled && "خرده", detail.wholesaleEnabled && "عمده"].filter(Boolean).join(" · ") || "—"}</b></div>
                  <div className="flex justify-between"><span className="text-[var(--kv-muted)]">وضعیت</span><Status value={STATUS_LABEL[detail.status] ?? detail.status} /></div>
                </div>
                {detail.variants.length > 0 && (
                  <div className="mt-3 rounded-[10px] bg-[var(--kv-surface-2)]/60 p-3 text-[11.5px]">
                    <p className="mb-1 font-bold">واریانت‌ها ({detail.variants.length.toLocaleString("fa-IR")})</p>
                    {detail.variants.slice(0, 6).map((variant) => <p key={variant.id} className="text-[var(--kv-muted)]" dir="ltr">{variant.sku} <span dir="rtl">· {variant.size ?? "—"} / {variant.color ?? "—"}</span></p>)}
                    {detail.variants.length > 6 && <p className="text-[var(--kv-muted)]">و {(detail.variants.length - 6).toLocaleString("fa-IR")} مورد دیگر…</p>}
                  </div>
                )}
                {detail.reviews.length > 0 && (
                  <div className="mt-3 border-t border-[var(--kv-line)] pt-3">
                    <p className="mb-1.5 text-[12.5px] font-bold">سوابق بازبینی</p>
                    {detail.reviews.slice(0, 3).map((review) => (
                      <p key={review.id} className="text-[11.5px] leading-5 text-[var(--kv-muted)]">
                        <b className="text-[var(--kv-ink)]">{REVIEW_DECISION_LABEL[review.decision] ?? review.decision}</b>
                        {review.reasonLabel && ` · ${review.reasonLabel}`}{review.note && ` — ${review.note}`}
                      </p>
                    ))}
                  </div>
                )}
                <div className="mt-4 space-y-3 border-t border-[var(--kv-line)] pt-4">
                  <Field label="تصمیم">
                    <Segmented<"approved" | "rejected" | "changes_requested"> options={[{ v: "approved", label: "تأیید و انتشار" }, { v: "changes_requested", label: "نیازمند اصلاح" }, { v: "rejected", label: "رد" }]} value={decision} onChange={setDecision} />
                  </Field>
                  {decision !== "approved" && (
                    <Field label={decision === "rejected" ? "دلیل رد (الزامی)" : "دلیل اصلاح (الزامی — یا توضیح بنویسید)"} hint="متن دلیل برای تأمین‌کننده ارسال و در سوابق ثبت می‌شود">
                      <Select options={["انتخاب دلیل…", ...reasons.filter((r) => r.active).map((r) => r.label)]} value={reasons.find((r) => r.code === reasonCode)?.label ?? "انتخاب دلیل…"} onChange={(label) => setReasonCode(reasons.find((r) => r.label === label)?.code ?? "")} />
                    </Field>
                  )}
                  <Field label="توضیح بازبین (برای تأمین‌کننده)"><Textarea rows={2} value={note} onChange={setNote} placeholder="مثلاً: تصویر دوم تار است؛ لطفاً جایگزین کنید." /></Field>
                  {detail.supplierId && <Checkbox checked={documentsChecked} onChange={setDocumentsChecked} label="مدارک تأمین‌کننده بررسی شد (شرط تأیید محصول تأمین‌کننده)" />}
                  <div className="grid grid-cols-2 gap-2">
                    <Btn variant={decision === "approved" ? "accent" : "soft"} size="sm" disabled={busy} icon={decision === "approved" ? <Check size={14} /> : <X size={14} />} onClick={() => void review()}>ثبت بازبینی</Btn>
                    {(detail.status === "rejected" || detail.status === "draft") && (
                      <Btn variant="soft" size="sm" disabled={busy} icon={<RotateCcw size={14} />} onClick={() => void (async () => { try { await marketplaceApi.adminResubmit(detail.id); flash("محصول دوباره به صف بازبینی برگشت"); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>ارسال مجدد به صف</Btn>
                    )}
                    {detail.status !== "archived" && (
                      <Btn variant="soft" size="sm" disabled={busy} onClick={() => void (async () => {
                        if (note.trim().length < 3) { flash("برای بایگانی، دلیل را در «توضیح بازبین» بنویسید"); return; }
                        try { await marketplaceApi.archive(detail.id, note.trim()); flash("محصول بایگانی شد (بدون هیچ تغییری در موجودی)"); await load(); }
                        catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
                      })()}>بایگانی با دلیل</Btn>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
