import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BadgePercent, Boxes, Check, Film, Image as ImageIcon, Loader2, Pencil, Plus, Save, Sparkles, Trash2, Upload, Wand2, Workflow, X } from "lucide-react";
import { COLORS, IMG, fmtMoney, fmtNum, nextSku, type Colorway, type Product, type SeriesDef } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE } from "../data/platform";
import { useOps } from "../data/ops";
import { fileToUrl, removeBackground, sendToN8n } from "../components/media";
import { authBlobUrl, filesApi, integrationsApi, inventoryApi, productColorsApi, productStructureApi, productsApi, seriesTemplatesApi } from "../data/api";
import {
  INSTALLMENT_POLICIES, INSTALLMENT_POLICY_LABEL, buildProductCreatePayload, normalizeProductTypes, normalizeTaxonomies, normalizeWarehouses,
  productVariantSkus, readProductCreateResponse, rialFromToman, variantKey, variantMatrix,
  type InstallmentPolicy, type ProductType as StructureProductType, type Taxonomy, type Warehouse,
} from "../data/contracts";
import { ProductSpecsEditor } from "../components/product-specs-editor";
import { ProductInventoryDrawer } from "../components/product-inventory";
import { DiscountManager } from "../components/discount-manager";
import { seriesComplete, seriesSizesFor } from "./series-templates";
import { AdaptiveSpecForm, missingRequiredSpecs } from "./admin-product-types";
import { productTypesApi, siteApi, studioApi, type ProductType } from "../data/experience-api";
import { catalogOpsApi } from "../data/api";
import { Btn, Card, WorkspaceModal, Empty, Field, Input, LoadingState, Modal, Segmented, Select, Status, Switch, Textarea, SearchBox } from "../components/primitives";
import { cn } from "../utils/cn";
import { CanonicalSeriesLibrary, ProductSeriesEditor, productSeriesPayload } from "../components/product-series-editor";

type F = (m: string) => void;
type Cutout = NonNullable<Product["cutout"]>;
const CUT_LABEL: Record<Cutout["status"], string> = { none: "بدون تصویر", queued: "در صف n8n", processing: "در حال پردازش", ready: "آماده استایل‌بیلدر", failed: "ناموفق" };

/* ============ Style-builder cutout pipeline (n8n with local fallback) ============ */
export function CutoutUploader({ productId, value, onChange, candidates, flash }: { productId: string; value: Cutout; onChange: (c: Cutout) => void; candidates: string[]; flash: F }) {
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const ops = useOps();
  /* n8n configuration lives in the Integration Center (server) — never as local ops state in production. */
  const [integration, setIntegration] = useState<{ id: string; enabled: boolean; webhookUrl: string; config: Record<string, unknown> } | null>(null);
  const loadIntegration = async () => {
    if (isDemo) return;
    try {
      const res = await integrationsApi.list();
      const hit = (res.items ?? []).find((i) => i.code === "n8n");
      if (hit) setIntegration({ id: hit.id, enabled: Boolean(hit.enabled), webhookUrl: String((hit.config ?? {}).webhookUrl ?? ""), config: hit.config ?? {} });
    } catch { /* integration center not reachable — keep local demo values */ }
  };
  useEffect(() => { void loadIntegration(); }, [isDemo]);
  const updateIntegration = async (patch: { enabled?: boolean; config?: Record<string, unknown> }) => {
    if (!integration) throw new Error("یکپارچه‌سازی n8n یافت نشد");
    await integrationsApi.update(integration.id, patch);
    await loadIntegration();
  };
  const ref = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string>(value.src && !value.src.startsWith("data:image/png") ? value.src : candidates[0] ?? "");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const busy = value.status === "processing" || value.status === "queued";

  const runLocal = async (src: string) => {
    onChange({ status: "processing", src, source: "local", note: "حذف پس‌زمینه محلی" });
    try {
      const png = await removeBackground(src);
      setPreview(png);
      onChange({ status: "ready", src: png.length < 700_000 ? png : src, source: "local", note: png.length < 700_000 ? undefined : "PNG بزرگ است؛ نسخه منبع ذخیره و هنگام نمایش پردازش می‌شود" });
      flash("پس‌زمینه حذف و تصویر PNG شفاف برای استایل‌بیلدر آماده شد");
    } catch (e) {
      onChange({ status: "failed", src, source: "local", note: String((e as Error).message) });
      setError(String((e as Error).message));
    }
  };
  const run = async () => {
    setError("");
    if (!source) { setError("ابتدا تصویر منبع را انتخاب یا بارگذاری کنید."); return; }
    const hookUrl = (!isDemo && integration ? integration.webhookUrl : ops.n8n.webhookUrl).trim();
    const hookEnabled = isDemo ? ops.n8n.enabled : Boolean(integration?.enabled && hookUrl);
    if (hookEnabled && hookUrl) {
      onChange({ status: "queued", src: source, source: "n8n", note: "ارسال به n8n" });
      try {
        const url = await sendToN8n(hookUrl, source, productId);
        setPreview(url);
        onChange({ status: "ready", src: url, source: "n8n" });
        flash("n8n تصویر آماده استایل‌بیلدر را برگرداند");
      } catch (e) {
        onChange({ status: "failed", src: source, source: "n8n", note: String((e as Error).message) });
        setError(`اتصال به n8n ناموفق بود: ${(e as Error).message}. می‌توانید پردازش محلی را اجرا کنید.`);
      }
    } else runLocal(source);
  };
  const shown = preview ?? (value.status === "ready" ? value.src : undefined);

  return (
    <div className="space-y-4">
      <div className="rounded-[12px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/40 p-4 text-[12.5px] leading-6 text-[var(--kv-muted)]">
        تصویر استایل‌بیلدر جدا از عکس‌های فروشگاه است: یک عکس روبه‌روی کامل از خود لباس (بدون مدل) روی پس‌زمینه ساده بارگذاری کنید. خروجی باید <b className="text-[var(--kv-ink)]">PNG بدون پس‌زمینه</b> باشد تا روی بوم نقطه‌ای استایل‌بیلدر قرار بگیرد.
      </div>
      <div>
        <p className="mb-2 text-[13px] font-semibold">تصویر منبع</p>
        <div className="flex flex-wrap gap-2">
          {candidates.map((c) => <button key={c} onClick={() => setSource(c)} aria-pressed={source === c} className={cn("h-16 w-16 overflow-hidden rounded-[10px] border-2", source === c ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)]")}><img src={c} alt="" className="h-full w-full object-cover" /></button>)}
          <input ref={ref} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const r = await fileToUrl(file, 2 * 1024 * 1024); setSource(r.url); }} />
          <button onClick={() => ref.current?.click()} className="flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-[10px] border-2 border-dashed border-[var(--kv-line-strong)] text-[10.5px] font-semibold text-[var(--kv-muted)] hover:border-[var(--kv-accent)]"><Upload size={16} />بارگذاری</button>
        </div>
      </div>
      <div className="rounded-[12px] border border-[var(--kv-line)] p-4">
        <div className="flex items-center justify-between gap-2"><p className="flex items-center gap-2 text-[13px] font-bold"><Workflow size={15} className="text-[var(--kv-accent)]" />اتوماسیون n8n {isDemo ? "(demo)" : "(Integration Center)"}</p><Switch on={integration?.enabled ?? ops.n8n.enabled} onToggle={async () => { if (isDemo) { ops.set("n8n", { ...ops.n8n, enabled: !ops.n8n.enabled }); return; } if (!integration) { flash("ابتدا یکپارچه‌سازی n8n را در «یکپارچه‌سازی‌ها» بسازید"); return; } try { await updateIntegration({ enabled: !integration.enabled }); } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره تنظیمات n8n"); } }} /></div>
        {(integration?.enabled ?? ops.n8n.enabled) ? <Field label="Webhook URL" hint={isDemo ? "demo: محلی" : "ذخیره‌شده در Integration Center (سرور)"}><Input value={integration?.webhookUrl ?? ops.n8n.webhookUrl} onChange={async (v) => { const url = v.trim(); if (isDemo) { ops.set("n8n", { ...ops.n8n, webhookUrl: url }); return; } if (!integration) { flash("ابتدا یکپارچه‌سازی n8n را در «یکپارچه‌سازی‌ها» بسازید"); return; } setIntegration((prev) => prev ? { ...prev, webhookUrl: url } : prev); try { await updateIntegration({ config: { ...integration.config, webhookUrl: url } }); } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره Webhook"); } }} placeholder="https://n8n.example.ir/webhook/style-cutout" /></Field>
          : <p className="mt-1 text-[12px] text-[var(--kv-muted)]">غیرفعال است؛ پس‌زمینه در مرورگر حذف می‌شود (مناسب عکس‌های پس‌زمینه سفید یا یکدست).</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn variant="accent" disabled={busy || !source} onClick={run} icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Wand2 size={15} />}>{busy ? "در حال پردازش…" : (isDemo ? ops.n8n.enabled : Boolean(integration?.enabled && integration.webhookUrl)) ? "ارسال به n8n و آماده‌سازی" : "حذف پس‌زمینه و آماده‌سازی"}</Btn>
        {value.status === "failed" && <Btn variant="soft" onClick={() => runLocal(source)}>پردازش محلی</Btn>}
        {value.status === "ready" && <Btn variant="ghost" icon={<X size={14} />} onClick={() => { onChange({ status: "none" }); setPreview(null); }}>حذف از استایل‌بیلدر</Btn>}
      </div>
      <div className="flex items-center gap-2"><Status value={CUT_LABEL[value.status]} />{value.source && <span className="text-[11.5px] text-[var(--kv-muted)]">منبع پردازش: {value.source === "n8n" ? "n8n" : "مرورگر"}</span>}</div>
      {error && <p role="alert" className="text-[12px] leading-6 text-[var(--kv-danger)]">{error}</p>}
      <div className="kv-dotted-light flex h-64 items-center justify-center rounded-[16px] border border-[var(--kv-line)] p-4">
        {shown ? <CutoutImg src={shown} alt="پیش‌نمایش استایل‌بیلدر" className="max-h-full max-w-full object-contain drop-shadow-[0_12px_18px_rgba(27,42,74,0.18)]" /> : <p className="text-[12.5px] text-[var(--kv-muted)]">پیش‌نمایش PNG روی بوم استایل‌بیلدر</p>}
      </div>
    </div>
  );
}

/** Renders a cutout, running background removal when the stored source isn't a processed PNG yet. */
export function CutoutImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const ready = src.startsWith("data:image/png") || src.startsWith("blob:");
  const [out, setOut] = useState<string | null>(ready ? src : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready) { setOut(src); return; }
    let live = true;
    setOut(null); setFailed(false);
    removeBackground(src).then((v) => live && setOut(v)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [src, ready]);
  if (failed) return <img src={src} alt={alt} className={className} />;
  if (!out) return <Loader2 size={20} className="animate-spin text-[var(--kv-muted)]" aria-label="در حال آماده‌سازی تصویر" />;
  return <img src={out} alt={alt} className={className} />;
}

/* ============ Product definition (Kolbe) ============ */
/** Product media = server file reference (persisted) + local preview URL (display only). */
type DraftImage = { fileId: string | null; url: string; previewUrl?: string };
type Draft = {
  name: string; brand: string; category: string; sku: string; desc: string; fabric: string; care: string;
  retail: string; installment: string; seoTitle: string; slug: string; retailOn: boolean; wholesaleOn: boolean;
  colors: Colorway[]; sizes: string[]; images: DraftImage[]; video: string; videoFileId: string | null; series: SeriesDef[]; cutout: Cutout;
  typeCode: string; specs: Record<string, unknown>; gender: "men" | "women" | "unisex" | "kids"; seasons: string[]; vibes: string[];
  productTypeId: string; genderCode: string;
  installmentPolicy: InstallmentPolicy; wholesaleMoq: string; variantWeights: Record<string, string>;
};
const blank = (): Draft => ({ name: "", brand: "Kolbe", category: "پیراهن", sku: "", desc: "", fabric: "", care: "", retail: "", installment: "", seoTitle: "", slug: "", retailOn: true, wholesaleOn: true, colors: [COLORS.orange, COLORS.black], sizes: ["S", "M", "L", "XL"], images: [], video: "", videoFileId: null, series: [], cutout: { status: "none" }, typeCode: "", specs: {}, gender: "unisex", seasons: ["autumn", "winter"], vibes: [], productTypeId: "", genderCode: "", installmentPolicy: "enabled", wholesaleMoq: "", variantWeights: {} });

type MatrixVariant = {
  id: string; sku: string; active: boolean; weight_grams: number | null;
  price_override_rial: string | null; available: number; on_hand: number;
  retail_on_hand: number; retail_available: number; wholesale_on_hand: number; wholesale_available: number;
};

/**
 * Advanced per-cell variant editor (Req 33, user-approved): weight, variant-level
 * retail price override (Req 25) and active status for one Color×Size cell.
 * Everything persists through the real variant APIs.
 */
function VariantAdvancedEditor({ color, size, variant, onClose, onCreate, onToggleActive, onPatch }: {
  color: string; size: string; variant: MatrixVariant | null;
  onClose: () => void; onCreate: () => void; onToggleActive: () => void;
  onPatch: (payload: { weightGrams?: number | null; priceOverrideRial?: string | null }) => Promise<void> | void;
}) {
  const [weight, setWeight] = useState(variant?.weight_grams === null || variant?.weight_grams === undefined ? "" : String(variant.weight_grams));
  const [overrideToman, setOverrideToman] = useState(variant?.price_override_rial ? String(Math.round(Number(variant.price_override_rial) / 10)) : "");
  return (
    <div className="mt-3 rounded-[12px] border border-[var(--kv-accent)]/40 bg-[var(--kv-surface-2)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12.5px] font-extrabold">ویرایش واریانت: {color} / {size}</p>
        <Btn variant="ghost" size="sm" icon={<X size={13} />} onClick={onClose}>بستن</Btn>
      </div>
      {!variant ? (
        <div className="space-y-2">
          <p className="text-[12px] text-[var(--kv-muted)]">این خانه هنوز واریانت ندارد («—» یعنی وجود ندارد، نه موجودی صفر).</p>
          <Btn variant="accent" size="sm" icon={<Plus size={14} />} onClick={onCreate}>ساخت واریانت با SKU سرور</Btn>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[11.5px] text-[var(--kv-muted)]"><span dir="ltr">{variant.sku}</span> · موجودی {variant.on_hand.toLocaleString("fa-IR")} · قابل فروش {variant.available.toLocaleString("fa-IR")}</p>
          {/* Req 29: retail/wholesale inventory domains are separate (Agent 1 foundation). */}
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            <span className="rounded-full border border-[var(--kv-line)] px-2.5 py-1 font-semibold">موجودی خرده: {variant.retail_on_hand.toLocaleString("fa-IR")} (قابل فروش {variant.retail_available.toLocaleString("fa-IR")})</span>
            <span className="rounded-full border border-[var(--kv-line)] px-2.5 py-1 font-semibold">موجودی عمده: {variant.wholesale_on_hand.toLocaleString("fa-IR")} (قابل فروش {variant.wholesale_available.toLocaleString("fa-IR")})</span>
          </div>
          <div className="flex items-center justify-between rounded-[10px] border border-[var(--kv-line)] px-3 py-2">
            <span className="text-[12px] font-bold">وضعیت فروش این واریانت</span>
            <Switch on={variant.active} onToggle={onToggleActive} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="وزن (گرم)" hint="برای محاسبه هزینه ارسال">
              <Input value={weight} onChange={(v) => setWeight(v.replace(/\D/g, ""))} placeholder="—" />
            </Field>
            <Field label="قیمت اختصاصی این واریانت (تومان)" hint="خالی = پیروی از قیمت پایه محصول؛ جدا از موتور تخفیف">
              <Input value={overrideToman} onChange={(v) => setOverrideToman(v.replace(/\D/g, ""))} placeholder="قیمت پایه" />
            </Field>
          </div>
          <div className="flex gap-2">
            <Btn variant="accent" size="sm" icon={<Check size={14} />}
              onClick={() => void onPatch({
                weightGrams: weight === "" ? null : Number(weight),
                priceOverrideRial: overrideToman === "" ? null : String(Number(overrideToman) * 10),
              })}>ذخیره واریانت</Btn>
            {variant.price_override_rial && (
              <Btn variant="soft" size="sm" onClick={() => { setOverrideToman(""); void onPatch({ priceOverrideRial: null }); }}>حذف قیمت اختصاصی</Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** §6/§9/§13: the canonical Product Studio.
 *
 *  `onContinueToInventory` — [ذخیره و ادامه]: receives the canonical productId and the
 *    caller opens the canonical initial-inventory workspace with the product preselected.
 *  `onDraftSaved` — [ذخیره پیش‌نویس]: the draft is persisted; the caller returns to
 *    the «محصولات کلبه → پیش‌نویس‌ها» list.
 *  `resumeProductId` — reopening a draft loads the SAME canonical studio form (§9).
 *  `embedded` — the caller already owns the canonical product list («محصولات کلبه»), so the
 *    studio mounts straight into the form and NEVER renders its own product list: there is
 *    no intermediate surface and no second product-creation authority.
 *  `onExit` — [انصراف] / «بازگشت به فهرست» / «خروج بدون ذخیره» hand control back to the caller.
 */
export function ProductStudio({ flash, onContinueToInventory, onDraftSaved, resumeProductId, onResumeHandled, embedded, onExit }: {
  flash: F;
  onContinueToInventory?: (productId: string) => void;
  onDraftSaved?: (productId: string) => void;
  resumeProductId?: string | null;
  onResumeHandled?: () => void;
  embedded?: boolean;
  onExit?: () => void;
}) {
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const { products, addProduct, setStatus, updateProduct, reload } = useStore();
  const [mediaBusy, setMediaBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [sec, setSec] = useState("base");
  /** §37: snapshot of the draft at open-time — leaving with unsaved edits asks first. */
  const [openSnapshot, setOpenSnapshot] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [q, setQ] = useState("");
  const [d, setD] = useState<Draft>(blank());
  const [cutFor, setCutFor] = useState<Product | null>(null);
  const [manage, setManage] = useState(false);
  const [newColor, setNewColor] = useState({ name: "", hex: "#8A6A4F" });
  // Inventory step: warehouse + per (color,size) initial quantity. Persisted through WMS receipts.
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [inventoryFor, setInventoryFor] = useState<Product | null>(null);
  const [discountFor, setDiscountFor] = useState<Product | null>(null);
  const [types, setTypes] = useState<ProductType[]>([]);
  /** §8: when the category has a configured profile, CATEGORY is the schema source of truth
   *  and the legacy product-type picker disappears (legacy data stays via the server adapter). */
  type CategorySpecField = { code: string; label: string; type: string; unit: string | null; required: boolean; options: { value: string; label: string }[] };
  const [catSchema, setCatSchema] = useState<{ configured: boolean; allowedSizes: string[]; sizeGuide: { name: string } | null; specFields: CategorySpecField[] } | null>(null);
  const [vibeOptions, setVibeOptions] = useState<{ slug: string; name: string }[]>([]);
  const automaticSizes = useRef(blank().sizes);
  const loadTypes = () => { if (!isDemo) productTypesApi.list().then((r) => setTypes(r.items)).catch(() => setTypes([])); };
  useEffect(() => {
    if (isDemo || !d.category.trim()) { setCatSchema(null); return; }
    let alive = true;
    catalogOpsApi.categorySchema(d.category.trim())
      .then((r) => {
        if (!alive) return;
        const fields = (r.specFields ?? []).map((field) => ({
          code: String(field.code ?? ""), label: String(field.label ?? ""), type: String(field.type ?? "text"),
          unit: field.unit ? String(field.unit) : null, required: field.required === true,
          options: Array.isArray(field.options) ? (field.options as { value: string; label: string }[]) : [],
        })).filter((field) => field.code);
        setCatSchema({ configured: r.configured, allowedSizes: r.allowedSizes ?? [], sizeGuide: r.sizeGuide, specFields: fields });
        // §8: in CREATE mode the selected sizes follow the category profile automatically —
        // no manual reload and no out-of-profile default can remain hidden in the matrix.
        if (!editing && r.configured && (r.allowedSizes ?? []).length) {
          setD((cur) => {
            if (cur.category.trim() !== d.category.trim()) return cur; // ignore a stale response after another category pick
            const allowed = (r.allowedSizes ?? []).slice(0, 4);
            const unchangedDefault = JSON.stringify(cur.sizes) === JSON.stringify(automaticSizes.current);
            const sizes = unchangedDefault ? allowed : cur.sizes.filter((size) => allowed.includes(size));
            const sizeSetChanged = JSON.stringify(sizes) !== JSON.stringify(cur.sizes);
            const series = cur.series.map((item) => {
              const composition = Object.fromEntries(Object.entries(item.composition).filter(([size]) => allowed.includes(size)));
              return { ...item, composition, pieces: Object.values(composition).reduce((sum, quantity) => sum + quantity, 0) };
            });
            const seriesChanged = series.some((item, index) => JSON.stringify(item.composition) !== JSON.stringify(cur.series[index]?.composition));
            automaticSizes.current = allowed;
            return sizeSetChanged || seriesChanged ? { ...cur, sizes, series } : cur;
          });
        }
      })
      .catch(() => { if (alive) setCatSchema(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.category, isDemo]);
  useEffect(() => { loadTypes(); if (!isDemo) siteApi.vibes().then((r) => setVibeOptions(r.items)).catch(() => undefined); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const [specsFor, setSpecsFor] = useState<Product | null>(null);
  const [productTypes, setProductTypes] = useState<StructureProductType[]>([]);
  const [taxonomies, setTaxonomies] = useState<Taxonomy[]>([]);

  /* ---------- Unified create/edit mode (Req 38-39) ---------- */
  type ServerVariant = { id: string; sku: string; color: string | null; size: string | null; weight_grams: number | null; active: boolean; available: number; on_hand: number; price_override_rial: string | null;
    retail_on_hand: number; retail_available: number; wholesale_on_hand: number; wholesale_available: number };
  /* Req 29 (user decision): retail/wholesale inventory tabs live inside the Product Studio matrix. */
  const [invDomain, setInvDomain] = useState<"retail" | "wholesale">("retail");
  const [editing, setEditing] = useState<{ id: string; metadata: Record<string, unknown> } | null>(null);
  const [editVariants, setEditVariants] = useState<ServerVariant[]>([]);
  /* Req 33: the advanced per-cell variant editor (weight, price override, status). */
  const [cellEditor, setCellEditor] = useState<{ color: string; size: string } | null>(null);
  /* Create-mode Color×Size matrix: a switched-off cell means "no variant" (—),
     which is different from a variant with stock 0 (Req 26/32). */
  const [cellOff, setCellOff] = useState<Record<string, boolean>>({});
  /* Persisted structure data (Req 30/34/35/41/43/44) */
  const [serverColors, setServerColors] = useState<{ id: string; name: string; hex: string }[]>([]);
  /* §33/§36: unpublished kolbe products (drafts) merged into the define list — the public catalogue hides them. */
  const [serverDrafts, setServerDrafts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; slug: string; parentId: string | null }[]>([]);
  const [newCategory, setNewCategory] = useState<{ open: boolean; name: string; parentId: string }>({ open: false, name: "", parentId: "" });
  /** §7 (final gate): quick filter for the hierarchical category picker. */
  const [catQuery, setCatQuery] = useState("");
  const [newSize, setNewSize] = useState("");
  const [vibeQuery, setVibeQuery] = useState("");
  const [newVibe, setNewVibe] = useState("");
  const autoSlug = (name: string, prefix: string) => {
    const latin = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return /^[a-z0-9-]{2,60}$/.test(latin) ? latin.slice(0, 50) : `${prefix}-${Date.now().toString(36)}`;
  };
  const loadCategories = () => {
    if (isDemo) return;
    siteApi.categories()
      .then((r) => setCategories((r.items ?? []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, parentId: (c as { parent_id?: string | null }).parent_id ?? null }))))
      .catch(() => setCategories([]));
  };
  const loadServerColors = () => {
    if (isDemo) return;
    productColorsApi.list().then((r) => setServerColors((r.items ?? []).map((c) => ({ id: c.id, name: c.name, hex: c.hex })))).catch(() => setServerColors([]));
  };
  const loadServerDrafts = () => {
    if (isDemo) return;
    catalogOpsApi.adminProducts({ status: "active", owner: "kolbe", limit: 100 })
      .then((r) => setServerDrafts(((r.items ?? []) as { id: string; name: string; brand?: string | null; category?: string | null; status: string }[])
        .filter((row) => row.status !== "published")
        .map((row) => ({
          id: row.id, name: row.name, brand: row.brand ?? "Kolbe", category: row.category ?? "", sku: "",
          supplier: KOLBE.name, supplierId: KOLBE.id, status: row.status,
          retailPrice: 0, installmentPrice: 0, wholesaleFrom: 0, rating: 0, reviews: 0,
          colors: [], images: [], series: [], seriesCount: 0, moq: 1, stock: 0, fabric: "—", desc: "",
        }) as unknown as Product)))
      .catch(() => setServerDrafts([]));
  };
  useEffect(() => { loadCategories(); loadServerColors(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  /* re-sync drafts whenever the canonical cache refreshes (save/publish call reload()). */
  useEffect(() => { loadServerDrafts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [products, isDemo]);
  /** Hierarchical category options (Req 34): parents first, children indented. */
  const categoryTree: { name: string; depth: number }[] = (() => {
    const out: { name: string; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const c of categories.filter((x) => (x.parentId ?? null) === parentId)) {
        out.push({ name: c.name, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  })();
  const NEW_CATEGORY_OPTION = "+ ساخت دسته جدید…";
  const categoryOptionLabels = [
    ...categoryTree.map((c) => `${"— ".repeat(c.depth)}${c.name}`),
    ...(categoryTree.some((c) => c.name === d.category) || !d.category ? [] : [d.category]),
    ...(isDemo ? [] : [NEW_CATEGORY_OPTION]),
  ];
  const createCategory = async () => {
    const name = newCategory.name.trim();
    if (!name) return;
    try {
      await studioApi.createTaxonomy("categories", {
        name, slug: autoSlug(name, "cat"), description: "",
        ...(newCategory.parentId ? { parentId: newCategory.parentId } : {}),
      });
      loadCategories();
      setD((cur) => ({ ...cur, category: name }));
      setNewCategory({ open: false, name: "", parentId: "" });
      flash(`دسته «${name}» ساخته و انتخاب شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت دسته"); }
  };
  const createColor = async () => {
    const name = newColor.name.trim();
    if (!name) return;
    if (isDemo) {
      const c = { id: `c-${Date.now()}`, name, hex: newColor.hex };
      setD((cur) => ({ ...cur, colors: [...cur.colors, c] }));
      setNewColor({ name: "", hex: "#8A6A4F" });
      return;
    }
    try {
      const created = await productColorsApi.create({ name, hex: newColor.hex });
      loadServerColors();
      setD((cur) => ({ ...cur, colors: [...cur.colors, { id: created.id, name: created.name, hex: created.hex }] }));
      setNewColor({ name: "", hex: "#8A6A4F" });
      flash(`رنگ «${name}» در سرور ذخیره و انتخاب شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره رنگ"); }
  };
  /** §8 (corrective): sizes are CATEGORY-driven. With a configured category profile the new
   *  size is explicitly added to that profile (data-safe merge — template/guide untouched);
   *  legacy products with a selected type keep the old path; otherwise the size applies to
   *  this product only (the server has no size constraint without a profile). */
  const createSize = async () => {
    const code = newSize.trim();
    if (!code) return;
    if (!isDemo && catSchema?.configured) {
      try {
        const all = await catalogOpsApi.categoryProfiles();
        const row = (all.items ?? []).find((p) => String(p.category) === d.category.trim()) as Record<string, unknown> | undefined;
        const allowed = Array.isArray(row?.allowed_sizes) ? (row.allowed_sizes as string[]) : (catSchema.allowedSizes ?? []);
        if (!allowed.includes(code)) {
          await catalogOpsApi.saveCategoryProfile(d.category.trim(), {
            specTemplateId: (row?.spec_template_id as string | null) ?? null,
            sizeGuideId: (row?.size_guide_id as string | null) ?? null,
            allowedSizes: [...allowed, code],
            requiredFields: Array.isArray(row?.required_fields) ? row.required_fields : [],
            notes: String(row?.notes ?? ""),
            active: row?.active !== false,
          });
          setCatSchema((cur) => (cur ? { ...cur, allowedSizes: cur.allowedSizes.includes(code) ? cur.allowedSizes : [...cur.allowedSizes, code] } : cur));
          flash(`سایز «${code}» به پروفایل دسته «${d.category}» اضافه شد`);
        }
        setD((cur) => ({ ...cur, sizes: cur.sizes.includes(code) ? cur.sizes : [...cur.sizes, code] }));
        setNewSize("");
      } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن سایز"); }
      return;
    }
    // No profile and no legacy type: the size belongs to this product only.
    setD((cur) => ({ ...cur, sizes: cur.sizes.includes(code) ? cur.sizes : [...cur.sizes, code] }));
    setNewSize("");
    flash(`سایز «${code}» فقط برای همین محصول استفاده می‌شود`);
  };
  const createVibe = async () => {
    const name = newVibe.trim();
    if (!name) return;
    try {
      const slug = autoSlug(name, "vibe");
      await studioApi.createTaxonomy("vibes", { name, slug, description: "" });
      const res = await siteApi.vibes();
      setVibeOptions(res.items ?? []);
      setD((cur) => ({ ...cur, vibes: cur.vibes.includes(slug) ? cur.vibes : [...cur.vibes, slug] }));
      setNewVibe("");
      flash(`وایب «${name}» ساخته و انتخاب شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ساخت وایب"); }
  };

  /** Loads the real server product into the shared studio form (Req 38). */
  const openEdit = async (p: Product) => {
    try {
      const detail = await productsApi.adminDetail(p.id);
      const meta = (detail.metadata ?? {}) as Record<string, unknown>;
      const variants = (detail.variants ?? []) as ServerVariant[];
      const colorNames = [...new Set(variants.map((v) => v.color).filter((c): c is string => Boolean(c)))];
      const knownColors = [...serverColors, ...Object.values(COLORS)];
      const toToman = (value: unknown) => value === null || value === undefined ? "" : String(Math.round(Number(value) / 10) || "");
      const metaImages = Array.isArray(meta.images) ? (meta.images as { fileId?: string | null; url?: string }[]) : [];
      const seo = (meta.seo ?? {}) as { title?: string; slug?: string };
      const loadedDraft: Draft = {
        ...blank(),
        name: String(detail.name ?? ""), brand: String(detail.brand ?? "Kolbe"), category: String(detail.category ?? ""),
        sku: String(meta.editorialSku ?? ""), desc: String(detail.description ?? ""),
        fabric: String(meta.fabric ?? ""), care: String(meta.care ?? ""),
        retail: toToman(detail.cash_price_rial), installment: toToman(detail.installment_price_rial),
        seoTitle: String(seo.title ?? ""), slug: String(seo.slug ?? ""),
        retailOn: detail.retail_enabled !== false, wholesaleOn: detail.wholesale_enabled !== false,
        colors: colorNames.map((name) => knownColors.find((c) => c.name === name) ?? { id: `c-${name}`, name, hex: "#8A6A4F" }),
        sizes: [...new Set(variants.map((v) => v.size).filter((s): s is string => Boolean(s)))],
        images: metaImages.map((image) => ({ fileId: image.fileId ?? null, url: String(image.url ?? "") })).filter((image) => image.url),
        videoFileId: (meta.videoFileId as string | null) ?? null,
        cutout: (meta.cutout as Cutout | null) ?? { status: "none" },
        typeCode: String(detail.product_type_code ?? ""), specs: (detail.specifications ?? {}) as Record<string, unknown>,
        gender: (detail.gender as Draft["gender"]) ?? "unisex",
        seasons: Array.isArray(detail.seasons) ? (detail.seasons as string[]) : [],
        vibes: Array.isArray(detail.vibes) ? (detail.vibes as string[]) : [],
        productTypeId: String(detail.product_type_id ?? ""), genderCode: String(detail.gender_code ?? ""),
        installmentPolicy: (detail.installment_policy as InstallmentPolicy) ?? "enabled",
        wholesaleMoq: detail.wholesale_moq === null || detail.wholesale_moq === undefined ? "" : String(detail.wholesale_moq),
      };
      loadedDraft.images = await Promise.all(loadedDraft.images.map(async (image) => image.fileId ? {
        ...image, url: `/api/v1/product-media/${image.fileId}`, previewUrl: await authBlobUrl(`/files/${image.fileId}`),
      } : image));
      if (loadedDraft.videoFileId) loadedDraft.video = await authBlobUrl(`/files/${loadedDraft.videoFileId}`);
      const templates = await seriesTemplatesApi.list(p.id);
      const recipes = await Promise.all(templates.items.map((t) => seriesTemplatesApi.detail(String(t.id))));
      loadedDraft.series = recipes.map((t, index) => ({
        id: String(templates.items[index]!.id), name: t.name,
        composition: Object.fromEntries(t.items.map((i) => [i.size_label ?? "", i.quantity_per_series])),
        pieces: t.pairsPerSeries, moqSeries: t.moqSeries, pricePerSeries: Number(t.pricePerSeriesRial ?? 0) / 10,
        available: t.active, colorIds: [loadedDraft.colors.find((c) => c.name === t.items[0]?.color_label)?.id ?? ""],
        pricingMode: t.pricingMode === "component_sum" ? "component_sum" : "series_total",
        componentPrices: Object.fromEntries(t.items.map((i) => [i.size_label ?? "", Number(i.unit_price_rial ?? 0) / 10])),
      }));
      setD(loadedDraft);
      setOpenSnapshot(JSON.stringify(loadedDraft));
      setEditing({ id: p.id, metadata: meta });
      setEditVariants(variants);
      setCellOff({});
      setSec("base");
      setOpen(true);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری محصول از سرور"); }
  };

  const refreshEditVariants = async () => {
    if (!editing) return;
    try {
      const detail = await productsApi.adminDetail(editing.id);
      setEditVariants((detail.variants ?? []) as ServerVariant[]);
    } catch { /* keep the last snapshot */ }
  };

  /** Matrix cell action in edit mode: create / enable / disable a real variant. */
  const toggleEditCell = async (color: string, size: string) => {
    if (!editing) return;
    const hit = editVariants.find((v) => (v.color ?? "") === color && (v.size ?? "") === size);
    try {
      if (!hit) {
        const created = await productsApi.createVariant(editing.id, { color, size });
        flash(`واریانت ${color}/${size} با SKU ${created.sku} ساخته شد`);
      } else {
        await productsApi.updateVariant(editing.id, hit.id, { active: !hit.active });
        flash(hit.active ? `واریانت ${hit.sku} غیرفعال شد` : `واریانت ${hit.sku} فعال شد`);
      }
      await refreshEditVariants();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر واریانت"); }
  };

  /** PATCHes the shared form back to the server (Req 38-39) — one studio, two modes. */
  const saveEdit = async () => {
    if (!editing) return;
    try {
      const metadata = { ...editing.metadata };
      // Legacy reference prices are neither pricing truth nor catalog metadata.
      delete metadata.compareAtRial;
      Object.assign(metadata, {
        images: d.images.map((image) => ({ fileId: image.fileId, url: image.url })),
        videoFileId: d.videoFileId ?? null,
        fabric: d.fabric.trim(), care: d.care.trim(),
        seo: { title: d.seoTitle.trim() || d.name.trim(), slug: d.slug.trim() },
        editorialSku: d.sku.trim() || null,
        cutout: d.cutout && d.cutout.status !== "none" ? d.cutout : null,
      });
      await productsApi.update(editing.id, {
        name: d.name.trim(), brand: d.brand.trim(), category: d.category.trim(), description: d.desc,
        metadata,
        gender: d.gender, seasons: d.seasons, vibes: d.vibes,
        ...(d.genderCode ? { genderCode: d.genderCode } : {}),
        productTypeId: d.productTypeId || null,
        retailEnabled: d.retailOn, wholesaleEnabled: d.wholesaleOn,
        wholesaleSeries: productSeriesPayload(d.series, d.colors),
        wholesaleMoq: d.wholesaleMoq ? Number(d.wholesaleMoq) : null,
        specifications: d.specs,
      });
      flash(`«${d.name}» ذخیره شد`);
      setOpen(false); setEditing(null); setD(blank());
      await reload();
      onExit?.();
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره تغییرات"); }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [structureTypes, taxonomyList] = await Promise.all([
          productStructureApi.types().then(normalizeProductTypes).catch(() => [] as StructureProductType[]),
          productStructureApi.taxonomies().then(normalizeTaxonomies).catch(() => [] as Taxonomy[]),
        ]);
        if (!active) return;
        setProductTypes(structureTypes.filter((type) => type.active));
        setTaxonomies(taxonomyList.filter((item) => item.active));
      } catch { /* structure endpoints unreachable — the editor keeps working without them */ }
    })();
    return () => { active = false; };
  }, []);
  const selectedType = types.find((t) => t.code === d.typeCode);
  /** One list of type options regardless of which structure endpoint responded first. */
  const typeOptions: { id: string; code: string; name: string; sizeCodes: string[] }[] = (types.length
    ? types.map((t) => ({ id: t.id, code: t.code, name: t.name, sizeCodes: t.sizes.filter((size) => size.active !== false).map((size) => size.code) }))
    : productTypes.map((t) => ({ id: t.id, code: t.code, name: t.name, sizeCodes: t.sizes.filter((size) => size.active !== false).map((size) => size.code) })));
  const typedSizeCodes = d.productTypeId ? (typeOptions.find((t) => t.id === d.productTypeId)?.sizeCodes ?? []) : [];
  /** §8-§9 (corrective): with a configured category profile the CATEGORY is the size source;
   *  the legacy type chain only applies to historical products without a profile. */
  const sizeOptions = catSchema?.configured && catSchema.allowedSizes.length
    ? catSchema.allowedSizes
    : selectedType?.sizes.length
    ? selectedType.sizes.map((size) => size.code)
    : typedSizeCodes.length ? typedSizeCodes
    : seriesSizesFor(d.category);
  /** Gender vocabulary bridge: adaptive form stores `gender` (men/…), taxonomy stores `genderCode` (male/…). */
  const genderTaxonomies = taxonomies.filter((t) => t.kind === "gender");
  const seasonTaxonomies = taxonomies.filter((t) => t.kind === "season");
  const FALLBACK_GENDER: { code: string; label: string; gender: Draft["gender"] }[] = [
    { code: "unisex", label: "یونیسکس", gender: "unisex" }, { code: "male", label: "مردانه", gender: "men" },
    { code: "female", label: "زنانه", gender: "women" }, { code: "kids", label: "بچگانه", gender: "kids" },
  ];
  const TAXONOMY_TO_GENDER: Record<string, Draft["gender"]> = { male: "men", female: "women", unisex: "unisex", kids: "kids" };
  const GENDER_TO_TAXONOMY: Record<string, string> = { men: "male", women: "female", unisex: "unisex", kids: "kids" };
  const currentGenderCode = d.genderCode || GENDER_TO_TAXONOMY[d.gender] || "";
  const FALLBACK_SEASONS: { code: string; label: string }[] = [
    { code: "spring", label: "بهار" }, { code: "summer", label: "تابستان" }, { code: "autumn", label: "پاییز" },
    { code: "winter", label: "زمستان" }, { code: "all-season", label: "چهارفصل" },
  ];
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = normalizeWarehouses(await inventoryApi.warehouses());
        if (!active) return;
        setWarehouses(list);
      } catch { if (active) setWarehouses([]); }
    })();
    return () => { active = false; };
  }, []);
  const imgRef = useRef<HTMLInputElement>(null);
  const vidRef = useRef<HTMLInputElement>(null);
  // Server rows are not guaranteed to carry every optional collection; the studio must render
  // whatever the catalogue returns instead of crashing the module.
  const cats = Array.from(new Set(products.map((p) => p.category).filter(Boolean)));
  // Persisted palette first (Req 30): server colors survive refresh; demo palette fills in locally.
  const palette = Array.from(new Map([
    ...serverColors,
    ...Object.values(COLORS),
    ...products.flatMap((p) => p.colors ?? []),
  ].filter((color) => Boolean(color?.id)).map((color) => [color.name, color])).values());
  // §33/§36 (corrective): a freshly defined product is a DRAFT; the public catalogue (store hydration)
  // only carries published rows, so without this merge the product vanished from «تعریف محصول» right
  // after save — no edit, no specs, no publish switch. Unpublished kolbe rows come from the admin read model.
  const merged = [...serverDrafts.filter((dr) => !products.some((p) => p.id === dr.id)), ...products];
  const list = merged.filter((p) => !q.trim() || (p.name ?? "").includes(q.trim()) || (p.sku ?? "").includes(q.trim()));
  const categoryDriven = !!catSchema?.configured; // §8: category profile overrides the legacy type system
  // §10 (final gate): required spec fields of the CATEGORY schema must be filled before publish —
  // each missing field produces a field-specific Persian issue that links back to its section.
  const missingCategorySpecs = categoryDriven
    ? (catSchema?.specFields ?? []).filter((field) => {
        if (!field.required) return false;
        const value = d.specs[field.code];
        return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      })
    : [];
  // §7 (corrective): Product Type is NOT required in the new flow — category drives the
  // schema when a profile exists, and its absence never blocks a definition.
  /** §30: every completion issue knows which section fixes it (review-step deep links). */
  const issueItems = [
    !d.name.trim() && { label: "نام محصول", sec: "base" },
    !d.colors.length && { label: "دست‌کم یک رنگ", sec: "variant" },
    !d.sizes.length && { label: "سایزها", sec: "variant" },
    !d.retailOn && !d.wholesaleOn && { label: "یک کانال فروش", sec: "price" },
    d.retailOn && !(Number(d.retail) > 0) && { label: "قیمت خرده", sec: "price" },
    d.retailOn && d.installment && !(Number(d.installment) > 0) && { label: "قیمت چهارقسطه معتبر", sec: "price" },
    d.wholesaleOn && !seriesComplete(d.series) && { label: "سری‌های عمده (قیمت، حداقل و رنگ)", sec: "series" },
    !d.images.length && { label: "دست‌کم یک تصویر", sec: "media" },
    ...missingCategorySpecs.map((field) => ({ label: `مشخصه «${field.label}» الزامی است`, sec: "specs" })),
    ...missingRequiredSpecs(selectedType, d.specs).map((label) => ({ label: `مشخصه «${label}»`, sec: "base" })),
  ].filter(Boolean) as { label: string; sec: string }[];
  const issues = issueItems.map((item) => item.label);
  /** §8: Save Draft ≠ Publish. A Draft only has to be STRUCTURALLY valid — identity and
   *  category are mandatory, everything else may be completed later (§9). */
  const draftBlockers = [
    !d.name.trim() ? "نام محصول" : null,
    !d.category.trim() ? "دسته‌بندی" : null,
  ].filter(Boolean) as string[];
  /** §39: one idempotency key per create session — a retried save reuses the same identity. */
  const [createIdemKey, setCreateIdemKey] = useState(() => `create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  /** §3/§6: open the canonical studio form for a NEW product — the only create entry point. */
  const openCreate = () => {
    const fresh = blank();
    automaticSizes.current = fresh.sizes;
    setD(fresh);
    setOpenSnapshot(JSON.stringify(fresh));
    setEditing(null);
    setEditVariants([]);
    setCellOff({});
    setSec("base");
    setOpen(true);
  };

  /** §3 (Prompt-1 correction): when the caller owns the canonical product list, the studio
   *  mounts directly into the NEW PRODUCT form — «افزودن محصول» never lands on an
   *  intermediate/parallel product list that would need a second click. */
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!embedded || resumeProductId || open || autoOpened.current) return;
    autoOpened.current = true;
    openCreate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, resumeProductId]);

  /** §6: [انصراف] / «بازگشت به فهرست» — always asks first when edits are unsaved (§37). */
  const closeStudio = () => {
    if (JSON.stringify(d) !== openSnapshot) { setConfirmLeave(true); return; }
    setOpen(false); setEditing(null); setD(blank());
    onExit?.();
  };

  /** §9/§13: reopening a Draft loads the SAME canonical studio with all data restored. */
  useEffect(() => {
    if (!resumeProductId) return;
    void openEdit({ id: resumeProductId } as unknown as Product)
      .finally(() => onResumeHandled?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeProductId]);

  /** Uploads a product image; the persisted value is the server file id, the preview stays local. */
  const uploadImage = async (file: File): Promise<DraftImage> => {
    if (isDemo) return { fileId: null, url: (await fileToUrl(file)).url };
    const uploaded = await filesApi.upload(file);
    return { fileId: uploaded.id, url: `/api/v1/product-media/${uploaded.id}`, previewUrl: URL.createObjectURL(file) };
  };
  const uploadVideo = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) { flash("حجم ویدیو باید کمتر از ۵۰ مگابایت باشد"); return; }
    if (isDemo) { setD((prev) => ({ ...prev, video: URL.createObjectURL(file) })); flash("ویدیو فقط در حالت demo محلی است"); return; }
    try {
      setMediaBusy(true);
      const uploaded = await filesApi.upload(file);
      setD((prev) => ({ ...prev, video: URL.createObjectURL(file), videoFileId: uploaded.id }));
      flash("ویدیوی محصول روی سرور ذخیره شد");
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در بارگذاری ویدیو"); }
    finally { setMediaBusy(false); }
  };

  /** §6/§11: ONE canonical create path, two canonical actions.
   *  `draft`    → [ذخیره پیش‌نویس] — lenient validation, no stock, product stays پیش‌نویس.
   *  `continue` → [ذخیره و ادامه]   — full catalog validation, then the WMS handoff. */
  const save = async (intent: "draft" | "continue" = "continue") => {
    if (intent === "continue" && issues.length) { flash(`برای ادامه تکمیل کنید: ${issues.join("، ")}`); return; }
    if (intent === "draft" && draftBlockers.length) { flash(`برای ذخیره پیش‌نویس لازم است: ${draftBlockers.join("، ")}`); return; }
    if (isDemo) {
      const offered = d.series.filter((s) => s.available);
      const p: Product = {
        status: "published", id: `p${Date.now()}`, sku: d.sku.trim() || nextSku(products, KOLBE.id, d.category), brand: d.brand, name: d.name.trim(),
        supplier: KOLBE.name, supplierId: KOLBE.id, category: d.category, retailPrice: d.retailOn ? Number(d.retail) : 0,
        installmentPrice: d.retailOn ? Number(d.installment || d.retail) : 0,
        wholesaleFrom: d.wholesaleOn && offered.length ? Math.min(...offered.map((s) => s.pricePerSeries)) : 0, rating: 0, reviews: 0,
        colors: d.colors, images: d.images.map((image) => image.url), video: d.video || undefined, cutout: d.cutout,
        series: d.wholesaleOn ? d.series : [], seriesCount: d.wholesaleOn ? d.series.length : 0,
        moq: d.wholesaleOn && offered.length ? Math.min(...offered.map((s) => s.moqSeries)) : 1,
        stock: 0, // §4 (corrective): product definition never carries stock — WMS owns it.
        fabric: d.fabric || "—", desc: d.desc || "توضیحات این محصول در حال تکمیل است.",
      };
      addProduct(p); setOpen(false); setD(blank());
      flash(`«${p.name}» منتشر شد (demo)${d.cutout.status === "ready" ? " و به استایل‌بیلدر اضافه شد" : ""}`);
      return;
    }
    try {
      // ONE canonical product-create contract: prices in rial, real colors×sizes variants (server SKUs),
      // extra schema-less fields in `metadata`.
      const payload = buildProductCreatePayload({
        name: d.name, brand: d.brand, category: d.category, description: d.desc,
        editorialSku: d.sku, retailOn: d.retailOn, wholesaleOn: d.wholesaleOn,
        cashToman: d.retail, installmentToman: d.installment,
        colors: d.colors.map((color) => ({ name: color.name })), sizes: d.sizes,
        images: d.images, videoFileId: d.videoFileId,
        fabric: d.fabric, care: d.care, seoTitle: d.seoTitle, slug: d.slug,
        productTypeId: d.productTypeId || undefined,
        genderCode: d.genderCode || undefined,
        seasons: d.seasons.length ? d.seasons : undefined,
        installmentPolicy: d.installmentPolicy,
        wholesaleMoq: d.wholesaleMoq || undefined,
        variantWeights: d.variantWeights,
        cutout: d.cutout,
        series: d.series.map((series) => ({
          name: series.name, pieces: series.pieces, moqSeries: series.moqSeries,
          pricePerSeries: series.pricePerSeries, available: series.available, colorIds: series.colorIds,
        })),
      });
      // Req 26/32: a switched-off matrix cell means the variant must NOT exist at all —
      // filter it out of the canonical payload instead of creating it with zero stock.
      const enabledVariants = payload.variants.filter((variant) =>
        !cellOff[variantKey((variant as { color?: string | null }).color ?? null, (variant as { size?: string | null }).size ?? null)]);
      // §8: a Draft may legitimately have no variant yet; Save & Continue needs at least one.
      if (intent === "continue" && !enabledVariants.length) { flash("دست‌کم یک خانه فعال در ماتریس رنگ×سایز لازم است."); return; }
      // Adaptive form data (Req 325-326): the server validates specs against the type template.
      // §10: category-driven specs ALWAYS travel with the create payload (the server validates
      // required attributes of the category profile against exactly this object).
      const adaptivePayload = { ...payload, saveIntent: intent, wholesalePriceRial: d.wholesaleOn && d.series.length ? rialFromToman(Math.max(1, Math.floor(Math.min(...d.series.map((series) => series.pricePerSeries / Math.max(1, series.pieces)))))) : undefined, wholesaleSeries: d.wholesaleOn ? productSeriesPayload(d.series, d.colors) : [], variants: enabledVariants, specifications: d.specs, ...(d.typeCode ? { productTypeCode: d.typeCode } : {}), gender: d.gender, seasons: d.seasons, vibes: d.vibes };
      // §39: the idempotency key makes a double click / retry reuse the SAME product identity.
      const res = readProductCreateResponse(await productsApi.create(adaptivePayload, createIdemKey));
      const skus = productVariantSkus(res);

      // §4/§15: Product Definition = catalog ONLY. No receipt, no movement, no balance
      // mutation here — the product stays «پیش‌نویس» and opening stock is registered only
      // through the audited WMS document in «ورود اولیه کالا».
      setOpen(false); setD(blank());
      await reload();
      if (intent === "draft") {
        // §7: the draft keeps its canonical Product/Variant/Series ids, creates ZERO stock
        // and appears under «محصولات کلبه → پیش‌نویس‌ها».
        flash(`پیش‌نویس «${d.name}» ذخیره شد — ${skus.length.toLocaleString("fa-IR")} واریانت؛ بدون هیچ موجودی فیزیکی`);
        setCreateIdemKey(`create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        onDraftSaved?.(res.id);
        return;
      }
      // §11: continuous handoff — no success page, no «نیازمند راه‌اندازی» queue.
      flash(`«${d.name}» ذخیره شد — ${skus.length.toLocaleString("fa-IR")} واریانت؛ ورود اولیه کالا آماده است`);
      setCreateIdemKey(`create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      // §40: the product is already persisted — if the handoff fails it simply stays a draft.
      onContinueToInventory?.(res.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : (intent === "draft" ? "خطا در ذخیره پیش‌نویس" : "خطا در ذخیره و ادامه"));
    }
  };

  // One unified studio for create AND edit (Req 39). §4 (corrective): NO operational stock
  // step — definition answers «این کالا چیست؟» and WMS answers «کجا و چقدر موجود است؟».
  const secs = [
    ["base", "اطلاعات پایه"], ["variant", "رنگ و سایز"], ["media", "تصویر و ویدیو"], ["cutout", "تصویر استایل‌بیلدر"],
    ["price", "قیمت‌گذاری"], ["series", "سری‌های عمده"],
    // QA2-SPEC-007 (§17.3): specs and size guide are two independent steps.
    ["specs", "مشخصات فنی"], ["sizeguide", "راهنمای سایز"], ["seo", "سئو و کانال‌ها"], ["review", "بازبینی و انتشار"],
  ].filter(([key]) => (d.retailOn || !["price", "cutout"].includes(key!)) && (d.wholesaleOn || key !== "series"));
  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      {/* §3: in embedded mode the caller owns the canonical product list, so the studio renders
          ONLY the form — its own list would be a second, parallel product-creation authority. */}
      {!open && embedded && resumeProductId && (
        <div className="space-y-3">
          <Btn variant="ghost" size="sm" onClick={onExit} icon={<X size={14} />}>بازگشت به فهرست محصولات</Btn>
          <LoadingState label="در حال بارگذاری محصول…" />
        </div>
      )}
      {!open && !embedded && (<>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="min-w-[200px] flex-1"><SearchBox value={q} onChange={setQ} placeholder="جست‌وجوی محصول یا SKU…" /></div>
        <Btn variant="soft" size="sm" onClick={() => setManage(true)}>قالب‌های سری کلبه</Btn>
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={openCreate}>تعریف محصول جدید</Btn>
      </div>
      <Card className="overflow-hidden">
        {/* kv-scroll-x: سایه لبه = نشانه دیداری ستون‌های بریده (ممیزی §2 — ستون ویرایش در ۱۴۴۰) */}
        <div className="kv-scroll kv-scroll-x">
          <table className="kv-table min-w-[920px]">
            <thead><tr><th>محصول</th><th>مالک</th><th>خرده</th><th>عمده از</th><th>موجودی (WMS)</th><th>تخفیف و جشنواره</th><th>سری</th><th>رسانه</th><th>استایل‌بیلدر</th><th>مشخصات</th><th>ویرایش</th><th>انتشار</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><span className="flex items-center gap-2.5"><img src={p.images?.[0] ?? undefined} alt="" className="h-10 w-9 rounded-lg object-cover" /><span><b className="block whitespace-nowrap">{p.name}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{p.sku}</span></span></span></td>
                  <td>{p.supplierId === KOLBE.id ? <span className="rounded-full bg-[#1B2A4A] px-2 py-0.5 text-[10.5px] font-bold text-[#E8D9C3]">کلبه</span> : p.supplier}</td>
                  <td className="tabular-nums font-bold">{p.retailPrice ? fmtMoney(p.retailPrice) : "—"}</td>
                  <td className="tabular-nums">{p.wholesaleFrom ? fmtMoney(p.wholesaleFrom) : "—"}</td>
                  <td>
                    <button onClick={() => setInventoryFor(p)} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-accent)] hover:underline">
                      <Boxes size={13} />موجودی و انبار
                    </button>
                  </td>
                  <td>
                    {isDemo
                      ? <span className="text-[11.5px] text-[var(--kv-muted)]">—</span>
                      : <button onClick={() => setDiscountFor(p)} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-accent)] hover:underline">
                          <BadgePercent size={13} />تخفیف / جشنواره
                        </button>}
                  </td>
                  <td className="tabular-nums">{fmtNum((p.series ?? []).length)}</td>
                  <td className="text-[12px] text-[var(--kv-muted)]">{fmtNum((p.images ?? []).length)} تصویر{p.video ? " · ویدیو" : ""}</td>
                  <td><button onClick={() => setCutFor(p)} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-accent)]"><Sparkles size={13} />{CUT_LABEL[p.cutout?.status ?? "none"]}</button></td>
                  <td>
                    <button onClick={() => setSpecsFor(p)} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-accent)] hover:underline">
                      مشخصات و راهنمای سایز
                    </button>
                  </td>
                  <td>
                    {isDemo
                      ? <span className="text-[11.5px] text-[var(--kv-muted)]">—</span>
                      : <button onClick={() => void openEdit(p)} className="inline-flex items-center gap-1.5 text-[12px] font-bold text-[var(--kv-accent)] hover:underline"><Pencil size={13} />ویرایش</button>}
                  </td>
                  <td><Switch on={p.status === "published"} onToggle={async () => { const next = p.status === "published" ? "draft" : "published"; if (!isDemo) { try { await productsApi.status(p.id, next); await reload(); flash(next === "published" ? `${p.name} منتشر شد` : `${p.name} از فروش خارج شد`); return; } catch (e) { flash(e instanceof Error ? e.message : "خطا در تغییر وضعیت"); return; } } setStatus(p.id, next); flash(p.status === "published" ? `${p.name} از فروش خارج شد (demo)` : `${p.name} منتشر شد (demo)`); }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      </>)}

      {open && (
      <div>
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <Btn variant="soft" size="sm" onClick={closeStudio} icon={<X size={14} />}>بازگشت به فهرست</Btn>
          <h2 className="text-[17px] font-extrabold">{editing ? `ویرایش محصول · ${d.name || "…"}` : "تعریف محصول جدید"}</h2>
          <span className="text-[11.5px] text-[var(--kv-muted)]">{editing ? "داده‌ها از سرور بارگذاری شده‌اند؛ تغییرات با ذخیره روی همان محصول اعمال می‌شود." : "تمام بخش‌های محصول را در همین صفحه تکمیل کنید؛ با «ذخیره پیش‌نویس» هر زمان ادامه دهید یا با «ذخیره و ادامه» موجودی اولیه را ثبت کنید."}</span>
        </div>
        <Card className="p-4 md:p-6">
        <div className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
          <nav className="space-y-0.5" aria-label="بخش‌های تعریف محصول">{secs.map(([v, l], i) => (
            <button key={v} onClick={() => setSec(v)} aria-current={sec === v ? "step" : undefined} className={cn("flex min-h-10 w-full items-center gap-2 rounded-[10px] px-3 py-2 text-right text-[12.5px] font-semibold", sec === v ? "bg-[var(--kv-surface-2)]" : "text-[var(--kv-muted)]")}>
              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold", sec === v ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "bg-[var(--kv-surface-2)]")}>{(i + 1).toLocaleString("fa-IR")}</span>{l}
            </button>
          ))}</nav>
          <div className="min-w-0 space-y-4">
            {sec === "base" && <>
              <Field label="نوع فروش" hint="تنظیمات محصول بر اساس بازار انتخاب‌شده نمایش داده می‌شود؛ موجودی در انبار مدیریت می‌شود.">
                <Segmented options={[{ v: "retail", label: "فقط خرده" }, { v: "wholesale", label: "فقط عمده" }, { v: "both", label: "خرده + عمده" }]}
                  value={d.retailOn ? (d.wholesaleOn ? "both" : "retail") : "wholesale"}
                  onChange={(mode) => setD((cur) => ({ ...cur, retailOn: mode !== "wholesale", wholesaleOn: mode !== "retail" }))} />
              </Field>
              <Field label="نام محصول"><Input value={d.name} onChange={(v) => setD({ ...d, name: v })} placeholder="مثلاً کت پشمی دو‌دکمه" /></Field>
              <div className="grid gap-3 sm:grid-cols-3"><Field label="برند"><Input value={d.brand} onChange={(v) => setD({ ...d, brand: v })} /></Field><Field label="دسته" hint={!isDemo && categories.length ? "سلسله‌مراتبی از سرور (زیر‌دسته‌ها با — تورفتگی)" : undefined}>
                  <div className="space-y-1.5">
                    {!isDemo && categories.length > 6 && (
                      <Input value={catQuery} onChange={setCatQuery} placeholder="جست‌وجوی دسته…" />
                    )}
                    <Select
                      options={!isDemo && categories.length
                        ? categoryOptionLabels.filter((label) => {
                            if (!catQuery.trim()) return true;
                            if (label === NEW_CATEGORY_OPTION) return true;
                            if (label.replace(/^(?:— )+/, "") === d.category) return true;
                            return label.includes(catQuery.trim());
                          })
                        : [...new Set([...cats, "شلوار", "کفش", "اکسسوری"])]}
                      value={!isDemo && categories.length ? (categoryOptionLabels.find((label) => label.replace(/^(?:— )+/, "") === d.category) ?? d.category) : d.category}
                      onChange={(v) => {
                        if (v === NEW_CATEGORY_OPTION) { setNewCategory({ open: true, name: "", parentId: "" }); return; }
                        const name = v.replace(/^(?:— )+/, "");
                        setD({ ...d, category: name });
                      }} />
                  </div>
                </Field><Field label="SKU"><Input value={d.sku} onChange={(v) => setD({ ...d, sku: v })} placeholder="خودکار · در صورت نیاز قابل تغییر" /></Field></div>
              {newCategory.open && (
                <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <p className="mb-2 text-[12.5px] font-bold">ساخت دسته جدید (در همان سیستم دسته‌بندی سرور)</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="نام دسته"><Input value={newCategory.name} onChange={(v) => setNewCategory({ ...newCategory, name: v })} placeholder="مثلاً کت و ژاکت" /></Field>
                    <Field label="دسته والد (اختیاری)">
                      <Select options={["— بدون والد —", ...categories.map((c) => c.name)]}
                        value={categories.find((c) => c.id === newCategory.parentId)?.name ?? "— بدون والد —"}
                        onChange={(label) => setNewCategory({ ...newCategory, parentId: categories.find((c) => c.name === label)?.id ?? "" })} />
                    </Field>
                    <Btn variant="accent" size="sm" disabled={!newCategory.name.trim()} onClick={() => void createCategory()} icon={<Plus size={14} />}>ساخت و انتخاب</Btn>
                    <Btn variant="ghost" size="sm" onClick={() => setNewCategory({ open: false, name: "", parentId: "" })}>انصراف</Btn>
                  </div>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-3">
                {categoryDriven && (
                  <Field label="قالب دسته‌بندی" hint={`سایزهای مجاز و مشخصات از پروفایل دسته‌بندی «${d.category}» می‌آیند${catSchema?.sizeGuide ? ` · راهنمای سایز: ${catSchema.sizeGuide.name}` : ""}`}>
                    <div className="flex h-11 items-center rounded-[11px] border border-emerald-200 bg-emerald-50 px-3 text-[12px] font-bold text-emerald-800">
                      دسته‌بندی منبع ساختار است{catSchema?.allowedSizes.length ? ` — سایزها: ${catSchema.allowedSizes.join("، ")}` : ""}
                    </div>
                  </Field>
                )}
                {/* §7 (corrective): Product Type is hidden from the NEW flow; it remains only
                    when editing a legacy product that already carries one (historical data). */}
                {!categoryDriven && !isDemo && d.category.trim() !== "" && (
                  <Field label="ساختار دسته‌بندی" hint="پروفایل دسته از «کالاها ← پروفایل دسته‌بندی» تعریف می‌شود">
                    <div className="flex h-11 items-center rounded-[11px] border border-amber-300 bg-amber-50 px-3 text-[12px] font-bold text-amber-800">
                      برای این دسته هنوز ساختار مشخصات و سایزبندی تعریف نشده است.
                    </div>
                  </Field>
                )}
                <Field label="جنسیت / مخاطب">
                  <Select
                    options={genderTaxonomies.length ? ["نامشخص", ...genderTaxonomies.map((t) => t.label)] : FALLBACK_GENDER.map((g) => g.label)}
                    value={genderTaxonomies.length
                      ? (genderTaxonomies.find((t) => t.code === currentGenderCode)?.label ?? "نامشخص")
                      : (FALLBACK_GENDER.find((g) => g.code === currentGenderCode)?.label ?? "یونیسکس")}
                    onChange={(label) => {
                      if (genderTaxonomies.length) {
                        const t = genderTaxonomies.find((x) => x.label === label);
                        setD((cur) => ({ ...cur, genderCode: t?.code ?? "", gender: t ? (TAXONOMY_TO_GENDER[t.code] ?? cur.gender) : cur.gender }));
                      } else {
                        const g = FALLBACK_GENDER.find((x) => x.label === label);
                        setD((cur) => ({ ...cur, genderCode: g?.code ?? "unisex", gender: g?.gender ?? "unisex" }));
                      }
                    }} />
                </Field>
                <Field label="فصل‌ها (چندانتخابی)">
                  <div className="flex flex-wrap gap-1.5">
                    {(seasonTaxonomies.length
                      ? seasonTaxonomies.map((t) => ({ code: t.code, label: t.label, key: t.id }))
                      : FALLBACK_SEASONS.map((sn) => ({ code: sn.code, label: sn.label, key: sn.code }))).map((season) => {
                      const on = d.seasons.includes(season.code);
                      return (
                        <button key={season.key} type="button" aria-pressed={on} onClick={() => setD({ ...d, seasons: on ? d.seasons.filter((x) => x !== season.code) : [...d.seasons, season.code] })} className={cn("min-h-10 rounded-full border px-3 text-[12px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>{season.label}</button>
                      );
                    })}
                    {seasonTaxonomies.length === 0 && taxonomies.length > 0 && <span className="text-[12px] text-[var(--kv-muted)]">از «ساختار محصولات» فصل بسازید.</span>}
                  </div>
                </Field>
                {!isDemo && d.retailOn && <div className="sm:col-span-3"><Field label="وایب‌ها (چندانتخابی مدیریت‌شده)" hint="جست‌وجو، انتخاب/حذف و ساخت وایب جدید — همه روی سرور">
                  <div className="space-y-2">
                    {d.vibes.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {d.vibes.map((slug) => {
                          const vibe = vibeOptions.find((v) => v.slug === slug);
                          return (
                            <span key={slug} className="flex items-center gap-1 rounded-full border border-[var(--kv-accent)] bg-[var(--kv-accent)]/10 px-2.5 py-1 text-[11.5px] font-semibold">
                              {vibe?.name ?? slug}
                              <button type="button" aria-label={`حذف ${vibe?.name ?? slug}`} onClick={() => setD({ ...d, vibes: d.vibes.filter((x) => x !== slug) })}><X size={11} /></button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <Input value={vibeQuery} onChange={setVibeQuery} placeholder="جست‌وجوی وایب…" />
                    <div className="flex flex-wrap gap-1.5">
                      {vibeOptions
                        .filter((v) => !d.vibes.includes(v.slug) && (!vibeQuery.trim() || v.name.includes(vibeQuery.trim()) || v.slug.includes(vibeQuery.trim())))
                        .slice(0, 24)
                        .map((v) => (
                          <button key={v.slug} type="button" onClick={() => d.vibes.length < 8 ? setD({ ...d, vibes: [...d.vibes, v.slug] }) : flash("حداکثر ۸ وایب برای هر محصول")} className="rounded-full border border-[var(--kv-line)] px-2.5 py-1 text-[11.5px]">{v.name}</button>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input className="max-w-[220px]" value={newVibe} onChange={setNewVibe} placeholder="وایب جدید…" />
                      <Btn variant="soft" size="sm" disabled={!newVibe.trim()} onClick={() => void createVibe()} icon={<Plus size={13} />}>ساخت وایب</Btn>
                    </div>
                  </div>
                </Field></div>}
                {isDemo && d.retailOn && vibeOptions.length > 0 && <div className="sm:col-span-3"><Field label="وایب‌ها"><div className="flex flex-wrap gap-1.5">{vibeOptions.map((v) => <button key={v.slug} type="button" aria-pressed={d.vibes.includes(v.slug)} onClick={() => setD({ ...d, vibes: d.vibes.includes(v.slug) ? d.vibes.filter((x) => x !== v.slug) : [...d.vibes, v.slug] })} className={cn("rounded-full border px-2.5 py-1 text-[11.5px]", d.vibes.includes(v.slug) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)]")}>{v.name}</button>)}</div></Field></div>}
              </div>
              {selectedType && <AdaptiveSpecForm type={selectedType} values={d.specs} onChange={(specs) => setD({ ...d, specs })} />}
              <Field label="توضیحات"><Textarea rows={4} value={d.desc} onChange={(v) => setD({ ...d, desc: v })} /></Field>
              {/* Req 45: fabric/care now live in the «مشخصات فنی» section. */}
              <p className="text-[11.5px] text-[var(--kv-muted)]">جنس پارچه و نگهداری به بخش «مشخصات فنی و راهنمای سایز» منتقل شده‌اند.</p>
            </>}
            {sec === "variant" && <>
              <div>
                <p className="mb-2 text-[13px] font-semibold">رنگ‌های محصول</p>
                {/* هویت رنگ واریانت = نام رنگ؛ تطبیق بر اساس نام هم انجام می‌شود تا «مشکی» پیش‌فرض و «مشکی» سروری دو انتخاب موازی (و واریانت تکراری هم‌نام) نسازند. */}
                <div className="flex flex-wrap gap-2">{palette.map((c) => { const on = d.colors.some((x) => x.id === c.id || x.name === c.name); return (
                  <button key={c.id} aria-pressed={on} onClick={() => setD({ ...d, colors: on ? d.colors.filter((x) => x.id !== c.id && x.name !== c.name) : [...d.colors.filter((x) => x.name !== c.name), c], series: d.series.map((s) => ({ ...s, colorIds: on ? s.colorIds?.filter((x) => x !== c.id) : s.colorIds })) })} className={cn("flex min-h-10 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}><span className="h-4 w-4 rounded-full border border-black/15" style={{ background: c.hex }} />{c.name}</button>
                ); })}</div>
              </div>
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-2 text-[12.5px] font-bold">تعریف رنگ جدید</p>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="نام رنگ"><Input value={newColor.name} onChange={(v) => setNewColor({ ...newColor, name: v })} placeholder="مثلاً قهوه‌ای کاراملی" /></Field>
                  <label className="flex flex-col gap-2 text-[13px] font-semibold text-[var(--kv-ink-2)]">کد رنگ<span className="flex items-center gap-2"><input type="color" value={newColor.hex} onChange={(e) => setNewColor({ ...newColor, hex: e.target.value })} className="h-11 w-14 cursor-pointer rounded-[10px] border border-[var(--kv-line)] bg-transparent" aria-label="انتخاب رنگ" /><span className="text-[12px] tabular-nums" dir="ltr">{newColor.hex.toUpperCase()}</span></span></label>
                  <Btn variant="soft" disabled={!newColor.name.trim() || palette.some((c) => c.name === newColor.name.trim())} onClick={() => void createColor()} icon={<Plus size={14} />}>{isDemo ? "افزودن (demo)" : "ذخیره در سرور و انتخاب"}</Btn>
                </div>
              </div>
              <Field label={catSchema?.configured
                ? `سایزهای مجاز دسته «${d.category}» (از پروفایل دسته‌بندی)`
                : selectedType || typedSizeCodes.length ? `سایزهای ${selectedType?.name ?? typeOptions.find((t) => t.id === d.productTypeId)?.name ?? "محصول"}` : "سایزهای خرده"}>
                {sizeOptions.length === 0
                  ? <p className="text-[12.5px] text-[var(--kv-muted)]">{catSchema?.configured ? "برای این دسته هنوز سایزی در پروفایل ثبت نشده؛ از پایین همین بخش اضافه کنید." : "سایزی ثبت نشده؛ از پایین همین بخش اضافه کنید."}</p>
                  : <div className="flex flex-wrap gap-2">{sizeOptions.map((s) => <button key={s} aria-pressed={d.sizes.includes(s)} onClick={() => setD({ ...d, sizes: d.sizes.includes(s) ? d.sizes.filter((x) => x !== s) : [...d.sizes, s] })} className={cn("min-h-10 min-w-[46px] rounded-[10px] border px-3 text-[12.5px] font-bold", d.sizes.includes(s) ? "border-[var(--kv-ink)] bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "border-[var(--kv-line)]")}>{s}</button>)}</div>}
              </Field>
              {!isDemo && (
                <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  {/* §8 (corrective): size creation is category-driven — never blocked on «نوع محصول». */}
                  <p className="mb-2 text-[12.5px] font-bold">افزودن سایز جدید</p>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="کد سایز" hint="مثلاً XXL یا ۴۴">
                      <Input value={newSize} onChange={setNewSize} placeholder="XXL" />
                    </Field>
                    <Btn variant="soft" size="sm" disabled={!newSize.trim()} onClick={() => void createSize()} icon={<Plus size={14} />}>
                      {catSchema?.configured ? "افزودن به پروفایل این دسته" : d.productTypeId ? "افزودن به نوع محصول" : "افزودن برای همین محصول"}
                    </Btn>
                  </div>
                  {catSchema?.configured
                    ? <p className="mt-1.5 text-[11px] text-[var(--kv-muted)]">سایز به پروفایل دسته «{d.category}» اضافه می‌شود و برای همه محصولات این دسته قابل استفاده خواهد بود.</p>
                    : !d.productTypeId && <p className="mt-1.5 text-[11px] text-[var(--kv-muted)]">این دسته هنوز پروفایل سایزبندی ندارد؛ سایز فقط برای همین محصول ثبت می‌شود.</p>}
                </div>
              )}
              {/* Req 26/32: the real Color×Size matrix. «—» = واریانت وجود ندارد؛ صفر = واریانت هست ولی موجودی صفر. */}
              {d.colors.length > 0 && d.sizes.length > 0 && (
                <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <p className="mb-1 text-[12.5px] font-bold">ماتریس واریانت رنگ × سایز</p>
                  <p className="mb-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                    {editing
                      ? "هر خانه وضعیت واقعی واریانت روی سرور است: کلیک = باز شدن ویرایشگر واریانت. «—» یعنی واریانت اصلاً وجود ندارد."
                      : "خانه‌های خاموش هنگام ذخیره ساخته نمی‌شوند (واریانت وجود نخواهد داشت)؛ این با واریانتِ ساخته‌شده با موجودی صفر فرق دارد."}
                  </p>
                  {editing && (
                    /* Req 29 (user decision): inventory-domain tabs inside the Product Studio. */
                    <div className="mb-2">
                      <Segmented
                        options={[{ v: "retail" as const, label: "موجودی خرده‌فروشی" }, { v: "wholesale" as const, label: "موجودی عمده‌فروشی" }]}
                        value={invDomain} onChange={setInvDomain} />
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="kv-table min-w-[420px] text-xs">
                      <thead><tr><th>رنگ \ سایز</th>{d.sizes.map((s) => <th key={s}>{s}</th>)}</tr></thead>
                      <tbody>
                        {d.colors.map((c) => (
                          <tr key={c.id}>
                            <td className="font-bold"><span className="flex items-center gap-1.5"><span className="h-3.5 w-3.5 rounded-full border border-black/15" style={{ background: c.hex }} />{c.name}</span></td>
                            {d.sizes.map((s) => {
                              if (editing) {
                                const hit = editVariants.find((v) => (v.color ?? "") === c.name && (v.size ?? "") === s);
                                const isOpen = cellEditor?.color === c.name && cellEditor?.size === s;
                                return (
                                  <td key={s}>
                                    <button type="button" onClick={() => setCellEditor(isOpen ? null : { color: c.name, size: s })}
                                      className={cn("min-h-9 w-full rounded-[8px] border px-2 py-1 text-[11px] font-bold",
                                        isOpen && "ring-2 ring-[var(--kv-accent)]",
                                        !hit ? "border-dashed border-[var(--kv-line)] text-[var(--kv-muted)]"
                                          : hit.active ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)] opacity-50")}
                                      title={hit ? `${hit.sku} · خرده ${hit.retail_on_hand} · عمده ${hit.wholesale_on_hand}` : "ساخت واریانت"}>
                                      {!hit ? "— (ساخت)" : `${hit.active ? "فعال" : "غیرفعال"} · ${(invDomain === "retail" ? hit.retail_on_hand : hit.wholesale_on_hand).toLocaleString("fa-IR")}${hit.price_override_rial ? " · قیمت ویژه" : ""}`}
                                    </button>
                                  </td>
                                );
                              }
                              const off = cellOff[variantKey(c.name, s)];
                              return (
                                <td key={s}>
                                  <button type="button" aria-pressed={!off}
                                    onClick={() => setCellOff((cur) => ({ ...cur, [variantKey(c.name, s)]: !off }))}
                                    className={cn("min-h-9 w-full rounded-[8px] border px-2 py-1 text-[11px] font-bold",
                                      off ? "border-dashed border-[var(--kv-line)] text-[var(--kv-muted)]" : "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10")}>
                                    {off ? "—" : "ساخته می‌شود"}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {editing && cellEditor && (() => {
                    const hit = editVariants.find((v) => (v.color ?? "") === cellEditor.color && (v.size ?? "") === cellEditor.size) ?? null;
                    return (
                      <VariantAdvancedEditor
                        key={hit?.id ?? `${cellEditor.color}|${cellEditor.size}`}
                        color={cellEditor.color} size={cellEditor.size} variant={hit}
                        onClose={() => setCellEditor(null)}
                        onCreate={() => void toggleEditCell(cellEditor.color, cellEditor.size)}
                        onToggleActive={() => void toggleEditCell(cellEditor.color, cellEditor.size)}
                        onPatch={async (payload) => {
                          if (!hit) return;
                          try {
                            await productsApi.updateVariant(editing.id, hit.id, payload);
                            flash(`واریانت ${hit.sku} به‌روزرسانی شد`);
                            await refreshEditVariants();
                          } catch (e) { flash(e instanceof Error ? e.message : "خطا در ذخیره واریانت"); }
                        }}
                      />
                    );
                  })()}
                </div>
              )}
            </>}
            {sec === "media" && <>
              <div>
                <div className="mb-2 flex items-center justify-between"><p className="text-[13px] font-semibold">تصاویر فروشگاه ({fmtNum(d.images.length)})</p><span className="text-[11.5px] text-[var(--kv-muted)]">اولین تصویر، کاور است · نسبت ۳:۴</span></div>
                <div className="grid grid-cols-4 gap-2">
                  {d.images.map((im, i) => <div key={`${im.fileId ?? im.url}-${i}`} className="group relative overflow-hidden rounded-[10px] border border-[var(--kv-line)]"><img src={im.previewUrl ?? im.url} alt="" className="aspect-[3/4] w-full object-cover" />{i === 0 && <span className="absolute bottom-1 right-1 rounded-full bg-[#1B2A4A]/85 px-2 py-0.5 text-[10px] font-bold text-white">کاور</span>}<span className="absolute right-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white">{im.fileId ? "ذخیره‌شده" : "محلی"}</span><button aria-label="حذف تصویر" onClick={() => setD({ ...d, images: d.images.filter((_, j) => j !== i) })} className="absolute left-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white"><Trash2 size={13} /></button>{i > 0 && <button onClick={() => setD({ ...d, images: [im, ...d.images.filter((_, j) => j !== i)] })} className="absolute bottom-1 left-1 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-bold text-[#1B2A4A]">کاور کن</button>}</div>)}
                  <input ref={imgRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={async (e) => { const files = Array.from(e.target.files ?? []).slice(0, 8); if (!files.length) return; setMediaBusy(true); try { const uploaded: DraftImage[] = []; for (const file of files) uploaded.push(await uploadImage(file)); setD((prev) => ({ ...prev, images: [...prev.images, ...uploaded] })); if (!isDemo) flash(`${uploaded.length.toLocaleString("fa-IR")} تصویر روی سرور ذخیره شد`); } catch (err) { flash(err instanceof Error ? err.message : "خطا در بارگذاری تصویر"); } finally { setMediaBusy(false); } }} />
                  <button onClick={() => imgRef.current?.click()} className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed border-[var(--kv-line-strong)] text-[11.5px] font-semibold text-[var(--kv-muted)] hover:border-[var(--kv-accent)]"><ImageIcon size={18} />افزودن تصویر</button>
                </div>
                {isDemo
                  ? <div className="mt-2 flex gap-1.5 overflow-x-auto kv-no-scrollbar">{[IMG.trenchArch, IMG.trenchHero, IMG.blazerDuo, IMG.shirtRack, IMG.redCoat].map((src) => <button key={src} onClick={() => setD({ ...d, images: [...d.images, { fileId: null, url: src }] })} className="h-12 w-10 shrink-0 overflow-hidden rounded-[7px] opacity-70 hover:opacity-100" aria-label="افزودن تصویر نمونه"><img src={src} alt="" className="h-full w-full object-cover" /></button>)}<span className="self-center text-[11px] text-[var(--kv-muted)]">تصاویر نمونه (demo)</span></div>
                  : <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">هر تصویر همان لحظه روی سرور ذخیره می‌شود و همراه محصول می‌ماند؛ پیش‌نمایش فقط برای نمایش در همین صفحه است.</p>}
                {mediaBusy && <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">در حال بارگذاری روی سرور…</p>}
              </div>
              <div>
                <p className="mb-2 text-[13px] font-semibold">ویدیوی محصول (اختیاری)</p>
                {d.video ? <div className="relative overflow-hidden rounded-[12px] border border-[var(--kv-line)]"><video src={d.video} controls muted className="max-h-64 w-full bg-black" /><button onClick={() => setD({ ...d, video: "" })} className="absolute left-2 top-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white" aria-label="حذف ویدیو"><Trash2 size={14} /></button></div>
                  : <div className="flex flex-wrap gap-2">
                    <input ref={vidRef} type="file" accept="video/mp4" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; await uploadVideo(file); }} />
                    <Btn variant="soft" icon={<Film size={15} />} onClick={() => vidRef.current?.click()}>بارگذاری ویدیو</Btn>
                    <Input className="min-w-[240px] flex-1" value="" onChange={(v) => v.startsWith("http") && setD({ ...d, video: v })} placeholder="یا نشانی ویدیو (https://…mp4)" />
                  </div>}
              </div>
            </>}
            {sec === "cutout" && <CutoutUploader productId="new" value={d.cutout} onChange={(c) => setD((p) => ({ ...p, cutout: c }))} candidates={d.images.map((image) => image.previewUrl ?? image.url)} flash={flash} />}
            {sec === "price" && <>
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                قیمت پایه، اقساط و تخفیف‌های محصول از فضای قیمت‌گذاری اختصاصی و موتور Pricing Resolver خوانده می‌شوند؛ این فرم تعریف، موجودی یا تخفیف سمت کلاینت نمی‌نویسد.
              </p>
              {editing ? (
                <Card className="space-y-3 p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><p className="text-xs text-[var(--kv-muted)]">قیمت پایه خرده · نقدی</p><p className="mt-1 font-bold">{d.retail ? `${fmtNum(Number(d.retail))} تومان` : "—"}</p></div>
                    <div><p className="text-xs text-[var(--kv-muted)]">قیمت چهارقسطه</p><p className="mt-1 font-bold">{d.installment ? `${fmtNum(Number(d.installment))} تومان` : "برابر نقدی"}</p></div>
                    <div className="sm:col-span-2"><p className="text-xs text-[var(--kv-muted)]">سیاست قسط</p><p className="mt-1 font-bold">{INSTALLMENT_POLICY_LABEL[d.installmentPolicy]}</p></div>
                  </div>
                  <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">ویرایش‌های کاتالوگ این فرم نمی‌توانند قیمت جدیدتری را بازنویسی کنند.</p>
                  <Btn variant="accent" icon={<BadgePercent size={14} />} onClick={() => setDiscountFor({ id: editing.id, name: d.name, images: d.images.map((image) => image.url), sku: d.sku } as Product)}>مدیریت قیمت، اقساط و تخفیف‌ها</Btn>
                </Card>
              ) : (
                <>
                  {d.retailOn && <div className="grid gap-3 sm:grid-cols-2"><Field label="قیمت پایه خرده — نقدی (تومان)" hint="مبنای اصلی قیمت تک‌عدد در kolbe.ir"><Input value={d.retail} onChange={(v) => setD({ ...d, retail: v.replace(/\D/g, "") })} /></Field><Field label="قیمت مخصوص چهارقسطه (تومان)" hint="هر قسط از این مبلغ محاسبه می‌شود؛ خالی یعنی برابر قیمت نقدی"><Input value={d.installment} onChange={(v) => setD({ ...d, installment: v.replace(/\D/g, "") })} /></Field></div>}
                  {d.retailOn && Number(d.installment || d.retail) > 0 && <p className="text-[12px] text-[var(--kv-muted)]">هر قسط: {fmtMoney(Math.ceil(Number(d.installment || d.retail) / 4))}</p>}
                  <Field label="سیاست قسط" hint="سرور در تسویه‌حساب همین سیاست را اعمال می‌کند"><Select options={([...INSTALLMENT_POLICIES]).map((p) => INSTALLMENT_POLICY_LABEL[p])} value={INSTALLMENT_POLICY_LABEL[d.installmentPolicy]} onChange={(label) => { const found = ([...INSTALLMENT_POLICIES]).find((p) => INSTALLMENT_POLICY_LABEL[p] === label); if (found) setD({ ...d, installmentPolicy: found }); }} /></Field>
                </>
              )}
            </>}
            {sec === "series" && <>
              {d.wholesaleOn && <Field label="حداقل سفارش عمده (عدد)" hint="سرور در ثبت سفارش عمده همین کف را برای مجموع واریانت‌های این محصول اعمال می‌کند"><Input value={d.wholesaleMoq} onChange={(v) => setD({ ...d, wholesaleMoq: v.replace(/\D/g, "") })} placeholder="مثلاً ۱۲" /></Field>}
              {d.wholesaleOn && <ProductSeriesEditor colors={d.colors} sizes={d.sizes} value={d.series} onChange={(series) => setD({ ...d, series })} />}
            </>}
            {/* §4/§15 (corrective): the «موجودی اولیه» step was removed from Product Definition.
                Opening stock lives ONLY in the canonical «ورود اولیه کالا» WMS document,
                reached through [ذخیره و ادامه] or «ادامه تکمیل محصول» — never from this form.
                Variant weight (catalog data) stays here, next to the matrix result. */}
            {sec === "variant" && !editing && d.colors.length > 0 && d.sizes.length > 0 && (
              <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                <p className="mb-1 text-[12.5px] font-bold">وزن واریانت‌ها (گرم — اختیاری)</p>
                <p className="mb-2 text-[11.5px] text-[var(--kv-muted)]">داده کاتالوگی واریانت است و ربطی به موجودی ندارد؛ موجودی اولیه فقط از «ورود اولیه کالا» و با سند انبار ثبت می‌شود.</p>
                <div className="overflow-x-auto">
                  <table className="kv-table min-w-[420px] text-xs">
                    <thead><tr><th>رنگ</th><th>سایز</th><th>وزن (گرم)</th></tr></thead>
                    <tbody>
                      {variantMatrix(d.colors.map((color) => color.name), d.sizes).filter(({ color, size }) => !cellOff[variantKey(color, size)]).map(({ color, size }) => (
                        <tr key={`${color}-${size}`}>
                          <td>{color}</td><td>{size}</td>
                          <td className="w-[110px]">
                            <Input
                              value={d.variantWeights[variantKey(color, size)] ?? ""}
                              onChange={(value) => setD((current) => ({ ...current, variantWeights: { ...current.variantWeights, [variantKey(color, size)]: value.replace(/\D/g, "") } }))}
                              placeholder="—"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {sec === "specs" && (
              <div className="space-y-4">
                {/* Req 45: fabric/care moved here from basic info — same fields, no data loss. */}
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="جنس پارچه"><Input value={d.fabric} onChange={(v) => setD({ ...d, fabric: v })} /></Field>
                  <Field label="نگهداری"><Input value={d.care} onChange={(v) => setD({ ...d, care: v })} /></Field>
                </div>
                {editing ? (
                  <ProductSpecsEditor key={editing.id} productId={editing.id} flash={flash} section="specs" />
                ) : categoryDriven && (catSchema?.specFields.length ?? 0) > 0 ? (
                  /* §10 (final gate): the CATEGORY schema fields render right here in create mode —
                     required blanks produce a field-specific Persian error and block publish. */
                  <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                    <p className="mb-1 text-[12.5px] font-extrabold">مشخصات فنی دسته «{d.category}»</p>
                    <p className="mb-3 text-[11.5px] text-[var(--kv-muted)]">این فیلدها از پروفایل دسته‌بندی می‌آیند و همراه محصول ذخیره می‌شوند؛ موارد ستاره‌دار الزامی‌اند.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {catSchema!.specFields.map((field) => {
                        const value = d.specs[field.code];
                        const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
                        const setValue = (next: unknown) => setD((cur) => ({ ...cur, specs: { ...cur.specs, [field.code]: next } }));
                        return (
                          <div key={field.code} className={field.type === "textarea" ? "sm:col-span-2" : undefined}>
                            <Field label={`${field.label}${field.required ? " *" : ""}${field.unit ? ` (${field.unit})` : ""}`}>
                              {field.type === "single_select" ? (
                                <Select options={["—", ...field.options.map((o) => o.label)]}
                                  value={field.options.find((o) => o.value === value)?.label ?? "—"}
                                  onChange={(label) => setValue(label === "—" ? null : field.options.find((o) => o.label === label)?.value ?? null)} />
                              ) : field.type === "multi_select" ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {field.options.map((option) => {
                                    const selected = Array.isArray(value) ? (value as string[]) : [];
                                    const on = selected.includes(option.value);
                                    return (
                                      <button key={option.value} type="button" aria-pressed={on}
                                        onClick={() => setValue(on ? selected.filter((v) => v !== option.value) : [...selected, option.value])}
                                        className={cn("min-h-10 rounded-full border px-3 text-[12px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}>{option.label}</button>
                                    );
                                  })}
                                </div>
                              ) : field.type === "textarea" ? (
                                <Textarea rows={3} value={typeof value === "string" ? value : ""} onChange={(v) => setValue(v)} />
                              ) : field.type === "boolean" ? (
                                <Switch on={value === true} onToggle={() => setValue(value !== true)} />
                              ) : field.type === "number" || field.type === "decimal" || field.type === "measurement" ? (
                                <Input value={value === null || value === undefined ? "" : String(value)} onChange={(v) => setValue(v === "" ? null : Number(v))} placeholder={field.unit ?? ""} />
                              ) : (
                                <Input value={typeof value === "string" || typeof value === "number" ? String(value) : ""} onChange={(v) => setValue(v)} />
                              )}
                            </Field>
                            {field.required && empty && <p role="alert" className="mt-1 text-[11.5px] font-bold text-[var(--kv-danger)]">مشخصه «{field.label}» الزامی است.</p>}
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-3 text-[11px] text-[var(--kv-muted)]">مشخصه اختصاصیِ خارج از قالب (فقط برای همین محصول) پس از ذخیره، از دکمه «ویرایش» همین بخش اضافه می‌شود.</p>
                  </div>
                ) : (
                  <Empty
                    title="مشخصات ساختاریافته و راهنمای سایز پس از ذخیره"
                    desc="ویرایشگر مشخصات فنی (بر اساس ساختار دسته‌بندی) و اتصال راهنمای سایز به شناسه محصول روی سرور نیاز دارند؛ بعد از «ذخیره پیش‌نویس» یا «ذخیره و ادامه»، از دکمه «ویرایش» همین بخش فعال می‌شود."
                  />
                )}
              </div>
            )}
            {sec === "sizeguide" && (
              <div className="space-y-4">
                {editing ? (
                  <ProductSpecsEditor key={`sg-${editing.id}`} productId={editing.id} flash={flash} section="size-guide" />
                ) : (
                  <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                    راهنمای سایز پس از «ذخیره» محصول از همین بخش به آن متصل می‌شود؛ ابتدا محصول را ذخیره کنید.
                  </p>
                )}
              </div>
            )}
            {sec === "seo" && <>
              <Field label="عنوان سئو"><Input value={d.seoTitle} onChange={(v) => setD({ ...d, seoTitle: v })} placeholder={d.name || "عنوان صفحه"} /></Field>
              <Field label="نامک"><Input value={d.slug} onChange={(v) => setD({ ...d, slug: v })} placeholder="/product/…" /></Field>
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">عنوان پایه همراه محصول ذخیره می‌شود؛ توضیح متا، Canonical، ایندکس، تصویر شبکه‌های اجتماعی و Schema محصول (قیمت و موجودی زنده از سرور) پس از ذخیره در «استودیو CMS ← سئو ← محصولات» مدیریت می‌شود.</p>
              <p className="text-[12px] text-[var(--kv-muted)]">کانال‌ها: {[d.retailOn && "فروشگاه خرده", d.wholesaleOn && "بازارچه عمده", d.cutout.status === "ready" && "استایل‌بیلدر"].filter(Boolean).join("، ") || "هیچ‌کدام"}</p>
            </>}
            {/* §30 (final gate): review step — completion checklist with click-to-section links. */}
            {sec === "review" && (
              <div className="space-y-4">
                {!editing && issueItems.length > 0 && (
                  <div>
                    <p className="mb-2 text-[13px] font-extrabold">برای انتشار، این موارد باقی مانده است:</p>
                    <ul className="space-y-1.5">
                      {issueItems.map((item, i) => (
                        <li key={`${item.label}-${i}`}>
                          <button type="button" onClick={() => setSec(item.sec)}
                            className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-amber-300 bg-amber-50 px-3 py-2 text-right text-[12.5px] font-bold text-amber-800 hover:border-amber-400">
                            <span>{item.label}</span><span className="shrink-0 text-[11px]">رفتن به بخش مربوط</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!editing && issueItems.length === 0 && (
                  <p className="rounded-[12px] border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[12.5px] font-bold text-emerald-800">
                    همه بخش‌ها کامل است — می‌توانید «ذخیره و ادامه» را بزنید و موجودی اولیه را ثبت کنید.
                  </p>
                )}
                <div>
                  <p className="mb-2 text-[13px] font-extrabold">خلاصه محصول</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      ["نام", d.name.trim() || "—"],
                      ["دسته", d.category || "—"],
                      ["رنگ‌ها", d.colors.map((c) => c.name).join("، ") || "—"],
                      ["سایزها", d.sizes.join("، ") || "—"],
                      ["واریانت‌هایی که ساخته می‌شوند", editing
                        ? `${editVariants.length.toLocaleString("fa-IR")} واریانت روی سرور`
                        : `${variantMatrix(d.colors.map((c) => c.name), d.sizes).filter(({ color, size }) => !cellOff[variantKey(color, size)]).length.toLocaleString("fa-IR")} از ${(d.colors.length * d.sizes.length).toLocaleString("fa-IR")} خانه ماتریس`],
                      ["تصاویر", `${d.images.length.toLocaleString("fa-IR")} تصویر${d.video ? " · ویدیو دارد" : ""}`],
                      ["کانال‌ها", [d.retailOn && "فروشگاه خرده", d.wholesaleOn && "بازارچه عمده", d.cutout.status === "ready" && "استایل‌بیلدر"].filter(Boolean).join("، ") || "هیچ‌کدام"],
                      ["قیمت خرده", d.retailOn && d.retail ? fmtMoney(Number(d.retail)) : "—"],
                      ["سری‌های عمده", d.wholesaleOn ? `${d.series.filter((s) => s.available).length.toLocaleString("fa-IR")} سری فعال` : "غیرفعال"],
                      ["سئو", d.seoTitle.trim() || d.slug.trim() ? `${d.seoTitle.trim() || d.name.trim()}${d.slug.trim() ? ` · ${d.slug.trim()}` : ""}` : "پیش‌فرض (نام محصول)"],
                    ] as [string, string][]).map(([label, value]) => (
                      <div key={label} className="rounded-[12px] border border-[var(--kv-line)] px-3 py-2">
                        <p className="text-[10.5px] text-[var(--kv-muted)]">{label}</p>
                        <p className="mt-0.5 break-words text-[12.5px] font-bold">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
                {/* §6/§15: the honest next step — definition writes no stock at all. */}
                <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                  «ذخیره پیش‌نویس» محصول را با شناسهٔ قطعی و بدون هیچ موجودی ذخیره می‌کند تا بعداً ادامه‌اش بدهید؛
                  «ذخیره و ادامه» بلافاصله «ورود اولیه کالا» را با همین محصول باز می‌کند و موجودی فقط با سند انبار ثبت می‌شود.
                </p>
              </div>
            )}
            {/* §6: the canonical creation actions — continuous workflow, no success page. */}
            <div className="space-y-2 border-t border-[var(--kv-line)] pt-4">
              {!editing && issues.length > 0 && <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">برای ادامه تکمیل کنید: {issues.join("، ")}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                {editing ? (
                  <>
                    <Btn variant="ghost" onClick={closeStudio} icon={<X size={14} />}>انصراف</Btn>
                    <Btn variant="accent" disabled={!d.name.trim()} onClick={() => void saveEdit()} icon={<Check size={14} />}>ذخیره تغییرات</Btn>
                  </>
                ) : (
                  <>
                    <Btn variant="ghost" onClick={closeStudio} icon={<X size={14} />}>انصراف</Btn>
                    <Btn variant="soft" disabled={draftBlockers.length > 0} onClick={() => void save("draft")} icon={<Save size={14} />}>ذخیره پیش‌نویس</Btn>
                    <Btn variant="accent" disabled={issues.length > 0} onClick={() => void save("continue")} icon={<ArrowLeft size={14} />}>ذخیره و ادامه</Btn>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        </Card>
      </div>
      )}

      <WorkspaceModal open={!!cutFor} onClose={() => setCutFor(null)} title={cutFor ? `استایل‌بیلدر · ${cutFor.name}` : ""}>
        {cutFor && <CutoutUploader key={cutFor.id} productId={cutFor.id} value={products.find((p) => p.id === cutFor.id)?.cutout ?? { status: "none" }} onChange={async (c) => { if (!isDemo) { try { const existing = ((products.find((x) => x.id === cutFor.id) as unknown as { metadata?: Record<string, unknown> })?.metadata ?? {}); await productsApi.update(cutFor.id, { metadata: { ...existing, cutout: c } }); flash("تصویر استایل‌بیلدر ذخیره شد"); await reload(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); return; } } updateProduct(cutFor.id, { cutout: c }); }} candidates={[...cutFor.images, ...(cutFor.cutout?.src && !cutFor.cutout.src.startsWith("data:") ? [cutFor.cutout.src] : [])]} flash={flash} />}
      </WorkspaceModal>
      <WorkspaceModal open={manage} onClose={() => setManage(false)} title="قالب‌های سری کلبه"><CanonicalSeriesLibrary /></WorkspaceModal>
      <WorkspaceModal open={!!specsFor} onClose={() => setSpecsFor(null)} title={specsFor ? `مشخصات · ${specsFor.name}` : ""}>
        {specsFor && <ProductSpecsEditor key={specsFor.id} productId={specsFor.id} flash={flash} />}
      </WorkspaceModal>
      <WorkspaceModal open={!!inventoryFor} onClose={() => setInventoryFor(null)} title={inventoryFor ? `موجودی · ${inventoryFor.name}` : ""}>
        <ProductInventoryDrawer product={inventoryFor} warehouses={warehouses ?? []} onClose={() => setInventoryFor(null)} onFlash={flash} />
      </WorkspaceModal>
      {discountFor && <DiscountManager
        productId={discountFor.id}
        productName={discountFor.name}
        productImage={discountFor.images?.[0]}
        sku={discountFor.sku}
        onClose={() => {
          const productId = discountFor.id;
          setDiscountFor(null);
          if (editing?.id === productId) void openEdit({ id: productId } as Product);
        }}
        flash={flash}
      />}
      {/* §6 (final PO decision): the post-create «محصول با موفقیت تعریف شد» success page was
          REMOVED — the creation journey is continuous. [ذخیره پیش‌نویس] returns to
          «پیش‌نویس‌ها» and [ذخیره و ادامه] goes straight into «ورود اولیه کالا». */}
      {/* §37 (final gate): leaving the studio with unsaved edits always asks first. */}
      <Modal open={confirmLeave} onClose={() => setConfirmLeave(false)} title="تغییرات ذخیره‌نشده">
        <div className="space-y-3">
          <p className="text-[13px] leading-7">تغییرات ذخیره‌نشده‌ای در این {editing ? "ویرایش" : "تعریف"} دارید. اگر خارج شوید، این تغییرات از بین می‌روند.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Btn variant="soft" size="sm" onClick={() => setConfirmLeave(false)}>ادامه ویرایش</Btn>
            <Btn variant="outline" size="sm" onClick={() => { setConfirmLeave(false); setOpen(false); setEditing(null); setD(blank()); onExit?.(); }}>خروج بدون ذخیره</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
