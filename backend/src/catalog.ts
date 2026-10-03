import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { principal, requirePermission } from './auth.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';
import { validateSpecifications, type SpecField } from './profile.js';
import { validateCategoryRequirements } from './product-lifecycle.js';
import { assertSupplierMay, supplierCapViolation } from './supplier360.js';
import { resolveVariantPrice } from './promotions.js';

const installmentPolicy = z.enum(['disabled', 'enabled', 'disabled_when_discounted', 'enabled_when_discounted']);
const variantInput = z.object({
  size: z.string().max(50).optional(),
  color: z.string().max(100).optional(),
  weightGrams: z.number().int().min(0).max(1000000).nullable().optional(),
  // Req 25: optional per-variant retail price override (integer rial).
  priceOverrideRial: z.string().regex(/^\d{1,15}$/).nullable().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
});
const saleTermsSchema = z.object({
  moq: z.number().int().min(1).max(10000).default(1),
  packSize: z.number().int().min(1).max(1000).default(1),
  leadTimeDays: z.number().int().min(1).max(90).default(3),
  returnableWithinDays: z.number().int().min(0).max(30).default(7),
  fulfillmentPolicy: z.literal('kolbe_central_qc').default('kolbe_central_qc'),
}).default({
  moq: 1,
  packSize: 1,
  leadTimeDays: 3,
  returnableWithinDays: 7,
  fulfillmentPolicy: 'kolbe_central_qc',
});
const productBody = z.object({
  brand: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(240),
  category: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(''),
  cashPriceRial: z.string().regex(/^\d+$/),
  installmentPriceRial: z.string().regex(/^\d+$/).optional(),
  wholesalePriceRial: z.string().regex(/^\d+$/).optional(),
  variants: z.array(variantInput).min(1).max(100),
  metadata: z.record(z.string(), z.unknown()).default({}),
  productTypeCode: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(),
  specifications: z.record(z.string(), z.unknown()).default({}),
  gender: z.enum(['men', 'women', 'unisex', 'kids']).default('unisex'),
  vibes: z.array(z.string().regex(/^[a-z0-9-]{2,40}$/)).max(8).default([]),
  installmentEnabled: z.boolean().default(true),
  discountPercent: z.number().int().min(0).max(95).default(0),
  productTypeId: z.uuid().nullable().optional(),
  retailEnabled: z.boolean().optional(),
  wholesaleEnabled: z.boolean().optional(),
  installmentPolicy: installmentPolicy.optional(),
  wholesaleMoq: z.number().int().min(0).max(1000000).nullable().optional(),
  genderCode: z.string().trim().max(40).nullable().optional(),
  seasons: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  allowInstallments: z.boolean().optional(),
  disableInstallmentsOnDiscount: z.boolean().optional(),
  saleTerms: saleTermsSchema.optional(),
});

async function resolveTypeSpecs(db: DbPool | import('pg').PoolClient, code: string | undefined, specs: Record<string, unknown>, sizes: (string | undefined)[]) {
  if (!code) return { specifications: specs && Object.keys(specs).length ? specs : {} };
  const type = await one<{ spec_template: SpecField[]; sizes: { code: string; active: boolean }[] }>(db,
    'SELECT spec_template, sizes FROM product_types WHERE code = $1 AND active', [code]);
  if (!type) throw badRequest('نوع محصول انتخاب‌شده معتبر یا فعال نیست.');
  const allowed = new Set(type.sizes.filter((size) => size.active).map((size) => size.code));
  const invalid = sizes.filter((size): size is string => Boolean(size) && allowed.size > 0 && !allowed.has(size!));
  if (invalid.length) throw badRequest(`سایز «${invalid[0]}» برای این نوع محصول تعریف نشده است.`);
  return { specifications: validateSpecifications(type.spec_template, specs) };
}
const statusBody = z.object({ status: z.enum(['published', 'rejected', 'draft', 'archived']) });

export const skuCategoryCode = (category: string) => /کفش|کتانی|بوت/.test(category) ? 'SHOE' : /شلوار|جین/.test(category) ? 'PANT'
  : /اکسسوری|کیف|شال|کمربند/.test(category) ? 'ACCS' : /کت|بلیزر/.test(category) ? 'COAT' : 'ITEM';
const categoryCode = skuCategoryCode;

type ProductListRow = {
  id: string; brand: string; name: string; category: string; description: string;
  cash_price_rial: string; installment_price_rial: string | null; wholesale_price_rial: string | null;
  owner_type: string; retail_enabled: boolean; wholesale_enabled: boolean;
  product_type_id: string | null; installment_policy: string; wholesale_moq: number | null;
  gender_code: string | null; metadata: unknown; created_at: string;
  product_type_code: string | null; gender: string; vibes: string[]; specifications: unknown;
  installment_enabled: boolean; discount_percent: number; supplier_id: string | null;
  allow_installments: boolean; disable_installments_on_discount: boolean; sale_terms: Record<string, unknown>;
  variants: { id: string; sku: string; size: string | null; color: string | null; weightGrams: number | null;
    attributes?: Record<string, unknown>;
    available?: number; reserved?: number; incoming?: number; damaged?: number;
    retailAvailableStock?: number }[];
  seasons: string[];
};

async function assertTaxonomy(client: DbPool, kind: 'gender' | 'season', code: string) {
  const row = await one<{ code: string }>(client,
    'SELECT code FROM product_taxonomies WHERE kind = $1 AND code = $2 AND active = true', [kind, code]);
  if (!row) throw badRequest(kind === 'gender' ? `جنسیت «${code}» معتبر نیست.` : `فصل «${code}» معتبر نیست.`);
}

async function assertTypeSizes(client: DbPool, productTypeId: string, sizes: (string | undefined)[]) {
  const type = await one<{ id: string; active: boolean }>(client, 'SELECT id, active FROM product_types WHERE id = $1', [productTypeId]);
  if (!type || !type.active) throw badRequest('نوع محصول انتخاب‌شده فعال نیست.');
  const rows = await client.query('SELECT code FROM product_type_sizes WHERE product_type_id = $1 AND active = true', [productTypeId]);
  const allowed = new Set(rows.rows.map((row: { code: string }) => row.code));
  for (const size of sizes) {
    if (size !== undefined && size !== null && size !== '' && !allowed.has(size))
      throw badRequest(`سایز «${size}» در نوع محصول انتخاب‌شده تعریف نشده است.`);
  }
}

export function registerCatalogRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/products', async (request) => {
    const query = z.object({
      category: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
      before: z.iso.datetime().optional(),
      channel: z.enum(['retail', 'wholesale', 'all']).default('retail'),
      productTypeId: z.uuid().optional(),
      gender: z.string().max(40).optional(),
      season: z.string().max(40).optional(),
    }).parse(request.query);

    const result = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.description, p.cash_price_rial,
              p.installment_price_rial, p.wholesale_price_rial, p.owner_type, p.retail_enabled, p.wholesale_enabled,
              p.product_type_id, p.installment_policy, p.wholesale_moq, p.gender_code, p.gender,
              p.seasons, p.vibes, p.specifications, p.installment_enabled, p.discount_percent, p.supplier_id,
              p.allow_installments, p.disable_installments_on_discount, p.sale_terms,
              p.metadata, p.created_at, p.status, p.inventory_setup,
              COALESCE(jsonb_agg(jsonb_build_object(
                'id', v.id,
                'sku', v.sku,
                'size', v.size_label,
                'color', v.color_label,
                'weightGrams', v.weight_grams,
                'priceOverrideRial', v.price_override_rial::text,
                'attributes', v.attributes,
                'available', COALESCE(b.available, 0),
                'reserved', COALESCE(b.reserved, 0),
                'incoming', COALESCE(b.incoming, 0),
                'damaged', COALESCE(b.damaged, 0),
                'retailAvailableStock', COALESCE(b.retail_available, 0)
              ) ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
       LEFT JOIN (
         SELECT sb.variant_id,
                SUM(sb.on_hand - sb.reserved - sb.damaged)::int AS available,
                SUM(sb.reserved)::int AS reserved,
                SUM(sb.incoming)::int AS incoming,
                SUM(sb.damaged)::int AS damaged,
                GREATEST(0, SUM(CASE WHEN sb.inventory_domain = 'retail' AND w.owner_id IS NULL THEN (sb.on_hand - sb.reserved - sb.damaged) ELSE 0 END))::int AS retail_available
         FROM stock_balances sb JOIN warehouses w ON w.id = sb.warehouse_id AND w.active
         GROUP BY sb.variant_id
       ) b ON b.variant_id = v.id
       WHERE p.status = 'published' AND ($1::text IS NULL OR p.category = $1)
         AND ($2::timestamptz IS NULL OR p.created_at < $2)
         AND ($3::text = 'all' OR ($3 = 'retail' AND p.owner_type = 'kolbe' AND p.retail_enabled)
              OR ($3 = 'wholesale' AND p.wholesale_enabled))
         AND ($4::uuid IS NULL OR p.product_type_id = $4)
         AND ($5::text IS NULL OR p.gender_code = $5)
         AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM product_seasons ps WHERE ps.product_id = p.id AND ps.season_code = $6))
       GROUP BY p.id ORDER BY p.created_at DESC, p.id DESC LIMIT $7 OFFSET $8`,
      [query.category ?? null, query.before ?? null, query.channel, query.productTypeId ?? null,
        query.gender ?? null, query.season ?? null, query.limit, query.offset]);

    const items = [];
    for (const row of result.rows as ProductListRow[]) {
      const enrichedVariants = [];
      let totalRetailAvailable = 0;
      for (const v of row.variants) {
        const resolved = await resolveVariantPrice(pool, v.id, { orderType: 'retail', paymentMode: 'cash' });
        const stock = Number(v.retailAvailableStock ?? 0);
        totalRetailAvailable += stock;
        enrichedVariants.push({
          ...v,
          retailAvailableStock: stock,
          basePriceRial: resolved.basePrice,
          discountRial: resolved.discountAmount,
          finalPriceRial: resolved.finalPrice,
          discountType: resolved.discountType,
          discountValue: resolved.discountValue,
          matchedRule: resolved.matchedRule,
        });
      }
      const sum = (key: 'available' | 'reserved' | 'incoming' | 'damaged') =>
        row.variants.reduce((total, variant) => total + Number(variant[key] ?? 0), 0);

      items.push({
        id: row.id,
        brand: row.brand,
        name: row.name,
        category: row.category,
        description: row.description,
        cashPriceRial: asRial(row.cash_price_rial),
        installmentPriceRial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
        wholesalePriceRial: row.wholesale_price_rial === null ? null : asRial(row.wholesale_price_rial),
        ownerType: row.owner_type,
        retailEnabled: row.retail_enabled,
        wholesaleEnabled: row.wholesale_enabled,
        productTypeId: row.product_type_id,
        installmentPolicy: row.installment_policy,
        wholesaleMoq: row.wholesale_moq,
        genderCode: row.gender_code,
        allowInstallments: row.allow_installments,
        disableInstallmentsOnDiscount: row.disable_installments_on_discount,
        saleTerms: row.sale_terms,
        // §16: 'pending' renders as «—» (profile not configured) — distinct from a real 0.
        inventorySetup: (row as unknown as { inventory_setup?: string }).inventory_setup ?? 'configured',
        productStatus: (row as unknown as { status?: string }).status,
        retailAvailableStock: totalRetailAvailable,
        metadata: row.metadata,
        variants: enrichedVariants,
        createdAt: row.created_at,
        productTypeCode: row.product_type_code,
        gender: row.gender,
        seasons: row.seasons,
        vibes: row.vibes,
        specifications: row.specifications,
        installmentEnabled: row.installment_enabled,
        discountPercent: row.discount_percent,
        supplierId: row.supplier_id,
        available: sum('available'),
        reserved: sum('reserved'),
        incoming: sum('incoming'),
        damaged: sum('damaged'),
      });
    }
    return { items };
  });

  /** Per-variant WMS inventory for one product — drives the ProductStudio inventory view. */
  app.get('/api/v1/admin/products/:id/inventory', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'inventory:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<{ id: string; name: string }>(pool, 'SELECT id, name FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    const rows = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.color_label AS color, v.size_label AS size, v.weight_grams,
              w.id AS warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              b.inventory_domain,
              COALESCE(b.on_hand, 0)::int AS on_hand, COALESCE(b.reserved, 0)::int AS reserved,
              COALESCE(b.incoming, 0)::int AS incoming, COALESCE(b.damaged, 0)::int AS damaged,
              COALESCE(b.on_hand - b.reserved - b.damaged, 0)::int AS available
       FROM product_variants v
       LEFT JOIN stock_balances b ON b.variant_id = v.id
       LEFT JOIN warehouses w ON w.id = b.warehouse_id
       WHERE v.product_id = $1 AND v.active
       ORDER BY v.sku, w.code`, [id]);
    const variants = await pool.query(
      `SELECT v.id AS variant_id, v.sku, v.color_label AS color, v.size_label AS size, v.weight_grams,
              COALESCE(SUM(b.on_hand), 0)::int AS on_hand, COALESCE(SUM(b.reserved), 0)::int AS reserved,
              COALESCE(SUM(b.incoming), 0)::int AS incoming, COALESCE(SUM(b.damaged), 0)::int AS damaged,
              COALESCE(SUM(b.on_hand - b.reserved - b.damaged), 0)::int AS available
       FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.product_id = $1 AND v.active GROUP BY v.id ORDER BY v.sku`, [id]);
    const totals = { available: 0, reserved: 0, incoming: 0, damaged: 0 };
    for (const row of rows.rows) {
      totals.available += Number(row.available); totals.reserved += Number(row.reserved);
      totals.incoming += Number(row.incoming); totals.damaged += Number(row.damaged);
    }
    return { productId: product.id, productName: product.name, variants: variants.rows, items: rows.rows, totals };
  });

  app.get('/api/v1/search', async (request) => {
    const query=z.object({
      q:z.string().trim().max(200).optional(),category:z.string().max(120).optional(),brand:z.string().max(120).optional(),gender:z.string().max(80).optional(),
      season:z.string().max(80).optional(),seasons:z.string().max(400).optional(),vibe:z.string().max(100).optional(),color:z.string().max(100).optional(),size:z.string().max(50).optional(),
      minPriceRial:z.string().regex(/^\d+$/).optional(),maxPriceRial:z.string().regex(/^\d+$/).optional(),available:z.coerce.boolean().optional(),installment:z.coerce.boolean().optional(),
      discountOnly:z.coerce.boolean().optional(),minRating:z.coerce.number().min(0).max(5).optional(),attributes:z.string().max(4000).optional(),
      sort:z.enum(['relevance','newest','price_low','price_high','popular']).default('relevance'),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(request.query);
    let attrs:Record<string,string>={};try{if(query.attributes)attrs=z.record(z.string(),z.string()).parse(JSON.parse(query.attributes));}catch{throw badRequest('ویژگی‌های جست‌وجو معتبر نیستند.');}
    const q=query.q?.normalize('NFKC').replace(/[\u0000-\u001f]/g,' ').trim()||null;
    const synonym=q?await pool.query<{replacement:string}>('SELECT replacement FROM search_synonyms WHERE phrase=$1 AND active',[q.toLowerCase()]):{rows:[] as {replacement:string}[]};
    const synonymText=synonym.rows[0]?.replacement??null;
    const sortSql={relevance:'score DESC, created_at DESC',newest:'created_at DESC',price_low:'cash_price_rial ASC, created_at DESC',price_high:'cash_price_rial DESC, created_at DESC',popular:'purchase_count DESC, score DESC'}[query.sort];
    const filterSql=`p.status='published' AND p.owner_type='kolbe' AND p.retail_enabled
      AND ($2::text IS NULL OR p.category=$2) AND ($3::text IS NULL OR p.brand=$3)
      AND ($4::text IS NULL OR p.gender=$4 OR p.gender_code=$4)
      AND ($5::text IS NULL OR $5=ANY(p.seasons))
      AND ($6::text IS NULL OR $6=ANY(p.vibes))
      AND ($17::text IS NULL OR p.seasons && string_to_array($17, ','))
      AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active AND v.color_label=$7))
      AND ($8::text IS NULL OR EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active AND v.size_label=$8))
      AND ($9::numeric IS NULL OR p.cash_price_rial >= $9::numeric) AND ($10::numeric IS NULL OR p.cash_price_rial <= $10::numeric)
      AND ($11::boolean IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM product_variants v JOIN stock_balances sb ON sb.variant_id=v.id WHERE v.product_id=p.id AND v.active AND sb.on_hand-sb.reserved-sb.damaged>0))
      AND ($12::boolean IS DISTINCT FROM true OR p.installment_price_rial IS NOT NULL)
      AND ($13::boolean IS DISTINCT FROM true OR COALESCE((p.metadata->>'discountPercent')::numeric,0)>0)
      AND ($14::numeric IS NULL OR COALESCE((p.metadata->>'rating')::numeric,0)>=$14)
      AND (COALESCE(p.metadata->'attributes','{}'::jsonb) @> $15::jsonb)
      AND ($1::text IS NULL OR to_tsvector('simple',concat_ws(' ',p.name,p.brand,p.category,p.description,p.metadata::text)) @@ plainto_tsquery('simple',$1)
         OR p.name ILIKE '%'||$1||'%' OR p.brand ILIKE '%'||$1||'%' OR EXISTS(SELECT 1 FROM product_variants sv WHERE sv.product_id=p.id AND sv.active AND sv.sku ILIKE '%'||$1||'%') OR ($16::text IS NOT NULL AND (to_tsvector('simple',concat_ws(' ',p.name,p.brand,p.category,p.description,p.metadata::text)) @@ plainto_tsquery('simple',$16) OR p.name ILIKE '%'||$16||'%' OR p.brand ILIKE '%'||$16||'%')))`;
    const params=[q,query.category??null,query.brand??null,query.gender??null,query.season??null,query.vibe??null,query.color??null,query.size??null,query.minPriceRial??null,query.maxPriceRial??null,query.available??null,query.installment??null,query.discountOnly??null,query.minRating??null,JSON.stringify(attrs),synonymText,query.seasons??null];
    const count=await pool.query(`SELECT count(*)::int AS total FROM products p WHERE ${filterSql}`,params);
    const rows=await pool.query(`WITH matches AS (SELECT p.id,p.brand,p.name,p.category,p.description,p.cash_price_rial,p.installment_price_rial,p.metadata,p.created_at,
      COALESCE((SELECT sum(sb.on_hand-sb.reserved-sb.damaged) FROM product_variants iv JOIN stock_balances sb ON sb.variant_id=iv.id WHERE iv.product_id=p.id AND iv.active),0)::int AS available_stock,
      (SELECT count(*)::int FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ol.product_id=p.id AND o.status IN ('paid','processing','preparing','ready_to_ship','in_transit','shipped','delivered')) AS purchase_count,
      CASE WHEN $1::text IS NULL THEN 0::real ELSE ts_rank_cd(to_tsvector('simple',concat_ws(' ',p.name,p.brand,p.category,p.description,p.metadata::text)),plainto_tsquery('simple',$1))
        + CASE WHEN lower(p.name)=lower($1) THEN 10 ELSE 0 END + CASE WHEN lower(p.name) LIKE lower($1)||'%' THEN 3 ELSE 0 END END AS score
      FROM products p WHERE ${filterSql})
      SELECT m.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'sku',v.sku,'size',v.size_label,'color',v.color_label,'attributes',v.attributes) ORDER BY v.sku) FROM product_variants v WHERE v.product_id=m.id AND v.active),'[]'::jsonb) AS variants
      FROM matches m ORDER BY ${sortSql} LIMIT $18 OFFSET $19`,[...params,query.limit,query.offset]);
    const facets=await pool.query(`SELECT
      (SELECT COALESCE(jsonb_object_agg(category,n),'{}'::jsonb) FROM (SELECT category,count(*)::int n FROM products WHERE status='published' GROUP BY category) c) AS categories,
      (SELECT COALESCE(jsonb_object_agg(brand,n),'{}'::jsonb) FROM (SELECT brand,count(*)::int n FROM products WHERE status='published' GROUP BY brand) b) AS brands,
      (SELECT COALESCE(jsonb_object_agg(value,n),'{}'::jsonb) FROM (SELECT v.color_label value,count(DISTINCT p.id)::int n FROM products p JOIN product_variants v ON v.product_id=p.id WHERE p.status='published' AND v.active AND v.color_label IS NOT NULL GROUP BY v.color_label) c) AS colors,
      (SELECT COALESCE(jsonb_object_agg(value,n),'{}'::jsonb) FROM (SELECT v.size_label value,count(DISTINCT p.id)::int n FROM products p JOIN product_variants v ON v.product_id=p.id WHERE p.status='published' AND v.active AND v.size_label IS NOT NULL GROUP BY v.size_label) s) AS sizes,
      (SELECT COALESCE(jsonb_object_agg(key,value_count),'{}'::jsonb) FROM (SELECT key,count(DISTINCT p.id)::int value_count FROM products p CROSS JOIN LATERAL jsonb_each(p.metadata->'attributes') a(key,val) WHERE p.status='published' GROUP BY key) a) AS attributes`);
    return {items:rows.rows.map((r)=>({id:r.id,brand:r.brand,name:r.name,category:r.category,description:r.description,cashPriceRial:asRial(r.cash_price_rial),installmentPriceRial:r.installment_price_rial===null?null:asRial(r.installment_price_rial),availableStock:r.available_stock,metadata:r.metadata,variants:r.variants,createdAt:r.created_at,popularity:r.purchase_count,score:r.score})),total:count.rows[0]?.total??0,offset:query.offset,limit:query.limit,facets:facets.rows[0]};
  });

  // Wholesale Catalog: Strictly sanitized DTO — NO supplier_id, phone, IBAN, warehouse address, or internal notes exposed to VIP buyers
  app.get('/api/v1/wholesale/products', async (request) => {
    const user = await principal(request, pool, config);
    const membership = await one<{ limits: Record<string, unknown> }>(
      pool,
      `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
       LIMIT 1`,
      [user.id],
    );
    if (!membership) throw forbidden();
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      productTypeId: z.uuid().optional(),
      gender: z.string().max(40).optional(),
      season: z.string().max(40).optional(),
    }).parse(request.query);
    const kolbeOnly = membership.limits.sources === 'kolbe';

    const rows = await pool.query<{
      id: string;
      name: string;
      brand: string;
      brand_display_name: string;
      category: string;
      description: string;
      wholesale_price_rial: string;
      owner_type: string;
      product_type_id: string | null;
      installment_policy: string;
      wholesale_moq: number | null;
      gender_code: string | null;
      sale_terms: Record<string, unknown>;
      allow_installments: boolean;
      disable_installments_on_discount: boolean;
      variant_id: string;
      sku: string;
      size_label: string | null;
      color_label: string | null;
      weight_grams: number | null;
      attributes: Record<string, unknown>;
      wholesale_available_stock: number;
      seasons: string[];
    }>(
      `SELECT p.id, p.name, p.brand,
              COALESCE(NULLIF(sp.brand_name, ''), p.brand) AS brand_display_name,
              p.category, p.description, p.wholesale_price_rial,
              p.owner_type, p.product_type_id, p.installment_policy, p.wholesale_moq, p.gender_code,
              p.sale_terms, p.allow_installments, p.disable_installments_on_discount,
              v.id AS variant_id, v.sku, v.size_label, v.color_label, v.weight_grams, v.attributes,
              COALESCE((
                SELECT GREATEST(0, SUM(sb.on_hand - sb.reserved - sb.damaged))::int
                FROM stock_balances sb
                JOIN warehouses w ON w.id = sb.warehouse_id
                WHERE sb.variant_id = v.id
                  AND sb.inventory_domain = 'wholesale'
                  AND w.active = true
              ), 0) AS wholesale_available_stock,
              COALESCE((SELECT jsonb_agg(ps.season_code) FROM product_seasons ps WHERE ps.product_id = p.id), '[]'::jsonb) AS seasons
       FROM products p
       LEFT JOIN supplier_profiles sp ON sp.user_id = p.supplier_id
       JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published'
         AND p.wholesale_enabled = true
         AND p.wholesale_price_rial > 0
         AND (NOT $1::boolean OR p.supplier_id IS NULL)
         AND ($3::uuid IS NULL OR p.product_type_id = $3)
         AND ($4::text IS NULL OR p.gender_code = $4)
         AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM product_seasons ps WHERE ps.product_id = p.id AND ps.season_code = $5))
       ORDER BY p.created_at DESC, v.sku LIMIT $2`,
      [kolbeOnly, query.limit, query.productTypeId ?? null, query.gender ?? null, query.season ?? null],
    );

    const items = [];
    for (const row of rows.rows) {
      const resolved = await resolveVariantPrice(pool, row.variant_id, {
        orderType: 'wholesale',
        paymentMode: 'cash',
      });
      const terms = {
        moq: row.wholesale_moq ?? 1,
        packSize: 1,
        leadTimeDays: 3,
        returnableWithinDays: 7,
        fulfillmentPolicy: 'kolbe_central_qc',
        fulfillmentChannel: 'kolbe_warehouse',
        inspectionBy: 'kolbe_qc',
        ...(row.sale_terms ?? {}),
      };
      items.push({
        id: row.id,
        name: row.name,
        brand: row.brand,
        brandDisplayName: row.brand_display_name,
        category: row.category,
        description: row.description,
        owner_type: row.owner_type,
        ownerType: row.owner_type,
        product_type_id: row.product_type_id,
        installment_policy: row.installment_policy,
        wholesale_moq: row.wholesale_moq,
        gender_code: row.gender_code,
        seasons: row.seasons,
        variant_id: row.variant_id,
        variantId: row.variant_id,
        sku: row.sku,
        size: row.size_label,
        color: row.color_label,
        weight_grams: row.weight_grams,
        attributes: row.attributes,
        base_wholesale_price_rial: resolved.basePrice,
        discount_rial: resolved.discountAmount,
        wholesale_price_rial: resolved.finalPrice,
        matched_promotion: resolved.matchedRule,
        wholesale_available_stock: Number(row.wholesale_available_stock ?? 0),
        wholesaleAvailableStock: Number(row.wholesale_available_stock ?? 0),
        sale_terms: terms,
        saleTerms: terms,
        allow_installments: row.allow_installments,
        disable_installments_on_discount: row.disable_installments_on_discount,
        fulfillment_via: 'kolbe_warehouse',
      });
    }
    return { items };
  });

  app.post('/api/v1/products', async (request, reply) => {
    const user = await principal(request, pool, config);
    const isSupplierOnly = user.roles.includes('supplier') && !user.permissions.includes('products:write');
    if (!user.roles.includes('supplier')) requirePermission(user, 'products:write');
    const body = productBody.parse(request.body);
    const cash = rial(body.cashPriceRial);
    const installment = body.installmentPriceRial === undefined ? null : rial(body.installmentPriceRial);
    const wholesale = body.wholesalePriceRial === undefined ? null : rial(body.wholesalePriceRial);
    if (cash === 0n && (!wholesale || wholesale === 0n)) throw badRequest('دست‌کم یک قیمت معتبر لازم است.');

    const isSupplier = user.roles.includes('supplier');
    if (isSupplierOnly) {
      const supplier = await one<{ activity_status: string; cooperation_status: string }>(
        pool,
        'SELECT activity_status, cooperation_status FROM supplier_profiles WHERE user_id = $1',
        [user.id],
      );
      if (!supplier) throw forbidden('پروفایل تأمین‌کننده یافت نشد؛ ابتدا درخواست همکاری تکمیل کنید.');
      await assertSupplierMay(pool, user.id, 'product_create', { resource: 'product', ip: request.ip });
      const violation = await transaction(pool, (client) => supplierCapViolation(client, user.id, 'product_limit'));
      if (violation) throw forbidden(violation);
      if (body.retailEnabled === true || body.wholesaleEnabled === false)
        throw new ApiError(403, 'FORBIDDEN', 'محصول تأمین‌کننده فقط در کانال عمده مجاز است.');
    }

    if (body.productTypeId) await assertTypeSizes(pool, body.productTypeId, body.variants.map((v) => v.size ?? undefined));
    // §8: Category is the source of truth for the NEW flow — allowed sizes + required specs
    // come from the category profile (product_type stays only as deprecated legacy data).
    await validateCategoryRequirements(pool, body.category, body.specifications, body.variants.map((v) => v.size));
    if (body.genderCode) await assertTaxonomy(pool, 'gender', body.genderCode);
    for (const season of new Set(body.seasons)) await assertTaxonomy(pool, 'season', season);

    const productId = randomUUID();
    const { specifications } = await resolveTypeSpecs(pool, body.productTypeCode, body.specifications, body.variants.map((v) => v.size));
    const ownerType = isSupplierOnly ? 'supplier' : 'kolbe';
    const retailEnabled = isSupplierOnly ? false : (body.retailEnabled ?? true);
    const wholesaleEnabled = isSupplierOnly ? true : (body.wholesaleEnabled ?? (wholesale !== null && wholesale > 0n));
    const resolvedPolicy = body.installmentPolicy
      ?? (body.allowInstallments === false
        ? 'disabled'
        : body.disableInstallmentsOnDiscount === true
          ? 'disabled_when_discounted'
          : 'enabled');
    const allowInstallments = body.allowInstallments ?? (resolvedPolicy !== 'disabled');
    const disableInstallmentsOnDiscount = body.disableInstallmentsOnDiscount ?? (resolvedPolicy === 'disabled_when_discounted');
    const saleTerms = body.saleTerms ?? {
      moq: body.wholesaleMoq ?? 1,
      packSize: 1,
      leadTimeDays: 3,
      returnableWithinDays: 7,
      fulfillmentPolicy: 'kolbe_central_qc',
    };
    const wholesaleMoq = body.wholesaleMoq !== undefined ? body.wholesaleMoq : (body.saleTerms?.moq ?? null);
    const seasons = [...new Set(body.seasons)];

    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial,metadata,
           product_type_code,specifications,gender,seasons,vibes,installment_enabled,discount_percent,
           product_type_id,owner_type,retail_enabled,wholesale_enabled,installment_policy,wholesale_moq,gender_code,
           sale_terms,allow_installments,disable_installments_on_discount,inventory_setup)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
        [
          productId,
          isSupplierOnly ? user.id : null,
          body.brand,
          body.name,
          body.category,
          body.description,
          isSupplierOnly ? 'pending' : 'draft',
          cash.toString(),
          installment?.toString() ?? null,
          wholesale?.toString() ?? null,
          JSON.stringify(body.metadata),
          body.productTypeCode ?? null,
          JSON.stringify(specifications),
          body.gender,
          seasons,
          body.vibes,
          body.installmentEnabled,
          body.discountPercent,
          body.productTypeId ?? null,
          ownerType,
          retailEnabled,
          wholesaleEnabled,
          resolvedPolicy,
          wholesaleMoq,
          body.genderCode ?? null,
          JSON.stringify(saleTerms),
          allowInstallments,
          disableInstallmentsOnDiscount,
          // §16: admin-defined KOLBE products start in «نیازمند راه‌اندازی» (pending);
          // supplier catalog submissions have no Kolbe stock profile to configure.
          isSupplierOnly ? 'configured' : 'pending',
        ],
      );
      for (const season of seasons) {
        await client.query('INSERT INTO product_seasons(product_id, season_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, season]);
      }
      const variants = [];
      for (const variant of body.variants) {
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${isSupplier ? 'SP' : 'KV'}-${categoryCode(body.category)}-${seq!.id}`;
        const id = randomUUID();
        const attrs = {
          ...variant.attributes,
          ...(variant.color ? { colorId: variant.color } : {}),
          ...(variant.size ? { sizeCode: variant.size } : {}),
        };
        await client.query(
          'INSERT INTO product_variants(id,product_id,sku,size_label,color_label,weight_grams,attributes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, productId, sku, variant.size ?? null, variant.color ?? null, variant.weightGrams ?? null, JSON.stringify(attrs)],
        );
        variants.push({ id, sku, color: variant.color ?? null, size: variant.size ?? null, weightGrams: variant.weightGrams ?? null });
      }
      await audit(client, user.id, 'product.created', 'product', productId, undefined, { name: body.name, ownerType, variants }, request.ip);
      await outbox(client, 'product.created', 'product', productId, { productId });
      await outbox(client, 'product.style_analysis_requested', 'product', productId, { productId, reason: 'product.created' });
      return {
        id: productId,
        status: isSupplierOnly ? 'pending' : 'draft',
        ownerType,
        retailEnabled,
        wholesaleEnabled,
        variants,
      };
    });
    return reply.code(201).send(result);
  });

  // Add new variant(s) to an existing product. Unified after the Agent 1/Agent 2 merge:
  // accepts BOTH the bulk shape {variants:[…]} (Agent 1 flows, promotion rules apply
  // automatically) and the single-cell shape {color,size,…} (Agent 2 matrix editor,
  // Req 26/32). All paths share the same guarantees: duplicate Color×Size → 409,
  // product-type size validation, server SKU, optional price override (Req 25).
  app.post('/api/v1/products/:id/variants', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rawBody = request.body as Record<string, unknown> | null;
    const isBulk = !!rawBody && Array.isArray((rawBody as { variants?: unknown }).variants);
    const items = isBulk
      ? z.object({ variants: z.array(variantInput).min(1).max(50) }).parse(rawBody).variants
      : [variantInput.parse(rawBody ?? {})];

    const created = await transaction(pool, async (client) => {
      const product = await one<{ id: string; category: string; supplier_id: string | null; product_type_id: string | null; specifications: Record<string, unknown> | null }>(
        client,
        'SELECT id, category, supplier_id, product_type_id, specifications FROM products WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!product) throw notFound();
      const isSupplierOnly = user.roles.includes('supplier') && !user.permissions.includes('products:write');
      if (isSupplierOnly) {
        if (product.supplier_id !== user.id) throw forbidden();
      } else {
        requirePermission(user, 'products:write');
      }
      if (product.product_type_id)
        await assertTypeSizes(client as unknown as DbPool, product.product_type_id, items.map((variant) => variant.size ?? undefined));
      // §8/§14 (final UAT gate): category profile bounds new variant sizes too — the rule
      // that guards product CREATE must also guard later variant additions (server-side,
      // regardless of what the UI offers). Existing specifications are passed through so
      // the required-spec check never false-fails on a product saved under this profile.
      await validateCategoryRequirements(client, product.category, product.specifications ?? {}, items.map((variant) => variant.size ?? null));

      const out = [];
      for (const variant of items) {
        const duplicate = await one<{ id: string }>(client,
          `SELECT id FROM product_variants WHERE product_id = $1
           AND COALESCE(color_label, '') = COALESCE($2, '') AND COALESCE(size_label, '') = COALESCE($3, '')`,
          [id, variant.color ?? null, variant.size ?? null]);
        if (duplicate) throw conflict('واریانتی با همین رنگ و سایز قبلاً برای این محصول ساخته شده است.');
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${product.supplier_id ? 'SP' : 'KV'}-${categoryCode(product.category)}-${seq!.id}`;
        const vId = randomUUID();
        const attrs = {
          ...variant.attributes,
          ...(variant.color ? { colorId: variant.color } : {}),
          ...(variant.size ? { sizeCode: variant.size } : {}),
        };
        await client.query(
          `INSERT INTO product_variants(id, product_id, sku, size_label, color_label, weight_grams, price_override_rial, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [vId, id, sku, variant.size ?? null, variant.color ?? null, variant.weightGrams ?? null, variant.priceOverrideRial ?? null, JSON.stringify(attrs)],
        );
        out.push({ id: vId, sku, size: variant.size ?? null, color: variant.color ?? null, weightGrams: variant.weightGrams ?? null,
          priceOverrideRial: variant.priceOverrideRial ?? null, active: true });
      }
      await audit(client, user.id, 'product.variants_added', 'product', id, undefined, { variants: out }, request.ip);
      return out;
    });
    return reply.code(201).send(isBulk ? { productId: id, variants: created } : created[0]);
  });

  app.patch('/api/v1/products/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      brand: z.string().trim().min(1).max(120).optional(),
      name: z.string().trim().min(2).max(240).optional(),
      category: z.string().trim().min(1).max(120).optional(),
      description: z.string().max(10000).optional(),
      cashPriceRial: z.string().regex(/^\d+$/).optional(),
      installmentPriceRial: z.string().regex(/^\d+$/).nullable().optional(),
      wholesalePriceRial: z.string().regex(/^\d+$/).nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      productTypeCode: z.string().regex(/^[a-z0-9_-]{2,40}$/).nullable().optional(),
      specifications: z.record(z.string(), z.unknown()).optional(),
      gender: z.enum(['men', 'women', 'unisex', 'kids']).optional(),
      vibes: z.array(z.string().regex(/^[a-z0-9-]{2,40}$/)).max(8).optional(),
      installmentEnabled: z.boolean().optional(),
      discountPercent: z.number().int().min(0).max(95).optional(),
      productTypeId: z.uuid().nullable().optional(),
      retailEnabled: z.boolean().optional(),
      wholesaleEnabled: z.boolean().optional(),
      installmentPolicy: installmentPolicy.optional(),
      wholesaleMoq: z.number().int().min(0).max(1000000).nullable().optional(),
      genderCode: z.string().trim().max(40).nullable().optional(),
      seasons: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    }).strict().parse(request.body);
    const owned = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
    if (!owned) throw notFound();
    const isSupplierOwner = owned.supplier_id === user.id && user.roles.includes('supplier');
    if (!isSupplierOwner) requirePermission(user, 'products:write');
    else await assertSupplierMay(pool, user.id, 'product_edit', { resource: 'product', resourceId: id, ip: request.ip });
    return transaction(pool, async (client) => {
      const before = await one<{ supplier_id: string | null; status: string; product_type_code: string | null; owner_type: string }>(client,
        'SELECT supplier_id, status, product_type_code, owner_type FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (before && (body.specifications !== undefined || body.productTypeCode !== undefined)) {
        const code = body.productTypeCode === null ? undefined : body.productTypeCode ?? before.product_type_code ?? undefined;
        body.specifications = (await resolveTypeSpecs(client, code, body.specifications ?? {}, [])).specifications;
      }
      if (!before) throw notFound();
      const isSupplierOwner = before.supplier_id === user.id && user.roles.includes('supplier');
      if (!isSupplierOwner) requirePermission(user, 'products:write');
      if (isSupplierOwner && (body.retailEnabled === true || body.wholesaleEnabled === false))
        throw new ApiError(403, 'FORBIDDEN', 'محصول تأمین‌کننده فقط در کانال عمده مجاز است.');
      if (body.cashPriceRial !== undefined) rial(body.cashPriceRial);
      if (body.installmentPriceRial) rial(body.installmentPriceRial);
      if (body.wholesalePriceRial) rial(body.wholesalePriceRial);
      if (body.productTypeId) {
        const type = await one<{ active: boolean }>(client, 'SELECT active FROM product_types WHERE id = $1', [body.productTypeId]);
        if (!type || !type.active) throw badRequest('نوع محصول انتخاب‌شده فعال نیست.');
      }
      if (body.genderCode) await assertTaxonomy(client as unknown as DbPool, 'gender', body.genderCode);
      if (body.seasons) for (const season of new Set(body.seasons)) await assertTaxonomy(client as unknown as DbPool, 'season', season);
      const columns: Record<string, string> = {
        brand: 'brand', name: 'name', category: 'category', description: 'description',
        cashPriceRial: 'cash_price_rial', installmentPriceRial: 'installment_price_rial',
        wholesalePriceRial: 'wholesale_price_rial', metadata: 'metadata',
        productTypeCode: 'product_type_code', specifications: 'specifications', gender: 'gender', seasons: 'seasons',
        vibes: 'vibes', installmentEnabled: 'installment_enabled', discountPercent: 'discount_percent',
        productTypeId: 'product_type_id', retailEnabled: 'retail_enabled', wholesaleEnabled: 'wholesale_enabled',
        installmentPolicy: 'installment_policy', wholesaleMoq: 'wholesale_moq', genderCode: 'gender_code',
      };
      const values: unknown[] = [id];
      const updates: string[] = [];
      for (const [key, column] of Object.entries(columns)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (isSupplierOwner && (column === 'retail_enabled' || column === 'wholesale_enabled')) continue;
        values.push(key === 'metadata' || key === 'specifications' ? JSON.stringify(value) : value);
        updates.push(`${column} = $${values.length}`);
      }
      if (body.seasons !== undefined) {
        await client.query('DELETE FROM product_seasons WHERE product_id = $1', [id]);
        for (const season of new Set(body.seasons)) {
          await client.query('INSERT INTO product_seasons(product_id, season_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, season]);
        }
      }
      if (!updates.length && body.seasons === undefined) throw badRequest('تغییری برای ذخیره وجود ندارد.');
      if (updates.length) {
        await client.query(`UPDATE products SET ${updates.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`, values);
      }
      await audit(client, user.id, 'product.updated', 'product', id, before,
        { fields: Object.keys(body) }, request.ip);
      await outbox(client, 'product.updated', 'product', id, { productId: id });
      return { id, updated: Object.keys(body) };
    });
  });

  app.patch('/api/v1/products/:id/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { status } = statusBody.parse(request.body);
    if (user.roles.includes('supplier') && status === 'published') {
      await assertSupplierMay(pool, user.id, 'product_publish', { resource: 'product', resourceId: id, ip: request.ip });
      const owned = await one<{ supplier_id: string | null }>(pool, 'SELECT supplier_id FROM products WHERE id = $1', [id]);
      if (!owned || (owned.supplier_id && owned.supplier_id !== user.id)) throw forbidden();
    }
    return transaction(pool, async (client) => {
      const before = await one<{ status: string }>(client, 'SELECT status FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (before.status === status) return { id, status };
      await client.query('UPDATE products SET status = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, status]);
      await audit(client, user.id, 'product.status_changed', 'product', id, before, { status }, request.ip);
      await outbox(client, 'product.status_changed', 'product', id, { productId: id, status });
      return { id, status };
    });
  });

  /**
   * §11/§12: bulk sale-status (فعال‌سازی/توقف فروش خرده) — ONE backend call with
   * per-item results; invalid items fail with a readable reason, valid items apply.
   * Sale status is independent from stock status (§8) and never touches balances.
   */
  app.post('/api/v1/products/bulk/sale-status', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const body = z.object({
      productIds: z.array(z.uuid()).min(1).max(200)
        .refine((ids) => new Set(ids).size === ids.length, 'هر محصول فقط یک بار مجاز است.'),
      enabled: z.boolean(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const results: { productId: string; ok: boolean; name?: string; error?: string }[] = [];
      for (const productId of body.productIds) {
        const product = await one<{ id: string; name: string; status: string; owner_type: string; retail_enabled: boolean; cash_price_rial: string | null }>(
          client,
          'SELECT id, name, status, owner_type, retail_enabled, cash_price_rial FROM products WHERE id = $1 FOR UPDATE',
          [productId]);
        if (!product) { results.push({ productId, ok: false, error: 'محصول یافت نشد.' }); continue; }
        if (product.status === 'archived') {
          results.push({ productId, ok: false, name: product.name, error: 'محصول آرشیو شده است؛ ابتدا باید از آرشیو خارج شود.' });
          continue;
        }
        if (body.enabled && product.owner_type === 'supplier') {
          results.push({ productId, ok: false, name: product.name, error: 'محصول متعلق به تأمین‌کننده فقط در کانال عمده مجاز است.' });
          continue;
        }
        if (body.enabled && (!product.cash_price_rial || product.cash_price_rial === '0')) {
          results.push({ productId, ok: false, name: product.name, error: 'قیمت خرده‌فروشی ثبت نشده است؛ فعال‌سازی فروش مجاز نیست.' });
          continue;
        }
        if (product.retail_enabled === body.enabled) {
          results.push({ productId, ok: true, name: product.name });
          continue;
        }
        await client.query('UPDATE products SET retail_enabled = $2, version = version + 1, updated_at = now() WHERE id = $1', [productId, body.enabled]);
        await outbox(client, 'product.updated', 'product', productId, { productId, retailEnabled: body.enabled });
        results.push({ productId, ok: true, name: product.name });
      }
      const succeeded = results.filter((item) => item.ok).length;
      await audit(client, user.id, 'products.bulk_sale_status', 'product', body.productIds[0]!, undefined,
        { enabled: body.enabled, requested: body.productIds.length, succeeded, failed: results.length - succeeded,
          failures: results.filter((item) => !item.ok).map((item) => ({ productId: item.productId, error: item.error })) },
        request.ip);
      return { results, succeeded, failed: results.length - succeeded };
    });
  });

  /**
   * §27-§30: scoped sale status — the fix for «توقف یک تنوع، کل محصول را متوقف می‌کرد».
   * Three EXPLICIT scopes in one transactional call with per-item results:
   *  - product: products.retail_enabled (master switch, as before)
   *  - color:   all variants of محصول+رنگ via product_variants.retail_sale_enabled (ONE backend op)
   *  - variant: a single variant's retail_sale_enabled
   * variant.active is NOT repurposed; every change is audited. Effective sellability stays
   * server-computed: product enabled AND variant enabled AND not archived AND valid price.
   */
  app.post('/api/v1/products/sale-status-scoped', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const body = z.object({
      scope: z.enum(['product', 'color', 'variant']),
      enabled: z.boolean(),
      productIds: z.array(z.uuid()).max(200).optional(),
      colorTargets: z.array(z.object({ productId: z.uuid(), colorLabel: z.string().trim().min(1).max(60) })).max(200).optional(),
      variantIds: z.array(z.uuid()).max(200).optional(),
    }).strict().parse(request.body);

    return transaction(pool, async (client) => {
      const results: { key: string; label: string; ok: boolean; error?: string; affectedVariants?: number }[] = [];

      if (body.scope === 'product') {
        const ids = body.productIds ?? [];
        if (!ids.length) throw badRequest('برای دامنه «محصول» حداقل یک محصول لازم است.');
        for (const productId of ids) {
          const product = await one<{ id: string; name: string; status: string; owner_type: string; retail_enabled: boolean; cash_price_rial: string | null }>(
            client, 'SELECT id, name, status, owner_type, retail_enabled, cash_price_rial FROM products WHERE id = $1 FOR UPDATE', [productId]);
          if (!product) { results.push({ key: productId, label: productId, ok: false, error: 'محصول یافت نشد.' }); continue; }
          if (product.status === 'archived') { results.push({ key: productId, label: product.name, ok: false, error: 'محصول آرشیو شده است.' }); continue; }
          if (body.enabled && product.owner_type === 'supplier') { results.push({ key: productId, label: product.name, ok: false, error: 'محصول تأمین‌کننده فقط در کانال عمده مجاز است.' }); continue; }
          if (body.enabled && (!product.cash_price_rial || product.cash_price_rial === '0')) { results.push({ key: productId, label: product.name, ok: false, error: 'قیمت خرده ثبت نشده است.' }); continue; }
          if (product.retail_enabled !== body.enabled) {
            await client.query('UPDATE products SET retail_enabled = $2, version = version + 1, updated_at = now() WHERE id = $1', [productId, body.enabled]);
            await outbox(client, 'product.updated', 'product', productId, { productId, retailEnabled: body.enabled });
          }
          await audit(client, user.id, 'product.sale_status_changed', 'product', productId,
            { retail_enabled: product.retail_enabled }, { retail_enabled: body.enabled, scope: 'product' }, request.ip);
          results.push({ key: productId, label: product.name, ok: true });
        }
      }

      if (body.scope === 'color') {
        const targets = body.colorTargets ?? [];
        if (!targets.length) throw badRequest('برای دامنه «رنگ» حداقل یک محصول+رنگ لازم است.');
        for (const target of targets) {
          const key = `${target.productId}|${target.colorLabel}`;
          const product = await one<{ id: string; name: string; status: string }>(
            client, 'SELECT id, name, status FROM products WHERE id = $1 FOR UPDATE', [target.productId]);
          if (!product) { results.push({ key, label: key, ok: false, error: 'محصول یافت نشد.' }); continue; }
          if (product.status === 'archived') { results.push({ key, label: `${product.name} — ${target.colorLabel}`, ok: false, error: 'محصول آرشیو شده است.' }); continue; }
          const updated = await client.query(
            `UPDATE product_variants SET retail_sale_enabled = $3
             WHERE product_id = $1 AND color_label = $2 AND retail_sale_enabled <> $3
             RETURNING id`,
            [target.productId, target.colorLabel, body.enabled]);
          const existing = await one<{ c: string }>(client,
            'SELECT count(*)::text AS c FROM product_variants WHERE product_id = $1 AND color_label = $2', [target.productId, target.colorLabel]);
          if (Number(existing?.c ?? '0') === 0) { results.push({ key, label: `${product.name} — ${target.colorLabel}`, ok: false, error: 'تنوعی با این رنگ یافت نشد.' }); continue; }
          await audit(client, user.id, 'product_color.sale_status_changed', 'product', target.productId,
            undefined, { colorLabel: target.colorLabel, retail_sale_enabled: body.enabled, affected: updated.rowCount, scope: 'color' }, request.ip);
          results.push({ key, label: `${product.name} — ${target.colorLabel}`, ok: true, affectedVariants: Number(existing?.c ?? '0') });
        }
      }

      if (body.scope === 'variant') {
        const ids = body.variantIds ?? [];
        if (!ids.length) throw badRequest('برای دامنه «تنوع» حداقل یک تنوع لازم است.');
        for (const variantId of ids) {
          const variant = await one<{ id: string; sku: string; retail_sale_enabled: boolean; product_id: string; product_status: string; product_name: string }>(
            client,
            `SELECT v.id, v.sku, v.retail_sale_enabled, p.id AS product_id, p.status AS product_status, p.name AS product_name
             FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 FOR UPDATE OF v`,
            [variantId]);
          if (!variant) { results.push({ key: variantId, label: variantId, ok: false, error: 'تنوع یافت نشد.' }); continue; }
          if (variant.product_status === 'archived') { results.push({ key: variantId, label: variant.sku, ok: false, error: 'محصول آرشیو شده است.' }); continue; }
          if (variant.retail_sale_enabled !== body.enabled) {
            await client.query('UPDATE product_variants SET retail_sale_enabled = $2 WHERE id = $1', [variantId, body.enabled]);
          }
          await audit(client, user.id, 'variant.sale_status_changed', 'product_variant', variantId,
            { retail_sale_enabled: variant.retail_sale_enabled }, { retail_sale_enabled: body.enabled, scope: 'variant' }, request.ip);
          results.push({ key: variantId, label: `${variant.product_name} (${variant.sku})`, ok: true });
        }
      }

      const succeeded = results.filter((item) => item.ok).length;
      return { results, succeeded, failed: results.length - succeeded };
    });
  });

  /** §12: safe bulk archive — stock and ledger stay untouched; per-item results. */
  app.post('/api/v1/products/bulk/archive', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const body = z.object({
      productIds: z.array(z.uuid()).min(1).max(200)
        .refine((ids) => new Set(ids).size === ids.length, 'هر محصول فقط یک بار مجاز است.'),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const results: { productId: string; ok: boolean; name?: string; error?: string }[] = [];
      for (const productId of body.productIds) {
        const product = await one<{ id: string; name: string; status: string }>(client,
          'SELECT id, name, status FROM products WHERE id = $1 FOR UPDATE', [productId]);
        if (!product) { results.push({ productId, ok: false, error: 'محصول یافت نشد.' }); continue; }
        if (product.status === 'archived') { results.push({ productId, ok: true, name: product.name }); continue; }
        await client.query(`UPDATE products SET status = 'archived', version = version + 1, updated_at = now() WHERE id = $1`, [productId]);
        await outbox(client, 'product.status_changed', 'product', productId, { productId, status: 'archived' });
        results.push({ productId, ok: true, name: product.name });
      }
      const succeeded = results.filter((item) => item.ok).length;
      await audit(client, user.id, 'products.bulk_archived', 'product', body.productIds[0]!, undefined,
        { requested: body.productIds.length, succeeded, failed: results.length - succeeded }, request.ip);
      return { results, succeeded, failed: results.length - succeeded };
    });
  });

  /**
   * P: hard delete is only allowed for fully clean products (no orders, invoices,
   * movements, receipts, transfers, manual sales, promotions, supplier requests or
   * series history). Anything with history must be archived/disabled instead.
   */
  app.delete('/api/v1/products/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);

    return transaction(pool, async (client) => {
      const product = await one<{ id: string; name: string }>(client, 'SELECT id, name FROM products WHERE id = $1 FOR UPDATE', [id]);
      if (!product) throw notFound();

      const blockers: string[] = [];
      const checks: Array<{ label: string; sql: string }> = [
        { label: 'سفارش ثبت‌شده', sql: `SELECT 1 FROM order_lines ol JOIN product_variants v ON v.id = ol.variant_id WHERE v.product_id = $1 LIMIT 1` },
        { label: 'گردش موجودی', sql: `SELECT 1 FROM stock_movements m JOIN product_variants v ON v.id = m.variant_id WHERE v.product_id = $1 LIMIT 1` },
        { label: 'رسید انبار', sql: `SELECT 1 FROM stock_receipts r JOIN product_variants v ON v.id = r.variant_id WHERE v.product_id = $1 LIMIT 1` },
        { label: 'انتقال موجودی', sql: `SELECT 1 FROM stock_transfers t JOIN product_variants v ON v.id = t.variant_id WHERE v.product_id = $1 LIMIT 1` },
        { label: 'فروش دستی', sql: `SELECT 1 FROM manual_sale_lines l JOIN product_variants v ON v.id = l.variant_id WHERE v.product_id = $1 LIMIT 1` },
        { label: 'قانون تخفیف/جشنواره', sql: `SELECT 1 FROM promotion_rules WHERE product_id = $1 LIMIT 1` },
        { label: 'درخواست تأمین', sql: `SELECT 1 FROM supplier_request_items WHERE product_id = $1 LIMIT 1` },
        { label: 'قالب سری', sql: `SELECT 1 FROM series_templates WHERE product_id = $1 LIMIT 1` },
        { label: 'سند تملک', sql: `SELECT 1 FROM ownership_conversions WHERE product_id = $1 LIMIT 1` },
      ];
      for (const check of checks) {
        const hit = await one<{ ok: number }>(client, check.sql, [id]);
        if (hit) blockers.push(check.label);
      }
      const stocked = await one<{ ok: number }>(client,
        `SELECT 1 AS ok FROM stock_balances b JOIN product_variants v ON v.id = b.variant_id
         WHERE v.product_id = $1 AND (b.on_hand > 0 OR b.reserved > 0 OR b.incoming > 0 OR b.damaged > 0) LIMIT 1`, [id]);
      if (stocked) blockers.push('موجودی فیزیکی');

      if (blockers.length > 0) {
        throw conflict(
          `این محصول دارای سابقه (${blockers.join('، ')}) است و حذف فیزیکی آن مجاز نیست؛ به‌جای حذف، آن را آرشیو یا غیرفعال کنید.`,
        );
      }

      await client.query('DELETE FROM stock_balances WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)', [id]);
      await client.query('DELETE FROM product_variants WHERE product_id = $1', [id]);
      await client.query('DELETE FROM products WHERE id = $1', [id]);
      await audit(client, user.id, 'product.hard_deleted', 'product', id, { name: product.name }, undefined, request.ip);
      await outbox(client, 'product.hard_deleted', 'product', id, { productId: id, name: product.name });
      return { id, deleted: true };
    });
  });

  /**
   * Full product detail for the unified create/edit Product Studio (Req 38-39).
   * Unlike the public list this includes ALL variants (active + disabled) so the
   * Color×Size matrix can distinguish "variant disabled" from "variant missing"
   * and "stock 0" (Req 26/32).
   */
  app.get('/api/v1/admin/products/:id', async (request) => {
    const user = await principal(request, pool, config);
    requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const product = await one<Record<string, unknown>>(pool, 'SELECT * FROM products WHERE id = $1', [id]);
    if (!product) throw notFound();
    const variants = await pool.query(
      `SELECT v.id, v.sku, v.size_label AS size, v.color_label AS color, v.weight_grams, v.active, v.attributes,
              v.price_override_rial::text AS price_override_rial,
              COALESCE(SUM(b.on_hand - b.reserved - b.damaged), 0)::int AS available,
              COALESCE(SUM(b.on_hand), 0)::int AS on_hand,
              COALESCE(SUM(b.on_hand - b.reserved - b.damaged) FILTER (WHERE b.inventory_domain = 'retail'), 0)::int AS retail_available,
              COALESCE(SUM(b.on_hand) FILTER (WHERE b.inventory_domain = 'retail'), 0)::int AS retail_on_hand,
              COALESCE(SUM(b.on_hand - b.reserved - b.damaged) FILTER (WHERE b.inventory_domain = 'wholesale'), 0)::int AS wholesale_available,
              COALESCE(SUM(b.on_hand) FILTER (WHERE b.inventory_domain = 'wholesale'), 0)::int AS wholesale_on_hand
       FROM product_variants v LEFT JOIN stock_balances b ON b.variant_id = v.id
       WHERE v.product_id = $1 GROUP BY v.id ORDER BY v.sku`, [id]);
    const row = product as { cash_price_rial: string; installment_price_rial: string | null; wholesale_price_rial: string | null };
    return {
      ...product,
      cash_price_rial: asRial(row.cash_price_rial),
      installment_price_rial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
      wholesale_price_rial: row.wholesale_price_rial === null ? null : asRial(row.wholesale_price_rial),
      variants: variants.rows,
    };
  });

  /** Variant-level maintenance (weight for shipping, active flag) — item 83. */
  app.patch('/api/v1/products/:id/variants/:variantId', async (request) => {
    const user = await principal(request, pool, config);
    const params = z.object({ id: z.uuid(), variantId: z.uuid() }).parse(request.params);
    const body = z.object({
      weightGrams: z.number().int().min(0).max(1000000).nullable().optional(),
      active: z.boolean().optional(),
      // Req 25: set/clear the per-variant retail price override (integer rial; null = follow base price).
      priceOverrideRial: z.string().regex(/^\d{1,15}$/).nullable().optional(),
    }).strict().parse(request.body);
    if (body.weightGrams === undefined && body.active === undefined && body.priceOverrideRial === undefined)
      throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const product = await one<{ supplier_id: string | null }>(client, 'SELECT supplier_id FROM products WHERE id = $1', [params.id]);
      if (!product) throw notFound();
      const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
      if (!isOwner) requirePermission(user, 'products:write');
      const variant = await one<{ id: string; weight_grams: number | null; active: boolean; price_override_rial: string | null }>(client,
        'SELECT id, weight_grams, active, price_override_rial::text FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE', [params.variantId, params.id]);
      if (!variant) throw notFound();
      const updates: string[] = [];
      const values: unknown[] = [params.variantId];
      if (body.weightGrams !== undefined) { values.push(body.weightGrams); updates.push(`weight_grams = $${values.length}`); }
      if (body.active !== undefined) { values.push(body.active); updates.push(`active = $${values.length}`); }
      if (body.priceOverrideRial !== undefined) { values.push(body.priceOverrideRial); updates.push(`price_override_rial = $${values.length}`); }
      await client.query(`UPDATE product_variants SET ${updates.join(', ')} WHERE id = $1`, values);
      await audit(client, user.id, 'product.variant_updated', 'product', params.id, variant, body, request.ip);
      return { id: params.variantId, ...body };
    });
  });
}
