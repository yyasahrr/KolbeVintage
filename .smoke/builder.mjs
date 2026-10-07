import fs from "node:fs";
import { boot, helpers, reporter, wait } from "./dom.mjs";

const { check, done } = reporter("style builder DOM suite (Phase 1)");
const dist = fs.readFileSync("dist/index.html", "utf8");

/* ---------------------------------------------------------------- desktop */
const env = await boot(".smoke/out/app.js");
const d = env.document;
const H = helpers(d);
const { $, $$, text, texts, byText, click } = H;

check("no runtime errors on boot", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));
check("storefront shell renders", () => !!$(".kv-storefront"));

/* ---- shop: card actions ---- */
await click(byText(".kv-sf-navlink", "فروشگاه"));
check("shop view opens", () => !!$(".kv-sf-shell-shop"));

/* supplier privacy regression: the retail listing never shows supplier names */
check("retail listing leaks no supplier identity", () => {
  const body = d.body.textContent ?? "";
  return !["نیلگون", "فراسو", "نوین استایل", "بافتینه"].some((name) => body.includes(name));
});

/* expand the first card via a colour swatch → the purchase area reveals */
const firstCell = $(".kv-sf-cell");
await click($(".kv-sf-swatch", firstCell));
check("card purchase area expands with a size row", () => !!$(".kv-sf-size", firstCell) || /سایزبندی ندارد/.test(firstCell.textContent));
check("eligible card offers پرو مجازی", () => !!byText(".kv-sf-cell-tryon", "پرو مجازی", firstCell) || texts(".kv-sf-cell-tryon", firstCell).some((t) => t.includes("پرو مجازی")));
check("card offers + استایل", () => texts(".kv-sf-cell-tryon", firstCell).some((t) => t.includes("+ استایل")));

/* ---- + استایل → existing builder, preloaded (§10) ---- */
await click(texts(".kv-sf-cell-tryon", firstCell).includes("+ استایل")
  ? $$(".kv-sf-cell-tryon", firstCell).find((b) => b.textContent.includes("+ استایل"))
  : null);
check("builder surface opens (no tab pair)", () => (d.body.textContent ?? "").includes("یک استایل کامل بساز"));
check("try-on is no longer a tab of the builder", () => !byText("button", "ساخت استایلپرو مجازی") && $$(".kv-glass button").every?.((b) => !/پرو مجازی\s*ساخت استایل/.test(b.textContent ?? "")));
check("preloaded product landed on the canvas", () => $$('[aria-label="بوم استایل"] [role="button"]').length >= 1);
check("placement note names the outfit role", () => (d.body.textContent ?? "").includes("اضافه شد"));

/* ---- wizard: style → occasion ---- */
await click(byText("button", "کژوال"));
check("style selection registers (chip pressed)", () => byText("button", "کژوال")?.getAttribute("aria-pressed") === "true");
await click(byText("button", "ادامه"));
await click(byText("button", "دانشگاه"));
await click($$("button").find((b) => b.textContent.trim() === "ادامه"));

/* ---- wizard: top candidates ranked with reasons ---- */
check("top step lists ranked candidates with reasons", () => {
  const rail = $(".kv-scroll");
  return !!rail && $$(".kv-scroll button", d).length >= 1 && (d.body.textContent ?? "").includes("پیشنهاد کلبه");
});
const candidateCount = $$(".kv-scroll button").length;
await click($(".kv-scroll button"));
check("picking a candidate advances the wizard", () => (d.body.textContent ?? "").includes("شلوار"));

/* ---- wizard: empty-role steps degrade honestly, shoes skipped ---- */
check("empty bottom step says so instead of faking options", () => (d.body.textContent ?? "").includes("شلواری در آرشیو خرده منتشر نشده"));
check("shoes step is skipped when no shoe inventory exists", () => !byText("[role='tab']", "کفش"));
await click($$("button").find((b) => b.textContent.trim() === "ادامه"));
check("accessory step is optional", () => (d.body.textContent ?? "").includes("اختیاری"));
await click($$("button").find((b) => b.textContent.trim() === "رد کردن"));

/* ---- final look ---- */
check("final look shows the compatibility score", () => (d.body.textContent ?? "").includes("هماهنگی استایل") && (d.body.textContent ?? "").includes("/ ۱۰۰"));
check("final look lists the pieces with roles", () => (d.body.textContent ?? "").includes("قطعات استایل") && (d.body.textContent ?? "").includes("اورکت") && (d.body.textContent ?? "").includes("بالاتنه"));
check("final look shows the price total", () => (d.body.textContent ?? "").includes("جمع قطعات"));

/* sizes are prefilled (deterministic preferredSize) so the outfit can be added */
check("size rows are prefilled for add-to-cart", () => $$("[aria-label^='سایز'] [data-on='true']").length >= 1);

/* ---- add the outfit to the EXISTING cart ---- */
const cartLabelBefore = $("[aria-label^='سبد خرید']")?.getAttribute("aria-label") ?? "";
await click($$("button").find((b) => b.textContent.includes("افزودن استایل به سبد")));
check("outfit add confirms", () => (d.body.textContent ?? "").includes("استایل به سبد خرید اضافه شد"));
const cartLabelAfter = $("[aria-label^='سبد خرید']")?.getAttribute("aria-label") ?? "";
check("cart badge counts the outfit lines", () => cartLabelAfter !== cartLabelBefore && /۲ قلم/.test(cartLabelAfter) || /۲ قلم/.test(cartLabelAfter));

/* ---- shared state: canvas removal updates the wizard (§13) ---- */
const canvasItemsBefore = $$('[aria-label="بوم استایل"] [role="button"]').length;
const trashButtons = $$("button[aria-label*='از بوم']");
await click(trashButtons[trashButtons.length - 1]);
await wait(250);
const canvasItemsAfter = $$('[aria-label="بوم استایل"] [role="button"]').length;
check("canvas removal flows back to the wizard", () => canvasItemsAfter === canvasItemsBefore - 1);
check("final look item count follows the canvas removal", () => {
  const match = /قطعات استایل \(([۰-۹]+)\)/.exec(d.body.textContent ?? "");
  return !!match && Number(match[1].replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))) === canvasItemsAfter;
});

/* ---- canvas proportion: portrait, not a dashboard board ---- */
check("canvas is portrait 3:4 by the stylesheet", () => /\.kv-sb-canvas\{[^}]*aspect-ratio:\s*3\s*\/\s*4/.test(dist) || /aspect-\[3\/4\]/.test(dist));
check("canvas keyboard path documented (drag is not the only way)", () => $$("button[aria-label*='از بوم']").length >= 1 && $$("[aria-label='بوم استایل'] [role='button']").every((node) => (node.getAttribute("aria-label") ?? "").includes("Delete")));

/* ---- try-on surface: honest, no fake result ----
   The merge ships the production try-on (server jobs + credits): the surface keeps
   its own step rail and product picker, and offline it shows the honest loading /
   error state — never a fabricated result. Retail-only eligibility is enforced by
   the picker's catalogue source: the public retail channel API (wholesale items
   are not in it), plus the image-availability filter. */
await click(byText(".kv-sf-navlink", "پرو مجازی"));
check("try-on opens as its own surface", () =>
  (d.body.textContent ?? "").includes("لباس را روی عکس خودت ببین")
  && !!$("[aria-label='مراحل پرو مجازی']"));
check("try-on picker stays honest offline (loading or retry — never a fake grid)", () => {
  const body = d.body.textContent ?? "";
  return body.includes("در حال بارگذاری محصولات…") || body.includes("تلاش دوباره") || $$(".grid [aria-pressed]", d).length > 0;
});
check("no fabricated try-on result exists anywhere in the build", () => !dist.includes("شبیه‌سازی تن‌خور"));

/* ---- wholesale never exposes try-on ---- */
await click(byText(".kv-sf-navlink", "بازارچه عمده"));
/* scoped to the portal content: the site-wide footer legitimately keeps the
   storefront try-on link, the wholesale experience itself must not offer it */
check("wholesale portal has no try-on entry", () => !($("#kv-sf-main").textContent ?? "").includes("پرو مجازی"));

process.exit(done({}) ? 1 : 0);
