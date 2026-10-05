/* Canonical product PUBLICATION (§1-§5, §18-§20 of the final Product Studio remediation).
 *
 * DOMAIN RULE
 * -----------
 *   - A WMS receipt (initial inventory / any physical movement) NEVER publishes a product.
 *     Inventory is a WMS concern; publication is an explicit Admin decision (§3).
 *   - Stock quantity is NOT a publication requirement: a published product may legitimately
 *     be «ناموجود» and must stay published (§19). Therefore `inventory_setup` and every
 *     balance are deliberately absent from this validator (§3).
 *   - Explicit publication runs the CANONICAL CATALOG validator below. When it fails, the
 *     API answers 422 with an actionable Persian issue list — never a silent no-op (§4/§20).
 *   - Only requirements the domain actually states are enforced here: identity, category,
 *     a sales channel, that channel's canonical price data, and (for wholesale) an orderable
 *     series. Nothing speculative is added, and media is NOT a server requirement (a product
 *     without a cover is still a valid catalogue row).
 *
 * The step codes map 1:1 onto the eight canonical Product Studio steps (§13) so the UI can
 * deep-link each missing requirement to the section that fixes it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, type DbClient, type DbPool } from './db.js';
import { ApiError, notFound } from './errors.js';

export type PublicationIssue = {
  /** Stable machine code — never shown to the Admin. */
  code: string;
  /** Persian, business-language label shown to the Admin. */
  label: string;
  /** Canonical Product Studio step that fixes the issue (§4: deep-link to the section). */
  step: 'base' | 'variant' | 'media' | 'cutout' | 'price' | 'specs' | 'seo' | 'review';
};

export type PublicationReadiness = {
  productId: string;
  status: string;
  publishable: boolean;
  issues: PublicationIssue[];
  /** Publication is a pure catalog decision — stock is never part of it (§3/§19). */
  stockIndependent: true;
};

type ProductRow = {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  status: string;
  retail_enabled: boolean;
  wholesale_enabled: boolean;
  cash_price_rial: string | null;
  installment_price_rial: string | null;
  wholesale_price_rial: string | null;
  installment_policy: string | null;
};

/**
 * §2/§4: the single canonical publication validator (server authority).
 * Every requirement is a CATALOG requirement — never a stock requirement.
 */
export async function publicationReadiness(
  db: DbPool | DbClient,
  productId: string,
): Promise<PublicationReadiness> {
  const product = await one<ProductRow>(db,
    `SELECT p.id, p.name, p.brand, p.category, p.status, p.retail_enabled, p.wholesale_enabled,
            p.cash_price_rial, p.installment_price_rial, p.wholesale_price_rial, p.installment_policy
       FROM products p WHERE p.id = $1`, [productId]);
  if (!product) throw notFound('محصول پیدا نشد.');

  const issues: PublicationIssue[] = [];
  const push = (code: string, label: string, step: PublicationIssue['step']) =>
    issues.push({ code, label, step });

  // ---- required basic product data (§4) ----
  if (!String(product.name ?? '').trim()) push('name', 'نام محصول', 'base');
  if (!String(product.category ?? '').trim()) push('category', 'دسته‌بندی محصول', 'base');

  // ---- required sale configuration (§4) ----
  const retail = product.retail_enabled === true;
  const wholesale = product.wholesale_enabled === true;
  if (!retail && !wholesale) push('channel', 'انتخاب دست‌کم یک کانال فروش (خرده یا عمده)', 'base');

  // ---- required pricing configuration (§4) ----
  if (retail) {
    if (!(Number(product.cash_price_rial ?? 0) > 0)) push('cash_price', 'قیمت نقدی پایهٔ فروش خرده', 'price');
    const installmentOff = product.installment_policy === 'disabled';
    if (!installmentOff && product.installment_price_rial !== null && !(Number(product.installment_price_rial) > 0)) {
      push('installment_price', 'قیمت پایهٔ خرید چهارقسطه', 'price');
    }
  }

  // ---- required sellable variant configuration (§4) ----
  if (retail) {
    const variants = await one<{ n: string }>(db,
      'SELECT count(*)::text AS n FROM product_variants WHERE product_id = $1 AND active', [productId]);
    if (!(Number(variants?.n ?? 0) > 0)) push('variants', 'دست‌کم یک واریانت فعال (رنگ × سایز)', 'variant');
  }

  // ---- required wholesale price data (§4) ----
  // Wholesale pricing IS canonical Series pricing (§6), and migration 070 keeps two canonical
  // sources: a priced active series (`series_total` / `component_sum`) or the legacy
  // product-level wholesale price (`legacy_product`). Either one makes the product orderable —
  // no new wholesale-pricing truth is introduced here.
  if (wholesale) {
    const wholesaleReady = Number(product.wholesale_price_rial ?? 0) > 0
      || Number((await one<{ n: string }>(db,
        `SELECT count(*)::text AS n FROM series_templates t
          WHERE t.product_id = $1 AND t.active
            AND COALESCE(t.min_order_series, 0) >= 1
            AND CASE t.pricing_mode
                  WHEN 'series_total' THEN COALESCE(t.total_price_rial, 0)
                  WHEN 'component_sum' THEN COALESCE((
                        SELECT sum(i.unit_price_rial) FROM series_template_items i
                         WHERE i.series_template_id = t.id), 0)
                  ELSE 0
                END > 0`, [productId]))?.n ?? 0) > 0;
    if (!wholesaleReady) push('series', 'قیمت عمده (قیمت سری یا قیمت پایهٔ عمده)', 'price');
  }

  return {
    productId,
    status: product.status,
    publishable: issues.length === 0,
    issues,
    stockIndependent: true,
  };
}

/** §4/§20: publication blocked — 422 with the exact, actionable Persian issue list. */
export function publicationBlocked(readiness: PublicationReadiness) {
  const message = 'برای انتشار محصول این موارد را تکمیل کنید:';
  const error = new ApiError(422, 'PUBLICATION_INCOMPLETE', message);
  Object.assign(error, { details: { issues: readiness.issues, labels: readiness.issues.map((i) => i.label) } });
  return error;
}

export function registerPublicationRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** §4: the Review & Publish step reads the SERVER's publication checklist, not a local guess. */
  app.get('/api/v1/admin/products/:id/publication-readiness', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return publicationReadiness(pool, id);
  });
}
