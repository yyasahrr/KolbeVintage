/* Supplier 360 (items 11-14).
 *
 * One page per supplier that answers "what is this supplier, what may they do,
 * what do we owe them and what happened" — all assembled server-side from the
 * real domains (products, orders, invoices, ledger statement, documents, audit
 * log, restrictions). Numbers are never computed in the browser.
 *
 * Restrictions are enforced on the server: catalog, orders, wallet and finance
 * all call `assertSupplierMay`, and every blocked attempt is written to the
 * audit log so it shows up in the 360° timeline.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';

export const ACTIVITY_STATUSES = ['pending_review', 'active', 'restricted', 'suspended', 'blocked', 'rejected'] as const;
export const RESTRICTION_SCOPES = ['product_create', 'product_edit', 'product_publish', 'order_intake',
  'withdrawal', 'settlement_request', 'product_limit', 'sales_limit', 'feature'] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export type RestrictionScope = (typeof RESTRICTION_SCOPES)[number];

const STATUS_LABEL: Record<ActivityStatus, string> = {
  pending_review: 'در انتظار بررسی',
  active: 'فعال',
  restricted: 'محدودشده',
  suspended: 'تعلیق‌شده',
  blocked: 'مسدود',
  rejected: 'ردشده',
};

/** Which product/order actions a status forbids outright. */
const STATUS_BLOCKS: Record<ActivityStatus, string[] | 'all'> = {
  pending_review: ['product_create', 'product_publish', 'settlement_request'],
  active: [],
  restricted: [],
  suspended: 'all',
  blocked: 'all',
  rejected: ['product_create', 'product_publish', 'product_edit'],
};

export type SupplierAction = 'product_create' | 'product_edit' | 'product_publish' | 'order_intake'
  | 'withdrawal' | 'settlement_request' | 'feature';

/**
 * Server-side gate used by every supplier-facing mutation. Throws a 403 with a
 * Persian explanation for the reason.
 *
 * The blocked attempt is written to the audit log and the outbox **before** the
 * error is raised and on its own connection, so a rejected action is recorded
 * even though the request that tried to perform it never happens (item 12).
 * Call it before opening the transaction that performs the mutation.
 */
export async function assertSupplierMay(pool: DbPool, userId: string, action: SupplierAction,
  meta: { resource?: string; resourceId?: string; ip?: string } = {}) {
  const client = await pool.connect();
  let blockedReason: string | null = null;
  try {
    await client.query('BEGIN');
    blockedReason = await supplierGate(client, userId, action);
    if (blockedReason) await recordBlockedAttempt(client, userId, action, blockedReason, meta);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (blockedReason) throw forbidden(`این عملیات برای تأمین‌کننده مجاز نیست: ${blockedReason}`);
}

/**
 * The same gate for code that already runs inside a transaction. The audit row
 * shares that transaction, so prefer {@link assertSupplierMay} in routes.
 */
export async function assertSupplierMayClient(client: PoolClient, userId: string, action: SupplierAction,
  meta: { resource?: string; resourceId?: string; ip?: string } = {}) {
  const reason = await supplierGate(client, userId, action);
  if (reason) {
    await recordBlockedAttempt(client, userId, action, reason, meta);
    throw forbidden(`این عملیات برای تأمین‌کننده مجاز نیست: ${reason}`);
  }
}

/** Evaluates status + restrictions; heals an expired temporary restriction. */
async function supplierGate(client: PoolClient, userId: string, action: SupplierAction): Promise<string | null> {
  const profile = await one<{ activity_status: ActivityStatus; activity_reason: string | null; activity_restricted_until: Date | null }>(client,
    'SELECT activity_status, activity_reason, activity_restricted_until FROM supplier_profiles WHERE user_id = $1', [userId]);
  if (!profile) return null; // not a supplier (staff/buyer) — other guards apply
  const restrictions = (await client.query<{ scope: RestrictionScope; reason: string; expires_at: Date | null }>(
    `SELECT scope, reason, expires_at FROM supplier_restrictions
      WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`, [userId])).rows;
  const statusGates = STATUS_BLOCKS[profile.activity_status];
  const blockedByStatus = statusGates === 'all' || statusGates.includes(action);
  const blockedByScope = restrictions.some((restriction) =>
    restriction.scope === action || (action === 'product_create' && restriction.scope === 'product_publish'));
  const expiredTemporary = profile.activity_restricted_until && profile.activity_restricted_until.getTime() <= Date.now();
  if ((blockedByStatus || blockedByScope) && !(expiredTemporary && profile.activity_status === 'restricted')) {
    return restrictions.find((restriction) => restriction.scope === action)?.reason
      ?? profile.activity_reason ?? STATUS_LABEL[profile.activity_status];
  }
  if (expiredTemporary && profile.activity_status === 'restricted') {
    await client.query("UPDATE supplier_profiles SET activity_status = 'active', activity_restricted_until = NULL, activity_changed_at = now() WHERE user_id = $1", [userId]);
    await client.query(
      `INSERT INTO supplier_status_history(id, user_id, from_status, to_status, reason, note)
       VALUES ($1,$2,'restricted','active','پایان محدودیت زمانی','رفع خودکار محدودیت موقت')`, [randomUUID(), userId]);
  }
  return null;
}

async function recordBlockedAttempt(client: PoolClient, userId: string, action: SupplierAction, reason: string,
  meta: { resource?: string; resourceId?: string; ip?: string }) {
  await audit(client, null, 'supplier.action_blocked', 'supplier', userId, undefined,
    { action, reason, resource: meta.resource ?? null, resourceId: meta.resourceId ?? null }, meta.ip);
  await client.query(
    `INSERT INTO outbox_events(id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1,'supplier.action_blocked','supplier',$2,$3)`,
    [randomUUID(), userId, JSON.stringify({ action, reason, resource: meta.resource ?? null, resourceId: meta.resourceId ?? null })]);
}

/** Product-count cap and sales cap (item 13) — returns a violation message or null. */
export async function supplierCapViolation(client: PoolClient, userId: string, kind: 'product_limit' | 'sales_limit',
  incoming?: bigint) {
  const restriction = await one<{ limit_value: string | null; reason: string }>(client,
    `SELECT limit_value::text, reason FROM supplier_restrictions
      WHERE user_id = $1 AND scope = $2 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC LIMIT 1`, [userId, kind]);
  if (!restriction?.limit_value) return null;
  const limit = BigInt(restriction.limit_value);
  if (kind === 'product_limit') {
    const count = await one<{ count: string }>(client,
      `SELECT COUNT(*)::text AS count FROM products WHERE supplier_id = $1 AND status <> 'archived'`, [userId]);
    if (BigInt(count?.count ?? '0') >= limit) return `${restriction.reason} (سقف محصول: ${limit.toString()})`;
    return null;
  }
  const sales = await one<{ total: string }>(client,
    `SELECT COALESCE(SUM(ol.line_total_rial), 0)::text AS total
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE ol.supplier_id = $1 AND o.status NOT IN ('cancelled','pending_payment')
        AND o.created_at >= date_trunc('month', now())`, [userId]);
  const projected = BigInt(sales?.total ?? '0') + (incoming ?? 0n);
  if (projected > limit) return `${restriction.reason} (سقف فروش ماه: ${limit.toString()})`;
  return null;
}

const statusBody = z.object({
  status: z.enum(ACTIVITY_STATUSES),
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(1000).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
}).strict();

export function registerSupplier360Routes(app: FastifyInstance, pool: DbPool, config: Config) {
  /** The 360° payload: profile, restrictions, finance, performance, timeline (items 11/12/14). */
  app.get('/api/v1/admin/suppliers/:id/360', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }).parse(request.query);
    const user = await one<Record<string, unknown>>(pool,
      `SELECT u.id, u.display_name, u.phone, u.email, u.status, u.created_at,
              p.brand_name, p.legal_name, p.person_type, p.national_id, p.economic_code, p.business_phone,
              p.bank_iban, p.bank_name, p.account_number, p.account_holder, p.product_categories, p.shipping_cities,
              p.lead_time_days, p.min_order_quantity, p.settlement_terms, p.sla, p.commission_percent,
              p.cooperation_status, p.contract_status, p.activity_status, p.activity_reason, p.activity_note,
              p.activity_restricted_until, p.activity_changed_at, p.version, p.updated_at
         FROM users u LEFT JOIN supplier_profiles p ON p.user_id = u.id WHERE u.id = $1`, [id]);
    if (!user) throw notFound();
    if (user.brand_name === null && user.legal_name === null && user.activity_status === null) throw notFound();

    const [restrictions, finance, products, orders, invoices, documents, versions, statusHistory, auditTrail, caps] = await Promise.all([
      pool.query(`SELECT r.*, c.display_name AS created_by_name, l.display_name AS lifted_by_name
                    FROM supplier_restrictions r LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users l ON l.id = r.lifted_by
                   WHERE r.user_id = $1 ORDER BY r.created_at DESC`, [id]),
      one<Record<string, string>>(pool, `SELECT * FROM supplier_finance_accounts WHERE user_id = $1`, [id]),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM products WHERE supplier_id = $1 GROUP BY 1`, [id]),
      pool.query(
        `SELECT COUNT(*)::int AS orders, COALESCE(SUM(ol.line_total_rial),0)::text AS gross_rial,
                COUNT(DISTINCT o.id)::int AS order_count
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id
          WHERE ol.supplier_id = $1 AND o.created_at >= now() - ($2 || ' days')::interval
            AND o.status NOT IN ('cancelled','pending_payment')`, [id, String(query.days)]),
      pool.query(
        `SELECT COUNT(*)::int AS invoices, COALESCE(SUM(i.total_rial),0)::text AS total_rial,
                COUNT(*) FILTER (WHERE i.status IN ('issued','partially_paid'))::int AS open_count
           FROM invoices i WHERE i.party_user_id = $1 AND i.created_at >= now() - ($2 || ' days')::interval`,
        [id, String(query.days)]),
      pool.query(`SELECT id, doc_type, title, verified, verified_by, created_at FROM supplier_documents WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      pool.query(`SELECT version, change_note, changed_by, created_at FROM supplier_profile_versions WHERE user_id = $1 ORDER BY version DESC LIMIT 20`, [id]),
      pool.query(`SELECT h.*, a.display_name AS actor_name FROM supplier_status_history h LEFT JOIN users a ON a.id = h.actor_id
                   WHERE h.user_id = $1 ORDER BY h.created_at DESC LIMIT 50`, [id]),
      pool.query(
        `SELECT l.id, l.action, l.resource_type, l.resource_id, l.old_value, l.new_value, l.ip, l.created_at, a.display_name AS actor_name
           FROM audit_logs l LEFT JOIN users a ON a.id = l.actor_id
          WHERE (l.resource_type = 'supplier' AND l.resource_id = $1::text)
             OR (l.actor_id = $1::uuid AND l.action LIKE 'supplier.%')
             OR (l.resource_type IN ('product','invoice','settlement','shipment') AND l.resource_id IN (
                   SELECT p.id::text FROM products p WHERE p.supplier_id = $1::uuid))
          ORDER BY l.created_at DESC LIMIT 100`, [id]),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM supplier_restrictions r WHERE r.user_id = $1 AND r.status = 'active' AND r.scope = 'product_limit') AS product_caps,
           (SELECT COUNT(*)::int FROM supplier_restrictions r WHERE r.user_id = $1 AND r.status = 'active' AND r.scope = 'sales_limit') AS sales_caps`, [id]),
    ]);

    const performance = await one<Record<string, string>>(pool,
      `SELECT
         (SELECT COUNT(*)::int FROM orders o JOIN order_lines ol ON ol.order_id = o.id
           WHERE ol.supplier_id = $1 AND o.status = 'delivered') AS delivered_lines,
         (SELECT COUNT(*)::int FROM orders o JOIN order_lines ol ON ol.order_id = o.id
           WHERE ol.supplier_id = $1 AND o.status = 'cancelled') AS cancelled_lines,
         (SELECT COUNT(*)::int FROM return_requests r JOIN order_lines ol ON ol.id = r.order_line_id
           WHERE ol.supplier_id = $1) AS return_requests,
         -- Fulfillment speed measured from the real order events, not from UI input.
         (SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (e.created_at - o.created_at)) / 86400)::numeric, 1), 0)::text
            FROM orders o
            JOIN order_lines ol ON ol.order_id = o.id
            JOIN order_events e ON e.order_id = o.id AND e.to_status = 'delivered'
           WHERE ol.supplier_id = $1) AS avg_delivery_days,
         (SELECT COUNT(DISTINCT o.id)::int FROM orders o JOIN order_lines ol ON ol.order_id = o.id
           WHERE ol.supplier_id = $1 AND o.status = 'returned') AS returned_orders,
         (SELECT COUNT(*)::int FROM settlement_exceptions e JOIN settlements s ON s.id = e.settlement_id
           WHERE s.party_user_id = $1 AND e.status = 'open') AS open_exceptions,
         (SELECT COUNT(*)::int FROM orders o JOIN order_lines ol ON ol.order_id = o.id
           WHERE ol.supplier_id = $1 AND o.created_at >= now() - interval '30 days'
             AND o.status NOT IN ('cancelled','pending_return')) AS orders_30d`, [id]);

    return {
      supplier: user,
      status: {
        current: user.activity_status ?? 'pending_review',
        label: STATUS_LABEL[(user.activity_status as ActivityStatus) ?? 'pending_review'],
        reason: user.activity_reason ?? null,
        note: user.activity_note ?? null,
        restrictedUntil: user.activity_restricted_until ?? null,
        changedAt: user.activity_changed_at ?? null,
      },
      restrictions: restrictions.rows,
      caps: caps.rows[0],
      finance: finance ?? {
        user_id: id, gross_sales_rial: '0', net_sales_rial: '0', commission_rial: '0', pending_payable_rial: '0',
        available_payable_rial: '0', blocked_rial: '0', settled_rial: '0', withdrawn_rial: '0', prepayments_rial: '0',
      },
      financeSummary: { payableRial: finance?.pending_payable_rial ?? '0', availableRial: finance?.available_payable_rial ?? '0',
        blockedRial: finance?.blocked_rial ?? '0', settledRial: finance?.settled_rial ?? '0' },
      performance: { ...(performance ?? {}), products: products.rows, orders: orders.rows[0], invoices: invoices.rows[0] },
      documents: documents.rows,
      profileVersions: versions.rows,
      statusHistory: statusHistory.rows,
      timeline: auditTrail.rows.map((row) => ({
        id: row.id, at: row.created_at, action: row.action, resourceType: row.resource_type,
        resourceId: row.resource_id, actor: row.actor_name, detail: row.new_value ?? row.old_value ?? null, ip: row.ip,
      })),
      range: { days: query.days, from: new Date(Date.now() - query.days * 86400_000).toISOString() },
    };
  });

  /** Change the activity status with a mandatory reason, duration and audit trail (items 11/12). */
  app.post('/api/v1/admin/suppliers/:id/activity-status', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = statusBody.parse(request.body);
    if (body.status === 'active' && !body.note) throw badRequest('برای فعال‌سازی، یادداشت توضیحی لازم است.');
    return transaction(pool, async (client) => {
      const profile = await one<{ activity_status: ActivityStatus; activity_reason: string | null }>(client,
        'SELECT activity_status, activity_reason FROM supplier_profiles WHERE user_id = $1 FOR UPDATE', [id]);
      if (!profile) throw notFound();
      if (profile.activity_status === body.status && !body.durationDays) return { userId: id, status: body.status };
      const restrictedUntil = body.durationDays ? new Date(Date.now() + body.durationDays * 86400_000) : null;
      await client.query(
        `UPDATE supplier_profiles SET activity_status = $2, activity_reason = $3, activity_note = $4,
           activity_restricted_until = $5, activity_changed_at = now(), activity_changed_by = $6,
           version = version + 1, updated_at = now()
         WHERE user_id = $1`, [id, body.status, body.reason, body.note ?? null, restrictedUntil, actor.id]);
      await client.query(
        `INSERT INTO supplier_status_history(id, user_id, from_status, to_status, reason, note, restricted_until, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), id, profile.activity_status, body.status, body.reason, body.note ?? null, restrictedUntil, actor.id]);
      if (body.status === 'suspended' || body.status === 'blocked') {
        const existing = await one<{ id: string }>(client,
          `SELECT id FROM supplier_restrictions WHERE user_id = $1 AND scope = 'feature' AND status = 'active' LIMIT 1`, [id]);
        if (!existing) {
          await client.query(
            `INSERT INTO supplier_restrictions(id, user_id, scope, reason, note, expires_at, created_by)
             VALUES ($1,$2,'feature',$3,$4,$5,$6)`,
            [randomUUID(), id, body.reason, `وضعیت ${STATUS_LABEL[body.status]}`, restrictedUntil, actor.id]);
        }
      }
      if (body.status === 'active') {
        await client.query("UPDATE supplier_restrictions SET status = 'lifted', lifted_by = $2, lifted_at = now() WHERE user_id = $1 AND status = 'active' AND scope = 'feature'",
          [id, actor.id]);
      }
      await audit(client, actor.id, 'supplier.activity_status_changed', 'supplier', id,
        { status: profile.activity_status, reason: profile.activity_reason }, { status: body.status, reason: body.reason, restrictedUntil }, request.ip);
      await client.query(
        `INSERT INTO outbox_events(id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1,'supplier.status_changed','supplier',$2,$3)`,
        [randomUUID(), id, JSON.stringify({ userId: id, status: body.status, reason: body.reason, restrictedUntil })]);
      return { userId: id, status: body.status, label: STATUS_LABEL[body.status], restrictedUntil };
    });
  });

  app.get('/api/v1/admin/suppliers/:id/status-history', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT h.*, a.display_name AS actor_name FROM supplier_status_history h LEFT JOIN users a ON a.id = h.actor_id
        WHERE h.user_id = $1 ORDER BY h.created_at DESC LIMIT 100`, [id]);
    return { items: rows.rows };
  });

  /** Granular restriction management (item 13). */
  app.get('/api/v1/admin/suppliers/:id/restrictions', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT r.*, c.display_name AS created_by_name FROM supplier_restrictions r
        LEFT JOIN users c ON c.id = r.created_by WHERE r.user_id = $1 ORDER BY r.created_at DESC`, [id]);
    return { items: rows.rows, scopes: RESTRICTION_SCOPES };
  });

  app.post('/api/v1/admin/suppliers/:id/restrictions', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      scope: z.enum(RESTRICTION_SCOPES),
      reason: z.string().trim().min(3).max(500),
      note: z.string().trim().max(1000).optional(),
      limitValue: z.string().regex(/^\d+$/).optional(),
      durationDays: z.number().int().min(1).max(365).optional(),
      featureCode: z.string().trim().max(60).optional(),
    }).strict().parse(request.body);
    if ((body.scope === 'product_limit' || body.scope === 'sales_limit') && !body.limitValue) {
      throw badRequest('برای سقف‌ها باید مقدار حد مجاز تعیین شود.');
    }
    const result = await transaction(pool, async (client) => {
      const profile = await one<{ activity_status: string }>(client, 'SELECT activity_status FROM supplier_profiles WHERE user_id = $1', [id]);
      if (!profile) throw notFound();
      const duplicate = await one<{ id: string }>(client,
        `SELECT id FROM supplier_restrictions WHERE user_id = $1 AND scope = $2 AND status = 'active'
           AND (expires_at IS NULL OR expires_at > now())`, [id, body.scope]);
      if (duplicate) throw conflict('برای این دامنه از قبل محدودیت فعال وجود دارد.');
      const expiresAt = body.durationDays ? new Date(Date.now() + body.durationDays * 86400_000) : null;
      const restrictionId = randomUUID();
      await client.query(
        `INSERT INTO supplier_restrictions(id, user_id, scope, feature_code, limit_value, reason, note, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [restrictionId, id, body.scope, body.featureCode ?? null, body.limitValue ?? null, body.reason,
          body.note ?? null, expiresAt, actor.id]);
      if (profile.activity_status === 'active' && body.scope !== 'feature'
        && (body.scope !== 'product_limit' && body.scope !== 'sales_limit')) {
        await client.query(
          `UPDATE supplier_profiles SET activity_status = 'restricted', activity_reason = $2, activity_restricted_until = $3,
             activity_changed_at = now(), activity_changed_by = $4, version = version + 1, updated_at = now() WHERE user_id = $1`,
          [id, body.reason, expiresAt, actor.id]);
        await client.query(
          `INSERT INTO supplier_status_history(id, user_id, from_status, to_status, reason, note, restricted_until, actor_id)
           VALUES ($1,$2,'active','restricted',$3,$4,$5,$6)`,
          [randomUUID(), id, body.reason, `محدودیت دامنه ${body.scope}`, expiresAt, actor.id]);
      }
      await audit(client, actor.id, 'supplier.restriction_created', 'supplier', id, undefined,
        { restrictionId, scope: body.scope, reason: body.reason, expiresAt, limitValue: body.limitValue ?? null }, request.ip);
      await client.query(
        `INSERT INTO outbox_events(id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1,'supplier.restricted','supplier',$2,$3)`,
        [randomUUID(), id, JSON.stringify({ scope: body.scope, expiresAt, limitValue: body.limitValue ?? null })]);
      return { id: restrictionId, scope: body.scope, expiresAt };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/v1/admin/suppliers/:id/restrictions/:restrictionId/lift', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:manage');
    const { id, restrictionId } = z.object({ id: z.uuid(), restrictionId: z.uuid() }).parse(request.params);
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(request.body);
    return transaction(pool, async (client) => {
      const restriction = await one<{ id: string; scope: string; status: string; limit_value: string | null }>(client,
        'SELECT id, scope, status, limit_value::text FROM supplier_restrictions WHERE id = $1 AND user_id = $2 FOR UPDATE', [restrictionId, id]);
      if (!restriction) throw notFound();
      if (restriction.status !== 'active') throw conflict('این محدودیت فعال نیست.');
      await client.query("UPDATE supplier_restrictions SET status = 'lifted', lifted_by = $2, lifted_at = now() WHERE id = $1", [restrictionId, actor.id]);
      const remaining = await one<{ count: string }>(client, "SELECT COUNT(*)::text AS count FROM supplier_restrictions WHERE user_id = $1 AND status = 'active'", [id]);
      if (Number(remaining?.count ?? '0') === 0) {
        await client.query(
          `UPDATE supplier_profiles SET activity_status = 'active', activity_reason = NULL, activity_restricted_until = NULL,
             activity_changed_at = now(), activity_changed_by = $2, version = version + 1, updated_at = now() WHERE user_id = $1`,
          [id, actor.id]);
        await client.query(
          `INSERT INTO supplier_status_history(id, user_id, from_status, to_status, reason, note, actor_id)
           VALUES ($1,$2,'restricted','active',$3,$4,$5)`, [randomUUID(), id, body.note, 'رفع آخرین محدودیت', actor.id]);
      }
      await audit(client, actor.id, 'supplier.restriction_lifted', 'supplier', id,
        { restrictionId, scope: restriction.scope }, { note: body.note }, request.ip);
      return { id: restrictionId, status: 'lifted', remainingActive: Number(remaining?.count ?? '0') };
    });
  });

  /** Performance + finance drill-down links used by the 360° page (items 12/14). */
  app.get('/api/v1/admin/suppliers/:id/finance', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'supplier360:read');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(20) }).parse(request.query);
    const account = await one<Record<string, string>>(pool, 'SELECT * FROM supplier_finance_accounts WHERE user_id = $1', [id]);
    const statement = await pool.query(
      `SELECT id, occurred_at, event, direction, amount_rial::text, balance_after_rial::text, reference, description,
              order_id, invoice_id, settlement_id
         FROM supplier_ledger_entries WHERE supplier_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`, [id, query.limit]);
    const settlements = await pool.query(
      `SELECT id, reference, status, reconciliation_status, net_rial::text, created_at, paid_at
         FROM settlements WHERE party_user_id = $1 ORDER BY created_at DESC LIMIT $2`, [id, query.limit]);
    return {
      account,
      entries: statement.rows,
      settlements: settlements.rows,
      links: {
        statement: `/api/v1/admin/finance/suppliers/${id}/statement`,
        settlements: `/api/v1/admin/finance/settlements?supplierId=${id}`,
        report: '/api/v1/admin/finance/reports/supplier_finance?format=xlsx',
      },
    };
  });
}

/** Guard helper for supplier-owned resources (used by catalog/inventory). */
export async function assertSupplierOwnsProduct(client: PoolClient, userId: string, productId: string) {
  const product = await one<{ supplier_id: string | null }>(client, 'SELECT supplier_id FROM products WHERE id = $1', [productId]);
  if (!product) throw notFound();
  if (product.supplier_id && product.supplier_id !== userId) throw forbidden();
  return product;
}
