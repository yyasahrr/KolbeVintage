import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { type DbPool } from './db.js';

export function registerAdminRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/audit-logs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'audit:read');
    const query = z.object({
      resourceType: z.string().max(80).optional(), resourceId: z.string().max(120).optional(),
      actor: z.string().max(120).optional(), action: z.string().max(120).optional(),
      from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
      ip: z.string().max(45).optional(),
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,actor_id,action,resource_type,resource_id,old_value,new_value,ip,created_at,
              (SELECT display_name FROM users WHERE id = actor_id) AS actor_name
       FROM audit_logs
       WHERE ($1::text IS NULL OR resource_type = $1)
         AND ($2::text IS NULL OR resource_id = $2)
         AND ($3::text IS NULL OR actor_id::text = $3 OR EXISTS (SELECT 1 FROM users WHERE id = actor_id AND display_name ILIKE '%' || $3 || '%'))
         AND ($4::text IS NULL OR action = $4)
         AND ($5::timestamptz IS NULL OR created_at >= $5)
         AND ($6::timestamptz IS NULL OR created_at <= $6)
         AND ($7::text IS NULL OR ip = $7)
         AND ($8::text IS NULL OR action ILIKE '%' || $8 || '%' OR resource_type ILIKE '%' || $8 || '%')
       ORDER BY created_at DESC LIMIT $9`,
      [query.resourceType ?? null, query.resourceId ?? null, query.actor ?? null, query.action ?? null,
        query.from ?? null, query.to ?? null, query.ip ?? null, query.search ?? null, query.limit]);
    return { items: rows.rows };
  });
  app.get('/api/v1/admin/journal', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'payments:read');
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      sourceType: z.string().max(60).optional(),
      reference: z.string().max(120).optional(),
    }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.id,e.reference,e.source_type,e.source_id,e.created_at,
              jsonb_agg(jsonb_build_object('account', a.code, 'title', a.title, 'type', a.account_type,
                'debitRial', l.debit_rial::text, 'creditRial', l.credit_rial::text) ORDER BY a.code) AS lines
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       JOIN ledger_accounts a ON a.id = l.account_id
       WHERE ($1::text IS NULL OR e.source_type = $1) AND ($2::text IS NULL OR e.reference ILIKE '%' || $2 || '%')
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT $3`, [query.sourceType ?? null, query.reference ?? null, query.limit]);
    return { items: rows.rows };
  });
  app.get('/api/v1/admin/journal/accounts', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'payments:read');
    const rows = await pool.query(
      `SELECT a.id, a.code, a.title, a.account_type,
              COALESCE(SUM(l.debit_rial),0)::text AS total_debit,
              COALESCE(SUM(l.credit_rial),0)::text AS total_credit,
              COALESCE(SUM(l.debit_rial - l.credit_rial),0)::text AS balance
       FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
       GROUP BY a.id ORDER BY a.code`);
    return { items: rows.rows };
  });
  app.get('/api/v1/admin/journal/stats', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'payments:read');
    const stats = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(amount_rial),0)::text FROM withdrawal_requests WHERE status = 'paid') AS total_withdrawn,
         (SELECT COALESCE(SUM(amount_rial),0)::text FROM settlements WHERE status = 'settled') AS total_settled,
         (SELECT COALESCE(SUM(total_rial),0)::text FROM invoices WHERE status = 'paid') AS total_invoiced,
         (SELECT COUNT(*)::int FROM journal_entries) AS journal_count`);
    return stats.rows[0];
  });
}
