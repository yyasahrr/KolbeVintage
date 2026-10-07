import { helpers, reporter, wait } from "./dom.mjs";
import fs from "node:fs";

const { check, done } = reporter("admin styling DOM suite (Phase 2: compatibility + curated)");

/* the probe mounts the real admin components directly (console login needs a
   live server) — same components, same store, zero fake state */
const env = await (async () => {
  const { makeDom } = await import("./dom.mjs");
  const e = makeDom();
  e.window.eval(fs.readFileSync(".smoke/out/admin-styling.js", "utf8"));
  await wait(700);
  return e;
})();
const d = env.document;
const H = helpers(d);
const { $, $$, text, texts, byText, click } = H;

const report = () => JSON.parse($("#out").textContent || "{}");
check("no runtime errors on boot", () => env.errors.length === 0 || env.errors.slice(0, 2).join(" | "));

/* ══════════ 1. Compatibility studio (inside the retail product editor) ══════════ */

check("source colour variants render first", () => $$("#compat [aria-label='انتخاب رنگ مبدأ'] button").length >= 2);
check("target catalogue lists real products", () => $$("#compat .kv-press").length >= 0 && (text("#compat") ?? "").includes("رنگ مبدأ"));

/* expand the first target product row */
const firstTarget = $("#compat [aria-label='فهرست محصول هدف'] > div:first-child button[aria-expanded]");
await click(firstTarget);
check("target row expands into colour-variant rows", () => $$("#compat [role='group'][aria-label^='هماهنگی با']").length >= 1);

/* set a strong_match relation on the first colour row */
const firstColourGroup = $("#compat [role='group'][aria-label^='هماهنگی با']");
const strongBtn = byText("button", "خیلی مناسب", firstColourGroup);
await click(strongBtn);
check("setting a level writes one canonical relation", () => report().relations.length === 1 && report().relations[0].level === "strong_match");
check("relation id is the symmetric product::colour pair", () => /^[^|]+::[^|]+\|[^|]+::[^|]+$/.test(report().relations[0].id));

/* clicking the active level again clears it */
await click(byText("button", "خی مناسب", firstColourGroup) ?? byText("button", "خیلی مناسب", firstColourGroup));
check("re-clicking the active level clears the relation", () => report().relations.length === 0);

/* re-set and use the productivity ops */
await click(byText("button", "خیلی مناسب", firstColourGroup));
check("copy-from-another-colour control exists", () => !!$("#compat select[aria-label='کپی روابط از رنگ دیگر']"));
const applyAll = byText("#compat button", "اعمال به همه رنگ‌ها");
await click(applyAll);
check("apply-to-all-colours fans relations out across the source product", () => report().relations.length >= 2);
check("fanned relations keep one level and stay canonical", () => report().relations.every((r) => r.level === "strong_match" && /^[^|]+\|[^|]+$/.test(r.id)));
check("admin flash names the productivity result", () => ($("#flash").textContent || "").includes("رنگ دیگر"));

/* only-defined filter (a checkbox inside a label) */
const definedToggle = () => $$("#compat input[type='checkbox']")[1];
await click(definedToggle());
check("only-defined filter narrows targets to related products", () => (text("#compat") ?? "").includes("رابطه"));
await click(definedToggle());

/* ══════════ 2. Curated Style studio ══════════ */

check("seeded styles list renders with titles", () => (text("#curated") ?? "").includes("ست ترنچ و پیراهن کلبه"));
check("seed styles render their status chips", () => (text("#curated") ?? "").includes("منتشر شده"));
check("installment preview shows in the list", () => (text("#curated") ?? "").includes("۴ ×"));
check("the four seeded styles are all published and public", () => report().publicStyles === 4 && report().styles.length === 4);

/* live pricing resolves from real products */
check("demo style subtotal equals the live product sum", () => report().seedDemo1.subtotal > 0);
check("demo percentage discount computes on the live subtotal", () => report().seedDemo1.discount === Math.round(report().seedDemo1.subtotal * 0.1));
check("automatic installments quarter the discounted total", () => report().seedDemo1.installment.mode === "automatic" && report().seedDemo1.installment.perInstallment === Math.ceil((report().seedDemo1.subtotal - report().seedDemo1.discount) / 4));

/* create → validate → add item → publish */
await click(byText("#curated button", "استایل جدید"));
check("editor opens with numbered sections", () => (text("#curated") ?? "").includes("اطلاعات استایل") && (text("#curated") ?? "").includes("قیمت‌گذاری استایل"));
check("empty title blocks saving with a named issue", () => (text("#curated") ?? "").includes("عنوان استایل الزامی است."));

/* add the first real product from the picker */
await click($("#curated .grid button:not([disabled])"));
check("item lands with pinned colours and role select", () => $$("#curated select[aria-label^='نقش']").length >= 1 && (text("#curated") ?? "").includes("رنگ پین‌شده"));

/* type a title through the real controlled input */
const titleInput = $("#curated input[placeholder^='مثلاً']");
const setter = Object.getOwnPropertyDescriptor(env.window.HTMLInputElement.prototype, "value").set;
setter.call(titleInput, "استایل تستی سوییت");
titleInput.dispatchEvent(new env.window.Event("input", { bubbles: true }));
await wait(120);
check("validation clears once the title exists", () => !(text("#curated") ?? "").includes("عنوان استایل الزامی است."));

/* media editor: candidates from the picked item, ordering badges, honest video form */
check("the media section lists gallery candidates from the item's real images", () => (text("#curated") ?? "").includes("افزودن از تصاویر قطعات"));
const mediaAdd = $("#curated button[aria-label='افزودن تصویر به گالری']");
await click(mediaAdd);
check("adding an image creates the ordered cover entry", () => !!$("#curated button[aria-label='حذف رسانه ۱']") && !!$("#curated button[aria-label='جابه‌جایی به جلو ۱']"));
check("the video form refuses non-https input", () => {
  const btn = byText("#curated button", "افزودن ویدیو به گالری");
  return !!btn && btn.hasAttribute("disabled");
});

await click(byText("#curated button", "انتشار در فروشگاه"));
check("publish persists a fifth style", () => report().styles.length === 5);
check("the new style is published and now public", () => report().publicStyles === 5);
check("flash confirms the publish", () => ($("#flash").textContent || "").includes("منتشر شد"));
await click(byText("#curated button", "بستن ویرایشگر"));
check("the published style appears in the list", () => (text("#curated") ?? "").includes("استایل تستی سوییت"));

/* archive path exists for published styles */
await click(byText("#curated button", "استایل جدید"));
await click($("#curated .grid button:not([disabled])"));
setter.call($("#curated input[placeholder^='مثلاً']"), "آرشیو تستی");
$("#curated input[placeholder^='مثلاً']").dispatchEvent(new env.window.Event("input", { bubbles: true }));
await wait(120);
await click(byText("#curated button", "ذخیره پیش‌نویس"));
check("draft save keeps the style out of the public lens", () => report().styles.length === 6 && report().publicStyles === 5);

process.exit(done({}) ? 1 : 0);
