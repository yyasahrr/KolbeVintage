import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider, useStore, buildStyleSnapshot } from "../src/data/store";
import { PRODUCTS } from "../src/data/catalog";
import { validateRetailLines } from "../src/data/cart";
import {
  allocateStyleDiscount, priceStyle, publicCuratedStyles, resolveLines, subtotalOf,
  DEFAULT_INSTALLMENTS, DEFAULT_PRICING,
  type CuratedStyle,
} from "../src/data/curated";
import type { RetailCartLine } from "../src/data/customer";
import type { Product } from "../src/data/catalog";
import { CuratedStyleDetail, type StyleAdd } from "../src/portals/style-storefront";

/**
 * Curated-commerce probe (Phase 3). Two rigs:
 *  1. math + the REAL store order flow — placeRetailOrder runs with
 *     style-grouped cart lines and the order snapshot is read back from FRESH
 *     state on the render after placement (three-phase guard: upsert → place
 *     → assert — no stale closure, no loosened expectation);
 *  2. a DetailRig mounting the real CuratedStyleDetail, including a one-size
 *     product (no series), mirroring UI state into pre#rig.
 */

function OrderProbe() {
  const { products, curatedStyles, placeRetailOrder, upsertCuratedStyle, retailOrders } = useStore();
  const stepRef = useRef("upsert");
  const orderIdRef = useRef("");
  useEffect(() => {
    const retail: Product[] = PRODUCTS.map((p) => ({ ...p, status: "published" as const }));
    const A = retail[0], B = retail[1], C = retail[2];
    const style: CuratedStyle = {
      id: "cs-x", slug: "x", title: "تست", description: "", status: "published",
      items: [
        { id: "i1", productId: A.id, colorId: A.colors[0]!.id, role: "top", sortOrder: 1 },
        { id: "i2", productId: B.id, colorId: B.colors[0]!.id, role: "outerwear", sortOrder: 2 },
      ],
      pricing: { ...DEFAULT_PRICING },
      installments: { ...DEFAULT_INSTALLMENTS },
      createdAt: "", updatedAt: "",
    };
    const report: Record<string, unknown> = {};

    /* ── deterministic allocation: SUM always equals the discount (§68) ── */
    const lines = resolveLines(style, retail).lines;
    const qtys1 = new Map<string, number>();
    const alloc = allocateStyleDiscount(lines, 1_234_567, qtys1);
    report.allocSums = Array.from(alloc.values()).reduce((a, b) => a + b, 0) === 1_234_567;
    report.allocDeterministic = JSON.stringify(Array.from(allocateStyleDiscount(lines, 1_234_567, qtys1))) === JSON.stringify(Array.from(alloc));
    const [first, second] = lines;
    report.allocProportional = (alloc.get(first!.item.productId) ?? 0) >= (alloc.get(second!.item.productId) ?? 0) || first!.unitPrice === second!.unitPrice;
    report.allocZeroEmpty = allocateStyleDiscount(lines, 0, qtys1).size === 0;
    /* quantity-weighted basis: unit price × quantity, exact reconciliation */
    const qtys2 = new Map<string, number>([[A.id, 2]]);
    report.allocQtySums = Array.from(allocateStyleDiscount(lines, 999_999, qtys2).values()).reduce((a, b) => a + b, 0) === 999_999;
    const alloc2 = allocateStyleDiscount(lines, 999_999, qtys2);
    const weighted = A.retailPrice * 2;
    report.allocQtyWeighted = Math.abs((alloc2.get(A.id) ?? 0) / 999_999 - weighted / (weighted + B.retailPrice)) < 0.01;

    /* ── priceStyle preview ── */
    const pct: CuratedStyle = { ...style, pricing: { ...DEFAULT_PRICING, discountType: "percentage", discountValue: 10, minimumActiveItems: 2 } };
    const full = priceStyle(pct, retail);
    report.previewSubtotal = full.subtotal === subtotalOf(lines);
    report.previewDiscount = full.discount.discount === Math.round(full.subtotal * 0.1);
    report.previewAllActive = full.allActive && full.activeCount === 2;
    const half = priceStyle(pct, retail, { activeProductIds: new Set([A.id]), sizes: new Map(), qtys: new Map() });
    report.halfActive = half.activeCount === 1 && !half.allActive && !half.discount.eligible;
    report.halfCtaMath = half.payable === half.subtotal;

    /* ── public lens at the storefront boundary ── */
    report.lens = JSON.stringify(publicCuratedStyles([style, { ...style, id: "d", status: "draft" as const }])) === JSON.stringify([style]);

    /* ── wholesale rejection + stale-price honesty ── */
    const wholesaleOnly = retail.map((p) => (p.id === B.id ? { ...p, retailPrice: 0 } : p));
    const rejected = validateRetailLines(wholesaleOnly, [], [{ id: B.id, qty: 1, size: "M", color: "x" }]);
    report.wholesaleRejected = !rejected.ok && rejected.failures[0]?.reason === "not_retail";
    const cartLine: RetailCartLine = { id: A.id, qty: 1, size: "M", color: A.colors[0]!.name, curatedStyleId: "cs-x", stylePurchaseGroupId: "g0" };
    report.stalePriceIgnored = !("price" in cartLine) && !("unitPrice" in cartLine);

    /* ── snapshot math against an injected style (pure) ── */
    const stateLike = { products, curatedStyles: [pct] };
    const groupLines: RetailCartLine[] = [
      { id: A.id, qty: 1, size: "M", color: A.colors[0]!.name, curatedStyleId: pct.id, stylePurchaseGroupId: "g1" },
      { id: B.id, qty: 1, size: "L", color: B.colors[0]!.name, curatedStyleId: pct.id, stylePurchaseGroupId: "g1" },
    ];
    const snap = buildStyleSnapshot(stateLike, "g1", groupLines, "cash");
    report.snapDiscount = snap?.discount === Math.round((A.retailPrice + B.retailPrice) * 0.1);
    report.snapAllocSums = snap ? snap.lines.reduce((sum, l) => sum + l.allocatedDiscount, 0) === snap.discount : false;
    report.snapEffective = snap ? snap.lines.every((l) => l.effectivePaid === l.unitPrice * l.qty - l.allocatedDiscount) : false;
    report.snapPayable = snap ? snap.payable === snap.lines.reduce((sum, l) => sum + l.effectivePaid, 0) : false;

    /* manual plan locked to the full composition (§60) */
    const manual: CuratedStyle = { ...pct, installments: { ...DEFAULT_INSTALLMENTS, installmentEnabled: true, installmentPricingMode: "manual", manualInstallmentTotal: 20_000_000, applyStyleDiscountToInstallments: true } };
    const snapManual = buildStyleSnapshot({ products, curatedStyles: [manual] }, "g1", groupLines, "four_installments");
    report.manualLocked = snapManual?.paymentMode === "manual_installments" && snapManual.payable === 20_000_000 && snapManual.perInstallment === 5_000_000;
    /* a SIZE change keeps the manual plan (§60) */
    const sizeChanged: RetailCartLine[] = [
      { id: A.id, qty: 1, size: "S", color: A.colors[0]!.name, curatedStyleId: manual.id, stylePurchaseGroupId: "g1" },
      groupLines[1]!,
    ];
    report.manualSurvivesSizeChange = buildStyleSnapshot({ products, curatedStyles: [manual] }, "g1", sizeChanged, "four_installments")?.paymentMode === "manual_installments";
    /* disabling/removing any item → automatic fallback, never proportional (§61) */
    const snapBroken = buildStyleSnapshot({ products, curatedStyles: [manual] }, "g1", groupLines.slice(0, 1), "four_installments");
    report.manualFallsBack = snapBroken?.paymentMode === "automatic_installments" && snapBroken.payable === A.retailPrice;
    report.manualNeverProportional = snapBroken ? snapBroken.payable !== 10_000_000 : false;
    /* a wrong colour also breaks the manual lock */
    const wrongColour = [{ ...groupLines[0]!, color: "مشکی" }, groupLines[1]!];
    report.manualColourLock = buildStyleSnapshot({ products, curatedStyles: [manual] }, "g1", wrongColour, "four_installments")?.paymentMode === "automatic_installments";
    /* style unpublish → lines stay, perks drop */
    const offStyle = buildStyleSnapshot({ products, curatedStyles: [{ ...manual, status: "archived" as const }] }, "g1", groupLines, "four_installments");
    report.unpublishedDropsPerks = offStyle?.paymentMode === "cash" && offStyle.discount === 0 && offStyle.payable === A.retailPrice + B.retailPrice;

    /* ── full store flow: upsert → place → assert on FRESH state ── */
    if (stepRef.current === "upsert") {
      stepRef.current = "placed";
      upsertCuratedStyle(manual);
    } else if (stepRef.current === "placed") {
      stepRef.current = "assert";
      const placedId = placeRetailOrder(
        "acc-sara",
        [...groupLines, { id: C.id, qty: 1, size: "M", color: C.colors[0]!.name }] /* one plain line beside the group */,
        { id: "a", title: "خانه", recipient: "س", phone: "۰۹۱۲۰۰۰۰۰۰۰", province: "تهران", city: "تهران", line: "خیابان ۱", postalCode: "111", isDefault: true },
        "پست پیشتاز", 60_000, 0, undefined, "four_installments",
      );
      orderIdRef.current = placedId ?? "";
    }
    const order = orderIdRef.current ? retailOrders.find((o) => o.id === orderIdRef.current) : undefined;
    const snapshot = order?.styleSnapshots?.[0];
    report.orderFound = !!order;
    report.orderSnapshot = snapshot?.paymentMode === "manual_installments" && snapshot.styleId === manual.id && snapshot.purchaseGroupId === "g1";
    report.orderPlainUntouched = order ? order.lines.length === 3 : false;
    report.orderSnapAllocSums = snapshot ? snapshot.lines.reduce((sum, l) => sum + l.allocatedDiscount, 0) === snapshot.discount : false;
    report.orderTotal = order ? order.total === C.retailPrice + 20_000_000 + 60_000 : false;
    report.orderPricesFromCatalog = order ? order.lines.every((l) => l.unitPrice === retail.find((p) => p.id === l.productId)!.retailPrice) : false;

    const out = document.getElementById("out") ?? (() => { const p = document.createElement("pre"); p.id = "out"; document.body.appendChild(p); return p; })();
    out.textContent = JSON.stringify(report);
  });
  return null;
}

/* ── DetailRig: the real detail over a real store — one item is one-size ── */
function DetailRig() {
  const { products } = useStore();
  const [cart, setCart] = useState<RetailCartLine[]>([]);
  const oneSize: Product = { ...products[2]!, series: [], id: "one-size" }; // no series → no size choices
  const catalogue = [products[0]!, products[1]!, oneSize];
  const style: CuratedStyle = {
    id: "cs-rig", slug: "rig", title: "ریگ", description: "", status: "published",
    items: [
      { id: "r1", productId: products[0]!.id, colorId: products[0]!.colors[0]!.id, role: "outerwear", sortOrder: 1 },
      { id: "r2", productId: "one-size", colorId: oneSize.colors[0]!.id, role: "accessory", sortOrder: 2 },
    ],
    pricing: { ...DEFAULT_PRICING },
    installments: { ...DEFAULT_INSTALLMENTS },
    createdAt: "", updatedAt: "",
  };
  const addToCart = (adds: StyleAdd[]) => {
    const incoming: RetailCartLine[] = adds.map((add) => ({ id: add.productId, qty: add.qty, size: add.size, color: add.colorId, curatedStyleId: style.id, stylePurchaseGroupId: "rig-group" }));
    const check = validateRetailLines(catalogue, [], incoming);
    if (check.ok) setCart(incoming);
    return check;
  };
  useEffect(() => {
    const out = document.getElementById("rig") ?? (() => { const p = document.createElement("pre"); p.id = "rig"; document.body.appendChild(p); return p; })();
    /* only CART data lives here — item toggle/size state is the child's local
       state and is read from the live DOM by the suite */
    out.textContent = JSON.stringify({
      cartLines: cart.map((l) => ({ id: l.id, size: l.size, group: l.stylePurchaseGroupId, style: l.curatedStyleId })),
      cartOk: cart.length === 2 && cart.every((l) => l.stylePurchaseGroupId === "rig-group" && l.curatedStyleId === "cs-rig"),
    });
  });
  return <CuratedStyleDetail style={style} catalogue={catalogue} relations={[]} onBack={() => {}} onOpenProduct={() => {}} onPersonalize={() => {}} onAddToCart={addToCart} />;
}

export default function Entry() {
  createRoot(document.getElementById("root")!).render(
    <StoreProvider>
      <OrderProbe />
      <DetailRig />
    </StoreProvider>,
  );
}
Entry();
