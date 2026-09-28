import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { type DbPool } from './db.js';

export function registerAdminRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/audit-logs', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'audit:read');
    const query = z.object({ resourceType: z.string().max(80).optional(), resourceId: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT id,actor_id,action,resource_type,resource_id,old_value,new_value,ip,created_at
       FROM audit_logs WHERE ($1::text IS NULL OR resource_type = $1)
         AND ($2::text IS NULL OR resource_id = $2)
       ORDER BY created_at DESC LIMIT $3`, [query.resourceType ?? null, query.resourceId ?? null, query.limit]);
    return { items: rows.rows };
  });
  app.get('/api/v1/admin/journal', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'payments:read');
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const rows = await pool.query(
      `SELECT e.id,e.reference,e.source_type,e.source_id,e.created_at,
              jsonb_agg(jsonb_build_object('account', a.code, 'debitRial', l.debit_rial::text,
                'creditRial', l.credit_rial::text) ORDER BY a.code) AS lines
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
       JOIN ledger_accounts a ON a.id = l.account_id
       GROUP BY e.id ORDER BY e.created_at DESC LIMIT $1`, [query.limit]);
    return { items: rows.rows };
  });
}
