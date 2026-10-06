import fs from "node:fs";
import { boot, helpers, reporter, wait } from "./dom.mjs";

const { check, done } = reporter("storefront DOM suite (phase 4)");
const dist = fs.readFileSync("dist/index.html", "utf8");

/* ---------------------------------------------------------------- desktop */
const env = await boot(".smoke/out/app.js");
const d = env.document;
const H = helpers(d);
const { $, $$, text, texts, byText, click } = H;

const type = async (node, value) => {
  const setter = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new env.window.Event("input", { bubbles: true }));
  await wait(200);
};
const select = async (node, value) => {
  const setter = Object.getOwnPropertyDescriptor(env.window.HTMLSelectElement.prototype, "value").set;
  setter.call(node, value);
  node.dispatchEvent(new env.window.Event("change", { bubbles: true }));
  await wait(200);
};

check("no runtime errors on boot", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));
check("storefront shell renders", () => !!$(".kv-storefront"));
check("home renders the product grid", () => $$(".kv-sf-cell").length >= 4 || `${$$(".kv-sf-cell").length} cards`);
check("home journal preview uses the journal card", () => $$(".kv-sf-jrnl-grid .kv-sf-jrnl-card").length === 3);
check("home journal cards are real buttons (a real destination)", () =>
  $$(".kv-sf-jrnl-grid .kv-sf-jrnl-card").every((node) => node.tagName === "BUTTON"));

/* ---- shop listing ---- */
await click(byText(".kv-sf-navlink", "فروشگاه"));
check("shop view opens", () => !!$(".kv-sf-shell-shop"));
check("shop shell is capped so desktop cards stay ~300px", () => /kv-sf-shell-shop\s*{[^}]*max-width:\s*1320px/.test(dist));
check("grid is 2 / 3 / 4 columns", () => {
  const grid = $(".kv-sf-shell-shop .grid");
  return /grid-cols-2/.test(grid.className) && /lg:grid-cols-3/.test(grid.className) && /xl:grid-cols-4/.test(grid.className);
});
check("grid uses the density tokens", () => /gap-x-\[var\(--kvaf-grid-gap\)\]/.test($(".kv-sf-shell-shop .grid").className));
check("listing shows all 8 published products", () => $$(".kv-sf-shell-shop .kv-sf-cell").length === 8 || `${$$(".kv-sf-shell-shop .kv-sf-cell").length}`);

const search = $(".kv-sf-field input");
check("toolbar has a labelled search field", () => search?.getAttribute("aria-label") === "جست‌وجوی محصول");
check("toolbar filter button is present", () => !!$(".kv-sf-tool"));
const sortSelect = $(".kv-sf-select");
check("toolbar sort is a native labelled select", () =>
  sortSelect?.getAttribute("aria-label") === "مرتب‌سازی" && sortSelect.querySelectorAll("option").length === 4);
check("category chips stay available and secondary", () => $$(".kv-sf-shell-shop .kv-sf-chip").length >= 6);
check("no permanent filter column in the markup", () => !/w-60|w-44/.test($(".kv-sf-shell-shop header").innerHTML));

await type(search, "بلیزر");
const searchCount = $$(".kv-sf-shell-shop .kv-sf-cell").length;
check("search narrows the grid", () => searchCount > 0 && searchCount < 8 || `${searchCount}`);
await click($(".kv-sf-field button[aria-label='پاک کردن جست‌وجو']"));
check("clearing search restores the grid", () => $$(".kv-sf-shell-shop .kv-sf-cell").length === 8);

const firstDefault = text(".kv-sf-shell-shop .kv-sf-cell .kv-sf-cell-name");
await select(sortSelect, "ارزان‌ترین");
check("sort reorders the grid", () => text(".kv-sf-shell-shop .kv-sf-cell .kv-sf-cell-name") !== firstDefault || "same first card");

/* ---- filter panel ---- */
await click($(".kv-sf-tool"));
const panel = $("[role='dialog'][data-panel='true']");
check("filters open as a FROST panel", () => !!panel);
check("panel is modal for assistive tech", () => panel?.getAttribute("aria-modal") === "true");
const panelText = panel?.textContent ?? "";
for (const group of ["دسته‌بندی", "رنگ", "سایز", "برند", "حداکثر قیمت", "موجودی", "مرتب‌سازی"]) {
  check(`filter panel offers ${group}`, () => panelText.includes(group));
}
check("no condition/grade group is offered (the data has none)", () => !/وضعیت کالا|درجه|condition/i.test(panelText));
check("price range is a native slider", () => !!panel?.querySelector("input[type='range'][aria-label='حداکثر قیمت']"));
const colourChip = byText(".kv-sf-chip", "کرم", panel);
await click(colourChip);
check("a colour facet narrows the listing", () => $$(".kv-sf-shell-shop .kv-sf-cell").length < 8 || "still 8");
check("the filter button reports the active facet count", () => !!$(".kv-sf-tool-count"));
check("the panel footer shows the live result count", () => /نمایش\s*[۰-۹]+\s*محصول/.test(panel?.querySelector(".kv-sf-sheet-foot")?.textContent ?? ""));
await click(panel.querySelector("button[aria-label='بستن']"));
check("the panel closes", () => !$("[role='dialog'][data-panel='true']"));
await click(byText(".kv-sf-shell-shop button", "حذف فیلترها") ?? $(".kv-sf-tool"));
await wait(120);
if ($("[role='dialog'][data-panel='true']")) await click($("[role='dialog'][data-panel='true'] button[aria-label='بستن']"));

/* ---- card inline purchase still works ---- */
/* pin the listing to one known product so every PDP assertion is deterministic */
await select($(".kv-sf-select"), "پیشنهاد کلبه");
await type($(".kv-sf-field input"), "مانتو بارانی");
check("the listing can be narrowed to one product", () => $$(".kv-sf-shell-shop .kv-sf-cell").length === 1 || `${$$(".kv-sf-shell-shop .kv-sf-cell").length}`);
const card = $(".kv-sf-shell-shop .kv-sf-cell");
await click(card.querySelector(".kv-sf-swatch"));
check("picking a colour expands the card inline", () => !!card.querySelector(".kv-sf-cell-purchase"));
const sizeChip = card.querySelector(".kv-sf-cell-purchase .kv-sf-size");
await click(sizeChip);
const cta = card.querySelector(".kv-sf-cell-cta");
check("the card CTA enables once a size is chosen", () => !cta.disabled);
await click(cta);
check("card feedback reads به سبد اضافه شد", () => cta.textContent.includes("به سبد اضافه شد") || cta.textContent);
check("the cart badge counted the line", () => /[۱-۹]/.test($(".kv-sf-badge")?.textContent ?? "") || $(".kv-sf-badge")?.textContent);

/* ---- product detail ---- */
const cardName = text(".kv-sf-shell-shop .kv-sf-cell .kv-sf-cell-name");
await click($(".kv-sf-shell-shop .kv-sf-cell .kv-sf-cell-shot"));
check("product detail opens", () => !!$(".kv-sf-pdp"));
const info = $(".kv-sf-pdp-info");
const gallery = $(".kv-sf-pdp-gallery");
check("information column precedes the gallery in the DOM (right in RTL)", () =>
  !!(info && gallery) && !!(info.compareDocumentPosition(gallery) & env.window.Node.DOCUMENT_POSITION_FOLLOWING));
check("PDP title matches the card that opened it", () => text(".kv-sf-pdp-info h1") === cardName || `${text(".kv-sf-pdp-info h1")} ≠ ${cardName}`);
check("PDP title sits at FEATURE scale, not hero", () => $(".kv-sf-pdp-info h1").className.includes("kvaf-feature-title"));
check("breadcrumb navigation is present", () => $("nav[aria-label='مسیر']")?.textContent.includes("فروشگاه"));
/* Phase 4: the purchase area answers "can I buy this option?" only — identity
   and technical metadata moved into the details section below. */
check("brand is shown at the top", () => $(".kv-sf-pdp-info > p").textContent.trim().length > 0);
const specsFold = $$(".kv-sf-fold").find((fold) => fold.querySelector(".kv-sf-fold-btn").textContent.includes("مشخصات کالا"));
check("the SKU row exists in the specifications", () => {
  const terms = specsFold ? Array.from(specsFold.querySelectorAll("dt")).map((dt) => dt.textContent.trim()) : [];
  return terms.includes("شناسه کالا") || terms.join(" | ");
});
const skuValue = (() => {
  const row = specsFold ? Array.from(specsFold.querySelectorAll("dt")).find((dt) => dt.textContent.trim() === "شناسه کالا") : null;
  return row?.nextElementSibling?.textContent.trim() ?? "";
})();
check("no SKU anywhere in the purchase area", () => {
  const purchase = $(".kv-sf-pdp-info").textContent.split("مشخصات کالا")[0];
  return (skuValue.length > 0 && !purchase.includes(skuValue)) || `sku=${skuValue} purchase=${purchase.slice(0, 60)}`;
});
check("rating summary is rendered from real data", () => {
  const rating = $(".kv-sf-rating");
  return !!rating && rating.textContent.includes("از ۵") && /دیدگاه/.test(rating.parentElement.textContent);
});
check("price and instalment price are both shown", () => {
  const block = $(".kv-sf-pdp-info").textContent;
  return /تومان/.test(block) && block.includes("یا ۴ قسطِ") || block.slice(0, 120);
});
check("four instalments never undercut the cash price", () => {
  /* the instalment figure is ceil(installmentPrice / 4); the only invariant the
     UI may claim is that four of them are not cheaper than paying cash */
  const amounts = ($(".kv-sf-pdp-info").textContent.match(/[۰-۹٬]+ تومان/g) ?? [])
    .map((value) => Number(value.replace(/[^۰-۹]/g, "").replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))));
  return amounts.length >= 2 && amounts[1] > 0 && amounts[1] * 4 >= amounts[0] || amounts.join(" / ");
});
check("colour swatches are rendered", () => $$(".kv-sf-pdp-info .kv-sf-swatch").length >= 2);
check("size chips are rendered", () => $$(".kv-sf-pdp-info .kv-sf-size").length >= 1);
check("stock states presence only", () => {
  const stock = $(".kv-sf-pdp-info .kv-sf-stock");
  if (!stock) return "no stock element";
  const label = stock.textContent.replace(/\s+/g, " ").trim();
  return label === "موجود" || label === "ناموجود" || label;
});
check("the product-level count never appears as variant stock", () => {
  const stock = $(".kv-sf-pdp-info .kv-sf-stock").textContent;
  return !/[0-9۰-۹]|عدد/.test(stock) || stock;
});
check("the selection summary is announced to assistive tech only", () => {
  const live = $(".kv-sf-pdp-info [aria-live='polite']");
  if (!live) return "no live region";
  return (live.className.includes("sr-only") && live.textContent.includes("انتخاب شما")) || live.className;
});
check("desktop gallery shows one main frame", () => $$(".kv-sf-gallery-main img").length === 1);
const thumbs = $$(".kv-sf-thumbs .kv-sf-thumb");
check("thumbnails match the gallery length", () => thumbs.length === $$(".kv-sf-scrollx img").length || `${thumbs.length}`);
check("thumbnails carry a current state", () => thumbs[0]?.getAttribute("aria-current") === "true");
const mainBefore = $(".kv-sf-gallery-main img").getAttribute("src");
await click(thumbs[1]);
check("clicking a thumbnail changes the main frame", () => $(".kv-sf-gallery-main img").getAttribute("src") !== mainBefore);
check("try-on is offered as a secondary control", () => {
  const button = byText(".kv-sf-pdp-info button", "پرو مجازی");
  return !!button && button.className.includes("kv-sf-action-quiet");
});

/* ---- accordion ---- */
const folds = $$(".kv-sf-fold");
check("details section has four disclosures", () => folds.length === 4 || `${folds.length}`);
check("disclosure titles are the documented set", () => {
  const titles = $$(".kv-sf-fold-btn").map((node) => node.textContent.replace(/\s+/g, " ").trim());
  return JSON.stringify(titles) === JSON.stringify(["درباره محصول", "جنس و متریال", "مشخصات کالا", "ارسال"]) || titles.join(" | ");
});
check("the first disclosure starts open", () => folds[0].querySelector(".kv-sf-fold-btn").getAttribute("aria-expanded") === "true");
check("closed disclosures hide their panel", () => folds[1].querySelector(".kv-sf-fold-body").hidden === true);
check("each disclosure is a real button wired to its region", () =>
  folds.every((fold) => {
    const button = fold.querySelector(".kv-sf-fold-btn");
    const panelNode = fold.querySelector(".kv-sf-fold-body");
    return button.tagName === "BUTTON"
      && button.getAttribute("aria-controls") === panelNode.id
      && panelNode.getAttribute("role") === "region";
  }));
await click(folds[1].querySelector(".kv-sf-fold-btn"));
check("activating a disclosure expands it", () =>
  folds[1].querySelector(".kv-sf-fold-btn").getAttribute("aria-expanded") === "true"
  && folds[1].querySelector(".kv-sf-fold-body").hidden === false);
await click(folds[1].querySelector(".kv-sf-fold-btn"));
check("activating it again collapses it", () => folds[1].querySelector(".kv-sf-fold-btn").getAttribute("aria-expanded") === "false");
const detailsText = $$("section[aria-labelledby='pdp-details-title'] .kv-sf-fold").map((node) => node.textContent).join(" ");
check("no vintage facts are invented", () =>
  !/سال ساخت|کشور سازنده|بازسازی|درجه کیفیت|دوره ساخت|اصالت تضمین‌شده توسط/.test(detailsText) || "invented field found");
await click(folds[3].querySelector(".kv-sf-fold-btn"));
const deliveryText = folds[3].textContent;
check("delivery panel uses the real shipping configuration", () =>
  deliveryText.includes("پست پیشتاز") && deliveryText.includes("۲ تا ۴ روز کاری") || deliveryText.slice(0, 80));
/* Phase 4: the "۷ روز مهلت برگشت" line was a hardcoded promise with no policy
   contract behind it. Delivery text may only come from live shipping config. */
check("no unbacked return/authenticity promise is rendered", () =>
  !/۷ روز|مهلت برگشت|ضمانت اصالت|تحویل تضمینی/.test($(".kv-sf-pdp").textContent) || "policy claim found");

/* ---- recommendation rails ---- */
const lookCards = $$("section[aria-labelledby='pdp-look-title'] .kv-sf-cell");
const alikeCards = $$("section[aria-labelledby='pdp-alike-title'] .kv-sf-cell");
check("complete-the-look rail is populated", () => lookCards.length > 0 || "empty");
check("you-may-also-like rail is populated", () => alikeCards.length > 0 || "empty");
const pdpName = text(".kv-sf-pdp-info h1");
check("neither rail repeats the product being viewed", () =>
  ![...lookCards, ...alikeCards].some((node) => node.querySelector(".kv-sf-cell-name").textContent === pdpName));
check("the two rails never share a product", () => {
  const looks = lookCards.map((node) => node.querySelector(".kv-sf-cell-name").textContent);
  return alikeCards.every((node) => !looks.includes(node.querySelector(".kv-sf-cell-name").textContent));
});
const pdpCategory = text("nav[aria-label='مسیر']").split("/")[1]?.trim();
check("complete-the-look pieces come from other categories", () =>
  !!pdpCategory && lookCards.every((node) => node.querySelector(".kv-sf-cell-cat").textContent !== pdpCategory) || `${pdpCategory}: ${lookCards.map((n) => n.querySelector(".kv-sf-cell-cat").textContent).join(",")}`);
check("rails stay compact (max 4 each)", () => lookCards.length <= 4 && alikeCards.length <= 4);
check("journal section on the PDP uses real entries", () =>
  $$("section[aria-labelledby='pdp-journal-title'] .kv-sf-jrnl-card").length === 3);

/* PDP purchase */
await click($(".kv-sf-pdp-info .kv-sf-size"));
const pdpCta = byText(".kv-sf-buyrow button", "افزودن به سبد خرید");
await click(pdpCta);
check("PDP add to cart confirms in Persian", () => byText(".kv-sf-buyrow button", "به سبد اضافه شد") !== null);
const wish = $(".kv-sf-buyrow .kv-sf-iconaction");
const wishedBefore = wish.getAttribute("aria-pressed");
await click(wish);
check("wishlist toggles its pressed state", () => $(".kv-sf-buyrow .kv-sf-iconaction").getAttribute("aria-pressed") !== wishedBefore);

/* in-page navigation through a rail */
const railName = lookCards[0].querySelector(".kv-sf-cell-name").textContent;
await click(lookCards[0].querySelector(".kv-sf-cell-shot"));
check("a rail card opens its own product page", () => text(".kv-sf-pdp-info h1") === railName || `${text(".kv-sf-pdp-info h1")} ≠ ${railName}`);
check("the gallery resets for the new product", () => $$(".kv-sf-thumbs .kv-sf-thumb")[0]?.getAttribute("aria-current") === "true");
await click($("nav[aria-label='مسیر'] button"));
check("the breadcrumb returns to the listing", () => !!$(".kv-sf-shell-shop") && $$(".kv-sf-cell").length > 0);

/* ---- journal ---- */
await click(byText(".kv-sf-navlink", "مجله"));
check("journal view opens", () => !!$(".kv-sf-jrnl-featured"));
const journalChips = texts(".kv-sf-shell-shop .kv-sf-chip");
check("journal chips come from real categories only", () =>
  JSON.stringify(journalChips) === JSON.stringify(["همه", "استایل", "هنر ساخت"]) || journalChips.join(" | "));
check("one large story leads the journal", () => $$(".kv-sf-jrnl-featured").length === 1);
check("the remaining stories sit in the standard grid", () => $$(".kv-sf-jrnl-grid .kv-sf-jrnl-card").length === 2);
check("no dead read action is rendered", () => !/خواندن/.test($(".kv-sf-shell-shop").textContent));
await click(byText(".kv-sf-shell-shop .kv-sf-chip", "هنر ساخت"));
check("a journal category filters the entries", () =>
  $$(".kv-sf-jrnl-featured").length === 1 && $$(".kv-sf-jrnl-grid .kv-sf-jrnl-card").length === 0);

check("no runtime errors after the full desktop flow", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));

/* ----------------------------------------------------------------- mobile */
const mobile = await boot(".smoke/out/app.js", { mobile: true });
const M = helpers(mobile.document);
check("mobile boots without errors", () => mobile.errors.length === 0 || mobile.errors.slice(0, 2).join(" | "));
await M.click(M.byText(".kv-sf-bnav-item", "فروشگاه"));
check("mobile bottom navigation reaches the shop", () => !!M.$(".kv-sf-shell-shop"));
check("mobile toolbar keeps a full-width search field", () => !!M.$(".kv-sf-field input"));
await M.click(M.$(".kv-sf-shell-shop .kv-sf-cell .kv-sf-cell-shot"));
check("mobile PDP opens", () => !!M.$(".kv-sf-pdp"));
check("mobile PDP has the sticky purchase bar", () => !!M.$(".kv-sf-buybar .kv-sf-action"));
check("mobile PDP has a swipeable gallery strip", () => M.$$(".kv-sf-pdp-gallery .kv-sf-scrollx img").length >= 2);
check("mobile gallery defers every frame but the first", () => {
  const images = M.$$(".kv-sf-pdp-gallery .kv-sf-scrollx img");
  return images[0].getAttribute("loading") === "eager" && images.slice(1).every((image) => image.getAttribute("loading") === "lazy");
});
/* Phase 4: unlayered .kv-sf-* rules outrank @layer utilities, so a `hidden lg:flex`
   utility on a display-owning element was silently dead. Those elements now carry
   no layout utility at all; the stylesheet owns the switch (asserted in the build
   audit below) and this check keeps the dead pattern from returning. */
check("no dead display utility on a display-owning element", () => {
  const owned = [".kv-sf-gallery", ".kv-sf-pdp-strip", ".kv-sf-buyrow", ".kv-sf-iconbtn"];
  const offenders = owned.flatMap((sel) => $$(sel)).map((node) => node.className)
    .filter((cls) => /(^|\s)(hidden|flex|grid|block|inline-flex)(\s|$)|(^|\s)(sm|md|lg|xl):/.test(cls));
  return offenders.length === 0 || offenders.join(" | ");
});
check("mobile bottom nav is present on the PDP", () => !!M.$(".kv-sf-bnav"));
check("no runtime errors after the mobile flow", () => mobile.errors.length === 0 || mobile.errors.slice(0, 2).join(" | "));

/* ------------------------------------------- support widget: open/close semantics */
await click($(".kv-sf-support-launch"));
check("support launcher reports its expanded state", () => $(".kv-sf-support-launch").getAttribute("aria-expanded") === "true" || $(".kv-sf-support-launch").getAttribute("aria-expanded"));
check("the panel it controls really exists", () => {
  const id = $(".kv-sf-support-launch").getAttribute("aria-controls");
  const panel = id ? d.getElementById(id) : null;
  return (!!panel && panel.className.includes("kv-sf-support-panel")) || `controls=${id}`;
});
check("support panel is a non-modal dialog, not a trap", () => {
  const panel = d.querySelector(".kv-sf-support-panel");
  return (panel.getAttribute("role") === "dialog" && !panel.hasAttribute("aria-modal")) || panel.outerHTML.slice(0, 80);
});
await click($(".kv-sf-support-launch"));
check("the same control closes it", () => !d.querySelector(".kv-sf-support-panel"));
d.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(120);
check("Escape on a closed widget is harmless", () => !d.querySelector(".kv-sf-support-panel") && env.errors.length === 0);
await click($(".kv-sf-support-launch"));
check("the panel reopens after Escape", () => !!d.querySelector(".kv-sf-support-panel"));
d.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(120);
check("Escape closes the panel", () => !d.querySelector(".kv-sf-support-panel"));
check("focus returns to the launcher, not the document body", () =>
  d.activeElement?.classList.contains("kv-sf-support-launch") || d.activeElement?.tagName);

/* ---------------------------------------- footer / demo gating / policy honesty */
const footer = d.querySelector("footer");
check("footer renders only real actions", () => {
  const controls = Array.from(footer.querySelectorAll("button, a"));
  const dead = controls.filter((node) => node.tagName === "A" && (node.getAttribute("href") ?? "#") === "#");
  return dead.length === 0 || dead.map((n) => n.textContent.trim()).join(" | ");
});
check("no newsletter form or success claim in the footer", () =>
  (!footer.querySelector("form") && !/خبرنامه|ثبت شد/.test(footer.textContent)) || "newsletter copy found");
/* Phase 4.1: the footer used to end every visit with a blanket delivery promise.
   Shipping copy may only appear when it is derived from the active shipping
   configuration, so it names that method and its threshold — or says nothing. */
check("the footer makes no blanket delivery claim", () =>
  !/با ارسال به سراسر کشور|ارسال به سراسر کشور/.test(footer.textContent) || "blanket delivery claim found");
check("any footer delivery copy is configuration-shaped, never a default", () => {
  const lines = Array.from(footer.querySelectorAll("p")).map((node) => node.textContent.trim());
  const claim = lines.find((line) => /ارسال/.test(line));
  return (!claim || /ارسال رایگان بالای [۰-۹]+ میلیون تومان/.test(claim)) || claim;
});
check("the footer prop is optional and has no literal fallback in source", () => {
  const footerSource = fs.readFileSync("src/components/storefront/StorefrontFooter.tsx", "utf8");
  const appSource = fs.readFileSync("src/App.tsx", "utf8");
  const optional = /shippingNote\?: string/.test(footerSource);
  const conditional = /\{shippingNote \?/.test(footerSource);
  const noDefault = !/shippingNote \|\| "/.test(appSource) && !/shippingNote \?\? "/.test(appSource);
  return (optional && conditional && noDefault) || `optional:${optional} conditional:${conditional} noDefault:${noDefault}`;
});
check("no unbacked contact data in the footer", () =>
  !/۰۲۱\d|tel:|ولیعصر|خیابان|اینستاگرام|تلگرام/.test(footer.textContent) || "contact copy found");
/* the smoke bundle is built in production mode (mode defaults to production), so
   the preview affordances must be gone from the DOM — exactly what a shopper sees */
/* Phase 4.1: the look rail's curated heuristic is documented as such in source,
   so nobody later mistakes the table for a catalogue-declared relationship. */
check("the look rail documents itself as a curated heuristic", () => {
  const source = fs.readFileSync("src/components/storefront/recommendations.ts", "utf8");
  return /not\*\* a relationship the catalogue declares|curated styling heuristic|curated styling opinion/.test(source) &&
    /productRelations/.test(source) || "heuristic note missing";
});
check("demo/preview controls are absent from the production DOM", () =>
  !/تست پنل‌ها|پیش‌نمایش پنل‌ها/.test(d.body.textContent) || "demo control rendered");
check("the preview affordances are gated on the dev flag in source", () => {
  const source = fs.readFileSync("src/App.tsx", "utf8");
  return /import\.meta\.env\.DEV/.test(source) && !/onDemo=\{\(?\)?=>/.test(source) || "gate not found";
});

check("cart and checkout resolve the line image through the shared colour resolver", () => {
  const cart = fs.readFileSync("src/components/storefront/CartDrawer.tsx", "utf8");
  const checkout = fs.readFileSync("src/portals/retail.tsx", "utf8");
  return (cart.includes("lineThumbnail") && checkout.includes("lineThumbnail")) ||
    `cart:${cart.includes("lineThumbnail")} checkout:${checkout.includes("lineThumbnail")}`;
});

/* ------------------------------------------------------- build / css audit */
/* the singlefile build inlines one <style rel="stylesheet"> block; search for the
   tag with attributes and take the whole document window, not a guessed slice */
const styleStart = dist.indexOf("<style");
const styleEnd = dist.lastIndexOf("</style>");
if (styleStart < 0 || styleEnd < 0) { console.error("no inlined stylesheet found"); process.exit(1); }
const css = dist.slice(styleStart, styleEnd);
check("card media is 4:5 (denser than 3:4)", () => /\.kv-sf-cell-figure\s*{[^}]*aspect-ratio:\s*4\s*\/\s*5/.test(css));
check("card grid items cannot push their track wider", () => /\.kv-sf-cell\s*{[^}]*min-width:\s*0/.test(css));
check("PDP gallery caps the photograph", () =>
  /\.kv-sf-gallery-main\s*{[^}]*max-width:\s*var\(--kvaf-gallery-max\)/.test(css)
  && /\.kv-sf-gallery-main\s*>\s*img\s*{[^}]*max-height:\s*var\(--kvaf-gallery-vh\)/.test(css));
check("gallery ratio is 4:5", () => /\.kv-sf-gallery-main\s*>\s*img\s*{[^}]*aspect-ratio:\s*4\s*\/\s*5/.test(css));
check("PDP columns are 40 / 60", () => /\.kv-sf-pdp\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(0,\s*3fr\)/.test(css));
check("the gallery is pulled above the information below lg only", () =>
  /\.kv-sf-pdp-gallery\s*{[^}]*order:\s*-1/.test(css) && /\.kv-sf-pdp-gallery\s*{[^}]*order:\s*0/.test(css));
check("thumbnails are 72px", () => /--kvaf-thumb:\s*72px/.test(css) && /\.kv-sf-thumb\s*{[^}]*width:\s*var\(--kvaf-thumb\)/.test(css));
check("filter panel docks to the side from 1024px", () => /\.kv-sf-sheet\[data-panel="?true"?\]\s*{[^}]*inset-inline-start:\s*0/.test(css));
check("reduced motion is still honoured", () => /prefers-reduced-motion:\s*reduce/.test(css));
/* Stacking order is explicit: the storefront surfaces use the named tokens only.
   The legacy dashboards (admin / supplier / style-canvas / account) still carry
   arbitrary z-index utilities — they are outside the storefront stack and are
   recorded as debt in docs/storefront-archive-fluid.md, so this audit covers the
   shopper-facing surfaces that Phase 4 ships. */
check("storefront surfaces never use an arbitrary z-index utility", () => {
  const storefrontDir = "src/components/storefront";
  const files = ["src/App.tsx", "src/components/support.tsx", "src/portals/retail.tsx",
    ...fs.readdirSync(storefrontDir).filter((name) => /\.tsx?$/.test(name)).map((name) => `${storefrontDir}/${name}`)];
  const offenders = files.filter((file) => /z-\[\d+\]/.test(fs.readFileSync(file, "utf8")));
  return offenders.length === 0 || offenders.join(" | ");
});
check("the named stacking tokens exist and order correctly", () => {
  const token = (name) => Number(new RegExp(`--kvaf-z-${name}:\\s*(\\d+)`).exec(css)?.[1] ?? -1);
  const stack = ["header", "bnav", "support", "drawer", "search", "sheet", "toast"].map((name) => [name, token(name)]);
  const values = stack.map(([, value]) => value);
  return values.every((value, index) => value > 0 && (index === 0 || value > values[index - 1])) || JSON.stringify(stack);
});
/* The mobile bands are arithmetic, not vibes: every fixed surface on a product
   page derives its offset from --kvaf-bottomnav-space and clears the one below it. */
check("the mobile bands derive from one token and never overlap", () => {
  const gap = (marker) => {
    const rule = new RegExp(`${marker}\\{[^}]*bottom:calc\\(var\\(--kvaf-bottomnav-space\\)\\s*\\+\\s*env\\(safe-area-inset-bottom,\\s*0px\\)\\s*\\+\\s*(\\d+)px\\)`).exec(css);
    return Number(rule?.[1] ?? -1);
  };
  /* the token is 0px on desktop and the real value inside the mobile query, so the
     arithmetic is checked against the largest declared value */
  const nav = Math.max(...[...css.matchAll(/--kvaf-bottomnav-space:\s*(\d+)px/g)].map((match) => Number(match[1])));
  const buybarGap = gap("\\.kv-sf-buybar");
  const toastGap = gap("\\.kv-storefront:has\\(\\.kv-sf-buybar\\) \\.kv-sf-toasts");
  /* the minifier drops quotes from attribute selectors and keeps a space after
     the custom-property colon, so both regexes are tolerant of that */
  const lift = Number(/\.kv-sf-support\[data-buybar="?true"?\]\s*\{\s*--kvaf-support-lift:\s*(\d+)px/.exec(css)?.[1] ?? -1);
  /* the purchase bar must also sit *below* the bottom nav in the stack */
  const buybarBelowNav = /\.kv-sf-buybar\{[^}]*z-index:calc\(var\(--kvaf-z-bnav\) - 1\)/.test(css);
  /* and the whole column must carry the safe-area inset, not just the nav */
  const safeArea = /\.kv-sf-support\{[^}]*--kvaf-support-bottom:\s*calc\(var\(--kvaf-bottomnav-space\) \+ var\(--kvaf-support-lift\) \+ env\(safe-area-inset-bottom, 0px\)\)/.test(css);
  const ok = nav > 0 && buybarGap > 0 && lift > buybarGap && toastGap >= lift && buybarBelowNav && safeArea;
  return ok || JSON.stringify({ nav, buybarGap, toastGap, lift, buybarBelowNav, safeArea });
});
/* Phase 4: the support panel is deliberately clamped to the viewport
   (`min(320px, calc(100vw - 1.5rem))`) instead of a rigid 270px, so a viewport unit
   is allowed there and only there. */
const vwRules = [...css.matchAll(/([^{}]+)\{([^{}]*100vw[^{}]*)\}/g)].map((match) => match[1].trim());
check("viewport width is used only to clamp the support panel", () =>
  (vwRules.length > 0 && vwRules.every((selector) => selector.includes(".kv-sf-support-panel"))) || vwRules.join(" | ") || "no 100vw rule found");
/* and the responsive display switch really is owned by the stylesheet */
check("the stylesheet owns the PDP mobile/desktop gallery switch", () => {
  const base = /\.kv-sf-gallery\{[^}]*display:\s*none/.test(css);
  const desktop = /@media[^{]*min-width:\s*1024px[^{]*\{[^@]*\.kv-sf-gallery\{[^}]*display:\s*flex/.test(css);
  return (base && desktop) || `base:${base} lg:${desktop}`;
});
const scrollers = [...css.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*auto[^{}]*\}/g)].map((match) => match[1].trim());
/* .kv-sf-cats is the circular category rail, .kv-sf-recs the recommendation rail —
   both are deliberate scrollers with hidden scrollbars and scroll snapping */
const allowed = [".kv-sf-scrollx", ".kv-sf-thumbs", ".kv-sf-recs", ".kv-sf-cats", ".overflow-x-auto"];
check("horizontal scroll exists only inside explicit rails", () =>
  scrollers.every((selector) => allowed.some((rule) => selector.includes(rule))) || scrollers.filter((s) => !allowed.some((r) => s.includes(r))).join(" | "));
check("accordion styles ship in the build", () => /\.kv-sf-fold-btn\[aria-expanded="?true"?\]/.test(css));

process.exit(done({ scrollers: scrollers.length }) ? 1 : 0);
