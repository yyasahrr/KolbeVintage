import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { one, transaction, type DbPool } from './db.js';
import { principal, requirePermission } from './auth.js';
import { asRial, rial } from './money.js';
import { audit, outbox } from './operations.js';
import { badRequest, forbidden, notFound } from './errors.js';

const productBody = z.object({
  brand: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2).max(240),
  category: z.string().trim().min(1).max(120),
  description: z.string().max(10000).default(''),
  cashPriceRial: z.string().regex(/^\d+$/),
  installmentPriceRial: z.string().regex(/^\d+$/).optional(),
  wholesalePriceRial: z.string().regex(/^\d+$/).optional(),
  gender: z.string().max(80).optional(),
  seasons: z.array(z.string().max(80)).max(20).default([]),
  vibes: z.array(z.string().max(100)).max(30).default([]),
  attributes: z.record(z.string().max(100), z.string().max(300)).default({}),
  discountPercent: z.number().int().min(0).max(100).optional(),
  variants: z.array(z.object({ size: z.string().max(50).optional(), color: z.string().max(100).optional(), attributes: z.record(z.string(), z.string()).default({}) })).min(1).max(100),
});
const statusBody = z.object({ status: z.enum(['published', 'rejected', 'draft', 'archived']) });

const categoryCode = (category: string) => /کفش|کتانی|بوت/.test(category) ? 'SHOE' : /شلوار|جین/.test(category) ? 'PANT'
  : /اکسسوری|کیف|شال|کمربند/.test(category) ? 'ACCS' : /کت|بلیزر/.test(category) ? 'COAT' : 'ITEM';

export function registerCatalogRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/products', async (request) => {
    const query = z.object({ category: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(30), before: z.iso.datetime().optional() }).parse(request.query);
    const result = await pool.query(
      `SELECT p.id, p.brand, p.name, p.category, p.description, p.cash_price_rial,
              p.installment_price_rial, p.created_at,
              COALESCE(jsonb_agg(jsonb_build_object('id', v.id, 'sku', v.sku, 'size', v.size_label, 'color', v.color_label)
                ORDER BY v.sku) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
       FROM products p LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published' AND ($1::text IS NULL OR p.category = $1)
         AND ($2::timestamptz IS NULL OR p.created_at < $2)
       GROUP BY p.id ORDER BY p.created_at DESC LIMIT $3`, [query.category ?? null, query.before ?? null, query.limit]);
    return { items: result.rows.map((row) => ({
      id: row.id, brand: row.brand, name: row.name, category: row.category, description: row.description,
      cashPriceRial: asRial(row.cash_price_rial), installmentPriceRial: row.installment_price_rial === null ? null : asRial(row.installment_price_rial),
      variants: row.variants, createdAt: row.created_at,
    })) };
  });

  app.get('/api/v1/search', async (request) => {
    const query=z.object({
      q:z.string().trim().max(200).optional(),category:z.string().max(120).optional(),brand:z.string().max(120).optional(),gender:z.string().max(80).optional(),
      season:z.string().max(80).optional(),vibe:z.string().max(100).optional(),color:z.string().max(100).optional(),size:z.string().max(50).optional(),
      minPriceRial:z.string().regex(/^\d+$/).optional(),maxPriceRial:z.string().regex(/^\d+$/).optional(),available:z.coerce.boolean().optional(),installment:z.coerce.boolean().optional(),
      discountOnly:z.coerce.boolean().optional(),minRating:z.coerce.number().min(0).max(5).optional(),attributes:z.string().max(4000).optional(),
      sort:z.enum(['relevance','newest','price_low','price_high','popular']).default('relevance'),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0),
    }).parse(request.query);
    let attrs:Record<string,string>={};try{if(query.attributes)attrs=z.record(z.string(),z.string()).parse(JSON.parse(query.attributes));}catch{throw badRequest('ویژگی‌های جست‌وجو معتبر نیستند.');}
    const q=query.q?.normalize('NFKC').replace(/[\u0000-\u001f]/g,' ').trim()||null;
    const synonym=q?await pool.query<{replacement:string}>('SELECT replacement FROM search_synonyms WHERE phrase=$1 AND active',[q.toLowerCase()]):{rows:[] as {replacement:string}[]};
    const synonymText=synonym.rows[0]?.replacement??null;
    const sortSql={relevance:'score DESC, created_at DESC',newest:'created_at DESC',price_low:'cash_price_rial ASC, created_at DESC',price_high:'cash_price_rial DESC, created_at DESC',popular:'purchase_count DESC, score DESC'}[query.sort];
    const filterSql=`p.status='published'
      AND ($2::text IS NULL OR p.category=$2) AND ($3::text IS NULL OR p.brand=$3)
      AND ($4::text IS NULL OR p.metadata->>'gender'=$4)
      AND ($5::text IS NULL OR COALESCE(p.metadata->'seasons','[]'::jsonb) ? $5)
      AND ($6::text IS NULL OR COALESCE(p.metadata->'vibes','[]'::jsonb) ? $6)
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
    const params=[q,query.category??null,query.brand??null,query.gender??null,query.season??null,query.vibe??null,query.color??null,query.size??null,query.minPriceRial??null,query.maxPriceRial??null,query.available??null,query.installment??null,query.discountOnly??null,query.minRating??null,JSON.stringify(attrs),synonymText];
    const count=await pool.query(`SELECT count(*)::int AS total FROM products p WHERE ${filterSql}`,params);
    const rows=await pool.query(`WITH matches AS (SELECT p.id,p.brand,p.name,p.category,p.description,p.cash_price_rial,p.installment_price_rial,p.metadata,p.created_at,
      COALESCE((SELECT sum(sb.on_hand-sb.reserved-sb.damaged) FROM product_variants iv JOIN stock_balances sb ON sb.variant_id=iv.id WHERE iv.product_id=p.id AND iv.active),0)::int AS available_stock,
      (SELECT count(*)::int FROM order_lines ol JOIN orders o ON o.id=ol.order_id WHERE ol.product_id=p.id AND o.status IN ('paid','processing','preparing','ready_to_ship','in_transit','shipped','delivered')) AS purchase_count,
      CASE WHEN $1::text IS NULL THEN 0::real ELSE ts_rank_cd(to_tsvector('simple',concat_ws(' ',p.name,p.brand,p.category,p.description,p.metadata::text)),plainto_tsquery('simple',$1))
        + CASE WHEN lower(p.name)=lower($1) THEN 10 ELSE 0 END + CASE WHEN lower(p.name) LIKE lower($1)||'%' THEN 3 ELSE 0 END END AS score
      FROM products p WHERE ${filterSql})
      SELECT m.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'sku',v.sku,'size',v.size_label,'color',v.color_label,'attributes',v.attributes) ORDER BY v.sku) FROM product_variants v WHERE v.product_id=m.id AND v.active),'[]'::jsonb) AS variants
      FROM matches m ORDER BY ${sortSql} LIMIT $17 OFFSET $18`,[...params,query.limit,query.offset]);
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
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const kolbeOnly = membership.limits.sources === 'kolbe';
    const rows = await pool.query(
      `SELECT p.id,p.name,p.brand,p.category,p.wholesale_price_rial,v.id AS variant_id,v.sku
       FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
       WHERE p.status = 'published' AND p.wholesale_price_rial > 0
         AND (NOT $1::boolean OR p.supplier_id IS NULL)
       ORDER BY p.created_at DESC,v.sku LIMIT $2`, [kolbeOnly, query.limit]);
    return { items: rows.rows.map((row) => ({ ...row, wholesale_price_rial: asRial(row.wholesale_price_rial) })) };
  });

  app.post('/api/v1/products', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) requirePermission(user, 'products:write');
    const body = productBody.parse(request.body);
    const cash = rial(body.cashPriceRial), installment = body.installmentPriceRial === undefined ? null : rial(body.installmentPriceRial);
    const wholesale = body.wholesalePriceRial === undefined ? null : rial(body.wholesalePriceRial);
    if (cash === 0n && (!wholesale || wholesale === 0n)) throw badRequest('دست‌کم یک قیمت معتبر لازم است.');
    if (user.roles.includes('supplier')) {
      const supplier = await one<{ cooperation_status: string }>(pool, 'SELECT cooperation_status FROM supplier_profiles WHERE user_id = $1', [user.id]);
      if (supplier?.cooperation_status !== 'approved') throw forbidden();
    }
    const productId = randomUUID();
    const metadata = { gender: body.gender ?? null, seasons: body.seasons, vibes: body.vibes, attributes: body.attributes, discountPercent: body.discountPercent ?? null };
    const result = await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [productId, user.roles.includes('supplier') ? user.id : null, body.brand, body.name, body.category, body.description,
          user.roles.includes('supplier') ? 'pending' : 'draft', cash.toString(), installment?.toString() ?? null, wholesale?.toString() ?? null, JSON.stringify(metadata)]);
      const variants = [];
      for (const variant of body.variants) {
        const seq = await one<{ id: string }>(client, "SELECT nextval('sku_sequence')::text AS id");
        const sku = `${user.roles.includes('supplier') ? 'SP' : 'KV'}-${categoryCode(body.category)}-${seq!.id}`;
        const id = randomUUID();
        await client.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,attributes) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, productId, sku, variant.size ?? null, variant.color ?? null, JSON.stringify(variant.attributes)]);
        variants.push({ id, sku });
      }
      await audit(client, user.id, 'product.created', 'product', productId, undefined, { name: body.name, variants }, request.ip);
      await outbox(client, 'product.created', 'product', productId, { productId });
      return { id: productId, status: user.roles.includes('supplier') ? 'pending' : 'draft', variants };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/products/:id/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { status } = statusBody.parse(request.body);
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
}
