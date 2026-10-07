import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { PRODUCTS, COLORS } from "../src/data/catalog";
import {
  tryOnEligible, outfitRoleOf, recommendFor, assessLook, colorHarmony,
  type Product,
} from "../src/data/styling";
import { outfitReducer, EMPTY_OUTFIT } from "../src/data/outfit";
import { validateRetailLines } from "../src/data/cart";
import type { RetailCartLine } from "../src/data/customer";
import {
  canonicalKey, checkRelation, levelBetween, relationsToAdjustments,
  publicCuratedStyles, resolveLines, subtotalOf, assessDiscount, assessInstallments,
  validateCuratedStyle, curatableProduct, DEFAULT_INSTALLMENTS, DEFAULT_PRICING,
  type CuratedStyle, type VariantRef, type RelationLevel,
} from "../src/data/curated";

/**
 * Styling-domain unit probe (Phase 1). Runs the pure functions against the
 * catalogue the storefront really ships and dumps one JSON report — the mjs
 * side makes the actual assertions. No React state here except the reducer
 * calls, which are pure.
 */
function Probe() {
  useEffect(() => {
    /* mirror the store: the storefront publishes PRODUCTS as-is */
    const retail: Product[] = PRODUCTS.map((p) => ({ ...p, status: "published" as const }));
    const published = (over: Partial<Product>): Product => ({
      ...retail[0], id: "zz-test", name: "تستی", category: "پیراهن",
      retailPrice: 5000000, stock: 10, ...over,
    });

    /* ── try-on eligibility ── */
    const eligibility = {
      retailGarment: tryOnEligible(retail[1]),                       // پیراهن
      retailOuterwear: tryOnEligible(retail[0]),                     // مانتو و بارانی
      pending: tryOnEligible({ ...retail[1], status: "pending" as const }),
      wholesaleOnly: tryOnEligible({ ...retail[1], retailPrice: 0 }),
      accessory: tryOnEligible(published({ category: "کیف" })),
      explicitOffBeatsCategory: tryOnEligible(published({ tryOn: false })),
      explicitOnBeatsCategory: tryOnEligible(published({ category: "کیف", tryOn: true })),
      draft: tryOnEligible({ ...retail[1], status: "draft" as const }),
    };

    /* ── roles ── */
    const roles = {
      trench: outfitRoleOf(retail[0]),
      trouser: outfitRoleOf({ category: "شلوار" } as Product),
      shoes: outfitRoleOf({ category: "کفش" } as Product),
      dress: outfitRoleOf({ category: "پیراهن یک‌تکه" } as Product),
      unknown: outfitRoleOf({ category: "چیز دیگر" } as Product),
    };

    /* ── engine ── */
    const ctx = { style: "casual" as const, occasion: "university" as const, role: "outerwear" as const, selection: { top: { productId: retail[1].id, colorId: retail[1].colors[0].id } } };
    const a = recommendFor(retail, ctx, [], 12);
    const b = recommendFor(retail, ctx, [], 12);
    const engine = {
      deterministic: JSON.stringify(a) === JSON.stringify(b),
      descending: a.every((c, i) => i === 0 || a[i - 1].score >= c.score),
      inRange: a.every((c) => c.score >= 0 && c.score <= 100),
      reasonsPresent: a.every((c) => c.reasons.length >= 1 && c.reasons.every((r) => r.trim().length > 0)),
      count: a.length,
      /* the product already occupying the slot never competes for it */
      slotExcluded: !a.some((c) => c.product.id === retail[1].id),
      /* candidates for a slot must be able to fill it (no shirts-as-trousers) */
      roleFillOnly: a.every((c) => outfitRoleOf(c.product) === "outerwear"),
    };

    /* graceful missing metadata: an unknown category still scores */
    const stranger = published({ id: "zz-stranger", category: "دسته ناشناخته" });
    const strangerRanked = recommendFor([...retail, stranger], { ...ctx, role: "accessory" }, [], 12);
    const graceful = {
      scored: strangerRanked.some((c) => c.product.id === "zz-stranger"),
      inRange: strangerRanked.every((c) => c.score >= 0 && c.score <= 100),
    };

    /* unavailable products are never promoted */
    const outOfStock = published({ id: "zz-oos", stock: 0 });
    const pending = published({ id: "zz-pending", status: "pending" as const });
    const withDead = recommendFor([...retail, outOfStock, pending], { ...ctx, role: "accessory" }, [], 20);
    const availability = {
      outOfStockExcluded: !withDead.some((c) => c.product.id === "zz-oos"),
      pendingExcluded: !withDead.some((c) => c.product.id === "zz-pending"),
    };

    /* explicit adjustment hook (Phase 2 preview): conflict excluded, boost applied */
    const base = recommendFor(retail, { ...ctx, role: "outerwear" }, [], 20);
    const boosted = recommendFor(retail, { ...ctx, role: "outerwear" }, [{ productId: retail[4].id, level: "strong_match" }], 20);
    const before = boosted.find((c) => c.product.id === retail[4].id)?.score ?? -1;
    const plain = base.find((c) => c.product.id === retail[4].id)?.score ?? -1;
    const conflicts = recommendFor(retail, { ...ctx, role: "outerwear" }, [{ productId: retail[4].id, level: "conflict" }], 20);
    const adjustments = {
      strongMatchBoosts: before > plain,
      reasonPresent: boosted.find((c) => c.product.id === retail[4].id)?.reasons.includes("انتخاب کلبه") ?? false,
      conflictExcluded: !conflicts.some((c) => c.product.id === retail[4].id),
    };

    /* ── look assessment ── */
    const lookEmpty = assessLook(retail, {});
    const lookOne = assessLook(retail, { top: { productId: retail[1].id } });
    const two = { top: { productId: retail[1].id, colorId: retail[1].colors[0].id }, bottom: { productId: retail[0].id, colorId: retail[0].colors[0].id } };
    const lookTwo = assessLook(retail, two, { style: "casual", occasion: "everyday" });
    const lookTwoAgain = assessLook(retail, two, { style: "casual", occasion: "everyday" });
    const look = {
      emptyZero: lookEmpty.score === 0,
      singleFull: lookOne.score === 100,
      inRange: lookTwo.score >= 0 && lookTwo.score <= 100,
      deterministic: lookTwo.score === lookTwoAgain.score,
      reasonsShape: Array.isArray(lookTwo.reasons),
    };

    /* ── shared outfit reducer ── */
    const top1 = retail[1], top2 = retail[3], trench = retail[0];
    const dress = published({ id: "zz-dress", category: "پیراهن یک‌تکه" });
    let s = EMPTY_OUTFIT;
    s = outfitReducer(s, { type: "place", product: top1, colorId: top1.colors[0].id });
    const afterFirst = Object.keys(s.items).length === 1 && s.items.top?.productId === top1.id;
    s = outfitReducer(s, { type: "place", product: top2 });               // same slot → replace
    const replaced = Object.keys(s.items).length === 1 && s.items.top?.productId === top2.id;
    s = outfitReducer(s, { type: "place", product: trench });             // outerwear slot
    s = outfitReducer(s, { type: "place", product: dress });              // dress → clears top+bottom
    const dressWins = s.items.dress?.productId === "zz-dress" && !s.items.top && !s.items.bottom && !!s.items.outerwear;
    s = outfitReducer(s, { type: "place", product: top1 });               // separate top → dress obsolete
    const topBreaksDress = s.items.top?.productId === top1.id && !s.items.dress;
    s = outfitReducer(s, { type: "removeRole", role: "top" });
    const removeRole = !s.items.top;
    s = outfitReducer(s, { type: "place", product: top2 });
    s = outfitReducer(s, { type: "removeProduct", productId: top2.id });
    const removeProduct = !s.items.top;
    const outfit = { afterFirst, replaced, dressWins, topBreaksDress, removeRole, removeProduct };

    /* ── cart batch rules (same rules as the single add) ── */
    const cartLine = (id: string, size = "M", color = "مشکی", qty = 1): RetailCartLine => ({ id, qty, size, color });
    const okBatch = validateRetailLines(retail, [], [cartLine(retail[1].id), cartLine(retail[0].id)]);
    const notFound = validateRetailLines(retail, [], [cartLine("nope")]);
    const notRetail = validateRetailLines(retail.map((p) => ({ ...p })), [], [cartLine(retail[1].id)]);
    const pendingProduct = published({ id: "zz-pending2", status: "pending" as const });
    const unPublished = validateRetailLines([...retail, pendingProduct], [], [cartLine("zz-pending2")]);
    const zeroStock = validateRetailLines([...retail, published({ id: "zz-zero", stock: 0 })], [], [cartLine("zz-zero")]);
    const aggCart: RetailCartLine[] = [cartLine(retail[1].id, "M", "مشکی", retail[1].stock - 1)];
    const overAggregate = validateRetailLines(retail, aggCart, [cartLine(retail[1].id, "L", "سفید", 2)]);
    const splitHalf = validateRetailLines(retail, [cartLine(retail[1].id, "M", "مشکی", Math.floor(retail[1].stock / 2))], [cartLine(retail[1].id, "L", "سفید", Math.floor(retail[1].stock / 2) + 1)]);
    const cart = {
      okBatch: okBatch.ok,
      notFound: notFound.failures[0]?.reason === "not_found" && !notFound.ok,
      zeroStock: zeroStock.failures[0]?.reason === "out_of_stock" && !zeroStock.ok,
      unPublished: unPublished.failures[0]?.reason === "not_retail" && !unPublished.ok,
      overAggregate: overAggregate.failures[0]?.productId === retail[1].id && !overAggregate.ok,
      splitHalfBlocked: !splitHalf.ok,
    };

    /* ── colour harmony: deterministic, explainable families ── */
    const harmony = {
      quietPairsLoud: colorHarmony(COLORS.white, COLORS.burgundy) === 1 && colorHarmony(COLORS.black, COLORS.orange) === 1,
      identical: colorHarmony(COLORS.burgundy, COLORS.burgundy) > 0,
      deterministic: colorHarmony(COLORS.orange, COLORS.navy) === colorHarmony(COLORS.orange, COLORS.navy),
      bounded: [COLORS.orange, COLORS.navy, COLORS.burgundy, COLORS.cream].flatMap((x) =>
        [COLORS.orange, COLORS.navy, COLORS.burgundy, COLORS.cream].map((y) => colorHarmony(x, y))).every((v) => v >= 0 && v <= 1),
    };

    /* ═══════════════ Phase 2 — compatibility graph + curated pricing ═══════════════ */
    const v = (productId: string, colorId: string): VariantRef => ({ productId, colorId });
    const rel = (a: VariantRef, b: VariantRef, level: RelationLevel) => ({
      id: canonicalKey(a, b), a: canonicalKey(a, b).split("|")[0]! < canonicalKey(a, b).split("|")[1]! ? a : b,
      b: canonicalKey(a, b).split("|")[0]! < canonicalKey(a, b).split("|")[1]! ? b : a, level, updatedAt: "",
    });

    const phase2: Record<string, unknown> = {};

    /* ── canonical symmetric pair key (§28) ── */
    const x = v("p1", "cream"), y = v("p2", "sand");
    phase2.canonicalSymmetric = canonicalKey(x, y) === canonicalKey(y, x);
    phase2.canonicalNotSelf = canonicalKey(x, x) !== canonicalKey(x, y);

    /* ── relation validation (§24) ── */
    const A = retail[0], B = retail[1];
    const ax = v(A.id, A.colors[0]!.id), bx = v(B.id, B.colors[0]!.id);
    phase2.selfBlocked = checkRelation(retail, ax, ax) === "self";
    phase2.invalidVariantBlocked = checkRelation(retail, { productId: A.id, colorId: "nope" }, bx) === "invalid_variant";
    const pendingClone = retail.map((p) => (p.id === B.id ? { ...p, status: "pending" as const } : p));
    phase2.notRetailBlocked = checkRelation(pendingClone, ax, bx) === "not_retail"
      && checkRelation(retail, { ...ax, productId: "p-missing" }, bx) === "invalid_variant";
    phase2.validAccepted = checkRelation(retail, ax, bx) === "ok";
    /* wholesale-only record (retail price zeroed) must be rejected */
    const wholesaleOnly = retail.map((p) => (p.id === B.id ? { ...p, retailPrice: 0 } : p));
    phase2.wholesaleBlocked = checkRelation(wholesaleOnly, ax, bx) === "not_retail";

    /* ── symmetric lookup resolves from either side ── */
    const one = [rel(ax, bx, "strong_match")];
    phase2.symmetricLookup = levelBetween(one, ax, bx) === "strong_match" && levelBetween(one, bx, ax) === "strong_match";
    phase2.selfLookupUndefined = levelBetween(one, ax, ax) === undefined && levelBetween(one, x, v("p3", "x")) === undefined;

    /* ── bridge: explicit relations → engine adjustments (§30) ── */
    const reverseOnly = relationsToAdjustments(one, [{ productId: B.id, colorId: B.colors[0]!.id }]);
    phase2.bridgeReverseDirection = reverseOnly.length === 1 && reverseOnly[0]!.productId === A.id && reverseOnly[0]!.level === "strong_match";
    const withConflict = [rel(ax, bx, "conflict"), rel(v(A.id, A.colors[0]!.id), v("p3", retail[2]!.colors[0]!.id), "strong_match")];
    const merged = relationsToAdjustments(withConflict, [{ productId: B.id, colorId: B.colors[0]!.id }]);
    phase2.conflictWinsMerge = merged.length === 1 && merged[0]!.level === "conflict";

    /* ── engine v2: explicit knowledge joins automatic scoring ── */
    const ctx2 = { style: "casual" as const, occasion: "any" as const, selection: { top: { productId: B.id, colorId: B.colors[0]!.id } }, role: "outerwear" as const };
    const baseline = recommendFor(retail, ctx2, [], 8);
    const boosted2 = recommendFor(retail, ctx2, [{ productId: A.id, level: "strong_match" }], 8);
    const baseRank = baseline.findIndex((c) => c.product.id === A.id);
    const boostRank = boosted2.findIndex((c) => c.product.id === A.id);
    phase2.strongBoostsOrTops = boostRank >= 0 && (baseRank < 0 || boostRank <= baseRank) && boosted2.some((c) => c.reasons.includes("انتخاب کلبه"));
    const conflicted = recommendFor(retail, ctx2, [{ productId: A.id, level: "conflict" }], 8);
    phase2.conflictExcludedFromRecs = !conflicted.some((c) => c.product.id === A.id);
    phase2.zeroRelationsUseful = baseline.length > 0 && baseline.every((c) => c.score > 0);

    /* ── curated validation ── */
    const styleDraft: CuratedStyle = {
      id: "cs-x", slug: "x", title: "تست", description: "", status: "draft",
      items: [
        { id: "i1", productId: A.id, colorId: A.colors[0]!.id, role: "top", sortOrder: 1 },
        { id: "i2", productId: B.id, colorId: B.colors[0]!.id, role: "bottom", sortOrder: 2 },
      ],
      pricing: { ...DEFAULT_PRICING }, installments: { ...DEFAULT_INSTALLMENTS },
      createdAt: "", updatedAt: "",
    };
    phase2.validateOkStyle = validateCuratedStyle(styleDraft, retail).length === 0;
    phase2.validateTitleNeeded = validateCuratedStyle({ ...styleDraft, title: "  " }, retail).some((i) => i.code === "title");
    phase2.validateDuplicateRole = validateCuratedStyle({ ...styleDraft, items: [styleDraft.items[0]!, { ...styleDraft.items[0]!, id: "i3", role: "top", sortOrder: 2 }] }, retail).some((i) => i.code === "duplicate_role");
    phase2.validateBadColor = validateCuratedStyle({ ...styleDraft, items: [{ ...styleDraft.items[0]!, colorId: "nope" }] }, retail).some((i) => i.code === "item_color");
    const pendingProduct2 = { ...B, status: "pending" as const };
    phase2.validateUnpublishedProduct = validateCuratedStyle({ ...styleDraft, items: [{ ...styleDraft.items[1]!, productId: pendingProduct2.id }] }, [{ ...retail.find((p) => p.id === pendingProduct2.id)!, status: "pending" as const }, ...retail.filter((p) => p.id !== pendingProduct.id)]).some((i) => i.code === "item_product");
    phase2.curatableGate = curatableProduct(pendingProduct2) === false && curatableProduct(B) === true;

    /* ── resolveLines: live prices, honest drops ── */
    const resolvedOk = resolveLines(styleDraft, retail);
    phase2.liveSubtotal = subtotalOf(resolvedOk.lines) === A.retailPrice + B.retailPrice && resolvedOk.dropped.length === 0;
    const resolvedDrop = resolveLines(styleDraft, retail.map((p) => (p.id === B.id ? { ...p, status: "draft" as const } : p)));
    phase2.unavailableDrop = resolvedDrop.dropped.length === 1 && resolvedDrop.lines.length === 1;
    phase2.activeFilter = resolveLines(styleDraft, retail, new Set([A.id])).lines.length === 1;

    /* ── discount eligibility (§53) ── */
    const priced = resolveLines(styleDraft, retail).lines;
    const tenPct: CuratedStyle = { ...styleDraft, pricing: { ...DEFAULT_PRICING, discountType: "percentage", discountValue: 10, minimumActiveItems: 2 } };
    const d10 = assessDiscount(tenPct, priced);
    phase2.percentMath = d10.eligible && d10.discount === Math.round((A.retailPrice + B.retailPrice) * 0.1);
    const belowMin: CuratedStyle = { ...tenPct, pricing: { ...tenPct.pricing, minimumActiveItems: 3 } };
    const dBlock = assessDiscount(belowMin, priced);
    phase2.minItemsBlocks = !dBlock.eligible && !!dBlock.reason && dBlock.discount === 0;
    phase2.minItemsRestores = assessDiscount({ ...belowMin, items: [...styleDraft.items] }, priced).eligible === false
      && assessDiscount(belowMin, [...priced, ...priced]).eligible === true;
    const coreNeeded: CuratedStyle = { ...tenPct, pricing: { ...tenPct.pricing, requiredCoreItems: ["shoes"] } };
    phase2.coreItemsBlock = !assessDiscount(coreNeeded, priced).eligible;
    const fixedBig: CuratedStyle = { ...tenPct, pricing: { ...tenPct.pricing, discountType: "fixed", discountValue: subtotalOf(priced) * 3 } };
    phase2.fixedClamps = assessDiscount(fixedBig, priced).discount === subtotalOf(priced);
    phase2.noDiscount = assessDiscount(styleDraft, priced).eligible === false && assessDiscount(styleDraft, priced).discount === 0;

    /* ── installment precedence (§56–§59) ── */
    const gross = subtotalOf(priced);
    const autoOn: CuratedStyle = { ...styleDraft, installments: { ...DEFAULT_INSTALLMENTS, installmentEnabled: true, installmentPricingMode: "automatic", applyStyleDiscountToInstallments: true } };
    const inst = assessInstallments(autoOn, priced, d10);
    phase2.autoQuarters = inst.mode === "automatic" && inst.perInstallment === Math.ceil((gross - d10.discount) / 4);
    const autoOff: CuratedStyle = { ...styleDraft, installments: { ...DEFAULT_INSTALLMENTS, installmentEnabled: true, installmentPricingMode: "automatic", applyStyleDiscountToInstallments: false } };
    phase2.autoIgnoresDiscount = assessInstallments(autoOff, priced, d10).perInstallment === Math.ceil(gross / 4);
    const oddGross = { ...styleDraft, items: [{ ...styleDraft.items[0]!, productId: A.id, id: "i1" }] };
    const oddPriced = resolveLines(oddGross, retail).lines;
    const oddTotal = subtotalOf(oddPriced);
    const autoOdd: CuratedStyle = { ...oddGross, installments: { ...autoOn.installments } };
    phase2.autoRoundsUp = assessInstallments(autoOdd, oddPriced, assessDiscount(autoOdd, oddPriced)).perInstallment === Math.ceil(oddTotal / 4);
    const manual: CuratedStyle = { ...styleDraft, installments: { ...DEFAULT_INSTALLMENTS, installmentEnabled: true, installmentPricingMode: "manual", manualInstallmentTotal: 9000000, applyStyleDiscountToInstallments: true } };
    const manualOk = assessInstallments(manual, priced, d10);
    phase2.manualLocked = manualOk.mode === "manual" && manualOk.total === 9000000 && manualOk.perInstallment === 2250000;
    const halfPriced = priced.slice(0, 1);
    const manualBroken = assessInstallments(manual, halfPriced, assessDiscount(manual, halfPriced));
    phase2.manualFallsBack = manualBroken.mode === "automatic" && !!manualBroken.manualInvalidReason;
    /* a manual total is never redistributed proportionally (§58) */
    phase2.manualNeverProportional = assessInstallments(manual, halfPriced, assessDiscount(manual, halfPriced)).total !== Math.ceil((9000000 / 2) / 4) * 4 || manualBroken.mode === "automatic";
    phase2.disabledNone = assessInstallments(styleDraft, priced, d10).mode === "none";

    /* ── public lens: drafts never leak (§39) ── */
    const all = [styleDraft, { ...styleDraft, id: "cs-p", status: "published" as const }, { ...styleDraft, id: "cs-a", status: "archived" as const }];
    phase2.publicOnlyPublished = JSON.stringify(publicCuratedStyles(all).map((s) => s.id)) === JSON.stringify(["cs-p"]);

    const report = { eligibility, roles, engine, graceful, availability, adjustments, look, outfit, cart, harmony, phase2, products: retail.length };
    /* the boot DOM ships only #root — create the sink if the harness did not */
    const out = document.getElementById("out") ?? (() => {
      const node = document.createElement("pre");
      node.id = "out";
      document.body.appendChild(node);
      return node;
    })();
    out.textContent = JSON.stringify(report);
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(<Probe />);
