/** §3-§5, §10, §12-§13, §19, §23-§25: «محصولات کلبه» — the canonical Product
 *  management surface for Products owned by KolbeVintage.
 *
 *  It is NOT a second Product database, NOT WMS and NOT the pricing engine:
 *  - catalog identity is written by the canonical Product Studio,
 *  - physical stock is written only by canonical WMS documents,
 *  - pricing/promotion records stay in the canonical Promotion Center.
 *
 *  Lifecycle (final Product Owner decision, §1):
 *  «پیش‌نویس» is the ONLY unfinished Product state. There is no user-facing
 *  «نیازمند راه‌اندازی» queue and no second Product lifecycle — `inventory_setup`
 *  remains an internal technical invariant only.
 *
 *  Reused canonical surfaces: ProductStudio (create/edit), Product360 (read),
 *  DiscountManager/ProductPricingWorkspace (pricing), InitialInventoryWorkspace (WMS).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgePercent, Boxes, PackagePlus, PartyPopper, Pencil, Plus, RefreshCw, ScanEye, Warehouse,
} from "lucide-react";
import {
  Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, SafeImg, SearchBox, Segmented, WorkspaceModal,
} from "./primitives";
import { DiscountManager } from "./discount-manager";
import { Product360 } from "./product-360";
import { InitialInventoryWorkspace } from "./initial-inventory-workspace";
import { ProductStudio } from "../portals/admin-product";
import { inventoryApi, promotionRulesApi, productsApi, catalogOpsApi, type AdminProductRow, type ProductCenterView } from "../data/api";
import { fmtToman } from "../data/contracts";
import { cn } from "../utils/cn";

type F = (message: string) => void;
const fa = (value: number | string) => String(value ?? "—").replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]!);

/** §26: raw enums never reach the admin UI — every Product state has Persian copy. */
const PUBLICATION_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: "پیش‌نویس", cls: "bg-slate-100 text-slate-700" },
  published: { label: "منتشرشده", cls: "bg-emerald-100 text-emerald-800" },
  pending: { label: "در انتظار تأیید", cls: "bg-amber-100 text-amber-800" },
  rejected: { label: "ردشده", cls: "bg-red-100 text-red-700" },
  archived: { label: "آرشیوشده", cls: "bg-slate-200 text-slate-600" },
};
const SELECT_CLS = "h-11 w-full rounded-[11px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-sm font-medium outline-none focus:border-[var(--kv-accent)]";

/** §5: the five canonical Product views — «نیازمند راه‌اندازی» is deliberately absent. */
const VIEWS: { v: ProductCenterView; label: string }[] = [
  { v: "all", label: "همه محصولات" },
  { v: "drafts", label: "پیش‌نویس‌ها" },
  { v: "published", label: "منتشرشده" },
  { v: "out_of_stock", label: "ناموجود" },
  { v: "archived", label: "آرشیوشده" },
];

const Pill = ({ value }: { value: string }) => {
  const meta = PUBLICATION_BADGE[value] ?? { label: "نامشخص", cls: "bg-slate-100 text-slate-600" };
  return <span className={cn("whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold", meta.cls)}>{meta.label}</span>;
};

/** §20: «—» means no inventory record exists yet for that domain; 0 is a real configured zero.
 *  Both are physical-quantity facts — never a Product lifecycle state. */
const StockCell = ({ pending, value, unit }: { pending: boolean; value: number; unit: string }) => (
  <span className="whitespace-nowrap font-bold tabular-nums">
    {pending ? <span className="text-[var(--kv-faint)]">—</span>
      : `${fa(value)} ${unit}`}
  </span>
);

type Screen =
  | { k: "list" }
  | { k: "studio" }
  | { k: "pricing"; row: AdminProductRow }
  /** §12/§16: canonical initial receipt (interrupted or fresh «ذخیره و ادامه»). */
  | { k: "inventory"; row: AdminProductRow }
  /** §24: ongoing WMS operations for a product whose initial inventory is already done. */
  | { k: "wms"; row: AdminProductRow }
  | { k: "view360"; row: AdminProductRow };

export function KolbeProductsHub({ flash, initialView, onOpenWms }: {
  flash: F; initialView?: ProductCenterView; onOpenWms?: () => void;
}) {
  const [view, setView] = useState<ProductCenterView>(initialView ?? "all");
  useEffect(() => { if (initialView) setView(initialView); }, [initialView]);
  const [rows, setRows] = useState<AdminProductRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [screen, setScreen] = useState<Screen>({ k: "list" });
  /** §9/§13: resuming a Draft reopens the SAME canonical studio with the product loaded. */
  const [resumeProductId, setResumeProductId] = useState<string | null>(null);
  // RULE-BULK-001 (§21): bulk festival assignment stays available in the product list.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [festivalModal, setFestivalModal] = useState(false);
  const [bulkResult, setBulkResult] = useState<Awaited<ReturnType<typeof promotionRulesApi.festivalBulk>> | null>(null);
  const limit = 30;

  const load = useCallback(() => {
    setError(null);
    // §4: «محصولات کلبه» owns Kolbe-owned products; supplier products are reviewed in WMS.
    catalogOpsApi.adminProducts({
      view, owner: "kolbe", limit, offset: page * limit, ...(q.trim() ? { q: q.trim() } : {}),
    })
      .then((r) => { setRows(r.items); setTotal(r.total); })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا در دریافت محصولات"));
  }, [view, page, q]);
  useEffect(load, [load]);

  const counts = useMemo(() => ({
    drafts: rows?.filter((r) => r.status === "draft").length ?? 0,
  }), [rows]);

  const openStudio = () => { setResumeProductId(null); setScreen({ k: "studio" }); };
  const resumeDraft = (id: string) => { setResumeProductId(id); setScreen({ k: "studio" }); };

  if (screen.k === "studio") return (
    <div className="space-y-3">
      {/* §3: [افزودن محصول] opens the canonical Product Studio form directly — the hub owns the
          list, so the studio is embedded and never shows a second product-management list. */}
      <ProductStudio
        flash={flash}
        embedded
        onExit={() => { setScreen({ k: "list" }); setResumeProductId(null); load(); }}
        resumeProductId={resumeProductId}
        onResumeHandled={() => setResumeProductId(null)}
        /** §11: Save & Continue hands the canonical productId straight to the WMS workspace. */
        onContinueToInventory={(productId) => {
          productsApi.adminDetail(productId)
            .then((detail) => {
              setScreen({ k: "inventory", row: {
                id: productId, name: String(detail.name ?? ""),
                retail_enabled: detail.retail_enabled !== false, wholesale_enabled: detail.wholesale_enabled !== false,
                owner_type: String(detail.owner_type ?? "kolbe"), sku: null, category: String(detail.category ?? ""),
              } as AdminProductRow });
            })
            .catch(() => flash("محصول ذخیره شد؛ برای ادامه، آن را از فهرست پیش‌نویس‌ها باز کنید."));
        }}
        onDraftSaved={() => { setScreen({ k: "list" }); load(); }}
        /** §2/§5: an explicit publish reloads the hub list so the row, the status badge and the
            «منتشرشده» / «پیش‌نویس‌ها» filters all reflect the server in the same click. */
        onPublished={(productId) => { void productsApi.adminDetail(productId); load(); }}
      />
    </div>
  );

  if (screen.k === "inventory") return (
    <InitialInventoryWorkspace
      product={screen.row}
      flash={flash}
      onClose={() => { setScreen({ k: "list" }); load(); }}
      onDone={() => { setScreen({ k: "list" }); load(); }}
    />
  );

  // §24: a product that already completed initial creation goes to REAL WMS operations,
  // never back into the initial-receipt workspace (which would fabricate a second opening).
  if (screen.k === "wms") return (
    <ManageInventoryPanel
      product={screen.row}
      onClose={() => { setScreen({ k: "list" }); load(); }}
      onOpenWms={onOpenWms}
    />
  );

  if (screen.k === "pricing") return (
    <WorkspaceModal open onClose={() => setScreen({ k: "list" })} title={`مدیریت قیمت‌گذاری — ${screen.row.name}`}>
      <DiscountManager
        productId={screen.row.id} productName={screen.row.name} sku={screen.row.sku ?? undefined}
        onClose={() => setScreen({ k: "list" })} flash={flash}
      />
    </WorkspaceModal>
  );

  if (screen.k === "view360") return (
    <Product360
      product={screen.row}
      onClose={() => setScreen({ k: "list" })}
      onPricing={() => setScreen({ k: "pricing", row: screen.row })}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-extrabold">محصولات کلبه</h2>
          <p className="mt-0.5 text-[11.5px] leading-6 text-[var(--kv-muted)]">
            تعریف، تکمیل و مدیریت محصولات کلبه — موجودی فیزیکی فقط با سند انبار (WMS) تغییر می‌کند و قیمت‌گذاری از مرکز تخفیف و جشنواره خوانده می‌شود.
          </p>
        </div>
        {/* §4: the primary action opens the canonical Product Studio. */}
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={openStudio}>افزودن محصول</Btn>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented options={VIEWS} value={view} onChange={(v) => { setView(v); setPage(0); setSelected(new Set()); }} />
        <div className="flex items-center gap-2">
          <SearchBox value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="جست‌وجوی نام، برند یا دسته…" />
          <Btn size="sm" variant="ghost" onClick={load} aria-label="تازه‌سازی"><RefreshCw size={14} /></Btn>
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rows && <LoadingState label="در حال دریافت محصولات..." />}
      {!error && rows && !rows.length && (
        <Empty
          title={view === "drafts" ? "پیش‌نویسی وجود ندارد" : "محصولی یافت نشد"}
          desc={view === "drafts"
            ? "محصولی که سفر ایجاد آن کامل نشده باشد، این‌جا با عنوان «پیش‌نویس» می‌نشیند تا بعداً ادامه‌اش بدهید."
            : "فیلتر یا عبارت جست‌وجو را تغییر دهید، یا با «افزودن محصول» یک محصول جدید تعریف کنید."}
          action={<Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={openStudio}>افزودن محصول</Btn>}
        />
      )}

      {!error && rows && rows.length > 0 && (
        <Card className="p-0">
          <div className="kv-scroll kv-scroll-x">
            <table className="kv-table min-w-[900px] w-full text-xs">
              <thead><tr>
                <th className="w-8">
                  <input type="checkbox" className="accent-[var(--kv-accent)]" aria-label="انتخاب همه"
                    checked={rows.every((p) => selected.has(p.id))}
                    onChange={(e) => setSelected((prev) => { const next = new Set(prev); for (const p of rows) { if (e.target.checked) next.add(p.id); else next.delete(p.id); } return next; })} />
                </th>
                <th>محصول</th><th>دسته‌بندی</th><th>روش فروش</th><th>قیمت</th>
                <th>موجودی خرده</th><th>موجودی عمده</th><th>وضعیت</th><th>اقدام</th>
              </tr></thead>
              <tbody>
                {rows.map((p) => {
                  const pending = p.inventory_setup === "pending";
                  const draft = p.status === "draft";
                  return (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" className="accent-[var(--kv-accent)]" aria-label={`انتخاب ${p.name}`}
                          checked={selected.has(p.id)}
                          onChange={(e) => setSelected((prev) => { const next = new Set(prev); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} />
                      </td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-10 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--kv-line)] bg-[var(--kv-surface-2)]">
                            {/* §15: a missing/unreachable cover must never show a broken-image glyph. */}
                            <SafeImg src={p.cover_file_id ? `/api/v1/product-media/${p.cover_file_id}` : null}
                              alt={`تصویر ${p.name}`} className="h-full w-full object-cover"
                              fallbackClassName="flex h-full w-full" />
                          </span>
                          <span className="min-w-0">
                            <b className="block max-w-[220px] truncate">{p.name}</b>
                            <span className="text-[10.5px] text-[var(--kv-muted)]" dir="ltr">{p.sku ?? "—"}</span>
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap">{p.category}</td>
                      <td className="whitespace-nowrap">
                        {p.retail_enabled && p.wholesale_enabled ? "خرده + عمده" : p.retail_enabled ? "خرده" : p.wholesale_enabled ? "عمده" : "—"}
                      </td>
                      <td className="whitespace-nowrap">
                        <span className="block font-bold">{p.cash_price_rial ? fmtToman(p.cash_price_rial) : "—"}</span>
                        {p.wholesale_price_rial && <span className="block text-[10px] text-[var(--kv-muted)]">عمده {fmtToman(p.wholesale_price_rial)}</span>}
                      </td>
                      <td>{p.retail_enabled ? <StockCell pending={pending} value={p.retail_available} unit="عدد" /> : <span className="text-[var(--kv-faint)]">—</span>}</td>
                      <td>{p.wholesale_enabled ? <StockCell pending={pending} value={p.wholesale_series_available} unit="سری" /> : <span className="text-[var(--kv-faint)]">—</span>}</td>
                      <td><Pill value={p.status} /></td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1">
                          {/* §13: an interrupted draft offers the canonical continuation action. */}
                          {draft && (
                            <Btn size="sm" variant="accent" onClick={() => resumeDraft(p.id)}>
                              <PackagePlus size={13} />ادامه تکمیل محصول
                            </Btn>
                          )}
                          <Btn size="sm" variant="ghost" onClick={() => resumeDraft(p.id)}><Pencil size={13} />ویرایش</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setScreen({ k: "view360", row: p })}><ScanEye size={13} />۳۶۰°</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setScreen({ k: "pricing", row: p })}><BadgePercent size={13} />قیمت‌گذاری</Btn>
                          {/* §24: an interrupted draft continues the canonical initial receipt;
                              a completed product opens real WMS operations. */}
                          <Btn size="sm" variant="ghost"
                            onClick={() => setScreen({ k: pending ? "inventory" : "wms", row: p })}>
                            {pending ? <Warehouse size={13} /> : <Boxes size={13} />}{pending ? "ورود اولیه کالا" : "مدیریت موجودی"}
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > limit && (
            <div className="flex items-center justify-center gap-2 p-3">
              <Btn size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>قبلی</Btn>
              <span className="text-[11.5px] text-[var(--kv-muted)]">صفحه {fa(page + 1)} از {fa(Math.ceil(total / limit))}</span>
              <Btn size="sm" variant="ghost" disabled={(page + 1) * limit >= total} onClick={() => setPage((p) => p + 1)}>بعدی</Btn>
            </div>
          )}
        </Card>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-2 z-10 flex flex-wrap items-center gap-2 rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 py-2 shadow-[var(--shadow-soft-lg)]">
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
              {bulkResult.summary.alreadyInFestival > 0 && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-bold text-slate-600">{fa(bulkResult.summary.alreadyInFestival)} از قبل عضو</span>}
              {bulkResult.summary.needsConfirmation > 0 && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-bold text-amber-800">{fa(bulkResult.summary.needsConfirmation)} نیازمند تأیید انتقال</span>}
              {bulkResult.summary.errors > 0 && <span className="rounded-full bg-red-100 px-2.5 py-1 font-bold text-red-700">{fa(bulkResult.summary.errors)} خطا</span>}
            </div>
            <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">
              با ورود به جشنواره، تخفیف‌های مستقل این کالاها «معلق» می‌شوند (حذف نمی‌شوند) و پس از پایان جشنواره فقط با «فعال‌سازی مجدد» برمی‌گردند.
            </p>
          </div>
        </Modal>
      )}
      <p className="text-[11px] leading-6 text-[var(--kv-muted)]">
        {view === "drafts"
          ? "«پیش‌نویس» یعنی سفر ایجاد محصول هنوز کامل نشده است؛ این وضعیت تنها وضعیت ناتمام محصول است و تا زمان انتشار، محصول قابل خرید نیست."
          : "تعداد پیش‌نویس‌های این صفحه: " + fa(counts.drafts)}
      </p>
    </div>
  );
}

/* ------------------------------ §24: «مدیریت موجودی» → real WMS operations ------------------------------ */

type BalanceRow = {
  variant_id: string; warehouse_id: string; inventory_domain: string; warehouse_name: string; sku: string;
  size_label: string | null; color_label: string | null; on_hand: number; reserved: number; damaged: number; available: number;
};
type MovementRow = {
  id: string; sku: string | null; warehouse_name: string | null; inventory_domain: string | null;
  on_hand_delta: number | null; reason: string | null; reference_type: string | null; created_at: string;
};

/** Read-only WMS surface scoped to ONE product (server-filtered), with a direct route into
 *  the WMS hub for the operations themselves. It never edits a balance from here. */
function ManageInventoryPanel({ product, onClose, onOpenWms }: {
  product: AdminProductRow; onClose: () => void; onOpenWms?: () => void;
}) {
  const [rows, setRows] = useState<BalanceRow[] | null>(null);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    Promise.all([
      inventoryApi.balances({ productId: product.id, limit: 100 }),
      inventoryApi.productMovements(product.id),
    ])
      .then(([balances, moves]) => {
        setRows(balances.items as BalanceRow[]);
        setMovements((moves.items ?? []) as unknown as MovementRow[]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "خطا در دریافت موجودی"));
  }, [product.id]);
  useEffect(load, [load]);

  const domainFa = (domain: string | null) => domain === "wholesale" ? "عمده" : "خرده";

  return (
    <WorkspaceModal open onClose={onClose} title={`مدیریت موجودی — ${product.name}`}
      subtitle="این فقط نمای موجودی واقعیِ همین محصول است؛ عملیات موجودی (رسید، اصلاح، انتقال، فروش) در «انبار و موجودی (WMS)» و با سند انجام می‌شود."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">هر تغییر فیزیکی فقط با سند انبار و ثبت حرکت انجام می‌شود؛ این صفحه موجودی را دستکاری نمی‌کند.</p>
          <div className="flex gap-2">
            {onOpenWms && <Btn variant="soft" onClick={onOpenWms}><Boxes size={14} />رفتن به انبار و موجودی (WMS)</Btn>}
            <Btn variant="ghost" onClick={onClose}>بستن</Btn>
          </div>
        </div>
      }>
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !rows && <LoadingState label="در حال دریافت موجودی..." />}
      {!error && rows && !rows.length && (
        <Empty title="ردیف موجودی برای این محصول ثبت نشده است"
          desc="موجودی اولیه این محصول هنوز ثبت نشده یا از بین رفته است؛ برای ثبت از «ورود اولیه کالا» استفاده کنید." />
      )}
      {!error && !!rows?.length && (
        <Card className="p-0">
          <div className="kv-scroll kv-scroll-x">
            <table className="kv-table min-w-[760px] w-full text-xs">
              <thead><tr>
                <th>کد کالا</th><th>رنگ / سایز</th><th>انبار</th><th>دامنه</th>
                <th>موجودی</th><th>رزرو</th><th>آسیب‌دیده</th><th>قابل فروش</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.variant_id}-${row.warehouse_id}-${row.inventory_domain}`}>
                    <td dir="ltr" className="font-mono">{row.sku}</td>
                    <td className="whitespace-nowrap">{row.color_label ?? "—"} / {row.size_label ?? "—"}</td>
                    <td className="whitespace-nowrap">{row.warehouse_name}</td>
                    <td className="whitespace-nowrap">{domainFa(row.inventory_domain)}</td>
                    <td className="font-bold tabular-nums">{fa(row.on_hand)}</td>
                    <td className="tabular-nums">{fa(row.reserved)}</td>
                    <td className="tabular-nums">{fa(row.damaged)}</td>
                    <td className="font-bold tabular-nums">{fa(row.available)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {!!movements.length && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-bold">آخرین حرکت‌های انبار</h3>
          <ul className="space-y-2">
            {movements.slice(0, 12).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-[var(--kv-line)] px-3 py-2 text-[11.5px]">
                <span className="min-w-0">
                  <b dir="ltr" className="font-mono">{m.sku ?? "—"}</b>
                  <span className="ms-2 text-[var(--kv-muted)]">{m.warehouse_name ?? "—"} · {domainFa(m.inventory_domain)}</span>
                </span>
                <span className="whitespace-nowrap">
                  <b className={cn("tabular-nums", Number(m.on_hand_delta ?? 0) >= 0 ? "text-emerald-700" : "text-red-700")}>
                    {Number(m.on_hand_delta ?? 0) >= 0 ? "+" : ""}{fa(m.on_hand_delta ?? 0)}
                  </b>
                  <span className="ms-2 text-[var(--kv-muted)]">{m.reason ?? "—"}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </WorkspaceModal>
  );
}

/* ------------------------- RULE-BULK-001: bulk festival assignment ------------------------- */

function BulkFestivalModal({ productIds, onClose, onDone }: {
  productIds: string[]; onClose: () => void;
  onDone: (result: Awaited<ReturnType<typeof promotionRulesApi.festivalBulk>>) => void;
}) {
  const [festivals, setFestivals] = useState<{ id: string; name: string }[] | null>(null);
  const [pick, setPick] = useState("");
  const [dType, setDType] = useState<"percent" | "fixed_rial">("percent");
  const [dValue, setDValue] = useState("");
  const [move, setMove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    promotionRulesApi.list()
      .then((r) => {
        const list = (r.promotions ?? []).filter((f: Record<string, unknown>) => f.kind === "festival" && f.active !== false
          && (!f.ends_at || new Date(String(f.ends_at)).getTime() > Date.now())) as { id: string; name: string }[];
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
              <select className={SELECT_CLS} value={pick} onChange={(e) => setPick(e.target.value)} aria-label="جشنواره">
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
            {error && <p role="alert" className="rounded-[10px] bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-700">{error}</p>}
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
