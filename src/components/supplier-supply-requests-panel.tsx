import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, RefreshCw, Send, ShieldCheck, X } from "lucide-react";
import { Btn, Card, Empty, ErrorState, LoadingState } from "./primitives";
import { wholesaleOmsApi, type SupplierSupplyRequest } from "../data/api";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const STATUS: Record<string, { label: string; cls: string }> = {
  unanswered: { label: "در انتظار پاسخ شما", cls: "bg-amber-100 text-amber-800" },
  accepted: { label: "پذیرفته‌شده؛ در انتظار تعهد", cls: "bg-sky-100 text-sky-800" },
  revised: { label: "پیشنهاد شما؛ در انتظار تصمیم خریدار", cls: "bg-violet-100 text-violet-800" },
  rejected: { label: "رد شده؛ نیازمند بازتخصیص کلبه", cls: "bg-red-100 text-red-700" },
  committed: { label: "تعهد نهایی ثبت شد", cls: "bg-indigo-100 text-indigo-800" },
  ready: { label: "آماده ارسال به انبار کلبه", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { label: "تعهد لغو شد؛ نیاز سفارش حفظ شد", cls: "bg-red-100 text-red-700" },
};
const PAY: Record<string, string> = {
  ready: "آماده پرداخت خریدار", paid: "پرداخت‌شده", blocked_supply_pending: "در انتظار تأمین",
  blocked_buyer_decision: "در انتظار تصمیم خریدار", expired: "مهلت پرداخت پایان یافت",
};

type Draft = { quantity: string; note: string };
type Flash = (message: string) => void;

export function SupplierSupplyRequestsPanel({ flash }: { flash: Flash }) {
  const [items, setItems] = useState<SupplierSupplyRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [revising, setRevising] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await wholesaleOmsApi.supplierSupplyRequests({ state: "open", limit: 100 });
      setItems(response.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "دریافت درخواست‌های سفارش انجام نشد.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const draftFor = (id: string): Draft => drafts[id] ?? { quantity: "", note: "" };
  const setDraft = (id: string, patch: Partial<Draft>) => setDrafts((current) => ({
    ...current, [id]: { ...(current[id] ?? { quantity: "", note: "" }), ...patch },
  }));
  const act = async (request: SupplierSupplyRequest, action: () => Promise<unknown>, success: string) => {
    setBusy(request.allocationId);
    try { await action(); flash(success); setRevising(null); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "ثبت تغییر انجام نشد."); }
    finally { setBusy(null); }
  };

  if (!items) return error ? <ErrorState message={error} onRetry={() => void load()} /> : <LoadingState label="در حال دریافت درخواست‌های متصل به سفارش مادر…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-3 text-[12px] leading-6 text-[var(--kv-muted)]">
        <p className="max-w-[80ch]">هر ردیف مستقیماً به تخصیص تأمین همان سفارش مادر در OMS کلبه وصل است. پذیرش، ظرفیت اعلامی را رزرو می‌کند؛ ظرفیت هرگز موجودی فیزیکی نیست. کالا فقط برای انبار کلبه آماده یا ارسال می‌شود.</p>
        <Btn size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCw size={14} />}>به‌روزرسانی</Btn>
      </div>
      {!items.length && <Empty title="درخواست بازی برای تأمین ندارید" desc="وقتی برای یک سفارش مادر نیاز بیرونی به شما تخصیص یابد، همین‌جا نمایش داده می‌شود." />}
      {items.map((request) => {
        const meta = STATUS[request.responseStatus] ?? { label: request.responseStatus, cls: "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]" };
        const draft = draftFor(request.allocationId);
        const isBusy = busy === request.allocationId;
        const canRespond = request.responseStatus === "unanswered" && request.lineStatus === "awaiting_supplier" && request.allocationStatus === "pending";
        const canCommit = request.responseStatus === "accepted" && request.allocationStatus === "reserved" && ["ready", "paid"].includes(request.paymentEligibility);
        const canReady = request.responseStatus === "committed" && request.allocationStatus === "reserved" && request.paymentEligibility === "paid";
        const canCancel = ["accepted", "committed"].includes(request.responseStatus)
          && request.allocationStatus === "reserved" && request.lineStatus === "confirmed"
          && request.childStatus === "pending_payment" && !["paid", "expired"].includes(request.paymentEligibility);
        const canDispatch = request.responseStatus === "ready" && request.paymentEligibility === "paid" && request.childFulfillment !== "dispatched";
        return (
          <Card key={request.allocationId} className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-mono font-bold" dir="ltr">{request.orderReference}</span>
                <span className={cn("rounded-full px-2 py-1 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>
                <span className="rounded-full bg-[var(--kv-surface)] px-2 py-1 text-[10.5px]">{PAY[request.paymentEligibility] ?? "در جریان سفارش"}</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--kv-muted)]">
                <Clock3 size={13} />{request.createdAt ? new Date(request.createdAt).toLocaleDateString("fa-IR") : ""}
              </div>
            </div>
            <div className="space-y-3 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-[14px] font-extrabold">{request.productName}</h3>
                  <p className="mt-0.5 text-[12px] text-[var(--kv-muted)]">{request.seriesName}{request.colorLabel ? ` · ${request.colorLabel}` : ""}</p>
                </div>
                <div className="grid min-w-[180px] grid-cols-2 gap-2 text-[11.5px]">
                  <div className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2"><span className="text-[var(--kv-muted)]">کل درخواستی</span><b className="mt-0.5 block tabular-nums">{fa(request.requestedSeries)} سری</b></div>
                  <div className="rounded-[10px] bg-amber-50 px-3 py-2 text-amber-900"><span>سهم بیرونی</span><b className="mt-0.5 block tabular-nums">{fa(request.externalSeries)} سری</b></div>
                </div>
              </div>

              {(request.proposedSeries !== null || request.confirmedSeries !== null) && (
                <div className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px]">
                  {request.proposedSeries !== null && <span>پیشنهاد اصلاح‌شده: <b className="tabular-nums">{fa(request.proposedSeries)} سری</b></span>}
                  {request.confirmedSeries !== null && <span>تعداد تأییدشده: <b className="tabular-nums">{fa(request.confirmedSeries)} سری</b></span>}
                </div>
              )}
              {request.responseNote && <p className="rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[11.5px] leading-6">یادداشت پاسخ: {request.responseNote}</p>}

              {canRespond && (
                <div className="space-y-2 border-t border-[var(--kv-line)] pt-3">
                  <label className="block text-[11.5px] font-semibold">یادداشت (اختیاری)
                    <input value={draft.note} onChange={(e) => setDraft(request.allocationId, { note: e.target.value })}
                      maxLength={400} className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12px] outline-none focus:border-[var(--kv-accent)]" />
                  </label>
                  {revising === request.allocationId && (
                    <label className="block text-[11.5px] font-semibold">تعداد پیشنهادی کمتر (سری)
                      <input dir="ltr" inputMode="numeric" min={1} max={request.requestedSeries - 1} value={draft.quantity}
                        onChange={(e) => setDraft(request.allocationId, { quantity: e.target.value })}
                        className="mt-1 h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-left tabular-nums outline-none focus:border-[var(--kv-accent)]" />
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Btn size="sm" variant="accent" disabled={isBusy} icon={<Check size={14} />}
                      onClick={() => void act(request, () => wholesaleOmsApi.supplierRespondAllocation(request.allocationId,
                        { action: "confirm", ...(draft.note ? { note: draft.note } : {}) }), "تأمین پذیرفته شد و ظرفیت در OMS رزرو شد.")}>پذیرش کامل</Btn>
                    {revising === request.allocationId ? (
                      <>
                        <Btn size="sm" variant="soft" disabled={isBusy || !Number.isInteger(Number(draft.quantity)) || Number(draft.quantity) < 1 || Number(draft.quantity) >= request.requestedSeries}
                          onClick={() => void act(request, () => wholesaleOmsApi.supplierRespondAllocation(request.allocationId,
                            { action: "counter", proposedSeries: Number(draft.quantity), ...(draft.note ? { note: draft.note } : {}) }), "پیشنهاد اصلاح به سفارش مادر متصل شد؛ تصمیم خریدار لازم است.")}>ارسال پیشنهاد اصلاح</Btn>
                        <Btn size="sm" variant="ghost" disabled={isBusy} onClick={() => setRevising(null)}>انصراف</Btn>
                      </>
                    ) : <Btn size="sm" variant="soft" disabled={isBusy} onClick={() => setRevising(request.allocationId)}>پیشنهاد تأمین جزئی / اصلاح</Btn>}
                    <Btn size="sm" variant="ghost" disabled={isBusy} icon={<X size={14} />}
                      onClick={() => void act(request, () => wholesaleOmsApi.supplierRespondAllocation(request.allocationId,
                        { action: "reject", ...(draft.note ? { note: draft.note } : {}) }), "عدم امکان تأمین ثبت شد؛ نیاز سفارش مادر برای بازتخصیص کلبه حفظ شد.")}>عدم امکان تأمین</Btn>
                  </div>
                </div>
              )}

              {(canCommit || canReady || canCancel || canDispatch) && (
                <div className="flex flex-wrap gap-2 border-t border-[var(--kv-line)] pt-3">
                  {canCommit && <Btn size="sm" variant="accent" disabled={isBusy} icon={<ShieldCheck size={14} />}
                    onClick={() => void act(request, () => wholesaleOmsApi.supplierCommit(request.allocationId, { note: draft.note }), "تعهد نهایی تأمین در OMS ثبت شد.")}>ثبت تعهد نهایی</Btn>}
                  {canReady && <Btn size="sm" variant="accent" disabled={isBusy} icon={<Check size={14} />}
                    onClick={() => void act(request, () => wholesaleOmsApi.supplierReady(request.allocationId, { note: draft.note }), "آماده‌بودن برای ارسال به انبار کلبه ثبت شد؛ موجودی WMS تغییری نکرد.")}>اعلام آمادگی برای کلبه</Btn>}
                  {canDispatch && <Btn size="sm" variant="soft" disabled={isBusy} icon={<Send size={14} />}
                    onClick={() => void act(request, () => wholesaleOmsApi.supplierDispatch(request.childOrderId, { trackingNote: draft.note }), "ارسال فقط به انبار کلبه ثبت شد؛ دریافت و QC در این پنل انجام نمی‌شود.")}>ثبت ارسال به انبار کلبه</Btn>}
                  {canCancel && <Btn size="sm" variant="ghost" disabled={isBusy}
                    onClick={() => {
                      const note = draft.note.trim() || "لغو تعهد توسط تأمین‌کننده";
                      if (!window.confirm("تعهد لغو می‌شود، اما نیاز سفارش مادر حذف نمی‌شود و برای بازتخصیص به کلبه بازمی‌گردد. ادامه می‌دهید؟")) return;
                      void act(request, () => wholesaleOmsApi.supplierCancelCommitment(request.allocationId, { note }), "تعهد لغو شد و همان نیاز برای بازتخصیص حفظ شد.");
                    }}>لغو تعهد پیش از پرداخت</Btn>}
                </div>
              )}

              <p className="flex items-start gap-2 rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2 text-[10.5px] leading-5 text-[var(--kv-muted)]">
                <ShieldCheck size={14} className="mt-0.5 shrink-0" />ظرفیت اعلامی و تعهد تأمین، موجودی فیزیکی، رسید انبار یا QC محسوب نمی‌شود. هر ارسال فقط به انبار مرکزی کلبه است؛ ارسال مستقیم به خریدار مجاز نیست.
              </p>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
