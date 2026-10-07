/* KOLBE — Styling admin surfaces (Phase 2, Non-Core workstream)
 *
 * Two production admin areas, built on the EXISTING console primitives:
 *
 *  1. CompatibilityStudio — «محصولات مکمل و هماهنگی استایل», embedded in the
 *     existing Retail product editor. Admin picks the SOURCE colour variant,
 *     browses the real retail catalogue for targets (search, category,
 *     availability, only-defined-relations; paginated) and sets the four
 *     relation levels on colour variants — never on size SKUs (§23/§26).
 *     Productivity: copy relations from another colour, apply to all colours.
 *
 *  2. CuratedStyleStudio — «استایل‌های آماده»: the admin-authored
 *     compositions of real retail products (§34–§40), with a compatibility
 *     preview that runs the SAME recommendation domain (§38), pricing
 *     configuration and installment configuration. Publishing is explicit;
 *     drafts never leak through public surfaces.
 */
import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, Layers, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../data/catalog";
import { useStore } from "../data/store";
import { outfitRoleOf, ROLE_LABEL } from "../data/styling";
import {
  CURATED_ROLES, CURATED_STATUS_LABEL, DEFAULT_INSTALLMENTS, DEFAULT_PRICING,
  RELATION_LABEL, curatableProduct, previewCompatibility, resolveLines, subtotalOf,
  assessDiscount, assessInstallments, validateCuratedStyle,
  type CuratedStyle, type CuratedStyleItem, type RelationLevel, type VariantRef,
} from "../data/curated";
import { Btn, Card, Field, Input, SearchBox, Switch, Textarea } from "../components/primitives";
import { cn } from "../utils/cn";

type F = (m: string) => void;

const LEVELS: RelationLevel[] = ["strong_match", "match", "neutral", "conflict"];
const LEVEL_TONE: Record<RelationLevel, string> = {
  strong_match: "bg-[var(--kv-success)] text-white",
  match: "bg-[var(--kv-accent)] text-white",
  neutral: "bg-[var(--kv-surface-3)] text-[var(--kv-ink)]",
  conflict: "bg-[var(--kv-danger)] text-white",
};
const PAGE = 6;

/* ============================================================
   1. Compatibility studio (inside the retail product editor)
   ============================================================ */

export function CompatibilityStudio({ source, flash }: { source: Product; flash: F }) {
  const store = useStore();
  const { products, variantRelations, setVariantRelation, copyVariantRelations } = store;
  const catalogue = useMemo(() => products.filter(curatableProduct), [products]);

  const [sourceColorId, setSourceColorId] = useState(source.colors[0]?.id ?? "");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("همه");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [definedOnly, setDefinedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const sourceRef: VariantRef = { productId: source.id, colorId: sourceColorId };
  const sourceRelations = useMemo(
    () => variantRelations.filter((r) =>
      (r.a.productId === source.id && r.a.colorId === sourceColorId)
      || (r.b.productId === source.id && r.b.colorId === sourceColorId)),
    [variantRelations, source.id, sourceColorId],
  );

  /* real retail taxonomy — categories come from the catalogue, never hardcoded */
  const categories = useMemo(() => Array.from(new Set(catalogue.map((p) => p.category))), [catalogue]);

  const targets = useMemo(() => {
    let list = catalogue.filter((p) => p.id !== source.id);
    if (q.trim()) list = list.filter((p) => p.name.includes(q.trim()) || p.brand.includes(q.trim()) || p.sku.includes(q.trim()));
    if (cat !== "همه") list = list.filter((p) => p.category === cat);
    if (inStockOnly) list = list.filter((p) => p.stock > 0);
    if (definedOnly) list = list.filter((p) => p.colors.some((c) =>
      sourceRelations.some((r) =>
        (r.a.productId === p.id && r.a.colorId === c.id) || (r.b.productId === p.id && r.b.colorId === c.id))));
    return list;
  }, [catalogue, source.id, q, cat, inStockOnly, definedOnly, sourceRelations]);

  const visible = targets.slice(0, page * PAGE);
  const otherColors = source.colors.filter((c) => c.id !== sourceColorId);

  const setLevel = (target: Product, colorId: string, level: RelationLevel | null) => {
    const result = setVariantRelation(sourceRef, { productId: target.id, colorId }, level);
    if (!result.ok) {
      const note = result.rejection === "self" ? "یک رنگ نمی‌تواند با خودش هماهنگ باشد."
        : result.rejection === "invalid_variant" ? "رنگ یا محصول هدف معتبر نیست."
        : result.rejection === "not_retail" ? "فقط محصولات منتشرشدهٔ خرده‌فروشی قابل تعریف هستند."
        : "ثبت رابطه ممکن نشد.";
      flash(note);
      return;
    }
    flash(level ? `هماهنگی «${target.name}» به «${RELATION_LABEL[level]}» تغییر کرد.` : `رابطه با «${target.name}» حذف شد.`);
  };

  const levelOf = (productId: string, colorId: string): RelationLevel | null => {
    const hit = sourceRelations.find((r) =>
      (r.a.productId === productId && r.a.colorId === colorId) || (r.b.productId === productId && r.b.colorId === colorId));
    return hit?.level ?? null;
  };

  return (
    <div className="space-y-4">
      {/* source colour variant selection — always first (§25) */}
      <div className="rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-3.5">
        <p className="text-[12.5px] font-extrabold">رنگ مبدأ: {source.name}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="انتخاب رنگ مبدأ">
          {source.colors.map((color) => (
            <button key={color.id} onClick={() => setSourceColorId(color.id)} aria-pressed={sourceColorId === color.id}
              className={cn("kv-press flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-bold",
                sourceColorId === color.id ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)]")}>
              <span className="h-3 w-3 rounded-full border border-[var(--kv-line)]" style={{ background: color.hex }} />
              {color.name}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[var(--kv-muted)]">{fmtNum(sourceRelations.length)} رابطه برای این رنگ ثبت شده است.</p>
      </div>

      {/* target browser */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1"><SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="جست‌وجوی محصول هدف…" /></div>
        <label className="flex items-center gap-1.5 text-[11.5px] font-bold text-[var(--kv-muted)]">
          <input type="checkbox" checked={inStockOnly} onChange={(e) => { setInStockOnly(e.target.checked); setPage(1); }} className="h-3.5 w-3.5 accent-[#C1613B]" />فقط موجودها
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] font-bold text-[var(--kv-muted)]">
          <input type="checkbox" checked={definedOnly} onChange={(e) => { setDefinedOnly(e.target.checked); setPage(1); }} className="h-3.5 w-3.5 accent-[#C1613B]" />فقط روابط تعریف‌شده
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="دستهٔ محصول هدف">
        {["همه", ...categories].map((name) => (
          <button key={name} onClick={() => { setCat(name); setPage(1); }} aria-pressed={cat === name}
            className={cn("kv-press rounded-full border px-3 py-1 text-[11px] font-bold", cat === name ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>
            {name}
          </button>
        ))}
      </div>

      <div className="space-y-2" aria-label="فهرست محصول هدف">
        {visible.length === 0 && <p className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-4 text-center text-[12px] text-[var(--kv-muted)]">محصولی برای این فیلترها نیست.</p>}
        {visible.map((target) => {
          const open = expanded === target.id;
          const defined = target.colors.filter((c) => levelOf(target.id, c.id)).length;
          return (
            <div key={target.id} className="rounded-[12px] border border-[var(--kv-line)]">
              <button onClick={() => setExpanded(open ? null : target.id)} aria-expanded={open}
                className="flex w-full items-center gap-3 p-2.5 text-right hover:bg-[var(--kv-surface-2)]/40">
                <ChevronDown size={15} className={cn("shrink-0 text-[var(--kv-muted)] transition-transform", open && "rotate-180")} />
                <img src={target.images[0]} alt="" className="h-11 w-9 shrink-0 rounded-[8px] object-cover" />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[12.5px]">{target.name}</b>
                  <span className="text-[10.5px] text-[var(--kv-muted)]">{target.category} · {fmtMoney(target.retailPrice)}</span>
                </span>
                <span className="shrink-0 rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10px] font-bold text-[var(--kv-muted)]">
                  {fmtNum(target.colors.length)} رنگ{defined ? ` · ${fmtNum(defined)} رابطه` : ""}
                </span>
              </button>
              {open && (
                <div className="space-y-1.5 border-t border-[var(--kv-line)] p-2.5">
                  {target.colors.map((color) => {
                    const current = levelOf(target.id, color.id);
                    return (
                      <div key={color.id} className="flex flex-wrap items-center gap-2 rounded-[10px] bg-[var(--kv-surface-2)]/40 px-2.5 py-2">
                        <span className="flex min-w-[90px] items-center gap-1.5 text-[11.5px] font-bold">
                          <span className="h-3 w-3 rounded-full border border-[var(--kv-line)]" style={{ background: color.hex }} />
                          {color.name}
                        </span>
                        <span className="flex flex-wrap gap-1" role="group" aria-label={`هماهنگی با ${color.name}`}>
                          {LEVELS.map((level) => (
                            <button key={level} onClick={() => setLevel(target, color.id, current === level ? null : level)}
                              aria-pressed={current === level}
                              className={cn("kv-press rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-all",
                                current === level ? LEVEL_TONE[level] : "border border-[var(--kv-line)] text-[var(--kv-muted)]")}>
                              {RELATION_LABEL[level]}
                            </button>
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {visible.length < targets.length && (
          <Btn variant="soft" size="sm" className="w-full" onClick={() => setPage((p) => p + 1)}>نمایش بیشتر ({fmtNum(targets.length - visible.length)} محصول دیگر)</Btn>
        )}
      </div>

      {/* productivity (§29) */}
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-dashed border-[var(--kv-line)] p-3">
        {otherColors.length > 0 && (
          <>
            <select aria-label="کپی روابط از رنگ دیگر" onChange={(e) => {
              const from = e.target.value;
              if (!from) return;
              const count = copyVariantRelations({ productId: source.id, colorId: from }, source.colors.filter((c) => c.id !== from).map((c) => ({ productId: source.id, colorId: c.id })));
              flash(`${fmtNum(count)} رابطه از رنگ دیگر کپی شد.`);
              e.target.value = "";
            }} className="h-9 rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2.5 text-[11.5px] font-bold">
              <option value="">کپی روابط از رنگ…</option>
              {otherColors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Btn variant="soft" size="sm" icon={<Layers size={13} />} onClick={() => {
              const count = copyVariantRelations(sourceRef, source.colors.filter((c) => c.id !== sourceColorId).map((c) => ({ productId: source.id, colorId: c.id })));
              flash(count ? `روابط این رنگ روی ${fmtNum(count)} رنگ دیگر اعمال شد.` : "روابط جدیدی برای کپی نبود.");
            }}>اعمال به همه رنگ‌ها</Btn>
          </>
        )}
        <p className="mr-auto text-[10.5px] leading-5 text-[var(--kv-muted)]">روابط در سطح رنگ تعریف می‌شوند؛ سایزها وارد این تعریف نمی‌شوند.</p>
      </div>
    </div>
  );
}

/* ============================================================
   2. Curated Style studio (admin tab)
   ============================================================ */

const blankStyle = (): CuratedStyle => ({
  id: `cs-${Date.now()}`,
  slug: "",
  title: "",
  description: "",
  status: "draft",
  items: [],
  cover: undefined,
  pricing: { ...DEFAULT_PRICING },
  installments: { ...DEFAULT_INSTALLMENTS },
  createdAt: new Date().toLocaleDateString("fa-IR"),
  updatedAt: new Date().toLocaleDateString("fa-IR"),
});

export function CuratedStyleStudio({ flash }: { flash: F }) {
  const store = useStore();
  const { products, curatedStyles, upsertCuratedStyle, setCuratedStyleStatus, removeCuratedStyle } = store;
  const catalogue = useMemo(() => products.filter(curatableProduct), [products]);

  const [draft, setDraft] = useState<CuratedStyle | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);

  const issues = useMemo(() => (draft ? validateCuratedStyle(draft, catalogue) : []), [draft, catalogue]);
  const preview = useMemo(() => (draft && draft.items.length ? previewCompatibility(draft, catalogue, store.variantRelations) : null), [draft, catalogue, store.variantRelations]);
  const priced = useMemo(() => (draft ? resolveLines({ ...draft, status: "draft" }, catalogue) : null), [draft, catalogue]);
  const discount = useMemo(() => (draft && priced ? assessDiscount(draft, priced.lines) : null), [draft, priced]);
  const installments = useMemo(() => (draft && priced && discount ? assessInstallments(draft, priced.lines, discount) : null), [draft, priced, discount]);

  const patch = (p: Partial<CuratedStyle>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const patchItem = (id: string, p: Partial<CuratedStyleItem>) => setDraft((d) => (d ? { ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...p } : i)) } : d));

  const addItem = (product: Product) => {
    setDraft((d) => {
      if (!d || d.items.some((i) => i.productId === product.id)) return d;
      const role = outfitRoleOf(product);
      const taken = new Set(d.items.map((i) => i.role));
      const finalRole = taken.has(role) ? undefined : role;
      const item: CuratedStyleItem = {
        id: `csi-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
        productId: product.id,
        colorId: product.colors[0]?.id ?? "",
        role: finalRole ?? "accessory",
        sortOrder: d.items.length + 1,
      };
      return { ...d, items: [...d.items, item] };
    });
  };

  const move = (id: string, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d;
      const items = [...d.items].sort((a, b) => a.sortOrder - b.sortOrder);
      const index = items.findIndex((i) => i.id === id);
      const swapWith = index + dir;
      if (index < 0 || swapWith < 0 || swapWith >= items.length) return d;
      [items[index], items[swapWith]] = [items[swapWith], items[index]];
      return { ...d, items: items.map((item, i) => ({ ...item, sortOrder: i + 1 })) };
    });
  };

  const save = (status?: CuratedStyle["status"]) => {
    if (!draft) return;
    const next = status ? { ...draft, status } : draft;
    const result = upsertCuratedStyle(next);
    if (!result.ok) {
      flash(result.issues[0]?.note ?? "ذخیره استایل ممکن نشد.");
      return;
    }
    setDraft(next);
    flash(status === "published" ? `استایل «${next.title}» منتشر شد.` : status === "archived" ? "استایل آرشیو شد." : "استایل ذخیره شد.");
  };

  const targets = catalogue.filter((p) => !q.trim() || p.name.includes(q.trim()) || p.brand.includes(q.trim())).slice(0, page * 6);

  return (
    <div className="animate-[fadeUp_0.35s_ease]">
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Btn variant="accent" size="sm" icon={<Plus size={15} />} onClick={() => { setDraft(blankStyle()); setPage(1); }}>استایل جدید</Btn>
        {draft && <Btn variant="soft" size="sm" onClick={() => setDraft(null)}>بستن ویرایشگر</Btn>}
        <p className="mr-auto text-[11.5px] text-[var(--kv-muted)]">{fmtNum(curatedStyles.length)} استایل ثبت شده</p>
      </div>

      {/* ── styles list ── */}
      {!draft && (
        <Card className="overflow-hidden">
          <div className="kv-scroll overflow-x-auto">
            <table className="kv-table min-w-[760px]">
              <thead><tr><th>استایل</th><th>قطعات</th><th>جمع قطعات (زنده)</th><th>قسط</th><th>وضعیت</th><th></th></tr></thead>
              <tbody>
                {curatedStyles.map((style) => {
                  const resolved = resolveLines(style, catalogue);
                  const subtotal = subtotalOf(resolved.lines);
                  const inst = assessInstallments(style, resolved.lines, assessDiscount(style, resolved.lines));
                  return (
                    <tr key={style.id}>
                      <td>
                        <span className="flex items-center gap-2.5">
                          {style.cover ? <img src={style.cover} alt="" className="h-10 w-9 rounded-lg object-cover" /> : <span className="flex h-10 w-9 items-center justify-center rounded-lg bg-[var(--kv-surface-2)]"><Wand2 size={14} className="text-[var(--kv-muted)]" /></span>}
                          <span><b className="block whitespace-nowrap">{style.title}</b><span className="text-[11px] text-[var(--kv-muted)]" dir="ltr">{style.slug}</span></span>
                        </span>
                        {resolved.dropped.length > 0 && <span className="mt-0.5 block text-[10px] font-bold text-[var(--kv-danger)]">{fmtNum(resolved.dropped.length)} قطعه ناموجود در فروشگاه</span>}
                      </td>
                      <td className="tabular-nums">{fmtNum(style.items.length)}</td>
                      <td className="tabular-nums font-bold">{fmtMoney(subtotal)}</td>
                      <td className="tabular-nums text-[12px]">{inst.mode === "none" ? "—" : `۴ × ${fmtMoney(inst.perInstallment)}`}</td>
                      <td><span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", style.status === "published" ? "bg-[var(--kv-success)]/10 text-[var(--kv-success)]" : style.status === "draft" ? "bg-[var(--kv-surface-2)] text-[var(--kv-muted)]" : "bg-[var(--kv-danger)]/10 text-[var(--kv-danger)]")}>{CURATED_STATUS_LABEL[style.status]}</span></td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <button onClick={() => setDraft(structuredClone(style))} className="text-[12px] font-bold text-[var(--kv-accent)]">ویرایش</button>
                          {style.status !== "published" && <button onClick={() => { setCuratedStyleStatus(style.id, "published"); flash(`«${style.title}» منتشر شد.`); }} className="text-[12px] font-bold text-[var(--kv-success)]">انتشار</button>}
                          {style.status === "published" && <button onClick={() => { setCuratedStyleStatus(style.id, "archived"); flash(`«${style.title}» از فروشگاه آرشیو شد.`); }} className="text-[12px] font-bold text-[var(--kv-muted)]">آرشیو</button>}
                          <button onClick={() => { removeCuratedStyle(style.id); flash("استایل حذف شد."); }} aria-label={`حذف ${style.title}`} className="text-[var(--kv-faint)] hover:text-[var(--kv-danger)]"><Trash2 size={14} /></button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {curatedStyles.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-[12px] text-[var(--kv-muted)]">هنوز استایلی تعریف نشده است.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── editor: the 9-step flow as one form (§37) ── */}
      {draft && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            {/* ۱ اطلاعات استایل */}
            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۱. اطلاعات استایل</p>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="عنوان استایل"><Input value={draft.title} onChange={(v) => patch({ title: v })} placeholder="مثلاً ست ترنچ و پیراهن" /></Field>
                <div dir="ltr"><Field label="نک لاتین (آدرس)" hint="برای صفحهٔ عمومی استایل"><Input value={draft.slug} onChange={(v) => patch({ slug: v.replace(/[^a-z0-9-]/gi, "-").toLowerCase() })} placeholder="trench-and-shirt" /></Field></div>
                <div className="md:col-span-2"><Field label="توضیح"><Textarea value={draft.description} onChange={(v) => patch({ description: v })} placeholder="این استایل برای کجاست؟" /></Field></div>
              </div>
            </Card>

            {/* ۲ انتخاب محصولات */}
            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۲. انتخاب محصولات</p>
              <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="جست‌وجو در محصولات خرده…" />
              <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                {targets.map((product) => {
                  const added = draft.items.some((i) => i.productId === product.id);
                  return (
                    <button key={product.id} onClick={() => addItem(product)} disabled={added}
                      className={cn("kv-press flex items-center gap-2.5 rounded-[11px] border p-2 text-right", added ? "border-[var(--kv-success)]/40 opacity-60" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                      <img src={product.images[0]} alt="" className="h-10 w-9 rounded-[8px] object-cover" />
                      <span className="min-w-0 flex-1"><b className="block truncate text-[12px]">{product.name}</b><span className="text-[10.5px] tabular-nums text-[var(--kv-muted)]">{fmtMoney(product.retailPrice)}</span></span>
                      {added ? <Check size={14} className="text-[var(--kv-success)]" /> : <Plus size={14} className="text-[var(--kv-muted)]" />}
                    </button>
                  );
                })}
              </div>
              {targets.length < catalogue.length && <Btn variant="soft" size="sm" className="mt-2" onClick={() => setPage((p) => p + 1)}>نمایش بیشتر</Btn>}
            </Card>

            {/* ۳–۴ رنگ، نقش و ترتیب */}
            {draft.items.length > 0 && (
              <Card className="p-4">
                <p className="mb-3 text-[13px] font-extrabold">۳ و ۴. رنگ پین‌شده، نقش و ترتیب</p>
                <div className="space-y-2">
                  {[...draft.items].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => {
                    const product = catalogue.find((p) => p.id === item.productId);
                    if (!product) return null;
                    return (
                      <div key={item.id} className="rounded-[12px] border border-[var(--kv-line)] p-2.5">
                        <div className="flex items-center gap-2.5">
                          <img src={product.images[0]} alt="" className="h-11 w-9 rounded-[8px] object-cover" />
                          <div className="min-w-0 flex-1">
                            <b className="block truncate text-[12px]">{product.name}</b>
                            <span className="text-[10.5px] text-[var(--kv-muted)]">{fmtMoney(product.retailPrice)}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button onClick={() => move(item.id, -1)} aria-label="انتقال به بالا" className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-[var(--kv-line)]"><ArrowUp size={12} /></button>
                            <button onClick={() => move(item.id, 1)} aria-label="انتقال به پایین" className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-[var(--kv-line)]"><ArrowDown size={12} /></button>
                            <button onClick={() => patch({ items: draft.items.filter((i) => i.id !== item.id).map((i, idx) => ({ ...i, sortOrder: idx + 1 })) })} aria-label={`حذف ${product.name}`} className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-[var(--kv-line)] text-[var(--kv-danger)]"><Trash2 size={12} /></button>
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div>
                            <p className="mb-1 text-[10.5px] font-bold text-[var(--kv-muted)]">رنگ پین‌شده (برای خرید ثابت است)</p>
                            <div className="flex flex-wrap gap-1">
                              {product.colors.map((color) => (
                                <button key={color.id} onClick={() => patchItem(item.id, { colorId: color.id })} aria-pressed={item.colorId === color.id}
                                  className={cn("kv-press flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-bold", item.colorId === color.id ? "border-[var(--kv-accent)]" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>
                                  <span className="h-2.5 w-2.5 rounded-full border border-[var(--kv-line)]" style={{ background: color.hex }} />{color.name}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div>
                            <p className="mb-1 text-[10.5px] font-bold text-[var(--kv-muted)]">نقش در استایل</p>
                            <select aria-label={`نقش ${product.name}`} value={item.role}
                              onChange={(e) => patchItem(item.id, { role: e.target.value as CuratedStyleItem["role"] })}
                              className="h-8 w-full rounded-[9px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-2 text-[11.5px] font-bold">
                              {CURATED_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABEL[role]}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* ۶ قیمت‌گذاری */}
            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۶. قیمت‌گذاری استایل</p>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label="نوع تخفیف">
                  <select aria-label="نوع تخفیف" value={draft.pricing.discountType} onChange={(e) => patch({ pricing: { ...draft.pricing, discountType: e.target.value as CuratedStyle["pricing"]["discountType"] } })}
                    className="h-10 w-full rounded-[10px] border border-[var(--kv-line)] bg-[var(--kv-surface)] px-3 text-[12.5px] font-bold">
                    <option value="none">بدون تخفیف</option>
                    <option value="percentage">درصدی</option>
                    <option value="fixed">مبلغ ثابت</option>
                  </select>
                </Field>
                {draft.pricing.discountType !== "none" && (
                  <Field label={draft.pricing.discountType === "percentage" ? "درصد تخفیف" : "مبلغ تخفیف (تومان)"}>
                    <Input type="number" value={String(draft.pricing.discountValue || "")} onChange={(v) => patch({ pricing: { ...draft.pricing, discountValue: Number(v) || 0 } })} />
                  </Field>
                )}
                <Field label="حداقل اقلام فعال برای تخفیف">
                  <Input type="number" value={String(draft.pricing.minimumActiveItems || "")} onChange={(v) => patch({ pricing: { ...draft.pricing, minimumActiveItems: Math.max(0, Number(v) || 0) } })} />
                </Field>
              </div>
              {draft.pricing.discountType !== "none" && (
                <div className="mt-2">
                  <p className="mb-1.5 text-[11px] font-bold text-[var(--kv-muted)]">قطعات الزامی برای اعتبار تخفیف</p>
                  <div className="flex flex-wrap gap-1">
                    {CURATED_ROLES.filter((role) => draft.items.some((i) => i.role === role)).map((role) => {
                      const on = draft.pricing.requiredCoreItems.includes(role);
                      return (
                        <button key={role} onClick={() => patch({ pricing: { ...draft.pricing, requiredCoreItems: on ? draft.pricing.requiredCoreItems.filter((r) => r !== role) : [...draft.pricing.requiredCoreItems, role] } })} aria-pressed={on}
                          className={cn("kv-press rounded-full border px-2.5 py-1 text-[10.5px] font-bold", on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/10" : "border-[var(--kv-line)] text-[var(--kv-muted)]")}>
                          {ROLE_LABEL[role]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>

            {/* ۷ اقساط */}
            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۷. تنظیم اقساط</p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-[12.5px] font-bold">
                  <Switch on={draft.installments.installmentEnabled} onToggle={() => patch({ installments: { ...draft.installments, installmentEnabled: !draft.installments.installmentEnabled } })} />
                  خرید اقساطی فعال باشد
                </label>
                {draft.installments.installmentEnabled && (
                  <>
                    <label className="flex items-center gap-2 text-[12px] font-bold text-[var(--kv-muted)]">
                      <input type="radio" name="inst-mode" checked={draft.installments.installmentPricingMode === "automatic"} onChange={() => patch({ installments: { ...draft.installments, installmentPricingMode: "automatic" } })} />
                      خودکار (جمع قطعات ÷ ۴)
                    </label>
                    <label className="flex items-center gap-2 text-[12px] font-bold text-[var(--kv-muted)]">
                      <input type="radio" name="inst-mode" checked={draft.installments.installmentPricingMode === "manual"} onChange={() => patch({ installments: { ...draft.installments, installmentPricingMode: "manual" } })} />
                      دستی
                    </label>
                  </>
                )}
              </div>
              {draft.installments.installmentEnabled && draft.installments.installmentPricingMode === "manual" && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <Field label="جمع مبلغ اقساط دستی (تومان)" hint="فقط برای ترکیب کامل استایل معتبر است؛ با حذف هر قطعه به محاسبهٔ خودکار برمی‌گردد.">
                    <Input type="number" value={draft.installments.manualInstallmentTotal ? String(draft.installments.manualInstallmentTotal) : ""} onChange={(v) => patch({ installments: { ...draft.installments, manualInstallmentTotal: Number(v) || undefined } })} />
                  </Field>
                  <p className="self-end text-[11.5px] leading-6 text-[var(--kv-muted)]">
                    نمایش: ۴ × {fmtMoney(Math.ceil((draft.installments.manualInstallmentTotal ?? 0) / 4))}
                  </p>
                </div>
              )}
              {draft.installments.installmentEnabled && draft.installments.installmentPricingMode === "automatic" && (
                <label className="mt-3 flex items-center gap-2 text-[12px] font-bold text-[var(--kv-muted)]">
                  <input type="checkbox" checked={draft.installments.applyStyleDiscountToInstallments} onChange={(e) => patch({ installments: { ...draft.installments, applyStyleDiscountToInstallments: e.target.checked } })} className="h-3.5 w-3.5 accent-[#C1613B]" />
                  تخفیف استایل روی مبلغ اقساط هم اعمال شود
                </label>
              )}
            </Card>

            {/* ۸ کاور */}
            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۸. کاور استایل</p>
              {draft.items.length === 0 ? <p className="text-[11.5px] text-[var(--kv-muted)]">ابتدا محصولات را انتخاب کنید؛ کاور از تصاویر همین قطعات انتخاب می‌شود.</p> : (
                <div className="flex flex-wrap gap-2">
                  {[...new Set(draft.items.map((i) => catalogue.find((p) => p.id === i.productId)?.images[0]).filter(Boolean))].map((img) => (
                    <button key={img} onClick={() => patch({ cover: img })} aria-pressed={draft.cover === img}
                      className={cn("kv-press overflow-hidden rounded-[10px] border-2", draft.cover === img ? "border-[var(--kv-accent)]" : "border-transparent")}>
                      <img src={img} alt="" className="h-20 w-16 object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* side: preview + compatibility + publish (۵ و ۹) */}
          <div className="space-y-4">
            <Card className="p-4 xl:sticky xl:top-20">
              <p className="mb-3 text-[13px] font-extrabold">۵. پیش‌نمایش و هماهنگی</p>
              {draft.items.length === 0 ? (
                <p className="text-[11.5px] leading-6 text-[var(--kv-muted)]">برای دیدن پیش‌نمایش، دست‌کم دو محصول انتخاب کنید.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-[12px] bg-[var(--kv-surface-2)]/50 px-3 py-2.5">
                    <span className="text-[12px] font-bold text-[var(--kv-muted)]">هماهنگی استایل</span>
                    <span className="text-[15px] font-extrabold tabular-nums">{fmtNum(preview?.score ?? 0)}<span className="text-[10.5px] font-bold text-[var(--kv-muted)]"> / ۱۰۰</span></span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {preview?.reasons.map((reason) => <li key={reason} className="text-[11.5px] font-bold text-[var(--kv-success)]">{reason}</li>)}
                    {preview?.warnings.map((warning) => <li key={warning} className="text-[11.5px] font-bold text-[var(--kv-accent)]">{warning}</li>)}
                  </ul>
                  <div className="mt-3 space-y-1.5 border-t border-[var(--kv-line)] pt-3 text-[12px]">
                    <div className="flex justify-between"><span className="text-[var(--kv-muted)]">جمع قطعات (قیمت زنده)</span><b className="tabular-nums">{fmtMoney(priced ? subtotalOf(priced.lines) : 0)}</b></div>
                    {discount?.eligible && <div className="flex justify-between text-[var(--kv-success)]"><span>تخفیف استایل</span><span className="tabular-nums">−{fmtMoney(discount.discount)}</span></div>}
                    {installments && installments.mode !== "none" && (
                      <div className="flex justify-between"><span className="text-[var(--kv-muted)]">اقساط ({installments.mode === "manual" ? "دستی" : "خودکار"})</span><span className="tabular-nums font-bold">۴ × {fmtMoney(installments.perInstallment)}</span></div>
                    )}
                    {installments?.manualInvalidReason && <p className="text-[10.5px] leading-5 text-[var(--kv-accent)]">{installments.manualInvalidReason}</p>}
                  </div>
                </>
              )}
            </Card>

            <Card className="p-4">
              <p className="mb-3 text-[13px] font-extrabold">۹. ذخیره و انتشار</p>
              {issues.length > 0 && (
                <ul className="mb-3 space-y-1 rounded-[10px] bg-[var(--kv-danger)]/[0.06] p-2.5">
                  {issues.map((issue, i) => <li key={i} className="text-[11px] font-bold text-[var(--kv-danger)]">· {issue.note}</li>)}
                </ul>
              )}
              <div className="grid gap-2">
                <Btn variant="soft" onClick={() => save()} disabled={!!issues.length}>ذخیره پیش‌نویس</Btn>
                <Btn variant="accent" icon={<Sparkles size={15} />} disabled={!!issues.length} onClick={() => save("published")}>انتشار در فروشگاه</Btn>
                {draft.status === "published" && <Btn variant="soft" onClick={() => save("archived")}>آرشیو</Btn>}
              </div>
              <p className="mt-3 text-[10.5px] leading-5 text-[var(--kv-muted)]">
                فقط استایل‌های منتشرشده در فروشگاه عمومی دیده می‌شوند؛ پیش‌نویس‌ها هرگز از API عمومی بیرون نمی‌روند.
              </p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}


