import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit, outbox } from './operations.js';
import { forbidden, notFound } from './errors.js';

const createTicket = z.object({
  subject: z.string().trim().min(3).max(240),
  category: z.string().trim().min(2).max(100),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  orderId: z.uuid().optional(),
  message: z.string().trim().min(8).max(10000),
});
const replyBody = z.object({ message: z.string().trim().min(1).max(10000), internal: z.boolean().default(false) });
/* Attachment metadata validation (pre-merge checklist): file references must be
   https URLs, with an allowlisted MIME type and a bounded size when declared. */
const ATTACHMENT_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'video/mp4', 'text/plain',
]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const fileMetaBody = z.record(z.string().max(40), z.unknown()).superRefine((meta, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (meta.url !== undefined && (typeof meta.url !== 'string' || !/^https:\/\/\S{1,1000}$/.test(meta.url))) {
    fail('آدرس فایل پیوست باید https معتبر باشد.');
  }
  const mime = meta.mime ?? meta.type;
  if (mime !== undefined && (typeof mime !== 'string' || !ATTACHMENT_MIME.has(mime))) fail('نوع فایل پیوست مجاز نیست.');
  const size = meta.size ?? meta.bytes;
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES)) {
    fail('حجم فایل پیوست باید بین ۱ بایت تا ۱۰ مگابایت باشد.');
  }
});
const statusBody = z.object({
  status: z.enum(['new', 'reviewing', 'waiting_user', 'answered', 'escalated', 'resolved', 'closed']),
  department: z.string().trim().max(120).optional(), assigneeId: z.uuid().nullable().optional(),
});
type TicketRow = { id: string; reference: string; owner_id: string; status: string; priority: string; subject: string; category: string; sla_due_at: Date | null };

export function registerTicketRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.post('/api/v1/tickets', async (request, reply) => {
    const user = await principal(request, pool, config);
    const body = createTicket.parse(request.body);
    const ticket = await transaction(pool, async (client) => {
      if (body.orderId) {
        const order = await one<{ buyer_id: string }>(client, 'SELECT buyer_id FROM orders WHERE id = $1', [body.orderId]);
        if (!order || order.buyer_id !== user.id) throw notFound();
      }
      const id = randomUUID();
      const sequence = await one<{ number: string }>(client, "SELECT nextval('ticket_reference_seq')::text AS number");
      const reference = `TK-${sequence!.number}`;
      // VIP plans get higher priority and a tighter SLA (item 45).
      const plan = await one<{ priority: boolean }>(client,
        `SELECT (COALESCE(p.limits->>'prioritySupport','false') = 'true'
           OR p.features ? 'priority_support') AS priority
         FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
         WHERE m.user_id = $1 AND m.status = 'active' AND m.starts_at <= now() AND m.ends_at > now()
         LIMIT 1`, [user.id]);
      const boost = plan?.priority === true;
      const priority = boost
        ? (body.priority === 'low' ? 'normal' : body.priority === 'normal' ? 'high' : body.priority)
        : body.priority;
      const hours = priority === 'urgent' ? 2 : priority === 'high' ? 4 : priority === 'normal' ? 24 : 48;
      await client.query(
        `INSERT INTO tickets(id,reference,owner_id,order_id,subject,category,priority,sla_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now() + ($8::integer * interval '1 hour'))`,
        [id, reference, user.id, body.orderId ?? null, body.subject, body.category, priority, boost ? Math.ceil(hours / 2) : hours]);
      await client.query('INSERT INTO ticket_messages(id,ticket_id,sender_id,body) VALUES ($1,$2,$3,$4)',
        [randomUUID(), id, user.id, body.message]);
      await audit(client, user.id, 'ticket.created', 'ticket', id, undefined, { reference, category: body.category }, request.ip);
      await outbox(client, 'ticket.created', 'ticket', id, { ticketId: id, reference, priority: body.priority });
      return { id, reference, status: 'new', priority, vipBoost: boost };
    });
    return reply.code(201).send(ticket);
  });

  app.get('/api/v1/tickets', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({
      status: z.string().max(40).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      category: z.string().max(100).optional(),
      assigneeId: z.uuid().optional(),
      search: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }).parse(request.query);
    const manager = user.permissions.includes('tickets:manage');
    const rows = await pool.query<TicketRow>(
      `SELECT id,reference,owner_id,status,priority,subject,category,sla_due_at,department,assignee_id,updated_at
       FROM tickets WHERE ($1::boolean OR owner_id = $2) AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR priority = $4) AND ($5::text IS NULL OR category = $5)
         AND ($6::uuid IS NULL OR assignee_id = $6)
         AND ($7::text IS NULL OR reference ILIKE '%' || $7 || '%' OR subject ILIKE '%' || $7 || '%')
       ORDER BY created_at DESC LIMIT $8`,
      [manager, user.id, query.status ?? null, query.priority ?? null, query.category ?? null,
        query.assigneeId ?? null, query.search ?? null, query.limit]);
    return { items: rows.rows };
  });

  /** Kanban board: tickets grouped by workflow status (item 26). */
  app.get('/api/v1/tickets/board', async (request) => {
    const user = await principal(request, pool, config);
    const manager = user.permissions.includes('tickets:manage');
    const rows = await pool.query<TicketRow & { updated_at: Date }>(
      `SELECT id,reference,owner_id,status,priority,subject,category,sla_due_at,department,assignee_id,updated_at
       FROM tickets WHERE ($1::boolean OR owner_id = $2) ORDER BY updated_at DESC LIMIT 300`, [manager, user.id]);
    const columns: Record<string, typeof rows.rows> = {
      new: [], reviewing: [], waiting_user: [], answered: [], escalated: [], resolved: [], closed: [],
    };
    for (const ticket of rows.rows) (columns[ticket.status] ??= []).push(ticket);
    return { columns };
  });

  app.get('/api/v1/tickets/:id', async (request) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const ticket = await one<TicketRow>(pool, 'SELECT * FROM tickets WHERE id = $1', [id]);
    if (!ticket || (ticket.owner_id !== user.id && !user.permissions.includes('tickets:manage'))) throw notFound();
    const manager = user.permissions.includes('tickets:manage');
    const messages = await pool.query(
      `SELECT m.id,m.sender_id,m.body,m.internal,m.created_at FROM ticket_messages m
       WHERE m.ticket_id = $1 AND ($2::boolean OR NOT m.internal) ORDER BY m.created_at,m.id`, [id, manager]);
    const attachments = await pool.query(
      'SELECT id,message_id,title,file_meta,created_at FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at', [id]);
    return { ...ticket, messages: messages.rows, attachments: attachments.rows };
  });

  app.post('/api/v1/tickets/:id/attachments', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(2).max(200),
      fileMeta: fileMetaBody.default({}),
      messageId: z.uuid().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const ticket = await one<TicketRow>(client, 'SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [id]);
      if (!ticket) throw notFound();
      const manager = user.permissions.includes('tickets:manage');
      if (ticket.owner_id !== user.id && !manager) throw notFound();
      const attachmentId = randomUUID();
      await client.query('INSERT INTO ticket_attachments(id,ticket_id,message_id,title,file_meta,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
        [attachmentId, id, body.messageId ?? null, body.title, JSON.stringify(body.fileMeta), user.id]);
      await audit(client, user.id, 'ticket.attachment_added', 'ticket', id, undefined, { title: body.title }, request.ip);
      return reply.code(201).send({ id: attachmentId, ticketId: id, title: body.title });
    });
  });

  app.post('/api/v1/tickets/:id/messages', async (request, reply) => {
    const user = await principal(request, pool, config);
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = replyBody.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const ticket = await one<TicketRow>(client, 'SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [id]);
      if (!ticket) throw notFound();
      const manager = user.permissions.includes('tickets:manage');
      if (ticket.owner_id !== user.id && !manager) throw notFound();
      if (body.internal && !manager) throw forbidden();
      if (ticket.status === 'closed') throw forbidden();
      const messageId = randomUUID();
      await client.query('INSERT INTO ticket_messages(id,ticket_id,sender_id,body,internal) VALUES ($1,$2,$3,$4,$5)',
        [messageId, id, user.id, body.message, body.internal]);
      const status = body.internal ? ticket.status : manager ? 'answered' : 'reviewing';
      await client.query(
        `UPDATE tickets SET status = $2, updated_at = now(),
           first_response_at = COALESCE(first_response_at, CASE WHEN $3::boolean THEN now() ELSE NULL END)
         WHERE id = $1`, [id, status, manager && !body.internal]);
      await audit(client, user.id, 'ticket.replied', 'ticket', id, undefined, { internal: body.internal, status }, request.ip);
      if (!body.internal) await outbox(client, 'ticket.replied', 'ticket', id, { ticketId: id, messageId });
      return { id: messageId, ticketId: id, status };
    });
    return reply.code(201).send(result);
  });

  app.patch('/api/v1/tickets/:id', async (request) => {
    const user = await principal(request, pool, config); requirePermission(user, 'tickets:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = statusBody.parse(request.body);
    return transaction(pool, async (client) => {
      const current = await one<TicketRow>(client, 'SELECT * FROM tickets WHERE id = $1 FOR UPDATE', [id]);
      if (!current) throw notFound();
      if (body.assigneeId) {
        const assignee = await one<{ id: string }>(client,
          `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
           WHERE u.id = $1 AND ur.role_code IN ('support','admin') AND u.status = 'active'`, [body.assigneeId]);
        if (!assignee) throw notFound();
      }
      await client.query(
        `UPDATE tickets SET status = $2, department = COALESCE($3,department),
         assignee_id = CASE WHEN $4::boolean THEN $5::uuid ELSE assignee_id END,
         resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE resolved_at END, updated_at = now() WHERE id = $1`,
        [id, body.status, body.department ?? null, body.assigneeId !== undefined, body.assigneeId ?? null]);
      await audit(client, user.id, 'ticket.updated', 'ticket', id, { status: current.status }, body, request.ip);
      await outbox(client, 'ticket.updated', 'ticket', id, { ticketId: id, status: body.status });
      return { id, status: body.status };
    });
  });
}
