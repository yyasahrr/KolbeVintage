import { useCallback, useEffect, useState } from "react";
import { PackagePlus, Plus, Send, Trash2 } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, Select, Textarea } from "./primitives";
import { inventoryApi, supplierRequestsApi } from "../data/api";
import { formatPersianDateTimeFull } from "../data/persian-date";
import { cn } from "../utils/cn";

const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const STATUS_FA: Record<string, { label: string; cls: string }> = {
  submitted: { label: "در انتظار بررسی کلبه", cls: "bg-amber-100 text-amber-800" },
  approved: { label: "تأیید شد — آماده ارسال", cls: "bg-emerald-100 text-emerald-800" },
  rejected: { label: "رد شد", cls: "bg-red-100 text-red-700" },
  needs_revision: { label: "نیازمند اصلاح", cls: "bg-amber-100 text-amber-800" },
  dispatched: { label: "ارسال‌شده — در راه انبار کلبه", cls: "bg-amber-100 text-amber-800" },
  received: { label: "دریافت‌شده در انبار", cls: "bg-emerald-100 text-emerald-800" },
  closed: { label: "بسته‌شده", cls: "bg-gray-100 text-gray-600" },
  cancelled: { label: "لغوشده", cls: "bg-gray-100 text-gray-500" },
};

type ItemDraft = {
  itemType: "replenishment" | "new_product";
  variantSku: string;
  proposedName: string;
  proposedColor: string;
  proposedSize: string;
  quantity: string;
  note: string;
};
const blankItem = (): ItemDraft => ({ itemType: "replenishment", variantSku: "", proposedName: "", proposedColor: "", proposedSize: "", quantity: "", note: "" });

type MyVariant = { variant_id: string; sku: string; product_name: string };

/**
 * I: supplier-side supply requests — create (max 10 items), track status, read
 * rejection reasons, revise & resubmit, and dispatch after approval.
 */
export function SupplierRequestsPortal({ flash }: { flash: (msg: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [variants, setVariants] = useState<MyVariant[]>([]);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; owner_id: string | null }[]>([]);
  const [items, setItems] = useState<ItemDraft[]>([blankItem()]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviseFor, setReviseFor] = useState<Record<string, unknown> | null>(null);
  const [dispatchFor, setDispatchFor] = useState<Record<string, unknown> | null>(null);
  const [dispatchWh, setDispatchWh] = useState("");
  const [dispatchBatch, setDispatchBatch] = useState("");

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, inv, whs] = await Promise.all([
        supplierRequestsApi.list(),
        inventoryApi.balances({ limit: 100 }),
        inventoryApi.warehouses().catch(() => ({ items: [] as { id: string; code: string; name: string; owner_id: string | null }[] })),
      ]);
      setRows(list.items);
      const seen = new Map<string, MyVariant>();
      for (const r of inv.items as unknown as MyVariant[]) if (!seen.has(r.sku)) seen.set(r.sku, r);
      setVariants([...seen.values()]);
      setWarehouses(whs.items);
    } catch (e) { setError(e instanceof Error ? e.message : "خطا در بارگذاری درخواست‌ها"); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const buildPayloadItems = () => items.map((item) => {
    const quantity = Number(item.quantity);
    if (!quantity || quantity <= 0) throw new Error("تعداد همه اقلام باید بیشتر از صفر باشد.");
    if (item.itemType === "replenishment") {
      const variant = variants.find((v) => v.sku === item.variantSku);
      if (!variant) throw new Error("برای اقلام شارژ موجودی، کالا را انتخاب کنید.");
      return { itemType: "replenishment", variantId: variant.variant_id, quantity, ...(item.note ? { note: item.note } : {}) };
    }
    if (!item.proposedName.trim()) throw new Error("برای محصول جدید، نام پیشنهادی الزامی است.");
    return {
      itemType: "new_product", proposedName: item.proposedName.trim(), quantity,
      ...(item.proposedColor ? { proposedColor: item.proposedColor } : {}),
      ...(item.proposedSize ? { proposedSize: item.proposedSize } : {}),
      ...(item.note ? { note: item.note } : {}),
    };
  });

  const submit = async () => {
    setBusy(true);
    try {
      const payloadItems = buildPayloadItems();
      await supplierRequestsApi.create({ ...(note ? { note } : {}), items: payloadItems }, newKey("sr"));
      flash("درخواست تأمین ثبت شد و برای بررسی به کلبه رفت.");
      setItems([blankItem()]); setNote("");
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت درخواست"); }
    finally { setBusy(false); }
  };

  const resubmit = async () => {
    if (!reviseFor) return;
    setBusy(true);
    try {
      const payloadItems = buildPayloadItems();
      await supplierRequestsApi.revise(String(reviseFor.id), { ...(note ? { note } : {}), items: payloadItems });
      flash("نسخه اصلاح‌شده ارسال شد؛ تاریخچه نسخه‌ها محفوظ است.");
      setReviseFor(null); setItems([blankItem()]); setNote("");
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ارسال اصلاحیه"); }
    finally { setBusy(false); }
  };

  const dispatch = async () => {
    if (!dispatchFor) return;
    const wh = warehouses.find((w) => w.name === dispatchWh);
    if (!wh) { flash("انبار مقصد کلبه را انتخاب کنید."); return; }
    setBusy(true);
    try {
      await supplierRequestsApi.dispatch(String(dispatchFor.id), {
        warehouseId: wh.id, ...(dispatchBatch ? { batchReference: dispatchBatch } : {}),
      });
      flash("ارسال محموله ثبت شد؛ اقلام به‌صورت «در راه» در انبار کلبه دیده می‌شوند.");
      setDispatchFor(null); setDispatchBatch("");
      await reload();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت ارسال"); }
    finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={() => void reload()} />;
  if (rows === null) return <LoadingState />;

  const itemsForm = (
    <div className="space-y-2.5">
      {items.map((item, idx) => (
        <div key={idx} className="grid gap-2 rounded-[12px] border border-[var(--kv-border)] p-3 md:grid-cols-5">
          <Field label="نوع قلم">
            <Select options={["شارژ موجودی", "محصول جدید"]} value={item.itemType === "replenishment" ? "شارژ موجودی" : "محصول جدید"}
              onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, itemType: v === "شارژ موجودی" ? "replenishment" : "new_product" } : it))} />
          </Field>
          {item.itemType === "replenishment" ? (
            <Field label="کالا (SKU)">
              <Select options={variants.map((v) => v.sku)} value={item.variantSku}
                onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, variantSku: v } : it))} />
            </Field>
          ) : (<>
            <Field label="نام محصول جدید">
              <Input value={item.proposedName} onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, proposedName: v } : it))} />
            </Field>
            <Field label="رنگ / سایز">
              <div className="flex gap-1.5">
                <Input value={item.proposedColor} onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, proposedColor: v } : it))} placeholder="رنگ" />
                <Input value={item.proposedSize} onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, proposedSize: v } : it))} placeholder="سایز" />
              </div>
            </Field>
          </>)}
          <Field label="تعداد">
            <Input value={item.quantity} onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, quantity: v } : it))} placeholder="مثلاً 30" />
          </Field>
          <div className="flex items-end gap-1.5">
            <Field label="یادداشت">
              <Input value={item.note} onChange={(v) => setItems(items.map((it, i) => i === idx ? { ...it, note: v } : it))} />
            </Field>
            {items.length > 1 && (
              <button className="mb-2 text-red-400 hover:text-red-600" onClick={() => setItems(items.filter((_, i) => i !== idx))}><Trash2 size={15} /></button>
            )}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2.5">
        <Btn size="sm" variant="soft" icon={<Plus size={14} />} disabled={items.length >= 10}
          onClick={() => setItems([...items, blankItem()])}>
          افزودن قلم ({fa(items.length)}/۱۰)
        </Btn>
        {items.length >= 10 && <span className="text-[11.5px] text-amber-700">حداکثر ۱۰ قلم در هر درخواست مجاز است.</span>}
      </div>
      <Field label="یادداشت کلی (اختیاری)"><Textarea value={note} onChange={setNote} rows={2} /></Field>
    </div>
  );

  return (
    <div className="animate-[fadeUp_0.35s_ease] space-y-4">
      <Card className="p-4">
        <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-extrabold"><PackagePlus size={15} />ثبت درخواست تأمین جدید</h3>
        <p className="mb-3 text-[12px] leading-6 text-[var(--kv-muted)]">
          می‌توانید در یک درخواست چند محصول (حداکثر ۱۰ قلم) ثبت کنید — شارژ موجودی محصولات فعلی یا معرفی محصول جدید.
          پس از تأیید کلبه، کالا را ارسال می‌کنید و بعد از دریافت و کنترل کیفیت به موجودی عمده اضافه می‌شود.
        </p>
        {itemsForm}
        <div className="mt-3"><Btn size="sm" variant="accent" disabled={busy} icon={<Send size={14} />} onClick={() => void submit()}>ارسال درخواست</Btn></div>
      </Card>

      <Card className="overflow-hidden">
        <h3 className="border-b border-[var(--kv-border)] p-3 text-[14px] font-extrabold">درخواست‌های من</h3>
        {rows.length === 0 ? <Empty title="درخواستی ندارید" desc="اولین درخواست تأمین را از فرم بالا بسازید." /> : (
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[720px] text-[12.5px]">
              <thead><tr><th>شماره</th><th>اقلام</th><th>جمع تعداد</th><th>وضعیت</th><th>توضیح کلبه</th><th>تاریخ</th><th>عملیات</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const status = String(r.status);
                  const meta = STATUS_FA[status] ?? { label: status, cls: "bg-gray-100 text-gray-600" };
                  return (
                    <tr key={String(r.id)}>
                      <td className="font-bold" dir="ltr">{String(r.request_number)}</td>
                      <td className="tabular-nums">{fa(Number(r.item_count ?? 0))}</td>
                      <td className="tabular-nums">{fa(Number(r.total_quantity ?? 0))}</td>
                      <td><span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span></td>
                      <td className="max-w-[260px] text-[11.5px] leading-5">
                        {status === "rejected" && typeof r.rejection_reason === "string" && <span className="text-red-600">{r.rejection_reason}</span>}
                        {status === "needs_revision" && typeof r.revision_note === "string" && <span className="text-amber-700">{r.revision_note}</span>}
                        {!["rejected", "needs_revision"].includes(status) && "—"}
                      </td>
                      <td className="text-[11px] text-[var(--kv-muted)]">{formatPersianDateTimeFull(String(r.created_at))}</td>
                      <td className="whitespace-nowrap space-x-2 space-x-reverse">
                        {status === "needs_revision" && (
                          <button className="text-[11.5px] font-bold text-[var(--kv-accent)] hover:underline"
                            onClick={async () => {
                              try {
                                const detail = await supplierRequestsApi.detail(String(r.id));
                                setReviseFor(detail);
                                setNote(String(detail.note ?? ""));
                                setItems((detail.items as Record<string, unknown>[]).map((it) => ({
                                  itemType: (it.item_type as "replenishment" | "new_product") ?? "replenishment",
                                  variantSku: String(it.variant_sku ?? ""),
                                  proposedName: String(it.proposed_name ?? ""),
                                  proposedColor: String(it.proposed_color ?? ""),
                                  proposedSize: String(it.proposed_size ?? ""),
                                  quantity: String(it.quantity ?? ""),
                                  note: String(it.note ?? ""),
                                })));
                              } catch (e) { flash(e instanceof Error ? e.message : "خطا"); }
                            }}>اصلاح و ارسال مجدد</button>
                        )}
                        {status === "approved" && (
                          <button className="text-[11.5px] font-bold text-emerald-600 hover:underline"
                            onClick={() => { setDispatchFor(r); setDispatchWh(warehouses.find((w) => w.owner_id === null)?.name ?? ""); }}>
                            ثبت ارسال محموله
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {reviseFor && (
        <Modal open onClose={() => { setReviseFor(null); setItems([blankItem()]); setNote(""); }} title={`اصلاح درخواست ${String(reviseFor.request_number)}`} max="max-w-[760px]">
          <div className="space-y-3 p-4">
            {typeof reviseFor.revision_note === "string" && reviseFor.revision_note && (
              <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[12px] text-amber-800">توضیح کلبه: {reviseFor.revision_note}</p>
            )}
            {itemsForm}
            <Btn size="sm" variant="accent" disabled={busy} onClick={() => void resubmit()}>ارسال نسخه اصلاح‌شده</Btn>
          </div>
        </Modal>
      )}

      {dispatchFor && (
        <Modal open onClose={() => setDispatchFor(null)} title={`ارسال محموله ${String(dispatchFor.request_number)}`}>
          <div className="space-y-3 p-4">
            <p className="text-[12.5px] text-[var(--kv-muted)]">با ثبت ارسال، اقلام به‌صورت «در راه» در انبار کلبه ثبت می‌شوند و پس از دریافت فیزیکی و کنترل کیفیت به موجودی اضافه خواهند شد.</p>
            <Field label="انبار مقصد کلبه">
              <Select options={warehouses.filter((w) => w.owner_id === null).map((w) => w.name)} value={dispatchWh} onChange={setDispatchWh} />
            </Field>
            <Field label="شماره بسته / بارنامه (اختیاری)"><Input value={dispatchBatch} onChange={setDispatchBatch} placeholder="مثلاً CTN-45" /></Field>
            <div className="flex gap-2">
              <Btn size="sm" variant="accent" disabled={busy} onClick={() => void dispatch()}>ثبت ارسال</Btn>
              <Btn size="sm" variant="soft" onClick={() => setDispatchFor(null)}>انصراف</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
