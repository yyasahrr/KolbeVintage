import { helpers, reporter, wait } from "./dom.mjs";
import fs from "node:fs";

const { check, done } = reporter("curated commerce suite (Phase 3: pricing · installments · cart/order)");

const env = await (async () => {
  const { makeDom } = await import("./dom.mjs");
  const e = makeDom();
  e.window.eval(fs.readFileSync(".smoke/out/curated-commerce.js", "utf8"));
  await wait(900);
  return e;
})();
const d = env.document;
const H = helpers(d);
const { $, $$, text, byText, click } = H;
const data = () => JSON.parse(d.getElementById("out").textContent || "{}");
const rig = () => JSON.parse(d.getElementById("rig").textContent || "{}");
/* item toggle/size state is the detail's LOCAL state — read the live DOM */
const ctaText = () => ($$(".kv-style-cta")[0]?.textContent ?? "").trim();
const ctaDisabled = () => !!$(".kv-style-cta[disabled]");
const toggles = () => $$(".kv-style-switch input");

check("no runtime errors on boot", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));

/* ── deterministic discount allocation (§68) ── */
check("allocation sums exactly to the style discount", () => data().allocSums === true);
check("allocation is deterministic across calls", () => data().allocDeterministic === true);
check("bigger pre-discount lines never get smaller shares", () => data().allocProportional === true);
check("zero discount allocates nothing", () => data().allocZeroEmpty === true);
check("quantity-weighted basis still reconciles exactly", () => data().allocQtySums === true && data().allocQtyWeighted === true);

/* ── priceStyle preview (§52) ── */
check("preview subtotal uses live catalogue prices", () => data().previewSubtotal === true);
check("percentage discount computes on the live subtotal", () => data().previewDiscount === true);
check("full composition is all-active with a correct count", () => data().previewAllActive === true);
check("disabling an item drops eligibility honestly", () => data().halfActive === true && data().halfCtaMath === true);

/* ── public lens (§39) ── */
check("only published styles pass the public lens", () => data().lens === true);

/* ── CMS-uploaded hero media resolves client-side (mediaSrc chain) ── */
check("kolbe media (/api/v1/media/<uuid>) resolves to the API origin with breakpoint variants", () => data().mediaHero?.kolbeVariant === true);
check("foreign CDN media passes through unchanged (hero keeps its source)", () => data().mediaHero?.pexelsPassthrough === true);
check("unsplash media gains width params without breaking the URL", () => data().mediaHero?.unsplashWidth === true);
check("kolbe media srcset lists the full breakpoint ladder", () => data().mediaHero?.srcSetListsBreakpoints === true);

/* ── retail-only + honesty boundaries (§65) ── */
check("wholesale-only products are rejected by the shared cart validation", () => data().wholesaleRejected === true);
check("cart lines carry no client-side price", () => data().stalePriceIgnored === true);

/* ── order-time snapshot recompute (§65–§67) ── */
check("snapshot discount matches the live catalogue", () => data().snapDiscount === true);
check("snapshot allocation reconciles with the discount", () => data().snapAllocSums === true);
check("effective paid = unit × qty − allocated discount", () => data().snapEffective === true);
check("cash payable equals the sum of effective paid", () => data().snapPayable === true);

/* ── installments: automatic + manual lock (§56–§61) ── */
check("manual plan locks to the full composition (4 × ceil/4)", () => data().manualLocked === true);
check("a SIZE change keeps the manual plan valid", () => data().manualSurvivesSizeChange === true);
check("removing an item falls back to automatic with honest payable", () => data().manualFallsBack === true);
check("the manual total is never proportionally redistributed", () => data().manualNeverProportional === true);
check("a wrong pinned colour breaks the manual lock", () => data().manualColourLock === true);
check("unpublished style keeps the lines but drops the perks", () => data().unpublishedDropsPerks === true);

/* ── cart → order conversion through the REAL store ── */
check("the style order was placed and found by id", () => data().orderFound === true);
check("the order carries the style snapshot (id · group · mode)", () => data().orderSnapshot === true);
check("style lines stay real product-variant lines (3 lines)", () => data().orderPlainUntouched === true);
check("order-time allocation reconciles exactly", () => data().orderSnapAllocSums === true);
check("order total = plain line + manual payable + shipping", () => data().orderTotal === true);
check("order line prices come from the catalogue, never the client", () => data().orderPricesFromCatalog === true);

/* ── DetailRig: real component, one-size item never blocks the CTA ── */
check("one-size item shows its note but does NOT block the CTA", () => (d.body.textContent ?? "").includes("بدون سایزبندی") && !ctaDisabled() && ctaText().includes("افزودن کل استایل به سبد"));
check("only items with size choices render size rows", () => $$(".kv-style-sizes").length === 1);

/* independent size selection on the sized item */
const sizeButtons = () => $$(".kv-style-sizes button");
await click(sizeButtons()[0]);
check("a different size can be selected independently", () => sizeButtons()[0]?.getAttribute("aria-pressed") === "true" && !ctaDisabled());

/* disable the second item → live composition reacts */
await click(toggles()[1]);
check("disabling an item switches the CTA to the partial label", () => ctaText().includes("افزودن ۱ آیتم انتخاب‌شده به سبد"));
await click(toggles()[1]);
check("re-enabling restores the whole-style CTA", () => ctaText().includes("افزودن کل استایل به سبد") && !ctaDisabled());

/* atomic add: both lines land with the style + group metadata */
await click($(".kv-style-cta"));
check("the style add lands as grouped real cart lines", () => rig().cartOk === true && rig().cartLines.length === 2);
check("both lines share one stylePurchaseGroupId and the style id", () => rig().cartLines.every((l) => l.group === "rig-group" && l.style === "cs-rig"));
check("the one-size line was added with the empty size", () => rig().cartLines.some((l) => l.size === ""));

process.exit(done({}) ? 1 : 0);
