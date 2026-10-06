import { boot, helpers, reporter } from "./dom.mjs";

const { check, done } = reporter("worst-case fixtures (phase 4)");
const env = await boot(".smoke/out/break.js");
const { $, $$ } = helpers(env.document);
const caseOf = (id) => $(`[data-case="${id}"]`);

check("every fixture rendered", () => $$("[data-case]").length === 13 || `${$$("[data-case]").length} cases`);
check("no runtime errors across the fixtures", () => env.errors.length === 0 || env.errors.slice(0, 3).join(" | "));

for (const id of $$("[data-case]").map((node) => node.dataset.case)) {
  const scope = caseOf(id);
  check(`${id}: PDP structure intact`, () => !!scope.querySelector(".kv-sf-pdp-info") && !!scope.querySelector(".kv-sf-pdp-gallery"));
  /* Phase 4: a section renders only when its backing data exists, so the
     disclosure count follows the data (3–4) and no fold is ever empty. */
  check(`${id}: disclosures follow the data, none empty`, () => {
    const folds = scope.querySelectorAll(".kv-sf-fold");
    return (folds.length >= 3 && folds.length <= 4) &&
      Array.from(folds).every((fold) => (fold.textContent ?? "").trim().length > 0) || `${folds.length} folds`;
  });
  check(`${id}: purchase control present and labelled`, () => {
    const button = Array.from(scope.querySelectorAll(".kv-sf-buyrow button")).find((node) => /افزودن|به سبد/.test(node.textContent));
    return !!button && button.textContent.trim().length > 0;
  });
  check(`${id}: no undefined or NaN leaked into the page`, () =>
    !/undefined|NaN|\[object Object\]/.test(scope.textContent) || (scope.textContent.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/) ?? [""])[0]);
}

check("no-colours: says so instead of inventing swatches", () =>
  caseOf("no-colors").querySelector(".kv-sf-pdp-info").textContent.includes("بدون تنوع رنگ"));
check("no-sizes: still offers a purchase path", () => {
  const button = Array.from(caseOf("no-sizes").querySelectorAll(".kv-sf-buyrow button")).find((node) => /افزودن/.test(node.textContent));
  return !!button && button.disabled === false;
});
check("sold-out: the purchase control is disabled and the state is stated", () => {
  const scope = caseOf("sold-out");
  const button = Array.from(scope.querySelectorAll(".kv-sf-buyrow button")).find((node) => /افزودن/.test(node.textContent));
  return button.disabled === true && scope.textContent.includes("ناموجود");
});
check("one-image: no thumbnail rail is rendered", () => !caseOf("one-image").querySelector(".kv-sf-thumbs"));
check("one-image: the frame counter is hidden", () => !/از /.test(caseOf("one-image").querySelector(".kv-sf-pdp-gallery p:last-child").textContent));
check("no-badge: no flag is drawn", () => !caseOf("no-badge").querySelector(".kv-sf-gallery-main .kv-sf-cell-flag"));
check("sold-note: a real seller note reaches the details", () =>
  caseOf("sold-note").textContent.includes("تک‌نسخه موجود"));
check("no-badge product states no badge in the facts", () =>
  !caseOf("no-badge").textContent.includes("برچسب کالا"));
check("no-instalment: no instalment line is shown", () => !caseOf("no-instalment").textContent.includes("یا ۴ قسطِ"));
check("with-instalment: the instalment line is shown", () => caseOf("with-instalment").textContent.includes("یا ۴ قسطِ"));
check("zero-rating: the summary stays honest", () => {
  const scope = caseOf("zero-rating");
  return scope.textContent.includes("۰") && scope.textContent.includes("دیدگاه") && !/NaN/.test(scope.textContent);
});
check("no-shipping: the delivery disclosure is omitted, not stubbed", () => {
  const scope = caseOf("no-shipping");
  const titles = Array.from(scope.querySelectorAll(".kv-sf-fold-btn")).map((node) => node.textContent.trim());
  return (!titles.includes("ارسال") && !/پست پیشتاز|تیپاکس/.test(scope.textContent)) || titles.join(" | ");
});
check("shipping present: real carrier, window and threshold are shown", () => {
  const scope = caseOf("with-instalment");
  return scope.textContent.includes("پست پیشتاز") && scope.textContent.includes("۲ تا ۴ روز کاری") && scope.textContent.includes("رایگان برای خرید بالای");
});
check("no-catalogue: both rails disappear rather than showing filler", () => {
  const scope = caseOf("no-catalogue");
  return !scope.querySelector(".kv-sf-recs") && !scope.textContent.includes("این استایل را کامل کن");
});
check("no-tryon: the try-on control is absent, not disabled", () =>
  !Array.from(caseOf("no-tryon").querySelectorAll("button")).some((node) => node.textContent.includes("پرو مجازی")));
check("long-name: the title is rendered in full", () =>
  caseOf("long-name").querySelector(".kv-sf-pdp-info h1").textContent.length > 80);
check("cards render for every fixture", () => $$("[data-case] .kv-sf-cell").length === 13);
check("a fixture card never exposes a broken price", () =>
  $$("[data-case] .kv-sf-cell-price").every((node) => node.textContent.includes("تومان")));

process.exit(done() ? 1 : 0);
