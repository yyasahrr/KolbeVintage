import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, notFound } from './errors.js';
import { skuCategoryCode } from './catalog.js';
import { putFile } from './storage.js';

/* Import / migration center (docs items 37-45): structured product, inventory
   and user imports from CSV/XLSX/XLS (+ image ZIPs) with a real wizard flow:
   upload → smart mapping → dry run → background run → report + history.
   Re-running the same job never duplicates rows; re-uploading an identical
   file warns about the previous job. */

const importType = z.enum(['products', 'inventory', 'users']);
type ImportType = z.infer<typeof importType>;
const importMode = z.enum(['create_only', 'update', 'create_update']);
const matchBy = z.enum(['sku', 'legacy_id', 'email', 'phone', 'product_code']);

const MAX_ROWS = 20000;
const MAX_IMAGES_PER_ROW = 8;
const REPORT_CAP = 200;

const normalizeHeader = (value: string) => value
  .replace(/\([^)]*\)/g, '')
  .replace(/["'«»]/g, '')
  .trim().toLowerCase().replace(/[\s_\-]+/g, '');
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩';
const normalizeNumber = (value: string): string | null => {
  let out = '';
  for (const ch of value.trim()) {
    const fa = FA_DIGITS.indexOf(ch);
    if (fa >= 0) out += String(fa % 10);
    else if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === ',' || ch === '٬' || ch === '،'.normalize?.() || /\s/.test(ch)) continue;
    else return null;
  }
  return /^\d+$/.test(out) ? out : null;
};

const SYNONYMS: Record<ImportType, Record<string, string[]>> = {
  products: {
    name: ['name', 'productname', 'title', 'producttitle', 'نام', 'ناممحصول', 'عنوان', 'نامکالا'],
    brand: ['brand', 'vendor', 'manufacturer', 'برند', 'مارک', 'تولیدکننده'],
    category: ['category', 'cat', 'دسته', 'دستهبندی', 'گروه', 'گروهکالا'],
    description: ['description', 'desc', 'body', 'توضیح', 'توضیحات', 'شرح'],
    cashPrice: ['price', 'cashprice', 'retailprice', 'regularprice', 'amount', 'قیمت', 'قیمتنقدی', 'قیمتخرده', 'قیمتاصلی'],
    installmentPrice: ['installmentprice', 'installment', 'قیمتاقساطی', 'قیمتقسطی', 'اقساطی'],
    wholesalePrice: ['wholesaleprice', 'wholesale', 'قیمتعمده', 'عمده'],
    productTypeCode: ['producttype', 'producttypecode', 'type', 'نوعمحصول', 'نوع'],
    gender: ['gender', 'audience', 'جنسیت', 'مخاطب'],
    seasons: ['season', 'seasons', 'فصل', 'فصول'],
    color: ['color', 'colour', 'رنگ'],
    size: ['size', 'سایز', 'اندازه'],
    weightGrams: ['weight', 'weightgrams', 'وزن', 'وزنگرم'],
    importKey: ['legacyid', 'legacy_id', 'productcode', 'product_code', 'code', 'کد', 'کدمحصول', 'کدقدیمی', 'کدکالا'],
    sku: ['sku', 'اسکیو'],
    supplier: ['supplier', 'vendorcode', 'تأمینکننده', 'کدتأمینکننده'],
  },
  inventory: {
    sku: ['sku', 'variant', 'variantsku', 'اسکیو', 'کدکالا'],
    warehouse: ['warehouse', 'warehousecode', 'انبار', 'کدانبار'],
    quantity: ['qty', 'quantity', 'stock', 'stockcount', 'count', 'onhand', 'تعداد', 'موجودی', 'مقدار'],
    mode: ['mode', 'نوع', 'حالت'],
  },
  users: {
    displayName: ['name', 'fullname', 'displayname', 'customername', 'نام', 'نامکامل', 'نامونامخانوادگی', 'ناممشتری'],
    firstName: ['firstname', 'نامکوچک'],
    lastName: ['lastname', 'نامخانوادگی'],
    mobile: ['mobile', 'phone', 'phonenumber', 'cell', 'موبایل', 'تلفن', 'تلفنهمراه', 'شمارهتماس', 'شمارهموبایل'],
    email: ['email', 'ایمیل', 'پستالکترونیک'],
    registeredAt: ['registeredat', 'createdat', 'registerdate', 'تاریخثبتنام', 'تاریخعضویت'],
    address: ['address', 'آدرس', 'نشانی'],
    city: ['city', 'شهر'],
    postalCode: ['postalcode', 'zip', 'کدپستی'],
    level: ['level', 'segment', 'tier', 'سطح', 'سطحمشتری'],
    legacyId: ['legacyid', 'legacy_id', 'کدقدیمی', 'کد', 'کدمشتری'],
  },
};
const IMAGE_PATTERN = /^(image|img|picture|photo|تصویر|عکس)[ _-]?(\d+)?$/i;
const IMAGES_SINGLE = new Set(['images', 'imageurls', 'تصاویر', 'تصویرها', 'لینکتصاویر']);

type Mapping = Record<string, string>; // canonical field -> source header

function suggestMapping(type: ImportType, headers: string[]): { mapping: Mapping; imageHeaders: string[]; unmapped: string[] } {
  const mapping: Mapping = {};
  const imageHeaders: string[] = [];
  const unmapped: string[] = [];
  const table = SYNONYMS[type];
  for (const header of headers) {
    if (type === 'products' && (IMAGE_PATTERN.test(header) || IMAGES_SINGLE.has(normalizeHeader(header)))) {
      imageHeaders.push(header);
      continue;
    }
    const normalized = normalizeHeader(header);
    let matched: string | null = null;
    for (const [field, synonyms] of Object.entries(table)) {
      if (mapping[field]) continue;
      if (synonyms.includes(normalized)) { matched = field; break; }
    }
    if (matched) mapping[matched] = header;
    else unmapped.push(header);
  }
  return { mapping, imageHeaders, unmapped };
}

const REQUIRED_MAPPING: Record<ImportType, string[][]> = {
  products: [['name'], ['brand'], ['category'], ['cashPrice', 'wholesalePrice']],
  inventory: [['sku'], ['warehouse'], ['quantity']],
  users: [['displayName', 'firstName'], ['mobile', 'email']],
};

function stagingPath(jobId: string) {
  return join(process.cwd(), 'storage', 'private', 'import-staging', `${jobId}.zip`);
}

async function parseDataFile(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: Record<string, string>[]; format: string }> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (!['csv', 'xlsx', 'xls'].includes(ext)) throw badRequest('فرمت فایل باید CSV، XLSX یا XLS باشد.');
  const workbook = ext === 'csv'
    ? XLSX.read(buffer.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string' })
    : XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw badRequest('فایل داده‌ای ندارد.');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, { header: 1, defval: '', raw: false }) as unknown[][];
  const nonEmpty = matrix.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (nonEmpty.length < 2) throw badRequest('فایل باید دست‌کم یک سطر عنوان و یک سطر داده داشته باشد.');
  const headers = (nonEmpty[0] as unknown[]).map((cell) => String(cell ?? '').trim());
  if (new Set(headers).size !== headers.length) throw badRequest('عنوان ستون‌ها تکراری است.');
  if (headers.some((header) => header === '')) throw badRequest('عنوان ستون خالی مجاز نیست.');
  const rows = (nonEmpty.slice(1) as unknown[][]).map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = String(cells[index] ?? '').trim(); });
    return row;
  }).filter((row) => Object.values(row).some((value) => value !== ''));
  if (rows.length > MAX_ROWS) throw badRequest(`حداکثر ${MAX_ROWS} سطر در هر فایل مجاز است.`);
  return { headers, rows, format: ext };
}

type JobRow = { id: string; type: ImportType; mode: string; match_by: string; mapping: Mapping; image_headers: string[]; status: string; created_by: string | null; filename: string };

async function zipImageNames(jobId: string): Promise<Set<string>> {
  try {
    const buffer = await readFile(stagingPath(jobId));
    const zip = await JSZip.loadAsync(buffer);
    const names = new Set<string>();
    for (const path of Object.keys(zip.files)) {
      const entry = zip.files[path]!;
      if (!entry.dir && /\.(jpe?g|png|webp|gif)$/i.test(path)) names.add(path.split('/').pop()!.toLowerCase());
    }
    return names;
  } catch { return new Set(); }
}

async function zipImageBuffer(jobId: string, filename: string): Promise<Buffer | null> {
  try {
    const buffer = await readFile(stagingPath(jobId));
    const zip = await JSZip.loadAsync(buffer);
    const wanted = filename.toLowerCase();
    for (const path of Object.keys(zip.files)) {
      if (path.split('/').pop()!.toLowerCase() === wanted) {
        const data = await zip.files[path]!.async('nodebuffer');
        return Buffer.from(data);
      }
    }
    return null;
  } catch { return null; }
}

const isRemoteUrl = (value: string) => /^https?:\/\/\S{6,2000}$/i.test(value);

async function fetchRemoteImage(url: string): Promise<{ buffer: Buffer; mime: string; name: string } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
    if (!response.ok) return null;
    const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) return null;
    const name = new URL(url).pathname.split('/').pop() || 'image';
    return { buffer, mime, name };
  } catch { return null; }
}

type RowContext = {
  pool: DbPool; job: JobRow; rowNumber: number;
  raw: Record<string, string>; get: (field: string) => string;
  images: string[]; zipNames: Set<string> | null;
  actorId: string | null; dryRun: boolean;
  errors: string[]; warnings: string[];
  issuedResetToken?: string;
};

async function validateProductsRow(ctx: RowContext): Promise<{ productId?: string; variantSize?: string; variantColor?: string; weight?: number | null; images: { fileId?: string; source: string }[] } | null> {
  const { pool, job, get, images, zipNames, errors, warnings } = ctx;
  const matchByValue = job.match_by;
  if (!['sku', 'legacy_id', 'product_code'].includes(matchByValue)) { errors.push('match_by برای محصول باید یکی از sku، legacy_id یا product_code باشد.'); return null; }
  const name = get('name'), brand = get('brand'), category = get('category');
  if (!name || name.length < 2) errors.push('نام محصول (دست‌کم ۲ نویسه) لازم است.');
  if (!brand) errors.push('برند لازم است.');
  if (!category) errors.push('دسته‌بندی لازم است.');
  const cash = get('cashPrice') ? normalizeNumber(get('cashPrice')) : null;
  const installment = get('installmentPrice') ? normalizeNumber(get('installmentPrice')) : null;
  const wholesale = get('wholesalePrice') ? normalizeNumber(get('wholesalePrice')) : null;
  if (get('cashPrice') && cash === null) errors.push('قیمت نقدی عدد معتبر نیست.');
  if (get('installmentPrice') && installment === null) errors.push('قیمت اقساطی عدد معتبر نیست.');
  if (get('wholesalePrice') && wholesale === null) errors.push('قیمت عمده عدد معتبر نیست.');
  if (cash === null && wholesale === null) errors.push('دست‌کم یک قیمت معتبر لازم است.');
  const importKey = get('importKey') || null;
  // Resolve existing product.
  let existing: { id: string } | null = null;
  if (matchByValue === 'sku' && get('sku')) {
    const hit = await one<{ product_id: string }>(pool, 'SELECT product_id FROM product_variants WHERE sku = $1', [get('sku')]);
    if (hit) existing = { id: hit.product_id };
  } else if ((matchByValue === 'legacy_id' || matchByValue === 'product_code') && importKey) {
    const hit = await one<{ id: string }>(pool, 'SELECT id FROM products WHERE import_key = $1', [importKey]);
    if (hit) existing = hit;
  }
  if (job.mode === 'update' && !existing) { errors.push('محصول برای به‌روزرسانی پیدا نشد.'); }
  if (job.mode === 'create_only' && existing) { warnings.push('محصول قبلاً وجود دارد؛ در حالت فقط-ایجاد رد می‌شود.'); return { images: [] }; }
  // Type / taxonomy checks.
  let productTypeId: string | null = null;
  if (get('productTypeCode')) {
    const type = await one<{ id: string }>(pool, 'SELECT id FROM product_types WHERE code = $1 AND active = true', [get('productTypeCode')]);
    if (!type) errors.push(`نوع محصول «${get('productTypeCode')}» فعال نیست.`);
    else {
      productTypeId = type.id;
      if (get('size')) {
        const size = await one(pool, 'SELECT id FROM product_type_sizes WHERE product_type_id = $1 AND code = $2 AND active = true', [type.id, get('size')]);
        if (!size) errors.push(`سایز «${get('size')}» در نوع محصول تعریف نشده است.`);
      }
    }
  }
  if (get('gender')) {
    const gender = await one(pool, 'SELECT code FROM product_taxonomies WHERE kind = $1 AND code = $2 AND active = true', ['gender', get('gender')]);
    if (!gender) errors.push(`جنسیت «${get('gender')}» معتبر نیست.`);
  }
  for (const season of get('seasons') ? get('seasons').split(/[،,|]/).map((s) => s.trim()).filter(Boolean) : []) {
    const hit = await one(pool, 'SELECT code FROM product_taxonomies WHERE kind = $1 AND code = $2 AND active = true', ['season', season]);
    if (!hit) errors.push(`فصل «${season}» معتبر نیست.`);
  }
  let weight: number | null = null;
  if (get('weightGrams')) {
    const parsed = normalizeNumber(get('weightGrams'));
    if (parsed === null) errors.push('وزن عدد معتبر نیست.');
    else weight = Number(parsed);
  }
  let supplierId: string | null = null;
  if (get('supplier')) {
    const identity = get('supplier');
    const supplier = await one<{ id: string }>(pool,
      `SELECT u.id FROM users u JOIN supplier_profiles s ON s.user_id = u.id
       WHERE (u.phone = $1 OR u.email = $1) AND s.cooperation_status = 'approved'`, [identity]);
    if (!supplier) errors.push(`تأمین‌کننده «${identity}» تأییدشده پیدا نشد.`);
    else supplierId = supplier.id;
  }
  // Images: remote format now, reachability at apply; zip presence now.
  const resolvedImages: { fileId?: string; source: string }[] = [];
  const imageList = images.slice(0, MAX_IMAGES_PER_ROW);
  if (images.length > MAX_IMAGES_PER_ROW) warnings.push(`بیش از ${MAX_IMAGES_PER_ROW} تصویر پشتیبانی نمی‌شود؛ بقیه نادیده گرفته می‌شوند.`);
  for (const source of imageList) {
    if (isRemoteUrl(source)) resolvedImages.push({ source });
    else if (zipNames && zipNames.has(source.toLowerCase())) resolvedImages.push({ source });
    else if (zipNames) errors.push(`تصویر «${source}» نه آدرس معتبر است نه داخل فایل ZIP پیدا شد.`);
    else if (!isRemoteUrl(source)) errors.push(`تصویر «${source}» آدرس اینترنتی معتبر نیست.`);
  }
  if (errors.length > 0) return null;
  if (ctx.dryRun) return { productId: existing?.id, variantSize: get('size') || undefined, variantColor: get('color') || undefined, weight, images: resolvedImages };
  // ---- Apply ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let productId = existing?.id;
    if (!productId) {
      productId = randomUUID();
      const ownerType = supplierId ? 'supplier' : 'kolbe';
      await client.query(
        `INSERT INTO products(id,supplier_id,brand,name,category,description,status,cash_price_rial,installment_price_rial,wholesale_price_rial,
          product_type_id,owner_type,retail_enabled,wholesale_enabled,gender_code,import_key,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,'{}')`,
        [productId, supplierId, brand, name, category, get('description'), cash ?? '0', installment, wholesale,
          productTypeId, ownerType, !supplierId, true, get('gender') || null, importKey]);
      for (const season of get('seasons') ? get('seasons').split(/[،,|]/).map((s) => s.trim()).filter(Boolean) : []) {
        await client.query('INSERT INTO product_seasons(product_id, season_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, season]);
      }
    } else {
      await client.query(
        `UPDATE products SET brand = $2, name = $3, category = $4, description = COALESCE(NULLIF($5,''), description),
          cash_price_rial = COALESCE($6, cash_price_rial), installment_price_rial = COALESCE($7, installment_price_rial),
          wholesale_price_rial = COALESCE($8, wholesale_price_rial),
          product_type_id = COALESCE($9, product_type_id), gender_code = COALESCE(NULLIF($10,''), gender_code),
          version = version + 1, updated_at = now() WHERE id = $1`,
        [productId, brand, name, category, get('description'), cash, installment, wholesale, productTypeId, get('gender')]);
      if (get('seasons')) {
        await client.query('DELETE FROM product_seasons WHERE product_id = $1', [productId]);
        for (const season of get('seasons').split(/[،,|]/).map((s) => s.trim()).filter(Boolean)) {
          await client.query('INSERT INTO product_seasons(product_id, season_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [productId, season]);
        }
      }
    }
    // Variant: match by size+color or create.
    const size = get('size') || null, color = get('color') || null;
    const matched = await one<{ id: string }>(client as unknown as DbPool,
      'SELECT id FROM product_variants WHERE product_id = $1 AND size_label IS NOT DISTINCT FROM $2 AND color_label IS NOT DISTINCT FROM $3',
      [productId, size, color]);
    if (matched) {
      if (weight !== null) await client.query('UPDATE product_variants SET weight_grams = $2 WHERE id = $1', [matched.id, weight]);
    } else {
      const seq = await one<{ id: string }>(client as unknown as DbPool, "SELECT nextval('sku_sequence')::text AS id");
      await client.query('INSERT INTO product_variants(id,product_id,sku,size_label,color_label,weight_grams) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), productId, `${supplierId ? 'SP' : 'KV'}-${skuCategoryCode(category)}-${seq!.id}`, size, color, weight]);
    }
    // Images.
    const storedFileIds: string[] = [];
    for (const image of resolvedImages) {
      let buffer: Buffer | null = null;
      let originalName = image.source;
      let mime = '';
      if (isRemoteUrl(image.source)) {
        const fetched = await fetchRemoteImage(image.source);
        if (!fetched) { warnings.push(`تصویر «${image.source}» دریافت نشد؛ از قلم افتاد.`); continue; }
        buffer = fetched.buffer; mime = fetched.mime; originalName = fetched.name;
      } else {
        buffer = await zipImageBuffer(job.id, image.source);
        if (!buffer) { warnings.push(`تصویر «${image.source}» داخل ZIP پیدا نشد؛ از قلم افتاد.`); continue; }
        mime = /\.png$/i.test(image.source) ? 'image/png' : /\.gif$/i.test(image.source) ? 'image/gif' : /\.webp$/i.test(image.source) ? 'image/webp' : 'image/jpeg';
      }
      try {
        const stored = await putFile(buffer, originalName, mime);
        const fileId = randomUUID();
        const sha = createHash('sha256').update(buffer).digest('hex');
        await client.query(`INSERT INTO files(id,owner_id,storage_key,original_name,mime_type,size_bytes,sha256,visibility)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'public')`,
          [fileId, ctx.actorId, stored.storageKey, originalName.slice(0, 200), mime, buffer.length, sha]);
        storedFileIds.push(fileId);
      } catch { warnings.push(`تصویر «${image.source}» ذخیره نشد (فرمت یا حجم نامعتبر).`); }
    }
    if (storedFileIds.length > 0) {
      const meta = await one<{ metadata: { images?: { fileId: string }[] } }>(client as unknown as DbPool, 'SELECT metadata FROM products WHERE id = $1', [productId]);
      const existingImages = Array.isArray(meta?.metadata?.images) ? meta!.metadata.images! : [];
      const merged = [...existingImages, ...storedFileIds.map((fileId) => ({ fileId }))];
      await client.query('UPDATE products SET metadata = jsonb_set(COALESCE(metadata, $2), $3, $4) WHERE id = $1',
        [productId, '{}', '{images}', JSON.stringify(merged)]);
    }
    await audit(client, ctx.actorId, existing ? 'import.product_updated' : 'import.product_created', 'product', productId!,
      undefined, { jobId: job.id, row: ctx.rowNumber }, undefined);
    await client.query('COMMIT');
    return { productId: productId!, variantSize: size ?? undefined, variantColor: color ?? undefined, weight, images: resolvedImages };
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') errors.push('رکورد تکراری (کلید یکتا).');
    else errors.push(error instanceof Error ? error.message : 'خطای ذخیره‌سازی.');
    return null;
  } finally { client.release(); }
}

async function validateInventoryRow(ctx: RowContext): Promise<{ variantId?: string; warehouseId?: string } | null> {
  const { pool, job, get, errors } = ctx;
  if (job.match_by !== 'sku') { errors.push('match_by برای موجودی باید sku باشد.'); return null; }
  if (job.mode !== 'create_update') { errors.push('حالت اجرای موجودی باید create_update باشد.'); return null; }
  const sku = get('sku');
  if (!sku) { errors.push('SKU لازم است.'); return null; }
  const variant = await one<{ id: string; owner_type: string; supplier_id: string | null; retail_enabled: boolean }>(
    pool,
    'SELECT v.id, p.owner_type, p.supplier_id, p.retail_enabled FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = $1',
    [sku],
  );
  if (!variant) { errors.push(`SKU «${sku}» پیدا نشد.`); return null; }
  const warehouseCode = get('warehouse');
  if (!warehouseCode) { errors.push('کد انبار لازم است.'); return null; }
  const warehouse = await one<{ id: string; owner_id: string | null }>(pool, 'SELECT id, owner_id FROM warehouses WHERE code = $1 AND active = true', [warehouseCode]);
  if (!warehouse) { errors.push(`انبار «${warehouseCode}» فعال نیست.`); return null; }
  const domain = (variant.owner_type === 'supplier' || variant.supplier_id !== null || !variant.retail_enabled || warehouse.owner_id !== null)
    ? 'wholesale'
    : 'retail';
  const quantityRaw = normalizeNumber(get('quantity'));
  if (quantityRaw === null) { errors.push('تعداد عدد معتبر نیست.'); return null; }
  const quantity = Number(quantityRaw);
  const mode = (get('mode') || 'receipt').trim().toLowerCase();
  if (!['receipt', 'set', 'رسید', 'ثبت'].includes(mode)) { errors.push('حالت باید receipt (افزایشی) یا set (مطلق) باشد.'); return null; }
  const absolute = mode === 'set' || mode === 'ثبت';
  if (ctx.dryRun) return { variantId: variant.id, warehouseId: warehouse.id };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO stock_balances(variant_id,warehouse_id,inventory_domain) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [variant.id, warehouse.id, domain]);
    const reference = `IMP-${job.id.slice(0, 8)}-${ctx.rowNumber}`;
    if (!absolute) {
      if (quantity === 0) { await client.query('ROLLBACK'); return { variantId: variant.id, warehouseId: warehouse.id }; }
      await client.query(`UPDATE stock_balances SET incoming = incoming + $4, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
        [variant.id, warehouse.id, domain, quantity]);
      const receiptId = randomUUID();
      await client.query(`INSERT INTO stock_receipts(id,reference,receipt_number,warehouse_id,variant_id,inventory_domain,quantity,status,created_by) VALUES ($1,$2,$2,$3,$4,$5,$6,'pending',$7)
        ON CONFLICT (reference) DO NOTHING`, [receiptId, reference, warehouse.id, variant.id, domain, quantity, ctx.actorId]);
      const receipt = await one<{ id: string; status: string }>(client as unknown as DbPool, 'SELECT id, status FROM stock_receipts WHERE reference = $1', [reference]);
      if (receipt && receipt.status === 'pending') {
        await client.query(`UPDATE stock_balances SET incoming = incoming - $4, on_hand = on_hand + $4, version = version + 1 WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`,
          [variant.id, warehouse.id, domain, quantity]);
        await client.query("UPDATE stock_receipts SET status = 'received', received_at = now() WHERE id = $1", [receipt.id]);
        await client.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
          VALUES ($1,$2,$3,$4,$5,'import receipt','receipt',$6,$7,$8)`,
          [randomUUID(), variant.id, warehouse.id, domain, quantity, receipt.id, ctx.actorId, `import-receipt:${receipt.id}`]);
      }
    } else {
      const balance = await one<{ on_hand: number; reserved: number; damaged: number }>(client as unknown as DbPool,
        `SELECT on_hand, reserved, damaged FROM stock_balances WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3`, [variant.id, warehouse.id, domain]);
      const delta = quantity - (balance?.on_hand ?? 0);
      if (delta !== 0) {
        const updated = await client.query(
          `UPDATE stock_balances SET on_hand = on_hand + $4, version = version + 1, updated_at = now()
           WHERE variant_id = $1 AND warehouse_id = $2 AND inventory_domain = $3 AND on_hand + $4 >= reserved + damaged`,
          [variant.id, warehouse.id, domain, delta]);
        if (!updated.rowCount) throw new Error('تنظیم موجودی باعث منفی شدن موجودی قابل فروش می‌شود.');
        await client.query(`INSERT INTO stock_movements(id,variant_id,warehouse_id,inventory_domain,on_hand_delta,reason,reference_type,reference_id,actor_id,idempotency_key)
          VALUES ($1,$2,$3,$4,$5,$6,'adjustment',$7,$8,$9)`,
          [randomUUID(), variant.id, warehouse.id, domain, delta, `import set ${quantity}`, reference, ctx.actorId, `import-set:${job.id}:${ctx.rowNumber}`]);
      }
    }
    await audit(client, ctx.actorId, 'import.inventory_applied', 'variant', variant.id, undefined, { jobId: job.id, row: ctx.rowNumber, quantity }, undefined);
    await client.query('COMMIT');
    return { variantId: variant.id, warehouseId: warehouse.id };
  } catch (error) {
    await client.query('ROLLBACK');
    errors.push(error instanceof Error ? error.message : 'خطای ذخیره‌سازی.');
    return null;
  } finally { client.release(); }
}

async function validateUsersRow(ctx: RowContext): Promise<{ userId?: string; created: boolean; resetToken?: string } | null> {
  const { pool, job, get, errors, warnings } = ctx;
  if (!['email', 'phone', 'legacy_id'].includes(job.match_by)) { errors.push('match_by برای کاربر باید یکی از email، phone یا legacy_id باشد.'); return null; }
  const displayName = get('displayName') || [get('firstName'), get('lastName')].filter(Boolean).join(' ').trim();
  if (!displayName || displayName.length < 2) errors.push('نام (دست‌کم ۲ نویسه) لازم است.');
  const mobile = get('mobile') || null;
  const email = get('email') ? get('email').toLowerCase() : null;
  if (mobile && !/^09\d{9}$/.test(mobile)) errors.push('شماره موبایل معتبر نیست.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('ایمیل معتبر نیست.');
  if (!mobile && !email) errors.push('دست‌کم موبایل یا ایمیل لازم است.');
  const legacyId = get('legacyId') || null;
  let registeredAt: string | null = null;
  if (get('registeredAt')) {
    const parsed = new Date(get('registeredAt').replace(/\//g, '-'));
    if (Number.isNaN(parsed.getTime())) errors.push('تاریخ ثبت‌نام معتبر نیست.');
    else registeredAt = parsed.toISOString();
  }
  let existing: { id: string } | null = null;
  if (job.match_by === 'email' && email) existing = await one(pool, 'SELECT id FROM users WHERE email = $1', [email]);
  else if (job.match_by === 'phone' && mobile) existing = await one(pool, 'SELECT id FROM users WHERE phone = $1', [mobile]);
  else if (job.match_by === 'legacy_id' && legacyId) existing = await one(pool, 'SELECT id FROM users WHERE import_key = $1', [legacyId]);
  if (job.mode === 'update' && !existing) errors.push('کاربر برای به‌روزرسانی پیدا نشد.');
  if (job.mode === 'create_only' && existing) { warnings.push('کاربر قبلاً وجود دارد؛ در حالت فقط-ایجاد رد می‌شود.'); return { created: false }; }
  if (errors.length > 0) return null;
  if (ctx.dryRun) return { userId: existing?.id, created: !existing };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let userId = existing?.id;
    let created = false;
    let resetToken: string | undefined;
    if (!userId) {
      userId = randomUUID();
      created = true;
      // Item 45: legacy passwords are NEVER imported — not even hashed. The
      // account gets an unusable random secret and must be activated via a
      // one-time reset token (returned once in the import report).
      const unusable = await argon2.hash(randomBytes(32).toString('base64url'), { type: argon2.argon2id });
      await client.query(
        `INSERT INTO users(id,phone,email,password_hash,display_name,import_key,must_reset_password,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,true,COALESCE($7, now()))`,
        [userId, mobile, email, unusable, displayName, legacyId, registeredAt]);
      await client.query('INSERT INTO user_roles(user_id, role_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, 'customer']);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await client.query(`INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_by) VALUES ($1,$2,$3,now() + interval '72 hours',$4)`,
        [randomUUID(), userId, tokenHash, ctx.actorId]);
      resetToken = token;
      ctx.issuedResetToken = token;
      if (get('level')) {
        await client.query(`INSERT INTO crm_contacts(id,user_id,segment) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET segment = $3, updated_at = now()`,
          [randomUUID(), userId, get('level').slice(0, 120)]);
      }
      if (get('address') && get('city') && mobile && get('postalCode') && /^\d{10}$/.test(get('postalCode'))) {
        await client.query(`INSERT INTO customer_addresses(id,user_id,title,recipient,phone,province,city,line,postal_code,is_default)
          VALUES ($1,$2,'imported',$3,$4,$5,$6,$7,$8,true)`,
          [randomUUID(), userId, displayName.slice(0, 120), mobile, get('city').slice(0, 120), get('city').slice(0, 120), get('address').slice(0, 500), get('postalCode')]);
      } else if (get('address') || get('city')) {
        warnings.push('نشانی ناقص است (نشانی، شهر، موبایل و کدپستی ۱۰رقمی لازم است)؛ بدون نشانی وارد شد.');
      }
    } else {
      await client.query('UPDATE users SET display_name = $2, import_key = COALESCE($3, import_key), updated_at = now() WHERE id = $1',
        [userId, displayName, legacyId]);
      if (get('level')) {
        await client.query(`INSERT INTO crm_contacts(id,user_id,segment) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET segment = $3, updated_at = now()`,
          [randomUUID(), userId, get('level').slice(0, 120)]);
      }
    }
    await audit(client, ctx.actorId, created ? 'import.user_created' : 'import.user_updated', 'user', userId!, undefined, { jobId: job.id, row: ctx.rowNumber }, undefined);
    await client.query('COMMIT');
    return { userId: userId!, created, resetToken };
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') errors.push('رکورد تکراری (ایمیل/موبایل/کد قدیمی).');
    else errors.push(error instanceof Error ? error.message : 'خطای ذخیره‌سازی.');
    return null;
  } finally { client.release(); }
}

/* ---------- Background runner (item 44) ---------- */
const runningJobs = new Set<string>();

async function processJob(pool: DbPool, jobId: string) {
  if (runningJobs.has(jobId)) return;
  runningJobs.add(jobId);
  try {
    const job = await one<JobRow & { mapping: Mapping; image_headers: string[] }>(pool, 'SELECT * FROM import_jobs WHERE id = $1', [jobId]);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    await pool.query("UPDATE import_jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1", [jobId]);
    const zipNames = job.filename.toLowerCase().endsWith('.zip') ? await zipImageNames(jobId) : null;
    const storedMapping = job.mapping as unknown as { mapping: Mapping; imageHeaders: string[] };
    const fieldMap = storedMapping.mapping ?? {};
    const jobImageHeaders = storedMapping.imageHeaders ?? [];
    const resetTokens: { row: number; token: string }[] = [];
    const batchSize = 50;
    for (;;) {
      const current = await one<{ status: string }>(pool, 'SELECT status FROM import_jobs WHERE id = $1', [jobId]);
      if (!current || current.status !== 'running') break; // cancelled or taken over
      const batch = await pool.query<{ row_number: number; data: Record<string, string> }>(
        `SELECT row_number, data FROM import_job_rows WHERE job_id = $1 AND status = 'pending' ORDER BY row_number LIMIT $2`, [jobId, batchSize]);
      if (batch.rows.length === 0) break;
      for (const item of batch.rows) {
        const ctx: RowContext = {
          pool, job: job as JobRow, rowNumber: item.row_number, raw: item.data,
          get: (field) => {
            const header = fieldMap[field];
            if (!header) return '';
            const value = item.data[header];
            return value === undefined || value === null ? '' : String(value);
          },
          images: jobImageHeaders.flatMap((header) => {
            const value = item.data[header];
            if (value === undefined || value === null || String(value).trim() === '') return [];
            if (IMAGES_SINGLE.has(normalizeHeader(header))) return String(value).split(/[,،\n|]/).map((s) => s.trim()).filter(Boolean);
            return [String(value).trim()];
          }),
          zipNames, actorId: job.created_by, dryRun: false, errors: [], warnings: [],
        };
        try {
          if (job.type === 'products') await validateProductsRow(ctx);
          else if (job.type === 'inventory') await validateInventoryRow(ctx);
          else await validateUsersRow(ctx);
        } catch (error) {
          ctx.errors.push(error instanceof Error ? error.message : 'خطای غیرمنتظره.');
        }
        // One-time activation tokens for imported users (item 45).
        if (ctx.issuedResetToken && resetTokens.length < 5000) {
          resetTokens.push({ row: item.row_number, token: ctx.issuedResetToken });
        }
        const status = ctx.errors.length > 0 ? 'failed' : 'ok';
        const message = ctx.errors.length > 0 ? ctx.errors.join(' | ') : ctx.warnings.join(' | ') || null;
        await pool.query('UPDATE import_job_rows SET status = $2, message = $3 WHERE job_id = $1 AND row_number = $4',
          [jobId, status, message, item.row_number]);
        await pool.query(
          `UPDATE import_jobs SET processed_rows = processed_rows + 1,
            succeeded_rows = succeeded_rows + $2, failed_rows = failed_rows + $3,
            warning_rows = warning_rows + $4, updated_at = now() WHERE id = $1`,
          [jobId, status === 'ok' ? 1 : 0, status === 'failed' ? 1 : 0, status === 'ok' && ctx.warnings.length > 0 ? 1 : 0]);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const failed = await pool.query<{ row_number: number; message: string | null }>(
      `SELECT row_number, message FROM import_job_rows WHERE job_id = $1 AND status = 'failed' ORDER BY row_number`, [jobId]);
    const warned = await pool.query<{ row_number: number; message: string | null }>(
      `SELECT row_number, message FROM import_job_rows WHERE job_id = $1 AND status = 'ok' AND message IS NOT NULL ORDER BY row_number LIMIT ${REPORT_CAP}`, [jobId]);
    const errorCsv = ['row,message', ...failed.rows.map((row) => `${row.row_number},"${String(row.message ?? '').replace(/"/g, '""')}"`)].join('\n');
    const finished = await one<{ status: string; processed_rows: number; total_rows: number }>(pool,
      'SELECT status, processed_rows, total_rows FROM import_jobs WHERE id = $1', [jobId]);
    if (finished && finished.status === 'running') {
      const done = finished.processed_rows >= finished.total_rows;
      await pool.query(
        `UPDATE import_jobs SET status = $2, finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE finished_at END,
          report = report || $3, error_csv = $4, updated_at = now() WHERE id = $1`,
        [jobId, done ? 'done' : 'failed',
          JSON.stringify({
            errors: failed.rows.slice(0, REPORT_CAP).map((row) => ({ row: row.row_number, message: row.message })),
            warnings: warned.rows.map((row) => ({ row: row.row_number, message: row.message })),
            ...(resetTokens.length > 0 ? { resetTokens } : {}),
          }), errorCsv]);
      await transaction(pool, (client) => audit(client, null, 'import.job_finished', 'import_job', jobId, undefined, { status: done ? 'done' : 'failed' }, undefined));
    }
  } finally {
    runningJobs.delete(jobId);
  }
}

export function registerImportRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/admin/imports/upload', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const meta = z.object({
      type: importType,
      mode: importMode.default('create_update'),
      matchBy: matchBy.default('legacy_id'),
    }).parse({
      type: (request.query as Record<string, string>).type,
      mode: (request.query as Record<string, string>).mode,
      matchBy: (request.query as Record<string, string>).matchBy,
    });
    if (meta.type === 'inventory' && (meta.matchBy !== 'sku' || meta.mode !== 'create_update'))
      throw badRequest('موجودی فقط با match_by=sku و mode=create_update وارد می‌شود.');
    if (meta.type === 'products' && !['sku', 'legacy_id', 'product_code'].includes(meta.matchBy))
      throw badRequest('محصول فقط با match_by از جنس sku، legacy_id یا product_code وارد می‌شود.');
    if (meta.type === 'users' && !['email', 'phone', 'legacy_id'].includes(meta.matchBy))
      throw badRequest('کاربر فقط با match_by از جنس email، phone یا legacy_id وارد می‌شود.');
    const file = await request.file();
    if (!file) throw badRequest('فایل ارسال نشده است.');
    const filename = file.filename || 'upload.bin';
    const ext = filename.toLowerCase().split('.').pop() ?? '';
    if (!['csv', 'xlsx', 'xls', 'zip'].includes(ext)) throw badRequest('فرمت فایل باید CSV، XLSX، XLS یا ZIP باشد.');
    const buffer = await file.toBuffer();
    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) throw badRequest('حجم فایل باید بین ۱ بایت تا ۱۰ مگابایت باشد.');
    const fileSha256 = createHash('sha256').update(buffer).digest('hex');
    let dataBuffer = buffer;
    let dataFilename = filename;
    let dataFormat = ext;
    if (ext === 'zip') {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.keys(zip.files).filter((path) => !zip.files[path]!.dir);
      const dataEntry = entries.find((path) => /\.(csv|xlsx|xls)$/i.test(path));
      if (!dataEntry) throw badRequest('داخل ZIP فایل داده (CSV/XLSX/XLS) پیدا نشد.');
      dataBuffer = Buffer.from(await zip.files[dataEntry]!.async('nodebuffer'));
      dataFilename = dataEntry.split('/').pop()!;
      dataFormat = dataFilename.toLowerCase().split('.').pop()!;
    }
    const parsed = await parseDataFile(dataBuffer, dataFilename);
    const { mapping, imageHeaders, unmapped } = suggestMapping(meta.type, parsed.headers);
    const requiredMissing = REQUIRED_MAPPING[meta.type]
      .filter((group) => !group.some((field) => mapping[field]))
      .map((group) => group.join(' یا '));
    const jobId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO import_jobs(id,type,filename,format,mode,match_by,mapping,status,total_rows,report,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10)`,
        [jobId, meta.type, filename, dataFormat, meta.mode, meta.matchBy, JSON.stringify({ mapping, imageHeaders }),
          parsed.rows.length, JSON.stringify({ fileSha256, unmapped }), user.id]);
      for (const [index, row] of parsed.rows.entries()) {
        await client.query('INSERT INTO import_job_rows(job_id,row_number,data) VALUES ($1,$2,$3)',
          [jobId, index + 2, JSON.stringify(row)]);
      }
      await audit(client, user.id, 'import.job_created', 'import_job', jobId, undefined,
        { type: meta.type, filename, rows: parsed.rows.length }, request.ip);
    });
    if (ext === 'zip') {
      await mkdir(join(process.cwd(), 'storage', 'private', 'import-staging'), { recursive: true });
      await writeFile(stagingPath(jobId), buffer);
    }
    const previous = await pool.query<{ id: string; filename: string; created_at: string }>(
      `SELECT id, filename, created_at FROM import_jobs WHERE id <> $1 AND report->>'fileSha256' = $2 ORDER BY created_at DESC LIMIT 3`,
      [jobId, fileSha256]);
    return reply.code(201).send({
      jobId, type: meta.type, mode: meta.mode, matchBy: meta.matchBy, format: dataFormat,
      totalRows: parsed.rows.length, headers: parsed.headers, mapping, imageHeaders, unmapped,
      requiredMissing, preview: parsed.rows.slice(0, 5),
      duplicateWarning: previous.rows.length > 0
        ? { message: 'این فایل قبلاً وارد شده است؛ اجرای مجدد ممکن است داده تکراری بسازد.', jobs: previous.rows } : null,
    });
  });

  app.get('/api/v1/admin/imports', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const rows = await pool.query(
      `SELECT j.id, j.type, j.filename, j.format, j.mode, j.match_by, j.status, j.total_rows, j.processed_rows,
              j.succeeded_rows, j.failed_rows, j.warning_rows, j.created_at, j.started_at, j.finished_at,
              u.display_name AS created_by_name,
              EXTRACT(EPOCH FROM (COALESCE(j.finished_at, now()) - j.created_at))::int AS duration_seconds
       FROM import_jobs j LEFT JOIN users u ON u.id = j.created_by
       ORDER BY j.created_at DESC LIMIT $1`, [query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/imports/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await one(pool, 'SELECT * FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw notFound();
    return job;
  });

  app.put('/api/v1/admin/imports/:id/mapping', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ mapping: z.record(z.string(), z.string().min(1).max(200)), imageHeaders: z.array(z.string().min(1).max(200)).max(30).default([]) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const job = await one<JobRow & { mapping: { mapping: Mapping; imageHeaders: string[] } }>(client, 'SELECT * FROM import_jobs WHERE id = $1 FOR UPDATE', [id]);
      if (!job) throw notFound();
      if (job.status !== 'queued') throw conflict('نگاشت فقط پیش از اجرا قابل تغییر است.');
      const knownFields = new Set(Object.keys(SYNONYMS[job.type as ImportType]));
      for (const field of Object.keys(body.mapping)) {
        if (!knownFields.has(field)) throw badRequest(`فیلد «${field}» برای این نوع ورود شناخته‌شده نیست.`);
      }
      const headers = new Set(Object.keys(((await client.query('SELECT data FROM import_job_rows WHERE job_id = $1 LIMIT 1', [id])).rows[0]?.data ?? {})));
      for (const header of [...Object.values(body.mapping), ...body.imageHeaders]) {
        if (!headers.has(header)) throw badRequest(`ستون «${header}» در فایل وجود ندارد.`);
      }
      await client.query('UPDATE import_jobs SET mapping = $2, updated_at = now() WHERE id = $1',
        [id, JSON.stringify({ mapping: body.mapping, imageHeaders: body.imageHeaders })]);
      await audit(client, user.id, 'import.mapping_updated', 'import_job', id, undefined, body, request.ip);
      return { jobId: id, mapping: body.mapping, imageHeaders: body.imageHeaders };
    });
  });

  app.post('/api/v1/admin/imports/:id/dry-run', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await one<JobRow & { mapping: { mapping: Mapping; imageHeaders: string[] } }>(pool, 'SELECT * FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw notFound();
    if (job.status !== 'queued') throw conflict('بررسی آزمایشی فقط پیش از اجرا مجاز است.');
    const mapping = (job.mapping as unknown as { mapping: Mapping; imageHeaders: string[] }).mapping ?? {};
    const imageHeaders = (job.mapping as unknown as { mapping: Mapping; imageHeaders: string[] }).imageHeaders ?? [];
    const requiredMissing = REQUIRED_MAPPING[job.type as ImportType].filter((group) => !group.some((field) => mapping[field]));
    if (requiredMissing.length > 0) throw badRequest(`نگاشت ناقص است: ${requiredMissing.map((group) => group.join(' یا ')).join('؛ ')}`);
    const zipNames = job.filename.toLowerCase().endsWith('.zip') ? await zipImageNames(id) : null;
    const stored = await pool.query<{ row_number: number; data: Record<string, string> }>(
      'SELECT row_number, data FROM import_job_rows WHERE job_id = $1 ORDER BY row_number', [id]);
    // Duplicate detection within the file (item 41).
    const seen = new Map<string, number>();
    let valid = 0, warnings = 0, errors = 0;
    const errorList: { row: number; message: string }[] = [];
    const warningList: { row: number; message: string }[] = [];
    for (const item of stored.rows) {
      const get = (field: string) => {
        const header = mapping[field];
        if (!header) return '';
        const value = item.data[header];
        return value === undefined || value === null ? '' : String(value);
      };
      const images = imageHeaders.flatMap((header) => {
        const value = item.data[header];
        if (value === undefined || value === null || String(value).trim() === '') return [];
        if (IMAGES_SINGLE.has(normalizeHeader(header))) return String(value).split(/[,،\n|]/).map((s) => s.trim()).filter(Boolean);
        return [String(value).trim()];
      });
      const ctx: RowContext = {
        pool, job: { ...job, mapping } as JobRow, rowNumber: item.row_number, raw: item.data, get,
        images, zipNames, actorId: user.id, dryRun: true, errors: [], warnings: [],
      };
      try {
        if (job.type === 'products') await validateProductsRow(ctx);
        else if (job.type === 'inventory') await validateInventoryRow(ctx);
        else await validateUsersRow(ctx);
      } catch (error) {
        ctx.errors.push(error instanceof Error ? error.message : 'خطای غیرمنتظره.');
      }
      const matchValue = job.type === 'products'
        ? (job.match_by === 'sku' ? get('sku') : get('importKey')) || `${get('brand')}|${get('name')}|${get('color')}|${get('size')}`
        : job.type === 'inventory' ? `${get('sku')}|${get('warehouse')}`
          : job.match_by === 'email' ? get('email').toLowerCase() : job.match_by === 'phone' ? get('mobile') : get('legacyId');
      if (matchValue) {
        if (seen.has(matchValue)) ctx.errors.push(`سطر تکراری داخل فایل (مشابه سطر ${seen.get(matchValue)}).`);
        else seen.set(matchValue, item.row_number);
      }
      if (ctx.errors.length > 0) {
        errors += 1;
        if (errorList.length < REPORT_CAP) errorList.push({ row: item.row_number, message: ctx.errors.join(' | ') });
      } else {
        valid += 1;
        if (ctx.warnings.length > 0) {
          warnings += 1;
          if (warningList.length < REPORT_CAP) warningList.push({ row: item.row_number, message: ctx.warnings.join(' | ') });
        }
      }
    }
    const dryRun = { at: new Date().toISOString(), total: stored.rows.length, valid, warnings, errors };
    await pool.query('UPDATE import_jobs SET report = report || $2, updated_at = now() WHERE id = $1',
      [id, JSON.stringify({ dryRun, dryRunErrors: errorList, dryRunWarnings: warningList })]);
    await transaction(pool, (client) => audit(client, user.id, 'import.dry_run', 'import_job', id, undefined, dryRun, request.ip));
    return { jobId: id, ...dryRun, errorSample: errorList.slice(0, 20) };
  });

  app.post('/api/v1/admin/imports/:id/run', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await one<{ status: string; updated_at: string }>(pool, 'SELECT status, updated_at FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw notFound();
    const staleRunning = job.status === 'running' && (Date.now() - new Date(job.updated_at).getTime() > 10 * 60_000);
    if (job.status !== 'queued' && !staleRunning) throw conflict('این کار در حال اجرا یا اجرا شده است.');
    if (staleRunning) await pool.query("UPDATE import_jobs SET status = 'queued', updated_at = now() WHERE id = $1", [id]);
    await transaction(pool, (client) => audit(client, user.id, 'import.job_started', 'import_job', id, undefined, undefined, request.ip));
    setImmediate(() => { void processJob(pool, id); });
    return reply.code(202).send({ jobId: id, status: 'running' });
  });

  app.post('/api/v1/admin/imports/:id/retry', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await one<{ status: string }>(pool, 'SELECT status FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw notFound();
    if (job.status !== 'done' && job.status !== 'failed' && job.status !== 'cancelled') throw conflict('تلاش مجدد فقط پس از پایان یا لغو مجاز است.');
    await transaction(pool, async (client) => {
      const reset = await client.query("UPDATE import_job_rows SET status = 'pending', message = NULL WHERE job_id = $1 AND status = 'failed'", [id]);
      await client.query(
        `UPDATE import_jobs SET status = 'queued', processed_rows = processed_rows - $2, failed_rows = 0, finished_at = NULL, updated_at = now() WHERE id = $1`,
        [id, reset.rowCount ?? 0]);
      await audit(client, user.id, 'import.job_retry', 'import_job', id, undefined, { rows: reset.rowCount ?? 0 }, request.ip);
    });
    setImmediate(() => { void processJob(pool, id); });
    return reply.code(202).send({ jobId: id, status: 'running' });
  });

  app.post('/api/v1/admin/imports/:id/cancel', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const updated = await pool.query("UPDATE import_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND status IN ('queued','running') RETURNING id", [id]);
    if (!updated.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'import.job_cancelled', 'import_job', id, undefined, undefined, request.ip));
    return { jobId: id, status: 'cancelled' };
  });

  app.get('/api/v1/admin/imports/:id/errors.csv', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await one<{ error_csv: string | null; filename: string }>(pool, 'SELECT error_csv, filename FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw notFound();
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="import-${id}-errors.csv"`)
      .send('\uFEFF' + (job.error_csv ?? 'row,message\n'));
  });

  app.delete('/api/v1/admin/imports/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'imports:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const deleted = await pool.query("DELETE FROM import_jobs WHERE id = $1 AND status <> 'running' RETURNING id", [id]);
    if (!deleted.rows[0]) throw notFound();
    await unlink(stagingPath(id)).catch(() => {});
    await transaction(pool, (client) => audit(client, user.id, 'import.job_deleted', 'import_job', id, undefined, undefined, request.ip));
    return { jobId: id, deleted: true };
  });
}
