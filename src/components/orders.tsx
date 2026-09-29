import { useState } from "react";
import { ChevronDown, Check, X, Truck, PackageCheck, CreditCard, Ban, History, Store, MapPin, Clock } from "lucide-react";
import { SUB_STATUS, SUB_STEPS, KOLBE, isTerminal, type ParentOrder, type SubOrder, type SubStatus } from "../data/platform";
import { fmtMoney, fmtNum } from "../data/catalog";
import { Btn, Status, Timeline, Empty, Field, Input, Card, Textarea } from "./primitives";
import { cn } from "../utils/cn";

export function SupplierChip({ id, name, size = "sm" }: { id: string; name: string; size?: "sm" | "md" }) {
  const kolbe = id === KOLBE.id;
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full font-bold whitespace-nowrap",
      size === "sm" ? "px-2.5 py-1 text-[11.5px]" : "px-3 py-1.5 text-[12.5px]",
      kolbe ? "bg-[#1B2A4A] text-[#E8D9C3] dark:bg-[#E8D9C3] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)] text-[var(--kv-ink-2)] border border-[var(--kv-line)]"
    )}>
      <Store size={12} />{kolbe ? "کلبه وینتیج" : name}
    </span>
  );
}

export function SubProgress({ status, caption = true }: { status: SubStatus; caption?: boolean }) {
  const s = SUB_STATUS[status];
  const dead = status === "rejected" || status === "cancelled";
  return (
    <div>
      <ol className="flex items-center gap-1" aria-label="مراحل زیرسفارش">
        {SUB_STEPS.map((label, i) => {
          const n = i + 1;
          const done = !dead && s.step > n;
          const cur = !dead && s.step === n;
          return <li key={label} title={label} className={cn("h-1.5 flex-1 rounded-full transition-colors", dead ? "bg-[var(--kv-surface-3)]" : done ? "bg-[var(--kv-success)]" : cur ? "bg-[var(--kv-accent)]" : "bg-[var(--kv-surface-3)]")} />;
        })}
      </ol>
      {caption && (
        <p className="mt-1.5 text-[11px] text-[var(--kv-muted)]">
          {dead ? s.label : `مرحله ${fmtNum(s.step)} از ${fmtNum(SUB_STEPS.length)} · ${SUB_STEPS[Math.max(0, s.step - 1)]}`}
        </p>
      )}
    </div>
  );
}

export function orderTotals(o: ParentOrder) {
  const live = (o.subOrders ?? []).filter((s) => s.status !== "rejected" && s.status !== "cancelled");
  return {
    total: live.reduce((a, s) => a + s.total, 0),
    pieces: live.reduce((a, s) => a + (s.lines ?? []).reduce((b, l) => b + l.pieces, 0), 0),
  };
}

/* ============ Parent order with expandable sub-orders ============ */
export function ParentOrderCard({ order, perspective, defaultOpen, onPaySub, onPayAll, onCancelSub, onReturnSub }: {
  order: ParentOrder; perspective: "buyer" | "admin"; defaultOpen?: boolean;
  onPaySub?: (subId: string) => void; onPayAll?: () => void; onCancelSub?: (subId: string) => void; onReturnSub?: (subId: string) => void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const subs = order.subOrders ?? [];
  const { total, pieces } = orderTotals(order);
  const payable = subs.filter((s) => s.status === "approved");
  const payableTotal = payable.reduce((a, s) => a + s.total, 0);
  const counts = subs.reduce<Record<string, number>>((m, s) => { const l = SUB_STATUS[s.status].label; m[l] = (m[l] ?? 0) + 1; return m; }, {});
  const thumbs = subs.flatMap((s) => (s.lines ?? []).map((l) => l.image)).slice(0, 3);

  return (
    <article className="overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] kv-shadow-sm">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-4 p-4 text-right transition-colors hover:bg-[var(--kv-surface-2)]/40">
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--kv-line)] bg-[var(--kv-surface)] transition-transform duration-300", open && "rotate-180")} aria-hidden>
          <ChevronDown size={17} />
        </span>
        <div className="flex -space-x-3 space-x-reverse">
          {thumbs.map((t, i) => <img key={i} src={t} alt="" className="h-12 w-10 rounded-[9px] border-2 border-[var(--kv-surface)] object-cover" />)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <b className="text-[14.5px] tabular-nums">{order.id}</b>
            <span className="text-xs text-[var(--kv-muted)]">{order.createdAt}</span>
            {perspective === "admin" && <span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-0.5 text-[11.5px] font-bold">{order.buyer}</span>}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {Object.entries(counts).map(([label, n]) => (
              <span key={label} className="inline-flex items-center gap-1">
                {n > 1 && <b className="text-[11px] tabular-nums text-[var(--kv-muted)]">{fmtNum(n)}×</b>}
                <Status value={label} />
              </span>
            ))}
          </div>
        </div>
        <div className="shrink-0 text-left">
          <p className="text-[15px] font-extrabold tabular-nums">{fmtMoney(total)}</p>
          <p className="text-xs text-[var(--kv-muted)]">{fmtNum(subs.length)} زیرسفارش · {fmtNum(pieces)} تکه</p>
        </div>
      </button>

      {perspective === "buyer" && payable.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--kv-line)] bg-[var(--kv-accent)]/[0.06] px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] font-bold"><CreditCard size={15} className="text-[var(--kv-accent)]" />{fmtNum(payable.length)} زیرسفارش تأیید شده و منتظر پرداخت شماست</p>
          <Btn variant="accent" size="sm" onClick={onPayAll}>پرداخت همه · {fmtMoney(payableTotal)}</Btn>
        </div>
      )}

      {open && (
        <div className="border-t border-[var(--kv-line)] animate-[fadeIn_0.25s_ease]">
          {subs.map((s, i) => <SubRow key={s.id} sub={s} index={i} perspective={perspective} onPay={onPaySub ? () => onPaySub(s.id) : undefined} onCancel={onCancelSub ? () => onCancelSub(s.id) : undefined} onReturn={onReturnSub ? () => onReturnSub(s.id) : undefined} />)}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 bg-[var(--kv-surface-2)]/40 px-5 py-3 text-xs text-[var(--kv-muted)]">
            <span className="flex items-center gap-1.5"><Truck size={13} />{order.shippingMethod}</span>
            <span className="flex items-center gap-1.5"><MapPin size={13} />{order.address}</span>
          </div>
        </div>
      )}
    </article>
  );
}

function SubRow({ sub, index, perspective, onPay, onCancel, onReturn }: { sub: SubOrder; index: number; perspective: "buyer" | "admin"; onPay?: () => void; onCancel?: () => void; onReturn?: () => void }) {
  const [hist, setHist] = useState(false);
  const terminal = isTerminal(sub.status);
  return (
    <div className={cn("px-5 py-4", index > 0 && "border-t border-dashed border-[var(--kv-line)]")}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-[var(--kv-faint)] tabular-nums">زیرسفارش {fmtNum(index + 1)} · {sub.id}</span>
            <SupplierChip id={sub.supplierId} name={sub.supplierName} />
            <Status value={SUB_STATUS[sub.status].label} />
          </div>
          <div className="mt-3 space-y-2">
            {sub.lines.map((l, i) => (
              <div key={i} className="flex items-center gap-3">
                <img src={l.image} alt="" className="h-14 w-12 shrink-0 rounded-[9px] object-cover" />
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-bold">{l.name}</p>
                  <p className="text-xs text-[var(--kv-muted)]">{l.seriesName} · {l.color} · {fmtNum(l.qtySeries)} سری ({fmtNum(l.pieces)} تکه)</p>
                </div>
                <p className="mr-auto shrink-0 text-[13px] font-extrabold tabular-nums">{fmtMoney(l.pricePerSeries * l.qtySeries)}</p>
              </div>
            ))}
          </div>
          {sub.note && <p className="mt-3 rounded-[10px] bg-[var(--kv-danger)]/[0.06] px-3 py-2 text-[12px] leading-6 text-[var(--kv-danger)]">توضیح تأمین‌کننده: {sub.note}</p>}
          {sub.tracking && <p className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--kv-muted)]"><Truck size={13} />کد رهگیری: <b className="tabular-nums text-[var(--kv-ink)]" dir="ltr">{sub.tracking}</b>{sub.eta && <span> · {sub.eta}</span>}</p>}
        </div>
        <div className="w-full sm:w-56">
          <SubProgress status={sub.status} />
          <div className="mt-3 flex flex-wrap gap-2">
            {perspective === "buyer" && sub.status === "approved" && onPay && <Btn variant="accent" size="sm" onClick={onPay} icon={<CreditCard size={14} />}>پرداخت این بخش</Btn>}
            {perspective === "buyer" && sub.status === "pending_supplier" && onCancel && <Btn variant="ghost" size="sm" onClick={onCancel} icon={<X size={14} />}>لغو</Btn>}
            {perspective === "buyer" && sub.status === "delivered" && onReturn && <Btn variant="soft" size="sm" onClick={onReturn} icon={<History size={14} />}>درخواست مرجوعی</Btn>}
            {perspective === "buyer" && sub.status === "approved" && <p className="w-full text-[11px] leading-5 text-[var(--kv-muted)]"><Clock size={11} className="inline" /> بعد از پرداخت، تأمین‌کننده آماده‌سازی را شروع می‌کند.</p>}
            {perspective === "admin" && !terminal && onCancel && <Btn variant="soft" size="sm" onClick={onCancel} icon={<Ban size={14} />}>لغو توسط کلبه</Btn>}
            <button onClick={() => setHist(!hist)} className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]"><History size={13} />{hist ? "بستن تاریخچه" : `تاریخچه (${fmtNum(sub.events.length)})`}</button>
          </div>
        </div>
      </div>
      {hist && (
        <div className="mt-4 rounded-[14px] bg-[var(--kv-surface-2)]/50 p-4 animate-[fadeIn_0.2s_ease]">
          <Timeline items={(sub.events ?? []).map((e) => ({ t: e.t, d: `توسط ${e.by}`, time: e.time, done: true }))} />
        </div>
      )}
    </div>
  );
}

/* ============ Operations desk — used by suppliers and by Kolbe's own ops team ============ */
export function SubOrderDesk({ items, actor, onTransition, emptyTitle, emptyDesc }: {
  items: { parent: ParentOrder; sub: SubOrder }[];
  actor: string;
  onTransition: (parentId: string, subId: string, status: SubStatus, extra?: { note?: string; tracking?: string; eta?: string }) => void;
  emptyTitle: string; emptyDesc: string;
}) {
  const sorted = [...items].sort((a, b) => rank(a.sub.status) - rank(b.sub.status));
  const [sel, setSel] = useState<string | null>(sorted[0]?.sub.id ?? null);
  const [note, setNote] = useState("");
  const [tracking, setTracking] = useState("");
  const cur = sorted.find((i) => i.sub.id === sel) ?? sorted[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <div className="space-y-2.5">
        {sorted.length === 0 && <Empty title={emptyTitle} desc={emptyDesc} />}
        {sorted.map(({ parent, sub }) => (
          <button key={sub.id} onClick={() => { setSel(sub.id); setNote(""); setTracking(""); }} className={cn("kv-press w-full rounded-[14px] border p-3.5 text-right transition-all", cur?.sub.id === sub.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.05] shadow-[var(--shadow-soft-sm)]" : "border-[var(--kv-line)] bg-[var(--kv-surface)] hover:border-[var(--kv-line-strong)]")}>
            <div className="flex items-center justify-between gap-2">
              <b className="text-[13px] tabular-nums">{sub.id}</b>
              <Status value={SUB_STATUS[sub.status].label} />
            </div>
            <p className="mt-1.5 truncate text-[12.5px] font-semibold">{parent.buyer}</p>
            <p className="mt-0.5 truncate text-[12px] text-[var(--kv-muted)]">{sub.lines.map((l) => `${l.name} × ${fmtNum(l.qtySeries)} سری`).join(" · ")}</p>
            <div className="mt-2 flex items-center justify-between text-[12px]"><span className="text-[var(--kv-faint)]">{parent.createdAt}</span><b className="tabular-nums">{fmtMoney(sub.total)}</b></div>
          </button>
        ))}
      </div>

      <Card className="h-fit p-6 lg:sticky lg:top-24">
        {!cur ? <Empty title="موردی انتخاب نشده" desc="از فهرست یک زیرسفارش را انتخاب کنید." /> : (() => {
          const { parent, sub } = cur;
          const pieces = (sub.lines ?? []).reduce((a, l) => a + l.pieces, 0);
          return (
            <div className="animate-[fadeIn_0.2s_ease]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-[var(--kv-muted)] tabular-nums">{sub.id} · بخشی از سفارش {parent.id}</p>
                  <h3 className="mt-1 text-[17px] font-extrabold">{parent.buyer}</h3>
                  <p className="mt-0.5 text-[12.5px] text-[var(--kv-muted)]">ثبت: {parent.createdAt} · ارسال با {parent.shippingMethod}</p>
                </div>
                <Status value={SUB_STATUS[sub.status].label} />
              </div>

              <div className="mt-4 overflow-hidden rounded-[14px] border border-[var(--kv-line)]">
                <table className="kv-table">
                  <thead><tr><th>محصول</th><th>سری</th><th>رنگ</th><th>تعداد</th><th>مبلغ</th></tr></thead>
                  <tbody>
                    {sub.lines.map((l, i) => (
                      <tr key={i}>
                        <td><span className="flex items-center gap-2.5"><img src={l.image} alt="" className="h-10 w-9 rounded-lg object-cover" /><b className="whitespace-nowrap">{l.name}</b></span></td>
                        <td>{l.seriesName}</td><td>{l.color}</td>
                        <td className="tabular-nums whitespace-nowrap">{fmtNum(l.qtySeries)} سری · {fmtNum(l.pieces)} تکه</td>
                        <td className="font-bold tabular-nums whitespace-nowrap">{fmtMoney(l.pricePerSeries * l.qtySeries)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--kv-surface-2)]/50 px-4 py-3 text-[13px]">
                  <span className="text-[var(--kv-muted)]">جمع {fmtNum(pieces)} تکه</span>
                  <b className="text-[15px] tabular-nums">{fmtMoney(sub.total)}</b>
                </div>
              </div>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-[var(--kv-muted)]"><MapPin size={13} />{parent.address}</p>

              <div className="mt-5"><SubProgress status={sub.status} /></div>

              <div className="mt-5 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 p-4">
                {sub.status === "pending_supplier" && (
                  <div className="space-y-3">
                    <p className="text-[13.5px] font-bold">آیا امکان تأمین این سفارش را دارید؟</p>
                    <Field label="توضیح برای خریدار (اختیاری)"><Textarea rows={2} placeholder="مثلاً: آماده ارسال ظرف ۵ روز کاری" value={note} onChange={setNote} /></Field>
                    <div className="flex flex-wrap gap-2">
                      <Btn variant="accent" size="sm" icon={<Check size={14} />} onClick={() => onTransition(parent.id, sub.id, "approved", note ? { note } : undefined)}>تأیید امکان تأمین</Btn>
                      <Btn variant="soft" size="sm" icon={<X size={14} />} onClick={() => onTransition(parent.id, sub.id, "rejected", { note: note || "امکان تأمین در حال حاضر وجود ندارد." })}>رد سفارش</Btn>
                    </div>
                  </div>
                )}
                {sub.status === "approved" && <p className="flex items-center gap-2 text-[13px] text-[var(--kv-muted)]"><Clock size={15} />تأیید شده؛ منتظر پرداخت خریدار. پس از پرداخت، آماده‌سازی را شروع کنید.</p>}
                {sub.status === "paid" && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[13px] font-bold">پرداخت انجام شده — سفارش را وارد آماده‌سازی کنید.</p>
                    <Btn variant="accent" size="sm" icon={<PackageCheck size={14} />} onClick={() => onTransition(parent.id, sub.id, "preparing")}>شروع آماده‌سازی</Btn>
                  </div>
                )}
                {sub.status === "preparing" && (
                  <div className="space-y-3">
                    <p className="text-[13.5px] font-bold">آماده‌سازی محصول</p>
                    <Btn variant="accent" size="sm" icon={<PackageCheck size={14} />} onClick={() => onTransition(parent.id, sub.id, "ready_to_ship")}>محصول آماده ارسال است</Btn>
                  </div>
                )}
                {sub.status === "ready_to_ship" && (
                  <div className="space-y-3">
                    <p className="text-[13.5px] font-bold">تحویل به شرکت حمل</p>
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      <Field label="کد رهگیری باربری"><Input placeholder="TPX-…" value={tracking} onChange={setTracking} /></Field>
                      <Field label="زمان تقریبی تحویل"><Input placeholder="۲ تا ۳ روز آینده" /></Field>
                    </div>
                    <Btn variant="accent" size="sm" icon={<Truck size={14} />} disabled={!tracking.trim()} onClick={() => onTransition(parent.id, sub.id, "in_transit", { tracking: tracking.trim(), eta: "تحویل تا ۳ روز آینده" })}>تحویل به باربری و ثبت رهگیری</Btn>
                  </div>
                )}
                {sub.status === "in_transit" && <Btn variant="accent" size="sm" onClick={() => onTransition(parent.id, sub.id, "shipped")}>ثبت ارسال از مبدا</Btn>}
                {sub.status === "shipped" && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[13px] text-[var(--kv-muted)]">در مسیر تحویل · {sub.tracking}</p>
                    <Btn variant="soft" size="sm" icon={<Check size={14} />} onClick={() => onTransition(parent.id, sub.id, "delivered")}>ثبت تحویل</Btn>
                  </div>
                )}
                {isTerminal(sub.status) && <p className="text-[13px] text-[var(--kv-muted)]">این زیرسفارش بسته شده است.{sub.note && ` توضیح: ${sub.note}`}</p>}
              </div>

              <p className="mb-3 mt-5 text-[13px] font-bold">تاریخچه</p>
              <Timeline items={(sub.events ?? []).map((e) => ({ t: e.t, d: `توسط ${e.by}`, time: e.time, done: true }))} />
              <p className="mt-4 text-[11px] text-[var(--kv-faint)]">اقدام‌کننده فعلی: {actor}</p>
            </div>
          );
        })()}
      </Card>
    </div>
  );
}

function rank(s: SubStatus) {
  return ({ pending_supplier: 0, paid: 1, preparing: 2, shipped: 3, approved: 4, delivered: 5, rejected: 6, cancelled: 7 } as Record<SubStatus, number>)[s];
}
