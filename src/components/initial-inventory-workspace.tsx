/** §11-§17, §20, §27: canonical «ورود اولیه کالا» (initial inventory) workspace.
 *
 *  This is the SAME canonical WMS opening-receipt surface that was verified in the
 *  preceding delivery — it is NOT a second initial-inventory implementation.
 *
 *  Contracts enforced here:
 *  - the Product Studio never writes stock; this workspace is the ONLY bridge from
 *    product definition to physical stock (§15);
 *  - Retail entry is a real Color × Size matrix at VARIANT level (§15);
 *  - Wholesale entry is Series-based and stays in the wholesale domain only —
 *    it never creates retail stock (§16);
 *  - Retail and Wholesale are two independent domains (§17);
 *  - confirmation executes an audited canonical WMS receipt — never a direct
 *    balance PATCH (§15);
 *  - the product is preselected and never searched for again (§12).
 */
import { useEffect, useMemo, useState } from "react";
import { PackagePlus } from "lucide-react";
import {
  Btn, Card, Empty, Field, LoadingState, Segmented, WorkspaceModal,
} from "./primitives";
import { inventoryApi, catalogOpsApi, productsApi, seriesTemplatesApi } from "../data/api";
import { cn } from "../utils/cn";

type F = (message: string) => void;
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const SELECT_CLS = "h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const NUM_CLS = "h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const CELL_CLS = "h-10 w-16 rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 text-center text-sm font-bold tabular-nums outline-none focus:border-[var(--kv-accent)]";

/** The minimum the workspace needs to know about the preselected product (§12). */
export type InitialInventoryProduct = {
  id: string;
  name: string;
  retail_enabled: boolean;
  wholesale_enabled: boolean;
  owner_type?: string;
  sku?: string | null;
  category?: string | null;
};

type VariantLite = { id: string; sku: string; color: string | null; size: string | null; active: boolean };
type TemplateLite = {
  id: string; name: string; color_label: string | null; pairs_per_series?: number; active?: boolean;
  moq_series?: number; price_per_series_rial?: string | number | null;
  items?: { size_label: string | null; quantity_per_series: number }[];
};

export function InitialInventoryWorkspace({ product, flash, onClose, onDone }: {
  product: InitialInventoryProduct; flash: F; onClose: () => void; onDone: () => void;
}) {
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; purpose?: string }[]>([]);
  const [variants, setVariants] = useState<VariantLite[] | null>(null);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [busy, setBusy] = useState(false);
  // channel selection (§17: retail / wholesale / both)
  const [retailOn, setRetailOn] = useState(product.retail_enabled);
  const [wholesaleOn, setWholesaleOn] = useState(product.wholesale_enabled && !product.retail_enabled);
  // retail config (§15/§19)
  const [retailWh, setRetailWh] = useState("");
  const [mode, setMode] = useState<"zero" | "equal" | "per_variant">("per_variant");
  const [equalQty, setEqualQty] = useState("0");
  const [perVariant, setPerVariant] = useState<Record<string, string>>({});
  // wholesale config (§16/§20)
  const [wholesaleWh, setWholesaleWh] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [seriesCount, setSeriesCount] = useState("0");
  // §39: one idempotency key per opened workspace — a double click replays, never duplicates.
  const [idemKey] = useState(() => newKey(`setup-${product.id.slice(0, 8)}`));

  useEffect(() => {
    inventoryApi.warehouses().then((r) => setWarehouses(r.items)).catch(() => setWarehouses([]));
    productsApi.adminDetail(product.id)
      .then((r) => setVariants((r.variants as VariantLite[]).filter((v) => v.active)))
      .catch(() => setVariants([]));
    seriesTemplatesApi.list(product.id)
      .then(async (r) => {
        const active = (r.items as TemplateLite[]).filter((t) => t.active !== false);
        // §16: the physical composition of each series must be visible before confirming.
        const detailed = await Promise.all(active.map((t) =>
          seriesTemplatesApi.detail(String(t.id)).catch(() => null)));
        setTemplates(active.map((t, index) => {
          const detail = detailed[index] as unknown as {
            items?: { size_label: string | null; quantity_per_series: number }[];
            pairsPerSeries?: number; moqSeries?: number; pricePerSeriesRial?: string | number | null;
          } | null;
          return {
            ...t,
            items: detail?.items ?? t.items ?? [],
            pairs_per_series: detail?.pairsPerSeries ?? t.pairs_per_series ?? 0,
            moq_series: detail?.moqSeries ?? t.moq_series,
            price_per_series_rial: detail?.pricePerSeriesRial ?? t.price_per_series_rial ?? null,
          };
        }));
      })
      .catch(() => setTemplates([]));
  }, [product.id]);

  const retailWarehouses = warehouses.filter((w) => w.purpose !== "wholesale");
  const wholesaleWarehouses = warehouses.filter((w) => w.purpose === "wholesale");
  const activeVariants = variants ?? [];
  const selectedTemplate = templates.find((t) => t.id === templateId);

  /* §15: the Retail entry is a VARIANT-level Color × Size matrix — exactly the
     «انبار مرکزی / S M L × مشکی,کرم» grid the Product Owner described. */
  const grid = useMemo(() => {
    const colors: string[] = [];
    const sizes: string[] = [];
    const cell = new Map<string, VariantLite>();
    const loose: VariantLite[] = [];
    for (const variant of activeVariants) {
      if (variant.color && variant.size) {
        if (!colors.includes(variant.color)) colors.push(variant.color);
        if (!sizes.includes(variant.size)) sizes.push(variant.size);
        cell.set(`${variant.color}::${variant.size}`, variant);
      } else loose.push(variant);
    }
    return { colors, sizes, cell, loose };
  }, [activeVariants]);

  const quantityOf = (variantId: string) => Math.max(0, Number(perVariant[variantId]) || 0);

  // §15/§19: honest preview BEFORE confirm — exactly what the server will write.
  const retailTotal = useMemo(() => {
    if (!retailOn) return 0;
    if (mode === "zero") return 0;
    if (mode === "equal") return activeVariants.length * Math.max(0, Number(equalQty) || 0);
    return activeVariants.reduce((sum, v) => sum + quantityOf(v.id), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retailOn, mode, equalQty, perVariant, activeVariants]);

  const seriesCountValue = Math.max(0, Number(seriesCount) || 0);
  const piecesPerSeries = selectedTemplate?.pairs_per_series ?? 0;
  const wholesalePieces = wholesaleOn && selectedTemplate ? seriesCountValue * piecesPerSeries : 0;

  const submit = async () => {
    if (!retailOn && !wholesaleOn) { flash("دست‌کم یک کانال را انتخاب کنید."); return; }
    if (retailOn && !retailWh) { flash("انبار خرده‌فروشی را انتخاب کنید."); return; }
    if (wholesaleOn && (!wholesaleWh || !templateId)) { flash("انبار مرکزی عمده و قالب سری را انتخاب کنید."); return; }
    if (retailOn && !activeVariants.length) { flash("این محصول واریانت فعالی ندارد؛ ابتدا رنگ و سایز را در استودیو محصول تعریف کنید."); return; }
    setBusy(true);
    try {
      await catalogOpsApi.inventorySetup(product.id, {
        ...(retailOn ? {
          retail: {
            warehouseId: retailWh, mode,
            ...(mode === "equal" ? { quantity: Math.max(0, Number(equalQty) || 0) } : {}),
            ...(mode === "per_variant" ? { perVariant: activeVariants.map((v) => ({ variantId: v.id, quantity: quantityOf(v.id) })) } : {}),
          },
        } : {}),
        ...(wholesaleOn ? { wholesale: { warehouseId: wholesaleWh, seriesTemplateId: templateId, seriesCount: seriesCountValue } } : {}),
      }, idemKey);
      flash("موجودی اولیه با سند انبار ثبت شد و تکمیل محصول ادامه یافت.");
      onDone();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ثبت موجودی اولیه"); } finally { setBusy(false); }
  };

  const salesMode = product.retail_enabled && product.wholesale_enabled ? "خرده + عمده"
    : product.retail_enabled ? "خرده" : product.wholesale_enabled ? "عمده" : "تعیین‌نشده";

  return (
    <WorkspaceModal open onClose={onClose} title={`ورود اولیه کالا — ${product.name}`}
      subtitle="موجودی اولیه فقط از این‌جا و از طریق سند رسید انبار (قابل‌حسابرسی) ثبت می‌شود؛ تعریف محصول هیچ عملیات موجودی ندارد."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            پیش‌نمایش: خرده {fa(retailTotal)} عدد{wholesaleOn ? ` · عمده ${fa(seriesCountValue)} سری (${fa(wholesalePieces)} عدد)` : ""} — پس از تأیید، همین مقادیر با سند ثبت می‌شوند.
          </p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={() => void submit()}>{busy ? "در حال ثبت..." : "تأیید و ثبت سند افتتاحیه"}</Btn>
          </div>
        </div>
      }>
      {/* §12: the workspace knows the product — no search, no re-selection. */}
      <div className="grid gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/60 p-3 text-[11.5px] sm:grid-cols-2 lg:grid-cols-4">
        <div><span className="text-[var(--kv-muted)]">محصول</span><p className="font-bold">{product.name}</p></div>
        <div><span className="text-[var(--kv-muted)]">مالک</span><p className="font-bold">{product.owner_type === "supplier" ? "تأمین‌کننده" : "کلبه"}</p></div>
        <div><span className="text-[var(--kv-muted)]">روش فروش</span><p className="font-bold">{salesMode}</p></div>
        <div><span className="text-[var(--kv-muted)]">واریانت‌های فعال</span><p className="font-bold">{variants === null ? "…" : fa(activeVariants.length)}</p></div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-4 p-4">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={retailOn} disabled={!product.retail_enabled} onChange={(e) => setRetailOn(e.target.checked)} aria-label="موجودی خرده‌فروشی" /> موجودی خرده‌فروشی (دامنه: خرده · واحد: عدد)
          </label>
          {retailOn && (
            <div className="space-y-3">
              <Field label="انبار خرده‌فروشی">
                <select className={SELECT_CLS} value={retailWh} onChange={(e) => setRetailWh(e.target.value)} aria-label="انبار خرده‌فروشی">
                  <option value="">انتخاب انبار...</option>
                  {retailWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
              <Segmented options={[
                { v: "per_variant", label: "به تفکیک رنگ × سایز" },
                { v: "equal", label: "مقدار یکسان" },
                { v: "zero", label: "شروع از صفر" },
              ]} value={mode} onChange={setMode} />
              {mode === "zero" && (
                <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                  همه واریانت‌ها با موجودی «۰» پیکربندی می‌شوند (۰ واقعی؛ دیگر «—» نمایش داده نمی‌شود).
                </p>
              )}
              {mode === "equal" && (
                <Field label={`تعداد برای هر ${fa(activeVariants.length)} واریانت`}>
                  <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={equalQty} onChange={(e) => setEqualQty(e.target.value)} aria-label="تعداد یکسان" />
                </Field>
              )}
              {mode === "per_variant" && (
                <div className="space-y-2">
                  {!variants && <LoadingState label="دریافت واریانت‌ها..." />}
                  {variants && !activeVariants.length && (
                    <Empty title="واریانت فعالی ندارد" desc="برای ورود موجودی خرده، ابتدا رنگ و سایز محصول را در استودیو محصول تعریف کنید." />
                  )}
                  {/* §15/§27: the Color×Size matrix may scroll horizontally INSIDE the card —
                      the document itself must never overflow. */}
                  {!!grid.sizes.length && (
                    <div className="kv-scroll-x">
                      <table className="w-full min-w-max border-separate border-spacing-1 text-[11.5px]">
                        <thead>
                          <tr>
                            <th className="sticky right-0 z-10 bg-[var(--kv-surface)] p-1 text-right text-[var(--kv-muted)]">رنگ / سایز</th>
                            {grid.sizes.map((size) => <th key={size} className="p-1 text-center font-bold" dir="ltr">{size}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {grid.colors.map((color) => (
                            <tr key={color}>
                              <th className="sticky right-0 z-10 whitespace-nowrap bg-[var(--kv-surface)] p-1 text-right font-bold">{color}</th>
                              {grid.sizes.map((size) => {
                                const variant = grid.cell.get(`${color}::${size}`);
                                if (!variant) return <td key={size} className="p-1 text-center text-[var(--kv-faint)]">—</td>;
                                return (
                                  <td key={size} className="p-1 text-center">
                                    <input
                                      dir="ltr" inputMode="numeric" className={CELL_CLS}
                                      value={perVariant[variant.id] ?? "0"}
                                      aria-label={`تعداد ${color} سایز ${size}`}
                                      onChange={(e) => setPerVariant((s) => ({ ...s, [variant.id]: e.target.value }))}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!!grid.loose.length && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-[var(--kv-muted)]">واریانت‌های بدون رنگ یا سایز مشخص</p>
                      {grid.loose.map((v) => (
                        <div key={v.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--kv-line)] px-3 py-2">
                          <span className="text-[11.5px]">{v.color ?? "—"} / {v.size ?? "—"} <span className="text-[var(--kv-muted)]" dir="ltr">({v.sku})</span></span>
                          <input dir="ltr" inputMode="numeric" className={cn(NUM_CLS, "w-24")} value={perVariant[v.id] ?? "0"} aria-label={`تعداد ${v.sku}`}
                            onChange={(e) => setPerVariant((s) => ({ ...s, [v.id]: e.target.value }))} />
                        </div>
                      ))}
                    </div>
                  )}
                  {!!grid.sizes.length && (
                    <p className="text-[11px] leading-6 text-[var(--kv-muted)]">
                      مجموع ورود خرده: <b className="text-[var(--kv-ink)]">{fa(retailTotal)} عدد</b> — فقط دامنهٔ خرده تغییر می‌کند.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-4">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={wholesaleOn} disabled={!product.wholesale_enabled} onChange={(e) => setWholesaleOn(e.target.checked)} aria-label="موجودی عمده‌فروشی" /> موجودی عمده‌فروشی (دامنه: عمده · واحد: سری)
          </label>
          {wholesaleOn && (
            <div className="space-y-3">
              <Field label="انبار مرکزی عمده">
                <select className={SELECT_CLS} value={wholesaleWh} onChange={(e) => setWholesaleWh(e.target.value)} aria-label="انبار مرکزی عمده">
                  <option value="">انتخاب انبار...</option>
                  {wholesaleWarehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
              <Field label="قالب سری (رنگ مشخص)">
                <select className={SELECT_CLS} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="قالب سری">
                  <option value="">انتخاب قالب سری...</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.color_label ? ` — ${t.color_label}` : ""}</option>)}
                </select>
              </Field>
              {!templates.length && (
                <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[11.5px] leading-6 text-amber-800">
                  این محصول هنوز قالب سری ندارد؛ ابتدا از «قالب‌های سری» یک دستور ترکیب (رنگ + سایزبندی) تعریف کنید.
                </p>
              )}
              <Field label="تعداد سری کامل">
                <input dir="ltr" inputMode="numeric" className={NUM_CLS} value={seriesCount} onChange={(e) => setSeriesCount(e.target.value)} aria-label="تعداد سری کامل" />
              </Field>
              {selectedTemplate && (
                <div className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6">
                  <p className="font-bold">ترکیب هر سری</p>
                  <p className="mt-1 text-[var(--kv-muted)]">
                    {(selectedTemplate.items ?? []).map((item) => `${item.size_label ?? "بدون سایز"} × ${fa(item.quantity_per_series)}`).join(" · ") || "ترکیبی ثبت نشده است"}
                  </p>
                  <p className="mt-1">
                    ورود: <b>{fa(seriesCountValue)} سری</b> · ترکیب فیزیکی: <b>{fa(wholesalePieces)} عدد</b>
                  </p>
                </div>
              )}
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                موجودی عمده فقط «سری کامل» است و در دامنهٔ عمده می‌ماند؛ این عملیات هیچ موجودی خرده‌ای ایجاد نمی‌کند.
              </p>
            </div>
          )}
        </Card>
      </div>
      <p className="flex items-start gap-2 text-[11px] leading-6 text-[var(--kv-muted)]">
        <PackagePlus size={14} className="mt-1 shrink-0" />
        اگر بدون تأیید خارج شوید، محصول در وضعیت «پیش‌نویس» باقی می‌ماند و هیچ موجودی فیزیکی ثبت نمی‌شود؛ می‌توانید بعداً از «محصولات کلبه ← پیش‌نویس‌ها» با «ادامه تکمیل محصول» به همین صفحه برگردید.
      </p>
    </WorkspaceModal>
  );
}
