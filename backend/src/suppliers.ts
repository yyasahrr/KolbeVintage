import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import argon2 from 'argon2';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { nextDocumentReference } from './references.js';
import { badRequest, conflict, notFound } from './errors.js';

/* Supplier management (items 5, 6, 43): complete legal/identity, contact, bank,
   operational and contract data with versioned snapshots and an admin-managed
   cooperation form whose submissions become full reviewable profiles. */

const profilePatch = z.object({
  personType: z.enum(['individual', 'legal']).optional(),
  brandName: z.string().trim().min(2).max(120).optional(),
  legalName: z.string().trim().max(200).optional(),
  nationalId: z.string().trim().max(20).optional(),
  registrationNumber: z.string().trim().max(40).optional(),
  economicCode: z.string().trim().max(40).optional(),
  taxInfo: z.string().trim().max(500).optional(),
  businessPhone: z.string().trim().max(20).optional(),
  mobile: z.string().trim().max(20).optional(),
  email: z.string().trim().max(254).optional(),
  website: z.string().trim().max(200).optional(),
  officeAddress: z.string().trim().max(500).optional(),
  warehouseAddress: z.string().trim().max(500).optional(),
  bankName: z.string().trim().max(80).optional(),
  accountNumber: z.string().trim().max(40).optional(),
  bankIban: z.string().trim().max(34).optional(),
  accountHolder: z.string().trim().max(120).optional(),
  productCategories: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  supplyCapacity: z.string().trim().max(1000).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  minOrderQuantity: z.number().int().min(0).max(1000000).optional(),
  shippingCities: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
  shippingMethods: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  collaborationStartDate: z.iso.date().optional(),
  contractStatus: z.enum(['none', 'draft', 'active', 'suspended', 'terminated']).optional(),
  settlementTerms: z.string().trim().max(2000).optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
  sla: z.string().trim().max(2000).optional(),
  changeNote: z.string().trim().max(500).optional(),
}).strict();

const columnMap: Record<string, string> = {
  personType: 'person_type', brandName: 'brand_name', legalName: 'legal_name', nationalId: 'national_id',
  registrationNumber: 'registration_number', economicCode: 'economic_code', taxInfo: 'tax_info',
  businessPhone: 'business_phone', mobile: 'mobile', email: 'email', website: 'website',
  officeAddress: 'office_address', warehouseAddress: 'warehouse_address', bankName: 'bank_name',
  accountNumber: 'account_number', bankIban: 'bank_iban', accountHolder: 'account_holder',
  productCategories: 'product_categories', supplyCapacity: 'supply_capacity', leadTimeDays: 'lead_time_days',
  minOrderQuantity: 'min_order_quantity', shippingCities: 'shipping_cities', shippingMethods: 'shipping_methods',
  collaborationStartDate: 'collaboration_start_date', contractStatus: 'contract_status',
  settlementTerms: 'settlement_terms', commissionPercent: 'commission_percent', sla: 'sla',
};

const formField = z.object({
  code: z.string().trim().regex(/^[a-z0-9_]{2,40}$/),
  label: z.string().trim().min(2).max(120),
  fieldType: z.enum(['text', 'textarea', 'number', 'select', 'file', 'boolean', 'date']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(1000).default(0),
}).strict();

export async function snapshotSupplierVersion(client: PoolClient, userId: string, changedBy: string, note?: string) {
  return snapshotVersion(client, userId, changedBy, note);
}

async function snapshotVersion(client: PoolClient, userId: string, changedBy: string, note?: string) {
  const profile = await one<Record<string, unknown>>(client, 'SELECT * FROM supplier_profiles WHERE user_id = $1', [userId]);
  if (!profile) throw notFound();
  await client.query(
    `INSERT INTO supplier_profile_versions(id,user_id,version,snapshot,change_note,changed_by)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, version) DO NOTHING`,
    [randomUUID(), userId, Number(profile.version), JSON.stringify(profile), note ?? null, changedBy]);
  return profile;
}

function validatePayload(fields: Array<{ code: string; label: string; field_type: string; required: boolean; options: string[] }>, payload: Record<string, unknown>) {
  for (const field of fields) {
    const value = payload[field.code];
    const missing = value === undefined || value === null || value === '';
    if (field.required && missing) throw badRequest(`فیلد «${field.label}» الزامی است.`);
    if (!missing && field.field_type === 'select' && field.options.length > 0 && !field.options.includes(String(value)))
      throw badRequest(`مقدار فیلد «${field.label}» معتبر نیست.`);
    if (!missing && field.field_type === 'number' && !/^\d+$/.test(String(value)))
      throw badRequest(`مقدار فیلد «${field.label}» باید عدد باشد.`);
    if (!missing && field.field_type === 'boolean' && typeof value !== 'boolean')
      throw badRequest(`مقدار فیلد «${field.label}» باید درست یا نادرست باشد.`);
    if (typeof value === 'string' && value.length > 5000) throw badRequest(`مقدار فیلد «${field.label}» خیلی طولانی است.`);
  }
}

export function registerSupplierRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/cooperation-form', async () => {
    const rows = await pool.query(
      `SELECT code,label,field_type AS fieldType,required,options,position FROM cooperation_form_fields
       WHERE active ORDER BY position, code`);
    return { items: rows.rows };
  });

  app.put('/api/v1/admin/cooperation-form', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cooperation:manage');
    const body = z.object({ fields: z.array(formField).min(1).max(100) }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await client.query('SELECT code,label,field_type,required,options,active,position FROM cooperation_form_fields ORDER BY position');
      await client.query('DELETE FROM cooperation_form_fields');
      for (const [index, field] of body.fields.entries()) {
        await client.query(
          `INSERT INTO cooperation_form_fields(id,code,label,field_type,required,options,active,position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), field.code, field.label, field.fieldType, field.required,
            JSON.stringify(field.options), field.active, field.position || index + 1]);
      }
      await audit(client, user.id, 'cooperation_form.updated', 'cooperation_form', 'default',
        { fields: before.rows }, { fields: body.fields }, request.ip);
      return { fields: body.fields };
    });
  });

  app.post('/api/v1/cooperation-requests', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const body = z.object({ payload: z.record(z.string(), z.unknown()) }).strict().parse(request.body);
    const result = await transaction(pool, async (client) => {
      const fields = (await client.query(
        `SELECT code,label,field_type,options,required FROM cooperation_form_fields WHERE active ORDER BY position`)).rows as Array<{ code: string; label: string; field_type: string; required: boolean; options: string[] }>;
      if (!fields.length) throw conflict('فرم همکاری فعال نیست.');
      validatePayload(fields, body.payload);
      const id = randomUUID();
      const reference = await nextDocumentReference(client, 'cooperation');
      await client.query('INSERT INTO cooperation_requests(id,reference,payload) VALUES ($1,$2,$3)',
        [id, reference, JSON.stringify(body.payload)]);
      await audit(client, null, 'cooperation_request.created', 'cooperation_request', id, undefined, { reference }, request.ip);
      await outbox(client, 'cooperation_request.created', 'cooperation_request', id, { requestId: id, reference });
      return { id, reference, status: 'new' };
    });
    return reply.code(201).send(result);
  });

  app.get('/api/v1/admin/cooperation-requests', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cooperation:manage');
    const query = z.object({ status: z.enum(['new', 'reviewing', 'approved', 'rejected']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,reference,status,user_id,review_note,created_at,updated_at,
              payload->>'brand_name' AS brand_name, payload->>'mobile' AS mobile
       FROM cooperation_requests WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`, [query.status ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/cooperation-requests/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cooperation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const row = await one(pool, 'SELECT * FROM cooperation_requests WHERE id = $1', [id]);
    if (!row) throw notFound();
    return row;
  });

  /** Approving a request turns the submission into a full supplier profile. */
  app.post('/api/v1/admin/cooperation-requests/:id/review', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'cooperation:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['reviewing', 'approved', 'rejected']),
      note: z.string().trim().max(1000).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const requestRow = await one<{ id: string; reference: string; payload: Record<string, unknown>; status: string; user_id: string | null }>(client,
        'SELECT * FROM cooperation_requests WHERE id = $1 FOR UPDATE', [id]);
      if (!requestRow) throw notFound();
      if (requestRow.status === 'approved' && body.status === 'approved') return { id, status: 'approved', userId: requestRow.user_id };
      if (requestRow.status === 'rejected' || requestRow.status === 'approved') throw conflict('این درخواست قبلاً تعیین تکلیف شده است.');
      let userId = requestRow.user_id;
      let temporaryPassword: string | null = null;
      if (body.status === 'approved') {
        const payload = requestRow.payload;
        const identity = String(payload.mobile ?? payload.email ?? '').trim();
        if (!/^09\d{9}$/.test(identity) && !z.string().email().safeParse(identity).success)
          throw badRequest('درخواست باید موبایل یا ایمیل معتبر داشته باشد.');
        const existing = await one<{ id: string }>(client, 'SELECT id FROM users WHERE phone = $1 OR email = $1', [identity]);
        if (existing) {
          userId = existing.id;
        } else {
          temporaryPassword = randomBytes(12).toString('base64url');
          userId = randomUUID();
          const isPhone = /^09\d{9}$/.test(identity);
          await client.query('INSERT INTO users(id,phone,email,password_hash,display_name) VALUES ($1,$2,$3,$4,$5)',
            [userId, isPhone ? identity : null, isPhone ? null : identity,
              await argon2.hash(temporaryPassword, { type: argon2.argon2id }), String(payload.brand_name ?? 'تأمین‌کننده')]);
        }
        await client.query(`INSERT INTO user_roles(user_id,role_code) VALUES ($1,'supplier') ON CONFLICT DO NOTHING`, [userId]);
        await client.query(
          `INSERT INTO supplier_profiles(user_id,brand_name,legal_name,national_id,economic_code,registration_number,
             business_phone,mobile,email,website,office_address,warehouse_address,bank_name,bank_iban,account_holder,
             product_categories,supply_capacity,lead_time_days,min_order_quantity,shipping_cities,shipping_methods,
             settlement_terms,sla,person_type,cooperation_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'pending')
           ON CONFLICT (user_id) DO NOTHING`,
          [userId,
            String(payload.brand_name ?? ''), payload.legal_name ? String(payload.legal_name) : null,
            payload.national_id ? String(payload.national_id) : null, payload.economic_code ? String(payload.economic_code) : null,
            payload.registration_number ? String(payload.registration_number) : null,
            payload.phone ? String(payload.phone) : null, payload.mobile ? String(payload.mobile) : null,
            payload.email ? String(payload.email) : null, payload.website ? String(payload.website) : null,
            payload.office_address ? String(payload.office_address) : null, payload.warehouse_address ? String(payload.warehouse_address) : null,
            payload.bank_name ? String(payload.bank_name) : null, payload.iban ? String(payload.iban) : null,
            payload.account_holder ? String(payload.account_holder) : null,
            payload.product_categories ? [String(payload.product_categories)] : [],
            payload.supply_capacity ? String(payload.supply_capacity) : null,
            payload.lead_time_days ? Number(payload.lead_time_days) : null,
            payload.min_order_quantity ? Number(payload.min_order_quantity) : null,
            payload.shipping_cities ? [String(payload.shipping_cities)] : [],
            payload.shipping_methods ? [String(payload.shipping_methods)] : [],
            payload.settlement_terms ? String(payload.settlement_terms) : null, payload.sla ? String(payload.sla) : null,
            payload.person_type === 'individual' ? 'individual' : 'legal']);
        await snapshotVersion(client, userId, user.id, `ایجاد پروفایل از درخواست ${requestRow.reference}`);
      }
      await client.query('UPDATE cooperation_requests SET status = $2, user_id = $3, reviewer_id = $4, review_note = $5, updated_at = now() WHERE id = $1',
        [id, body.status, userId, user.id, body.note ?? null]);
      await audit(client, user.id, 'cooperation_request.reviewed', 'cooperation_request', id,
        { status: requestRow.status }, { status: body.status, note: body.note ?? null, userId }, request.ip);
      await outbox(client, 'cooperation_request.reviewed', 'cooperation_request', id, { requestId: id, status: body.status });
      return { id, status: body.status, userId, temporaryPassword };
    });
  });

  app.get('/api/v1/admin/suppliers', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const query = z.object({ status: z.enum(['pending', 'approved', 'suspended', 'rejected']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT s.user_id,s.brand_name,s.legal_name,s.person_type,s.national_id,s.cooperation_status,
              s.commission_percent,s.contract_status,s.product_categories,s.version,s.updated_at,
              s.activity_status,s.activity_reason,s.activity_restricted_until,
              u.display_name,u.phone,u.email
       FROM supplier_profiles s JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.cooperation_status = $1) ORDER BY s.updated_at DESC LIMIT $2`,
      [query.status ?? null, query.limit]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/suppliers/:userId/status', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
    const body = z.object({ status: z.enum(['pending', 'approved', 'suspended', 'rejected']),
      note: z.string().trim().max(1000).optional() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<{ cooperation_status: string; activity_status: string }>(client,
        'SELECT cooperation_status, activity_status FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!before) throw notFound();
      // The legacy cooperation status and the richer activity lifecycle stay in
      // sync so both panels (and the enforcement layer) agree (item 11).
      const activityStatus = body.status === 'approved' ? 'active' : body.status === 'pending' ? 'pending_review' : body.status;
      await client.query(
        `UPDATE supplier_profiles SET cooperation_status = $2, activity_status = $3, activity_reason = COALESCE($4, activity_reason),
           activity_changed_at = now(), version = version + 1, updated_at = now() WHERE user_id = $1`,
        [userId, body.status, activityStatus, body.note ?? null]);
      await client.query(
        `INSERT INTO supplier_status_history(id, user_id, from_status, to_status, reason, note, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), userId, before.activity_status, activityStatus,
          body.note ?? `تغییر وضعیت همکاری به ${body.status}`, body.note ?? null, user.id]);
      await snapshotVersion(client, userId, user.id, body.note ?? `تغییر وضعیت به ${body.status}`);
      await audit(client, user.id, 'supplier.status_changed', 'supplier', userId,
        { status: before.cooperation_status }, { status: body.status, note: body.note ?? null }, request.ip);
      await outbox(client, 'supplier.status_changed', 'supplier', userId, { userId, status: body.status });
      return { userId, status: body.status };
    });
  });

  app.get('/api/v1/supplier-profile', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ userId: z.uuid().optional() }).parse(request.query);
    const privileged = user.permissions.includes('suppliers:manage');
    const userId = privileged && query.userId ? query.userId : user.id;
    const profile = await one(pool, 'SELECT * FROM supplier_profiles WHERE user_id = $1', [userId]);
    if (!profile) throw notFound();
    const documents = await pool.query(
      'SELECT id,doc_type,title,file_meta,verified,created_at FROM supplier_documents WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return { ...profile, documents: documents.rows };
  });

  app.patch('/api/v1/supplier-profile', async (request) => {
    const user = await principal(request, pool, config);
    const body = profilePatch.parse(request.body);
    const privileged = user.permissions.includes('suppliers:manage');
    // Approval policy (Req 339-340): legal/bank/tax data never changes directly — it goes through
    // POST /supplier-profile/change-requests → admin diff review → new version.
    const SENSITIVE = ['legalName', 'nationalId', 'registrationNumber', 'economicCode', 'taxInfo', 'bankName', 'accountNumber', 'bankIban', 'accountHolder'];
    const blocked = Object.keys(body).filter((key) => SENSITIVE.includes(key));
    if (blocked.length && !privileged) {
      throw badRequest('تغییر اطلاعات حقوقی، بانکی و مالیاتی نیاز به تأیید مدیریت دارد؛ از «درخواست تغییر اطلاعات حساس» استفاده کنید.');
    }
    return transaction(pool, async (client) => {
      const current = await one<{ version: number }>(client, 'SELECT version FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [user.id]);
      if (!current) throw notFound();
      const updates: string[] = [];
      const values: unknown[] = [user.id];
      for (const [key, column] of Object.entries(columnMap)) {
        const value = (body as Record<string, unknown>)[key];
        if (value === undefined) continue;
        if (column === 'commission_percent' && !privileged) continue;
        values.push(Array.isArray(value) ? value : value);
        updates.push(`${column} = $${values.length}`);
      }
      if (!updates.length) throw badRequest('تغییری برای ذخیره وجود ندارد.');
      await client.query(`UPDATE supplier_profiles SET ${updates.join(', ')}, version = version + 1, updated_at = now() WHERE user_id = $1`,
        values);
      await snapshotVersion(client, user.id, user.id, body.changeNote);
      await audit(client, user.id, 'supplier.profile_updated', 'supplier', user.id,
        { version: current.version }, { fields: Object.keys(body).filter((key) => key !== 'changeNote') }, request.ip);
      return one(client, 'SELECT * FROM supplier_profiles WHERE user_id = $1', [user.id]);
    });
  });

  app.get('/api/v1/supplier-profile/versions', async (request) => {
    const user = await principal(request, pool, config);
    const rows = await pool.query(
      `SELECT version,snapshot,change_note,changed_by,created_at FROM supplier_profile_versions
       WHERE user_id = $1 ORDER BY version DESC LIMIT 50`, [user.id]);
    return { items: rows.rows };
  });

  app.post('/api/v1/supplier-profile/documents', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      docType: z.enum(['license', 'company_doc', 'bank_doc', 'contract', 'identity', 'other']),
      title: z.string().trim().min(2).max(200),
      fileMeta: z.record(z.string(), z.unknown()).default({}),
    }).strict().parse(request.body);
    const id = randomUUID();
    await pool.query('INSERT INTO supplier_documents(id,user_id,doc_type,title,file_meta) VALUES ($1,$2,$3,$4,$5)',
      [id, user.id, body.docType, body.title, JSON.stringify(body.fileMeta)]);
    await transaction(pool, (client) => audit(client, user.id, 'supplier.document_added', 'supplier_document', id, undefined, { title: body.title }, request.ip));
    return reply.code(201).send({ id, docType: body.docType, title: body.title, verified: false });
  });

  app.post('/api/v1/admin/suppliers/:userId/documents/:docId/verify', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'suppliers:manage');
    const params = z.object({ userId: z.uuid(), docId: z.uuid() }).parse(request.params);
    const body = z.object({ verified: z.boolean() }).strict().parse(request.body);
    const updated = await pool.query(
      'UPDATE supplier_documents SET verified = $3, verified_by = $4 WHERE id = $2 AND user_id = $1 RETURNING id, verified',
      [params.userId, params.docId, body.verified, user.id]);
    if (!updated.rows[0]) throw notFound();
    await transaction(pool, (client) => audit(client, user.id, 'supplier.document_verified', 'supplier_document', params.docId,
      undefined, { verified: body.verified }, request.ip));
    return updated.rows[0];
  });
}
