import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors.js';
import { putFile } from './storage.js';
import { snapshotSupplierVersion } from './suppliers.js';
import { commerceProductsByIds, queryCommerceProducts } from './commerce-view.js';

/* ============================ Product types & adaptive spec templates (Req 4-9, 122-126, 325-326) ============================ */

export type SpecField = { code: string; label: string; group: string; fieldType: 'text' | 'number' | 'select' | 'multiselect' | 'boolean'; options: string[];
  required: boolean; filterable: boolean; unit?: string };
export type SizeDef = { code: string; label: string; position: number; active: boolean };

/** Server-side validation of values entered in the generated product form. */
export function validateSpecifications(template: SpecField[], values: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const field of template) {
    const value = values[field.code];
    const missing = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    if (missing) { if (field.required) throw badRequest(`فیلد «${field.label}» الزامی است.`); continue; }
    if (field.fieldType === 'number') {
      if (!/^\d+(\.\d+)?$/.test(String(value))) throw badRequest(`«${field.label}» باید عدد باشد.`);
      clean[field.code] = Number(value);
    } else if (field.fieldType === 'boolean') {
      if (typeof value !== 'boolean') throw badRequest(`«${field.label}» باید بله/خیر باشد.`);
      clean[field.code] = value;
    } else if (field.fieldType === 'select') {
      if (field.options.length && !field.options.includes(String(value))) throw badRequest(`مقدار «${field.label}» در گزینه‌های مجاز نیست.`);
      clean[field.code] = String(value);
    } else if (field.fieldType === 'multiselect') {
      const list = Array.isArray(value) ? value.map(String) : [String(value)];
      if (field.options.length && list.some((item) => !field.options.includes(item))) throw badRequest(`مقدار «${field.label}» در گزینه‌های مجاز نیست.`);
      clean[field.code] = list;
    } else {
      if (String(value).length > 2000 || /<[a-z!/]/i.test(String(value))) throw badRequest(`مقدار «${field.label}» معتبر نیست.`);
      clean[field.code] = String(value).trim();
    }
  }
  for (const key of Object.keys(values)) {
    if (!template.some((f) => f.code === key) && !key.startsWith('extra_')) throw badRequest(`فیلد «${key}» در قالب این نوع محصول تعریف نشده است.`);
    if (key.startsWith('extra_')) clean[key] = String(values[key]).slice(0, 500);
  }
  return clean;
}

const specFieldSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{2,40}$/), label: z.string().trim().min(1).max(80), group: z.string().trim().max(60).default('مشخصات'),
  fieldType: z.enum(['text', 'number', 'select', 'multiselect', 'boolean']), options: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  required: z.boolean().default(false), filterable: z.boolean().default(false), unit: z.string().max(20).optional(),
}).strict();
const sizeSchema = z.object({ code: z.string().trim().min(1).max(12), label: z.string().trim().min(1).max(20), position: z.number().int().min(0).max(1000), active: z.boolean() }).strict();

/* ============================ Avatar validation (Req 334) ============================ */

export const AVATAR_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export function sniffImage(buffer: Buffer): { mime: (typeof AVATAR_MIME)[number]; width: number; height: number } | null {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1]!;
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    return { mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const b = buffer.readUInt32LE(21); return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    return { mime: 'image/webp', width: 0, height: 0 };
  }
  return null;
}

export function validateAvatar(buffer: Buffer, declaredMime: string) {
  if (!(AVATAR_MIME as readonly string[]).includes(declaredMime)) throw badRequest('فقط تصاویر JPG، PNG و WebP مجاز هستند.');
  if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) throw badRequest('حجم تصویر پروفایل باید کمتر از ۲ مگابایت باشد.');
  const sniffed = sniffImage(buffer);
  if (!sniffed || sniffed.mime !== declaredMime) throw badRequest('محتوای فایل با نوع اعلام‌شده مطابقت ندارد.');
  if (sniffed.width && sniffed.height && (sniffed.width < 64 || sniffed.height < 64 || sniffed.width > 4096 || sniffed.height > 4096)) {
    throw badRequest('ابعاد تصویر باید بین ۶۴ تا ۴۰۹۶ پیکسل باشد.');
  }
  return sniffed;
}

/* ============================ Supplier approval policy (Req 339-341) ============================ */

export const SUPPLIER_SENSITIVE_FIELDS: Record<string, { column: string; label: string }> = {
  legalName: { column: 'legal_name', label: 'نام حقوقی' },
  nationalId: { column: 'national_id', label: 'شناسه ملی' },
  registrationNumber: { column: 'registration_number', label: 'شماره ثبت' },
  economicCode: { column: 'economic_code', label: 'کد اقتصادی' },
  taxInfo: { column: 'tax_info', label: 'اطلاعات مالیاتی' },
  bankName: { column: 'bank_name', label: 'نام بانک' },
  accountNumber: { column: 'account_number', label: 'شماره حساب' },
  bankIban: { column: 'bank_iban', label: 'شماره شبا' },
  accountHolder: { column: 'account_holder', label: 'صاحب حساب' },
};

export function supplierDiff(current: Record<string, unknown>, proposed: Record<string, string | null>) {
  return Object.entries(proposed)
    .filter(([key]) => SUPPLIER_SENSITIVE_FIELDS[key])
    .map(([key, value]) => ({ field: key, label: SUPPLIER_SENSITIVE_FIELDS[key]!.label, oldValue: (current[SUPPLIER_SENSITIVE_FIELDS[key]!.column] as string | null) ?? null, newValue: value }))
    .filter((entry) => (entry.oldValue ?? '') !== (entry.newValue ?? ''));
}

export function loyaltyTier(points: number) {
  if (points >= 2000) return { code: 'gold', label: 'طلایی', next: null as number | null };
  if (points >= 500) return { code: 'silver', label: 'نقره‌ای', next: 2000 };
  return { code: 'classic', label: 'کلاسیک', next: 500 };
}

/* ============================ OTP helpers (Req 336-337) ============================ */

const otpHash = (config: Config, id: string, code: string) => createHash('sha256').update(`${id}:${code}:${config.JWT_SECRET}`).digest('hex');

async function issueOtp(client: PoolClient, config: Config, userId: string, channel: 'phone' | 'email' | 'password' | '2fa', target: string, deliverTo: string | null) {
  await client.query(`UPDATE contact_change_requests SET status = 'cancelled' WHERE user_id = $1 AND channel = $2 AND status = 'pending'`, [userId, channel]);
  const id = randomUUID();
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await client.query(`INSERT INTO contact_change_requests(id,user_id,channel,new_value,otp_code_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, channel, target, otpHash(config, id, code), expiresAt]);
  const eventType = channel === 'email' ? 'profile.email_verification' : 'profile.otp';
  await outbox(client, eventType, 'user', userId, { requestId: id, channel }); // never the code itself
  if (channel !== 'email' && deliverTo && /^09\d{9}$/.test(deliverTo)) {
    const event = await one<{ id: string }>(client, `SELECT id FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at DESC LIMIT 1`, [eventType, userId]);
    await client.query('INSERT INTO sms_deliveries(id,event_id,user_id,phone,message) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING',
      [randomUUID(), event!.id, userId, deliverTo, `کلبه وینتیج — کد تأیید شما: ${code} (اعتبار ۱۰ دقیقه)`]);
  }
  return { requestId: id, expiresAt: expiresAt.toISOString(), devCode: config.NODE_ENV === 'production' ? undefined : code };
}

async function consumeOtp(pool: DbPool, config: Config, userId: string, requestId: string, code: string, channel: string) {
  const outcome = await transaction(pool, async (client) => {
    const row = await one<{ id: string; new_value: string; status: string; expires_at: string; attempts: number; otp_code_hash: string; channel: string }>(client,
      'SELECT * FROM contact_change_requests WHERE id = $1 AND user_id = $2 FOR UPDATE', [requestId, userId]);
    if (!row || row.channel !== channel) return { error: 'درخواست تأیید یافت نشد.' };
    if (row.status !== 'pending') return { error: 'این کد قبلاً استفاده یا لغو شده است.' };
    if (new Date(row.expires_at) < new Date()) { await client.query(`UPDATE contact_change_requests SET status = 'expired' WHERE id = $1`, [row.id]); return { error: 'کد منقضی شده است؛ دوباره درخواست دهید.' }; }
    if (row.attempts >= 5) return { error: 'تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید درخواست دهید.' };
    const expected = Buffer.from(row.otp_code_hash, 'hex');
    const actual = Buffer.from(otpHash(config, row.id, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      await client.query('UPDATE contact_change_requests SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return { error: 'کد واردشده صحیح نیست.' };
    }
    await client.query(`UPDATE contact_change_requests SET status = 'verified', verified_at = now() WHERE id = $1`, [row.id]);
    return { value: row.new_value };
  });
  if ('error' in outcome) throw badRequest(outcome.error!);
  return outcome.value;
}

async function readUpload(request: FastifyRequest): Promise<{ buffer: Buffer; mime: string; name: string }> {
  try {
    const file = await (request as unknown as { file?: () => Promise<{ file: AsyncIterable<Buffer>; mimetype: string; filename: string } | undefined> }).file?.();
    if (file) {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of file.file) { size += chunk.length; if (size > AVATAR_MAX_BYTES) throw badRequest('حجم تصویر پروفایل باید کمتر از ۲ مگابایت باشد.'); chunks.push(chunk); }
      return { buffer: Buffer.concat(chunks), mime: file.mimetype, name: file.filename };
    }
  } catch (error) { if ((error as { statusCode?: number }).statusCode === 400) throw error; }
  const body = z.object({ dataBase64: z.string().max(3_000_000), mime: z.string().max(40), name: z.string().max(120).default('avatar') }).strict().parse(request.body);
  return { buffer: Buffer.from(body.dataBase64, 'base64'), mime: body.mime, name: body.name };
}

const ACTIVE_ORDER = ['pending_payment', 'paid', 'processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped'];

function orderTimeline(order: { status: string; created_at: string; paid_at: string | null }, events: { to_status: string; created_at: string }[]) {
  const at = (statuses: string[]) => events.find((e) => statuses.includes(e.to_status))?.created_at ?? null;
  const rank = ['pending_payment', 'paid', 'processing', 'preparing', 'ready_to_ship', 'in_transit', 'shipped', 'delivered'].indexOf(order.status);
  return [
    { key: 'placed', label: 'ثبت سفارش', done: true, at: order.created_at },
    { key: 'paid', label: 'پرداخت', done: rank >= 1, at: order.paid_at ?? at(['paid']) },
    { key: 'preparing', label: 'آماده‌سازی', done: rank >= 2, at: at(['processing', 'preparing', 'ready_to_ship']) },
    { key: 'shipped', label: 'ارسال', done: rank >= 5, at: at(['in_transit', 'shipped']) },
    { key: 'delivered', label: 'تحویل', done: rank >= 7, at: at(['delivered']) },
  ];
}

/* ============================ Routes ============================ */

export function registerProfileRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ---------- Product types ---------- */
  app.get('/api/v1/product-types', async () => {
    const rows = await pool.query('SELECT id, code, name, description, sizes, spec_template, size_guide_template, position FROM product_types WHERE active ORDER BY position, name');
    return { items: rows.rows.map((row: Record<string, unknown>) => ({ ...row,
      sizes: ((row.sizes as SizeDef[]) ?? []).filter((s) => s.active).sort((a, b) => a.position - b.position) })) };
  });

  app.get('/api/v1/admin/product-types', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    return { items: (await pool.query(`SELECT t.*, (SELECT count(*)::int FROM products p WHERE p.product_type_code = t.code) AS product_count
      FROM product_types t ORDER BY position, name`)).rows };
  });

  const typeBody = z.object({
    code: z.string().regex(/^[a-z0-9_-]{2,40}$/), name: z.string().trim().min(2).max(80), description: z.string().trim().max(500).default(''),
    sizes: z.array(sizeSchema).max(60).default([]), specTemplate: z.array(specFieldSchema).max(40).default([]),
    sizeGuideTemplate: z.object({ columns: z.array(z.string().max(40)).max(10), rows: z.array(z.array(z.string().max(20)).max(10)).max(40) }).strict().optional(),
    position: z.number().int().min(0).max(1000).default(0), active: z.boolean().default(true),
  }).strict();

  app.post('/api/v1/admin/product-types', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const body = typeBody.parse(request.body);
    if (new Set(body.specTemplate.map((f) => f.code)).size !== body.specTemplate.length) throw badRequest('کد فیلدها باید یکتا باشد.');
    if (new Set(body.sizes.map((s) => s.code)).size !== body.sizes.length) throw badRequest('کد سایزها باید یکتا باشد.');
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO product_types(id,code,name,description,sizes,spec_template,size_guide_template,position,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, body.code, body.name, body.description, JSON.stringify(body.sizes), JSON.stringify(body.specTemplate), JSON.stringify(body.sizeGuideTemplate ?? {}), body.position, body.active]);
      await audit(client, user.id, 'product_type.created', 'product_type', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id, code: body.code });
  });

  app.patch('/api/v1/admin/product-types/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'products:write');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = typeBody.omit({ code: true }).partial().parse(request.body);
    if (body.specTemplate && new Set(body.specTemplate.map((f) => f.code)).size !== body.specTemplate.length) throw badRequest('کد فیلدها باید یکتا باشد.');
    if (body.sizes && new Set(body.sizes.map((s) => s.code)).size !== body.sizes.length) throw badRequest('کد سایزها باید یکتا باشد.');
    return transaction(pool, async (client) => {
      const before = await one<{ sizes: SizeDef[]; code: string }>(client, 'SELECT * FROM product_types WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.sizes) {
        // A size already used by variants may be deactivated but never deleted (history stays valid).
        const removed = before.sizes.filter((s) => !body.sizes!.some((n) => n.code === s.code)).map((s) => s.code);
        if (removed.length) {
          const used = await one<{ n: number }>(client, `SELECT count(*)::int AS n FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.product_type_code = $1 AND v.size_label = ANY($2::text[])`, [before.code, removed]);
          if (used && used.n > 0) throw conflict('سایزهای استفاده‌شده در محصولات حذف نمی‌شوند؛ آن‌ها را غیرفعال کنید.');
        }
      }
      await client.query(`UPDATE product_types SET name = COALESCE($2,name), description = COALESCE($3,description), sizes = COALESCE($4,sizes),
          spec_template = COALESCE($5,spec_template), size_guide_template = COALESCE($6,size_guide_template), position = COALESCE($7,position),
          active = COALESCE($8,active), updated_at = now() WHERE id = $1`,
        [id, body.name ?? null, body.description ?? null, body.sizes ? JSON.stringify(body.sizes) : null, body.specTemplate ? JSON.stringify(body.specTemplate) : null,
          body.sizeGuideTemplate ? JSON.stringify(body.sizeGuideTemplate) : null, body.position ?? null, body.active ?? null]);
      await audit(client, user.id, 'product_type.updated', 'product_type', id, before, body, request.ip);
      return one(client, 'SELECT * FROM product_types WHERE id = $1', [id]);
    });
  });

  /* ---------- Unified profile (Req 333, 335, 338, 355) ---------- */
  app.get('/api/v1/profile', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<Record<string, unknown>>(pool, `SELECT id, display_name, first_name, last_name, email, phone, birthday, avatar_url, city, postal_code,
      two_factor_enabled, created_at FROM users WHERE id = $1`, [user.id]);
    if (!row) throw unauthorized();
    const membership = await one(pool, `SELECT m.id, m.status, m.starts_at, m.ends_at, p.code AS plan_code, p.title AS plan_name, p.permissions, p.limits
      FROM memberships m JOIN membership_plans p ON p.id = m.plan_id WHERE m.user_id = $1 ORDER BY (m.status = 'active') DESC, m.created_at DESC LIMIT 1`, [user.id]);
    const supplier = user.roles.includes('supplier')
      ? await one(pool, `SELECT brand_name, legal_name, national_id, registration_number, economic_code, tax_info, bank_name, account_number, bank_iban, account_holder,
          avatar_url, bio, public_description, contact_person, cooperation_status, version FROM supplier_profiles WHERE user_id = $1`, [user.id]) : null;
    const pendingChange = supplier ? await one(pool, `SELECT id, diff, status, created_at FROM supplier_profile_change_requests WHERE user_id = $1 AND status = 'pending_review' ORDER BY created_at DESC LIMIT 1`, [user.id]) : null;
    return {
      user: { id: row.id, displayName: row.display_name, firstName: row.first_name, lastName: row.last_name, email: row.email, phone: row.phone,
        birthday: row.birthday, avatarUrl: row.avatar_url, city: row.city, postalCode: row.postal_code, twoFactorEnabled: row.two_factor_enabled, createdAt: row.created_at },
      roles: user.roles,
      roleProfiles: { customer: true, vip: membership && (membership as { status: string }).status === 'active' ? membership : null, membership, supplier, supplierPendingChange: pendingChange },
      policy: {
        selfService: ['firstName', 'lastName', 'birthday', 'avatar', 'city', 'postalCode', 'addresses'],
        verifiedChange: ['phone', 'email'],
        supplierFree: ['avatarUrl', 'bio', 'publicDescription', 'contactPerson'],
        supplierApproval: Object.entries(SUPPLIER_SENSITIVE_FIELDS).map(([key, value]) => ({ key, label: value.label })),
      },
    };
  });

  app.patch('/api/v1/profile', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      firstName: z.string().trim().min(1).max(60).optional(), lastName: z.string().trim().min(1).max(80).optional(),
      birthday: z.iso.date().nullable().optional(), city: z.string().trim().max(80).nullable().optional(),
      postalCode: z.string().regex(/^\d{10}$/).nullable().optional(),
    }).strict().parse(request.body);
    if (body.birthday && (new Date(body.birthday) > new Date() || new Date(body.birthday) < new Date('1900-01-01'))) throw badRequest('تاریخ تولد معتبر نیست.');
    return transaction(pool, async (client) => {
      const before = await one<{ first_name: string | null; last_name: string | null; display_name: string; birthday: string | null; city: string | null; postal_code: string | null }>(client,
        'SELECT first_name, last_name, display_name, birthday, city, postal_code FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      if (!before) throw unauthorized();
      const first = body.firstName ?? before.first_name; const last = body.lastName ?? before.last_name;
      const displayName = [first, last].filter(Boolean).join(' ') || before.display_name;
      await client.query(`UPDATE users SET first_name = $2, last_name = $3, display_name = $4,
          birthday = CASE WHEN $5::boolean THEN $6::date ELSE birthday END, city = CASE WHEN $7::boolean THEN $8 ELSE city END,
          postal_code = CASE WHEN $9::boolean THEN $10 ELSE postal_code END, updated_at = now() WHERE id = $1`,
        [user.id, first, last, displayName, body.birthday !== undefined, body.birthday ?? null, body.city !== undefined, body.city ?? null, body.postalCode !== undefined, body.postalCode ?? null]);
      await audit(client, user.id, 'profile.updated', 'user', user.id, before, { ...body, displayName, verification: 'session' }, request.ip);
      return { displayName, ...body };
    });
  });

  app.post('/api/v1/profile/avatar', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const user = await principal(request, pool, config);
    const upload = await readUpload(request);
    const sniffed = validateAvatar(upload.buffer, upload.mime);
    const ext = sniffed.mime === 'image/png' ? '.png' : sniffed.mime === 'image/webp' ? '.webp' : '.jpg';
    const stored = await putFile(upload.buffer, `avatar${ext}`, sniffed.mime);
    const fileId = randomUUID();
    const url = `/api/v1/media/${fileId}`;
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO files(id,owner_id,storage_key,original_name,mime_type,size_bytes,sha256,visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,'public')`,
        [fileId, user.id, stored.storageKey, `avatar${ext}`, sniffed.mime, upload.buffer.length, stored.sha256]);
      const before = await one(client, 'SELECT avatar_url FROM users WHERE id = $1', [user.id]);
      await client.query('UPDATE users SET avatar_file_id = $2, avatar_url = $3, updated_at = now() WHERE id = $1', [user.id, fileId, url]);
      if (user.roles.includes('supplier')) await client.query('UPDATE supplier_profiles SET avatar_url = $2 WHERE user_id = $1', [user.id, url]);
      await audit(client, user.id, 'profile.avatar_updated', 'user', user.id, before, { avatarUrl: url, width: sniffed.width, height: sniffed.height }, request.ip);
    });
    return reply.code(201).send({ avatarUrl: url, width: sniffed.width, height: sniffed.height });
  });

  app.delete('/api/v1/profile/avatar', async (request) => {
    const user = await principal(request, pool, config);
    await transaction(pool, async (client) => {
      await client.query('UPDATE users SET avatar_file_id = NULL, avatar_url = NULL, updated_at = now() WHERE id = $1', [user.id]);
      await audit(client, user.id, 'profile.avatar_removed', 'user', user.id, undefined, undefined, request.ip);
    });
    return { avatarUrl: null };
  });

  /* ---------- Verified contact change (Req 336, 341) ---------- */
  app.post('/api/v1/profile/contact-change', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.discriminatedUnion('channel', [
      z.object({ channel: z.literal('phone'), value: z.string().regex(/^09\d{9}$/) }).strict(),
      z.object({ channel: z.literal('email'), value: z.email().max(254) }).strict(),
    ]).parse(request.body);
    const value = body.channel === 'email' ? body.value.toLowerCase() : body.value;
    const taken = await one(pool, `SELECT id FROM users WHERE ${body.channel === 'phone' ? 'phone' : 'email'} = $1 AND id <> $2`, [value, user.id]);
    if (taken) throw conflict(body.channel === 'phone' ? 'این شماره همراه متعلق به حساب دیگری است.' : 'این ایمیل متعلق به حساب دیگری است.');
    const result = await transaction(pool, (client) => issueOtp(client, config, user.id, body.channel, value, body.channel === 'phone' ? value : null));
    return reply.code(201).send({ ...result, channel: body.channel, target: value });
  });

  app.post('/api/v1/profile/contact-change/:id/verify', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    const row = await one<{ channel: 'phone' | 'email' }>(pool, 'SELECT channel FROM contact_change_requests WHERE id = $1 AND user_id = $2', [id, user.id]);
    if (!row || !['phone', 'email'].includes(row.channel)) throw notFound();
    const value = await consumeOtp(pool, config, user.id, id, body.code, row.channel);
    return transaction(pool, async (client) => {
      const column = row.channel === 'phone' ? 'phone' : 'email';
      const before = await one<Record<string, string | null>>(client, `SELECT ${column} FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
      const taken = await one(client, `SELECT id FROM users WHERE ${column} = $1 AND id <> $2`, [value, user.id]);
      if (taken) throw conflict('این مقدار هم‌زمان توسط حساب دیگری ثبت شد.');
      await client.query(`UPDATE users SET ${column} = $2, updated_at = now() WHERE id = $1`, [user.id, value]);
      await audit(client, user.id, `profile.${column}_changed`, 'user', user.id, before, { [column]: value, verification: row.channel === 'phone' ? 'sms_otp' : 'email_code' }, request.ip);
      await outbox(client, `profile.${column}_changed`, 'user', user.id, { userId: user.id });
      return { channel: row.channel, value };
    });
  });

  /* ---------- Password (Req 337) ---------- */
  app.post('/api/v1/profile/password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(12).max(128), confirmPassword: z.string() }).strict().parse(request.body);
    if (body.newPassword !== body.confirmPassword) throw badRequest('تکرار رمز عبور با رمز جدید یکسان نیست.');
    if (body.newPassword === body.currentPassword) throw badRequest('رمز جدید باید با رمز فعلی متفاوت باشد.');
    const row = await one<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [user.id]);
    if (!row || !(await argon2.verify(row.password_hash, body.currentPassword))) throw badRequest('رمز عبور فعلی صحیح نیست.');
    const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    return transaction(pool, async (client) => {
      await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hash]);
      const revoked = await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, user.sessionId]);
      await audit(client, user.id, 'profile.password_changed', 'user', user.id, undefined, { verification: 'current_password', otherSessionsRevoked: revoked.rowCount }, request.ip);
      return { changed: true, otherSessionsRevoked: revoked.rowCount ?? 0 };
    });
  });

  /** OTP-based users can set/recover a password through their verified phone. */
  app.post('/api/v1/profile/password/otp', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await principal(request, pool, config);
    const row = await one<{ phone: string | null }>(pool, 'SELECT phone FROM users WHERE id = $1', [user.id]);
    if (!row?.phone) throw badRequest('برای تنظیم رمز با کد یک‌بارمصرف، شماره همراه تأییدشده لازم است.');
    const result = await transaction(pool, (client) => issueOtp(client, config, user.id, 'password', '-', row.phone));
    return reply.code(201).send({ ...result, target: `${row.phone.slice(0, 4)}***${row.phone.slice(-2)}` });
  });

  app.post('/api/v1/profile/password/otp/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(12).max(128), confirmPassword: z.string() }).strict().parse(request.body);
    if (body.newPassword !== body.confirmPassword) throw badRequest('تکرار رمز عبور با رمز جدید یکسان نیست.');
    await consumeOtp(pool, config, user.id, id, body.code, 'password');
    const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    return transaction(pool, async (client) => {
      await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, hash]);
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, user.sessionId]);
      await audit(client, user.id, 'profile.password_set', 'user', user.id, undefined, { verification: 'sms_otp' }, request.ip);
      return { changed: true };
    });
  });

  /* ---------- Account security (Req 351) ---------- */
  app.get('/api/v1/profile/security', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<{ two_factor_enabled: boolean; two_factor_method: string }>(pool, 'SELECT two_factor_enabled, two_factor_method FROM users WHERE id = $1', [user.id]);
    const sessions = await pool.query(`SELECT id, device_label, user_agent, ip_address, created_at, last_active_at, expires_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_active_at DESC`, [user.id]);
    const history = await pool.query('SELECT id, device_label, ip_address, method, succeeded, created_at FROM login_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [user.id]);
    return { twoFactorEnabled: row?.two_factor_enabled ?? false, twoFactorMethod: row?.two_factor_method ?? 'sms',
      sessions: sessions.rows.map((s: Record<string, unknown>) => ({ ...s, current: s.id === user.sessionId })), loginHistory: history.rows };
  });

  app.post('/api/v1/profile/security/2fa', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({ enabled: z.boolean(), currentPassword: z.string().min(1).max(128) }).strict().parse(request.body);
    const row = await one<{ password_hash: string; phone: string | null }>(pool, 'SELECT password_hash, phone FROM users WHERE id = $1', [user.id]);
    if (!row || !(await argon2.verify(row.password_hash, body.currentPassword))) throw badRequest('رمز عبور فعلی صحیح نیست.');
    if (body.enabled && !row.phone) throw badRequest('برای فعال‌سازی ورود دومرحله‌ای، شماره همراه لازم است.');
    await transaction(pool, async (client) => {
      await client.query(`UPDATE users SET two_factor_enabled = $2, two_factor_method = 'sms', updated_at = now() WHERE id = $1`, [user.id, body.enabled]);
      await audit(client, user.id, body.enabled ? 'security.2fa_enabled' : 'security.2fa_disabled', 'user', user.id, undefined, { method: 'sms', verification: 'current_password' }, request.ip);
    });
    return { twoFactorEnabled: body.enabled };
  });

  app.delete('/api/v1/profile/sessions/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id', [id, user.id]);
    if (!res.rowCount) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'security.session_revoked', 'session', id, undefined, undefined, request.ip));
    return { id, revoked: true, current: id === user.sessionId };
  });

  app.post('/api/v1/profile/sessions/logout-all', async (request) => {
    const user = await principal(request, pool, config);
    return transaction(pool, async (client) => {
      const res = await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
      await client.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [user.id]);
      await audit(client, user.id, 'security.logout_all', 'user', user.id, undefined, { sessions: res.rowCount }, request.ip);
      return { revoked: res.rowCount ?? 0 };
    });
  });

  /* ---------- Customer dashboard (Req 342-350, 352-354) ---------- */
  app.post('/api/v1/account/views', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { productId } = z.object({ productId: z.uuid() }).strict().parse(request.body);
    await pool.query(`INSERT INTO product_views(user_id, product_id) SELECT $1, id FROM products WHERE id = $2 AND status = 'published'
      ON CONFLICT (user_id, product_id) DO UPDATE SET viewed_at = now()`, [user.id, productId]);
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/v1/account/dashboard', async (request) => {
    const user = await principal(request, pool, config);
    const me = await one<{ display_name: string; first_name: string | null; avatar_url: string | null }>(pool, 'SELECT display_name, first_name, avatar_url FROM users WHERE id = $1', [user.id]);
    const counts = await one<Record<string, number>>(pool, `SELECT
        (SELECT count(*)::int FROM orders WHERE buyer_id = $1 AND status = ANY($2::text[])) AS active_orders,
        (SELECT count(*)::int FROM orders WHERE buyer_id = $1 AND status = 'delivered') AS delivered_orders,
        (SELECT count(*)::int FROM wishlist_items i JOIN wishlist_collections c ON c.id = i.collection_id WHERE c.owner_id = $1) AS wishlist,
        (SELECT count(*)::int FROM saved_styles WHERE user_id = $1) AS saved_styles,
        (SELECT count(*)::int FROM coupons c WHERE c.recipient_user_id = $1 AND c.active AND c.ends_at > now()
           AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.user_id = $1)) AS coupons,
        (SELECT COALESCE(sum(total_rial), 0)::text FROM orders WHERE buyer_id = $1 AND status NOT IN ('pending_payment','cancelled','returned')) AS spent_rial`,
      [user.id, ACTIVE_ORDER]);
    const points = Math.floor(Number(BigInt(String(counts?.spent_rial ?? '0')) / 1_000_000n)) + (counts?.delivered_orders ?? 0) * 20;
    const activeOrderRow = await one<{ id: string; reference: string; status: string; created_at: string; paid_at: string | null; tracking_code: string | null; total_rial: string }>(pool,
      `SELECT id, reference, status, created_at, paid_at, tracking_code, total_rial::text FROM orders WHERE buyer_id = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`, [user.id, ACTIVE_ORDER]);
    let activeOrder = null;
    if (activeOrderRow) {
      const events = (await pool.query('SELECT to_status, created_at FROM order_events WHERE order_id = $1 ORDER BY created_at', [activeOrderRow.id])).rows as { to_status: string; created_at: string }[];
      activeOrder = { ...activeOrderRow, timeline: orderTimeline(activeOrderRow, events) };
    }
    const coupons = (await pool.query(`SELECT c.id, c.code, c.type, c.value::text AS value, c.max_discount_rial::text AS max_discount_rial, c.min_order_rial::text AS min_order_rial,
        c.campaign_name, c.source, c.ends_at, EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.user_id = $1) AS used
      FROM coupons c WHERE c.recipient_user_id = $1 AND c.active ORDER BY used, c.ends_at LIMIT 20`, [user.id])).rows;

    // Personalization from real signals (Req 346): purchases, wishlist, saved styles, views — WMS-filtered.
    const signals = await one<{ vibes: string[] | null; categories: string[] | null }>(pool, `SELECT
        ARRAY(SELECT DISTINCT unnest(p.vibes) FROM products p WHERE p.id IN (
          SELECT ol.product_id FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.buyer_id = $1
          UNION SELECT i.product_id FROM wishlist_items i JOIN wishlist_collections c ON c.id = i.collection_id WHERE c.owner_id = $1
          UNION SELECT product_id FROM product_views WHERE user_id = $1)
          UNION SELECT DISTINCT unnest(derived_vibes) FROM saved_styles WHERE user_id = $1) AS vibes,
        ARRAY(SELECT DISTINCT p.category FROM products p JOIN order_lines ol ON ol.product_id = p.id JOIN orders o ON o.id = ol.order_id WHERE o.buyer_id = $1) AS categories`, [user.id]);
    const topVibe = signals?.vibes?.[0];
    const forYou = await queryCommerceProducts(pool, { inStockOnly: true, vibe: topVibe, limit: 8, sortBy: 'popular' });
    const recentIds = (await pool.query('SELECT product_id FROM product_views WHERE user_id = $1 ORDER BY viewed_at DESC LIMIT 8', [user.id])).rows.map((r: { product_id: string }) => r.product_id);
    const buyAgainIds = (await pool.query(`SELECT DISTINCT ol.product_id FROM order_lines ol JOIN orders o ON o.id = ol.order_id WHERE o.buyer_id = $1 AND o.status = 'delivered' LIMIT 8`, [user.id])).rows.map((r: { product_id: string }) => r.product_id);
    const wishIds = (await pool.query(`SELECT i.product_id FROM wishlist_items i JOIN wishlist_collections c ON c.id = i.collection_id WHERE c.owner_id = $1 ORDER BY i.added_at DESC LIMIT 8`, [user.id])).rows.map((r: { product_id: string }) => r.product_id);
    const [recentlyViewed, buyAgain, wishlistProducts] = await Promise.all([commerceProductsByIds(pool, recentIds), commerceProductsByIds(pool, buyAgainIds), commerceProductsByIds(pool, wishIds)]);
    const suggestedStyles = (await pool.query(`SELECT id, name, share_code, score, items, derived_vibes FROM saved_styles WHERE privacy = 'public' AND user_id <> $1
      AND ($2::text IS NULL OR $2 = ANY(derived_vibes)) ORDER BY score DESC, updated_at DESC LIMIT 3`, [user.id, topVibe ?? null])).rows;
    const invoices = (await pool.query(`SELECT id, reference, kind, status, total_rial::text, issue_date FROM invoices WHERE buyer->>'userId' = $1 ORDER BY created_at DESC LIMIT 5`, [user.id])).rows;
    const reviewable = await one<{ n: number }>(pool, `SELECT count(DISTINCT ol.product_id)::int AS n FROM orders o JOIN order_lines ol ON ol.order_id = o.id
      WHERE o.buyer_id = $1 AND o.status IN ('delivered','shipped','in_transit') AND NOT EXISTS (SELECT 1 FROM customer_reviews r WHERE r.user_id = $1 AND r.product_id = ol.product_id)`, [user.id]);
    const appearance = await one<{ value: unknown }>(pool, `SELECT value FROM site_settings WHERE key = 'account_appearance'`);
    return {
      greetingName: me?.first_name || me?.display_name || user.displayName, avatarUrl: me?.avatar_url ?? null,
      summary: { activeOrders: counts?.active_orders ?? 0, deliveredOrders: counts?.delivered_orders ?? 0, wishlist: counts?.wishlist ?? 0,
        savedStyles: counts?.saved_styles ?? 0, coupons: counts?.coupons ?? 0, loyalty: { points, tier: loyaltyTier(points) } },
      activeOrder, coupons, invoices, reviewableCount: reviewable?.n ?? 0,
      personalization: { forYou, recentlyViewed, buyAgain, wishlistProducts, suggestedStyles, basedOnVibe: topVibe ?? null },
      appearance: appearance?.value ?? null,
    };
  });

  /** Customer-facing timeline (Req 352) — derived from domains, never from internal audit logs. */
  app.get('/api/v1/account/timeline', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(`
      SELECT 'order_placed' AS kind, 'سفارش ' || reference || ' ثبت شد' AS title, created_at AS at, id::text AS ref FROM orders WHERE buyer_id = $1
      UNION ALL SELECT 'order_paid', 'سفارش ' || reference || ' پرداخت شد', paid_at, id::text FROM orders WHERE buyer_id = $1 AND paid_at IS NOT NULL
      UNION ALL SELECT 'order_' || e.to_status, CASE e.to_status WHEN 'shipped' THEN 'مرسوله ' || o.reference || ' ارسال شد' WHEN 'in_transit' THEN 'مرسوله ' || o.reference || ' در مسیر است'
          WHEN 'delivered' THEN 'سفارش ' || o.reference || ' تحویل شد' WHEN 'cancelled' THEN 'سفارش ' || o.reference || ' لغو شد' END, e.created_at, o.id::text
        FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.buyer_id = $1 AND e.to_status IN ('shipped','in_transit','delivered','cancelled')
      UNION ALL SELECT 'coupon', 'کوپن ' || COALESCE(campaign_name, code) || ' دریافت کردید', created_at, id::text FROM coupons WHERE recipient_user_id = $1
      UNION ALL SELECT 'review', 'برای ' || p.name || ' دیدگاه ثبت کردید', r.created_at, r.id::text FROM customer_reviews r JOIN products p ON p.id = r.product_id WHERE r.user_id = $1
      UNION ALL SELECT 'style', 'استایل «' || name || '» را ذخیره کردید', created_at, id::text FROM saved_styles WHERE user_id = $1
      ORDER BY at DESC NULLS LAST LIMIT 60`, [user.id]);
    return { items: rows.rows };
  });

  app.get('/api/v1/account/coupons', async (request) => {
    const user = await principal(request, pool, config);
    return { items: (await pool.query(`SELECT c.id, c.code, c.type, c.value::text AS value, c.max_discount_rial::text AS max_discount_rial, c.min_order_rial::text AS min_order_rial,
        c.campaign_name, c.source, c.starts_at, c.ends_at, (c.ends_at < now()) AS expired,
        EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.user_id = $1) AS used
      FROM coupons c WHERE c.recipient_user_id = $1 ORDER BY used, expired, c.ends_at`, [user.id])).rows };
  });

  app.get('/api/v1/account/invoices', async (request) => {
    const user = await principal(request, pool, config);
    return { items: (await pool.query(`SELECT id, reference, kind, order_id, status, total_rial::text, paid_rial::text, issue_date, created_at FROM invoices
      WHERE buyer->>'userId' = $1 AND kind IN ('retail_sale','wholesale_sale','refund','return_credit','installment_plan') ORDER BY created_at DESC LIMIT 100`, [user.id])).rows };
  });

  /* ---------- Supplier profile approval policy (Req 339-341) ---------- */
  app.patch('/api/v1/supplier-profile/public', async (request) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
    const body = z.object({ avatarUrl: z.string().max(300).nullable().optional(), bio: z.string().trim().max(1000).optional(),
      publicDescription: z.string().trim().max(3000).optional(), contactPerson: z.string().trim().max(120).optional() }).strict().parse(request.body);
    for (const v of Object.values(body)) if (typeof v === 'string' && /<[a-z!/]/i.test(v)) throw badRequest('HTML مجاز نیست.');
    return transaction(pool, async (client) => {
      const before = await one(client, 'SELECT avatar_url, bio, public_description, contact_person FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [user.id]);
      if (!before) throw notFound();
      await client.query(`UPDATE supplier_profiles SET avatar_url = CASE WHEN $2::boolean THEN $3 ELSE avatar_url END, bio = COALESCE($4,bio),
          public_description = COALESCE($5,public_description), contact_person = COALESCE($6,contact_person), updated_at = now() WHERE user_id = $1`,
        [user.id, body.avatarUrl !== undefined, body.avatarUrl ?? null, body.bio ?? null, body.publicDescription ?? null, body.contactPerson ?? null]);
      await audit(client, user.id, 'supplier.public_profile_updated', 'supplier', user.id, before, body, request.ip);
      return one(client, 'SELECT avatar_url, bio, public_description, contact_person FROM supplier_profiles WHERE user_id = $1', [user.id]);
    });
  });

  app.post('/api/v1/supplier-profile/change-requests', async (request, reply) => {
    const user = await principal(request, pool, config);
    if (!user.roles.includes('supplier')) throw forbidden();
    const body = z.object({ changes: z.record(z.string(), z.string().trim().max(200).nullable()), note: z.string().trim().max(500).optional() }).strict().parse(request.body);
    const unknown = Object.keys(body.changes).filter((k) => !SUPPLIER_SENSITIVE_FIELDS[k]);
    if (unknown.length) throw badRequest(`این فیلدها نیاز به تأیید ندارند یا معتبر نیستند: ${unknown.join('، ')}`);
    if (body.changes.bankIban && !/^IR\d{24}$/.test(body.changes.bankIban.replace(/\s/g, ''))) throw badRequest('شماره شبا باید با IR و ۲۴ رقم باشد.');
    if (body.changes.bankIban) body.changes.bankIban = body.changes.bankIban.replace(/\s/g, '');
    return transaction(pool, async (client) => {
      const current = await one<Record<string, unknown> & { version: number }>(client, 'SELECT * FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [user.id]);
      if (!current) throw notFound();
      const pending = await one(client, `SELECT id FROM supplier_profile_change_requests WHERE user_id = $1 AND status = 'pending_review'`, [user.id]);
      if (pending) throw conflict('یک درخواست تغییر در انتظار بررسی دارید؛ پس از تعیین تکلیف، درخواست جدید ثبت کنید.');
      const diff = supplierDiff(current, body.changes);
      if (!diff.length) throw badRequest('مقدار جدید با اطلاعات فعلی تفاوتی ندارد.');
      const id = randomUUID();
      const currentValues = Object.fromEntries(diff.map((d) => [d.field, d.oldValue]));
      await client.query(`INSERT INTO supplier_profile_change_requests(id,user_id,base_version,current_values,proposed_values,diff,supplier_note) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, user.id, current.version, JSON.stringify(currentValues), JSON.stringify(body.changes), JSON.stringify(diff), body.note ?? null]);
      await audit(client, user.id, 'supplier.change_requested', 'supplier', user.id, currentValues, { requestId: id, proposed: body.changes }, request.ip);
      await outbox(client, 'supplier.profile_change_requested', 'supplier', user.id, { requestId: id, fields: diff.map((d) => d.field) });
      return reply.code(201).send({ id, status: 'pending_review', diff });
    });
  });

  app.get('/api/v1/supplier-profile/change-requests', async (request) => {
    const user = await principal(request, pool, config);
    return { items: (await pool.query('SELECT id, diff, status, supplier_note, review_note, reviewed_at, created_at FROM supplier_profile_change_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30', [user.id])).rows };
  });

  app.get('/api/v1/admin/supplier-change-requests', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const q = z.object({ status: z.enum(['pending_review', 'approved', 'rejected']).optional() }).parse(request.query);
    return { items: (await pool.query(`SELECT r.*, s.brand_name, u.display_name, u.phone FROM supplier_profile_change_requests r
      JOIN supplier_profiles s ON s.user_id = r.user_id JOIN users u ON u.id = r.user_id
      WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 100`, [q.status ?? null])).rows };
  });

  app.post('/api/v1/admin/supplier-change-requests/:id/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(1000).optional() }).strict()
      .refine((v) => v.decision === 'approved' || (v.note && v.note.length >= 3), 'برای رد درخواست، دلیل لازم است.').parse(request.body);
    return transaction(pool, async (client) => {
      const change = await one<{ user_id: string; status: string; base_version: number; proposed_values: Record<string, string | null>; diff: unknown[] }>(client,
        'SELECT * FROM supplier_profile_change_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!change) throw notFound();
      if (change.status !== 'pending_review') throw conflict('این درخواست قبلاً بررسی شده است.');
      if (body.decision === 'approved') {
        const current = await one<{ version: number }>(client, 'SELECT version FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [change.user_id]);
        if (!current) throw notFound();
        const sets: string[] = []; const values: unknown[] = [change.user_id];
        for (const [key, value] of Object.entries(change.proposed_values)) {
          const def = SUPPLIER_SENSITIVE_FIELDS[key]; if (!def) continue;
          values.push(value); sets.push(`${def.column} = $${values.length}`);
        }
        await client.query(`UPDATE supplier_profiles SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE user_id = $1`, values);
        await snapshotSupplierVersion(client, change.user_id, user.id, `تأیید درخواست تغییر اطلاعات حساس ${id.slice(0, 8)}`);
      }
      await client.query('UPDATE supplier_profile_change_requests SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1',
        [id, body.decision, body.note ?? null, user.id]);
      await audit(client, user.id, `supplier.change_${body.decision}`, 'supplier', change.user_id, { diff: change.diff }, { requestId: id, note: body.note ?? null, verification: 'admin_review' }, request.ip);
      await outbox(client, `supplier.profile_change_${body.decision}`, 'supplier', change.user_id, { requestId: id });
      const event = await one<{ id: string }>(client, `SELECT id FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [`supplier.profile_change_${body.decision}`, change.user_id]);
      await client.query(`INSERT INTO notifications(id,user_id,event_id,title,body,priority) VALUES ($1,$2,$3,$4,$5,'high') ON CONFLICT DO NOTHING`,
        [randomUUID(), change.user_id, event!.id, body.decision === 'approved' ? 'تغییر اطلاعات حساس تأیید شد' : 'تغییر اطلاعات حساس رد شد',
          body.decision === 'approved' ? 'نسخه جدید پروفایل شما فعال شد.' : `دلیل: ${body.note}`]);
      return { id, status: body.decision };
    });
  });
}
