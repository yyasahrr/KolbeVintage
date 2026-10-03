/** Prompt 3 — admin supplier settlement center (inside the canonical finance ops hub).
 *  Scheduled settlements (upcoming/generate/review/approve/manual-pay/cancel),
 *  settlement holds, policies, verified bank accounts, recoveries, shipping
 *  financial policies, provider reconciliation and the read-only ledger
 *  reconciliation diagnostic. Server-derived allowedActions drive the buttons. */
import { useEffect, useState } from "react";
import { BadgeCheck, Banknote, Landmark, RefreshCcw, ShieldAlert, Truck } from "lucide-react";
import { settlementAdminApi } from "../data/api";
import { fmtNum } from "../data/catalog";
import { Btn, Card, Empty, Field, Input, Select, Status, WorkspaceModal } from "./primitives";

type Row = Record<string, unknown>;
type Flash = (message: string) => void;
const toman = (rial: unknown) => `${fmtNum(Math.round(Number(rial ?? 0) / 10))} تومان`;
const dt = (v: unknown) => (v ? String(v).slice(0, 16).replace("T", " ") : "—");
const errText = (e: unknown) => (e instanceof Error ? e.message : "خطای ناشناخته");

const SETTLE_LABEL: Record<string, string> = { pending: "در بررسی", approved: "تأیید شده", processing: "در پردازش", paid: "پرداخت شد", reconciled: "مغایرت‌گیری شد", cancelled: "لغو شد", failed: "ناموفق" };
const HOLD_LABEL: Record<string, string> = { active: "فعال", blocked: "مسدود", released: "آزاد شد", cancelled: "لغو شد" };
const BANK_LABEL: Record<string, string> = { pending_verification: "در انتظار تأیید", verified: "تأیید شده", rejected: "رد شد", disabled: "غیرفعال", archived: "بایگانی" };

/* ------------------------------ settlements ------------------------------ */

function SettlementsSection({ flash }: { flash: Flash }) {
  const [upcoming, setUpcoming] = useState<Row[]>([]);
  const [items, setItems] = useState<Row[]>([]);
  const [detail, setDetail] = useState<Row | null>(null);
  const [pay, setPay] = useState({ reference: "", paidAmountRial: "", sourceBank: "", note: "" });
  const load = () => {
    settlementAdminApi.upcoming().then((r) => setUpcoming(r.items)).catch(() => setUpcoming([]));
    settlementAdminApi.settlements({ pageSize: 50 }).then((r) => setItems(r.items)).catch(() => setItems([]));
  };
  useEffect(load, []);
  const openDetail = (id: string) => settlementAdminApi.settlement(id)
    .then((d) => { setDetail(d); setPay({ reference: "", paidAmountRial: String(d.net_rial ?? ""), sourceBank: "", note: "" }); })
    .catch((e) => flash(errText(e)));
  const act = (fn: Promise<unknown>, done: string) =>
    fn.then(() => { flash(done); setDetail(null); load(); }).catch((e) => flash(errText(e)));
  const generate = (supplierId?: string) =>
    settlementAdminApi.generate({ supplierId, force: true }).then((r) => {
      flash(`ایجاد: ${fmtNum(r.created.length)} · ردشده: ${r.skipped.map((s) => String(s.reason)).join("، ") || "—"}`);
      load();
    }).catch((e) => flash(errText(e)));
  const allowed = (detail?.allowedActions as string[] | undefined) ?? [];
  const approvalId = detail ? String((detail.approval as Row | null)?.id ?? "") : "";
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between p-4">
          <p className="text-[14px] font-extrabold">تسویه‌های پیشِ رو (آماده تسویه به تفکیک تأمین‌کننده)</p>
          <Btn variant="accent" onClick={() => void generate()} icon={<RefreshCcw size={14} />}>ایجاد تسویه برای همه</Btn>
        </div>
        <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[760px]"><thead>
          <tr><th>تأمین‌کننده</th><th>آماده تسویه</th><th>در Hold</th><th>تاریخ تسویه بعدی</th><th>سیاست</th><th>بانک تأییدشده</th><th></th></tr></thead><tbody>
          {upcoming.map((u) => (
            <tr key={String(u.supplierId)}>
              <td className="font-bold">{String(u.supplierName)}</td>
              <td className="tabular-nums">{toman(u.eligibleRial)} ({fmtNum(Number(u.eligiblePayables ?? 0))} سند)</td>
              <td className="tabular-nums">{toman(u.heldRial)}</td>
              <td>{String(u.nextSettlementDate ?? "—")}</td>
              <td className="text-[12px]">{String(u.policyName)}</td>
              <td>{u.hasVerifiedBank ? <Status value="دارد" /> : <Status value="ندارد" />}</td>
              <td><button className="text-[12px] font-bold text-[var(--kv-accent)]" onClick={() => void generate(String(u.supplierId))}>ایجاد تسویه</button></td>
            </tr>
          ))}
          {upcoming.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">مبلغ آماده تسویه‌ای وجود ندارد.</td></tr>}
        </tbody></table></div>
      </Card>
      <Card className="overflow-hidden">
        <p className="p-4 text-[14px] font-extrabold">تسویه‌های زمان‌بندی‌شده</p>
        <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[760px]"><thead>
          <tr><th>سند</th><th>تأمین‌کننده</th><th>خالص</th><th>وضعیت</th><th>مغایرت بازدارنده</th><th>واریز</th><th></th></tr></thead><tbody>
          {items.map((x) => (
            <tr key={String(x.id)}>
              <td className="tabular-nums" dir="ltr">{String(x.reference)}</td>
              <td>{String(x.supplier_name)}</td>
              <td className="tabular-nums font-bold">{toman(x.net_rial)}</td>
              <td><Status value={SETTLE_LABEL[String(x.status)] ?? String(x.status)} /></td>
              <td>{Number(x.blocking_exceptions ?? 0) > 0 ? <span className="text-[12px] font-bold text-[var(--kv-danger)]">{fmtNum(Number(x.blocking_exceptions))} مورد</span> : "—"}</td>
              <td className="text-[11.5px] text-[var(--kv-muted)]" dir="ltr">{x.paid_reference ? `${String(x.paid_reference)} · ${dt(x.paid_at)}` : "—"}</td>
              <td><button className="text-[12px] font-bold text-[var(--kv-accent)]" onClick={() => void openDetail(String(x.id))}>بررسی</button></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">تسویه زمان‌بندی‌شده‌ای ثبت نشده است.</td></tr>}
        </tbody></table></div>
      </Card>

      <WorkspaceModal open={!!detail} onClose={() => setDetail(null)} title={detail ? `تسویه ${String(detail.reference)}` : ""}
        subtitle={detail ? `${String(detail.supplier_name)} · ${SETTLE_LABEL[String(detail.status)] ?? String(detail.status)}` : undefined}>
        {detail && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {([["فروش ناخالص", detail.gross_rial], ["کمیسیون", detail.commission_rial], ["سهم ارسال", detail.shipping_rial],
                  ["بازپرداخت‌ها", detail.returns_rial], ["کسر Recovery", detail.recovery_offset_rial], ["خالص واریز", detail.net_rial]] as const).map(([label, v]) => (
                  <div key={label} className="rounded-[12px] border border-[var(--kv-line)] p-3"><p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p><p className="text-[14px] font-extrabold tabular-nums">{toman(v)}</p></div>
                ))}
              </div>
              <div className="overflow-hidden rounded-[12px] border border-[var(--kv-line)]">
                <p className="p-3 text-[13px] font-extrabold">اقلام (هر زیرسفارش = یک سند مالی)</p>
                <table className="kv-table"><thead><tr><th>زیرسفارش</th><th>تعداد سری</th><th>ناخالص</th><th>کمیسیون</th><th>خالص</th></tr></thead><tbody>
                  {((detail.lines as Row[]) ?? []).map((l) => (
                    <tr key={String(l.id)}><td dir="ltr" className="tabular-nums">{String(l.order_reference)}</td><td>{fmtNum(Number(l.quantity ?? 0))}</td>
                      <td className="tabular-nums">{toman(l.gross_rial)}</td><td className="tabular-nums">{toman(l.commission_rial)}</td><td className="tabular-nums font-bold">{toman(l.net_rial)}</td></tr>
                  ))}
                </tbody></table>
              </div>
              {((detail.exceptions as Row[]) ?? []).length > 0 && (
                <div className="rounded-[12px] border border-[var(--kv-danger)]/30 p-3">
                  <p className="mb-2 text-[13px] font-extrabold text-[var(--kv-danger)]">مغایرت‌ها</p>
                  {((detail.exceptions as Row[]) ?? []).map((e) => (
                    <p key={String(e.id)} className="py-1 text-[12px]"><b>{String(e.code)}</b> ({String(e.severity)} · {String(e.status)}) — {String(e.detail)}</p>
                  ))}
                </div>
              )}
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-1 text-[13px] font-extrabold">تاریخچه</p>
                {((detail.events as Row[]) ?? []).map((e, i) => (
                  <p key={i} className="py-0.5 text-[12px] text-[var(--kv-muted)]">{dt(e.created_at)} · {String(e.from_status ?? "شروع")} → {String(e.to_status)}{e.note ? ` · ${String(e.note)}` : ""}</p>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3 text-[12.5px]">
                <p className="mb-1 font-extrabold"><Landmark size={14} className="mb-0.5 inline text-[var(--kv-accent)]" /> مقصد واریز (Snapshot منجمد)</p>
                {(detail.bank_snapshot as Row | null)?.iban
                  ? <><p>{String((detail.bank_snapshot as Row).bankName)} · {String((detail.bank_snapshot as Row).holderName)}</p><p dir="ltr" className="tabular-nums">{String((detail.bank_snapshot as Row).iban)}</p></>
                  : <p className="text-[var(--kv-danger)]">حساب بانکی تأییدشده ندارد.</p>}
              </div>
              {allowed.includes("review") && approvalId && (
                <Btn className="w-full" onClick={() => void act(settlementAdminApi.approvalAction(approvalId, "review"), "بازبینی مالی ثبت شد.")}>بازبینی (مرحله اول)</Btn>
              )}
              {allowed.includes("approve") && approvalId && (
                <Btn variant="accent" className="w-full" onClick={() => void act(settlementAdminApi.approvalAction(approvalId, "approve"), "تسویه تأیید شد — پرداخت به‌صورت دستی انجام می‌شود، هیچ واریز خودکاری وجود ندارد.")}>تأیید مالی (بدون واریز خودکار)</Btn>
              )}
              {allowed.includes("pay") && (
                <div className="space-y-2 rounded-[12px] border border-[var(--kv-line)] p-3">
                  <p className="text-[13px] font-extrabold"><Banknote size={14} className="mb-0.5 inline text-[var(--kv-accent)]" /> ثبت واریز دستی بانکی</p>
                  <Field label="کد پیگیری بانکی"><Input value={pay.reference} onChange={(v) => setPay((p) => ({ ...p, reference: v }))} /></Field>
                  <Field label="مبلغ واریزشده (ریال)" hint="باید دقیقاً با خالص تسویه برابر باشد"><Input value={pay.paidAmountRial} onChange={(v) => setPay((p) => ({ ...p, paidAmountRial: v.replace(/\D/g, "") }))} /></Field>
                  <Field label="حساب مبدأ کلبه"><Input value={pay.sourceBank} onChange={(v) => setPay((p) => ({ ...p, sourceBank: v }))} /></Field>
                  <Field label="یادداشت"><Input value={pay.note} onChange={(v) => setPay((p) => ({ ...p, note: v }))} /></Field>
                  <Btn variant="accent" className="w-full" disabled={!pay.reference || !pay.paidAmountRial}
                    onClick={() => void act(settlementAdminApi.pay(String(detail.id), { reference: pay.reference, paidAmountRial: pay.paidAmountRial, sourceBank: pay.sourceBank || undefined, note: pay.note || undefined }), "واریز ثبت و تسویه نهایی شد.")}>ثبت پرداخت (PAID)</Btn>
                </div>
              )}
              {allowed.includes("block") && (
                <Btn className="w-full" onClick={() => { const reason = window.prompt("دلیل مسدودسازی تسویه؟"); if (reason) void act(settlementAdminApi.block(String(detail.id), reason), "تسویه مسدود شد."); }}>مسدودسازی</Btn>
              )}
              {(allowed.includes("cancel") || allowed.includes("fail")) && (
                <div className="flex gap-2">
                  {allowed.includes("cancel") && <Btn className="flex-1" onClick={() => { const reason = window.prompt("دلیل لغو؟"); if (reason) void act(settlementAdminApi.transition(String(detail.id), "cancel", reason), "تسویه لغو و اسناد آزاد شدند."); }}>لغو</Btn>}
                  {allowed.includes("fail") && <Btn className="flex-1" onClick={() => { const reason = window.prompt("دلیل ناموفق بودن واریز؟"); if (reason) void act(settlementAdminApi.transition(String(detail.id), "fail", reason), "واریز ناموفق ثبت شد."); }}>واریز ناموفق</Btn>}
                </div>
              )}
              {allowed.length === 0 && <p className="text-[12px] text-[var(--kv-muted)]">این تسویه نهایی و غیرقابل تغییر است.</p>}
            </div>
          </div>
        )}
      </WorkspaceModal>
    </div>
  );
}

/* --------------------------------- holds --------------------------------- */

function HoldsSection({ flash }: { flash: Flash }) {
  const [items, setItems] = useState<Row[]>([]);
  const load = () => settlementAdminApi.holds({ pageSize: 50 }).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => { void load(); }, []);
  const action = (id: string, action: "block" | "unblock" | "extend" | "release") => {
    const payload: { reason?: string; hours?: number } = {};
    if (action === "block") { const reason = window.prompt("دلیل مسدودسازی؟"); if (!reason) return; payload.reason = reason; }
    if (action === "extend") { const hours = Number(window.prompt("چند ساعت تمدید شود؟", "24")); if (!hours) return; payload.hours = hours; }
    settlementAdminApi.holdAction(id, action, payload).then(() => { flash("انجام شد."); void load(); }).catch((e) => flash(errText(e)));
  };
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between p-4">
        <p className="text-[14px] font-extrabold">دوره‌های نگهداری (Settlement Holds)</p>
        <Btn onClick={() => void settlementAdminApi.runHoldRelease().then((r) => { flash(`آزاد شد: ${fmtNum(r.released)} · مسدود: ${fmtNum(r.blocked)}`); void load(); }).catch((e) => flash(errText(e)))} icon={<RefreshCcw size={14} />}>اجرای آزادسازی سررسیدها</Btn>
      </div>
      <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[860px]"><thead>
        <tr><th>تأمین‌کننده</th><th>زیرسفارش</th><th>مبلغ</th><th>وضعیت</th><th>آزادسازی</th><th>دلیل</th><th>عملیات</th></tr></thead><tbody>
        {items.map((h) => (
          <tr key={String(h.id)}>
            <td>{String(h.supplier_name)}</td>
            <td className="tabular-nums" dir="ltr">{String(h.child_reference)}</td>
            <td className="tabular-nums font-bold">{toman(h.amount_rial)}</td>
            <td><Status value={HOLD_LABEL[String(h.status)] ?? String(h.status)} /></td>
            <td className="text-[12px]">{dt(h.release_at)}</td>
            <td className="text-[12px] text-[var(--kv-muted)]">{String(h.blocked_reason ?? h.reason ?? "—")}</td>
            <td className="space-x-2 space-x-reverse text-[12px] font-bold">
              {h.status === "active" && <>
                <button className="text-[var(--kv-danger)]" onClick={() => action(String(h.id), "block")}>مسدود</button>{" "}
                <button className="text-[var(--kv-accent)]" onClick={() => action(String(h.id), "extend")}>تمدید</button>{" "}
                <button className="text-[var(--kv-success)]" onClick={() => action(String(h.id), "release")}>آزادسازی زودهنگام</button>
              </>}
              {h.status === "blocked" && <button className="text-[var(--kv-success)]" onClick={() => action(String(h.id), "unblock")}>رفع مسدودی</button>}
            </td>
          </tr>
        ))}
        {items.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">Hold فعالی وجود ندارد.</td></tr>}
      </tbody></table></div>
    </Card>
  );
}

/* ------------------------- policies + finance config ------------------------- */

function PoliciesSection({ flash }: { flash: Flash }) {
  const [items, setItems] = useState<Row[]>([]);
  const [financePolicy, setFinancePolicy] = useState<Row | null>(null);
  const [f, setF] = useState({ name: "", scheduleType: "month_days", monthDays: "15,30", weeklyDay: "6", minimumToman: "0", holdHours: "" });
  const [assign, setAssign] = useState({ supplierId: "", policyId: "" });
  const load = () => {
    settlementAdminApi.policies().then((r) => setItems(r.items)).catch(() => setItems([]));
    settlementAdminApi.financePolicy().then(setFinancePolicy).catch(() => setFinancePolicy(null));
  };
  useEffect(load, []);
  const create = () => {
    const monthDays = f.monthDays.split(/[،,\s]+/).map((x) => Number(x)).filter((x) => x >= 1 && x <= 31);
    settlementAdminApi.createPolicy({
      name: f.name, scheduleType: f.scheduleType,
      weeklyDay: f.scheduleType === "weekly" ? Number(f.weeklyDay) : undefined,
      monthDays: f.scheduleType === "weekly" || f.scheduleType === "manual" ? [] : monthDays,
      minimumSettlementRial: String(Math.max(0, Number(f.minimumToman.replace(/\D/g, "") || 0)) * 10),
      holdHours: f.holdHours ? Number(f.holdHours) : null,
    }).then(() => { flash("سیاست تسویه ساخته شد."); setF((p) => ({ ...p, name: "" })); load(); }).catch((e) => flash(errText(e)));
  };
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <p className="p-4 text-[14px] font-extrabold">سیاست‌های تسویه</p>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[720px]"><thead>
            <tr><th>نام</th><th>زمان‌بندی</th><th>حداقل مبلغ</th><th>Hold (ساعت)</th><th>بانک تأییدشده</th><th>واریز خودکار</th><th>نسخه</th><th>تأمین‌کنندگان</th></tr></thead><tbody>
            {items.map((p) => (
              <tr key={String(p.id)}>
                <td className="font-bold">{String(p.name)}{p.active ? "" : " · غیرفعال"}</td>
                <td className="text-[12px]">{p.schedule_type === "weekly" ? `هفتگی (روز ${fmtNum(Number(p.weekly_day ?? 0))})` : p.schedule_type === "manual" ? "دستی" : `روزهای ${((p.month_days as number[]) ?? []).map((d) => fmtNum(d)).join("، ")}`}</td>
                <td className="tabular-nums">{toman(p.minimum_settlement_rial)}</td>
                <td>{p.hold_hours === null ? "پیش‌فرض سراسری" : fmtNum(Number(p.hold_hours))}</td>
                <td>{p.requires_verified_bank ? "الزامی" : "—"}</td>
                <td className="font-bold text-[var(--kv-success)]">{p.automatic_bank_payout ? "⚠️" : "غیرفعال (قفل V1)"}</td>
                <td>{fmtNum(Number(p.version ?? 1))}</td>
                <td>{fmtNum(Number(p.supplier_count ?? 0))}</td>
              </tr>
            ))}
          </tbody></table></div>
        </Card>
        {financePolicy && (
          <Card className="p-4 text-[12.5px]">
            <p className="mb-2 text-[13.5px] font-extrabold">پیکربندی سراسری مالی تأمین‌کننده</p>
            <p>Hold پیش‌فرض: <b>{fmtNum(Number(financePolicy.holdHours ?? 72))} ساعت</b> · دوره انتظار حساب بانکی: <b>{fmtNum(Number(financePolicy.bankCooldownHours ?? 0))} ساعت</b> · آستانه کنترل دوگانه: <b>{toman(financePolicy.dualControlThresholdRial)}</b> · برداشت قدیمی: <b className={financePolicy.legacyWithdrawalsEnabled ? "text-[var(--kv-danger)]" : "text-[var(--kv-success)]"}>{financePolicy.legacyWithdrawalsEnabled ? "فعال (حالت legacy)" : "غیرفعال"}</b></p>
          </Card>
        )}
      </div>
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <p className="text-[13.5px] font-extrabold">سیاست جدید</p>
          <Field label="نام"><Input value={f.name} onChange={(v) => setF((p) => ({ ...p, name: v }))} /></Field>
          <Field label="نوع زمان‌بندی"><Select value={f.scheduleType} onChange={(v) => setF((p) => ({ ...p, scheduleType: v }))} options={["month_days", "monthly", "weekly", "manual"]} /></Field>
          {f.scheduleType === "weekly"
            ? <Field label="روز هفته (۰=یکشنبه … ۶=شنبه)"><Input value={f.weeklyDay} onChange={(v) => setF((p) => ({ ...p, weeklyDay: v.replace(/\D/g, "") }))} /></Field>
            : f.scheduleType !== "manual" && <Field label="روزهای ماه" hint="مثلاً 15,30"><Input value={f.monthDays} onChange={(v) => setF((p) => ({ ...p, monthDays: v }))} /></Field>}
          <Field label="حداقل مبلغ تسویه (تومان)"><Input value={f.minimumToman} onChange={(v) => setF((p) => ({ ...p, minimumToman: v.replace(/\D/g, "") }))} /></Field>
          <Field label="مدت Hold (ساعت — خالی = پیش‌فرض سراسری)"><Input value={f.holdHours} onChange={(v) => setF((p) => ({ ...p, holdHours: v.replace(/\D/g, "") }))} /></Field>
          <Btn variant="accent" className="w-full" disabled={!f.name.trim()} onClick={create}>ایجاد سیاست</Btn>
          <p className="text-[11.5px] text-[var(--kv-muted)]">واریز خودکار بانکی در V1 در سطح پایگاه‌داده قفل است و هیچ سیاستی نمی‌تواند آن را فعال کند.</p>
        </Card>
        <Card className="space-y-3 p-4">
          <p className="text-[13.5px] font-extrabold">انتساب سیاست به تأمین‌کننده</p>
          <Field label="شناسه تأمین‌کننده (UUID)"><Input value={assign.supplierId} onChange={(v) => setAssign((p) => ({ ...p, supplierId: v.trim() }))} /></Field>
          <Field label="سیاست"><Select value={assign.policyId} onChange={(v) => setAssign((p) => ({ ...p, policyId: v }))} options={["", ...items.map((p) => String(p.id))]} /></Field>
          <Btn className="w-full" disabled={!assign.supplierId} onClick={() => void settlementAdminApi.assignPolicy(assign.supplierId, assign.policyId || null).then(() => flash("سیاست منتسب شد.")).catch((e) => flash(errText(e)))}>انتساب</Btn>
        </Card>
      </div>
    </div>
  );
}

/* --------------------------- banks + recoveries --------------------------- */

function BanksSection({ flash }: { flash: Flash }) {
  const [banks, setBanks] = useState<Row[]>([]);
  const [recoveries, setRecoveries] = useState<Row[]>([]);
  const load = () => {
    settlementAdminApi.bankAccounts({ pageSize: 50 }).then((r) => setBanks(r.items)).catch(() => setBanks([]));
    settlementAdminApi.recoveries({ pageSize: 50 }).then((r) => setRecoveries(r.items)).catch(() => setRecoveries([]));
  };
  useEffect(load, []);
  const act = (id: string, action: "verify" | "reject" | "disable") => {
    let reason: string | undefined;
    if (action !== "verify") { const input = window.prompt(action === "reject" ? "دلیل رد؟" : "دلیل غیرفعال‌سازی؟"); if (!input) return; reason = input; }
    settlementAdminApi.bankAction(id, action, reason).then(() => { flash("انجام شد."); load(); }).catch((e) => flash(errText(e)));
  };
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <p className="p-4 text-[14px] font-extrabold"><BadgeCheck size={15} className="mb-0.5 inline text-[var(--kv-accent)]" /> تأیید حساب‌های بانکی تأمین‌کنندگان</p>
        <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[860px]"><thead>
          <tr><th>تأمین‌کننده</th><th>بانک</th><th>شبا</th><th>صاحب حساب</th><th>وضعیت</th><th>فعال از</th><th>عملیات</th></tr></thead><tbody>
          {banks.map((b) => (
            <tr key={String(b.id)}>
              <td>{String(b.supplier_name)}</td>
              <td>{String(b.bank_name)}</td>
              <td className="tabular-nums" dir="ltr">{String(b.iban)}</td>
              <td>{String(b.holder_name)}</td>
              <td><Status value={BANK_LABEL[String(b.status)] ?? String(b.status)} /></td>
              <td className="text-[11.5px] text-[var(--kv-muted)]">{dt(b.settlement_enabled_at)}</td>
              <td className="space-x-2 space-x-reverse text-[12px] font-bold">
                {b.status === "pending_verification" && <>
                  <button className="text-[var(--kv-success)]" onClick={() => act(String(b.id), "verify")}>تأیید</button>{" "}
                  <button className="text-[var(--kv-danger)]" onClick={() => act(String(b.id), "reject")}>رد</button>
                </>}
                {b.status === "verified" && <button className="text-[var(--kv-danger)]" onClick={() => act(String(b.id), "disable")}>غیرفعال (امنیتی)</button>}
              </td>
            </tr>
          ))}
          {banks.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">حساب بانکی ثبت نشده است.</td></tr>}
        </tbody></table></div>
      </Card>
      <Card className="overflow-hidden">
        <p className="p-4 text-[14px] font-extrabold">بدهی‌های قابل بازیافت (Supplier Recoveries)</p>
        <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[720px]"><thead>
          <tr><th>سند</th><th>تأمین‌کننده</th><th>مبلغ</th><th>جبران‌شده</th><th>وضعیت</th><th>منشأ</th><th></th></tr></thead><tbody>
          {recoveries.map((r) => (
            <tr key={String(r.id)}>
              <td className="tabular-nums" dir="ltr">{String(r.reference)}</td>
              <td>{String(r.supplier_name)}</td>
              <td className="tabular-nums font-bold">{toman(r.amount_rial)}</td>
              <td className="tabular-nums">{toman(r.offset_rial)}</td>
              <td><Status value={r.status === "open" ? "باز" : r.status === "offset" ? "جبران شد" : "بخشوده شد"} /></td>
              <td className="text-[12px] text-[var(--kv-muted)]">{String(r.source_type)}</td>
              <td>{r.status === "open" && <button className="text-[12px] font-bold text-[var(--kv-danger)]" onClick={() => { const reason = window.prompt("دلیل بخشودگی؟"); if (reason) void settlementAdminApi.writeOffRecovery(String(r.id), reason).then(() => { flash("بخشوده شد."); load(); }).catch((e) => flash(errText(e))); }}>بخشودگی</button>}</td>
            </tr>
          ))}
          {recoveries.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">بدهی بازی وجود ندارد.</td></tr>}
        </tbody></table></div>
      </Card>
    </div>
  );
}

/* ------------------- shipping + provider recon + diagnostic ------------------- */

function ReconSection({ flash }: { flash: Flash }) {
  const [shipping, setShipping] = useState<Row[]>([]);
  const [recons, setRecons] = useState<Row[]>([]);
  const [unknownCount, setUnknownCount] = useState(0);
  const [diag, setDiag] = useState<Row | null>(null);
  const [diagSupplier, setDiagSupplier] = useState("");
  const [ship, setShip] = useState({ name: "", leg: "supplier_inbound_order", payer: "customer", method: "fixed", amountToman: "0", sharePercent: "0" });
  const [recon, setRecon] = useState({ paymentIntentId: "", source: "manual", matched: "matched", externalReference: "", statementBatch: "", note: "" });
  const load = () => {
    settlementAdminApi.shippingPolicies().then((r) => setShipping(r.items)).catch(() => setShipping([]));
    settlementAdminApi.providerReconciliations({ pageSize: 50 }).then((r) => { setRecons(r.items); setUnknownCount(r.unreconciledIntents); }).catch(() => setRecons([]));
  };
  useEffect(load, []);
  const LEG_LABEL: Record<string, string> = { supplier_inbound_order: "تأمین‌کننده → کلبه (سفارش‌محور)", supplier_inbound_stock: "تأمین‌کننده → کلبه (موجودی امانی)", master_final: "کلبه → خریدار VIP" };
  const PAYER_LABEL: Record<string, string> = { customer: "مشتری", supplier: "تأمین‌کننده", kolbe: "کلبه", shared: "مشترک", promotion: "پروموشن" };
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <p className="p-4 text-[14px] font-extrabold"><Truck size={15} className="mb-0.5 inline text-[var(--kv-accent)]" /> سیاست مالی حمل (نسخه‌دار — هرگز عطف به ماسبق نمی‌شود)</p>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[760px]"><thead>
            <tr><th>مسیر</th><th>پرداخت‌کننده</th><th>روش</th><th>مبلغ</th><th>سهم تأمین‌کننده</th><th>نسخه</th><th>وضعیت</th></tr></thead><tbody>
            {shipping.map((p) => (
              <tr key={String(p.id)}>
                <td className="text-[12px]">{LEG_LABEL[String(p.leg)] ?? String(p.leg)}{p.supplier_name ? ` · ${String(p.supplier_name)}` : ""}</td>
                <td className="font-bold">{PAYER_LABEL[String(p.payer)] ?? String(p.payer)}</td>
                <td>{String(p.method)}</td>
                <td className="tabular-nums">{toman(p.amount_rial)}</td>
                <td>{fmtNum(Number(p.supplier_share_percent ?? 0))}٪</td>
                <td>{fmtNum(Number(p.version ?? 1))}</td>
                <td><Status value={p.active ? "فعال" : "بسته‌شده"} /></td>
              </tr>
            ))}
          </tbody></table></div>
        </Card>
        <Card className="space-y-3 p-4">
          <p className="text-[13.5px] font-extrabold">نسخه جدید سیاست حمل</p>
          <Field label="نام"><Input value={ship.name} onChange={(v) => setShip((p) => ({ ...p, name: v }))} /></Field>
          <Field label="مسیر"><Select value={ship.leg} onChange={(v) => setShip((p) => ({ ...p, leg: v }))} options={["supplier_inbound_order", "supplier_inbound_stock", "master_final"]} /></Field>
          <Field label="پرداخت‌کننده"><Select value={ship.payer} onChange={(v) => setShip((p) => ({ ...p, payer: v }))} options={["customer", "supplier", "kolbe", "shared", "promotion"]} /></Field>
          <Field label="روش"><Select value={ship.method} onChange={(v) => setShip((p) => ({ ...p, method: v }))} options={["fixed", "per_series", "actual_cost"]} /></Field>
          <Field label="مبلغ (تومان)"><Input value={ship.amountToman} onChange={(v) => setShip((p) => ({ ...p, amountToman: v.replace(/\D/g, "") }))} /></Field>
          {ship.payer === "shared" && <Field label="سهم تأمین‌کننده (٪)"><Input value={ship.sharePercent} onChange={(v) => setShip((p) => ({ ...p, sharePercent: v.replace(/\D/g, "") }))} /></Field>}
          <Btn variant="accent" className="w-full" disabled={!ship.name.trim()} onClick={() => void settlementAdminApi.createShippingPolicy({
            name: ship.name, leg: ship.leg, payer: ship.payer, method: ship.method,
            amountRial: String(Number(ship.amountToman || 0) * 10),
            supplierSharePercent: ship.payer === "shared" ? Number(ship.sharePercent || 0) : 0,
          }).then((r) => { flash(`نسخه ${fmtNum(r.version)} فعال شد؛ محاسبات قبلی دست‌نخورده می‌ماند.`); load(); }).catch((e) => flash(errText(e)))}>ثبت نسخه جدید</Btn>
        </Card>
      </div>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between p-4">
            <p className="text-[14px] font-extrabold">تطبیق تسویه درگاه‌ها (SnappPay / DigiPay / …)</p>
            <span className="text-[12px] font-bold text-[var(--kv-danger)]">{fmtNum(unknownCount)} پرداخت موفق بدون وضعیت تطبیق (نامشخصِ صادقانه)</span>
          </div>
          <div className="kv-scroll overflow-x-auto"><table className="kv-table min-w-[760px]"><thead>
            <tr><th>درگاه</th><th>مرجع درگاه</th><th>مبلغ</th><th>وضعیت</th><th>منبع</th><th>مرجع بیرونی</th><th>بررسی</th></tr></thead><tbody>
            {recons.map((r) => (
              <tr key={String(r.id)}>
                <td>{String(r.provider)}</td>
                <td className="tabular-nums" dir="ltr">{String(r.provider_reference ?? "—")}</td>
                <td className="tabular-nums">{toman(r.amount_rial)}</td>
                <td><Status value={r.status === "matched" ? "تطبیق شد" : r.status === "exception" ? "مغایرت" : "نامشخص"} /></td>
                <td>{String(r.source)}</td>
                <td className="text-[11.5px]" dir="ltr">{String(r.external_reference ?? r.statement_batch ?? "—")}</td>
                <td className="text-[11.5px] text-[var(--kv-muted)]">{dt(r.checked_at)}</td>
              </tr>
            ))}
            {recons.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-[var(--kv-muted)]">هیچ رکورد تطبیقی ثبت نشده — وضعیت تسویه درگاه «نامشخص» است، نه «تسویه‌شده».</td></tr>}
          </tbody></table></div>
        </Card>
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <p className="text-[13.5px] font-extrabold">ثبت نتیجه تطبیق</p>
            <Field label="شناسه Payment Intent"><Input value={recon.paymentIntentId} onChange={(v) => setRecon((p) => ({ ...p, paymentIntentId: v.trim() }))} /></Field>
            <Field label="منبع"><Select value={recon.source} onChange={(v) => setRecon((p) => ({ ...p, source: v }))} options={["manual", "statement", "api"]} /></Field>
            <Field label="نتیجه"><Select value={recon.matched} onChange={(v) => setRecon((p) => ({ ...p, matched: v }))} options={["matched", "exception"]} /></Field>
            {recon.source === "statement" && <Field label="شناسه صورتحساب بانکی"><Input value={recon.statementBatch} onChange={(v) => setRecon((p) => ({ ...p, statementBatch: v }))} /></Field>}
            <Field label="مرجع بیرونی"><Input value={recon.externalReference} onChange={(v) => setRecon((p) => ({ ...p, externalReference: v }))} /></Field>
            <Field label="یادداشت"><Input value={recon.note} onChange={(v) => setRecon((p) => ({ ...p, note: v }))} /></Field>
            <Btn variant="accent" className="w-full" disabled={!recon.paymentIntentId} onClick={() => void settlementAdminApi.recordProviderReconciliation({
              paymentIntentId: recon.paymentIntentId, source: recon.source, matched: recon.matched === "matched",
              externalReference: recon.externalReference || undefined, statementBatch: recon.statementBatch || undefined, note: recon.note || undefined,
            }).then(() => { flash("نتیجه تطبیق ثبت شد."); load(); }).catch((e) => flash(errText(e)))}>ثبت</Btn>
          </Card>
          <Card className="space-y-3 p-4">
            <p className="text-[13.5px] font-extrabold"><ShieldAlert size={14} className="mb-0.5 inline text-[var(--kv-accent)]" /> سلامت مالی تأمین‌کننده (فقط‌خواندنی)</p>
            <Field label="شناسه تأمین‌کننده (UUID)"><Input value={diagSupplier} onChange={setDiagSupplier} /></Field>
            <Btn className="w-full" disabled={!diagSupplier.trim()} onClick={() => void settlementAdminApi.diagnostic(diagSupplier.trim()).then(setDiag).catch((e) => flash(errText(e)))}>بررسی تطابق دفتر کل</Btn>
            {diag && (
              <div className="space-y-1 text-[12px]">
                <p className={`text-[13px] font-extrabold ${diag.status === "OK" ? "text-[var(--kv-success)]" : "text-[var(--kv-danger)]"}`}>{diag.status === "OK" ? "تطابق کامل ✓" : `مغایرت: ${toman(diag.differenceRial)}`}</p>
                {([["دفتر کل", diag.ledgerOutstandingRial], ["پروجکشن اسناد", diag.expectedOutstandingRial], ["در Hold", diag.heldRial],
                  ["آماده تسویه", diag.eligibleRial], ["در تسویه", diag.scheduledRial], ["تسویه‌شده", diag.settledRial], ["Recovery باز", diag.openRecoveryRial]] as const).map(([label, v]) => (
                  <p key={label} className="flex justify-between"><span className="text-[var(--kv-muted)]">{label}</span><b className="tabular-nums">{toman(v)}</b></p>
                ))}
                {diag.status !== "OK" && <p className="text-[11.5px] text-[var(--kv-danger)]">تا رفع مغایرت، تسویه جدیدی برای این تأمین‌کننده ساخته نمی‌شود.</p>}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- shell --------------------------------- */

const SECTIONS = [
  { v: "settlements", label: "تسویه‌های زمان‌بندی‌شده" },
  { v: "holds", label: "Holds" },
  { v: "policies", label: "سیاست‌های تسویه" },
  { v: "banks", label: "بانک و Recovery" },
  { v: "recon", label: "حمل و تطبیق درگاه" },
] as const;

export function SettlementCenter({ flash }: { flash: Flash }) {
  const [section, setSection] = useState<typeof SECTIONS[number]["v"]>("settlements");
  return (
    <div className="space-y-4">
      <div className="kv-scroll -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {SECTIONS.map((s) => (
          <button key={s.v} onClick={() => setSection(s.v)}
            className={`kv-press shrink-0 rounded-[10px] px-3 py-2 text-[12.5px] font-bold ${section === s.v ? "bg-[var(--kv-action)] text-[var(--kv-bg)]" : "bg-[var(--kv-surface-2)] text-[var(--kv-muted)] hover:text-[var(--kv-text)]"}`}>
            {s.label}
          </button>
        ))}
      </div>
      {section === "settlements" && <SettlementsSection flash={flash} />}
      {section === "holds" && <HoldsSection flash={flash} />}
      {section === "policies" && <PoliciesSection flash={flash} />}
      {section === "banks" && <BanksSection flash={flash} />}
      {section === "recon" && <ReconSection flash={flash} />}
      {false && <Empty title="" desc="" />}
    </div>
  );
}
