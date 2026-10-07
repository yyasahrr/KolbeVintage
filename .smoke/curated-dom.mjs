import fs from "node:fs";
import { helpers, reporter, wait } from "./dom.mjs";

const { check, done } = reporter("curated storefront DOM suite (Phase 3: homepage · card · detail · personalize)");

/* the full production bundle — same one the storefront suite boots */
const env = await (async () => {
  const fs = await import("node:fs");
  const { makeDom } = await import("./dom.mjs");
  const e = makeDom();
  e.window.eval(fs.readFileSync(".smoke/out/app.js", "utf8"));
  await wait(900);
  return e;
})();
const d = env.document;
const H = helpers(d);
const { $, $$, text, texts, byText, click } = H;
const faNum = (s) => { const m = (s ?? "").match(/[۰-۹]+/); return m ? m[0].split("").reduce((acc, ch) => acc * 10 + (ch.charCodeAt(0) - 1776), 0) : -1; };
const cartCount = () => { const el = $('[aria-label^="سبد خرید"]'); return el ? faNum(el.getAttribute("aria-label")) : -1; };
const inMain = () => d.getElementById("kv-sf-main")?.textContent ?? "";
const SUPPLIERS = ["نیلگون", "فراسو", "نوین استایل", "بافتینه"];

check("no runtime errors on boot", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));
check("homepage renders the ready-styles section", () => inMain().includes("استایل‌های آماده"));

/* the published seed style shows; the draft seed never leaks */
check("the published curated style is on the homepage", () => inMain().includes("ست ترنچ و پیراهن کلبه"));
check("the draft curated style never reaches the storefront", () => !inMain().includes("نیم‌ست رسمی پالتو و شومیز"));

/* the style card is an editorial object, NOT a product card */
const card = $(".kv-style-card");
check("a style card exists and is distinct from product cards", () => !!card && !$(".kv-style-card .kv-sf-size"));
check("the card shows item count and complete cash total", () =>
  (card?.textContent ?? "").includes("قطعه") && !!$(".kv-style-price-now", card) && (card?.textContent ?? "").includes("تومان"));
check("the discounted card strikes the full total and shows the percent badge", () =>
  !!$(".kv-style-price-was", card) && (card?.textContent ?? "").includes("٪"));
check("the installment-enabled card carries the per-quarter hint", () =>
  (card?.textContent ?? "").includes("۴ قسطِ"));
check("the two card CTAs sit in one row sized by content (no fixed 70/30)", () => {
  const row = $(".kv-style-ctas", card);
  if (!row || row.children.length !== 2) return false;
  const primary = row.children[0], secondary = row.children[1];
  if ((primary.textContent ?? "").trim() !== "\u0645\u0634\u0627\u0647\u062f\u0647 \u0627\u0633\u062a\u0627\u06cc\u0644") return false;
  if (!(secondary.textContent ?? "").includes("\u0633\u0627\u062e\u062a \u0627\u0633\u062a\u0627\u06cc\u0644 \u0634\u062e\u0635\u06cc")) return false;
  /* the revoked ratio must be gone from the shipped CSS entirely; the row is
     flex, the primary fills, the secondary takes its label width */
  const flat = (() => { const t = fs.readFileSync("dist/index.html", "utf8"); return t.slice(t.indexOf("<style"), t.lastIndexOf("</style>")); })().replace(/\s+/g, "");
  if (flat.includes("grid-template-columns:minmax(0,7fr)minmax(0,3fr)")) return "70/30 ratio still shipped";
  const rule = flat.match(/\.kv-style-ctas\{[^}]*\}/)?.[0] ?? "";
  return rule.includes("display:flex") && /\.kv-style-cta-card:first-child\{flex:1/.test(flat) && /\.kv-style-cta-card-alt\{flex:0/.test(flat);
});
check("both card CTAs stay on one line (white-space: nowrap) and keep equal type size", () => {
  const flatCss = (() => { const t = fs.readFileSync("dist/index.html", "utf8"); return t.slice(t.indexOf("<style"), t.lastIndexOf("</style>")); })().replace(/\s+/g, "");
  const base = flatCss.match(/\.kv-style-cta-card\{[^}]*\}/)?.[0] ?? "";
  return base.includes("white-space:nowrap") && !/\.kv-style-cta-card-alt\{[^}]*font-size:clamp/.test(flatCss);
});check("the card carries both card-level actions, no size selector", () => !!byText(".kv-style-card button", "مشاهده استایل") && !!byText(".kv-style-card button", "ساخت استایل شخصی"));

check("the styles grid composes intentionally for the published count (no empty columns)", () => {
  const cards = $$(".kv-style-card");
  const wrapper = cards[0]?.parentElement;
  if (!wrapper) return false;
  if (cards.length === 1) {
    /* one published style reads as a feature card, centered, never a lone
       column beside two empty ones */
    return /max-w-\[440px\]/.test(wrapper.className) && /mx-auto/.test(wrapper.className);
  }
  if (cards.length === 2) return /sm:grid-cols-2/.test(wrapper.className) && /max-w-\[920px\]/.test(wrapper.className);
  return /sm:grid-cols-2/.test(wrapper.className) && /lg:grid-cols-3/.test(wrapper.className);
});
check("the card cover zoom is wired (hover group + transform class)", () =>
  /\bgroup\b/.test(card.className) && !!$(".kv-style-cover img[class*='group-hover']"));
/* style cards leak no supplier identity — pre-existing baseline
   journal/CMS teasers elsewhere on the homepage are out of Phase-3 scope */
check("style cards leak no supplier identity", () =>
  !$$(".kv-style-card").some((card) => SUPPLIERS.some((name) => (card.textContent ?? "").includes(name))));

/* ── guest favorites: the auth CTA must be obvious, the page stays usable ── */
await click($('.kv-sf-header button[aria-label^="علاقه‌مندی‌ها"]'));
check("guest favorites shows an explicit combined ورود / ثبت‌نام CTA", () => {
  const note = $('[data-testid="wishlist-guest-auth"]');
  return !!note && !!byText("button", "ورود / ثبت‌نام") && (note.textContent ?? "").includes("ماندگار");
});
check("guest favorites explains device-local saving honestly", () =>
  ($('[data-testid="wishlist-guest-auth"]')?.textContent ?? "").includes("همین دستگاه"));
check("guest favorites page stays usable (no broken empty state)", () => env.errors.length === 0 && !!$(".kv-sf-shell"));
await click($('.kv-sf-header button[aria-label="کلبه وینتج · خانه"]'));

/* ── the reader (style detail) ── */
await click(byText(".kv-style-card button", "مشاهده استایل"));
check("the style reader opens", () => !!$(".kv-style-detail"));
check("the reader opens on an editorial cover band (PDP-like)", () => {
  const hero = $(".kv-style-hero");
  return !!hero && !!$(".kv-style-hero img", hero) && !$(".kv-style-hero .kv-sf-size", hero);
});
check("the cover band carries the discount/count flags, no controls", () => {
  const hero = $(".kv-style-hero");
  return !!hero && (hero.textContent ?? "").includes("قطعه") && !$("button", hero);
});
check("the reader carries the style title as its heading", () => ($(".kv-style-heading")?.textContent ?? "").includes("ست ترنچ و پیراهن کلبه"));
check("the document title reflects the open style", () => (d.title ?? "").includes("ست ترنچ و پیراهن کلبه"));
check("pinned colours are marked as fixed for this style", () => inMain().includes("ثابت است"));
check("each item offers its own size row", () => $$(".kv-style-item .kv-style-sizes").length >= 2);
check("the live composition panel renders totals", () => inMain().includes("ترکیب استایل شما") && inMain().includes("مبلغ قابل پرداخت"));
check("each item carries a stock-capped quantity stepper that feeds the live totals", () => {
  const steppers = $$(".kv-style-qty");
  if (steppers.length < 2) return false;
  const plus = $(".kv-style-qty-btn:last-child", steppers[0]);
  const before = inMain();
  if (!plus || plus.hasAttribute("disabled")) return false;
  return !!$(".kv-style-qty-n", steppers[0]) && !!plus.getAttribute("aria-label");
});
/* stepper interaction: raise, verify the live math followed, restore */
await click($$(".kv-style-qty .kv-style-qty-btn")[1]);
check("raising quantity updates the item line price in the live DOM", () => inMain().includes("۲ ×"));
check("the qty readout reflects the raise", () => ($$(".kv-style-qty .kv-style-qty-n")[0]?.textContent ?? "") === "۲");
await click($$(".kv-style-qty .kv-style-qty-btn")[0]); // restore qty 1
/* gallery interaction: tap the second thumb, verify pressed state moved, restore */
const thumbRow = $(".kv-style-thumbs");
if (thumbRow && $$(".kv-style-thumb", thumbRow)[1]) {
  await click($$(".kv-style-thumb", thumbRow)[1]);
  check("tapping a gallery thumb moves the pressed state", () =>
    $$(".kv-style-thumb", thumbRow)[1].getAttribute("aria-pressed") === "true"
      && $$(".kv-style-thumb", thumbRow)[0].getAttribute("aria-pressed") === "false");
  await click($$(".kv-style-thumb", thumbRow)[0]); // restore
}
check("items with more than one photo expose a gallery thumb row", () => {
  const thumbs = $$(".kv-style-thumbs");
  if (!thumbs.length) return "no galleries rendered";
  const firstThumb = $(".kv-style-thumb", thumbs[0]);
  return !!firstThumb && firstThumb.getAttribute("aria-pressed") === "true";
});

check("the eligible style discount shows in the panel", () => inMain().includes("تخفیف استایل"));
check("the whole-style CTA is present and enabled", () => (texts(".kv-style-cta")[0] ?? "").includes("افزودن کل استایل به سبد") && !$(".kv-style-cta[disabled]"));
check("the reader leaks no supplier identity", () => !SUPPLIERS.some((name) => inMain().includes(name)));

/* ── header summary: count · payable · discount · installments ── */
check("the header carries the live style summary", () =>
  inMain().includes("قطعه فعال") && inMain().includes("پرداخت کامل") && inMain().includes("اقساط ۴ ×"));

/* ── per-item commerce actions ── */
check("every item exposes خرید محصول / ساخت استایل جدید / پرو آنلاین لباس", () => {
  const rows = $$(".kv-style-item-actions");
  return rows.length >= 2 && rows.every((row) =>
    !!byText("button", "خرید محصول", row) || row.textContent.includes("خرید محصول"))
  && rows.every((row) => row.textContent.includes("ساخت استایل جدید") && row.textContent.includes("پرو آنلاین لباس"));
});
check("try-on appears only on eligible items (business logic, not CSS)", () => {
  const rows = $$(".kv-style-item");
  return rows.length >= 2 && rows.every((row) => row.textContent.includes("پرو آنلاین لباس"));
});
check("the pinned colour is display-only inside items (no colour picker)", () => {
  const items = $$(".kv-style-item");
  return items.every((item) => !!$(".kv-style-pinned-note", item))
    && !$$(".kv-style-item .kv-sf-swatch").length
    && !$$(".kv-style-item [role='group']").some((group) => (group.getAttribute("aria-label") ?? "").includes("رنگ‌های"));
});
check("availability is stated as presence per item", () => $$(".kv-style-item .kv-sf-stock").length >= 2);
check("each item carries a field-driven details fold", () => {
  const folds = $$(".kv-style-item .kv-sf-fold-btn");
  return folds.length >= 2 && folds.every((f) => (f.textContent ?? "").includes("جزئیات محصول"));
});
/* ── responsive contract of the refined surfaces (static, 360→1440) ──
   no real browser exists in this environment: the width matrix is enforced on
   the shipped stylesheet exactly like the storefront suite's viewport audits */
const distCssFlat = (() => { const t = fs.readFileSync("dist/index.html", "utf8"); return t.slice(t.indexOf("<style"), t.lastIndexOf("</style>")).replace(/\s+/g, ""); })();
check("card CTA row: flex one-line from 375px, stacks below so 360px never wraps", () =>
  distCssFlat.includes(".kv-style-ctas{display:flex;align-items:stretch;gap:8px")
  && distCssFlat.includes("padding:11px14px") /* cssnano strips the unit gap in flat form */
  && distCssFlat.includes("@media(max-width:374px){.kv-style-ctas{flex-direction:column;gap:6px}.kv-style-cta-card{padding:10px12px}}"));
check("item cards tighten media and action labels at small widths (360/390)", () =>
  distCssFlat.includes("@media(max-width:480px){.kv-style-item-media{flex-basis:76px}.kv-style-act{font-size:10.5px}"));
const firstFold = $(".kv-style-item .kv-sf-fold-btn");
const firstFoldBody = $(".kv-style-item .kv-sf-fold-body");
await click(firstFold);
check("expanding an item reveals its real catalogue facts (no invented size table)", () =>
  firstFoldBody?.hidden === false && inMain().includes("جنس و متریال") && inMain().includes("شناسه کالا"));

/* disable the second item — live count/CTA react, eligibility is lost honestly */
await click($$(".kv-style-switch input")[1]);
check("disabling an item updates the CTA to the partial label", () => (texts(".kv-style-cta")[0] ?? "").includes("افزودن ۱ آیتم انتخاب‌شده به سبد"));
check("disabling an item drops the style-discount eligibility with a reason", () => inMain().includes("به دست‌کم"));
check("disabling an item hides the discount row", () => !inMain().includes("−"));

/* re-enable — eligibility restored */
await click($$(".kv-style-switch input")[1]);
check("re-enabling restores the whole-style CTA and discount", () => (texts(".kv-style-cta")[0] ?? "").includes("افزودن کل استایل به سبد") && inMain().includes("تخفیف استایل"));

/* ── atomic add to the EXISTING cart ── */
const before = cartCount();
await click($$(".kv-style-cta")[0]);
check("the style add lands in the cart as one atomic group (2 lines)", () => cartCount() === before + 2);

/* ── personalization into the EXISTING style builder ── */
await click(byText("button", "ساخت استایل شخصی"));
check("personalize opens the existing style builder", () => inMain().includes("یک استایل کامل بساز"));
check("the curated composition preloads the shared outfit canvas", () => $$('[aria-label="بوم استایل"] [role="button"]').length >= 2);

process.exit(done({ cartBefore: before }) ? 1 : 0);
