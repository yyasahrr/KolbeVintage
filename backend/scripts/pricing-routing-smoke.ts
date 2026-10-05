/** PROMPT 1 — FINAL BROWSER UAT DELTA: routing / authority static gate (§1-§3, §6-§15, §20-§21).
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
const pricing = read('src/components/discount-manager.tsx');
const admin = read('src/portals/admin.tsx');
const wms = read('src/portals/warehouse-hub.tsx');
const structure = read('src/components/product-structure-panel.tsx');

/* ------------------------------ §1/§2/§16/§18 pricing is a full page ------------------------ */
check('pricing workspace is one full-page component and the modal export is gone',
  pricing.includes('export function ProductPricingWorkspace') && !/export function DiscountManager/.test(pricing));
check('pricing route is stable and holds the productId in the hash',
  hub.includes('const PRICING_HASH = "#/admin/products/pricing/"') && hub.includes('window.location.hash = `${PRICING_HASH}${row.id}`'));
check('a refresh/bookmark reopens the same product (deep-link parse exists)',
  /^#\/admin\/products\/pricing\//m.test(admin) || admin.includes('/^#\\/admin\\/products\\/pricing\\/([0-9a-f-]{36})/i'));
check('the hub renders the workspace as a page, not inside a modal',
  hub.includes('<ProductPricingWorkspace')
  && !/WorkspaceModal[\s\S]{0,400}?<ProductPricingWorkspace/.test(hub.replace(/\/\*[\s\S]*?\*\//g, '')));
check('every hub pricing entry passes the SAME productId', hub.includes('openPricing(row') && count(hub, 'openPricing(') >= 2);
check('pricing deep-links into the canonical promotion center instead of owning promotions',
  hub.includes('onOpenPromotionCenter={') && /onOpenPromo\?\.\(\{ productId: screen\.row\.id/.test(hub)
  && pricing.includes('onOpenPromotionCenter?: (anchor?:') && pricing.includes('onOpenPromotionCenter("discount")'));
check('admin routes the promotion deep-link to the canonical tab with the product context',
  admin.includes('onOpenPromo={(focus) => { setPromoFocus(focus); go("promo"); }}') && admin.includes('<PromoPanel focus={promoFocus} />'));
check('pricing header exposes the product facts the PO asked for',
  pricing.includes('data-workspace="product-pricing"') && pricing.includes('sku') && pricing.includes('بازگشت'));

/* ------------------------------ §3/§17 draft-first handoff --------------------------------- */
check('Studio reaches pricing through a handoff prop (not a local pricing authority)',
  studio.includes('onOpenPricing?:') && studio.includes('const handoff ='));
check('handoff reuses the current/created draft instead of creating a second product',
  studio.includes('editing?.id ?? createdDraftId') && studio.includes('createdDraftId'));
check('handoff names the exact missing draft fields in Persian',
  studio.includes('handoffMissing') && studio.includes('ابتدا این موارد را وارد کنید')
  && studio.includes('ذخیره پیش‌نویس و رفتن به ${noun}'));
check('Studio no longer mounts the pricing modal and points at the full management page',
  !studio.includes('DiscountManager') && studio.includes('مدیریت کامل قیمت‌گذاری')
  && !/<DiscountManager/.test(studio));

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

/* ------------------------ §5 (continuation): no silent dead code / parallel authority -------- */
/* Two modules are superseded and currently have ZERO importers. They are retained (removal is an
   open PO decision) but must never be reconnected silently: this check makes reconnection a
   deliberate, reviewed act, and the file headers state the canonical replacements. */
{
  const readQuiet = (rel: string) => { try { return readFileSync(new URL(`../../${rel}`, import.meta.url).pathname, 'utf8'); } catch { return ''; } };
  const deprecations = [
    { rel: 'src/components/product-specs-editor.tsx', name: 'ProductSpecsEditor', reason: 'legacy superseded specs/size-guide editor (parallel authority)' },
    { rel: 'src/portals/admin-wms-panel.tsx', name: 'AdminWmsPanel', reason: 'superseded second WMS surface' },
  ];
  const sources = ['src/App.tsx', 'src/main.tsx', ...['src/components', 'src/portals', 'src/data', 'src/utils'].flatMap((dir) => {
    try {
      return readdirSync(new URL(`../../${dir}`, import.meta.url).pathname)
        .filter((name) => /\.tsx?$/.test(name)).map((name) => `${dir}/${name}`);
    } catch { return []; }
  })];
  for (const entry of deprecations) {
    const self = readQuiet(entry.rel);
    check(`deprecated ${entry.name} is documented and not imported by any module`,
      self.includes('DEPRECATED') && self.includes('no importers')
      && sources.filter((rel) => rel !== entry.rel).every((rel) => !readQuiet(rel).includes(entry.name)),
      entry.reason);
  }
}

console.log(`pricing-routing smoke: ${checks.filter((entry) => !entry.startsWith('✗')).length}/${checks.length} checks passed`);
for (const entry of checks) console.log(`  ${entry.startsWith('✗') ? entry : `✓ ${entry}`}`);
if (failed) process.exit(1);
