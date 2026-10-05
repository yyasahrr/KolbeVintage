import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { principal, requirePermission } from './auth.js';
import { one, transaction, type DbPool } from './db.js';
import { audit } from './operations.js';
import { conflict, notFound } from './errors.js';
import { ensureContact, recordTimeline } from './crm-intelligence.js';

const stage = z.enum(['lead','prospect','active','loyal','at_risk','dormant','churned','partner']);
const priority = z.enum(['low','normal','high','urgent']);
const channel = z.enum(['call','sms','whatsapp','email','meeting','other']);
const outcome = z.enum(['successful','no_answer','follow_up','closed','neutral']);

async function contactForUser(pool: DbPool, userId: string) {
  return one<{ id: string }>(pool, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
}

export function registerCrmRelationshipRoutes(app: FastifyInstance, pool: DbPool, config: Config) {
  app.get('/api/v1/admin/crm/owners', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const rows = await pool.query(
      `SELECT DISTINCT u.id, u.display_name
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_code = ur.role_code
        WHERE u.status = 'active' AND rp.permission_code = 'crm:manage'
        ORDER BY u.display_name`);
    return { items: rows.rows };
  });

  app.post('/api/v1/admin/crm/leads', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const body = z.object({
      name: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.string().trim().email().max(200).nullable().optional(),
      organization: z.string().trim().max(180).nullable().optional(),
      ownerUserId: z.uuid().nullable().optional(),
      priority: priority.default('normal'),
      nextFollowupAt: z.iso.datetime().nullable().optional(),
    }).strict().parse(request.body);
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query(
        `INSERT INTO crm_contacts(id,actor_type,lifecycle_stage,priority,owner_user_id,next_followup_at,lead_name,lead_phone,lead_email,organization,metadata)
         VALUES ($1,'other','lead',$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`,
        [id, body.priority, body.ownerUserId ?? null, body.nextFollowupAt ?? null, body.name, body.phone ?? null, body.email ?? null, body.organization ?? null]);
      await audit(client, actor.id, 'crm.lead_created', 'crm_contact', id, undefined, body, request.ip);
    });
    return reply.code(201).send({ id });
  });

  app.post('/api/v1/admin/crm/contacts/:id/link-user', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { userId } = z.object({ userId: z.uuid() }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const existing = await one<{ id: string }>(client, 'SELECT id FROM crm_contacts WHERE user_id = $1', [userId]);
      if (existing && existing.id !== id) throw conflict('برای این کاربر از قبل پرونده CRM وجود دارد.');
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const result = await client.query(
        `UPDATE crm_contacts SET user_id=$2, actor_type='customer', lifecycle_stage='active',
           lead_name=NULL, lead_phone=NULL, lead_email=NULL, updated_at=now()
         WHERE id=$1 RETURNING *`, [id, userId]);
      await audit(client, actor.id, 'crm.lead_linked_to_user', 'crm_contact', id, before, { userId }, request.ip);
      return result.rows[0];
    });
  });

  app.get('/api/v1/admin/crm/relationship-summary', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const row = await one<Record<string, string>>(pool, `
      SELECT
        (SELECT count(*) FROM crm_tasks WHERE status='open' AND due_at < now())::text AS overdue,
        (SELECT count(*) FROM crm_tasks WHERE status='open' AND due_at >= date_trunc('day',now()) AND due_at < date_trunc('day',now()) + interval '1 day')::text AS today,
        (SELECT count(*) FROM crm_tasks WHERE status='open' AND due_at >= now() AND due_at < now()+interval '7 days')::text AS next_7_days,
        (SELECT count(*) FROM crm_contacts WHERE owner_user_id IS NULL)::text AS unassigned,
        (SELECT count(*) FROM crm_contacts WHERE lifecycle_stage='lead')::text AS leads,
        (SELECT count(*) FROM crm_contacts WHERE lifecycle_stage='at_risk')::text AS at_risk,
        (SELECT count(*) FROM crm_contacts WHERE next_followup_at IS NOT NULL AND next_followup_at < now())::text AS followup_overdue`);
    return { kpis: Object.fromEntries(Object.entries(row ?? {}).map(([k,v]) => [k, Number(v ?? 0)])) };
  });

  app.get('/api/v1/admin/crm/action-center', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const query = z.object({
      view: z.enum(['all','overdue','today','upcoming','unassigned']).default('all'),
      ownerId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await pool.query(`
      SELECT t.id,t.title,t.description,t.due_at,t.priority,t.status,t.assigned_to,t.contact_id,
             COALESCE(u.display_name,c.lead_name,'بدون نام') AS contact_name,
             COALESCE(u.phone,c.lead_phone) AS phone,
             c.actor_type,c.lifecycle_stage,c.next_followup_at,
             owner.display_name AS owner_name, assignee.display_name AS assignee_name
        FROM crm_tasks t
        JOIN crm_contacts c ON c.id=t.contact_id
        LEFT JOIN users u ON u.id=c.user_id
        LEFT JOIN users owner ON owner.id=c.owner_user_id
        LEFT JOIN users assignee ON assignee.id=t.assigned_to
       WHERE t.status='open'
         AND ($1::uuid IS NULL OR COALESCE(t.assigned_to,c.owner_user_id)=$1)
         AND CASE $2
           WHEN 'overdue' THEN t.due_at < now()
           WHEN 'today' THEN t.due_at >= date_trunc('day',now()) AND t.due_at < date_trunc('day',now())+interval '1 day'
           WHEN 'upcoming' THEN t.due_at >= now()
           WHEN 'unassigned' THEN COALESCE(t.assigned_to,c.owner_user_id) IS NULL
           ELSE true END
       ORDER BY (t.due_at < now()) DESC, t.due_at ASC NULLS LAST,
                CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END
       LIMIT $3`, [query.ownerId ?? null, query.view, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/crm/search', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const query = z.object({ q: z.string().trim().min(2).max(120), limit: z.coerce.number().int().min(1).max(30).default(15) }).parse(request.query);
    const rows = await pool.query(`
      WITH people AS (
        SELECT c.id AS contact_id,u.id AS user_id,
               COALESCE(c.actor_type,CASE WHEN sp.user_id IS NOT NULL THEN 'supplier' WHEN bp.user_id IS NOT NULL THEN 'wholesale_buyer' ELSE 'customer' END) AS actor_type,
               COALESCE(c.lifecycle_stage,'active') AS lifecycle_stage,COALESCE(c.priority,'normal') AS priority,c.next_followup_at,
               u.display_name,u.phone,u.email,COALESCE(sp.brand_name,bp.business_name) AS organization,
               owner.display_name AS owner_name,COALESCE(c.updated_at,u.created_at) AS sort_at
          FROM users u
          LEFT JOIN crm_contacts c ON c.user_id=u.id
          LEFT JOIN supplier_profiles sp ON sp.user_id=u.id
          LEFT JOIN buyer_profiles bp ON bp.user_id=u.id
          LEFT JOIN users owner ON owner.id=c.owner_user_id
         WHERE u.display_name ILIKE '%'||$1||'%' OR COALESCE(u.phone,'') ILIKE '%'||$1||'%'
            OR COALESCE(u.email,'') ILIKE '%'||$1||'%' OR COALESCE(sp.brand_name,bp.business_name,'') ILIKE '%'||$1||'%'
        UNION ALL
        SELECT c.id,NULL,c.actor_type,c.lifecycle_stage,c.priority,c.next_followup_at,
               COALESCE(c.lead_name,'بدون نام'),c.lead_phone,c.lead_email,c.organization,owner.display_name,c.updated_at
          FROM crm_contacts c LEFT JOIN users owner ON owner.id=c.owner_user_id
         WHERE c.user_id IS NULL AND (COALESCE(c.lead_name,'') ILIKE '%'||$1||'%'
            OR COALESCE(c.lead_phone,'') ILIKE '%'||$1||'%' OR COALESCE(c.lead_email,'') ILIKE '%'||$1||'%'
            OR COALESCE(c.organization,'') ILIKE '%'||$1||'%')
      )
      SELECT * FROM people ORDER BY sort_at DESC LIMIT $2`, [query.q, query.limit]);
    return { items: rows.rows };
  });

  app.get('/api/v1/admin/crm/contacts/:id/relationship', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const contact = await one<Record<string, unknown>>(pool, `
      SELECT c.*,COALESCE(u.display_name,c.lead_name) AS display_name,COALESCE(u.phone,c.lead_phone) AS phone,
             COALESCE(u.email,c.lead_email) AS email,owner.display_name AS owner_name
        FROM crm_contacts c LEFT JOIN users u ON u.id=c.user_id LEFT JOIN users owner ON owner.id=c.owner_user_id
       WHERE c.id=$1`, [id]);
    if (!contact) throw notFound();
    const [tasks, interactions] = await Promise.all([
      pool.query(`SELECT t.*,a.display_name AS assignee_name,cb.display_name AS created_by_name
                    FROM crm_tasks t LEFT JOIN users a ON a.id=t.assigned_to LEFT JOIN users cb ON cb.id=t.created_by
                   WHERE t.contact_id=$1 ORDER BY (t.status='open') DESC,t.due_at ASC NULLS LAST,t.created_at DESC LIMIT 100`, [id]),
      pool.query(`SELECT i.*,u.display_name AS created_by_name FROM crm_interactions i LEFT JOIN users u ON u.id=i.created_by
                   WHERE i.contact_id=$1 ORDER BY i.occurred_at DESC LIMIT 100`, [id]),
    ]);
    return { contact, tasks: tasks.rows, interactions: interactions.rows };
  });

  app.patch('/api/v1/admin/crm/contacts/:id/relationship', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      ownerUserId: z.uuid().nullable().optional(), lifecycleStage: stage.optional(), priority: priority.optional(),
      nextFollowupAt: z.iso.datetime().nullable().optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before = await one<Record<string, unknown>>(client, 'SELECT * FROM crm_contacts WHERE id=$1 FOR UPDATE', [id]);
      if (!before) throw notFound();
      const row = await one<Record<string, unknown>>(client, `
        UPDATE crm_contacts SET
          owner_user_id=CASE WHEN $2::boolean THEN $3::uuid ELSE owner_user_id END,
          lifecycle_stage=COALESCE($4,lifecycle_stage),priority=COALESCE($5,priority),
          next_followup_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE next_followup_at END,updated_at=now()
        WHERE id=$1 RETURNING *`,
        [id, Object.prototype.hasOwnProperty.call(body,'ownerUserId'), body.ownerUserId ?? null, body.lifecycleStage ?? null,
         body.priority ?? null, Object.prototype.hasOwnProperty.call(body,'nextFollowupAt'), body.nextFollowupAt ?? null]);
      await audit(client, actor.id, 'crm.relationship_updated', 'crm_contact', id, before, body, request.ip);
      return row;
    });
  });

  app.post('/api/v1/admin/crm/contacts/:id/tasks', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z.object({
      title: z.string().trim().min(2).max(200), description: z.string().trim().max(3000).default(''),
      assignedTo: z.uuid().nullable().optional(), dueAt: z.iso.datetime().nullable().optional(), priority: priority.default('normal'),
    }).strict().parse(request.body);
    const contact = await one<{ id:string; user_id:string|null; owner_user_id:string|null }>(pool,'SELECT id,user_id,owner_user_id FROM crm_contacts WHERE id=$1',[id]);
    if (!contact) throw notFound();
    const taskId=randomUUID();
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO crm_tasks(id,contact_id,title,description,assigned_to,due_at,priority,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [taskId,id,body.title,body.description,body.assignedTo ?? contact.owner_user_id,body.dueAt ?? null,body.priority,actor.id]);
      if (body.dueAt) await client.query('UPDATE crm_contacts SET next_followup_at=$2,updated_at=now() WHERE id=$1 AND (next_followup_at IS NULL OR next_followup_at>$2)',[id,body.dueAt]);
      await audit(client,actor.id,'crm.task_created','crm_task',taskId,undefined,{contactId:id,...body},request.ip);
    });
    return reply.code(201).send({id:taskId});
  });

  app.patch('/api/v1/admin/crm/tasks/:id', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id } = z.object({ id:z.uuid() }).parse(request.params);
    const body = z.object({
      title:z.string().trim().min(2).max(200).optional(), description:z.string().trim().max(3000).optional(),
      assignedTo:z.uuid().nullable().optional(), dueAt:z.iso.datetime().nullable().optional(), priority:priority.optional(),
      status:z.enum(['open','done','cancelled']).optional(),
    }).strict().parse(request.body);
    return transaction(pool, async (client) => {
      const before=await one<Record<string,unknown>>(client,'SELECT * FROM crm_tasks WHERE id=$1 FOR UPDATE',[id]);
      if(!before) throw notFound();
      const row=await one<Record<string,unknown>>(client,`
        UPDATE crm_tasks SET title=COALESCE($2,title),description=COALESCE($3,description),
          assigned_to=CASE WHEN $4::boolean THEN $5::uuid ELSE assigned_to END,
          due_at=CASE WHEN $6::boolean THEN $7::timestamptz ELSE due_at END,
          priority=COALESCE($8,priority),status=COALESCE($9,status),
          completed_at=CASE WHEN $9='done' THEN now() WHEN $9='open' THEN NULL ELSE completed_at END,updated_at=now()
        WHERE id=$1 RETURNING *`,
        [id,body.title ?? null,body.description ?? null,Object.prototype.hasOwnProperty.call(body,'assignedTo'),body.assignedTo ?? null,
         Object.prototype.hasOwnProperty.call(body,'dueAt'),body.dueAt ?? null,body.priority ?? null,body.status ?? null]);
      await audit(client,actor.id,'crm.task_updated','crm_task',id,before,body,request.ip);
      return row;
    });
  });

  app.post('/api/v1/admin/crm/contacts/:id/interactions', async (request, reply) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { id }=z.object({id:z.uuid()}).parse(request.params);
    const body=z.object({
      channel, outcome, subject:z.string().trim().min(2).max(200), body:z.string().trim().max(5000).default(''),
      occurredAt:z.iso.datetime().optional(), nextFollowupAt:z.iso.datetime().nullable().optional(),
    }).strict().parse(request.body);
    const contact=await one<{id:string;user_id:string|null}>(pool,'SELECT id,user_id FROM crm_contacts WHERE id=$1',[id]);
    if(!contact) throw notFound();
    const interactionId=randomUUID();
    await transaction(pool,async(client)=>{
      await client.query(`INSERT INTO crm_interactions(id,contact_id,channel,outcome,subject,body,occurred_at,next_followup_at,created_by)
        VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$8,$9)`,
        [interactionId,id,body.channel,body.outcome,body.subject,body.body,body.occurredAt ?? null,body.nextFollowupAt ?? null,actor.id]);
      await client.query(`UPDATE crm_contacts SET last_interaction_at=COALESCE($2,now()),
        next_followup_at=CASE WHEN $3::timestamptz IS NOT NULL THEN $3 ELSE next_followup_at END,updated_at=now() WHERE id=$1`,
        [id,body.occurredAt ?? null,body.nextFollowupAt ?? null]);
      if(contact.user_id) await recordTimeline(client,{userId:contact.user_id,eventType:'crm.interaction',title:body.subject,
        description:body.body,source:'crm',refType:'crm_interaction',refId:interactionId,actorId:actor.id,metadata:{channel:body.channel,outcome:body.outcome},
        occurredAt:body.occurredAt?new Date(body.occurredAt):undefined});
      await audit(client,actor.id,'crm.interaction_created','crm_interaction',interactionId,undefined,{contactId:id,...body},request.ip);
    });
    return reply.code(201).send({id:interactionId});
  });

  app.get('/api/v1/admin/crm/users/:userId/relationship', async (request) => {
    const actor = await principal(request, pool, config); requirePermission(actor, 'crm:manage');
    const { userId }=z.object({userId:z.uuid()}).parse(request.params);
    let contact=await contactForUser(pool,userId);
    if(!contact){
      const exists=await one<{actor_type:string}>(pool,`
        SELECT CASE WHEN EXISTS(SELECT 1 FROM supplier_profiles WHERE user_id=$1) THEN 'supplier'
                    WHEN EXISTS(SELECT 1 FROM buyer_profiles WHERE user_id=$1) THEN 'wholesale_buyer'
                    ELSE 'customer' END AS actor_type
        FROM users WHERE id=$1`,[userId]);
      if(!exists) throw notFound();
      const id=await transaction(pool,(client)=>ensureContact(client,userId,exists.actor_type));
      contact={id};
    }
    const detail=await one<Record<string,unknown>>(pool,`
      SELECT c.*,owner.display_name AS owner_name FROM crm_contacts c LEFT JOIN users owner ON owner.id=c.owner_user_id WHERE c.id=$1`,[contact.id]);
    return { contact:detail };
  });
}
