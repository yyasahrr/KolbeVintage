import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Play, Plus, RefreshCw, Trash2, Upload, XCircle } from "lucide-react";
import { Btn, Card, Drawer, Empty, ErrorState, Field, LoadingState, Select, Segmented, Status } from "./primitives";
import { importsApi } from "../data/api";
import {
  IMPORT_FIELD_LABEL, IMPORT_MATCH_LABEL, IMPORT_MODE_LABEL, IMPORT_STATUS_LABEL, IMPORT_TYPE_LABEL,
  normalizeImportJob, normalizeImportJobs, type ImportJob, type ImportType,
} from "../data/contracts";
import { cn } from "../utils/cn";

type F = (message: string) => void;
type UploadResult = {
  jobId: string; type: ImportType; mode: string; matchBy: string; format: string;
  totalRows: number; headers: string[]; mapping: Record<string, string>; imageHeaders: string[];
  unmapped: string[]; requiredMissing: string[]; preview: Record<string, unknown>[];
  duplicateWarning: { message: string; jobs: { id: string; filename: string; created_at: string }[] } | null;
};
type DryRunResult = { jobId: string; total: number; valid: number; warnings: number; errors: number; errorSample: { row: number; message: string }[] };

const readUpload = (raw: unknown): UploadResult => {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    jobId: String(row.jobId), type: (row.type === "inventory" || row.type === "users" ? row.type : "products") as ImportType,
    mode: String(row.mode ?? ""), matchBy: String(row.matchBy ?? ""), format: String(row.format ?? ""),
    totalRows: Number(row.totalRows ?? 0) || 0,
    headers: (Array.isArray(row.headers) ? row.headers : []) as string[],
    mapping: (row.mapping ?? {}) as Record<string, string>,
    imageHeaders: (Array.isArray(row.imageHeaders) ? row.imageHeaders : []) as string[],
    unmapped: (Array.isArray(row.unmapped) ? row.unmapped : []) as string[],
    requiredMissing: (Array.isArray(row.requiredMissing) ? row.requiredMissing : []) as string[],
    preview: (Array.isArray(row.preview) ? row.preview : []) as Record<string, unknown>[],
    duplicateWarning: (row.duplicateWarning ?? null) as UploadResult["duplicateWarning"],
  };
};
const readDryRun = (raw: unknown): DryRunResult => {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    jobId: String(row.jobId), total: Number(row.total ?? 0) || 0, valid: Number(row.valid ?? 0) || 0,
    warnings: Number(row.warnings ?? 0) || 0, errors: Number(row.errors ?? 0) || 0,
    errorSample: (Array.isArray(row.errorSample) ? row.errorSample : []) as DryRunResult["errorSample"],
  };
};

const MATCH_OPTIONS: Record<ImportType, string[]> = {
  products: ["legacy_id", "sku", "product_code"],
  inventory: ["sku"],
  users: ["email", "phone", "legacy_id"],
};

export function ImportCenterPanel({ flash }: { flash: F }) {
  const [jobs, setJobs] = useState<ImportJob[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<ImportJob | null>(null);
  const [wizard, setWizard] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<ImportType>("products");
  const [mode, setMode] = useState("create_update");
  const [matchBy, setMatchBy] = useState("legacy_id");
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await importsApi.history().then(normalizeImportJobs);
      setJobs(list);
      setSel((current) => (current && list.some((job) => job.id === current) ? current : list[0]?.id ?? null));
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری تاریخچه ورود داده"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!sel) { setDetail(null); return; }
    let live = true;
    const tick = () => {
      importsApi.detail(sel).then(normalizeImportJob).then((job) => { if (live) setDetail(job); }).catch(() => { /* keep last */ });
    };
    tick();
    const timer = window.setInterval(tick, 2500);
    return () => { live = false; window.clearInterval(timer); };
  }, [sel]);

  const startWizard = () => {
    setFile(null); setKind("products"); setMode("create_update"); setMatchBy("legacy_id");
    setUpload(null); setMapping({}); setDry(null); setStep(1); setWizard(true);
  };
  const doUpload = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const result = readUpload(await importsApi.upload(file, file.name, { type: kind, mode, matchBy }));
      setUpload(result);
      setMapping(result.mapping);
      setStep(2);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری فایل"); }
    finally { setBusy(false); }
  };
  const saveMapping = async (next: 3 | 4) => {
    if (!upload) return;
    setBusy(true); setError(null);
    try {
      await importsApi.updateMapping(upload.jobId, { mapping });
      if (next === 3) {
        const result = readDryRun(await importsApi.dryRun(upload.jobId));
        setDry(result);
      }
      setStep(next);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در ذخیره نگاشت"); }
    finally { setBusy(false); }
  };
  const runJob = async (jobId: string) => {
    setBusy(true); setError(null);
    try {
      await importsApi.run(jobId);
      setWizard(false);
      await load();
      setSel(jobId);
      flash("اجرای ورود داده در پس‌زمینه شروع شد");
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در اجرای ورود داده"); }
    finally { setBusy(false); }
  };

  const fields = upload ? IMPORT_FIELD_LABEL[upload.type] : {};
  const report = (detail?.report ?? {}) as { errors?: { row: number; message: string }[]; warnings?: { row: number; message: string }[]; resetTokens?: { row: number; token: string }[]; dryRun?: DryRunResult };
  const progress = detail && detail.totalRows > 0 ? Math.round((detail.processedRows / detail.totalRows) * 100) : 0;

  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <p className="text-[13px] text-[var(--kv-muted)]">فایل CSV/Excel (تا ۲۰٬۰۰۰ سطر) یا ZIP داده+تصویر · بررسی آزمایشی بدون ثبت · اجرای پس‌زمینه با گزارش سطر‌به‌سطر</p>
        <span className="mr-auto flex gap-2">
          <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>به‌روزرسانی</Btn>
          <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={startWizard}>ورود داده جدید</Btn>
        </span>
      </div>
      {error && <div className="mb-4"><ErrorState message={error} onRetry={() => void load()} /></div>}
      {!jobs ? <LoadingState label="در حال بارگذاری تاریخچه…" /> : (
        <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Card className="h-fit overflow-hidden">
            <p className="p-4 pb-2 text-sm font-extrabold">تاریخچه اجراها</p>
            {jobs.length === 0 ? <div className="p-4"><Empty title="اجرایی ثبت نشده" desc="نخستین فایل را با «ورود داده جدید» بارگذاری کنید." /></div> : (
              <div className="kv-scroll max-h-[560px] divide-y divide-[var(--kv-line)] overflow-y-auto">
                {jobs.map((job) => (
                  <button key={job.id} onClick={() => setSel(job.id)} className={cn("flex w-full items-center gap-2.5 px-4 py-3 text-right hover:bg-[var(--kv-surface-2)]", sel === job.id && "bg-[var(--kv-accent)]/[0.05]")}>
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-[13px]">{job.filename}</b>
                      <span className="text-[11.5px] text-[var(--kv-muted)]">{IMPORT_TYPE_LABEL[job.type]} · {job.totalRows.toLocaleString("fa-IR")} سطر · {job.createdByName ?? "—"}</span>
                    </span>
                    <Status value={IMPORT_STATUS_LABEL[job.status] ?? job.status} />
                  </button>
                ))}
              </div>
            )}
          </Card>
          <Card className="h-fit p-5">
            {!detail ? <Empty title="اجرایی انتخاب نشده" desc="از تاریخچه یک اجرا را انتخاب کنید." /> : (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><h3 className="text-[15px] font-extrabold">{detail.filename}</h3>
                    <p className="text-xs text-[var(--kv-muted)]">{IMPORT_TYPE_LABEL[detail.type]} · {IMPORT_MODE_LABEL[detail.mode] ?? detail.mode} · تطبیق با {IMPORT_MATCH_LABEL[detail.matchBy] ?? detail.matchBy}</p></div>
                  <Status value={IMPORT_STATUS_LABEL[detail.status] ?? detail.status} />
                </div>
                {(detail.status === "running" || detail.status === "queued") && (
                  <div className="mt-3"><div className="h-2 overflow-hidden rounded-full bg-[var(--kv-surface-3)]"><div className="h-full rounded-full bg-[var(--kv-accent)] transition-all" style={{ width: `${progress}%` }} /></div>
                    <p className="mt-1 text-[11.5px] text-[var(--kv-muted)] tabular-nums">{detail.processedRows.toLocaleString("fa-IR")} از {detail.totalRows.toLocaleString("fa-IR")} سطر ({progress.toLocaleString("fa-IR")}٪)</p></div>
                )}
                <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                  {[["موفق", detail.succeededRows], ["ناموفق", detail.failedRows], ["هشدار", detail.warningRows], ["مدت (ثانیه)", detail.durationSeconds ?? 0]].map(([label, value]) => (
                    <div key={label as string} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-2"><p className="text-[15px] font-extrabold tabular-nums">{Number(value).toLocaleString("fa-IR")}</p><p className="text-[10.5px] text-[var(--kv-muted)]">{label as string}</p></div>
                  ))}
                </div>
                {(report.errors?.length ?? 0) > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-[13px] font-extrabold">خطاها ({report.errors!.length.toLocaleString("fa-IR")})</p>
                    <div className="kv-scroll max-h-48 space-y-1.5 overflow-y-auto">
                      {report.errors!.slice(0, 50).map((entry, i) => (
                        <p key={i} className="rounded-[8px] bg-[var(--kv-danger)]/[0.06] px-3 py-1.5 text-[12px]"><b className="tabular-nums">سطر {entry.row.toLocaleString("fa-IR")}:</b> {entry.message}</p>
                      ))}
                    </div>
                  </div>
                )}
                {(report.warnings?.length ?? 0) > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-[13px] font-extrabold">هشدارها ({report.warnings!.length.toLocaleString("fa-IR")})</p>
                    <div className="kv-scroll max-h-32 space-y-1.5 overflow-y-auto">
                      {report.warnings!.slice(0, 30).map((entry, i) => (
                        <p key={i} className="rounded-[8px] bg-[var(--kv-surface-2)]/70 px-3 py-1.5 text-[12px]"><b className="tabular-nums">سطر {entry.row.toLocaleString("fa-IR")}:</b> {entry.message}</p>
                      ))}
                    </div>
                  </div>
                )}
                {(report.resetTokens?.length ?? 0) > 0 && (
                  <div className="mt-4 rounded-[12px] border border-[var(--kv-line)] p-3">
                    <p className="text-[13px] font-extrabold">توکن‌های یک‌بارمصرف فعال‌سازی ({report.resetTokens!.length.toLocaleString("fa-IR")})</p>
                    <p className="mt-1 text-[11.5px] leading-5 text-[var(--kv-muted)]">گذرواژه کاربران مهاجر وارد نشده است؛ این توکن‌ها را برایشان ارسال کنید تا گذرواژه جدید بسازند. هر توکن فقط یک‌بار نمایش داده می‌شود.</p>
                    <div className="kv-scroll mt-2 max-h-40 space-y-1 overflow-y-auto" dir="ltr">
                      {report.resetTokens!.slice(0, 100).map((entry) => <p key={entry.row} className="rounded bg-[var(--kv-surface-2)] px-2 py-1 font-mono text-[11px]">row {entry.row}: {entry.token}</p>)}
                    </div>
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--kv-line)] pt-4">
                  {detail.status === "queued" && <Btn variant="accent" size="sm" icon={<Play size={14} />} onClick={() => void runJob(detail.id)}>اجرای نهایی</Btn>}
                  {(detail.status === "done" || detail.status === "failed") && detail.failedRows > 0 && (
                    <Btn variant="soft" size="sm" icon={<RefreshCw size={14} />} onClick={() => void (async () => { try { await importsApi.retry(detail.id); await load(); flash("سطرهای ناموفق دوباره به صف اجرا برگشتند"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>تلاش مجدد سطرهای ناموفق</Btn>
                  )}
                  {(detail.status === "queued" || detail.status === "running") && (
                    <Btn variant="soft" size="sm" icon={<XCircle size={14} />} onClick={() => void (async () => { try { await importsApi.cancel(detail.id); await load(); flash("اجرا لغو شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>لغو اجرا</Btn>
                  )}
                  {detail.failedRows > 0 && <Btn variant="soft" size="sm" icon={<Download size={14} />} onClick={() => void importsApi.downloadErrorsCsv(detail.id).catch((e: unknown) => flash(e instanceof Error ? e.message : "خطا در دانلود"))}>دانلود خطاها (CSV)</Btn>}
                  {(detail.status === "done" || detail.status === "failed" || detail.status === "cancelled") && (
                    <Btn variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void (async () => { try { await importsApi.remove(detail.id); await load(); flash("رکورد اجرا حذف شد"); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } })()}>حذف رکورد</Btn>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      <Drawer open={wizard} onClose={() => setWizard(false)} title="ورود داده جدید" wide>
        <Segmented<`${1 | 2 | 3 | 4}`> options={[{ v: "1", label: "۱· فایل" }, { v: "2", label: "۲· نگاشت ستون‌ها" }, { v: "3", label: "۳· بررسی آزمایشی" }, { v: "4", label: "۴· اجرا" }]} value={String(step) as "1"} onChange={(v) => { if (Number(v) < step) setStep(Number(v) as 1 | 2 | 3 | 4); }} />
        <div className="mt-4">
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="نوع داده"><Select options={["products", "inventory", "users"].map((t) => IMPORT_TYPE_LABEL[t as ImportType])} value={IMPORT_TYPE_LABEL[kind]} onChange={(label) => { const found = (["products", "inventory", "users"] as ImportType[]).find((t) => IMPORT_TYPE_LABEL[t] === label) ?? "products"; setKind(found); setMatchBy(MATCH_OPTIONS[found][0]!); }} /></Field>
                <Field label="حالت"><Select options={["create_only", "update", "create_update"].map((m) => IMPORT_MODE_LABEL[m]!)} value={IMPORT_MODE_LABEL[mode]!} onChange={(label) => setMode(["create_only", "update", "create_update"].find((m) => IMPORT_MODE_LABEL[m] === label) ?? "create_update")} /></Field>
                <Field label="کلید تطبیق" hint={kind === "inventory" ? "موجودی فقط با SKU وارد می‌شود" : undefined}>
                  <Select options={MATCH_OPTIONS[kind].map((m) => IMPORT_MATCH_LABEL[m]!)} value={IMPORT_MATCH_LABEL[matchBy]!} onChange={(label) => setMatchBy(MATCH_OPTIONS[kind].find((m) => IMPORT_MATCH_LABEL[m] === label) ?? MATCH_OPTIONS[kind][0]!)} />
                </Field>
              </div>
              {kind === "users" && <p className="rounded-[12px] bg-[var(--kv-accent)]/[0.07] p-3 text-[12.5px] leading-6">ستون گذرواژه (در صورت وجود) <b>نادیده گرفته می‌شود</b>؛ برای هر کاربر توکن یک‌بارمصرف تعیین گذرواژه صادر می‌شود.</p>}
              {kind === "inventory" && <p className="rounded-[12px] bg-[var(--kv-accent)]/[0.07] p-3 text-[12.5px] leading-6">ستون «حالت» هر سطر می‌تواند <code dir="ltr">receipt</code> (افزایش موجودی با رسید) یا <code dir="ltr">set</code> (تنظیم دقیق) باشد.</p>}
              <div>
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls,.zip" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <button onClick={() => fileRef.current?.click()} className="flex w-full flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed border-[var(--kv-line-strong)] py-8 text-[13px] font-semibold text-[var(--kv-muted)] hover:border-[var(--kv-accent)]">
                  <Upload size={20} />{file ? file.name : "انتخاب فایل CSV / Excel / ZIP"}<span className="text-[11.5px]">حداکثر ۱۰ مگابایت · تا ۲۰٬۰۰۰ سطر</span>
                </button>
              </div>
              {file && upload === null && <Btn variant="accent" className="w-full" disabled={busy} onClick={() => void doUpload()}>{busy ? "در حال بارگذاری…" : "بارگذاری و تشخیص ستون‌ها"}</Btn>}
            </div>
          )}
          {step === 2 && upload && (
            <div className="space-y-4">
              {upload.duplicateWarning && <p role="alert" className="rounded-[12px] bg-[var(--kv-danger)]/[0.07] p-3 text-[12.5px] leading-6 text-[var(--kv-danger)]">{upload.duplicateWarning.message}</p>}
              {upload.requiredMissing.length > 0 && <p className="rounded-[12px] bg-[#B7791F]/10 p-3 text-[12.5px] leading-6">نگاشت ناقص است: {upload.requiredMissing.join("، ")} — ستون متناظر را انتخاب کنید.</p>}
              <p className="text-[12.5px] text-[var(--kv-muted)]">
                <span className="rounded-full bg-[var(--kv-surface-2)] px-2.5 py-0.5 text-[11.5px] font-bold" dir="ltr">{upload.format.toUpperCase() || "?"}</span>
                {" "}{upload.totalRows.toLocaleString("fa-IR")} سطر · نگاشت هوشمند بر اساس نام ستون‌ها انجام شد؛ در صورت نیاز اصلاح کنید.
              </p>
              {upload.preview.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[12.5px] font-extrabold">پیش‌نمایش سطرهای خوانده‌شده</p>
                  <div className="kv-scroll overflow-x-auto rounded-[10px] border border-[var(--kv-line)]">
                    <table className="kv-table min-w-[560px]">
                      <thead><tr>{upload.headers.map((header) => <th key={header} dir="auto">{header}</th>)}</tr></thead>
                      <tbody>
                        {upload.preview.map((row, i) => (
                          <tr key={i}>{upload.headers.map((header) => <td key={header} dir="auto">{String(row[header] ?? "—").slice(0, 60)}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {upload.imageHeaders.length > 0 && <p className="text-[12px] text-[var(--kv-muted)]">ستون‌های تصویر (دانلود خودکار به انباره فایل): {upload.imageHeaders.join("، ")}</p>}
              <div className="space-y-2">
                {Object.entries(fields).map(([field, label]) => (
                  <div key={field} className="grid grid-cols-2 items-center gap-2">
                    <span className="text-[12.5px] font-bold">{label}</span>
                    <Select options={["—", ...upload.headers]} value={mapping[field] ?? "—"} onChange={(v) => setMapping((current) => { const next = { ...current }; if (v === "—") delete next[field]; else next[field] = v; return next; })} />
                  </div>
                ))}
              </div>
              {upload.unmapped.length > 0 && <p className="text-[12px] text-[var(--kv-muted)]">ستون‌های نادیده‌گرفته‌شده: {upload.unmapped.join("، ")}</p>}
              <div className="flex gap-2">
                <Btn variant="soft" onClick={() => setStep(1)}>بازگشت</Btn>
                <Btn variant="accent" className="flex-1" disabled={busy} onClick={() => void saveMapping(3)}>{busy ? "در حال بررسی…" : "ذخیره نگاشت و بررسی آزمایشی"}</Btn>
              </div>
            </div>
          )}
          {step === 3 && dry && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                {[["معتبر", dry.valid], ["هشدار", dry.warnings], ["نامعتبر", dry.errors]].map(([label, value]) => (
                  <div key={label as string} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-2 py-3"><p className="text-lg font-extrabold tabular-nums">{Number(value).toLocaleString("fa-IR")}</p><p className="text-[11px] text-[var(--kv-muted)]">{label as string}</p></div>
                ))}
              </div>
              {dry.errorSample.length > 0 && (
                <div className="kv-scroll max-h-56 space-y-1.5 overflow-y-auto">
                  {dry.errorSample.map((entry, i) => <p key={i} className="rounded-[8px] bg-[var(--kv-danger)]/[0.06] px-3 py-1.5 text-[12px]"><b className="tabular-nums">سطر {entry.row.toLocaleString("fa-IR")}:</b> {entry.message}</p>)}
                </div>
              )}
              <p className="text-[12px] text-[var(--kv-muted)]">بررسی آزمایشی چیزی در دیتابیس ثبت نکرد. با «اجرای نهایی» سطرهای معتبر واقعاً ثبت می‌شوند.</p>
              <div className="flex gap-2">
                <Btn variant="soft" onClick={() => setStep(2)}>اصلاح نگاشت</Btn>
                <Btn variant="accent" className="flex-1" disabled={busy || dry.valid === 0} onClick={() => void saveMapping(4)}>تأیید و رفتن به اجرا</Btn>
              </div>
            </div>
          )}
          {step === 4 && upload && (
            <div className="space-y-4">
              <Card className="p-4">
                <p className="text-[13px] font-extrabold">{upload.totalRows.toLocaleString("fa-IR")} سطر آماده اجراست</p>
                <p className="mt-1 text-[12.5px] text-[var(--kv-muted)]">اجرا در پس‌زمینه انجام می‌شود؛ می‌توانید این پنجره را ببندید و از تاریخچه دنبال کنید. سطرهای ناموفق بعداً قابل تلاش مجدد هستند.</p>
              </Card>
              <div className="flex gap-2">
                <Btn variant="soft" onClick={() => setStep(3)}>بازگشت</Btn>
                <Btn variant="accent" className="flex-1" disabled={busy} icon={<Play size={15} />} onClick={() => void runJob(upload.jobId)}>اجرای نهایی</Btn>
              </div>
            </div>
          )}
        </div>
      </Drawer>
    </div>
  );
}
