import { useEffect, useRef, useState } from "react";
import { Boxes, Check, Film, Image as ImageIcon, Loader2, Pencil, Plus, Sparkles, Trash2, Upload, Wand2, Workflow, X } from "lucide-react";
import { COLORS, IMG, fmtMoney, fmtNum, nextSku, type Colorway, type Product, type SeriesDef } from "../data/catalog";
import { useStore } from "../data/store";
import { KOLBE } from "../data/platform";
import { useOps } from "../data/ops";
import { fileToUrl, removeBackground, sendToN8n } from "../components/media";
import { filesApi, integrationsApi, inventoryApi, productColorsApi, productStructureApi, productsApi } from "../data/api";
import {
  INSTALLMENT_POLICIES, INSTALLMENT_POLICY_LABEL, buildProductCreatePayload, normalizeProductTypes, normalizeTaxonomies, normalizeWarehouses,
  productVariantSkus, readProductCreateResponse, rialFromToman, variantKey, variantMatrix,
  type InstallmentPolicy, type ProductCreateResponse, type ProductType as StructureProductType, type Taxonomy, type Warehouse,
} from "../data/contracts";
import { ProductSpecsEditor } from "../components/product-specs-editor";
import { ProductInventoryDrawer } from "../components/product-inventory";
import { SeriesTemplatePicker, SeriesTemplateManager, seriesComplete, seriesSizesFor } from "./series-templates";
import { AdaptiveSpecForm, ProductTypesManager, missingRequiredSpecs } from "./admin-product-types";
import { productTypesApi, siteApi, studioApi, type ProductType } from "../data/experience-api";
import { Btn, Card, Drawer, Empty, Field, Input, Select, Status, Switch, Textarea, SearchBox, LoadingState, ErrorState } from "../components/primitives";
import { cn } from "../utils/cn";

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
type DraftImage = { fileId: string | null; url: string };
type Draft = {
  name: string; brand: string; category: string; sku: string; desc: string; fabric: string; care: string;
  retail: string; installment: string; compare: string; seoTitle: string; slug: string; retailOn: boolean; wholesaleOn: boolean;
  colors: Colorway[]; sizes: string[]; images: DraftImage[]; video: string; videoFileId: string | null; series: SeriesDef[]; cutout: Cutout;
  typeCode: string; specs: Record<string, unknown>; gender: "men" | "women" | "unisex" | "kids"; seasons: string[]; vibes: string[];
  productTypeId: string; genderCode: string;
  installmentPolicy: InstallmentPolicy; wholesaleMoq: string; variantWeights: Record<string, string>;
};
const blank = (): Draft => ({ name: "", brand: "Kolbe", category: "پیراهن", sku: "", desc: "", fabric: "", care: "", retail: "", installment: "", compare: "", seoTitle: "", slug: "", retailOn: true, wholesaleOn: true, colors: [COLORS.orange, COLORS.black], sizes: ["S", "M", "L", "XL"], images: [], video: "", videoFileId: null, series: [], cutout: { status: "none" }, typeCode: "", specs: {}, gender: "unisex", seasons: ["autumn", "winter"], vibes: [], productTypeId: "", genderCode: "", installmentPolicy: "enabled", wholesaleMoq: "", variantWeights: {} });

export function ProductStudio({ flash }: { flash: F }) {
  const isDemo = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");
  const { products, addProduct, setStatus, updateProduct, reload } = useStore();
  const [mediaBusy, setMediaBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [sec, setSec] = useState("base");
  const [q, setQ] = useState("");
  const [d, setD] = useState<Draft>(blank());
  const [cutFor, setCutFor] = useState<Product | null>(null);
  const [manage, setManage] = useState(false);
  const [newColor, setNewColor] = useState({ name: "", hex: "#8A6A4F" });
  // Inventory step: warehouse + per (color,size) initial quantity. Persisted through WMS receipts.
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [initialQty, setInitialQty] = useState<Record<string, string>>({});
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [createdSummary, setCreatedSummary] = useState<{ product: ProductCreateResponse; receipted: number } | null>(null);
  const [inventoryFor, setInventoryFor] = useState<Product | null>(null);
  const [types, setTypes] = useState<ProductType[]>([]);
  const [vibeOptions, setVibeOptions] = useState<{ slug: string; name: string }[]>([]);
  const [typesOpen, setTypesOpen] = useState(false);
  const loadTypes = () => { if (!isDemo) productTypesApi.list().then((r) => setTypes(r.items)).catch(() => setTypes([])); };
  useEffect(() => { loadTypes(); if (!isDemo) siteApi.vibes().then((r) => setVibeOptions(r.items)).catch(() => undefined); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const [specsFor, setSpecsFor] = useState<Product | null>(null);
  const [productTypes, setProductTypes] = useState<StructureProductType[]>([]);
  const [taxonomies, setTaxonomies] = useState<Taxonomy[]>([]);

  /* ---------- Unified create/edit mode (Req 38-39) ---------- */
  type ServerVariant = { id: string; sku: string; color: string | null; size: string | null; weight_grams: number | null; active: boolean; available: number; on_hand: number };
  const [editing, setEditing] = useState<{ id: string; metadata: Record<string, unknown> } | null>(null);
  const [editVariants, setEditVariants] = useState<ServerVariant[]>([]);
  /* Create-mode Color×Size matrix: a switched-off cell means "no variant" (—),
     which is different from a variant with stock 0 (Req 26/32). */
  const [cellOff, setCellOff] = useState<Record<string, boolean>>({});
  /* Persisted structure data (Req 30/34/35/41/43/44) */
  const [serverColors, setServerColors] = useState<{ id: string; name: string; hex: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; slug: string; parentId: string | null }[]>([]);
  const [newCategory, setNewCategory] = useState<{ open: boolean; name: string; parentId: string }>({ open: false, name: "", parentId: "" });
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
  useEffect(() => { loadCategories(); loadServerColors(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
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
  const createSize = async () => {
    const code = newSize.trim();
    if (!code) return;
    if (!d.productTypeId) { flash("برای افزودن سایز، ابتدا نوع محصول را انتخاب کنید."); return; }
    try {
      await productStructureApi.createSize(d.productTypeId, { code, label: code });
      loadTypes();
      setD((cur) => ({ ...cur, sizes: cur.sizes.includes(code) ? cur.sizes : [...cur.sizes, code] }));
      setNewSize("");
      flash(`سایز «${code}» به نوع محصول اضافه شد`);
    } catch (e) { flash(e instanceof Error ? e.message : "خطا در افزودن سایز"); }
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
      setD({
        ...blank(),
        name: String(detail.name ?? ""), brand: String(detail.brand ?? "Kolbe"), category: String(detail.category ?? ""),
        sku: String(meta.editorialSku ?? ""), desc: String(detail.description ?? ""),
        fabric: String(meta.fabric ?? ""), care: String(meta.care ?? ""),
        retail: toToman(detail.cash_price_rial), installment: toToman(detail.installment_price_rial),
        compare: toToman(meta.compareAtRial), seoTitle: String(seo.title ?? ""), slug: String(seo.slug ?? ""),
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
      });
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
      const metadata = {
        ...editing.metadata,
        images: d.images.map((image) => ({ fileId: image.fileId, url: image.url })),
        videoFileId: d.videoFileId ?? null,
        fabric: d.fabric.trim(), care: d.care.trim(),
        seo: { title: d.seoTitle.trim() || d.name.trim(), slug: d.slug.trim() },
        compareAtRial: d.compare ? rialFromToman(d.compare) : null,
        editorialSku: d.sku.trim() || null,
        cutout: d.cutout && d.cutout.status !== "none" ? d.cutout : null,
      };
      await productsApi.update(editing.id, {
        name: d.name.trim(), brand: d.brand.trim(), category: d.category.trim(), description: d.desc,
        cashPriceRial: d.retailOn ? rialFromToman(d.retail) : "0",
        installmentPriceRial: d.retailOn && (d.installment || d.retail) ? rialFromToman(d.installment || d.retail) : null,
        metadata,
        gender: d.gender, seasons: d.seasons, vibes: d.vibes,
        ...(d.genderCode ? { genderCode: d.genderCode } : {}),
        productTypeId: d.productTypeId || null,
        retailEnabled: d.retailOn, wholesaleEnabled: d.wholesaleOn,
        installmentPolicy: d.installmentPolicy,
        wholesaleMoq: d.wholesaleMoq ? Number(d.wholesaleMoq) : null,
        ...(d.typeCode ? { productTypeCode: d.typeCode, specifications: d.specs } : {}),
      });
      flash(`«${d.name}» ذخیره شد`);
      setOpen(false); setEditing(null); setD(blank());
      await reload();
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
  const sizeOptions = selectedType?.sizes.length
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
        setWarehouseId((current) => current || list[0]?.id || "");
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
  const list = products.filter((p) => !q.trim() || (p.name ?? "").includes(q.trim()) || (p.sku ?? "").includes(q.trim()));
  const issues = [
    !isDemo && !d.productTypeId && "نوع محصول",
    !d.name.trim() && "نام محصول", !d.colors.length && "دست‌کم یک رنگ", !d.sizes.length && "سایزها",
    !d.retailOn && !d.wholesaleOn && "یک کانال فروش", d.retailOn && !(Number(d.retail) > 0) && "قیمت خرده",
    d.retailOn && d.installment && !(Number(d.installment) > 0) && "قیمت چهارقسطه معتبر",
    d.wholesaleOn && !seriesComplete(d.series) && "سری‌های عمده (قیمت، حداقل و رنگ)", !d.images.length && "دست‌کم یک تصویر",
    !isDemo && types.length > 0 && !d.typeCode && "نوع محصول",
    ...missingRequiredSpecs(selectedType, d.specs).map((label) => `مشخصه «${label}»`),
  ].filter(Boolean) as string[];

  /** Uploads a product image; the persisted value is the server file id, the preview stays local. */
  const uploadImage = async (file: File): Promise<DraftImage> => {
    if (isDemo) return { fileId: null, url: (await fileToUrl(file)).url };
    const uploaded = await filesApi.upload(file);
    return { fileId: uploaded.id, url: URL.createObjectURL(file) };
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

  const save = async () => {
    if (issues.length) return;
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
        stock: Object.values(initialQty).reduce((total, value) => total + (Number(value) || 0), 0),
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
        cashToman: d.retail, installmentToman: d.installment, compareToman: d.compare,
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
      if (!enabledVariants.length) { flash("دست‌کم یک خانه فعال در ماتریس رنگ×سایز لازم است."); return; }
      setInventoryBusy(true);
      // Adaptive form data (Req 325-326): the server validates specs against the type template.
      const adaptivePayload = { ...payload, variants: enabledVariants, ...(d.typeCode ? { productTypeCode: d.typeCode, specifications: d.specs } : {}), gender: d.gender, seasons: d.seasons, vibes: d.vibes };
      const res = readProductCreateResponse(await productsApi.create(adaptivePayload));
      const skus = productVariantSkus(res);

      // Inventory never lives on the product: after the server mints the variants we open a real
      // WMS receipt per variant (incoming → receive) so the balance becomes sellable stock.
      let receipted = 0;
      const warehouse = warehouseId || warehouses?.[0]?.id || "";
      if (warehouse) {
        for (const variant of res.variants) {
          const key = variantKey(variant.color, variant.size);
          const quantity = Number(initialQty[key] ?? 0);
          if (!quantity || quantity < 1) continue;
          const receipt = await inventoryApi.receipt({
            warehouseId: warehouse, variantId: variant.id, quantity,
            reference: `INIT-${variant.sku}`,
          }, `init-${variant.id}`) as { id?: string };
          if (receipt?.id) await inventoryApi.receiveReceipt(receipt.id);
          receipted += 1;
        }
      }
      setCreatedSummary({ product: res, receipted });
      flash(`«${d.name}» ثبت شد — ${skus.length.toLocaleString("fa-IR")} واریانت (SKU سرور)${receipted ? ` و موجودی اولیه ${receipted.toLocaleString("fa-IR")} واریانت در انبار ثبت شد` : ""}`);
      setOpen(false); setD(blank()); setInitialQty({});
      await reload();
    } catch (e) {
      flash(e instanceof Error ? e.message : "خطا در انتشار");
    }
  };

  // One unified studio for create AND edit (Req 39); initial stock only applies at creation.
  const secs = [
    ["base", "اطلاعات پایه"], ["variant", "رنگ و سایز"], ["media", "تصویر و ویدیو"], ["cutout", "تصویر استایل‌بیلدر"],
    ["price", "قیمت‌گذاری"], ["series", "سری‌های عمده"],
    ...(editing ? [] : [["stock", "موجودی اولیه"]]),
    ["specs", "مشخصات فنی و راهنمای سایز"], ["seo", "سئو و کانال‌ها"],
  ];
  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      {!open && (<>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <div className="min-w-[200px] flex-1"><SearchBox value={q} onChange={setQ} placeholder="جست‌وجوی محصول یا SKU…" /></div>
        <Btn variant="soft" size="sm" onClick={() => setManage(true)}>قالب‌های سری کلبه</Btn>
        {!isDemo && <Btn variant="soft" size="sm" onClick={() => setTypesOpen(true)}>انواع محصول و قالب مشخصات</Btn>}
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setD(blank()); setEditing(null); setEditVariants([]); setCellOff({}); setSec("base"); setOpen(true); }}>تعریف محصول جدید</Btn>
      </div>
      <Card className="overflow-hidden">
        <div className="kv-scroll overflow-x-auto">
          <table className="kv-table min-w-[920px]">
            <thead><tr><th>محصول</th><th>مالک</th><th>خرده</th><th>عمده از</th><th>موجودی (WMS)</th><th>سری</th><th>رسانه</th><th>استایل‌بیلدر</th><th>مشخصات</th><th>ویرایش</th><th>انتشار</th></tr></thead>
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
          <Btn variant="soft" size="sm" onClick={() => { setOpen(false); setEditing(null); }} icon={<X size={14} />}>بازگشت به فهرست</Btn>
          <h2 className="text-[17px] font-extrabold">{editing ? `ویرایش محصول · ${d.name || "…"}` : "تعریف محصول جدید"}</h2>
          <span className="text-[11.5px] text-[var(--kv-muted)]">{editing ? "داده‌ها از سرور بارگذاری شده‌اند؛ تغییرات با ذخیره روی همان محصول اعمال می‌شود." : "تمام بخش‌های محصول را در همین صفحه تکمیل کنید و در پایان ذخیره و انتشار بزنید."}</span>
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
              <Field label="نام محصول"><Input value={d.name} onChange={(v) => setD({ ...d, name: v })} placeholder="مثلاً کت پشمی دو‌دکمه" /></Field>
              <div className="grid gap-3 sm:grid-cols-3"><Field label="برند"><Input value={d.brand} onChange={(v) => setD({ ...d, brand: v })} /></Field><Field label="دسته" hint={!isDemo && categories.length ? "سلسله‌مراتبی از سرور (زیر‌دسته‌ها با — تورفتگی)" : undefined}>
                  <Select
                    options={!isDemo && categories.length ? categoryOptionLabels : [...new Set([...cats, "شلوار", "کفش", "اکسسوری"])]}
                    value={!isDemo && categories.length ? (categoryOptionLabels.find((label) => label.replace(/^(?:— )+/, "") === d.category) ?? d.category) : d.category}
                    onChange={(v) => {
                      if (v === NEW_CATEGORY_OPTION) { setNewCategory({ open: true, name: "", parentId: "" }); return; }
                      const name = v.replace(/^(?:— )+/, "");
                      setD({ ...d, category: name, sizes: seriesSizesFor(name).slice(0, 4), series: [] });
                    }} />
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
                {typeOptions.length > 0 && (
                  <Field label="نوع محصول" hint="سایزها و قالب مشخصات از نوع محصول می‌آیند">
                    <Select options={["انتخاب کنید", ...typeOptions.map((t) => t.name)]}
                      value={typeOptions.find((t) => t.id === d.productTypeId || t.code === d.typeCode)?.name ?? "انتخاب کنید"}
                      onChange={(label) => { const t = typeOptions.find((x) => x.name === label); setD({ ...d, typeCode: t?.code ?? "", productTypeId: t?.id ?? "", specs: {}, sizes: t?.sizeCodes.length ? t.sizeCodes : d.sizes, series: [] }); }} />
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
                {!isDemo && <div className="sm:col-span-3"><Field label="وایب‌ها (چندانتخابی مدیریت‌شده)" hint="جست‌وجو، انتخاب/حذف و ساخت وایب جدید — همه روی سرور">
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
                {isDemo && vibeOptions.length > 0 && <div className="sm:col-span-3"><Field label="وایب‌ها"><div className="flex flex-wrap gap-1.5">{vibeOptions.map((v) => <button key={v.slug} type="button" aria-pressed={d.vibes.includes(v.slug)} onClick={() => setD({ ...d, vibes: d.vibes.includes(v.slug) ? d.vibes.filter((x) => x !== v.slug) : [...d.vibes, v.slug] })} className={cn("rounded-full border px-2.5 py-1 text-[11.5px]", d.vibes.includes(v.slug) ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)]")}>{v.name}</button>)}</div></Field></div>}
              </div>
              {selectedType && <AdaptiveSpecForm type={selectedType} values={d.specs} onChange={(specs) => setD({ ...d, specs })} />}
              <Field label="توضیحات"><Textarea rows={4} value={d.desc} onChange={(v) => setD({ ...d, desc: v })} /></Field>
              {/* Req 45: fabric/care now live in the «مشخصات فنی» section. */}
              <p className="text-[11.5px] text-[var(--kv-muted)]">جنس پارچه و نگهداری به بخش «مشخصات فنی و راهنمای سایز» منتقل شده‌اند.</p>
            </>}
            {sec === "variant" && <>
              <div>
                <p className="mb-2 text-[13px] font-semibold">رنگ‌های محصول</p>
                <div className="flex flex-wrap gap-2">{palette.map((c) => { const on = d.colors.some((x) => x.id === c.id); return (
                  <button key={c.id} aria-pressed={on} onClick={() => setD({ ...d, colors: on ? d.colors.filter((x) => x.id !== c.id) : [...d.colors, c], series: d.series.map((s) => ({ ...s, colorIds: on ? s.colorIds?.filter((x) => x !== c.id) : s.colorIds })) })} className={cn("flex min-h-10 items-center gap-2 rounded-full border px-3 text-[12px] font-semibold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)]")}><span className="h-4 w-4 rounded-full border border-black/15" style={{ background: c.hex }} />{c.name}</button>
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
              <Field label={selectedType || typedSizeCodes.length ? `سایزهای ${selectedType?.name ?? typeOptions.find((t) => t.id === d.productTypeId)?.name ?? "نوع محصول"} (از قالب نوع محصول)` : "سایزهای خرده"}>
                {sizeOptions.length === 0
                  ? <p className="text-[12.5px] text-[var(--kv-muted)]">این نوع محصول سایز فعالی ندارد؛ از «ساختار محصولات» سایز اضافه کنید.</p>
                  : <div className="flex flex-wrap gap-2">{sizeOptions.map((s) => <button key={s} aria-pressed={d.sizes.includes(s)} onClick={() => setD({ ...d, sizes: d.sizes.includes(s) ? d.sizes.filter((x) => x !== s) : [...d.sizes, s] })} className={cn("min-h-10 min-w-[46px] rounded-[10px] border px-3 text-[12.5px] font-bold", d.sizes.includes(s) ? "border-[var(--kv-ink)] bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]" : "border-[var(--kv-line)]")}>{s}</button>)}</div>}
              </Field>
              {!isDemo && (
                <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <p className="mb-2 text-[12.5px] font-bold">افزودن سایز جدید به نوع محصول</p>
                  {!d.productTypeId
                    ? <p className="text-[12px] text-[var(--kv-muted)]">سایزها به «نوع محصول» وصل‌اند؛ ابتدا در «اطلاعات پایه» نوع محصول را انتخاب کنید.</p>
                    : <div className="flex flex-wrap items-end gap-2">
                        <Field label="کد سایز" hint="مثلاً XXL یا ۴۴ — روی سرور ذخیره و بعد از رفرش هم می‌ماند">
                          <Input value={newSize} onChange={setNewSize} placeholder="XXL" />
                        </Field>
                        <Btn variant="soft" size="sm" disabled={!newSize.trim()} onClick={() => void createSize()} icon={<Plus size={14} />}>افزودن به نوع محصول</Btn>
                      </div>}
                </div>
              )}
              {/* Req 26/32: the real Color×Size matrix. «—» = واریانت وجود ندارد؛ صفر = واریانت هست ولی موجودی صفر. */}
              {d.colors.length > 0 && d.sizes.length > 0 && (
                <div className="rounded-[12px] border border-[var(--kv-line)] p-3">
                  <p className="mb-1 text-[12.5px] font-bold">ماتریس واریانت رنگ × سایز</p>
                  <p className="mb-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                    {editing
                      ? "هر خانه وضعیت واقعی واریانت روی سرور است: کلیک = ساخت واریانت جدید یا فعال/غیرفعال‌کردن همان لحظه. «—» یعنی واریانت اصلاً وجود ندارد."
                      : "خانه‌های خاموش هنگام ذخیره ساخته نمی‌شوند (واریانت وجود نخواهد داشت)؛ این با واریانتِ ساخته‌شده با موجودی صفر فرق دارد."}
                  </p>
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
                                return (
                                  <td key={s}>
                                    <button type="button" onClick={() => void toggleEditCell(c.name, s)}
                                      className={cn("min-h-9 w-full rounded-[8px] border px-2 py-1 text-[11px] font-bold",
                                        !hit ? "border-dashed border-[var(--kv-line)] text-[var(--kv-muted)]"
                                          : hit.active ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)] opacity-50")}
                                      title={hit ? `${hit.sku} · موجودی ${hit.on_hand}` : "ساخت واریانت"}>
                                      {!hit ? "— (ساخت)" : hit.active ? `فعال · ${hit.on_hand.toLocaleString("fa-IR")}` : "غیرفعال"}
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
                </div>
              )}
            </>}
            {sec === "media" && <>
              <div>
                <div className="mb-2 flex items-center justify-between"><p className="text-[13px] font-semibold">تصاویر فروشگاه ({fmtNum(d.images.length)})</p><span className="text-[11.5px] text-[var(--kv-muted)]">اولین تصویر، کاور است · نسبت ۳:۴</span></div>
                <div className="grid grid-cols-4 gap-2">
                  {d.images.map((im, i) => <div key={`${im.fileId ?? im.url}-${i}`} className="group relative overflow-hidden rounded-[10px] border border-[var(--kv-line)]"><img src={im.url} alt="" className="aspect-[3/4] w-full object-cover" />{i === 0 && <span className="absolute bottom-1 right-1 rounded-full bg-[#1B2A4A]/85 px-2 py-0.5 text-[10px] font-bold text-white">کاور</span>}<span className="absolute right-1 top-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white" dir="ltr">{im.fileId ? "server" : "demo"}</span><button aria-label="حذف تصویر" onClick={() => setD({ ...d, images: d.images.filter((_, j) => j !== i) })} className="absolute left-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white"><Trash2 size={13} /></button>{i > 0 && <button onClick={() => setD({ ...d, images: [im, ...d.images.filter((_, j) => j !== i)] })} className="absolute bottom-1 left-1 rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-bold text-[#1B2A4A]">کاور کن</button>}</div>)}
                  <input ref={imgRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={async (e) => { const files = Array.from(e.target.files ?? []).slice(0, 8); if (!files.length) return; setMediaBusy(true); try { const uploaded: DraftImage[] = []; for (const file of files) uploaded.push(await uploadImage(file)); setD((prev) => ({ ...prev, images: [...prev.images, ...uploaded] })); if (!isDemo) flash(`${uploaded.length.toLocaleString("fa-IR")} تصویر روی سرور ذخیره شد`); } catch (err) { flash(err instanceof Error ? err.message : "خطا در بارگذاری تصویر"); } finally { setMediaBusy(false); } }} />
                  <button onClick={() => imgRef.current?.click()} className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed border-[var(--kv-line-strong)] text-[11.5px] font-semibold text-[var(--kv-muted)] hover:border-[var(--kv-accent)]"><ImageIcon size={18} />افزودن تصویر</button>
                </div>
                {isDemo
                  ? <div className="mt-2 flex gap-1.5 overflow-x-auto kv-no-scrollbar">{[IMG.trenchArch, IMG.trenchHero, IMG.blazerDuo, IMG.shirtRack, IMG.redCoat].map((src) => <button key={src} onClick={() => setD({ ...d, images: [...d.images, { fileId: null, url: src }] })} className="h-12 w-10 shrink-0 overflow-hidden rounded-[7px] opacity-70 hover:opacity-100" aria-label="افزودن تصویر نمونه"><img src={src} alt="" className="h-full w-full object-cover" /></button>)}<span className="self-center text-[11px] text-[var(--kv-muted)]">تصاویر نمونه (demo)</span></div>
                  : <p className="mt-2 text-[11.5px] text-[var(--kv-muted)]">هر تصویر ابتدا با <code dir="ltr">POST /files</code> روی سرور ذخیره می‌شود و شناسه فایل در <code dir="ltr">metadata.images</code> قرار می‌گیرد؛ پیش‌نمایش محلی فقط برای نمایش است.</p>}
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
            {sec === "cutout" && <CutoutUploader productId="new" value={d.cutout} onChange={(c) => setD((p) => ({ ...p, cutout: c }))} candidates={d.images.map((image) => image.url)} flash={flash} />}
            {sec === "price" && <>
              <div className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3"><span><b className="text-[13px]">فروش خرده در kolbe.ir</b><span className="block text-[11.5px] text-[var(--kv-muted)]">قیمت تک‌عدد برای همه مشتریان</span></span><Switch on={d.retailOn} onToggle={() => setD({ ...d, retailOn: !d.retailOn })} /></div>
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">
                چهار مفهوم قیمتی جدا از هم‌اند: <b>قیمت پایه خرده</b> (مبنای فروش تک‌عدد)، <b>قیمت چهارقسطه</b> (مخصوص پرداخت اقساطی)،
                <b> قیمت عمده</b> (در بخش «سری‌های عمده» تعیین می‌شود) و <b>تخفیف</b> که فقط از موتور پروموشن/جشنواره اعمال می‌شود، نه از این فرم.
              </p>
              {d.retailOn && <div className="grid gap-3 sm:grid-cols-2"><Field label="قیمت پایه خرده — نقدی (تومان)" hint="مبنای اصلی قیمت تک‌عدد در kolbe.ir"><Input value={d.retail} onChange={(v) => setD({ ...d, retail: v.replace(/\D/g, "") })} /></Field><Field label="قیمت مخصوص چهارقسطه (تومان)" hint="هر قسط از این مبلغ محاسبه می‌شود؛ خالی یعنی برابر قیمت نقدی"><Input value={d.installment} onChange={(v) => setD({ ...d, installment: v.replace(/\D/g, "") })} /></Field><Field label="قیمت قبل از تخفیف — نمایشی (تومان)" hint="فقط برای نمایش خط‌خورده در کارت محصول؛ تخفیف واقعی از موتور پروموشن اعمال می‌شود"><Input value={d.compare} onChange={(v) => setD({ ...d, compare: v.replace(/\D/g, "") })} /></Field></div>}
              {d.retailOn && Number(d.installment || d.retail) > 0 && <p className="text-[12px] text-[var(--kv-muted)]">هر قسط: {fmtMoney(Math.ceil(Number(d.installment || d.retail) / 4))}</p>}
              <Field label="سیاست قسط" hint="سرور در تسویه‌حساب همین سیاست را اعمال می‌کند"><Select options={([...INSTALLMENT_POLICIES]).map((p) => INSTALLMENT_POLICY_LABEL[p])} value={INSTALLMENT_POLICY_LABEL[d.installmentPolicy]} onChange={(label) => { const found = ([...INSTALLMENT_POLICIES]).find((p) => INSTALLMENT_POLICY_LABEL[p] === label); if (found) setD({ ...d, installmentPolicy: found }); }} /></Field>
            </>}
            {sec === "series" && <>
              <div className="flex items-center justify-between rounded-[12px] border border-[var(--kv-line)] px-4 py-3"><span><b className="text-[13px]">فروش در بازارچه عمده · بخش کلبه وینتیج</b><span className="block text-[11.5px] text-[var(--kv-muted)]">سری‌ها از قالب‌های تعریف‌شده انتخاب می‌شوند</span></span><Switch on={d.wholesaleOn} onToggle={() => setD({ ...d, wholesaleOn: !d.wholesaleOn })} /></div>
              {d.wholesaleOn && <Field label="حداقل سفارش عمده (عدد)" hint="سرور در ثبت سفارش عمده همین کف را برای مجموع واریانت‌های این محصول اعمال می‌کند"><Input value={d.wholesaleMoq} onChange={(v) => setD({ ...d, wholesaleMoq: v.replace(/\D/g, "") })} placeholder="مثلاً ۱۲" /></Field>}
              {d.wholesaleOn && (!d.productTypeId && !isDemo ? <p className="rounded-[12px] border border-dashed border-[var(--kv-line-strong)] p-4 text-[12.5px] text-[var(--kv-muted)]">برای انتخاب سری، ابتدا نوع محصول را مشخص کنید.</p> : <SeriesTemplatePicker ownerId={KOLBE.id} category={d.category} colors={d.colors} value={d.series} onChange={(s) => setD({ ...d, series: s })} onManage={() => setManage(true)} productTypeId={d.productTypeId || undefined} />)}
            </>}
            {sec === "stock" && (
              <div className="space-y-3">
                <p className="text-[12.5px] leading-6 text-[var(--kv-muted)]">
                  موجودی فقط در انبار (WMS) نگهداری می‌شود؛ برای هر رنگ/سایز مقدار اولیه را وارد کنید تا در پایان ذخیره، رسید ورودی واقعی ثبت و تأیید شود.
                </p>
                {!warehouses || warehouses.length === 0 ? (
                  <ErrorState message="هنوز انباری ثبت نشده است؛ نخست از بخش «انبار و موجودی» یک انبار بسازید." />
                ) : (
                  <Field label="انبار مقصد موجودی اولیه" hint="از فهرست واقعی انبارهای ثبت‌شده">
                    <Select
                      options={warehouses.map((warehouse) => `${warehouse.code} — ${warehouse.name}`)}
                      value={warehouses.find((warehouse) => warehouse.id === warehouseId) ? `${warehouses.find((warehouse) => warehouse.id === warehouseId)!.code} — ${warehouses.find((warehouse) => warehouse.id === warehouseId)!.name}` : warehouses[0] ? `${warehouses[0].code} — ${warehouses[0].name}` : ""}
                      onChange={(label) => setWarehouseId(warehouses.find((warehouse) => `${warehouse.code} — ${warehouse.name}` === label)?.id ?? "")}
                    />
                  </Field>
                )}
                <Card className="overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="kv-table min-w-[560px] text-xs">
                      <thead><tr><th>رنگ</th><th>سایز</th><th>SKU (پس از ایجاد)</th><th>وزن (گرم)</th><th>انبار</th><th>موجودی اولیه</th></tr></thead>
                      <tbody>
                        {variantMatrix(d.colors.map((color) => color.name), d.sizes).filter(({ color, size }) => !cellOff[variantKey(color, size)]).map(({ color, size }) => (
                          <tr key={`${color}-${size}`}>
                            <td>{color}</td><td>{size}</td>
                            <td className="text-[var(--kv-muted)]" dir="ltr">پس از ذخیره ساخته می‌شود</td>
                            <td className="w-[100px]">
                              <Input
                                value={d.variantWeights[variantKey(color, size)] ?? ""}
                                onChange={(value) => setD((current) => ({ ...current, variantWeights: { ...current.variantWeights, [variantKey(color, size)]: value.replace(/\D/g, "") } }))}
                                placeholder="—"
                              />
                            </td>
                            <td>{warehouses?.find((warehouse) => warehouse.id === warehouseId)?.name ?? "—"}</td>
                            <td className="w-[120px]">
                              <Input
                                value={initialQty[variantKey(color, size)] ?? ""}
                                onChange={(value) => setInitialQty((current) => ({ ...current, [variantKey(color, size)]: value.replace(/\D/g, "") }))}
                                placeholder="۰"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {d.colors.length === 0 || d.sizes.length === 0
                    ? <p className="px-4 py-3 text-[12px] text-[var(--kv-muted)]">ابتدا در بخش «رنگ و سایز» دست‌کم یک رنگ و یک سایز انتخاب کنید.</p>
                    : <p className="px-4 py-3 text-[11.5px] text-[var(--kv-muted)]">{`${variantMatrix(d.colors.map((color) => color.name), d.sizes).filter(({ color, size }) => !cellOff[variantKey(color, size)]).length.toLocaleString("fa-IR")} واریانت (خانه‌های فعال ماتریس) ساخته می‌شود و موجودی هر ردیف با رسید ورودی ثبت می‌شود.`}</p>}
                </Card>
                {inventoryBusy && <LoadingState label="در حال ثبت رسیدهای موجودی اولیه…" />}
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
                  <ProductSpecsEditor key={editing.id} productId={editing.id} flash={flash} />
                ) : (
                  <Empty
                    title="مشخصات ساختاریافته و راهنمای سایز پس از ذخیره"
                    desc="ویرایشگر مشخصات فنی (بر اساس قالب نوع محصول) و اتصال راهنمای سایز به شناسه محصول روی سرور نیاز دارند؛ بعد از «ذخیره و انتشار»، از دکمه «ویرایش» همین بخش فعال می‌شود."
                  />
                )}
              </div>
            )}
            {sec === "seo" && <>
              <Field label="عنوان سئو"><Input value={d.seoTitle} onChange={(v) => setD({ ...d, seoTitle: v })} placeholder={d.name || "عنوان صفحه"} /></Field>
              <Field label="نامک"><Input value={d.slug} onChange={(v) => setD({ ...d, slug: v })} placeholder="/product/…" /></Field>
              <p className="rounded-[10px] bg-[var(--kv-surface-2)] px-3 py-2 text-[11.5px] leading-6 text-[var(--kv-muted)]">عنوان پایه همراه محصول ذخیره می‌شود؛ توضیح متا، Canonical، ایندکس، تصویر شبکه‌های اجتماعی و Schema محصول (قیمت و موجودی زنده از سرور) پس از ذخیره در «استودیو CMS ← سئو ← محصولات» مدیریت می‌شود.</p>
              <p className="text-[12px] text-[var(--kv-muted)]">کانال‌ها: {[d.retailOn && "فروشگاه خرده", d.wholesaleOn && "بازارچه عمده", d.cutout.status === "ready" && "استایل‌بیلدر"].filter(Boolean).join("، ") || "هیچ‌کدام"}</p>
            </>}
            <div className="space-y-2 border-t border-[var(--kv-line)] pt-4">
              {!editing && issues.length > 0 && <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">برای انتشار تکمیل کنید: {issues.join("، ")}</p>}
              <Btn variant="accent" disabled={editing ? !d.name.trim() : issues.length > 0} onClick={editing ? saveEdit : save} icon={<Check size={14} />}>{editing ? "ذخیره تغییرات" : "ذخیره و انتشار"}</Btn>
            </div>
          </div>
        </div>
        </Card>
      </div>
      )}

      <Drawer open={!!cutFor} onClose={() => setCutFor(null)} title={cutFor ? `استایل‌بیلدر · ${cutFor.name}` : ""} wide>
        {cutFor && <CutoutUploader key={cutFor.id} productId={cutFor.id} value={products.find((p) => p.id === cutFor.id)?.cutout ?? { status: "none" }} onChange={async (c) => { if (!isDemo) { try { const existing = ((products.find((x) => x.id === cutFor.id) as unknown as { metadata?: Record<string, unknown> })?.metadata ?? {}); await productsApi.update(cutFor.id, { metadata: { ...existing, cutout: c } }); flash("تصویر استایل‌بیلدر ذخیره شد"); await reload(); } catch (e) { flash(e instanceof Error ? e.message : "خطا"); return; } } updateProduct(cutFor.id, { cutout: c }); }} candidates={[...cutFor.images, ...(cutFor.cutout?.src && !cutFor.cutout.src.startsWith("data:") ? [cutFor.cutout.src] : [])]} flash={flash} />}
      </Drawer>
      <Drawer open={typesOpen} onClose={() => setTypesOpen(false)} title="انواع محصول، سایزها و قالب مشخصات" wide><ProductTypesManager flash={flash} onChanged={loadTypes} /></Drawer>
      <Drawer open={manage} onClose={() => setManage(false)} title="قالب‌های سری کلبه" wide><SeriesTemplateManager ownerId={KOLBE.id} ownerLabel="کلبه وینتیج" /></Drawer>
      <Drawer open={!!specsFor} onClose={() => setSpecsFor(null)} title={specsFor ? `مشخصات · ${specsFor.name}` : ""} wide>
        {specsFor && <ProductSpecsEditor key={specsFor.id} productId={specsFor.id} flash={flash} />}
      </Drawer>
      <Drawer open={!!inventoryFor} onClose={() => setInventoryFor(null)} title={inventoryFor ? `موجودی · ${inventoryFor.name}` : ""} wide>
        <ProductInventoryDrawer product={inventoryFor} warehouses={warehouses ?? []} onClose={() => setInventoryFor(null)} onFlash={flash} />
      </Drawer>
      <Drawer open={!!createdSummary} onClose={() => setCreatedSummary(null)} title="محصول ثبت شد — موجودی اولیه" wide>
        {createdSummary && (
          <div className="space-y-3">
            <p className="text-[13px] leading-7 text-[var(--kv-muted)]">
              {createdSummary.product.variants.length.toLocaleString("fa-IR")} واریانت با SKU سرور ساخته شد
              {createdSummary.receipted > 0
                ? ` و موجودی اولیه ${createdSummary.receipted.toLocaleString("fa-IR")} واریانت با رسید ورودی در انبار ثبت شد.`
                : "؛ برای این محصول موجودی اولیه ثبت نشد و می‌توانید بعداً از بخش انبار اضافه کنید."}
            </p>
            <Card className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="kv-table min-w-[420px] text-xs">
                  <thead><tr><th>رنگ</th><th>سایز</th><th>SKU</th></tr></thead>
                  <tbody>
                    {createdSummary.product.variants.map((variant) => (
                      <tr key={variant.id}><td>{variant.color ?? "—"}</td><td>{variant.size ?? "—"}</td><td className="font-mono" dir="ltr">{variant.sku}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Btn variant="soft" size="sm" onClick={() => setCreatedSummary(null)}>بستن</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}
