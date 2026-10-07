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
check("the card shows item count and complete cash total", () => (card?.textContent ?? "").includes("قطعه") && (card?.textContent ?? "").includes("جمع کامل"));
check("the card carries both card-level actions, no size selector", () => !!byText(".kv-style-card button", "مشاهده استایل") && !!byText(".kv-style-card button", "ساخت استایل شخصی"));

/* the CURATED surfaces keep supplier identity out — pre-existing baseline
   journal/CMS teasers elsewhere on the homepage are out of Phase-3 scope */
check("style cards leak no supplier identity", () =>
  !$$(".kv-style-card").some((card) => SUPPLIERS.some((name) => (card.textContent ?? "").includes(name))));

/* ── the reader (style detail) ── */
await click(byText(".kv-style-card button", "مشاهده استایل"));
check("the style reader opens", () => !!$(".kv-style-detail"));
check("the reader carries the style title as its heading", () => ($(".kv-style-heading")?.textContent ?? "").includes("ست ترنچ و پیراهن کلبه"));
check("the document title reflects the open style", () => (d.title ?? "").includes("ست ترنچ و پیراهن کلبه"));
check("pinned colours are marked as fixed for this style", () => inMain().includes("ثابت است"));
check("each item offers its own size row", () => $$(".kv-style-item .kv-style-sizes").length >= 2);
check("the live composition panel renders totals", () => inMain().includes("ترکیب استایل شما") && inMain().includes("مبلغ قابل پرداخت"));
check("the eligible style discount shows in the panel", () => inMain().includes("تخفیف استایل"));
check("the whole-style CTA is present and enabled", () => (texts(".kv-style-cta")[0] ?? "").includes("افزودن کل استایل به سبد") && !$(".kv-style-cta[disabled]"));
check("the reader leaks no supplier identity", () => !SUPPLIERS.some((name) => inMain().includes(name)));

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
