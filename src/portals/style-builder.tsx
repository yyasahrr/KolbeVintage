/* KOLBE — Style Builder (Phase 1, Non-Core workstream)
 *
 * Answers: «چه محصولاتی با هم یک استایل کامل می‌سازند؟»
 * Virtual try-on is a different customer job and lives in its own surface —
 * it is no longer a mode or tab of this builder.
 *
 * Architecture:
 *  - ONE shared outfit state (`data/outfit.tsx`) drives wizard AND canvas:
 *    wizard selection lands on the canvas immediately and canvas removal/
 *    replacement updates the wizard immediately;
 *  - the existing StyleCanvas is preserved and wrapped (never rebuilt): drag,
 *    keyboard move, scale, layer order and non-drag removal all keep working;
 *  - the shared state owns MEMBERSHIP (which product/colour fills which role);
 *    the canvas view owns GEOMETRY (x/y/scale/z) in its own draft, so dragging
 *    a piece never mutates the outfit and re-adding a piece restores its spot;
 *  - candidates in every step are ranked by the deterministic styling engine
 *    (`data/styling.ts`) — the same engine that scores the Final Look;
 *  - "Add the outfit" reuses the EXISTING cart domain: ordinary retail cart
 *    lines, validated with the same rules as a single add, all-or-nothing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, RotateCcw, Save, ShoppingBag, Sparkles, Wand2, X } from "lucide-react";
import { fmtMoney, fmtNum, type Product } from "../data/catalog";
import { useStore } from "../data/store";
import { FAILURE_TEXT, type LineFailure } from "../data/cart";
import {
  OCCASION_LABEL, OCCASION_OPTIONS, ROLE_LABEL, STYLE_LABEL, STYLE_OPTIONS,
  assessLook, outfitRoleOf, recommendFor,
  type OutfitRole,
} from "../data/styling";
import { relationsToAdjustments } from "../data/curated";
import { useOutfit } from "../data/outfit";
import { StyleCanvas, type CanvasItem } from "./style-canvas";
import { Btn, Card } from "../components/primitives";
import { Swatches } from "../components/storefront/Swatches";
import { preferredSize, sizesOf } from "../components/storefront/shared";
import { cn } from "../utils/cn";

export type BuilderEntry = {
  productId?: string;
  colorId?: string;
  nonce?: number;
  /** «ساخت استایل شخصی» from a curated style: products + pinned colours, in wear order */
  preload?: { productId: string; colorId?: string }[];
} | null;

type StepId = "style" | "occasion" | OutfitRole | "final";

const STEP_TITLE: Record<Exclude<StepId, "final">, string> = {
  style: "سبک استایل",
  occasion: "موقعیت",
  top: "بالاتنه",
  bottom: "شلوار",
  shoes: "کفش",
  accessory: "اکسسوری",
  outerwear: "اورکت",
  dress: "پیراهن یک‌تکه",
  headwear: "کلاه",
};

/** Canvas geometry draft — presentation state, kept out of the outfit facts. */
type Geometry = Record<string, CanvasItem>;
const GEOM_KEY = "kolbe-builder-geometry-v1";
const loadGeometry = (): Geometry => {
  try { const raw = JSON.parse(sessionStorage.getItem(GEOM_KEY) || "null"); if (raw && typeof raw === "object") return raw; } catch { /* ignore */ }
  return {};
};

/**
 * Dynamic wizard order (§14):
 *  - a dress replaces top+bottom (a dress slot removes both steps);
 *  - accessories are optional and come last;
 *  - shoes are skipped when no suitable inventory exists;
 *  - a filled role keeps its step (changeable) but is no longer *missing*.
 */
function wizardSteps(hasDress: boolean, shoeInventoryExists: boolean): StepId[] {
  const steps: StepId[] = ["style", "occasion"];
  if (hasDress) steps.push("dress");
  else steps.push("top", "bottom");
  if (shoeInventoryExists) steps.push("shoes");
  steps.push("accessory", "final");
  return steps;
}

export default function StyleBuilder({ accountId, entry, onEntryConsumed, onLogin, onAddOutfit }: {
  accountId?: string;
  /** «+ استایل» preload: product (and colour context) placed before anything else */
  entry: BuilderEntry;
  onEntryConsumed: () => void;
  onLogin: () => void;
  /** existing cart domain; all-or-nothing, returns the failing products */
  onAddOutfit: (lines: { productId: string; size: string; color: string; qty: number }[]) => { ok: boolean; failures: LineFailure[] };
}) {
  const store = useStore();
  const outfit = useOutfit();
  const catalogue = useMemo(() => store.products.filter((p) => p.status === "published" && p.retailPrice > 0), [store.products]);
  const productOf = useMemo(() => {
    const map = new Map(catalogue.map((p) => [p.id, p]));
    return (id: string) => map.get(id);
  }, [catalogue]);

  const [geometry, setGeometry] = useState<Geometry>(loadGeometry);
  useEffect(() => { try { sessionStorage.setItem(GEOM_KEY, JSON.stringify(geometry)); } catch { /* ignore */ } }, [geometry]);

  /* active items: membership from the shared state, in stable role order */
  const activeItems = useMemo(() => {
    const order: OutfitRole[] = ["dress", "top", "bottom", "outerwear", "shoes", "headwear", "accessory"];
    return order
      .filter((role) => outfit.items[role] && productOf(outfit.items[role]!.productId))
      .map((role) => ({ role, product: productOf(outfit.items[role]!.productId)!, colorId: outfit.items[role]!.colorId }));
  }, [outfit.items, productOf]);

  const filledRoles = activeItems.map((item) => item.role);
  const hasDress = filledRoles.includes("dress");
  const shoeInventoryExists = catalogue.some((p) => outfitRoleOf(p) === "shoes");
  const steps = useMemo(() => wizardSteps(hasDress, shoeInventoryExists), [hasDress, shoeInventoryExists]);

  const missingStepIds = steps.filter((id) =>
    id === "style" ? !outfit.style
      : id === "occasion" ? !outfit.occasion
      : id === "final" ? false
      : !filledRoles.includes(id as OutfitRole));
  const firstMissingStep = (): StepId => missingStepIds[0] ?? "final";

  const [step, setStep] = useState<StepId>("style");
  const [wizardOpen, setWizardOpen] = useState(true);
  const [addedNote, setAddedNote] = useState<{ name: string; role: OutfitRole } | null>(null);
  const [cartError, setCartError] = useState("");
  const noteTimer = useRef<number | null>(null);
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

  /* ── «+ استایل» preload (§10): place the product, continue from the next
     missing logical step; unknown ids are never invented into items ── */
  const entryKey = `${entry?.productId ?? ""}:${entry?.colorId ?? ""}`;
  const lastEntryKey = useRef("");
  useEffect(() => {
    if (!entry?.productId || entry?.preload?.length) return;
    if (lastEntryKey.current === entryKey) return;
    lastEntryKey.current = entryKey;
    const product = productOf(entry.productId);
    onEntryConsumed();
    if (!product) return;
    const colorId = entry.colorId && product.colors.some((c) => c.id === entry.colorId) ? entry.colorId : undefined;
    const role = outfit.placeItem(product, colorId);
    setAddedNote({ name: product.name, role });
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setAddedNote(null), 3200);
    setStep((current) => (current === "style" && !outfit.style ? "style" : firstMissingStep()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  /* curated-style personalisation (§50): preload the whole composition into the
     SAME shared outfit state — replacement semantics, never duplication */
  const preloadKey = entry?.preload ? entry.preload.map((p) => `${p.productId}:${p.colorId ?? ""}`).join(">") : "";
  useEffect(() => {
    if (!entry?.preload?.length) return;
    if (lastEntryKey.current === preloadKey) return;
    lastEntryKey.current = preloadKey;
    onEntryConsumed();
    const entries = [...entry.preload];
    /* dresses first: a later top legally retires the dress (reducer rules) */
    entries.sort((a, b) => {
      const isDress = (item: { productId: string }) => {
        const product = productOf(item.productId);
        return product ? outfitRoleOf(product) === "dress" : false;
      };
      return (isDress(a) ? -1 : 0) - (isDress(b) ? -1 : 0);
    });
    let lastName = "";
    for (const item of entries) {
      const product = productOf(item.productId);
      if (!product) continue;
      const colorId = item.colorId && product.colors.some((c) => c.id === item.colorId) ? item.colorId : undefined;
      lastName = product.name;
      outfit.placeItem(product, colorId);
    }
    if (lastName) setAddedNote({ name: lastName, role: outfitRoleOf(productOf(entries[0]!.productId)!) });
    setStep(firstMissingStep());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preloadKey]);

  const stepIndex = steps.indexOf(step);
  const goNext = () => setStep(steps[Math.min(steps.length - 1, stepIndex + 1)]);
  const goBack = () => setStep(steps[Math.max(0, stepIndex - 1)]);

  /* candidates for the active role step — ranked by the one styling engine.
     Phase 2: explicit colour-variant relations (admin-authored) join the
     automatic score through the documented precedence (§30) — conflicts are
     excluded from the shortlist by the engine itself. */
  const selectionKey = JSON.stringify(outfit.items);
  const variantRelations = store.variantRelations;
  const candidates = useMemo(() => {
    if (step === "style" || step === "occasion" || step === "final") return [];
    const placed = Object.entries(outfit.items).flatMap(([, sel]) => (sel ? [{ productId: sel.productId, colorId: sel.colorId ?? "" }] : []));
    const adjustments = relationsToAdjustments(variantRelations, placed);
    return recommendFor(catalogue, { style: outfit.style, occasion: outfit.occasion, selection: outfit.items, role: step }, adjustments, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue, step, outfit.style, outfit.occasion, selectionKey, variantRelations]);

  const pickCandidate = (product: Product) => {
    outfit.placeItem(product, product.colors[0]?.id);
    setCartError("");
    goNext();
  };

  /* ── Final Look (§18) — score from the SAME engine.
     Explicit relations that touch the placed items add the curated-shop
     reason «انتخاب کلبه» on top of the automatic harmony score (§31). */
  const look = useMemo(() => {
    const base = assessLook(catalogue, outfit.items, { style: outfit.style, occasion: outfit.occasion });
    const placed = Object.entries(outfit.items).flatMap(([, sel]) => (sel ? [{ productId: sel.productId, colorId: sel.colorId ?? "" }] : []));
    const adjustments = relationsToAdjustments(variantRelations, placed);
    const strong = variantRelations.filter(
      (r) => r.level === "strong_match"
        && placed.some((p) => p.productId === r.a.productId && p.colorId === r.a.colorId)
        && placed.some((p) => p.productId === r.b.productId && p.colorId === r.b.colorId),
    ).length;
    const conflicts = adjustments.filter((a) => a.level === "conflict").length;
    const reasons = [...base.reasons];
    if (strong) reasons.unshift(`انتخاب کلبه`);
    if (conflicts) reasons.push("⚠ هماهنگی ضعیف بین دو قطعه");
    return { ...base, reasons: reasons.slice(0, 5) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue, selectionKey, outfit.style, outfit.occasion, variantRelations]);
  const total = activeItems.reduce((sum, item) => sum + item.product.retailPrice, 0);

  /* per-item size — required by the existing cart lines */
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const activeIds = activeItems.map((i) => i.product.id).join(",");
  useEffect(() => {
    setSizes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const item of activeItems) {
        if (!next[item.product.id]) {
          const list = sizesOf(item.product);
          next[item.product.id] = list.length ? preferredSize(list) : "";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIds]);

  const missingSize = activeItems.filter((item) => sizesOf(item.product).length > 0 && !sizes[item.product.id]);
  const pendingLines = activeItems.map((item) => ({
    productId: item.product.id,
    size: sizes[item.product.id] ?? "",
    color: item.product.colors.find((c) => c.id === item.colorId)?.name ?? item.product.colors[0]?.name ?? "",
    qty: 1,
  }));

  /* ── Add the outfit: all-or-nothing through the EXISTING cart rules (§19) ── */
  const [addedFlash, setAddedFlash] = useState(false);
  const addOutfit = () => {
    setCartError("");
    if (!activeItems.length) return;
    if (missingSize.length) {
      setCartError(`سایز ${missingSize.map((item) => item.product.name).join("، ")} را انتخاب کنید.`);
      return;
    }
    const result = onAddOutfit(pendingLines);
    if (!result.ok) {
      const names = result.failures.map((f) => `${productOf(f.productId)?.name ?? "محصول"}: ${FAILURE_TEXT[f.reason]}`).join(" · ");
      setCartError(`این استایل اضافه نشد — ${names}. هیچ قلمی به سبد اضافه نشد.`);
      return;
    }
    setAddedFlash(true);
    window.setTimeout(() => setAddedFlash(false), 2600);
  };

  /* canvas items: membership (shared state) + geometry (view draft) */
  const canvasItems: CanvasItem[] = activeItems.map((item, index) => {
    const g = geometry[item.product.id];
    return {
      id: item.product.id,
      x: g?.x ?? 30 + (index * 17) % 45,
      y: g?.y ?? 45 + (index * 9) % 15,
      scale: g?.scale ?? 1,
      z: g?.z ?? index + 1,
    };
  });
  const onCanvasChange = (next: CanvasItem[]) => {
    /* geometry always follows the canvas */
    setGeometry((prev) => {
      const merged: Geometry = {};
      for (const item of next) merged[item.id] = item;
      /* keep geometry of temporarily removed pieces so re-adding restores the spot */
      for (const [id, item] of Object.entries(prev)) if (!merged[id]) merged[id] = item;
      return merged;
    });
    /* membership: diff against the shared state (both directions, §13) */
    const before = new Set(activeItems.map((i) => i.product.id));
    const after = new Set(next.map((i) => i.id));
    for (const item of activeItems) {
      if (!after.has(item.product.id)) outfit.removeProduct(item.product.id);
    }
    for (const canvasItem of next) {
      if (!before.has(canvasItem.id)) {
        const product = productOf(canvasItem.id);
        if (product) outfit.placeItem(product, product.colors[0]?.id);
      }
    }
    setCartError("");
  };

  const onFinal = step === "final";

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-44 pt-6 md:px-8 lg:pb-20">
      {/* header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--kv-accent)]"><Sparkles size={14} />استایل‌بیلدر کلبه</p>
          <h1 className="kv-editorial-title mt-1.5 text-[24px] md:text-[28px]">یک استایل کامل بساز</h1>
          <p className="mt-1 text-[13px] text-[var(--kv-muted)]">گام‌به‌گام انتخاب کنید؛ هر انتخابی همان لحظه روی بوم می‌نشیند و حذف روی بوم هم همین‌طور.</p>
        </div>
        <div className="flex gap-2">
          <Btn variant="soft" size="sm" icon={<RotateCcw size={15} />} disabled={!activeItems.length && !outfit.style && !outfit.occasion}
            onClick={() => { outfit.clear(); setStep("style"); setCartError(""); }}>
            پاک‌سازی
          </Btn>
          <Btn variant="soft" size="sm" icon={<Save size={15} />} disabled={!activeItems.length}
            onClick={() => { if (!accountId) { onLogin(); return; } store.saveStyle(accountId, activeItems.map((i) => i.product.id), `استایل ${new Date().toLocaleDateString("fa-IR")}`); }}>
            {accountId ? "ذخیره در حساب من" : "ورود و ذخیره"}
          </Btn>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_350px]">
        {/* ── canvas column: the preserved StyleCanvas in controlled mode ── */}
        <div>
          {addedNote && (
            <div role="status" className="kv-glass mb-3 flex w-fit items-center gap-2 rounded-[12px] px-4 py-2.5 text-[13px] font-bold">
              <Check size={15} className="text-[var(--kv-success)]" />
              {addedNote.name} به نقش «{ROLE_LABEL[addedNote.role]}» اضافه شد
            </div>
          )}
          <StyleCanvas
            items={canvasItems}
            onItemsChange={onCanvasChange}
            pickable={catalogue}
          />
        </div>

        {/* ── wizard column ── */}
        <div>
          {wizardOpen ? (
            <Card className="p-0 lg:sticky lg:top-24">
              {/* step rail — every prior step stays reachable (change selections, §14) */}
              <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--kv-line)] px-4 pb-3 pt-4" role="tablist" aria-label="گام‌های ساخت استایل">
                {steps.map((id) => {
                  const done = id === "style" ? !!outfit.style
                    : id === "occasion" ? !!outfit.occasion
                    : id === "final" ? false
                    : filledRoles.includes(id as OutfitRole);
                  const current = id === step;
                  return (
                    <button key={id} role="tab" aria-selected={current} onClick={() => setStep(id)}
                      className={cn("kv-press rounded-full px-3 py-1.5 text-[11.5px] font-bold transition-all",
                        current ? "bg-[var(--kv-action)] text-[var(--kv-bg)] dark:text-[#0E1527]"
                          : done ? "border border-[var(--kv-success)]/50 text-[var(--kv-success)]"
                          : "border border-[var(--kv-line)] text-[var(--kv-muted)]")}>
                      {id === "final" ? "نمای نهایی" : STEP_TITLE[id]}
                    </button>
                  );
                })}
              </div>

              <div className="p-4">
                {step === "style" && (
                  <div>
                    <p className="text-[14px] font-extrabold">چه سبکی می‌خواهی؟</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {STYLE_OPTIONS.map((key) => (
                        <button key={key} onClick={() => outfit.setStyle(outfit.style === key ? undefined : key)} aria-pressed={outfit.style === key}
                          className={cn("kv-press rounded-full px-4 py-2 text-[12.5px] font-bold", outfit.style === key ? "bg-[var(--kv-accent)] text-white" : "border border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                          {STYLE_LABEL[key]}
                        </button>
                      ))}
                    </div>
                    <Btn variant="accent" className="mt-4 w-full" onClick={goNext} icon={<ArrowLeft size={16} />}>ادامه</Btn>
                  </div>
                )}

                {step === "occasion" && (
                  <div>
                    <p className="text-[14px] font-extrabold">برای کجا؟</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {OCCASION_OPTIONS.map((key) => (
                        <button key={key} onClick={() => outfit.setOccasion(outfit.occasion === key ? undefined : key)} aria-pressed={outfit.occasion === key}
                          className={cn("kv-press rounded-full px-4 py-2 text-[12.5px] font-bold", outfit.occasion === key ? "bg-[var(--kv-accent)] text-white" : "border border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                          {OCCASION_LABEL[key]}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 flex gap-2">
                      <Btn variant="soft" className="flex-1" onClick={goBack} icon={<ArrowRight size={16} />}>قبلی</Btn>
                      <Btn variant="accent" className="flex-1" onClick={goNext} icon={<ArrowLeft size={16} />}>ادامه</Btn>
                    </div>
                  </div>
                )}

                {(step === "top" || step === "bottom" || step === "shoes" || step === "accessory" || step === "dress") && (
                  <RoleStep
                    role={step}
                    candidates={candidates}
                    selection={outfit.items}
                    onPick={pickCandidate}
                    onColor={(role, colorId) => {
                      const item = outfit.items[role];
                      const product = item && productOf(item.productId);
                      if (product) outfit.replaceRole(role, product, colorId);
                    }}
                    onRemove={() => outfit.removeRole(step as OutfitRole)}
                    onBack={goBack}
                    onNext={goNext}
                    catalogue={catalogue}
                    emptyNote={
                      step === "shoes" ? "فعلاً کفشی در آرشیو خرده نیست؛ می‌توانید این گام را رد کنید."
                        : step === "bottom" ? "فعلاً شلواری در آرشیو خرده منتشر نشده؛ می‌توانید این گام را رد کنید."
                        : undefined
                    }
                  />
                )}

                {step === "final" && (
                  <FinalLook
                    items={activeItems}
                    sizes={sizes}
                    onSize={(productId, size) => setSizes((prev) => ({ ...prev, [productId]: size }))}
                    onColor={(role, colorId) => {
                      const item = outfit.items[role];
                      const product = item && productOf(item.productId);
                      if (product) outfit.replaceRole(role, product, colorId);
                    }}
                    onChangeRole={(role) => setStep(role)}
                    onRemove={(role) => outfit.removeRole(role)}
                    look={look}
                    total={total}
                    styleLabel={outfit.style ? STYLE_LABEL[outfit.style] : undefined}
                    occasionLabel={outfit.occasion ? OCCASION_LABEL[outfit.occasion] : undefined}
                    missingSizeCount={missingSize.length}
                    onBack={goBack}
                    onAdd={addOutfit}
                    addedFlash={addedFlash}
                    cartError={cartError}
                  />
                )}
              </div>
            </Card>
          ) : (
            <button onClick={() => setWizardOpen(true)} className="kv-glass flex w-full items-center justify-between rounded-[16px] px-5 py-4 text-right" aria-expanded="false">
              <span className="flex items-center gap-2 text-[13.5px] font-extrabold"><Wand2 size={16} className="text-[var(--kv-accent)]" />ادامهٔ ساخت استایل</span>
              <ChevronDown size={18} className="-rotate-90 text-[var(--kv-muted)]" />
            </button>
          )}

          {/* after Final Look the wizard collapses but stays reopenable (§18) */}
          {onFinal && wizardOpen && (
            <button onClick={() => setWizardOpen(false)} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-[var(--kv-line)] py-2.5 text-[12.5px] font-bold text-[var(--kv-muted)] hover:text-[var(--kv-ink)]">
              <X size={14} />بستن راهنما — بوم برای ویرایش باز می‌ماند
            </button>
          )}
        </div>
      </div>

      {/* sticky mobile summary — the canvas never disappears behind it (§20) */}
      <div className="kv-sb-buybar fixed inset-x-0 bottom-[calc(var(--kvaf-bottomnav-space,64px)_+_env(safe-area-inset-bottom,0px))] z-30 border-t border-[var(--kv-line)] bg-[var(--kv-surface)]/95 px-4 py-3 backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-[640px] items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-[var(--kv-muted)]">{fmtNum(activeItems.length)} قلم در استایل</p>
            <p className="truncate text-[13.5px] font-extrabold tabular-nums">{fmtMoney(total)}</p>
          </div>
          <Btn variant="accent" size="sm" icon={<ShoppingBag size={15} />} disabled={!activeItems.length || !!missingSize.length} onClick={addOutfit}>
            {missingSize.length ? "انتخاب سایز" : "افزودن به سبد"}
          </Btn>
          <button onClick={() => { const open = !wizardOpen; setWizardOpen(open); if (open) window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--kv-line)]"
            aria-label={wizardOpen ? "بستن راهنما" : "بازکردن راهنما"} aria-expanded={wizardOpen}>
            <ChevronDown size={17} className={wizardOpen ? "" : "rotate-180"} />
          </button>
        </div>
        {cartError && <p role="alert" className="mt-2 text-center text-[11.5px] leading-5 text-[var(--kv-danger)]">{cartError}</p>}
      </div>
    </div>
  );
}

/* ================= one wizard role step ================= */
function RoleStep({ role, candidates, selection, onPick, onColor, onRemove, onBack, onNext, catalogue, emptyNote }: {
  role: OutfitRole;
  candidates: ReturnType<typeof recommendFor>;
  selection: ReturnType<typeof useOutfit>["items"];
  onPick: (p: Product) => void;
  onColor: (role: OutfitRole, colorId: string) => void;
  onRemove: () => void;
  onBack: () => void;
  onNext: () => void;
  catalogue: Product[];
  emptyNote?: string;
}) {
  const current = selection[role];
  const currentProduct = current ? catalogue.find((p) => p.id === current.productId) : undefined;
  const isOptional = role === "accessory";

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[14px] font-extrabold">
          {isOptional ? "اکسسوری (اختیاری)" : `${ROLE_LABEL[role]} را انتخاب کنید`}
        </p>
        {currentProduct && (
          <span className="rounded-full bg-[var(--kv-success)]/10 px-2.5 py-1 text-[10.5px] font-bold text-[var(--kv-success)]">انتخاب شد</span>
        )}
      </div>

      {currentProduct && current && (
        <div className="mt-3 rounded-[14px] border border-[var(--kv-success)]/40 bg-[var(--kv-success)]/[0.05] p-3">
          <div className="flex items-center gap-3">
            <img src={currentProduct.images[0]} alt="" className="h-16 w-12 rounded-[9px] object-cover" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] font-bold">{currentProduct.name}</p>
              <p className="mt-0.5 text-[12px] tabular-nums text-[var(--kv-muted)]">{fmtMoney(currentProduct.retailPrice)}</p>
            </div>
            <button onClick={onRemove} className="rounded-[9px] border border-[var(--kv-line)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--kv-danger)] hover:border-[var(--kv-danger)]">حذف</button>
          </div>
          {currentProduct.colors.length > 1 && (
            <div className="mt-2.5 border-t border-[var(--kv-success)]/20 pt-2.5">
              <p className="mb-1.5 text-[11px] font-bold text-[var(--kv-muted)]">رنگ</p>
              <Swatches colors={currentProduct.colors} selectedId={current.colorId ?? currentProduct.colors[0]?.id}
                onSelect={(c) => onColor(role, c.id)} productName={currentProduct.name} />
            </div>
          )}
        </div>
      )}

      <p className="mt-4 mb-2 text-[12px] font-bold text-[var(--kv-muted)]">پیشنهاد کلبه</p>
      {candidates.length === 0 ? (
        <p className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[12px] leading-6 text-[var(--kv-muted)]">
          {emptyNote ?? "فعلاً گزینه‌ای برای این گام در آرشیو خرده نیست."}
        </p>
      ) : (
        <div className="kv-scroll max-h-[320px] space-y-2 overflow-y-auto pl-1">
          {candidates.map(({ product, score, reasons }) => {
            const on = current?.productId === product.id;
            return (
              <button key={product.id} onClick={() => onPick(product)} aria-pressed={on}
                className={cn("kv-press flex w-full items-center gap-3 rounded-[12px] border p-2 text-right transition-all",
                  on ? "border-[var(--kv-accent)] bg-[var(--kv-accent)]/[0.06]" : "border-[var(--kv-line)] hover:border-[var(--kv-line-strong)]")}>
                <img src={product.images[0]} alt="" className="h-14 w-12 shrink-0 rounded-[8px] object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-bold">{product.name}</span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-[var(--kv-success)]">{reasons.join(" · ")}</span>
                  <span className="mt-0.5 block text-[11.5px] tabular-nums text-[var(--kv-muted)]">{fmtMoney(product.retailPrice)}</span>
                </span>
                <span className="shrink-0 rounded-full bg-[var(--kv-surface-2)] px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--kv-muted)]">{fmtNum(score)}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <Btn variant="soft" className="flex-1" onClick={onBack} icon={<ArrowRight size={16} />}>قبلی</Btn>
        <Btn variant="accent" className="flex-1" onClick={onNext} icon={<ArrowLeft size={16} />}>
          {isOptional && !current ? "رد کردن" : "ادامه"}
        </Btn>
      </div>
    </div>
  );
}

/* ================= Final Look (§18) ================= */
function FinalLook({ items, sizes, onSize, onColor, onChangeRole, onRemove, look, total, styleLabel, occasionLabel, missingSizeCount, onBack, onAdd, addedFlash, cartError }: {
  items: { role: OutfitRole; product: Product; colorId?: string }[];
  sizes: Record<string, string>;
  onSize: (productId: string, size: string) => void;
  onColor: (role: OutfitRole, colorId: string) => void;
  onChangeRole: (role: OutfitRole) => void;
  onRemove: (role: OutfitRole) => void;
  look: ReturnType<typeof assessLook>;
  total: number;
  styleLabel?: string;
  occasionLabel?: string;
  missingSizeCount: number;
  onBack: () => void;
  onAdd: () => void;
  addedFlash: boolean;
  cartError: string;
}) {
  return (
    <div>
      <p className="text-[14px] font-extrabold">نمای نهایی استایل</p>

      {/* context + score from the same engine the suggestions use */}
      <div className="mt-3 rounded-[14px] border border-[var(--kv-line)] bg-[var(--kv-surface-2)]/50 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-bold text-[var(--kv-muted)]">هماهنگی استایل</p>
          <p className="text-[15px] font-extrabold tabular-nums">{fmtNum(look.score)}<span className="text-[11px] font-bold text-[var(--kv-muted)]"> / ۱۰۰</span></p>
        </div>
        {(styleLabel || occasionLabel) && (
          <p className="mt-1 text-[11.5px] text-[var(--kv-muted)]">
            {[styleLabel && `استایل ${styleLabel}`, occasionLabel].filter(Boolean).join(" · ")}
          </p>
        )}
        {look.reasons.length > 0 && (
          <ul className="mt-2 space-y-1">
            {look.reasons.map((reason) => (
              <li key={reason} className={cn("text-[11.5px] font-bold", reason.startsWith("⚠") ? "text-[var(--kv-accent)]" : "text-[var(--kv-success)]")}>{reason}</li>
            ))}
          </ul>
        )}
      </div>

      {/* items */}
      <p className="mt-4 mb-2 text-[12px] font-bold text-[var(--kv-muted)]">قطعات استایل ({fmtNum(items.length)})</p>
      {items.length === 0 ? (
        <p className="rounded-[12px] bg-[var(--kv-surface-2)]/60 p-3 text-[12px] leading-6 text-[var(--kv-muted)]">هنوز قطعه‌ای انتخاب نشده است.</p>
      ) : (
        <div className="space-y-2">
          {items.map(({ role, product, colorId }) => {
            const list = sizesOf(product);
            return (
              <div key={role} className="rounded-[14px] border border-[var(--kv-line)] p-3">
                <div className="flex items-center gap-3">
                  <img src={product.images[0]} alt="" className="h-16 w-12 rounded-[9px] object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10.5px] font-bold text-[var(--kv-accent)]">{ROLE_LABEL[role]}</p>
                    <p className="truncate text-[12.5px] font-bold">{product.name}</p>
                    <p className="mt-0.5 text-[12px] tabular-nums text-[var(--kv-muted)]">{fmtMoney(product.retailPrice)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button onClick={() => onChangeRole(role)} className="rounded-[9px] border border-[var(--kv-line)] px-2.5 py-1 text-[11px] font-bold text-[var(--kv-muted)] hover:border-[var(--kv-line-strong)]">تغییر</button>
                    <button onClick={() => onRemove(role)} className="rounded-[9px] border border-[var(--kv-line)] px-2.5 py-1 text-[11px] font-bold text-[var(--kv-danger)] hover:border-[var(--kv-danger)]">حذف</button>
                  </div>
                </div>
                <div className="mt-2.5 space-y-2 border-t border-[var(--kv-line)] pt-2.5">
                  {product.colors.length > 1 && (
                    <div>
                      <p className="mb-1 text-[10.5px] font-bold text-[var(--kv-muted)]">رنگ (پین‌شده)</p>
                      <Swatches colors={product.colors} selectedId={colorId ?? product.colors[0]?.id} onSelect={(c) => onColor(role, c.id)} productName={product.name} />
                    </div>
                  )}
                  {list.length > 0 && (
                    <div>
                      <p className="mb-1 text-[10.5px] font-bold text-[var(--kv-muted)]">سایز</p>
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`سایز ${product.name}`}>
                        {list.map((size) => (
                          <button key={size} onClick={() => onSize(product.id, size)} data-on={(sizes[product.id] ?? "") === size ? "true" : "false"} aria-pressed={(sizes[product.id] ?? "") === size} className="kv-sf-size">
                            {size}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* totals */}
      <div className="mt-4 space-y-1.5 border-t border-[var(--kv-line)] pt-3 text-[13px]">
        <div className="flex justify-between"><span className="text-[var(--kv-muted)]">جمع قطعات</span><span className="font-extrabold tabular-nums">{fmtMoney(total)}</span></div>
        {missingSizeCount > 0 && <p className="text-[11.5px] font-bold text-[var(--kv-accent)]">برای {fmtNum(missingSizeCount)} قلم سایز انتخاب کنید.</p>}
      </div>

      {cartError && <p role="alert" className="mt-3 rounded-[10px] bg-[var(--kv-danger)]/[0.07] p-2.5 text-[11.5px] leading-5 text-[var(--kv-danger)]">{cartError}</p>}
      {addedFlash && <p role="status" className="kv-glass mt-3 flex items-center gap-2 rounded-[12px] px-4 py-2.5 text-[13px] font-bold"><Check size={15} className="text-[var(--kv-success)]" />استایل به سبد خرید اضافه شد</p>}

      <div className="mt-4 flex gap-2">
        <Btn variant="soft" className="flex-1" onClick={onBack} icon={<ArrowRight size={16} />}>قبلی</Btn>
        <Btn variant="accent" className="flex-[2]" disabled={!items.length || missingSizeCount > 0} onClick={onAdd} icon={<ShoppingBag size={16} />}>
          افزودن استایل به سبد
        </Btn>
      </div>
    </div>
  );
}
