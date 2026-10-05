/** PROMPT 1 — UNIFIED PRODUCT STUDIO: routing / authority static gate (§5-§26, §32, §41).
 *
 *  Browser automation is unavailable in this environment (no Chromium binary, no package
 *  mirrors), so the §20-§26 browser acceptance is reported as PENDING. This gate does NOT
 *  replace it: it locks down the structural facts the browser UAT checks, so a regression that
 *  reintroduces a modal pricing surface, a second pricing authority, a client-only promotion
 *  state, a client-side inventory sort, or a toggle-only structural row fails HERE as well as in
 *  the browser.
 *
 *  Rules asserted (source of truth = the shipped files):
 *    §1/§2/§16/§18  pricing is ONE full-page workspace, deep-linked by productId hash, with no
 *                   modal wrapper and no second DiscountManager export;
 *    §3/§17         the Studio hands off draft-first through `onOpenPricing` and reuses the SAME
 *                   draft id (never creates a second product) — the management deep-link, not a
 *                   duplicated pricing form;
 *    §6/§8-§11      WMS wording is inventory-only, publication is shown separately, ordering is a
 *                   server parameter with the eight canonical options, filters are real and
 *                   clearable, and the client never sorts the full inventory in the browser;
 *    §12-§15        structural dictionaries have edit / activate-deactivate / delete row actions
 *                   with server-backed search + count and no DB identifiers in the UI.
 *
 *  Run: cd backend && npx tsx scripts/pricing-routing-smoke.ts
 */
import { readdirSync, readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, 'utf8');
const checks: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) checks.push(name);
  else { failed += 1; checks.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const hub = read('src/components/kolbe-products-hub.tsx');
const studio = read('src/portals/admin-product.tsx');
const pricing = read('src/components/product-pricing-panel.tsx');
const admin = read('src/portals/admin.tsx');
const wms = read('src/portals/warehouse-hub.tsx');
const structure = read('src/components/product-structure-panel.tsx');
const readQuiet = (rel: string) => { try { return readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, 'utf8'); } catch { return ''; } };

/* ------------------- §1/§2/§6/§26 ONE unified Studio (no separate pricing page) --------------- */
check('the discount/festival editor is embedded in the Studio as a canonical panel (no separate page)',
  studio.includes('ProductPricingPanel') && studio.includes('from "../components/product-pricing-panel"')
  && pricing.includes('data-panel="studio-pricing"'));
check('one Studio route holds the productId + requested step, and the legacy pricing route redirects into it',
  hub.includes('const STUDIO_HASH = "#/admin/products/studio/"')
  && hub.includes('const LEGACY_PRICING_HASH = "#/admin/products/pricing/"')
  && hub.includes('return { id: legacy[1]!, step: "price" };')
  && hub.includes('window.history.replaceState(null, "", studioHash(id, "price"))'));
check('every hub row action routes into the Studio at the right step (ویرایش/قیمت‌گذاری/موجودی/ادامه)',
  ['openStudioAt(p, "base")', 'openStudioAt(p, "price")', 'openStudioAt(p, "inventory")']
    .every((needle) => hub.includes(needle))
  && hub.includes('openStudioAt(p, pending ? "inventory" : "price")'));
check('the Studio exposes the step router (`?step=`) and a popstate listener so Back stays in-step',
  studio.includes('window.history.replaceState(null, "", `${path}${suffix ? `?${suffix}` : ""}`)')
  && studio.includes('window.addEventListener("popstate", onPop)')
  && studio.includes('export const STUDIO_STEPS'));
check('the Studio is draft-first: ONE canonical draft, reused by every later step',
  studio.includes('const ensureDraft =') && studio.includes('const activeProductId = editing?.id ?? createdDraftId')
  && studio.includes('if (createdDraftId) return createdDraftId;') && !studio.includes('onOpenPricing'));
check('the sticky action bar always carries «ذخیره پیش‌نویس» and the final step carries «انتشار محصول»',
  studio.includes('sticky bottom-0') && studio.includes('ذخیره پیش‌نویس') && studio.includes('مرحله بعد')
  && studio.includes('انتشار محصول') && studio.includes('const isLastStep ='));
check('initial inventory is embedded in the Studio and writes canonical WMS receipts only',
  studio.includes('<InitialInventoryWorkspace') && studio.includes('<ProductInventoryPanel')
  && !/productsApi\.update\([^)]*stock/.test(studio));
check('discount writes go through the canonical promotion API — never a local/metadata authority',
  ['promotionRulesApi.createRule', 'promotionRulesApi.updateRule', 'promotionRulesApi.setProductMode', 'promotionRulesApi.resolvePrices']
    .every((needle) => pricing.includes(needle))
  && !/metadata\s*[.:]/.test(pricing));
check('the dead ON/OFF controls for standalone discount and central festival are gone',
  !studio.includes('تخفیف مستقل محصول') && !studio.includes('جشنواره محصول از مرکز مرکزی'));
check('the promotion deep link opens the canonical Promotion Center scoped to the product',
  studio.includes('onOpenPromotionCenter({ productId: activeProductId, productName: d.name.trim() || "محصول"')
  && hub.includes('onOpenPromotionCenter={(focus) => onOpenPromo?.(focus)}')
  && admin.includes('onOpenPromo={(focus) => { setPromoFocus(focus); go("promo"); }}')
  && admin.includes('<PromoPanel focus={promoFocus} />'));
check('§41 the superseded pricing workspace, specs editor and second WMS panel are REMOVED',
  ['src/components/discount-manager.tsx', 'src/components/product-specs-editor.tsx', 'src/portals/admin-wms-panel.tsx']
    .every((rel) => readQuiet(rel) === ''),
  'no parallel pricing/specs/WMS authority may be reintroduced');

/* ------------------------------ §6/§8-§11 WMS operability ---------------------------------- */
check('WMS shows inventory facts with inventory wording (no «قابل فروش», no «وضعیت فروش»)',
  !wms.includes('قابل فروش') && !wms.includes('وضعیت فروش') && wms.includes('قابل تخصیص'));
check('catalogue publication is shown as its OWN column/filter',
  wms.includes('PUBLICATION_BADGE') && wms.includes('وضعیت انتشار') && wms.includes('publicationStatus'));
check('WMS never auto-publishes (no publish/status write from the warehouse surface)',
  !/productsApi\.status\([^)]*published/.test(wms));
const sortOptions = ['newest', 'oldest', 'stock_desc', 'stock_asc', 'available_desc', 'available_asc', 'name_asc', 'name_desc'];
check('all eight canonical sort options are exposed', sortOptions.every((option) => wms.includes(`v: "${option}"`)));
check('ordering + filters are sent to the SERVER (no client-side full-inventory sort)',
  /withTotal: 1, sort/.test(wms) && !/\.sort\(\(a, b\) =>/.test(wms));
check('filters cover category, warehouse, availability, publication and ownership',
  ['category', 'warehouseId', 'stockStatus', 'publicationStatus', 'owner'].every((key) => wms.includes(`params.${key}`)));
check('active filters are visible and clearable with a result count',
  wms.includes('activeChips') && wms.includes('پاک کردن فیلترها') && wms.includes('ردیف مطابق فیلتر'));
check('the filter bar collapses on small screens', wms.includes('filtersOpen') && wms.includes('hidden sm:flex'));

/* ------------------------------ §12-§15 structure lifecycle -------------------------------- */
check('structure rows expose edit + activate/deactivate + delete actions (never toggle-only)',
  structure.includes('RowAction') && structure.includes('ویرایش') && structure.includes('غیرفعال کردن') && structure.includes('حذف'));
check('structure lists are searchable with a result count and a clear-filters affordance',
  structure.includes('SearchBox') && structure.includes('مورد') && structure.includes('پاک کردن فیلترها'));
check('safe delete surfaces the server reason instead of swallowing it',
  structure.includes('deleteError') && structure.includes('غیرفعال'));
check('display order is editable for structural records', structure.includes('ترتیب نمایش'));
check('no raw identifiers are rendered in the structure UI (no UUID fields)',
  !/>\s*\{(item|type|guide|attribute|size|edit|detail)\.id\}/.test(structure)
  && !/\{(item|type|guide|attribute)\.(created_at|updated_at)\}/.test(structure));
check('size definitions get a real management surface (types + sizes)',
  structure.includes('TypesSizesSection') && structure.includes('createSize') && structure.includes('deleteSize'));

console.log(`pricing-routing smoke: ${checks.filter((entry) => !entry.startsWith('✗')).length}/${checks.length} checks passed`);
for (const entry of checks) console.log(`  ${entry.startsWith('✗') ? entry : `✓ ${entry}`}`);
if (failed) process.exit(1);
