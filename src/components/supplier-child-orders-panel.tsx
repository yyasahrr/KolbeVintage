/**
 * Prompt-2 §71-§72: supplier panel for VIP wholesale CHILD orders.
 *  - one row per child order (the supplier's own sub-order of a master);
 *  - per line: [تأیید کامل] [پیشنهاد کمتر] [عدم امکان] — requested qty stays immutable (§35);
 *  - dispatch only after payment; destination is server-resolved (§80/§137);
 *  - buyer identity/address is NEVER shown here (§72) — the API does not return it.
 */
import { useEffect, useState } from "react";
import { Btn, Card, LoadingState, ErrorState, Empty } from "./primitives";
import { wholesaleOmsApi, type SupplierChildOrder, type SupplierChildLine } from "../data/api";
import { fmtNum } from "../data/catalog";

const SUPPLY_FA: Record<string, string> = {
  unresolved: "در انتظار بررسی", awaiting_supplier: "در انتظار پاسخ شما", partially_confirmed: "تأیید ناقص",
  awaiting_buyer: "در انتظار تصمیم خریدار", confirmed: "تأیید شده", stock_reserved: "رزرو از موجودی",
  rejected: "رد شده", timed_out: "مهلت پاسخ گذشت", exception: "استثنا",
};
const PAY_FA: Record<string, string> = {
  blocked_supply_pending: "در انتظار تأمین", blocked_buyer_decision: "در انتظار خریدار",
  ready: "آماده پرداخت خریدار", paid: "پرداخت شده", expired: "منقضی", refund_required: "نیازمند استرداد",
};
const FULFIL_FA: Record<string, string> = {
  waiting_payment: "در انتظار پرداخت", preparing: "آماده‌سازی", dispatched: "ارسال به کلبه",
  received: "دریافت در کلبه", qc: "کنترل کیفی", ready_for_consolidation: "آماده تجمیع",
  consolidated: "تجمیع شد", shipped: "ارسال نهایی", delivered: "تحویل شد", exception: "استثنا",
};
const LINE_FA: Record<string, string> = {
  requested: "در انتظار پاسخ", confirmed: "تأیید شده", awaiting_buyer: "در انتظار خریدار",
  rejected: "رد شده", removed: "حذف شده",
};

export function SupplierChildOrdersPanel({ flash }: { flash: (msg: string) => void }) {
  const [items, setItems] = useState<SupplierChildOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [counterFor, setCounterFor] = useState<string | null>(null);
  const [counterQty, setCounterQty] = useState("");

  const load = async () => {
    setLoading(true); setError(null);
    try { const r = await wholesaleOmsApi.supplierChildOrders({ limit: 30 }); setItems(r.items); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const respond = async (line: SupplierChildLine, action: "confirm" | "counter" | "reject") => {
    setBusy(line.id);
    try {
      const payload: { action: "confirm" | "counter" | "reject"; proposedSeries?: number } = { action };
      if (action === "counter") {
        const qty = Number(counterQty);
        if (!Number.isInteger(qty) || qty < 1) { flash("تعداد پیشنهادی معتبر نیست"); setBusy(null); return; }
        payload.proposedSeries = qty;
      }
      await wholesaleOmsApi.supplierRespond(line.id, payload);
      flash(action === "confirm" ? "خط سفارش تأیید شد" : action === "counter" ? "پیشنهاد کمتر برای خریدار ارسال شد" : "عدم امکان تأمین ثبت شد");
      setCounterFor(null); setCounterQty("");
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت پاسخ"); }
    setBusy(null);
  };

  const dispatch = async (child: SupplierChildOrder) => {
    setBusy(child.id);
    try {
      await wholesaleOmsApi.supplierDispatch(child.id, {});
      flash("مرسوله به مقصد کلبه ثبت شد — مقصد توسط سرور تعیین می‌شود");
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت ارسال"); }
    setBusy(null);
  };

  if (loading) return <LoadingState label="در حال بارگذاری زیرسفارش‌های عمده…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items || items.length === 0) return <Empty title="زیرسفارش عمده‌ای نیست" desc="وقتی خریدار VIP سفارشی شامل کالاهای شما ثبت کند، اینجا نمایش داده می‌شود." />;

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      {items.map((child) => (
        <Card key={child.id} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 px-5 py-3">
            <div className="flex flex-wrap items-center gap-3 text-[13px]">
              <b className="tabular-nums" dir="ltr">{child.reference}</b>
              <span className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{child.master_reference}</span>
              <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px]">{SUPPLY_FA[child.supply_status] ?? child.supply_status}</span>
              <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px]">{PAY_FA[child.payment_eligibility] ?? child.payment_eligibility}</span>
              {child.child_fulfillment && <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px]">{FULFIL_FA[child.child_fulfillment] ?? child.child_fulfillment}</span>}
            </div>
            <div className="flex items-center gap-3 text-[11.5px] text-[var(--kv-muted)]">
              {child.supplier_respond_by && <span>مهلت پاسخ: {new Date(child.supplier_respond_by).toLocaleDateString("fa-IR")}</span>}
              {child.payment_eligibility === "paid" && child.child_fulfillment === "preparing" && (
                <Btn size="sm" variant="accent" disabled={busy === child.id} onClick={() => void dispatch(child)}>ثبت ارسال به کلبه</Btn>
              )}
            </div>
          </div>
          <div className="divide-y divide-[var(--kv-line)]">
            {child.lines.map((line) => (
              <div key={line.id} className="px-5 py-3.5 text-[12.5px]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <b>{line.productName ?? "کالا"}</b>
                    {line.templateName && <span className="text-[var(--kv-muted)]">{line.templateName}</span>}
                    <span className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[11px]">{LINE_FA[line.status] ?? line.status}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 tabular-nums">
                    <span>درخواستی: {fmtNum(line.requestedSeries)} سری</span>
                    {line.stockAtKolbeSeries > 0 && <span className="text-[var(--kv-muted)]">از موجودی نزد کلبه: {fmtNum(line.stockAtKolbeSeries)}</span>}
                    {line.externalSeries > 0 && <span className="text-[var(--kv-muted)]">تأمین بیرونی: {fmtNum(line.externalSeries)}</span>}
                    {line.proposedSeries !== null && <span>پیشنهاد شما: {fmtNum(line.proposedSeries)}</span>}
                    {line.confirmedSeries !== null && <span className="font-bold">تأییدشده: {fmtNum(line.confirmedSeries)}</span>}
                  </div>
                </div>
                {line.status === "requested" && child.supply_status !== "timed_out" && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Btn size="sm" variant="accent" disabled={busy === line.id} onClick={() => void respond(line, "confirm")}>تأیید کامل</Btn>
                    {counterFor === line.id ? (
                      <span className="flex items-center gap-2">
                        <input dir="ltr" inputMode="numeric" value={counterQty} onChange={(e) => setCounterQty(e.target.value)}
                          placeholder={`< ${line.requestedSeries}`}
                          className="w-24 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 py-1.5 text-center text-[12.5px] tabular-nums" />
                        <Btn size="sm" variant="soft" disabled={busy === line.id} onClick={() => void respond(line, "counter")}>ارسال پیشنهاد</Btn>
                        <Btn size="sm" variant="ghost" onClick={() => { setCounterFor(null); setCounterQty(""); }}>انصراف</Btn>
                      </span>
                    ) : (
                      <Btn size="sm" variant="soft" onClick={() => { setCounterFor(line.id); setCounterQty(""); }}>پیشنهاد کمتر</Btn>
                    )}
                    <Btn size="sm" variant="ghost" disabled={busy === line.id} onClick={() => void respond(line, "reject")}>عدم امکان</Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
      <div className="rounded-lg bg-[var(--kv-surface-2)] p-3 text-xs leading-6 text-[var(--kv-muted)]">
        مقدار درخواستی خریدار تغییر نمی‌کند؛ «پیشنهاد کمتر» کل خط را به تصمیم خریدار می‌سپارد. بعد از پرداختِ خریدار، فقط «ثبت ارسال به کلبه» مجاز است — ارسال مستقیم به خریدار ممنوع است و مقصد را سرور تعیین می‌کند.
      </div>
    </div>
  );
}
