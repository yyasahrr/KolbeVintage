import { useCallback, useEffect, useState } from "react";
import { Fingerprint, History, KeyRound, Laptop, ShieldCheck, Smartphone, UserCog } from "lucide-react";
import { fmtNum } from "../data/catalog";
import { formatPersianDateTime } from "../data/persian-date";
import { profileApi } from "../data/api";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Segmented, Select, Status } from "./primitives";

const stamp = (value: unknown) => (value ? formatPersianDateTime(String(value)) : "—");
const text = (value: unknown, fallback = "—") => (value === null || value === undefined || value === "" ? fallback : String(value));
const num = (value: unknown) => fmtNum(Number(value ?? 0));

type Tab = "identity" | "security";
const TABS: { v: Tab; label: string }[] = [
  { v: "identity", label: "اطلاعات هویتی" },
  { v: "security", label: "مرکز امنیت" },
];

type PendingChange = { id: string; kind: string; new_value: string; channel: string; expires_at: string };

/** Customer self-service center (items 101-104): editable profile with audit,
 *  verified email/phone change, sessions, password, 2FA and login history. */
export function SecurityCenter({ flash, initialTab = "identity" }: { flash: (message: string) => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [security, setSecurity] = useState<Record<string, unknown>>({});
  const [sessions, setSessions] = useState<Record<string, unknown>[]>([]);
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [twoFactor, setTwoFactor] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [identity, setIdentity] = useState({ displayName: "", firstName: "", lastName: "", city: "", birthday: "", gender: "unspecified" });
  const [change, setChange] = useState<{ kind: "email" | "phone"; newValue: string }>({ kind: "email", newValue: "" });
  const [confirming, setConfirming] = useState<{ id: string; code: string } | null>(null);
  const [passwords, setPasswords] = useState({ current: "", next: "" });
  const [setup, setSetup] = useState<{ method: "otp_sms" | "authenticator"; code: string; otpauthUrl?: string; manualEntryKey?: string; deliveryHint?: string; developmentCode?: string } | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [me, sessionList, logins, factor] = await Promise.all([
        profileApi.get(), profileApi.sessions(), profileApi.loginHistory(30), profileApi.twoFactor(),
      ]);
      const record = (me.profile ?? {}) as Record<string, unknown>;
      setProfile(record);
      setSecurity((me.security ?? {}) as Record<string, unknown>);
      setSessions(sessionList.items); setHistory(logins.items);
      setTwoFactor(factor.twoFactor);
      setIdentity({
        displayName: text(record.display_name, ""), firstName: text(record.first_name, ""), lastName: text(record.last_name, ""),
        city: text(record.city, ""), birthday: record.birthday ? String(record.birthday).slice(0, 10) : "", gender: "unspecified",
      });
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری مرکز حساب"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    try { await action(); flash(`${label} انجام شد`); await load(); }
    catch (e) { flash(e instanceof Error ? e.message : "خطا در اجرای عملیات"); }
  };

  if (loading && !profile) return <LoadingState label="در حال بارگذاری اطلاعات حساب…" />;
  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  const pendingChanges = (security.pendingChanges ?? []) as unknown as PendingChange[];
  const twoFactorEnabled = Boolean(twoFactor?.enabled);

  return (
    <div className="space-y-4 animate-[fadeUp_0.35s_ease]">
      <Card className="p-4"><Segmented options={TABS} value={tab} onChange={setTab} /></Card>

      {tab === "identity" && (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><UserCog size={16} />اطلاعات پروفایل</div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="نام نمایشی"><Input value={identity.displayName} onChange={(v) => setIdentity({ ...identity, displayName: v })} /></Field>
              <Field label="نام"><Input value={identity.firstName} onChange={(v) => setIdentity({ ...identity, firstName: v })} /></Field>
              <Field label="نام خانوادگی"><Input value={identity.lastName} onChange={(v) => setIdentity({ ...identity, lastName: v })} /></Field>
              <Field label="شهر"><Input value={identity.city} onChange={(v) => setIdentity({ ...identity, city: v })} /></Field>
              <Field label="تاریخ تولد (YYYY-MM-DD)"><Input value={identity.birthday} onChange={(v) => setIdentity({ ...identity, birthday: v })} /></Field>
              <Field label="جنسیت"><Select options={["unspecified", "female", "male"]} value={identity.gender} onChange={(v) => setIdentity({ ...identity, gender: v })} /></Field>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
              ایمیل فعلی: {text(profile?.email)} · همراه: {text(profile?.phone)}
              <Btn variant="accent" size="sm" onClick={() => void run("ذخیره پروفایل", () => profileApi.update({
                displayName: identity.displayName || undefined,
                firstName: identity.firstName || null, lastName: identity.lastName || null,
                city: identity.city || null, gender: identity.gender,
                birthday: /^\d{4}-\d{2}-\d{2}$/.test(identity.birthday) ? identity.birthday : null,
              }))}>ذخیره تغییرات</Btn>
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">هر ویرایش با مقدار قبلی، مقدار جدید، کاربر و زمان در گزارش ممیزی ثبت می‌شود.</p>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Smartphone size={16} />تغییر ایمیل / شماره همراه (با تأیید)</div>
            <div className="grid gap-3 md:grid-cols-[160px_1fr_auto]">
              <Select options={["email", "phone"]} value={change.kind} onChange={(v) => setChange({ ...change, kind: v as "email" | "phone" })} />
              <Input value={change.newValue} onChange={(v) => setChange({ ...change, newValue: v })}
                placeholder={change.kind === "email" ? "name@example.com" : "09xxxxxxxxx"} />
              <Btn variant="soft" disabled={change.newValue.trim().length < 5}
                onClick={() => void run("ثبت درخواست تغییر", async () => {
                  const result = await profileApi.requestContactChange({
                    kind: change.kind, newValue: change.newValue.trim(), idempotencyKey: crypto.randomUUID(),
                  });
                  setConfirming({ id: result.requestId, code: "" });
                  setChange({ ...change, newValue: "" });
                  flash(result.developmentCode ? `کد تأیید (محیط توسعه): ${result.developmentCode}` : result.deliveryHint);
                })}>ثبت درخواست</Btn>
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">
              تغییر ایمیل با لینک تأیید و تغییر شماره همراه با کد پیامکی (اعتبار ۱۵ دقیقه) انجام می‌شود؛ تا تأیید نشود مقدار قبلی معتبر می‌ماند.
            </p>
            {pendingChanges.length > 0 && (
              <div className="mt-3 space-y-2">
                {pendingChanges.map((pending) => (
                  <div key={pending.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-2.5 text-[12px]">
                    <span>{pending.kind === "email" ? "ایمیل" : "شماره همراه"} → <b>{pending.new_value}</b> ({pending.channel}) · انقضا {stamp(pending.expires_at)}</span>
                    <Btn variant="soft" size="sm" onClick={() => setConfirming({ id: pending.id, code: "" })}>تأیید با کد</Btn>
                  </div>
                ))}
              </div>
            )}
            {confirming && (
              <div className="mt-3 flex flex-wrap items-end gap-2 rounded-[11px] bg-[var(--kv-surface-2)]/70 p-3">
                <Field label="کد ۶ رقمی"><Input value={confirming.code} onChange={(v) => setConfirming({ ...confirming, code: v.replace(/\D/g, "").slice(0, 6) })} /></Field>
                <Btn variant="accent" size="sm" disabled={confirming.code.length !== 6}
                  onClick={() => void run("تأیید تغییر", async () => {
                    await profileApi.confirmContactChange(confirming.id, confirming.code);
                    setConfirming(null);
                  })}>تأیید</Btn>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "security" && (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Laptop size={16} />نشست‌های فعال ({num(sessions.length)})</div>
            <div className="space-y-2">
              {sessions.map((session) => (
                <div key={String(session.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-[11px] border border-[var(--kv-line)] p-2.5 text-[12px]">
                  <span>
                    {text(session.ip)} · {text(session.user_agent, "دستگاه نامشخص")}
                    <span className="block text-[11px] text-[var(--kv-muted)]">آخرین فعالیت {stamp(session.last_seen_at)} · انقضا {stamp(session.expires_at)}</span>
                  </span>
                  {session.current ? <Status value="نشست فعلی" /> : (
                    <Btn variant="ghost" size="sm" onClick={() => void run("خروج دستگاه", () => profileApi.revokeSession(String(session.id)))}>خروج از این دستگاه</Btn>
                  )}
                </div>
              ))}
              {!sessions.length && <Empty title="نشست فعالی نیست" desc="با ورود در دستگاه‌های دیگر، فهرست اینجا کامل می‌شود." />}
            </div>
            <Btn variant="soft" size="sm" className="mt-3" onClick={() => void run("خروج از سایر دستگاه‌ها", () => profileApi.revokeOtherSessions())}>خروج از همه دستگاه‌های دیگر</Btn>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><KeyRound size={16} />تغییر رمز عبور</div>
              <div className="space-y-2">
                <Field label="رمز فعلی"><Input type="password" value={passwords.current} onChange={(v) => setPasswords({ ...passwords, current: v })} /></Field>
                <Field label="رمز جدید (حداقل ۱۲ کاراکتر)"><Input type="password" value={passwords.next} onChange={(v) => setPasswords({ ...passwords, next: v })} /></Field>
                <Btn variant="accent" size="sm" disabled={passwords.next.length < 12 || !passwords.current}
                  onClick={() => void run("تغییر رمز", async () => {
                    const result = await profileApi.changePassword({ currentPassword: passwords.current, newPassword: passwords.next });
                    setPasswords({ current: "", next: "" });
                    flash(`${num(result.revokedOtherSessions)} نشست دیگر بسته شد.`);
                  })}>تغییر رمز</Btn>
              </div>
            </Card>

            <Card className="p-5">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><Fingerprint size={16} />ورود دومرحله‌ای {twoFactorEnabled ? <Status value="فعال" /> : <Status value="غیرفعال" />}</div>
              {!twoFactorEnabled && !setup && (
                <div className="space-y-2 text-[12px]">
                  <p className="text-[var(--kv-muted)]">روش را انتخاب کنید؛ در روش پیامکی، کد به شماره همراه ثبت‌شده ارسال می‌شود.</p>
                  <div className="flex gap-2">
                    <Btn variant="soft" size="sm" onClick={() => void run("شروع راه‌اندازی", async () => {
                      const result = await profileApi.setupTwoFactor("otp_sms");
                      setSetup({ method: "otp_sms", code: "", deliveryHint: result.deliveryHint, developmentCode: result.developmentCode });
                    })}>کد پیامکی</Btn>
                    <Btn variant="soft" size="sm" onClick={() => void run("شروع راه‌اندازی", async () => {
                      const result = await profileApi.setupTwoFactor("authenticator");
                      setSetup({ method: "authenticator", code: "", otpauthUrl: result.otpauthUrl, manualEntryKey: result.manualEntryKey });
                    })}>اپلیکیشن Authenticator</Btn>
                  </div>
                </div>
              )}
              {!twoFactorEnabled && setup && (
                <div className="space-y-2 text-[12px]">
                  {setup.method === "authenticator" ? (
                    <p className="break-all rounded-[11px] bg-[var(--kv-surface-2)]/70 p-2 text-[11px]">
                      کلید دستی: <code>{setup.manualEntryKey}</code><br />یا لینک otpauth: <code>{setup.otpauthUrl}</code>
                    </p>
                  ) : <p className="text-[var(--kv-muted)]">{setup.deliveryHint}{setup.developmentCode ? ` — کد محیط توسعه: ${setup.developmentCode}` : ""}</p>}
                  <Field label="کد ۶ رقمی تأیید"><Input value={setup.code} onChange={(v) => setSetup({ ...setup, code: v.replace(/\D/g, "").slice(0, 6) })} /></Field>
                  <div className="flex gap-2">
                    <Btn variant="accent" size="sm" disabled={setup.code.length !== 6}
                      onClick={() => void run("فعال‌سازی ورود دومرحله‌ای", async () => {
                        const result = await profileApi.confirmTwoFactor(setup.code);
                        setRecoveryCodes(result.recoveryCodes); setSetup(null);
                      })}>فعال‌سازی</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => setSetup(null)}>انصراف</Btn>
                  </div>
                </div>
              )}
              {recoveryCodes && (
                <div className="mt-3 rounded-[11px] border border-dashed border-[var(--kv-line)] p-3 text-[12px]">
                  <p className="font-bold">کدهای بازیابی (فقط همین یک‌بار نمایش داده می‌شوند)</p>
                  <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[12px] tabular-nums">
                    {recoveryCodes.map((code) => <span key={code}>{code}</span>)}
                  </div>
                  <Btn variant="ghost" size="sm" className="mt-2" onClick={() => setRecoveryCodes(null)}>ذخیره کردم</Btn>
                </div>
              )}
              {twoFactorEnabled && (
                <div className="space-y-2 text-[12px]">
                  <p className="text-[var(--kv-muted)]">روش فعال: {twoFactor?.method === "otp_sms" ? "کد پیامکی" : "اپلیکیشن Authenticator"}</p>
                  <div className="flex items-end gap-2">
                    <Field label="برای غیرفعال‌سازی، رمز عبور را وارد کنید"><Input type="password" value={disablePassword} onChange={setDisablePassword} /></Field>
                    <Btn variant="soft" size="sm" disabled={!disablePassword}
                      onClick={() => void run("غیرفعال‌سازی", async () => {
                        await profileApi.disableTwoFactor(disablePassword);
                        setDisablePassword("");
                      })}>غیرفعال‌سازی</Btn>
                  </div>
                </div>
              )}
            </Card>
          </div>

          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-extrabold"><History size={16} />تاریخچه ورود</div>
            <div className="kv-scroll overflow-x-auto">
              <table className="w-full min-w-[640px] text-right text-[12.5px]">
                <thead><tr className="text-[11.5px] text-[var(--kv-muted)]">
                  <th className="pb-2">زمان</th><th className="pb-2">نتیجه</th><th className="pb-2">دلیل</th><th className="pb-2">IP</th><th className="pb-2">دستگاه</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--kv-line)]">
                  {history.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="py-2">{stamp(row.created_at)}</td>
                      <td className="py-2">{row.success ? <Status value="موفق" /> : <Status value="ناموفق" />}</td>
                      <td className="py-2 text-[11.5px]">{text(row.reason)}</td>
                      <td className="py-2 tabular-nums">{text(row.ip)}</td>
                      <td className="py-2 text-[11.5px]">{text(row.user_agent, "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!history.length && <Empty title="ورودی ثبت نشده" desc="ورودهای موفق و ناموفق اینجا برای پیگیری امنیتی ثبت می‌شوند." />}
            </div>
            <p className="mt-3 flex items-center gap-2 text-[11.5px] text-[var(--kv-muted)]">
              <ShieldCheck size={14} />ورود دومرحله‌ای از دو مسیر کد پیامکی و اپلیکیشن پشتیبانی می‌کند و کدهای بازیابی یک‌بارمصرف‌اند.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
