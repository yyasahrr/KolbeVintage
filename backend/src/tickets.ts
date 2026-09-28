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
      const hours = body.priority === 'urgent' ? 2 : body.priority === 'high' ? 4 : body.priority === 'normal' ? 24 : 48;
      await client.query(
        `INSERT INTO tickets(id,reference,owner_id,order_id,subject,category,priority,sla_due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now() + ($8::integer * interval '1 hour'))`,
        [id, reference, user.id, body.orderId ?? null, body.subject, body.category, body.priority, hours]);
      await client.query('INSERT INTO ticket_messages(id,ticket_id,sender_id,body) VALUES ($1,$2,$3,$4)',
        [randomUUID(), id, user.id, body.message]);
      await audit(client, user.id, 'ticket.created', 'ticket', id, undefined, { reference, category: body.category }, request.ip);
      await outbox(client, 'ticket.created', 'ticket', id, { ticketId: id, reference, priority: body.priority });
      return { id, reference, status: 'new', priority: body.priority };
    });
    return reply.code(201).send(ticket);
  });

  app.get('/api/v1/tickets', async (request) => {
    const user = await principal(request, pool, config);
    const query = z.object({ status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const manager = user.permissions.includes('tickets:manage');
    const rows = await pool.query<TicketRow>(
      `SELECT id,reference,owner_id,status,priority,subject,category,sla_due_at
       FROM tickets WHERE ($1::boolean OR owner_id = $2) AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC LIMIT $4`, [manager, user.id, query.status ?? null, query.limit]);
    return { items: rows.rows };
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
    return { ...ticket, messages: messages.rows };
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
      await client.query('UPDATE tickets SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
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
         assignee_id = CASE WHEN $4::boolean THEN $5::uuid ELSE assignee_id END, updated_at = now() WHERE id = $1`,
        [id, body.status, body.department ?? null, body.assigneeId !== undefined, body.assigneeId ?? null]);
      await audit(client, user.id, 'ticket.updated', 'ticket', id, { status: current.status }, body, request.ip);
      await outbox(client, 'ticket.updated', 'ticket', id, { ticketId: id, status: body.status });
      return { id, status: body.status };
    });
  });
}
