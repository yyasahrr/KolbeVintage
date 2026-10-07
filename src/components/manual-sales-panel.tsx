import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { Btn, Card, Empty, Field, Input, LoadingState, Select, Status } from "./primitives";
import { inventoryApi, manualSalesApi, productsApi, type ManualSaleChannel, type ManualSaleCreate } from "../data/api";
import { normalizeWarehouses, type Warehouse } from "../data/contracts";

type F = (message: string) => void;

/** Requirement 14/16: the real off-site channels a sale can happen on. */
export const CHANNEL_LABEL: Record<ManualSaleChannel, string> = {
  website: "وب‌سایت", instagram: "اینستاگرام", in_person: "حضوری", phone: "تلفنی",
  whatsapp: "واتس‌اپ", telegram: "تلگرام", other: "سایر",
};
const PAYMENT_LABEL: Record<string, string> = {
  card_to_card: "کارت‌به‌کارت", cash: "نقدی", pos: "کارتخوان (POS)", gateway: "درگاه", other: "سایر",
};
const STATUS_LABEL: Record<string, string> = {
  pending_verification: "در انتظار تأیید پرداخت", completed: "تکمیل‌شده", cancelled: "لغو شده",
};
const VERIFY_LABEL: Record<string, string> = {
  pending_verification: "در انتظار تأیید", verified: "تأییدشده", rejected: "رد شده",
};

const fmtRial = (value: unknown) => `${(Number(value ?? 0) / 10).toLocaleString("fa-IR")} تومان`;

type VariantOption = { variantId: string; label: string; priceToman: string };
type DraftLine = { variantId: string; quantity: string; priceToman: string };

/**
 * Manual sales workspace (Requirements 13-16): records real off-site sales
 * (Sale → Payment → Inventory → Audit) through the manual-sales API — never
 * through inventory adjustments.
 */
export function ManualSalesPanel({ flash }: { flash: F }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState<{ channel: string; sales: number; totalRial: string }[]>([]);
  const [filterChannel, setFilterChannel] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 20;
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [variants, setVariants] = useState<VariantOption[]>([]);
  const [draft, setDraft] = useState({
    channel: "instagram" as ManualSaleChannel, warehouseId: "", customerName: "", customerPhone: "", note: "",
    method: "card_to_card" as ManualSaleCreate["payment"]["method"], reference: "", paymentNote: "",
  });
  const [lines, setLines] = useState<DraftLine[]>([{ variantId: "", quantity: "1", priceToman: "" }]);

  const load = async (nextOffset = offset) => {
    try {
      const res = await manualSalesApi.list({
        ...(filterChannel ? { channel: filterChannel } : {}), ...(filterStatus ? { status: filterStatus } : {}),
        ...(search.trim() ? { search: search.trim() } : {}), limit, offset: nextOffset,
      });
      setItems(res.items ?? []); setTotal(res.total ?? 0); setChannels(res.channels ?? []);
    } catch (e) { setItems([]); flash(e instanceof Error ? e.message : "خطا در دریافت فروش‌های دستی"); }
  };
  useEffect(() => { void load(0); setOffset(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterChannel, filterStatus]);
  useEffect(() => {
    inventoryApi.warehouses().then((r) => {
      const list = normalizeWarehouses(r);
      setWarehouses(list);
      setDraft((cur) => ({ ...cur, warehouseId: cur.warehouseId || list[0]?.id || "" }));
    }).catch(() => setWarehouses([]));
    productsApi.list({ channel: "all", limit: "100" }).then((r) => {
      const opts: VariantOption[] = [];
      for (const p of (r.items ?? []) as unknown as { name: string; cashPriceRial?: string; variants?: { id: string; sku: string; color: string | null; size: string | null }[] }[]) {
        for (const v of p.variants ?? []) {
          opts.push({ variantId: v.id, label: `${p.name} · ${v.color ?? "—"} / ${v.size ?? "—"} · ${v.sku}`,
            priceToman: p.cashPriceRial ? String(Math.round(Number(p.cashPriceRial) / 10)) : "" });
        }
      }
      setVariants(opts);
    }).catch(() => setVariants([]));
  }, []);

  const totalToman = useMemo(() => lines.reduce((sum, line) => sum + (Number(line.priceToman) || 0) * (Number(line.quantity) || 0), 0), [lines]);

  const submit = async () => {
    const validLines = lines.filter((line) => line.variantId && Number(line.quantity) > 0 && Number(line.priceToman) > 0);
    if (!draft.warehouseId) { flash("انبار را انتخاب کنید."); return; }
    if (!validLines.length) { flash("دست‌کم یک ردیف کالا با قیمت و تعداد معتبر لازم است."); return; }
    if (draft.method === "card_to_card" && !draft.reference.trim()) { flash("برای کارت‌به‌کارت کد پیگیری لازم است."); return; }
    setBusy(true);
    try {
      const payload: ManualSaleCreate = {
        channel: draft.channel, warehouseId: draft.warehouseId,
        customerName: draft.customerName.trim() || undefined, customerPhone: draft.customerPhone.trim() || undefined,
        note: draft.note.trim() || undefined,
        lines: validLines.map((line) => ({ variantId: line.variantId, quantity: Number(line.quantity), unitPriceRial: String(Number(line.priceToman) * 10) })),
        payment: { method: draft.method, amountRial: String(totalToman * 10),
          reference: draft.reference.trim() || undefined, note: draft.paymentNote.trim() || undefined },
      };
      const res = await manualSalesApi.create(payload, `msale-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      flash(res.status === "pending_verification"
        ? `فروش ${res.reference} ثبت شد — در انتظار تأیید کارت‌به‌کارت`
        : `فروش ${res.reference} ثبت و تکمیل شد`);
      setCreating(false);
      setLines([{ variantId: "", quantity: "1", priceToman: "" }]);
      setDraft((cur) => ({ ...cur, customerName: "", customerPhone: "", note: "", reference: "", paymentNote: "" }));
      await load(0); setOffset(0);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت فروش دستی"); }
    finally { setBusy(false); }
  };

  const verify = async (sale: Record<string, unknown>, action: "verify" | "reject") => {
    const payments = (sale.payments ?? []) as { id: string; verificationStatus: string }[];
    const pending = payments.find((p) => p.verificationStatus === "pending_verification");
    if (!pending) { flash("پرداخت در انتظاری برای این فروش نیست."); return; }
    try {
      await manualSalesApi.verifyPayment(String(sale.id), pending.id, action);
      flash(action === "verify" ? "پرداخت تأیید و فروش تکمیل شد" : "پرداخت رد شد؛ فروش لغو و موجودی برگشت");
      await load();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بررسی پرداخت"); }
  };

  return (
    <div className="animate-[fadeUp_0.35s_ease] space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-[200px] flex-1">
          <Input value={search} onChange={setSearch} placeholder="جست‌وجوی مرجع، مشتری، SKU…" />
        </div>
        <Select className="w-44" options={["همه کانال‌ها", ...Object.values(CHANNEL_LABEL)]}
          value={filterChannel ? CHANNEL_LABEL[filterChannel as ManualSaleChannel] : "همه کانال‌ها"}
          onChange={(label) => setFilterChannel((Object.entries(CHANNEL_LABEL).find(([, l]) => l === label)?.[0]) ?? "")} />
        <Select className="w-52" options={["همه وضعیت‌ها", ...Object.values(STATUS_LABEL)]}
          value={filterStatus ? STATUS_LABEL[filterStatus] : "همه وضعیت‌ها"}
          onChange={(label) => setFilterStatus((Object.entries(STATUS_LABEL).find(([, l]) => l === label)?.[0]) ?? "")} />
        <Btn variant="soft" size="sm" onClick={() => { setOffset(0); void load(0); }}>جست‌وجو</Btn>
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => setCreating((v) => !v)}>ثبت فروش دستی</Btn>
      </div>

      {channels.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {channels.map((c) => (
            <span key={c.channel} className="rounded-full border border-[var(--kv-line)] px-3 py-1.5 text-[11.5px] font-semibold text-[var(--kv-muted)]">
              {CHANNEL_LABEL[c.channel as ManualSaleChannel] ?? c.channel}: {c.sales.toLocaleString("fa-IR")} فروش · {fmtRial(c.totalRial)}
            </span>
          ))}
        </div>
      )}

      {creating && (
        <Card className="space-y-4 p-4 md:p-6">
          <p className="text-[14px] font-extrabold">فروش دستی جدید</p>
          <p className="text-[12px] leading-6 text-[var(--kv-muted)]">
            فروش دستی یک رویداد تجاری واقعی است (فروش ← پرداخت ← کسر موجودی ← حسابرسی) و جایگزین «اصلاح موجودی» نیست.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="کانال فروش">
              <Select options={Object.values(CHANNEL_LABEL)} value={CHANNEL_LABEL[draft.channel]}
                onChange={(label) => { const hit = Object.entries(CHANNEL_LABEL).find(([, l]) => l === label); if (hit) setDraft({ ...draft, channel: hit[0] as ManualSaleChannel }); }} />
            </Field>
            <Field label="انبار">
              <Select options={warehouses.map((w) => `${w.code} — ${w.name}`)}
                value={(() => { const w = warehouses.find((x) => x.id === draft.warehouseId); return w ? `${w.code} — ${w.name}` : ""; })()}
                onChange={(label) => setDraft({ ...draft, warehouseId: warehouses.find((w) => `${w.code} — ${w.name}` === label)?.id ?? "" })} />
            </Field>
            <Field label="نام مشتری (اختیاری)"><Input value={draft.customerName} onChange={(v) => setDraft({ ...draft, customerName: v })} /></Field>
            <Field label="تلفن مشتری (اختیاری)"><Input value={draft.customerPhone} onChange={(v) => setDraft({ ...draft, customerPhone: v })} /></Field>
            <div className="sm:col-span-2"><Field label="یادداشت"><Input value={draft.note} onChange={(v) => setDraft({ ...draft, note: v })} /></Field></div>
          </div>
          <div className="space-y-2">
            <p className="text-[13px] font-bold">اقلام فروش</p>
            {lines.map((line, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="min-w-[260px] flex-1">
                  <Field label="واریانت (محصول · رنگ/سایز · SKU)">
                    <Select options={["انتخاب کنید", ...variants.map((v) => v.label)]}
                      value={variants.find((v) => v.variantId === line.variantId)?.label ?? "انتخاب کنید"}
                      onChange={(label) => {
                        const hit = variants.find((v) => v.label === label);
                        setLines((cur) => cur.map((l, i) => i === index ? { ...l, variantId: hit?.variantId ?? "", priceToman: l.priceToman || hit?.priceToman || "" } : l));
                      }} />
                  </Field>
                </div>
                <div className="w-24"><Field label="تعداد"><Input value={line.quantity} onChange={(v) => setLines((cur) => cur.map((l, i) => i === index ? { ...l, quantity: v.replace(/\D/g, "") } : l))} /></Field></div>
                <div className="w-40"><Field label="قیمت واحد (تومان)"><Input value={line.priceToman} onChange={(v) => setLines((cur) => cur.map((l, i) => i === index ? { ...l, priceToman: v.replace(/\D/g, "") } : l))} /></Field></div>
                <Btn variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => setLines((cur) => cur.filter((_, i) => i !== index))}>حذف</Btn>
              </div>
            ))}
            <Btn variant="soft" size="sm" icon={<Plus size={14} />} onClick={() => setLines((cur) => [...cur, { variantId: "", quantity: "1", priceToman: "" }])}>ردیف جدید</Btn>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="روش پرداخت">
              <Select options={Object.values(PAYMENT_LABEL)} value={PAYMENT_LABEL[draft.method]}
                onChange={(label) => { const hit = Object.entries(PAYMENT_LABEL).find(([, l]) => l === label); if (hit) setDraft({ ...draft, method: hit[0] as ManualSaleCreate["payment"]["method"] }); }} />
            </Field>
            {draft.method === "card_to_card" && (
              <Field label="کد پیگیری / شماره مرجع" hint="تا تأیید دستی، فروش «در انتظار تأیید» می‌ماند">
                <Input value={draft.reference} onChange={(v) => setDraft({ ...draft, reference: v })} />
              </Field>
            )}
            <Field label="یادداشت پرداخت (اختیاری)"><Input value={draft.paymentNote} onChange={(v) => setDraft({ ...draft, paymentNote: v })} /></Field>
          </div>
          <div className="flex items-center justify-between border-t border-[var(--kv-line)] pt-3">
            <p className="text-[13px] font-bold">جمع فروش: {totalToman.toLocaleString("fa-IR")} تومان</p>
            <div className="flex gap-2">
              <Btn variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setCreating(false)}>انصراف</Btn>
              <Btn variant="accent" size="sm" disabled={busy} icon={<Check size={14} />} onClick={submit}>{busy ? "در حال ثبت…" : "ثبت فروش"}</Btn>
            </div>
          </div>
        </Card>
      )}

      {items === null ? <LoadingState label="در حال دریافت فروش‌های دستی…" /> : items.length === 0 ? (
        <Empty title="فروش دستی ثبت نشده" desc="فروش‌های خارج از سایت (اینستاگرام، حضوری، تلفنی…) را از دکمه «ثبت فروش دستی» ثبت کنید تا موجودی و حسابرسی واقعی بمانند." />
      ) : (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[880px]">
              <thead><tr><th>مرجع</th><th>کانال</th><th>مشتری</th><th>اقلام</th><th>مبلغ</th><th>پرداخت</th><th>وضعیت</th><th>اقدام</th></tr></thead>
              <tbody>
                {items.map((sale) => {
                  const payments = (sale.payments ?? []) as { method: string; verificationStatus: string; reference: string | null }[];
                  const payment = payments[0];
                  return (
                    <tr key={String(sale.id)}>
                      <td className="font-mono text-[12px]" dir="ltr">{String(sale.reference)}</td>
                      <td>{CHANNEL_LABEL[sale.channel as ManualSaleChannel] ?? String(sale.channel)}</td>
                      <td>{String(sale.customer_name ?? "—")}<span className="block text-[11px] text-[var(--kv-muted)]" dir="ltr">{String(sale.customer_phone ?? "")}</span></td>
                      <td className="tabular-nums">{Number(sale.line_count ?? 0).toLocaleString("fa-IR")}</td>
                      <td className="tabular-nums font-bold">{fmtRial(sale.total_rial)}</td>
                      <td className="text-[12px]">{payment ? `${PAYMENT_LABEL[payment.method] ?? payment.method} · ${VERIFY_LABEL[payment.verificationStatus] ?? payment.verificationStatus}` : "—"}</td>
                      <td><Status value={STATUS_LABEL[String(sale.status)] ?? String(sale.status)} /></td>
                      <td>
                        {String(sale.status) === "pending_verification" ? (
                          <span className="flex gap-1.5">
                            <Btn variant="soft" size="sm" icon={<Check size={13} />} onClick={() => verify(sale, "verify")}>تأیید</Btn>
                            <Btn variant="ghost" size="sm" icon={<X size={13} />} onClick={() => verify(sale, "reject")}>رد</Btn>
                          </span>
                        ) : <span className="text-[11.5px] text-[var(--kv-muted)]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 text-[12px] text-[var(--kv-muted)]">
            <span>{total.toLocaleString("fa-IR")} فروش · صفحه {(Math.floor(offset / limit) + 1).toLocaleString("fa-IR")}</span>
            <span className="flex gap-2">
              <Btn variant="soft" size="sm" disabled={offset === 0} onClick={() => { const next = Math.max(0, offset - limit); setOffset(next); void load(next); }}>قبلی</Btn>
              <Btn variant="soft" size="sm" disabled={offset + limit >= total} onClick={() => { const next = offset + limit; setOffset(next); void load(next); }}>بعدی</Btn>
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
