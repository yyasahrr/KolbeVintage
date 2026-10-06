import { JSDOM } from "jsdom";
import fs from "node:fs";
import { reporter } from "./dom.mjs";

const dom = new JSDOM(`<!doctype html><html dir="rtl"><body><div id="root"></div><pre id="out"></pre></body></html>`, {
  url: "https://kolbe.test/", runScripts: "outside-only",
});
dom.window.eval(fs.readFileSync(".smoke/out/units.js", "utf8"));
/* the probe writes its report from an effect, so let React flush first */
await new Promise((resolve) => setTimeout(resolve, 600));
const raw = dom.window.document.getElementById("out").textContent;
if (!raw) { console.error("probe produced no report"); process.exit(1); }
const data = JSON.parse(raw);
const { check, done } = reporter("unit checks (recommendations + media integrity)");
const per = data.perProduct;
const ids = Object.keys(per);

check(`catalogue has published retail products (${data.products})`, () => data.products === 8 || `got ${data.products}`);
check("recommendations are deterministic across calls", () => data.deterministic === true);
check("an unknown category degrades to empty rails", () => data.unknownCategory.alike === 0 || `alike=${data.unknownCategory.alike}`);
check("unpublished or non-retail products are never recommended", () => data.unpublishedLeak === false);

for (const id of ids) {
  const entry = per[id];
  check(`${id}: "complete the look" never includes itself`, () => !entry.looks.includes(id));
  check(`${id}: "complete the look" is at most 4 pieces`, () => entry.looks.length <= 4);
  check(`${id}: "complete the look" has no duplicates`, () => new Set(entry.looks).size === entry.looks.length);
  check(`${id}: complements come from other categories`, () => entry.lookCategories.every((c) => c !== entry.category) || entry.lookCategories.join(","));
  check(`${id}: "you may also like" never includes itself`, () => !entry.alike.includes(id));
  const sameCategory = ids.filter((other) => per[other].category === entry.category).length;
  check(`${id}: alternatives prefer the same category`, () =>
    entry.alike.length === 0 || entry.alikeCategories[0] === entry.category || sameCategory === 1
      || `${entry.category} → ${entry.alikeCategories[0]} (${sameCategory} in category)`);
  check(`${id}: the two rails are disjoint`, () => entry.looks.every((x) => !entry.alike.includes(x)));
  check(`${id}: every colour photograph belongs to this product`, () => entry.mediaLeaks.length === 0 || entry.mediaLeaks.join(","));
  check(`${id}: colour media keys are real colourways`, () => entry.colorMediaForeign.length === 0 || entry.colorMediaForeign.join(","));
  check(`${id}: a colour with media still shows a gallery`, () => entry.galleryFor > 0);
}
process.exit(done() ? 1 : 0);
