import { createRoot } from "react-dom/client";
import { CmsSection } from "../src/components/cms-blocks";
import type { PageSection } from "../src/data/experience-api";

/**
 * Phase 3 harness: every registry variant of every section component rendered
 * side by side with fixed content, so the suite can assert REAL rendering
 * differences between options of the same component (structure, classes,
 * attrs), never just data-attribute echo.
 */

const PRODUCT = {
  id: "11111111-1111-4111-8111-111111111111", name: "پیراهن کرپ اسلیمی", brand: "کلبه", category: "shirt", productType: null,
  gender: "unisex", seasons: [], vibes: [], priceRial: "24500000", installmentPriceRial: null, perInstallmentRial: "6125000",
  compareAtRial: "29000000", discountPercent: 15, installmentEnabled: true, installmentProviders: ["snapppay"],
  image: null, flatLay: null, available: 7, isNew: true, createdAt: "2026-10-01T00:00:00Z", rating: 4.6, reviewCount: 12,
  variants: [{ id: "22222222-2222-4222-8222-222222222222", sku: "SH-M", size: "M", color: "شیری", available: 7 }],
};

const PROVIDERS = [
  { code: "snapppay", title: "اسنپ‌پی", integration_code: "snapppay", count: 4, installments_count: 4, min_order_rial: "1000000", max_order_rial: null, fee_percent: "0", badge_text: "۴ قسط", terms: "شرایط اسنپ‌پی", brand_color: "#00B14F", logo_url: null, position: 1, active: true },
  { code: "digipay", title: "دیجی‌پی", integration_code: "digipay", count: 6, installments_count: 6, min_order_rial: "2000000", max_order_rial: null, fee_percent: "0", badge_text: "۶ قسط", terms: "شرایط دیجی‌پی", brand_color: "#0D6EFD", logo_url: null, position: 2, active: true },
];

let seq = 0;
const section = (component_code: string, variant: string | undefined, payload: Record<string, unknown> = {}, resolved: Record<string, unknown> = {}): PageSection => ({
  id: `sec-${++seq}`, title: `بخش ${component_code}`, payload, visible: true, position: seq, component_code, component_type: "section",
  variant, section_theme: "inherit", style_overrides: {}, responsive_config: {}, resolved,
});

const REVIEWS = {
  reviews: [
    { id: "r1", rating: 5, title: "کیفت عالی", body: "پارچه بسیار خوش‌دوخت بود و پس از شست‌وشو رنگ آن تغییر نکرد.", display_name: "مریم ک.", product_name: "پیراهن کرپ اسلیمی", verified_purchase: true, photos: [] },
    { id: "r2", rating: 4, title: "خوب", body: "سایزبندی دقیق بود، ارسال هم سریع.", display_name: "سارا ن.", product_name: "پیراهن کرپ اسلیمی", verified_purchase: true, photos: [] },
  ],
  reviewSummary: { total: 12, average: 4.6, distribution: [{ rating: 5, n: 9 }, { rating: 4, n: 3 }] },
  customerPhotos: [],
};

const CASES: { key: string; el: React.ReactElement }[] = [];
const add = (component: string, variant: string | undefined, payload: Record<string, unknown> = {}, resolved: Record<string, unknown> = {}) => {
  const sec = section(component, variant, payload, resolved);
  CASES.push({
    key: `${component}:${variant ?? "unset"}`,
    el: (
      <div data-case={`${component}:${variant ?? "unset"}`}>
        <CmsSection section={sec} index={1} pageCode="variants" onNav={() => undefined} onOpenProduct={() => undefined} onQuickAdd={() => true} />
      </div>
    ),
  });
};

/* product_grid + carousel — density/card presets */
for (const v of ["default", "editorial", "compact", "luxury"]) add("product_grid", v, { title: "تازه‌رسیده‌ها" }, { products: [PRODUCT] });
for (const v of ["default", "editorial", "minimal"]) add("product_carousel", v, {}, { products: [PRODUCT] });
/* countdown presets */
for (const v of ["default", "banner", "minimal", "dark", "glass", "floating", "compact"]) add("countdown", v, { title: "جشنواره پاییزه", targetDate: new Date(Date.now() + 864e5).toISOString() });
/* category_card templates */
for (const v of ["default", "image", "editorial", "minimal", "glass", "overlay", "horizontal"]) add("category_card", v, { title: "دسته‌بندی‌ها" }, { categories: [{ id: "c1", slug: "shirt", name: "پیراهن", description: "دسته پیراهن", product_count: 8, cover_url: null, image_url: null, card_template: null, card_style: {} }] });
/* promotion_banner surfaces */
for (const v of ["default", "dark", "terra", "split"]) add("promotion_banner", v, { title: "تأمین عمده", cta: "شروع", image: "https://images.example/rack.jpg" });
/* installment provider presets */
for (const v of ["snapppay", "digipay", "generic"]) add("installment_card", v, { installmentsCount: 4 }, { providers: PROVIDERS });
/* brand_strip presentations */
for (const v of ["default", "minimal", "marquee"]) add("brand_strip", v, {});
/* review displays */
for (const v of ["default", "summary", "editorial"]) add("review_section", v, {}, REVIEWS);
/* recommendation treatments */
for (const v of ["default", "minimal", "dark"]) add("recommendation_section", v, { strategy: "popular" }, { products: [PRODUCT], recommendation: { strategy: "popular", personal: false, fallback: false } });
/* text_section presentations */
for (const v of ["default", "centered", "editorial"]) add("text_section", v, { title: "ویراستاری کلبه", text: "پارچه، دوخت و ماندگاری." });
/* lead_form layouts */
for (const v of ["default", "split", "compact"]) add("lead_form", v, { title: "باشگاه کلبه" });
/* story_hero frames */
for (const v of ["default", "split"]) add("story_hero", v, { title: "از پارچه تا پوشاک", image: "https://images.example/atelier.jpg" });
/* timeline shapes */
for (const v of ["default", "vertical"]) add("timeline", v, { milestones: "۱۳۹۸، آغاز\n۱۴۰۱، کارگاه" });
/* values_grid densities */
for (const v of ["default", "minimal"]) add("values_grid", v, { values: "اصالت، پارچه واقعی\nماندگاری، دوخت تمیز" });
/* stats_strip themes */
for (const v of ["default", "dark"]) add("stats_strip", v, { stats: "۱۲۰، محصول\n۴۸، شهر" });
/* spacer rhythm */
for (const v of ["sm", "md", "lg"]) add("spacer", v, {});
/* divider styles */
for (const v of ["line", "ornament", "dashed"]) add("divider", v, {});
/* hero trio templates from the section variant */
add("hero", "cinematic", { title: "کالکشن زمستان" });
add("image_hero", "minimal", { title: "آرشیو پارچه" });
add("video_hero", "split", { title: "پرده کلبه" });

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(<div data-variant-suite="">{CASES.map((c) => <div key={c.key}>{c.el}</div>)}</div>);
