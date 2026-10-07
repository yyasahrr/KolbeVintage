import fs from "node:fs";
import { boot, reporter } from "./dom.mjs";

/* the probe bundles React's renderer, so it uses the full boot path */
const env = await boot(".smoke/out/styling-units.js");
await new Promise((resolve) => setTimeout(resolve, 400));
const raw = env.document.getElementById("out").textContent;
if (!raw) { console.error("styling probe produced no report"); process.exit(1); }
const data = JSON.parse(raw);
const { check, done } = reporter("styling domain units (Phase 1: eligibility + engine + outfit + cart)");

/* ── try-on eligibility is business logic ── */
check("eligible retail garment offers try-on", () => data.eligibility.retailGarment === true);
check("eligible retail outerwear offers try-on", () => data.eligibility.retailOuterwear === true);
check("pending product never offers try-on", () => data.eligibility.pending === false);
check("draft product never offers try-on", () => data.eligibility.draft === false);
check("wholesale-only record never offers try-on", () => data.eligibility.wholesaleOnly === false);
check("accessory category never offers try-on by default", () => data.eligibility.accessory === false);
check("explicit tryOn:false beats a capable category", () => data.eligibility.explicitOffBeatsCategory === false);
check("explicit tryOn:true beats a default-off category", () => data.eligibility.explicitOnBeatsCategory === true);

/* ── outfit roles come from real categories ── */
check("trench maps to outerwear", () => data.roles.trench === "outerwear");
check("trousers map to bottom", () => data.roles.trouser === "bottom");
check("shoes map to shoes", () => data.roles.shoes === "shoes");
check("one-piece dress maps to dress", () => data.roles.dress === "dress");
check("unknown category degrades to accessory", () => data.roles.unknown === "accessory");

/* ── engine: deterministic, explainable, honest ── */
check(`recommendations produced (${data.engine.count})`, () => data.engine.count > 0);
check("recommendations are deterministic across calls", () => data.engine.deterministic === true);
check("scores are ordered (never random reshuffle)", () => data.engine.descending === true);
check("scores stay inside 0–100 (no fake percentages)", () => data.engine.inRange === true);
check("every candidate carries honest reasons", () => data.engine.reasonsPresent === true);
check("the product already in the slot is excluded from its own candidates", () => data.engine.slotExcluded === true);
check("candidates for a slot can actually fill that role", () => data.engine.roleFillOnly === true);

check("unknown-category product still scores (graceful metadata)", () => data.graceful.scored === true && data.graceful.inRange === true);
check("out-of-stock product is never promoted", () => data.availability.outOfStockExcluded === true);
check("unpublished product is never promoted", () => data.availability.pendingExcluded === true);

check("strong match boosts the score (supplements, not replaces)", () => data.adjustments.strongMatchBoosts === true);
check("strong match earns the انتخاب کلبه reason", () => data.adjustments.reasonPresent === true);
check("conflict is excluded from normal recommendations", () => data.adjustments.conflictExcluded === true);

/* ── final look ── */
check("empty look scores 0", () => data.look.emptyZero === true);
check("single piece scores full", () => data.look.singleFull === true);
check("pair score stays in range and repeats identically", () => data.look.inRange === true && data.look.deterministic === true && data.look.reasonsShape === true);

/* ── shared outfit state (one state, wizard ⇄ canvas) ── */
check("first placement fills its role slot", () => data.outfit.afterFirst === true);
check("same-slot placement replaces instead of duplicating", () => data.outfit.replaced === true);
check("a dress replaces top + bottom", () => data.outfit.dressWins === true);
check("a separate top makes the dress obsolete", () => data.outfit.topBreaksDress === true);
check("removeRole clears the slot", () => data.outfit.removeRole === true);
check("removeProduct clears the slot (canvas → wizard direction)", () => data.outfit.removeProduct === true);

/* ── cart batch rules: all-or-nothing, same rules as a single add ── */
check("valid outfit batch passes", () => data.cart.okBatch === true);
check("unknown product fails as not_found", () => data.cart.notFound === true);
check("zero-stock product fails as out_of_stock", () => data.cart.zeroStock === true);
check("unpublished product fails as not_retail", () => data.cart.unPublished === true);
check("stock is checked across cart + batch (aggregate)", () => data.cart.overAggregate === true);
check("a split outfit cannot sneak past stock in two halves", () => data.cart.splitHalfBlocked === true);

/* ═══════════════ Phase 2 — compatibility graph + curated pricing ═══════════════ */
const P2 = data.phase2;

/* canonical symmetric pair key */
check("pair key is symmetric and never collides with a self key", () => P2.canonicalSymmetric === true && P2.canonicalNotSelf === true);

/* relation validation */
check("a variant cannot relate to itself", () => P2.selfBlocked === true);
check("unknown product/colour variants are rejected", () => P2.invalidVariantBlocked === true);
check("unpublished / wholesale-only / missing variants are rejected", () => P2.notRetailBlocked === true && P2.wholesaleBlocked === true);
check("a real retail pair is accepted", () => P2.validAccepted === true);

/* symmetric lookup */
check("a relation resolves identically from either side", () => P2.symmetricLookup === true);
check("self and unknown pairs have no level", () => P2.selfLookupUndefined === true);

/* bridge to the engine */
check("relations map to adjustments in the reverse direction too", () => P2.bridgeReverseDirection === true);
check("conflict beats strong_match when both exist", () => P2.conflictWinsMerge === true);

/* engine v2 */
check("strong_match boosts ranking and earns انتخاب کلبه", () => P2.strongBoostsOrTops === true);
check("conflict removes a product from recommendations", () => P2.conflictExcludedFromRecs === true);
check("engine stays useful with zero manual relations", () => P2.zeroRelationsUseful === true);

/* curated validation */
check("a clean style passes validation", () => P2.validateOkStyle === true);
check("empty title is blocked", () => P2.validateTitleNeeded === true);
check("duplicate outfit roles are blocked", () => P2.validateDuplicateRole === true);
check("a pinned colour that no longer exists is blocked", () => P2.validateBadColor === true);
check("unpublished products cannot be curated", () => P2.validateUnpublishedProduct === true && P2.curatableGate === true);

/* resolveLines */
check("subtotals use live catalogue prices", () => P2.liveSubtotal === true);
check("unavailable items drop out honestly", () => P2.unavailableDrop === true);
check("the active-items filter shapes the priced lines", () => P2.activeFilter === true);

/* discount */
check("percentage discount is computed on the live subtotal", () => P2.percentMath === true);
check("minimumActiveItems blocks eligibility with a reason", () => P2.minItemsBlocks === true);
check("eligibility is restored when enough items activate", () => P2.minItemsRestores === true);
check("requiredCoreItems gate eligibility", () => P2.coreItemsBlock === true);
check("fixed discount clamps to the subtotal", () => P2.fixedClamps === true);
check("no discount config yields no discount", () => P2.noDiscount === true);

/* installments */
check("automatic installments quarter the discounted total, rounding up", () => P2.autoQuarters === true && P2.autoRoundsUp === true);
check("applyStyleDiscountToInstallments=false keeps the gross total", () => P2.autoIgnoresDiscount === true);
check("manual total is locked to the full composition (4 × ceil/4)", () => P2.manualLocked === true);
check("disabling an item falls back to automatic with an explicit reason", () => P2.manualFallsBack === true);
check("a manual total is never redistributed proportionally", () => P2.manualNeverProportional === true);
check("installments disabled means none", () => P2.disabledNone === true);

/* public lens */
check("drafts and archived styles never reach the public lens", () => P2.publicOnlyPublished === true);

/* ── colour harmony ── */
check("quiet colours pair with everything (explainable rule)", () => data.harmony.quietPairsLoud === true);
check("identical colours are tonal harmony", () => data.harmony.identical === true);
check("harmony is deterministic and bounded 0–1", () => data.harmony.deterministic === true && data.harmony.bounded === true);

process.exit(done({ products: data.products }) ? 1 : 0);
