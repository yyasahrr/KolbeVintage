import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { principal, requirePermission } from './auth.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { ApiError, badRequest, forbidden, notFound } from './errors.js';
import { validateSpecifications, type SpecField } from './profile.js';
import { assertSupplierMay, supplierCapViolation } from './supplier360.js';

const installmentPolicy = z.enum(['disabled', 'enabled', 'disabled_when_discounted', 'enabled_when_discounted']);
const variantInput = z.object({
  size: z.string().max(50).optional(),
  color: z.string().max(100).optional(),
  weightGrams: z.number().int().min(0).max(1000000).nullable().optional(),
  attributes: z.record(z.string(), z.string()).default({}),
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
  // Adaptive product form (Req 325-326): type → template → validated values.
  productTypeCode: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional(),
  specifications: z.record(z.string(), z.unknown()).default({}),
  gender: z.enum(['men', 'women', 'unisex', 'kids']).default('unisex'),
  vibes: z.array(z.string().regex(/^[a-z0-9-]{2,40}$/)).max(8).default([]),
  installmentEnabled: z.boolean().default(true),
  discountPercent: z.number().int().min(0).max(95).default(0),
  // Item 8/35/36/46/245-247 — all optional so older clients keep working.
  productTypeId: z.uuid().nullable().optional(),
  retailEnabled: z.boolean().optional(),
  wholesaleEnabled: z.boolean().optional(),
  installmentPolicy: installmentPolicy.optional(),
  wholesaleMoq: z.number().int().min(0).max(1000000).nullable().optional(),
  genderCode: z.string().trim().max(40).nullable().optional(),
  seasons: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

/** Loads the type template and validates the values; sizes must belong to the type's active size list. */
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
  variants: { id: string; sku: string; size: string | null; color: string | null; weightGrams: number | null;
    available?: number; reserved?: number; incoming?: number; damaged?: number }[];
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
      // Item 35: query isolation. Retail is the storefront-safe default.
      channel: z.enum(['retail', 'wholesale', 'all']).default('retail'),
      productTypeId: z.uuid().optional(),
      gender: z.string().max(40).optional(),
      season: z.string().max(40).optional(),
    }).parse(request.query);
    // Availability is derived from the WMS ledger (stock_balances), never from product.metadata.
    const result = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.description, p.cash_price_rial,
              p.installment_price_rial, p.wholesale_price_rial, p.owner_type, p.retail_enabled, p.wholesale_enabled,
              p.product_type_id, p.installment_policy, p.wholesale_moq, p.gender_code, p.gender,
              p.seasons, p.vibes, p.specifications, p.installment_enabled, p.discount_percent, p.supplier_id,
              p.metadata, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'size', v.size_label, 'color', v.color_label,
                'weightGrams', v.weight_grams,
                'available', COALESCE(b.available, 0), 'reserved', COALESCE(b.reserved, 0),
                'incoming', COALESCE(b.incoming, 0), 'damaged', COALESCE(b.damaged, 0))
                ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
       LEFT JOIN (
         SELECT sb.variant_id,
                SUM(sb.on_hand - sb.reserved - sb.damaged)::int AS available,
                SUM(sb.reserved)::int AS reserved, SUM(sb.incoming)::int AS incoming, SUM(sb.damaged)::int AS damaged
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
    return { items: (result.rows as ProductListRow[]).map((row) => {
      const variants = row.variants as { available?: number; reserved?: number; incoming?: number; damaged?: number }[];
      const sum = (key: 'available' | 'reserved' | 'incoming' | 'damaged') => variants.reduce((total, variant) => total + Number(variant[key] ?? 0), 0);
      return {
        id: row.id, brand: row.brand, name: row.name, category: row.category, description: row.description,
        cashPriceRial: asRial(row.cash_price_rial),
        installmentPriceRial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
        wholesalePriceRial: row.wholesale_price_rial === null ? null : asRial(row.wholesale_price_rial),
        ownerType: row.owner_type, retailEnabled: row.retail_enabled, wholesaleEnabled: row.wholesale_enabled,
        productTypeId: row.product_type_id, installmentPolicy: row.installment_policy,
        wholesaleMoq: row.wholesale_moq, genderCode: row.gender_code,
        metadata: row.metadata, variants, createdAt: row.created_at,
        productTypeCode: row.product_type_code, gender: row.gender, seasons: row.seasons, vibes: row.vibes,
        specifications: row.specifications, installmentEnabled: row.installment_enabled, discountPercent: row.discount_percent,
        supplierId: row.supplier_id,
        available: sum('available'), reserved: sum('reserved'), incoming: sum('incoming'), damaged: sum('damaged'),
      };
    }) };
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

  app.get('/api/v1/wholesale/products', async (request) => {
    const user = await principal(request, pool, config);
    const membership = await one<{ limits: Record<string, unknown> }>(pool,
      `SELECT p.limits FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
       WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
       LIMIT 1`, [user.id]);
    if (!membership) throw forbidden();
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(30),
      productTypeId: z.uuid().optional(), gender: z.string().max(40).optional(), season: z.string().max(40).optional(),
    }).parse(request.query);
    const kolbeOnly = membership.limits.sources === 'kolbe';
    const rows = await pool.query(
      `SELECT p.id,p.name,p.brand,p.category,p.wholesale_price_rial,p.owner_type,p.product_type_id,
              p.installment_policy,p.wholesale_moq,p.gender_code,v.id AS variant_id,v.sku,v.weight_grams,
              COALESCE((SELECT jsonb_agg(ps.season_code) FROM product_seasons ps WHERE ps.product_id = p.id), '[]'::jsonb) AS seasons
       FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published' AND p.wholesale_price_rial > 0 AND p.wholesale_enabled = true
         AND (NOT $1::boolean OR p.supplier_id IS NULL)
         AND ($3::uuid IS NULL OR p.product_type_id = $3)
         AND ($4::text IS NULL OR p.gender_code = $4)
         AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM product_seasons ps WHERE ps.product_id = p.id AND ps.season_code = $5))
       ORDER BY p.created_at DESC,v.sku LIMIT $2`, [kolbeOnly, query.limit, query.productTypeId ?? null, query.gender ?? null, query.season ?? null]);
    return { items: rows.rows.map((row) => ({ ...row, wholesale_price_rial: asRial(row.wholesale_price_rial) })) };
  });

  app.post('/api/v1/products', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'products:write');
    const body = productBody.parse(request.body);
    const cash = rial(body.cashPriceRial), installment = body.installmentPriceRial === undefined ? null : rial(body.installmentPriceRial);
    const wholesale = body.wholesalePriceRial === undefined ? null : rial(body.wholesalePriceRial);
    if (cash === 0n && (!wholesale || wholesale === 0n)) throw badRequest('دست‌کم یک قیمت معتبر لازم است.');
    const isSupplier = user.roles.includes('supplier');
    if (isSupplier) {
      // Agent B: the activity lifecycle (item 11) is the single gate - it already folds in
      // the legacy cooperation status and always explains *why* an action is blocked.
      const supplier = await one<{ activity_status: string }>(pool,
        'SELECT activity_status FROM supplier_profiles WHERE user_id = $1', [user.id]);
      if (!supplier) throw forbidden('پروفایل تأمین‌کننده یافت نشد؛ ابتدا درخواست همکاری تکمیل کنید.');
      await assertSupplierMay(pool, user.id, 'product_create', { resource: 'product', ip: request.ip });
      const violation = await transaction(pool, (client) => supplierCapViolation(client, user.id, 'product_limit'));
      if (violation) throw forbidden(violation);
      // Item 35: the API itself refuses a retail/supplier combination.
      if (body.retailEnabled === true || body.wholesaleEnabled === false)
        throw new ApiError(403, 'FORBIDDEN', 'محصول تأمین‌کننده فقط در کانال عمده مجاز است.');
    }
    if (body.productTypeId) await assertTypeSizes(pool, body.productTypeId, body.variants.map((v) => v.size ?? undefined));
    if (body.genderCode) await assertTaxonomy(pool, 'gender', body.genderCode);
    for (const season of new Set(body.seasons)) await assertTaxonomy(pool, 'season', season);
    const productId = randomUUID();
    const { specifications } = await resolveTypeSpecs(pool, body.productTypeCode, body.specifications, body.variants.map((v) => v.size));
    const ownerType = isSupplier ? 'supplier' : 'kolbe';
    const retailEnabled = isSupplier ? false : (body.retailEnabled ?? true);
    const wholesaleEnabled = isSupplier ? true : (body.wholesaleEnabled ?? true);
    // One seasons array feeds both representations (products.seasons + product_seasons) so they never diverge.
    const seasons = [...new Set(body.seasons)];
    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial,metadata,
           product_type_code,specifications,gender,seasons,vibes,installment_enabled,discount_percent,
           product_type_id,owner_type,retail_enabled,wholesale_enabled,installment_policy,wholesale_moq,gender_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [productId, isSupplier ? user.id : null, body.brand, body.name, body.category, body.description,
          isSupplier ? 'pending' : 'draft', cash.toString(), installment?.toString() ?? null, wholesale?.toString() ?? null,
          JSON.stringify(body.metadata), body.productTypeCode ?? null, JSON.stringify(specifications), body.gender,
          seasons, body.vibes, body.installmentEnabled, body.discountPercent,
          body.productTypeId ?? null, ownerType, retailEnabled, wholesaleEnabled,
          body.installmentPolicy ?? 'enabled', body.wholesaleMoq ?? null, body.genderCode ?? null]);
      for (const season of seasons) {
        await client.query('INSERT INTO product_seasons(product_id, season_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, season]);
      }
      const variants = [];
      for (const variant of body.variants) {
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${isSupplier ? 'SP' : 'KV'}-${categoryCode(body.category)}-${seq!.id}`;
        const id = randomUUID();
        await client.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,weight_grams,attributes) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [id, productId, sku, variant.size ?? null, variant.color ?? null, variant.weightGrams ?? null, JSON.stringify(variant.attributes)]);
        // Color/size travel with the ids so the client can bind per-variant inventory input
        // without relying on array order.
        variants.push({ id, sku, color: variant.color ?? null, size: variant.size ?? null, weightGrams: variant.weightGrams ?? null });
      }
      await audit(client, user.id, 'product.created', 'product', productId, undefined, { name: body.name, variants }, request.ip);
      await outbox(client, 'product.created', 'product', productId, { productId });
      // Style analysis is async (Req 252): creation never waits for it.
      await outbox(client, 'product.style_analysis_requested', 'product', productId, { productId, reason: 'product.created' });
      return { id: productId, status: isSupplier ? 'pending' : 'draft', ownerType, variants };
    });
    return reply.code(201).send(result);
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

  /** Variant-level maintenance (weight for shipping, active flag) — item 83. */
  app.patch('/api/v1/products/:id/variants/:variantId', async (request) => {
    const user = await principal(request, pool, config);
    const params = z.object({ id: z.uuid(), variantId: z.uuid() }).parse(request.params);
    const body = z.object({
      weightGrams: z.number().int().min(0).max(1000000).nullable().optional(),
      active: z.boolean().optional(),
    }).strict().parse(request.body);
    if (body.weightGrams === undefined && body.active === undefined) throw badRequest('تغییری برای ذخیره وجود ندارد.');
    return transaction(pool, async (client) => {
      const product = await one<{ supplier_id: string | null }>(client, 'SELECT supplier_id FROM products WHERE id = $1', [params.id]);
      if (!product) throw notFound();
      const isOwner = product.supplier_id === user.id && user.roles.includes('supplier');
      if (!isOwner) requirePermission(user, 'products:write');
      const variant = await one<{ id: string; weight_grams: number | null; active: boolean }>(client,
        'SELECT id, weight_grams, active FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE', [params.variantId, params.id]);
      if (!variant) throw notFound();
      const updates: string[] = [];
      const values: unknown[] = [params.variantId];
      if (body.weightGrams !== undefined) { values.push(body.weightGrams); updates.push(`weight_grams = $${values.length}`); }
      if (body.active !== undefined) { values.push(body.active); updates.push(`active = $${values.length}`); }
      await client.query(`UPDATE product_variants SET ${updates.join(', ')} WHERE id = $1`, values);
      await audit(client, user.id, 'product.variant_updated', 'product', params.id, variant, body, request.ip);
      return { id: params.variantId, ...body };
    });
  });
}
