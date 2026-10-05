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
 *  Reused canonical surfaces: ProductStudio (create/edit/pricing/initial-inventory — the ONE
 *  product workflow), Product360 (read), the canonical Promotion Center (discounts/festivals).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BadgePercent, PackagePlus, PartyPopper, Pencil, Plus, RefreshCw, ScanEye, Warehouse,
} from "lucide-react";
import {
  Btn, Card, Empty, ErrorState, Field, Input, LoadingState, Modal, SafeImg, SearchBox, Segmented,
} from "./primitives";
import { Product360 } from "./product-360";
import { ProductStudio, STUDIO_STEPS, type StudioStep } from "../portals/admin-product";
import { promotionRulesApi, productsApi, catalogOpsApi, type AdminProductRow, type ProductCenterView } from "../data/api";
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
  /** §26 (unified Studio): create AND every product task (edit / pricing / inventory / …) happen
   *  inside the ONE canonical Product Studio, opened directly at the relevant step. */
  | { k: "studio"; step: StudioStep; resumeId: string | null }
  | { k: "view360"; row: AdminProductRow };

/** §26: the Studio route lives in the hash (with the requested step) so refresh/Back keep it. */
const STUDIO_HASH = "#/admin/products/studio/";
/** §6: the superseded full-page pricing route now REDIRECTS to the Studio pricing step. */
const LEGACY_PRICING_HASH = "#/admin/products/pricing/";
const parseStudioHash = (hash: string): { id: string; step: StudioStep } | null => {
  const legacy = new RegExp(`^${LEGACY_PRICING_HASH}([0-9a-f-]{36})`, "i").exec(hash);
  if (legacy) return { id: legacy[1]!, step: "price" };
  const hit = new RegExp(`^${STUDIO_HASH}(new|[0-9a-f-]{36})(?:\\?step=([a-z]+))?`, "i").exec(hash);
  if (!hit) return null;
  const step = (STUDIO_STEPS as readonly string[]).includes(hit[2] ?? "") ? hit[2] as StudioStep : "base";
  return { id: hit[1]!, step };
};
const studioHash = (id: string, step: StudioStep) =>
  `${STUDIO_HASH}${id}${step === "base" ? "" : `?step=${step}`}`;
const rowFromDetail = (detail: Record<string, unknown>, id: string, fallbackName = ""): AdminProductRow => ({
  id, name: String(detail.name ?? fallbackName),
  retail_enabled: detail.retail_enabled !== false, wholesale_enabled: detail.wholesale_enabled !== false,
  owner_type: String(detail.owner_type ?? "kolbe"), sku: null, category: String(detail.category ?? ""),
} as AdminProductRow);

export function KolbeProductsHub({ flash, initialView, onOpenWms, onOpenPromo }: {
  flash: F; initialView?: ProductCenterView; onOpenWms?: () => void;
  /** §2/§17: the canonical Promotion Center is a different tab — the pricing workspace links to it
   *  WITH the product context so the two surfaces stay one authority, never two views. */
  onOpenPromo?: (focus: { productId: string; productName: string; anchor?: "discount" | "festival" }) => void;
}) {
  const [view, setView] = useState<ProductCenterView>(initialView ?? "all");
  useEffect(() => { if (initialView) setView(initialView); }, [initialView]);
  const [rows, setRows] = useState<AdminProductRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  /** §26: the hash decides the initial screen — a bookmarked Studio/pricing URL reopens the SAME
   *  draft at the SAME step (the legacy pricing route is redirected to step «قیمت‌گذاری»). */
  const initial = typeof window === "undefined" ? null : parseStudioHash(window.location.hash);
  const [screen, setScreen] = useState<Screen>(() => initial
    ? { k: "studio", step: initial.step, resumeId: initial.id === "new" ? null : initial.id }
    : { k: "list" });
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

  /** §16: the hub keeps its view/search/filters/scroll and returns to exactly this state. */
  const listScroll = useRef(0);
  const openStudio = () => {
    listScroll.current = window.scrollY;
    setScreen({ k: "studio", step: "base", resumeId: null });
    if (typeof window !== "undefined") window.location.hash = studioHash("new", "base");
  };
  /** §5/§26: every row action opens the SAME Studio, at the step that action refers to. */
  const openStudioAt = (row: AdminProductRow, step: StudioStep) => {
    listScroll.current = window.scrollY;
    setScreen({ k: "studio", step, resumeId: row.id });
    if (typeof window !== "undefined") window.location.hash = studioHash(row.id, step);
  };
  const closeStudio = () => {
    if (typeof window !== "undefined" && (window.location.hash.startsWith(STUDIO_HASH) || window.location.hash.startsWith(LEGACY_PRICING_HASH)))
      window.location.hash = "#/admin";
    setScreen({ k: "list" });
    load();
    window.requestAnimationFrame(() => window.scrollTo({ top: listScroll.current, behavior: "auto" }));
  };

  /* §6: `#/admin/products/pricing/<id>` (old bookmarks) redirects into the Studio pricing step. */
  useEffect(() => {
    if (typeof window === "undefined" || !window.location.hash.startsWith(LEGACY_PRICING_HASH)) return;
    const id = new RegExp(`^${LEGACY_PRICING_HASH}([0-9a-f-]{36})`, "i").exec(window.location.hash)?.[1];
    if (!id) return;
    window.history.replaceState(null, "", studioHash(id, "price"));
    productsApi.adminDetail(id)
      .then((detail) => openStudioAt(rowFromDetail(detail, id), "price"))
      .catch(() => flash("محصول موردنظر برای قیمت‌گذاری یافت نشد."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (screen.k === "studio") return (
    <div className="space-y-3">
      {/* §26: [افزودن محصول] and every row action open the canonical Product Studio form directly at
          the requested step — the hub owns the list, the Studio owns the product workflow. */}
      <ProductStudio
        flash={flash}
        embedded
        initialStep={screen.step}
        onExit={closeStudio}
        resumeProductId={screen.resumeId}
        onResumeHandled={() => setScreen((current) => current.k === "studio" ? { ...current, resumeId: null } : current)}
        onDraftSaved={() => { load(); }}
        /** §2/§5: an explicit publish reloads the hub list so the row, the status badge and the
            «منتشرشده» / «پیش‌نویس‌ها» filters all reflect the server in the same click. */
        onPublished={() => { load(); }}
        /** §23: advanced WMS work stays in the WMS hub — the Studio never becomes a stock authority. */
        onOpenWms={onOpenWms}
        /** §32: cross-product promotion admin stays in the canonical Promotion Center. */
        onOpenPromotionCenter={(focus) => onOpenPromo?.(focus)}
      />
    </div>
  );

  if (screen.k === "view360") return (
    <Product360
      product={screen.row}
      onClose={() => setScreen({ k: "list" })}
      onPricing={() => openStudioAt(screen.row, "price")}
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
                          {/* §5/§26: every action opens the SAME Studio at the right step. */}
                          {draft && (
                            <Btn size="sm" variant="accent"
                              onClick={() => openStudioAt(p, pending ? "inventory" : "price")}>
                              <PackagePlus size={13} />ادامه تکمیل محصول
                            </Btn>
                          )}
                          <Btn size="sm" variant="ghost" onClick={() => openStudioAt(p, "base")}><Pencil size={13} />ویرایش</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => openStudioAt(p, "price")}><BadgePercent size={13} />قیمت‌گذاری</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => openStudioAt(p, "inventory")}><Warehouse size={13} />{pending ? "ورود اولیه کالا" : "مدیریت موجودی"}</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setScreen({ k: "view360", row: p })}><ScanEye size={13} />۳۶۰°</Btn>
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
