/** §14-§20, §44: «کالاها» — the single home of product definition & lifecycle.
 *
 *  Sub-views (IA §14): تعریف محصول | نیازمند راه‌اندازی | بازبینی تأمین‌کنندگان | همه کالاها | آرشیو
 *
 *  Rules enforced here (UI side of backend guarantees):
 *  - product definition has NO stock operation (§15) — stock starts ONLY in the
 *    «راه‌اندازی موجودی» workspace, which creates audited opening receipts (§19);
 *  - «—» = inventory profile not configured (pending) ≠ «۰» = configured, zero (§16);
 *  - the owner column shows کلبه/تأمین‌کننده explicitly — there is NO owner picker (§4);
 *  - status columns stay in their own domains (§45): catalog status ≠ sale ≠ setup.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgePercent, PackagePlus, PartyPopper, RefreshCw } from "lucide-react";
import { Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, SearchBox, Segmented, WorkspaceModal } from "./primitives";
import { MarketplaceReviewPanel } from "./marketplace-review-panel";
import { DiscountManager } from "./discount-manager";
import { promoApi, promotionRulesApi } from "../data/api";
import { ProductStudio } from "../portals/admin-product";
import {
  catalogOpsApi, inventoryApi, productsApi, seriesTemplatesApi, sizeGuidesApi, specsApi,
  type AdminProductRow, type NeedsSetupRow,
} from "../data/api";
import { cn } from "../utils/cn";
import { siteApi } from "../data/experience-api";

type F = (message: string) => void;
const fa = (value: number | string) => String(value).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);
const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const SETUP_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: "نیازمند راه‌اندازی", cls: "bg-amber-100 text-amber-800" },
  configured: { label: "راه‌اندازی‌شده", cls: "bg-emerald-100 text-emerald-800" },
};
const CATALOG_BADGE: Record<string, { label: string; cls: string }> = {
  published: { label: "منتشرشده", cls: "bg-emerald-100 text-emerald-800" },
  draft: { label: "پیش‌نویس", cls: "bg-gray-100 text-gray-600" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  archived: { label: "آرشیو", cls: "bg-gray-200 text-gray-600" },
};
const SELECT_CLS = "h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";
const NUM_CLS = "h-10 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";

const Pill = ({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) => {
  const meta = map[value] ?? { label: value, cls: "bg-gray-100 text-gray-600" };
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>;
};

export function CatalogHub({ flash }: { flash: F }) {
  const [sub, setSub] = useState<"define" | "needs-setup" | "review" | "all" | "archive">("define");
  return (
    <div className="space-y-4">
      <Segmented
        options={[
          { v: "define", label: "تعریف محصول" },
          { v: "needs-setup", label: "نیازمند راه‌اندازی" },
          { v: "review", label: "بازبینی تأمین‌کنندگان" },
          { v: "all", label: "همه کالاها" },
          { v: "archive", label: "آرشیو" },
        ]}
        value={sub} onChange={setSub}
      />
      {sub === "define" && (
        <div className="space-y-3">
          <Card className="p-3">
            <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              تعریف محصول فقط اطلاعات کاتالوگ را ذخیره می‌کند و هیچ عملیات موجودی ندارد؛ پس از ذخیره، محصول به
              «نیازمند راه‌اندازی» می‌رود و موجودی اولیه فقط از همان‌جا و با سند انبار ثبت می‌شود. مالکیت محصولات
              ادمین همیشه «کلبه» است (سمت سرور تضمین می‌شود).
            </p>
          </Card>
          <ProductStudio flash={flash} onGoToSetup={() => setSub("needs-setup")} />
        </div>
      )}
      {sub === "needs-setup" && <NeedsSetupPanel flash={flash} />}
      {sub === "review" && <MarketplaceReviewPanel flash={flash} />}
      {sub === "all" && <AllProductsPanel mode="active" flash={flash} />}
      {sub === "archive" && <AllProductsPanel mode="archived" flash={flash} />}
    </div>
  );
}

/* ------------------------------ §16: needs-setup list ------------------------------ */

function NeedsSetupPanel({ flash }: { flash: F }) {
  const [rows, setRows] = useState<NeedsSetupRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupFor, setSetupFor] = useState<NeedsSetupRow | null>(null);
  const load = useCallback(() => {
    setError(null);
    catalogOpsApi.needsSetup({ limit: 100 }).then((r) => setRows(r.items)).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!rows) return <LoadingState label="در حال دریافت فهرست..." />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">محصولات نیازمند راه‌اندازی موجودی</h3>
          <p className="text-[11.5px] text-[var(--kv-muted)]">
            این محصولات تعریف شده‌اند اما پروفایل موجودی‌شان پیکربندی نشده است — در جدول‌ها «—» نمایش داده می‌شوند، نه «۰».
          </p>
        </div>
        <Btn size="sm" variant="ghost" onClick={load}><RefreshCw size={14} /></Btn>
      </div>
      {!rows.length && <Empty title="همه محصولات راه‌اندازی شده‌اند" desc="محصول جدید پس از تعریف، این‌جا در انتظار پیکربندی موجودی می‌نشیند." />}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            <thead><tr><th>محصول</th><th>دسته‌بندی</th><th>واریانت‌ها</th><th>وضعیت کاتالوگ</th><th>موجودی</th><th>اقدام</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="font-bold">{p.name}</td>
                  <td>{p.category}</td>
                  <td>{fa(p.variant_count)}</td>
                  <td><Pill map={CATALOG_BADGE} value={p.status} /></td>
                  <td className="font-bold text-[var(--kv-muted)]">—</td>
                  <td><Btn size="sm" variant="accent" onClick={() => setSetupFor(p)}><PackagePlus size={13} /> راه‌اندازی موجودی</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {setupFor && <InventorySetupWorkspace product={setupFor} flash={flash} onClose={() => setSetupFor(null)} onDone={() => { setSetupFor(null); load(); }} />}
    </Card>
  );
}

/* ------------------------------ §17-§20: setup workspace (WorkspaceModal, §60) ------------------------------ */

type VariantLite = { id: string; sku: string; color: string | null; size: string | null; active: boolean };
type TemplateLite = { id: string; name: string; color_label: string | null; pairs_per_series?: number; active?: boolean };

function InventorySetupWorkspace({ product, flash, onClose, onDone }: {
  product: NeedsSetupRow; flash: F; onClose: () => void; onDone: () => void;
}) {
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; purpose?: string }[]>([]);
  const [variants, setVariants] = useState<VariantLite[] | null>(null);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [busy, setBusy] = useState(false);
  // channel selection (§17: retail / wholesale / both)
  const [retailOn, setRetailOn] = useState(product.retail_enabled);
  const [wholesaleOn, setWholesaleOn] = useState(product.wholesale_enabled && !product.retail_enabled);
  // retail config (§19)
  const [retailWh, setRetailWh] = useState("");
  const [mode, setMode] = useState<"zero" | "equal" | "per_variant">("zero");
  const [equalQty, setEqualQty] = useState("0");
  const [perVariant, setPerVariant] = useState<Record<string, string>>({});
  // wholesale config (§20)
  const [wholesaleWh, setWholesaleWh] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [seriesCount, setSeriesCount] = useState("0");
  const [idemKey] = useState(() => newKey(`setup-${product.id.slice(0, 8)}`));

  useEffect(() => {
    inventoryApi.warehouses().then((r) => setWarehouses(r.items)).catch(() => setWarehouses([]));
    productsApi.adminDetail(product.id)
      .then((r) => setVariants((r.variants as VariantLite[]).filter((v) => v.active)))
      .catch(() => setVariants([]));
    seriesTemplatesApi.list(product.id)
      .then((r) => setTemplates((r.items as TemplateLite[]).filter((t) => t.active !== false)))
      .catch(() => setTemplates([]));
  }, [product.id]);

  const retailWarehouses = warehouses.filter((w) => w.purpose !== "wholesale");
  const wholesaleWarehouses = warehouses.filter((w) => w.purpose === "wholesale");
  const activeVariants = variants ?? [];
  const selectedTemplate = templates.find((t) => t.id === templateId);

  // §19: honest preview BEFORE confirm — exactly what the server will write.
  const retailTotal = useMemo(() => {
    if (!retailOn) return 0;
    if (mode === "zero") return 0;
    if (mode === "equal") return activeVariants.length * Math.max(0, Number(equalQty) || 0);
    return activeVariants.reduce((sum, v) => sum + Math.max(0, Number(perVariant[v.id]) || 0), 0);
  }, [retailOn, mode, equalQty, perVariant, activeVariants]);
  const wholesalePieces = wholesaleOn && selectedTemplate
    ? Math.max(0, Number(seriesCount) || 0) * (selectedTemplate.pairs_per_series ?? 0) : 0;

  const submit = async () => {
    if (!retailOn && !wholesaleOn) { flash("دست‌کم یک کانال را انتخاب کنید."); return; }
    if (retailOn && !retailWh) { flash("انبار خرده‌فروشی را انتخاب کنید."); return; }
    if (wholesaleOn && (!wholesaleWh || !templateId)) { flash("انبار مرکزی عمده و قالب سری را انتخاب کنید."); return; }
    setBusy(true);
    try {
      await catalogOpsApi.inventorySetup(product.id, {
        ...(retailOn ? { retail: {
          warehouseId: retailWh, mode,
          ...(mode === "equal" ? { quantity: Math.max(0, Number(equalQty) || 0) } : {}),
          ...(mode === "per_variant" ? { perVariant: activeVariants.map((v) => ({ variantId: v.id, quantity: Math.max(0, Number(perVariant[v.id]) || 0) })) } : {}),
        } } : {}),
        ...(wholesaleOn ? { wholesale: { warehouseId: wholesaleWh, seriesTemplateId: templateId, seriesCount: Math.max(0, Number(seriesCount) || 0) } } : {}),
      }, idemKey);
      flash("موجودی اولیه با سند انبار ثبت شد و محصول راه‌اندازی شد.");
      onDone();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در راه‌اندازی"); } finally { setBusy(false); }
  };

  return (
    <WorkspaceModal open onClose={onClose} title={`راه‌اندازی موجودی — ${product.name}`}
      subtitle="موجودی اولیه فقط از این‌جا و از طریق سند رسید انبار (قابل‌حسابرسی) ثبت می‌شود؛ فرم تعریف محصول هیچ عملیات موجودی ندارد."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            پیش‌نمایش: خرده {fa(retailTotal)} عدد{wholesaleOn ? ` · عمده ${fa(Math.max(0, Number(seriesCount) || 0))} سری (${fa(wholesalePieces)} عدد)` : ""} — پس از تأیید، همین مقادیر با سند ثبت می‌شوند.
          </p>
          <div className="flex gap-2">
            <Btn variant="ghost" onClick={onClose}>انصراف</Btn>
            <Btn variant="accent" disabled={busy} onClick={submit}>{busy ? "در حال ثبت..." : "تأیید و ثبت سند افتتاحیه"}</Btn>
          </div>
        </div>
      }>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-4 p-4">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={retailOn} disabled={!product.retail_enabled} onChange={(e) => setRetailOn(e.target.checked)} /> موجودی خرده‌فروشی (واحد: عدد)
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
                { v: "zero", label: "شروع از صفر" },
                { v: "equal", label: "مقدار یکسان" },
                { v: "per_variant", label: "به تفکیک واریانت" },
              ]} value={mode} onChange={setMode} />
              {mode === "zero" && (
                <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                  همه واریانت‌ها با موجودی «۰» پیکربندی می‌شوند (۰ واقعی؛ دیگر «—» نمایش داده نمی‌شود).
                </p>
              )}
              {mode === "equal" && (
                <Field label={`تعداد برای هر ${fa(activeVariants.length)} واریانت`}>
                  <input dir="ltr" inputMode="numeric" className={cn(NUM_CLS, "w-full")} value={equalQty} onChange={(e) => setEqualQty(e.target.value)} aria-label="تعداد یکسان" />
                </Field>
              )}
              {mode === "per_variant" && (
                <div className="max-h-72 space-y-2 overflow-y-auto pe-1">
                  {!variants && <LoadingState label="دریافت واریانت‌ها..." />}
                  {activeVariants.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--kv-line)] px-3 py-2">
                      <span className="text-[11.5px]">{v.color ?? "—"} / {v.size ?? "—"} <span className="text-[var(--kv-muted)]" dir="ltr">({v.sku})</span></span>
                      <input dir="ltr" inputMode="numeric" className={cn(NUM_CLS, "w-24")} value={perVariant[v.id] ?? "0"} aria-label={`تعداد ${v.sku}`}
                        onChange={(e) => setPerVariant((s) => ({ ...s, [v.id]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
        <Card className="space-y-4 p-4">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={wholesaleOn} disabled={!product.wholesale_enabled} onChange={(e) => setWholesaleOn(e.target.checked)} /> موجودی عمده‌فروشی (واحد: سری)
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
                <input dir="ltr" inputMode="numeric" className={cn(NUM_CLS, "w-full")} value={seriesCount} onChange={(e) => setSeriesCount(e.target.value)} aria-label="تعداد سری کامل" />
              </Field>
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                موجودی عمده فقط «سری کامل» است؛ موجودی فله در دامنه عمده پذیرفته نمی‌شود.
              </p>
            </div>
          )}
        </Card>
      </div>
    </WorkspaceModal>
  );
}

/* ------------------------------ §44: all products / archive ------------------------------ */

function AllProductsPanel({ mode, flash }: { mode: "active" | "archived"; flash?: F }) {
  const [rows, setRows] = useState<AdminProductRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState<"all" | "kolbe" | "supplier">("all");
  const [page, setPage] = useState(0);
  // §17.10: bulk festival assignment + per-row discount drill
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [festivalModal, setFestivalModal] = useState(false);
  const [bulkResult, setBulkResult] = useState<Awaited<ReturnType<typeof promotionRulesApi.festivalBulk>> | null>(null);
  const [discountFor, setDiscountFor] = useState<AdminProductRow | null>(null);
  const limit = 30;
  const load = useCallback(() => {
    setError(null);
    catalogOpsApi.adminProducts({ status: mode === "archived" ? "archived" : "active", owner, limit, offset: page * limit, ...(q.trim() ? { q: q.trim() } : {}) })
      .then((r) => { setRows(r.items); setTotal(r.total); })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, [mode, owner, page, q]);
  useEffect(load, [load]);
  if (error) return <ErrorState message={error} onRetry={load} />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{mode === "archived" ? "آرشیو کالاها" : "همه کالاها"} {total > 0 && <span className="text-[11px] font-normal text-[var(--kv-muted)]">({fa(total)})</span>}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented options={[{ v: "all", label: "همه مالکان" }, { v: "kolbe", label: "کلبه" }, { v: "supplier", label: "تأمین‌کننده" }]}
            value={owner} onChange={(v) => { setOwner(v); setPage(0); }} />
          <SearchBox value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="جستجوی نام/برند/دسته..." />
        </div>
      </div>
      {!rows && <LoadingState label="در حال دریافت کالاها..." />}
      {rows && !rows.length && <Empty title="کالایی یافت نشد" desc="فیلترها یا عبارت جستجو را تغییر دهید." />}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            {/* §44 columns: product | owner | catalog status | retail | wholesale | marketplace | setup — NO vague «فعال» badge. */}
            <thead><tr>
              {mode === "active" && <th className="w-8">
                <input type="checkbox" className="accent-[var(--kv-accent)]" aria-label="انتخاب همه"
                  checked={rows.length > 0 && rows.every((p) => selected.has(p.id))}
                  onChange={(e) => setSelected((prev) => { const next = new Set(prev); for (const p of rows) { if (e.target.checked) next.add(p.id); else next.delete(p.id); } return next; })} />
              </th>}
              <th>محصول</th><th>مالک</th><th>وضعیت کاتالوگ</th><th>موجودی خرده</th><th>موجودی عمده (سری)</th><th>پیشنهاد فعال بازارچه</th><th>راه‌اندازی موجودی</th>{mode === "active" && <th>اقدام</th>}
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const pending = p.inventory_setup === "pending";
                return (
                  <tr key={p.id}>
                    {mode === "active" && <td>
                      <input type="checkbox" className="accent-[var(--kv-accent)]" aria-label={`انتخاب ${p.name}`}
                        checked={selected.has(p.id)}
                        onChange={(e) => setSelected((prev) => { const next = new Set(prev); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} />
                    </td>}
                    <td><div className="font-bold">{p.name}</div><div className="text-[10.5px] text-[var(--kv-muted)]">{p.brand ?? "—"} · {p.category} · {fa(p.variant_count)} واریانت</div></td>
                    <td>{p.owner_type === "kolbe" ? "کلبه" : <span>تأمین‌کننده{p.supplier_name ? ` — ${p.supplier_name}` : ""}</span>}</td>
                    <td><Pill map={CATALOG_BADGE} value={p.status} /></td>
                    {/* §16: «—» = پیکربندی‌نشده؛ عدد (حتی ۰) = پیکربندی‌شده. */}
                    <td className="font-bold">{p.owner_type !== "kolbe" ? "—" : pending ? <span title="پروفایل موجودی پیکربندی نشده" className="text-[var(--kv-muted)]">—</span> : fa(p.retail_available)}</td>
                    <td className="font-bold">{p.owner_type !== "kolbe" ? "—" : pending ? <span className="text-[var(--kv-muted)]">—</span> : fa(p.wholesale_series_available)}</td>
                    <td>{p.active_offers > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-bold text-emerald-800">{fa(p.active_offers)} پیشنهاد</span> : "—"}</td>
                    <td>{p.owner_type === "kolbe" ? <Pill map={SETUP_BADGE} value={p.inventory_setup} /> : "—"}</td>
                    {mode === "active" && <td>
                      <Btn size="sm" variant="ghost" onClick={() => setDiscountFor(p)}><BadgePercent size={13} /> تخفیف و جشنواره</Btn>
                    </td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > limit && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Btn size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>قبلی</Btn>
          <span className="text-[11.5px] text-[var(--kv-muted)]">صفحه {fa(page + 1)} از {fa(Math.ceil(total / limit))}</span>
          <Btn size="sm" variant="ghost" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>بعدی</Btn>
        </div>
      )}
      {mode === "active" && selected.size > 0 && (
        <div className="sticky bottom-2 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 shadow-[var(--shadow-soft-lg)]">
          <span className="text-[12px] font-bold">{fa(selected.size)} کالا انتخاب شده</span>
          <Btn size="sm" variant="accent" onClick={() => setFestivalModal(true)}><PartyPopper size={13} /> افزودن به جشنواره</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setSelected(new Set())}>لغو انتخاب</Btn>
        </div>
      )}
      {festivalModal && (
        <BulkFestivalModal
          productIds={[...selected]}
          onClose={() => setFestivalModal(false)}
          onDone={(result) => { setFestivalModal(false); setBulkResult(result); setSelected(new Set()); load(); }}
        />
      )}
      {bulkResult && (
        <Modal open onClose={() => setBulkResult(null)} title={`نتیجه افزودن به «${bulkResult.promotionName}»`} max="max-w-[560px]">
          <div className="space-y-3 text-[12.5px]">
            <div className="flex flex-wrap gap-2">
              {bulkResult.summary.added > 0 && <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-bold text-emerald-800">{fa(bulkResult.summary.added)} اضافه شد</span>}
              {bulkResult.summary.moved > 0 && <span className="rounded-full bg-sky-100 px-2.5 py-1 font-bold text-sky-800">{fa(bulkResult.summary.moved)} منتقل شد</span>}
              {bulkResult.summary.alreadyInFestival > 0 && <span className="rounded-full bg-gray-100 px-2.5 py-1 font-bold text-gray-600">{fa(bulkResult.summary.alreadyInFestival)} از قبل عضو</span>}
              {bulkResult.summary.needsConfirmation > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-bold text-amber-800">{fa(bulkResult.summary.needsConfirmation)} نیازمند تأیید انتقال</span>}
              {bulkResult.summary.errors > 0 && <span className="rounded-full bg-red-100 px-2.5 py-1 font-bold text-red-700">{fa(bulkResult.summary.errors)} خطا</span>}
            </div>
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {bulkResult.results.map((r) => (
                <li key={r.productId} className="flex items-start justify-between gap-2 rounded-[8px] bg-[var(--kv-surface-2)] px-2.5 py-1.5">
                  <span className="font-semibold">{r.productName ?? r.productId.slice(0, 8)}</span>
                  <span className={cn("text-[11.5px]", r.status === "error" ? "text-red-600" : r.status === "needs_confirmation" ? "text-amber-700" : "text-[var(--kv-muted)]")}>{r.message}</span>
                </li>
              ))}
            </ul>
            {bulkResult.summary.needsConfirmation > 0 && (
              <p className="rounded-[10px] bg-amber-50 px-3 py-2 text-[11.5px] leading-6 text-amber-800">
                کالاهای نیازمند تأیید، در جشنواره دیگری فعال‌اند. برای انتقال، دوباره انتخاب‌شان کنید و در پنجره جشنواره گزینه «انتقال از جشنواره قبلی» را فعال کنید.
              </p>
            )}
          </div>
        </Modal>
      )}
      {discountFor && (
        <DiscountManager
          productId={discountFor.id}
          productName={discountFor.name}
          onClose={() => { setDiscountFor(null); load(); }}
          flash={flash ?? (() => undefined)}
        />
      )}
    </Card>
  );
}

/** §17.10: festival chooser for the bulk action — pick festival + discount, explicit move confirmation. */
function BulkFestivalModal({ productIds, onClose, onDone }: {
  productIds: string[];
  onClose: () => void;
  onDone: (result: Awaited<ReturnType<typeof promotionRulesApi.festivalBulk>>) => void;
}) {
  const [festivals, setFestivals] = useState<{ id: string; name: string; active: boolean; kind?: string }[] | null>(null);
  const [pick, setPick] = useState("");
  const [dType, setDType] = useState<"percent" | "fixed_rial">("percent");
  const [dValue, setDValue] = useState("");
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    promoApi.festivals()
      .then((r) => {
        const list = ((r.items ?? []) as { id: string; name: string; active: boolean; kind?: string }[]).filter((f) => f.active !== false);
        setFestivals(list);
        if (list.length === 1) setPick(list[0]!.id);
      })
      .catch(() => setFestivals([]));
  }, []);
  const submit = async () => {
    if (!pick) { setError("یک جشنواره انتخاب کنید."); return; }
    const value = Number(dValue);
    if (!dValue.trim() || !Number.isFinite(value) || value <= 0) { setError("مقدار تخفیف معتبر نیست."); return; }
    if (dType === "percent" && (value < 1 || value > 95)) { setError("درصد تخفیف باید بین ۱ تا ۹۵ باشد."); return; }
    setBusy(true); setError(null);
    try {
      const result = await promotionRulesApi.festivalBulk({
        promotionId: pick, productIds, discountType: dType,
        discountValue: dType === "percent" ? Math.round(value) : String(Math.round(value)),
        moveFromFestival: move,
      });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در افزودن به جشنواره");
    } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`افزودن ${fa(productIds.length)} کالا به جشنواره`} max="max-w-[480px]">
      <div className="space-y-3">
        {!festivals && <LoadingState label="در حال دریافت جشنواره‌ها..." />}
        {festivals && !festivals.length && <Empty title="جشنواره فعالی وجود ندارد" desc="ابتدا از «تخفیف و جشنواره‌ها» یک جشنواره بسازید." />}
        {festivals && festivals.length > 0 && (
          <>
            <Field label="جشنواره">
              <select className={SELECT_CLS} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">انتخاب کنید…</option>
                {festivals.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </Field>
            <div className="flex flex-wrap items-end gap-2.5">
              <Field label="نوع تخفیف">
                <Segmented options={[{ v: "percent", label: "درصدی" }, { v: "fixed_rial", label: "مبلغ ثابت" }]} value={dType} onChange={setDType} />
              </Field>
              <Field label={dType === "percent" ? "درصد (۱ تا ۹۵)" : "مبلغ (ریال)"}>
                <Input value={dValue} onChange={setDValue} placeholder={dType === "percent" ? "مثلاً 20" : "مثلاً 500000"} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[12px] font-semibold">
              <input type="checkbox" className="accent-[var(--kv-accent)]" checked={move} onChange={(e) => setMove(e.target.checked)} />
              انتقال از جشنواره قبلی (در صورت عضویت فعلی)
            </label>
            <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
              با ورود به جشنواره، تخفیف‌های مستقل این کالاها «معلق» می‌شوند (حذف نمی‌شوند) و پس از پایان جشنواره فقط با «فعال‌سازی مجدد» برمی‌گردند.
            </p>
            {error && <p className="rounded-[10px] bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <Btn size="sm" variant="ghost" onClick={onClose} disabled={busy}>انصراف</Btn>
              <Btn size="sm" variant="accent" onClick={() => void submit()} disabled={busy}>{busy ? "در حال اعمال…" : "تأیید و اعمال"}</Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------ §8-§10: category profiles (configuration) ------------------------------ */

/** Category = source of truth: spec template + size guide + allowed sizes per category.
 *  Rendered inside the hub's SETTINGS tab (configuration-only area). */
export function CategoryProfilesPanel({ flash }: { flash: F }) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [profiles, setProfiles] = useState<Record<string, unknown>[] | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [guides, setGuides] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ category: string; specTemplateId: string; sizeGuideId: string; sizes: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      catalogOpsApi.categoryProfiles(),
      specsApi.templates().catch(() => ({ items: [] as unknown[] })),
      sizeGuidesApi.adminList().catch(() => ({ items: [] as unknown[] })),
      siteApi.categories(),
    ]).then(([p, t, g, c]) => {
      setCategories(c.items);
      setProfiles(p.items);
      setTemplates((t.items as { id: string; name: string }[]).filter((x) => x?.id));
      setGuides((g.items as { id: string; name: string }[]).filter((x) => x?.id));
    }).catch((e) => setError(e instanceof Error ? e.message : "خطا"));
  }, []);
  useEffect(load, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profiles) return <LoadingState label="در حال دریافت پروفایل دسته‌بندی‌ها..." />;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold">پروفایل دسته‌بندی‌ها (اتصال دسته به ساختار محصول)</h3>
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
            دسته‌بندی تعیین می‌کند چه مشخصاتی الزامی است، چه سایزهایی مجازند و کدام راهنمای سایز نمایش داده می‌شود.
            خودِ قالب‌های مشخصات و راهنمای سایز در بخش «ساختار محصولات و سری‌ها» (منوی محصول و انبار) تعریف می‌شوند؛ این‌جا فقط به دسته متصل می‌شوند.
          </p>
        </div>
        <Btn size="sm" variant="accent" onClick={() => setEditing({ category: "", specTemplateId: "", sizeGuideId: "", sizes: "" })}>پروفایل جدید</Btn>
      </div>
      {!profiles.length && <Empty title="پروفایلی تعریف نشده" desc="برای هر دسته‌بندی، قالب مشخصات و سایزهای مجاز را تعریف کنید." />}
      {profiles.length > 0 && (
        <div className="overflow-x-auto">
          <table className="kv-table w-full text-xs">
            <thead><tr><th>دسته‌بندی</th><th>قالب مشخصات</th><th>راهنمای سایز</th><th>سایزهای مجاز</th><th>محصولات</th><th>اقدام</th></tr></thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={String(p.id)}>
                  <td className="font-bold">{String(p.category)}</td>
                  <td>{String(p.spec_template_name ?? "—")}</td>
                  <td>{String(p.size_guide_name ?? "—")}</td>
                  <td dir="ltr">{Array.isArray(p.allowed_sizes) && p.allowed_sizes.length ? (p.allowed_sizes as string[]).join("، ") : "آزاد"}</td>
                  <td>{fa(Number(p.product_count ?? 0))}</td>
                  <td><Btn size="sm" variant="soft" onClick={() => setEditing({
                    category: String(p.category),
                    specTemplateId: String(p.spec_template_id ?? ""),
                    sizeGuideId: String(p.size_guide_id ?? ""),
                    sizes: Array.isArray(p.allowed_sizes) ? (p.allowed_sizes as string[]).join(",") : "",
                  })}>ویرایش</Btn></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} title="پروفایل دسته‌بندی">
          <h3 className="mb-3 text-sm font-bold">پروفایل دسته‌بندی</h3>
          <div className="space-y-3">
            <Field label="دسته‌بندی" hint="دسته جدید را در استودیو محصول بسازید؛ این بخش پیش‌فرض‌های همان دسته را تنظیم می‌کند.">
              <select className={SELECT_CLS} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} aria-label="دسته‌بندی">
                <option value="">انتخاب دسته‌بندی…</option>
                {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="قالب مشخصات فنی">
              <select className={SELECT_CLS} value={editing.specTemplateId} onChange={(e) => setEditing({ ...editing, specTemplateId: e.target.value })} aria-label="قالب مشخصات">
                <option value="">بدون قالب</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="راهنمای سایز">
              <select className={SELECT_CLS} value={editing.sizeGuideId} onChange={(e) => setEditing({ ...editing, sizeGuideId: e.target.value })} aria-label="راهنمای سایز">
                <option value="">بدون راهنما</option>
                {guides.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
            <Field label="سایزهای مجاز (با ویرگول جدا کنید؛ خالی = آزاد)" hint="مثال: S,M,L,XL">
              <input dir="ltr" className={cn(NUM_CLS, "w-full")} value={editing.sizes} onChange={(e) => setEditing({ ...editing, sizes: e.target.value })} aria-label="سایزهای مجاز" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setEditing(null)}>انصراف</Btn>
            <Btn variant="accent" disabled={busy || !editing.category.trim()} onClick={async () => {
              setBusy(true);
              try {
                await catalogOpsApi.saveCategoryProfile(editing.category.trim(), {
                  specTemplateId: editing.specTemplateId || null,
                  sizeGuideId: editing.sizeGuideId || null,
                  allowedSizes: editing.sizes.split(",").map((x) => x.trim()).filter(Boolean),
                });
                flash("پروفایل دسته‌بندی ذخیره شد.");
                setEditing(null); load();
              } catch (e) { flash(e instanceof Error ? e.message : "خطا"); } finally { setBusy(false); }
            }}>{busy ? "..." : "ذخیره"}</Btn>
          </div>
        </Modal>
      )}
    </Card>
  );
}
