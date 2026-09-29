import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbClient, type DbPool } from './db.js';
import { asRial, roundRial } from './money.js';
import { audit } from './operations.js';
import { emitEvent } from './events.js';
import { badRequest, conflict, notFound } from './errors.js';
import { blockQueuedMarketingSms } from './sms-queue.js';

/* CRM intelligence (items 20-21, 95-100, 108, 136-143).
   Labels are manual *and* rule-based, rules are evaluated on the server against
   canonical customer data, segments are dynamic query-builder definitions, and
   every SMS campaign is gated by marketing consent. */

/* ----------------------------- metrics engine ----------------------------- */

export type CustomerMetrics = {
  userId: string; displayName: string; phone: string | null; createdAt: string;
  orderCount: number; totalSpent: number; averageOrder: number; maxOrder: number;
  lastOrderAt: string | null; daysSinceLastOrder: number | null; registerDays: number;
  cancelled: number; returns: number; failedPayments: number; couponsUsed: number; couponsPercent: number;
  membershipStatus: string | null; membershipEndsAt: string | null; membershipDaysLeft: number | null;
  planCode: string | null; planTier: number | null; actorType: string; city: string | null; vipLevel: string;
  categories: string[]; colors: string[]; sizes: string[];
};

const METRICS_SQL = `
  WITH order_stats AS (
    SELECT buyer_id,
           count(*)::int AS order_count,
           COALESCE(sum(total_rial), 0)::bigint AS total_spent,
           COALESCE(avg(total_rial), 0)::bigint AS average_order,
           COALESCE(max(total_rial), 0)::bigint AS max_order,
           max(created_at) AS last_order_at,
           count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
    FROM orders GROUP BY buyer_id
  ),
  return_stats AS (SELECT requester_id, count(*)::int AS returns FROM return_requests GROUP BY requester_id),
  payment_stats AS (
    SELECT o.buyer_id, count(*)::int AS failed_payments
    FROM payment_intents p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'failed' GROUP BY o.buyer_id
  ),
  coupon_stats AS (SELECT user_id, count(*)::int AS coupons_used FROM coupon_redemptions GROUP BY user_id),
  interests AS (
    SELECT o.buyer_id,
           array_remove(array_agg(DISTINCT p.category), NULL) AS categories,
           array_remove(array_agg(DISTINCT v.color_label), NULL) AS colors,
           array_remove(array_agg(DISTINCT v.size_label), NULL) AS sizes
    FROM orders o JOIN order_lines l ON l.order_id = o.id
    JOIN products p ON p.id = l.product_id JOIN product_variants v ON v.id = l.variant_id
    GROUP BY o.buyer_id
  )
  SELECT u.id AS user_id, u.display_name, u.phone, u.created_at,
         COALESCE(os.order_count,0) AS order_count, COALESCE(os.total_spent,0) AS total_spent,
         COALESCE(os.average_order,0) AS average_order, COALESCE(os.max_order,0) AS max_order,
         os.last_order_at, COALESCE(os.cancelled,0) AS cancelled,
         COALESCE(rs.returns,0) AS returns, COALESCE(ps.failed_payments,0) AS failed_payments,
         COALESCE(cs.coupons_used,0) AS coupons_used,
         m.status AS membership_status, m.ends_at AS membership_ends_at,
         mp.code AS plan_code, mp.tier AS plan_tier,
         COALESCE(c.actor_type,'customer') AS actor_type, bp.city, COALESCE(bp.vip_level,'none') AS vip_level,
         COALESCE(i.categories, ARRAY[]::text[]) AS categories,
         COALESCE(i.colors, ARRAY[]::text[]) AS colors,
         COALESCE(i.sizes, ARRAY[]::text[]) AS sizes
  FROM users u
  LEFT JOIN order_stats os ON os.buyer_id = u.id
  LEFT JOIN return_stats rs ON rs.requester_id = u.id
  LEFT JOIN payment_stats ps ON ps.buyer_id = u.id
  LEFT JOIN coupon_stats cs ON cs.user_id = u.id
  LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
  LEFT JOIN membership_plans mp ON mp.id = m.plan_id
  LEFT JOIN crm_contacts c ON c.user_id = u.id
  LEFT JOIN buyer_profiles bp ON bp.user_id = u.id
  LEFT JOIN interests i ON i.buyer_id = u.id
`;

type MetricsRow = Record<string, unknown>;

/** Display strings for money; the numeric fields stay for rule comparisons. */
export const moneyView = (row: MetricsRow) => ({
  totalSpentRial: roundRial(row.total_spent),
  averageOrderRial: roundRial(row.average_order),
  maxOrderRial: roundRial(row.max_order),
});

export function toMetrics(row: MetricsRow, now = new Date()): CustomerMetrics {
  const createdAt = new Date(String(row.created_at));
  const lastOrderAt = row.last_order_at ? new Date(String(row.last_order_at)) : null;
  const endsAt = row.membership_ends_at ? new Date(String(row.membership_ends_at)) : null;
  const totalSpent = Number(row.total_spent ?? 0);
  const orders = Number(row.order_count ?? 0);
  const couponsUsed = Number(row.coupons_used ?? 0);
  return {
    userId: String(row.user_id), displayName: String(row.display_name ?? ''), phone: (row.phone as string) ?? null,
    createdAt: createdAt.toISOString(),
    orderCount: orders, totalSpent, averageOrder: Number(row.average_order ?? 0), maxOrder: Number(row.max_order ?? 0),
    lastOrderAt: lastOrderAt ? lastOrderAt.toISOString() : null,
    daysSinceLastOrder: lastOrderAt ? Math.floor((now.getTime() - lastOrderAt.getTime()) / 86_400_000) : null,
    registerDays: Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000),
    cancelled: Number(row.cancelled ?? 0), returns: Number(row.returns ?? 0),
    failedPayments: Number(row.failed_payments ?? 0), couponsUsed,
    couponsPercent: orders ? Math.round((couponsUsed / orders) * 100) : 0,
    membershipStatus: (row.membership_status as string) ?? null,
    membershipEndsAt: endsAt ? endsAt.toISOString() : null,
    membershipDaysLeft: endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000) : null,
    planCode: (row.plan_code as string) ?? null, planTier: row.plan_tier === null || row.plan_tier === undefined ? null : Number(row.plan_tier),
    actorType: String(row.actor_type ?? 'customer'), city: (row.city as string) ?? null, vipLevel: String(row.vip_level ?? 'none'),
    categories: (row.categories as string[]) ?? [], colors: (row.colors as string[]) ?? [], sizes: (row.sizes as string[]) ?? [],
  };
}

export type RuleCondition = { field: string; op: string; value: unknown };

export const CONDITION_FIELDS = [
  'order_count', 'total_spent', 'average_order', 'max_order', 'days_since_last_order', 'register_days',
  'cancelled_orders', 'returns_count', 'failed_payments', 'coupons_used', 'coupons_percent',
  'membership_status', 'membership_days_left', 'plan_code', 'plan_tier', 'actor_type', 'city',
  'vip_level', 'category_interest', 'color_interest', 'size_interest',
] as const;

const metricValue = (metrics: CustomerMetrics, field: string): unknown => {
  switch (field) {
    case 'order_count': return metrics.orderCount;
    case 'total_spent': return metrics.totalSpent;
    case 'average_order': return metrics.averageOrder;
    case 'max_order': return metrics.maxOrder;
    case 'days_since_last_order': return metrics.daysSinceLastOrder;
    case 'register_days': return metrics.registerDays;
    case 'cancelled_orders': return metrics.cancelled;
    case 'returns_count': return metrics.returns;
    case 'failed_payments': return metrics.failedPayments;
    case 'coupons_used': return metrics.couponsUsed;
    case 'coupons_percent': return metrics.couponsPercent;
    case 'membership_status': return metrics.membershipStatus;
    case 'membership_days_left': return metrics.membershipDaysLeft;
    case 'plan_code': return metrics.planCode;
    case 'plan_tier': return metrics.planTier;
    case 'actor_type': return metrics.actorType;
    case 'city': return metrics.city;
    case 'vip_level': return metrics.vipLevel;
    case 'category_interest': return metrics.categories;
    case 'color_interest': return metrics.colors;
    case 'size_interest': return metrics.sizes;
    default: return undefined;
  }
};

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

/** Pure, testable rule evaluation (requirement 21: the engine is server-side). */
export function evaluateConditions(metrics: CustomerMetrics, conditions: RuleCondition[], matchMode: 'all' | 'any' = 'all'): boolean {
  if (!conditions.length) return false;
  const results = conditions.map((condition) => {
    const actual = metricValue(metrics, condition.field);
    if (actual === undefined) return false;
    const op = condition.op;
    if (['category_interest', 'color_interest', 'size_interest'].includes(condition.field)) {
      const haystack = Array.isArray(actual) ? (actual as string[]) : [];
      const wanted = Array.isArray(condition.value) ? (condition.value as unknown[]).map(String) : [String(condition.value)];
      return op === 'not_in' || op === '!=' ? wanted.every((item) => !haystack.includes(item)) : wanted.some((item) => haystack.includes(item));
    }
    if (op === 'in' || op === 'not_in') {
      const list = Array.isArray(condition.value) ? (condition.value as unknown[]).map(String) : [String(condition.value)];
      const current = String(actual ?? '');
      return op === 'in' ? list.includes(current) : !list.includes(current);
    }
    const left = asNumber(actual);
    const right = asNumber(condition.value);
    if (left === null && right === null) {
      const equal = String(actual ?? '') === String(condition.value ?? '');
      return op === '!=' ? !equal : equal;
    }
    if (op === 'contains') return String(actual ?? '').includes(String(condition.value ?? ''));
    if (left === null || right === null) return false;
    switch (op) {
      case '>=': return left >= right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '<': return left < right;
      case '=': return left === right;
      case '!=': return left !== right;
      default: return false;
    }
  });
  return matchMode === 'all' ? results.every(Boolean) : results.some(Boolean);
}

export function matchesDefinition(metrics: CustomerMetrics, definition: { matchMode?: 'all' | 'any'; conditions?: RuleCondition[]; rules?: RuleCondition[] }) {
  const conditions = definition.conditions ?? definition.rules ?? [];
  return evaluateConditions(metrics, conditions, definition.matchMode ?? 'all');
}

export async function loadMetrics(pool: DbPool | PoolClient, userId?: string): Promise<CustomerMetrics[]> {
  const rows = await (pool as DbPool).query<MetricsRow>(
    `${METRICS_SQL} WHERE ($1::uuid IS NULL OR u.id = $1) ORDER BY u.created_at DESC LIMIT 5000`, [userId ?? null]);
  return rows.rows.map((row) => toMetrics(row));
}

/** Canonical customer timeline writer (item 99) — reused by every domain. */
export async function recordTimeline(client: DbClient, input: {
  userId: string; eventType: string; title: string; description?: string; refType?: string | null;
  refId?: string | null; actorId?: string | null; source?: string; metadata?: Record<string, unknown>;
  occurredAt?: Date;
}) {
  await client.query(
    `INSERT INTO customer_timeline(id,user_id,event_type,title,description,ref_type,ref_id,actor_id,source,metadata,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()))`,
    [randomUUID(), input.userId, input.eventType, input.title, input.description ?? '', input.refType ?? null,
      input.refId ?? null, input.actorId ?? null, input.source ?? 'system', JSON.stringify(input.metadata ?? {}),
      input.occurredAt ?? null]);
}

/** Contact row for a user, created on demand — every domain can then log to CRM. */
export async function ensureContact(client: DbClient, userId: string, actorType = 'customer') {
  const existing = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
  if (existing) return existing.id;
  const id = randomUUID();
  await client.query('INSERT INTO crm_contacts(id,user_id,actor_type) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING',
    [id, userId, actorType]);
  const row = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
  return row!.id;
}

/** Requirement 143: marketing SMS only ever reaches consented phones. */
export async function consentedRecipients(client: DbClient, userIds: string[]) {
  if (!userIds.length) return [];
  const rows = await client.query<{ id: string; phone: string; display_name: string }>(
    `SELECT u.id, u.phone, u.display_name FROM users u
     LEFT JOIN customer_consents c ON c.user_id = u.id
     WHERE u.id = ANY($1::uuid[]) AND u.status = 'active' AND u.phone IS NOT NULL AND u.phone ~ '^09\\d{9}$'
       AND COALESCE(c.marketing_sms, false) AND NOT COALESCE(c.do_not_contact, false)`, [userIds]);
  return rows.rows;
}

const ruleBody = z.object({
  code: z.string().trim().regex(/^[a-z0-9_-]{3,40}$/),
  title: z.string().trim().min(2).max(140),
  labelCode: z.string().trim().min(2).max(40),
  status: z.enum(['draft', 'test', 'active', 'paused']).default('draft'),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(z.object({
    field: z.enum(CONDITION_FIELDS), op: z.enum(['>=', '<=', '>', '<', '=', '!=', 'in', 'not_in', 'contains']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  })).min(1).max(20),
  windowDays: z.number().int().min(1).max(3650).nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(100),
  requiresApproval: z.boolean().default(false),
}).strict();

export function registerCrmIntelligenceRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  /* ------------------------------- labels ------------------------------- */
  app.get('/api/v1/admin/crm/labels', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT l.*, (SELECT count(*)::int FROM crm_contact_labels cl WHERE cl.label_code = l.code) AS assigned_count
       FROM crm_labels l ORDER BY l.kind, l.code`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/labels', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = z.object({
      code: z.string().trim().regex(/^[a-z0-9_-]{2,40}$/), title: z.string().trim().min(2).max(80),
      kind: z.enum(['manual', 'behavioral']).default('manual'), description: z.string().trim().max(300).default(''),
      color: z.string().trim().max(20).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      await client.query('INSERT INTO crm_labels(code,title,kind,description,color) VALUES ($1,$2,$3,$4,$5)',
        [body.code, body.title, body.kind, body.description, body.color ?? null]);
      await audit(client, user.id, 'crm.label_created', 'crm_label', body.code, undefined, body, request.ip);
      return reply.code(201).send(body);
    });
  });

  /** The rule vocabulary is owned by the server so the builder cannot invent fields. */
  app.get('/api/v1/admin/crm/condition-fields', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    return { fields: CONDITION_FIELDS, operators: ['=', '!=', '>', '>=', '<', '<=', 'in', 'contains'] };
  });

  /* ----------------------------- label rules ----------------------------- */
  app.get('/api/v1/admin/crm/label-rules', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT r.*, l.title AS label_title FROM crm_label_rules r JOIN crm_labels l ON l.code = r.label_code
       ORDER BY r.priority, r.code`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/label-rules', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = ruleBody.parse(request.body);
    if (body.status === 'active' && body.requiresApproval) throw badRequest('قانون نیازمند تأیید ابتدا باید در وضعیت test بماند.');
    const id = randomUUID();
    return transaction(pool, async (client) => {
      const label = await one(client, 'SELECT code FROM crm_labels WHERE code = $1', [body.labelCode]);
      if (!label) throw notFound();
      await client.query(
        `INSERT INTO crm_label_rules(id,code,title,label_code,status,match_mode,conditions,window_days,priority,requires_approval,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, body.code, body.title, body.labelCode, body.status, body.matchMode, JSON.stringify(body.conditions),
          body.windowDays ?? null, body.priority, body.requiresApproval, user.id]);
      await audit(client, user.id, 'crm.label_rule_created', 'crm_label_rule', id, undefined, body, request.ip);
      return reply.code(201).send({ id, ...body });
    });
  });

  app.patch('/api/v1/admin/crm/label-rules/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = ruleBody.omit({ code: true }).partial().strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_label_rules WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      if (body.status === 'active' && before.requires_approval && !before.approved_at)
        throw conflict('این قانون نیازمند تأیید است؛ ابتدا با dry-run آن را تأیید کنید.');
      await client.query(
        `UPDATE crm_label_rules SET title = COALESCE($2,title), label_code = COALESCE($3,label_code), status = COALESCE($4,status),
           match_mode = COALESCE($5,match_mode), conditions = COALESCE($6,conditions), window_days = COALESCE($7,window_days),
           priority = COALESCE($8,priority), requires_approval = COALESCE($9,requires_approval), updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.labelCode ?? null, body.status ?? null, body.matchMode ?? null,
          body.conditions ? JSON.stringify(body.conditions) : null, body.windowDays ?? null, body.priority ?? null,
          body.requiresApproval ?? null]);
      await audit(client, user.id, 'crm.label_rule_updated', 'crm_label_rule', id, before, body, request.ip);
      return one(client, 'SELECT * FROM crm_label_rules WHERE id = $1', [id]);
    });
  });

  /**
   * Requirement 138 — dry run: "این قانون روی N کاربر Match می‌شود" with a sample,
   * before anything is activated or any coupon is issued.
   */
  app.post('/api/v1/admin/crm/label-rules/:id/dry-run', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rule = await one<Record<string, unknown>>(pool, 'SELECT * FROM crm_label_rules WHERE id = $1', [id]);
    if (!rule) throw notFound();
    const metrics = await loadMetrics(pool);
    const matched = metrics.filter((item) => evaluateConditions(item, rule.conditions as RuleCondition[], rule.match_mode as 'all' | 'any'));
    const sample = matched.slice(0, 10).map((item) => ({
      userId: item.userId, displayName: item.displayName, phone: item.phone,
      orderCount: item.orderCount, totalSpentRial: asRial(item.totalSpent), daysSinceLastOrder: item.daysSinceLastOrder,
    }));
    return {
      ruleId: id, matchCount: matched.length, totalCustomers: metrics.length, sample,
      activate: 'برای فعال‌سازی، وضعیت قانون را به active تغییر دهید.', dryRun: true,
    };
  });

  /** Apply a rule now (admin action) — the same implementation backs the worker sweep. */
  app.post('/api/v1/admin/crm/label-rules/:id/apply', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ approve: z.boolean().default(false) }).strict().parse(request.body ?? {});
    return applyLabelRule(pool, id, { actorId: user.id, approve: body.approve, ip: request.ip });
  });

  /* ----------------------------- segments ----------------------------- */
  app.get('/api/v1/admin/crm/segments', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT s.*, (SELECT count(*)::int FROM crm_segment_members m WHERE m.segment_id = s.id) AS current_members
       FROM crm_segments s ORDER BY s.created_at DESC`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/segments', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const body = z.object({
      code: z.string().trim().regex(/^[a-z0-9_.-]{3,40}$/), title: z.string().trim().min(2).max(120),
      description: z.string().trim().max(400).default(''),
      kind: z.enum(['dynamic', 'manual']).default('dynamic'),
      definition: z.object({
        matchMode: z.enum(['all', 'any']).default('all'),
        conditions: z.array(z.object({
          field: z.enum(CONDITION_FIELDS), op: z.enum(['>=', '<=', '>', '<', '=', '!=', 'in', 'not_in', 'contains']),
          value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
        })).default([]),
      }).strict().default({ matchMode: 'all', conditions: [] }),
      refreshIntervalMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
    }).strict().parse(request.body);
    const id = randomUUID();
    return transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO crm_segments(id,code,title,description,kind,definition,refresh_interval_minutes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, body.code, body.title, body.description, body.kind, JSON.stringify(body.definition),
          body.refreshIntervalMinutes ?? null, user.id]);
      await audit(client, user.id, 'crm.segment_created', 'crm_segment', id, undefined, body, request.ip);
      return reply.code(201).send({ id, ...body });
    });
  });

  app.patch('/api/v1/admin/crm/segments/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(400).optional(),
      definition: z.record(z.string(), z.unknown()).optional(), active: z.boolean().optional(),
      refreshIntervalMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_segments WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query(
        `UPDATE crm_segments SET title = COALESCE($2,title), description = COALESCE($3,description),
           definition = COALESCE($4,definition), active = COALESCE($5,active),
           refresh_interval_minutes = COALESCE($6,refresh_interval_minutes), updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.description ?? null, body.definition ? JSON.stringify(body.definition) : null,
          body.active ?? null, body.refreshIntervalMinutes ?? null]);
      await audit(client, user.id, 'crm.segment_updated', 'crm_segment', id, before, body, request.ip);
      return one(client, 'SELECT * FROM crm_segments WHERE id = $1', [id]);
    });
  });

  /** Refresh a dynamic segment: the query builder is resolved on the server. */
  app.post('/api/v1/admin/crm/segments/:id/refresh', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return refreshSegment(pool, id, user.id);
  });

  app.get('/api/v1/admin/crm/segments/:id/members', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT m.user_id,u.display_name,u.phone,m.matched_at,
              (SELECT COALESCE(sum(o.total_rial),0)::text FROM orders o WHERE o.buyer_id = m.user_id AND o.status <> 'cancelled') AS total_rial,
              (SELECT count(*)::int FROM orders o WHERE o.buyer_id = m.user_id) AS order_count
       FROM crm_segment_members m JOIN users u ON u.id = m.user_id
       WHERE m.segment_id = $1 ORDER BY m.matched_at DESC LIMIT 500`, [id]);
    return { items: rows.rows.map((row) => ({ ...row, total_rial: asRial(row.total_rial) })) };
  });

  /* ---------------------- notes, timeline, behaviour ---------------------- */
  app.get('/api/v1/admin/crm/contacts/:id/notes', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const rows = await pool.query(
      `SELECT n.id,n.body,n.visibility,n.created_at,n.edited_at,u.display_name AS author_name
       FROM crm_notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.contact_id = $1 AND n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 200`, [id]);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/contacts/:id/notes', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ body: z.string().trim().min(2).max(4000), visibility: z.enum(['internal', 'team']).default('internal') })
      .strict().parse(request.body);
    const noteId = randomUUID();
    return transaction(pool, async (client) => {
      const contact = await one<{ id: string; user_id: string }>(client, 'SELECT id,user_id FROM crm_contacts WHERE id = $1', [id]);
      if (!contact) throw notFound();
      await client.query('INSERT INTO crm_notes(id,contact_id,author_id,body,visibility) VALUES ($1,$2,$3,$4,$5)',
        [noteId, id, user.id, body.body, body.visibility]);
      await recordTimeline(client, { userId: contact.user_id, eventType: 'crm.note', title: 'یادداشت داخلی CRM',
        description: body.body.slice(0, 200), refType: 'crm_note', refId: noteId, actorId: user.id, source: 'crm' });
      await audit(client, user.id, 'crm.note_added', 'crm_contact', id, undefined, { noteId, visibility: body.visibility }, request.ip);
      return reply.code(201).send({ id: noteId, ...body });
    });
  });

  app.patch('/api/v1/admin/crm/notes/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({ body: z.string().trim().min(2).max(4000), visibility: z.enum(['internal', 'team']).optional() })
      .strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_notes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
      if (!before) throw notFound();
      await client.query('UPDATE crm_notes SET body = $2, visibility = COALESCE($3,visibility), edited_at = now() WHERE id = $1',
        [id, body.body, body.visibility ?? null]);
      await audit(client, user.id, 'crm.note_edited', 'crm_note', id, { body: before.body }, { body: body.body }, request.ip);
      return one(client, 'SELECT * FROM crm_notes WHERE id = $1', [id]);
    });
  });

  app.delete('/api/v1/admin/crm/notes/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return transaction(pool, async (client) => {
      const result = await client.query('UPDATE crm_notes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id]);
      if (!result.rowCount) throw notFound();
      await audit(client, user.id, 'crm.note_deleted', 'crm_note', id, undefined, undefined, request.ip);
      return { id, deleted: true };
    });
  });

  app.get('/api/v1/admin/crm/contacts/:id/timeline', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const contact = await one<{ user_id: string }>(pool, 'SELECT user_id FROM crm_contacts WHERE id = $1', [id]);
    if (!contact?.user_id) throw notFound();
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const rows = await pool.query(
      `SELECT t.id,t.event_type,t.title,t.description,t.ref_type,t.ref_id,t.source,t.metadata,t.occurred_at,
              u.display_name AS actor_name
       FROM customer_timeline t LEFT JOIN users u ON u.id = t.actor_id
       WHERE t.user_id = $1 ORDER BY t.occurred_at DESC LIMIT $2`, [contact.user_id, query.limit]);
    return { items: rows.rows };
  });

  /** Requirement 96: real purchase behaviour, computed from canonical data. */
  app.get('/api/v1/admin/crm/contacts/:id/behavior', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const contact = await one<{ user_id: string }>(pool, 'SELECT user_id FROM crm_contacts WHERE id = $1', [id]);
    if (!contact?.user_id) throw notFound();
    const metrics = (await loadMetrics(pool, contact.user_id))[0];
    if (!metrics) throw notFound();
    const products = await pool.query(
      `SELECT l.product_name, l.product_id, sum(l.quantity)::int AS quantity, count(DISTINCT o.id)::int AS orders
       FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.buyer_id = $1
       GROUP BY l.product_name, l.product_id ORDER BY quantity DESC LIMIT 10`, [contact.user_id]);
    const categories = await pool.query(
      `SELECT p.category, count(*)::int AS count FROM order_lines l JOIN orders o ON o.id = l.order_id
       JOIN products p ON p.id = l.product_id WHERE o.buyer_id = $1 GROUP BY p.category ORDER BY count DESC LIMIT 8`,
      [contact.user_id]);
    const coupons = await pool.query(
      `SELECT cr.discount_rial, cr.created_at, c.code FROM coupon_redemptions cr JOIN coupons c ON c.id = cr.coupon_id
       WHERE cr.user_id = $1 ORDER BY cr.created_at DESC LIMIT 10`, [contact.user_id]);
    const intervals = await pool.query<{ gap_days: number }>(
      `SELECT EXTRACT(EPOCH FROM (created_at - lag(created_at) OVER (ORDER BY created_at)))/86400 AS gap_days
       FROM orders WHERE buyer_id = $1 AND status <> 'cancelled' ORDER BY created_at`, [contact.user_id]);
    const gaps = intervals.rows.map((row) => Number(row.gap_days)).filter((value) => Number.isFinite(value));
    return {
      metrics: {
        ...metrics,
        orders: metrics.orderCount, totalSpentRial: String(metrics.totalSpent), averageOrderRial: String(Math.round(metrics.averageOrder)),
        maxOrderRial: asRial(metrics.maxOrder),
      },
      averagePurchaseIntervalDays: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
      products: products.rows, categories: categories.rows,
      coupons: coupons.rows.map((row) => ({ ...row, discount_rial: asRial(row.discount_rial) })),
    };
  });

  /** Requirement 95 + 108: the CRM 360 view including reviews written by the customer. */
  app.get('/api/v1/admin/crm/contacts/:id/360', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const contact = await one<Record<string, unknown>>(pool,
      `SELECT c.id,c.user_id,c.actor_type,c.segment,c.tags,c.metadata,c.created_at,c.updated_at,
              u.display_name,u.phone,u.email,u.birthday,u.created_at AS registered_at,u.status,
              cp.first_name,cp.last_name,cp.gender,cp.national_id,
              bp.business_name,bp.city,bp.vip_level,bp.credit_limit_rial,bp.blocked,bp.approval_policy,
              (SELECT max(created_at) FROM user_login_history h WHERE h.user_id = c.user_id AND h.success) AS last_login_at
       FROM crm_contacts c JOIN users u ON u.id = c.user_id
       LEFT JOIN customer_profiles cp ON cp.user_id = c.user_id
       LEFT JOIN buyer_profiles bp ON bp.user_id = c.user_id
       WHERE c.id = $1`, [id]);
    if (!contact) throw notFound();
    const userId = String(contact.user_id);
    const addresses = await pool.query(
      'SELECT id,title,recipient,phone,province,city,line,is_default FROM customer_addresses WHERE user_id = $1', [userId]);
    const membership = await one<Record<string, unknown>>(pool,
      `SELECT m.status,m.starts_at,m.ends_at,p.code,p.title,p.tier FROM memberships m
       JOIN membership_plans p ON p.id = m.plan_id WHERE m.user_id = $1 ORDER BY m.created_at DESC LIMIT 1`, [userId]);
    const labels = await pool.query(
      `SELECT cl.label_code,l.title FROM crm_contact_labels cl JOIN crm_labels l ON l.code = cl.label_code
       WHERE cl.contact_id = $1 AND (cl.expires_at IS NULL OR cl.expires_at > now()) ORDER BY cl.assigned_at DESC`, [id]);
    const segments = await pool.query(
      `SELECT s.code,s.title FROM crm_segment_members m JOIN crm_segments s ON s.id = m.segment_id WHERE m.user_id = $1`, [userId]);
    const reviews = await pool.query(
      `SELECT r.id,r.rating,r.title,r.comment,r.status,r.verified_purchase,r.created_at,p.name AS product_name
       FROM customer_reviews r JOIN products p ON p.id = r.product_id
       WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [userId]);
    const notes = await pool.query(
      `SELECT n.id,n.body,n.visibility,n.created_at,u.display_name AS author_name FROM crm_notes n
       LEFT JOIN users u ON u.id = n.author_id WHERE n.contact_id = $1 AND n.deleted_at IS NULL
       ORDER BY n.created_at DESC LIMIT 20`, [id]);
    const timeline = await pool.query(
      `SELECT id,event_type,title,source,occurred_at FROM customer_timeline WHERE user_id = $1
       ORDER BY occurred_at DESC LIMIT 50`, [userId]);
    const consent = await one<Record<string, unknown>>(pool, 'SELECT * FROM customer_consents WHERE user_id = $1', [userId]);
    return {
      contact, addresses: addresses.rows, membership, labels: labels.rows, segments: segments.rows,
      reviews: reviews.rows, notes: notes.rows, timeline: timeline.rows, consent,
    };
  });

  /* --------------- CRM ↔ promotion: campaigns targeted by label/segment --------------- */
  app.post('/api/v1/admin/crm/campaigns', async (request, reply) => {
    const user = await principal(request, pool, config); requirePermission(user, 'campaigns:manage');
    const body = z.object({
      title: z.string().trim().min(2).max(160),
      message: z.string().trim().min(5).max(1000),
      segmentId: z.uuid().nullable().optional(),
      labelCode: z.string().trim().max(40).nullable().optional(),
      dryRun: z.boolean().default(true),
      send: z.boolean().default(false),
    }).strict().parse(request.body);
    if (!body.segmentId && !body.labelCode) throw badRequest('سگمنت یا برچسب مقصد لازم است.');
    const audience = await transaction(pool, async (client) => {
      let userIds: string[] = [];
      let audienceLabel = '';
      if (body.segmentId) {
        const segment = await one<{ title: string }>(client, 'SELECT title FROM crm_segments WHERE id = $1', [body.segmentId]);
        if (!segment) throw notFound();
        audienceLabel = `segment:${segment.title}`;
        const members = await client.query<{ user_id: string }>('SELECT user_id FROM crm_segment_members WHERE segment_id = $1', [body.segmentId]);
        userIds = members.rows.map((row) => row.user_id);
      } else if (body.labelCode) {
        const label = await one<{ title: string }>(client, 'SELECT title FROM crm_labels WHERE code = $1', [body.labelCode]);
        if (!label) throw notFound();
        audienceLabel = `label:${label.title}`;
        const members = await client.query<{ user_id: string }>(
          `SELECT c.user_id FROM crm_contact_labels cl JOIN crm_contacts c ON c.id = cl.contact_id
           WHERE cl.label_code = $1 AND (cl.expires_at IS NULL OR cl.expires_at > now())`, [body.labelCode]);
        userIds = members.rows.map((row) => row.user_id);
      }
      // Requirement 143: consent gate + do-not-contact are applied before counting.
      const consented = await consentedRecipients(client, userIds);
      const blocked = userIds.length - consented.length;
      const campaignId = randomUUID();
      const status = body.send && consented.length ? 'queued' : 'draft';
      await client.query(
        `INSERT INTO sms_campaigns(id,title,message,audience,status,recipients,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [campaignId, body.title, body.message, audienceLabel.slice(0, 40), status, consented.length, user.id]);
      await audit(client, user.id, 'crm.campaign_created', 'sms_campaign', campaignId, undefined,
        { audience: audienceLabel, recipients: consented.length, blockedByConsent: blocked, send: body.send }, request.ip);
      if (audienceLabel.startsWith('segment:')) {
        await emitEvent(client, { eventType: 'crm.campaign.targeted', entityType: 'sms_campaign', entityId: campaignId,
          payload: { campaignId, audience: audienceLabel, recipients: consented.length }, actorId: user.id });
      }
      if (body.send) {
        for (const recipient of consented) {
          const event = await emitEvent(client, { eventType: 'crm.campaign_sms', entityType: 'sms_campaign',
            entityId: campaignId, payload: { campaignId, userId: recipient.id }, actorId: user.id });
          await client.query(
            `INSERT INTO sms_deliveries(id,event_id,user_id,phone,message,category) VALUES ($1,$2,$3,$4,$5,'marketing')`,
            [randomUUID(), event.eventId, recipient.id, recipient.phone, body.message]);
          await recordTimeline(client, { userId: recipient.id, eventType: 'crm.campaign', source: 'crm',
            title: `کمپین SMS: ${body.title}`, refType: 'sms_campaign', refId: campaignId, actorId: user.id });
        }
      }
      return {
        campaignId, recipients: consented.length, blockedByConsent: blocked, audienceLabel, status,
        // Item 138: the preview names the match count and shows who is in it.
        sample: consented.slice(0, 10).map((row) => ({
          userId: row.id, displayName: row.display_name ?? '',
          phone: row.phone ? `${row.phone.slice(0, 4)}***${row.phone.slice(-2)}` : null,
        })),
        matchMessage: `این کمپین روی ${consented.length.toLocaleString('fa-IR')} کاربر Match می‌شود (${blocked.toLocaleString('fa-IR')} کاربر به دلیل نبود رضایت حذف شدند).`,
      };
    });
    return reply.code(body.send ? 201 : 200).send({ ...audience, dryRun: !body.send });
  });

  /** Self-service consent management for the signed-in customer (item 143). */
  app.get('/api/v1/customer/consent', async (request) => {
    const user = await principal(request, pool, config);
    const row = await one<Record<string, unknown>>(pool, 'SELECT * FROM customer_consents WHERE user_id = $1', [user.id]);
    return { consent: row ?? { user_id: user.id, marketing_sms: false, transactional_sms: true, email_marketing: false, do_not_contact: false } };
  });

  app.patch('/api/v1/customer/consent', async (request) => {
    const user = await principal(request, pool, config);
    const body = z.object({
      marketingSms: z.boolean().optional(), emailMarketing: z.boolean().optional(), doNotContact: z.boolean().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM customer_consents WHERE user_id = $1', [user.id]);
      const row = await one<Record<string, unknown>>(client,
        `INSERT INTO customer_consents(user_id,marketing_sms,email_marketing,do_not_contact,source)
         VALUES ($1,COALESCE($2,false),COALESCE($3,false),COALESCE($4,false),'self_service')
         ON CONFLICT (user_id) DO UPDATE SET
           marketing_sms = COALESCE($2, customer_consents.marketing_sms),
           email_marketing = COALESCE($3, customer_consents.email_marketing),
           do_not_contact = COALESCE($4, customer_consents.do_not_contact),
           unsubscribed_at = CASE WHEN $2 = false AND customer_consents.marketing_sms THEN now() ELSE customer_consents.unsubscribed_at END,
           source = 'self_service', updated_at = now() RETURNING *`,
        [user.id, body.marketingSms ?? null, body.emailMarketing ?? null, body.doNotContact ?? null]);
      // Hardening: revocation is retroactive — queued marketing SMS never reach the provider.
      const stillAllowed = Boolean(row?.marketing_sms) && !Boolean(row?.do_not_contact);
      const blocked = stillAllowed ? 0 : await blockQueuedMarketingSms(client, user.id,
        Boolean(row?.do_not_contact) ? 'do_not_contact' : 'consent_revoked');
      await audit(client, user.id, 'customer.consent_updated', 'customer_consent', user.id, before, body, request.ip);
      return { consent: row, blockedQueuedSms: blocked };
    });
  });

  /** Outbox-driven listing so operators can see what the automation layer sees. */
  app.get('/api/v1/admin/crm/upcoming-events', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'crm:manage');
    const rows = await pool.query(
      `SELECT id,event_type,aggregate_type,aggregate_id,payload,occurred_at,delivered_at
       FROM outbox_events WHERE event_type LIKE 'membership.%' OR event_type LIKE 'crm.%' OR event_type LIKE 'customer.%'
       ORDER BY occurred_at DESC LIMIT 50`);
    return { items: rows.rows };
  });
}

/** Apply a label rule: assign/remove the label and record the run (requirement 20/21).
 *  Shared by the admin API, the dry-run/approval flow and the scheduled worker. */
export async function applyLabelRule(pool: DbPool, ruleId: string, options: {
  actorId?: string | null; approve?: boolean; ip?: string | null;
} = {}) {
  const rule = await one<Record<string, unknown>>(pool, 'SELECT * FROM crm_label_rules WHERE id = $1', [ruleId]);
  if (!rule) throw notFound();
  if (rule.requires_approval && !rule.approved_at && !options.approve)
    throw conflict('این قانون نیازمند تأیید دستی است؛ با approve=true تأیید کنید.');
  const metrics = await loadMetrics(pool);
  const matched = metrics.filter((item) => evaluateConditions(item, rule.conditions as RuleCondition[], rule.match_mode as 'all' | 'any'));
  const applied = await transaction(pool, async (client) => {
    if (rule.requires_approval && !rule.approved_at) {
      await client.query('UPDATE crm_label_rules SET approved_by = $2, approved_at = now() WHERE id = $1', [ruleId, options.actorId ?? null]);
    }
    let assigned = 0;
    let removed = 0;
    for (const item of matched) {
      const contact = await client.query<{ id: string }>(
        `INSERT INTO crm_contacts(id,user_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET updated_at = now() RETURNING id`,
        [randomUUID(), item.userId]);
      const contactId = contact.rows[0]!.id;
      const inserted = await client.query(
        `INSERT INTO crm_contact_labels(contact_id,label_code,source,rule_id,assigned_by) VALUES ($1,$2,'rule',$3,$4)
         ON CONFLICT (contact_id,label_code) DO UPDATE SET rule_id = $3, assigned_at = now()`,
        [contactId, rule.label_code, ruleId, options.actorId ?? null]);
      assigned += inserted.rowCount ?? 0;
      await recordTimeline(client, { userId: item.userId, eventType: 'crm.label_assigned', source: 'crm_rule',
        title: `برچسب ${String(rule.label_code)} اعمال شد`, refType: 'crm_label_rule', refId: ruleId, actorId: options.actorId ?? null });
    }
    if (rule.label_code) {
      const stale = await client.query(
        `UPDATE crm_contact_labels SET expires_at = now()
         WHERE label_code = $1 AND source = 'rule' AND rule_id = $2 AND NOT (contact_id IN (
           SELECT contact_id FROM crm_contact_labels cl JOIN crm_contacts c ON c.id = cl.contact_id
           WHERE cl.label_code = $1 AND c.user_id = ANY($3::uuid[])))
         RETURNING contact_id`, [rule.label_code, ruleId, matched.map((item) => item.userId)]);
      removed = stale.rowCount ?? 0;
    }
    await client.query(
      `UPDATE crm_label_rules SET last_run_at = now(), last_match_count = $2, updated_at = now() WHERE id = $1`,
      [ruleId, matched.length]);
    await audit(client, options.actorId ?? null, 'crm.label_rule_applied', 'crm_label_rule', ruleId, undefined,
      { matched: matched.length, assigned, removed, scheduled: !options.actorId }, options.ip ?? undefined);
    return { assigned, removed };
  });
  return { ruleId, matchCount: matched.length, ...applied };
}

/** Refresh a dynamic segment from its stored definition (requirement 98). */
export async function refreshSegment(pool: DbPool, segmentId: string, actorId: string | null = null) {
  const segment = await one<{ id: string; kind: string; definition: { matchMode?: 'all' | 'any'; conditions?: RuleCondition[] } }>(pool,
    'SELECT id,kind,definition FROM crm_segments WHERE id = $1', [segmentId]);
  if (!segment) throw notFound();
  if (segment.kind === 'manual') throw badRequest('سگمنت دستی به‌روزرسانی خودکار ندارد.');
  const metrics = await loadMetrics(pool);
  const matched = metrics.filter((item) => matchesDefinition(item, segment.definition ?? {}));
  const result = await transaction(pool, async (client) => {
    await client.query('DELETE FROM crm_segment_members WHERE segment_id = $1', [segmentId]);
    for (const item of matched) {
      await client.query(
        `INSERT INTO crm_segment_members(segment_id,user_id,matched_by) VALUES ($1,$2,'rule') ON CONFLICT DO NOTHING`,
        [segmentId, item.userId]);
    }
    await client.query('UPDATE crm_segments SET last_refreshed_at = now(), member_count = $2 WHERE id = $1',
      [segmentId, matched.length]);
    await audit(client, actorId, 'crm.segment_refreshed', 'crm_segment', segmentId, undefined,
      { members: matched.length, scheduled: !actorId }, undefined);
    return { members: matched.length };
  });
  return { segmentId, ...result, totalCustomers: metrics.length };
}

/** Hourly worker sweep: keeps rule labels and dynamic segments self-updating (items 21/98). */
export async function runCrmRuleSweep(pool: DbPool, options: { labelIntervalHours?: number } = {}) {
  const hours = options.labelIntervalHours ?? 6;
  const dueRules = await pool.query<{ id: string }>(
    `SELECT id FROM crm_label_rules
     WHERE status = 'active' AND (approved_at IS NOT NULL OR NOT requires_approval)
       AND (last_run_at IS NULL OR last_run_at < now() - ($1::int || ' hours')::interval)
     ORDER BY priority DESC LIMIT 20`, [hours]);
  let rulesApplied = 0;
  let labelsAssigned = 0;
  for (const row of dueRules.rows) {
    try {
      const applied = await applyLabelRule(pool, row.id, { actorId: null });
      labelsAssigned += applied.assigned;
      rulesApplied += 1;
    } catch (error) {
      await pool.query('UPDATE crm_label_rules SET updated_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
      console.error('Label rule sweep failed', row.id, error);
    }
  }
  const dueSegments = await pool.query<{ id: string }>(
    `SELECT id FROM crm_segments
     WHERE kind = 'dynamic' AND active AND refresh_interval_minutes IS NOT NULL
       AND (last_refreshed_at IS NULL OR last_refreshed_at < now() - (refresh_interval_minutes || ' minutes')::interval)
     ORDER BY last_refreshed_at NULLS FIRST LIMIT 50`);
  let segmentsRefreshed = 0;
  let members = 0;
  for (const row of dueSegments.rows) {
    try {
      const refreshed = await refreshSegment(pool, row.id, null);
      members += refreshed.members;
      segmentsRefreshed += 1;
    } catch (error) {
      console.error('Segment refresh failed', row.id, error);
    }
  }
  return { rulesApplied, labelsAssigned, segmentsRefreshed, members };
}
