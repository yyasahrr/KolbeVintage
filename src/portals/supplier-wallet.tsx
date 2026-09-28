import { useEffect, useState } from "react";
import { ArrowDownToLine, Banknote, Check, Clock, Landmark, Lock, ShieldCheck, Wallet } from "lucide-react";
import { fmtMoney, fmtNum } from "../data/catalog";
import { useStore } from "../data/store";
import { useOps, opsNow, bankFromIban, isValidCard, isValidIban, normalizeIban, type SupplierBank, type Withdrawal } from "../data/ops";
import { AreaChart, DonutChart, Kpi } from "../components/charts";
import { Btn, Card, Empty, Field, Input, Status } from "../components/primitives";
import { apiClient, walletApi } from "../data/api";

export const MIN_WITHDRAW = 1000000;
const WD_LABEL: Record<Withdrawal["status"], string> = { requested: "در انتظار", approved: "تأیید شد", paid: "پرداخت شد", rejected: "رد شد" };

/** Wallet math shared by supplier panel and admin finance. */
export function useWallet(supplierId: string) {
  const { orders } = useStore();
  const ops = useOps();
  const rate = ops.commissions[supplierId] ?? 8;
  const subs = orders.flatMap((o) => o.subOrders.filter((s) => s.supplierId === supplierId).map((s) => ({ o, s })));
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
  const ops = useOps();
  const w = useWallet(supplierId);
  const bank = ops.banks[supplierId];
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  // Server ledger is canonical: GET /wallet + /wallet/entries + /wallet/withdrawals
  const [server, setServer] = useState<{ availableRial: string; pendingRial: string; totals: Record<string, string> } | null>(null);
  const [serverEntries, setServerEntries] = useState<{ id: string; kind: string; direction: string; amount_rial: string; reference: string | null; created_at: string }[]>([]);
  const [serverWithdrawals, setServerWithdrawals] = useState<{ id: string; reference: string; amount_rial: string; status: string; destination: unknown; requested_at: string }[]>([]);
  const loadServer = () => {
    if (isDemo) return;
    apiClient.get<{ availableRial: string; pendingRial: string; totals: Record<string, string> }>("/wallet").then(setServer).catch(() => setServer(null));
    apiClient.get<{ items: typeof serverEntries }>("/wallet/entries?limit=30").then((r) => setServerEntries(r.items)).catch(() => setServerEntries([]));
    apiClient.get<{ items: typeof serverWithdrawals }>("/wallet/withdrawals").then((r) => setServerWithdrawals(r.items)).catch(() => setServerWithdrawals([]));
  };
  useEffect(loadServer, [isDemo]);
  const serverBalanceToman = server ? Math.round(Number(server.availableRial) / 10) : null;
  const serverPendingToman = server ? Math.round(Number(server.pendingRial) / 10) : null;
  const serverInFlightToman = serverWithdrawals.filter((x) => x.status === "requested" || x.status === "approved").reduce((a, x) => a + Math.round(Number(x.amount_rial) / 10), 0);
  let run = 0;
  const points = w.ledger.map((e) => (run += e.amount));
  const requestServer = async (a: number) => {
    try {
      // Canonical wallet domain: payload + Idempotency-Key are handled by the client.
      await walletApi.withdraw(
        { amountRial: String(a * 10), destination: { bankName: bank?.bankName ?? "", iban: bank?.iban ?? "", holderName: bank?.holder ?? "" } },
        `wd-${crypto.randomUUID().replace(/-/g, "")}`,
      );
      loadServer();
      setAmount("");
      setMsg({ ok: true, text: "درخواست برداشت روی سرور ثبت شد و پس از تأیید مالی کلبه تسویه می‌شود." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "خطا در ثبت برداشت" }); }
  };
  const request = () => {
    const a = Number(amount.replace(/\D/g, ""));
    if (!isDemo) {
      if (noWithdraw) return setMsg({ ok: false, text: "برداشت برای حساب شما توسط کلبه محدود شده است. از پشتیبانی پیگیری کنید." });
      if (a < MIN_WITHDRAW) return setMsg({ ok: false, text: `حداقل مبلغ برداشت ${fmtMoney(MIN_WITHDRAW)} است.` });
      if (serverBalanceToman !== null && a > serverBalanceToman) return setMsg({ ok: false, text: "مبلغ از موجودی قابل برداشت سرور بیشتر است." });
      void requestServer(a);
      return;
    }
    if (noWithdraw) return setMsg({ ok: false, text: "برداشت برای حساب شما توسط کلبه محدود شده است. از پشتیبانی پیگیری کنید." });
    if (!bank || bank.status !== "verified") return setMsg({ ok: false, text: "ابتدا اطلاعات بانکی باید توسط کلبه تأیید شود." });
    if (a < MIN_WITHDRAW) return setMsg({ ok: false, text: `حداقل مبلغ برداشت ${fmtMoney(MIN_WITHDRAW)} است.` });
    if (a > w.balance) return setMsg({ ok: false, text: "مبلغ از موجودی قابل برداشت بیشتر است." });
    ops.upsert("withdrawals", { id: `WD-${Date.now().toString().slice(-4)}`, supplierId, supplierName, amount: a, status: "requested", createdAt: opsNow(), iban: bank.iban }, true);
    setAmount(""); setMsg({ ok: true, text: "درخواست برداشت ثبت شد و پس از تأیید مالی کلبه به شبای شما واریز می‌شود." });
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="موجودی قابل برداشت" value={fmtMoney(serverBalanceToman ?? w.balance)} hint={server ? "دفتر کل سرور (ریال)" : "پس از کسر کمیسیون"} />
        <Kpi label="در امانت (سفارش‌های در جریان)" value={fmtMoney(server ? (serverPendingToman ?? 0) : w.escrowNet)} hint={server ? "مانده در انتظار تسویه (سرور)" : `${fmtNum(w.escrowCount)} زیرسفارش · پس از تحویل آزاد می‌شود`} />
        <Kpi label="در حال واریز" value={fmtMoney(server ? serverInFlightToman : w.inFlight)} hint={server ? "از /wallet/withdrawals" : "درخواست‌های تأییدنشده یا در صف"} />
        <Kpi label={`کمیسیون کلبه (${fmtNum(w.rate)}٪)`} value={fmtMoney(w.commission)} hint={`از ${fmtNum(w.settledCount)} فروش تسویه‌شده`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
          <p className="text-[15px] font-extrabold">روند موجودی کیف پول</p>
          <p className="mb-3 text-xs text-[var(--kv-muted)]">مانده تجمعی پس از هر فروش، کمیسیون و برداشت</p>
          {points.length > 1 ? <AreaChart labels={w.ledger.map((e) => e.id.replace(/-[sf]$/, ""))} series={[{ name: "مانده کیف پول", color: "var(--kv-accent)", values: points.map((p) => Math.max(0, p)) }]} height={200} /> : <p className="py-10 text-center text-[13px] text-[var(--kv-muted)]">پس از اولین فروش تحویل‌شده، روند موجودی نمایش داده می‌شود.</p>}
        </div>
        <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
          <p className="mb-4 text-[15px] font-extrabold">ترکیب درآمد</p>
          <DonutChart center={fmtMoney(w.gross + w.escrowNet).replace(" تومان", "")} sub="تومان" segs={[
            { label: "سهم خالص شما (تسویه‌شده)", value: w.gross - w.commission, color: "var(--kv-success)" },
            { label: "کمیسیون کلبه", value: w.commission, color: "var(--kv-accent)" },
            { label: "در امانت", value: w.escrowNet, color: "#D6A94E" },
          ]} />
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-hidden rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)]">
          <p className="p-5 pb-3 text-[15px] font-extrabold">دفتر تراکنش‌ها</p>
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[560px]">
              <thead><tr><th>شرح</th><th>نوع</th><th>زمان</th><th>مبلغ</th></tr></thead>
              <tbody>
                {w.ledger.map((e) => <tr key={e.id}><td>{e.title}</td><td>{e.kind === "sale" ? "فروش" : e.kind === "fee" ? "کمیسیون" : "برداشت"}</td><td className="text-[var(--kv-muted)]">{e.at}</td><td className={`font-bold tabular-nums ${e.amount < 0 ? "text-[var(--kv-danger)]" : "text-[var(--kv-success)]"}`} dir="ltr">{e.amount < 0 ? "−" : "+"}{fmtNum(Math.abs(e.amount))}</td></tr>)}
                {w.ledger.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-[var(--kv-muted)]">هنوز تراکنشی ثبت نشده است.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
            <p className="flex items-center gap-2 text-[15px] font-extrabold"><ArrowDownToLine size={17} className="text-[var(--kv-accent)]" />درخواست برداشت</p>
            {bank?.status === "verified" ? <p className="mt-2 text-[12px] leading-6 text-[var(--kv-muted)]">واریز به {bank.bankName || "حساب"} · <span dir="ltr" className="tabular-nums">{bank.iban.slice(0, 6)}…{bank.iban.slice(-4)}</span> · {bank.holder}</p>
              : <button onClick={onBank} className="mt-2 flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-danger)]"><Lock size={13} />اطلاعات بانکی {bank?.status === "pending" ? "در انتظار تأیید کلبه است" : "ثبت نشده"} — تکمیل اطلاعات</button>}
            <div className="mt-4 space-y-3">
              <Field label="مبلغ (تومان)" hint={`حداقل ${fmtMoney(MIN_WITHDRAW)} · حداکثر ${fmtMoney(w.balance)}`}><Input value={amount} onChange={(v) => { setAmount(v.replace(/[^\d۰-۹]/g, "")); setMsg(null); }} placeholder="۰" /></Field>
              <div className="flex gap-2">{[0.25, 0.5, 1].map((f) => <button key={f} onClick={() => setAmount(String(Math.floor(w.balance * f)))} className="min-h-10 flex-1 rounded-[10px] border border-[var(--kv-line)] text-[12px] font-semibold hover:border-[var(--kv-accent)]">{f === 1 ? "کل موجودی" : `${fmtNum(f * 100)}٪`}</button>)}</div>
              <Btn variant="accent" className="w-full" disabled={noWithdraw || !bank || bank.status !== "verified" || w.balance < MIN_WITHDRAW} onClick={request} icon={<Banknote size={16} />}>ثبت درخواست برداشت</Btn>
              {noWithdraw && <p className="text-[12px] text-[var(--kv-danger)]">برداشت برای حساب شما محدود شده است.</p>}
              {msg && <p role="status" className={`text-[12px] leading-6 ${msg.ok ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]"}`}>{msg.text}</p>}
            </div>
          </div>
          <div className="rounded-[18px] border border-[var(--kv-line)] bg-[var(--kv-surface)] p-5">
            <p className="mb-3 text-[14px] font-extrabold">درخواست‌های برداشت</p>
            {w.withdrawals.length === 0 ? <p className="text-[12.5px] text-[var(--kv-muted)]">درخواستی ثبت نکرده‌اید.</p> : (
              <div className="space-y-2">{w.withdrawals.map((x) => <div key={x.id} className="flex items-center justify-between gap-2 rounded-[12px] border border-[var(--kv-line)] px-3 py-2.5"><div><p className="text-[12.5px] font-bold tabular-nums">{x.id} · {fmtMoney(x.amount)}</p><p className="text-[11px] text-[var(--kv-muted)]">{x.createdAt}{x.ref ? ` · پیگیری ${x.ref}` : ""}{x.note ? ` · ${x.note}` : ""}</p></div><Status value={WD_LABEL[x.status]} /></div>)}</div>
            )}
          </div>
        </div>
      </div>
      {!isDemo && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card className="overflow-hidden">
            <p className="p-4 text-[13.5px] font-extrabold">دفتر کل سرور (wallet_entries)</p>
            <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[420px]"><thead><tr><th>نوع</th><th>مبلغ</th><th>مرجع</th><th>تاریخ</th></tr></thead><tbody>
              {serverEntries.map((e) => <tr key={e.id}><td>{e.kind}{e.direction === "debit" ? " · بدهکار" : ""}</td><td className="tabular-nums">{fmtMoney(Math.round(Number(e.amount_rial) / 10))}</td><td className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{e.reference ?? "—"}</td><td className="text-[11px] text-[var(--kv-muted)]">{String(e.created_at).slice(0, 16).replace("T", " ")}</td></tr>)}
              {serverEntries.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-[var(--kv-muted)]">تراکنشی ثبت نشده است.</td></tr>}
            </tbody></table></div>
          </Card>
          <Card className="overflow-hidden">
            <p className="p-4 text-[13.5px] font-extrabold">درخواست‌های برداشت سرور</p>
            <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[420px]"><thead><tr><th>شناسه</th><th>مبلغ</th><th>وضعیت</th><th>تاریخ</th></tr></thead><tbody>
              {serverWithdrawals.map((x) => <tr key={x.id}><td className="tabular-nums" dir="ltr">{x.reference}</td><td className="tabular-nums">{fmtMoney(Math.round(Number(x.amount_rial) / 10))}</td><td><Status value={WD_LABEL[x.status as Withdrawal["status"]] ?? x.status} /></td><td className="text-[11px] text-[var(--kv-muted)]">{String(x.requested_at).slice(0, 16).replace("T", " ")}</td></tr>)}
              {serverWithdrawals.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-[var(--kv-muted)]">درخواست برداشتی ثبت نشده است.</td></tr>}
            </tbody></table></div>
          </Card>
        </div>
      )}
      <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--kv-muted)]"><Clock size={12} />{isDemo ? "واریز در این نسخه آزمایشی (demo) شبیه‌سازی است." : "موجودی، تراکنش‌ها و برداشت‌ها از دفتر کل سرور خوانده می‌شود؛ تسویه توسط مالی کلبه تأیید می‌شود."}</p>
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
