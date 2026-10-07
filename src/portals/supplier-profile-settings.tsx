import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";
import { profileApi, studioApi, type ProfileResponse, type SupplierDiff } from "../data/experience-api";
import { formatPersianDateTime } from "../data/persian-date";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Segmented, Status, Textarea } from "../components/primitives";
import { ProfileCenter } from "./account-center";

/* Supplier profile with an approval policy (Req 339-341):
   public fields change instantly; legal/bank/tax fields become a versioned change request with a diff. */

const STATUS: Record<string, string> = { pending_review: "در انتظار بررسی", approved: "تأیید شد", rejected: "رد شد" };

function DiffTable({ diff }: { diff: SupplierDiff[] }) {
  return (
    <table className="kv-table w-full text-[12px]"><thead><tr><th>فیلد</th><th>مقدار فعلی</th><th /><th>مقدار پیشنهادی</th></tr></thead>
      <tbody>{diff.map((d) => <tr key={d.field}><td className="font-bold">{d.label}</td><td dir="ltr" className="text-[var(--kv-muted)] line-through">{d.oldValue ?? "—"}</td><td><ArrowLeft size={12} /></td><td dir="ltr" className="font-bold text-[var(--kv-success)]">{d.newValue ?? "—"}</td></tr>)}</tbody></table>
  );
}

export function SupplierProfileSettings({ flash }: { flash: (m: string) => void }) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [requests, setRequests] = useState<Awaited<ReturnType<typeof profileApi.supplierChangeRequests>>["items"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pub, setPub] = useState({ bio: "", publicDescription: "", contactPerson: "" });
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [section, setSection] = useState<"business" | "personal">("business");
  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, r] = await Promise.all([profileApi.get(), profileApi.supplierChangeRequests()]);
      setProfile(p); setRequests(r.items);
      const s = p.roleProfiles.supplier ?? {};
      setPub({ bio: s.bio ?? "", publicDescription: s.public_description ?? "", contactPerson: s.contact_person ?? "" });
    } catch (e) { setError(e instanceof Error ? e.message : "خطا"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profile || !requests) return <LoadingState />;
  const supplier = profile.roleProfiles.supplier ?? {};
  const column: Record<string, string> = { legalName: "legal_name", nationalId: "national_id", registrationNumber: "registration_number", economicCode: "economic_code", taxInfo: "tax_info", bankName: "bank_name", accountNumber: "account_number", bankIban: "bank_iban", accountHolder: "account_holder" };
  const pending = requests.find((r) => r.status === "pending_review");
  const dirty = Object.entries(changes).filter(([k, v]) => v.trim() !== (supplier[column[k]!] ?? ""));
  return (
    <div className="max-w-[860px] space-y-5">
      <Segmented<"business" | "personal"> options={[{ v: "business", label: "پروفایل تجاری" }, { v: "personal", label: "حساب شخصی و امنیت" }]} value={section} onChange={setSection} />
      {section === "personal" ? <ProfileCenter /> : (<>
        <Card className="space-y-3 p-5">
          <p className="text-[15px] font-extrabold">اطلاعات عمومی (بدون نیاز به تأیید)</p>
          <Field label="شخص رابط"><Input value={pub.contactPerson} onChange={(contactPerson) => setPub({ ...pub, contactPerson })} /></Field>
          <Field label="معرفی کوتاه (Bio)"><Textarea rows={2} value={pub.bio} onChange={(bio) => setPub({ ...pub, bio })} /></Field>
          <Field label="توضیحات عمومی برند"><Textarea rows={4} value={pub.publicDescription} onChange={(publicDescription) => setPub({ ...pub, publicDescription })} /></Field>
          <p className="text-[11.5px] text-[var(--kv-muted)]">تصویر پروفایل از تب «حساب شخصی و امنیت» تغییر می‌کند و روی پروفایل تجاری هم اعمال می‌شود.</p>
          <Btn variant="accent" size="sm" disabled={busy === "pub"} onClick={async () => { setBusy("pub"); try { await profileApi.supplierPublic(pub); flash("اطلاعات عمومی ذخیره شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(""); } }}>ذخیره</Btn>
        </Card>
        <Card className="space-y-3 p-5">
          <p className="flex items-center gap-2 text-[15px] font-extrabold"><ShieldCheck size={16} />اطلاعات حقوقی، بانکی و مالیاتی</p>
          <p className="text-[12px] leading-6 text-[var(--kv-muted)]">این اطلاعات مستقیم تغییر نمی‌کنند؛ تغییرات به‌صورت درخواست ثبت و پس از بررسی مدیریت، نسخه جدید پروفایل فعال می‌شود.</p>
          {pending ? (
            <div className="space-y-2 rounded-[12px] border border-[var(--kv-warning)]/40 bg-[var(--kv-warning)]/[0.06] p-3"><p className="text-[12.5px] font-bold">درخواست در انتظار بررسی — {formatPersianDateTime(pending.created_at)}</p><DiffTable diff={pending.diff} /></div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {profile.policy.supplierApproval.map((f) => (
                  <Field key={f.key} label={f.label} hint={`فعلی: ${supplier[column[f.key]!] ?? "ثبت نشده"}`}>
                    <Input value={changes[f.key] ?? supplier[column[f.key]!] ?? ""} onChange={(v) => setChanges({ ...changes, [f.key]: f.key === "bankIban" ? v.toUpperCase().replace(/\s/g, "") : v })} />
                  </Field>
                ))}
              </div>
              <Field label="توضیح برای مدیریت"><Input value={note} onChange={setNote} placeholder="مثلاً تغییر حساب بانکی شرکت" /></Field>
              <Btn variant="accent" size="sm" disabled={!dirty.length || busy === "req"} icon={busy === "req" ? <Loader2 size={14} className="animate-spin" /> : undefined}
                onClick={async () => { setBusy("req"); try { const r = await profileApi.supplierChangeRequest(Object.fromEntries(dirty.map(([k, v]) => [k, v.trim() || null])), note || undefined); flash(`درخواست تغییر ${r.diff.length} فیلد برای بررسی ارسال شد`); setChanges({}); setNote(""); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(""); } }}>
                ارسال درخواست تغییر ({dirty.length.toLocaleString("fa-IR")} فیلد)
              </Btn>
            </>
          )}
        </Card>
        <Card className="p-5">
          <p className="mb-3 text-[14px] font-extrabold">سابقه درخواست‌ها</p>
          {requests.length === 0 ? <p className="text-[12.5px] text-[var(--kv-muted)]">درخواستی ثبت نشده است.</p> : (
            <ul className="space-y-3">{requests.map((r) => <li key={r.id} className="space-y-2 rounded-[12px] border border-[var(--kv-line)] p-3"><div className="flex flex-wrap items-center gap-2"><Status value={STATUS[r.status] ?? r.status} /><span className="text-[11.5px] text-[var(--kv-muted)]">{formatPersianDateTime(r.created_at)}</span>{r.review_note && <span className="text-[11.5px]">یادداشت مدیریت: {r.review_note}</span>}</div><DiffTable diff={r.diff} /></li>)}</ul>
          )}
        </Card>
      </>)}
    </div>
  );
}

/** Admin side: diff review, approve activates a new supplier profile version; reject requires a reason. */
export function SupplierChangeReview({ flash }: { flash: (m: string) => void }) {
  const [status, setStatus] = useState<"pending_review" | "approved" | "rejected">("pending_review");
  const [items, setItems] = useState<Awaited<ReturnType<typeof studioApi.supplierChanges>>["items"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => { setError(null); try { setItems((await studioApi.supplierChanges(status)).items); } catch (e) { setError(e instanceof Error ? e.message : "خطا"); } }, [status]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[15px] font-extrabold">درخواست‌های تغییر اطلاعات حساس تأمین‌کنندگان</p>
        <Segmented<"pending_review" | "approved" | "rejected"> options={[{ v: "pending_review", label: "در انتظار" }, { v: "approved", label: "تأییدشده" }, { v: "rejected", label: "ردشده" }]} value={status} onChange={setStatus} /></div>
      {!items ? <LoadingState /> : items.length === 0 ? <Empty title="درخواستی نیست" desc="تغییر شبا، حساب بانکی، شناسه ملی و اطلاعات مالیاتی اینجا بررسی می‌شود." /> : items.map((r) => (
        <div key={r.id} className="space-y-2 rounded-[12px] border border-[var(--kv-line)] p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]"><b>{r.brand_name}</b><span className="text-[var(--kv-muted)]">{r.display_name} · {r.phone ?? "—"} · {formatPersianDateTime(r.created_at)}</span></div>
          {r.supplier_note && <p className="text-[12px] text-[var(--kv-muted)]">توضیح تأمین‌کننده: {r.supplier_note}</p>}
          <DiffTable diff={r.diff} />
          {r.status === "pending_review" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1"><Input value={notes[r.id] ?? ""} onChange={(v) => setNotes({ ...notes, [r.id]: v })} placeholder="یادداشت / دلیل رد" /></div>
              <Btn size="sm" variant="accent" onClick={async () => { try { await studioApi.reviewSupplierChange(r.id, "approved", notes[r.id]); flash("تأیید شد؛ نسخه جدید پروفایل فعال شد"); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } }}>تأیید</Btn>
              <Btn size="sm" variant="soft" disabled={(notes[r.id] ?? "").trim().length < 3} onClick={async () => { try { await studioApi.reviewSupplierChange(r.id, "rejected", notes[r.id]); flash("رد شد و به تأمین‌کننده اطلاع داده شد"); await load(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } }}>رد</Btn>
            </div>
          ) : r.review_note && <p className="text-[12px]">یادداشت: {r.review_note}</p>}
        </div>
      ))}
    </Card>
  );
}
