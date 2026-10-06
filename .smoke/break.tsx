import { createRoot } from "react-dom/client";
import ProductDetail from "../src/components/storefront/ProductDetail";
import StorefrontProductCard from "../src/components/storefront/StorefrontProductCard";
import { COLORS, IMG, type Product } from "../src/data/catalog";

/**
 * Worst-case pass: the same components the storefront ships, fed hostile but
 * legal data. Nothing here is asserted visually — only that the component
 * renders, keeps its semantics and never invents a fact.
 */
const base: Product = {
  id: "x1", sku: "XX-TST-001", brand: "Kolbe", name: "کت آزمایشی", supplier: "کلبه وینتیج",
  supplierId: "kolbe", category: "کت و بلیزر", retailPrice: 5000000, wholesaleFrom: 4000000,
  rating: 4.5, reviews: 10, colors: [COLORS.black, COLORS.cream], images: [IMG.blazerDuo, IMG.blackSuit],
  series: [], seriesCount: 0, moq: 1, stock: 4, fabric: "پشم", desc: "توضیح آزمایشی",
  status: "published", colorMedia: {}, cutout: { status: "none" },
} as unknown as Product;

const cases: { id: string; product: Product; props?: Partial<React.ComponentProps<typeof ProductDetail>> }[] = [
  { id: "no-colors", product: { ...base, id: "c1", colors: [] } },
  { id: "no-sizes", product: { ...base, id: "c2", series: [] } },
  { id: "sold-out", product: { ...base, id: "c3", stock: 0 } },
  { id: "one-image", product: { ...base, id: "c4", images: [IMG.blazerDuo] } },
  { id: "no-badge", product: { ...base, id: "c5", badge: undefined } },
  { id: "long-name", product: { ...base, id: "c6", name: "کت و شلوار کلاسیک دوخت کارگاه با پارچه وارداتی و آستر کامل و دکمه شاخ طبیعی نسخه محدود پاییز" } },
  { id: "no-instalment", product: { ...base, id: "c7", installmentPrice: undefined } },
  { id: "with-instalment", product: { ...base, id: "c8", installmentPrice: 5200000 } },
  { id: "zero-rating", product: { ...base, id: "c9", rating: 0, reviews: 0 } },
  { id: "sold-note", product: { ...base, id: "c10", soldNote: "تک‌نسخه موجود" } },
  { id: "no-shipping", product: { ...base, id: "c11" }, props: { shipping: [] } },
  { id: "no-catalogue", product: { ...base, id: "c12" }, props: { catalogue: [] } },
  { id: "no-tryon", product: { ...base, id: "c13" }, props: { onTryOn: undefined } },
];

const shipped = [{ id: "post", name: "پست پیشتاز", carrier: "پست", scope: "خرده", price: 180000, freeAbove: 5000000, eta: "۲ تا ۴ روز کاری", zones: "سراسر کشور", active: true }] as never;

function Case({ id, product, props }: { id: string; product: Product; props?: Partial<React.ComponentProps<typeof ProductDetail>> }) {
  return (
    <section data-case={id}>
      <ProductDetail
        p={product} wished={false} onWish={() => {}} onAdd={() => true} onBack={() => {}}
        shipping={shipped}
        {...(props ?? {})}
      />
      <StorefrontProductCard p={product} wished={false} onWish={() => {}} onOpen={() => {}} onAdd={() => true} />
    </section>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <div className="kv-storefront">
    {cases.map((entry) => <Case key={entry.id} {...entry} />)}
  </div>,
);
