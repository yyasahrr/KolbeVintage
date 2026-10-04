import { useCallback, useEffect, useState } from "react";
import { Coins, Percent, Plus, RefreshCw, Settings2, UserMinus, UserPlus } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, Select } from "./primitives";
import { cashbackApi } from "../data/api";
import { fmtToman } from "../data/contracts";
import { CASHBACK_TX_FA, faLabel } from "../data/fa-labels";
import { formatPersianDate, formatPersianDateTime } from "../data/persian-date";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
type F = (message: string) => void;

/**
 * کیف پول کش‌بک (اعتبار وفاداری خرده‌فروشی). برداشت/انتقال/نقد شدن ندارد؛ فقط در پرداخت
 * سفارش خرده مصرف می‌شود. دفترکل سرور منبع حقیقت است — این صفحه فقط نمایش و فرمان است.
 */
export function CashbackCenter({ flash }: { flash: F }) {
  const [tab, setTab] = useState<"overview" | "rules" | "wallets" | "transactions" | "expiring" | "settings">("overview");
  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Segmented
        options={[
          { v: "overview", label: "نمای کلی" },
          { v: "rules", label: "قوانین کش‌بک" },
          { v: "wallets", label: "کیف پول‌ها" },
          { v: "transactions", label: "تراکنش‌ها" },
          { v: "expiring", label: "در آستانه انقضا" },
          { v: "settings", label: "تنظیمات استفاده" },
        ]}
        value={tab} onChange={setTab}
      />
      {tab === "overview" && <OverviewTab />}
      {tab === "rules" && <RulesTab flash={flash} />}
      {tab === "wallets" && <WalletsTab flash={flash} />}
      {tab === "transactions" && <TransactionsTab />}
      {tab === "expiring" && <ExpiringTab />}
      {tab === "settings" && <SettingsTab flash={flash} />}
    </div>
  );
}

function OverviewTab() {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    cashbackApi.adminOverview().then(setData).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="در حال بارگذاری نمای کلی کش‌بک…" />;
  const last30 = (data.last30 ?? {}) as Record<string, string>;
  const cards: [string, string, string?][] = [
    ["بدهی کل کش‌بک (تعهد فروشگاه)", fmtToman(data.liabilityRial), "جمع اعتبار در انتظار + قابل استفاده"],
    ["در انتظار آزادسازی", fmtToman(data.pendingRial)],
    ["قابل استفاده", fmtToman(data.availableRial)],
    ["استفاده‌شده (کل)", fmtToman(data.usedRial)],
    ["منقضی‌شده (کل)", fmtToman(data.expiredRial)],
    ["مشتریان دارای کیف پول", fa(Number(data.customers ?? 0))],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map(([label, value, hint]) => (
          <Card key={label} className="p-4">
            <p className="text-[11.5px] text-[var(--kv-muted)]">{label}</p>
            <p className="mt-1 text-[16px] font-extrabold tabular-nums">{value}</p>
            {hint && <p className="mt-1 text-[10.5px] text-[var(--kv-faint)]">{hint}</p>}
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <p className="text-[13px] font-bold">۳۰ روز اخیر</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div><p className="text-[11.5px] text-[var(--kv-muted)]">کش‌بک تعلق‌گرفته</p><p className="font-extrabold tabular-nums">{fmtToman(last30.earnedRial ?? "0")}</p></div>
          <div><p className="text-[11.5px] text-[var(--kv-muted)]">اعتبار مصرف‌شده</p><p className="font-extrabold tabular-nums">{fmtToman(last30.redeemedRial ?? "0")}</p></div>
        </div>
        <p className="mt-3 text-[11px] leading-6 text-[var(--kv-muted)]">
          کیف پول کش‌بک اعتبار وفاداری است: قابل برداشت یا انتقال نیست و فقط در پرداخت سفارش خرده مصرف می‌شود.
          موجودی‌ها از دفترکل تراکنش‌ها محاسبه می‌شوند و هیچ عددی دستی ویرایش نمی‌شود.
        </p>
      </Card>
    </div>
  );
}

type RuleForm = {
  name: string; mode: "percent" | "fixed"; percent: string; fixedRial: string;
  minOrderRial: string; maxPerOrderRial: string; releaseDelayDays: string; expirationDays: string;
  firstOrderOnly: boolean; priority: string;
};
const emptyRule: RuleForm = {
  name: "", mode: "percent", percent: "5", fixedRial: "500000",
  minOrderRial: "0", maxPerOrderRial: "", releaseDelayDays: "7", expirationDays: "90",
  firstOrderOnly: false, priority: "100",
};

function RulesTab({ flash }: { flash: F }) {
  const [rules, setRules] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    cashbackApi.adminRules().then((r) => setRules(r.items)).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    if (!form) return;
    try {
      setBusy(true);
      await cashbackApi.createRule({
        name: form.name.trim(),
        priority: Number(form.priority) || 100,
        ...(form.mode === "percent" ? { percent: Number(form.percent) } : { fixedRial: form.fixedRial }),
        minOrderRial: form.minOrderRial || "0",
        ...(form.maxPerOrderRial ? { maxPerOrderRial: form.maxPerOrderRial } : {}),
        releaseDelayDays: Number(form.releaseDelayDays) || 0,
        ...(form.expirationDays ? { expirationDays: Number(form.expirationDays) } : {}),
        firstOrderOnly: form.firstOrderOnly,
        paymentModes: ["cash"],
      });
      flash("قانون کش‌بک ساخته شد.");
      setForm(null); load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت قانون"); }
    finally { setBusy(false); }
  };

  const toggle = async (rule: Record<string, unknown>) => {
    try {
      await cashbackApi.updateRule(String(rule.id), { active: !rule.active });
      flash(rule.active ? "قانون غیرفعال شد." : "قانون فعال شد.");
      load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rules) return <LoadingState label="در حال بارگذاری قوانین…" />;
  const percentInvalid = form?.mode === "percent" && (!form.percent || Number(form.percent) < 1 || Number(form.percent) > 100);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold">قوانین تعلق کش‌بک ({fa(rules.length)})</p>
        <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={() => setForm({ ...emptyRule })}>قانون جدید</Btn>
      </div>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[900px] text-xs">
            <thead><tr><th>نام</th><th>مقدار</th><th>حداقل سفارش</th><th>سقف هر سفارش</th><th>تأخیر آزادسازی</th><th>انقضا</th><th>اولویت</th><th>وضعیت</th><th>عملیات</th></tr></thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={String(rule.id)}>
                  <td className="font-bold">{String(rule.name)}</td>
                  <td className="tabular-nums">{rule.percent != null ? `${fa(Number(rule.percent))}٪` : fmtToman(rule.fixed_rial)}</td>
                  <td className="tabular-nums">{fmtToman(rule.min_order_rial)}</td>
                  <td className="tabular-nums">{rule.max_per_order_rial != null ? fmtToman(rule.max_per_order_rial) : "—"}</td>
                  <td className="tabular-nums">{fa(Number(rule.release_delay_days))} روز</td>
                  <td className="tabular-nums">{rule.expiration_days != null ? `${fa(Number(rule.expiration_days))} روز` : "بدون انقضا"}</td>
                  <td className="tabular-nums">{fa(Number(rule.priority))}</td>
                  <td>{rule.active ? "فعال" : "غیرفعال"}</td>
                  <td><Btn size="sm" variant="soft" onClick={() => void toggle(rule)}>{rule.active ? "غیرفعال‌سازی" : "فعال‌سازی"}</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rules.length === 0 && <Empty title="قانونی تعریف نشده" desc="نخستین قانون کش‌بک (درصدی یا مبلغ ثابت) را بسازید." />}
      </Card>

      {form && (
        <Modal open title="قانون جدید کش‌بک" onClose={() => setForm(null)}>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            <Field label="نام قانون"><Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="مثلاً کش‌بک پاییزی ۵٪" /></Field>
            <Field label="نوع مقدار">
              <Select options={["درصدی", "مبلغ ثابت"]} value={form.mode === "percent" ? "درصدی" : "مبلغ ثابت"}
                onChange={(v) => setForm({ ...form, mode: v === "درصدی" ? "percent" : "fixed" })} />
            </Field>
            {form.mode === "percent" ? (
              <Field label="درصد (۱ تا ۱۰۰)" hint={percentInvalid ? "عدد بین ۱ تا ۱۰۰" : undefined}>
                <Input value={form.percent} onChange={(v) => setForm({ ...form, percent: v.replace(/\D/g, "").slice(0, 3) })} />
              </Field>
            ) : (
              <Field label="مبلغ ثابت (ریال)"><Input value={form.fixedRial} onChange={(v) => setForm({ ...form, fixedRial: v.replace(/\D/g, "") })} /></Field>
            )}
            <Field label="حداقل مبلغ سفارش (ریال)"><Input value={form.minOrderRial} onChange={(v) => setForm({ ...form, minOrderRial: v.replace(/\D/g, "") })} /></Field>
            <Field label="سقف کش‌بک هر سفارش (ریال، اختیاری)"><Input value={form.maxPerOrderRial} onChange={(v) => setForm({ ...form, maxPerOrderRial: v.replace(/\D/g, "") })} /></Field>
            <Field label="تأخیر آزادسازی پس از تحویل (روز)"><Input value={form.releaseDelayDays} onChange={(v) => setForm({ ...form, releaseDelayDays: v.replace(/\D/g, "") })} /></Field>
            <Field label="مهلت مصرف اعتبار (روز، خالی = بدون انقضا)"><Input value={form.expirationDays} onChange={(v) => setForm({ ...form, expirationDays: v.replace(/\D/g, "") })} /></Field>
            <Field label="اولویت (عدد کمتر = قوی‌تر)"><Input value={form.priority} onChange={(v) => setForm({ ...form, priority: v.replace(/\D/g, "") })} /></Field>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" checked={form.firstOrderOnly} onChange={(e) => setForm({ ...form, firstOrderOnly: e.target.checked })} />
              فقط اولین خرید مشتری
            </label>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setForm(null)}>انصراف</Btn>
              <Btn variant="accent" icon={<Percent size={14} />} disabled={busy || !form.name.trim() || !!percentInvalid} onClick={() => void save()}>ذخیره قانون</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WalletsTab({ flash }: { flash: F }) {
  const [data, setData] = useState<{ total: number; items: Record<string, unknown>[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [adjust, setAdjust] = useState<{ customerId: string; name: string; direction: "credit" | "debit"; amount: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    cashbackApi.adminWallets({ ...(search ? { search } : {}), limit: 50 })
      .then(setData).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, [search]);
  useEffect(load, [load]);

  const submitAdjust = async () => {
    if (!adjust) return;
    try {
      setBusy(true);
      await cashbackApi.adjust({ customerId: adjust.customerId, direction: adjust.direction, amountRial: adjust.amount, reason: adjust.reason.trim() });
      flash(adjust.direction === "credit" ? "اعتبار افزوده شد." : "اعتبار کسر شد.");
      setAdjust(null); load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در اصلاح کیف پول"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold">کیف پول مشتریان {data ? `(${fa(data.total)})` : ""}</p>
        <SearchBox placeholder="نام، موبایل یا ایمیل مشتری…" value={search} onChange={setSearch} />
      </div>
      {!data ? <LoadingState label="در حال بارگذاری کیف پول‌ها…" /> : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[920px] text-xs">
              <thead><tr><th>مشتری</th><th>در انتظار</th><th>قابل استفاده</th><th>استفاده‌شده</th><th>منقضی</th><th>آخرین فعالیت</th><th>اصلاح دستی</th></tr></thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={String(row.customer_id)}>
                    <td><b>{String(row.display_name ?? "—")}</b><p className="text-[10.5px] text-[var(--kv-muted)]" dir="ltr">{String(row.phone ?? row.email ?? "")}</p></td>
                    <td className="tabular-nums">{fmtToman(row.pending_rial)}</td>
                    <td className="tabular-nums font-bold">{fmtToman(row.available_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.used_rial)}</td>
                    <td className="tabular-nums">{fmtToman(row.expired_rial)}</td>
                    <td className="tabular-nums">{row.last_activity_at ? formatPersianDate(String(row.last_activity_at)) : "—"}</td>
                    <td className="space-x-1 space-x-reverse">
                      <Btn size="sm" variant="soft" icon={<UserPlus size={13} />} onClick={() => setAdjust({ customerId: String(row.customer_id), name: String(row.display_name ?? ""), direction: "credit", amount: "", reason: "" })}>افزایش</Btn>
                      <Btn size="sm" variant="ghost" icon={<UserMinus size={13} />} onClick={() => setAdjust({ customerId: String(row.customer_id), name: String(row.display_name ?? ""), direction: "debit", amount: "", reason: "" })}>کاهش</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.items.length === 0 && <Empty title="کیف پولی یافت نشد" desc="با اولین کش‌بکِ تعلق‌گرفته، کیف پول مشتری اینجا دیده می‌شود." />}
        </Card>
      )}

      {adjust && (
        <Modal open title={`${adjust.direction === "credit" ? "افزایش" : "کاهش"} اعتبار — ${adjust.name}`} onClose={() => setAdjust(null)}>
          <div className="space-y-3 p-4">
            <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              اصلاح دستی فقط به‌صورت سند دفترکل ثبت می‌شود (با ثبت دلیل و اپراتور در حسابرسی). کاهش هرگز موجودی را منفی نمی‌کند.
            </p>
            <Field label="مبلغ (ریال)"><Input value={adjust.amount} onChange={(v) => setAdjust({ ...adjust, amount: v.replace(/\D/g, "") })} placeholder="مثلاً ۵۰۰۰۰۰" /></Field>
            <Field label="دلیل (اجباری)"><Input value={adjust.reason} onChange={(v) => setAdjust({ ...adjust, reason: v })} placeholder="مثلاً جبران خطای ارسال سفارش ۱۲۳" /></Field>
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setAdjust(null)}>انصراف</Btn>
              <Btn variant="accent" icon={<Coins size={14} />} disabled={busy || !adjust.amount || adjust.reason.trim().length < 4} onClick={() => void submitAdjust()}>ثبت سند</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TransactionsTab() {
  const [data, setData] = useState<{ total: number; items: Record<string, unknown>[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [type, setType] = useState("all");
  const load = useCallback(() => {
    setError(null);
    cashbackApi.adminTransactions({ ...(type !== "all" ? { type } : {}), limit: 100 })
      .then(setData).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, [type]);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  const typeOptions = ["all", ...Object.keys(CASHBACK_TX_FA)];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-bold">دفترکل تراکنش‌ها {data ? `(${fa(data.total)})` : ""}</p>
        <div className="flex items-center gap-2">
          <Select options={typeOptions.map((t) => (t === "all" ? "همه انواع" : CASHBACK_TX_FA[t]!))}
            value={type === "all" ? "همه انواع" : CASHBACK_TX_FA[type]!}
            onChange={(label) => setType(label === "همه انواع" ? "all" : (Object.entries(CASHBACK_TX_FA).find(([, v]) => v === label)?.[0] ?? "all"))} />
          <Btn size="sm" variant="soft" icon={<RefreshCw size={13} />} onClick={load}>به‌روزرسانی</Btn>
        </div>
      </div>
      {!data ? <LoadingState label="در حال بارگذاری تراکنش‌ها…" /> : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[980px] text-xs">
              <thead><tr><th>زمان</th><th>مشتری</th><th>نوع</th><th>مبلغ</th><th>سفارش</th><th>شرح</th></tr></thead>
              <tbody>
                {data.items.map((row) => {
                  const amount = BigInt(String(row.amount_rial ?? "0"));
                  return (
                    <tr key={String(row.id)}>
                      <td className="tabular-nums">{formatPersianDateTime(String(row.created_at))}</td>
                      <td>{String(row.customer_name ?? "—")}</td>
                      <td>{faLabel(CASHBACK_TX_FA, row.tx_type)}</td>
                      <td className={"tabular-nums font-bold " + (amount < 0n ? "text-[var(--kv-danger)]" : "text-[#31603D]")}>{fmtToman(row.amount_rial)}</td>
                      <td className="tabular-nums" dir="ltr">{String(row.order_reference ?? "—")}</td>
                      <td className="max-w-[260px] truncate text-[var(--kv-muted)]">{String(row.description ?? "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.items.length === 0 && <Empty title="تراکنشی نیست" desc="رویدادهای کش‌بک (تعلق، استفاده، برگشت، انقضا) اینجا ثبت می‌شوند." />}
        </Card>
      )}
    </div>
  );
}

function ExpiringTab() {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    cashbackApi.adminExpiring(30).then((r) => setItems(r.items)).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="در حال بارگذاری اعتبارهای در آستانه انقضا…" />;
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3"><p className="text-[13px] font-bold">اعتبارهای با انقضای ۳۰ روز آینده ({fa(items.length)})</p></div>
      <div className="overflow-x-auto">
        <table className="kv-table min-w-[760px] text-xs">
          <thead><tr><th>مشتری</th><th>مبلغ</th><th>تاریخ انقضا</th><th>سفارش مبدا</th></tr></thead>
          <tbody>
            {items.map((row) => (
              <tr key={String(row.id)}>
                <td className="font-bold">{String(row.display_name ?? "—")}</td>
                <td className="tabular-nums">{fmtToman(row.amount_rial)}</td>
                <td className="tabular-nums">{formatPersianDate(String(row.expires_at))}</td>
                <td className="tabular-nums" dir="ltr">{String(row.order_reference ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length === 0 && <Empty title="اعتباری در آستانه انقضا نیست" desc="اعتبارهای با مهلت مصرف محدود، ۳۰ روز مانده به انقضا اینجا فهرست می‌شوند." />}
    </Card>
  );
}

function SettingsTab({ flash }: { flash: F }) {
  const [form, setForm] = useState<{ redemptionEnabled: boolean; maxPercentOfOrder: string; minRedeemRial: string; earnOnInstallments: boolean; redeemOnInstallments: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    cashbackApi.settings().then((s) => setForm({
      redemptionEnabled: Boolean(s.redemptionEnabled),
      maxPercentOfOrder: String(s.maxPercentOfOrder ?? 50),
      minRedeemRial: String(s.minRedeemRial ?? "100000"),
      earnOnInstallments: Boolean(s.earnOnInstallments),
      redeemOnInstallments: Boolean(s.redeemOnInstallments),
    })).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!form) return <LoadingState label="در حال بارگذاری تنظیمات…" />;
  const save = async () => {
    try {
      setBusy(true);
      await cashbackApi.saveSettings({
        redemptionEnabled: form.redemptionEnabled,
        maxPercentOfOrder: Math.min(Math.max(Number(form.maxPercentOfOrder) || 0, 0), 100),
        minRedeemRial: form.minRedeemRial || "0",
        earnOnInstallments: form.earnOnInstallments,
        redeemOnInstallments: form.redeemOnInstallments,
      });
      flash("تنظیمات استفاده از کیف پول ذخیره شد.");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره تنظیمات"); }
    finally { setBusy(false); }
  };
  return (
    <Card className="p-4">
      <p className="text-[13px] font-bold">تنظیمات استفاده از کیف پول در پرداخت</p>
      <p className="mt-1 text-[11.5px] leading-6 text-[var(--kv-muted)]">
        ترتیب محاسبه ثابت است: قیمت پایه ← تخفیف/جشنواره ← کوپن ← کیف پول ← هزینه ارسال.
        کیف پول هزینه ارسال را پرداخت نمی‌کند و به بخشِ با کیف‌پول‌پرداخت‌شده کش‌بک تعلق نمی‌گیرد.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={form.redemptionEnabled} onChange={(e) => setForm({ ...form, redemptionEnabled: e.target.checked })} />
          استفاده از کیف پول در پرداخت فعال باشد
        </label>
        <span />
        <Field label="حداکثر سهم کیف پول از مبلغ کالاها (٪)">
          <Input value={form.maxPercentOfOrder} onChange={(v) => setForm({ ...form, maxPercentOfOrder: v.replace(/\D/g, "").slice(0, 3) })} />
        </Field>
        <Field label="حداقل مبلغ قابل استفاده در هر سفارش (ریال)">
          <Input value={form.minRedeemRial} onChange={(v) => setForm({ ...form, minRedeemRial: v.replace(/\D/g, "") })} />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={form.earnOnInstallments} onChange={(e) => setForm({ ...form, earnOnInstallments: e.target.checked })} />
          تعلق کش‌بک به خرید اقساطی (پیش‌فرض: خاموش)
        </label>
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={form.redeemOnInstallments} onChange={(e) => setForm({ ...form, redeemOnInstallments: e.target.checked })} />
          استفاده از کیف پول در خرید اقساطی (پیش‌فرض: خاموش)
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <Btn variant="accent" icon={<Settings2 size={14} />} disabled={busy} onClick={() => void save()}>ذخیره تنظیمات</Btn>
      </div>
    </Card>
  );
}
