import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Btn, Card, Drawer, Empty, ErrorState, Field, LoadingState, Select } from "./primitives";
import { marketplaceApi } from "../data/api";
import { REVIEW_DECISION_LABEL, normalizeMarketplaceProducts, type MarketplaceProduct } from "../data/contracts";
import { fmtMoney } from "../data/catalog";
import { cn } from "../utils/cn";

const STATUS_LABEL: Record<string, string> = { draft: "پیش‌نویس", pending: "در انتظار بازبینی", published: "منتشر", rejected: "ردشده", archived: "بایگانی" };
const STATUS_TONE: Record<string, string> = {
  draft: "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]",
  pending: "bg-[#B7791F]/15 text-[#8A5A00] dark:text-[#E8B44A]",
  published: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  rejected: "bg-[var(--kv-danger)]/12 text-[var(--kv-danger)]",
  archived: "bg-[var(--kv-surface-2)] text-[var(--kv-faint)]",
};

/**
 * Supplier's own review pipeline — real statuses from the server with the
 * Kolbe decision history and one-click resubmission after fixing a rejection.
 */
export function SupplierReviewPanel({ flash }: { flash: (message: string) => void }) {
  const [items, setItems] = useState<MarketplaceProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<MarketplaceProduct | null>(null);

  const load = async () => {
    setError(null);
    try {
      setItems(normalizeMarketplaceProducts(await marketplaceApi.supplierProducts({ ...(status ? { status } : {}), limit: "50" })));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت محصولات"); }
  };
  useEffect(() => { void load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const resubmit = async (id: string) => {
    try {
      await marketplaceApi.supplierResubmit(id);
      await load();
      setSelected(null);
      flash("محصول دوباره برای بازبینی کلبه ارسال شد.");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ارسال مجدد"); }
  };

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-3">
        <div>
          <p className="text-[13.5px] font-extrabold">وضعیت بازبینی محصولات (داده سرور)</p>
          <p className="text-[11.5px] text-[var(--kv-muted)]">تصمیم کلبه، دلیل رد و امکان ارسال مجدد پس از اصلاح</p>
        </div>
        <span className="w-[170px"><Select options={["همه وضعیت‌ها", "پیش‌نویس", "در انتظار بازبینی", "منتشرشده", "ردشده", "بایگانی‌شده"]} value={status === "" ? "همه وضعیت‌ها" : STATUS_LABEL[status] ?? status} onChange={(label) => { const codes = ["", "draft", "pending", "published", "rejected", "archived"]; const labels = ["همه وضعیت‌ها", "پیش‌نویس", "در انتظار بازبینی", "منتشرشده", "ردشده", "بایگانی‌شده"]; setStatus(codes[labels.indexOf(label)] ?? ""); }} /></span>
      </div>
      {!items ? (error ? <div className="p-4"><ErrorState message={error} onRetry={() => void load()} /></div> : <LoadingState label="در حال بارگذاری…" />)
        : items.length === 0 ? <div className="p-4"><Empty title="محصولی ثبت نشده" desc="از دکمه «افزودن محصول جدید» شروع کنید." /></div>
          : (
            <div className="divide-y divide-[var(--kv-line)]">
              {items.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center gap-3 p-3.5">
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-[13px]">{item.name}</b>
                    <span className="mt-0.5 block text-[11.5px] text-[var(--kv-muted)]">
                      عمده {item.wholesalePriceRial ? fmtMoney(Number(item.wholesalePriceRial)) : "—"} · {item.variantCount.toLocaleString("fa-IR")} واریانت
                      {item.lastDecision && ` · آخرین تصمیم: ${REVIEW_DECISION_LABEL[item.lastDecision]}${item.lastReason ? ` — ${item.lastReason}` : ""}`}
                    </span>
                  </span>
                  <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-bold", STATUS_TONE[item.status])}>{STATUS_LABEL[item.status] ?? item.status}</span>
                  <Btn variant="ghost" size="sm" onClick={() => setSelected(item)}>جزئیات</Btn>
                  {(item.status === "rejected" || item.status === "draft") && (
                    <Btn variant="soft" size="sm" icon={<RotateCcw size={13} />} onClick={() => void resubmit(item.id)}>ارسال مجدد برای بازبینی</Btn>
                  )}
                </div>
              ))}
            </div>
          )}
      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? `بازبینی · ${selected.name}` : ""}>
        {selected && <SupplierProductDetail product={selected} flash={flash} onResubmit={() => void resubmit(selected.id)} />}
      </Drawer>
    </Card>
  );
}

function SupplierProductDetail({ product, flash, onResubmit }: { product: MarketplaceProduct; flash: (m: string) => void; onResubmit: () => void }) {
  const [detail, setDetail] = useState<{ reviews: { id: string; decision: string; reasonLabel: string | null; note: string | null; reviewerName: string | null; createdAt: string }[]; variants: { sku: string; sizeLabel: string | null; colorLabel: string | null }[]; documents: { id: string; title: string }[] } | null>(null);
  useEffect(() => {
    let live = true;
    marketplaceApi.supplierDetail(product.id).then((raw: unknown) => {
      if (!live) return;
      const row = (raw ?? {}) as Record<string, unknown>;
      const arr = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
      setDetail({
        variants: arr(row.variants).map((v) => ({ sku: String(v.sku ?? ""), sizeLabel: (v.sizeLabel ?? v.size_label) as string | null ?? null, colorLabel: (v.colorLabel ?? v.color_label) as string | null ?? null })),
        documents: arr(row.documents).map((d) => ({ id: String(d.id ?? ""), title: String(d.title ?? "") })),
        reviews: arr(row.reviews).map((r) => ({ id: String(r.id ?? ""), decision: String(r.decision ?? ""), reasonLabel: (r.reasonLabel ?? r.reason_label) as string | null ?? null, note: (r.note ?? null) as string | null, reviewerName: (r.reviewerName ?? r.reviewer_name) as string | null ?? null, createdAt: String(r.createdAt ?? r.created_at ?? "") })),
      });
    }).catch((e: unknown) => flash(e instanceof Error ? e.message : "خطا در دریافت جزئیات"));
    return () => { live = false; };
  }, [product.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) return <LoadingState label="در حال بارگذاری…" />;
  return (
    <div className="space-y-4">
      <Field label="واریانت‌ها"><p className="text-[12.5px] tabular-nums">{detail.variants.length ? detail.variants.map((v) => `${v.sku} (${v.colorLabel ?? "—"} / ${v.sizeLabel ?? "—"})`).join(" · ") : "—"}</p></Field>
      {detail.documents.length > 0 && <Field label="مدارک"><p className="text-[12.5px]">{detail.documents.map((d) => d.title).join(" · ")}</p></Field>}
      <div>
        <p className="mb-2 text-[12.5px] font-extrabold">تاریخچه تصمیم‌های کلبه</p>
        {detail.reviews.length === 0 ? <p className="text-[12.5px] text-[var(--kv-muted)]">هنوز تصمیمی ثبت نشده — محصول در صف بازبینی است.</p> : (
          <ol className="space-y-2 border-r border-[var(--kv-line)] pr-3">
            {detail.reviews.map((review) => (
              <li key={review.id} className="text-[12.5px]">
                <b>{REVIEW_DECISION_LABEL[review.decision as keyof typeof REVIEW_DECISION_LABEL] ?? review.decision}</b>
                {review.reasonLabel && <span> — {review.reasonLabel}</span>}
                <span className="mr-2 text-[var(--kv-muted)]">{review.reviewerName ?? "کلبه"}{review.createdAt ? ` · ${new Date(review.createdAt).toLocaleDateString("fa-IR", { dateStyle: "medium" })}` : ""}</span>
                {review.note && <p className="mt-1 rounded-[8px] bg-[var(--kv-surface-2)]/70 px-3 py-1.5">{review.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
      {(product.status === "rejected" || product.status === "draft") && (
        <Btn variant="accent" size="sm" icon={<RotateCcw size={14} />} onClick={onResubmit}>ارسال مجدد برای بازبینی</Btn>
      )}
    </div>
  );
}
