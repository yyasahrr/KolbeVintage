import fs from "node:fs";
import { boot, helpers, reporter, wait } from "./dom.mjs";

const { check, done } = reporter("storefront DOM suite (phase 3)");
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
check("brand and SKU are shown", () => {
  const brand = $(".kv-sf-pdp-info p").textContent;
  const sku = $(".kv-sf-pdp-info bdi").textContent;
  return brand.length > 0 && /^[A-Z]{2,5}-[A-Z]{2,4}-\d{3}$/.test(sku) || `${brand} / ${sku}`;
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
check("stock is stated from the product record", () => /موجود در انبار|ناموجود/.test($(".kv-sf-pdp-info").textContent));
check("the selection summary is announced", () => $(".kv-sf-summary")?.getAttribute("aria-live") === "polite");
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
  return JSON.stringify(titles) === JSON.stringify(["درباره محصول", "جنس و متریال", "وضعیت کالا", "ارسال و مرجوعی"]) || titles.join(" | ");
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
check("return window is the existing store label", () => deliveryText.includes("۷ روز مهلت برگشت"));

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
check("mobile PDP hides the desktop gallery markup", () => M.$(".kv-sf-gallery").className.includes("hidden"));
check("mobile bottom nav is present on the PDP", () => !!M.$(".kv-sf-bnav"));
check("no runtime errors after the mobile flow", () => mobile.errors.length === 0 || mobile.errors.slice(0, 2).join(" | "));

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
check("no viewport-width unit anywhere in the build", () => !/100vw/.test(dist));
const scrollers = [...css.matchAll(/([^{}]+)\{[^{}]*overflow-x:\s*auto[^{}]*\}/g)].map((match) => match[1].trim());
/* .kv-sf-cats is the circular category rail, .kv-sf-recs the recommendation rail —
   both are deliberate scrollers with hidden scrollbars and scroll snapping */
const allowed = [".kv-sf-scrollx", ".kv-sf-thumbs", ".kv-sf-recs", ".kv-sf-cats", ".overflow-x-auto"];
check("horizontal scroll exists only inside explicit rails", () =>
  scrollers.every((selector) => allowed.some((rule) => selector.includes(rule))) || scrollers.filter((s) => !allowed.some((r) => s.includes(r))).join(" | "));
check("accordion styles ship in the build", () => /\.kv-sf-fold-btn\[aria-expanded="?true"?\]/.test(css));

process.exit(done({ scrollers: scrollers.length }) ? 1 : 0);
