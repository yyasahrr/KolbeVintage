import { useEffect, useState } from "react";
import { Check, Clock, Landmark, Lock, ShieldCheck, Wallet } from "lucide-react";
import { fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { useOps, opsNow, bankFromIban, isValidCard, isValidIban, normalizeIban, type SupplierBank, type Withdrawal } from "../data/ops";
import { Kpi } from "../components/charts";
import { Btn, Card, Empty, Field, Input, Status } from "../components/primitives";
import { supplierFinanceApi } from "../data/api";

export const MIN_WITHDRAW = 1000000;
const WD_LABEL: Record<Withdrawal["status"], string> = { requested: "در انتظار", approved: "تأیید شد", paid: "پرداخت شد", rejected: "رد شد" };

/** Wallet math shared by supplier panel and admin finance. */
export function useWallet(supplierId: string) {
  const { orders } = useStore();
  const ops = useOps();
  const rate = ops.commissions[supplierId] ?? 8;
  const subs = orders.flatMap((o) => (o.subOrders ?? []).filter((s) => s.supplierId === supplierId).map((s) => ({ o, s })));
  const settled = subs.filter((x) => x.s.status === "delivered");
  const escrow = subs.filter((x) => ["paid", "preparing", "ready_to_ship", "in_transit", "shipped"].includes(x.s.status));
  const gross = settled.reduce((a, x) => a + x.s.total, 0);
  const commission = Math.round(gross * rate / 100);
  const escrowNet = Math.round(escrow.reduce((a, x) => a + x.s.total, 0) * (1 - rate / 100));
  const withdrawals = ops.withdrawals.filter((w) => w.supplierId === supplierId);
  const locked = withdrawals.filter((w) => w.status !== "rejected").reduce((a, w) => a + w.amount, 0);
  const inFlight = withdrawals.filter((w) => w.status === "requested" || w.status === "approved").reduce((a, w) => a + w.amount, 0);
  const balance = Math.max(0, gross - commission - locked);
  type Entry = { id: string; title: string; amount: number; kind: "sale" | "fee" | "payout"; at: string };
  const ledger: Entry[] = [
    ...settled.flatMap((x) => [
      { id: `${x.s.id}-s`, title: `فروش ${x.s.id} · ${x.o.buyer}`, amount: x.s.total, kind: "sale" as const, at: x.s.events[x.s.events.length - 1]?.time ?? x.o.createdAt },
      { id: `${x.s.id}-f`, title: `کمیسیون کلبه ${fmtNum(rate)}٪ · ${x.s.id}`, amount: -Math.round(x.s.total * rate / 100), kind: "fee" as const, at: x.s.events[x.s.events.length - 1]?.time ?? x.o.createdAt },
    ]),
    ...withdrawals.filter((w) => w.status !== "rejected").map((w) => ({ id: w.id, title: `برداشت ${w.id} · ${WD_LABEL[w.status]}`, amount: -w.amount, kind: "payout" as const, at: w.createdAt })),
  ];
  return { rate, gross, commission, escrowNet, balance, inFlight, withdrawals, ledger, settledCount: settled.length, escrowCount: escrow.length };
}

export function SupplierWallet({ supplierId, supplierName, noWithdraw, onBank }: { supplierId: string; supplierName: string; noWithdraw?: boolean; onBank: () => void }) {
  void supplierId; void supplierName; void noWithdraw; void onBank;
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  type Row = Record<string, unknown>;
  const [view, setView] = useState<"overview" | "sales" | "ledger" | "holds" | "settlements" | "bank">("overview");
  const [summary, setSummary] = useState<Row | null>(null);
  const [payables, setPayables] = useState<Row[]>([]);
  const [holds, setHolds] = useState<Row[]>([]);
  const [settlements, setSettlements] = useState<Row[]>([]);
  const [ledger, setLedger] = useState<Row[]>([]);
  const [detail, setDetail] = useState<Row | null>(null);
  const load = () => {
    if (isDemo) return;
    supplierFinanceApi.summary().then(setSummary).catch(() => setSummary(null));
    supplierFinanceApi.payables({ pageSize: 50 }).then((r) => setPayables(r.items)).catch(() => setPayables([]));
    supplierFinanceApi.holds().then((r) => setHolds(r.items)).catch(() => setHolds([]));
    supplierFinanceApi.settlements().then((r) => setSettlements(r.items)).catch(() => setSettlements([]));
    supplierFinanceApi.ledger({ pageSize: 50 }).then((r) => setLedger(r.items)).catch(() => setLedger([]));
  };
  useEffect(load, [isDemo]);
  const toman = (rial: unknown) => fmtMoney(Math.round(Number(rial ?? 0) / 10));
  const dt = (v: unknown) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");
  const PAYABLE_LABEL: Record<string, string> = { held: "دوره نگهداری", blocked: "مسدود", eligible: "آماده تسویه", scheduled: "در تسویه", settled: "تسویه‌شده", cancelled: "لغو شد" };
  const SETTLE_LABEL: Record<string, string> = { pending: "در بررسی مالی", approved: "تأیید شده", processing: "در حال پردازش", paid: "پرداخت شد", reconciled: "مغایرت‌گیری شد", cancelled: "لغو شد", failed: "ناموفق" };
  const HOLD_LABEL: Record<string, string> = { active: "فعال", blocked: "مسدود", released: "آزاد شد", cancelled: "لغو شد" };
  const TABS = [
    { v: "overview", label: "خلاصه" }, { v: "sales", label: "فروش‌ها" }, { v: "ledger", label: "تراکنش‌ها" },
    { v: "holds", label: "Holds" }, { v: "settlements", label: "تسویه‌ها" }, { v: "bank", label: "حساب بانکی" },
  ] as const;
  return (
    <div className="space-y-5">
      {/* Settlement buckets (§186) — NO withdraw button: scheduled settlements replace withdrawals (§7). */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <Kpi label="در انتظار تکمیل سفارش" value={toman(summary?.pendingFulfillmentRial)} hint={`${fmtNum(Number(summary?.pendingFulfillmentOrders ?? 0))} زیرسفارش در جریان`} />
        <Kpi label="دوره نگهداری (Hold)" value={toman(summary?.heldRial)} hint={summary?.nextHoldReleaseAt ? `آزادسازی بعدی ${dt(summary.nextHoldReleaseAt)}` : "پس از تحویل شروع می‌شود"} />
        <Kpi label="آماده تسویه" value={toman(summary?.eligibleRial)} hint="در تسویه زمان‌بندی‌شده بعدی" />
        <Kpi label="تسویه بعدی" value={String(summary?.nextSettlementDate ?? "—")} hint={String((summary?.policy as Row | undefined)?.name ?? "طبق سیاست تسویه")} />
        <Kpi label="تسویه‌شده" value={toman(summary?.settledRial)} hint="واریز شده به حساب بانکی" />
        <Kpi label="مسدود" value={toman(summary?.blockedRial)} hint={Number(summary?.openRecoveryRial ?? 0) > 0 ? `بدهی Recovery: ${toman(summary?.openRecoveryRial)}` : "موارد دارای مغایرت"} />
      </div>
      <div className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)] px-4 py-3 text-[12.5px] leading-6 text-[var(--kv-muted)]">
        <span className="font-bold text-[var(--kv-text)]">تسویه خودکار جایگزین درخواست برداشت شده است.</span>{" "}
        مبلغ هر زیرسفارش پس از تحویل و طی دوره نگهداری، در نزدیک‌ترین تاریخ تسویه ({String(summary?.nextSettlementDate ?? "—")}) به حساب بانکی تأییدشده شما واریز می‌شود.
      </div>
      <div className="kv-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {TABS.map((t) => (
          <button key={t.v} onClick={() => { setView(t.v); setDetail(null); }}
            className={`kv-press shrink-0 rounded-[10px] px-3 py-2 text-[12.5px] font-bold ${view === t.v ? "bg-[var(--kv-action)] text-[var(--kv-bg)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)] hover:text-[var(--kv-text)]"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {view === "overview" && (
        <Card className="p-5">
          <p className="mb-3 text-[14px] font-extrabold">چرخه مالی هر زیرسفارش</p>
          <ol className="grid gap-2 text-[12.5px] leading-6 text-[var(--kv-muted)] sm:grid-cols-5">
            {["تحویل زیرسفارش", "دوره نگهداری (Hold)", "آماده تسویه", "تسویه زمان‌بندی‌شده و تأیید مالی", "واریز بانکی و ثبت کد پیگیری"].map((step, i) => (
              <li key={step} className="rounded-[10px] border border-[var(--kv-line)] px-3 py-2"><span className="font-bold text-[var(--kv-accent)]">{fmtNum(i + 1)}.</span> {step}</li>
            ))}
          </ol>
          <p className="mt-3 text-[12px] text-[var(--kv-muted)]">هر مبلغ به تفکیک فروش ناخالص، کمیسیون، سهم ارسال و بازپرداخت قابل ردیابی است — هیچ عدد مبهمی وجود ندارد.</p>
        </Card>
      )}

      {view === "sales" && (
        <Card className="overflow-hidden">
          <p className="p-4 text-[14px] font-extrabold">فروش‌ها (به تفکیک زیرسفارش)</p>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[820px]"><thead>
            <tr><th>سند</th><th>زیرسفارش</th><th>ناخالص</th><th>کمیسیون</th><th>سهم ارسال</th><th>بازپرداخت</th><th>خالص</th><th>وضعیت</th><th>تاریخ</th></tr></thead><tbody>
            {payables.map((p) => (
              <tr key={String(p.id)}>
                <td className="tabular-nums" dir="ltr">{String(p.reference)}</td>
                <td className="tabular-nums" dir="ltr">{String(p.child_reference)}</td>
                <td className="tabular-nums">{toman(p.gross_rial)}</td>
                <td className="tabular-nums text-[var(--kv-danger)]">{toman(p.commission_rial)} ({fmtNum(Number(p.commission_percent ?? 0))}٪)</td>
                <td className="tabular-nums">{toman(p.shipping_share_rial)}</td>
                <td className="tabular-nums">{toman(p.refunds_rial)}</td>
                <td className="tabular-nums font-bold text-[var(--kv-success)]">{toman(p.net_rial)}</td>
                <td><Status value={PAYABLE_LABEL[String(p.status)] ?? String(p.status)} /></td>
                <td className="text-[11px] text-[var(--kv-muted)]">{dt(p.created_at)}</td>
              </tr>
            ))}
            {payables.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-[var(--kv-muted)]">پس از تحویل اولین زیرسفارش، صورت مالی آن اینجا ثبت می‌شود.</td></tr>}
          </tbody></table></div>
        </Card>
      )}

      {view === "ledger" && (
        <Card className="overflow-hidden">
          <p className="p-4 text-[14px] font-extrabold">تراکنش‌ها (دفتر کل)</p>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[640px]"><thead>
            <tr><th>رویداد</th><th>شرح</th><th>مبلغ</th><th>مانده</th><th>مرجع</th><th>زمان</th></tr></thead><tbody>
            {ledger.map((e) => (
              <tr key={String(e.id)}>
                <td>{String(e.event)}</td><td className="text-[12px]">{String(e.description ?? "—")}</td>
                <td className={`font-bold tabular-nums ${e.direction === "debit" ? "text-[var(--kv-danger)]" : "text-[var(--kv-success)]"}`} dir="ltr">{e.direction === "debit" ? "−" : "+"}{fmtNum(Math.round(Number(e.amount_rial) / 10))}</td>
                <td className="tabular-nums">{toman(e.balance_after_rial)}</td>
                <td className="text-[11px]" dir="ltr">{String(e.reference)}</td>
                <td className="text-[11px] text-[var(--kv-muted)]">{dt(e.occurred_at)}</td>
              </tr>
            ))}
            {ledger.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-[var(--kv-muted)]">هنوز تراکنشی ثبت نشده است.</td></tr>}
          </tbody></table></div>
        </Card>
      )}

      {view === "holds" && (
        <Card className="overflow-hidden">
          <p className="p-4 text-[14px] font-extrabold">دوره‌های نگهداری (Settlement Hold)</p>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[640px]"><thead>
            <tr><th>زیرسفارش</th><th>مبلغ</th><th>وضعیت</th><th>آزادسازی</th><th>دلیل</th></tr></thead><tbody>
            {holds.map((h) => (
              <tr key={String(h.id)}>
                <td className="tabular-nums" dir="ltr">{String(h.child_reference)}</td>
                <td className="tabular-nums font-bold">{toman(h.amount_rial)}</td>
                <td><Status value={HOLD_LABEL[String(h.status)] ?? String(h.status)} /></td>
                <td className="text-[12px]">{h.released_at ? `آزاد شد ${dt(h.released_at)}` : dt(h.release_at)}</td>
                <td className="text-[12px] text-[var(--kv-muted)]">{String(h.blocked_reason ?? h.reason ?? "—")}</td>
              </tr>
            ))}
            {holds.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-[var(--kv-muted)]">Hold فعالی ندارید.</td></tr>}
          </tbody></table></div>
          <p className="px-4 pb-4 text-[11.5px] text-[var(--kv-muted)]"><Clock size={12} className="mb-0.5 inline" /> پس از پایان دوره نگهداری، مبلغ به «آماده تسویه» منتقل می‌شود و در نزدیک‌ترین تاریخ تسویه واریز می‌شود.</p>
        </Card>
      )}

      {view === "settlements" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Card className="overflow-hidden">
            <p className="p-4 text-[14px] font-extrabold">تسویه‌ها و صورت‌حساب‌ها</p>
            <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[560px]"><thead>
              <tr><th>سند</th><th>خالص</th><th>وضعیت</th><th>واریز</th><th></th></tr></thead><tbody>
              {settlements.map((x) => (
                <tr key={String(x.id)}>
                  <td className="tabular-nums" dir="ltr">{String(x.reference)}</td>
                  <td className="tabular-nums font-bold">{toman(x.net_rial)}</td>
                  <td><Status value={SETTLE_LABEL[String(x.status)] ?? String(x.status)} /></td>
                  <td className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{x.paid_reference ? `${String(x.paid_reference)} · ${dt(x.paid_at)}` : "—"}</td>
                  <td><button className="text-[12px] font-bold text-[var(--kv-accent)]" onClick={() => void supplierFinanceApi.settlement(String(x.id)).then(setDetail).catch(() => setDetail(null))}>جزئیات</button></td>
                </tr>
              ))}
              {settlements.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-[var(--kv-muted)]">اولین تسویه پس از رسیدن تاریخ تسویه ساخته می‌شود.</td></tr>}
            </tbody></table></div>
          </Card>
          <Card className="p-4">
            {detail ? (
              <div className="space-y-2 text-[12.5px]">
                <p className="text-[14px] font-extrabold" dir="ltr">{String(detail.reference)}</p>
                {([["فروش ناخالص", detail.gross_rial], ["کمیسیون", detail.commission_rial], ["سهم ارسال", detail.shipping_rial],
                  ["بازپرداخت‌ها", detail.returns_rial], ["کسر Recovery", detail.recovery_offset_rial], ["خالص واریز", detail.net_rial]] as const).map(([label, v]) => (
                  <div key={label} className="flex items-center justify-between border-b border-[var(--kv-line)] py-1.5"><span className="text-[var(--kv-muted)]">{label}</span><b className="tabular-nums">{toman(v)}</b></div>
                ))}
                {detail.bank ? <p className="pt-1 text-[12px] text-[var(--kv-muted)]">مقصد: {String((detail.bank as Row).bankName)} · <span dir="ltr" className="tabular-nums">{String((detail.bank as Row).ibanMasked)}</span></p> : null}
                {detail.paid_reference ? <p className="text-[12px] text-[var(--kv-success)]">کد پیگیری بانکی: <span dir="ltr">{String(detail.paid_reference)}</span></p> : null}
                <div className="pt-2">
                  <p className="mb-1 font-bold">اقلام ({fmtNum(((detail.lines as Row[]) ?? []).length)})</p>
                  {((detail.lines as Row[]) ?? []).map((l) => (
                    <p key={String(l.id)} className="flex justify-between py-0.5 text-[12px]"><span dir="ltr">{String(l.order_reference)}</span><b className="tabular-nums">{toman(l.net_rial)}</b></p>
                  ))}
                </div>
              </div>
            ) : <Empty title="جزئیات تسویه" desc="برای مشاهده اجزای مبلغ و اقلام، یک تسویه را انتخاب کنید." />}
          </Card>
        </div>
      )}

      {view === "bank" && <SupplierBankAccounts />}
      <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]"><ShieldCheck size={12} />{isDemo ? "در نسخه آزمایشی (demo) داده مالی سرور در دسترس نیست." : "تمام مبالغ از دفتر کل سرور خوانده می‌شود؛ واریز فقط به حساب بانکی تأییدشده انجام می‌گیرد."}</p>
    </div>
  );
}

/** Server-backed verified bank accounts (§43-§47): pending → verified by finance;
 *  a new account always starts unverified; archive is blocked mid-settlement. */
export function SupplierBankAccounts() {
  type Row = Record<string, unknown>;
  const [items, setItems] = useState<Row[]>([]);
  const [f, setF] = useState({ bankName: "", iban: "", holderName: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => supplierFinanceApi.bankAccounts().then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  const BANK_LABEL: Record<string, string> = { pending_verification: "در انتظار تأیید", verified: "تأیید شده", rejected: "رد شد", disabled: "غیرفعال", archived: "بایگانی" };
  const submit = async () => {
    setMsg(null);
    const iban = normalizeIban(f.iban);
    if (!f.bankName.trim() || !f.holderName.trim()) return setMsg({ ok: false, text: "نام بانک و صاحب حساب الزامی است." });
    if (!isValidIban(iban)) return setMsg({ ok: false, text: "شماره شبا باید با IR شروع شود و ۲۴ رقم معتبر داشته باشد." });
    try {
      await supplierFinanceApi.addBankAccount({ bankName: f.bankName.trim(), iban, holderName: f.holderName.trim() });
      setF({ bankName: "", iban: "", holderName: "" });
      setMsg({ ok: true, text: "حساب ثبت شد و پس از تأیید واحد مالی برای تسویه استفاده می‌شود." });
      void load();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "خطا در ثبت حساب" }); }
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card className="overflow-hidden">
        <p className="p-4 text-[14px] font-extrabold">حساب‌های بانکی تسویه</p>
        <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[560px]"><thead>
          <tr><th>بانک</th><th>شبا</th><th>صاحب حساب</th><th>وضعیت</th><th></th></tr></thead><tbody>
          {items.map((b) => (
            <tr key={String(b.id)}>
              <td>{String(b.bank_name)}{b.is_primary ? " · اصلی" : ""}</td>
              <td className="tabular-nums" dir="ltr">{String(b.iban)}</td>
              <td>{String(b.holder_name)}</td>
              <td><Status value={BANK_LABEL[String(b.status)] ?? String(b.status)} />{b.rejected_reason ? <p className="text-[11px] text-[var(--kv-danger)]">{String(b.rejected_reason)}</p> : null}</td>
              <td><button className="text-[12px] font-bold text-[var(--kv-danger)]" onClick={() => void supplierFinanceApi.archiveBankAccount(String(b.id)).then(load).catch((e) => setMsg({ ok: false, text: e instanceof Error ? e.message : "خطا" }))}>حذف</button></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-[var(--kv-muted)]">برای دریافت تسویه، یک حساب بانکی ثبت کنید.</td></tr>}
        </tbody></table></div>
      </Card>
      <Card className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-[14px] font-extrabold"><Landmark size={16} className="text-[var(--kv-accent)]" />افزودن حساب جدید</p>
        <Field label="نام بانک"><Input value={f.bankName} onChange={(v) => setF((p) => ({ ...p, bankName: v }))} /></Field>
        <Field label="شماره شبا" hint={f.iban ? (isValidIban(normalizeIban(f.iban)) ? `معتبر · ${bankFromIban(f.iban) || "بانک نامشخص"}` : "قالب شبا درست نیست") : "IR و ۲۴ رقم"}><Input value={f.iban} onChange={(v) => setF((p) => ({ ...p, iban: v.toUpperCase(), bankName: bankFromIban(v) || p.bankName }))} placeholder="IR000000000000000000000000" /></Field>
        <Field label="نام صاحب حساب"><Input value={f.holderName} onChange={(v) => setF((p) => ({ ...p, holderName: v }))} /></Field>
        <Btn variant="accent" className="w-full" onClick={() => void submit()}>ثبت برای تأیید مالی</Btn>
        {msg && <p role="status" className={`text-[12px] leading-6 ${msg.ok ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]"}`}>{msg.text}</p>}
        <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]"><Lock size={12} className="mb-0.5 inline" /> حساب جدید همیشه «در انتظار تأیید» ثبت می‌شود؛ تغییر حساب، تأیید قبلی را منتقل نمی‌کند و واریز فقط به حساب تأییدشده انجام می‌گیرد.</p>
      </Card>
    </div>
  );
}

const blankBank = (): SupplierBank => ({ legalName: "", nationalId: "", economicCode: "", holder: "", iban: "", card: "", bankName: "", address: "", postalCode: "", status: "draft" });

export function SupplierBankForm({ supplierId }: { supplierId: string }) {
  const ops = useOps();
  const saved = ops.banks[supplierId];
  const [f, setF] = useState<SupplierBank>(saved ?? blankBank());
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState("");
  const set = (k: keyof SupplierBank, v: string) => { setF((p) => ({ ...p, [k]: v, ...(k === "iban" ? { bankName: bankFromIban(v) || p.bankName } : {}) })); setDone(""); };
  const submit = () => {
    const e: string[] = [];
    if (!f.legalName.trim()) e.push("نام حقوقی یا نام کامل را وارد کنید.");
    if (!/^\d{10,11}$/.test(f.nationalId.replace(/\D/g, ""))) e.push("شناسه ملی (۱۱ رقم) یا کد ملی (۱۰ رقم) معتبر نیست.");
    if (!f.holder.trim()) e.push("نام صاحب حساب را وارد کنید.");
    if (!isValidIban(f.iban)) e.push("شماره شبا باید با IR شروع شود، ۲۴ رقم داشته باشد و رقم کنترل آن درست باشد.");
    if (f.card && !isValidCard(f.card)) e.push("شماره کارت ۱۶ رقمی معتبر نیست.");
    if (!/^\d{10}$/.test(f.postalCode.replace(/\D/g, ""))) e.push("کد پستی ۱۰ رقمی وارد کنید.");
    setErrors(e);
    if (e.length) return;
    ops.set("banks", { ...ops.banks, [supplierId]: { ...f, iban: normalizeIban(f.iban), card: f.card.replace(/\D/g, ""), status: "pending", updatedAt: opsNow(), note: undefined } });
    setDone("اطلاعات برای تأیید به واحد مالی کلبه ارسال شد. تا زمان تأیید، برداشت غیرفعال است.");
  };
  const status = saved?.status ?? "draft";
  const LABEL = { draft: "ثبت نشده", pending: "در انتظار تأیید", verified: "تأیید شد", rejected: "رد شد" } as const;
  return (
    <div className="max-w-[760px] space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-4">
        <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--kv-surface-2)] text-[var(--kv-accent)]"><Landmark size={18} /></span><div><p className="text-[14px] font-extrabold">وضعیت احراز مالی</p><p className="text-[12px] text-[var(--kv-muted)]">{saved?.updatedAt ? `آخرین به‌روزرسانی ${saved.updatedAt}` : "برای دریافت تسویه، اطلاعات زیر را کامل کنید"}{saved?.note ? ` · ${saved.note}` : ""}</p></div></div>
        <Status value={LABEL[status]} />
      </div>
      <section className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
        <h3 className="mb-4 flex items-center gap-2 text-[14px] font-extrabold"><ShieldCheck size={16} className="text-[var(--kv-accent)]" />اطلاعات حقوقی</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام حقوقی شرکت یا نام کامل"><Input value={f.legalName} onChange={(v) => set("legalName", v)} /></Field>
          <Field label="شناسه ملی / کد ملی"><Input value={f.nationalId} onChange={(v) => set("nationalId", v.replace(/[^\d۰-۹]/g, ""))} /></Field>
          <Field label="کد اقتصادی (اختیاری)"><Input value={f.economicCode} onChange={(v) => set("economicCode", v)} /></Field>
          <Field label="کد پستی"><Input value={f.postalCode} onChange={(v) => set("postalCode", v.replace(/[^\d۰-۹]/g, ""))} /></Field>
          <div className="sm:col-span-2"><Field label="نشانی دفتر یا کارگاه"><Input value={f.address} onChange={(v) => set("address", v)} /></Field></div>
        </div>
      </section>
      <section className="rounded-[16px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
        <h3 className="mb-4 flex items-center gap-2 text-[14px] font-extrabold"><Wallet size={16} className="text-[var(--kv-accent)]" />حساب بانکی تسویه</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام صاحب حساب" hint="باید با نام حقوقی یا مسئول یکی باشد"><Input value={f.holder} onChange={(v) => set("holder", v)} /></Field>
          <Field label="شماره شبا" hint={f.iban ? (isValidIban(f.iban) ? `معتبر · ${bankFromIban(f.iban) || "بانک نامشخص"}` : "قالب یا رقم کنترل شبا درست نیست") : "IR و ۲۴ رقم"}><Input value={f.iban} onChange={(v) => set("iban", v.toUpperCase())} placeholder="IR000000000000000000000000" /></Field>
          <Field label="شماره کارت (اختیاری)" hint={f.card ? (isValidCard(f.card) ? "معتبر" : "شماره کارت معتبر نیست") : undefined}><Input value={f.card} onChange={(v) => set("card", v.replace(/[^\d۰-۹-\s]/g, ""))} placeholder="۶۰۳۷ ۹۹۱۱ ۲۲۳۳ ۴۴۵۵" /></Field>
          <Field label="نام بانک"><Input value={f.bankName} onChange={(v) => set("bankName", v)} placeholder="از روی شبا تشخیص داده می‌شود" /></Field>
        </div>
      </section>
      {errors.length > 0 && <ul role="alert" className="space-y-1 rounded-[12px] bg-[var(--kv-danger)]/[0.06] p-4 text-[12.5px] text-[var(--kv-danger)]">{errors.map((e) => <li key={e}>• {e}</li>)}</ul>}
      {done && <p role="status" className="flex items-center gap-2 text-[12.5px] font-semibold text-[var(--kv-success)]"><Check size={15} />{done}</p>}
      <div className="flex flex-wrap items-center gap-3"><Btn variant="accent" onClick={submit}>ارسال برای تأیید مالی</Btn>{status === "verified" && <p className="text-[12px] text-[var(--kv-muted)]">ویرایش اطلاعات تأییدشده، برداشت را تا تأیید مجدد متوقف می‌کند.</p>}</div>
    </div>
  );
}

export function WithdrawalEmpty() { return <Empty title="درخواستی نیست" desc="درخواست‌های برداشت تأمین‌کنندگان اینجا نمایش داده می‌شود." />; }
