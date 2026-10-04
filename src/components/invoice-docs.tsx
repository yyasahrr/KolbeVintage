import { useEffect, useMemo, useState } from "react";
import {
  Card, Btn, Status, SearchBox, Empty, LoadingState, ErrorState, Field, Input, Select, Textarea,
  Drawer, Segmented, SectionHead, Checkbox, Modal,
} from "./primitives";
import { addDaysIso, formatPersianDate, formatPersianDateTime, isoDateOnly, todayIso } from "../data/persian-date";
import { PersianDatePicker } from "./persian-date-picker";
import { useSupplierOptions } from "./supplier-360";
import { invoiceDocsApi, invoicesApi, type InvoiceTemplateSummary } from "../data/api";
import { fmtNum } from "../data/catalog";
import { fmtToman } from "../data/contracts";
import {
  FileText, Plus, Eye, Send, Ban, Undo2, Download, Layers, RefreshCw, FileSignature,
} from "lucide-react";

/* Unified document engine (items 25-34).
 * One engine produces retail/wholesale/VIP/supplier/settlement/refund documents
 * from admin-editable, versioned templates. Everything printed here comes from a
 * stored server snapshot; the console never assembles a document by itself. */

const KIND_LABEL: Record<string, string> = {
  retail_sale: "فروش خرده",
  wholesale_sale: "فروش عمده",
  vip_sale: "فروش ویژه (VIP)",
  supplier_purchase: "خرید از تأمین‌کننده",
  supplier_statement: "صورت‌حساب تأمین‌کننده",
  settlement: "سند تسویه",
  refund: "بازپرداخت",
  return_credit: "اعتبار مرجوعی",
  credit_note: "اعتبارنامه",
  installment_plan: "فروش اقساطی",
  other: "سایر",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "پیش‌نویس", issued: "صادرشده", partially_paid: "پرداخت جزئی", paid: "پرداخت‌شده",
  cancelled: "لغوشده", refunded: "بازپرداخت‌شده", void: "باطل‌شده", credited: "اعتباری", revised: "اصلاح‌شده",
};

const SECTION_TYPES = ["keyValues", "table", "totals", "paragraph", "signature"] as const;

const SECTION_TYPE_LABEL: Record<string, string> = {
  keyValues: "کلید/مقدار", table: "جدول اقلام", totals: "جمع‌بندی مبالغ", paragraph: "پاراگراف متنی", signature: "محل امضا",
};

type TemplateSection = { id: string; type: string; title?: string; order?: number; visible?: boolean;
  fields?: string[]; text?: string; lines?: string[] };

const blankDefinition = (): Record<string, unknown> => ({
  paperSize: "A4",
  sections: [
    { id: "seller", type: "keyValues", title: "فروشنده", order: 1, visible: true, fields: ["seller.name", "seller.address"] },
    { id: "buyer", type: "keyValues", title: "خریدار", order: 2, visible: true, fields: ["customer.name", "customer.phone"] },
    { id: "items", type: "table", title: "اقلام", order: 3, visible: true },
    { id: "totals", type: "totals", order: 4, visible: true },
  ],
  footer: "کلبه وینتج",
});

export function InvoiceDocumentsPanel({ flash }: { flash?: (message: string) => void }) {
  const [tab, setTab] = useState<"documents" | "templates" | "statements">("documents");
  return (
    <div className="space-y-5 animate-[fadeUp_0.35s_ease]">
      <Segmented<"documents" | "templates" | "statements">
        options={[
          { v: "documents", label: "اسناد مالی" },
          { v: "templates", label: "قالب‌ها و نسخه‌ها" },
          { v: "statements", label: "صورت‌حساب‌ها" },
        ]}
        value={tab} onChange={setTab} />
      {tab === "documents" && <DocumentsTab flash={flash} />}
      {tab === "templates" && <TemplatesTab flash={flash} />}
      {tab === "statements" && <StatementsTab flash={flash} />}
    </div>
  );
}

/* ------------------------------- documents ------------------------------- */

function DocumentsTab({ flash }: { flash?: (message: string) => void }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [reference, setReference] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const params: Record<string, string> = { limit: "60" };
      if (status) params.status = status;
      if (kind) params.kind = kind;
      if (reference.trim()) params.reference = reference.trim();
      const response = await invoicesApi.list(params) as { items: Record<string, unknown>[] };
      setItems(response.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت اسناد"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status, kind]);

  const download = async (id: string) => {
    try {
      const url = await invoiceDocsApi.downloadPdf(id);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) { setError(e instanceof Error ? e.message : "دانلود فایل ناموفق بود"); }
  };

  if (error && !items) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <LoadingState label="در حال بارگذاری اسناد…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox placeholder="شماره سند (INV-…)" value={reference} onChange={setReference} />
        <Btn variant="soft" size="sm" onClick={load}>جست‌وجو</Btn>
        <Select options={["", ...Object.keys(STATUS_LABEL)]} labels={{ "": "همه وضعیت‌ها", ...STATUS_LABEL }} value={status} onChange={setStatus} />
        <Select options={["", ...Object.keys(KIND_LABEL)]} labels={{ "": "همه انواع سند", ...KIND_LABEL }} value={kind} onChange={setKind} />
        <span className="mr-auto text-[12px] text-[var(--kv-muted)]">{fmtNum(items.length)} سند</span>
        <Btn variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>بروزرسانی</Btn>
      </div>

      {items.length === 0
        ? <Empty title="سندی ثبت نشده است" desc="با ثبت پرداخت سفارش یا صدور سند دستی، فاکتور در همین فهرست ساخته می‌شود." />
        : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="kv-table min-w-[880px] text-xs">
                <thead>
                  <tr><th>شماره</th><th>نوع</th><th>وضعیت</th><th>مبلغ کل</th><th>پرداخت‌شده</th><th>مانده</th><th>تاریخ</th><th></th></tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="font-mono text-[11px]">{String(row.reference)}</td>
                      <td>{KIND_LABEL[String(row.kind)] ?? String(row.kind)}</td>
                      <td><Status value={STATUS_LABEL[String(row.status)] ?? String(row.status)} /></td>
                      <td className="tabular-nums">{fmtToman(row.total_rial ?? 0)}</td>
                      <td className="tabular-nums">{fmtToman(row.paid_rial ?? 0)}</td>
                      <td className="tabular-nums">{fmtToman(row.remaining_rial ?? 0)}</td>
                      <td className="tabular-nums">{formatPersianDate(String(row.issue_date ?? row.created_at))}</td>
                      <td className="flex gap-1">
                        <Btn variant="ghost" size="sm" onClick={() => setOpenId(String(row.id))}>مدیریت</Btn>
                        <Btn variant="ghost" size="sm" icon={<Download size={13} />} onClick={() => void download(String(row.id))}>PDF</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      {openId && (
        <DocumentDrawer invoiceId={openId} onClose={() => setOpenId(null)}
          onChanged={() => { void load(); flash?.("سند بروزرسانی شد"); }} />
      )}
    </div>
  );
}

/** Lifecycle actions of a single document: issue → void → refund (items 32/33). */
function DocumentDrawer({ invoiceId, onClose, onChanged }: {
  invoiceId: string; onClose: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [full, setFull] = useState(true);

  const load = async () => {
    setError(null);
    try { setDetail(await invoicesApi.get(invoiceId) as Record<string, unknown>); }
    catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت سند"); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [invoiceId]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await task(); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "عملیات ناموفق بود"); }
    finally { setBusy(false); }
  };

  if (!detail) return <Drawer open onClose={onClose} wide title="سند"><LoadingState /></Drawer>;
  const status = String(detail.status);
  const lines = (detail.lines ?? []) as Record<string, unknown>[];
  const events = (detail.events ?? []) as Record<string, unknown>[];

  return (
    <Drawer open onClose={onClose} wide title={`سند ${String(detail.reference)} — ${KIND_LABEL[String(detail.kind)] ?? ""}`}>
      <div className="space-y-4">
        {error && <p className="rounded-[10px] bg-[var(--kv-danger)]/8 px-3 py-2 text-[12.5px] text-[var(--kv-danger)]">{error}</p>}

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Status value={STATUS_LABEL[status] ?? status} />
            <span className="text-[12px] text-[var(--kv-muted)]">{formatPersianDateTime(String(detail.created_at))}</span>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4 text-[12.5px]">
            {[["جمع اقلام", detail.subtotal_rial], ["تخفیف", detail.discount_rial], ["مالیات", detail.tax_rial],
              ["ارسال", detail.shipping_rial], ["کارمزد خدمات", detail.services_fee_rial],
              ["مبلغ کل", detail.total_rial], ["پرداخت‌شده", detail.paid_rial], ["مانده", detail.remaining_rial]]
              .map(([label, value]) => (
                <div key={String(label)} className="rounded-[10px] bg-[var(--kv-surface-2)]/70 px-3 py-2">
                  <p className="text-[11px] text-[var(--kv-muted)]">{label as string}</p>
                  <p className="font-extrabold tabular-nums">{fmtToman(value ?? 0)}</p>
                </div>
              ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {status === "draft" && (
              <Btn variant="accent" size="sm" icon={<Send size={14} />} disabled={busy}
                onClick={() => void run(() => invoiceDocsApi.issue(invoiceId))}>صدور سند</Btn>
            )}
            {status !== "draft" && status !== "void" && status !== "cancelled" && (
              <Btn variant="soft" size="sm" icon={<Ban size={14} />} disabled={busy || reason.trim().length < 3}
                onClick={() => void run(() => invoiceDocsApi.void(invoiceId, reason.trim()))}>ابطال سند</Btn>
            )}
            {status !== "draft" && status !== "void" && status !== "cancelled" && status !== "refunded" && (
              <Btn variant="soft" size="sm" icon={<Undo2 size={14} />} disabled={busy || reason.trim().length < 3}
                onClick={() => void run(() => invoiceDocsApi.refund(invoiceId, { reason: reason.trim(), full }))}>بازپرداخت</Btn>
            )}
            <Btn variant="ghost" size="sm" icon={<Download size={14} />} disabled={busy}
              onClick={() => void invoiceDocsApi.downloadPdf(invoiceId).then((url) => {
                window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60_000);
              }).catch((e) => setError(e instanceof Error ? e.message : "دانلود ناموفق"))}>دانلود PDF</Btn>
            <span className="mr-auto" />
            <div className="w-[260px]"><Input value={reason} onChange={setReason} placeholder="دلیل ابطال/بازپرداخت (اجباری)" /></div>
            <Checkbox checked={full} onChange={setFull} label="بازپرداخت کامل" />
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 py-3"><p className="text-[13px] font-bold">اقلام</p></div>
          <div className="overflow-x-auto">
            <table className="kv-table min-w-[620px] text-xs">
              <thead><tr><th>#</th><th>شرح</th><th>کد</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr></thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={String(line.id)}>
                    <td className="tabular-nums">{fmtNum(Number(line.line_no))}</td>
                    <td>{String(line.product_name)}</td>
                    <td className="font-mono text-[11px]">{String(line.sku ?? "—")}</td>
                    <td className="tabular-nums">{fmtNum(Number(line.quantity))}</td>
                    <td className="tabular-nums">{fmtToman(line.unit_price_rial)}</td>
                    <td className="tabular-nums">{fmtToman(line.line_total_rial)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-4">
          <SectionHead title="تاریخچه سند" desc="هر رویداد با کاربر و زمان در سرور ثبت می‌شود" />
          <ol className="mt-3 space-y-2">
            {events.map((event) => (
              <li key={String(event.id)} className="rounded-[10px] bg-[var(--kv-surface-2)]/60 px-3 py-2 text-[12.5px]">
                <span className="font-bold">{String(event.event_type)}
                  {String(event.event_type) === "issued" ? " (صدور)" : ""}</span>
                {" · "}{formatPersianDateTime(String(event.created_at))}
                {event.actor_name ? ` · ${String(event.actor_name)}` : ""}
                {event.note ? <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">{String(event.note)}</p> : null}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </Drawer>
  );
}

/* ------------------------------- templates ------------------------------- */

function TemplatesTab({ flash }: { flash?: (message: string) => void }) {
  const [templates, setTemplates] = useState<InvoiceTemplateSummary[] | null>(null);
  const [variables, setVariables] = useState<{ group: string; label: string; items: { path: string; label: string }[] }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; code: string; title: string; kind: string;
    definition: Record<string, unknown>; changeNote: string } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [list, vars] = await Promise.all([invoiceDocsApi.templates(), invoiceDocsApi.variables()]);
      setTemplates(list.items);
      setVariables(vars.groups);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در دریافت قالب‌ها"); }
  };
  useEffect(() => { void load(); }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await task(); await load(); flash?.("قالب بروزرسانی شد"); }
    catch (e) { setError(e instanceof Error ? e.message : "عملیات ناموفق بود"); }
    finally { setBusy(false); }
  };

  const openPreview = async () => {
    if (!editor) return;
    setBusy(true); setError(null);
    try {
      const targetId = editor.id ?? templates?.[0]?.id;
      if (!targetId) throw new Error("برای پیش‌نمایش ابتدا قالب را ذخیره کنید.");
      const next = await invoiceDocsApi.preview(targetId, { definition: editor.definition });
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(next);
    } catch (e) { setError(e instanceof Error ? e.message : "پیش‌نمایش ناموفق بود"); }
    finally { setBusy(false); }
  };

  if (error && !templates) return <ErrorState message={error} onRetry={load} />;
  if (!templates) return <LoadingState label="در حال بارگذاری قالب‌ها…" />;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-[10px] bg-[var(--kv-danger)]/8 px-3 py-2 text-[12.5px] text-[var(--kv-danger)]">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-bold">قالب‌های سند ({fmtNum(templates.length)})</p>
        <span className="mr-auto" />
        <Btn variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>بروزرسانی</Btn>
        <Btn variant="accent" size="sm" icon={<Plus size={14} />}
          onClick={() => setEditor({ id: null, code: "", title: "", kind: "retail_sale", definition: blankDefinition(), changeNote: "" })}>
          قالب جدید
        </Btn>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {templates.map((template) => (
          <Card key={template.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[14px] font-extrabold">{template.title}</p>
                <p className="text-[11.5px] text-[var(--kv-muted)]">
                  <span className="font-mono">{template.code}</span> · {KIND_LABEL[template.kind] ?? template.kind} · نسخه {fmtNum(template.current_version)}
                </p>
              </div>
              {template.active ? <Status value="فعال" /> : <Status value="غیرفعال" />}
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">
              {fmtNum(template.usage_count)} سند با این قالب صادر شده است.
              {template.change_note ? ` آخرین تغییر: ${template.change_note}` : ""}
            </p>
            <div className="mt-3 grid grid-cols-4 gap-1 text-[10.5px]">
              {((template.definition?.sections ?? []) as TemplateSection[]).map((section) => (
                <span key={section.id} className="rounded-[8px] bg-[var(--kv-surface-2)]/70 px-2 py-1 text-center">
                  {section.title ?? section.type}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Btn variant="ghost" size="sm" icon={<Eye size={13} />} disabled={busy}
                onClick={() => void (async () => {
                  setBusy(true);
                  try {
                    const url = await invoiceDocsApi.preview(template.id, {});
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    setPreviewUrl(url);
                  } catch (e) { setError(e instanceof Error ? e.message : "پیش‌نمایش ناموفق بود"); }
                  finally { setBusy(false); }
                })()}>پیش‌نمایش</Btn>
              <Btn variant="soft" size="sm" icon={<Layers size={13} />}
                onClick={() => setEditor({ id: template.id, code: template.code, title: template.title, kind: template.kind,
                  definition: (template.definition ?? blankDefinition()) as Record<string, unknown>, changeNote: "" })}>
                ویرایش نسخه
              </Btn>
              <Btn variant={template.active ? "ghost" : "accent"} size="sm" disabled={busy}
                onClick={() => void run(() => invoiceDocsApi.activate(template.id, !template.active))}>
                {template.active ? "غیرفعال‌سازی" : "فعال‌سازی"}
              </Btn>
            </div>
          </Card>
        ))}
      </div>

      {editor && (
        <TemplateEditor
          editor={editor} setEditor={setEditor} variables={variables} busy={busy}
          onPreview={openPreview}
          onSave={() => void run(async () => {
            if (editor.id) {
              await invoiceDocsApi.addVersion(editor.id, { definition: editor.definition,
                changeNote: editor.changeNote || undefined });
            } else {
              await invoiceDocsApi.createTemplate({ code: editor.code, title: editor.title, kind: editor.kind,
                definition: editor.definition, changeNote: editor.changeNote || undefined });
            }
            setEditor(null);
          })}
          onClose={() => setEditor(null)} />
      )}

      {previewUrl && (
        <Modal open onClose={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null); }} max="max-w-[900px]" title="پیش‌نمایش قالب">
          <iframe title="قالب سند" src={previewUrl} className="h-[70vh] w-full rounded-[12px] border border-[var(--kv-line)]" />
        </Modal>
      )}
    </div>
  );
}

function TemplateEditor({ editor, setEditor, variables, busy, onPreview, onSave, onClose }: {
  editor: { id: string | null; code: string; title: string; kind: string; definition: Record<string, unknown>; changeNote: string };
  setEditor: (value: typeof editor | null) => void;
  variables: { group: string; label: string; items: { path: string; label: string }[] }[];
  busy: boolean; onPreview: () => void; onSave: () => void; onClose: () => void;
}) {
  const sections = (editor.definition.sections ?? []) as TemplateSection[];
  const setSections = (next: TemplateSection[]) => setEditor({ ...editor, definition: { ...editor.definition, sections: next } });
  const patch = (index: number, value: Partial<TemplateSection>) =>
    setSections(sections.map((section, current) => (current === index ? { ...section, ...value } : section)));

  return (
    <Modal open onClose={onClose} max="max-w-[1000px]" title={editor.id ? `ویرایش قالب ${editor.code}` : "قالب جدید"}>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="کد قالب" hint="حروف کوچک، عدد، - و _">
            <Input value={editor.code} onChange={(value) => setEditor({ ...editor, code: value })} placeholder="official-invoice" />
          </Field>
          <Field label="عنوان">
            <Input value={editor.title} onChange={(value) => setEditor({ ...editor, title: value })} placeholder="فاکتور رسمی فروش" />
          </Field>
          <Field label="نوع سند">
            <Select options={Object.keys(KIND_LABEL)} labels={KIND_LABEL} value={editor.kind} onChange={(value) => setEditor({ ...editor, kind: value })} />
          </Field>
        </div>

        <Field label="یادداشت نسخه" hint="در تاریخچه نسخه‌ها ثبت می‌شود">
          <Input value={editor.changeNote} onChange={(value) => setEditor({ ...editor, changeNote: value })} placeholder="مثلاً افزودن امضای خریدار" />
        </Field>

        <Card className="p-3">
          <SectionHead title="بخش‌های سند" desc="ترتیب، عنوان و نمایش هر بخش را تعیین کنید" action={
            <Btn variant="soft" size="sm" icon={<Plus size={13} />}
              onClick={() => setSections([...sections, { id: `s${sections.length + 1}`, type: "paragraph", title: "بخش جدید", order: sections.length + 1, visible: true, text: "" }])}>
              افزودن بخش
            </Btn>
          } />
          <div className="mt-3 space-y-2">
            {sections.map((section, index) => (
              <div key={section.id} className="grid gap-2 rounded-[10px] border border-[var(--kv-line)] p-2 md:grid-cols-[1fr_1fr_90px_90px_auto]">
                <Input value={section.id} onChange={(value) => patch(index, { id: value })} placeholder="شناسه" />
                <Input value={section.title ?? ""} onChange={(value) => patch(index, { title: value })} placeholder="عنوان" />
                <Select options={[...SECTION_TYPES]} labels={SECTION_TYPE_LABEL} value={section.type} onChange={(value) => patch(index, { type: value })} />
                <Input value={String(section.order ?? index + 1)}
                  onChange={(value) => patch(index, { order: Number(value) || index + 1 })} placeholder="ترتیب" />
                <div className="flex items-center gap-2">
                  <SwitchMini checked={section.visible !== false} onChange={(value) => patch(index, { visible: value })} />
                  <Btn variant="ghost" size="sm" onClick={() => setSections(sections.filter((_, current) => current !== index))}>حذف</Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-3 md:grid-cols-2">
          <Card className="p-3">
            <p className="text-[12.5px] font-bold">متغیرهای قابل استفاده</p>
            <div className="mt-2 max-h-[220px] space-y-2 overflow-y-auto text-[11.5px]">
              {variables.map((group) => (
                <div key={group.group}>
                  <p className="font-bold text-[var(--kv-muted)]">{group.label}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {group.items.map((item) => (
                      <span key={item.path} className="rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 font-mono text-[10.5px]" title={item.label}>
                        {`{{${item.path}}}`}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-3">
            <p className="text-[12.5px] font-bold">متن پاورقی</p>
            <Textarea value={String(editor.definition.footer ?? "")} rows={3}
              onChange={(value) => setEditor({ ...editor, definition: { ...editor.definition, footer: value } })} />
            <p className="mt-2 text-[11px] text-[var(--kv-muted)]">
              قالب‌ها نسخه‌بندی می‌شوند؛ سندهای صادرشده همیشه با نسخه زمان صدور بازسازی می‌شوند.
            </p>
          </Card>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Btn variant="ghost" size="sm" icon={<Eye size={14} />} disabled={busy} onClick={onPreview}>پیش‌نمایش PDF</Btn>
          <Btn variant="accent" size="sm" icon={<FileSignature size={14} />} disabled={busy || !editor.title.trim() || !editor.code.trim()} onClick={onSave}>
            {editor.id ? "ثبت نسخه جدید" : "ایجاد قالب"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function SwitchMini({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`kv-press h-6 w-11 shrink-0 rounded-full border transition ${checked ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/20" : "border-[var(--kv-line)] bg-[var(--kv-surface-2)]"}`}
      aria-pressed={checked}>
      <span className={`block h-4 w-4 rounded-full bg-[var(--kv-surface)] shadow transition ${checked ? "translate-x-[-24px]" : "translate-x-[-4px]"} translate-x-0 mr-1 ${checked ? "ml-auto" : ""}`} />
    </button>
  );
}

/* ------------------------------ statements ------------------------------ */

function StatementsTab({ flash }: { flash?: (message: string) => void }) {
  const supplierOptions = useSupplierOptions();
  const [supplierId, setSupplierId] = useState("");
  // Picker values are ISO instants (Jalali shown); the API receives date-only strings.
  const [from, setFrom] = useState(() => addDaysIso(todayIso(), -30));
  const [to, setTo] = useState(() => todayIso());
  const [issued, setIssued] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const issue = async () => {
    setBusy(true); setError(null);
    try {
      const statement = await invoiceDocsApi.supplierStatement({ supplierId, from: isoDateOnly(from), to: isoDateOnly(to) });
      setIssued((current) => [statement as unknown as Record<string, unknown>, ...current]);
      flash?.("صورت‌حساب صادر شد");
    } catch (e) { setError(e instanceof Error ? e.message : "صدور صورت‌حساب ناموفق بود"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {error && <p className="rounded-[10px] bg-[var(--kv-danger)]/8 px-3 py-2 text-[12.5px] text-[var(--kv-danger)]">{error}</p>}
      <Card className="p-4">
        <SectionHead title="صدور صورت‌حساب تأمین‌کننده" desc="از گردش واقعی دفتر معین تأمین‌کننده، با فایل PDF و اسنپ‌شات" />
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="تأمین‌کننده">
            <Select options={["", ...supplierOptions.map((option) => option.v)]}
              labels={{ "": "انتخاب تأمین‌کننده…", ...Object.fromEntries(supplierOptions.map((option) => [option.v, option.label])) }}
              value={supplierId} onChange={setSupplierId} />
          </Field>
          <div><PersianDatePicker label="از تاریخ" value={from} onChange={(iso) => iso && setFrom(iso)} /></div>
          <div><PersianDatePicker label="تا تاریخ" value={to} onChange={(iso) => iso && setTo(iso)} /></div>
          <div className="flex items-end">
            <Btn variant="accent" size="sm" icon={<FileText size={14} />} disabled={busy || !supplierId || !from || !to} onClick={() => void issue()}>
              صدور صورت‌حساب
            </Btn>
          </div>
        </div>
        {supplierOptions.length > 0 && (
          <p className="mt-2 text-[11px] text-[var(--kv-muted)]">
            شناسه انتخاب‌شده: <span className="font-mono">{supplierId || "—"}</span>
          </p>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="px-4 py-3"><p className="text-[13px] font-bold">صورت‌حساب‌های صادرشده در این نشست</p></div>
        <div className="overflow-x-auto">
          <table className="kv-table min-w-[520px] text-xs">
            <thead><tr><th>مرجع</th><th>مانده خالص</th><th>فایل</th></tr></thead>
            <tbody>
              {issued.length === 0 && <tr><td colSpan={3} className="text-center text-[var(--kv-muted)]">هنوز صورت‌حسابی صادر نشده است.</td></tr>}
              {issued.map((row) => (
                <tr key={String(row.id)}>
                  <td className="font-mono text-[11px]">{String(row.reference)}</td>
                  <td className="tabular-nums">{fmtToman(row.netRial ?? 0)}</td>
                  <td>
                    <a className="text-[var(--kv-accent)] underline" target="_blank" rel="noopener"
                      href={invoiceDocsApi.pdfUrl(String(row.id))}>دانلود PDF</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4">
        <SectionHead title="قاعده کار" desc="صورت‌حساب تسویه نیز هنگام پرداخت تسویه به‌صورت خودکار صادر می‌شود" />
      </Card>
    </div>
  );
}

/* re-export for other modules that show document kinds */
export { KIND_LABEL as DOCUMENT_KIND_LABEL, STATUS_LABEL as DOCUMENT_STATUS_LABEL };

/** Small helper for pages that only need the list of kinds. */
export const documentKinds = Object.keys(KIND_LABEL);

export function useDocumentKindOptions() {
  return useMemo(() => Object.entries(KIND_LABEL).map(([v, label]) => ({ v, label })), []);
}
